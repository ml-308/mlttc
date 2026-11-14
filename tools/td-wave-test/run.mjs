// tools/td-wave-test/run.mjs
// 塔防波次曲线的无依赖自检（零依赖、不联网、不写临时文件）。
//
// 用法：node tools/td-wave-test/run.mjs
//       全通过 → 打印数据表 + PASS n/n，退出码 0；有失败 → 打印首个失败详情，退出码 1。
//
// 为什么要用 data: URL 导入：
//   仓库根 package.json 是 "type": "commonjs"，src/pages/tower-defense.js 里写的是 ESM。
//   Node 直接 import 那个 .js 会按 CJS 解析 → 语法报错。这里 readFileSync 读源码后用
//   `data:text/javascript;base64,` 导入，等价于「把源码当 ESM 模块执行」，测的就是真实源码，
//   不复制、不改写被测文件（与 tools/import-api-test 用加载钩子同一个目的，这里更省事）。
//   该模块在 Node 下不会 boot（boot 需要 window / document），import 只拿到纯函数。
//
// 断言：
//   1. 无尽 1..100 波 total 严格递增（触到 maxEnemiesPerWave=400 后允许持平）
//   2. 非 BOSS 波（n % 10 !== 0）所需 DPS 单调不减（= 单波总血量 / 出怪时长）
//   3. 源码里没有「逐波数量表」（正则扫描，命中即失败）——「不写死出怪」这条对闯关模式同样成立
//   4. generateLevel(1..100) 全部合法：waves>=4、lives>=3、mapIndex∈[0,5]、gold>=0
//   5. 输出数据表（波次 / 总数 / 首组 hp / 需 DPS）
//   6. 闯关 1..100 关全部可通：预算模型下 需要DPS/可买DPS <= 0.85
//   7. 难度曲线不倒挂：ratio(L) 单调不减（±5% 容差），并指出首个违规的 L
//   8. 存档码 encodeSave / decodeSave 往返一致（含非 ASCII），非法输入一律 null 且不抛异常；
//      关卡总怪量（关卡列表按钮上的数字）为正整数且缓存不改变结果

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const srcPath = path.join(root, 'src', 'pages', 'tower-defense.js');
const source = readFileSync(srcPath, 'utf8');

const mod = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));

const { generateEndlessWave, generateLevel, buildLevelWave, LEVEL_MAX, BALANCE, MAP_TEMPLATES, TOWER_TYPES } = mod;
const SEED = 'mlttc-td-demo';
const WAVES = 100;

// ─── 测试框架 ─────────────────────────────────────────────────

let passed = 0;
const failures = [];

function assert(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failures.push({ name, detail: detail || '' });
        console.log(`  FAIL ${name}${detail ? '  ← ' + detail : ''}`);
    }
}

function section(title) {
    console.log(`\n[${title}]`);
}

// ─── 波次采样 ─────────────────────────────────────────────────

/** 一波的统计：total = 实际出场数（含 BOSS），hpSum = 全场总血量，dps = 总血量 / 出怪时长 */
function waveStat(n) {
    const w = generateEndlessWave(n, SEED);
    const hpSum = w.groups.reduce((sum, g) => sum + g.count * g.hp, 0);
    const nonBossHp = w.groups.filter((g) => g.type !== 'boss').reduce((sum, g) => sum + g.count * g.hp, 0);
    const spawned = w.total + w.bossCount;
    // 出怪时长：最后一只出场时刻 = spawnGap × (出场数 - 1)
    const seconds = Math.max(0.001, ((spawned - 1) * w.spawnGap) / 1000);
    return {
        n,
        total: w.total,
        bossCount: w.bossCount,
        spawned,
        firstHp: w.groups[0].hp,
        hpSum,
        nonBossHp,
        seconds,
        dps: nonBossHp / seconds,
        isBoss: w.isBossWave,
    };
}

const stats = [];
for (let n = 1; n <= WAVES; n += 1) stats.push(waveStat(n));

// ─── 1. total 严格递增 ────────────────────────────────────────

