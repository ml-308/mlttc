/**
 * td-synergy.js —— 技能连携（先后施放的组合加成）：纯数据 + 纯函数层
 *
 * 设计约束（与 td-skills.js 同一套口径，下游与离线自检都依赖）：
 *   1) 零 import、零 DOM、零副作用：import 本模块不触碰 window / document / performance；
 *   2) 时间一律由调用方注入（prevAtMs / nowMs），模块内部不读任何时钟 → 同输入必得同输出；
 *   3) 全部只读：不改入参、不写模块级状态。「同一对技能只能命中一次」不归本模块管，
 *      由调用方维护「上一次施放的 id 与时刻」，并在命中消费后清空（见文件末尾的集成说明）。
 *
 * 与主文件的唯一约定：
 *   prevId   上一次施放的技能 id（没有则传 '' / null）
 *   prevAtMs 上一次施放的时刻 ms，与当前 nowMs 同源（都用 state.timeMs）；0 / undefined 视为「没有前置」
 */

/**
 * 连携表：在 first 施放后 windowMs 内施放 second，second 获得额外效果。
 * kind 决定加成落在哪个通道：
 *   dmg    → 伤害倍率 1 + value（synergyMultiplier）
 *   rate   → 攻速倍率 1 + value（synergyMultiplier）
 *   refund → 返还 floor(技能费 * value)（synergyRefund）
 * 顺序有意义：反向施放不构成连携（自检里有「meteor→vortex 不命中」一条）。
 */
export const SYNERGIES = [
  // 黑洞先聚怪、陨石再砸：把「聚拢」变成实打实的伤害收益，窗口 4 秒刚好覆盖 1.5s 聚怪 + 出手延迟。
  { first: 'vortex', second: 'meteor', windowMs: 4000, kind: 'dmg', value: 0.5, desc: '黑洞聚怪后 4 秒内陨石伤害 +50%' },
  // 寒流减速期间补时停：敌人本就在慢慢挪，时停里挨打再加 25%，是「控住再打」的常规组合。
  { first: 'chill', second: 'timestop', windowMs: 4000, kind: 'dmg', value: 0.25, desc: '寒流减速中时停，期间敌人受击伤害 +25%' },
  // 共鸣让光环翻倍，此时开超载叠攻速：窗口放宽到 5 秒（两者持续都是 8 秒，取较短的一段）。
  { first: 'resonance', second: 'overload', windowMs: 5000, kind: 'rate', value: 0.2, desc: '共鸣生效时超载，攻速额外 +20%' },
  // 护盾挡漏怪、净化清场：先有盾再清场才敢放，返还 30% 技能费作为「顺手省一笔」。
  { first: 'shield', second: 'purge', windowMs: 6000, kind: 'refund', value: 0.3, desc: '护盾期间净化，返还 30% 技能费' },
  // 赏金开着的时候回收：赏金期是「攒钱期」，回收多返 50% 让换塔更划算；窗口 8 秒（赏金 12 秒的子区间）。
  { first: 'bounty', second: 'salvage', windowMs: 8000, kind: 'refund', value: 0.5, desc: '赏金期间回收，回收返还 +50%' },
];

/** 12 个技能 id 的中文名（仅用于 UI 文案；与 td-skills.js 的 name 字段保持一致，改那里请同步这里） */
const SKILL_NAMES = {
  chill: '寒流',
  meteor: '陨石',
  bounty: '赏金',
  repair: '修复',
  vortex: '黑洞',
  timestop: '时停',
  shield: '护盾',
  overload: '超载',
  execute: '斩杀',
  resonance: '共鸣',
  purge: '净化',
  salvage: '回收',
};

/**
 * 技能 id → 中文名。未知 id 原样返回 id，保证文案永远不会出现 "undefined"。
 * @param {string} id
 * @returns {string}
 */
function skillName(id) {
  const n = SKILL_NAMES[id];
  return typeof n === 'string' ? n : String(id);
}

/** 0.5 → '50%'；只用于文案，故四舍五入到整数百分比 */
function pct(value) {
  return `${Math.round(value * 100)}%`;
}

/**
 * 连携命中判定：上一次施放 prevId（时刻 prevAtMs）之后、windowMs 内施放 currentId 即命中。
 * 命中窗口取**闭区间**：nowMs - prevAtMs === windowMs 算命中，多 1ms 就不算。
 * @param {string} prevId 上一次施放的技能 id；空 / 非字符串视为没有前置
 * @param {number} prevAtMs 上一次施放的时刻 ms；0 / undefined / 非有限数视为没有前置
 * @param {string} currentId 本次施放的技能 id
 * @param {number} nowMs 本次施放的时刻 ms（与 prevAtMs 同源）
 * @returns {object|null} 命中的那条 SYNERGIES 项（同一份引用，调用方不要改它），否则 null
 */
