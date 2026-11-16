/**
 * budget.js — 日预算、任务预算、派发预检
 *
 * 三种钱袋子，粒度不同：
 *   day     —— 跨会话的日预算（D5 成本维，只观测，永不单独触发限制）
 *   session —— 单会话预算（D6 调度维，可升到 r7）
 *   task    —— 单个目标/委派任务的预算（D6，可升到 r7）
 *
 * 以及 S10「派发前预检」：不预测式预扣，只在「明显超支」时提示一句。
 */

export function createBudget(config, ledger, store, clock = Date.now) {
  /** sessionId -> 最后一条用户消息所在轮次 */
  const lastUserTurn = new Map()
  /** sessionId -> 已拦次数（用于 R5 冷却） */
  const denyCount = new Map()
  /** taskId -> {startedAt, tokens, budget} */
  const tasks = new Map()

  function dayKey(ts = clock()) {
    const d = new Date(ts)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  /** 记录一次用户消息（E1/E3 的输入） */
  function noteUserMessage(sessionId, turn) {
    lastUserTurn.set(sessionId, turn)
  }

  function lastUserTurnOf(sessionId) {
    return lastUserTurn.has(sessionId) ? lastUserTurn.get(sessionId) : -Infinity
  }

  /** 今日已花（input+output，不算 cacheRead） */
  function daySpent() {
    try {
      return ledger.dayTotals()?.used ?? 0
    } catch {
      return 0
    }
  }

  /**
   * 日预算判定（D5：纯观测，最高 r2）
   * @returns {{level:string|null, spent:number, budget:number, eta:number|null}}
   */
  function checkDay(sessionId, p95Daily) {
    const spent = daySpent()
    const budget = config.dailyBudget > 0 ? config.dailyBudget : (p95Daily ?? 0)
    if (!budget || budget <= 0) return { level: null, spent, budget: 0, eta: null }
    const ratio = spent / budget
    const burn = ledger.burnRate?.(sessionId, config.windowTurns) ?? 0
    const eta = burn > 0 ? Math.max(0, (budget - spent) / burn) : null
    let level = null
    if (ratio >= config.capAt) level = 'r2'
    else if (ratio >= config.warnAt) level = 'r2'
    return { level, spent, budget, eta, ratio }
  }

  /**
   * S10 派发前预检：估算本次任务大概要花多少。
   * 不预扣、不阻止，只在超过日预算 30% 时给一句 r3 提示。
   * @param {object} est {sessionId, taskKind, steps?, contextTokens?}
   */
  function precheck(est = {}) {
    if (!config.detectors?.s10) return null
    const kind = est.taskKind ?? 'default'
    const hist = store?.readJson?.('task-p50.json', {}) ?? {}
    const p50Steps = hist[kind]?.steps ?? config.defaultSteps ?? 20
    const ctxTokens = Number(est.contextTokens ?? ledger.get(est.sessionId)?.total ?? 0) || 0
    // 每步大致要重发一次上下文
    const estimate = Math.round(p50Steps * Math.max(ctxTokens, 1000) * 0.15)
    const cap = (config.dailyBudget > 0 ? config.dailyBudget : Infinity) * 0.3
    if (estimate > cap) {
      return {
        id: 's10',
        dim: 'd6',
        level: 'r3',
        evidence: { kind, p50Steps, estimate, cap: Math.round(cap) },
      }
    }
    return null
  }

  /** 任务预算（D6，唯一能升 r7 的两维之一） */
  function openTask(taskId, budget = config.sessionBudget ?? 0) {
    tasks.set(taskId, { startedAt: clock(), tokens: 0, budget })
  }

  function chargeTask(taskId, tokens) {
    const t = tasks.get(taskId)
    if (t) t.tokens += tokens
  }

  function checkTask(taskId) {
    const t = tasks.get(taskId)
    if (!t || !t.budget) return { level: null }
    if (t.tokens >= t.budget) {
      return { level: 'r7', reason: 'task-budget-exhausted', taskId, spent: t.tokens, budget: t.budget }
    }
    if (t.tokens >= t.budget * 0.8) {
      return { level: 'r6', reason: 'task-budget-near', taskId, spent: t.tokens, budget: t.budget }
    }
    return { level: null }
  }

  function closeTask(taskId) {
    tasks.delete(taskId)
  }

  function bumpDeny(sessionId) {
    denyCount.set(sessionId, (denyCount.get(sessionId) ?? 0) + 1)
    return denyCount.get(sessionId)
  }

  function snapshot() {
    return {
      day: dayKey(),
      daySpent: daySpent(),
      sessions: lastUserTurn.size,
      tasks: [...tasks.entries()].map(([id, t]) => ({ id, ...t })),
    }
  }

  return {
    noteUserMessage,
    lastUserTurn: lastUserTurnOf,
    daySpent,
    checkDay,
    precheck,
    openTask, chargeTask, checkTask, closeTask,
    bumpDeny,
    snapshot,
    dayKey,
  }
}
