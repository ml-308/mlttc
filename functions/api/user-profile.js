// functions/api/user-profile.js
// 接口地址：GET /api/user-profile?email=...
//
// 用途：「别人的主页」(user.html) 展示某位用户的公开资料 + 其已上线时刻表。
// 鉴权：公开接口，无需登录（不读 Cookie，也不返回任何凭据信息）
// 入参：query email —— 必填，去空格后非空、长度 ≤ 100、需含 @
// 出参：200 { success:true, user:{ NAME, city, registertime, emailMasked },
//             timetables:[ { ID, CITY, WAY, START, END, SPECIAL, STARTTIME, WRITETIME } ] }
//       400 email 非法
//       404 用户不存在
//       429 请求过于频繁（由 ratelimit 组件原样返回）
//       500 服务器错误
//
// 隐私：响应里**绝不出现原始 email**，只给 emailMasked（见 maskEmail）。
//       email 本身只是查询条件与作者链接的参数，不随响应下发。
// 错误体约定：message 与 error 同时给出同一条文案（前端读取习惯不统一，同 ratelimit）。
// 注意：本接口是同源调用，不需要 CORS 头（不要照抄 profile.js 的 setCorsHeaders）。
import { enforceRateLimit, LIMITS } from '../ratelimit';

/** email 长度上限 */
const MAX_EMAIL_LEN = 100;
/** 单个用户最多返回的时刻表条数 */
const MAX_TIMETABLES = 100;

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

/**
 * 邮箱脱敏：本地部分保留前 3 个字符 + '***' + '@域名'；
 * 本地部分不超过 3 个字符时只留前 1 个字符，避免短地址被反推
 *
 *   abcdef@qq.com → abc***@qq.com
 *   ab@qq.com     → a***@qq.com
 *   abc@qq.com    → a***@qq.com
 *
 * @param {string} email 原始邮箱
 * @returns {string} 脱敏后的邮箱；不含 @ 或本地部分为空时返回空串
 */
function maskEmail(email) {
  const raw = String(email || '');
  const at = raw.indexOf('@');
  if (at <= 0) return '';
  const local = raw.slice(0, at);
  const domain = raw.slice(at); // 含 @ 与其后的域名
  const keep = local.length > 3 ? 3 : 1;
  return `${local.slice(0, keep)}***${domain}`;
}

export async function onRequestGet({ request, env }) {
  try {
    // 频率限制：额度宽松（每次主页加载都会调 1 次），只为挡住脚本批量抓取
    const limited = await enforceRateLimit(request, env, LIMITS.userRead);
    if (limited) return limited;

    // ─── 入参校验 ────────────────────────────────
    // email 统一转小写：注册时就是小写入库（register-D1.js），登录查询也这么处理
    const rawEmail = new URL(request.url).searchParams.get('email');
    if (!rawEmail || typeof rawEmail !== 'string') {
      return errorResponse('缺少邮箱参数', 400);
    }
    const email = rawEmail.trim().toLowerCase();
    if (email.length === 0) {
      return errorResponse('缺少邮箱参数', 400);
    }
    if (email.length > MAX_EMAIL_LEN) {
      return errorResponse('邮箱参数过长', 400);
    }
    if (!email.includes('@')) {
      return errorResponse('邮箱格式不正确', 400);
    }

    // ─── 用户资料 ────────────────────────────────
    // 列名写法跟随现有代码：profile.js 用的是 id, email, NAME, city, registertime, adm
    const user = await env.mlttcd.prepare(
      'SELECT NAME, city, registertime FROM USER WHERE EMAIL = ?'
    ).bind(email).first();
    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    // ─── 该用户已上线的时刻表 ────────────────────
    // PASS = 1 即审核通过（对外可见）；只取公开主页需要的字段，不含 TIMEONE/TIMETWO
    const { results } = await env.mlttcd.prepare(
      'SELECT ID, CITY, WAY, START, END, SPECIAL, STARTTIME, WRITETIME FROM TIMETABLE WHERE WRITER = ?1 AND PASS = 1 ORDER BY WRITETIME DESC LIMIT 100'
    ).bind(email).all();

    return jsonResponse({
      success: true,
      user: {
        NAME: user.NAME,
        city: user.city,
        registertime: user.registertime,
        emailMasked: maskEmail(email)
      },
      timetables: results || []
    }, 200);
  } catch (err) {
    console.error('读取用户公开资料失败:', err);
    return errorResponse('服务器错误', 500);
  }
}
