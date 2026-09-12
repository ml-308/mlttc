// lib/ui/timetable-detail.mjs
/**
 * 时刻表详情页 —— 唯一实现
 *
 * 只服务一个页面 `timetable-detail.html`，用 URL 参数区分入口：
 *   /timetable-detail.html?id=xxx               从搜索结果 / 时刻表列表进入
 *   /timetable-detail.html?id=xxx&from=account  从个人主页「我的时刻表」进入
 *
 * `from` 只影响两个返回按钮的**文案与去向**（见 BACK_TARGETS），其余逻辑完全相同。
 * 旧地址 `timetable-detail-result.html` 已改为重定向到第二种形式，老链接不会失效。
 * （历史上两个页面各有一份 HTML + 一份脚本，除返回按钮外逐字相同，现已合并。）
 *
 * 页面需要提供的元素 id：
 *   back-btn / detail-back-btn / detail-retry-btn
 *   detail-loading / detail-error / detail-content
 *   detail-title / detail-id / detail-city / detail-way / detail-start / detail-end
 *   detail-special / detail-time1 / detail-time2
 *   detail-starttime / detail-writer / detail-writetime
 *   错误提示文本需位于 `.detail-error p` 内
 *
 * 用法：
 *   import { createTimetableDetailPage } from '/lib/ui/timetable-detail.mjs';
 *   createTimetableDetailPage();   // 返回去向自动按 ?from= 推断
 */

/**
 * 把接口返回的原始时刻串切成一个个「HH:MM」
 * 原始格式形如 "06:00\t06:30\t\n07:00"，以制表符/换行分隔
 *
 * @param {string} timeStr 数据库中的 TIMEONE / TIMETWO
 * @returns {string[]} 时刻数组；无数据或 "unknown" 时返回空数组
 */
function formatTimeDisplay(timeStr) {
    if (!timeStr || timeStr === 'unknown') return [];
    const parts = timeStr.split(/[\t\n\r]+/).filter((t) => t.trim());
    return parts.map((p) => p.trim()).filter((p) => p);
}

/**
 * 读取当前 URL 的查询参数
 * @param {string} name 参数名
 * @returns {string|null}
 */
function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
}

/**
 * 「返回」按钮的来源预设：?from= 的取值 → 去向与文案
 * 未带 from（或值无法识别）时按「从时刻表列表进入」处理
 */
const BACK_TARGETS = new Map([
    ['account', { url: '/account.html', backLabel: '返回个人主页', detailBackLabel: '返回个人主页' }],
    ['list', { url: '/timetable.html', backLabel: '返回', detailBackLabel: '返回列表' }]
]);

/**
 * 初始化时刻表详情页（拉取数据 → 渲染 → 绑定返回/重试按钮）
 *
 * @param {object} [options]
 * @param {string} [options.backUrl] 「返回」按钮跳转的地址；缺省时按 ?from= 推断
 * @param {string} [options.backLabel] 页头返回按钮文案；缺省时按 ?from= 推断
 * @param {string} [options.detailBackLabel] 底部返回按钮文案；缺省时按 ?from= 推断
 * @returns {{ load: () => Promise<void> }} 便于外部再次触发加载
 */
