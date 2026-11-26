import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_COORDINATORS,
  addCoordinatorId,
  coordinatorIdOf,
  isCoordinatorId,
  normalizeCoordinatorIds,
  parseCoordinatorIds,
  primaryCoordinatorOf,
  removeCoordinatorId,
  serializeCoordinatorIds,
} from '../src/coordinator-set.js'

test('coordinatorIdOf：只认非空字符串，去首尾空白，其余一律 undefined', () => {
  assert.equal(coordinatorIdOf('s-1'), 's-1')
  assert.equal(coordinatorIdOf('  s-1  '), 's-1')
  assert.equal(coordinatorIdOf('   '), undefined)
  assert.equal(coordinatorIdOf(''), undefined)
  assert.equal(coordinatorIdOf(42), undefined)
  assert.equal(coordinatorIdOf({ id: 's-1' }), undefined)
  assert.equal(coordinatorIdOf(null), undefined)
})

test('normalizeCoordinatorIds：去非法项、保序去重、截断到上限', () => {
  assert.deepEqual(normalizeCoordinatorIds(['s-1', 's-2']), ['s-1', 's-2'])
  assert.deepEqual(normalizeCoordinatorIds([' s-1 ', '', 3, null, 's-1']), ['s-1'])
  assert.deepEqual(normalizeCoordinatorIds('not-an-array'), [])
  assert.deepEqual(normalizeCoordinatorIds(undefined), [])
  const many = ['a', 'b', 'c', 'd', 'e', 'f']
  assert.deepEqual(normalizeCoordinatorIds(many), ['a', 'b', 'c', 'd'])
  assert.equal(normalizeCoordinatorIds(many).length, MAX_COORDINATORS)
})

test('parseCoordinatorIds：坏 JSON / 空串 / 非数组一律回落空名单（读路径不抛错）', () => {
  assert.deepEqual(parseCoordinatorIds('["s-1","s-2"]'), ['s-1', 's-2'])
  assert.deepEqual(parseCoordinatorIds(['s-1']), ['s-1'])
  assert.deepEqual(parseCoordinatorIds(''), [])
  assert.deepEqual(parseCoordinatorIds('   '), [])
  assert.deepEqual(parseCoordinatorIds('{bad json'), [])
  assert.deepEqual(parseCoordinatorIds('{"a":1}'), [])
  assert.deepEqual(parseCoordinatorIds(null), [])
  assert.deepEqual(parseCoordinatorIds('["s-1","s-1",7]'), ['s-1'])
})

test('serializeCoordinatorIds：非空写 JSON 数组，空名单写空串', () => {
  assert.equal(serializeCoordinatorIds(['s-1', 's-2']), '["s-1","s-2"]')
  assert.equal(serializeCoordinatorIds([' s-1 ', 's-1']), '["s-1"]')
  assert.equal(serializeCoordinatorIds([]), '')
  assert.equal(serializeCoordinatorIds(undefined), '')
  assert.deepEqual(parseCoordinatorIds(serializeCoordinatorIds(['s-9'])), ['s-9'])
})

test('primaryCoordinatorOf / isCoordinatorId：首位即主，成员逐字比较', () => {
  assert.equal(primaryCoordinatorOf(['s-1', 's-2']), 's-1')
  assert.equal(primaryCoordinatorOf([]), undefined)
  assert.equal(primaryCoordinatorOf(undefined), undefined)
  assert.equal(isCoordinatorId(['s-1', 's-2'], 's-2'), true)
  assert.equal(isCoordinatorId(['s-1'], 's-3'), false)
  assert.equal(isCoordinatorId(['s-1'], 'S-1'), false, '不做大小写归一')
  assert.equal(isCoordinatorId(['s-1'], ' s-1'), true, '只 trim，不改变 id 本体')
  assert.equal(isCoordinatorId(undefined, 's-1'), false)
})

test('addCoordinatorId：新人前插为主，老成员只提升，主协调者重设是 unchanged', () => {
  const empty = addCoordinatorId([], 's-1')
  assert.deepEqual(empty.ids, ['s-1'])
  assert.equal(empty.added, true)

  const second = addCoordinatorId(['s-1'], 's-2')
  assert.deepEqual(second.ids, ['s-2', 's-1'], '新成员成为主协调者（前插）')
  assert.equal(second.added, true)

  const promote = addCoordinatorId(['s-2', 's-1'], 's-1')
  assert.deepEqual(promote.ids, ['s-1', 's-2'])
  assert.equal(promote.added, false)
  assert.equal(promote.promoted, true)

  const unchanged = addCoordinatorId(['s-1', 's-2'], 's-1')
  assert.deepEqual(unchanged.ids, ['s-1', 's-2'])
  assert.equal(unchanged.unchanged, true)

  const invalid = addCoordinatorId(['s-1'], '  ')
  assert.deepEqual(invalid.ids, ['s-1'])
  assert.equal(invalid.added, false)
})

test('addCoordinatorId：名单已满且不是成员 → limitReached，名单原样不动', () => {
  const full = ['a', 'b', 'c', 'd']
  const outcome = addCoordinatorId(full, 'e')
  assert.equal(outcome.limitReached, true)
  assert.deepEqual(outcome.ids, full)
  assert.equal(outcome.added, false)
  // 已满时提升已有成员仍然允许（不是新增，不占名额）
  const promote = addCoordinatorId(full, 'd')
  assert.deepEqual(promote.ids, ['d', 'a', 'b', 'c'])
  assert.equal(promote.limitReached, false)
})

test('removeCoordinatorId：删次位不动主，删首位下一位升主，删不存在是 no-op', () => {
  const secondary = removeCoordinatorId(['s-1', 's-2'], 's-2')
  assert.deepEqual(secondary.ids, ['s-1'])
  assert.equal(secondary.dropped, true)
  assert.equal(secondary.primaryChanged, false)

  const primary = removeCoordinatorId(['s-1', 's-2', 's-3'], 's-1')
  assert.deepEqual(primary.ids, ['s-2', 's-3'])
  assert.equal(primary.primaryChanged, true)

  const missing = removeCoordinatorId(['s-1'], 's-9')
  assert.deepEqual(missing.ids, ['s-1'])
  assert.equal(missing.dropped, false)

  const last = removeCoordinatorId(['s-1'], 's-1')
  assert.deepEqual(last.ids, [])
  assert.equal(last.dropped, true)
  assert.equal(last.primaryChanged, true)
})
