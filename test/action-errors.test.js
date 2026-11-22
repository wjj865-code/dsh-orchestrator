import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ACTION_ERRORS, actionErrorText, panelFailure, toolFailure, panelHttpStatus,
} from '../src/action-errors.js'

const HTTP_STATUSES = new Set([200, 400, 404, 409, 500, 502])

test('错误码表：code 非空、HTTP 状态合法、至少有一个通道文案', () => {
  const codes = Object.keys(ACTION_ERRORS)
  assert.ok(codes.length > 0)
  for (const code of codes) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
    const spec = ACTION_ERRORS[code]
    assert.ok(HTTP_STATUSES.has(spec.http), `${code} 的 HTTP 状态非法：${spec.http}`)
    assert.equal(typeof spec.panel === 'function' || typeof spec.tool === 'function', true, `${code} 没有文案`)
  }
})

test('面板失败结果统一是 { ok:false, code, error }', () => {
  // 版本 B：错误文案不回声入参（面板 toast 也是用户面出口，回显 t-xxxx 等于自己泄漏）。
  const result = panelFailure('TASK_NOT_FOUND', { taskId: 't-x' })
  assert.deepEqual(result, { ok: false, code: 'TASK_NOT_FOUND', error: '找不到这个任务（可能已被删除或面板数据过期），刷新面板再试。' })
  assert.doesNotMatch(result.error, /t-x/)
  const retry = panelFailure('RETRY_NOT_ALLOWED', { label: '甲', statusLabel: '进行中' })
  assert.equal(retry.code, 'RETRY_NOT_ALLOWED')
  assert.match(retry.error, /只有失败或会话丢失/)
})

test('工具层文案复用同一张表，保持字符串契约', () => {
  const missing = toolFailure('TASK_NOT_FOUND', { taskId: 't-x', hint: '用 task_list 看任务的名称与引用。' })
  assert.equal(missing, '找不到这个任务引用。用 task_list 看任务的名称与引用。')
  assert.doesNotMatch(missing, /t-x/)
  assert.match(toolFailure('MESSAGE_WAITING_DEP', { label: '甲', depends: 't-1' }), /等待前置任务（t-1）/)
  assert.match(
    toolFailure('MESSAGE_WRITE_CONFLICT', { label: '甲', reason: '目标目录被「乙」（进行中）占着' }),
    /^未把消息追给任务「甲」：目标目录被「乙」（进行中）占着$/,
    'P0-3：追问被拒与面板同帧，必须点名任务与原因',
  )
  assert.equal(toolFailure('RETRY_FAILED', { reason: 'spawn boom' }), 'spawn boom')
})

test('未定义 code / 通道缺失直接抛，不静默成 400', () => {
  assert.throws(() => panelFailure('NOT_A_CODE'), /未定义的动作错误码/)
  assert.throws(() => actionErrorText('tool', 'MESSAGE_EMPTY'), /没有 tool 文案/)
})

test('panelHttpStatus：成功 200，已知 code 用映射，旧格式 400', () => {
  assert.equal(panelHttpStatus({ ok: true }), 200)
  assert.equal(panelHttpStatus({ ok: false, code: 'TASK_NOT_FOUND' }), 404)
  assert.equal(panelHttpStatus({ ok: false, code: 'RETRY_NOT_ALLOWED' }), 409)
  assert.equal(panelHttpStatus({ ok: false, code: 'MESSAGE_DELIVERY_FAILED' }), 502)
  assert.equal(panelHttpStatus({ ok: false, code: 'MESSAGE_WRITE_CONFLICT' }), 409)
  assert.equal(panelHttpStatus({ ok: false, code: 'STOP_FAILED' }), 500)
  assert.equal(panelHttpStatus({ ok: false, error: '旧格式' }), 400)
})

test('源码里使用的每个 panelFailure/toolFailure code 都在集中表里', () => {
  for (const file of ['../src/panel-actions.js', '../src/host-route.js', '../src/tools.js', '../src/workbench.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const match of source.matchAll(/(?:panelFailure|toolFailure)\('([A-Z][A-Z0-9_]*)'/g)) {
      assert.ok(ACTION_ERRORS[match[1]] !== undefined, `${file} 使用了未定义错误码 ${match[1]}`)
    }
  }
})
