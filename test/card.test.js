import test from 'node:test'
import assert from 'node:assert/strict'
import { taskCard } from '../src/card.js'

const task = (overrides = {}) => ({ id: 't-1', title: '甲', status: 'running', ...overrides })

test('字段齐全：带子会话 id 与打开方式，pending 标排队', () => {
  const card = taskCard(task({ session_id: 'c-1' }), { summary: '在跑' })
  assert.deepEqual(card, {
    taskId: 't-1', title: '甲', status: 'running', label: '进行中', tone: 'info', summary: '在跑',
    childSessionId: 'c-1', queued: false, openVia: 'subagent-catalog',
  })
  const queued = taskCard(task({ status: 'pending' }))
  assert.equal(queued.childSessionId, null)
  assert.equal(queued.queued, true)
})

test('8 个状态的中文名与色值', () => {
  const expected = {
    pending: ['待派发', 'muted'],
    running: ['进行中', 'info'],
    waiting_user: ['等你确认', 'warn'],
    waiting_auth: ['要授权', 'warn'],
    done: ['已完成', 'good'],
    failed: ['失败', 'bad'],
    cancelled: ['已取消', 'muted'],
    orphaned: ['会话丢失', 'bad'],
  }
  for (const [status, [label, tone]] of Object.entries(expected)) {
    const card = taskCard(task({ status }))
    assert.equal(card.label, label, status)
    assert.equal(card.tone, tone, status)
  }
})

test('未知状态回落', () => {
  const card = taskCard(task({ status: 'weird' }))
  assert.equal(card.label, 'weird')
  assert.equal(card.tone, 'muted')
})

test('摘要截断到 80 字', () => {
  const eighty = '字'.repeat(80)
  const eightyOne = '字'.repeat(81)
  assert.equal(taskCard(task(), { summary: eighty }).summary, eighty)
  assert.equal(taskCard(task(), { summary: eightyOne }).summary, `${'字'.repeat(80)}…`)
  assert.equal(taskCard(task(), { summary: '' }).summary, '')
})

test('自定义截断长度', () => {
  assert.equal(taskCard(task(), { summary: '123456', maxLength: 5 }).summary, '12345…')
})

test('emoji 不在 80 边界被截成半个代理对', () => {
  const summary = `${'a'.repeat(79)}😀b`
  const text = taskCard(task(), { summary }).summary
  assert.equal(text, `${'a'.repeat(79)}😀…`)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false)
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), false)
})
