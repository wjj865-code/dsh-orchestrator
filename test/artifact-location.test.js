// 产物位置唯一判据（artifact-location）：已登记产物可读、未登记仍拒、符号链接不放行。
//
// 这一组锁的是**审计 §2.1 方案 C** 的三条边界（改之前先读 src/artifact-location.js 文件头）：
//   1. 登记表不扩大读取面——只有被任务登记过的路径可读，同目录的未登记文件仍被拒；
//   2. 登记表不借符号链接放行——登记一个指向别处的链接不等于登记了它的真实路径；
//   3. 已登记目录放开子树（产物可以是目录），已登记文件只放开它自己。
// 另外锁住「存量产物兼容」：target 目录下的产物不需要迁移数据、不需要改 WRITE_HINT，登记后立刻可读。
// 最后区分两种「不可读」：**读取面缺口**（越界/未登记，是权限问题）与**体积拒绝**（内容超 4MB，
// 是内容问题）——后者在存量抽样里允许出现，但绝不能被当成前者（文案与统计都分开）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deliverableOf, isInside, isRegisteredArtifact, registeredArtifacts, registeredMatch,
} from '../src/artifact-location.js'
import { MAX_FILE_BYTES, readWorkspaceFile, renderWorkspaceRead, resolveWorkspaceTarget } from '../src/read-workspace.js'
import { createTools } from '../src/tools.js'
import { createTask, openLedger, setTaskArtifacts, transition } from '../src/ledger.js'
import { createQueue } from '../src/queue.js'
import { canCreateFileSymlink, sampleBrief, SYMLINK_SKIP_REASON, tempDir } from './helpers.js'

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

const taskRow = (id, artifacts, ref = undefined) => ({ id, artifacts, ...(ref === undefined ? {} : { ref }) })

/**
 * 「体积类拒绝」的唯一判据：ok:false 且原因是文件过大。
 *
 * 产品代码没有单独的 `reason` 字段，体积拒绝在文案里以「文件过大」表达（src/read-workspace.js）。
 * 测试统一走这个判定，避免各处自己正则——两种拒绝（读取面缺口 vs 内容太大）必须分开说。
 */
const isOversizeRejection = read => read?.ok === false && /文件过大/.test(read.error ?? '')

