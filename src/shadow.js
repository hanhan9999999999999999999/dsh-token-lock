/**
 * shadow.js — 影子回测
 *
 * 干的事：把每一个「本来要拦」的判定记下来，然后回头看看——如果当时真拦了，
 * 会不会把一个正在干活的会话拦死。
 *
 * 判据：某条 wouldBlock 记录之后，该会话在 N（默认 5）轮内**仍有实打实产出**
 *       （写文件 / 测试转绿），就算一次误伤。
 *
 * 为什么必须有它：enforce 档一旦开启就会真的拒绝请求。开之前要有数据证明
 * 「这条线画得对」。误伤率 > 阈值的判定模式，代码层面直接禁止进 enforce。
 *
 * ★ 只在 shadow 里失败，不影响主流程；所有异常吞掉。
 */

export function createShadow(config, store, clock = Date.now) {
  /** 未结案的 wouldBlock：key = `${sessionId}:${turn}` */
  const pending = new Map()
  /** 累计统计 */
  const acc = { total: 0, wouldBlock: 0, confirmed: 0, falsePositive: 0, startedAt: clock() }

  /**
   * 记一行判定。只有 wouldBlock（notional 到 r7）才进 pending 观察。
   */
  function record(row) {
    try {
      acc.total++
      if (row.wouldBlock) {
        acc.wouldBlock++
        // 先对同一会话做过期结算：又过了 windowTurns 轮还没产出，
        // 说明当时那一刀切对了 → 计入 confirmed，judged 才能随事件流增长。
        // 不这样做的话 pending 只会在会话结束时结案，真实使用中 judged 恒为 0，
        // canEnforce() 永远 false，enforce 档实际永久不可达。
        const win = config.shadow?.windowTurns ?? 5
        for (const [key, p] of pending) {
          if (p.sessionId === row.sessionId && row.turn - p.turn > win) {
            pending.delete(key)
            acc.confirmed++
          }
        }
        pending.set(`${row.sessionId}:${row.turn}`, {
          sessionId: row.sessionId,
          turn: row.turn,
          at: row.ts ?? clock(),
          dim: row.dim,
          patterns: row.patterns ?? [],
        })
        // pending 不会无限涨：超过 2000 条丢最早的
        if (pending.size > 2000) {
          const first = pending.keys().next().value
          pending.delete(first)
        }
      }
      if (config.shadow?.persist && store) {
        store.appendJsonl('shadow.jsonl', row, config.maxShadowBytes)
      }
    } catch { /* 影子层永不抛 */ }
  }

  /**
   * 后续观测：某会话在第 turn 轮有了实打实产出。
   * 回头把窗口内所有 pending 标记为「误伤候选」。
   */
  function observe(sessionId, turn, productivity = 0) {
    if (!productivity || productivity <= 0) return
    try {
      const win = config.shadow?.windowTurns ?? 5
      for (const [key, p] of pending) {
        if (p.sessionId !== sessionId) continue
        if (turn > p.turn && turn - p.turn <= win) {
          acc.falsePositive++
          pending.delete(key)
        }
      }
    } catch { /* ignore */ }
  }

  /** 会话结束时把剩下的 pending 结案为「拦对了」（没有后续产出） */
  function settle(sessionId) {
    try {
      let n = 0
      for (const [key, p] of pending) {
        if (p.sessionId === sessionId) { pending.delete(key); n++ }
      }
      acc.confirmed += n
      return n
    } catch {
      return 0
    }
  }

  /** 误伤率 */
  function stats() {
    const judged = acc.confirmed + acc.falsePositive
    const rate = judged > 0 ? acc.falsePositive / judged : 0
    return {
      ...acc,
      pending: pending.size,
      judged,
      falsePositiveRate: round(rate),
      threshold: config.shadow?.maxFalsePositive ?? 0.005,
    }
  }

  /**
   * 能不能进 enforce。
   * @returns {{ok:boolean, why:string}}
   */
  function canEnforce() {
    const s = stats()
    if (s.judged < (config.shadow?.minJudge ?? 50)) {
      return { ok: false, why: `样本不足（${s.judged}/${config.shadow?.minJudge ?? 50}），继续观察` }
    }
    if (s.falsePositiveRate > s.threshold) {
      return { ok: false, why: `误伤率 ${(s.falsePositiveRate * 100).toFixed(2)}% 超过阈值 ${(s.threshold * 100).toFixed(2)}%，禁止进 enforce` }
    }
    return { ok: true, why: `误伤率 ${(s.falsePositiveRate * 100).toFixed(2)}%，在阈值内` }
  }

  /** 按维度统计误伤分布——哪条判据画错了线，看这里 */
  function byDim() {
    const out = {}
    for (const p of pending.values()) {
      const d = p.dim ?? 'none'
      out[d] = out[d] ?? { wouldBlock: 0 }
      out[d].wouldBlock++
    }
    return out
  }

  function snapshot() {
    return { ...stats(), dims: byDim() }
  }

  const round = (n) => Math.round(n * 10000) / 10000

  return { record, observe, settle, stats, canEnforce, byDim, snapshot }
}
