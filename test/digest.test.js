import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, getSetting, setSetting } from '../src/ledger.js'
import { ensureDigest, DIGEST_SCHEDULE_KEY, DIGEST_SPEC_KEY } from '../src/digest.js'
import { tempDir } from './helpers.js'

function fakeSchedule() {
  const entries = new Map()
  const calls = []
  let next = 0
  return {
    calls,
    get entries() { return entries },
    async create(request, actorSessionId) {
      next += 1
      const id = `sch-${next}`
      const entry = { id, status: 'active', target: request.target, timing: request.timing, title: request.title }
      entries.set(id, entry)
      calls.push(['create', request, actorSessionId])
      return entry
    },
    async view({ id }) {
      return entries.get(id) ?? { id, code: 'schedule_not_found' }
    },
    async edit({ id, action }) {
      calls.push(['edit', action, id])
      entries.delete(id)
      return { id, deleted: true }
    },
  }
}

test('digestAt 未配置：不创建，且清掉已有 schedule', async () => {
  const db = await openLedger(tempDir())
  const schedule = fakeSchedule()
  schedule.entries.set('old', { id: 'old', status: 'active', target: { kind: 'session', sessionId: 's-1' } })
  setSetting(db, DIGEST_SCHEDULE_KEY, 'old')
  setSetting(db, DIGEST_SPEC_KEY, 'old-spec')
  const first = await ensureDigest({ schedule, db, mainSessionId: 's-1', config: { digestAt: '' } })
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'disabled')
  assert.equal(schedule.calls.filter(call => call[0] === 'create').length, 0)
  assert.equal(getSetting(db, DIGEST_SCHEDULE_KEY), '')
  db.close()
})

test('配置 digestAt：创建一条 daily schedule，重复调用复用', async () => {
  const db = await openLedger(tempDir())
  const schedule = fakeSchedule()
  const config = { digestAt: '09:00', digestTimeZone: 'Asia/Shanghai' }
  const first = await ensureDigest({ schedule, db, mainSessionId: 's-1', config })
  assert.equal(first.ok, true)
  assert.equal(first.created, true)
  assert.equal(first.id, 'sch-1')
  const create = schedule.calls.find(call => call[0] === 'create')
  assert.equal(create[1].timing.kind, 'daily')
  assert.equal(create[1].timing.daily.time, '09:00')
  assert.equal(create[1].timing.daily.time_zone, 'Asia/Shanghai')
  assert.deepEqual(create[1].target, { kind: 'session', sessionId: 's-1' })
  assert.equal(create[2], 's-1')
  assert.equal(getSetting(db, DIGEST_SCHEDULE_KEY), 'sch-1')
  assert.match(getSetting(db, DIGEST_SPEC_KEY), /s-1\|09:00\|Asia\/Shanghai/)

  const second = await ensureDigest({ schedule, db, mainSessionId: 's-1', config })
  assert.equal(second.ok, true)
  assert.equal(second.created, false)
  assert.equal(second.id, 'sch-1')
  assert.equal(schedule.calls.filter(call => call[0] === 'create').length, 1)
  db.close()
})

test('主会话变化：删除旧 schedule，为目标重建', async () => {
  const db = await openLedger(tempDir())
  const schedule = fakeSchedule()
  const config = { digestAt: '09:00', digestTimeZone: 'Asia/Shanghai' }
  await ensureDigest({ schedule, db, mainSessionId: 's-1', config })
  const next = await ensureDigest({ schedule, db, mainSessionId: 's-2', config })
  assert.equal(next.ok, true)
  assert.equal(next.created, true)
  assert.equal(next.id, 'sch-2')
  assert.equal(schedule.calls.some(call => call[0] === 'edit' && call[1] === 'delete'), true)
  assert.equal(getSetting(db, DIGEST_SPEC_KEY).startsWith('s-2|'), true)
  db.close()
})

test('缺 schedule 服务时返回 no-schedule-service，不写 settings', async () => {
  const db = await openLedger(tempDir())
  const result = await ensureDigest({ schedule: undefined, db, mainSessionId: 's-1', config: { digestAt: '09:00' } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-schedule-service')
  assert.equal(getSetting(db, DIGEST_SCHEDULE_KEY), undefined)
  db.close()
})
