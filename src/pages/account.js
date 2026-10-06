// src/pages/account.js
/**
 * 个人主页（account.html）
 *
 * 职责：
 *   1. 拉取并展示资料：昵称 / 邮箱 / 城市 / 注册时间 + 身份徽章
 *      （身份由 /api/profile 返回的 role · roleLabel 决定，见 resolveRole）
 *   2. 修改昵称与城市（POST /api/update-profile）
 *   3. 提供退出登录入口（GET /api/logout-D1）
 *
 * 注意：「我的时刻表」列表已拆分为独立页面 my-timetable.html / src/pages/my-timetable.js，
 *       本页不再拉取时刻表数据（showConfirm 也随之下移，此处不再引入 popup.mjs）。
 *
 * 依赖：/lib/ui/message.mjs、/lib/ui/guard.mjs
 */
import { showMessage } from '/lib/ui/message.mjs';
import { createGuard } from '/lib/ui/guard.mjs';

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

/**
 * 身份定义：key → 显示名与标识颜色
 * 颜色对应 style/main.css 中的 --role-* 变量，如需调整只改那里即可
 */
const ROLE_INFO = {
  admin: { label: '管理员', color: 'var(--role-admin)' },
  station: { label: '站长', color: 'var(--role-station)' },
  user: { label: '普通用户', color: 'var(--role-user)' }
};

/**
 * 解析用户身份
 * 优先使用后端 /api/profile 返回的 role / roleLabel；
 * 若后端未返回（旧响应），则按 adm 原始值兜底判断（兼容大小写与前后空格）
 * @returns {{key:'admin'|'station'|'user', label:string, color:string}}
 */
function resolveRole(user) {
  if (!user) return { key: 'user', ...ROLE_INFO.user };

  const key = String(user.role ?? '').trim().toLowerCase();
  if (ROLE_INFO[key]) {
    return { key, label: user.roleLabel || ROLE_INFO[key].label, color: ROLE_INFO[key].color };
  }

  // 兜底：后端未返回 role 时按 adm 原始值判断
  // 注意 adm 已 toLowerCase()，所以比对值必须用小写
  const adm = String(user.adm ?? '').trim().toLowerCase();
  let fallbackKey = 'user';
  if (adm === 'adm' || adm === 'admin') fallbackKey = 'admin';
  else if (adm === 'station' || adm === '站长') fallbackKey = 'station';
  return { key: fallbackKey, ...ROLE_INFO[fallbackKey] };
}

async function loadProfile() {
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (res.status === 429) {
      // 被限流：不能当成「未登录」，否则会把已登录用户显示成游客
      showMessage('请求过于频繁，请稍后刷新重试', true);
      return;
    }
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
    // 显示身份（优先用后端返回的 role/roleLabel，缺失时按 adm 兜底）
    const typeEl = document.getElementById('profileAccountType');
    if (typeEl) {
      const role = resolveRole(user);
      typeEl.textContent = role.label;
      typeEl.style.background = role.color;
      typeEl.dataset.role = role.key;
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

  // 登录按钮由 /src/pages/main.js 统一绑定（account.html 已包含 #globalLoginModal 结构）。
  // 原先此处也绑了一份，逻辑重复，故删除。

  // ─── 退出登录 ───────────────────────────────────
  // 退出入口已从页头移入本页「账户」卡片（页头只保留登录按钮）。
  // 抽屉导航底部另有一份全站可用的入口（/src/nav.js）。
  // 原先此处调用 /api/logout（清理用户信息）并跳转 /login.html（该页面不存在 → 404），
  // 与 /src/api/logout-D1 的 cookie 清理链路不一致，故一并删除。
  const logoutMsg = document.getElementById('accountLogoutMsg');
  const logoutGuard = createGuard('正在退出…');
  document.getElementById('accountLogoutBtn')?.addEventListener('click', () => logoutGuard.run(async () => {
    try {
      // 与 src/auth-header.js / src/nav.js 使用同一个退出接口：清 auth_token 与 user_name
      await fetch('/api/logout-D1', { credentials: 'include' });
      showMessage('已退出登录', false);
      if (logoutMsg) {
        logoutMsg.textContent = '已退出登录，即将返回首页…';
        logoutMsg.style.display = 'block';
        logoutMsg.style.color = 'var(--success, #34c759)';
      }
      // 回到首页（个人主页在退出后已无内容可看）
      setTimeout(() => { window.location.href = '/index.html'; }, 1200);
    } catch {
      showMessage('退出失败，请稍后重试', true);
      if (logoutMsg) {
        logoutMsg.textContent = '退出失败，请检查网络后重试';
        logoutMsg.style.display = 'block';
        logoutMsg.style.color = 'var(--danger)';
      }
    }
  }));

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

  // 保存按钮（外包一层防重复提交：连点会发出多个写请求，容易触发服务端限流）
  const saveGuard = createGuard('正在保存，请稍候…');
  document.getElementById('saveBtn')?.addEventListener('click', () => saveGuard.run(async () => {
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
  }));

});
