// src/pages/information.js
/**
 * 车辆信息页（information.html）—— 仿 timetable 的三段式交互
 *
 *   1. 查询车辆信息：公司 / 关键词 / 车辆ID，提交后显示结果区（接口待接入）
 *   2. 添加车辆信息：单条车辆表单，所有字段均为选填（写入接口待接入）
 *   3. 批量导入：本地解析 CSV / XLSX，表头映射、逐行校验、分页预览
 *      （确认上传只提示导入接口待接入）
 *
 * 目前不请求任何车辆接口；接入时替换 handleSearch / handleSubmit /
 * handleImportConfirm 里的提示分支即可。
 *
 * 代码结构（自上而下）：
 *   顶部菜单与面板切换 → 通用小工具 → 表单值收集 → 输入校验 →
 *   板块一 查询 → 板块二 添加（含候选匹配） → 板块三 批量导入 →
 *   返回 / 离开提醒 → 初始化
 *
 * 页面结构约定：
 *   - 三个面板（#search-form / #add-form / #import-form）始终存在于 DOM 中，
 *     切换只做显隐、不销毁节点，因此来回切页时各面板的输入值会保留；
 *     需要清空时走 resetForm / resetImport。
 *   - 菜单按钮用 [data-menu] 标记目标面板，与 panels 的键名一一对应，
 *     新增面板时菜单、panels、?tab= 三处要同时补上。
 *   - 页面节点是「可缺省」的（$() 可能返回 null），所有 DOM 操作都先判空，
 *     这样同一份脚本可以兼容 information.html 的多个裁剪版本。
 */
// 全局轻提示：showMessage(文案, 是否作为错误提示, 选项)
import { showMessage } from '/lib/ui/message.mjs';
// 二次确认弹窗：返回被点击按钮的下标（从 1 开始计数）
import { showConfirm } from '/lib/ui/popup.mjs';
// 通用表格解析（CSV / XLSX → 二维数组），负责识别编码并上报给调用方
import { parseTableFile } from '/lib/timetable-import.mjs';
// 车辆导入专用规则
import {
    TEMPLATE_CSV,        // 下载用模板的 CSV 文本
    TEMPLATE_FILENAME,   // 模板下载时使用的文件名
    PREVIEW_LABELS,      // 预览表头文案，顺序必须与 renderImportPreview 拼的列一致
    findHeaderRowIndex,  // 在前若干行里定位表头（模板/导出文件前面常有说明行）
    validateRows,        // 表头之后逐行校验，返回 { records, errors }
    paginate,            // 按页大小切分 records，返回 { items, page, totalPages }
    formatPlate          // 把省/市/号牌片段拼成完整车牌用于展示
} from '/lib/vehicle-import.mjs';
// 匹配下拉（输入框 + 候选列表，样式复用城市选择器）
import { attachMatchPicker } from '/lib/data/match-picker.mjs';
// 车辆页候选数据：字典 / 品牌系列 / 车牌前缀
import { loadVehicleData, fieldItems, platePrefixItems, withUnknown, UNKNOWN_CODE } from '/lib/data/vehicle-data.mjs';
// 拼音表复用城市数据，用于「海口公交 / hkjt」这类拼音匹配
import { loadCityData } from '/lib/data/city-data.mjs';

// 极简查询助手：节点不存在时返回 null，由调用处统一判空
// 用法：const addResult = $('add-result');
const $ = (id) => document.getElementById(id);

// 导入预览每页行数：行数多时只渲染当前页，避免一次插入上百个 <tr>
const IMPORT_PAGE_SIZE = 20;

/* ─── 顶部菜单与面板切换 ───────────────────────────────────── */

// 顶部菜单与三个面板：panels 的键名同时被按钮 [data-menu] 和 ?tab= 使用
const menuButtons = Array.from(document.querySelectorAll('#vehicle-menu .menu-btn'));
const panels = {
    search: $('search-form'),
    add: $('add-form'),
    import: $('import-form'),
};

/**
 * 切换到指定面板。
 * 只改显隐与按钮状态，不清理任何表单数据——用户切回来时应看到自己填的内容；
 * 需要清空时显式调用 resetForm / resetImport。
 *
 * @param {keyof typeof panels} name 目标面板键名
 * @example
 * switchPanel('import');     // 点击「批量导入」菜单
 * switchPanel(requestedTab); // 按 ?tab= 初始化
 */
function switchPanel(name) {
    Object.keys(panels).forEach((key) => {
        setHidden(panels[key], key !== name);
    });
    menuButtons.forEach((button) => {
        const active = button.dataset.menu === name;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    // 切回「添加」时重新量一次导航条（隐藏期间高度为 0，锚点留白会算错）
    if (name === 'add') {
        measureSectionNav();
        updateSectionCounts();
        scheduleSectionNav();
    }
}

// 点击菜单即切换面板；aria-selected 由 switchPanel 统一维护
menuButtons.forEach((button) => {
    button.addEventListener('click', () => switchPanel(button.dataset.menu));
});

/* ─── 通用小工具 ───────────────────────────────────────── */
/**
 * 显隐切换，同时操作 class 与 hidden 属性：
 * class 负责样式（部分组件用 .hidden 做过渡/布局），hidden 属性负责可访问性
 * 与内容判断，两者都写才能避免「看不见但仍可点击/仍被读取」。
 *
 * @param {HTMLElement|null} node 目标节点，允许为 null
 * @param {boolean} hidden 是否隐藏
 * @example
 * setHidden(searchResult, false); // 展开查询结果区
 * setHidden(addResult, true);     // 收起添加结果提示
 */
function setHidden(node, hidden) {
    if (!node) return;
    node.classList.toggle('hidden', Boolean(hidden));
    if ('hidden' in node) node.hidden = Boolean(hidden);
}

/**
 * hcw-button 没有代理 disabled：属性负责外观，expando 只给内部判断用。
 *
 * 因此这里必须两边都写——setAttribute 让组件渲染成禁用态，
 * node.disabled 则供本文件的逻辑判断（自定义元素的 click 仍会触发，
 * 回调里要靠 disabled 属性提前 return）。
 *
 * @example
 * setDisabled(importEls.confirm, true); // 初始化时禁用「确认导入」
 */
function setDisabled(node, disabled) {
    if (!node) return;
    node.disabled = Boolean(disabled);
    if (disabled) node.setAttribute('disabled', '');
    else node.removeAttribute('disabled');
}

/**
 * 把任意值转成可安全插入 innerHTML 的文本。
 * 文件名、表头、单元格等外部内容在拼接 HTML 前都要经过它。
 *
 * @param {unknown} value 任意值；null/undefined 视为空串
 * @returns {string} 已转义的文本
 * @example
 * const header = `<th>${escapeHtml(label)}</th>`;
 */
/** HTML 特殊字符 → 实体（对照表，不用正则） */
const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

function escapeHtml(value) {
    const text = String(value ?? '');
    let out = '';

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        out += HTML_ESCAPES[ch] ?? ch;
    }
    return out;
}

/**
 * 表格单元格文案：去空格，空值统一显示为「—」，其余内容做 HTML 转义。
 * 返回的是可直接拼进 <td> 的 HTML 片段。
 *
 * @param {unknown} value 单元格原始值
 * @returns {string} 已转义的 HTML 片段
 * @example
 * const cell = `<td>${cellText(record.company)}</td>`; // 空值渲染为「—」
 */
function cellText(value) {
    const text = String(value ?? '').trim();
    return escapeHtml(text === '' ? '—' : text);
}

/* ─── 表单值收集 ───────────────────────────────────────── */
/**
 * 全页输入控件的实时值，键为控件的 name（没有 name 时退回 id）。
 * 只做记录、不操作 DOM：接入接口时直接读 formValues，不必再遍历表单。
 *
 * 文件框记录 File 对象（未选择时为 null），其余记录 value 字符串，
 * 复选框记录布尔值。
 */
const formValues = Object.create(null);

/** 控件在 formValues 中的键名 */
function controlKey(el) {
    return el.name || el.id || '';
}

/** 读取控件当前值 */
function readControlValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'file') return (el.files && el.files[0]) || null;
    return el.value;
}

/** 记录单个控件的最新值 */
function recordControl(el) {
    if (!el) return;
    const key = controlKey(el);
    if (key) formValues[key] = readControlValue(el);
}

// 查询 / 添加 / 导入三个面板里的全部 input、select、textarea
const trackedControls = [panels.search, panels.add, panels.import]
    .filter(Boolean)
    .flatMap((panel) => Array.from(panel.querySelectorAll('input, select, textarea')));

