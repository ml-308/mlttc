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

    // 解构需要的字段（id 不再需要）
    let { city, way, start, end, special, time1, time2, etime, writetime, writer } = body;

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
    let id;
    let idExists = true;
    while (idExists) {
        id = generate12DigitString();
        const existingId = await env.mlttcd.prepare(
            'SELECT id FROM TIMETABLE WHERE id = ?1'
        ).bind(id).first();
        idExists = !!existingId;
    }

    // ----- 插入数据 -----
    try {
        await env.mlttcd.prepare(`
            INSERT INTO TIMETABLE (ID, CITY, WAY, START, END, SPECIAL, TIMEONE, TIMETWO, STARTTIME, WRITER, WRITETIME, PASSER)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        `).bind(
            id,
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
            '-'
        ).run();

        return new Response(JSON.stringify({
            success: true,
            id: id,
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
    // 1. 频率限制检查
    const rateLimitResponse = await checkRateLimit(request, env);
    if (rateLimitResponse) return rateLimitResponse;

    const url=new URL(request.url);
    const city=url.searchParams.get("city");
    const way=url.searchParams.get("way");
    const id=url.searchParams.get("id");
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
      const { results } = await env.mlttcd.prepare(
        'SELECT * FROM TIMETABLE WHERE ID = ?'
      ).bind(cleanId).all();

      if (results.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          message: '未找到该记录'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        success: true,
        data: results[0]          
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      console.error('ID 查询错误:', err);
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (city && city !== '0' && way && way !== '0') {
    // 模糊搜索——参数长度校验（防止超长输入导致数据库压力）
    const cleanCity = validateSearchParam(city, 20);
    const cleanWay = validateSearchParam(way, 50);
    if (!cleanCity || !cleanWay) {
      return new Response(JSON.stringify({
        success: false,
        message: '参数格式无效（城市不超过20字，线路不超过50字）'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    console.log("按城市+线路模糊查询");
    try {
      const { results } = await env.mlttcd.prepare(
        'SELECT * FROM TIMETABLE WHERE CITY LIKE ? AND WAY LIKE ? LIMIT 50'
      ).bind(`%${cleanCity}%`, `%${cleanWay}%`).all();

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
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response(JSON.stringify({
    success: false,
    message: '请提供 id 或 city+way 参数'
  }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}