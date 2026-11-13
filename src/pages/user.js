// src/pages/user.js
/**
 * 用户主页（user.html）
 *
 * 路径：/user.html?email=<urlencoded email>
 *
 * 职责：
 *   1. 按 email 拉取他人的公开资料（GET /api/user-profile?email=…）
 *   2. 渲染资料卡：昵称 / 城市 / 注册时间 / 邮箱
 *      邮箱只用后端返回的 emailMasked 脱敏串，本页自己绝不拼接邮箱
 *   3. 渲染该用户「已上线」的时刻表列表（.result-area / .result-list / .result-item）
 *
 * 状态（同一时刻只显示一个容器，见 setVisibleState）：
 *   loading  → #profile-loading
 *   error    → #profile-error   （404 用户不存在 / 429 限流 / 网络错误）
 *   empty    → #profile-empty   （该用户没有已上线时刻表）
 *   missing  → #profile-missing （缺少 email 参数，不发请求）
 *   ready    → #timetable-list  （有数据）
 *
 * 接口契约（只调用，不改后端）：
 *   200 → { success: true, user: { NAME, city, registertime, emailMasked },
 *           timetables: [ { ID, CITY, WAY, START, END, SPECIAL, STARTTIME, WRITETIME } ] }
 *   400 参数非法 / 404 用户不存在 / 429 限流（响应体含 message、error）
 *
 * 安全：接口返回的字符串（NAME / 城市 / 线路 / 站名 / 备注 / 时间）拼 innerHTML 前
 *       一律经 escapeHtml() 转义；纯文本字段用 textContent 写入。
 */

// ─── 状态容器 ───────────────────────────────────────
const stateEl = {
  loading: document.getElementById('profile-loading'),
  error: document.getElementById('profile-error'),
  empty: document.getElementById('profile-empty'),
  missing: document.getElementById('profile-missing'),
  list: document.getElementById('timetable-list')
};

/** 除 ready 之外的四个状态容器 */
const STATE_KEYS = ['loading', 'error', 'empty', 'missing'];

/**
 * 切换页面状态：只显示指定的那个容器
 * @param {'loading'|'error'|'empty'|'missing'|'ready'} name
 */
function setVisibleState(name) {
  STATE_KEYS.forEach((key) => {
    stateEl[key]?.classList.toggle('hidden', key !== name);
  });
  // 列表容器仅在 ready 态显示
  stateEl.list?.classList.toggle('hidden', name !== 'ready');
}

// ─── 小工具 ─────────────────────────────────────────

/**
 * 接口字段兜底：undefined / null / 空串统一显示「—」，避免页面上出现 undefined
 * @param {*} value
 * @returns {string}
 */
function textOrDash(value) {
  if (value === undefined || value === null) return '—';
  const text = String(value).trim();
  return text === '' ? '—' : text;
}

/** 转义 HTML 特殊字符（接口字符串拼进 innerHTML 前必须转义） */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 以纯文本方式写入元素内容（昵称/城市/时间等字段专用） */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/** 错误态：写入文案并切到 error 容器 */
function showError(message) {
  if (stateEl.error) stateEl.error.textContent = message;
  setVisibleState('error');
}

// ─── 渲染 ───────────────────────────────────────────

/**
 * 渲染资料卡
 * @param {{NAME?:string, city?:string, registertime?:string, emailMasked?:string}} user
 */
function renderProfile(user) {
  const info = user || {};
  setText('userDisplayName', textOrDash(info.NAME));
  setText('userCity', textOrDash(info.city));
  setText('userRegDate', textOrDash(info.registertime));
  // 邮箱只用后端脱敏后的 emailMasked，页面不参与拼接
  setText('userEmail', textOrDash(info.emailMasked));
}

/**
 * 生成一条时刻表卡片（结构照 timetables.js 的搜索结果卡片）
 * @param {object} raw 契约中的时刻表对象
 * @param {number} idx 序号（用于入场动画错峰）
 * @returns {HTMLElement}
 */
