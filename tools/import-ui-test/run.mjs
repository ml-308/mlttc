// tools/import-ui-test/run.mjs
/**
 * 时刻表批量导入面板（lib/ui/timetable-import.mjs）的无浏览器测试
 *
 * 用 tools/nav-smoke-test/dom-stub.mjs 的最小 DOM 桩，加载真实的 timetable.html 骨架，
 * 再挂上真实的导入面板组件，逐条验证：
 *   分页预览（20/页）、非法行阻止上传、按 20 行自动分批串行提交、
 *   429 断点续传、409 部分完成如实报告、未登录不发起请求、模板下载不抛错。
 *
 * 用法：node tools/import-ui-test/run.mjs
 * 全部通过打印 PASS n/n 并以 0 退出；任一断言失败打印首个失败详情并以非 0 退出。
 *
 * 说明：dom-stub 没有真实的 File / Blob / DataTransfer，
 *   - 文件路径用「带 name + text() 的普通对象」覆盖（parseTableFile 只依赖这两样）；
 *   - Blob / URL.createObjectURL 用 Node 自带实现（Node 18+ 都有），只验证不抛错；
 *   - 组件把这些都做了可选/防御处理，因此不需要额外的全局打桩。
 */

import { createDOM } from '../nav-smoke-test/dom-stub.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(root, 'timetable.html'), 'utf8');

/* ─── 城市库预热 ────────────────────────────────────────────────
 * 城市列要按城市库匹配（lib/timetable-import.mjs 的 normalizeCityField），
 * 面板解析前会确保城市数据就绪。这里让真实加载路径读仓库里的 cities.json。 */
const CITY_JSON = JSON.parse(readFileSync(path.join(root, 'lib/data/cities.json'), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).includes('cities.json')) return { ok: true, json: async () => CITY_JSON };
    if (realFetch) return realFetch(url, init);
    throw new Error('unexpected fetch: ' + url);
};
await (await import(pathToFileURL(path.join(root, 'lib/data/city-data.mjs')).href)).loadCityData();

const { createImportPanel, BATCH_SIZE, PAGE_SIZE } = await import(
    pathToFileURL(path.join(root, 'lib/ui/timetable-import.mjs')).href
);

/* ------------------------------------------------------------------ */
/* 断言脚手架                                                          */
/* ------------------------------------------------------------------ */

const failures = [];
let checks = 0;

function check(ok, detail) {
    checks += 1;
    if (!ok) failures.push(detail);
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};
const rowsOf = (preview) => (preview ? preview.querySelectorAll('tbody tr') : []);

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const HEADER = [
    '城市', '线路', '起点站', '终点站', '特殊情况',
    '主站→副站时刻表', '副站→主站时刻表', '执行时间'
];

function dataRow(i, over = {}) {
    return [
        over.city ?? '上海市',
        over.way ?? `测试${i}路`,
        '火车站',
        '汽车站',
        over.special ?? '无',
        over.time1 ?? '0630,0700',
        over.time2 ?? '0645,0715',
        over.etime ?? '2025.1.1'
    ];
}

/** 生成 count 行合法数据（含表头行） */
function makeTable(count) {
    return [HEADER, ...Array.from({ length: count }, (_, i) => dataRow(i + 1))];
}

/* ------------------------------------------------------------------ */
/* 环境搭建                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每个用例一套全新的 DOM + 面板，避免监听器叠加
 * @param {object} opts
 * @param {(call: object) => Promise<object>} [opts.respond] fetch 响应工厂
 */
