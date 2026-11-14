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
import './version-check.js';

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

// ========== 自定义主题色（accent color） ==========
// 与深浅主题正交：用户可在个人主页「个人设置」里挑选主色，
// 颜色以 #rrggbb 存 localStorage（mlttc-accent），由本模块全站恢复。
// 恢复方式：向 html 内联写入一组 CSS 变量，覆盖 main.css 中 --primary 家族，
// 从而让按钮 / 链接 / 聚焦环 / 身份徽章等所有引用 --primary 的地方一起变色。

const ACCENT_STORAGE_KEY = 'mlttc-accent';

/**
 * 将 #rrggbb 转为 HSL，用于派生 hover（提亮）与 pressed（压暗）
 * @param {string} hex
 * @returns {{h:number, s:number, l:number}|null}
 */
function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l };
}

/**
 * 由 HSL 生成 #rrggbb
 */
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

/**
 * 应用自定义主题色到 html 内联变量（覆盖 --primary 家族）
 * @param {string|null} hex  #rrggbb；传 null 则清除自定义（回落到 main.css 默认 Spotify 绿）
 */
function applyAccentColor(hex) {
  const html = document.documentElement;
  const clear = () => {
    ['--primary', '--primary-hl', '--primary-dark', '--primary-light',
     '--primary-bg', '--primary-surface', '--link-color', '--shadow-focus']
      .forEach((k) => html.style.removeProperty(k));
  };

  if (!hex) { clear(); return; }

  const hsl = hexToHsl(hex);
  if (!hsl) { clear(); return; }

  const hover = hslToHex(hsl.h, hsl.s, Math.min(1, hsl.l + 0.07));
  const pressed = hslToHex(hsl.h, hsl.s, Math.max(0, hsl.l - 0.08));
  const light = hslToHex(hsl.h, hsl.s, Math.min(1, hsl.l + 0.12));

  const set = (k, v) => html.style.setProperty(k, v);
  set('--primary', hex);
  set('--primary-hl', hover);
  set('--primary-dark', pressed);
  set('--primary-light', light);
  set('--primary-bg', hexToRgba(hex, 0.14));
  set('--primary-surface', hexToRgba(hex, 0.08));
  set('--link-color', hex);
  set('--shadow-focus', hexToRgba(hex, 0.30));
}

/**
 * 生成带 alpha 的 rgba 字符串
 */
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'rgba(29,185,84,' + alpha + ')';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 从 localStorage 恢复自定义主题色（无则不处理）
 */
function initAccentColor() {
  const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
  if (saved) applyAccentColor(saved);
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
    // Spotify 深色优先：无历史记录时默认深色主题
    applyTheme('dark');
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

/**
 * 用服务端状态校正页头（user_name Cookie 只是「显示用的旁路信息」）
 *
 * 为什么需要这一步：user_name 只用于让页头立刻知道「该显示登录还是已登录」，
 * 而它可能缺失或过期（例如用「注册自动登录」「GitHub 登录」进来的老版本没写它，
 * 或它被浏览器清掉/过期了），此时页头会错显「登录」按钮，哪怕会话仍然有效。
 * 这里问一次 /api/profile 拿权威结论，顺带把 user_name 补回一个与会话等长的有效期。
 *
 * 失败（401 / 网络异常 / 限流）时保持现状，不把用户从「已登录」误踢成「未登录」——
 * 唯一的例外是明确的 401：那说明会话真的没了，清掉残留的 user_name 更符合直觉。
 */
async function syncAuthWithServer() {
  const loginBtn = document.getElementById('globalLoginBtn');
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (res.status === 401) {
      // 会话确实失效：清掉显示用的 cookie，避免「显示已登录但操作全 401」
      document.cookie = 'user_name=; Path=/; Max-Age=0; SameSite=Lax';
      if (loginBtn) loginBtn.style.display = 'inline-block';
      return;
    }
    if (!res.ok) return; // 429 / 5xx 等：保持当前显示，不要误踢

    const data = await res.json();
    const user = data.user || data;
    // 补回/刷新显示用 cookie（30 天，与持久 auth_token 对齐；会话型 auth_token 失效后
    // 下一次加载会走到上面的 401 分支把它清掉）
    document.cookie = `user_name=${encodeURIComponent(user.NAME || '')}; Path=/; Max-Age=2592000; SameSite=Lax`;
    if (loginBtn) loginBtn.style.display = 'none';
    window.dispatchEvent(new CustomEvent('mlttc:auth-changed'));
  } catch {
    /* 网络异常：保持现状 */
  }
}

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAccentColor();
  bindThemeToggle();
  updateHeaderAuth();
  // 先用 Cookie 立刻画出正确状态（避免闪烁），再用服务端结论校正
  syncAuthWithServer();
  // 通知导航模块：页头已就绪（nav.js 在此之后精简页头 / 刷新登录态相关 UI）
  window.dispatchEvent(new CustomEvent('mlttc:header-ready'));
});

// 暴露给个人主页（src/pages/account.js）使用：读取 / 写入自定义主题色
// 通过 window 桥接，避免两个独立模块间的循环依赖。
window.MLTTC_ACCENT = {
  get: () => localStorage.getItem(ACCENT_STORAGE_KEY) || null,
  set: (hex) => {
    if (hex) localStorage.setItem(ACCENT_STORAGE_KEY, hex);
    else localStorage.removeItem(ACCENT_STORAGE_KEY);
    applyAccentColor(hex || null);
  },
  clear: () => {
    localStorage.removeItem(ACCENT_STORAGE_KEY);
    applyAccentColor(null);
  },
  KEY: ACCENT_STORAGE_KEY
};