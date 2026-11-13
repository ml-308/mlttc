// lib/ui/timetable-import.mjs
/**
 * 时刻表页「批量导入」面板 —— 唯一实现
 *
 * 只服务 timetable.html 的 #import-form，负责整条导入链路：
 *   选择/拖入 .csv 或 .xlsx → 解析（lib/timetable-import.mjs）→ 校验
 *   → 分页预览（每页 20 行，切页不重新解析）→ 二次确认
 *   → 【逐条串行】POST /api/timetable-import-D1 → 每条一个动画 + 实时汇总
 *
 * 提交策略（后端 items 接受 1..20 条，这里永远只放 1 条）：
 *   - 一行一个请求：items 里只有这一行，等它有确定结果（成功/失败）→ 播动画 → 再发下一行，
 *     同一时刻只会有一个请求在飞（串行 for + await，没有并发池）；
 *   - 成功：该卡片向左滑出屏幕，出列后下方卡片上移补位；
 *   - 单条失败（400/409/500/网络错误）：该卡片变红、钉在列表第一位，**队列继续往下走**，
 *     一条错误不再把整批打回（这是本次改造的核心）；
 *   - 429 限流：继续发只会继续被拒，所以停在这一条，并给「重试未完成」入口；
 *   - 校验不通过的行依然阻止上传（本地校验是全表前置检查，不参与逐条提交流程）。
 *
 * 动画目标只能是卡片：<table> 的 <tr> 上做 translateX 观感与兼容性都受限，
 * 因此上传期间 #import-preview 切成纵向卡片队列（.tt-queue-card），
 * 上传结束后再回到分页表格预览（已成功的行不再出现，失败行标红并带原因）。
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
/**
 * 后端一次请求允许的最大条数（items 1..20）。
 * 导入现在是「一行一个请求」，这个常量只用于文案与对外兼容导出，不再参与分批。
 */
export const BATCH_SIZE = 20;
/** 批量写入接口（逐条上传时每行发一次 POST） */
export const IMPORT_API = '/api/timetable-import-D1';
/** 成功行左滑出列的时长（ms），与 style/timetable-import.css 的 .is-leaving 对齐 */
const LEAVE_MS = 200;
/** 下方卡片补位上移的时长（ms）；不阻塞下一条提交，与下一个请求并行跑完 */
const FLIP_MS = 180;
/** 等 transitionend 的兜底时长：动画事件丢了也不能把队列卡住 */
const LEAVE_TIMEOUT_MS = LEAVE_MS + 120;

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
/** 导入限流窗口（LIMITS.import 的 window = 600 秒），429 拿不到 retryAfter 时用它兜底 */
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

