import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, createTask, getTask, listTasks, listHistoryTasks, listPendingQueue, countPending, transition, touchTask, addMessage, setMessageDelivery, addNotification, deleteTask, getSetting, setSetting, bindSettingOnce, rebindSetting, getMainSessionId, setMainSessionId, setTaskArtifacts, setTaskLastMessage } from '../src/ledger.js'
import { tempDir, sampleBrief, markDone } from './helpers.js'

test('建表、WAL 与幂等打开', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name)
  assert.deepEqual(tables, ['memories', 'messages', 'notifications', 'settings', 'tasks'])
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  db.close()
  const again = await openLedger(dir)
  assert.equal(again.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 5)
  again.close()
})

test('创建并读回任务', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: 'A' }), coordinatorSession: 's-1' })
  assert.match(task.id, /^t-[0-9a-f]{8}$/)
  assert.equal(task.status, 'pending')
  assert.equal(getTask(db, task.id).title, 'A')
  assert.equal(typeof task.created_at, 'number')
  assert.equal(typeof task.updated_at, 'number')
  assert.equal(typeof task.last_event_at, 'number')
  db.close()
})

test('listTasks 默认只列活跃任务', async () => {
  const db = await openLedger(tempDir())
  const a = createTask(db, { brief: sampleBrief({ title: 'A' }), coordinatorSession: 's-1' })
  const b = createTask(db, { brief: sampleBrief({ title: 'B' }), coordinatorSession: 's-1' })
  transition(db, a.id, 'running')
  transition(db, b.id, 'cancelled')
  assert.deepEqual(listTasks(db, { active: true }).map(task => task.title), ['A'])
  assert.equal(listTasks(db).length, 2)
  db.close()
})

test('listTasks 活跃集合覆盖四种状态', async () => {
  const db = await openLedger(tempDir())
  const ids = {}
  for (const title of ['pending', 'running', 'waiting_user', 'waiting_auth', 'done', 'cancelled']) {
    ids[title] = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1' }).id
  }
  transition(db, ids.running, 'running')
  transition(db, ids.waiting_user, 'running')
  transition(db, ids.waiting_user, 'waiting_user')
  transition(db, ids.waiting_auth, 'running')
  transition(db, ids.waiting_auth, 'waiting_auth')
  transition(db, ids.done, 'running')
  markDone(db, ids.done)
  transition(db, ids.cancelled, 'cancelled')
  assert.deepEqual(listTasks(db, { active: true }).map(t => t.title).sort(), ['pending', 'running', 'waiting_auth', 'waiting_user'])
  db.close()
})

test('settings 读写与覆盖', async () => {
  const db = await openLedger(tempDir())
  assert.equal(getSetting(db, 'coordinator_session_id'), undefined)
  setSetting(db, 'coordinator_session_id', 's-1')
  assert.equal(getSetting(db, 'coordinator_session_id'), 's-1')
  setSetting(db, 'coordinator_session_id', 's-2')
  assert.equal(getSetting(db, 'coordinator_session_id'), 's-2')
  db.close()
})

test('首次绑定先到先得，失效重绑是 CAS', async () => {
  const db = await openLedger(tempDir())
  assert.equal(bindSettingOnce(db, 'k', 's-1'), 's-1')
  assert.equal(bindSettingOnce(db, 'k', 's-2'), 's-1')
  assert.equal(rebindSetting(db, 'k', 's-0', 's-3'), false)
  assert.equal(getSetting(db, 'k'), 's-1')
  assert.equal(rebindSetting(db, 'k', 's-1', 's-3'), true)
  assert.equal(getSetting(db, 'k'), 's-3')
  db.close()
})

test('同毫秒创建的排序稳定：按 created_at DESC, rowid DESC', async () => {
  const db = await openLedger(tempDir())
  const ids = []
  for (let i = 0; i < 5; i += 1) ids.push(createTask(db, { brief: sampleBrief({ title: `T${i}` }), coordinatorSession: 's-1' }).id)
  assert.deepEqual(listTasks(db).map(t => t.id), [...ids].reverse())
  db.close()
})

test('非法状态迁移被拒绝且不落库', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  transition(db, task.id, 'running')
  markDone(db, task.id)
  const before = getTask(db, task.id)
  assert.throws(() => transition(db, task.id, 'running'), /不允许/)
  const after = getTask(db, task.id)
  assert.equal(after.status, 'done')
  assert.equal(after.updated_at, before.updated_at)
  db.close()
})

