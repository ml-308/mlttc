// lib/timetable-import.mjs
/**
 * 时刻表批量导入：表格读取 → 表头映射 → 行校验规范化 → 分页切片
 *
 * 三条设计约束：
 *   1. 纯函数模块，不触碰 DOM（浏览器与 node 均可直接 import，便于跑单测）；
 *   2. 入库字段与校验规则与 src/pages/timetables.js 的单条提交（write()）保持一致，
 *      复用 lib/timetable.mjs 的 Complete / timejudge / timeformat / ex_timejudege，
 *      以及城市库的 findCity / formatCityForStorage（城市必须能匹配到库内写法）；
 *   3. 零外部依赖：CSV 自己解析；XLSX 的 ZIP 容器自己解压，仅用平台原生的
 *      DecompressionStream('deflate-raw')（浏览器与 Node 18+ 均提供）。
 *
 * 典型用法（UI 侧）：
 *   const rows = await parseTableFile(file);        // string[][]
 *   const { indices, missing } = mapHeader(rows[0]);
 *   const { records, errors } = validateRows(rows); // 城市走城市库匹配，见 normalizeCityField
 *   const page = paginate(records, 1, 20);
 *   const body = buildImportBody(page.items, writer, writetime);
 */

import { Complete, timejudge, timeformat, ex_timejudege } from './timetable.mjs';
import { getCityData } from './data/city-data.mjs';
import {
    findCity,
    formatCityForStorage,
    splitCityInput,
    MAX_CITY_COUNT,
    CITY_SEPARATOR
} from './ui/city-chooser.mjs';

/** 入库字段（顺序即 buildImportBody 输出的键顺序） */
const FIELDS = ['city', 'way', 'start', 'end', 'special', 'time1', 'time2', 'etime'];

/** 必须能从表头识别出来的字段（「特殊情况」可整列省略，故不在其中） */
const REQUIRED_FIELDS = FIELDS.filter((field) => field !== 'special');

/** 字段的中文名，用于 mapHeader 的 missing 与校验报错文案 */
const FIELD_LABELS = {
    city: '城市',
    way: '线路',
    start: '起点站',
    end: '终点站',
    special: '特殊情况',
    time1: '主站→副站时刻表',
    time2: '副站→主站时刻表',
    etime: '执行时间'
};

/**
 * 可识别的表头别名（同一字段内按优先级排列，先命中者胜）
 * 匹配时对表头做归一化：全角转半角、去空格、箭头统一为 '→'、英文转小写。
 */
export const HEADER_ALIASES = {
    city: ['城市', '城市名称', '市名', '所属城市', 'city'],
    way: ['线路', '线路名称', '线路名', '线路号', '路号', 'way', 'line'],
    start: ['起点站', '出发站', '主站', '起点', '首站', 'start'],
    end: ['终点站', '到达站', '副站', '终点', '末站', 'end'],
    special: ['特殊情况', '特殊', '备注', '附注', '说明', 'special'],
    time1: [
        '主站→副站时刻表', '主站到副站时刻表', '主站→副站时刻', '主站到副站时刻',
        '主站→副站', '主站到副站', '主→副', '外环', '外圈', '时刻表1', 'time1'
    ],
    time2: [
        '副站→主站时刻表', '副站到主站时刻表', '副站→主站时刻', '副站到主站时刻',
        '副站→主站', '副站到主站', '副→主', '内环', '内圈', '时刻表2', 'time2'
    ],
    etime: ['执行时间', '生效时间', '执行日期', '生效日期', 'etime']
};

/** 导入模板：表头一行 + 示例数据一行（时刻表用引号包住，内含逗号） */
export const TEMPLATE_CSV =
    '城市,线路,起点站,终点站,特殊情况,主站→副站时刻表,副站→主站时刻表,执行时间\n' +
    '上海市,52路,火车站,汽车站,无,"0630,0700,0730","0645,0715,0745",2025-01-01\n';

/** 文本类扩展名 / ZIP 类扩展名 */
const TEXT_EXTS = new Set(['csv', 'txt', 'tsv']);
const ZIP_EXTS = new Set(['xlsx', 'xlsm', 'xltx', 'xltm']);

