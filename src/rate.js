/**
 * rate.js — 速率与基线
 *
 * 两个职责：
 *   1. D1 时间维：本地 5 分钟请求数 vs 该项目的 P95。超过 P95×3 判「暴走」。
 *      —— 这不是配额，是异常检测：正常干活不会突然密度翻三倍。
 *   2. 产出率基线：冷启动用绝对阈值（0.8/0.3），攒够 minSessionsForBaseline
 *      个会话后改用同项目 14 天 P25/P75，并夹到 [yieldClampMin, yieldClampMax]。
 *
 * 为什么基线化：不同项目「1 个产出事件值多少 token」差一个量级，
 * 写代码的项目一次写成 2 万 token 很正常，读文档的项目 2 万 token 已经是灾难。
 */

export function createRate(config, store, clock = Date.now) {
  /** sessionId -> number[]（窗口内的时间戳，升序） */
  const hits = new Map()
  /** sessionId -> {turn, step, tokens} 用于产出率的样本 */
  const samples = new Map()

  let baseline = null          // { p25, p75, sessions, computedAt }
  let baselineLoading = null

  function ensureLoaded() {
    if (baseline || baselineLoading) return baselineLoading
    baselineLoading = store.readJson('baseline.json', null).then((b) => {
      if (b && typeof b.p25 === 'number' && typeof b.p75 === 'number') baseline = b
      return baseline
    })
    return baselineLoading
  }

  /** 记一次请求（在 llm/stream 进入时调用） */
  function hit(sessionId, ts = clock()) {
    let arr = hits.get(sessionId)
    if (!arr) { arr = []; hits.set(sessionId, arr) }
    arr.push(ts)
    // 顺手清理窗口外的
    const cutoff = ts - config.rateWindowMs * 4
    let i = 0
    while (i < arr.length && arr[i] < cutoff) i++
    if (i > 0) arr.splice(0, i)
  }

  function rateNow(sessionId, ts = clock(), windowMs = config.rateWindowMs) {
    const arr = hits.get(sessionId)
    if (!arr || !arr.length) return 0
    const cutoff = ts - windowMs
    let n = 0
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] >= cutoff) n++
      else break
    }
    return n
  }

  /** 记录一次轮次样本（waste 算完产出率后调用） */
  function recordSample(sessionId, sample) {
    let arr = samples.get(sessionId)
    if (!arr) { arr = []; samples.set(sessionId, arr) }
    arr.push({ ...sample, ts: clock() })
    if (arr.length > 200) arr.splice(0, arr.length - 200)
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
    return sorted[idx]
  }

  /**
   * 重算基线。输入是历史产出率样本数组。
   * 少于 minSessionsForBaseline 时返回 null（继续用绝对阈值）。
   */
  async function recalc(sessionSamples) {
    if (!Array.isArray(sessionSamples) || sessionSamples.length < config.minSessionsForBaseline) {
      return baseline
    }
    const sorted = [...sessionSamples].sort((a, b) => a - b)
    const p25 = percentile(sorted, 0.25)
    const p75 = percentile(sorted, 0.75)
    // 夹取：基线不能离谱
    const clamp = (v) => Math.min(config.yieldClampMax, Math.max(config.yieldClampMin, v))
    baseline = {
      p25: clamp(p25),
      p75: clamp(p75),
      sessions: sessionSamples.length,
      computedAt: clock(),
    }
    await store.writeJson('baseline.json', baseline)
    return baseline
  }

  /** 当前的 warn/cap 阈值：有基线用基线，没有用绝对默认 */
  function thresholds() {
    if (baseline && baseline.sessions >= config.minSessionsForBaseline) {
      return { warn: baseline.p75, cap: baseline.p25, source: 'baseline' }
    }
    return { warn: config.yieldWarn, cap: config.yieldCap, source: 'absolute' }
  }

  /** D1：是否暴走 */
  function verdict(sessionId, ts = clock()) {
    if (!baseline) {
      // 没有基线时只能靠绝对下限：5 分钟超过 60 次请求已经很不正常
      const n = rateNow(sessionId, ts)
      return { burst: n > 60, rate: n, p95: null, reason: 'no-baseline' }
    }
    const n = rateNow(sessionId, ts)
    return { burst: n > baseline.p95 * config.burstMultiplier, rate: n, p95: baseline.p95 }
  }

  /** 从历史样本里估计 P95 请求密度（供 recalc 时补 P95 字段） */
  async function learnP95(densities) {
    if (!Array.isArray(densities) || !densities.length) return null
    const sorted = [...densities].sort((a, b) => a - b)
    const p95 = percentile(sorted, 0.95)
    baseline = { ...(baseline ?? {}), p95, sessions: baseline?.sessions ?? 0, computedAt: clock() }
    await store.writeJson('baseline.json', baseline)
    return p95
  }

  function snapshot() {
    return {
      baseline,
      thresholds: thresholds(),
      sessions: hits.size,
    }
  }

  return { hit, rateNow, recordSample, recalc, thresholds, verdict, learnP95, snapshot, ensureLoaded }
}
