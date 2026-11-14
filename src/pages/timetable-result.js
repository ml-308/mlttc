// src/pages/timetable-result.js
/**
 * 修改时刻表页（timetable-result.html?id=xxx）
 * 从「我的时刻表」（my-timetable.html）列表里的「修改」按钮进入
 *
 * 流程：按 ?id= 拉取原记录 → 填入表单 → 逐字段校验 → 提交修改（POST /api/timetable-D1）
 * 注意：修改后由**服务端**把 PASS 重置为 0（重新进入待审核），客户端不传 pass
 *
 * 依赖：/lib/ui/popup.mjs、/lib/ui/message.mjs、/lib/timetable.mjs、/lib/data/city-picker.mjs
 */
import { showPrompt, showConfirm } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';
import { createGuard } from '/lib/ui/guard.mjs';
import {
  bindAutoSave, loadDraft, clearDraft,
  isUnattended, setUnattended, describeDraftAge, formatClock,
  listSnapshots, saveSnapshot, deleteSnapshot, getSnapshot
} from '/src/pages/timetable-draft.js';
import { attachCityPicker } from '/lib/data/city-picker.mjs';
import { checkCityInput, describeCityInput, normalizeCityInput, formatCityForStorage } from '/lib/ui/city-chooser.mjs';
import { Complete, timejudge, timeformat, ex_timejudege } from '/lib/timetable.mjs';

// ─── DOM 元素 ────────────────────────────────

const backBtn = document.getElementById('back-btn');
const editLoading = document.getElementById('edit-loading');
const editError = document.getElementById('edit-error');
const editForm = document.getElementById('edit-form');
const editRetryBtn = document.getElementById('edit-retry-btn');
const submitBtn = document.getElementById('submitEditBtn');
const resetBtn = document.getElementById('resetEditBtn');

// 输入框
const cityInput = document.getElementById('city');
const wayInput = document.getElementById('way');
const startInput = document.getElementById('start');
const endInput = document.getElementById('end');
const time1Input = document.getElementById('time1');
const time2Input = document.getElementById('time2');
const bcInput = document.getElementById('bc');
const eTimeInput = document.getElementById('exec-time');

// 提示框
const cityTest = document.getElementById('citytest');
const wayTest = document.getElementById('waytest');
const startTest = document.getElementById('starttest');
const endTest = document.getElementById('endtest');
const time1Test = document.getElementById('time1test');
const time2Test = document.getElementById('time2test');
const bcTest = document.getElementById('bctest');
const eTimeTest = document.getElementById('exec-timetest');

const time1Div = document.getElementById('time1b');
const time2Div = document.getElementById('time2b');
const time1c = document.getElementById('cl1');
const time2c = document.getElementById('cl2');

// 草稿 UI（见 timetable-result.html 的 .draft-bar / .snap-panel）
const draftSaveBtn = document.getElementById('draft-save-btn');
const draftRestoreBtn = document.getElementById('draft-restore-btn');
const draftStatusEl = document.getElementById('draft-status');
const autoSaveToggle = document.getElementById('draft-autosave');
const snapPanelEl = document.getElementById('snap-panel');
const snapTitleEl = document.getElementById('snap-title');
const snapListEl = document.getElementById('snap-list');

let originalData = null;

// ─── 判断状态 ────────────────────────────────

let judge = {
  city: 0,
  way: 0,
  start: 0,
  end: 0,
  time1: 0,
  time2: 0,
  bc: 1,
  e_time: 0
};

// ─── 工具函数 ────────────────────────────────

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// ─── 草稿：收集 / 状态行 / 恢复 / 自动保存 ─────────
// 存储与过期策略都在 /src/pages/timetable-draft.js 里，本页只管「取哪几个字段、
// 怎么回填、状态行写什么」。
// 编辑页草稿按时刻表 ID 分开存（改 #42 的草稿不会串到 #43）。
const draftPage = 'edit';
const draftId = getQueryParam('id') || '';
let autoSave = null;

/** 页面上哪些字段进草稿（键名即 HTML 里的 name / id，便于排查） */
const DRAFT_INPUTS = {
  city: cityInput,
  way: wayInput,
  start: startInput,
  end: endInput,
  bc: bcInput,
  time1: time1Input,
  time2: time2Input,
  execTime: eTimeInput
};

