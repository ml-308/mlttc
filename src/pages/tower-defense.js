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
 *   towers[]   { type, lv, col, row, x, y, cd, rateBuff, dmgBuff, spend }
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
  SKILLS, CHILL, METEOR, REPAIR, TIMESTOP, OVERLOAD,
  getSkill, canCast, cooldownLeft, meteorHits, purgeHits, applyChillTo, tickStatus,
} from './td-skills.js';
import {
  SPECIAL_TOWER_TYPES, SPECIAL_TOWER_IDS, isSpecialTower, specialTowersUnlockedAt,
  towerUnlockWave, chainDamage, pickChainTargets, poisonTick, pushDistance, applyPush,
} from './td-special-towers.js';

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
const HIGH_LV_DMG_STEP = 1.12;        // 每级伤害 ×1.12
const HIGH_LV_RATE_STEP = 0.015;      // 每级攻速 +1.5%（相对 Lv.3），累计上限 +100%
const HIGH_LV_RANGE_STEP = 0.6;       // 每级射程 +0.6，累计上限 +50
const HIGH_LV_COST_STEP = 1.35;       // 升级价每级 ×1.35（以 Lv.3 的升级价为基点）

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
 *  · 高波次叠乘 LATE_HP_STEP^(n-LATE_HP_FROM)（见下面的常量注释）：1.06 单层在高波次
 *    偏软，第 30 波之后再加一层更陡的增长，让「无尽后期明显更硬」。
 */

/**
 * 无尽高波次叠乘血量。设计取舍（为什么是这两个数）：
 *  · 为什么从第 30 波起：**闯关模式每关最多 28 波**（waves = 4 + floor(L×0.24)，L100 → 28），
 *    而闯关的血量基数也走 generateEndlessWave —— 阈值 ≥ 30（= LATE_HP_FROM ≥ 30，自检第 14.4
 *    条钉住这条硬门槛）才能保证这一层**完全不进入闯关**，闯关平衡一点不动。
 *  · 为什么选 1.025：与 1.06 叠成每波 ×1.0865（约 8.4 波翻倍，原来约 12 波）——足够让
 *    高波次明显更硬，又不至于把「能不能推到 100 波」直接判死：第 100 波 lateHpMul = 1.025^70 ≈ 5.6。
 *    再陡（1.04+）会和 BOSS 的 ×8 叠成墙，高波次变成纯看脸。
 *  · n ≤ LATE_HP_FROM 时 lateHpMul 严格等于 1（不是 ≈1、也不参与取整），第 1~30 波的
 *    每次取整结果都与改动前完全一致。
 */
const LATE_HP_FROM = 30;      // 第 30 波起额外加血（必须 ≥ 30，见上面「闯关最多 28 波」）
const LATE_HP_STEP = 1.025;   // 每多一波，血量再 ×1.025（叠在 1.06 之上）

