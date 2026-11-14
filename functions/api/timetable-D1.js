// functions/api/timetable-D1.js
// 接口地址：/api/timetable-D1 —— 一个文件提供 3 个方法
//   GET    ?id=xxx        查询单条（详情页）
//          ?关键词/城市/线路  组合搜索（时刻表列表页、首页）
//   POST   { id? }        新增（无 id）或更新（有 id）—— 写需求入口
//   DELETE ?id=xxx        删除自己写入的一条
//
// 调用方：src/pages/{timetables, timetable-result, timetable-detail, my-timetable, account}.js
// 依赖：env.mlttcd（D1）、env.mlttckv（KV 限流）、env.JWT_SECRET
//
// 关键约束（改动时务必保持）：
//   1. 写操作必须登录，且只允许作者本人操作（前端删除同样按作者校验）
//   2. POST 更新分支会强制 PASS = 0、BACK = '-'，即“任何修改都需重新审核”，
//      客户端传入的 pass 一律忽略，防止用户自我审批
//   3. GET 的搜索条件先各自加括号，再与权限条件用 AND 拼接：
//      (PASS = 1 AND 城市 AND 线路) AND (关键词A OR 关键词B)
//      缺少外层括号会让 AND 抢先结合，使城市过滤被绕过
//   4. 参数长度限制见 _lib/params.js 的 cleanParam；频率限制统一走 ../ratelimit（见 LIMITS）
//
// ⚠️ 频率限制已抽到 functions/ratelimit.js，本文件只 import 使用，不再本地实现。
//    额度：POST → LIMITS.write、DELETE → LIMITS.remove
//    GET 已不再限流（读路径不消耗 KV 写额度，理由见 onRequestGet 里第 1 条注释）

