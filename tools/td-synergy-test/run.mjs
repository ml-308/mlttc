// tools/td-synergy-test/run.mjs
// 塔防「技能连携」纯数据/纯函数模块的无依赖自检
// （零依赖、不联网、不写临时文件、不改任何被测文件）。
//
// 用法：node tools/td-synergy-test/run.mjs
//   模块未就绪（文件不存在 / 导入失败 / 缺少导出）→ 打印「等待模块」提示，退出码 2
//   断言全过 → PASS n/n，退出码 0
//   断言失败 → FAIL n/m + 首个失败详情，退出码 1
//
// 退出码 2 的意义：并行开发期间模块可能只写了一半，把它报成「断言失败」是假信号。
//
// 为什么用 data: URL 导入：仓库根 package.json 是 "type":"commonjs"，而 src/pages/*.js 是 ESM。
// 直接 import 那个 .js 会按 CJS 解析并语法报错；这里 readFileSync 读源码后用
// `data:text/javascript;base64,` 导入，等价于「把源码当 ESM 模块执行」，测的就是真实源码
// （与 tools/td-skills-test/run.mjs、tools/td-wave-test/run.mjs 同一做法）。

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

const section = (title) => console.log(`\n[${title}]`);

// ─── 被测模块加载（未就绪 → 退出码 2） ───────────────────────

const NEEDED = ['SYNERGIES', 'matchSynergy', 'synergyMultiplier', 'synergyRefund', 'synergyLabel'];

async function loadModule(file, needed) {
    const abs = path.join(root, 'src', 'pages', file);
    if (!existsSync(abs)) return { state: 'missing', reason: '文件不存在（可能正在编写）' };
    let mod;
    try {
        const source = readFileSync(abs, 'utf8');
        mod = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
    } catch (e) {
        return { state: 'broken', reason: `无法作为 ESM 导入：${e.message}` };
    }
    const lacking = needed.filter((n) => mod[n] === undefined);
    if (lacking.length > 0) return { state: 'incomplete', reason: `缺少导出：${lacking.join(', ')}` };
    return { state: 'ready', mod };
}

// 12 个技能 id（连携表只能从这里取，避免写错 id 后静默不生效）
const SKILL_IDS = ['chill', 'meteor', 'bounty', 'repair', 'vortex', 'timestop',
    'shield', 'overload', 'execute', 'resonance', 'purge', 'salvage'];
const KINDS = ['dmg', 'rate', 'refund'];

// ═══ 断言 ═══════════════════════════════════════════════════