function newPanel(opts = {}) {
    const { doc } = createDOM(HTML);
    globalThis.document = doc;

    const mount = doc.getElementById('import-body');
    const notifyCalls = [];
    const calls = [];

    const fetchImpl = async (url, init) => {
        const call = {
            index: calls.length + 1,
            url: String(url),
            init,
            body: init && init.body ? JSON.parse(init.body) : null
        };
        calls.push(call);
        if (opts.respond) return opts.respond(call);
        const size = call.body ? call.body.items.length : 0;
        return {
            ok: true,
            status: 201,
            json: async () => ({
                success: true,
                inserted: size,
                items: Array.from({ length: size }, (_, i) => ({ row: i + 2, id: 'ID' + i }))
            })
        };
    };

    const panel = createImportPanel({
        mount,
        fetchImpl,
        getWriter: opts.getWriter || (async () => '测试用户'),
        confirmImpl: opts.confirmImpl || (async () => 1),
        notify: (msg, isError, extra) => notifyCalls.push({ msg, isError, extra }),
        now: () => new Date(2025, 5, 1)
    });

    const $ = (id) => doc.getElementById(id);
    return { doc, mount, panel, calls, notifyCalls, $ };
}

const okResponse = (call) => {
    const size = call.body ? call.body.items.length : 0;
    return {
        ok: true,
        status: 201,
        json: async () => ({
            success: true,
            inserted: size,
            items: Array.from({ length: size }, (_, i) => ({ row: i + 2, id: 'ID' + i }))
        })
    };
};

/* ------------------------------------------------------------------ */
/* 1. 分页预览：25 行 → 首页 20 行，第 2 页 5 行，切页不重新解析        */
/* ------------------------------------------------------------------ */

{
    const { panel, $ } = newPanel();
    panel.setRows(makeTable(25));

    const preview = $('import-preview');
    const stat = text($('import-stat'));

    check(rowsOf(preview).length === PAGE_SIZE, `分页 1：首页应 ${PAGE_SIZE} 行，实际 ${rowsOf(preview).length}`);
    check(!preview.classList.contains('hidden'), '分页 1：预览容器应可见');
    check(stat.includes('共 25 行'), `分页 1：统计应含「共 25 行」，实际「${stat}」`);
    check(stat.includes('第 1/2 页'), `分页 1：统计应含「第 1/2 页」，实际「${stat}」`);

    const state = panel.getState();
    check(state.total === 25 && state.totalPages === 2, `分页 1：getState 应 total=25/totalPages=2，实际 ${state.total}/${state.totalPages}`);
    check(state.records === 25 && state.errors === 0, `分页 1：应 25 条合法 0 处问题，实际 ${state.records}/${state.errors}`);

    const pager = $('import-pager');
    const pageButtons = pager.querySelectorAll('.tt-page-btn');
    const toPage2 = pageButtons.filter((b) => b.getAttribute('data-page') === '2'
        && text(b) === '2')[0];
    check(Boolean(toPage2), '分页 1：应有第 2 页按钮');
    if (toPage2) toPage2.dispatch('click');

    check(rowsOf(preview).length === 5, `分页 1：第 2 页应 5 行，实际 ${rowsOf(preview).length}`);
    check(panel.getState().page === 2, '分页 1：切换后 page 应为 2');
    check(text($('import-stat')).includes('第 2/2 页'), `分页 1：第 2 页统计异常「${text($('import-stat'))}」`);
    // 首列是行号：第 2 页第一条应为 Excel 第 22 行（表头=1，首条数据=2）
    const firstCell = rowsOf(preview)[0].querySelectorAll('td')[0];
    check(text(firstCell) === '22', `分页 1：第 2 页首行行号应为 22，实际 ${text(firstCell)}`);
    check(panel.getState().records === 25, '分页 1：切页不应影响解析结果（缓存复用）');
}

/* ------------------------------------------------------------------ */
/* 2. 非法行：上传禁用 + 汇总文案 + is-invalid                        */
/* ------------------------------------------------------------------ */

