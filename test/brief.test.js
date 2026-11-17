import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOCKED_HINT, CONFIRM_HINT, DETAIL_POINTER_TEXT, WORKTREE_INSTALL_HINT,
  renderBrief, renderBriefForTask, validateBrief, validateTargetDir,
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

test('renderBrief 输出任务编号 + 指引 + 执行中待确认 + 确认方式四行', () => {
  const text = renderBrief({ taskId: 't-1a2b3c4d' })
  assert.deepEqual(text.split('\n'), [
    '【任务编号】t-1a2b3c4d',
    `【任务详情】${DETAIL_POINTER_TEXT}`,
    `【执行中待确认】${BLOCKED_HINT}`,
    `【确认方式】${CONFIRM_HINT}`,
  ])
})

// ---- 提示三：执行中待确认事项用 blocked 上报，由主会话问用户 ----------------------

test('执行中待确认提示：用 task_report blocked 上报「问题 + 选项建议」', () => {
  const text = renderBrief({ taskId: 't-1' })
  assert.match(text, /【执行中待确认】/)
  assert.match(BLOCKED_HINT, /执行中/)
  assert.match(BLOCKED_HINT, /task_report/)
  assert.match(BLOCKED_HINT, /blocked/)
  assert.match(BLOCKED_HINT, /问题 \+ 选项建议/)
  // 覆盖该上报的四类决策点（用户点名要的）。
  for (const kind of ['业务取舍', '范围变更', '不可逆操作', '方案歧义']) {
    assert.equal(BLOCKED_HINT.includes(kind), true, `应提到 ${kind}`)
  }
})

test('执行中待确认提示：由主会话 ask_user_question 确认后 task_message 续派', () => {
  assert.match(BLOCKED_HINT, /协调者用 ask_user_question 向用户确认/)
  assert.match(BLOCKED_HINT, /task_message 续派/)
  // 三种不许：不自行假设、不阻塞等待、不等不到就跳过。
  assert.match(BLOCKED_HINT, /不要自行假设用户意图/)
  assert.match(BLOCKED_HINT, /不要阻塞等待/)
  assert.match(BLOCKED_HINT, /不要等不到回复就跳过/)
})

test('执行中待确认提示：blocked 只是上报，不等于已获授权（不绕过双审查）', () => {
  assert.match(BLOCKED_HINT, /blocked 只是上报，不等于已获授权/)
  // 三段提示都不得给「免审查 / 免确认 / 跳过门禁」的口子。
  for (const hint of [BLOCKED_HINT, CONFIRM_HINT, WORKTREE_INSTALL_HINT]) {
    assert.doesNotMatch(hint, /跳过(?:推送前)?(?:双)?审查|免审查|无需审查|不用审查|免确认/)
  }
})

test('执行中待确认提示对所有任务都出现（一开始就要能看到，不是只在交付环节）', () => {
  for (const options of [{ taskId: 't-1' }, { taskId: 't-1', access: 'full' }, { taskId: 't-1', worktreeState: 'created' }]) {
    assert.equal(renderBrief(options).includes(`【执行中待确认】${BLOCKED_HINT}`), true, JSON.stringify(options))
  }
  // 没有任务编号（队列兜底/旧数据）时也带。
  assert.equal(renderBrief().includes(`【执行中待确认】${BLOCKED_HINT}`), true)
  // 且排在【确认方式】之前：执行期提示先于交付期提示。
  const lines = renderBrief({ taskId: 't-1' }).split('\n')
  assert.equal(lines.findIndex(line => line.startsWith('【执行中待确认】')) < lines.findIndex(line => line.startsWith('【确认方式】')), true)
})

// ---- 提示一：报告后用 ask_user_question 的选项方式确认 ----------------------------

test('确认方式提示：交付时给结构化选项，不只在正文里问', () => {
  const text = renderBrief({ taskId: 't-1' })
  assert.match(text, /【确认方式】/)
  assert.match(CONFIRM_HINT, /报 done/)
  assert.match(CONFIRM_HINT, /不要只在正文里问/)
  // 交付阶段走 summary（done 会清空 question/options，这条是平台事实，必须写明）。
  assert.match(CONFIRM_HINT, /待确认要点写进 summary/)
  assert.match(CONFIRM_HINT, /done 会清空 question\/options/)
  // 用户拍板要带选项：确认 / 要改？
  assert.match(CONFIRM_HINT, /确认 \/ 要改？/)
  // 措辞不能顺手放宽推送前双审查或人工确认门禁。
  assert.doesNotMatch(CONFIRM_HINT, /跳过|免确认|不用审查|无需审查/)
})

test('确认方式提示不指挥子会话去调 ask_user_question（平台会以 DELEGATED_CALLER 拒绝）', () => {
  // 子会话是 subagent 来源，ask_user_question 的 assertLiveRoot 会直接抛 DELEGATED_CALLER
  // （本会话已实测：子会话调用返回 "human interaction is unavailable while the calling agent is
  // owned by another live agent"）。提示必须点明边界并把「问用户」指回协调者，
  // 否则每个子会话每轮都会撞一次墙。
  assert.match(CONFIRM_HINT, /DELEGATED_CALLER/)
  assert.match(CONFIRM_HINT, /子会话直接调 ask_user_question 会被平台拒/)
  assert.match(CONFIRM_HINT, /由协调者带选项问用户/)
})

