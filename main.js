// ==================== 配置 ====================
const API_BASE = '/api/auth';   // 后端接口前缀，同域可保持默认

// ==================== 通用请求（自动携带 Cookie） ====================
async function request(path, method = 'GET') {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',   // 携带 HttpOnly Cookie
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ==================== 弹窗提示 ====================
function showPopup(message, duration = 2000, isError = false) {
  const popup = document.createElement('div');
  popup.style.position = 'fixed';
  popup.style.top = '20px';
  popup.style.left = '50%';
  popup.style.transform = 'translateX(-50%)';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  popup.style.color = 'white';
  popup.style.padding = '10px 20px';
  popup.style.borderRadius = '5px';
  popup.style.zIndex = '1000';
  popup.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
  popup.textContent = message;
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), duration);
}

// ==================== UI 状态更新 ====================
function updateUIForLoggedIn(userInfo) {
  document.getElementById('globalLoginModal')?.style?.display && (document.getElementById('globalLoginModal').style.display = 'none');
  const loginBtn = document.getElementById('globalLoginBtn');
  const userInfoDiv = document.getElementById('globalUserInfo');
  const displayName = document.getElementById('globalDisplayName');
  if (loginBtn) loginBtn.style.display = 'none';
  if (userInfoDiv) userInfoDiv.style.display = 'block';
  if (displayName) displayName.textContent = userInfo.email || userInfo.username || '用户';
}

function updateUIForLoggedOut() {
  const userInfoDiv = document.getElementById('globalUserInfo');
  const displayName = document.getElementById('globalDisplayName');
  const loginBtn = document.getElementById('globalLoginBtn');
  const loginModal = document.getElementById('globalLoginModal');
  if (userInfoDiv) userInfoDiv.style.display = 'none';
  if (displayName) displayName.textContent = '';
  if (loginBtn) loginBtn.style.display = 'block';
  if (loginModal) loginModal.style.display = 'none';
  // 清除可能残留的表单
  ['username', 'password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const errorEl = document.getElementById('ErrorLogin');
  if (errorEl) errorEl.style.display = 'none';
}

// ==================== 登录状态检测（页面加载时调用） ====================
windows.download=async function checkLoginStatus() {
  try {
    const data = await request('/me', 'GET');
    updateUIForLoggedIn(data.user);
  } catch (err) {
    updateUIForLoggedOut();
  }
}

// ==================== 退出登录 ====================
async function login_out() {
  try {
    await request('/logout', 'POST');
  } catch (e) {
    // 即使后端返回错误也清理前端状态
  }
  updateUIForLoggedOut();
  showPopup('退出成功', 2000);
}

// ==================== 登录弹窗控制（仅 UI，不包含登录逻辑） ====================
function login_btn() {
  const modal = document.getElementById('globalLoginModal');
  if (modal) modal.style.display = 'flex';
}

function close_login_modal() {
  const modal = document.getElementById('globalLoginModal');
  if (modal) modal.style.display = 'none';
}

// 登录按钮的点击事件由登录页面自行绑定，此处不实现 API 调用

// ==================== 页面跳转 ====================
function back() {
  window.location.href = 'index.html';
}

function timetable() {
  window.location.href = 'timetable.html';
}

function register_btn() {
  window.location.href = 'register.html';
}

// ==================== 初始化 ====================
window.addEventListener('DOMContentLoaded', () => {
  checkLoginStatus();
  // 可将全局函数暴露到 window 以便 HTML onclick 调用（可选）
  window.login_out = login_out;
  window.login_btn = login_btn;
  window.close_login_modal = close_login_modal;
  window.register_btn = register_btn;
  window.back = back;
  window.timetable = timetable;
});