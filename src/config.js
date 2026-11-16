/**
 * config.js — 全功能开关表
 *
 * 设计原则：
 *   1. 每个功能（维度 / 检测器 / 响应级 / 豁免 / 子系统）都有独立开关，关掉即彻底不运行。
 *   2. 所有默认值都是「最保守」：默认观测与提示，不拦人。
 *   3. 任何未知键忽略而不抛错（用户配置写错不该让插件装不上）。
 *   4. 校验失败只降级，不抛 —— 唯一的例外是明显危险的组合，用 warnings 报出来。
 *
 * 兼容：v1 的七个扁平键（mode/dryRun/dataDir/windowTurns/dailyBudget/warnAt/capAt）
 *       继续有效，会被 normalize 到新结构上。
 */

/** 七维（原六维 + D7 项目维） */
export const DIMENSIONS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']

/** 判据：P0 边际产出率 / P1 单轮豁免 / S1..S11 */
export const DETECTORS = [
  'p0', 'p1',
  's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8',
  's9', 's10', 's11',
]

/** 响应阶梯：R0 观察 / R1 记录 / R2 软提示 / R3 定向建议 / R4 封顶 / R5 限流 / R6 降档 / R7 硬停 */
export const LEVELS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']

/** 豁免：E1 用户在场 / E2 产出 / E3 交互 / E4 白名单 / E5 放行令牌 / E6 自适应预算 / E7 学习期 */
export const EXEMPTIONS = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']

export const MODES = ['observe', 'advise', 'enforce']

/** 全部子系统开关 */
export const SUBSYSTEMS = [
  'ledger',   // 记账
  'rate',     // 速率与基线
  'waste',    // 空转检测
  'exempt',   // 豁免计算
  'budget',   // 预算与派发预检
  'attr',     // 归因
  'shadow',   // 影子回测
  'routes',   // HTTP 面板
  'gate',     // llm/stream 拦截（关掉=纯观测，永不 deny）
]

const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const num = (v, d, lo, hi) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d
  return Math.min(hi, Math.max(lo, n))
}
const str = (v, d) => (typeof v === 'string' && v.length ? v : d)
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d)

/** 把一组开关按已知键归一：缺省=默认，未知=忽略 */
function switches(input, keys, defaultOn) {
  const src = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const k of keys) out[k] = bool(src[k], defaultOn)
  return out
}