section('1. 无尽 1..100 波 total 严格递增');
{
    const cap = BALANCE.maxEnemiesPerWave;
    let firstDip = null;
    let cappedFrom = 0;
    for (let i = 1; i < stats.length; i += 1) {
        const prev = stats[i - 1], cur = stats[i];
        if (cur.total > prev.total) continue;
        if (cur.total === prev.total && cur.total >= cap) { cappedFrom = cappedFrom || cur.n; continue; }
        if (!firstDip) firstDip = `第 ${prev.n} 波 ${prev.total} → 第 ${cur.n} 波 ${cur.total}`;
    }
    assert('每波 total 都不小于上一波', firstDip === null, firstDip || '');
    assert(`触顶 ${cap} 之后才允许持平（首个持平波 ${cappedFrom || '无'}）`, true);
    assert('第 1 波 total 大于 0', stats[0].total > 0, `实际 ${stats[0].total}`);
    assert('末波 total 已达上限 400', stats[stats.length - 1].total === cap, `实际 ${stats[stats.length - 1].total}`);
}

// ─── 2. 非 BOSS 波所需 DPS 单调不减 ─────────────────────────

section('2. 非 BOSS 波所需 DPS 单调不减');
{
    const rows = stats.filter((s) => !s.isBoss);
    let dip = null;
    for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1], cur = rows[i];
        if (cur.dps + 1e-9 < prev.dps) {
            dip = `第 ${prev.n} 波 ${prev.dps.toFixed(1)} → 第 ${cur.n} 波 ${cur.dps.toFixed(1)}`;
            break;
        }
    }
    assert(`非 BOSS 波共 ${rows.length} 条，所需 DPS 全部单调不减`, dip === null, dip || '');
    assert('第 1 波所需 DPS 为正数', rows[0].dps > 0, `实际 ${rows[0].dps}`);
    assert('末波所需 DPS 远大于第 1 波（压力确实在涨）',
        rows[rows.length - 1].dps > rows[0].dps * 5,
        `${rows[0].dps.toFixed(1)} → ${rows[rows.length - 1].dps.toFixed(1)}`);
}

// ─── 3. 源码里没有逐波数量表 ─────────────────────────────────

