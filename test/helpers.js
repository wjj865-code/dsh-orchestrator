import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/** 目录链接用例不可用时给用户的跳过原因：同样必须说清「为什么没真跑」。 */
export const DIRECTORY_LINK_SKIP_REASON = '需要目录链接能力（真符号链接与 Windows junction 都造不出来）：跳过这条目录链接用例，CI/有权限环境仍会真跑'

let directoryLinkSupport

/**
 * 目录级链接能力探测：先试**真符号链接**，没有权限时退到 **Windows junction**（目录联接，普通用户即可创建）。
 *
 * 为什么要分级：`canCreateFileSymlink()` 探测的是**文件**符号链接——Windows 未开「开发者模式」时
 * 普通用户没有 SeCreateSymbolicLinkPrivilege，那条探测必假。但只会「拿链接当路径别名」的用例其实
 * 只需要一条**目录**链接，而 junction 不需要任何特权；Node 对 junction 的 `lstat` 同样报
 * `isSymbolicLink() === true`、`realpath` 同样解析到真实目录（Node 22 实测），所以
 * 「按真实路径核验/链接不得当普通文件」这些不变量在 junction 上照样成立，不该整条 skip。
 *
 * 能力成不成立即缓存进进程（每进程只试一次），探测目录用完即删。
 * @returns {'symlink'|'junction'|undefined} 真符号链接 / Windows 目录联接 / 都不可用
 */
export function directoryLinkKind() {
  if (directoryLinkSupport !== undefined) return directoryLinkSupport
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-dirlink-probe-'))
  const target = join(dir, 'probe-target')
  try {
    mkdirSync(target)
    try {
      symlinkSync(target, join(dir, 'probe-symlink'))
      directoryLinkSupport = 'symlink'
    } catch {
      try {
        symlinkSync(target, join(dir, 'probe-junction'), process.platform === 'win32' ? 'junction' : 'dir')
        directoryLinkSupport = 'junction'
      } catch {
        directoryLinkSupport = undefined
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return directoryLinkSupport
}

export const canCreateDirectoryLink = () => directoryLinkKind() !== undefined

/**
 * 造一条目录链接（真符号链接优先，否则 junction）。能力都没有时返回 `undefined`，交调用方 `t.skip(理由)`。
 * @returns {'symlink'|'junction'|undefined} 实际造出来的类型
 */
export function linkDirectory(target, link) {
  const kind = directoryLinkKind()
  if (kind === undefined) return undefined
  if (kind === 'symlink') symlinkSync(target, link)
  else symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  return kind
}

/**
 * 轮询等一个异步链路落地：条件成立即返回，超时抛错（**不是**静默放过）。
 *
 * 为什么不用固定 `await wait(50)`：结算链路里要 spawn `git` 收产物（Windows 上一次几十到上百毫秒，
 * 慢机器更久），固定等待是把「机器够快」当成断言前提——本地必红、CI 只是碰巧过。
 * 谓词只放**弱于断言**的前置条件（如「状态已离开 running」「字段已落库」），真正的等值/文案断言
 * 仍写在轮询之后，别把断言挪进谓词（那样谓词一失败就只剩一句超时，看不出错在哪）。
 *
 * @param {() => unknown | Promise<unknown>} predicate 返回真值即认为落地
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
 */
export async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 10, label = '等待条件成立' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ready = await predicate()
    if (ready) return ready
    if (Date.now() >= deadline) throw new Error(`${label}：轮询 ${timeoutMs}ms 仍未成立`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
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
