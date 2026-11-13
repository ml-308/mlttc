// functions/api/report.js
// 接口地址：POST /api/report
//
// 用途：时刻表「错误报告」提交。
// 调用方：lib/ui/timetable-detail.mjs（详情页「错误报告」按钮）
// 入参：body { id: string, content: string }
//        id      = 被报告的时刻表 ID，去空格后非空、长度 ≤ 20
//        content = 报告正文，去空格后 1~500 字
// 鉴权：必须已登录 —— 从 Cookie auth_token 解析 JWT 取邮箱
//       （邮箱优先取 payload.email，payload 里没有时才回查 USER 表，同 bugback.js）
// 出参：201 {success:true, message:'报告已提交，感谢您的反馈'}
//       400 请求体无效 / id 非法 / 内容为空或超长
//       401 未登录或登录已过期（过期时顺带清除 Cookie）
//       404 时刻表不存在
//       429 请求过于频繁（由 ratelimit 组件原样返回）
//       500 服务器错误
//
// 落库：INSERT INTO TIMETABLE_REPORT (TID, EMAIL, CONTENT, STATUS, WRITETIME)
//       表结构见 functions/TIMETABLE_REPORT.sql —— 该表需先在 D1 后台手工建好
// 错误体约定：message 与 error 同时给出同一条文案。前端各处的读取习惯不统一
//       （有的读 data.message，有的读 data.error），限流组件 rateLimitedResponse
//       也是同一做法；只给 error 会让一部分调用方显示成笼统的「提交失败」。
import { verifyToken, getCookie, clearAuthCookie } from '../auth';
import { enforceRateLimit, LIMITS } from '../ratelimit';

/** 内容长度上限（字） */
const MAX_CONTENT_LEN = 500;
/** 时刻表 ID 长度上限（TIMETABLE.ID 是 12 位数字字符串，留出余量） */
const MAX_ID_LEN = 20;

/**
 * 构造 JSON 响应
 * @param {object} body 响应体
 * @param {number} status HTTP 状态码
 * @returns {Response}
 */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 构造错误响应：message 与 error 同值（见文件头「错误体约定」）
 * @param {string} message 给用户看的文案
 * @param {number} status HTTP 状态码
 * @returns {Response}
 */
function errorResponse(message, status) {
  return jsonResponse({ success: false, message, error: message }, status);
}

export async function onRequestPost({ request, env }) {
  try {
    // 频率限制：防灌水（每 10 分钟最多 5 条），超限时由组件直接返回 429
    const limited = await enforceRateLimit(request, env, LIMITS.report);
    if (limited) return limited;

    // 验证登录
    const token = getCookie(request, 'auth_token');
    if (!token) {
      return errorResponse('请先登录', 401);
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      const response = errorResponse('登录已过期，请重新登录', 401);
      clearAuthCookie(response);
      return response;
    }

    // 解析请求体
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return errorResponse('无效的请求数据', 400);
    }

    // 校验时刻表 ID
    const rawId = body.id;
    if (!rawId || typeof rawId !== 'string' || rawId.trim().length === 0) {
      return errorResponse('缺少时刻表ID', 400);
    }
    const tid = rawId.trim();
    if (tid.length > MAX_ID_LEN) {
      return errorResponse('时刻表ID不合法', 400);
    }

    // 校验报告内容
    const rawContent = body.content;
    if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
      return errorResponse('报告内容不能为空', 400);
    }
    const content = rawContent.trim();
    if (content.length > MAX_CONTENT_LEN) {
      return errorResponse(`报告内容过长，请限制在${MAX_CONTENT_LEN}字以内`, 400);
    }

    // 邮箱优先取自 JWT payload；payload 里没有时才回查 USER 表（同 bugback.js）
    if (!payload.email) {
      const user = await env.mlttcd.prepare(
        'SELECT EMAIL FROM USER WHERE id = ?'
      ).bind(payload.userId).first();
      if (!user || !user.EMAIL) {
        return errorResponse('用户不存在', 404);
      }
      payload.email = user.EMAIL;
    }

    // 存在性校验：报告必须挂在一条真实存在的时刻表上
    const timetable = await env.mlttcd.prepare(
      'SELECT ID, CITY FROM TIMETABLE WHERE ID = ?'
    ).bind(tid).first();
    if (!timetable) {
      return errorResponse('时刻表不存在', 404);
    }

    // 落库：WRITETIME 用 ISO 字符串，与 TIMETABLE.WRITETIME / USER.registertime 一致
    await env.mlttcd.prepare(
      "INSERT INTO TIMETABLE_REPORT (TID, EMAIL, CONTENT, STATUS, WRITETIME) VALUES (?1, ?2, ?3, 'open', ?4)"
    ).bind(tid, payload.email, content, new Date().toISOString()).run();

    return jsonResponse({
      success: true,
      message: '报告已提交，感谢您的反馈'
    }, 201);
  } catch (err) {
    console.error('时刻表错误报告提交失败:', err);
    return errorResponse('服务器错误', 500);
  }
}