function runSections(mod) {
    const { SYNERGIES, matchSynergy, synergyMultiplier, synergyRefund, synergyLabel } = mod;

    section('1. SYNERGIES 数据形状（条数 / 12 个技能 id 内 / 数值为正 / desc 非空）');
    ok('SYNERGIES 是非空数组', Array.isArray(SYNERGIES) && SYNERGIES.length > 0,
        `实际 ${show(SYNERGIES)}`);

    const rows = Array.isArray(SYNERGIES) ? SYNERGIES : [];
    const badField = rows.filter((s) => !s
        || typeof s.first !== 'string' || !SKILL_IDS.includes(s.first)
        || typeof s.second !== 'string' || !SKILL_IDS.includes(s.second)
        || !Number.isFinite(s.windowMs) || !(s.windowMs > 0)
        || !Number.isFinite(s.value) || !(s.value > 0)
        || typeof s.desc !== 'string' || s.desc.trim().length === 0
        || !KINDS.includes(s.kind)).map((s) => `${s && s.first}->${s && s.second}`);
    deepEq('每条 first/second 都在 12 个技能 id 内，windowMs>0、value>0、kind 合法、desc 非空',
        badField, []);

    const pairs = rows.map((s) => `${s.first}>${s.second}`);
    eq('没有重复的技能对', new Set(pairs).size, pairs.length);
    const selfLoop = rows.filter((s) => s.first === s.second).map((s) => `${s.first}>${s.second}`);
    deepEq('first 与 second 不会是同一个技能', selfLoop, []);
    console.log(`  连携表：${rows.map((s) => `${s.first}→${s.second}@${s.windowMs}ms(${s.kind} ${s.value})`).join('  ')}`);

    section('2. matchSynergy 命中（vortex → meteor 在 4000ms 内）');
    const hit = matchSynergy('vortex', 1000, 'meteor', 3000);
    ok('prevAtMs=1000、nowMs=3000（差 2000）→ 命中', hit !== null && typeof hit === 'object',
        `实际 ${show(hit)}`);
    eq('命中的就是 SYNERGIES 里 vortex→meteor 那一条', hit && hit.second, 'meteor');
    eq('命中项 kind = dmg', hit && hit.kind, 'dmg');
    eq('返回值是表里的同一份引用（不是拷贝）', hit, rows.find((s) => s.first === 'vortex' && s.second === 'meteor'));

    section('3. 窗口边界（恰好 4000 命中 / 4001 不命中）');
    const edgeHit = matchSynergy('vortex', 1000, 'meteor', 5000);
    ok('nowMs - prevAtMs = 4000（恰等于 windowMs）→ 命中（闭区间）', edgeHit !== null,
        `实际 ${show(edgeHit)}`);
    const overHit = matchSynergy('vortex', 1000, 'meteor', 5001);
    eq('nowMs - prevAtMs = 4001（超出 1ms）→ 不命中', overHit, null);
    eq('差值 0（同一时刻连放两个技能）→ 命中', matchSynergy('vortex', 1000, 'meteor', 1000) !== null, true);

    section('4. 不该命中的情形（反向顺序 / 无前置 / 时间倒流 / 无关技能）');
    eq('反向顺序 meteor→vortex 不命中（连携有方向）', matchSynergy('meteor', 1000, 'vortex', 2000), null);
    eq('无前置：prevAtMs = 0 不命中', matchSynergy('vortex', 0, 'meteor', 2000), null);
    eq('无前置：prevAtMs = undefined 不命中', matchSynergy('vortex', undefined, 'meteor', 2000), null);
    eq('无前置：prevId = "" 不命中', matchSynergy('', 1000, 'meteor', 2000), null);
    eq('nowMs < prevAtMs（时间倒流）不命中', matchSynergy('vortex', 5000, 'meteor', 4000), null);
    eq('两个技能不在连携表里（chill→meteor）不命中', matchSynergy('chill', 1000, 'meteor', 2000), null);
    eq('第一条命中后不会顺带命中第二条（vortex→meteor 只返回 dmg 那条）',
        matchSynergy('vortex', 1000, 'meteor', 2000).kind, 'dmg');

    section('5. synergyMultiplier（dmg/rate 返回 1 + value，其它 kind 与未命中返回 1）');
    const dmgHit = rows.find((s) => s.kind === 'dmg' && s.value === 0.5);
    eq("synergyMultiplier('dmg', vortex→meteor 命中) = 1.5", synergyMultiplier('dmg', dmgHit), 1.5);
    eq("synergyMultiplier('refund', 同一条命中) = 1（kind 不匹配）", synergyMultiplier('refund', dmgHit), 1);
    eq("synergyMultiplier('dmg', null) = 1（未命中可直接相乘）", synergyMultiplier('dmg', null), 1);
    const rateHit = rows.find((s) => s.kind === 'rate');
    eq("synergyMultiplier('rate', 共鸣→超载) = 1.2", synergyMultiplier('rate', rateHit), 1.2);

    section('6. synergyRefund（refund 返回 floor(base*value)，其它 0）');
    const refundHit = rows.find((s) => s.first === 'shield' && s.second === 'purge');
    eq("synergyRefund('refund', 护盾→净化, 1000) = 300", synergyRefund('refund', refundHit, 1000), 300);
    eq("synergyRefund('refund', 护盾→净化, 999) = 299（向下取整）",
        synergyRefund('refund', refundHit, 999), 299);
    eq("synergyRefund('dmg', 同一条命中, 1000) = 0（kind 不匹配）", synergyRefund('dmg', refundHit, 1000), 0);
    eq("synergyRefund('refund', null, 1000) = 0（未命中）", synergyRefund('refund', null, 1000), 0);
    eq("synergyRefund('refund', 命中, NaN) = 0（非法基数不返回 NaN）",
        synergyRefund('refund', refundHit, NaN), 0);

    section('7. synergyLabel 文案（非空、含两个技能的中文名或 id）');
    const label = synergyLabel(dmgHit);
    ok('命中时 label 是非空字符串', typeof label === 'string' && label.trim().length > 0,
        `实际 ${show(label)}`);
    ok('label 同时含 first 的中文名/id（黑洞）与 second 的中文名/id（陨石）',
        (label.includes('黑洞') || label.includes('vortex')) && (label.includes('陨石') || label.includes('meteor')),
        `实际 ${show(label)}`);
    eq('未命中时 label 返回空串', synergyLabel(null), '');
    const allBad = rows.filter((s) => {
        const t = synergyLabel(s);
        return typeof t !== 'string' || t.length === 0
            || !(t.includes(s.first) || t.length > 0);
    }).map((s) => `${s.first}>${s.second}`);
    deepEq('每一条连携都能生成非空文案', allBad, []);
    console.log(`  文案样例：${label}`);

    section('8. 纯函数性（不改入参 / 同输入同输出 / 可重复调用）');
    const snapshot = JSON.stringify(SYNERGIES);
    matchSynergy('vortex', 1000, 'meteor', 2000);
    synergyLabel(dmgHit);
    const stable = JSON.stringify(SYNERGIES) === snapshot;
    eq('多次调用后 SYNERGIES 未被就地改写', stable, true);
    const a = JSON.stringify(matchSynergy('vortex', 1000, 'meteor', 2000));
    const b = JSON.stringify(matchSynergy('vortex', 1000, 'meteor', 2000));
    eq('同一组输入连续两次得到相同结果（无隐藏状态）', a, b);
}

// ─── 调度 ───────────────────────────────────────────────────

const load = await loadModule('td-synergy.js', NEEDED);

if (load.state === 'ready') {
    runSections(load.mod);
} else {
    console.log('\n[等待模块] src/pages/td-synergy.js 尚未就绪，断言被跳过（这不是失败）：');
    console.log(`  ..   src/pages/td-synergy.js — ${load.reason}`);
    console.log('等模块写完后再跑一次：node tools/td-synergy-test/run.mjs');
    console.log('WAITING 退出码 2（1 个模块未就绪）');
    process.exit(2);
}

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
