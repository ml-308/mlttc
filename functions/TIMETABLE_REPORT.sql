-- TIMETABLE_REPORT 建表 SQL（需在 Cloudflare D1 后台 Console 手工执行一次）
--
-- 用途：时刻表「错误报告」收集表。
--       写入方 functions/api/report.js（详情页 timetable-detail.html 的「错误报告」按钮）。
--       每个时刻表可以有任意多条报告，一条报告一行，便于后台逐条处理。
--
-- 执行方式：Cloudflare Dashboard → D1 → 对应数据库（mlttcd）→ Console，
--           把下面的 SQL 粘贴进去运行即可。只需执行一次；
--           建表语句用的是 IF NOT EXISTS，重复执行不会报错、也不会清掉已有数据。
--           ⚠️ 本仓库不提供自动建表，接口写入前该表必须已存在，否则 INSERT 会失败。
--
-- 列含义：
--   ID        自增主键（报告自身的编号，与时刻表 ID 无关）
--   TID       被报告的时刻表 ID（对应 TIMETABLE.ID，TEXT 类型，不是数字）
--   EMAIL     提交报告的用户邮箱（取自登录状态；USER.EMAIL 为小写）
--   CONTENT   报告正文（去首尾空格后 1~500 字）
--   STATUS    处理状态，默认 'open'（待处理）；其它取值由后台流程自行约定
--   WRITETIME 提交时间，ISO 字符串（与 TIMETABLE / USER.registertime 的写法一致）
--
-- 索引说明：idx_report_tid 用于「按时刻表查它的所有报告」这一最常见的查询方向。

CREATE TABLE IF NOT EXISTS TIMETABLE_REPORT (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  TID TEXT NOT NULL,
  EMAIL TEXT NOT NULL,
  CONTENT TEXT NOT NULL,
  STATUS TEXT NOT NULL DEFAULT 'open',
  WRITETIME TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_tid ON TIMETABLE_REPORT (TID);
