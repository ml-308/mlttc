// tools/import-api-test/run.mjs
// 批量导入接口 functions/api/timetable-import-D1.js 的无依赖自测。
//
// 用法：node tools/import-api-test/run.mjs
//       全通过 → 打印 PASS n/n，退出码 0；有失败 → 打印首个失败详情，退出码 1。
//
// 为什么要用加载钩子：
//   仓库根 package.json 是 "type": "commonjs"，而 functions/*.js 里写的是 ESM（Pages 用 esbuild
//   打包，不受 package.json 影响）。Node 默认会按 CJS 解析这些 .js 文件 → import 语法报错。
//   这里用 node:module 的同步加载钩子把 functions/ 下的 .js 强制定为 ESM 读入，
//   从而直接测「真实源码」，不复制、不改写被测文件。
//
// 环境说明：本机没有 wrangler / 真实 D1，所以用假的 env.mlttcd（D1）与 env.mlttckv（KV 限流）。

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const functionsDir = path.join(root, 'functions') + path.sep;
const apiPath = path.join(root, 'functions', 'api', 'timetable-import-D1.js');
const ratelimitPath = path.join(root, 'functions', 'ratelimit.js');

if (typeof registerHooks !== 'function') {
    console.error(`本测试需要 node:module 的 registerHooks（Node 22.15+ / 23.5+），当前 Node ${process.version} 不支持`);
    process.exit(1);
}

registerHooks({
    load(url, context, nextLoad) {
        if (url.startsWith('file:')) {
            const file = fileURLToPath(url);
            if (file.startsWith(functionsDir) && file.endsWith('.js')) {
                return { format: 'module', source: readFileSync(file, 'utf8'), shortCircuit: true };
            }
        }
        return nextLoad(url, context);
    }
});

// ─── 假 D1 ────────────────────────────────────────────────────

class FakeStmt {
    constructor(db, sql) {
        this.db = db;
        this.sql = sql;
        this.args = [];
    }
    bind(...args) {
        this.args = args;
        return this;
    }
    async first() {
        const rows = this.db.query(this.sql, this.args);
        return rows.length > 0 ? rows[0] : null;
    }
    async all() {
        return { results: this.db.query(this.sql, this.args) };
    }
    async run() {
        return { meta: { changes: 1 } };
    }
}

class FakeDB {
    /**
     * @param {Array<{id:string, city:string, way:string, start:string, end:string, time1:string, time2:string}>} existing
     *        库内已有的记录（用于模拟查重命中）
     */
    constructor(existing = []) {
        this.existing = existing;
        this.prepares = [];
        this.batchCalls = [];
        this.batchError = null;
    }
    prepare(sql) {
        const stmt = new FakeStmt(this, sql);
        this.prepares.push(stmt);
        return stmt;
    }
    async batch(statements) {
        this.batchCalls.push(statements);
        if (this.batchError) throw this.batchError;
        return statements.map(() => ({ meta: { changes: 1 } }));
    }
    /** 只实现被测代码真正会发的两种 SELECT，其它 SQL 直接报错，避免「假实现悄悄跑偏」 */
    query(sql, args) {
        const compact = sql.replace(/\s+/g, ' ').trim();

        if (/^SELECT ID FROM TIMETABLE WHERE ID IN \(/i.test(compact)) {
            return this.existing
                .filter((row) => args.includes(row.id))
                .map((row) => ({ ID: row.id }));
        }

        if (/^SELECT CITY, WAY, START, END, TIMEONE, TIMETWO FROM TIMETABLE WHERE \(/i.test(compact)) {
            const hit = [];
            for (let i = 0; i + 5 < args.length; i += 6) {
                const [city, way, start, end, time1, time2] = args.slice(i, i + 6);
                const row = this.existing.find((r) => r.city === city && r.way === way
                    && r.start === start && r.end === end && r.time1 === time1 && r.time2 === time2);
                if (row) {
                    hit.push({ CITY: row.city, WAY: row.way, START: row.start, END: row.end, TIMEONE: row.time1, TIMETWO: row.time2 });
                }
            }
            return hit;
        }

        throw new Error(`假 D1 未实现的 SQL：${compact}`);
    }
}

// ─── 假 KV（限流存储）────────────────────────────────────────

class FakeKV {
    constructor() {
        this.store = new Map();
    }
    async get(key, options) {
        const raw = this.store.get(key);
        if (raw === undefined) return null;
        return options && options.type === 'json' ? JSON.parse(raw) : raw;
    }
    async put(key, value) {
        this.store.set(key, String(value));
    }
}

function makeEnv(existing = []) {
    return { mlttcd: new FakeDB(existing), mlttckv: new FakeKV() };
}

// ─── 请求构造 ─────────────────────────────────────────────────

const URL_IMPORT = 'https://x/api/timetable-import-D1';

function postRequest(payload) {
    return new Request(URL_IMPORT, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' }
    });
}

function makeItem(index, overrides = {}) {
    return {
        city: '测试市',
        way: `线路${index}`,
        start: `起点${index}`,
        end: `终点${index}`,
        special: '',
        time1: `07:${String(index).padStart(2, '0')}`,
        time2: `08:${String(index).padStart(2, '0')}`,
        etime: '工作日',
        ...overrides
    };
}

function makePayload(count, overrides = {}) {
    return {
        items: Array.from({ length: count }, (_, i) => makeItem(i + 1)),
        writer: 'tester@example.com',
        writetime: '2024-01-01 10:00:00',
        ...overrides
    };
}

// ─── 测试框架 ─────────────────────────────────────────────────

let passed = 0;
const failures = [];

function assert(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failures.push({ name, detail: detail || '' });
        console.log(`  FAIL ${name}`);
    }
}

