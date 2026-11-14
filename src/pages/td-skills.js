/**
 * td-skills.js —— 无尽模式主动技能：纯数据 + 纯函数层
 *
 * 设计约束（下游与本模块的离线测试都依赖这些）：
 *   1) 零 import、零 DOM、零副作用：import 本模块时不会触碰 window / document / localStorage / performance；
 *   2) 时间一律由调用方注入（now / dtMs），模块内部不读任何时钟 → 同样的输入必然得到同样的输出；
 *   3) 唯一的写操作是 applyChillTo / tickStatus 就地改写「传进来的那个 enemy 对象」，不碰任何模块级状态。
 *
 * 敌人身上的临时状态字段（本模块与主文件之间唯一的约定）：
 *   chillMs   寒流剩余时间 ms        —— 相对值，tickStatus 可直接递减，无需时钟
 *   stopMs    时停剩余时间 ms        —— 同上
 *   poisonMs  中毒剩余时间 ms        —— 本轮技能没用上，留给后续毒塔复用同一套 tick 逻辑
 *   slow      生效中的减速强度 0..1  —— 只存「最强的那一个」，所以永远不会叠乘
 *   slowFactor 与 slow 同值          —— 沿用 tower-defense.js 里冰塔的字段名（冰塔写 slowFactor/slowUntil），
 *                                       两个名字同步写入：短名 slow 给技能/UI/测试用，slowFactor 让主循环既有代码零改动
 *   slowUntil 上述减速的绝对到期时刻 ms（与 applyChillTo 的 now 同源）
 *
 * 注意：slowUntil 是绝对时刻、由主循环拿 state.timeMs 自行比较过期，所以 tickStatus 不处理它；
 *       chillMs 只是寒流自己的计时账本，与 slowUntil 在 applyChillTo 里由同一组 (now, durationMs) 写入，不会漂移。
 */

/** 无尽模式主动技能：解锁波次 / 花费 / 冷却 / 效果说明 */
export const SKILLS = [
  // 解锁波次 4/8/10/14/18/22/26/32/36/42/45/55：逐级拉开，每个阶段都有「刚好解封」的那一个在等玩家；
  // 花费与冷却同步抬升（60/20s → 900/120s），保证后期技能强但不廉价；冷却全部长于持续时间，避免同一技能无缝连放。
  // 12 条的 unlockWave 必须严格递增（自检脚本会逐位比对序列），新增技能只能插在相邻两档之间。
  { id: 'chill', name: '寒流', unlockWave: 4, cost: 60, cooldownMs: 20000, desc: '全场敌人减速 50%，持续 3 秒' },
  { id: 'meteor', name: '陨石', unlockWave: 8, cost: 150, cooldownMs: 30000, desc: '指定一处，半径 100 内 500 伤害' },
  { id: 'bounty', name: '赏金', unlockWave: 10, cost: 120, cooldownMs: 45000, desc: '12 秒内击杀赏金 +60%' },
  { id: 'repair', name: '修复', unlockWave: 14, cost: 220, cooldownMs: 60000, desc: '生命 +3（不超过上限）' },
  { id: 'vortex', name: '黑洞', unlockWave: 18, cost: 260, cooldownMs: 60000, desc: '点地面：半径 90 内的敌人被拉向圆心并聚集 1.5 秒' },
  { id: 'timestop', name: '时停', unlockWave: 22, cost: 380, cooldownMs: 75000, desc: '全场敌人停滞 2.5 秒' },
  { id: 'shield', name: '护盾', unlockWave: 26, cost: 300, cooldownMs: 70000, desc: '20 秒内漏怪不扣生命，改为消耗护盾（吸收 3 次）' },
  { id: 'overload', name: '超载', unlockWave: 32, cost: 500, cooldownMs: 90000, desc: '全塔攻速 +50%、伤害 +20%，持续 8 秒；随后疲劳 5 秒（攻速 -20%）' },
  { id: 'execute', name: '斩杀', unlockWave: 36, cost: 420, cooldownMs: 80000, desc: '对血量低于 25% 的敌人造成其最大生命 50% 的真实伤害（无视护甲）' },
  { id: 'resonance', name: '共鸣', unlockWave: 42, cost: 560, cooldownMs: 100000, desc: '8 秒内所有光环塔的加成翻倍' },
  { id: 'purge', name: '净化', unlockWave: 45, cost: 900, cooldownMs: 120000, desc: '清掉场上所有非 BOSS 敌人（不给赏金）' },
  { id: 'salvage', name: '回收', unlockWave: 55, cost: 300, cooldownMs: 150000, desc: '立刻把等级最低的 3 座塔全额返还卖掉' },
];

