// functions/api/register-D1.js
// 同一路径提供两个方法：
//   GET  /api/register-D1?email=xxx   邮箱查重（注册表单失焦时调用）
//        → 200 {success:true} / 409 {success:false, message:'邮箱已存在'} / 400 缺参
//   POST /api/register-D1             注册新用户
//        body { email, password, agree, policyVersion, agreedAt,
//               turnstileToken?, rememberCookie? }
//        → 201 成功（并写入 auth_token 登录 Cookie）/ 400 未同意条款、参数缺失、
//          邮箱格式错误、人机验证未通过 / 409 邮箱已注册
//        turnstileToken 可选：配置了 TURNSTILE_SECRET 时由 Turnstile 拦截（见 ../turnstile）
//        rememberCookie 可选，缺省 true：true = 30 天持久化 Cookie，false = 会话 Cookie
//
// 调用方：src/pages/register.js；依赖：env.mlttcd（USER 表）、
//         env.JWT_SECRET、env.TURNSTILE_SECRET（可选）
// 关键约束：
//   1. agree 必须严格等于 true —— 服务端强制校验，防止绕过前端直接注册
//   2. 用户 ID 为 12 位随机数字，循环重试直到不撞库
//   3. 密码以 PBKDF2-SHA256 / 100000 次迭代 / 16 字节随机盐 存为 "saltHex:hashHex"
//      （本文件的 hashPassword 与 login-D1.js 的 verifyPassword 必须保持一致）
//   4. 同意留痕：console.log 记录条款版本与同意时间，便于日后核查
//
// 频率限制：GET 走 LIMITS.emailCheck、POST 走 LIMITS.register（见 ../ratelimit）
//
// 响应构造统一走 ../_lib/response：带 success/message 的用 json()，
// 「message 与 error 同时给出」的用 jsonError()。响应体逐字未变。
// 查询点未做合并：邮箱查重与 ID 查重循环的判断顺序、以及「撞库就重试」的
// 语义都要保留（理由见 onRequestPost 内注释）。

import { enforceRateLimit, LIMITS } from '../ratelimit';
import { verifyTurnstile } from '../turnstile';
import { signToken, setAuthCookie, setUserNameCookie } from '../auth';
import { json, jsonError } from '../_lib/response';

// 生成12位安全随机数字字符串
function generate12DigitString() {
  const array = new Uint32Array(3);
  crypto.getRandomValues(array);
  let num = '';
  for (let i = 0; i < 3; i++) {
    num += String(array[i] % 10000).padStart(4, '0');
  }
  return num;
}

// 将密码转换为哈希（PBKDF2 + 随机盐）
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
  // 将 salt 和 derivedBits 合并为一个字符串存储
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

// 检查邮箱是否已注册（GET 请求）
export async function onRequestGet({ request, env }) {
  // 频率限制：防止被批量探测「哪些邮箱已注册」
  const limited = await enforceRateLimit(request, env, LIMITS.emailCheck);
  if (limited) return limited;

  const url = new URL(request.url);
  const email = url.searchParams.get('email');

  if (!email) {
    return json({ success: false, message: '邮箱参数缺失' }, 400);
  }

  try {
    const existing = await env.mlttcd.prepare(
      'SELECT id FROM USER WHERE email = ?'
    ).bind(email.trim().toLowerCase()).first();

    if (existing) {
      return json({ success: false, message: '邮箱已存在' }, 409);
    }

    return json({ success: true, message: '邮箱未被使用' }, 200);
  } catch (error) {
    return json({ success: false, message: '服务器错误' }, 500);
  }
}

