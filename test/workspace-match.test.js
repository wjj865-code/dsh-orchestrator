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

test('包含消歧：被更具体名字包含的泛命中丢掉（orchestrator ⊂ dsh-orchestrator）', () => {
  const workspaces = [
    ws('broad', 'orchestrator', 'C:/x/orchestrator'),
    ws('specific', 'dsh-orchestrator', 'C:/x/dsh-orchestrator'),
  ]
  const result = inferWorkspaceTarget({ title: 'dsh-orchestrator 重构', goal: '' }, workspaces)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'specific')
})

test('包含消歧不能吞掉真正多命中：互不包含仍列候选', () => {
  const workspaces = [ws('a', 'alpha', 'C:/x/alpha'), ws('b', 'beta', 'C:/x/beta')]
  const result = inferWorkspaceTarget({ title: 'alpha 和 beta 一起改', goal: '' }, workspaces)
  assert.equal(result.ok, false)
  assert.deepEqual(result.candidates.map(item => item.id), ['a', 'b'])
})

test('包含消歧不能吞掉同名工作区（key 完全相同仍走候选）', () => {
  const workspaces = [ws('n1', '同名项目', 'C:/a/同名项目'), ws('n2', '同名项目', 'D:/b/同名项目')]
  const result = inferWorkspaceTarget({ title: '同名项目 排期', goal: '' }, workspaces)
  assert.equal(result.ok, false)
  assert.deepEqual(result.candidates.map(item => item.id), ['n1', 'n2'])
})

test('通用词末段被黑：指挥舱（末段 workspace）与 default-workspace 不再歧义', () => {
  const workspaces = [
    ws('w-ms', '指挥舱', 'C:/Users/me/.dsh/state/orchestrator/workspace'),
    ws('w-dw', 'default-workspace', 'D:/default-workspace'),
  ]
  // 真机原案：任务标题里带 default-workspace。
  const result = inferWorkspaceTarget({ title: 'default-workspace 真机推断验证', goal: '' }, workspaces)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'w-dw')
})

test('通用词末段被黑：只写 workspace 这类通用词不再弹候选（无命中回指挥舱）', () => {
  const workspaces = [
    ws('w-ms', '指挥舱', 'C:/Users/me/.dsh/state/orchestrator/workspace'),
    ws('w-dw', 'default-workspace', 'D:/default-workspace'),
  ]
  const result = inferWorkspaceTarget({ title: 'workspace 清理一下', goal: '顺手整理' }, workspaces)
  assert.equal(result.ok, true)
  assert.equal(result.workspace, undefined)
})

test('通用词末段被黑：末段为 documents 的工作区不参与路径末段匹配', () => {
  const workspaces = [ws('w-docs', '我的资料', 'C:/Users/me/documents')]
  const result = inferWorkspaceTarget({ title: 'documents 归档', goal: '' }, workspaces)
  assert.equal(result.ok, true)
  assert.equal(result.workspace, undefined)
})

test('通用词末段被黑不影响显示名：title 叫 app 的工作区仍能精确/子串命中', () => {
  const workspaces = [ws('w-app', 'app', 'C:/x/app')]
  assert.equal(inferWorkspaceTarget({ title: 'app', goal: '' }, workspaces).workspace.id, 'w-app')
  assert.equal(inferWorkspaceTarget({ title: 'app 部署', goal: '' }, workspaces).workspace.id, 'w-app')
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

test('精确全等不受短键过滤影响（2 字 title 全等命中）', () => {
  const workspaces = [ws('w-ai', 'AI', 'C:/tmp/ai')]
  const result = inferWorkspaceTarget({ title: 'AI', goal: '' }, workspaces)
  assert.equal(result.ok, true)
  assert.equal(result.workspace.id, 'w-ai')
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
