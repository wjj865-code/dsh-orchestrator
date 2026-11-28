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
