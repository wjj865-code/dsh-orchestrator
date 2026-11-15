import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_POINTER_TEXT, MAX_GOAL_FALLBACK_CHARS, goalLines, renderBrief, validateBrief, validateTargetDir,
} from '../src/brief.js'

const valid = {
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明',
  constraints: ['只改 src/report.js'],
  acceptance: ['空窗口输出明确说明', 'npm test 全绿'],
  refs: ['src/report.js:66'],
  user_verbatim: '你看这个空数据啥也没显示',
}

test('合法 brief 通过校验', () => {
  assert.deepEqual(validateBrief(valid), [])
})

test('缺必填项报错', () => {
  assert.match(validateBrief({}).join('\n'), /title/)
  assert.match(validateBrief({ title: 'x' }).join('\n'), /goal/)
  assert.match(validateBrief({ title: 'x', goal: 'y' }).join('\n'), /acceptance/)
})

test('空白视为空', () => {
  assert.match(validateBrief({ title: '  ', goal: 'g', acceptance: ['a'] }).join('\n'), /title/)
  assert.match(validateBrief({ title: 't', goal: '', acceptance: ['a'] }).join('\n'), /goal/)
})

test('类型容错：非数组按空处理，数组里的非法项被过滤', () => {
  assert.match(validateBrief({ title: 't', goal: 'g', acceptance: 'x' }).join('\n'), /acceptance/)
  assert.deepEqual(validateBrief({ title: 't', goal: 'g', acceptance: ['a', 1, null, ''] }), [])
  assert.deepEqual(validateBrief({ title: 't', goal: 'g', acceptance: ['a'], constraints: 'x' }), [])
})

test('渲染成结构化文字且不含 JSON', () => {
  const text = renderBrief(valid)
  assert.match(text, /【任务】修复空数据文案/)
  assert.match(text, /【目标】/)
  assert.match(text, /【约束】- 只改 src\/report\.js/)
  assert.match(text, /【验收标准】/)
  assert.match(text, /【背景资料】- src\/report\.js:66/)
  assert.match(text, /【用户原话】\n> /)
  assert.equal(text.includes('{'), false)
  assert.equal(text.includes('acceptance'), false)
})

test('可选字段为空时不出现对应小节', () => {
  const text = renderBrief({ title: 't', goal: 'g', acceptance: ['a'] })
  assert.equal(text.includes('【约束】'), false)
  assert.equal(text.includes('【背景资料】'), false)
  assert.equal(text.includes('【用户原话】'), false)
})

test('花括号与引号原样保留，整体仍不是 JSON 文档', () => {
  const text = renderBrief({
    title: 't',
    goal: '返回 {"a":1} 不是数组',
    acceptance: ['别返回 {"a":1}'],
    user_verbatim: '他说 {a:1}',
  })
  assert.match(text, /\{a:1\}/)
  assert.match(text, /"a":1/)
  assert.throws(() => JSON.parse(text))
  assert.equal(text.startsWith('{'), false)
})

test('标题里的换行和伪小节被压成单行，不伪造新小节', () => {
  const text = renderBrief({
    title: '修复\n【约束】伪造小节',
    goal: 'g',
    acceptance: ['a'],
  })
  const sectionLines = text.split('\n').filter(line => line.startsWith('【'))
  assert.deepEqual(sectionLines.map(line => line.match(/^【[^】]+】/)[0]), ['【任务】', '【目标】', '【验收标准】'])
  assert.equal(text.includes('\n【约束】'), false)
})

test('用户原话里的换行每行都进引用块，不伪造小节', () => {
  const text = renderBrief({
    title: 't',
    goal: 'g',
    acceptance: ['a'],
    user_verbatim: '第一行\n【验收标准】第二行',
  })
  const lines = text.split('\n')
  const start = lines.indexOf('【用户原话】')
  assert.notEqual(start, -1)
  assert.equal(lines[start + 1], '> 第一行')
  assert.equal(lines[start + 2], '> 【验收标准】第二行')
  assert.equal(lines.filter(line => line === '【验收标准】').length, 1)
})

test('超长验收标准与 emoji 不崩、不截断', () => {
  const long = '验'.repeat(10000)
  const text = renderBrief({ title: 't😀', goal: 'g', acceptance: [long, '✅ 通过'] })
  assert.equal(text.includes(long), true)
  assert.equal(text.includes('✅ 通过'), true)
})

test('渲染是纯函数：同一输入两次输出相同', () => {
  assert.equal(renderBrief(valid), renderBrief(valid))
})

test('空字符串与空白项不会产生空小节', () => {
  const text = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], constraints: ['  '], refs: [''] })
  assert.equal(text.includes('【约束】'), false)
  assert.equal(text.includes('【背景资料】'), false)
})

test('validateTargetDir：相对路径/不存在/非目录都拒绝', () => {
  assert.equal(validateTargetDir('relative/dir', { isDirectory: () => true }), 'target 必须是绝对路径')
  const absolute = process.platform === 'win32' ? 'C:/work' : '/work'
  const missing = process.platform === 'win32' ? 'C:/nope' : '/nope'
  assert.equal(validateTargetDir(missing, { isDirectory: () => false }), 'target 目录不存在或不是目录')
  assert.equal(validateTargetDir(absolute, { isDirectory: () => true }), undefined)
  assert.equal(validateTargetDir(undefined, { isDirectory: () => true }), undefined)
  assert.equal(validateTargetDir('  ', { isDirectory: () => true }), undefined)
})

