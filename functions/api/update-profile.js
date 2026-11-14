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
//
// 响应构造统一走 ../_lib/response 的 json()，响应体与状态码逐字未变。
// 未改用 ../_lib/auth-guard 的 requireUser：本文件的 401 文案是「未登录」/「登录已过期」
// 且失败体只有 {error}，requireUser 给的是「请先登录」/「登录已过期，请重新登录」+
// {success:false, message, error}，两者都对不上，换过去就改契约了，故保持原写法。
// 另：原来那 8 个 {error} 分支没带 Content-Type 头，改用 json() 后统一带上
//     application/json（响应体与状态码一个字都没动，前端按 JSON 解析更稳）。
import { verifyToken, getCookie, clearAuthCookie } from '../auth';
import { enforceRateLimit, LIMITS } from '../ratelimit';
import { json } from '../_lib/response';

export async function onRequestPost({ request, env }) {
  try {
    // 频率限制：防止反复提交资料修改
    const limited = await enforceRateLimit(request, env, LIMITS.profileUpdate);
    if (limited) return limited;

    const token = getCookie(request, 'auth_token');
    if (!token) {
      return json({ error: '未登录' }, 401);
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch {
      const response = json({ error: '登录已过期' }, 401);
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
        return json({ error: '昵称不能为空' }, 400);
      }
      if (trimmedName.includes('@')) {
        return json({ error: '昵称不能包含@字符' }, 400);
      }
      if (trimmedName.length > 6) {
        return json({ error: '昵称不能超过6个字符' }, 400);
      }

      // 这次查询就是「昵称唯一性校验」本身，是 409 的判定依据，不能省：
      // 若改成「条件 UPDATE + meta.changes」，0 行变更无法区分「昵称被占」与
      // 「用户不存在」，还得补一次消歧查询（失败路径反而更慢更绕），
      // 而且 id 不存在时原代码是照常返回 200 的，条件 UPDATE 会把它的行为改掉
      const existing = await env.mlttcd.prepare(
        'SELECT id FROM USER WHERE NAME = ? AND id != ?'
      ).bind(trimmedName, userId).first();

      if (existing) {
        return json({ error: '该昵称已被使用' }, 409);
      }

      await env.mlttcd.prepare(
        'UPDATE USER SET NAME = ? WHERE id = ?'
      ).bind(trimmedName, userId).run();
    }

    // 如果要修改城市
    // （不并入上面那条 UPDATE：城市超长是 400，而原顺序是「昵称已写入后」才校验城市，
    //   合并会把这个副作用顺序一起改掉）
    if (city !== undefined && city !== null) {
      const trimmedCity = city.trim();
      if (trimmedCity.length > 6) {
        return json({ error: '城市名不能超过6个字符' }, 400);
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
    return json(resData, 200);
  } catch (err) {
    return json({ error: '服务器错误' }, 500);
  }
}
