// P1-B 迁移契约：工具面 15 → 10 之后，「旧名删了但不静默」这件事必须有断言锁住。
//
// 三件事各一条：
// 1. 旧名**确实不在**工具表里（10 个，名字集合精确相等）；
// 2. 旧名调用有**可读迁移提示**（src/tool-migrations.js → index.js guard，见 test/index.test.js 的 guard 用例）；
// 3. 映射表在 **CHANGELOG / README 各有一处**，且新调用在文档里能照着抄。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openLedger } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { REMOVED_TOOLS, REMOVED_TOOL_NAMES, legacyToolHint } from '../src/tool-migrations.js'
import { tempDir } from './helpers.js'

const EXPECTED_TOOLS = [
  'capability_pack', 'context', 'memory_note', 'plan_save', 'read_workspace', 'task_create',
  'task_detail', 'task_list', 'task_message', 'task_report', 'task_status',
]
const EXPECTED_REMOVED = ['task_stop', 'task_retry', 'task_close', 'task_inbox', 'history_search', 'project_context']

async function makeTools() {
  const db = await openLedger(tempDir())
  const dispatcher = { async spawn() { throw new Error('不该派发') }, async send() {}, async stop() {}, slug: () => 's' }
  const notifier = { push() {} }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1' }
  const queue = createQueue({ db, dispatcher, config })
  return createTools({ db, dispatcher, queue, notifier, config, coordinatorStatus: () => ({ id: 's-1', live: true }) })
}

test('工具面 15 → 10（0.32.0 +capability_pack = 11）：名字集合精确相等，旧名一个都不在', async () => {
  const tools = await makeTools()
  assert.equal(tools.length, 11, 'createTools 必须返回 11 个工具')
  assert.deepEqual(tools.map(tool => tool.name).sort(), EXPECTED_TOOLS)
  for (const removed of EXPECTED_REMOVED) {
    assert.equal(tools.some(tool => tool.name === removed), false, `${removed} 不该还注册着`)
  }
})

test('迁移账：6 个旧名各有一条「旧名 → 新调用」，且新调用真的存在', async () => {
  assert.deepEqual(REMOVED_TOOL_NAMES.sort(), [...EXPECTED_REMOVED].sort())
  const names = new Set((await makeTools()).map(tool => tool.name))
  for (const [legacy, entry] of Object.entries(REMOVED_TOOLS)) {
    const target = /^([a-z_]+)\(/.exec(entry.call)?.[1]
    assert.ok(target !== undefined, `${legacy} 的 call 应形如 tool({...})：${entry.call}`)
    assert.equal(names.has(target), true, `${legacy} 指向的新工具 ${target} 必须存在`)
    const hint = legacyToolHint(legacy)
    assert.match(hint, /已删除/, '提示要说清「已删除」，不能静默')
    assert.ok(hint.includes(`${target}(`), `提示里要能直接抄到新调用（${target}）`)
    assert.equal(hint.includes('\n'), false, '提示保持一行，别把长文档塞进工具返回')
  }
})

test('迁移提示只对旧名生效：新名与无关名返回 undefined', () => {
  for (const name of EXPECTED_TOOLS) assert.equal(legacyToolHint(name), undefined, `${name} 不该有迁移提示`)
  for (const name of ['', 'read', 'wait_agent', 'toString', '__proto__']) {
    assert.equal(legacyToolHint(name), undefined, `${JSON.stringify(name)} 不该有迁移提示`)
  }
})

test('映射表在 CHANGELOG / README 各有一处，且两处都覆盖 6 个旧名', () => {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(changelog, /工具面 15 → 10/)
  assert.match(readme, /工具迁移映射/)
  for (const legacy of EXPECTED_REMOVED) {
    assert.ok(changelog.includes(legacy), `CHANGELOG 迁移表缺少 ${legacy}`)
    assert.ok(readme.includes(legacy), `README 迁移表缺少 ${legacy}`)
    assert.ok(changelog.includes(REMOVED_TOOLS[legacy].call.split(',')[0]), `CHANGELOG 里 ${legacy} 的新调用应可照抄`)
  }
})