// 逐元素监听 input：用户一改动就同步到 formValues
trackedControls.forEach((el) => {
    el.addEventListener('input', () => recordControl(el));
});

/**
 * 重新读取全部控件。
 * input 事件只覆盖用户输入，程序化改动（清空表单、切换车牌地区、
 * 重置文件框）不会触发它，这些地方显式调用本函数保持状态一致。
 */
function refreshFormValues() {
    trackedControls.forEach(recordControl);
}

refreshFormValues();

/* ─── 单条记录 ────────────────────────────────────────── */
/** 「信息未知」的几种写法：代号 UNKN，或用户直接打的同义词 */
const UNKNOWN_WORDS = new Set(['unkn', 'unknown', 'unk', '未知', '不清楚', '不知道', '待补充', '待确认']);

/**
 * 是否填的是「未知」代号。
 * @param {string} value 输入值
 * @returns {boolean}
 */
function isUnknownValue(value) {
    return UNKNOWN_WORDS.has(String(value ?? '').trim().toLowerCase());
}

/**
 * 车辆档案字段白名单（与 information.html 的 name 一一对应）。
 * formValues 里还混着查询条件与导入文件，取单条记录时必须按这份清单筛选。
 */
const VEHICLE_FIELD_KEYS = [
    'selfNo', 'company', 'branch', 'vehicleModel', 'operationStatus', 'fuelType',
    'vin', 'factoryNo', 'vehicleType', 'plateRegion', 'platePrefix', 'plateSuffix',
    'engine', 'motor', 'battery', 'transmission',
    'axle', 'chassis', 'tire', 'suspension', 'step',
    'airConditioner', 'door',
    'factoryDate', 'onlineDate', 'scrapDate', 'remark',
];

/**
 * 把当前表单整理成「一条车辆记录」。
 *
 * 规范化规则：
 *   - 去掉首尾空格
 *   - 空串 / 未触碰过的字段 → null
 *   - 「未知」代号（UNKN、未知、待补充…）→ null（暂留空）
 *
 * @returns {Record<string, string|null>} 键为接口字段名，值为字符串或 null
 * @example
 * const record = collectVehicleRecord();
 * // { selfNo: 'A-01', company: '海口公交', fuelType: null, ... }
 */
function collectVehicleRecord() {
    const record = {};

    VEHICLE_FIELD_KEYS.forEach((key) => {
        const raw = formValues[key];
        const text = typeof raw === 'string' ? raw.trim() : raw;

        if (!text || isUnknownValue(text)) {
            record[key] = null;
            return;
        }

        // 日期统一成 YYYY-MM-DD（2024/5/1 → 2024-05-01）；解析不了就保留原样
        record[key] = DATE_FIELDS.has(key) ? (parseDateText(text) ?? text) : text;
    });

    return record;
}

/* ─── 输入校验（仅判空，红 / 绿提示） ───────────────────────────── */
/**
 * 每个可编辑控件按下面的顺序判断：
 *   空       → 输入框标红，提示行红字「请填写 xxx」
 *   未知代号 → 不标红不标绿，提示行黄字「代号 UNKN · 信息未知（暂留空）」
 *   格式不符 → 输入框标红，提示行红字说明具体要求（如 VIN 17 位）
 *   符合     → 输入框标绿，提示行绿字「"xxx" 符合格式要求」
 *
 * 格式规则见 FIELD_FORMATS；不在表里的字段只判空。
 * 不拦截提交，未交互过的控件保持中性。
 */

/** 记录「用户真正输入/选择过」的控件；只有它们失焦时才判空 */
const touchedControls = new WeakSet();

/**
 * 取控件对应的提示行：优先复用 HTML 里的 #<id>-hint，没有就动态建一个。
 * 提示行带 role="status" + aria-live，读屏会念出校验结果。
 */
function controlHint(el) {
    if (!el || !el.id) return null;
    const existing = document.getElementById(el.id + '-hint');
    if (existing) return existing;

    const hint = document.createElement('p');
    hint.id = el.id + '-hint';
    hint.className = 'lp';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');

    // .city-chooser（匹配下拉外壳）与 .match-row（含「全部」按钮的整行）都要跳过，
    // 提示行挂到整行外面，避免挤进 flex 行里
    let anchor = el;
    while (anchor.parentElement
        && (anchor.parentElement.classList.contains('city-chooser')
            || anchor.parentElement.classList.contains('match-row'))) {
        anchor = anchor.parentElement;
    }
    anchor.insertAdjacentElement('afterend', hint);
    el.setAttribute('aria-describedby', hint.id);
    return hint;
}

/** 控件名称：取关联 label 的文案，去掉「(可选)」这类括号说明 */
function controlLabel(el) {
    const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
    const text = label
        ? label.textContent.split('（可选）').join('').split('(可选)').join('').trim()
        : '';
    return text || el.name || el.id || '该字段';
}

/* ---------- 格式判断小工具 ---------- */
/*
 * 全部用逐字符判断，不使用正则：
 * 规则改动时只需要改这些具名函数，读起来也是「长度 + 字符集」两件事。
 */

/** 0–9 */
function isDigitChar(ch) {
    const code = ch.charCodeAt(0);
    return code >= 48 && code <= 57;
}

/** A–Z（忽略大小写） */
function isLetter(ch) {
    const code = ch.charCodeAt(0);
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    return upper >= 65 && upper <= 90;
}

/** 整串都是数字 */
function isAllDigits(text) {
    if (!text) return false;
    for (let i = 0; i < text.length; i += 1) {
        if (!isDigitChar(text[i])) return false;
    }
    return true;
}

/** 恰好 n 位数字 */
function isFixedDigits(text, n) {
    return text.length === n && isAllDigits(text);
}

/** 整串都是字母或数字（车牌后缀用） */
function isLetterOrDigits(text) {
    if (!text) return false;
    for (let i = 0; i < text.length; i += 1) {
        if (!isDigitChar(text[i]) && !isLetter(text[i])) return false;
    }
    return true;
}

/* ---------- 字段格式规则 ---------- */
/** 车牌首位的省级行政区简称（不含港澳台） */
const PLATE_PROVINCES = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼';

/** VIN 禁用字母：与数字 1 / 0 易混 */
const VIN_EXCLUDED_LETTERS = ['I', 'O', 'Q'];

/** 日期字段（失焦时会把 2024/5/1 补成 2024-05-01） */
const DATE_FIELDS = new Set(['factoryDate', 'onlineDate', 'scrapDate']);

/** 日期分隔符：`-` 与 `/` 都认 */
function isDateSeparator(ch) {
    return ch === '-' || ch === '/';
}

/** 首个日期分隔符的下标；没有分隔符时返回 -1 */
function firstSeparatorIndex(text) {
    for (let i = 0; i < text.length; i += 1) {
        if (isDateSeparator(text[i])) return i;
    }
    return -1;
}

/** 按 `-` 或 `/` 把日期拆成若干段（空段保留，交给后面的数字判断挡掉） */
function splitDateParts(text) {
    const parts = [];
    let current = '';

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (isDateSeparator(ch)) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts;
}

/** 日期文本半角化：全角数字 / ／ / － 转半角，便于统一解析与判断 */
function toHalfWidthDate(value) {
    const text = String(value ?? '');
    let out = '';

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const code = ch.charCodeAt(0);

        if (code >= 0xFF10 && code <= 0xFF19) out += String.fromCharCode(code - 0xFEE0);
        else if (ch === '／') out += '/';
        else if (ch === '－') out += '-';
        else out += ch;
    }

    return out.trim();
}

/**
 * 解析日期文本。
 * 支持 `-` 与 `/` 分隔、月/日不补零、两位年份、全角数字；
 * 返回规范化的 YYYY-MM-DD。
 *
 * @param {string} value 输入文本
 * @returns {string|null} 规范化日期；非法返回 null
 * @example
 * parseDateText('2024/5/1');  // '2024-05-01'
 * parseDateText('24/5/1');    // '2024-05-01'（两位年份按 20xx 识别）
 * parseDateText('2024-13-1'); // null
 */
function parseDateText(value) {
    const parts = splitDateParts(toHalfWidthDate(value));
    if (parts.length !== 3) return null;

    const [yearText, monthText, dayText] = parts;
    const yearOk = isAllDigits(yearText) && (yearText.length === 4 || yearText.length === 2);
    if (!yearOk || !isAllDigits(monthText) || !isAllDigits(dayText)) return null;
    if (monthText.length > 2 || dayText.length > 2) return null;

    // 两位年份统一按 20xx 解释（24 → 2024）
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (month < 1 || month > 12 || day < 1) return null;

    // 用 Date 回算一次，挡掉 2 月 30 日、非闰年 2 月 29 日这类
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day) {
        return null;
    }

    const pad = (num) => String(num).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * 日期字段失焦时规范化输入（2024/5/1 → 2024-05-01）。
 * 规范化后派发 input 事件，让表单值收集与校验同步；
 * 若年份只写了两位，会在该条提示行里说明识别结果。
 *
 * @param {HTMLInputElement} el 输入框
 * @returns {boolean} 是否发生了改写
 */
