// functions/turnstile.js
// ─── Cloudflare Turnstile 服务端校验（非路由模块）─────────────
// 位置说明：与 auth.js / ratelimit.js 一样放在 functions/ 根目录，
// 而**不是** functions/api/，因此只作为被 import 的工具模块，不会映射成 URL。
//
// 校验取舍（重要，勿随意改动）：
//   1) env.TURNSTILE_SECRET 未配置（undefined / 空串）
//      → 一律放行：{ ok: true, skipped: true, reason: 'unconfigured' }
//      理由：站点在还没申请/没配置密钥之前必须照常可用，不能因为少一个
//      环境变量就把登录、注册全部堵死。
//   2) 已配置 TURNSTILE_SECRET → fail-closed
//      此时 token 缺失、Cloudflare 判定失败、网络异常、非 2xx、响应不是
//      合法 JSON，全部返回 ok:false。理由：配了密钥就等于「我要求过人机
//      验证」，这种情况下的放行等于没开验证，反而给脚本开了绿灯。
//      排障信息一律 console.warn 出来，但不把细节回给前端。
//
// 其它约定：
//   - 不缓存、不写 KV。KV 是最终一致的，这类一次性校验既没有复用价值，
//     还会让一次通过的证明被重放。
//   - 密钥只从 env 读，代码里不出现任何真实 secret。
//
// 用法：
//   import { verifyTurnstile } from '../turnstile';
//   const check = await verifyTurnstile(request, env, body.turnstileToken);
//   if (!check.ok) { /* 返回 400，示例见 api/login-D1.js、api/register-D1.js */ }

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 校验前端拿到的 Turnstile token
 *
 * @param {Request} request 用于取 CF-Connecting-IP 作为 remoteip
 * @param {object} env       需要 env.TURNSTILE_SECRET
 * @param {string} [token]   前端提交的 turnstileToken（可选字段）
 * @returns {Promise<{ok: boolean, skipped: boolean, reason: string}>}
 *          reason 取值：
 *            'unconfigured'  —— 未配置密钥，放行
 *            'success'       —— 校验通过
 *            'missing-token' —— 已配置但前端没带 token
 *            'failed'        —— Cloudflare 明确判定失败
 *            'verify-error'  —— 网络异常 / 非 2xx / JSON 解析失败（fail-closed）
 */
export async function verifyTurnstile(request, env, token) {
  const secret = env && env.TURNSTILE_SECRET;

  // 未配置 → 放行（见文件头取舍说明第 1 条）
  if (!secret) {
    return { ok: true, skipped: true, reason: 'unconfigured' };
  }

  const responseToken = typeof token === 'string' ? token.trim() : '';

  // 已配置但没带 token → 直接拒绝，不必白跑一次网络请求
  if (!responseToken) {
    return { ok: false, skipped: false, reason: 'missing-token' };
  }

  // 按官方要求提交 form-urlencoded：secret + response + remoteip
  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', responseToken);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    // 非 2xx：配置了就 fail-closed
    if (!res.ok) {
      console.warn(`[turnstile] siteverify 返回 HTTP ${res.status}`);
      return { ok: false, skipped: false, reason: 'verify-error' };
    }

    // 解析失败会被下面的 catch 接住 → verify-error
    const data = await res.json();
    if (data && data.success === true) {
      return { ok: true, skipped: false, reason: 'success' };
    }

    // 明确判定失败：把 error-codes 打出来便于排障（hostname 不匹配、token 过期/重放等）
    const codes = (data && data['error-codes']) || [];
    console.warn(`[turnstile] 校验未通过: ${JSON.stringify(codes)}`);
    return { ok: false, skipped: false, reason: 'failed' };
  } catch (err) {
    // 网络异常 / JSON 解析失败：已配置就必须拦住，同时保留原始错误便于排障
    console.warn('[turnstile] siteverify 请求异常:', err);
    return { ok: false, skipped: false, reason: 'verify-error' };
  }
}
