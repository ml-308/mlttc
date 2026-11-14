// src/pages/timetable-draft.js
/**
 * 时刻表表单草稿：自动保存 / 自动恢复 / 无人值守模式
 *
 * 解决的问题：时刻表（尤其两条时刻表文本域）动辄几百字，一次误关标签页、
 * 一次上传失败重来，用户就得整段重打。这里把「表单内容」当成草稿存进 localStorage，
 * 表单变动后自动落盘，上传成功后立即删除。
 *
 * 分工：
 *   - 本模块只管「存 / 取 / 删 / 过期 / 敏感字段过滤 / 事件绑定」，不碰任何 DOM 结构；
 *   - 页面负责：传哪几个字段、恢复后怎么回填、状态行文案挂在哪里。
 *
 * 键名约定（与站点既有 mlttc- 前缀一致）：
 *   mlttc-tdraft:create          新建页草稿
 *   mlttc-tdraft:edit:<id>       修改页草稿（按时刻表 ID 分开，改 A 表不会串到 B 表）
 *   mlttc-tdraft:unattended      无人值守模式开关（'1' = 开）
 *
 * 零依赖：不 import 任何东西（toast 由页面自己弹，模块只返回成败）。
 */

/** 所有草稿键的统一前缀 */
export const DRAFT_PREFIX = 'mlttc-tdraft:';

/** 无人值守模式开关的存储键 */
export const UNATTENDED_KEY = 'mlttc-tdraft:unattended';

/** 草稿有效期：7 天。恰好 7 天按「已过期」处理（见 parseDraft） */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 输入停顿多久后自动落盘（ms） */
export const AUTO_SAVE_DELAY_MS = 800;

/**
 * 敏感字段名的判定片段（小写包含匹配）：
 * 名字里带 token 的一律不存（authToken / api_token / X-CSRF-Token 都命中），
 * password / passwd 同理。草稿是明文存在用户本机的，没必要把凭据也留一份。
 */
const SENSITIVE_PARTS = ['token', 'password', 'passwd'];

/** 时间参数兜底：没传 / 传了非数字就用当前时间 */
function timeOf(nowMs) {
  const n = Number(nowMs);
  return Number.isFinite(n) ? n : Date.now();
}

/**
 * 取可用的 localStorage；取不到一律 null。
 * Node 里没有 window（本模块的自检脚本就跑在 Node 上），Safari 隐私模式下
 * setItem 会抛 QuotaExceededError，被浏览器策略禁用时连读属性都可能抛错，
 * 所以这里连「访问属性」都包在 try 里。
 */
function getStorage() {
  try {
    if (typeof window === 'undefined') return null;
    const s = globalThis.localStorage;
    if (!s || typeof s.getItem !== 'function' || typeof s.setItem !== 'function') return null;
    return s;
  } catch {
    return null;
  }
}

/** 字段名是否敏感（password / 任何名字带 token 的字段） */
export function isSensitiveField(name) {
  const lower = String(name == null ? '' : name).toLowerCase();
  return SENSITIVE_PARTS.some((part) => lower.includes(part));
}

/** 去掉敏感字段，并把值统一成字符串（undefined / null 直接不存） */
function filterFields(fields) {
  const clean = {};
  if (!fields || typeof fields !== 'object') return clean;
  Object.keys(fields).forEach((key) => {
    if (isSensitiveField(key)) return;
    const value = fields[key];
    if (value === undefined || value === null) return;
    clean[key] = typeof value === 'string' ? value : String(value);
  });
  return clean;
}

/**
 * 草稿键
 *   draftKey('create')      → 'mlttc-tdraft:create'
 *   draftKey('edit', 42)    → 'mlttc-tdraft:edit:42'
 * 未知 page 按 'create' 处理；edit 缺 id 时退化成 'mlttc-tdraft:edit'（不至于拼出 'edit:undefined'）
 */
export function draftKey(page, id) {
  const name = String(page == null ? '' : page).trim();
  if (name === 'edit') {
    const sid = (id === undefined || id === null) ? '' : String(id).trim();
    return sid ? `${DRAFT_PREFIX}edit:${sid}` : `${DRAFT_PREFIX}edit`;
  }
  return `${DRAFT_PREFIX}create`;
}

/**
 * 序列化成草稿字符串
 *
 * 为什么**不是纯函数（默认情况下）**：草稿必须带「保存时刻」才能判断过期，
 * 所以第二个参数缺省时取 Date.now()。显式传入 nowMs 时就是纯函数（自检脚本靠这一点断言往返）。
 *
 * @param {object} fields 表单字段
 * @param {number} [nowMs] 保存时刻（ms），缺省取当前时间
 * @returns {string} 纯 JSON 串
 */
export function serializeDraft(fields, nowMs) {
  return JSON.stringify({ savedAt: timeOf(nowMs), fields: filterFields(fields) });
}

/**
 * 解析草稿字符串，任何坏数据都返回 null，绝不抛异常
 *   - 空串 / 非字符串 → null
 *   - 坏 JSON / 非对象 / 缺 savedAt / fields 不是对象 → null
 *   - 已过期（age >= 7 天）→ null；恰好 7 天算过期，6 天 23 小时算有效
 *   - savedAt 在未来（本机时间被调过）→ 视为有效，不做惩罚
 *
 * @param {string} raw localStorage 里的原始串
 * @param {number} [nowMs] 当前时刻（ms），缺省取当前时间
 * @returns {{savedAt: number, fields: object} | null}
 */
export function parseDraft(raw, nowMs) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const savedAt = Number(obj.savedAt);
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
  if (timeOf(nowMs) - savedAt >= DRAFT_TTL_MS) return null;

  const fields = obj.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;

  return { savedAt, fields: filterFields(fields) };
}

