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
//   9. 塔数据形状（数值表 / 场上塔清单共用同一份 TOWER_TYPES）
//  10. 场上塔清单 describeTowers：空场 / 顺序 / 光环加成 / 满级 / 金币门槛 / 返还额
//  11. 「快速升级」目标 nextUpgradeTarget：建造顺序 / 跳过满级 / 全满级 / 价格取值 / 金币门槛 / 坏输入
//  12. 导入合并 mergeProgress：导入的无尽进度必须胜出（不许退回「savedAt 谁新留谁」）

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const srcPath = path.join(root, 'src', 'pages', 'tower-defense.js');
const source = readFileSync(srcPath, 'utf8');   // 原文留着给第 3 节的正则扫描用（扫的是真实源码）

/**
 * data: URL 里的模块没有「基准目录」，相对说明符（'./td-skills.js'）在那里解析不了。
 * 这里把每一层相对 import 递归改写成**同一招**（读源码 → data: URL），所以主文件里那两条
 * `import ... from './td-skills.js'` 会被换成那两份源码的 data: URL：
 *   · 为什么不用 pathToFileURL 直接指向 src/pages/*.js —— 仓库根 package.json 是
 *     "type": "commonjs"，Node 会按 CJS 解析那两个 .js，具名导出（SKILLS / SPECIAL_TOWER_TYPES…）
 *     一个都拿不到，报 "Named export not found"。data: URL 恒按 ESM 执行，正好绕开这件事。
 *   · 仍然是同一份真实源码：不复制、不改写磁盘上的文件、不写临时文件。
 * 递归只在模块间有相对 import 时才继续下沉；这里两个模块自身零 import，所以实际只有两层。
 * 注意这条注释里的写法带有单引号，正则只认 `from '…'` 开头，注释本身不会被改写。
 */