/** 当前表单内容 → 草稿字段 */
function draftFields() {
  const fields = {};
  Object.keys(DRAFT_INPUTS).forEach((key) => {
    fields[key] = DRAFT_INPUTS[key].value;
  });
  return fields;
}

/** 状态行：传空串即清空（.draft-status:empty 会自动隐藏） */
function setDraftStatus(text) {
  if (draftStatusEl) draftStatusEl.textContent = text || '';
}

/**
 * 只挑「表单当前为空」的字段
 * 编辑页的表单刚从服务器记录里填好，草稿绝不能盖掉服务器数据，
 * 所以 city/way/start/end 这类已有值的字段一律跳过（时刻表文本域默认为空，正好能被恢复）。
 */
function pickRestorable(fields) {
  const out = {};
  Object.keys(DRAFT_INPUTS).forEach((key) => {
    const input = DRAFT_INPUTS[key];
    const value = fields ? fields[key] : undefined;
    if (typeof value !== 'string' || value === '') return;
    if (input.value !== '') return;
    out[key] = value;
  });
  return out;
}

/** 把草稿字段写回表单，并重跑一遍校验（否则 judge 状态与输入框不一致，提交会被判「未修改」） */
function applyDraftFields(fields) {
  Object.keys(fields).forEach((key) => {
    const input = DRAFT_INPUTS[key];
    if (input) input.value = fields[key];
  });
  cityinput();
  wayinput();
  startinput();
  endinput();
  time1input();
  time2input();
  bcinput();
  e_timeinput();
}

/**
 * 恢复草稿（自动恢复：**只填空字段**，绝不覆盖服务器数据与用户已敲的内容）
 *   自动保存开 → 静默恢复，只在状态行留一行字（不打断流程）；
 *   关 → showConfirm 问一次；注意它返回的是**倒序**索引：['恢复草稿','丢弃草稿'] 中
 *        点「恢复草稿」得 1，点「丢弃草稿」/ 点 × / 按 Esc 都得 0。
 */
async function restoreDraft() {
  const draft = loadDraft(draftPage, draftId);
  if (!draft) return;

  const fields = pickRestorable(draft.fields);
  if (Object.keys(fields).length === 0) {
    // 草稿里的字段现在都已经有值（或草稿本身是空的）→ 没有可恢复的内容，直接丢弃
    clearDraft(draftPage, draftId);
    return;
  }

  const age = describeDraftAge(draft.savedAt);
  const restored = age === '刚刚' ? '已恢复刚才填写的草稿' : `已恢复 ${age}的草稿`;

  if (isUnattended()) {
    applyDraftFields(fields);
    setDraftStatus(restored);
    return;
  }

  const choice = await showConfirm({
    text: `发现未提交的草稿（${age}），要恢复吗？`,
    buttons: ['恢复草稿', '丢弃草稿'],
    button_style: ['variant=success', '']
  });
  if (choice === 1) {
    applyDraftFields(fields);
    setDraftStatus(restored);
    return;
  }
  clearDraft(draftPage, draftId);
  setDraftStatus('已丢弃草稿');
}

/** 绑定自动保存：input / change 去抖 800ms，pagehide 与切后台各立即刷一次 */
function bindDraftAutoSave() {
  if (autoSave || !editForm) return;
  autoSave = bindAutoSave(editForm, {
    page: draftPage,
    id: draftId,
    collect: draftFields,
    onSaved() {
      setDraftStatus(`已自动保存 · ${formatClock(Date.now())}`);
    }
  });
}

/** 开关语义：开 = 改动即自动保存；关 = 不自动保存（仍可手动保存快照）。
 *  关掉时要摘掉已有绑定，否则它还会继续往单草稿键里写。 */
function applyAutoSaveSwitch() {
  if (isUnattended()) {
    bindDraftAutoSave();
    return;
  }
  if (autoSave) {
    autoSave.dispose();
    autoSave = null;
  }
}