// ── 各技能参数（单独导出，便于主文件与测试共用同一份真值，避免两边魔法数字打架） ──

// 寒流：50% 是「明显能感觉到、又不至于让敌人完全站住」的档位；3 秒约等于一波推进的 1/5，够塔多打两轮。
export const CHILL = { slow: 0.5, durationMs: 3000 };

// 陨石：半径 100 ≈ 2.5 个格子，能覆盖一个弯道的集火点；500 伤害对齐 8 波左右小怪血量，一发清一片但打不动 BOSS。
export const METEOR = { radius: 100, damage: 500 };

// 修复：+3 条命、上限 20 —— 上限写死在这里，避免技能把生命刷成无限。
export const REPAIR = { lives: 3, maxLives: 20 };

// 时停：2.5 秒比寒流的 3 秒略短，但效果是「完全不动」，配合陨石能白嫖一轮输出。
export const TIMESTOP = { durationMs: 2500 };

// 超载：攻速 +50% 明显、伤害 +20% 温和（相乘约 1.8 倍 DPS）；8 秒爆发后 5 秒疲劳 -20% 攻速，形成代价曲线。
export const OVERLOAD = {
  rateBonus: 0.5,
  dmgBonus: 0.2,
  durationMs: 8000,
  fatigueMs: 5000,
  fatigueRate: -0.2,
};

// 赏金：+60% 是「值得为它留一波爆发」的量级；12 秒覆盖一波中后段；cap 1.2 挡住随波次强化的叠加失控。
export const BOUNTY = { goldBonus: 0.6, durationMs: 12000, cap: 1.2 };

// 黑洞：半径 90 略小于陨石（100），因为它是「聚怪」而非「清怪」，聚集 1.5 秒刚好够一轮集火。
export const VORTEX = { radius: 90, durationMs: 1500 };

// 护盾：20 秒 / 3 次吸收，上限 6 次 —— 上限写死，避免强化把「不漏血」变成永久无敌。
export const SHIELD = { durationMs: 20000, hits: 3, maxHits: 6 };

// 斩杀：25% 血线是「残血但还没死」的常见档位；50% 最大生命的真实伤害无视护甲，对高甲单位才有价值。
export const EXECUTE = { hpThreshold: 0.25, maxHpRatio: 0.5 };

// 共鸣：光环加成翻倍，持续 8 秒（与超载同档），让「堆光环塔」成为一条真实流派。
export const RESONANCE = { durationMs: 8000, auraMul: 2 };

// 回收：卖最弱的 3 座、全额返还 —— 后期换塔的止损手段；towers 上限 3、refundRatio 上限 1（不允许卖出高于投入）。
export const SALVAGE = { towers: 3, refundRatio: 1 };

/**
 * 按 id 取技能定义。
 * @param {string} id
 * @returns {object|null} 找不到返回 null（不抛异常，主文件可以安全地 `if (!skill) return;`）
 */
export function getSkill(id) {
  if (typeof id !== 'string') return null;
  for (const s of SKILLS) if (s.id === id) return s;
  return null;
}

/**
 * 返回 wave 波已解锁的技能，保持 SKILLS 原顺序（不按解锁波次重排，UI 顺序才稳定）。
 * wave 非法/NaN 时返回空数组（NaN 比较恒为 false，这里显式兜一下更直白）。
 * @param {number} wave
 * @returns {object[]}
 */