const UTF8 = new TextDecoder('utf-8');

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** 去掉 UTF-8 BOM */
function stripBom(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * 自动识别分隔符：只统计前 5 个物理行内、引号外的候选分隔符个数
 * 并列时优先逗号（最常见的表格文本格式）
 *
 * @param {string} text 已去 BOM 的整份文本
 * @returns {string} ',' 或 ';' 或 '\t'
 */
function detectDelimiter(text) {
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let inQuotes = false;
    let lines = 0;

    for (let i = 0; i < text.length && lines < 5; i++) {
        const ch = text[i];
        if (ch === '"') {
            // "" 转义会连续翻转两次，净效果不变
            inQuotes = !inQuotes;
            continue;
        }
        if (inQuotes) continue;
        if (ch === '\n') {
            lines += 1;
            continue;
        }
        if (counts[ch] !== undefined) counts[ch] += 1;
    }

    let best = ',';
    for (const delimiter of [',', ';', '\t']) {
        if (counts[delimiter] > counts[best]) best = delimiter;
    }
    return best;
}

/** 去掉尾部整行皆空的行（Excel 导出的 CSV 常在末尾多出若干逗号行） */
function trimTrailingEmptyRows(rows) {
    while (rows.length > 0) {
        const last = rows[rows.length - 1];
        if (last.every((cell) => String(cell).trim() === '')) rows.pop();
        else break;
    }
    return rows;
}

/**
 * 解析 CSV / TSV 文本
 * 支持：引号内含分隔符与换行、"" 转义双引号、UTF-8 BOM、CRLF 与孤立 CR、
 *      逗号 / 分号 / 制表符三种分隔符自动识别、尾部空行忽略
 *
 * @param {string} text 表格文本
 * @returns {string[][]} 行数组，每行是单元格字符串数组（各行列数允许不等）
 */
export function parseCsv(text) {
    const source = stripBom(String(text ?? ''));
    if (!source.trim()) return [];

    const delimiter = detectDelimiter(source);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < source.length) {
        const ch = source[i];

        if (inQuotes) {
            if (ch === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
            i += 1;
            continue;
        }

        if (ch === delimiter) {
            row.push(field);
            field = '';
            i += 1;
            continue;
        }

        if (ch === '\r' || ch === '\n') {
            row.push(field);
            field = '';
            rows.push(row);
            row = [];
            i += ch === '\r' && source[i + 1] === '\n' ? 2 : 1;
            continue;
        }

        field += ch;
        i += 1;
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return trimTrailingEmptyRows(rows);
}

/* ------------------------------------------------------------------ */
/* XLSX（自写最小 ZIP 读取 + 单工作表 XML 解析）                         */
/* ------------------------------------------------------------------ */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function readU16(bytes, at) {
    return bytes[at] | (bytes[at + 1] << 8);
}

function readU32(bytes, at) {
    return (
        bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
    ) >>> 0;
}

/** 统一成 Uint8Array */
function toUint8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new Error('需要 ArrayBuffer 或 Uint8Array');
}

/** 粗略判定是否文本：前 512 字节内不出现 NUL 字节 */
function isProbablyText(bytes) {
    const limit = Math.min(bytes.length, 512);
    for (let i = 0; i < limit; i++) {
        if (bytes[i] === 0) return false;
    }
    return true;
}

/** ZIP 魔数：PK\x03\x04（正常）、PK\x05\x06（空档）、PK\x07\x08（跨卷） */
function isZip(bytes) {
    return (
        bytes.length >= 4 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    );
}

/**
 * 定位 EOCD（中央目录结束记录）并读出中央目录
 *
 * @param {Uint8Array} bytes 整个文件
 * @returns {Map<string, {method:number, compressedSize:number, localOffset:number}>}
 */
function readZipDirectory(bytes) {
    let eocd = -1;
    const lowest = Math.max(0, bytes.length - 22 - 0xffff);
    for (let i = bytes.length - 22; i >= lowest; i--) {
        if (readU32(bytes, i) === SIG_EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('不是有效的 XLSX 文件（缺少 ZIP 结束标记）');

    const total = readU16(bytes, eocd + 10);
    let at = readU32(bytes, eocd + 16);
    const entries = new Map();

    for (let n = 0; n < total; n++) {
        if (at + 46 > bytes.length || readU32(bytes, at) !== SIG_CENTRAL) break;
        const method = readU16(bytes, at + 10);
        const compressedSize = readU32(bytes, at + 20);
        const nameLength = readU16(bytes, at + 28);
        const extraLength = readU16(bytes, at + 30);
        const commentLength = readU16(bytes, at + 32);
        const localOffset = readU32(bytes, at + 42);
        const name = UTF8.decode(bytes.subarray(at + 46, at + 46 + nameLength));
        entries.set(name, { method, compressedSize, localOffset });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

/** 用 DecompressionStream('deflate-raw') 解压，不依赖 Response / Blob */
async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前环境不支持 DecompressionStream，无法解析 XLSX');
    }
    const source = new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        }
    });
    const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        length += value.length;
    }
    if (chunks.length === 1) return chunks[0];
    const merged = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
}