// ─── 快照：用户手动保存的多份时刻表，按需挑选还原 ─────────────
// 与自动保存的分工：自动保存只维护一份「上次没提交完的现场」（mlttc-tdraft:edit:<id>），
// 由输入去抖随时覆盖；快照只由「保存快照」按钮产生，可以有多份、互不覆盖。

/** 快照标签：优先「城市→线路」，两者都空时退回「快照 N」（N = 现有份数 + 1） */
function snapshotLabel() {
  const city = String(cityInput.value || '').trim();
  const way = String(wayInput.value || '').trim();
  if (city && way) return `${city}→${way}`;
  return city || way || `快照 ${listSnapshots(draftPage, draftId).length + 1}`;
}

/** 快照行的时间：MM-DD HH:MM（列表里要能一眼看出是哪天存的） */
function snapStamp(ms) {
  const pad = (n) => ('0' + n).slice(-2);
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function closeSnapshotPanel() {
  if (snapPanelEl) snapPanelEl.classList.add('hidden');
}

/** 行内小按钮：用原生 button，样式见 timetable-result.html <style> 里的 .snap-btn */
function snapshotRowBtn(text, act, snapId, danger) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = danger ? 'snap-btn danger' : 'snap-btn';
  btn.textContent = text;
  btn.dataset.act = act;
  btn.dataset.snap = snapId;
  return btn;
}

/** 重建快照列表：每行「标签 · 时间 [还原][删除]」。没有快照时给一行提示，面板照样展开 */
function renderSnapshotPanel() {
  if (!snapListEl) return;
  const items = listSnapshots(draftPage, draftId);
  if (snapTitleEl) snapTitleEl.textContent = `▼ 已保存的时刻表（${items.length}）`;
  snapListEl.textContent = '';
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'snap-empty';
    empty.textContent = '还没有保存过时刻表';
    snapListEl.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'snap-row';
    const meta = document.createElement('span');
    meta.className = 'snap-meta';
    meta.textContent = `${item.label} · ${snapStamp(item.savedAt)}`;
    row.appendChild(meta);
    row.appendChild(snapshotRowBtn('还原', 'restore', item.snapId, false));
    row.appendChild(snapshotRowBtn('删除', 'delete', item.snapId, true));
    snapListEl.appendChild(row);
  });
}

/**
 * 还原指定快照
 * 与自动恢复的关键区别：**这里覆盖表单已有值**。restoreDraft() 只往空字段里填（编辑页甚至连
 * 服务器数据都不许盖），而「还原」是用户明确点名要这一份存档，所以照单全收；
 * 写完统一走 applyDraftFields()，重跑页面既有的 8 个校验函数，judge 与输入框保持一致。
 */
function restoreSnapshot(snapId) {
  const snap = getSnapshot(draftPage, draftId, snapId);
  if (!snap) return false;
  applyDraftFields(snap.fields);
  closeSnapshotPanel();
  setDraftStatus(`已还原 · ${formatClock(Date.now())}`);
  return true;
}

// Complete / timejudge / timeformat / ex_timejudege
// 已抽到 /lib/timetable.mjs（见文件顶部 import）


function msgout(input, test, msg, judgeVal) {
  if (judgeVal == 1) {
    input.style.borderColor = '#1eff01';
    test.style.color = '#1eff01';
    test.innerHTML = msg;
    test.style.display = 'block';
  }
  if (judgeVal == 0) {
    input.style.borderColor = '#ff0000';
    test.style.color = '#ff0000';
    test.innerHTML = msg;
    test.style.display = 'block';
  }
  if (judgeVal == 2) {
    input.style.borderColor = '#8881';
    test.style.color = 'var(--text-secondary)';
    test.innerHTML = msg;
    test.style.display = 'none';
  }
  if (judgeVal == 3) {
    input.style.borderColor = '#f3f30e';
    test.style.color = '#f3f30e';
    test.innerHTML = msg;
  }
}

function cleaninput(input, inputtest, btn) {
  inputtest.style.display = 'none';
  input.style.borderColor = '#8881';
  if (btn != 0) {
    btn.style.display = 'none';
  }
}

// ─── 解析时刻表显示格式到编辑格式 ─────────────────

function parseDateForEdit(dateStr) {
  if (!dateStr || dateStr === '1000-1-1') return '';
  // 将 "2025-1-1" 转为 "2025.1.1"
  return dateStr.replace(/-/g, '.');
}

