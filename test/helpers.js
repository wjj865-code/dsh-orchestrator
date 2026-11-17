import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTask, transition } from '../src/ledger.js'
import { canTransition } from '../src/state.js'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'orchestrator-'))

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
