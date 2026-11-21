import test from 'node:test'
import assert from 'node:assert/strict'
import { openSessionWhenReady } from '../client/src/open-session.js'

// t-8a81264c：开包会话后「跳到新会话」要等客户端会话目录收到新行。
// 宿主 `sessions.retain()` 对还没进目录的 id 同步抛 `sessions.retain: unknown session <id>`
// （pack-open 结果走 HTTP、新会话行走 WS，两者没有顺序保证），所以这里对这类错误短退避重试；
// 其它错误必须立刻失败——不能把真故障（没 openSession / 宿主拒绝）掩盖成「等一会儿就好」。

const unknownSession = id => new Error(`sessions.retain: unknown session ${id}`)

test('开包会话跳转：unknown session 重试到会话目录就绪', async () => {
  const waits = []
  let attempts = 0
  const result = await openSessionWhenReady(sessionId => {
    attempts += 1
    if (attempts < 3) throw unknownSession(sessionId)
  }, 'session-abc', { wait: async ms => { waits.push(ms) } })
  assert.deepEqual(result, { ok: true })
  assert.equal(attempts, 3, '第 3 次才成功：前两次都是 unknown session')
  assert.deepEqual(waits, [120, 240], '退避是 n × 120ms，且成功那次不再等待')
})

test('开包会话跳转：其它错误立即失败，不重试也不掩盖原因', async () => {
  let attempts = 0
  const result = await openSessionWhenReady(() => {
    attempts += 1
    throw new Error('宿主没有 uiWorkspace.openSession（旧宿主或裁剪 profile）')
  }, 'session-abc', { wait: async () => { throw new Error('不该等待') } })
  assert.equal(attempts, 1)
  assert.equal(result.ok, false)
  assert.match(result.reason, /openSession/)
})

test('开包会话跳转：重试用尽仍失败 → 带上宿主原文，供面板给「请从左侧列表打开」', async () => {
  const waits = []
  const result = await openSessionWhenReady(() => { throw unknownSession('session-xyz') }, 'session-xyz', {
    attempts: 3,
    wait: async ms => { waits.push(ms) },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /sessions\.retain: unknown session session-xyz/)
  assert.deepEqual(waits, [120, 240], '最后一次失败后不再等待')
})

test('开包会话跳转：宿主没有 openSession（旧宿主/裁剪 profile）时如实失败', async () => {
  const missingHost = await openSessionWhenReady(undefined, 'session-1', { wait: async () => {} })
  assert.equal(missingHost.ok, false)
  assert.match(missingHost.reason, /openSession/)
})
