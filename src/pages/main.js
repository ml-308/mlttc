// src/pages/main.js
/**
 * 全站通用交互脚本
 *
 * 加载它的页面：index.html / game.html / legal.html / timetable.html /
 *               timetable-result.html / timetable-detail(.result).html / account.html / my-timetable.html
 *               （register.html 不加载）
 *
 * 注意：分隔符用英文字符，不要用中文顿号 —— 曾经用过，被外部工具转换成了乱码。
 *
 * 职责：
 *   1. 页头登录弹窗（打开 / 关闭 / 提交登录 → POST /api/login-D1）
 *   2. 首页「距离高考还有…」倒计时
 *   3. 首页 BUG 反馈入口（POST /api/bugback，仅当页面存在 #BUG 元素）
 *
 * 注意：退出登录不在页头 —— 由 /src/nav.js（抽屉底部）与 /src/pages/account.js（个人主页）负责，
 *       此处不再重复绑定。登录成功后派发 mlttc:auth-changed 通知导航模块刷新。
 */
import { showPrompt } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';
import { createGuard } from '/lib/ui/guard.mjs';
// 与 /src/auth-header.js 共用同一模块实例，条款版本号只在这里维护一份
import { CONSENT_VERSION } from '/src/consent.js';
import { TURNSTILE_SITE_KEY } from '/src/config.js';

/** 登录防重复提交：连点会发出多个登录请求，容易撞上服务端的登录限流 */
const loginGuard = createGuard('正在登录，请稍候…');

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
  // 登录框内的同意区由本文件运行时注入（21 个页面的登录框 HTML 一律不改）
  mountLoginConsent();
  // 退出按钮由 /src/auth-header.js 统一绑定，此处不再重复绑定
});
    
console.log("V1.2.5");

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

// 关闭登录弹窗后恢复页头按钮（页头已无「退出」按钮，退出见 /src/nav.js 与个人主页）
function loginshow() {
  const modal = document.getElementById('globalLoginModal');
  const loginBtn = document.getElementById('globalLoginBtn');
  if (modal) modal.style.display = 'flex';
  if (loginBtn) loginBtn.style.display = 'none';
  // 打开时补齐同意区（幂等），site key 非空时顺手挂载人机验证组件
  mountLoginConsent();
  void ensureTurnstileWidget();
}

function closeLogin() {
  const modal = document.getElementById('globalLoginModal');
  const loginBtn = document.getElementById('globalLoginBtn');
  if (modal) modal.style.display = 'none';
  if (loginBtn) loginBtn.style.display = 'inline-block';
}

// ============ 登录框增强：政策同意 / cookie 同意 / 人机验证 ============
// 21 个页面共用同一份 #globalLoginModal 的 HTML，所以这里全部运行时注入，不改任何 HTML 文件。

/** 登录框「已同意用户协议与隐私政策」记录（版本号 + 时间） */
const LOGIN_CONSENT_KEY = 'mlttc-login-consent';
/** 登录框「同意使用 cookie 保持登录」的上次选择 */
const LOGIN_REMEMBER_KEY = 'mlttc-login-remember';
/** 政策版本号，与 /src/consent.js 的 CONSENT_VERSION 同源；条款更新时旧记录自动失效 */
const LOGIN_POLICY_VERSION = CONSENT_VERSION;
/** Turnstile 显式渲染模式脚本地址 */
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Turnstile 运行态：脚本加载 Promise / 组件实例 id / 最近一次拿到的 token / 等待 token 的回调 */
let turnstileScriptPromise = null;
let turnstileWidgetId = null;
let turnstileToken = '';
let turnstileWaiters = [];

/**
 * 读取登录框的政策同意记录
 * @returns {{version:string,time:string}|null} null 表示从未同意或读不到（隐私模式）
 */
