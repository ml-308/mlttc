// src/version-check.js
/**
 * 每次打开页面时检查是否有新版本
 *
 * 流程：
 *   1. 页面加载后 fetch GET /api/version，拿到后端「最新版本号」；
 *   2. 与当前代码内置版本（src/version.js 的 APP_VERSION）对比；
 *   3. 若不同，且这个「最新版本号」尚未提示过（localStorage 记录），
 *      顶部弹一条信息提示「发现新版本 vX.Y.Z」；
 *   4. 记录该版本号，避免每次打开都重复提示。
 *
 * 说明：
 *   - 由 src/auth-header.js 引入，全站每个页面自动生效。
 *   - 接口失败 / 无后端 / 版本一致时静默，不打扰用户。
 */
import { APP_VERSION } from './version.js';
import { showMessage } from '/lib/ui/message.mjs';

/** localStorage 键：记录「已提示过的新版本号」 */
const SEEN_KEY = 'mlttc-seen-version';

async function checkVersion() {
  let latest;
  try {
    const res = await fetch('/api/version', { credentials: 'include' });
    if (!res.ok) return;
    const json = await res.json();
    if (!json || !json.success || !json.version) return;
    latest = String(json.version);
  } catch {
    return; // 无后端 / 网络异常：静默
  }

  // 版本一致 → 无需提示
  if (latest === APP_VERSION) return;

  // 已提示过这个版本 → 不再重复
  let seen = '';
  try { seen = localStorage.getItem(SEEN_KEY) || ''; } catch { /* ignore */ }
  if (seen === latest) return;

  // 提示新版本
  const notes = json && json.notes ? `：${json.notes}` : '';
  showMessage(`发现新版本 v${latest}${notes}`, false, { type: 'info', duration: 5000 });

  // 记录已提示
  try { localStorage.setItem(SEEN_KEY, latest); } catch { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', checkVersion);