/** 取一个条目的解压后字节；method 0 为 stored，8 为 deflate */
async function readEntry(bytes, entry) {
    if (readU32(bytes, entry.localOffset) !== SIG_LOCAL) {
        throw new Error('XLSX 的 ZIP 本地文件头损坏');
    }
    const nameLength = readU16(bytes, entry.localOffset + 26);
    const extraLength = readU16(bytes, entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return data.slice();
    if (entry.method === 8) return inflateRaw(data);
    throw new Error('不支持的 ZIP 压缩方式：' + entry.method);
}

/** ZIP 内路径归一化（去掉前导 / 与 . / ..） */
function normalizeZipPath(target) {
    const parts = [];
    for (const segment of String(target).replace(/^\/+/, '').split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            parts.pop();
            continue;
        }
        parts.push(segment);
    }
    return parts.join('/');
}

/**
 * 按 workbook.xml 的声明顺序列出全部工作表路径
 * （排在后面的是兜底：关系缺失时把 xl/worksheets/*.xml 按名字补上）
 *
 * @param {Uint8Array} bytes
 * @param {Map<string, object>} entries 中央目录
 * @returns {Promise<string[]>}
 */
async function orderedSheetPaths(bytes, entries) {
    const paths = [];
    const push = (path) => {
        if (path && entries.has(path) && !paths.includes(path)) paths.push(path);
    };

    const workbookEntry = entries.get('xl/workbook.xml');
    const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
    if (workbookEntry) {
        const workbookXml = UTF8.decode(await readEntry(bytes, workbookEntry));
        const relsXml = relsEntry ? UTF8.decode(await readEntry(bytes, relsEntry)) : '';

        // r:id → Target 的映射表
        const targets = new Map();
        if (relsXml) {
            const relRe = /<Relationship\b[^>]*>/gi;
            let match;
            while ((match = relRe.exec(relsXml))) {
                const idMatch = /\bId\s*=\s*"([^"]+)"/i.exec(match[0]);
                const targetMatch = /\bTarget\s*=\s*"([^"]+)"/i.exec(match[0]);
                if (!idMatch || !targetMatch) continue;
                const target = String(targetMatch[1]);
                const path = target.startsWith('/') || target.startsWith('xl/')
                    ? normalizeZipPath(target)
                    : normalizeZipPath('xl/' + target);
                targets.set(idMatch[1], path);
            }
        }

        const sheetRe = /<sheet\b[^>]*>/gi;
        let sheetMatch;
        while ((sheetMatch = sheetRe.exec(workbookXml))) {
            const ridMatch = /\br:id\s*=\s*"([^"]+)"/i.exec(sheetMatch[0]);
            if (ridMatch && targets.has(ridMatch[1])) push(targets.get(ridMatch[1]));
        }
    }

    push('xl/worksheets/sheet1.xml');
    for (const name of [...entries.keys()]
        .filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/i.test(entry))
        .sort()) {
        push(name);
    }

    if (paths.length === 0) throw new Error('XLSX 中找不到工作表');
    return paths;
}

function decodeXmlEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/** 去掉注音（rPh）块，避免日文读音混进单元格文本 */
function stripPhonetic(xml) {
    return xml.replace(/<rPh\b[\s\S]*?<\/rPh>/gi, '');
}

