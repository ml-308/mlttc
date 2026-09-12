// functions/api/update-profile.js
// 接口地址：POST /api/update-profile
//
// 用途：修改昵称 NAME / 城市 CITY（两个字段都可选，传哪个改哪个）。
// 调用方：src/pages/account.js
// 入参：body { name | NAME, city }（name 与 NAME 都兼容）
// 鉴权：必须已登录（Cookie auth_token → JWT）
// 出参：200 {success:true, name?} —— 改了昵称时回传新昵称，供前端刷新 user_name Cookie
//       400 昵称为空 / 含 @ / 超过 6 字，或城市超过 6 字
//       401 未登录或登录过期（过期时顺带清 Cookie）
//       409 昵称已被他人占用
// 注意：昵称唯一性只靠应用层查重，不依赖数据库唯一索引
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
