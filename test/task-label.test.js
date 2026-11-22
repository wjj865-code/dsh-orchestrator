// 版本 B《ID 出口网关》：对外文案的显示名。
//
// 口径：**用户面只用任务名 + 任务引用（tk-xxxxxx）**；台账内部编号（t-xxxx）不再出现在回执/面板。
// 没有 ref 的行（旧库未回填 / 测试手搓）退回 4 位短后缀兜底，保证重名仍可区分。
import test from 'node:test'
import assert from 'node:assert/strict'
import { shortTaskId, taskLabel, taskLabelWithRef } from '../src/task-label.js'

const task = (id, title, ref) => ({ id, title, ref })

test('shortTaskId 取 t- 后 4 位（只在没有 ref 时兜底）', () => {
  assert.equal(shortTaskId('t-1a2b3c4d'), '1a2b')
  assert.equal(shortTaskId('abcd'), 'abcd')
  assert.equal(shortTaskId(undefined), '')
})

test('taskLabel：唯一标题原样，重名附**任务引用**（tk-）', () => {
  const a = task('t-aaaa1111', '修登录', 'tk-aaaa11')
  const b = task('t-bbbb2222', '改文案', 'tk-bbbb22')
  const all = [a, b]
  assert.equal(taskLabel(a, { all }), '修登录')
  const c = task('t-cccc3333', '修登录', 'tk-cccc33')
  assert.equal(taskLabel(a, { all: [a, c] }), '修登录（tk-aaaa11）')
  assert.equal(taskLabel(c, { all: [a, c] }), '修登录（tk-cccc33）')
  // 重名后缀**不再是** t-xxx 的 4 位：用户面零裸编号。
  assert.doesNotMatch(taskLabel(a, { all: [a, c] }), /（aaaa）/)
})

test('taskLabel：没有 ref 时退回 4 位短后缀（不出现 t- 前缀形态）；空集合不崩', () => {
  const a = task('t-aaaa1111', '修登录')
  const c = task('t-cccc3333', '修登录')
  assert.equal(taskLabel(a, { all: [a, c] }), '修登录（aaaa）')
  assert.equal(taskLabel(task('t-12345678', '')), '任务 1234')
  assert.equal(taskLabel(task('t-12345678', '   '), { all: [] }), '任务 1234')
  assert.equal(taskLabel({}), '任务')
})

test('taskLabelWithRef：标题（tk-xxxxxx），空标题也带引用', () => {
  assert.equal(taskLabelWithRef(task('t-1a2b3c4d', '修登录', 'tk-1a2b3c')), '修登录（tk-1a2b3c）')
  assert.equal(taskLabelWithRef(task('t-1a2b3c4d', '', 'tk-1a2b3c')), '任务（tk-1a2b3c）')
  assert.equal(taskLabelWithRef({}), '任务')
  // 关键断言：回执里的引用值里**永远没有** t-xxxx 形态。
  const text = taskLabelWithRef(task('t-1a2b3c4d', '修登录', 'tk-1a2b3c'))
  assert.doesNotMatch(text, /\bt-[0-9a-z]{4,}\b/)
})
