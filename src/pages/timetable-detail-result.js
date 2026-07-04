// ─── 时刻表详情页（从个人主页进入）────────────────

// DOM 元素
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

// ─── 工具函数 ────────────────────────────────

function showMessage(msg, isError) {
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style.cssText = 'position:fixed; top:20px; left:50%; padding:10px 20px; border-radius:5px; z-index:9999; color:#fff; font-size:0.85rem; animation: fadeInOut 2s ease forwards; transform:translateX(-50%);';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2000);

  if (!document.getElementById('showMsgAnimStyles')) {
    const styleSheet = document.createElement('style');
    styleSheet.id = 'showMsgAnimStyles';
    styleSheet.textContent = `
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        15%  { opacity: 1; transform: translateX(-50%) translateY(0); }
        85%  { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      }
    `;
    document.head.appendChild(styleSheet);
  }
}

function formatTimeDisplay(timeStr) {
  if (!timeStr || timeStr === 'unknown') return [];
  const parts = timeStr.split(/[\t\n\r]+/).filter(t => t.trim());
  return parts.map(p => p.trim()).filter(p => p);
}

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// ─── 加载详情 ────────────────────────────────

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
    detailLoading.classList.add('hidden');
    detailError.classList.remove('hidden');
    document.querySelector('.detail-error p').textContent = e.message || '无法加载时刻表详情';
  }
}

function renderDetail(item) {
  detailLoading.classList.add('hidden');
  detailError.classList.add('hidden');
  detailContent.classList.remove('hidden');

  // 标题和信息
  detailTitle.textContent = `${item.CITY} · ${item.WAY}`;
  detailId.textContent = `#${item.ID}`;
  detailCity.textContent = item.CITY || '-';
  detailWay.textContent = item.WAY || '-';
  detailStart.textContent = item.START || '-';
  detailEnd.textContent = item.END || '-';
  detailSpecial.textContent = item.SPECIAL && item.SPECIAL !== '无' ? item.SPECIAL : '无';

  // 主站→副站时刻表
  const time1Parts = formatTimeDisplay(item.TIMEONE);
  detailTime1.innerHTML = '';
  if (time1Parts.length > 0) {
    time1Parts.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'detail-time-chip';
      chip.textContent = t;
      detailTime1.appendChild(chip);
    });
  } else if (item.TIMEONE === 'Remove') {
    detailTime1.innerHTML = '<span class="detail-time-chip">线路已撤销</span>';
  } else {
    detailTime1.innerHTML = '<span class="detail-time-chip">未填写或无发车班次</span>';
  }

  // 副站→主站时刻表
  const time2Parts = formatTimeDisplay(item.TIMETWO);
  detailTime2.innerHTML = '';
  if (time2Parts.length > 0) {
    time2Parts.forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'detail-time-chip';
      chip.textContent = t;
      detailTime2.appendChild(chip);
    });
  } else if (item.TIMETWO === 'Remove') {
    detailTime2.innerHTML = '<span class="detail-time-chip">线路已撤销</span>';
  } else {
    detailTime2.innerHTML = '<span class="detail-time-chip">未填写或无发车班次</span>';
  }

  // 元信息
  detailStarttime.textContent = (!item.STARTTIME || item.STARTTIME === '1000-1-1') ? '执行时间未知' : item.STARTTIME;
  detailWriter.textContent = item.WRITER_NAME || item.WRITER || '未知';
  detailWritetime.textContent = item.WRITETIME || '未知';

  // 滚动到顶部
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── 事件绑定 ────────────────────────────────

backBtn.addEventListener('click', () => {
  window.location.href = '/account.html';
});

detailBackBtn.addEventListener('click', () => {
  window.location.href = '/account.html';
});

detailRetryBtn.addEventListener('click', loadDetail);

// ─── 启动 ────────────────────────────────

loadDetail();
