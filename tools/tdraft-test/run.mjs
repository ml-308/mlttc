// tools/tdraft-test/run.mjs
// 时刻表草稿模块（src/pages/timetable-draft.js）的零依赖自检
// （不联网、不写临时文件、不改被测文件）。
//
// 用法：node tools/tdraft-test/run.mjs
//   断言全过 → PASS n/n，退出码 0；有失败 → FAIL n/m + 首个失败详情，退出码 1
//
// 为什么用 data: URL 导入：仓库根 package.json 是 "type":"commonjs"，而 src/pages/*.js 是 ESM，
// 直接 import 会按 CJS 解析；这里读源码后用 `data:text/javascript;base64,` 导入，
// 测的就是真实源码（与 tools/td-skills-test/run.mjs 同一做法）。
//
// 两个环境的先后顺序很关键：
//   1. 先在没有 window / localStorage 的纯 Node 环境里断言「不抛异常、降级为失败」；
//   2. 再注入假的 window / document / localStorage，断言真实读写、过期清理、去抖与 pagehide 落盘。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const TARGET = path.join(root, 'src', 'pages', 'timetable-draft.js');

// ─── 微型断言框架 ────────────────────────────────────────────

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言某段代码不抛异常（返回 'ok' 或异常信息） */
function noThrow(fn) {
    try {
        fn();
        return 'ok';
    } catch (e) {
        return `抛出异常：${e && e.message}`;
    }
}

// ─── 假环境（第二段才装上） ─────────────────────────────────

function makeStorage() {
    const map = new Map();
    return {
        map,
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
    };
}

function makeEventTarget(extra = {}) {
    const handlers = new Map();
    return {
        ...extra,
        handlers,
        addEventListener(type, fn) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            if (handlers.has(type)) handlers.get(type).delete(fn);
        },
        dispatch(type) {
            const set = handlers.get(type);
            if (set) for (const fn of [...set]) fn({ type });
        },
        count(type) {
            const set = handlers.get(type);
            return set ? set.size : 0;
        },
    };
}

// ─── 加载被测模块 ───────────────────────────────────────────

const REQUIRED_EXPORTS = ['DRAFT_PREFIX', 'UNATTENDED_KEY', 'draftKey', 'serializeDraft', 'parseDraft',
    'isUnattended', 'setUnattended', 'saveDraft', 'loadDraft', 'clearDraft', 'bindAutoSave',
    'SNAPSHOT_KEY_PREFIX', 'MAX_SNAPSHOTS', 'SNAPSHOT_MAX_CHARS',
    'listSnapshots', 'saveSnapshot', 'deleteSnapshot', 'getSnapshot'];

if (!existsSync(TARGET)) {
    console.log('[等待模块] src/pages/timetable-draft.js 不存在');
    console.log('WAITING 退出码 2');
    process.exit(2);
}

let mod;
try {
    const source = readFileSync(TARGET, 'utf8');
    mod = await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
} catch (e) {
    console.log(`[模块无法导入] ${e && e.message}`);
    console.log('WAITING 退出码 2');
    process.exit(2);
}

const lacking = REQUIRED_EXPORTS.filter((n) => mod[n] === undefined);
deepEq('导出清单完整（18 个必需导出）', lacking, []);
if (lacking.length > 0) {
    console.log(`\nFAIL 导出缺失：${lacking.join(', ')}`);
    process.exit(1);
}

const {
    DRAFT_PREFIX, UNATTENDED_KEY, draftKey, serializeDraft, parseDraft,
    isUnattended, setUnattended, saveDraft, loadDraft, clearDraft, bindAutoSave,
    describeDraftAge, formatClock, isSensitiveField,
    SNAPSHOT_KEY_PREFIX, MAX_SNAPSHOTS, SNAPSHOT_MAX_CHARS,
    listSnapshots, saveSnapshot, deleteSnapshot, getSnapshot,
} = mod;

const DAY = 24 * 60 * 60 * 1000;

// ═══ 第 1 段：纯函数（无环境依赖） ═══════════════════════════