/** 取节点所在文档的 window（无浏览器环境返回 null） */
function animationWindow(node) {
    const doc = (node && node.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (doc && doc.defaultView) return doc.defaultView;
    return typeof window !== 'undefined' ? window : null;
}

/**
 * 能否在这张卡片上播放位移动画
 *
 * 需要真实布局引擎（getBoundingClientRect）与 requestAnimationFrame。
 * tools/ 下的 DOM 桩两者都没有，于是自动走「瞬时移除 / 瞬时置红」降级 ——
 * 逐条上传的时序在无浏览器测试里依然确定，不会因为等动画而卡住。
 */
function canAnimate(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    const win = animationWindow(node);
    return Boolean(win && typeof win.requestAnimationFrame === 'function');
}

/** 用户要求减少动态效果时，位移动画一律不播（直接移除 / 置红） */
function prefersReducedMotion(node) {
    const win = animationWindow(node);
    if (!win || typeof win.matchMedia !== 'function') return false;
    try {
        return win.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
        return false;
    }
}

/** 下一帧执行；没有 rAF 时退回 setTimeout（只用在不阻塞队列的补位动画上） */
function nextFrame(node, fn) {
    const win = animationWindow(node);
    if (win && typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(fn);
    else setTimeout(fn, 16);
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
 * 把合法记录排成逐条提交的队列（一条一项，绝不合并）
 *
 * 每一项就是一个请求：{ row（Excel 行号）, record（validateRows 的 record）, view, state, note }
 * view 用来在提交结束后把失败原因写回预览的「状态」列。
 *
 * @param {Array<Object>} records
 * @param {Array<Object>} views
 */
function buildQueue(records, views) {
    const viewByRow = new Map();
    for (const view of views) viewByRow.set(view.row, view);

    const items = [];
    for (const record of records) {
        const view = viewByRow.get(record.row) || null;
        // 重试时把上一轮留下的「失败：…」抹掉，本轮的结论重新写
        if (view) {
            view.status = '待上传';
            view.failed = false;
        }
        items.push({ row: record.row, record, view, state: 'pending', note: '' });
    }
    return items;
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
        /** 当前这一轮的逐条提交队列：{ items, cursor, writer, writetime, stopped } */
        run: null,
        /** 最近一次请求体，便于排查 */
        lastPayload: null,
        lastStatus: 0
    };

    /**
     * 逐条上传期间队列的 DOM 引用：{ failed, pending, cards }
     * cards 是「行号 → 卡片元素」的 Map —— 不用 [data-row="N"] 选择器查卡片：
     * 一是要拼字符串，二是 DOM 桩只按属性是否存在匹配，按行号建表最稳。
     */
    let queueRefs = { failed: null, pending: null, cards: new Map() };
    /* ---------------- 渲染 ---------------- */

    /** 本次逐条上传的实时计数：成功 / 失败 / 剩余（剩余 = 还没轮到提交的） */
    function runCounts() {
        const items = (state.run && state.run.items) || [];
        let ok = 0;
        let fail = 0;
        let pending = 0;
        for (const item of items) {
            if (item.state === 'ok') ok += 1;
            else if (item.state === 'fail') fail += 1;
            else pending += 1;
        }
        return { ok, fail, pending, total: items.length };
    }

    function renderStat(page) {
        if (!els.stat) return;
        // 逐条上传期间这一行改跑实时计数（每完成一条 syncProgress 就刷一次）
        if (state.run) {
            const { ok, fail, pending, total } = runCounts();
            els.stat.textContent = `逐条上传：成功 ${ok} / 失败 ${fail} / 剩余 ${pending}（本次共 ${total} 行）`;
            return;
        }
        if (page.total === 0) {
            els.stat.textContent = state.busy
                ? ''
                : `尚未选择文件（支持 .csv / .xlsx，每页 ${PAGE_SIZE} 行，上传时逐条提交，一条失败不影响其它行）`;
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

    /** 提交进度：正在提交第 k/n 条（成功 x / 失败 y / 剩余 z） */
    function renderProgress() {
        if (!els.notice) return;
        const run = state.run;
        if (!state.busy || !run) {
            els.notice.textContent = '';
            setHidden(els.notice, true);
            return;
        }
        const { ok, fail, pending, total } = runCounts();
        const current = Math.min(run.cursor + 1, total);
        els.notice.textContent = `正在逐条上传（第 ${current}/${total} 条，一行一个请求）：`
            + `成功 ${ok} / 失败 ${fail} / 剩余 ${pending}`;
        setHidden(els.notice, false);
    }

    /** 每完成一条就刷一次实时计数与进度行 —— 逐条上传的「更新点」只有这一处 */
    function syncProgress() {
        if (!state.run) return;
        renderStat();
        renderProgress();
        updateConfirm();
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
        const classes = ['tt-data-row'];
        if (view.invalid) classes.push('is-invalid');
        // 上传失败的行：留在预览里标红，状态列写明原因（信息不丢）
        if (view.failed) classes.push('is-failed');
        return `<tr class="${classes.join(' ')}">`
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

    /**
     * 逐条上传时的一张卡片（信息密度对齐表格：行号/城市/线路/起终点/备注/时刻摘要/状态）
     *
     * 用卡片而不是 <tr>：translateX 在表格行上的观感与兼容性都受限，
     * 「向左滑出、下面的往上移」需要卡片这种独立盒子才好做。
     */
    function queueCardHtml(item) {
        const view = item.view || {};
        const status = item.state === 'fail'
            ? '失败：' + (item.note || '导入失败')
            : (item.state === 'sending' ? '上传中…' : '待上传');
        const classes = ['tt-queue-card'];
        if (item.state === 'fail') classes.push('is-failed');
        if (item.state === 'sending') classes.push('is-sending');
        return `<article class="${classes.join(' ')}" data-row="${item.row}">`
            + '<div class="tt-q-head">'
            + `<span class="tt-q-row">第 ${item.row} 行</span>`
            + `<span class="tt-q-city">${cell(view.city)}</span>`
            + `<span class="tt-q-way">${cell(view.way)}</span>`
            + `<span class="tt-q-state">${escapeHtml(status)}</span>`
            + '</div>'
            + '<div class="tt-q-main">'
            + `<span class="tt-q-route">${cell(view.start)} → ${cell(view.end)}</span>`
            + `<span class="tt-q-special">备注：${cell(view.special)}</span>`
            + '</div>'
            + '<div class="tt-q-times">'
            + `<span>主→副 ${cell(timePreview(view.time1))}</span>`
            + `<span>副→主 ${cell(timePreview(view.time2))}</span>`
            + `<span>执行 ${cell(view.etime)}</span>`
            + '</div>'
            + '</article>';
    }

    /**
     * 渲染逐条上传的队列视图
     *
     * 队列分两组：失败组在上面（最新的失败排最前，因此当前失败的卡片永远在「第一条」），
     * 待提交组在下面。队列只会变短（成功的出列、失败的留在原地），
     * 所以失败卡片既不会被后续行挤到列表里更靠前的位置，也不会被挤出首屏。
     */
    function renderQueueView() {
        if (!els.preview) return;
        const items = (state.run && state.run.items) || [];
        const failed = items.filter((item) => item.state === 'fail').reverse();
        const pending = items.filter((item) => item.state === 'pending' || item.state === 'sending');

        els.preview.classList.add('is-queue');
        els.preview.innerHTML = '<div class="tt-queue">'
            + `<div class="tt-queue-failed">${failed.map(queueCardHtml).join('')}</div>`
            + `<div class="tt-queue-pending">${pending.map(queueCardHtml).join('')}</div>`
            + '</div>';

        const cards = new Map();
        els.preview.querySelectorAll('.tt-queue-card').forEach((node) => {
            cards.set(Number(node.getAttribute('data-row')), node);
        });
        queueRefs = {
            failed: els.preview.querySelector('.tt-queue-failed'),
            pending: els.preview.querySelector('.tt-queue-pending'),
            cards
        };
        // 队列视图不分页：这里的分页按钮对队列没有意义（上传结束后 render 会恢复）
        if (els.pager) setHidden(els.pager, true);
        setHidden(els.preview, false);
    }

    function renderPreview(page) {
        if (!els.preview) return;
        // 回到表格预览：撤销队列形态与队列引用（动画只在上传期间可播）
        els.preview.classList.remove('is-queue');
        queueRefs = { failed: null, pending: null, cards: new Map() };
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
        // 逐条上传期间列表是提交队列，不是分页预览；此时翻页会把它换成表格，
        // 动画与「失败钉在第一位」就没有了着力点，直接忽略
        if (state.busy) return;
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
        // 逐条上传结束后成功的行已从 state.records 里移除，所以「再点确认」只会重发
        // 还没写进去的那些行，不会重复写入，也就不需要旧的「游标 > 0 就禁用」条件
        const blocked =
            state.busy
            || state.records.length === 0
            || state.errors.length > 0;
        setDisabled(els.confirm, blocked);
        // 提交中锁住「清空 / 重试」，避免中途把 state.run 清掉（真正的点击守卫在
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

    /** 「重试未完成」入口：未完成的 = 失败的行 + 因限流没来得及提交的行 */
    function showContinue(visible, remainingRows) {
        if (!els.continueBtn) return;
        if (!visible || !remainingRows) {
            setHidden(els.continueBtn, true);
            return;
        }
        els.continueBtn.textContent = `重试未完成的 ${remainingRows} 行`;
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
        const counts = runCounts();
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
            // 现在是「一行一个请求」：要发的请求数就等于待上传行数
            perRequest: 1,
            batchCount: state.records.length,
            requestCount: state.records.length,
            // 属性才是 hcw-button 的真实禁用状态（.disabled 只是镜像的 expando）
            canUpload: Boolean(els.confirm) && !els.confirm.hasAttribute('disabled'),
            busy: state.busy,
            progress: counts,
            run: run
                ? {
                    cursor: run.cursor,
                    written: counts.ok,
                    failed: counts.fail,
                    pending: counts.pending,
                    stopped: run.stopped,
                    items: run.items.map((item) => ({
                        row: item.row,
                        state: item.state,
                        note: item.note
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

    /* ---------------- 上传：逐条串行提交 + 逐条动画 ---------------- */

    /**
     * 单条提交时后端 errors 里的 row 是「本次请求内的序号」，恒为 1，与 Excel 行号无关。
     * 所以这里只取原因，行号一律用队列里的真实行号 —— 否则失败提示会变成
     * 「第 1 行：该时刻表已存在」，指错行比不指行更糟。
     */
    function describeItemErrors(errors) {
        if (!Array.isArray(errors) || errors.length === 0) return '';
        const lines = [];
        for (const item of errors) {
            const message = String((item && item.message) || '').trim();
            if (message && !lines.includes(message)) lines.push(message);
            if (lines.length >= MAX_RESULT_LINES) break;
        }
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

    /**
     * 提交【一条】：请求体沿用 buildImportBody 的构造方式，items 里只有这一行。
     * 返回 { kind: 'ok' | 'rate-limit' | 'error', message, wait }
     */
    async function submitOne(run, item) {
        const payload = buildImportBody([item.record], run.writer, run.writetime);
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

        if (res && res.ok) return { kind: 'ok' };

        const message = (data && data.message) || (data && data.error) || '导入失败';
        const detail = describeItemErrors(data && data.errors);
        if (state.lastStatus === 429) {
            return { kind: 'rate-limit', message, wait: readRetryAfter(res, data) };
        }
        // 只发一行时，items 里唯一那一行的 errors 就是这一行的原因，比后端的批级
        // message（如「部分时刻表已存在」）更准确，所以优先用 detail
        return { kind: 'error', message: detail || message };
    }

    /* ---- 动画：成功左滑出列 + 下方补位上移 ---- */

    /** 等左滑动画结束；transitionend 没来（或根本没有过渡）时由超时兜底，绝不卡住队列 */
    function waitLeave(card) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                if (typeof card.removeEventListener === 'function') {
                    card.removeEventListener('transitionend', onEnd);
                }
                resolve();
            };
            const onEnd = (event) => {
                if (!event || !event.target || event.target === card) finish();
            };
            if (typeof card.addEventListener === 'function') card.addEventListener('transitionend', onEnd);
            setTimeout(finish, LEAVE_TIMEOUT_MS);
        });
    }

    /**
     * FLIP 补位：把「移除后应当上移」的卡片先按位移差摆回旧位置，
     * 下一帧再用 transform 过渡回原位 —— 下面的行是平滑上移而不是瞬跳。
     * 不 await：补位动画与下一条请求并行，不拖慢串行队列。
     */
    function flipSettle(nodes, beforeTops) {
        nodes.forEach((node, index) => {
            const delta = beforeTops[index] - node.getBoundingClientRect().top;
            if (!delta) return;
            node.style.transition = 'none';
            node.style.transform = `translateY(${delta}px)`;
            nextFrame(node, () => {
                node.style.transition = `transform ${FLIP_MS}ms ease-out`;
                node.style.transform = '';
                setTimeout(() => {
                    node.style.transition = '';
                    node.style.transform = '';
                }, FLIP_MS + 40);
            });
        });
    }

    /**
     * 成功行出列：向左滑出屏幕 → 从列表移除 → 下方卡片上移补位
     * 返回的 Promise 在「已从列表移除」时 resolve，调用方 await 完它才发下一条请求。
     */
    async function playLeaveOut(card) {
        if (!card) return;
        // 无布局引擎（DOM 桩）或用户要求减少动态效果：直接移除，不播位移动画
        if (!canAnimate(card) || prefersReducedMotion(card)) {
            card.remove();
            return;
        }
        const container = card.parentNode;
        const moving = container
            ? Array.from(container.children).filter((node) => node !== card && Boolean(node.style))
            : [];
        const beforeTops = moving.map((node) => node.getBoundingClientRect().top);

        card.classList.add('is-leaving');   // CSS：translateX(-100%) + opacity 0
        await waitLeave(card);
        card.remove();
        flipSettle(moving, beforeTops);
    }

    /** 请求还没回来时把「上传中…」写到卡片上（不改队列顺序） */
    function markCardSending(item) {
        const card = queueRefs.cards.get(item.row);
        if (!card) return;
        card.classList.add('is-sending');
        const stateNode = card.querySelector('.tt-q-state');
        if (stateNode) stateNode.textContent = '上传中…';
    }

    /**
     * 失败行：变红 + 钉在列表第一位（失败组最前面），不移出列表
     *
     * 它只是留在原地等重试，后面的行照常提交 —— 这就是「一条错误不再把整批打回」。
     * 最新失败插到失败组最前面，所以「第一条」永远是这次失败的卡片。
     */
    function pinFailedCard(item) {
        const card = queueRefs.cards.get(item.row);
        if (!card) return;
        card.classList.remove('is-sending');
        const stateNode = card.querySelector('.tt-q-state');
        if (stateNode) stateNode.textContent = '失败：' + (item.note || '导入失败');
        // 先摘下来再插进失败组（真实浏览器的 insertBefore 会自动脱离原父节点，
        // 这里显式 remove 是为了同一段代码在 DOM 桩上也成立）
        if (queueRefs.failed) {
            card.remove();
            queueRefs.failed.insertBefore(card, queueRefs.failed.firstChild);
        }
        card.classList.add('is-failed');
        if (canAnimate(card) && !prefersReducedMotion(card)) {
            card.classList.add('is-pinned');
            setTimeout(() => card.classList.remove('is-pinned'), 500);
        }
    }

    /** 成功写入的行从预览/合法集里移除：再渲染不会再出现，也不会被重复提交 */
    function removeRowFromState(item) {
        state.views = state.views.filter((view) => view !== item.view);
        state.records = state.records.filter((record) => record !== item.record);
    }

    /**
     * 逐条串行提交
     *
     * 循环体里 await 完这一条（请求 + 成功动画）才轮到下一条，
     * 整个文件只会有一个请求在飞，没有任何并发池。
     */
    async function runQueue() {
        const run = state.run;
        if (!run) return;
        if (!fetchImpl) {
            notify('当前环境不支持网络请求', true);
            state.run = null;
            render();
            return;
        }
        if (!run.writer) {
            const writer = await getWriter();
            if (!writer) {
                notify('请先登录', true);
                state.run = null;
                render();
                return;
            }
            run.writer = writer;
            run.writetime = formatDate(now());
        }

        state.busy = true;
        state.page = 1;
        showContinue(false);
        renderQueueView();
        syncProgress();

        let stopped = null;
        try {
            for (let i = 0; i < run.items.length; i++) {
                const item = run.items[i];
                if (item.state !== 'pending') continue;   // 重试时跳过已成功的行
                run.cursor = i;
                item.state = 'sending';
                markCardSending(item);
                syncProgress();

                let result;
                try {
                    result = await submitOne(run, item);   // ← 一个请求只带这一行
                } catch (error) {
                    result = {
                        kind: 'error',
                        message: '网络错误：' + ((error && error.message) || String(error))
                    };
                }

                if (result.kind === 'ok') {
                    item.state = 'ok';
                    dropMyTimetableCache();
                    // 先播动画（出列），再从数据层移除，然后才轮到下一条
                    await playLeaveOut(queueRefs.cards.get(item.row));
                    queueRefs.cards.delete(item.row);
                    removeRowFromState(item);
                } else {
                    item.state = 'fail';
                    item.note = result.message || '导入失败';
                    // 变红 + 钉在第一位；队列继续往下走
                    pinFailedCard(item);
                    syncProgress();
                    if (result.kind === 'rate-limit') {
                        // 限流：接着发只会接着被拒，停下来把入口交给「重试未完成」
                        run.stopped = 'rate-limit';
                        stopped = { ...result, item };
                        break;
                    }
                }
                syncProgress();
            }
        } finally {
            state.busy = false;
        }

        finishRun(run, stopped);
    }

    /** 收尾：失败原因写回预览（表格形态、标红），给结果卡与「重试未完成」入口 */
    function finishRun(run, stopped) {
        const { ok, fail, pending } = runCounts();
        // 失败行留在 state.views/records 里：标红并把原因写进「状态」列，信息不丢
        for (const item of run.items) {
            if (item.state === 'fail' && item.view) {
                item.view.failed = true;
                item.view.status = '失败：' + (item.note || '导入失败');
            }
        }
        const remaining = state.records.length;   // 未写入的 = 失败 + 没来得及发的
        state.run = null;
        render();

        if (fail === 0) {
            showResult('success', `导入成功：逐条写入 ${ok} 条时刻表`);
            notify('导入成功', false);
            showContinue(false);
            return;
        }

        const details = run.items
            .filter((item) => item.state === 'fail')
            .slice(0, MAX_PROBLEM_LINES)
            .map((item) => `第 ${item.row} 行：${item.note || '导入失败'}`);
        const rest = fail - details.length;
        if (rest > 0) details.push(`…等 ${rest} 行失败（预览里都已标红）`);

        const head = ok > 0
            ? `部分完成：已写入 ${ok} 条，${fail} 条失败${pending > 0 ? `，${pending} 条未提交` : ''}`
            : `本次未写入：${fail} 条失败${pending > 0 ? `，${pending} 条未提交` : ''}`;
        const tail = stopped && stopped.kind === 'rate-limit'
            ? `已暂停：请求过于频繁，请 ${stopped.wait} 秒后重试未完成的行`
            : '失败的行留在列表里，可修正或重试';
        showResult(
            stopped && stopped.kind === 'rate-limit' ? 'info' : 'error',
            `${head}。${tail}`,
            details
        );
        notify(`导入完成：${fail} 条失败，其余已写入`, true);
        showContinue(remaining > 0, remaining);
    }

    /** 点「确认上传」：把当前合法行排成队列，逐条提交 */
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
        if (!fetchImpl) {
            notify('当前环境不支持网络请求', true);
            return;
        }

        // 成功的行在上传后会从 state.records 里移除，所以「再点确认」只会重发
        // 还没写进去的那部分，不会重复写入（旧的「游标 > 0 就禁用」不再需要）
        const count = state.records.length;
        const answer = await confirmImpl({
            text: `将逐条写入 ${count} 条时刻表（一行一个请求，某一条失败不会影响其它行），确认上传？`,
            buttons: ['确定', '取消'],
            button_style: ['primary', '']
        });
        // showConfirm 返回按钮的倒序索引：['确定','取消'] 时「确定」为 1
        if (answer !== 1) {
            notify('已取消上传', false, { type: 'info' });
            return;
        }

        state.run = {
            items: buildQueue(state.records, state.views),
            cursor: 0,
            writer: '',
            writetime: '',
            stopped: null
        };
        await guard.run(() => runQueue());
    }

    /**
     * 点「重试未完成的 N 行」：未完成的行（失败 + 限流后没来得及发的）还在
     * state.records 里，已成功的已移除 —— 直接重新排队即可，不重发已写入的行，
     * 也不用再弹二次确认。
     */
    async function handleContinue() {
        if (state.busy) return;
        if (state.errors.length > 0) {
            notify('存在非法行，修正后才能上传', true);
            return;
        }
        if (state.records.length === 0) {
            notify('没有可重试的行', true);
            return;
        }
        if (!fetchImpl) {
            notify('当前环境不支持网络请求', true);
            return;
        }

        state.run = {
            items: buildQueue(state.records, state.views),
            cursor: 0,
            writer: '',
            writetime: '',
            stopped: null
        };
        await guard.run(() => runQueue());
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
