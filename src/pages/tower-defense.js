/**
 * tower-defense.js —— 塔防引擎核心（无尽 + 闯关 + 技能/特殊塔，零第三方依赖 ES module）
 * ---------------------------------------------------------------------------
 * 用途：给 tower-defense.html 提供全部游戏逻辑（地图/波次/塔/敌人/战斗/渲染/输入/HUD）；
 *   只 import 两个纯数据+纯函数模块（td-skills / td-special-towers），Node 下 import 只拿纯函数、不碰 DOM。
 * 模式：「无尽」波次由 generateEndlessWave(n) 现算，每 10 波一个 BOSS 波；「闯关」100 关由
 *   generateLevel(L) 派生，关卡内每一波仍复用 generateEndlessWave 再按关卡系数放大 —— 两种
 *   模式都没有逐波写死的数量表（tools/td-wave-test/run.mjs 会正则扫描源码把关）。
 * 存档：localStorage 单键 mlttc-td-progress（unlocked / levelBest / endlessBest / endlessRun），另有
 *   'TD1-<base64>' 存档码做导出导入；读写全部 try/catch，隐私模式或坏 JSON 一律回落默认值。
 * 数据结构：
 *   state      唯一可变状态（波次 / 生命 / 金币 / 击杀 / 实体数组）
 *   enemies[]  { type, hp, maxHp, speed, armor, bounty, dist, slowUntil, slowFactor, x, y }
 *              dist = 沿路径的像素进度，越大越靠前 → 「最靠前的敌人」= dist 最大
 *   towers[]   { type, lv, col, row, x, y, cd, rateBuff, dmgBuff, spend, oc }
 *              oc = 超频标记（true = 同一座塔的强化态，加成由 towerStat(type, lv, oc) 现算）；
 *              它只活在内存里、**不进存档**（endlessRun 结构一个字段都不加）：重开即重置。
 *   bullets[]  对象池复用 { x, y, tx, ty, target, dmg, splash, slow, speed, color }
 *   path       { pts, segs, length } 折线路径；敌人只存 dist，坐标靠插值算出
 * 主循环节奏：rAF 只负责「采样时间 + 渲染」，逻辑固定 1/60 s 步长——累积器
 *   acc += dt × 倍速，while (acc >= STEP) 步进，单帧最多追 5 步（切后台不暴走）；
 *   页面隐藏时暂停累积。倍速只加快累积，不改渲染帧率。
 */

/* ===================== 0. 外部模块（技能 / 特殊塔：纯数据 + 纯函数层） =====================
 * 本文件唯一的顶层 import（两个模块零 DOM、零时钟，时间由本文件注入）；tools/td-wave-test 的加载器会把每层相对 import 改写成 data: URL（见 toModuleUrl）。
 */
import {
  SKILLS, CHILL, METEOR, REPAIR, TIMESTOP, OVERLOAD, SHIELD, BOUNTY, VORTEX, RESONANCE, SALVAGE,
  getSkill, canCast, cooldownLeft, meteorHits, purgeHits, applyChillTo, tickStatus,
  bountyMultiplier, vortexTargets, shieldHits, executeTargets, executeDamage, salvageRefund, resonanceMul,
} from './td-skills.js';
import {
  SPECIAL_TOWER_TYPES, SPECIAL_TOWER_IDS, isSpecialTower, specialTowersUnlockedAt,
  towerUnlockWave, chainDamage, pickChainTargets, poisonTick, pushDistance, applyPush,
} from './td-special-towers.js';
// 词缀 / 连携 / 专精：同样是零 DOM 零时钟的纯函数层，时间与种子一律由本文件注入。
import { affixForWave, applyAffix, affixLabel } from './td-affixes.js';
import { matchSynergy, synergyMultiplier, synergyRefund, synergyLabel } from './td-synergy.js';
import {
  SPEC_TIERS, specOptions, specById, applySpecialization, specSummary,
} from './td-specialization.js';

/* ===================== 1. 常量区（调数值只改这里） ===================== */
const GRID = { cols: 24, rows: 14, tile: 32 };          // 24×14 格、每格 32px
const VIEW = { w: GRID.cols * GRID.tile, h: GRID.rows * GRID.tile };  // 逻辑画布 768×448

/** 敌人基础数值（波次里再乘 hp / speed / gold 倍率） */
const ENEMY_TYPES = {
  basic: { name: '步兵', hp: 40, speed: 55, armor: 0, bounty: 6 },
  swift: { name: '快兵', hp: 45, speed: 95, armor: 0, bounty: 5 },
  armor: { name: '重甲', hp: 110, speed: 40, armor: 0.25, bounty: 14 },
  shield: { name: '盾兵', hp: 160, speed: 35, armor: 0.35, bounty: 22 },
  boss: { name: 'BOSS', hp: 600, speed: 32, armor: 0.35, bounty: 80 },
};

/** 4 种塔 × 3 级：数组下标 = 等级-1；cost[0] 是建造价、cost[lv] 是升级价 */
const TOWER_TYPES = {
  arrow: { name: '箭塔', cost: [60, 120, 220], dmg: [8, 14, 24], rate: [1.6, 1.9, 2.2], range: [110, 120, 130], color: '#1DB954' },
  cannon: { name: '炮塔', cost: [110, 200, 340], dmg: [22, 38, 62], rate: [0.6, 0.7, 0.8], range: [130, 140, 150], splash: [45, 55, 65], color: '#E8A33D' },
  frost: { name: '冰塔', cost: [90, 160, 280], dmg: [4, 6, 8], rate: [0.8, 0.9, 1.0], range: [110, 120, 130], slow: [0.35, 0.45, 0.55], slowMs: [1200, 1500, 1800], color: '#4CC9F0' },
  aura: { name: '光环塔', cost: [130, 180, 300], range: [120, 140, 160], auraRate: [0.15, 0.25, 0.35], auraDmg: [0, 0, 0.15], color: '#B693FD' },
};

/**
 * 塔定义总表 = 4 种基础塔 + 3 种特殊塔。建造 / 升级 / 出售 / 清单 / 数值表 / 续玩校验全部遍历这一份，
 * 特殊塔因此自动获得既有的经济与 UI 流程。TOWER_TYPES 仍只含 4 种基础塔：它是自检按「正好 4 种」
 * 断言的形状基准，且特殊塔另带 unlockWave / chain / poison / push，混进来会让两件事互相污染。
 */
const ALL_TOWER_TYPES = { ...TOWER_TYPES, ...SPECIAL_TOWER_TYPES };

/**
 * 高等级（Lv.4+）的外推参数：塔表里的数组仍然只存 Lv.1~3（自检按「三档齐全」断言），
 * Lv.4~MAX_TOWER_LEVEL 一律由 towerStat() 以 Lv.3 为基点现算，不往数组里塞 100 个数字。
 * 解锁条件：**只无尽模式、且过了第 HIGH_LV_UNLOCK_WAVE 波**（闯关最多 28 波，天然用不到）。
 */
const MAX_TOWER_LEVEL = 100;          // 塔的最高等级
const HIGH_LV_UNLOCK_WAVE = 50;       // 无尽模式第 50 波后才允许升级到 Lv.4+
/**
 * 同屏塔数硬上限。每座塔每帧都要绘制塔身 / 等级 / 光环脉冲 / 超频金环并参与索敌，而 90 波之后
 * 金币充裕，玩家会把每个可建格都铺满 —— 实测铺到 300 座上下时帧率塌方，画面看着就是「完全卡死」。
 * 80 座已远超清掉一波所需的火力，所以它是纯兜底：超限时 placeTower 拒绝建造（不扣钱），
 * 已有塔的升级 / 超频 / 拆除都不受影响。
 */
const MAX_TOWERS = 80;
/** 特效降载阈值（见 perfSkipFx）：同屏敌人数 / 塔数超过它就不再生成粒子与飘字 */
const FX_CROWD_ENEMIES = 200;
const FX_CROWD_TOWERS = 40;
const HIGH_LV_DMG_STEP = 1.12;        // 每级伤害 ×1.12
const HIGH_LV_RATE_STEP = 0.015;      // 每级攻速 +1.5%（相对 Lv.3），累计上限 +100%
const HIGH_LV_RANGE_STEP = 0.6;       // 每级射程 +0.6，累计上限 +50
// 升级价每级 ×1.12（以 Lv.3 的升级价为基点）：让 100 级真正可达（Lv.50 单次约 8 万，而非 4 亿）。
// 原来的 1.35 在 Lv.50 就是 220×1.35^48 ≈ 4 亿 —— 曲线还在，但玩家永远摸不到高等级。
const HIGH_LV_COST_STEP = 1.12;

/**
 * 「超频」（Overclock）：**同一座塔的强化态**，不是新塔种。
 * 塔实例上只多一个布尔字段 oc，全部加成由 towerStat(type, lv, oc) 现算 —— 所以
 * TOWER_TYPES / SPECIAL_TOWER_TYPES 的三元素数组一个字都不用改，也不往 ALL_TOWER_TYPES 里加类型：
 * 那两条一旦动了，塔数值表、场上塔清单与既有断言会一起被污染。
 * oc 只活在内存里、不进存档（endlessRun 结构不新增字段）：重开 / 续玩即重置。
 */
const OC_DMG_MUL = 1.6;      // 伤害 ×1.6
const OC_RATE_MUL = 1.25;    // 攻速 ×1.25
const OC_RANGE_MUL = 1.15;   // 射程 ×1.15
const OC_AURA_MUL = 1.4;     // 光环塔的攻速 / 伤害增幅各 ×1.4（仍受既有 +100% 上限约束）
const OC_SLOW_ADD = 0.10;    // 冰塔减速 +10 个百分点（上限仍是 80%）
const OC_POISON_MUL = 1.6;   // 毒塔 dot 的每秒伤害 ×1.6
const OC_PUSH_MUL = 1.25;    // 力场塔推回距离 ×1.25
const OC_CHAIN_COUNT = 5;    // 特斯拉链式目标数 3 → 5
const OC_SUCCESS = 0.5;      // 成功率 50%（overclockRoll(rand) = rand < 0.5）
const OC_FAIL_DROP = 5;      // 失败降 5 级，最低 1 级
const OC_COST_BASE = 240;    // 超频价基数：overclockCost(1) = 240
const OC_COST_STEP = 1.12;   // 超频价每级 ×1.12
const OC_COUNT_MIN = 1;      // 「一键超频」的座数区间（输入框 min/max 与纯函数的夹取共用这两个常量）
const OC_COUNT_MAX = 20;
// 无尽存档里「剩余时长」类字段的夹取上限（10 分钟）：坏存档 / 时钟跳变都不会写进一个荒谬的值
const RUN_LEFT_MAX_MS = 600000;
// 超频塔的金色（画布金环 / 角标 / 清单徽章共用一份）：深色底上是亮金、浅色底上是暖金，
// 且画布与徽章都带描边，两套主题下都有足够对比度（不跟随主题变量，免得浅色主题把金色洗淡）。
const OC_COLOR = '#FFD166';

/** 全局平衡参数 */
const BALANCE = {  startGold: 150, startLives: 20,
  sellRatio: 0.6,          // 出售返还「总投入」的 60%
  waveGapMs: 2500,         // 波与波之间的喘息
  maxEnemiesPerWave: 400,  // 软上限，防掉帧（触顶后靠血量与速度继续施压）
};

const STEP = 1 / 60;                  // 固定逻辑步长
const MAX_STEPS_PER_FRAME = 5;        // 单帧最多补偿 5 步
/**
 * 倍速档位：1x → 2x → 3x → 4x → 回到 1x（按钮点一下走一档，见 tower-defense.html 的 tdSpeed）。
 * 为什么封顶 4x —— 这是从主循环算出来的硬上限，不是口味问题：
 *  · 主循环是固定步长 STEP = 1/60，每帧 `acc += dt * state.speed` 后最多补
 *    MAX_STEPS_PER_FRAME = 5 步，追不上就把欠账丢掉（`if (steps >= MAX_STEPS_PER_FRAME) acc = 0`）。
 *  · 60fps 下 dt ≈ 1/60，一帧需要补的步数 ≈ speed —— 所以**倍速上限 ≈ 5x**。
 *    5x 正好压在补帧上限上，任何一帧抖动（dt 稍大）就触发丢欠账，表现是
 *    **画面变卡、实际速度却上不去**；再往上（6x/8x）连 60fps 都吃不满，只会更卡。
 *  · 4x 留了 1 步余量（dt 涨到 20ms 才顶格），常见掉帧下仍然跟得上，所以最高档取 4x。
 *  · MAX_STEPS_PER_FRAME 不许跟着调大：一次补太多步时敌人单帧位移过大，
 *    会出现「瞬移穿塔」（射程/碰撞按每步位置判定）。本倍速上限与它同时成立。
 *  · 倍速只放大 acc 的累积（逻辑步数），不改 requestAnimationFrame 的渲染帧率。
 */
const SPEED_LEVELS = [1, 2, 3, 4];
const EARLY_WAVE_MUL = 1.3;           // 无尽前 5 波赏金系数（只在 startWave 调用处乘，见那里的注释）
const BEST_KEY = 'mlttc-td-best';     // 第一步的旧存档键：只做一次性迁移，迁移后立即删除
const PROGRESS_KEY = 'mlttc-td-progress'; // 唯一存档键（unlocked / levelBest / endlessBest）
const LEVEL_MAX = 100;                // 闯关模式总关数
const DEFAULT_SEED = 'mlttc-td-demo'; // 自检脚本用的固定种子
const LEVEL_DIFF_STEP = 0.05;         // 关卡难度斜率：diff = 1 + 斜率 ×(L-1)，L100 → 5.95
/**
 * 闯关模式经济参数（详见 buildLevelWave 的经济说明）。
 * 赏金不再按「只数」累积，而是每波一个固定赏金池，池子按基础赏金权重摊到每只怪头上。
 *  · LEVEL_POT      第 1 关第 1 波的赏金池（金）。由「可买 DPS ≈ 所需 DPS」反解，再留余量
 *                   （曲线峰值 ratio ≈ 0.78，红线 0.85 见 tools/td-wave-test 第 6 节）。
 *  · LEVEL_POT_EXP  池子随 diff 的指数：血量/数量一起涨，金币必须涨得更快才跟得上。
 *  · LEVEL_POT_FALL 池子随波次号的衰减指数：后段靠已建好的火力，不靠新钱（否则波数越
 *                   多、钱越多，高关卡反而比低关卡轻松 —— 这就是原来难度倒挂的根因之一）。
 */
const LEVEL_POT = 664;
const LEVEL_POT_EXP = 2.5;
const LEVEL_POT_FALL = 1.5;

/**
 * 前 12 关手工调参（以「倍率」形式压平公式值，1 = 不额外调整）。
 * 为什么要有它：diff 从第 1 关就按 5% 起跳，光靠公式前几关的 hp/数量对新手仍然偏硬，
 * 这里把 1~12 关的血量与数量各乘一个 <1 的系数做缓坡；13 关起不再查表，完全走公式。
 */
const LEVEL_TWEAKS = {
  1: { hp: 0.72, count: 0.70 }, 2: { hp: 0.76, count: 0.74 }, 3: { hp: 0.80, count: 0.78 },
  4: { hp: 0.83, count: 0.81 }, 5: { hp: 0.86, count: 0.84 }, 6: { hp: 0.89, count: 0.87 },
  7: { hp: 0.91, count: 0.89 }, 8: { hp: 0.93, count: 0.91 }, 9: { hp: 0.95, count: 0.93 },
  10: { hp: 0.96, count: 0.95 }, 11: { hp: 0.98, count: 0.97 }, 12: { hp: 0.99, count: 0.98 },
};
/* ===================== 2. 无尽波次生成器 ===================== */
/** 字符串 → uint32（FNV-1a 变体）：让波次可复现，调试与第二步自检都靠它 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/** mulberry32：32 位状态的小 PRNG，快、无依赖、同种子同序列 */
function mulberry32(a) {
  let t = a >>> 0;
  return function random() {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * 无尽波次生成器。设计取舍（为什么这么取）：
 *  · total = 6 + 1.5n + 0.05n²：一次项让每波略增，二次项让后期「成群」；数量涨得
 *    比血量慢，压力来自血量而不是帧率；再套 maxEnemiesPerWave 软上限。
 *  · 权重漂移：basic 恒为 1（保证场面不空），swift 第 4 波、armor 第 9 波、shield
 *    第 18 波解锁，权重随 n 线性上升 → 每解锁一档都「换味」，不是一次把池子倒完。
 *  · 拆组：按权重向下取整、每组至少 1（避免某档解锁后长期 0 只），向下取整的余数
 *    补给权重最大的组，使各组计数之和严格等于 total。
 *  · hpMul = 1.06^(n-1)（约 12 波翻倍，与塔的攻击成长同量级）；spdMul 封顶 2.2（再快玩家
 *    来不及反应）；goldMul = 1.10^(n-1) 略低于血量增速，制造后期金币紧张。
 *  · spawnGap 从 1.15s 收到 0.22s 封顶，只压缩到 1/5，防止后期一帧刷出整波。
 *  · BOSS 波 n%10===0：额外插入 1+floor(n/25) 只 BOSS（血量 ×8、速度 ×0.85），
 *    不计入 total → 实际出场数 = total + bossCount。
 *  · 高波次叠乘 LATE_HP_STEP^(n-LATE_HP_FROM)：1.06 单层在高波次偏软，第 30 波之后再加一层
 *    **轻量**叠乘（1.010/波）——它是「加一点点」，不是陡坡：陡到 1.025 时第 90 波单波 4144 万血，而
 *    「场上不清空就不算这波结束」的收尾条件会让玩家永远停在同一波（BUG 的血量侧成因）。
 */

/**
 * 无尽高波次叠乘血量。设计取舍（为什么是这两个数）：
 *  · 为什么从第 30 波起：**闯关模式每关最多 28 波**（waves = 4 + floor(L×0.24)，L100 → 28），
 *    而闯关的血量基数也走 generateEndlessWave —— 阈值 ≥ 30（= LATE_HP_FROM ≥ 30，自检第 14.4
 *    条钉住这条硬门槛）才能保证这一层**完全不进入闯关**，闯关平衡一点不动。
 *  · 为什么从 1.025 改成 1.010 —— 它只该是「加一点点」，不该是第二堵墙：
 *    - 老值 1.025 与 1.06 叠成每波 ×1.0865：第 90 波 lateHpMul ≈ 4.40、单波 4144 万血，而玩家在
 *      90 波的实际输出（复现存档：3 座 Lv.50 超频塔）只有几万 DPS → 一波要打 20 分钟以上。
 *    - 新值 1.010：第 90 波 lateHpMul ≈ 1.82、单波 1711 万血；配合已降到 1.12 的升级价斜率
 *      （自检第 20.8 条），按参考 DPS 10 万算约 171 秒清完，落在第 21 节「< 240 秒」的护栏内。
 *    - 边界：再缓（≤1.005）等于没加、高波次失去「明显更硬」；再陡（≥1.02）又走回那堵墙。
 *      这一层**只乘 hp**：hpMul = 1.06^(n-1) 一个数都没动（第 1~30 波逐组相等由第 21.7 条钉住）。
 *  · n ≤ LATE_HP_FROM 时 lateHpMul 严格等于 1（不是 ≈1、也不参与取整），第 1~30 波的
 *    每次取整结果都与改动前完全一致。
 */
const LATE_HP_FROM = 30;      // 第 30 波起额外加血（必须 ≥ 30，见上面「闯关最多 28 波」）
const LATE_HP_STEP = 1.010;   // 每多一波，血量再 ×1.010（叠在 1.06 之上；老值 1.025 见上面的 BUG 复盘）

/**
 * 血量的有限上限。
 *
 * 无尽模式的波次本身没有上限，但血量是「1.06^(n-1) × 1.010^(n-30)」的指数叠乘：
 * 实测第 8000 波还是有限值，到第 ~10000 波就溢出成 Infinity —— 那时 `hp - 伤害`
 * 仍是 Infinity，敌人永远打不死，参与显示/结算还可能产生 NaN。也就是说「无尽」
 * 会在数值上先烂掉。
 *
 * 这里封顶到安全整数上限（约 9.0e15）：波次仍可无限推进、出怪照常，只是血量不再涨。
 * 玩家实际到不了这个波次（第 200 波每只怪已数千万血），但这样能同时保证
 * 「波次无上限」与「数值永远有限」两个性质。
 */
const HP_CEIL = Number.MAX_SAFE_INTEGER;

/** 按倍率算血量：指数溢出时封顶到 HP_CEIL，而不是放任它变成 Infinity */
function scaledHp(baseHp, mult) {
  const v = Math.round(baseHp * mult);
  if (!Number.isFinite(v)) return HP_CEIL;
  return Math.min(HP_CEIL, Math.max(1, v));
}
function generateEndlessWave(n, seed) {
  // 每波独立随机流：第 n 波的组成只由 (n, seed) 决定，与前面的波无关
  const rng = mulberry32(hashSeed('endless:' + n + ':' + seed));

  let total = 6 + Math.floor(1.5 * n + 0.05 * n * n);
  total = Math.min(total, BALANCE.maxEnemiesPerWave);

  // 种类池：解锁条件 + 权重漂移（basic 恒有权重 1）
  const pool = [{ type: 'basic', w: 1 }];
  if (n >= 4) pool.push({ type: 'swift', w: 0.35 + 0.01 * n });
  if (n >= 9) pool.push({ type: 'armor', w: 0.20 + 0.012 * n });
  if (n >= 18) pool.push({ type: 'shield', w: 0.05 + 0.008 * n });

  // 按权重拆组：先向下取整并保证每组 ≥1，再把余数补给权重最大的组
  const sumW = pool.reduce((s, p) => s + p.w, 0);
  const counts = pool.map((p) => Math.max(1, Math.floor((total * p.w) / sumW)));
  const assigned = counts.reduce((s, c) => s + c, 0);
  let topIdx = 0;
  for (let i = 1; i < pool.length; i++) if (pool[i].w > pool[topIdx].w) topIdx = i;
  counts[topIdx] += total - assigned;
  if (counts[topIdx] < 1) counts[topIdx] = 1;   // 兜底：极端权重下别出现 0 或负数

  // 血量增长：1.06^(n-1) 约 12 波翻倍。原来取 1.155（4.6 波翻倍）实测第 30 波就要 1.6 万
  // DPS，而满配塔阵只能到 2 千上下 —— 等于 30 波左右必死，数值上不可行。
  const hpMul = Math.pow(1.06, n - 1);
  // 高波次叠乘：第 31 波起生效，n ≤ LATE_HP_FROM 时严格 = 1（第 1~30 波数值与改动前完全一致）
  const lateHpMul = n > LATE_HP_FROM ? Math.pow(LATE_HP_STEP, n - LATE_HP_FROM) : 1;
  const spdMul = Math.min(2.2, 1 + 0.012 * (n - 1));
  // 赏金增长：1.05^(n-1)。与血量曲线同量级，避免后期钱多到没处花。
  const goldMul = Math.pow(1.05, n - 1);

  const groups = pool.map((p, i) => {
    const base = ENEMY_TYPES[p.type];
    return {
      type: p.type, count: counts[i],
      hp: scaledHp(base.hp, hpMul * lateHpMul),   // 极高波次封顶，避免 Infinity
      speed: base.speed * spdMul,
      bounty: Math.max(1, Math.round(base.bounty * goldMul)),
      armor: base.armor,
    };
  });

  // BOSS 波：额外插入，不占 total
  const isBossWave = n % 10 === 0;
  let bossCount = 0;
  if (isBossWave) {
    bossCount = 1 + Math.floor(n / 25);
    const b = ENEMY_TYPES.boss;
    groups.push({
      type: 'boss', count: bossCount,
      // BOSS 同样乘 lateHpMul：否则高波次 BOSS 相对小兵反而变软（BOSS 波都在 n%10===0，
      // 第 30 波是 BOSS 波但正好在阈值上，lateHpMul = 1；第 40 波起吃到 1.025^10 及以上）
      hp: scaledHp(b.hp, hpMul * lateHpMul * 8),   // 同样封顶
      speed: b.speed * spdMul * 0.85,
      bounty: Math.max(1, Math.round(b.bounty * goldMul)),
      armor: b.armor,
    });
  }

  // 出场间隔（ms）：每波 -15ms，钳在 [220, 1150]
  const spawnGap = Math.max(0.22, Math.min(1.15, 1.15 - 0.015 * n)) * 1000;
  void rng;   // 随机流保留给第二步做组内出场抖动
  return { n, total, bossCount, groups, spawnGap, isBossWave };
}
/**
 * 波次曲线自检：返回 [{ wave, total, hp }]（hp = 该波第一个组的血量）。
 * 不含任何 DOM 代码，`node --input-type=module -e "import(...)"` 可直接调。
 */
export function debugWaveCurve(waves) {
  return (waves || []).map((n) => {
    const w = generateEndlessWave(n, DEFAULT_SEED);
    return { wave: w.n, total: w.total, hp: w.groups[0].hp };
  });
}

/* ===================== 2a. 波次僵局判定（无尽模式的「打不完」出口） ===================== */
/**
 * 僵局阈值（毫秒）。一波的收尾条件是「出场队列放空 **且** 场上清空」，高波次血量指数增长，
 * 玩家输出一旦跟不上这一波就永远打不完（出怪无止境、金币不涨、像冻住）。血量斜率已降到
 * 1.010/波（见 LATE_HP_STEP），这层判定是第二道保险：真打不完时给玩家一个体面的出口。
 */
const STALL_WAVE_MS = 90000;    // 波次已进行 ≥ 90 秒
const STALL_NO_KILL_MS = 20000; // 且 ≥ 20 秒没死过一只（输出已经完全跟不上）
const STALL_HARD_MS = 300000;   // 硬上限：单波 ≥ 5 分钟，不管还在不在杀，都算僵局
const STALL_REMIND_MS = 60000;  // 浮层被「继续打」关掉后，同一波最多每 60 秒再提醒一次
/** 阈值对外导出：自检断言「策略数字没被顺手改掉」，浮层文案与调参也读这一份 */
export const STALL_LIMITS = Object.freeze({
  waveMs: STALL_WAVE_MS, sinceKillMs: STALL_NO_KILL_MS, hardMs: STALL_HARD_MS, remindMs: STALL_REMIND_MS,
});

/**
 * 波次僵局判定（纯函数：不读 state、不碰 DOM、不看时钟，参数进 → 布尔出）。
 * info = { waveMs, sinceKillMs, aliveCount, total }：本波已进行毫秒 / 距上次击杀毫秒 /
 * 场上活怪数 / 本波出场总数（total 本判定不读，留给浮层文案与后续调参）。
 * 规则（边界取「≥」：90000 / 20000 这一刻即算僵局，与「90 秒 + 20 秒无击杀 → true」这条用例一致）：
 *  1. waveMs ≥ 90000 且 sinceKillMs ≥ 20000 且 aliveCount > 0 → true；
 *  2. waveMs ≥ 300000（5 分钟硬上限）且 aliveCount > 0 → true（不看击杀间隔）；
 *  3. 其余 false。**场上没有活怪时永远 false** —— 那是正常收尾，不是僵局。
 */
export function isWaveStalled(info) {
  if (!info || typeof info !== 'object') return false;
  const waveMs = Number(info.waveMs);
  const sinceKillMs = Number(info.sinceKillMs);
  const alive = Number(info.aliveCount);
  if (!(alive > 0)) return false;                    // 含 NaN：认不出活怪就不报僵局
  if (!Number.isFinite(waveMs)) return false;
  if (waveMs >= STALL_HARD_MS) return true;          // 硬上限不看击杀间隔
  return Number.isFinite(sinceKillMs) && waveMs >= STALL_WAVE_MS && sinceKillMs >= STALL_NO_KILL_MS;
}

/* ===================== 2b. 闯关模式：关卡派生 + 关卡波次 ===================== */
/**
 * 第 L 关的完整配置（L 夹到 [1,100]，非法输入按第 1 关处理）：
 *  waves    = 4 + floor(L*0.24)          L1→4、L50→16、L100→28（波数固定 ⇒ 有明确结局）
 *  lives    = max(3, 20 - floor(L/6))    20 一路压到 4
 *  gold     = 160 + 10L                 起步资金随关卡给，后期补得起塔
 *  diff     = 1 + 0.05(L-1)             hp 与 count 的统一系数（斜率见 LEVEL_DIFF_STEP）
 *  mapIndex = (L-1) % 6                  6 张路点模板轮换（换图会作废旧塔，见 resetGame）
 */
function generateLevel(L) {
  const level = Math.max(1, Math.min(LEVEL_MAX, Math.floor(Number(L) || 0) || 1));
  return {
    level,
    waves: 4 + Math.floor(level * 0.24),
    lives: Math.max(3, 20 - Math.floor(level / 6)),
    gold: 160 + 10 * level,
    diff: 1 + LEVEL_DIFF_STEP * (level - 1),
    mapIndex: (level - 1) % 6,
  };
}

/**
 * 第 L 关第 n 波的出场配置：先向 generateEndlessWave 要一份「标准波」，再把 hp 与 count
 * 乘上 diff（前 12 关再叠 LEVEL_TWEAKS）——所以闯关模式同样没有写死的出怪表，BOSS 波
 * 判定也仍然来自无尽生成器（n % 10 === 0）。
 * 两条工程约束只防失控，不改数值曲线：
 *  · 数量软上限：放大后超过 BALANCE.maxEnemiesPerWave 就等比压缩数量系数（血量照常放大，
 *    压力仍落在血量上），否则高关单波上千只，帧率与单波时长会一起崩。
 *  · 出场间隔压缩：按系数开方缩短 spawnGap，让放大后的波次出场时长与无尽模式同量级。
 * 经济（这一段决定难度曲线是否倒挂，改之前先看 tools/td-wave-test 的可通性断言）：
 *  · 旧做法是把基波赏金直接搬过来，等于「赏金 × 只数」累积 —— 数量随 diff 涨，赏金跟着涨，
 *    于是越到高关越富；而「所需 DPS」是 单波总血量 / 出怪时长，与只数无关，被 maxEnemiesPerWave
 *    压住。两者一起导致中段关卡（L20~L60）预算追不上压力、后期又反过来比低关轻松。
 *  · 现在改成「每波一个赏金池」pot，池子按基础赏金权重摊到每只怪身上：与只数解耦，且
 *    池子 = LEVEL_POT × diff^2.5 ÷ n^1.5 —— 随关卡难度涨、随波次号衰减。
 */
function buildLevelWave(lv, n) {
  const base = generateEndlessWave(n, 'level:' + lv.level);
  const tweak = LEVEL_TWEAKS[lv.level] || null;
  const hpScale = lv.diff * ((tweak && tweak.hp) || 1);
  let cntScale = lv.diff * ((tweak && tweak.count) || 1);
  const baseTotal = Math.max(1, base.total);
  if (baseTotal * cntScale > BALANCE.maxEnemiesPerWave) cntScale = BALANCE.maxEnemiesPerWave / baseTotal;
  const groups = base.groups.map((g) => ({
    ...g,
    count: Math.max(1, Math.ceil(g.count * cntScale)),      // 向上取整：别让某组被压成 0
    hp: Math.max(1, Math.round(g.hp * hpScale)),
  }));
  // 赏金池：按各组「基础赏金 × 只数」的权重摊成单只赏金（income 因此恒等于 pot，与只数无关）
  const pot = (LEVEL_POT * Math.pow(lv.diff, LEVEL_POT_EXP)) / Math.pow(n, LEVEL_POT_FALL)
    * ((tweak && tweak.bounty) || 1);
  const weight = groups.reduce((s, g) => s + g.bounty * g.count, 0) || 1;
  for (const g of groups) g.bounty = Math.max(1, Math.round((pot * g.bounty) / weight));
  const total = groups.reduce((s, g) => s + (g.type === 'boss' ? 0 : g.count), 0);
  return {
    ...base, groups, total,
    spawnGap: Math.max(120, Math.min(base.spawnGap, base.spawnGap / Math.sqrt(cntScale))),
  };
}

/* ===================== 2c. 下一波预告（纯函数） ===================== */
/**
 * 场上所有塔的实际 DPS 之和（纯函数：不读 state、不写 DOM）。
 * 每座塔取 dmg × rate，再乘它身上**现成**的 rateBuff / dmgBuff —— 光环（含共鸣）的效果已经由
 * updateTowers 写进这两个字段，所以这里既不必也不该重算光环几何，否则就会与战斗结算算法分叉。
 * 光环塔（没有 dmg / rate）与毒塔（dmg 恒为 0、输出走 dot）在这里贡献 0：预览只回答
 * 「直接伤害够不够」，把毒 dot 算进来会让人高估自己（毒是额外收益，不是保底输出）。
 */
function towersDps(towers) {
  let sum = 0;
  const list = Array.isArray(towers) ? towers : [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (!t || !ALL_TOWER_TYPES[t.type]) continue;
    const st = towerStatOf(t);   // 含超频与专精后的实际值（与战斗同源）
    if (!st || !(st.dmg > 0) || !(st.rate > 0)) continue;
    sum += st.dmg * st.rate * (1 + (Number(t.rateBuff) || 0)) * (1 + (Number(t.dmgBuff) || 0));
  }
  return sum;
}

/**
 * 下一波预告（纯函数：不碰 DOM、不读时钟、不改 state —— 自检可以直接造一份假 state 断言）。
 *   wave       下一波的波次号（= state.wave + 1）
 *   total      该波实际出场数 = 各组 count 之和（BOSS 组也算在内；王潮波就是 BOSS 的只数）
 *   comp       兵种构成摘要，形如「步兵×12 快兵×5 BOSS×1」
 *   reqDps     该波所需 DPS = 「将出场的小兵总血量」÷「出怪时长」。与第 2 章自检的 waveStat 同一口径：
 *              出怪时长 = (出场数 - 1) × spawnGap / 1000（= 最后一只出场的时刻）；BOSS 血量不计
 *              （10 的倍数波里 BOSS 是额外插入的，算进来会让读数直接翻倍）。
 *              唯一的例外是王潮（整波只剩 BOSS）：此时没有小兵可算，退回把 BOSS 血量计入 ——
 *              否则会显示「需要 DPS 0」，那正好是最危险的方向（显示安全、实际是硬墙）。
 *   myDps      场上所有塔的实际 DPS 之和（见 towersDps）
 *   ratio      reqDps / myDps；myDps 为 0 时返回 **Infinity**（不是 NaN、也不是 0）——
 *              「你一点 DPS 都没有」本来就是最危险的读数，Infinity 天然落在 >1.0 的红档，调用方不必特判
 *   affixLabel 该波词缀的单行文案（只有无尽模式的 5 的倍数波才有；其余为 ''）
 *
 * 为什么把词缀也套进预告：预告要描述「你真正会遇到的那一波」。厚甲波 +60% 血量，若不套词缀，
 * 读数会低报 60%（看起来打得动，实际顶不住）；王潮波更是完全不同的一场仗。
 */
function nextWavePreview(state) {
  const s = state && typeof state === 'object' ? state : {};
  const wave = Math.max(1, Math.floor(Number(s.wave) || 0) + 1);
  const raw = s.mode === 'level' && s.level ? buildLevelWave(s.level, wave) : generateEndlessWave(wave, s.seed);
  const affix = s.mode === 'level' ? null : affixForWave(wave, s.seed);
  const cfg = affix ? applyAffix(raw, affix) : raw;   // 入参不动，拿返回值
  const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  let total = 0, hpSum = 0, bossHp = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    if (!g) continue;
    const hp = (Number(g.count) || 0) * (Number(g.hp) || 0);
    total += Number(g.count) || 0;
    if (g.type === 'boss') bossHp += hp; else hpSum += hp;
  }
  const spawnGap = Number(cfg.spawnGap) || 0;
  const seconds = Math.max(0.001, (Math.max(0, total - 1) * spawnGap) / 1000);
  const reqDps = (hpSum > 0 ? hpSum : bossHp) / seconds;   // 王潮波退回计入 BOSS 血量（见上）
  const comp = groups.map((g) => {
    const def = g ? ENEMY_TYPES[g.type] : null;
    return (def ? def.name : String(g && g.type)) + '×' + (Number(g && g.count) || 0);
  }).join(' ');
  const myDps = towersDps(s.towers);
  return {
    wave, total, comp, reqDps, myDps,
    ratio: myDps > 0 ? reqDps / myDps : Infinity,
    affixLabel: affixLabel(affix),
  };
}

/* ===================== 3. 地图与路径 ===================== */
/**
 * 路点模板（6 张）：每张是折线拐点数组（单位＝格）。三条硬约束（新增图形也必须满足）：
 *  · 第一个点 x = -1 → 从画布左侧外进入；最后一个点 x = cols(24) → 从右侧外离开；
 *  · 相邻两点必须共 x 或共 y（斜线会让 buildPathTiles 与像素路径不一致）；
 *  · 拐点不重合、非相邻线段不交叉（每条路径不重复占同一格）。
 * 无尽模式固定用第 1 张；闯关模式按 (L-1) % 6 轮换。
 */
const MAP_TEMPLATES = [
  [[-1, 2], [6, 2], [6, 9], [18, 9], [18, 4], [24, 4]],                              // 1 长廊
  [[-1, 11], [4, 11], [4, 4], [10, 4], [10, 11], [16, 11], [16, 6], [24, 6]],        // 2 蛇形
  [[-1, 7], [8, 7], [8, 2], [16, 2], [16, 10], [22, 10], [22, 6], [24, 6]],          // 3 阶梯
  [[-1, 1], [5, 1], [5, 12], [12, 12], [12, 2], [19, 2], [19, 11], [24, 11]],        // 4 双拐（上下大幅折返）
  [[-1, 1], [20, 1], [20, 5], [4, 5], [4, 9], [16, 9], [16, 12], [24, 12]],          // 5 回环（向内收拢再甩出）
  [[-1, 2], [8, 2], [8, 6], [2, 6], [2, 10], [14, 10], [14, 4], [21, 4], [21, 12], [24, 12]], // 6 长蛇（九弯）
];

/** 格坐标路点 → 像素路点 + 累计长度线段表（敌人只记 dist，索敌不用排序） */
function buildPath(points) {
  const pts = points.map(([gx, gy]) => ({ x: (gx + 0.5) * GRID.tile, y: (gy + 0.5) * GRID.tile }));
  const segs = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len, start: acc });
    acc += len;
  }
  return { pts, segs, length: acc };
}

