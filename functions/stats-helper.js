// functions/stats-helper.js
/**
 * 首页「数据速览」统计的维护
 *
 * ─── 口径（唯一定义，别再处各算一套）────────────────────────— 
 *   lines   = 「已收录时刻表条数」= COUNT(*)（一条记录算一条，含同一线路的多个版本）
 *   cities  = 「覆盖城市数」= 城市名去重后的 JSON 数组（/api/stats 取它的长度）
 *   updated = 最后一次重算时间（ISO）
 *
 * ─── 为什么从「加减」改成「重算」──────────────────────────────
 * 旧实现（已删除的 statsOnInsert / statsOnDelete）有两套互相打架的口径：
 *   · 增量路径（本文件 statsOnInsert / statsOnDelete）按「记录数」±1
 *   · 全量初始化（本文件 ensureFromScratch / api/stats.js 的 initStats）
 *     按 COUNT(DISTINCT CITY, WAY)
 * 同一条线路存在多条记录时（不同起终点 / 不同执行时间各自一行），两个口径会差出
 * 好几条，于是这个数字随「上次走的是哪条路径」漂移，永远对不上真实线路数。
 * 另外批量导入（api/timetable-import-D1.js）根本没调用本文件，导入再多也不更新。
 *
 * 现在统一为一条 SQL 重算：幂等、不漂移，也不需要调用方知道当前值是多少。
 *
 * ─── 成本 ────────────────────────────────────────────────────
 * 2 条只读查询（DISTINCT 计数 + 城市名列表）+ 3 次写入。表规模千级，DISTINCT
 * 扫描可忽略；所有调用点都在「数据已经写完」之后，不阻塞响应，失败一律 fail-open
 * （保持旧值，下次再算）。
 */

async function setStat(env, key, value) {
  await env.mlttcd.prepare(
    `INSERT INTO SITE_STATS (K, V) VALUES (?, ?)
     ON CONFLICT(K) DO UPDATE SET V = excluded.V`
  ).bind(key, value).run();
}

/** 城市名去重条件：忽略 NULL 与纯空白（避免把空串算成一个城市） */
const CITY_NOT_BLANK = `TRIM(COALESCE(CITY, '')) <> ''`;

/**
 * 按库里现状重算并写回三项统计。
 *
 * @param {object} env Cloudflare 环境（需要 env.mlttcd）
 * @returns {Promise<{lines:number, cities:number}|null>} 重算结果；失败返回 null 且不改旧值
 */
export async function recomputeStats(env) {
  try {
    const row = await env.mlttcd.prepare(
      `SELECT
         (SELECT COUNT(*) FROM TIMETABLE) AS lineCount,
         (SELECT COUNT(*) FROM (SELECT DISTINCT CITY FROM TIMETABLE WHERE ${CITY_NOT_BLANK})) AS cityCount`
    ).first();

    // cities 仍按旧格式存 JSON 数组：api/stats.js 用它的长度作为「覆盖城市数」
    const { results } = await env.mlttcd.prepare(
      `SELECT DISTINCT CITY FROM TIMETABLE WHERE ${CITY_NOT_BLANK} ORDER BY CITY`
    ).all();

    const cityList = (results || []).map((r) => String(r.CITY).trim());
    const linesValue = String((row && row.lineCount) || 0);

    await setStat(env, 'lines', linesValue);
    await setStat(env, 'cities', JSON.stringify(cityList));
    await setStat(env, 'updated', new Date().toISOString());

    return { lines: Number(linesValue), cities: cityList.length };
  } catch (err) {
    // fail-open：统计暂时不精确也不该影响主流程，下次写入时会自动纠正
    console.warn('[stats] 重算失败（保留旧值）:', err);
    return null;
  }
}