/** 拼接一段 XML 内所有 <t> 的文本（富文本被拆成多个 run，需连起来） */
function collectText(xml) {
    const normalized = xml.replace(/<t\b([^>]*)\/>/gi, '<t$1></t>');
    const out = [];
    const re = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
    let match;
    while ((match = re.exec(normalized))) out.push(decodeXmlEntities(match[1]));
    return out.join('');
}

/** 解析 xl/sharedStrings.xml */
function parseSharedStrings(xml) {
    const normalized = xml.replace(/<si\s*\/>/gi, '<si></si>');
    const list = [];
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
    let match;
    while ((match = re.exec(normalized))) list.push(collectText(stripPhonetic(match[1])));
    return list;
}

/** 单元格列引用（A1 → 0，AA1 → 26）转成 0 基列号 */
function columnIndex(letters) {
    let index = 0;
    for (const ch of letters.toUpperCase()) {
        index = index * 26 + (ch.charCodeAt(0) - 64);
    }
    return index - 1;
}

/** 取 <v> 或 <is> 的文本 */
function findTagText(xml, tag) {
    const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
    const match = re.exec(xml);
    return match ? decodeXmlEntities(match[1]) : '';
}

/** 按单元格类型取值 */
function readCellValue(type, body, sharedStrings) {
    if (type === 's') {
        const index = Number(findTagText(body, 'v').trim());
        const text = sharedStrings[index];
        return text === undefined ? '' : text;
    }
    if (type === 'inlineStr') return collectText(stripPhonetic(findTagText(body, 'is')));
    if (type === 'b') return findTagText(body, 'v').trim() === '1' ? '1' : '0';
    return findTagText(body, 'v');
}

/**
 * 解析工作表 XML 为二维字符串数组
 * 依据每个 <c r="B3"> 的列引用定位，空单元格会留出空串占位，保证列对齐；
 * 依据 <row r="5"> 的行号定位，中间缺失的行补空数组，保证行号与 Excel 显示一致；
 * 末尾整行皆空的表格行被丢弃。
 *
 * @param {string} xml 工作表 XML
 * @param {string[]} sharedStrings 共享字符串表
 * @returns {string[][]}
 */
function parseSheetXml(xml, sharedStrings) {
    const rows = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi;
    let rowMatch;

    while ((rowMatch = rowRe.exec(xml))) {
        const rowAttrs = rowMatch[1] || '';
        const body = rowMatch[2] || '';
        const rMatch = /\br\s*=\s*"(\d+)"/i.exec(rowAttrs);
        const rowNumber = rMatch ? Number(rMatch[1]) : rows.length + 1;

        const cells = [];
        const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi;
        let cellMatch;
        while ((cellMatch = cellRe.exec(body))) {
            const cellAttrs = cellMatch[1] || '';
            const cellBody = cellMatch[2] || '';
            const refMatch = /\br\s*=\s*"([A-Za-z]+)\d+"/i.exec(cellAttrs);
            const column = refMatch ? columnIndex(refMatch[1]) : cells.length;
            const typeMatch = /\bt\s*=\s*"([^"]+)"/i.exec(cellAttrs);
            cells[column] = readCellValue(typeMatch ? typeMatch[1] : 'n', cellBody, sharedStrings);
        }

        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === undefined) cells[i] = '';
        }
        rows[rowNumber - 1] = cells;
    }

    for (let i = 0; i < rows.length; i++) {
        if (!Array.isArray(rows[i])) rows[i] = [];
    }
    return trimTrailingEmptyRows(rows);
}

/**
 * 解析 XLSX（按 workbook 顺序取「第一个表头能认出来的工作表」，见 orderedSheetPaths）
 *
 * @param {ArrayBuffer|Uint8Array} arrayBuffer 文件字节
 * @returns {Promise<string[][]>} 与 parseCsv 同形状的二维数组
 */
