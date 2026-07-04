// ─── 个人信息页面逻辑 ────────────────────────────────

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
    document.getElementById('profileDisplayName').textContent = user.name || user.email || '用户';
    document.getElementById('profileEmail').textContent = user.email || '—';
    document.getElementById('profileCity').textContent = user.city || '未设置';
    if (user.registertime) {
      document.getElementById('profileRegDate').textContent = user.registertime;
    }
    // 填入当前值作为 placeholder
    if (user.name) document.getElementById('nameInput').placeholder = user.name;
    if (user.city) document.getElementById('cityInput').placeholder = user.city;
  } catch (e) {
    console.error('加载用户信息失败:', e);
  }
}

async function saveProfile(name, city) {
  const body = {};
  if (name !== undefined && name !== null) body.name = name;
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
      showMessage('❌ ' + (data.error || '该昵称已被使用'), true);
    } else {
      showMessage('❌ ' + (data.error || '保存失败'), true);
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

  // 保存按钮
  document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('nameInput');
    const cityInput = document.getElementById('cityInput');
    const name = nameInput?.value.trim() || null;
    const city = cityInput?.value.trim() || null;

    if (!name && !city) {
      showMessage('请至少填写一项', true);
      return;
    }

    const ok = await saveProfile(name, city);
    if (ok) {
      showMessage('✅ 保存成功', false);
      // 刷新显示
      if (name) {
        document.getElementById('profileDisplayName').textContent = name;
        nameInput.placeholder = name;
        nameInput.value = '';
      }
      if (city) {
        document.getElementById('profileCity').textContent = city;
        cityInput.placeholder = city;
        cityInput.value = '';
      }
    }
  });
});