function normalizeDateField(el) {
    if (!DATE_FIELDS.has(controlKey(el))) return false;

    const raw = toHalfWidthDate(el.value);
    const normalized = parseDateText(raw);
    if (!normalized || normalized === raw) return false;

    el.value = normalized;
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // 两位年份（24/5/1）被补成 20xx 时，在这一条输入框下方说明一次
    if (firstSeparatorIndex(raw) === 2) {
        const hint = controlHint(el);
        if (hint) {
            hint.textContent = `“${normalized}” 符合格式要求（年份 ${raw.slice(0, 2)} 已识别为 ${normalized.slice(0, 4)}）`;
        }
    }

    return true;
}

/** 车牌地区是否为中国香港（香港车牌不走大陆「省份简称 + 字母」规则） */
function isHongKongRegion() {
    const region = $('plate-region');
    return Boolean(region && region.value === 'hk');
}

const DATE_FORMAT = {
    test: (value) => parseDateText(value) !== null,
    message: '日期格式应为 YYYY-MM-DD 或 YYYY/MM/DD（例：2024-05-01，年份可简写为 24）',
};

/** VIN：17 位字母或数字，排除 I / O / Q */
function isVin(value) {
    if (value.length !== 17) return false;

    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (isDigitChar(ch)) continue;
        if (!isLetter(ch)) return false;
        if (VIN_EXCLUDED_LETTERS.includes(ch.toUpperCase())) return false;
    }
    return true;
}

/** 车牌号前缀：省份简称 + 1 位字母（中国香港不做限制） */
function isPlatePrefix(value) {
    if (isHongKongRegion()) return true;
    if (value.length !== 2) return false;
    if (!PLATE_PROVINCES.includes(value[0])) return false;
    return isLetter(value[1]);
}

/** 车牌号后缀：5–6 位字母或数字（中国香港不做限制） */
function isPlateSuffix(value) {
    if (isHongKongRegion()) return true;
    if (value.length < 5 || value.length > 6) return false;
    return isLetterOrDigits(value);
}

/**
 * 字段格式规则，键为控件的 name / id。
 * 不在表里的字段只判空，不校验格式。
 */
const FIELD_FORMATS = {
    vin: { test: isVin, message: 'VIN 应为 17 位字母或数字（不含 I/O/Q）' },
    platePrefix: { test: isPlatePrefix, message: '格式应为「省份简称 + 字母」，例：琼A' },
    plateSuffix: { test: isPlateSuffix, message: '格式应为 5–6 位字母或数字' },
    factoryDate: DATE_FORMAT,
    onlineDate: DATE_FORMAT,
    scrapDate: DATE_FORMAT,
    searchId: { test: (value) => isFixedDigits(value, 12), message: '车辆ID应为 12 位数字' },
};

/** 把控件恢复成「未判断」的中性态（清空表单、切换面板后使用） */
function clearControlState(el) {
    if (!el) return;
    touchedControls.delete(el);
    el.classList.remove('is-invalid', 'is-valid');
    const hint = el.id ? document.getElementById(el.id + '-hint') : null;
    if (!hint) return;
    hint.classList.remove('lp-invalid', 'lp-valid', 'lp-warning');
    hint.textContent = '';
}

/**
 * 校验单个控件：判空 + 格式，并把结果写进样式与提示行。
 * 填「未知」代号时不算错，用警告色提示「暂留空」。
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} el 目标控件
 * @returns {boolean} 是否已有内容
 */
function validateControl(el) {
    if (!el || el.disabled) return false;

    const value = (el.value || '').trim();
    const filled = value.length > 0;
    const unknown = filled && isUnknownValue(value);
    const label = controlLabel(el);
    const hint = controlHint(el);
    const rule = FIELD_FORMATS[controlKey(el)];
    // 空值与「未知」代号不参与格式判断
    const formatOk = !rule || !filled || unknown || rule.test(value);
    const invalid = !filled || (!unknown && !formatOk);

    el.classList.toggle('is-invalid', invalid);
    el.classList.toggle('is-valid', filled && !unknown && formatOk);
    // 悬浮输入框也能看到代号含义（提示行之外的补充）
    el.title = unknown ? `代号 ${UNKNOWN_CODE}：信息未知（暂留空）` : '';

    if (hint) {
        hint.classList.toggle('lp-invalid', invalid);
        hint.classList.toggle('lp-valid', filled && !unknown && formatOk);
        hint.classList.toggle('lp-warning', unknown);

        if (unknown) {
            hint.textContent = `代号 ${UNKNOWN_CODE} · 信息未知（暂留空）`;
        } else if (!filled) {
            hint.textContent = '请填写' + label;
        } else if (!formatOk) {
            hint.textContent = rule.message;
        } else {
            // 长文本（备注）只截取前 12 个字符做回显
            const preview = value.length > 12 ? value.slice(0, 12) + '…' : value;
            hint.textContent = `“${preview}” 符合格式要求`;
        }
    }

    return filled;
}

// 只校验可编辑控件：隐藏字段与文件选择框不参与
const validatedControls = trackedControls.filter((el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type !== 'hidden' && type !== 'file';
});

// 输入 / 选择时立刻判空并记为「已触碰」；失焦时只对碰过的控件再判一次，
// 这样 Tab 扫一遍表单不会出现满屏红字。
validatedControls.forEach((el) => {
    ['input', 'change'].forEach((type) => {
        el.addEventListener(type, () => {
            touchedControls.add(el);
            validateControl(el);
        });
    });
    el.addEventListener('blur', () => {
        if (!touchedControls.has(el)) return;
        // 规范化会派发 input 触发一次校验；没发生改写时再补一次兜底校验
        if (!normalizeDateField(el)) validateControl(el);
    });
});

/**
 * 批量清除校验结果。
 * @param {HTMLElement} [root] 限定容器；省略时清除全部
 * @example
 * resetValidation(formRoot);      // 清空「添加」表单后
 * resetValidation(panels.search); // 清空查询条件后
 */
function resetValidation(root) {
    validatedControls.forEach((el) => {
        if (!root || root.contains(el)) clearControlState(el);
    });
}


/* ═══════════════════════════════════════════════════════════════════════════
 * 板块一 · 查询车辆信息
 *
 * 入口：#search-form 面板；对应菜单 data-menu="search"，也可用 ?tab=search 打开。
 * 现状：不请求接口，只校验入参后渲染一张占位结果卡片。
 * 接入：替换 handleSearch 里构造占位卡片的分支，按接口返回的 records 渲染结果。
 * ═══════════════════════════════════════════════════════════════════════════ */

// 「查询」面板的输入项与结果区
const searchCompanyInput = $('search-company');
const searchKeywordInput = $('search-keyword');
const searchIdInput = $('search-id');
const searchResult = $('search-result');
const resultCount = $('result-count');
const resultList = $('result-list');

/**
 * 收起结果区，并复位计数与三个查询条件的校验态。
 *
 * @example
 * clearSearchResult(); // 点击「清空」后收起上一次的查询结果
 */
function clearSearchResult() {
    setHidden(searchResult, true);
    resultList.replaceChildren();
    resultCount.textContent = '共 0 条结果';
    resetValidation(panels.search);
}

/**
 * 执行查询。
 *
 * 目前不发真实请求：只在前端校验入参，然后渲染一张「接口待接入」的占位卡片，
 * 顺便说明将来接口会接收哪些条件、返回什么。接入后把占位卡片
 * 替换成按 records 渲染的结果行即可。
 *
 * @example
 * // 点击按钮或输入框回车时触发
 * $('submitSearchBtn').addEventListener('click', handleSearch);
 */
