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

  async function loadMyTimetables() {
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
    renderReportNotices();
    // 时刻表卡片此时可能已渲染完成，补打一次高亮（幂等）
    applyReportHighlight();
  }

  /** 生成只含纯文本的元素：用户/管理员输入的文本一律走 textContent，不拼 innerHTML */
  function makeTextEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = (text === undefined || text === null) ? '' : String(text);
    return el;
  }

  /** 报告对应的时刻表 ID 集合（字符串化，便于与卡片 data-tid 比对） */
  function reportTidSet() {
    const set = new Set();
    myReports.forEach((r) => {
      if (!r || r.TID === undefined || r.TID === null) return;
      const tid = String(r.TID).trim();
      if (tid) set.add(tid);
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

  /** 构造一条提醒（含「去修改」按钮） */
  function buildReportItem(r) {
    const li = document.createElement('li');
    li.className = 'my-report-item';

    const head = document.createElement('div');
    head.className = 'my-report-item-head';
    head.appendChild(makeTextEl('span', 'my-report-item-id', `#${r.TID}`));
    head.appendChild(makeTextEl('span', 'my-report-item-route', reportRouteText(r)));
    li.appendChild(head);

    li.appendChild(makeTextEl('div', 'my-report-item-stations', reportStationsText(r)));

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

    // 「去修改」：与卡片上「修改时刻表」按钮同一跳转目标（按 TID 打开修改页）
    const action = document.createElement('hcw-button');
    action.className = 'my-report-item-action';
    action.setAttribute('flat', '');
    action.textContent = '去修改';
    action.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.href = `/timetable-result.html?id=${encodeURIComponent(r.TID)}`;
    });
    const actionBar = document.createElement('div');
    actionBar.className = 'my-report-item-actions';
    actionBar.appendChild(action);
    li.appendChild(actionBar);

    return li;
  }

  /**
   * 渲染顶部提醒横幅
   * 触发条件只有一条：reports.length > 0；为空（含接口失败/401/未登录）时清空并隐藏，
   * 不留下空容器或占位空白。
   */
  function renderReportNotices() {
    if (!ttReportNotice) return;
    // 先清空；下面所有内容都用 createElement + textContent 写入
    ttReportNotice.innerHTML = '';
    if (myReports.length === 0) {
      ttReportNotice.classList.add('hidden');
      return;
    }

    const head = document.createElement('div');
    head.className = 'my-report-head';
    head.appendChild(makeTextEl('span', 'my-report-title',
      `有 ${myReports.length} 条时刻表因错误报告被返还，请修正后重新提交`));
    ttReportNotice.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'my-report-list';
    myReports.forEach((r) => {
      if (r) list.appendChild(buildReportItem(r));
    });
    ttReportNotice.appendChild(list);

    ttReportNotice.classList.remove('hidden');
  }

  /**
   * 给命中 TID 的卡片打高亮（左侧警示色 + 角标「因报告被返还」）
   * 命中依据：卡片上的 data-tid（renderMyPage 写入）与报告 TID 字符串相等。
   * 幂等：重复调用不会重复插入角标；未命中时会把角标移除。
   * 与现有「被驳回」状态并存：只加 class 与角标，不改状态文案/配色。
   */
  function applyReportHighlight() {
    if (!ttList) return;
    const tids = reportTidSet();
    ttList.querySelectorAll('.result-item').forEach((card) => {
      const tid = card.dataset ? card.dataset.tid : '';
      const hit = Boolean(tid) && tids.has(tid);
      card.classList.toggle('is-report-returned', hit);

      const existed = card.querySelector('.my-report-badge');
      if (hit && !existed) {
        const badge = document.createElement('span');
        badge.className = 'my-report-badge';
        badge.textContent = '因报告被返还';
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
      // 记录时刻表 ID，供 applyReportHighlight 命中提醒（字符串化，避免类型差异）
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
    // 卡片重建后重新打一次高亮（提醒可能比列表先到）
    applyReportHighlight();
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