function getLoginConsent() {
  try {
    const raw = localStorage.getItem(LOGIN_CONSENT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** 是否已同意「当前版本」的政策（版本号变则视为未同意，需要重新勾选） */
function hasLoginConsent() {
  const record = getLoginConsent();
  return !!record && record.version === LOGIN_POLICY_VERSION;
}

/** 登录成功后写入同意记录（版本号 + 时间） */
function saveLoginConsent() {
  const record = { version: LOGIN_POLICY_VERSION, time: new Date().toISOString() };
  try {
    localStorage.setItem(LOGIN_CONSENT_KEY, JSON.stringify(record));
  } catch {
    // 写不进去（隐私模式）也不阻断登录，下次照旧手动勾选
  }
  return record;
}

/** 读取「同意使用 cookie 保持登录」的上次选择，默认勾选 */
function getRememberPref() {
  try {
    return localStorage.getItem(LOGIN_REMEMBER_KEY) !== '0';
  } catch {
    return true;
  }
}

/** 记住「同意使用 cookie 保持登录」的选择 */
function saveRememberPref(remember) {
  try {
    localStorage.setItem(LOGIN_REMEMBER_KEY, remember ? '1' : '0');
  } catch {
    // 忽略
  }
}

/** 动态加载 Turnstile 脚本（只加载一次）；失败或超时进入 reject，由调用方降级提示 */
function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    // 15 秒还没加载出来就降级，避免用户点了登录一直卡着没反应
    const timer = setTimeout(() => reject(new Error('turnstile-script-timeout')), 15000);
    script.onload = () => { clearTimeout(timer); resolve(window.turnstile); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('turnstile-script-error')); };
    document.head.appendChild(script);
  }).catch((err) => {
    turnstileScriptPromise = null; // 允许下次重试
    throw err;
  });
  return turnstileScriptPromise;
}

/** 把 widget 渲染进指定容器（同一页面只渲染一次） */
async function renderTurnstile(container) {
  if (turnstileWidgetId !== null) return turnstileWidgetId;
  const turnstile = await loadTurnstileScript();
  if (!turnstile || typeof turnstile.render !== 'function') throw new Error('turnstile-unavailable');
  turnstileWidgetId = turnstile.render(container, {
    sitekey: TURNSTILE_SITE_KEY,
    // 验证通过 → 记下 token；过期或出错 → 清空，等待用户重新验证
    callback: (token) => { turnstileToken = token; flushTurnstileWaiters(token); },
    'expired-callback': () => { turnstileToken = ''; },
    'error-callback': () => { turnstileToken = ''; flushTurnstileWaiters(''); }
  });
  return turnstileWidgetId;
}

/** 唤醒所有等待 token 的回调 */
function flushTurnstileWaiters(token) {
  const waiters = turnstileWaiters;
  turnstileWaiters = [];
  waiters.forEach((fn) => fn(token));
}

/** 等 widget 回调产出 token，超时返回空串 */
function waitForTurnstileToken(timeout) {
  return new Promise((resolve) => {
    const waiter = (token) => {
      clearTimeout(timer);
      resolve(typeof token === 'string' ? token : '');
    };
    const timer = setTimeout(() => {
      turnstileWaiters = turnstileWaiters.filter((fn) => fn !== waiter);
      resolve('');
    }, timeout);
    turnstileWaiters.push(waiter);
  });
}

/**
 * 确保 Turnstile 已就绪
 * site key 留空时直接返回 true 且什么都不做（不加载脚本、不渲染、不留空白框）
 */
async function ensureTurnstileWidget() {
  if (!TURNSTILE_SITE_KEY) return true;
  if (turnstileWidgetId !== null) return true;
  const container = document.getElementById('loginTurnstile');
  if (!container) return false;
  try {
    await renderTurnstile(container);
    return turnstileWidgetId !== null;
  } catch {
    // 加载失败要明确告诉用户，不能静默卡住
    showMessage('人机验证加载失败，请检查网络后重试', true);
    return false;
  }
}

/** 取当前有效 token；没有就等回调，最多 8 秒 */
async function getTurnstileToken() {
  if (!TURNSTILE_SITE_KEY) return '';
  if (turnstileToken) return turnstileToken;
  if (window.turnstile && turnstileWidgetId !== null) {
    try {
      const token = window.turnstile.getResponse(turnstileWidgetId);
      if (token) {
        turnstileToken = token;
        return token;
      }
    } catch {
      // 拿不到就走等待回调
    }
  }
  return waitForTurnstileToken(8000);
}

/** 重置 widget：token 是一次性的，登录失败后不 reset 就会一直失败 */
function resetTurnstile() {
  turnstileToken = '';
  turnstileWaiters = [];
  if (window.turnstile && turnstileWidgetId !== null) {
    try {
      window.turnstile.reset(turnstileWidgetId);
    } catch {
      // 忽略
    }
  }
}

