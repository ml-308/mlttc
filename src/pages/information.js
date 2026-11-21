// src/pages/information.js
/**
 * 车辆信息页（information.html）—— 仿 timetable 的三段式交互
 *
 *   1. 查询车辆信息：公司 / 关键词 / 车辆ID，提交后显示结果区（接口待接入）
 *   2. 添加车辆信息：单条车辆表单，只做必填项非空校验（写入接口待接入）
 *   3. 批量导入：本地解析 CSV / XLSX，表头映射、逐行校验、分页预览
 *      （确认上传只提示导入接口待接入）
 *
 * 目前不请求任何车辆接口；接入时替换 handleSearch / handleSubmit /
 * handleImportConfirm 里的提示分支即可。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { showConfirm } from '/lib/ui/popup.mjs';
import { parseTableFile } from '/lib/timetable-import.mjs';
import {
    TEMPLATE_CSV,
    TEMPLATE_FILENAME,
    PREVIEW_LABELS,
    findHeaderRowIndex,
    validateRows,
    paginate,
    formatPlate
} from '/lib/vehicle-import.mjs';

const $ = (id) => document.getElementById(id);

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_START = 1980;
const YEAR_END = CURRENT_YEAR + 10;
const IMPORT_PAGE_SIZE = 20;

/* ─── DOM ─────────────────────────────────────────────── */
const menuButtons = Array.from(document.querySelectorAll('#vehicle-menu .menu-btn'));
const panels = {
    search: $('search-form'),
    add: $('add-form'),
    import: $('import-form'),
};

const formRoot = $('vehicle-form');
const companyInput = $('company');
const branchInput = $('branch');
const branchHint = $('branch-hint');
const plateRegion = $('plate-region');
const backBtn = $('back-btn');
const regionTabs = Array.from(document.querySelectorAll('#plate-region-tabs .menu-btn'));

const searchCompanyInput = $('search-company');
const searchKeywordInput = $('search-keyword');
const searchIdInput = $('search-id');
const searchResult = $('search-result');
const resultCount = $('result-count');
const resultList = $('result-list');

const submitAddBtn = $('submitAddBtn');
const resetAddBtn = $('resetAddBtn');
const addResult = $('add-result');

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

/* ─── 通用小工具 ──────────────────────────────────────── */
function setHidden(node, hidden) {
    if (!node) return;
    node.classList.toggle('hidden', Boolean(hidden));
    if ('hidden' in node) node.hidden = Boolean(hidden);
}

