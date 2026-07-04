// functions/api/logout.js
import { clearAuthCookie } from '../auth';
export async function onRequestGet() {
  const response = new Response(JSON.stringify({ success: true }), { status: 200 });
  clearAuthCookie(response);
  response.headers.append('Set-Cookie', 'user_name=; Path=/; Max-Age=0; SameSite=Lax');
  return response;
}