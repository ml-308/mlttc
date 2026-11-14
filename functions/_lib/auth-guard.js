/**
 * functions/_lib/auth-guard.js
 * ─────────────────────────────────────────────────────────────
 * 登录态 / 管理员权限的统一前置校验。
 *
 * 用途：消除各接口里重复出现的「取 token → verifyToken → 判 401 → 判 role」样板。
 * 复用 ../auth 的 verifyToken / getCookie / clearAuthCookie，本模块不解析 JWT。
 *
 * 返回形状：{ ok:true, payload } / { ok:false, response }
 *   —— 不直接 return Response，是为了让调用方在失败分支还能做别的事
 *      （例如加上 CORS 头、打日志、写审计），现有接口本来就是这个写法。
 *
 * 纯校验，不访问 D1 / KV。
 */

import { verifyToken, getCookie, clearAuthCookie } from '../auth';
import { jsonError } from './response';

/**
 * 要求已登录用户（Cookie auth_token）
 * @returns {Promise<{ok:true, payload:object} | {ok:false, response:Response}>}
 *   payload 至少含 userId / email（verifyToken 的结果）
 *   失败时 response 已构造好：401「请先登录」/「登录已过期，请重新登录」（后者带 clearAuthCookie）
 */
export async function requireUser(request, env) {
  const token = getCookie(request, 'auth_token');
  if (!token) {
    return { ok: false, response: jsonError('请先登录', 401) };
  }

  let payload;
  try {
    payload = await verifyToken(token, env.JWT_SECRET);
  } catch (e) {
    // 过期 / 签名无效：先清掉坏 Cookie 再回 401，否则前端会一直带着旧票据重试
    const response = jsonError('登录已过期，请重新登录', 401);
    clearAuthCookie(response);
    return { ok: false, response };
  }

  return { ok: true, payload };
}

/**
 * 要求管理员（优先 Authorization: Bearer <JWT>，其次 Cookie auth_token）
 * @returns {Promise<{ok:true, payload:object} | {ok:false, response:Response}>}
 *   失败：401「未授权」/「登录已过期」，403「无管理员权限」
 *   判定与 admin 站完全一致：payload.role === 'admin'
 */
export async function requireAdmin(request, env) {
  // 1. 优先请求头 Bearer（前端显式携带，绕开 Safari 的 Cookie 限制）
  let token = null;
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  // 2. 没有再从 Cookie 取
  if (!token) {
    token = getCookie(request, 'auth_token');
  }

  if (!token) {
    return { ok: false, response: jsonError('未授权', 401) };
  }

  let payload;
  try {
    payload = await verifyToken(token, env.JWT_SECRET);
  } catch (e) {
    // 与 admin 站一致：这里只回 401，不动 Cookie（管理员票据也可能来自 Bearer）
    return { ok: false, response: jsonError('登录已过期', 401) };
  }

  // 3. 管理员判定：与 admmlttc/functions/api/admin.js 完全一致
  if (!payload.role || payload.role !== 'admin') {
    return { ok: false, response: jsonError('无管理员权限', 403) };
  }

  return { ok: true, payload };
}
