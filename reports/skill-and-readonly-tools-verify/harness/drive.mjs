// Full 0.26.0 e2e drive: skills + read-only tool surface + progress notifications + permission badge.
// Runs against a throwaway DSH_HOME / profile / port started by the operator (see harness/README in the
// report). Writes step results to <OUT>/drive-results.json and screenshots to <OUT>.
import { launchChrome, connectPage, waitFor, clickByText, readBadge, sendComposer, sleep, artifacts } from './cdp.mjs'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

const URL = process.env.DSH_URL
const OUT = process.env.E2E_OUT
const TARGETS = {
  ro: `${process.env.E2E_BASE}/targets/target-ro`,
  normal: `${process.env.E2E_BASE}/targets/target-normal`,
  outside: `${process.env.E2E_BASE}/outside-full/out.txt`,
}
const summaryLines = () => existsSync(`${OUT}/mock/summary.jsonl`) ? readFileSync(`${OUT}/mock/summary.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const decisionLines = () => existsSync(`${OUT}/mock/decisions.jsonl`) ? readFileSync(`${OUT}/mock/decisions.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const requestsOf = () => existsSync(`${OUT}/mock/requests.jsonl`) ? readFileSync(`${OUT}/mock/requests.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

const results = { startedAt: new Date().toISOString(), steps: [] }
const step = (name, data) => {
  results.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log('STEP', name, JSON.stringify(data).slice(0, 700))
}
const waitLine = async (predicate, { from = 0, timeout = 120000, poll = 300 } = {}) => {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = summaryLines().slice(from).find(predicate)
    if (last !== undefined) return last
    await sleep(poll)
  }
  return undefined
}
const toolResultTexts = (requests, fromRequest, kind, scn) => {
  const texts = []
  for (const request of requests.slice(fromRequest)) {
    if (kind !== undefined && request.kind !== kind) continue
    if (scn !== undefined && request.scn !== scn) continue
    for (const message of request.body?.messages ?? []) {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type !== 'tool_result') continue
        const text = Array.isArray(block.content)
          ? block.content.map(item => item?.text ?? '').join('\n')
          : String(block.content ?? '')
        texts.push(text)
      }
    }
  }
  return texts
}

const { base, child } = await launchChrome({ port: 9533, userDataDir: `${OUT}/chrome`, startUrl: URL })
let page
try {
  page = await connectPage({ base })
  await sleep(4000)
  step('0-initial', { badge: await readBadge(page) })
  await page.screenshot(`${OUT}/01-initial.png`)

  // ——— 1. open the coordinator session (main) ———
  const clickMain = await clickByText(page, '主会话')
  await sleep(5000)
  const badgeMain = await readBadge(page)
  step('1-main-badge', { click: clickMain, badge: badgeMain })
  await page.screenshot(`${OUT}/02-main-badge-readonly.png`)

  // ——— 2. coordinator tool table + skill catalog ———
  let from = summaryLines().length
  let fromRequest = requestsOf().length
  await sendComposer(page, 'CHECK_TOOLS 采集协调者工具表（0.26.0 验证）')
  const toolsReq = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('CHECK_TOOLS'), { from })
  step('2-coordinator-tools', {
    found: toolsReq !== undefined,
    tools: toolsReq?.toolNames ?? [],
    catalogSkills: toolsReq?.catalogSkills ?? [],
    catalogHasGrillMe: toolsReq?.catalogHasGrillMe === true,
  })
  await page.screenshot(`${OUT}/03-coordinator-tools.png`)

  // ——— 3. read target artifact + installed skills file; load grill-me ———
  from = summaryLines().length
  fromRequest = requestsOf().length
  await sendComposer(page, 'READ_TESTS 读取 target 产物与技能文件')
  await waitFor(page, `document.body.innerText.includes('READ_OK')`, { timeout: 120000 })
  await sleep(500)
  const readTexts = toolResultTexts(requestsOf(), fromRequest, 'coordinator')
  step('3-read-tools', {
    results: readTexts.map(text => text.slice(0, 400)),
    readArtifact: readTexts.some(text => text.includes('artifact-from-target-main')),
    readSkillFile: readTexts.some(text => text.includes('# grill-me')),
    skillLoaded: readTexts.some(text => /skill|grill-me/i.test(text) && text.includes('决策记录')),
  })
  await page.screenshot(`${OUT}/04-read-tools.png`)

  // ——— 4. read-only task: write must be sandbox-denied, and grill-me must be invisible ———
  from = summaryLines().length
  fromRequest = requestsOf().length
  await sendComposer(page, 'DISPATCH_RO 派一个只读任务：验证写被拒、技能不可见')
  const roWorker = await waitLine(l => l.kind === 'worker' && l.scn === 'readonly-deny', { from, timeout: 30000 })
  step('4a-readonly-worker', { found: roWorker !== undefined, tools: roWorker?.toolNames ?? [], catalogSkills: roWorker?.catalogSkills ?? [], catalogHasGrillMe: roWorker?.catalogHasGrillMe === true })
  const roNotify = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('只读写拒绝'), { from, timeout: 150000 })
  const roTexts = toolResultTexts(requestsOf(), fromRequest, 'worker', 'readonly-deny')
  step('4b-readonly-results', {
    notified: roNotify !== undefined,
    notification: roNotify?.trigger?.slice(0, 300) ?? null,
    fileExists: existsSync(`${TARGETS.ro}/ro-blocked.txt`),
    writeDenial: roTexts.find(text => text.includes('sandbox: file access denied'))?.slice(0, 400) ?? null,
    skillDenial: roTexts.find(text => /is unknown or no longer available/i.test(text))?.slice(0, 300) ?? null,
  })
  await page.screenshot(`${OUT}/05-readonly-task.png`)

  // ——— 5. normal task still workspace-write ———
  from = summaryLines().length
  await sendComposer(page, 'DISPATCH_NORMAL 派一个普通任务：验证 workspace-write')
  await waitLine(l => l.kind === 'worker' && l.scn === 'normal-write', { from, timeout: 30000 })
  const normalNotify = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('普通写文件'), { from, timeout: 150000 })
  let normalWrote = false
  for (let i = 0; i < 60; i += 1) { if (existsSync(`${TARGETS.normal}/worker-ok.txt`)) { normalWrote = true; break } await sleep(400) }
  step('5-normal-task', { notified: normalNotify !== undefined, wrote: normalWrote, content: normalWrote ? readFileSync(`${TARGETS.normal}/worker-ok.txt`, 'utf8') : null })
  await page.screenshot(`${OUT}/06-normal-task.png`)

  // ——— 6. progress: merge window, watermark, trailing edge, follow-up must-deliver ———
  from = summaryLines().length
  await sendComposer(page, 'DISPATCH_PROGRESS 派一个连续报进度的任务')
  await waitLine(l => l.kind === 'worker' && l.scn === 'progress', { from, timeout: 30000 })
  const progressNotify1 = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('进度 1/2'), { from, timeout: 90000 })
  step('6a-progress-merged', { notified: progressNotify1 !== undefined, at: progressNotify1?.at, trigger: progressNotify1?.trigger?.slice(0, 400) ?? null })
  const progressNotify2 = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('进度 2/2'), { from, timeout: 90000 })
  step('6b-progress-watermark-trailing', { notified: progressNotify2 !== undefined, at: progressNotify2?.at, trigger: progressNotify2?.trigger?.slice(0, 400) ?? null })
  await page.screenshot(`${OUT}/07-progress.png`)

  // follow-up: the answer to 「先给部分结论」 must arrive immediately
  from = summaryLines().length
  await sendComposer(page, 'FOLLOWUP 追问进度任务：先给部分结论')
  const answeredNotify = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('回答你的追问'), { from, timeout: 90000 })
  step('6c-progress-answered-followup', { notified: answeredNotify !== undefined, at: answeredNotify?.at, trigger: answeredNotify?.trigger?.slice(0, 400) ?? null })
  await page.screenshot(`${OUT}/08-progress-followup.png`)

  // ——— 7. status grading regression: done / blocked / needs_auth ———
  // Let the progress task's one-off stalled notice leave the merge window first, so the done
  // notification is a clean single-task batch (otherwise both merge into one "2 个任务状态更新" message).
  await sleep(6000)
  const statusSteps = []
  for (const [keyword, scn, titleNeedle, kindNeedle] of [
    ['DISPATCH_DONE', 'done', 'E2E done 分级', '已交付待确认'],
    ['DISPATCH_BLOCKED', 'blocked', 'E2E blocked 分级', '需要你'],
    ['DISPATCH_NEEDS_AUTH', 'needs-auth', 'E2E needs_auth 分级', '需要你'],
  ]) {
    from = summaryLines().length
    await sendComposer(page, `${keyword} 派任务验证 ${scn} 分级`)
    await waitLine(l => l.kind === 'worker' && l.scn === scn, { from, timeout: 30000 })
    const notify = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes(titleNeedle) && l.trigger.includes(kindNeedle), { from, timeout: 90000 })
    statusSteps.push({ scn, notified: notify !== undefined, at: notify?.at, trigger: notify?.trigger?.slice(0, 400) ?? null })
    await sleep(1200)
  }
  step('7-status-grading', { items: statusSteps })
  await page.screenshot(`${OUT}/09-status-grading.png`)

  // ——— 8. danger-full-access sandbox semantics control (write outside target) ———
  from = summaryLines().length
  await sendComposer(page, 'DISPATCH_FULL 派一个完整访问任务：验证 danger-full-access 写盘')
  await waitLine(l => l.kind === 'worker' && l.scn === 'full-write', { from, timeout: 30000 })
  const fullNotify = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('完整访问写盘'), { from, timeout: 150000 })
  let outsideWrote = false
  for (let i = 0; i < 60; i += 1) { if (existsSync(TARGETS.outside)) { outsideWrote = true; break } await sleep(400) }
  step('8-full-access-write', { notified: fullNotify !== undefined, wroteOutside: outsideWrote, content: outsideWrote ? readFileSync(TARGETS.outside, 'utf8') : null })
  await page.screenshot(`${OUT}/10-full-access-write.png`)

  // ——— 9. user switches the main session to danger-full-access ———
  await sleep(1500)
  const beforeSwitch = summaryLines().length
  await sendComposer(page, '/permission danger-full-access', { submit: false })
  await page.screenshot(`${OUT}/11-permission-typed.png`)
  await page.pressKey('Enter')
  await sleep(1800)
  let badgeFull = await readBadge(page)
  if (badgeFull?.text === badgeMain?.text) {
    await page.pressKey('Enter')
    await sleep(1800)
    badgeFull = await readBadge(page)
  }
  await page.screenshot(`${OUT}/12-permission-full.png`)
  step('9a-switched', { badge: badgeFull })

  from = summaryLines().length
  await sendComposer(page, 'AFTER_SWITCH 切换后工具表对照')
  const toolsAfter = await waitLine(l => l.kind === 'coordinator' && l.trigger.includes('AFTER_SWITCH'), { from })
  step('9b-tools-after-switch', {
    found: toolsAfter !== undefined,
    tools: toolsAfter?.toolNames ?? [],
    sameAsBefore: JSON.stringify(toolsAfter?.toolNames ?? []) === JSON.stringify(toolsReq?.toolNames ?? []),
    added: (toolsAfter?.toolNames ?? []).filter(name => !(toolsReq?.toolNames ?? []).includes(name)),
  })
  await page.screenshot(`${OUT}/13-after-switch.png`)

  // ——— 10. reopen the main session: permission pinned back to read-only ———
  const clickReopen = await clickByText(page, '主会话')
  await sleep(5000)
  const badgeReopened = await readBadge(page)
  step('10-reopened', { click: clickReopen, badge: badgeReopened })
  await page.screenshot(`${OUT}/14-reopened-readonly.png`)

  results.finishedAt = new Date().toISOString()
  artifacts.writeJson(`${OUT}/drive-results.json`, results)
  await page.text().then(text => writeFileSync(`${OUT}/page-text-final.txt`, text, 'utf8'))
  console.log('DRIVE OK')
} catch (error) {
  step('error', { message: error.message, stack: error.stack })
  try { await page?.screenshot(`${OUT}/99-error.png`) } catch {}
  try { artifacts.writeJson(`${OUT}/drive-results.json`, results) } catch {}
  throw error
} finally {
  page?.close()
  child.kill()
}
