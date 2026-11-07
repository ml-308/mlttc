// functions/api/stats.js
// 接口地址：GET /api/stats
//
// 用途：首页「数据速览」——返回已收录线路数、覆盖城市数。
// 数据源：D1 表 SITE_STATS（键值表），而非每次全量扫描 TIMETABLE。
//
// 设计（惰性初始化 + 增量维护）：
//   1. 首次调用时若 SITE_STATS 为空，则对 TIMETABLE 做一次全量统计写入；
//      之后由 timetable-D1.js 的 POST（+1）/ DELETE（-1）增量维护。
//   2. 键：'lines' → 线路数（字符串数字）；'cities' → 城市名 JSON 数组；
//      'updated' → 最后写入时间戳（ISO）。
//
// 容错：统计表读取失败时，退回对 TIMETABLE 做 COUNT + DISTINCT 兜底，
//       保证首页速览在任何情况下都能拿到一个（可能略慢的）正确值。
//
// 依赖：env.mlttcd（D1）、env.mlttckv（KV，仅限流）

import { enforceRateLimit, LIMITS } from '../ratelimit';

/** 从 D1 统计表读取一行 */
async function getStat(env, key) {
  const row = await env.mlttcd.prepare(
    'SELECT V FROM SITE_STATS WHERE K = ?'
  ).bind(key).first();
  return row ? row.V : null;
}

/** 写入/更新统计表一行 */
async function setStat(env, key, value) {
  await env.mlttcd.prepare(
    `INSERT INTO SITE_STATS (K, V) VALUES (?, ?)
     ON CONFLICT(K) DO UPDATE SET V = excluded.V`
  ).bind(key, value).run();
}

/**
 * 惰性初始化：统计表为空时，全量统计一次并写入。
 * 只在建表后第一次调用 /api/stats 时触发一次。
 */
async function ensureStats(env) {
  const lines = await getStat(env, 'lines');
  if (lines !== null) return; // 已初始化

  const { results } = await env.mlttcd.prepare(
    'SELECT DISTINCT CITY, WAY FROM TIMETABLE'
  ).all();

  const linesCount = results.length;
  const citySet = new Set();
  for (const r of results) {
    const c = (r.CITY || '').toString().trim();
    if (c) citySet.add(c);
  }

  await setStat(env, 'lines', String(linesCount));
  await setStat(env, 'cities', JSON.stringify([...citySet]));
  await setStat(env, 'updated', new Date().toISOString());
}

/** 兜底：直接对 TIMETABLE 实时统计（统计表异常时用） */
async function computeLive(env) {
  const { results } = await env.mlttcd.prepare(
    'SELECT DISTINCT CITY, WAY FROM TIMETABLE'
  ).all();
  const citySet = new Set();
  for (const r of results) {
    const c = (r.CITY || '').toString().trim();
    if (c) citySet.add(c);
  }
  return { lines: results.length, cities: citySet.size };
}

export async function onRequestGet({ request, env }) {
  const limited = await enforceRateLimit(request, env, LIMITS.search);
  if (limited) return limited;

  try {
    await ensureStats(env);

    const linesStr = await getStat(env, 'lines');
    const citiesStr = await getStat(env, 'cities');
    const updated = await getStat(env, 'updated');

    if (linesStr !== null) {
      let cities = 0;
      try {
        cities = JSON.parse(citiesStr || '[]').length;
      } catch {
        cities = 0;
      }
      return new Response(JSON.stringify({
        success: true,
        lines: parseInt(linesStr, 10) || 0,
        cities,
        updated: updated || null
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // 统计表仍为空（异常场景）→ 实时兜底
    const live = await computeLive(env);
    return new Response(JSON.stringify({
      success: true,
      lines: live.lines,
      cities: live.cities,
      updated: null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[stats] 读取失败：', err);
    // 最后兜底：实时统计
    try {
      const live = await computeLive(env);
      return new Response(JSON.stringify({
        success: true,
        lines: live.lines,
        cities: live.cities,
        updated: null
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e2) {
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
