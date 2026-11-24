import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOCKED_HINT, CONFIRM_HINT, DETAIL_POINTER_TEXT, SUMMARY_FIELDS, WORKTREE_INSTALL_HINT,
  renderBrief, renderBriefForTask, validateBrief, validateTargetDir,
} from '../src/brief.js'
import { BLOCKER_RULE } from '../src/copy.js'

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

// ---- t-4f7ce108：brief 只留一次性参数（任务引用 / 访问级别 / 一行详情指针） ----------------
// 静态提示（执行中上报 / 交付回报 / worktree 装依赖 / 主动读 context）迁到 W1 每回合注入，
// 这一组锁「brief 不再内联静态句」，W1 的措辞在 test/worker-policy.test.js 锁。

test('renderBrief 只输出任务编号 + 详情指针两行', () => {
  const text = renderBrief({ taskRef: 'tk-1a2b3c' })
  assert.deepEqual(text.split('\n'), [
    '【任务引用】tk-1a2b3c',
    `【任务详情】${DETAIL_POINTER_TEXT}`,
  ])
})

test('brief 不带任何静态提示（这些句子归 W1 per-turn policy）', () => {
  const text = renderBrief({ taskRef: 'tk-test1', access: 'full' })
  for (const staticHint of [BLOCKED_HINT, CONFIRM_HINT, WORKTREE_INSTALL_HINT, SUMMARY_FIELDS, BLOCKER_RULE]) {
    assert.equal(text.includes(staticHint), false, `brief 不应内联 W1 的静态句：${staticHint.slice(0, 20)}…`)
  }
  for (const section of ['【执行中待确认】', '【确认方式】', '【worktree 依赖】']) {
    assert.equal(text.includes(section), false, `brief 不应出现 ${section}`)
  }
})

test('指引里点名 task_detail 与 task_id（字段清单归 W1）', () => {
  assert.match(DETAIL_POINTER_TEXT, /task_detail/)
  assert.match(DETAIL_POINTER_TEXT, /task_id/)
  assert.equal(DETAIL_POINTER_TEXT.includes('目标全文'), false, '字段清单在 W1 的 WORKER_DETAIL_HINT 里')
})

test('brief 不再内联目标/验收/约束/背景/原话/工作目录（详情都在 task_detail）', () => {
  const text = renderBrief({ taskRef: 'tk-test1' })
  for (const section of ['【任务】', '【目标】', '【目标兜底】', '【验收标准】', '【约束】', '【背景资料】',
    '【用户原话】', '【工作目录】', '【权限】', '【历史经验】', '【前置任务】', 'get_goal']) {
    assert.equal(text.includes(section), false, `brief 不应出现 ${section}`)
  }
  assert.equal(text.includes(valid.goal), false)
  assert.equal(text.includes(valid.acceptance[0]), false)
})

test('没有任务引用时只有详情指针，不出现空引用行', () => {
  const text = renderBrief()
  assert.equal(text, `【任务详情】${DETAIL_POINTER_TEXT}`)
  assert.equal(text.includes('【任务引用】'), false)
  assert.equal(renderBrief({}).includes('【任务引用】'), false)
  assert.equal(renderBrief({ taskRef: '   ' }).includes('【任务引用】'), false)
})

test('任务引用里的换行被压成单行，不伪造小节', () => {
  const text = renderBrief({ taskRef: 'tk-1\n【目标】伪造' })
  const lines = text.split('\n')
  assert.equal(lines[0], '【任务引用】tk-1 【目标】伪造')
  assert.equal(lines.filter(line => line.startsWith('【目标】')).length, 0)
})

test('渲染是纯函数：同一输入两次输出相同，且不是 JSON', () => {
  assert.equal(renderBrief({ taskRef: 'tk-test1' }), renderBrief({ taskRef: 'tk-test1' }))
  const text = renderBrief({ taskRef: 'tk-test1' })
  assert.equal(text.startsWith('{'), false)
  assert.throws(() => JSON.parse(text))
})

