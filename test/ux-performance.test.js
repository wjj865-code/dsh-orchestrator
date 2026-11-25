import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, setTaskArtifacts, setTaskArtifactStage, transition } from '../src/ledger.js'
import { createHostRoute } from '../src/host-route.js'
import { buildTitleCounts, displayNameOf, matchesQuery } from '../client/src/logic.js'
import { renderCoordinatorPolicy } from '../index.js'
import { createTools } from '../src/tools.js'
import { loadConfig } from '../src/config.js'
import { sampleBrief, tempDir } from './helpers.js'
import { createTaskFeed } from '../client/src/feed.js'

const request = rev => new Request('http://localhost/api/orchestrator', {
  method: 'POST', body: JSON.stringify({ endpoint: 'snapshot', rev }),
})

test('策略与工具描述预算：只精简文字，结构冻结另由 contract-snapshot 验证', () => {
  assert.ok(renderCoordinatorPolicy({}).length <= 11000)
  const schema = JSON.stringify(createTools({ db: {}, config: loadConfig({}) })
    .map(({ name, description, parameters }) => ({ name, description, parameters })))
  assert.ok(schema.length <= Math.floor(12650 * .92), `schema ${schema.length}`)
})

test('名字预计算：重名语义保持、引用与短后缀可搜索', () => {
  const tasks = Array.from({ length: 800 }, (_, index) => ({
    id: `t-${index}`, ref: `tk-${index}`, title: `任务${index % 40}`,
  }))
  const counts = buildTitleCounts(tasks)
  for (const task of tasks) {
    assert.equal(displayNameOf(task, counts), displayNameOf(task, tasks))
    assert.ok(matchesQuery(task, task.ref))
  }
})

test('列表阶段投影与文件数无关，未变化响应只返回固定小结构', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  setTaskArtifacts(db, task.id, Array.from({ length: 50 }, (_, index) => ({ path: `/artifact/${index}.md` })))
  const handler = createHostRoute({ db })
  const stage = files => ({ mode: 'non-git', complete: false, coverage: 'explicit-only', files })
  setTaskArtifactStage(db, task.id, stage([]))
  const first = await (await handler(request())).json()
  setTaskArtifactStage(db, task.id, stage(Array(10000).fill({ source: '/long/path', reason: 'missing' })))
  const second = await (await handler(request(first.rev))).json()
  assert.deepEqual(second, { ok: true, notModified: true, rev: first.rev })
  assert.ok(Buffer.byteLength(JSON.stringify(second)) < 150)
  assert.equal(first.tasks[0].artifactCount, 50)
  db.close()
})

test('feed 条件缓存独立、失败保留、隐藏恢复且请求不重叠', async () => {
  let visible = true, visibilityListener, resolve
  const revisions = [], timers = []
  let body = { ok: true, rev: 'r1', tasks: [{ id: 'a', status: 'running' }] }
  const feed = createTaskFeed({
    readSnapshot: async (_signal, rev) => {
      revisions.push(rev)
      return body ?? await new Promise(done => { resolve = done })
    },
    visible: () => visible,
    visibility: {
      addEventListener: (_name, fn) => { visibilityListener = fn },
      removeEventListener: () => {},
    },
    setTimer: (run, ms) => { const timer = { run, ms }; timers.push(timer); return timer },
    clearTimer: timer => { timer.cleared = true },
  })
  const off = feed.subscribe(() => {})
  await timers.at(-1).run()
  const first = feed.getSnapshot()
  body = { ok: true, notModified: true, rev: 'r1' }
  assert.equal(await feed.poll(), true)
  assert.equal(feed.getSnapshot(), first)
  body = { ok: false }
  assert.equal(await feed.poll(), false)
  assert.equal(feed.getSnapshot(), first)
  visible = false
  assert.equal(await feed.poll(), false)
  assert.equal(revisions.length, 3)
  visible = true
  visibilityListener()
  assert.equal(timers.at(-1).ms, 0)
  body = null
  const pending = feed.poll()
  assert.equal(await feed.poll(), false)
  resolve({ ok: true, notModified: true, rev: 'r1' })
  assert.equal(await pending, true)
  assert.deepEqual(revisions, [undefined, 'r1', 'r1', 'r1'])
  const independent = createTaskFeed({
    readSnapshot: async (_signal, rev) => {
      assert.equal(rev, undefined)
      return { ok: true, rev: 'r2', tasks: [] }
    },
    visibility: null,
  })
  await independent.poll()
  assert.equal(feed.getSnapshot(), first)
  off()
})