import { enforceRateLimit, LIMITS } from '../ratelimit';
import { statsOnInsert, statsOnDelete } from '../stats-helper';
import { json } from '../_lib/response';
import { cleanParam } from '../_lib/params';

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
    // 频率限制：新增/修改都算写操作
    const limited = await enforceRateLimit(request, env, LIMITS.write);
    if (limited) return limited;

    const body = await request.json().catch(() => null);
    if (!body) {
        return json({ error: '无效的请求数据' }, 400);
    }

    let { id, city, way, start, end, special, time1, time2, etime, writetime, writer } = body;

    // ─── 更新模式（id 存在时）─────────────────────────
    if (id) {
        if (!writer || typeof writer !== 'string' || writer.trim().length === 0) {
            return json({ error: '作者不能为空' }, 400);
        }
        if (!writetime || typeof writetime !== 'string' || writetime.trim().length === 0) {
            return json({ error: '写入时间不能为空' }, 400);
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
        // ─── 修改后重新进入待审核 ────────────────────────
        // 1) PASS 一律由服务端重置为 0（待审核），**不接受客户端传入的 pass**：
        //    否则任何人都能把 PASS 置为 1 自行审批通过。
        //    审核通过/驳回属于管理员站点的能力，走 /api/admin。
        // 2) 驳回标记以 BACK 列为准（BACK = 1 表示被驳回），
        //    用户修改时刻表后即视为已重新提交，故将 BACK 复位为 '-'。
        sets.push('PASS = ?');
        params.push(0);
        sets.push('BACK = ?');
        params.push('-');

        if (sets.length === 0) {
            return json({ error: '没有提供需要更新的字段' }, 400);
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
                    return json({ error: '记录不存在' }, 404);
                }
                return json({ error: '无权修改此记录' }, 403);
            }

            // ─── 作者改表后自动销单（错误报告）──────────────────
            // 触发条件：本条时刻表下存在被管理员「返还写入者」的错误报告
            //           （TIMETABLE_REPORT.RESOLUTION = 'returned'）。
            //           作者改表即视为已重新提交，这些报告随之置为：
            //             RESOLUTION   = 'author-resubmitted'（作者改表自动销单）
            //             STATUS       = 'resolved'
            //             RESOLVEDTIME = 当前 ISO 时间（写法同 WRITETIME）
            //             RESOLVEDBY   = NULL（作者自己处理，不是管理员处置）
            // 'restored'（管理员恢复上线）已终结，不在此处覆盖。
            // ⚠️ 必须独立 try/catch：用户还没执行新版 functions/TIMETABLE_REPORT.sql 时，
            //    该表不存在或没有 RESOLUTION/STATUS/RESOLVED* 列，UPDATE 会抛错 ——
            //    这种情况下**不能让「更新时刻表」失败**，改表功能必须照旧可用，
            //    因此这里失败只打一条 console.warn，继续正常返回 200。
            try {
                await env.mlttcd.prepare(
                    `UPDATE TIMETABLE_REPORT
                     SET RESOLUTION = 'author-resubmitted',
                         STATUS = 'resolved',
                         RESOLVEDTIME = ?1,
                         RESOLVEDBY = NULL
                     WHERE TID = ?2 AND RESOLUTION = 'returned'`
                ).bind(new Date().toISOString(), id).run();
            } catch (reportErr) {
                console.warn('自动销单失败（TIMETABLE_REPORT 可能尚未创建或缺列）:', reportErr);
            }

            return json({
                success: true,
                id: id,
                message: '更新成功'
            }, 200);
        } catch (err) {
            console.error('更新错误:', err);
            return json({ error: '数据库更新失败' }, 500);
        }
    }

    // ─── 新增模式（无 id）─────────────────────────
    // ----- 参数校验 -----
    if (!city || typeof city !== 'string' || city.trim().length === 0) {
        return json({ error: '城市不能为空' }, 400);
    }
    if (!way || typeof way !== 'string' || way.trim().length === 0) {
        return json({ error: '线路不能为空' }, 400);
    }
    if (!start || typeof start !== 'string' || start.trim().length === 0) {
        return json({ error: '起点不能为空' }, 400);
    }
    if (!end || typeof end !== 'string' || end.trim().length === 0) {
        return json({ error: '终点不能为空' }, 400);
    }
    if (!time1 || typeof time1 !== 'string' || time1.trim().length === 0) {
        return json({ error: '时刻表1不能为空' }, 400);
    }
    if (!time2 || typeof time2 !== 'string' || time2.trim().length === 0) {
        return json({ error: '时刻表2不能为空' }, 400);
    }
    if (!etime || typeof etime !== 'string' || etime.trim().length === 0) {
        return json({ error: '执行时间不能为空' }, 400);
    }
    if (!writer || typeof writer !== 'string' || writer.trim().length === 0) {
        return json({ error: '作者不能为空' }, 400);
    }
    if (!writetime || typeof writetime !== 'string' || writetime.trim().length === 0) {
        return json({ error: '写入时间不能为空' }, 400);
    }

    // 处理 special 字段（可选）
    const specialValue = (typeof special === 'string' && special.trim().length > 0) ? special.trim() : '无';

    // ----- 城市+线路查重 -----
    const existingRoute = await env.mlttcd.prepare(
        'SELECT id FROM TIMETABLE WHERE CITY = ?1 AND WAY = ?2 AND START = ?3 AND END = ?4 AND TIMEONE = ?5 AND TIMETWO = ?6'
    ).bind(city.trim(), way.trim(), start.trim(), end.trim(), time1.trim(), time2.trim()).first();

    if (existingRoute) {
        return json({
            success: false,
            message: '该时刻表已存在'
        }, 409);
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

        // 维护首页统计（线路 +1、城市并入），失败不影响主流程
        statsOnInsert(env, city.trim()).catch((e) => console.warn('统计维护失败:', e));

        return json({
            success: true,
            id: newId,
            message: '添加成功'
        }, 201);
    } catch (err) {
        console.error('插入错误:', err);
        return json({ error: '数据库写入失败' }, 500);
    }
}