/**
 * 路径进度 dist 处的像素坐标（越界自动夹到两端）。
 * 塔多 / 怪少时这里是高风险点：dist 可能来自被力场推回、被黑洞插值、或坏存档还原出来的敌人。
 * NaN 参与比较时所有 `d <= s.start + s.len` 都是 false，会一路穿到最后一个段的终点 —— 结果虽然
 * 有限，但「为什么坐标跑到终点」完全不可预期。所以先把 dist 规整成 [0, length] 里的有限数，
 * 函数对任何输入都返回有限坐标、且不抛异常（第 21 节断言这一点）。
 */
function pointAt(path, dist) {
  const segs = path && path.segs ? path.segs : [];
  if (!segs.length) return { x: 0, y: 0 };
  const raw = Number(dist);
  const len = Number.isFinite(path.length) ? path.length : 0;
  const d = Number.isNaN(raw) ? 0 : (raw <= 0 ? 0 : (raw >= len ? len : raw));
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (d <= s.start + s.len) {
      const t = s.len > 0 ? (d - s.start) / s.len : 0;
      return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
    }
  }
  const last = segs[segs.length - 1];
  return { x: last.b.x, y: last.b.y };
}

/** 折线覆盖到的格子（"x,y" 键）→ 不可建造的路径带（宽 1 格） */
function buildPathTiles(points) {
  const set = new Set();
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1);
    let x = x1, y = y1;
    set.add(x + ',' + y);
    while (x !== x2 || y !== y2) { x += dx; y += dy; set.add(x + ',' + y); }
  }
  return set;
}

/** 可建造 = 在网格内且不在路径带上；towerAt = 该格已有的塔（没有则 null） */
function isBuildable(st, col, row) {
  if (col < 0 || row < 0 || col >= GRID.cols || row >= GRID.rows) return false;
  return !st.pathTiles.has(col + ',' + row);
}
function towerAt(st, col, row) {
  for (let i = 0; i < st.towers.length; i++) {
    const t = st.towers[i];
    if (t.col === col && t.row === row) return t;
  }
  return null;
}

/* 对外导出：给自检脚本与调试台用（纯函数，无副作用） */
export {
  GRID, VIEW, ENEMY_TYPES, TOWER_TYPES, ALL_TOWER_TYPES, BALANCE, MAP_TEMPLATES, LEVEL_TWEAKS, LEVEL_MAX, PROGRESS_KEY,
  LEVEL_DIFF_STEP, LEVEL_POT, LEVEL_POT_EXP, LEVEL_POT_FALL,
  hashSeed, mulberry32, generateEndlessWave, generateLevel, buildLevelWave, buildPath, buildPathTiles,
  encodeSave, decodeSave, levelTotalEnemies,   // 存档码往返 + 关卡总怪量：自检脚本直接断言
  describeTowers,   // 场上塔清单的数据化描述（纯函数，清单渲染与自检共用同一份口径）
  nextUpgradeTarget,   // 「快速升级」按钮的目标选择（纯函数：按建造顺序取第一个未满级的塔）
  planBatchUpgrade,    // 「批量升级」的先算后扣计划（纯函数：等级最低优先、同级先建者，金币不够就少升几座）
  overclockCost,       // 超频价（纯函数：Lv.1 = 240，每级 ×1.12）
  overclockRoll,       // 50% 判定（纯函数：rand 由调用方给，rand < 0.5 即成功，便于断言边界）
  overclockFailLevel,  // 超频失败后的等级（纯函数：降 5 级、最低 1 级）
  planBatchOverclock,  // 「一键超频」的先算后扣计划（纯函数：未超频、等级最高优先、同级先建者）
  effectiveSkillCost,  // 技能当前花费（纯函数：解锁后每多一波 ×(1+4%)）
  skillEffectScale,    // 技能当前效果倍率（纯函数：解锁后每多一波 ×(1+5%)，各技能再各自封顶）
  SKILL_CASTERS,       // 12 个技能的施放实现表（id → 函数）：自检拿 SKILLS.map(s=>s.id) 逐位比对，漏接即 FAIL
  planSalvage,         // 「回收」的选塔计划（纯函数：等级最低优先、同级先建者、全额返还）
  SKILL_EFFECT_CAP, SKILL_CHILL_CAP,   // 技能效果的封顶值（2 倍 / 减速 80%，自检直接断言）
  RUN_LEFT_MAX_MS,     // 存档里「剩余毫秒」类字段的夹取上限（自检断言坏值被夹住）
  mergeProgress,   // 导入合并（自检断言「导入的无尽进度必须胜出」，防止退回「谁新留谁」）
  towerStatRows,   // 塔数值表的行 HTML（纯函数：自检断言「并进特殊塔后不出现 NaN / undefined」）
  towerStat,       // 某塔某等级的实际数值（Lv.1~3 读数组、Lv.4+ 现算外推：战斗 / 清单 / 快速升级同源）
  MAX_TOWER_LEVEL, HIGH_LV_UNLOCK_WAVE,   // 等级上限 + 高等级解锁波次（自检按常量取，不写死 3）
  HIGH_LV_COST_STEP, HIGH_LV_DMG_STEP,    // 高等级的两条斜率（自检断言 1.12 生效、Lv.50 升级价在 1 万~20 万）
  nextWavePreview, towersDps,   // 下一波预告（纯函数：不碰 DOM，自检直接断言 myDps / reqDps / comp）
  // 三个纯逻辑模块经主文件转发一份（自检与调试台不必再各自解析路径；模块本身不改一行）
  affixForWave, applyAffix, affixLabel,
  matchSynergy, synergyMultiplier, synergyRefund, synergyLabel,
  SPEC_TIERS, specOptions, specById, applySpecialization, specSummary,
  towerStatSpec,   // towerStat + 专精（自检断言「串起来之后 dmg 真的变大」，不必再造一座塔）
  LATE_HP_FROM, LATE_HP_STEP, SPEED_LEVELS, HP_CEIL,   // 高波次叠乘阈值/斜率 + 倍速档位（自检直接断言）
  MAX_TOWERS,   // 同屏塔数硬上限（自检断言存在 + 其余计划类纯函数不受它影响）
  pointAt,          // 路径进度 → 坐标（纯函数：自检用坏 dist 断言「有限坐标、不抛异常」）
  PUSH_IMMUNE_MS, PUSH_BACK_FLOOR_PX, PUSH_DECAY, PUSH_MIN_PX,   // 力场回推收敛的四个数（自检直接断言）
};

/* ===================== 4. 运行时状态 ===================== */
/**
 * 唯一可变状态。实体数组一律「就地删除 / 池化复用」，不给 GC 留垃圾：enemies 反向
 * 遍历 + swap-remove；bullets 命中即回收进 bulletPool；粒子/飘字同理。
 */
const state = {
  seed: DEFAULT_SEED, wave: 0, lives: BALANCE.startLives, gold: BALANCE.startGold,
  kills: 0, best: 0,
  mode: 'endless', level: null, inRun: true, result: '', // 模式 endless/level、关卡配置、是否在对局中、结算结果
  waveActive: false, nextWaveIn: 0,      // 当前波是否在打 / 下一波倒计时（ms）
  spawnQueue: [], spawnIdx: 0,           // 本波出场队列（元素是 group 引用）+ 消费下标
  spawnGap: 1000, spawnTimer: 0, waveStats: null,
  // 僵局出口用的时间戳 / 标志（判定见 isWaveStalled）：全部是本局内存态，**不进存档**（存档结构一个字段都没加）。
  waveStartedAt: 0,      // 本波开始的逻辑时刻（startWave 写 state.timeMs）
  lastKillAt: 0,         // 最近一次击杀的逻辑时刻（killEnemy 写 state.timeMs）
  stallShown: false,     // 本波是否已弹过僵局浮层（防反复打扰）
  stallNoticeAt: 0,      // 上次弹 / 关掉浮层的逻辑时刻（配 STALL_REMIND_MS 限流）
  stallPaused: false,    // 浮层挂起中：主循环像 state.paused 一样不推进，但不改 UI 的暂停按钮态
  // 本波的词缀（无尽模式 5 的倍数波才有，闯关模式恒为 null）+ 它的 flags 副本。
  // waveFlags 单独存一份是为了让减速结算处不必每次都 `&& affix.flags &&` 地判空。
  waveAffix: null, waveFlags: {},
  paused: false, hidden: false, speed: 1, gameOver: false, timeMs: 0,
  // 逻辑步进抛过异常：主循环停摆（否则每帧抛一次、render 被跳过 → 画面停在最后一帧、数据全冻，
  // 玩家看到的只是「卡死」而不是「出错」）。提示画在画布顶部，见 frame 的 try/catch 与 drawHaltBanner。
  halted: false,
  awaitingResume: false, resumeDone: false,   // 等玩家选「继续/重开」时主循环不推进（见 frame）
  selectedType: null, selectedTower: null, hover: { col: -1, row: -1 }, reducedMotion: false,
  enemies: [], towers: [], bullets: [], particles: [], floaters: [],
  mapIdx: 0, path: null, pathTiles: null,
  // 技能时序全部以 state.timeMs（逻辑步累计）为基准：暂停 / 隐藏 / 等续玩时 step() 不跑，
  // 冷却与持续时间一起冻结。skillReady 只活在内存里，不进存档（存档结构一个字段都不加）。
  skillReady: {},        // 技能 id → 可再次释放的逻辑毫秒
  casting: null,         // 选点态：正在选落点的技能 id（meteor / vortex，同一时刻只有一个）
  aim: null,             // 选点预览落点（画布逻辑坐标 768×448）
  stopUntil: 0,          // 时停到期时刻
  overloadUntil: 0,      // 超载到期时刻
  fatigueUntil: 0,       // 疲劳到期时刻（= overloadUntil + fatigueMs）
  overloadScale: 1,      // 本次超载的加成倍数（施放时按 skillEffectScale 写入，上限 2；随对局重置）
  overloadRateMul: 1,    // 连携「共鸣→超载」只放大**攻速**通道：单独一个乘数，绝不并进 overloadScale（那会连伤害一起放大）
  // 技能连携：上一次**真正施放成功（已扣钱）**的技能 id 与时刻。两个字段一起写、一起清（重开归零）。
  // lastSkillAtMs 恒写 state.timeMs —— 与 matchSynergy 的 nowMs 同源；用 Date.now() 会让窗口在暂停 / 倍速下漂移。
  lastSkillId: '', lastSkillAtMs: 0,
  // 赏金 / 共鸣是「花金币买来的一段纯增益」：只记到期时刻与倍率，到点自然失效，不需要清理回调。
  // 它们**不进存档**（存档结构一个字段都没加）：续玩是从该波开头重来，存了等于让刷新白拿一段爆发。
  bountyUntil: 0,        // 赏金加成到期时刻
  bountyMul: 0,          // 本次赏金的**额外**倍率（0.6 = 击杀赏金 +60%）
  resonanceUntil: 0,     // 共鸣到期时刻（光环加成 ×resonanceMul()）
  // 护盾（技能侧的「护盾」）：{ hits, until } = 剩余可吸收次数 + 到期时刻。
  // 它随存档保存（state.shield ⇄ endlessRun.shield），所以字段名与语义由两端共同约定。
  shield: null,
};
const bulletPool = [];   // 子弹对象池：复用对象，避免每发都新建
let nextEnemyId = 1;     // 敌人唯一 id：链式闪电靠它去重「本轮已经电过谁」（pickChainTargets 看 e.id）

/* ===================== 4b. 存档（localStorage，隐私模式必须能苟活） ===================== */
/**
 * 唯一存档键 mlttc-td-progress，结构：
 *   { unlocked: 1, levelBest: { "3": 12 }, endlessBest: 0, endlessRun: null }
 *   unlocked 已解锁到第几关；levelBest 每关最好波数；endlessBest 无尽最高波数；endlessRun 见下。
 * 读取全程 try/catch：隐私模式取不到、JSON 坏了、字段类型不对，一律回落默认值 —— 宁可丢
 * 记录也不能让游戏起不来。写入同理，失败只丢记录不影响本局。
 */
let progress = { unlocked: 1, levelBest: {}, endlessBest: 0, endlessRun: null };

function defaultProgress() { return { unlocked: 1, levelBest: {}, endlessBest: 0, endlessRun: null }; }

/**
 * endlessRun（无尽整局进度）校验：结构不对就整块丢掉 —— 续玩宁可不给，也不能拿半份数据造出
 * 一个歪塔阵。塔位这里只查类型与范围，「越界 / 在路径上 / 重叠」留给 resumeEndlessRun 判。
 *
 * 三个**可选**字段（oc / skillReady / shield）都是纯加法，规则一致：**缺了照常读，坏值只丢那一段**，
 * 绝不因为缺字段就整份返回 null —— 那样会让 2026 年之前的所有老存档一次性失效。
 * 反向兼容也成立：新存档被旧客户端读取时，旧代码只挑它认识的几个字段，
 * oc / shield / skillReady 会被安静丢弃，等于「续玩回来是普通塔、没有护盾、冷却全好」——
 * 这是可接受的降级，因此 TD1- 前缀与版本号都不用动，也不做任何版本协商。
 */
function sanitizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => Math.floor(Number(v)), towers = [];
  const wave = num(raw.wave), gold = num(raw.gold), lives = num(raw.lives), kills = num(raw.kills);
  const savedAt = num(raw.savedAt);
  const seed = typeof raw.seed === 'string' ? raw.seed.slice(0, 64) : '';
  if (!(wave >= 1 && wave <= 100000) || !(gold >= 0) || !(lives >= 1) || !(kills >= 0)) return null;
  if (!(savedAt > 0) || !seed) return null;
  if (Array.isArray(raw.towers)) for (const t of raw.towers) {
    if (!t || typeof t !== 'object' || !ALL_TOWER_TYPES[t.type]) continue;
    const col = num(t.col), row = num(t.row), lvl = num(t.lvl);
    if (!Number.isFinite(col) || !Number.isFinite(row) || !(lvl >= 1 && lvl <= MAX_TOWER_LEVEL)) continue;
    const item = { type: t.type, col, row, lvl };
    // 超频标记：**只在为 true 时写回**。false 与「没有这个键」在玩法上完全等价，
    // 而少写一个 false 能保证老存档 encode → decode 的字面一致（既有断言就按字面比）。
    if (t.oc === true) item.oc = true;
    // 专精（可选字段，规则与上面三个完全一致）：缺省 = 一个都没选；非法 id / 越阶 / **跨塔**的 id
    // 逐档丢弃，**绝不因为缺这个字段就整份返回 null**（那样 2026 年之前的老存档会一次性失效）。
    // 空对象也不写回：老存档 decode → encode 的字面形状因此一个字都不变。
    const spec = {};
    const sp = t.spec;
    if (sp && typeof sp === 'object' && !Array.isArray(sp)) {
      for (let i = 0; i < SPEC_TIERS.length; i += 1) {
        const tier = SPEC_TIERS[i];
        const id = sp[tier];
        if (typeof id !== 'string') continue;
        const hit = specById(id);
        if (hit && hit.tier === tier && hit.type === t.type) spec[tier] = id;
      }
    }
    if (Object.keys(spec).length > 0) item.spec = spec;
    towers.push(item);
  }
  // 技能冷却剩余毫秒（只存 > 0 的项）：0 / 负数 / 非数字 / 未知技能 id 一律丢弃；
  // 未知 id 静默丢弃而不是整份拒绝 —— 技能表将来增删技能时，老存档不该因此作废。
  const skillReady = {};
  const sr = raw.skillReady;
  if (sr && typeof sr === 'object' && !Array.isArray(sr)) {
    for (const k in sr) {
      if (!Object.prototype.hasOwnProperty.call(sr, k) || !getSkill(k)) continue;
      const ms = num(sr[k]);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      skillReady[k] = Math.min(RUN_LEFT_MAX_MS, ms);
    }
  }
  // 护盾剩余 { hits, ms }：两个都 > 0 才保留，并各自夹到 0..SHIELD.maxHits / 0..10 分钟
  let shield = null;
  const sh = raw.shield;
  if (sh && typeof sh === 'object' && !Array.isArray(sh)) {
    const hits = num(sh.hits), ms = num(sh.ms);
    if (Number.isFinite(hits) && Number.isFinite(ms) && hits > 0 && ms > 0) {
      shield = { hits: Math.min(SHIELD.maxHits, hits), ms: Math.min(RUN_LEFT_MAX_MS, ms) };
    }
  }
  const out = { wave, gold, lives, kills, seed, towers, savedAt };
  if (Object.keys(skillReady).length > 0) out.skillReady = skillReady;   // 空表不写：无冷却的存档保持老形状
  if (shield) out.shield = shield;
  return out;
}

/**
 * 存档字段校验。strict=true（存档码解码 / 导入）时任何一个字段非法 → 整份 null：导入不能靠
 * 「猜」，错一个字就整份拒收；strict=false（读 localStorage）时只丢那一个坏字段。未知字段
 * 透传，好让存档码往返保持形状。
 */
function sanitizeProgress(raw, strict) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = defaultProgress(), int = (v) => Math.floor(Number(v)), fail = (strict ? null : undefined);
  if ('unlocked' in raw) { const u = int(raw.unlocked);
    if (Number.isFinite(u) && u >= 1) out.unlocked = Math.min(LEVEL_MAX, u); else if (fail === null) return null; }
  if ('endlessBest' in raw) { const e = int(raw.endlessBest);
    if (Number.isFinite(e) && e >= 0) out.endlessBest = e; else if (fail === null) return null; }
  if ('levelBest' in raw) { const lb = raw.levelBest;
    if (!lb || typeof lb !== 'object' || Array.isArray(lb)) { if (fail === null) return null; }
    else for (const k in lb) { if (!Object.prototype.hasOwnProperty.call(lb, k)) continue;
      const key = int(k), v = int(lb[k]);
      if (key >= 1 && key <= LEVEL_MAX && Number.isFinite(v) && v > 0) out.levelBest[key] = v;
      else if (fail === null) return null; } }
  if ('endlessRun' in raw && raw.endlessRun != null) {
    const run = sanitizeRun(raw.endlessRun);
    if (run) out.endlessRun = run; else if (fail === null) return null;
  }
  for (const k in raw) {   // 未知字段透传：存档码往返因此与编码前一致
    if (Object.prototype.hasOwnProperty.call(raw, k) && !(k in out)) out[k] = raw[k];
  }
  return out;
}

/** 读档：逐字段校验（坏字段只丢那一项，宽模式见 sanitizeProgress） */
function loadProgress() {
  let p = defaultProgress();
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) p = sanitizeProgress(JSON.parse(raw), false) || p;
    // 旧键兼容：第一步只存了「无尽最高波数」的裸数字，这里一次性并入新结构并删掉旧键，
    // 避免同一种进度散在两个键上互相打架。
    const legacyRaw = localStorage.getItem(BEST_KEY);
    if (legacyRaw != null) {
      const legacy = Math.floor(Number(legacyRaw));
      if (Number.isFinite(legacy) && legacy > p.endlessBest) p.endlessBest = legacy;
      localStorage.removeItem(BEST_KEY);
    }
  } catch (err) {
    return defaultProgress();   // 读档失败 = 按新玩家开局，异常绝不外泄到 boot
  }
  return p;
}

function saveProgress() {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch (err) { /* 隐私模式：只丢记录 */ }
}

/* ===================== 4c. 存档码（导出 / 导入，纯函数，Node 下可直接断言） ===================== */
const SAVE_PREFIX = 'TD1-';
/** 字符串 ↔ base64：都过 TextEncoder / Decoder 走 UTF-8 字节，中文昵称、emoji 不会变乱码 */
function utf8ToB64(str) {
  return btoa(Array.from(new TextEncoder().encode(str), (x) => String.fromCharCode(x)).join(''));
}
function b64ToUtf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}
/**
 * 存档 → 存档码：'TD1-' + base64(JSON)。只序列化不清洗 —— 字段合法性归 decodeSave 判，这样
 * 「编码 → 解码」保持传入时的形状（网站以后加的字段也带得出来）。循环引用等怪输入退回默认存档。
 */
function encodeSave(p) {
  let json;
  try { json = JSON.stringify(p && typeof p === 'object' ? p : defaultProgress()); }
  catch (err) { json = JSON.stringify(defaultProgress()); }
  return SAVE_PREFIX + utf8ToB64(json);
}
/**
 * 存档码 → 存档对象 | null。四类坏输入一律 null 且绝不抛异常：前缀不对 / base64 坏或 UTF-8
 * 解不开 / JSON 坏 / 字段非法（sanitizeProgress 严格模式）。
 */
function decodeSave(str) {
  try {
    if (typeof str !== 'string') return null;
    const s = str.trim();
    if (s.indexOf(SAVE_PREFIX) !== 0) return null;
    return sanitizeProgress(JSON.parse(b64ToUtf8(s.slice(SAVE_PREFIX.length))), true);
  } catch (err) { return null; }   // 解码链任何一步失败都收敛成 null，绝不冒到按钮回调
}
/** 存档文本 → 对象：既认 'TD1-…' 存档码，也认 .json 文件正文，两者走同一份字段校验 */
function parseSaveText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  if (s.indexOf(SAVE_PREFIX) === 0) return decodeSave(s);
  try { return sanitizeProgress(JSON.parse(s), true); } catch (err) { return null; }
}

/** 敌人配色与半径（canvas 2D 用不了 CSS 变量，按类型固定） */
const ENEMY_COLORS = { basic: '#8f8f8f', swift: '#4CC9F0', armor: '#E8A33D', shield: '#B693FD', boss: '#D93025' };
const ENEMY_RADIUS = { basic: 8, swift: 7, armor: 10, shield: 11, boss: 15 };

/** 画布调色板：从站点 CSS 变量读，主题切换时重读 */
const palette = {
  bg: '#ffffff', grid: '#ececec', path: '#f2f2f2', edge: '#d9d9d9', text: '#111111',
  muted: '#535353', card: '#ffffff', primary: '#1db954', danger: '#d93025', warning: '#e8900a',
  ok: 'rgba(29,185,84,.18)', bad: 'rgba(217,48,37,.16)',
};

/* ===================== 5. 局内流程 ===================== */
/**
 * 开局 / 重开：清空一切，回到「准备第 1 波」。
 * 闯关模式按关卡配置给生命 / 资金 / 地图；换图时已建的塔与场上敌人一起清空 —— 关卡地图
 * 不同、塔位不通用，作废旧塔是预期行为，不是 bug。
 */
function resetGame() {
  const lv = state.mode === 'level' ? state.level : null;
  state.seed = 'run-' + (Date.now() % 1000000);
  state.wave = 0;
  state.lives = lv ? lv.lives : BALANCE.startLives;
  state.gold = lv ? lv.gold : BALANCE.startGold;
  state.kills = 0; state.waveActive = false; state.nextWaveIn = 1800;
  state.spawnQueue = []; state.spawnIdx = 0; state.spawnTimer = 0; state.waveStats = null;
  // 僵局出口的本局状态：重开归零（startWave 每波会重写 waveStartedAt / lastKillAt）
  state.waveStartedAt = 0; state.lastKillAt = 0;
  state.stallShown = false; state.stallNoticeAt = 0; state.stallPaused = false;
  state.paused = false; state.speed = 1; state.gameOver = false; state.result = ''; state.timeMs = 0;
  state.halted = false;   // 新的一局重新给主循环一次机会（护栏见 frame 的 try/catch）
  // 技能时序跟着本局清零：冷却不进存档（存档结构一个字段都不加），重开就是全新的一局
  state.skillReady = {}; state.casting = null; state.aim = null; state.stopUntil = 0;
  state.overloadUntil = 0; state.fatigueUntil = 0; state.overloadScale = 1; state.overloadRateMul = 1;
  // 连携窗口与本波词缀同属「本局状态」：重开归零（词缀由 startWave 按新 seed 重算）
  state.lastSkillId = ''; state.lastSkillAtMs = 0;
  state.waveAffix = null; state.waveFlags = {};
  state.bountyUntil = 0; state.bountyMul = 0; state.resonanceUntil = 0;   // 赏金 / 共鸣：本局的临时增益，重开清零
  state.shield = null;   // 护盾是「本局」的防御资源：重开清零（续玩时由 resumeEndlessRun 从存档还原）
  state.selectedType = null; state.selectedTower = null;
  state.hover.col = -1; state.hover.row = -1;
  // 实体数组长度清零（旧对象交给 GC：一次性开销，不在循环里发生）
  state.enemies.length = 0; state.towers.length = 0; state.bullets.length = 0;
  state.particles.length = 0; state.floaters.length = 0;
  state.mapIdx = lv ? lv.mapIndex : 0;   // 无尽模式固定第 1 张图
  state.path = buildPath(MAP_TEMPLATES[state.mapIdx]);
  state.pathTiles = buildPathTiles(MAP_TEMPLATES[state.mapIdx]);
  state.best = lv ? (progress.levelBest[lv.level] || 0) : progress.endlessBest;
}

/**
 * 把一波的 groups 展开成出场队列：轮转插入（每组各取 1 只循环），而不是「先出完
 * 步兵再出盾兵」——每波从头到尾都有混合压力，波内难度不突变。元素引用 group，不复制。
 */
function expandSpawnQueue(wave) {
  const pools = wave.groups.map((g) => ({ g, left: g.count }));
  const queue = [];
  let remaining = pools.reduce((s, p) => s + p.left, 0);
  let guard = 0;
  while (remaining > 0 && guard++ < 200000) {
    for (let i = 0; i < pools.length; i++) {
      const p = pools[i];
      if (p.left <= 0) continue;
      p.left -= 1;
      remaining -= 1;
      queue.push(p.g);
      if (remaining <= 0) break;
    }
  }
  return queue;
}

/**
 * 本波是否禁魔（词缀 flags.noSlow）：为真时减速**不施加、也不更新**。
 * 已有减速保持原样（不主动清除）—— 它最多再活 1~2 秒就自然到期，清掉反而多出一条「禁魔波开始
 * 瞬间把减速抹了」的隐性行为；保持原样对玩家更可预期，代码也少一条分支。
 */
