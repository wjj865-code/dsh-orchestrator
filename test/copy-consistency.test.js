// 文案一致性（0.14.1：两段式终态口径 + 预设默认 + present 口径）：brief / 协调者 policy / 通知 / task_detail / README
// 不得出现「done 即终态」「默认立刻 task_close」这类互相打架的措辞。
//
// 为什么单独一个测试文件：这些文案分散在 5 个模块里，逐条断言容易被后续改动悄悄改回去；
// 这里只锁「口径」——默认保持待确认、追问复用原会话、present 1-4 个——不锁具体措辞细节。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderCoordinatorPolicy } from '../index.js'
import { renderBrief } from '../src/brief.js'
import { renderTaskDetail } from '../src/task-detail.js'
import { DELIVERED_HINT, PRESENT_HINT } from '../src/notify.js'
import { DEFAULT_KEEPALIVE_PROMPT } from '../src/keepalive.js'

/** 与两段式终态冲突的旧口径：命中任何一条都说明文案在「done 即结束 / 默认自动关闭」。 */
const CONFLICTS = [
  /默认立刻\s*task_close/,
  /done\s*即(?:任务)?(?:结束|终态|完成)/,
  /报\s*done\s*即/,
  /自动关闭/,
  /1-2 个最关键/,
]

const assertNoConflicts = (name, text) => {
  for (const pattern of CONFLICTS) {
    assert.doesNotMatch(text, pattern, `${name} 出现与两段式终态冲突的旧口径：${pattern}`)
  }
}

test('brief 只引向 task_detail，不越权定义交付/关闭口径', () => {
  const brief = renderBrief({ taskId: 't-1a2b3c4d', access: 'full' })
  assert.match(brief, /【任务编号】t-1a2b3c4d/)
  assert.match(brief, /task_detail/)
  // 交付语义一律在 task_detail / 协调者 policy 里讲，brief 不该出现这些词。
  assert.doesNotMatch(brief, /task_close|delivered|已交付待确认|终态/)
  assertNoConflicts('brief', brief)
})

test('协调者 policy：done 后默认保持待确认，不主动 task_close', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /不是终态/)
  assert.match(policy, /默认\*\*保持待确认、不要主动 task_close\*\*/)
  assert.match(policy, /task_message 追问（复用同一个子会话/)
  assert.match(policy, /超时/)
  assertNoConflicts('COORDINATOR_POLICY', policy)
})

test('task_detail 对子会话讲清：done 只是交付，不是任务结束', () => {
  const detail = renderTaskDetail({
    id: 't-1',
    title: '示例',
    status: 'running',
    brief: { title: '示例', goal: '目标', acceptance: ['验收'] },
  })
  assert.match(detail, /报 done 只是「交付」/)
  assert.match(detail, /已交付待确认/)
  assert.match(detail, /不要自行宣告任务结束/)
  assertNoConflicts('task_detail', detail)
})

test('交付通知口径：默认保持待确认、要改走追问；不再以「确认」开头催关闭', () => {
  assert.match(DELIVERED_HINT, /默认保持待确认/)
  assert.match(DELIVERED_HINT, /task_message 追问/)
  assert.match(DELIVERED_HINT, /task_close/)
  // 旧文案以「确认：task_close」开头，等于每条通知都在催关闭。
  assert.doesNotMatch(DELIVERED_HINT, /^确认：/)
  assertNoConflicts('DELIVERED_HINT', DELIVERED_HINT)
})

test('present 口径：通知里的交付指令与协调者 policy 一致（1-4 个）', () => {
  assert.match(PRESENT_HINT, /1-4 个最关键的/)
  assert.match(renderCoordinatorPolicy({}), /1-4 个最关键的产物/)
  assertNoConflicts('PRESENT_HINT', PRESENT_HINT)
})

test('keep-alive 提示不把 done 说成任务结束', () => {
  assert.match(DEFAULT_KEEPALIVE_PROMPT, /已交付待确认/)
  assertNoConflicts('keep-alive prompt', DEFAULT_KEEPALIVE_PROMPT)
})

test('README 与预设同口径：默认保持待确认、工具数 14、升级要重启', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /默认保持待确认/)
  assert.match(readme, /14 个/)
  assert.match(readme, /刷新页面不会换版本/)
  assert.doesNotMatch(readme, /默认立刻 `?task_close/)
  assert.doesNotMatch(readme, /13 个工具/)
  assertNoConflicts('README', readme)
})

test('原生自动化 policy 与文档锁住真实工具、授权及会话边界', () => {
  const texts = [renderCoordinatorPolicy({}), ...['README.md', 'docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md']
    .map(file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))]
  for (const text of texts) {
    for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']) assert.ok(text.includes(name))
    assert.match(text, /Host-wide/)
    assert.match(text, /明确授权/)
    assert.match(text, /this_session/)
    assert.match(text, /new.*new_once/)
    assert.match(text, /非唯一主/)
    assert.match(text, /(?:默认|default) worker 不(?:开放|新增)/)
    assert.match(text, /full.*不增加工具/)
    assert.match(text, /expectedUpdatedAt/)
  }
})

test('README 只服务使用者：维护者内容放 docs/，仅留链接', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  // 维护者章节（发布/CI/内部架构/开发命令）不该再回到 README。
  assert.doesNotMatch(readme, /^##\s*(版本与发布|架构与安全|开发)\s*$/m)
  assert.doesNotMatch(readme, /release\.yml|npm publish|npm version patch/)
  assert.doesNotMatch(readme, /npm test\s+#|npm run build\s+#/)
  // 指向文档的链接要在。
  for (const doc of ['docs/CONTRIBUTING.md', 'docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md', 'docs/UI.md', 'CHANGELOG.md']) {
    assert.ok(readme.includes(doc), `README 缺少文档链接：${doc}`)
  }
})