function handleSearch() {
    const company = searchCompanyInput.value.trim();
    const keyword = searchKeywordInput.value.trim();
    const id = searchIdInput.value.trim();

    // 车辆ID 固定 12 位数字：格式不对直接止步，避免把脏条件发给后端
    if (id && !isFixedDigits(id, 12)) {
        searchIdInput.classList.remove('is-valid');
        searchIdInput.classList.add('is-invalid');
        const hint = controlHint(searchIdInput);
        if (hint) {
            hint.classList.remove('lp-valid');
            hint.classList.add('lp-invalid');
            hint.textContent = '车辆ID应为 12 位数字';
        }
        showMessage('车辆ID应为12位数字', true);
        searchIdInput.focus();
        return;
    }
    // 格式通过后把 ID 的中性态还回去（不保留上一次的红框/红字）
    clearControlState(searchIdInput);

    // 三个条件全空时无从查询，聚焦第一个输入框引导用户填写
    if (!company && !keyword && !id) {
        showMessage('请输入至少一个查询条件', true);
        searchCompanyInput.focus();
        return;
    }

    // 占位结果卡片：用 DOM API 构造而非 innerHTML，后续替换成真实结果行时改动更小
    const box = document.createElement('div');
    box.className = 'result-card info';
    const title = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = '查询接口待接入';
    title.appendChild(strong);
    const desc = document.createElement('p');
    desc.textContent = '接入后将按公司、关键词（自编号 / 车牌号 / VIN）和车辆ID返回车辆记录。';
    box.append(title, desc);

    resultCount.textContent = '共 0 条结果';
    resultList.replaceChildren(box);
    setHidden(searchResult, false);
    searchResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showMessage('查询接口待接入', false, { type: 'info' });
}

if ($('submitSearchBtn')) $('submitSearchBtn').addEventListener('click', handleSearch);
if ($('clearSearchBtn')) {
    $('clearSearchBtn').addEventListener('click', () => {
        searchCompanyInput.value = '';
        searchKeywordInput.value = '';
        searchIdInput.value = '';
        clearSearchResult();
    });
}
// 三个输入框都支持回车提交，行为与点击「查询」按钮一致；
// preventDefault 避免浏览器把回车当成隐式表单提交导致整页刷新
[searchCompanyInput, searchKeywordInput, searchIdInput].forEach((input) => {
    if (!input) return;
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleSearch();
        }
    });
});


/* ═══════════════════════════════════════════════════════════════════════════
 * 板块二 · 添加车辆信息
 *
 * 入口：#add-form 面板；对应菜单 data-menu="add"，也可用 ?tab=add 打开，
 *       或带 #字段id 的链接直接定位到本面板内的某个分区。
 * 现状：所有字段均为选填，不做任何校验，提交后仅提示「写入接口待接入」。
 * 接入：在 handleSubmit 里直接发起写入请求，并按响应调用 showAddResult。
 * 内部顺序：DOM 引用 → 操作按钮 → 公司/分公司联动 → 车牌地区 → 候选匹配 → 清空 / 提交。
 * ═══════════════════════════════════════════════════════════════════════════ */

// 「添加」面板的固定节点：表单根、公司 → 分公司联动、车牌地区。
// 统一在启动时取一次，回调里不再重复查询 DOM，缺失的节点也能更早暴露为 null。
const formRoot = $('vehicle-form');
const companyInput = $('company');
const branchInput = $('branch');
const plateRegion = $('plate-region'); // 隐藏字段，值与地区选项卡的 data-region 对应
const regionTabs = Array.from(document.querySelectorAll('#plate-region-tabs .menu-btn'));

// 「添加」面板的两个操作按钮与结果提示区
const submitAddBtn = $('submitAddBtn');
const resetAddBtn = $('resetAddBtn');
const addResult = $('add-result');

/**
 * 在「添加」面板底部展示结果提示。
 *
 * @param {string} message 文案
 * @param {'info'|'success'|'error'} type 样式类型，默认 info
 * @example
 * showAddResult('写入接口待接入：接入接口后即可保存车辆信息。', 'info');
 */
function showAddResult(message, type = 'info') {
    if (!addResult) return;
    addResult.classList.remove('hidden', 'success', 'error', 'info');
    addResult.classList.add(type);
    addResult.textContent = message;
    setHidden(addResult, false);
}

/**
 * 提交「添加」表单。
 *
 * 所有字段均为选填，这里不做任何校验；先把表单整理成一条车辆记录，
 * 再给出占位提示。接入后端时把 record 直接提交即可。
 *
 * @example
 * submitAddBtn.addEventListener('click', handleSubmit);
 */
function handleSubmit() {
    setHidden(addResult, true);

    // 单条记录：只取车辆字段，UNKN 与空值统一转成 null
    const record = collectVehicleRecord();
    const filled = Object.values(record).filter((value) => value !== null).length;

    // 写入接口尚未接入：表单内容不做校验，直接给出占位提示
    showAddResult(`写入接口待接入：已整理 ${filled} 个字段，接入接口后即可保存车辆信息。`, 'info');
    showMessage('写入接口待接入', false, { type: 'info' });
}

/* ─── 公司 → 分公司/车队 ─────────────────────────────────── */
/**
 * 公司 → 分公司/车队联动。
 * 分公司候选依赖所选公司，所以公司为空时直接禁用分支输入并清空其值，
 * 避免上一次的残留内容被一起提交。
 *
 * @example
 * companyInput.addEventListener('input', syncBranchInput);
 * syncBranchInput(); // 初始化时执行一次，让分公司输入处于禁用态
 */
function syncBranchInput() {
    if (!companyInput || !branchInput) return;

    const hasCompany = companyInput.value.trim().length > 0;
    branchInput.disabled = !hasCompany;
    branchInput.placeholder = hasCompany ? '请输入分公司/车队名称' : '请先填写公司';
    if (!hasCompany) {
        branchInput.value = '';
        // 被禁用后旧的红/绿提示已经没有意义，清成中性
        clearControlState(branchInput);
    }
}

// input 覆盖手动输入，change 覆盖选择器/自动填充等不触发 input 的场景
if (companyInput) {
    companyInput.addEventListener('input', syncBranchInput);
    companyInput.addEventListener('change', syncBranchInput);
}

/* ─── 车牌地区选项卡 ─────────────────────────────────────── */
// 车牌地区：选项卡只负责切换 is-active 并回写隐藏字段 #plate-region，
// 真正的地区值随表单一起提交
regionTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
        regionTabs.forEach((item) => item.classList.toggle('is-active', item === tab));
        if (plateRegion) plateRegion.value = tab.dataset.region || 'mainland';
        // 隐藏字段不会触发 input，切换后手动同步一次
        refreshFormValues();
    });
});

/* ─── 候选数据：公司与车队 / 字典字段 ─────────────────── */
/**
 * 需要挂「输入框 + 匹配下拉」的控件（都在本面板内）。
 * 公司 / 车队 / 车型按普通文本框处理，直接填写，不挂下拉；
 * 三个原下拉是封闭字典，其余部件字段允许自由输入。
 * 车牌号前缀单独处理：候选来自城市库（城市 → 前缀）。
 */
const PICKER_IDS = [
    'operation-status', 'fuel-type', 'vehicle-type',
    'engine', 'motor', 'battery', 'transmission',
    'axle', 'chassis', 'tire', 'suspension', 'step', 'air-conditioner', 'door',
];

/** 封闭字典：失焦时若输入不在候选内，回退到上次选中值（没有就清空） */
const STRICT_PICKER_IDS = ['operation-status', 'fuel-type', 'vehicle-type'];

/** 控件 id → 选择器实例，清空表单时统一复位 */
const pickers = new Map();

/**
 * 动力系统字段：候选按燃料类型过滤，不适用的会被禁用。
 * （发动机 / 电机 / 电池 / 变速器，顺序即下方联动时的处理顺序）
 */
const POWERTRAIN_IDS = ['engine', 'motor', 'battery', 'transmission'];

/** 动力系统各字段的完整候选（含 UNKN）；联动时在这份数据上过滤，不动原始候选 */
const powertrainItems = new Map();

/** 联动配置，来自 vehicle-options.json 的 powertrain；缺失时为 null（不联动） */
let powertrainConfig = null;

/** 取某个控件的候选（字典类字段直接按控件 id 索引，「未知」代号排在最前） */
function pickerItems(id, data) {
    return withUnknown(fieldItems(data, id));
}

/**
 * 加载候选数据并给各字段挂上匹配下拉。
 *
 * 数据或拼音表加载失败时只打印警告：输入框退化为普通文本框，
 * 校验、收集、提交等其余功能不受影响。
 */