// 注册新用户（POST 请求）
export async function onRequestPost({ request, env }) {
  try {
    // 频率限制：注册是重操作，额度收得比较紧
    const limited = await enforceRateLimit(request, env, LIMITS.register);
    if (limited) return limited;

    const body = await request.json().catch(() => null);
    if (!body) {
      return json({ success: false, message: '无效的请求数据' }, 400);
    }

    const { email, password, agree, policyVersion, agreedAt } = body;

    // 必须明确同意《用户协议》与《隐私政策》后方可注册（服务端强制校验，防止绕过前端）
    if (agree !== true) {
      return json({
        success: false,
        message: '请先阅读并同意《用户协议》与《隐私政策》后再注册'
      }, 400);
    }

    // 同意留痕：记录条款版本与同意时间，便于日后核查
    console.log(`[consent] email=${email} version=${policyVersion || 'unknown'} agreedAt=${agreedAt || new Date().toISOString()}`);

    if (!email || !password) {
      return json({ success: false, message: '邮箱和密码不能为空' }, 400);
    }

    // 邮箱格式校验
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return json({ success: false, message: '邮箱格式不正确' }, 400);
    }

    // 人机验证：放在写库之前拦截（未配置 TURNSTILE_SECRET 时 skipped:true → 放行）
    const turnstile = await verifyTurnstile(request, env, body.turnstileToken);
    if (!turnstile.ok) {
      // message 与 error 同时给出：前端各处的读取习惯不一致（见 ../ratelimit.js）
      const msg = '人机验证未通过，请重试';
      return jsonError(msg, 400);
    }

    // 检查邮箱是否已存在
    const existingEmail = await env.mlttcd.prepare(
      'SELECT id FROM USER WHERE email = ?'
    ).bind(email.trim().toLowerCase()).first();
    if (existingEmail) {
      return json({ success: false, message: '该邮箱已注册' }, 409);
    }

    // 生成唯一用户 ID
    // 这里保留「先查重、再 INSERT」的两次往返，不并成 INSERT 失败后重试：
    //   撞库时 INSERT 会抛异常，被外层 catch 吞成 500「服务器错误」，
    //   要重试就得加异常分类与重试循环，逻辑更绕且容易误伤真实写库失败
    let id;
    let idExists = true;
    while (idExists) {
      id = generate12DigitString();
      const existingId = await env.mlttcd.prepare(
        'SELECT id FROM USER WHERE id = ?'
      ).bind(id).first();
      idExists = !!existingId;
    }

    // 密码哈希（使用 Web Crypto）
    const hashedPassword = await hashPassword(password);

    // 插入新用户
    await env.mlttcd.prepare(
      `INSERT INTO USER (id, email, password, city, registertime)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      id,
      email.trim().toLowerCase(),
      hashedPassword,
      '-',
      new Date().toISOString()
    ).run();

    const response = json({ success: true, message: '注册成功' }, 201);

    // 注册成功后顺手签发登录态（可选能力，由 rememberCookie 控制是否持久化）
    // 缺省 true → 30 天持久化 Cookie；false → 会话 Cookie + JWT 12 小时。
    // 这段失败不能影响「注册已成功」的结论：用户已经写进库了，
    // 所以只在 JWT_SECRET 存在时签发，且整体包在 try 里，失败就返回不带 Cookie 的 201。
    const rememberCookie = body.rememberCookie !== false;
    if (env.JWT_SECRET) {
      try {
        const expiresIn = rememberCookie ? 2592000 : 12 * 60 * 60;
        const token = await signToken(
          { userId: id, email: email.trim().toLowerCase() },
          env.JWT_SECRET,
          expiresIn
        );
        setAuthCookie(response, token, { persistent: rememberCookie });
        // 注册流程不收集昵称，先写空串：页头据此判定「已登录」（显示为未设置昵称），
        // 否则注册完成跳到首页后仍然显示「登录」按钮
        setUserNameCookie(response, '', { persistent: rememberCookie });
      } catch (err) {
        console.warn('[register] 签发登录 Cookie 失败，本次仅返回注册成功:', err);
      }
    }

    return response;
  } catch (error) {
    return json({ success: false, message: '服务器错误' }, 500);
  }
}
