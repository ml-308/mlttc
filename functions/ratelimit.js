// functions/ratelimit.js
// ─── 通用 IP 频率限制（非路由模块）──────────────────────────
// 位置说明：与 auth.js 一样放在 functions/ 根目录，而**不是** functions/api/，
// 因此只作为被 import 的工具模块，不会映射成 URL。
//
// 计数模型：固定窗口（fixed window）
//   KV key  = rl:<name>:<ip>      （与邮箱白名单共用 mlttckv 命名空间，rl: 前缀避免撞键）
//   KV 值   = { w: 窗口起始秒, n: 窗口内计数 }
//   过期时间 = 窗口长度 × 2，防止 KV 无限堆积
//
// 用法：
//   import { enforceRateLimit, LIMITS } from '../ratelimit';
//
//   export async function onRequestPost({ request, env }) {
//     const limited = await enforceRateLimit(request, env, LIMITS.feedback);
//     if (limited) return limited;
//     // …正常逻辑
//   }
//
// ⚠️ 已知局限（选型决定，不是 bug）：
//   1. KV 是最终一致的，多地并发请求时计数可能偏少 → 挡不住分布式高频刷，
//      只适合挡「单机脚本 / 手抖连点」这类请求过多。要挡分布式请用 Cloudflare
//      WAF 的 Rate limiting 规则（见 README 或运维说明），那是边缘层拦截。
//   2. KV 读写异常时一律**放行**（fail-open）——限流组件故障不应该让全站不可用。
//   3. 计数按 IP 归并，同一出口 IP 的用户（公司/校园网）会共享额度。

/**
 * 取出客户端 IP。
 * Cloudflare 生产环境一定带 CF-Connecting-IP；本地或其它环境退回 X-Forwarded-For；
 * 都取不到时用 'unknown'（此时所有此类请求共用一个桶，宁可少挡也不拦错）。
 *
 * @param {Request} request
 * @returns {string}
 */
export function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/**
 * 计一次数并判断是否超限（不返回响应，便于自定义处理）
 *
 * @param {Request} request
 * @param {{mlttckv: KVNamespace}} env
 * @param {{name: string, max: number, window: number, suffix?: string}} rule
 *        阈值规则；传了 suffix 就按 suffix 计数（用于在 IP 之外再加一个维度，
 *        例如按账号限流传 `acct:${email}`），否则按 IP 计数。
 * @returns {Promise<{allowed: boolean, count: number, max: number, retryAfter: number}>}
 *          allowed=false 表示已超限；retryAfter 为建议等待秒数
 */
export async function consume(request, env, { name, max, window: windowSeconds, suffix }) {
  const now = Math.floor(Date.now() / 1000);
  const key = `rl:${name}:${suffix || getClientIp(request)}`;

  let record = null;
  try {
    record = await env.mlttckv.get(key, { type: 'json' });
  } catch {
    record = null; // 读失败 → 当作新窗口，fail-open
  }

  // 双保险：个别运行时不支持 { type: 'json' }，会原样返回字符串。
  // 不解析的话，下面的 typeof 校验会把它判成「无记录」→ 每次都开新窗口 → 等于没限流。
  if (typeof record === 'string') {
    try {
      record = JSON.parse(record);
    } catch {
      record = null;
    }
  }

  // 记录缺失、格式不对，或已超出窗口 → 开一个新窗口
  if (!record || typeof record.w !== 'number' || typeof record.n !== 'number' || now - record.w >= windowSeconds) {
    record = { w: now, n: 1 };
  } else {
    record.n += 1;
  }

  // 写回不 await：限流记录属于「尽力而为」，失败不影响本次请求
  try {
    env.mlttckv
      .put(key, JSON.stringify(record), { expirationTtl: windowSeconds * 2 })
      .catch(() => {});
  } catch {
    /* 同上 */
  }

  return {
    allowed: record.n <= max,
    count: record.n,
    max,
    retryAfter: Math.max(1, record.w + windowSeconds - now)
  };
}

/**
 * 构造 429 响应，带 Retry-After 与限流相关信息头
 *
 * @param {{max: number, retryAfter: number}} info
 * @returns {Response}
 */
export function rateLimitedResponse({ max, retryAfter }) {
  const message = `请求过于频繁，请在 ${retryAfter} 秒后重试`;
  return new Response(
    JSON.stringify({
      success: false,
      // message 与 error 同时给出：前端各处的错误读取习惯不一致
      // （有的读 data.message，有的读 data.error），两个都带上才能保证
      // 用户看到的是「请求过于频繁」而不是一句笼统的「提交失败」。
      message,
      error: message,
      retryAfter
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(max),
        'X-RateLimit-Remaining': '0'
      }
    }
  );
}

/**
 * 限流中间件：超限返回 429 响应，未超限返回 null
 *
 * @param {Request} request
 * @param {object} env
 * @param {{name: string, max: number, window: number, suffix?: string}} rule
 * @returns {Promise<Response|null>} 非 null 时调用方应直接 return 它
 */
export async function enforceRateLimit(request, env, rule) {
  const result = await consume(request, env, rule);
  return result.allowed ? null : rateLimitedResponse(result);
}

/**
 * 各接口阈值（「适中」档：内测小站的默认强度）
 *   max    = 窗口内允许的最大次数
 *   window = 窗口长度（秒）
 *
 * 调整建议：阈值调小是「更严」，调大是「更松」；
 * 每个接口用独立的 name → 独立计数桶，互不影响。
 */
export const LIMITS = {
  /** 时刻表搜索 / 详情查询（读多，额度给大一些） */
  search: { name: 'search', max: 30, window: 60 },
  /** 邮箱查重、注册白名单校验（防批量探测邮箱是否已注册） */
  emailCheck: { name: 'email-check', max: 20, window: 60 },
  /** 个人资料读取（每次页面加载都会调 2~4 次，额度必须宽松） */
  profileRead: { name: 'profile-read', max: 60, window: 60 },
  /** 新增 / 修改时刻表 */
  write: { name: 'write', max: 10, window: 600 },
  /** 删除时刻表 */
  remove: { name: 'remove', max: 20, window: 600 },
  /** 登录（防脚本撞库 / 请求过多） */
  login: { name: 'login', max: 10, window: 300 },
  /** 注册 */
  register: { name: 'register', max: 5, window: 600 },
  /** 修改昵称 / 城市 */
  profileUpdate: { name: 'profile-update', max: 10, window: 600 },
  /** BUG 反馈（防灌水） */
  feedback: { name: 'feedback', max: 5, window: 600 }
};