/**
 * 移除 consent.js 注入的被动同意文案（「继续登录即表示你已同意…」）。
 * 它与本文件的主动勾选语义冲突，由 .auth-extras 的主人单向清理；
 * 没有任何 .auth-extras 的页面不会被调用，因此 consent.js 的兜底行为不受影响。
 * 幂等：没有该节点时什么都不做。
 */
function removePassiveLoginNotice(modal) {
  modal.querySelectorAll('.consent-login-notice').forEach((el) => el.remove());
}

/**
 * 向 #globalLoginModal 注入同意区（政策勾选 + cookie 同意 + Turnstile 容器）
 * 幂等：已注入过就只同步勾选状态，不会叠加第二块。
 * @returns {HTMLElement|null} 注入的容器
 */
function mountLoginConsent() {
  const modal = document.getElementById('globalLoginModal');
  if (!modal) return null;
  const body = modal.querySelector('[hcw-modal-body]') || modal;

  let wrap = body.querySelector('.auth-extras');
  if (wrap) {
    // 已经注入过：只按本地记录同步勾选状态，绝不叠加第二块；
    // 用户本次已经手动点过的勾选不覆盖（否则会把手动勾掉）
    if (!wrap.dataset.touched) {
      const policyBox = wrap.querySelector('#loginPolicyConsent');
      const rememberBox = wrap.querySelector('#loginRememberCookie');
      if (policyBox) policyBox.checked = hasLoginConsent();
      if (rememberBox) rememberBox.checked = getRememberPref();
    }
    // consent.js 比本文件晚执行时会补插被动文案，这里再清一次（同样幂等）
    removePassiveLoginNotice(modal);
    return wrap;
  }

  wrap = document.createElement('div');
  wrap.className = 'auth-extras';
  wrap.innerHTML = `
    <div class="auth-consent">
      <label class="auth-check">
        <input type="checkbox" id="loginPolicyConsent">
        <span>我已阅读并同意
          <a href="/legal.html" target="_blank" rel="noopener">《用户协议》</a>与
          <a href="/legal.html" target="_blank" rel="noopener">《隐私政策》</a>
        </span>
      </label>
      <label class="auth-check">
        <input type="checkbox" id="loginRememberCookie">
        <span>同意使用 cookie 保持登录状态（不勾选则关闭浏览器后需重新登录）</span>
      </label>
    </div>
    <div class="auth-turnstile" id="loginTurnstile"></div>
    <div class="auth-divider"><span>或</span></div>
    <hcw-button class="auth-github-btn" flat>使用 GitHub 登录 / 注册</hcw-button>
  `;
  // 放在「登录」按钮正上方；找不到按钮就追加到弹窗内容末尾
  const modalLoginBtn = document.getElementById('login-btn');
  if (modalLoginBtn && modalLoginBtn.parentNode === body) {
    body.insertBefore(wrap, modalLoginBtn);
  } else {
    body.appendChild(wrap);
  }

  // 主动勾选区已就位：移除同一模态框内的被动同意文案，避免两套说法并存
  removePassiveLoginNotice(modal);

  const policyBox = wrap.querySelector('#loginPolicyConsent');
  const rememberBox = wrap.querySelector('#loginRememberCookie');
  const consentBox = wrap.querySelector('.auth-consent');

  // 勾过且登录成功过的用户：自动预勾选，不再强制拦截
  policyBox.checked = hasLoginConsent();
  rememberBox.checked = getRememberPref();

  policyBox.addEventListener('change', () => {
    wrap.dataset.touched = '1';
    if (policyBox.checked) consentBox.classList.remove('invalid');
  });
  rememberBox.addEventListener('change', () => {
    wrap.dataset.touched = '1';
    saveRememberPref(rememberBox.checked);
  });

  // GitHub 登录 / 注册：与账号密码登录共用同一道「政策同意」门禁，
  // 并把「保持登录」的选择写进跳转参数 —— 后端会把它签进 state，
  // 回调据此决定下发持久 Cookie 还是会话 Cookie，避免绕开 cookie 同意。
  const githubBtn = wrap.querySelector('.auth-github-btn');
  if (githubBtn) {
    githubBtn.addEventListener('click', () => {
      wrap.dataset.touched = '1';
      if (policyBox && !policyBox.checked) {
        showMessage('请先阅读并勾选同意《用户协议》与《隐私政策》', true);
        if (consentBox) consentBox.classList.add('invalid');
        policyBox.focus();
        return;
      }
      if (consentBox) consentBox.classList.remove('invalid');
      const remember = rememberBox ? rememberBox.checked : true;
      saveRememberPref(remember);
      // from=home：授权完成后回首页（登录与注册共用同一条回调，账号不存在会自动建号）
      window.location.href = `/api/auth-github?from=home&remember=${remember ? '1' : '0'}`;
    });
  }

  return wrap;
}

