/**
 * 公开 KV 操作 API（无需鉴权）
 * 
 * 前置条件：
 * - 在 Cloudflare Pages 项目绑定 KV 命名空间，变量名 mlttckv
 */
export async function onRequest(context) {
  const { request, env } = context;

  // CORS 配置（允许所有来源，生产环境可限制为你的域名）
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'get';
  const key = url.searchParams.get('key');
  if (!key) {
    return json({ error: 'Missing "key" parameter' }, 400, corsHeaders);
  }

  const kv = env.mlttckv;
  if (!kv) {
    return json({ error: 'KV binding "mlttckv" not found' }, 500, corsHeaders);
  }

  try {
    switch (action) {
      case 'get': {
        const value = await kv.get(key);
        if (value === null) {
          return json({ error: 'Key not found', key }, 404, corsHeaders);
        }
        return json({ key, value }, 200, corsHeaders);
      }

      case 'put': {
        // 从查询参数或请求体获取 value
        let value = url.searchParams.get('value');
        if (!value && request.method === 'PUT') {
          try {
            const body = await request.json();
            value = body.value;
          } catch (_) { /* not JSON */ }
        }
        if (!value) {
          return json({ error: 'Missing "value" parameter' }, 400, corsHeaders);
        }

        const ttl = parseInt(url.searchParams.get('ttl')) || 3600; // 默认1小时
        await kv.put(key, value, { expirationTtl: ttl });
        return json({ key, value, ttl, action: 'put' }, 200, corsHeaders);
      }

      case 'delete': {
        await kv.delete(key);
        return json({ key, action: 'delete' }, 200, corsHeaders);
      }

      default:
        return json({ error: 'Invalid action. Use get/put/delete' }, 400, corsHeaders);
    }
  } catch (err) {
    console.error(`KV error: ${err.message}`);
    return json({ error: 'Internal Server Error' }, 500, corsHeaders);
  }
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}