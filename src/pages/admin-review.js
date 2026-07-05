// ─── 管理员时刻表审核页面 ─────────────────────────

(function checkAuth() {
  if (sessionStorage.getItem('admin_logged_in') !== 'true') {
    window.location.href = '/admin-login.html';
    return;
  }
  const email = sessionStorage.getItem('admin_email');
  if (email) {
    const el = document.getElementById('adminEmailDisplay');
    if (el) el.textContent = email;
  }
})();

// ─── DOM ────────────────────────────────────
const backBtn = document.getElementById('backBtn');
const logoutBtn = document.getElementById('logoutBtn');
const loadBtn = document.getElementById('loadReviewBtn');
const reviewPanel = document.getElementById('reviewPanel');

const unreviewedList = document.getElementById('unreviewedList');
const reviewedList = document.getElementById('reviewedList');
const unreviewedLoading = document.getElementById('unreviewedLoading');
const reviewedLoading = document.getElementById('reviewedLoading');
const unreviewedEmpty = document.getElementById('unreviewedEmpty');
const reviewedEmpty = document.getElementById('reviewedEmpty');
const unreviewedCount = document.getElementById('unreviewedCount');
const reviewedCount = document.getElementById('reviewedCount');

// ─── 分页 DOM ───────────────────────────────
const unreviewedPagination = document.getElementById('unreviewedPagination');
const reviewedPagination = document.getElementById('reviewedPagination');
const unreviewedPrevBtn = document.getElementById('unreviewedPrevBtn');
const unreviewedNextBtn = document.getElementById('unreviewedNextBtn');
const reviewedPrevBtn = document.getElementById('reviewedPrevBtn');
const reviewedNextBtn = document.getElementById('reviewedNextBtn');
const unreviewedPageInfo = document.getElementById('unreviewedPageInfo');
const reviewedPageInfo = document.getElementById('reviewedPageInfo');

const PAGE_SIZE = 5;

// ─── 分页状态 ───────────────────────────────
const pageState = {
  unreviewed: { data: [], page: 0 },
  reviewed: { data: [], page: 0 }
};

const adminEmail = sessionStorage.getItem('admin_email') || '';

// ─── 工具 ────────────────────────────────────
function showMessage(msg, isError) {
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style.cssText = 'position:fixed; top:20px; left:50%; padding:10px 20px; border-radius:5px; z-index:9999; color:#fff; font-size:0.85rem; animation: fadeInOut 2s ease forwards; transform:translateX(-50%);';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2500);

  if (!document.getElementById('showMsgAnimStyles_admin')) {
    const ss = document.createElement('style');
    ss.id = 'showMsgAnimStyles_admin';
    ss.textContent = `@keyframes fadeInOut{0%{opacity:0;transform:translateX(-50%) translateY(-20px)}15%{opacity:1;transform:translateX(-50%) translateY(0)}85%{opacity:1;transform:translateX(-50%) translateY(0)}100%{opacity:0;transform:translateX(-50%) translateY(-20px)}}`;
    document.head.appendChild(ss);
  }
}

function formatTimeShort(timeStr) {
  if (!timeStr || timeStr === 'unknown') return '未知';
  const parts = timeStr.split(/[\t\n\r]+/).filter(t => t.trim());
  if (parts.length <= 4) return parts.join(' ');
  return parts.slice(0, 4).join(' ') + '...';
}

// ─── 操作 ────────────────────────────────────
async function approveItem(item) {
  if (!confirm(`确认通过时刻表 #${item.ID}？`)) return;
  try {
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.ID, passer: adminEmail, pass: 1 })
    });
    const data = await res.json();
    if (res.ok) { showMessage('已通过', false); loadReviewData(); }
    else { showMessage(data.error || '操作失败', true); }
  } catch { showMessage('网络错误', true); }
}

async function rejectItem(item) {
  if (!confirm(`确认驳回时刻表 #${item.ID}？`)) return;
  try {
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.ID, passer: adminEmail, action: 'reject' })
    });
    if (res.ok) { showMessage('已驳回', false); loadReviewData(); }
    else { const d = await res.json().catch(()=>({})); showMessage(d.error || '操作失败', true); }
  } catch { showMessage('网络错误', true); }
}

