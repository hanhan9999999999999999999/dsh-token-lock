/**
 * policy.js — 合成器：把「看到了什么」变成「这一次怎么办」
 *
 * ★ 这是整个插件唯一能决定「拒绝」的地方，因此它必须是最保守的一层。
 *
 * 合成顺序（顺序本身是安全保证，任何一步算错方向都是更宽松）：
 *   1. 硬豁免      E4/E5/E6/E7 命中 → 直接 r0/r1，后面全部不再看
 *   2. 按维封顶    D2 最高 r3、D5 永不超 r2、D4 只到 r4 且只禁「新建」
 *   3. 产出压制    产出率高于阈值 → 整体降级（产出会话永不被拦）
 *   4. 模式档位    observe 一律 r0；advise 最高 r3；enforce 才放开
 *   5. 配置封顶    levels.r4..r7 若非 true，永不越过 r3
 *   6. dryRun      是则只记 notional，实际返回 r0
 *
 * ★ 两条不可动摇的性质：
 *   - 只有 D3（行为）与 D6（调度）的命中可以升到 r7。
 *   - 默认 mode='advise' 时，物理上不可能产生 deny。
 */

const ORDER = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']

/** 各维最高等级（D5 成本维只是观测，永不参与限制） */
const DIM_CEILING = Object.freeze({
  d1: 'r3',
  d2: 'r3',
  d3: 'r7',
  d4: 'r4',
  d5: 'r2',
  d6: 'r7',
  d7: 'r2',
})

/** 哪些维有资格升 r7 */
const R7_DIMS = new Set(['d3', 'd6'])

const idx = (l) => Math.max(0, ORDER.indexOf(l))
const minOf = (a, b) => (idx(a) <= idx(b) ? a : b)
const maxOf = (a, b) => (idx(a) >= idx(b) ? a : b)

/** 模式档位上限 */
function modeCeiling(mode) {
  if (mode === 'observe') return 'r0'
  if (mode === 'advise') return 'r3'
  return 'r7'
}

/** 配置里显式允许的最高等级 */
function configCeiling(config) {
  let top = 'r0'
  for (const l of ORDER) {
    if (config.levels?.[l] === true) top = l
  }
  return top
}

/**
 * @param {object} config
 * @param {object} pos {patterns, yieldRate, thresholds, turn, dryRun}
 * @param {object} ex  {ceiling, exempt, reasons}  来自 exempt.evaluate
 * @returns {object} decision
 */
export function compose(config, pos, ex) {
  const patterns = Array.isArray(pos?.patterns) ? pos.patterns : []
  const exempt = ex?.exempt ?? []
  const reasons = ex?.reasons ?? {}

  // —— 第 1 步：硬豁免 ——
  // E4 白名单 / E5 令牌 / E7 学习期：只观察，什么都不做
  const hardExempt = exempt.some((e) => e === 'e4' || e === 'e5' || e === 'e7')
  if (hardExempt) {
    return mk('r0', 'exempt', { exempt, reasons, patterns: [] })
  }
  if (!patterns.length) {
    return mk('r0', 'nothing-detected', { exempt, reasons, patterns: [] })
  }

  // —— 第 2 步：按维封顶 ——
  let level = 'r0'
  let driver = null
  const capped = []
  for (const p of patterns) {
    const dimCap = DIM_CEILING[p.dim] ?? 'r2'
    const l = minOf(p.level, dimCap)
    capped.push({ ...p, level: l, cappedFrom: p.level })
    if (idx(l) > idx(level)) { level = l; driver = p }
  }

  // r7 资格检查：非 D3/D6 的命中一律压回 r6
  if (level === 'r7' && !R7_DIMS.has(driver?.dim)) level = 'r6'

  // —— 第 3 步：产出压制 ——
  // 用户就在场内（E1/E3）或产出高（E2）时整体降级
  if (exempt.includes('e1') || exempt.includes('e3')) {
    level = minOf(level, 'r3')
  }
  if (exempt.includes('e2')) {
    level = minOf(level, 'r2')
  }
  if (typeof ex?.ceiling === 'string') {
    level = minOf(level, ex.ceiling)
  }

  // —— 第 4 步：模式档位 ——
  level = minOf(level, modeCeiling(config.mode))

  // —— 第 5 步：配置封顶 ——
  // maxLevel 与 levels 里显式为 true 的项共同决定上限
  level = minOf(level, config.maxLevel ?? 'r3')
  level = minOf(level, configCeiling(config))

  // —— 第 6 步：dryRun ——
  const notional = level
  if (config.dryRun) level = 'r0'

  return mk(level, driver?.id ?? 'mixed', {
    exempt, reasons, patterns: capped, driver, notional,
    deny: level === 'r7',
  })
}

function mk(level, reason, extra = {}) {
  return {
    level,
    reason,
    deny: level === 'r7',
    allow: level !== 'r7',
    ...extra,
  }
}

/** R 等级的语义（给提示文案与日志用） */
export const LEVEL_MEANING = Object.freeze({
  r0: '观察，不打扰',
  r1: '记账',
  r2: '软提示',
  r3: '定向建议',
  r4: '禁止新建任务（不影响在跑的）',
  r5: '限流：请求间隔 ≥ 3s',
  r6: '要求先压缩再继续',
  r7: '硬停本次请求',
})

export { DIM_CEILING, R7_DIMS, ORDER }