{
    const { panel, $ } = newPanel();
    panel.setRows([
        HEADER,
        dataRow(1),
        dataRow(2, { time1: '2502' }),
        dataRow(3)
    ]);

    const confirmBtn = $('import-confirm');
    const problems = text($('import-problems'));
    const preview = $('import-preview');
    const invalidRows = preview.querySelectorAll('tr.is-invalid');

    check(confirmBtn.disabled === true, '非法行：上传按钮应 disabled');
    check(confirmBtn.hasAttribute('disabled') === true,
        '非法行：disabled 属性必须真的写上（hcw-button 灰态只看这个属性）');
    check(panel.getState().canUpload === false, '非法行：getState().canUpload 应为 false');
    check(problems.includes('共 1 处问题，修正后才能上传'), `非法行：汇总文案异常「${problems}」`);
    check(problems.includes('第 3 行'), `非法行：汇总应含「第 3 行」，「${problems}」`);
    check(problems.includes('时刻格式不合法：2502'), `非法行：汇总应含具体原因，「${problems}」`);
    check(invalidRows.length === 1, `非法行：应 1 行带 is-invalid，实际 ${invalidRows.length}`);
    check(rowsOf(preview).length === 3, `非法行：预览仍应展示 3 行（含非法行），实际 ${rowsOf(preview).length}`);

    const statusCell = invalidRows.length ? invalidRows[0].querySelectorAll('td')[9] : null;
    check(text(statusCell).includes('时刻格式不合法：2502'),
        `非法行：状态列应显示首个错误，实际「${text(statusCell)}」`);
    check(panel.getState().invalidRows.length === 1 && panel.getState().invalidRows[0] === 3,
        `非法行：getState().invalidRows 应为 [3]，实际 ${JSON.stringify(panel.getState().invalidRows)}`);
}

/* ------------------------------------------------------------------ */
/* 3. 45 行 → 自动分 3 批串行提交（20 / 20 / 5），合起来不重不漏        */
/* ------------------------------------------------------------------ */

{
    const { panel, $, calls } = newPanel({ respond: okResponse });
    panel.setRows(makeTable(45));

    check($('import-confirm').disabled === false, '分批：45 行合法数据不应禁用上传（智能分批，行数不阻塞）');
    check($('import-confirm').hasAttribute('disabled') === false,
        '分批：合法数据时 disabled 属性必须被移除（否则 hcw-button 一直是灰的）');
    check(panel.getState().canUpload === true, '分批：getState().canUpload 应为 true');
    check(panel.getState().batchCount === 3, `分批：应计划 3 批，实际 ${panel.getState().batchCount}`);

    $('import-confirm').dispatch('click');
    await settle();

    const sizes = calls.map((call) => call.body.items.length);
    check(calls.length === 3, `分批：应调用 3 次，实际 ${calls.length}（${sizes.join('/')}）`);
    check(JSON.stringify(sizes) === JSON.stringify([20, 20, 5]), `分批：每批条数应为 20/20/5，实际 ${sizes.join('/')}`);

    const sentWays = calls.flatMap((call) => call.body.items.map((item) => item.way));
    check(sentWays.length === 45, `分批：三次 items 合计应 45 条，实际 ${sentWays.length}`);
    check(new Set(sentWays).size === 45, `分批：三次 items 不应重复，去重后 ${new Set(sentWays).size}`);
    const expected = Array.from({ length: 45 }, (_, i) => `测试${i + 1}路`);
    check(expected.every((way) => sentWays.includes(way)), '分批：三次 items 不应漏行');

    const first = calls[0];
    check(first.url === '/api/timetable-import-D1', `分批：URL 应为 /api/timetable-import-D1，实际 ${first.url}`);
    check(first.init.method === 'POST', `分批：method 应为 POST，实际 ${first.init.method}`);
    check(first.init.credentials === 'include', `分批：应带 credentials: include，实际 ${first.init.credentials}`);
    check(first.init.headers['Content-Type'] === 'application/json', '分批：Content-Type 应为 application/json');
    check(Object.keys(first.body).join(',') === 'items,writer,writetime',
        `分批：请求体应只有 items/writer/writetime，实际 ${Object.keys(first.body).join(',')}`);
    check(first.body.writer === '测试用户', `分批：writer 应为注入值，实际 ${first.body.writer}`);
    check(first.body.writetime === '2025-06-01', `分批：writetime 应为本地日期，实际 ${first.body.writetime}`);
    const keys = Object.keys(first.body.items[0]);
    check(keys.length === 8, `分批：每项应 8 个字段，实际 ${keys.length}`);
    check(!('row' in first.body.items[0]), '分批：items 不应带 row 字段');
    check(keys.join(',') === 'city,way,start,end,special,time1,time2,etime',
        `分批：字段名/顺序应逐字对齐后端契约，实际 ${keys.join(',')}`);
    // 真实抓到的第一段请求体，供报告引用
    check(typeof first.body.items[0].time1 === 'string' && first.body.items[0].time1.length > 0,
        '分批：time1 应已是入库格式');

    const result = text($('import-result'));
    check($('import-result').classList.contains('success'), `分批：结果卡应有 success 类，实际「${$('import-result').className}」`);
    check(result.includes('分 3 批写入 45 条时刻表'), `分批：成功文案异常「${result}」`);
    check(result.includes('第 2-21 行') && result.includes('第 42-46 行'), `分批：应列出每批行号范围，「${result}」`);
    check(panel.getState().total === 0, '分批：全部成功后应清空预览');
    console.log('  [证据] 45 行分批 → 每批 items.length =', sizes.join(' / '));
    console.log('  [证据] 第 1 批 items[0] =', JSON.stringify(first.body.items[0]));
}

