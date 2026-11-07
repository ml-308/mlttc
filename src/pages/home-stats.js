// src/pages/home-stats.js
/**
 * 首页「数据速览」——走专用统计接口
 *
 * 数据源：GET /api/stats
 *   返回 { success, lines(线路数), cities(城市数), updated(最后更新时间) }
 *   后端用独立统计表 SITE_STATS 维护（首次惰性初始化，之后增删增量 +1/-1），
 *   不在前端做全量 list=all 计算。
 *
 * 容错：接口失败 / 数据缺失时，隐藏整个速览区，不展示「—」占位。
 */
const STAT_SELECTORS = {
  grid: '#statGrid',
  lines: '#statLines',
  cities: '#statCities',
  updated: '#statUpdated'
};

/** 隐藏整个速览区（数据不可用时优雅降级） */
function hideStats() {
  const grid = document.querySelector(STAT_SELECTORS.grid);
  if (grid) grid.style.display = 'none';
}

/** 把 ISO 时间戳格式化为「YYYY-MM-DD」 */
function formatDate(iso) {
  if (!iso) return '持续补充中';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '持续补充中';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 填充数值 */
function renderStats(lines, cities, updated) {
  const elLines = document.querySelector(STAT_SELECTORS.lines);
  const elCities = document.querySelector(STAT_SELECTORS.cities);
  const elUpdated = document.querySelector(STAT_SELECTORS.updated);
  if (elLines) elLines.textContent = String(lines);
  if (elCities) elCities.textContent = String(cities);
  if (elUpdated) elUpdated.textContent = formatDate(updated);
}

async function loadStats() {
  const grid = document.querySelector(STAT_SELECTORS.grid);
  if (!grid) return; // 非首页，无速览区

  try {
    const res = await fetch('/api/stats', { credentials: 'include' });
    if (!res.ok) { hideStats(); return; }

    const json = await res.json();
    if (!json || !json.success) { hideStats(); return; }

    const lines = Number(json.lines) || 0;
    const cities = Number(json.cities) || 0;
    if (lines <= 0 && cities <= 0) { hideStats(); return; }

    renderStats(lines, cities, json.updated);
  } catch (e) {
    console.warn('[home-stats] 获取统计失败：', e);
    hideStats();
  }
}

document.addEventListener('DOMContentLoaded', loadStats);
