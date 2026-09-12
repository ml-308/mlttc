// functions/api/register-D1.js
// 同一路径提供两个方法：
//   GET  /api/register-D1?email=xxx   邮箱查重（注册表单失焦时调用）
//        → 200 {success:true} / 409 {success:false, message:'邮箱已存在'} / 400 缺参
//   POST /api/register-D1             注册新用户
//        body { email, password, agree, policyVersion, agreedAt }
//        → 201 成功 / 400 未同意条款、参数缺失、邮箱格式错误 / 409 邮箱已注册
//
// 调用方：src/pages/register.js；依赖：env.mlttcd（USER 表）
// 关键约束：
//   1. agree 必须严格等于 true —— 服务端强制校验，防止绕过前端直接注册
//   2. 用户 ID 为 12 位随机数字，循环重试直到不撞库
//   3. 密码以 PBKDF2-SHA256 / 100000 次迭代 / 16 字节随机盐 存为 "saltHex:hashHex"
//      （本文件的 hashPassword 与 login-D1.js 的 verifyPassword 必须保持一致）
//   4. 同意留痕：console.log 记录条款版本与同意时间，便于日后核查
//
// 频率限制：GET 走 LIMITS.emailCheck、POST 走 LIMITS.register（见 ../ratelimit）

import { enforceRateLimit, LIMITS } from '../ratelimit';

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
    return new Response(JSON.stringify({ success: false, message: '邮箱参数缺失' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const existing = await env.mlttcd.prepare(
      'SELECT id FROM USER WHERE email = ?'
    ).bind(email.trim().toLowerCase()).first();

    if (existing) {
      return new Response(JSON.stringify({ success: false, message: '邮箱已存在' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, message: '邮箱未被使用' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
      return new Response(JSON.stringify({ success: false, message: '无效的请求数据' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { email, password, agree, policyVersion, agreedAt } = body;

    // 必须明确同意《用户协议》与《隐私政策》后方可注册（服务端强制校验，防止绕过前端）
    if (agree !== true) {
      return new Response(JSON.stringify({
        success: false,
        message: '请先阅读并同意《用户协议》与《隐私政策》后再注册'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 同意留痕：记录条款版本与同意时间，便于日后核查
    console.log(`[consent] email=${email} version=${policyVersion || 'unknown'} agreedAt=${agreedAt || new Date().toISOString()}`);

    if (!email || !password) {
      return new Response(JSON.stringify({ success: false, message: '邮箱和密码不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 邮箱格式校验
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return new Response(JSON.stringify({ success: false, message: '邮箱格式不正确' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 检查邮箱是否已存在
    const existingEmail = await env.mlttcd.prepare(
      'SELECT id FROM USER WHERE email = ?'
    ).bind(email.trim().toLowerCase()).first();
    if (existingEmail) {
      return new Response(JSON.stringify({ success: false, message: '该邮箱已注册' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 生成唯一用户 ID
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

    return new Response(JSON.stringify({ success: true, message: '注册成功' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, message: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}