/* ------------------------------------------------------------------ */
/* 4. 20 行及以下 → 单请求原子提交                                    */
/* ------------------------------------------------------------------ */

{
    const { panel, $, calls } = newPanel({ respond: okResponse });
    panel.setRows(makeTable(20));
    $('import-confirm').dispatch('click');
    await settle();

    check(calls.length === 1, `原子：20 行应只调用 1 次，实际 ${calls.length}`);
    check(calls[0].body.items.length === 20, `原子：单次 items 应为 20，实际 ${calls[0].body.items.length}`);
    check(text($('import-result')).includes('已写入 20 条时刻表'), `原子：成功文案异常「${text($('import-result'))}」`);

    // 1 行也走原子路径
    const single = newPanel({ respond: okResponse });
    single.panel.setRows(makeTable(1));
    single.$('import-confirm').dispatch('click');
    await settle();
    check(single.calls.length === 1 && single.calls[0].body.items.length === 1,
        `原子：1 行应 1 次调用 1 条，实际 ${single.calls.length} 次`);
}

/* ------------------------------------------------------------------ */
/* 4b. 城市列按城市库匹配：库外城市阻止上传，库内写法进请求体            */
/* ------------------------------------------------------------------ */

{
    // 库外城市 → 该行非法 → 整批阻止
    const badCity = newPanel({ respond: okResponse });
    badCity.panel.setRows([HEADER, dataRow(1, { city: '火星' })]);
    const badState = badCity.panel.getState();
    check(badState.errors === 1, `城市：库外城市应产出 1 处错误，实际 ${badState.errors}`);
    check(text(badCity.$('import-problems')).includes('城市库中找不到「火星」'),
        `城市：非法原因应写明城市库找不到，实际「${text(badCity.$('import-problems'))}」`);
    check(badCity.$('import-confirm').hasAttribute('disabled') === true, '城市：库外城市应禁用上传');

    badCity.$('import-confirm').dispatch('click');
    await settle();
    check(badCity.calls.length === 0, `城市：库外城市不得发起任何上传，实际 ${badCity.calls.length} 次`);

    // 库内简写 → 规范成库内写法后再提交
    const okCity = newPanel({ respond: okResponse });
    okCity.panel.setRows([
        HEADER,
        dataRow(1, { city: '无锡' }),
        dataRow(2, { city: '无锡/苏州' })
    ]);
    const okState = okCity.panel.getState();
    check(okState.errors === 0 && okState.records === 2,
        `城市：库内城市应全部通过，实际 合法 ${okState.records} / 错误 ${okState.errors}`);

    okCity.$('import-confirm').dispatch('click');
    await settle();
    check(okCity.calls.length === 1, `城市：应发起 1 次上传，实际 ${okCity.calls.length}`);
    check(okCity.calls[0].body.items[0].city === '江苏省 无锡市',
        `城市：请求体应带库内写法「江苏省 无锡市」，实际「${okCity.calls[0].body.items[0].city}」`);
    check(okCity.calls[0].body.items[1].city === '江苏省 无锡市/江苏省 苏州市',
        `城市：合营线路应逐段规范化，实际「${okCity.calls[0].body.items[1].city}」`);
}

