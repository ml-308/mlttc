// tools/td-spec-test/run.mjs
// 塔专精模块 src/pages/td-specialization.js 的无依赖自检
// （零依赖、不联网、不写临时文件、不改任何被测文件）。
//
// 用法：node tools/td-spec-test/run.mjs
//   模块未就绪（文件不存在 / 导入失败 / 缺导出）→ 打印「等待模块」，退出码 2
//     （并行开发期间把「还没写完」报成「断言失败」是假信号，与 tools/td-skills-test 同一约定）
//   就绪且断言全过 → PASS n/n，退出码 0
//   就绪但有断言失败 → FAIL n/m + 首个失败详情，退出码 1
//
// 为什么用 data: URL 导入：仓库根 package.json 是 "type":"commonjs"，而 src/pages/*.js 是 ESM，
// 直接 import 会按 CJS 解析并语法报错；这里读源码后用 data:text/javascript;base64 导入，
// 等价于「把源码当 ESM 执行」，测的就是真实源码（与 tools/td-wave-test、tools/td-skills-test 同一做法）。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

// ─── 测试框架 ────────────────────────────────────────────────

let passed = 0;
const failures = [];

function show(v) {
    try {
        if (typeof v === 'function') return '[Function]';
        const s = JSON.stringify(v);
        if (s === undefined) return String(v);
        return s.length > 160 ? `${s.slice(0, 157)}...` : s;
    } catch {
        return String(v);
    }
}

function record(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failures.push({ name, detail: detail || '' });
        console.log(`  FAIL ${name}${detail ? '  ← ' + detail : ''}`);
    }
}

const ok = (name, cond, detail) => record(name, !!cond, detail);
const eq = (name, actual, expected) => record(name, actual === expected,
    `期望 ${show(expected)}，实际 ${show(actual)}`);
