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
    document.getElementById('profileDisplayName').textContent = user.name || user.email || '用户';
    document.getElementById('profileEmail').textContent = user.email || '—';
    document.getElementById('profileCity').textContent = user.city || '未设置';
    if (user.registertime) {
      document.getElementById('profileRegDate').textContent = user.registertime;
    }
    // 填入当前值作为 placeholder
    if (cookieName || user.name) document.getElementById('nameInput').placeholder = cookieName || user.name;
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

  // 实时验证：昵称（最多6字）
  const nameInput = document.getElementById('nameInput');
  const nameMsg = document.getElementById('nameMsg');
  if (nameInput && nameMsg) {
    nameInput.addEventListener('input', () => {
      const v = nameInput.value;
      if (v.length > 6) {
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

  // 保存按钮
  document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const name = nameInput?.value.trim() || null;
    const city = cityInput?.value.trim() || null;

    // 提交前再次校验
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
      showMessage('✅ 保存成功', false);
      if (name) {
        document.getElementById('profileDisplayName').textContent = name;
        nameInput.placeholder = name;
        nameInput.value = '';
        msgout(nameInput, nameMsg, '', 2);
      }
      if (city) {
        document.getElementById('profileCity').textContent = city;
        cityInput.placeholder = city;
        cityInput.value = '';
        msgout(cityInput, cityMsg, '', 2);
      }
    }
  });
});