function createTimetableCard(raw, idx) {
  const item = raw || {};
  const card = document.createElement('div');
  card.className = 'result-item';
  card.style.animationDelay = `${idx * 0.05}s`;

  // 备注：无内容或「无」时不占位（与 timetables.js 一致）
  const note = item.SPECIAL;
  const noteHtml = note && String(note).trim() !== '' && note !== '无'
    ? `<div class="result-item-note">${escapeHtml(note)}</div>`
    : '';

  // 执行时间：后端用 1000-1-1 表示未设置（与 my-timetable.js 判据一致）
  const startTime = !item.STARTTIME || item.STARTTIME === '1000-1-1'
    ? '未知执行时间'
    : textOrDash(item.STARTTIME);

  card.innerHTML = `
    <div class="result-item-header">
      <span class="result-item-id">#${escapeHtml(textOrDash(item.ID))}</span>
      <span class="result-item-route">${escapeHtml(textOrDash(item.CITY))} · ${escapeHtml(textOrDash(item.WAY))}</span>
    </div>
    <div class="result-item-body">
      <div class="result-item-stations">
        <span class="station-name">${escapeHtml(textOrDash(item.START))}</span>
        <span class="station-arrow">↔</span>
        <span class="station-name">${escapeHtml(textOrDash(item.END))}</span>
      </div>
      ${noteHtml}
      <div class="result-item-meta">
        <span>执行: ${escapeHtml(startTime)}</span>
        <span>写入: ${escapeHtml(textOrDash(item.WRITETIME))}</span>
      </div>
    </div>
  `;

  // 点击整张卡片跳详情页（与搜索结果一致）
  card.addEventListener('click', () => {
    window.location.href = `/timetable-detail.html?id=${encodeURIComponent(item.ID ?? '')}`;
  });

  return card;
}

/**
 * 渲染时刻表列表；空数组切到 empty 态
 * @param {object[]} list
 */
function renderTimetables(list) {
  if (!stateEl.list) return;
  stateEl.list.innerHTML = '';

  if (list.length === 0) {
    setVisibleState('empty');
    return;
  }

  setVisibleState('ready');
  list.forEach((item, idx) => {
    stateEl.list.appendChild(createTimetableCard(item, idx));
  });
}

// ─── 数据加载 ───────────────────────────────────────

/**
 * 拉取并渲染用户公开资料
 * @param {string} email
 */
async function loadUserProfile(email) {
  setVisibleState('loading');

  let res;
  try {
    res = await fetch(`/api/user-profile?email=${encodeURIComponent(email)}`, {
      credentials: 'include'
    });
  } catch (e) {
    // fetch 直接抛错 = 断网 / DNS / CORS 之类的网络层失败
    console.error('加载用户资料失败:', e);
    showError('网络错误，请检查网络后重试');
    return;
  }

  // 响应体可能不是 JSON（网关错误页等），解析失败时按状态码走兜底文案
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 429) {
    showError('请求过于频繁，请稍后重试');
    return;
  }
  if (res.status === 404) {
    showError('用户不存在');
    return;
  }
  if (!res.ok || !data || data.success !== true) {
    // 400 参数非法等：优先用后端文案（error → message），否则通用兜底
    const backendMsg = data ? String(data.error || data.message || '').trim() : '';
    showError(backendMsg || '加载失败，请稍后重试');
    return;
  }

  renderProfile(data.user);
  renderTimetables(Array.isArray(data.timetables) ? data.timetables : []);
}

/** 返回上一页：有历史就回退，否则回首页 */
function goBack() {
  if (history.length > 1) history.back();
  else window.location.href = '/index.html';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('backBtn')?.addEventListener('click', goBack);
  document.getElementById('missingBackBtn')?.addEventListener('click', goBack);

  // 登录按钮由 /src/pages/main.js 统一绑定（本页已包含 #globalLoginModal 结构）。

  const email = new URLSearchParams(window.location.search).get('email');
  const target = email ? email.trim() : '';

  if (!target) {
    // 缺 email 参数：直接展示「参数缺失」空态，不发请求
    setVisibleState('missing');
    return;
  }

  loadUserProfile(target);
});
