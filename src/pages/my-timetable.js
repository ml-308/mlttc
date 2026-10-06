// src/pages/my-timetable.js
/**
 * 我的时刻表（my-timetable.html）
 *
 * 原属个人主页（account.html / account.js）的「我的时刻表」区块，现拆分为独立页面。
 *
 * 职责：
 *   1. 按当前登录用户拉取时刻表列表（GET /api/timetable-D1?writer=邮箱）
 *   2. 排序：被驳回 > 待审核 > 已通过
 *   3. 每条卡片提供「查看详情 / 修改时刻表 / 删除」（DELETE /api/timetable-D1）
 *
 * 依赖：/lib/ui/popup.mjs（确认弹窗）、/lib/ui/message.mjs（提示）、/lib/ui/guard.mjs（防重复点击）
 */
import { showConfirm } from '/lib/ui/popup.mjs';
import { showMessage } from '/lib/ui/message.mjs';

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

document.addEventListener('DOMContentLoaded', () => {
  // 返回按钮：本页是导航栏里的顶层页面，返回到首页
  document.getElementById('backBtn')?.addEventListener('click', () => window.location.href = '/index.html');

  // 登录按钮由 /src/pages/main.js 统一绑定（本页已包含 #globalLoginModal 结构）。

  // ─── 我的时刻表 - 渲染（一次性展示全部） ─────────
  let myEmail = '';
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
    const CACHE_KEY = 'my_timetable_cache';
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
      // from=mine 让详情页的「返回」按钮回到本页（详情页已合并为单页）
      card.querySelector('.detail-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = `/timetable-detail.html?id=${encodeURIComponent(item.ID)}&from=mine`;
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
            sessionStorage.removeItem('my_timetable_cache');
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
    sessionStorage.removeItem('my_timetable_cache');
    loadMyTimetables();
    showMessage('已刷新', false);
  });

  // ─── 加载我的时刻表 ─────────────────────────────
  loadMyTimetables();
});