section('1. draftKey：新建 / 修改两份键，互不相同');
eq("draftKey('create') = 'mlttc-tdraft:create'", draftKey('create'), 'mlttc-tdraft:create');
eq("draftKey('edit', 42) = 'mlttc-tdraft:edit:42'", draftKey('edit', 42), 'mlttc-tdraft:edit:42');
ok('create 与 edit 的键不同', draftKey('create') !== draftKey('edit', 42),
    `实际 ${show(draftKey('create'))} / ${show(draftKey('edit', 42))}`);
eq("DRAFT_PREFIX = 'mlttc-tdraft:'", DRAFT_PREFIX, 'mlttc-tdraft:');
eq("UNATTENDED_KEY = 'mlttc-tdraft:unattended'", UNATTENDED_KEY, 'mlttc-tdraft:unattended');
ok('两份键都以 DRAFT_PREFIX 开头', draftKey('create').startsWith(DRAFT_PREFIX) && draftKey('edit', 42).startsWith(DRAFT_PREFIX));
eq("draftKey('edit') 缺 id 时退化成 'mlttc-tdraft:edit'（不出现 undefined）", draftKey('edit'), 'mlttc-tdraft:edit');

section('2. parseDraft：坏数据 / 缺字段一律 null，且不抛异常');
const now = 1_700_000_000_000;
const badCases = ['', '   ', 'not json', '{', 'null', '123', '"str"', '[]', '{}',
    '{"savedAt":1}', '{"fields":{}}', '{"savedAt":"x","fields":{}}', '{"savedAt":1,"fields":[]}',
    '{"savedAt":1,"fields":"s"}'];
deepEq('15 种坏输入全部返回 null', badCases.map((raw) => parseDraft(raw, now)), badCases.map(() => null));
deepEq('非字符串输入（null / undefined / 数字 / 对象）也返回 null',
    [parseDraft(null, now), parseDraft(undefined, now), parseDraft(42, now), parseDraft({}, now)],
    [null, null, null, null]);
eq('整个过程未抛异常', noThrow(() => badCases.forEach((raw) => parseDraft(raw, now))), 'ok');

section('3. parseDraft：合法草稿返回 savedAt 与 fields');
const goodRaw = JSON.stringify({ savedAt: now - 60_000, fields: { city: '无锡', way: '52路' } });
const good = parseDraft(goodRaw, now);
eq('savedAt 原样返回', good && good.savedAt, now - 60_000);
deepEq('fields 原样返回', good && good.fields, { city: '无锡', way: '52路' });
eq('后续时刻（仍在有效期内）可解析', parseDraft(goodRaw, now + 60_000) !== null, true);

section('4. 敏感字段被过滤（password / authToken / api_token 的值不落盘）');
const SECRETS = ['p@ssw0rd!', 'tk-9f8e7d', 'abc-123-xyz'];
const withSecrets = {
    city: '无锡市', way: '52路',
    password: SECRETS[0], authToken: SECRETS[1], api_token: SECRETS[2],
    note: '正常字段应保留',
};
const secretRaw = serializeDraft(withSecrets, now);
deepEq('三个敏感值都没出现在序列化结果里', SECRETS.filter((s) => secretRaw.includes(s)), []);
deepEq('三个敏感键名都没出现在序列化结果里',
    ['password', 'authToken', 'api_token'].filter((k) => secretRaw.includes(k)), []);
const secretParsed = parseDraft(secretRaw, now);
deepEq('解析后只剩非敏感字段', secretParsed && Object.keys(secretParsed.fields), ['city', 'way', 'note']);
eq("'authToken' 被判为敏感", isSensitiveField('authToken'), true);
eq("'api_token' 被判为敏感", isSensitiveField('api_token'), true);
eq("'X-CSRF-Token' 被判为敏感", isSensitiveField('X-CSRF-Token'), true);
eq("'password' 被判为敏感", isSensitiveField('password'), true);
eq("'city' 不被判为敏感", isSensitiveField('city'), false);
eq("'tokenless'（名字里没有独立 token）仍会被包含匹配拦下", isSensitiveField('tokenless'), true);

