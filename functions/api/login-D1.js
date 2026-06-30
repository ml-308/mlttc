// functions/api/login.js
import { signToken, setAuthCookie } from '../auth';

// 密码验证函数（与注册时的 hashPassword 配对使用）
async function verifyPassword(password, storedValue) {
  const [saltHex, originalHashHex] = storedValue.split(':');
  if (!saltHex || !originalHashHex) return false;

  const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  const encoder = new TextEncoder();
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
  const newHashHex = Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return newHashHex === originalHashHex;
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ success: false, message: '无效的请求数据' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { email, password } = body;
    if (!email || !password) {
      return new Response(JSON.stringify({ success: false, message: '邮箱和密码不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 查找用户
    const user = await env.mlttcd.prepare(
      'SELECT id, email, password FROM USER WHERE email = ?'
    ).bind(email.trim().toLowerCase()).first();

    if (!user) {
      return new Response(JSON.stringify({ success: false, message: '邮箱或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证密码
    const isPasswordValid = await verifyPassword(password, user.password);
    if (!isPasswordValid) {
      return new Response(JSON.stringify({ success: false, message: '邮箱或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 生成 JWT
    const token = await signToken({ userId: user.id, email: user.email }, env.JWT_SECRET);

    // 构造响应并设置 Cookie
    const response = new Response(JSON.stringify({ success: true, message: '登录成功' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    setAuthCookie(response, token);
    return response;
  } catch (error) {
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}