test('不存在任务抛可读中文错误', async () => {
  const db = await openLedger(tempDir())
  assert.throws(() => transition(db, 't-nope', 'running'), /任务不存在：t-nope/)
  db.close()
})

test('消息按 seq 递增保存', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  for (let i = 1; i <= 5; i += 1) addMessage(db, task.id, { kind: 'brief', rendered: `m${i}` })
  const rows = db.prepare('SELECT seq, rendered FROM messages WHERE task_id = ? ORDER BY seq').all(task.id)
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3, 4, 5])
  assert.deepEqual(rows.map(row => row.rendered), ['m1', 'm2', 'm3', 'm4', 'm5'])
  db.close()
})

test('8 个任务各写 20 条消息：seq 连续、不串号、不丢失', async () => {
  const db = await openLedger(tempDir())
  const tasks = Array.from({ length: 8 }, (_, i) =>
    createTask(db, { brief: sampleBrief({ title: `T${i}` }), coordinatorSession: 's-1' }))
  const work = []
  for (const task of tasks) {
    for (let i = 0; i < 20; i += 1) {
      work.push((async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        addMessage(db, task.id, { kind: 'report', rendered: `${task.id}:${i}` })
      })())
    }
  }
  await Promise.all(work)
  for (const task of tasks) {
    const rows = db.prepare('SELECT seq, rendered FROM messages WHERE task_id = ? ORDER BY seq').all(task.id)
    assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 20 }, (_, i) => i + 1))
    assert.ok(rows.every(row => row.rendered.startsWith(`${task.id}:`)))
  }
  db.close()
})

test('touchTask 只更新时间戳', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  transition(db, task.id, 'running')
  const before = getTask(db, task.id)
  await new Promise(resolve => setTimeout(resolve, 2))
  touchTask(db, task.id)
  const after = getTask(db, task.id)
  assert.equal(after.status, 'running')
  assert.ok(after.updated_at >= before.updated_at)
  assert.ok(after.last_event_at > before.last_event_at)
  db.close()
})

test('patch.error 可以显式清空，未传则不覆盖', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { error: '第一次失败' })
  assert.equal(getTask(db, task.id).error, '第一次失败')
  transition(db, task.id, 'waiting_user')
  assert.equal(getTask(db, task.id).error, '第一次失败')
  transition(db, task.id, 'running', { error: null })
  assert.equal(getTask(db, task.id).error, null)
  db.close()
})

test('notifications 可写入并返回自增 id', async () => {
  const db = await openLedger(tempDir())
  const first = addNotification(db, { taskId: 't-1', level: 'notify', status: 'delivered' })
  const second = addNotification(db, { taskId: 't-2', level: 'notify', status: 'delivered', mergedInto: first })
  assert.equal(typeof first, 'number')
  assert.ok(second > first)
  const rows = db.prepare('SELECT task_id, level, status, delivered_at, merged_into FROM notifications ORDER BY rowid').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[1].merged_into, first)
  assert.ok(rows[0].delivered_at > 0)
  db.close()
})

test('损坏账本给出可读中文错误，不泄漏 SQLITE_ 或堆栈', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-corrupt-'))
  writeFileSync(join(dir, 'tasks.sqlite'), 'this is not a sqlite database at all')
  await assert.rejects(
    () => openLedger(dir),
    error => {
      assert.match(error.message, /台账损坏/)
      assert.match(error.message, /tasks\.sqlite/)
      assert.match(error.message, /snapshots/)
      assert.equal(error.message.includes('SQLITE_'), false)
      assert.equal(/\n\s+at /.test(error.message), false)
      return true
    },
  )
})

test('非损坏的打开失败不报「台账损坏」，保留原始原因', async () => {
  const dir = tempDir()
  const file = join(dir, 'plain-file')
  writeFileSync(file, 'x')
  await assert.rejects(
    () => openLedger(join(file, 'state')),
    error => {
      assert.match(error.message, /台账不可用/)
      assert.equal(error.message.includes('台账损坏'), false)
      assert.match(error.message, /ENOTDIR|not a directory/i)
      return true
    },
  )
})

