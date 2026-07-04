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

    let { name, NAME, city } = await request.json();
    name = name || NAME; // 兼容前端传入的 name 或 NAME
    const userId = payload.userId;

    // 如果要修改昵称
    if (name !== undefined && name !== null) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return new Response(JSON.stringify({ error: '昵称不能为空' }), { status: 400 });
      }
      if (trimmedName.includes('@')) {
        return new Response(JSON.stringify({ error: '昵称不能包含@字符' }), { status: 400 });
      }
      if (trimmedName.length > 6) {
        return new Response(JSON.stringify({ error: '昵称不能超过6个字符' }), { status: 400 });
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

    // 如果要修改城市
    if (city !== undefined && city !== null) {
      const trimmedCity = city.trim();
      if (trimmedCity.length > 6) {
        return new Response(JSON.stringify({ error: '城市名不能超过6个字符' }), { status: 400 });
      }
      await env.mlttcd.prepare(
        'UPDATE USER SET CITY = ? WHERE id = ?'
      ).bind(trimmedCity, userId).run();
    }

    const resData = { success: true };
    // 如果更新了昵称，把新昵称返回给前端，让前端更新 cookie
    if (name !== undefined && name !== null) {
      resData.name = name.trim();
    }
    return new Response(JSON.stringify(resData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '服务器错误' }), { status: 500 });
  }
}
