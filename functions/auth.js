// functions/auth.js
// ─── 认证工具模块（非路由，不会注册成接口）──────────────────
// 位置说明：本文件在 functions/ 根目录，而非 functions/api/，
// 因此只作为被 import 的模块；只有 functions/api/** 才会映射成 URL。
//
// 导出内容：
//   signToken(payload, secret, expiresIn)  签发 JWT（HS256，默认 30 天）
//   verifyToken(token, secret)             校验 JWT，失败抛异常，成功返回 payload
//   getCookie(request, name)               从请求头 Cookie 中取值
//   setAuthCookie(response, token, opts)    写入登录 Cookie
//                                          opts.persistent=false → 会话 Cookie
//   clearAuthCookie(response)              清除登录 Cookie
//
// Cookie 约定：
//   auth_token —— HttpOnly，携带 JWT，前端 JS 读不到，仅服务端校验用
//   user_name  —— 非 HttpOnly，供页头直接显示昵称
//
// 安全密钥：必须使用环境变量，绝对不能硬编码
// 在 Pages 控制台 Settings -> Environment variables 中添加 JWT_SECRET
// 本地测试时可在 wrangler.toml 中设置

// 将 ArrayBuffer 转为 Base64URL 字符串
function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// 将 Base64URL 字符串转为 ArrayBuffer
function base64UrlToArrayBuffer(base64url) {
  const padding = '=='.slice(0, (4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return buffer;
}

// 签发 JWT
export async function signToken(payload, secret, expiresIn = 2592000) {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expiresIn;

  const payloadWithClaims = { ...payload, iat: now, exp };

  const headerEncoded = btoa(JSON.stringify(header)).replace(/=/g, '');
  const payloadEncoded = btoa(JSON.stringify(payloadWithClaims)).replace(/=/g, '');
  const data = headerEncoded + '.' + payloadEncoded;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const signatureEncoded = arrayBufferToBase64Url(signature);
  return `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;
}

// 验证 JWT，返回 payload（若无效则抛出异常）
export async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token 格式无效');

  const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
  const data = headerEncoded + '.' + payloadEncoded;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signature = base64UrlToArrayBuffer(signatureEncoded);
  const isValid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(data));

  if (!isValid) throw new Error('签名无效');

  const payload = JSON.parse(atob(payloadEncoded));

  // 检查过期
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('Token 已过期');
  }

  return payload; // 包含 userId 等
}

// 从请求的 Cookie 中提取指定名称的 cookie 值（兼容各种格式）
export function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = {};
  cookieHeader.split(';').forEach(c => {
    const parts = c.trim().split('=');
    if (parts.length >= 2) {
      try {
        const key = decodeURIComponent(parts[0]);
        const value = decodeURIComponent(parts.slice(1).join('='));
        cookies[key] = value;
      } catch (e) {
        // 忽略解码失败的 cookie
      }
    }
  });
  return cookies[name] || null;
}

// 设置 httpOnly Cookie（兼容 Safari）
//   persistent: true（默认） → 30 天持久化 Cookie，带 Max-Age=2592000
//   persistent: false        → 会话 Cookie，不带 Max-Age / Expires，
//                              关掉浏览器即失效（「不保持登录」用）
// 注意：不传第 3 个参数时行为与改动前完全一致（向后兼容）。
//       另外 JWT 自身也有 exp，调用方必须让 expiresIn 与这里的取值配套，
//       否则会出现「Cookie 是会话级但 JWT 还能用 30 天」的不一致。
export function setAuthCookie(response, token, { persistent = true } = {}) {
  response.headers.set(
    'Set-Cookie',
    persistent
      ? `auth_token=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=2592000`
      : `auth_token=${token}; HttpOnly; Secure; SameSite=None; Path=/`
  );
}

/**
 * 写入 user_name Cookie（**非 HttpOnly**：页头与抽屉要读它来决定「登录 / 已登录」的显示）
 *
 * 为什么必须由服务端写：登录有两条通路（注册后自动登录、GitHub 授权登录）根本不经过
 * 前端「密码登录成功」的回调，而以前只有那条通路写 user_name —— 于是用这两种方式登录后，
 * 页头仍然显示「登录」按钮。
 *
 * 有效期与 auth_token 对齐（持久 30 天 / 会话）。它只是显示用的旁路信息，
 * 真正的凭据是 HttpOnly 的 auth_token：即使它被伪造，也只是让页头显示错，
 * 拿不到任何权限（所有身份相关操作都由服务端校验 auth_token）。
 *
 * @param {Response} response 要追加头部的响应
 * @param {string} name 昵称，可为空串（此时页头显示「未设置昵称」，但仍算已登录）
 * @param {{persistent?: boolean}} [opts] 与 setAuthCookie 的 persistent 保持一致
 */
export function setUserNameCookie(response, name, { persistent = true } = {}) {
  const value = encodeURIComponent(name == null ? '' : String(name));
  const attrs = ['Path=/', 'SameSite=Lax'];
  if (persistent) attrs.push('Max-Age=2592000');
  // 用 append 而不是 set：setAuthCookie 已经用 set 占用了第一个 Set-Cookie
  response.headers.append('Set-Cookie', `user_name=${value}; ${attrs.join('; ')}`);
}

// 清除认证 Cookie
export function clearAuthCookie(response) {
  response.headers.set(
    'Set-Cookie',
    `auth_token=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`
  );
}