section('3. 源码中没有写死的逐波数量表');
{
    // 10 个及以上数字的数组字面量 = 典型的「逐波数量表」；单个波次的 groups 只是 3~4 元素。
    const longNumberArray = /\[\s*(?:-?\d+(?:\.\d+)?\s*,\s*){9,}-?\d+(?:\.\d+)?\s*\]/;
    const namedTable = /\b(?:waveCounts?|countTable|WAVE_TABLE|WAVE_COUNTS|perWaveCounts|PER_WAVE_COUNTS)\b/;
    const hitArray = source.match(longNumberArray);
    const hitName = source.match(namedTable);
    assert('没有 10+ 元素的数字数组字面量', hitArray === null, hitArray ? hitArray[0].slice(0, 80) : '');
    assert('没有 waveCounts / WAVE_TABLE 之类的数量表标识符', hitName === null, hitName ? hitName[0] : '');
    assert('每一波都由 generateEndlessWave 现算（无逐波分支表）',
        (source.match(/generateEndlessWave\s*\(/g) || []).length >= 2,
        `调用点 ${(source.match(/generateEndlessWave\s*\(/g) || []).length} 处`);
}

// ─── 4. generateLevel(1..100) 合法 ──────────────────────────

section('4. generateLevel(1..100) 全部合法');
{
    const bad = [];
    for (let L = 1; L <= LEVEL_MAX; L += 1) {
        const c = generateLevel(L);
        const problems = [];
        if (c.level !== L) problems.push('level');
        if (!(c.waves >= 4)) problems.push('waves');
        if (!(c.lives >= 3)) problems.push('lives');
        if (!(c.mapIndex >= 0 && c.mapIndex <= 5)) problems.push('mapIndex');
        if (!(c.gold >= 0)) problems.push('gold');
        if (!Number.isFinite(c.diff) || c.diff < 1) problems.push('diff');
        if (problems.length) bad.push(`L${L}:${problems.join('/')}`);
    }
    assert(`${LEVEL_MAX} 关配置全部合法（waves>=4、lives>=3、mapIndex∈[0,5]、gold>=0）`,
        bad.length === 0, bad.slice(0, 5).join(' '));
    assert('L1 波数为 4、L50 为 16、L100 为 28',
        generateLevel(1).waves === 4 && generateLevel(50).waves === 16 && generateLevel(100).waves === 28,
        `${generateLevel(1).waves}/${generateLevel(50).waves}/${generateLevel(100).waves}`);
    assert('mapIndex 在 1..100 上覆盖全部 6 张模板',
        new Set(Array.from({ length: LEVEL_MAX }, (_, i) => generateLevel(i + 1).mapIndex)).size === 6,
        [...new Set(Array.from({ length: LEVEL_MAX }, (_, i) => generateLevel(i + 1).mapIndex))].join(','));
    assert('6 张地图模板都存在且都是从左侧外(-1)进、右侧外(24)出',
        MAP_TEMPLATES.length === 6 && MAP_TEMPLATES.every((p) => p[0][0] === -1 && p[p.length - 1][0] === 24),
        MAP_TEMPLATES.map((p) => `${p[0][0]}→${p[p.length - 1][0]}`).join(' '));
    assert('非法关卡号会被夹到 [1,100]',
        generateLevel(0).level === 1 && generateLevel(101).level === 100 && generateLevel('x').level === 1,
        `${generateLevel(0).level}/${generateLevel(101).level}/${generateLevel('x').level}`);
    assert('关卡波次仍复用无尽生成器（L100 第 10 波仍是 BOSS 波）',
        buildLevelWave(generateLevel(100), 10).isBossWave === true, 'isBossWave 不为 true');
}

// ─── 5. 数据表 ───────────────────────────────────────────────

section('5. 数据表（无尽模式，种子 ' + SEED + '）');
{
    const pad = (v, w) => String(v).padStart(w);
    console.log(`  ${pad('波次', 4)} ${pad('总数', 6)} ${pad('首组hp', 8)} ${pad('总血量', 10)} ${pad('需DPS', 9)}  备注`);
    for (const s of stats) {
        const note = s.isBoss ? `BOSS×${s.bossCount}` : '';
        console.log(`  ${pad(s.n, 4)} ${pad(s.spawned, 6)} ${pad(s.firstHp, 8)} ${pad(s.hpSum, 10)} ${pad(s.dps.toFixed(1), 9)}  ${note}`);
    }
    assert(`表格输出了 ${WAVES} 行`, stats.length === WAVES, `实际 ${stats.length}`);
}

section('5b. 关卡配置抽样（公式 + 前 12 关手工调参表）');
{
    const pad = (v, w) => String(v).padStart(w);
    console.log(`  ${pad('关卡', 4)} ${pad('波数', 5)} ${pad('生命', 5)} ${pad('起步金', 7)} ${pad('diff', 6)} ${pad('地图', 5)} ${pad('首波hp', 7)} ${pad('首波数量', 8)}`);
    for (const L of [1, 2, 3, 12, 13, 50, 100]) {
        const c = generateLevel(L);
        const w1 = buildLevelWave(c, 1);
        console.log(`  ${pad('L' + L, 4)} ${pad(c.waves, 5)} ${pad(c.lives, 5)} ${pad(c.gold, 7)} ${pad(c.diff.toFixed(2), 6)} ${pad(c.mapIndex, 5)} ${pad(w1.groups[0].hp, 7)} ${pad(w1.total, 8)}`);
    }
    // 前 12 关调参表必须真的更平缓：L1 首波 hp 不高于纯公式值
    const c1 = generateLevel(1);
    const raw = Math.round(generateEndlessWave(1, 'level:1').groups[0].hp * c1.diff);
    assert('前 12 关调参表生效（L1 首波 hp 低于纯公式值）',
        buildLevelWave(c1, 1).groups[0].hp < raw, `${buildLevelWave(c1, 1).groups[0].hp} vs ${raw}`);
}

// ─── 6. 闯关 1..100 关可通性 ─────────────────────────────────
//
// 预算模型（判「这一关的怪，玩家买得起的火力能不能打死」）：
//   可买DPS(L) = (cfg.gold + Σ 该关所有波次 count×bounty) / 满级箭塔造价 × 满级箭塔DPS × 光环buff
//   需要DPS(L) = max over waves ( 单波总血量 / 出怪时长 )
//   ratio(L)   = 需要DPS / 可买DPS      —— ratio<=0.85 才留得住操作与放置失误的余量
// 口径说明：单波总血量含 BOSS 组（BOSS 波就是 hardest wave），出怪时长 = (出场数-1)×spawnGap。

const ARROW_COST = 60 + 120 + 220;   // 满级箭塔总投入 = 400（建造 + 两次升级）
const ARROW_DPS = 24 * 2.2;          // 满级箭塔 DPS = 52.8（dmg × rate）
const AURA_BUFF = 1.5525;            // 一座满级光环塔的乘算加成
const RATIO_MAX = 0.85;              // 可通性红线
const RATIO_TOL = 0.95;              // 单调性容差：允许 -5% 抖动

function levelBudget(L) {
    const cfg = generateLevel(L);
    let gold = cfg.gold, worst = 0, worstWave = 0;
    for (let n = 1; n <= cfg.waves; n += 1) {
        const w = buildLevelWave(cfg, n);
        const hpSum = w.groups.reduce((s, g) => s + g.count * g.hp, 0);
        const bossCount = w.groups.reduce((s, g) => s + (g.type === 'boss' ? g.count : 0), 0);
        const seconds = Math.max(0.001, ((w.total + bossCount - 1) * w.spawnGap) / 1000);
        const dps = hpSum / seconds;
        if (dps > worst) { worst = dps; worstWave = n; }
        for (const g of w.groups) gold += g.count * g.bounty;
    }
    const buy = (gold / ARROW_COST) * ARROW_DPS * AURA_BUFF;
    return { L, waves: cfg.waves, worstWave, need: worst, buy, gold, ratio: worst / buy };
}

const budget = [];
for (let L = 1; L <= LEVEL_MAX; L += 1) budget.push(levelBudget(L));

section('6. 闯关 1..100 关可通性（ratio = 需要DPS / 可买DPS，红线 ' + RATIO_MAX + '）');
{
    const pad = (v, w) => String(v).padStart(w);
    const worst = budget.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    console.log(`  ${pad('关卡', 4)} ${pad('波数', 5)} ${pad('最难关', 6)} ${pad('需要DPS', 9)} ${pad('可买DPS', 9)} ${pad('ratio', 6)}`);
    for (const r of budget) {
        if (r.L !== 1 && r.L % 10 !== 0 && r !== worst) continue;
        const mark = r.ratio > RATIO_MAX ? '  <<< 超过红线' : (r === worst ? '  <<< 最难关' : '');
        console.log(`  ${pad('L' + r.L, 4)} ${pad(r.waves, 5)} ${pad(r.worstWave, 6)} ${pad(r.need.toFixed(0), 9)} ${pad(r.buy.toFixed(0), 9)} ${pad(r.ratio.toFixed(3), 6)}${mark}`);
    }
    const over = budget.filter((r) => r.ratio > RATIO_MAX);
    assert(`${LEVEL_MAX} 关的 ratio 全部 <= ${RATIO_MAX}（可通）`,
        over.length === 0,
        over.length ? `首个超标 L${over[0].L} ratio=${over[0].ratio.toFixed(3)}，共 ${over.length} 关超标` : '');
    assert('最难关 ratio 有实际压力（>0.4，不是一路白给）',
        worst.ratio > 0.4, `峰值 L${worst.L} ratio=${worst.ratio.toFixed(3)}`);
    assert('可买DPS 随关卡增长（L100 >= L1 的 5 倍）',
        budget[budget.length - 1].buy >= budget[0].buy * 5,
        `${budget[0].buy.toFixed(0)} → ${budget[budget.length - 1].buy.toFixed(0)}`);
}

// ─── 7. 难度曲线不倒挂 ───────────────────────────────────────

section('7. 难度曲线不倒挂（ratio 单调不减，允许 -' + Math.round((1 - RATIO_TOL) * 100) + '% 抖动）');
{
    const dips = [];
    for (let i = 1; i < budget.length; i += 1) {
        const prev = budget[i - 1], cur = budget[i];
        if (cur.ratio < prev.ratio * RATIO_TOL) dips.push({ prev, cur });
    }
    const first = dips[0];
    assert('ratio(L) 全程不出现「高关卡比低关卡轻松」',
        dips.length === 0,
        first
            ? `首个违规：L${first.prev.L}(${first.prev.ratio.toFixed(3)}) → L${first.cur.L}(${first.cur.ratio.toFixed(3)})，共 ${dips.length} 处`
            : '');
    const r1 = budget[0].ratio, r100 = budget[budget.length - 1].ratio;
    assert('曲线是爬升而不是崩塌（L100 的 ratio 不低于 L1）', r100 >= r1,
        `L1=${r1.toFixed(3)} L100=${r100.toFixed(3)}`);
    assert('L1 与 L100 的 ratio 差距不过分（<=0.45）', Math.abs(r100 - r1) <= 0.45,
        `差 ${(r100 - r1).toFixed(3)}`);
}

// ─── 8. 存档码编解码 + 关卡总怪量 ────────────────────────────

section('8. 存档码 encodeSave / decodeSave（往返 + 非法输入）');
{
    const { encodeSave, decodeSave, levelTotalEnemies } = mod;

    // 键序无关的序列化：encodeSave 走 JSON，解码后键序可能不同，比的是内容不是字面量顺序
    const canon = (v) => JSON.stringify(v, (k, val) => (
        val && typeof val === 'object' && !Array.isArray(val)
            ? Object.keys(val).sort().reduce((o, k2) => { o[k2] = val[k2]; return o; }, {})
            : val));

    const sample = {
        unlocked: 12,
        endlessBest: 37,
        levelBest: { 3: 12, 7: 16 },
        endlessRun: {
            wave: 9, gold: 420, lives: 14, kills: 208,
            seed: 'run-中文种子·🎮&<tag>', savedAt: 1700000000000,
            towers: [{ type: 'arrow', col: 3, row: 5, lvl: 2 }, { type: 'aura', col: 4, row: 5, lvl: 3 }],
        },
        nickname: '中文昵称 · test & <b>',
    };

    const code = encodeSave(sample);
    assert('encodeSave 输出 TD1- 前缀的字符串',
        typeof code === 'string' && code.startsWith('TD1-') && code.length > 40, String(code).slice(0, 20));

    const back = decodeSave(code);
    assert('encodeSave → decodeSave 往返一致（含中文 / emoji / <>& 特殊字符）',
        canon(back) === canon(sample), String(canon(back)).slice(0, 140));

    assert('合法最小存档也能往返',
        (decodeSave(encodeSave({ unlocked: 1 })) || {}).unlocked === 1, 'decode 失败');

    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const badInputs = [
        '', null, undefined, 42, {}, [], 'TD1-', 'TD1-!!!not-base64', 'nothing-here',
        'TD1-' + b64('{oops'),                     // JSON 坏
        'TD1-' + b64('"just a string"'),           // 不是对象
        'TD1-' + b64('[1,2,3]'),                   // 是数组
        'TD1-' + b64('{"unlocked":"abc"}'),        // 字段非法
        'TD1-' + b64('{"levelBest":{"0":5}}'),     // 关卡号越界
        'TD1-' + b64('{"endlessRun":{"wave":0}}'), // endlessRun 结构不全
    ];
    let threw = null, nonNull = null;
    for (const v of badInputs) {
        try { if (decodeSave(v) !== null) nonNull = String(v).slice(0, 40); }
        catch (e) { threw = e; }
    }
    assert('非法输入（前缀/base64/JSON/字段/类型）一律 null 且不抛异常',
        threw === null && nonNull === null,
        threw ? `抛出异常：${threw}` : (nonNull ? `非 null 返回：${nonNull}` : ''));

    // 关卡总怪量：缓存命中与否结果必须一致（缓存不能改变数值）
    const t0 = Date.now();
    const totals = [];
    for (let L = 1; L <= LEVEL_MAX; L += 1) totals.push(levelTotalEnemies(L));
    const cost = Date.now() - t0;
    const again = levelTotalEnemies(50);
    assert('100 关总怪量全部为正整数，且缓存命中结果一致',
        totals.every((v) => Number.isInteger(v) && v > 0) && again === totals[49],
        `L50 ${totals[49]} vs ${again}`);
    console.log(`  关卡总怪量：L1=${totals[0]} L50=${totals[49]} L100=${totals[99]}`);
    console.log(`  100 关首次全算耗时 ${cost}ms（页面里缓存在 Map，之后进列表命中缓存为 0）`);
}

// ─── 9. 塔数据形状（塔数值表与塔信息卡片共用同一份 TOWER_TYPES） ───

section('9. TOWER_TYPES 数据形状（数值表 / 塔信息卡片共用）');
{
    // 数值表与卡片都用 lv-1 下标读 dmg / rate / range / cost，长度不足就会渲染出 NaN
    const keys = Object.keys(TOWER_TYPES);
    const bad = [];
    const three = (v) => Array.isArray(v) && v.length === 3;
    for (const k of keys) {
        const d = TOWER_TYPES[k];
        if (!(three(d.cost) && d.cost.every((v) => v > 0))) bad.push(`${k}:cost`);
        if (!three(d.range)) bad.push(`${k}:range`);
        if (d.auraRate) {
            if (!three(d.auraRate)) bad.push(`${k}:auraRate`);
            if (!three(d.auraDmg)) bad.push(`${k}:auraDmg`);
        } else if (!(three(d.dmg) && three(d.rate))) bad.push(`${k}:dmg/rate`);
        if (d.splash && !three(d.splash)) bad.push(`${k}:splash`);
        if (d.slow && !(three(d.slow) && three(d.slowMs))) bad.push(`${k}:slow`);
    }
    assert(`${keys.length} 种塔的 cost / range / 伤害或光环 三档齐全（卡片取 lv-1 不越界）`,
        keys.length === 4 && bad.length === 0, bad.join(' '));
    assert('升级价逐级递增（cost[0] < cost[1] < cost[2]）',
        keys.every((k) => TOWER_TYPES[k].cost[2] > TOWER_TYPES[k].cost[1] && TOWER_TYPES[k].cost[1] > TOWER_TYPES[k].cost[0]),
        keys.filter((k) => !(TOWER_TYPES[k].cost[2] > TOWER_TYPES[k].cost[1] && TOWER_TYPES[k].cost[1] > TOWER_TYPES[k].cost[0])).join(' '));
    // 卡片与 sellTower 用同一个公式 floor(spend × sellRatio)：卖塔永远不能刷钱
    const refundBad = [];
    for (let s = 2; s <= 2000; s += 1) {
        const r = Math.floor(s * BALANCE.sellRatio);
        if (!Number.isInteger(r) || r < 1 || r >= s) refundBad.push(`spend ${s} → ${r}`);
    }
    assert('出售返还 = floor(总投入 × sellRatio)，恒为正整数且严格小于总投入',
        refundBad.length === 0, refundBad.slice(0, 3).join(' '));
}

// ─── 汇总 ────────────────────────────────────────────────────

const total = passed + failures.length;
console.log('');
if (failures.length === 0) {
    console.log(`PASS ${passed}/${total}`);
    process.exit(0);
} else {
    console.log(`FAIL ${passed}/${total}`);
    const first = failures[0];
    console.log(`首个失败：${first.name}`);
    if (first.detail) console.log(`详情：${first.detail}`);
    process.exit(1);
}