// ─── 输入验证函数 ────────────────────────────

function cityinput() {
  const input = cityInput.value;
  // 规范判断：必须能在城市库里找到
  // 接受「无锡」「无锡市」「江苏省 无锡」「江苏省 无锡市」这几种写法；
  // 合营线路可以写多个城市（最多 6 个，见 city-chooser 的 MAX_CITY_COUNT），用「/」隔开
  const result = checkCityInput(input);
  judge.city = result.ok ? 1 : 0;
  if (result.ok) {
    // 入库写法（带「市」）；以「/」结尾时不会走到这里，免得抹掉刚打的分隔符
    cityInput.value = result.value;
  }
  msgout(cityInput, cityTest, describeCityInput(result), judge.city);
}

function wayinput() {
  const input = wayInput.value;
  let way = wayInput.value;
  if (!isNaN(way)) {
    way = Complete(way, '路');
  }
  if (way == null) {
    judge.way = 0;
    msgout(wayInput, wayTest, '请输入线路', 0);
  } else {
    judge.way = 1;
    msgout(wayInput, wayTest, '"' + way + '" 符合格式规范', 1);
  }
}

function startinput() {
  const input = startInput.value;
  let start = startInput.value;
  start = Complete(start, '站');
  if (start == null) {
    judge.start = 0;
    msgout(startInput, startTest, '请输入起点', 0);
  } else {
    judge.start = 1;
    msgout(startInput, startTest, '"' + start + '" 符合格式规范', 1);
  }
}

function endinput() {
  const input = endInput.value;
  let end = endInput.value;
  end = Complete(end, '站');
  if (end == null) {
    judge.end = 0;
    msgout(endInput, endTest, '请输入终点', 0);
  } else {
    judge.end = 1;
    msgout(endInput, endTest, '"' + end + '" 符合格式规范', 1);
  }
}

function time1input() {
  const input = time1Input.value;
  if (input == 2500) {
    msgout(time1Input, time1Test, 'unknown', 1);
    judge.time1 = 1;
    return;
  } else if (input == 2501) {
    msgout(time1Input, time1Test, 'Remove', 1);
    judge.time1 = 1;
    return;
  }
  let time = time1Input.value;
  let err = '';
  time = time.replace(/\s+/g, ' ').trim();
  let timec = time.split(' ');
  time1Div.style.display = 'flex';
  for (let i = 0; i < timec.length; i++) {
    if (timejudge(timec[i])) {
      continue;
    } else if (timec[i] == ' ') {
      continue;
    } else {
      err += timec[i] + ' ';
    }
  }
  if (err.length > 0 && err != ' ') {
    judge.time1 = 0;
    time1c.style.display = 'inline-block';
    msgout(time1Input, time1Test, '以下时间不符合格式规范：' + err, 0);
  } else if (timec.length == 0 || time == '' || time == ' ') {
    judge.time1 = 0;
    msgout(time1Input, time1Test, '请输入时刻表', 0);
  } else {
    judge.time1 = 1;
    time1c.style.display = 'inline-block';
    msgout(time1Input, time1Test, '时刻表符合格式规范', 1);
  }
}

function time2input() {
  const input = time2Input.value;
  if (input == 2500) {
    msgout(time2Input, time2Test, 'unknown', 1);
    judge.time2 = 1;
    return;
  } else if (input == 2501) {
    msgout(time2Input, time2Test, 'Remove', 1);
    judge.time2 = 1;
    return;
  }
  let time = time2Input.value;
  let err = '';
  time = time.replace(/\s+/g, ' ').trim();
  let timec = time.split(' ');
  time2Div.style.display = 'flex';
  for (let i = 0; i < timec.length; i++) {
    if (timejudge(timec[i])) {
      continue;
    } else if (timec[i] == ' ') {
      continue;
    } else {
      err += timec[i] + ' ';
    }
  }
  if (err.length > 0 && err != ' ') {
    judge.time2 = 0;
    time2c.style.display = 'inline-block';
    msgout(time2Input, time2Test, '以下时间不符合格式规范：' + err, 0);
  } else if (timec.length == 0 || time == '' || time == ' ') {
    judge.time2 = 0;
    msgout(time2Input, time2Test, '请输入时刻表', 0);
  } else {
    judge.time2 = 1;
    time2c.style.display = 'inline-block';
    msgout(time2Input, time2Test, '时刻表符合格式规范', 1);
  }
}