function waveNoSlow() {
  return !!(state.waveFlags && state.waveFlags.noSlow);
}

/** 开始第 n 波：无尽模式现算标准波（再叠本波词缀），闯关模式在标准波上乘关卡系数 */
function startWave() {
  state.wave += 1;
  let wave = state.mode === 'level'
    ? buildLevelWave(state.level, state.wave)
    : generateEndlessWave(state.wave, state.seed);
  // 波次词缀（只有无尽模式接）：5 的倍数波按 (wave, seed) 确定性取一条，然后套到本波配置上。
  // ★ applyAffix **返回新对象、入参一个字段都不改** —— 必须用返回值替换 wave，忘了替换就是词缀静默失效
  //   （塔照常打、HUD 照常跳，只是这一波什么修饰都没有，还极难察觉）。
  // ★ 闯关模式不接词缀：每关最多 28 波、有明确结局，词缀会把「可通性」这条已经调平的曲线搅乱。
  if (state.mode === 'level') {
    state.waveAffix = null;
    state.waveFlags = {};
  } else {
    const affix = affixForWave(state.wave, state.seed);
    wave = applyAffix(wave, affix);
    state.waveAffix = affix;                  // UI 用（预告条 / HUD）
    state.waveFlags = wave.flags || {};       // 减速结算处据此判断「本波禁魔」
  }
  // 无尽前 5 波赏金 ×1.3（「略微」加一点，不是把曲线改陡）：只在这里乘，generateEndlessWave 的
  // 签名与 goldMul = 1.05^(n-1) 曲线原封不动；闯关模式走 buildLevelWave 自己的赏金池，不经过这里。
  if (wave.n <= 5 && state.mode !== 'level') {
    for (const g of wave.groups) g.bounty = Math.max(1, Math.round(g.bounty * EARLY_WAVE_MUL));
  }
  state.waveStats = wave;
  state.spawnQueue = expandSpawnQueue(wave);
  state.spawnIdx = 0;
  state.spawnGap = wave.spawnGap;
  state.spawnTimer = 0;
  state.waveActive = true;
  // 僵局计时：每波开头重新起算。lastKillAt 也归到此刻 —— 一波刚开始还没击杀，
  // 不该立刻被算成「20 秒没死过一只」（否则第 20 秒一到就误报僵局）。
  state.waveStartedAt = state.timeMs; state.lastKillAt = state.timeMs;
  state.stallShown = false; state.stallNoticeAt = 0; state.stallPaused = false;
  noteBest(state.wave);
  announceUnlocks(state.wave);   // 这一波若有新技能 / 新特殊塔解锁，就在画布顶部飘一句
  noteEndlessRun();   // 每波开始时落盘：此刻波中还没有敌人，存下来的正是「该波开头」
}

/**
 * 记录最好成绩并立即落盘（每进一波就存，玩家直接关标签页也不丢进度）：
 * 无尽模式记 endlessBest（最高波数），闯关模式记 levelBest[L]（本关最好波数）。
 */
function noteBest(wave) {
  if (state.mode === 'level') {
    const L = state.level.level;
    if (wave <= (progress.levelBest[L] || 0)) return;
    progress.levelBest[L] = wave;
  } else {
    if (wave <= progress.endlessBest) return;
    progress.endlessBest = wave;
  }
  state.best = wave;
  saveProgress();
}

/* ---------- 无尽模式「整局进度」：存档 / 过期 / 清空 ---------- */
/**
 * 保存时机：每波开始时、建塔 / 升级 / 出售后各写一次（写入失败静默，saveProgress 内部已 try）。
 * 存的只是「波的开头」：敌人 / 子弹 / 倒计时一概不存，所以继续时从该波第一只怪重新开始。
 * 结算与主动重开不走这里，走 clearEndlessRun：把已结束的局面留在「继续上次」里就是坑。
 */
const RUN_TTL_MS = 7 * 24 * 3600 * 1000;   // 7 天：太久以前的进度按作废处理（引擎数值可能已变）
function noteEndlessRun() {
  if (state.mode !== 'endless' || !state.inRun || state.gameOver || state.wave < 1) return;
  const run = {
    wave: state.wave, gold: state.gold, lives: state.lives, kills: state.kills, seed: state.seed, savedAt: Date.now(),
    // oc 一律写成布尔（false = 普通塔）：写 false 是为了让存档自解释；解码端只在 true 时回填，
    // 所以老存档里没有这个键也一样正确。
    towers: state.towers.map((t) => {
      const row = { type: t.type, col: t.col, row: t.row, lvl: t.lv, oc: t.oc === true };
      // 专精只写**非空**的（空对象不写）：与 oc 同一约定，没选过专精的塔保持老形状
      if (t.spec && typeof t.spec === 'object' && Object.keys(t.spec).length > 0) row.spec = { ...t.spec };
      return row;
    }),
  };
  // 技能冷却「剩余毫秒」：内存里存的是绝对时刻，落盘前换算回剩余（已就绪的不写）。
  // 为什么冷却可以存：续玩会从该波开头重来，存冷却是为了**防止刷新页面逃冷却**（漏洞方向反过来了）。
  const sr = {};
  for (const id in state.skillReady) {
    if (!Object.prototype.hasOwnProperty.call(state.skillReady, id)) continue;
    const left = Math.floor(Number(state.skillReady[id]) - state.timeMs);
    if (Number.isFinite(left) && left > 0) sr[id] = Math.min(RUN_LEFT_MAX_MS, left);
  }
  if (Object.keys(sr).length > 0) run.skillReady = sr;   // 空表不写：没冷却的存档保持老形状
  // 护盾「剩余次数 + 剩余毫秒」：它是**已经付过钱的防御资源**，波中消耗掉之后不该因为刷新而复原。
  // 反过来，超载 / 赏金加成 / 共振这类「花金币买来的纯增益计时」一律**不存**：续玩是从该波开头
  // 重来，存了等于让玩家刷新页面白拿一段爆发，那是漏洞而不是便利。
  const sh = state.shield;
  if (sh && Number.isFinite(sh.hits) && sh.hits > 0) {
    const ms = Math.floor(Number(sh.until) - state.timeMs);
    if (Number.isFinite(ms) && ms > 0) {
      run.shield = { hits: Math.min(SHIELD.maxHits, sh.hits), ms: Math.min(RUN_LEFT_MAX_MS, ms) };
    }
  }
  progress.endlessRun = run;
  saveProgress();
}
/** 清空可续记录：无尽结算、主动重开时调用（否则「继续」会续到一局已经结束/已放弃的局面） */
function clearEndlessRun() {
  if (!progress.endlessRun) return;
  progress.endlessRun = null;
  saveProgress();
}
/** 可续记录：存在且 savedAt 在 7 天内才算数；过期项不删，只是不认（下一次存档自然覆盖） */
function resumableRun() {
  const run = progress.endlessRun;
  if (!run) return null;
  const age = Date.now() - run.savedAt;
  return (age >= 0 && age <= RUN_TTL_MS) ? run : null;
}

/** 生命归零：存档 + 亮「失败」浮层（闯关模式失败不解锁下一关） */
function gameOver() {
  if (state.gameOver) return;
  state.gameOver = true;
  state.paused = false;
  state.result = 'lose';
  noteBest(state.wave);
  if (state.mode === 'endless') clearEndlessRun();   // 无尽结算：这一局结束了，可续记录作废
  showOverlay();
}

/** 闯关模式打完最后一波：记满波数 + 解锁下一关 + 亮「通关」浮层（无尽模式没有这条路） */
function levelClear() {
  if (state.gameOver) return;
  state.gameOver = true;
  state.paused = false;
  state.result = 'win';
  const L = state.level.level;
  progress.levelBest[L] = Math.max(progress.levelBest[L] || 0, state.level.waves);
  progress.unlocked = Math.max(progress.unlocked, Math.min(LEVEL_MAX, L + 1));
  state.best = progress.levelBest[L];
  saveProgress();
  showOverlay();
}

/* ===================== 6. 敌人 ===================== */
/** 造一只敌人（速度带 ±7% 抖动，避免整波叠成一条完美直线） */
function spawnEnemy(spec) {
  const jitter = 0.93 + Math.random() * 0.14;
  const start = pointAt(state.path, 0);
  state.enemies.push({
    type: spec.type, hp: spec.hp, maxHp: spec.hp, speed: spec.speed * jitter,
    armor: spec.armor, bounty: spec.bounty,
    dist: 0, x: start.x, y: start.y,     // dist = 沿路径像素进度，越大越靠前
    // 力场回推的收敛状态（见 canPush / clampPushDist / pushStrength）：
    maxDistReached: 0,   // 它走过的最远 dist —— 回推的最低位置由它减去 PUSH_BACK_FLOOR_PX 决定
    pushCount: 0,        // 累计被推次数（推回距离按 0.75^n 递减）
    pushImmuneUntil: 0,  // 免疫窗口的到期时刻（逻辑毫秒），窗口内再命中只结算伤害、不再推
    id: nextEnemyId++,                  // 唯一 id：链式闪电用它排除已电过的目标
    slowUntil: 0, slowFactor: 0, hitFlash: 0, dead: false,
    // 技能状态字段（td-skills 的约定）：前三个是剩余毫秒，由 tickStatus 递减；poisonDps 是每秒毒伤
    chillMs: 0, stopMs: 0, poisonMs: 0, poisonDps: 0,
    // 黑洞（vortex）：被拉住的到期时刻 + 圆心。holdUntil 是**绝对逻辑时刻**（= 施放时 state.timeMs + 时长），
    // 过期即自然失效，不需要谁来清理；holdX/holdY 让插值在 hold 期间每帧都能找回圆心。
    holdUntil: 0, holdX: 0, holdY: 0,
  });
}

/** 步进敌人：移动 → 到终点扣血；死亡/漏怪都是 swap-remove 就地删除 */
function updateEnemies(dt) {
  const arr = state.enemies;
  const path = state.path;
  const dtMs = dt * 1000;
  const frozen = state.timeMs < state.stopUntil;   // 时停：整场敌人原地不动，但仍然会被打（塔/子弹照常跑）
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    // 清理阶段：dead / 血量非有限 / hp ≤ 0 一律移除。这是「该死了却没死」的最后一道回收 ——
    // hp 变成 NaN 时 `hp <= 0` 永远为 false，那只敌人会一直赖在场上，而波次收尾要求「场上清空」，
    // 结果就是整波永远结束不了（症状：只剩几只敌人不动、波次卡死）。
    if (isRunawayEnemy(e)) { arr[i] = arr[arr.length - 1]; arr.pop(); continue; }
    // 中毒：先把「本步剩余时间内的那一段」结算掉（无视护甲，见 poisonDamage），再统一递减计时
    if (e.poisonMs > 0) {
      poisonDamage(e, poisonTick(e.poisonMs, e.poisonDps, dtMs));
      if (e.dead) { arr[i] = arr[arr.length - 1]; arr.pop(); continue; }
    }
    tickStatus(e, dtMs);   // chillMs / stopMs / poisonMs 一起递减；slowUntil / stopUntil 是绝对时刻，由主循环比较
    // 黑洞：被拉住的敌人**不推进 dist**，而是把 x,y 朝圆心插值；这里用 held 分支而不是 continue 早退，
    // 是为了让命中闪白（hitFlash）照常衰减 —— 被拉住的敌人同样挨打，闪白不能停在原地。
    const held = !frozen && state.timeMs < e.holdUntil;
    if (held) {
      const dx = e.holdX - e.x, dy = e.holdY - e.y, d = Math.hypot(dx, dy), step = VORTEX_PULL_PX * dt;
      if (d <= step || d < 1) { e.x = e.holdX; e.y = e.holdY; }   // 到圆心就停住（不再抖动）
      else { e.x += (dx / d) * step; e.y += (dy / d) * step; }
    } else if (!frozen) {
      // 减速只有一个乘数（slowFactor 取「最强的那个」，寒流与冰塔谁强谁生效，绝不叠乘）
      const slowed = state.timeMs < e.slowUntil;
      e.dist += (slowed ? e.speed * (1 - e.slowFactor) : e.speed) * dt;
    }
    // 走过的最远点：力场回推的「最低可推回位置」由它决定（见 clampPushDist）。
    // 正因为有它，血量再厚、力场塔再多的怪也保证能持续推进 —— 要么被打死、要么漏过去，波次一定会结束。
    if (e.dist > e.maxDistReached) e.maxDistReached = e.dist;
    if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
    // 被拉住的这一帧既不结算漏怪、也不回写路径坐标：dist 没动，hold 结束后的下一帧
    // 就会由下面的 pointAt(path, dist) 把坐标重新同步回路径上（= 「解除控制后归位」）。
    if (held) continue;
    if (e.dist >= path.length) {
      arr[i] = arr[arr.length - 1];
      arr.pop();
      leak();
      if (state.gameOver) return;
      continue;
    }
    const p = pointAt(path, e.dist);
    e.x = p.x; e.y = p.y;
  }
}

/**
 * 漏怪：扣 1 点生命。
 * 护盾（shield 技能）在这里拦截**唯一的一道生命扣减**：有效期内（未到期且次数未耗尽）只消耗一次
 * 吸收次数、不扣生命 —— 所以「护盾挡住漏怪」不可能有第二条漏网路径。
 */
function leak() {
  const sh = state.shield;
  if (sh && sh.hits > 0 && state.timeMs < sh.until) {
    sh.hits -= 1;
    addFloater(VIEW.w - 46, VIEW.h / 2, '护盾 ' + sh.hits, '#4CC9F0', 1.2);
    addParticles(VIEW.w - 46, VIEW.h / 2, 6, '#4CC9F0');
    if (sh.hits <= 0) state.shield = null;   // 次数耗尽即失效（到期由上面那条时间比较负责）
    return;
  }
  state.lives -= 1;
  addFloater(VIEW.w - 46, VIEW.h / 2, -1, palette.danger);
  if (state.lives <= 0) { state.lives = 0; gameOver(); }
}

/**
 * 「该死了却没死」的兜底判定（纯函数：只看一只敌人的血量与标记）。hp 若变成 NaN / Infinity，
 * `hp <= 0` 永远为 false → 这只怪再也打不死，而收尾要求「场上清空」→ 整波永远结束不了。
 * 判为 true 的敌人在 updateEnemies 的清理阶段一律移除。
 */
export function isRunawayEnemy(e) {
  if (!e || typeof e !== 'object') return false;
  const hp = Number(e.hp);
  return e.dead === true || !Number.isFinite(hp) || hp <= 0;
}

/**
 * 击杀结算（赏金 / 击杀数 / 粒子）：damageEnemy 与无视护甲的真实伤害共用，保证两条伤害路径记同一本账。
 * 赏金加成读的是逻辑时间（state.timeMs）而不是墙钟：暂停 / 切后台 / 等续玩时不会白白烧掉赏金时段。
 */
function killEnemy(enemy) {
  enemy.hp = 0;
  enemy.dead = true;
  // 赏金技能：计时有效期内赏金 ×(1 + bountyMul)。取整用四舍五入、下限 1 —— 低波次小怪的赏金
  // 乘完可能是 1.6，宁可向上凑也不能取整成 0（「开了赏金反而没钱」是最难解释的那种 bug）。
  const reward = state.timeMs < state.bountyUntil ? enemy.bounty * (1 + state.bountyMul) : enemy.bounty;
  state.gold += Math.max(1, Math.round(reward));
  state.kills += 1;
  state.lastKillAt = state.timeMs;   // 僵局判定用：只要还在杀，这一波就不算「清不完」（见 isWaveStalled）
  addParticles(enemy.x, enemy.y, 7, ENEMY_COLORS[enemy.type] || '#999');
}

/** 伤害结算：真实伤害 = dmg × (1 - armor)；击杀给赏金（bounty 已在波次里算好倍率） */
function damageEnemy(enemy, dmg) {
  // 塔多 / 怪少时这里是空值高发点：索敌返回 null、目标已被 swap-remove、被技能标了 dead 都会传进来
  if (!enemy || enemy.dead) return;
  if (!Number.isFinite(enemy.hp)) enemy.hp = 0;   // 非有限血量视为可击杀，否则 NaN <= 0 永远为 false → 打不死
  const real = dmg * (1 - enemy.armor);
  enemy.hp -= real;
  if (!Number.isFinite(enemy.hp)) enemy.hp = 0;   // 伤害本身是 NaN / Infinity 时同样落到 0（见 isRunawayEnemy）
  enemy.hitFlash = 1;
  addFloater(enemy.x, enemy.y - 8, Math.round(real), null);
  if (enemy.hp <= 0) killEnemy(enemy);
}

/**
 * 真实伤害结算（**无视护甲**）：毒塔 dot 与斩杀技能共用这一条路径 —— 两条都绕开 (1 - armor)。
 * 死亡仍然走 killEnemy，所以「毒死的」与「斩死的」与普通击杀记同一本账（赏金 / 击杀数 / 落盘）。
 * 这里不打伤害飘字：毒 dot 每个逻辑步都在跳，逐帧飘字会把画面刷成一片数字，掉血由血条体现。
 */
function trueDamage(enemy, dmg) {
  if (!enemy || enemy.dead || !(dmg > 0)) return;
  if (!Number.isFinite(enemy.hp)) enemy.hp = 0;   // 同 damageEnemy：非有限血量视为可击杀（见 isRunawayEnemy）
  enemy.hp -= dmg;
  if (!Number.isFinite(enemy.hp)) enemy.hp = 0;
  enemy.hitFlash = 1;
  if (enemy.hp <= 0) killEnemy(enemy);
}

/**
 * 毒伤结算：**故意不走 damageEnemy** —— 那里会乘 (1 - armor)，而毒塔的唯一卖点就是「无视护甲」
 * （见 td-special-towers 里 dmg 写 0 / ignoreArmor 的说明：伤害 100% 来自 dot）。
 * 实现就是 trueDamage：名字保留，是为了让调用点与「毒塔的 dot」这个语义一对一，不随通用化漂移。
 */
function poisonDamage(enemy, dmg) {
  trueDamage(enemy, dmg);
}

/* ===================== 7. 塔与战斗 ===================== */
/**
 * 超频加成（就地改传入的 st 并返回它）：在「普通塔数值」之上再乘一组固定系数。
 * 顺序固定 —— 先按等级外推算完普通塔，再叠超频，所以超频塔在高等级下同样是「外推值 × 系数」。
 * upgradeCost **一律不动**（超频不影响升级价）；特斯拉的目标数从 3 提到 5（chain.count 的强化态，
 * 落在 st.chainCount 上，模块里的 def.chain.count 保持原值不动）。
 */
function applyOverclock(d, st) {
  st.dmg *= OC_DMG_MUL;
  st.rate *= OC_RATE_MUL;
  st.range *= OC_RANGE_MUL;
  if (d.auraRate) st.auraRate = Math.min(1, st.auraRate * OC_AURA_MUL);   // 仍受 +100% 上限
  if (d.auraDmg) st.auraDmg = Math.min(1, st.auraDmg * OC_AURA_MUL);
  if (d.slow) st.slow = Math.min(0.8, st.slow + OC_SLOW_ADD);             // 减速上限仍是 80%
  if (d.poison) st.poisonDps *= OC_POISON_MUL;
  if (d.push) st.pushTiles *= OC_PUSH_MUL;
  if (d.chain) st.chainCount = OC_CHAIN_COUNT;
  return st;
}

/**
 * 某座塔某个等级的实际数值（纯函数：只读塔表，不碰 state / DOM）—— 战斗、清单、快速升级共用这一份。
 * 塔表里的 cost / dmg / rate / range / auraRate / auraDmg / splash / slow / slowMs / poison.dps /
 * push.tiles **只存 Lv.1~3**，Lv.4~MAX_TOWER_LEVEL 全部按 k = lv - 3 从 Lv.3 外推，并各自封顶
 * （攻速 ×2 / 溅射 +40 / 减速 80% / 光环 +100% / 推回 +50%），所以高等级不会指数爆炸。
 * oc 是**可缺省**的第三参：省略 / false = 普通塔（既有调用零改动），true = 超频塔（再叠 applyOverclock）。
 * 返回字段（都是有限数值，缺的补 0，调用方不必再判空）：
 *   dmg / rate / range / auraRate / auraDmg / splash / slow / slowMs / poisonDps / pushTiles（单位：格）/
 *   chainCount（特斯拉的链式目标数，非链式塔为 0）/
 *   upgradeCost = **升到下一级**的价格（与既有语义一致：Lv.1→cost[1]、Lv.2→cost[2]、
 *   Lv.3→cost[2]×1.35、Lv.L→cost[2]×1.35^(L-2)；满级 0）。
 */
function towerStat(type, lv, oc) {
  const d = ALL_TOWER_TYPES[type];
  if (!d) return null;
  const L = Math.min(MAX_TOWER_LEVEL, Math.max(1, Math.floor(Number(lv) || 1)));
  const i = Math.min(2, L - 1);            // Lv.1~3：直接读数组（既有数值一个字都不改）
  const k = Math.max(0, L - 3);            // 超出 Lv.3 的级数
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const st = {
    dmg: num(d.dmg ? d.dmg[i] : 0),
    rate: num(d.rate ? d.rate[i] : 0),
    range: num(d.range ? d.range[i] : 0),
    auraRate: num(d.auraRate ? d.auraRate[i] : 0),
    auraDmg: num(d.auraDmg ? d.auraDmg[i] : 0),
    splash: num(d.splash ? d.splash[i] : 0),
    slow: num(d.slow ? d.slow[i] : 0),
    slowMs: num(d.slowMs ? d.slowMs[i] : 0),
    poisonDps: num(d.poison && d.poison.dps ? d.poison.dps[i] : 0),
    pushTiles: num(d.push && d.push.tiles ? d.push.tiles[i] : 0),
    chainCount: d.chain && Number.isFinite(d.chain.count) ? d.chain.count : 0,
    upgradeCost: L >= MAX_TOWER_LEVEL ? 0
      : (L < 3 ? num(d.cost[L]) : Math.round(d.cost[2] * Math.pow(HIGH_LV_COST_STEP, L - 2))),
  };
  if (k > 0) {                             // Lv.1~3 原样返回；Lv.4+ 按 k 外推
    const g = Math.pow(HIGH_LV_DMG_STEP, k);
    st.dmg = st.dmg * g;
    st.poisonDps = st.poisonDps * g;                                        // 毒的 dot 跟着涨
    st.rate = st.rate * (1 + Math.min(1, HIGH_LV_RATE_STEP * k));           // 攻速封顶 = Lv.3 的 2 倍
    st.range = st.range + Math.min(50, HIGH_LV_RANGE_STEP * k);             // 射程最多 +50
    if (d.splash) st.splash = st.splash + Math.min(40, 4 * k);              // 溅射最多 +40
    if (d.slow) st.slow = Math.min(0.8, st.slow + 0.01 * k);                // 减速上限 80%，慢速时长不变
    if (d.auraRate) st.auraRate = Math.min(1, st.auraRate + 0.02 * k);      // 光环增幅各自上限 +100%
    if (d.auraDmg) st.auraDmg = Math.min(1, st.auraDmg + 0.02 * k);
    if (d.push) st.pushTiles = Math.min(st.pushTiles * 1.5, st.pushTiles + 0.05 * k);   // 推回最多 +50%
  }
  return oc === true ? applyOverclock(d, st) : st;
}

/**
 * 「按塔实例取数值」的唯一入口 = towerStat(type, lv, oc) 再叠它已选的专精。
 *
 * 为什么要包一层：专精模块只认 `picks`，拿不到塔类型，所以它做的只是「把已选的修正算进 stat」；
 * 而「这座塔选了哪几档」只有塔实例知道。**所有按塔实例取值的地方都必须走这里** —— 战斗、清单、
 * 数值表、光环、毒 dot、链式目标数、推回距离，漏一处就是「专精只在部分地方生效」。
 * upgradeCost 不受专精影响（模块的 MOD_FIELDS 白名单把升级价排除在外），所以升级价仍可直读 towerStat。
 */
function towerStatSpec(type, lv, oc, spec) {
  const st = towerStat(type, lv, oc);
  return st ? applySpecialization(st, spec) : st;
}

/** 同上，入参直接是塔实例（战斗循环与清单都从塔对象出发） */
function towerStatOf(tower) {
  if (!tower) return null;
  return towerStatSpec(tower.type, tower.lv, tower.oc === true, tower.spec);
}

/**
 * Lv.4+ 的解锁闸：只无尽模式、且 wave >= HIGH_LV_UNLOCK_WAVE。
 * 模式判断不能省 —— 只按波次看的话，将来闯关模式波数一改就漏闸。
 */
function canUpgradeBeyond3() {
  return state.mode === 'endless' && state.wave >= HIGH_LV_UNLOCK_WAVE;
}

/**
 * 建塔：校验金币 / 可建 / 空位，成功后扣钱并记录总投入（出售按它返还）。
 * 特殊塔多一道解锁闸：只无尽模式、且 wave >= unlockWave 才建得起来（塔栏已经灰显，这里再兜一层，
 * 因为调试台 / 键盘也能直接调 placeTower）。
 */
function placeTower(type, col, row) {
  const def = ALL_TOWER_TYPES[type];
  if (!def) return false;
  if (isSpecialTower(type) && (state.mode !== 'endless' || state.wave < towerUnlockWave(type))) return false;
  const cost = def.cost[0];
  // 塔数上限：先拦在这里（不扣钱、不建塔）。铺满整张图的塔阵会让每帧的绘制与索敌一起塌方，
  // 而「塔更多」对高波次并没有边际收益 —— 火力瓶颈在等级与血量曲线，不在座数。
  if (state.towers.length >= MAX_TOWERS) {
    addFloater((col + 0.5) * GRID.tile, (row + 0.5) * GRID.tile, '已达 ' + MAX_TOWERS + ' 座上限', palette.danger, 1.2);
    saveMsg('塔数量已达上限 ' + MAX_TOWERS + ' 座，请先拆除不用的塔', true);
    return false;
  }
  if (state.gold < cost || !isBuildable(state, col, row) || towerAt(state, col, row)) return false;
  state.gold -= cost;
  state.towers.push({
    type, lv: 1, col, row,
    x: (col + 0.5) * GRID.tile, y: (row + 0.5) * GRID.tile,
    cd: 0,        // 冷却剩余秒数
    rateBuff: 0,  // 光环给的攻速增幅
    dmgBuff: 0,   // 光环给的伤害增幅
    spend: cost,  // 历史总投入（升级累加）
    oc: false,    // 超频标记：新建的塔一律是普通态（超频只改内存，不进存档）
  });
  addParticles((col + 0.5) * GRID.tile, (row + 0.5) * GRID.tile, 6, def.color);
  noteEndlessRun();   // 建塔后落盘：关标签页也不会丢刚布好的阵
  return true;
}

/* ---------- 塔专精（td-specialization）：Lv.10 / 25 / 50 各一次二选一 ---------- */
let specDialogOpen = false;   // 同一时刻只允许一个专精对话框（连点 / 批量升级不会叠出两个弹窗）

/**
 * 写入一个专精 pick。**这里是唯一一道归属校验**：applySpecialization 拿不到塔类型，
 * 一旦把冰塔的 id 塞进箭塔，那座塔会拿到一个「存在但无效」的 pick —— 不报错、不生效、静默失效。
 * 所以三道检查缺一不可：id 存在、档位一致、**归属塔一致**（specById(id).type === tower.type）。
 * upgradeCost 不在白名单里，因此专精不影响升级价（想改价只能改 TOWER_TYPES）。
 */
function assignSpecialization(tower, tier, id) {
  if (!tower || !ALL_TOWER_TYPES[tower.type]) return false;
  const hit = specById(id);
  if (!hit || hit.tier !== tier || hit.type !== tower.type) return false;
  if (!tower.spec || typeof tower.spec !== 'object') tower.spec = {};   // 懒建：没选过专精的塔不背一个空对象
  tower.spec[tier] = id;
  tListSig = '';       // 清单签名作废：下一次 syncHud 必然重画这一行（数值 + 专精名一起变）
  noteEndlessRun();    // 专精是永久成长：落盘，刷新不该丢
  return true;
}

/**
 * 弹二选一对话框。动态 import popup —— 只有升到 Lv.10 才用得上，不该进首屏依赖。
 * ★ 按钮索引是**倒序**的（lib/ui/popup.mjs：finish(all.length - i - 1)，且关闭 / Esc 按最后一个按钮计 = 0），
 *   所以 [A, B, 取消] 三个按钮回的是 2 / 1 / 0 —— 按这个映射取 pick，别按直觉写成 0/1/2
 *   （写反了的表现就是「点取消却选中了 A」）。
 */
function openSpecDialog(tower, tier) {
  const opts = specOptions(tower.type, tier);
  if (opts.length < 2) return;
  const a = opts[0], b = opts[1];
  const def = ALL_TOWER_TYPES[tower.type];
  specDialogOpen = true;
  // 与 offerImportedRun 同一写法：async IIFE + try/finally，失败也不把 specDialogOpen 卡在 true
  // （卡住了的话，之后再升到 Lv.25 / Lv.50 就永远问不出来 —— 静默失效）。
  (async () => {
    try {
      const { showConfirm } = await import('/lib/ui/popup.mjs');
      const index = await showConfirm({
        title: (def ? def.name : String(tower.type)) + ' · Lv.' + tier + ' 专精',
        eyebrow: '专精 · Lv.' + tier,
        text: '二选一（只改数值，不改升级价）。取消的话，下次升级会再问一次。',
        buttons: [a.name + '（' + a.desc + '）', b.name + '（' + b.desc + '）', '稍后再选'],
        button_style: ['primary', '', ''],
      });
      const pick = index === 2 ? a.id : (index === 1 ? b.id : '');   // 倒序索引：A=2 / B=1 / 取消=0
      if (!pick) return;                                     // 取消：什么都不写，下次升级重问
      if (!assignSpecialization(tower, tier, pick)) return;   // 归属校验没过（塔已被卖掉 / 类型对不上）：安静放弃
      const hit = specById(pick);
      addFloater(tower.x, tower.y - 18, '专精：' + (hit ? hit.option.name : pick), palette.primary, 2.2);
      syncHud();
    } catch (err) {
      console.warn('[tower-defense] 专精对话框加载失败：', err);
    } finally {
      specDialogOpen = false;
    }
  })();
}

/**
 * 升级后的专精判定：找**第一座**「够到某档、且该档还没选」的塔，为它弹二选一。
 * 「首次 >= tier」用「这一档没有 pick」表达：选过就再也不会被问；取消则在下次升级时重问。
 * 一次只问一档 —— 连升 40 级也不会一口气攒出三个弹窗（下一档留给下一次升级）。
 */
function maybeOfferSpecialization() {
  if (specDialogOpen) return;
  const list = state.towers;
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (!t || !ALL_TOWER_TYPES[t.type]) continue;
    const lv = Math.min(MAX_TOWER_LEVEL, Math.max(1, Math.floor(Number(t.lv) || 1)));
    const picks = t.spec && typeof t.spec === 'object' ? t.spec : null;
    for (let j = 0; j < SPEC_TIERS.length; j += 1) {
      const tier = SPEC_TIERS[j];
      if (lv < tier) break;                                   // 档位递增：后面的更高，不必再看
      if (picks && typeof picks[tier] === 'string') continue;  // 这一档已经选过了
      openSpecDialog(t, tier);
      return;                                                 // 一次只问一档
    }
  }
}

/**
 * 升级：Lv.1 → Lv.MAX_TOWER_LEVEL。Lv.4 起要过解锁闸（无尽 + 第 HIGH_LV_UNLOCK_WAVE 波后），
 * 没解锁时**拒绝升级并给可见提示**（画布飘字 + 存档提示条），不静默失败。
 * 价格一律取 towerStat(type, lv).upgradeCost（= 升到下一级的价格），所以高等级自动按 ×1.35 递增。
 */