async function initPickers() {
    let data;
    let cityData = null;

    try {
        [data, cityData] = await Promise.all([
            loadVehicleData(),
            // 城市数据同时提供拼音表与车牌前缀
            loadCityData().catch(() => null),
        ]);
    } catch (err) {
        console.warn('[information] 候选数据不可用，输入框保持普通文本模式', err);
        return;
    }

    // 拼音表复用城市数据；字不在表里时自动退化为字面匹配
    const pinyin = cityData ? { map: cityData.pinyin, exceptions: cityData.exceptions } : null;

    // 燃料类型 → 动力系统字段的联动表，数据里没配就整块跳过
    powertrainConfig = data.powertrain || null;

    PICKER_IDS.forEach((id) => {
        const input = $(id);
        if (!input) return;

        const items = pickerItems(id, data);
        const picker = attachMatchPicker(input, {
            items,
            strict: STRICT_PICKER_IDS.includes(id),
            pinyin,
            // 车门类型可能同时有多种（如「双内摆门、外摆门」），支持多选
            multi: id === 'door',
        });

        pickers.set(id, picker);
        if (POWERTRAIN_IDS.includes(id)) powertrainItems.set(id, items);
    });

    // 车牌号前缀：输入城市名（海口）或前缀（琼A）都能匹配
    const plateInput = $('plate-prefix');
    const plateItems = withUnknown(platePrefixItems(cityData));
    if (plateInput && plateItems.length > 0) {
        pickers.set('plate-prefix', attachMatchPicker(plateInput, {
            items: plateItems,
            pinyin,
            ariaLabel: '可选车牌号前缀',
        }));
    }

    // 燃料类型一变，动力系统跟着换（禁用不该填的字段 + 过滤候选）
    const fuelInput = $('fuel-type');
    if (fuelInput) {
        ['input', 'change'].forEach((type) => {
            fuelInput.addEventListener(type, applyPowertrainProfile);
        });
    }
    applyPowertrainProfile();
}

/* ─── 动力系统联动：按燃料类型匹配字段与候选 ───────────── */
/*
 * 燃料类型决定动力系统该填什么：
 *   柴油 / 汽油 / 天然气 / 醇醚 / 双燃料 → 发动机（+ 变速器）
 *   纯电动 / 换电 / 快充 / 燃料电池       → 电机 + 电池（+ 变速器）
 *   无轨电车 / 超级电容                   → 电机（+ 变速器）
 *   混合动力 / 增程式                     → 发动机 + 电机 + 电池（+ 变速器）
 * 规则写在 vehicle-options.json 的 powertrain 里，改口径只改数据。
 */

/**
 * 燃料文本 → 档案键（不在映射表里返回空串）。
 * @example
 * fuelProfileKey('纯电动'); // 'ev'
 */
function fuelProfileKey(text) {
    const byFuel = (powertrainConfig && powertrainConfig.byFuel) || {};
    return byFuel[String(text ?? '').trim()] || '';
}

/**
 * 档案键 → 档案；未知键退回 any（等于不限制）。
 * @param {string} key 档案键，如 'ev'
 */
function powertrainProfile(key) {
    const profiles = (powertrainConfig && powertrainConfig.profiles) || {};
    return profiles[key] || profiles.any || null;
}

/**
 * 按 drive 过滤候选：条目没写 drive 视为通用，UNKN 因此始终保留。
 * @param {Array} items 候选
 * @param {string} drive 'ev' / 'ice' / 'both' / 'all'
 */
function filterByDrive(items, drive) {
    // 'all' / 'both' 都表示该燃料类型不限制变速器类别（混动两套都能配）
    if (!drive || drive === 'all' || drive === 'both') return items;
    return items.filter((item) => !item.drive || item.drive === 'both' || item.drive === drive);
}

/** 候选数量变了，同步「全部」按钮的悬浮说明 */
function syncAllCount(picker, count) {
    if (!picker || !picker.allBtn) return;
    picker.allBtn.title = count > 0 ? `查看全部候选（${count} 条）` : '查看全部候选';
}

/**
 * 设置单个动力系统字段的适用状态。
 * 不适用时：禁用输入框与「全部」按钮、清空已填内容、提示行说明原因。
 *
 * @param {string} id 控件 id
 * @param {{disabled: boolean, items: Array, reason: string}} options
 */
function setPowertrainField(id, options) {
    const input = $(id);
    if (!input) return;

    const picker = pickers.get(id) || null;
    const hint = controlHint(input);
    const { disabled, items, reason } = options;

    if (disabled) {
        if (picker) picker.reset();
        else input.value = '';
        // 清掉校验色，并把控件移出「已触碰」，恢复适用后不会一上来就标红
        clearControlState(input);
        recordControl(input);
    }

    setDisabled(input, disabled);
    if (picker) {
        picker.setItems(items);
        syncAllCount(picker, items.length);
        setDisabled(picker.allBtn, disabled);
        picker.row.classList.toggle('is-na', disabled);
    }

    if (!hint) return;
    hint.classList.remove('lp-invalid', 'lp-valid', 'lp-warning', 'lp-na');
    hint.textContent = disabled ? reason : '';
    if (disabled) hint.classList.add('lp-na');
}

/**
 * 应用当前燃料类型对应的动力系统规则。
 * 燃料还没输入成完整候选值时先不动，等失焦确认后再联动，避免打字过程中来回闪。
 *
 * @example
 * fuelType.addEventListener('input', applyPowertrainProfile);
 */
function applyPowertrainProfile() {
    if (!powertrainConfig) return;

    const fuelInput = $('fuel-type');
    const fuelText = fuelInput ? String(fuelInput.value || '').trim() : '';
    // 空值与「未知」代号都当作不限制：不知道该填什么时，四个字段都留着
    const unknown = !fuelText || isUnknownValue(fuelText);
    const key = unknown ? 'any' : fuelProfileKey(fuelText);
    // 还在打字（不是完整候选值）时先不动，等失焦确认后再联动
    if (!unknown && !key) return;

    const profile = powertrainProfile(key);
    if (!profile) return;

    const allowed = profile.fields.length > 0 ? profile.fields : POWERTRAIN_IDS;
    const fuelLabel = fuelText || '未填写';

    POWERTRAIN_IDS.forEach((id) => {
        const base = powertrainItems.get(id);
        if (!base) return;

        const disabled = !allowed.includes(id);
        setPowertrainField(id, {
            disabled,
            items: filterByDrive(base, profile.drive),
            reason: disabled ? `燃料类型「${fuelLabel}」不适用${controlLabel($(id))}，已清空` : '',
        });
    });

    // 字段被禁用 / 恢复会改变板块的「可填条目数」
    updateSectionCounts();
}

/* ─── 分区导航：吸顶、当前位置、完成度 ─────────────────── */
/*
 * 导航条本身用 position: sticky 贴在页头下方（information.css 里把 hcw-article
 * 的 overflow 换成 clip，祖先链才不是滚动容器）：
 *   - 吸顶后加 .is-stuck，给不透明底色 + 阴影，避免表单从字缝里透出来
 *   - 当前位置由滚动位置算出，落在「最后一块已越过导航条下沿」的板块上
 *   - 每个板块右侧显示「已填 / 可填」，字段被燃料类型禁用时总数跟着减少
 */
const sectionNav = document.querySelector('.section-nav');

/** 导航项 → 板块：{ link, section, count } */
const sectionEntries = sectionNav
    ? Array.from(sectionNav.querySelectorAll('.section-jump'))
        .map((link) => {
            const id = (link.getAttribute('href') || '').replace('#', '');
            const section = id ? document.getElementById(id) : null;
            if (!section) return null;

            const count = document.createElement('span');
            count.className = 'section-jump-count';
            link.append(count);
            return { link, section, count };
        })
        .filter(Boolean)
    : [];

/**
 * 统计一个板块「已填 / 可填」的控件数。
 * 禁用（燃料类型不适用）的字段不计入总数；隐藏字段与文件框不算条目。
 */
function sectionProgress(section) {
    const list = Array.from(section.querySelectorAll('input, select, textarea')).filter((el) => (
        el.type !== 'hidden' && el.type !== 'file' && !el.disabled
    ));
    const done = list.filter((el) => String(el.value || '').trim().length > 0).length;
    return { done, total: list.length };
}

/** 刷新每个板块的完成度（输入、联动禁用字段、清空表单后调用） */
function updateSectionCounts() {
    sectionEntries.forEach(({ section, count }) => {
        const { done, total } = sectionProgress(section);
        count.textContent = `${done}/${total}`;
        count.classList.toggle('is-done', total > 0 && done === total);
    });
}

/** 页头高度 / 导航条高度写进 CSS 变量，sticky 偏移与锚点留白都跟着走 */
function measureSectionNav() {
    const header = document.querySelector('hcw-body-header');
    const root = document.documentElement;
    const headerHeight = header ? Math.round(header.getBoundingClientRect().height) : 0;
    root.style.setProperty('--info-nav-top', `${headerHeight}px`);

    if (!sectionNav) return;
    root.style.setProperty('--info-nav-height', `${Math.round(sectionNav.getBoundingClientRect().height)}px`);
}

