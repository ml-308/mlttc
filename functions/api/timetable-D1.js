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
        'SELECT id FROM TIMETABLE WHERE CITY = ?1 AND WAY = ?2'
    ).bind(city.trim(), way.trim()).first();

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

//Get
export async function onRequestGet({request,env}){
    const url=new URL(request.url);
    const city=url.searchParams.get("city");
    const way=url.searchParams.get("way");
    const id=url.searchParams.get("id");
  if (id && id !== '0') {
    console.log("按 ID 查询");
    try {
      const { results } = await env.mlttcd.prepare(
        'SELECT * FROM TIMETABLE WHERE ID = ?'
      ).bind(id.trim()).all();

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
      return new Response(JSON.stringify({ error: '服务器内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (city && city !== '0' && way && way !== '0') {
    console.log("按城市+线路查询");
    try {
      const { results } = await env.mlttcd.prepare(
        'SELECT * FROM TIMETABLE WHERE CITY = ? AND WAY = ?'
      ).bind(city.trim(), way.trim()).all();

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