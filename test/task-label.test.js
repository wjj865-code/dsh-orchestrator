import test from 'node:test'
import assert from 'node:assert/strict'
import { shortTaskId, taskLabel, taskLabelWithId } from '../src/task-label.js'

const task = (id, title) => ({ id, title })

test('shortTaskId 取 t- 后 4 位', () => {
  assert.equal(shortTaskId('t-1a2b3c4d'), '1a2b')
  assert.equal(shortTaskId('abcd'), 'abcd')
  assert.equal(shortTaskId(undefined), '')
})

test('taskLabel：唯一标题原样，重名才附短 id', () => {
  const a = task('t-aaaa1111', '修登录')
  const b = task('t-bbbb2222', '改文案')
  const all = [a, b]
  assert.equal(taskLabel(a, { all }), '修登录')
  const c = task('t-cccc3333', '修登录')
  assert.equal(taskLabel(a, { all: [a, c] }), '修登录（aaaa）')
  assert.equal(taskLabel(c, { all: [a, c] }), '修登录（cccc）')
})

test('taskLabel：空标题回落「任务 <id>」；空集合不崩', () => {
  assert.equal(taskLabel(task('t-12345678', '')), '任务 t-12345678')
  assert.equal(taskLabel(task('t-12345678', '   '), { all: [] }), '任务 t-12345678')
  assert.equal(taskLabel({}), '任务')
})

test('taskLabelWithId：标题（t-xxxx），空标题也带 id', () => {
  assert.equal(taskLabelWithId(task('t-1a2b3c4d', '修登录')), '修登录（t-1a2b3c4d）')
  assert.equal(taskLabelWithId(task('t-1a2b3c4d', '')), '任务（t-1a2b3c4d）')
  assert.equal(taskLabelWithId({}), '任务')
})
