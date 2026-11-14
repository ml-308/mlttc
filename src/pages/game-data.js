// src/pages/game-data.js
/**
 * 站点「游戏数据」清理（tools.html 使用）
 *
 * 为什么单独做一个模块：站内小游戏把成绩与进度存在 localStorage 里，
 * 分散在三种键名体系下（贪吃蛇 snake_best_score、走迷宫 maze-best-<格子数>、
 * 塔防 mlttc-td-progress / 旧键 mlttc-td-best）。用户想清掉它们时，
 * 不该去浏览器设置里手动逐条删，也不该被"清理"顺手带走站点设置。
 *
 * 安全边界（本模块最重要的约束）：
 *   · 只清「白名单里的游戏键」，绝不按前缀批量删。
 *     塔防的 mlttc-td-progress 用的是 mlttc- 前缀，和站点设置
 *     （mlttc-theme / mlttc-accent / mlttc_consent / mlttc-login-consent /
 *      mlttc-login-remember / mlttc-seen-version / mlttc-auth-checked）
 *     共用前缀 —— 一旦按前缀删，就会把主题、同意记录、已读版本一起清掉。
 *   · 账号登录态在 Cookie 里、时刻表在服务端，均不受影响；
 *     个人主页的时刻表列表缓存（my_timetable_cache）也不在本模块范围内。
 *
 * 依赖：/lib/ui/popup.mjs（showConfirm）、/lib/ui/message.mjs（showMessage）
 */
import { showConfirm } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';

/** 固定键：贪吃蛇最高分、塔防进度、塔防旧键（旧键只在迁移期出现） */
const FIXED_KEYS = {
  snake: 'snake_best_score',
  tower: 'mlttc-td-progress',
  towerLegacy: 'mlttc-td-best',
};

/** 动态键前缀：走迷宫按格子数各存一条，如 maze-best-20 */
const MAZE_PREFIX = 'maze-best-';

/** tools.html 里对应的容器 id */
const LIST_ID = 'gameDataList';
const BTN_ID = 'clearGameDataBtn';

/**
 * 收集当前浏览器里的全部游戏数据键。
 * 遍历 localStorage 而不是逐个猜键名 —— 走迷宫的键随格子数变化，猜不全。
 *
 * @returns {{ keys: string[], mazeKeys: string[] }} keys 为待删除的全部键
 */
function collectGameKeys() {
  const keys = [];
  const mazeKeys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key === FIXED_KEYS.snake || key === FIXED_KEYS.tower || key === FIXED_KEYS.towerLegacy) {
        keys.push(key);
      } else if (key.indexOf(MAZE_PREFIX) === 0) {
        keys.push(key);
        mazeKeys.push(key);
      }
    }
  } catch (err) {
    // 隐私模式 / 存储被禁用：当作没有任何游戏数据，绝不抛给用户
    console.warn('[game-data] 读取 localStorage 失败：', err);
  }
  return { keys, mazeKeys };
}

/** 生成一个元素，文本一律走 textContent（键名里含用户可控内容时也不怕） */
function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text == null ? '' : String(text);
  return el;
}

/** 读一个键的原始值，失败返回 null */
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 把塔防存档摘要成一行人类可读的文字 */
function describeTowerProgress(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const parts = [];
    const unlocked = Number(obj.unlocked);
    if (Number.isFinite(unlocked) && unlocked > 1) parts.push(`闯关已解锁至第 ${unlocked} 关`);
    const bestWaves = Object.values(obj.levelBest || {}).reduce(
      (max, v) => (Number(v) > max ? Number(v) : max),
      0
    );
    if (bestWaves > 0) parts.push(`闯关最佳 ${bestWaves} 波`);
    const endless = Number(obj.endlessBest);
    if (Number.isFinite(endless) && endless > 0) parts.push(`无尽最高第 ${endless} 波`);
    if (obj.endlessRun && typeof obj.endlessRun === 'object') {
      parts.push(`有未完成的无尽局（第 ${Number(obj.endlessRun.wave) || 1} 波）`);
    }
    return parts.length ? parts.join(' · ') : null;
  } catch {
    return null;
  }
}

