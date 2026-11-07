// lib/ui/timetable-import.mjs
/**
 * 时刻表页「批量导入」面板 —— 唯一实现
 *
 * 只服务 timetable.html 的 #import-form，负责整条导入链路：
 *   选择/拖入 .csv 或 .xlsx → 解析（lib/timetable-import.mjs）→ 校验
 *   → 分页预览（每页 20 行，切页不重新解析）→ 二次确认
 *   → 按 20 行一批【串行】POST /api/timetable-import-D1 → 逐批报告结果
 *
 * 分批策略（后端 items 只接受 1..20 条）：
 *   - 合法行 ≤ 20：单请求提交，完全原子；
 *   - 合法行 > 20：按 20 行切片，第 k 批成功后才发第 k+1 批（绝不并发）；
 *   - 任一批 429 / 4xx：立即停止，已成功的批不重发；429 时给「继续提交剩余」按钮，
 *     从【未写入的那一批】继续（该批仍留在队列里，跳过就会丢行）；
 *   - 校验不通过的行依然整批阻止上传。
 *
 * 页面需要提供的骨架（见 timetable.html 的 #import-form，全部包在 #import-body 里）：
 *   import-drop / import-pick / import-file / import-template
 *   import-stat / import-notice / import-problems
 *   import-preview / import-pager
 *   import-confirm / import-continue / import-clear / import-result
 *
 * 用法：
 *   import { createImportPanel } from '/lib/ui/timetable-import.mjs';
 *   createImportPanel({ mount: document.getElementById('import-body') });
 *
 * 可注入项（便于无浏览器环境跑测试）：
 *   mount          挂载点（必填，其余元素都在它下面按 id 查找）
 *   getWriter      取写入者，默认 GET /api/profile 拿邮箱
 *   fetchImpl      网络实现，默认全局 fetch
 *   confirmImpl    二次确认弹窗，默认 lib/ui/popup.mjs 的 showConfirm
 *   notify         轻提示，默认 lib/ui/message.mjs 的 showMessage
 *   now            取当前时间，默认 new Date()（用于 writetime）
 *
 * 返回 { setFile, setRows, getState }：
 *   setFile(file)  → Promise，走 parseTableFile
 *   setRows(rows)  → 直接吃「含表头行的二维数组」，跳过文件读取（测试/复用入口）
 *   getState()     → 当前解析结果、分批计划与提交进度的快照
 */

import {
    parseTableFile,
    validateRows,
    paginate,
    mapHeader,
    findHeaderRowIndex,
    TEMPLATE_CSV,
    buildImportBody
} from '../timetable-import.mjs';
import { showMessage } from './message.mjs';
import { showConfirm } from './popup.mjs';
import { createGuard } from './guard.mjs';
import { loadCityData, getCityData } from '../data/city-data.mjs';

/** 预览每页行数 */
export const PAGE_SIZE = 20;
/** 单批上传上限，也是自动分批的批大小（后端 items 允许 1..20） */
export const BATCH_SIZE = 20;
/** 批量写入接口 */
export const IMPORT_API = '/api/timetable-import-D1';

/** 与 lib/timetable-import.mjs 的 FIELDS 同序：表头认不出来时按这个列序回显原始内容 */
const FIELDS_ORDER = ['city', 'way', 'start', 'end', 'special', 'time1', 'time2', 'etime'];

/** 预览里时刻列最多显示几个时刻，其余用省略号 */
const TIME_PREVIEW_ITEMS = 6;
/** 非法行清单最多列几条 */
const MAX_PROBLEM_LINES = 5;
/** 后端 errors 最多列几条 */
const MAX_RESULT_LINES = 5;
/** 写入成功后要失效的「我的时刻表」缓存键 */
const MY_TIMETABLE_CACHE = 'my_timetable_cache';
/** 导入限流窗口（LIMITS.import = 5 次 / 600 秒），429 拿不到 retryAfter 时用它兜底 */
const IMPORT_WINDOW_SECONDS = 600;

