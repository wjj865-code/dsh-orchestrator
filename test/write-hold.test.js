// 写域瞬时占位（write-hold）规格测试：owner token 引用计数、TTL 剔除、touch、仅重叠才合并、
// 并列视图（跨盘符/不重叠）、台账行合并（空字段回退）。
//
// 为什么单独一个文件：这些是「两个子会话同时写同一份工作树」事故的直接防线，
// 以前只有 write-guard 的纯判定被覆盖，占位层（引用计数/过期/合并）完全没有测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetHolds, acquireWriteHold, activeWriteHolds, heldTaskView, isWriteHeld, releaseWriteHold,
  touchWriteHold, writeHoldCount, writeHoldOwners,
} from '../src/write-hold.js'
import { tasksWithHolds } from '../src/write-guard.js'

const reset = () => __resetHolds()

test('write-hold：owner token 引用计数——先 release 一侧另一侧仍占，最后一个 release 才清任务', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:c1', targetDir: 'C:/ws', writeScopes: ['src'], now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:r1', targetDir: 'C:/ws', writeScopes: ['src'], now: 1000 })
  assert.equal(writeHoldCount(), 1)
  assert.equal(writeHoldOwners('t-1', 1000).length, 2)
  assert.equal(isWriteHeld('t-1', 1000), true)
  const [view] = activeWriteHolds(1000)
  assert.equal(view.ownerCount, 2)
  assert.deepEqual([...view.ownerTokens].sort(), ['panel:r1', 'tool:c1'])

  assert.equal(releaseWriteHold('t-1', 'tool:c1'), true)
  assert.equal(isWriteHeld('t-1', 1000), true, '另一侧还在投递，不能被一次 finally 放掉')
  const [rest] = activeWriteHolds(1000)
  assert.equal(rest.ownerCount, 1)
  assert.deepEqual(rest.ownerTokens, ['panel:r1'])

  // 释放别人的 token（或已释放的）不改别人占位。
  assert.equal(releaseWriteHold('t-1', 'tool:c1'), false)
  assert.equal(isWriteHeld('t-1', 1000), true)
  assert.equal(releaseWriteHold('t-1', 'panel:r1'), true)
  assert.equal(isWriteHeld('t-1', 1000), false)
  assert.equal(writeHoldCount(), 0)
})

test('write-hold：无 token 的强制释放清空整条任务（仅 stop/close/终态允许，见 write-gate 静态断言）', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:c1', targetDir: 'C:/ws', now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:r1', targetDir: 'C:/ws', now: 1000 })
  assert.equal(releaseWriteHold('t-1'), true)
  assert.equal(writeHoldCount(), 0)
  assert.equal(isWriteHeld('t-1', 1000), false)
})

test('write-hold：过期 owner 剔除——只剩过期者的任务直接删除；活着的不受影响', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:old', targetDir: 'C:/ws', ttlMs: 100, now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:live', targetDir: 'C:/ws', ttlMs: 1000, now: 1000 })
  // 过期 token 不得继续占路径：合并视图只含未过期者。
  const [view] = activeWriteHolds(1101)
  assert.equal(view.ownerCount, 1)
  assert.deepEqual(view.ownerTokens, ['panel:live'])
  assert.equal(view.expiresAt, 2000, 'expiresAt = 未过期 owner 的 max')
  assert.equal(writeHoldOwners('t-1', 1101).length, 1)

  // 全过期 → hold 删除（不是留着空壳）。
  assert.deepEqual(activeWriteHolds(2001), [])
  assert.equal(writeHoldCount(), 0)
})

test('write-hold：touch 只续自己 token 的 TTL，不延长别人', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/ws', ttlMs: 100, now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:b', targetDir: 'C:/ws', ttlMs: 100, now: 1000 })
  assert.equal(touchWriteHold('t-1', 'tool:a', 5000, 1050), true)
  const owners = writeHoldOwners('t-1', 1050)
  assert.equal(owners.find(owner => owner.token === 'tool:a').expiresAt, 6050)
  assert.equal(owners.find(owner => owner.token === 'tool:b').expiresAt, 1100)
  // 119s → touch → 再 2s 仍占（G12 口径：长投递靠心跳续期，不是一次 acquire 定生死）。
  assert.equal(touchWriteHold('t-1', 'tool:a', 120_000, 121_000), true)
  assert.equal(isWriteHeld('t-1', 123_000), true)
  assert.equal(touchWriteHold('t-1', 'missing', 1000, 123_000), false)
})

test('write-hold：仅重叠才合并——C:\\a\\b + C:\\a\\c 是两个并列视图，不合成 C:\\a', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/a/b', now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:b', targetDir: 'C:/a/c', now: 1000 })
  const views = activeWriteHolds(1000)
  assert.equal(views.length, 2, '不重叠 → 并列视图')
  assert.deepEqual(views.map(view => view.targetDir).sort(), ['C:/a/b', 'C:/a/c'])
  // 组成宽视图会误拦 C:/a/d；这里每个视图只覆盖自己那条路径。
  for (const view of views) {
    assert.equal(['C:/a/b', 'C:/a/c'].includes(view.targetDir), true)
    assert.equal(view.ownerCount, 1)
  }
})