export function skillsUnlockedAt(wave) {
  if (!Number.isFinite(wave)) return [];
  return SKILLS.filter((s) => s.unlockWave <= wave);
}

/**
 * 能否释放技能。判定顺序固定：未解锁 → 冷却 → 金币（下游 UI 按这个顺序显示第一条失败原因，换顺序会改提示文案）。
 * @param {object} skill 技能定义
 * @param {{wave:number, gold:number, readyAt:number, now:number}} ctx
 * @returns {{ok:boolean, reason?:'locked'|'gold'|'cooldown'}}
 */
export function canCast(skill, ctx) {
  if (!skill) return { ok: false, reason: 'locked' }; // 未知技能按「未解锁」处理，而不是抛错
  const c = ctx || {};
  const wave = Number.isFinite(c.wave) ? c.wave : 0;
  const gold = Number.isFinite(c.gold) ? c.gold : 0;
  const now = Number.isFinite(c.now) ? c.now : 0;
  const readyAt = Number.isFinite(c.readyAt) ? c.readyAt : 0;
  if (wave < skill.unlockWave) return { ok: false, reason: 'locked' };
  if (now < readyAt) return { ok: false, reason: 'cooldown' };
  if (gold < skill.cost) return { ok: false, reason: 'gold' };
  return { ok: true };
}

/**
 * 冷却剩余毫秒，恒 >= 0（已就绪返回 0，绝不返回负数，主文件可直接拿去进度条）。
 * 技能没有冷却概念（cooldownMs 非正数）或时间参数非法时返回 0。
 * @param {object} skill
 * @param {number} readyAt 可再次释放的时刻
 * @param {number} now 当前时刻
 * @returns {number}
 */
export function cooldownLeft(skill, readyAt, now) {
  if (!skill || !(skill.cooldownMs > 0)) return 0;
  if (!Number.isFinite(readyAt) || !Number.isFinite(now)) return 0;
  const left = readyAt - now;
  return left > 0 ? left : 0;
}

/**
 * 陨石命中判定：按敌人 {x,y} 圆心距 <= radius（含边界）。
 * hover 只是浮空单位的绘制偏移，不参与判定。不修改入参，返回新数组（元素仍是原引用）。
 * @param {object[]} enemies
 * @param {number} x 落点
 * @param {number} y 落点
 * @param {number} [radius] 省略时用 METEOR.radius
 * @returns {object[]}
 */
export function meteorHits(enemies, x, y, radius) {
  if (!Array.isArray(enemies)) return [];
  const r = Number.isFinite(radius) ? radius : METEOR.radius;
  const cx = Number.isFinite(x) ? x : 0;
  const cy = Number.isFinite(y) ? y : 0;
  return enemies.filter((e) => e && Math.hypot(e.x - cx, e.y - cy) <= r);
}

/**
 * 净化命中判定：所有非 BOSS 敌人（enemy.type !== 'boss'）。
 * BOSS 有分阶段机制，不能被一键清场顺走；返回新数组，不修改入参。
 * @param {object[]} enemies
 * @returns {object[]}
 */
export function purgeHits(enemies) {
  if (!Array.isArray(enemies)) return [];
  return enemies.filter((e) => e && e.type !== 'boss');
}

/**
 * 对全场敌人施加寒流减速（就地写入状态）。
 * 规则「取更强、不叠乘」：只有新减速严格强于当前生效的减速才覆盖 slow / slowFactor / slowUntil，
 * 否则保留敌人原有（更强的）那个减速值（以及它自己的到期时刻）——绝不把两个系数相乘。
 * @param {object[]} enemies
 * @param {number} now 当前时刻 ms（不读时钟，由调用方给）
 * @param {number} slow 减速强度 0..1
 * @param {number} durationMs 持续时间 ms
 * @returns {number} 受影响人数（被写入寒流计时的敌人数量；已带更强减速的也算，因为它确实处于减速中）
 */
