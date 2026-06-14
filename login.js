// ==================== 配置 ====================
const API_BASE = '/api/auth';

// ==================== 通用请求（修复：安全解析 JSON） ====================
async function request(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(API_BASE + path, options);

  let data;
  try {
    data = await res.json();   // 尝试解析 JSON
  } catch (e) {
    // 如果响应体为空或不是 JSON（如 405 HTML 页面），抛出明确错误
    throw new Error(`服务器返回了无效的响应 (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

// ==================== UI 状态控制 ====================
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
  const err = document.getElementById('ErrorLogin');

  if (loginModal) loginModal.style.display = 'none';
  if (loginBtn) loginBtn.style.display = 'block';
  if (userInfoDiv) userInfoDiv.style.display = 'none';
  if (displayName) displayName.textContent = '';
  if (err) {
    err.style.display = 'none';
    err.textContent = '';
  }
  ['username', 'password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function showMessage(msg, isError = false) {
  const box = document.getElementById('ErrorLogin');
  if (box) {
    box.textContent = msg;
    box.style.display = 'block';
    box.style.color = isError ? 'red' : 'green';
  }
  // 浮层提示
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); padding:10px 20px; border-radius:5px; z-index:9999; color:#fff;';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2000);
}

// ==================== 核心功能 ====================
async function login() {
  const email = document.getElementById('username')?.value.trim();
  const password = document.getElementById('password')?.value;
  if (!email || !password) {
    showMessage('请输入邮箱和密码', true);
    return;
  }
  try {
    await request('/login', 'POST', { email, password });
    const data = await request('/me', 'GET');
    updateUIForLoggedIn(data.user.email);
    showMessage('登录成功');
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function logout() {
  try {
    await request('/logout', 'POST');
  } catch (e) {
    // 即使后端出错（如未实现 /logout），也强制清理前端状态
  }
  updateUIForLoggedOut();
  showMessage('已退出登录');
}

async function checkLoginStatus() {
  try {
    const data = await request('/me', 'GET');
    updateUIForLoggedIn(data.user.email);
  } catch (err) {
    updateUIForLoggedOut();
  }
}

// ==================== 弹窗控制 ====================
function login_btn() {
  const modal = document.getElementById('globalLoginModal');
  const errorEl = document.getElementById('ErrorLogin');
  if (modal) modal.style.display = 'flex';
  if (errorEl) errorEl.style.display = 'none';
}

function close_login_modal() {
  const modal = document.getElementById('globalLoginModal');
  if (modal) modal.style.display = 'none';
}

function login_btn_model() {
  login();
}

// ==================== 兼容旧 HTML 中残留的函数调用 ====================
// 如果 HTML 中仍有 onchange="username_in()" 等，可保留空函数避免报错
function username_in() {}
function password_in() {}
function login_btn2() { login(); }   // 如果旧按钮用 login_btn2，也指向 login

// ==================== 页面加载初始化 ====================
window.addEventListener('DOMContentLoaded', () => {
  checkLoginStatus();
});

// 暴露全局函数
window.login = login;
window.logout = logout;
window.login_btn = login_btn;
window.close_login_modal = close_login_modal;
window.login_btn_model = login_btn_model;
window.login_out = logout;
window.username_in = username_in;
window.password_in = password_in;
window.login_btn2 = login_btn2;