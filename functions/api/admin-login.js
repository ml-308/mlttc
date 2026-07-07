// functions/api/admin-login.js
import { signToken } from '../auth';

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

const ADMIN_TOKEN_EXPIRY = 259200; // 3天（秒）

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
      return new Response(JSON.stringify({ success: false, message: '账号和密码不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 支持邮箱或昵称登录
    const input = email.trim();
    let user;
    if (input.includes('@')) {
      user = await env.mlttcd.prepare(
        'SELECT id, email, NAME, password, adm FROM USER WHERE email = ?'
      ).bind(input.toLowerCase()).first();
    } else {
      user = await env.mlttcd.prepare(
        'SELECT id, email, NAME, password, adm FROM USER WHERE NAME = ?'
      ).bind(input).first();
    }

    if (!user) {
      return new Response(JSON.stringify({ success: false, message: '管理员账号或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证管理员权限：adm 不为 'user' 即为管理员，adm 列的值即管理令牌
    if (!user.adm || user.adm === 'user') {
      return new Response(JSON.stringify({ success: false, message: '无管理员权限' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证密码
    const isPasswordValid = await verifyPassword(password, user.password);
    if (!isPasswordValid) {
      return new Response(JSON.stringify({ success: false, message: '管理员账号或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 生成 JWT（3天过期）
    const token = await signToken(
      { userId: user.id, email: user.email, role: 'admin' },
      env.JWT_SECRET,
      ADMIN_TOKEN_EXPIRY
    );

    return new Response(JSON.stringify({
      success: true,
      token,
      email: user.email,
      name: user.NAME,
      message: '管理员登录成功'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('管理员登录错误:', error);
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
