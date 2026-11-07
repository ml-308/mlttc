// functions/api/timetable-import-D1.js
// 接口地址：/api/timetable-import-D1 —— 批量导入时刻表
//   POST  { items: [{city,way,start,end,special,time1,time2,etime}], writer, writetime }
//         一次最多 20 条，**事务性**写入：要么全成功，要么一行都不写。
//
// 依赖：env.mlttcd（D1）、env.mlttckv（KV 限流）
//
// 与单条写入接口 /api/timetable-D1 的关系（不共用代码，只共用表结构与约定）：
//   1. 查重字段、写入字段、ID 规则、默认值全部与单条接口保持一致；
//      但本文件**不 import 那边的辅助函数** —— functions/ 下的文件会被 Pages 当作路由加载，
//      从路由文件 import 会让那个路由被当成普通模块执行，副作用不可控，所以这里自己实现一份。
//   2. 限流用 LIMITS.import（5 次/10 分钟）而不是 LIMITS.write（10 次/10 分钟）：
//      一个请求就能写 20 行，沿用 write 的额度会立刻撞限。
//   3. 批内查重 + 库内查重都在写入前完成，任何一处命中 → 409 且一行不写。
//
// ⚠️ 安全取舍（有意为之，不是遗漏）：
//   本接口**不做 session / cookie 校验**，直接信任 body 里的 writer，
//   与现有单条写入接口 /api/timetable-D1 的约定完全一致。
//   理由：现有前端没有统一携带登录态的写入链路（写时刻表的页面历史上就是免登录提交，
//   靠管理员在 /api/admin 侧审核 PASS 字段兜底），仓促在这里加鉴权会让前端整条提交链路失效，
//   超出「新增批量接口」的改动范围。代价是：知道本接口的人可以把 WRITER 伪造成任意邮箱。
//   风险缓解：PASS 一律写 0（待审核），必须经管理员审核才会对外可见。
//   后续若要收紧，正确做法是在 auth.js 侧统一验证并同步改造单条接口，而不是只改这里。

import { enforceRateLimit, LIMITS } from '../ratelimit.js';

// ─── 常量 ─────────────────────────────────────────────────────

/** 一次请求允许的最大条数 */
const MAX_ITEMS = 20;
/** 一次请求允许的最小条数（空数组 → 400） */
const MIN_ITEMS = 1;

/** 各字段最大长度（字符数） */
const MAX_LEN = {
    city: 100,
    way: 100,
    start: 100,
    end: 100,
    special: 200,
    time1: 5000,
    time2: 5000,
    etime: 40
};

/** 必有字段：[请求字段名, 中文名] */
const REQUIRED_FIELDS = [
    ['city', '城市'],
    ['way', '线路'],
    ['start', '起点'],
    ['end', '终点'],
    ['time1', '时刻表1'],
    ['time2', '时刻表2'],
    ['etime', '执行时间']
];

/** 查重维度（与单条接口的查重 SQL 一一对应，顺序不可改） */
const DUP_FIELDS = ['city', 'way', 'start', 'end', 'time1', 'time2'];

/** special 字段缺省值（与单条接口一致） */
const DEFAULT_SPECIAL = '无';

/**
 * 查重预检每条 SQL 最多带多少行 → 16 行 × 6 个字段 = 96 个绑定参数。
 * D1 的硬限制是「每条 SQL 最多 100 个绑定参数」
 * （https://developers.cloudflare.com/d1/platform/limits/ → Maximum bound parameters per query = 100）。
 * 若 20 行整批写成一条 OR 查询就是 120 个参数，生产环境会直接报错，所以按 16 行分块：
 * 整批最多拆成 2 条**只读**查询。写入仍是单个 batch 事务，
 * 因此「全成功或全不写」的事务语义不受分块影响。
 */
const CHECK_CHUNK_SIZE = 16;