test('完整访问任务：任务引用后多一行【访问级别】，其余行不变', () => {
  const text = renderBrief({ taskRef: 'tk-1a2b3c', access: 'full' })
  const lines = text.split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0], '【任务引用】tk-1a2b3c')
  assert.match(lines[1], /^【访问级别】完整（danger-full-access/)
  assert.equal(lines[2], `【任务详情】${DETAIL_POINTER_TEXT}`)
  // 默认任务一字不提。
  assert.equal(renderBrief({ taskRef: 'tk-test1' }).includes('访问级别'), false)
  assert.equal(renderBrief({ taskRef: 'tk-test1', access: 'read-only' }).includes('访问级别'), false)
})

// R2：brief 补任务名——子会话第一句就能用名字称呼任务（L1 的口径是「只用任务名 + 引用」）。
test('brief 有任务名时多一行【任务名】，位置在引用之后、访问级别之前', () => {
  const plain = renderBrief({ taskRef: 'tk-1a2b3c', taskName: '计划落盘工具' }).split('\n')
  assert.deepEqual(plain, ['【任务引用】tk-1a2b3c', '【任务名】计划落盘工具', `【任务详情】${DETAIL_POINTER_TEXT}`])
  const full = renderBrief({ taskRef: 'tk-1a2b3c', taskName: '计划落盘工具', access: 'full' }).split('\n')
  assert.equal(full.length, 4)
  assert.equal(full[1], '【任务名】计划落盘工具')
  assert.match(full[2], /^【访问级别】/)
  // 名字里的换行压成单行（不让它伪造小节）；空白名字不出这一行。
  const tricky = renderBrief({ taskRef: 'tk-1a2b3c', taskName: '甲\n【目标】伪造' }).split('\n')
  assert.equal(tricky[1], '【任务名】甲 【目标】伪造')
  assert.equal(tricky.filter(line => line.startsWith('【目标】')).length, 0)
  assert.equal(renderBrief({ taskRef: 'tk-1a2b3c', taskName: '   ' }).includes('【任务名】'), false)
  // 没有引用但有名字：名字行照样给（极端情况也不丢称呼）。
  assert.deepEqual(renderBrief({ taskName: '只有名字' }).split('\n'), ['【任务名】只有名字', `【任务详情】${DETAIL_POINTER_TEXT}`])
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

// ---- 台账行 → brief 的单点映射（四个入口共用） --------------------------------

test('renderBriefForTask：只从台账行取 access / ref / title，worktree_state 不再进 brief', () => {
  const task = { id: 't-1a2b3c4d', ref: 'tk-1a2b3c', title: '修发版', access: 'full', worktree_state: 'created' }
  assert.equal(renderBriefForTask(task), renderBrief({ taskRef: 'tk-1a2b3c', taskName: '修发版', access: 'full' }))
  // 隔离任务的 worktree_state 不影响 brief：装依赖提示由 W1 按同一字段条件渲染。
  assert.equal(renderBriefForTask(task), renderBriefForTask({ id: 't-1a2b3c4d', ref: 'tk-1a2b3c', title: '修发版', access: 'full', worktree_state: 'none' }))
  // 默认任务：不传 access → 无访问级别。
  const plain = renderBriefForTask({ id: 't-1', ref: 'tk-test1', title: '小活', access: null, worktree_state: 'none' })
  assert.equal(plain.includes('【访问级别】'), false)
  // R2：名字来自台账 title（面板/通知/task_detail 同一来源）。
  assert.equal(plain.includes('【任务名】小活'), true)
  // 版本 B：brief 只写引用（tk-），绝不写台账内部编号。
  assert.equal(renderBriefForTask({ id: 't-1a2b3c4d', ref: 'tk-1a2b3c', title: 'x' }).includes('t-1a2b3c4d'), false)
  // 空行/null 都不炸（台账行理论上不会是 null，但渲染不该因此抛错）。
  assert.equal(renderBriefForTask().includes('【任务引用】'), false)
  assert.equal(renderBriefForTask(null).includes('【任务引用】'), false)
})