async function deleteItem(item) {
  if (!confirm(`确认永久删除时刻表 #${item.ID}？此操作不可撤销。`)) return;
  if (!confirm(`再次确认：删除 ${item.CITY} ${item.WAY}？`)) return;
  try {
    const res = await fetch('/api/admin', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.ID })
    });
    if (res.ok) { showMessage('已删除', false); loadReviewData(); }
    else { const d = await res.json().catch(()=>({})); showMessage(d.message || d.error || '删除失败', true); }
  } catch { showMessage('网络错误', true); }
}

// ─── 渲染 ────────────────────────────────────
function createTimetableCard(item, isUnreviewed) {
  const card = document.createElement('div');
  card.className = 'result-item';
  card.dataset.id = item.ID;

  card.innerHTML = `
    <div class="result-item-header">
      <span class="result-item-id">#${item.ID}</span>
      <span class="result-item-route">${item.CITY || '?'} · ${item.WAY || '?'}</span>
    </div>
    <div class="result-item-body">
      <div class="result-item-stations">
        <span class="station-label">起点</span>
        <span class="station-name">${item.START || '?'}</span>
        <span class="station-arrow">→</span>
        <span class="station-label">终点</span>
        <span class="station-name">${item.END || '?'}</span>
      </div>
      ${item.SPECIAL && item.SPECIAL !== '无' ? `<div class="result-item-note">${item.SPECIAL}</div>` : ''}
      <div class="result-item-times" style="display:flex; flex-direction:column; gap:2px; font-size:0.82rem;">
        <div class="time-row"><span class="time-label">外环:</span><span class="time-value">${formatTimeShort(item.TIMEONE)}</span></div>
        <div class="time-row"><span class="time-label">内环:</span><span class="time-value">${formatTimeShort(item.TIMETWO)}</span></div>
      </div>
      <div class="result-item-meta">
        <span>执行: ${(!item.STARTTIME || item.STARTTIME === '1000-1-1') ? '未知' : item.STARTTIME}</span>
        <span>作者: ${item.WRITER_NAME || item.WRITER || '未知'}</span>
        <span>写入: ${item.WRITETIME || '未知'}</span>
        ${
          item.PASS === 1 ? `<span>审核: ${item.PASSER || '管理员'}</span>` :
          (item.SPECIAL && item.SPECIAL.includes('【时刻表被驳回】')) ? '<span style="color:var(--danger);">被驳回</span>' :
          '<span style="color:var(--warning);">待审核</span>'
        }
      </div>
    </div>
    <div class="result-item-actions" style="gap:6px; flex-wrap:wrap;">
      ${isUnreviewed ? `
        <hcw-button class="approve-btn" primary flat style="min-width:4rem; font-size:0.8rem;">通过</hcw-button>
        <hcw-button class="reject-btn" variant="danger" flat style="min-width:4rem; font-size:0.8rem;">驳回</hcw-button>
      ` : `<span style="font-size:0.78rem; color:var(--text-muted);">已审核</span>`}
      <hcw-button class="delete-btn" tp flat style="min-width:4rem; font-size:0.8rem; color:var(--danger);">删除</hcw-button>
      <hcw-button class="modify-btn" flat style="min-width:4rem; font-size:0.8rem;" data-id="${item.ID}">修改</hcw-button>
    </div>
  `;

  if (isUnreviewed) {
    card.querySelector('.approve-btn').addEventListener('click', e => { e.stopPropagation(); approveItem(item); });
    card.querySelector('.reject-btn').addEventListener('click', e => { e.stopPropagation(); rejectItem(item); });
  }
  card.querySelector('.delete-btn').addEventListener('click', e => { e.stopPropagation(); deleteItem(item); });
  card.addEventListener('click', () => { window.location.href = `/admin-detail.html?id=${encodeURIComponent(item.ID)}`; });
  card.querySelector('.modify-btn').addEventListener('click', e => {
    e.stopPropagation();
    window.location.href = `/timetable-result.html?id=${encodeURIComponent(item.ID)}`;
  });

  return card;
}

