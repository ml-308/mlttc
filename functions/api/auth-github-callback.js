// functions/api/auth-github-callback.js
// 接口地址：GET /api/auth-github-callback
//
// 用途：GitHub OAuth 回调。校验 state → code 换 access_token → 取邮箱 → 查库/建号 → 签发登录态。
//
// ★ 政策说明（刻意变更，勿回退）：
//   GitHub 授权即可建号 —— GitHub 登录/注册**不再校验站点的注册码（邀请制）**。
//   用户已明确决定放弃邀请制，因此本文件里不存在、也不要补回「注册码校验」这一步。
//   建号按邮箱匹配：USER 表里已有同邮箱就复用，没有就新建一条，不需要给 USER 表加
//   github_id 之类的列（因此本改动不需要任何 SQL 迁移）。
//
// 入参：GET ?code=...&state=...（由 GitHub 带回）
// 出参（全部是浏览器跳转，不返回 JSON 体给正常流程）：
//   302 → /index.html?auth=github          成功（from=home 或未指定）
//   302 → /register.html?auth=github       成功（from=register）
//   302 → /register.html?auth=state-error  state 签名/时间窗校验失败
//   302 → /register.html?auth=denied       用户拒绝了授权（GitHub 带回 error 或没有 code）
//   302 → /register.html?auth=error        换 token 失败 / 取不到邮箱 / 其它异常
//   503 → 一个友好的 HTML 提示页            环境变量未配置
//   429 → 限流（见 ../ratelimit 的 LIMITS.githubAuth）
//
// 依赖：env.GITHUB_CLIENT_ID、env.GITHUB_CLIENT_SECRET、env.JWT_SECRET
//       env.GITHUB_REDIRECT_URI（可选）；env.mlttcd（USER 表）
// 密码占位：GitHub 账号没有站内密码，password 列存一个「随机串的 PBKDF2 哈希」，
//           该账号只能走 GitHub 登录，站内密码登录不可用（随机串只有本次请求知道）。
//
// 纯 GET 接口，不读 Cookie。
import { signToken, setAuthCookie, setUserNameCookie } from '../auth';
import { enforceRateLimit, LIMITS } from '../ratelimit';
import { verifyState, resolveRedirectUri, redirect302 } from './auth-github';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const EMAILS_URL = 'https://api.github.com/user/emails';
const USER_URL = 'https://api.github.com/user';

// GitHub API 强制要求 User-Agent，缺了直接 403
const GITHUB_HEADERS_BASE = {
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'mlttc-github-oauth'
};

// ─── 与 register-D1.js 完全一致的建号规则（勿自创算法）─────────
// 生成12位安全随机数字字符串（同 register-D1.js 的 generate12DigitString）
function generate12DigitString() {
  const array = new Uint32Array(3);
  crypto.getRandomValues(array);
  let num = '';
  for (let i = 0; i < 3; i++) {
    num += String(array[i] % 10000).padStart(4, '0');
  }
  return num;
}

// PBKDF2-SHA256 / 100000 次迭代 / 16 字节随机盐，存为 "saltHex:hashHex"
// （同 register-D1.js 的 hashPassword，login-D1.js 的 verifyPassword 能配对校验）
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    key,
    256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

// 生成一个没人知道的随机密码串（只用于给 password 列占位）
function randomPasswordPlaceholder() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 未配置环境变量时的友好提示页（不能 500、不能白屏）
function unconfiguredResponse() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>GitHub 登录暂不可用</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#333">
  <h2>GitHub 登录暂未开放</h2>
  <p>站点还没有配置 GitHub 登录所需的密钥，请先用邮箱密码登录或注册。</p>
  <p><a href="/register.html">返回注册页</a>　<a href="/index.html">返回首页</a></p>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// 用 code 换 access_token
async function exchangeCode(env, code, redirectUri) {
  const form = new URLSearchParams();
  form.append('client_id', env.GITHUB_CLIENT_ID);
  form.append('client_secret', env.GITHUB_CLIENT_SECRET);
  form.append('code', code);
  form.append('redirect_uri', redirectUri);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  // GitHub 出错时也返回 200，靠 error 字段区分
  if (!data || data.error || !data.access_token) return null;
  return data.access_token;
}