/** 当前是哪一块：最后一个「已滚到导航条下方」的板块；滚到底时锁定最后一块 */
function currentSectionEntry(navBottom) {
    if (!sectionEntries.length) return null;

    // 锚点跳转会把板块标题停在导航条下方一点点，阈值要略大才不会差一格
    const limit = navBottom + 24;
    let current = sectionEntries[0];
    sectionEntries.forEach((entry) => {
        if (entry.section.getBoundingClientRect().top <= limit) current = entry;
    });

    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    return atBottom ? sectionEntries[sectionEntries.length - 1] : current;
}

let navFrame = 0;
/** 上一次高亮的导航项，只在「换人」时滚动导航条，避免和用户的手动横滑打架 */
let currentLink = null;

/**
 * 把某个导航项滚进导航条的可视范围（横向，只动导航条自己的 scrollLeft）。
 * @param {HTMLElement} link 目标导航项
 */
function revealNavLink(link) {
    const linkRect = link.getBoundingClientRect();
    const navRect = sectionNav.getBoundingClientRect();
    const pad = 8;

    if (linkRect.left < navRect.left + pad) {
        sectionNav.scrollLeft -= navRect.left + pad - linkRect.left;
    } else if (linkRect.right > navRect.right - pad) {
        sectionNav.scrollLeft += linkRect.right - navRect.right + pad;
    }
}

/** 滚动 / 尺寸变化时重算吸顶态与当前位置（一帧一次） */
function updateSectionNav() {
    navFrame = 0;
    if (!sectionNav || !sectionEntries.length) return;
    // 切到其它面板时导航条不可见，不做判断
    if (!sectionNav.offsetParent) {
        sectionNav.classList.remove('is-stuck');
        return;
    }

    const navTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--info-nav-top')) || 0;
    const rect = sectionNav.getBoundingClientRect();
    const stuck = rect.top <= navTop + 1;
    sectionNav.classList.toggle('is-stuck', stuck);

    const current = currentSectionEntry(rect.bottom);
    sectionEntries.forEach((entry) => {
        const on = entry === current;
        // 滚动每帧都会进来，状态没变就不动 DOM
        if (entry.link.classList.contains('is-current') === on) return;
        entry.link.classList.toggle('is-current', on);
        if (on) entry.link.setAttribute('aria-current', 'true');
        else entry.link.removeAttribute('aria-current');
    });

    // 窄屏导航条要横向滚动：当前位置换人时把它滚进可视区
    if (current && current.link !== currentLink) {
        currentLink = current.link;
        revealNavLink(current.link);
    }
}

function scheduleSectionNav() {
    if (navFrame) return;
    navFrame = requestAnimationFrame(updateSectionNav);
}

if (sectionNav && sectionEntries.length) {
    window.addEventListener('scroll', scheduleSectionNav, { passive: true });
    window.addEventListener('resize', () => {
        measureSectionNav();
        scheduleSectionNav();
    });

    // 输入 / 选择只影响完成度，不必每键都量位置
    ['input', 'change'].forEach((type) => {
        formRoot?.addEventListener(type, updateSectionCounts);
    });

    measureSectionNav();
    updateSectionCounts();
    updateSectionNav();
}

/* ─── 清空 / 提交 ─────────────────────────────────────── */
/**
 * 无条件重置「添加」面板（不弹确认）。
 * 只清值、不动 DOM 结构；日期已是普通文本框，随 input 一起清空。
 *
 * @example
 * resetForm(); // 由 handleReset 在用户确认清空后调用
 */
function resetForm() {
    if (!formRoot) return;

    // 隐藏字段（如 plate-region）由下面的专门逻辑重置，这里跳过
    formRoot.querySelectorAll('input').forEach((input) => {
        if (input.type !== 'hidden') input.value = '';
    });
    formRoot.querySelectorAll('select').forEach((select) => {
        select.value = '';
    });
    formRoot.querySelectorAll('textarea').forEach((textarea) => {
        textarea.value = '';
    });

    // 地区回到默认值，选项卡高亮与隐藏字段保持一致
    if (plateRegion) plateRegion.value = 'mainland';
    regionTabs.forEach((tab) => {
        tab.classList.toggle('is-active', tab.dataset.region === 'mainland');
    });

    // 匹配下拉内部的选中态一并清空（不派发事件，避免触发一次校验）
    pickers.forEach((picker) => picker.reset());

    syncBranchInput();
    // 清空是程序化改动，不触发 input，重新采集一次
    refreshFormValues();
    // 校验结果一并复位，避免清空后还留着绿色的「符合格式要求」
    resetValidation(formRoot);
    // 燃料类型已清空 → 动力系统全部字段恢复可用
    applyPowertrainProfile();
    setHidden(addResult, true);
    showMessage('已清空表单', false, { type: 'info' });
}

/**
 * 清空是破坏性操作：已有内容时先确认，空表单直接重置。
 *
 * @example
 * resetAddBtn.addEventListener('click', handleReset);
 */
async function handleReset() {
    if (isFormDirty()) {
        const choice = await showConfirm({
            text: '确定清空已填写的内容吗？此操作不可撤销。',
            buttons: ['清空', '取消'],
            button_style: ['variant=danger', ''],
        });
        // showConfirm 返回按钮下标（1 起），只有「清空」才继续
        if (choice !== 1) return;
    }
    resetForm();
}

if (submitAddBtn) submitAddBtn.addEventListener('click', handleSubmit);
if (resetAddBtn) resetAddBtn.addEventListener('click', handleReset);


/* ═══════════════════════════════════════════════════════════════════════════
 * 板块三 · 批量导入
 *
 * 入口：#import-form 面板；对应菜单 data-menu="import"，也可用 ?tab=import 打开。
 * 现状：全部在浏览器本地完成——解析 CSV/XLSX → 定位表头 → 逐行校验 →
 *       分页预览；点「确认导入」只提示接口待接入。
 * 接入：替换「确认导入」按钮回调里的提示分支，提交 importState 中的合法行。
 * 内部顺序：状态与提示 → 渲染（统计 / 问题 / 预览 / 分页 / 按钮）→ 解析入口 →
 *           文件选择 / 拖拽 / 模板下载 / 确认 / 清空。
 * ═══════════════════════════════════════════════════════════════════════════ */

// 批量导入面板的节点集合：resetImport / renderImport* 都从这里取，
// 新增元素时只需在这里补一行
const importEls = {
    drop: $('import-drop'),
    pick: $('import-pick'),
    file: $('import-file'),
    template: $('import-template'),
    stat: $('import-stat'),
    notice: $('import-notice'),
    problems: $('import-problems'),
    preview: $('import-preview'),
    pager: $('import-pager'),
    confirm: $('import-confirm'),
    clear: $('import-clear'),
    result: $('import-result'),
};

/**
 * 导入面板的全部运行时状态。
 * 只在 handleImportFile / 分页 / 清空时改写；渲染函数一律从「状态」读数，
 * 保证「状态 → 视图」单向流动，便于定位问题。
 */
const importState = {
    fileName: '',   // 当前文件名，仅用于统计行展示
    encoding: '',   // parseTableFile 识别出的编码，展示用
    records: [],    // 全部数据行（含 valid=false 的行），分页在它之上进行
    errors: [],     // 表头级 + 行级错误；只要有内容就禁用「确认导入」
    page: 1,        // 当前页码，从 1 开始
    totalPages: 1,  // 由 paginate 回写
};

/**
 * 隐藏导入提示条（错误与警告共用一个节点）。
 *
 * @example
 * clearImportNotice(); // resetImport 内部会调用
 */
function clearImportNotice() {
    if (!importEls.notice) return;
    importEls.notice.textContent = '';
    setHidden(importEls.notice, true);
}

/**
 * 显示导入提示条。
 *
 * @param {string} message 文案
 * @param {'warning'|'error'} kind error 用红色样式，其余用警告样式
 * @example
 * setImportNotice('文件是空的，没有可读取的内容。', 'error');
 */
function setImportNotice(message, kind = 'warning') {
    if (!importEls.notice) return;
    importEls.notice.classList.remove('lp-warning', 'lp-invalid');
    importEls.notice.classList.add(kind === 'error' ? 'lp-invalid' : 'lp-warning');
    importEls.notice.textContent = message;
    setHidden(importEls.notice, false);
}

