import { verifyToken, getCookie, clearAuthCookie } from '../auth';

export async function onRequestPost({ request, env }) {
  try {
    // 验证登录
    const token = getCookie(request, 'auth_token');
    if (!token) {
      return new Response(JSON.stringify({ error: '请先登录' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let payload;
    try {
      payload = await verifyToken(token, env.JWT_SECRET);
    } catch (e) {
      const response = new Response(JSON.stringify({ error: '登录已过期，请重新登录' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
      clearAuthCookie(response);
      return response;
    }

    // 获取用户邮箱
    const user = await env.mlttcd.prepare(
      'SELECT EMAIL FROM USER WHERE id = ?'
    ).bind(payload.userId).first();

    if (!user || !user.EMAIL) {
      return new Response(JSON.stringify({ error: '用户不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 解析请求体
    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ error: '无效的请求数据' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const bugback = body.bugback;
    if (!bugback || typeof bugback !== 'string' || bugback.trim().length === 0) {
      return new Response(JSON.stringify({ error: '反馈内容不能为空' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (bugback.trim().length > 2000) {
      return new Response(JSON.stringify({ error: '反馈内容过长，请限制在2000字以内' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 插入 BUG 表
    const now = new Date().toISOString();
    await env.mlttcd.prepare(
      'INSERT INTO BUG (EMAIL, BUGBACK) VALUES (?1, ?2)'
    ).bind(user.EMAIL, bugback.trim()).run();

    return new Response(JSON.stringify({
      success: true,
      message: '反馈已提交，感谢您的支持'
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('BUG反馈错误:', err);
    return new Response(JSON.stringify({ error: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
