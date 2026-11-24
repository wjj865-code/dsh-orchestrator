import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTask, transition } from '../src/ledger.js'
import { createSettlementReporter } from '../src/settlement.js'
import { createArtifactDelivery } from '../src/artifact-delivery.js'
import { canTransition } from '../src/state.js'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'orchestrator-'))

/** 既有场景显式模拟回合结束；artifact-delivery.test 验证结束前不交付。 */
export function endReportedTurn(db, { taskId, notifier, dispatcher, queue, workspaceChanges, session, mainDir, goalBridge, sender } = {}) {
  const task = getTask(db, taskId)
  if (!task?.delivery_pending) return Promise.resolve()
  const cwd = task.target_dir ?? task.brief?.inheritedTarget ?? mainDir ?? tempDir()
  const delivery = createArtifactDelivery({
    db,
    settlement: createSettlementReporter({
      db, notifier, releaseSession: id => dispatcher?.releaseWritableRoots?.(id),
      senderOf: () => sender,
      pump: () => queue?.pump(), onTerminal: t => goalBridge?.complete?.(t.id, t.session_id),
    }),
    sessionOf: () => session ?? { id: task.session_id, events: [{ type: 'workspace/changes', seq: 1 }] },
    workspaceChanges: () => workspaceChanges ?? { summary: () => ({ cwd, files: [] }) },
    mainDir: () => mainDir ?? cwd,
  })
  return delivery.report({ taskId, sessionId: task.session_id, stopReason: 'completed', source: 'test-turn-end' })
}

/** 符号链接用例不可用时给用户的跳过原因：必须说清「为什么没跑」，不许静默 pass。 */
export const SYMLINK_SKIP_REASON = '需要符号链接权限（当前环境无法创建文件符号链接，如 Windows 未开开发者模式）：跳过这条符号链接用例，CI/有权限环境仍会真跑'

/**
 * 文件符号链接能力探测：临时目录里真造一条链接，成不成立即缓存进进程（每进程只试一次）。
 *
 * 为什么要它：Windows 未开「开发者模式」时普通用户没有 SeCreateSymbolicLinkPrivilege，
 * `symlinkSync` 直接 EPERM——那是环境限制，不是被测代码的问题，判失败会让本地测试永远红。
 * 探测失败只影响调用方（链接相关用例 t.skip），其余用例照跑；探测目录用完即删，不留垃圾。
 */
let fileSymlinkSupport

export function canCreateFileSymlink() {
  if (fileSymlinkSupport !== undefined) return fileSymlinkSupport
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-symlink-probe-'))
  try {
    writeFileSync(join(dir, 'probe-target.txt'), 'probe\n', 'utf8')
    symlinkSync(join(dir, 'probe-target.txt'), join(dir, 'probe-link.txt'))
    fileSymlinkSupport = true
  } catch {
    fileSymlinkSupport = false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return fileSymlinkSupport
}

/** 管道 spawn 用例不可用时给用户的跳过原因：同样必须说清「为什么没真跑」。 */
export const PIPE_SPAWN_SKIP_REASON = '需要「带管道 spawn 子进程」的能力（当前沙箱禁止打开命名管道，spawn/execFile 传 stdio:"pipe" 直接 EPERM）：跳过 `node --check 产物` 这条用例，正常环境/CI 仍会真跑'

/**
 * 管道 spawn 能力探测：真起一个只退出的 node 子进程，**用 stdio:'pipe' 捕获它的输出**——
 * 这正是 `node --check` 那条用例需要的形态，能力成不成立即缓存进进程（每进程只试一次）。
 *
 * 为什么要它：DSH 的受限沙箱禁止子进程打开命名管道，`execFileSync(..., { stdio: 'pipe' })`
 * 直接 `EPERM`（不是被测代码的问题）。判失败会让「沙箱里的 pnpm test」永远红；探测失败只让调用方
 * `t.skip(理由)`，能力可用的环境（本地全权 / CI）照常真跑。
 */
let pipeSpawnSupport

export function canSpawnWithPipes() {
  if (pipeSpawnSupport !== undefined) return pipeSpawnSupport
  try {
    // spawnSync 对 EPERM 不抛，落在 result.error 上：既要没有 error，也要真的跑完（status 0）。
    const result = spawnSync(process.execPath, ['-e', ''], { stdio: 'pipe', timeout: 30_000 })
    pipeSpawnSupport = result?.error === undefined && result?.status === 0
  } catch {
    pipeSpawnSupport = false
  }
  return pipeSpawnSupport
}

export function sampleBrief(overrides = {}) {
  return {
    title: 't', goal: 'g', constraints: [], acceptance: ['a'], refs: [], ...overrides,
  }
}

/**
 * 测试用「把任务推到 done」：走**合法**转移路径，而不是 `transition(id,'done')` 一步到位。
 *
 * 为什么需要它：`running → done` 在 0.14.0 引入两段式终态后就不可达了（审计 §2.3.3），
 * 0.19.x 的测试夹具却大量用它走捷径——这正是「测试锁死死代码」的实例。删边后夹具统一走
 * `… → delivered → done`，既合法又顺带覆盖交付主路径。
 */
const DONE_PATH = {
  waiting_dep: ['pending', 'running', 'delivered', 'done'],
  pending: ['running', 'delivered', 'done'],
  running: ['delivered', 'done'],
  waiting_user: ['running', 'delivered', 'done'],
  waiting_auth: ['running', 'delivered', 'done'],
  delivered: ['done'],
  done: [],
}

export function markDone(db, id) {
  let task = getTask(db, id)
  if (task === undefined) throw new Error(`markDone：任务不存在 ${id}`)
  const path = DONE_PATH[task.status]
  if (path === undefined) throw new Error(`markDone：状态 ${task.status} 不能到 done`)
  for (const to of path) {
    if (task.status === to) continue
    if (!canTransition(task.status, to)) throw new Error(`markDone：不允许 ${task.status} → ${to}`)
    task = transition(db, id, to)
  }
  return task
}