section('5. serializeDraft → parseDraft 往返一致');
const roundTrip = { city: '江苏省 无锡市', way: '快速直达专线1路', start: '火车站', end: '机场',
    time1: '06:00 06:30 07:00', time2: '07:10 07:40', bc: '工作日', execTime: '2025.1.1' };
const rt = parseDraft(serializeDraft(roundTrip, now), now);
deepEq('普通字段往返完全一致', rt && rt.fields, roundTrip);
eq('往返后 savedAt 等于传入的 nowMs', rt && rt.savedAt, now);
eq('serializeDraft 产出的确实是 JSON 串', typeof serializeDraft(roundTrip, now), 'string');

section('6. 空字段对象也能安全往返');
const emptyRt = parseDraft(serializeDraft({}, now), now);
deepEq('fields 为空对象', emptyRt && emptyRt.fields, {});
eq('空对象草稿仍带 savedAt', emptyRt && emptyRt.savedAt, now);
deepEq('null / undefined 字段入参按空对象处理',
    [parseDraft(serializeDraft(null, now), now)?.fields, parseDraft(serializeDraft(undefined, now), now)?.fields],
    [{}, {}]);

section('7. 过期边界：恰好 7 天算过期，6 天 23 小时算有效');
const atExactly7d = JSON.stringify({ savedAt: now - 7 * DAY, fields: { city: '边界' } });
const at6d23h = JSON.stringify({ savedAt: now - (7 * DAY - 60 * 60 * 1000), fields: { city: '边界' } });
eq('恰好 7 天 → null（过期）', parseDraft(atExactly7d, now), null);
ok('6 天 23 小时 → 非 null（有效）', parseDraft(at6d23h, now) !== null, `实际 ${show(parseDraft(at6d23h, now))}`);
ok('7 天差 1 毫秒 → 有效', parseDraft(JSON.stringify({ savedAt: now - 7 * DAY + 1, fields: {} }), now) !== null, '边界反向失败');
ok('7 天零 1 毫秒 → 过期', parseDraft(JSON.stringify({ savedAt: now - 7 * DAY - 1, fields: {} }), now) === null, '边界正向失败');
ok('savedAt 在未来（本机时间被调过）仍算有效',
    parseDraft(JSON.stringify({ savedAt: now + DAY, fields: {} }), now) !== null, '未来时间被判过期');
eq('describeDraftAge(7 天前) = 7 天前', describeDraftAge(now - 7 * DAY, now), '7 天前');
eq('describeDraftAge(90 秒前) = 1 分钟前', describeDraftAge(now - 90_000, now), '1 分钟前');

// ═══ 第 2 段：无 localStorage 环境（纯 Node） ════════════════

section('8. 无 localStorage 环境：saveDraft / loadDraft / isUnattended 不抛异常且安全降级');
eq('当前环境确实没有可用的 localStorage', typeof globalThis.window === 'undefined', true);
eq('saveDraft 返回 false（不抛异常）', noThrow(() => eq('  saveDraft(create) = false', saveDraft('create', undefined, { city: 'x' }), false)), 'ok');
eq('loadDraft 返回 null（不抛异常）', noThrow(() => eq('  loadDraft(create) = null', loadDraft('create', undefined), null)), 'ok');
eq('clearDraft 返回 false（不抛异常）', noThrow(() => eq('  clearDraft(create) = false', clearDraft('create', undefined), false)), 'ok');
eq('isUnattended 返回 false（不抛异常）', noThrow(() => eq('  isUnattended() = false', isUnattended(), false)), 'ok');
eq('setUnattended 返回 false（不抛异常）',
    noThrow(() => eq('  setUnattended(true) = false', setUnattended(true), false)), 'ok');
eq('bindAutoSave 在无 DOM 环境也能构造，flush 返回 false 且不抛异常', noThrow(() => {
    const h = bindAutoSave(null, { page: 'create', collect: () => ({ city: 'x' }) });
    eq('  flush() = false', h.flush(), false);
    h.dispose();
}), 'ok');
eq('listSnapshots 在无 localStorage 时返回 []（不抛异常）',
    noThrow(() => deepEq('  listSnapshots() = []', listSnapshots('create'), [])), 'ok');