/**
 * 血量的有限上限。
 *
 * 无尽模式的波次本身没有上限，但血量是「1.06^(n-1) × 1.025^(n-30)」的指数叠乘：
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

/** 路径进度 dist 处的像素坐标（越界自动夹到两端） */
function pointAt(path, dist) {
  const segs = path.segs;
  if (!segs.length) return { x: 0, y: 0 };
  const d = dist < 0 ? 0 : dist > path.length ? path.length : dist;
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
  mergeProgress,   // 导入合并（自检断言「导入的无尽进度必须胜出」，防止退回「谁新留谁」）
  towerStatRows,   // 塔数值表的行 HTML（纯函数：自检断言「并进特殊塔后不出现 NaN / undefined」）
  towerStat,       // 某塔某等级的实际数值（Lv.1~3 读数组、Lv.4+ 现算外推：战斗 / 清单 / 快速升级同源）
  MAX_TOWER_LEVEL, HIGH_LV_UNLOCK_WAVE,   // 等级上限 + 高等级解锁波次（自检按常量取，不写死 3）
  LATE_HP_FROM, LATE_HP_STEP, SPEED_LEVELS, HP_CEIL,   // 高波次叠乘阈值/斜率 + 倍速档位（自检直接断言）
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
  paused: false, hidden: false, speed: 1, gameOver: false, timeMs: 0,
  awaitingResume: false, resumeDone: false,   // 等玩家选「继续/重开」时主循环不推进（见 frame）
  selectedType: null, selectedTower: null, hover: { col: -1, row: -1 }, reducedMotion: false,
  enemies: [], towers: [], bullets: [], particles: [], floaters: [],
  mapIdx: 0, path: null, pathTiles: null,
  // 技能时序全部以 state.timeMs（逻辑步累计）为基准：暂停 / 隐藏 / 等续玩时 step() 不跑，
  // 冷却与持续时间一起冻结。skillReady 只活在内存里，不进存档（存档结构一个字段都不加）。
  skillReady: {},        // 技能 id → 可再次释放的逻辑毫秒
  casting: null,         // 选点态：正在选落点的技能 id（目前只有 meteor）
  aim: null,             // 选点预览落点（画布逻辑坐标 768×448）
  stopUntil: 0,          // 时停到期时刻
  overloadUntil: 0,      // 超载到期时刻
  fatigueUntil: 0,       // 疲劳到期时刻（= overloadUntil + fatigueMs）
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
    towers.push({ type: t.type, col, row, lvl });
  }
  return { wave, gold, lives, kills, seed, towers, savedAt };
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
  state.paused = false; state.speed = 1; state.gameOver = false; state.result = ''; state.timeMs = 0;
  // 技能时序跟着本局清零：冷却不进存档（存档结构一个字段都不加），重开就是全新的一局
  state.skillReady = {}; state.casting = null; state.aim = null; state.stopUntil = 0;
  state.overloadUntil = 0; state.fatigueUntil = 0;
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

