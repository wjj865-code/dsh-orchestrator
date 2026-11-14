import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectWorkspaceArtifacts, appendMissingArtifacts, changedEventsOf } from '../src/artifact-collect.js'
import { tempDir } from './helpers.js'

const sessionWith = events => ({ id: 'c-1', ownEvents: () => events })
const changeEvent = seq => ({ type: 'workspace/changes', seq, data: { turn: 1 } })

test('collectWorkspaceArtifacts：跨回合汇总、相对路径按摘要 cwd 解析、同路径去重', () => {
  const cwd = tempDir()
  const first = join(cwd, 'a.md')
  const second = join(cwd, 'b.txt')
  writeFileSync(first, 'a', 'utf8')
  writeFileSync(second, 'b', 'utf8')
  const summaries = {
    2: { cwd, files: [{ path: 'a.md', added: 1, deleted: 0 }] },
    5: {
      cwd,
      files: [
        { path: 'a.md', added: 3, deleted: 1 },
        { path: 'b.txt', added: 0, deleted: 2 },
        { path: 'gone.txt', added: 1, deleted: 0 },
      ],
    },
  }
  const result = collectWorkspaceArtifacts({
    session: sessionWith([changeEvent(2), { type: 'turn/end', seq: 3 }, changeEvent(5)]),
    workspaceChanges: { summary: (_id, seq) => summaries[seq] },
  })
  assert.equal(result.turns, 2)
  assert.deepEqual(result.artifacts.map(item => item.path), [first, second, join(cwd, 'gone.txt')])
  assert.equal(result.artifacts.find(item => item.path === first).label, '+3/-1')
  assert.equal(result.artifacts.find(item => item.path === first).exists, true)
  assert.equal(result.artifacts.find(item => item.path === second).exists, true)
  assert.equal(result.artifacts.find(item => item.path.endsWith('gone.txt')).exists, false)
})

test('collectWorkspaceArtifacts：无事件 / 无服务 / 摘要已释放都返回空，不抛错', () => {
  assert.deepEqual(collectWorkspaceArtifacts({ session: sessionWith([]), workspaceChanges: { summary: () => undefined } }),
    { artifacts: [], turns: 0, omitted: 0 })
  assert.deepEqual(collectWorkspaceArtifacts({ session: sessionWith([changeEvent(1)]) }),
    { artifacts: [], turns: 0, omitted: 0 })
  assert.deepEqual(collectWorkspaceArtifacts({ session: undefined, workspaceChanges: { summary: () => ({ files: [] }) } }),
    { artifacts: [], turns: 0, omitted: 0 })
})

test('collectWorkspaceArtifacts：超过上限截断并报告 omitted；cwd 缺失时保留绝对路径', () => {
  const result = collectWorkspaceArtifacts({
    session: sessionWith([changeEvent(1)]),
    workspaceChanges: { summary: () => ({
      cwd: 'C:/work',
      files: Array.from({ length: 4 }, (_, index) => ({ path: `f-${index}.txt`, added: index, deleted: 0 })),
    }) },
    max: 3,
  })
  assert.equal(result.artifacts.length, 3)
  assert.equal(result.omitted, 1)
  const absolute = collectWorkspaceArtifacts({
    session: sessionWith([changeEvent(1)]),
    workspaceChanges: { summary: () => ({ files: [{ path: 'C:/abs/out.md', added: 1, deleted: 0 }] }) },
  })
  assert.equal(absolute.artifacts[0].path, 'C:/abs/out.md')
})

test('changedEventsOf 兼容 events 数组；appendMissingArtifacts 不覆盖已有路径', () => {
  assert.equal(changedEventsOf({ events: [changeEvent(1), changeEvent(2)] }).length, 2)
  assert.deepEqual(appendMissingArtifacts([{ path: 'a', label: '显式' }], [
    { path: 'a', label: '自动' }, { path: 'b', label: '自动' },
  ]), [{ path: 'b', label: '自动' }])
})
