// tools/import-test/run.mjs
/**
 * lib/timetable-import.mjs 的 node 单测（零依赖，不需打包）
 *
 * 用法：node tools/import-test/run.mjs
 * 全部通过打印 PASS n/n 并以 0 退出；任一断言失败打印失败详情并以非 0 退出。
 * XLSX 夹具由 make-fixtures.mjs 现场手写生成并写到系统临时目录，跑完删除。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as tables from '../../lib/timetable-import.mjs';
import {
    parseCsv, parseXlsx, parseTableFile, HEADER_ALIASES, mapHeader,
    normalizeTimeList, validateRows, paginate, TEMPLATE_CSV, buildImportBody
} from '../../lib/timetable-import.mjs';
import { HEADER, SAMPLE_ROWS, OTHER_ROWS, buildXlsx, toCsv, writeTempFixture } from './make-fixtures.mjs';

let total = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
    total += 1;
    try {
        fn();
    } catch (err) {
        failed += 1;
        failures.push([name, err]);
    }
}

async function checkAsync(name, fn) {
    total += 1;
    try {
        await fn();
    } catch (err) {
        failed += 1;
        failures.push([name, err]);
    }
}

const toArrayBuffer = (buffer) => buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
);

const fieldErrors = (errors, row, field) =>
    errors.filter((item) => item.row === row && item.field === field);

async function main() {
    /* ---------------- 导出面 ---------------- */
    const REQUIRED = {
        parseCsv: 'function',
        parseXlsx: 'function',
        parseTableFile: 'function',
        HEADER_ALIASES: 'object',
        mapHeader: 'function',
        normalizeTimeList: 'function',
        validateRows: 'function',
        paginate: 'function',
        TEMPLATE_CSV: 'string',
        buildImportBody: 'function'
    };

    check('10 个导出名逐字存在且类型正确', () => {
        for (const [name, type] of Object.entries(REQUIRED)) {
            assert.equal(typeof tables[name], type, name + ' 应为 ' + type);
        }
    });

    check('模块源码不含 document / window（node 可直接 import）', () => {
        const source = readFileSync(
            fileURLToPath(new URL('../../lib/timetable-import.mjs', import.meta.url)),
            'utf8'
        );
        assert.equal(/\bdocument\b/.test(source), false, '出现 document');
        assert.equal(/\bwindow\b/.test(source), false, '出现 window');
    });

    check('HEADER_ALIASES 含指定的中文别名', () => {
        assert.ok(HEADER_ALIASES.way.includes('线路'));
        assert.ok(HEADER_ALIASES.way.includes('线路名称'));
        assert.ok(HEADER_ALIASES.start.includes('起点站'));
        assert.ok(HEADER_ALIASES.start.includes('出发站'));
        assert.ok(HEADER_ALIASES.start.includes('主站'));
        assert.ok(HEADER_ALIASES.time1.includes('主站→副站时刻表'));
        assert.ok(HEADER_ALIASES.time1.includes('外环'));
        assert.ok(HEADER_ALIASES.time1.includes('主站到副站时刻表'));
        assert.deepEqual(
            Object.keys(HEADER_ALIASES).sort(),
            ['city', 'end', 'etime', 'special', 'start', 'time1', 'time2', 'way']
        );
    });

    /* ---------------- CSV ---------------- */
    check('CSV：引号内含逗号', () => {
        assert.deepEqual(parseCsv('a,"b,c",d'), [['a', 'b,c', 'd']]);
    });

    check('CSV：引号内含换行', () => {
        assert.deepEqual(parseCsv('"a\nb",c\n1,2'), [['a\nb', 'c'], ['1', '2']]);
    });

    check('CSV："" 转义双引号', () => {
        assert.deepEqual(parseCsv('"他说""你好""",x'), [['他说"你好"', 'x']]);
    });

    check('CSV：剥掉 UTF-8 BOM', () => {
        const rows = parseCsv('\uFEFF城市,线路\n上海市,52路');
        assert.equal(rows[0][0], '城市');
        assert.deepEqual(rows[1], ['上海市', '52路']);
    });

    check('CSV：CRLF 与孤立 CR 都按行切分', () => {
        assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
        assert.deepEqual(parseCsv('a,b\rc,d'), [['a', 'b'], ['c', 'd']]);
    });

    check('CSV：尾部空行与空列行被丢弃', () => {
        assert.deepEqual(parseCsv('a,b\n1,2\n\n,,\n'), [['a', 'b'], ['1', '2']]);
    });

    check('CSV：分号分隔自动识别', () => {
        assert.deepEqual(parseCsv('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
    });

    check('CSV：制表符分隔自动识别（TSV）', () => {
        assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
    });

    check('CSV：引号内的分号不参与分隔符判定', () => {
        assert.deepEqual(parseCsv('a,b\n"1;2",3'), [['a', 'b'], ['1;2', '3']]);
    });

    check('CSV：空文本返回空数组', () => {
        assert.deepEqual(parseCsv(''), []);
        assert.deepEqual(parseCsv('   \n\n'), []);
        assert.deepEqual(parseCsv(null), []);
    });

    check('CSV：单行无分隔符', () => {
        assert.deepEqual(parseCsv('只有一列'), [['只有一列']]);
    });

    /* ---------------- XLSX ---------------- */
    const csvText = toCsv(SAMPLE_ROWS);
    const xlsxBuffer = buildXlsx({
        sheets: [{ name: '时刻表', rows: SAMPLE_ROWS }],
        storedNames: ['xl/sharedStrings.xml'] // 共享串用 stored(0)，工作表用 deflate(8)
    });

    await checkAsync('XLSX：解析结果与同一份 CSV 完全等价', async () => {
        const fromCsv = parseCsv(csvText);
        const fromXlsx = await parseXlsx(xlsxBuffer);
        const fromXlsxArrayBuffer = await parseXlsx(toArrayBuffer(xlsxBuffer));
        assert.deepEqual(fromCsv, SAMPLE_ROWS);
        assert.deepEqual(fromXlsx, fromCsv);
        assert.deepEqual(fromXlsxArrayBuffer, fromCsv);
    });

    await checkAsync('XLSX：stored(0) 与 deflate(8) 两种压缩方式都能读', async () => {
        const storedAll = buildXlsx({
            sheets: [{ name: '时刻表', rows: SAMPLE_ROWS }],
            storedNames: [
                'xl/sharedStrings.xml',
                'xl/worksheets/sheet1.xml',
                'xl/workbook.xml',
                'xl/_rels/workbook.xml.rels'
            ]
        });
        assert.deepEqual(await parseXlsx(storedAll), SAMPLE_ROWS);
    });

    await checkAsync('XLSX：只取 workbook.xml 里的第一个工作表（不是文件名 sheet1.xml）', async () => {
        const ordered = buildXlsx({
            sheets: [
                { name: '时刻表', rows: SAMPLE_ROWS, file: 'sheet2.xml' },
                { name: '附表', rows: OTHER_ROWS, file: 'sheet1.xml' }
            ]
        });
        assert.deepEqual(await parseXlsx(ordered), SAMPLE_ROWS);
    });

    await checkAsync('XLSX：inlineStr / 数字 / 缺省单元格的列对齐', async () => {
        const typed = buildXlsx({
            sheets: [{
                name: '类型',
                rows: [
                    HEADER,
                    ['上海市', { inline: '52' }, '火车站', '汽车站', { omit: true },
                        '0630', '0645', '2025.1.1'],
                    ['北京市', 'B12', '苹果园', { num: 700 }, '仅工作日',
                        '0630', '0645', '2025.12.31']
                ]
            }]
        });
        const rows = await parseXlsx(typed);
        assert.deepEqual(rows[1], ['上海市', '52', '火车站', '汽车站', '', '0630', '0645', '2025.1.1']);
        assert.deepEqual(rows[2], ['北京市', 'B12', '苹果园', '700', '仅工作日', '0630', '0645', '2025.12.31']);
    });

    await checkAsync('XLSX：非 ZIP 内容报错', async () => {
        await assert.rejects(() => parseXlsx(new Uint8Array([1, 2, 3, 4])), /不是有效的 XLSX/);
    });

    /* ---------------- 临时文件 + parseTableFile ---------------- */
    const dir = mkdtempSync(path.join(tmpdir(), 'mlttc-import-test-'));
    try {
        const csvPath = writeTempFixture(dir, '时刻表.csv', '\uFEFF' + csvText);
        const xlsxPath = writeTempFixture(dir, '时刻表.xlsx', xlsxBuffer);

        await checkAsync('夹具：CSV 与 XLSX 写到临时目录后可读回', async () => {
            assert.ok(readFileSync(csvPath).length > 0);
            assert.ok(readFileSync(xlsxPath).length > 0);
        });

        await checkAsync('parseTableFile：按 .csv 走文本、按 .xlsx 走字节', async () => {
            const byText = await parseTableFile({
                name: '表格.csv',
                text: async () => csvText
            });
            const byBytes = await parseTableFile({
                name: '表格.xlsx',
                arrayBuffer: async () => toArrayBuffer(xlsxBuffer)
            });
            assert.deepEqual(byText, SAMPLE_ROWS);
            assert.deepEqual(byBytes, SAMPLE_ROWS);
        });

        await checkAsync('parseTableFile：扩展名错但魔数是 ZIP 时按 XLSX 处理', async () => {
            const rows = await parseTableFile({
                name: '其实是表格.csv',
                arrayBuffer: async () => toArrayBuffer(xlsxBuffer)
            });
            assert.deepEqual(rows, SAMPLE_ROWS);
        });

        await checkAsync('parseTableFile：.xlsx 扩展名但内容不是 ZIP 时明确报错', async () => {
            await assert.rejects(
                () => parseTableFile({
                    name: '坏文件.xlsx',
                    arrayBuffer: async () => toArrayBuffer(Buffer.from('城市,线路\n', 'utf8'))
                }),
                /不是有效的 XLSX/
            );
        });

        await checkAsync('parseTableFile：二进制且非 XLSX 的文件被拒绝', async () => {
            await assert.rejects(
                () => parseTableFile({
                    name: '文档.pdf',
                    arrayBuffer: async () => toArrayBuffer(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))
                }),
                /不支持的文件类型/
            );
        });

        await checkAsync('parseTableFile：只有 text() 的对象也能读', async () => {
            const rows = await parseTableFile({ name: 'x', text: async () => 'a,b\n1,2' });
            assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    /* ---------------- 表头映射 ---------------- */
    check('mapHeader：标准中文表头全部命中', () => {
        const { indices, missing } = mapHeader(HEADER);
        assert.deepEqual(missing, []);
        assert.deepEqual(indices, {
            city: 0, way: 1, start: 2, end: 3, special: 4, time1: 5, time2: 6, etime: 7
        });
    });

    check('mapHeader：别名命中（线路名称/出发站/外环/内环/执行日期）', () => {
        const { indices, missing } = mapHeader(
            ['线路名称', '城市', '出发站', '终点站', '外环', '内环', '执行日期']
        );
        assert.deepEqual(missing, ['特殊情况']);
        assert.equal(indices.way, 0);
        assert.equal(indices.city, 1);
        assert.equal(indices.start, 2);
        assert.equal(indices.end, 3);
        assert.equal(indices.special, -1);
        assert.equal(indices.time1, 4);
        assert.equal(indices.time2, 5);
        assert.equal(indices.etime, 6);
    });

    check('mapHeader：全角/空格/箭头写法/英文大小写归一化', () => {
        const { indices, missing } = mapHeader([
            ' CITY ', '线路', '主站 → 副站时刻表', '副站→主站时刻表',
            '起点站', '终点站', '执行时间'
        ]);
        assert.deepEqual(missing, ['特殊情况']);
        assert.equal(indices.city, 0);
        assert.equal(indices.time1, 2);
        assert.equal(indices.time2, 3);

        const fullWidth = mapHeader(['ｃｉｔｙ', '线路', '主站 -> 副站时刻表']);
        assert.equal(fullWidth.indices.city, 0);
        assert.equal(fullWidth.indices.time1, 2);
    });

    check('mapHeader：缺列时 missing 给出中文字段名', () => {
        const { indices, missing } = mapHeader(['城市', '线路']);
        assert.deepEqual(missing, [
            '起点站', '终点站', '特殊情况', '主站→副站时刻表', '副站→主站时刻表', '执行时间'
        ]);
        assert.equal(indices.etime, -1);
        assert.equal(indices.city, 0);
    });

    check('mapHeader：空表头不抛异常', () => {
        const { indices, missing } = mapHeader([]);
        assert.equal(indices.city, -1);
        assert.equal(missing.length, 8);
        assert.deepEqual(mapHeader(undefined).missing.length, 8);
    });

    /* ---------------- normalizeTimeList ---------------- */
    check('normalizeTimeList：06:30 / 6:30 / 630 / 600', () => {
        assert.equal(normalizeTimeList('06:30'), '0630');
        assert.equal(normalizeTimeList('6:30'), '0630');
        assert.equal(normalizeTimeList('630'), '0630');
        assert.equal(normalizeTimeList('600'), '0600');
    });

    check('normalizeTimeList：换行/逗号/顿号/分号/空白混排', () => {
        assert.equal(
            normalizeTimeList('0630\n0700,0730、0745 0800;0900；0930'),
            '0630 0700 0730 0745 0800 0900 0930'
        );
        assert.equal(normalizeTimeList('0630 0700'), '0630 0700');
    });

    check('normalizeTimeList：非法 token 原样保留', () => {
        assert.equal(normalizeTimeList('0630 6:5'), '0630 6:5');
        assert.equal(normalizeTimeList('0630 25:00'), '0630 2500');
        assert.equal(normalizeTimeList('2500'), '2500');
        assert.equal(normalizeTimeList('0630:0700'), '0630 0700');
    });

    check('normalizeTimeList：空输入与全角数字', () => {
        assert.equal(normalizeTimeList(''), '');
        assert.equal(normalizeTimeList('  \n '), '');
        assert.equal(normalizeTimeList(null), '');
        assert.equal(normalizeTimeList(undefined), '');
        assert.equal(normalizeTimeList('０６３０'), '0630');
        assert.equal(normalizeTimeList('0630：0700'), '0630 0700');
    });

    /* ---------------- validateRows ---------------- */
    check('validateRows：正常行补后缀并生成入库格式', () => {
        const { records, errors } = validateRows(parseCsv(csvText));
        assert.deepEqual(errors, []);
        assert.equal(records.length, 3);
        assert.deepEqual(records[0], {
            row: 2,
            city: '上海市',
            way: '52路',
            start: '火车站',
            end: '汽车站',
            special: '无',
            time1: '06:30\t07:00\t',
            time2: '06:45\t07:15\t',
            etime: '2025-1-1'
        });
        assert.equal(records[1].row, 3);
        assert.equal(records[1].way, '地铁1号线');
        assert.equal(records[1].special, '');
        assert.equal(records[1].etime, '2025-12-31');
        assert.equal(records[2].row, 4);
        assert.equal(records[2].time1, '06:30\t07:00\t07:30\t08:00\t08:30\t\n09:00\t');
        assert.equal(records[2].time2, '06:40\t07:20\t08:00\t');
        assert.equal(records[2].etime, '2025-6-1');
    });

    check('validateRows：城市/站点补后缀，数字线路补「路」', () => {
        const rows = [HEADER, ['广州', '52', '火车东', '汽车', '', '0630', '0645', '2025.1.1']];
        const { records } = validateRows(rows);
        assert.equal(records[0].city, '广州市');
        assert.equal(records[0].way, '52路');
        assert.equal(records[0].start, '火车东站');
        assert.equal(records[0].end, '汽车站');
    });

    check('validateRows：2500 → unknown，2501 → Remove', () => {
        const rows = [
            HEADER,
            ['上海市', '52', '火车站', '汽车站', '', '2500', '2501', '2025.1.1'],
            ['上海市', '52', '火车站', '汽车站', '', '2501', '2500', '2025.1.1']
        ];
        const { records, errors } = validateRows(rows);
        assert.deepEqual(errors, []);
        assert.equal(records[0].time1, 'unknown');
        assert.equal(records[0].time2, 'Remove');
        assert.equal(records[1].time1, 'Remove');
        assert.equal(records[1].time2, 'unknown');
    });

    check('validateRows：时刻排序（700/630 反序输入）', () => {
        const rows = [HEADER, ['上海市', '52', '火车站', '汽车站', '', '0700 0630', '0645', '2025.1.1']];
        const { records } = validateRows(rows);
        assert.equal(records[0].time1, '06:30\t07:00\t');
    });

    check('validateRows：非法时刻产生带行号的 error', () => {
        const rows = [
            HEADER,
            ['上海市', '52', '火车站', '汽车站', '', '0630', '0645', '2025.1.1'],
            ['上海市', '52', '火车站', '汽车站', '', '2502', '0680', '2025.1.1'],
            ['上海市', '52', '火车站', '汽车站', '', '0630 2500', '0645', '2025.1.1'],
            ['上海市', '52', '火车站', '汽车站', '', '0630 6:5', '0645', '2025.1.1']
        ];
        const { records, errors } = validateRows(rows);
        assert.equal(records.length, 1);
        assert.equal(records[0].row, 2);

        const time1Row3 = fieldErrors(errors, 3, 'time1');
        assert.equal(time1Row3.length, 1);
        assert.equal(time1Row3[0].message, '时刻格式不合法：2502');

        const time2Row3 = fieldErrors(errors, 3, 'time2');
        assert.equal(time2Row3.length, 1);
        assert.equal(time2Row3[0].message, '时刻格式不合法：0680');

        assert.equal(fieldErrors(errors, 4, 'time1')[0].message, '时刻格式不合法：2500');
        assert.equal(fieldErrors(errors, 5, 'time1')[0].message, '时刻格式不合法：6:5');
    });

    check('validateRows：非法/缺失执行时间产生带行号的 error', () => {
        const rows = [
            HEADER,
            ['上海市', '52', '火车站', '汽车站', '', '0630', '0645', ''],
            ['上海市', '52', '火车站', '汽车站', '', '0630', '0645', '2025.13.1'],
            ['上海市', '52', '火车站', '汽车站', '', '0630', '0645', '2025-12-31'],
            ['上海市', '52', '火车站', '汽车站', '', '0630', '0645', '25.6.1']
        ];
        const { records, errors } = validateRows(rows);
        assert.equal(fieldErrors(errors, 2, 'etime')[0].message, '执行时间不能为空');
        assert.equal(fieldErrors(errors, 3, 'etime')[0].message, '执行时间格式不合法：2025.13.1');
        assert.equal(records.length, 2);
        assert.equal(records[0].row, 4);
        assert.equal(records[0].etime, '2025-12-31');
        assert.equal(records[1].etime, '2025-6-1');
    });

    check('validateRows：必填缺失时逐字段报错', () => {
        const rows = [
            HEADER,
            ['', '', '', '', '', '', '', ''],
            ['上海市', '52', '火车站', '汽车站', '', '0630', '0645', '2025.1.1']
        ];
        const { records, errors } = validateRows(rows);
        assert.equal(records.length, 1, '整行皆空的行应被跳过');
        assert.equal(records[0].row, 3);
        assert.deepEqual(errors, [], '整行皆空的行不应产生 error');

        const badRow = [HEADER, ['', '', '', '', '', '', '', '2025.1.1']];
        const bad = validateRows(badRow);
        const byField = (field) => bad.errors.filter((item) => item.field === field)[0];
        assert.equal(byField('city').message, '城市不能为空');
        assert.equal(byField('way').message, '线路不能为空');
        assert.equal(byField('start').message, '起点站不能为空');
        assert.equal(byField('end').message, '终点站不能为空');
        assert.equal(byField('time1').message, '主站→副站时刻表不能为空');
        assert.equal(byField('time2').message, '副站→主站时刻表不能为空');
        assert.equal(bad.records.length, 0, '有错的行不应进入 records');
    });

    check('validateRows：缺列时按缺列报错（indices 为 -1）', () => {
        const rows = [['城市', '线路'], ['上海市', '52']];
        const { records, errors } = validateRows(rows);
        assert.equal(records.length, 0);
        assert.ok(errors.some((item) => item.field === 'etime'));
        assert.ok(errors.some((item) => item.field === 'time1'));
    });

    check('validateRows：空表 / 只有表头', () => {
        assert.deepEqual(validateRows([]), { records: [], errors: [] });
        assert.deepEqual(validateRows([HEADER]), { records: [], errors: [] });
    });

    check('TEMPLATE_CSV：自带一行示例且能零错误走完校验', () => {
        const rows = parseCsv(TEMPLATE_CSV);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[0], HEADER);
        const { records, errors } = validateRows(rows);
        assert.deepEqual(errors, []);
        assert.equal(records.length, 1);
        assert.equal(records[0].city, '上海市');
        assert.equal(records[0].way, '52路');
        assert.equal(records[0].time1, '06:30\t07:00\t07:30\t');
        assert.equal(records[0].etime, '2025-01-01');
    });

    /* ---------------- paginate ---------------- */
    const items = Array.from({ length: 45 }, (_, i) => ({ id: i + 1 }));

    check('paginate：首页', () => {
        const page = paginate(items, 1, 20);
        assert.equal(page.page, 1);
        assert.equal(page.totalPages, 3);
        assert.equal(page.total, 45);
        assert.equal(page.items.length, 20);
        assert.equal(page.items[0].id, 1);
    });

    check('paginate：末页', () => {
        const page = paginate(items, 3, 20);
        assert.equal(page.page, 3);
        assert.equal(page.items.length, 5);
        assert.equal(page.items[4].id, 45);
    });

    check('paginate：越界页夹紧到末页', () => {
        const page = paginate(items, 99, 20);
        assert.equal(page.page, 3);
        assert.equal(page.items.length, 5);
        assert.equal(paginate(items, 0, 20).page, 1);
        assert.equal(paginate(items, -7, 20).page, 1);
        assert.equal(paginate(items, 'x', 20).page, 1);
    });

    check('paginate：空列表（totalPages 取 0）', () => {
        const page = paginate([], 1, 20);
        assert.deepEqual(page.items, []);
        assert.equal(page.page, 1);
        assert.equal(page.totalPages, 0);
        assert.equal(page.total, 0);
    });

    check('paginate：pageSize 非法时有兜底', () => {
        assert.equal(paginate(items, 1, 0).items.length, 1);
        assert.equal(paginate(items, 1, undefined).items.length, 1);
        assert.equal(paginate(items, 1, 100).totalPages, 1);
    });

    /* ---------------- buildImportBody ---------------- */
    check('buildImportBody：items 不含 row，writer/writetime 透传', () => {
        const { records } = validateRows(parseCsv(csvText));
        const body = buildImportBody(records, '张三', '2025-06-01');
        assert.deepEqual(Object.keys(body), ['items', 'writer', 'writetime']);
        assert.equal(body.writer, '张三');
        assert.equal(body.writetime, '2025-06-01');
        assert.equal(body.items.length, 3);
        assert.equal('row' in body.items[0], false, 'items 不应带 row');
        assert.deepEqual(Object.keys(body.items[0]), [
            'city', 'way', 'start', 'end', 'special', 'time1', 'time2', 'etime'
        ]);
        assert.equal(body.items[0].city, '上海市');
        assert.equal(JSON.parse(JSON.stringify(body)).items.length, 3);
    });

    check('buildImportBody：空输入安全', () => {
        assert.deepEqual(buildImportBody([], 'a', 'b'), { items: [], writer: 'a', writetime: 'b' });
        assert.deepEqual(buildImportBody(null, 'a', 'b').items, []);
    });
}

await main();

if (failed > 0) {
    for (const [name, err] of failures) {
        console.error('FAIL ' + name);
        console.error('     ' + String((err && err.message) || err).split('\n').slice(0, 8).join('\n     '));
    }
    console.error('FAILED ' + failed + '/' + total);
    process.exit(1);
}

console.log('PASS ' + total + '/' + total);
process.exit(0);
