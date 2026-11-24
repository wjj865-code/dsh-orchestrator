// 使用仓库现有零依赖 CDP 客户端，连接临时 DSH web profile。
import { readFileSync, writeFileSync } from 'node:fs'
import { launchChrome, connectPage, clickByText, sendComposer, sleep, waitFor } from '../../reports/main-permission-badge-verify/harness/cdp.mjs'

const root = process.env.ARTIFACT_PROBE_ROOT
const log = readFileSync(process.env.ARTIFACT_PROBE_HOST_LOG, 'utf8')
const url = /dsh web: (http\S+)/.exec(log)?.[1]
if (!url) throw new Error('没有隔离 web URL')
const results = []
const { child, base } = await launchChrome({
  port: 47832, userDataDir: `${root}/chrome`, startUrl: url,
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
let page
try {
  page = await connectPage({ base })
  const clickVisible = async text => {
    const point = await page.evaluate(`(() => { const el = [...document.querySelectorAll('button,a,[role=button]')].find(el=>el.innerText.trim()===${JSON.stringify(text)} && el.getBoundingClientRect().width); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    if (!point) throw new Error(`按钮不可见：${text}`)
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  await waitFor(page, 'document.body.innerText.includes("主会话")', { timeout: 60000 })
  results.push({ check: 'panel-loaded', ok: true })
  if ((await page.text()).includes('预览版说明')) await clickVisible('继续')
  await sleep(1000)
  const api = body => page.evaluate(`fetch('/api/orchestrator', {method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`)
  const opened = await api({ endpoint: 'open-main' })
  results.push({ check: 'open-main', ...opened })
  if (!opened.body.ok) throw new Error(`主会话打开失败：${JSON.stringify(opened.body)}`)
  await clickVisible('主会话')
  await sleep(3000)
  await page.screenshot(`${root}/01-main.png`)
  writeFileSync(`${root}/01-main.txt`, await page.text())
  results.push({ check: 'snapshot', ...(await api({ endpoint: 'snapshot' })) })
  if (!process.env.ARTIFACT_PROBE_INSPECT_ONLY) await sendComposer(page, 'ARTIFACT_WEB_VERIFY 普通非Git任务')
  await sleep(12000)
  results.push({ check: 'ordinary-task', ...(await api({ endpoint: 'snapshot' })) })
  await page.screenshot(`${root}/02-ordinary.png`)
  writeFileSync(`${root}/02-ordinary.txt`, await page.text())
  if (!process.env.ARTIFACT_PROBE_INSPECT_ONLY) await sendComposer(page, 'ARTIFACT_WEB_VERIFY READONLY 只读任务')
  await sleep(12000)
  results.push({ check: 'readonly-task', ...(await api({ endpoint: 'snapshot' })) })
  await page.screenshot(`${root}/03-readonly.png`)
  writeFileSync(`${root}/03-readonly.txt`, await page.text())
  const snapshot = results.at(-1).body
  for (const task of snapshot.tasks ?? []) {
    results.push({ check: 'task-detail', taskId: task.id, ...(await api({ endpoint: 'detail', taskId: task.id })) })
    const artifact = task.artifacts?.find(a => a.path.includes('/docs/'))
    if (artifact) results.push({ check: 'document-preview', taskId: task.id, ...(await api({ endpoint: 'preview', taskId: task.id, path: artifact.path })) })
  }
  const taskButton = await page.evaluate(`(() => {const el=[...document.querySelectorAll('button,a,[role=button]')].find(e=>e.innerText.trim()==='任务' && e.getBoundingClientRect().width);if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  if (taskButton) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...taskButton })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...taskButton })
    await sleep(800)
    await page.screenshot(`${root}/04-tasks.png`)
    writeFileSync(`${root}/04-tasks.txt`, await page.text())
    const card = await page.evaluate(`(() => { const el=document.querySelector('.orch-card'); if(!el)return null; const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    if (card) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...card })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...card })
      await sleep(800)
      await page.screenshot(`${root}/05-detail.png`)
      writeFileSync(`${root}/05-detail.txt`, await page.text())
    }
  }
  writeFileSync(`${root}/snapshot.json`, JSON.stringify(snapshot, null, 2))
  writeFileSync(`${root}/browser.json`, JSON.stringify(results, null, 2))
  console.log('浏览器证据已保存（未输出认证 URL）')
} catch (error) {
  await page?.screenshot(`${root}/browser-error.png`)
  writeFileSync(`${root}/browser-error.txt`, await page?.text() ?? '')
  throw error
} finally {
  page?.close()
  child.kill()
}
