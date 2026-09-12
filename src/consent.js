/**
 * src/consent.js
 * 用户同意模块：Cookie / 本地存储告知横幅、登录前同意提示、同意记录读写
 *
 * 由 /src/auth-header.js 引入，站点所有页面自动生效。
 * 同意记录保存在浏览器 localStorage（键名 mlttc_consent），不向服务器发送。
 */

/** 条款版本。条款内容更新时递增，旧版本记录将被视为未同意，会重新征询。 */
export const CONSENT_VERSION = '1.0';

/** 条款页面地址（锚点：#terms 用户协议 / #privacy 隐私政策 / #cookies Cookie 与本地存储） */
export const LEGAL_URL = '/legal.html';

const CONSENT_KEY = 'mlttc_consent';

/* ==================== 同意记录 ==================== */

/**
 * 读取本地同意记录
 * @returns {{version:string,time:string,policy:string}|null}
 */
export function getConsent() {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    // 隐私模式或数据被篡改时视为未同意
    return null;
  }
}

/** 是否已同意「当前版本」的条款 */
export function hasConsented() {
  const record = getConsent();
  return !!record && record.version === CONSENT_VERSION;
}

/**
 * 记录同意（含条款版本与时间）
 * @param {object} [extra] 附加信息，例如 { source: 'register' }
 */
export function setConsent(extra = {}) {
  const record = {
    version: CONSENT_VERSION,
    time: new Date().toISOString(),
    policy: LEGAL_URL,
    ...extra
  };
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  } catch {
    // 无法写入（如隐私模式）时忽略，不阻断用户操作
  }
  return record;
}

/** 撤回同意（清除本地记录） */
export function revokeConsent() {
  try {
    localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* ignore */
  }
}

/* ==================== Cookie / 本地存储告知横幅 ==================== */

/** 是否当前页面需要展示告知横幅（仅首页，可能是 / 或 /index.html） */
function isHomePage() {
  const path = window.location.pathname;
  return path === '/' || /\/index\.html$/.test(path);
}

function mountBanner() {
  if (!isHomePage()) return; // 仅在首页展示
  if (hasConsented()) return;
  if (document.querySelector('.consent-banner')) return;

  const banner = document.createElement('div');
  banner.className = 'consent-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Cookie 与本地存储提示');
  banner.innerHTML = `
        <div class="consent-banner-text">
            <strong>关于 Cookie 与本地存储</strong>
            <span>本站使用必要的 Cookie 维持登录状态，并使用浏览器本地存储保存主题偏好与临时缓存；首页含有不使用 Cookie 的访问统计。详见
                <a href="${LEGAL_URL}#cookies">《Cookie 与本地存储说明》</a>。</span>
        </div>
        <div class="consent-banner-actions">
            <a hcw-button tp flat href="${LEGAL_URL}">查看详情</a>
            <button hcw-button primary flat id="consentAcceptBtn" type="button">我知道了</button>
        </div>
    `;
  document.body.appendChild(banner);

  banner.querySelector('#consentAcceptBtn')?.addEventListener('click', () => {
    setConsent({ source: 'banner' });
    banner.remove();
  });
}

/* ==================== 登录前同意提示 ==================== */

function mountLoginNotice() {
  document.querySelectorAll('#globalLoginModal').forEach((modal) => {
    if (modal.querySelector('.consent-login-notice')) return;
    const body = modal.querySelector('[hcw-modal-body]') || modal;
    const notice = document.createElement('p');
    notice.className = 'consent-login-notice';
    notice.innerHTML = `继续登录即表示你已阅读并同意
            <a href="${LEGAL_URL}#terms" target="_blank" rel="noopener">《用户协议》</a>与
            <a href="${LEGAL_URL}#privacy" target="_blank" rel="noopener">《隐私政策》</a>`;
    body.appendChild(notice);
  });
}

/* ==================== 「清除本地数据」按钮（法务页面） ==================== */

function mountClearStorageButton() {
  const btn = document.getElementById('clearStorageBtn');
  if (!btn || btn.dataset.consentBound === '1') return;
  btn.dataset.consentBound = '1';

  btn.addEventListener('click', async () => {
    const ok = window.confirm(
      '确定要清除本站保存在当前浏览器中的本地数据并退出登录吗？\n\n' +
      '此操作只影响当前浏览器，不会删除服务器上的账号与你已提交的时刻表数据。'
    );
    if (!ok) return;

    // 1. 清除 localStorage 中的本站数据
    try {
      ['mlttc_consent', 'mlttc-theme', 'snake_best_score'].forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }

    // 2. 清除 sessionStorage 中的本站数据
    try {
      ['account_tt_cache', 'timetable_search_state', 'admin_token', 'admin_email', 'admin_logged_in']
        .forEach((k) => sessionStorage.removeItem(k));
    } catch { /* ignore */ }

    // 3. 清除可由脚本删除的 Cookie
    try {
      document.cookie = 'user_name=; Path=/; Max-Age=0; SameSite=Lax';
    } catch { /* ignore */ }

    // 4. auth_token 为 HttpOnly，脚本无法删除，需调用退出接口
    try {
      await fetch('/api/logout-D1', { credentials: 'include' });
    } catch { /* 网络异常时忽略，本地数据已清除 */ }

    window.alert('已清除本站保存在当前浏览器中的本地数据，并退出登录。');
    window.location.reload();
  });
}

/* ==================== 初始化 ==================== */

function initConsent() {
  mountBanner();
  mountLoginNotice();
  mountClearStorageButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initConsent);
} else {
  initConsent();
}
