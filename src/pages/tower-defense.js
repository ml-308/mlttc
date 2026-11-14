/**
 * tower-defense.js —— 塔防引擎核心（第 1 步：无尽模式，零依赖 ES module）
 * ---------------------------------------------------------------------------
 * 用途：给 tower-defense.html 提供全部游戏逻辑（地图/波次/塔/敌人/战斗/渲染/输入/HUD）；
 *   不 import 任何站点模块，Node 下 import 只会拿到纯函数，不碰 DOM。
 * 模式：只有「无尽」——波次由 generateEndlessWave(n) 现算，没有逐波写死的数量表，
 *   每 10 波一个 BOSS 波；闯关模式 / 关卡选择 / tools.html 入口留给第二步。
 * 数据结构：
 *   state      唯一可变状态（波次 / 生命 / 金币 / 击杀 / 实体数组）
 *   enemies[]  { type, hp, maxHp, speed, armor, bounty, dist, slowUntil, slowFactor, x, y }
 *              dist = 沿路径的像素进度，越大越靠前 → 「最靠前的敌人」= dist 最大
 *   towers[]   { type, lv, col, row, x, y, cd, rateBuff, dmgBuff, spend }
 *   bullets[]  对象池复用 { x, y, tx, ty, target, dmg, splash, slow, speed, color }
 *   path       { pts, segs, length } 折线路径；敌人只存 dist，坐标靠插值算出
 * 主循环节奏：rAF 只负责「采样时间 + 渲染」，逻辑固定 1/60 s 步长——累积器
 *   acc += dt × 倍速，while (acc >= STEP) 步进，单帧最多追 5 步（切后台不暴走）；
 *   页面隐藏时暂停累积。倍速只加快累积，不改渲染帧率。
 */

/* ===================== 1. 常量区（调数值只改这里） ===================== */
const GRID = { cols: 24, rows: 14, tile: 32 };          // 24×14 格、每格 32px
const VIEW = { w: GRID.cols * GRID.tile, h: GRID.rows * GRID.tile };  // 逻辑画布 768×448

/** 敌人基础数值（波次里再乘 hp / speed / gold 倍率） */
const ENEMY_TYPES = {
  basic: { name: '步兵', hp: 40, speed: 55, armor: 0, bounty: 6 },
  swift: { name: '快兵', hp: 45, speed: 95, armor: 0, bounty: 5 },
  armor: { name: '重甲', hp: 110, speed: 40, armor: 0.25, bounty: 14 },
  shield: { name: '盾兵', hp: 160, speed: 35, armor: 0.35, bounty: 22 },
  boss: { name: 'BOSS', hp: 600, speed: 32, armor: 0.35, bounty: 80 },
};

/** 4 种塔 × 3 级：数组下标 = 等级-1；cost[0] 是建造价、cost[lv] 是升级价 */
const TOWER_TYPES = {
  arrow: { name: '箭塔', cost: [60, 120, 220], dmg: [8, 14, 24], rate: [1.6, 1.9, 2.2], range: [110, 120, 130], color: '#1DB954' },
  cannon: { name: '炮塔', cost: [110, 200, 340], dmg: [22, 38, 62], rate: [0.6, 0.7, 0.8], range: [130, 140, 150], splash: [45, 55, 65], color: '#E8A33D' },
  frost: { name: '冰塔', cost: [90, 160, 280], dmg: [4, 6, 8], rate: [0.8, 0.9, 1.0], range: [110, 120, 130], slow: [0.35, 0.45, 0.55], slowMs: [1200, 1500, 1800], color: '#4CC9F0' },
  aura: { name: '光环塔', cost: [130, 180, 300], range: [120, 140, 160], auraRate: [0.15, 0.25, 0.35], auraDmg: [0, 0, 0.15], color: '#B693FD' },
};

/** 全局平衡参数 */
const BALANCE = {
  startGold: 150, startLives: 20,
  sellRatio: 0.6,          // 出售返还「总投入」的 60%
  waveGapMs: 2500,         // 波与波之间的喘息
  maxEnemiesPerWave: 400,  // 软上限，防掉帧（触顶后靠血量与速度继续施压）
};

