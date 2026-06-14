// functions/api/auth.js

export async function onRequest(context) {
  const { request, env } = context;

  // ---------- CORS 配置（必须指定具体域名，且允许携带凭据）----------
  const ALLOWED_ORIGIN = 'https://mlttc.bond'; // 不能使用 *
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',   // 允许携带 Cookie
    'Access-Control-Max-Age': '86400',
  };

  // 处理 OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace('/api/auth', '');

  try {
    if (request.method === 'POST' && path === '/register') {
      return await handleRegister(request, env.mlttcd1, corsHeaders);
    }
    if (request.method === 'POST' && path === '/login') {
      return await handleLogin(request, env.mlttcd1, corsHeaders);
    }
    if (request.method === 'GET' && path === '/me') {
      return await handleGetCurrentUser(request, env.mlttcd1, corsHeaders);
    }
    // 【新增】登出接口
    if (request.method === 'POST' && path === '/logout') {
      return await handleLogout(corsHeaders);
    }
    return json({ error: 'Not found' }, 404, corsHeaders);
  } catch (err) {
    console.error('Auth error:', err.message);
    return json({ error: 'Internal server error' }, 500, corsHeaders);
  }
}

// ========== 注册（不变）==========
async function handleRegister(request, db, corsHeaders) {
    let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const { email, password } = body;
  if (!email || !password) {
    return json({ error: 'Email and password are required' }, 400, corsHeaders);
  }
  if (!email.includes('@') || password.length < 6) {
    return json({ error: 'Invalid email format or password too short (min 6 chars)' }, 400, corsHeaders);
  }

  // 检查邮箱是否已注册
  const exists = await db.prepare('SELECT id FROM user WHERE email = ?').bind(email).first();
  if (exists) {
    return json({ error: 'Email already registered' }, 409, corsHeaders);
  }

  // 密码哈希
  const hashed = await hashPassword(password);

  // 当前日期（DATE 格式）
  const today = new Date().toISOString().split('T')[0];

  // 插入用户，city 默认 '-'，adm 默认 'user'
  await db.prepare(
    'INSERT INTO user (email, password, city, adm, registertime) VALUES (?, ?, ?, ?, ?)'
  ).bind(email, hashed, '-', 'user', today).run();

  return json({ success: true, message: 'Registration successful' }, 201, corsHeaders);
}


// ========== 登录（核心改动：不再返回 token，改为设置 HttpOnly Cookie）==========
async function handleLogin(request, db, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const { email, password } = body;
  if (!email || !password) {
    return json({ error: 'Email and password are required' }, 400, corsHeaders);
  }

  const user = await db.prepare('SELECT id, password FROM user WHERE email = ?').bind(email).first();
  if (!user) {
    return json({ error: 'Invalid credentials' }, 401, corsHeaders);
  }

  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    return json({ error: 'Invalid credentials' }, 401, corsHeaders);
  }

  const token = generateToken();
  await db.prepare('UPDATE user SET token = ? WHERE id = ?').bind(token, user.id).run();

  // 【改动】构造带 HttpOnly 的 Set-Cookie 头
  const cookieHeader = `token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`;
  // 合并 CORS 头和 Set-Cookie
  const headers = {
    ...corsHeaders,
    'Set-Cookie': cookieHeader,
  };
  return json({ success: true, message: 'Login successful' }, 200, headers);
}

// ========== 获取当前用户（核心改动：从 Cookie 中读取 Token）==========
async function handleGetCurrentUser(request, db, corsHeaders) {
  const user = await requireAuthFromCookie(request, db);
  if (user instanceof Response) return user;

  return json({
    user: {
      id: user.id,
      email: user.email,
      city: user.city,
      adm: user.adm,
      registertime: user.registertime
    }
  }, 200, corsHeaders);
}

// ========== 登出（清除 Cookie）==========
async function handleLogout(corsHeaders) {
  const headers = {
    ...corsHeaders,
    'Set-Cookie': `token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  };
  return json({ success: true, message: 'Logged out' }, 200, headers);
}

// ========== 鉴权中间件（新版本，从 Cookie 中读取 Token）==========
async function requireAuthFromCookie(request, db) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const token = getCookieValue(cookieHeader, 'token');
  if (!token) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const user = await db.prepare('SELECT id, email, city, adm, registertime FROM user WHERE token = ?').bind(token).first();
  if (!user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  return user;
}

// 辅助函数：从 Cookie 字符串中解析指定键的值
function getCookieValue(cookieStr, name) {
  const cookies = cookieStr.split('; ');
  for (const cookie of cookies) {
    const [key, val] = cookie.split('=');
    if (key === name) return val;
  }
  return null;
}

// ========== 其他工具函数（hashPassword, verifyPassword, generateToken, json 等保持不变）==========
/**
 * 密码哈希（PBKDF2，100,000 次迭代，SHA-256）
 * 返回 salt:hash 十六进制字符串
 */
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16)); // 16 字节盐
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashArray = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  const saltArray = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltArray}:${hashArray}`;
}

/**
 * 验证密码
 * @param {string} password 明文密码
 * @param {string} stored  存储的 salt:hash 字符串
 */
async function verifyPassword(password, stored) {
  const [saltHex, originalHash] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === originalHash;
}

/**
 * 生成随机 Token（URL 安全的 base64 字符串）
 */
function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 鉴权中间件：从 Authorization 头提取 Token，查询数据库，返回用户对象
 * 若失败返回 401 Response
 */
async function requireAuth(request, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice(7);
  const user = await db.prepare(
    'SELECT id, email, city, adm, registertime FROM user WHERE token = ?'
  ).bind(token).first();
  if (!user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  return user;
}

/**
 * 返回 JSON 响应的快捷方法
 */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}