export async function parseXlsx(arrayBuffer) {
    const bytes = toUint8(arrayBuffer);
    if (!isZip(bytes)) throw new Error('不是有效的 XLSX 文件（缺少 ZIP 魔数）');

    const entries = readZipDirectory(bytes);
    const sharedEntry = entries.get('xl/sharedStrings.xml');
    const sharedStrings = sharedEntry
        ? parseSharedStrings(UTF8.decode(await readEntry(bytes, sharedEntry)))
        : [];

    // 按 workbook 声明顺序逐表尝试：**第一个表头能认出来的工作表**才是要导入的那张。
    // （工作簿里常有封面/说明/空表排在第一张，直接取第一张会得到「表头无法识别」。）
    const sheets = await orderedSheetPaths(bytes, entries);
    let fallback = null;
    for (const sheetPath of sheets) {
        const sheetXml = UTF8.decode(await readEntry(bytes, entries.get(sheetPath)));
        const rows = parseSheetXml(sheetXml, sharedStrings);
        if (fallback === null) fallback = rows;

        const headerIndex = findHeaderRowIndex(rows);
        if (headerIndex >= 0 && headerIsUsable(rows[headerIndex])) return rows;
    }
    return fallback ?? [];
}

/**
 * 按文件名扩展名 + 文件魔数分派解析器
 * 只要求传入对象具备 .name 与 .arrayBuffer() / .text()（浏览器 File / Blob 即可）
 *
 * @param {{name?: string, arrayBuffer?: Function, text?: Function}} file 文件对象
 * @returns {Promise<string[][]>}
 */
export async function parseTableFile(file) {
    if (!file || typeof file !== 'object') throw new Error('需要一个文件对象');

    const name = String(file.name || '');
    const extMatch = /\.([^.]+)$/.exec(name);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const hasBytes = typeof file.arrayBuffer === 'function';
    const hasText = typeof file.text === 'function';

    // 明确的文本扩展名优先按文本读，省一次整份副本
    if (TEXT_EXTS.has(ext) && hasText) return parseCsv(await file.text());

    if (hasBytes) {
        const buffer = await file.arrayBuffer();
        const bytes = toUint8(buffer);
        if (isZip(bytes)) return parseXlsx(buffer);
        if (ZIP_EXTS.has(ext)) {
            throw new Error('扩展名是 .' + ext + '，但内容不是有效的 XLSX（请另存为 .xlsx 后重试）');
        }
        // 其余情况按文本处理；但二进制内容别当 CSV 静默读成乱码
        if (!isProbablyText(bytes)) {
            throw new Error('不支持的文件类型：.' + (ext || '(无扩展名)'));
        }
        if (hasText) return parseCsv(await file.text());
        return parseCsv(UTF8.decode(bytes));
    }

    if (hasText) return parseCsv(await file.text());
    throw new Error('无法读取文件内容：需要 arrayBuffer() 或 text()');
}

/* ------------------------------------------------------------------ */
/* 表头映射                                                            */
/* ------------------------------------------------------------------ */

/** 表头归一化：全角转半角、去所有空白、箭头统一、英文转小写 */
function normalizeHeader(text) {
    return String(text ?? '')
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\u3000/g, '')
        .replace(/\s+/g, '')
        .replace(/->|=>|➡|⟶|⇒|—>|→→/g, '→')
        .toLowerCase();
}

/**
 * 把表头行映射成各字段的列下标
 * 匹配规则：归一化后与别名完全相等（不做包含匹配，避免「主站→副站时刻表」被误判成「主站」）
 *
 * @param {string[]} headerRow 表头行
 * @returns {{indices: Object, missing: string[]}} indices 各字段列下标（未命中为 -1），
 *          missing 为未命中的中文字段名列表
 */
export function mapHeader(headerRow) {
    const cells = Array.isArray(headerRow) ? headerRow : [];
    const normalized = cells.map(normalizeHeader);
    const indices = {};
    const missing = [];

    for (const field of FIELDS) {
        let index = -1;
        for (const alias of HEADER_ALIASES[field]) {
            const at = normalized.indexOf(normalizeHeader(alias));
            if (at >= 0) {
                index = at;
                break;
            }
        }
        indices[field] = index;
        if (index < 0) missing.push(FIELD_LABELS[field]);
    }
    return { indices, missing };
}

/**
 * 找出表头所在的行下标
 *
 * 跳过表格最前面的空行：有的文件第 1 行留空、或先把光标挪到第 2 行才写表头。
 * 返回第一个「至少有一个非空单元格」的行下标；整份表都空时返回 -1。
 * 报错用的行号仍按 Excel 的绝对行号（下标 + 1），所以跳过的空行不会让行号错位。
 *
 * @param {string[][]} rows 二维数组
 * @returns {number}
 */
