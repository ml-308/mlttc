// functions/api/logout.js
import { clearAuthCookie } from '../auth';
export async function onRequestGet() {
  const response = new Response(JSON.stringify({ success: true }), { status: 200 });
  clearAuthCookie(response);
  return response;
}