export const DEFAULT_CONFIG = Object.freeze({
  // ── 总开关 ──────────────────────────────────────────────
  mode: 'advise',            // observe | advise | enforce
  dryRun: true,              // true = 即使算出 R4+ 也只记录不执行
  enabled: true,             // 插件总闸；false 时 apply 立即返回，不注册任何东西
  dataDir: '',               // 空 = <DSH_HOME>/storages/dsh-token-lock

  // ── 子系统开关（关掉即不加载该模块）────────────────────
  features: Object.freeze({
    ledger: true,
    rate: true,
    waste: true,
    exempt: true,
    budget: true,
    attr: true,
    shadow: true,
    routes: true,
    gate: true,
  }),

  // ── 维度开关（关掉该维永不产生动作）────────────────────
  dimensions: Object.freeze({
    d1: true,  // 时间：rate5m vs P95
    d2: true,  // 内容：上下文体量
    d3: true,  // 行为：空转模式
    d4: true,  // 结构：并发/子会话
    d5: true,  // 成本：纯观测
    d6: true,  // 调度：预算
    d7: false, // 项目级重犯（默认关：需要足够历史才有意义）
  }),

  // ── 检测器开关 ─────────────────────────────────────────
  detectors: Object.freeze({
    p0: true, p1: true,
    s1: true, s2: true, s3: true, s4: true, s5: true, s6: true,
    s7: true, s8: true, s9: false, s10: false, s11: true,
  }),

  // ── 响应上限（每一级都能单独关；maxLevel 是总天花板）──
  levels: Object.freeze({
    r0: true, r1: true, r2: true, r3: true,
    r4: false, r5: false, r6: false, r7: false,
  }),
  maxLevel: 'r3',           // 任何维度都不得超过此级
  throttleMs: 3000,         // R5 限流：两次请求的最小间隔

  // ── 豁免开关 ───────────────────────────────────────────
  exemptions: Object.freeze({
    e1: true,  // 用户在场
    e2: true,  // 产出豁免
    e3: true,  // 交互豁免（用户消息永不 R7）
    e4: true,  // 白名单
    e5: true,  // 放行令牌
    e6: true,  // 自适应预算
    e7: true,  // 学习期
  }),
  whitelist: Object.freeze([]),   // 工具名或会话 id，命中即 E4
  tokenTtlMs: 10 * 60 * 1000,     // E5 放行令牌有效期
  presentTurns: 2,          // E1：用户消息后多少轮内算「在场」
  learningSessions: 20,     // E7：见过多少个会话后结束学习期
  budgetHeadroom: 1.2,      // E6：自适应预算 = P95 日均 × 此系数

  // ── 记账 ───────────────────────────────────────────────
  windowTurns: 8,           // P0 边际产出率的滑动窗口轮数
  sampleRate: 1,            // ledger 采样率，1=全记；<1 时抽样并标 sampled:true
  maxLedgerBytes: 10 * 1024 * 1024,   // 单日账本上限，超了自动降采样
  maxShadowBytes: 5 * 1024 * 1024,
  shadow: Object.freeze({
    persist: true,          // 把 wouldBlock 决策写进 shadow.jsonl
    windowTurns: 5,         // 判定「误伤」的回看轮数
    minJudge: 50,           // 至少积累多少次 wouldBlock 才允许进 enforce
    maxFalsePositive: 0.005, // 误伤率上限，超过就禁止 enforce
  }),

  // ── 速率与基线 ─────────────────────────────────────────
  rateWindowMs: 5 * 60 * 1000,      // rate5m 窗口
  burstMultiplier: 3,               // rate5m > P95 × 此值 → D1 暴走
  minSessionsForBaseline: 20,       // 冷启动会话数阈值
  baselineRecalcMs: 24 * 60 * 60 * 1000,
  yieldWarn: 0.8,                   // 产出率低于此值 → 软提示
  yieldCap: 0.3,                    // 低于此值 → 定向建议
  yieldClampMin: 0.15,              // 基线化后的夹取下限
  yieldClampMax: 1.2,

  // ── 预算 ───────────────────────────────────────────────
  dailyBudget: 0,           // 0 = 不限
  sessionBudget: 0,         // 0 = 不限
  warnAt: 0.6,              // 用掉 60% → 提示
  capAt: 0.8,               // 用掉 80% → 封顶（若 levels.r4 开）
  dispatchCheckRatio: 0.3,  // 派发预估超过日预算此比例 → R3
  defaultSteps: 20,         // S10 派发预估的缺省步数（无历史时用）

  // ── 提示频率（不为省 token 而花 token）─────────────────
  hintCooldownMs: 60 * 60 * 1000,   // 同一级提示最小间隔
  hintMaxPerHour: 6,
  hintRoiFloor: 3,                  // 提示 ROI 低于此倍数 → 自动减半频次

  // ── 反自噬 ─────────────────────────────────────────────
  hookBudgetMs: 1,          // 单次 hook 目标耗时
  memoryBudgetMb: 20,
  selfDefense: true,        // 超限自动降 observe

  // ── 结构维 ─────────────────────────────────────────────
  maxChildren: 5,           // 同时活跃子会话上限
  maxImages: 24,            // 单会话图片块上限

  // ── 空转阈值 ───────────────────────────────────────────
  repeatReadTimes: 3,       // 连续重复读同一区间次数
  repeatReadOverlap: 0.7,   // 行号重叠率判同
  repeatCmdTimes: 3,
  consecutiveFailures: 4,
  idleTurns: 6,
  idleTokens: 400000,
  contextBloatedTokens: 600000,
  contextDeltaTokens: 2000,
  deadEndMinutes: 30,       // S4 走到 R6 后仍无产出，多久升 R7

  // ── 面板 ───────────────────────────────────────────────
  routePrefix: '/token-lock',
  verboseLog: false,
})

const clone = (o) => JSON.parse(JSON.stringify(o))