const STEP = 1 / 60;                  // 固定逻辑步长
const MAX_STEPS_PER_FRAME = 5;        // 单帧最多补偿 5 步
const BEST_KEY = 'mlttc-td-best';     // 最高波数存档键
const DEFAULT_SEED = 'mlttc-td-demo'; // 自检脚本用的固定种子
/* ===================== 2. 无尽波次生成器 ===================== */
/** 字符串 → uint32（FNV-1a 变体）：让波次可复现，调试与第二步自检都靠它 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/** mulberry32：32 位状态的小 PRNG，快、无依赖、同种子同序列 */
function mulberry32(a) {
  let t = a >>> 0;
  return function random() {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * 无尽波次生成器。设计取舍（为什么这么取）：
 *  · total = 6 + 1.5n + 0.05n²：一次项让每波略增，二次项让后期「成群」；数量涨得
 *    比血量慢，压力来自血量而不是帧率；再套 maxEnemiesPerWave 软上限。
 *  · 权重漂移：basic 恒为 1（保证场面不空），swift 第 4 波、armor 第 9 波、shield
 *    第 18 波解锁，权重随 n 线性上升 → 每解锁一档都「换味」，不是一次把池子倒完。
 *  · 拆组：按权重向下取整、每组至少 1（避免某档解锁后长期 0 只），向下取整的余数
 *    补给权重最大的组，使各组计数之和严格等于 total。
 *  · hpMul = 1.06^(n-1)（约 12 波翻倍，与塔的攻击成长同量级）；spdMul 封顶 2.2（再快玩家
 *    来不及反应）；goldMul = 1.10^(n-1) 略低于血量增速，制造后期金币紧张。
 *  · spawnGap 从 1.15s 收到 0.22s 封顶，只压缩到 1/5，防止后期一帧刷出整波。
 *  · BOSS 波 n%10===0：额外插入 1+floor(n/25) 只 BOSS（血量 ×8、速度 ×0.85），
 *    不计入 total → 实际出场数 = total + bossCount。
 */
function generateEndlessWave(n, seed) {
  // 每波独立随机流：第 n 波的组成只由 (n, seed) 决定，与前面的波无关
  const rng = mulberry32(hashSeed('endless:' + n + ':' + seed));

  let total = 6 + Math.floor(1.5 * n + 0.05 * n * n);
  total = Math.min(total, BALANCE.maxEnemiesPerWave);

  // 种类池：解锁条件 + 权重漂移（basic 恒有权重 1）
  const pool = [{ type: 'basic', w: 1 }];
  if (n >= 4) pool.push({ type: 'swift', w: 0.35 + 0.01 * n });
  if (n >= 9) pool.push({ type: 'armor', w: 0.20 + 0.012 * n });
  if (n >= 18) pool.push({ type: 'shield', w: 0.05 + 0.008 * n });

  // 按权重拆组：先向下取整并保证每组 ≥1，再把余数补给权重最大的组
  const sumW = pool.reduce((s, p) => s + p.w, 0);
  const counts = pool.map((p) => Math.max(1, Math.floor((total * p.w) / sumW)));
  const assigned = counts.reduce((s, c) => s + c, 0);
  let topIdx = 0;
  for (let i = 1; i < pool.length; i++) if (pool[i].w > pool[topIdx].w) topIdx = i;
  counts[topIdx] += total - assigned;
  if (counts[topIdx] < 1) counts[topIdx] = 1;   // 兜底：极端权重下别出现 0 或负数

  // 血量增长：1.06^(n-1) 约 12 波翻倍。原来取 1.155（4.6 波翻倍）实测第 30 波就要 1.6 万
  // DPS，而满配塔阵只能到 2 千上下 —— 等于 30 波左右必死，数值上不可行。
  const hpMul = Math.pow(1.06, n - 1);
  const spdMul = Math.min(2.2, 1 + 0.012 * (n - 1));
  // 赏金增长：1.05^(n-1)。与血量曲线同量级，避免后期钱多到没处花。
  const goldMul = Math.pow(1.05, n - 1);

  const groups = pool.map((p, i) => {
    const base = ENEMY_TYPES[p.type];
    return {
      type: p.type, count: counts[i],
      hp: Math.max(1, Math.round(base.hp * hpMul)),
      speed: base.speed * spdMul,
      bounty: Math.max(1, Math.round(base.bounty * goldMul)),
      armor: base.armor,
    };
  });

  // BOSS 波：额外插入，不占 total
  const isBossWave = n % 10 === 0;
  let bossCount = 0;
  if (isBossWave) {
    bossCount = 1 + Math.floor(n / 25);
    const b = ENEMY_TYPES.boss;
    groups.push({
      type: 'boss', count: bossCount,
      hp: Math.max(1, Math.round(b.hp * hpMul * 8)),
      speed: b.speed * spdMul * 0.85,
      bounty: Math.max(1, Math.round(b.bounty * goldMul)),
      armor: b.armor,
    });
  }

  // 出场间隔（ms）：每波 -15ms，钳在 [220, 1150]
  const spawnGap = Math.max(0.22, Math.min(1.15, 1.15 - 0.015 * n)) * 1000;
  void rng;   // 随机流保留给第二步做组内出场抖动
  return { n, total, bossCount, groups, spawnGap, isBossWave };
}
/**
 * 波次曲线自检：返回 [{ wave, total, hp }]（hp = 该波第一个组的血量）。
 * 不含任何 DOM 代码，`node --input-type=module -e "import(...)"` 可直接调。
 */
export function debugWaveCurve(waves) {
  return (waves || []).map((n) => {
    const w = generateEndlessWave(n, DEFAULT_SEED);
    return { wave: w.n, total: w.total, hp: w.groups[0].hp };
  });
}

/* ===================== 3. 地图与路径 ===================== */
/**
 * 路点模板：每张是折线拐点数组（单位＝格）。第一个点 x = -1 表示从左侧画布外进入，
 * 最后一个 x = cols 表示从右侧外离开。本步实现前 3 张，无尽模式固定用第 1 张（换图会
 * 作废已建的塔，属关卡概念，留给第二步）；第 4~6 张按同一格式追加即可。
 */
const MAP_TEMPLATES = [
  [[-1, 2], [6, 2], [6, 9], [18, 9], [18, 4], [24, 4]],                              // 1 长廊
  [[-1, 11], [4, 11], [4, 4], [10, 4], [10, 11], [16, 11], [16, 6], [24, 6]],        // 2 蛇形
  [[-1, 7], [8, 7], [8, 2], [16, 2], [16, 10], [22, 10], [22, 6], [24, 6]],          // 3 阶梯
];

/** 格坐标路点 → 像素路点 + 累计长度线段表（敌人只记 dist，索敌不用排序） */
function buildPath(points) {
  const pts = points.map(([gx, gy]) => ({ x: (gx + 0.5) * GRID.tile, y: (gy + 0.5) * GRID.tile }));
  const segs = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len, start: acc });
    acc += len;
  }
  return { pts, segs, length: acc };
}

/** 路径进度 dist 处的像素坐标（越界自动夹到两端） */
function pointAt(path, dist) {
  const segs = path.segs;
  if (!segs.length) return { x: 0, y: 0 };
  const d = dist < 0 ? 0 : dist > path.length ? path.length : dist;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (d <= s.start + s.len) {
      const t = s.len > 0 ? (d - s.start) / s.len : 0;
      return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
    }
  }
  const last = segs[segs.length - 1];
  return { x: last.b.x, y: last.b.y };
}

/** 折线覆盖到的格子（"x,y" 键）→ 不可建造的路径带（宽 1 格） */
function buildPathTiles(points) {
  const set = new Set();
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1);
    let x = x1, y = y1;
    set.add(x + ',' + y);
    while (x !== x2 || y !== y2) { x += dx; y += dy; set.add(x + ',' + y); }
  }
  return set;
}

/** 可建造 = 在网格内且不在路径带上；towerAt = 该格已有的塔（没有则 null） */
function isBuildable(st, col, row) {
  if (col < 0 || row < 0 || col >= GRID.cols || row >= GRID.rows) return false;
  return !st.pathTiles.has(col + ',' + row);
}
function towerAt(st, col, row) {
  for (let i = 0; i < st.towers.length; i++) {
    const t = st.towers[i];
    if (t.col === col && t.row === row) return t;
  }
  return null;
}

