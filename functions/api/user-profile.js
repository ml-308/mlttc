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
//       500 服务器错误
//
// 隐私：响应里**绝不出现原始 email**，只给 emailMasked（见 maskEmail）。
//       email 本身只是查询条件与作者链接的参数，不随响应下发。
// 错误体约定：message 与 error 同时给出同一条文案（前端读取习惯不统一，同 ratelimit）。
// 注意：本接口是同源调用，不需要 CORS 头（不要照抄 profile.js 的 setCorsHeaders）。
//
// 查询次数：用户资料与其已上线时刻表用一条 LEFT JOIN 一次取回（原为两次往返）。

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
    // 不做 KV 限流：本接口是纯读，每请求一次 KV 读写会先撞到「写 1000/天」的免费额度；
    // 滥用由 Cloudflare 面板的 WAF 规则挡。
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

    // ─── 用户资料 + 该用户已上线的时刻表（一条 LEFT JOIN 取回）────
    // 原来是两次往返（先查 USER，再查 TIMETABLE），这里合成一条：
    //   · 用户不存在  → 0 行 → 下面照旧返回 404
    //   · 无已上线时刻表 → 1 行，且 TIMETABLE 侧各列全为 NULL（下面按 ID 过滤掉）
    //   · 列名冲突：USER 有 city、TIMETABLE 有 CITY，而 SQLite 列名不区分大小写，
    //     同一行对象里会撞在一起；所以用户侧三列必须起 user_* 别名，TIMETABLE
    //     侧保持原列名（这样下发字段名与两次查询版逐字一致）
    // PASS = 1 即审核通过（对外可见）；只取公开主页需要的字段，不含 TIMEONE/TIMETWO
    const { results } = await env.mlttcd.prepare(
      `SELECT u.NAME AS user_name, u.city AS user_city, u.registertime AS user_registertime,
              t.ID, t.CITY, t.WAY, t.START, t.END, t.SPECIAL, t.STARTTIME, t.WRITETIME
         FROM USER u
         LEFT JOIN TIMETABLE t ON t.WRITER = u.EMAIL AND t.PASS = 1
        WHERE u.EMAIL = ?1
        ORDER BY t.WRITETIME DESC
        LIMIT 100`
    ).bind(email).all();

    if (!results || results.length === 0) {
      return errorResponse('用户不存在', 404);
    }

    // 剥掉 LEFT JOIN 带出的用户侧别名列，剩下的就是原样下发的时刻表字段
    const timetables = [];
    for (const row of results) {
      if (row.ID === null || row.ID === undefined) continue; // LEFT JOIN 补的空行
      const { user_name, user_city, user_registertime, ...rest } = row;
      timetables.push(rest);
    }

    return jsonResponse({
      success: true,
      user: {
        NAME: results[0].user_name,
        city: results[0].user_city,
        registertime: results[0].user_registertime,
        emailMasked: maskEmail(email)
      },
      timetables
    }, 200);
  } catch (err) {
    console.error('读取用户公开资料失败:', err);
    return errorResponse('服务器错误', 500);
  }
}