const deepEq = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${show(expected)}，实际 ${show(actual)}`);

function near(name, actual, expected, tol = 1e-9) {
    record(name, typeof actual === 'number' && Math.abs(actual - expected) <= tol,
        `期望 ${show(expected)}（±${tol}），实际 ${show(actual)}`);
}
function within(name, actual, lo, hi) {
    record(name, typeof actual === 'number' && actual >= lo && actual <= hi,
        `期望落在 [${lo}, ${hi}]，实际 ${show(actual)}`);
}

const section = (title) => console.log(`\n[${title}]`);

// ─── 被测模块加载 ────────────────────────────────────────────

const EXPORTS = ['SPEC_TIERS', 'SPECIALIZATIONS', 'specOptions', 'specById',
    'applySpecialization', 'specSummary'];

async function loadModule() {
    const abs = path.join(root, 'src', 'pages', 'td-specialization.js');
    if (!existsSync(abs)) return { state: 'missing', reason: '文件不存在（可能正在编写）' };
    let mod;
    try {
        const source = readFileSync(abs, 'utf8');
        mod = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
    } catch (e) {
        return { state: 'broken', reason: `无法作为 ESM 导入：${e.message}` };
    }
    const lacking = EXPORTS.filter((n) => mod[n] === undefined);
    if (lacking.length > 0) return { state: 'incomplete', reason: `缺少导出：${lacking.join(', ')}` };
    return { state: 'ready', mod };
}

const load = await loadModule();
if (load.state !== 'ready') {
    console.log('\n[等待模块] src/pages/td-specialization.js 尚未就绪（这不是失败）：');
    console.log(`  ..   ${load.reason}`);
    console.log('等模块写完后再跑一次：node tools/td-spec-test/run.mjs');
    console.log('WAITING 退出码 2（1 个模块未就绪）');
    process.exit(2);
}

const { SPEC_TIERS, SPECIALIZATIONS, specOptions, specById, applySpecialization, specSummary } = load.mod;

const TOWERS = ['arrow', 'cannon', 'frost', 'aura', 'tesla', 'poison', 'force'];
const TIERS = [10, 25, 50];

// 参考基准：字段名 / 量级都贴 towerStat() 的真实输出（Lv.3 那档），
// 这样断言里的算术和战场上的数字是同一套口径。
const baseStat = () => ({
    dmg: 8, rate: 1.6, range: 130, auraRate: 0.35, auraDmg: 0.15, splash: 65,
    slow: 0.55, slowMs: 1800, poisonDps: 40, pushTiles: 1.2, chainCount: 3,
    upgradeCost: 220,
});

/** 取一个 option 的 mod 里唯一的字段名（本模块约定每个选项只动一个字段） */
const modField = (option) => {
    const keys = option && option.mod && typeof option.mod === 'object' ? Object.keys(option.mod) : [];
    return keys.length === 1 ? keys[0] : `（${keys.length} 个字段：${keys.join(',')}）`;
};
/** 该 mod 字段的 { pct, add }（数字 = 百分比，{add} = 绝对值） */
function shapeOf(mod, field) {
    const raw = mod && mod[field];
    if (typeof raw === 'number') return { pct: raw, add: 0 };
    if (raw && typeof raw === 'object') return { pct: raw.pct || 0, add: raw.add || 0 };
    return { pct: 0, add: 0 };
}

/** 扁平化成 [{ type, tier, id, name, desc, field, pct, add }]，供整表断言复用 */
const allOptions = [];
for (const type of TOWERS) {
    for (const tier of TIERS) {
        for (const option of specOptions(type, tier)) {
            const field = modField(option);
            allOptions.push({ type, tier, option, id: option && option.id, name: option && option.name,
                desc: option && option.desc, field, ...shapeOf(option && option.mod, field) });
        }
    }
}

// ═══ 1. 数据形状：7 塔 × 3 阶 × 恰好 2 选项 ═════════════════════

section('1. SPEC_TIERS 与「7 塔 × 3 阶 = 21 组，每组恰好 2 个选项」');
deepEq('SPEC_TIERS = [10, 25, 50]', SPEC_TIERS, [10, 25, 50]);
deepEq('SPECIALIZATIONS 的键顺序 = 4 基础塔 + 3 特殊塔',
    Object.keys(SPECIALIZATIONS || {}), TOWERS);
deepEq('每种塔都恰好有 10/25/50 三档', TOWERS.filter((t) => {
    const byTier = SPECIALIZATIONS[t];
    return !byTier || JSON.stringify(Object.keys(byTier).map(Number)) !== JSON.stringify(TIERS);
}), []);
const badCount = [];
for (const type of TOWERS) {
    for (const tier of TIERS) {
        const list = specOptions(type, tier);
        if (!Array.isArray(list) || list.length !== 2) badCount.push(`${type}@${tier}:${show(list && list.length)}`);
    }
}
deepEq('21 组「塔 × 阶」每组都返回恰好 2 个选项', badCount, []);
eq('扁平后的选项总数 = 42', allOptions.length, 42);

// ═══ 2. id 唯一 + specById 反查 ═════════════════════════════════

section('2. option id 全局唯一，且能被 specById 反查回 (type, tier, option)');
const ids = allOptions.map((o) => o.id);
eq('42 个 id 互不重复', new Set(ids).size, ids.length);
deepEq('id 都是非空字符串', ids.filter((x) => typeof x !== 'string' || x.length === 0), []);
deepEq('id 编码符合 <塔><档位><a|b>（与所在塔/阶一致）', allOptions.filter((o) => {
    const m = /^([a-z]+)(10|25|50)([ab])$/.exec(String(o.id));
    return !m || m[1] !== o.type || Number(m[2]) !== o.tier;
}).map((o) => `${o.type}@${o.tier}:${o.id}`), []);
const badLookup = allOptions.filter((o) => {
    const hit = specById(o.id);
    return !hit || hit.type !== o.type || hit.tier !== o.tier || hit.option !== o.option;
}).map((o) => o.id);
deepEq('每个 id 走 specById 都能取回「同一份定义 + 正确的塔与档位」', badLookup, []);
eq('specById 取回的 option 与表里是同一个引用（不是拷贝）',
    specById('arrow10a').option === specOptions('arrow', 10)[0], true);
eq('specById 对未知 id 返回 null', specById('__no_such__'), null);
deepEq('specById 对非字符串返回 null', [specById(null), specById(10), specById({})],
    [null, null, null]);

// ═══ 3. name / desc / 同一维度不同取向 ═══════════════════════════

section('3. name / desc 非空；每组两选项「同维度不同取向」（一个字段，且互不相同）');
deepEq('42 个选项 name 与 desc 都非空', allOptions.filter((o) =>
    typeof o.name !== 'string' || o.name.length === 0
    || typeof o.desc !== 'string' || o.desc.length === 0).map((o) => o.id), []);
deepEq('每个选项只动 1 个字段（mod 恰好一个键）', allOptions.filter((o) =>
    typeof o.field !== 'string' || o.field.startsWith('（')).map((o) => `${o.id}:${o.field}`), []);
const badPair = [];
for (const type of TOWERS) {
    for (const tier of TIERS) {
        const [a, b] = specOptions(type, tier);
        if (modField(a) === modField(b)) badPair.push(`${type}@${tier} 都是 ${modField(a)}`);
    }
}
deepEq('同组两个选项改的字段不同（不会退化成「伤害+X / 伤害+Y」的伪选择）', badPair, []);
console.log(`  字段分布：${TOWERS.map((t) => `${t}=[${TIERS.map((tr) => specOptions(t, tr).map((o) => modField(o)).join('/')).join(' ')}]`).join('  ')}`);

// ═══ 4. 数值保守性（单阶加成区间 / chainCount / slow） ══════════

section('4. 数值保守性：百分比落 +15%~+35%、chainCount 只 +1、slow ≤ +0.08');
const pctBad = allOptions.filter((o) => o.pct !== 0 && !(o.pct >= 0.15 && o.pct <= 0.35))
    .map((o) => `${o.id}:${o.pct}`);
deepEq('所有百分比加成都落在 +15%~+35%', pctBad, []);
eq('百分比加成至少覆盖 20 个选项（每种塔每档都有可量的百分比取向）',
    allOptions.filter((o) => o.pct !== 0).length >= 20, true);
const chainOpts = allOptions.filter((o) => o.field === 'chainCount');
ok('至少有一个 chainCount 专精（特斯拉 25 阶）', chainOpts.length >= 1, `实际 ${chainOpts.length} 个`);
deepEq('chainCount 只允许 +1 绝对值（不允许百分比、不允许 +2）',
    chainOpts.filter((o) => o.add !== 1 || o.pct !== 0).map((o) => o.id), []);
const slowOpts = allOptions.filter((o) => o.field === 'slow');
ok('至少有一个减速专精（冰塔 25/50 阶）', slowOpts.length >= 2, `实际 ${slowOpts.length} 个`);
deepEq('slow 单阶最多 +0.08，且只能写绝对值',
    slowOpts.filter((o) => !(o.add > 0 && o.add <= 0.08 && o.pct === 0)).map((o) => `${o.id}:${show(o.add)}`), []);
const addBad = allOptions.filter((o) => o.add !== 0 && ['chainCount', 'slow'].indexOf(o.field) < 0 && o.add <= 0);
deepEq('其余绝对值加成都是正数（不做无意义的负修饰）', addBad.map((o) => o.id), []);

// ═══ 5. specOptions 非法输入 ═════════════════════════════════════

section('5. specOptions 对非法 type / tier 一律返回 []');
deepEq('未知塔类型 → []', [specOptions('__nope__', 10), specOptions('', 10), specOptions(null, 10),
    specOptions(undefined, 10), specOptions(42, 10)], [[], [], [], [], []]);
deepEq('非法档位 → []（含 0 / 999 / NaN / 非数字字符串 / 空串）',
    [specOptions('arrow', 0), specOptions('arrow', 999), specOptions('arrow', NaN),
        specOptions('arrow', 'abc'), specOptions('arrow', ''), specOptions('arrow', null),
        specOptions('arrow', undefined), specOptions('arrow', 12.5)],
    [[], [], [], [], [], [], [], []]);
eq('合法档位写成字符串也认（"10" 与 10 等价）',
    JSON.stringify(specOptions('arrow', '10')), JSON.stringify(specOptions('arrow', 10)));
const mut = specOptions('arrow', 10);
mut.length = 0;
eq('返回的是副本：改它不会污染表', specOptions('arrow', 10).length, 2);

// ═══ 6. applySpecialization：不改入参 ═══════════════════════════

section('6. applySpecialization 返回新对象、入参一个字节都不动');
const base = baseStat();
const snapshot = JSON.stringify(base);
const one = applySpecialization(base, { 10: 'arrow10a' });
ok('返回值是另一个对象（!== 入参）', one !== base, '返回了同一个引用');
eq('入参在调用后与调用前逐字节相同（深比较）', JSON.stringify(base), snapshot);
deepEq('未选专精（空 picks）→ 只多一层副本，数值全等', applySpecialization(base, {}), baseStat());
deepEq('picks 为 null / 非对象 → 同样只返回副本', [applySpecialization(base, null),
    applySpecialization(base, 'arrow10a'), applySpecialization(base, 42)], [baseStat(), baseStat(), baseStat()]);
deepEq('stat 非法（null / 字符串）→ 返回空对象而不是抛异常',
    [applySpecialization(null, { 10: 'arrow10a' }), applySpecialization('x', {})], [{}, {}]);
eq('upgradeCost 不参与专精（经济曲线不被绕过）',
    applySpecialization(base, { 10: 'arrow10a' }).upgradeCost, baseStat().upgradeCost);

// ═══ 7. 单阶加成生效 ═══════════════════════════════════════════

section('7. 单阶加成生效（数值对比）');
near('arrow + 锐矢(dmg +25%)：8 → 10', applySpecialization(base, { 10: 'arrow10a' }).dmg, 10);
near('arrow + 快弦(rate +20%)：1.6 → 1.92', applySpecialization(base, { 10: 'arrow10b' }).rate, 1.92);
near('tesla + 连锁(chainCount +1)：3 → 4', applySpecialization(base, { 25: 'tesla25a' }).chainCount, 4);
near('frost + 深寒(slow +0.06)：0.55 → 0.61', applySpecialization(base, { 25: 'frost25a' }).slow, 0.61);
near('frost + 冻缓(slowMs +500)：1800 → 2300', applySpecialization(base, { 25: 'frost25b' }).slowMs, 2300);
near('cannon + 破片弹(splash +12)：65 → 77', applySpecialization(base, { 25: 'cannon25a' }).splash, 77);
near('aura + 增伤共鸣(auraDmg +0.10)：0.15 → 0.25', applySpecialization(base, { 25: 'aura25a' }).auraDmg, 0.25);
near('force + 强场(pushTiles +25%)：1.2 → 1.5', applySpecialization(base, { 10: 'force10a' }).pushTiles, 1.5);
near('poison + 浓毒(poisonDps +25%)：40 → 50', applySpecialization(base, { 10: 'poison10a' }).poisonDps, 50);
near('只动被选中的字段（未选 dmg 时 dmg 原样）',
    applySpecialization(base, { 10: 'arrow10b' }).dmg, baseStat().dmg);

// ═══ 8. 多档叠加（相加而非连乘，且与 pick 顺序无关） ═════════════

section('8. 多档叠加：同字段百分比相加、绝对值相加、与 pick 顺序无关');
const threeDmg = applySpecialization(base, { 10: 'arrow10a', 25: 'arrow25a', 50: 'arrow50a' });
near('三档全选伤害：8 × (1+0.25+0.30+0.35) = 15.2', threeDmg.dmg, 15.2);
ok('叠加明确小于连乘（8×1.25×1.30×1.35 = 17.55）', threeDmg.dmg < 17.55,
    `实际 ${show(threeDmg.dmg)}`);
near('混合维度叠加（伤害 + 攻速）互不干扰',
    applySpecialization(base, { 10: 'arrow10a', 50: 'arrow50b' }).rate, 1.6 * 1.3);
const twoSlow = applySpecialization(base, { 25: 'frost25a', 50: 'frost50a' });
near('两个减速档相加：0.55 + 0.06 + 0.08 = 0.69', twoSlow.slow, 0.69);
const ordered = { 50: 'arrow50a', 25: 'arrow25a', 10: 'arrow10a' };
deepEq('pick 的书写顺序不影响结果（对象键序颠倒后逐字段相同）',
    applySpecialization(base, ordered), threeDmg);
deepEq('两座塔各自只吃自己的档位（不串台）',
    [applySpecialization(base, { 10: 'frost10a' }).dmg, applySpecialization(base, { 10: 'arrow10a' }).dmg],
    [10, 10]);

// ═══ 9. 非法 pick 被跳过（不抛异常） ═════════════════════════════

section('9. 非法 / 缺档 / 越阶 pick 被跳过，绝不抛异常');
let threw = null;
try {
    applySpecialization(base, { 10: '__nope__', 25: 42, 50: null });
} catch (e) { threw = e.message; }
eq('整组非法 pick 不抛异常', threw, null);
deepEq('整组非法 pick 时数值原样返回', applySpecialization(base, { 10: '__nope__', 25: 42, 50: null }), baseStat());
near('只选 50 阶（10/25 档缺省）时该档仍然生效：8 × 1.35 = 10.8',
    applySpecialization(base, { 50: 'arrow50a' }).dmg, 10.8);
near('越阶 pick 被跳过：把 arrow50a 塞进 picks[10] 只拿到 baseline',
    applySpecialization(base, { 10: 'arrow50a' }).dmg, baseStat().dmg);
near('越阶 pick 不影响同组合法 pick：{10:arrow50a, 50:arrow50a} → 只有 50 阶生效',
    applySpecialization(base, { 10: 'arrow50a', 50: 'arrow50a' }).dmg, 10.8);
const polluted = { 10: 'arrow10a', 25: null, 50: undefined };
deepEq('null / undefined 档位被跳过，其余照常', applySpecialization(base, polluted).dmg, 10);

// ═══ 10. 上限夹取（与主文件既有上限一致） ═══════════════════════

section('10. 上限夹取：slow ≤ 0.8、auraRate/auraDmg ≤ 1、属性不为负、chainCount 取整');
const highSlow = applySpecialization({ ...baseStat(), slow: 0.78 }, { 50: 'frost50a' });
near('slow 0.78 + 0.08 → 夹到 0.8（不越过主文件的 80% 上限）', highSlow.slow, 0.8);
const highAura = applySpecialization({ ...baseStat(), auraRate: 0.95 }, { 25: 'aura25b' });
near('auraRate 0.95 × 1.3 → 夹到 1.0', highAura.auraRate, 1);
eq('chainCount 结果取整（整数个目标）',
    Number.isInteger(applySpecialization(base, { 25: 'tesla25a' }).chainCount), true);
const noChain = applySpecialization({ dmg: 8, rate: 1.6 }, { 25: 'tesla25a' });
eq('stat 里缺 chainCount（非有限数）时按 0 处理 → 0 + 1 = 1', noChain.chainCount, 1);
eq('stat 里缺失的字段不会凭空出现（只有 mod 动过的字段才会被补）', 'range' in noChain, false);
near('负向基准被修正后仍不为负（-8 × 1.25 → 夹到 0，不出现 -10 伤害）',
    applySpecialization({ ...baseStat(), dmg: -8 }, { 10: 'arrow10a' }).dmg, 0);

// ═══ 11. specSummary ════════════════════════════════════════════

section('11. specSummary 文案（空 picks / 单档 / 三档 / 跨塔串台）');
const empty = specSummary('arrow', {});
ok('空 picks 返回空串或「未专精」', empty === '' || empty === '未专精', `实际 ${show(empty)}`);
deepEq('picks 为 null / 非对象同样返回空串', [specSummary('arrow', null), specSummary('arrow', {})], ['', '']);
eq('单档 → 只有该专精名', specSummary('arrow', { 10: 'arrow10a' }), '锐矢');
eq('三档 → 按档位顺序用「 · 」连接',
    specSummary('arrow', { 10: 'arrow10a', 25: 'arrow25a', 50: 'arrow50a' }), '锐矢 · 破甲 · 齐射');
eq('pick 键序颠倒也按档位顺序输出',
    specSummary('arrow', { 50: 'arrow50a', 25: 'arrow25a', 10: 'arrow10a' }), '锐矢 · 破甲 · 齐射');
eq('缺中间的档位 → 只连已选的', specSummary('frost', { 10: 'frost10a', 50: 'frost50a' }), '霜刺 · 绝对零度');
eq('跨塔的 pick 被丢掉（不给箭塔显示冰塔专精名）', specSummary('arrow', { 10: 'frost10a' }), '');
eq('未知 id 被丢掉', specSummary('arrow', { 10: '__nope__' }), '');
const summaryAll = TOWERS.map((t) => specSummary(t, { 10: specOptions(t, 10)[0].id }));
deepEq('每座塔单选首档都能得到非空文案', summaryAll.filter((s) => !s).length, 0);

// ═══ 12. 形实一致：desc 里的百分比与 mod 数值对齐 ═══════════════

section('12. desc 与 mod 数值一致（文案不是手写的第二份真值）');
const descBad = allOptions.filter((o) => {
    if (o.pct === 0) return false;
    const pctInText = Math.round(o.pct * 100);
    return String(o.desc).indexOf(`+${pctInText}%`) < 0;
}).map((o) => `${o.id}（${o.desc} vs ${o.pct}）`);
deepEq('所有百分比选项的 desc 里都写着同一个百分比', descBad, []);
const slowDescBad = slowOpts.filter((o) => String(o.option.desc).indexOf(`+${Math.round(o.add * 100)}`) < 0)
    .map((o) => o.id);
deepEq('减速选项的 desc 写的是同一个百分点数', slowDescBad, []);

// ─── 汇总 ───────────────────────────────────────────────────

const total = passed + failures.length;
console.log('');
if (failures.length === 0) {
    console.log(`PASS ${passed}/${total}`);
    process.exit(0);
} else {
    console.log(`FAIL ${passed}/${total}`);
    console.log(`首个失败：${failures[0].name}`);
    if (failures[0].detail) console.log(`详情：${failures[0].detail}`);
    process.exit(1);
}
