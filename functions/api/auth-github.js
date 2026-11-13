// functions/api/auth-github.js
// 接口地址：GET /api/auth-github
//
// 用途：GitHub OAuth 登录/注册的入口，负责生成 anti-CSRF 的 state 并 302 到 GitHub 授权页。
//
// ★ 政策说明（刻意变更，勿回退）：
//   GitHub 授权即可建号 —— GitHub 登录/注册**不再校验站点的注册码（邀请制）**。
//   用户已明确决定放弃邀请制；任何「先填注册码才能用 GitHub 登录」的折中方案
//   都不是需求，不要在回调里补回注册码校验。
//
// 入参：GET ?from=register（可选，其余值或缺省都当 home）
// 出参：
//   302 → https://github.com/login/oauth/authorize?...（正常）
//   302 → /register.html?auth=unconfigured（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET /
//         JWT_SECRET 任一缺失时；**不能 500**，站点没配密钥也必须能用密码登录）
//   429 → 限流（见 ../ratelimit 的 LIMITS.githubAuth）
//
// 依赖：env.GITHUB_CLIENT_ID、env.GITHUB_CLIENT_SECRET、env.JWT_SECRET
//       env.GITHUB_REDIRECT_URI（可选，缺省按本次请求的 origin 拼
//       https://<host>/api/auth-github-callback）
//
// state 方案（不依赖 KV，KV 是最终一致的）：
//   state = <nonce>.<ts>.<from>.<sig>
//     nonce —— 16 字节随机数的 hex，保证每次不同（防重放的前提）
//     ts    —— 签发时的 Unix 秒
//     from  —— 'register' 或 'home'，被签名覆盖，所以回调落地页无法被篡改
//     sig   —— HMAC-SHA256(env.JWT_SECRET, "<nonce>.<ts>.<from>") 的 base64url
//   校验：重算签名并做定长比较 + 检查 ts 落在 600 秒时间窗内（见 verifyState）。
//   纯 GET 接口，不读 Cookie。
import { enforceRateLimit, LIMITS } from '../ratelimit';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

// state 时间窗（秒）：10 分钟，够慢手慢脚点完授权，又短到没有重放价值
export const STATE_TTL_SECONDS = 600;

// Uint8Array → base64url（去掉 = 填充，供签名用）
function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// 生成指定字节数的随机 hex 串（nonce 用）
function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// HMAC-SHA256(secret, data) → base64url 字符串
async function hmacBase64Url(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(signature));
}

// 定长比较，避免用 === 逐字符短路泄露签名前缀
function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 签发 state（回调侧用 verifyState 校验，两函数必须成对维护）
 * @param {string} secret env.JWT_SECRET
 * @param {'register'|'home'} from 授权完成后的落地页
 * @returns {Promise<string>} "<nonce>.<ts>.<from>.<sig>"
 */
export async function signState(secret, from) {
  const payload = `${randomHex(16)}.${Math.floor(Date.now() / 1000)}.${from}`;
  const signature = await hmacBase64Url(secret, payload);
  return `${payload}.${signature}`;
}

/**
 * 校验 state：签名 + 时间窗
 * @param {string} secret env.JWT_SECRET
 * @param {string} state 回调带回的 state
 * @returns {Promise<{ok: boolean, from: 'register'|'home'}>}
 *          失败时 ok=false，from 一律回退 'home'（失败分支只会回注册页，用不到 from）
 */
export async function verifyState(secret, state) {
  const FAILED = { ok: false, from: 'home' };
  if (typeof state !== 'string') return FAILED;

  const parts = state.split('.');
  if (parts.length !== 4) return FAILED;

  const [nonce, ts, from, signature] = parts;
  if (!nonce || !/^\d+$/.test(ts)) return FAILED;

  // 签名覆盖 nonce + ts + from，任何一段被改都会对不上
  const expected = await hmacBase64Url(secret, `${nonce}.${ts}.${from}`);
  if (!timingSafeEqualString(expected, signature)) return FAILED;

  // 时间窗：只接受 600 秒内签发的 state，允许 60 秒时钟偏差
  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (age < -60 || age > STATE_TTL_SECONDS) return FAILED;

  return { ok: true, from: from === 'register' ? 'register' : 'home' };
}

/**
 * 解析回调地址：优先 env.GITHUB_REDIRECT_URI，缺省用本次请求的 origin 拼
 * （不从 env 读到就绝不写死域名，保证本地/预览/正式域名都能跑）
 */
export function resolveRedirectUri(request, env) {
  if (env.GITHUB_REDIRECT_URI) return env.GITHUB_REDIRECT_URI;
  const origin = new URL(request.url).origin;
  return `${origin}/api/auth-github-callback`;
}

// 302 跳转（no-store：state 不能被缓存页命中）
export function redirect302(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestGet({ request, env }) {
  // 频率限制：防刷授权跳转（每次都会生成新 state）
  const limited = await enforceRateLimit(request, env, LIMITS.githubAuth);
  if (limited) return limited;

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  const jwtSecret = env.JWT_SECRET;

  // 缺任一必需项 → 回注册页并带原因，绝不让用户看到 500 或白屏
  // （JWT_SECRET 也是必需的：没有它签不出 state，同样无法完成登录）
  if (!clientId || !clientSecret || !jwtSecret) {
    return redirect302('/register.html?auth=unconfigured');
  }

  const url = new URL(request.url);
  // 只认 register，其余（含未传）都回首页；归一化后放进 state 里被签名保护
  const from = url.searchParams.get('from') === 'register' ? 'register' : 'home';
  const state = await signState(jwtSecret, from);
  const redirectUri = resolveRedirectUri(request, env);

  // 手工拼 query，确保 scope 是标准写法 read:user%20user:email
  const authorizeUrl =
    `${GITHUB_AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=read:user%20user:email` +
    `&state=${encodeURIComponent(state)}`;

  return redirect302(authorizeUrl);
}