eq('saveSnapshot 在无 localStorage 时返回 null（不抛异常）',
    noThrow(() => eq('  saveSnapshot() = null', saveSnapshot('create', undefined, 'x', { city: 'x' }), null)), 'ok');
eq('getSnapshot / deleteSnapshot 在无 localStorage 时降级为 null / false（不抛异常）', noThrow(() => {
    eq('  getSnapshot() = null', getSnapshot('create', undefined, 's1'), null);
    eq('  deleteSnapshot() = false', deleteSnapshot('create', undefined, 's1'), false);
}), 'ok');

// ═══ 第 3 段：注入假 window / document / localStorage ═══════

const storage = makeStorage();
const fakeWindow = makeEventTarget();
const fakeDocument = makeEventTarget({ visibilityState: 'visible' });
globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.localStorage = storage;

section('9. 有 localStorage：存 / 取 / 删 全流程');
eq('saveDraft 返回 true', saveDraft('create', undefined, { city: '无锡', way: '52路' }), true);
ok('键名就是 mlttc-tdraft:create', storage.map.has('mlttc-tdraft:create'), `实际键：${show([...storage.map.keys()])}`);
const loaded = loadDraft('create', undefined);
deepEq('loadDraft 取回同样的字段', loaded && loaded.fields, { city: '无锡', way: '52路' });
saveDraft('edit', 42, { city: '江阴' });
deepEq('两份草稿互不干扰',
    [loadDraft('create', undefined)?.fields?.city, loadDraft('edit', 42)?.fields?.city], ['无锡', '江阴']);
eq('clearDraft 返回 true', clearDraft('create', undefined), true);
eq('删除后 loadDraft = null', loadDraft('create', undefined), null);
eq('删除只影响自己那份（edit 仍在）', loadDraft('edit', 42) !== null, true);
eq('没有草稿时 clearDraft 也不报错', clearDraft('edit', 999), true);

section('10. 过期草稿：loadDraft 返回 null 并顺手清掉存储');
storage.setItem('mlttc-tdraft:create', JSON.stringify({ savedAt: Date.now() - 8 * DAY, fields: { city: '旧' } }));
eq('过期草稿读出来是 null', loadDraft('create', undefined), null);
eq('过期条目已被删除', storage.map.has('mlttc-tdraft:create'), false);
storage.setItem('mlttc-tdraft:create', '{坏数据');
eq('坏数据读出来是 null', loadDraft('create', undefined), null);
eq('坏数据条目也被删除', storage.map.has('mlttc-tdraft:create'), false);

section('11. 自动保存开关：持久化 / 关闭 / 键名');
eq('默认关闭', isUnattended(), false);
eq('setUnattended(true) 返回 true', setUnattended(true), true);
eq('开启后 isUnattended = true', isUnattended(), true);
eq("开启写入的值是 '1'", storage.getItem(UNATTENDED_KEY), '1');
eq('setUnattended(false) 返回 true', setUnattended(false), true);
eq('关闭后 isUnattended = false', isUnattended(), false);
eq('关闭即删除键（不留 "0" 残值）', storage.getItem(UNATTENDED_KEY), null);

section('12. bindAutoSave：输入去抖 / pagehide 立即刷 / dispose 后不再写');
const target = makeEventTarget({ value: '' });
let collected = { city: '南京' };
const statuses = [];
const handle = bindAutoSave(target, {
    page: 'edit', id: 7, delayMs: 40,
    collect: () => ({ ...collected }),
    onSaved: (f) => statuses.push(f.city),
});
const before = storage.map.has('mlttc-tdraft:edit:7');
eq('绑定后尚未落盘（不白写空草稿）', before, false);

