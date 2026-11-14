// 侧栏 nav 槽位探针：从已安装 asar 取平台侧栏/布局源码，核对「插件」下方可插入什么、点击走哪条路径。
// 用法：node docs/probes/sidebar-nav-probe.mjs [app.asar 路径] [ds-bot client.js 路径]
import { readFileSync, existsSync } from 'node:fs'

const ASAR = process.argv[2] ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const DSBOT = process.argv[3] ?? 'C:/Users/72489/.dsh/profiles/desktop/node_modules/ds-bot/client.js'

const bytes = readFileSync(ASAR)
// asar 数据区起点按 4 字节对齐（rc.3 的 headerSize 会落成 16+hs ≡ 1 mod 4）。
const headerSize = bytes.readUInt32LE(12)
const dataStart = Math.ceil((16 + headerSize) / 4) * 4
const header = JSON.parse(bytes.slice(16, 16 + headerSize).toString('utf8'))
const files = []
const collect = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) collect(entry, path)
    else files.push({ path, offset: Number(entry.offset), size: Number(entry.size) })
  }
}
collect(header, '')
const fileOf = suffix => {
  const hits = files.filter(item => item.path.endsWith(suffix))
  if (hits.length !== 1) throw new Error(`文件不唯一或缺失：${suffix}（${hits.length}）`)
  return hits[0]
}
const read = suffix => {
  const file = fileOf(suffix)
  return bytes.slice(dataStart + file.offset, dataStart + file.offset + file.size).toString('utf8')
}

const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'
const LAYOUT = '@deepseek-ai/dsh-client-ui-layout/lib/client.js'
const PLUGINS = '@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js'
const SCHEDULE = '@deepseek-ai/dsh-client-ui-schedule/lib/client.js'
const CONTRACT = '@deepseek-ai/dsh-cordis-client-runner/lib/client.js'

const results = []
const check = (label, file, needle, { absent = false } = {}) => {
  const text = read(file)
  const at = text.indexOf(needle)
  const hit = absent ? at === -1 : at !== -1
  results.push({ label, file, hit })
  console.log(`${hit ? 'PASS' : 'FAIL'} ${label}（${file}${at === -1 ? '' : ` @${at}`}）`)
  return hit
}

console.log(`asar: ${ASAR}\n`)
console.log('## 1. 槽位契约：sidebar.panellist 是「全局面板图标列表」')
check('sidebar 注册 panellist 为 list 槽位', SIDEBAR, '"sidebar.panellist":{kind:`list`,scope:`root`}')
check('契约文档：id 对应一个 main 面板（Each list id addresses the matching main panel）', CONTRACT, 'Each list id addresses the matching main panel')
check('条目按 order 升序排序', SIDEBAR, 'sort((a,b)=>a.order-b.order)')
check('label 由槽位元数据解析（resolveSlotLabel）', SIDEBAR, 'resolveSlotLabel)(options.label)')

console.log('\n## 2. 点击行为：固定走 selectPanel(id)')
check('面板行点击 = selectPanel(id)', SIDEBAR, 'onClick:()=>{const entry=officialEntry(id);if(entry!==void 0)trackEntryClick({menu_name:entry,position:`sidebar`});selectPanel(id)}')
check('「更多」菜单同样 selectPanel', SIDEBAR, 'onOpen:id=>{const entry=officialEntry(id);if(entry!==void 0)trackEntryClick({menu_name:entry,position:`sidebar_more`});const panel=panels.find(candidate=>candidate.id===id);if(panel!==void 0)selectPanel(panel.id)}')
check('injectProps.selectPanel 直连 ctx.layout.selectPanel', SIDEBAR, 'selectPanel:id=>{ctx.layout.selectPanel(id)}')

console.log('\n## 3. 清空面板 / 回到对话')
check('selectPanel 允许 null（只对非 null 校验已注册）', LAYOUT, 'selectPanel(panelId){if(panelId!==null&&!this.hasMainPanel(panelId))throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)')
check('activePanelId=null 存进 store', LAYOUT, 'selectPanel:(d,panelId)=>{d.panelInfo.activePanelId=panelId;')
check('main 槽位 entryKey：null 时回落 conversation', LAYOUT, 'renderSlot(`main`,{},{entryKey:panelId??`conversation`})')

console.log('\n## 4. 现有面板条目的 id 与顺序（决定插在「插件」下面）')
check('插件面板 id=plugins、order=0', PLUGINS, 'name:`sidebar.panellist`,id:PANEL_ID,order:0,label:()=>t(`panel`)')
check('自动化任务面板 order=10', SCHEDULE, 'name:`sidebar.panellist`,id:PANEL_ID,order:10,locale:MANAGER_NS,label:()=>t(`panel`)')
check('panellist 条目组件由 PanelIcon 按 id 渲染（renderSlot 只取该 id）', SIDEBAR, 'function PanelIcon({id,size,active,renderSlot}){return renderSlot(`sidebar.panellist`,{size,active},{only:id})}')
check('「更多」仅当 sidebar.panellist.actions 有条目时出现', SIDEBAR, 'entriesOfSlot(`sidebar.panellist.actions`).length>0')

console.log('\n## 5. ds-bot 冲突核对')
if (existsSync(DSBOT)) {
  const dsbot = readFileSync(DSBOT, 'utf8')
  const needle = 'nav[class*="_panelList"]'
  const at = dsbot.indexOf(needle)
  const hidden = at !== -1
  results.push({ label: 'ds-bot 在 Bot 表面隐藏 panelList', file: 'ds-bot/client.js', hit: hidden })
  console.log(`${hidden ? 'PASS' : 'FAIL'} ds-bot 含 [class*="_panelList"] 隐藏规则（ds-bot/client.js${at === -1 ? '' : ` @${at}`}）`)
  const footer = dsbot.includes('shadow("sidebar.footer.action"')
  results.push({ label: 'ds-bot 保留 footer action', file: 'ds-bot/client.js', hit: footer })
  console.log(`${footer ? 'PASS' : 'FAIL'} ds-bot 在 footer action 注册自己的 bot-return/bot-account`)
} else {
  console.log(`SKIP ds-bot 路径不存在：${DSBOT}`)
}

const failed = results.filter(item => !item.hit)
console.log(`\n结果：${results.length - failed.length}/${results.length} PASS`)
if (failed.length > 0) {
  for (const item of failed) console.log(`- 未命中：${item.label}（${item.file}）`)
  process.exit(1)
}
