import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createArtifactDelivery } from '../src/artifact-delivery.js'
import { createSettlementReporter } from '../src/settlement.js'
import { createTools } from '../src/tools.js'
import { createTask, getTask, openLedger, transition, setTaskDeliveryPending } from '../src/ledger.js'
import { closeGate, deleteGate } from '../src/panel-gates.js'
import { tempDir, sampleBrief } from './helpers.js'

test('done 请求保持目录占用；当前回合摘要保存完成后才交付和释放，重复结束幂等', async () => {
  const db = await openLedger(tempDir())
  const cwd = tempDir()
  const file = join(cwd, 'out.txt')
  writeFileSync(file, 'A')
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: cwd })
  transition(db, task.id, 'running', { target: 'child', sessionId: 'child' })
  const released = []
  const notices = []
  const dispatcher = { freezeWork: id => { assert.equal(id, 'child'); return { ok: true } } }
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue: { pump() {} }, notifier: { push() {} }, config: {},
    defaultCwd: () => cwd,
  }).map(t => [t.name, t]))
  const response = await tools.task_report.execute({ task_id: task.id, status: 'done', summary: 'finished', changedFiles: ['out.txt'] }, { agent: { id: 'child' } })
  assert.match(response, /交付请求已记录/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(getTask(db, task.id).delivery_pending.summary, 'finished')
  const session = { id: 'child', events: [{ type: 'workspace/changes', seq: 4 }] }
  const settlement = createSettlementReporter({ db, releaseSession: id => released.push(id), notifier: { push: n => notices.push(n) } })
  const delivery = createArtifactDelivery({
    db, settlement, mainDir: () => cwd, sessionOf: () => session,
    workspaceChanges: () => ({ summary: () => ({ cwd, files: [{ path: 'out.txt' }] }) }),
  })
  const input = { taskId: task.id, stopReason: 'completed' }
  await Promise.all([delivery.report(input), delivery.report(input)])
  const final = getTask(db, task.id)
  assert.equal(final.status, 'delivered')
  assert.equal(final.delivery_pending, null)
  assert.equal(final.artifact_stage.complete, true)
  assert.equal(released.length, 1)
  assert.equal(notices.length, 1)
  writeFileSync(file, 'B')
  assert.equal(readFileSync(final.artifact_stage.files[0].path, 'utf8'), 'A')
  db.close()
})

test('收集中停止不会被重新交付，失败清单可见且不重复通知', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: tempDir() })
  transition(db, task.id, 'running', { sessionId: 'child', target: 'child' })
  setTaskDeliveryPending(db, task.id, { summary: 'finished', changedFiles: ['out.txt'], eventSeq: 1 })
  let finish
  const notices = []
  const delivery = createArtifactDelivery({
    db, settlement: createSettlementReporter({ db, notifier: { push: n => notices.push(n) } }),
    mainDir: tempDir, sessionOf: () => null, workspaceChanges: () => null,
    collect: () => new Promise(resolve => { finish = resolve }),
  })
  const pending = delivery.report({ taskId: task.id, stopReason: 'completed' })
  transition(db, task.id, 'cancelled')
  assert.equal(getTask(db, task.id).delivery_pending.changedFiles[0], 'out.txt')
  assert.equal(deleteGate(getTask(db, task.id)).reason, 'collecting')
  assert.equal(closeGate(getTask(db, task.id)).reason, 'collecting')
  finish()
  await pending
  assert.equal(getTask(db, task.id).status, 'cancelled')
  assert.equal(getTask(db, task.id).delivery_pending, null)
  assert.equal(deleteGate(getTask(db, task.id)).ok, true)
  assert.equal(notices.length, 0)
  db.close()
})

test('停止后重启恢复保留候选信息，恢复结束清 pending 且不重新交付', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: tempDir() })
  transition(db, task.id, 'running', { target: 'child', sessionId: 'child' })
  setTaskDeliveryPending(db, task.id, { changedFiles: ['result.txt'], artifacts: [], eventSeq: 2 })
  transition(db, task.id, 'cancelled')
  let captured
  const delivery = createArtifactDelivery({
    db, settlement: createSettlementReporter({ db }), mainDir: tempDir,
    sessionOf: () => null, workspaceChanges: () => null,
    collect: async args => { captured = args },
  })
  await delivery.report({ taskId: task.id, stopReason: 'error', source: 'startup-recovery' })
  assert.deepEqual(captured.changedFiles, ['result.txt'])
  assert.equal(captured.interrupted, true)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  assert.equal(getTask(db, task.id).delivery_pending, null)
  db.close()
})

test('done 的显式交付超限持久记录到最终清单，不报告完整输入', async () => {
  const db = await openLedger(tempDir())
  const cwd = tempDir()
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: cwd })
  transition(db, task.id, 'running', { sessionId: 'child', target: 'child' })
  writeFileSync(join(cwd, 'report.md'), '# report')
  const tools = Object.fromEntries(createTools({
    db, dispatcher: { freezeWork: () => ({ ok: true }) }, queue: { pump() {} },
    notifier: { push() {} }, config: {}, defaultCwd: () => cwd,
  }).map(tool => [tool.name, tool]))
  await tools.task_report.execute({
    task_id: task.id, status: 'done',
    artifacts: Array.from({ length: 23 }, () => ({ path: 'report.md' })),
  }, { agent: { id: 'child' } })
  assert.equal(getTask(db, task.id).delivery_pending.artifactsOmitted, 3)
  const delivery = createArtifactDelivery({
    db, settlement: createSettlementReporter({ db }), mainDir: () => cwd,
    sessionOf: () => ({ id: 'child', events: [{ type: 'workspace/changes', seq: 5 }] }),
    workspaceChanges: () => ({ summary: () => ({ cwd, files: [] }) }),
  })
  await delivery.report({ taskId: task.id, stopReason: 'completed', eventSeq: 5 })
  const stage = getTask(db, task.id).artifact_stage
  assert.equal(stage.documentsOmitted, 3)
  assert.equal(stage.complete, false)
  assert.equal(JSON.parse(readFileSync(stage.path, 'utf8')).documentsOmitted, 3)
  db.close()
})
