/**
 * td-constants.js —— 塔防的全部数值常量（从 tower-defense.js 原样搬出，一个字都没改）。
 * 纯数据：零 import 副作用、零 state、零 DOM，任何模块 import 都不会 boot。
 * =========================================================================
 */
import { SPECIAL_TOWER_TYPES } from '../td-special-towers.js';

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
// 塔的最高等级：实质无限制。
// 为什么不直接写 Infinity：伤害是 1.12^k 的指数、升级价是 1.12^L 的指数，
// 真给 Infinity 会让比较失真并算出 NaN 污染显示与存档。取 100 万级：
// 正常玩最多到几百级，等效"无限制"，同时所有运算仍在有限域内。
const MAX_TOWER_LEVEL = 1000000;
const STAT_CEIL = 1e15;   // 伤害 / 毒 dot / 升级价 / 超频价的有限上限
const HIGH_LV_UNLOCK_WAVE = 50;       // 无尽模式第 50 波后才允许升级到 Lv.4+
/**
 * 同屏塔数硬上限。每座塔每帧都要绘制塔身 / 等级 / 光环脉冲 / 超频金环并参与索敌，而 90 波之后
 * 金币充裕，玩家会把每个可建格都铺满 —— 实测铺到 300 座上下时帧率塌方，画面看着就是「完全卡死」。
 * 80 座已远超清掉一波所需的火力，所以它是纯兜底：超限时 placeTower 拒绝建造（不扣钱），
 * 已有塔的升级 / 超频 / 拆除都不受影响。
 */
// 塔数量软上限：**只用于拦截"继续无节制铺满全图"**，绝不裁剪既有存档。
// 曾经设为 80 并配合「超限只恢复前 80 座」，结果把玩家合法攒出的整图布局削掉了 ——
// 数据丢失比掉帧严重得多。降到 400 后正常玩家碰不到，同时仍能挡住病态存档。
const MAX_TOWERS = 400;
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
/* 批量升级的座数区间：输入框的 min/max 与纯函数的夹取共用这两个常量（不许两边各写一份） */
const BATCH_UP_MIN = 1;
const BATCH_UP_MAX = 100;

/* ===== 导出（逐个具名：主文件再转发一份，导出面不变） ===== */
export {
GRID, VIEW, ENEMY_TYPES, TOWER_TYPES, ALL_TOWER_TYPES, MAX_TOWER_LEVEL, STAT_CEIL, HIGH_LV_UNLOCK_WAVE, MAX_TOWERS, FX_CROWD_ENEMIES, FX_CROWD_TOWERS, HIGH_LV_DMG_STEP, HIGH_LV_RATE_STEP, HIGH_LV_RANGE_STEP, HIGH_LV_COST_STEP, OC_DMG_MUL, OC_RATE_MUL, OC_RANGE_MUL, OC_AURA_MUL, OC_SLOW_ADD, OC_POISON_MUL, OC_PUSH_MUL, OC_CHAIN_COUNT, OC_SUCCESS, OC_FAIL_DROP, OC_COST_BASE, OC_COST_STEP, OC_COUNT_MIN, OC_COUNT_MAX, RUN_LEFT_MAX_MS, OC_COLOR, BALANCE, SPEED_LEVELS, EARLY_WAVE_MUL, BEST_KEY, PROGRESS_KEY, LEVEL_MAX, DEFAULT_SEED, LEVEL_DIFF_STEP, LEVEL_POT, LEVEL_POT_EXP, LEVEL_POT_FALL, LEVEL_TWEAKS, LATE_HP_FROM, LATE_HP_STEP, HP_CEIL, MAP_TEMPLATES, BATCH_UP_MIN, BATCH_UP_MAX,
};
