/**
 * td-special-towers.js —— 无尽模式特殊塔：纯数据 + 纯函数层
 *
 * 设计边界（刻意保持极窄）：1) 零依赖，可被 Node 直接 import 做离线断言；
 * 2) 零宿主全局访问，import 时不产生任何副作用；3) 零时钟——一切与时间相关的量
 * （dtMs / durationMs / remainingMs）都由调用方传入，测试才能构造确定数值、方便回放。
 * 所以这里只有「表格 + 算术」；渲染、计时、索敌调度、扣血都留在 tower-defense.js。
 *
 * 坐标约定（与 tower-defense.js 第 13-17 行一致）：敌人用 dist 表示沿路径的像素进度，
 * dist 越大越靠前；敌人另有 x / y 像素坐标用来算「离塔多远」；格宽固定 32px，
 * 力场推回距离从「格」换算成像素。
 */

// ---------------------------------------------------------------------------
// 1. 常量（只用字面量，不读外部配置）
// ---------------------------------------------------------------------------

const TILE_PX = 32;     // 路径格宽固定 32px，力场推回按格换算像素
const MIN_LEVEL = 1;
const MAX_LEVEL = 3;

// ---------------------------------------------------------------------------
// 2. 三座特殊塔的数值表
//
// 数值取舍说明（改动前请先读完）：
// * 造价定位「大量金币」：常规塔 60~130，这里 L1 直接 480 / 560 / 780，
//   是常规塔的 4~12 倍。L3 累计投入分别是
//     tesla  480+420+760 = 1660
//     poison 560+500+900 = 1960
//     force  780+700+1200 = 2680
//   都落在 1600~2700 区间：既让玩家在 18/28/40 波攒得住，又不至于一局堆满三座。
// * tesla 链式衰减 0.2：3 跳后仍是 51.2%（34→27→22→17），
//   够清掉排在后排的小兵，又不会因为「跳无限次」把数值撑爆。
// * poison 的 dmg 刻意写 0：伤害 100% 来自 dot；填个「看起来正常」的 dmg 会让普通
//   伤害先吃护甲减免，把「无视护甲」这个唯一卖点稀释掉，高护甲盾兵/BOSS 波反而更弱。
//   rate 在这里只表示「毒液刷新频率」：命中即刷新 duration，伤害靠 poisonTick 逐帧结算。
// * force 推回 1.0/1.1/1.2 格 = 32/35.2/38.4px，约等于 BOSS 一秒的推进量；
//   BOSS 效果减半是防止「双力场 + BOSS 慢速」把它永久钉在原地导致卡关。
// * 解锁波次 18/28/40：无尽模式金币曲线在 15 波之后开始滚动，
//   18 波刚好能买下第一座 tesla，40 波的 force 属于后期翻盘件。
// ---------------------------------------------------------------------------

/** 无尽模式特殊塔：解锁波次 + 造价（建造/升2/升3）+ 特性 */
export const SPECIAL_TOWER_TYPES = {
  tesla: {
    name: '特斯拉塔', special: true, unlockWave: 18,
    cost: [480, 420, 760], dmg: [34, 52, 78], rate: [0.9, 1.0, 1.1], range: [120, 130, 140],
    chain: { count: 3, falloff: 0.2 },   // 命中后额外跳 3 个目标，每跳衰减 20%
    color: '#67E8F9',
    desc: '链式闪电：额外跳 3 个目标，每跳衰减 20%',
  },
  poison: {
    name: '毒塔', special: true, unlockWave: 28,
    cost: [560, 500, 900], dmg: [0, 0, 0], rate: [0.8, 0.9, 1.0], range: [110, 120, 130],
    poison: { dps: [18, 28, 40], durationMs: 3000, ignoreArmor: true }, // 无视护甲的持续伤害
    color: '#A3E635',
    desc: '剧毒：无视护甲的持续伤害，每秒 18/28/40，持续 3 秒',
  },
  force: {
    name: '力场塔', special: true, unlockWave: 40,
    cost: [780, 700, 1200], dmg: [6, 10, 14], rate: [0.5, 0.6, 0.7], range: [110, 120, 130],
    push: { tiles: [1.0, 1.1, 1.2], bossHalf: true },  // 把敌人沿路径推回（BOSS 减半）
    color: '#F472B6',
    desc: '力场：把敌人推回 1.0/1.1/1.2 格，BOSS 效果减半',
  },
};

