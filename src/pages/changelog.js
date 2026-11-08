// src/pages/changelog.js
/**
 * 更新日志页：读取构建期生成的静态快照并渲染列表
 *
 * 数据源：/lib/data/changelog.json
 *   { generatedAt, count, entries: [{ hash, date, subject }] }
 *   entries 已按时间从新到旧排好序、subject 已剥掉 feat: 前缀，前端只负责展示，
 *   不再二次排序或改写文案（顺序与内容以快照为准）。
 *
 * 容错：接口失败 / JSON 解析失败 / 无条目，都落回同一行友好提示，
 * 不抛未捕获错误，也不留空白区域。
 */

const DATA_URL = '/lib/data/changelog.json';

const SELECTORS = {
  list: '#changelogList',
  state: '#changelogState',
  meta: '#changelogMeta'
};

/** 展示占位提示（加载中 / 失败 / 空态共用一处） */
function showState(text) {
  const list = document.querySelector(SELECTORS.list);
  const state = document.querySelector(SELECTORS.state);
  if (list) list.hidden = true;
  if (state) {
    state.textContent = text;
    state.hidden = false;
  }
}

/** 生成一条日志的 DOM */
function entryNode(entry) {
  const li = document.createElement('li');
  li.className = 'changelog-item';

  const date = document.createElement('span');
  date.className = 'changelog-date';
  date.textContent = entry && entry.date ? String(entry.date) : '日期未知';

  const subject = document.createElement('span');
  subject.className = 'changelog-subject';
  subject.textContent = entry && entry.subject ? String(entry.subject) : '（无标题）';

  li.append(date, subject);

  // hash 只是溯源用的附加信息，缺失时整段省略，不影响排版
  if (entry && entry.hash) {
    const hash = document.createElement('code');
    hash.className = 'changelog-hash';
    hash.textContent = String(entry.hash);
    li.append(hash);
  }

  return li;
}

/** 只取 YYYY-MM-DD，避免不同浏览器对 ISO 字符串的本地时区换算把日期改掉一位 */
function dateOnly(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
  return m ? m[1] : '';
}

function renderMeta(json, shown) {
  const meta = document.querySelector(SELECTORS.meta);
  if (!meta) return;
  const generated = dateOnly(json.generatedAt);
  meta.textContent = generated
    ? `共 ${shown} 条记录　·　快照生成于 ${generated}`
    : `共 ${shown} 条记录`;
}

async function loadChangelog() {
  if (!document.querySelector(SELECTORS.list)) return; // 非本页

  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) {
      console.warn('[changelog] 读取更新日志失败，HTTP', res.status);
      showState('更新日志暂时无法读取，请稍后刷新重试。');
      return;
    }

    const json = await res.json();
    const entries = Array.isArray(json && json.entries) ? json.entries : [];
    if (entries.length === 0) {
      showState('还没有可展示的更新记录。');
      return;
    }

    const list = document.querySelector(SELECTORS.list);
    if (!list) return;
    list.replaceChildren(...entries.map(entryNode));
    list.hidden = false;

    const state = document.querySelector(SELECTORS.state);
    if (state) state.hidden = true;

    renderMeta(json, entries.length);
  } catch (e) {
    console.warn('[changelog] 读取更新日志出错：', e);
    showState('更新日志暂时无法读取，请稍后刷新重试。');
  }
}

document.addEventListener('DOMContentLoaded', loadChangelog);
