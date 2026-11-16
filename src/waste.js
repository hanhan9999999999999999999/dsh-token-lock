/**
 * waste.js — 空转检测与产出率
 *
 * 这是整个插件的判据核心。它回答一个问题：
 *   「这个会话最近这些轮，花的 token 换到了什么？」
 *
 * 判据编号（DESIGN-V2 §28）：
 *   P0 边际产出率   P1 单轮豁免
 *   S1 重复读  S2 重复命令  S3 连续失败  S4 零产出长跑  S5 上下文虚胖
 *   S6 图片堆积  S7 子会话爆炸  S8 速率异常  S9 项目级重犯
 *   S10 派发预估超限  S11 压缩不划算
 *
 * 红线（不可违反）：
 *   - 只读 event，绝不改写、绝不丢弃、绝不阻止事件进入会话。
 *   - 单测函数永远不抛；任何异常只让本次判定失效（返回 null）。
 *   - 产出证据优先：只要本轮有实打实的产出，任何模式检测都退让。
 */

/** 产出权重：一次文件写入值 1.0，一次成功工具调用值 0.3，测试转绿值 1.5 */
export const PRODUCTIVITY_WEIGHT = Object.freeze({
  write: 1.0,
  edit: 1.0,
  testGreen: 1.5,
  toolOk: 0.3,
  workspaceChange: 0.8,
  todoWrite: 0.2,
})

const WRITE_TOOLS = /^(write|create_file|apply_patch|str_replace|edit|multi_edit|write_file)$/i
const READ_TOOLS = /^(read|read_file|view|cat|inspect_local_file|open_file)$/i
const SEARCH_TOOLS = /^(grep|glob|search|rg|find|list_dir|ls)$/i
const BASH_TOOLS = /^(bash|shell|run|exec|command|ops_bash|terminal)$/i

/** 从 tool/call 的 arguments 里抠出文件路径与行号范围（容错，抠不到就 null） */
function readTarget(args) {
  if (!args) return null
  let o = args
  if (typeof args === 'string') {
    try { o = JSON.parse(args) } catch { return null }
  }
  const file = o.file_path ?? o.path ?? o.file ?? o.target_file
  if (typeof file !== 'string') return null
  const from = Number(o.offset ?? o.start ?? o.line ?? 0) || 0
  const limit = Number(o.limit ?? o.lines ?? 0) || 0
  return { file, from, to: limit ? from + limit : from + 2000 }
}

function bashCommand(args) {
  if (!args) return null
  let o = args
  if (typeof args === 'string') {
    try { o = JSON.parse(args) } catch { return typeof args === 'string' ? args : null }
  }
  const cmd = o.command ?? o.cmd ?? o.script
  return typeof cmd === 'string' ? cmd.trim().replace(/\s+/g, ' ') : null
}

function overlapRatio(a, b) {
  const lo = Math.max(a.from, b.from)
  const hi = Math.min(a.to, b.to)
  if (hi <= lo) return 0
  const inter = hi - lo
  const shorter = Math.min(a.to - a.from, b.to - b.from) || 1
  return inter / shorter
}

/** 工具结果是否算失败 */
function isFailure(event) {
  const d = event?.data ?? {}
  if (d.ok === false || d.success === false || d.isError === true || d.error) return true
  const text = typeof d.result === 'string' ? d.result : ''
  if (/^\s*(error|exception|failed)/i.test(text)) return true
  if (d.exitCode !== undefined && d.exitCode !== 0) return true
  return false
}

