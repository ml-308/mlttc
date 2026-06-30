// 等待 DOM 完全加载，确保所有元素存在
document.addEventListener('DOMContentLoaded', () => {
  // 获取元素，如果不存在则跳过（避免报错）
  const globalLoginBtn = document.getElementById('globalLoginBtn');
  const globalLogoutBtn = document.getElementById('globalLogoutBtn');
  const loginModalBtn = document.getElementById('login-btn');      // 弹窗中的“登录”按钮
  const closeBtn = document.getElementById('closeModalBtn');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const globalLoginModal = document.getElementById('globalLoginModal');
  const userInfoDiv = document.getElementById('globalUserInfo');
  const displayName = document.getElementById('globalDisplayName');

  // 安全绑定事件（仅当元素存在时）
  if (globalLoginBtn) {
    globalLoginBtn.addEventListener('click', loginshow);
  }
  if (loginModalBtn) {
    loginModalBtn.addEventListener('click', login);
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', closeLogin);
  }
  if (globalLogoutBtn) {
    globalLogoutBtn.addEventListener('click', logout);
  }
});

// 目标时间：2028年6月7日 00:00:00（月份从0开始，5代表6月）
const targetDate = new Date(2028, 5, 7, 8, 0, 0);
const timer=document.getElementById('time');
// 倒计时更新函数
function updateCountdown() {
  const now = new Date();
  const diff = targetDate - now; // 毫秒差

  if (diff <= 0) {
    // 倒计时结束，显示提示并停止定时器（可选）
    timer.textContent = '🎉 高考已开始！';
    return;
  }

  // 计算天、时、分、秒
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  // 格式化输出（补零）
  const display = `${days}天 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  timer.textContent ="距离高考还有："+ display;
  console.log(display);
}

// 立即执行一次，避免首屏空白
updateCountdown();
// 每秒更新
setInterval(updateCountdown, 1000);

// ================== 工具函数 ==================

function showMessage(msg, isError) {
  const box = document.getElementById('errormsg');
  if (box) {
    box.textContent = msg;
    box.style.display = 'block';
    box.style.color = isError ? 'red' : 'green';
  }
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style = 'position:fixed; top:20px; left:50%; padding:10px 20px; border-radius:5px; z-index:9999; color:#fff; font-size:0.85rem; animation: fadeInOut 2s ease forwards;';
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

function validateEmail(value) {
  const email = value.trim();
  if (!email) return '邮箱不能为空';
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!regex.test(email)) return '邮箱格式不正确';
  return '邮箱格式正确';
}

// ================== 界面控制 ==================

function loginshow() {
  const modal = document.getElementById('globalLoginModal');
  const loginBtn = document.getElementById('globalLoginBtn');
  const logoutBtn = document.getElementById('globalLogoutBtn');
  const closeBtn = document.getElementById('close_login_btn');
  if (modal) modal.style.display = 'flex';
  if (loginBtn) loginBtn.style.display = 'none';
  if (logoutBtn) logoutBtn.style.display = 'none';
  if (closeBtn) closeBtn.style.display = 'flex';
}

function closeLogin() {
  const modal = document.getElementById('globalLoginModal');
  const loginBtn = document.getElementById('globalLoginBtn');
  const logoutBtn = document.getElementById('globalLogoutBtn');
  const closeBtn = document.getElementById('close_login_btn');
  if (modal) modal.style.display = 'none';
  if (loginBtn) loginBtn.style.display = 'flex';
  if (logoutBtn) logoutBtn.style.display = 'none';
  if (closeBtn) closeBtn.style.display = 'none';
}

// ================== 登录逻辑 ==================

function login(e) {
  e.preventDefault();
  const email = document.getElementById('username')?.value.trim();
  const password = document.getElementById('password')?.value;
  if (!email || !password) {
    showMessage('请输入邮箱和密码', true);
    return;
  }
  const msg = validateEmail(email);
  if (msg === '邮箱格式正确') {
    loginread(email, password);
  } else {
    showMessage(msg, true);
  }
}

async function loginread(email, password) {
  try {
    const res = await fetch('/api/login-D1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showMessage(data.message || '登录失败', true);
      return;
    }
    showMessage('登录成功', false);
    // 登录成功，获取用户信息并更新界面
    await updateUIAfterLogin();
  } catch (err) {
    showMessage('网络错误', true);
  }
}

async function updateUIAfterLogin() {
  const user = await fetchUserInfo();
  if (user) {
    const loginBtn = document.getElementById('globalLoginBtn');
    const logoutBtn = document.getElementById('globalLogoutBtn');
    const userInfoDiv = document.getElementById('globalUserInfo');
    const displayName = document.getElementById('globalDisplayName');
    const modal = document.getElementById('globalLoginModal');
    const closeBtn = document.getElementById('close_login_btn');

    if (displayName) displayName.textContent = user.email || '用户';
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'block';
    if (userInfoDiv) userInfoDiv.style.display = 'block';
    if (modal) modal.style.display = 'none';
    if (closeBtn) closeBtn.style.display = 'none';
  }
}

async function fetchUserInfo() {
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      return data.user || data;  // 适配不同返回格式
    }
    return null;
  } catch {
    return null;
  }
}

// ================== 退出登录 ==================

async function logout() {
  await fetch('/api/logout-D1', { credentials: 'include' });
  window.location.reload();
  showMessage('已退出登录', true);
}

