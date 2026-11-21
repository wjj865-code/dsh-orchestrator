// 真机验收探针（t-8a81264c）：隔离 DSH_HOME + 临时 profile + headless Chrome（CDP）
//   1. 打开「能力包」面板 → 点「用这个包开新会话」
//   2. 断言：没有「已建好（…）但打不开」/「开包会话失败」提示；会话切过去且落在「指挥舱」工作区
//   3. 证据：screenshot + result JSON（外部脚本读插件日志与 workspace.json 交叉核对）
import { writeFileSync } from 'node:fs'
import { launchChrome, connectPage, sleep, clickByText } from './cdp.mjs'

const URL = process.env.DSH_URL
const OUT = process.env.PROBE_OUT ?? 'C:/Users/72489/AppData/Local/Temp/orch-packfix-verify'
const base = await launchChrome({
  port: 9333,
  userDataDir: 'C:/Users/72489/AppData/Local/Temp/orch-packfix-chrome-verify',
  startUrl: 'about:blank',
})
const page = await connectPage({ base: base.base, url: URL })
const result = { checks: [], pageText: '', consoleErrors: [] }
const record = (name, ok, detail = {}) => result.checks.push({ name, ok: ok === true, ...detail })
const sleepMs = ms => sleep(ms)

await sleep(4500)
// 首次启动的预览说明卡（「继续」）
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '继续')
  if (el) { el.click(); return true } return false
})()`)
await sleep(1200)

record('panel-entry', (await clickByText(page, '能力包', { exact: false })).ok === true)
await sleep(2200)
const before = await page.text()
record('pack-card-visible', before.includes('用这个包开新会话'))
record('preset-registered', before.includes('预设已注册'))

const clicked = await clickByText(page, '用这个包开新会话', { exact: true })
record('open-button-clicked', clicked.ok === true, { tag: clicked.tag ?? null })

// 打开是异步的：HTTP 建会话 + 客户端等会话目录就绪再跳转（重试最多 ≈1.2s）
for (let index = 0; index < 40; index += 1) {
  await sleepMs(250)
  const text = await page.text()
  if (text.includes('添加文件或调用指令')) break
}
const after = await page.text()
result.pageText = after.slice(0, 2500)

record('no-open-failure', !/打不开|开包会话失败/.test(after))
record('conversation-open', after.includes('描述你想要构建的内容') || after.includes('添加文件或调用指令'))
record('in-cockpit-workspace', after.includes('指挥舱'))
record('no-workspace-placeholder', !after.includes('选择一个工作区开始'))
record('session-tab-title', after.includes('公众号文章'), { packTitle: '公众号文章' })

await page.screenshot(`${OUT}.png`)
result.ok = result.checks.every(check => check.ok === true)
writeFileSync(`${OUT}.json`, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(JSON.stringify(result, null, 2))
await page.close()
base.child.kill()
process.exit(result.ok ? 0 : 1)