function bcinput() {
  const input = bcInput.value;
  let bc = bcInput.value;
  bc = Complete(bc, ')');
  if (bc != null) {
    bc = '(' + bc;
    msgout(bcInput, bcTest, '"' + bc + '" ', 1);
  } else {
    msgout(bcInput, bcTest, '', 2);
  }
  judge.bc = 1;
}

function e_timeinput() {
  const input = eTimeInput.value;
  let e_time = eTimeInput.value;
  if (e_time == '') {
    judge.e_time = 0;
    msgout(eTimeInput, eTimeTest, '请输入执行时间', 0);
    return;
  }
  e_time = ex_timejudege(e_time);
  if (e_time != false) {
    judge.e_time = 1;
    msgout(eTimeInput, eTimeTest, e_time + ' 是符合格式规范时间', 1);
  } else {
    judge.e_time = 0;
    msgout(eTimeInput, eTimeTest, input + ' 不是符合格式规范时间', 0);
  }
}

function time1cl() {
  cleaninput(time1Input, time1Test, time1Div);
  judge.time1 = 0;
}

function time2cl() {
  cleaninput(time2Input, time2Test, time2Div);
  judge.time2 = 0;
}

function cleanall() {
  judge = {
    city: 0,
    way: 0,
    start: 0,
    end: 0,
    time1: 0,
    time2: 0,
    bc: 1,
    e_time: 0
  };
  cleaninput(cityInput, cityTest, 0);
  cleaninput(wayInput, wayTest, 0);
  cleaninput(startInput, startTest, 0);
  cleaninput(endInput, endTest, 0);
  cleaninput(bcInput, bcTest, 0);
  cleaninput(eTimeInput, eTimeTest, 0);
  time1cl();
  time2cl();
}

// ─── 构建提交数据 ────────────────────────────

function buildData() {
  const city = Complete(normalizeCityInput(cityInput.value) ?? cityInput.value, '市');
  let way = wayInput.value;
  if (!isNaN(way)) {
    way = Complete(way, '路');
  }
  const start = Complete(startInput.value, '站');
  const end = Complete(endInput.value, '站');
  let time1, time2;
  if (time1Input.value == 2500) {
    time1 = 'unknown';
  } else if (time1Input.value == 2501) {
    time1 = 'Remove';
  } else {
    time1 = timeformat(time1Input.value);
  }
  if (time2Input.value == 2500) {
    time2 = 'unknown';
  } else if (time2Input.value == 2501) {
    time2 = 'Remove';
  } else {
    time2 = timeformat(time2Input.value);
  }
  const bc = bcInput.value;
  const e_time = ex_timejudege(eTimeInput.value);
  const now = new Date();
  const year = now.getFullYear();
  const month = ('0' + (now.getMonth() + 1)).slice(-2);
  const day = ('0' + now.getDate()).slice(-2);
  const writetime = year + '-' + month + '-' + day;

  return {
    city, way, start, end, time1, time2, bc, e_time, writetime
  };
}

// ─── 提交 ────────────────────────────────────

const submitGuard = createGuard('正在提交，请稍候…');

/** 「提交修改」按钮的入口（绑定处引用 submitEdit，所以守卫裹在这里） */
function submitEdit() {
  return submitGuard.run(doSubmitEdit);
}

