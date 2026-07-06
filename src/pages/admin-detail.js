// ─── 管理员时刻表详情页 ─────────────────────────

// ─── JWT 解析辅助 ─────────────────────────────
function parseJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload));
  } catch { return null; }
}

// ─── 管理员 JWT 验证 ──────────────────────────
(function checkAuth() {
  const token = sessionStorage.getItem('admin_token');
  if (!token) {
    sessionStorage.removeItem('admin_logged_in');
    sessionStorage.removeItem('admin_email');
    window.location.href = '/admin-login.html';
    return;
  }
  const payload = parseJwtPayload(token);
  if (!payload || payload.role !== 'admin' || Date.now() / 1000 > payload.exp) {
    sessionStorage.removeItem('admin_token');
    sessionStorage.removeItem('admin_email');
    sessionStorage.removeItem('admin_logged_in');
    window.location.href = '/admin-login.html';
    return;
  }
})();

const backBtn = document.getElementById('back-btn');
const detailBackBtn = document.getElementById('detail-back-btn');
const detailLoading = document.getElementById('detail-loading');
const detailError = document.getElementById('detail-error');
const detailContent = document.getElementById('detail-content');
const detailRetryBtn = document.getElementById('detail-retry-btn');

const detailTitle = document.getElementById('detail-title');
const detailId = document.getElementById('detail-id');
const detailCity = document.getElementById('detail-city');
const detailWay = document.getElementById('detail-way');
const detailStart = document.getElementById('detail-start');
const detailEnd = document.getElementById('detail-end');
const detailSpecial = document.getElementById('detail-special');
const detailTime1 = document.getElementById('detail-time1');
const detailTime2 = document.getElementById('detail-time2');
const detailStarttime = document.getElementById('detail-starttime');
const detailWriter = document.getElementById('detail-writer');
const detailWritetime = document.getElementById('detail-writetime');
const detailPassStatus = document.getElementById('detail-pass-status');
const detailPasser = document.getElementById('detail-passer');

function showMessage(msg, isError) {
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style.cssText = 'position:fixed; top:20px; left:50%; padding:10px 20px; border-radius:5px; z-index:9999; color:#fff; font-size:0.85rem; animation: fadeInOut 2s ease forwards; transform:translateX(-50%);';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2000);
  if (!document.getElementById('showMsgAnimStyles_admin_detail')) {
    const ss = document.createElement('style');
    ss.id = 'showMsgAnimStyles_admin_detail';
    ss.textContent = '@keyframes fadeInOut{0%{opacity:0;transform:translateX(-50%) translateY(-20px)}15%{opacity:1;transform:translateX(-50%) translateY(0)}85%{opacity:1;transform:translateX(-50%) translateY(0)}100%{opacity:0;transform:translateX(-50%) translateY(-20px)}}';
    document.head.appendChild(ss);
  }
}

function formatTimeDisplay(timeStr) {
  if (!timeStr || timeStr === 'unknown') return [];
  return timeStr.split(/[\t\n\r]+/).filter(t => t.trim()).map(p => p.trim()).filter(p => p);
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

let loadedData = null;

async function loadDetail() {
  const id = getQueryParam('id');
  if (!id) {
    detailLoading.classList.add('hidden');
    detailError.classList.remove('hidden');
    document.querySelector('.detail-error p').textContent = '缺少时刻表ID参数';
    return;
  }

  detailLoading.classList.remove('hidden');
  detailError.classList.add('hidden');
  detailContent.classList.add('hidden');

  try {
    const res = await fetch(`/api/timetable-D1?id=${encodeURIComponent(id)}`, {
      credentials: 'include'
    });
    if (!res.ok) throw new Error('请求失败');
    const json = await res.json();
    if (!json.success || !json.data) throw new Error(json.message || '找不到数据');

    loadedData = json.data;
    renderDetail(loadedData);
  } catch (e) {
    console.error('加载详情失败:', e);
    detailLoading.classList.add('hidden');
    detailError.classList.remove('hidden');
    document.querySelector('.detail-error p').textContent = e.message || '无法加载时刻表详情';
  }
}

function renderDetail(item) {
  detailLoading.classList.add('hidden');
  detailError.classList.add('hidden');
  detailContent.classList.remove('hidden');

  detailTitle.textContent = `${item.CITY} · ${item.WAY}`;
  detailId.textContent = `#${item.ID}`;
  detailCity.textContent = item.CITY || '-';
  detailWay.textContent = item.WAY || '-';
  detailStart.textContent = item.START || '-';
  detailEnd.textContent = item.END || '-';
  detailSpecial.textContent = item.SPECIAL && item.SPECIAL !== '无' ? item.SPECIAL : '无';

  const t1 = formatTimeDisplay(item.TIMEONE);
  detailTime1.innerHTML = '';
  if (t1.length > 0) {
    t1.forEach(t => { const chip = document.createElement('span'); chip.className = 'detail-time-chip'; chip.textContent = t; detailTime1.appendChild(chip); });
  } else if (item.TIMEONE === 'Remove') {
    detailTime1.innerHTML = '<span class="detail-time-chip">线路已撤销</span>';
  } else {
    detailTime1.innerHTML = '<span class="detail-time-chip">未填写或无发车班次</span>';
  }

  const t2 = formatTimeDisplay(item.TIMETWO);
  detailTime2.innerHTML = '';
  if (t2.length > 0) {
    t2.forEach(t => { const chip = document.createElement('span'); chip.className = 'detail-time-chip'; chip.textContent = t; detailTime2.appendChild(chip); });
  } else if (item.TIMETWO === 'Remove') {
    detailTime2.innerHTML = '<span class="detail-time-chip">线路已撤销</span>';
  } else {
    detailTime2.innerHTML = '<span class="detail-time-chip">未填写或无发车班次</span>';
  }

  detailStarttime.textContent = (!item.STARTTIME || item.STARTTIME === '1000-1-1') ? '执行时间未知' : item.STARTTIME;
  detailWriter.textContent = item.WRITER_NAME || item.WRITER || '未知';
  detailWritetime.textContent = item.WRITETIME || '未知';

  const isRejected = item.SPECIAL && item.SPECIAL.includes('【时刻表被驳回】');
  if (item.PASS == true) {
    detailPassStatus.textContent = '已审核';
    detailPassStatus.style.color = 'var(--success)';
    detailPasser.textContent = item.PASSER || '管理员';
  } else if (isRejected) {
    detailPassStatus.textContent = '被驳回';
    detailPassStatus.style.color = 'var(--danger)';
    detailPasser.textContent = item.PASSER || '管理员';
  } else {
    detailPassStatus.textContent = '待审核';
    detailPassStatus.style.color = 'var(--warning)';
    detailPasser.textContent = '—';
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

backBtn.addEventListener('click', () => window.location.href = '/admin-review.html');
detailBackBtn.addEventListener('click', () => window.location.href = '/admin-review.html');
detailRetryBtn.addEventListener('click', loadDetail);

loadDetail();
