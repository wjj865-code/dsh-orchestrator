import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger } from '../src/ledger.js'
import {
  GLOBAL_PROJECT, LESSONS_DIRNAME, LESSON_KIND, MAX_FACT_CHARS, MAX_LESSON_SUMMARY_CHARS, MAX_LOG_CHARS,
  MAX_TASK_LOG_PER_PROJECT, TASK_LOG_KIND, addMemory, buildLessonBlock, buildMemoryBlock, distillFacts,
  distillLessons, distillText, lessonFilePath, lessonPointerBlock, memoryLayerOf, memoryTokens, normalizeProjectKeys,
  projectKeyOf, renderLessonFile, searchMemories, taskLogText, writeLessonFile,
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

  // 日志层不注入，但 history 用的检索仍能查到（不只查事实层）。
  // P0 质量门槛：多词查询要求命中 ≥2 个词，所以这里用只出现在日志层里的 'cookie' 做单词查询。
  const logs = searchMemories(db, { projectKey: project, query: 'cookie' })
  assert.deepEqual(logs.map(row => row.kind).sort(), ['task-done', 'task-log'])
  const factsOnly = searchMemories(db, { projectKey: project, query: 'cookie', kinds: [LESSON_KIND, 'decision', 'preference', 'note'] })
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

// ---- L1 brief 精简：经验写记忆文件 + brief 短摘要/指针 + 降级 ----

test('L1 经验文件：完整内容写 lessons/，brief 只留短摘要 + 指针，路径稳定', async () => {
  const db = await openLedger(tempDir())
  const stateDir = tempDir()
  const project = projectKeyOf('C:/work/l1')
  const lesson = '登录模块先查半成品再动手，避免重做'
  addMemory(db, { projectKey: project, kind: LESSON_KIND, text: lesson, sourceTaskId: 't-12345678' })
  addMemory(db, { projectKey: project, kind: 'decision', text: '统一走 session cookie' })

  const result = buildLessonBlock(db, { stateDir, projectKey: project, limit: 2 })
  assert.equal(result.mode, 'pointer')
  assert.equal(result.count, 2)
  assert.equal(typeof result.path, 'string')
  assert.equal(result.path, join(stateDir, LESSONS_DIRNAME, result.path.split(/[\\/]/).pop()))
  assert.match(result.block, new RegExp(`【历史经验】2 条`))
  assert.equal(result.block.includes(`完整经验：${result.path}`), true)

  // 文件里是完整内容（brief 里只有摘要），带层标签与来源，子会话 read 就能拿到全文。
  const body = readFileSync(result.path, 'utf8')
  assert.equal(body.includes(lesson), true)
  assert.equal(body.includes('统一走 session cookie'), true)
  assert.match(body, /\[经验\]/)
  assert.match(body, /\[决策\]/)
  assert.match(body, /来源任务：t-12345678/)
  assert.match(body, /生成时间：/)

  // 同一项目再次派发落到同一个文件；文件内容可重复生成（同一 now 下逐字一致）。
  const again = buildLessonBlock(db, { stateDir, projectKey: project, limit: 2 })
  assert.equal(again.path, result.path)
  assert.equal(writeLessonFile({ stateDir, projectKey: project, rows: [], now: 1 }), undefined)
  db.close()
})

test('L1 经验文件：brief 里的摘要被截短，长事实不进 brief', async () => {
  const db = await openLedger(tempDir())
  const stateDir = tempDir()
  const project = projectKeyOf('C:/work/l1-long')
  const long = `结论：${'很长的经验'.repeat(30)}`
  addMemory(db, { projectKey: project, kind: LESSON_KIND, text: long })
  const result = buildLessonBlock(db, { stateDir, projectKey: project })
  assert.equal(result.mode, 'pointer')
  const stored = readFileSync(result.path, 'utf8')
  assert.equal(stored.includes('很长的经验'.repeat(30)), true)
  // 摘要行最多 MAX_LESSON_SUMMARY_CHARS + 省略号，完整长尾不出现在 brief 块里。
  const summaryLine = result.block.split('\n').find(line => line.startsWith('- '))
  assert.ok(summaryLine !== undefined)
  assert.ok(summaryLine.length <= MAX_LESSON_SUMMARY_CHARS + 24, summaryLine)
  assert.equal(result.block.includes('很长的经验'.repeat(30)), false)
  db.close()
})

test('L1 降级：没有 stateDir → 退回内联记忆块（不丢经验、不写文件）', async () => {
  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/l1-inline')
  addMemory(db, { projectKey: project, kind: LESSON_KIND, text: '登录模块先查半成品再动手' })
  const result = buildLessonBlock(db, { projectKey: project })
  assert.equal(result.mode, 'inline')
  assert.equal(result.path, undefined)
  assert.match(result.block, /【历史经验】\n/)
  assert.equal(result.block.includes('先查半成品'), true)
  assert.equal(result.block.includes('完整经验：'), false)
  db.close()
})

test('L1 降级：lessons/ 写不进去（同名文件占位）→ 退回内联块', async () => {
  const db = await openLedger(tempDir())
  const stateDir = tempDir()
  writeFileSync(join(stateDir, LESSONS_DIRNAME), '占位：这不是目录', 'utf8')
  const project = projectKeyOf('C:/work/l1-eacces')
  addMemory(db, { projectKey: project, kind: LESSON_KIND, text: '经验：小步提交，避免一次改太多' })
  const result = buildLessonBlock(db, { stateDir, projectKey: project })
  assert.equal(result.mode, 'inline')
  assert.equal(result.path, undefined)
  assert.equal(result.block.includes('小步提交'), true)
  db.close()
})

test('L1 无命中：返回空块，且不创建 lessons/ 目录', async () => {
  const db = await openLedger(tempDir())
  const stateDir = tempDir()
  const result = buildLessonBlock(db, { stateDir, projectKey: projectKeyOf('C:/work/l1-none'), query: '完全不存在的词xyz' })
  assert.deepEqual({ block: result.block, mode: result.mode, count: result.count }, { block: '', mode: 'inline', count: 0 })
  assert.equal(existsSync(join(stateDir, LESSONS_DIRNAME)), false)
  db.close()
})

test('L1 指针块：超上限先丢摘要行，文件路径行永不截断', () => {
  const rows = [
    { id: 'm-1', kind: LESSON_KIND, text: '经验'.repeat(80), createdAt: Date.now() },
    { id: 'm-2', kind: 'decision', text: '决策'.repeat(80), createdAt: Date.now() },
  ]
  const path = join(tempDir(), LESSONS_DIRNAME, 'demo-01234567.md')
  const block = lessonPointerBlock(rows, path, { maxChars: 120 })
  assert.equal(block.includes(path), true)
  assert.ok(block.length <= 120 + path.length)
  assert.match(block, /完整经验：/)
  // 空输入/空路径返回空串（调用方据此不追加小节）。
  assert.equal(lessonPointerBlock([], path), '')
  assert.equal(lessonPointerBlock(rows, '  '), '')
})

test('L1 lessonFilePath：项目名可读 + key 短 hash，global 也稳定', () => {
  const dir = tempDir()
  const a = lessonFilePath(dir, projectKeyOf('C:/work/Alpha'))
  const b = lessonFilePath(dir, projectKeyOf('C:/work/Alpha'))
  const c = lessonFilePath(dir, projectKeyOf('C:/work/Beta'))
  assert.equal(a, b)
  assert.notEqual(a.split(/[\\/]/).pop(), c.split(/[\\/]/).pop())
  assert.match(a.split(/[\\/]/).pop(), /^alpha-[0-9a-f]{8}\.md$/)
  assert.match(lessonFilePath(dir, GLOBAL_PROJECT).split(/[\\/]/).pop(), /^global-[0-9a-f]{8}\.md$/)
})

test('L1 renderLessonFile：无行时只有头，行内容逐字保留', () => {
  const empty = renderLessonFile({ projectKey: 'global', rows: [], now: 0 })
  assert.match(empty, /# 项目经验：全局（跨项目）/)
  assert.match(empty, /生成时间：1970-01-01T00:00:00.000Z/)
  const one = renderLessonFile({ projectKey: GLOBAL_PROJECT, rows: [{ id: 'm-9', kind: 'note', text: '甲\n乙', createdAt: 0 }], now: 0 })
  assert.equal(one.includes('甲\n乙'), true)
  assert.match(one, /id：m-9/)
})

// ---- M2 记忆优化（t-3e27f4b4）：淘汰分层 / 质量门槛 / 多键检索 ----

test('M2 淘汰分层：task-log 单项目限 200，事实层不参与淘汰', async () => {
  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/evict')
  // 手记事实先写（最老），再灌 260 条 task-log：旧口径（300 条混算）会先把这几条删掉。
  addMemory(db, { projectKey: project, kind: 'decision', text: '决策甲：登录统一走 cookie，不再新增 token' })
  addMemory(db, { projectKey: project, kind: 'note', text: '笔记乙：发布前先跑 pnpm test' })
  addMemory(db, { projectKey: project, kind: LESSON_KIND, text: '经验丙：先查半成品再动手' })
  for (let index = 0; index < 260; index += 1) {
    addMemory(db, { projectKey: project, kind: TASK_LOG_KIND, text: `任务「第 ${index} 号」完成：改了一处` })
  }
  const countOfKind = kind => db.prepare('SELECT count(*) AS n FROM memories WHERE project_key = ? AND kind = ?').get(project, kind).n
  assert.equal(countOfKind(TASK_LOG_KIND), MAX_TASK_LOG_PER_PROJECT)
  assert.equal(MAX_TASK_LOG_PER_PROJECT, 200)
  assert.equal(countOfKind('decision'), 1)
  assert.equal(countOfKind('note'), 1)
  assert.equal(countOfKind(LESSON_KIND), 1)
  // 淘汰的是最老的日志（第 0–59 号），最新的留下。
  const logTexts = db.prepare('SELECT text FROM memories WHERE project_key = ? AND kind = ?').all(project, TASK_LOG_KIND).map(row => row.text)
  assert.equal(logTexts.some(text => text.includes('第 0 号')), false)
  assert.equal(logTexts.some(text => text.includes('第 259 号')), true)
  db.close()
})

test('M2 质量门槛：通用词进停用词；多词查询要命中 ≥2 词或分数 ≥2，单词查询照旧', async () => {
  // 通用词不再构成「相关」
  const tokens = memoryTokens('测试 代码 文件 实现 插件 登录')
  for (const stop of ['测试', '代码', '文件', '实现', '插件']) assert.equal(tokens.includes(stop), false, stop)
  assert.equal(tokens.includes('登录'), true)

  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/threshold')
  addMemory(db, { projectKey: project, kind: 'note', text: '登录模块统一走 session cookie' })
  addMemory(db, { projectKey: project, kind: 'note', text: '发布流程先跑 pnpm test' })
  // 两个词各命中一条 note：单条只命中 1 个词（score 1）→ 两条都不算相关。
  assert.deepEqual(searchMemories(db, { projectKey: project, query: '登录 发布' }), [])
  // decision 有 +2 权重：只命中 1 个词也能过（score ≥2），这是「高价值事实放宽」的那一侧。
  addMemory(db, { projectKey: project, kind: 'decision', text: '登录走统一网关' })
  const hits = searchMemories(db, { projectKey: project, query: '登录 发布' })
  assert.deepEqual(hits.map(row => row.kind), ['decision'])
  // 单词查询沿用「命中即相关」：pnpm 仍能查到那条 note。
  assert.equal(searchMemories(db, { projectKey: project, query: 'pnpm' }).length, 1)
  db.close()
})

test('M2 分层配额：decision/preference 最多占 2 条，剩余槽位留给 lesson', async () => {
  const db = await openLedger(tempDir())
  const project = projectKeyOf('C:/work/quota')
  for (let index = 0; index < 3; index += 1) {
    addMemory(db, { projectKey: project, kind: 'decision', text: `登录事项${index}：走 cookie 校验` })
  }
  addMemory(db, { projectKey: project, kind: LESSON_KIND, text: '登录先查半成品再动手' })
  const hits = searchMemories(db, { projectKey: project, query: '登录 cookie', limit: 3 })
  assert.equal(hits.length, 3)
  assert.equal(hits.filter(row => row.kind === 'decision').length, 2)
  assert.equal(hits.some(row => row.kind === LESSON_KIND), true)
  // 没有其它层可补时按分数补回：不会因为配额只返回 2 条。
  const db2 = await openLedger(tempDir())
  const project2 = projectKeyOf('C:/work/quota-only-decision')
  for (let index = 0; index < 3; index += 1) {
    addMemory(db2, { projectKey: project2, kind: 'decision', text: `登录事项${index}：走 cookie 校验` })
  }
  assert.equal(searchMemories(db2, { projectKey: project2, query: '登录 cookie', limit: 3 }).length, 3)
  db.close()
  db2.close()
})

test('P0-b 检索范围：projectKeys 合并多项目、all 跨项目、单键自动补 global', async () => {
  const db = await openLedger(tempDir())
  const a = projectKeyOf('C:/work/merge-a')
  const b = projectKeyOf('C:/work/merge-b')
  addMemory(db, { projectKey: a, kind: 'decision', text: '甲项目：登录用 cookie' })
  addMemory(db, { projectKey: b, kind: 'decision', text: '乙项目：登录用 token' })
  addMemory(db, { projectKey: GLOBAL_PROJECT, kind: 'preference', text: '全局：登录相关先查 README' })

  const merged = searchMemories(db, { projectKeys: [a, b], query: '登录' })
  assert.deepEqual(merged.map(row => row.projectKey).sort(), [a, b, GLOBAL_PROJECT].sort())
  const all = searchMemories(db, { projectKeys: 'all', query: '登录' })
  assert.equal(all.length, 3)
  const one = searchMemories(db, { projectKey: a, query: '登录' })
  assert.deepEqual(one.map(row => row.projectKey).sort(), [a, GLOBAL_PROJECT].sort())
  // normalizeProjectKeys：'all' → null；数组去重并自动补 global。
  assert.equal(normalizeProjectKeys('all'), null)
  assert.deepEqual(normalizeProjectKeys([a, a]), [a, GLOBAL_PROJECT])
  assert.deepEqual(normalizeProjectKeys(undefined), [GLOBAL_PROJECT])
  db.close()
})