// ─── 频率限制辅助 ─────────────────────────────────────────────
// 本地实现已删除，统一使用 ../ratelimit —— 这样额度配置只有一处，改起来不会漏

// ─── 参数校验辅助 ─────────────────────────────────────────────

// 参数清洗统一走 functions/_lib/params.js 的 cleanParam()：
// 语义与原本地 validateSearchParam 完全一致（非字符串 / 去空格后为空 / 超长 → null）

//Get
export async function onRequestGet({request,env}){
    try {
        // 1. 频率限制：读路径已移除（省 KV 写额度）
        //    enforceRateLimit() 每次调用 = 1 次 KV 读 + 1 次 KV 写，而 KV 免费额度的写只有
        //    1000/天；本接口的 GET 是首页/列表页/详情页最高频的读路径，会把写额度烧光，
        //    连累真正需要限流的写接口（POST/DELETE）被误伤。
        //    读接口的滥用改由 Cloudflare 面板的 WAF / Rate limiting 规则兜住（不消耗 KV）。
        //    ⚠️ POST（LIMITS.write）与 DELETE（LIMITS.remove）的限流原样保留。
        const url = new URL(request.url);
        const city = url.searchParams.get("city");
        const way = url.searchParams.get("way");
        const id = url.searchParams.get("id");

        if (id && id !== '0') {
            // ID 查询（精确匹配，受控参数）
            const cleanId = cleanParam(id, 20);
            if (!cleanId) {
                return json({
                    success: false,
                    message: 'ID 格式无效'
                }, 400);
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
                    return json({
                        success: false,
                        message: '未找到该记录'
                    }, 404);
                }

                return json({
                    success: true,
                    data: row
                }, 200);
            } catch (err) {
                console.error('ID 查询错误:', err);
                return json({ error: '服务器内部错误' }, 500);
            }
        }

        // ─── 按作者(邮箱)查询 ──────────────────────────
        const writer = url.searchParams.get('writer');
        if (writer) {
            const cleanWriter = cleanParam(writer, 100);
            if (cleanWriter) {
                console.log("按作者查询:", cleanWriter);
                try {
                    const { results } = await env.mlttcd.prepare(
                        `SELECT t.*, u.NAME as WRITER_NAME
                         FROM TIMETABLE t
                         LEFT JOIN USER u ON u.EMAIL = t.WRITER
                         WHERE t.WRITER = ? ORDER BY t.WRITETIME DESC`
                    ).bind(cleanWriter).all();

                    return json({
                        success: true,
                        data: results,
                        count: results.length
                    }, 200);
                } catch (err) {
                    console.error('作者查询错误:', err);
                    return json({ error: '服务器内部错误' }, 500);
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
                const cleanCity = cleanParam(city, 20);
                if (cleanCity) {
                    conditions.push('t.CITY LIKE ? ');   // 添加 t. 前缀
                    params.push(`%${cleanCity}%`);
                }
            }
            if (way) {
                const cleanWay = cleanParam(way, 50);
                if (cleanWay) {
                    conditions.push('t.WAY LIKE ? ');    // 添加 t. 前缀
                    params.push(`%${cleanWay}%`);
                }
            }

            // 通用关键词 q：跨 CITY、WAY、START、END 多字段模糊搜索
            const cleanQ = cleanParam(q, 50);
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
                        // 城市/线路条件必须与关键词条件同时成立。
                        // 括号不能省：SQL 中 AND 优先级高于 OR，写成 (条件) OR (关键词)
                        // 会让城市过滤完全失效（只要命中关键词，其它城市的记录也会返回）
                        whereClauses.push('(' + conditions.join(' AND ') + ') AND (' + orGroups.join(' OR ') + ')');
                    } else {
                        whereClauses.push(conditions.join(' AND '));
                    }
                } else if (orGroups.length > 0) {
                    whereClauses.push(orGroups.join(' OR '));
                }
                whereClauses.push('t.PASS = 1');
                query += ' ' + whereClauses.join(' AND ');
            } else {
                return json({
                    success: false,
                    message: '参数格式无效'
                }, 400);
            }

            query += ' LIMIT 200';

            console.log("组合查询:", query, params);
            try {
                const { results } = await env.mlttcd.prepare(query).bind(...params).all();

                if (results.length === 0) {
                    return json({
                        success: false,
                        message: '未找到符合条件的时刻表'
                    }, 404);
                }

                return json({
                    success: true,
                    data: results
                }, 200);
            } catch (err) {
                console.error('模糊查询错误:', err);
                return json({ error: '服务器内部错误' ,debug:err.stack,message:err.message}, 500);
            }
        }

        // ─── 列出所有已添加的线路（city + way）─────────────────────
        const list = url.searchParams.get('list');
        if (list === 'all') {
            console.log("列出所有线路");
            try {
                const listQuery = 'SELECT DISTINCT CITY, WAY FROM TIMETABLE ORDER BY CITY, WAY';
                const { results } = await env.mlttcd.prepare(listQuery).all();

                return json({
                    success: true,
                    data: results
                }, 200);
            } catch (err) {
                console.error('列出线路错误:', err);
                return json({ error: '服务器内部错误' ,debug:err.stack,message:err.message}, 500);
            }
        }

        return json({
            success: false,
            message: '请提供 id 或 city+way 参数'
        }, 400);
    } catch (err) {
        return json({
            error: '服务器内部错误',
            debug: err.stack,        // 保留调试信息，定位其他潜在问题后建议移除
            message: err.message
        }, 500);
    }
}