test('落盘范围仅限传入目录', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  db.close()
  const { readdirSync } = await import('node:fs')
  const names = readdirSync(dir).sort()
  assert.ok(names.length > 0)
  assert.ok(names.every(name => name.startsWith('tasks.sqlite')), names.join(','))
  assert.deepEqual(names.filter(name => !name.startsWith('tasks.sqlite')), [])
})

test('tasks 表有 target_dir，旧库自动补列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-'))
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('target_dir'))
  const task = createTask(db, {
    brief: { title: '任务', goal: '目标', acceptance: ['a'] },
    coordinatorSession: 's-1',
    targetDir: 'C:/work/project',
  })
  assert.equal(task.target_dir, 'C:/work/project')
  db.close()
})

test('旧库缺 target_dir 时自动 ALTER 补列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-old-'))
  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(join(dir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.close()
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('target_dir'))
  db.close()
})

test('access：默认 null（沿用会话策略）、显式 full 落库、坏值归一成 null', async () => {
  const db = await openLedger(tempDir())
  const normal = createTask(db, { brief: { title: '普通', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  assert.equal(normal.access, null)
  const full = createTask(db, {
    brief: { title: '完整访问', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1', access: 'full',
  })
  assert.equal(full.access, 'full')
  assert.equal(getTask(db, full.id).access, 'full')
  // 手改/旧版写入的其它值一律按默认处理（读取侧不信任库里的自由文本）。
  db.prepare("UPDATE tasks SET access = 'workspace-write' WHERE id = ?").run(full.id)
  assert.equal(getTask(db, full.id).access, null)
  db.close()
})

test('access：旧库自动补列，历史行按默认（null）', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const legacyDir = mkdtempSync(join(tmpdir(), 'orch-ledger-access-legacy-'))
  const legacy = new DatabaseSync(join(legacyDir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at)
    VALUES ('t-old', '旧任务', 'g', '{}', 'done', 's-1', 1, 1, 1)`).run()
  legacy.close()
  const migrated = await openLedger(legacyDir)
  const cols = migrated.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('access'))
  assert.equal(getTask(migrated, 't-old').access, null)
  migrated.close()
})

test('read_only：默认 false、显式 true 落库、旧库自动补列', async () => {
  const db = await openLedger(tempDir())
  const normal = createTask(db, { brief: { title: '普通', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  assert.equal(normal.read_only, false)
  const readOnly = createTask(db, { brief: { title: '只读', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1', readOnly: true })
  assert.equal(readOnly.read_only, true)
  assert.equal(getTask(db, readOnly.id).read_only, true)
  db.close()

  const { DatabaseSync } = await import('node:sqlite')
  const legacyDir = mkdtempSync(join(tmpdir(), 'orch-ledger-ro-legacy-'))
  const legacy = new DatabaseSync(join(legacyDir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at)
    VALUES ('t-old', '旧任务', 'g', '{}', 'done', 's-1', 1, 1, 1)`).run()
  legacy.close()
  const migrated = await openLedger(legacyDir)
  const cols = migrated.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('read_only'))
  assert.equal(getTask(migrated, 't-old').read_only, false)
  migrated.close()
})

test('main_session_id 读写', async () => {
  const db = await openLedger(tempDir())
  assert.equal(getMainSessionId(db), undefined)
  setMainSessionId(db, 'session-main')
  assert.equal(getMainSessionId(db), 'session-main')
  db.close()
})


test('tasks 表有 artifacts_json，旧库自动补列，旧行按空数组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-art-'))
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('artifacts_json'))
  const task = createTask(db, { brief: { title: '任务', goal: '目标', acceptance: ['a'] }, coordinatorSession: 's-1' })
  assert.deepEqual(task.artifacts, [])
  db.close()

  const { DatabaseSync } = await import('node:sqlite')
  const legacyDir = mkdtempSync(join(tmpdir(), 'orch-ledger-art-legacy-'))
  const legacy = new DatabaseSync(join(legacyDir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, target_dir TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare('INSERT INTO tasks (id,title,goal,brief_json,status,coordinator_session,created_at,updated_at,last_event_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('t-old', 'old', 'g', '{}', 'done', 's-1', 1, 1, 1)
  legacy.close()
  const reopened = await openLedger(legacyDir)
  const old = getTask(reopened, 't-old')
  assert.deepEqual(old.artifacts, [])
  const legacyCols = reopened.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(legacyCols.includes('artifacts_json'))
  reopened.close()
})

test('setTaskArtifacts 落库并可读回，不改状态', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '带产物' }), coordinatorSession: 's-1' })
  const artifacts = [
    { path: 'C:/work/report.md', label: '报告', exists: true },
    { path: 'C:/work/missing.txt', label: '', exists: false },
  ]
  const updated = setTaskArtifacts(db, task.id, artifacts)
  assert.deepEqual(updated.artifacts, artifacts)
  assert.equal(updated.status, task.status)
  assert.deepEqual(getTask(db, task.id).artifacts, artifacts)
  db.close()
})

