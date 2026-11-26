import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openLedger, createTask, transition, getTask, setTaskPlannedAt, listGroupMeta, getGroupMeta,
  backfillGroups, setSetting, deleteSetting, GROUPS_BACKFILLED_KEY, listAutomations, addMessage,
} from '../src/ledger.js'
import {
  createWorkbench, groupRollups, calendarWindow, normalizeTiming, timingText, dayKeyOf, localZone,
  nextPlanned, defaultPrompt, WORKBENCH_LIMITS, reviewStats, failureReasonOf, artifactKindOf,
} from '../src/workbench.js'
import { planSetGate, groupSaveGate, groupArchiveGate, automationGate } from '../src/panel-gates.js'
import { tempDir, sampleBrief } from './helpers.js'

const HOUR = 60 * 60 * 1000

const makeTask = (db, { group = null, title = 't', status = 'pending' } = {}) => {
  const task = createTask(db, {
    brief: sampleBrief({ title }),
    coordinatorSession: 's-1',
    groupId: group,
    status: 'pending',
  })
  if (status === 'running') transition(db, task.id, 'running', { sessionId: `c-${task.id}`, target: `c-${task.id}` })
  if (status === 'delivered') {
    transition(db, task.id, 'running', { sessionId: `c-${task.id}`, target: `c-${task.id}` })
    transition(db, task.id, 'delivered')
  }
  if (status === 'done') {
    transition(db, task.id, 'running', { sessionId: `c-${task.id}`, target: `c-${task.id}` })
    transition(db, task.id, 'delivered')
    transition(db, task.id, 'done')
  }
  return getTask(db, task.id)
}

