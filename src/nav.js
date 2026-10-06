// src/nav.js
/**
 * 全站左侧收拉式导航栏（抽屉式）
 *
 * 职责：
 *   1. 在页头左侧注入「☰ 菜单」按钮（页头即 hcw-body-header；game.html 退回到 #headerAuthArea）
 *   2. 注入左侧抽屉导航 + 遮罩层，收录全站入口（时刻表 / 个人主页 / 游戏与工具 / 工具 / 法律条款）
 *   3. 页头改造：去掉页头里的「退出」按钮（退出统一放进个人主页与抽屉底部），
 *      并把「MLTTC - xxx」精简为「MLTTC」（页面标题保留在 <title>）
 *   4. 当前页高亮、Esc 关闭、移动端隐藏页头副标题、抽屉内滚动锁定
 *
 * 加载方式：由 /src/auth-header.js 统一 import（全站每个页面都会引入该模块），
 *           因此各页面无需自己添加 <script>。
 *
 * 依赖：/lib/ui/message.mjs（退出登录提示）
 */
import { showMessage } from '/lib/ui/message.mjs';
import { createGuard } from '/lib/ui/guard.mjs';

/** 导航菜单结构 —— 只列实际存在的页面，保证不出现 404 入口 */
const NAV_SECTIONS = [
  {
    title: '首页',
    items: [
      { label: '首页', href: '/index.html' }
    ]
  },
  {
    title: '时刻表',
    items: [
      { label: '时刻表查询', href: '/timetable.html' },
      { label: '我的时刻表', href: '/my-timetable.html' }
    ]
  },
  {
    title: '其它',
    items: [
      { label: '个人主页', href: '/account.html' },
      { label: '用户协议与隐私', href: '/legal.html' }
    ]
  }
];

/** 读取 cookie（与 auth-header.js 保持同一实现） */
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

/** 当前是否已登录（仅看 user_name cookie，不查数据库） */
function isLoggedIn() {
  return getCookie('user_name') !== null;
}

/** 当前页面路径（末段形式，例如 /index.html；站点根路径视作首页） */
function currentPath() {
  const p = window.location.pathname.replace(/\\/g, '/');
  const seg = p.split('/').filter(Boolean).pop();
  return seg ? '/' + seg : '/index.html';
}

/** 页面标题里「- MLTTC」之类的站点后缀（用于抽屉里的当前页面名） */
const TITLE_SEP = /\s*[-–—|｜·/]\s*/;
/** 导航栏不放 emoji：页面标题里若带了 emoji，显示时去掉 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/**
 * 当前页面在抽屉里显示的名字：
 *   优先取 <title> 去掉站点后缀后的部分；
 *   index.html 的 <title> 就是 MLTTC 时退回当前路径文件名；
 *   个别页面的 <title> 带了 emoji（如 game.html），导航栏不放 emoji，这里一并去掉。
 */
function pageLabel() {
  const raw = (document.title || '').replace(/\s+/g, ' ').trim();
  const head = raw.split(TITLE_SEP)[0].replace(EMOJI_RE, '').trim();
  if (!head || head === 'MLTTC' || head === 'Document') return labelForPath(currentPath());
  return head;
}

/** 标题不可用时，用导航表里的名字称呼当前页（如 /index.html → 首页） */
function labelForPath(path) {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (pathOf(item.href) === path) return item.label;
    }
  }
  return path;
}

/** 从子路径中取末段，用于判断子项是否命中当前页 */
function pathOf(href) {
  const clean = String(href).split('#')[0];
  const seg = clean.split('/').filter(Boolean).pop();
  return seg ? '/' + seg : '';
}

/** 一条导航链接的 HTML */
function itemHTML(item) {
  const sub = item.sub ? ' nav-item--sub' : '';
  return `<a class="nav-item${sub}" href="${item.href}" data-path="${pathOf(item.href)}">
        <span class="nav-item-label">${item.label}</span>
      </a>`;
}

/** 抽屉整体 HTML */
function drawerHTML() {
  const sections = NAV_SECTIONS.map((section) => `<div class="nav-section">
        <div class="nav-section-title">${section.title}</div>
        ${section.items.map(itemHTML).join('\n        ')}
      </div>`).join('\n      ');

  return `<div class="nav-drawer" id="mlttcNavDrawer" role="dialog" aria-modal="true" aria-label="全站导航">
      <div class="nav-drawer-head">
        <div class="logo-area">
          <div class="logo-text">MLTTC</div>
          <div class="nav-drawer-sub" id="navPageLabel"></div>
        </div>
        <button type="button" class="nav-close" id="navCloseBtn" aria-label="收起导航">&times;</button>
      </div>
      <nav class="nav-body">
      ${sections}
      </nav>
      <div class="nav-drawer-foot">
        <a class="nav-item nav-item--logout" href="javascript:void(0)" id="navLogoutBtn" hidden>
          <span class="nav-item-label">退出登录</span>
        </a>
      </div>
    </div>`;
}