test('确认方式提示对所有任务都出现（交付待确认是每个任务的出口）', () => {
  for (const options of [{ taskId: 't-1' }, { taskId: 't-1', access: 'full' }, { taskId: 't-1', worktreeState: 'created' }]) {
    assert.equal(renderBrief(options).includes(`【确认方式】${CONFIRM_HINT}`), true, JSON.stringify(options))
  }
  // 没有任务编号（队列兜底/旧数据）时也照样带确认方式。
  assert.equal(renderBrief().includes(`【确认方式】${CONFIRM_HINT}`), true)
})

// ---- 提示二：worktree 任务可安装依赖（只装不升） --------------------------------

test('worktree 任务：brief 带装依赖提示（只安装不升级）', () => {
  for (const worktreeState of ['requested', 'created', 'reused']) {
    const text = renderBrief({ taskId: 't-1', worktreeState })
    assert.equal(text.includes(`【worktree 依赖】${WORKTREE_INSTALL_HINT}`), true, worktreeState)
  }
  assert.match(WORKTREE_INSTALL_HINT, /worktree/)
  assert.match(WORKTREE_INSTALL_HINT, /pnpm install/)
  assert.match(WORKTREE_INSTALL_HINT, /npm install/)
  assert.match(WORKTREE_INSTALL_HINT, /uv sync/)
  assert.match(WORKTREE_INSTALL_HINT, /只安装不升级/)
  // 只给装依赖授权，不改依赖声明/版本，也不碰门禁。
  assert.match(WORKTREE_INSTALL_HINT, /不改依赖声明与版本/)
  assert.doesNotMatch(WORKTREE_INSTALL_HINT, /跳过|免确认|无需审查/)
})

test('普通任务不出现 worktree 装依赖提示（未隔离/降级/被拒都没有检出）', () => {
  for (const worktreeState of [undefined, 'none', 'degraded', 'rejected', 'failed', 'cleaned']) {
    const text = renderBrief({ taskId: 't-1', worktreeState })
    assert.equal(text.includes('【worktree 依赖】'), false, String(worktreeState))
    assert.equal(text.includes(WORKTREE_INSTALL_HINT), false, String(worktreeState))
  }
  // 传了非布尔/非状态值时也不误触发。
  assert.equal(renderBrief({ taskId: 't-1', worktreeState: true }).includes('【worktree 依赖】'), false)
  assert.equal(renderBrief({ taskId: 't-1', worktreeState: 'created ' }).includes('【worktree 依赖】'), false)
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

test('没有任务编号时只输出指引与确认方式，不出现空编号行', () => {
  const text = renderBrief()
  assert.equal(text, `【任务详情】${DETAIL_POINTER_TEXT}\n【执行中待确认】${BLOCKED_HINT}\n【确认方式】${CONFIRM_HINT}`)
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

test('完整访问任务：任务编号后多一行【访问级别】，其余行不变', () => {
  const text = renderBrief({ taskId: 't-1a2b3c4d', access: 'full' })
  const lines = text.split('\n')
  assert.equal(lines[0], '【任务编号】t-1a2b3c4d')
  assert.match(lines[1], /^【访问级别】完整（danger-full-access/)
  assert.equal(lines[2], `【任务详情】${DETAIL_POINTER_TEXT}`)
  assert.equal(lines[3], `【执行中待确认】${BLOCKED_HINT}`)
  assert.equal(lines[4], `【确认方式】${CONFIRM_HINT}`)
  // 默认任务一字不提。
  assert.equal(renderBrief({ taskId: 't-1' }).includes('访问级别'), false)
  assert.equal(renderBrief({ taskId: 't-1', access: 'read-only' }).includes('访问级别'), false)
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

test('renderBriefForTask：从台账行取 access / worktree_state，四个入口不各写一份', () => {
  const task = { id: 't-1a2b3c4d', access: 'full', worktree_state: 'created' }
  assert.equal(renderBriefForTask(task), renderBrief({
    taskId: 't-1a2b3c4d', access: 'full', worktreeState: 'created',
  }))
  // 默认任务：不传 access、worktree_state=none → 无访问级别、无装依赖提示。
  const plain = renderBriefForTask({ id: 't-1', access: null, worktree_state: 'none' })
  assert.equal(plain.includes('【访问级别】'), false)
  assert.equal(plain.includes('【worktree 依赖】'), false)
  // 降级任务也不给装依赖提示。
  assert.equal(renderBriefForTask({ id: 't-1', worktree_state: 'degraded' }).includes('【worktree 依赖】'), false)
  // 空行/null 都不炸（台账行理论上不会是 null，但渲染不该因此抛错）。
  assert.equal(renderBriefForTask().includes('【任务编号】'), false)
  assert.equal(renderBriefForTask(null).includes('【任务编号】'), false)
})