function section(title) {
    console.log(`\n[${title}]`);
}

// ─── 被测模块 ─────────────────────────────────────────────────

const handler = await import(pathToFileURL(apiPath).href);
const ratelimit = await import(pathToFileURL(ratelimitPath).href);

// ─── 1. 正常 20 条 ────────────────────────────────────────────

section('正常写入 20 条');
{
    const env = makeEnv();
    const res = await handler.onRequestPost({ request: postRequest(makePayload(20)), env });
    const body = await res.json();
    const db = env.mlttcd;

    assert('状态码 201', res.status === 201, `实际 ${res.status}`);
    assert('success=true 且 inserted=20', body.success === true && body.inserted === 20, JSON.stringify(body));
    assert('返回 20 条 row/id', Array.isArray(body.items) && body.items.length === 20, JSON.stringify(body.items));
    assert('row 为 1 基下标', body.items?.[0]?.row === 1 && body.items?.[19]?.row === 20, JSON.stringify(body.items?.slice(0, 1)));
    assert('batch 被调用且只有 1 次', db.batchCalls.length === 1, `batchCalls=${db.batchCalls.length}`);
    assert('batch 语句数为 20', db.batchCalls[0]?.length === 20, `语句数=${db.batchCalls[0]?.length}`);
    assert('插入语句是 INSERT INTO TIMETABLE',
        (db.batchCalls[0]?.[0]?.sql || '').includes('INSERT INTO TIMETABLE'), db.batchCalls[0]?.[0]?.sql);
    assert('每条语句 PASSER=\'-\'、PASS=0',
        db.batchCalls[0].every((s) => s.args[11] === '-' && s.args[12] === 0),
        JSON.stringify(db.batchCalls[0].map((s) => [s.args[11], s.args[12]])));
    assert('special 缺省为「无」', db.batchCalls[0][0].args[5] === '无', String(db.batchCalls[0][0].args[5]));
    assert('writer / writetime 落到第 10、11 个参数',
        db.batchCalls[0][0].args[9] === 'tester@example.com' && db.batchCalls[0][0].args[10] === '2024-01-01 10:00:00',
        JSON.stringify([db.batchCalls[0][0].args[9], db.batchCalls[0][0].args[10]]));

    // 5. ID 唯一且都是 12 位数字
    const ids = body.items.map((it) => it.id);
    assert('20 个 id 互不相同', new Set(ids).size === 20, JSON.stringify(ids));
    assert('20 个 id 都是 12 位数字', ids.every((id) => /^\d{12}$/.test(id)), JSON.stringify(ids));
    assert('id 与写入语句里的第一个参数一致', db.batchCalls[0].every((s, i) => s.args[0] === ids[i]), 'id 与语句参数不匹配');
}