// ================== 登录逻辑 ==================

async function login(e) {
  e.preventDefault();
  const email = document.getElementById('username')?.value.trim();
  const password = document.getElementById('password')?.value;
  if (!email || !password) {
    showMessage('请输入账号和密码', true);
    return;
  }

  // ① 政策同意：从没同意过的用户必须自己勾选；勾过并登录成功过的自动预勾选，不再拦截
  mountLoginConsent();
  const consentBox = document.querySelector('#globalLoginModal .auth-consent');
  const policyBox = document.getElementById('loginPolicyConsent');
  if (policyBox && !policyBox.checked) {
    showMessage('请先阅读并勾选同意《用户协议》与《隐私政策》', true);
    if (consentBox) consentBox.classList.add('invalid');
    policyBox.focus();
    return;
  }
  if (consentBox) consentBox.classList.remove('invalid');

  // ② cookie 同意：勾 = 持久登录，不勾 = 关浏览器即登出（后端据此下发不同有效期的 cookie）
  const rememberBox = document.getElementById('loginRememberCookie');
  const rememberCookie = rememberBox ? rememberBox.checked : true;
  saveRememberPref(rememberCookie);

  // ③ 人机验证：site key 留空时整段跳过（不加载脚本、不渲染、不传 turnstileToken）
  let token = '';
  if (TURNSTILE_SITE_KEY) {
    if (!(await ensureTurnstileWidget())) return; // 加载失败已在 ensure 里提示
    token = await getTurnstileToken();
    if (!token) {
      showMessage('人机验证未通过，请稍后重试', true);
      resetTurnstile();
      return;
    }
  }

  loginGuard.run(() => loginread(email, password, { rememberCookie, turnstileToken: token }));
}

async function loginread(email, password, opts = {}) {
  try {
    // 请求体：rememberCookie 一定带上；turnstileToken 只在启用并拿到 token 时带上
    const body = { email, password, rememberCookie: opts.rememberCookie !== false };
    if (opts.turnstileToken) body.turnstileToken = opts.turnstileToken;

    const res = await fetch('/api/login-D1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      // 失败（含人机验证未通过）：token 已被服务端消费，必须 reset 才能再验证
      resetTurnstile();
      showMessage(data.message || '登录失败', true);
      return;
    }
    // 登录成功：写入同意记录（版本号 + 时间），下次打开登录框自动预勾选
    saveLoginConsent();
    resetTurnstile();
    showMessage('登录成功', false);
    // 登录成功，获取用户信息并更新界面
    await updateUIAfterLogin();
  } catch (err) {
    resetTurnstile();
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

    document.cookie = `user_name=${encodeURIComponent(user.NAME || '')}; Path=/; Max-Age=3600; SameSite=Lax`;
    // 登录成功：隐藏页头「登录」按钮；个人主页入口在左侧抽屉导航中
    if (loginBtn) loginBtn.style.display = 'none';
    // 抽屉底部「退出登录」的显示状态随登录态变化
    window.dispatchEvent(new CustomEvent('mlttc:auth-changed'));
  }
}

async function fetchUserInfo() {
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (res.status === 429) {
      // 被限流时不要误判成「未登录」，否则页头会突然变回登录按钮
      showMessage('请求过于频繁，请稍后刷新重试', true);
      return null;
    }
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
    eyebrow:"反馈",
    title:"BUG 反馈",
    text:"描述你遇到的问题，越具体越容易复现。",
    buttons:['提交','取消'],
    button_style:['primary','tp'],
    input_is_area:true,
    input_attrs:{placeholder:"例如：在时刻表查询页点「立即使用」后没有任何反应"}
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