test('setTaskArtifacts 累积合并：不同路径保留，同路径后报覆盖，总数有上限', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '累积' }), coordinatorSession: 's-1' })
  setTaskArtifacts(db, task.id, [{ path: 'C:/a.md', label: 'A', exists: true }])
  setTaskArtifacts(db, task.id, [{ path: 'C:/b.md', label: 'B', exists: true }, { path: 'C:/a.md', label: 'A2', exists: true }])
  const saved = getTask(db, task.id).artifacts
  assert.deepEqual(saved.map(item => item.path), ['C:/a.md', 'C:/b.md'])
  assert.equal(saved[0].label, 'A2')
  const many = Array.from({ length: 60 }, (_, index) => ({ path: `C:/x-${index}.txt`, label: '', exists: true }))
  setTaskArtifacts(db, task.id, many)
  assert.equal(getTask(db, task.id).artifacts.length, 50)
  db.close()
})

test('P1 字段：依赖/分组/写域/优先级落库，waiting_dep 算活跃，队列按优先级排', async () => {
  const db = await openLedger(tempDir())
  const low = createTask(db, {
    brief: sampleBrief({ title: '低' }), coordinatorSession: 's-1', priority: 1,
    dependsOn: ['t-a'], groupId: 'G', writeScopes: ['src'],
  })
  const high = createTask(db, {
    brief: sampleBrief({ title: '高' }), coordinatorSession: 's-1', priority: 9,
    status: 'waiting_dep',
  })
  assert.deepEqual(low.depends_on, ['t-a'])
  assert.equal(low.group_id, 'G')
  assert.deepEqual(low.write_scopes, ['src'])
  assert.equal(low.priority, 1)
  assert.equal(high.status, 'waiting_dep')
  assert.deepEqual(listTasks(db, { active: true }).map(task => task.id).sort(), [low.id, high.id].sort())
  assert.deepEqual(listHistoryTasks(db).map(task => task.id), [])
  assert.equal(countPending(db), 2)
  assert.deepEqual(listPendingQueue(db).map(task => task.priority), [1])
  db.close()
})

test('artifacts_json 损坏或非数组时读回空数组', async () => {  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '坏数据' }), coordinatorSession: 's-1' })
  db.prepare('UPDATE tasks SET artifacts_json = ? WHERE id = ?').run('not-json', task.id)
  assert.deepEqual(getTask(db, task.id).artifacts, [])
  db.prepare('UPDATE tasks SET artifacts_json = ? WHERE id = ?').run('{"a":1}', task.id)
  assert.deepEqual(getTask(db, task.id).artifacts, [])
  db.close()
})

