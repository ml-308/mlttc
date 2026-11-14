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
// D1 往返次数（优化点，出参完全不变）：
//   稳态：原来 4 次（ensureStats 读 lines + 分别读 lines/cities/updated），
//         现在 1 次（一条带三个子查询的 SELECT 一次取回三个键）；
//   首次初始化：原来 8 次，现在 5 次（1 次合并读 + 1 次全表扫描 + 3 次写回，
//         写回后直接用刚算出的值响应，不再回表重读）；
//   兜底路径：1 次全表扫描（与原来相同）。
//
// 依赖：env.mlttcd（D1）

/**
 * 一次往返读出统计表的三个键。
 * 写法：SELECT (SELECT …) AS a, (SELECT …) AS b, (SELECT …) AS c
 *      —— 只含子查询的 SELECT 恒返回一行；某个键不存在时该列为 NULL，
 *      与原来分别 first() 三次各拿到 null 完全等价。
 *
 * @returns {Promise<{lines: string|null, cities: string|null, updated: string|null}>}
 */
async function readStats(env) {
  const row = await env.mlttcd.prepare(
    `SELECT
       (SELECT V FROM SITE_STATS WHERE K = 'lines')   AS lines,
       (SELECT V FROM SITE_STATS WHERE K = 'cities')  AS cities,
       (SELECT V FROM SITE_STATS WHERE K = 'updated') AS updated`
  ).first();
  return row || { lines: null, cities: null, updated: null };
}

/** 写入/更新统计表一行 */
async function setStat(env, key, value) {
  await env.mlttcd.prepare(
    `INSERT INTO SITE_STATS (K, V) VALUES (?, ?)
     ON CONFLICT(K) DO UPDATE SET V = excluded.V`
  ).bind(key, value).run();
}

/**
 * 全表扫描统计（惰性初始化与兜底共用同一条 DISTINCT 查询，
 * 原来是 ensureStats / computeLive 各写一遍完全相同的 SQL）。
 *
 * @returns {Promise<{lines: number, cities: string[]}>}
 *          lines  = DISTINCT (CITY, WAY) 的行数（一条线路一行）
 *          cities = 去重后的城市名数组
 */
async function scanTimetable(env) {
  const { results } = await env.mlttcd.prepare(
    'SELECT DISTINCT CITY, WAY FROM TIMETABLE'
  ).all();

  const citySet = new Set();
  for (const r of results) {
    const c = (r.CITY || '').toString().trim();
    if (c) citySet.add(c);
  }
  return { lines: results.length, cities: [...citySet] };
}

/**
 * 惰性初始化：统计表为空时，全量统计一次并写入。
 * 只在建表后第一次调用 /api/stats 时触发一次。
 *
 * @returns {Promise<{lines: string, cities: string, updated: string}>}
 *          刚写入的三个值（键格式与表里存的完全一致），调用方无需回表重读
 */
async function initStats(env) {
  const { lines, cities } = await scanTimetable(env);
  const linesValue = String(lines);
  const citiesValue = JSON.stringify(cities);
  const updatedValue = new Date().toISOString();

  await setStat(env, 'lines', linesValue);
  await setStat(env, 'cities', citiesValue);
  await setStat(env, 'updated', updatedValue);

  return { lines: linesValue, cities: citiesValue, updated: updatedValue };
}

/**
 * 统一出参（字段名、顺序、取值方式都与改动前一致）
 * @param {number} lines 线路数
 * @param {number} cities 覆盖城市数
 * @param {string|null} updated 最后写入时间戳
 */
function jsonStats(lines, cities, updated) {
  return new Response(JSON.stringify({
    success: true,
    lines,
    cities,
    updated
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ env }) {
  // 不做 KV 限流：本接口是纯读，每请求一次 KV 读写会先撞到「写 1000/天」的免费额度；
  // 滥用由 Cloudflare 面板的 WAF 规则挡。
  try {
    const stored = await readStats(env);

    // lines 键缺失 → 统计表还没初始化：全量统计一次并写回，
    // 直接用刚算出的值响应（省掉原来写回后再读 3 次的那一轮往返）
    const data = stored.lines === null ? await initStats(env) : stored;

    let cities = 0;
    try {
      cities = JSON.parse(data.cities || '[]').length;
    } catch {
      cities = 0;
    }
    return jsonStats(parseInt(data.lines, 10) || 0, cities, data.updated || null);
  } catch (err) {
    console.error('[stats] 读取失败：', err);
    // 最后兜底：实时统计
    try {
      const live = await scanTimetable(env);
      return jsonStats(live.lines, live.cities.length, null);
    } catch (e2) {
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