/** 稳定顺序，供塔栏渲染（不要按对象 key 顺序渲染，顺序是产品决策） */
export const SPECIAL_TOWER_IDS = ['tesla', 'poison', 'force'];

// ---------------------------------------------------------------------------
// 3. 内部小工具
// ---------------------------------------------------------------------------

/** 取类型定义；非自有 key（如 'constructor'）一律视为未知，避免原型链误命 */
function defOf(typeId) {
  if (typeof typeId !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SPECIAL_TOWER_TYPES, typeId)
    ? SPECIAL_TOWER_TYPES[typeId]
    : null;
}

/** 等级夹到 1..3；非法输入（undefined / NaN / 字符串垃圾）按 1 级处理 */
function clampLevel(lvl) {
  const n = Math.round(Number(lvl));
  if (!Number.isFinite(n)) return MIN_LEVEL;
  if (n < MIN_LEVEL) return MIN_LEVEL;
  if (n > MAX_LEVEL) return MAX_LEVEL;
  return n;
}

// ---------------------------------------------------------------------------
// 4. 解锁判定
// ---------------------------------------------------------------------------

/** 是否特殊塔 */
export function isSpecialTower(typeId) {
  const def = defOf(typeId);
  return !!(def && def.special);
}

/** 返回 unlockWave <= wave 的 SPECIAL_TOWER_IDS（保序，便于直接铺塔栏） */
export function specialTowersUnlockedAt(wave) {
  const w = Number(wave);
  if (!Number.isFinite(w)) return [];
  return SPECIAL_TOWER_IDS.filter((id) => SPECIAL_TOWER_TYPES[id].unlockWave <= w);
}

/** 返回解锁波次；普通塔 / 未知 id 返回 0（调用方据此判断「本关就能造」） */
export function towerUnlockWave(typeId) {
  const def = defOf(typeId);
  return def ? def.unlockWave : 0;
}

// ---------------------------------------------------------------------------
// 5. 经济
// ---------------------------------------------------------------------------

/**
 * 该塔到 lvl 级为止的累计投入 = cost.slice(0, lvl).sum。
 * 累计值（而不是单级价）是给「卖掉返 70%」「成就统计」用的：
 * 升级价本身会随等级下降，单看任一级都会低估真实沉没成本。
 * lvl 被夹到 1..3；未知类型返回 0（不抛错，塔栏删塔时可能拿到脏 id）。
 */
export function totalInvested(typeId, lvl) {
  const def = defOf(typeId);
  if (!def || !Array.isArray(def.cost)) return 0;
  const n = clampLevel(lvl);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += def.cost[i] || 0;
  return sum;
}

// ---------------------------------------------------------------------------
// 6. 特斯拉塔：链式闪电
// ---------------------------------------------------------------------------

/**
 * 第 hopIndex 跳（从 1 开始）的伤害 = base * (1-falloff)^(hopIndex-1)，取整。
 * 末跳最小 1：衰减再狠也不能变成 0，否则「跳到了但没伤害」会让玩家以为塔坏了，
 * 也让 dot/统计里出现假命中。四舍五入而不是向下取整，避免 34*0.8=27.2 被压成 27 后
 * 逐跳误差累积。
 */
export function chainDamage(baseDmg, hopIndex, falloff) {
  const base = Number(baseDmg);
  const hop = Math.floor(Number(hopIndex));
  const f = Number(falloff);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(hop) || hop < 1) return Math.round(base);
  const ff = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
  const dmg = base * Math.pow(1 - ff, hop - 1);
  return Math.max(1, Math.round(dmg));
}

