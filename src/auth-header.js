// src/auth-header.js
/**
 * 页头通用模块（全站每个页面都会引入）
 *
 * 职责：
 *   1. 引入「用户同意」模块（src/consent.js）—— Cookie / 本地存储告知横幅、
 *      登录前提示、注册页勾选记录等，引入后全站自动生效
 *   2. 页头登录态展示：读 user_name Cookie 切换「登录按钮 / 欢迎xxx + 退出」
 *   3. 退出登录（唯一实现，见下方 logout）
 *   4. 深浅色主题切换（localStorage: mlttc-theme，属性：html[data-theme]）
 *   5. 点击昵称跳转个人主页
 *
 * 依赖：/lib/ui/message.mjs
 */
import './consent.js';
import { showMessage } from '/lib/ui/message.mjs';

// 从 cookie 中读取指定名称的值
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

// 检查登录状态（仅读取 cookie，不查询数据库）
function checkAuth() {
  const name = getCookie('user_name');
  if (name !== null) {
    return { loggedIn: true, displayName: name || '未设置昵称' };
  }
  return { loggedIn: false };
}

/**
 * 退出登录：清除服务端会话后刷新当前页（停留在原页面）
 * 注意：本站没有独立的登录页（登录用页头弹窗），所以退出后是原地刷新，
 *       而不是跳转到不存在的 /login.html（那会 404）
 */
async function logout() {
  await fetch('/api/logout-D1', { credentials: 'include' });
  showMessage('已退出登录', false);
  setTimeout(() => window.location.reload(), 1500);
}

// 绑定退出按钮事件
function bindLogoutButton() {
  const logoutBtn = document.getElementById('globalLogoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }
}

// 根据登录状态切换头部 UI
function updateHeaderAuth() {
  const loginBtn = document.getElementById('globalLoginBtn');
  const userInfoDiv = document.getElementById('globalUserInfo');
  const displayName = document.getElementById('globalDisplayName');

  // 确保元素都存在（有的页面可能没有这个头部）
  if (!loginBtn || !userInfoDiv || !displayName) return;

  const { loggedIn, displayName: name } = checkAuth();

  if (loggedIn) {
    // 已登录：显示用户信息，隐藏登录按钮
    loginBtn.style.display = 'none';
    userInfoDiv.style.display = 'block';
    displayName.textContent = name;
    bindLogoutButton();
  } else {
    // 未登录：显示登录按钮，隐藏用户信息
    loginBtn.style.display = 'inline-block'; // 或原来 hcw-button 的 display
    userInfoDiv.style.display = 'none';
  }
}

// ========== 深色/浅色主题切换 ==========

/**
 * 获取当前有效的主题
 * 优先使用 data-theme 属性，否则检测系统偏好
 */
function getEffectiveTheme() {
  const html = document.documentElement;
  const attr = html.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  // 未设置属性时，跟随系统
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 应用主题
 * @param {'dark'|'light'} theme
 */
function applyTheme(theme) {
  const html = document.documentElement;
  html.setAttribute('data-theme', theme);
  localStorage.setItem('mlttc-theme', theme);
  updateToggleButtonIcon(theme);
}

/**
 * 更新切换按钮图标
 */
function updateToggleButtonIcon(theme) {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  btn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
}

/**
 * 初始化主题（从 localStorage 恢复，或跟随系统）
 */
function initTheme() {
  const saved = localStorage.getItem('mlttc-theme');
  if (saved === 'dark' || saved === 'light') {
    applyTheme(saved);
  } else {
    // 跟随系统
    const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(sys);
  }
}

/**
 * 绑定主题切换按钮
 */
function bindThemeToggle() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const current = getEffectiveTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    // 添加旋转动画
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 400);
  });
}

// 监听系统主题变化（仅在用户未手动设置时跟随）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('mlttc-theme')) {
    applyTheme(e.matches ? 'dark' : 'light');
  }
});

/**
 * 绑定用户名点击跳转到个人主页
 */
function bindUsernameClick() {
  const displayName = document.getElementById('globalDisplayName');
  if (displayName) {
    displayName.style.cursor = 'pointer';
    displayName.addEventListener('click', () => {
      window.location.href = '/account.html';
    });
  }
}

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bindThemeToggle();
  bindUsernameClick();
  updateHeaderAuth();
});