async function doSubmitEdit() {
  // 获取用户信息
  const userRes = await fetch('/api/profile', { credentials: 'include' });
  if (!userRes.ok) {
    showMessage('请先登录', true);
    return;
  }
  const userData = await userRes.json();
  const user = userData.user || userData;
  const name = user.email || '';
  if (!name) {
    showMessage('无法获取用户信息', true);
    return;
  }

  // 实时验证有输入的内容
  cityinput();
  wayinput();
  startinput();
  endinput();
  time1input();
  time2input();
  bcinput();
  e_timeinput();

  // 检查哪些字段有有效输入（judge=1 且值不为空）
  const now = new Date();
  const year = now.getFullYear();
  const month = ('0' + (now.getMonth() + 1)).slice(-2);
  const day = ('0' + now.getDate()).slice(-2);
  const writetime = year + '-' + month + '-' + day;

  const changes = {};

  // 城市：入库写法统一成城市库里的形态（如「江苏省 无锡市」）
  const newCity = Complete(normalizeCityInput(cityInput.value) ?? cityInput.value, '市');
  if (newCity && judge.city === 1) {
    // 原值可能是旧写法（「无锡市」），也过一遍库再比，
    // 免得「根本没改城市」却被判定成改过、白白提交一次
    const origRaw = originalData.CITY || '';
    const origCity = Complete(normalizeCityInput(origRaw) ?? origRaw, '市');
    if (newCity !== origCity) changes.city = newCity;
  }

  // 线路
  let newWay = wayInput.value;
  if (!isNaN(newWay)) newWay = Complete(newWay, '路');
  if (newWay && judge.way === 1) {
    if (newWay !== originalData.WAY) changes.way = newWay;
  }

  // 起点
  const newStart = Complete(startInput.value, '站');
  if (newStart && judge.start === 1) {
    const origStart = Complete(originalData.START, '站');
    if (newStart !== origStart) changes.start = newStart;
  }

  // 终点
  const newEnd = Complete(endInput.value, '站');
  if (newEnd && judge.end === 1) {
    const origEnd = Complete(originalData.END, '站');
    if (newEnd !== origEnd) changes.end = newEnd;
  }

  // 主站→副站时刻表
  if (time1Input.value && judge.time1 === 1) {
    const fmt1 = timeformat(time1Input.value);
    if (fmt1 !== originalData.TIMEONE) changes.time1 = fmt1;
  }

  // 副站→主站时刻表
  if (time2Input.value && judge.time2 === 1) {
    const fmt2 = timeformat(time2Input.value);
    if (fmt2 !== originalData.TIMETWO) changes.time2 = fmt2;
  }

  // 备注
  if (bcInput.value && judge.bc === 1) {
    const newBc = bcInput.value.trim();
    const origBc = (originalData.SPECIAL && originalData.SPECIAL !== '无') ? originalData.SPECIAL : '';
    if (newBc !== origBc) changes.special = newBc;
  }

  // 执行时间
  if (eTimeInput.value && judge.e_time === 1) {
    const fmtE = ex_timejudege(eTimeInput.value);
    if (fmtE && fmtE !== originalData.STARTTIME) changes.etime = fmtE;
  }

  // 检查是否有任何修改
  if (Object.keys(changes).length === 0) {
    showMessage('至少需要修改一项内容', true);
    submitBtn.innerHTML = '提交修改';
    submitBtn.removeAttribute('variant');
    return;
  }

  submitBtn.removeAttribute('variant');
  submitBtn.innerHTML = '提交修改';

  // 构造预览文本
  const allData = buildData();
  const previewLines = [];
  if (changes.city) previewLines.push('城市：' + changes.city + ' ← 已修改');
  if (changes.way) previewLines.push('线路：' + changes.way + ' ← 已修改');
  if (changes.start) previewLines.push('起点：' + changes.start + ' ← 已修改');
  if (changes.end) previewLines.push('终点：' + changes.end + ' ← 已修改');
  if (changes.time1) previewLines.push('主站->副站时刻表：' + changes.time1 + ' ← 已修改');
  if (changes.time2) previewLines.push('副站->主站时刻表：' + changes.time2 + ' ← 已修改');
  if (changes.special !== undefined) previewLines.push('备注：' + changes.special + ' ← 已修改');
  if (changes.etime) previewLines.push('执行时间：' + changes.etime + ' ← 已修改');
  previewLines.push('写入时间：' + writetime);
  previewLines.push('作者：' + name);
  const msg = previewLines.join('\n');

  const inputvalue = await showPrompt({
    text: '确认提交修改',
    buttons: ['确认', '取消'],
    button_style: ['variant=success', ''],
    input_is_area: true,
    input_attrs: { readonly: true, value: msg }
  });

  if (inputvalue != msg) {
    showMessage('已取消', true);
    return;
  }

  // 构造提交数据：id + 修改的字段
  // 注意：PASS（是否通过审核）由服务端在更新时统一重置为 0，客户端不传，
  //       避免用户自行审批；审核由管理员站点通过 /api/admin 完成
  const postData = {
    id: originalData.ID,
    writer: name,
    writetime: writetime,
    ...changes
  };

  try {
    const response = await fetch('/api/timetable-D1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postData)
    });

    const result = await response.json();

    // 只有「HTTP 成功 且 业务 success」才算上传成功；拿不到 body 也按失败处理，
    // 宁可留着草稿，也不要在结果不明时把它删掉
    if (!response.ok || !result || result.success === false) {
      const errMsg = result.message || result.error || '提交失败';
      showMessage(errMsg, true);
      // 失败路径：草稿一个字都不动（否则用户白填一遍）
      return;
    }

    showMessage('修改成功', false);
    // 上传成功：草稿已经完成使命。先解绑再删 —— 顺序不能反，
    // 否则随后导航触发的 pagehide 会把刚删掉的草稿又写回去。
    if (autoSave) {
      autoSave.dispose();
      autoSave = null;
    }
    clearDraft(draftPage, draftId);
    setDraftStatus('');
    // 清除「我的时刻表」页缓存，确保下次加载最新数据
    sessionStorage.removeItem('my_timetable_cache');
    setTimeout(() => {
      window.location.href = '/my-timetable.html';
    }, 1200);
  } catch (err) {
    console.error(err);
    showMessage('网络错误', true);
  }
}

