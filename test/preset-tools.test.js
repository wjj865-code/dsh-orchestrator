import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../preset-tools.js'

// 审计日志目录通过 config.stateDir 注入临时目录，不改 process.env（避免与 index.test 的 DSH_HOME 交错）。
const logHome = mkdtempSync(join(tmpdir(), 'orch-preset-log-'))
const logStateDir = join(logHome, 'state', 'orchestrator')
const applyIsolated = (ctx, config = {}) => apply(ctx, { stateDir: logStateDir, ...config })
after(() => { rmSync(logHome, { recursive: true, force: true }) })

// 假 ctx：模拟预设 scope 的 tools/change 事件、restrict 返回值与 effect 清理。
const makeCtx = (globals = []) => {
  let names = [...globals]
  const listeners = []
  const calls = []
  const lifts = []
  const cleanups = []
  const logLines = []
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
    logger: { info: message => logLines.push(message) },
    setGlobals: next => { names = [...next] },
    fire: () => { for (const listener of [...listeners]) listener() },
    calls,
    lifts,
    logLines,
    // 协调者最终能看到的工具表：全局工具去掉被 deny 的，加上预设自有工具。
    visible: (presetOwned = []) => {
      const denied = new Set(calls.flatMap(call => call.deny ?? []))
      return [...names.filter(item => !denied.has(item)), ...presetOwned].sort()
    },
    listenerCount: () => listeners.length,
    cleanup: () => { for (const fn of cleanups) fn() },
  }
  return ctx
}

test('preset-tools 用 deny 补集保留 allow，不把 allow 交给 restrict', () => {
  const ctx = makeCtx(['task_create', 'read', 'bash'])
  applyIsolated(ctx, { allow: ['task_create'] })
  assert.deepEqual(ctx.calls, [{ deny: ['read', 'bash'] }])
  assert.equal(name, 'dsh-orchestrator-preset-tools')
})

test('mount 后动态注册的全局工具被 deny，协调者工具表不增加', () => {
  const ctx = makeCtx(['task_create', 'read'])
  applyIsolated(ctx, { allow: ['task_create'] })
  assert.deepEqual(ctx.visible(['ask_user_question']), ['ask_user_question', 'task_create'])
  // 模拟别的插件后注册一个新工具（不写死工具名，按「不在 allow 的全局工具」判定）。
  ctx.setGlobals(['task_create', 'read', 'exec_shell'])
  ctx.fire()
  assert.deepEqual(ctx.calls.at(-1), { deny: ['exec_shell'] })
  assert.deepEqual(ctx.visible(['ask_user_question']), ['ask_user_question', 'task_create'])
})

test('mount 时一次性 deny 已存在的全部非 allow 全局工具，并写审计日志', () => {
  const ctx = makeCtx(['task_create', 'read', 'bash', 'glob'])
  applyIsolated(ctx, { allow: ['task_create'] })
  assert.deepEqual(ctx.calls, [{ deny: ['read', 'bash', 'glob'] }])
  assert.deepEqual(ctx.logLines, ['preset-tools: deny read, bash, glob'])
  ctx.setGlobals(['task_create', 'read', 'bash', 'glob', 'web_search'])
  ctx.fire()
  assert.deepEqual(ctx.logLines.at(-1), 'preset-tools: deny web_search')
})

test('后注册的全局工具在 tools/change 后补 deny，且不重复', () => {
  const ctx = makeCtx(['task_create', 'task_list'])
  applyIsolated(ctx, { allow: ['task_create', 'task_list'] })
  assert.equal(ctx.calls.length, 0)
  ctx.setGlobals(['task_create', 'task_list', 'show_view'])
  ctx.fire()
  assert.deepEqual(ctx.calls, [{ deny: ['show_view'] }])
  ctx.fire()
  assert.equal(ctx.calls.length, 1)
})

test('allow 名单里的工具即使后注册也不会被 deny', () => {
  const ctx = makeCtx([])
  applyIsolated(ctx, { allow: ['task_create'] })
  assert.equal(ctx.calls.length, 0)
  ctx.setGlobals(['task_create', 'task_status'])
  ctx.fire()
  assert.deepEqual(ctx.calls, [{ deny: ['task_status'] }])
})

test('四个原生自动化工具初始及晚注册均保留，未知工具继续 deny', () => {
  const schedule = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']
  for (const initial of [schedule, []]) {
    const ctx = makeCtx([...initial, 'read', 'bash', 'task_report', 'spawn_teammate'])
    applyIsolated(ctx, { allow: ['task_create', ...schedule] })
    ctx.setGlobals([...schedule, 'task_create', 'read', 'bash', 'task_report', 'spawn_teammate', 'schedule_future'])
    ctx.fire()
    assert.deepEqual(ctx.visible(), [...schedule, 'task_create'].sort())
    assert.deepEqual(ctx.calls.flatMap(call => call.deny), ['read', 'bash', 'task_report', 'spawn_teammate', 'schedule_future'])
    ctx.cleanup()
    assert.equal(ctx.listenerCount(), 0)
    assert.ok(ctx.lifts.every(lift => lift.called))
  }
})

test('run_code 不可 deny，跳过', () => {
  const ctx = makeCtx(['run_code', 'read'])
  applyIsolated(ctx, { allow: ['task_create'] })
  assert.deepEqual(ctx.calls, [{ deny: ['read'] }])
})

