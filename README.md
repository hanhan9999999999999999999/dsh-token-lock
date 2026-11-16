# dsh-token-lock

> 给 DSH 装一把锁。**锁的是空转，不是干活。**

它盯着会话里每一次请求花的 token，也盯着这次请求**换来了什么**——
写了文件、测试转绿、工具调用成功，这些都是产出；反复读同一个文件、
同一条命令跑三遍、连续失败还不知道停，这些是空转。

空转的会话被收紧，正在干活的会话一路放行。默认姿态下它**连一次都不会拦**，
只记账、只提示；要不要真拦，是主人自己拨的开关。

---

## 一、装

```bash
# 1. 登记到 profile（两处都要）
#    D:\dsh-home\profiles\desktop\package.json
#      "dependencies": { "dsh-token-lock": "file:D:/dsh-home/vendor/dsh-token-lock" }
#      "dsh": { "profile": { "bundles": [ ... "dsh-token-lock" ] } }

# 2. 装依赖
cd D:/dsh-home/profiles/desktop && pnpm install

# 3. 重启 DSH（这一下必须主人自己来）
```

装完打开 `http://127.0.0.1:<port>/token-lock/status` 能看到今日用量与当前姿态，就是活了。

数据落在 `D:\dsh-home\storages\dsh-token-lock\`：

| 文件 | 内容 |
| --- | --- |
| `ledger.jsonl` | 按会话聚合的 token 账（**不存每次请求**，只存每轮聚合） |
| `rate.json` | 请求速率的 P95 基线（按天学，24h 重算一次） |
| `shadow.jsonl` | 影子回测记录：每次「本该拦」都记一笔，回头看有没有误伤 |
| `baseline.json` | 各项目的产出率基线（P25/P75） |

---

## 二、六个开关层次

插件所有功能都能单独关。从粗到细：

### 1. 总闸

```yaml
enabled: true      # false = 整个插件睡过去，一个字节都不写
```

### 2. 模式（三档，默认最保守的那档）

```yaml
mode: advise       # observe | advise | enforce
```

| 档位 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| `observe` | 只记账、只统计 | 一句话都不说，一个字都不拦 |
| `advise` **（默认）** | 上面全部 + 最多给一条定向建议（r3） | 拦不了任何请求 |
| `enforce` | 到了 r7 会真的拒绝 | 还得 `dryRun: false`，且影子回测通过才允许切 |

切 `enforce` 有三道门：`dryRun` 关掉、影子样本 ≥ 50 且误伤率 ≤ 0.5%、`mode` 显式改。
任何一道不过，`POST /config` 直接 409，不给你切。

### 3. 演练开关

```yaml
dryRun: true       # true = 算得出「本该拦」，但实际不拦，只记一笔
```

它和 `mode: advise` 叠加，是「默认永不拦」的第二重保险。

### 4. 七个维度

```yaml
dimensions:
  d1: true   # 时间：请求太密（对比自己的 P95）
  d2: true   # 内容：上下文太胖、同一段重复读
  d3: true   # 行为：连续失败、死胡同   ← 唯一有资格硬停的维度之一
  d4: true   # 结构：图片太多、子会话太多（只禁新建，不打断正在跑的）
  d5: true   # 成本：今日预算（永远只提示）
  d6: true   # 调度：派活前预检、任务超支 ← 另一个有资格硬停的
  d7: false  # 项目：某个项目整体收紧（默认关）
```

**只有 d3 和 d6 能升到 r7（硬停）**。其余维度最高到建议或禁止新建——
因为「上下文胖」和「花钱多」不是罪，「反复做同一件没用的事」才是。

### 5. 十一个检测器

```yaml
detectors:
  p0: true   # 空转综合分
  p1: true   # 产出率过低
  s1: true   # 重复读同一段（重叠 > 70%，连续 3 次）
  s2: true   # 重复命令
  s3: true   # 连续失败
  s4: true   # 零产出
  s5: true   # 上下文膨胀且没在推进
  s6: true   # 图片堆积
  s7: true   # 子会话爆开
  s8: true   # 请求速率暴走
  s9: false  # 死胡同计时（默认关，容易误判长任务）
  s10: false # 派发前预检（默认关，会打断「一口气派十个」的用法）
  s11: true  # 压缩后仍然膨胀
```

### 6. 七条豁免

```yaml
exemptions:
  e1: true   # 用户在场：最近 2 轮内有你的消息 → 最高只到 r3
  e2: true   # 产出豁免：产出率翻倍 → 最高只到 r2（干得好就该放开）
  e3: true   # 交互豁免：由你的消息触发的请求 → 永不硬停
  e4: true   # 白名单：whitelist 里的项目/工具/路径一律放行
  e5: true   # 放行令牌：POST /unlock 临时放行，默认 10 分钟
  e6: true   # 自适应预算：预算至少是 P95 的 1.2 倍
  e7: true   # 学习期：前 20 个会话只观察不动作
