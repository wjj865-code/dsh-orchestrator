import { launchChrome, connectPage, waitFor, clickByText, readBadge, sendComposer, sleep, artifacts } from './cdp.mjs'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const URL = process.env.DSH_URL
const OUT = 'C:/Users/72489/AppData/Local/Temp/orch-e2e-artifacts'
const MOCK_SUMMARY = `${OUT}/mock/summary.jsonl`
const TARGET = `${OUT}/task-target`
const results = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data) => { results.steps.push({ name, at: new Date().toISOString(), ...data }); console.log('STEP', name, JSON.stringify(data).slice(0, 400)) }
const mockLines = () => existsSync(MOCK_SUMMARY) ? readFileSync(MOCK_SUMMARY, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const waitMock = async (from, predicate, timeout = 60000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const lines = mockLines().slice(from)
    const hit = lines.find(predicate)
    if (hit) return hit
    await sleep(400)
  }
  return undefined
}

const { base, child } = await launchChrome({ userDataDir: `${OUT}/chrome-profile2`, startUrl: URL })
let page
try {
  page = await connectPage({ base })
  await sleep(4000)
  step('initial', { badge: await readBadge(page) })
  await page.screenshot(`${OUT}/e2e-01-initial.png`)

  // (a) open / create the coordinator session from the sidebar
  const click1 = await clickByText(page, '主会话')
  await sleep(5000)
  const badgeA = await readBadge(page)
  await page.screenshot(`${OUT}/e2e-02-main-badge.png`)
  step('a-main-session-badge', { click: click1, badge: badgeA, url: await page.evaluate('location.href') })

  // baseline model turn: capture the coordinator tool table
  const before = mockLines().length
  await sendComposer(page, 'BASELINE_TOOL_TABLE_CHECK')
  const reqBaseline = await waitMock(before, l => l.toolNames?.includes('task_create'))
  step('b0-coordinator-tools-before', { found: reqBaseline !== undefined, tools: reqBaseline?.toolNames ?? [] })
  await page.screenshot(`${OUT}/e2e-03-baseline-turn.png`)

  // (b) switch permission preset via the /permission command
  const cmdType = await sendComposer(page, '/permission danger-full-access', { submit: false })
  await page.screenshot(`${OUT}/e2e-04-command-typed.png`)
  const menuText = await page.evaluate(`(() => {
    const text = document.body.innerText;
    const idx = text.indexOf('/permission');
    return idx >= 0 ? text.slice(Math.max(0, idx - 120), idx + 300) : text.slice(-600);
  })()`)
  await page.pressKey('Enter')
  await sleep(1800)
  let badgeB = await readBadge(page)
  let composerState = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 0);
    return el ? (el.textContent || '') : null;
  })()`)
  if (badgeB?.text === badgeA?.text) {
    // The slash menu may have consumed the first Enter; submit again.
    await page.pressKey('Enter')
    await sleep(1800)
    badgeB = await readBadge(page)
    composerState = await page.evaluate(`(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find(e => e.getBoundingClientRect().width > 0);
      return el ? (el.textContent || '') : null;
    })()`)
  }
  await page.screenshot(`${OUT}/e2e-05-after-permission.png`)
  step('b1-after-permission', { typed: cmdType, menuText, badge: badgeB, composer: composerState })

  // capture the coordinator tool table AFTER the switch
  const afterSwitch = mockLines().length
  await sendComposer(page, 'AFTER_SWITCH_TOOL_TABLE_CHECK')
  const reqAfter = await waitMock(afterSwitch, l => l.toolNames?.includes('task_create'))
  step('b2-coordinator-tools-after', { found: reqAfter !== undefined, tools: reqAfter?.toolNames ?? [] })
  await page.screenshot(`${OUT}/e2e-06-after-switch-turn.png`)

  // (c) reopen the main session: the plugin re-pins read-only
  const click2 = await clickByText(page, '主会话')
  await sleep(4000)
  const badgeC = await readBadge(page)
  await page.screenshot(`${OUT}/e2e-07-reopened.png`)
  step('c-reopen-badge', { click: click2, badge: badgeC })

  // (d) dispatch a normal task: the worker must still be able to write a file
  const beforeDispatch = mockLines().length
  await sendComposer(page, 'DISPATCH_NOW 请派一个任务')
  const childReq = await waitMock(beforeDispatch, l => Array.isArray(l.toolNames) && l.toolNames.includes('write') && !l.toolNames.includes('task_create'), 60000)
  step('d0-child-tools', { found: childReq !== undefined, tools: childReq?.toolNames ?? [] })
  let wrote = false
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(`${TARGET}/e2e-child.txt`)) { wrote = true; break }
    await sleep(500)
  }
  const fileContent = wrote ? readFileSync(`${TARGET}/e2e-child.txt`, 'utf8') : null
  await page.screenshot(`${OUT}/e2e-08-child-task.png`)
  step('d1-child-write', { wrote, fileContent, target: TARGET })
  results.finishedAt = new Date().toISOString()
  artifacts.writeJson(`${OUT}/e2e-results.json`, results)
  writeFileSync(`${OUT}/e2e-page-text-final.txt`, await page.text(), 'utf8')
} catch (error) {
  step('error', { message: error.message, stack: error.stack })
  try { await page?.screenshot(`${OUT}/e2e-error.png`) } catch {}
  artifacts.writeJson(`${OUT}/e2e-results.json`, results)
  throw error
} finally {
  page?.close()
  child.kill()
}