// 取邮箱：先 /user/emails 找 primary && verified，再退 /user 的 email 字段
async function fetchGithubEmail(accessToken) {
  try {
    const res = await fetch(EMAILS_URL, {
      headers: { ...GITHUB_HEADERS_BASE, 'Authorization': `Bearer ${accessToken}` }
    });
    if (res.ok) {
      const list = await res.json().catch(() => null);
      if (Array.isArray(list)) {
        const primary = list.find(item => item && item.primary === true && item.verified === true);
        if (primary && primary.email) return primary.email;
      }
    }
  } catch (err) {
    console.warn('[github-oauth] 读取 /user/emails 失败，改用 /user 兜底:', err);
  }

  try {
    const res = await fetch(USER_URL, {
      headers: { ...GITHUB_HEADERS_BASE, 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null);
    return (user && user.email) || null;
  } catch (err) {
    console.warn('[github-oauth] 读取 /user 失败:', err);
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  // 频率限制：与入口接口共用同一套额度（同一个 name → 同一个计数桶）
  const limited = await enforceRateLimit(request, env, LIMITS.githubAuth);
  if (limited) return limited;

  const url = new URL(request.url);

  // 1) 环境变量未配置 → 503 友好提示（不是 500、不是白屏）
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.JWT_SECRET) {
    console.warn('[github-oauth] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / JWT_SECRET 缺失');
    return unconfiguredResponse();
  }

  // 2) 校验 state（签名 + 600 秒时间窗）
  const stateCheck = await verifyState(env.JWT_SECRET, url.searchParams.get('state'));
  if (!stateCheck.ok) {
    return redirect302('/register.html?auth=state-error');
  }
  const from = stateCheck.from;

  // 3) 用户拒绝授权 / 没有 code
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('error')) {
    return redirect302('/register.html?auth=denied');
  }

  try {
    // 4) code 换 access_token
    const redirectUri = resolveRedirectUri(request, env);
    const accessToken = await exchangeCode(env, code, redirectUri);
    if (!accessToken) {
      return redirect302('/register.html?auth=error');
    }

    // 5) 取邮箱并统一小写（与 register-D1.js 的 email.trim().toLowerCase() 一致）
    const rawEmail = await fetchGithubEmail(accessToken);
    const email = rawEmail ? rawEmail.trim().toLowerCase() : '';
    if (!email) {
      return redirect302('/register.html?auth=error');
    }

    // 6) 查库：有同邮箱就复用，没有就建号（不需要 github_id 列，按邮箱匹配）
    let userId;
    // 老用户的昵称（写进 user_name Cookie 供页头显示）；新用户还没昵称，留空串
    let existingName = '';
    const existing = await env.mlttcd.prepare(
      'SELECT id, NAME FROM USER WHERE email = ?'
    ).bind(email).first();

    if (existing) {
      userId = existing.id;
      existingName = existing.NAME || '';
    } else {
      // 用户 ID 为 12 位随机数字，循环重试直到不撞库（同 register-D1.js）
      let id;
      let idExists = true;
      while (idExists) {
        id = generate12DigitString();
        const existingId = await env.mlttcd.prepare(
          'SELECT id FROM USER WHERE id = ?'
        ).bind(id).first();
        idExists = !!existingId;
      }

      // GitHub 用户没有站内密码：给一个随机串的 PBKDF2 哈希占位。
      // 随机串本身不落库、不回传，因此该账号只能走 GitHub 登录，站内密码登录不可用。
      const hashedPassword = await hashPassword(randomPasswordPlaceholder());

      // 列与取值规则照 register-D1.js 那条 INSERT：city 同为 '-'
      await env.mlttcd.prepare(
        `INSERT INTO USER (id, email, password, city, registertime)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        id,
        email,
        hashedPassword,
        '-',
        new Date().toISOString()
      ).run();

      userId = id;
      console.log(`[github-oauth] 已按 GitHub 授权新建账号 email=${email}`);
    }

    // 7) 签发登录态：有效期跟「保持登录」的选择走，与账号密码登录保持一致 ——
    //    持久（30 天持久 Cookie）或会话（关浏览器即失效 + JWT 12 小时）。
    //    该选择由发起方写进 state 并签名，回调侧无法被中途篡改。
    const remember = stateCheck.remember !== false;
    const expiresIn = remember ? 2592000 : 12 * 60 * 60;
    const token = await signToken({ userId, email }, env.JWT_SECRET, expiresIn);

    const landing = from === 'register' ? '/register.html?auth=github' : '/index.html?auth=github';
    const response = redirect302(landing);
    setAuthCookie(response, token, { persistent: remember });
    // 页头读 user_name 决定显示「登录」还是已登录；GitHub 通路必须自己写，
    // 否则授权回来仍然显示「登录」按钮
    setUserNameCookie(response, existingName, { persistent: remember });
    return response;
  } catch (err) {
    // 任何意外都不要把用户扔在 GitHub 的回调页上：回注册页并带原因
    console.error('[github-oauth] 回调处理失败:', err);
    return redirect302('/register.html?auth=error');
  }
}