/* 对外导出：给第二步的自检脚本与调试台用（纯函数，无副作用） */
export {
  GRID, VIEW, ENEMY_TYPES, TOWER_TYPES, BALANCE, MAP_TEMPLATES,
  hashSeed, mulberry32, generateEndlessWave, buildPath, buildPathTiles,
};

/* ===================== 4. 运行时状态 ===================== */
/**
 * 唯一可变状态。实体数组一律「就地删除 / 池化复用」，不给 GC 留垃圾：enemies 反向
 * 遍历 + swap-remove；bullets 命中即回收进 bulletPool；粒子/飘字同理。
 */
const state = {
  seed: DEFAULT_SEED, wave: 0, lives: BALANCE.startLives, gold: BALANCE.startGold,
  kills: 0, best: 0,
  waveActive: false, nextWaveIn: 0,      // 当前波是否在打 / 下一波倒计时（ms）
  spawnQueue: [], spawnIdx: 0,           // 本波出场队列（元素是 group 引用）+ 消费下标
  spawnGap: 1000, spawnTimer: 0, waveStats: null,
  paused: false, hidden: false, speed: 1, gameOver: false, timeMs: 0,
  selectedType: null, selectedTower: null, hover: { col: -1, row: -1 }, reducedMotion: false,
  enemies: [], towers: [], bullets: [], particles: [], floaters: [],
  mapIdx: 0, path: null, pathTiles: null,
};
const bulletPool = [];   // 子弹对象池：复用对象，避免每发都新建

/** 敌人配色与半径（canvas 2D 用不了 CSS 变量，按类型固定） */
const ENEMY_COLORS = { basic: '#8f8f8f', swift: '#4CC9F0', armor: '#E8A33D', shield: '#B693FD', boss: '#D93025' };
const ENEMY_RADIUS = { basic: 8, swift: 7, armor: 10, shield: 11, boss: 15 };

/** 画布调色板：从站点 CSS 变量读，主题切换时重读 */
const palette = {
  bg: '#ffffff', grid: '#ececec', path: '#f2f2f2', edge: '#d9d9d9', text: '#111111',
  muted: '#535353', card: '#ffffff', primary: '#1db954', danger: '#d93025', warning: '#e8900a',
  ok: 'rgba(29,185,84,.18)', bad: 'rgba(217,48,37,.16)',
};

/* ===================== 5. 局内流程 ===================== */
/** 开局 / 重开：清空一切，回到「准备第 1 波」 */
function resetGame() {
  state.seed = 'run-' + (Date.now() % 1000000);
  state.wave = 0; state.lives = BALANCE.startLives; state.gold = BALANCE.startGold;
  state.kills = 0; state.waveActive = false; state.nextWaveIn = 1800;
  state.spawnQueue = []; state.spawnIdx = 0; state.spawnTimer = 0; state.waveStats = null;
  state.paused = false; state.speed = 1; state.gameOver = false; state.timeMs = 0;
  state.selectedType = null; state.selectedTower = null;
  state.hover.col = -1; state.hover.row = -1;
  // 实体数组长度清零（旧对象交给 GC：一次性开销，不在循环里发生）
  state.enemies.length = 0; state.towers.length = 0; state.bullets.length = 0;
  state.particles.length = 0; state.floaters.length = 0;
  state.path = buildPath(MAP_TEMPLATES[state.mapIdx]);
  state.pathTiles = buildPathTiles(MAP_TEMPLATES[state.mapIdx]);
}

/**
 * 把一波的 groups 展开成出场队列：轮转插入（每组各取 1 只循环），而不是「先出完
 * 步兵再出盾兵」——每波从头到尾都有混合压力，波内难度不突变。元素引用 group，不复制。
 */
function expandSpawnQueue(wave) {
  const pools = wave.groups.map((g) => ({ g, left: g.count }));
  const queue = [];
  let remaining = pools.reduce((s, p) => s + p.left, 0);
  let guard = 0;
  while (remaining > 0 && guard++ < 200000) {
    for (let i = 0; i < pools.length; i++) {
      const p = pools[i];
      if (p.left <= 0) continue;
      p.left -= 1;
      remaining -= 1;
      queue.push(p.g);
      if (remaining <= 0) break;
    }
  }
  return queue;
}

/** 开始第 n 波 */
function startWave() {
  state.wave += 1;
  const wave = generateEndlessWave(state.wave, state.seed);
  state.waveStats = wave;
  state.spawnQueue = expandSpawnQueue(wave);
  state.spawnIdx = 0;
  state.spawnGap = wave.spawnGap;
  state.spawnTimer = 0;
  state.waveActive = true;
  noteBest(state.wave);
}

/** 记录并持久化最高波数（每进一波就存，玩家直接关标签页也不丢记录） */
function noteBest(wave) {
  if (wave <= state.best) return;
  state.best = wave;
  try { localStorage.setItem(BEST_KEY, String(wave)); } catch (err) { /* 隐私模式：只影响记录 */ }
}

/** 生命归零：存档 + 亮结算浮层 */
function gameOver() {
  if (state.gameOver) return;
  state.gameOver = true;
  state.paused = false;
  noteBest(state.wave);
  showOverlay();
}

/* ===================== 6. 敌人 ===================== */
/** 造一只敌人（速度带 ±7% 抖动，避免整波叠成一条完美直线） */
function spawnEnemy(spec) {
  const jitter = 0.93 + Math.random() * 0.14;
  const start = pointAt(state.path, 0);
  state.enemies.push({
    type: spec.type, hp: spec.hp, maxHp: spec.hp, speed: spec.speed * jitter,
    armor: spec.armor, bounty: spec.bounty,
    dist: 0, x: start.x, y: start.y,     // dist = 沿路径像素进度，越大越靠前
    slowUntil: 0, slowFactor: 0, hitFlash: 0, dead: false,
  });
}

/** 步进敌人：移动 → 到终点扣血；死亡/漏怪都是 swap-remove 就地删除 */
function updateEnemies(dt) {
  const arr = state.enemies;
  const path = state.path;
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e.dead) { arr[i] = arr[arr.length - 1]; arr.pop(); continue; }
    const slowed = state.timeMs < e.slowUntil;
    e.dist += (slowed ? e.speed * (1 - e.slowFactor) : e.speed) * dt;
    if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
    if (e.dist >= path.length) {
      arr[i] = arr[arr.length - 1];
      arr.pop();
      leak();
      if (state.gameOver) return;
      continue;
    }
    const p = pointAt(path, e.dist);
    e.x = p.x; e.y = p.y;
  }
}