export function findHeaderRowIndex(rows) {
    if (!Array.isArray(rows)) return -1;
    for (let i = 0; i < rows.length; i++) {
        const row = Array.isArray(rows[i]) ? rows[i] : [];
        if (row.some((value) => String(value ?? '').trim() !== '')) return i;
    }
    return -1;
}

/** 这一行能不能当表头：必需字段都要能认出来（「特殊情况」可省略） */
function headerIsUsable(headerRow) {
    const { indices } = mapHeader(headerRow);
    return REQUIRED_FIELDS.every((field) => indices[field] >= 0);
}

/**
 * 把第一行实际内容拼成一小段回显，用于「表头无法识别」的报错
 * 例：（当前第 1 行：City | Line | Start …）
 *
 * @param {string[]} headerRow 第一行
 * @returns {string} 没有内容时返回空串
 */
function describeHeaderRow(headerRow) {
    const cells = (Array.isArray(headerRow) ? headerRow : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => value !== '');
    if (cells.length === 0) return '（第 1 行是空的）';
    const shown = cells.slice(0, 8).join(' | ');
    return '（当前第 1 行：' + shown + (cells.length > 8 ? ' …' : '') + '）';
}

/* ------------------------------------------------------------------ */
/* 时刻规范化与行校验                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把各种写法的时刻列表规范成空格分隔的 4 位 HHMM
 *
 * 支持：`06:30`、`6:30`（两位分钟）、`630` / `600`（左补零到 4 位）、
 *      换行 / 逗号 / 顿号 / 分号 / 空白混排、全角数字与全角冒号。
 * 不做「6:5」这类一位分钟写法（原样保留，交给 timejudge 报错）。
 * 非法 token 原样保留，由 validateRows 汇总报错。
 *
 * @param {string} raw 原始文本
 * @returns {string} 空格分隔的规范 token 串（可能为空串）
 */
export function normalizeTimeList(raw) {
    const source = String(raw ?? '')
        .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\uFF1A/g, ':');

    const tokens = source.split(/[\s,，、;；]+/).filter((token) => token !== '');
    const out = [];

    for (const token of tokens) {
        const colon = /^(\d{1,2}):(\d{2})$/.exec(token);
        if (colon) {
            out.push(colon[1].padStart(2, '0') + colon[2]);
            continue;
        }
        if (/^\d{1,3}$/.test(token)) {
            out.push(token.padStart(4, '0'));
            continue;
        }
        // '0630:0700' 这种拿冒号当分隔符的写法：每一段都像 4 位时刻才按冒号再切，
        // 这样 '6:5' 不会被误切成 00:06 / 00:05
        const parts = token.split(':');
        if (parts.length > 1 && parts.every((part) => /^\d{3,4}$/.test(part))) {
            for (const part of parts) out.push(part.padStart(4, '0'));
            continue;
        }
        out.push(token);
    }
    return out.join(' ');
}

/** 单个时刻字段的规范化：2500/2501 单独放行，其余逐 token 过 timejudge */
function normalizeTimeField(raw, label) {
    const text = String(raw ?? '').trim();
    if (text === '2500') return { value: 'unknown' };
    if (text === '2501') return { value: 'Remove' };

    const normalized = normalizeTimeList(text);
    if (!normalized) return { value: null, message: label + '不能为空' };

    for (const token of normalized.split(' ')) {
        if (!timejudge(token)) return { value: null, message: '时刻格式不合法：' + token };
    }
    return { value: timeformat(normalized) };
}

/** 执行时间规范化：容忍 - / / 年月日 等写法，再交给 ex_timejudege 校验 */
function normalizeEtimeField(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { value: null, message: FIELD_LABELS.etime + '不能为空' };

    const dotted = text
        .replace(/\s+/g, '')
        .replace(/[年月\/\-]/g, '.')
        .replace(/日/g, '');
    const value = ex_timejudege(dotted);
    return value ? { value } : { value: null, message: FIELD_LABELS.etime + '格式不合法：' + text };
}

