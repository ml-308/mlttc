// js/auth-header.js

// 检查是否已登录（调用受保护接口）
async function checkAuth() {
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      return { loggedIn: true, user: data.user || data }; // 根据你接口实际返回调整
    }
    return { loggedIn: false };
  } catch (error) {
    return { loggedIn: false };
  }
}

// 退出登录
async function logout() {
  await fetch('/api/logout-D1', { credentials: 'include' });
  window.location.href = '/login.html';
}

// 绑定退出按钮事件
function bindLogoutButton() {
  const logoutBtn = document.getElementById('globalLogoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }
}

// 根据登录状态切换头部 UI
async function updateHeaderAuth() {
  const loginBtn = document.getElementById('globalLoginBtn');
  const userInfoDiv = document.getElementById('globalUserInfo');
  const displayName = document.getElementById('globalDisplayName');

  // 确保元素都存在（有的页面可能没有这个头部）
  if (!loginBtn || !userInfoDiv || !displayName) return;

  const { loggedIn, user } = await checkAuth();

  if (loggedIn && user) {
    // 已登录：显示用户信息，隐藏登录按钮
    loginBtn.style.display = 'none';
    userInfoDiv.style.display = 'block';
    displayName.textContent = user.email || user.name || '用户'; // 根据实际字段调整
    bindLogoutButton();
  } else {
    // 未登录：显示登录按钮，隐藏用户信息
    loginBtn.style.display = 'inline-block'; // 或原来 hcw-button 的 display
    userInfoDiv.style.display = 'none';
  }
}

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', updateHeaderAuth);