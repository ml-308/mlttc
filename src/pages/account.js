// ─── 个人信息页面逻辑 ────────────────────────────────

// 验证提示（参考 timetables.js 的 msgout）
function msgout(input, test, msg, judge) {
  if (judge === 1) {
    input.style.borderColor = '#1eff01';
    test.style.color = '#1eff01';
    test.textContent = msg;
    test.style.display = 'block';
  } else if (judge === 0) {
    input.style.borderColor = '#ff0000';
    test.style.color = '#ff0000';
    test.textContent = msg;
    test.style.display = 'block';
  } else if (judge === 2) {
    input.style.borderColor = '#8881';
    test.style.color = 'var(--text-secondary)';
    test.textContent = msg;
    test.style.display = 'none';
  } else if (judge === 3) {
    input.style.borderColor = '#f3f30e';
    test.style.color = '#f3f30e';
    test.textContent = msg;
    test.style.display = 'block';
  }
}

function showMessage(msg, isError) {
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style.cssText = 'position:fixed; top:20px; left:50%; padding:10px 20px; border-radius:5px; z-index:9999; color:#fff; font-size:0.85rem; animation: fadeInOut 2s ease forwards; transform:translateX(-50%);';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2500);

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

async function loadProfile() {
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (!res.ok) {
      document.getElementById('profileDisplayName').textContent = '未登录';
      return;
    }
    const data = await res.json();
    const user = data.user || data;
    document.getElementById('profileDisplayName').textContent = user.NAME || '未设置昵称';
    document.getElementById('profileEmail').textContent = user.email || '—';
    document.getElementById('profileCity').textContent = user.city || '未设置';
    if (user.registertime) {
      document.getElementById('profileRegDate').textContent = user.registertime;
    }
    // 更新 cookie 中的昵称（无论是否有值，都写入以便 header 判断登录状态）
    document.cookie = `user_name=${encodeURIComponent(user.NAME || '')}; Path=/; Max-Age=3600; SameSite=Lax`;
    if (user.NAME) document.getElementById('nameInput').placeholder = user.NAME;
    if (user.city) document.getElementById('cityInput').placeholder = user.city;
  } catch (e) {
    console.error('加载用户信息失败:', e);
  }
}

