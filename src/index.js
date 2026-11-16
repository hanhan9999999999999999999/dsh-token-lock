/**
 * dsh-token-lock — 拦浪费，不拦工作
 *
 * 一个插件，七个维度，十一个检测器，七个豁免，三档模式。
 * 每个功能都能用配置单独开关；默认全在「建议」档，物理上不会拒绝任何请求。
 *
 * 体系速查：
 *   D1 时间维  —— 请求速率暴涨（5 分钟 vs P95）        封顶 r3
 *   D2 内容维  —— 重复读、空转、无产出                  封顶 r3
 *   D3 行为维  —— 死循环、连续失败、刷屏                封顶 r7 ★
 *   D4 结构维  —— 上下文超载、图片堆积                  封顶 r4（只禁新建）
 *   D5 成本维  —— 日预算                                封顶 r2（纯观测）
 *   D6 调度维  —— 任务/子会话超预算                     封顶 r7 ★
 *   D7 项目维  —— 项目级超支                            封顶 r2
 *
 *   ★ 只有 D3/D6 有资格升到 r7（硬停）。其余维度最多到 r6。
 *
 * 响应阶梯：r0 观察 / r1 记账 / r2 软提示 / r3 定向建议 / r4 禁止新建 /
 *           r5 限流 / r6 要求先压缩 / r7 硬停
 */

import { normalizeConfig, DEFAULT_CONFIG } from './config.js'
import { createStore } from './store.js'
import { createLedger } from './ledger.js'
import { createRate } from './rate.js'
import { createWaste } from './waste.js'
import { createExempt } from './exempt.js'
import { compose } from './policy.js'
import { createGate, finishChunk } from './gate.js'
import { createBudget } from './budget.js'
import { createAttr } from './attr.js'
import { createShadow } from './shadow.js'
import { createRoutes } from './routes.js'

export { DEFAULT_CONFIG }

/**
 * 运行期状态（给测试、调试、看板用；宿主不读它）
 * loaded/disposedAt 只在 apply / dispose 时写，没有别的地方会动。
 */
export const state = { loaded: false, loadedAt: 0, disposedAt: 0, config: null }

export const name = 'dsh-token-lock'

/**
 * 只声明 webServer —— 且必须声明，不能省。
 *
 * 踩过的坑一（装上了等于没装）：写成
 * `{ required: [], optional: ['sessions','tokenMeter','webServer','logger'] }`
 * 时宿主把插件判成 pending（日志原文 "pending (waiting for services: required, optional)"）
 * —— 这个版本的 cordis 把 optional 也一起等，只要有一个可选服务本机不存在，
 * apply() 就永远不被调用：路由不注册、事件不订阅。user 看到的就是设置界面里
 * 一句「读不到插件配置」。
 *
 * 踩过的坑二（写成空数组也不对）：inject 为 [] 时，`ctx.webServer` 属于
 * 「未声明就要」——cordis 的代理会先走 internal/get waterfall 沿 parent 链找
 * provision（见 @deepseek-ai/cordis lib/index.js:1254-1282），隔离键对不上就抛
 * `cannot get property "webServer" without inject`；而 :1270 的「inactive
 * context」分支只对已声明的名字生效。也就是说空数组把确定性从框架手里拿走了。
 *
 * 正解 = 只声明那个真实存在的服务，让框架保证 apply 时它已注入
 * （dsh-host-webserver 里是 super(ctx, "webServer")，dsh web 起得来它就在），
 * 其它（sessions / tokenMeter / logger）一律不声明、在 apply 里软取。
 * 与 D:\dsh-home\vendor\dsh-vpn-panel\src\index.js:34 的做法一致。
 */
export const inject = ['webServer']

