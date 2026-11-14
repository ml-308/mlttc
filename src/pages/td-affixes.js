// src/pages/td-affixes.js
// 塔防「波次词缀」：无尽模式每 5 波随机附加一条修饰，逼玩家换打法。
//
// 设计约束（模块自身保证，不靠调用方）：
//   · 零 import、零 DOM、零时钟、零 Math.random —— 纯数据 + 纯函数，Node 下可直接跑；
//   · 确定性：同一个 (wave, seed) 拿到的词缀永远同一条，同一份 waveCfg + 同一条词缀
//     算出的结果逐字段相同（可复现、可自检、可存档重放）；
//   · applyAffix **只读** waveCfg，返回全新对象（含全新的 groups 数组与组对象）。
//
// 词缀表与主文件 ENEMY_TYPES 的一致性：本模块不能 import 主文件（要保持零依赖），
// 所以下面复制了一份「敌人基础值」。主文件改数值时请同步这里，否则 allBoss 的换算会偏。

/* ===================== 1. 确定性随机的本地副本 ===================== */
/* 写法与主文件 hashSeed / mulberry32 一致，但**故意不 import**：本模块要能脱离主文件单独加载。 */

/** 字符串 → uint32（FNV-1a 变体）：同字符串永远同结果 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** mulberry32：32 位状态的小 PRNG，同种子同序列 */
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

/* ===================== 2. 词缀表 ===================== */
/**
 * 每条词缀 = 一组乘法系数（mul）＋ 可选的硬标记（flags）。
 *   mul.hp     该波所有敌人血量 × hp
 *   mul.speed  该波所有敌人速度 × speed
 *   mul.bounty 该波所有敌人赏金 × bounty
 *   mul.count  该波出怪数量 × count（拆组后每组各乘一次）
 * 数值取舍：词缀必须**有得有失**——纯增益会让 5 的倍数波变成福利关，纯减益则是送死关。
 * 因此每条都成对出现（快了就脆、硬了就慢、给钱就加血…）。
 */
export const AFFIXES = [
  {
    id: 'swift', name: '疾行', desc: '敌人脚下生风：跑得更快，但更不禁打',
    mul: { hp: 0.7, speed: 1.5, bounty: 1, count: 1 },
    flags: {},
  },
  {
    id: 'armored', name: '厚甲', desc: '敌人披上重甲：血更厚，但走得更慢',
    mul: { hp: 1.6, speed: 0.8, bounty: 1, count: 1 },
    flags: {},
  },
  {
    id: 'plenty', name: '丰饶', desc: '赏金翻倍，代价是敌人更结实',
    mul: { hp: 1.25, speed: 1, bounty: 2, count: 1 },
    flags: {},
  },
  {
    id: 'surge', name: '狂潮', desc: '敌人成群涌出，但每只都变脆',
    mul: { hp: 0.8, speed: 1, bounty: 1, count: 1.4 },
    flags: {},
  },
  {
    id: 'noSlow', name: '禁魔', desc: '冰塔的减速对本波完全无效',
    mul: { hp: 1.1, speed: 1.05, bounty: 1.2, count: 1 },
    flags: { noSlow: true },
  },
  {
    id: 'bossRush', name: '王潮', desc: '整波只剩 BOSS，没有小兵替你垫刀',
    mul: { hp: 1, speed: 1, bounty: 1.6, count: 1 },
    flags: { allBoss: true },
  },
  {
    id: 'frail', name: '脆皮', desc: '敌人一碰就碎，但更快也更有钱',
    mul: { hp: 0.55, speed: 1.2, bounty: 1.5, count: 1 },
    flags: {},
  },
  {
    id: 'horde', name: '蚁群', desc: '铺天盖地的杂兵：数量暴涨，血量与赏金同时缩水',
    mul: { hp: 0.6, speed: 1.1, bounty: 0.9, count: 1.8 },
    flags: {},
  },
];

/**
 * 敌人基础值副本（与主文件 ENEMY_TYPES 同值）。
 * 只给 allBoss 反推「本波的 hp / speed / bounty 倍率」用：波配置里只有绝对值，
 * 用它除一下基础值就把倍率还原出来了。主文件改数值时请同步这里。
 */