/**
 * 从 origin 周围 range 内挑「沿路径最靠前」（dist 最大）的 count 个敌人。
 * - 距离用 x/y 的欧氏距离，range 之外直接排除（链式闪电不穿墙拐弯）；
 * - excludeIds 用于排除已经在本轮链里被电过的目标，防止同一敌人吃两次；
 * - 返回值按 dist 从大到小排序：最靠前的先被电，观感上就是闪电往前打，
 *   同时也让「先打的伤害高」这层顺序在每个帧内都是确定的。
 * 缺 x/y 坐标的敌人视为无法判距，直接跳过（本仓库的敌人一定带坐标）。
 */
export function pickChainTargets(enemies, origin, count, range, excludeIds) {
  if (!Array.isArray(enemies) || enemies.length === 0) return [];
  const max = Math.floor(Number(count));
  if (!Number.isFinite(max) || max <= 0) return [];
  const r = Number(range);
  if (!Number.isFinite(r) || r <= 0) return [];
  const ox = Number(origin && origin.x);
  const oy = Number(origin && origin.y);
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return [];
  const banned = new Set(Array.isArray(excludeIds) ? excludeIds : []);
  const picked = [];
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e) continue;
    if (banned.has(e.id)) continue;
    const ex = Number(e.x);
    const ey = Number(e.y);
    if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
    if (Math.hypot(ex - ox, ey - oy) > r) continue;
    picked.push(e);
  }
  picked.sort((a, b) => (Number(b.dist) || 0) - (Number(a.dist) || 0));
  return picked.slice(0, max);
}

// ---------------------------------------------------------------------------
// 7. 毒塔：无视护甲的持续伤害
// ---------------------------------------------------------------------------

/** 返回每秒伤害；无 poison 特性 / 未知类型返回 0 */
export function poisonDps(typeId, lvl) {
  const def = defOf(typeId);
  if (!def || !def.poison || !Array.isArray(def.poison.dps)) return 0;
  return def.poison.dps[clampLevel(lvl) - 1] || 0;
}

/**
 * 本次 tick 的伤害 = dps * min(dtMs, remainingMs) / 1000。
 * 只结算剩余时间内的部分：毒正好在帧中结束时不会多打一帧的满额伤害。
 * 明确返回浮点、不在这里取整——取整交给调用方累加到 hp 上，
 * 否则每次 tick 都向下取整会凭空吃掉一部分 DPS（18/1000*100ms=1.8 → 1 就是 -45%）。
 */
export function poisonTick(remainingMs, dps, dtMs) {
  const rem = Number(remainingMs);
  const rate = Number(dps);
  const dt = Number(dtMs);
  if (!Number.isFinite(rem) || rem <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  return (rate * Math.min(dt, rem)) / 1000;
}

// ---------------------------------------------------------------------------
// 8. 力场塔：沿路径推回
// ---------------------------------------------------------------------------

/**
 * 应推回的像素距离 = push.tiles[lvl-1] * 32；BOSS 且 bossHalf 为真时再乘 0.5。
 * 推回量按「格」定义而不是按像素，是为了让数值能对着关卡地图读；
 * 像素换算留在函数里，调用方只需要关心格。
 */
export function pushDistance(typeId, lvl, isBoss) {
  const def = defOf(typeId);
  if (!def || !def.push || !Array.isArray(def.push.tiles)) return 0;
  const tiles = def.push.tiles[clampLevel(lvl) - 1];
  if (!Number.isFinite(tiles) || tiles <= 0) return 0;
  const half = isBoss && def.push.bossHalf ? 0.5 : 1;
  return tiles * TILE_PX * half;
}

/** 推回后的路径进度 = max(0, currentDist - pushPx)；dist 不允许为负（0 即起点） */
export function applyPush(currentDist, pushPx) {
  const cur = Number(currentDist);
  const push = Number(pushPx);
  if (!Number.isFinite(cur)) return 0;
  if (!Number.isFinite(push) || push <= 0) return Math.max(0, cur);
  return Math.max(0, cur - push);
}