function upgradeTower(tower) {
  if (!tower) return false;
  const def = ALL_TOWER_TYPES[tower.type];
  if (!def) return false;
  const lv = Math.max(1, Math.floor(Number(tower.lv) || 1));
  if (lv >= MAX_TOWER_LEVEL) return false;          // 满级：不再可升
  if (lv >= 3 && !canUpgradeBeyond3()) {            // Lv.4+ 未解锁
    addFloater(tower.x, tower.y - 16, '第 ' + HIGH_LV_UNLOCK_WAVE + ' 波后解锁更高等级', palette.danger, 1.2);
    saveMsg('Lv.4 及以上只在无尽模式第 ' + HIGH_LV_UNLOCK_WAVE + ' 波后解锁', true);
    return false;
  }
  const cost = towerStat(tower.type, lv).upgradeCost;
  if (!(cost > 0) || state.gold < cost) return false;
  state.gold -= cost;
  tower.lv = lv + 1;
  tower.spend += cost;
  addParticles(tower.x, tower.y, 8, def.color);
  noteEndlessRun();   // 升级后落盘
  maybeOfferSpecialization();   // 跨过 Lv.10 / 25 / 50 且该档还没选 → 弹二选一（取消则下次升级再问）
  return true;
}

/**
 * 执行一份「批量升级」计划（plan 由 planBatchUpgrade 现算，这里不再挑塔、不再判价格）。
 * 要点：**金币只扣一次**（plan.totalCost 已含全部目标价之和），逐座只做 lv+1 / 累加 spend / 撒粒子，
 * 存档也只落一次 —— 不能循环调 upgradeTower()：那样会逐座扣钱、每座都写一次存档，
 * 而且中途任何一座被拒就会留下半截状态。
 * 返回实际升级的座数（计划为空 / canDo 为 false 时返回 false）。
 */
function applyBatchUpgrade(plan) {
  if (!plan || !plan.canDo || !Array.isArray(plan.targets) || plan.targets.length === 0) return false;
  state.gold -= plan.totalCost;                 // ← 唯一的扣款点
  for (let i = 0; i < plan.targets.length; i += 1) {
    const p = plan.targets[i];
    const tw = p && p.tower;
    if (!tw) continue;
    tw.lv = Math.min(MAX_TOWER_LEVEL, p.nextLv);   // 计划里已排除满级，这里再兜一层上限
    tw.spend = (Number(tw.spend) || 0) + p.cost;
    addParticles(tw.x, tw.y, 4, ALL_TOWER_TYPES[tw.type] ? ALL_TOWER_TYPES[tw.type].color : palette.text);
  }
  noteEndlessRun();                             // ← 唯一的落盘点（一次批量 = 一条存档）
  maybeOfferSpecialization();                   // 批量升过 Lv.10 / 25 / 50 的塔同样要补专精（一次只问一档）
  return plan.targets.length;
}

/** 出售：返还总投入的 60%（向下取整） */
function sellTower(tower) {
  const idx = state.towers.indexOf(tower);
  if (idx < 0) return 0;
  const refund = Math.floor(tower.spend * BALANCE.sellRatio);
  state.gold += refund;
  state.towers.splice(idx, 1);
  if (state.selectedTower === tower) state.selectedTower = null;
  noteEndlessRun();   // 出售后落盘（prog 里的塔阵要跟着少一座）
  return refund;
}

/** 保留两位小数（纯函数，避免浮点尾巴：22 × 1.15 = 25.299999999999997） */
function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/**
 * 场上塔清单的数据化描述（纯函数，不碰 DOM / 不读 state）：信息区列表与自检脚本共用同一份口径，
 * 所以「列表上写的伤害」与「自检断言的值」不可能各算一套。
 *   opts = { gold, sellRatio, highUnlocked } —— gold 决定 canUpgrade；sellRatio 缺省取 BALANCE.sellRatio；
 *   highUnlocked 缺省 false（= Lv.4+ 还没解锁，Lv.3 就停住），调用方传 canUpgradeBeyond3()。
 * 每项字段：index（在 towers 数组里的下标，就是建造顺序）/ type / name / color / lv / maxLv /
 *   dmg / rate（**已计入光环 buff**，保留两位小数）/ range / col / row /
 *   oc（是否超频：true 时 dmg / rate / range / 光环增幅等已经是超频后的值）/
 *   spec（已选专精 picks，形如 {10:'arrow10a'}；没选过是 null）/ specText（specSummary 的单行文案，空串 = 没选）/
 *   upgradeCost（下一级价格，满级 0）/ sellRefund（floor(spend × sellRatio)）/
 *   canUpgrade（未满级、高等级已解锁、金币够）/ maxed（已到 MAX_TOWER_LEVEL）/ locked（Lv.3 但未解锁）。
 * 光环塔自身没有 dmg / rate 字段（它只给别人加成），这里回落成 0，展示层改显增幅。
 * 数据异常（未知塔类型）的项直接跳过，不让一条坏数据毁掉整个列表。
 */
function describeTowers(towers, opts) {
  const list = Array.isArray(towers) ? towers : [];
  const gold = opts && Number.isFinite(opts.gold) ? opts.gold : 0;
  const sellRatio = opts && Number.isFinite(opts.sellRatio) ? opts.sellRatio : BALANCE.sellRatio;
  const highUnlocked = !!(opts && opts.highUnlocked);
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const def = t ? ALL_TOWER_TYPES[t.type] : null;
    if (!def) continue;
    const lv = Math.min(MAX_TOWER_LEVEL, Math.max(1, Math.floor(Number(t.lv) || 1)));   // 夹到 1..上限，越界也不出 NaN
    const oc = t.oc === true;
    const st = towerStatSpec(t.type, lv, oc, t.spec);   // 超频 → 专精：清单显示的已经是这座塔的真实数值
    const maxed = lv >= MAX_TOWER_LEVEL;
    const locked = !maxed && lv >= 3 && !highUnlocked;   // Lv.3 往上要等解锁：按钮灰显 + title 说明
    const upgradeCost = maxed ? 0 : st.upgradeCost;
    rows.push({
      index: i,
      type: t.type,
      name: def.name,
      color: def.color,
      lv,
      maxLv: MAX_TOWER_LEVEL,
      oc,
      spec: t.spec && typeof t.spec === 'object' ? t.spec : null,   // 已选专精（{10:'arrow10a'}）；没选过是 null
      specText: specSummary(t.type, t.spec),                        // 清单那一行的小字；什么都没选时是 ''
      dmg: round2(st.dmg * (1 + (Number(t.dmgBuff) || 0))),
      rate: round2(st.rate * (1 + (Number(t.rateBuff) || 0))),
      range: st.range,
      col: Math.floor(Number(t.col) || 0),
      row: Math.floor(Number(t.row) || 0),
      upgradeCost,
      sellRefund: Math.floor((Number(t.spend) || 0) * sellRatio),
      canUpgrade: !maxed && !locked && gold >= upgradeCost,
      maxed,
      locked,
    });
  }
  return rows;
}

/**
 * 「快速升级」的目标（纯函数：不读 state、不碰 DOM、不读时钟）：按 towers 的数组顺序（= 建造顺序）
 * 取**第一个**未满级的塔 —— 不是最便宜的、也不是等级最低的，就是第一个；没有目标返回 null。
 * 返回 { index, tower, type, name, lv, nextLv, cost, canAfford }。
 * 价格一律取 towerStat(type, lv).upgradeCost = 升到 lv+1 的价格（Lv.4+ 按 ×1.35 递增）。
 * highUnlocked 缺省 false：Lv.4+ 没解锁时把 Lv.3 当到顶，跳过它继续找下一座。
 * 坏数据（null / 未知塔类型 / 等级不在 1..MAX_TOWER_LEVEL）跳过继续找下一座，不抛异常。
 */
function nextUpgradeTarget(towers, gold, highUnlocked) {
  const list = Array.isArray(towers) ? towers : [];
  const g = Number.isFinite(gold) ? gold : 0;
  const unlocked = !!highUnlocked;
  let best = null;
  let bestLv = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const def = t ? ALL_TOWER_TYPES[t.type] : null;
    const lv = def ? Math.floor(Number(t.lv) || 0) : 0;
    if (lv < 1 || lv >= MAX_TOWER_LEVEL) continue;   // 满级 / 等级异常：跳过
    if (lv >= 3 && !unlocked) continue;               // Lv.4+ 未解锁：Lv.3 也算到顶
    const cost = towerStat(t.type, lv).upgradeCost;
    if (!(cost > 0)) continue;
    // 优先升「等级最低」的那座，同级取先建的（严格小于 → 平手时保留更早的下标）。
    // 原来只取「第一个未满级」，结果快速升级一直往同一座塔砸钱：它涨到 Lv.4、5、6…
    // 而其余塔还停在 1 级 —— 按钮等于「只给一座塔升级」，与用户预期不符。
    if (lv < bestLv) {
      bestLv = lv;
      best = { index: i, tower: t, type: t.type, name: def.name, lv, nextLv: lv + 1, cost, canAfford: g >= cost };
    }
  }
  return best;
}

/* 批量升级的座数区间：输入框的 min/max 与纯函数的夹取共用这两个常量（不许两边各写一份） */
const BATCH_UP_MIN = 1;
const BATCH_UP_MAX = 100;

/**
 * 「批量升级」计划（纯函数：不读 state、不碰 DOM、不读时钟）—— **先算计划，再一次性扣款**。
 *
 * 挑选规则与 nextUpgradeTarget 完全一致：挑**等级最低**的塔，同级取数组下标更小的（= 先建的）；
 * 跳过满级、跳过等级异常、跳过 Lv.4+ 未解锁时停在 Lv.3 的塔。
 * 「那么多座塔**各**升一级」→ 同一座塔在一次批量里最多出现一次（挑过的立刻移出候选），
 * 所以顺序就是「等级升序、同级按建造顺序」，而不是按数组原序（建造顺序）平铺。
 * 价格按 towerStat(type, lv).upgradeCost 累加；**金币不够付下一座就停**（部分可执行：能升几座算几座）。
 * count 夹到 1..BATCH_UP_MAX（<1 → 1，>100 → 100，非数字 → 1）；towers 非数组 → 空计划。
 * 返回 { targets: [{ index, tower, type, name, lv, nextLv, cost }], totalCost, canDo }。
 *
 * 为什么必须一次算完：边升边扣的话，中途钱不够会留下「A 升了、B 没升、钱扣了一半」的半截状态，
 * 玩家既看不懂也退不回来；先算成一份完整计划，扣款就只剩一次减法。
 */
function planBatchUpgrade(towers, gold, count, highUnlocked) {
  const list = Array.isArray(towers) ? towers : [];
  const g = Number.isFinite(gold) ? gold : 0;
  const unlocked = !!highUnlocked;
  const want = Math.floor(Number(count));
  const n = Number.isFinite(want) ? Math.min(BATCH_UP_MAX, Math.max(BATCH_UP_MIN, want)) : BATCH_UP_MIN;
  // 候选 = 可升级的塔下标 + 一份等级镜像（挑走的记 Infinity，等于「已用」，只看不改真塔）
  const ids = [];
  const lvs = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    const def = t ? ALL_TOWER_TYPES[t.type] : null;
    const lv = def ? Math.floor(Number(t.lv) || 0) : 0;
    if (lv < 1 || lv >= MAX_TOWER_LEVEL) continue;   // 满级 / 等级异常：跳过
    if (lv >= 3 && !unlocked) continue;              // Lv.4+ 未解锁：Lv.3 也算到顶
    ids.push(i);
    lvs.push(lv);
  }
  const targets = [];
  let totalCost = 0;
  while (targets.length < n) {
    let pick = -1;
    let pickLv = Infinity;
    for (let j = 0; j < ids.length; j += 1) {
      if (lvs[j] < pickLv) { pickLv = lvs[j]; pick = j; }   // 严格小于 → 平手保留更早建造的
    }
    if (pick < 0) break;                                    // 没有可升级的塔了
    const t = list[ids[pick]];
    const cost = towerStat(t.type, pickLv).upgradeCost;
    if (!(cost > 0)) { lvs[pick] = Infinity; continue; }    // 价格异常：移出候选，不占名额
    if (totalCost + cost > g) break;                        // 钱不够付下一座：停（部分可执行）
    targets.push({
      index: ids[pick], tower: t, type: t.type, name: ALL_TOWER_TYPES[t.type].name,
      lv: pickLv, nextLv: pickLv + 1, cost,
    });
    totalCost += cost;
    lvs[pick] = Infinity;                                   // 每座塔一次批量只升一级
  }
  return { targets, totalCost, canDo: targets.length > 0 };
}

/* ---------- 超频（同一座塔的强化态：50% 成功保留等级 / 失败降 5 级） ---------- */
/** 超频价（纯函数）：Lv.1 = 240，每级 ×1.12 —— 高等级塔更贵，但超频保留等级，投在高塔上才划算 */
function overclockCost(lv) {
  const L = Math.min(MAX_TOWER_LEVEL, Math.max(1, Math.floor(Number(lv) || 1)));
  return Math.round(OC_COST_BASE * Math.pow(OC_COST_STEP, L - 1));
}

/** 50% 判定（纯函数）：rand < 0.5 即成功 —— 判定抽成函数才好断言 0.49 / 0.5 这条边界 */
function overclockRoll(rand) {
  const r = Number.isFinite(rand) ? rand : 1;   // 非法随机数一律按失败处理，绝不白送一次强化
  return r < OC_SUCCESS;
}

/** 超频失败后的等级（纯函数）：降 5 级、**最低 1 级** —— applyBatchOverclock 用的就是这一份式子 */
function overclockFailLevel(lv) {
  const L = Math.max(1, Math.floor(Number(lv) || 1));
  return Math.max(1, L - OC_FAIL_DROP);
}

/**
 * 「一键超频」计划（纯函数：不读 state、不碰 DOM、不读时钟）—— 先算计划，再一次性扣款。
 *
 * 挑选规则与「批量升级」相反：挑**等级最高**的塔，同级取数组下标更小的（= 先建的）。
 * 原因很直接 —— 超频保留等级，投在 Lv.20 的塔上得到的是 Lv.20 的强化态，投在 Lv.1 上是
 * Lv.1 的强化态；失败还降 5 级，把低等级塔拿去赌毫无意义。
 * 跳过已超频（oc === true，提示「已超频」）、跳过未知塔类型与等级异常。
 * 价格按 overclockCost(lv) 累加；**金币不够付下一座就停**（部分可执行：能赌几座算几座）。
 * count 夹到 1..OC_COUNT_MAX（<1 → 1，>20 → 20，非数字 → 1）；towers 非数组 → 空计划。
 * 返回 { targets: [{ index, tower, type, name, lv, cost }], totalCost, canDo }。
 */
function planBatchOverclock(towers, gold, count) {
  const list = Array.isArray(towers) ? towers : [];
  const g = Number.isFinite(gold) ? gold : 0;
  const want = Math.floor(Number(count));
  const n = Number.isFinite(want) ? Math.min(OC_COUNT_MAX, Math.max(OC_COUNT_MIN, want)) : OC_COUNT_MIN;
  const ids = [];    // 候选下标
  const lvs = [];    // 与 ids 平行的等级镜像（挑走的记 -1 = 已用，只看不改真塔）
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    const def = t ? ALL_TOWER_TYPES[t.type] : null;
    if (!def || t.oc === true) continue;             // 未知塔 / 已超频：跳过
    const lv = Math.floor(Number(t.lv) || 0);
    if (lv < 1 || lv > MAX_TOWER_LEVEL) continue;     // 等级异常：跳过
    ids.push(i);
    lvs.push(lv);
  }
  const targets = [];
  let totalCost = 0;
  while (targets.length < n) {
    let pick = -1;
    let pickLv = -1;
    for (let j = 0; j < ids.length; j += 1) {
      if (lvs[j] > pickLv) { pickLv = lvs[j]; pick = j; }   // 严格大于 → 平手保留更早建造的
    }
    if (pick < 0) break;                                    // 没有可超频的塔了
    const t = list[ids[pick]];
    const cost = overclockCost(pickLv);
    if (!(cost > 0)) { lvs[pick] = -1; continue; }          // 价格异常：移出候选，不占名额
    if (totalCost + cost > g) break;                        // 钱不够付下一座：停（部分可执行）
    targets.push({
      index: ids[pick], tower: t, type: t.type, name: ALL_TOWER_TYPES[t.type].name, lv: pickLv, cost,
    });
    totalCost += cost;
    lvs[pick] = -1;                                         // 每座塔一次批量只赌一次
  }
  return { targets, totalCost, canDo: targets.length > 0 };
}

/**
 * 「超频结果」弹窗：动态 import 组件库（本模块顶层保持零副作用 —— Node 下 import 本文件不会碰
 * DOM / 组件库），组件库不可用时 showConfirm 自己会退回原生 confirm，这里只再兜一层 catch：
 * 弹窗失败绝不影响已经结算完的金币与等级。
 */
function showOverclockResult(okList, failList) {
  const ok = okList.length, fail = failList.length;
  const parts = ['成功 ' + ok + ' 座 / 失败 ' + fail + ' 座'];
  if (ok > 0) parts.push('已超频（保留等级）：' + okList.map((t) => t.name + ' Lv.' + t.lv).join('、'));
  if (fail > 0) {
    parts.push('超频失败（降 ' + OC_FAIL_DROP + ' 级）：'
      + failList.map((t) => t.name + ' Lv.' + t.from + ' → Lv.' + t.to + '（降 ' + (t.from - t.to) + ' 级）').join('、'));
  }
  import('/lib/ui/popup.mjs')
    .then(({ showConfirm }) => showConfirm({
      title: '超频结果', text: parts.join('｜'), buttons: ['知道了'], button_style: ['primary'],
    }))
    .catch(() => {});
}

/**
 * 执行一份「一键超频」计划（plan 由 planBatchOverclock 现算，这里不再挑塔、不再判价格）。
 * 要点与 applyBatchUpgrade 一致：**金币只扣一次**（plan.totalCost），**存档只落一次**，
 * 中途任何一座都不会因为「钱不够」被留下半截状态；成败各座独立按 50% 判定：
 *   成功 → oc = true，**等级一分不动**；
 *   失败 → lv = max(1, lv - 5)（**降 5 级，最低 1 级**）。
 * 返回统计 { ok, fail, okList }（okList = 成功的那几座 { name, lv }，弹窗与自检共用）。
 */
function applyBatchOverclock(plan) {
  if (!plan || !plan.canDo || !Array.isArray(plan.targets) || plan.targets.length === 0) return false;
  state.gold -= plan.totalCost;                    // ← 唯一的扣款点（成败都一样收钱）
  const okList = [];
  const failList = [];
  for (let i = 0; i < plan.targets.length; i += 1) {
    const p = plan.targets[i];
    const tw = p && p.tower;
    if (!tw) continue;
    const def = ALL_TOWER_TYPES[tw.type];
    if (tw.oc === true) continue;                  // 计划里已排除已超频的塔，这里再兜一层
    if (overclockRoll(Math.random())) {
      tw.oc = true;                                // 成功：只打强化标记，等级保持不变
      okList.push({ name: def ? def.name : tw.type, lv: Math.floor(Number(tw.lv) || 1) });
      addParticles(tw.x, tw.y, 10, OC_COLOR);      // 金色粒子 = 成功的观感
    } else {
      const before = Math.max(1, Math.floor(Number(tw.lv) || 1));
      tw.lv = overclockFailLevel(before);          // 失败：降 5 级，最低 1 级（式子只有一份）
      failList.push({ name: def ? def.name : tw.type, from: before, to: tw.lv });
      addParticles(tw.x, tw.y, 5, palette.danger);
    }
  }
  noteEndlessRun();                                // ← 唯一的落盘点（一次批量 = 一条存档）
  showOverclockResult(okList, failList);
  return { ok: okList.length, fail: failList.length, okList };
}

/**
 * 单座超频：校验（未超频 / 钱够）→ 拼一份只有这一座的计划 → 复用 applyBatchOverclock。
 * 复用而不是另写一遍：扣款只发生在一个地方、存档只写一次、成败与弹窗口径完全一致。
 * 被拒时给可见提示（画布飘字），不静默失败。
 */
function overclockTower(tower) {
  if (!tower) return false;
  const def = ALL_TOWER_TYPES[tower.type];
  if (!def) return false;
  if (tower.oc === true) {   // 已超频：不能叠第二次
    addFloater(tower.x, tower.y - 16, '已超频', palette.warning, 1.0);
    saveMsg('这座塔已经超频过了', true);
    return false;
  }
  const lv = Math.max(1, Math.floor(Number(tower.lv) || 1));
  const cost = overclockCost(lv);
  if (!(cost > 0) || state.gold < cost) {
    addFloater(tower.x, tower.y - 16, '金币不足 ' + cost, palette.danger, 1.0);
    return false;
  }
  return applyBatchOverclock({
    targets: [{ index: state.towers.indexOf(tower), tower, type: tower.type, name: def.name, lv, cost }],
    totalCost: cost,
    canDo: true,
  });
}

/** 索敌：射程内沿路径进度最大（最靠近终点、最危险）的敌人 */
function findTarget(tower, range) {
  const r2 = range * range;
  let best = null;
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i];
    if (e.dead) continue;
    const dx = e.x - tower.x, dy = e.y - tower.y;
    if (dx * dx + dy * dy > r2) continue;
    if (!best || e.dist > best.dist) best = e;
  }
  return best;
}

/**
 * 每逻辑步更新全部塔：
 *  1) buff 先清零，再由每个光环塔给自己范围内的塔「取最高值」——同类光环不叠乘，
 *     所以是 Math.max 比较赋值而不是相加（不同类光环若第二步加入，各自取最高后叠加）。
 *  2) 冷却按 (1 + rateBuff) 加速消耗，到 0 就开火；伤害按 (1 + dmgBuff) 放大。
 *  3) 超载 / 疲劳是与光环**相乘**的独立乘数：(1 + 光环增幅) × 超载系数（乘法可交换，这个顺序
 *     只为读起来像「常驻底数 × 临时系数」）。时间基准是逻辑步累计的 now：暂停时不推进，不白烧。
 */
function updateTowers(dt) {
  const towers = state.towers;
  const now = state.timeMs;
  // 共鸣：把**光环本身的值**先乘倍率，再进下面的「同类取最高」。所以放大的只是每个光环的数值，
  // 合并规则一点没变 —— 两座光环塔依旧取最高而不是相乘（否则两个光环 + 共鸣就是 4 倍）。
  const resonance = now < state.resonanceUntil ? resonanceMul() : 1;
  for (let i = 0; i < towers.length; i++) { towers[i].rateBuff = 0; towers[i].dmgBuff = 0; }
  for (let i = 0; i < towers.length; i++) {
    const a = towers[i];
    if (a.type !== 'aura') continue;
    const astat = towerStatOf(a);   // 超频 + 专精后的实际增幅（仍受 +100% 上限约束）
    const range = astat.range, rate = astat.auraRate * resonance, dmg = astat.auraDmg * resonance;
    const r2 = range * range;
    for (let j = 0; j < towers.length; j++) {
      const t = towers[j];
      if (t === a) continue;
      const dx = t.x - a.x, dy = t.y - a.y;
      if (dx * dx + dy * dy > r2) continue;
      if (rate > t.rateBuff) t.rateBuff = rate;   // 同类光环取最高值，不叠乘
      if (dmg > t.dmgBuff) t.dmgBuff = dmg;
    }
  }
  const overloaded = now < state.overloadUntil;
  const fatigued = !overloaded && now < state.fatigueUntil;   // 疲劳排在爆发之后，两者不重叠
  // 超载的加成会随波次放大（castSkill 时按 skillEffectScale 存进 state.overloadScale，上限 2 倍）；
  // 疲劳是超载的代价，不跟着放大，保持「爆发越强、代价不变」的曲线。
  const ovScale = Number.isFinite(state.overloadScale) ? state.overloadScale : 1;
  // 连携倍率只乘在攻速通道上（超载的伤害增益仍只看 ovScale）：两通道分开，才不会「一个连携把爆发整体翻倍」
  const ovRate = Number.isFinite(state.overloadRateMul) ? state.overloadRateMul : 1;
  const rateMul = overloaded
    ? 1 + OVERLOAD.rateBonus * ovScale * ovRate
    : (fatigued ? 1 + OVERLOAD.fatigueRate : 1);
  const dmgMul = overloaded ? 1 + OVERLOAD.dmgBonus * ovScale : 1;
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    if (t.type === 'aura') continue;               // 光环塔本身不攻击
    t.cd -= dt * (1 + t.rateBuff) * rateMul;
    if (t.cd > 0) continue;
    const st = towerStatOf(t);   // 伤害 / 射程 / 攻速 / 溅射 / 减速全部现算（Lv.4+ 走外推，超频再叠一层，最后叠专精）
    const target = findTarget(t, st.range);
    if (!target) { t.cd = 0; continue; }   // 没目标不打空枪，进射程立刻开火
    t.cd += 1 / st.rate;                   // 累加不清零，倍速下节奏更稳
    const dmg = st.dmg * (1 + t.dmgBuff) * dmgMul;
    // 特殊塔也走同一颗子弹：链式 / 中毒 / 推回的差别在 impact 里按 b.type 分派，子弹池与追身飞行对 7 种塔一致
    if (t.type === 'cannon') spawnBullet(t, target, dmg, st.splash, 0, 0);                // 溅射
    else if (t.type === 'frost') spawnBullet(t, target, dmg, 0, st.slow, st.slowMs);      // 单体+减速
    else spawnBullet(t, target, dmg, 0, 0, 0);                                            // 单体 / 链式 / dot / 推回
  }
}

/** 取一颗子弹：池里有就复用，没有才新建 */
function spawnBullet(tower, target, dmg, splash, slow, slowMs) {
  const b = bulletPool.pop() || {};
  b.x = tower.x; b.y = tower.y; b.tx = target.x; b.ty = target.y; b.target = target;
  b.dmg = dmg; b.splash = splash; b.slow = slow; b.slowMs = slowMs;
  b.speed = splash > 0 ? 320 : 640;
  b.type = tower.type;   // 命中特效按塔种分派（对象池复用，所以每发出一颗都必须重写）
  b.lv = tower.lv;       // 毒的 dot dps 按等级取 towerStat('poison', lv, oc).poisonDps（Lv.4+ 跟着涨、超频再 ×1.6）
  b.oc = tower.oc === true;   // 超频标记随子弹走：命中结算（毒 dot / 推回 / 链式）与发射端同源
  b.spec = tower.spec || null;   // 专精同样随子弹走：命中处要按「这座塔选了什么」现算毒伤 / 跳数 / 推回距离
  b.color = ALL_TOWER_TYPES[tower.type].color;
  state.bullets.push(b);
}

/** 子弹飞行：追目标当前位置，命中即结算并回收进池 */
function updateBullets(dt) {
  const arr = state.bullets;
  for (let i = arr.length - 1; i >= 0; i--) {
    const b = arr[i];
    const t = b.target;
    if (t && !t.dead) { b.tx = t.x; b.ty = t.y; } else b.target = null;  // 目标先死：飞向最后位置
    const dx = b.tx - b.x, dy = b.ty - b.y;
    const dist = Math.hypot(dx, dy);
    const move = b.speed * dt;
    if (dist <= move || dist < 1) {
      b.x = b.tx; b.y = b.ty;
      impact(b);
      arr[i] = arr[arr.length - 1];
      arr.pop();
      bulletPool.push(b);
      continue;
    }
    b.x += (dx / dist) * move;
    b.y += (dy / dist) * move;
  }
}

/* ---------- 力场回推的收敛规则（BUG：力场把血厚的怪永久锁在起点） ---------- */
/**
 * 回推收敛的三条规则。力场塔（force，第 40 波解锁）沿路径把敌人**往回推**；90 波的血厚怪在场
 * 时间长，推回量一旦赶上它单位时间的前进量，敌人就被永久锁在起点附近：既不前进（不漏怪、不扣命）、
 * 也杀不死（击杀不涨、金币不涨），而收尾条件要求「场上清空」→ 波次永不结束（「画面在动、数字全冻」）。
 * 三条必须一起做：① 免疫窗口（多座力场塔不许按帧连推同一只）② 回推下限（最多往回 3 格，
 * 保证它总在推进）③ 推回递减（推得越多推得越轻，否则一堆力场塔只会让敌人原地抖动）。
 */
const PUSH_IMMUNE_MS = 2000;      // 被推回后的免疫窗口（逻辑毫秒）
const PUSH_BACK_FLOOR_PX = 96;    // 回推最多往回 3 格（GRID.tile = 32px）
const PUSH_DECAY = 0.75;          // 每多被推一次，推回距离 ×0.75
const PUSH_MIN_PX = 2;            // 递减下限：再小就只是原地抖动，等于没推

/** 现在这一刻这只敌人还能不能被推回（纯函数）：已死不能推，免疫窗口内也不能推 */
export function canPush(enemy, now) {
  if (!enemy || typeof enemy !== 'object' || enemy.dead === true) return false;
  const t = Number(now);
  return !(Number.isFinite(t) && t < enemy.pushImmuneUntil);
}

/** 回推后的路径进度下限（纯函数）：不低于「走过的最远点 − floorPx」，也不低于 0（起点） */
export function clampPushDist(dist, maxDistReached, floorPx) {
  const d = Number(dist);
  const top = Number(maxDistReached);
  const floor = Number(floorPx);
  const topSafe = Number.isFinite(top) ? Math.max(0, top) : 0;
  const floorSafe = Number.isFinite(floor) && floor >= 0 ? floor : PUSH_BACK_FLOOR_PX;
  return Math.max(Math.max(0, topSafe - floorSafe), Number.isFinite(d) ? d : 0);
}

/** 第 n 次被推回时的实际距离（纯函数）：base × 0.75^n，下限 2px */
export function pushStrength(base, pushCount) {
  const b = Number(base);
  const n = Number(pushCount);
  const baseSafe = Number.isFinite(b) && b > 0 ? b : 0;
  const countSafe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return Math.max(PUSH_MIN_PX, baseSafe * Math.pow(PUSH_DECAY, countSafe));
}

/**
 * 力场推回的像素距离：Lv.1~3 走 td-special-towers 的 pushDistance（口径不变）再按超频 ×1.25，
 * Lv.4+ 用 towerStat 外推的格数（oc 已在 towerStat 里乘过）× 同一条公式（格 × 32 × BOSS 减半）。
 * spec 是开这颗子弹那座塔的专精 picks（专精的 pushTiles 修正只落在 Lv.4+ 那条路上：
 * Lv.1~3 的推回距离来自模块的 pushDistance，不经过 towerStat，这是既有口径，不动它）。
 */
function forcePushPx(lv, isBoss, oc, spec) {
  const over = oc === true;
  if (lv <= 3) return pushDistance('force', lv, isBoss) * (over ? OC_PUSH_MUL : 1);
  const p = ALL_TOWER_TYPES.force.push;
  const half = isBoss && p && p.bossHalf ? 0.5 : 1;
  return towerStatSpec('force', lv, over, spec).pushTiles * GRID.tile * half;
}

/** 命中结算：炮塔按溅射半径命中范围内所有敌人；冰塔附加「最近一次」减速；特殊塔按 b.type 分派 */
function impact(b) {
  if (b.splash > 0) {
    const r2 = b.splash * b.splash;
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i];
      if (e.dead) continue;
      const dx = e.x - b.x, dy = e.y - b.y;
      if (dx * dx + dy * dy > r2) continue;
      damageEnemy(e, b.dmg);
    }
    addParticles(b.x, b.y, 6, b.color);
    return;
  }
  const target = b.target;
  if (!target || target.dead) return;
  if (b.type === 'poison') {
    // 毒塔本体 dmg 恒为 0：命中只挂 / 刷新 dot（覆盖剩余时间、不叠加），伤害在 updateEnemies 里逐帧结算
    const dps = towerStatSpec('poison', b.lv, b.oc === true, b.spec).poisonDps;
    if (dps > 0) { target.poisonMs = ALL_TOWER_TYPES.poison.poison.durationMs; target.poisonDps = dps; }
    addParticles(b.x, b.y, 3, b.color);
    return;
  }
  damageEnemy(target, b.dmg);
  if (b.type === 'tesla') chainShock(b, target);   // 链式闪电：命中后额外跳 3 个目标（超频 5 个）
  if (b.type === 'force' && !target.dead) {
    // 力场：沿路径推回。**推回必须收敛**（三条规则见 canPush / clampPushDist / pushStrength 的注释），
    // 否则血厚的怪会被力场塔反复推回、永久锁在起点：不漏怪、杀不死、波次永不结束。
    // 免疫窗口内的命中只结算伤害、不推回 —— 「伤害照常、只是不推」，力场塔不会因此变成哑炮。
    if (canPush(target, state.timeMs)) {
      const px = pushStrength(forcePushPx(b.lv, target.type === 'boss', b.oc === true, b.spec),
          target.pushCount || 0);
      target.pushCount = (target.pushCount || 0) + 1;
      target.pushImmuneUntil = state.timeMs + PUSH_IMMUNE_MS;
      target.dist = clampPushDist(applyPush(target.dist, px), target.maxDistReached || 0, PUSH_BACK_FLOOR_PX);
      const pt = pointAt(state.path, target.dist);
      target.x = pt.x; target.y = pt.y;
    }
  }
  if (b.slow > 0 && !target.dead) {
    // 禁魔波（词缀 noSlow）：冰塔这一发**不施加也不更新**减速 —— 已有减速保持原样（见 waveNoSlow 的注释）。
    // 伤害照常结算：禁魔只针对「减速」这条控制通道，不是让冰塔变成哑炮。
    // 「最近一次有效」：新的一发直接覆盖当前减速（不叠乘、不取最强）
    if (!waveNoSlow()) {
      target.slowUntil = state.timeMs + b.slowMs;
      target.slowFactor = b.slow;
    }
  }
  addParticles(b.x, b.y, 3, b.color);
}