/** 漏怪：扣 1 点生命 */
function leak() {
  state.lives -= 1;
  addFloater(VIEW.w - 46, VIEW.h / 2, -1, palette.danger);
  if (state.lives <= 0) { state.lives = 0; gameOver(); }
}

/** 伤害结算：真实伤害 = dmg × (1 - armor)；击杀给赏金（bounty 已在波次里算好倍率） */
function damageEnemy(enemy, dmg) {
  if (enemy.dead) return;
  const real = dmg * (1 - enemy.armor);
  enemy.hp -= real;
  enemy.hitFlash = 1;
  addFloater(enemy.x, enemy.y - 8, Math.round(real), null);
  if (enemy.hp <= 0) {
    enemy.hp = 0;
    enemy.dead = true;
    state.gold += enemy.bounty;
    state.kills += 1;
    addParticles(enemy.x, enemy.y, 7, ENEMY_COLORS[enemy.type] || '#999');
  }
}

/* ===================== 7. 塔与战斗 ===================== */
/** 建塔：校验金币 / 可建 / 空位，成功后扣钱并记录总投入（出售按它返还） */
function placeTower(type, col, row) {
  const def = TOWER_TYPES[type];
  if (!def) return false;
  const cost = def.cost[0];
  if (state.gold < cost || !isBuildable(state, col, row) || towerAt(state, col, row)) return false;
  state.gold -= cost;
  state.towers.push({
    type, lv: 1, col, row,
    x: (col + 0.5) * GRID.tile, y: (row + 0.5) * GRID.tile,
    cd: 0,        // 冷却剩余秒数
    rateBuff: 0,  // 光环给的攻速增幅
    dmgBuff: 0,   // 光环给的伤害增幅
    spend: cost,  // 历史总投入（升级累加）
  });
  addParticles((col + 0.5) * GRID.tile, (row + 0.5) * GRID.tile, 6, def.color);
  return true;
}

/** 升级：两级封顶（1→2→3），cost[lv] 就是升到下一级的价格 */
function upgradeTower(tower) {
  if (!tower || tower.lv >= 3) return false;
  const def = TOWER_TYPES[tower.type];
  const cost = def.cost[tower.lv];
  if (state.gold < cost) return false;
  state.gold -= cost;
  tower.lv += 1;
  tower.spend += cost;
  addParticles(tower.x, tower.y, 8, def.color);
  return true;
}

/** 出售：返还总投入的 60%（向下取整） */
function sellTower(tower) {
  const idx = state.towers.indexOf(tower);
  if (idx < 0) return 0;
  const refund = Math.floor(tower.spend * BALANCE.sellRatio);
  state.gold += refund;
  state.towers.splice(idx, 1);
  if (state.selectedTower === tower) state.selectedTower = null;
  return refund;
}

/** 索敌：射程内沿路径进度最大（最靠近终点、最危险）的敌人 */
function findTarget(tower, range) {
  const r2 = range * range;
  let best = null;
  for (let i = 0; i < state.enemies.length; i++) {
    const e = state.enemies[i];
    if (e.dead) continue;
    const dx = e.x - tower.x, dy = e.y - tower.y;
    if (dx * dx + dy * dy > r2) continue;
    if (!best || e.dist > best.dist) best = e;
  }
  return best;
}

/**
 * 每逻辑步更新全部塔：
 *  1) buff 先清零，再由每个光环塔给自己范围内的塔「取最高值」——同类光环不叠乘，
 *     所以是 Math.max 比较赋值而不是相加（不同类光环若第二步加入，各自取最高后叠加）。
 *  2) 冷却按 (1 + rateBuff) 加速消耗，到 0 就开火；伤害按 (1 + dmgBuff) 放大。
 */
function updateTowers(dt) {
  const towers = state.towers;
  for (let i = 0; i < towers.length; i++) { towers[i].rateBuff = 0; towers[i].dmgBuff = 0; }
  for (let i = 0; i < towers.length; i++) {
    const a = towers[i];
    if (a.type !== 'aura') continue;
    const adef = TOWER_TYPES.aura;
    const range = adef.range[a.lv - 1], rate = adef.auraRate[a.lv - 1], dmg = adef.auraDmg[a.lv - 1];
    const r2 = range * range;
    for (let j = 0; j < towers.length; j++) {
      const t = towers[j];
      if (t === a) continue;
      const dx = t.x - a.x, dy = t.y - a.y;
      if (dx * dx + dy * dy > r2) continue;
      if (rate > t.rateBuff) t.rateBuff = rate;   // 同类光环取最高值，不叠乘
      if (dmg > t.dmgBuff) t.dmgBuff = dmg;
    }
  }
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    if (t.type === 'aura') continue;               // 光环塔本身不攻击
    const def = TOWER_TYPES[t.type];
    t.cd -= dt * (1 + t.rateBuff);
    if (t.cd > 0) continue;
    const target = findTarget(t, def.range[t.lv - 1]);
    if (!target) { t.cd = 0; continue; }           // 没目标不打空枪，进射程立刻开火
    t.cd += 1 / def.rate[t.lv - 1];                // 累加不清零，倍速下节奏更稳
    const lv = t.lv - 1;
    const dmg = def.dmg[lv] * (1 + t.dmgBuff);
    if (t.type === 'cannon') spawnBullet(t, target, dmg, def.splash[lv], 0, 0);                 // 溅射
    else if (t.type === 'frost') spawnBullet(t, target, dmg, 0, def.slow[lv], def.slowMs[lv]);  // 单体+减速
    else spawnBullet(t, target, dmg, 0, 0, 0);                                                 // 单体
  }
}

/** 取一颗子弹：池里有就复用，没有才新建 */
function spawnBullet(tower, target, dmg, splash, slow, slowMs) {
  const b = bulletPool.pop() || {};
  b.x = tower.x; b.y = tower.y; b.tx = target.x; b.ty = target.y; b.target = target;
  b.dmg = dmg; b.splash = splash; b.slow = slow; b.slowMs = slowMs;
  b.speed = splash > 0 ? 320 : 640;
  b.color = TOWER_TYPES[tower.type].color;
  state.bullets.push(b);
}

