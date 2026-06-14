// ==================== 配置 ====================
const API_BASE = '/api/auth';

// ==================== 通用请求 ====================
async function request(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(API_BASE + path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ==================== UI 状态控制 ====================
function updateUIForLoggedIn(email) {
  document.getElementById('globalLoginModal').style.display = 'none';
  document.getElementById('globalLoginBtn').style.display = 'none';
  document.getElementById('globalUserInfo').style.display = 'block';
  document.getElementById('globalDisplayName').textContent = email || '用户';
}

function updateUIForLoggedOut() {
  document.getElementById('globalLoginModal').style.display = 'none';
  document.getElementById('globalLoginBtn').style.display = 'block';
  document.getElementById('globalUserInfo').style.display = 'none';
  document.getElementById('globalDisplayName').textContent = '';
  const err = document.getElementById('ErrorLogin');
  if (err) err.style.display = 'none';
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
  try { await request('/logout', 'POST'); } catch (e) {}
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

// ==================== 弹窗控制（供 HTML onclick 使用） ====================
function login_btn() {
  document.getElementById('globalLoginModal').style.display = 'flex';
  document.getElementById('ErrorLogin').style.display = 'none';
}

function close_login_modal() {
  document.getElementById('globalLoginModal').style.display = 'none';
}

// 登录模态框内的登录按钮事件
function login_btn_model() {
  login();
}

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
window.login_out = logout;   // 兼容已有退出调用 login_out()