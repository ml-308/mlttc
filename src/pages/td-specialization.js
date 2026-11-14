/**
 * td-specialization.js —— 塔专精（三阶二选一）：纯数据 + 纯函数层
 *
 * 定位：塔在 **Lv.10 / Lv.25 / Lv.50** 各获得一次「二选一」的专精机会，效果是
 * **对 towerStat() 已算出的属性做修正**，不引入任何新机制（不加新攻击方式、不加新计时器、
 * 不改敌人状态生命周期）。所以本模块只有「差额」和「算术」，战斗循环要改的只是
 * 「先 towerStat()，再 applySpecialization()」这一步取值。
 *
 * 设计约束（与 td-skills.js / td-special-towers.js 同一套边界）：
 *   1) 零 import、零 DOM、零副作用：import 本模块不触碰 window / document / 任何存储；
 *   2) 零时钟：不读 Date / performance，三个等级档是常量而非「什么时候能选」的判断；
 *   3) 等级闸**不在本模块**：Lv.10 才能选 10 阶，由调用方用 `tower.lv >= tier` 判。
 *      applySpecialization 不判等级，但会跳过「非法 id」和「越阶 id」（见下）。
 *
 * ── mod 的写法（本模块与调用方唯一的约定） ─────────────────────────
 *   mod 是 `{ 字段: 修饰 }`，修饰有三种形态：
 *     数字          → **百分比**（相对该字段基准值）：`dmg: 0.25` 表示 ×1.25
 *     { pct: 数 }   → 同数字，显式写法
 *     { add: 数 }   → **绝对值**加法：`chainCount: { add: 1 }`、`slow: { add: 0.06 }`
 *   为什么默认给百分比：towerStat 的 Lv.4+ 是外推值（每级 ×1.12），百分比能跟着等级一起长，
 *   绝对值会随等级被稀释。而 chainCount / slow / slowMs / splash 这类「本来就是绝对量」的字段
 *   一律用 { add } 显式写 —— 数量的百分比没有意义（3 个目标 ×1.25 = 3.75 个目标）。
 *
 * ── 叠加规则（顺序无关，可反复推导） ───────────────────────────────
 *   同一字段的三个档位**百分比相加、绝对值相加**，最后一次性算到基准值上：
 *     v = base × (1 + Σpct) + Σadd
 *   刻意**不做连乘**：连乘会让 1.25×1.30×1.35 = 2.19（+119%），远超「三阶累计应约 +40%~+90%」
 *   的设计意图，也让 pick 顺序变成一件能被利用的事。相加之下的满阶收益是可预期的、可审计的。
 *
 * ── 数值取向（改数字前请先读） ───────────────────────────────────
 *   * 单阶加成一律落在 **+15% ~ +35%**（或等价的绝对量）之间：三阶累计约 +80%~+110%，
 *     与「超频」这一既有强化态（伤害 ×1.6）拉开距离，专精是长期成长的复利，不是一次爆发；
 *   * 同一阶的两个选项**必须同维度不同取向**：一个偏伤害、一个偏频率 / 范围 / 控制。
 *     不允许出现「伤害 +25% / 伤害 +30%」这种只是更强的伪选择；
 *   * chainCount 只允许 +1（3 → 4）：主文件的链式衰减是每跳 ×0.8，多一跳的边际收益很高；
 *   * slow 单阶最多 +0.08（且结果被本模块夹到 0.8，与 tower-defense.js 的减速上限一致）；
 *   * auraRate / auraDmg 单阶最多 +0.10 绝对值，结果夹到 1.0（同样是主文件既有上限）；
 *   * auraDmg 的基准值在 Lv.1~3 是 0，所以对 auraDmg **只能写 { add }**，
 *     写百分比会乘在 0 上变成「毫无效果」的假选项。
 */

/** 三次专精机会的等级档（必须严格递增；applySpecialization 按此顺序叠加） */
export const SPEC_TIERS = [10, 25, 50];

/**
 * 允许被 mod 修改的字段 —— 白名单，而不是「有啥改啥」。
 * 两个理由：1) mod 里写错字段名（dmg → damage）会静默无效，白名单能把它变成可测的失败；
 * 2) upgradeCost 被刻意排除：专精是战斗成长，不该偷偷改升级价，否则经济曲线会被绕过。
 * 其余字段与 towerStat() 的返回字段一一对应。
 */
const MOD_FIELDS = ['dmg', 'rate', 'range', 'splash', 'slow', 'slowMs',
  'auraRate', 'auraDmg', 'poisonDps', 'pushTiles', 'chainCount'];

