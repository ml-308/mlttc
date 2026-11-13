// src/pages/changelog.js
/**
 * 更新日志页：读取构建期生成的静态快照并渲染
 *
 * 数据源：/lib/data/changelog.json（由 tools/gen-changelog.mjs 从 CHANGELOG.md 生成）
 *   {
 *     generatedAt, count, latestVersion,
 *     releases: [{ version, date, sections: [{ title, items: [...] }] }],
 *     history:  [{ hash, date, subject }],
 *     entries:  [{ hash, date, subject }]
 *   }
 *   - releases：CHANGELOG.md 的发版记录，页面主体（不再只认 feat 提交，纯修复版本也不会漏）；
 *   - history：首个按版本记录的日期之前的提交，渲染在页面底部「更早的改动」；
 *   - entries：旧快照字段，仅在 releases 缺失时用于兼容回退。
 *
 * 容错：接口失败 / JSON 解析失败 / 无条目，都落回同一行友好提示，
 * 不抛未捕获错误，也不留空白区域。所有内容走 textContent 拼装，不解析 HTML。
 */

const DATA_URL = '/lib/data/changelog.json';

const SELECTORS = {
  list: '#changelogList',
  history: '#changelogHistory',
  state: '#changelogState',
  meta: '#changelogMeta'
};

/** 展示占位提示（加载中 / 失败 / 空态共用一处） */
function showState(text) {
  const list = document.querySelector(SELECTORS.list);
  const history = document.querySelector(SELECTORS.history);
  const state = document.querySelector(SELECTORS.state);
  if (list) list.hidden = true;
  if (history) history.hidden = true;
  if (state) {
    state.textContent = text;
    state.hidden = false;
  }
}

/**
 * 把 CHANGELOG 里的轻量行内标记（**粗体**、`代码`、[文字](链接)）渲染成 DOM。
 * 全部用 createElement / textContent 拼，任何内容都不会被当成 HTML 执行。
 */
function appendInline(parent, text) {
  const source = String(text ?? '');
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(source.slice(lastIndex, match.index)));
    }

    const bold = match[1];
    const code = match[2];
    const linkLabel = match[3];
    const linkHref = match[4];

    if (bold !== undefined) {
      const el = document.createElement('strong');
      // 粗体里可能还嵌着 `代码`（CHANGELOG 里就有），递归解析一次
      appendInline(el, bold);
      parent.append(el);
    } else if (code !== undefined) {
      const el = document.createElement('code');
      el.textContent = code;
      parent.append(el);
    } else if (linkLabel !== undefined && /^(https?:\/\/|\/)/i.test(linkHref)) {
      const a = document.createElement('a');
      a.href = linkHref;
      a.textContent = linkLabel;
      if (/^https?:/i.test(linkHref)) {
        a.target = '_blank';
        a.rel = 'noopener';
      }
      parent.append(a);
    } else {
      parent.append(document.createTextNode(linkLabel !== undefined ? linkLabel : match[0]));
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    parent.append(document.createTextNode(source.slice(lastIndex)));
  }
}

/** 生成一条日志的 DOM（早期提交与旧快照兼容回退共用） */
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

/** 一条发版记录：版本 / 最新标记 / 日期 + 各分组条目 */
function releaseNode(release, isLatest) {
  const li = document.createElement('li');
  li.className = 'changelog-release';

  const head = document.createElement('header');
  head.className = 'changelog-release-head';

  const version = document.createElement('span');
  version.className = 'changelog-version';
  version.textContent = 'v' + (release.version || '');
  head.append(version);

  if (isLatest) {
    const badge = document.createElement('span');
    badge.className = 'changelog-latest';
    badge.textContent = '最新';
    head.append(badge);
  }

  if (release.date) {
    const date = document.createElement('span');
    date.className = 'changelog-release-date';
    date.textContent = String(release.date);
    head.append(date);
  }

  li.append(head);

  const sections = Array.isArray(release.sections) ? release.sections : [];
  for (const section of sections) {
    const items = Array.isArray(section && section.items) ? section.items : [];
    if (items.length === 0) continue;

    const wrap = document.createElement('section');
    wrap.className = 'changelog-section';

    if (section.title) {
      const title = document.createElement('h3');
      title.className = 'changelog-section-title';
      title.textContent = String(section.title);
      wrap.append(title);
    }

    const points = document.createElement('ul');
    points.className = 'changelog-points';
    for (const item of items) {
      const point = document.createElement('li');
      appendInline(point, item);
      points.append(point);
    }

    wrap.append(points);
    li.append(wrap);
  }

  return li;
}

/** 早期提交：按版本记录之前的那段历史，沿用「日期 + 一句话 + hash」的扁平样式 */
function historyNode(entries) {
  const section = document.createElement('section');
  section.className = 'changelog-history';

  const title = document.createElement('h2');
  title.className = 'changelog-history-title';
  title.textContent = '更早的改动';

  const hint = document.createElement('p');
  hint.className = 'changelog-history-hint';
  hint.textContent = '这些改动发生在按版本整理更新日志之前，按时间倒序列在这里。';

  const list = document.createElement('ol');
  list.className = 'changelog-history-list';
  for (const entry of entries) {
    list.append(entryNode(entry));
  }

  section.append(title, hint, list);
  return section;
}

/** 只取 YYYY-MM-DD，避免不同浏览器对 ISO 字符串的本地时区换算把日期改掉一位 */
function dateOnly(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
  return m ? m[1] : '';
}

function renderMeta(text) {
  const meta = document.querySelector(SELECTORS.meta);
  if (meta) meta.textContent = text;
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
    const releases = Array.isArray(json && json.releases) ? json.releases : [];
    const history = Array.isArray(json && json.history) ? json.history : [];
    const entries = Array.isArray(json && json.entries) ? json.entries : [];

    if (releases.length === 0 && entries.length === 0) {
      showState('还没有可展示的更新记录。');
      return;
    }

    const list = document.querySelector(SELECTORS.list);
    if (!list) return;

    // 正常路径：发版记录。回退：缓存里的旧快照只有 entries
    if (releases.length > 0) {
      list.replaceChildren(...releases.map((release, index) => releaseNode(release, index === 0)));
    } else {
      list.replaceChildren(...entries.map(entryNode));
    }
    list.hidden = false;

    const historyEl = document.querySelector(SELECTORS.history);
    if (historyEl && releases.length > 0 && history.length > 0) {
      historyEl.replaceChildren(historyNode(history));
      historyEl.hidden = false;
    }

    const state = document.querySelector(SELECTORS.state);
    if (state) state.hidden = true;

    const generated = dateOnly(json && json.generatedAt);
    const countText = releases.length > 0
      ? '共 ' + releases.length + ' 个版本'
      : '共 ' + entries.length + ' 条记录';
    renderMeta(generated ? countText + '　·　快照生成于 ' + generated : countText);
  } catch (e) {
    console.warn('[changelog] 读取更新日志出错：', e);
    showState('更新日志暂时无法读取，请稍后刷新重试。');
  }
}

document.addEventListener('DOMContentLoaded', loadChangelog);