const TEMPLATE_FILENAME = '时刻表导入模板.csv';
const TEMPLATE_TYPE = 'text/csv;charset=utf-8';

/** 预览表头，顺序即列顺序 */
const TH_LABELS = [
    '行号', '城市', '线路', '起点站', '终点站', '备注',
    '主站→副站', '副站→主站', '执行时间', '状态'
];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/** 空值统一显示成破折号，避免表格出现空洞 */
function cell(value) {
    const text = String(value ?? '').trim();
    return escapeHtml(text === '' ? '—' : text);
}

/** 本地日期 YYYY-MM-DD */
function formatDate(date) {
    const d = date instanceof Date ? date : new Date();
    const pad = (n) => ('0' + n).slice(-2);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 时刻串只显示前 6 个（入库格式是 'HH:MM\tHH:MM\t'），后面用省略号，
 * 不要整串塞进单元格
 */
function timePreview(value) {
    const text = String(value ?? '');
    const items = text.split(/[\t\n\r\s]+/).filter(Boolean);
    if (items.length === 0) return '';
    if (items.length <= TIME_PREVIEW_ITEMS) return items.join(' ');
    return items.slice(0, TIME_PREVIEW_ITEMS).join(' ') + ' …';
}

/** 同时用 hidden 属性与 .hidden 类（站点两套写法都在用） */
function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) {
        node.classList.add('hidden');
        node.hidden = true;
    } else {
        node.classList.remove('hidden');
        node.hidden = false;
    }
}

/**
 * 设置 hcw-button / 原生元素的禁用态 —— 唯一入口，属性与 expando 一起动
 *
 * hcw-button 没有代理 disabled（lib/ui/init.mjs 的 HcwButton 只代理 style / onclick），
 * 内部渲染成 div.inner-root 而非原生 button，所以：
 *   - 灰态只由宿主元素上的 disabled 属性决定（lib/ui/templates.html: :host([disabled])>.inner-root）；
 *   - 直接写 .disabled 既不改变外观也不阻止点击。
 * 属性因此是唯一可信来源，组件内一律用 hasAttribute('disabled') 判断，读取仍兼容 .disabled。
 */
function setDisabled(node, flag) {
    if (!node) return;
    node.disabled = flag;
    if (flag) node.setAttribute('disabled', '');
    else node.removeAttribute('disabled');
}

/** 让「我的时刻表」页下次加载拿最新数据；非浏览器环境静默跳过 */
function dropMyTimetableCache() {
    try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(MY_TIMETABLE_CACHE);
    } catch {
        /* 隐私模式 / 测试环境：忽略 */
    }
}

/**
 * 解析一整张表（含表头行）为预览用的行模型
 * - records / errors 直接来自 validateRows（有错的行不进 records）
 * - views 覆盖全部非空数据行（含非法行），供表格渲染与分页使用
 */
function analyzeTable(rows, cityData) {
    const source = Array.isArray(rows) ? rows : [];
    const { records, errors } = validateRows(source, { cityData });
    // 表头行由 findHeaderRowIndex 定位（可能不在第 1 行），与 validateRows 保持同一判断
    const headerIndex = findHeaderRowIndex(source);
    const headerRow = headerIndex >= 0 && Array.isArray(source[headerIndex]) ? source[headerIndex] : [];
    const { indices } = mapHeader(headerRow);

    const recordByRow = new Map();
    for (const record of records) recordByRow.set(record.row, record);

    const firstErrorByRow = new Map();
    for (const error of errors) {
        if (!firstErrorByRow.has(error.row)) firstErrorByRow.set(error.row, error.message);
    }

    const views = [];
    for (let i = headerIndex + 1; i < source.length; i++) {
        const raw = Array.isArray(source[i]) ? source[i] : [];
        // 与 validateRows 一致：整行皆空的表格行不计入
        if (raw.every((value) => String(value ?? '').trim() === '')) continue;

        const row = i + 1;
        const record = recordByRow.get(row) || null;
        const rawCell = (field) => {
            // 表头认不出来时（index < 0）按标准列序回显原始内容，
            // 让用户能对着「缺哪些列」的提示自查，而不是看到一列「—」
            const index = indices[field] >= 0 ? indices[field] : FIELDS_ORDER.indexOf(field);
            if (index < 0 || index >= raw.length) return '';
            return String(raw[index] ?? '').trim();
        };

        views.push({
            row,
            invalid: !record,
            city: record ? record.city : rawCell('city'),
            way: record ? record.way : rawCell('way'),
            start: record ? record.start : rawCell('start'),
            end: record ? record.end : rawCell('end'),
            special: record ? record.special : rawCell('special'),
            time1: record ? record.time1 : rawCell('time1'),
            time2: record ? record.time2 : rawCell('time2'),
            etime: record ? record.etime : rawCell('etime'),
            status: record ? '待上传' : (firstErrorByRow.get(row) || '校验未通过')
        });
    }

    return { records, errors, views };
}

