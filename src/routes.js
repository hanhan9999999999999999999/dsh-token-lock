/**
 * routes.js — HTTP 接口，给状态看板用
 *
 * 挂在宿主自带的 webServer 上（ctx.webServer.register），不自己起服务、不占新端口。
 * 全部只读 + 两个受控写操作（unlock / config）。
 *
 * 安全：与 vpn-panel 同一套校验 —— 只准 loopback、拒 sec-fetch-site
 * cross-site/same-site、拒非同源 origin。因为这是本机面板，不是公网 API。
 */

const PREFIX = '/token-lock'

function sendJson(res, code, body) {
  try {
    const text = JSON.stringify(body)
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(text)
  } catch {
    try { res.statusCode = 500; res.end() } catch { /* ignore */ }
  }
}

const BODY_TOO_LARGE = Symbol('body-too-large')

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        chunks.length = 0
        req.removeAllListeners('data')
        req.resume()
        resolve(BODY_TOO_LARGE)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

function requestRejection(req) {
  try {
    const headers = (req && req.headers) || {}
    let host
    try { host = new URL('http://' + String(headers.host || '')) } catch { return 403 }
    if (!isLoopback(host.hostname)) return 403
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site' || site === 'same-site') return 403
    const origin = headers.origin
    if (origin) {
      try {
        const o = new URL(origin)
        if (!isLoopback(o.hostname) || o.port !== host.port) return 403
      } catch { return 403 }
    }
    return null
  } catch {
    return 403
  }
}

/**
 * @param {object} deps {config, log, ledger, rate, waste, exempt, policy, budget, attr, shadow, runtime}
 *   runtime 提供 {getConfig, patchConfig, reload(soft)}
 */
