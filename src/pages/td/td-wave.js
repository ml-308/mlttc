/**
 * td-wave.js —— 波次生成（无尽 / 闯关）与关卡派生，纯函数层。
 * 从 tower-defense.js 原样搬出：算法、常量、取整顺序、缓存一个都没动。
 * 只依赖 ./td-constants.js；不读 state、不碰 DOM、不读时钟（种子由调用方注入）。
 */
import {
  GRID, VIEW, ENEMY_TYPES, TOWER_TYPES, ALL_TOWER_TYPES, MAX_TOWER_LEVEL, STAT_CEIL, HIGH_LV_UNLOCK_WAVE, MAX_TOWERS, FX_CROWD_ENEMIES, FX_CROWD_TOWERS, HIGH_LV_DMG_STEP, HIGH_LV_RATE_STEP, HIGH_LV_RANGE_STEP, HIGH_LV_COST_STEP, OC_DMG_MUL, OC_RATE_MUL, OC_RANGE_MUL, OC_AURA_MUL, OC_SLOW_ADD, OC_POISON_MUL, OC_PUSH_MUL, OC_CHAIN_COUNT, OC_SUCCESS, OC_FAIL_DROP, OC_COST_BASE, OC_COST_STEP, OC_COUNT_MIN, OC_COUNT_MAX, RUN_LEFT_MAX_MS, OC_COLOR, BALANCE, SPEED_LEVELS, EARLY_WAVE_MUL, BEST_KEY, PROGRESS_KEY, LEVEL_MAX, DEFAULT_SEED, LEVEL_DIFF_STEP, LEVEL_POT, LEVEL_POT_EXP, LEVEL_POT_FALL, LEVEL_TWEAKS, LATE_HP_FROM, LATE_HP_STEP, HP_CEIL, MAP_TEMPLATES, BATCH_UP_MIN, BATCH_UP_MAX,
} from './td-constants.js';

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

/* ===== 导出 ===== */
export {
hashSeed, mulberry32, scaledHp, generateEndlessWave, generateLevel, buildLevelWave, levelTotalCache, levelTotalEnemies,
};