// 与 tower-defense.js 的既有上限对齐，专精不得突破（那里的 Math.min 是「上限」，不是建议值）
const MAX_SLOW = 0.8;      // 减速上限 80%
const MAX_AURA = 1;        // 光环增幅上限 +100%
const INT_FIELDS = ['chainCount']; // 目标数量必须是整数

/**
 * 7 种塔 × 3 阶 × 2 选项。
 * 键顺序 = TOWER_TYPES（4 种基础塔）在前、SPECIAL_TOWER_TYPES（3 种特殊塔）在后，
 * 与 tower-defense.js 的 ALL_TOWER_TYPES 展开顺序一致，UI 遍历时不需要再排序。
 * id 编码：`<塔><档位><a|b>`，a 偏伤害 / 绝对量，b 偏频率 / 范围 / 控制；全局唯一，供 specById 反查。
 */
export const SPECIALIZATIONS = {
  arrow: {
    10: [
      { id: 'arrow10a', name: '锐矢', desc: '伤害 +25%', mod: { dmg: 0.25 } },
      { id: 'arrow10b', name: '快弦', desc: '攻速 +20%', mod: { rate: 0.2 } },
    ],
    25: [
      { id: 'arrow25a', name: '破甲', desc: '伤害 +30%', mod: { dmg: 0.3 } },
      { id: 'arrow25b', name: '长弓', desc: '射程 +25%', mod: { range: 0.25 } },
    ],
    50: [
      { id: 'arrow50a', name: '齐射', desc: '伤害 +35%', mod: { dmg: 0.35 } },
      { id: 'arrow50b', name: '疾风', desc: '攻速 +30%', mod: { rate: 0.3 } },
    ],
  },
  cannon: {
    10: [
      { id: 'cannon10a', name: '重弹', desc: '伤害 +25%', mod: { dmg: 0.25 } },
      { id: 'cannon10b', name: '速装', desc: '攻速 +20%', mod: { rate: 0.2 } },
    ],
    25: [
      { id: 'cannon25a', name: '破片弹', desc: '溅射半径 +12', mod: { splash: { add: 12 } } },
      { id: 'cannon25b', name: '长炮管', desc: '射程 +25%', mod: { range: 0.25 } },
    ],
    50: [
      { id: 'cannon50a', name: '攻坚弹', desc: '伤害 +35%', mod: { dmg: 0.35 } },
      { id: 'cannon50b', name: '速射机', desc: '攻速 +30%', mod: { rate: 0.3 } },
    ],
  },
  frost: {
    10: [
      { id: 'frost10a', name: '霜刺', desc: '伤害 +25%', mod: { dmg: 0.25 } },
      { id: 'frost10b', name: '蔓延', desc: '攻速 +20%', mod: { rate: 0.2 } },
    ],
    25: [
      { id: 'frost25a', name: '深寒', desc: '减速 +6 个百分点', mod: { slow: { add: 0.06 } } },
      { id: 'frost25b', name: '冻缓', desc: '减速持续 +500ms', mod: { slowMs: { add: 500 } } },
    ],
    50: [
      { id: 'frost50a', name: '绝对零度', desc: '减速 +8 个百分点（上限 80%）', mod: { slow: { add: 0.08 } } },
      { id: 'frost50b', name: '极寒领域', desc: '射程 +30%', mod: { range: 0.3 } },
    ],
  },
  aura: {
    10: [
      { id: 'aura10a', name: '增幅共鸣', desc: '攻速增幅 +25%', mod: { auraRate: 0.25 } },
      { id: 'aura10b', name: '扩域', desc: '光环范围 +20%', mod: { range: 0.2 } },
    ],
    25: [
      // auraDmg 基准为 0，只能写绝对值；写成百分比会乘在 0 上，是个「什么都没有」的假选项
      { id: 'aura25a', name: '增伤共鸣', desc: '伤害增幅 +10 个百分点', mod: { auraDmg: { add: 0.1 } } },
      { id: 'aura25b', name: '速频', desc: '攻速增幅 +30%', mod: { auraRate: 0.3 } },
    ],
    50: [
      { id: 'aura50a', name: '共振强化', desc: '伤害增幅 +15 个百分点', mod: { auraDmg: { add: 0.15 } } },
      { id: 'aura50b', name: '全域覆盖', desc: '光环范围 +30%', mod: { range: 0.3 } },
    ],
  },
  tesla: {
    10: [
      { id: 'tesla10a', name: '高压', desc: '伤害 +25%', mod: { dmg: 0.25 } },
      { id: 'tesla10b', name: '迅雷', desc: '攻速 +20%', mod: { rate: 0.2 } },
    ],
    25: [
      // 链式目标只 +1：每跳衰减 ×0.8，3 跳 → 4 跳的边际收益已经很高，再往上会变成清场
      { id: 'tesla25a', name: '连锁', desc: '链式目标 +1', mod: { chainCount: { add: 1 } } },
      { id: 'tesla25b', name: '长弧', desc: '射程 +25%', mod: { range: 0.25 } },
    ],
    50: [
      { id: 'tesla50a', name: '超载弧', desc: '伤害 +35%', mod: { dmg: 0.35 } },
      { id: 'tesla50b', name: '电弧频率', desc: '攻速 +30%', mod: { rate: 0.3 } },
    ],
  },
  poison: {
    10: [
      { id: 'poison10a', name: '浓毒', desc: '毒伤 +25%', mod: { poisonDps: 0.25 } },
      { id: 'poison10b', name: '快喷', desc: '喷吐频率 +20%', mod: { rate: 0.2 } },
    ],
    25: [
      { id: 'poison25a', name: '腐蚀', desc: '毒伤 +30%', mod: { poisonDps: 0.3 } },
      { id: 'poison25b', name: '扩散', desc: '射程 +25%', mod: { range: 0.25 } },
    ],
    50: [
      { id: 'poison50a', name: '剧毒', desc: '毒伤 +35%', mod: { poisonDps: 0.35 } },
      { id: 'poison50b', name: '喷流', desc: '喷吐频率 +30%', mod: { rate: 0.3 } },
    ],
  },
  force: {
    10: [
      { id: 'force10a', name: '强场', desc: '推回距离 +25%', mod: { pushTiles: 0.25 } },
      { id: 'force10b', name: '快脉', desc: '脉冲频率 +20%', mod: { rate: 0.2 } },
    ],
    25: [
      { id: 'force25a', name: '厚重', desc: '推回距离 +30%', mod: { pushTiles: 0.3 } },
      { id: 'force25b', name: '广域', desc: '射程 +25%', mod: { range: 0.25 } },
    ],
    50: [
      { id: 'force50a', name: '斥力', desc: '推回距离 +35%', mod: { pushTiles: 0.35 } },
      { id: 'force50b', name: '力场脉动', desc: '脉冲频率 +30%', mod: { rate: 0.3 } },
    ],
  },
};

