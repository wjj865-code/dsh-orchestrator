import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger } from '../src/ledger.js'
import {
  GLOBAL_PROJECT, addMemory, buildMemoryBlock, memoryTokens, projectKeyOf, searchMemories,
} from '../src/memory.js'
import { tempDir } from './helpers.js'

test('projectKeyOf：绝对路径规范化，空值归 global，Windows 大小写归一', () => {
  assert.equal(projectKeyOf(undefined), GLOBAL_PROJECT)
  assert.equal(projectKeyOf('  '), GLOBAL_PROJECT)
  const key = projectKeyOf('C:/Work/Project')
  assert.equal(key, projectKeyOf('C:\\Work\\Project'))
  if (process.platform === 'win32') assert.equal(key, key.toLowerCase())
})

test('memoryTokens：中文二元组 + ASCII 词，去掉停用词', () => {
  const tokens = memoryTokens('修复登录模块 Login Bug')
  assert.ok(tokens.includes('登录'))
  assert.ok(tokens.includes('login'))
  assert.ok(tokens.includes('bug'))
  assert.equal(tokens.includes('任务'), false)
})

test('addMemory 幂等；searchMemories 按项目隔离并命中中文关键词', async () => {
  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/a')
  const first = addMemory(db, { projectKey: project, kind: 'decision', text: '登录模块统一走 session cookie，不再新增 token 参数' })
  assert.ok(first)
  const duplicate = addMemory(db, { projectKey: project, kind: 'decision', text: '登录模块统一走 session cookie，不再新增 token 参数' })
  assert.equal(duplicate, undefined)
  addMemory(db, { projectKey: projectKeyOf('C:/work/b'), kind: 'note', text: '登录模块用另一个方案' })
  addMemory(db, { projectKey: GLOBAL_PROJECT, kind: 'preference', text: '用户偏好 pnpm' })

  const hits = searchMemories(db, { projectKey: project, query: '登录模块 token', limit: 5 })
  assert.equal(hits.length, 1) // 只命中本项目那条；别的项目不串
  assert.equal(hits[0].text.includes('session cookie'), true)
  assert.equal(hits[0].kind, 'decision')
  assert.equal(hits.some(row => row.text.includes('另一个方案')), false)
  // global 记忆在任意项目查询里都能召回（不能把 'global' 当相对路径）。
  const globalHits = searchMemories(db, { projectKey: project, query: 'pnpm', limit: 5 })
  assert.equal(globalHits.length, 1)
  assert.equal(globalHits[0].projectKey, GLOBAL_PROJECT)
  db.close()
})

test('searchMemories 无关键词按时间倒序；buildMemoryBlock 有上限且无命中为空', async () => {
  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/c')
  addMemory(db, { projectKey: project, kind: 'note', text: '第一条'.repeat(400) })
  await new Promise(resolve => setTimeout(resolve, 2))
  addMemory(db, { projectKey: project, kind: 'note', text: '第二条' })
  const recent = searchMemories(db, { projectKey: project })
  assert.equal(recent[0].text, '第二条')
  const block = buildMemoryBlock(db, { projectKey: project, limit: 2, maxChars: 80 })
  assert.ok(block.startsWith('【历史经验】'))
  assert.ok(block.length <= 80)
  assert.equal(buildMemoryBlock(db, { projectKey: project, query: '完全不存在的词xyz', limit: 2 }), '')
  db.close()
})
