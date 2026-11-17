// 产物位置唯一判据（artifact-location）：已登记产物可读、未登记仍拒、符号链接不放行。
//
// 这一组锁的是**审计 §2.1 方案 C** 的三条边界（改之前先读 src/artifact-location.js 文件头）：
//   1. 登记表不扩大读取面——只有被任务登记过的路径可读，同目录的未登记文件仍被拒；
//   2. 登记表不借符号链接放行——登记一个指向别处的链接不等于登记了它的真实路径；
//   3. 已登记目录放开子树（产物可以是目录），已登记文件只放开它自己。
// 另外锁住「存量产物兼容」：target 目录下的产物不需要迁移数据、不需要改 WRITE_HINT，登记后立刻可读。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deliverableOf, isInside, isRegisteredArtifact, registeredArtifacts, registeredMatch,
} from '../src/artifact-location.js'
import { readWorkspaceFile, renderWorkspaceRead, resolveWorkspaceTarget } from '../src/read-workspace.js'
import { createTools } from '../src/tools.js'
import { createTask, openLedger, setTaskArtifacts, transition } from '../src/ledger.js'
import { createQueue } from '../src/queue.js'
import { tempDir, sampleBrief } from './helpers.js'

/**
 * 「主会话工作区 + 任务 target 目录（工作区外）」两处布局：
 * 复现真实台账的 78.7%——产物落在 target 里，工作区里没有它。
 */
function locationFixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'orch-loc-ws-'))
  const target = mkdtempSync(join(tmpdir(), 'orch-loc-target-'))
  mkdirSync(join(workspace, 'reports'), { recursive: true })
  mkdirSync(join(target, 'reports'), { recursive: true })
  mkdirSync(join(target, 'diag'), { recursive: true })
  writeFileSync(join(workspace, 'reports', 'plan.md'), '# 工作区里的计划\n', 'utf8')
  writeFileSync(join(target, 'reports', 'preference-mechanism-plan.md'), '# 偏好机制方案\n\n正文\n', 'utf8')
  writeFileSync(join(target, 'reports', 'unregistered.md'), '# 没登记过的文件\n', 'utf8')
  writeFileSync(join(target, 'diag', 'snap.json'), '{"ok":true}\n', 'utf8')
  const secretDir = mkdtempSync(join(tmpdir(), 'orch-loc-secret-'))
  writeFileSync(join(secretDir, 'secret.yaml'), 'token: should-never-be-read\n', 'utf8')
  return { workspace, target, secretDir }
}

const taskRow = (id, artifacts) => ({ id, artifacts })

test('已登记产物可读：target 目录下（工作区外）的文件按真实路径放行', () => {
  const { workspace, target } = locationFixture()
  const registered = registeredArtifacts([taskRow('t-1', [{ path: join(target, 'reports', 'preference-mechanism-plan.md') }])])
  const read = readWorkspaceFile({ root: workspace, path: join(target, 'reports', 'preference-mechanism-plan.md'), registered })
  assert.equal(read.ok, true)
  assert.equal(read.via, 'registered')
  assert.equal(read.artifact.taskId, 't-1')
  assert.match(read.text, /偏好机制方案/)
  // 头行说清「凭什么可读」，别让人以为它突然在工作区里了。
  assert.match(renderWorkspaceRead(read), /【已登记产物文件】/)
  assert.match(renderWorkspaceRead(read), /任务 t-1 登记/)
})

test('未登记的同一目录文件仍被拒：登记表不放宽目录', () => {
  const { workspace, target } = locationFixture()
  const registered = registeredArtifacts([taskRow('t-1', [{ path: join(target, 'reports', 'preference-mechanism-plan.md') }])])
  const denied = readWorkspaceFile({ root: workspace, path: join(target, 'reports', 'unregistered.md'), registered })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /越界被拒绝/)
  assert.match(denied.error, /已登记的产物/)
  assert.doesNotMatch(denied.error, /没登记过的文件/)
  // 没有登记表（旧调用方式）时行为与 0.19.x 一致：仍然拒绝。
  const legacy = readWorkspaceFile({ root: workspace, path: join(target, 'reports', 'preference-mechanism-plan.md') })
  assert.equal(legacy.ok, false)
  assert.match(legacy.error, /越界被拒绝/)
})

test('登记表里的符号链接仍被拒：不放行真实路径，也不放行链接本身', () => {
  const { workspace, target, secretDir } = locationFixture()
  const link = join(target, 'reports', 'link-out.yaml')
  symlinkSync(join(secretDir, 'secret.yaml'), link)
  // 即使台账里登记的就是这个链接路径，也不能借它读到工作区外的真实文件。
  const registered = registeredArtifacts([taskRow('t-1', [{ path: link }])])
  assert.equal(registered.files.size, 0, '符号链接不登记真实路径')
  const denied = readWorkspaceFile({ root: workspace, path: link, registered })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /越界被拒绝|读不到/)
  assert.doesNotMatch(denied.error, /should-never-be-read/)
  // 指向**已登记文件**的链接：真实路径命中登记表，允许（判据看真实路径，不看「是不是链接」）。
  const inside = join(target, 'reports', 'link-in.md')
  symlinkSync(join(target, 'reports', 'preference-mechanism-plan.md'), inside)
  const withFile = registeredArtifacts([taskRow('t-1', [{ path: join(target, 'reports', 'preference-mechanism-plan.md') }])])
  const ok = readWorkspaceFile({ root: workspace, path: inside, registered: withFile })
  assert.equal(ok.ok, true)
  assert.match(ok.text, /偏好机制方案/)
})

