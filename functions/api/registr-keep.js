/**
 * 用户认证 API
 * 
 * 前置条件：
 * 1. 绑定 D1 数据库，变量名为 mlttcd1。
 * 2. 执行建表 SQL：
 *    CREATE TABLE IF NOT EXISTS users (
 *      id INTEGER PRIMARY KEY AUTOINCREMENT,
 *      username TEXT UNIQUE NOT NULL,
 *      password_hash TEXT NOT NULL,
 *      token TEXT,
 *      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
 *    );
 */

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };

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

  const { username, password } = body;
  if (!username || !password) {
    return json({ error: 'Username and password required' }, 400, corsHeaders);
  }
  if (username.length < 3 || password.length < 6) {
    return json({ error: 'Username min 3 chars, password min 6 chars' }, 400, corsHeaders);
  }

  const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) {
    return json({ error: 'Username already taken' }, 409, corsHeaders);
  }

  const hash = await hashPassword(password);
  await db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').bind(username, hash).run();

  return json({ success: true, message: 'User registered' }, 201, corsHeaders);
}

// ---------- 登录 ----------
async function handleLogin(request, db, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const { username, password } = body;
  if (!username || !password) {
    return json({ error: 'Username and password required' }, 400, corsHeaders);
  }

  const user = await db.prepare('SELECT id, password_hash FROM users WHERE username = ?').bind(username).first();
  if (!user) {
    return json({ error: 'Invalid credentials' }, 401, corsHeaders);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return json({ error: 'Invalid credentials' }, 401, corsHeaders);
  }

  const token = generateToken();
  await db.prepare('UPDATE users SET token = ? WHERE id = ?').bind(token, user.id).run();

  return json({ token }, 200, corsHeaders);
}

// ---------- 获取当前用户（需鉴权）----------
async function handleGetCurrentUser(request, db, corsHeaders) {
  const user = await requireAuth(request, db);
  if (user instanceof Response) return user; // 鉴权失败返回 401

  return json({ user: { id: user.id, username: user.username, created_at: user.created_at } }, 200, corsHeaders);
}

// ==================== 工具函数 ====================

// 密码哈希（PBKDF2）
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

// 密码验证
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

// 生成随机 Token（base64url）
function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// 鉴权中间件：从 Authorization 头提取 token，查询用户，失败返回 401 Response
async function requireAuth(request, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice(7);
  const user = await db.prepare('SELECT id, username, token, created_at FROM users WHERE token = ?').bind(token).first();
  if (!user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  return user;
}

// 通用 JSON 响应
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}