/**
 * 清空整个导入面板：状态复位，并把选择框、统计、问题列表、预览、分页、
 * 结果区和确认按钮都还原成初始态。换文件前也会先调用它，
 * 避免上一次的数据残留到新文件的解析结果里。
 *
 * @example
 * resetImport(); // 换文件前、或点击「清空」时调用
 */
function resetImport() {
    importState.fileName = '';
    importState.encoding = '';
    importState.records = [];
    importState.errors = [];
    importState.page = 1;
    importState.totalPages = 1;

    if (importEls.file) importEls.file.value = '';
    if (importEls.stat) {
        importEls.stat.textContent = '';
        setHidden(importEls.stat, true);
    }
    clearImportNotice();
    if (importEls.problems) {
        importEls.problems.replaceChildren();
        setHidden(importEls.problems, true);
    }
    if (importEls.preview) {
        importEls.preview.innerHTML = '';
        setHidden(importEls.preview, true);
    }
    if (importEls.pager) {
        importEls.pager.innerHTML = '';
        setHidden(importEls.pager, true);
    }
    if (importEls.result) {
        importEls.result.classList.add('hidden');
        importEls.result.textContent = '';
    }
    setDisabled(importEls.confirm, true);
    // 文件框被清空不会触发 input，重新采集一次
    refreshFormValues();
}

/**
 * 统计行：总行数 / 可写入行数 / 需修正行数 / 编码 / 文件名。
 *
 * @example
 * renderImportStat(); // 通常由 renderImportAll 统一调用
 */
function renderImportStat() {
    if (!importEls.stat) return;
    if (importState.records.length === 0) {
        importEls.stat.textContent = '';
        setHidden(importEls.stat, true);
        return;
    }
    const total = importState.records.length;
    const valid = importState.records.filter((record) => record.valid).length;
    const invalid = total - valid;
    const parts = [`已读取 ${total} 行`, `${valid} 行可写入`];
    if (invalid > 0) parts.push(`${invalid} 行需修正`);
    if (importState.encoding) parts.push(`编码 ${importState.encoding.toUpperCase()}`);
    if (importState.fileName) parts.push(importState.fileName);
    importEls.stat.textContent = parts.join(' · ');
    setHidden(importEls.stat, false);
}

/**
 * 问题列表：最多展示前 8 条，其余折叠为「…等 N 条」，避免撑爆面板。
 * field === 'header' 表示表头级问题（如缺少必需列），它没有行号，
 * 需要单独分支直接显示原始文案。
 *
 * @example
 * renderImportProblems(); // 最多展示 8 条，其余折叠为「…等 N 条」
 */
function renderImportProblems() {
    if (!importEls.problems) return;
    if (importState.errors.length === 0) {
        importEls.problems.replaceChildren();
        setHidden(importEls.problems, true);
        return;
    }

    const lines = importState.errors.slice(0, 8).map((error) => {
        // 表头错误没有行号，直接显示原文案
        if (error.field === 'header') return error.message;
        return `第 ${error.row} 行：${error.message}`;
    });
    const rest = importState.errors.length - lines.length;

    const strong = document.createElement('strong');
    strong.textContent = `共 ${importState.errors.length} 处问题`;
    const span = document.createElement('span');
    span.className = 'tt-problem-list';
    span.textContent = lines.join('；') + (rest > 0 ? `；…等 ${rest} 条` : '');

    importEls.problems.replaceChildren(strong, span);
    setHidden(importEls.problems, false);
}

/**
 * 预览表格：只渲染当前页的 records，无效行整行标红并在末列显示状态。
 * 所有单元格都经过 cellText/escapeHtml，文件内容不会被当作 HTML 执行。
 *
 * @example
 * renderImportPreview(); // 切换分页后只重渲染预览与分页条
 */
function renderImportPreview() {
    if (!importEls.preview) return;
    if (importState.records.length === 0) {
        importEls.preview.innerHTML = '';
        setHidden(importEls.preview, true);
        if (importEls.pager) {
            importEls.pager.innerHTML = '';
            setHidden(importEls.pager, true);
        }
        return;
    }

    // paginate 会把越界页码夹紧（例如清空后页码仍在旧值上），回写保持一致
    const page = paginate(importState.records, importState.page, IMPORT_PAGE_SIZE);
    importState.page = page.page;
    importState.totalPages = page.totalPages;

    const rows = page.items.map((record) => {
        const classes = ['tt-data-row'];
        if (!record.valid) classes.push('is-invalid');
        const status = record.valid ? '可写入' : '需修正';
        return `<tr class="${classes.join(' ')}">`
            + `<td class="tt-rowno">${record.row}</td>`
            + `<td>${cellText(record.selfNo)}</td>`
            + `<td>${cellText(record.company)}</td>`
            + `<td>${cellText(record.model)}</td>`
            + `<td>${cellText(record.fuelType)}</td>`
            + `<td>${cellText(record.vehicleType)}</td>`
            + `<td class="tt-time">${cellText(formatPlate(record))}</td>`
            + `<td class="tt-state">${status}</td>`
            + '</tr>';
    }).join('');

    importEls.preview.innerHTML = '<table class="tt-import-table"><thead><tr>'
        + PREVIEW_LABELS.map((label) => `<th>${escapeHtml(label)}</th>`).join('')
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
    setHidden(importEls.preview, false);

    renderImportPager(page);
}

/**
 * 分页条：只有一页时不显示。
 * 按钮是 hcw-button + data-page，每次渲染都重新绑定 click——因为 innerHTML
 * 重建后旧节点已被丢弃，无法继续复用之前的监听器。
 *
 * @param {{items: Array, page: number, totalPages: number}} page paginate 的返回值
 * @example
 * renderImportPager({ items, page: 2, totalPages: 5 });
 */
function renderImportPager(page) {
    if (!importEls.pager) return;
    importEls.pager.innerHTML = '';
    if (page.totalPages <= 1) {
        setHidden(importEls.pager, true);
        return;
    }

    // 生成单个分页按钮的 HTML 片段，例如：
    // <hcw-button class="tt-page-btn is-current" data-page="2" primary>2</hcw-button>
    const button = (target, label, current) =>
        `<hcw-button class="tt-page-btn${current ? ' is-current' : ''}" data-page="${target}"`
        + `${current ? ' primary' : ''}>${escapeHtml(label)}</hcw-button>`;

    // 首页不显示「上一页」，末页不显示「下一页」；页码按钮始终全量渲染
    const parts = [];
    if (page.page > 1) parts.push(button(page.page - 1, '上一页', false));
    for (let n = 1; n <= page.totalPages; n += 1) {
        parts.push(button(n, String(n), n === page.page));
    }
    if (page.page < page.totalPages) parts.push(button(page.page + 1, '下一页', false));

    importEls.pager.innerHTML = parts.join('');
    importEls.pager.querySelectorAll('.tt-page-btn').forEach((node) => {
        node.addEventListener('click', () => {
            importState.page = Number(node.getAttribute('data-page')) || 1;
            renderImportPreview();
        });
    });
    setHidden(importEls.pager, false);
}

/**
 * 「确认导入」按钮的启用条件：
 *   - 至少读到一行数据；
 *   - 没有任何校验错误（表头级、行级都算）；
 *   - 至少有一行 valid=true（全部是空行时也要挡住）。
 *
 * 这里是「有错就整体禁用」而不是「只导入合法行」，目的是避免用户在
 * 不知情的情况下漏导数据；点「确认」时还会再校验一次合法行数。
 *
 * @example
 * updateImportConfirm(); // 每次重绘后决定「确认导入」是否可点
 */
function updateImportConfirm() {
    const hasValid = importState.records.some((record) => record.valid);
    const blocked = importState.records.length === 0
        || importState.errors.length > 0
        || !hasValid;
    setDisabled(importEls.confirm, blocked);
}

/**
 * 状态变更后的统一重绘入口；顺序保证统计/问题先于预览与按钮更新。
 *
 * @example
 * renderImportAll(); // 解析完成、异常清理状态后调用
 */
function renderImportAll() {
    renderImportStat();
    renderImportProblems();
    renderImportPreview();
    updateImportConfirm();
}

/**
 * 读取并解析用户选择的文件（点击选择与拖拽共用同一入口）。
 *
 * 流程：resetImport → 解析（识别编码、得到二维数组）→ 定位表头 →
 * 逐行校验 → 写入 importState → 统一渲染 → 按结果给出提示。
 * 任一步失败都会清空状态并说明原因，避免上一次的结果残留。
 *
 * @param {File} file 用户选择的 CSV / XLSX 文件
 * @example
 * importEls.file.addEventListener('change', (event) => {
 *     const file = event.target.files && event.target.files[0];
 *     if (file) handleImportFile(file);
 * });
 */