/**
 * 归一化用户配置。任何非法值退回默认，不抛。
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(input, env = {}) {
  const warnings = []
  const d = DEFAULT_CONFIG
  const src = input && typeof input === 'object' ? input : {}
  const out = clone(d)

  out.enabled = bool(src.enabled, d.enabled)
  out.mode = pick(src.mode, MODES, d.mode)
  if (src.mode && !MODES.includes(src.mode)) warnings.push(`未知 mode="${src.mode}"，回落 ${d.mode}`)
  out.dryRun = bool(src.dryRun, d.dryRun)

  // dataDir：显式 > DSH_HOME > 空
  out.dataDir = str(src.dataDir, '')
  if (!out.dataDir && env.DSH_HOME) out.dataDir = `${env.DSH_HOME.replace(/[\\/]+$/, '')}/storages/dsh-token-lock`
  if (!out.dataDir) out.dataDir = './.dsh-token-lock'

  out.features = switches(src.features, SUBSYSTEMS, true)
  out.dimensions = switches(src.dimensions, DIMENSIONS, true)
  out.dimensions.d7 = bool(src.dimensions?.d7, false)
  out.detectors = switches(src.detectors, DETECTORS, true)
  out.detectors.s9 = bool(src.detectors?.s9, false)
  out.detectors.s10 = bool(src.detectors?.s10, false)
  out.exemptions = switches(src.exemptions, EXEMPTIONS, true)

  // 响应级：默认只有 R0–R3 开
  const defLevels = { r0: true, r1: true, r2: true, r3: true, r4: false, r5: false, r6: false, r7: false }
  const lv = src.levels && typeof src.levels === 'object' ? src.levels : {}
  out.levels = {}
  for (const k of LEVELS) out.levels[k] = bool(lv[k], defLevels[k])

  out.maxLevel = pick(src.maxLevel, LEVELS, d.maxLevel)
  out.throttleMs = Math.round(num(src.throttleMs, d.throttleMs, 500, 60000))

  // 数值项：夹到合理区间
  out.windowTurns = Math.round(num(src.windowTurns, d.windowTurns, 1, 64))
  out.sampleRate = num(src.sampleRate, d.sampleRate, 0.01, 1)
  out.maxLedgerBytes = num(src.maxLedgerBytes, d.maxLedgerBytes, 65536, 1 << 30)
  out.maxShadowBytes = num(src.maxShadowBytes, d.maxShadowBytes, 65536, 1 << 30)
  out.shadow = {
    persist: bool(src.shadow?.persist, d.shadow.persist),
    windowTurns: Math.round(num(src.shadow?.windowTurns, d.shadow.windowTurns, 1, 100)),
    minJudge: Math.round(num(src.shadow?.minJudge, d.shadow.minJudge, 5, 100000)),
    maxFalsePositive: num(src.shadow?.maxFalsePositive, d.shadow.maxFalsePositive, 0, 1),
  }
  out.rateWindowMs = num(src.rateWindowMs, d.rateWindowMs, 10000, 3600000)
  out.burstMultiplier = num(src.burstMultiplier, d.burstMultiplier, 1.2, 20)
  out.minSessionsForBaseline = Math.round(num(src.minSessionsForBaseline, d.minSessionsForBaseline, 1, 1000))
  out.baselineRecalcMs = num(src.baselineRecalcMs, d.baselineRecalcMs, 60000, 7 * 86400000)
  out.yieldWarn = num(src.yieldWarn, d.yieldWarn, 0.05, 1.5)
  out.yieldCap = num(src.yieldCap, d.yieldCap, 0.01, 1.5)
  out.yieldClampMin = num(src.yieldClampMin, d.yieldClampMin, 0.01, 1)
  out.yieldClampMax = num(src.yieldClampMax, d.yieldClampMax, 0.2, 2)

  out.dailyBudget = Math.round(num(src.dailyBudget, d.dailyBudget, 0, 1e12))
  out.sessionBudget = Math.round(num(src.sessionBudget, d.sessionBudget, 0, 1e12))
  out.warnAt = num(src.warnAt, d.warnAt, 0.05, 0.99)
  out.capAt = num(src.capAt, d.capAt, 0.05, 1)
  out.dispatchCheckRatio = num(src.dispatchCheckRatio, d.dispatchCheckRatio, 0.01, 1)
  out.defaultSteps = Math.round(num(src.defaultSteps, d.defaultSteps, 1, 500))

  out.hintCooldownMs = num(src.hintCooldownMs, d.hintCooldownMs, 0, 86400000)
  out.hintMaxPerHour = Math.round(num(src.hintMaxPerHour, d.hintMaxPerHour, 0, 100))
  out.hintRoiFloor = num(src.hintRoiFloor, d.hintRoiFloor, 0, 100)

  out.hookBudgetMs = num(src.hookBudgetMs, d.hookBudgetMs, 0.1, 50)
  out.memoryBudgetMb = num(src.memoryBudgetMb, d.memoryBudgetMb, 2, 512)
  out.selfDefense = bool(src.selfDefense, d.selfDefense)

  out.maxChildren = Math.round(num(src.maxChildren, d.maxChildren, 1, 64))
  out.maxImages = Math.round(num(src.maxImages, d.maxImages, 1, 512))

  out.repeatReadTimes = Math.round(num(src.repeatReadTimes, d.repeatReadTimes, 2, 20))
  out.repeatReadOverlap = num(src.repeatReadOverlap, d.repeatReadOverlap, 0.3, 1)
  out.repeatCmdTimes = Math.round(num(src.repeatCmdTimes, d.repeatCmdTimes, 2, 20))
  out.consecutiveFailures = Math.round(num(src.consecutiveFailures, d.consecutiveFailures, 2, 30))
  out.idleTurns = Math.round(num(src.idleTurns, d.idleTurns, 2, 200))
  out.idleTokens = Math.round(num(src.idleTokens, d.idleTokens, 1000, 1e9))
  out.contextBloatedTokens = Math.round(num(src.contextBloatedTokens, d.contextBloatedTokens, 1000, 1e9))
  out.contextDeltaTokens = Math.round(num(src.contextDeltaTokens, d.contextDeltaTokens, 1, 1e7))
  out.deadEndMinutes = Math.round(num(src.deadEndMinutes, d.deadEndMinutes, 1, 1440))

  out.whitelist = Array.isArray(src.whitelist) ? src.whitelist.filter((x) => typeof x === 'string') : []
  out.tokenTtlMs = num(src.tokenTtlMs, d.tokenTtlMs, 1000, 86400000)
  out.presentTurns = Math.round(num(src.presentTurns, d.presentTurns, 0, 20))
  out.learningSessions = Math.round(num(src.learningSessions, d.learningSessions, 0, 10000))
  out.budgetHeadroom = num(src.budgetHeadroom, d.budgetHeadroom, 1, 10)
  out.routePrefix = str(src.routePrefix, d.routePrefix)
  if (!out.routePrefix.startsWith('/')) out.routePrefix = '/' + out.routePrefix
  out.verboseLog = bool(src.verboseLog, d.verboseLog)

  // ── 危险组合检查（只警告，不改）────────────────────────
  if (out.mode === 'enforce' && out.dryRun) {
    warnings.push('mode=enforce 但 dryRun=true：实际仍不会拦截；要真拦请同时设 dryRun=false')
  }
  if (out.levels.r7 && out.maxLevel !== 'r7') {
    warnings.push('levels.r7=true 但 maxLevel 低于 r7：R7 永远不会发生')
  }
  if (!out.features.gate && out.mode === 'enforce') {
    warnings.push('features.gate=false 时完全没有拦截钩子，enforce 无从生效')
  }
  if (out.yieldCap >= out.yieldWarn) {
    warnings.push('yieldCap 不小于 yieldWarn，两档建议会重合')
  }
  if (out.capAt <= out.warnAt) {
    warnings.push('capAt 不大于 warnAt，封顶提示不会出现')
  }

  return { config: out, warnings }
}

/** 该级别是否被允许（levels 开关 + maxLevel 天花板） */
export function levelAllowed(config, level) {
  const idx = LEVELS.indexOf(level)
  if (idx < 0) return false
  const maxIdx = LEVELS.indexOf(config.maxLevel)
  if (maxIdx >= 0 && idx > maxIdx) return false
  return config.levels[level] === true
}

/** 取最高允许级别（用于把任何请求夹回天花板） */
export function ceilingLevel(config) {
  let best = 'r0'
  for (const lv of LEVELS) if (levelAllowed(config, lv)) best = lv
  return best
}