/** hcw-button 没有代理 disabled：属性负责外观，expando 只给内部判断用 */
function setDisabled(node, disabled) {
    if (!node) return;
    node.disabled = Boolean(disabled);
    if (disabled) node.setAttribute('disabled', '');
    else node.removeAttribute('disabled');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function cellText(value) {
    const text = String(value ?? '').trim();
    return escapeHtml(text === '' ? '—' : text);
}

/* ─── 菜单切换 ────────────────────────────────────────── */
function switchPanel(name) {
    Object.keys(panels).forEach((key) => {
        setHidden(panels[key], key !== name);
    });
    menuButtons.forEach((button) => {
        const active = button.dataset.menu === name;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

menuButtons.forEach((button) => {
    button.addEventListener('click', () => switchPanel(button.dataset.menu));
});

/* ─── 添加：必填校验 ──────────────────────────────────── */
const requiredFields = [
    { input: $('company'), hint: $('company-hint'), message: '请输入公司名称' },
    { input: $('vehicle-model'), hint: $('vehicle-model-hint'), message: '请输入车型' },
    { input: $('fuel-type'), hint: $('fuel-type-hint'), message: '请选择燃料类型' },
    { input: $('vehicle-type'), hint: $('vehicle-type-hint'), message: '请选择车辆类型' },
    { input: $('plate-prefix'), hint: $('plate-prefix-hint'), message: '请输入车牌号前缀' },
].filter((field) => field.input && field.hint);

function validateField(field) {
    const value = (field.input.value || '').trim();
    const valid = value.length > 0;
    field.input.classList.toggle('is-invalid', !valid);
    field.hint.textContent = valid ? '' : field.message;
    field.hint.classList.toggle('lp-invalid', !valid);
    return valid;
}

function clearFieldError(field) {
    field.input.classList.remove('is-invalid');
    field.hint.textContent = '';
    field.hint.classList.remove('lp-invalid');
}

function showAddResult(message, type = 'info') {
    if (!addResult) return;
    addResult.classList.remove('hidden', 'success', 'error', 'info');
    addResult.classList.add(type);
    addResult.textContent = message;
    setHidden(addResult, false);
}

function handleSubmit() {
    setHidden(addResult, true);
    let firstInvalid = null;

    requiredFields.forEach((field) => {
        const valid = validateField(field);
        if (!valid && !firstInvalid) firstInvalid = field.input;
    });

    if (firstInvalid) {
        showMessage('请先填写必填项', true);
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstInvalid.focus({ preventScroll: true });
        return;
    }

    // 写入接口尚未接入：只保留本地校验结果
    showAddResult('写入接口待接入：必填校验已通过，接入接口后即可保存车辆信息。', 'info');
    showMessage('写入接口待接入', false, { type: 'info' });
}

requiredFields.forEach((field) => {
    ['input', 'change'].forEach((type) => {
        field.input.addEventListener(type, () => {
            if ((field.input.value || '').trim()) clearFieldError(field);
        });
    });
    field.input.addEventListener('blur', () => validateField(field));
});

/* ─── 公司 → 分公司/车队 ──────────────────────────────── */
function syncBranchInput() {
    if (!companyInput || !branchInput) return;

    const hasCompany = companyInput.value.trim().length > 0;
    branchInput.disabled = !hasCompany;
    branchInput.placeholder = hasCompany ? '输入分公司/车队名称搜索...' : '请先选择公司';
    if (branchHint) branchHint.textContent = hasCompany ? '' : '请先选择公司';
    if (!hasCompany) branchInput.value = '';
}

if (companyInput) {
    companyInput.addEventListener('input', syncBranchInput);
    companyInput.addEventListener('change', syncBranchInput);
}

/* ─── 车牌地区选项卡 ──────────────────────────────────── */
regionTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
        regionTabs.forEach((item) => item.classList.toggle('is-active', item === tab));
        if (plateRegion) plateRegion.value = tab.dataset.region || 'mainland';
    });
});

/* ─── 日期三级下拉 ────────────────────────────────────── */
function pad2(value) {
    return String(value).padStart(2, '0');
}

function daysInMonth(year, month) {
    if (!year || !month) return 31;
    return new Date(year, month, 0).getDate();
}

function fillSelect(select, items, placeholder) {
    select.replaceChildren();
    select.appendChild(new Option(placeholder, ''));
    items.forEach((item) => {
        select.appendChild(new Option(item.label, String(item.value)));
    });
}

function createDateField(root) {
    const yearSelect = root.querySelector('[data-part="year"]');
    const monthSelect = root.querySelector('[data-part="month"]');
    const daySelect = root.querySelector('[data-part="day"]');
    if (!yearSelect || !monthSelect || !daySelect) return null;

    const years = [];
    for (let year = YEAR_END; year >= YEAR_START; year -= 1) {
        years.push({ value: year, label: `${year}年` });
    }
    const months = Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        return { value: month, label: `${pad2(month)}月` };
    });

    fillSelect(yearSelect, years, '年');
    fillSelect(monthSelect, months, '月');

    function refreshDays() {
        const max = daysInMonth(Number(yearSelect.value), Number(monthSelect.value));
        const previous = Number(daySelect.value) || 0;
        const days = Array.from({ length: max }, (_, index) => {
            const day = index + 1;
            return { value: day, label: `${pad2(day)}日` };
        });
        fillSelect(daySelect, days, '日');
        if (previous >= 1 && previous <= max) daySelect.value = String(previous);
    }

    yearSelect.addEventListener('change', refreshDays);
    monthSelect.addEventListener('change', refreshDays);
    refreshDays();

    return {
        reset() {
            yearSelect.value = '';
            monthSelect.value = '';
            daySelect.value = '';
            refreshDays();
        },
    };
}

const dateGroups = ['factory-date', 'online-date', 'scrap-date']
    .map((id) => $(id))
    .filter(Boolean)
    .map(createDateField)
    .filter(Boolean);