export function applyChillTo(enemies, now, slow, durationMs) {
  if (!Array.isArray(enemies) || !(slow > 0) || !(durationMs > 0)) return 0;
  const t = Number.isFinite(now) ? now : 0;
  let affected = 0;
  for (const e of enemies) {
    if (!e || e.dead) continue; // 已死亡的不再挂状态，避免拖尸体的字段影响后续判定
    // 现有减速强度：slow 是合并后的生效值；slowFactor 是冰塔那份，只在 slowUntil 未过期时才算数
    //（过期的旧减速不该挡住新的一发）。两者取大，保证任何来源都不会被叠乘或打架。
    const iceActive = Number.isFinite(e.slowUntil) && e.slowUntil > t;
    const slowOwn = Number.isFinite(e.slow) ? e.slow : 0;
    const slowIce = iceActive && Number.isFinite(e.slowFactor) ? e.slowFactor : 0;
    const prevSlow = slowOwn > slowIce ? slowOwn : slowIce;
    if (slow > prevSlow) {
      // 严格更强才覆盖；slow 与 slowFactor 是同一份值，同步写入，避免主循环与技能看到两个数
      e.slow = slow;
      e.slowFactor = slow;
      e.slowUntil = t + durationMs;
    }
    // 寒流自己的计时账本：与生效减速是否被我方覆盖无关，寒流确实笼罩了它就算受影响。
    const prevMs = Number.isFinite(e.chillMs) ? e.chillMs : 0;
    e.chillMs = prevMs > durationMs ? prevMs : durationMs;
    affected += 1;
  }
  return affected;
}

// tickStatus 负责递减的「剩余毫秒」字段。slowUntil 是绝对时刻，由主循环按 state.timeMs 判过期，故不在此列。
const STATUS_MS_FIELDS = ['chillMs', 'stopMs', 'poisonMs'];

/**
 * 递减敌人身上的临时状态剩余时间。
 * @param {object} enemy
 * @param {number} dtMs 本帧毫秒数（不读时钟，由调用方给）
 * @returns {boolean} 递减后是否仍处于任一状态（全部归零则 false）
 */
export function tickStatus(enemy, dtMs) {
  if (!enemy) return false;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  let alive = false;
  for (const key of STATUS_MS_FIELDS) {
    const rest = enemy[key];
    if (!Number.isFinite(rest) || rest <= 0) continue;
    const next = rest - dt;
    enemy[key] = next > 0 ? next : 0; // 归零而不留负数，便于 `> 0` 判断
    if (next > 0) alive = true;
  }
  return alive;
}

// ── 新增技能（赏金 / 黑洞 / 护盾 / 斩杀 / 共鸣 / 回收）的纯逻辑 ──
// 全部零副作用、时间由参数传入：这里只做「算一个数 / 挑一批目标」，改状态由主文件自己做。

/**
 * 赏金的额外赏金倍率（**额外**部分：0.6 表示 +60%，不是 1.6 倍总价）。
 * 结果 = min(cap, goldBonus * scale)，scale 用来给后续「随波次强化」留口子。
 * scale 非法（非数字 / NaN / Infinity）按 1 处理；scale = 0 得 0（等于没开），公式本身不额外夹取。
 * @param {number} [scale] 强化倍数，缺省 1
 * @returns {number}
 */
export function bountyMultiplier(scale) {
  const s = Number.isFinite(scale) ? scale : 1;
  const raw = BOUNTY.goldBonus * s;
  return raw < BOUNTY.cap ? raw : BOUNTY.cap;
}

/**
 * 黑洞的目标选择：圆心距 <= radius（含边界）的敌人数组，与 meteorHits 同一套判定口径。
 * 只挑目标，不做位移 —— 真正的「拉向圆心」由主文件按 VORTEX.durationMs 插值。
 * @param {object[]} enemies
 * @param {number} x 圆心
 * @param {number} y 圆心
 * @param {number} [radius] 省略/非法时用 VORTEX.radius
 * @returns {object[]} 不修改入参，返回新数组（元素仍是原引用）；坏输入返回 []
 */
