// 生成12位安全随机数字（字符串）
function generate12DigitString() {
    const array = new Uint32Array(3);
    crypto.getRandomValues(array);
    let num = '';
    for (let i = 0; i < 3; i++) {
        num += String(array[i] % 10000).padStart(4, '0');
    }
    return num;
}

export async function onRequestPost({ request, env }) {
    const body = await request.json().catch(() => null);
    if (!body) {
        return new Response(JSON.stringify({ error: '无效的请求数据' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    let { id, city, way, start, end, special, time1, time2, etime, writetime, writer, pass } = body;

    // ─── 更新模式（id 存在时）─────────────────────────
    if (id) {
        if (!writer || typeof writer !== 'string' || writer.trim().length === 0) {
            return new Response(JSON.stringify({ error: '作者不能为空' }), { status: 400 });
        }
        if (!writetime || typeof writetime !== 'string' || writetime.trim().length === 0) {
            return new Response(JSON.stringify({ error: '写入时间不能为空' }), { status: 400 });
        }

        // 动态构建 UPDATE SET 子句
        const sets = [];
        const params = [];

        if (city !== undefined && city !== null && typeof city === 'string' && city.trim().length > 0) {
            sets.push('CITY = ?');
            params.push(city.trim());
        }
        if (way !== undefined && way !== null && typeof way === 'string' && way.trim().length > 0) {
            sets.push('WAY = ?');
            params.push(way.trim());
        }
        if (start !== undefined && start !== null && typeof start === 'string' && start.trim().length > 0) {
            sets.push('START = ?');
            params.push(start.trim());
        }
        if (end !== undefined && end !== null && typeof end === 'string' && end.trim().length > 0) {
            sets.push('END = ?');
            params.push(end.trim());
        }
        if (special !== undefined && special !== null && typeof special === 'string') {
            sets.push('SPECIAL = ?');
            params.push(special.trim().length > 0 ? special.trim() : '无');
        }
        if (time1 !== undefined && time1 !== null && typeof time1 === 'string' && time1.trim().length > 0) {
            sets.push('TIMEONE = ?');
            params.push(time1.trim());
        }
        if (time2 !== undefined && time2 !== null && typeof time2 === 'string' && time2.trim().length > 0) {
            sets.push('TIMETWO = ?');
            params.push(time2.trim());
        }
        if (etime !== undefined && etime !== null && typeof etime === 'string' && etime.trim().length > 0) {
            sets.push('STARTTIME = ?');
            params.push(etime.trim());
        }
        if (pass !== undefined && pass !== null) {
            const passVal = Number(pass);
            if (passVal === 0 || passVal === 1) {
                sets.push('PASS = ?');
                params.push(passVal);
            }
        }

        // ─── 被驳回后重新提交：标记已修改驳回 ────────
        const existingRow = await env.mlttcd.prepare(
            'SELECT SPECIAL FROM TIMETABLE WHERE ID = ?'
        ).bind(id).first();
        if (existingRow && existingRow.SPECIAL === '时刻表被驳回') {
            // 用户提交了新的 special → 追加标记；否则自动设为标记
            if (special !== undefined && special !== null && typeof special === 'string') {
                const userVal = special.trim().length > 0 ? special.trim() : '无';
                // 替换 sets 中已有的 SPECIAL 项或新增
                const spIdx = sets.findIndex(s => s.startsWith('SPECIAL'));
                if (spIdx !== -1) {
                    params[spIdx] = userVal + '（已修改驳回）';
                } else {
                    sets.push('SPECIAL = ?');
                    params.push(userVal + '（已修改驳回）');
                }
            } else {
                // 用户未修改备注，自动标记
                sets.push('SPECIAL = ?');
                params.push('已修改驳回');
            }
        }

        if (sets.length === 0) {
            return new Response(JSON.stringify({ error: '没有提供需要更新的字段' }), {
                status: 400, headers: { 'Content-Type': 'application/json' }
            });
        }

        // 始终更新写入时间
        sets.push('WRITETIME = ?');
        params.push(writetime.trim());
        params.push(id);
        params.push(writer.trim());

        try {
            // 使用条件 UPDATE + 作者验证，一次查询代替 SELECT + UPDATE 两次
            const result = await env.mlttcd.prepare(
                `UPDATE TIMETABLE SET ${sets.join(', ')} WHERE ID = ? AND WRITER = ?`
            ).bind(...params).run();

            // D1 的 result.meta.changes > 0 表示有行被更新
            if (!result.meta || result.meta.changes === 0) {
                // 检查记录是否存在（区分"不存在"和"无权限"）
                const existing = await env.mlttcd.prepare(
                    'SELECT ID FROM TIMETABLE WHERE ID = ?'
                ).bind(id).first();

                if (!existing) {
                    return new Response(JSON.stringify({ error: '记录不存在' }), {
                        status: 404, headers: { 'Content-Type': 'application/json' }
                    });
                }
                return new Response(JSON.stringify({ error: '无权修改此记录' }), {
                    status: 403, headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response(JSON.stringify({
                success: true,
                id: id,
                message: '更新成功'
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch (err) {
            console.error('更新错误:', err);
            return new Response(JSON.stringify({ error: '数据库更新失败' }), {
                status: 500, headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    // ─── 新增模式（无 id）─────────────────────────
    // ----- 参数校验 -----
    if (!city || typeof city !== 'string' || city.trim().length === 0) {
        return new Response(JSON.stringify({ error: '城市不能为空' }), { status: 400 });
    }
    if (!way || typeof way !== 'string' || way.trim().length === 0) {
        return new Response(JSON.stringify({ error: '线路不能为空' }), { status: 400 });
    }
    if (!start || typeof start !== 'string' || start.trim().length === 0) {
        return new Response(JSON.stringify({ error: '起点不能为空' }), { status: 400 });
    }
    if (!end || typeof end !== 'string' || end.trim().length === 0) {
        return new Response(JSON.stringify({ error: '终点不能为空' }), { status: 400 });
    }
    if (!time1 || typeof time1 !== 'string' || time1.trim().length === 0) {
        return new Response(JSON.stringify({ error: '时刻表1不能为空' }), { status: 400 });
    }
    if (!time2 || typeof time2 !== 'string' || time2.trim().length === 0) {
        return new Response(JSON.stringify({ error: '时刻表2不能为空' }), { status: 400 });
    }
    if (!etime || typeof etime !== 'string' || etime.trim().length === 0) {
        return new Response(JSON.stringify({ error: '执行时间不能为空' }), { status: 400 });
    }
    if (!writer || typeof writer !== 'string' || writer.trim().length === 0) {
        return new Response(JSON.stringify({ error: '作者不能为空' }), { status: 400 });
    }
    if (!writetime || typeof writetime !== 'string' || writetime.trim().length === 0) {
        return new Response(JSON.stringify({ error: '写入时间不能为空' }), { status: 400 });
    }

    // 处理 special 字段（可选）
    const specialValue = (typeof special === 'string' && special.trim().length > 0) ? special.trim() : '无';

    // ----- 城市+线路查重 -----
    const existingRoute = await env.mlttcd.prepare(
        'SELECT id FROM TIMETABLE WHERE CITY = ?1 AND WAY = ?2 AND START = ?3 AND END = ?4 AND TIMEONE = ?5 AND TIMETWO = ?6'
    ).bind(city.trim(), way.trim(), start.trim(), end.trim(), time1.trim(), time2.trim()).first();

    if (existingRoute) {
        return new Response(JSON.stringify({
            success: false,
            message: '该时刻表已存在'
        }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // ----- 生成唯一 ID（循环查重）-----
    let newId;
    let idExists = true;
    while (idExists) {
        newId = generate12DigitString();
        const existingId = await env.mlttcd.prepare(
            'SELECT id FROM TIMETABLE WHERE id = ?1'
        ).bind(newId).first();
        idExists = !!existingId;
    }

    // ----- 插入数据 -----
    try {
        await env.mlttcd.prepare(`
            INSERT INTO TIMETABLE (ID, CITY, WAY, START, END, SPECIAL, TIMEONE, TIMETWO, STARTTIME, WRITER, WRITETIME, PASSER, PASS)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        `).bind(
            newId,
            city.trim(),
            way.trim(),
            start.trim(),
            end.trim(),
            specialValue,
            time1.trim(),
            time2.trim(),
            etime.trim(),
            writer.trim(),
            writetime.trim(),
            '-',
            0
        ).run();

        return new Response(JSON.stringify({
            success: true,
            id: newId,
            message: '添加成功'
        }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        console.error('插入错误:', err);
        return new Response(JSON.stringify({ error: '数据库写入失败' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// ─── 频率限制辅助 ─────────────────────────────────────────────
// 基于 KV 的简单 IP 频率限制，防止异常流量
async function checkRateLimit(request, env) {
  const MAX_REQUESTS = 30;          // 最大请求次数
  const WINDOW_SECONDS = 60;        // 时间窗口（秒）

  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';

  const now = Math.floor(Date.now() / 1000);
  const key = `ratelimit:search:${ip}`;

  // 读取当前记录
  let record;
  try {
    record = await env.mlttckv.get(key, { type: 'json' });
  } catch {
    record = null;
  }

  if (record && record.window === now) {
    // 同一秒内
    record.count += 1;
  } else if (record && now - record.window < WINDOW_SECONDS) {
    // 仍在时间窗口内
    record.count += 1;
    record.window = record.window; // 保持窗口起始时间
  } else {
    // 新窗口
    record = { window: now, count: 1 };
  }

  // 写回 KV（不 await，不阻塞响应）
  env.mlttckv.put(key, JSON.stringify(record), { expirationTtl: WINDOW_SECONDS * 2 }).catch(() => {});

  // 超过阈值则拒绝
  if (record.count > MAX_REQUESTS) {
    return new Response(JSON.stringify({
      success: false,
      message: '请求过于频繁，请稍后再试'
    }), { status: 429, headers: { 'Content-Type': 'application/json' } });
  }

  return null; // 通过
}

// ─── 参数校验辅助 ─────────────────────────────────────────────
function validateSearchParam(value, maxLen) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

//Get
export async function onRequestGet({request,env}){
    try {
        // 1. 频率限制检查
        const rateLimitResponse = await checkRateLimit(request, env);
        if (rateLimitResponse) return rateLimitResponse;

        const url = new URL(request.url);
        const city = url.searchParams.get("city");
        const way = url.searchParams.get("way");
        const id = url.searchParams.get("id");

        if (id && id !== '0') {
            // ID 查询（精确匹配，受控参数）
            const cleanId = validateSearchParam(id, 20);
            if (!cleanId) {
                return new Response(JSON.stringify({
                    success: false,
                    message: 'ID 格式无效'
                }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }

            console.log("按 ID 查询");
            try {
                const row = await env.mlttcd.prepare(
                    `SELECT t.*, u.NAME as WRITER_NAME
                     FROM TIMETABLE t
                     LEFT JOIN USER u ON u.EMAIL = t.WRITER
                     WHERE t.ID = ?`
                ).bind(cleanId).first();

                if (!row) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: '未找到该记录'
                    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                }

                return new Response(JSON.stringify({
                    success: true,
                    data: row
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            } catch (err) {
                console.error('ID 查询错误:', err);
                return new Response(JSON.stringify({ error: '服务器内部错误' }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        // ─── 按作者(邮箱)查询 ──────────────────────────
        const writer = url.searchParams.get('writer');
        if (writer) {
            const cleanWriter = validateSearchParam(writer, 100);
            if (cleanWriter) {
                console.log("按作者查询:", cleanWriter);
                try {
                    const { results } = await env.mlttcd.prepare(
                        `SELECT t.*, u.NAME as WRITER_NAME
                         FROM TIMETABLE t
                         LEFT JOIN USER u ON u.EMAIL = t.WRITER
                         WHERE t.WRITER = ? ORDER BY t.WRITETIME DESC`
                    ).bind(cleanWriter).all();

                    return new Response(JSON.stringify({
                        success: true,
                        data: results,
                        count: results.length
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                } catch (err) {
                    console.error('作者查询错误:', err);
                    return new Response(JSON.stringify({ error: '服务器内部错误' }), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }
        }

        const q = url.searchParams.get('q');
        if (city || way || q) {
            // 支持按城市、线路或通用关键词搜索
            let query = 'SELECT t.*, u.NAME as WRITER_NAME FROM TIMETABLE t LEFT JOIN USER u ON u.EMAIL = t.WRITER WHERE t.PASS=1 AND';
            const params = [];
            const conditions = [];
            const orGroups = []; // 用于 OR 分组

            if (city) {
                const cleanCity = validateSearchParam(city, 20);
                if (cleanCity) {
                    conditions.push('t.CITY LIKE ? ');   // 添加 t. 前缀
                    params.push(`%${cleanCity}%`);
                }
            }
            if (way) {
                const cleanWay = validateSearchParam(way, 50);
                if (cleanWay) {
                    conditions.push('t.WAY LIKE ? ');    // 添加 t. 前缀
                    params.push(`%${cleanWay}%`);
                }
            }

            // 通用关键词 q：跨 CITY、WAY、START、END 多字段模糊搜索
            const cleanQ = validateSearchParam(q, 50);
            if (cleanQ) {
                const qConditions = [
                    't.CITY LIKE ?',   // 添加 t. 前缀
                    't.WAY LIKE ?',
                    't.START LIKE ?',
                    't.END LIKE ?'
                ];
                orGroups.push('(' + qConditions.join(' OR ') + ')');
                params.push(`%${cleanQ}%`, `%${cleanQ}%`, `%${cleanQ}%`, `%${cleanQ}%`);
            }

            if (conditions.length > 0 || orGroups.length > 0) {
                const whereClauses = [];
                if (conditions.length > 0) {
                    if (orGroups.length > 0) {
                        whereClauses.push('(' + conditions.join(' AND ') + ') OR ' + orGroups.join(' OR '));
                    } else {
                        whereClauses.push(conditions.join(' AND '));
                    }
                } else if (orGroups.length > 0) {
                    whereClauses.push(orGroups.join(' OR '));
                }
                whereClauses.push('t.PASS = 1');
                query += ' ' + whereClauses.join(' AND ');
            } else {
                return new Response(JSON.stringify({
                    success: false,
                    message: '参数格式无效'
                }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }

            query += ' LIMIT 200';

            console.log("组合查询:", query, params);
            try {
                const { results } = await env.mlttcd.prepare(query).bind(...params).all();

                if (results.length === 0) {
                    return new Response(JSON.stringify({
                        success: false,
                        message: '未找到符合条件的时刻表'
                    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
                }

                return new Response(JSON.stringify({
                    success: true,
                    data: results
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            } catch (err) {
                console.error('模糊查询错误:', err);
                return new Response(JSON.stringify({ error: '服务器内部错误' ,debug:err.stack,message:err.message}), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        // ─── 列出所有已添加的线路（city + way）─────────────────────
        const list = url.searchParams.get('list');
        if (list === 'all') {
            console.log("列出所有线路");
            try {
                const listQuery = 'SELECT DISTINCT CITY, WAY FROM TIMETABLE WHERE PASS = 1 ORDER BY CITY, WAY';
                const { results } = await env.mlttcd.prepare(listQuery).all();

                return new Response(JSON.stringify({
                    success: true,
                    data: results
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            } catch (err) {
                console.error('列出线路错误:', err);
                return new Response(JSON.stringify({ error: '服务器内部错误' ,debug:err.stack,message:err.message}), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response(JSON.stringify({
            success: false,
            message: '请提供 id 或 city+way 参数'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        return new Response(JSON.stringify({
            error: '服务器内部错误',
            debug: err.stack,        // 保留调试信息，定位其他潜在问题后建议移除
            message: err.message
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}