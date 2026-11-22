// 驱动隔离的 DSH Web 实例跑 4 条泄漏抽查任务流（mock 模型），并抓取「用户可见文本」样本。
//
// 前置：operator 已起好 mock-llm 与 dsh web（见 README / run-leak-check.ps1），环境变量：
//   DSH_URL  带 token 的 URL（dsh web 启动行打印）
//   E2E_OUT  产物目录（mock 日志、截图、drive-results.json）
import { launchChrome, connectPage, waitFor, clickByText, sendComposer, sleep, artifacts } from './cdp.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const URL = process.env.DSH_URL
const OUT = process.env.E2E_OUT
const HOME = process.env.E2E_HOME
const LEDGER = `${HOME}/state/orchestrator/tasks.sqlite`

const FLOWS = [
  { key: 'LEAK_A', title: '说明文件编写（泄漏抽查 A）', prompt: 'LEAK_A 帮我派一个普通任务：在 target 写一个说明文件，完成后追问一句再收掉。', finalText: '已收尾：说明文件编写' },
  { key: 'LEAK_B', title: '只读核对（泄漏抽查 B）', prompt: 'LEAK_B 派一个只读任务：读 target 里的说明文件并回报。', finalText: '已确认收尾：只读核对' },
  { key: 'LEAK_C', title: '方案选择（泄漏抽查 C）', prompt: 'LEAK_C 派一个任务，让它报 blocked 等我拍板；我选方案A，然后收掉。', finalText: '已收尾：方案选择' },
  { key: 'LEAK_D', title: '分阶段推进（泄漏抽查 D）', prompt: 'LEAK_D 派一个任务，让它连续报两次进度再交付。', finalText: '已收尾：分阶段推进' },
]

const ledgerTaskOf = title => {
  if (!existsSync(LEDGER)) return null
  try {
    const db = new DatabaseSync(LEDGER, { readOnly: true })
    try {
      const row = db.prepare('SELECT id, title, status, read_only FROM tasks WHERE title = ? ORDER BY created_at DESC LIMIT 1').get(title)
      if (row === undefined) return null
      const ref = db.prepare('SELECT token FROM task_refs WHERE task_id = ?').get(String(row.id))?.token ?? null
      const messages = db.prepare('SELECT seq, kind, rendered FROM messages WHERE task_id = ? ORDER BY seq').all(String(row.id))
      const question = db.prepare('SELECT question FROM tasks WHERE id = ?').get(String(row.id))?.question ?? null
      return { id: String(row.id), status: String(row.status), readOnly: Number(row.read_only) === 1, ref, question, messages: messages.map(m => ({ seq: Number(m.seq), kind: String(m.kind), rendered: String(m.rendered) })) }
    } finally { db.close() }
  } catch (error) {
    return { error: String(error.message ?? error) }
  }
}

const results = { startedAt: new Date().toISOString(), url: URL, flows: [] }
const log = (...args) => console.log(...args)

const { child } = await launchChrome({ port: 9541, userDataDir: `${OUT}/chrome`, startUrl: URL })
let page
try {
  page = await connectPage({ base: 'http://127.0.0.1:9541' })
  await sleep(4000)
  await page.screenshot(`${OUT}/screenshots/00-initial.png`)

  // 关掉首启的「预览版说明」浮层（否则输入框被遮住，消息发不出去）
  try {
    const cont = await clickByText(page, '继续', { exact: true })
    log('click 继续:', JSON.stringify(cont))
  } catch (error) {
    log('click 继续 failed:', String(error.message ?? error))
  }
  await sleep(2500)

  // 打开主会话（协调者）
  const clicked = await clickByText(page, '主会话', { exact: true })
  log('click 主会话:', JSON.stringify(clicked))
  await sleep(5000)
  await waitFor(page, "!!document.querySelector('[contenteditable=\"true\"], textarea')", { timeout: 60000 })
  await page.screenshot(`${OUT}/screenshots/01-main-session.png`)
  log('main session text head:', (await page.text()).slice(0, 200).replaceAll('\n', ' | '))

  for (const [index, flow] of FLOWS.entries()) {
    const flowResult = { key: flow.key, title: flow.title, prompt: flow.prompt, steps: [] }
    log(`--- ${flow.key} ---`)
    await sendComposer(page, flow.prompt)
    // 等最终收尾回复出现（含任务名），再等台账落到终态。
    try {
      await waitFor(page, `document.body.innerText.includes(${JSON.stringify(flow.finalText)})`, { timeout: 240000 })
      flowResult.steps.push({ name: 'final-reply-visible', ok: true })
    } catch (error) {
      flowResult.steps.push({ name: 'final-reply-visible', ok: false, error: String(error.message ?? error), bodyTail: (await page.text()).slice(-1500) })
    }
    await sleep(1500)
    // 等台账落到 done（面板/详情读到的最终状态），最多 90s
    let task = ledgerTaskOf(flow.title)
    for (let i = 0; i < 90 && (task === null || task.error !== undefined || task.status !== 'done'); i += 1) {
      await sleep(1000)
      task = ledgerTaskOf(flow.title)
    }
    flowResult.task = task
    flowResult.taskDone = task !== null && task.error === undefined && task.status === 'done'
    // 页面可见文本（用户眼前实际看到的内容）
    flowResult.pageText = await page.text()
    await page.screenshot(`${OUT}/screenshots/02-flow-${index + 1}-${flow.key}.png`)
    log('task:', JSON.stringify(task === null ? null : { id: task.id, status: task.status, ref: task.ref, messages: task.messages?.length }))
    results.flows.push(flowResult)
    // 相邻两条流之间留一点时间，让通知/结算收尾
    await sleep(2500)
  }

  // 打开任务面板取证（面板也是用户可见文本的一部分）
  try {
    const opened = await clickByText(page, '任务', { exact: true })
    log('click 任务面板:', JSON.stringify(opened))
    await sleep(3000)
    await page.screenshot(`${OUT}/screenshots/03-task-panel.png`)
    results.panelOpen = opened
    results.panelText = await page.text()
  } catch (error) {
    results.panelError = String(error.message ?? error)
  }
  results.finishedAt = new Date().toISOString()
  artifacts.writeJson(`${OUT}/drive-results.json`, results)
  log('drive done')
} catch (error) {
  results.error = String(error?.stack ?? error)
  results.finishedAt = new Date().toISOString()
  if (OUT !== undefined) {
    try { artifacts.writeJson(`${OUT}/drive-results.json`, results) } catch { /* 收尾失败不遮原始错误 */ }
    try { await page?.screenshot(`${OUT}/screenshots/99-error.png`) } catch { /* 同上 */ }
  }
  console.error(error)
  process.exitCode = 1
} finally {
  try { page?.close() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
}
