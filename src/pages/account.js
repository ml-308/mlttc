// src/pages/account.js
/**
 * 个人主页（account.html）
 *
 * 职责：
 *   1. 拉取并展示资料：昵称 / 邮箱 / 城市 / 注册时间 + 身份徽章
 *      （身份由 /api/profile 返回的 role · roleLabel 决定，见 resolveRole）
 *   2. 修改昵称与城市（POST /api/update-profile）
 *   3. 「我的时刻表」列表：拉取、排序（被驳回 > 待审核 > 已通过）、修改、删除
 *
 * 依赖：/lib/ui/popup.mjs、/lib/ui/message.mjs
 */
import { showConfirm } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';

// 验证提示（参考 timetables.js 的 msgout）
function msgout(input, test, msg, judge) {
  if (judge === 1) {
    input.style.borderColor = '#1eff01';
    test.style.color = '#1eff01';
    test.textContent = msg;
    test.style.display = 'block';
  } else if (judge === 0) {
    input.style.borderColor = '#ff0000';
    test.style.color = '#ff0000';
    test.textContent = msg;
    test.style.display = 'block';
  } else if (judge === 2) {
    input.style.borderColor = '#8881';
    test.style.color = 'var(--text-secondary)';
    test.textContent = msg;
    test.style.display = 'none';
  } else if (judge === 3) {
    input.style.borderColor = '#f3f30e';
    test.style.color = '#f3f30e';
    test.textContent = msg;
    test.style.display = 'block';
  }
}

/**
 * 是否被驳回：以 BACK 列为准（BACK == 1 表示被管理员驳回）
 * 说明：SPECIAL 为“备注”字段，不再用于判断驳回状态；
 *       用户修改时刻表后，后端会将 BACK 置为 '-'（未驳回）
 */
function isRejected(item) {
  if (!item) return false;
  const back = item.BACK;
  return back !== undefined && back !== null && String(back).trim() === '1';
}

/** 列表排序权重：被驳回 > 待审核 > 已通过 */
function timetableLevel(item) {
  if (isRejected(item)) return 2;
  if (item.PASS == true) return 0;
  return 1;
}

/**
 * 身份定义：key → 显示名与标识颜色
 * 颜色对应 style/main.css 中的 --role-* 变量，如需调整只改那里即可
 */
const ROLE_INFO = {
  admin: { label: '管理员', color: 'var(--role-admin)' },
  station: { label: '站长', color: 'var(--role-station)' },
  user: { label: '普通用户', color: 'var(--role-user)' }
};

/**
 * 解析用户身份
 * 优先使用后端 /api/profile 返回的 role / roleLabel；
 * 若后端未返回（旧响应），则按 adm 原始值兜底判断（兼容大小写与前后空格）
 * @returns {{key:'admin'|'station'|'user', label:string, color:string}}
 */
function resolveRole(user) {
  if (!user) return { key: 'user', ...ROLE_INFO.user };

  const key = String(user.role ?? '').trim().toLowerCase();
  if (ROLE_INFO[key]) {
    return { key, label: user.roleLabel || ROLE_INFO[key].label, color: ROLE_INFO[key].color };
  }

  // 兜底：后端未返回 role 时按 adm 原始值判断
  // 注意 adm 已 toLowerCase()，所以比对值必须用小写
  const adm = String(user.adm ?? '').trim().toLowerCase();
  let fallbackKey = 'user';
  if (adm === 'adm' || adm === 'admin') fallbackKey = 'admin';
  else if (adm === 'station' || adm === '站长') fallbackKey = 'station';
  return { key: fallbackKey, ...ROLE_INFO[fallbackKey] };
}

async function loadProfile() {
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (!res.ok) {
      document.getElementById('profileDisplayName').textContent = '未登录';
      return;
    }
    const data = await res.json();
    const user = data.user || data;
    document.getElementById('profileDisplayName').textContent = user.NAME || '未设置昵称';
    document.getElementById('profileEmail').textContent = user.email || '—';
    document.getElementById('profileCity').textContent = user.city || '未设置';
    if (user.registertime) {
      document.getElementById('profileRegDate').textContent = user.registertime;
    }
    // 显示身份（优先用后端返回的 role/roleLabel，缺失时按 adm 兜底）
    const typeEl = document.getElementById('profileAccountType');
    if (typeEl) {
      const role = resolveRole(user);
      typeEl.textContent = role.label;
      typeEl.style.background = role.color;
      typeEl.dataset.role = role.key;
    }
    // 更新 cookie 中的昵称（无论是否有值，都写入以便 header 判断登录状态）
    document.cookie = `user_name=${encodeURIComponent(user.NAME || '')}; Path=/; Max-Age=3600; SameSite=Lax`;
    if (user.NAME) document.getElementById('nameInput').placeholder = user.NAME;
    if (user.city) document.getElementById('cityInput').placeholder = user.city;
  } catch (e) {
    console.error('加载用户信息失败:', e);
  }
}