/** 档位归一化：接受 10 / '10' / 10.0，其余（含 null / NaN / '10abc' / 999）一律不像话 */
function normalizeTier(tier) {
  if (typeof tier === 'string' && tier.trim() === '') return NaN;
  const n = Number(tier);
  if (!Number.isInteger(n)) return NaN;
  return SPEC_TIERS.includes(n) ? n : NaN;
}

/**
 * 某座塔某个档位的两个选项。
 * @param {string} type 塔类型（arrow / cannon / … / force）
 * @param {number} tier 10 / 25 / 50
 * @returns {object[]} 非法 type / tier 一律返回 []（绝不抛异常，UI 可以直接 spread）
 */
export function specOptions(type, tier) {
  const t = normalizeTier(tier);
  if (!Number.isFinite(t) || typeof type !== 'string') return [];
  const byTier = SPECIALIZATIONS[type];
  if (!byTier || !Object.prototype.hasOwnProperty.call(byTier, t)) return [];
  const list = byTier[t];
  return Array.isArray(list) ? list.slice() : []; // 返回副本：调用方 sort/splice 不会污染表
}

/**
 * 按 id 反查专精。
 * @param {string} id
 * @returns {{type:string, tier:number, option:object}|null} 找不到返回 null
 *   注意 option 是表里的**同一个引用**：只读，不要就地改（要改请改 SPECIALIZATIONS 里的那一行）。
 */
export function specById(id) {
  if (typeof id !== 'string' || id === '') return null;
  for (const type of Object.keys(SPECIALIZATIONS)) {
    const byTier = SPECIALIZATIONS[type];
    for (const tier of SPEC_TIERS) {
      const list = byTier[tier];
      if (!Array.isArray(list)) continue;
      for (const option of list) {
        if (option && option.id === id) return { type, tier, option };
      }
    }
  }
  return null;
}

/** 把一个 mod 修饰拆成 { pct, add }；非法修饰返回 null（该条被跳过） */
function splitMod(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { pct: raw, add: 0 } : null;
  }
  if (raw && typeof raw === 'object') {
    const pct = Number.isFinite(raw.pct) ? raw.pct : 0;
    const add = Number.isFinite(raw.add) ? raw.add : 0;
    if (pct === 0 && add === 0) return null; // 空修饰：不产生任何字段写入，保持 out 干净
    return { pct, add };
  }
  return null;
}