/**
 * 城市字段：必须在城市库里匹配到，并规范成库内入库写法（与单条表单完全一致）
 *
 * 与单条「添加时刻表」共用同一套城市库查询（lib/ui/city-chooser.mjs）：
 *   「上海」/「上海市」            → 「上海市」
 *   「无锡」/「江苏无锡」/「江苏省 无锡市」 → 「江苏省 无锡市」
 *   「宜兴」/「无锡宜兴」          → 「江苏省 无锡市-宜兴市」（县级市带上级）
 * 合营线路用「/」隔开多个城市（最多 MAX_CITY_COUNT 个），逐段匹配后拼回。
 *
 * 匹配不到就报错（不退回「补个市字」的原样写法）：写错的城市会被拒绝入库，
 * 而不是悄悄存成一个城市库里不存在的名字。
 *
 * @param {string} raw 单元格原文
 * @param {{cities: Array}|null} cityData 城市数据（lib/data/city-data.mjs 的 getCityData/loadCityData）
 * @returns {{value: string|null, message?: string}}
 */
function normalizeCityField(raw, cityData) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return { value: null, message: FIELD_LABELS.city + '不能为空' };

    const cities = cityData && Array.isArray(cityData.cities) ? cityData.cities : null;
    if (!cities || cities.length === 0) {
        // 城市库没加载好时不能把整表判成非法，但要明确告诉用户是环境问题
        return { value: null, message: '城市库未加载，无法校验城市，请刷新页面后重新导入' };
    }

    const parts = splitCityInput(text);
    if (parts.length === 0) return { value: null, message: FIELD_LABELS.city + '不能为空' };
    if (parts.length > MAX_CITY_COUNT) {
        return {
            value: null,
            message: `最多只能填 ${MAX_CITY_COUNT} 个城市（合营线路用「${CITY_SEPARATOR}」隔开），当前 ${parts.length} 个`
        };
    }

    const formatted = [];
    for (const part of parts) {
        const hit = findCity(part, cityData);
        if (!hit) {
            return {
                value: null,
                message: `城市库中找不到「${part}」，请写城市库里的名称（如「上海市」「江苏省 无锡市」）`
            };
        }
        formatted.push(formatCityForStorage(hit.item));
    }
    return { value: formatted.join(CITY_SEPARATOR) };
}

/**
 * 逐行校验并规范化
 *
 * 入参是 parseCsv / parseXlsx 的原始结果（**含表头行**）：
 * rows[0] 为表头，rows[1] 起为数据；因此 records/errors 里的 row 是表格行号
 * （表头=1，第一条数据=2），与 Excel 左侧显示的行号一致。
 * 整行皆空的表格行被跳过；有任一错误的行不会进入 records。
 *
 * @param {string[][]} rows 含表头的二维数组
 * @param {object} [options]
 * @param {{cities: Array}|null} [options.cityData] 城市数据；缺省取已加载的缓存
 *        （见 lib/data/city-data.mjs 的 loadCityData）。城市必须能匹配到库内写法，
 *        匹配不到的行会被判为非法（不会原样入库）。
 * @returns {{records: Array<Object>, errors: Array<{row:number, field:string, message:string}>}}
 */