const BASE = {
  basic: { hp: 40, speed: 55, bounty: 6 },
  swift: { hp: 45, speed: 95, bounty: 5 },
  armor: { hp: 110, speed: 40, bounty: 14 },
  shield: { hp: 160, speed: 35, bounty: 22 },
  boss: { hp: 600, speed: 32, bounty: 80 },
};

/** 出场间隔的钳制区间（ms）：与主文件的 [120, 2000] 一致 */
const GAP_MIN = 120;
const GAP_MAX = 2000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** 保留两位小数：避免 1.5 × 61.6 这类乘法在 UI 上露出 92.39999999999999 */
const r2 = (v) => Math.round(v * 100) / 100;

/* ===================== 3. 按波次取词缀 ===================== */

/**
 * 取该波的词缀：非 5 的倍数返回 null；5 的倍数用确定性哈希 (wave, seed) 从 AFFIXES 里挑一条。
 * 同一波同一 seed 永远同一条 —— 读档、回放、自检都靠这条性质。
 */
export function affixForWave(wave, seed) {
  const n = Math.floor(Number(wave));
  if (!Number.isFinite(n) || n <= 0 || n % 5 !== 0) return null;
  const rng = mulberry32(hashSeed('affix:' + n + ':' + String(seed === undefined ? '' : seed)));
  const i = Math.min(AFFIXES.length - 1, Math.floor(rng() * AFFIXES.length));
  return AFFIXES[i] || null;
}

/* ===================== 4. 把词缀套到一波配置上 ===================== */

/** 取词缀的 mul，缺字段按 1，非法值也按 1（词缀表写错时退化成「无修饰」而不是算出 NaN） */
function normaliseMul(affix) {
  const m = (affix && affix.mul) || {};
  const pick = (k) => {
    const v = Number(m[k]);
    return Number.isFinite(v) && v > 0 ? v : 1;
  };
  return { hp: pick('hp'), speed: pick('speed'), bounty: pick('bounty'), count: pick('count') };
}

/**
 * 还原某字段的「倍率」：波配置里存的是绝对值，除以基础值就是本波用的倍率。
 * 取各组里的最大值（= 主文件统一的 hpMul / spdMul / goldMul）。
 * **跳过 type === 'boss' 的组**：它的 hp 已含 BOSS 的 ×8 插入系数，算进来会让王潮变成 ×64。
 */
function estimateMul(groups, field) {
  let best = 1;
  for (const g of groups) {
    const base = BASE[g && g.type];
    if (!base || g.type === 'boss') continue;
    const v = Number(g[field]);
    const b = base[field];
    if (Number.isFinite(v) && b > 0) best = Math.max(best, v / b);
  }
  return best;
}

/**
 * 把词缀套到一波配置上，返回**新对象**（入参一个字段都不改）。
 *
 * 具体做了什么（调用方必须知道的部分）：
 *  1. 每组 hp / speed / bounty 各乘 mul 对应系数；hp、bounty 向下取整且 ≥1，speed 留两位小数。
 *  2. 每组 count 乘 mul.count 后四舍五入、最小 1。
 *  3. total 重算为「非 BOSS 组 count 之和」（与主文件 generateEndlessWave 的口径一致），
 *     而不是简单 round(total × mul.count)：组内取整会产生 ±几的漂移，重算才对得上场面。
 *  4. spawnGap 除以 mul.count（钳在 [120, 2000] ms）。这里是**除**不是乘：乘的话
 *     「+40% 出怪数」会把一波的持续时间也拉长 40%，一波打太久；除则时长基本不变。
 *  5. flags.allBoss（王潮）：groups 换成一个 BOSS 组，详见下面的分步注释。
 *  6. 结果额外带上 affix（{id,name} 或 null）与 flags 副本，方便 UI 直接取文案与标记。
 *
 * affix 为 null/undefined 时：仍返回一份**结构相同的新对象**（groups 逐层复制），
 * 调用方因此不必分支判断 —— 但既然没修饰，字段值与入参一致。
 */
