/**
 * functions/_lib/params.js
 * ─────────────────────────────────────────────────────────────
 * 查询参数 / 表单字段的清洗与校验工具。
 *
 * 用途：消除各接口里重复出现的「去首尾空格 + 空串判定 + 长度上限」三段式校验。
 *
 * 语义与 functions/api/timetable-D1.js 里的 validateSearchParam 完全一致：
 *   1. 非字符串（null / undefined / 数字 / 对象…）一律视为非法
 *   2. 去首尾空白后再判断：空串非法、超过 maxLen 非法
 *   3. 合法时返回去空格后的字符串
 *
 * 纯函数，不访问 D1 / KV，也不构造 Response（需要响应请用 ./response）。
 */

/**
 * 去首尾空格并校验长度；非法返回 null（调用方应忽略该条件）
 * @param {*} value
 * @param {number} maxLen
 * @returns {string|null}
 */
export function cleanParam(value, maxLen) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

/**
 * 必填字符串校验
 *
 * 与 cleanParam 用同一套规则判定是否合法，只是把「为什么非法」翻译成
 * 可以直接回给用户的文案，省得每个接口各写一遍。
 *
 * @param {*} value 原始值（body 字段或 searchParams 取到的值）
 * @param {string} label 字段的中文名，用于拼错误文案，如「反馈内容」
 * @param {number} maxLen 允许的最大长度（按去空格后的字符数算）
 * @returns {{ok:true, value:string} | {ok:false, message:string}}
 */
export function requireString(value, label, maxLen) {
  const cleaned = cleanParam(value, maxLen);
  if (cleaned !== null) return { ok: true, value: cleaned };

  const name = label || '内容';
  // 类型不对（数字、对象等）单独给一句，避免误报成「不能为空」
  if (value !== null && value !== undefined && typeof value !== 'string') {
    return { ok: false, message: `${name}格式不正确` };
  }
  // 走到这里只剩两种：去空格后为空 / 超长（文案风格对齐现有接口）
  if (typeof value === 'string' && value.trim().length > maxLen) {
    return { ok: false, message: `${name}过长，请限制在${maxLen}字以内` };
  }
  return { ok: false, message: `${name}不能为空` };
}
