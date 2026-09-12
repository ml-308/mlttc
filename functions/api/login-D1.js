// functions/api/login.js
// ⚠️ 实际文件名为 login-D1.js → 接口地址为 POST /api/login-D1
//    （文件名中的 -D1 只是历史命名，路由以实际文件名为准）
//
// 用途：账号密码登录。前端 src/pages/main.js 的登录弹窗提交至此。
// 入参：body { email, password }；输入含 "@" 时按邮箱匹配，否则按昵称 NAME 匹配
// 出参：200 {success:true, message:'登录成功'} + Set-Cookie(auth_token, user_name)
//       400 参数缺失 / 401 账号或密码错误
//
// 依赖：env.mlttcd（USER 表）、env.JWT_SECRET
// 密码校验：PBKDF2-SHA256 / 100000 次迭代 / 256bit，与 register-D1.js 的
//           hashPassword 配对（存储格式 "saltHex:hashHex"）
import { signToken, setAuthCookie } from '../auth';
import { enforceRateLimit, LIMITS } from '../ratelimit';

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
    // 频率限制：按 IP 限制登录尝试次数（防脚本撞库 / 请求过多）
    const limited = await enforceRateLimit(request, env, LIMITS.login);
    if (limited) return limited;

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

    // 若输入包含 @ 则按邮箱匹配，否则按昵称匹配
    const input = email.trim();
    let user;
    if (input.includes('@')) {
      user = await env.mlttcd.prepare(
        'SELECT id, email, NAME, password FROM USER WHERE email = ?'
      ).bind(input.toLowerCase()).first();
    } else {
      user = await env.mlttcd.prepare(
        'SELECT id, email, NAME, password FROM USER WHERE NAME = ?'
      ).bind(input).first();
    }

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