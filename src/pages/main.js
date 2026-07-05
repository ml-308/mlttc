import { showConfirm, showPrompt } from '/lib/ui/popup.mjs';
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
const timer = document.getElementById('time');
// 倒计时更新函数
function updateCountdown() {
  if (!timer) return;
  const now = new Date();
  const diff = targetDate - now;

  if (diff <= 0) {
    timer.textContent = '🎉 高考已开始！';
    return;
  }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  const display = `${days}天 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  timer.textContent ="距离高考还有："+ display;
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
  if (modal) modal.style.display = 'flex';
  if (loginBtn) loginBtn.style.display = 'none';
  if (logoutBtn) logoutBtn.style.display = 'none';
}

function closeLogin() {
  const modal = document.getElementById('globalLoginModal');
  const loginBtn = document.getElementById('globalLoginBtn');
  const logoutBtn = document.getElementById('globalLogoutBtn');
  if (modal) modal.style.display = 'none';
  if (loginBtn) loginBtn.style.display = 'inline-block';
  if (logoutBtn) logoutBtn.style.display = 'none';
}

// ================== 登录逻辑 ==================

function login(e) {
  e.preventDefault();
  const email = document.getElementById('username')?.value.trim();
  const password = document.getElementById('password')?.value;
  if (!email || !password) {
    showMessage('请输入账号和密码', true);
    return;
  }
  loginread(email, password);
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
  // 先关闭模态框，无论 fetchUserInfo 是否成功
  const modal = document.getElementById('globalLoginModal');
  const closeBtn = document.getElementById('closeModalBtn');
  if (modal) modal.style.display = 'none';
  if (closeBtn) closeBtn.style.display = 'none';

  const user = await fetchUserInfo();
  if (user) {
    const loginBtn = document.getElementById('globalLoginBtn');
    const logoutBtn = document.getElementById('globalLogoutBtn');
    const userInfoDiv = document.getElementById('globalUserInfo');
    const displayName = document.getElementById('globalDisplayName');

    const loggedName = user.NAME || '未设置昵称';
    if (displayName) displayName.textContent = loggedName;
    document.cookie = `user_name=${encodeURIComponent(user.NAME || '')}; Path=/; Max-Age=3600; SameSite=Lax`;
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-block';
    if (userInfoDiv) userInfoDiv.style.display = 'block';
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
  showMessage('已退出登录', false);
  setTimeout(() => window.location.reload(), 1500);
}



//BUG反馈
const bugback=document.getElementById("BUG");

bugback.addEventListener("click",bugbackf);

async function bugbackf(){
  const inputvalue=await showPrompt({
    text:"请输入BUG反馈内容",
    buttons:['确定','取消'],
    button_style:['primary','secondary'],
    input_is_area:true,
    input_placeholder:"请输入BUG反馈内容",
    input_value:""
  })
  if(inputvalue){
    try {
      const res = await fetch('/api/bugback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bugback: inputvalue })
      });
      const data = await res.json();
      if (res.ok) {
        showMessage(data.message || '反馈已提交，感谢您的支持', false);
      } else {
        showMessage(data.error || '提交失败', true);
      }
    } catch {
      showMessage('网络错误，请稍后重试', true);
    }
  }
}