export function applyAffix(waveCfg, affix) {
  const src = waveCfg && typeof waveCfg === 'object' ? waveCfg : {};
  const flags = { ...((affix && affix.flags) || {}) };
  const mul = normaliseMul(affix);

  // 1) 先深复制一份组（绝不改入参：并行修改一个共享 waveCfg 会互相污染）
  let groups = (Array.isArray(src.groups) ? src.groups : []).map((g) => ({ ...g }));

  // 2) 逐组乘系数
  for (const g of groups) {
    g.hp = Math.max(1, Math.round(Number(g.hp || 0) * mul.hp));
    g.speed = Math.max(1, r2(Number(g.speed || 0) * mul.speed));
    g.bounty = Math.max(1, Math.round(Number(g.bounty || 0) * mul.bounty));
    g.count = Math.max(1, Math.round(Number(g.count || 0) * mul.count));
  }

  // 3) total = 非 BOSS 组之和（BOSS 是额外插入、不占 total，与生成器同一口径）
  const sumNonBoss = (list) => list.reduce((s, g) => s + (g.type === 'boss' ? 0 : g.count), 0);

  // 4) 出场间隔与数量反比
  const baseGap = Number(src.spawnGap) || 0;
  const spawnGap = baseGap > 0 ? clamp(Math.round(baseGap / mul.count), GAP_MIN, GAP_MAX) : baseGap;

  let total = sumNonBoss(groups);
  let bossCount = Number(src.bossCount) || groups.reduce((s, g) => s + (g.type === 'boss' ? g.count : 0), 0);
  let isBossWave = !!src.isBossWave;

  // 5) 王潮：整波只剩 BOSS
  //  · 数量：ceil(total / 8) —— 小兵换 BOSS 按 1:8 折算，白兵量越大 BOSS 越多（至少 1 只）；
  //  · 血量：600（BOSS 基础） × 本波 hp 倍率 × 词缀 hp 系数。倍率从**已经乘过 mul** 的小兵组
  //    反推，所以「厚甲 + 王潮」叠在一起时 BOSS 也吃到了 +60%；
  //  · 速度 / 赏金：同理用本波倍率乘 BOSS 基础值；
  //  · 护甲固定 0.35（BOSS 本体值）。
  //  · 换算后 total 直接等于 BOSS 只数：此时已不存在「额外插入的 BOSS」，total 就是本波实际出场数，
  //    HUD 上的「本波 N 只」才不会显示成 0。
  if (flags.allBoss) {
    const hpMul = estimateMul(groups, 'hp');
    const spdMul = estimateMul(groups, 'speed');
    const goldMul = estimateMul(groups, 'bounty');
    const count = Math.max(1, Math.ceil(total / 8));
    const b = BASE.boss;
    groups = [{
      type: 'boss',
      count,
      hp: Math.max(1, Math.round(b.hp * hpMul)),
      speed: Math.max(1, r2(b.speed * spdMul)),
      bounty: Math.max(1, Math.round(b.bounty * goldMul)),
      armor: 0.35,
    }];
    total = count;
    bossCount = count;
    isBossWave = true;
  }

  return {
    ...src,
    total,
    bossCount,
    groups,
    spawnGap,
    isBossWave,
    affix: affix ? { id: affix.id, name: affix.name } : null,
    flags,
  };
}

/* ===================== 5. UI 文案 ===================== */

/** 倍率 → 百分比片段：1.5 → '速度 +50%'，0.7 → '血量 -30%'，1 → 不出现 */
function pctPart(label, v) {
  if (!Number.isFinite(v) || v === 1) return '';
  const p = Math.round((v - 1) * 100);
  if (p === 0) return '';
  return `${label} ${p > 0 ? '+' : '-'}${Math.abs(p)}%`;
}

/**
 * 给 UI 用的单行文案，形如「词缀：疾行｜敌人 速度 +50%、血量 -30%」。
 * 文案由 mul / flags 自动拼（词缀表改数值时文案自动跟着变，不会与数值脱节）。
 */
export function affixLabel(affix) {
  if (!affix || typeof affix !== 'object') return '';
  const m = normaliseMul(affix);
  const flags = affix.flags || {};
  const parts = [
    pctPart('速度', m.speed),
    pctPart('血量', m.hp),
    m.bounty !== 1 ? `赏金 ×${r2(m.bounty)}` : '',
    pctPart('出怪数', m.count),
    flags.noSlow ? '免疫减速' : '',
    flags.allBoss ? '全 BOSS 波' : '',
  ].filter(Boolean);
  const name = affix.name || affix.id || '未知';
  const body = parts.length > 0 ? parts.join('、') : (affix.desc || '无附加效果');
  return `词缀：${name}｜敌人 ${body}`;
}
