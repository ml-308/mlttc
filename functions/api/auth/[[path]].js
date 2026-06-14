export async function onRequest(context) {
  const { request, env } = context;

  // ---------- CORS 配置（动态允许多个域名）----------
  const allowedOrigins = ['https://mlttc.pages.dev', 'https://mlttc.bond'];
  const origin = request.headers.get('Origin');
  const allowOrigin = (origin && allowedOrigins.includes(origin)) ? origin : allowedOrigins[0];

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };

  // 处理 OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  console.log(`Auth request: ${request.method} ${url.pathname}`);

  try {
    // 注册
    if (request.method === 'POST' && url.pathname.endsWith('/register')) {
      return await handleRegister(request, env.mlttcd, corsHeaders);
    }
    // 登录
    if (request.method === 'POST' && url.pathname.endsWith('/login')) {
      return await handleLogin(request, env.mlttcd, corsHeaders);
    }
    // 获取当前用户
    if (request.method === 'GET' && url.pathname.endsWith('/me')) {
      return await handleGetCurrentUser(request, env.mlttcd, corsHeaders);
    }
    // 登出
    if (request.method === 'POST' && url.pathname.endsWith('/logout')) {
      return await handleLogout(corsHeaders);
    }

    return json({ error: 'Not found' }, 404, corsHeaders);
  } catch (err) {
    console.error('Auth error:', err.message);
    return json({ error: 'Internal server error' }, 500, corsHeaders);
  }
}

// ---------- 注册 ----------
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

  const exists = await db.prepare('SELECT id FROM user WHERE email = ?').bind(email).first();
  if (exists) {
    return json({ error: 'Email already registered' }, 409, corsHeaders);
  }

  const hashed = await hashPassword(password);
  const today = new Date().toISOString().split('T')[0];

  await db.prepare(
    'INSERT INTO user (email, password, city, adm, registertime) VALUES (?, ?, ?, ?, ?)'
  ).bind(email, hashed, '-', 'user', today).run();

  return json({ success: true, message: 'Registration successful' }, 201, corsHeaders);
}

// ---------- 登录（Set-Cookie 返回 HttpOnly Token）----------
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

  const cookieHeader = `token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`;
  const headers = {
    ...corsHeaders,
    'Set-Cookie': cookieHeader,
  };
  return json({ success: true, message: 'Login successful' }, 200, headers);
}

// ---------- 获取当前用户（从 Cookie 中读 Token）----------
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

// ---------- 登出（清除 Cookie）----------
async function handleLogout(corsHeaders) {
  const headers = {
    ...corsHeaders,
    'Set-Cookie': `token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  };
  return json({ success: true, message: 'Logged out' }, 200, headers);
}

// ---------- 鉴权（从 Cookie 提取 token）----------
async function requireAuthFromCookie(request, db) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const token = getCookieValue(cookieHeader, 'token');
  if (!token) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const user = await db.prepare(
    'SELECT id, email, city, adm, registertime FROM user WHERE token = ?'
  ).bind(token).first();
  if (!user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  return user;
}

function getCookieValue(cookieStr, name) {
  const cookies = cookieStr.split('; ');
  for (const cookie of cookies) {
    const [key, val] = cookie.split('=');
    if (key === name) return val;
  }
  return null;
}

// ==================== 工具函数 ====================
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
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

function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}