test('空 allow 直接报错（避免协调者工具全开或全空）', () => {
  assert.throws(() => apply(makeCtx(['read']), {}), /allow/)
  assert.throws(() => apply(makeCtx(['read']), { allow: [] }), /allow/)
})

test('遮挡式（deny）：只遮点名工具，其余全局工具原样继承', () => {
  const ctx = makeCtx(['context', 'memory_note', 'task_detail', 'task_report', 'read'])
  applyIsolated(ctx, { deny: ['memory_note'] })
  assert.deepEqual(ctx.calls, [{ deny: ['memory_note'] }])
  assert.deepEqual(ctx.visible(), ['context', 'read', 'task_detail', 'task_report'])
})

test('遮挡式：后注册的 deny 目标经 tools/change 补遮，且不重复', () => {
  const ctx = makeCtx(['context'])
  applyIsolated(ctx, { deny: ['memory_note'] })
  assert.equal(ctx.calls.length, 0)
  ctx.setGlobals(['context', 'memory_note'])
  ctx.fire()
  assert.deepEqual(ctx.calls, [{ deny: ['memory_note'] }])
  ctx.fire()
  assert.equal(ctx.calls.length, 1)
  assert.deepEqual(ctx.visible(), ['context'])
})

test('keep 是「出生即可用」的正向声明：确认后写 preset.keep 审计，未注册时静默等待', () => {
  const ctx = makeCtx(['memory_note', 'task_report'])
  applyIsolated(ctx, { deny: ['memory_note'], keep: ['context', 'task_detail', 'task_report'] })
  // 只确认已注册的 task_report；context / task_detail 还没注册 → 不抛、不误报。
  assert.deepEqual(ctx.calls, [{ deny: ['memory_note'] }])
  assert.deepEqual(ctx.logLines, ['preset-tools: deny memory_note', 'preset-tools: keep task_report'])
  // 稍后注册上来的 keep 目标补确认（幂等，不重复记）。
  ctx.setGlobals(['memory_note', 'task_report', 'context', 'task_detail'])
  ctx.fire()
  assert.deepEqual(ctx.logLines.at(-1), 'preset-tools: keep context, task_detail')
  ctx.fire()
  assert.equal(ctx.logLines.filter(line => line.startsWith('preset-tools: keep')).length, 2)
  // keep 的工具有没有被误遮：没有（context 与 task_report 都还在）。
  assert.deepEqual(ctx.visible(), ['context', 'task_detail', 'task_report'])
})

test('keep-only（deny 为空）：不遮任何工具，只做「出生即可用」正向声明', () => {
  // 子会话预设 0.29.x 起就是这一形态：不再遮 memory_note（子会话可写项目记忆），只 keep 声明。
  const ctx = makeCtx(['context', 'memory_note', 'task_detail', 'task_report'])
  applyIsolated(ctx, { keep: ['context', 'task_detail', 'task_report', 'memory_note'] })
  assert.deepEqual(ctx.calls, [], '没有 deny 名单 → 一次 restrict 都不该发')
  assert.deepEqual(ctx.logLines, ['preset-tools: keep context, task_detail, task_report, memory_note'])
  // memory_note 不被遮：子会话工具表里保留它（写权限由执行层按任务归属校验）。
  assert.deepEqual(ctx.visible(), ['context', 'memory_note', 'task_detail', 'task_report'])
})

test('配置互斥：allow 与 deny 只能二选一，deny 与 keep 不许重叠，keep 只用于遮挡式', () => {
  assert.throws(() => apply(makeCtx([]), { allow: ['task_create'], deny: ['memory_note'] }), /二选一/)
  assert.throws(() => apply(makeCtx([]), { deny: ['memory_note'], keep: ['memory_note'] }), /冲突/)
  assert.throws(() => apply(makeCtx([]), { allow: ['task_create'], keep: ['context'] }), /keep/)
  // 三份名单全空是配置错误（工具表要么全空要么全开）；keep-only 合法，见上一条。
  assert.throws(() => apply(makeCtx([]), {}), /allow|deny/)
  assert.throws(() => apply(makeCtx([]), { deny: [], keep: [] }), /allow|deny/)
})

test('dispose 时移除 tools/change 监听并解除 deny', () => {
  const ctx = makeCtx(['read'])
  applyIsolated(ctx, { allow: ['task_create'] })
  assert.equal(ctx.listenerCount(), 1)
  assert.equal(ctx.calls.length, 1)
  ctx.cleanup()
  assert.equal(ctx.listenerCount(), 0)
  assert.equal(ctx.lifts[0].called, true)
})


test('deny 审计同时写插件自己的 JSONL', () => {
  const ctx = makeCtx(['read', 'bash'])
  applyIsolated(ctx, { allow: ['task_create'] })
  const dir = join(logStateDir, 'logs')
  const files = readdirSync(dir).filter(file => file.endsWith('.jsonl'))
  assert.ok(files.length > 0, '没有写日志文件')
  const text = files.map(file => readFileSync(join(dir, file), 'utf8')).join('')
  assert.match(text, /"event":"preset\.deny"/)
  assert.match(text, /read/)
  assert.match(text, /bash/)
  assert.deepEqual(ctx.logLines, ['preset-tools: deny read, bash'])
})