/**
 * 特斯拉链式闪电：命中后挑 count 个目标（pickChainTargets 按 e.id 排除、按 dist 排序，观感是往终点
 * 方向跳），每跳按 chainDamage 衰减（34 → 27 → 22 → 17，跳数从 2 起算 = 主目标吃满伤）。
 * 链上的伤害走 damageEnemy：与普通攻击同一套护甲减免，不另开无视护甲的路。
 * count / 射程都取 towerStat（超频塔：目标数 3 → 5、射程 ×1.15），模块里的 def.chain.count 不动。
 */
function chainShock(b, first) {
  const def = ALL_TOWER_TYPES.tesla;
  // 跳数取 towerStat 的 chainCount（**非链式塔为 0**，绝不补 1：补了会让「+1」变成「1 个目标」，
  // 表现为特斯拉只电一个目标 —— 见 spec 模块那句「chainCount 必须由 towerStat 原样提供」）。
  const st = towerStatSpec('tesla', b.lv, b.oc === true, b.spec);
  const alive = state.enemies.filter((e) => !e.dead);
  const hops = pickChainTargets(alive, { x: b.x, y: b.y }, st.chainCount, st.range, [first.id]);
  for (let i = 0; i < hops.length; i++) {
    if (hops[i].dead) continue;
    damageEnemy(hops[i], chainDamage(b.dmg, i + 2, def.chain.falloff));
    addParticles(hops[i].x, hops[i].y, 3, def.color);
  }
}

/* ===================== 8. 特效（飘字 / 粒子） ===================== */
/**
 * 降载判定（同屏拥挤时跳过粒子与伤害飘字）。粒子 + 飘字是最贵的两条绘制通道，数量随命中次数线性涨，
 * 而高波次恰好「敌人多 + 塔多 + 命中频繁」同时成立。**只影响观感，不影响伤害与赏金** ——
 * 赏金在 killEnemy 结算、伤害在 damageEnemy 结算，与这两条特效通道无关。
 */
function perfSkipFx() {
  return state.enemies.length > FX_CROWD_ENEMIES || state.towers.length > FX_CROWD_TOWERS;
}

/**
 * 飘字：reduce 动效时改为静态显示（不上飘、不淡出），信息不丢。
 * lifeSec 可省略（默认 0.7s）—— 技能 / 解锁提示要停留久一点才读得完，所以开了这个口子。
 */
function addFloater(x, y, value, color, lifeSec) {
  if (perfSkipFx()) return;   // 降载：同屏过挤时不生成飘字（只影响观感，见 perfSkipFx）
  if (state.floaters.length > 60) state.floaters.shift();
  const life = Number.isFinite(lifeSec) && lifeSec > 0 ? lifeSec : 0.7;
  state.floaters.push({
    x, y, text: String(value),
    color: color || (value > 0 ? palette.text : palette.danger),
    life, max: life,
  });
}

/** 命中粒子：reduce 动效时干脆不生成（不画＝最彻底的「关掉位移」）；同屏过挤时同样跳过（见 perfSkipFx） */
function addParticles(x, y, count, color) {
  if (state.reducedMotion || perfSkipFx()) return;
  for (let i = 0; i < count; i++) {
    if (state.particles.length > 220) break;
    const ang = Math.random() * Math.PI * 2;
    const spd = 40 + Math.random() * 90;
    state.particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      life: 0.32 + Math.random() * 0.2, max: 0.52, color,
    });
  }
}

/** 步进飘字与粒子（同样反向 swap-remove） */
function updateFx(dt) {
  const f = state.floaters;
  for (let i = f.length - 1; i >= 0; i--) {
    const o = f[i];
    o.life -= dt;
    if (!state.reducedMotion) o.y -= 26 * dt;   // 减少动效时不动位置
    if (o.life <= 0) { f[i] = f[f.length - 1]; f.pop(); }
  }
  const p = state.particles;
  for (let i = p.length - 1; i >= 0; i--) {
    const o = p[i];
    o.life -= dt;
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.vx *= 0.94; o.vy *= 0.94;
    if (o.life <= 0) { p[i] = p[p.length - 1]; p.pop(); }
  }
}

/* ===================== 8b. 主动技能（只在无尽模式） ===================== */
// 时间基准：state.timeMs（逻辑步累计）。暂停 / 隐藏 / 等续玩时 step() 不跑 → 冷却、时停、超载、
// 疲劳一起冻结；倍速只让 timeMs 走得快。冷却表 skillReady 只活在内存里，不进存档。
/**
 * 技能随波次强化：解锁之后每多一波，花费 +4%、效果 +5%（两条斜率都基于「超出解锁波次的波数」）。
 * 花费与效果分开算，是因为它们要各自封顶：钱没有上限（涨钱本来就是压力来源），但效果必须有，
 * 否则高波次一个陨石就能把整波清空、时停能冻到天荒地老。
 * td-skills.js 一个字都不改：两个纯函数算的是「主文件这一层的当前口径」，模块仍是基础值。
 */
const SKILL_COST_STEP = 0.04;     // 每超出一波，花费 +4%
const SKILL_EFFECT_STEP = 0.05;   // 每超出一波，效果 +5%
const SKILL_EFFECT_CAP = 2;       // 时停时长 / 超载加成最多 2 倍
const SKILL_CHILL_CAP = 0.8;      // 寒流减速上限 80%（与冰塔、Lv.4+ 外推同一条上限）

/** 超出解锁波次多少波（未解锁 / 非法输入一律 0 = 不放大） */
function skillWaveGap(skill, wave) {
  const unlock = skill && Number.isFinite(skill.unlockWave) ? skill.unlockWave : 0;
  const w = Number.isFinite(wave) ? wave : 0;
  return Math.max(0, w - unlock);
}

/**
 * 技能当前花费（纯函数）= round(基础价 × (1 + 4% × 超出波数))。
 * canCast 与施放扣款、按钮文案全都走这一份，所以「按钮上写的价」与「真实扣的钱」不可能不一致。
 */
function effectiveSkillCost(skill, wave) {
  if (!skill) return 0;
  const base = Number.isFinite(skill.cost) ? skill.cost : 0;
  return Math.round(base * (1 + SKILL_COST_STEP * skillWaveGap(skill, wave)));
}

/** 技能当前效果倍率（纯函数）= 1 + 5% × 超出波数；各技能再各自封顶（见 castSkill / confirmMeteor） */
function skillEffectScale(skill, wave) {
  return 1 + SKILL_EFFECT_STEP * skillWaveGap(skill, wave);
}

/**
 * 技能当前状态：解锁 / 冷却 / 金币三条判定。
 * 金币这一条**不能交给模块的 canCast**：它比的是基础价 skill.cost，而实际扣的是涨过价的
 * effectiveSkillCost。所以这里传一个不可能不足的金币让它只判「解锁 + 冷却」，金币在主文件判 ——
 * td-skills.js 因此保持原样（它的 90 条离线断言一个都不受影响）。
 */
function skillState(id) {
  const skill = getSkill(id);
  const now = state.timeMs;
  const readyAt = Number.isFinite(state.skillReady[id]) ? state.skillReady[id] : 0;   // 没放过 = 0
  const cost = effectiveSkillCost(skill, state.wave);      // 当前花费（随波次涨）
  const scale = skillEffectScale(skill, state.wave);       // 当前效果倍率（随波次涨）
  const left = cooldownLeft(skill, readyAt, now);
  const chk = canCast(skill, { wave: state.wave, gold: Number.MAX_SAFE_INTEGER, readyAt, now });
  const afford = state.gold >= cost;
  const ok = chk.ok && afford && state.mode === 'endless';
  const reason = chk.ok ? (afford ? undefined : 'gold') : chk.reason;
  return { skill, ok, reason, left, now, cost, scale };
}

/** 扣金币 + 写冷却（只在效果真正生效后调：失败路径一分钱都不动）；price 是当前花费 */
function payForSkill(skill, price) {
  const c = Number.isFinite(price) ? price : effectiveSkillCost(skill, state.wave);
  state.gold -= c; state.skillReady[skill.id] = state.timeMs + skill.cooldownMs; syncHud();
}
/** 取消选点态（Esc / 右键 / 点到画布外）：还没扣钱，什么都不用回滚 */
function cancelCasting() {
  if (state.casting) { state.casting = null; syncHud(); }
}

/* ---------- 技能连携（td-synergy）接线：判定 → 生效 → 最后才写回 ---------- */
/**
 * 连携命中判定：**必须用旧的 lastSkill\***（写回之前调用）。时刻直接读 state.timeMs ——
 * 与 skillState() 里的 now 同一个来源，所以「判定用的时钟」只有一套。
 * 单独成函数是为了让「先判、再生效、最后覆盖」这个顺序在代码上一眼可见，不必靠注释约束。
 */
function synergyHitFor(id) {
  return matchSynergy(state.lastSkillId, state.lastSkillAtMs, id, state.timeMs);
}

/**
 * 施放**成功（已扣钱）后**的写回：两个字段一起写。时刻只认 state.timeMs ——
 * 用 Date.now() 会引入第二套时钟：暂停 / 后台 / 倍速下，4 秒窗口会跟游戏内时间对不上。
 */
function noteSkillCast(id) {
  state.lastSkillId = id;
  state.lastSkillAtMs = state.timeMs;
}

/** 连携命中的飘字（未命中时 synergyLabel 返回空串，直接跳过，不产生任何 DOM / 画布开销） */
function announceSynergy(hit) {
  const text = synergyLabel(hit);
  if (text) addFloater(VIEW.w / 2, VIEW.h - 30, text, palette.warning, 2.4);
}

/* ---------- 回收：先算计划（纯函数）再执行 ---------- */
/**
 * 「回收」的选塔计划（纯函数：只读 towers，不碰 state / 金币 / DOM）。
 * 规则：**等级最低**的 count 座优先，同级取下标更小者（= 先建的先卖）；
 * 返还额 = salvageRefund(tower.spend, SALVAGE.refundRatio) —— refundRatio 当前是 1，即**全额返还**。
 * 注意它和出售不是一回事：sellTower 走 BALANCE.sellRatio（60%），回收是另一条语义，不能复用那个函数。
 * 返回 { targets: [{ index, tower, type, name, lv, refund }], totalRefund }：
 * 塔不足 count 时返回全部，空场返回空计划（totalRefund = 0）；排序只作用于下标镜像，不改任何塔字段。
 */
function planSalvage(towers, count) {
  const list = Array.isArray(towers) ? towers : [];
  const want = Number.isFinite(count) ? count : SALVAGE.towers;
  const n = Math.min(list.length, Math.max(0, Math.floor(want)));
  const rows = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (!t) continue;
    const def = ALL_TOWER_TYPES[t.type];
    rows.push({ index: i, tower: t, type: t.type, name: def ? def.name : String(t.type), lv: Math.floor(Number(t.lv) || 1) });
  }
  rows.sort((a, b) => (a.lv - b.lv) || (a.index - b.index));   // 等级最低优先；同级先建者
  const targets = [];
  let totalRefund = 0;
  for (let i = 0; i < rows.length && i < n; i += 1) {
    const r = rows[i];
    const spend = Number.isFinite(r.tower.spend) ? r.tower.spend : 0;
    const refund = salvageRefund(spend, SALVAGE.refundRatio);
    targets.push({ index: r.index, tower: r.tower, type: r.type, name: r.name, lv: r.lv, refund });
    totalRefund += refund;
  }
  return { targets, totalRefund };
}

/**
 * 执行一份回收计划（plan 由 planSalvage 现算，这里不再挑塔、不再算钱）：逐座移除 → 金币一次到账 → 清选中。
 * 落盘不在这里做：castSkill 会在**扣完技能费之后**落一次盘（顺序反了，刷新页面就能白拿返还、白逃冷却）。
 * 返回实际移除的座数（空计划返回 0）。
 */
function applySalvage(plan) {
  if (!plan || !Array.isArray(plan.targets) || plan.targets.length === 0) return 0;
  let removed = 0;
  for (const row of plan.targets) {
    const i = state.towers.indexOf(row.tower);
    if (i < 0) continue;                  // 计划是现算的，塔仍可能已被别的路径挪走：下标失效就跳过
    state.towers.splice(i, 1);
    if (state.selectedTower === row.tower) state.selectedTower = null;
    addParticles(row.tower.x, row.tower.y, 5, palette.warning);
    removed += 1;
  }
  state.gold += plan.totalRefund;         // 回收 = 全额返还：唯一的入账点
  clearTowerSelect();                     // 被卖掉的塔可能正是选中的那座：清画布圈 + 清单高亮
  syncHud();
  return removed;
}

const VORTEX_PULL_PX = 180;   // 黑洞把敌人拉向圆心的速度（px/s）：半径 90px 约 0.5s 到圆心，1.5s 的 hold 够聚拢

/**
 * 12 个技能的施放实现表：id → 函数。每项**只负责效果**；扣钱 / 写冷却 / 解锁 / 金币判定一律由 castSkill
 * 统一处理（所以「按钮上写的价」与「真实扣的钱」不可能再分叉）。返回值约定：
 *   true  —— 效果已生效，castSkill 随后 payForSkill 扣钱进冷却；
 *   'aim' —— 进入 / 退出选点态，此刻一分钱都不扣（落点确认时才由 confirmMeteor / confirmVortex 收钱）；
 *   其他  —— 什么都不做（不扣钱、不进冷却）。
 * 为什么是一张表而不是一长串 if/else：漏接一个技能的后果是「按钮亮着、点了没反应、也不报错」——
 * 这正是「新增 6 个技能只有前 6 个能用」的成因。表化之后 tools/td-wave-test 第 19 节拿
 * SKILLS.map(s => s.id) 逐位比对，缺一个就 FAIL。**新增技能必须同时登记到这里。**
 */
const SKILL_CASTERS = {
  // 寒流：只有比当前生效的更强才覆盖（模块内的取更强逻辑），所以寒流与冰塔不叠乘；
  // 减速随波次放大，但封顶 80%（与冰塔 / Lv.4+ 外推同一条上限，再高就等于让敌人站住不动）
  chill: (st) => {
    // 禁魔波（词缀 flags.noSlow）：减速这条通道整波失效。与其收钱后什么都不发生，不如**不施放**
    // —— 返回 false 走「什么都不做」分支：一分钱不扣、不进冷却，并明确告诉玩家为什么。
    if (waveNoSlow()) {
      addFloater(VIEW.w / 2, 44, '本波禁魔：寒流无效', palette.danger, 1.6);
      return false;
    }
    const slow = Math.min(SKILL_CHILL_CAP, CHILL.slow * st.scale);
    const n = applyChillTo(state.enemies, st.now, slow, CHILL.durationMs);
    addFloater(VIEW.w / 2, 44, '寒流 ' + Math.round(slow * 100) + '% ×' + n, '#4CC9F0', 1.4);
    return true;
  },
  meteor: () => enterAim('meteor'),
  // 赏金：只写两个计时字段，击杀处（killEnemy）现读现乘；到点自然失效，没有清理回调
  bounty: (st) => {
    state.bountyUntil = st.now + BOUNTY.durationMs;
    state.bountyMul = bountyMultiplier(st.scale);
    addFloater(VIEW.w / 2, 44, '赏金 +' + Math.round(state.bountyMul * 100) + '% '
      + Math.round(BOUNTY.durationMs / 1000) + 's', palette.warning, 1.6);
    return true;
  },
  repair: (st) => {
    const before = state.lives;
    // 修复量随波次放大（向上取整：17.6 → 18 条，宁可多给一点也别让放大看起来没生效）；
    // 生命上限仍是 BALANCE.startLives，靠技能刷不出无限生命
    state.lives = Math.min(BALANCE.startLives, state.lives + Math.ceil(REPAIR.lives * st.scale));
    addFloater(VIEW.w - 46, VIEW.h / 2 - 18, '+' + (state.lives - before), palette.primary, 1.4);
    return true;
  },
  vortex: () => enterAim('vortex'),
  // 时停：时长随波次放大，上限 2 倍（否则后期一次时停能白嫖半波）
  timestop: (st) => {
    state.stopUntil = st.now + TIMESTOP.durationMs * Math.min(SKILL_EFFECT_CAP, st.scale);
    return true;
  },
  // 护盾：次数随波次放大（shieldHits 已夹到 1..maxHits），到期时刻用逻辑时间 —— 暂停 / 后台都不流逝
  shield: (st) => {
    state.shield = { hits: shieldHits(st.scale), until: st.now + SHIELD.durationMs };
    addFloater(VIEW.w - 46, VIEW.h / 2 - 18, '护盾 ' + state.shield.hits + ' 次', '#4CC9F0', 1.6);
    return true;
  },
  // 超载：加成倍数存进 state，由 updateTowers 现乘（那里持有 OVERLOAD 的基础值），上限 2 倍
  overload: (st, hit) => {
    state.overloadScale = Math.min(SKILL_EFFECT_CAP, st.scale);
    // 连携「共鸣→超载」：只把**攻速**乘一次（单独的字段，绝不并进 overloadScale，那会连伤害一起放大）
    state.overloadRateMul = synergyMultiplier('rate', hit);
    state.overloadUntil = st.now + OVERLOAD.durationMs;
    state.fatigueUntil = state.overloadUntil + OVERLOAD.fatigueMs;   // 爆发结束才轮到疲劳，两段不重叠
    addFloater(VIEW.w / 2, 44, '超载 ×' + round2(state.overloadScale) + ' ' + OVERLOAD.durationMs / 1000 + 's', palette.warning, 1.6);
    return true;
  },
  // 斩杀：血线 <25% 的目标吃「最大生命 50%」的**真实伤害**（走 trueDamage，与毒塔同一路径、无视护甲）；
  // 死亡仍由 killEnemy 记账，所以该给的赏金 / 击杀数一分不少
  execute: (st, hit) => {
    const dmgMul = synergyMultiplier('dmg', hit);   // 连携通道：斩杀伤害 ×(1+value)，未命中恒为 1，可无条件相乘
    const hits = executeTargets(state.enemies);
    let n = 0;
    for (const e of hits) {
      if (e.dead) continue;                       // 同一帧里先后被别的伤害打死：跳过，别再结算一次
      const dmg = executeDamage(e) * dmgMul;
      if (dmg > 0) { trueDamage(e, dmg); n += 1; }
    }
    addFloater(VIEW.w / 2, 44, '斩杀 ×' + n, palette.danger, 1.6);
    return true;
  },
  // 共鸣：只写到期时刻，倍率由 updateTowers 现取（resonanceMul 留成函数是为以后做强化不动调用方）
  resonance: (st) => {
    state.resonanceUntil = st.now + RESONANCE.durationMs;
    addFloater(VIEW.w / 2, 44, '共鸣 光环 ×' + resonanceMul() + ' '
      + Math.round(RESONANCE.durationMs / 1000) + 's', palette.primary, 1.6);
    return true;
  },
  // 净化本来就是清场：效果不放大，只有价格跟着波次涨
  purge: () => { purgeEnemies(); return true; },
  // 回收：先算计划（纯函数）再执行；场上没有塔时什么都不做，一分钱都不扣（与「批量升级」无可升级即禁用同一口径）
  salvage: () => {
    const plan = planSalvage(state.towers, SALVAGE.towers);
    const n = applySalvage(plan);
    if (n === 0) return false;
    addFloater(VIEW.w / 2, 44, '回收 ×' + n + ' 返还 ' + plan.totalRefund, palette.warning, 1.6);
    return true;
  },
};

/**
 * 进入 / 退出选点态（陨石与黑洞**共用这一处**）：同一时刻只允许一个选点态 ——
 * 再点同一个技能 = 取消；点另一个技能 = 直接切过去（技能 id 与 aim 一起换，准星半径按 id 现取）。
 * 状态只有 state.casting + state.aim 两个字段，所以「两种技能不会互相干扰」是结构上的，不靠时序。
 */
function enterAim(id) {
  state.casting = state.casting === id ? null : id;
  if (state.casting && !state.aim) state.aim = { x: VIEW.w / 2, y: VIEW.h / 2 };
  syncHud();
  return 'aim';
}

/**
 * 施放技能：唯一入口。判定（模式 / 结算 / 解锁 / 冷却 / 金币）在这里，效果在 SKILL_CASTERS 里，
 * 扣钱 + 写冷却统一走 payForSkill。陨石与黑洞是两段式：先'aim'（不扣钱），落点确认时才扣钱进冷却。
 */
function castSkill(id) {
  if (state.mode !== 'endless' || state.gameOver || !state.inRun) return false;
  const st = skillState(id);
  if (!st.ok) return false;
  const cast = SKILL_CASTERS[id];
  if (typeof cast !== 'function') return false;   // 表里没登记（自检第 19 节会拦住）：什么都不做
  // 连携判定必须在这里、用**旧的** lastSkill* —— 任何「施放失败」的分支都还没走到下面的写回，
  // 所以冷却中 / 钱不够 / 未解锁这三种情况天然不会污染连携窗口（它们在上面就 return false 了）。
  const hit = synergyHitFor(id);
  const r = cast(st, hit);
  if (r === 'aim') return true;                    // 选点态：一分钱都还没扣，lastSkill* 也不写（落点确认时才写）
  if (r !== true) return false;
  payForSkill(st.skill, st.cost);   // 扣的是当前花费（涨过价的那个数），不是模块里的基础价
  // 连携返还通道：基数一律是**本次技能费**（不是回收金额、不是击杀赏金），未命中返回 0
  const refund = synergyRefund('refund', hit, st.cost);
  if (refund > 0) { state.gold += refund; syncHud(); }
  announceSynergy(hit);
  noteSkillCast(id);        // ★ 只在真的放出去（已扣钱）之后写：先判 → 再生效 → 最后写回
  // 回收改动的是塔阵，必须**扣完钱再落盘**：若在效果里先落盘，刷新页面就能白拿返还、白逃冷却
  if (id === 'salvage') noteEndlessRun();
  return true;
}

/** 陨石落点：meteorHits 取命中 → 逐一走**既有 damageEnemy**（因此受护甲减免）→ 最后才扣钱进冷却 */
function confirmMeteor(x, y) {
  const st = skillState('meteor');
  state.casting = null;
  if (!st.ok) { syncHud(); return false; }   // 选点期间金币被花光 / 技能已过期：什么都不做
  // 两段式技能（陨石 / 黑洞）的「施放成功」发生在**落点确认**（此刻才扣钱），所以连携判定与写回都放在这里，
  // 而且顺序仍是「先判（旧 lastSkill*）→ 应用加成 → 最后写回」。
  const hit = synergyHitFor('meteor');
  const dmgMul = synergyMultiplier('dmg', hit);   // 连携「黑洞→陨石」：陨石伤害 ×1.5
  const hits = meteorHits(state.enemies, x, y, METEOR.radius);   // 半径不变，只有伤害随波次放大
  const dmg = METEOR.damage * st.scale * dmgMul;
  for (let i = 0; i < hits.length; i++) if (!hits[i].dead) damageEnemy(hits[i], dmg);
  addParticles(x, y, 10, '#F0643C');
  addFloater(x, y - 18, '陨石 ×' + hits.length, '#F0643C', 1.4);
  payForSkill(st.skill, st.cost);
  announceSynergy(hit);
  noteSkillCast('meteor');
  return true;
}

/**
 * 黑洞落点：vortexTargets 取半径内的敌人 → 逐个挂 holdUntil（绝对逻辑时刻）+ 圆心，
 * 位移插值由 updateEnemies 每帧做（它才是唯一动坐标的地方）。半径内没有敌人也照常扣钱进冷却，
 * 与陨石「落空也进冷却」保持一致。
 */
function confirmVortex(x, y) {
  const st = skillState('vortex');
  state.casting = null;
  if (!st.ok) { syncHud(); return false; }   // 选点期间金币被花光 / 技能已过期：什么都不做
  // 黑洞没有自己的伤害通道，但它常是连携的**前半段**（黑洞→陨石），所以照样判定 + 写回
  const hit = synergyHitFor('vortex');
  const hits = vortexTargets(state.enemies, x, y, VORTEX.radius);
  const until = st.now + VORTEX.durationMs;
  let n = 0;
  for (const e of hits) {
    if (e.dead) continue;
    e.holdUntil = until; e.holdX = x; e.holdY = y;
    n += 1;
  }
  addParticles(x, y, 10, '#6C4CF0');
  addFloater(x, y - 18, '黑洞 ×' + n, '#6C4CF0', 1.4);
  payForSkill(st.skill, st.cost);
  announceSynergy(hit);
  noteSkillCast('vortex');   // 写回只用 state.timeMs（noteSkillCast 内部），不碰 Date.now()
  return true;
}
/**
 * 净化：非 BOSS 敌人直接标记 dead —— **不经过 damageEnemy**，所以不给赏金、不计击杀数（清场是
 * 止损不是收割：靠它刷钱 / 刷击杀会让 45 波之后的经济与最高波数曲线失真）。标记后由 updateEnemies
 * 的 swap-remove 删除，与其它死亡走同一条删除路径。
 */
function purgeEnemies() {
  const hits = purgeHits(state.enemies);
  let n = 0;
  for (const e of hits) if (!e.dead) { e.dead = true; addParticles(e.x, e.y, 4, '#B693FD'); n += 1; }
  addFloater(VIEW.w / 2, 44, '净化 ×' + n, '#B693FD', 1.6);
  return n;
}
/** 解锁提示：只在 unlockWave === wave 时命中一次（不刷屏），多条错开 y，停留 2.6s 便于读 */
function announceUnlocks(wave) {
  const lines = SKILLS.filter((s) => s.unlockWave === wave).map((s) => '解锁技能：' + s.name);
  for (const id of specialTowersUnlockedAt(wave)) if (towerUnlockWave(id) === wave) lines.push('解锁：' + ALL_TOWER_TYPES[id].name);
  lines.forEach((text, i) => addFloater(VIEW.w / 2, 56 + i * 20, text, palette.primary, 2.6));
}

/* ===================== 9. 逻辑步 & 波次推进 ===================== */
/** 波次推进：出场 → 打完 → 倒计时下一波 */
function updateWaves(dt) {
  if (!state.waveActive) {
    state.nextWaveIn -= dt * 1000;
    if (state.nextWaveIn <= 0) startWave();
    return;
  }
  // 出场：每 spawnGap 毫秒一只；while 兜住低帧率时的补偿
  if (state.spawnIdx < state.spawnQueue.length) {
    state.spawnTimer -= dt * 1000;
    while (state.spawnTimer <= 0 && state.spawnIdx < state.spawnQueue.length) {
      spawnEnemy(state.spawnQueue[state.spawnIdx]);
      state.spawnIdx += 1;
      state.spawnTimer += state.spawnGap;
    }
  }
  // 收尾：队列放空且场上清干净 → 闯关模式打完最后一波即通关；无尽模式进入喘息时间
  if (state.spawnIdx >= state.spawnQueue.length && state.enemies.length === 0) {
    state.waveActive = false;
    if (state.mode === 'level' && state.wave >= state.level.waves) { levelClear(); return; }
    state.nextWaveIn = BALANCE.waveGapMs;
    return;   // 这一波已经收尾：不必再判僵局
  }
  checkWaveStall();   // 还在打，却已经清不动 → 无尽模式的僵局出口（见 isWaveStalled）
}

/**
 * 僵局出口：本波「打不完」时弹一次结算浮层。**只接无尽模式**（闯关每关最多 28 波、血量曲线已按
 * 「可通」调平；无尽没有终点，卡在同一波就等于整局冻结）。防打扰：stallShown 一旦置真，
 * 同一波只在「距上次提醒 ≥ STALL_REMIND_MS（60 秒）」时才再弹；换波时两个字段一起归零。
 */
function checkWaveStall() {
  if (state.mode !== 'endless' || !state.waveActive || state.gameOver) return;
  const info = {
    waveMs: state.timeMs - state.waveStartedAt,
    sinceKillMs: state.timeMs - state.lastKillAt,
    aliveCount: state.enemies.length,
    total: state.waveStats ? state.waveStats.total : 0,
  };
  if (!isWaveStalled(info)) return;
  if (state.stallShown && state.timeMs - state.stallNoticeAt < STALL_REMIND_MS) return;
  state.stallShown = true;
  state.stallNoticeAt = state.timeMs;
  showStallOverlay();
}

/** 一个固定逻辑步：时间 → 波次 → 敌人 → 塔 → 子弹 → 特效 */
function step(dt) {
  state.timeMs += dt * 1000;
  updateWaves(dt);
  updateEnemies(dt);
  if (state.gameOver) return;
  updateTowers(dt);
  updateBullets(dt);
  updateFx(dt);
}

/* ===================== 10. 渲染 ===================== */
const draw = { ctx: null, canvas: null };

/** 从站点 CSS 变量读调色板（主题切换后重读，画布跟着变深浅） */
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => ((cs.getPropertyValue(name) || '').trim() || fallback);
  palette.bg = pick('--bg-page', '#ffffff');
  palette.grid = pick('--border-light', '#ececec');
  palette.path = pick('--bg-hover', '#f2f2f2');
  palette.edge = pick('--border', '#d9d9d9');
  palette.text = pick('--text-primary', '#111111');
  palette.muted = pick('--text-secondary', '#535353');
  palette.card = pick('--bg-card', '#ffffff');
  palette.primary = pick('--primary', '#1db954');
  palette.danger = pick('--danger', '#d93025');
  palette.warning = pick('--warning', '#e8900a');
}

/** 整帧重绘（网格只有 24×14，全量重绘开销可忽略） */
function render() {
  const ctx = draw.ctx;
  if (!ctx) return;
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  drawGrid(ctx); drawPath(ctx);
  drawFieldFx(ctx);   // 时停罩：压在路径之上、实体之下，不挡血条也不挡塔
  drawHover(ctx); drawTowers(ctx);
  drawEnemies(ctx); drawBullets(ctx); drawFx(ctx); drawPrompts(ctx);
  drawAim(ctx);       // 陨石选点准星：最上层，指针在哪都能看见
  drawHaltBanner(ctx);   // 逻辑停摆提示：压在一切之上（停摆时其它图层已经不再变化）
}

/** 时停罩：一层淡蓝 + 顶部倒计时。敌人只是不移动，照样挨打，所以用半透明而不是把画面挡住 */
function drawFieldFx(ctx) {
  if (state.timeMs >= state.stopUntil) return;
  ctx.globalAlpha = 0.16; ctx.fillStyle = '#4CC9F0';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#1f7f9c';
  ctx.font = '700 15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('停滞 ' + ((state.stopUntil - state.timeMs) / 1000).toFixed(1) + 's', VIEW.w / 2, 24);
}

/**
 * 选点预览：十字准星 + 落点半径圆圈（跟指针走；点了才扣钱，Esc / 右键取消）。
 * 半径与配色按 state.casting 现取 —— 陨石（红 · METEOR.radius）与黑洞（紫 · VORTEX.radius）共用同一套绘制。
 */
