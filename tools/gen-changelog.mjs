// tools/gen-changelog.mjs
/**
 * 把 git 历史里 feat 提交导出成前端可直接 fetch 的静态 JSON。
 *
 * 用法：
 *   node tools/gen-changelog.mjs                 # 直接读当前仓库的 git log
 *   node tools/gen-changelog.mjs --input a.txt   # 解析已有的 `hash|date|subject` 文本
 *
 * 为什么走临时文件而不是管道：本环境的沙箱禁止命名管道，capture 子进程输出
 * （execSync / spawn 且 stdio 为 pipe）会以 EPERM 失败，所以把 git 的 stdout
 * 直接绑到临时文件的 fd 上，读回来再解析。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 默认写契约路径；MLTTC_CHANGELOG_OUT 只是给「当前目录不可写」的沙箱留的自检出口
const OUT_FILE = path.resolve(REPO_ROOT, process.env.MLTTC_CHANGELOG_OUT || 'lib/data/changelog.json');
const VERSION_FILE = path.resolve(REPO_ROOT, 'src/version.js');

// 部署版本号只认源码里的 APP_VERSION：它和前端 JS 在同一次部署中一起下发，
// 不会像外部存储那样与真正跑着的代码各说各话（KV 停在旧值曾让两端都静默）。
const APP_VERSION_RE = /APP_VERSION\s*=\s*['"]([^'"]+)['"]/;

// 一行一条；解析时只切前两段，所以 subject 里出现 | 也不会错位
const GIT_ARGS = ['log', '--date=short', '--pretty=format:%h|%ad|%s'];
// feat: xxx / feat(scope): xxx（容忍全角冒号）
const FEAT_RE = /^feat(?:\([^)]*\))?[:：]\s*(.*)$/;
const SEP = '|';

/** 从 src/version.js 解析当前部署版本号；解析不到返回空串，由 main 打印告警 */
function readLatestVersion() {
  try {
    const m = fs.readFileSync(VERSION_FILE, 'utf8').match(APP_VERSION_RE);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/** 读当前仓库的 git log；stdout 落到临时文件避免管道 */
function readGitLog() {
  const tmp = path.join(os.tmpdir(), `mlttc-changelog-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(tmp, 'w');
  try {
    execFileSync('git', GIT_ARGS, {
      cwd: REPO_ROOT,
      stdio: ['ignore', fd, 'inherit'],
    });
  } finally {
    fs.closeSync(fd);
  }
  try {
    return fs.readFileSync(tmp, 'utf8');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 解析一行一条的 `hash|date|subject` 文本 */
function parseLog(text) {
  const entries = [];
  let featCount = 0;
  let malformed = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const first = line.indexOf(SEP);
    const second = first < 0 ? -1 : line.indexOf(SEP, first + 1);
    if (second < 0) { malformed++; continue; }

    const hash = line.slice(0, first).trim();
    const date = line.slice(first + 1, second).trim();
    const subject = line.slice(second + 1).trim();

    if (!subject.startsWith('feat')) continue; // 只收 feat 提交
    featCount++;

    const m = subject.match(FEAT_RE);
    if (!m || !hash || !date) { malformed++; continue; }
    entries.push({ hash, date, subject: m[1].trim() });
  }

  // git log 本身新→旧；稳定排序让 --input 传入的乱序文本也满足「从新到旧」契约
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { entries, featCount, malformed };
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--input');
  const inputFile = i >= 0 ? argv[i + 1] : '';
  if (i >= 0 && !inputFile) {
    console.error('用法：node tools/gen-changelog.mjs [--input <文件>]');
    process.exit(1);
  }

  const text = inputFile
    ? fs.readFileSync(path.resolve(process.cwd(), inputFile), 'utf8')
    : readGitLog();

  const { entries, featCount, malformed } = parseLog(text);
  const latestVersion = readLatestVersion();
  // latestVersion 排在最前：它是前端判断「有新版本」的唯一依据，和展示用的 entries 分开
  const payload = {
    latestVersion,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`[changelog] 来源：${inputFile ? inputFile : 'git log'}`);
  console.log(`[changelog] latestVersion：${latestVersion || '（解析失败，请检查 src/version.js）'}`);
  console.log(`[changelog] 收录 ${entries.length} 条 feat 提交（命中 feat 前缀 ${featCount} 条，无法解析 ${malformed} 条）`);
  console.log(`[changelog] 最新日期：${entries.length ? entries[0].date : '（无）'}`);
  console.log(`[changelog] 输出：${path.relative(REPO_ROOT, OUT_FILE)}`);
  if (malformed) console.warn(`[changelog] 警告：有 ${malformed} 行不符合 hash|date|subject 或 feat 前缀格式，已跳过`);
}

main();
