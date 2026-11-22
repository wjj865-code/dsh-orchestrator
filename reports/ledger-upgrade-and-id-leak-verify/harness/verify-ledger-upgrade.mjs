#!/usr/bin/env node
// 真台账升级验证（只读原库 + 副本）：合并后的 openLedger 打开真实台账副本。
//
// 用法：
//   node reports/ledger-upgrade-and-id-leak-verify/harness/verify-ledger-upgrade.mjs [--keep]
//
// 退出码：0 = 全部 PASS；1 = 有 FAIL（详细见 evidence JSON）。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { deleteTask, getTask, openLedger } from '../../../src/ledger.js'
import { resolveTaskInput, taskRefOf, TASK_ID_RE, TASK_REF_RE } from '../../../src/task-ref.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = resolve(HERE, '..')
const EVIDENCE_DIR = join(REPORT_DIR, 'evidence')
const KEEP = process.argv.includes('--keep')
const SRC_DB_DIR = process.env.DSH_ORCH_STATE_DIR ?? 'C:\\Users\\72489\\.dsh\\state\\orchestrator'
const SRC_DB = join(SRC_DB_DIR, 'tasks.sqlite')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const sha256 = path => {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const dbHashes = dir => ({
  main: sha256(join(dir, 'tasks.sqlite')),
  wal: sha256(join(dir, 'tasks.sqlite-wal')),
  shm: sha256(join(dir, 'tasks.sqlite-shm'))
})

const rowCount = (db, table) => {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c)
  } catch (error) {
    return { error: String(error.message ?? error) }
  }
}

const counts = db => ({
  tasks: rowCount(db, 'tasks'),
  messages: rowCount(db, 'messages'),
  notifications: rowCount(db, 'notifications'),
  memories: rowCount(db, 'memories'),
  settings: rowCount(db, 'settings'),
  automations: rowCount(db, 'automations'),
  groups: rowCount(db, 'groups_v1'),
  task_refs: rowCount(db, 'task_refs')
})

const tableNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name)
const integrity = db => String(db.prepare('PRAGMA integrity_check').get().integrity_check)
const planPathColumn = db => db.prepare('PRAGMA table_info(tasks)').all().some(row => row.name === 'plan_path')

const snapshotTo = (sourcePath, targetPath) => {
  // 只读连接上 VACUUM INTO：一致性快照，不写源库。失败则回退「三文件拷贝」。
  const db = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''").replaceAll('\\', '/')}'`)
    return { method: 'vacuum-into' }
  } finally {
    db.close()
  }
}

const copyTriplet = (sourceDir, targetDir) => {
  copyFileSync(join(sourceDir, 'tasks.sqlite'), join(targetDir, 'tasks.sqlite'))
  for (const suffix of ['-wal', '-shm']) {
    const from = join(sourceDir, `tasks.sqlite${suffix}`)
    if (existsSync(from)) copyFileSync(from, join(targetDir, `tasks.sqlite${suffix}`))
  }
  return { method: 'file-copy' }
}

const cleanupTargets = []
const makeTempDir = label => {
  const dir = mkdtempSync(join(tmpdir(), `orch-${label}-`))
  cleanupTargets.push(dir)
  return dir
}