function drawAim(ctx) {
  const id = state.casting, a = id && state.aim;
  if (!a) return;
  const vortex = id === 'vortex';
  const radius = vortex ? VORTEX.radius : METEOR.radius;
  const color = vortex ? '#6C4CF0' : '#F0643C';
  ctx.fillStyle = vortex ? 'rgba(108,76,240,.12)' : 'rgba(240,100,60,.10)';
  ctx.beginPath(); ctx.arc(a.x, a.y, radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.arc(a.x, a.y, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();   // 十字：横 10px、竖 10px
  ctx.moveTo(a.x - 10, a.y); ctx.lineTo(a.x + 10, a.y);
  ctx.moveTo(a.x, a.y - 10); ctx.lineTo(a.x, a.y + 10);
  ctx.stroke();
}

function drawGrid(ctx) {
  ctx.strokeStyle = palette.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (let c = 1; c < GRID.cols; c++) { const x = c * GRID.tile + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, VIEW.h); }
  for (let r = 1; r < GRID.rows; r++) { const y = r * GRID.tile + 0.5; ctx.moveTo(0, y); ctx.lineTo(VIEW.w, y); }
  ctx.stroke();
}

/** 路径带：1 格宽的折线描边（与 buildPathTiles 的格子判定同源） */
function drawPath(ctx) {
  const pts = state.path.pts;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  };
  ctx.strokeStyle = palette.path; ctx.lineWidth = GRID.tile; ctx.lineJoin = 'round';
  trace();
  ctx.strokeStyle = palette.edge; ctx.lineWidth = 1; ctx.setLineDash([6, 8]);   // 中线虚线
  trace();
  ctx.setLineDash([]);
  const end = pts[pts.length - 1];      // 终点：红色标记
  ctx.fillStyle = palette.danger;
  ctx.beginPath(); ctx.arc(end.x - 8, end.y, 7, 0, Math.PI * 2); ctx.fill();
}

/** 悬停格高亮 + 待建塔射程预览 */
function drawHover(ctx) {
  const type = state.selectedType;
  const col = state.hover.col, row = state.hover.row;
  if (!type || col < 0) return;
  const ok = isBuildable(state, col, row) && !towerAt(state, col, row);
  const x = col * GRID.tile, y = row * GRID.tile;
  ctx.fillStyle = ok ? palette.ok : palette.bad;
  ctx.fillRect(x, y, GRID.tile, GRID.tile);
  ctx.strokeStyle = ok ? palette.primary : palette.danger; ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, GRID.tile - 2, GRID.tile - 2);
  if (!ok) return;
  ctx.strokeStyle = ALL_TOWER_TYPES[type].color; ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.arc(x + GRID.tile / 2, y + GRID.tile / 2, ALL_TOWER_TYPES[type].range[0], 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;
}

