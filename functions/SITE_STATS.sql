-- SITE_STATS 建表 SQL（需在 Cloudflare D1 后台手动执行一次）
--
-- 用途：首页「数据速览」的统计表（functions/api/stats.js 读取，
--        functions/stats-helper.js + timetable-D1.js 增量维护）
--
-- 执行方式：Cloudflare Dashboard → D1 → 对应数据库 → Console，
--           粘贴以下 SQL 运行即可。只需执行一次，之后接口会惰性初始化数据。

CREATE TABLE IF NOT EXISTS SITE_STATS (
  K TEXT PRIMARY KEY,   -- 键名：'lines' / 'cities' / 'updated'
  V TEXT NOT NULL       -- 值（lines 为数字字符串，cities 为 JSON 数组）
);

-- 建表后无需手动插入数据：
--   GET /api/stats 首次调用时会自动全量统计一次并写入。
--   之后由 timetable-D1.js 的增删操作增量维护。
