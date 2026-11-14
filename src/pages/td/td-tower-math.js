/**
 * td-tower-math.js —— 塔的数值与「先算后扣」计划，纯函数层。
 * 从 tower-defense.js 原样搬出：外推公式、封顶、挑选顺序、取整全部未改。
 * 不读 state、不碰 DOM、不读时钟（入参进 → 结果出），所以 Node 下可直接断言。
 */
import {
  GRID, VIEW, ENEMY_TYPES, TOWER_TYPES, ALL_TOWER_TYPES, MAX_TOWER_LEVEL, STAT_CEIL, HIGH_LV_UNLOCK_WAVE, MAX_TOWERS, FX_CROWD_ENEMIES, FX_CROWD_TOWERS, HIGH_LV_DMG_STEP, HIGH_LV_RATE_STEP, HIGH_LV_RANGE_STEP, HIGH_LV_COST_STEP, OC_DMG_MUL, OC_RATE_MUL, OC_RANGE_MUL, OC_AURA_MUL, OC_SLOW_ADD, OC_POISON_MUL, OC_PUSH_MUL, OC_CHAIN_COUNT, OC_SUCCESS, OC_FAIL_DROP, OC_COST_BASE, OC_COST_STEP, OC_COUNT_MIN, OC_COUNT_MAX, RUN_LEFT_MAX_MS, OC_COLOR, BALANCE, SPEED_LEVELS, EARLY_WAVE_MUL, BEST_KEY, PROGRESS_KEY, LEVEL_MAX, DEFAULT_SEED, LEVEL_DIFF_STEP, LEVEL_POT, LEVEL_POT_EXP, LEVEL_POT_FALL, LEVEL_TWEAKS, LATE_HP_FROM, LATE_HP_STEP, HP_CEIL, MAP_TEMPLATES, BATCH_UP_MIN, BATCH_UP_MAX,
} from './td-constants.js';
import { applySpecialization, specSummary } from '../td-specialization.js';
import { SALVAGE, salvageRefund } from '../td-skills.js';

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
      : (L < 3 ? num(d.cost[L])
        : Math.min(STAT_CEIL, Math.round(d.cost[2] * Math.pow(HIGH_LV_COST_STEP, L - 2)))),
  };
  if (k > 0) {                             // Lv.1~3 原样返回；Lv.4+ 按 k 外推
    // 等级无上限后 1.12^k 在 k≈6000 会溢出成 Infinity，伤害变 Infinity 会连带把血量、
    // 赏金、显示算成 NaN。所有指数项统一封顶到有限值。
    const g = Math.min(STAT_CEIL, Math.pow(HIGH_LV_DMG_STEP, k));
    st.dmg = Math.min(STAT_CEIL, st.dmg * g);
    st.poisonDps = Math.min(STAT_CEIL, st.poisonDps * g);                                        // 毒的 dot 跟着涨
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
  // 等级无上限后 1.12^L 会溢出成 Infinity（按钮会永远显示"金币不足"），封顶到 STAT_CEIL
  return Math.min(STAT_CEIL, Math.round(OC_COST_BASE * Math.pow(OC_COST_STEP, L - 1)));
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

/* ===== 导出 ===== */
export {
applyOverclock, towerStat, towerStatSpec, towerStatOf, round2, describeTowers, nextUpgradeTarget, planBatchUpgrade, overclockCost, overclockRoll, overclockFailLevel, planBatchOverclock, planSalvage, highLevelNote, towerStatRows,
};