/** 塔：底盘 + 图标 + 等级点；选中时画射程圈；超频塔多一圈金色脉冲环 + 右上角金色角标 */
function drawTowers(ctx) {
  const towers = state.towers;
  // 塔多时的降载（与粒子/飘字共用同一套判定，见 perfSkipFx）：超频金环不再逐帧呼吸，
  // 改画一圈静态金环 —— 仍然一眼认得出超频塔，但省掉 40+ 座塔每帧的 sin + 整圆描边。
  // 射程圈只在「选中的那一座」上画（同一时刻最多 1 个，不会随塔数批量画），是操作反馈，不参与降载。
  const light = perfSkipFx();
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    const def = ALL_TOWER_TYPES[t.type];
    const on = state.selectedTower === t;
    const oc = t.oc === true;
    if (on) {   // 选中：射程圈（超频塔画的是放大后的射程；专精改射程时圈也跟着变，否则手感和数值会脱节）
      ctx.strokeStyle = def.color; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.arc(t.x, t.y, towerStatOf(t).range, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (oc && light) {
      // 降载态：静态金环（不呼吸、不算 sin，也不逐帧改 globalAlpha）
      ctx.strokeStyle = OC_COLOR; ctx.lineWidth = 2; ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.arc(t.x, t.y, 16.5, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (oc) {
      // 金色脉冲环：半径与不透明度都随 state.timeMs 呼吸（2.6s 一圈），一眼就能从一片塔里认出来。
      // 用 state.timeMs（逻辑步累计）而不是 Date.now()，暂停时环也跟着停，与其它动效同一口径。
      const pulse = 0.5 + 0.5 * Math.sin(state.timeMs / 260);
      ctx.strokeStyle = OC_COLOR; ctx.lineWidth = 2;
      ctx.globalAlpha = 0.45 + 0.45 * pulse;
      ctx.beginPath(); ctx.arc(t.x, t.y, 15.5 + pulse * 2.5, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = palette.card;
    ctx.beginPath(); ctx.arc(t.x, t.y, 13, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = def.color; ctx.lineWidth = on ? 3.5 : 2.5; ctx.stroke();
    drawTowerGlyph(ctx, t, def.color);
    if (oc) {   // 右上角金色角标：一个小三角（塔身外的强化标记，与清单里的「超频」徽章同一件事）
      ctx.fillStyle = OC_COLOR;
      ctx.beginPath();
      ctx.moveTo(t.x + 8, t.y - 10); ctx.lineTo(t.x + 15, t.y - 10); ctx.lineTo(t.x + 11.5, t.y - 3);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = def.color;   // 等级：Lv.1~3 画塔底小圆点；Lv.4+ 画不下一百个点，直接写等级数字
    if (t.lv <= 3) {
      for (let k = 0; k < t.lv; k++) { ctx.beginPath(); ctx.arc(t.x + 9 - k * 6, t.y + 11, 2, 0, Math.PI * 2); ctx.fill(); }
    } else {
      ctx.font = '700 9px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Lv' + t.lv, t.x, t.y + 18);
    }
  }
}

/** 塔的图标（纯几何，不依赖任何图片资源） */
function drawTowerGlyph(ctx, tower, color) {
  const x = tower.x, y = tower.y;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  if (tower.type === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(x, y - 7); ctx.lineTo(x + 5, y + 5); ctx.lineTo(x, y + 2); ctx.lineTo(x - 5, y + 5);
    ctx.closePath(); ctx.fill();
  } else if (tower.type === 'cannon') {
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(x - 1.5, y - 9, 3, 6);
  } else if (tower.type === 'frost') {
    for (let i = 0; i < 3; i++) {
      const a = (Math.PI / 3) * i;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * 7, y - Math.sin(a) * 7);
      ctx.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7);
      ctx.stroke();
    }
  } else if (tower.type === 'tesla') {   // 特斯拉：一道闪电折线
    ctx.beginPath();
    ctx.moveTo(x - 6, y - 7); ctx.lineTo(x + 1, y - 1); ctx.lineTo(x - 3, y + 1); ctx.lineTo(x + 6, y + 7);
    ctx.stroke();
  } else if (tower.type === 'poison') {  // 毒：实心核 + 半透明外环
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (tower.type === 'force') {   // 力场：两道推进箭头
    for (let i = 0; i < 2; i++) {
      const ox = i * 6 - 3;
      ctx.beginPath(); ctx.moveTo(x - 6 + ox, y - 6); ctx.lineTo(x + ox, y); ctx.lineTo(x - 6 + ox, y + 6);
      ctx.stroke();
    }
  } else {   // aura：双环
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/** 敌人：身体 + 血条（减速时描一圈冷色） */
function drawEnemies(ctx) {
  const arr = state.enemies;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (e.dead) continue;
    const r = ENEMY_RADIUS[e.type] || 8;
    ctx.fillStyle = e.hitFlash > 0.35 ? '#ffffff' : (ENEMY_COLORS[e.type] || '#8f8f8f');
    ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
    if (state.timeMs < e.slowUntil) { ctx.strokeStyle = '#4CC9F0'; ctx.lineWidth = 2; ctx.stroke(); }
    const ratio = e.maxHp > 0 ? Math.max(0, e.hp / e.maxHp) : 0;
    const w = r * 2.6, bx = e.x - w / 2, by = e.y - r - 9;
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(bx, by, w, 4);
    ctx.fillStyle = ratio > 0.5 ? palette.primary : ratio > 0.25 ? palette.warning : palette.danger;
    ctx.fillRect(bx, by, w * ratio, 4);
  }
}

function drawBullets(ctx) {
  const arr = state.bullets;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.splash > 0 ? 5 : 3, 0, Math.PI * 2); ctx.fill();
  }
}

function drawFx(ctx) {
  const p = state.particles;
  for (let i = 0; i < p.length; i++) {
    const o = p[i];
    ctx.globalAlpha = Math.max(0, o.life / o.max);
    ctx.fillStyle = o.color;
    ctx.fillRect(o.x - 1.5, o.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  const f = state.floaters;
  ctx.font = '600 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < f.length; i++) {
    const o = f[i];
    ctx.globalAlpha = state.reducedMotion ? 0.9 : Math.max(0, o.life / o.max);
    ctx.fillStyle = o.color;
    ctx.fillText(o.text, o.x, o.y);
  }
  ctx.globalAlpha = 1;
}

/** 状态提示：波间倒计时 / 暂停文字 */
function drawPrompts(ctx) {
  ctx.textAlign = 'center';
  if (state.gameOver) return;
  if (state.awaitingResume) {   // 有可续进度：等玩家选「继续 / 重新开始」，画面先停在这里
    ctx.fillStyle = palette.text;
    ctx.font = '700 17px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('上次的无尽进度还在：继续 或 重新开始', VIEW.w / 2, VIEW.h / 2);
    return;
  }
  if (state.paused || state.hidden) {
    ctx.fillStyle = palette.text;
    ctx.font = '700 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('已暂停', VIEW.w / 2, VIEW.h / 2);
    return;
  }
  if (!state.waveActive) {
    const secs = Math.max(0, state.nextWaveIn / 1000).toFixed(1);
    const label = state.wave === 0 ? '准备开战 ' : '第 ' + (state.wave + 1) + ' 波 · ';
    ctx.fillStyle = palette.muted;
    ctx.font = '600 15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(label + secs + 's', VIEW.w / 2, VIEW.h / 2);
  }
}

/* ===================== 11. 输入（鼠标 + 触摸统一走 pointer） ===================== */
/** 指针 → 格子：用 rect 反算逻辑坐标，CSS 缩放与 DPR 都不影响命中 */
function eventToCell(ev) {
  const rect = draw.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((ev.clientX - rect.left) / rect.width) * VIEW.w;
  const y = ((ev.clientY - rect.top) / rect.height) * VIEW.h;
  const col = Math.floor(x / GRID.tile), row = Math.floor(y / GRID.tile);
  if (col < 0 || row < 0 || col >= GRID.cols || row >= GRID.rows) return null;
  return { col, row };
}

/** 指针 → 画布逻辑坐标（不取整、不夹到格内）：陨石落点用这个，允许落在路径上、塔身上、画布边缘 */
function eventToPoint(ev) {
  const rect = draw.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((ev.clientX - rect.left) / rect.width) * VIEW.w;
  const y = ((ev.clientY - rect.top) / rect.height) * VIEW.h;
  if (x < 0 || y < 0 || x > VIEW.w || y > VIEW.h) return null;
  return { x, y };
}

/**
 * pointerdown 统一处理鼠标 / 触摸 / 触控笔：选点态 → 这次点击就是「确认落点」（陨石）；
 * 点到已有塔 → 选中它（画布画射程圈 + 清单高亮那一行）；点空地 → 放了塔种类就建塔，
 * 否则清掉选中态。点到路径 / 画布外同样清选中——「点空白处取消选中」对整块画布都成立。
 */
function onPointerDown(ev) {
  if (ev.cancelable) ev.preventDefault();
  if (state.casting) {   // 选点态优先：画布上的一次点击 = 落点确认（点画布外 = 取消）
    const pt = eventToPoint(ev);
    if (!pt) cancelCasting();
    else if (state.casting === 'vortex') confirmVortex(pt.x, pt.y);   // 谁在选点态，落点就交给谁
    else confirmMeteor(pt.x, pt.y);
    return;
  }
  const cell = eventToCell(ev);
  if (!cell) { clearTowerSelect(); return; }   // 画布外的落点也算「点了非塔位置」
  state.hover.col = cell.col;
  state.hover.row = cell.row;
  if (state.gameOver) return;
  const existing = towerAt(state, cell.col, cell.row);
  if (existing) { selectTower(existing); return; }
  clearTowerSelect();                          // 点到的不是塔：选中态先清（路径格也算）
  if (state.selectedType && placeTower(state.selectedType, cell.col, cell.row)) {
    // 金币不够下一座就自动取消选中，省一次点击
    if (state.gold < ALL_TOWER_TYPES[state.selectedType].cost[0]) state.selectedType = null;
    syncTowerButtons();
  }
}

/** 悬停高亮只跟鼠标走（触摸不跟踪，避免手指抬起后留个假高亮）；选点态下触摸也要跟，否则看不见准星 */
function onPointerMove(ev) {
  if (state.casting) { const pt = eventToPoint(ev); if (pt) state.aim = pt; }
  if (ev.pointerType && ev.pointerType !== 'mouse') return;
  const cell = eventToCell(ev);
  if (!cell) { state.hover.col = -1; state.hover.row = -1; return; }
  state.hover.col = cell.col;
  state.hover.row = cell.row;
}

/* ===================== 12. 场上塔清单 / HUD / 结算浮层 ===================== */
const ui = {};   // DOM 引用集中在 boot() 里一次性取好
let tListSig = '';   // 清单上次渲染的签名（每行数据 + 金币 + 选中行），没变就不写 DOM
let tListCount = -1; // summary 上「场上塔（N）」的 N；只在这一格变时才写文本

/**
 * 选中一座塔：画布上画它的射程圈，清单里高亮它那一行。点画布上的塔、点清单里的行
 * 走的是同一个函数 —— 两边只是同一份 state.selectedTower 的两个视图，不存在第二套选中态。
 */
function selectTower(tower) {
  state.selectedTower = tower || null;
  state.selectedType = null;    // 选中已有塔就取消「准备建塔」，避免下一次点击顺手又放一座
  syncTowerButtons();
  renderTowerList();
}

/**
 * 清选中态（画布选中圈 + 清单行高亮一起消失）：作废签名，下一次 syncHud 必然重画。
 * 注意它**不隐藏清单**——清单展示的是「场上所有塔」，与有没有选中无关；隐藏只由 syncView 管。
 */
function clearTowerSelect() {
  state.selectedTower = null;
  tListSig = '';
}

/**
 * 清单签名：把「每一行会显示的东西」压成一个字符串——行数据（等级 / 伤害 / 攻速 / 射程 / 坐标 /
 * 升级价 / 返还额 / 能否升级）+ 金币 + 当前选中行。签名不变就一个字符都不写 DOM，
 * 所以 syncHud 每帧调用也只是一次字符串拼接（塔只有几座）。
 */
function towerListSignature(rows, activeIdx) {
  let s = state.gold + '#' + activeIdx;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    s += '|' + r.index + ',' + r.lv + ',' + r.dmg + ',' + r.rate + ',' + r.range + ','
      + r.col + ',' + r.row + ',' + r.upgradeCost + ',' + r.sellRefund + ',' + r.canUpgrade + ',' + r.maxed + r.locked
      + ',' + r.oc   // 超频标记也要进签名：否则超频成功后这一行不会重画（徽章与数值都停在旧样子）
      + ',' + r.specText;   // 专精同理：选完之后这一行的数值与专精名都要跟着变
  }
  return s;
}

/** 一行塔的 HTML：名称（塔色）+ 超频徽章 + 等级 + 伤害/攻速/射程 + 位置 + 升级/删除两个按钮 */
function towerRowHtml(r, active) {
  const oc = r.oc === true;
  const st = towerStatSpec(r.type, r.lv, oc, r.spec);   // 与战斗同源：光环增幅 / 毒伤 / 射程都现算（超频再叠一层，最后叠专精）
  // 光环塔自身不攻击：显示它给别人的增幅（与塔数值表一致；describeTowers 里它的伤害/攻速是 0）
  // 毒塔 dmg 恒为 0，唯一输出是无视护甲的 dot，直接写每秒毒伤比「伤害 0.00」有用
  const stats = r.type === 'aura'
    ? ['攻速增幅 +' + Math.round(st.auraRate * 100) + '%', '伤害增幅 +' + Math.round(st.auraDmg * 100) + '%']
    : r.type === 'poison'
      ? ['毒伤 ' + round2(st.poisonDps) + '/s（无视护甲）', '攻速 ' + r.rate.toFixed(2) + '/s']
      : ['伤害 ' + r.dmg.toFixed(2), '攻速 ' + r.rate.toFixed(2) + '/s'];
  stats.push('射程 ' + Math.round(r.range));
  const upText = r.maxed ? '已满级' : (r.locked ? '未解锁' : '升级（' + r.upgradeCost + '）');
  const upTitle = r.maxed ? '已满级（Lv.' + MAX_TOWER_LEVEL + '）'
    : r.locked
      ? '第 ' + HIGH_LV_UNLOCK_WAVE + ' 波后解锁 Lv.4 及以上（升到 Lv.' + (r.lv + 1) + ' 需 ' + r.upgradeCost + ' 金币）'
      : (r.canUpgrade ? '花 ' + r.upgradeCost + ' 金币升到 Lv.' + (r.lv + 1)
        : '金币不足：还差 ' + (r.upgradeCost - state.gold));
  // 行内「超频」：单座赌一次（50% 成功保留等级 / 失败降 5 级），已超频的塔不能再赌
  const ocCost = overclockCost(r.lv);
  const ocText = oc ? '已超频' : '超频 ' + ocCost;
  const ocTitle = oc
    ? '这座塔已经超频过了（同一座塔只能超频一次）'
    : (state.gold >= ocCost
      ? '花 ' + ocCost + ' 金币赌一次：50% 成功（保留 Lv.' + r.lv + '，伤害 ×1.6 攻速 ×1.25 射程 ×1.15），失败降 ' + OC_FAIL_DROP + ' 级'
      : '金币不足：还差 ' + (ocCost - state.gold));
  return '<div class="td-ti-row' + (active ? ' is-active' : '') + (oc ? ' is-oc' : '') + '" data-tower-index="' + r.index + '"'
    + ' title="点击选中这座塔">'
    + '<span class="td-ti-name" style="color:' + r.color + '">' + r.name + '</span>'
    + (oc ? '<span class="td-ti-oc" title="已超频：伤害 ×1.6、攻速 ×1.25、射程 ×1.15（特殊塔另有加成）">超频</span>' : '')
    + '<span class="td-ti-lv">Lv.' + r.lv + '/' + r.maxLv + '</span>'
    // 已选专精：一个都没选时 r.specText 是空串，整段不出现（不留一个空壳）
    + (r.specText
      ? '<span class="td-ti-spec" title="专精：Lv.10 / 25 / 50 各一次二选一，只改数值不改升级价">' + r.specText + '</span>'
      : '')
    + '<span class="td-ti-stats">' + stats.map((p) => '<span>' + p + '</span>').join('') + '</span>'
    + '<span class="td-ti-pos">(' + r.col + ', ' + r.row + ')</span>'
    + '<span class="td-ti-acts">'
    + '<button type="button" data-act="upgrade" data-tower-index="' + r.index + '"'
    + (r.canUpgrade ? '' : ' disabled') + ' title="' + upTitle + '">' + upText + '</button>'
    + '<button type="button" data-act="oc" data-tower-index="' + r.index + '"'
    + (oc || state.gold < ocCost ? ' disabled' : '') + ' title="' + ocTitle + '">' + ocText + '</button>'
    + '<button type="button" data-act="sell" data-tower-index="' + r.index + '"'
    + ' title="删除这座塔，返还 ' + r.sellRefund + ' 金币">删除（返还 ' + r.sellRefund + '）</button>'
    + '</span></div>';
}

/**
 * 重画整张清单：场上每一座塔一行，按 state.towers 的数组顺序（= 建造顺序），永不重排。
 *  · summary 的数量每次都跟着变（「场上塔（3）」），折叠时也照常更新；
 *  · 折叠状态下**跳过主体重绘**：只作废签名就返回，重新展开时（toggle）整表重画一次；
 *  · 空场显示一行灰字「场上还没有塔」，不留一个空盒子；
 *  · 选中行加 is-active（点画布 → 这里亮；点这里 → 画布亮）；
 *  · 内容整体替换，但事件不跟着重绑：监听器只在 bindEvents 里挂一次（见 onTowerListClick）。
 */
function renderTowerList() {
  const box = ui.towerList;
  if (!box) return;
  const rows = describeTowers(state.towers, {
    gold: state.gold, sellRatio: BALANCE.sellRatio, highUnlocked: canUpgradeBeyond3(),
  });
  // 标题上的数量：折叠时也实时更新（用户不看主体也知道场上有几座）
  if (ui.towerSummary && tListCount !== rows.length) {
    tListCount = rows.length;
    ui.towerSummary.textContent = '场上塔（' + rows.length + '）';
  }
  if (ui.tInfo && ui.tInfo.open === false) { tListSig = ''; return; }   // 折叠：主体一个字符都不写
  const active = state.selectedTower ? state.towers.indexOf(state.selectedTower) : -1;
  const sig = towerListSignature(rows, active);
  if (sig === tListSig) return;      // 没变：一个字符都不写
  tListSig = sig;
  if (rows.length === 0) { box.innerHTML = '<div class="td-ti-empty">场上还没有塔</div>'; return; }
  let html = '';
  for (let i = 0; i < rows.length; i++) html += towerRowHtml(rows[i], active === rows[i].index);
  box.innerHTML = html;
}

/**
 * 清单的**唯一** click 监听器（事件委托）：按钮靠 data-act 分派，行靠 data-tower-index 选中。
 * 每次重画只换 innerHTML，监听器挂在容器上不重建，塔再多也不会累积监听。
 */
function onTowerListClick(ev) {
  const el = ev.target;
  if (!el || !el.closest) return;
  const btn = el.closest('[data-act]');
  const row = el.closest('[data-tower-index]');
  const src = btn || row;
  if (!src) return;
  const tower = state.towers[Number(src.dataset.towerIndex)];
  if (!tower) { tListSig = ''; return; }   // 下标失效（刚被卖掉）：作废签名，下一帧重画
  const act = btn ? btn.dataset.act : '';
  if (act === 'upgrade') {
    if (btn.disabled) return;               // 满级 / 金币不足：disabled 已经拦了，这里再兜一层
    upgradeTower(tower);                    // 复用现成的 upgradeTower（扣钱 / 升级 / 落盘）
  } else if (act === 'oc') {
    if (btn.disabled) return;               // 已超频 / 金币不足：同上
    overclockTower(tower);                  // 单座超频：50% 成功保留等级 / 失败降 5 级，结果弹窗告知
  } else if (act === 'sell') {
    sellTower(tower);                       // 复用现成的 sellTower（返还 / 移除 / 落盘）
    clearTowerSelect();                     // 删掉的那一行不能还留着高亮
  } else {
    selectTower(tower);                     // 点的不是按钮 → 选中这一行对应的塔
    return;
  }
  syncHud();                                // 金币 / 清单立即刷新（不必等下一帧）
}

/* ---------- 技能栏（只在无尽模式；按钮由 SKILLS 现生成） ---------- */
/** 按 SKILLS 现生成 6 个按钮：顺序 / 名字 / 花费都来自模块；副标题 span 就是三态的载体 */
function buildSkillBar() {
  if (!ui.skills) return;
  const frag = document.createDocumentFragment();
  for (const s of SKILLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'td-skill-btn';
    btn.dataset.skill = s.id;
    btn.innerHTML = '<span class="td-sname">' + s.name + '</span><span class="td-sinfo"></span>';
    frag.appendChild(btn);
  }
  ui.skills.textContent = '';
  ui.skills.appendChild(frag);
  ui.skillBtns = Array.prototype.slice.call(ui.skills.querySelectorAll('.td-skill-btn'));
}

/** 3 座特殊塔的塔栏按钮：由 SPECIAL_TOWER_IDS 现生成（名字 / 费用 / 颜色只有一份），未解锁时灰显 */
function buildSpecialTowerBar() {
  if (!ui.towers) return;
  const frag = document.createDocumentFragment();
  for (const id of SPECIAL_TOWER_IDS) {
    const def = SPECIAL_TOWER_TYPES[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'td-tower-btn';
    btn.dataset.tower = id;
    btn.title = def.name + '：' + def.desc + '（' + def.cost[0] + ' 金币）';
    btn.dataset.baseTitle = btn.title;   // 解锁后要还原这句作者写的 title
    btn.innerHTML = '<span class="td-tchip" style="background:' + def.color + '"></span>'
      + def.name + '<span class="td-tcost">' + def.cost[0] + '</span><span class="td-tlock"></span>';
    frag.appendChild(btn);
  }
  ui.towers.appendChild(frag);
}

let skillBarSig = '';   // 技能栏上次写的签名（副标题 + disabled + class + title），没变就不写 DOM

/**
 * 技能按钮三态：未解锁（「第 N 波」）/ 冷却中（「12s」）/ 可用（**当前花费**；金币不足则禁用）。
 * 签名只由**显示出来的字**拼成，绝不把 state.timeMs 放进去 —— 否则每帧都是新签名、每帧写 DOM。
 * 花费随波次涨（effectiveSkillCost），所以按钮上写的是当前价；涨价时 title 里补一句
 * 「基础 150 → 当前 186（第 50 波）」，玩家看得懂钱为什么变多了。
 */
function syncSkillButtons() {
  if (!ui.skillBtns || !ui.skillBtns.length) return;
  const endless = state.mode === 'endless';
  const rows = [];
  let sig = endless ? 'e' : 'l';
  for (const btn of ui.skillBtns) {
    const id = btn.dataset.skill, s = getSkill(id), st = skillState(id);
    const costNow = st.cost;   // 当前花费（＝真实扣款数）
    const costNote = costNow === s.cost ? '' : ('（基础 ' + s.cost + ' → 当前 ' + costNow + '，第 ' + state.wave + ' 波）');
    const effNote = st.scale > 1 ? '· 效果 ×' + round2(st.scale) : '';
    const row = { info: '', off: true, cls: '', title: '' };
    if (!endless || state.wave < s.unlockWave) {
      row.cls = 'is-locked'; row.info = '第 ' + s.unlockWave + ' 波';
      row.title = s.name + '：第 ' + s.unlockWave + ' 波解锁（' + s.desc + '）';
    } else if (st.left > 0) {
      row.cls = 'is-cooling'; row.info = Math.ceil(st.left / 1000) + 's';
      row.title = s.name + '：冷却中，还剩 ' + Math.ceil(st.left / 1000) + ' 秒（' + s.desc + '）' + costNote;
    } else if (state.gold < costNow) {
      row.cls = 'is-poor'; row.info = String(costNow);
      row.title = '金币不足：还差 ' + (costNow - state.gold) + costNote;
    } else {
      row.off = false; row.info = String(costNow);
      row.title = s.desc + '（' + costNow + ' 金币 · 冷却 ' + Math.round(s.cooldownMs / 1000) + 's' + effNote + '）' + costNote;
    }
    if (state.casting === id) row.cls += ' is-selected';
    rows.push(row);
    sig += '|' + row.info + '#' + (row.off ? 1 : 0) + '#' + row.cls + '#' + row.title;
  }
  if (sig === skillBarSig) return;
  skillBarSig = sig;
  for (let i = 0; i < rows.length; i++) {
    const btn = ui.skillBtns[i], row = rows[i], info = btn.lastElementChild;   // info = .td-sinfo
    if (info && info.textContent !== row.info) info.textContent = row.info;
    if (btn.disabled !== row.off) btn.disabled = row.off;
    if (btn.title !== row.title) btn.title = row.title;
    btn.className = 'td-skill-btn' + (row.cls ? ' ' + row.cls : '');
  }
}

/** HUD：值变了才写 DOM，避免每帧 6 次无效写入 */
/* ---------- BOSS 信息栏（排在场上塔清单下面，同一套卡片视觉） ---------- */
const BOSS_BAR_MAX = 5;   // 最多显示 5 行，超出的折成一行小字「另有 N 只 BOSS」

/**
 * 场上 BOSS 的行数据（纯函数：不碰 DOM，UI 与自检共用同一份口径）。
 * 只取 type === 'boss' 且未 dead 的；hp 取整、pct 夹到 0..1。
 * 容错：maxHp 缺失 / ≤0 时 pct 记 0 —— 血条宽度写成 NaN 会静默失效，宁可显示空条。
 */
export function bossRows(enemies) {
  const out = [];
  if (!Array.isArray(enemies)) return out;
  for (const e of enemies) {
    if (!e || typeof e !== 'object' || e.type !== 'boss' || e.dead === true) continue;
    const maxHp = Math.max(0, Math.round(Number(e.maxHp) || 0));
    const hp = Math.max(0, Math.round(Number(e.hp) || 0));
    out.push({
      idx: out.length, hp, maxHp,
      pct: maxHp > 0 ? Math.min(1, hp / maxHp) : 0,
      armor: Number(e.armor) || 0,
      speed: Number(e.speed) || 0,
    });
  }
  return out;
}

/** 千分位（不依赖 Intl：三档分组就够 BOSS 血量用） */
function fmtInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 血条配色：>60% 绿、30%~60% 黄、<30% 红（与 HUD 的视觉语言一致） */
function bossHpColor(pct) {
  if (pct > 0.6) return 'var(--primary)';
  if (pct >= 0.3) return '#e8a33d';
  return 'var(--danger)';
}

let bossSig = '';   // BOSS 栏上次写的签名（总只数 + 每只的百分比取整值 : 整数血量）

/** 只数变了才重建行节点：血量变化只改 style.width 与 textContent（别每帧重建 DOM） */
function buildBossRows(count) {
  const box = ui.bossList;
  box.textContent = '';
  for (let i = 0; i < count; i += 1) {
    const row = document.createElement('div'); row.className = 'td-boss-row';
    const name = document.createElement('b'); name.className = 'td-boss-name';
    const bar = document.createElement('span'); bar.className = 'td-boss-hp';
    const fill = document.createElement('i'); bar.appendChild(fill);
    const num = document.createElement('span'); num.className = 'td-boss-num';
    const meta = document.createElement('span'); meta.className = 'td-boss-meta';
    row.appendChild(name); row.appendChild(bar); row.appendChild(num); row.appendChild(meta);
    box.appendChild(row);
  }
}

/**
 * BOSS 栏刷新（由 syncHud 每帧调用）。签名 = 总只数 + 每只的「百分比取整 : 整数血量」：
 * 血量百分比没变的那一帧一个字符都不写；变了也只改宽度与文本，不重建节点。
 */
function syncBossBar() {
  if (!ui.bossBar || !ui.bossList) return;
  if (!state.inRun) {   // 回关卡列表 / 不在对局：整块收起（不留空盒子）
    if (bossSig !== 'off') { bossSig = 'off'; ui.bossBar.hidden = true; ui.bossList.textContent = ''; }
    return;
  }
  const rows = bossRows(state.enemies);
  const shown = rows.slice(0, BOSS_BAR_MAX);
  const sig = rows.length + '|' + shown.map((r) => Math.round(r.pct * 100) + ':' + r.hp).join(',');
  if (sig === bossSig) return;
  bossSig = sig;
  ui.bossBar.hidden = rows.length === 0;
  if (ui.bossCount) ui.bossCount.textContent = String(rows.length);
  if (rows.length === 0) ui.bossList.textContent = '';
  else {
    if (ui.bossList.childElementCount !== shown.length) buildBossRows(shown.length);
    for (let i = 0; i < shown.length; i += 1) {
      const el = ui.bossList.children[i], r = shown[i];
      if (!el || el.children.length < 4) continue;
      el.children[0].textContent = rows.length > 1 ? 'BOSS ' + (i + 1) : 'BOSS';
      const fill = el.children[1].firstElementChild;
      if (fill) { fill.style.width = (r.pct * 100).toFixed(1) + '%'; fill.style.background = bossHpColor(r.pct); }
      el.children[2].textContent = fmtInt(r.hp) + ' / ' + fmtInt(r.maxHp);
      el.children[3].textContent = '护甲 ' + Math.round(r.armor * 100) + '% · 速度 ' + Math.round(r.speed);
    }
  }
  if (ui.bossMore) {
    const rest = rows.length - shown.length;
    ui.bossMore.hidden = rest <= 0;
    if (rest > 0) ui.bossMore.textContent = '另有 ' + rest + ' 只 BOSS';
  }
}

const hudCache = { wave: -1, lives: -1, gold: -1, kills: -1, alive: -1, best: -1 };

let nextWaveSig = '';   // 预告条上次写的签名（色调 + 文案 + 词缀），没变就不写 DOM

/**
 * 下一波预告条：内容全部来自纯函数 nextWavePreview，这里只负责拼文案 + 签名比较（每帧调用 = 一次字符串拼接）。
 * 着色按 ratio 三档：<0.7 绿（打得动）/ 0.7~1.0 黄（刚好够）/ >1.0 红（顶不住；没有塔时是 Infinity，落红档）。
 */
function syncNextWavePreview() {
  const el = ui.nextWave;
  if (!el) return;
  if (!state.inRun || state.gameOver) {
    if (nextWaveSig !== 'off') { nextWaveSig = 'off'; el.hidden = true; }
    return;
  }
  const p = nextWavePreview(state);
  const tone = p.ratio < 0.7 ? 'is-easy' : (p.ratio <= 1 ? 'is-even' : 'is-hard');
  const need = Math.round(p.reqDps), mine = Math.round(p.myDps);
  const text = '下一波：' + p.total + ' 只（' + p.comp + '）· 需要 DPS ≈ ' + need + ' · 你的 ≈ ' + mine
    + (Number.isFinite(p.ratio) ? '（差 ' + p.ratio.toFixed(2) + '×）' : '（场上还没有塔）');
  // 词缀徽章：本波有词缀就先显示本波（正在生效的那条：禁魔波里别浪费寒流），
  // 本波没有、下一波有（5 的倍数波）时才预告「下一波」，两件事挤在同一个徽章里，不多占一行。
  const currentAffix = affixLabel(state.waveAffix);
  const badge = currentAffix || (p.affixLabel ? '下一波 · ' + p.affixLabel : '');
  const sig = tone + '|' + text + '|' + badge;
  if (sig === nextWaveSig) return;   // 没变：一个字符都不写
  nextWaveSig = sig;
  el.hidden = false;
  el.className = 'td-next ' + tone;
  if (ui.nextText) ui.nextText.textContent = text;
  if (ui.nextAffix) {
    ui.nextAffix.hidden = !badge;   // 只有 5 的倍数波（本波或下一波）才有词缀文案
    if (badge) ui.nextAffix.textContent = badge;
  }
}

function syncHud() {
  if (!ui.wave) return;
  // 闯关模式波次显示「当前/总数」，让玩家知道还剩几波（有明确结局的前提）
  const waveText = state.mode === 'level' && state.level ? state.wave + '/' + state.level.waves : String(state.wave);
  if (hudCache.wave !== waveText) { ui.wave.textContent = waveText; hudCache.wave = waveText; }
  if (hudCache.lives !== state.lives) { ui.lives.textContent = state.lives; hudCache.lives = state.lives; }
  if (hudCache.gold !== state.gold) { ui.gold.textContent = state.gold; hudCache.gold = state.gold; syncTowerButtons(); }
  if (hudCache.kills !== state.kills) { ui.kills.textContent = state.kills; hudCache.kills = state.kills; }
  const alive = state.enemies.length;
  if (hudCache.alive !== alive) { ui.alive.textContent = alive; hudCache.alive = alive; }
  if (hudCache.best !== state.best) { ui.best.textContent = state.best; hudCache.best = state.best; }
  renderTowerList();   // 每帧走到这里，但签名没变就只做一次字符串拼接，不写 DOM
  syncBossBar();       // BOSS 栏：签名里带血量百分比取整值，血量不动就不写 DOM
  syncQuickUpgrade();  // 同上：按钮三态由签名比较决定写不写
  syncBatchUpgrade();  // 「批量升级」同上（文案里的合计价随金币/塔等级变，签名比较照样只写一次）
  syncBatchOverclock(); // 「一键超频」同上（合计价与成功率提示随金币/塔等级变）
  syncSkillButtons();  // 技能栏三态同上（冷却秒数只反映到秒，不会每帧写）
  syncNextWavePreview();  // 下一波预告条：签名由「文案 + 色调 + 词缀」拼成，不改就不写 DOM
}

let qUpSig = '';   // 「快速升级」按钮上次写的签名（文案 + disabled + title），没变就不动 DOM

/**
 * 「快速升级」的目标查询——**唯一入口**。
 *
 * 这个按钮的状态（syncQuickUpgrade）和点击处理原来是各算一遍，参数还不一样：
 * 状态那边传了 canUpgradeBeyond3()，点击那边漏传 → 第 50 波之后按钮明明是亮的，
 * 点下去却查到 null 直接 return，表现为「快速升级按钮不可用」。
 * 现在两处都走这里，参数只在一个地方给，不可能再分叉。
 */
function quickUpgradeTarget() {
  return nextUpgradeTarget(state.towers, state.gold, canUpgradeBeyond3());
}

/**
 * 「快速升级」按钮三态：没有塔 / 全部满级 / 金币不足 → disabled（title 说明原因）；
 * 可升级 → 可用，title 写清「把 X 升到 Lv.N（价格）」。每帧由 syncHud 调，沿用 tListSig 的签名比较办法。
 */
function syncQuickUpgrade() {
  const btn = ui.btnQuickUp;
  if (!btn) return;
  const unlocked = canUpgradeBeyond3();
  const target = quickUpgradeTarget();
  const text = target ? '快速升级（' + target.cost + '）' : '快速升级';
  const title = !target
    ? (state.towers.length === 0 ? '场上没有塔'
      : (unlocked ? '所有塔已满级' : '场上塔都到 Lv.3 了：第 ' + HIGH_LV_UNLOCK_WAVE + ' 波后解锁更高等级'))
    : (target.canAfford
      ? '把 ' + target.name + ' 升到 Lv.' + target.nextLv + '（' + target.cost + ' 金币）'
      : '金币不足：还差 ' + (target.cost - state.gold));
  const off = !target || !target.canAfford;
  const sig = text + '#' + off + '#' + title;
  if (sig === qUpSig) return;
  qUpSig = sig;
  btn.textContent = text;
  btn.disabled = off;
  btn.title = title;
}

let bUpSig = '';   // 「批量升级」按钮上次写的签名（文案 + disabled + title），没变就不动 DOM

/**
 * 输入框里的「座数」，**始终是夹好的 1..100**（nan / 空串 / 'abc' / 0 / -5 → 1，999 → 100）。
 * 按钮状态与实际执行都走这里取值，所以哪怕玩家在框里留着 999，一次也只会升 100 座。
 */
function batchCount() {
  const el = ui.batchCount;
  const raw = el ? Math.floor(Number(el.value)) : NaN;
  if (!Number.isFinite(raw)) return BATCH_UP_MIN;
  return Math.min(BATCH_UP_MAX, Math.max(BATCH_UP_MIN, raw));
}

/** 把输入框里的值原地夹好（失焦 / change 时用）：999 → 100、'' → 1、'abc' → 1 */
function clampBatchCountInput() {
  const el = ui.batchCount;
  if (!el) return BATCH_UP_MIN;
  const v = batchCount();
  const want = String(v);
  if (el.value !== want) el.value = want;   // 只在真的越界时才写，不打断正常输入
  return v;
}

/**
 * 「批量升级」按钮三态（与 syncQuickUpgrade 同一套写法：每帧由 syncHud 调，签名没变就不写 DOM）。
 *   无可升级的塔 → disabled，title 说清是「场上没有塔 / 都到 Lv.3 了 / 全满级」；
 *   有塔但钱连第一座都不够 → disabled，title「金币不足」；
 *   有能升的 → 可用，文案「批量升级（合计 X）」，title「升级 N 座（合计 X 金币）」。
 * 「有没有可升级的塔」用 nextUpgradeTarget(…, Infinity, …) 问，就是那个已经过 71 条断言的函数，
 * 不另写一份判断 —— 否则「都到 Lv.3」这种边界一定会跟单座按钮说的不一样。
 */
function syncBatchUpgrade() {
  const btn = ui.btnBatchUp;
  if (!btn) return;
  const unlocked = canUpgradeBeyond3();
  const count = batchCount();
  const plan = planBatchUpgrade(state.towers, state.gold, count, unlocked);
  const any = plan.canDo ? null : nextUpgradeTarget(state.towers, Infinity, unlocked);   // 忽略金币：场上还有没有能升的
  let text = '批量升级';
  let title;
  let off = false;
  if (plan.canDo) {
    const got = plan.targets.length;
    text = '批量升级（合计 ' + plan.totalCost + '）';
    title = '升级 ' + got + ' 座（合计 ' + plan.totalCost + ' 金币）'
      + (got < count ? '·金币只够升 ' + got + ' 座' : '');
  } else {
    off = true;
    title = any
      ? '金币不足'
      : (state.towers.length === 0 ? '场上没有可升级的塔'
        : (unlocked ? '所有塔已满级' : '场上塔都到 Lv.3 了：第 ' + HIGH_LV_UNLOCK_WAVE + ' 波后解锁更高等级'));
  }
  const sig = text + '#' + off + '#' + title;
  if (sig === bUpSig) return;
  bUpSig = sig;
  btn.textContent = text;
  btn.disabled = off;
  btn.title = title;
}

let bOcSig = '';   // 「一键超频」按钮上次写的签名（文案 + disabled + title），没变就不动 DOM

/**
 * 「一键超频」输入框里的座数，**始终是夹好的 1..20**（nan / 空串 / 'abc' / 0 / -5 → 1，99 → 20）。
 * 按钮状态与实际执行都走这里取值，所以哪怕玩家在框里留着 99，一次也只会赌 20 座。
 */
function ocCount() {
  const el = ui.ocCount;
  const raw = el ? Math.floor(Number(el.value)) : NaN;
  if (!Number.isFinite(raw)) return OC_COUNT_MIN;
  return Math.min(OC_COUNT_MAX, Math.max(OC_COUNT_MIN, raw));
}

/** 把一键超频的输入框原地夹好（失焦 / change 时用）：99 → 20、'' → 1、'abc' → 1 */
function clampOcCountInput() {
  const el = ui.ocCount;
  if (!el) return OC_COUNT_MIN;
  const v = ocCount();
  const want = String(v);
  if (el.value !== want) el.value = want;   // 只在真的越界时才写，不打断正常输入
  return v;
}

/**
 * 「一键超频」按钮三态（与 syncBatchUpgrade 同一套签名写法：每帧由 syncHud 调，没变就不写 DOM）。
 *   有可超频的塔且钱够 → 可用，文案「一键超频（合计 X）」，title 写清座数 / 合计价 / 50% 成功率；
 *   没塔 / 全部已超频 / 钱连第一座都不够 → disabled，title 说明原因。
 */
function syncBatchOverclock() {
  const btn = ui.btnBatchOc;
  if (!btn) return;
  const count = ocCount();
  const plan = planBatchOverclock(state.towers, state.gold, count);
  let text = '一键超频';
  let title;
  let off = false;
  if (plan.canDo) {
    const got = plan.targets.length;
    text = '一键超频（合计 ' + plan.totalCost + '）';
    title = '超频 ' + got + ' 座（合计 ' + plan.totalCost + ' 金币）·成功率 50%，失败降 ' + OC_FAIL_DROP + ' 级'
      + (got < count ? '·金币只够赌 ' + got + ' 座' : '');
  } else {
    off = true;
    let open = 0;
    let cheapest = 0;
    for (let i = 0; i < state.towers.length; i += 1) {
      const t = state.towers[i];
      if (!t || !ALL_TOWER_TYPES[t.type] || t.oc === true) continue;
      const c = overclockCost(t.lv);
      if (!(c > 0)) continue;
      open += 1;
      if (cheapest === 0 || c < cheapest) cheapest = c;
    }
    title = state.towers.length === 0 ? '场上没有塔'
      : (open === 0 ? '所有塔都已超频'
        : '金币不足：最便宜的一座要 ' + cheapest);
  }
  const sig = text + '#' + off + '#' + title;
  if (sig === bOcSig) return;
  bOcSig = sig;
  btn.textContent = text;
  btn.disabled = off;
  btn.title = title;
}

let tBtnSig = '';   // 塔栏「解锁 / 是否出现」这部分上次写的签名（只跟模式 + 波次有关）

/**
 * 塔按钮三态：选中 / 买不起 / 未解锁。特殊塔多两件事：解锁波次没到 → 灰显 + 副标题「第 N 波」；
 * 闯关模式整颗按钮不出现（特殊塔与技能栏都只属于无尽模式）。解锁只随 (模式, 波次) 变，单列签名。
 */
function syncTowerButtons() {
  if (!ui.towerBtns) return;
  const lockSig = state.mode + '#' + state.wave;
  const relock = lockSig !== tBtnSig;
  if (relock) tBtnSig = lockSig;
  for (let i = 0; i < ui.towerBtns.length; i++) {
    const btn = ui.towerBtns[i];
    const type = btn.dataset.tower;
    const def = ALL_TOWER_TYPES[type];
    if (!def) continue;
    const special = isSpecialTower(type);
    const inLevel = state.mode !== 'endless';
    const locked = special && (inLevel || state.wave < towerUnlockWave(type));
    if (relock) {
      btn.hidden = special && inLevel;                       // 闯关模式：特殊塔不出现在塔栏
      btn.classList.toggle('is-locked', locked && !inLevel);
      btn.title = locked && !inLevel
        ? def.name + '：第 ' + towerUnlockWave(type) + ' 波解锁（' + def.desc + '）'
        : (btn.dataset.baseTitle || def.name);
      const lockEl = btn.querySelector('.td-tlock');
      if (lockEl) lockEl.textContent = locked && !inLevel ? '第 ' + towerUnlockWave(type) + ' 波' : '';
    }
    btn.classList.toggle('is-selected', state.selectedType === type);
    btn.classList.toggle('is-poor', !locked && state.gold < def.cost[0]);
  }
}

/**
 * 结算浮层：失败（生命归零）与通关（打完固定波数）共用同一个盒子，只换文案与按钮。
 * 「下一关」只在闯关通关且还有下一关时出现；「关卡列表」只在闯关模式出现。
 */
function showOverlay() {
  clearTowerSelect();   // 对局结算：清掉选中圈与行高亮（清单本身还挂着「场上有哪些塔」，不必藏）
  const lv = state.level;
  const isLevel = state.mode === 'level' && !!lv;
  const win = state.result === 'win';
  ui.overTitle.textContent = win ? '通关！' : (isLevel ? '关卡失败' : '防线被攻破了');
  ui.overWave.textContent = state.wave + (isLevel ? '/' + lv.waves : '');
  ui.overSub.textContent = win ? '本关 ' + lv.waves + ' 波全部清空' : (isLevel ? '本关到达波次' : '到达波次');
  ui.overBest.textContent = isLevel
    ? '本关最好：' + (progress.levelBest[lv.level] || 0) + '/' + lv.waves + ' 波'
    : '最高波数：' + progress.endlessBest;
  ui.btnAgain.textContent = isLevel ? '重打本关' : '再来一局';
  ui.btnAgain.hidden = false;   // 僵局浮层会把主按钮藏起来，结算浮层要显式还原
  if (stallUI.keep) { stallUI.keep.hidden = true; stallUI.end.hidden = true; }
  ui.btnNext.hidden = !(win && isLevel && lv.level < LEVEL_MAX);
  ui.btnList.hidden = !isLevel;
  ui.overlay.classList.add('show');
}

function hideOverlay() {
  if (ui.overlay) ui.overlay.classList.remove('show');
  state.stallPaused = false;   // 任何路径关掉浮层都恢复推进（重开 / 换模式 / 结算都会走到这里）
}

/* ---------- 僵局浮层（无尽模式「这一波清不完」的出口） ---------- */
/**
 * 复用结算浮层那个盒子（tdOverlay），只换文案与按钮：不新增 DOM id，也不碰 CSS。
 * 两个按钮首次用到时现建（createElement），挂在「再来一局」的父节点里，顺带复用 .td-overacts 的排版。
 */
const stallUI = { keep: null, end: null };

function ensureStallButtons() {
  if (stallUI.keep || !ui.btnAgain || !ui.btnAgain.parentNode) return stallUI;
  const host = ui.btnAgain.parentNode;
  // 主按钮「结束本局」走 gameOver()：与生命归零同一条路径（写 endlessBest / 清续玩记录 / 亮结算浮层）
  stallUI.end = document.createElement('button');
  stallUI.end.textContent = '结束本局（记入最高波数）';
  stallUI.end.addEventListener('click', giveUpStalledRun);
  // 次按钮「继续打」：关掉提示接着打，不再反复打扰（同一波最多每 60 秒提醒一次，见 checkWaveStall）
  stallUI.keep = document.createElement('button');
  stallUI.keep.className = 'td-secondary';
  stallUI.keep.textContent = '继续打';
  stallUI.keep.addEventListener('click', keepFightingStall);
  host.appendChild(stallUI.end);
  host.appendChild(stallUI.keep);
  stallUI.end.hidden = true; stallUI.keep.hidden = true;
  return stallUI;
}

/** 亮僵局浮层：标题 / 正文 / 两个按钮；同时把主循环挂起（stallPaused），别让玩家在决策时继续掉命 */
function showStallOverlay() {
  ensureStallButtons();
  clearTowerSelect();
  ui.overTitle.textContent = '这一波清不完了';
  ui.overWave.textContent = state.wave;
  ui.overSub.textContent = '第 ' + state.wave + ' 波 · 场上还剩 ' + state.enemies.length
    + ' 只 · 继续打下去也清不完（敌人总血量远超当前输出）';
  ui.overBest.textContent = '最高波数：' + progress.endlessBest;
  // 结算浮层那三个按钮（再来一局 / 下一关 / 关卡列表）在这里全藏起来：它们不是这次的选项
  ui.btnAgain.hidden = true; ui.btnNext.hidden = true; ui.btnList.hidden = true;
  if (stallUI.end) stallUI.end.hidden = false;
  if (stallUI.keep) stallUI.keep.hidden = false;
  ui.overlay.classList.add('show');
  state.stallPaused = true;
}

/** 「继续打」：关浮层、恢复推进，并记下提醒时刻（下一次最早 60 秒后再说） */
function keepFightingStall() {
  state.stallNoticeAt = state.timeMs;
  hideOverlay();   // 内部会把 stallPaused 复位
}

/** 「结束本局」：走结算那条路（endlessBest 由 gameOver → noteBest 写对），只把标题换成「主动结束」 */
function giveUpStalledRun() {
  hideOverlay();
  gameOver();
  ui.overTitle.textContent = '本局结束（这一波清不完）';
  syncHud();
}

/* ---------- 塔数值表（每个数字都现读塔表，绝不手抄第二份） ---------- */
/**
 * 塔数值表的行 HTML（纯函数：只读 ALL_TOWER_TYPES，不碰 DOM）：4 基础塔 + 3 特殊塔 × 3 级，
 * 每种塔再补一行 Lv.4~MAX_TOWER_LEVEL 的汇总（一行讲完外推规则，绝不铺成 100 级 × 7 塔）。
 * 光环塔无 dmg / rate、毒塔 dmg 恒为 0，都显示「—」（毒塔输出写在特效列的「无视护甲 毒 X/s」）。
 * 拆出来是为了让自检能断言「并进特殊塔后这张表里没有 NaN / undefined」。
 */
function highLevelNote(key) {
  const d = ALL_TOWER_TYPES[key];
  const parts = [];
  if (d.auraRate) parts.push('攻速增幅 +2%/级', '伤害增幅 +2%/级（各上限 +100%）');   // 光环塔自身不攻击，没有伤害项
  else {
    parts.push(d.poison ? '毒伤 ×1.12/级（无视护甲）' : '伤害 ×1.12/级', '攻速 +1.5%/级（上限 ×2）');
  }
  parts.push('射程 +0.6/级（上限 +50）');
  if (d.splash) parts.push('溅射 +4/级（上限 +40）');
  if (d.slow) parts.push('减速 +1%/级（上限 80%，时长不变）');
  if (d.push) parts.push('推回 +0.05 格/级（上限 +50%）');
  if (d.chain) parts.push('跳数与每跳衰减不变');
  return 'Lv.4–' + MAX_TOWER_LEVEL + '：' + parts.join('、') + '、升级价 ×' + HIGH_LV_COST_STEP + '/级；第 '
    + HIGH_LV_UNLOCK_WAVE + ' 波后解锁（仅无尽模式）';
}

function towerStatRows() {
  const head = ['塔', '等级', '造价', '伤害', '攻速', '射程', '特效'];
  let rows = '';
  for (const key in ALL_TOWER_TYPES) {
    const d = ALL_TOWER_TYPES[key];
    for (let lv = 1; lv <= 3; lv++) {
      const i = lv - 1, spent = d.cost.slice(0, lv).reduce((s, c) => s + c, 0);
      const note = '建造 ' + d.cost[0] + (lv > 1 ? ' + 升级 ' + d.cost.slice(1, lv).join(' + ') : '');
      let fx = '—';
      if (d.splash) fx = '溅射半径 ' + d.splash[i];
      else if (d.slow) fx = '减速 ' + Math.round(d.slow[i] * 100) + '% · ' + (d.slowMs[i] / 1000).toFixed(1) + 's';
      else if (d.auraRate) fx = '攻速 +' + Math.round(d.auraRate[i] * 100) + '% · 伤害 +' + Math.round(d.auraDmg[i] * 100) + '%';
      else if (d.chain) fx = '链式：额外跳 ' + d.chain.count + ' 个，每跳 -' + Math.round(d.chain.falloff * 100) + '%';
      else if (d.poison) fx = '无视护甲 毒 ' + d.poison.dps[i] + '/s · ' + (d.poison.durationMs / 1000) + 's';
      else if (d.push) fx = '推回 ' + d.push.tiles[i] + ' 格' + (d.push.bossHalf ? '（BOSS 减半）' : '');
      const dmgCell = d.poison ? '—' : (d.dmg ? d.dmg[i] : '—');
      rows += '<tr>' + (lv === 1 ? '<td rowspan="4" style="color:' + d.color + '">' + d.name + '</td>' : '')
        + '<td>Lv.' + lv + '</td><td title="' + note + '">' + spent + '</td><td>' + dmgCell + '</td>'
        + '<td>' + (d.rate ? d.rate[i].toFixed(1) + '/s' : '—') + '</td><td>' + d.range[i] + '</td><td>' + fx + '</td></tr>';
    }
    // 第 4 行 = Lv.4~MAX 的汇总（与上面 3 行共用 rowspan="4" 的塔名格），不铺 100 行
    rows += '<tr class="td-tstats-note"><td colspan="6">' + highLevelNote(key) + '</td></tr>';
  }
  // 表尾补一行「超频」说明：同一张表里讲完，不另起一张表（结构化的一行，读屏也能念到）。
  // 刻意写成 <tr class="…"> 而不是裸 <tr>，这样「7 种塔 × 3 级 = 21 行 + 1 行表头」这条
  // 既有断言的计数口径一个字都不用改。
  rows += '<tr class="td-tstats-oc"><td colspan="7">超频塔（画布上的金色脉冲环）：伤害 ×1.6、攻速 ×1.25、'
    + '射程 ×1.15；光环增幅 ×1.4、冰塔减速 +10%、毒 dot ×1.6、推回 ×1.25、特斯拉目标数 3 → 5。'
    + '超频成功率 50%，失败降 ' + OC_FAIL_DROP + ' 级（最低 1 级），超频不改变升级价</td></tr>';
  // 表尾再补一行「专精」说明：同样写成带 class 的 tr，既有的「21 行 + 1 行表头」计数口径不受影响
  rows += '<tr class="td-tstats-spec"><td colspan="7">专精：Lv.10 / 25 / 50 各一次二选一，只改数值不改升级价'
    + '（每档两个取向：一个偏伤害 / 绝对量，一个偏频率 / 范围 / 控制）</td></tr>';
  return '<table><thead><tr><th>' + head.join('</th><th>') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function buildTowerStats() {
  // 不静默 return：容器取不到说明 DOM 与 JS 的 id 对不上了，留一条 warn 便于一眼定位，
  // 而不是像以前那样「什么也没有、也没有报错」。
  const box = ui.towerStatsBody;
  if (!box) { console.warn('[tower-defense] 塔数值表容器缺失 #tdTowerStatsBody'); return; }
  // 防御：塔数据为空时宁可不生成，也不要留一张只有表头的假表
  if (!ALL_TOWER_TYPES || Object.keys(ALL_TOWER_TYPES).length === 0) {
    console.warn('[tower-defense] 塔表为空，跳过塔数值表生成');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = towerStatRows();
}

/* ---------- 存档导出 / 导入 ---------- */
/** 提示条：一句话讲结果，失败标红 */
function saveMsg(text, bad) {
  if (!ui.saveMsg) return;
  ui.saveMsg.textContent = text; ui.saveMsg.classList.toggle('is-bad', !!bad);
}

/** 合并策略：unlocked / endlessBest 取大、levelBest 逐键取大、endlessRun 取 savedAt 较新者。 */
function mergeProgress(cur, inc) {
  const out = sanitizeProgress(cur, false) || defaultProgress();
  out.unlocked = Math.max(out.unlocked, inc.unlocked);
  out.endlessBest = Math.max(out.endlessBest, inc.endlessBest);
  for (const k in inc.levelBest) out.levelBest[Number(k)] = Math.max(out.levelBest[Number(k)] || 0, inc.levelBest[k]);
  // 无尽进度是「单槽位」，不能按「谁新就留谁」合并：
  // 页面一加载就会写出当前这局的 endlessRun（savedAt = 此刻），它永远比任何导入的旧存档新，
  // 于是导入进度永远胜不出 → 表现就是「导入成功、却怎么也用不上」。
  // 导入是用户的显式意图，因此只要导入里带了无尽进度，就用它。
  // （关卡解锁 / 各关最好 / 最高波数是单调数据，仍按取大合并。）
  out.endlessRun = inc.endlessRun || out.endlessRun;
  return out;
}

/**
 * 对局进行中导入「带无尽进度」的存档时，当场问要不要切过去。
 *
 * 为什么必须问：页面加载后会自动开波次 1，而 maybeAwaitResume() 的守卫是 `state.wave === 0`
 * —— 也就是说「继续上次」只在"刚打开页面、还没开波"的那一瞬间出现。对局已经在跑时导入，
 * 那条提示永远不会出现，这份进度就只剩两条路：等到下次打开页面，或者被「重开」清掉。
 * 用户看到的是「导入成功、含可继续的无尽进度」，却怎么也点不到 —— 即「可以读取但无法使用」。
 *
 * 这里用动态 import 取 showConfirm：本模块顶层刻意保持零 import（Node 下 import 它只拿纯函数、
 * 不碰 DOM），动态 import 只在浏览器里、且只在用户点了导入时才执行，不破坏这个性质。
 */
function offerImportedRun(run) {
  (async () => {
    try {
      const { showConfirm } = await import('/lib/ui/popup.mjs');
      const choice = await showConfirm({
        eyebrow: '导入存档',
        title: '要用这份无尽进度吗？',
        text: '存档里有第 ' + run.wave + ' 波的无尽进度（金币 ' + run.gold + ' / 生命 ' + run.lives
          + ' / 塔 ' + run.towers.length + ' 座）。现在切换会放弃当前这局；'
          + '不切换的话这份进度会被当前这局覆盖，所以这里只有两个选择。',
        buttons: ['现在切换', '不切换'],
        button_style: ['primary', 'tp']
      });
      // showConfirm 返回倒序索引：buttons 为 ['现在切换','不切换'] 时，切换 = 1
      if (choice === 1) {
        resumeEndlessRun();
        saveMsg('已切换到导入的无尽进度（第 ' + run.wave + ' 波）', false);
        return;
      }
      // 不切换：明确丢掉，避免「以为留着、其实下一波就被覆盖」的错觉
      clearEndlessRun();
      saveMsg('已保留当前这局；导入的无尽进度未采用（关卡解锁与最高波数仍已导入）', false);
    } catch (err) {
      // 弹窗不可用（极端情况）：保守起见直接切过去，否则这份进度会立刻被覆盖掉
      console.warn('[tower-defense] 导入后续玩询问失败，改为直接切换：', err);
      resumeEndlessRun();
    }
  })();
}

/**
 * 导入一段文本或一个对象（存档码 / .json 正文走同一条校验链）。失败只提示、一个字节都不写：
 * progress 与 localStorage 都不动，现有存档绝不被毁。成功则立刻刷新最高波数、关卡网格与继续按钮。
 */
function applyImport(raw) {
  const inc = typeof raw === 'string' ? parseSaveText(raw) : sanitizeProgress(raw, true);
  if (!inc) { saveMsg('存档无效，未做任何修改', true); return false; }
  progress = mergeProgress(progress, inc);
  saveProgress();
  state.best = state.mode === 'level' && state.level
    ? (progress.levelBest[state.level.level] || 0) : progress.endlessBest;
  hudCache.best = -1;                                    // 让 syncHud 强制重写这一格
  if (ui.levelGrid && state.mode === 'level' && !state.inRun) buildLevelGrid();
  state.resumeDone = false;                              // 导入的记录也算「还没问过」
  maybeAwaitResume();
  syncHud();

  // 对局进行中：续玩提示不会自己出现（见 offerImportedRun 的注释），改为当场询问
  const run = resumableRun();
  const midRun = state.inRun && !state.gameOver && state.wave > 0;
  if (run && midRun) offerImportedRun(run);

  saveMsg('导入成功：解锁 ' + progress.unlocked + ' 关 · 无尽最高 ' + progress.endlessBest + ' 波 · '
    + (!run ? '无可继续的无尽进度'
      : midRun ? '含第 ' + run.wave + ' 波的无尽进度（已保存，见弹窗/下次打开时提示）'
        : '含可继续的无尽进度'), false);
  return true;
}

/* ---------- 关卡选择（100 关网格） ---------- */
/**
 * 关卡总怪量 = 该关所有波次实际出场数之和。用 groups 求和而不是 w.total —— 后者按设计不含 BOSS。
 * 100 关 × 最多 28 波在切到闯关列表时一次算完（约 1600 次 buildLevelWave），结果缓存在 Map：
 * 运行期数值不变，只算一次就够，避免每次进列表都重跑一遍把 UI 卡一下。
 */
const levelTotalCache = new Map();
function levelTotalEnemies(L) {
  const hit = levelTotalCache.get(L);
  if (hit != null) return hit;
  const cfg = generateLevel(L);
  let sum = 0;
  for (let n = 1; n <= cfg.waves; n++) for (const g of buildLevelWave(cfg, n).groups) sum += g.count;
  levelTotalCache.set(L, sum);
  return sum;
}

/**
 * 三态判定（每关一个按钮）：
 *  已通关   L < progress.unlocked（通关才会 +1）或本关最好波数已满 ⇒ 绿
 *  可挑战   L <= progress.unlocked 且未通关 ⇒ 高亮（实际通常只有一关）
 *  未解锁   L > progress.unlocked ⇒ 灰 + 真 disabled，点不动
 * 按钮只显示两行：大字关卡号 + 小字总怪量；「最好 w/waves 波」挪进 title，免得按钮容不下。
 */
function buildLevelGrid() {
  if (!ui.levelGrid) return;
  const frag = document.createDocumentFragment();
  for (let L = 1; L <= LEVEL_MAX; L++) {
    const cfg = generateLevel(L);
    const best = progress.levelBest[L] || 0;
    const cleared = L < progress.unlocked || best >= cfg.waves;
    const locked = L > progress.unlocked;
    const total = levelTotalEnemies(L);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'td-lv' + (cleared ? ' is-clear' : locked ? ' is-lock' : ' is-open');
    btn.disabled = locked;
    btn.dataset.level = String(L);
    btn.innerHTML = '<b>' + L + '</b><small>总怪量 ' + total + '</small>';
    btn.title = '第 ' + L + ' 关 · ' + cfg.waves + ' 波 · 总怪量 ' + total
      + ' · 最好 ' + best + '/' + cfg.waves + ' 波 · ' + (locked ? '未解锁' : cleared ? '已通关' : '可挑战');
    frag.appendChild(btn);
  }
  ui.levelGrid.textContent = '';
  ui.levelGrid.appendChild(frag);
  if (ui.levelsProg) {
    ui.levelsProg.textContent = '已通关 ' + Math.min(LEVEL_MAX, progress.unlocked - 1) + ' / ' + LEVEL_MAX + ' 关';
  }
}

/** 视图切换：对局中显示状态栏/画布/塔栏，闯关列表显示网格；顺带同步模式按钮与角标 */
function syncView() {
  const playing = state.inRun;
  const menu = state.mode === 'level' && !state.inRun;
  const show = (el, on) => { if (el) el.hidden = !on; };
  show(ui.hud, playing); show(ui.stage, playing); show(ui.bar, playing); show(ui.hint, playing);
  show(ui.nextWave, playing);   // 下一波预告条只在对局中显示（内容由 syncNextWavePreview 负责）
  // 技能栏只在无尽模式：闯关模式没有「主动技能」这条玩法（解锁波次也是按无尽曲线定的）
  show(ui.skills, playing && state.mode === 'endless');
  // 批量升级（座数输入 + 按钮）整组同样只在无尽模式：闯关最多 28 波、没有 Lv.4+ 玩法，用不上
  show(ui.batchBox, playing && state.mode === 'endless');
  show(ui.btnBatchUp, playing && state.mode === 'endless');
  // 一键超频（座数输入 + 按钮）同样只在无尽模式：闯关最多 28 波、等级上不去，赌超频没有意义
  show(ui.ocBox, playing && state.mode === 'endless');
  show(ui.btnBatchOc, playing && state.mode === 'endless');
  show(ui.tInfo, playing);   // 场上塔清单只在对局中显示；回关卡列表 / 切模式一起收起
  show(ui.levels, menu);
  if (ui.btnBack) ui.btnBack.hidden = state.mode !== 'level';
  if (ui.btnModeEndless) ui.btnModeEndless.classList.toggle('is-on', state.mode === 'endless');
  if (ui.btnModeLevel) ui.btnModeLevel.classList.toggle('is-on', state.mode === 'level');
  if (ui.modeBadge) {
    ui.modeBadge.textContent = state.mode === 'level'
      ? (state.inRun && state.level ? '第 ' + state.level.level + ' 关 · ' + state.level.waves + ' 波' : '闯关模式')
      : '无尽模式';
  }
  if (menu) buildLevelGrid();
  syncSkillButtons();   // 模式一变，技能栏整排的解锁文案就变（签名比较，没变不写）
  syncTowerButtons();   // 同上：闯关模式要摘掉特殊塔
  syncBatchUpgrade();   // 同上：换模式后「批量升级」的显隐与文案立刻对齐
  syncBatchOverclock(); // 同上：「一键超频」换模式后收起并同步文案
  if (playing) setupCanvas();   // 从 hidden 恢复时元素才有宽度，必须重算 backing store
}

/** 开始某一关（换图作废旧塔与场上敌人由 resetGame 统一处理） */
function startLevel(L) {
  const cfg = generateLevel(L);
  if (cfg.level > progress.unlocked) return;   // 兜底：未解锁的关不许进
  state.mode = 'level'; state.level = cfg; state.inRun = true;
  hideOverlay(); clearTowerSelect();
  resetGame();
  ui.btnPause.textContent = '暂停'; ui.btnPause.classList.remove('is-on');
  ui.btnSpeed.textContent = '1x'; ui.btnSpeed.classList.remove('is-on');
  lastTs = 0; acc = 0;
  syncView(); syncTowerButtons(); syncHud();
}

/** 切模式：中途切换不判失败，直接丢弃当前对局（最好波数在每波开始时已经落盘） */
function setMode(mode) {
  state.mode = mode === 'level' ? 'level' : 'endless';
  state.level = state.mode === 'level' ? generateLevel(progress.unlocked) : null;
  state.inRun = state.mode === 'endless';    // 无尽直接开局；闯关先进关卡列表
  state.paused = false; state.gameOver = false; state.result = ''; state.waveActive = false;
  hideOverlay(); clearTowerSelect();
  if (state.inRun) resetGame();
  state.resumeDone = false;                  // 换模式 = 新语境，重新问一次「继续还是重开」
  lastTs = 0; acc = 0;
  maybeAwaitResume();
  syncView(); syncTowerButtons(); syncHud();
}

/** 中途退出回关卡列表：不判失败，也不写任何失败记录 */
function backToList() {
  state.inRun = false; state.paused = false; state.gameOver = false; state.result = '';
  state.waveActive = false; state.selectedTower = null; state.selectedType = null;
  state.enemies.length = 0; state.bullets.length = 0;
  state.particles.length = 0; state.floaters.length = 0;
  hideOverlay(); clearTowerSelect();
  syncView(); syncTowerButtons();
}

/* ===================== 13. 主循环：固定步长 + 补帧上限 ===================== */
let acc = 0;      // 累积的未消耗逻辑时间（秒）
let lastTs = 0;   // 上一帧时间戳；0 = 需要重新对齐基准

function frame(ts) {
  requestAnimationFrame(frame);
  if (!lastTs) { lastTs = ts; return; }   // 首帧 / 恢复可见后的首帧只对齐基准
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.25) dt = 0.25;               // 长卡顿先给真实间隔封顶
  if (!state.inRun || state.paused || state.hidden || state.gameOver || state.awaitingResume
      || state.stallPaused || state.halted) {
    acc = 0;                                // 不在对局中（关卡列表）/ 等玩家选继续 / 僵局浮层挂着 / 已停摆时彻底不推进逻辑
  } else {
    acc += dt * state.speed;              // 倍速只加快累积，不改渲染帧率
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
      // 护栏：step() 抛异常时**不吞、不每帧刷屏** —— 打一条带栈的 error、停掉主循环、在画布顶部挂一行
      // 可读提示。没有这道护栏时异常每帧抛一次、render 被跳过，表现就是「画面正常但所有数据不动」。
      try {
        step(STEP);
      } catch (err) {
        console.error('[tower-defense] step 异常：', err && err.stack ? err.stack : err);
        state.halted = true;
        acc = 0; lastTs = 0;
        break;
      }
      acc -= STEP;
      steps += 1;
      if (state.gameOver) break;
    }
    if (steps >= MAX_STEPS_PER_FRAME) acc = 0;   // 追不上就丢弃欠账，绝不滚成雪球
  }
  if (state.inRun) { render(); syncHud(); }
}

/**
 * 停摆提示：逻辑步进出错后画在画布顶部（画布是最靠得住的那块区域 —— 出错的可能是 HUD 的数据源）。
 * 文案里给出「导出存档后刷新」这条可执行动作，用户看到的是「游戏逻辑出错」而不是「游戏卡死」。
 */
function drawHaltBanner(ctx) {
  if (!state.halted) return;
  const text = '游戏逻辑出错已暂停（第 ' + state.wave + ' 波），请导出存档后刷新页面';
  ctx.save();
  ctx.fillStyle = 'rgba(217,48,37,0.94)';
  ctx.fillRect(0, 0, VIEW.w, 26);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, VIEW.w / 2, 13.5);
  ctx.restore();
}

/* ===================== 14. 尺寸 / 事件 / 启动 ===================== */
/** 按 DPR 放大 backing store，再用 setTransform 把绘制坐标固定成 768×448 */
function setupCanvas() {
  const cssW = Math.max(240, Math.min(ui.stage.clientWidth || VIEW.w, VIEW.w));
  const cssH = Math.round((cssW * VIEW.h) / VIEW.w);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ui.canvas.style.height = cssH + 'px';
  ui.canvas.width = Math.round(cssW * dpr);
  ui.canvas.height = Math.round(cssH * dpr);
  draw.ctx.setTransform(ui.canvas.width / VIEW.w, 0, 0, ui.canvas.height / VIEW.h, 0, 0);
}

function togglePause() {
  if (state.gameOver) return;
  state.paused = !state.paused;
  ui.btnPause.textContent = state.paused ? '继续' : '暂停';
  ui.btnPause.classList.toggle('is-on', state.paused);
}

function restart() {
  if (state.mode === 'endless') clearEndlessRun();   // 主动重开：旧的可续记录作废（别续到已放弃的一局）
  state.resumeDone = false;
  resetGame(); hideOverlay(); clearTowerSelect();
  lastTs = 0; acc = 0;
  ui.btnPause.textContent = '暂停'; ui.btnPause.classList.remove('is-on');
  ui.btnSpeed.textContent = '1x'; ui.btnSpeed.classList.remove('is-on');
  maybeAwaitResume(); syncTowerButtons(); syncHud();
}

/**
 * 「继续上次 / 重新开始」待选择态：只在「无尽 + 未开局（第 0 波）+ 有 7 天内的记录 + 没问过」
 * 时成立。为真时主循环不推进（见 frame），否则 1.8s 倒计时一到就开始新的一局，选择权被没收。
 */
function maybeAwaitResume() {
  const run = resumableRun();
  state.awaitingResume = !!run && !state.resumeDone && state.mode === 'endless'
    && state.inRun && !state.gameOver && state.wave === 0;
  if (ui.resumeBar) ui.resumeBar.hidden = !state.awaitingResume;
  if (ui.btnResume && state.awaitingResume) ui.btnResume.textContent = '继续上次（第 ' + run.wave + ' 波）';
}

/**
 * 续玩：恢复金币 / 生命 / 击杀 / 种子 / 塔阵，波次回到 run.wave 的「开头」—— 波中状态（场上
 * 敌人、飞行子弹、剩余出场队列）根本不进存档，所以那一波是从第一只怪重新开始，不是接着半波打。
 * 非法塔位（越界 / 落在路径上 / 与已有塔重叠）逐座跳过并 console.warn，坏存档不会把局面搞崩。
 */
function resumeEndlessRun() {
  const run = resumableRun();
  if (!run) { maybeAwaitResume(); return; }
  state.mode = 'endless'; state.level = null; state.inRun = true;
  resetGame();                                  // 清实体 + 按无尽模式重建地图（固定第 1 张）
  state.seed = run.seed;
  state.gold = run.gold; state.lives = run.lives; state.kills = run.kills;
  state.wave = run.wave - 1;                    // startWave 会 +1 → 正好从该波开头重来
  state.nextWaveIn = 1500;
  let skipped = 0;
  let overCap = 0;                              // 旧存档可能铺了远超上限的塔：只恢复前 MAX_TOWERS 座
  for (const t of run.towers) {
    if (state.towers.length >= MAX_TOWERS) { overCap += 1; continue; }
    const def = ALL_TOWER_TYPES[t.type];
    if (!def || !isBuildable(state, t.col, t.row) || towerAt(state, t.col, t.row)) { skipped += 1; continue; }
    state.towers.push({
      type: t.type, lv: t.lvl, col: t.col, row: t.row, x: (t.col + 0.5) * GRID.tile, y: (t.row + 0.5) * GRID.tile,
      cd: 0, rateBuff: 0, dmgBuff: 0, spend: def.cost.slice(0, t.lvl).reduce((s, c) => s + c, 0),  // 还原总投入，出售不亏
      oc: t.oc === true,   // 超频随存档还原（数值由 towerStat(type, lv, oc) 现算，等级一分不动）
      // 专精随存档还原。**必须复制一份**：否则内存里的塔与 progress.endlessRun 里的对象共用同一个 picks，
      // 之后选新专精会顺手改写「存档里的那一条」（内存态与落盘态从此互相污染）。
      spec: t.spec && typeof t.spec === 'object' ? { ...t.spec } : {},
    });
  }
  // 技能冷却：存档里是「剩余毫秒」，还原成绝对时刻（本局逻辑时间基准 state.timeMs，此刻刚从 0 起步）。
  // 这样刷新页面不能把冷却清零，玩家也没法靠重载白拿四轮技能。
  state.skillReady = {};
  if (run.skillReady) for (const id in run.skillReady) {
    if (!Object.prototype.hasOwnProperty.call(run.skillReady, id) || !getSkill(id)) continue;
    const left = Math.floor(Number(run.skillReady[id]));
    if (Number.isFinite(left) && left > 0) state.skillReady[id] = state.timeMs + Math.min(RUN_LEFT_MAX_MS, left);
  }
  // 护盾：已付过钱的防御资源，剩余次数与到期时刻一起还原（hits 已在校验层夹到 0..SHIELD.maxHits）
  state.shield = null;
  if (run.shield && run.shield.hits > 0 && run.shield.ms > 0) {
    state.shield = {
      hits: Math.min(SHIELD.maxHits, run.shield.hits),
      until: state.timeMs + Math.min(RUN_LEFT_MAX_MS, run.shield.ms),
    };
  }
  if (skipped > 0) console.warn('[tower-defense] 续玩跳过 ' + skipped + ' 座非法塔位（越界/在路径上/重叠）');
  if (overCap > 0) console.warn('[tower-defense] 续玩时塔数超过上限 ' + MAX_TOWERS + ' 座，已忽略多出的 ' + overCap + ' 座');
  state.resumeDone = true;                      // 已经选过「继续」，别再拦一次
  state.awaitingResume = false;
  hideOverlay(); clearTowerSelect();
  lastTs = 0; acc = 0;
  ui.btnPause.textContent = '暂停'; ui.btnPause.classList.remove('is-on');
  ui.btnSpeed.textContent = '1x'; ui.btnSpeed.classList.remove('is-on');
  if (ui.resumeBar) ui.resumeBar.hidden = true;
  syncTowerButtons(); syncHud();
}

function bindEvents() {
  ui.canvas.addEventListener('pointerdown', onPointerDown);
  ui.canvas.addEventListener('pointermove', onPointerMove);
  ui.canvas.addEventListener('pointerleave', () => { state.hover.col = -1; state.hover.row = -1; });

  ui.towerBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.tower;
      const def = ALL_TOWER_TYPES[type];
      if (!def) return;
      // 未解锁的特殊塔（含闯关模式下根本不该出现的那种）直接不理，disabled 之外再兜一层
      if (isSpecialTower(type) && (state.mode !== 'endless' || state.wave < towerUnlockWave(type))) return;
      if (state.gold < def.cost[0]) return;   // 买不起：不选中
      state.selectedType = state.selectedType === type ? null : type;
      clearTowerSelect();
      syncTowerButtons();
    });
  });

  // 技能栏：**唯一**一个 click 监听器（挂在容器上做事件委托，按钮由 buildSkillBar 现生成）
  if (ui.skills) ui.skills.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.td-skill-btn') : null;
    if (!btn || btn.disabled) return;   // 未解锁 / 冷却中 / 金币不足：disabled 已经拦了，这里再兜一层
    castSkill(btn.dataset.skill);
  });
  // 右键取消陨石选点：只在选点态下拦浏览器菜单，平时不动画布的默认行为
  ui.canvas.addEventListener('contextmenu', (ev) => {
    if (!state.casting) return;
    ev.preventDefault();
    cancelCasting();
  });

  // 场上塔清单（排在塔栏下方，可折叠）：summary 上的数量由 renderTowerList 实时更新；
  // 这里只补「重新展开时整表重画一次」——折叠期间主体跳过重绘（见 renderTowerList），
  // 展开时签名已被作废，这里强制重画，等于自愈一次（与塔数值表的 toggle 做法一致）。
  if (ui.tInfo) ui.tInfo.addEventListener('toggle', () => {
    if (ui.tInfo.open) { tListSig = ''; renderTowerList(); }
  });
  // 场上塔清单：**唯一**一个 click 监听器，挂在容器上做事件委托（行/按钮用 data-* 分派）。
  // 清单每次重画只换 innerHTML，这里不再重绑，塔再多也不会累积监听器。
  if (ui.tInfo) ui.tInfo.addEventListener('click', onTowerListClick);
  // 塔数值表自愈：展开时若还是空壳就重建一次（boot 时机 / 缓存导致首次为空都能恢复）
  if (ui.towerStats) ui.towerStats.addEventListener('toggle', () => {
    if (ui.towerStats.open && ui.towerStatsBody && !ui.towerStatsBody.firstChild) {
      console.warn('[tower-defense] 塔数值表展开时为空，重建一次');
      buildTowerStats();
    }
  });
  ui.btnPause.addEventListener('click', togglePause);
  // 倍速：按 SPEED_LEVELS 循环（1→2→3→4→1）。文案就是当前倍速；is-on 表示「已加速」，
  // 与原来 2x 时点亮的观感一致（不新增指示器，外观风格不变）。上限 4x 的算术见 SPEED_LEVELS 注释。
  ui.btnSpeed.title = '点击切换倍速（最高 4x）';
  ui.btnSpeed.addEventListener('click', () => {
    const i = SPEED_LEVELS.indexOf(state.speed);
    state.speed = SPEED_LEVELS[(i + 1) % SPEED_LEVELS.length];   // i = -1（异常值）时回到 1x
    ui.btnSpeed.textContent = state.speed + 'x';
    ui.btnSpeed.classList.toggle('is-on', state.speed > 1);
  });
  ui.btnRestart.addEventListener('click', restart);
  // 「快速升级」：把建造顺序上第一个未满级的塔升一级——扣钱/升级/累加 spend/落盘全在 upgradeTower 里
  if (ui.btnQuickUp) ui.btnQuickUp.addEventListener('click', () => {
    const target = quickUpgradeTarget();   // 与按钮状态同源：不能再各算一遍
    if (!target || !target.canAfford) return;
    upgradeTower(target.tower);            // 被拒（满级 / 未解锁 / 钱不够）时它自己会提示
    syncHud();                             // 金币 / 清单 / 按钮上的价格立即刷新
  });
  // 「批量升级」：先算整份计划 → 一次扣款 → 逐座 +1 级（只扣一次钱、只落一次盘，见 applyBatchUpgrade）。
  // 计划为空（没塔 / 全满级 / Lv.3 未解锁 / 连第一座都买不起）时直接返回，不提示也不扣钱。
  if (ui.btnBatchUp) ui.btnBatchUp.addEventListener('click', () => {
    const plan = planBatchUpgrade(state.towers, state.gold, clampBatchCountInput(), canUpgradeBeyond3());
    if (!plan.canDo) return;
    applyBatchUpgrade(plan);
    syncHud();                             // 金币 / 场上塔清单 / 合计价立即刷新
  });
  // 座数输入框：input 时只重算按钮（取值一律走 batchCount 的夹取，所以 999 也只算 100 座），
  // change / blur 再把框里那个越界的数字就地改成夹好的值，不打断中间的正常输入。
  if (ui.batchCount) {
    ui.batchCount.addEventListener('input', () => syncBatchUpgrade());
    ui.batchCount.addEventListener('change', () => { clampBatchCountInput(); syncBatchUpgrade(); });
    ui.batchCount.addEventListener('blur', () => { clampBatchCountInput(); syncBatchUpgrade(); });
  }
  // 「一键超频」：先算整份计划 → 一次扣款 → 逐座按 50% 判定（只扣一次钱、只落一次盘，见 applyBatchOverclock）
  if (ui.btnBatchOc) ui.btnBatchOc.addEventListener('click', () => {
    const plan = planBatchOverclock(state.towers, state.gold, clampOcCountInput());
    if (!plan.canDo) return;               // 没塔 / 全部已超频 / 连第一座都买不起：不提示也不扣钱
    applyBatchOverclock(plan);             // 结果由 showOverclockResult 弹窗告知
    syncHud();                             // 金币 / 清单 / 按钮合计价立即刷新
  });
  if (ui.ocCount) {
    ui.ocCount.addEventListener('input', () => syncBatchOverclock());
    ui.ocCount.addEventListener('change', () => { clampOcCountInput(); syncBatchOverclock(); });
    ui.ocCount.addEventListener('blur', () => { clampOcCountInput(); syncBatchOverclock(); });
  }
  ui.btnAgain.addEventListener('click', restart);

  // 无尽「继续上次 / 重新开始」：重新开始 = 丢掉旧记录走 restart（restart 会 clearEndlessRun）
  if (ui.btnResume) ui.btnResume.addEventListener('click', resumeEndlessRun);
  if (ui.btnResumeFresh) ui.btnResumeFresh.addEventListener('click', restart);

  // 导出：存档码写进只读 textarea 并全选（一键 Ctrl+C）；下载走 Blob + createObjectURL
  if (ui.btnExportCode) ui.btnExportCode.addEventListener('click', () => {
    if (ui.saveOut) { ui.saveOut.value = encodeSave(progress); ui.saveOut.focus(); ui.saveOut.select(); }
    saveMsg('存档码已生成，已全选：Ctrl+C / ⌘+C 复制', false);
  });
  if (ui.btnExportFile) ui.btnExportFile.addEventListener('click', () => {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(progress, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'mlttc-td-save.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      saveMsg('已下载 mlttc-td-save.json', false);
    } catch (err) { saveMsg('下载失败：' + (err && err.message ? err.message : '浏览器不支持'), true); }
  });
  // 导入：存档码粘贴框 + 文件选择，两条路都收敛到 applyImport → 同一份字段校验与合并策略
  if (ui.btnImportCode) ui.btnImportCode.addEventListener('click', () => applyImport(ui.saveIn ? ui.saveIn.value : ''));
  if (ui.saveFile) ui.saveFile.addEventListener('change', () => {
    const f = ui.saveFile.files && ui.saveFile.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { applyImport(String(reader.result || '')); ui.saveFile.value = ''; };
    reader.onerror = () => saveMsg('文件读取失败', true);
    reader.readAsText(f);
  });

  // 通关浮层：下一关 / 回关卡列表（列表点完会重建网格，解锁状态立刻可见）
  ui.btnNext.addEventListener('click', () => {
    const next = state.level ? state.level.level + 1 : 0;
    if (next >= 1 && next <= LEVEL_MAX) startLevel(next);
  });
  ui.btnList.addEventListener('click', backToList);
  ui.btnBack.addEventListener('click', backToList);   // 对局中的「关卡列表」：退出不判失败

  // 模式切换 + 关卡网格（网格用事件委托：100 个按钮不挂 100 个监听）
  ui.btnModeEndless.addEventListener('click', () => setMode('endless'));
  ui.btnModeLevel.addEventListener('click', () => setMode('level'));
  ui.levelGrid.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.td-lv') : null;
    if (!btn || btn.disabled) return;   // 未解锁：按钮本身 disabled，这里再兜一层
    startLevel(Number(btn.dataset.level));
  });

  // 键盘：空格暂停、1~4 选基础塔（5~7 是特殊塔，未解锁时点不动）、Esc 先收陨石选点再收面板
  document.addEventListener('keydown', (ev) => {
    if (ev.key === ' ') { ev.preventDefault(); togglePause(); }
    else if (ev.key === 'Escape') { cancelCasting(); clearTowerSelect(); }
    else if (ev.key >= '1' && ev.key <= '7') { const b = ui.towerBtns[Number(ev.key) - 1]; if (b && !b.hidden) b.click(); }
  });

  // 页面隐藏 → 停止累积；回到前台 → 重排时间基准，避免一次补出几十步
  document.addEventListener('visibilitychange', () => {
    state.hidden = document.hidden;
    lastTs = 0;
    acc = 0;
  });

  // 主题切换（auth-header.js 改的是 html[data-theme]）→ 重读调色板
  new MutationObserver(readPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // 减少动效偏好变化时实时生效
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  state.reducedMotion = mq.matches;
  if (mq.addEventListener) mq.addEventListener('change', (e) => { state.reducedMotion = e.matches; });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setupCanvas, 150);
  });
}