/** 开始第 n 波：无尽模式现算标准波，闯关模式在标准波上乘关卡系数 */
function startWave() {
  state.wave += 1;
  const wave = state.mode === 'level'
    ? buildLevelWave(state.level, state.wave)
    : generateEndlessWave(state.wave, state.seed);
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
  progress.endlessRun = {
    wave: state.wave, gold: state.gold, lives: state.lives, kills: state.kills, seed: state.seed, savedAt: Date.now(),
    towers: state.towers.map((t) => ({ type: t.type, col: t.col, row: t.row, lvl: t.lv })),
  };
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
    id: nextEnemyId++,                  // 唯一 id：链式闪电用它排除已电过的目标
    slowUntil: 0, slowFactor: 0, hitFlash: 0, dead: false,
    // 技能状态字段（td-skills 的约定）：前三个是剩余毫秒，由 tickStatus 递减；poisonDps 是每秒毒伤
    chillMs: 0, stopMs: 0, poisonMs: 0, poisonDps: 0,
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
    if (e.dead) { arr[i] = arr[arr.length - 1]; arr.pop(); continue; }
    // 中毒：先把「本步剩余时间内的那一段」结算掉（无视护甲，见 poisonDamage），再统一递减计时
    if (e.poisonMs > 0) {
      poisonDamage(e, poisonTick(e.poisonMs, e.poisonDps, dtMs));
      if (e.dead) { arr[i] = arr[arr.length - 1]; arr.pop(); continue; }
    }
    tickStatus(e, dtMs);   // chillMs / stopMs / poisonMs 一起递减；slowUntil / stopUntil 是绝对时刻，由主循环比较
    if (!frozen) {
      // 减速只有一个乘数（slowFactor 取「最强的那个」，寒流与冰塔谁强谁生效，绝不叠乘）
      const slowed = state.timeMs < e.slowUntil;
      e.dist += (slowed ? e.speed * (1 - e.slowFactor) : e.speed) * dt;
    }
    if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
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

/** 漏怪：扣 1 点生命 */
function leak() {
  state.lives -= 1;
  addFloater(VIEW.w - 46, VIEW.h / 2, -1, palette.danger);
  if (state.lives <= 0) { state.lives = 0; gameOver(); }
}

/** 击杀结算（赏金 / 击杀数 / 粒子）：damageEnemy 与无视护甲的毒伤共用，保证两条伤害路径记同一本账 */
function killEnemy(enemy) {
  enemy.hp = 0;
  enemy.dead = true;
  state.gold += enemy.bounty;
  state.kills += 1;
  addParticles(enemy.x, enemy.y, 7, ENEMY_COLORS[enemy.type] || '#999');
}

/** 伤害结算：真实伤害 = dmg × (1 - armor)；击杀给赏金（bounty 已在波次里算好倍率） */
function damageEnemy(enemy, dmg) {
  if (enemy.dead) return;
  const real = dmg * (1 - enemy.armor);
  enemy.hp -= real;
  enemy.hitFlash = 1;
  addFloater(enemy.x, enemy.y - 8, Math.round(real), null);
  if (enemy.hp <= 0) killEnemy(enemy);
}

/**
 * 毒伤结算：**故意不走 damageEnemy** —— 那里会乘 (1 - armor)，而毒塔的唯一卖点就是「无视护甲」
 * （见 td-special-towers 里 dmg 写 0 / ignoreArmor 的说明：伤害 100% 来自 dot）。
 * 这里也不打伤害飘字：dot 每个逻辑步都在跳，逐帧飘字会把画面刷成一片数字，掉血由血条体现。
 */
function poisonDamage(enemy, dmg) {
  if (!enemy || enemy.dead || !(dmg > 0)) return;
  enemy.hp -= dmg;
  enemy.hitFlash = 1;
  if (enemy.hp <= 0) killEnemy(enemy);
}

/* ===================== 7. 塔与战斗 ===================== */
/**
 * 某座塔某个等级的实际数值（纯函数：只读塔表，不碰 state / DOM）—— 战斗、清单、快速升级共用这一份。
 * 塔表里的 cost / dmg / rate / range / auraRate / auraDmg / splash / slow / slowMs / poison.dps /
 * push.tiles **只存 Lv.1~3**，Lv.4~MAX_TOWER_LEVEL 全部按 k = lv - 3 从 Lv.3 外推，并各自封顶
 * （攻速 ×2 / 溅射 +40 / 减速 80% / 光环 +100% / 推回 +50%），所以高等级不会指数爆炸。
 * 返回字段（都是有限数值，缺的补 0，调用方不必再判空）：
 *   dmg / rate / range / auraRate / auraDmg / splash / slow / slowMs / poisonDps / pushTiles（单位：格）/
 *   upgradeCost = **升到下一级**的价格（与既有语义一致：Lv.1→cost[1]、Lv.2→cost[2]、
 *   Lv.3→cost[2]×1.35、Lv.L→cost[2]×1.35^(L-2)；满级 0）。
 */
function towerStat(type, lv) {
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
    upgradeCost: L >= MAX_TOWER_LEVEL ? 0
      : (L < 3 ? num(d.cost[L]) : Math.round(d.cost[2] * Math.pow(HIGH_LV_COST_STEP, L - 2))),
  };
  if (k === 0) return st;                  // Lv.1~3：原样返回
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
  return st;
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
  if (state.gold < cost || !isBuildable(state, col, row) || towerAt(state, col, row)) return false;
  state.gold -= cost;
  state.towers.push({
    type, lv: 1, col, row,
    x: (col + 0.5) * GRID.tile, y: (row + 0.5) * GRID.tile,
    cd: 0,        // 冷却剩余秒数
    rateBuff: 0,  // 光环给的攻速增幅
    dmgBuff: 0,   // 光环给的伤害增幅
    spend: cost,  // 历史总投入（升级累加）
  });
  addParticles((col + 0.5) * GRID.tile, (row + 0.5) * GRID.tile, 6, def.color);
  noteEndlessRun();   // 建塔后落盘：关标签页也不会丢刚布好的阵
  return true;
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
  return true;
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
    const st = towerStat(t.type, lv);
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
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const def = t ? ALL_TOWER_TYPES[t.type] : null;
    const lv = def ? Math.floor(Number(t.lv) || 0) : 0;
    if (lv < 1 || lv >= MAX_TOWER_LEVEL) continue;   // 满级 / 等级异常：跳过，继续找下一座
    if (lv >= 3 && !unlocked) continue;               // Lv.4+ 未解锁：Lv.3 也算到顶
    const cost = towerStat(t.type, lv).upgradeCost;
    if (!(cost > 0)) continue;
    return { index: i, tower: t, type: t.type, name: def.name, lv, nextLv: lv + 1, cost, canAfford: g >= cost };
  }
  return null;
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
  for (let i = 0; i < towers.length; i++) { towers[i].rateBuff = 0; towers[i].dmgBuff = 0; }
  for (let i = 0; i < towers.length; i++) {
    const a = towers[i];
    if (a.type !== 'aura') continue;
    const astat = towerStat('aura', a.lv);
    const range = astat.range, rate = astat.auraRate, dmg = astat.auraDmg;
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
  const now = state.timeMs;
  const overloaded = now < state.overloadUntil;
  const fatigued = !overloaded && now < state.fatigueUntil;   // 疲劳排在爆发之后，两者不重叠
  const rateMul = overloaded ? 1 + OVERLOAD.rateBonus : (fatigued ? 1 + OVERLOAD.fatigueRate : 1);
  const dmgMul = overloaded ? 1 + OVERLOAD.dmgBonus : 1;
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    if (t.type === 'aura') continue;               // 光环塔本身不攻击
    t.cd -= dt * (1 + t.rateBuff) * rateMul;
    if (t.cd > 0) continue;
    const st = towerStat(t.type, t.lv);   // 伤害 / 射程 / 攻速 / 溅射 / 减速全部现算（Lv.4+ 走外推）
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
  b.lv = tower.lv;       // 毒的 dot dps 按等级取 towerStat('poison', lv).poisonDps（Lv.4+ 跟着涨）
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

/**
 * 力场推回的像素距离：Lv.1~3 仍走 td-special-towers 的 pushDistance（口径不变），
 * Lv.4+ 用 towerStat 外推的格数 + 同一条公式（格 × 32 × BOSS 减半）。
 */
function forcePushPx(lv, isBoss) {
  if (lv <= 3) return pushDistance('force', lv, isBoss);
  const p = ALL_TOWER_TYPES.force.push;
  const half = isBoss && p && p.bossHalf ? 0.5 : 1;
  return towerStat('force', lv).pushTiles * GRID.tile * half;
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
    const dps = towerStat('poison', b.lv).poisonDps;
    if (dps > 0) { target.poisonMs = ALL_TOWER_TYPES.poison.poison.durationMs; target.poisonDps = dps; }
    addParticles(b.x, b.y, 3, b.color);
    return;
  }
  damageEnemy(target, b.dmg);
  if (b.type === 'tesla') chainShock(b, target);   // 链式闪电：命中后额外跳 3 个目标
  if (b.type === 'force' && !target.dead) {
    // 力场：沿路径推回（dist 减小、不小于 0；BOSS 减半由 pushDistance 处理），坐标立刻回写免得看着像穿墙
    target.dist = applyPush(target.dist, forcePushPx(b.lv, target.type === 'boss'));
    const pt = pointAt(state.path, target.dist);
    target.x = pt.x; target.y = pt.y;
  }
  if (b.slow > 0 && !target.dead) {
    // 「最近一次有效」：新的一发直接覆盖当前减速（不叠乘、不取最强）
    target.slowUntil = state.timeMs + b.slowMs;
    target.slowFactor = b.slow;
  }
  addParticles(b.x, b.y, 3, b.color);
}