export function validateRows(rows, options = {}) {
    const records = [];
    const errors = [];
    if (!Array.isArray(rows) || rows.length === 0) return { records, errors };

    // 显式传入 cityData（含显式 null，表示「城市库不可用」）优先于已加载的缓存
    const cityData = Object.prototype.hasOwnProperty.call(options, 'cityData')
        ? options.cityData
        : getCityData();

    // ─── 表头先判 ───────────────────────────────────────────────
    // 表头认不出来时（英文表头、第一行是标题、传错了工作表……），逐行报
    // 「城市不能为空」会把用户引向错误的修法。这里直接给出「表头缺哪些列」，
    // 并且不再产出逐行错误（那些错误全是同一个根因的噪声）。
    const headerIndex = findHeaderRowIndex(rows);
    if (headerIndex < 0) return { records, errors };

    const headerRow = Array.isArray(rows[headerIndex]) ? rows[headerIndex] : [];
    const headerLine = headerIndex + 1;
    const { indices } = mapHeader(headerRow);
    const missingRequired = REQUIRED_FIELDS.filter((field) => indices[field] < 0);
    if (missingRequired.length > 0) {
        errors.push({
            row: headerLine,
            field: 'header',
            message: `第 ${headerLine} 行表头无法识别，缺少：`
                + missingRequired.map((field) => FIELD_LABELS[field]).join('、')
                + describeHeaderRow(headerRow)
        });
        return { records, errors };
    }

    const cellAt = (row, field) => {
        const index = indices[field];
        if (index < 0 || index >= row.length) return '';
        return String(row[index] ?? '');
    };

    for (let i = headerIndex + 1; i < rows.length; i++) {
        const raw = Array.isArray(rows[i]) ? rows[i] : [];
        const line = i + 1;
        if (raw.every((cell) => String(cell ?? '').trim() === '')) continue;

        const rowErrors = [];
        const fail = (field, message) => rowErrors.push({ row: line, field, message });

        // 城市必须匹配城市库（并写成库内写法）；线路纯数字补「路」；站点补「站」
        const city = normalizeCityField(cellAt(raw, 'city'), cityData);
        if (city.value === null) fail('city', city.message);

        let way = cellAt(raw, 'way').replace(/\s+/g, ' ').trim();
        if (way) {
            if (!isNaN(way)) way = Complete(way, '路');
        } else {
            fail('way', FIELD_LABELS.way + '不能为空');
            way = null;
        }

        const startRaw = cellAt(raw, 'start').trim();
        const start = startRaw ? Complete(startRaw, '站') : null;
        if (!start) fail('start', FIELD_LABELS.start + '不能为空');

        const endRaw = cellAt(raw, 'end').trim();
        const end = endRaw ? Complete(endRaw, '站') : null;
        if (!end) fail('end', FIELD_LABELS.end + '不能为空');

        const time1 = normalizeTimeField(cellAt(raw, 'time1'), FIELD_LABELS.time1);
        if (time1.value === null) fail('time1', time1.message);
        const time2 = normalizeTimeField(cellAt(raw, 'time2'), FIELD_LABELS.time2);
        if (time2.value === null) fail('time2', time2.message);

        const etime = normalizeEtimeField(cellAt(raw, 'etime'));
        if (etime.value === null) fail('etime', etime.message);

        // 特殊情况可空；留空串，由后端落库时写「无」
        const special = cellAt(raw, 'special').trim();

        if (rowErrors.length > 0) {
            errors.push(...rowErrors);
            continue;
        }

        records.push({
            row: line,
            city: city.value,
            way,
            start,
            end,
            special,
            time1: time1.value,
            time2: time2.value,
            etime: etime.value
        });
    }

    return { records, errors };
}

/* ------------------------------------------------------------------ */
/* 分页与请求体                                                        */
/* ------------------------------------------------------------------ */

/**
 * 分页切片
 * page 从 1 起；page 非法（0、负数、NaN）按 1 处理，超过 totalPages 夹紧到末页。
 * 空列表：totalPages 取 0（没有页），page 仍为 1，items 为空数组。
 *
 * @param {Array} items 全部数据
 * @param {number} page 目标页（从 1 起）
 * @param {number} pageSize 每页条数
 * @returns {{items: Array, page: number, totalPages: number, total: number}}
 */
export function paginate(items, page, pageSize) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const size = Math.max(1, Math.floor(Number(pageSize)) || 1);
    const totalPages = total === 0 ? 0 : Math.ceil(total / size);
    const requested = Math.floor(Number(page));

    let current = Number.isFinite(requested) && requested >= 1 ? requested : 1;
    if (totalPages > 0 && current > totalPages) current = totalPages;

    const start = (current - 1) * size;
    return { items: list.slice(start, start + size), page: current, totalPages, total };
}

/**
 * 组装批量入库请求体：items 只带入库字段（丢掉 row），writer / writetime 原样透传
 *
 * @param {Array<Object>} records validateRows 的 records
 * @param {string} writer 写入者
 * @param {string} writetime 写入时间（YYYY-MM-DD）
 * @returns {{items: Array<Object>, writer: string, writetime: string}}
 */
export function buildImportBody(records, writer, writetime) {
    const source = Array.isArray(records) ? records : [];
    const items = source.map((record) => {
        const item = {};
        for (const field of FIELDS) item[field] = record ? record[field] : undefined;
        return item;
    });
    return { items, writer, writetime };
}