/* ------------------------------------------------------------------ */
/* 4c. 表头认不出来 → 明确提示缺哪些列，并按列回显原始内容              */
/* ------------------------------------------------------------------ */

{
    const broken = newPanel({ respond: okResponse });
    // 第一行是英文表头（常见的「传错文件/表头写错」情形）
    broken.panel.setRows([
        ['City', 'Line', 'Start', 'End', 'Note', 'Out', 'Back', 'Date'],
        ['扬州市', '352路', '郭村客运站停车场', '韩阳村党群中心', '无', '700 1310', '740 1345', '2025.1.1']
    ]);

    const problems = text(broken.$('import-problems'));
    check(problems.includes('表头无法识别'), `表头：提示应写明「表头无法识别」，实际「${problems}」`);
    // 英文别名里 city/way/start/end 都能认，所以缺的是两个时刻列与执行时间
    check(problems.includes('副站→主站时刻表') && problems.includes('执行时间'),
        `表头：应点名缺少的列，实际「${problems}」`);
    check(problems.includes('当前第 1 行：City'), '表头：应回显第一行实际内容便于自查');
    check(broken.$('import-confirm').hasAttribute('disabled') === true, '表头：无法识别时应禁用上传');

    // 预览仍按标准列序回显原始内容，方便用户对照「缺哪些列」
    const preview = broken.$('import-preview');
    const previewText = text(preview);
    check(previewText.includes('扬州市') && previewText.includes('352路'),
        `表头：预览应按列回显原始内容，实际「${previewText.slice(0, 120)}」`);
    check(broken.panel.getState().errors === 1,
        `表头：应只报 1 处问题（不再是逐列「不能为空」），实际 ${broken.panel.getState().errors}`);

    broken.$('import-confirm').dispatch('click');
    await settle();
    check(broken.calls.length === 0, `表头：不得发起上传，实际 ${broken.calls.length} 次`);
}

/* ------------------------------------------------------------------ */
/* 5. 第 2 批 429 → 部分完成 + 断点续传不重发已成功批、不漏行          */
/* ------------------------------------------------------------------ */

