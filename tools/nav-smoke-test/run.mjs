// tools/nav-smoke-test/run.mjs
// 无浏览器环境下的导航栏冒烟测试：用最小 DOM 桩执行真实的 src/nav.js，
// 检查「☰ 按钮注入 / 抽屉挂载 / 当前页高亮 / 退出登录请求」是否按预期工作。
//
// 用法：node tools/nav-smoke-test/run.mjs [页面文件 ...]
//       不带参数时扫描仓库根目录下全部 *.html
import { createDOM } from './dom-stub.mjs';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 用真实的 src/nav.js，只把两个绝对路径依赖换成本地桩
const navSrc = readFileSync(path.join(root, 'src/nav.js'), 'utf8')
  .replace("'/lib/ui/message.mjs'", "'./message.mjs'")
  .replace("'/lib/ui/guard.mjs'", "'./guard.mjs'");
const generated = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nav-under-test.mjs');
// src/nav.js 只导出 { nav, isLoggedIn, tidyHeader }，但断言需要读菜单结构来推导期望值，
// 故在生成副本时补一条导出（只改副本，不动 src/nav.js 本体）
writeFileSync(generated, navSrc + '\nexport { NAV_SECTIONS };\n', 'utf8');

/** 期望的 a.nav-item 数量：由导航配置推导 = 各组 items 链接总数 + 抽屉底部「退出登录」1 项 */
function expectedNavItemCount(sections) {
  return sections.reduce((n, section) => n + section.items.length, 0) + 1;
}

// 首次 import 后由 nav 配置算出，之后各页复用（导航结构不随页面变化）
let expectedNavItems = null;

async function checkPage(file) {
  const html = readFileSync(path.join(root, file), 'utf8');
  const { doc } = createDOM(html);

  const events = {};
  globalThis.window = {
    location: { pathname: '/' + file, search: '', href: '', reload() { events.reloaded = true; } },
    addEventListener(t, fn) { (events[t] ||= []).push(fn); },
    dispatchEvent(e) { (events[e.type] || []).forEach((f) => f(e)); },
  };
  globalThis.document = doc;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  globalThis.fetch = async (url) => { events.fetched = url; return { ok: true, json: async () => ({}) }; };

  const nav = await import('./nav-under-test.mjs?t=' + Date.now());
  expectedNavItems ??= expectedNavItemCount(nav.NAV_SECTIONS);
  doc.dispatch('DOMContentLoaded');

  const toggle = doc.getElementById('navToggleBtn');
  const drawer = doc.getElementById('mlttcNavDrawer');
  const overlay = doc.getElementById('mlttcNavOverlay');
  const header = doc.querySelector('hcw-body-header, [hcw-body-header]') || doc.getElementById('headerAuthArea');

  const out = {
    page: file,
    toggleInHeader: !!(toggle && header && toggle.parentNode === header),
    toggleIsFirstChild: !!(header && toggle && header.children[0] === toggle),
    drawerInBody: !!(drawer && drawer.parentNode === doc.body),
    overlayInBody: !!(overlay && overlay.parentNode === doc.body),
    navItems: doc.querySelectorAll('a.nav-item').length,
    icons: doc.querySelectorAll('.nav-item-icon').length,
    hasMyTimetable: !!doc.querySelector('a.nav-item[href="/my-timetable.html"]'),
    emojiLabel: /[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(doc.getElementById('navPageLabel')?.textContent || ''),
    activeItems: doc.querySelectorAll('a.nav-item.is-active').map((a) => a.getAttribute('href')),
    pageLabel: doc.getElementById('navPageLabel')?.textContent,
    leftovers: doc.querySelectorAll('#globalUserInfo, #globalLogoutBtn, #globalDisplayName').length,
  };

  nav.nav.open();
  out.openAddsClass = !!(drawer && drawer.classList.contains('open') && overlay && overlay.classList.contains('open')
    && doc.body.classList.contains('nav-open') && toggle && toggle.getAttribute('aria-expanded') === 'true');
  nav.nav.close();
  out.closeRemovesClass = !!(drawer && !drawer.classList.contains('open') && !doc.body.classList.contains('nav-open')
    && toggle && toggle.getAttribute('aria-expanded') === 'false');

  doc.getElementById('navLogoutBtn')?.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  out.logoutFetched = events.fetched || null;
  return out;
}

const args = process.argv.slice(2);
const files = args.length ? args : readdirSync(root).filter((f) => f.endsWith('.html')).sort();

let failures = 0;
for (const f of files) {
  const r = await checkPage(f);
  // 跳转占位页（timetable-detail-result.html）没有页头，故只校验抽屉挂载
  const needsHeader = r.navItems > 0 && !/timetable-detail-result/.test(f);
  const problems = [];
  if (needsHeader && !r.toggleInHeader) problems.push('☰ 未注入页头');
  if (needsHeader && !r.toggleIsFirstChild) problems.push('☰ 不是页头第一个元素');
  if (!r.drawerInBody || !r.overlayInBody) problems.push('抽屉/遮罩未挂到 body');
  // 导航结构：数量由 nav 配置推导（各组 items 链接数 + 抽屉底部「退出登录」），
  // 加/删一个导航链接会自动跟随；实际值仍按桩 DOM 里数出的 a.nav-item 条目数，少渲染即 FAIL
  if (r.navItems !== expectedNavItems) problems.push('导航项数量=' + r.navItems + '（期望 ' + expectedNavItems + '）');
  if (r.icons !== 0) problems.push('导航仍有 emoji 图标=' + r.icons);
  if (r.emojiLabel) problems.push('抽屉标题含 emoji');
  if (needsHeader && !r.hasMyTimetable) problems.push('缺少「我的时刻表」入口');
  if (needsHeader && (!r.openAddsClass || !r.closeRemovesClass)) problems.push('开合状态类异常');
  if (r.logoutFetched !== '/api/logout-D1') problems.push('退出登录未调用 /api/logout-D1');
  if (r.leftovers) problems.push('页头残留=' + r.leftovers);
  if (problems.length) failures++;
  console.log((problems.length ? 'FAIL ' : 'ok   ') + f.padEnd(30) + '抽屉标题=' + JSON.stringify(r.pageLabel) + (problems.length ? '  → ' + problems.join('; ') : ''));
}
console.log('\n共 ' + files.length + ' 个页面，失败 ' + failures + ' 个');
process.exit(failures ? 1 : 0);