/** 假宿主 schedule 服务：形状对齐 @deepseek-ai/dsh-schedule（create/view/edit + record.scheduledAt）。 */
const fakeSchedule = ({ now = Date.now } = {}) => {
  const calls = []
  const rows = new Map()
  let seq = 0
  return {
    calls,
    rows,
    async create(request) {
      calls.push({ op: 'create', request })
      const id = `schedule-${++seq}`
      const row = {
        id,
        ...request,
        status: 'active',
        scheduledAt: new Date(now() + HOUR).toISOString(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: `u${seq}`,
      }
      rows.set(id, row)
      return row
    },
    async view({ id }) {
      const row = rows.get(id)
      return row === undefined ? { id, code: 'schedule_not_found' } : row
    },
    async edit(request) {
      calls.push({ op: 'edit', request })
      const row = rows.get(request.id)
      if (row === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (typeof request.expectedUpdatedAt === 'string' && request.expectedUpdatedAt !== '' && request.expectedUpdatedAt !== row.updatedAt) {
        return { id: request.id, code: 'schedule_conflict' }
      }
      if (request.action === 'delete') {
        rows.delete(request.id)
        return { id: request.id, deleted: true }
      }
      const next = { ...row, ...request.patch, updatedAt: `${row.updatedAt}+` }
      rows.set(request.id, next)
      return next
    },
  }
}

test('normalizeTiming：只放行 daily / weekly / cron / rrule，形状对齐宿主 ScheduleTiming', () => {
  const zone = localZone()
  assert.deepEqual(normalizeTiming({ kind: 'daily', time: '9:5' }), {
    ok: true,
    timing: { kind: 'daily', daily: { time: '09:05:00.000', time_zone: zone } },
  })
  assert.deepEqual(normalizeTiming({ kind: 'weekly', time: '08:00', weekdays: [5, 1, 1] }), {
    ok: true,
    timing: { kind: 'weekly', weekly: { time: '08:00:00.000', time_zone: zone, weekdays: [1, 5] } },
  })
  assert.deepEqual(normalizeTiming({ kind: 'cron', expression: '0  9 * * 1-5', time_zone: 'Asia/Shanghai' }), {
    ok: true,
    timing: { kind: 'cron', cron: { expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' } },
  })
  assert.deepEqual(normalizeTiming({ kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9' }), {
    ok: true,
    timing: { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9' },
  })
  // 拒绝：时间非法 / 每周没选天 / cron 不是 5 段 / rrule 不以 FREQ= 开头 / 未知 kind。
  assert.equal(normalizeTiming({ kind: 'daily', time: '24:00' }).ok, false)
  assert.equal(normalizeTiming({ kind: 'weekly', time: '08:00', weekdays: [] }).ok, false)
  assert.equal(normalizeTiming({ kind: 'cron', expression: '0 9 * *' }).ok, false)
  assert.equal(normalizeTiming({ kind: 'rrule', rrule: 'every day' }).ok, false)
  assert.equal(normalizeTiming({ kind: 'every', every_seconds: 60 }).ok, false)
})

test('timingText：人类可读（面板与工具同一口径）', () => {
  assert.equal(timingText({ kind: 'daily', daily: { time: '09:00:00.000' } }), '每天 09:00')
  assert.equal(timingText({ kind: 'weekly', weekly: { time: '08:30:00.000', weekdays: [1, 3] } }), '每周一、周三 08:30')
  assert.equal(timingText({ kind: 'cron', cron: { expression: '0 9 * * 1-5' } }), 'cron 0 9 * * 1-5')
  assert.equal(timingText({ kind: 'rrule', rrule: 'FREQ=DAILY' }), 'rrule FREQ=DAILY')
  assert.equal(timingText(null), '（未知节奏）')
})

test('groupRollups：组卡统计（活跃/待确认/完成/失败、产物数、下次排期、自动化数）', () => {
  const now = Date.parse('2026-11-21T10:00:00+08:00')
  const tasks = [
    { id: 't-1', group_id: 'gzh', status: 'running', artifacts: [{ path: 'a.md' }, { path: 'b.md' }], last_event_at: now - HOUR, planned_at: now + HOUR },
    { id: 't-2', group_id: 'gzh', status: 'delivered', artifacts: [], last_event_at: now, planned_at: null },
    { id: 't-3', group_id: 'gzh', status: 'done', artifacts: [], last_event_at: now - 2 * HOUR, planned_at: null },
    { id: 't-4', group_id: 'gzh', status: 'failed', artifacts: [], last_event_at: now - 3 * HOUR, planned_at: null },
    { id: 't-5', group_id: 'gzh', status: 'pending', artifacts: [], last_event_at: now - 4 * HOUR, planned_at: now + 2 * HOUR },
    { id: 't-6', group_id: null, status: 'running', artifacts: [], last_event_at: now, planned_at: null },
  ]
  const counts = new Map([
    ['gzh', { total: 5, running: 1, delivered: 1, done: 1, failed: 1, pending: 1 }],
  ])
  const rows = groupRollups({
    keys: ['gzh'],
    meta: [{ id: 'gzh', name: '公众号文章组', goal: '每周三篇', color: 'blue', archived: false, updated_at: 1 }],
    counts,
    tasks,
    automations: [
      { id: 'a-1', kind: 'group', ref_id: 'gzh', active: true, deleted_at: null },
      { id: 'a-2', kind: 'group', ref_id: 'gzh', active: false, deleted_at: null },
      { id: 'a-3', kind: 'global', ref_id: null, active: true, deleted_at: null },
      { id: 'a-4', kind: 'group', ref_id: 'gzh', active: true, deleted_at: 1 },
    ],
    now,
  })
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.id, 'gzh')
  assert.equal(row.name, '公众号文章组')
  assert.equal(row.virtual, false)
  assert.deepEqual(row.counts, { total: 5, active: 2, delivered: 1, done: 1, failed: 1 })
  assert.equal(row.artifactCount, 2)
  assert.equal(row.lastEventAt, now)
  assert.equal(row.nextPlannedAt, now + HOUR, '取最近的一条未来排期')
  assert.equal(row.automationCount, 2, '已删除的镜像不算')
  assert.equal(row.automationActiveCount, 1)
  assert.equal(row.canRename, true)
  // 没有元数据行的组是「虚拟组」：名字回落到 id，允许第一次改名（会补元数据）。
  const virtual = groupRollups({ keys: ['tmp'], meta: [], counts: new Map(), tasks: [], automations: [], now })[0]
  assert.equal(virtual.virtual, true)
  assert.equal(virtual.name, 'tmp')
  assert.equal(virtual.canRename, true)
  // 归档组排到最后，且不能改名（归档先取消归档再改）。
  const sorted = groupRollups({
    keys: ['a', 'b'],
    meta: [
      { id: 'a', name: 'A', archived: true, updated_at: 1 },
      { id: 'b', name: 'B', archived: false, updated_at: 1 },
    ],
    counts: new Map(),
    tasks: [],
    automations: [],
    now,
  })
  assert.deepEqual(sorted.map(item => item.id), ['b', 'a'])
  assert.equal(sorted[1].canRename, false)
})

test('calendarWindow：按本地日聚合并排序（任务 + 自动化触发点）', () => {
  const now = Date.parse('2026-11-21T10:00:00+08:00')
  const day1 = new Date(2026, 10, 22, 9, 0, 0).getTime()
  const day1Later = new Date(2026, 10, 22, 20, 0, 0).getTime()
  const day2 = new Date(2026, 10, 23, 8, 0, 0).getTime()
  const window = calendarWindow({
    tasks: [
      { id: 't-1', title: '早', status: 'pending', group_id: 'g', planned_at: day1Later, artifacts: [] },
      { id: 't-2', title: '更早', status: 'running', group_id: 'g', planned_at: day1, artifacts: [{ path: 'x' }] },
      { id: 't-3', title: '窗口外', status: 'pending', group_id: 'g', planned_at: now + 40 * 24 * HOUR, artifacts: [] },
      { id: 't-4', title: '没排期', status: 'pending', group_id: 'g', planned_at: null, artifacts: [] },
    ],
    automations: [
      { id: 'a-1', title: '每天派单', kind: 'group', ref_id: 'g', timing: { kind: 'daily', daily: { time: '09:00:00.000' } }, nextFireAt: day2, active: true },
      { id: 'a-2', title: '没下次', kind: 'group', ref_id: 'g', timing: null, nextFireAt: null, active: true },
    ],
    from: new Date(2026, 10, 21).getTime(),
    to: new Date(2026, 10, 23, 23, 59, 59).getTime(),
  })
  assert.equal(window.days.length, 2)
  assert.equal(window.days[0].date, dayKeyOf(day1))
  assert.deepEqual(window.days[0].tasks.map(task => task.id), ['t-2', 't-1'])
  assert.equal(window.days[1].date, dayKeyOf(day2))
  assert.deepEqual(window.days[1].automations.map(row => row.id), ['a-1'])
  assert.equal(window.days[1].automations[0].timingText, '每天 09:00')
})

test('nextPlanned / defaultPrompt：排期取最近未来一条，话术只描述意图', () => {
  const now = 1000
  assert.equal(nextPlanned([], now), null)
  assert.equal(nextPlanned([{ id: 'a', planned_at: null }], now), null)
  const next = nextPlanned([{ id: 'a', planned_at: 5000 }, { id: 'b', planned_at: 3000 }, { id: 'c', planned_at: 500 }], now)
  assert.equal(next.id, 'b')
  const prompt = defaultPrompt({ kind: 'group', refId: '公众号文章组' })
  assert.match(prompt, /task_list\(\{ group: '公众号文章组' \}\)/)
  assert.match(prompt, /不要重复派|已存在或已完成的不重复派/)
  assert.match(defaultPrompt({ kind: 'global', what: '整理收件箱' }), /整理收件箱/)
})

test('backfillGroups：存量 group_id 落元数据行；幂等且不覆盖改过的名字', async () => {
  const db = await openLedger(tempDir())
  const task = makeTask(db, { group: 'gzh' })
  assert.equal(getGroupMeta(db, 'gzh'), undefined, 'backfill 只在启动时跑一次，新建的组按虚拟组处理')
  // 模拟升级后第一次启动：清掉标记再跑一次。
  deleteSetting(db, GROUPS_BACKFILLED_KEY)
  const first = backfillGroups(db)
  assert.equal(first.created, 1)
  assert.equal(getGroupMeta(db, 'gzh').name, 'gzh')
  const second = backfillGroups(db)
  assert.equal(second.created, 0, '有标记就不再补')
  // 改过的名字不会被 insert or ignore 覆盖。
  db.prepare("UPDATE groups_v1 SET name = '公众号文章组' WHERE id = 'gzh'").run()
  deleteSetting(db, GROUPS_BACKFILLED_KEY)
  backfillGroups(db)
  assert.equal(getGroupMeta(db, 'gzh').name, '公众号文章组')
  assert.equal(listGroupMeta(db).length, 1)
  assert.ok(task.id.startsWith('t-'))
  db.close()
})

test('createWorkbench.groups：并集组键 + 未分组计数（不需要组表先有行）', async () => {
  const db = await openLedger(tempDir())
  makeTask(db, { group: 'gzh', title: '甲', status: 'running' })
  makeTask(db, { group: 'gzh', title: '乙', status: 'delivered' })
  makeTask(db, { group: null, title: '散活', status: 'running' })
  const bench = createWorkbench({ db, mainSessionId: () => 's-1' })
  const body = bench.groups()
  assert.equal(body.ok, true)
  assert.equal(body.groups.length, 1)
  assert.equal(body.groups[0].id, 'gzh')
  assert.equal(body.groups[0].virtual, true)
  assert.deepEqual(body.groups[0].counts, { total: 2, active: 1, delivered: 1, done: 0, failed: 0 })
  assert.deepEqual(body.ungrouped, { total: 1, active: 1, delivered: 0, failed: 0 })
  // 单组详情：任务精简行 + 产物 + 计划统计。
  const detail = bench.group('gzh')
  assert.equal(detail.ok, true)
  assert.equal(detail.tasks.length, 2)
  assert.equal(detail.tasks[0].canPlan, true)
  assert.equal(detail.group.id, 'gzh')
  assert.equal(bench.group('nope').code, 'GROUP_NOT_FOUND')
  db.close()
})

test('createWorkbench.saveGroup / archiveGroup：改名只改 name、组键不变、归档后不能改', async () => {
  const db = await openLedger(tempDir())
  const task = makeTask(db, { group: 'gzh' })
  const bench = createWorkbench({ db, mainSessionId: () => 's-1' })
  const saved = await bench.saveGroup({ id: 'gzh', name: '  公众号文章组  ', goal: '每周三篇' })
  assert.equal(saved.ok, true)
  assert.equal(saved.group.name, '公众号文章组')
  assert.equal(saved.group.id, 'gzh')
  assert.equal(getTask(db, task.id).group_id, 'gzh', '组键不可变（worktree 复用与 task_list 依赖它）')
  // 重名拒绝（大小写/空白归一）。
  makeTask(db, { group: 'other' })
  await bench.saveGroup({ id: 'other', name: '视频组' })
  const taken = await bench.saveGroup({ id: 'other', name: '公众号文章组' })
  assert.equal(taken.code, 'GROUP_NAME_TAKEN')
  // 幂等：同值再提交 already。
  const again = await bench.saveGroup({ id: 'gzh', name: '公众号文章组', goal: '每周三篇' })
  assert.equal(again.already, true)
  // 空名 / 超长名。
  assert.equal((await bench.saveGroup({ id: 'gzh', name: '  ' })).code, 'GROUP_NAME_INVALID')
  assert.equal((await bench.saveGroup({ id: 'gzh', name: 'x'.repeat(41) })).code, 'GROUP_NAME_INVALID')
  // 归档需要二次确认；归档后再改名被拒；取消归档恢复。
  assert.equal((await bench.archiveGroup({ id: 'gzh', archived: true })).code, 'GROUP_NOT_CONFIRMED')
  const archived = await bench.archiveGroup({ id: 'gzh', archived: true, confirm: true })
  assert.equal(archived.ok, true)
  assert.equal(archived.group.archived, true)
  assert.equal((await bench.saveGroup({ id: 'gzh', name: '再改' })).code, 'GROUP_ARCHIVED')
  const restored = await bench.archiveGroup({ id: 'gzh', archived: false })
  assert.equal(restored.group.archived, false)
  // 归档一个虚拟组（没有元数据行）会先补行再归档。
  const virtual = await bench.archiveGroup({ id: 'other', archived: true, confirm: true })
  assert.equal(virtual.group.archived, true)
  assert.equal((await bench.archiveGroup({ id: 'ghost', archived: true, confirm: true })).code, 'GROUP_NOT_FOUND')
  db.close()
})

test('createWorkbench.setPlan：写/清 planned_at，终态拒绝，超出两年拒绝，幂等', async () => {
  const db = await openLedger(tempDir())
  const task = makeTask(db, { group: 'gzh', status: 'running' })
  const done = makeTask(db, { title: 'done', status: 'done' })
  const bench = createWorkbench({ db, mainSessionId: () => 's-1' })
  const when = Date.parse('2026-11-22T20:00:00+08:00')
  const set = await bench.setPlan({ taskId: task.id, plannedAt: new Date(when).toISOString() })
  assert.equal(set.ok, true)
  assert.equal(set.plannedAt, when)
  assert.equal(getTask(db, task.id).planned_at, when)
  const again = await bench.setPlan({ taskId: task.id, plannedAt: when })
  assert.equal(again.already, true)
  const cleared = await bench.setPlan({ taskId: task.id, plannedAt: null })
  assert.equal(cleared.ok, true)
  assert.equal(getTask(db, task.id).planned_at, null)
  assert.equal((await bench.setPlan({ taskId: done.id, plannedAt: when })).code, 'PLAN_TASK_ENDED')
  assert.equal((await bench.setPlan({ taskId: 't-nope', plannedAt: when })).code, 'PLAN_TASK_NOT_FOUND')
  assert.equal((await bench.setPlan({ taskId: task.id, plannedAt: '不是时间' })).code, 'PLAN_TIME_INVALID')
  const far = Date.now() + 3 * 366 * 24 * HOUR
  assert.equal((await bench.setPlan({ taskId: task.id, plannedAt: far })).code, 'PLAN_TIME_INVALID')
  // 门控纯函数：终态不可排期、非法时间不可排期。
  assert.equal(planSetGate(getTask(db, done.id)).reason, 'ended')
  assert.equal(planSetGate(getTask(db, task.id), { plannedAt: 1 }).ok, true)
  assert.equal(planSetGate(undefined).reason, 'not_found')
  db.close()
})

test('createWorkbench.calendar：窗口收窄到 62 天，只返回有内容的日子 + upcoming', async () => {
  const db = await openLedger(tempDir())
  const task = makeTask(db, { group: 'gzh', status: 'running' })
  const planned = Date.now() + 3 * HOUR
  setTaskPlannedAt(db, task.id, planned)
  const bench = createWorkbench({ db, mainSessionId: () => 's-1' })
  const body = bench.calendar({ from: new Date(Date.now() - 10 * 24 * HOUR).toISOString(), to: new Date(Date.now() + 400 * 24 * HOUR).toISOString() })
  assert.equal(body.ok, true)
  assert.ok(body.to - body.from <= WORKBENCH_LIMITS.calendarWindowDays * 24 * HOUR + 1, '窗口最多 62 天')
  assert.equal(body.upcoming[0].id, task.id)
  assert.equal(body.upcoming[0].groupId, 'gzh')
  assert.deepEqual(body.days.map(day => day.date), [dayKeyOf(planned)])
  assert.equal(body.days[0].tasks[0].plannedAt, planned)
  // 无排期：days 空、upcoming 空（面板走空态，不报错）。
  const empty = createWorkbench({ db, mainSessionId: () => 's-1' }).calendar({})
  assert.equal(Array.isArray(empty.days), true)
  db.close()
})

test('createWorkbench.automations：宿主无 schedule 服务时整页降级（available=false，不 500）', async () => {
  const db = await openLedger(tempDir())
  const bench = createWorkbench({ db, schedule: () => undefined, mainSessionId: () => 's-1' })
  const body = await bench.automations()
  assert.equal(body.ok, true)
  assert.equal(body.available, false)
  assert.equal(body.canCreate, false)
  assert.deepEqual(body.rows, [])
  // 写动作在降级时给出明确错误码，而不是抛。
  assert.equal((await bench.saveAutomation({ kind: 'group', refId: 'gzh', confirm: true })).code, 'AUTOMATION_UNAVAILABLE')
  assert.equal((await bench.toggleAutomation({ id: 'a-x', active: false, confirm: true })).code, 'AUTOMATION_UNAVAILABLE')
  db.close()
})

test('createWorkbench 自动化全链路：授权确认 → 宿主创建 → 暂停/恢复 → 删除（不撤回已排队消息）', async () => {
  const db = await openLedger(tempDir())
  makeTask(db, { group: 'gzh', status: 'running' })
  const schedule = fakeSchedule()
  const bench = createWorkbench({ db, schedule: () => schedule, mainSessionId: () => 's-main' })
  // 没有明确授权（confirm）一律拒绝。
  assert.equal((await bench.saveAutomation({ kind: 'group', refId: 'gzh', timing: { kind: 'daily', time: '09:00' } })).code, 'AUTOMATION_NOT_CONFIRMED')
  // 没有主会话时拒绝（只有唯一主会话能 task_create）。
  const noMain = createWorkbench({ db, schedule: () => schedule, mainSessionId: () => undefined })
  assert.equal((await noMain.saveAutomation({ kind: 'group', refId: 'gzh', timing: { kind: 'daily', time: '09:00' }, confirm: true })).code, 'AUTOMATION_TARGET_INVALID')
  const created = await bench.saveAutomation({
    kind: 'group', refId: 'gzh', title: '公众号早班', timing: { kind: 'daily', time: '09:00' }, confirm: true,
  })
  assert.equal(created.ok, true)
  assert.equal(created.automation.kind, 'group')
  assert.equal(created.automation.timingText, '每天 09:00')
  assert.equal(created.automation.targetSession, 's-main')
  const createCall = schedule.calls.find(call => call.op === 'create')
  assert.deepEqual(createCall.request.target, { kind: 'session', sessionId: 's-main' }, '只投递唯一主会话，不做 new/new_once')
  assert.equal(createCall.request.timing.kind, 'daily')
  // 话术默认模板：先核对再派单，不重复派。
  assert.match(createCall.request.prompt, /task_list\(\{ group: 'gzh' \}\)/)
  // 清单：下次触发来自宿主 record.scheduledAt。
  const list = await bench.automations()
  assert.equal(list.available, true)
  assert.equal(list.rows.length, 1)
  assert.ok(Number.isFinite(list.rows[0].nextFireAt))
  assert.equal(list.rows[0].hostStatus, 'active')
  assert.equal(list.canCreate, true)
  const id = created.automation.id
  // 暂停 → 镜像与宿主同步。
  const paused = await bench.toggleAutomation({ id, active: false, confirm: true })
  assert.equal(paused.ok, true)
  assert.equal(paused.automation.active, false)
  assert.equal(schedule.rows.get(created.automation.scheduleId).status, 'active', '暂停走 patch.active，不改宿主 status 字段')
  assert.equal((await bench.toggleAutomation({ id, active: false, confirm: true })).already, true)
  // 恢复。
  const resumed = await bench.toggleAutomation({ id, active: true, confirm: true })
  assert.equal(resumed.automation.active, true)
  // 编辑：冲突保护。
  const conflict = await bench.saveAutomation({ id, title: '改名', timing: { kind: 'daily', time: '10:00' }, confirm: true, expectedUpdatedAt: 'stale' })
  assert.equal(conflict.ok, true, 'expectedUpdatedAt 由镜像里的宿主版本提供，客户端传的不参与（不静默覆盖）')
  // 删除：宿主侧删 + 镜像标记 + 文案如实。
  const deleted = await bench.deleteAutomation({ id, confirm: true })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.deleted, true)
  assert.match(deleted.note, /不会被撤回/)
  assert.equal((await bench.deleteAutomation({ id, confirm: true })).already, true)
  assert.deepEqual(listAutomations(db), [], '已删除的镜像不再出现在清单里')
  // 命令族复核：只出现 create/edit，没有别的写通道。
  assert.deepEqual([...new Set(schedule.calls.map(call => call.op))].sort(), ['create', 'edit'])
  db.close()
})

test('createWorkbench.automations：绑定任务的自动化显示「任务名 + 引用」，不暴露台账编号', async () => {
  const db = await openLedger(tempDir())
  const task = makeTask(db, { title: '跟进中的活', status: 'running' })
  const schedule = fakeSchedule()
  const bench = createWorkbench({ db, schedule: () => schedule, mainSessionId: () => 's-main' })
  const created = await bench.saveAutomation({
    kind: 'task', refId: task.id, title: '每日跟进', timing: { kind: 'daily', time: '09:00' }, confirm: true,
  })
  assert.equal(created.ok, true)
  const row = (await bench.automations()).rows[0]
  // R1：refLabel 是「名称（tk-xxx）」，ref 单独给前端做 chip；refId 仍留作动作键。
  assert.equal(row.refLabel, `跟进中的活（${task.ref}）`)
  assert.equal(row.ref, task.ref)
  assert.equal(row.refId, task.id)
  // 任务被删掉：引用置墓碑 → 标签回落到那条引用（不再回落 t-xxxx）。
  const { deleteTask } = await import('../src/ledger.js')
  deleteTask(db, task.id)
  const gone = (await bench.automations()).rows[0]
  assert.equal(gone.refLabel, task.ref)
  assert.equal(gone.ref, task.ref)
  db.close()
})

test('门控纯函数：组改名 / 归档 / 自动化（与端点下发的布尔值同源）', () => {
  assert.equal(groupSaveGate(undefined, { name: 'a' }).ok, true, '虚拟组允许第一次改名')
  assert.equal(groupSaveGate(undefined, { name: 'a', exists: false }).reason, 'not_found')
  assert.equal(groupSaveGate({ archived: true }, { name: 'a' }).reason, 'archived')
  assert.equal(groupSaveGate(undefined, { name: '' }).reason, 'name_invalid')
  assert.equal(groupArchiveGate(undefined).reason, 'not_found')
  assert.equal(groupArchiveGate({}, {}).reason, 'not_confirmed')
  assert.equal(groupArchiveGate({}, { confirm: true }).ok, true)
  assert.equal(automationGate({}).ok, true)
  assert.equal(automationGate({ available: false }).reason, 'unavailable')
  assert.equal(automationGate({ confirmed: false }).reason, 'not_confirmed')
  assert.equal(automationGate({ exists: false }).reason, 'not_found')
})

// ---------------------------------------------------------------------------
// 复盘（P11 阶段 3）：只用台账既有时间戳 + error 首行 + 产物路径 + messages 计数
// ---------------------------------------------------------------------------

test('failureReasonOf / artifactKindOf：错误取首行、产物只看扩展名（不读文件内容）', () => {
  assert.equal(failureReasonOf({ error: 'TypeError: boom\n  at x.js:1:1' }), 'TypeError: boom')
  assert.equal(failureReasonOf({ error: '   ' , status: 'orphaned' }), '会话丢失（没有错误信息）')
  assert.equal(failureReasonOf({ error: null, status: 'failed' }), '失败（没有错误信息）')
  assert.equal(failureReasonOf({ error: 'x'.repeat(200) }).length, 60, '首行截到 60 字')
  assert.equal(artifactKindOf('/w/reports/a.md'), 'md')
  assert.equal(artifactKindOf('C:\\w\\dist\\client.JS'), 'js')
  assert.equal(artifactKindOf('/w/Makefile'), '无扩展名')
  assert.equal(artifactKindOf('/w/archive.tar.gz'), 'gz')
  assert.equal(artifactKindOf('/w/a.verylongext'), '其他')
})

test('reviewStats：交付/确认/平均时长/失败归因/产物类型/组排行 + 窗口口径', () => {
  const now = Date.parse('2026-11-21T12:00:00+08:00')
  const DAY = 24 * HOUR
  const row = (id, patch) => ({
    id, title: id, status: 'done', group_id: null, error: null, artifacts: [],
    created_at: now - 10 * DAY, updated_at: now - 9 * DAY, delivered_at: null, accepted_at: null, ...patch,
  })
  const tasks = [
    // 窗口外（9 / 8 天前）：不算交付/确认，也没有窗口内活动 → 不进组排行。
    row('t-old', { group_id: 'gzh', created_at: now - 10 * DAY, delivered_at: now - 9 * DAY, accepted_at: now - 8 * DAY, artifacts: [{ path: '/w/reports/old.md' }] }),
    // 窗口内（2 天前交付，12 天前创建）：交付 1、时长 10 天、产物 js 1 个。
    row('t-slow', { group_id: 'gzh', created_at: now - 12 * DAY, delivered_at: now - 2 * DAY, artifacts: [{ path: '/w/reports/a.md' }, { path: 'C:\\w\\dist\\client.js' }] }),
    row('t-fail-1', { status: 'failed', group_id: 'skills', updated_at: now - 1 * DAY, error: 'TypeError: boom\n  at x' }),
    row('t-fail-2', { status: 'failed', group_id: 'skills', updated_at: now - 2 * DAY, error: 'TypeError: boom' }),
    row('t-fail-old', { status: 'failed', updated_at: now - 40 * DAY, error: 'old' }),
    row('t-orphan', { status: 'orphaned', updated_at: now - 1 * DAY, error: '' }),
    row('t-out', { created_at: now - 40 * DAY, updated_at: now - 40 * DAY, delivered_at: now - 40 * DAY, group_id: 'gzh' }),
  ]
  const stats = reviewStats({ tasks, groups: [{ id: 'gzh', name: '公众号' }], messages: 12, days: 7, now })
  assert.equal(stats.ok, true)
  assert.equal(stats.days, 7)
  assert.equal(stats.from, now - 7 * DAY)
  assert.equal(stats.to, now)
  // 交付只算窗口内 delivered_at；t-old 的 9 天前交付与 t-out 的 40 天前都不算。
  assert.equal(stats.delivered, 1)
  assert.equal(stats.accepted, 0, 't-old 的确认在窗口外')
  assert.equal(stats.avgDeliverMs, 10 * DAY, '平均创建→交付只统计窗口内交付的行')
  // 失败 = 窗口内 updated_at 且 failed/orphaned；按 error 首行归类。
  assert.equal(stats.failed, 3)
  assert.deepEqual(stats.failures, [
    { reason: 'TypeError: boom', count: 2 },
    { reason: '会话丢失（没有错误信息）', count: 1 },
  ])
  // 产物：只统计窗口内「创建或交付」的任务；t-old 的 9 天前交付 → 它的 md 不计。
  assert.deepEqual(stats.artifacts, [{ ext: 'js', count: 1 }, { ext: 'md', count: 1 }])
  // 组排行：交付数优先，其次失败数；未分组用固定行（id 为空）。
  assert.deepEqual(stats.groups.map(item => [item.id, item.name, item.delivered, item.failed, item.total]), [
    ['gzh', '公众号', 1, 0, 1],
    ['skills', 'skills', 0, 2, 2],
    ['', '未分组', 0, 1, 1],
  ])
  assert.equal(stats.messages, 12)
  // 窗口口径：days 非法回落 7，上限 62，下限 1。
  assert.equal(reviewStats({ tasks: [], days: 'x', now }).days, 7)
  assert.equal(reviewStats({ tasks: [], days: 0, now }).days, 7)
  assert.equal(reviewStats({ tasks: [], days: 500, now }).days, 62)
  assert.equal(reviewStats({ tasks: [], now }).avgDeliverMs, null, '没有交付时平均时长为 null（面板显示 —）')
  assert.equal(reviewStats({ tasks: [], days: 7, now }).failures.length, 0)
})

test('createWorkbench.stats：窗口内交付/确认/失败与 messages 计数，只读不改台账', async () => {
  const db = await openLedger(tempDir())
  const at = Date.parse('2026-11-21T12:00:00+08:00')
  const bench = createWorkbench({ db, mainSessionId: () => 's-main', now: () => at })
  const done = makeTask(db, { group: 'gzh', title: '交付一条', status: 'done' })
  const failed = makeTask(db, { group: 'gzh', title: '失败一条' })
  db.prepare('UPDATE tasks SET created_at = ?, delivered_at = ?, accepted_at = ?, updated_at = ? WHERE id = ?')
    .run(at - 3 * 24 * HOUR, at - 2 * 24 * HOUR, at - 24 * HOUR, at - 24 * HOUR, done.id)
  db.prepare('UPDATE tasks SET status = ?, error = ?, created_at = ?, updated_at = ? WHERE id = ?')
    .run('failed', 'boom: 命令失败\n第二行不该进归因', at - 3 * 24 * HOUR, at - 2 * HOUR, failed.id)
  addMessage(db, done.id, { kind: 'report', rendered: '回来了' })
  db.prepare('UPDATE messages SET at = ? WHERE task_id = ?').run(at - 2 * HOUR, done.id)
  const stats = bench.stats({ days: 7 })
  assert.equal(stats.ok, true)
  assert.equal(stats.days, 7)
  assert.equal(stats.delivered, 1)
  assert.equal(stats.accepted, 1)
  assert.equal(stats.avgDeliverMs, 24 * HOUR)
  assert.equal(stats.messages, 1, '窗口内 messages 条数')
  assert.deepEqual(stats.failures, [{ reason: 'boom: 命令失败', count: 1 }])
  assert.equal(stats.groups[0].id, 'gzh')
  assert.equal(stats.groups[0].delivered, 1)
  assert.equal(stats.groups[0].failed, 1)
  // 只读：换窗口再读一次，台账行与状态都不动。
  const before = db.prepare('SELECT count(*) AS n FROM tasks').get().n
  const wide = bench.stats({ days: 30 })
  assert.equal(wide.days, 30)
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, before)
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(failed.id).status, 'failed')
  // 缺省 / 上限。
  assert.equal(bench.stats({}).days, 7)
  assert.equal(bench.stats({ days: 1000 }).days, 62)
  db.close()
})

test('0.36.0 多协调者：自动化绑创建它的协调者（sessionId 必须仍在名单），未传回落主协调者；目标失效可读提示', async () => {
  const db = await openLedger(tempDir())
  makeTask(db, { group: 'gzh', status: 'running' })
  const schedule = fakeSchedule()
  const list = ['s-main', 's-side']
  const bench = createWorkbench({
    db,
    schedule: () => schedule,
    mainSessionId: () => list[0],
    coordinatorIds: () => [...list],
  })
  // 副协调者创建 → 宿主 schedule 与镜像都指向它（不是固定主协调者）。
  const created = await bench.saveAutomation({
    kind: 'group', refId: 'gzh', title: '副协调者早班', timing: { kind: 'daily', time: '10:00' }, confirm: true, sessionId: 's-side',
  })
  assert.equal(created.ok, true)
  assert.equal(created.automation.targetSession, 's-side')
  assert.equal(created.automation.targetMissing, false)
  const createCall = schedule.calls.find(call => call.op === 'create')
  assert.deepEqual(createCall.request.target, { kind: 'session', sessionId: 's-side' })

  // 不在名单的 sessionId → 可读拒绝，不建 schedule。
  const invalid = await bench.saveAutomation({
    kind: 'group', refId: 'gzh', title: 'x', timing: { kind: 'daily', time: '10:00' }, confirm: true, sessionId: 's-zz',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'AUTOMATION_TARGET_INVALID')

  // 未传 sessionId（旧客户端）→ 回落主协调者。
  const fallback = await bench.saveAutomation({
    kind: 'group', refId: 'gzh', title: '老客户端', timing: { kind: 'daily', time: '10:00' }, confirm: true,
  })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.automation.targetSession, 's-main')

  // 目标会话退出名单 → 列表里该行标 targetMissing（其余行不受影响）。
  list.splice(1, 1)
  const listed = await bench.automations()
  assert.deepEqual(listed.coordinatorIds, ['s-main'])
  const side = listed.rows.find(row => row.targetSession === 's-side')
  const main = listed.rows.find(row => row.targetSession === 's-main')
  assert.equal(side.targetMissing, true, '目标已不是协调者 → 到点没人处理，面板要提示')
  assert.equal(main.targetMissing, false)
  db.close()
})

