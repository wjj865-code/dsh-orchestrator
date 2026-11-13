import test from 'node:test'
import assert from 'node:assert/strict'
import { injectNotification } from '../src/inject.js'

test('注入 user 消息并唤醒协调者 agent', () => {
  const steered = []
  const agent = { id: 's-1', steer(message) { steered.push(message) } }
  const message = injectNotification(agent, { text: '任务「甲」完成：好', senderId: 'm-1' })
  assert.equal(steered.length, 1)
  assert.equal(steered[0], message)
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(message.content, [{ type: 'text', text: '任务「甲」完成：好' }])
  assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'm-1' })
})

test('没有 sender 时仍可注入，source 标记为 orchestrator-notification', () => {
  const steered = []
  const agent = { id: 's-1', steer(message) { steered.push(message) } }
  const message = injectNotification(agent, { text: '通知' })
  assert.deepEqual(message.source, { kind: 'orchestrator-notification' })
})

test('协调者不可注入时给可读错误', () => {
  assert.throws(() => injectNotification({ id: 's-1' }, { text: 'x' }), /协调者会话不可用/)
  assert.throws(() => injectNotification(undefined, { text: 'x' }), /协调者会话不可用/)
})