```

---

## 三、八级响应阶梯

| 级别 | 名字 | 动作 | 默认开 |
| --- | --- | --- | --- |
| r0 | 观察 | 什么都不做 | ✅ |
| r1 | 记账 | 写进账本 | ✅ |
| r2 | 软提示 | 状态里能看到 | ✅ |
| r3 | 定向建议 | 给一条具体建议（每小时 ≤ 6 条，ROI < 3 不发） | ✅ |
| r4 | 禁止新建 | 不许开新子会话/新任务，**正在跑的不受影响** | ❌ |
| r5 | 限流 | 每次请求间隔 ≥ 3 秒 | ❌ |
| r6 | 要求先压缩 | 提示先压缩再继续 | ❌ |
| r7 | 硬停 | 直接拒绝这次请求 | ❌ |

---

## 四、HTTP 接口

都挂在 `routePrefix`（默认 `/token-lock`）下，只接受本机回环访问。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/token-lock/status` | 今日用量、当前姿态、速率、影子是否够格进 enforce |
| GET | `/token-lock/waste?session=<id>` | 这个会话为什么判定为空转 |
| GET | `/token-lock/why?session=<id>` | 完整判定链回放（每一维怎么算的、被哪条豁免压下去了） |
| GET | `/token-lock/shadow` | 影子回测统计：样本数、误伤率、按维度分布 |
| POST | `/token-lock/unlock` | `{session, minutes}` 临时放行，1–240 分钟 |
| GET | `/token-lock/config` | 当前配置 + 可改字段白名单（设置界面读这一份） |
| POST | `/token-lock/config` | `{patch: {...}, force: bool}` 运行期改配置 |

```bash
curl -s http://127.0.0.1:PORT/token-lock/status | jq
curl -s -X POST http://127.0.0.1:PORT/token-lock/unlock -d '{"minutes":30}' -H 'content-type: application/json'
```

---

## 五、成本口径

只用 **input + output**，不看 `totalTokens`。

理由：实测里 `cacheRead` 占了 99.4% 的 token 数，而它的单价大约是 miss 的十分之一——
把它算进 KPI，等于用一个几乎不花钱的数字去判断「贵不贵」。
另外**不预测、不预扣**：只对已经花掉的量刹车，永不说「你这个请求大概要花 X，所以先扣住」。

---

## 六、它不会做的事

- 不改写 messages、不裁剪上下文、不替你决定「哪些历史不要了」——
  宿主的 `options` 是 deep-frozen 的，锁只能放行或拒绝，不做降级改造。
- 不自己数 token、不猜 contextWindow（自己数一定比宿主错）。
- 不在没有数据的时候给人下判断（前 20 个会话是学习期）。
- 不因为「花得多」就拦人——花得多但产出高，是应该的。

---

## 七、设置界面

插件在 **DSH 设置界面左侧栏注册一个分区**，`id` 为 `token-lock`、`order` 为 `25`
（排在 `agent-presets` 的 20 之后），标签取 locale 命名空间 `token-lock` 的 `nav`。

打开路径：设置 → 左侧栏「Token 护栏」/「Token Guard」。面板从上到下六段：

1. **运行姿态** —— `enabled` 总开关、`dryRun` 干跑、`mode` 三档（observe / advise / enforce）。
   `enforce` 在 `canEnforce.ok === false` 时是灰的，旁边写「锁定」——卡它的是影子回测门槛，
   不是 UI。
2. **七维** `dimensions.*` 3. **十三检测器** `detectors.*`
4. **八级阶梯** `levels.*` 5. **七豁免** `exemptions.*`
6. **数值** —— `maxLevel` 下拉 + `throttleMs` / `dailyBudget` / `sessionBudget`（失焦提交）

顶部三张卡：今日消耗、影子样本数与误伤率、当前 `maxLevel`。

实现说明：

- 浏览器半边在 `lib/client.js`，走 `window.__ModuleLoader__.load({...})` 外壳，靠
  `package.json` 的 `exports["./client"]` 与 `dsh.client.platform = "web"` 被宿主加载；
  `dsh.client.inject` 声明 `@deepseek-ai/dsh-client-locale` 与
  `@deepseek-ai/dsh-client-ui-settings`，保证 slots 与设置外壳先就绪。
- **不用宿主的 `configForms`**：它绑的是宿主配置命名空间（`ctx.remote.settings.mutate`），
  而本插件的配置是自有 JSON + 运行期内存，硬塞进去等于两边各存一份、互相打架。
- 读写都走插件自己的 HTTP 路由（`GET /config` + `POST /config`），与页面同源，
  所以 `requestRejection` 直接放行，不需要令牌。
- `runtime.patchConfig` 是**浅合并**：`levels` / `detectors` / `dimensions` / `exemptions`
  这类嵌套对象会被整体替换，所以界面每次提交都发**完整的子对象**，不是发单个键。
- 默认姿态（`mode=advise` + `dryRun=true` + `maxLevel=r3`）是面板一打开就长这样的原因——
  想让它真的拦人，得在面板上显式改三处。

---

## 八、开发

```bash
node --test test/*.mjs      # 28 条，全程 < 200ms
```

| 测试 | 覆盖 |
| --- | --- |
| `m0.mjs` | 装配层：能不能装上、导出面、假 ctx 不炸 |
| `m1.mjs` | 单元层：六维封顶、豁免、影子、账本、拒绝形状 |
| `m2.mjs` | 集成层：热配置真的生效、默认姿态永不 deny |

模块清单（`src/`）：`config` `store` `ledger` `rate` `waste` `exempt` `policy`
`gate` `budget` `attr` `shadow` `routes` `index`。