{
    const { panel, $, calls } = newPanel({
        respond: (call) => {
            if (call.index === 2) {
                return {
                    ok: false,
                    status: 429,
                    json: async () => ({
                        success: false,
                        message: '请求过于频繁，请稍后再试',
                        error: 'rate_limited',
                        retryAfter: 42
                    })
                };
            }
            return okResponse(call);
        }
    });

    panel.setRows(makeTable(45));
    $('import-confirm').dispatch('click');
    await settle();

    check(calls.length === 2, `429：第 3 批不应发出，总调用应 2 次，实际 ${calls.length}`);
    let result = text($('import-result'));
    check(result.includes('部分完成'), `429：结果区应含「部分完成」，「${result}」`);
    check(result.includes('已写入 20 行'), `429：应报已写入 20 行，「${result}」`);
    check(result.includes('剩余 25 行未提交'), `429：应报剩余 25 行，` + `「${result}」`);
    check(result.includes('请在 42 秒后继续'), `429：应显示 retryAfter 秒数，「${result}」`);
    check(result.includes('第 22-41 行') && result.includes('未写入'), `429：应指出第 2 批未写入，「${result}」`);

    const continueBtn = $('import-continue');
    check(!continueBtn.classList.contains('hidden'), '429：应出现「继续提交剩余」按钮');
    check(text(continueBtn).includes('继续提交剩余'), `429：按钮文案异常「${text(continueBtn)}」`);
    check(panel.getState().run.cursor === 1, `429：游标应停在第 2 批（索引 1），实际 ${panel.getState().run.cursor}`);
    check($('import-confirm').disabled === true,
        '429：已有成功批次后「确认上传」应禁用（避免从头重发撞 409），只能走「继续提交剩余」');
    check($('import-confirm').hasAttribute('disabled') === true,
        '429：该禁用必须体现在 disabled 属性上');
    check(!$('import-continue').hasAttribute('disabled'),
        '429：可用的「继续提交剩余」不应带 disabled 属性（否则看着是灰的）');
    check(!$('import-clear').hasAttribute('disabled'),
        '429：非提交中，「清空」不应带 disabled 属性');

    // 续传：从第 2 批开始（429 的批并未写入，跳过会丢 20 行）
    const firstBatchWays = calls[0].body.items.map((item) => item.way);
    continueBtn.dispatch('click');
    await settle();

    const resumed = calls.slice(2);
    check(resumed.length === 2, `429 续传：应把第 2、3 批补齐（2 次调用），实际 ${resumed.length}`);
    check(resumed[0].body.items.length === 20, `429 续传：第 1 次续传应重发第 2 批 20 条，实际 ${resumed[0].body.items.length}`);
    check(resumed[1].body.items.length === 5, `429 续传：随后应发第 3 批 5 条，实际 ${resumed[1].body.items.length}`);
    const resumedWays = resumed.flatMap((call) => call.body.items.map((item) => item.way));
    check(resumedWays.every((way) => !firstBatchWays.includes(way)),
        '429 续传：不得重发第 1 批已写入的内容');
    check(new Set([...firstBatchWays, ...resumedWays]).size === 45, '429 续传：全部 45 行最终都提交过且不重复');

    result = text($('import-result'));
    check(result.includes('全部') === false && result.includes('导入成功'), `429 续传：补齐后应报成功，「${result}」`);
    check(result.includes('分 3 批写入 45 条时刻表'), `429 续传：最终成功文案异常，「${result}」`);
    check($('import-continue').classList.contains('hidden'), '429 续传：补完后应隐藏继续按钮');
    check(panel.getState().run === null && panel.getState().total === 0,
        '429 续传：补完后应清空预览与本次提交状态');
    console.log('  [证据] 429 续传 → 每次调用 items.length =',
        calls.map((call) => call.body.items.length).join(' / '));
}

/* ------------------------------------------------------------------ */
/* 6. 第 2 批 409 → 停止并如实说明「前 k-1 批已写入、第 k 批未写入」    */
/* ------------------------------------------------------------------ */

