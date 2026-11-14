import test from 'node:test'
import assert from 'node:assert/strict'
import { inferWorkspaceTarget, pathTail } from '../src/workspace-match.js'

const ws = (id, title, path) => ({ id, title, path })

const WORKSPACES = [
  ws('w-gzh', '公众号文章', 'C:/Users/me/公众号文章'),
  ws('w-gzh2', '公众号文章（旧）', 'D:/backup/公众号文章（旧）'),
  ws('w-bot', 'DS Bot', 'C:/Users/me/.dsh/bot/workspace'),
  ws('w-ai', 'ai', 'C:/tmp/ai'),
  ws('w-ms', '指挥舱', 'C:/Users/me/.dsh/state/orchestrator/workspace'),
]

test('pathTail 跨平台取末段', () => {
  assert.equal(pathTail('C:\\a\\b'), 'b')
  assert.equal(pathTail('/a/b/'), 'b')
  assert.equal(pathTail('C:/'), 'C:')
  assert.equal(pathTail(undefined), '')
})

test('精确名优先：命中 title 全等时忽略别的工作区的子串命中', () => {
  const result = inferWorkspaceTarget({ title: '公众号文章', goal: '写下一篇' }, WORKSPACES)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'w-gzh')
})

test('精确名也看 goal；大小写不敏感', () => {
  const result = inferWorkspaceTarget({ title: '随手任务', goal: 'ds bot' }, WORKSPACES)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'w-bot')
})

test('子串唯一命中：标题里出现工作区名', () => {
  const result = inferWorkspaceTarget({ title: '整理公众号文章选题', goal: '给下一篇做准备' }, WORKSPACES)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'w-gzh')
})

test('子串多命中：列候选、不猜，按 title 稳定排序', () => {
  const workspaces = [
    ws('a', '项目甲', 'C:/x/项目甲'),
    ws('b', '项目乙', 'C:/x/项目乙'),
  ]
  const result = inferWorkspaceTarget({ title: '项目甲和项目乙的对比', goal: '' }, workspaces)
  assert.equal(result.ok, false)
  assert.deepEqual(result.candidates.map(item => item.id), ['a', 'b'])
  assert.deepEqual(result.candidates.map(item => item.path), ['C:/x/项目甲', 'C:/x/项目乙'])
})

test('无命中返回 ok:true 且 workspace 为空（落指挥舱）', () => {
  const result = inferWorkspaceTarget({ title: '无关任务', goal: '随便干点' }, WORKSPACES)
  assert.equal(result.ok, true)
  assert.equal(result.workspace, undefined)
})

test('同一工作区 title 与路径末段都命中只算一个', () => {
  const workspaces = [ws('same', '公众号文章', 'C:/x/公众号文章')]
  const result = inferWorkspaceTarget({ title: '公众号文章', goal: '公众号文章 选题' }, workspaces)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'same')
})

test('短 ASCII 键不参与匹配（ai 这类不误伤）', () => {
  const workspaces = [ws('w-ai', 'ai', 'C:/tmp/ai'), ws('w-gomoku', 'gomoku-ai 项目', 'C:/tmp/gomoku-ai')]
  // 'ai' 只有 2 个 ASCII 字符 → 跳过；'gomoku-ai 项目' 不是文本子串 → 无命中。
  assert.equal(inferWorkspaceTarget({ title: 'ai 辅助流程', goal: '随便看看' }, workspaces).workspace, undefined)
})

test('CJK 两字键可以匹配', () => {
  const workspaces = [ws('w-gz', '公号', 'C:/x/公号')]
  const result = inferWorkspaceTarget({ title: '公号排版', goal: '' }, workspaces)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'w-gz')
})

test('空文本/空列表/非法工作区都不崩', () => {
  assert.equal(inferWorkspaceTarget({}, WORKSPACES).workspace, undefined)
  assert.equal(inferWorkspaceTarget({ title: 'x' }, []).workspace, undefined)
  assert.equal(inferWorkspaceTarget({ title: 'x' }, [null, {}, { id: 'ok', title: '', path: '' }]).workspace, undefined)
})

test('命中的是指挥舱本身（允许）', () => {
  const result = inferWorkspaceTarget({ title: '指挥舱整理', goal: '' }, WORKSPACES)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'w-ms')
})
