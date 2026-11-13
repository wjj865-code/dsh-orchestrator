import test from 'node:test'
import assert from 'node:assert/strict'
import { validateBrief, renderBrief } from '../src/brief.js'

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
