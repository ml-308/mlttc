// functions/api/version.js
// 接口地址：GET /api/version
//
// 用途：返回当前「已部署版本号」，供前端「检查新版本」使用。
//
// 为什么这个接口必须存在（别删）：
//   客户端缓存的旧版 JS 里写死了 fetch('/api/version')，只有这个路径能叫醒它们。
//   删掉它以后，旧客户端拿到的是 Pages 回落的 index.html（200 + HTML），
//   res.json() 直接抛错 -> 静默 -> 「更新提示完全不弹」。
//
// 版本号来源：静态标记 lib/data/changelog.json 的 latestVersion
//   （由 tools/gen-changelog.mjs 从 src/version.js 生成，与 JS 同一次部署下发，
//     所以不会出现 KV 那种「版本号与实际部署脱节」的问题）。
//   取不到静态资源时退回下面的兜底常量。
//
// 出参：{ success: true, version: '1.3.1', notes: '' }

/** 兜底版本号：取不到静态标记时返回，需与 src/version.js 保持一致 */
const FALLBACK_VERSION = '1.3.1';

/** 静态标记路径（仓库里的 lib/data/changelog.json） */
const MARKER_PATH = '/lib/data/changelog.json';

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 版本号是「随时可能变」的实时数据，任何缓存都会让检查失效
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestGet({ request, env }) {
  let version = FALLBACK_VERSION;
  let notes = '';

  try {
    // env.ASSETS 是 Pages 的静态资源入口：直接读同一次部署里的标记文件
    const res = await env.ASSETS.fetch(new URL(MARKER_PATH, request.url));
    if (res.ok) {
      const data = await res.json();
      if (data && data.latestVersion) version = String(data.latestVersion);
      if (data && data.notes) notes = String(data.notes);
    }
  } catch {
    // 静态资源读不到：用兜底版本号，绝不能因为这里失败把通知链路掐断
  }

  return jsonResponse({ success: true, version, notes });
}