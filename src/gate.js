/**
 * gate.js — 真正的闸门：挂在 llm/stream 上
 *
 * ★ 关键约束（写死在这里，注释即契约）：
 *   1. options 是 deep-frozen 的，**只读不改**。本插件从不改写 messages、
 *      不删历史、不换 model——降级只能表现为「这一次不让你发」。
 *   2. 拒绝的形状自己造：new Error(msg) + err.code = 'TOKEN_LOCK_*'，
 *      让宿主的 normalizeLlmFailure 归成 {message, code}。
 *   3. 拒绝走 yield 一个 finish(error) chunk，而不是 throw —— throw 会触发
 *      agent 的重试链，一次拒绝会变成三次重试，反而更贵。
 *   4. 本文件永不因为「成本高」而拒绝。它只执行 policy 已经算好的结论。
 */

const PREFIX = '[token-lock]'

/** 造一个可被宿主识别的失败对象 */
export function lockError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 造一个终止 chunk（宿主侧形状：{type:'finish', reason:{kind:'error', failure}}） */
export function finishChunk(failure) {
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/**
 * @param {object} deps {config, log, ledger, rate, waste, exempt, policy, budget, shadow, clock}
 */
export function createGate(deps) {
  const { config, log, ledger, rate, waste, exempt, policy, budget, shadow, clock = Date.now } = deps
  const stats = { seen: 0, allowed: 0, denied: 0, throttled: 0, notional: 0, lastAt: 0 }

  /**
   * 判定一个请求。
   * @param {object} options 宿主的 GenerateOptions（只读）
   * @returns {{allow:boolean, level:string, reason:string, decision:object, delayMs:number, failure?:object}}
   */
  function judge(options = {}) {
    const sessionId = optsSessionId(options)
    const turn = options.turn ?? 0
    const fromUserMessage = readFromUserMessage(options)

    if (!config.enabled) {
      return { allow: true, level: 'r0', reason: 'disabled', decision: null, delayMs: 0 }
    }

    // 只处理 agent loop 的请求：用「冻结 + 有 sessionId」做启发式。
    // 失败方向是「认不出来 → 放行」，因此永不会误拦。
    if (!isAgentRequest(options)) {
      return { allow: true, level: 'r0', reason: 'not-agent-request', decision: null, delayMs: 0 }
    }

    stats.seen++

    const pos = waste.score(sessionId)
    const ex = exempt.evaluate(sessionId, {
      turn,
      lastUserTurn: budget.lastUserTurn(sessionId),
      fromUserMessage,
      yieldRate: pos?.yieldRate ?? 0,
      projectId: options.projectId ?? options.cwd,
      toolName: options.toolName,
      path: options.path,
    })

    const decision = policy.compose(config, { ...pos, turn }, ex)

    // R5 限流：最小间隔
    let delayMs = 0
    if (decision.level === 'r5') {
      const since = clock() - stats.lastAt
      delayMs = Math.max(0, config.throttleMs - since)
      if (delayMs > 0) stats.throttled++
    }
    stats.lastAt = clock()

    // 影子记录：无论放不放，都留一行，供回测
    try {
      shadow?.record({
        ts: clock(),
        sessionId,
        turn,
        dim: decision.driver?.dim ?? null,
        patterns: (decision.patterns ?? []).map((p) => p.id),
        level: decision.level,
        notional: decision.notional ?? decision.level,
        dryRun: !!config.dryRun,
        mode: config.mode,
        wouldBlock: decision.level === 'r7',
        exempt: decision.exempt ?? [],
        yieldRate: pos?.yieldRate ?? null,
      })
    } catch { /* 影子失败不影响主流程 */ }

    if (decision.level !== 'r0') stats.notional++

    if (!decision.allow) {
      stats.denied++
      const failure = lockError(
        'TOKEN_LOCK_DENIED',
        `${PREFIX} 本次请求被拦下（${decision.reason}）。这是「拦浪费不拦工作」的最后一级，` +
        `只有行为维/调度维能到这里。用 /token-lock status 看依据，或 /token-lock unlock 10m 临时放行。`,
      )
      return { allow: false, level: decision.level, reason: decision.reason, decision, delayMs: 0, failure }
    }

    stats.allowed++
    return { allow: true, level: decision.level, reason: decision.reason, decision, delayMs }
  }

  /** 把判定结果落账 + 出提示 */
  function afterJudge(sessionId, result) {
    if (!result || result.level === 'r0') return
    try {
      ledger.note(sessionId, {
        ts: clock(),
        level: result.level,
        reason: result.reason,
        driver: result.decision?.driver?.id ?? null,
      })
    } catch { /* ignore */ }
    if (result.level !== 'r0' && config.verboseLog) {
      log?.info?.(`${PREFIX} ${sessionId} → ${result.level} (${result.reason})`)
    }
  }

  return { judge, afterJudge, stats, lockError, finishChunk }
}

/** 从 options 里尽量取出会话 id（各版本字段名不同，容错） */
function optsSessionId(options) {
  return options.sessionId ?? options.session?.id ?? options.session?.sessionId ?? 'unknown'
}

/**
 * 判断是不是 agent loop 的请求。
 * 宿主里 isAgentLoopRequest 是进程内 WeakSet，跨包拿不到，这里用启发式：
 * 冻结 + 有 sessionId。认不出来的方向是「当成不是」，即放行。
 */
function isAgentRequest(options) {
  try {
    if (!options || typeof options !== 'object') return false
    if (options.sessionId === undefined && options.session === undefined) return false
    return Object.isFrozen(options) || options.agent === true || options.isAgentLoop === true
  } catch {
    return false
  }
}

/** 这次请求是不是由用户消息直接触发（E3 用） */
function readFromUserMessage(options) {
  try {
    return options.trigger === 'user' ||
      options.source?.kind === 'user' ||
      options.reason === 'user-message'
  } catch {
    return false
  }
}