/** 注入 ☰ 按钮、遮罩与抽屉 */
function injectNav() {
  if (document.getElementById('mlttcNavDrawer')) return;

  // 1) 页头左侧的 ☰ 按钮（放在页头第一个 child，紧贴左内边距）
  //    game.html 没有 hcw-body-header，退回把按钮放进它的顶部登录条（#headerAuthArea）
  const header = document.querySelector('hcw-body-header, [hcw-body-header]')
    || document.getElementById('headerAuthArea');
  if (header && !document.getElementById('navToggleBtn')) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'navToggleBtn';
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-label', '展开导航菜单');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'mlttcNavDrawer');
    toggle.innerHTML = '<span class="nav-toggle-bars" aria-hidden="true"><span></span><span></span><span></span></span>';
    header.insertBefore(toggle, header.firstChild);
  }

  // 2) 抽屉 + 遮罩（挂在 body 末尾，避免受各页面布局影响）
  const overlay = document.createElement('div');
  overlay.className = 'nav-overlay';
  overlay.id = 'mlttcNavOverlay';

  const wrap = document.createElement('div');
  wrap.innerHTML = drawerHTML();

  document.body.appendChild(overlay);
  document.body.appendChild(wrap.firstElementChild);

  bindNavEvents();
}

/** 抽屉开合 */
const nav = {
  open() {
    const drawer = document.getElementById('mlttcNavDrawer');
    const overlay = document.getElementById('mlttcNavOverlay');
    const toggle = document.getElementById('navToggleBtn');
    if (!drawer) return;
    drawer.classList.add('open');
    overlay?.classList.add('open');
    toggle?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('nav-open');
  },
  close() {
    const drawer = document.getElementById('mlttcNavDrawer');
    const overlay = document.getElementById('mlttcNavOverlay');
    const toggle = document.getElementById('navToggleBtn');
    if (!drawer) return;
    drawer.classList.remove('open');
    overlay?.classList.remove('open');
    toggle?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-open');
  },
  toggle() {
    const drawer = document.getElementById('mlttcNavDrawer');
    if (drawer?.classList.contains('open')) nav.close();
    else nav.open();
  }
};

/** 事件绑定 */
function bindNavEvents() {
  document.getElementById('navToggleBtn')?.addEventListener('click', nav.toggle);
  document.getElementById('navCloseBtn')?.addEventListener('click', nav.close);
  document.getElementById('mlttcNavOverlay')?.addEventListener('click', nav.close);

  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') nav.close();
  });

  // 抽屉内链接：点击后收起（普通跳转由浏览器完成）
  document.getElementById('mlttcNavDrawer')?.querySelectorAll('a.nav-item').forEach((a) => {
    a.addEventListener('click', () => {
      if (a.id !== 'navLogoutBtn') nav.close();
    });
  });

  // 退出登录（防重复提交）
  const logoutGuard = createGuard('正在退出…');
  document.getElementById('navLogoutBtn')?.addEventListener('click', () => {
    logoutGuard.run(async () => {
      try {
        await fetch('/api/logout-D1', { credentials: 'include' });
        showMessage('已退出登录', false);
        setTimeout(() => window.location.reload(), 1200);
      } catch {
        showMessage('退出失败，请稍后重试', true);
      }
    });
  });
}

/** 高亮当前页 */
function markActive() {
  const here = currentPath();
  document.querySelectorAll('#mlttcNavDrawer a.nav-item[data-path]').forEach((a) => {
    if (a.dataset.path === here) a.classList.add('is-active');
  });
}

/** 抽屉底部的「退出登录」仅登录后显示 */
function syncAuth() {
  const logoutItem = document.getElementById('navLogoutBtn');
  if (logoutItem) logoutItem.hidden = !isLoggedIn();
}

/**
 * 页头精简：
 *   1. 移除「欢迎，昵称 + 退出」容器（#globalUserInfo / #globalLogoutBtn）——
 *      页头右侧只留「主题切换 + 登录」；退出改到个人主页与抽屉底部
 *   2. 「MLTTC - xxx」精简为「MLTTC」（页面标题保留在 <title> 与抽屉里）
 */
function tidyHeader() {
  // #globalUserInfo / #globalLogoutBtn 用 document 级查询：个别页面（game.html）
  // 的登录条不在 hcw-body-header 里
  document.querySelectorAll('#globalUserInfo, #globalLogoutBtn').forEach((el) => el.remove());

  const header = document.querySelector('hcw-body-header, [hcw-body-header]');
  const logo = header?.querySelector('.logo-text');
  if (logo) logo.textContent = 'MLTTC';
}

/** 抽屉标题下显示当前页面名（页头副标题精简后，页面名在抽屉里仍可见） */
function showPageLabel() {
  const label = document.getElementById('navPageLabel');
  if (label) label.textContent = pageLabel();
}

function init() {
  injectNav();
  markActive();
  syncAuth();
  showPageLabel();
}

document.addEventListener('DOMContentLoaded', init);

// 登录成功后（/src/pages/main.js 派发）同步抽屉底部「退出登录」的显示状态
window.addEventListener('mlttc:auth-changed', () => {
  syncAuth();
  tidyHeader();
});

// 页头精简需在其他模块绑定完页头元素之后执行，故由 /src/auth-header.js 在最后触发
window.addEventListener('mlttc:header-ready', tidyHeader);

export { nav, isLoggedIn, tidyHeader };