/** 子弹飞行：追目标当前位置，命中即结算并回收进池 */
function updateBullets(dt) {
  const arr = state.bullets;
  for (let i = arr.length - 1; i >= 0; i--) {
    const b = arr[i];
    const t = b.target;
    if (t && !t.dead) { b.tx = t.x; b.ty = t.y; } else b.target = null;  // 目标先死：飞向最后位置
    const dx = b.tx - b.x, dy = b.ty - b.y;
    const dist = Math.hypot(dx, dy);
    const move = b.speed * dt;
    if (dist <= move || dist < 1) {
      b.x = b.tx; b.y = b.ty;
      impact(b);
      arr[i] = arr[arr.length - 1];
      arr.pop();
      bulletPool.push(b);
      continue;
    }
    b.x += (dx / dist) * move;
    b.y += (dy / dist) * move;
  }
}

/** 命中结算：炮塔按溅射半径命中范围内所有敌人；冰塔附加「最近一次」减速 */
function impact(b) {
  if (b.splash > 0) {
    const r2 = b.splash * b.splash;
    for (let i = 0; i < state.enemies.length; i++) {
      const e = state.enemies[i];
      if (e.dead) continue;
      const dx = e.x - b.x, dy = e.y - b.y;
      if (dx * dx + dy * dy > r2) continue;
      damageEnemy(e, b.dmg);
    }
    addParticles(b.x, b.y, 6, b.color);
    return;
  }
  const target = b.target;
  if (!target || target.dead) return;
  damageEnemy(target, b.dmg);
  if (b.slow > 0 && !target.dead) {
    // 「最近一次有效」：新的一发直接覆盖当前减速（不叠乘、不取最强）
    target.slowUntil = state.timeMs + b.slowMs;
    target.slowFactor = b.slow;
  }
  addParticles(b.x, b.y, 3, b.color);
}

/* ===================== 8. 特效（飘字 / 粒子） ===================== */
/** 伤害飘字：reduce 动效时改为静态显示（不上飘、不淡出），信息不丢 */
function addFloater(x, y, value, color) {
  if (state.floaters.length > 60) state.floaters.shift();
  state.floaters.push({
    x, y, text: String(value),
    color: color || (value > 0 ? palette.text : palette.danger),
    life: 0.7, max: 0.7,
  });
}

/** 命中粒子：reduce 动效时干脆不生成（不画＝最彻底的「关掉位移」） */
function addParticles(x, y, count, color) {
  if (state.reducedMotion) return;
  for (let i = 0; i < count; i++) {
    if (state.particles.length > 220) break;
    const ang = Math.random() * Math.PI * 2;
    const spd = 40 + Math.random() * 90;
    state.particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      life: 0.32 + Math.random() * 0.2, max: 0.52, color,
    });
  }
}

/** 步进飘字与粒子（同样反向 swap-remove） */
function updateFx(dt) {
  const f = state.floaters;
  for (let i = f.length - 1; i >= 0; i--) {
    const o = f[i];
    o.life -= dt;
    if (!state.reducedMotion) o.y -= 26 * dt;   // 减少动效时不动位置
    if (o.life <= 0) { f[i] = f[f.length - 1]; f.pop(); }
  }
  const p = state.particles;
  for (let i = p.length - 1; i >= 0; i--) {
    const o = p[i];
    o.life -= dt;
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.vx *= 0.94; o.vy *= 0.94;
    if (o.life <= 0) { p[i] = p[p.length - 1]; p.pop(); }
  }
}

/* ===================== 9. 逻辑步 & 波次推进 ===================== */
/** 波次推进：出场 → 打完 → 倒计时下一波 */
function updateWaves(dt) {
  if (!state.waveActive) {
    state.nextWaveIn -= dt * 1000;
    if (state.nextWaveIn <= 0) startWave();
    return;
  }
  // 出场：每 spawnGap 毫秒一只；while 兜住低帧率时的补偿
  if (state.spawnIdx < state.spawnQueue.length) {
    state.spawnTimer -= dt * 1000;
    while (state.spawnTimer <= 0 && state.spawnIdx < state.spawnQueue.length) {
      spawnEnemy(state.spawnQueue[state.spawnIdx]);
      state.spawnIdx += 1;
      state.spawnTimer += state.spawnGap;
    }
  }
  // 收尾：队列放空且场上清干净 → 进入喘息时间
  if (state.spawnIdx >= state.spawnQueue.length && state.enemies.length === 0) {
    state.waveActive = false;
    state.nextWaveIn = BALANCE.waveGapMs;
  }
}

/** 一个固定逻辑步：时间 → 波次 → 敌人 → 塔 → 子弹 → 特效 */
function step(dt) {
  state.timeMs += dt * 1000;
  updateWaves(dt);
  updateEnemies(dt);
  if (state.gameOver) return;
  updateTowers(dt);
  updateBullets(dt);
  updateFx(dt);
}

/* ===================== 10. 渲染 ===================== */
const draw = { ctx: null, canvas: null };

/** 从站点 CSS 变量读调色板（主题切换后重读，画布跟着变深浅） */
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => ((cs.getPropertyValue(name) || '').trim() || fallback);
  palette.bg = pick('--bg-page', '#ffffff');
  palette.grid = pick('--border-light', '#ececec');
  palette.path = pick('--bg-hover', '#f2f2f2');
  palette.edge = pick('--border', '#d9d9d9');
  palette.text = pick('--text-primary', '#111111');
  palette.muted = pick('--text-secondary', '#535353');
  palette.card = pick('--bg-card', '#ffffff');
  palette.primary = pick('--primary', '#1db954');
  palette.danger = pick('--danger', '#d93025');
  palette.warning = pick('--warning', '#e8900a');
}

/** 整帧重绘（网格只有 24×14，全量重绘开销可忽略） */
function render() {
  const ctx = draw.ctx;
  if (!ctx) return;
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  drawGrid(ctx); drawPath(ctx); drawHover(ctx); drawTowers(ctx);
  drawEnemies(ctx); drawBullets(ctx); drawFx(ctx); drawPrompts(ctx);
}

function drawGrid(ctx) {
  ctx.strokeStyle = palette.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (let c = 1; c < GRID.cols; c++) { const x = c * GRID.tile + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, VIEW.h); }
  for (let r = 1; r < GRID.rows; r++) { const y = r * GRID.tile + 0.5; ctx.moveTo(0, y); ctx.lineTo(VIEW.w, y); }
  ctx.stroke();
}