test('已登记产物可读：target 目录下（工作区外）的文件按真实路径放行', () => {
  const { workspace, target } = locationFixture()
  const registered = registeredArtifacts([taskRow('t-1', [{ path: join(target, 'reports', 'preference-mechanism-plan.md') }], 'tk-000001')])
  const read = readWorkspaceFile({ root: workspace, path: join(target, 'reports', 'preference-mechanism-plan.md'), registered })
  assert.equal(read.ok, true)
  assert.equal(read.via, 'registered')
  assert.equal(read.artifact.taskId, 't-1')
  assert.match(read.text, /偏好机制方案/)
  // 头行说清「凭什么可读」，别让人以为它突然在工作区里了。
  assert.match(renderWorkspaceRead(read), /【已登记产物文件】/)
  // 版本 B：归属只写任务引用（tk-），不写裸编号。
  assert.match(renderWorkspaceRead(read), /任务 tk-000001 登记/)
  assert.doesNotMatch(renderWorkspaceRead(read), /\bt-1\b/)
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

test('登记表里的符号链接仍被拒：不放行真实路径，也不放行链接本身', t => {
  // 整条用例靠真链接才能验：没有符号链接权限的环境（Windows 未开开发者模式）只跳过它，不判失败。
  if (!canCreateFileSymlink()) return t.skip(SYMLINK_SKIP_REASON)
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

test('已登记目录放开子树（产物可以是目录），未登记目录下的文件仍被拒', t => {
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
  // 尾段要给目录里造一条指向未登记的链接：环境不支持文件链接时只跳过这一段（前面的断言已跑过），
  // 不把整条用例判失败，也不假装验过。
  if (!canCreateFileSymlink()) return t.skip(SYMLINK_SKIP_REASON)
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
  const registered = registeredArtifacts([taskRow('t-9', [{ path: file, label: '方案' }], 'tk-000009')])
  assert.deepEqual(registeredMatch(file, registered), { taskId: 't-9', ref: 'tk-000009', label: '方案' })
  assert.equal(isRegisteredArtifact(join(target, 'reports', 'unregistered.md'), registered), false)
  assert.equal(isRegisteredArtifact(file, undefined), false)
  assert.equal(registeredMatch('', registered), undefined)
  // 非绝对路径的登记项一律忽略（台账里历史行可能是相对路径）。
  const relative = registeredArtifacts([taskRow('t-2', [{ path: 'reports/x.md' }])])
  assert.equal(relative.files.size, 0)
})

test('deliverableOf：present 的类型判定（普通文件/目录/链接/缺失/相对路径）', t => {
  const { target } = locationFixture()
  const file = join(target, 'reports', 'preference-mechanism-plan.md')
  assert.equal(deliverableOf(file), 'file')
  assert.equal(deliverableOf(join(target, 'reports')), 'directory')
  assert.equal(deliverableOf(join(target, 'reports', 'nope.md')), 'missing')
  assert.equal(deliverableOf('reports/plan.md'), 'relative')
  assert.equal(deliverableOf(''), 'other')
  // 「链接」那一支要真造一条链接：无权限环境只跳过这一段，前面的普通文件/目录/缺失判定照跑。
  if (!canCreateFileSymlink()) return t.skip(SYMLINK_SKIP_REASON)
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

test('已登记的超大产物：按体积拒绝，不判成读取面缺口（越界/未登记）', () => {
  const { workspace, target } = locationFixture()
  const big = join(target, 'reports', 'big-report.json')
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  const registered = registeredArtifacts([taskRow('t-big', [{ path: big }])])
  // 登记表认这条产物：读取面是通的。所以拒绝只能来自体积，不能被说成「未登记/越界」——
  // 后者会把「产物太大」误导成「权限不够」，让人去翻登记表而不是去缩产物。
  assert.equal(isRegisteredArtifact(big, registered), true)
  const denied = readWorkspaceFile({ root: workspace, path: big, registered })
  assert.equal(isOversizeRejection(denied), true)
  assert.match(denied.error, /上限/)
  assert.doesNotMatch(denied.error, /越界被拒绝|未登记|读取面缺口/)
  // 同一登记项、同一路径，只是变小到上限内 → 立刻可读（证明拒绝的是体积，不是读取面）。
  writeFileSync(big, '{"ok":true}\n', 'utf8')
  const read = readWorkspaceFile({ root: workspace, path: big, registered })
  assert.equal(read.ok, true)
  assert.equal(read.via, 'registered')
  assert.match(read.text, /"ok":true/)
})

test('存量台账抽样：已登记产物要么可读、要么只按体积拒（真实数据兼容性）', () => {
  // 用宿主真实台账抽样（CI/无台账时跳过）：这是「78.7% → 100%」的回归证据。
  //
  // 判据分两档，两种「不可读」必须分开（宿主大产物不该把读取面回归测红）：
  //   1. 体积 > MAX_FILE_BYTES：允许 ok:false，但原因必须且只能是体积类；
  //   2. 其余（含上限内的全部产物）：必须 ok:true——任何「越界/未登记/不存在」都算读取面回归。
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
  let oversized = 0
  const unexpected = []
  for (const task of tasks) {
    for (const item of task.artifacts) {
      if (typeof item?.path !== 'string' || !existsSync(item.path)) continue
      total += 1
      const read = readWorkspaceFile({ root: workspace, path: item.path, registered })
      if (read.ok === true) {
        readable += 1
        continue
      }
      const size = statSync(item.path).size
      if (size > MAX_FILE_BYTES && isOversizeRejection(read)) {
        oversized += 1
        continue
      }
      unexpected.push(`${task.id}｜${item.path}（${size} 字节）｜${read.error}`)
    }
  }
  if (total === 0) return
  assert.deepEqual(
    unexpected,
    [],
    `存量产物应可读、或仅按体积拒绝（可读 ${readable}/${total}，体积拒 ${oversized}）`,
  )
  // 体积拒只可能是「内容太大」，不是「读取面被收窄」：越界/未登记一条都不许有。
  assert.equal(readable + oversized, total)
})
