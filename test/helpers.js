import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTask, transition } from '../src/ledger.js'
import { canTransition } from '../src/state.js'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'orchestrator-'))

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
