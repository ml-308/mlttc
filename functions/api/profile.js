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

export async function onRequestGet({ request, env }) {
  try {
    const token = safeGetCookie(request, 'auth_token');
    if (!token) {
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401 });
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      const response = new Response(JSON.stringify({ error: '登录已过期' }), { status: 401 });
      clearAuthCookie(response);
      return response;
    }

    const user = await env.mlttcd.prepare(
      'SELECT id, email, NAME, city, registertime, adm FROM USER WHERE id = ?'
    ).bind(payload.userId).first();

    if (!user) {
      return new Response(JSON.stringify({ error: '用户不存在' }), { status: 404 });
    }

    return new Response(JSON.stringify({ user }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    // 调试用：返回详细错误，定位问题后请移除 debug 字段
    return new Response(JSON.stringify({
      error: '服务器错误',
      debug: err.stack,
      message: err.message
    }), { status: 500 });
  }
}