// src/pages/my-timetable.js
/**
 * 我的时刻表（my-timetable.html）
 *
 * 原属个人主页（account.html / account.js）的「我的时刻表」区块，现拆分为独立页面。
 *
 * 职责：
 *   1. 按当前登录用户拉取时刻表列表（GET /api/timetable-D1?writer=邮箱）
 *   2. 排序：被驳回 > 待审核 > 已通过
 *   3. 每条卡片提供「查看详情 / 修改时刻表 / 删除」（DELETE /api/timetable-D1）
 *   4. 「因错误报告被返还」提醒：GET /api/report?mine=1（需登录）→ 顶部横幅 + 卡片高亮
 *      提醒单独请求、不进 sessionStorage 缓存；接口 401/失败静默跳过，只在控制台记一笔
 *
 * 依赖：/lib/ui/popup.mjs（确认弹窗）、/lib/ui/message.mjs（提示）、/lib/ui/guard.mjs（防重复点击）
 */
import { showConfirm } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';

/**
 * 是否被驳回：以 BACK 列为准（BACK == 1 表示被管理员驳回）
 * 说明：SPECIAL 为“备注”字段，不再用于判断驳回状态；
 *       用户修改时刻表后，后端会将 BACK 置为 '-'（未驳回）
 */
function isRejected(item) {
  if (!item) return false;
  const back = item.BACK;
  return back !== undefined && back !== null && String(back).trim() === '1';
}

/** 列表排序权重：被驳回 > 待审核 > 已通过 */
function timetableLevel(item) {
  if (isRejected(item)) return 2;
  if (item.PASS == true) return 0;
  return 1;
}

