// tools/td-affix-test/run.mjs
// 塔防「波次词缀」模块的无依赖自检（零依赖、不联网、不写临时文件、不改被测文件）。
//
// 用法：node tools/td-affix-test/run.mjs
//   全通过 → PASS n/n，退出码 0；有失败 → FAIL n/m + 首个失败详情，退出码 1。
//
// 为什么用 data: URL 导入：仓库根 package.json 是 "type": "commonjs"，而 src/pages/*.js
// 是 ESM，直接按路径 import 会当 CJS 解析并语法报错。这里读源码后用
// `data:text/javascript;base64,` 导入，等价于「把源码当 ESM 执行」，测的就是真实源码
// （与 tools/td-wave-test/run.mjs、tools/td-skills-test/run.mjs 同一做法）。
// 该模块零 import / 零 DOM / 零时钟，Node 下无需任何桩件。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const target = path.join(root, 'src', 'pages', 'td-affixes.js');

// ─── 测试框架（与既有脚本同格式：分节 / ok / FAIL / PASS n/n） ─────

let passed = 0;
const failures = [];

function show(v) {
    try {
        if (typeof v === 'function') return '[Function]';
        const s = JSON.stringify(v);
        if (s === undefined) return String(v);
        return s.length > 160 ? `${s.slice(0, 157)}...` : s;
    } catch { return String(v); }
}

function record(name, condition, detail) {
    if (condition) { passed += 1; console.log(`  ok   ${name}`); }
    else { failures.push({ name, detail: detail || '' }); console.log(`  FAIL ${name}${detail ? '  ← ' + detail : ''}`); }
}