async function saveProfile(name, city) {
  const body = {};
  if (name !== undefined && name !== null) body.NAME = name;
  if (city !== undefined && city !== null) body.city = city;

  const res = await fetch('/api/update-profile', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok) {
    if (res.status === 409) {
      showMessage((data.error || '该昵称已被使用'), true);
    } else {
      showMessage((data.error || '保存失败'), true);
    }
    return false;
  }

  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();

  // 返回按钮
  document.getElementById('backBtn')?.addEventListener('click', () => window.location.href = '/index.html');

  // 登录按钮由 /src/pages/main.js 统一绑定（account.html 已包含 #globalLoginModal 结构）。
  // 原先此处也绑了一份，逻辑重复，故删除。

  // 退出按钮由 /src/auth-header.js 统一绑定。
  // 原先此处也绑了一份并跳转 /login.html（不存在 → 404），且与页头模块重复触发。

  // 实时验证：昵称（最多6字）
  const nameInput = document.getElementById('nameInput');
  const nameMsg = document.getElementById('nameMsg');
  if (nameInput && nameMsg) {
    nameInput.addEventListener('input', () => {
      const v = nameInput.value;
      if (v.includes('@')) {
        msgout(nameInput, nameMsg, '昵称不能包含@字符', 0);
      } else if (v.length > 6) {
        msgout(nameInput, nameMsg, '昵称不能超过6个字符', 0);
      } else if (v.length > 0) {
        msgout(nameInput, nameMsg, '✓ 昵称格式正确', 1);
      } else {
        msgout(nameInput, nameMsg, '', 2);
      }
    });
  }

  // 实时验证：城市（最多6字）
  const cityInput = document.getElementById('cityInput');
  const cityMsg = document.getElementById('cityMsg');
  if (cityInput && cityMsg) {
    cityInput.addEventListener('input', () => {
      const v = cityInput.value;
      if (v.length > 6) {
        msgout(cityInput, cityMsg, '城市名不能超过6个字符', 0);
      } else if (v.length > 0) {
        msgout(cityInput, cityMsg, '✓ 城市名格式正确', 1);
      } else {
        msgout(cityInput, cityMsg, '', 2);
      }
    });
  }

  // ─── 加载我的时刻表 ─────────────────────────────
  let myEmail = '';
  loadMyTimetables();

  // 保存按钮
  document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const name = nameInput?.value.trim() || null;
    const city = cityInput?.value.trim() || null;

    // 提交前再次校验
    if (name && name.includes('@')) {
      showMessage('昵称不能包含@字符', true);
      return;
    }
    if (name && name.length > 6) {
      showMessage('昵称不能超过6个字符', true);
      return;
    }
    if (city && city.length > 6) {
      showMessage('城市名不能超过6个字符', true);
      return;
    }
    if (!name && !city) {
      showMessage('请至少填写一项', true);
      return;
    }

    const ok = await saveProfile(name, city);
    if (ok) {
      showMessage('保存成功', false);
      if (name) {
        document.getElementById('profileDisplayName').textContent = name;
        nameInput.placeholder = name;
        nameInput.value = '';
        msgout(nameInput, nameMsg, '', 2);
        document.cookie = `user_name=${encodeURIComponent(name)}; Path=/; Max-Age=3600; SameSite=Lax`;
      }
      if (city) {
        document.getElementById('profileCity').textContent = city;
        cityInput.placeholder = city;
        cityInput.value = '';
        msgout(cityInput, cityMsg, '', 2);
      }
    }
  });

  // ─── 我的时刻表 - 渲染（一次性展示全部） ─────────
  let myTimetables = [];

  const ttList = document.getElementById('timetable-list');
  const ttLoading = document.getElementById('timetable-loading');
  const ttEmpty = document.getElementById('timetable-empty');
  const ttError = document.getElementById('timetable-error');

  async function loadMyTimetables() {
    // 先获取用户邮箱
    let email = '';
    myEmail = '';
    try {
      const res = await fetch('/api/profile', { credentials: 'include' });
      if (!res.ok) {
        ttLoading.classList.add('hidden');
        ttError.classList.remove('hidden');
        ttError.textContent = '请先登录';
        return;
      }
      const data = await res.json();
      const user = data.user || data;
      email = user.email || '';
      if (!email) {
        ttLoading.classList.add('hidden');
        ttError.classList.remove('hidden');
        ttError.textContent = '无法获取用户信息';
        return;
      }
    } catch (e) {
      ttLoading.classList.add('hidden');
      ttError.classList.remove('hidden');
      ttError.textContent = '获取用户信息失败';
      return;
    }
    myEmail = email;

    // 尝试从 sessionStorage 读取缓存
    const CACHE_KEY = 'account_tt_cache';
    let cached = null;
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch { /* ignore */ }

    if (cached && cached.email === email && Array.isArray(cached.data)) {
      // 缓存命中，直接使用
      myTimetables = cached.data;
      // 被驳回 > 待审核 > 已通过 排序
      myTimetables.sort((a, b) => timetableLevel(b) - timetableLevel(a));
      ttLoading.classList.add('hidden');

      if (myTimetables.length === 0) {
        ttEmpty.classList.remove('hidden');
      } else {
        ttEmpty.classList.add('hidden');
        renderMyPage();
      }
      return;
    }

    // 缓存未命中，从 D1 查询
    try {
      const res = await fetch(`/api/timetable-D1?writer=${encodeURIComponent(email)}`, {
        credentials: 'include'
      });
      if (!res.ok) {
        ttLoading.classList.add('hidden');
        ttError.classList.remove('hidden');
        ttError.textContent = '获取时刻表失败';
        return;
      }
      const json = await res.json();
      if (!json.success) {
        ttLoading.classList.add('hidden');
        ttEmpty.classList.remove('hidden');
        return;
      }

      myTimetables = json.data || [];
      // 被驳回 > 待审核 > 已通过 排序
      myTimetables.sort((a, b) => timetableLevel(b) - timetableLevel(a));

      // 写入缓存
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ email, data: myTimetables }));
      } catch { /* ignore */ }

      ttLoading.classList.add('hidden');

      if (myTimetables.length === 0) {
        ttEmpty.classList.remove('hidden');
        return;
      }

      ttEmpty.classList.add('hidden');
      renderMyPage();
    } catch (e) {
      ttLoading.classList.add('hidden');
      ttError.classList.remove('hidden');
      ttError.textContent = '网络错误';
    }
  }

  function renderMyPage() {
    // 一次性渲染全部时刻表
    ttList.innerHTML = '';
    myTimetables.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'result-item';
      card.style.animationDelay = `${idx * 0.05}s`;

      const time1Display = formatTimeDisplay(item.TIMEONE);
      const time2Display = formatTimeDisplay(item.TIMETWO);

      card.innerHTML = `
        <div class="result-item-header">
          <span class="result-item-id">#${item.ID}</span>
          <span class="result-item-route">${item.CITY} · ${item.WAY}</span>
        </div>
        <div class="result-item-body">
          <div class="result-item-stations">
            <span class="station-name">${item.START}</span>
            <span class="station-arrow">↔</span>
            <span class="station-name">${item.END}</span>
          </div>
          ${item.SPECIAL && item.SPECIAL !== '无' ? `<div class="result-item-note">${item.SPECIAL}</div>` : ''}
          <div class="result-item-meta">
            <span>执行: ${(!item.STARTTIME || item.STARTTIME === '1000-1-1') ? '未知执行时间' : item.STARTTIME}</span>
            <span>写入: ${item.WRITETIME || '未知'}</span>
            <span style="font-weight:600; ${
              isRejected(item) ? 'color:var(--danger);' :
              item.PASS == true ? 'color:var(--success);' :
              'color:var(--warning);'
            }">${
              isRejected(item) ? '被驳回' :
              item.PASS == true ? '已通过' :
              '待审核'
            }</span>
          </div>
        </div>
        <div class="result-item-actions">
          <hcw-button class="detail-btn" flat style="min-width:5rem; font-size:0.82rem;">查看详情</hcw-button>
          <hcw-button class="edit-btn" flat style="min-width:5rem; font-size:0.82rem;">修改时刻表</hcw-button>
          <hcw-button class="delete-btn" flat style="min-width:5rem; font-size:0.82rem; color:var(--danger);">删除</hcw-button>
        </div>
      `;

      // 查看详情按钮
      // from=account 让详情页的「返回」按钮回到本页（详情页已合并为单页）
      card.querySelector('.detail-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = `/timetable-detail.html?id=${encodeURIComponent(item.ID)}&from=account`;
      });

      // 修改时刻表按钮
      card.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = `/timetable-result.html?id=${encodeURIComponent(item.ID)}`;
      });

      // 删除按钮
      card.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirm({
          text: `确定要删除 #${item.ID} 时刻表吗？此操作不可恢复。`,
          buttons: ['确定删除', '取消'],
          button_style: ['danger', '']
        });
        if (!confirmed) return;

        try {
          const res = await fetch('/api/timetable-D1', {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.ID, writer: myEmail })
          });
          const data = await res.json();
          if (data.success) {
            showMessage('删除成功', false);
            // 清除缓存并重新加载
            sessionStorage.removeItem('account_tt_cache');
            loadMyTimetables();
          } else {
            showMessage(data.error || '删除失败', true);
          }
        } catch (err) {
          showMessage('删除失败: 网络错误', true);
        }
      });

      ttList.appendChild(card);
    });
  }

  // 刷新按钮
  document.getElementById('tt-refresh-btn')?.addEventListener('click', () => {
    sessionStorage.removeItem('account_tt_cache');
    loadMyTimetables();
    showMessage('已刷新', false);
  });

  function formatTimeDisplay(timeStr) {
    if (!timeStr || timeStr === 'unknown') return '未知';
    const parts = timeStr.split(/[\t\n\r]+/).filter(t => t.trim());
    if (parts.length <= 6) {
      return parts.join(' ');
    }
    return parts.slice(0, 6).join(' ') + ` ... (+${parts.length - 6}个)`;
  }
});