export function vortexTargets(enemies, x, y, radius) {
  if (!Array.isArray(enemies)) return [];
  const r = Number.isFinite(radius) ? radius : VORTEX.radius;
  const cx = Number.isFinite(x) ? x : 0;
  const cy = Number.isFinite(y) ? y : 0;
  return enemies.filter((e) => e && Math.hypot(e.x - cx, e.y - cy) <= r);
}

/**
 * 护盾能吸收几次漏怪 = min(maxHits, round(hits * scale))，并且至少 1 次。
 * scale 非法按 1 处理；scale = 0 时也夹到 1 —— 「花 300 金开一个 0 次的护盾」没有意义，只会是配置错误。
 * @param {number} [scale] 强化倍数，缺省 1
 * @returns {number} 1..SHIELD.maxHits 的整数
 */
export function shieldHits(scale) {
  const s = Number.isFinite(scale) ? scale : 1;
  const n = Math.round(SHIELD.hits * s);
  if (n > SHIELD.maxHits) return SHIELD.maxHits;
  return n > 0 ? n : 1;
}

/**
 * 斩杀的目标选择：血量比 hp / maxHp < EXECUTE.hpThreshold 的敌人。
 * 注意是**严格小于**：hp = 25 / maxHp = 100（恰好 25%）不算命中，避免「刚好踩线」把满编小队整片秒掉。
 * 缺 hp / maxHp（或非有限数、maxHp <= 0）的敌人跳过；BOSS 不做排除（斩杀就是用来处理高血量单位的）。
 * 这里不判 dead —— 已死亡目标由主循环在遍历前剔除，本模块不重复猜测主文件的生命周期约定。
 * @param {object[]} enemies
 * @returns {object[]} 不修改入参，返回新数组（元素仍是原引用）；坏输入返回 []
 */
export function executeTargets(enemies) {
  if (!Array.isArray(enemies)) return [];
  return enemies.filter((e) => {
    if (!e) return false;
    const hp = e.hp;
    const maxHp = e.maxHp;
    if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return false;
    return hp < maxHp * EXECUTE.hpThreshold;
  });
}

/**
 * 斩杀伤害：目标最大生命的 50%，向下取整，至少 1（残血小怪不该因为取整变成 0 伤害）。
 * 这是「真实伤害」的数值部分：不做护甲减免，减免/无敌判定由主文件在结算时决定。
 * 缺 maxHp（或非有限数、<= 0）返回 0，供调用方直接 `if (!dmg) return;`。
 * @param {object} enemy
 * @returns {number}
 */
export function executeDamage(enemy) {
  if (!enemy) return 0;
  const maxHp = enemy.maxHp;
  if (!Number.isFinite(maxHp) || maxHp <= 0) return 0;
  const dmg = Math.floor(maxHp * EXECUTE.maxHpRatio);
  return dmg > 1 ? dmg : 1;
}

/**
 * 回收某座塔能返还多少金币 = max(0, floor(spend * refundRatio))。
 * refundRatio 缺省（非有限数）时用 SALVAGE.refundRatio（当前为 1，即全额返还）；
 * spend 非法返回 0 —— 宁可返还 0 也不返回 NaN，主文件可以直接加到金币上。
 * @param {number} spend 已投入的金币（totalInvested）
 * @param {number} [refundRatio] 返还比例，缺省 SALVAGE.refundRatio
 * @returns {number} 恒 >= 0 的整数
 */
export function salvageRefund(spend, refundRatio) {
  if (!Number.isFinite(spend)) return 0;
  const ratio = Number.isFinite(refundRatio) ? refundRatio : SALVAGE.refundRatio;
  const refund = Math.floor(spend * ratio);
  return refund > 0 ? refund : 0;
}

/**
 * 共鸣生效时光环塔加成的倍率。现在恒等于 RESONANCE.auraMul（2 = 翻倍），
 * 留成函数是为了以后做「随波次 / 随光环塔数量强化」时不动调用方签名。
 * @returns {number}
 */
export function resonanceMul() {
  return RESONANCE.auraMul;
}
