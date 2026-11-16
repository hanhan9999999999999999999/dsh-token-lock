/**
 * ledger.js — 账本
 *
 * 唯一数据来源：`assistant/message` 事件的 `data.usage`（已实测确认）：
 *   { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
 *
 * 关键决定（DESIGN-V2 §16 / §22）：
 *   - KPI 只用 input + output。cacheRead 占实测 99.4%，单价约 miss 的 1/10，
 *     算进 KPI 会让「缓存命中越多越像在浪费」，方向是反的。
 *   - 只记已发生，绝不预扣。预测留给 budget 的派发预检，且只到 R3。
 *   - 内存里保留边际窗口（最近 N 轮），磁盘只写聚合行，防止账本自己变大。
 */

const emptyCounter = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  requests: 0, turns: 0, steps: 0, firstAt: 0, lastAt: 0,
})

function addInto(counter, u) {
  counter.input += u.inputTokens ?? 0
  counter.output += u.outputTokens ?? 0
  counter.cacheRead += u.cacheReadTokens ?? 0
  counter.cacheWrite += u.cacheWriteTokens ?? 0
  counter.requests += 1
}

export function createLedger(config, store, clock = Date.now) {
  /** sessionId -> { counter, turns: Map<turnNo, counter>, order: number[] } */
  const sessions = new Map()
  const day = emptyCounter()
  const project = emptyCounter()
  let dayKey = dayKeyOf(clock())

  function dayKeyOf(ts) {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  function rollDay() {
    const k = dayKeyOf(clock())
    if (k !== dayKey) {
      dayKey = k
      Object.assign(day, emptyCounter())
    }
  }

  function ensureSession(sessionId) {
    let s = sessions.get(sessionId)
    if (!s) {
      s = { counter: emptyCounter(), turns: new Map(), order: [], lastSeq: -1 }
      sessions.set(sessionId, s)
    }
    return s
  }

  /**
   * 处理一条 assistant/message。
   * @returns {{delta: object, turnCounter: object}|null}
   */
  function recordAssistant(sessionId, event) {
    const u = event?.data?.usage
    if (!u) return null
    const seq = event.seq ?? -1
    const s = ensureSession(sessionId)
    if (seq >= 0 && seq <= s.lastSeq) return null   // 去重：同一 seq 只记一次
    if (seq >= 0) s.lastSeq = seq

    rollDay()

    const turn = event.data?.turn ?? 0
    const step = event.data?.step ?? 0

    const delta = {
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadTokens ?? 0,
      cacheWrite: u.cacheWriteTokens ?? 0,
    }

    addInto(s.counter, u)
    addInto(day, u)
    addInto(project, u)

    let tc = s.turns.get(turn)
    if (!tc) {
      tc = emptyCounter()
      tc.firstAt = event.time ?? clock()
      s.turns.set(turn, tc)
      s.order.push(turn)
    }
    addInto(tc, u)
    if (step > tc.steps) tc.steps = step
    tc.turns = 1
    tc.lastAt = event.time ?? clock()
    s.counter.steps = Math.max(s.counter.steps, step)
    s.counter.turns = s.order.length

    return { delta, turnCounter: tc }
  }

  /** 一次 compaction/summary 也记 —— 压缩不是免费的，必须计入 */
  function recordCompaction(sessionId, event) {
    return recordAssistant(sessionId, event)
  }

  function get(sessionId) {
    const s = sessions.get(sessionId)
    if (!s) return null
    return {
      sessionId,
      ...s.counter,
      total: s.counter.input + s.counter.output,
      turns: s.order.length,
    }
  }

  /**
   * 边际窗口：最近 N 轮。
   * 分母只算窗口内的 input+output —— 这样长会话不会被前 189 轮的债拖死。
   */
  function marginal(sessionId, windowTurns = config.windowTurns) {
    const s = sessions.get(sessionId)
    if (!s) return { input: 0, output: 0, total: 0, turns: 0, steps: 0, fromTurn: 0, toTurn: 0 }
    const turns = s.order.slice(-windowTurns)
    let input = 0, output = 0, steps = 0
    for (const t of turns) {
      const c = s.turns.get(t)
      if (!c) continue
      input += c.input
      output += c.output
      steps += c.steps
    }
    return {
      input, output, total: input + output, steps,
      turns: turns.length,
      fromTurn: turns[0] ?? 0,
      toTurn: turns[turns.length - 1] ?? 0,
    }
  }

  /** 最近 n 轮的速率（tokens/ms），用于 eta 外推 */
  function burnRate(sessionId, turns = 3) {
    const s = sessions.get(sessionId)
    if (!s) return 0
    const recent = s.order.slice(-turns).map((t) => s.turns.get(t)).filter(Boolean)
    if (!recent.length) return 0
    const first = recent[0].firstAt || 0
    const last = recent[recent.length - 1].lastAt || 0
    const span = Math.max(1, last - first)
    const total = recent.reduce((a, c) => a + c.input + c.output, 0)
    return total / span   // tokens per ms
  }

  function dayTotals() {
    rollDay()
    return { dayKey, ...day, total: day.input + day.output }
  }

  function projectTotals() {
    return { ...project, total: project.input + project.output }
  }

  /** 所有会话的快照（面板用） */
  function snapshot() {
    const list = []
    for (const [id, s] of sessions) {
      const m = marginal(id)
      list.push({
        sessionId: id,
        input: s.counter.input,
        output: s.counter.output,
        cacheRead: s.counter.cacheRead,
        total: s.counter.input + s.counter.output,
        requests: s.counter.requests,
        turns: s.order.length,
        lastAt: s.counter.lastAt,
        marginalTotal: m.total,
      })
    }
    list.sort((a, b) => b.total - a.total)
    return { day: dayTotals(), project: projectTotals(), sessions: list }
  }

  /** 周期落盘（聚合行，不是每请求一行） */
  async function flush() {
    rollDay()
    await store.appendJsonl('ledger.jsonl', {
      ts: clock(),
      day: dayKey,
      dayTotal: day.input + day.output,
      dayInput: day.input,
      dayOutput: day.output,
      sessions: sessions.size,
      detail: [...sessions].map(([id, s]) => ({
        id,
        in: s.counter.input,
        out: s.counter.output,
        cr: s.counter.cacheRead,
        req: s.counter.requests,
      })),
    })
  }

  function dropSession(sessionId) {
    sessions.delete(sessionId)
  }

  return {
    recordAssistant, recordCompaction,
    get, marginal, burnRate, dayTotals, projectTotals, snapshot,
    flush, dropSession,
    get size() { return sessions.size },
  }
}
