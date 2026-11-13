// src/version-check.js
/**
 * 每次打开页面时检查是否有新版本，由用户决定要不要立刻更新
 *
 * 流程：
 *   1. 页面加载后带时间戳去拉 lib/data/changelog.json，读它的 latestVersion 作为「部署版本」；
 *   2. 与当前代码内置版本（src/version.js 的 APP_VERSION）对比；
 *   3. 若部署版本**比当前运行版本更新**，且这个版本号尚未被标记过 → 优先弹提示框给两个选择；
 *      页面没引 lib/ui/init.mjs 时 <hcw-popup> 永远不会定义，此时降级成顶部 Toast；
 *   4. 弹框里「立即更新」带 cache-bust 参数强刷当前页（不写标记，刷新失败下次还能提示），
 *      「稍后」把该版本号记进 localStorage；Toast 降级不做记录，下次打开还会提示。
 *
 * 说明：
 *   - 由 src/auth-header.js 引入，全站每个页面自动生效。
 *   - 只认「部署版本更新」：相等 / 更旧 / 无法解析一律静默，
 *     否则刚升级完的用户会被提示「更新」到一个更旧的版本。
 *   - 数据源是本仓库里跟着 JS 一起部署的静态快照，不再走 KV 支撑的版本接口：
 *     外部存储靠人工同步，一旦停在旧值，就会和真正跑着的代码各说各话，
 *     结果新版本永远推不出去（两端都静默）。
 *   - 弹窗由 lib/ui/popup.mjs 的 showDialog 渲染：eyebrow + 标题 + 版本对比块，
 *     与全站其它对话框共用同一套「标题 / 描述 / 操作」版式。
 */
import { APP_VERSION } from './version.js';
import { popupReady, showDialog } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';

/** localStorage 键：记录「已被用户选择稍后 / 已提示过的新版本号」 */
const SEEN_KEY = 'mlttc-seen-version';

const DATA_URL = '/lib/data/changelog.json';

/** 同一时刻只跑一次检查：DOMContentLoaded 与 pageshow 会前后脚触发，不能弹两个框 */
let checking = false;

/**
 * 把 '1.2.9' / 'v1.2' / '1.2.9-beta' 之类的版本号解析成数字三元组。
 * 取不到任何数字段时返回 null，交给调用方判定「不可比较」。
 */
function parseVersion(value) {
  const nums = String(value ?? '').match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  return [0, 1, 2].map((i) => Number(nums[i] || 0));
}

/**
 * 比较版本号：a 比 b 新返回正数、相同返回 0、更旧返回负数。
 * 任一侧无法解析时返回 0（当作「不比当前新」），
 * 这样部署标记里写脏值只会静默，不会把用户往旧版本上引导。
 */
