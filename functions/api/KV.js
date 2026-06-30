export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!key) {
      return new Response(JSON.stringify({message: '缺少 key 参数' ,way:0}), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const value = await env.mlttckv.get(key);
    if (value === null) {
      return new Response(JSON.stringify({ message: '邮箱正确但没有注册权限' ,way:2}), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
      return new Response(JSON.stringify({success: true,message:"邮箱正确且可以注册",value:value,way:1}),{
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
  } catch (err) {
    return new Response(JSON.stringify({message: '服务器错误' ,way:0}), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

}