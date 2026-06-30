// functions/auth.js

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
export async function signToken(payload, secret, expiresIn = '1h') {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (expiresIn === '1h' ? 3600 : expiresIn); // 默认1小时

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

// 从请求的 Cookie 中提取指定名称的 cookie 值
export function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').map(c => c.split('=').map(decodeURIComponent))
  );
  return cookies[name] || null;
}

// 设置 httpOnly Cookie
export function setAuthCookie(response, token) {
  response.headers.set('Set-Cookie', `auth_token=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`);
}

// 清除认证 Cookie
export function clearAuthCookie(response) {
  response.headers.set('Set-Cookie', `auth_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}