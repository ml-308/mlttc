// tools/gen-changelog.mjs
/**
 * 生成前端可直接 fetch 的更新日志快照（lib/data/changelog.json）。
 *
 * 数据来源：
 *   1. CHANGELOG.md —— 发版记录的唯一真相源（版本 / 日期 / 分组条目）；
 *   2. git log —— 只取 feat 提交，用来补「按版本记录之前」的历史，
 *      并作为缓存着旧版页面的客户端的兼容回退。
 *
 * 用法：
 *   node tools/gen-changelog.mjs                 # 读 CHANGELOG.md + 当前仓库的 git log
 *   node tools/gen-changelog.mjs --input a.txt   # 用已有的 hash|date|subject 文本代替 git log
 *
 * 为什么走临时文件而不是管道：本环境的沙箱禁止命名管道，capture 子进程输出
 * （execSync / spawn 且 stdio 为 pipe）会以 EPERM 失败，所以把 git 的 stdout
 * 直接绑到临时文件的 fd 上，读回来再解析。git 不可用时不阻塞部署，只是历史段为空。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot, parseChangelog, parseGitLog } from './changelog-source.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 默认写契约路径；MLTTC_CHANGELOG_OUT 只是给「当前目录不可写」的沙箱留的自检出口
const OUT_FILE = path.resolve(REPO_ROOT, process.env.MLTTC_CHANGELOG_OUT || 'lib/data/changelog.json');
const VERSION_FILE = path.resolve(REPO_ROOT, 'src/version.js');
const CHANGELOG_FILE = path.resolve(REPO_ROOT, 'CHANGELOG.md');

// 部署版本号只认源码里的 APP_VERSION：它和前端 JS 在同一次部署中一起下发，
// 不会像外部存储那样与真正跑着的代码各说各话（KV 停在旧值曾让两端都静默）。
const APP_VERSION_RE = /APP_VERSION\s*=\s*['"]([^'"]+)['"]/;

// 一行一条；解析时只切前两段，所以 subject 里出现 | 也不会错位
const GIT_ARGS = ['log', '--date=short', '--pretty=format:%h|%ad|%s'];

/** 从 src/version.js 解析当前部署版本号；解析不到返回空串，由 main 打印告警 */
function readLatestVersion() {
  try {
    const m = fs.readFileSync(VERSION_FILE, 'utf8').match(APP_VERSION_RE);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/** 读当前仓库的 git log；stdout 落到临时文件避免管道；失败返回空串 */
function readGitLog() {
  const tmp = path.join(os.tmpdir(), `mlttc-changelog-${process.pid}-${Date.now()}.log`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      execFileSync('git', GIT_ARGS, {
        cwd: REPO_ROOT,
        stdio: ['ignore', fd, 'inherit'],
      });
    } finally {
      fs.closeSync(fd);
    }
    return fs.readFileSync(tmp, 'utf8');
  } catch (err) {
    console.warn('[changelog] 读取 git log 失败，早期提交记录留空：', err.message);
    return '';
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--input');
  const inputFile = i >= 0 ? argv[i + 1] : '';
  if (i >= 0 && !inputFile) {
    console.error('用法：node tools/gen-changelog.mjs [--input <文件>]');
    process.exit(1);
  }

  let markdown = '';
  try {
    markdown = fs.readFileSync(CHANGELOG_FILE, 'utf8');
  } catch (err) {
    console.error('[changelog] 读不到 CHANGELOG.md：', err.message);
    process.exit(1);
  }

  const releases = parseChangelog(markdown);
  if (releases.length === 0) {
    console.error('[changelog] CHANGELOG.md 里没有解析到任何版本标题（## [x.y.z] - 日期）');
    process.exit(1);
  }

  const gitText = inputFile
    ? fs.readFileSync(path.resolve(process.cwd(), inputFile), 'utf8')
    : readGitLog();
  const entries = parseGitLog(gitText);
  const latestVersion = readLatestVersion();

  const payload = buildSnapshot({ releases, entries, latestVersion });
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const newest = releases[0].version;
  const oldest = releases[releases.length - 1].version;
  console.log(`[changelog] 发版记录：${releases.length} 个版本（${newest} → ${oldest}）`);
  console.log(`[changelog] 快照版本：${latestVersion || '（解析失败，请检查 src/version.js）'}`);
  console.log(`[changelog] 早期提交：${payload.history.length} 条（来自 ${inputFile ? inputFile : 'git log'}，共命中 feat ${entries.length} 条）`);
  console.log(`[changelog] 输出：${path.relative(REPO_ROOT, OUT_FILE)}`);
  if (latestVersion && latestVersion !== newest) {
    console.warn(`[changelog] 警告：src/version.js 的 ${latestVersion} 与 CHANGELOG.md 最新版本 ${newest} 不一致`);
  }
}

main();
