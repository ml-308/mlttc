// ==================== 配置 ====================
const API_BASE = '/api/auth';   // 后端认证接口前缀，按实际调整

// ==================== 通用请求（自动携带 HttpOnly Cookie） ====================
async function request(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',   // 让浏览器自动发送 Cookie
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(API_BASE + path, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

// ==================== UI 状态更新 ====================
function updateUIForLoggedIn(email) {
  const loginModal = document.getElementById('globalLoginModal');
  const loginBtn = document.getElementById('globalLoginBtn');
  const userInfoDiv = document.getElementById('globalUserInfo');
  const displayName = document.getElementById('globalDisplayName');

  if (loginModal) loginModal.style.display = 'none';
  if (loginBtn) loginBtn.style.display = 'none';
  if (userInfoDiv) userInfoDiv.style.display = 'block';
  if (displayName) displayName.textContent = email || '用户';
}

function updateUIForLoggedOut() {
  const loginModal = document.getElementById('globalLoginModal');
  const loginBtn = document.getElementById('globalLoginBtn');
  const userInfoDiv = document.getElementById('globalUserInfo');
  const displayName = document.getElementById('globalDisplayName');
  const errorEl = document.getElementById('ErrorLogin');

  if (loginModal) loginModal.style.display = 'none';
  if (loginBtn) loginBtn.style.display = 'block';
  if (userInfoDiv) userInfoDiv.style.display = 'none';
  if (displayName) displayName.textContent = '';
  if (errorEl) {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
  }

  // 清空输入框
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  if (usernameInput) usernameInput.value = '';
  if (passwordInput) passwordInput.value = '';
}

function showMessage(msg, isError = false) {
  // 优先显示在错误提示区域
  const box = document.getElementById('ErrorLogin');
  if (box) {
    box.textContent = msg;
    box.style.display = 'block';
    box.style.color = isError ? 'red' : 'green';
  }
  // 同时弹出浮层提示
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style.position = 'fixed';
  popup.style.top = '20px';
  popup.style.left = '50%';
  popup.style.transform = 'translateX(-50%)';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  popup.style.color = '#fff';
  popup.style.padding = '10px 20px';
  popup.style.borderRadius = '5px';
  popup.style.zIndex = '9999';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2000);
}

// ==================== 登录操作 ====================
async function login() {
  const email = document.getElementById('username')?.value.trim();
  const password = document.getElementById('password')?.value;

  if (!email || !password) {
    showMessage('请输入邮箱和密码', true);
    return;
  }

  try {
    // 1. 调用登录接口（后端会设置 HttpOnly Cookie）
    await request('/login', 'POST', { email, password });
    // 2. 获取用户信息以显示邮箱
    const data = await request('/me', 'GET');
    updateUIForLoggedIn(data.user.email);
    showMessage('登录成功');
  } catch (err) {
    showMessage(err.message, true);
  }
}

// ==================== 检查登录状态（页面加载时调用） ====================
async function checkLoginStatus() {
  try {
    const data = await request('/me', 'GET');
    updateUIForLoggedIn(data.user.email);
  } catch (err) {
    updateUIForLoggedOut();
  }
}

// ==================== 初始化 ====================
window.addEventListener('DOMContentLoaded', () => {
  checkLoginStatus();

  // 暴露函数给全局，以便在 HTML 中通过 onclick 调用
  window.login = login;
  window.logout = logout;
});