{
    const { panel, $, calls } = newPanel({
        respond: (call) => {
            if (call.index === 2) {
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({
                        success: false,
                        message: '部分时刻表已存在',
                        error: 'conflict',
                        errors: [
                            { row: 22, message: '该时刻表已存在' },
                            { row: 0, message: 'batch level' }
                        ]
                    })
                };
            }
            return okResponse(call);
        }
    });

    panel.setRows(makeTable(45));
    $('import-confirm').dispatch('click');
    await settle();

    check(calls.length === 2, `409：应停止后续批次（2 次调用），实际 ${calls.length}`);
    const result = text($('import-result'));
    check(result.includes('部分完成'), `409：应说明部分完成，「${result}」`);
    check(result.includes('前 1 批已写入'), `409：应说明前 k-1 批已写入，「${result}」`);
    check(result.includes('第 22-41 行'), `409：应指出失败批的行号范围，「${result}」`);
    check(result.includes('部分时刻表已存在'), `409：应带后端 message，「${result}」`);
    check(result.includes('第 22 行：该时刻表已存在'), `409：应带 errors 里的行号，「${result}」`);
    check(!result.includes('第 0 行'), '409：批级错误 row=0 不能被当成行号');
    check($('import-continue').classList.contains('hidden'), '409：非限流场景不提供继续按钮（需先修数据）');
    check($('import-result').classList.contains('error'), '409：结果卡应为 error 类');
    check(panel.getState().total === 45, '409：中止后预览应保留，便于用户修数据');
}

/* ------------------------------------------------------------------ */
/* 7. 未登录（getWriter 为空）→ 不发起上传请求                        */
/* ------------------------------------------------------------------ */

{
    const { panel, $, calls, notifyCalls } = newPanel({
        getWriter: async () => '',
        respond: okResponse
    });

    panel.setRows(makeTable(5));
    $('import-confirm').dispatch('click');
    await settle();

    check(calls.length === 0, `未登录：不应发起任何请求，实际 ${calls.length} 次`);
    check(notifyCalls.some((item) => item.msg === '请先登录' && item.isError === true),
        `未登录：应提示「请先登录」，实际 ${JSON.stringify(notifyCalls.map((i) => i.msg))}`);
}

/* ------------------------------------------------------------------ */
/* 8. 文件入口：普通对象（name + text）即可走通解析                     */
/* ------------------------------------------------------------------ */

{
    const { panel, $ } = newPanel();
    const csv = '\uFEFF' + HEADER.join(',') + '\n上海市,51路,火车站,汽车站,无,"0630,0700","0645,0715",2025.1.1\n';
    await panel.setFile({ name: '时刻表.csv', text: async () => csv });

    const state = panel.getState();
    check(state.fileName === '时刻表.csv', `文件：应记住文件名，实际「${state.fileName}」`);
    check(state.records === 1, `文件：应解析出 1 条合法记录，实际 ${state.records}`);
    check(rowsOf($('import-preview')).length === 1, `文件：预览应 1 行，实际 ${rowsOf($('import-preview')).length}`);

    // 解析失败要给中文文案（parseTableFile 的 message 已是中文）
    await panel.setFile({ name: '坏文件.pdf', arrayBuffer: async () => new Uint8Array([1, 2, 3, 0]).buffer });
    check(text($('import-result')).includes('解析失败'), `文件：失败应有「解析失败」，「${text($('import-result'))}」`);
    check(text($('import-result')).includes('不支持的文件类型'),
        `文件：应透出 parseTableFile 的中文原因，「${text($('import-result'))}」`);
}

/* ------------------------------------------------------------------ */
/* 9. 模板下载：不抛错、不残留临时 <a>                                */
/* ------------------------------------------------------------------ */

{
    const { doc, $, notifyCalls } = newPanel();
    let threw = null;
    try {
        $('import-template').dispatch('click');
    } catch (error) {
        threw = error;
    }
    check(threw === null, `模板：点击不应抛错，实际 ${threw && threw.message}`);
    const leftovers = doc.body.querySelectorAll('a').length;
    check(leftovers === 0, `模板：临时 <a> 应被移除，实际残留 ${leftovers}`);
    check(notifyCalls.some((item) => /模板/.test(item.msg)),
        `模板：应有提示，实际 ${JSON.stringify(notifyCalls.map((i) => i.msg))}`);
}

/* ------------------------------------------------------------------ */
/* 10. 按钮禁用态：hcw-button 的灰态只看宿主元素上的 disabled 属性     */
/*     （HcwButton 不代理 disabled，写 .disabled 既不改外观也不挡点击）  */
/* ------------------------------------------------------------------ */