async function saveProfile(name, city) {
  const body = {};
  if (name !== undefined && name !== null) body.NAME = name;
  if (city !== undefined && city !== null) body.city = city;

  const res = await fetch('/api/update-profile', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok) {
    if (res.status === 409) {
      showMessage((data.error || '该昵称已被使用'), true);
    } else {
      showMessage((data.error || '保存失败'), true);
    }
    return false;
  }

  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();

  // 返回按钮
  document.getElementById('backBtn')?.addEventListener('click', () => window.location.href = '/index.html');

  // 登录按钮
  document.getElementById('globalLoginBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('globalLoginModal');
    if (modal) modal.style.display = 'flex';
    else window.location.href = '/login.html';
  });

  // 退出按钮
  document.getElementById('globalLogoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/logout-D1', { credentials: 'include' });
    window.location.href = '/login.html';
  });

  // 实时验证：昵称（最多6字）
  const nameInput = document.getElementById('nameInput');
  const nameMsg = document.getElementById('nameMsg');
  if (nameInput && nameMsg) {
    nameInput.addEventListener('input', () => {
      const v = nameInput.value;
      if (v.includes('@')) {
        msgout(nameInput, nameMsg, '昵称不能包含@字符', 0);
      } else if (v.length > 6) {
        msgout(nameInput, nameMsg, '昵称不能超过6个字符', 0);
      } else if (v.length > 0) {
        msgout(nameInput, nameMsg, '✓ 昵称格式正确', 1);
      } else {
        msgout(nameInput, nameMsg, '', 2);
      }
    });
  }

  // 实时验证：城市（最多6字）
  const cityInput = document.getElementById('cityInput');
  const cityMsg = document.getElementById('cityMsg');
  if (cityInput && cityMsg) {
    cityInput.addEventListener('input', () => {
      const v = cityInput.value;
      if (v.length > 6) {
        msgout(cityInput, cityMsg, '城市名不能超过6个字符', 0);
      } else if (v.length > 0) {
        msgout(cityInput, cityMsg, '✓ 城市名格式正确', 1);
      } else {
        msgout(cityInput, cityMsg, '', 2);
      }
    });
  }

  // ─── 加载我的时刻表 ─────────────────────────────
  loadMyTimetables();

  // 保存按钮
  document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const name = nameInput?.value.trim() || null;
    const city = cityInput?.value.trim() || null;

    // 提交前再次校验
    if (name && name.includes('@')) {
      showMessage('昵称不能包含@字符', true);
      return;
    }
    if (name && name.length > 6) {
      showMessage('昵称不能超过6个字符', true);
      return;
    }
    if (city && city.length > 6) {
      showMessage('城市名不能超过6个字符', true);
      return;
    }
    if (!name && !city) {
      showMessage('请至少填写一项', true);
      return;
    }

    const ok = await saveProfile(name, city);
    if (ok) {
      showMessage('保存成功', false);
      if (name) {
        document.getElementById('profileDisplayName').textContent = name;
        nameInput.placeholder = name;
        nameInput.value = '';
        msgout(nameInput, nameMsg, '', 2);
        document.cookie = `user_name=${encodeURIComponent(name)}; Path=/; Max-Age=3600; SameSite=Lax`;
      }
      if (city) {
        document.getElementById('profileCity').textContent = city;
        cityInput.placeholder = city;
        cityInput.value = '';
        msgout(cityInput, cityMsg, '', 2);
      }
    }
  });

  // ─── 我的时刻表 - 分页与渲染 ─────────────────────
  // 卡片含2个操作按钮，每页3条可完整显示
  const PAGE_SIZE = 3;
  let myTimetables = [];
  let myCurrentPage = 0;

  const ttList = document.getElementById('timetable-list');
  const ttLoading = document.getElementById('timetable-loading');
  const ttEmpty = document.getElementById('timetable-empty');
  const ttError = document.getElementById('timetable-error');
  const ttPagination = document.getElementById('timetable-pagination');
  const ttPageInfo = document.getElementById('tt-page-info');
  const ttPrevBtn = document.getElementById('tt-prev-btn');
  const ttNextBtn = document.getElementById('tt-next-btn');

  async function loadMyTimetables() {
    // 先获取用户邮箱
    let email = '';
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

    // 尝试从 sessionStorage 读取缓存
    const CACHE_KEY = 'account_tt_cache';
    let cached = null;
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch { /* ignore */ }

    if (cached && cached.email === email && Array.isArray(cached.data)) {
      // 缓存命中，直接使用
      myTimetables = cached.data;
      // 已通过优先排序
      myTimetables.sort((a, b) => (b.PASS == true ? 1 : 0) - (a.PASS == true ? 1 : 0));
      myCurrentPage = 0;
      ttLoading.classList.add('hidden');

      if (myTimetables.length === 0) {
        ttEmpty.classList.remove('hidden');
        ttPagination.classList.add('hidden');
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
      // 已通过优先排序
      myTimetables.sort((a, b) => (b.PASS == true ? 1 : 0) - (a.PASS == true ? 1 : 0));
      myCurrentPage = 0;

      // 写入缓存
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ email, data: myTimetables }));
      } catch { /* ignore */ }

      ttLoading.classList.add('hidden');

      if (myTimetables.length === 0) {
        ttEmpty.classList.remove('hidden');
        ttPagination.classList.add('hidden');
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

  function renderMyPage() {
    const start = myCurrentPage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, myTimetables.length);
    const pageData = myTimetables.slice(start, end);
    const totalPages = Math.ceil(myTimetables.length / PAGE_SIZE);

    ttPageInfo.textContent = `${myCurrentPage + 1}/${totalPages}`;
    ttPrevBtn.disabled = myCurrentPage === 0;
    ttNextBtn.disabled = myCurrentPage >= totalPages - 1;
    ttPagination.classList.remove('hidden');

    ttList.innerHTML = '';
    pageData.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'result-item';
      card.style.animationDelay = `${idx * 0.05}s`;

      const time1Display = formatTimeDisplay(item.TIMEONE);
      const time2Display = formatTimeDisplay(item.TIMETWO);

      card.innerHTML = `
        <div class="result-item-header">
          <span class="result-item-id">#${item.ID}</span>
          <span class="result-item-route">${item.CITY} · ${item.WAY}</span>
        </div>
        <div class="result-item-body">
          <div class="result-item-stations">
            <span class="station-label">起点</span>
            <span class="station-name">${item.START}</span>
            <span class="station-arrow">→</span>
            <span class="station-label">终点</span>
            <span class="station-name">${item.END}</span>
          </div>
          ${item.SPECIAL && item.SPECIAL !== '无' ? `<div class="result-item-note">${item.SPECIAL}</div>` : ''}
          <div class="result-item-meta">
            <span>执行: ${(!item.STARTTIME || item.STARTTIME === '1000-1-1') ? '未知执行时间' : item.STARTTIME}</span>
            <span>写入: ${item.WRITETIME || '未知'}</span>
            <span style="font-weight:600; ${
              item.PASS == true ? 'color:var(--success);' :
              (item.SPECIAL && item.SPECIAL.includes('【时刻表被驳回】')) ? 'color:var(--danger);' :
              'color:var(--warning);'
            }">${
              item.PASS == true ? '已通过' :
              (item.SPECIAL && item.SPECIAL.includes('【时刻表被驳回】')) ? '被驳回' :
              '待审核'
            }</span>
          </div>
        </div>
        <div class="result-item-actions">
          <hcw-button class="detail-btn" flat style="min-width:5rem; font-size:0.82rem;">查看详情</hcw-button>
          <hcw-button class="edit-btn" flat style="min-width:5rem; font-size:0.82rem;">修改时刻表</hcw-button>
        </div>
      `;

      const isRejected = item.SPECIAL && item.SPECIAL.includes('【时刻表被驳回】');

      // 查看详情按钮
      card.querySelector('.detail-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        // 被驳回的时刻表：查看后删除
        if (isRejected) {
          if (confirm('该时刻表已被管理员驳回，查看后将自动删除。确定查看？')) {
            fetch('/api/admin', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.ID })
            }).catch(() => {});
            window.location.href = `/timetable-detail-result.html?id=${encodeURIComponent(item.ID)}`;
          }
        } else {
          window.location.href = `/timetable-detail-result.html?id=${encodeURIComponent(item.ID)}`;
        }
      });

      // 修改时刻表按钮（被驳回的不可修改）
      if (isRejected) {
        card.querySelector('.edit-btn').disabled = true;
        card.querySelector('.edit-btn').style.opacity = '0.4';
        card.querySelector('.edit-btn').textContent = '已驳回';
      } else {
        card.querySelector('.edit-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          window.location.href = `/timetable-result.html?id=${encodeURIComponent(item.ID)}`;
        });
      }

      ttList.appendChild(card);
    });
  }

  function changeMyPage(delta) {
    const totalPages = Math.ceil(myTimetables.length / PAGE_SIZE);
    const newPage = myCurrentPage + delta;
    if (newPage < 0 || newPage >= totalPages) return;
    myCurrentPage = newPage;
    renderMyPage();
  }

  ttPrevBtn.addEventListener('click', () => changeMyPage(-1));
  ttNextBtn.addEventListener('click', () => changeMyPage(1));

  function formatTimeDisplay(timeStr) {
    if (!timeStr || timeStr === 'unknown') return '未知';
    const parts = timeStr.split(/[\t\n\r]+/).filter(t => t.trim());
    if (parts.length <= 6) {
      return parts.join(' ');
    }
    return parts.slice(0, 6).join(' ') + ` ... (+${parts.length - 6}个)`;
  }
});