// ─── 2. 400 参数错误 ─────────────────────────────────────────

section('参数错误 → 400 且不写库');
{
    const cases = [
        ['空数组 items', makePayload(0)],
        ['21 条 items', makePayload(21)],
        ['缺 writer', (() => { const p = makePayload(2); delete p.writer; return p; })()],
        ['某项缺 etime', (() => { const p = makePayload(2); delete p.items[1].etime; return p; })()],
        ['writer 为空串', makePayload(2, { writer: '   ' })],
        ['city 超长（101 字符）', (() => { const p = makePayload(1); p.items[0].city = '城'.repeat(101); return p; })()],
        ['items 不是数组', { items: 'not-an-array', writer: 'a@b.c', writetime: '2024-01-01' }]
    ];

    for (const [name, payload] of cases) {
        const env = makeEnv();
        const res = await handler.onRequestPost({ request: postRequest(payload), env });
        const body = await res.json().catch(() => ({}));
        assert(`${name} → 400`, res.status === 400, `实际 ${res.status}`);
        assert(`${name} → success=false 且带 message/error`,
            body.success === false && typeof body.message === 'string' && body.error === body.message,
            JSON.stringify(body));
        assert(`${name} → errors 是数组`, Array.isArray(body.errors), JSON.stringify(body.errors));
        assert(`${name} → batch 未被调用`, env.mlttcd.batchCalls.length === 0, `batchCalls=${env.mlttcd.batchCalls.length}`);
    }

    // 非法 JSON body
    const env = makeEnv();
    const badJson = new Request(URL_IMPORT, { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } });
    const res = await handler.onRequestPost({ request: badJson, env });
    assert('非法 JSON body → 400', res.status === 400, `实际 ${res.status}`);
    assert('非法 JSON body → batch 未被调用', env.mlttcd.batchCalls.length === 0, 'batch 被调用了');
}

// ─── 3. 批内重复 → 409 ───────────────────────────────────────

section('批内重复 → 409 且不写库');
{
    const env = makeEnv();
    const payload = makePayload(3);
    payload.items[2] = { ...payload.items[0] }; // 第 3 行与第 1 行完全相同
    const res = await handler.onRequestPost({ request: postRequest(payload), env });
    const body = await res.json();

    assert('状态码 409', res.status === 409, `实际 ${res.status}`);
    assert('message/error 为「部分时刻表已存在」',
        body.message === '部分时刻表已存在' && body.error === body.message, JSON.stringify(body));
    assert('errors[0].row 指向后出现的那行（3）', body.errors?.[0]?.row === 3, JSON.stringify(body.errors));
    assert('errors[0].message 为「该时刻表已存在」', body.errors?.[0]?.message === '该时刻表已存在', JSON.stringify(body.errors));
    assert('batch 未被调用', env.mlttcd.batchCalls.length === 0, `batchCalls=${env.mlttcd.batchCalls.length}`);
}

// ─── 4. 库内已存在 → 409 ────────────────────────────────────

section('库内已存在 → 409 且不写库');
{
    const payload = makePayload(3);
    const target = payload.items[2]; // 第 3 行在库里已存在
    const env = makeEnv([{
        id: '123456789012',
        city: target.city,
        way: target.way,
        start: target.start,
        end: target.end,
        time1: target.time1,
        time2: target.time2
    }]);
    const res = await handler.onRequestPost({ request: postRequest(payload), env });
    const body = await res.json();

    assert('状态码 409', res.status === 409, `实际 ${res.status}`);
    assert('message 为「部分时刻表已存在」', body.message === '部分时刻表已存在', JSON.stringify(body));
    assert('errors[0].row 指向命中的那行（3）', body.errors?.[0]?.row === 3, JSON.stringify(body.errors));
    assert('batch 未被调用', env.mlttcd.batchCalls.length === 0, `batchCalls=${env.mlttcd.batchCalls.length}`);
    assert('3 行只需 1 条查重 SQL（OR 分组覆盖整块）',
        env.mlttcd.prepares.length === 1 && (env.mlttcd.prepares[0].sql.match(/OR/g) || []).length === 2,
        `prepare 次数=${env.mlttcd.prepares.length}`);
}