async function handleImportFile(file) {
    if (!file) return;

    resetImport();
    importState.fileName = file.name || '未命名文件';
    // 解析可能是异步的，先给个占位反馈，避免用户以为没响应
    if (importEls.stat) {
        importEls.stat.textContent = '正在解析…';
        setHidden(importEls.stat, false);
    }

    let encoding = '';
    try {
        const rows = await parseTableFile(file, {
            onEncoding: (value) => { encoding = value || ''; },
        });

        // 空文件一般是选错了文件，直接报错，不展示空表格
        if (!Array.isArray(rows) || rows.length === 0) {
            setImportNotice('文件是空的，没有可读取的内容。', 'error');
            if (importEls.stat) setHidden(importEls.stat, true);
            return;
        }

        // 表头不一定在第一行（模板/导出文件前面常有说明行），需要先定位
        const headerIndex = findHeaderRowIndex(rows);
        if (headerIndex < 0) {
            setImportNotice('没有找到表头行：请把第一行写成列名。', 'error');
            if (importEls.stat) setHidden(importEls.stat, true);
            return;
        }

        // 校验结果分两部分：records 含全部行（保留 valid 标记），errors 含表头与行级问题
        const result = validateRows(rows, headerIndex);
        importState.encoding = encoding;
        importState.records = result.records;
        importState.errors = result.errors;
        importState.page = 1;

        renderImportAll();

        // 有问题行时仍保留预览，让用户能对照标红的行去修正原文件
        if (result.errors.length > 0) {
            setImportNotice('有问题的行已在预览中标红；修正后重新选择文件。', 'warning');
        } else if (result.records.length === 0) {
            setImportNotice('只有表头，没有数据行。', 'warning');
        }
    } catch (err) {
        // 解析异常（格式不支持、加密 xlsx 等）统一收敛成一条错误提示
        importState.records = [];
        importState.errors = [];
        renderImportAll();
        setImportNotice('解析失败：' + (err && err.message ? err.message : '无法读取文件'), 'error');
        if (importEls.stat) setHidden(importEls.stat, true);
    } finally {
        // 清空 input.value，保证再次选择同一个文件时仍会触发 change
        if (importEls.file) importEls.file.value = '';
        refreshFormValues();
    }
}

// 点击自定义的「选择文件」按钮 → 触发隐藏的 file input；
// change 里只取第一个文件，多选场景按单选处理
if (importEls.pick && importEls.file) {
    importEls.pick.addEventListener('click', () => importEls.file.click());
    importEls.file.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) handleImportFile(file);
    });
}

// 拖拽上传：dragover 必须 preventDefault 才能收到 drop；
// is-over 只负责高亮反馈，拖出/放下时都要清掉
if (importEls.drop) {
    importEls.drop.addEventListener('dragover', (event) => {
        event.preventDefault();
        importEls.drop.classList.add('is-over');
    });
    importEls.drop.addEventListener('dragleave', () => {
        importEls.drop.classList.remove('is-over');
    });
    importEls.drop.addEventListener('drop', (event) => {
        event.preventDefault();
        importEls.drop.classList.remove('is-over');
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) handleImportFile(file);
    });
}

/**
 * 模板下载：把内存里的 CSV 文本包成 Blob 触发下载。
 * 文本前拼 \uFEFF（BOM），否则 Excel 打开中文会乱码；下载后释放 objectURL。
 */
if (importEls.template) {
    importEls.template.addEventListener('click', () => {
        const blob = new Blob(['\uFEFF' + TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = TEMPLATE_FILENAME;
        // 部分浏览器要求链接在文档中才会触发下载，点击后立即移除
        document.body.appendChild(link);
        link.click();
        link.remove();
        // 放到下一轮事件循环再释放，避免下载尚未开始 URL 就被回收
        setTimeout(() => URL.revokeObjectURL(url), 0);
        showMessage('模板已开始下载', false, { type: 'info' });
    });
}

// 确认导入：当前只提示接口待接入；接入后在这里换成真实上传请求
if (importEls.confirm) {
    importEls.confirm.addEventListener('click', () => {
        // 双保险：按钮已禁用但事件仍可能被触发时不做事
        if (importEls.confirm.hasAttribute('disabled')) return;
        // 只统计合法行，提示里给出真正会被写入的行数
        const valid = importState.records.filter((record) => record.valid);
        if (valid.length === 0) return;

        if (importEls.result) {
            importEls.result.classList.remove('hidden', 'success', 'error', 'info');
            importEls.result.classList.add('info');
            importEls.result.textContent =
                `批量导入接口待接入：${valid.length} 行已通过本地校验，接入接口后即可写入。`;
            setHidden(importEls.result, false);
            importEls.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        showMessage('批量导入接口待接入', false, { type: 'info' });
    });
}

// 清空导入面板；重置后提示一次，让用户确认操作已生效
if (importEls.clear) {
    importEls.clear.addEventListener('click', () => {
        resetImport();
        showMessage('已清空导入面板', false, { type: 'info' });
    });
}

/* ─── 返回 / 离开提醒 ───────────────────────────────────── */

// 页面级节点：与三个面板无关，单独放在本段
const backBtn = $('back-btn');

/**
 * 返回：优先回到同站的来路页面；直接打开（或来路不可识别）时回首页。
 * 直接跳来路 URL 而不是 history.back()：页内锚点会在历史里留下 #hash 记录，
 * back() 可能只是退回上一个锚点、仍停在当前页。
 *
 * @example
 * backBtn.addEventListener('click', goBack);
 */
function goBack() {
    try {
        const ref = document.referrer ? new URL(document.referrer) : null;
        // 只跳回同源、且路径不同的来路，避免被外部页面构造的 referrer 带偏
        if (ref && ref.origin === window.location.origin && ref.pathname !== window.location.pathname) {
            window.location.assign(ref.href);
            return;
        }
    } catch {
        // 来路不是合法 URL：走下面的首页兜底
    }

    window.location.href = '/index.html';
}

/**
 * 表单里是否有需要保留的内容（隐藏字段和默认值不计）。
 *
 * @returns {boolean}
 * @example
 * if (isFormDirty()) { ... }  // handleReset：有内容才弹确认
 * if (!isFormDirty()) return; // beforeunload：没内容就直接放行
 */
function isFormDirty() {
    if (!formRoot) return false;
    // 隐藏字段不参与「脏」判断；select 的占位项 value 为空串，同样视为未填
    return Array.from(formRoot.querySelectorAll('input, select, textarea')).some((field) => {
        if (field.type === 'hidden') return false;
        return (field.value || '').trim() !== '';
    });
}

if (backBtn) backBtn.addEventListener('click', goBack);

// 填了内容后刷新 / 关闭 / 从抽屉跳转时，由浏览器给出离开确认。
// 现代浏览器会忽略自定义文案，只显示通用提示，但仍需 preventDefault
// 并把 returnValue 置空才会触发。
window.addEventListener('beforeunload', (event) => {
    if (!isFormDirty()) return;
    event.preventDefault();
    event.returnValue = '';
});

/* ─── 初始化 ─────────────────────────────────────────── */
// 初始状态：分公司输入不可用，导入确认按钮不可用
syncBranchInput();
setDisabled(importEls.confirm, true);

// 候选数据异步加载，不阻塞首屏；失败时输入框仍可正常使用
initPickers();

// 带 #section 时优先切到「添加」并滚到对应分区；hash 可能已被百分号编码，
// 解码失败时按「没有 hash」处理
let hashTarget = null;
try {
    const rawHash = window.location.hash;
    const hash = decodeURIComponent(rawHash.startsWith('#') ? rawHash.slice(1) : rawHash);
    if (hash) hashTarget = document.getElementById(hash);
} catch {
    hashTarget = null;
}

// 初始面板的选择优先级：
//   1. #hash 指向「添加」面板内的某个分区 → 切到「添加」并滚动定位
//      （从其他页面深链到具体字段的场景）；
//   2. ?tab=xxx 且是已知面板 → 切到该面板；
//   3. 兜底切到「查询」。
const requestedTab = new URLSearchParams(window.location.search).get('tab');

// 用 hasOwnProperty 判断，避免 ?tab=toString 之类的原型链属性被误判为有效面板
if (hashTarget && formRoot && formRoot.contains(hashTarget)) {
    switchPanel('add');
    requestAnimationFrame(() => hashTarget.scrollIntoView({ block: 'start' }));
} else if (requestedTab && Object.prototype.hasOwnProperty.call(panels, requestedTab)) {
    switchPanel(requestedTab);
} else {
    switchPanel('search');
}
