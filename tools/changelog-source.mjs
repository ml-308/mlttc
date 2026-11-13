// tools/changelog-source.mjs
/**
 * 更新日志的数据源解析（构建期使用，纯函数、可单测）
 *
 * 设计背景：站点的更新日志页原来只收 git 的 feat: 提交，于是「纯修复」的发版
 * （例如 v1.3.0）永远不会出现，页面看起来「不全」。现在改为：
 *
 *   - CHANGELOG.md 是**发版记录的唯一真相源**，页面上的版本、日期、分组与条目都由它解析；
 *   - git 提交只用来补「1.2.7 之前还没按版本整理」的那段历史（页面底部的「更早的改动」）。
 *
 * 这样发版时只要写 CHANGELOG.md，页面就不会漏版本；提交前缀写得不对也不会再影响更新日志。
 *
 * 导出：
 *   parseChangelog(markdown) → releases[]
 *   parseGitLog(text)        → entries[]（只收 feat: 前缀）
 *   buildSnapshot({...})     → 写入 lib/data/changelog.json 的对象
 */

/** 版本标题：## [1.3.1] - 2026-11-13（日期允许非日期文本，如 1.2.6 的「之前」） */
const RELEASE_RE = /^##\s+\[([^\]]+)\]\s*-\s*(.+?)\s*$/;
/** 分组标题：### 🎨 界面 */
const SECTION_RE = /^###\s+(.+?)\s*$/;
/** 列表项：- 文本 */
const BULLET_RE = /^[-*]\s+(.*)$/;
/** 版本之间的分隔线 */
const RULE_RE = /^---\s*$/;
/** 只认 ISO 日期，用来算「早期提交」的分界线 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 中日韩文字与全角标点：续行拼接时两侧都是中文就不塞空格 */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** 把一条手写续行并回上一条：中文之间直接相连，英文/代码之间补一个空格 */
function joinContinuation(previous, next) {
  if (!previous) return next;
  const tail = previous.slice(-1);
  const head = next.slice(0, 1);
  return CJK_RE.test(tail) && CJK_RE.test(head) ? previous + next : previous + ' ' + next;
}

/**
 * 解析 CHANGELOG.md。
 * 返回按文件顺序（新 → 旧）排列的版本数组：
 *   { version, date, sections: [{ title, items: string[] }] }
 * 允许某个版本没有 ### 分组（如 1.2.6），此时条目落在 title 为空的分组里。
 */
export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;
  let itemIndex = -1;

  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();

    const releaseMatch = RELEASE_RE.exec(line);
    if (releaseMatch) {
      release = { version: releaseMatch[1].trim(), date: releaseMatch[2].trim(), sections: [] };
      releases.push(release);
      section = null;
      itemIndex = -1;
      continue;
    }

    // 文件头部（标题、说明段）不属于任何版本，直接跳过
    if (!release) continue;

    if (RULE_RE.test(line)) {
      section = null;
      itemIndex = -1;
      continue;
    }

    if (!line.trim()) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      section = { title: sectionMatch[1].trim(), items: [] };
      release.sections.push(section);
      itemIndex = -1;
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch) {
      if (!section) {
        section = { title: '', items: [] };
        release.sections.push(section);
      }
      section.items.push(bulletMatch[1].trim());
      itemIndex = section.items.length - 1;
      continue;
    }

    // 非结构行视为上一条的续行（CHANGELOG 里有手写换行）
    if (section && itemIndex >= 0) {
      section.items[itemIndex] = joinContinuation(section.items[itemIndex], line.trim());
    }
  }

  return releases;
}

/** feat: xxx / feat(scope): xxx（容忍全角冒号） */
const FEAT_RE = /^feat(?:\([^)]*\))?[:：]\s*(.*)$/;

/**
 * 解析 git log 的一行一条 `hash|date|subject` 文本（只收 feat 提交）。
 * 输入文本来自 git log --date=short --pretty=format:%h|%ad|%s。
 * 结果按日期从新到旧稳定排序。
 */
export function parseGitLog(text) {
  const entries = [];

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const first = line.indexOf('|');
    const second = first < 0 ? -1 : line.indexOf('|', first + 1);
    if (second < 0) continue;

    const hash = line.slice(0, first).trim();
    const date = line.slice(first + 1, second).trim();
    const subject = line.slice(second + 1).trim();
    if (!subject.startsWith('feat')) continue;

    const match = subject.match(FEAT_RE);
    if (!match || !hash || !date) continue;
    entries.push({ hash, date, subject: match[1].trim() });
  }

  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries;
}

/**
 * 组装最终快照。
 *   - releases：CHANGELOG.md 的发版记录（页面主体）
 *   - history：首个按版本记录的日期之前、还没被版本覆盖的提交（页面底部「更早的改动」）
 *   - entries：完整 feat 提交列表，留给缓存着旧版页面的客户端做兼容回退
 */
export function buildSnapshot({ releases = [], entries = [], latestVersion = '', generatedAt = new Date() } = {}) {
  const releaseList = Array.isArray(releases) ? releases : [];
  const commitList = Array.isArray(entries) ? entries : [];

  const releaseDates = releaseList
    .map((release) => String(release && release.date ? release.date : ''))
    .filter((date) => ISO_DATE_RE.test(date))
    .sort();
  const boundary = releaseDates[0] || '';
  const history = boundary
    ? commitList.filter((entry) => entry && ISO_DATE_RE.test(String(entry.date || '')) && entry.date < boundary)
    : [];

  return {
    latestVersion,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    count: releaseList.length,
    source: 'CHANGELOG.md',
    releases: releaseList,
    history,
    entries: commitList,
  };
}
