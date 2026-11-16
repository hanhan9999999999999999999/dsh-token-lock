/**
 * M0 验收：只看两件事 —— 能装、能卸。
 * 不测任何拦截行为，因为 M0 根本没有拦截逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject, state, DEFAULT_CONFIG } from '../src/index.js'

function makeCtx() {
  const handlers = new Map()
  return {
    ctx: {
      on(event, fn) {
        handlers.set(event, fn)
        return () => handlers.delete(event)
      },
    },
    fire(event) {
      const fn = handlers.get(event)
      if (typeof fn === 'function') return fn()
      return undefined
    },
    has(event) {
      return handlers.has(event)
    },
    handlers,
  }
}

test('插件标识与最小依赖声明', () => {
  assert.equal(name, 'dsh-token-lock')
  // 只声明 webServer 一个真实存在的服务：让框架保证 apply 时它已注入。
  // 不声明 → ctx.webServer 属于「未声明就要」，隔离键对不上会抛
  //   cannot get property "webServer" without inject。
  // 声明一堆不存在的（sessions/tokenMeter/logger）→ 宿主判 pending，
  //   apply 永不执行，等于装了但没装。两头都踩过，所以恰好声明一个。
  assert.deepEqual(inject, ['webServer'], '只声明 webServer，别的一个都不声明')
})

test('DEFAULT_CONFIG 冻结且默认不拦人', () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(DEFAULT_CONFIG.dryRun, true, '默认必须是绝对刹车')
  assert.equal(DEFAULT_CONFIG.mode, 'advise', '默认档位物理上不能 deny')
  assert.equal(DEFAULT_CONFIG.maxLevel, 'r3', '默认封顶在建议档')
  assert.ok(DEFAULT_CONFIG.shadow.windowTurns > 0)
  assert.equal(DEFAULT_CONFIG.levels.r7, false, 'r7 默认关闭')
})

test('apply 同步返回 undefined 并置位 loaded', () => {
  const { ctx } = makeCtx()
  const ret = apply(ctx, {})
  assert.equal(ret, undefined, 'apply 必须是同步函数')
  assert.equal(state.loaded, true)
  assert.ok(state.loadedAt > 0)
})

test('注册了 dispose 且触发后记录时间', () => {
  const { ctx, fire, has } = makeCtx()
  apply(ctx, { mode: 'observe' })
  assert.equal(has('dispose'), true, '必须注册 dispose 以便验证卸干净')
  assert.equal(state.disposedAt, 0)
  fire('dispose')
  assert.ok(state.disposedAt > 0)
})

test('缺省 config 不抛，未知键不炸', () => {
  const { ctx } = makeCtx()
  assert.doesNotThrow(() => apply(ctx))
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.doesNotThrow(() => apply(ctx, { totallyUnknownKey: 1, mode: 'enforce' }))
})

test('ctx 不含 on 时也不炸（防御性）', () => {
  assert.doesNotThrow(() => apply({}, {}))
  assert.doesNotThrow(() => apply(null, {}))
})
