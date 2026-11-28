// 三个界面缺陷的回归守卫（0.37.1：弹窗蒙层层级 / 任务组看板间距 / 组页顶部按钮间距）。
//
// 为什么另起一个文件：client.test.js 是面板的通用守卫（锁定 .orch-metric 数量、token 集合等），
// client-workbench.test.js 锁工作台纯逻辑；这三处是**这一轮修复的界面契约**，单列一份最省事，
// 也不会把既有守卫的锁定项搅在一起。
//
// 口径：CSS 断言读源码 client/src/styles.css，同时读**产物** dist/client.js —— 后者保证
// 「改了源码没重建产物」不会蒙混过关（插件运行时只加载 dist/client.js）。JSX 结构读源码
// （.js 里的 JSX 只有 vite 能编译，node --test 不能 import）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const styles = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../client/src/workbench.js', import.meta.url), 'utf8')
const views = readFileSync(new URL('../client/src/views.js', import.meta.url), 'utf8')
const packs = readFileSync(new URL('../client/src/capability-packs.js', import.meta.url), 'utf8')
const artifact = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 取某个选择器自己的规则块（`^` 或上一条规则的 `}` 之后才算规则起点，`.orch-dialog` 不会命中 `.orch-dialog-layer`）。 */
const ruleOf = (css, selector) => {
  const pattern = new RegExp(`(?:^|[}])\\s*${escapeRe(selector)}\\s*\\{`, 'm')
  const found = pattern.exec(css)
  assert.ok(found, `styles.css 缺少规则 ${selector}`)
  const start = found.index + found[0].length
  return css.slice(start, css.indexOf('}', start))
}

