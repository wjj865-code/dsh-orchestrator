// 台账快照：每天一份 VACUUM INTO 的完整副本，保留最近 N 天。
// 只读目录、只新增快照，不改台账；失败由调用方降级成 warn，不能影响主流程。
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SNAPSHOT_FILE = /^tasks-(\d{4})-(\d{2})-(\d{2})\.sqlite$/
const DAY_MS = 86_400_000
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

const pad = value => String(value).padStart(2, '0')
const dayKey = now => {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const sqlString = value => `'${String(value).replace(/'/g, "''")}'`

/**
 * 生成当天快照；同一天已存在就复用，不覆盖。
 * @returns {{path: string, created: boolean, pruned: string[]}}
 */
export function takeDailySnapshot(db, stateDir, { now = Date.now(), retentionDays = 7 } = {}) {
  const dir = join(stateDir, 'snapshots')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `tasks-${dayKey(now)}.sqlite`)
  let created = false
  if (!existsSync(path)) {
    // VACUUM INTO 要求目标文件不存在；WAL 模式下会先做一致性检查点。
    try {
      db.exec(`VACUUM INTO ${sqlString(path)}`)
      created = true
    } catch (error) {
      // 并发调用时另一端可能刚好生成了同一份快照；文件存在就算成功。
      if (!existsSync(path)) throw error
    }
  }

  // 只清理自己命名的快照；README/手工文件等一律不动。
  const keepDays = Number.isFinite(retentionDays) && retentionDays > 0 ? Math.floor(retentionDays) : 7
  const cutoff = now - keepDays * DAY_MS
  const pruned = []
  for (const name of readdirSync(dir)) {
    const match = SNAPSHOT_FILE.exec(name)
    if (match === null) continue
    const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
    if (!Number.isFinite(at) || at >= cutoff) continue
    try {
      rmSync(join(dir, name))
      pruned.push(name)
    } catch { /* 单个旧快照删不掉不影响新快照 */ }
  }
  return { path, created, pruned }
}

/**
 * 启动时立即快照一次，之后每 intervalMs 检查一次（通常一天内跨日时再生成）。
 * 返回同步清理函数；定时器 unref，不阻止进程退出。
 */
export function startSnapshotLoop(db, stateDir, {
  retentionDays = 7,
  intervalMs = DEFAULT_INTERVAL_MS,
  onCreated = () => {},
  onError = () => {},
} = {}) {
  const run = () => {
    try {
      const result = takeDailySnapshot(db, stateDir, { retentionDays })
      if (result.created) onCreated(result)
    } catch (error) {
      onError(error)
    }
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
