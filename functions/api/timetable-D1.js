export async function onRequestGet({ request, env }) {
  return new Response(JSON.stringify({ test: 'hello' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