target.dispatch('input');
await sleep(10);
eq('去抖窗口内不落盘', storage.map.has('mlttc-tdraft:edit:7'), false);
await sleep(60);
eq('去抖结束后自动落盘', storage.map.has('mlttc-tdraft:edit:7'), true);
deepEq('落盘内容即 collect 的返回值', loadDraft('edit', 7)?.fields, { city: '南京' });
deepEq('onSaved 回调收到字段', statuses, ['南京']);

collected = { city: '苏州' };
target.dispatch('change');
fakeWindow.dispatch('pagehide');
deepEq('pagehide 立即刷（不等去抖）', loadDraft('edit', 7)?.fields, { city: '苏州' });
collected = { city: '常州' };
target.dispatch('input');
fakeDocument.visibilityState = 'visible';
fakeDocument.dispatch('visibilitychange');
eq('visibilityState=visible 不触发落盘', loadDraft('edit', 7)?.fields?.city, '苏州');
fakeDocument.visibilityState = 'hidden';
fakeDocument.dispatch('visibilitychange');
eq('visibilityState=hidden 立即落盘', loadDraft('edit', 7)?.fields?.city, '常州');

collected = { city: '不该写进去' };
handle.dispose();
eq('dispose 摘掉 input 监听', target.count('input'), 0);
eq('dispose 摘掉 pagehide 监听', fakeWindow.count('pagehide'), 0);
eq('dispose 摘掉 visibilitychange 监听', fakeDocument.count('visibilitychange'), 0);
fakeWindow.dispatch('pagehide');
target.dispatch('input');
await sleep(60);
eq('dispose 之后 flush 不再写入', loadDraft('edit', 7)?.fields?.city, '常州');
eq('dispose 之后 flush() 返回 false', handle.flush(), false);

section('13. 上传成功后的删除顺序：先 dispose 再 clearDraft，草稿不会复活');
const h2 = bindAutoSave(target, { page: 'edit', id: 7, delayMs: 20, collect: () => ({ city: '厦门' }) });
saveDraft('edit', 7, { city: '厦门' });
h2.dispose();
clearDraft('edit', 7);
eq('删除后确实没有草稿', loadDraft('edit', 7), null);
fakeWindow.dispatch('pagehide');
target.dispatch('input');
await sleep(40);
eq('pagehide / input 之后仍没有草稿（没被写回来）', loadDraft('edit', 7), null);

// ═══ 第 4 段：多快照（用户手动保存的存档） ═══════════════════

section('14. 快照：键名 / 保存 / 读回 / 倒序 / 淘汰 / 删除 / 取回');
const SNAP_KEY = 'mlttc-tdraft:snaps:create';
eq("SNAPSHOT_KEY_PREFIX = 'mlttc-tdraft:snaps:'", SNAPSHOT_KEY_PREFIX, 'mlttc-tdraft:snaps:');
eq('MAX_SNAPSHOTS = 10', MAX_SNAPSHOTS, 10);
eq('SNAPSHOT_MAX_CHARS = 8192', SNAPSHOT_MAX_CHARS, 8192);

// 快照的 savedAt 取 Date.now()，注入时钟才能断言顺序与「淘汰最旧」
const realNow = Date.now;
let clock = 1_700_000_000_000;
Date.now = () => clock;

const s1 = saveSnapshot('create', undefined, '广州→中山路', { city: '广州市', way: '中山路', time1: '06:00' });
ok('saveSnapshot 返回 s 开头的 snapId', typeof s1 === 'string' && s1[0] === 's' && s1.length > 5, show(s1));
ok('快照写在 mlttc-tdraft:snaps:create（不与单草稿键混）',
    storage.map.has(SNAP_KEY) && !storage.map.has('mlttc-tdraft:create'), show([...storage.map.keys()]));
const snap1 = listSnapshots('create');
eq('listSnapshots 读回 1 条', snap1.length, 1);
eq('label 原样保存', snap1[0].label, '广州→中山路');
eq('savedAt 即注入的时钟', snap1[0].savedAt, clock);
deepEq('fields 原样读回', snap1[0].fields, { city: '广州市', way: '中山路', time1: '06:00' });
const got = getSnapshot('create', undefined, s1);
ok('getSnapshot 取回同一份', got && got.savedAt === clock && got.fields.way === '中山路', show(got));
eq('getSnapshot 拿不到时返回 null', getSnapshot('create', undefined, 's-not-exist'), null);

