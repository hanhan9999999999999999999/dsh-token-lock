/**
 * attr.js — 归因：这一轮的钱花在哪了
 *
 * 三切片（加起来 = 本轮 input + output）：
 *   1. fixed   固定开销 —— 系统提示、工具定义、schema。每次请求都要重发。
 *   2. context 上下文重放 —— 历史消息越长越贵，是长会话的主成本。
 *   3. work    实际工作 —— 本轮新增的工具结果、用户输入、模型输出。
 *
 * 为什么值得切：如果固定开销占比 >60%，说明「工具装太多」或「系统提示太长」，
 * 该动的是配置；如果上下文占比 >70%，说明该压缩；如果 work 占比高，
 * 这钱花得值，不该拦。
 *
 * ★ 只是估算。它不参与任何 deny 判定，只用于提示文案与 /token-lock why。
 */

/** 粗略估算：1 token ≈ 4 个字符（中文按 1.6 字符/token 算更接近，这里取保守方向） */
function estTokens(text, isCJK) {
  if (!text) return 0
  const s = String(text)
  return Math.ceil(s.length / (isCJK ? 1.6 : 4))
}

function looksCJK(s) {
  return /[\u4e00-\u9fff]/.test(String(s ?? ''))
}

export function createAttr(config, ledger) {
  /** sessionId -> 最近一次切片 */
  const cache = new Map()

  /**
   * 计算三切片。
   * @param {string} sessionId
   * @param {object} req {systemText, toolsText, historyText, workText, usage}
   * @returns {{fixed:number, context:number, work:number, total:number, ratio:object}}
   */
  function slice(sessionId, req = {}) {
    const usage = req.usage ?? ledger.get(sessionId)?.lastUsage ?? {}
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)

    const cjk = looksCJK(req.systemText) || looksCJK(req.historyText)
    const fixedEst = estTokens(req.systemText, cjk) + estTokens(req.toolsText, cjk)
    const histEst = estTokens(req.historyText, cjk)
    const workEst = estTokens(req.workText, cjk)

    const estSum = fixedEst + histEst + workEst
    // 按估算比例把真实 total 分配下去；估不出来就全给 context
    let fixed, context, work
    if (estSum > 0) {
      fixed = Math.round((fixedEst / estSum) * total)
      context = Math.round((histEst / estSum) * total)
      work = Math.max(0, total - fixed - context)
    } else {
      fixed = 0
      context = total
      work = 0
    }

    const out = {
      fixed, context, work, total,
      ratio: {
        fixed: total ? fixed / total : 0,
        context: total ? context / total : 0,
        work: total ? work / total : 0,
      },
      estimates: { fixedEst, histEst, workEst },
    }
    cache.set(sessionId, out)
    return out
  }

  /**
   * 给出「该往哪下手」的判断句。只用于提示文案。
   * @returns {{headline:string, advice:string|null}}
   */
  function diagnose(sessionId) {
    const s = cache.get(sessionId)
    if (!s || !s.total) return { headline: '还没有足够的用量数据', advice: null }
    const r = s.ratio
    if (r.fixed >= 0.6) {
      return {
        headline: `固定开销占 ${pct(r.fixed)}，主要是系统提示与工具定义`,
        advice: '考虑减少同时启用的插件/工具数量，或缩短系统提示。',
      }
    }
    if (r.context >= 0.7) {
      return {
        headline: `上下文重放占 ${pct(r.context)}，历史消息是主成本`,
        advice: '先压缩再继续，比继续往下跑更省。',
      }
    }
    if (r.work >= 0.5) {
      return {
        headline: `实际工作占 ${pct(r.work)}，这部分钱花在了产出上`,
        advice: null,   // 不提示——这是正常且值得的
      }
    }
    return { headline: `成本分布：固定 ${pct(r.fixed)} / 上下文 ${pct(r.context)} / 工作 ${pct(r.work)}`, advice: null }
  }

  const pct = (n) => `${Math.round(n * 100)}%`

  function get(sessionId) {
    return cache.get(sessionId) ?? null
  }

  function snapshot() {
    return [...cache.entries()].map(([id, s]) => ({ sessionId: id, ...s }))
  }

  return { slice, diagnose, get, snapshot, estTokens }
}