test('write-hold：嵌套路径合并到更宽的那个（C:\\a\\b + C:\\a\\b\\c → 一个 C:\\a\\b 视图）', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/a/b', now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:b', targetDir: 'C:/a/b/c', now: 1000 })
  const views = activeWriteHolds(1000)
  assert.equal(views.length, 1)
  assert.equal(views[0].targetDir, 'C:/a/b')
  assert.equal(views[0].ownerCount, 2)
})

test('write-hold：检出相同会进同一组件，但 target 无共同祖先时拆子视图（不误拦更宽路径）', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/a/b', checkoutPath: 'C:/wt/x', now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:b', targetDir: 'C:/a/c', checkoutPath: 'C:/wt/x', now: 1000 })
  const views = activeWriteHolds(1000)
  // 共同祖先不存在（C:/a/b 与 C:/a/c 互不包含）→ 拆成两条子视图，各自仍占着自己的 target + 同一检出。
  assert.equal(views.length, 2)
  assert.equal(new Set(views.flatMap(view => view.ownerTokens)).size, 2)
  assert.deepEqual(views.map(view => view.targetDir).sort(), ['C:/a/b', 'C:/a/c'])
  for (const view of views) assert.equal(view.checkoutPath, 'C:/wt/x')
})

test('write-hold：跨盘符天然并列视图（不使用共同祖先）', t => {
  if (process.platform !== 'win32') {
    t.skip('跨盘符只有 Windows 有意义（其它平台无盘符）')
    return
  }
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/a/b', now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:b', targetDir: 'D:/a/b', now: 1000 })
  const views = activeWriteHolds(1000)
  assert.equal(views.length, 2)
  assert.deepEqual(views.map(view => view.targetDir).sort(), ['C:/a/b', 'D:/a/b'])
})

test('write-hold：writeScopes 并集去重；空路径不参与合并', () => {
  reset()
  acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/a', writeScopes: ['src', 'docs/'], now: 1000 })
  acquireWriteHold({ taskId: 't-1', ownerToken: 'panel:b', targetDir: 'C:/a', writeScopes: ['src', 'test'], now: 1000 })
  const [view] = activeWriteHolds(1000)
  assert.deepEqual(view.writeScopes, ['src', 'docs', 'test'])
})

test('write-hold：tasksWithHolds 合并台账行（空字段回退）、多视图、未知 id 用虚拟行', () => {
  reset()
  const ledger = [
    { id: 't-1', status: 'delivered', read_only: false, target_dir: 'C:/ledger', write_scopes: ['ledger-scope'], worktree_path: '' },
    { id: 't-2', status: 'running', read_only: false, target_dir: 'C:/other', write_scopes: [], worktree_path: '' },
  ]
  const holds = [
    // 空字段必须回退台账行（否则 target_dir:'' 会把继承目标清掉，F11/G5）。
    { taskId: 't-1', targetDir: '', writeScopes: [], checkoutPath: '' },
    { taskId: 't-3', targetDir: 'C:/held', writeScopes: [], checkoutPath: 'C:/wt/3' },
    { taskId: 't-1', targetDir: 'C:/held-2', writeScopes: ['h2'], checkoutPath: '' },
  ]
  const merged = tasksWithHolds(ledger, holds)
  const t1 = merged.filter(task => task.id === 't-1')
  assert.equal(t1.length, 2, '同一 task 的两条视图各一行，台账原行不重复保留')
  assert.equal(t1.some(task => task.target_dir === 'C:/ledger' && task.write_scopes[0] === 'ledger-scope'), true)
  assert.equal(t1.some(task => task.target_dir === 'C:/held-2' && task.write_scopes[0] === 'h2'), true)
  for (const row of t1) {
    assert.equal(row.status, 'running', 'hold = 正在写')
    assert.equal(row.read_only, false)
  }
  const t2 = merged.filter(task => task.id === 't-2')
  assert.equal(t2.length, 1, '没有 hold 的台账行原样保留')
  const t3 = merged.filter(task => task.id === 't-3')
  assert.equal(t3.length, 1)
  assert.deepEqual(t3[0], heldTaskView({ taskId: 't-3', targetDir: 'C:/held', writeScopes: [], checkoutPath: 'C:/wt/3' }))
})

test('write-hold：heldTaskView 是判定用的虚拟任务行（running/可写/目标与检出）', () => {
  const view = heldTaskView({ taskId: 't-9', targetDir: 'C:/x', writeScopes: ['s'], checkoutPath: 'C:/wt' })
  assert.deepEqual(view, {
    id: 't-9', target_dir: 'C:/x', write_scopes: ['s'], worktree_path: 'C:/wt', status: 'running', read_only: false,
  })
})

test('write-hold：taskId 非法/空目标仍可占位（不抛），重复 acquire 刷新同 token', () => {
  reset()
  assert.equal(acquireWriteHold({ taskId: '', ownerToken: 'tool:a' }), undefined)
  const first = acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/a', ttlMs: 100, now: 1000 })
  const second = acquireWriteHold({ taskId: 't-1', ownerToken: 'tool:a', targetDir: 'C:/b', ttlMs: 100, now: 1050 })
  assert.equal(first.expiresAt, 1100)
  assert.equal(second.expiresAt, 1150, '同 token 重复 acquire：expiresAt = max(now+ttl, 现有)')
  const owners = writeHoldOwners('t-1', 1050)
  assert.equal(owners.length, 1, '同 token 不产生第二条 owner')
  assert.equal(owners[0].targetDir, 'C:/b', '字段更新到最新')
})
