// functions/api/login.js
// ⚠️ 实际文件名为 login-D1.js → 接口地址为 POST /api/login-D1
//    （文件名中的 -D1 只是历史命名，路由以实际文件名为准）
//
// 用途：账号密码登录。前端 src/pages/main.js 的登录弹窗提交至此。
// 入参：body { email, password, turnstileToken?, rememberCookie? }
//       含 "@" 时按邮箱匹配，否则按昵称 NAME 匹配
//       turnstileToken 可选：配置了 TURNSTILE_SECRET 时由 Turnstile 拦截（见 ../turnstile）
//       rememberCookie 可选，缺省 true：true = 30 天持久化 Cookie，false = 会话 Cookie
// 出参：200 {success:true, message:'登录成功'} + Set-Cookie(auth_token)
//       400 参数缺失 / 人机验证未通过、401 账号或密码错误
//
// 依赖：env.mlttcd（USER 表）、env.JWT_SECRET、env.TURNSTILE_SECRET（可选）
// 密码校验：PBKDF2-SHA256 / 100000 次迭代 / 256bit，与 register-D1.js 的
//           hashPassword 配对（存储格式 "saltHex:hashHex"）
//
// 响应构造统一走 ../_lib/response：带 success/message 的用 json()，
// 「message 与 error 同时给出」的用 jsonError()。响应体逐字未变。
import { signToken, setAuthCookie, setUserNameCookie } from '../auth';
import { enforceRateLimit, LIMITS } from '../ratelimit';
import { verifyTurnstile } from '../turnstile';
import { json, jsonError } from '../_lib/response';

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
      return json({ success: false, message: '无效的请求数据' }, 400);
    }

    const { email, password } = body;
    if (!email || !password) {
      return json({ success: false, message: '账号和密码不能为空' }, 400);
    }

    // 人机验证：必须在验密码、查库之前拦截。
    // 未配置 TURNSTILE_SECRET 时 skipped:true → 放行，行为与改动前一致。
    const turnstile = await verifyTurnstile(request, env, body.turnstileToken);
    if (!turnstile.ok) {
      // message 与 error 同时给出：前端各处的读取习惯不一致（见 ratelimit.js 同样处理）
      const msg = '人机验证未通过，请重试';
      return jsonError(msg, 400);
    }

    // 若输入包含 @ 则按邮箱匹配，否则按昵称匹配
    // （两个分支互斥，每次请求只会查一次库，不存在可合并的往返）
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
      return json({ success: false, message: '邮箱或密码错误' }, 401);
    }

    // 验证密码
    const isPasswordValid = await verifyPassword(password, user.password);
    if (!isPasswordValid) {
      return json({ success: false, message: '邮箱或密码错误' }, 401);
    }

    // 「保持登录」：只有明确传 false 才算不保持，缺省 / 其它值一律按 true 处理
    const rememberCookie = body.rememberCookie !== false;

    // JWT 有效期必须与 Cookie 类型配套：
    //   持久化 Cookie（30 天）→ JWT 也 30 天
    //   会话 Cookie（关浏览器失效）→ JWT 缩到 12 小时兜底
    const expiresIn = rememberCookie ? 2592000 : 12 * 60 * 60;

    // 生成 JWT
    const token = await signToken({ userId: user.id, email: user.email }, env.JWT_SECRET, expiresIn);

    // 构造响应并设置 Cookie
    const response = json({ success: true, message: '登录成功' }, 200);
    setAuthCookie(response, token, { persistent: rememberCookie });
    // 页头靠 user_name 显示登录态；以前只有前端密码登录成功时才写它，
    // 服务端这条路补齐后，「注册自动登录」「GitHub 登录」也能立刻显示已登录
    setUserNameCookie(response, user.NAME, { persistent: rememberCookie });
    return response;
  } catch (error) {
    return json({ success: false, message: '服务器错误' }, 500);
  }
}