/** 路径带：1 格宽的折线描边（与 buildPathTiles 的格子判定同源） */
function drawPath(ctx) {
  const pts = state.path.pts;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  };
  ctx.strokeStyle = palette.path; ctx.lineWidth = GRID.tile; ctx.lineJoin = 'round';
  trace();
  ctx.strokeStyle = palette.edge; ctx.lineWidth = 1; ctx.setLineDash([6, 8]);   // 中线虚线
  trace();
  ctx.setLineDash([]);
  const end = pts[pts.length - 1];      // 终点：红色标记
  ctx.fillStyle = palette.danger;
  ctx.beginPath(); ctx.arc(end.x - 8, end.y, 7, 0, Math.PI * 2); ctx.fill();
}

/** 悬停格高亮 + 待建塔射程预览 */
function drawHover(ctx) {
  const type = state.selectedType;
  const col = state.hover.col, row = state.hover.row;
  if (!type || col < 0) return;
  const ok = isBuildable(state, col, row) && !towerAt(state, col, row);
  const x = col * GRID.tile, y = row * GRID.tile;
  ctx.fillStyle = ok ? palette.ok : palette.bad;
  ctx.fillRect(x, y, GRID.tile, GRID.tile);
  ctx.strokeStyle = ok ? palette.primary : palette.danger; ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, GRID.tile - 2, GRID.tile - 2);
  if (!ok) return;
  ctx.strokeStyle = TOWER_TYPES[type].color; ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.arc(x + GRID.tile / 2, y + GRID.tile / 2, TOWER_TYPES[type].range[0], 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;
}

/** 塔：底盘 + 图标 + 等级点；选中时画射程圈 */
function drawTowers(ctx) {
  const towers = state.towers;
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    const def = TOWER_TYPES[t.type];
    const on = state.selectedTower === t;
    if (on) {   // 选中：射程圈
      ctx.strokeStyle = def.color; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.arc(t.x, t.y, def.range[t.lv - 1], 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = palette.card;
    ctx.beginPath(); ctx.arc(t.x, t.y, 13, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = def.color; ctx.lineWidth = on ? 3.5 : 2.5; ctx.stroke();
    drawTowerGlyph(ctx, t, def.color);
    ctx.fillStyle = def.color;   // 等级：塔底一排小圆点
    for (let k = 0; k < t.lv; k++) { ctx.beginPath(); ctx.arc(t.x + 9 - k * 6, t.y + 11, 2, 0, Math.PI * 2); ctx.fill(); }
  }
}

/** 塔的图标（纯几何，不依赖任何图片资源） */
function drawTowerGlyph(ctx, tower, color) {
  const x = tower.x, y = tower.y;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  if (tower.type === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(x, y - 7); ctx.lineTo(x + 5, y + 5); ctx.lineTo(x, y + 2); ctx.lineTo(x - 5, y + 5);
    ctx.closePath(); ctx.fill();
  } else if (tower.type === 'cannon') {
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(x - 1.5, y - 9, 3, 6);
  } else if (tower.type === 'frost') {
    for (let i = 0; i < 3; i++) {
      const a = (Math.PI / 3) * i;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * 7, y - Math.sin(a) * 7);
      ctx.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7);
      ctx.stroke();
    }
  } else {   // aura：双环
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/** 敌人：身体 + 血条（减速时描一圈冷色） */
function drawEnemies(ctx) {
  const arr = state.enemies;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (e.dead) continue;
    const r = ENEMY_RADIUS[e.type] || 8;
    ctx.fillStyle = e.hitFlash > 0.35 ? '#ffffff' : (ENEMY_COLORS[e.type] || '#8f8f8f');
    ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
    if (state.timeMs < e.slowUntil) { ctx.strokeStyle = '#4CC9F0'; ctx.lineWidth = 2; ctx.stroke(); }
    const ratio = e.maxHp > 0 ? Math.max(0, e.hp / e.maxHp) : 0;
    const w = r * 2.6, bx = e.x - w / 2, by = e.y - r - 9;
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(bx, by, w, 4);
    ctx.fillStyle = ratio > 0.5 ? palette.primary : ratio > 0.25 ? palette.warning : palette.danger;
    ctx.fillRect(bx, by, w * ratio, 4);
  }
}

function drawBullets(ctx) {
  const arr = state.bullets;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.splash > 0 ? 5 : 3, 0, Math.PI * 2); ctx.fill();
  }
}