test('已登记目录放开子树（产物可以是目录），未登记目录下的文件仍被拒', () => {
  const { workspace, target } = locationFixture()
  const registered = registeredArtifacts([taskRow('t-1', [{ path: join(target, 'diag') }])])
  const ok = readWorkspaceFile({ root: workspace, path: join(target, 'diag', 'snap.json'), registered })
  assert.equal(ok.ok, true)
  assert.equal(ok.via, 'registered')
  assert.equal(ok.artifact.viaDir, realpathSync(join(target, 'diag')))
  // 目录本身也能读（列一层条目），且条目标签是「已登记产物目录」。
  const listed = readWorkspaceFile({ root: workspace, path: join(target, 'diag'), registered })
  assert.equal(listed.ok, true)
  assert.equal(listed.kind, 'directory')
  assert.match(renderWorkspaceRead(listed), /【已登记产物目录】/)
  // 目录里的符号链接指向未登记位置 → 条目标 readable:false（标记与真实判定同源）。
  const outside = mkdtempSync(join(tmpdir(), 'orch-loc-out-'))
  writeFileSync(join(outside, 'x.txt'), 'x', 'utf8')
  symlinkSync(join(outside, 'x.txt'), join(target, 'diag', 'link-out.txt'))
  const relisted = readWorkspaceFile({ root: workspace, path: join(target, 'diag'), registered })
  const entry = relisted.items.find(item => item.name === 'link-out.txt')
  assert.equal(entry.readable, false)
  assert.equal(readWorkspaceFile({ root: workspace, path: join(target, 'diag', 'link-out.txt'), registered }).ok, false)
})

test('工作区包含性优先：工作区内的路径仍标 via:workspace（原行为不变）', () => {
  const { workspace, target } = locationFixture()
  const registered = registeredArtifacts([taskRow('t-1', [{ path: join(target, 'reports', 'preference-mechanism-plan.md') }])])
  const read = readWorkspaceFile({ root: workspace, path: 'reports/plan.md', registered })
  assert.equal(read.ok, true)
  assert.equal(read.via, 'workspace')
  assert.match(renderWorkspaceRead(read), /【工作区文件】/)
  // 工作区内的路径不需要登记表也照样可读。
  assert.equal(readWorkspaceFile({ root: workspace, path: 'reports/plan.md' }).ok, true)
})

test('已登记但已缺失的产物：报「不存在」，不报越界（避免误导）', () => {
  const { workspace, target } = locationFixture()
  const gone = join(target, 'reports', 'gone.md')
  // 台账里登记过、文件后来被删：不可读（不进 files），但登记表记住它曾登记过。
  const registered = registeredArtifacts([taskRow('t-1', [{ path: gone }])])
  assert.equal(registered.files.size, 0)
  assert.equal(registered.missing.size, 1)
  const denied = readWorkspaceFile({ root: workspace, path: gone, registered })
  assert.equal(denied.ok, false)
  // 关键：文案说「不存在 + 已登记但被删」，而不是「越界（未登记）」——后者会让模型以为权限不够。
  assert.match(denied.error, /不存在/)
  assert.match(denied.error, /已登记/)
  assert.doesNotMatch(denied.error, /越界被拒绝/)
  // 从没登记过的工作区外缺失路径 → 越界（这是真的越界，不是产物被删）。
  const outside = readWorkspaceFile({ root: workspace, path: join(target, 'reports', 'never.md'), registered })
  assert.match(outside.error, /越界被拒绝/)
  // 工作区内缺失 → 不存在。
  assert.match(readWorkspaceFile({ root: workspace, path: 'reports/nope.md', registered }).error, /不存在/)
})

test('registeredMatch / isRegisteredArtifact：文件命中自己、目录命中子树、其余不命中', () => {
  const { target } = locationFixture()
  const file = join(target, 'reports', 'preference-mechanism-plan.md')
  const registered = registeredArtifacts([taskRow('t-9', [{ path: file, label: '方案' }])])
  assert.deepEqual(registeredMatch(file, registered), { taskId: 't-9', label: '方案' })
  assert.equal(isRegisteredArtifact(join(target, 'reports', 'unregistered.md'), registered), false)
  assert.equal(isRegisteredArtifact(file, undefined), false)
  assert.equal(registeredMatch('', registered), undefined)
  // 非绝对路径的登记项一律忽略（台账里历史行可能是相对路径）。
  const relative = registeredArtifacts([taskRow('t-2', [{ path: 'reports/x.md' }])])
  assert.equal(relative.files.size, 0)
})