/** 规则块 → 声明表（`.orch-x { a: 1; b: 2 }` → { a: '1', b: '2' }）；注释先剥掉（注释里也会有冒号/分号）。 */
const declarationsOf = (css, selector) => {
  const declarations = {}
  const body = ruleOf(css, selector).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const part of body.split(';')) {
    const at = part.indexOf(':')
    if (at === -1) continue
    declarations[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return declarations
}

const px = value => Number.parseFloat(value ?? '')

// ---------------------------------------------------------------------------
// 问题 1：确认弹窗被蒙层压住（弹窗 static、scrim absolute → scrim 后画，整块弹窗发灰）。
// 浏览器级实测（reports/ui-fixes/evidence/before/dialog.json）：改前 .orch-dialog 是
// position: static / z-index: auto，弹窗中心的 elementFromPoint 命中的是 .orch-scrim。
// ---------------------------------------------------------------------------
test('弹窗层级：dialog 定位且 z-index 高于 scrim，两者同级、dialog 不在 scrim 子树里', () => {
  const dialog = declarationsOf(styles, '.orch-dialog')
  const scrimInLayer = declarationsOf(styles, '.orch-dialog-layer .orch-scrim')
  const layer = declarationsOf(styles, '.orch-dialog-layer')
  assert.equal(dialog.position, 'relative', '.orch-dialog 必须定位，否则 static 盒子会被后画的 scrim 盖住')
  assert.equal(dialog['z-index'], '1')
  assert.equal(scrimInLayer['z-index'], '0', '弹层里的 scrim 显式压到 0，与 dialog 的 1 组成确定的顺序')
  assert.equal(layer.position, 'absolute')
  assert.equal(layer['z-index'], '4', '弹层要压在抽屉层（.orch-layer=3）之上')
  // 结构：scrim 自闭合，紧跟着同级的 section[role=alertdialog] —— 不是父子关系。
  assert.match(
    views,
    /<div className="orch-scrim" data-open="true"[^>]*\/>\s*<section className="orch-dialog"/,
    'scrim 与 dialog 必须是同级兄弟（scrim 自闭合，后面紧跟 section.orch-dialog）',
  )
  // 六个确认场景共用同一个 ConfirmDialog，所以 el 的层叠只在这一处定义（不许某页自己再造一份）。
  assert.equal((views.match(/className="orch-dialog-layer"/g) ?? []).length, 1, '弹层容器只应有一处（唯一确认实现）')
  assert.equal((workbench.match(/<ConfirmDialog/g) ?? []).length, 3, '工作台三个二次确认都复用同一个 ConfirmDialog')
})

test('弹窗层级：产物 dist/client.js 已同步（改源码没重建会被这条挡下）', () => {
  assert.match(artifact, /\.orch-dialog\s*\{[^}]*?position:\s*relative/, '产物里 .orch-dialog 仍缺 position: relative')
  assert.match(artifact, /\.orch-dialog\s*\{[^}]*?z-index:\s*1\b/, '产物里 .orch-dialog 仍缺 z-index: 1')
  assert.match(artifact, /\.orch-dialog-layer\s+\.orch-scrim\s*\{[^}]*?z-index:\s*0/, '产物里缺少 .orch-dialog-layer .orch-scrim 的 z-index: 0')
})

test('弹窗层级：组卡里的确认弹层提到页面层（卡是 role=button，且已归档卡 opacity 0.6）', () => {
  const card = workbench.slice(workbench.indexOf('const GroupCard ='), workbench.indexOf('const GroupsPage ='))
  const page = workbench.slice(workbench.indexOf('const GroupsPage ='), workbench.indexOf('const PlanControl ='))
  assert.equal((card.match(/<ConfirmDialog/g) ?? []).length, 0,
    '组卡里不许再挂弹层：卡是 role=button（点弹窗会冒泡成「打开这个组」），已归档卡 opacity 0.6 还会把弹窗一起压暗')
  assert.equal((page.match(/<ConfirmDialog/g) ?? []).length, 1, '归档确认应渲染在任务组页的页面根上')
  assert.match(card, /onAskArchive\(group\)/, '组卡只负责请求确认，不自己渲染弹层')
  assert.match(page, /onAskArchive=\{setPendingArchive\}/)
})

// ---------------------------------------------------------------------------
// 问题 2：看板「贴死」。浏览器实测（evidence/before/board.json）：
// 列间 8、卡间 6、列头↔卡 6；滚到底时最后一行 bottom 贴到面板底边（收尾留白 0 ——
// 组页作为 flex 子项被压缩，看板溢出页面盒，bottom padding 被吃掉）。
// ---------------------------------------------------------------------------
test('看板间距：列间 ≥8、卡间 ≥8、列头与卡 ≥8，且组页不被压缩、底部留收尾留白', () => {
  const board = declarationsOf(styles, '.orch-wb-board')
  const column = declarationsOf(styles, '.orch-wb-column')
  const colbody = declarationsOf(styles, '.orch-wb-column .orch-wb-colbody')
  const page = declarationsOf(styles, '.orch-wb-grouppage')
  assert.ok(px(board.gap) >= 8, `看板列间隙应 ≥8px，实际 ${board.gap}`)
  assert.equal(px(board.gap), 12, '列间用 12（与 .orch-wb-cols / .orch-wb-split 同档）')
  assert.ok(px(column.gap) >= 8, `列头与卡片间隙应 ≥8px，实际 ${column.gap}`)
  assert.ok(px(colbody.gap) >= 8, `列内卡片间隙应 ≥8px，实际 ${colbody.gap}`)
  // 组页整块不参与 flex 收缩（flex: 0 0 auto）——收缩会让最后一行溢出页面盒、底部留白归零。
  assert.equal(page.flex, '0 0 auto')
  // 收尾留白写在页面自己身上：滚动容器的 padding-bottom 在内容溢出时不计入滚动区（实测 = 0）。
  assert.ok(px(page['padding-bottom']) >= 24, `组页收尾留白应 ≥24px，实际 ${page['padding-bottom']}`)
  assert.match(artifact, /\.orch-wb-board\s*\{[^}]*?gap:\s*12px/, '产物里看板列间仍是旧值')
})

test('任务组导航与页面内容：保留 12px 纵向间距，不再让导航贴住首排组卡', () => {
  const shell = declarationsOf(styles, '.orch-wb-shell')
  assert.equal(shell.gap, 'var(--orch-gap-4)', '工作台壳层要用 12px 间距 token，0 会让导航与页面根贴死')
  assert.match(styles, /--orch-gap-4:\s*12px/, '间距 token 必须与页面块间距同为 12px')
  assert.match(artifact, /\.orch-wb-shell\s*\{[^}]*?gap:\s*var\(--orch-gap-4\)/,
    '产物里 .orch-wb-shell 仍为 0：改了源码没重建 dist/client.js')
})

test('排期月份切换：上个月用左箭头、下个月用右箭头，不再共用下箭头', () => {
  const start = workbench.indexOf('<header className="orch-wb-calhead">')
  assert.ok(start !== -1, '排期页头没找到')
  const header = workbench.slice(start, workbench.indexOf('</header>', start))
  assert.match(header, /aria-label="上个月"[\s\S]{0,160}<Icon name="chevronLeft"/, '上个月按钮应使用左箭头')
  assert.match(header, /aria-label="下个月"[\s\S]{0,160}<Icon name="chevronRight"/, '下个月按钮应使用右箭头')
  assert.doesNotMatch(header, /style=\{\{\s*transform:\s*'rotate\(-?90deg\)'/, '不要再用被 Icon 丢弃的 inline transform')
  assert.match(artifact, /chevronLeft:\["M15 6l-6 6 6 6"\]/, '产物里缺少左箭头图标')
  assert.match(artifact, /chevronRight:\["M9 6l6 6-6 6"\]/, '产物里缺少右箭头图标')
})

test('自动化页头工具区：刷新与官方页并排，不再单独挂在卡尾', () => {
  const pageStart = workbench.indexOf('const AutomationsPage =')
  assert.ok(pageStart !== -1, '自动化页没找到')
  const start = workbench.indexOf('<header className="orch-wb-cardhead">', pageStart)
  const header = workbench.slice(start, workbench.indexOf('</header>', start))
  assert.match(header, /className="orch-btn orch-btn--ghost orch-btn--sm orch-wb-refresh"[\s\S]{0,180}<Icon name="refresh"/,
    '刷新应是带刷新图标的描边按钮')
  assert.match(header, /className="orch-btn orch-btn--ghost orch-btn--sm orch-wb-official"[\s\S]{0,220}<Icon name="external"/,
    '官方页入口应是带外链图标的描边按钮')
  assert.match(header, /<span>\{'刷新'\}<\/span>/, '刷新按钮要有可读文字')
  assert.match(header, /<span>\{'官方自动化任务页'\}<\/span>/, '官方页按钮要有可读文字')
  assert.doesNotMatch(workbench, /orch-wb-cardfoot/, '卡尾工具区应移除，避免入口孤零零挂在底部')
  const official = declarationsOf(styles, '.orch-wb-official')
  const refresh = declarationsOf(styles, '.orch-wb-refresh')
  assert.equal(official.background, 'var(--orch-surface-2)', '官方页入口要有浅底，和卡尾文字区分')
  assert.equal(official['border-color'], 'var(--orch-line-strong)', '官方页入口要有可见描边')
  assert.equal(refresh.background, 'var(--orch-surface-2)', '刷新按钮要和官方页入口同档')
  assert.equal(refresh['border-color'], 'var(--orch-line-strong)', '刷新按钮要有可见描边')
  assert.match(artifact, /\.orch-wb-official[^{}]*\{[^}]*?background:\s*var\(--orch-surface-2\)/,
    '产物里缺官方页入口样式：改了源码没重建 dist/client.js')
  assert.match(artifact, /\.orch-wb-refresh[^{}]*\{[^}]*?background:\s*var\(--orch-surface-2\)/,
    '产物里缺刷新按钮样式：改了源码没重建 dist/client.js')
})

test('自动化到期话术：22 高 ghost 折叠按钮，统一 chevron，开合文案切换', () => {
  const start = workbench.indexOf('<details className="orch-wb-details">')
  assert.ok(start !== -1, '到期话术折叠区没找到')
  const details = workbench.slice(start, workbench.indexOf('</details>', start))
  assert.match(details, /<summary className="orch-btn orch-btn--ghost orch-btn--sm orch-wb-details-summary">/,
    '展开按钮应复用 22 高 ghost 档，而不是浏览器默认 summary')
  assert.match(details, /<Icon name="chevron" size=\{12\} className="orch-wb-details-caret"/,
    '展开按钮应使用统一 chevron 图标')
  assert.match(details, /查看到期话术/, '收起态文案应为「查看到期话术」')
  assert.match(details, /收起到期话术/, '展开态文案应为「收起到期话术」')
  assert.doesNotMatch(details, />看到期话术</, '不应再使用生硬的「看到期话术」')
  assert.match(details, /<pre className="orch-pre orch-wb-prompt">/, '话术正文要有独立间距样式')
  const summary = declarationsOf(styles, '.orch-wb-details-summary')
  assert.equal(summary['list-style'], 'none', '要去掉 summary 默认列表样式')
  assert.equal(summary.width, 'fit-content', '折叠按钮只占自身宽度，不铺满整行')
  assert.match(styles, /\.orch-wb-details-summary::-webkit-details-marker\s*\{\s*display:\s*none/,
    '要隐藏 WebKit 默认三角')
  assert.match(styles, /\.orch-wb-details\[open\]\s+\.orch-wb-details-caret\s*\{[^}]*rotate\(180deg\)/,
    '展开后 chevron 应旋转 180 度')
  assert.match(styles, /\.orch-wb-details\[open\]\s+\.orch-wb-details-label--closed\s*\{[^}]*display:\s*none/,
    '展开后隐藏收起态文案')
  assert.match(styles, /\.orch-wb-details\[open\]\s+\.orch-wb-details-label--open\s*\{[^}]*display:\s*inline/,
    '展开后显示展开态文案')
  assert.match(artifact, /\.orch-wb-details-summary[^{}]*\{[^}]*width:\s*fit-content/,
    '产物里缺折叠按钮样式：改了源码没重建 dist/client.js')
  assert.match(artifact, /\.orch-wb-details\[open\][^{}]*\.orch-wb-details-caret[^{}]*\{[^}]*rotate\(180deg\)/,
    '产物里缺 chevron 展开旋转：改了源码没重建 dist/client.js')
})

test('自动化行：可直接打开绑定的目标会话', () => {
  const pageStart = workbench.indexOf('const AutomationsPage =')
  assert.ok(pageStart !== -1, '自动化页没找到')
  const page = workbench.slice(pageStart, workbench.indexOf('const ReviewPage =', pageStart))
  assert.match(page, /onOpenSession\(row\.targetSession\)/, '「打开」按钮应把目标会话交给宿主打开')
  assert.match(page, /title="打开这条自动化绑定的会话"/, '「打开」按钮要有明确说明')
  assert.match(page, /<Icon name="external" size=\{12\} \/>[\s\S]{0,80}<span>\{'打开'\}<\/span>/,
    '「打开」按钮要有外链图标和可读文字')
  assert.match(views, /<Wb\.AutomationsPage[\s\S]{0,500}onOpenSession=\{open\}/,
    '自动化页要从工作台接上宿主打开会话的能力')
})

test('能力包页：卡头 / 规格 / 底部动作三段式，说明、健康与操作不再散落', () => {
  assert.match(packs, /className="orch-packs-head"/, '页头要有独立容器')
  assert.match(packs, /className="orch-packs-subtitle"/, '页头要有用途说明')
  assert.match(packs, /className="orch-pack-head"/, '卡头要独立成段')
  assert.match(packs, /className="orch-pack-desc">\{pack\.description\}/, '卡片要展示包说明（原来只有一句 publisher｜技能数）')
  assert.match(packs, /healthOfPack\(pack\.health\)/, '健康状态要收口成短标签')
  assert.match(packs, /className="orch-pack-spec"/, 'CLI/技能/目录/环境变量要有独立规格区')
  assert.match(packs, /orch-pack-path" title=\{pack\.dir\}/, '长目录要有 title 兜底')
  assert.match(packs, /className="orch-pack-chips"/, '技能与环境变量要用可换行的 chip 组')
  assert.match(packs, /tone=\{item\.set \? 'good' : \(item\.required \? 'warn' : undefined\)\}[\s\S]{0,180}\$\{item\.ref\} \$\{item\.set \? '已设置' : '未设置'\}/,
    '环境变量应逐项用 Chip 展示，不再拼成一长串')
  assert.match(packs, /className="orch-pack-foot"/, '底部动作区要有分隔')
  assert.match(packs, /className="orch-pack-footnote" data-tone=\{health\.tone\}/, '底部要说明当前是否可用')
  assert.match(packs, /<Icon name="plus" size=\{12\} \/>[\s\S]{0,80}\{'开新会话'\}/, '主操作要有图标和短标签')
  assert.match(packs, /title="用这个能力包开一个新会话"/, '主操作要有明确说明')
  const card = declarationsOf(styles, '.orch-pack')
  assert.equal(card.cursor, 'default', '包卡不是可点列表行，不能继承 pointer')
  assert.match(card.background, /^color-mix\(in srgb, var\(--dsw-alias-label-primary/,
    '包卡底色必须自带对比度，不能依赖可能为白色的主题 card-fill')
  assert.match(card['box-shadow'], /color-mix\(/,
    '包卡要有轻阴影，和页面形成层级')
  assert.equal(declarationsOf(styles, '.orch-pack-spec').background, 'var(--orch-surface-1)',
    '卡内规格区要用浅一档的底，和卡片形成层次')
  assert.equal(declarationsOf(styles, '.orch-pack-foot')['border-top'], '1px solid var(--orch-line)',
    '底部动作区要有发丝线，不能悬空')
  assert.equal(declarationsOf(styles, '.orch-pack-actions')['margin-left'], 'auto',
    '动作组靠右，但必须和说明同处一条底栏')
  assert.match(styles, /\.orch-packs-shell\s*\{[^}]*max-width:\s*1040px/,
    '单包页面要收阅读宽度，避免横跨整个窗口')
  assert.match(artifact, /\.orch-pack-head/, '产物里缺卡头样式：改了源码没重建 dist/client.js')
  assert.match(artifact, /\.orch-pack-spec/, '产物里缺规格区样式：改了源码没重建 dist/client.js')
  assert.match(artifact, /\.orch-packs-subtitle/, '产物里缺页头说明样式：改了源码没重建 dist/client.js')
})

test('产物库：文件名 / 目录 / 元信息 / 操作各归其位，长路径不再折成竖条', () => {
  assert.match(views, /const artifactPathParts = value =>/, '产物路径要拆成文件名与目录')
  assert.match(views, /className="orch-artifact-row"/, '产物行要独立容器')
  assert.match(views, /className="orch-artifact-name" title=\{item\.path\}/, '文件名要有完整路径兜底')
  assert.match(views, /className="orch-artifact-dir" title=\{item\.path\}/, '目录要单行省略并保留 title')
  assert.match(views, /className="orch-artifact-label" title=\{item\.label\}/, '产物标签要可省略并保留 title')
  assert.match(views, /className="orch-artifact-actions"/, '操作要独立成组，不能和路径抢宽度')
  assert.match(views, /className="orch-artifact-toolbar"/, '顶部要独立工具栏')
  assert.match(views, /className="orch-artifact-rows"/, '分组内用无间隙行容器，靠发丝线分隔')
  const row = declarationsOf(styles, '.orch-artifact-row')
  assert.equal(row.display, 'grid', '产物行要用 grid 固定三列')
  assert.match(row['grid-template-columns'], /8px minmax\(0, 1fr\) auto/, '文件名列可收缩，操作列占自身宽度')
  assert.equal(declarationsOf(styles, '.orch-artifact-name')['white-space'], 'nowrap',
    '文件名不能被 anywhere 折行')
  assert.equal(declarationsOf(styles, '.orch-artifact-dir')['text-overflow'], 'ellipsis',
    '目录单行省略，完整路径走 title')
  assert.equal(declarationsOf(styles, '.orch-artifact-actions')['justify-content'], 'flex-end',
    '操作组靠右，不与元信息混排')
  assert.match(styles, /\.orch-group\s*\{[^}]*border:\s*1px solid var\(--orch-line\)/, '分组要有卡片边界')
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]{0,240}\.orch-artifact-actions\s*\{[^}]*grid-column:\s*2/,
    '窄屏时操作组要落到第二行，不能横向溢出')
  assert.match(artifact, /\.orch-artifact-row/, '产物里缺新产物行样式：改了源码没重建 dist/client.js')
  assert.match(artifact, /\.orch-artifact-toolbar/, '产物里缺产物工具栏样式：改了源码没重建 dist/client.js')
})

// ---------------------------------------------------------------------------
// 补丁：吸顶列头漏 12px 内容带。浏览器实测（evidence/sticky-before/sticky.json）：
// `.orch-main` 有 12px 上内边距，列头只写 `top: 0` 时钉在「内容盒上沿」（比可视上沿低 12px），
// 滚动时列头上方漏出 12px 的任务卡 chip（1440 / 1024 / 863 三个宽度都是 12px）。
// 修法（a）：`top` 与该上内边距同源，用同一个变量推导 —— 两处写同一个数才不会再错位。
// 滚动后的像素级对齐/无内容带断言在浏览器级 harness（reports/ui-fixes/harness/verify.mjs 的 S-1/S-3），
// node --test 没有浏览器，这里锁「机制」：变量存在、两处都引用它、产物已同步。
// ---------------------------------------------------------------------------
test('吸顶列头：sticky top 与滚动容器上内边距同源（只用变量推导，不许写 -12px 魔法数）', () => {
  const shell = declarationsOf(styles, '.orch-shell')
  assert.equal(shell['--orch-page-pad'], '12px', '页面级上内边距要有唯一变量来源 --orch-page-pad')
  const main = declarationsOf(styles, '.orch-main')
  assert.match(main.padding ?? '', /^var\(--orch-page-pad\)\s/, '滚动容器的上内边距必须取同一个变量')
  const colidx = declarationsOf(styles, '.orch-wb-colidx')
  assert.equal(colidx.position, 'sticky')
  assert.equal(colidx.top, 'calc(-1 * var(--orch-page-pad))',
    '吸顶偏移必须由 --orch-page-pad 推导：写死 0 会漏 12px 内容带，写死 -12px 又会与变量脱钩')
  // 中档断点（≤863）换了横向内边距，上内边距同样走变量，否则窄屏又会对不上。
  const narrow = /@media \(max-width: 863px\)[\s\S]*?\n\}/.exec(styles)?.[0] ?? ''
  assert.match(narrow, /\.orch-main\s*\{[^}]*padding:\s*var\(--orch-page-pad\)/, '≤863 的 .orch-main 上内边距也要取变量')
  // 产物同步：改了源码没重建会被这两条挡下。
  assert.match(artifact, /--orch-page-pad:\s*12px/, '产物里缺 --orch-page-pad')
  assert.match(artifact, /\.orch-wb-colidx\s*\{[^}]*top:\s*calc\(\s*-1\s*\*\s*var\(--orch-page-pad\)\s*\)/,
    '产物里列头仍没有用变量推导的吸顶偏移')
})

// ---------------------------------------------------------------------------
// 问题 3：组页顶部四个按钮「裸文字 / 22 高 / 挨在一起」。
// 浏览器实测（evidence/before/header.json）：四个按钮全走 --sm（22px 高）、重命名与归档是 quiet 裸文字、
// 同一行实测 gap = 6px。
// ---------------------------------------------------------------------------
test('组页顶部按钮：统一 .orch-btn 档位（ghost 次 / primary 主）、26 高、动作区 gap 8', () => {
  const start = workbench.indexOf('<header className="orch-wb-grouphead">')
  assert.ok(start !== -1, '组页头没找到')
  const header = workbench.slice(start, workbench.indexOf('</header>', start))
  // 重命名是行内表单（保存 / 取消）与「重命名」按钮二选一，先切出去单独验；
  // 常驻动作区就是「返回 / 打开主会话 / 重命名 / 归档」四个。
  const formStart = header.indexOf('<span className="orch-wb-inline">')
  const formEnd = header.indexOf('</span>', formStart)
  const inlineForm = formStart === -1 ? '' : header.slice(formStart, formEnd)
  const steady = formStart === -1 ? header : header.slice(0, formStart) + header.slice(formEnd)
  const classList = text => [...text.matchAll(/className="(orch-btn[^"]*)"/g)].map(match => match[1])
  const classes = classList(steady)
  assert.equal(classes.length, 4, `组页头常驻动作应是 4 个（返回 / 打开主会话 / 重命名 / 归档），实际 ${classes.length}`)
  assert.equal(classes.filter(name => name.includes('orch-btn--sm')).length, 0, '组页头按钮不许再用 22px 的 --sm 小档')
  assert.equal(classes.filter(name => name.includes('orch-btn--quiet')).length, 0, '次级也不能是裸文字（quiet），要走 ghost')
  assert.equal(classes.filter(name => name.includes('orch-btn--primary')).length, 1, '主操作只能有一个（打开主会话）')
  assert.equal(classes.filter(name => name.includes('orch-btn--ghost')).length, 3, '返回 / 重命名 / 归档是 ghost')
  // 返回是导航而不是普通动作：文字箭头换成统一 chevron，并用柔和底/细描边与右侧动作区分。
  assert.doesNotMatch(workbench, /← 返回任务组/, '返回按钮不应再用文字箭头')
  assert.match(header, /className="orch-btn orch-btn--ghost orch-wb-back"[\s\S]{0,160}<Icon name="chevron"/,
    '返回按钮应复用统一 chevron 图标')
  assert.match(header, /<span>\{'返回任务组'\}<\/span>/, '返回按钮仍要有可读文字')
  const back = declarationsOf(styles, '.orch-wb-back')
  assert.equal(back.gap, '4px', '返回按钮图标与文字用 4px 间距')
  assert.equal(back['border-color'], 'var(--orch-line)', '返回按钮用细描边，不与重命名/归档抢层级')
  assert.equal(back.background, 'var(--orch-surface-card)', '返回按钮用柔和底色')
  assert.match(artifact, /\.orch-wb-back\s*\{[^}]*?background:\s*var\(--orch-surface-card\)/,
    '产物里缺返回按钮样式：改了源码没重建 dist/client.js')
  // 行内重命名表单：保存 = primary、取消 = ghost，同样不用小档。
  const formClasses = classList(inlineForm)
  assert.equal(formClasses.length, 2, `重命名行内表单应有 2 个按钮，实际 ${formClasses.length}`)
  assert.ok(formClasses.some(name => name.includes('orch-btn--primary')), '保存应是 primary')
  assert.ok(formClasses.some(name => name.includes('orch-btn--ghost')), '取消应是 ghost')
  assert.equal(formClasses.filter(name => name.includes('orch-btn--sm') || name.includes('orch-btn--quiet')).length, 0)
  // 按钮规格本身：26 高 + hover + focus-visible（复用公共 .orch-btn，不另造形态）。
  const button = declarationsOf(styles, '.orch-btn')
  assert.ok(px(button.height) >= 26, `.orch-btn 高度应 ≥26px，实际 ${button.height}`)
  assert.match(styles, /\.orch-btn:hover\s*\{/, '缺 .orch-btn:hover')
  assert.match(styles, /\.orch-btn:focus-visible\s*\{[^}]*outline:\s*2px/, '缺 .orch-btn:focus-visible 的 2px 焦点环')
  // 动作区两行的间距 ≥8。
  assert.ok(px(declarationsOf(styles, '.orch-wb-grouphead-main').gap) >= 8)
  assert.ok(px(declarationsOf(styles, '.orch-wb-grouphead-sub').gap) >= 8)
})