function drawFx(ctx) {
  const p = state.particles;
  for (let i = 0; i < p.length; i++) {
    const o = p[i];
    ctx.globalAlpha = Math.max(0, o.life / o.max);
    ctx.fillStyle = o.color;
    ctx.fillRect(o.x - 1.5, o.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  const f = state.floaters;
  ctx.font = '600 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < f.length; i++) {
    const o = f[i];
    ctx.globalAlpha = state.reducedMotion ? 0.9 : Math.max(0, o.life / o.max);
    ctx.fillStyle = o.color;
    ctx.fillText(o.text, o.x, o.y);
  }
  ctx.globalAlpha = 1;
}

/** 状态提示：波间倒计时 / 暂停文字 */
function drawPrompts(ctx) {
  ctx.textAlign = 'center';
  if (state.gameOver) return;
  if (state.paused || state.hidden) {
    ctx.fillStyle = palette.text;
    ctx.font = '700 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('已暂停', VIEW.w / 2, VIEW.h / 2);
    return;
  }
  if (!state.waveActive) {
    const secs = Math.max(0, state.nextWaveIn / 1000).toFixed(1);
    const label = state.wave === 0 ? '准备开战 ' : '第 ' + (state.wave + 1) + ' 波 · ';
    ctx.fillStyle = palette.muted;
    ctx.font = '600 15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(label + secs + 's', VIEW.w / 2, VIEW.h / 2);
  }
}

/* ===================== 11. 输入（鼠标 + 触摸统一走 pointer） ===================== */
/** 指针 → 格子：用 rect 反算逻辑坐标，CSS 缩放与 DPR 都不影响命中 */
function eventToCell(ev) {
  const rect = draw.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((ev.clientX - rect.left) / rect.width) * VIEW.w;
  const y = ((ev.clientY - rect.top) / rect.height) * VIEW.h;
  const col = Math.floor(x / GRID.tile), row = Math.floor(y / GRID.tile);
  if (col < 0 || row < 0 || col >= GRID.cols || row >= GRID.rows) return null;
  return { col, row };
}

/**
 * pointerdown 统一处理鼠标 / 触摸 / 触控笔：
 *  点到已有塔 → 打开升级/出售面板（优先于放塔）；否则选了塔种类就放塔；再否则收面板。
 */
function onPointerDown(ev) {
  if (ev.cancelable) ev.preventDefault();
  const cell = eventToCell(ev);
  if (!cell) return;
  state.hover.col = cell.col;
  state.hover.row = cell.row;
  if (state.gameOver) return;
  const existing = towerAt(state, cell.col, cell.row);
  if (existing) { showTowerPanel(existing); return; }
  if (state.selectedType) {
    if (placeTower(state.selectedType, cell.col, cell.row)) {
      // 金币不够下一座就自动取消选中，省一次点击
      if (state.gold < TOWER_TYPES[state.selectedType].cost[0]) state.selectedType = null;
      syncTowerButtons();
    }
    return;
  }
  hideTowerPanel();
}

/** 悬停高亮只跟鼠标走（触摸不跟踪，避免手指抬起后留个假高亮） */
function onPointerMove(ev) {
  if (ev.pointerType && ev.pointerType !== 'mouse') return;
  const cell = eventToCell(ev);
  if (!cell) { state.hover.col = -1; state.hover.row = -1; return; }
  state.hover.col = cell.col;
  state.hover.row = cell.row;
}

/* ===================== 12. 塔面板 / HUD / 结算浮层 ===================== */
const ui = {};   // DOM 引用集中在 boot() 里一次性取好

function showTowerPanel(tower) {
  state.selectedTower = tower;
  state.selectedType = null;
  syncTowerButtons();
  refreshPanel();
  ui.panel.classList.add('show');
}

function hideTowerPanel() {
  state.selectedTower = null;
  if (ui.panel) ui.panel.classList.remove('show');
}

/** 刷新面板内容 + 摆位（摆在塔右下方，越界时向内夹） */
function refreshPanel() {
  const t = state.selectedTower;
  if (!t || !ui.panel) return;
  const def = TOWER_TYPES[t.type];
  const lv = t.lv - 1;
  ui.panelName.textContent = def.name;
  ui.panelLv.textContent = 'Lv.' + t.lv;
  if (t.type === 'aura') {
    ui.panelDmg.textContent = '攻速增幅 +' + Math.round(def.auraRate[lv] * 100) + '%';
    ui.panelRate.textContent = '伤害增幅 +' + Math.round(def.auraDmg[lv] * 100) + '%';
  } else {
    ui.panelDmg.textContent = '伤害 ' + Math.round(def.dmg[lv] * (1 + t.dmgBuff));
    ui.panelRate.textContent = '攻速 ' + (def.rate[lv] * (1 + t.rateBuff)).toFixed(2) + '/s';
  }
  ui.panelRange.textContent = '射程 ' + def.range[lv];
  const upCost = t.lv < 3 ? def.cost[t.lv] : null;
  ui.btnUpgrade.textContent = upCost == null ? '已满级' : '升级 ' + upCost;
  ui.btnUpgrade.disabled = upCost == null || state.gold < upCost;
  ui.btnSell.textContent = '出售 +' + Math.floor(t.spend * BALANCE.sellRatio);
  ui.panel.style.left = Math.min((((t.col + 1) * GRID.tile) / VIEW.w) * 100, 68) + '%';
  ui.panel.style.top = Math.min(Math.max(((t.row * GRID.tile) / VIEW.h) * 100, 0), 60) + '%';
}

/** HUD：值变了才写 DOM，避免每帧 6 次无效写入 */
const hudCache = { wave: -1, lives: -1, gold: -1, kills: -1, alive: -1, best: -1 };

function syncHud() {
  if (!ui.wave) return;
  if (hudCache.wave !== state.wave) { ui.wave.textContent = state.wave; hudCache.wave = state.wave; }
  if (hudCache.lives !== state.lives) { ui.lives.textContent = state.lives; hudCache.lives = state.lives; }
  if (hudCache.gold !== state.gold) { ui.gold.textContent = state.gold; hudCache.gold = state.gold; syncTowerButtons(); }
  if (hudCache.kills !== state.kills) { ui.kills.textContent = state.kills; hudCache.kills = state.kills; }
  const alive = state.enemies.length;
  if (hudCache.alive !== alive) { ui.alive.textContent = alive; hudCache.alive = alive; }
  if (hudCache.best !== state.best) { ui.best.textContent = state.best; hudCache.best = state.best; }
  if (state.selectedTower) refreshPanel();
}

/** 塔按钮三态：选中 / 买不起 / 普通 */
function syncTowerButtons() {
  if (!ui.towerBtns) return;
  for (let i = 0; i < ui.towerBtns.length; i++) {
    const btn = ui.towerBtns[i];
    btn.classList.toggle('is-selected', state.selectedType === btn.dataset.tower);
    btn.classList.toggle('is-poor', state.gold < TOWER_TYPES[btn.dataset.tower].cost[0]);
  }
}

function showOverlay() {
  ui.overWave.textContent = state.wave;
  ui.overBest.textContent = '最高波数：' + state.best;
  ui.overlay.classList.add('show');
}

function hideOverlay() {
  if (ui.overlay) ui.overlay.classList.remove('show');
}

/* ===================== 13. 主循环：固定步长 + 补帧上限 ===================== */
let acc = 0;      // 累积的未消耗逻辑时间（秒）
let lastTs = 0;   // 上一帧时间戳；0 = 需要重新对齐基准

function frame(ts) {
  requestAnimationFrame(frame);
  if (!lastTs) { lastTs = ts; return; }   // 首帧 / 恢复可见后的首帧只对齐基准
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.25) dt = 0.25;               // 长卡顿先给真实间隔封顶
  if (state.paused || state.hidden || state.gameOver) {
    acc = 0;
  } else {
    acc += dt * state.speed;              // 倍速只加快累积，不改渲染帧率
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
      step(STEP);
      acc -= STEP;
      steps += 1;
      if (state.gameOver) break;
    }
    if (steps >= MAX_STEPS_PER_FRAME) acc = 0;   // 追不上就丢弃欠账，绝不滚成雪球
  }
  render();
  syncHud();
}

