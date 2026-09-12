// src/pages/timetable-result.js
/**
 * 修改时刻表页（timetable-result.html?id=xxx）
 * 从个人主页「我的时刻表」的「修改」按钮进入
 *
 * 流程：按 ?id= 拉取原记录 → 填入表单 → 逐字段校验 → 提交修改（POST /api/timetable-D1）
 * 注意：修改后由**服务端**把 PASS 重置为 0（重新进入待审核），客户端不传 pass
 *
 * 依赖：/lib/ui/popup.mjs、/lib/ui/message.mjs、/lib/timetable.mjs
 */
import { showPrompt } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';
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
  let city = cityInput.value;
  city = Complete(city, '市');
  if (city == null) {
    judge.city = 0;
    msgout(cityInput, cityTest, '请输入城市', 0);
  } else {
    judge.city = 1;
    msgout(cityInput, cityTest, '"' + city + '" 符合格式规范', 1);
  }
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
  const city = Complete(cityInput.value, '市');
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

async function submitEdit() {
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

  // 城市
  const newCity = Complete(cityInput.value, '市');
  if (newCity && judge.city === 1) {
    const origCity = Complete(originalData.CITY, '市');
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

    if (!response.ok) {
      const errMsg = result.message || result.error || '提交失败';
      showMessage(errMsg, true);
      return;
    }

    showMessage('修改成功', false);
    // 清除个人主页缓存，确保下次加载最新数据
    sessionStorage.removeItem('account_tt_cache');
    setTimeout(() => {
      window.location.href = '/account.html';
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
}

// ─── 事件绑定 ────────────────────────────────

backBtn.addEventListener('click', () => {
  window.location.href = '/account.html';
});

editRetryBtn.addEventListener('click', loadData);

submitBtn.addEventListener('click', submitEdit);

resetBtn.addEventListener('click', cleanall);

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

// ─── 启动 ────────────────────────────────────

loadData();
