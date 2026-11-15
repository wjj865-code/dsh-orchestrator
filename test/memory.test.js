import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger } from '../src/ledger.js'
import {
  GLOBAL_PROJECT, LESSON_KIND, MAX_FACT_CHARS, MAX_LOG_CHARS, TASK_LOG_KIND, addMemory, buildMemoryBlock,
  distillFacts, distillLessons, distillText, memoryLayerOf, memoryTokens, projectKeyOf, searchMemories,
  taskLogText,
} from '../src/memory.js'
import { tempDir } from './helpers.js'

test('projectKeyOf：绝对路径规范化，空值归 global，Windows 大小写归一', () => {
  assert.equal(projectKeyOf(undefined), GLOBAL_PROJECT)
  assert.equal(projectKeyOf('  '), GLOBAL_PROJECT)
  const key = projectKeyOf(process.platform === 'win32' ? 'C:/Work/Project' : '/Work/Project')
  if (process.platform === 'win32') {
    assert.equal(key, projectKeyOf('C:\\Work\\Project'))
    assert.equal(key, key.toLowerCase())
  }
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

test('M1 分层：只有事实层注入 brief，task-log 与旧 task-done 都不注入但可检索', async () => {
  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/layer')
  // 白名单：lesson/decision/preference/note 是事实层；task-log 与旧 task-done 是日志层；未知 kind 兜底为日志层。
  assert.equal(memoryLayerOf(LESSON_KIND), 'fact')
  assert.equal(memoryLayerOf('decision'), 'fact')
  assert.equal(memoryLayerOf('preference'), 'fact')
  assert.equal(memoryLayerOf('note'), 'fact')
  assert.equal(memoryLayerOf(TASK_LOG_KIND), 'log')
  assert.equal(memoryLayerOf('task-done'), 'log')
  assert.equal(memoryLayerOf('whatever'), 'log')

  addMemory(db, { projectKey: project, kind: TASK_LOG_KIND, text: '任务「登录修复」完成：改用 session cookie' })
  addMemory(db, { projectKey: project, kind: 'task-done', text: '任务「旧版登录」完成：登录 cookie 改造' })
  addMemory(db, { projectKey: project, kind: LESSON_KIND, text: '登录模块先查半成品再动手，避免重做' })

  const block = buildMemoryBlock(db, { projectKey: project })
  assert.ok(block.includes('先查半成品'))
  assert.equal(block.includes('task-log'), false)
  assert.equal(block.includes('任务「登录修复」完成'), false)
  assert.equal(block.includes('任务「旧版登录」完成'), false)
  // 事实层标签可读，便于协调者分辨来源
  assert.match(block, /\[经验\]/)

  // 日志层不注入，但 history_search 用的检索仍能查到（不只查事实层）。
  const logs = searchMemories(db, { projectKey: project, query: 'session cookie' })
  assert.deepEqual(logs.map(row => row.kind).sort(), ['task-done', 'task-log'])
  const factsOnly = searchMemories(db, { projectKey: project, query: 'session cookie', kinds: [LESSON_KIND, 'decision', 'preference', 'note'] })
  assert.equal(factsOnly.length, 0)
  db.close()
})

test('M1 蒸馏：写入即清洗——代码块/命令日志/verbatim/路径清单不进库，原子事实限量', () => {
  const raw = [
    '改完发现 ```js\nconst a = 1\n``` 这段是日志',
    '$ npm test -- --watch',
    '> 用户原话：把整个日志贴给我',
    '结论：先查半成品再继续',
    '经验：小步提交，避免一次改太多',
    'C:\\work\\a\\src\\brief.js',
  ].join('\n')

  const facts = distillFacts(raw, { max: 5 })
  assert.deepEqual(facts, ['结论：先查半成品再继续', '经验：小步提交，避免一次改太多'])
  assert.ok(facts.every(fact => fact.length <= MAX_FACT_CHARS))
  assert.equal(facts.some(fact => fact.includes('const a = 1')), false)
  assert.equal(facts.some(fact => fact.startsWith('$ ')), false)
  assert.equal(facts.some(fact => fact.startsWith('> ')), false)
  assert.equal(facts.some(fact => fact.startsWith('C:')), false)
  // 长分句 = 长日志/verbatim：整条丢弃，不做截断写入。
  assert.deepEqual(distillFacts('很长的日志'.repeat(200)), [])
  // 限量与去重
  const many = '结论一：先查半成品。结论二：小步提交。结论三：注意回归。结论四：避免大改。'
  assert.deepEqual(distillFacts(many, { max: 2 }), ['结论一：先查半成品', '结论二：小步提交'])
  assert.deepEqual(distillFacts('结论一样：别急。结论一样：别急。'), ['结论一样：别急'])
  // 只留有经验/教训标记的 lesson
  assert.deepEqual(distillLessons('改完文件。结论：先查半成品。', { max: 2 }), ['结论：先查半成品'])
  assert.deepEqual(distillLessons('改完文件。npm test 全绿。'), [])
  // 完成任务记录（日志层措辞）不算经验，哪怕带「改用」
  assert.deepEqual(distillLessons('任务「A」完成：改用 session cookie'), [])
  // 写入清洗统一按上限截断，不留半句之外的日志
  assert.ok(distillText('第一条'.repeat(400)).length <= MAX_FACT_CHARS)
  assert.equal(distillText('$ ls\n> 引用'), '')
})

test('M1 task-log 格式：一行完成任务记录，总长受上限约束，verbatim 不落库', () => {
  const one = taskLogText('登录修复', '改用 session cookie')
  assert.equal(one, '任务「登录修复」完成：改用 session cookie')
  assert.ok(one.length <= MAX_LOG_CHARS)
  // 摘要自带「任务「…」完成」前缀时不重复拼
  assert.equal(taskLogText('登录修复', one), one)
  // 长摘要按日志上限截断；代码块/命令日志/verbatim 被丢弃后只剩标题
  const long = taskLogText('登录修复', '改用 session cookie。' + '补充'.repeat(200))
  assert.ok(long.length <= MAX_LOG_CHARS)
  assert.equal(taskLogText('登录修复', '```js\nconsole.log(1)\n```\n$ npm test\n> 原话'), '任务「登录修复」完成')
})

test('M1 写入即蒸馏：addMemory 按层截断，日志层一行、事实层一条原子事实', async () => {
  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/distill')
  const log = addMemory(db, { projectKey: project, kind: TASK_LOG_KIND, text: '完成：' + '很长的日志'.repeat(100) })
  const fact = addMemory(db, { projectKey: project, kind: 'note', text: '注意：先查半成品。' + '很长的日志'.repeat(100) })
  assert.ok(log.text.length <= MAX_LOG_CHARS)
  assert.ok(fact.text.length <= MAX_FACT_CHARS)
  assert.ok(fact.text.includes('先查半成品'))
  db.close()
})
