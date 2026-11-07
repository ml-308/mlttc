// functions/api/version.js
// 接口地址：GET /api/version
//
// 用途：返回站点「最新版本号」与更新日志摘要，供前端「检查新版本」使用。
//
// 版本号真相源：KV 命名空间 env.mlttckv 的键 `site:latest-version`。
//   发版时在 KV 里更新该键即可，无需改代码 / 重新部署 Functions。
//   读不到该键时，回退为代码内置的兜底版本号（见下方 FALLBACK_VERSION）。
//
// 出参：
//   { success:true, version:'1.2.7', notes:'…摘要…' }

import { enforceRateLimit, LIMITS } from '../ratelimit';

/** 兜底版本号：KV 未配置时返回，保持与前端 src/version.js 一致 */
const FALLBACK_VERSION = '1.2.7';

/** KV 键名 */
const VERSION_KEY = 'site:latest-version';

export async function onRequestGet({ request, env }) {
  const limited = await enforceRateLimit(request, env, LIMITS.search);
  if (limited) return limited;

  let version = FALLBACK_VERSION;
  let notes = '';

  try {
    const raw = await env.mlttckv.get(VERSION_KEY, { type: 'json' });
    if (raw && typeof raw === 'object') {
      version = raw.version || FALLBACK_VERSION;
      notes = raw.notes || '';
    } else if (typeof raw === 'string' && raw.trim()) {
      // 兼容「只存版本号字符串」的情况
      version = raw.trim();
    }
  } catch {
    // KV 读取失败 → 用兜底版本号，不阻断前端
  }

  return new Response(JSON.stringify({
    success: true,
    version,
    notes
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