function compareVersion(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/**
 * 「立即更新」前必须拉新的关键资源。
 * 只给页面 URL 加 _v 是不够的：浏览器里那几份 JS/CSS 是按**旧缓存策略**存下来的，
 * 页面重载时仍会直接命中缓存，用户看到的是「点了更新、弹窗又弹一次」。
 * 下面这些用 cache:'reload' 请求（绕过缓存并回写缓存），再用页面 URL 的 _v 重载，
 * 整条链路才会真的换成新版本。
 */
const ASSETS_TO_REFRESH = [
  '/src/version.js',
  '/src/version-check.js',
  '/src/auth-header.js',
  '/src/nav.js',
  '/lib/ui/init.mjs',
  '/lib/ui/popup.mjs',
  '/lib/ui/templates.html',
  '/style/main.css',
  '/style/index.css',
];

/**
 * 把上面这些资源用 cache:'reload' 各拉一次。
 * 同时把当前页面自己引的样式与脚本也带上（时刻表页的 timetable.css、各页 pages/*.js 等），
 * 否则只有主站首页能得到完整的新资源。
 * 失败无所谓（某个文件 404 不该把「更新」卡死），所以逐个 catch 掉。
 */
function collectPageAssets() {
  const urls = new Set(ASSETS_TO_REFRESH);
  document.querySelectorAll('link[rel="stylesheet"][href]').forEach((el) => {
    urls.add(new URL(el.getAttribute('href'), location.href).pathname);
  });
  document.querySelectorAll('script[src]').forEach((el) => {
    const abs = new URL(el.getAttribute('src'), location.href);
    if (abs.origin === location.origin) urls.add(abs.pathname);
  });
  return [...urls];
}

async function refreshCachedAssets() {
  await Promise.all(
    collectPageAssets().map((url) => fetch(url, { cache: 'reload' }).catch(() => null))
  );
}

/**
 * 强刷当前页：先拉新关键资源，再改写 _v 参数重载。
 * 只改写 _v，原有查询串和 hash 都保留，避免把用户自己带着的参数丢掉。
 */
async function reloadWithCacheBust() {
  await refreshCachedAssets();
  const url = new URL(location.href);
  url.searchParams.set('_v', String(Date.now()));
  location.replace(url.href);
}

/** 写成单句连排：Toast 只有一行，多行文案会被挤断 */
function buildText(latest) {
  return '发现新版本 v' + latest + '（当前 v' + APP_VERSION + '），主页更新日志见 changelog.html。';
}

/**
 * 版本对比块的样式。样式节点跟着内容一起 append 进弹窗 shadow，
 * 所以只作用于这一个弹窗；类名统一带 vc- 前缀，避免和别处渗透进来的选择器撞车。
 * 颜色全部取设计令牌，深浅两套主题自动跟随。
 */
const VERSION_DIFF_STYLE = [
  '.vc-diff { display: flex; flex-direction: column; gap: .75rem; }',
  '.vc-track { display: flex; align-items: center; gap: .625rem; padding: .75rem .875rem;' +
  ' border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--input-bg); }',
  '.vc-chip { display: flex; flex: 1 1 0; flex-direction: column; gap: .1875rem; min-width: 0; }',
  '.vc-chip-label { font-size: .6875rem; font-weight: 700; letter-spacing: .08em;' +
  ' text-transform: uppercase; color: var(--text-secondary); }',
  '.vc-chip-value { font-family: var(--font-mono); font-size: .9375rem; font-weight: 700;' +
  ' color: var(--text-primary); overflow-wrap: anywhere; }',
  '.vc-chip-new .vc-chip-value { color: var(--link-color); }',
  '.vc-arrow { flex: none; color: var(--text-secondary); font-size: 1rem; line-height: 1; }',
  '.vc-log { align-self: flex-start; font-size: .8125rem; font-weight: 600; color: var(--link-color);' +
  ' text-decoration: none; border-radius: var(--radius-xs); }',
  '.vc-log:hover { text-decoration: underline; }',
  '.vc-log:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }',
].join('\n');

/** 一个版本号胶囊：小标题（当前 / 最新）+ 版本号本身 */
function versionChip(value, kind, labelText) {
  const chip = document.createElement('span');
  chip.className = 'vc-chip vc-chip-' + kind;

  const label = document.createElement('span');
  label.className = 'vc-chip-label';
  label.textContent = labelText;

  const version = document.createElement('span');
  version.className = 'vc-chip-value';
  version.textContent = 'v' + value;

  chip.append(label, version);
  return chip;
}

/**
 * 版本对比块：当前 vX → 最新 vY，外加一个更新日志入口。
 * 全部用 textContent 拼，版本号即使来自远端数据也不会被当成 HTML 解析。
 */
function buildVersionDiff(current, latest) {
  const root = document.createElement('div');
  root.className = 'vc-diff';

  const style = document.createElement('style');
  style.textContent = VERSION_DIFF_STYLE;

  const track = document.createElement('div');
  track.className = 'vc-track';

  const arrow = document.createElement('span');
  arrow.className = 'vc-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';

  track.append(versionChip(current, 'old', '当前'), arrow, versionChip(latest, 'new', '最新'));

  const log = document.createElement('a');
  log.className = 'vc-log';
  log.href = '/changelog.html';
  log.target = '_blank';
  log.rel = 'noopener';
  log.textContent = '查看更新日志';

  root.append(style, track, log);
  return root;
}

/**
 * 拉部署版本号。带 ?_= 且 cache: 'no-store' 是必需的：
 * CDN 和手机浏览器都会把这份 JSON 缓存住，缓存住的旧值等于没检查。
 *
 * 主源是静态标记（纯静态、不依赖 Functions）；取不到再退回 /api/version——
 * 那个接口是给「缓存着旧版 JS 的客户端」准备的兼容入口，两边必须都能答上来。
 */
async function fetchLatestVersion() {
  try {
    const res = await fetch(DATA_URL + '?_=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      if (json && json.latestVersion) return String(json.latestVersion);
    }
    console.warn('[version-check] 静态标记不可用，改走 /api/version');
  } catch {
    console.warn('[version-check] 静态标记读取异常，改走 /api/version');
  }

  try {
    const res = await fetch('/api/version?_=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      if (json && json.success && json.version) return String(json.version);
    }
    console.warn('[version-check] /api/version 也不可用');
  } catch (err) {
    console.warn('[version-check] /api/version 请求异常', err);
  }
  return '';
}

async function checkVersion() {
  if (checking) return;
  checking = true;
  try {
    let latest = '';
    try {
      latest = await fetchLatestVersion();
    } catch (err) {
      console.warn('[version-check] 读取部署版本出错，跳过本次检查', err);
      return;
    }
    if (!latest) return;

    // 只在部署版本更新时提示：相等静默；部署版本更旧（回滚、快照没跟上）也必须静默
    if (compareVersion(latest, APP_VERSION) <= 0) return;

    // 已提示过这个版本 → 不再重复
    let seen = '';
    try { seen = localStorage.getItem(SEEN_KEY) || ''; } catch { /* 隐私模式下 localStorage 会抛，当作没标记过 */ }
    if (seen === latest) return;

    // 没有 <hcw-popup> 就只能退回只读的顶部提示
    if (!(await popupReady())) {
      // 不写标记：Toast 没有交互按钮，用户可能压根没看到，写了就等于让这条提示永久消失
      showMessage(buildText(latest), false, { type: 'info', duration: 6000 });
      return;
    }

    const choice = await showDialog({
      eyebrow: '更新可用',
      title: '发现新版本 v' + latest,
      text: '更新会重新加载本页，正在填写的内容不会保留；也可以先看看这次改了什么。',
      content: buildVersionDiff(APP_VERSION, latest),
      buttons: ['立即更新', '稍后'],
      button_style: ['primary', 'tp'],
    });

    // showDialog 返回的是**倒序**索引：1 =「立即更新」，0 =「稍后」或直接关掉弹窗
    if (choice === 1) {
      // 刷新期间保持一个「正在更新」的提示，避免用户以为没反应而重复点击
      showMessage('正在更新到 v' + latest + '…', false, { type: 'info', duration: 6000 });
      await reloadWithCacheBust();
      return;
    }
    try { localStorage.setItem(SEEN_KEY, latest); } catch { /* ignore */ }
  } finally {
    checking = false;
  }
}

document.addEventListener('DOMContentLoaded', checkVersion);

// iOS 从 bfcache 还原页面时不重新执行脚本，DOMContentLoaded 也不会再触发，
// 只有 pageshow 会带着 persisted=true 到达，否则「从后台切回来」永远等不到检查。
window.addEventListener('pageshow', (e) => {
  if (e.persisted) checkVersion();
});

// 长时间开着的标签页也要能发现新部署：切回前台查一次，另外每 5 分钟轮询一次
// （请求只是一个几 KB 的 JSON，且 checkVersion 自带 in-flight 锁与已读去重）。
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkVersion();
});

setInterval(() => {
  if (document.visibilityState === 'visible') checkVersion();
}, RECHECK_INTERVAL_MS);
