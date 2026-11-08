// src/version-check.js
/**
 * 每次打开页面时检查是否有新版本，由用户决定要不要立刻更新
 *
 * 流程：
 *   1. 页面加载后 fetch GET /api/version，拿到后端「最新版本号」；
 *   2. 与当前代码内置版本（src/version.js 的 APP_VERSION）对比；
 *   3. 若不同，且这个「最新版本号」尚未被标记过 → 优先弹提示框给两个选择；
 *      页面没引 lib/ui/init.mjs 时 <hcw-popup> 永远不会定义，此时降级成顶部 Toast；
 *   4. 弹框里「立即更新」带 cache-bust 参数强刷当前页（不写标记，刷新失败下次还能提示），
 *      「稍后」把该版本号记进 localStorage；Toast 降级不做记录，下次打开还会提示。
 *
 * 说明：
 *   - 由 src/auth-header.js 引入，全站每个页面自动生效。
 *   - 接口失败 / 无后端 / 版本一致时静默，不打扰用户。
 */
import { APP_VERSION } from './version.js';
import { showConfirm } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';

/** localStorage 键：记录「已被用户选择稍后 / 已提示过的新版本号」 */
const SEEN_KEY = 'mlttc-seen-version';

/** <hcw-popup> 由 lib/ui/init.mjs 定义；没引 init.mjs 的页面等不到它，不能无限等 */
const POPUP_WAIT_MS = 1500;

/**
 * 强刷当前页：只改写 _v 参数，原有查询串和 hash 都保留，
 * 避免把用户自己带着的参数丢掉。
 */
function reloadWithCacheBust() {
  const url = new URL(location.href);
  url.searchParams.set('_v', String(Date.now()));
  location.replace(url.href);
}

/**
 * <hcw-popup> 可使用返回 true；等待超时仍未定义（页面没引 init.mjs）返回 false。
 * 必须 race：whenDefined 在这些页面上会永远 pending，弹框和提示就一起消失了。
 */
function popupAvailable() {
  return Promise.race([
    customElements.whenDefined('hcw-popup').then(() => true),
    new Promise((resolve) => {
      setTimeout(() => resolve(Boolean(customElements.get('hcw-popup'))), POPUP_WAIT_MS);
    }),
  ]);
}

/** 写成单句连排：<hcw-popup> 的文本节点不保留换行，多行文案会被折叠成一段 */
function buildText(latest, notes) {
  const parts = [`发现新版本 v${latest}（当前 v${APP_VERSION}）`];
  if (notes) parts.push(`更新内容：${notes}`);
  parts.push('主页更新日志见 changelog.html');
  return `${parts.join('，')}。`;
}

async function checkVersion() {
  let latest;
  let notes = '';
  try {
    const res = await fetch('/api/version', { credentials: 'include' });
    if (!res.ok) return;
    const json = await res.json();
    if (!json || !json.success || !json.version) return;
    latest = String(json.version);
    notes = json.notes ? String(json.notes) : '';
  } catch {
    return; // 无后端 / 网络异常：静默
  }

  // 版本一致 → 无需提示
  if (latest === APP_VERSION) return;

  // 已提示过这个版本 → 不再重复
  let seen = '';
  try { seen = localStorage.getItem(SEEN_KEY) || ''; } catch { /* ignore */ }
  if (seen === latest) return;

  const text = buildText(latest, notes);

  // 没有 <hcw-popup> 就只能退回只读的顶部提示
  if (!(await popupAvailable())) {
    // 不写标记：Toast 没有交互按钮，用户可能压根没看到，写了就等于让这条提示永久消失
    showMessage(text, false, { type: 'info', duration: 6000 });
    return;
  }

  const choice = await showConfirm({
    text,
    buttons: ['立即更新', '稍后'],
    button_style: ['primary', ''],
  });

  // showConfirm 返回的是**倒序**索引：0 =「稍后」，1 =「立即更新」
  if (choice === 1) {
    reloadWithCacheBust();
    return;
  }
  try { localStorage.setItem(SEEN_KEY, latest); } catch { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', checkVersion);