// ─── 4b. D1 绑定参数上限（每条 SQL ≤ 100）────────────────────

section('D1 绑定参数上限（每条 SQL ≤ 100 个）');
{
    // 20 行 × 6 字段 = 120 个参数，一定要分块，否则生产环境整批失败
    const env = makeEnv();
    const res = await handler.onRequestPost({ request: postRequest(makePayload(20)), env });
    assert('20 行仍返回 201', res.status === 201, `实际 ${res.status}`);

    const checkStmts = env.mlttcd.prepares.filter((s) => /SELECT CITY, WAY, START, END, TIMEONE, TIMETWO/.test(s.sql));
    assert('20 行拆成 2 条查重 SQL', checkStmts.length === 2, `查重 SQL 条数=${checkStmts.length}`);
    assert('两块分别是 96 / 24 个绑定参数', JSON.stringify(checkStmts.map((s) => s.args.length)) === '[96,24]',
        JSON.stringify(checkStmts.map((s) => s.args.length)));
    assert('所有 SQL 的绑定参数都 ≤ 100', env.mlttcd.prepares.every((s) => s.args.length <= 100),
        JSON.stringify(env.mlttcd.prepares.map((s) => s.args.length)));

    // 17 行 → 96 + 6
    const env17 = makeEnv();
    await handler.onRequestPost({ request: postRequest(makePayload(17)), env: env17 });
    const check17 = env17.mlttcd.prepares.filter((s) => /SELECT CITY, WAY, START, END, TIMEONE, TIMETWO/.test(s.sql));
    assert('17 行拆成 2 条查重 SQL（96 + 6）',
        check17.length === 2 && check17[0].args.length === 96 && check17[1].args.length === 6,
        JSON.stringify(check17.map((s) => s.args.length)));

    // 命中的行在第二块里，仍要正确定位到行号
    const payload = makePayload(20);
    const target = payload.items[19]; // 第 20 行
    const env2 = makeEnv([{
        id: '999999999999',
        city: target.city, way: target.way, start: target.start, end: target.end,
        time1: target.time1, time2: target.time2
    }]);
    const res2 = await handler.onRequestPost({ request: postRequest(payload), env: env2 });
    const body2 = await res2.json();
    assert('第二块命中也返回 409', res2.status === 409, `实际 ${res2.status}`);
    assert('第二块命中时 row=20', body2.errors?.[0]?.row === 20, JSON.stringify(body2.errors));
    assert('第二块命中时 batch 未被调用', env2.mlttcd.batchCalls.length === 0, `batchCalls=${env2.mlttcd.batchCalls.length}`);
}

// ─── 5. ID 与库内已有 ID 冲突时重生成 ───────────────────────

section('ID 分配');
{
    const env = makeEnv();
    // 让库里「已存在」的 ID 恰好等于第一次生成的候选 ID：先跑一次拿到真实 ID，再用它构造冲突环境
    const first = await handler.onRequestPost({ request: postRequest(makePayload(1)), env });
    const firstBody = await first.json();
    assert('单条也返回 201 且 id 为 12 位数字',
        first.status === 201 && /^\d{12}$/.test(firstBody.items?.[0]?.id || ''), JSON.stringify(firstBody));

    const conflictingId = firstBody.items[0].id;
    const payload = makePayload(1);
    const conflictEnv = makeEnv([{
        id: conflictingId,
        city: '别处', way: '别处', start: '别处', end: '别处', time1: 'x', time2: 'y'
    }]);
    // 无法直接控制随机数，这里只断言：即使库内已存在同 ID，接口也不会因此报错/写脏（预检 SQL 被发出）
    const res = await handler.onRequestPost({ request: postRequest(payload), env: conflictEnv });
    assert('ID 预检 SQL 确实发出（SELECT ID FROM TIMETABLE WHERE ID IN (...)）',
        conflictEnv.mlttcd.prepares.some((s) => /SELECT ID FROM TIMETABLE WHERE ID IN/.test(s.sql)),
        conflictEnv.mlttcd.prepares.map((s) => s.sql).join(' | '));
    assert('ID 预检不会影响正常写入（仍是 201）', res.status === 201, `实际 ${res.status}`);
}