export function createTimetableDetailPage({ backUrl, backLabel, detailBackLabel } = {}) {
    const el = (id) => document.getElementById(id);

    // 按 ?from= 决定返回去向与文案（HTML 里已写有「从列表进入」的默认文案）
    const preset = BACK_TARGETS.get(getQueryParam('from')) || BACK_TARGETS.get('list');

    // ─── DOM 元素 ────────────────────────────────
    const backBtn = el('back-btn');
    const detailBackBtn = el('detail-back-btn');
    const detailLoading = el('detail-loading');
    const detailError = el('detail-error');
    const detailContent = el('detail-content');
    const detailRetryBtn = el('detail-retry-btn');

    const detailTitle = el('detail-title');
    const detailId = el('detail-id');
    const detailCity = el('detail-city');
    const detailWay = el('detail-way');
    const detailStart = el('detail-start');
    const detailEnd = el('detail-end');
    const detailSpecial = el('detail-special');
    const detailTime1 = el('detail-time1');
    const detailTime2 = el('detail-time2');
    const detailStarttime = el('detail-starttime');
    const detailWriter = el('detail-writer');
    const detailWritetime = el('detail-writetime');

    // 文案按来源覆盖（HTML 中写死的是「从列表进入」的文案，options 可再次覆盖）
    if (backBtn) backBtn.textContent = backLabel ?? preset.backLabel;
    if (detailBackBtn) detailBackBtn.textContent = detailBackLabel ?? preset.detailBackLabel;

    /** 当前已加载的数据（便于后续扩展，如「修改」按钮） */
    let loadedData = null;

    /** 展示错误状态（隐藏加载中与内容区） */
    function showError(message) {
        detailLoading.classList.add('hidden');
        detailError.classList.remove('hidden');
        const p = document.querySelector('.detail-error p');
        if (p) p.textContent = message;
    }

    /**
     * 渲染一个方向（主站→副站 或 副站→主站）的时刻表
     *
     * @param {HTMLElement} container 目标容器
     * @param {string} raw 原始时刻串（TIMEONE / TIMETWO）
     */
    function renderTimeChips(container, raw) {
        container.innerHTML = '';

        // 2501（线路撤销）在后端以 "Remove" 存储。
        // 注意：必须在切分之前判断 —— formatTimeDisplay('Remove') 会返回 ['Remove']
        // （长度不为 0），若放在下面 length 判断之后将永远无法命中。
        if (raw === 'Remove') {
            container.innerHTML = '<span class="detail-time-chip">线路已撤销</span>';
            return;
        }

        const parts = formatTimeDisplay(raw);
        if (parts.length > 0) {
            parts.forEach((t) => {
                const chip = document.createElement('span');
                chip.className = 'detail-time-chip';
                chip.textContent = t;
                container.appendChild(chip);
            });
            return;
        }

        // 无数据 / "unknown" / 1000-1-1 之类的占位值
        container.innerHTML = '<span class="detail-time-chip">未填写或无发车班次</span>';
    }

    /**
     * 渲染详情内容
     * @param {object} item 接口返回的时刻表记录
     */
    function renderDetail(item) {
        detailLoading.classList.add('hidden');
        detailError.classList.add('hidden');
        detailContent.classList.remove('hidden');

        // 标题与基本信息
        detailTitle.textContent = `${item.CITY} · ${item.WAY}`;
        detailId.textContent = `#${item.ID}`;
        detailCity.textContent = item.CITY || '-';
        detailWay.textContent = item.WAY || '-';
        detailStart.textContent = item.START || '-';
        detailEnd.textContent = item.END || '-';
        detailSpecial.textContent = item.SPECIAL && item.SPECIAL !== '无' ? item.SPECIAL : '无';

        // 两个方向的时刻表（外环 / 内环）
        renderTimeChips(detailTime1, item.TIMEONE);
        renderTimeChips(detailTime2, item.TIMETWO);

        // 元信息（1000-1-1 是「执行时间未知」的约定值）
        detailStarttime.textContent = (!item.STARTTIME || item.STARTTIME === '1000-1-1')
            ? '执行时间未知'
            : item.STARTTIME;
        detailWriter.textContent = item.WRITER_NAME || item.WRITER || '未知';
        detailWritetime.textContent = item.WRITETIME || '未知';

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /** 按 URL 上的 ?id= 拉取并渲染详情 */
    async function loadDetail() {
        const id = getQueryParam('id');
        if (!id) {
            showError('缺少时刻表ID参数');
            return;
        }

        detailLoading.classList.remove('hidden');
        detailError.classList.add('hidden');
        detailContent.classList.add('hidden');

        try {
            const res = await fetch(`/api/timetable-D1?id=${encodeURIComponent(id)}`, {
                credentials: 'include'
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({ message: '请求失败' }));
                throw new Error(errData.message || errData.error || '请求失败');
            }

            const json = await res.json();
            if (!json.success || !json.data) {
                throw new Error(json.message || '找不到数据');
            }

            loadedData = json.data;
            renderDetail(loadedData);
        } catch (e) {
            console.error('加载详情失败:', e);
            showError(e.message || '无法加载时刻表详情');
        }
    }

    // ─── 事件绑定 ────────────────────────────────
    // 两个返回按钮去向一致，都按 ?from= 推断
    const targetUrl = backUrl ?? preset.url;

    backBtn?.addEventListener('click', () => {
        window.location.href = targetUrl;
    });

    detailBackBtn?.addEventListener('click', () => {
        window.location.href = targetUrl;
    });

    detailRetryBtn?.addEventListener('click', loadDetail);

    // ─── 启动 ────────────────────────────────
    loadDetail();

    return { load: loadDetail };
}