// ─── 加载数据 ────────────────────────────────

async function loadData() {
  const id = getQueryParam('id');
  if (!id) {
    editLoading.classList.add('hidden');
    editError.classList.remove('hidden');
    document.querySelector('#edit-error p').textContent = '缺少时刻表ID参数';
    return;
  }

  editLoading.classList.remove('hidden');
  editError.classList.add('hidden');
  editForm.classList.add('hidden');

  try {
    const res = await fetch(`/api/timetable-D1?id=${encodeURIComponent(id)}`, {
      credentials: 'include'
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ message: '请求失败' }));
      throw new Error(errData.message || errData.error || '请求失败');
    }

    const json = await res.json();
    if (!json.success || !json.data) {
      throw new Error(json.message || '找不到数据');
    }

    originalData = json.data;
    fillForm(originalData);
  } catch (e) {
    console.error('加载数据失败:', e);
    editLoading.classList.add('hidden');
    editError.classList.remove('hidden');
    document.querySelector('#edit-error p').textContent = e.message || '无法加载时刻表数据';
  }
}

function fillForm(item) {
  editLoading.classList.add('hidden');
  editError.classList.add('hidden');
  editForm.classList.remove('hidden');

  // 预填表单
  cityInput.value = item.CITY || '';
  wayInput.value = item.WAY || '';
  startInput.value = item.START || '';
  endInput.value = item.END || '';
  bcInput.value = (item.SPECIAL && item.SPECIAL !== '无') ? item.SPECIAL : '';

  // 时刻表默认清空（目前不支持还原）
  time1Input.value = '';
  time2Input.value = '';

  // 执行时间格式转换
  eTimeInput.value = parseDateForEdit(item.STARTTIME);

  // 触发验证（已有输入即认为有效）
  setTimeout(() => {
    cityinput();
    wayinput();
    startinput();
    endinput();
    // 时刻表默认为空，由用户重新输入
    judge.time1 = 0;
    judge.time2 = 0;
    if (bcInput.value) {
      judge.bc = 1;
    }
    if (eTimeInput.value) {
      judge.e_time = 1;
      msgout(eTimeInput, eTimeTest, '已加载数据', 1);
    }
  }, 100);

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // 草稿：按「自动保存」开关决定是否绑定（开 = 用户一动手就有人接盘），再尝试恢复。
  // 恢复写的是 input.value，不触发 input 事件，所以不会被自动保存当成「用户改动」。
  // 恢复要放在上面的 100ms 校验之后：那段校验会把 judge.time1 / judge.time2 归零，
  // 若恢复先跑，时间表文本会被当成「未校验」而在提交时被忽略。
  applyAutoSaveSwitch();
  setTimeout(() => {
    restoreDraft().catch((e) => console.warn('[timetable-result] 恢复草稿失败，已忽略', e));
  }, 150);
}

