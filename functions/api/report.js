// functions/api/report.js
// 接口地址：POST /api/report                提交错误报告
//           GET  /api/report?mine=1         作者自查「因错误报告被返还给我」的条目
//
// 用途：时刻表「错误报告」提交（POST）与作者自查提醒（GET）。
// 调用方：POST — lib/ui/timetable-detail.mjs（详情页「错误报告」按钮）
//         GET  — 「我的时刻表」页（my-timetable，页面加载时调一次）
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
//
// ── GET ?mine=1 ──────────────────────────────────────────────────────────────
// 用途：「我的时刻表」页提醒作者：哪几条时刻表被管理员「返还写入者」（RESOLUTION='returned'），
//       以及管理员留的话（RESOLVENOTE）。
// 鉴权：必须已登录（同 POST：Cookie auth_token + verifyToken）；未登录 401。
// 安全：EMAIL **只取自登录态**，绝不接受 query 参数指定「查谁的」；
//       mine=1 是契约值，其它值不改变查询范围（查谁恒由 token 决定），
//       这样即使前端忘传参数也不会越权，也不会报错。
// 出参：200 { success:true, reports:[ { ID, TID, CONTENT, WRITETIME,
//                                        RESOLUTION, RESOLVENOTE,
//                                        CITY, WAY, START, END } ] }
//       401 未登录 / 登录已过期（过期时顺带清除 Cookie）
//       404 用户不存在（token 里没有 email，回查 USER 也查不到）
//       429 请求过于频繁（POST 由 ratelimit 组件原样返回；GET 已不再限流，见 onRequestGet）
//       500 服务器错误
//      表或新列尚未创建（用户还没执行新版 TIMETABLE_REPORT.sql）时**不 500**：
//      降级 200 { success:true, reports:[], note:'...' } + console.warn
//      （与 admin 仓库 functions/api/admin-reports.js 同风格）
// 过滤：只返回 RESOLUTION = 'returned'（作者尚未处理）的；
//       'author-resubmitted'（作者改表后自动销单）与 'restored'（管理员恢复上线）都不返回。
//       （有的读 data.message，有的读 data.error），限流组件 rateLimitedResponse
//       也是同一做法；只给 error 会让一部分调用方显示成笼统的「提交失败」。
import { verifyToken, getCookie, clearAuthCookie } from '../auth';
import { enforceRateLimit, LIMITS } from '../ratelimit';
import { json, jsonError } from '../_lib/response';

/** 内容长度上限（字） */
const MAX_CONTENT_LEN = 500;
/** 时刻表 ID 长度上限（TIMETABLE.ID 是 12 位数字字符串，留出余量） */
const MAX_ID_LEN = 20;

// 响应构造统一走 functions/_lib/response.js（响应体与状态码逐字不变）：
//   json(body, status)     —— 原本地包装函数的函数体，只有 JSON.stringify + status
//   jsonError(msg, status) —— 仍产出 { success:false, message, error }（见文件头「错误体约定」）

export async function onRequestPost({ request, env }) {
  try {
    // 频率限制：防灌水（每 10 分钟最多 5 条），超限时由组件直接返回 429
    const limited = await enforceRateLimit(request, env, LIMITS.report);
    if (limited) return limited;

    // 验证登录
    const token = getCookie(request, 'auth_token');
    if (!token) {
      return jsonError('请先登录', 401);
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      const response = jsonError('登录已过期，请重新登录', 401);
      clearAuthCookie(response);
      return response;
    }

    // 解析请求体
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return jsonError('无效的请求数据', 400);
    }

    // 校验时刻表 ID
    const rawId = body.id;
    if (!rawId || typeof rawId !== 'string' || rawId.trim().length === 0) {
      return jsonError('缺少时刻表ID', 400);
    }
    const tid = rawId.trim();
    if (tid.length > MAX_ID_LEN) {
      return jsonError('时刻表ID不合法', 400);
    }

    // 校验报告内容
    const rawContent = body.content;
    if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
      return jsonError('报告内容不能为空', 400);
    }
    const content = rawContent.trim();
    if (content.length > MAX_CONTENT_LEN) {
      return jsonError(`报告内容过长，请限制在${MAX_CONTENT_LEN}字以内`, 400);
    }

    // 邮箱兜底 + 时刻表存在性预检
    // payload 里没有 email 时（同 bugback.js）原本要跑两条 SQL：先查 USER、再查 TIMETABLE。
    // 这里合并成 1 次 D1 往返：两个标量子查询写在同一句 SELECT 里，按出现顺序求值，
    // 因此判定顺序仍是「先用户、后时刻表」——「用户不存在 404」照旧先于
    // 「时刻表不存在 404」，状态码与文案一个字都没变。
    // payload 已带 email 时仍只查一次 TIMETABLE（不会多做一次 USER 查询，
    // 保持原有的失败面：USER 表只在该查的时候才被访问）。
    if (!payload.email) {
      const precheck = await env.mlttcd.prepare(
        `SELECT (SELECT EMAIL FROM USER WHERE id = ?1) AS EMAIL,
                (SELECT ID FROM TIMETABLE WHERE ID = ?2) AS TID`
      ).bind(payload.userId, tid).first();
      if (!precheck || !precheck.EMAIL) {
        return jsonError('用户不存在', 404);
      }
      if (!precheck.TID) {
        return jsonError('时刻表不存在', 404);
      }
      payload.email = precheck.EMAIL;
    } else {
      // 存在性校验：报告必须挂在一条真实存在的时刻表上
      const timetable = await env.mlttcd.prepare(
        'SELECT ID FROM TIMETABLE WHERE ID = ?'
      ).bind(tid).first();
      if (!timetable) {
        return jsonError('时刻表不存在', 404);
      }
    }

    // 落库：WRITETIME 用 ISO 字符串，与 TIMETABLE.WRITETIME / USER.registertime 一致
    await env.mlttcd.prepare(
      "INSERT INTO TIMETABLE_REPORT (TID, EMAIL, CONTENT, STATUS, WRITETIME) VALUES (?1, ?2, ?3, 'open', ?4)"
    ).bind(tid, payload.email, content, new Date().toISOString()).run();

    return json({
      success: true,
      message: '报告已提交，感谢您的反馈'
    }, 201);
  } catch (err) {
    console.error('时刻表错误报告提交失败:', err);
    return jsonError('服务器错误', 500);
  }
}