/* ===================== 14. 尺寸 / 事件 / 启动 ===================== */
/** 按 DPR 放大 backing store，再用 setTransform 把绘制坐标固定成 768×448 */
function setupCanvas() {
  const cssW = Math.max(240, Math.min(ui.stage.clientWidth || VIEW.w, VIEW.w));
  const cssH = Math.round((cssW * VIEW.h) / VIEW.w);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ui.canvas.style.height = cssH + 'px';
  ui.canvas.width = Math.round(cssW * dpr);
  ui.canvas.height = Math.round(cssH * dpr);
  draw.ctx.setTransform(ui.canvas.width / VIEW.w, 0, 0, ui.canvas.height / VIEW.h, 0, 0);
}

function readBest() {
  try {
    const v = parseInt(localStorage.getItem(BEST_KEY) || '0', 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (err) {
    return 0;
  }
}

function togglePause() {
  if (state.gameOver) return;
  state.paused = !state.paused;
  ui.btnPause.textContent = state.paused ? '继续' : '暂停';
  ui.btnPause.classList.toggle('is-on', state.paused);
}

function restart() {
  resetGame();
  hideOverlay();
  hideTowerPanel();
  ui.btnPause.textContent = '暂停';
  ui.btnPause.classList.remove('is-on');
  ui.btnSpeed.textContent = '1x';
  ui.btnSpeed.classList.remove('is-on');
  lastTs = 0; acc = 0;
  syncTowerButtons();
  syncHud();
}

function bindEvents() {
  ui.canvas.addEventListener('pointerdown', onPointerDown);
  ui.canvas.addEventListener('pointermove', onPointerMove);
  ui.canvas.addEventListener('pointerleave', () => { state.hover.col = -1; state.hover.row = -1; });

  ui.towerBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.tower;
      if (state.gold < TOWER_TYPES[type].cost[0]) return;   // 买不起：不选中
      state.selectedType = state.selectedType === type ? null : type;
      hideTowerPanel();
      syncTowerButtons();
    });
  });

  ui.btnUpgrade.addEventListener('click', () => {
    if (state.selectedTower && upgradeTower(state.selectedTower)) { refreshPanel(); syncTowerButtons(); }
  });
  ui.btnSell.addEventListener('click', () => {
    if (!state.selectedTower) return;
    sellTower(state.selectedTower);
    hideTowerPanel();
    syncHud();
  });
  ui.btnPause.addEventListener('click', togglePause);
  ui.btnSpeed.addEventListener('click', () => {
    state.speed = state.speed === 1 ? 2 : 1;
    ui.btnSpeed.textContent = state.speed + 'x';
    ui.btnSpeed.classList.toggle('is-on', state.speed === 2);
  });
  ui.btnRestart.addEventListener('click', restart);
  ui.btnAgain.addEventListener('click', restart);

  // 键盘：空格暂停、1~4 选塔、Esc 收面板（桌面调试友好）
  document.addEventListener('keydown', (ev) => {
    if (ev.key === ' ') { ev.preventDefault(); togglePause(); }
    else if (ev.key === 'Escape') hideTowerPanel();
    else if (ev.key >= '1' && ev.key <= '4') { const b = ui.towerBtns[Number(ev.key) - 1]; if (b) b.click(); }
  });

  // 页面隐藏 → 停止累积；回到前台 → 重排时间基准，避免一次补出几十步
  document.addEventListener('visibilitychange', () => {
    state.hidden = document.hidden;
    lastTs = 0;
    acc = 0;
  });

  // 主题切换（auth-header.js 改的是 html[data-theme]）→ 重读调色板
  new MutationObserver(readPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // 减少动效偏好变化时实时生效
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  state.reducedMotion = mq.matches;
  if (mq.addEventListener) mq.addEventListener('change', (e) => { state.reducedMotion = e.matches; });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setupCanvas, 150);
  });
}

/** 取 DOM 引用并开局 */
function boot() {
  const byId = (id) => document.getElementById(id);
  ui.canvas = byId('tdCanvas');
  ui.stage = byId('tdStage');
  if (!ui.canvas || !ui.stage) return;   // 不在塔防页面：静默退出
  draw.canvas = ui.canvas;
  draw.ctx = ui.canvas.getContext('2d');
  ui.wave = byId('tdWave'); ui.lives = byId('tdLives'); ui.gold = byId('tdGold');
  ui.kills = byId('tdKills'); ui.alive = byId('tdAlive'); ui.best = byId('tdBest');
  ui.panel = byId('tdPanel'); ui.panelName = byId('tdPanelName'); ui.panelLv = byId('tdPanelLv');
  ui.panelDmg = byId('tdPanelDmg'); ui.panelRate = byId('tdPanelRate'); ui.panelRange = byId('tdPanelRange');
  ui.btnUpgrade = byId('tdBtnUpgrade'); ui.btnSell = byId('tdBtnSell');
  ui.overlay = byId('tdOverlay'); ui.overWave = byId('tdOverWave'); ui.overBest = byId('tdOverBest');
  ui.btnAgain = byId('tdBtnAgain'); ui.btnPause = byId('tdPause');
  ui.btnSpeed = byId('tdSpeed'); ui.btnRestart = byId('tdRestart');
  ui.towerBtns = Array.prototype.slice.call(document.querySelectorAll('.td-tower-btn'));

  state.best = readBest();
  readPalette();
  resetGame();
  setupCanvas();
  bindEvents();
  syncTowerButtons();
  syncHud();

  // 控制台调试入口（手工核对波次曲线、快速加钱）
  window.tdGame = {
    snapshot: () => ({
      wave: state.wave, lives: state.lives, gold: state.gold, kills: state.kills, best: state.best,
      enemies: state.enemies.length, towers: state.towers.length,
      waveActive: state.waveActive, gameOver: state.gameOver, speed: state.speed,
    }),
    wave: (n) => generateEndlessWave(n, state.seed),
    addGold: (n) => { state.gold += n; },
    skipWait: () => { state.nextWaveIn = 0; },
    restart,
  };
  requestAnimationFrame(frame);
}

// 只在浏览器里启动：Node 下 import 本模块只拿到纯函数，不会碰 DOM
if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();
