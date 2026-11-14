// tools/td-skills-test/run.mjs
// 塔防「技能」与「特殊塔」两个纯数据/纯函数模块的无依赖自检
// （零依赖、不联网、不写临时文件、不改任何被测文件）。
//
// 用法：node tools/td-skills-test/run.mjs
//   任一被测模块未就绪（文件不存在 / 导入失败 / 缺少导出）→ 打印「等待模块」提示，退出码 2
//     （已就绪的那一半仍会跑完并打印结果，方便并行开发时看到进展，但整体退出码仍是 2）
//   两个模块都就绪且断言全过 → PASS n/n，退出码 0
//   两个模块都就绪但断言失败 → FAIL n/m + 首个失败详情，退出码 1
//
// 退出码 2 的意义：并行开发期间模块可能只写了一半，把它报成「断言失败」是假信号。
// 只有「模块已就绪但行为不符合约定」才算 FAIL(1)，「模块还没就绪」只是 WAITING(2)。
//
// 为什么用 data: URL 导入：仓库根 package.json 是 "type":"commonjs"，而 src/pages/*.js 是 ESM。
// 直接 import 那个 .js 会按 CJS 解析并语法报错；这里 readFileSync 读源码后用
// `data:text/javascript;base64,` 导入，等价于「把源码当 ESM 模块执行」，测的就是真实源码
// （与 tools/td-wave-test/run.mjs 同一做法）。

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

const ok = (name, cond, detail) => record(name, !!cond, detail);                    // 布尔
const eq = (name, actual, expected) => record(name, actual === expected,
    `期望 ${show(expected)}，实际 ${show(actual)}`);                                  // 严格相等