const main = async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  record('源台账存在', existsSync(SRC_DB), SRC_DB)

  const beforeHashes = dbHashes(SRC_DB_DIR)
  const beforeStat = { size: statSync(SRC_DB).size, mtimeMs: statSync(SRC_DB).mtimeMs }
  // 源库（只读连接）当下计数：用来证明副本快照不是旧状态（WAL 已并入）。
  const liveDb = new DatabaseSync(SRC_DB, { readOnly: true })
  const sourceCounts = counts(liveDb)
  const sourceMaxSeq = Number(liveDb.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages').get().s)
  const sourceMaxTask = String(liveDb.prepare('SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1').get()?.id ?? '')
  liveDb.close()
  record('源库（只读）当下计数已取得', true, sourceCounts)

  // 1) 一致性快照到临时目录（源库只读，不写）
  const upgradeDir = makeTempDir('ledger-upgrade')
  let snapshot
  try {
    snapshot = snapshotTo(SRC_DB, join(upgradeDir, 'tasks.sqlite'))
  } catch (error) {
    console.log(`[info] VACUUM INTO 不可用（${error.message}），回退文件拷贝`)
    snapshot = copyTriplet(SRC_DB_DIR, upgradeDir)
  }
  record('快照方式', true, snapshot)
  const copyPath = join(upgradeDir, 'tasks.sqlite')
  record('副本已生成', existsSync(copyPath), { path: copyPath, size: statSync(copyPath).size })
  const afterCopyHashes = dbHashes(SRC_DB_DIR)
  record('取快照后源库 sha256 未变', JSON.stringify(beforeHashes) === JSON.stringify(afterCopyHashes),
    { before: beforeHashes, after: afterCopyHashes })

  // 2) 升级前的副本基线（无 task_refs / 无 plan_path）
  const preDb = new DatabaseSync(copyPath, { readOnly: true })
  const preCounts = counts(preDb)
  const preTables = tableNames(preDb)
  const prePlanPath = planPathColumn(preDb)
  const historicalIds = preDb.prepare(
    `SELECT id, status FROM tasks
     WHERE status IN ('done','cancelled','failed','delivered','blocked','pending','running','waiting_dep')
     ORDER BY created_at DESC`)
    .all().map(row => ({ id: String(row.id), status: String(row.status) }))
  preDb.close()
  record('升级前副本：无 task_refs 表', !preTables.includes('task_refs'), preTables)
  record('升级前副本：tasks 无 plan_path 列', prePlanPath === false)
  record('升级前副本：任务/消息数', true, { tasks: preCounts.tasks, messages: preCounts.messages })
  record('副本与源库（只读）计数一致（WAL 已并入，非旧状态）',
    preCounts.tasks === sourceCounts.tasks && preCounts.messages === sourceCounts.messages,
    { source: sourceCounts, copy: preCounts, sourceMaxSeq, sourceMaxTask })

  // 3) 用合并后的新版 openLedger 打开副本（第一次：建表 + 回填）
  let db = await openLedger(upgradeDir)
  const postCounts = counts(db)
  record('task_refs 表已自动建出', tableNames(db).includes('task_refs'))
  record('tasks.plan_path 列已补齐', planPathColumn(db) === true)
  record('任务数不变', postCounts.tasks === preCounts.tasks, { before: preCounts.tasks, after: postCounts.tasks })
  record('消息数不变', postCounts.messages === preCounts.messages, { before: preCounts.messages, after: postCounts.messages })
  record('通知/设置/记忆/组数不变',
    postCounts.notifications === preCounts.notifications
    && postCounts.settings === preCounts.settings
    && postCounts.memories === preCounts.memories
    && postCounts.groups === preCounts.groups,
    { before: preCounts, after: postCounts })
  record('PRAGMA integrity_check = ok', integrity(db) === 'ok', integrity(db))

  // 4) 回填完整性
  const refRows = db.prepare('SELECT token, task_id, created_at, retired_at FROM task_refs').all()
    .map(row => ({ token: String(row.token), taskId: String(row.task_id), createdAt: Number(row.created_at), retiredAt: row.retired_at }))
  const tasksWithoutRef = db.prepare(`SELECT t.id FROM tasks t LEFT JOIN task_refs r ON r.task_id = t.id WHERE r.token IS NULL`).all()
    .map(row => String(row.id))
  const refsWithoutTask = db.prepare(`SELECT r.token, r.task_id FROM task_refs r LEFT JOIN tasks t ON t.id = r.task_id WHERE t.id IS NULL`).all()
  const badTokenShape = refRows.filter(row => !TASK_REF_RE.test(row.token))
  const dupTokens = refRows.length - new Set(refRows.map(row => row.token)).size
  const dupTaskIds = refRows.length - new Set(refRows.map(row => row.taskId)).size
  record('每条任务都有引用', tasksWithoutRef.length === 0, { missing: tasksWithoutRef.slice(0, 5), missingCount: tasksWithoutRef.length })
  record('引用都指向存在的任务（无孤儿）', refsWithoutTask.length === 0, { orphans: refsWithoutTask.slice(0, 5), count: refsWithoutTask.length })
  record('token 形状全部合法（tk- + 6 位）', badTokenShape.length === 0, { bad: badTokenShape.slice(0, 5).map(r => r.token) })
  record('token 无重复（主键 + 唯一 task_id）', dupTokens === 0 && dupTaskIds === 0, { dupTokens, dupTaskIds })
  record('回填只补缺的（引用数 = 任务数）', refRows.length === postCounts.tasks,
    { refs: refRows.length, tasks: postCounts.tasks })
  const retiredCount = refRows.filter(row => row.retiredAt !== null).length
  record('副本上无墓碑（旧库从未有过 token）', retiredCount === 0, { retired: retiredCount })

  // 5) 旧任务：t-xxxx 仍可解析、引用齐全
  const statuses = [...new Set(historicalIds.map(row => row.status))]
  const samples = []
  for (const status of statuses) {
    const pick = historicalIds.find(row => row.status === status)
    if (pick !== undefined) samples.push(pick)
  }
  // 再补几个最近的历史任务，凑够至少 8 条
  for (const row of historicalIds) {
    if (samples.length >= 8) break
    if (!samples.some(item => item.id === row.id)) samples.push(row)
  }
  const legacyChecks = samples.map(({ id, status }) => {
    const resolved = resolveTaskInput(db, id)
    const ref = taskRefOf(db, id)
    const task = resolved.ok ? getTask(db, id) : null
    return {
      id,
      status,
      resolvesById: resolved.ok === true && resolved.via === 'id',
      resolvesByRef: ref !== null && resolveTaskInput(db, ref).ok === true && resolveTaskInput(db, ref).via === 'ref',
      ref,
      taskRowHasRef: task !== null && task.ref === ref,
      refShapeOk: ref !== null && TASK_REF_RE.test(ref)
    }
  })
  const legacyOk = legacyChecks.every(item => item.resolvesById && item.resolvesByRef && item.taskRowHasRef && item.refShapeOk)
  record('历史任务 t-xxxx 可解析且带 tk- 引用', legacyOk, legacyChecks)
  record('t-xxxx 参数形态仍被接受', legacyChecks.every(item => TASK_ID_RE.test(item.id)), { ids: legacyChecks.map(i => i.id) })

  // 6) 幂等：全部关闭后重新打开
  const refMapBefore = JSON.stringify(refRows.map(row => [row.token, row.taskId, row.createdAt]).sort())
  db.close()
  db = await openLedger(upgradeDir)
  const secondCounts = counts(db)
  const refRowsSecond = db.prepare('SELECT token, task_id, created_at, retired_at FROM task_refs').all()
    .map(row => ({ token: String(row.token), taskId: String(row.task_id), createdAt: Number(row.created_at), retiredAt: row.retired_at }))
  const refMapAfter = JSON.stringify(refRowsSecond.map(row => [row.token, row.taskId, row.createdAt]).sort())
  record('二次打开：任务/消息/引用数不变',
    secondCounts.tasks === postCounts.tasks
    && secondCounts.messages === postCounts.messages
    && secondCounts.task_refs === postCounts.task_refs,
    { first: postCounts, second: secondCounts })
  record('二次打开：token/task_id/created_at 完全一致（无重复生成）', refMapBefore === refMapAfter,
    { first: refRows.length, second: refRowsSecond.length })
  record('二次打开：integrity_check = ok', integrity(db) === 'ok', integrity(db))

  // 7) 删除任务 → 墓碑（在第三份副本上做，不污染前两份证据）
  const deletionDir = makeTempDir('ledger-delete')
  copyFileSync(copyPath, join(deletionDir, 'tasks.sqlite'))
  const delDb = await openLedger(deletionDir)
  const victimRow = delDb.prepare(`SELECT id FROM tasks WHERE status IN ('cancelled','done','failed') ORDER BY created_at DESC LIMIT 1`).get()
  const victimId = victimRow === undefined ? null : String(victimRow.id)
  let tombstone = null
  if (victimId !== null) {
    const victimRef = taskRefOf(delDb, victimId)
    deleteTask(delDb, victimId)
    tombstone = {
      victimId,
      victimRef,
      taskGone: delDb.prepare('SELECT 1 AS ok FROM tasks WHERE id = ?').get(victimId) === undefined,
      refOfDeleted: taskRefOf(delDb, victimId),
      resolveByRef: victimRef === null ? null : resolveTaskInput(delDb, victimRef),
      resolveById: resolveTaskInput(delDb, victimId),
      row: delDb.prepare('SELECT retired_at FROM task_refs WHERE task_id = ?').get(victimId)
    }
  }
  delDb.close()
  const reopenedDel = await openLedger(deletionDir)
  const refAfterReopen = tombstone?.victimId === null || tombstone?.victimId === undefined
    ? null
    : reopenedDel.prepare('SELECT token, retired_at FROM task_refs WHERE task_id = ?').get(tombstone.victimId)
  const taskStillGone = tombstone?.victimId === null || tombstone?.victimId === undefined
    ? null
    : reopenedDel.prepare('SELECT 1 AS ok FROM tasks WHERE id = ?').get(tombstone.victimId) === undefined
  reopenedDel.close()
  record('删除任务后引用置墓碑（不再可解析）',
    tombstone !== null
    && tombstone.taskGone
    && tombstone.refOfDeleted === null
    && tombstone.resolveByRef?.ok === false
    && tombstone.resolveByRef?.reason === 'retired'
    && tombstone.resolveById?.ok === false
    && tombstone.resolveById?.reason === 'not-found'
    && tombstone.row?.retired_at !== null,
    tombstone)
  record('墓碑行重开台账后不被补回、任务不复活',
    tombstone !== null
    && refAfterReopen !== undefined
    && refAfterReopen.retired_at !== null
    && taskStillGone === true,
    { refAfterReopen })

  // 8) 源库最终校验
  const afterHashes = dbHashes(SRC_DB_DIR)
  const afterStat = { size: statSync(SRC_DB).size, mtimeMs: statSync(SRC_DB).mtimeMs }
  record('原库 sha256 前后一致（只读不动）',
    JSON.stringify(beforeHashes) === JSON.stringify(afterHashes),
    { before: beforeHashes, after: afterHashes, beforeStat, afterStat })

  const failed = results.filter(item => !item.ok)
  const evidence = {
    generatedAt: new Date().toISOString(),
    source: { path: SRC_DB, hashesBefore: beforeHashes, hashesAfter: afterHashes, statBefore: beforeStat, statAfter: afterStat, snapshot, liveCounts: sourceCounts, liveMaxSeq: sourceMaxSeq, liveMaxTask: sourceMaxTask },
    upgradeDir,
    before: { counts: preCounts, tables: preTables, planPathColumn: prePlanPath },
    after: { counts: postCounts, tables: tableNames(db), planPathColumn: planPathColumn(db), integrity: integrity(db) },
    refs: { total: refRows.length, retired: retiredCount, dupTokens, dupTaskIds, tasksWithoutRef: tasksWithoutRef.length, refsWithoutTask: refsWithoutTask.length },
    legacySamples: legacyChecks,
    idempotency: { first: postCounts, second: secondCounts, identicalRefs: refMapBefore === refMapAfter },
    tombstone,
    results,
    pass: results.length - failed.length,
    fail: failed.length
  }
  db.close()
  writeFileSync(join(EVIDENCE_DIR, 'ledger-upgrade.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  if (!KEEP) {
    for (const dir of cleanupTargets) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
    }
  } else {
    console.log(`[info] --keep：临时目录保留：${cleanupTargets.join(', ')}`)
  }
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAIL`} (${results.length} checks)`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