{
    // ① 合法数据 → 属性必须被移除
    const valid = newPanel();
    valid.panel.setRows(makeTable(25));
    check(valid.$('import-confirm').hasAttribute('disabled') === false,
        '禁用态①：25 行合法数据后 #import-confirm 不应带 disabled 属性');
    check(valid.$('import-confirm').disabled === false,
        '禁用态①：expando .disabled 也应同步为 false（兼容旧读取路径）');
    check(valid.panel.getState().canUpload === true, '禁用态①：canUpload 应为 true');

    // ② 存在非法行 → 属性必须写上
    const invalid = newPanel();
    invalid.panel.setRows([HEADER, dataRow(1), dataRow(2, { time1: '2502' })]);
    check(invalid.$('import-confirm').hasAttribute('disabled') === true,
        '禁用态②：存在非法行时 #import-confirm 必须带 disabled 属性');
    check(invalid.panel.getState().canUpload === false, '禁用态②：canUpload 应为 false');

    // ③ 上传进行中（busy）→ 属性必须写上；抓 fetch 调用那一刻的真实 DOM 状态
    const busyFlags = [];
    let busyDoc = null;
    const busy = newPanel({
        respond: (call) => {
            const btn = busyDoc.getElementById('import-confirm');
            busyFlags.push({
                confirm: btn.hasAttribute('disabled'),
                clear: busyDoc.getElementById('import-clear').hasAttribute('disabled'),
                continueBtn: busyDoc.getElementById('import-continue').hasAttribute('disabled'),
                canUpload: null
            });
            return okResponse(call);
        }
    });
    busyDoc = busy.doc;
    busy.panel.setRows(makeTable(45));
    busy.$('import-confirm').dispatch('click');
    await settle();
    check(busyFlags.length === 3, `禁用态③：应抓到 3 次请求期间的按钮状态，实际 ${busyFlags.length}`);
    check(busyFlags.every((row) => row.confirm === true),
        `禁用态③：提交中 #import-confirm 必须带 disabled 属性，实际 ${JSON.stringify(busyFlags)}`);
    check(busyFlags.every((row) => row.clear === true),
        '禁用态③：提交中「清空」也应带 disabled 属性（防止中途清掉 state.run）');
    check(busyFlags.every((row) => row.continueBtn === true),
        `禁用态③：提交中「继续提交剩余」也应带 disabled 属性，实际 ${JSON.stringify(busyFlags)}`);

    // ④ 上传成功后（预览已清空、没有可上传数据）→ 属性必须写上
    check(busy.$('import-confirm').hasAttribute('disabled') === true,
        '禁用态④：上传成功后无数据，#import-confirm 必须带 disabled 属性');
    check(busy.panel.getState().canUpload === false, '禁用态④：成功后 canUpload 应为 false');
    check(busy.$('import-clear').hasAttribute('disabled') === false,
        '禁用态④：提交结束后「清空」应恢复可用（不带 disabled 属性）');

    // ⑤ 清空后仍无数据 → 仍禁用；重新喂数据 → 解除
    busy.$('import-clear').dispatch('click');
    await settle();
    check(busy.$('import-confirm').hasAttribute('disabled') === true,
        '禁用态⑤：清空后无数据仍应禁用');
    busy.panel.setRows(makeTable(3));
    check(busy.$('import-confirm').hasAttribute('disabled') === false,
        '禁用态⑤：重新载入合法数据后应解除禁用');
    console.log('  [证据] 提交中按钮属性 =', JSON.stringify(busyFlags[0]));
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

if (failures.length > 0) {
    console.error('FAIL ' + failures[0]);
    for (const item of failures.slice(1)) console.error('FAIL ' + item);
    console.error('FAILED ' + failures.length + '/' + checks);
    process.exit(1);
}

console.log('PASS ' + checks + '/' + checks);
process.exit(0);