export function apply(ctx, rawConfig) {
  const env = readEnv()
  const { config, warnings } = normalizeConfig(rawConfig ?? {}, env)

  const log = makeLogger(ctx)

  // 宿主 ctx 一定有 on()，但测试 / 降级环境可能给个空对象 ——
  // 一个假 ctx 不该让整个插件炸掉，那等于「装上了但整个会话起不来」。
  const on = (ev, fn) => (typeof ctx?.on === 'function' ? ctx.on(ev, fn) : () => {})
  for (const w of warnings) log.warn(`[token-lock] 配置：${w}`)

  // 运行期可变的那一份配置（/config 路由改这里，重启回默认）
  let live = config

  // ★ 关键：把所有子系统接到一个只读 Proxy 上，而不是传 config 快照。
  // 否则 /config 改了 live 之后，子系统手里还是旧对象 —— 用户改了配置却静默不生效。
  // 每次读属性时才落到 live，patchConfig 一换对象，所有模块立刻看到新值。
  const CFG = new Proxy({}, {
    get: (_, key) => live[key],
    has: (_, key) => key in live,
    ownKeys: () => Reflect.ownKeys(live),
    getOwnPropertyDescriptor: (_, key) => ({
      configurable: true, enumerable: true, value: live[key],
    }),
  })

  const store = createStore(CFG, log)
  try { store.ensure() } catch { /* ignore */ }

  const clock = () => Date.now()
  const ledger = createLedger(CFG, store, clock)
  const rate = createRate(CFG, store, clock)
  const waste = createWaste(CFG, ledger, rate, clock)
  const exempt = createExempt(CFG, ledger, rate, clock)
  const budget = createBudget(CFG, ledger, store, clock)
  const attr = createAttr(CFG, ledger)
  const shadow = createShadow(CFG, store, clock)
  // policy 是无状态的纯函数模块，包一层只为统一注入形状
  const policy = { compose: (cfg, pos, ex) => compose(cfg ?? CFG, pos, ex) }

  const runtime = {
    getConfig: () => live,
    patchConfig: (patch) => {
      const merged = { ...live, ...patch }
      const norm = normalizeConfig(merged, env)
      live = norm.config
      for (const w of norm.warnings) log.warn(`[token-lock] 配置：${w}`)
      return live
    },
  }

  const gate = createGate({
    config: CFG, log, ledger, rate, waste, exempt, policy, budget, shadow, clock,
  })

  // ── 闸门：llm/stream（cordis waterfall） ────────────────────
  // 签名 'llm/stream'(options, next) => AsyncIterable<StreamChunk>
  // options 是 deep-frozen 的，只读。我们只决定「这次让不让发」。
  const offStream = on('llm/stream', function (options, next) {
    const result = gate.judge(options)
    const sessionId = options?.sessionId ?? options?.session?.id ?? 'unknown'

    if (!result.allow) {
      // 用 finish chunk 结束，而不是 throw —— throw 会触发宿主重试链
      return (async function* () {
        yield finishChunk(result.failure)
      })()
    }

    if (result.delayMs > 0) {
      return (async function* () {
        await new Promise((r) => setTimeout(r, result.delayMs))
        yield* next()
      })()
    }

    if (result.level !== 'r0') gate.afterJudge(sessionId, result)
    return next()
  })

  // ── 事件：把会话流喂给各子系统 ─────────────────────────────
  const offEvent = on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    const sessionId = session?.id ?? session?.sessionId ?? event?.data?.sessionId ?? 'unknown'
    try {
      switch (event.type) {
        case 'assistant/message': {
          ledger.recordAssistant(sessionId, event)
          rate.hit(sessionId, event.time)
          waste.onEvent(sessionId, event)
          // 产出观测：让影子层知道这个会话还在干活
          const prod = waste.score(sessionId)?.productivity ?? 0
          if (prod > 0) shadow.observe(sessionId, event.data?.turn ?? 0, prod)
          break
        }
        case 'compaction/summary':
          ledger.recordCompaction(sessionId, event)
          break
        case 'user/message':
          budget.noteUserMessage(sessionId, event.data?.turn ?? 0)
          waste.onEvent(sessionId, event)
          exempt.markSeen(sessionId)
          break
        case 'tool/call':
        case 'tool/result':
        case 'step/start':
        case 'step/end':
        case 'workspace/changes':
        case 'todo/write':
        case 'turn/start':
        case 'turn/end':
        case 'job/registered':
        case 'job/settled':
          waste.onEvent(sessionId, event)
          break
        case 'compaction/start':
        case 'compaction/end':
        case 'compaction/prune':
          waste.onEvent(sessionId, event)
          break
        case 'request/context': {
          // 这里是唯一能拿到真实 contextWindow 的地方（实测 1048576）
          const cw = event.data?.contextWindow
          if (Number.isFinite(cw) && cw > 0) waste.onEvent(sessionId, { ...event, data: { ...event.data, contextWindow: cw } })
          break
        }
        default:
          break
      }
    } catch (err) {
      log.warn(`[token-lock] 事件处理失败 ${event.type}: ${err?.message ?? err}`)
    }
  })

  // ── HTTP 看板 ─────────────────────────────────────────────
  // inject 已声明 ['webServer']：框架保证 apply 时它已注入 —— 所以这里只保留
  // **一条**挂载路径，不再留 `ctx.inject` 兜底。
  //
  // 踩过的坑三（六条路由全灭，侧栏报 "Unexpected end of JSON input"）：
  // 旧写法主路径挂一次，`ctx.inject(['webServer'], cb)` 又因服务已就绪**立刻同步回调**
  // 挂第二次 —— 而两次的 `target.webServer` **不是同一个对象**（scoped ctx 上取到的
  // 是另一层包装），所以 `mountedOn === server` 这种对象身份守卫恒为假，等于没守卫。
  // 第二次 createRoutes 六条全 duplicate（宿主只 warn，createRoutes 仍返回
  // available:true、disposers 为空），紧接着 `routes.dispose()` 撤掉的正是第一次
  // **成功**的那套 → 净零路由 → 前端 404 空 body。
  // 日志证据：`已挂载 · 路由=/token-lock/status` 之后紧跟六条
  // `register /status failed: webserver: duplicate exact route "/token-lock/status"`。
  // 结论：守卫用**布尔标志**（与对象身份无关），且绝不注册第二条挂载路径。
  let routes = { dispose() {}, available: false, count: 0 }
  let mounted = false
  const routeDeps = { config: CFG, log, ledger, rate, waste, exempt, policy, budget, attr, shadow, runtime }
  const mountRoutes = () => {
    if (mounted) return
    let next = null
    try {
      next = createRoutes(ctx, routeDeps)
    } catch (err) {
      log.warn(`[token-lock] 路由未注册：${err?.message ?? err}`)
      return
    }
    if (!next || next.available === false) return
    routes = next
    mounted = true
  }
  try {
    mountRoutes()
  } catch (err) {
    log.warn(`[token-lock] webServer 不可用：${err?.message ?? err}`)
  }

  // ── 退出清理 ──────────────────────────────────────────────
  on('dispose', () => {
    state.disposedAt = Date.now()
    try { offStream?.() } catch { /* ignore */ }
    try { offEvent?.() } catch { /* ignore */ }
    try { routes.dispose() } catch { /* ignore */ }
    mounted = false
    try { ledger.flush() } catch { /* ignore */ }
    try { rate.flush?.() } catch { /* ignore */ }
  })

  log.info(
    `[token-lock] build=r3 已挂载 · 模式=${live.mode}${live.dryRun ? '(预演)' : ''} · ` +
    `上限=${live.maxLevel} · 数据=${store.file?.('ledger.jsonl') ?? live.dataDir} · ` +
    `路由=${routes.available ? `${routes.count} 条 @ /token-lock/*` : '未启用（无 webServer）'} · ` +
    `entry=${import.meta.url}`,
  )

  state.loaded = true
  state.loadedAt = Date.now()
  state.config = live

  // 暴露给测试与调试（宿主不会用它）。ctx 可能是 null/{}，写不进就算了。
  const exposed = {
    config: CFG,
    getConfig: runtime.getConfig,
    ledger, rate, waste, exempt, policy, gate, budget, attr, shadow, runtime,
    compose: (pos, ex) => compose(live, pos, ex),
  }
  try { if (ctx && (typeof ctx === 'object' || typeof ctx === 'function')) ctx.tokenLock = exposed } catch { /* ignore */ }
}

function readEnv() {
  try {
    return { DSH_HOME: process.env.DSH_HOME }
  } catch {
    return {}
  }
}

function makeLogger(ctx) {
  const fallback = {
    info: (...a) => { try { console.log(...a) } catch { /* ignore */ } },
    warn: (...a) => { try { console.warn(...a) } catch { /* ignore */ } },
    error: (...a) => { try { console.error(...a) } catch { /* ignore */ } },
  }
  try {
    const l = ctx?.logger
    if (l && typeof l.info === 'function') {
      return {
        info: (m) => l.info(m),
        warn: (m) => (typeof l.warn === 'function' ? l.warn(m) : l.info(m)),
        error: (m) => (typeof l.error === 'function' ? l.error(m) : l.info(m)),
      }
    }
  } catch { /* ignore */ }
  return fallback
}
