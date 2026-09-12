// functions/api/logout.js
// ⚠️ 实际文件名为 logout-D1.js → 接口地址为 GET /api/logout-D1
//
// 用途：退出登录。同时清除 auth_token（HttpOnly）与 user_name 两个 Cookie。
// 调用方：src/auth-header.js 的 logout()（全站唯一的退出实现）
// 出参：200 {success:true}
// 注意：无需鉴权，未登录时调用也安全（等价于清空 Cookie）
import { clearAuthCookie } from '../auth';
export async function onRequestGet() {
  const response = new Response(JSON.stringify({ success: true }), { status: 200 });
  clearAuthCookie(response);
  response.headers.append('Set-Cookie', 'user_name=; Path=/; Max-Age=0; SameSite=Lax');
  return response;
}