/** 插入语句（列顺序与单条接口完全一致：PASSER 固定 '-'、PASS 固定 0 → 待审核） */
const INSERT_SQL = `INSERT INTO TIMETABLE (ID, CITY, WAY, START, END, SPECIAL, TIMEONE, TIMETWO, STARTTIME, WRITER, WRITETIME, PASSER, PASS)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// ─── 响应辅助 ─────────────────────────────────────────────────

/**
 * 统一构造 JSON 响应（message 与 error 同时给出，兼容前端两种读取习惯）
 * @param {object} body
 * @param {number} status
 * @param {object} [extraHeaders]
 * @returns {Response}
 */
function jsonResponse(body, status, extraHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {})
    });
}

/**
 * 构造 400 参数错误响应
 * @param {Array<{row: number, field: string, message: string}>} errors
 * @returns {Response}
 */
function badRequestResponse(errors) {
    const message = errors.length > 0 ? errors[0].message : '参数校验未通过';
    return jsonResponse({ success: false, message, error: message, errors }, 400);
}

/**
 * 构造 409 重复响应（一行都不写）
 * @param {Array<{row: number, message: string}>} errors
 * @returns {Response}
 */
function conflictResponse(errors) {
    const message = '部分时刻表已存在';
    return jsonResponse({ success: false, message, error: message, errors }, 409);
}

// ─── ID 生成 ─────────────────────────────────────────────────

/**
 * 生成 12 位随机数字串（与单条接口的实现保持一致：3 个 Uint32 → 各取 4 位）
 * @returns {string}
 */
function generate12DigitString() {
    const array = new Uint32Array(3);
    crypto.getRandomValues(array);
    let num = '';
    for (let i = 0; i < 3; i++) {
        num += String(array[i] % 10000).padStart(4, '0');
    }
    return num;
}

/**
 * 为整批数据分配互不相同的 ID，并对库内已有 ID 做一次预检。
 * 命中库内已有 ID 时只重新生成命中的那几个，再做一次预检（最多 3 轮）。
 * @param {object} env
 * @param {number} count
 * @returns {Promise<string[]>}
 */
async function allocateIds(env, count) {
    const set = new Set();
    while (set.size < count) set.add(generate12DigitString());
    let list = [...set];

    for (let round = 0; round < 3; round++) {
        const placeholders = list.map(() => '?').join(', ');
        const { results } = await env.mlttcd.prepare(
            `SELECT ID FROM TIMETABLE WHERE ID IN (${placeholders})`
        ).bind(...list).all();

        const taken = new Set((results || []).map((row) => String(row.ID ?? row.id ?? '')));
        if (taken.size === 0) return list;

        list = list.map((id) => {
            if (!taken.has(id)) return id;
            let next = generate12DigitString();
            let guard = 0;
            while (list.includes(next) && guard++ < 50) next = generate12DigitString();
            return next;
        });
    }

    // 12 位数字空间约 10^12，连续 3 轮全撞的概率可忽略；走到这里说明环境异常
    throw new Error('无法生成唯一 ID');
}

// ─── 参数校验 ─────────────────────────────────────────────────

/**
 * 校验并规范化单条记录
 * @param {*} raw 原始条目
 * @param {number} row 1 基行号
 * @param {Array} errors 错误收集器
 * @returns {null|{city:string,way:string,start:string,end:string,special:string,time1:string,time2:string,etime:string}}
 */
function normalizeItem(raw, row, errors) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ row, field: 'item', message: `第 ${row} 行数据格式无效` });
        return null;
    }

    const out = {};
    for (const [field, label] of REQUIRED_FIELDS) {
        const value = raw[field];
        if (typeof value !== 'string' || value.trim().length === 0) {
            errors.push({ row, field, message: `${label}不能为空` });
            continue;
        }
        const trimmed = value.trim();
        if (trimmed.length > MAX_LEN[field]) {
            errors.push({ row, field, message: `${label}长度不能超过 ${MAX_LEN[field]} 个字符` });
            continue;
        }
        out[field] = trimmed;
    }

    // special 可选：缺省、null、空串都写 '无'
    const special = raw.special;
    if (special === undefined || special === null || (typeof special === 'string' && special.trim().length === 0)) {
        out.special = DEFAULT_SPECIAL;
    } else if (typeof special !== 'string') {
        errors.push({ row, field: 'special', message: '备注格式无效' });
    } else {
        const trimmed = special.trim();
        if (trimmed.length > MAX_LEN.special) {
            errors.push({ row, field: 'special', message: `备注长度不能超过 ${MAX_LEN.special} 个字符` });
        } else {
            out.special = trimmed;
        }
    }

    return out;
}

/**
 * 校验 writer / writetime 这类整批共用字段
 * @param {*} value
 * @param {string} field
 * @param {string} label
 * @param {Array} errors
 * @returns {string} 去空格后的值（非法时为空串，调用方在 errors 非空时不会使用）
 */
function normalizeCommonString(value, field, label, errors) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        errors.push({ row: 0, field, message: `${label}不能为空` });
        return '';
    }
    return value.trim();
}

/**
 * 查重键（六元组，用 JSON 保证不会因为分隔符与内容相同而误判）
 * @param {object} item
 * @returns {string}
 */
function dupKey(item) {
    return JSON.stringify(DUP_FIELDS.map((field) => item[field]));
}

// ─── 路由入口 ─────────────────────────────────────────────────

/**
 * 方法兜底：本接口只接受 POST，其它方法显式返回 405。
 * （不依赖 Pages 框架对「未导出该方法的处理器」的兜底行为，行为由本文件自己保证）
 */
export async function onRequest(context) {
    if (!context || !context.request || context.request.method !== 'POST') {
        const message = '只支持 POST 方法';
        return jsonResponse({ success: false, message, error: message }, 405, { Allow: 'POST' });
    }
    return onRequestPost(context);
}

export async function onRequestPost({ request, env }) {
    // 频率限制：批量导入有独立额度（5 次/10 分钟），与单条写入的 write 桶互不影响
    const limited = await enforceRateLimit(request, env, LIMITS.import);
    if (limited) return limited;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const message = '无效的请求数据';
        return jsonResponse({ success: false, message, error: message, errors: [] }, 400);
    }

    const errors = [];

    // ----- items 校验（1~20 条）-----
    const rawItems = body.items;
    const itemsIsValidArray = Array.isArray(rawItems);
    if (!itemsIsValidArray) {
        errors.push({ row: 0, field: 'items', message: 'items 必须是数组' });
    } else if (rawItems.length < MIN_ITEMS) {
        errors.push({ row: 0, field: 'items', message: `至少提交 ${MIN_ITEMS} 条时刻表` });
    } else if (rawItems.length > MAX_ITEMS) {
        errors.push({ row: 0, field: 'items', message: `一次最多提交 ${MAX_ITEMS} 条时刻表` });
    }

    // ----- writer / writetime -----
    const writer = normalizeCommonString(body.writer, 'writer', '作者', errors);
    const writetime = normalizeCommonString(body.writetime, 'writetime', '写入时间', errors);

    // ----- 逐条校验 -----
    const rows = [];
    if (itemsIsValidArray && rawItems.length >= MIN_ITEMS && rawItems.length <= MAX_ITEMS) {
        rawItems.forEach((raw, index) => {
            const normalized = normalizeItem(raw, index + 1, errors);
            if (normalized) rows.push(normalized);
        });
    }

    if (errors.length > 0) return badRequestResponse(errors);

    // ----- 批内查重：完全相同才算重复，row 指向后出现的那一行 -----
    const seen = new Set();
    const inBatchDupErrors = [];
    rows.forEach((item, index) => {
        const key = dupKey(item);
        if (seen.has(key)) {
            inBatchDupErrors.push({ row: index + 1, message: '该时刻表已存在' });
        } else {
            seen.add(key);
        }
    });
    if (inBatchDupErrors.length > 0) return conflictResponse(inBatchDupErrors);

    // ----- 库内查重预检：命中即 409、一行不写 -----
    // 用 OR 分组而不是行值 IN ((...),(...))：行值语法要 SQLite 3.15+，
    // 这里不引入版本前提，老的兼容层（含测试用的假 D1）也能跑。
    // 按 CHECK_CHUNK_SIZE 分块是为了不撞 D1 的 100 个绑定参数上限（见常量注释）。
    const existingRows = [];
    try {
        for (let offset = 0; offset < rows.length; offset += CHECK_CHUNK_SIZE) {
            const chunk = rows.slice(offset, offset + CHECK_CHUNK_SIZE);
            const checkParams = [];
            const checkClauses = chunk.map((item) => {
                const placeholders = DUP_FIELDS.map((field) => {
                    checkParams.push(item[field]);
                    return '?';
                });
                return `(CITY = ${placeholders[0]} AND WAY = ${placeholders[1]} AND START = ${placeholders[2]} AND END = ${placeholders[3]} AND TIMEONE = ${placeholders[4]} AND TIMETWO = ${placeholders[5]})`;
            });

            const result = await env.mlttcd.prepare(
                `SELECT CITY, WAY, START, END, TIMEONE, TIMETWO FROM TIMETABLE WHERE ${checkClauses.join(' OR ')}`
            ).bind(...checkParams).all();

            if (result && result.results && result.results.length > 0) {
                existingRows.push(...result.results);
                break; // 已经确定有重复，不必再查剩下的块
            }
        }
    } catch (err) {
        console.error('批量查重错误:', err);
        const message = '数据库查询失败';
        return jsonResponse({ success: false, message, error: message }, 500);
    }

    if (existingRows.length > 0) {
        const existingKeys = new Set(existingRows.map((row) => JSON.stringify([
            row.CITY, row.WAY, row.START, row.END, row.TIMEONE, row.TIMETWO
        ])));
        const existingErrors = [];
        rows.forEach((item, index) => {
            if (existingKeys.has(dupKey(item))) {
                existingErrors.push({ row: index + 1, message: '该时刻表已存在' });
            }
        });
        // 兜底：SQL 命中了但没对上具体行（例如列排序规则与预期不同），
        // 仍然要按 409 处理，绝不因为「定位不到行号」而放行写入。
        if (existingErrors.length === 0) existingErrors.push({ row: 0, message: '该时刻表已存在' });
        return conflictResponse(existingErrors);
    }

    // ----- 分配 ID（批内互不相同 + 库内一次预检）-----
    let ids;
    try {
        ids = await allocateIds(env, rows.length);
    } catch (err) {
        console.error('ID 生成错误:', err);
        const message = '服务器内部错误';
        return jsonResponse({ success: false, message, error: message }, 500);
    }

    // ----- 事务性写入 -----
    // D1 的 batch() 在单个事务中顺序执行：任一条失败则整批回滚，
    // 因此不会出现「前几行写进去、后面几行失败」的半成品数据。
    const statements = rows.map((item, index) => env.mlttcd.prepare(INSERT_SQL).bind(
        ids[index],
        item.city,
        item.way,
        item.start,
        item.end,
        item.special,
        item.time1,
        item.time2,
        item.etime,
        writer,
        writetime,
        '-',
        0
    ));

    try {
        await env.mlttcd.batch(statements);
    } catch (err) {
        console.error('批量写入错误:', err);
        const message = '数据库写入失败';
        return jsonResponse({ success: false, message, error: message }, 500);
    }

    return jsonResponse({
        success: true,
        inserted: rows.length,
        items: rows.map((item, index) => ({ row: index + 1, id: ids[index] }))
    }, 201);
}