export function createRoutes(ctx, deps) {
  const disposers = []
  const { config, log, ledger, rate, waste, exempt, policy, budget, attr, shadow, runtime } = deps

  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') {
    // headless / 无 web 的宿主：安静地不注册，插件其余功能照常
    return { dispose: () => {}, count: 0, available: false }
  }

  // 一个 path 只注册一次：webServer 按 exact path 索引，同 path 二次注册会撞。
  // 所以 GET/POST 共存的路径用数组声明方法，handler 收第三参 method 自行分支。
  const route = (path, method, handler) => {
    const methods = Array.isArray(method) ? method : [method]
    try {
      const d = server.register({
        kind: 'exact',
        path: PREFIX + path,
        handler: async (req, res) => {
          const deny = requestRejection(req)
          if (deny !== null) return sendJson(res, deny, { ok: false, error: 'forbidden' })
          const wanted = String(req.method || 'GET').toUpperCase()
          if (!methods.includes(wanted)) return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const body = wanted === 'POST' ? await readBody(req) : null
            if (body === BODY_TOO_LARGE) return sendJson(res, 413, { ok: false, error: 'body too large' })
            if (wanted === 'POST' && body === null) return sendJson(res, 400, { ok: false, error: 'bad json' })
            const result = await handler(req, body, wanted)
            const code = result && Number.isInteger(result.httpStatus) ? result.httpStatus : 200
            sendJson(res, code, result && result.body ? result.body : result)
          } catch (err) {
            log?.warn?.(`[token-lock] route ${path} failed: ${err?.message ?? err}`)
            sendJson(res, 500, { ok: false, error: 'internal' })
          }
        },
      })
      if (typeof d === 'function') disposers.push(d)
    } catch (err) {
      log?.warn?.(`[token-lock] register ${path} failed: ${err?.message ?? err}`)
    }
  }

  // ── 状态总览 ────────────────────────────────────────────────
  route('/status', 'GET', () => {
    const cfg = runtime?.getConfig?.() ?? config
    const sh = shadow?.stats?.() ?? null
    return {
      body: {
        ok: true,
        plugin: 'dsh-token-lock',
        enabled: cfg.enabled,
        mode: cfg.mode,
        dryRun: cfg.dryRun,
        maxLevel: cfg.maxLevel,
        // 说人话的当前档位
        posture: describePosture(cfg),
        today: budget.snapshot?.() ?? null,
        rate: rate?.snapshot?.() ?? null,
        shadow: sh,
        canEnforce: shadow?.canEnforce?.() ?? null,
        sessions: ledger?.snapshot?.() ?? null,
        detectors: cfg.detectors,
        dimensions: cfg.dimensions,
      },
    }
  })

  // ── 空转画像 ────────────────────────────────────────────────
  route('/waste', 'GET', (req) => {
    const sessionId = queryParam(req, 'session')
    const pos = sessionId ? waste.score(sessionId) : null
    return {
      body: {
        ok: true,
        sessionId: sessionId ?? null,
        position: pos,
        diagnose: sessionId ? attr.diagnose(sessionId) : null,
        thresholds: rate?.thresholds?.() ?? null,
      },
    }
  })

  // ── 为什么 ──────────────────────────────────────────────────
  route('/why', 'GET', (req) => {
    const sessionId = queryParam(req, 'session')
    if (!sessionId) return { httpStatus: 400, body: { ok: false, error: 'session required' } }
    const pos = waste.score(sessionId)
    const ex = exempt.evaluate(sessionId, { turn: pos?.turn ?? 0, yieldRate: pos?.yieldRate ?? 0 })
    const decision = policy.compose(runtime?.getConfig?.() ?? config, pos ?? {}, ex)
    return {
      body: {
        ok: true,
        sessionId,
        composed: decision,
        explain: (decision.patterns ?? []).map((p) => ({
          id: p.id, dim: p.dim, level: p.level, evidence: p.evidence, message: p.message,
        })),
        exempted: decision.exempt ?? [],
        attribution: attr.diagnose(sessionId),
      },
    }
  })

  // ── 临时放行 ────────────────────────────────────────────────
  route('/unlock', 'POST', (req, body) => {
    const sessionId = body?.session ?? queryParam(req, 'session') ?? '*'
    const minutes = clamp(Number(body?.minutes ?? 10), 1, 240)
    exempt.grantToken(sessionId, minutes)
    log?.info?.(`[token-lock] 放行令牌已发：${sessionId} ${minutes} 分钟`)
    return {
      body: {
        ok: true,
        sessionId,
        minutes,
        until: new Date(Date.now() + minutes * 60000).toISOString(),
        note: '这段时间内最高只到 r1（记账，不提示、不限制）',
      },
    }
  })

  // ── 读 / 改运行期配置 ───────────────────────────────────────
  // GET：给设置界面用，返回当前全量配置（前端拿它渲染全部开关）
  // POST：改配置（只在内存；落盘改 cordis.patch.yml 的 config）
  route('/config', ['GET', 'POST'], (req, body, method) => {
    if (method === 'GET') {
      const cfg = runtime?.getConfig?.() ?? config
      return {
        body: {
          ok: true,
          config: cfg,
          // 前端只改这几类是安全的：其余键改坏了会静默失效，不如不给
          editable: ['enabled', 'mode', 'dryRun', 'maxLevel', 'levels', 'detectors', 'dimensions', 'verbose', 'throttleMs', 'whitelist', 'exemptions', 'dailyBudget', 'sessionBudget'],
        },
      }
    }
    const patch = body?.patch
    if (!patch || typeof patch !== 'object') {
      return { httpStatus: 400, body: { ok: false, error: 'patch required' } }
    }
    const allowed = ['enabled', 'mode', 'dryRun', 'maxLevel', 'levels', 'detectors', 'dimensions', 'verbose', 'throttleMs', 'whitelist', 'exemptions', 'dailyBudget', 'sessionBudget']
    const rejected = Object.keys(patch).filter((k) => !allowed.includes(k))
    if (rejected.length && !body?.force) {
      return {
        httpStatus: 400,
        body: { ok: false, error: 'unsupported keys', rejected, allowed, hint: '加 force:true 仍不允许未知键' },
      }
    }
    if (patch.mode === 'enforce') {
      const gate = shadow?.canEnforce?.()
      if (!gate?.ok) {
        return {
          httpStatus: 409,
          body: {
            ok: false,
            error: 'enforce blocked',
            why: gate?.why ?? '影子样本不足',
            hint: 'enforce 是唯一会真的拒绝请求的档位，必须先过影子回测。',
          },
        }
      }
    }
    const applied = runtime?.patchConfig?.(patch)
    return { body: { ok: true, applied: applied ?? patch, persisted: false, note: '本次只在内存生效；重启回默认。要落盘改 cordis.patch.yml 的 config' } }
  })

  // ── 影子回测 ────────────────────────────────────────────────
  route('/shadow', 'GET', () => ({
    body: { ok: true, ...(shadow?.snapshot?.() ?? {}), canEnforce: shadow?.canEnforce?.() ?? null },
  }))

  function dispose() {
    for (const d of disposers) {
      try { d() } catch { /* ignore */ }
    }
    disposers.length = 0
  }

  return { dispose, count: disposers.length, available: true, base: PREFIX }
}

function queryParam(req, name) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    return url.searchParams.get(name) ?? null
  } catch {
    return null
  }
}

const clamp = (n, lo, hi) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo)

function describePosture(cfg) {
  if (!cfg.enabled) return '已停用'
  if (cfg.mode === 'observe') return '只观察：记账 + 统计，一句话都不说'
  if (cfg.mode === 'advise') return cfg.dryRun ? '建议（预演）：算得出拦截但不会真的拦' : '建议：最多提示到 r3'
  return '执行：真的会拒绝请求（仅 D3/D6）'
}