clock += 60_000;
saveSnapshot('create', undefined, '佛山→XX路', { way: 'XX路' });
clock += 60_000;
saveSnapshot('create', undefined, '珠海→YY路', { way: 'YY路' });
deepEq('多条按 savedAt 倒序（新的在前）', listSnapshots('create').map((x) => x.label),
    ['珠海→YY路', '佛山→XX路', '广州→中山路']);

// 造 12 条，逼出淘汰：只剩最新的 10 条，「批量 0 / 1」被挤掉
const snapBase = clock;
for (let i = 0; i < 12; i += 1) {
    clock = snapBase + (i + 1) * 1000;
    saveSnapshot('create', undefined, `批量 ${i}`, { way: `W${i}` });
}
const keptList = listSnapshots('create');
eq('超过 MAX_SNAPSHOTS 时只剩 10 条', keptList.length, MAX_SNAPSHOTS);
eq('最旧的两条（批量 0 / 1）已被淘汰',
    keptList.filter((x) => x.label === '批量 0' || x.label === '批量 1').length, 0);
eq('排头是最新保存的「批量 11」', keptList[0].label, '批量 11');

const countBefore = keptList.length;
const victim = keptList[3].snapId;
eq('deleteSnapshot 删掉指定条 → true', deleteSnapshot('create', undefined, victim), true);
eq('删除后少一条', listSnapshots('create').length, countBefore - 1);
eq('删掉的正是那一条，其余不动', listSnapshots('create').filter((x) => x.snapId === victim).length, 0);
eq('删不存在的 snapId → false（本实现的选择）', deleteSnapshot('create', undefined, 's-none'), false);

const secretSnap = saveSnapshot('create', undefined, '带密钥的', { city: '无锡', password: 'p@ss-1', authToken: 'tk-9f', time1: '06:00' });
const rawAll = storage.getItem(SNAP_KEY);
ok('敏感值 / 敏感键名都没落进快照存储',
    !rawAll.includes('p@ss-1') && !rawAll.includes('tk-9f') && !rawAll.includes('authToken'),
    '敏感内容被写进了存储');
deepEq('快照里只剩非敏感字段', getSnapshot('create', undefined, secretSnap).fields, { city: '无锡', time1: '06:00' });

eq('fields 序列化超过 8KB → 拒绝保存（返回 null）',
    saveSnapshot('create', undefined, '超大', { time1: 'x'.repeat(SNAPSHOT_MAX_CHARS) }), null);
eq('被拒的超大快照没有进列表', listSnapshots('create').filter((x) => x.label === '超大').length, 0);

storage.setItem(SNAP_KEY, '{坏 JSON');
eq('坏 JSON → listSnapshots 返回 [] 且不抛', noThrow(() => deepEq('  listSnapshots() = []', listSnapshots('create'), [])), 'ok');
storage.setItem(SNAP_KEY, '{"not":"array"}');
deepEq('非数组 → []', listSnapshots('create'), []);
storage.setItem(SNAP_KEY, JSON.stringify([null, 42, 'x', {},
    { snapId: 's-ok', savedAt: clock, label: '合法', fields: { way: 'A' } }, { snapId: 's-nofields' }]));
deepEq('数组里混入 null / 数字 / 残缺项：只留下合法那条', listSnapshots('create').map((x) => x.snapId), ['s-ok']);
storage.setItem(SNAP_KEY, JSON.stringify([{ snapId: 's-old', savedAt: clock - 8 * DAY, label: '过期', fields: { way: 'A' } }]));
deepEq('过期（>= 7 天）快照被剔除', listSnapshots('create'), []);

storage.removeItem(SNAP_KEY);
Date.now = realNow;

eq('formatClock 是两位小时的 HH:MM', /^\d{2}:\d{2}$/.test(formatClock(Date.now())), true);

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
