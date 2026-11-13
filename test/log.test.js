import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../src/log.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'orch-log-'))
const lines = file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('按天写 jsonl，字段齐全，goal/summary 截断，不落 user_verbatim', () => {
  const dir = tempDir()
  const now = Date.parse('2026-11-13T12:00:00+08:00')
  const logger = createLogger({ stateDir: dir, now: () => now })
  logger.log('task.create.requested', {
    agentId: 's-1',
    detail: { title: '甲', goal: '长'.repeat(200), summary: '摘'.repeat(200), user_verbatim: '绝对不能出现' },
  })
  const rows = lines(logger.pathForDay('2026-11-13'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].at, new Date(now).toISOString())
  assert.equal(rows[0].event, 'task.create.requested')
  assert.equal(rows[0].agentId, 's-1')
  assert.equal(rows[0].detail.goal.length, 81)
  assert.equal(rows[0].detail.goal.endsWith('…'), true)
  assert.equal(rows[0].detail.summary.length, 81)
  assert.equal('user_verbatim' in rows[0].detail, false)
  assert.equal(JSON.stringify(rows).includes('绝对不能出现'), false)
})

test('超过 maxBytes 换新文件，文件名带序号', () => {
  const dir = tempDir()
  const logger = createLogger({ stateDir: dir, maxBytes: 120, now: () => Date.parse('2026-11-13T08:00:00+08:00') })
  for (let i = 0; i < 5; i += 1) logger.log('task.create.created', { taskId: `t-${i}`, detail: { title: `任务${i}` } })
  const files = readdirSync(join(dir, 'logs')).sort()
  assert.ok(files.length >= 2, files.join(','))
  assert.ok(files.includes('orchestrator-2026-11-13.jsonl'))
})

test('保留 7 天，超过的按文件名日期清掉', () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'logs'), { recursive: true })
  for (const day of ['2026-11-01', '2026-11-06', '2026-11-07', '2026-11-13']) {
    writeFileSync(join(dir, 'logs', `orchestrator-${day}.jsonl`), '{}\n')
  }
  createLogger({ stateDir: dir, now: () => Date.parse('2026-11-13T09:00:00+08:00') })
    .log('cleanup.pending', { detail: {} })
  const names = readdirSync(join(dir, 'logs'))
  assert.ok(names.includes('orchestrator-2026-11-07.jsonl'))
  assert.ok(names.includes('orchestrator-2026-11-13.jsonl'))
  assert.equal(names.includes('orchestrator-2026-11-01.jsonl'), false)
  assert.equal(names.includes('orchestrator-2026-11-06.jsonl'), false)
})

test('写失败只 warn 一次，不抛错', () => {
  const dir = tempDir()
  const stateDir = join(dir, 'state', 'orchestrator')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'logs'), 'not a directory')
  const warnings = []
  const logger = createLogger({ stateDir, onWarn: message => warnings.push(message) })
  assert.doesNotThrow(() => { logger.log('a', {}); logger.log('b', {}) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /日志写入失败/)
})
