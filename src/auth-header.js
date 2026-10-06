// src/auth-header.js
/**
 * 页头通用模块（全站每个页面都会引入）
 *
 * 职责：
 *   1. 引入「用户同意」模块（src/consent.js）—— Cookie / 本地存储告知横幅、
 *      登录前提示、注册页勾选记录等，引入后全站自动生效
 *   2. 引入左侧收拉式导航栏（src/nav.js）—— ☰ 按钮 + 抽屉导航，全站统一入口
 *   3. 页头登录态展示：读 user_name Cookie 切换「登录按钮 / 已登录」
 *      （页头不再放「退出」按钮：退出已移入个人主页与抽屉底部；
 *        「欢迎，xxx + 退出」容器由 /src/nav.js 的 tidyHeader() 统一移除，
 *        已登录时的入口在左侧抽屉导航「其它 · 个人主页」）
 *   4. 深浅色主题切换（localStorage: mlttc-theme，属性：html[data-theme]）
 *
 * 依赖：/lib/ui/message.mjs、/src/nav.js
 */
import './consent.js';
import './nav.js';

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
 * 退出登录已从页头移出，现由两处负责（两处都调用 GET /api/logout-D1）：
 *   - 左侧抽屉底部「退出登录」（src/nav.js，全站可用）
 *   - 个人主页 account.html 的账户卡片（src/pages/account.js）
 * 页头此处只负责「登录按钮 / 欢迎xxx」的切换。
 */

// 根据登录状态切换头部 UI：未登录显示「登录」按钮，已登录则隐藏按钮
// （页头右侧只保留登录按钮 / 主题按钮；用户名与个人主页入口在左侧抽屉导航里）
function updateHeaderAuth() {
  const loginBtn = document.getElementById('globalLoginBtn');

  // 确保元素存在（有的页面可能没有这个头部）
  if (!loginBtn) return;

  const { loggedIn } = checkAuth();

  // 未登录：显示「登录」按钮；已登录：隐藏（点击弹窗由 /src/pages/main.js 负责）
  loginBtn.style.display = loggedIn ? 'none' : 'inline-block';
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

// 个人主页的入口在左侧抽屉导航中（见 /src/nav.js 的「其它 · 个人主页」），
// 页头不再有可点击的「欢迎，昵称」文本。

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bindThemeToggle();
  updateHeaderAuth();
  // 通知导航模块：页头已就绪（nav.js 在此之后精简页头 / 刷新登录态相关 UI）
  window.dispatchEvent(new CustomEvent('mlttc:header-ready'));
});