export function createWaste(config, ledger, rate, clock = Date.now) {
  /** sessionId -> state */
  const states = new Map()

  function ensure(sessionId) {
    let s = states.get(sessionId)
    if (!s) {
      s = {
        turn: 0, step: 0,
        turnProductivity: new Map(),   // turnNo -> 权重和
        recentReads: [],               // {file, from, to, seq, turn}
        recentCmds: [],                // {cmd, seq, turn}
        failStreak: 0,
        lastSuccessSeq: 0,
        imageCount: 0,
        children: new Set(),
        contextTokens: 0,
        contextWindow: 0,
        compactionCount: 0,
        compactionOutput: 0,
        lastTurnAt: 0,
        firstAt: 0,
        patterns: new Map(),           // id -> {hits, lastSeq}
      }
      states.set(sessionId, s)
    }
    return s
  }

  function bump(s, id) {
    const p = s.patterns.get(id) ?? { hits: 0, lastSeq: 0 }
    p.hits++
    p.lastSeq = s.lastSeq ?? 0
    s.patterns.set(id, p)
  }

  /** 给某一轮加产出分 */
  function addProductivity(s, turn, w) {
    s.turnProductivity.set(turn, (s.turnProductivity.get(turn) ?? 0) + w)
    if (s.turnProductivity.size > 200) {
      const first = s.turnProductivity.keys().next().value
      s.turnProductivity.delete(first)
    }
  }

  /**
   * 主入口：喂一条会话事件。
   * @returns {{patterns: object[], productivity: number}|null}
   */
  function onEvent(sessionId, event) {
    if (!event || typeof event.type !== 'string') return null
    let s
    try { s = ensure(sessionId) } catch { return null }
    s.lastSeq = event.seq ?? s.lastSeq
    if (!s.firstAt) s.firstAt = event.time ?? clock()
    s.lastTurnAt = event.time ?? s.lastTurnAt

    const t = event.type
    const d = event.data ?? {}
    const turn = typeof d.turn === 'number' ? d.turn : s.turn

    try {
      switch (t) {
        case 'turn/start':
          s.turn = d.turn ?? s.turn + 1
          if (!s.turnProductivity.has(s.turn)) s.turnProductivity.set(s.turn, 0)
          break

        case 'step/start':
          s.step = d.step ?? s.step + 1
          break

        case 'tool/call':
          handleToolCall(s, event, d, turn)
          break

        case 'tool/result':
          handleToolResult(s, event, d, turn)
          break

        case 'workspace/changes':
          addProductivity(s, turn, PRODUCTIVITY_WEIGHT.workspaceChange)
          break

        case 'todo/write':
          addProductivity(s, turn, PRODUCTIVITY_WEIGHT.todoWrite)
          break

        case 'request/context':
          if (typeof d.contextWindow === 'number') s.contextWindow = d.contextWindow
          break

        case 'compaction/start':
          s.compactionCount++
          break

        case 'compaction/summary': {
          const out = d.usage?.outputTokens ?? 0
          s.compactionOutput += out
          break
        }

        case 'job/registered':
          s.children.add(d.jobId ?? d.id ?? String(event.seq))
          break

        case 'job/settled':
          s.children.delete(d.jobId ?? d.id ?? String(event.seq))
          break

        case 'assistant/message': {
          // 统计图片块（S6）
          const content = d.message?.content
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === 'image' || c?.type === 'image_url') s.imageCount++
            }
          }
          break
        }

        default:
          break
      }
    } catch {
      return null
    }

    return { patterns: evaluate(s, sessionId, turn), productivity: s.turnProductivity.get(turn) ?? 0 }
  }

  function handleToolCall(s, event, d, turn) {
    const name = String(d.name ?? '')
    const callId = d.callId ?? d.id
    const args = d.arguments
    const seq = event.seq ?? 0

    if (WRITE_TOOLS.test(name)) {
      addProductivity(s, turn, PRODUCTIVITY_WEIGHT.write)
      s.recentReads = []   // 写过文件之后，之前的重复读判据清零
      return
    }

    if (READ_TOOLS.test(name)) {
      const tgt = readTarget(args)
      if (tgt) {
        const dup = s.recentReads.filter(
          (r) => r.file === tgt.file && overlapRatio(r, tgt) > config.repeatReadOverlap,
        )
        dup.push({ ...tgt, seq, turn })
        s.recentReads.push({ ...tgt, seq, turn })
        if (s.recentReads.length > 24) s.recentReads.splice(0, s.recentReads.length - 24)
        if (dup.length >= config.repeatReadTimes) bump(s, 's1')
      }
      return
    }

    if (BASH_TOOLS.test(name)) {
      const cmd = bashCommand(args)
      if (cmd) {
        const same = s.recentCmds.filter((c) => c.cmd === cmd)
        same.push({ cmd, seq, turn })
        s.recentCmds.push({ cmd, seq, turn })
        if (s.recentCmds.length > 24) s.recentCmds.splice(0, s.recentCmds.length - 24)
        if (same.length >= config.repeatCmdTimes) bump(s, 's2')
      }
      return
    }

    if (SEARCH_TOOLS.test(name)) {
      // 搜索也算弱产出：找到了东西才有用，这里只给极小权重，不参与主要判据
      return
    }
    // 其他工具：结果出来再算
    void callId
  }

  function handleToolResult(s, event, d, turn) {
    const failed = isFailure(event)
    if (failed) {
      s.failStreak++
      if (s.failStreak >= config.consecutiveFailures) bump(s, 's3')
    } else {
      s.failStreak = 0
      s.lastSuccessSeq = event.seq ?? 0
      addProductivity(s, turn, PRODUCTIVITY_WEIGHT.toolOk)
    }
  }

  /** 计算边际产出率：窗口内 Σ产出权重 / Σ(input+output) */
  function marginalYield(sessionId) {
    const s = states.get(sessionId)
    const m = ledger.marginal(sessionId, config.windowTurns)
    if (!s || !m.turns) return { rate: 0, productivity: 0, tokens: 0, turns: 0 }
    let prod = 0
    for (const t of s.turnProductivity.keys()) {
      if (t >= m.fromTurn && t <= m.toTurn) prod += s.turnProductivity.get(t) ?? 0
    }
    const tokens = m.total
    if (tokens <= 0) return { rate: 0, productivity: prod, tokens: 0, turns: m.turns }
    const raw = prod / (tokens / 10000)   // 每 1 万 token 换到多少产出
    return { rate: Math.min(raw, 3), productivity: prod, tokens, turns: m.turns }
  }

  /**
   * 综合判定。返回命中的模式数组（每项 {id, dim, level, evidence}）。
   * 注意：这里只给「建议级」，最终 clamp 由 policy 做。
   */
  function evaluate(s, sessionId, turn) {
    const out = []
    const y = marginalYield(sessionId)
    const th = rate.thresholds()

    // —— P0 边际产出率（D3 行为维）——
    if (config.detectors.p0 && y.turns >= 2) {
      // P1 单轮豁免：某一轮产出特别高，不看均值
      const single = s.turnProductivity.get(turn) ?? 0
      const exempt = config.detectors.p1 && single >= 1.0
      if (!exempt) {
        if (y.rate < th.cap) {
          out.push({ id: 'p0', dim: 'd3', level: 'r3', evidence: { rate: round(y.rate), cap: th.cap, source: th.source, turns: y.turns } })
        } else if (y.rate < th.warn) {
          out.push({ id: 'p0', dim: 'd3', level: 'r2', evidence: { rate: round(y.rate), warn: th.warn, source: th.source } })
        }
      }
    }

    // —— S1 重复读 ——（已由 bump 计数，这里检查计数是否够新鲜）
    if (config.detectors.s1 && fresh(s, 's1')) {
      out.push({ id: 's1', dim: 'd3', level: 'r2', evidence: { times: config.repeatReadTimes, overlap: config.repeatReadOverlap } })
    }

    // —— S2 重复命令 ——
    if (config.detectors.s2 && fresh(s, 's2') && s.failStreak > 0) {
      out.push({ id: 's2', dim: 'd3', level: 'r2', evidence: { times: config.repeatCmdTimes } })
    }

    // —— S3 连续失败 ——
    if (config.detectors.s3 && s.failStreak >= config.consecutiveFailures) {
      out.push({ id: 's3', dim: 'd3', level: 'r3', evidence: { streak: s.failStreak } })
    }

    // —— S4 零产出长跑 ——
    if (config.detectors.s4 && y.turns >= config.idleTurns && y.tokens > config.idleTokens) {
      const level = y.rate < th.cap ? 'r4' : 'r3'
      out.push({ id: 's4', dim: 'd3', level, evidence: { turns: y.turns, tokens: y.tokens, rate: round(y.rate) } })
    }

    // —— S5 上下文虚胖（D2 内容维，最高 R3）——
    if (config.detectors.s5 && s.contextWindow > 0) {
      const used = ledger.get(sessionId)?.total ?? 0
      if (used > config.contextBloatedTokens) {
        out.push({ id: 's5', dim: 'd2', level: 'r2', evidence: { used, window: s.contextWindow } })
      }
    }

    // —— S6 图片堆积（D4 结构维）——
    if (config.detectors.s6 && s.imageCount > config.maxImages) {
      out.push({ id: 's6', dim: 'd4', level: 'r2', evidence: { images: s.imageCount, max: config.maxImages } })
    }

    // —— S7 子会话爆炸（D4 结构维，只禁新建）——
    if (config.detectors.s7 && s.children.size > config.maxChildren) {
      out.push({ id: 's7', dim: 'd4', level: 'r4', evidence: { children: s.children.size, max: config.maxChildren } })
    }

    // —— S8 速率异常（D1 时间维）——
    const v = rate.verdict(sessionId)
    if (config.detectors.s8 && v.burst) {
      out.push({ id: 's8', dim: 'd1', level: 'r2', evidence: { rate: v.rate, p95: v.p95 } })
    }

    // —— S11 压缩不划算（D2，抽象为「压缩产出比」）——
    if (config.detectors.s11 && s.compactionCount > 0 && y.rate < th.cap && y.tokens < 20000) {
      out.push({ id: 's11', dim: 'd2', level: 'r2', evidence: { compactions: s.compactionCount, spent: s.compactionOutput, rate: round(y.rate) } })
    }

    return out
  }

  function fresh(s, id) {
    const p = s.patterns.get(id)
    if (!p) return false
    return (s.lastSeq ?? 0) - p.lastSeq <= 40   // 事件数窗口
  }

  const round = (n) => Math.round(n * 100) / 100

  function score(sessionId) {
    const s = states.get(sessionId)
    if (!s) return null
    const y = marginalYield(sessionId)
    return {
      sessionId,
      turn: s.turn,
      step: s.step,
      yieldRate: round(y.rate),
      productivity: round(y.productivity),
      windowTokens: y.tokens,
      windowTurns: y.turns,
      failStreak: s.failStreak,
      images: s.imageCount,
      children: s.children.size,
      contextWindow: s.contextWindow,
      compactions: s.compactionCount,
      patterns: evaluate(s, sessionId, s.turn),
      thresholds: rate.thresholds(),
    }
  }

  function reset(sessionId) {
    states.delete(sessionId)
  }

  return { onEvent, score, marginalYield, reset, get size() { return states.size } }
}
