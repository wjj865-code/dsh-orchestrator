import { launchChrome, connectPage, clickByText, readBadge, sendComposer, sleep, artifacts } from './cdp.mjs'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const URL = process.env.DSH_URL
const OUT = 'C:/Users/72489/AppData/Local/Temp/orch-e2e-artifacts'
const MOCK_SUMMARY = `${OUT}/mock/summary.jsonl`
const TARGET = `${OUT}/task-target3`
const results = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data) => { results.steps.push({ name, at: new Date().toISOString(), ...data }); console.log('STEP', name, JSON.stringify(data).slice(0, 500)) }
const mockLines = () => existsSync(MOCK_SUMMARY) ? readFileSync(MOCK_SUMMARY, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const waitMock = async (from, predicate, timeout = 90000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const hit = mockLines().slice(from).find(predicate)
    if (hit) return hit
    await sleep(400)
  }
  return undefined
}

const { base, child } = await launchChrome({ userDataDir: `${OUT}/chrome-profile3`, startUrl: URL })
let page
try {
  page = await connectPage({ base })
  await sleep(4000)
  await clickByText(page, '主会话')
  await sleep(4000)
  step('d-prep', { badge: await readBadge(page) })

  const before = mockLines().length
  await sendComposer(page, 'DISPATCH_NOW 请派一个任务：证明普通子会话仍能写文件')
  const childReq = await waitMock(before, l => Array.isArray(l.toolNames) && l.toolNames.includes('write') && l.toolNames.includes('task_report') && !l.toolNames.includes('schedule_create'), 90000)
  step('d0-child-tools', { found: childReq !== undefined, tools: childReq?.toolNames ?? [] })
  let wrote = false
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(`${TARGET}/e2e-child.txt`)) { wrote = true; break }
    await sleep(500)
  }
  const fileContent = wrote ? readFileSync(`${TARGET}/e2e-child.txt`, 'utf8') : null
  await page.screenshot(`${OUT}/e2e-09-child-task.png`)
  step('d1-child-write', { wrote, fileContent, target: TARGET })
  await sleep(3000)
  results.finishedAt = new Date().toISOString()
  artifacts.writeJson(`${OUT}/e2e-d-results.json`, results)
  writeFileSync(`${OUT}/e2e-page-text-d.txt`, await page.text(), 'utf8')
} catch (error) {
  step('error', { message: error.message, stack: error.stack })
  try { await page?.screenshot(`${OUT}/e2e-d-error.png`) } catch {}
  artifacts.writeJson(`${OUT}/e2e-d-results.json`, results)
  throw error
} finally {
  page?.close()
  child.kill()
}