export function matchSynergy(prevId, prevAtMs, currentId, nowMs) {
  if (typeof prevId !== 'string' || prevId.length === 0) return null;
  if (typeof currentId !== 'string' || currentId.length === 0) return null;
  // prevAtMs === 0 是「没有前置」的显式哨兵值，不是「上一次施放在 0 时刻」
  if (!Number.isFinite(prevAtMs) || prevAtMs === 0) return null;
  if (!Number.isFinite(nowMs)) return null;
  // 时间倒流（本次早于上次）不成立，直接判无效，避免负差值被当成「窗口内」
  if (nowMs < prevAtMs) return null;
  for (const s of SYNERGIES) {
    if (s.first !== prevId || s.second !== currentId) continue;
    if (nowMs - prevAtMs <= s.windowMs) return s;
  }
  return null;
}

/**
 * 倍率通道加成：kind 为 'dmg' / 'rate' 时返回 1 + hit.value，其它 kind（含未命中）返回 1。
 * 返回的是「乘数」而不是「加成量」，调用方直接乘即可；未命中恒为 1，可以无条件相乘。
 * @param {'dmg'|'rate'|'refund'|string} kind
 * @param {object|null} hit matchSynergy 的返回值
 * @returns {number}
 */
export function synergyMultiplier(kind, hit) {
  if (!hit || typeof hit !== 'object') return 1;
  if (kind !== 'dmg' && kind !== 'rate') return 1;
  return Number.isFinite(hit.value) && hit.value > 0 ? 1 + hit.value : 1;
}

/**
 * 返还通道：kind 为 'refund' 时返回 floor(base * hit.value)，其它 kind（含未命中、非法 base）返回 0。
 * 与 td-skills.js 的 salvageRefund 同一口径（向下取整、不返还负数），调用方无条件加到金币上即可。
 * @param {'dmg'|'rate'|'refund'|string} kind
 * @param {object|null} hit matchSynergy 的返回值
 * @param {number} base 计算基数（通常是这次施放花掉的金币）
 * @returns {number} 恒 >= 0 的整数
 */
export function synergyRefund(kind, hit, base) {
  if (kind !== 'refund') return 0;
  if (!hit || typeof hit !== 'object') return 0;
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(hit.value) || hit.value <= 0) return 0;
  return Math.floor(base * hit.value);
}

/**
 * UI 提示文案，例如「连携：黑洞→陨石 · 陨石伤害 +50%」。
 * 未命中返回空串（调用方可以 `if (!text) return;` 直接跳过绘制，不必判 null）。
 * @param {object|null} hit matchSynergy 的返回值
 * @returns {string}
 */
export function synergyLabel(hit) {
  if (!hit || typeof hit !== 'object') return '';
  const a = skillName(hit.first);
  const b = skillName(hit.second);
  const v = Number.isFinite(hit.value) ? hit.value : 0;
  let effect;
  if (hit.kind === 'dmg') effect = `${b}伤害 +${pct(v)}`;
  else if (hit.kind === 'rate') effect = '攻速额外 +' + pct(v);
  else if (hit.kind === 'refund') effect = `技能费返还 ${pct(v)}`;
  else effect = typeof hit.desc === 'string' ? hit.desc : '连携生效';
  return `连携：${a}→${b} · ${effect}`;
}

/*
 * ── 集成说明（主文件 tower-defense.js 侧需要维护的状态）──────────────────
 *
 * 1) 两个字段足以支撑整套连携：
 *      state.lastSkillId   上一次真正施放成功的技能 id（施放失败 / 冷却中 / 金币不足不要写）
 *      state.lastSkillAtMs 上一次施放时刻，必须写 state.timeMs（与下面 nowMs 同源），不要用 Date.now()
 *    两者一起出现、一起清空；初始化为 { lastSkillId: '', lastSkillAtMs: 0 } —— 0 在这里即「没有前置」。
 *
 * 2) 施放结算处的调用顺序（先判连携、再生效、最后覆盖上次施放）：
 *      const now = state.timeMs;
 *      const hit = matchSynergy(state.lastSkillId, state.lastSkillAtMs, id, now);
 *      // 生效时：伤害乘 synergyMultiplier('dmg', hit)，攻速乘 synergyMultiplier('rate', hit)，
 *      //       返还加 synergyRefund('refund', hit, skill.cost)（注意返还的是「本次」技能费）
 *      if (hit) { pushToast(synergyLabel(hit)); }
 *      state.lastSkillId = id;      // 命中后也要覆盖：同一对技能因此不会被连续触发两次
 *      state.lastSkillAtMs = now;
 *
 * 3) 需要主文件自己保证的两条（本模块刻意不做）：
 *      · 只在「技能真的放出去了」之后写 lastSkill*，否则一次失败施放会把连携窗口吃掉；
 *      · 连携的额外效果（+25% 受击伤害、攻速 +20% 等）的持续时间由各自技能自己管，
 *        本模块只回答「这一发给不给加成」，不负责计时与叠加；
 *      · 若将来要做「同一次施放只吃一条」，本模块已保证按 SYNERGIES 顺序取首个命中项（不会累加）。
 *
 * 4) 时间基准：state.timeMs 会被暂停/变速影响，这也正是想要的口径 —— 连携窗口按「游戏内时间」算，
 *    玩家暂停时窗口不会自己流走。绝不要混用 performance.now()，否则两套时钟会让窗口判定漂移。
 */