test('B1 last_message_json：旧库自动补列、坏 JSON 当没有、同正文回落幂等', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const legacyDir = mkdtempSync(join(tmpdir(), 'orch-ledger-lm-legacy-'))
  const legacy = new DatabaseSync(join(legacyDir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare('INSERT INTO tasks (id,title,goal,brief_json,status,coordinator_session,created_at,updated_at,last_event_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('t-old', 'old', 'g', '{}', 'done', 's-1', 1, 1, 1)
  legacy.close()
  const db = await openLedger(legacyDir)
  assert.ok(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name).includes('last_message_json'))
  assert.equal(getTask(db, 't-old').last_message, null)
  db.prepare('UPDATE tasks SET last_message_json = ? WHERE id = ?').run('not-json', 't-old')
  assert.equal(getTask(db, 't-old').last_message, null)

  const task = createTask(db, { brief: sampleBrief({ title: '带返回' }), coordinatorSession: 's-1' })
  const record = { at: 1, stopReason: 'completed', source: 'lifecycle', bytes: 6, chars: 2, digest: 'abc123', summary: '正文', stored: 'inline', text: '正文' }
  const first = setTaskLastMessage(db, task.id, record)
  assert.equal(first.last_message.text, '正文')
  const firstUpdatedAt = first.updated_at
  // 同 digest 再写：幂等，不动 updated_at
  const again = setTaskLastMessage(db, task.id, { ...record, at: 999 })
  assert.equal(again.last_message.at, 1)
  assert.equal(again.updated_at, firstUpdatedAt)
  // digest 变了才覆盖
  const replaced = setTaskLastMessage(db, task.id, { ...record, digest: 'def456', text: '新正文', summary: '新正文' })
  assert.equal(replaced.last_message.text, '新正文')
  assert.equal(replaced.last_message.digest, 'def456')
  // 空记录不覆盖
  assert.equal(setTaskLastMessage(db, task.id, null).last_message.text, '新正文')
  db.close()
})

test('setMessageDelivery 只改 meta_json，不新增消息行', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  const seq = addMessage(db, task.id, { kind: 'followup', rendered: '继续', meta: { delivery: 'pending' } })
  const before = db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n
  assert.equal(setMessageDelivery(db, task.id, seq, 'delivered'), true)
  const row = db.prepare('SELECT meta_json FROM messages WHERE task_id = ? AND seq = ?').get(task.id, seq)
  assert.equal(JSON.parse(row.meta_json).delivery, 'delivered')
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n, before)
  // 保留已有 meta 字段：只覆盖 delivery 和传入的补充字段。
  setMessageDelivery(db, task.id, seq, 'failed', { error: 'boom' })
  const merged = JSON.parse(db.prepare('SELECT meta_json FROM messages WHERE task_id = ? AND seq = ?').get(task.id, seq).meta_json)
  assert.deepEqual(merged, { delivery: 'failed', error: 'boom' })
  // 不存在的 seq / 非法状态：返回 false 或抛错，不静默写坏库。
  assert.equal(setMessageDelivery(db, task.id, 999, 'delivered'), false)
  assert.throws(() => setMessageDelivery(db, task.id, seq, 'weird'), /未知投递状态/)
  db.close()
})

test('M1 迁移：旧 kind=task-done 迁到 task-log 并重算 hash，重复打开幂等', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  // 模拟旧版本写入的行（kind='task-done'，hash 按旧公式）。
  db.prepare(`INSERT INTO memories (id, project_key, kind, text, hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('m-legacy', 'c:/work/legacy', 'task-done', '任务「旧版」完成：改用 cookie', 'legacy-hash', Date.now())
  db.close()

  const migrated = await openLedger(dir)
  const row = migrated.prepare("SELECT kind, hash FROM memories WHERE id = 'm-legacy'").get()
  assert.equal(row.kind, 'task-log')
  assert.notEqual(row.hash, 'legacy-hash')
  migrated.close()

  // 再打开一次：不重复迁移、不新增行、hash 稳定。
  const again = await openLedger(dir)
  const rows = again.prepare("SELECT kind, hash FROM memories WHERE id = 'm-legacy'").all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'task-log')
  assert.equal(rows[0].hash, row.hash)
  assert.equal(again.prepare("SELECT count(*) AS n FROM memories WHERE kind = 'task-done'").get().n, 0)
  again.close()
})

test('deleteTask：删任务行并级联 messages/notifications，返回删除计数；不存在返回 undefined', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '待删' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  markDone(db, task.id)
  addMessage(db, task.id, { kind: 'brief', rendered: '简报' })
  addMessage(db, task.id, { kind: 'report', rendered: '结果' })
  addNotification(db, { taskId: task.id, level: 'info' })
  addNotification(db, { taskId: task.id, level: 'warn' })
  const removed = deleteTask(db, task.id)
  assert.equal(removed.task.id, task.id)
  assert.deepEqual(removed.deleted, { messages: 2, notifications: 2 })
  assert.equal(getTask(db, task.id), undefined)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n, 0)
  // 幂等：再删一次返回 undefined，不抛错。
  assert.equal(deleteTask(db, task.id), undefined)
  db.close()
})