test('deliverableOf：present 的类型判定（普通文件/目录/链接/缺失/相对路径）', () => {
  const { target } = locationFixture()
  const file = join(target, 'reports', 'preference-mechanism-plan.md')
  assert.equal(deliverableOf(file), 'file')
  assert.equal(deliverableOf(join(target, 'reports')), 'directory')
  assert.equal(deliverableOf(join(target, 'reports', 'nope.md')), 'missing')
  assert.equal(deliverableOf('reports/plan.md'), 'relative')
  assert.equal(deliverableOf(''), 'other')
  const link = join(target, 'reports', 'link-deliver.md')
  symlinkSync(file, link)
  assert.equal(deliverableOf(link), 'symlink')
})

test('isInside：等值算在内，父目录/前缀相似目录不算', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a'), false)
})

// ---- 工具层：台账登记 → read_workspace 可读（端到端） ----

async function toolFixture() {
  const { workspace, target, secretDir } = locationFixture()
  const db = await openLedger(tempDir())
  const events = []
  const queue = createQueue({ db, dispatcher: { async spawn() { throw new Error('不应派发') } }, config: {} })
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher: {},
    queue,
    notifier: { push() {} },
    config: {},
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    defaultCwd: () => workspace,
    logger: { log: (event, fields) => events.push([event, fields]) },
  }).map(tool => [tool.name, tool]))
  return { workspace, target, secretDir, db, tools, events }
}

test('read_workspace 能读台账登记过的 target 产物（端到端），审计日志标 via:registered', async () => {
  const { db, tools, events, target } = await toolFixture()
  const artifact = join(target, 'reports', 'preference-mechanism-plan.md')
  const task = createTask(db, { brief: sampleBrief({ title: '规划偏好机制' }), coordinatorSession: 's-1', targetDir: target })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  setTaskArtifacts(db, task.id, [{ path: artifact, label: '方案' }])

  const text = await tools.read_workspace.execute({ path: artifact }, { agent: { id: 's-1' } })
  assert.match(text, /【已登记产物文件】/)
  assert.match(text, /偏好机制方案/)
  const read = events.filter(([event]) => event === 'workspace.read')
  assert.equal(read.length, 1)
  assert.equal(read[0][1].detail.via, 'registered')
  assert.equal(read[0][1].detail.artifactTaskId, task.id)
  // 审计日志不记正文。
  assert.equal(JSON.stringify(read[0][1].detail).includes('偏好机制方案'), false)

  // 同一目录里没登记的文件仍然被拒，且写审计日志。
  const denied = await tools.read_workspace.execute({ path: join(target, 'reports', 'unregistered.md') }, { agent: { id: 's-1' } })
  assert.match(denied, /读取失败/)
  assert.match(denied, /越界被拒绝/)
  assert.equal(events.filter(([event]) => event === 'workspace.read.rejected').length, 1)
  db.close()
})

test('存量产物兼容：登记表为空时工作区路径照旧、target 路径照旧被拒（不静默放宽）', async () => {
  const { db, tools, target } = await toolFixture()
  assert.match(await tools.read_workspace.execute({ path: 'reports/plan.md' }, { agent: { id: 's-1' } }), /工作区里的计划/)
  assert.match(
    await tools.read_workspace.execute({ path: join(target, 'reports', 'preference-mechanism-plan.md') }, { agent: { id: 's-1' } }),
    /越界被拒绝/,
  )
  db.close()
})

test('工具描述不再声称「子会话产物常落在工作区 reports/」', async () => {
  const { db, tools } = await toolFixture()
  const description = tools.read_workspace.description
  assert.doesNotMatch(description, /常落在 reports/)
  assert.match(description, /已登记产物/)
  db.close()
})

test('存量台账抽样：所有仍然存在的已登记产物都可读（真实数据兼容性）', () => {
  // 用宿主真实台账抽样（CI/无台账时跳过）：这是「78.7% → 100%」的回归证据。
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const dbPath = join(home, 'state', 'orchestrator', 'tasks.sqlite')
  if (!existsSync(dbPath)) return
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  const rows = raw.prepare('SELECT id, artifacts_json FROM tasks WHERE artifacts_json IS NOT NULL').all()
  raw.close()
  const tasks = rows.map(row => ({ id: row.id, artifacts: JSON.parse(row.artifacts_json) }))
  const registered = registeredArtifacts(tasks)
  const workspace = join(home, 'state', 'orchestrator', 'workspace')
  let total = 0
  let readable = 0
  for (const task of tasks) {
    for (const item of task.artifacts) {
      if (typeof item?.path !== 'string' || !existsSync(item.path)) continue
      total += 1
      if (readWorkspaceFile({ root: workspace, path: item.path, registered }).ok === true) readable += 1
    }
  }
  if (total === 0) return
  assert.equal(readable, total, `存量产物应全部可读（${readable}/${total}）`)
})
