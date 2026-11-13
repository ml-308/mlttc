-- TIMETABLE_REPORT 建表 / 升级 SQL（在 Cloudflare D1 后台 Console 手工执行一次）
--
-- 用途：时刻表「错误报告」收集表。
--       写入方 functions/api/report.js（详情页 timetable-detail.html 的「错误报告」按钮）。
--       读取方 主站 GET /api/report?mine=1（作者自查被返还的条目）、
--              管理端 admmlttc 的 GET /api/admin-reports（按时刻表列出全部报告）。
--       每个时刻表可以有任意多条报告，一条报告一行，便于后台逐条处理。
--
-- 执行方式：Cloudflare Dashboard → D1 → 对应数据库（mlttcd）→ Console，
--           把下面「情况 A」或「情况 B」中的一段粘贴进去运行，**二选一执行**。
--           ⚠️ 本仓库不提供自动建表，接口写入前该表必须已存在，否则 INSERT 会失败。
--
-- ⚠️ 情况 A 与情况 B 二选一，不要混着跑：
--      · 情况 A（表还没建）→ 执行 A 段，一条 CREATE TABLE IF NOT EXISTS 建出完整十列。
--      · 情况 B（表已经建过旧版四列/六列）→ 只执行 B 段的四条 ALTER TABLE。
--    为什么不能混着跑：A 段的 CREATE ... IF NOT EXISTS 对已存在的表是**安全**的
--    （什么都不做，也不清数据），但 B 段的 ALTER TABLE ADD COLUMN 在列已存在时会**报错**
--    （SQLite/D1 的 ADD COLUMN 不支持 IF NOT EXISTS），所以对同一张表重复执行 B 段会失败。
--    最省事的判定方式：先跑一次自查语句，看结果有没有 RESOLVEDBY 那一行 ——
--      没有 → 走 A 段（表不存在时 PRAGMA 也会返回空，同样按「需要建」处理）；
--      有四列已有 RESOLVEDBY/RESOLVEDTIME/RESOLUTION/RESOLVENOTE → 什么都不用做；
--      有表但没有这四列（旧版四/六列）→ 走 B 段。
--
-- 自查语句（在 D1 Console 里单独执行，不进任何代码）：
--   PRAGMA table_info(TIMETABLE_REPORT);
--
-- 列含义：
--   ID          自增主键（报告自身的编号，与时刻表 ID 无关）
--   TID         被报告的时刻表 ID（对应 TIMETABLE.ID，TEXT 类型，不是数字）
--   EMAIL       提交报告的用户邮箱（取自登录状态；USER.EMAIL 为小写）
--   CONTENT     报告正文（去首尾空格后 1~500 字）
--   STATUS      处理状态：'open' 待处理（默认） → 'resolved' 已处置
--   WRITETIME   提交时间，ISO 字符串（与 TIMETABLE / USER.registertime 的写法一致）
--   RESOLVEDBY  处理人邮箱（管理员处置时写管理员邮箱；作者改表自动销单时为空）
--   RESOLVEDTIME 处理时间，ISO 字符串（写法与 WRITETIME 一致）
--   RESOLUTION  处置方式，三选一：
--                 'restored'             管理员恢复上线
--                 'returned'             返还写入者（作者需自己改表）
--                 'author-resubmitted'   作者改表后自动销单（timetable-D1.js 的更新分支写入）
--   RESOLVENOTE 管理员留言（可选，给作者看）
--
-- 索引说明：idx_report_tid 用于「按时刻表查它的所有报告」这一最常见的查询方向。
--
-- 兼容性说明：RESOLVEDBY / RESOLVEDTIME / RESOLUTION / RESOLVENOTE 四列必须**可空且无默认值**，
--   因为旧数据（未处置的报告）在这四列上就是 NULL，接口据此判断「还没处理」。
--   在主站执行完 A 或 B 段之前，主站与 admin 的读取接口都会降级为空列表（不 500），
--   只是提醒功能暂时看不到数据，改表/提交报告不受影响。


-- ═══════════════════════════════════════════════════════════════
-- 情况 A：表还没建过 —— 直接建出完整十列（A 与 B 二选一）
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS TIMETABLE_REPORT (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  TID TEXT NOT NULL,
  EMAIL TEXT NOT NULL,
  CONTENT TEXT NOT NULL,
  STATUS TEXT NOT NULL DEFAULT 'open',
  WRITETIME TEXT NOT NULL,
  RESOLVEDBY TEXT,
  RESOLVEDTIME TEXT,
  RESOLUTION TEXT,
  RESOLVENOTE TEXT
);


-- ═══════════════════════════════════════════════════════════════
-- 情况 B：表已经建过（旧版四列/六列，没有 RESOLVED* 这四列）
--         A 与 B 二选一 —— 已按 A 建过表的话，**不要**执行下面四条 ALTER，
--         列已存在时 ADD COLUMN 会报错。逐条执行，便于定位是哪一条失败。
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE TIMETABLE_REPORT ADD COLUMN RESOLVEDBY TEXT;
ALTER TABLE TIMETABLE_REPORT ADD COLUMN RESOLVEDTIME TEXT;
ALTER TABLE TIMETABLE_REPORT ADD COLUMN RESOLUTION TEXT;
ALTER TABLE TIMETABLE_REPORT ADD COLUMN RESOLVENOTE TEXT;


-- ═══════════════════════════════════════════════════════════════
-- 索引：A / B 两种情况都要执行（IF NOT EXISTS，重复执行安全）
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_report_tid ON TIMETABLE_REPORT (TID);
