import { verifyToken, getCookie, clearAuthCookie } from '../auth';

export async function onRequestPost({ request, env }) {
  try {
    const token = getCookie(request, 'auth_token');
    if (!token) {
      return new Response(JSON.stringify({ error: '未登录' }), { status: 401 });
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch {
      const response = new Response(JSON.stringify({ error: '登录已过期' }), { status: 401 });
      clearAuthCookie(response);
      return response;
    }

    const { name, city } = await request.json();
    const userId = payload.userId;

    // 如果要修改昵称，检查是否与其他用户重复
    if (name !== undefined && name !== null) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return new Response(JSON.stringify({ error: '昵称不能为空' }), { status: 400 });
      }

      const existing = await env.mlttcd.prepare(
        'SELECT id FROM USER WHERE NAME = ? AND id != ?'
      ).bind(trimmedName, userId).first();

      if (existing) {
        return new Response(JSON.stringify({ error: '该昵称已被使用' }), { status: 409 });
      }

      await env.mlttcd.prepare(
        'UPDATE USER SET NAME = ? WHERE id = ?'
      ).bind(trimmedName, userId).run();
    }

    if (city !== undefined && city !== null) {
      await env.mlttcd.prepare(
        'UPDATE USER SET CITY = ? WHERE id = ?'
      ).bind(city.trim(), userId).run();
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '服务器错误' }), { status: 500 });
  }
}
