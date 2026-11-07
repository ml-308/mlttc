// tools/detail-table-test/run.mjs
// 时刻表详情页「网格表格」渲染的无浏览器测试：用最小 DOM 桩 + fetch 桩执行真实的
// lib/ui/timetable-detail.mjs，检查两个方向是否按「每行 6 个时刻」的表格渲染，
// 以及线路撤销 / 无班次两种说明文案是否保留。
//
// 用法：node tools/detail-table-test/run.mjs
import { createDOM } from '../nav-smoke-test/dom-stub.mjs';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 13 个时刻：06:00 06:30 … 12:00（6 + 6 + 1）
const TIMES_13 = Array.from({ length: 13 }, (_, i) =>
    `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`).join('\t');

const RECORD_NORMAL = {
    ID: 4242,
    CITY: '示例市',
    WAY: '客运班线',
    START: '主站',
    END: '副站',
    SPECIAL: '无',
    TIMEONE: TIMES_13,
    TIMETWO: 'Remove',
    STARTTIME: '2024-05-01',
    WRITER_NAME: '张三',
    WRITETIME: '2024-05-01 10:00',
};

const RECORD_EMPTY = { ...RECORD_NORMAL, TIMEONE: '', TIMETWO: 'unknown' };

const { doc } = createDOM(readFileSync(path.join(root, 'timetable-detail.html'), 'utf8'));

let payload = RECORD_NORMAL;
let fetchedUrl = '';
globalThis.window = {
    location: { pathname: '/timetable-detail.html', search: '?id=4242', href: '' },
    scrollTo() {},
};
globalThis.document = doc;
globalThis.fetch = async (url) => {
    fetchedUrl = String(url);
    return { ok: true, json: async () => ({ success: true, data: payload }) };
};

/** 让 fetch → json → 渲染 的微任务链结算 */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

const failures = [];
let checks = 0;

function check(ok, detail) {
    checks++;
    if (!ok) failures.push(detail);
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const tds = (row) => row.querySelectorAll('td');

const { createTimetableDetailPage } = await import(
    pathToFileURL(path.join(root, 'lib/ui/timetable-detail.mjs')).href);

const page = createTimetableDetailPage();
await settle();

// ── 运行 1：正常记录（TIMEONE 13 个时刻 / TIMETWO 为 'Remove'）──────────
const time1 = doc.getElementById('detail-time1');
const time2 = doc.getElementById('detail-time2');

check(fetchedUrl.includes('/api/timetable-D1?id=4242'), `fetch URL 异常: ${fetchedUrl}`);

const table1 = time1.querySelector('table.detail-time-table');
check(!!table1, '#detail-time1 内没有 table.detail-time-table');
check(!!time1.querySelector('.detail-time-table-wrap'), '#detail-time1 内没有 .detail-time-table-wrap');

const rows1 = time1.querySelectorAll('tbody tr');
check(rows1.length === 3, `#detail-time1 应有 3 行，实际 ${rows1.length} 行`);

if (rows1.length === 3) {
    check(tds(rows1[0]).length === 6, `第 1 行应有 6 个 td，实际 ${tds(rows1[0]).length}`);
    check(text(tds(rows1[0])[0]) === '06:00', `第 1 行首格应为 06:00，实际 ${text(tds(rows1[0])[0])}`);
    check(text(tds(rows1[0])[5]) === '08:30', `第 1 行末格应为 08:30，实际 ${text(tds(rows1[0])[5])}`);

    const lastCells = tds(rows1[2]);
    check(lastCells.length === 6, `最后一行应有 6 个 td，实际 ${lastCells.length}`);
    check(text(lastCells[0]) === '12:00', `最后一行首格应为 12:00，实际 ${text(lastCells[0])}`);
    for (let i = 1; i < 6; i++) {
        check(lastCells[i].classList.contains('is-empty'),
            `最后一行第 ${i + 1} 格应带 is-empty，class="${lastCells[i].className}"`);
        check(text(lastCells[i]) === '', `最后一行第 ${i + 1} 格应为空内容，实际 "${text(lastCells[i])}"`);
    }
}

// TIMETWO = 'Remove'
check(text(time2).includes('线路已撤销'), `#detail-time2 应显示「线路已撤销」，实际 "${text(time2)}"`);
check(time2.querySelectorAll('tbody tr').length === 1, '#detail-time2 撤销态应为单行');
const emptyCell = time2.querySelector('td.detail-time-empty');
check(!!emptyCell, '#detail-time2 撤销态缺少 td.detail-time-empty');
check(emptyCell?.getAttribute('colspan') === '6', `撤销态 colspan 应为 6，实际 ${emptyCell?.getAttribute('colspan')}`);
check(!!time2.querySelector('table.detail-time-table'), '#detail-time2 撤销态应仍是一张表格');

// 全站不再有旧 chip；渲染结果不含内联样式
check(doc.querySelectorAll('.detail-time-chip').length === 0,
    `不应再出现 .detail-time-chip，实际 ${doc.querySelectorAll('.detail-time-chip').length} 个`);
for (const [name, el] of [['#detail-time1', time1], ['#detail-time2', time2]]) {
    check(!/style\s*=/.test(el.innerHTML), `${name} 的渲染结果不应包含内联 style`);
}

// 既有字段未被破坏
check(text(doc.getElementById('detail-title')).includes('示例市')
    && text(doc.getElementById('detail-title')).includes('客运班线'),
    `#detail-title 填充异常: "${text(doc.getElementById('detail-title'))}"`);
check(text(doc.getElementById('detail-id')) === '#4242', `#detail-id 填充异常: "${text(doc.getElementById('detail-id'))}"`);
check(text(doc.getElementById('detail-city')) === '示例市', `#detail-city 填充异常: "${text(doc.getElementById('detail-city'))}"`);
check(text(doc.getElementById('detail-way')) === '客运班线', `#detail-way 填充异常: "${text(doc.getElementById('detail-way'))}"`);
check(text(doc.getElementById('detail-writer')) === '张三', `#detail-writer 填充异常: "${text(doc.getElementById('detail-writer'))}"`);
check(text(doc.getElementById('detail-starttime')) === '2024-05-01', `#detail-starttime 填充异常: "${text(doc.getElementById('detail-starttime'))}"`);
check(typeof page.load === 'function', 'createTimetableDetailPage 应返回 { load }');

// ── 运行 2：空串 / 'unknown' 走说明文案 ──────────────────────────────
payload = RECORD_EMPTY;
await page.load();
await settle();

for (const [name, el] of [['#detail-time1', time1], ['#detail-time2', time2]]) {
    check(text(el).includes('未填写或无发车班次'), `${name} 空态应显示「未填写或无发车班次」，实际 "${text(el)}"`);
    check(el.querySelectorAll('tbody tr').length === 1, `${name} 空态应为单行`);
    check(!!el.querySelector('td.detail-time-empty'), `${name} 空态缺少 td.detail-time-empty`);
    check(el.querySelectorAll('.detail-time-chip').length === 0, `${name} 空态不应出现 chip`);
}

// ── 结果 ─────────────────────────────────────────────────────────────
if (failures.length === 0) {
    console.log(`PASS ${checks}/${checks}`);
    process.exit(0);
}

console.log(`FAIL ${failures.length}/${checks}`);
console.log(`首个失败: ${failures[0]}`);
process.exit(1);
