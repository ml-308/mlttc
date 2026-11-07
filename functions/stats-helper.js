// functions/stats-helper.js
// 首页「数据速览」统计的增量维护（供 timetable-D1.js 的增删调用）
//
// 位置说明：与 auth.js / ratelimit.js 一样放 functions/ 根目录，
//           只作为被 import 的工具模块，不映射成 URL。
//
// 计数模型：
//   SITE_STATS 表（K 主键）——
//     'lines'   → 线路数（字符串数字）
//     'cities'  → 城市名 JSON 数组（去重集合）
//     'updated' → 最后更新时间戳
//
// 增量规则：
//   - 新增线路：lines+1；若该城市不在集合中，加入。
//   - 删除线路：lines-1；若删除后该城市不再有其它线路，从集合移除。
//
// 容错：任何一步失败都不抛出（fail-open），统计允许暂时不精确；
//       下次调用 /api/stats 时，若统计表缺失会自动惰性初始化自愈。

async function getStat(env, key) {
  try {
    const row = await env.mlttcd.prepare(
      'SELECT V FROM SITE_STATS WHERE K = ?'
    ).bind(key).first();
    return row ? row.V : null;
  } catch {
    return null;
  }
}

async function setStat(env, key, value) {
  try {
    await env.mlttcd.prepare(
      `INSERT INTO SITE_STATS (K, V) VALUES (?, ?)
       ON CONFLICT(K) DO UPDATE SET V = excluded.V`
    ).bind(key, value).run();
  } catch {
    /* fail-open */
  }
}

/** 读取 lines（缺失则返回 null，调用方需初始化） */
async function readLines(env) {
  const v = await getStat(env, 'lines');
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/** 读取 cities 集合（缺失返回 null） */
async function readCities(env) {
  const v = await getStat(env, 'cities');
  if (v === null) return null;
  try {
    return new Set(JSON.parse(v || '[]'));
  } catch {
    return new Set();
  }
}

async function touchUpdated(env) {
  await setStat(env, 'updated', new Date().toISOString());
}

/**
 * 新增一条线路后维护统计
 * @param {string} city 新增线路的城市（CITY 字段原值）
 */
export async function statsOnInsert(env, city) {
  // 若统计尚未初始化，先全量初始化，避免从 0 误增
  let lines = await readLines(env);
  if (lines === null) {
    await ensureFromScratch(env);
    return;
  }

  let cities = await readCities(env);
  if (cities === null) cities = new Set();

  const c = (city || '').toString().trim();
  if (c) cities.add(c);

  await setStat(env, 'lines', String(lines + 1));
  await setStat(env, 'cities', JSON.stringify([...cities]));
  await touchUpdated(env);
}

/**
 * 删除一条线路后维护统计
 * @param {string} city 被删线路的城市（CITY 字段原值）
 */
export async function statsOnDelete(env, city) {
  let lines = await readLines(env);
  if (lines === null) {
    await ensureFromScratch(env);
    return;
  }

  const newLines = Math.max(0, lines - 1);
  await setStat(env, 'lines', String(newLines));

  // 城市集合：若该城市已无其它线路，则移除（精确回收）
  const c = (city || '').toString().trim();
  if (c) {
    const { results } = await env.mlttcd.prepare(
      'SELECT ID FROM TIMETABLE WHERE CITY = ? LIMIT 1'
    ).bind(c).all();
    if (!results || results.length === 0) {
      let cities = await readCities(env);
      if (cities) {
        cities.delete(c);
        await setStat(env, 'cities', JSON.stringify([...cities]));
      }
    }
  }

  await touchUpdated(env);
}

/** 全量初始化统计表 */
async function ensureFromScratch(env) {
  try {
    const { results } = await env.mlttcd.prepare(
      'SELECT DISTINCT CITY, WAY FROM TIMETABLE'
    ).all();

    const citySet = new Set();
    for (const r of results) {
      const c = (r.CITY || '').toString().trim();
      if (c) citySet.add(c);
    }

    await setStat(env, 'lines', String(results.length));
    await setStat(env, 'cities', JSON.stringify([...citySet]));
    await touchUpdated(env);
  } catch {
    /* fail-open */
  }
}