/* ─── 清空 / 提交 ─────────────────────────────────────── */
function resetForm() {
    if (!formRoot) return;

    formRoot.querySelectorAll('input').forEach((input) => {
        if (input.type !== 'hidden') input.value = '';
    });
    formRoot.querySelectorAll('select').forEach((select) => {
        select.value = '';
    });
    formRoot.querySelectorAll('textarea').forEach((textarea) => {
        textarea.value = '';
    });

    requiredFields.forEach(clearFieldError);

    if (plateRegion) plateRegion.value = 'mainland';
    regionTabs.forEach((tab) => {
        tab.classList.toggle('is-active', tab.dataset.region === 'mainland');
    });
    dateGroups.forEach((group) => group.reset());

    syncBranchInput();
    setHidden(addResult, true);
    showMessage('已清空表单', false, { type: 'info' });
}

/** 清空是破坏性操作：已有内容时先确认，空表单直接重置 */
async function handleReset() {
    if (isFormDirty()) {
        const choice = await showConfirm({
            text: '确定清空已填写的内容吗？此操作不可撤销。',
            buttons: ['清空', '取消'],
            button_style: ['variant=danger', ''],
        });
        if (choice !== 1) return;
    }
    resetForm();
}

if (submitAddBtn) submitAddBtn.addEventListener('click', handleSubmit);
if (resetAddBtn) resetAddBtn.addEventListener('click', handleReset);

/* ─── 查询：接口留空，只展示结果区结构 ───────────────── */
function clearSearchResult() {
    setHidden(searchResult, true);
    resultList.replaceChildren();
    resultCount.textContent = '共 0 条结果';
    searchIdInput?.classList.remove('is-invalid');
}

function handleSearch() {
    const company = searchCompanyInput.value.trim();
    const keyword = searchKeywordInput.value.trim();
    const id = searchIdInput.value.trim();

    if (id && !/^\d{12}$/.test(id)) {
        searchIdInput.classList.add('is-invalid');
        showMessage('车辆ID应为12位数字', true);
        searchIdInput.focus();
        return;
    }
    searchIdInput.classList.remove('is-invalid');

    if (!company && !keyword && !id) {
        showMessage('请输入至少一个查询条件', true);
        searchCompanyInput.focus();
        return;
    }

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

if (searchIdInput) {
    searchIdInput.addEventListener('input', () => searchIdInput.classList.remove('is-invalid'));
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
[searchCompanyInput, searchKeywordInput, searchIdInput].forEach((input) => {
    if (!input) return;
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleSearch();
        }
    });
});

/* ─── 批量导入：本地解析 / 校验 / 预览 ───────────────── */
const importState = {
    fileName: '',
    encoding: '',
    records: [],
    errors: [],
    page: 1,
    totalPages: 1,
};

function clearImportNotice() {
    if (!importEls.notice) return;
    importEls.notice.textContent = '';
    setHidden(importEls.notice, true);
}

function setImportNotice(message, kind = 'warning') {
    if (!importEls.notice) return;
    importEls.notice.classList.remove('lp-warning', 'lp-invalid');
    importEls.notice.classList.add(kind === 'error' ? 'lp-invalid' : 'lp-warning');
    importEls.notice.textContent = message;
    setHidden(importEls.notice, false);
}

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
}

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

