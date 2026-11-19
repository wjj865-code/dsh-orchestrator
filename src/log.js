// 结构化日志：$DSH_HOME/state/orchestrator/<subdir>/<prefix>-YYYY-MM-DD.jsonl
// 默认 logs/orchestrator-*（运行日志）；交接契约（P2-3 / src/handoff.js）用 handoff/handoff-*，
// 两边共用同一套「按天分文件 + 超 maxBytes 换新 + 保留 N 天」的实现，避免两份轮转逻辑漂移。
// 写失败只 warn 一次，不影响主流程。
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const pad = value => String(value).padStart(2, '0')
const dateKey = ms => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const truncate = (value, max = 80) => typeof value === 'string' && value.length > max
  ? `${value.slice(0, max)}…`
  : value

const sanitize = detail => {
  if (detail === null || typeof detail !== 'object') return {}
  const clean = {}
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'user_verbatim' || key === 'verbatim') continue
    clean[key] = key === 'goal' || key === 'summary' ? truncate(value) : value
  }
  return clean
}

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function createLogger({
  stateDir,
  maxBytes = 5 * 1024 * 1024,
  keepDays = 7,
  now = Date.now,
  onWarn = () => {},
  // 子目录 / 文件名前缀：默认是运行日志；交接事件用 handoff/ + handoff-。
  subdir = 'logs',
  filePrefix = 'orchestrator',
}) {
  const dir = join(stateDir, subdir)
  const namePattern = new RegExp(`^${escapeRegExp(filePrefix)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.\\d+)?\\.jsonl$`)
  let warned = false
  let currentDay = ''
  let currentIndex = 0

  const warnOnce = error => {
    if (warned) return
    warned = true
    onWarn(`dsh-orchestrator: 日志写入失败：${error?.message ?? error}`)
  }

  const cleanup = day => {
    if (!existsSync(dir)) return
    const cutoff = new Date(`${day}T00:00:00`).getTime() - (keepDays - 1) * DAY_MS
    for (const name of readdirSync(dir)) {
      const match = namePattern.exec(name)
      if (match === null) continue
      const created = new Date(`${match[1]}T00:00:00`).getTime()
      if (created < cutoff) {
        try { unlinkSync(join(dir, name)) } catch { /* 删不掉不影响日志 */ }
      }
    }
  }

  const ensureDay = () => {
    const day = dateKey(now())
    if (day === currentDay) return
    currentDay = day
    currentIndex = 0
    try {
      mkdirSync(dir, { recursive: true })
      cleanup(day)
    } catch (error) {
      warnOnce(error)
    }
  }

  const fileFor = bytes => {
    for (;;) {
      const name = currentIndex === 0
        ? `${filePrefix}-${currentDay}.jsonl`
        : `${filePrefix}-${currentDay}.${currentIndex + 1}.jsonl`
      const file = join(dir, name)
      let size = 0
      try {
        if (existsSync(file)) size = statSync(file).size
      } catch { /* 读不到大小就当空文件 */ }
      if (size + bytes <= maxBytes) return file
      currentIndex += 1
    }
  }

  return {
    log(event, fields = {}) {
      const line = JSON.stringify({
        at: new Date(now()).toISOString(),
        event,
        ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
        ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
        ...(fields.agentId === undefined ? {} : { agentId: fields.agentId }),
        detail: sanitize(fields.detail ?? {}),
      })
      const bytes = Buffer.byteLength(line, 'utf8') + 1
      try {
        ensureDay()
        appendFileSync(fileFor(bytes), `${line}\n`, 'utf8')
      } catch (error) {
        warnOnce(error)
      }
    },
    pathForDay(day = dateKey(now())) {
      return join(dir, `${filePrefix}-${day}.jsonl`)
    },
  }
}