/**
 * 特斯拉链式闪电：命中后挑 count 个目标（pickChainTargets 按 e.id 排除、按 dist 排序，观感是往终点
 * 方向跳），每跳按 chainDamage 衰减（34 → 27 → 22 → 17，跳数从 2 起算 = 主目标吃满伤）。
 * 链上的伤害走 damageEnemy：与普通攻击同一套护甲减免，不另开无视护甲的路。
 */
function chainShock(b, first) {
  const def = ALL_TOWER_TYPES.tesla;
  const alive = state.enemies.filter((e) => !e.dead);
  const hops = pickChainTargets(alive, { x: b.x, y: b.y }, def.chain.count, towerStat('tesla', b.lv).range, [first.id]);
  for (let i = 0; i < hops.length; i++) {
    if (hops[i].dead) continue;
    damageEnemy(hops[i], chainDamage(b.dmg, i + 2, def.chain.falloff));
    addParticles(hops[i].x, hops[i].y, 3, def.color);
  }
}

/* ===================== 8. 特效（飘字 / 粒子） ===================== */
/**
 * 飘字：reduce 动效时改为静态显示（不上飘、不淡出），信息不丢。
 * lifeSec 可省略（默认 0.7s）—— 技能 / 解锁提示要停留久一点才读得完，所以开了这个口子。
 */
