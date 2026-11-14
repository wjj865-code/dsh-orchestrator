import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openLedger, createTask } from '../src/ledger.js'
import { takeDailySnapshot } from '../src/snapshot.js'
import { tempDir, sampleBrief } from './helpers.js'

test('takeDailySnapshot：生成当天快照，快照可打开且含任务', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  const task = createTask(db, { brief: sampleBrief({ title: '快照任务' }), coordinatorSession: 's-1' })
  const now = new Date(2026, 10, 14, 12).getTime()
  const result = takeDailySnapshot(db, dir, { now })
  assert.equal(result.created, true)
  assert.equal(result.path, join(dir, 'snapshots', 'tasks-2026-11-14.sqlite'))
  assert.equal(existsSync(result.path), true)
  const snap = new DatabaseSync(result.path)
  const row = snap.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id)
  snap.close()
  assert.equal(row.title, '快照任务')
  // 同一天重复调用不重写、不报错。
  const again = takeDailySnapshot(db, dir, { now: now + 60_000 })
  assert.equal(again.created, false)
  assert.equal(again.path, result.path)
  db.close()
})

test('takeDailySnapshot：按保留天数清理旧快照，不认识的文件不动', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  const snapshots = join(dir, 'snapshots')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(snapshots, { recursive: true })
  const old = join(snapshots, 'tasks-2020-01-01.sqlite')
  const keep = join(snapshots, 'README.txt')
  writeFileSync(old, 'old', 'utf8')
  writeFileSync(keep, 'keep', 'utf8')
  const oldTime = new Date(2020, 0, 1).getTime() / 1000
  utimesSync(old, oldTime, oldTime)
  const now = new Date(2026, 10, 14, 12).getTime()
  const result = takeDailySnapshot(db, dir, { now, retentionDays: 7 })
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(keep), true)
  assert.equal(result.pruned.includes('tasks-2020-01-01.sqlite'), true)
  assert.deepEqual(readdirSync(snapshots).sort(), ['README.txt', 'tasks-2026-11-14.sqlite'])
  db.close()
})

test('takeDailySnapshot：台账目录不存在时自建，不崩', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  const result = takeDailySnapshot(db, dir, { now: new Date(2026, 10, 14, 12).getTime() })
  assert.equal(existsSync(result.path), true)
  db.close()
})