/** 取 DOM 引用并开局 */
function boot() {
  const byId = (id) => document.getElementById(id);
  ui.canvas = byId('tdCanvas');
  ui.stage = byId('tdStage');
  if (!ui.canvas || !ui.stage) return;   // 不在塔防页面：静默退出
  draw.canvas = ui.canvas;
  draw.ctx = ui.canvas.getContext('2d');
  ui.wave = byId('tdWave'); ui.lives = byId('tdLives'); ui.gold = byId('tdGold');
  ui.kills = byId('tdKills'); ui.alive = byId('tdAlive'); ui.best = byId('tdBest');
  // 场上塔清单（塔栏下方，details 可折叠：每座塔一行，升级 / 删除都在行内）
  ui.tInfo = byId('tdTowerInfo'); ui.towerList = byId('tdTowerList');
  ui.towerSummary = byId('tdTowerInfoSummary');
  // BOSS 信息栏（紧跟场上塔清单下面）：容器 / 列表 / 总只数 / 「另有 N 只」小字
  ui.bossBar = byId('tdBossBar'); ui.bossList = byId('tdBossList');
  ui.bossCount = byId('tdBossCount'); ui.bossMore = byId('tdBossMore');
  ui.overlay = byId('tdOverlay'); ui.overWave = byId('tdOverWave'); ui.overBest = byId('tdOverBest');
  ui.overTitle = byId('tdOverTitle'); ui.overSub = byId('tdOverSub');
  ui.btnAgain = byId('tdBtnAgain'); ui.btnNext = byId('tdBtnNext'); ui.btnList = byId('tdBtnList');
  ui.btnPause = byId('tdPause');
  ui.btnQuickUp = byId('tdQuickUpgrade');   // 「快速升级」（在 .td-controls 里，跟着 .td-bar 一起显隐）
  ui.btnBatchUp = byId('tdBatchUpgrade');   // 「批量升级」（同上，另加「只在无尽模式」一道闸，见 syncView）
  ui.batchCount = byId('tdBatchCount');     // 批量升级的座数输入框（1..100，夹取见 batchCount）
  // 整组 = 包着输入框的 <label class="td-batch">：它自己带 display:inline-flex，hidden 要靠 CSS 让位
  ui.batchBox = ui.batchCount && ui.batchCount.closest ? ui.batchCount.closest('.td-batch') : null;
  ui.btnBatchOc = byId('tdBatchOcBtn');     // 「一键超频」（1~20 座，只在无尽模式出现，见 syncView）
  ui.ocCount = byId('tdBatchOcCount');      // 一键超频的座数输入框（1..20，夹取见 ocCount）
  ui.ocBox = ui.ocCount && ui.ocCount.closest ? ui.ocCount.closest('.td-batch') : null;
  ui.btnSpeed = byId('tdSpeed'); ui.btnRestart = byId('tdRestart'); ui.btnBack = byId('tdBack');
  ui.hud = byId('tdHud'); ui.bar = byId('tdBar'); ui.hint = byId('tdHint');
  // 下一波预告条（HUD 下方一条）：文案 / 色调 / 词缀全部由 syncNextWavePreview 写
  ui.nextWave = byId('tdNext'); ui.nextText = byId('tdNextText'); ui.nextAffix = byId('tdNextAffix');
  ui.levels = byId('tdLevels'); ui.levelGrid = byId('tdLevelGrid'); ui.levelsProg = byId('tdLevelsProg');
  ui.btnModeEndless = byId('tdModeEndless'); ui.btnModeLevel = byId('tdModeLevel');
  ui.modeBadge = byId('tdMode');
  // 特殊塔按钮 / 技能按钮都是「按数据现生成」——放在取 ui.towerBtns 之前，顺序不能换
  ui.towers = byId('tdTowers');
  ui.skills = byId('tdSkills');
  buildSpecialTowerBar();
  buildSkillBar();
  ui.towerBtns = Array.prototype.slice.call(document.querySelectorAll('.td-tower-btn'));
  for (const b of ui.towerBtns) if (!b.dataset.baseTitle) b.dataset.baseTitle = b.title;   // 解锁后要还原作者写的 title
  // 塔数值表容器 + 存档面板 + 无尽「继续上次」条
  ui.towerStats = byId('tdTowerStats');
  ui.towerStatsBody = byId('tdTowerStatsBody'); ui.resumeBar = byId('tdResumeBar');
  ui.btnResume = byId('tdBtnResume'); ui.btnResumeFresh = byId('tdBtnResumeFresh');
  ui.saveOut = byId('tdSaveOut'); ui.saveIn = byId('tdSaveIn'); ui.saveFile = byId('tdSaveFile');
  ui.saveMsg = byId('tdSaveMsg'); ui.btnExportCode = byId('tdBtnExportCode');
  ui.btnExportFile = byId('tdBtnExportFile'); ui.btnImportCode = byId('tdBtnImportCode');

  progress = loadProgress();             // 读档失败内部已回落默认值，boot 不会因此中断
  state.mode = 'endless'; state.level = null; state.inRun = true;
  readPalette();
  resetGame();
  setupCanvas();
  bindEvents();
  buildTowerStats();                     // 塔数值表由 TOWER_TYPES 现生成（数据只有一份）
  maybeAwaitResume();                    // 有 7 天内的无尽进度就先停在「继续 / 重新开始」
  syncView();
  syncTowerButtons();
  syncHud();

  // 控制台调试入口（手工核对波次曲线、快速加钱）
  window.tdGame = {
    snapshot: () => ({
      mode: state.mode, level: state.level ? state.level.level : 0,
      wave: state.wave, lives: state.lives, gold: state.gold, kills: state.kills, best: state.best,
      enemies: state.enemies.length, towers: state.towers.length, mapIdx: state.mapIdx,
      waveActive: state.waveActive, gameOver: state.gameOver, speed: state.speed,
    }),
    wave: (n) => generateEndlessWave(n, state.seed),   // 原始曲线（不含前 5 波赏金加成，调参用）
    preview: () => nextWavePreview(state),   // 下一波预告（与预告条同一份纯函数，调参 / 断言用）
    affix: () => (state.waveAffix ? {
      id: state.waveAffix.id, name: state.waveAffix.name, flags: state.waveFlags,
    } : null),   // 本波词缀（第 5 / 10 / 15… 波才有）
    level: (n) => generateLevel(n),
    levelWave: (l, n) => buildLevelWave(generateLevel(l), n),
    levelTotal: levelTotalEnemies,
    progress: () => JSON.parse(JSON.stringify(progress)),
    saveCode: () => encodeSave(progress),
    importSave: applyImport,
    startLevel, backToList, setMode,
    addGold: (n) => { state.gold += n; },
    skipWait: () => { state.nextWaveIn = 0; },
    cast: castSkill,   // 技能调试：cast('meteor') 进选点态、cast('purge') 直接清场
    skills: () => SKILLS.map((s) => ({ id: s.id, readyAt: state.skillReady[s.id] || 0, state: skillState(s.id).reason || 'ok' })),
    skillTimers: () => ({
      timeMs: state.timeMs, stopUntil: state.stopUntil, overloadUntil: state.overloadUntil, fatigueUntil: state.fatigueUntil,
      bountyUntil: state.bountyUntil, bountyMul: state.bountyMul, resonanceUntil: state.resonanceUntil,
      shield: state.shield ? { hits: state.shield.hits, until: state.shield.until } : null,
    }),
    restart,
  };
  requestAnimationFrame(frame);
}

// 只在浏览器里启动：Node 下 import 本模块只拿到纯函数，不会碰 DOM
//
// 启动失败必须"可见且可自愈"，不能白屏——这就是 2026-11 那次「游戏完全无法运行」的成因：
// 站点的浏览器缓存把 .js 缓存了 4 小时（详见 _headers 里的说明），于是出现
// 「新 HTML + 旧 JS」的错配：旧 JS 去找已被删除的元素，boot 中途抛错，
// 画布从此一帧都没画过，而界面上看起来只是"空白"。
// 这里做两件事：
//   1. 捕捉启动异常并解释给用户（而不是让他对着一块空白画布猜）；
//   2. 自动用带时间戳的 URL 重载一次（新 URL 必然绕过缓存），把用户从错配里救出来；
//      只在本次会话里试一次，避免缓存真的坏了时无限刷新。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    boot();
  } catch (err) {
    console.error('[tower-defense] 启动失败：', err);
    const KEY = 'mlttc-td-reloaded';
    let tried = false;
    try {
      tried = sessionStorage.getItem(KEY) === '1';
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* 隐私模式下无法去重，宁可只提示不重载 */
      tried = true;
    }

    const box = document.getElementById('tdCanvas');
    if (box && box.parentElement) {
      box.parentElement.innerHTML =
        '<div style="padding:24px;text-align:center;line-height:1.7">' +
        '<p><b>游戏启动失败</b></p>' +
        '<p style="opacity:.75;font-size:.9rem">多半是浏览器缓存了旧版脚本。' +
        (tried ? '请按 Ctrl+Shift+R 强制刷新。' : '正在自动重新加载…') +
        '</p></div>';
    }

    if (!tried) {
      const url = new URL(location.href);
      url.searchParams.set('v', String(Date.now()));
      setTimeout(() => location.replace(url.toString()), 600);
    }
  }
}
