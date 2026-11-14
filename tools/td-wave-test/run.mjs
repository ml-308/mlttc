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
    assert('3 座塔（Lv.1/Lv.2/Lv.1）→ index 0（按建造顺序的第一个未满级，不是最便宜/等级最低）',
        first && first.index === 0 && first.tower === three[0] && first.type === 'arrow'
        && first.lv === 1 && first.nextLv === 2,
        first ? `index=${first.index} type=${first.type} lv=${first.lv}` : 'null');

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
