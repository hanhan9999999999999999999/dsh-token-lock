/**
 * M1 验收：把「不会误伤正常使用」这件事钉成断言。
 *
 * 生死线：默认配置下 compose() 物理上算不出 deny。
 * 唯一能 deny 的路径只有一条：enforce + dryRun:false + maxLevel:r7 + levels.r7 + 命中 D3/D6 + 无任何豁免。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { normalizeConfig } from '../src/config.js'
import { createStore } from '../src/store.js'
import { createLedger } from '../src/ledger.js'
import { createRate } from '../src/rate.js'
import { createWaste } from '../src/waste.js'
import { createExempt } from '../src/exempt.js'
import { createShadow } from '../src/shadow.js'
import { createBudget } from '../src/budget.js'
import { compose, DIM_CEILING, R7_DIMS } from '../src/policy.js'
import { createGate } from '../src/gate.js'

/* ---------------------------------------------------------------- 夹具 */

let tmpSeq = 0
function tmpDir() {
  const d = path.join(os.tmpdir(), `tl-test-${process.pid}-${++tmpSeq}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

const log = { warn() {}, info() {}, debug() {}, error() {} }

function build(over = {}, clock = () => Date.now()) {
  const { config } = normalizeConfig({ dataDir: tmpDir(), ...over }, { DSH_HOME: tmpDir() })
  const store = createStore(config, log)
  const ledger = createLedger(config, store, clock)
  const rate = createRate(config, store, clock)
  const waste = createWaste(config, ledger, rate, clock)
  const exempt = createExempt(config, ledger, rate, clock)
  const shadow = createShadow(config, store, clock)
  const budget = createBudget(config, ledger, store, clock)
  const policy = { compose: (cfg, pos, ex) => compose(cfg ?? config, pos, ex) }
  const gate = createGate({ config, log, ledger, rate, waste, exempt, policy, budget, shadow, clock })
  return { config, store, ledger, rate, waste, exempt, shadow, budget, policy, gate }
}

/** 造一个 policy 输入：patterns 是 [{id, dim, level}] */
function pos(patterns = [], extra = {}) {
  return { sessionId: 's1', turn: 3, patterns, ...extra }
}

const S_BURST = { id: 's3', dim: 'd3', level: 'r7', evidence: { failStreak: 6 } }
const S_RATE = { id: 'p1', dim: 'd1', level: 'r7', evidence: { rate: 999 } }
const S_CTX = { id: 's5', dim: 'd4', level: 'r7', evidence: { contextWindow: 900000 } }

/* ---------------------------------------------------- 1. 默认永不 deny */

test('默认配置：任何 pattern 组合都不 deny（生死线）', () => {
  const { config } = build()
  assert.equal(config.mode, 'advise')
  assert.equal(config.dryRun, true)
  assert.equal(config.maxLevel, 'r3')

  const combos = [
    [],
    [S_BURST],
    [S_RATE],
    [S_CTX],
    [S_BURST, S_RATE, S_CTX],
  ]
  for (const patterns of combos) {
    const d = compose(config, pos(patterns), { exempt: [], ceiling: 'r7' })
    assert.equal(d.deny, false, `默认配置竟算出 deny: ${JSON.stringify(d)}`)
    assert.equal(d.allow, true)
    assert.equal(d.level, 'r0')
  }
})

test('默认配置：dryRun 记录了 notional 但不执行', () => {
  const { config } = build()
  const d = compose(config, pos([S_BURST]), { exempt: [], ceiling: 'r7' })
  assert.equal(d.level, 'r0')
  assert.equal(d.notional, 'r3', 'dryRun 应把「本该是 r3」记在 notional 里')
})

/* ------------------------------------------------ 2. 模式档位真的生效 */

test('observe 模式：关掉 dryRun 也只是 r0', () => {
  const { config } = build({ mode: 'observe', dryRun: false, maxLevel: 'r7', levels: { r7: true } })
  const d = compose(config, pos([S_BURST]), { exempt: [], ceiling: 'r7' })
  assert.equal(d.level, 'r0')
  assert.equal(d.deny, false)
})

/* -------------------------------------------- 3. 非 D3/D6 的 r7 被压回 */

test('只有 D3/D6 有资格 r7：d1 的 r7 被压回 r6', () => {
  const { config } = build({ mode: 'enforce', dryRun: false, maxLevel: 'r7', levels: { r7: true, r6: true } })
  assert.equal(DIM_CEILING.d1, 'r3')
  assert.deepEqual([...R7_DIMS].sort(), ['d3', 'd6'])

  const d = compose(config, pos([S_RATE]), { exempt: [], ceiling: 'r7' })
  assert.equal(d.deny, false, 'D1 永远没资格 deny')
  assert.notEqual(d.level, 'r7')
})

test('D4 结构维最高只到 r4（禁新建，不中断在跑的活）', () => {
  const { config } = build({ mode: 'enforce', dryRun: false, maxLevel: 'r7', levels: { r7: true, r6: true, r5: true, r4: true } })
  const d = compose(config, pos([S_CTX]), { exempt: [], ceiling: 'r7' })
  assert.equal(d.deny, false)
  assert.equal(d.level, 'r4')
})

/* --------------------------------------------- 4. 唯一可 deny 的那条路 */

test('enforce + 非 dryRun + levels.r7 + D3 + 无豁免 → 唯一可 deny 路径', () => {
  const { config } = build({
    mode: 'enforce',
    dryRun: false,
    maxLevel: 'r7',
    levels: { r0: true, r1: true, r2: true, r3: true, r4: true, r5: true, r6: true, r7: true },
  })
  const d = compose(config, pos([S_BURST]), { exempt: [], ceiling: 'r7' })
  assert.equal(d.level, 'r7')
  assert.equal(d.deny, true)
  assert.equal(d.allow, false)
})

test('同一条件下只要有任一豁免，就 deny 不了', () => {
  const { config } = build({
    mode: 'enforce',
    dryRun: false,
    maxLevel: 'r7',
    levels: { r7: true, r6: true, r5: true, r4: true, r3: true, r2: true, r1: true },
  })
  for (const ex of [{ exempt: ['e1'], ceiling: 'r3' }, { exempt: ['e2'], ceiling: 'r2' }, { exempt: ['e3'], ceiling: 'r6' }]) {
    const d = compose(config, pos([S_BURST]), ex)
    assert.equal(d.deny, false, `豁免 ${ex.exempt} 竟然没挡住 deny`)
  }
})

/* --------------------------------------------------- 5. E4 白名单 → r0 */

test('E4 白名单命中：直接 r0，不再看任何模式', () => {
  const { config, exempt } = build({
    mode: 'enforce',
    dryRun: false,
    maxLevel: 'r7',
    levels: { r7: true },
    whitelist: ['D:\\whitelisted\\*'],
  })
  const ex = exempt.evaluate('s1', { turn: 5, lastUserTurn: -Infinity, projectId: 'D:\\whitelisted\\proj', path: 'D:\\whitelisted\\proj\\a.ts' })
  const d = compose(config, pos([S_BURST]), ex)
  assert.equal(d.level, 'r0')
  assert.equal(d.deny, false)
})

/* ------------------------------------------------------- 6. 影子回测门槛 */

test('shadow.canEnforce：样本不足时不许进 enforce', () => {
  const { shadow } = build()
  for (let i = 0; i < 10; i++) shadow.record({ sessionId: `s${i}`, turn: 1, wouldBlock: true, level: 'r7', dim: 'd3', patterns: ['s3'], ts: i })
  const gateRes = shadow.canEnforce()
  assert.equal(gateRes.ok, false)
  assert.match(String(gateRes.why), /judged|样本|50/)
})

test('shadow.canEnforce：50 样本 0 误伤 → 放行', () => {
  const { shadow } = build()
  // 每个会话都走到 turn 1 + turn 10：turn 10 那次 record 会把 turn 1 的 pending
  // 过期结算为「拦对了」（10 - 1 > windowTurns 5）。judged 因此随事件流增长。
  for (let i = 0; i < 60; i++) {
    shadow.record({ sessionId: `s${i}`, turn: 1, wouldBlock: true, level: 'r7', dim: 'd3', patterns: ['s3'], ts: i })
    shadow.record({ sessionId: `s${i}`, turn: 10, wouldBlock: true, level: 'r7', dim: 'd3', patterns: ['s3'], ts: i })
  }
  const gateRes = shadow.canEnforce()
  assert.equal(gateRes.ok, true, JSON.stringify(gateRes))
})

test('shadow.canEnforce：出现误伤就退回观察', () => {
  const { shadow } = build()
  for (let i = 0; i < 60; i++) {
    shadow.record({ sessionId: `s${i}`, turn: 1, wouldBlock: true, level: 'r7', dim: 'd3', patterns: ['s3'], ts: i })
    shadow.record({ sessionId: `s${i}`, turn: 10, wouldBlock: true, level: 'r7', dim: 'd3', patterns: ['s3'], ts: i })
  }
  assert.equal(shadow.canEnforce().ok, true)
  // s0 在第 3 轮仍有产出 → 落在 turn 10 那刀的观察窗口内？不在（10 > 3）。
  // 重新造一条落在窗口内的 pending 再观测。
  shadow.record({ sessionId: 'sX', turn: 1, wouldBlock: true, level: 'r7', dim: 'd3', patterns: ['s3'], ts: 999 })
  shadow.observe('sX', 3, 1)          // 第 3 轮有产出，且 3 - 1 = 2 <= 5 → 误伤
  const gateRes = shadow.canEnforce()
  assert.equal(gateRes.ok, false, JSON.stringify(gateRes))
  assert.match(String(gateRes.why), /误伤/)
})

/* ------------------------------------------------- 7. ledger.marginal 口径 */

test('ledger.marginal 只算最近窗口，不被历史债拖死', () => {
  let seq = 0
  const { ledger, config } = build({ windowTurns: 3 })
  const push = (turn, input, output) =>
    ledger.recordAssistant('s1', {
      seq: ++seq,
      data: { turn, step: 1, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: input + output } },
    })

  // 前 7 轮烧了很多，最后 3 轮很少
  for (let t = 1; t <= 7; t++) push(t, 100_000, 1_000)
  for (let t = 8; t <= 10; t++) push(t, 1_000, 100)

  const m = ledger.marginal('s1', config.windowTurns)
  assert.equal(m.turns, 3, '只应覆盖最近 3 轮')
  assert.equal(m.input, 3_000, `marginal 把历史 input 也算进去了: ${JSON.stringify(m)}`)
  assert.equal(m.output, 300, `marginal 把历史 output 也算进去了: ${JSON.stringify(m)}`)
  assert.equal(m.total, 3_300)
})

/* ---------------------------------------------------------- 8. gate 放行 */

test('gate：认不出的 options（非冻结）一律放行', () => {
  const { gate } = build({ mode: 'enforce', dryRun: false, maxLevel: 'r7', levels: { r7: true } })
  const r = gate.judge({ messages: [] })
  assert.equal(r.allow, true)
  assert.equal(r.reason, 'not-agent-request')
})

test('gate：冻结 + 有 sessionId 才进闸门，默认配置仍放行', () => {
  const { gate } = build()
  const opts = Object.freeze({ sessionId: 's1', turn: 1, messages: Object.freeze([]) })
  const r = gate.judge(opts)
  assert.equal(r.allow, true)
  assert.equal(r.level, 'r0')
})

test('gate：enabled:false 时直接放行', () => {
  const { gate } = build({ enabled: false })
  const r = gate.judge(Object.freeze({ sessionId: 's1', turn: 1 }))
  assert.equal(r.allow, true)
  assert.equal(r.reason, 'disabled')
})

/* ------------------------------------------------- 9. 拒绝形状可被宿主识别 */

test('拒绝形状：finish chunk + 带 code 的 Error', async () => {
  const { finishChunk, lockError } = await import('../src/gate.js')
  const err = lockError('TOKEN_LOCK_DENIED', 'denied')
  assert.equal(err.code, 'TOKEN_LOCK_DENIED')
  const chunk = finishChunk(err)
  assert.equal(chunk.type, 'finish')
  assert.equal(chunk.reason.kind, 'error')
  assert.equal(chunk.reason.failure.code, 'TOKEN_LOCK_DENIED')
})
