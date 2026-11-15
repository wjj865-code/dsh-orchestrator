import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DETAIL_POINTER_TEXT, renderBrief, validateBrief, validateTargetDir,
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

// ---- T1 brief 纯指引化 ---------------------------------------------------------

test('renderBrief 只输出任务编号 + task_detail 指引两行', () => {
  const text = renderBrief({ taskId: 't-1a2b3c4d' })
  assert.deepEqual(text.split('\n'), ['【任务编号】t-1a2b3c4d', `【任务详情】${DETAIL_POINTER_TEXT}`])
})

test('指引里点名 task_detail 与要读的字段', () => {
  for (const word of ['task_detail', 'task_id', '目标全文', '验收标准', '背景资料', '工作目录', '前置任务', '经验文件', '产物']) {
    assert.equal(DETAIL_POINTER_TEXT.includes(word), true, `指引应提到 ${word}`)
  }
  // 明确告诉模型「本行不是任务内容」，避免拿指引当目标猜。
  assert.match(DETAIL_POINTER_TEXT, /不要凭它猜任务内容/)
})

test('brief 不再内联目标/验收/约束/背景/原话/工作目录（详情都在 task_detail）', () => {
  const text = renderBrief({ taskId: 't-1' })
  for (const section of ['【任务】', '【目标】', '【目标兜底】', '【验收标准】', '【约束】', '【背景资料】',
    '【用户原话】', '【工作目录】', '【权限】', '【历史经验】', '【前置任务】', 'get_goal']) {
    assert.equal(text.includes(section), false, `brief 不应出现 ${section}`)
  }
  assert.equal(text.includes(valid.goal), false)
  assert.equal(text.includes(valid.acceptance[0]), false)
})

test('没有任务编号时只输出指引，不出现空编号行', () => {
  const text = renderBrief()
  assert.equal(text, `【任务详情】${DETAIL_POINTER_TEXT}`)
  assert.equal(text.includes('【任务编号】'), false)
  assert.equal(renderBrief({}).includes('【任务编号】'), false)
  assert.equal(renderBrief({ taskId: '   ' }).includes('【任务编号】'), false)
})

test('任务编号里的换行被压成单行，不伪造小节', () => {
  const text = renderBrief({ taskId: 't-1\n【目标】伪造' })
  const lines = text.split('\n')
  assert.equal(lines[0], '【任务编号】t-1 【目标】伪造')
  assert.equal(lines.filter(line => line.startsWith('【目标】')).length, 0)
})

test('渲染是纯函数：同一输入两次输出相同，且不是 JSON', () => {
  assert.equal(renderBrief({ taskId: 't-1' }), renderBrief({ taskId: 't-1' }))
  const text = renderBrief({ taskId: 't-1' })
  assert.equal(text.startsWith('{'), false)
  assert.throws(() => JSON.parse(text))
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