// ────────────────────────────────────────────────────────────────
// GET /api/report?mine=1 —— 作者自查被「返还写入者」的错误报告
// 契约、出参与降级策略见文件头「GET ?mine=1」一节
// ────────────────────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  try {
    // 频率限制：读路径已移除（省 KV 写额度）
    // 原因：enforceRateLimit() 每次调用 = 1 次 KV 读 + 1 次 KV 写，而 KV 免费额度的写只有
    // 1000/天；本接口是「我的时刻表」页每次加载都会调的读路径，会把写额度烧光，
    // 连累真正需要限流的写接口。读接口的滥用改由 Cloudflare 面板的 WAF / Rate limiting
    // 规则兜住（不消耗 KV）。POST 的 LIMITS.report 保留不动（防灌水）。

    // 验证登录
    const token = getCookie(request, 'auth_token');
    if (!token) {
      return jsonError('请先登录', 401);
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      const response = jsonError('登录已过期，请重新登录', 401);
      clearAuthCookie(response);
      return response;
    }

    // 邮箱优先取自 JWT payload；payload 里没有时才回查 USER 表（同 POST / bugback.js）
    // ⚠️ 查询主体只由登录态决定：不读 query 里的 email/任何用户标识
    if (!payload.email) {
      const user = await env.mlttcd.prepare(
        'SELECT EMAIL FROM USER WHERE id = ?'
      ).bind(payload.userId).first();
      if (!user || !user.EMAIL) {
        return jsonError('用户不存在', 404);
      }
      payload.email = user.EMAIL;
    }
    const email = payload.email;

    try {
      // 只返回 RESOLUTION = 'returned'（作者尚未处理）的报告；
      // LEFT JOIN 时刻表是为了把 CITY/WAY/START/END 一并发给前端做标题
      // （时刻表已被删除时这些列为 null，报告本身仍要能显示）
      const { results } = await env.mlttcd.prepare(
        `SELECT r.ID, r.TID, r.CONTENT, r.WRITETIME, r.RESOLUTION, r.RESOLVENOTE,
                t.CITY, t.WAY, t.START, t.END
         FROM TIMETABLE_REPORT r
         LEFT JOIN TIMETABLE t ON t.ID = r.TID
         WHERE r.EMAIL = ?1 AND r.RESOLUTION = 'returned'
         ORDER BY r.WRITETIME DESC
         LIMIT 100`
      ).bind(email).all();

      return json({ success: true, reports: results || [] }, 200);
    } catch (queryErr) {
      // 表不存在（新版 TIMETABLE_REPORT.sql 未执行）或缺 RESOLUTION/RESOLVENOTE 等新列：
      // 降级为空列表，不让「我的时刻表」页整块报错
      console.warn('查询返还给作者的错误报告失败（TIMETABLE_REPORT 可能尚未创建或缺列）:', queryErr);
      return json({
        success: true,
        reports: [],
        note: '错误报告查询失败，TIMETABLE_REPORT 表可能尚未创建或缺少新列'
      }, 200);
    }
  } catch (err) {
    console.error('读取返还错误报告失败:', err);
    return jsonError('服务器错误', 500);
  }
}
