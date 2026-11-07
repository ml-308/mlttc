// tools/import-test/make-fixtures.mjs
/**
 * 单测夹具生成器：现场手写一个最小 XLSX（ZIP 容器自己拼，deflate 用 zlib）
 *
 * 只在测试进程内生成、写到系统临时目录，仓库里不提交任何二进制夹具。
 * 单元格支持三种写法（都用于覆盖解析分支）：
 *   '文本'            → 共享字符串（t="s"）
 *   { num: 700 }      → 数字单元格（<v>700</v>）
 *   { inline: '文本' } → 内联字符串（t="inlineStr"）
 *   { omit: true }    → 该单元格完全不出现在 XML 里（测试列引用补空）
 */

import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** 标准表头（与 HEADER_ALIASES 对齐） */
export const HEADER = [
    '城市', '线路', '起点站', '终点站', '特殊情况',
    '主站→副站时刻表', '副站→主站时刻表', '执行时间'
];

/** CSV 与 XLSX 共用的规范数据（用于「两种读取方式结果等价」的断言） */
export const SAMPLE_ROWS = [
    HEADER,
    ['上海市', '52', '火车站', '汽车站', '无', '0630 0700', '0645 0715', '2025.1.1'],
    ['北京市', '地铁1号线', '苹果园', '四惠东', '', '2500', '2501', '2025.12.31'],
    ['广州市', 'B12', '天河客运站', '体育西路', '仅工作日',
        '0630,0700,0730,0800,0830,0900', '0640、0720、0800', '25.6.1']
];

/** 另一份数据，用于证明「只取第一个工作表」时取到的是正确的那张 */
export const OTHER_ROWS = [
    ['城市', '线路', '起点站', '终点站', '特殊情况', '主站→副站时刻表', '副站→主站时刻表', '执行时间'],
    ['假城市', '99', '假起点', '假终点', '', '0000', '0000', '2000.1.1']
];

function crc32(buffer) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

/**
 * 拼一个最小 ZIP
 *
 * @param {Array<{name: string, data: string|Buffer, method?: 0|8}>} files 条目
 * @returns {Buffer}
 */
export function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = Buffer.from(file.name, 'utf8');
        const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
        const method = file.method === 0 ? 0 : 8;
        const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // 文件名为 UTF-8
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12); // 1980-01-01
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBytes, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + data.length;
    }

    const centralDirectory = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([Buffer.concat(locals), centralDirectory, eocd]);
}

function columnName(index) {
    let name = '';
    let n = index + 1;
    while (n > 0) {
        const rest = (n - 1) % 26;
        name = String.fromCharCode(65 + rest) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function escapeXml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function collectStrings(sheets, sink) {
    for (const sheet of sheets) {
        for (const row of sheet.rows) {
            for (const cell of row) {
                if (cell === undefined || cell === null) continue;
                if (typeof cell === 'object') continue;
                const text = String(cell);
                if (!sink.includes(text)) sink.push(text);
            }
        }
    }
    return sink;
}

function buildSheetXml(rows, sharedStrings) {
    const lines = [];
    rows.forEach((row, rowIndex) => {
        const cells = [];
        row.forEach((cell, colIndex) => {
            if (cell === undefined || cell === null) return;
            if (typeof cell === 'object' && cell.omit) return;
            const ref = columnName(colIndex) + (rowIndex + 1);
            if (typeof cell === 'object' && 'num' in cell) {
                cells.push('<c r="' + ref + '" s="1"><v>' + cell.num + '</v></c>');
                return;
            }
            if (typeof cell === 'object' && 'inline' in cell) {
                cells.push(
                    '<c r="' + ref + '" s="1" t="inlineStr"><is><t>' +
                    escapeXml(cell.inline) + '</t></is></c>'
                );
                return;
            }
            const index = sharedStrings.indexOf(String(cell));
            cells.push('<c r="' + ref + '" s="1" t="s"><v>' + index + '</v></c>');
        });
        // 真实文件还会带 spans / customFormat 等属性，一并模拟以验证属性容错
        lines.push('<row r="' + (rowIndex + 1) + '" spans="1:' + Math.max(row.length, 1) + '">' +
            cells.join('') + '</row>');
    });

    const lastColumn = columnName(Math.max(...rows.map((row) => row.length), 1) - 1);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<dimension ref="A1:' + lastColumn + rows.length + '"/>' +
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="14.25"/>' +
        '<cols><col min="1" max="' + Math.max(lastColumn.charCodeAt(0) - 64, 1) +
        '" width="18.5" customWidth="1"/></cols>' +
        '<sheetData>' + lines.join('') + '</sheetData></worksheet>';
}

/**
 * 生成一个最小可解析的 XLSX
 *
 * @param {{sheets: Array<{name: string, rows: Array<Array>, file?: string}>,
 *          storedNames?: string[]}} spec
 *        sheets 的数组顺序即 workbook.xml 中 <sheet> 的顺序（第一个即「第一个工作表」）；
 *        file 可指定该表落在哪个 XML 文件名下；storedNames 里的条目用 stored(0) 存放
 * @returns {Buffer}
 */
export function buildXlsx(spec) {
    const sheets = spec.sheets;
    const sharedStrings = collectStrings(sheets, []);
    const stored = new Set(spec.storedNames || []);

    const files = [
        {
            name: '[Content_Types].xml',
            data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                '<Default Extension="xml" ContentType="application/xml"/>' +
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
                '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
                '</Types>'
        },
        {
            name: '_rels/.rels',
            data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
                '</Relationships>'
        },
        {
            name: 'xl/workbook.xml',
            data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
                '<sheets>' +
                sheets.map((sheet, index) => '<sheet name="' + escapeXml(sheet.name) +
                    '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>').join('') +
                '</sheets></workbook>'
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                sheets.map((sheet, index) => '<Relationship Id="rId' + (index + 1) +
                    '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
                    'Target="worksheets/' + (sheet.file || ('sheet' + (index + 1) + '.xml')) + '"/>').join('') +
                '</Relationships>'
        },
        {
            name: 'xl/sharedStrings.xml',
            data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
                'count="' + sharedStrings.length + '" uniqueCount="' + sharedStrings.length + '">' +
                sharedStrings.map((text) => '<si><t xml:space="preserve">' +
                    escapeXml(text) + '</t></si>').join('') +
                '</sst>'
        }
    ];

    sheets.forEach((sheet, index) => {
        files.push({
            name: 'xl/worksheets/' + (sheet.file || ('sheet' + (index + 1) + '.xml')),
            data: buildSheetXml(sheet.rows, sharedStrings)
        });
    });

    for (const file of files) {
        if (stored.has(file.name)) file.method = 0;
    }
    return makeZip(files);
}

/**
 * 把二维数组转成 CSV 文本（含分隔符/引号/换行的字段一律加引号）
 *
 * @param {Array<Array>} rows
 * @returns {string}
 */
export function toCsv(rows) {
    return rows
        .map((row) => row
            .map((cell) => {
                const text = cell === undefined || cell === null ? '' : String(cell);
                return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
            })
            .join(','))
        .join('\r\n') + '\r\n';
}

/** 写临时文件并返回绝对路径 */
export function writeTempFixture(dir, name, data) {
    const target = path.join(dir, name);
    writeFileSync(target, data);
    return target;
}
