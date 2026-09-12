// functions/api/profile.js
import { verifyToken, getCookie, clearAuthCookie } from '../auth';

// 安全版本的 getCookie（修复原版缺陷）
function safeGetCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = {};
  cookieHeader.split(';').forEach(c => {
    const parts = c.trim().split('=');
    if (parts.length >= 2) {
      try {
        const key = decodeURIComponent(parts[0]);
        const value = decodeURIComponent(parts.slice(1).join('='));
        cookies[key] = value;
      } catch (e) {
        // 忽略解码失败的 cookie
      }
    }
  });
  return cookies[name] || null;
}

// 统一设置 CORS 凭据头
function setCorsHeaders(response) {
  response.headers.set('Access-Control-Allow-Origin', 'https://mlttc.bond');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  return response;
}

// ─── 用户身份（角色）判定 ─────────────────────────
// 数据来源：USER.adm 列。在此统一解析后随资料一起返回，
// 前端直接使用 role / roleLabel 显示，无需再比对原始值
// （避免大小写、前后空格导致判定失败）
// 注意：查表前会做 toLowerCase()，所以此表的键必须全部小写
const ROLE_INFO = {
  adm: { key: 'admin', label: '管理员' },
  admin: { key: 'admin', label: '管理员' },
  station: { key: 'station', label: '站长' },
  '站长': { key: 'station', label: '站长' }
};
const ROLE_USER = { key: 'user', label: '普通用户' };

/**
 * 把 adm 原始值解析为标准角色（大小写、前后空格均兼容）
 * @param {string|null|undefined} adm 数据库中的身份值
 * @returns {{key:'admin'|'station'|'user', label:string}}
 */
function parseRole(adm) {
  if (adm === null || adm === undefined) return ROLE_USER;
  const raw = String(adm).trim().toLowerCase();
  return ROLE_INFO[raw] || ROLE_USER;
}

export async function onRequestGet({ request, env }) {
  try {
    let token = null;

    // 1. 优先从 Authorization 头获取 Bearer token
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    // 2. 如果没有，再从 Cookie 中获取
    if (!token) {
      token = safeGetCookie(request, 'auth_token');
    }

    if (!token) {
      const response = new Response(JSON.stringify({ error: '未登录' }), { status: 401 });
      return setCorsHeaders(response);
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      const response = new Response(JSON.stringify({ error: '登录已过期' }), { status: 401 });
      clearAuthCookie(response);
      return setCorsHeaders(response);
    }

    const user = await env.mlttcd.prepare(
      'SELECT id, email, NAME, city, registertime, adm FROM USER WHERE id = ?'
    ).bind(payload.userId).first();

    if (!user) {
      const response = new Response(JSON.stringify({ error: '用户不存在' }), { status: 404 });
      return setCorsHeaders(response);
    }

    // 统一身份判定：前端可直接使用 user.roleLabel 显示身份
    const role = parseRole(user.adm);

    const response = new Response(JSON.stringify({
      user: { ...user, role: role.key, roleLabel: role.label },
      role: role.key,
      roleLabel: role.label
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    return setCorsHeaders(response);
  } catch (err) {
    // 调试用：返回详细错误，定位问题后请移除 debug 字段
    const response = new Response(JSON.stringify({
      error: '服务器错误',
      debug: err.stack,
      message: err.message
    }), { status: 500 });
    return setCorsHeaders(response);
  }
}