/** 无人值守模式是否开启；存储不可用 → false（不抛异常） */
export function isUnattended() {
  const s = getStorage();
  if (!s) return false;
  try {
    return s.getItem(UNATTENDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写入无人值守模式开关；存储不可用 → false（不抛异常） */
export function setUnattended(on) {
  const s = getStorage();
  if (!s) return false;
  try {
    if (on) s.setItem(UNATTENDED_KEY, '1');
    else s.removeItem(UNATTENDED_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入草稿
 * @returns {boolean} 成功 true；存储不可用 / 配额满 / 隐私模式 → false（静默失败，不抛异常）
 */
export function saveDraft(page, id, fields, nowMs) {
  const s = getStorage();
  if (!s) return false;
  try {
    s.setItem(draftKey(page, id), serializeDraft(fields, nowMs));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取草稿；没有 / 坏了 / 过期（>= 7 天）都返回 null。
 * 过期的条目顺手删掉，免得「提示有草稿」却恢复不出东西。
 * @returns {{savedAt: number, fields: object} | null}
 */
export function loadDraft(page, id) {
  const s = getStorage();
  if (!s) return null;

  const key = draftKey(page, id);
  let raw = null;
  try {
    raw = s.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;

  const parsed = parseDraft(raw);
  if (!parsed) {
    try {
      s.removeItem(key);
    } catch { /* 删不掉也不影响返回值 */ }
    return null;
  }
  return parsed;
}

/** 删除草稿（上传成功后调用）；存储不可用 → false */
export function clearDraft(page, id) {
  const s = getStorage();
  if (!s) return false;
  try {
    s.removeItem(draftKey(page, id));
    return true;
  } catch {
    return false;
  }
}

/** 草稿距今多少分钟（负数按 0） */
export function draftAgeMinutes(savedAt, nowMs) {
  const mins = Math.floor((timeOf(nowMs) - Number(savedAt)) / 60000);
  return Number.isFinite(mins) && mins > 0 ? mins : 0;
}

/** 「刚刚 / X 分钟前 / X 小时前 / X 天前」，供状态行与确认文案使用 */
export function describeDraftAge(savedAt, nowMs) {
  const mins = draftAgeMinutes(savedAt, nowMs);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 时间戳 → 本地 HH:MM（状态行「草稿已保存 · HH:MM」用） */
export function formatClock(ms) {
  const d = new Date(timeOf(ms));
  const hh = ('0' + d.getHours()).slice(-2);
  const mm = ('0' + d.getMinutes()).slice(-2);
  return `${hh}:${mm}`;
}

/** 兜底的字段收集：遍历 root 里的 input / textarea / select，键名取 name，其次 id */
function collectFromDom(root) {
  const out = {};
  if (!root || typeof root.querySelectorAll !== 'function') return out;
  root.querySelectorAll('input, textarea, select').forEach((el) => {
    const key = el.name || el.id;
    if (!key) return;
    // 密码框、复选/单选框不写草稿：前者属凭据，后者是开关不是内容
    if (el.type === 'password' || el.type === 'checkbox' || el.type === 'radio') return;
    out[key] = el.value == null ? '' : String(el.value);
  });
  return out;
}

/**
 * 绑定自动保存
 *
 * 落盘时机：
 *   1. 容器内 input / change 事件 → 去抖 delayMs（默认 800ms）后写一次；
 *   2. pagehide（关标签页 / 跳转）→ 立刻刷，不留给去抖；
 *   3. visibilitychange 且 document.visibilityState === 'hidden'（切后台、锁屏）→ 立刻刷。
 * 2、3 是「直接关标签页丢字」的唯一兜底：去抖窗口内的最后一次输入还没落盘时，
 * 这两个事件一定会先于页面销毁触发。
 *
 * @param {HTMLElement|Document|null} form 监听事件与（默认）收集字段的容器
 * @param {object} [opts]
 * @param {'create'|'edit'} [opts.page='create'] 草稿归属页
 * @param {string|number} [opts.id] edit 页的时刻表 ID
 * @param {number} [opts.delayMs] 去抖时长，默认 800
 * @param {() => object} [opts.collect] 自定义字段收集（给了就不走 DOM 兜底）
 * @param {(fields: object) => void} [opts.onSaved] 每次成功落盘后的回调（页面用来刷状态行）
 * @returns {{flush: () => boolean, dispose: () => void}}
 */
export function bindAutoSave(form, opts = {}) {
  const page = opts.page === 'edit' ? 'edit' : 'create';
  const id = opts.id;
  const delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : AUTO_SAVE_DELAY_MS;
  const collect = typeof opts.collect === 'function' ? opts.collect : () => collectFromDom(form);
  const onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null;

  const target = (form && typeof form.addEventListener === 'function') ? form : null;
  let timer = null;
  let disposed = false;

  /** 立即落盘；dispose 之后一律不写（防止「上传成功后删除」被 pagehide 又写回来） */
  function flush() {
    if (disposed) return false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    let fields;
    try {
      fields = collect();
    } catch {
      return false;
    }
    const saved = saveDraft(page, id, fields);
    if (saved && onSaved) {
      try {
        onSaved(fields);
      } catch { /* 状态行出错不影响草稿本身 */ }
    }
    return saved;
  }

  function schedule() {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  }

  function onVisibilityChange() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
  }

  if (target) {
    target.addEventListener('input', schedule);
    target.addEventListener('change', schedule);
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    flush,
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (target) {
        target.removeEventListener('input', schedule);
        target.removeEventListener('change', schedule);
      }
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