// ─── 分页渲染 ────────────────────────────────
function renderPage(key, isUnreviewed) {
  const state = pageState[key];
  const list = key === 'unreviewed' ? unreviewedList : reviewedList;
  const empty = key === 'unreviewed' ? unreviewedEmpty : reviewedEmpty;
  const pagination = key === 'unreviewed' ? unreviewedPagination : reviewedPagination;
  const prevBtn = key === 'unreviewed' ? unreviewedPrevBtn : reviewedPrevBtn;
  const nextBtn = key === 'unreviewed' ? unreviewedNextBtn : reviewedNextBtn;
  const pageInfo = key === 'unreviewed' ? unreviewedPageInfo : reviewedPageInfo;

  const total = state.data.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;

  const start = state.page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  const pageData = state.data.slice(start, end);

  list.innerHTML = '';

  if (total === 0) {
    empty.classList.remove('hidden');
    pagination.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  pagination.classList.remove('hidden');
  pageInfo.textContent = `${state.page + 1}/${totalPages}`;
  prevBtn.disabled = state.page === 0;
  nextBtn.disabled = state.page >= totalPages - 1;

  pageData.forEach(item => list.appendChild(createTimetableCard(item, isUnreviewed)));
}

// ─── 加载数据 ────────────────────────────────
async function loadReviewData() {
  unreviewedLoading.classList.remove('hidden');
  reviewedLoading.classList.remove('hidden');
  unreviewedList.innerHTML = '';
  reviewedList.innerHTML = '';
  unreviewedEmpty.classList.add('hidden');
  reviewedEmpty.classList.add('hidden');

  try {
    const res = await fetch('/api/admin', { credentials: 'include' });
    let allData = [];
    if (res.ok) { const json = await res.json(); if (json.success && json.data) allData = json.data; }

    const REJECT_MARK = '【时刻表被驳回】';
    const unreviewed = allData.filter(item => (item.PASS === 0 || item.PASS === undefined || item.PASS === null) && !(item.SPECIAL && item.SPECIAL.includes(REJECT_MARK)));
    const reviewed = allData.filter(item => item.PASS === 1);
    const rejected = allData.filter(item => item.SPECIAL && item.SPECIAL.includes(REJECT_MARK));

    // 未审核 + 被驳回合并显示在未审核区
    pageState.unreviewed.data = [...unreviewed, ...rejected];
    pageState.unreviewed.page = 0;
    pageState.reviewed.data = reviewed;
    pageState.reviewed.page = 0;

    unreviewedLoading.classList.add('hidden');
    reviewedLoading.classList.add('hidden');
    unreviewedCount.textContent = pageState.unreviewed.data.length + ' 条';
    reviewedCount.textContent = pageState.reviewed.data.length + ' 条';

    renderPage('unreviewed', true);
    renderPage('reviewed', false);
  } catch (e) {
    console.error('加载审核数据失败:', e);
    unreviewedLoading.textContent = '加载失败，请重试';
    reviewedLoading.textContent = '加载失败，请重试';
    showMessage('加载数据失败', true);
  }
}

// ─── 分页切换 ────────────────────────────────
function changePage(key, delta, isUnreviewed) {
  const state = pageState[key];
  const totalPages = Math.max(1, Math.ceil(state.data.length / PAGE_SIZE));
  const newPage = state.page + delta;
  if (newPage < 0 || newPage >= totalPages) return;
  state.page = newPage;
  renderPage(key, isUnreviewed);
}

// ─── 事件绑定 ────────────────────────────────
backBtn.addEventListener('click', () => window.location.href = '/index.html');

logoutBtn.addEventListener('click', () => {
  sessionStorage.removeItem('admin_logged_in');
  sessionStorage.removeItem('admin_token');
  sessionStorage.removeItem('admin_email');
  window.location.href = '/admin-login.html';
});

loadBtn.addEventListener('click', () => {
  reviewPanel.classList.remove('hidden');
  loadBtn.disabled = true;
  loadBtn.textContent = '加载中...';
  loadReviewData().finally(() => {
    loadBtn.textContent = '刷新审核列表';
    loadBtn.disabled = false;
  });
});

// ─── 分页按钮事件 ────────────────────────────
unreviewedPrevBtn.addEventListener('click', () => changePage('unreviewed', -1, true));
unreviewedNextBtn.addEventListener('click', () => changePage('unreviewed', 1, true));
reviewedPrevBtn.addEventListener('click', () => changePage('reviewed', -1, false));
reviewedNextBtn.addEventListener('click', () => changePage('reviewed', 1, false));