// ─── 事件绑定 ────────────────────────────────

backBtn.addEventListener('click', () => {
  window.location.href = '/my-timetable.html';
});

editRetryBtn.addEventListener('click', loadData);

submitBtn.addEventListener('click', submitEdit);

// 「清空表单」= 用户主动要一张白纸，连草稿一起清掉，免得刷新后又把旧内容恢复回来
resetBtn.addEventListener('click', () => {
  cleanall();
  clearDraft(draftPage, draftId);
  setDraftStatus('');
});

// 「保存快照」：把当前表单存成一份存档（自动保存不会往快照列表里加，只能由用户点这里）
if (draftSaveBtn) {
  draftSaveBtn.addEventListener('click', () => {
    const snapId = saveSnapshot(draftPage, draftId, snapshotLabel(), draftFields());
    if (!snapId) {
      showMessage('快照保存失败（浏览器可能禁用了本地存储，或内容超过 8KB）', true);
      return;
    }
    if (autoSave) autoSave.flush();   // 顺带把单草稿刷一次，刷新页面仍能续填
    setDraftStatus(`快照已保存 · ${formatClock(Date.now())}`);
    showMessage('快照已保存', false);
    renderSnapshotPanel();            // 面板开着就顺手刷新
  });
}

// 「还原…」：在表单下方展开 / 收起快照列表（内联面板，不用模态弹窗遮挡表单）
if (draftRestoreBtn && snapPanelEl) {
  draftRestoreBtn.addEventListener('click', () => {
    if (snapPanelEl.classList.contains('hidden')) {
      renderSnapshotPanel();
      snapPanelEl.classList.remove('hidden');
      return;
    }
    closeSnapshotPanel();
  });
}

// 列表内部走事件委托：面板每重建一次不用重新绑定
if (snapListEl) {
  snapListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-snap]');
    if (!btn) return;
    const snapId = btn.dataset.snap || '';
    if (btn.dataset.act === 'restore') {
      if (!restoreSnapshot(snapId)) showMessage('这份快照已不存在', true);
      return;
    }
    deleteSnapshot(draftPage, draftId, snapId);
    renderSnapshotPanel();
    setDraftStatus(`快照已删除 · ${formatClock(Date.now())}`);
  });
}

// 「自动保存」开关：开 = 改动即自动保存、恢复时静默不弹窗；关 = 不自动保存（仍可手动保存快照）、恢复时询问。
// 开关本身存 localStorage，下次进来仍然有效。
if (autoSaveToggle) {
  autoSaveToggle.checked = isUnattended();
  autoSaveToggle.addEventListener('change', () => {
    const on = autoSaveToggle.checked;
    setUnattended(on);
    applyAutoSaveSwitch();
    showMessage(on ? '已开启自动保存：改动随手保存，恢复时不再询问' : '已关闭自动保存（仍可手动保存快照）', false);
  });
}

time1c.addEventListener('click', time1cl);
time2c.addEventListener('click', time2cl);

cityInput.addEventListener('input', cityinput);
wayInput.addEventListener('input', wayinput);
startInput.addEventListener('input', startinput);
endInput.addEventListener('input', endinput);
time1Input.addEventListener('input', time1input);
time2Input.addEventListener('input', time2input);
bcInput.addEventListener('input', bcinput);
eTimeInput.addEventListener('input', e_timeinput);

// 城市框：在已有的 <input id="city"> 外面套上同样的下拉（逻辑见 lib/data/city-picker.mjs）
// 输入框本身会被原样保留（id / name / required 不变），所以取值与校验代码不用改
//   hint: false   —— 提示交给既有的 citytest 校验
//   formatPicked  —— 选中就直接写库里的入库写法「江苏省 无锡市」（带市）
const cityPicker = await attachCityPicker('#city', {
  hint: false,
  formatPicked: (item) => formatCityForStorage(item),
  onPick() { cityinput(); }
});

// ─── 启动 ────────────────────────────────────

loadData();
