/**
 * functions/_lib/response.js
 * ─────────────────────────────────────────────────────────────
 * 统一响应构造工具。
 *
 * 目录约定：`functions/` 下以 `_` 开头的目录不会生成路由，
 * 因此 _lib 只作为被接口 import 的公共模块，不会变成 `/api/_lib/...` 接口。
 *
 * 用途：消除各接口里重复出现的 `new Response(JSON.stringify(...), {...})`。
 * 用法（接口文件在 functions/api/ 下，引用路径即 '../_lib/response'）：
 *   import { json, jsonError } from '../_lib/response';
 *   return json({ success: true }, 200);
 *   return jsonError('未登录', 401);
 *
 * 纯响应构造，不访问 D1 / KV。
 */

/** JSON 响应默认头 */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * 构造 JSON 响应
 * @param {any} body 响应体
 * @param {number} [status=200] HTTP 状态码
 * @returns {Response}
 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS }
  });
}

/**
 * 构造错误响应：message 与 error 同时给出同一条文案
 * （全站前端读取习惯不统一，有的读 data.message 有的读 data.error；
 *   见 functions/ratelimit.js 的 rateLimitedResponse，同样做法）
 * @param {string} message 给用户看的文案
 * @param {number} [status=500]
 * @param {object} [extra] 额外字段，合并进响应体（不要覆盖 success/message/error）
 * @returns {Response}
 */
export function jsonError(message, status = 500, extra) {
  // success / message / error 由本函数统一提供，extra 里的同名字段直接丢弃：
  // 让调用方即使手滑传了 { message: '...' } 也不会覆盖真正的错误文案
  const rest = { ...(extra || {}) };
  delete rest.success;
  delete rest.message;
  delete rest.error;
  return json({ success: false, message, error: message, ...rest }, status);
}