function renderImportProblems() {
    if (!importEls.problems) return;
    if (importState.errors.length === 0) {
        importEls.problems.replaceChildren();
        setHidden(importEls.problems, true);
        return;
    }

    const lines = importState.errors.slice(0, 8).map((error) => {
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

function renderImportPager(page) {
    if (!importEls.pager) return;
    importEls.pager.innerHTML = '';
    if (page.totalPages <= 1) {
        setHidden(importEls.pager, true);
        return;
    }

    const button = (target, label, current) =>
        `<hcw-button class="tt-page-btn${current ? ' is-current' : ''}" data-page="${target}"`
        + `${current ? ' primary' : ''}>${escapeHtml(label)}</hcw-button>`;

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

function updateImportConfirm() {
    const hasValid = importState.records.some((record) => record.valid);
    const blocked = importState.records.length === 0
        || importState.errors.length > 0
        || !hasValid;
    setDisabled(importEls.confirm, blocked);
}

function renderImportAll() {
    renderImportStat();
    renderImportProblems();
    renderImportPreview();
    updateImportConfirm();
}

async function handleImportFile(file) {
    if (!file) return;

    resetImport();
    importState.fileName = file.name || '未命名文件';
    if (importEls.stat) {
        importEls.stat.textContent = '正在解析…';
        setHidden(importEls.stat, false);
    }

    let encoding = '';
    try {
        const rows = await parseTableFile(file, {
            onEncoding: (value) => { encoding = value || ''; },
        });

        if (!Array.isArray(rows) || rows.length === 0) {
            setImportNotice('文件是空的，没有可读取的内容。', 'error');
            if (importEls.stat) setHidden(importEls.stat, true);
            return;
        }

        const headerIndex = findHeaderRowIndex(rows);
        if (headerIndex < 0) {
            setImportNotice('没有找到表头行：请把第一行写成列名。', 'error');
            if (importEls.stat) setHidden(importEls.stat, true);
            return;
        }

        const result = validateRows(rows, headerIndex);
        importState.encoding = encoding;
        importState.records = result.records;
        importState.errors = result.errors;
        importState.page = 1;

        renderImportAll();

        if (result.errors.length > 0) {
            setImportNotice('有问题的行已在预览中标红；修正后重新选择文件。', 'warning');
        } else if (result.records.length === 0) {
            setImportNotice('只有表头，没有数据行。', 'warning');
        }
    } catch (err) {
        importState.records = [];
        importState.errors = [];
        renderImportAll();
        setImportNotice('解析失败：' + (err && err.message ? err.message : '无法读取文件'), 'error');
        if (importEls.stat) setHidden(importEls.stat, true);
    } finally {
        if (importEls.file) importEls.file.value = '';
    }
}

if (importEls.pick && importEls.file) {
    importEls.pick.addEventListener('click', () => importEls.file.click());
    importEls.file.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) handleImportFile(file);
    });
}

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

if (importEls.template) {
    importEls.template.addEventListener('click', () => {
        const blob = new Blob(['\uFEFF' + TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = TEMPLATE_FILENAME;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        showMessage('模板已开始下载', false, { type: 'info' });
    });
}

if (importEls.confirm) {
    importEls.confirm.addEventListener('click', () => {
        if (importEls.confirm.hasAttribute('disabled')) return;
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

if (importEls.clear) {
    importEls.clear.addEventListener('click', () => {
        resetImport();
        showMessage('已清空导入面板', false, { type: 'info' });
    });
}

/* ─── 返回 / 离开提醒 ─────────────────────────────────── */
/**
 * 返回：优先回到同站的来路页面；直接打开（或来路不可识别）时回首页。
 * 直接跳来路 URL 而不是 history.back()：页内锚点会在历史里留下 #hash 记录，
 * back() 可能只是退回上一个锚点、仍停在当前页。
 */
function goBack() {
    try {
        const ref = document.referrer ? new URL(document.referrer) : null;
        if (ref && ref.origin === window.location.origin && ref.pathname !== window.location.pathname) {
            window.location.assign(ref.href);
            return;
        }
    } catch {
        // 来路不是合法 URL：走下面的首页兜底
    }

    window.location.href = '/index.html';
}

/** 表单里是否有需要保留的内容（隐藏字段和默认值不计） */
function isFormDirty() {
    if (!formRoot) return false;
    return Array.from(formRoot.querySelectorAll('input, select, textarea')).some((field) => {
        if (field.type === 'hidden') return false;
        return (field.value || '').trim() !== '';
    });
}

if (backBtn) backBtn.addEventListener('click', goBack);

// 填了内容后刷新 / 关闭 / 从抽屉跳转时，由浏览器给出离开确认
window.addEventListener('beforeunload', (event) => {
    if (!isFormDirty()) return;
    event.preventDefault();
    event.returnValue = '';
});

/* ─── 初始化 ──────────────────────────────────────────── */
syncBranchInput();
setDisabled(importEls.confirm, true);

// 带 ?tab= 可直接打开某个模块；带 #section 时优先切到「添加」并滚到对应分区
let hashTarget = null;
try {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
    if (hash) hashTarget = document.getElementById(hash);
} catch {
    hashTarget = null;
}

const requestedTab = new URLSearchParams(window.location.search).get('tab');

if (hashTarget && formRoot && formRoot.contains(hashTarget)) {
    switchPanel('add');
    requestAnimationFrame(() => hashTarget.scrollIntoView({ block: 'start' }));
} else if (requestedTab && Object.prototype.hasOwnProperty.call(panels, requestedTab)) {
    switchPanel(requestedTab);
} else {
    switchPanel('search');
}