const deepEq = (name, actual, expected) => record(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${show(expected)}，实际 ${show(actual)}`);                                  // 深比较

function near(name, actual, expected, tol = 1e-6) {                                  // 浮点近似
    record(name, typeof actual === 'number' && Math.abs(actual - expected) <= tol,
        `期望 ${show(expected)}（±${tol}），实际 ${show(actual)}`);
}

function within(name, actual, lo, hi) {                                             // 闭区间
    record(name, typeof actual === 'number' && actual >= lo && actual <= hi,
        `期望落在 [${lo}, ${hi}]，实际 ${show(actual)}`);
}

const section = (title) => console.log(`\n[${title}]`);

// ─── 被测模块加载（未就绪 → 退出码 2） ───────────────────────

const SKILLS_EXPORTS = ['SKILLS', 'CHILL', 'METEOR', 'REPAIR', 'TIMESTOP', 'OVERLOAD',
    'getSkill', 'skillsUnlockedAt', 'canCast', 'cooldownLeft', 'meteorHits', 'purgeHits',
    'applyChillTo', 'tickStatus'];
const TOWERS_EXPORTS = ['SPECIAL_TOWER_TYPES', 'SPECIAL_TOWER_IDS', 'isSpecialTower',
    'specialTowersUnlockedAt', 'towerUnlockWave', 'totalInvested', 'chainDamage',
    'pickChainTargets', 'poisonDps', 'poisonTick', 'pushDistance', 'applyPush'];

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

/** 把「字符串 / 对象」两种返回形态统一成 id 数组 */
const idsOf = (list) => (Array.isArray(list)
    ? list.map((it) => (typeof it === 'string' ? it : String(it && (it.id ?? it.key ?? it.type ?? ''))))
    : []);

/** 无视顺序比较 id 集合 */
function sameSet(name, actualList, expectedIds) {
    const a = idsOf(actualList).slice().sort();
    record(name, JSON.stringify(a) === JSON.stringify(expectedIds.slice().sort()),
        `期望 ${show(expectedIds.slice().sort())}，实际 ${show(a)}`);
}

// 状态剩余时长的字段探测：被测模块用哪个字段名不在本脚本约定内，这里按常见命名逐个找，
// 找不到就把失败原因写成「未找到剩余时长字段」，便于集成时对齐。
const REMAIN_PATHS = [['status', 'remainingMs'], ['status', 'ms'], ['status', 'left'],
    ['status', 'remaining'], ['statusMs'], ['slowMs'], ['chillMs'], ['effectMs'], ['remainingMs']];
const UNTIL_PATHS = [['status', 'until'], ['slowUntil'], ['statusUntil'], ['until']];

function dig(obj, keys) {
    let cur = obj;
    for (const k of keys) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[k];
    }
    return cur;
}

function statusRemaining(enemy, now = 0) {
    for (const p of REMAIN_PATHS) {
        const v = dig(enemy, p);
        if (typeof v === 'number') return { value: v, field: p.join('.') };
    }
    for (const p of UNTIL_PATHS) {
        const v = dig(enemy, p);
        if (typeof v === 'number') return { value: v - now, field: `${p.join('.')} - now` };
    }
    return { value: NaN, field: '（未找到剩余时长字段）' };
}

// ═══ 技能模块 src/pages/td-skills.js ════════════════════════

function runSkillSections(mod) {
    const { SKILLS, CHILL, METEOR, REPAIR, TIMESTOP, OVERLOAD, getSkill, skillsUnlockedAt,
        canCast, cooldownLeft, meteorHits, purgeHits, applyChillTo, tickStatus } = mod;

    section('1. SKILLS 数据形状（6 条 / id 唯一 / 解锁波次严格递增 / 数值为正）');
    ok('SKILLS 是长度 6 的数组', Array.isArray(SKILLS) && SKILLS.length === 6, `实际长度 ${show(SKILLS && SKILLS.length)}`);
    const ids = Array.isArray(SKILLS) ? SKILLS.map((s) => s && s.id) : [];
    const waves = Array.isArray(SKILLS) ? SKILLS.map((s) => s && s.unlockWave) : [];
    eq('6 个 id 互不重复', new Set(ids).size, ids.length);
    deepEq('id 都是非空字符串', ids.filter((x) => typeof x !== 'string' || x.length === 0), []);
    deepEq('unlockWave 序列 = [4, 8, 14, 22, 32, 45]', waves, [4, 8, 14, 22, 32, 45]);
    deepEq('unlockWave 严格递增', waves.every((w, i) => i === 0 || w > waves[i - 1]), true);
    const badNum = (Array.isArray(SKILLS) ? SKILLS : []).filter((s) => !s
        || typeof s.name !== 'string' || s.name.length === 0
        || typeof s.desc !== 'string' || s.desc.length === 0
        || typeof s.cost !== 'number' || s.cost <= 0
        || typeof s.cooldownMs !== 'number' || s.cooldownMs <= 0).map((s) => s && s.id);
    deepEq('每条都有 name/desc，cost 与 cooldownMs 均为正数', badNum, []);
    const badConsts = Object.entries({ CHILL, METEOR, REPAIR, TIMESTOP, OVERLOAD })
        .filter(([, v]) => !v || typeof v !== 'object' || Object.keys(v).length === 0).map(([k]) => k);
    deepEq('CHILL/METEOR/REPAIR/TIMESTOP/OVERLOAD 五个参数常量都是非空对象', badConsts, []);
    eq(`getSkill('${ids[0]}') 返回同一份定义`, getSkill(ids[0]) && getSkill(ids[0]).id, ids[0]);
    const unknown = getSkill('__no_such_skill__');
    ok('getSkill(未知 id) 返回 null/undefined', unknown === null || unknown === undefined, `实际 ${show(unknown)}`);
    console.log(`  技能表：${(Array.isArray(SKILLS) ? SKILLS : [])
        .map((s) => `${s && s.id}@${s && s.unlockWave}(${s && s.cost}g/${s && s.cooldownMs}ms)`).join(' ')}`);

    section('2. skillsUnlockedAt 分阶段解锁');
    deepEq('skillsUnlockedAt(1) 为空', idsOf(skillsUnlockedAt(1)), []);
    deepEq('skillsUnlockedAt(3) 仍为空（chill 要 4 波）', idsOf(skillsUnlockedAt(3)), []);
    const at4 = idsOf(skillsUnlockedAt(4));
    ok('skillsUnlockedAt(4) 含 chill', at4.includes('chill'), `实际 ${show(at4)}`);
    sameSet('skillsUnlockedAt(45) 含全部 6 个技能', skillsUnlockedAt(45), ids);

    section('3. canCast 四种情形（locked / cooldown / gold / ok）');
    const first = SKILLS[0], last = SKILLS[SKILLS.length - 1], now = 1000;
    const locked = canCast(last, { wave: 1, gold: 999999, readyAt: 0, now });
    ok('未解锁 → ok:false 且 reason=locked', locked?.ok === false && locked.reason === 'locked', `实际 ${show(locked)}`);
    const cooling = canCast(first, { wave: 99, gold: 999999, readyAt: now + 500, now });
    ok('冷却中 → ok:false 且 reason=cooldown', cooling?.ok === false && cooling.reason === 'cooldown', `实际 ${show(cooling)}`);
    const poor = canCast(first, { wave: 99, gold: first.cost - 1, readyAt: 0, now });
    ok('金币不足 → ok:false 且 reason=gold', poor?.ok === false && poor.reason === 'gold', `实际 ${show(poor)}`);
    const good = canCast(first, { wave: 99, gold: first.cost, readyAt: 0, now });
    ok('解锁+不在冷却+金币刚好够（gold===cost）→ ok:true', good?.ok === true, `实际 ${show(good)}`);

    section('4. cooldownLeft（未来为正且等于差值，过去为 0）');
    near('readyAt 在未来 → 返回差值（1500-1000=500）', cooldownLeft(first, 1500, 1000), 500);
    ok('readyAt 在未来 → 返回正数', cooldownLeft(first, 1500, 1000) > 0, `实际 ${show(cooldownLeft(first, 1500, 1000))}`);
    eq('readyAt 已过去 → 返回 0', cooldownLeft(first, 500, 1000), 0);
    eq('readyAt 恰等于 now → 返回 0', cooldownLeft(first, 1000, 1000), 0);

    section('5. meteorHits 半径筛选（含距离恰等于 radius 的边界）');
    const mos = [
        { id: 'a', x: 100, y: 100 },   // 圆心，距 0
        { id: 'b', x: 140, y: 100 },   // 距 40
        { id: 'c', x: 100, y: 140 },   // 距 40
        { id: 'd', x: 141, y: 100 },   // 距 41，仅比 b 远 1px
        { id: 'e', x: 200, y: 100 },   // 距 100，半径外
        { id: 'f', x: 140, y: 70 },    // 距 50 —— 恰等于 radius
    ];
    const hits = idsOf(meteorHits(mos, 100, 100, 50));
    deepEq('半径 50 内（a,b,c,d,f）全中、半径外的 e 不中', hits.slice().sort(), ['a', 'b', 'c', 'd', 'f']);
    ok('半径外（距 100）的 e 未被选中', !hits.includes('e'), `实际 ${show(hits)}`);
    ok('距离恰等于 radius(50) 仍被选中（边界取 <=）',
        idsOf(meteorHits([{ id: 'edge', x: 150, y: 100 }], 100, 100, 50)).includes('edge'), '边界项未命中');
    ok('距离 50.5（刚出界）不被选中',
        !idsOf(meteorHits([{ id: 'out', x: 150.5, y: 100 }], 100, 100, 50)).includes('out'), '出界项被误选');

    section('6. purgeHits 排除 BOSS，其余全选中');
    const purgeSrc = [{ id: 'n1', type: 'normal' }, { id: 'boss1', type: 'boss' }, { id: 'n2', type: 'fast' },
        { id: 'boss2', type: 'boss' }, { id: 'n3', type: 'tank' }];
    const purged = idsOf(purgeHits(purgeSrc));
    deepEq('BOSS 被排除，非 BOSS 全中', purged.slice().sort(), ['n1', 'n2', 'n3']);
    ok('结果里不含任何 type==="boss"', !purged.includes('boss1') && !purged.includes('boss2'), `实际 ${show(purged)}`);
    deepEq('全是 BOSS 时返回空', idsOf(purgeHits([{ id: 'b', type: 'boss' }])), []);

    section('7. applyChillTo 取更强、不叠乘');
    // 种子里带上 slowUntil（绝对到期时刻 > now），这样「已生效 0.6」在任何实现下都成立
    const s1 = { id: 's1', slow: 0.6, slowFactor: 0.6, slowUntil: 5000 };
    applyChillTo([s1], 1000, 0.5, 1000);
    near('已 slow=0.6 时施加 0.5 → 仍为 0.6（叠乘会变 0.3）', s1.slow, 0.6);
    applyChillTo([s1], 1000, 0.7, 1000);
    near('再施加 0.7 → 变为 0.7（更强的一方生效）', s1.slow, 0.7);
    const s2 = { id: 's2', slow: 0 };
    applyChillTo([s2], 1000, 0.5, 1000);
    near('初始无减速时施加 0.5 → 变为 0.5', s2.slow, 0.5);

    section('8. tickStatus 递减并在到期后结束');
    const st = { id: 't1', slow: 0 };
    applyChillTo([st], 0, 0.5, 1000);                       // now=0、持续 1000ms → 剩余 1000ms
    const r0 = statusRemaining(st, 0);
    near(`施加后剩余 1000ms（读取字段 ${r0.field}）`, r0.value, 1000);
    tickStatus(st, 300);
    const r1 = statusRemaining(st, 0);
    near(`tick 300ms 后剩余 700ms（读取字段 ${r1.field}）`, r1.value, 700);
    ok('tick 300ms 后仍处于减速状态（slow>0）', typeof st.slow === 'number' && st.slow > 0, `slow=${show(st.slow)}`);
    tickStatus(st, 800);                                    // 700-800 → 到期
    const r2 = statusRemaining(st, 0);
    ok('再 tick 800ms 后状态结束（剩余 <= 0）', !(r2.value > 0),
        `剩余 ${show(r2.value)}（字段 ${r2.field}），slow=${show(st.slow)}`);
}

// ═══ 特殊塔模块 src/pages/td-special-towers.js ══════════════

function runTowerSections(mod) {
    const { SPECIAL_TOWER_TYPES, SPECIAL_TOWER_IDS, isSpecialTower, specialTowersUnlockedAt,
        towerUnlockWave, totalInvested, chainDamage, pickChainTargets, poisonDps, poisonTick,
        pushDistance, applyPush } = mod;

    section('9. SPECIAL_TOWER_TYPES 数据形状（三座 / 三档 / 造价与累计投入）');
    const entries = Object.entries(SPECIAL_TOWER_TYPES || {});
    eq('恰好 3 座特殊塔', entries.length, 3);
    const shapeBad = [];
    for (const [id, d] of entries) {
        if (!d || d.special !== true) shapeBad.push(`${id}:special`);
        for (const k of ['cost', 'dmg', 'rate', 'range']) {
            if (!Array.isArray(d && d[k]) || d[k].length !== 3) shapeBad.push(`${id}:${k}`);
        }
        if (!d || !(Array.isArray(d.cost) && d.cost[0] > 400)) shapeBad.push(`${id}:建价<=400`);
        if (typeof d?.unlockWave !== 'number') shapeBad.push(`${id}:unlockWave`);
    }
    deepEq('每座 special===true、cost/dmg/rate/range 均三档、建造价 > 400', shapeBad, []);
    const towerWaves = entries.map(([, d]) => d && d.unlockWave);
    deepEq('解锁波次 = tesla:18 / poison:28 / force:40',
        [SPECIAL_TOWER_TYPES?.tesla?.unlockWave, SPECIAL_TOWER_TYPES?.poison?.unlockWave,
            SPECIAL_TOWER_TYPES?.force?.unlockWave], [18, 28, 40]);
    const investBad = [];
    for (const [id, d] of entries) {
        const [l1, l2, l3] = [totalInvested(id, 1), totalInvested(id, 2), totalInvested(id, 3)];
        if (l1 !== d.cost[0]) investBad.push(`${id} L1 ${l1}!=${d.cost[0]}`);
        if (l2 !== d.cost[0] + d.cost[1]) investBad.push(`${id} L2 ${l2}!=${d.cost[0] + d.cost[1]}`);
        if (l3 !== d.cost[0] + d.cost[1] + d.cost[2]) investBad.push(`${id} L3 ${l3}!=sum`);
    }
    deepEq('totalInvested(id, lvl) 是 1 基累计价（L1/L2/L3 = cost 前缀和）', investBad, []);
    for (const [id] of entries) within(`${id} L3 累计投入落在 1600~2700`, totalInvested(id, 3), 1600, 2700);
    console.log(`  特殊塔：${entries.map(([id, d]) => `${id}@${d.unlockWave}(${d.cost.join('/')})`).join(' ')}`);

    section('10. SPECIAL_TOWER_IDS 与 TYPES 键一致；isSpecialTower');
    deepEq('SPECIAL_TOWER_IDS 顺序 = [tesla, poison, force]', SPECIAL_TOWER_IDS, ['tesla', 'poison', 'force']);
    deepEq('SPECIAL_TOWER_TYPES 键顺序与之相同', Object.keys(SPECIAL_TOWER_TYPES || {}), ['tesla', 'poison', 'force']);
    eq('isSpecialTower(force) 为 true', isSpecialTower('force'), true);
    eq('isSpecialTower(arrow) 为 false', isSpecialTower('arrow'), false);
    eq('isSpecialTower(未知) 为 false', isSpecialTower('__nope__'), false);

    section('11. specialTowersUnlockedAt 分阶段解锁');
    deepEq('specialTowersUnlockedAt(17) 为空', idsOf(specialTowersUnlockedAt(17)), []);
    sameSet('specialTowersUnlockedAt(18) 只有 tesla', specialTowersUnlockedAt(18), ['tesla']);
    sameSet('specialTowersUnlockedAt(28) 含 tesla + poison', specialTowersUnlockedAt(28), ['tesla', 'poison']);
    sameSet('specialTowersUnlockedAt(40) 含全部 3 座', specialTowersUnlockedAt(40), ['tesla', 'poison', 'force']);

    section('12. towerUnlockWave（已知返回波次，未知返回 0）');
    eq('towerUnlockWave(tesla) = 18', towerUnlockWave('tesla'), 18);
    eq('towerUnlockWave(poison) = 28', towerUnlockWave('poison'), 28);
    eq('towerUnlockWave(force) = 40', towerUnlockWave('force'), 40);
    eq('towerUnlockWave(未知 id) = 0', towerUnlockWave('__nope__'), 0);

    section('13. chainDamage 逐跳衰减（单调递减，末跳仍 >= 1）');
    near('第 1 跳 = 基础伤害（34,1,0.2）= 34', chainDamage(34, 1, 0.2), 34);
    near('第 2 跳约 27（34×0.8）', chainDamage(34, 2, 0.2), 27.2, 1);
    near('第 3 跳约 22（34×0.64）', chainDamage(34, 3, 0.2), 21.76, 1);
    const seq = Array.from({ length: 12 }, (_, i) => chainDamage(34, i + 1, 0.2));
    deepEq('同一 falloff 下逐跳单调不增', seq.every((v, i) => i === 0 || v <= seq[i - 1]), true);
    ok('衰减序列确实在下降（第 12 跳 < 第 1 跳）', seq[11] < seq[0], `第 1 跳 ${seq[0]}，第 12 跳 ${seq[11]}`);
    ok('所有跳数结果都 >= 1', seq.every((v) => v >= 1), `实际 ${show(seq)}`);
    ok('极端参数下末跳仍 >= 1（chainDamage(34,60,0.1)）', chainDamage(34, 60, 0.1) >= 1,
        `实际 ${show(chainDamage(34, 60, 0.1))}`);
    console.log(`  衰减序列：${seq.map((v) => v.toFixed(2)).join(' → ')}`);

    section('14. pickChainTargets（按 dist 降序 / 数量上限 / range 与 excludeIds）');
    const origin = { x: 0, y: 0 };
    const chainSrc = [
        { id: 'p1', x: 100, y: 0, dist: 100 }, { id: 'p2', x: 200, y: 0, dist: 200 },
        { id: 'p3', x: 300, y: 0, dist: 300 }, { id: 'p4', x: 400, y: 0, dist: 400 },
        { id: 'p5', x: 1200, y: 0, dist: 500 },              // 超出 range=1000
    ];
    const picked = pickChainTargets(chainSrc, origin, 3, 1000, []);
    const got = idsOf(picked);
    ok('返回数量 <= count(3)', got.length <= 3, `实际 ${show(got)}`);
    eq('返回数量 = 3（范围内候选足够）', got.length, 3);
    deepEq('按 dist 从大到小取前 3 个（p4,p3,p2）', got, ['p4', 'p3', 'p2']);
    ok('range 外的 p5 被排除', !got.includes('p5'), `实际 ${show(got)}`);
    const dists = (Array.isArray(picked) ? picked : []).map((e) => e && e.dist);
    deepEq('结果按 dist 严格降序', dists.every((v, i) => i === 0 || v < dists[i - 1]), true);
    deepEq('excludeIds=[p4] 生效，顺延取 p3,p2,p1',
        idsOf(pickChainTargets(chainSrc, origin, 3, 1000, ['p4'])), ['p3', 'p2', 'p1']);
    deepEq('excludeIds 全排除时返回空',
        idsOf(pickChainTargets(chainSrc, origin, 3, 1000, ['p1', 'p2', 'p3', 'p4', 'p5'])), []);

    section('15. poisonDps 按等级取值');
    near('poison L1 = 18', poisonDps('poison', 1), 18);
    near('poison L2 = 28', poisonDps('poison', 2), 28);
    near('poison L3 = 40', poisonDps('poison', 3), 40);
    eq('tesla 没有毒伤 → 0', poisonDps('tesla', 1), 0);
    eq('force 没有毒伤 → 0', poisonDps('force', 2), 0);

    section('16. poisonTick 只结算剩余有效时间');
    near('(3000,18,1000) = 18（整跳）', poisonTick(3000, 18, 1000), 18);
    near('(500,18,1000) = 9（只结算剩余 500ms）', poisonTick(500, 18, 1000), 9);
    near('(1000,40,1000) = 40', poisonTick(1000, 40, 1000), 40);
    near('(0,18,1000) = 0（已到期不再扣血）', poisonTick(0, 18, 1000), 0);

    section('17. pushDistance / applyPush（击退距离与不为负）');
    near('force L1 = 32（1 格）', pushDistance('force', 1, false), 32);
    near('force L2 = 35.2（1.1 格）', pushDistance('force', 2, false), 35.2);
    near('force L3 = 38.4（1.2 格）', pushDistance('force', 3, false), 38.4);
    const pushSeq = [1, 2, 3].map((lvl) => pushDistance('force', lvl, false));
    deepEq('force 击退距离随等级严格递增', pushSeq.every((v, i) => i === 0 || v > pushSeq[i - 1]), true);
    near('BOSS 击退减半（32 → 16）', pushDistance('force', 1, true), pushDistance('force', 1, false) / 2);
    ok('BOSS 击退严格小于普通敌人', pushDistance('force', 3, true) < pushDistance('force', 3, false),
        `BOSS ${show(pushDistance('force', 3, true))}，普通 ${show(pushDistance('force', 3, false))}`);
    eq('applyPush(10, 38) 不为负 → 0', applyPush(10, 38), 0);
    eq('applyPush(10.4, 38) 仍落在 0', applyPush(10.4, 38), 0);
    near('applyPush(50, 38) = 12（正常后退）', applyPush(50, 38), 12);
    ok('击退后棋盘距恒 >= 0', [0, 1, 5, 10, 37.9].every((d) => applyPush(d, 38) >= 0), '有小值算出负数');
}

// ═══ 跨模块 ═════════════════════════════════════════════════

function runCrossSections(skillsMod, towersMod) {
    section('18. 跨模块一致性：技能 + 特殊塔合并后覆盖多个解锁档位');
    const skillWaves = skillsMod.SKILLS.map((s) => s && s.unlockWave);
    const towerWaves = Object.values(towersMod.SPECIAL_TOWER_TYPES || {}).map((d) => d && d.unlockWave);
    const union = Array.from(new Set([...skillWaves, ...towerWaves])).sort((a, b) => a - b);
    ok('合并后覆盖 >= 4 个不同 unlockWave 档位', union.length >= 4, `共 ${union.length} 档：${show(union)}`);
    ok('特殊塔解锁波次都落在技能区间内（4~45）', towerWaves.every((w) => w >= 4 && w <= 45),
        `实际 ${show(towerWaves)}`);
    console.log(`  合并解锁节奏：${union.join(' / ')}`);
}

// ─── 调度：能跑的先跑，缺失的收尾时报退出码 2 ───────────────

const skillsLoad = await loadModule('td-skills.js', SKILLS_EXPORTS);
const towersLoad = await loadModule('td-special-towers.js', TOWERS_EXPORTS);
const pending = [];

if (skillsLoad.state === 'ready') runSkillSections(skillsLoad.mod);
else pending.push(['td-skills.js', skillsLoad]);

if (towersLoad.state === 'ready') runTowerSections(towersLoad.mod);
else pending.push(['td-special-towers.js', towersLoad]);

if (pending.length === 0) runCrossSections(skillsLoad.mod, towersLoad.mod);

if (pending.length > 0) {
    console.log('\n[等待模块] 以下被测模块尚未就绪，对应断言被跳过（这不是失败）：');
    for (const [file, r] of pending) console.log(`  ..   src/pages/${file} — ${r.reason}`);
    if (passed + failures.length > 0) console.log(`  已就绪的部分：${passed} 条通过、${failures.length} 条失败（见上方）`);
    console.log('等模块写完后再跑一次：node tools/td-skills-test/run.mjs');
    console.log(`WAITING 退出码 2（${pending.length} 个模块未就绪）`);
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
