// ─── 时刻表详情页（唯一入口）────────────────────────
//
// 页面实现见 /lib/ui/timetable-detail.mjs。
// 返回按钮的去向与文案由 URL 上的 ?from= 决定：
//   ?from=account → 返回个人主页；缺省 → 返回时刻表列表
import { createTimetableDetailPage } from '/lib/ui/timetable-detail.mjs';

createTimetableDetailPage();