// ─── 删除时刻表 ─────────────────────────────────────────────
export async function onRequestDelete({ request, env }) {
    try {
        // 频率限制：删除
        const limited = await enforceRateLimit(request, env, LIMITS.remove);
        if (limited) return limited;

        const body = await request.json().catch(() => null);
        if (!body) {
            return json({ error: '无效的请求数据' }, 400);
        }

        const { id, writer } = body;
        if (!id || !writer) {
            return json({ error: '参数不完整' }, 400);
        }

        // 验证该记录存在且作者匹配
        const existing = await env.mlttcd.prepare(
            'SELECT ID, WRITER, CITY FROM TIMETABLE WHERE ID = ?'
        ).bind(id).first();

        if (!existing) {
            return json({ error: '记录不存在' }, 404);
        }

        if (existing.WRITER !== writer) {
            return json({ error: '无权删除此记录' }, 403);
        }

        await env.mlttcd.prepare('DELETE FROM TIMETABLE WHERE ID = ? AND WRITER = ?')
            .bind(id, writer).run();

        // ─── 同步删除这条时刻表的错误报告 ──────────────────────
        // 时刻表没了，挂在它上面的报告就是没有主体的孤儿记录；最常见的路径正是
        // 「管理员把报告返还写入者 → 作者直接删除这条时刻表」，此时报告若留在库里，
        // 管理端的报告列表里会一直挂着一条点进去什么都没有的条目。
        // 删掉整条 TID 的报告（不论 open 还是已处理），与时刻表同生共死。
        // ⚠️ 独立 try/catch：TIMETABLE_REPORT 尚未创建时不能让「删除时刻表」失败。
        try {
            await env.mlttcd.prepare(
                'DELETE FROM TIMETABLE_REPORT WHERE TID = ?'
            ).bind(id).run();
        } catch (reportErr) {
            console.warn('同步删除错误报告失败（TIMETABLE_REPORT 可能尚未创建）:', reportErr);
        }

        // 维护首页统计（线路 -1、城市回收），失败不影响主流程
        statsOnDelete(env, existing.CITY).catch((e) => console.warn('统计维护失败:', e));

        return json({
            success: true,
            message: '删除成功'
        }, 200);
    } catch (err) {
        console.error('删除错误:', err);
        return json({ error: '删除失败' }, 500);
    }
}