// ─── 加载骨架 ─────────────────────────────────────────
/** 建一个只有类名、没有内容的占位元素 */
function makeSkeletonEl(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

/**
 * 渲染加载骨架：count 张 .sk-card，外面包一层 .sk-list
 *
 * 为什么用骨架而不是纯文字：文字「加载中...」只告诉用户「正在等」，
 * 不预告版面；骨架用与 .result-item 同构的占位块先把列表轮廓撑出来，
 * 数据到达后布局不再跳动（不出现 CLS 抖动），等待的感知时长也更短。
 *
 * 样式全部由 style/main.css 的 .sk-* 契约提供，本文件不写任何 CSS。
 * 幂等：每次渲染前先清空容器，重复进入加载态（点刷新、切筛选）
 * 不会叠加成 6 张、9 张卡片；容器里原有的「加载中...」文字也一并移除。
 *
 * 骨架不含任何接口数据，纯占位，因此不需要转义处理。
 *
 * @param {HTMLElement|null} container 加载态容器（#timetable-loading）
 * @param {number} count 骨架卡片数量
 */
function renderSkeletonCards(container, count) {
  if (!container) return;
  container.innerHTML = '';

  const list = makeSkeletonEl('div', 'sk-list');
  for (let i = 0; i < count; i += 1) {
    const card = makeSkeletonEl('div', 'sk-card');
    // 一张卡片 = 2 条文本行（编号/线路）+ 1 个矩形块（站点行）
    card.appendChild(makeSkeletonEl('div', 'sk sk-line'));
    card.appendChild(makeSkeletonEl('div', 'sk sk-line'));
    card.appendChild(makeSkeletonEl('div', 'sk sk-block'));
    list.appendChild(card);
  }

  container.appendChild(list);
}

document.addEventListener('DOMContentLoaded', () => {
  // 返回按钮：本页是导航栏里的顶层页面，返回到首页
  document.getElementById('backBtn')?.addEventListener('click', () => window.location.href = '/index.html');

  // 登录按钮由 /src/pages/main.js 统一绑定（本页已包含 #globalLoginModal 结构）。

  // ─── 我的时刻表 - 渲染（一次性展示全部） ─────────
  let myEmail = '';
  let myTimetables = [];
  // 「因错误报告被返还」的报告列表（GET /api/report?mine=1），不写入任何缓存
  let myReports = [];

  const ttList = document.getElementById('timetable-list');
  const ttLoading = document.getElementById('timetable-loading');
  const ttEmpty = document.getElementById('timetable-empty');
  const ttError = document.getElementById('timetable-error');
  // 错误报告返还提醒（顶部横幅容器，见 my-timetable.html）
  const ttReportNotice = document.getElementById('my-report-notice');

  /**
   * 加载入口：进入加载态先画骨架，再发请求
   * 请求结束（成功 / 空 / 错误，含缓存命中的提前 return）一律在 finally 里清空骨架，
   * 不必改动原有各处 hidden 的显隐逻辑，也不会漏掉任何一条退出分支。
   */
  async function loadMyTimetables() {
    // 先把加载态重新露出来：首次加载后 ttLoading 被加了 hidden 就再没人移除，
    // 刷新/删表后重载时骨架会画在一个隐藏容器里、等于没有。
    // 各退出分支原有的 add('hidden') 保持不变，所以失败/空列表仍会正确收起来。
    if (ttLoading) ttLoading.classList.remove('hidden');
    renderSkeletonCards(ttLoading, 3);
    try {
      await fetchMyTimetables();
    } finally {
      if (ttLoading) ttLoading.innerHTML = '';
    }
  }

  async function fetchMyTimetables() {
    // 先获取用户邮箱
    let email = '';
    myEmail = '';
    try {
      const res = await fetch('/api/profile', { credentials: 'include' });
      if (!res.ok) {
        ttLoading.classList.add('hidden');
        ttError.classList.remove('hidden');
        ttError.textContent = '请先登录';
        return;
      }
      const data = await res.json();
      const user = data.user || data;
      email = user.email || '';
      if (!email) {
        ttLoading.classList.add('hidden');
        ttError.classList.remove('hidden');
        ttError.textContent = '无法获取用户信息';
        return;
      }
    } catch (e) {
      ttLoading.classList.add('hidden');
      ttError.classList.remove('hidden');
      ttError.textContent = '获取用户信息失败';
      return;
    }
    myEmail = email;

    // 尝试从 sessionStorage 读取缓存
    const CACHE_KEY = 'my_timetable_cache';
    let cached = null;
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch { /* ignore */ }

    if (cached && cached.email === email && Array.isArray(cached.data)) {
      // 缓存命中，直接使用
      myTimetables = cached.data;
      // 被驳回 > 待审核 > 已通过 排序
      myTimetables.sort((a, b) => timetableLevel(b) - timetableLevel(a));
      ttLoading.classList.add('hidden');

      if (myTimetables.length === 0) {
        ttEmpty.classList.remove('hidden');
      } else {
        ttEmpty.classList.add('hidden');
        renderMyPage();
      }
      return;
    }

    // 缓存未命中，从 D1 查询
    try {
      const res = await fetch(`/api/timetable-D1?writer=${encodeURIComponent(email)}`, {
        credentials: 'include'
      });
      if (!res.ok) {
        ttLoading.classList.add('hidden');
        ttError.classList.remove('hidden');
        ttError.textContent = '获取时刻表失败';
        return;
      }
      const json = await res.json();
      if (!json.success) {
        ttLoading.classList.add('hidden');
        ttEmpty.classList.remove('hidden');
        return;
      }

      myTimetables = json.data || [];
      // 被驳回 > 待审核 > 已通过 排序
      myTimetables.sort((a, b) => timetableLevel(b) - timetableLevel(a));

      // 写入缓存
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ email, data: myTimetables }));
      } catch { /* ignore */ }

      ttLoading.classList.add('hidden');

      if (myTimetables.length === 0) {
        ttEmpty.classList.remove('hidden');
        return;
      }

      ttEmpty.classList.add('hidden');
      renderMyPage();
    } catch (e) {
      ttLoading.classList.add('hidden');
      ttError.classList.remove('hidden');
      ttError.textContent = '网络错误';
    }
  }

  // ─── 因错误报告被返还：拉取 / 渲染 / 卡片高亮 ─────────
  /**
   * 拉取「因错误报告被返还」的提醒（GET /api/report?mine=1，需登录）
   * 后端只返回 RESOLUTION === 'returned'（作者尚未处理）的条目。
   * 401（未登录）/ 429 / 其它失败：静默跳过，不显示错误横幅，只 console.warn 记一笔
   * ——登录态提示与时刻表列表的错误提示由 loadMyTimetables 负责。
   */
  async function loadReportNotices() {
    try {
      const res = await fetch('/api/report?mine=1', { credentials: 'include' });
      if (!res.ok) {
        console.warn(`[my-timetable] 拉取错误报告提醒失败（HTTP ${res.status}），已静默跳过`);
        myReports = [];
      } else {
        const json = await res.json();
        // 仅 success 且 reports 为数组时采用；表未建/缺列时后端已降级为 reports: []
        myReports = (json && json.success && Array.isArray(json.reports)) ? json.reports : [];
      }
    } catch (e) {
      console.warn('[my-timetable] 拉取错误报告提醒异常，已静默跳过', e);
      myReports = [];
    }
    renderNotices();
    // 时刻表卡片此时可能已渲染完成，补打一次高亮（幂等）
    applyNoticeHighlight();
  }

  /** 生成只含纯文本的元素：用户/管理员输入的文本一律走 textContent，不拼 innerHTML */
  function makeTextEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = (text === undefined || text === null) ? '' : String(text);
    return el;
  }

  /**
   * 统一的「需要修正」条目，两类来源并列显示：
   *   1. 错误报告返还（TIMETABLE_REPORT.RESOLUTION = 'returned'）—— 带报告正文与管理员留言；
   *   2. 管理员普通驳回（TIMETABLE.BACK = 1 且没有对应报告）—— 没有正文可显示，用通用说明。
   *
   * 同一条时刻表只出现一次：已被报告覆盖的驳回条目跳过，避免横幅里同一张表出现两遍。
   * 两个数据源（报告接口、时刻表列表）各自独立到达，任一方为空时另一方的条目照常显示。
   *
   * @returns {Array<{kind:'report'|'rejected', tid:string, report?:object, item?:object}>}
   */
  function noticeEntries() {
    const entries = [];
    const seen = new Set();

    myReports.forEach((r) => {
      if (!r) return;
      const tid = (r.TID === undefined || r.TID === null) ? '' : String(r.TID).trim();
      if (tid) seen.add(tid);
      entries.push({ kind: 'report', tid, report: r });
    });

    myTimetables.forEach((item) => {
      if (!item || !isRejected(item)) return;
      const tid = (item.ID === undefined || item.ID === null) ? '' : String(item.ID).trim();
      if (!tid || seen.has(tid)) return;   // 已有报告条目，或拿不到 ID → 不重复列
      seen.add(tid);
      entries.push({ kind: 'rejected', tid, item });
    });

    return entries;
  }

  /** 需要修正的时刻表 ID 集合（字符串化，便于与卡片 data-tid 比对） */
  function noticeTidSet() {
    const set = new Set();
    noticeEntries().forEach((entry) => {
      if (entry.tid) set.add(entry.tid);
    });
    return set;
  }

  /** 「城市 · 线路」文本；时刻表已被删除时 CITY/WAY 为 null */
  function reportRouteText(r) {
    const city = r.CITY ? String(r.CITY).trim() : '';
    const way = r.WAY ? String(r.WAY).trim() : '';
    if (!city && !way) return '线路信息不可用（时刻表可能已删除）';
    return `${city || '未知城市'} · ${way || '未知线路'}`;
  }

  /** 「起点 ↔ 终点」文本；同上，时刻表已删除时 START/END 为 null */
  function reportStationsText(r) {
    const start = r.START ? String(r.START).trim() : '';
    const end = r.END ? String(r.END).trim() : '';
    if (!start && !end) return '站点信息不可用';
    return `${start || '?'} ↔ ${end || '?'}`;
  }

  /**
   * 构造一条提醒（含「去修改」按钮）
   * 两类条目的字段名恰好一致（CITY/WAY/START/END），所以路线与站点文本复用同一套函数；
   * 「报告返还」多显示报告正文、管理员留言与报告时间，「普通驳回」只给一句通用说明。
   */
  function buildNoticeItem(entry) {
    const data = entry.kind === 'report' ? entry.report : entry.item;
    const li = document.createElement('li');
    li.className = 'my-report-item';

    const head = document.createElement('div');
    head.className = 'my-report-item-head';
    head.appendChild(makeTextEl('span', 'my-report-item-id', `#${entry.tid || '未知ID'}`));
    head.appendChild(makeTextEl('span', 'my-report-item-route', reportRouteText(data)));
    li.appendChild(head);

    li.appendChild(makeTextEl('div', 'my-report-item-stations', reportStationsText(data)));

    if (entry.kind === 'report') {
      const r = entry.report;
      // 报告正文：用户输入的文本 → textContent
      const contentRow = document.createElement('div');
      contentRow.className = 'my-report-item-row';
      contentRow.appendChild(makeTextEl('span', 'my-report-item-label', '报告内容'));
      contentRow.appendChild(makeTextEl('span', 'my-report-item-value', r.CONTENT || '（无正文）'));
      li.appendChild(contentRow);

      // 管理员留言 RESOLVENOTE：管理员输入的文本 → textContent，有内容才显示
      const note = r.RESOLVENOTE ? String(r.RESOLVENOTE).trim() : '';
      if (note) {
        const noteRow = document.createElement('div');
        noteRow.className = 'my-report-item-row my-report-item-row--note';
        noteRow.appendChild(makeTextEl('span', 'my-report-item-label', '管理员留言'));
        noteRow.appendChild(makeTextEl('span', 'my-report-item-value', note));
        li.appendChild(noteRow);
      }

      li.appendChild(makeTextEl('div', 'my-report-item-time',
        `报告时间：${r.WRITETIME ? String(r.WRITETIME) : '未知'}`));
    } else {
      // 普通驳回没有正文与留言（审核页的驳回不填原因），只给出做了什么、该干什么
      const statusRow = document.createElement('div');
      statusRow.className = 'my-report-item-row my-report-item-row--note';
      statusRow.appendChild(makeTextEl('span', 'my-report-item-label', '审核结果'));
      statusRow.appendChild(makeTextEl('span', 'my-report-item-value',
        '管理员已驳回，请修正后重新提交审核'));
      li.appendChild(statusRow);
    }

    // 「去修改」：与卡片上「修改时刻表」按钮同一跳转目标（按 TID 打开修改页）
    const action = document.createElement('hcw-button');
    action.className = 'my-report-item-action';
    action.setAttribute('flat', '');
    action.textContent = '去修改';
    action.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.href = `/timetable-result.html?id=${encodeURIComponent(entry.tid)}`;
    });
    const actionBar = document.createElement('div');
    actionBar.className = 'my-report-item-actions';
    actionBar.appendChild(action);
    li.appendChild(actionBar);

    return li;
  }

  /**
   * 渲染顶部提醒横幅
   * 触发条件：存在任一「需要修正」的条目（错误报告返还 或 普通驳回）；
   * 两类都没有（含接口失败/401/未登录）时清空并隐藏，不留空容器或占位空白。
   */
  function renderNotices() {
    if (!ttReportNotice) return;
    // 先清空；下面所有内容都用 createElement + textContent 写入
    ttReportNotice.innerHTML = '';

    const entries = noticeEntries();
    if (entries.length === 0) {
      ttReportNotice.classList.add('hidden');
      return;
    }

    const reportCount = entries.filter((e) => e.kind === 'report').length;
    const rejectCount = entries.filter((e) => e.kind === 'rejected').length;
    let title;
    if (reportCount > 0 && rejectCount > 0) {
      title = `有 ${entries.length} 条时刻表需要修正后重新提交`
        + `（${reportCount} 条因错误报告返还，${rejectCount} 条被驳回）`;
    } else if (reportCount > 0) {
      title = `有 ${reportCount} 条时刻表因错误报告被返还，请修正后重新提交`;
    } else {
      title = `有 ${rejectCount} 条时刻表被管理员驳回，请修正后重新提交`;
    }

    const head = document.createElement('div');
    head.className = 'my-report-head';
    head.appendChild(makeTextEl('span', 'my-report-title', title));
    ttReportNotice.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'my-report-list';
    entries.forEach((entry) => list.appendChild(buildNoticeItem(entry)));
    ttReportNotice.appendChild(list);

    ttReportNotice.classList.remove('hidden');
  }

  /**
   * 给「需要修正」的卡片打高亮（左侧警示条 + 角标）
   * 命中依据：卡片上的 data-tid（renderMyPage 写入）与条目 TID 字符串相等。
   * 角标文案按来源区分：错误报告返还 / 已被驳回。
   * 幂等：重复调用不会重复插入角标；未命中时会把角标移除。
   * 与现有「被驳回」状态并存：只加 class 与角标，不改状态文案/配色。
   */
  function applyNoticeHighlight() {
    if (!ttList) return;
    const kinds = new Map();
    noticeEntries().forEach((entry) => {
      if (!entry.tid) return;
      // 同一条表既有报告又是驳回时，报告优先（信息更具体）
      if (!kinds.has(entry.tid) || entry.kind === 'report') kinds.set(entry.tid, entry.kind);
    });

    ttList.querySelectorAll('.result-item').forEach((card) => {
      const tid = card.dataset ? card.dataset.tid : '';
      const kind = tid ? kinds.get(tid) : undefined;
      const hit = Boolean(kind);
      card.classList.toggle('is-report-returned', hit);

      const existed = card.querySelector('.my-report-badge');
      if (hit && !existed) {
        const badge = document.createElement('span');
        badge.className = 'my-report-badge';
        badge.textContent = kind === 'report' ? '因报告被返还' : '已被驳回';
        (card.querySelector('.result-item-header') || card).appendChild(badge);
      } else if (!hit && existed) {
        existed.remove();
      }
    });
  }

  function renderMyPage() {
    // 一次性渲染全部时刻表
    ttList.innerHTML = '';
    myTimetables.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'result-item';
      // 记录时刻表 ID，供 applyNoticeHighlight 命中提醒（字符串化，避免类型差异）
      card.dataset.tid = String(item.ID);
      card.style.animationDelay = `${idx * 0.05}s`;

      card.innerHTML = `
        <div class="result-item-header">
          <span class="result-item-id">#${item.ID}</span>
          <span class="result-item-route">${item.CITY} · ${item.WAY}</span>
        </div>
        <div class="result-item-body">
          <div class="result-item-stations">
            <span class="station-name">${item.START}</span>
            <span class="station-arrow">↔</span>
            <span class="station-name">${item.END}</span>
          </div>
          ${item.SPECIAL && item.SPECIAL !== '无' ? `<div class="result-item-note">${item.SPECIAL}</div>` : ''}
          <div class="result-item-meta">
            <span>执行: ${(!item.STARTTIME || item.STARTTIME === '1000-1-1') ? '未知执行时间' : item.STARTTIME}</span>
            <span>写入: ${item.WRITETIME || '未知'}</span>
            <span style="font-weight:600; ${
              isRejected(item) ? 'color:var(--danger);' :
              item.PASS == true ? 'color:var(--success);' :
              'color:var(--warning);'
            }">${
              isRejected(item) ? '被驳回' :
              item.PASS == true ? '已通过' :
              '待审核'
            }</span>
          </div>
        </div>
        <div class="result-item-actions">
          <hcw-button class="detail-btn" flat style="min-width:5rem; font-size:0.82rem;">查看详情</hcw-button>
          <hcw-button class="edit-btn" flat style="min-width:5rem; font-size:0.82rem;">修改时刻表</hcw-button>
          <hcw-button class="delete-btn" flat style="min-width:5rem; font-size:0.82rem; color:var(--danger);">删除</hcw-button>
        </div>
      `;

      // 查看详情按钮
      // from=mine 让详情页的「返回」按钮回到本页（详情页已合并为单页）
      card.querySelector('.detail-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = `/timetable-detail.html?id=${encodeURIComponent(item.ID)}&from=mine`;
      });

      // 修改时刻表按钮
      card.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = `/timetable-result.html?id=${encodeURIComponent(item.ID)}`;
      });

      // 删除按钮
      card.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirm({
          text: `确定要删除 #${item.ID} 时刻表吗？此操作不可恢复。`,
          buttons: ['确定删除', '取消'],
          button_style: ['variant=danger', 'tp']
        });
        if (!confirmed) return;

        try {
          const res = await fetch('/api/timetable-D1', {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.ID, writer: myEmail })
          });
          const data = await res.json();
          if (data.success) {
            showMessage('删除成功', false);
            // 清除缓存并重新加载
            sessionStorage.removeItem('my_timetable_cache');
            loadMyTimetables();
            // 被删的时刻表可能正带着返还提醒，一并重拉，避免留下过期提醒
            loadReportNotices();
          } else {
            showMessage(data.error || '删除失败', true);
          }
        } catch (err) {
          showMessage('删除失败: 网络错误', true);
        }
      });

      ttList.appendChild(card);
    });
    // 列表到货后横幅要重建：普通驳回的条目来自 myTimetables（不在报告接口里），
    // 而横幅可能已经先按报告渲染过一次。渲染与高亮都是幂等的，重复调用安全。
    renderNotices();
    // 卡片重建后重新打一次高亮（提醒可能比列表先到）
    applyNoticeHighlight();
  }

  // 刷新按钮：两个数据源都重拉（时刻表清缓存后重查；提醒不进缓存，直接重拉）
  document.getElementById('tt-refresh-btn')?.addEventListener('click', () => {
    sessionStorage.removeItem('my_timetable_cache');
    loadMyTimetables();
    loadReportNotices();
    showMessage('已刷新', false);
  });

  // ─── 加载我的时刻表 + 错误报告返还提醒 ─────────────
  loadMyTimetables();
  loadReportNotices();
});
