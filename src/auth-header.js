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

/** 当前生效的自定义主色（切主题时用它重算文字型主题色）；无自定义时为 null */
let activeAccent = null;

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
  const ACCENT_KEYS = [
    '--primary', '--primary-hl', '--primary-dark', '--primary-light',
    '--primary-bg', '--primary-surface', '--primary-ink', '--on-primary',
    '--on-primary-hl', '--link-color', '--shadow-focus',
  ];
  const clear = () => {
    ACCENT_KEYS.forEach((k) => html.style.removeProperty(k));
    activeAccent = null;
  };

  if (!hex) { clear(); return; }

  const hsl = hexToHsl(hex);
  if (!hsl) { clear(); return; }

  const hover = hslToHex(hsl.h, hsl.s, Math.min(1, hsl.l + 0.07));
  const pressed = hslToHex(hsl.h, hsl.s, Math.max(0, hsl.l - 0.08));
  const light = hslToHex(hsl.h, hsl.s, Math.min(1, hsl.l + 0.12));

  // 文字型主题色 / 主色底上的文字都按当前深浅主题现算：换主题时要重新跑一遍
  const theme = getEffectiveTheme();
  const ink = accentInk(hex, theme);

  const set = (k, v) => html.style.setProperty(k, v);
  set('--primary', hex);
  set('--primary-hl', hover);
  set('--primary-dark', pressed);
  set('--primary-light', light);
  set('--primary-bg', hexToRgba(hex, 0.14));
  set('--primary-surface', hexToRgba(hex, 0.08));
  set('--primary-ink', ink);
  // 主色底上的文字：颜色偏亮配黑字、偏暗配白字，别让深色主色配黑字看不见
  set('--on-primary', onAccentColor(hex));
  set('--on-primary-hl', onAccentColor(hover));
  set('--link-color', ink);
  set('--shadow-focus', hexToRgba(hex, 0.30));
  activeAccent = hex;
}

/**
 * sRGB 通道 → 线性光（WCAG 2.x 相对亮度用）
 * @param {number} channel 0–255
 */
function linearChannel(channel) {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * 相对亮度（0–1）
 * @param {string} hex #rrggbb
 */
function relativeLuminance(hex) {
  const c = parseHexColor(hex);
  if (!c) return 0;
  return 0.2126 * linearChannel(c.r) + 0.7152 * linearChannel(c.g) + 0.0722 * linearChannel(c.b);
}

/**
 * 两色对比度（1–21）
 * @param {string} a #rrggbb
 * @param {string} b #rrggbb
 */
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 解析 #rrggbb
 * @param {string} hex
 * @returns {{r:number,g:number,b:number}|null}
 */
function parseHexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 「文字型主题色」要对比的背景：浅色主题是卡片白，深色主题是卡片深灰 */
const INK_BACKGROUND = { light: '#ffffff', dark: '#151515' };

/**
 * 由主色派生「文字型主题色」（--primary-ink / --link-color）：
 * 保持色相不变，往背景的反方向挪明度，直到对比度 ≥ 4.5:1。
 * 这样浅黄、深蓝这类极端主色也不会出现读不清的绿字/黄字。
 *
 * @param {string} hex 主色
 * @param {'light'|'dark'} theme 当前主题
 * @returns {string} 可安全用作文字的 #rrggbb
 */
function accentInk(hex, theme) {
  const hsl = hexToHsl(hex);
  if (!hsl) return hex;
  const bg = INK_BACKGROUND[theme] || INK_BACKGROUND.light;
  const step = theme === 'dark' ? 0.02 : -0.02;

  let l = hsl.l;
  for (let i = 0; i < 50; i += 1) {
    const candidate = hslToHex(hsl.h, hsl.s, Math.min(1, Math.max(0, l)));
    if (contrastRatio(candidate, bg) >= 4.5) return candidate;
    l += step;
    if (l <= 0 || l >= 1) break;
  }
  return hslToHex(hsl.h, hsl.s, theme === 'dark' ? 1 : 0);
}

/**
 * 主色底上该用黑字还是白字：取对比度更高的一方
 * @param {string} hex 主色
 * @returns {string} '#000000' 或 '#ffffff'
 */
function onAccentColor(hex) {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff';
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
  // 文字型主题色是按背景明暗算的，换主题必须重算一遍
  if (activeAccent) applyAccentColor(activeAccent);
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

// ─── 校验时间窗（省掉「每次页面加载都打一次 /api/profile」）────────
// /api/profile 会打一次 D1；而页头需要的结论（显示登录按钮还是隐藏）几乎不会
// 在 5 分钟内反复变化，所以用 sessionStorage 记下上次校验时间：
//   · user_name Cookie 存在、且距上次校验不足 5 分钟 → 直接信任现有显示，不再请求
//   · 其余情况（没有 cookie / 超过 5 分钟 / 读存储抛错）→ 照常校验，成功或 401 后记录时间
// 语义不变：401 仍清 cookie 并显示登录按钮；200 仍隐藏按钮并刷新 user_name；
// 429 / 5xx / 网络异常仍然保持现状、不更新时间戳（下一次加载会重新校验）。
const AUTH_CHECKED_KEY = 'mlttc-auth-checked';
const AUTH_CHECK_TTL_MS = 5 * 60 * 1000; // 5 分钟

/** 读上次校验时间戳；读不到 / 解析失败 / sessionStorage 不可用时返回 0（= 需要校验） */
function readAuthCheckedAt() {
  try {
    const ts = Number(sessionStorage.getItem(AUTH_CHECKED_KEY));
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0; // 隐私模式等场景 sessionStorage 会抛错 → 退回每次都校验
  }
}

/** 记录「刚刚校验过」；存不进去也不影响正确性，只是下次会再校验一次 */
function markAuthCheckedNow() {
  try {
    sessionStorage.setItem(AUTH_CHECKED_KEY, String(Date.now()));
  } catch {
    /* 存不了就算了 */
  }
}

/** 作废时间戳：登录成功 / 退出登录后必须调用，否则会被旧的「已校验」窗口误判 */
function clearAuthChecked() {
  try {
    sessionStorage.removeItem(AUTH_CHECKED_KEY);
  } catch {
    /* 同上 */
  }
}

// 全站的登录成功（/src/pages/main.js）与退出登录都通过 mlttc:auth-changed 广播，
// 这里挂上作废，保证身份刚变化时下一次加载一定重新校验。
// 注意：本模块在校验成功后自己也会派发该事件，所以 markAuthCheckedNow() 必须
// 写在派发之后（见下面 syncAuthWithServer），否则会被这里刚清掉。
window.addEventListener('mlttc:auth-changed', clearAuthChecked);

async function syncAuthWithServer() {
  const loginBtn = document.getElementById('globalLoginBtn');

  // 时间窗短路：cookie 有显示名 + 5 分钟内校验过 → 信任现有显示，不再打接口
  if (getCookie('user_name') !== null && Date.now() - readAuthCheckedAt() < AUTH_CHECK_TTL_MS) {
    return;
  }

  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (res.status === 401) {
      // 会话确实失效：清掉显示用的 cookie，避免「显示已登录但操作全 401」
      document.cookie = 'user_name=; Path=/; Max-Age=0; SameSite=Lax';
      if (loginBtn) loginBtn.style.display = 'inline-block';
      markAuthCheckedNow();
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
    // 记录本次校验时间：必须放在上面派发之后——本模块自己也监听 auth-changed 清时间戳，
    // 顺序反了会把自己刚记录的时间立刻清掉，5 分钟窗口就失效了
    markAuthCheckedNow();
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