function addFloater(x, y, value, color, lifeSec) {
  if (state.floaters.length > 60) state.floaters.shift();
  const life = Number.isFinite(lifeSec) && lifeSec > 0 ? lifeSec : 0.7;
  state.floaters.push({
    x, y, text: String(value),
    color: color || (value > 0 ? palette.text : palette.danger),
    life, max: life,
  });
}

/** 命中粒子：reduce 动效时干脆不生成（不画＝最彻底的「关掉位移」） */
function addParticles(x, y, count, color) {
  if (state.reducedMotion) return;
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
/** 技能当前状态：解锁 / 冷却 / 金币三条判定交给模块的 canCast（它的 reason 就是文案依据） */
function skillState(id) {
  const skill = getSkill(id);
  const now = state.timeMs;
  const readyAt = Number.isFinite(state.skillReady[id]) ? state.skillReady[id] : 0;   // 没放过 = 0
  const left = cooldownLeft(skill, readyAt, now);
  const chk = canCast(skill, { wave: state.wave, gold: state.gold, readyAt, now });
  return { skill, ok: chk.ok && state.mode === 'endless', reason: chk.reason, left, now };
}

/** 扣金币 + 写冷却（只在效果真正生效后调：失败路径一分钱都不动） */
function payForSkill(skill) {
  state.gold -= skill.cost; state.skillReady[skill.id] = state.timeMs + skill.cooldownMs; syncHud();
}
/** 取消选点态（Esc / 右键 / 点到画布外）：还没扣钱，什么都不用回滚 */
function cancelCasting() {
  if (state.casting) { state.casting = null; syncHud(); }
}

/** 施放技能。陨石两段式：先进选点态（不扣钱），落点确认时才扣钱进冷却 —— 点错了取消也不亏。 */
function castSkill(id) {
  if (state.mode !== 'endless' || state.gameOver || !state.inRun) return false;
  const st = skillState(id);
  if (!st.ok) return false;
  if (id === 'meteor') {   // 选点态（再点一次 = 取消），此时一分钱都没扣
    state.casting = state.casting === 'meteor' ? null : 'meteor';
    if (state.casting && !state.aim) state.aim = { x: VIEW.w / 2, y: VIEW.h / 2 };
    syncHud();
    return true;
  }
  if (id === 'chill') {
    // 只有比当前生效的更强才覆盖（模块内的取更强逻辑），所以寒流与冰塔不叠乘
    const n = applyChillTo(state.enemies, st.now, CHILL.slow, CHILL.durationMs);
    addFloater(VIEW.w / 2, 44, '寒流 ×' + n, '#4CC9F0', 1.4);
  } else if (id === 'repair') {
    const before = state.lives;
    state.lives = Math.min(BALANCE.startLives, state.lives + REPAIR.lives);   // 封顶 20：不能靠技能刷无限生命
    addFloater(VIEW.w - 46, VIEW.h / 2 - 18, '+' + (state.lives - before), palette.primary, 1.4);
  } else if (id === 'timestop') {
    state.stopUntil = st.now + TIMESTOP.durationMs;   // 期间敌人不移动但仍可被攻击（见 updateEnemies）
  } else if (id === 'overload') {
    state.overloadUntil = st.now + OVERLOAD.durationMs;
    state.fatigueUntil = state.overloadUntil + OVERLOAD.fatigueMs;   // 爆发结束才轮到疲劳，两段不重叠
    addFloater(VIEW.w / 2, 44, '超载 ' + OVERLOAD.durationMs / 1000 + 's', palette.warning, 1.6);
  } else if (id === 'purge') {
    purgeEnemies();
  } else return false;
  payForSkill(st.skill);
  return true;
}

/** 陨石落点：meteorHits 取命中 → 逐一走**既有 damageEnemy**（因此受护甲减免）→ 最后才扣钱进冷却 */
function confirmMeteor(x, y) {
  const st = skillState('meteor');
  state.casting = null;
  if (!st.ok) { syncHud(); return false; }   // 选点期间金币被花光 / 技能已过期：什么都不做
  const hits = meteorHits(state.enemies, x, y, METEOR.radius);
  for (let i = 0; i < hits.length; i++) if (!hits[i].dead) damageEnemy(hits[i], METEOR.damage);
  addParticles(x, y, 10, '#F0643C');
  addFloater(x, y - 18, '陨石 ×' + hits.length, '#F0643C', 1.4);
  payForSkill(st.skill);
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
  }
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

/** 陨石选点预览：十字准星 + 落点半径圆圈（跟指针走；点了才扣钱，Esc / 右键取消） */
function drawAim(ctx) {
  const a = state.casting && state.aim;
  if (!a) return;
  ctx.fillStyle = 'rgba(240,100,60,.10)';
  ctx.beginPath(); ctx.arc(a.x, a.y, METEOR.radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#F0643C'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.arc(a.x, a.y, METEOR.radius, 0, Math.PI * 2); ctx.stroke();
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

/** 塔：底盘 + 图标 + 等级点；选中时画射程圈 */
function drawTowers(ctx) {
  const towers = state.towers;
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    const def = ALL_TOWER_TYPES[t.type];
    const on = state.selectedTower === t;
    if (on) {   // 选中：射程圈
      ctx.strokeStyle = def.color; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.arc(t.x, t.y, towerStat(t.type, t.lv).range, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = palette.card;
    ctx.beginPath(); ctx.arc(t.x, t.y, 13, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = def.color; ctx.lineWidth = on ? 3.5 : 2.5; ctx.stroke();
    drawTowerGlyph(ctx, t, def.color);
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
    if (pt) confirmMeteor(pt.x, pt.y); else cancelCasting();
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
      + r.col + ',' + r.row + ',' + r.upgradeCost + ',' + r.sellRefund + ',' + r.canUpgrade + ',' + r.maxed + r.locked;
  }
  return s;
}

/** 一行塔的 HTML：名称（塔色）+ 等级 + 伤害/攻速/射程 + 位置 + 升级/删除两个按钮 */
function towerRowHtml(r, active) {
  const st = towerStat(r.type, r.lv);   // 与战斗同源：光环增幅 / 毒伤 / 射程都现算
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
  return '<div class="td-ti-row' + (active ? ' is-active' : '') + '" data-tower-index="' + r.index + '"'
    + ' title="点击选中这座塔">'
    + '<span class="td-ti-name" style="color:' + r.color + '">' + r.name + '</span>'
    + '<span class="td-ti-lv">Lv.' + r.lv + '/' + r.maxLv + '</span>'
    + '<span class="td-ti-stats">' + stats.map((p) => '<span>' + p + '</span>').join('') + '</span>'
    + '<span class="td-ti-pos">(' + r.col + ', ' + r.row + ')</span>'
    + '<span class="td-ti-acts">'
    + '<button type="button" data-act="upgrade" data-tower-index="' + r.index + '"'
    + (r.canUpgrade ? '' : ' disabled') + ' title="' + upTitle + '">' + upText + '</button>'
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
 * 技能按钮三态：未解锁（「第 N 波」）/ 冷却中（「12s」）/ 可用（花费；金币不足则禁用）。签名只由
 * **显示出来的字**拼成，绝不把 state.timeMs 放进去 —— 否则每帧都是新签名、每帧写 DOM。
 */
function syncSkillButtons() {
  if (!ui.skillBtns || !ui.skillBtns.length) return;
  const endless = state.mode === 'endless';
  const rows = [];
  let sig = endless ? 'e' : 'l';
  for (const btn of ui.skillBtns) {
    const id = btn.dataset.skill, s = getSkill(id), st = skillState(id);
    const row = { info: '', off: true, cls: '', title: '' };
    if (!endless || state.wave < s.unlockWave) {
      row.cls = 'is-locked'; row.info = '第 ' + s.unlockWave + ' 波';
      row.title = s.name + '：第 ' + s.unlockWave + ' 波解锁（' + s.desc + '）';
    } else if (st.left > 0) {
      row.cls = 'is-cooling'; row.info = Math.ceil(st.left / 1000) + 's';
      row.title = s.name + '：冷却中，还剩 ' + Math.ceil(st.left / 1000) + ' 秒（' + s.desc + '）';
    } else if (state.gold < s.cost) {
      row.cls = 'is-poor'; row.info = String(s.cost);
      row.title = '金币不足：还差 ' + (s.cost - state.gold);
    } else {
      row.off = false; row.info = String(s.cost);
      row.title = s.desc + '（' + s.cost + ' 金币 · 冷却 ' + Math.round(s.cooldownMs / 1000) + 's）';
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
const hudCache = { wave: -1, lives: -1, gold: -1, kills: -1, alive: -1, best: -1 };

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
  syncQuickUpgrade();  // 同上：按钮三态由签名比较决定写不写
  syncSkillButtons();  // 技能栏三态同上（冷却秒数只反映到秒，不会每帧写）
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
  ui.btnNext.hidden = !(win && isLevel && lv.level < LEVEL_MAX);
  ui.btnList.hidden = !isLevel;
  ui.overlay.classList.add('show');
}

function hideOverlay() {
  if (ui.overlay) ui.overlay.classList.remove('show');
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
  return 'Lv.4–' + MAX_TOWER_LEVEL + '：' + parts.join('、') + '、升级价 ×1.35/级；第 '
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
  // 技能栏只在无尽模式：闯关模式没有「主动技能」这条玩法（解锁波次也是按无尽曲线定的）
  show(ui.skills, playing && state.mode === 'endless');
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
  if (!state.inRun || state.paused || state.hidden || state.gameOver || state.awaitingResume) {
    acc = 0;                                // 不在对局中（关卡列表）/ 等玩家选继续时彻底不推进逻辑
  } else {
    acc += dt * state.speed;              // 倍速只加快累积，不改渲染帧率
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
      step(STEP);
      acc -= STEP;
      steps += 1;
      if (state.gameOver) break;
    }
    if (steps >= MAX_STEPS_PER_FRAME) acc = 0;   // 追不上就丢弃欠账，绝不滚成雪球
  }
  if (state.inRun) { render(); syncHud(); }
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
  for (const t of run.towers) {
    const def = ALL_TOWER_TYPES[t.type];
    if (!def || !isBuildable(state, t.col, t.row) || towerAt(state, t.col, t.row)) { skipped += 1; continue; }
    state.towers.push({
      type: t.type, lv: t.lvl, col: t.col, row: t.row, x: (t.col + 0.5) * GRID.tile, y: (t.row + 0.5) * GRID.tile,
      cd: 0, rateBuff: 0, dmgBuff: 0, spend: def.cost.slice(0, t.lvl).reduce((s, c) => s + c, 0),  // 还原总投入，出售不亏
    });
  }
  if (skipped > 0) console.warn('[tower-defense] 续玩跳过 ' + skipped + ' 座非法塔位（越界/在路径上/重叠）');
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
  ui.overlay = byId('tdOverlay'); ui.overWave = byId('tdOverWave'); ui.overBest = byId('tdOverBest');
  ui.overTitle = byId('tdOverTitle'); ui.overSub = byId('tdOverSub');
  ui.btnAgain = byId('tdBtnAgain'); ui.btnNext = byId('tdBtnNext'); ui.btnList = byId('tdBtnList');
  ui.btnPause = byId('tdPause');
  ui.btnQuickUp = byId('tdQuickUpgrade');   // 「快速升级」（在 .td-controls 里，跟着 .td-bar 一起显隐）
  ui.btnSpeed = byId('tdSpeed'); ui.btnRestart = byId('tdRestart'); ui.btnBack = byId('tdBack');
  ui.hud = byId('tdHud'); ui.bar = byId('tdBar'); ui.hint = byId('tdHint');
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
    skills: () => SKILLS.map((s) => ({ id: s.id, readyAt: skillReadyAt(s.id), state: skillState(s.id).reason || 'ok' })),
    skillTimers: () => ({ timeMs: state.timeMs, stopUntil: state.stopUntil, overloadUntil: state.overloadUntil, fatigueUntil: state.fatigueUntil }),
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