/** 渲染「检测到的游戏数据」清单；没有任何数据时给出明确的空态 */
function renderList() {
  const list = document.getElementById(LIST_ID);
  if (!list) return;
  list.innerHTML = '';

  const { keys, mazeKeys } = collectGameKeys();
  if (!keys.length) {
    list.appendChild(makeEl('p', 'game-data-empty', '当前浏览器没有保存任何游戏数据。'));
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'game-data-items';

  const snake = read(FIXED_KEYS.snake);
  if (snake !== null) {
    ul.appendChild(makeEl('li', null, `贪吃蛇：最高分 ${snake}`));
  }

  if (mazeKeys.length) {
    // 只报条数与尺寸，不逐条铺满界面
    const sizes = mazeKeys
      .map((k) => k.slice(MAZE_PREFIX.length))
      .filter(Boolean)
      .sort((a, b) => Number(a) - Number(b));
    ul.appendChild(makeEl('li', null, `走迷宫：${mazeKeys.length} 个尺寸有最佳成绩（${sizes.join('/')} 格）`));
  }

  const tower = describeTowerProgress(read(FIXED_KEYS.tower));
  if (tower) ul.appendChild(makeEl('li', null, `塔防：${tower}`));
  else if (read(FIXED_KEYS.tower) !== null) ul.appendChild(makeEl('li', null, '塔防：有一份进度存档'));

  if (read(FIXED_KEYS.towerLegacy) !== null) {
    ul.appendChild(makeEl('li', null, '塔防：存在旧版存档键（会在下次打开游戏时自动迁移）'));
  }

  list.appendChild(ul);
}

/** 删除所有游戏数据键，返回实际删掉的条数 */
function clearGameKeys() {
  const { keys } = collectGameKeys();
  let removed = 0;
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
      removed += 1;
    } catch (err) {
      console.warn('[game-data] 删除失败：', key, err);
    }
  }
  return removed;
}

/** 点「清除游戏数据」：先确认、再删除、最后反馈并刷新清单 */
async function onClearClick() {
  const { keys, mazeKeys } = collectGameKeys();
  if (!keys.length) {
    showMessage('当前没有可清除的游戏数据', false);
    return;
  }

  // 确认弹窗里把「会删什么、不会动什么」都写清楚。
  // 只列**实际存在**的项：否则会出现「将清除贪吃蛇最高分」但其实没有这条数据，
  // 让人以为清错了东西。文案不依赖换行（弹窗对 \n 的处理不确定）。
  const what = [];
  if (read(FIXED_KEYS.snake) !== null) what.push('贪吃蛇最高分');
  if (mazeKeys.length) what.push(`走迷宫最佳成绩（${mazeKeys.length} 项）`);
  if (read(FIXED_KEYS.tower) !== null) what.push('塔防进度与存档（含未完成的无尽局）');
  if (read(FIXED_KEYS.towerLegacy) !== null) what.push('塔防旧版存档');

  const index = await showConfirm({
    eyebrow: '清除游戏数据',
    title: '确定要清除吗？',
    text:
      `将清除 ${keys.length} 项游戏数据：${what.join('；')}。` +
      '账号登录、时刻表数据、主题与同意记录不受影响。此操作不可撤销。',
    buttons: ['确定清除', '取消'],
    button_style: ['variant=danger', 'tp']
  });
  // showConfirm 返回倒序索引：buttons 为 ['确定清除','取消'] 时，确定 = 1
  if (index !== 1) return;

  const removed = clearGameKeys();
  renderList();
  showMessage(removed > 0 ? `已清除 ${removed} 项游戏数据` : '清除失败，请检查浏览器存储权限', removed === 0);
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById(BTN_ID);
  if (!btn) return; // 非 tools.html 页面，静默退出
  renderList();
  btn.addEventListener('click', onClearClick);
});
