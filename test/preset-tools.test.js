import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../preset-tools.js'

// 假 ctx：模拟预设 scope 的 tools/change 事件、restrict 返回值与 effect 清理。
const makeCtx = (globals = []) => {
  let names = [...globals]
  const listeners = []
  const calls = []
  const lifts = []
  const cleanups = []
  const ctx = {
    tools: {
      view: () => ({ restrictableNames: new Set(names) }),
      restrict: filter => {
        calls.push(filter)
        const lift = () => { lift.called = true }
        lifts.push(lift)
        return lift
      },
    },
    on: (event, listener) => {
      assert.equal(event, 'tools/change')
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect: fn => {
      cleanups.push(fn())
      return () => {}
    },
    setGlobals: next => { names = [...next] },
    fire: () => { for (const listener of [...listeners]) listener() },
    calls,
    lifts,
    listenerCount: () => listeners.length,
    cleanup: () => { for (const fn of cleanups) fn() },
  }
  return ctx
}

test('preset-tools 用 deny 补集保留 allow，不把 allow 交给 restrict', () => {
  const ctx = makeCtx(['task_create', 'read', 'bash'])
  apply(ctx, { allow: ['task_create'] })
  assert.deepEqual(ctx.calls, [{ deny: ['read', 'bash'] }])
  assert.equal(name, 'dsh-orchestrator-preset-tools')
})

test('后注册的全局工具在 tools/change 后补 deny，且不重复', () => {
  const ctx = makeCtx(['task_create', 'task_list'])
  apply(ctx, { allow: ['task_create', 'task_list'] })
  assert.equal(ctx.calls.length, 0)
  ctx.setGlobals(['task_create', 'task_list', 'show_view'])
  ctx.fire()
  assert.deepEqual(ctx.calls, [{ deny: ['show_view'] }])
  ctx.fire()
  assert.equal(ctx.calls.length, 1)
})

test('allow 名单里的工具即使后注册也不会被 deny', () => {
  const ctx = makeCtx([])
  apply(ctx, { allow: ['task_create'] })
  assert.equal(ctx.calls.length, 0)
  ctx.setGlobals(['task_create', 'task_status'])
  ctx.fire()
  assert.deepEqual(ctx.calls, [{ deny: ['task_status'] }])
})

test('run_code 不可 deny，跳过', () => {
  const ctx = makeCtx(['run_code', 'read'])
  apply(ctx, { allow: ['task_create'] })
  assert.deepEqual(ctx.calls, [{ deny: ['read'] }])
})

test('空 allow 直接报错（避免协调者工具全开或全空）', () => {
  assert.throws(() => apply(makeCtx(['read']), {}), /allow/)
  assert.throws(() => apply(makeCtx(['read']), { allow: [] }), /allow/)
})

test('dispose 时移除 tools/change 监听并解除 deny', () => {
  const ctx = makeCtx(['read'])
  apply(ctx, { allow: ['task_create'] })
  assert.equal(ctx.listenerCount(), 1)
  assert.equal(ctx.calls.length, 1)
  ctx.cleanup()
  assert.equal(ctx.listenerCount(), 0)
  assert.equal(ctx.lifts[0].called, true)
})
