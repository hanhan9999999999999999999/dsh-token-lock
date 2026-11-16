/**
 * exempt.js — 七道豁免
 *
 * 豁免的意思是「这一次不许动它」，而不是「这一次少花点」。
 * 它们的存在理由：锁的价值是拦浪费，而下面这些情况里，限制的代价
 * 一定大于浪费的代价。
 *
 *   E1 用户在场     —— 2 轮内有人说话，说明有人在看，不许升到 R4 以上
 *   E2 产出豁免     —— 产出率 ≥ 阈值×2，这是高产会话，直接放行
 *   E3 交互豁免     —— 用户消息触发的请求永不 R7（人就在说话，断电没道理）
 *   E4 白名单       —— 项目/工具/路径命中白名单
 *   E5 放行令牌     —— 主人手动 /unlock 10m，到点自动失效
 *   E6 自适应预算   —— 有效预算 = max(config, 该项目 P95_7d × 1.2)
 *   E7 学习期       —— 新工作区前 N 个会话只记账不判定
 */

export function createExempt(config, ledger, rate, clock = Date.now) {
  /** sessionId -> 放行到期时间 */
  const tokens = new Map()
  /** 已观测到的会话总数（用于 E7 学习期判断） */
  const seenSessions = new Set()

  function grantToken(sessionId, minutes = Math.round(config.tokenTtlMs / 60_000)) {
    tokens.set(sessionId, clock() + minutes * 60_000)
    return tokens.get(sessionId)
  }

  function revokeToken(sessionId) {
    tokens.delete(sessionId)
  }

  function tokenActive(sessionId) {
    const until = tokens.get(sessionId)
    if (!until) return false
    if (until < clock()) { tokens.delete(sessionId); return false }
    return true
  }

  function markSeen(sessionId) {
    seenSessions.add(sessionId)
    return seenSessions.size
  }

  function matchesWhitelist(value, list) {
    if (!Array.isArray(list) || !list.length) return false
    const v = String(value ?? '')
    return list.some((p) => {
      const pat = String(p)
      if (pat.endsWith('*')) return v.startsWith(pat.slice(0, -1))
      return v === pat
    })
  }

  /**
   * 计算当前会话的豁免结论。
   * @param {string} sessionId
   * @param {object} ctx {lastUserTurn, turn, toolName, path, projectId, yieldRate}
   * @returns {{exempt: string[], ceiling: string|null, reasons: object}}
   */
  function evaluate(sessionId, ctx = {}) {
    const exempt = []
    const reasons = {}
    let ceiling = null    // null = 不额外封顶

    // E1 用户在场：最近 N 轮内有用户消息
    const lastUserTurn = ctx.lastUserTurn ?? -Infinity
    const turn = ctx.turn ?? 0
    if (config.exemptions.e1 && turn - lastUserTurn <= config.presentTurns) {
      exempt.push('e1')
      reasons.e1 = { lastUserTurn, turn }
      ceiling = minLevel(ceiling, 'r3')
    }

    // E2 产出豁免：产出率 ≥ 阈值 × 2
    const th = rate.thresholds()
    const y = ctx.yieldRate ?? 0
    if (config.exemptions.e2 && th.warn > 0 && y >= th.warn * 2) {
      exempt.push('e2')
      reasons.e2 = { yieldRate: y, threshold: th.warn * 2 }
      ceiling = minLevel(ceiling, 'r2')
    }

    // E3 交互豁免：本请求由用户消息直接触发
    if (config.exemptions.e3 && ctx.fromUserMessage) {
      exempt.push('e3')
      reasons.e3 = true
      ceiling = minLevel(ceiling, 'r6')   // 永不 R7
    }

    // E4 白名单：扁平数组，项目名 / 工具名 / 路径都往里放
    if (config.exemptions.e4) {
      if (matchesWhitelist(ctx.projectId, config.whitelist) ||
          matchesWhitelist(ctx.toolName, config.whitelist) ||
          matchesWhitelist(ctx.path, config.whitelist)) {
        exempt.push('e4')
        reasons.e4 = { project: ctx.projectId, tool: ctx.toolName, path: ctx.path }
        ceiling = minLevel(ceiling, 'r1')   // 白名单 = 只观察
      }
    }

    // E5 放行令牌
    if (config.exemptions.e5 && tokenActive(sessionId)) {
      exempt.push('e5')
      reasons.e5 = { until: tokens.get(sessionId) }
      ceiling = minLevel(ceiling, 'r1')
    }

    // E7 学习期：见过的会话还不够多
    if (config.exemptions.e7 && seenSessions.size < config.learningSessions) {
      exempt.push('e7')
      reasons.e7 = { seen: seenSessions.size, need: config.learningSessions }
      ceiling = minLevel(ceiling, 'r2')
    }

    return { exempt, ceiling, reasons }
  }

  /** E6 自适应预算：取 config 与 P95×1.2 的较大者，避免基线偏低时误封 */
  function effectiveBudget(sessionId, p95Daily) {
    if (!config.exemptions.e6) return config.dailyBudget
    if (!p95Daily || typeof p95Daily !== 'number') return config.dailyBudget
    return Math.max(config.dailyBudget, Math.round(p95Daily * config.budgetHeadroom))
  }

  const ORDER = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']
  function minLevel(a, b) {
    if (a === null) return b
    return ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b
  }

  function snapshot() {
    return { tokens: [...tokens.keys()], seenSessions: seenSessions.size }
  }

  return {
    evaluate, effectiveBudget, grantToken, revokeToken, tokenActive,
    markSeen, snapshot, minLevel,
    get seenCount() { return seenSessions.size },
  }
}