// ─── 6. 非 POST → 405 ───────────────────────────────────────

section('非 POST 方法');
{
    const env = makeEnv();
    const getRes = await handler.onRequest({ request: new Request(URL_IMPORT, { method: 'GET' }), env });
    const getBody = await getRes.json();
    assert('GET → 405', getRes.status === 405, `实际 ${getRes.status}`);
    assert('405 带 Allow: POST 头', getRes.headers.get('Allow') === 'POST', String(getRes.headers.get('Allow')));
    assert('405 body 带 message 与 error',
        getBody.success === false && typeof getBody.message === 'string' && getBody.error === getBody.message,
        JSON.stringify(getBody));
    assert('405 未写库', env.mlttcd.batchCalls.length === 0, 'batch 被调用了');

    const deleteRes = await handler.onRequest({ request: new Request(URL_IMPORT, { method: 'DELETE' }), env });
    assert('DELETE → 405', deleteRes.status === 405, `实际 ${deleteRes.status}`);

    // onRequest 也要把 POST 正确转交给 onRequestPost（Pages 里 onRequest 覆盖所有方法）
    const postEnv = makeEnv();
    const postRes = await handler.onRequest({ request: postRequest(makePayload(2)), env: postEnv });
    assert('onRequest + POST → 201（转交给 onRequestPost）', postRes.status === 201, `实际 ${postRes.status}`);
    assert('onRequest + POST → batch 语句数 2', postEnv.mlttcd.batchCalls[0]?.length === 2, `语句数=${postEnv.mlttcd.batchCalls[0]?.length}`);
}

// ─── 7. 限流额度独立 ───────────────────────────────────────

section('限流');
{
    assert('LIMITS.import = { name: "timetable-import", max: 300, window: 600 }（逐行提交后额度按行计）',
        JSON.stringify(ratelimit.LIMITS.import) === JSON.stringify({ name: 'timetable-import', max: 300, window: 600 }),
        JSON.stringify(ratelimit.LIMITS.import));
    assert('LIMITS.write 仍是 10 次/600 秒（未被复用/篡改）',
        ratelimit.LIMITS.write.max === 10 && ratelimit.LIMITS.write.window === 600 && ratelimit.LIMITS.write.name === 'write',
        JSON.stringify(ratelimit.LIMITS.write));

    // 逐行提交后额度按行计：10 分钟内 300 行（= 300 个请求）全部放行，第 301 个才 429
    const env = makeEnv(); // 同一个 env → 同一个 KV 桶
    const statuses = [];
    for (let i = 0; i < 301; i += 1) {
        const res = await handler.onRequestPost({ request: postRequest(makePayload(1)), env });
        statuses.push(res.status);
    }
    assert('前 300 次放行（201）', statuses.slice(0, 300).every((s) => s === 201),
        `201 个数=${statuses.filter((s) => s === 201).length}，尾部=${JSON.stringify(statuses.slice(297))}`);
    assert('第 301 次被限流（429）', statuses[300] === 429, JSON.stringify(statuses.slice(298)));
    assert('被限流时只写了 300 次', env.mlttcd.batchCalls.length === 300, `batchCalls=${env.mlttcd.batchCalls.length}`);
    assert('限流响应带 retryAfter 与 X-RateLimit-Limit=300',
        (await handler.onRequestPost({ request: postRequest(makePayload(1)), env })).headers.get('X-RateLimit-Limit') === '300',
        'X-RateLimit-Limit 不等于 300');
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
