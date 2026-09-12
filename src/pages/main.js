// src/pages/main.js
/**
 * 全站通用交互脚本
 *
 * 加载它的页面：index.htmlã€乬ame.htmlã€乴egal.htmlã€亀imetable.htmlã€亂
 *               timetable-result.htmlã€乼imetable-detail(.result).htmlã€乤ccount.html
 *               （register.html 不加载）
 *
 * 职责：
 *   1. 页头登录弹窗（打开 / 关闭 / 提交登录 → POST /api/login-D1）
 *   2. 首页「距离高考还有…」倒计时
 *   3. 首页 BUG 反馈入口（POST /api/bugback，仅当页面存在 #BUG 元素）
 *
 * 注意：退出登录由 /src/auth-header.js 统一负责，此处不再重复绑定。
 */
import { showPrompt } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';

// 等待 DOM 完全加载，确保所有元素存在
document.addEventListener('DOMContentLoaded', () => {
  // 获取元素，如果不存在则跳过（避免报错）
  const globalLoginBtn = document.getElementById('globalLoginBtn');
  const loginModalBtn = document.getElementById('login-btn');      // 弹窗中的“登录”按钮
  const closeBtn = document.getElementById('closeModalBtn');

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
  // 退出按钮由 /src/auth-header.js 统一绑定，此处不再重复绑定
});
    
console.log("V1.2.4");

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

// 退出登录由 /src/auth-header.js 统一负责（页头模块），此处不再重复实现



// BUG 反馈（只有首页有 #BUG 元素，其它页面需跳过，否则会抛异常中断模块）
const bugback = document.getElementById("BUG");
if (bugback) bugback.addEventListener("click", bugbackf);

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