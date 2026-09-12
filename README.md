# mlttc

## 请求频率限制（Rate limiting）

防「请求过多」分两层：应用层在本仓库代码里（随代码生效），边缘层需要在 Cloudflare
控制台配置（拦截更早、更省资源）。两层不冲突，建议都开。

### 1. 应用层（已实现）

实现在 `functions/ratelimit.js`，基于 Cloudflare KV（绑定名 `mlttckv`）做**固定窗口**计数。
阈值统一收在文件末尾的 `LIMITS` 里，调阈值只改那一处。

| 用途 | 端点 | 额度 | 窗口 |
| --- | --- | --- | --- |
| 时刻表搜索 / 详情 | `GET /api/timetable-D1` | 30 次 | 60 秒 |
| 邮箱查重、注册白名单校验 | `GET /api/register-D1?email=`、`GET /api/KV` | 20 次 | 60 秒 |
| 个人资料读取 | `GET /api/profile` | 60 次 | 60 秒 |
| 新增 / 修改时刻表 | `POST /api/timetable-D1` | 10 次 | 10 分钟 |
| 删除时刻表 | `DELETE /api/timetable-D1` | 20 次 | 10 分钟 |
| 登录 | `POST /api/login-D1` | 10 次 | 5 分钟 |
| 注册 | `POST /api/register-D1` | 5 次 | 10 分钟 |
| 修改昵称 / 城市 | `POST /api/update-profile` | 10 次 | 10 分钟 |
| BUG 反馈 | `POST /api/bugback` | 5 次 | 10 分钟 |

超限时返回 **HTTP 429**，并带 `Retry-After`、`X-RateLimit-Limit`、`X-RateLimit-Remaining` 响应头：

```json
{
  "success": false,
  "message": "请求过于频繁，请在 42 秒后重试",
  "error": "请求过于频繁，请在 42 秒后重试",
  "retryAfter": 42
}
```

> `message` 与 `error` 两个字段内容相同，是因为前端各处的错误读取习惯不一致
> （有的读 `data.message`，有的读 `data.error`）。这样无论哪边都能显示真正的限流原因，
> 而不是一句笼统的「提交失败」。

**调整阈值**：编辑 `functions/ratelimit.js` 的 `LIMITS`——`max` 是次数、`window` 是秒。
每个接口用独立的 `name`，计数桶互不影响。需要「在 IP 之外再加一个维度」（例如按账号限流）时，
给 `consume()` 传 `suffix` 即可，`enforceRateLimit()` 的签名支持这一项。

**已知局限**（属于选型取舍，不是 bug）：

- KV 是**最终一致**的，多地并发请求时计数可能偏少 → 挡得住单机脚本和手抖连点，
  挡不住分布式高频刷；后者要靠下面的边缘层规则。
- 计数**按 IP 归并**，同一出口 IP 的用户（公司、校园网）会共享额度。
- KV 读写异常时**一律放行**（fail-open）——限流组件出故障不应该让全站不可用。

### 2. 边缘层（在 Cloudflare 控制台配置，不改代码）

在请求到达 Functions 之前就拦掉，最省资源。大致路径（不同套餐界面文案可能略有差异）：

1. 登录 Cloudflare Dashboard → 选中域名 `mlttc.bond`
2. 进入 **Security → WAF → Rate limiting rules** → *Create rule*
3. **总闸规则**（防整体刷量）
   - 名称：`API 总量`
   - 匹配：`URI Path` `starts with` `/api/`
   - 特征（Characteristics）：`IP`
   - 速率：如 `60 requests / 1 minute`
   - 超出动作：`Block`（或 `Managed Challenge`，对真人更友好）
4. **重点接口规则**（登录 / 注册，防撞库与批量注册）
   - 表达式：`(http.request.uri.path eq "/api/login-D1" or http.request.uri.path eq "/api/register-D1")`
   - 速率：如 `10 requests / 1 minute` → `Block`，并把 `Retry after` 设为 60 秒以上
5. 可选补充：开启 **Bot Fight Mode**，或对 `POST` 到 `/api/` 的请求加 `Managed Challenge`

**留意的点**

- 阈值要比应用层**宽松**一档，让应用层先返回 429（能带上有意义的 JSON 提示），
  边缘层只兜底；否则用户会收到 Cloudflare 的拦截页而不是站内提示。
- 记下规则命中情况（Security → Events），上线初期观察一两天再收紧。

### 3. 怎么验证

- 应用层：连续请求同一接口超过上表额度，应返回 429，且响应头带 `Retry-After`。
  本地无法直接跑 `functions/`，可用 Node 以 stub 方式 import 端点函数后自行调用；
  或在线上用 `curl -i` 循环请求 `/api/timetable-D1?id=1` 观察第 31 次的结果。
- 前端表现：被限流时页面顶部弹出红色浮动提示「请求过于频繁，请在 N 秒后重试」；
  提交类按钮（登录 / 注册 / 保存 / 提交时刻表）连点会被 `lib/ui/guard.mjs` 拦住，只发一次请求。