const REL_IMPORT = /from\s+(['"])(\.{1,2}\/[^'"]+)\1/g;
function toModuleUrl(file) {
  const code = readFileSync(file, 'utf8').replace(REL_IMPORT, (_m, q, spec) =>
    `from ${q}${toModuleUrl(path.resolve(path.dirname(file), spec))}${q}`);
  return 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
}
const mainUrl = toModuleUrl(srcPath);
const leftOver = Buffer.from(mainUrl.slice(mainUrl.indexOf(',') + 1), 'base64').toString('utf8')
  .match(/from\s+['"]\./g);
if (leftOver) throw new Error('仍有相对 import 没有改写：' + leftOver.join(' '));

const mod = await import(mainUrl);

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

// ─── 10. 场上塔清单 describeTowers（纯函数，Node 下直接调用） ─────────
//
// 信息区列的是「场上每一座塔」，每行的伤害/攻速必须与画面上看到的一致 —— 所以断言直接打在
// 渲染用的那个纯函数上，而不是另抄一份期望值：函数改了，这里立刻红。

section('10. 场上塔清单 describeTowers（纯函数，不碰 DOM）');
{
    const { describeTowers } = mod;
    const SELL = BALANCE.sellRatio;
    // 塔对象的形状与 placeTower 一致（只关心清单会读到的字段）
    const tower = (type, lv, col, row, spend, dmgBuff = 0, rateBuff = 0) =>
        ({ type, lv, col, row, x: 0, y: 0, cd: 0, spend, dmgBuff, rateBuff });

    // 10.1 空场 → 空数组（且完全无输入也不抛）
    const empty0 = describeTowers([], { gold: 500, sellRatio: SELL });
    const empty1 = describeTowers(undefined, { gold: 0, sellRatio: SELL });
    assert('空场返回空数组（undefined 也不抛异常）',
        Array.isArray(empty0) && empty0.length === 0 && Array.isArray(empty1) && empty1.length === 0,
        `len ${empty0.length} / ${empty1.length}`);

    // 10.2 三座不同等级：index 等于数组下标，lv / col / row 原样透出
    const field = [
        tower('arrow', 1, 3, 5, 60),
        tower('cannon', 2, 7, 4, 310),
        tower('frost', 3, 9, 8, 530),
    ];
    const rows = describeTowers(field, { gold: 1000, sellRatio: SELL });
    const orderBad = rows.length !== 3 || rows.some((r, i) => r.index !== i || r.type !== field[i].type
        || r.name !== TOWER_TYPES[field[i].type].name || r.color !== TOWER_TYPES[field[i].type].color
        || r.lv !== field[i].lv || r.col !== field[i].col || r.row !== field[i].row
        || r.range !== TOWER_TYPES[field[i].type].range[field[i].lv - 1]);
    assert('3 座塔 → 3 行，index 与数组顺序一致，lv/col/row/射程 正确', !orderBad,
        JSON.stringify(rows.map((r) => [r.index, r.type, r.lv, r.col, r.row, r.range])));

    // 10.3 光环加成计入 dmg / rate（容差 0.01，且必须是两位小数）
    const buffed = describeTowers([tower('cannon', 1, 2, 2, 110, 0.15, 0.35)], { gold: 0, sellRatio: SELL })[0];
    const expDmg = TOWER_TYPES.cannon.dmg[0] * 1.15;
    const expRate = TOWER_TYPES.cannon.rate[0] * 1.35;
    assert('dmg / rate 已计入 dmgBuff(+15%) / rateBuff(+35%)，保留两位小数',
        Math.abs(buffed.dmg - expDmg) <= 0.01 && Math.abs(buffed.rate - expRate) <= 0.01
        && Number(buffed.dmg.toFixed(2)) === buffed.dmg && Number(buffed.rate.toFixed(2)) === buffed.rate,
        `${buffed.dmg} vs ${expDmg.toFixed(3)} / ${buffed.rate} vs ${expRate.toFixed(3)}`);

    // 10.4 满级（Lv.MAX_TOWER_LEVEL）：maxed、upgradeCost 归零、金币再多也不能升
    const MAX_LV = mod.MAX_TOWER_LEVEL;
    const maxedRow = describeTowers([tower('arrow', MAX_LV, 1, 1, 400)], { gold: 99999, sellRatio: SELL })[0];
    assert('满级塔（Lv.MAX_TOWER_LEVEL）maxed=true、upgradeCost=0、canUpgrade=false',
        maxedRow.maxed === true && maxedRow.upgradeCost === 0 && maxedRow.canUpgrade === false
        && maxedRow.lv === MAX_LV && maxedRow.maxLv === MAX_LV,
        `maxed=${maxedRow.maxed} cost=${maxedRow.upgradeCost} can=${maxedRow.canUpgrade}`);

    // 10.5 金币门槛：arrow Lv.1 升级价 120
    const poor = describeTowers([tower('arrow', 1, 1, 1, 60)], { gold: 90, sellRatio: SELL })[0];
    const exact = describeTowers([tower('arrow', 1, 1, 1, 60)], { gold: 120, sellRatio: SELL })[0];
    assert('金币不足（90 < 120）canUpgrade=false，恰好够（120 >= 120）为 true',
        poor.upgradeCost === 120 && poor.canUpgrade === false && exact.canUpgrade === true,
        `gold90 → ${poor.canUpgrade} / gold120 → ${exact.canUpgrade}`);

    // 10.6 返还额 = floor(spend × sellRatio)：正整数、严格小于投入（卖塔永远刷不出钱）
    const refundBad = [];
    for (const spend of [60, 110, 310, 400, 530, 999]) {
        const r = describeTowers([tower('arrow', 1, 0, 0, spend)], { gold: 0, sellRatio: SELL })[0].sellRefund;
        if (r !== Math.floor(spend * SELL) || !Number.isInteger(r) || r < 1 || r >= spend) {
            refundBad.push(`${spend}→${r}`);
        }
    }
    assert('sellRefund = floor(spend × sellRatio)，恒为正整数且严格小于投入',
        refundBad.length === 0, refundBad.join(' '));

    // 真实调用取样（报告里贴的就是这几行）
    console.log('  describeTowers(3 座塔, gold=260)：');
    for (const r of describeTowers(field, { gold: 260, sellRatio: SELL })) {
        console.log(`    #${r.index} ${r.name} Lv.${r.lv}/${r.maxLv} dmg=${r.dmg} rate=${r.rate}`
            + ` range=${r.range} (${r.col}, ${r.row}) 升级=${r.upgradeCost} 返还=${r.sellRefund}`
            + ` canUpgrade=${r.canUpgrade} maxed=${r.maxed}`);
    }
}

section('11. 「快速升级」目标 nextUpgradeTarget（纯函数，不碰 DOM）');
{
    const { nextUpgradeTarget } = mod;
    const tower = (type, lv, col = 0, row = 0, spend = 60) =>
        ({ type, lv, col, row, x: 0, y: 0, cd: 0, spend, dmgBuff: 0, rateBuff: 0 });

    // 11.1 空场 → null（undefined 也不抛）
    const none0 = nextUpgradeTarget([], 9999);
    const none1 = nextUpgradeTarget(undefined, 0);
    assert('空塔数组 → null（undefined 也不抛异常）', none0 === null && none1 === null,
        `${none0} / ${none1}`);

    // 11.2 三座塔（Lv.1 / Lv.2 / Lv.1）→ 取数组第一个（index 0），不是等级最低、也不是建造最晚的
    const three = [tower('arrow', 1, 1, 1, 60), tower('cannon', 2, 2, 2, 310), tower('frost', 1, 3, 3, 90)];
    const first = nextUpgradeTarget(three, 1000);
    assert('3 座塔（Lv.1/Lv.2/Lv.1）→ index 0（等级最低者里取先建的；平手才算建造顺序）',
        first && first.index === 0 && first.tower === three[0] && first.type === 'arrow'
        && first.lv === 1 && first.nextLv === 2,
        first ? `index=${first.index} type=${first.type} lv=${first.lv}` : 'null');

    // 11.2b 不能只盯着"等级最高/先建"的那座：Lv.4 与 Lv.1 并存时，应升 Lv.1 的那座
    const mixed = [tower('arrow', 4, 1, 1, 697), tower('frost', 1, 2, 2, 90)];
    const spread = nextUpgradeTarget(mixed, 999999, true);   // true = 高等级已解锁
    assert('Lv.4 与 Lv.1 并存 → 选 Lv.1 那座（不再只往同一座塔砸钱）',
        spread && spread.index === 1 && spread.lv === 1 && spread.type === 'frost',
        spread ? `index=${spread.index} lv=${spread.lv} type=${spread.type}` : 'null');

    // 11.3 第一座满级 → 跳过它，取第二座
    const skip = [tower('arrow', 3, 1, 1, 400), tower('frost', 1, 2, 2, 90)];
    const second = nextUpgradeTarget(skip, 1000);
    assert('第一座已满级（Lv.3）→ 返回 index 1（跳过满级的那座）',
        second && second.index === 1 && second.type === 'frost', second ? `index=${second.index}` : 'null');

    // 11.4 全部满级 → null
    const allMax = [tower('arrow', 3), tower('cannon', 3), tower('aura', 3)];
    assert('全部满级 → null', nextUpgradeTarget(allMax, 99999) === null);

    // 11.5 cost 就是 TOWER_TYPES[type].cost[lv]（Lv.1 与 Lv.2 各验一次，lv 是 1 基等级）
    const c1 = nextUpgradeTarget([tower('arrow', 1)], 0);
    const c2 = nextUpgradeTarget([tower('arrow', 2)], 0);
    const costOk = c1.cost === TOWER_TYPES.arrow.cost[1] && c2.cost === TOWER_TYPES.arrow.cost[2]
        && c1.cost !== TOWER_TYPES.arrow.cost[0] && c1.nextLv === 2 && c2.nextLv === 3;
    assert('cost = TOWER_TYPES[type].cost[lv]（Lv.1→cost[1], Lv.2→cost[2]，不是建造价 cost[0]）', costOk,
        `lv1=${c1.cost} lv2=${c2.cost} 建造价=${TOWER_TYPES.arrow.cost[0]}`);

    // 11.6 金币门槛：恰好够（gold === cost）为 true，差 1 为 false
    const exact = nextUpgradeTarget([tower('arrow', 1)], c1.cost);
    const poor = nextUpgradeTarget([tower('arrow', 1)], c1.cost - 1);
    assert('canAfford：gold === cost → true，gold === cost - 1 → false',
        exact.canAfford === true && poor.canAfford === false,
        `${c1.cost} → ${exact.canAfford} / ${c1.cost - 1} → ${poor.canAfford}`);

    // 11.7 坏输入：非数组 / 含 null / 未知类型 → 不抛，能正常返回结果或 null
    let badThrew = '';
    let badResult = 'ok';
    try {
        const arrWithNull = nextUpgradeTarget([null, tower('arrow', 1)], 500);
        const unknown = nextUpgradeTarget([tower('nope', 1), null], 500);
        if (!arrWithNull || arrWithNull.index !== 1) badResult = 'arrWithNull 未跳过坏元素';
        if (unknown !== null) badResult = '未知塔类型未返回 null';
    } catch (err) { badThrew = String(err && err.message); }
    assert('非数组 / 含 null 元素 / 未知塔类型：不抛异常，跳过坏数据处理后面的塔',
        badThrew === '' && badResult === 'ok', badThrew || badResult);

    // 真实调用取样（报告里贴的就是这几行）
    console.log('  nextUpgradeTarget(3 座塔 Lv.1/Lv.2/Lv.1, gold=1000)：'
        + JSON.stringify({ index: first.index, type: first.type, lv: first.lv, nextLv: first.nextLv,
            cost: first.cost, canAfford: first.canAfford }));
    console.log('  nextUpgradeTarget(全满级 3 座, gold=99999)：' + nextUpgradeTarget(allMax, 99999));
    console.log('  nextUpgradeTarget([], gold=9999)：' + nextUpgradeTarget([], 9999));
}

section('12. 导入合并 mergeProgress（导入的无尽进度必须胜出）');
{
    const { mergeProgress } = mod;
    // 注意：endlessRun 必须过 sanitizeRun 的校验（wave/gold/lives/kills/savedAt 均为数字、seed 非空）
    const cur = { unlocked: 1, levelBest: {}, endlessBest: 3,
        endlessRun: { wave: 1, gold: 150, lives: 20, kills: 0, seed: 'local-seed', towers: [], savedAt: 999999999 } };
    const inc = { unlocked: 50, levelBest: { 3: 12 }, endlessBest: 99,
        endlessRun: { wave: 12, gold: 500, lives: 15, kills: 300, seed: 'imported-seed', towers: [], savedAt: 1 } };
    const out = mergeProgress(cur, inc);
    // 这条是回归断言：页面一加载就写出当前这局的 run（savedAt=此刻），永远比导入的新，
    // 若按「谁新留谁」合并，导入的无尽进度永远用不上 —— 曾经真的出现过这个 bug。
    assert('导入的无尽进度胜出（即使 savedAt 更旧）', out.endlessRun && out.endlessRun.wave === 12,
        '得到 ' + JSON.stringify(out.endlessRun));
    assert('单调数据仍取大：unlocked / endlessBest / levelBest', out.unlocked === 50 && out.endlessBest === 99 && out.levelBest[3] === 12,
        JSON.stringify({ u: out.unlocked, e: out.endlessBest, lb: out.levelBest }));
    const keep = mergeProgress(cur, { unlocked: 1, levelBest: {}, endlessBest: 0, endlessRun: null });
    assert('导入里没有无尽进度时，不覆盖本地的', keep.endlessRun && keep.endlessRun.wave === 1,
        '得到 ' + JSON.stringify(keep.endlessRun));
}

// ─── 13. 特殊塔并入塔表（建造 / 升级 / 清单 / 数值表都遍历同一份表） ───

section('13. 特殊塔并入 ALL_TOWER_TYPES 后：清单与数值表仍正常');
{
    const { ALL_TOWER_TYPES, towerStatRows, describeTowers } = mod;
    const SPECIAL = ['tesla', 'poison', 'force'];
    const three = (v) => Array.isArray(v) && v.length === 3;

    assert('TOWER_TYPES 仍只含 4 种基础塔（并入总表没有污染它）',
        Object.keys(TOWER_TYPES).length === 4, Object.keys(TOWER_TYPES).join(','));
    assert('ALL_TOWER_TYPES = 4 基础塔 + 3 特殊塔，顺序为 4 + tesla/poison/force',
        Object.keys(ALL_TOWER_TYPES).length === 7
        && SPECIAL.every((k) => !!ALL_TOWER_TYPES[k])
        && Object.keys(ALL_TOWER_TYPES).slice(4).join(',') === SPECIAL.join(','),
        Object.keys(ALL_TOWER_TYPES).join(','));

    const badShape = SPECIAL.filter((k) => {
        const d = ALL_TOWER_TYPES[k];
        return !(three(d.cost) && three(d.dmg) && three(d.rate) && three(d.range) && !!d.name && !!d.color);
    });
    assert('3 种特殊塔的 cost / dmg / rate / range 三档齐全（清单按 lv-1 取下标不越界）',
        badShape.length === 0, badShape.join(' '));

    // 场上塔清单：特殊塔走的是同一个 describeTowers，等级 / 射程 / 升级价 / 返还额都必须对
    const MAX_LV = mod.MAX_TOWER_LEVEL;   // 满级 = MAX_TOWER_LEVEL（不再是写死的 3）
    const lv2 = ALL_TOWER_TYPES.tesla, lv3 = ALL_TOWER_TYPES.poison;
    const rows = describeTowers([
        { type: 'tesla', lv: 2, col: 1, row: 2, x: 0, y: 0, cd: 0, spend: 900, dmgBuff: 0.15, rateBuff: 0.35 },
        { type: 'poison', lv: MAX_LV, col: 3, row: 4, x: 0, y: 0, cd: 0, spend: 1960, dmgBuff: 0, rateBuff: 0 },
    ], { gold: 1000, sellRatio: BALANCE.sellRatio });
    const wantTeslaDmg = Math.round(lv2.dmg[1] * 1.15 * 100) / 100;
    assert('describeTowers 收录特殊塔：name/range/升级价/返还额/伤害(含光环) 全部正确',
        rows.length === 2
        && rows[0].type === 'tesla' && rows[0].name === lv2.name && rows[0].range === lv2.range[1]
        && rows[0].upgradeCost === lv2.cost[2] && rows[0].sellRefund === Math.floor(900 * BALANCE.sellRatio)
        && Math.abs(rows[0].dmg - wantTeslaDmg) <= 0.01
        && rows[1].type === 'poison' && rows[1].maxed === true && rows[1].upgradeCost === 0
        && rows[1].sellRefund === Math.floor(1960 * BALANCE.sellRatio),
        JSON.stringify(rows.map((r) => [r.type, r.name, r.lv, r.range, r.dmg, r.upgradeCost, r.sellRefund, r.maxed])));

    // 塔数值表：7 种塔 × 3 级 = 21 行 + 表头；不准出现 undefined / NaN（特殊塔缺字段就会露出来）
    const html = towerStatRows();
    const trs = (html.match(/<tr>/g) || []).length;
    const names = SPECIAL.filter((k) => html.indexOf(ALL_TOWER_TYPES[k].name) < 0);
    assert('towerStatRows：7 种塔 × 3 级 = 21 行 + 1 行表头，三座特殊塔都在表里',
        trs === 22 && names.length === 0, `tr=${trs} 缺=${names.join(',')}`);
    assert('towerStatRows 里没有 undefined / NaN（特殊塔也读得到 dmg/rate/range/特效）',
        !/undefined|NaN/.test(html),
        (html.match(/.{0,30}(?:undefined|NaN).{0,30}/) || [''])[0]);
    console.log('  特殊塔数值表行（截取）：');
    for (const k of SPECIAL) {
        const row = html.split('<tr>').find((r) => r.indexOf(ALL_TOWER_TYPES[k].name) >= 0);
        console.log('    ' + String(row || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
}

// ─── 14. 高波次叠乘血量（lateHpMul）+ 倍速档位 ─────────────────

section('14. 高波次叠乘血量 lateHpMul（第 ' + mod.LATE_HP_FROM + ' 波起 ×' + mod.LATE_HP_STEP + '/波）与倍速档位');
{
    const { ENEMY_TYPES, LEVEL_TWEAKS, LATE_HP_FROM, LATE_HP_STEP, SPEED_LEVELS } = mod;
    // 「改动前」口径：只按 1.06^(n-1) 算血（BOSS 组照旧 ×8），完全不看 lateHpMul。
    // 期望值独立重算，不读被测实现的 g.hp —— 否则实现改错也测不出来。
    const baselineHp = (g, n) => Math.max(1, Math.round(
        ENEMY_TYPES[g.type].hp * Math.pow(1.06, n - 1) * (g.type === 'boss' ? 8 : 1)));
    const waveOf = (n) => generateEndlessWave(n, SEED);
    const sumOf = (w) => w.groups.reduce((s, g) => s + g.count * g.hp, 0);
    const baselineSum = (n) => waveOf(n).groups.reduce((s, g) => s + g.count * baselineHp(g, n), 0);
    const hpByType = (w) => {
        const m = {};
        for (const g of w.groups) if (g.type !== 'boss') m[g.type] = g.hp;
        return m;
    };

    // 14.1 阈值前一个数都没动：第 1/10/20/30 波的每一组血量都等于「只用 1.06^(n-1)」的期望值
    const earlyWaves = [1, 10, 20, 30];
    const earlyBad = [];
    for (const n of earlyWaves) for (const g of waveOf(n).groups) {
        const want = baselineHp(g, n);
        if (g.hp !== want) earlyBad.push(`第${n}波 ${g.type} ${g.hp}≠${want}`);
    }
    assert(`第 ${earlyWaves.join('/')} 波的每组血量与「只按 1.06^(n-1)」完全相等（阈值前数值未变）`,
        earlyBad.length === 0, earlyBad.slice(0, 4).join(' '));

    // 14.2 第 31 波起加成生效：每组的血量必须等于 round(基础 × 1.06^(n-1) × LATE_HP_STEP)
    const w30 = waveOf(30), w31 = waveOf(31);
    const bad31 = w31.groups.filter((g) => g.type !== 'boss').filter((g) => g.hp !== Math.max(1, Math.round(
        ENEMY_TYPES[g.type].hp * Math.pow(1.06, 30) * LATE_HP_STEP)));
    assert(`第 31 波每组血量 = round(基础 × 1.06^30 × ${LATE_HP_STEP})（加成正好从第 31 波起、只乘一档）`,
        bad31.length === 0, bad31.map((g) => `${g.type} ${g.hp}`).join(' '));
    const h30 = hpByType(w30), h31 = hpByType(w31);
    const notHigher = Object.keys(h31).filter((t) => h30[t] === undefined
        ? false
        : !(h31[t] > Math.max(1, Math.round(ENEMY_TYPES[t].hp * Math.pow(1.06, 29)))));
    assert('第 31 波同类怪血量 > 第 30 波「仅 1.06 增长」的期望值（加成确实生效）',
        notHigher.length === 0 && sumOf(w31) > baselineSum(31),
        `第31波总血 ${sumOf(w31)} vs 仅1.06期望 ${baselineSum(31)}；未超过的类型 ${notHigher.join(',') || '无'}`);

    // 14.3 加成的单调性：40 / 50 / 75 / 100 严格递增，且 100 波 ≥ 50 波的 2 倍
    const ladder = [40, 50, 75, 100].map((n) => ({ n, sum: sumOf(waveOf(n)) }));
    let monoBad = null;
    for (let i = 1; i < ladder.length; i += 1) {
        if (!(ladder[i].sum > ladder[i - 1].sum)) {
            monoBad = `第 ${ladder[i - 1].n} 波 ${ladder[i - 1].sum} → 第 ${ladder[i].n} 波 ${ladder[i].sum}`;
            break;
        }
    }
    assert('第 40/50/75/100 波的单波总血量严格递增',
        monoBad === null, monoBad || ladder.map((r) => `${r.n}:${r.sum}`).join(' '));
    const grow = ladder[3].sum / ladder[1].sum;
    assert(`第 100 波总血量 ≥ 第 50 波的 2 倍（高波次明显更硬，实际 ×${grow.toFixed(2)}）`,
        grow >= 2, `第 50 波 ${ladder[1].sum} → 第 100 波 ${ladder[3].sum}`);

    // 14.4 硬门槛：阈值必须 ≥ 30（闯关每关最多 28 波 = 4 + floor(L×0.24)，L100 → 28）
    assert(`LATE_HP_FROM ≥ 30（硬门槛：闯关最多 28 波，阈值必须落在闯关范围之外，实际 ${LATE_HP_FROM}）`,
        LATE_HP_FROM >= 30, `实际 ${LATE_HP_FROM}`);
    assert(`LATE_HP_STEP 取 (1, 1.06] 之间（比 1.06 更陡则过度，更缓则等于没加；实际 ${LATE_HP_STEP}）`,
        LATE_HP_STEP > 1 && LATE_HP_STEP <= 1.06, `实际 ${LATE_HP_STEP}`);

    // 14.5 闯关未受影响：L100 的 28 波（28 < 30）每组血量 = 「不含 lateHpMul」的期望值
    const lv100 = generateLevel(LEVEL_MAX);
    const hpScale100 = lv100.diff * ((LEVEL_TWEAKS[lv100.level] || {}).hp || 1);
    const lvBad = [];
    for (let n = 1; n <= lv100.waves; n += 1) {
        for (const g of buildLevelWave(lv100, n).groups) {
            const want = Math.max(1, Math.round(baselineHp(g, n) * hpScale100));
            if (g.hp !== want) lvBad.push(`L${lv100.level} 第${n}波 ${g.type} ${g.hp}≠${want}`);
        }
    }
    assert(`闯关 L${lv100.level}（${lv100.waves} 波 < 阈值 ${LATE_HP_FROM}）全部血量 = 不含 lateHpMul 的期望值`,
        lvBad.length === 0 && lv100.waves < LATE_HP_FROM, lvBad.slice(0, 4).join(' ') || `waves=${lv100.waves}`);
    const oneWave = buildLevelWave(generateLevel(100), 28);
    assert('buildLevelWave(generateLevel(100), 28) 的第 1 组血量 = 只按 1.06^27 × hpScale 的期望值',
        oneWave.groups[0].hp === Math.max(1, Math.round(baselineHp(oneWave.groups[0], 28) * hpScale100)),
        `实际 ${oneWave.groups[0].hp} / 期望 ${Math.max(1, Math.round(baselineHp(oneWave.groups[0], 28) * hpScale100))}`);

    // 14.6 倍速档位：升序 1→2→3→4，且最高档必须小于单帧补帧上限（否则 60fps 下会丢欠账）
    const stepCap = Number((source.match(/MAX_STEPS_PER_FRAME\s*=\s*(\d+)/) || [])[1]);
    assert('倍速档位为 1,2,3,4 升序（按钮点一下走一档，4x 之后回到 1x）',
        Array.isArray(SPEED_LEVELS) && SPEED_LEVELS.join(',') === '1,2,3,4', String(SPEED_LEVELS));
    assert(`最高倍速 ${Math.max(...SPEED_LEVELS)}x < 单帧补帧上限 ${stepCap} 步（60fps 下一帧 ≈ speed 步，不触发丢欠账）`,
        stepCap === 5 && Math.max(...SPEED_LEVELS) < stepCap, `cap=${stepCap}`);

    // 14.7 实测表（供人工核对曲线，不是断言）
    console.log('  实测表（单波总血量 / 相对改动前倍数 / 所需 DPS）：');
    for (const n of [1, 10, 20, 30, 31, 40, 50, 75, 100]) {
        const sum = sumOf(waveOf(n)), base = baselineSum(n);
        console.log(`    ${String(n).padStart(3)} 波  总血量 ${String(sum).padStart(10)}  改动前 ${String(base).padStart(10)}`
            + `  ×${(sum / base).toFixed(3).padStart(6)}  需DPS ${String(Math.round(waveStat(n).dps)).padStart(8)}`);
    }
}

//  15. 无尽「真的无尽」：波次无上限 + 血量封顶不溢出
section('15. 无尽模式「真的无尽」：波次无上限 + 血量不溢出');
{
    const { generateEndlessWave } = mod;
    const HP_CEIL = mod.HP_CEIL;
    assert('导出了 HP_CEIL 且为有限正数', Number.isFinite(HP_CEIL) && HP_CEIL > 0, String(HP_CEIL));

    // 波次本身没有上限：这些超大波次都必须能正常生成（有分组、有出怪数）
    const huge = [1000, 8000, 10000, 50000, 100000, 1000000];
    let waveOk = true, hpOk = true, details = [];
    for (const n of huge) {
        const w = generateEndlessWave(n, 'endless-probe');
        const okWave = w && w.groups && w.groups.length >= 1 && w.total >= 1;
        const okHp = okWave && w.groups.every((g) => Number.isFinite(g.hp) && g.hp > 0 && g.hp <= HP_CEIL);
        if (!okWave) waveOk = false;
        if (!okHp) hpOk = false;
        if (!okWave || !okHp) details.push(n + ':' + JSON.stringify(w && w.groups && w.groups.map((g) => g.hp)));
    }
    assert('超大波次（1000 ~ 100 万）都能正常生成，没有波次上限', waveOk, details.join(' '));
    // 指数叠乘在第 ~1 万波会算成 Infinity；封顶后必须仍是有限正数
    assert('超大波次的每组血量都是有限正数且不超过 HP_CEIL（不会变 Infinity）', hpOk, details.join(' '));

    const w1e6 = generateEndlessWave(1000000, 'endless-probe');
    assert('第 100 万波的血量已被封顶（说明是「涨到头」而不是「溢出」）',
        w1e6.groups.every((g) => g.hp === HP_CEIL), w1e6.groups.map((g) => g.hp).join('/'));

    // 封顶不能影响正常范围：第 40/60/80/100 波仍要严格递增
    let rising = true; let prev = 0;
    for (const n of [40, 60, 80, 100]) {
        const w = generateEndlessWave(n, 'endless-probe');
        const hp = w.groups.reduce((sum, g) => sum + g.count * g.hp, 0);
        if (!(hp > prev)) rising = false;
        prev = hp;
    }
    assert('正常范围（40→60→80→100 波）单波总血量仍严格递增（封顶没波及日常区间）', rising);
}

//  16. 「批量升级」计划 planBatchUpgrade：先算后扣、等级最低优先、同级先建、钱不够就少升几座
section('16. 「批量升级」计划 planBatchUpgrade（先算后扣：等级最低优先 / 同级先建 / 钱不够就少升几座）');
{
    const { planBatchUpgrade, towerStat, MAX_TOWER_LEVEL } = mod;
    const tower = (type, lv, col = 0, row = 0, spend = 60) =>
        ({ type, lv, col, row, x: 0, y: 0, cd: 0, spend, dmgBuff: 0, rateBuff: 0 });
    const costOf = (type, lv) => towerStat(type, lv).upgradeCost;   // 与运行时同一份价格口径
    const show = (p) => (p.targets.length ? p.targets.map((t) => '#' + t.index + '/Lv.' + t.lv + '/' + t.cost).join(' ')
        : '（空计划）') + ' 合计=' + p.totalCost + ' canDo=' + p.canDo;

    // 16.1 count 夹取：0 / -5 / 非数字 → 1 座；999 → 100 座（200 座塔的场景，上限确实生效）
    const many = [];
    for (let i = 0; i < 200; i += 1) many.push(tower('arrow', 1));
    const cZero = planBatchUpgrade(many, 9e9, 0, true);
    const cNeg = planBatchUpgrade(many, 9e9, -5, true);
    const cBad = planBatchUpgrade(many, 9e9, 'abc', true);
    const cHuge = planBatchUpgrade(many, 9e9, 999, true);
    const cMid = planBatchUpgrade(many, 9e9, 5, true);
    assert('count 夹到 1..100：0 / -5 / 非数字 → 1 座，999 → 100 座（200 座塔的场景，上限确实生效）',
        cZero.targets.length === 1 && cNeg.targets.length === 1 && cBad.targets.length === 1
        && cHuge.targets.length === 100 && cMid.targets.length === 5,
        `${cZero.targets.length}/${cNeg.targets.length}/${cBad.targets.length}/${cHuge.targets.length}/${cMid.targets.length}`);

    // 16.2 挑选顺序：等级升序，不是数组（建造）顺序 —— [Lv.1, Lv.4, Lv.2] 取 2 座 → Lv.1 再 Lv.2
    const spread = [tower('arrow', 1, 1, 1, 60), tower('cannon', 4, 2, 2, 700), tower('frost', 2, 3, 3, 150)];
    const two = planBatchUpgrade(spread, 9e9, 2, true);
    assert('挑选顺序：[Lv.1, Lv.4, Lv.2] 取 2 座 → 先 Lv.1(index 0) 再 Lv.2(index 2)，不是按建造顺序',
        two.targets.length === 2 && two.targets[0].index === 0 && two.targets[0].lv === 1
        && two.targets[1].index === 2 && two.targets[1].lv === 2 && two.targets[1].nextLv === 3,
        show(two));

    // 16.3 同级取先建：两座都 Lv.2、只要 1 座 → index 0
    const tie = [tower('arrow', 2, 1, 1, 200), tower('frost', 2, 2, 2, 200)];
    const one = planBatchUpgrade(tie, 9e9, 1, true);
    assert('同级取先建：两座都 Lv.2、只升 1 座 → index 0（下标更小 = 先建）',
        one.targets.length === 1 && one.targets[0].index === 0, show(one));

    // 16.4 部分执行：钱只够 2 座、要 5 座 → 只给 2 座，totalCost 正好是这两座之和且不超过金币
    const five = [tower('arrow', 1), tower('frost', 1), tower('cannon', 1), tower('aura', 1), tower('arrow', 1)];
    const pA = costOf('arrow', 1), pF = costOf('frost', 1), pC = costOf('cannon', 1);
    const near = pA + pF + pC - 1;                       // 差 1 金币才够第三座
    const partial = planBatchUpgrade(five, near, 5, true);
    assert('部分执行：钱只够 2 座（差 1 金币够第三座）、要求 5 座 → 只返回 2 座，totalCost = 这两座之和且 <= 金币',
        partial.targets.length === 2 && partial.canDo === true
        && partial.targets[0].index === 0 && partial.targets[1].index === 1
        && partial.totalCost === pA + pF && partial.totalCost <= near,
        show(partial) + ` 金币=${near}`);

    // 16.5 钱连第一座都不够 → 空计划（按钮据此 disabled + 「金币不足」）
    const broke = planBatchUpgrade([tower('arrow', 1)], pA - 1, 5, true);
    assert('钱连第一座都不够 → targets 为空、canDo === false、totalCost === 0',
        broke.targets.length === 0 && broke.canDo === false && broke.totalCost === 0,
        show(broke) + ` 金币=${pA - 1}`);

    // 16.6 未解锁高等级时 Lv.3 算到顶：只挑 Lv.2 那座；解锁后两座都能被挑中
    const lock = [tower('arrow', 3, 1, 1, 400), tower('frost', 2, 2, 2, 150)];
    const lockedPlan = planBatchUpgrade(lock, 9e9, 5, false);
    const openPlan = planBatchUpgrade(lock, 9e9, 5, true);
    assert('未解锁 Lv.4+ 时跳过 Lv.3：[Lv.3, Lv.2] 只要 Lv.2 那座；highUnlocked=true 时两座都进计划',
        lockedPlan.targets.length === 1 && lockedPlan.targets[0].index === 1
        && openPlan.targets.length === 2 && openPlan.targets[0].index === 1 && openPlan.targets[1].index === 0,
        'locked: ' + show(lockedPlan) + '  open: ' + show(openPlan));

    // 16.7 全部满级 → 空计划
    const allMax = [tower('arrow', MAX_TOWER_LEVEL), tower('cannon', MAX_TOWER_LEVEL)];
    const maxedPlan = planBatchUpgrade(allMax, 9e9, 5, true);
    assert(`全部满级（Lv.${MAX_TOWER_LEVEL}）→ 空计划、canDo === false、totalCost === 0`,
        maxedPlan.targets.length === 0 && maxedPlan.canDo === false && maxedPlan.totalCost === 0,
        show(maxedPlan));

    // 16.8 纯函数：算计划不改塔（lv / spend 一个都没动），坏输入也不抛
    const beforeJson = JSON.stringify(spread.map((t) => [t.lv, t.spend]));
    planBatchUpgrade(spread, 9e9, 3, true);
    let bad = 'ok';
    try {
        if (planBatchUpgrade(undefined, 100, 3, true).targets.length !== 0) bad = 'undefined 未返回空计划';
        if (planBatchUpgrade([null, tower('nope', 1)], 9e9, 3, true).targets.length !== 0) bad = '坏元素未跳过';
        if (planBatchUpgrade([tower('arrow', 1)], 9e9, 3, true).targets.length !== 1) bad = '正常输入未返回计划';
    } catch (err) { bad = String(err && err.message); }
    assert('纯函数：算计划不改塔的 lv / spend；非数组、含 null 与未知塔类型都不抛异常',
        JSON.stringify(spread.map((t) => [t.lv, t.spend])) === beforeJson && bad === 'ok', bad);

    // 真实调用取样（报告里贴的就是这三行：3 座塔、要求 2 座、不同金币）
    const sample = [tower('arrow', 1, 1, 1, 60), tower('frost', 2, 2, 2, 150), tower('cannon', 1, 3, 3, 90)];
    const sA = costOf('arrow', 1), sC = costOf('cannon', 1);
    for (const g of [0, sA + sC - 1, sA + sC, 9e9]) {
        const p = planBatchUpgrade(sample, g, 2, true);
        console.log('  planBatchUpgrade(3 座 Lv.1/Lv.2/Lv.1, gold=' + g + ', count=2)：' + JSON.stringify({
            targets: p.targets.map((t) => ({ index: t.index, type: t.type, lv: t.lv, nextLv: t.nextLv, cost: t.cost })),
            totalCost: p.totalCost, canDo: p.canDo,
        }));
    }
}


// ─── 17. 超频 + 技能随波次强化 ───────────────────────────────

//  17. 超频（towerStat 第三参 / 50% 判定 / 一键计划）与技能随波次强化（花费 4% / 效果 5%）
section('17. 超频（towerStat 第三参 / overclockCost / overclockRoll / planBatchOverclock）与技能随波次强化');
{
    const {
        towerStat, describeTowers, overclockCost, overclockRoll, overclockFailLevel,
        planBatchOverclock, effectiveSkillCost, skillEffectScale, MAX_TOWER_LEVEL,
        SKILL_EFFECT_CAP, SKILL_CHILL_CAP,
    } = mod;
    const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
    const plain = (type, lv) => towerStat(type, lv, false);
    const over = (type, lv) => towerStat(type, lv, true);
    const tower = (type, lv, oc) => ({ type, lv, col: 0, row: 0, x: 0, y: 0, cd: 0, spend: 60, dmgBuff: 0, rateBuff: 0, oc });
    const show = (p) => (p.targets.length ? p.targets.map((t) => '#' + t.index + '/Lv.' + t.lv + '/' + t.cost).join(' ') : '（空计划）')
        + ' 合计=' + p.totalCost + ' canDo=' + p.canDo;

    // 17.1 普通塔：超频 = dmg ×1.6 / rate ×1.25 / range ×1.15，升级价不变（含 Lv.4+ 外推后的等级）
    const badMul = [];
    for (const [type, lv] of [['arrow', 1], ['cannon', 3], ['frost', 5], ['arrow', 12]]) {
        const b = plain(type, lv), o = over(type, lv);
        if (!near(o.dmg, b.dmg * 1.6)) badMul.push(`${type}Lv.${lv} dmg ${o.dmg}≠${b.dmg * 1.6}`);
        if (!near(o.rate, b.rate * 1.25)) badMul.push(`${type}Lv.${lv} rate ${o.rate}≠${b.rate * 1.25}`);
        if (!near(o.range, b.range * 1.15)) badMul.push(`${type}Lv.${lv} range ${o.range}≠${b.range * 1.15}`);
        if (o.upgradeCost !== b.upgradeCost) badMul.push(`${type}Lv.${lv} 升级价被超频改了`);
    }
    assert('towerStat(type, lv, true) 相对 false：dmg ×1.6 / rate ×1.25 / range ×1.15（容差 0.01，升级价不变）',
        badMul.length === 0, badMul.join('；'));

    // 17.2 第三参可缺省：省略 = 普通塔（既有调用零改动）
    const same = ['arrow', 'tesla', 'aura'].every((t) => {
        const a = towerStat(t, 4), b = towerStat(t, 4, false);
        return JSON.stringify(a) === JSON.stringify(b);
    });
    assert('第三参可缺省：towerStat(type, lv) 与 towerStat(type, lv, false) 完全一致（省略不等于超频）',
        same, '省略第三参的结果与 false 不同');

    // 17.3 特殊塔：毒 dot ×1.6 / 力场推回 ×1.25 / 特斯拉目标数 3→5 / 光环增幅 ×1.4（仍受 +100% 上限）
    const p0 = plain('poison', 2), p1 = over('poison', 2);
    const f0 = plain('force', 2), f1 = over('force', 2);
    const a0 = plain('aura', 2), a1 = over('aura', 2);
    const maxAura = over('aura', MAX_TOWER_LEVEL);
    assert('特殊塔加成：毒 dot ×1.6、力场推回 ×1.25、特斯拉 chainCount 3→5、光环 auraRate / auraDmg ×1.4',
        near(p1.poisonDps, p0.poisonDps * 1.6) && near(f1.pushTiles, f0.pushTiles * 1.25)
        && plain('tesla', 1).chainCount === 3 && over('tesla', 1).chainCount === 5
        && near(a1.auraRate, a0.auraRate * 1.4) && near(a1.auraDmg, a0.auraDmg * 1.4),
        JSON.stringify({ poison: [p0.poisonDps, p1.poisonDps], push: [f0.pushTiles, f1.pushTiles], aura: [a0.auraRate, a1.auraRate] }));

    // 17.4 上限：光环增幅仍 <= 1（+100%），冰塔减速 +10 个百分点但封顶 80%
    const frostMax = over('frost', MAX_TOWER_LEVEL);
    assert('超频没突破既有上限：光环 auraRate / auraDmg <= 1（+100%），冰塔减速 <= 80%（+10 个百分点）',
        maxAura.auraRate <= 1 && maxAura.auraDmg <= 1
        && near(over('frost', 1).slow, Math.min(0.8, plain('frost', 1).slow + 0.10)) && frostMax.slow <= 0.8,
        JSON.stringify({ aura: [maxAura.auraRate, maxAura.auraDmg], slow: [plain('frost', 1).slow, over('frost', 1).slow, frostMax.slow] }));

    // 17.5 超频价：Lv.1 = 240，且 1..MAX 严格递增
    const costs = [];
    for (let lv = 1; lv <= MAX_TOWER_LEVEL; lv += 1) costs.push(overclockCost(lv));
    assert('overclockCost(1) = 240，且在 Lv.1..MAX 上严格递增（每级 ×1.12）',
        overclockCost(1) === 240 && costs.every((c, i) => i === 0 || c > costs[i - 1]),
        'Lv.1=' + costs[0] + ' Lv.2=' + costs[1] + ' Lv.100=' + costs[99]);

    // 17.6 50% 边界：rand < 0.5 成功（0.49 成功 / 0.5 失败）
    assert('成功率 50% 的边界明确：overclockRoll(0.49) === true、overclockRoll(0.5) === false（0 成功 / 0.99 失败）',
        overclockRoll(0.49) === true && overclockRoll(0.5) === false
        && overclockRoll(0) === true && overclockRoll(0.99) === false,
        [0.49, 0.5, 0, 0.99].map((r) => r + '→' + overclockRoll(r)).join(' '));

    // 17.7 失败降 5 级，但最低 1 级
    assert('失败降 5 级且不低于 1 级：Lv.3 → 1、Lv.10 → 5、Lv.1 → 1、Lv.MAX → MAX-5',
        overclockFailLevel(3) === 1 && overclockFailLevel(10) === 5
        && overclockFailLevel(1) === 1 && overclockFailLevel(MAX_TOWER_LEVEL) === MAX_TOWER_LEVEL - 5,
        [3, 10, 1, MAX_TOWER_LEVEL].map((l) => 'Lv.' + l + '→' + overclockFailLevel(l)).join(' '));

    // 17.8 count 夹取：0 / -3 / 非数字 → 1 座；99 → 20 座
    const many = [];
    for (let i = 0; i < 30; i += 1) many.push(tower('arrow', 1));
    const c0 = planBatchOverclock(many, 9e9, 0), cNeg = planBatchOverclock(many, 9e9, -3);
    const cBad = planBatchOverclock(many, 9e9, 'x'), c99 = planBatchOverclock(many, 9e9, 99);
    const c5 = planBatchOverclock(many, 9e9, 5);
    assert('count 夹到 1..20：0 / -3 / 非数字 → 1 座，99 → 20 座（30 座塔的场景，上限确实生效）',
        c0.targets.length === 1 && cNeg.targets.length === 1 && cBad.targets.length === 1
        && c99.targets.length === 20 && c5.targets.length === 5,
        [c0, cNeg, cBad, c99, c5].map((p) => p.targets.length).join('/'));

    // 17.9 挑选顺序：等级最高优先、同级取先建、跳过已超频
    const mix = [tower('arrow', 2), tower('cannon', 9), tower('frost', 2), tower('poison', 9, true)];
    const pmix = planBatchOverclock(mix, 9e9, 3);
    assert('等级最高优先、同级取先建、跳过已超频：[Lv.2, Lv.9, Lv.2, Lv.9(已超频)] 取 3 座 → index 1（Lv.9）、index 0、index 2（同为 Lv.2，先建的在前）',
        pmix.targets.length === 3 && pmix.targets[0].index === 1
        && pmix.targets[1].index === 0 && pmix.targets[2].index === 2
        && pmix.targets.every((t) => t.index !== 3),
        show(pmix));

    // 17.10 部分执行：钱只够 2 座、要求 5 座 → 2 座，totalCost <= 金币
    const one = overclockCost(1);
    const fiveT = [tower('arrow', 1), tower('frost', 1), tower('cannon', 1), tower('aura', 1), tower('arrow', 1)];
    const partial = planBatchOverclock(fiveT, one * 2, 5);
    const partialMinus = planBatchOverclock(fiveT, one * 3 - 1, 5);   // 差 1 金币才够第三座
    assert('部分执行：钱只够 2 座（或差 1 金够第三座）、要求 5 座 → 只返回 2 座，totalCost = 2 × 单价且 <= 金币',
        partial.targets.length === 2 && partial.canDo === true && partial.totalCost === one * 2
        && partial.totalCost <= one * 2
        && partialMinus.targets.length === 2 && partialMinus.totalCost <= one * 3 - 1,
        show(partial) + ` 单价=${one}`);

    // 17.11 钱不够第一座 → 空计划
    const broke = planBatchOverclock([tower('arrow', 1)], one - 1, 5);
    assert('钱连第一座都不够 → targets 为空、canDo === false、totalCost === 0',
        broke.targets.length === 0 && broke.canDo === false && broke.totalCost === 0,
        show(broke) + ` 金币=${one - 1}`);

    // 17.12 纯函数：算计划不改塔（oc 一处都不写），坏输入不抛
    const beforeOc = mix.map((t) => t.oc);
    let badInput = 'ok';
    try {
        if (planBatchOverclock(undefined, 100, 3).targets.length !== 0) badInput = 'undefined 未返回空计划';
        if (planBatchOverclock([null, tower('nope', 1)], 9e9, 3).targets.length !== 0) badInput = '坏元素未跳过';
        if (planBatchOverclock([tower('arrow', 0)], 9e9, 1).targets.length !== 0) badInput = '等级 0 未跳过';
    } catch (err) { badInput = String(err && err.message); }
    assert('纯函数：算计划不改塔的 oc；非数组 / null 元素 / 未知塔类型 / 等级异常都不抛异常',
        JSON.stringify(mix.map((t) => t.oc)) === JSON.stringify(beforeOc) && badInput === 'ok', badInput);

    // 17.13 清单同源：describeTowers 把 oc 带出来，且数值已经是超频后的
    const rows = describeTowers([
        { type: 'arrow', lv: 4, col: 1, row: 1, x: 0, y: 0, cd: 0, spend: 900, dmgBuff: 0, rateBuff: 0, oc: true },
        { type: 'arrow', lv: 4, col: 2, row: 2, x: 0, y: 0, cd: 0, spend: 900, dmgBuff: 0, rateBuff: 0 },
    ], { gold: 0, highUnlocked: true });
    assert('describeTowers：清单行的 oc 字段为 true / false，dmg 与 range 已经是超频后的值（与战斗同源）',
        rows.length === 2 && rows[0].oc === true && rows[1].oc === false
        && near(rows[0].dmg, towerStat('arrow', 4, true).dmg) && near(rows[0].range, towerStat('arrow', 4, true).range),
        JSON.stringify(rows.map((r) => [r.lv, r.oc, r.dmg, r.range])));

    // 17.14 技能随波次强化：解锁前不放大，解锁后每波 +4% 花费 / +5% 效果
    //      （用与 SKILLS 同形的fixture 直接喂纯函数：它们是纯函数，只认传进去的 skill 对象）
    const meteor = { id: 'meteor', cost: 150, unlockWave: 8 };
    const chill = { id: 'chill', cost: 60, unlockWave: 4 };
    const timestop = { id: 'timestop', cost: 380, unlockWave: 26 };
    const overload = { id: 'overload', cost: 500, unlockWave: 32 };
    assert('未解锁阶段不放大：第 1 波（陨石解锁于第 8 波）花费 = 基础 150、倍率 = 1；解锁当波同样不加价',
        effectiveSkillCost(meteor, 1) === 150 && skillEffectScale(meteor, 1) === 1
        && effectiveSkillCost(meteor, 8) === 150 && skillEffectScale(meteor, 8) === 1,
        `w1=${effectiveSkillCost(meteor, 1)}/${skillEffectScale(meteor, 1)} w8=${effectiveSkillCost(meteor, 8)}/${skillEffectScale(meteor, 8)}`);
    assert('超出解锁波次 N 波按线性放价：陨石第 9 波 156、第 10 波 162、第 50 波 = round(150×(1+4%×42))',
        effectiveSkillCost(meteor, 9) === 156 && effectiveSkillCost(meteor, 10) === 162
        && effectiveSkillCost(meteor, 50) === Math.round(150 * (1 + 0.04 * 42))
        && near(skillEffectScale(meteor, 50), 1 + 0.05 * 42),
        `w9=${effectiveSkillCost(meteor, 9)} w10=${effectiveSkillCost(meteor, 10)} w50=${effectiveSkillCost(meteor, 50)}`);
    const s100 = skillEffectScale(timestop, 100);
    assert('效果上限：时停 / 超载的倍率在施放处封顶 2 倍，寒流减速封顶 80%（倍率本身仍线性长）',
        s100 > 2 && Math.min(SKILL_EFFECT_CAP, s100) === 2 && SKILL_EFFECT_CAP === 2
        && Math.min(SKILL_CHILL_CAP, 0.5 * s100) === 0.8 && SKILL_CHILL_CAP === 0.8
        && Math.min(SKILL_EFFECT_CAP, skillEffectScale(overload, 100)) === 2
        && Math.min(SKILL_CHILL_CAP, 0.5 * skillEffectScale(chill, 100)) === 0.8,
        `时停w100=${s100} 寒流=${0.5 * s100}`);

    // 真实取样（报告里贴的就是这几行）
    console.log('  超频数值对比（普通 → 超频）：');
    for (const [type, lv] of [['arrow', 1], ['arrow', 12], ['cannon', 3], ['tesla', 1], ['poison', 2], ['force', 2], ['aura', 2]]) {
        const b = plain(type, lv), o = over(type, lv);
        console.log('    ' + type.padEnd(7) + ' Lv.' + String(lv).padStart(2) + '：'
            + 'dmg ' + b.dmg.toFixed(2) + ' → ' + o.dmg.toFixed(2)
            + ' · rate ' + b.rate.toFixed(3) + ' → ' + o.rate.toFixed(3)
            + ' · range ' + b.range.toFixed(1) + ' → ' + o.range.toFixed(1)
            + ' · 特效 ' + JSON.stringify({
                slow: o.slow, auraRate: o.auraRate, auraDmg: o.auraDmg,
                poisonDps: Number(o.poisonDps.toFixed(1)), pushTiles: Number(o.pushTiles.toFixed(2)), chainCount: o.chainCount,
            }));
    }
    console.log('  overclockCost 取样：Lv.1=' + overclockCost(1) + ' Lv.5=' + overclockCost(5)
        + ' Lv.20=' + overclockCost(20) + ' Lv.50=' + overclockCost(50) + ' Lv.100=' + overclockCost(100));
    console.log('  技能随波次：陨石(w8 解锁) 花费 ' + [8, 20, 50, 100].map((w) => 'w' + w + '=' + effectiveSkillCost(meteor, w)).join(' ')
        + ' · 倍率 ' + [8, 20, 50, 100].map((w) => 'w' + w + '=' + skillEffectScale(meteor, w).toFixed(2)).join(' '));
}


// ─── 18. 存档：超频 / 护盾 / 技能冷却的落盘与向后兼容 ────────

//  18. 存档新增字段（oc / shield / skillReady）：往返、旧存档兼容、只存 >0 项、坏值不炸
section('18. 无尽存档新增可选字段（oc / shield / skillReady）：往返 / 旧存档兼容 / 只存 >0 / 坏值不炸');
{
    const { encodeSave, decodeSave, RUN_LEFT_MAX_MS } = mod;
    const mk = (run) => ({ unlocked: 1, levelBest: {}, endlessBest: 0, endlessRun: run });
    const baseRun = {
        wave: 9, gold: 420, lives: 14, kills: 208, seed: 'run-x', savedAt: 1700000000000,
        towers: [{ type: 'arrow', col: 3, row: 5, lvl: 2, oc: true }, { type: 'aura', col: 4, row: 5, lvl: 3, oc: false }],
    };

    // 18.1 往返：oc:true 保留；oc:false 不写回（false 与「缺键」等价，老存档的字面往返因此不变）
    const trip = decodeSave(encodeSave(mk(baseRun)));
    assert('超频往返：oc:true 的塔经 encodeSave → decodeSave 仍是 true；oc:false 不写回（契约上等于普通塔）',
        !!trip && !!trip.endlessRun && trip.endlessRun.towers[0].oc === true
        && trip.endlessRun.towers[1].oc === undefined,
        JSON.stringify(trip && trip.endlessRun && trip.endlessRun.towers));

    // 18.2 旧存档兼容：老格式（没有 oc / shield / skillReady）必须能读
    const oldRun = {
        wave: 3, gold: 100, lives: 20, kills: 5, seed: 'run-old', savedAt: 1700000000001,
        towers: [{ type: 'arrow', col: 1, row: 2, lvl: 4 }],
    };
    const oldBack = decodeSave(encodeSave(mk(oldRun)));
    assert('旧存档兼容：不含 oc / shield / skillReady 的老格式 run 解码不为 null，塔的 oc 为假值、三个字段都不凭空出现',
        !!oldBack && !!oldBack.endlessRun && !oldBack.endlessRun.towers[0].oc
        && !('shield' in oldBack.endlessRun) && !('skillReady' in oldBack.endlessRun),
        JSON.stringify(oldBack && oldBack.endlessRun));

    // 18.3 只存 > 0 的项：0 / 负数 / 非数字 / hits:0 一律丢弃，连字段都不写
    const zeroRun = Object.assign({}, baseRun, {
        skillReady: { chill: 0, meteor: -5, repair: 'abc' },
        shield: { hits: 0, ms: 5000 },
    });
    const zeroBack = decodeSave(encodeSave(mk(zeroRun)));
    assert('冷却 / 护盾只存 > 0 的项：{chill:0, meteor:-5, repair:"abc"} 与 hits:0 全部丢弃，skillReady / shield 两个字段都不出现',
        !!zeroBack && !('skillReady' in zeroBack.endlessRun) && !('shield' in zeroBack.endlessRun),
        JSON.stringify(zeroBack && zeroBack.endlessRun));

    // 18.4 坏值不炸 + 夹取：脏数据丢弃、越界值夹到上限
    const dirtyRun = Object.assign({}, baseRun, {
        shield: { hits: -5, ms: 'abc' },
        skillReady: { chill: -1, nope: 99999 },
    });
    const clampRun = Object.assign({}, baseRun, {
        shield: { hits: 99, ms: 9e9 },
        skillReady: { chill: 9e9 },
    });
    let threw = null, dirty = null, clamped = null;
    try {
        dirty = decodeSave(encodeSave(mk(dirtyRun)));
        clamped = decodeSave(encodeSave(mk(clampRun)));
    } catch (err) { threw = err; }
    assert('坏值不炸：shield:{hits:-5,ms:"abc"} 与 skillReady:{chill:-1, nope:99999} 解码不抛异常，两个字段被丢弃',
        threw === null && !!dirty && !('shield' in dirty.endlessRun) && !('skillReady' in dirty.endlessRun),
        threw ? '抛出异常：' + threw : JSON.stringify(dirty && dirty.endlessRun));
    assert('越界值夹到上限：shield.hits 夹到 SHIELD.maxHits(6)、ms 与冷却剩余夹到 ' + RUN_LEFT_MAX_MS + '（10 分钟）',
        !!clamped && clamped.endlessRun.shield.hits === 6
        && clamped.endlessRun.shield.ms === RUN_LEFT_MAX_MS
        && clamped.endlessRun.skillReady.chill === RUN_LEFT_MAX_MS,
        JSON.stringify(clamped && clamped.endlessRun));

    // 18.5 往返取样（报告里贴的就是这两行）
    console.log('  旧格式存档（无新字段）：' + JSON.stringify(oldRun));
    console.log('  解码结果：' + JSON.stringify(oldBack && oldBack.endlessRun));
    console.log('  超频 + 冷却 + 护盾齐全的往返：' + JSON.stringify(decodeSave(encodeSave(mk(Object.assign({}, baseRun, {
        skillReady: { chill: 12000 }, shield: { hits: 3, ms: 8000 },
    }))))?.endlessRun));
}


// ─── 19. 技能施放接线：SKILL_CASTERS 覆盖 12 个技能 + 回收计划 ──

//  19. 防「按钮有、点了没反应」：SKILL_CASTERS 的键集与 SKILLS 逐位比对；planSalvage 的选塔 / 返还 / 纯度
section('19. 技能施放接线：SKILL_CASTERS 覆盖全部 12 个技能 + 回收计划 planSalvage');
{
    const { SKILL_CASTERS, planSalvage } = mod;
    const skillsMod = await import(toModuleUrl(path.join(root, 'src', 'pages', 'td-skills.js')));
    const { SKILLS, SALVAGE, salvageRefund } = skillsMod;

    // 19.1 覆盖：SKILLS 里有的 id，表里必须有函数 —— 漏一个就 FAIL（本次 bug 的复发保险）
    const ids = SKILLS.map((s) => s.id);
    const missing = ids.filter((id) => typeof SKILL_CASTERS[id] !== 'function');
    assert('SKILL_CASTERS 覆盖全部 ' + ids.length + ' 个技能 id（' + ids.join('/') + '），缺一个即失败',
        ids.length === 12 && missing.length === 0,
        'missing=' + JSON.stringify(missing));

    // 19.2 反向：表里不许有多余 / 拼错的 id（键集必须与 SKILLS 完全一致）
    const keys = Object.keys(SKILL_CASTERS);
    assert('SKILL_CASTERS 的键集与 SKILLS 完全一致（没有多余 / 拼错的 id）',
        keys.length === ids.length && keys.every((k) => ids.includes(k)),
        JSON.stringify(keys));

    // 19.3 每个 caster 都是函数（不是 undefined / 占位字符串 / 对象）
    assert('12 个 caster 全部是函数（typeof === "function"）',
        keys.length === 12 && keys.every((k) => typeof SKILL_CASTERS[k] === 'function'),
        JSON.stringify(keys.map((k) => k + ':' + typeof SKILL_CASTERS[k])));

    // 19.4 选塔：5 座不同等级取 3 座 → 等级最低优先，同级取下标更小者（= 先建者）
    const mkTower = (type, lv, spend, i) => ({
        type, lv, spend, col: i, row: 0, x: i * 32, y: 0, cd: 0, rateBuff: 0, dmgBuff: 0,
    });
    const five = [
        mkTower('arrow', 3, 400, 0),
        mkTower('cannon', 5, 900, 1),
        mkTower('frost', 2, 300, 2),
        mkTower('tesla', 4, 700, 3),
        mkTower('aura', 2, 260, 4),
    ];
    const plan5 = planSalvage(five, 3);
    assert('planSalvage：5 座不同等级取 3 座 → 等级最低的 frost(2)/aura(2)/arrow(3)，同为 2 级时先建的 frost 在前',
        plan5.targets.length === 3
        && plan5.targets.map((t) => t.index).join(',') === '2,4,0'
        && plan5.targets.map((t) => t.lv).join(',') === '2,2,3',
        JSON.stringify(plan5.targets.map((t) => [t.index, t.type, t.lv])));

    // 19.5 不足 count / 空场
    const two = [mkTower('arrow', 7, 500, 0), mkTower('frost', 6, 400, 1)];
    const plan2 = planSalvage(two, 3);
    const plan0 = planSalvage([], 3);
    assert('planSalvage：不足 3 座时返回全部（2 座 → 2 项，等级低的排前面）；空数组 → 空计划且 totalRefund === 0',
        plan2.targets.length === 2 && plan2.targets[0].index === 1 && plan2.targets[0].lv === 6
        && plan0.targets.length === 0 && plan0.totalRefund === 0,
        JSON.stringify({ plan2: plan2.targets.map((t) => t.index), plan0 }));

    // 19.6 全额返还（不是出售的 60%）：refund = salvageRefund(spend, 1) = spend
    const fullOk = plan5.targets.every((t) => t.refund === salvageRefund(t.tower.spend, 1) && t.refund === t.tower.spend);
    const sumOk = plan5.totalRefund === plan5.targets.reduce((s, t) => s + t.refund, 0);
    const notSale = plan5.targets.every((t) => t.refund !== Math.floor(t.tower.spend * BALANCE.sellRatio));
    assert('planSalvage 的 refund 是全额（= salvageRefund(spend, 1) = spend），不是出售的 60%；totalRefund = 各项之和',
        SALVAGE.refundRatio === 1 && fullOk && sumOk && notSale,
        JSON.stringify({ refunds: plan5.targets.map((t) => t.refund), total: plan5.totalRefund }));

    // 19.7 纯度：连算三次（3 / 5 / 0 座）不改塔的任何字段
    const snapshot = JSON.stringify(five);
    planSalvage(five, 3);
    planSalvage(five, 5);
    planSalvage(five, 0);
    assert('planSalvage 是纯函数：连算三次（3 / 5 / 0 座）之后每座塔的字段一字未变',
        JSON.stringify(five) === snapshot,
        JSON.stringify(five) === snapshot ? '' : '塔被改写了：' + JSON.stringify(five));

    console.log('  SKILL_CASTERS 键：' + keys.join(' / '));
    console.log('  5 座塔取 3 座的计划：' + JSON.stringify(plan5.targets.map((t) => ({ i: t.index, n: t.name, lv: t.lv, refund: t.refund })))
        + ' · totalRefund=' + plan5.totalRefund);
}


// ─── 20. 词缀 / 连携 / 专精 / 下一波预告：四个模块接进主文件后的接线 ──

//  20. 这一节只断言「接线」与「跨文件一致性」，模块自身的单元断言在 td-affix-test / td-synergy-test /
//      td-spec-test 里。为什么还要写一遍：模块内自检全绿，接线错了照样静默失效（applyAffix 忘了用返回值、
//      专精 pick 写错塔、连携时刻用了 Date.now()）—— 这三类错误在浏览器里都表现为「什么都没发生」。
section('20. 词缀 / 连携 / 专精 / 下一波预告：模块接线与跨文件一致性');
{
    const { ENEMY_TYPES, towerStat, towerStatSpec, nextWavePreview, encodeSave, decodeSave } = mod;
    const affixMod = await import(toModuleUrl(path.join(root, 'src', 'pages', 'td-affixes.js')));
    const specMod = await import(toModuleUrl(path.join(root, 'src', 'pages', 'td-specialization.js')));
    const synMod = await import(toModuleUrl(path.join(root, 'src', 'pages', 'td-synergy.js')));
    const { affixForWave, applyAffix, affixLabel } = affixMod;
    const { matchSynergy } = synMod;
    void specMod;

    // 20.1 词缀模块里的「敌人基础值副本」必须与主文件 ENEMY_TYPES 逐项一致。
    //      副本本身不导出（模块要保持零 import、零依赖），所以这里直接读源码里那段 BASE 字面量。
    const affixSrc = readFileSync(path.join(root, 'src', 'pages', 'td-affixes.js'), 'utf8');
    const baseAt = affixSrc.indexOf('const BASE = {');
    const baseSrc = baseAt < 0 ? '' : affixSrc.slice(baseAt, affixSrc.indexOf('};', baseAt) + 2);
    const baseRe = /(\w+):\s*\{\s*hp:\s*([\d.]+),\s*speed:\s*([\d.]+),\s*bounty:\s*([\d.]+)\s*\}/g;
    const copies = Array.from(baseSrc.matchAll(baseRe),
        (m) => ({ type: m[1], hp: Number(m[2]), speed: Number(m[3]), bounty: Number(m[4]) }));
    const mismatch = copies.filter((c) => {
        const e = ENEMY_TYPES[c.type];
        return !e || e.hp !== c.hp || e.speed !== c.speed || e.bounty !== c.bounty;
    });
    assert('词缀模块的基础值副本与 ENEMY_TYPES 逐项一致（basic/swift/armor/shield/boss 的 hp/speed/bounty）',
        copies.length === 5 && mismatch.length === 0,
        JSON.stringify({ 副本: copies, 不一致: mismatch }));
    for (const c of copies) {
        const e = ENEMY_TYPES[c.type] || {};
        console.log('    ' + String(c.type).padEnd(7) + '副本 ' + c.hp + '/' + c.speed + '/' + c.bounty
            + '  ·  ENEMY_TYPES ' + e.hp + '/' + e.speed + '/' + e.bounty);
    }

    // 20.2 词缀被真正用上：第 5 波配置 ≠ 同波无词缀配置
    const plain5 = generateEndlessWave(5, SEED);
    const affix5 = affixForWave(5, SEED);
    const with5 = applyAffix(plain5, affix5);
    const fieldChanged = with5.total !== plain5.total || with5.spawnGap !== plain5.spawnGap
        || with5.groups.some((g, i) => !plain5.groups[i]
            || g.hp !== plain5.groups[i].hp || g.speed !== plain5.groups[i].speed
            || g.count !== plain5.groups[i].count || g.bounty !== plain5.groups[i].bounty);
    assert('第 5 波有词缀，且 applyAffix 返回**新对象**（波配置与 groups 都不是同一份，入参一字未改）',
        !!affix5 && typeof affixLabel(affix5) === 'string' && affixLabel(affix5).length > 0
        && with5 !== plain5 && with5.groups !== plain5.groups,
        'affix5=' + JSON.stringify(affix5 && affix5.id));
    assert('第 5 波配置 ≠ 同波无词缀配置（这条防「忘了用返回值 → 词缀静默失效」）',
        fieldChanged,
        JSON.stringify({ total: [plain5.total, with5.total], gap: [plain5.spawnGap, with5.spawnGap] }));
    assert('主文件把 applyAffix 的返回值赋回波配置，并把词缀记进 state.waveAffix',
        /wave\s*=\s*applyAffix\(wave,\s*affix\)/.test(source) && /state\.waveAffix\s*=\s*affix/.test(source),
        '源码里找不到「wave = applyAffix(wave, affix)」或「state.waveAffix = affix」');
    // flags.noSlow 必须真的拦住两条减速通道（冰塔命中的 slowUntil / 寒流技能）
    assert('减速结算处（冰塔 impact + 寒流技能）都判了禁魔：if (!waveNoSlow()) 与 if (waveNoSlow()) 各一处',
        /if \(!waveNoSlow\(\)\)/.test(source) && /if \(waveNoSlow\(\)\)/.test(source),
        'waveNoSlow() 调用点：' + (source.match(/waveNoSlow\(\)/g) || []).length + ' 处');

    // 20.3 nextWavePreview 是纯函数：不碰 DOM、不读时钟，0 座塔也不炸
    let emptyPrev = null, emptyThrew = null;
    try { emptyPrev = nextWavePreview({ wave: 3, seed: SEED, mode: 'endless', level: null, towers: [] }); }
    catch (err) { emptyThrew = err; }
    assert('nextWavePreview：0 座塔 → myDps === 0、ratio 为 Infinity（不是 NaN / 0），且不抛异常',
        emptyThrew === null && !!emptyPrev && emptyPrev.myDps === 0 && emptyPrev.ratio === Infinity,
        emptyThrew ? '抛出异常：' + emptyThrew : JSON.stringify(emptyPrev));
    const oneTower = nextWavePreview({
        wave: 3, seed: SEED, mode: 'endless', level: null,
        towers: [{ type: 'arrow', lv: 1, rateBuff: 0, dmgBuff: 0 }],
    });
    assert('nextWavePreview：1 座 Lv.1 箭塔 → myDps ≈ 8 × 1.6 = 12.8（容差 0.5）',
        Math.abs(oneTower.myDps - 12.8) <= 0.5, '实际 myDps = ' + oneTower.myDps);

    // 20.4 预告的三个基本量
    assert('nextWavePreview：total > 0、reqDps > 0、comp 是非空字符串（带兵种名与 ×数量）',
        oneTower.total > 0 && oneTower.reqDps > 0 && Math.abs(oneTower.ratio - (oneTower.reqDps / oneTower.myDps)) < 1e-9
        && typeof oneTower.comp === 'string' && oneTower.comp.length > 0 && oneTower.comp.indexOf('×') >= 0,
        JSON.stringify({ total: oneTower.total, reqDps: oneTower.reqDps, comp: oneTower.comp, ratio: oneTower.ratio }));
    const prevOf5 = nextWavePreview({ wave: 4, seed: SEED, mode: 'endless', level: null, towers: [] });   // 下一波 = 5
    const prevOf6 = nextWavePreview({ wave: 5, seed: SEED, mode: 'endless', level: null, towers: [] });   // 下一波 = 6
    assert('预告条的词缀文案只在 5 的倍数波出现（第 5 波有、第 6 波没有）',
        prevOf5.wave === 5 && prevOf5.affixLabel.length > 0 && prevOf6.affixLabel === '',
        JSON.stringify({ w5: prevOf5.affixLabel, w6: prevOf6.affixLabel }));
    console.log('  第 5 波预告：total=' + prevOf5.total + ' comp=' + prevOf5.comp
        + ' reqDps≈' + Math.round(prevOf5.reqDps) + ' myDps=' + prevOf5.myDps + ' · ' + prevOf5.affixLabel);

    // 20.5 专精存档往返 + 旧存档兼容 + 非法 pick 逐档丢弃
    const mkProgress = (run) => ({ unlocked: 1, levelBest: {}, endlessBest: 0, endlessRun: run });
    const runBase = { wave: 60, gold: 5000, lives: 12, kills: 900, seed: 'run-spec', savedAt: 1700000000000 };
    const specTrip = decodeSave(encodeSave(mkProgress(Object.assign({}, runBase,
        { towers: [{ type: 'arrow', col: 2, row: 3, lvl: 10, spec: { 10: 'arrow10a' } }] }))));
    assert('专精存档往返：towers[].spec = {10:"arrow10a"} 经 encodeSave → decodeSave 仍是同一 pick',
        !!specTrip && !!specTrip.endlessRun && !!specTrip.endlessRun.towers[0].spec
        && specTrip.endlessRun.towers[0].spec[10] === 'arrow10a',
        JSON.stringify(specTrip && specTrip.endlessRun && specTrip.endlessRun.towers));
    const oldTrip = decodeSave(encodeSave(mkProgress(Object.assign({}, runBase,
        { towers: [{ type: 'arrow', col: 2, row: 3, lvl: 10 }] }))));
    assert('旧存档（塔上没有 spec）解码不为 null，且 spec 读出来是空的（缺字段绝不能让整份存档作废）',
        !!oldTrip && !!oldTrip.endlessRun && oldTrip.endlessRun.towers.length === 1
        && Object.keys(oldTrip.endlessRun.towers[0].spec || {}).length === 0,
        JSON.stringify(oldTrip && oldTrip.endlessRun && oldTrip.endlessRun.towers));
    const badSpec = decodeSave(encodeSave(mkProgress(Object.assign({}, runBase, {
        towers: [{ type: 'arrow', col: 2, row: 3, lvl: 25, spec: { 10: 'frost25a', 25: 'nope', 50: 42 } }],
    }))));
    assert('非法 / 跨塔的 pick（frost25a 塞进箭塔、25:"nope"、50:42）逐档丢弃，但那份存档仍然有效',
        !!badSpec && !!badSpec.endlessRun && badSpec.endlessRun.towers.length === 1
        && Object.keys(badSpec.endlessRun.towers[0].spec || {}).length === 0,
        JSON.stringify(badSpec && badSpec.endlessRun && badSpec.endlessRun.towers));

    // 20.6 专精与 towerStat 串起来：数字必须真的变大，chainCount 必须由 towerStat 原样提供
    const lv10 = towerStat('arrow', 10);
    const spec10 = towerStatSpec('arrow', 10, false, { 10: 'arrow10a' });
    assert('箭塔 Lv.10 选 arrow10a（伤害 +25%）后 dmg = 未选时 × 1.25（容差 0.01）',
        Math.abs(spec10.dmg - lv10.dmg * 1.25) <= 0.01 && spec10.dmg > lv10.dmg,
        '未选 ' + lv10.dmg.toFixed(2) + ' → 选后 ' + spec10.dmg.toFixed(2));
    assert('chainCount 由 towerStat 原样提供：非链式塔为 0、特斯拉为 3，tesla25a 只 +1（0 + 1 会变成「1 个目标」）',
        towerStat('arrow', 10).chainCount === 0 && towerStat('tesla', 10).chainCount === 3
        && towerStatSpec('tesla', 25, false, { 25: 'tesla25a' }).chainCount === 4,
        JSON.stringify({
            arrow: towerStat('arrow', 10).chainCount,
            tesla: towerStat('tesla', 10).chainCount,
            tesla25a: towerStatSpec('tesla', 25, false, { 25: 'tesla25a' }).chainCount,
        }));

    // 20.7 连携：窗口边界与模块一致；时钟只有 state.timeMs 一套
    //      vortex→meteor 的窗口是 4000ms 且取**闭区间**：1000 起算，5000 命中、5001 不命中。
    const hitIn = matchSynergy('vortex', 1000, 'meteor', 5000);
    const hitOut = matchSynergy('vortex', 1000, 'meteor', 5001);
    assert('连携窗口与模块一致：vortex→meteor 在 +4000ms 命中（闭区间边界），4001ms 之后不命中',
        !!hitIn && hitIn.kind === 'dmg' && hitIn.second === 'meteor' && hitIn.windowMs === 4000 && hitOut === null,
        JSON.stringify({ in: hitIn && hitIn.kind, out: hitOut }));
    assert('主文件的连携时刻只用 state.timeMs（写回处不碰 Date.now），且判定用的是旧 lastSkill*',
        /state\.lastSkillAtMs\s*=\s*state\.timeMs/.test(source)
        && !/lastSkillAtMs\s*=\s*Date\.now\(\)/.test(source)
        && /matchSynergy\(state\.lastSkillId,\s*state\.lastSkillAtMs,\s*\w+,\s*state\.timeMs\)/.test(source),
        '源码里的连携时钟不是 state.timeMs');

    // 20.8 升级价斜率：1.35 → 1.12 之后 Lv.50 不再是「摸不到」的价格
    const cost50 = towerStat('arrow', 50).upgradeCost;
    assert('升级价斜率 1.12 生效：towerStat("arrow",50).upgradeCost 落在 1 万~20 万之间（不是 4 亿）',
        mod.HIGH_LV_COST_STEP === 1.12 && mod.HIGH_LV_DMG_STEP === 1.12
        && cost50 >= 10000 && cost50 <= 200000,
        'HIGH_LV_COST_STEP=' + mod.HIGH_LV_COST_STEP + ' cost50=' + cost50);
    console.log('  Lv.50 单次升级价：' + cost50 + '（旧斜率 1.35 下是 '
        + Math.round(220 * Math.pow(1.35, 48)) + '）· 箭塔 dmg Lv.10 ' + lv10.dmg.toFixed(1)
        + ' → Lv.50 ' + towerStat('arrow', 50).dmg.toFixed(1));
}


// ─── 21. 「90 波卡死」的修复：僵局出口 / 血量斜率 / 性能兜底 / 残留敌人回收 ──────
//
//   参考 DPS 口径（平衡断言 21.9 用它，**阈值 240 秒不许放宽**）：
//    REF_DPS = 100,000。为什么是十万：
//     ① 复现存档（第 90 波 · 3 座 Lv.50 超频塔）实测总输出「几万」，约 2.7 万；
//     ② 打到 90 波的玩家金币按 1.05^(n-1) 涨、升级价斜率已降到 1.12（见 20.8），塔的等级与座数
//        都会明显高于那个复现阵容 —— 十万只比它高约 3.7 倍；
//     ③ 上限侧参照：Lv.100 箭塔单体 dmg ≈ 1.43e6 × 4.4/s ≈ 627 万 DPS，十万只占其 1.6%。
//    所以十万是「一个认真玩到 90 波的玩家应能达到」的**下限**口径，不是乐观值。
//    清完秒数 = 单波总血量 ÷ REF_DPS（忽略护甲与出怪时长，纯持续输出口径，只用来抓数量级）。
section('21. 高波次「打不完」的修复：僵局出口 / 血量斜率 / 性能兜底 / 残留敌人');
const REF_DPS = 100000;
const CLEAR_SEC_MAX = 240;   // 护栏：第 90 波必须在 240 秒内清完（这条阈值不许放宽）
{
    const { ENEMY_TYPES, isWaveStalled, STALL_LIMITS, isRunawayEnemy, MAX_TOWERS,
        pointAt, nextWavePreview, towersDps, LATE_HP_STEP } = mod;

    // 21.1 阈值策略本身也断言：口径被人顺手改掉时这里先响
    assert('isWaveStalled / STALL_LIMITS 已导出，阈值 = 90s / 20s / 5min，提醒间隔 60s',
        typeof isWaveStalled === 'function' && !!STALL_LIMITS
        && STALL_LIMITS.waveMs === 90000 && STALL_LIMITS.sinceKillMs === 20000
        && STALL_LIMITS.hardMs === 300000 && STALL_LIMITS.remindMs === 60000,
        JSON.stringify(STALL_LIMITS));

    // 21.2 正例：90 秒 + 20 秒无击杀 + 有活怪 → true
    assert('僵局：90 秒 + 20 秒无击杀 + 场上有活怪 → true',
        isWaveStalled({ waveMs: 90000, sinceKillMs: 20000, aliveCount: 5, total: 400 }) === true, '');

    // 21.3 两条边界各一条（差 1 秒不算）
    assert('僵局边界：波次 89 秒 → false',
        isWaveStalled({ waveMs: 89000, sinceKillMs: 60000, aliveCount: 5 }) === false, '');
    assert('僵局边界：19 秒前刚杀过 → false（输出还跟得上就不打扰）',
        isWaveStalled({ waveMs: 120000, sinceKillMs: 19000, aliveCount: 5 }) === false, '');

    // 21.4 场上无活怪 → 永远 false（哪怕时间早就超了）
    assert('僵局：场上没有活怪 → false（超时也不报，那是正常收尾）',
        isWaveStalled({ waveMs: 400000, sinceKillMs: 400000, aliveCount: 0 }) === false
        && isWaveStalled({ waveMs: 90000, sinceKillMs: 20000, aliveCount: 0 }) === false, '');

    // 21.5 5 分钟硬上限：不看击杀间隔
    assert('僵局硬上限：单波 5 分钟 → true（刚杀过也算）',
        isWaveStalled({ waveMs: 300000, sinceKillMs: 0, aliveCount: 3 }) === true, '');

    // 21.6 用户截图那个局面：只剩 4 只、长期无进展
    assert('僵局：只剩 4 只 + 波次 100 秒 + 25 秒无击杀 → true（复现用户截图那一幕）',
        isWaveStalled({ waveMs: 100000, sinceKillMs: 25000, aliveCount: 4, total: 400 }) === true, '');

    // 21.7 第 1~30 波血量逐组等于 1.06^(n-1)（BOSS 再 ×8）：改斜率不许误伤前段
    const earlyBad = [];
    for (let n = 1; n <= 30; n += 1) {
        for (const g of generateEndlessWave(n, SEED).groups) {
            const want = Math.max(1, Math.round(
                ENEMY_TYPES[g.type].hp * Math.pow(1.06, n - 1) * (g.type === 'boss' ? 8 : 1)));
            if (g.hp !== want) earlyBad.push(`第${n}波 ${g.type} ${g.hp}≠${want}`);
        }
    }
    assert('第 1~30 波每组血量与「只按 1.06^(n-1)」逐组相等（LATE_HP_STEP 的改动没有误伤前段）',
        earlyBad.length === 0, earlyBad.slice(0, 4).join(' '));

    // 21.8 改动前后对照表（不是断言，供人工核对；旧值 1.025 在这里独立重算，不读被测常量）
    const OLD_STEP = 1.025;
    const baseHp = (g, n) => Math.max(1, Math.round(
        ENEMY_TYPES[g.type].hp * Math.pow(1.06, n - 1) * (g.type === 'boss' ? 8 : 1)));
    const hpSumOf = (w) => w.groups.reduce((s, g) => s + g.count * g.hp, 0);
    const sumNew = (n) => hpSumOf(generateEndlessWave(n, SEED));
    const sumOld = (n) => generateEndlessWave(n, SEED).groups.reduce((s, g) => s + g.count
        * Math.max(1, Math.round(baseHp(g, n) * (n > mod.LATE_HP_FROM ? Math.pow(OLD_STEP, n - mod.LATE_HP_FROM) : 1))), 0);
    const lateMulNew = (n) => (n > mod.LATE_HP_FROM ? Math.pow(LATE_HP_STEP, n - mod.LATE_HP_FROM) : 1);
    console.log('  LATE_HP_STEP：' + OLD_STEP + ' → ' + LATE_HP_STEP + '（参考 DPS ' + REF_DPS + '，清完秒 = 总血量 ÷ 参考 DPS）');
    console.log('    波次  lateHpMul  改动后总血量  清完秒  |  改动前总血量  清完秒');
    for (const n of [30, 50, 75, 90, 100]) {
        const sn = sumNew(n), so = sumOld(n);
        console.log(`    ${String(n).padStart(3)}   ×${lateMulNew(n).toFixed(3).padStart(6)}  ${String(sn).padStart(12)}`
            + `  ${String(Math.round(sn / REF_DPS)).padStart(6)}  |  ${String(so).padStart(12)}  ${String(Math.round(so / REF_DPS)).padStart(6)}`);
    }

    // 21.9 平衡护栏：第 90 波按参考 DPS 必须 240 秒内清完（阈值不许放宽 —— 若不满足只能继续降斜率）
    const sec90 = sumNew(90) / REF_DPS;
    assert(`平衡护栏：第 90 波按参考 DPS ${REF_DPS} 估算的清完秒数 < ${CLEAR_SEC_MAX} 秒（实际 ${Math.round(sec90)} 秒）`,
        sec90 < CLEAR_SEC_MAX, `第 90 波总血量 ${sumNew(90)} ÷ ${REF_DPS} = ${sec90.toFixed(1)} 秒`);

    // 21.10 pointAt 对坏输入必须给出有限坐标（塔多怪少时 dist 会来自推回 / 黑洞 / 坏存档）
    const path0 = mod.buildPath(MAP_TEMPLATES[0]);
    let pErr = null, pts = [];
    try { pts = [-1, 1e18, NaN, Infinity, -Infinity, undefined].map((d) => pointAt(path0, d)); }
    catch (err) { pErr = err; }
    assert('pointAt：-1 / 1e18 / NaN / ±Infinity / undefined 都返回有限坐标且不抛异常',
        pErr === null && pts.length === 6 && pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)),
        pErr ? String(pErr) : JSON.stringify(pts));

    // 21.11 isRunawayEnemy：NaN / Infinity / hp≤0 / dead 一律认出来（否则 `hp <= 0` 永远为 false → 打不死）
    const runaways = [{ hp: NaN }, { hp: Infinity }, { hp: -Infinity }, { hp: 0 }, { hp: 10, dead: true }];
    assert('isRunawayEnemy：hp = NaN / Infinity / 0 / dead:true → true；正常敌人 → false；null → false',
        runaways.every((e) => isRunawayEnemy(e) === true)
        && isRunawayEnemy({ hp: 120, dead: false }) === false
        && isRunawayEnemy(null) === false,
        runaways.map((e) => e.hp + ':' + isRunawayEnemy(e)).join(' '));

    // 21.12 塔数上限 + 满场压测（塔极多、怪极少时不炸）
    assert('MAX_TOWERS = 80 且计划类纯函数仍在（批量升级 / 快速升级只操作已有的塔，不受上限影响）',
        MAX_TOWERS === 80 && typeof mod.planBatchUpgrade === 'function' && typeof mod.nextUpgradeTarget === 'function',
        'MAX_TOWERS=' + MAX_TOWERS);
    const many = [];
    const kinds = ['arrow', 'cannon', 'frost', 'aura'];
    for (let i = 0; i < MAX_TOWERS; i += 1) {
        many.push({ type: kinds[i % 4], lv: 50, oc: i % 3 === 0, rateBuff: 0, dmgBuff: 0, col: i % 24, row: Math.floor(i / 24) });
    }
    let manyErr = null, manyPrev = null, manyDps = 0;
    try {
        manyPrev = nextWavePreview({ wave: 89, seed: SEED, mode: 'endless', level: null, towers: many });
        manyDps = towersDps(many);
    } catch (err) { manyErr = err; }
    assert(`${MAX_TOWERS} 座 Lv.50 塔（含超频）：nextWavePreview / towersDps 不抛异常且返回有限正数`,
        manyErr === null && Number.isFinite(manyDps) && manyDps > 0
        && !!manyPrev && Number.isFinite(manyPrev.myDps) && manyPrev.myDps > 0,
        manyErr ? String(manyErr) : 'dps=' + Math.round(manyDps));
    console.log('  ' + MAX_TOWERS + ' 座 Lv.50 塔合计 DPS ≈ ' + Math.round(manyDps)
        + '（参考 DPS 口径 ' + REF_DPS + ' 只相当于约 ' + Math.round(manyDps / REF_DPS) + ' 倍 —— 说明口径偏保守）');

    // 21.13 力场回推收敛（真因：血厚的怪被推回锁在起点 → 不漏怪、杀不死、波次永不结束）
    const { canPush, clampPushDist, pushStrength, PUSH_IMMUNE_MS, PUSH_BACK_FLOOR_PX } = mod;
    assert('canPush：被推回后 ' + PUSH_IMMUNE_MS + 'ms 免疫窗口内第二次推回不生效，过窗口/未推过的怪可推',
        canPush({ hp: 100, pushImmuneUntil: 0 }, 500) === true
        && canPush({ hp: 100, pushImmuneUntil: 2500 }, 1000) === false
        && canPush({ hp: 100, pushImmuneUntil: 2500 }, 2500) === true
        && canPush({ hp: 100, dead: true }, 9000) === false
        && canPush(null, 0) === false,
        'pushImmuneUntil 判定不按预期');
    assert('clampPushDist：dist 低于「最远点 − ' + PUSH_BACK_FLOOR_PX + 'px」时抬到该下限，且永不为负',
        clampPushDist(10, 500, PUSH_BACK_FLOOR_PX) === 500 - PUSH_BACK_FLOOR_PX
        && clampPushDist(450, 500, PUSH_BACK_FLOOR_PX) === 450
        && clampPushDist(-50, 100, PUSH_BACK_FLOOR_PX) === 4
        && clampPushDist(-50, 0, PUSH_BACK_FLOOR_PX) === 0
        && clampPushDist(NaN, 500, PUSH_BACK_FLOOR_PX) === 500 - PUSH_BACK_FLOOR_PX,
        '下限计算不按预期');
    const strengths = [0, 1, 2, 3, 40].map((n) => pushStrength(100, n));
    assert('pushStrength：随被推次数严格递减，且下限恒为 2px（100 → 75 → 56.25 → 42.19 … → 2）',
        strengths[0] === 100 && strengths[1] === 75 && strengths[2] === 56.25
        && strengths[1] < strengths[0] && strengths[2] < strengths[1] && strengths[3] < strengths[2]
        && strengths[4] === 2 && pushStrength(100, 999) === 2 && pushStrength(0.5, 0) === 2,
        strengths.join(' → '));
    // 收敛性：每帧前进 2px，每 2 秒（= 免疫窗口）才允许再吃一次满推回（400px）。
    // 有下限兜底 → 位置仍单调向终点推进，这就是「血再厚也不会被永久锁在起点、波次一定会结束」的保证。
    // 推回公式与模块里的 applyPush 同一条（max(0, dist - px)），这里独立重写一份便于断言。
    const pushAfter = (cur, px) => Math.max(0, cur - px);
    let d = 0, top = 0, pushed = 0;
    for (let i = 0; i < 4000; i += 1) {
        d += 2;                                  // 前进 2px/帧（≈120px/s 的怪在 60fps 下）
        if (d > top) top = d;
        if (i % 120 === 0) {                     // 每 2000ms 才允许推一次
            pushed += 1;
            d = clampPushDist(pushAfter(d, pushStrength(400, 0)), top, PUSH_BACK_FLOOR_PX);
        }
    }
    assert('回推收敛：每帧前进 2px + 每 2 秒吃一次 400px 满推回，4000 帧后仍向终点推进了 > 1000px（不会被锁死）',
        top > 1000 && d >= 0 && pushed >= 33, '峰值 dist=' + top.toFixed(0) + ' 末 dist=' + d.toFixed(0)
        + ' 推回次数=' + pushed);

    // 21.14 BOSS 信息栏的数据口径（血条 / 数值 / 护甲 / 速度全由 bossRows 现算，UI 不另算一份）
    const { bossRows } = mod;
    assert('bossRows：空数组 / null / 只有非 BOSS 敌人 → []（BOSS 栏整块 hidden 的依据）',
        bossRows([]).length === 0 && bossRows(null).length === 0
        && bossRows([{ type: 'basic', hp: 10, maxHp: 10 }]).length === 0, '');
    const b2 = bossRows([
        { type: 'boss', hp: 50, maxHp: 200, armor: 0.35, speed: 70 },
        { type: 'boss', hp: 999, maxHp: 100, armor: 0.35, speed: 70 },
        { type: 'boss', hp: 10, maxHp: 10, dead: true },
        { type: 'basic', hp: 10, maxHp: 10 },
    ]);
    assert('bossRows：2 只活 BOSS（已死的那只被过滤）→ 2 条，pct = 0.25 与夹到 1，护甲/速度原样带出',
        b2.length === 2 && b2[0].pct === 0.25 && b2[0].hp === 50 && b2[0].maxHp === 200
        && b2[0].armor === 0.35 && b2[0].speed === 70 && b2[1].pct === 1, JSON.stringify(b2));
    const b3 = bossRows([
        { type: 'boss', hp: -20, maxHp: 100 }, { type: 'boss', hp: 5, maxHp: 0 }, { type: 'boss' },
    ]);
    assert('bossRows 容错：hp 为负 → 0；maxHp = 0 / 缺失 → pct 记 0 且不抛异常',
        b3.length === 3 && b3[0].hp === 0 && b3[0].pct === 0 && b3[1].pct === 0 && b3[2].pct === 0,
        JSON.stringify(b3));
    console.log('  bossRows 实测：' + JSON.stringify(b2) + ' / 容错组 ' + JSON.stringify(b3));
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