const ok = (name, cond, detail) => record(name, !!cond, detail);
const eq = (name, actual, expected) => record(name, actual === expected, `期望 ${show(expected)}，实际 ${show(actual)}`);
const deepEq = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${show(expected)}，实际 ${show(actual)}`);
const section = (title) => console.log(`\n[${title}]`);
const round2 = (v) => Math.round(v * 100) / 100;

// ─── 加载被测模块 ───────────────────────────────────────────

const NEEDED = ['AFFIXES', 'affixForWave', 'applyAffix', 'affixLabel'];
if (!existsSync(target)) {
    console.log('  FAIL src/pages/td-affixes.js 不存在');
    console.log('FAIL 0/1');
    process.exit(1);
}
let mod;
try {
    const source = readFileSync(target, 'utf8');
    mod = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
} catch (e) {
    console.log(`  FAIL 无法作为 ESM 导入：${e.message}`);
    console.log('FAIL 0/1');
    process.exit(1);
}
const lacking = NEEDED.filter((n) => mod[n] === undefined);
if (lacking.length > 0) {
    console.log(`  FAIL 缺少导出：${lacking.join(', ')}`);
    console.log('FAIL 0/1');
    process.exit(1);
}
const { AFFIXES, affixForWave, applyAffix, affixLabel } = mod;

// ─── 夹具：仿 generateEndlessWave 的输出形状 ─────────────────
// 第 9 波（非 BOSS 波）：三组，count 之和 = total = 26
const W9 = {
    n: 9, total: 26, bossCount: 0, isBossWave: false, spawnGap: 1015,
    groups: [
        { type: 'basic', count: 16, hp: 63, speed: 61.6, bounty: 9, armor: 0 },
        { type: 'swift', count: 6, hp: 71, speed: 106.4, bounty: 7, armor: 0 },
        { type: 'armor', count: 4, hp: 173, speed: 44.8, bounty: 21, armor: 0.25 },
    ],
};
// 第 10 波（BOSS 波）：多一个不占 total 的 BOSS 组
const W10 = {
    ...W9, n: 10, isBossWave: true, bossCount: 1, spawnGap: 1000,
    groups: [...W9.groups.map((g) => ({ ...g })), { type: 'boss', count: 1, hp: 5000, speed: 26, bounty: 126, armor: 0.35 }],
};
const byId = (id) => AFFIXES.find((a) => a && a.id === id);
const snapshot = (w) => JSON.stringify(w);
// 王潮混合词缀：证明 allBoss 换算吃到词缀自己的 hp 系数
const FUSED = { id: 'fused', name: '叠加', desc: '', mul: { hp: 1.6, speed: 0.8, bounty: 1, count: 1 }, flags: { allBoss: true } };
const nonBossSum = (list) => list.reduce((s, g) => s + (g.type === 'boss' ? 0 : g.count), 0);

// ═══ 1. 词缀表形状 ═══════════════════════════════════════════
section('1. AFFIXES 数据形状（≥6 条 / id 唯一 / 字段齐全 / 系数为正）');
ok('AFFIXES 是数组且长度 ≥ 6', Array.isArray(AFFIXES) && AFFIXES.length >= 6, `实际长度 ${show(AFFIXES && AFFIXES.length)}`);
const ids = AFFIXES.map((a) => a && a.id);
eq('id 互不重复', new Set(ids).size, ids.length);
deepEq('id 都是非空字符串', ids.filter((x) => typeof x !== 'string' || x.length === 0), []);
deepEq('每条都有非空 name / desc', AFFIXES.filter((a) => typeof a.name !== 'string' || !a.name
    || typeof a.desc !== 'string' || !a.desc).map((a) => a && a.id), []);
deepEq('每条 mul 的 hp/speed/bounty/count 都是正数', AFFIXES.filter((a) => !a.mul
    || ['hp', 'speed', 'bounty', 'count'].some((k) => typeof a.mul[k] !== 'number' || !(a.mul[k] > 0))
).map((a) => a && a.id), []);
ok('至少有一条带 flags.noSlow', AFFIXES.some((a) => a.flags && a.flags.noSlow === true));
ok('至少有一条带 flags.allBoss', AFFIXES.some((a) => a.flags && a.flags.allBoss === true));
console.log(`  词缀表：${AFFIXES.map((a) => `${a.id}(${a.name})`).join(' ')}`);

// ═══ 2. affixForWave 的波次门槛 ═════════════════════════════
section('2. affixForWave：非 5 的倍数返回 null，5 的倍数必有一条');
deepEq('1/2/3/4/6/7/9/11/13 波都返回 null',
    [1, 2, 3, 4, 6, 7, 9, 11, 13].map((n) => affixForWave(n, 'x')), [null, null, null, null, null, null, null, null, null]);
deepEq('非正数波次（0 / -5 / NaN / undefined）返回 null',
    [affixForWave(0, 'x'), affixForWave(-5, 'x'), affixForWave(NaN, 'x'), affixForWave(undefined, 'x')],
    [null, null, null, null]);
const w5 = affixForWave(5, 'x'), w10 = affixForWave(10, 'x'), w15 = affixForWave(15, 'x');
ok('第 5 波返回某条词缀', !!w5 && ids.includes(w5.id), `实际 ${show(w5 && w5.id)}`);
ok('第 10 波返回某条词缀', !!w10 && ids.includes(w10.id), `实际 ${show(w10 && w10.id)}`);
ok('第 15 波返回某条词缀', !!w15 && ids.includes(w15.id), `实际 ${show(w15 && w15.id)}`);
ok('返回的是 AFFIXES 里的同一个对象（可直接 === 比较）', w5 === byId(w5.id));

// ═══ 3. 确定性 ═══════════════════════════════════════════════
section('3. 确定性：同 (wave, seed) 永远同一条');
deepEq('affixForWave(5,\'x\') 连调两次 id 相同',
    [affixForWave(5, 'x').id, affixForWave(5, 'x').id], [w5.id, w5.id]);
const unstable = [];
for (let n = 5; n <= 500; n += 5) if (affixForWave(n, 'x').id !== affixForWave(n, 'x').id) unstable.push(n);
deepEq('5..500 波全部两两复算一致（0 条漂移）', unstable, []);
const spread = new Set();
for (let n = 5; n <= 500; n += 5) spread.add(affixForWave(n, 'x').id);
ok('5..500 波覆盖 ≥ 3 条不同词缀（哈希不是常量）', spread.size >= 3, `实际覆盖 ${spread.size} 条：${show([...spread])}`);
const diffSeed = [];
for (let n = 5; n <= 100; n += 5) if (affixForWave(n, 'a').id !== affixForWave(n, 'b').id) diffSeed.push(n);
ok('换 seed 会改变抽取结果（seed 真的参与哈希）', diffSeed.length > 0, `若 0 条则 seed 未参与：${show(diffSeed)}`);

// ═══ 4. applyAffix 不改入参 ═════════════════════════════════
section('4. applyAffix 不修改入参（深比较前后）');
const ARMORED = byId('armored'), SURGE = byId('surge'), NO_SLOW = byId('noSlow'), BOSS_RUSH = byId('bossRush');
const before9 = snapshot(W9), before10 = snapshot(W10);
const a9 = applyAffix(W9, ARMORED);
const a10 = applyAffix(W10, BOSS_RUSH);
eq('套普通词缀后 W9 逐字段未变', snapshot(W9), before9);
eq('套王潮后（最激进的改写）W10 逐字段未变', snapshot(W10), before10);
ok('返回值不是入参本身', a9 !== W9);
ok('groups 是新数组', Array.isArray(a9.groups) && a9.groups !== W9.groups);
ok('每个组对象也是新的（不是共享引用）', a9.groups.every((g, i) => g !== W9.groups[i]));
deepEq('W9 各组的 hp/count 仍是原值', W9.groups.map((g) => [g.hp, g.count]), [[63, 16], [71, 6], [173, 4]]);

// ═══ 5. 乘数生效 ═════════════════════════════════════════════
section('5. 乘数生效（hp / speed / bounty / count / total / spawnGap）');
const m = ARMORED.mul;   // hp 1.6 / speed 0.8 / count 1 / bounty 1
deepEq('厚甲：每组 hp = round(原值 × 1.6)',
    a9.groups.map((g) => g.hp), W9.groups.map((g) => Math.round(g.hp * m.hp)));
deepEq('厚甲：每组 speed = round2(原值 × 0.8)',
    a9.groups.map((g) => g.speed), W9.groups.map((g) => round2(g.speed * m.speed)));
deepEq('厚甲：bounty 不变（×1）', a9.groups.map((g) => g.bounty), W9.groups.map((g) => g.bounty));
deepEq('厚甲：count 不变（×1）', a9.groups.map((g) => g.count), W9.groups.map((g) => g.count));
eq('厚甲：spawnGap 不变（÷1）', a9.spawnGap, W9.spawnGap);
const s9 = applyAffix(W9, SURGE);    // count 1.4 / hp 0.8
deepEq('狂潮：每组 count = round(原值 × 1.4)，最小 1',
    s9.groups.map((g) => g.count), [22, 8, 6]);
eq('狂潮：total = 非 BOSS 组 count 之和（重算，不用 round(total×1.4)）',
    s9.total, nonBossSum(s9.groups));
eq('狂潮：total 实测值', s9.total, 36);
eq('狂潮：spawnGap ÷ 1.4（1015 → 725）', s9.spawnGap, 725);
deepEq('狂潮：hp 也乘了 0.8', s9.groups.map((g) => g.hp), W9.groups.map((g) => Math.round(g.hp * 0.8)));
const tiny = applyAffix({ n: 5, total: 3, groups: [{ type: 'basic', count: 3, hp: 40, speed: 55, bounty: 6, armor: 0 }], spawnGap: 150 }, SURGE);
eq('spawnGap 下限钳到 120ms（150 ÷ 1.4 = 107 → 120）', tiny.spawnGap, 120);
const plenty = applyAffix(W9, byId('plenty'));   // bounty ×2
deepEq('丰饶：bounty = round(原值 × 2)', plenty.groups.map((g) => g.bounty), W9.groups.map((g) => Math.round(g.bounty * 2)));
eq('未知字段被原样带出（n / isBossWave）', `${a9.n}/${a9.isBossWave}`, '9/false');

// ═══ 6. 王潮（allBoss） ══════════════════════════════════════
section('6. flags.allBoss：整波只剩一个 BOSS 组');
eq('groups 只剩 1 组', a10.groups.length, 1);
eq('这一组 type = boss', a10.groups[0].type, 'boss');
eq('不会剩下任何小兵组', a10.groups.filter((g) => g.type !== 'boss').length, 0);
eq('BOSS 只数 = ceil(total / 8)（26 → 4）', a10.groups[0].count, Math.ceil(26 / 8));
eq('total 跟着等于 BOSS 只数（HUD 才不会显示 0 只）', a10.total, a10.groups[0].count);
eq('bossCount 也等于 BOSS 只数', a10.bossCount, a10.groups[0].count);
eq('isBossWave 置 true', a10.isBossWave, true);
const expectHp = 600 * (71 / 45);   // 本波 hp 倍率取小兵组最大值（swift 71/45），跳过 boss 组的 ×8
ok('BOSS 血量 = 600 × 本波 hp 倍率（±3 取整误差）', Math.abs(a10.groups[0].hp - expectHp) <= 3,
    `期望 ≈ ${round2(expectHp)}，实际 ${show(a10.groups[0].hp)}`);
ok('估算时跳过了已有 boss 组（否则会叠成 ×8 再 ×8）', a10.groups[0].hp < 600 * 8,
    `实际 ${show(a10.groups[0].hp)}`);
ok('BOSS 护甲 = 0.35', a10.groups[0].armor === 0.35);
const fused = applyAffix(W10, FUSED);
ok('厚甲 + 王潮 叠加：BOSS 吃到词缀自己的 hp 系数（1.6）', fused.groups[0].hp > a10.groups[0].hp * 1.5,
    `无词缀系数 ${show(a10.groups[0].hp)}，叠加后 ${show(fused.groups[0].hp)}`);
ok('王潮的 bounty 系数也生效（×1.6）', a10.groups[0].bounty > 80, `实际 ${show(a10.groups[0].bounty)}`);

// ═══ 7. flags 透传 ══════════════════════════════════════════
section('7. flags 透传（noSlow 交给主循环判断免疫减速）');
const ns = applyAffix(W9, NO_SLOW);
eq('禁魔：结果 flags.noSlow === true', ns.flags.noSlow, true);
ok('flags 是新对象（不与词缀表共享引用）', ns.flags !== NO_SLOW.flags);
eq('普通词缀的 flags 不带 noSlow', a9.flags.noSlow, undefined);
eq('affix 字段带上 id/name 供 UI 用', `${a9.affix.id}/${a9.affix.name}`, 'armored/厚甲');

// ═══ 8. affixLabel 文案 ══════════════════════════════════════
section('8. affixLabel：非空单行、含词缀名、文案与数值一致');
const emptyLabel = AFFIXES.filter((a) => typeof affixLabel(a) !== 'string' || affixLabel(a).length === 0).map((a) => a.id);
deepEq('每条词缀的 label 都是非空字符串', emptyLabel, []);
const noName = AFFIXES.filter((a) => !affixLabel(a).includes(a.name)).map((a) => a.id);
deepEq('每条 label 都含词缀名', noName, []);
ok('label 以「词缀：」开头并带「｜」分隔', affixLabel(ARMORED).startsWith('词缀：') && affixLabel(ARMORED).includes('｜'),
    `实际 ${show(affixLabel(ARMORED))}`);
ok('疾行的 label 含 +50% 与 -30%', affixLabel(byId('swift')).includes('+50%') && affixLabel(byId('swift')).includes('-30%'),
    `实际 ${show(affixLabel(byId('swift')))}`);
ok('禁魔的 label 提到免疫减速', affixLabel(NO_SLOW).includes('免疫减速'), `实际 ${show(affixLabel(NO_SLOW))}`);
ok('王潮的 label 提到 BOSS', affixLabel(BOSS_RUSH).includes('BOSS'), `实际 ${show(affixLabel(BOSS_RUSH))}`);
eq('affixLabel(null) 返回空串（不是 "词缀：undefined"）', affixLabel(null), '');
console.log(`  示例：${affixLabel(byId('swift'))}`);

// ═══ 9. 坏输入与无词缀路径 ══════════════════════════════════
section('9. 坏输入 / 无词缀：不抛异常、返回结构一致的新对象');
const none = applyAffix(W9, null);
eq('affix=null 时字段值不变（hp 原样）', JSON.stringify(none.groups.map((g) => [g.hp, g.count])),
    JSON.stringify(W9.groups.map((g) => [g.hp, g.count])));
ok('affix=null 时仍返回新对象', none !== W9);
deepEq('affix=null 时 affix 字段为 null / flags 为空对象', [none.affix, none.flags], [null, {}]);
const blank = applyAffix(null, SURGE);
deepEq('waveCfg=null 不抛异常：groups 为空数组', blank.groups, []);
const noGroups = applyAffix({ n: 5, spawnGap: 900 }, SURGE);
deepEq('缺 groups 的配置也不抛异常', noGroups.groups, []);
ok('applyAffix 对 undefined 词缀同样安全', !!applyAffix(W9, undefined));

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