/**
 * 把已选专精叠加到 towerStat() 的输出上，返回**新对象**（入参一个字节都不动）。
 *
 * 等级闸不在这里判：调用方用 `tower.lv >= tier` 决定「能不能选」。本函数只负责两件事：
 *   1) 跳过非法 pick —— id 不存在 / 不是字符串 / **越阶**（把 arrow50a 塞进 picks[10] 也会被跳过，
 *      否则一次「提前选中」就能白拿 50 阶的加成，等级闸形同虚设）；
 *   2) 按「百分比相加、绝对值相加」算到基准值上，并夹住主文件的既有上限。
 *
 * stat 里**必填**的字段就是它要用到的那些：某字段在 stat 里缺失或非有限数时按 0 处理
 * （例如给 arrow 的 stat 里没有 chainCount，而 pick 恰好改 chainCount，结果就是 0 + add）。
 * picks 形如 `{ 10: 'arrow10a', 25: 'arrow25b' }`；缺档 / 空对象 / null / 非对象 → 原样副本。
 *
 * 注意：stat 里没有塔类型，本函数**无法**校验 pick 是否属于这座塔。调用方应自己保证
 * `specById(id).type === tower.type`（specSummary 已内置这条校验，可直接拿来对齐 UI）。
 *
 * @param {object} stat towerStat(type, lv, oc) 的返回值
 * @param {object} picks { [tier]: optionId }
 * @returns {object} 新的 stat 对象
 */
export function applySpecialization(stat, picks) {
  if (!stat || typeof stat !== 'object') return {}; // 没有可修正的对象时返回空表，而不是补一堆 0
  const out = { ...stat };
  const pctAcc = Object.create(null);
  const addAcc = Object.create(null);

  if (picks && typeof picks === 'object') {
    for (const tier of SPEC_TIERS) {
      const id = picks[tier];
      if (typeof id !== 'string') continue;          // 没选 / 非法：整档跳过
      const hit = specById(id);
      if (!hit || hit.tier !== tier) continue;        // 不存在 或 越阶 → 跳过
      if (!hit.option.mod || typeof hit.option.mod !== 'object') continue;
      for (const field of Object.keys(hit.option.mod)) {
        if (!MOD_FIELDS.includes(field)) continue;    // 白名单外的字段（含 upgradeCost）一律忽略
        const m = splitMod(hit.option.mod[field]);
        if (!m) continue;
        pctAcc[field] = (pctAcc[field] || 0) + m.pct;
        addAcc[field] = (addAcc[field] || 0) + m.add;
      }
    }
  }

  const touched = Object.keys(pctAcc);
  for (const field of Object.keys(addAcc)) if (!touched.includes(field)) touched.push(field);

  for (const field of touched) {
    const base = Number.isFinite(out[field]) ? out[field] : 0;
    let v = base * (1 + (pctAcc[field] || 0)) + (addAcc[field] || 0);
    if (v < 0) v = 0;                                  // 属性不为负：负修正最多归零，不出现 -27 伤害
    if (field === 'slow' && v > MAX_SLOW) v = MAX_SLOW;
    if ((field === 'auraRate' || field === 'auraDmg') && v > MAX_AURA) v = MAX_AURA;
    if (INT_FIELDS.includes(field)) v = Math.round(v);  // 目标数取整，避免 3.75 个目标这种中间态
    out[field] = v;
  }
  return out;
}

/**
 * 给 UI 的一行文案：已选专精的名字按档位顺序用「 · 」连起来。
 * 校验比 applySpecialization 更严 —— 这里知道 type，所以**跨塔的 id 也会被丢掉**，
 * 免得「给箭塔显示冰塔专精名」这种串台的 UI 文案。
 * @param {string} type
 * @param {object} picks { [tier]: optionId }
 * @returns {string} 一个都没选时返回空串（UI 用 `if (s)` 决定要不要画这一行）
 */
export function specSummary(type, picks) {
  const names = [];
  if (picks && typeof picks === 'object') {
    for (const tier of SPEC_TIERS) {
      const id = picks[tier];
      if (typeof id !== 'string') continue;
      const hit = specById(id);
      if (!hit || hit.tier !== tier || hit.type !== type) continue;
      if (hit.option.name) names.push(hit.option.name);
    }
  }
  return names.join(' · ');
}