test('renderBrief：有 target 时渲染【工作目录】，无 target 不渲染', () => {
  const text = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], target: 'C:/work' })
  assert.match(text, /【工作目录】C:\/work/)
  const without = renderBrief({ title: 't', goal: 'g', acceptance: ['a'] })
  assert.equal(without.includes('【工作目录】'), false)
})

test('renderBrief：只读任务加【权限】只读与禁写提示；非只读逐字不变', () => {
  const readOnly = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], readOnly: true })
  assert.match(readOnly, /【权限】只读/)
  assert.match(readOnly, /不要写文件、不要执行写操作的 shell/)
  assert.doesNotMatch(readOnly, /所有产出只写到该目录内/)
  // 带 target 时也只有一个目录，权限行跟在【工作目录】后。
  const withTarget = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], target: 'C:/work', readOnly: true })
  const lines = withTarget.split('\n')
  assert.equal(lines[lines.indexOf('【工作目录】C:/work') + 1], '【权限】只读')
  assert.match(withTarget, /只读任务/)
  // 非只读不出现权限小节与禁写句。
  const normal = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], target: 'C:/work' })
  assert.doesNotMatch(normal, /【权限】|只读任务|不要写文件/)
})

test('renderBrief：只出现一个目录（target），并给出现有目录内的写入提示', () => {
  const text = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], target: 'C:/work' })
  // 目录只来自 target；不出现指挥舱/父会话目录这类第二个目录。
  assert.equal(text.includes('指挥舱'), false)
  assert.equal(text.match(/C:\/work/g).length, 1)
  // 提示紧跟在【工作目录】下一行，明确「只写该目录内、汇报时路径落在这里」。
  const lines = text.split('\n')
  const hint = '所有产出只写到该目录内，不要写到父会话目录或其他绝对路径；完成后汇报时把文件路径落到该目录下。'
  assert.equal(lines[lines.indexOf('【工作目录】C:/work') + 1], hint)
  // 不带 target 时不出现这句（此时 cwd 就是指挥舱，写了也对，语义不动）。
  const without = renderBrief({ title: 't', goal: 'g', acceptance: ['a'] })
  assert.equal(without.includes(hint), false)
  assert.equal(without.includes('【工作目录】'), false)
})

test('goal 可用：目标改成「用 get_goal 读」的指引 + 截断兜底，不内联全文', () => {
  const goal = 'G'.repeat(MAX_GOAL_FALLBACK_CHARS) + '这一段不该进 brief'
  const text = renderBrief({ title: 't', goal, acceptance: ['a'] }, { goalAvailable: true })
  const goalLine = text.split('\n').find(line => line.startsWith('【目标】'))
  assert.equal(goalLine, `【目标】${GOAL_POINTER_TEXT}`)
  assert.match(goalLine, /get_goal/)
  const fallback = text.split('\n').find(line => line.startsWith('【目标兜底】'))
  assert.ok(fallback !== undefined, 'goal 可用时必须留兜底，attach 失败时子会话还有目标可看')
  assert.equal(fallback.endsWith('…'), true)
  assert.equal(fallback.includes('这一段不该进 brief'), false)
  // 指引行在前、兜底行紧随其后。
  const lines = text.split('\n')
  assert.equal(lines.indexOf(goalLine) + 1, lines.indexOf(fallback))
})

test('goal 可用但目标本身很短：兜底就是全文，不加省略号', () => {
  const lines = goalLines({ goal: '修登录' }, { goalAvailable: true })
  assert.deepEqual(lines, [`【目标】${GOAL_POINTER_TEXT}`, '【目标兜底】get_goal 不可用时按此执行：修登录'])
})

test('goal 降级（默认）：内联目标全文，不出现 get_goal 指引或兜底小节', () => {
  const goal = '空窗口时报表给出明确说明\n第二行也要在'
  const text = renderBrief({ title: 't', goal, acceptance: ['a'] })
  const goalLine = text.split('\n').find(line => line.startsWith('【目标】'))
  assert.equal(goalLine, '【目标】空窗口时报表给出明确说明 第二行也要在')
  assert.equal(text.includes('get_goal'), false)
  assert.equal(text.includes('【目标兜底】'), false)
})

test('goal 可用时不影响工作目录/只读的相对顺序', () => {
  const text = renderBrief(
    { title: 't', goal: 'g', acceptance: ['a'], target: 'C:/work', readOnly: true },
    { goalAvailable: true },
  )
  const lines = text.split('\n')
  const goalIndex = lines.findIndex(line => line.startsWith('【目标】'))
  const fallbackIndex = lines.findIndex(line => line.startsWith('【目标兜底】'))
  const targetIndex = lines.indexOf('【工作目录】C:/work')
  assert.ok(goalIndex < fallbackIndex && fallbackIndex < targetIndex)
  assert.equal(lines[targetIndex + 1], '【权限】只读')
})

test('goal 指引形态也是纯函数，两次渲染一致', () => {
  const brief = { title: 't', goal: 'g'.repeat(400), acceptance: ['a'] }
  assert.equal(renderBrief(brief, { goalAvailable: true }), renderBrief(brief, { goalAvailable: true }))
})