/**
 * 把合法记录切成每批 BATCH_SIZE 条
 * 每批带自己的表格行号范围（records[k].row 来自 Excel 行号），用于结果区展示
 */
function buildBatches(records) {
    const batches = [];
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const slice = records.slice(i, i + BATCH_SIZE);
        batches.push({
            index: batches.length + 1,
            from: slice[0].row,
            to: slice[slice.length - 1].row,
            records: slice,
            state: 'pending',
            inserted: 0,
            note: ''
        });
    }
    return batches;
}

/** 「第 2-21 行」；只有一行时写「第 2 行」 */
function rangeLabel(batch) {
    return batch.from === batch.to ? `第 ${batch.from} 行` : `第 ${batch.from}-${batch.to} 行`;
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */

export function createImportPanel(options = {}) {
    const mount = options.mount || null;
    const fetchImpl = options.fetchImpl
        || (typeof fetch === 'function' ? (...args) => fetch(...args) : null);

    /** 默认取写入者：与单条提交一致，从 /api/profile 拿邮箱 */
    const requestProfile = async () => {
        if (!fetchImpl) return '';
        try {
            const res = await fetchImpl('/api/profile', { credentials: 'include' });
            if (!res || !res.ok) return '';
            const data = await res.json();
            return (data && (data.user?.email || data.email)) || '';
        } catch {
            return '';
        }
    };

    const getWriter = options.getWriter || requestProfile;
    const confirmImpl = options.confirmImpl || showConfirm;
    const notify = options.notify || showMessage;
    const now = options.now || (() => new Date());
    const guard = createGuard('正在上传，请稍候…');

    // 城市库：城市列必须能匹配到库内写法，所以解析前要确保数据已就绪
    // （页面上的城市选择器通常已加载好，这里直接命中缓存；否则自己拉一次）
    const loadCityDataImpl = options.loadCityDataImpl || loadCityData;
    let cityData = options.cityData || null;

    async function ensureCityData() {
        if (!cityData) cityData = getCityData() || await loadCityDataImpl();
        return cityData;
    }

    function currentCityData() {
        return cityData || options.cityData || getCityData() || null;
    }

    const el = (id) => (mount ? mount.querySelector('#' + id) : null);
    const els = {
        drop: el('import-drop'),
        pick: el('import-pick'),
        file: el('import-file'),
        template: el('import-template'),
        stat: el('import-stat'),
        notice: el('import-notice'),
        problems: el('import-problems'),
        preview: el('import-preview'),
        pager: el('import-pager'),
        confirm: el('import-confirm'),
        continueBtn: el('import-continue'),
        clear: el('import-clear'),
        result: el('import-result')
    };

    const state = {
        fileName: '',
        /** 文件实际采用的文本编码（GB18030 / UTF-16LE 等；UTF-8 时不显示） */
        encoding: '',
        rows: [],
        records: [],
        errors: [],
        views: [],
        page: 1,
        /** 提交中（按钮 disabled、进度条可见） */
        busy: false,
        /** 当前这一轮的分批计划：{ batches, cursor, writer, writetime } */
        run: null,
        /** 最近一次请求体，便于排查 */
        lastPayload: null,
        lastStatus: 0
    };

    /* ---------------- 渲染 ---------------- */

    function renderStat(page) {
        if (!els.stat) return;
        if (page.total === 0) {
            els.stat.textContent = state.busy
                ? ''
                : `尚未选择文件（支持 .csv / .xlsx，每页 ${PAGE_SIZE} 行，超过 ${BATCH_SIZE} 行会自动分批提交）`;
            return;
        }
        const invalidRowCount = new Set(state.errors.map((error) => error.row)).size;
        const parts = [`共 ${page.total} 行`, `第 ${page.page}/${page.totalPages} 页`];
        parts.push(invalidRowCount > 0
            ? `${invalidRowCount} 行有问题`
            : `合法 ${state.records.length} 条`);
        // 非 UTF-8 文件把实际编码显示出来，乱码时用户能立刻看到是编码判定
        if (state.encoding && state.encoding !== 'utf-8') parts.push(`编码 ${state.encoding.toUpperCase()}`);
        els.stat.textContent = parts.join(' / ');
    }

    /** 提交进度：正在提交第 k/n 批（已成功 x 行） */
    function renderProgress() {
        if (!els.notice) return;
        const run = state.run;
        if (!state.busy || !run) {
            els.notice.textContent = '';
            setHidden(els.notice, true);
            return;
        }
        const total = run.batches.length;
        const current = Math.min(run.cursor + 1, total);
        els.notice.textContent =
            `正在提交第 ${current}/${total} 批（已成功 ${writtenCount(run)} 行）`;
        setHidden(els.notice, false);
    }

    function renderProblems() {
        if (!els.problems) return;
        if (state.errors.length === 0) {
            els.problems.textContent = '';
            setHidden(els.problems, true);
            return;
        }
        const badRows = [...new Set(state.errors.map((error) => error.row))];
        const lines = badRows.slice(0, MAX_PROBLEM_LINES).map((row) => {
            const first = state.errors.find((error) => error.row === row);
            // 表头错误属于「整张表」而不是某一行，不加「第 N 行」前缀免得误解
            if (first && first.field === 'header') return first.message;
            return `第 ${row} 行：${first ? first.message : '校验未通过'}`;
        });
        const rest = badRows.length - lines.length;
        els.problems.innerHTML =
            `<strong>共 ${state.errors.length} 处问题，修正后才能上传</strong>`
            + `<span class="tt-problem-list">${escapeHtml(lines.join('；'))}`
            + (rest > 0 ? `；…等 ${rest} 条` : '')
            + '</span>';
        setHidden(els.problems, false);
    }

    function rowHtml(view) {
        const cls = view.invalid ? 'tt-data-row is-invalid' : 'tt-data-row';
        return `<tr class="${cls}">`
            + `<td class="tt-rowno">${view.row}</td>`
            + `<td>${cell(view.city)}</td>`
            + `<td>${cell(view.way)}</td>`
            + `<td>${cell(view.start)}</td>`
            + `<td>${cell(view.end)}</td>`
            + `<td>${cell(view.special)}</td>`
            + `<td class="tt-time">${cell(timePreview(view.time1))}</td>`
            + `<td class="tt-time">${cell(timePreview(view.time2))}</td>`
            + `<td class="tt-time">${cell(view.etime)}</td>`
            + `<td class="tt-state">${cell(view.status)}</td>`
            + '</tr>';
    }

    function renderPreview(page) {
        if (!els.preview) return;
        if (page.total === 0) {
            els.preview.innerHTML = '';
            setHidden(els.preview, true);
            return;
        }
        els.preview.innerHTML = '<table class="tt-import-table"><thead><tr>'
            + TH_LABELS.map((label) => `<th>${escapeHtml(label)}</th>`).join('')
            + '</tr></thead><tbody>'
            + page.items.map(rowHtml).join('')
            + '</tbody></table>';
        setHidden(els.preview, false);
    }

    function goToPage(target) {
        state.page = target;
        render();
    }

    function renderPager(page) {
        if (!els.pager) return;
        els.pager.innerHTML = '';
        if (page.totalPages <= 1) {
            setHidden(els.pager, true);
            return;
        }
        const button = (target, label, current) =>
            `<hcw-button class="tt-page-btn${current ? ' is-current' : ''}" data-page="${target}"`
            + `${current ? ' primary' : ''}>${escapeHtml(label)}</hcw-button>`;

        const parts = [];
        if (page.page > 1) parts.push(button(page.page - 1, '上一页', false));
        for (let n = 1; n <= page.totalPages; n++) parts.push(button(n, String(n), n === page.page));
        if (page.page < page.totalPages) parts.push(button(page.page + 1, '下一页', false));

        els.pager.innerHTML = parts.join('');
        els.pager.querySelectorAll('.tt-page-btn').forEach((node) => {
            node.addEventListener('click', () => goToPage(Number(node.getAttribute('data-page'))));
        });
        setHidden(els.pager, false);
    }

    function updateConfirm() {
        const blocked =
            state.busy
            || state.records.length === 0
            || state.errors.length > 0
            // 已有成功批次时只允许「继续提交剩余」，再点确认会从头重发、撞 409
            || (state.run !== null && state.run.cursor > 0);
        setDisabled(els.confirm, blocked);
        // 提交中锁住「清空 / 继续」，避免中途把 state.run 清掉（真正的点击守卫在
        // clearAll / handleContinue 里，属性只负责灰态）
        setDisabled(els.clear, state.busy);
        setDisabled(els.continueBtn, state.busy);
        if (els.continueBtn && state.busy) setHidden(els.continueBtn, true);
    }

    function render() {
        const page = paginate(state.views, state.page, PAGE_SIZE);
        state.page = page.page;
        renderStat(page);
        renderProgress();
        renderProblems();
        renderPreview(page);
        renderPager(page);
        updateConfirm();
        return page;
    }

    /**
     * @param {'success'|'error'|'info'} kind
     * @param {string} text 结论行
     * @param {string[]} [lines] 逐批明细
     */
    function showResult(kind, text, lines) {
        if (!els.result) return;
        els.result.className = 'result-card ' + kind;
        let html = `<p><strong>${escapeHtml(text)}</strong></p>`;
        if (Array.isArray(lines) && lines.length > 0) {
            html += '<ul class="tt-batch-list">'
                + lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')
                + '</ul>';
        }
        els.result.innerHTML = html;
        setHidden(els.result, false);
    }

    function showContinue(visible, remainingRows) {
        if (!els.continueBtn) return;
        if (!visible) {
            setHidden(els.continueBtn, true);
            return;
        }
        els.continueBtn.textContent = `继续提交剩余 ${remainingRows} 行`;
        setHidden(els.continueBtn, false);
    }

    /* ---------------- 状态写入 ---------------- */

    function resetPreview() {
        state.rows = [];
        state.records = [];
        state.errors = [];
        state.views = [];
        state.page = 1;
        state.run = null;
        state.lastPayload = null;
        if (els.file) els.file.value = '';
        render();
        showContinue(false);
    }

    function setRows(rows, encoding = '') {
        const source = Array.isArray(rows) ? rows : [];
        const { records, errors, views } = analyzeTable(source, currentCityData());
        state.rows = source;
        state.records = records;
        state.errors = errors;
        state.views = views;
        state.encoding = encoding;
        state.page = 1;
        state.run = null;
        render();
        showContinue(false);
        return getState();
    }

    async function setFile(file) {
        if (!file) return getState();
        state.fileName = String(file.name || '');
        try {
            notify(`正在解析 ${state.fileName || '文件'}…`, false, { type: 'info' });
            // 城市列要按城市库匹配，先把数据准备好（已加载时直接命中缓存，不发请求）
            await ensureCityData();
            // onEncoding：文本文件自动判定的实际编码（GBK/GB18030/UTF-16 都能读）
            let detected = '';
            const rows = await parseTableFile(file, {
                onEncoding: (encoding) => { detected = encoding; }
            });
            setRows(rows, detected);
            if (state.views.length === 0) {
                showResult('error', '文件里没有可识别的数据行，请确认第一行是表头');
                notify('文件里没有可识别的数据行', true);
            } else {
                setHidden(els.result, true);
            }
        } catch (error) {
            const message = (error && error.message) || String(error);
            resetPreview();
            showResult('error', '解析失败：' + message);
            notify('解析失败：' + message, true);
        }
        return getState();
    }

    function getState() {
        const total = state.views.length;
        const run = state.run;
        return {
            fileName: state.fileName,
            total,
            page: state.page,
            pageSize: PAGE_SIZE,
            totalPages: total === 0 ? 0 : Math.ceil(total / PAGE_SIZE),
            records: state.records.length,
            errors: state.errors.length,
            invalidRows: [...new Set(state.errors.map((error) => error.row))],
            batchSize: BATCH_SIZE,
            batchCount: state.records.length === 0
                ? 0
                : Math.ceil(state.records.length / BATCH_SIZE),
            // 属性才是 hcw-button 的真实禁用状态（.disabled 只是镜像的 expando）
            canUpload: Boolean(els.confirm) && !els.confirm.hasAttribute('disabled'),
            busy: state.busy,
            run: run
                ? {
                    cursor: run.cursor,
                    written: writtenCount(run),
                    batches: run.batches.map((batch) => ({
                        index: batch.index,
                        from: batch.from,
                        to: batch.to,
                        size: batch.records.length,
                        state: batch.state,
                        inserted: batch.inserted,
                        note: batch.note
                    }))
                }
                : null,
            lastPayload: state.lastPayload,
            lastStatus: state.lastStatus
        };
    }

    /* ---------------- 模板下载 ---------------- */

    function downloadTemplate() {
        const docRef = (mount && mount.ownerDocument)
            || (typeof document !== 'undefined' ? document : null);
        try {
            if (typeof Blob === 'undefined' || typeof URL === 'undefined'
                || typeof URL.createObjectURL !== 'function') {
                throw new Error('当前环境不支持文件下载');
            }
            // 前置 BOM，否则 Excel 打开中文会乱码
            const blob = new Blob(['\uFEFF' + TEMPLATE_CSV], { type: TEMPLATE_TYPE });
            const url = URL.createObjectURL(blob);
            const link = docRef.createElement('a');
            link.href = url;
            link.download = TEMPLATE_FILENAME;
            docRef.body.appendChild(link);
            link.click?.();
            docRef.body.removeChild(link);
            if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
            notify('模板已开始下载', false, { type: 'info' });
        } catch (error) {
            notify('模板下载失败：' + ((error && error.message) || String(error)), true);
        }
    }

    /* ---------------- 上传：分批串行提交 ---------------- */

    /** 后端 errors → 一行说明；row 为 0 的是批级错误，不能当行号用 */
    function describeErrors(errors) {
        if (!Array.isArray(errors) || errors.length === 0) return '';
        const lines = [];
        for (const item of errors.slice(0, MAX_RESULT_LINES)) {
            const rowNo = Number(item && item.row);
            const message = String((item && item.message) || '').trim();
            if (!message) continue;
            lines.push(rowNo >= 1 ? `第 ${rowNo} 行：${message}` : message);
        }
        const rest = errors.length - lines.length;
        if (rest > 0) lines.push(`等 ${rest} 条`);
        return lines.join(' · ');
    }

    function readRetryAfter(res, data) {
        const fromBody = Number(data && data.retryAfter);
        if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
        const header = res && res.headers && typeof res.headers.get === 'function'
            ? Number(res.headers.get('Retry-After'))
            : NaN;
        if (Number.isFinite(header) && header > 0) return Math.ceil(header);
        return IMPORT_WINDOW_SECONDS;
    }

    function writtenCount(run) {
        return run.batches.reduce((sum, batch) => sum + (batch.state === 'ok' ? batch.inserted : 0), 0);
    }

    /** 提交一批；返回 { kind: 'ok' | 'rate-limit' | 'error', ... } */
    async function submitBatch(run, batch) {
        const payload = buildImportBody(batch.records, run.writer, run.writetime);
        state.lastPayload = payload;

        const res = await fetchImpl(IMPORT_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        state.lastStatus = res && typeof res.status === 'number' ? res.status : 0;

        let data = null;
        try {
            data = await res.json();
        } catch {
            data = null;
        }

        if (res && res.ok) {
            const inserted = Number((data && data.inserted) ?? batch.records.length);
            batch.state = 'ok';
            batch.inserted = Number.isFinite(inserted) ? inserted : batch.records.length;
            batch.note = `已写入 ${batch.inserted} 条`;
            return { kind: 'ok' };
        }

        const message = (data && data.message) || (data && data.error) || '导入失败';
        const detail = describeErrors(data && data.errors);
        batch.note = `${message}${detail ? '：' + detail : ''}`;

        if (state.lastStatus === 429) {
            return { kind: 'rate-limit', message, wait: readRetryAfter(res, data) };
        }
        return { kind: 'error', message, detail };
    }

    /** 从 run.cursor 开始串行提交剩余批次（已成功的批不会被重发） */
    async function runBatches() {
        const run = state.run;
        if (!run) return;
        if (!fetchImpl) {
            notify('当前环境不支持网络请求', true);
            return;
        }
        if (!run.writer) {
            const writer = await getWriter();
            if (!writer) {
                notify('请先登录', true);
                return;
            }
            run.writer = writer;
            run.writetime = formatDate(now());
        }

        state.busy = true;
        showContinue(false);
        updateConfirm();
        let stopped = null;

        try {
            for (let i = run.cursor; i < run.batches.length; i++) {
                run.cursor = i;
                renderProgress();

                const batch = run.batches[i];
                let result;
                try {
                    result = await submitBatch(run, batch);
                } catch (error) {
                    result = {
                        kind: 'error',
                        message: '网络错误：' + ((error && error.message) || String(error))
                    };
                    batch.note = result.message;
                }

                if (result.kind === 'ok') {
                    run.cursor = i + 1;
                    dropMyTimetableCache();
                    continue;
                }
                // 429 / 4xx：停止后续批次；run.cursor 停在未写入的这一批
                stopped = { ...result, batch };
                break;
            }
        } finally {
            state.busy = false;
        }

        finishRun(run, stopped);
    }

    function finishRun(run, stopped) {
        const totalBatches = run.batches.length;
        const written = writtenCount(run);
        const remainingRows = run.batches
            .slice(run.cursor)
            .reduce((sum, batch) => sum + batch.records.length, 0);
        const details = totalBatches > 1 || stopped
            ? run.batches.map((batch) => {
                const head = `第 ${batch.index} 批（${rangeLabel(batch)}）：`;
                if (batch.state === 'ok') return head + batch.note;
                if (batch === (stopped && stopped.batch)) return head + '未写入 · ' + batch.note;
                return head + '未提交';
            })
            : [];

        // 全部批次成功
        if (!stopped && run.cursor >= totalBatches) {
            const head = totalBatches > 1
                ? `导入成功：分 ${totalBatches} 批写入 ${written} 条时刻表`
                : `导入成功：已写入 ${written} 条时刻表`;
            showResult('success', head, details);
            notify('导入成功', false);
            resetPreview();
            return;
        }

        const head = written > 0
            ? `部分完成：已写入 ${written} 行，剩余 ${remainingRows} 行未提交`
            : `未能写入：剩余 ${remainingRows} 行都未提交`;
        const doneBatches = run.batches.filter((batch) => batch.state === 'ok').length;
        const failedIndex = stopped ? stopped.batch.index : run.cursor + 1;
        const failedRange = stopped ? rangeLabel(stopped.batch) : '剩余';
        const tail = stopped && stopped.kind === 'rate-limit'
            ? `请在 ${stopped.wait} 秒后继续`
            : (doneBatches > 0 ? `前 ${doneBatches} 批已写入、` : '')
                + `第 ${failedIndex} 批（${failedRange}）未写入，请修正数据后重新导入`;

        showResult(
            stopped && stopped.kind === 'rate-limit' ? 'info' : 'error',
            `${head}。${tail}`,
            details
        );
        notify(
            stopped && stopped.kind === 'rate-limit'
                ? '部分完成，可稍后继续提交'
                : '导入中止：' + ((stopped && stopped.message) || '导入失败'),
            true
        );
        showContinue(Boolean(stopped && stopped.kind === 'rate-limit'), remainingRows);
        render();
    }

    /** 点「确认上传」 */
    async function handleConfirm() {
        if (state.busy) return;
        if (state.records.length === 0) {
            notify('没有可上传的合法行', true);
            return;
        }
        if (state.errors.length > 0) {
            notify('存在非法行，修正后才能上传', true);
            return;
        }
        // 已有成功批次：只能走「继续提交剩余」，否则会从头重发前面已写入的批（撞 409）
        if (state.run !== null && state.run.cursor > 0) {
            notify('已有批次写入，请用「继续提交剩余」', true);
            return;
        }
        if (!fetchImpl) {
            notify('当前环境不支持网络请求', true);
            return;
        }

        const batches = buildBatches(state.records);
        const answer = await confirmImpl({
            text: batches.length > 1
                ? `将分 ${batches.length} 批写入，共 ${state.records.length} 条时刻表，确认上传？`
                : `将写入 ${state.records.length} 条时刻表，确认上传？`,
            buttons: ['确定', '取消'],
            button_style: ['primary', '']
        });
        // showConfirm 返回按钮的倒序索引：['确定','取消'] 时「确定」为 1
        if (answer !== 1) {
            notify('已取消上传', false, { type: 'info' });
            return;
        }

        state.run = { batches, cursor: 0, writer: '', writetime: '' };
        await guard.run(() => runBatches());
    }

    /** 点「继续提交剩余」：从 run.cursor（未写入的那一批）接着发，已成功的批不再重发 */
    async function handleContinue() {
        if (state.busy || !state.run) return;
        await guard.run(() => runBatches());
    }

    function clearAll() {
        // hcw-button 的 disabled 属性只改灰态，挡不住点击 —— 守卫写在这里
        if (state.busy) return;
        resetPreview();
        if (els.result) {
            els.result.innerHTML = '';
            els.result.className = 'result-card hidden';
            setHidden(els.result, true);
        }
        notify('已清空导入内容', false, { type: 'info' });
    }

    /* ---------------- 事件绑定 ---------------- */

    if (els.pick && els.file) {
        els.pick.addEventListener('click', () => els.file.click?.());
    }

    if (els.file) {
        els.file.addEventListener('change', async (event) => {
            const picked = event && event.target && event.target.files
                ? event.target.files[0]
                : null;
            if (picked) await setFile(picked);
        });
    }

    if (els.drop) {
        ['dragenter', 'dragover'].forEach((type) => {
            els.drop.addEventListener(type, (event) => {
                event.preventDefault?.();
                els.drop.classList.add('is-over');
            });
        });
        ['dragleave', 'drop'].forEach((type) => {
            els.drop.addEventListener(type, (event) => {
                event.preventDefault?.();
                els.drop.classList.remove('is-over');
            });
        });
        els.drop.addEventListener('drop', async (event) => {
            const dropped = event && event.dataTransfer && event.dataTransfer.files
                ? event.dataTransfer.files[0]
                : null;
            if (dropped) await setFile(dropped);
        });
    }

    if (els.template) els.template.addEventListener('click', downloadTemplate);
    if (els.confirm) els.confirm.addEventListener('click', handleConfirm);
    if (els.continueBtn) {
        setHidden(els.continueBtn, true);
        els.continueBtn.addEventListener('click', handleContinue);
    }
    if (els.clear) els.clear.addEventListener('click', clearAll);

    render();

    return { setFile, setRows, getState };
}
