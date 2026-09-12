// ─── 管理员专用 API ─────────────────────────────

/**
 * 是否被驳回：以 BACK 列为准（BACK == 1 表示被驳回）
 * 注意：SPECIAL 为“备注”列，不再用于承载驳回标记
 */
function isRejected(row) {
  if (!row) return false;
  const back = row.BACK;
  return back !== undefined && back !== null && String(back).trim() === '1';
}

// ─── GET: 获取所有时刻表（已按状态分离）─────────
export async function onRequestGet({ request, env }) {
  try {
    // 一次查询全量数据，JS端分组，减少2次数据库查询
    const { results } = await env.mlttcd.prepare(
      `SELECT t.*, u.NAME as WRITER_NAME
       FROM TIMETABLE t
       LEFT JOIN USER u ON u.EMAIL = t.WRITER
       ORDER BY t.WRITETIME DESC`
    ).all();

    // 在 JS 层分类
    const unreviewed = [];
    const reviewed = [];
    const rejected = [];

    for (const row of results) {
      if (row.PASS === 1) {
        reviewed.push(row);
      } else if (isRejected(row)) {
        rejected.push(row);
      } else {
        unreviewed.push(row);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      unreviewed,
      reviewed,
      rejected
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('管理员查询错误:', err);
    return new Response(JSON.stringify({ error: '服务器内部错误' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─── POST: 审核操作────────────────────────────
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ error: '无效的请求数据' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const { id, passer, pass, action } = body;

    if (!id) {
      return new Response(JSON.stringify({ error: '缺少时刻表ID' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 通过操作：设置 PASS=1 和 PASSER，同时把驳回标记 BACK 复位为 '-'
    if (action === 'approve' || (pass !== undefined && Number(pass) === 1)) {
      const result = await env.mlttcd.prepare(
        `UPDATE TIMETABLE SET PASS = 1, PASSER = ?, BACK = '-'
         WHERE ID = ?`
      ).bind(passer || '管理员', id).run();

      if (!result.meta || result.meta.changes === 0) {
        return new Response(JSON.stringify({ error: '记录不存在' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ success: true, message: '已通过' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 驳回操作：BACK 置为 1（驳回标记），PASS 保持 0；SPECIAL 为备注列不再被占用
    if (action === 'reject') {
      const existing = await env.mlttcd.prepare(
        'SELECT ID FROM TIMETABLE WHERE ID = ?'
      ).bind(id).first();

      if (!existing) {
        return new Response(JSON.stringify({ error: '记录不存在' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }

      await env.mlttcd.prepare(
        'UPDATE TIMETABLE SET PASS = 0, BACK = 1, PASSER = ? WHERE ID = ?'
      ).bind(passer || '管理员', id).run();

      return new Response(JSON.stringify({ success: true, message: '已驳回' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: '未知操作' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('管理员操作错误:', err);
    return new Response(JSON.stringify({ error: '服务器内部错误' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─── DELETE: 删除时刻表 ─────────────────────────
export async function onRequestDelete({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    const id = body?.id;
    if (!id) {
      return new Response(JSON.stringify({ error: '缺少时刻表ID' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await env.mlttcd.prepare(
      'DELETE FROM TIMETABLE WHERE ID = ?'
    ).bind(id).run();

    if (!result.meta || result.meta.changes === 0) {
      return new Response(JSON.stringify({ message: '记录不存在' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, message: '已删除' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('管理员删除错误:', err);
    return new Response(JSON.stringify({ error: '服务器内部错误' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
