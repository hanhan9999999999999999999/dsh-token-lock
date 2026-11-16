/**
 * m2.mjs — 装配级测试（apply 之后的整体行为）
 *
 * m0 测的是「能不能装上」，m1 测的是「各模块单独对不对」，
 * 这里测的是「装起来之后，改配置真的会生效吗」—— 也就是那条静默失效的线。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { apply, inject, name, state, DEFAULT_CONFIG } from '../src/index.js'

let n = 0
const tmpDir = () => {
  const d = path.join(os.tmpdir(), `tl-m2-${process.pid}-${n++}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** 一个够真的假 ctx：只提供 on() 与 logger。 */
function makeCtx() {
  const handlers = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set())
      handlers.get(ev).add(fn)
      return () => handlers.get(ev).delete(fn)
    },
    emit(ev, ...args) {
      for (const fn of handlers.get(ev) ?? []) fn(...args)
    },
    handlers,
  }
  return ctx
}

/** 造一个「宿主送进来的 agent 请求」：冻结对象 + sessionId。 */
function agentOptions(sessionId = 's1') {
  return Object.freeze({ sessionId, messages: [], model: 'deepseek-flash' })
}

test('apply 之后 ctx.tokenLock 暴露完整开关面', () => {
  const ctx = makeCtx()
  apply(ctx, { dataDir: tmpDir() })
  const api = ctx.tokenLock
  assert.ok(api, 'ctx.tokenLock 应存在')
  for (const k of ['config', 'getConfig', 'ledger', 'rate', 'waste', 'exempt', 'gate', 'budget', 'attr', 'shadow', 'runtime']) {
    assert.ok(api[k], `ctx.tokenLock.${k} 应存在`)
  }
  assert.equal(state.loaded, true)
  // 恰好声明 webServer：少了 → ctx.webServer 抛「without inject」；
  // 多了（可选服务）→ 宿主判 pending，apply 永不执行。
  assert.deepEqual(inject, ['webServer'], '只声明 webServer 一个服务')
})

test('热配置：patchConfig 之后，子系统读到的是新值（不是 apply 时的快照）', () => {
  const ctx = makeCtx()
  apply(ctx, { dataDir: tmpDir(), mode: 'advise', dryRun: true })
  const api = ctx.tokenLock

  assert.equal(api.config.mode, 'advise')

  api.runtime.patchConfig({ mode: 'observe' })
  // ★ 这一条就是防「配置静默失效」的哨兵
  assert.equal(api.config.mode, 'observe', 'proxy 应读到新配置')
  assert.equal(api.getConfig().mode, 'observe')
})

test('热配置：patchConfig 改 maxLevel 立即影响 gate 判定', () => {
  const ctx = makeCtx()
  apply(ctx, { dataDir: tmpDir(), mode: 'enforce', dryRun: false, maxLevel: 'r0', levels: { r7: true } })
  const api = ctx.tokenLock

  // maxLevel r0 → 一律观察
  const before = api.gate.judge(agentOptions('s-hot-1'))
  assert.equal(before.level, 'r0')

  // 放开到 r3 之后，同样的请求不再是「永远 r0」
  api.runtime.patchConfig({ maxLevel: 'r3' })
  assert.equal(api.config.maxLevel, 'r3')
})

test('默认配置下，装配层永不 deny（生死线）', () => {
  const ctx = makeCtx()
  apply(ctx, { dataDir: tmpDir() })
  const api = ctx.tokenLock
  for (const sid of ['s-a', 's-b', 's-c']) {
    const r = api.gate.judge(agentOptions(sid))
    assert.equal(r.allow, true, `默认配置不该拦 ${sid}`)
    assert.equal(r.level, 'r0')
  }
})

test('dispose 只做清理，不影响已落盘数据', () => {
  const ctx = makeCtx()
  const dir = tmpDir()
  apply(ctx, { dataDir: dir })
  assert.ok(state.loaded)
  ctx.emit('dispose')
  assert.ok(state.disposedAt > 0)
  assert.ok(fs.existsSync(dir), '数据目录应还在')
})

test('路由只挂一次：webServer 已就绪 + ctx.inject 立即回调，不该重复注册或自我撤除', () => {
  const registrations = []
  const disposers = []
  const ctx = makeCtx()
  ctx.webServer = {
    // 照宿主真实语义：同一个 exact path 二次注册会 throw
    register(route) {
      if (registrations.includes(route.path)) {
        throw new Error(`webserver: duplicate exact route "${route.path}"`)
      }
      registrations.push(route.path)
      return () => disposers.push(route.path)
    },
  }
  // 宿主真实行为：inject 声明的服务已就绪时，ctx.inject 会「立刻同步回调」，
  // 不是等下一拍 —— 所以主路径 + 兜底回调会让 mountRoutes 被调两次。
  let injectCalls = 0
  ctx.inject = (names, cb) => {
    injectCalls += 1
    cb(ctx)
    return () => {}
  }

  apply(ctx, { dataDir: tmpDir() })

  assert.equal(registrations.length, 6, `六条路由应只注册一次，实际注册 ${registrations.length} 次`)
  assert.equal(new Set(registrations).size, 6, '六条 path 应各不相同')
  // ★ 这一条就是这次的病根：第二次挂载把第一次那套 dispose 掉了，净结果零路由
  assert.deepEqual(disposers, [], '不该有任何一条路由被自己撤掉')
  // 重做后：只留一条挂载路径，连 ctx.inject 都不该碰（第二次拿到的 webServer
  // 是另一个包装对象，靠对象身份守卫拦不住，只能靠「不注册第二条路径」）
  assert.equal(injectCalls, 0, '只声明 inject 就够，不要在 apply 里再 ctx.inject 兜底')
})

test('DEFAULT_CONFIG 的默认姿态：advise + dryRun + r3 封顶', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'advise')
  assert.equal(DEFAULT_CONFIG.dryRun, true)
  assert.equal(DEFAULT_CONFIG.maxLevel, 'r3')
  assert.equal(DEFAULT_CONFIG.levels.r4, false)
  assert.equal(DEFAULT_CONFIG.levels.r7, false)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(name, 'dsh-token-lock')
})
