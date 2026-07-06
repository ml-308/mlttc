// ─── 管理员专用 API ─────────────────────────────

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

    // 在 JS 层分类，减少数据库 2/3 的查询
    const unreviewed = [];
    const rejected = [];
    const reviewed = [];

    for (const row of results) {
      if (row.PASS === 1) {
        reviewed.push(row);
      } else if (row.SPECIAL && row.SPECIAL.includes('【时刻表被驳回】')) {
        rejected.push(row);
      } else {
        unreviewed.push(row);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      unreviewed,
      rejected,
      reviewed
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('管理员查询错误:', err);
    return new Response(JSON.stringify({ error: '服务器内部错误' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─── POST: 审核操作（通过/驳回）─────────────────
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

    // 通过操作：设置 PASS=1 和 PASSER（直接 UPDATE，用 changes 判断存在性）
    if (action === 'approve' || (pass !== undefined && Number(pass) === 1)) {
      const result = await env.mlttcd.prepare(
        'UPDATE TIMETABLE SET PASS = 1, PASSER = ? WHERE ID = ?'
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

    // 驳回操作：PASS 保持 0，在备注追加驳回标记
    if (action === 'reject') {
      // 先获取当前 SPECIAL 值以追加驳回标记
      const existing = await env.mlttcd.prepare(
        'SELECT SPECIAL FROM TIMETABLE WHERE ID = ?'
      ).bind(id).first();

      if (!existing) {
        return new Response(JSON.stringify({ error: '记录不存在' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }

      const newSpecial = existing.SPECIAL && existing.SPECIAL !== '无'
        ? existing.SPECIAL + '【时刻表被驳回】'
        : '【时刻表被驳回】';
      await env.mlttcd.prepare(
        'UPDATE TIMETABLE SET PASS = 0, SPECIAL = ?, PASSER = ? WHERE ID = ?'
      ).bind(newSpecial, passer || '管理员', id).run();

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
