// functions/api/profile.js 示例
import { verifyToken, getCookie, clearAuthCookie } from '../auth';

export async function onRequestGet({ request, env }) {
  try {
    const token = getCookie(request, 'auth_token');
    if (!token) {
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401 });
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      // token 无效或过期，清除 cookie 并返回 401
      const response = new Response(JSON.stringify({ error: '登录已过期' }), { status: 401 });
      clearAuthCookie(response);
      return response;
    }

    // 通过 payload.userId 进行后续操作，如获取用户资料
    const user = await env.mlttcd.prepare(
      'SELECT id, email, city, registertime FROM USER WHERE id = ?'
    ).bind(payload.userId).first();

    if (!user) {
      return new Response(JSON.stringify({ error: '用户不存在' }), { status: 404 });
    }

    return new Response(JSON.stringify({ user }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '服务器错误' }), { status: 500 });
  }
}