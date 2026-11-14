// functions/api/bugback.js
// 接口地址：POST /api/bugback
//
// 用途：首页 BUG 反馈提交。
// 调用方：src/pages/main.js
// 入参：body { bugback:string }（去空格后 1~2000 字）
// 鉴权：必须已登录 —— 从 Cookie auth_token 解析 JWT 取邮箱
// 出参：201 {success:true, message:'反馈已提交，感谢您的支持'}
//       400 内容为空/超长/请求体无效、401 未登录或已过期、404 用户不存在
//
// 落库：INSERT INTO BUG (EMAIL, BUGBACK)，依赖 env.mlttcd
// 优化点：邮箱优先取自 JWT payload，只有 payload 里没有时才回查 USER 表
//
// 响应构造统一走 ../_lib/response 的 json()，响应体与状态码逐字未变。
// 401 分支未改用 ../_lib/auth-guard 的 requireUser，原因有两条：
//   1. 文案其实对得上（请先登录 / 登录已过期，请重新登录），清 Cookie 的时机也一样；
//   2. 但 requireUser 失败时给的是 jsonError 的 {success:false, message, error}，
//      而本文件 401 一直是裸 {error}，多注入两个字段就改了出参形状，故保留原写法。
import { verifyToken, getCookie, clearAuthCookie } from '../auth';
import { enforceRateLimit, LIMITS } from '../ratelimit';
import { json } from '../_lib/response';

export async function onRequestPost({ request, env }) {
  try {
    // 频率限制：防灌水（每 10 分钟最多 5 条）
    const limited = await enforceRateLimit(request, env, LIMITS.feedback);
    if (limited) return limited;

    // 验证登录
    const token = getCookie(request, 'auth_token');
    if (!token) {
      return json({ error: '请先登录' }, 401);
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      const response = json({ error: '登录已过期，请重新登录' }, 401);
      clearAuthCookie(response);
      return response;
    }

    // 解析请求体
    const body = await request.json().catch(() => null);
    if (!body) {
      return json({ error: '无效的请求数据' }, 400);
    }

    // 这里没用 ../_lib/params 的 requireString：它对「非字符串」回的是
    // 「反馈内容格式不正确」，而本接口对非字符串一直回「反馈内容不能为空」，
    // 换了就改文案，故保留原判定（空/超长两句文案本身与 requireString 一致）
    const bugback = body.bugback;
    if (!bugback || typeof bugback !== 'string' || bugback.trim().length === 0) {
      return json({ error: '反馈内容不能为空' }, 400);
    }
    if (bugback.trim().length > 2000) {
      return json({ error: '反馈内容过长，请限制在2000字以内' }, 400);
    }

    // 直接从 JWT payload 获取邮箱，无需再次查询 USER 表
    if (!payload.email) {
      // 兜底：payload 中没有 email 时才查库
      const user = await env.mlttcd.prepare(
        'SELECT EMAIL FROM USER WHERE id = ?'
      ).bind(payload.userId).first();
      if (!user || !user.EMAIL) {
        return json({ error: '用户不存在' }, 404);
      }
      payload.email = user.EMAIL;
    }

    // 插入 BUG 表
    await env.mlttcd.prepare(
      'INSERT INTO BUG (EMAIL, BUGBACK) VALUES (?1, ?2)'
    ).bind(payload.email, bugback.trim()).run();

    return json({
      success: true,
      message: '反馈已提交，感谢您的支持'
    }, 201);
  } catch (err) {
    console.error('BUG反馈错误:', err);
    return json({ error: '服务器错误' }, 500);
  }
}
