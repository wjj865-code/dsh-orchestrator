// 子会话工具失败监听的判定矩阵（纯函数 + 内存去重 + 文案）。
//
// 两个真实样本的夹具逐字来自真机会话日志（`~/.dsh/sessions/…/session.v4.jsonl.zstd` 的
// `tool/result` 事件，中文部分按原始文本写回——查看时的控制台回显乱码不算内容）：
//   - 样本 A：`seq 816`，pwsh 写 `.tmp-stage/p03.patch` 被沙箱拒：`isError:false`、带
//     `[sandbox: file access denied under workspace-write mode]` 与 `[exit code: 1]`；
//   - 样本 B：`seq 824`，pwsh `git add` 撞 `.git/index.lock`：`isError:false`、**无**沙箱标记、
//     **无**退出码标记（末尾 `git status` 成功使退出码归零）——这条专门锁住「不许要求 exitCode !== 0」。
//
// 这一组不碰文件系统（纯函数 + 内存去重），所以只读沙箱里也能跑；装配级用例在 test/index.test.js。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DENIED_CODES, ENV_CODES, INTERRUPT_CODES, TOOL_FAILURE_DEDUPE_MS, TOOL_FAILURE_HEAD_MAX,
  classifyToolFailure, createChildToolFailureWatcher, failureHead, redactHomePath, toolFailureDedupeMs,
} from '../src/child-tool-failure.js'
import { toolFailureNotice } from '../src/copy.js'

// ---- 真实样本夹具 -----------------------------------------------------------------

const SAMPLE_A_STDERR = [
  "fatal: could not open '.tmp-stage/p03.patch' for writing: Permission denied",
  'node:fs:440',
  '    return binding.readFileUtf8(path, stringToFlags(options.flag));',
  '                   ^',
  '',
  "Error: ENOENT: no such file or directory, open 'C:\\Users\\72489\\Documents\\dsh-orchestrator\\.tmp-stage\\p03.patch'",
  '    at readFileSync (node:fs:440:20)',
  '  errno: -4058,',
  "  code: 'ENOENT',",
  "  syscall: 'open',",
  '}',
  'Node.js v22.23.2',
  'Select-String : 找不到路径“C:\\Users\\72489\\Documents\\dsh-orchestrator\\.tmp-stage\\p03-filtered.patch”，因为该路径不存在。',
].join('\n')

const SAMPLE_A_CONTENT = [
  '[stderr]',
  SAMPLE_A_STDERR,
  '[sandbox: file access denied under workspace-write mode]',
  '[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
  '[exit code: 1]',
].join('\n')

const SAMPLE_B_STDERR = [
  "git : fatal: Unable to create 'C:/Users/72489/Documents/dsh-orchestrator/.git/index.lock': Permission denied",
  '所在位置 行:1 字符: 129',
  "+ ... coding]::new($false); git add test/action-errors.test.js 2>&1; git st ...",
  '+                           ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '    + CategoryInfo          : NotSpecified: (fatal: Unable t...rmission denied:String) [], RemoteException',
  '    + FullyQualifiedErrorId : NativeCommandError',
].join('\n')

const SAMPLE_B_CONTENT = [' M test/action-errors.test.js', '[stderr]', SAMPLE_B_STDERR].join('\n')

const execOf = (name, agentId) => ({ name, agent: { id: agentId, session: { id: agentId } }, callId: `c-${name}`, arguments: {} })

const sampleAExec = () => execOf('pwsh', 'm-a')
const sampleAResult = () => ({
  isError: false,
  content: [{ type: 'text', text: SAMPLE_A_CONTENT }],
  meta: { cwd: 'C:\\Users\\72489\\Documents\\dsh-orchestrator' },
  value: {
    cwd: 'C:\\Users\\72489\\Documents\\dsh-orchestrator',
    kind: 'foreground',
    exitCode: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 120000,
    stdout: { text: '', truncated: false },
    stderr: { text: SAMPLE_A_STDERR, truncated: false },
    sandbox: { mode: 'workspace-write', denied: true, enforcement: 'restricted-token' },
  },
})

const sampleBExec = () => execOf('pwsh', 'm-b')
const sampleBResult = () => ({
  isError: false,
  content: [{ type: 'text', text: SAMPLE_B_CONTENT }],
  meta: { cwd: 'C:\\Users\\72489\\Documents\\dsh-orchestrator' },
  value: {
    cwd: 'C:\\Users\\72489\\Documents\\dsh-orchestrator',
    kind: 'foreground',
    exitCode: 0, // ← 真机事实：git status 成功，退出码是 0
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 120000,
    stdout: { text: ' M test/action-errors.test.js\n', truncated: false },
    stderr: { text: SAMPLE_B_STDERR, truncated: false },
  },
})

/** 构造一次「结构化失败」结果（形状见 dsh-tools/src/contracts.ts:279-284：`error.info` 才有 code）。 */
const failedResult = (code, text = '') => ({
  isError: true,
  error: code === undefined
    ? { message: 'denied' }
    : { message: 'denied', info: { name: 'HarnessError', code } },
  content: text === '' ? [] : [{ type: 'text', text }],
})

/** 构造一次成功形状的命令结果。 */
const shellResult = ({ exitCode = 0, stderr = '', sandbox, signal = null, timedOut = false, aborted = false, stopped } = {}) => ({
  isError: false,
  content: [{ type: 'text', text: '' }],
  value: {
    kind: 'foreground',
    exitCode,
    signal,
    timedOut,
    aborted,
    ...(stopped === undefined ? {} : { stopped }),
    timeoutMs: 120000,
    stdout: { text: '', truncated: false },
    stderr: { text: stderr, truncated: false },
    ...(sandbox === undefined ? {} : { sandbox }),
  },
})

// ---- 两个真实样本（各 1 条） -------------------------------------------------------

test('真实样本 A（seq 816）：sandbox.denied → denied/SANDBOX_DENIED，带 mode 与 exitCode', () => {
  const hit = classifyToolFailure(sampleAExec(), sampleAResult())
  assert.equal(hit.kind, 'denied')
  assert.equal(hit.code, 'SANDBOX_DENIED')
  assert.equal(hit.tool, 'pwsh')
  assert.equal(hit.exitCode, 1)
  assert.equal(hit.sandboxMode, 'workspace-write')
  assert.match(hit.head, /Permission denied/)
})

test('真实样本 B（seq 824）：退出码 0、无沙箱标记，只有 stderr 认得出来 → denied/COMMAND_PERMISSION_DENIED', () => {
  const hit = classifyToolFailure(sampleBExec(), sampleBResult())
  assert.equal(hit.kind, 'denied')
  assert.equal(hit.code, 'COMMAND_PERMISSION_DENIED')
  // 真机退出码是 0：任何「exitCode !== 0」的前置条件都会把这条漏掉（这条断言就是那个回归）。
  assert.equal(hit.exitCode, 0)
  assert.equal(hit.sandboxMode, undefined)
  assert.match(hit.head, /index\.lock/)
  // 证据首行脱敏：家目录换成 ~，用户名不出现。
  assert.ok(hit.head.includes('~/Documents/dsh-orchestrator/.git/index.lock'), hit.head)
  assert.equal(hit.head.includes('72489'), false, '通知/日志里的家目录必须脱敏')
})

// ---- 判定矩阵（#3–#13） ------------------------------------------------------------

test('判定矩阵：结构化 code / 文本兜底 / 沙箱事实 / 中断 / 无关失败各归其位', () => {
  const cases = [
    // #3 fs 写入被只读/工作区沙箱拒：结构化 code 优先。
    {
      name: 'FS_SANDBOX_DENIED → denied',
      exec: execOf('write', 'm-a'),
      result: failedResult('FS_SANDBOX_DENIED', 'cannot write "C:\\x": file access denied under read-only mode'),
      expected: { kind: 'denied', code: 'FS_SANDBOX_DENIED' },
    },
    // #4 审批被拒 / 沙箱升级被拒：同样是 denied。
    { name: 'APPROVAL_REJECTED → denied', exec: execOf('pwsh', 'm-a'), result: failedResult('APPROVAL_REJECTED'), expected: { kind: 'denied', code: 'APPROVAL_REJECTED' } },
    { name: 'APPROVAL_UNAVAILABLE → denied', exec: execOf('pwsh', 'm-a'), result: failedResult('APPROVAL_UNAVAILABLE'), expected: { kind: 'denied', code: 'APPROVAL_UNAVAILABLE' } },
    { name: 'SANDBOX_ESCALATION_REJECTED → denied', exec: execOf('pwsh', 'm-a'), result: failedResult('SANDBOX_ESCALATION_REJECTED'), expected: { kind: 'denied', code: 'SANDBOX_ESCALATION_REJECTED' } },
    // #5 环境类：命令没跑起来（沙箱后端/准备失败、工具缺上下文）——只写日志。
    { name: 'SANDBOX_UNAVAILABLE → env', exec: execOf('pwsh', 'm-a'), result: failedResult('SANDBOX_UNAVAILABLE'), expected: { kind: 'env', code: 'SANDBOX_UNAVAILABLE' } },
    { name: 'SANDBOX_PREPARATION_FAILED → env', exec: execOf('pwsh', 'm-a'), result: failedResult('SANDBOX_PREPARATION_FAILED'), expected: { kind: 'env', code: 'SANDBOX_PREPARATION_FAILED' } },
    { name: 'SANDBOX_INVALID_TEMP_ROOT → env', exec: execOf('pwsh', 'm-a'), result: failedResult('SANDBOX_INVALID_TEMP_ROOT'), expected: { kind: 'env', code: 'SANDBOX_INVALID_TEMP_ROOT' } },
    { name: 'TOOL_CONTEXT_UNAVAILABLE → env', exec: execOf('memory_note', 'm-a'), result: failedResult('TOOL_CONTEXT_UNAVAILABLE'), expected: { kind: 'env', code: 'TOOL_CONTEXT_UNAVAILABLE' } },
    // #6 工具自身失败（找不到文件/搜索失败/被 abort）：不是权限也不是环境。
    { name: 'FS_NOT_FOUND → 丢弃', exec: execOf('read', 'm-a'), result: failedResult('FS_NOT_FOUND', 'ENOENT: no such file'), expected: undefined },
    { name: 'SEARCH_FAILED → 丢弃', exec: execOf('grep', 'm-a'), result: failedResult('SEARCH_FAILED'), expected: undefined },
    // #7 没有结构化身份（guard 以字符串拒绝）：正文兜底。
    { name: 'guard 文本拒绝访问 → denied/GUARD_TEXT_DENIED', exec: execOf('read', 'm-a'), result: failedResult(undefined, '读取被拒绝：拒绝访问'), expected: { kind: 'denied', code: 'GUARD_TEXT_DENIED' } },
    { name: 'guard 文本 ENOENT → env/TOOL_TEXT_ENV', exec: execOf('read', 'm-a'), result: failedResult(undefined, 'ENOENT: no such file or directory'), expected: { kind: 'env', code: 'TOOL_TEXT_ENV' } },
    // #8 非零退出但没有权限/环境语义（grep 无匹配、测试红）：不算失败。
    { name: 'exit 1 + 无权限词 → 丢弃', exec: execOf('pwsh', 'm-a'), result: shellResult({ exitCode: 1, stderr: '1 failing test (2 passed)' }), expected: undefined },
    // #9 非 shell 工具读到含 Permission denied 的正文：不参与文本通道。
    {
      name: 'read 正文含 Permission denied → 丢弃',
      exec: execOf('read', 'm-a'),
      result: { isError: false, content: [{ type: 'text', text: 'Permission denied' }], value: { text: 'Permission denied' } },
      expected: undefined,
    },
    // #10 被超时/取消/外部停止：中断不是失败。
    { name: 'timedOut → 丢弃', exec: execOf('pwsh', 'm-a'), result: shellResult({ exitCode: 1, stderr: 'Permission denied', timedOut: true }), expected: undefined },
    { name: 'aborted → 丢弃', exec: execOf('pwsh', 'm-a'), result: shellResult({ exitCode: 1, stderr: 'Permission denied', aborted: true }), expected: undefined },
    { name: 'stopped → 丢弃', exec: execOf('pwsh', 'm-a'), result: shellResult({ exitCode: 1, stderr: 'Permission denied', stopped: 'job killed' }), expected: undefined },
    { name: 'signal SIGTERM → 丢弃', exec: execOf('pwsh', 'm-a'), result: shellResult({ exitCode: 1, stderr: 'Permission denied', signal: 'SIGTERM' }), expected: undefined },
    // #11 runner 起不来：命令没跑，归 env。
    { name: 'sandbox.runnerFailed → env/SANDBOX_RUNNER_FAILED', exec: execOf('pwsh', 'm-a'), result: shellResult({ exitCode: 1, stderr: 'runner failed', sandbox: { mode: 'workspace-write', denied: false, runnerFailed: true } }), expected: { kind: 'env', code: 'SANDBOX_RUNNER_FAILED' } },
    // #12 取消类 code：中断 ≠ 权限拒绝。
    { name: 'APPROVAL_CANCELLED → 丢弃', exec: execOf('pwsh', 'm-a'), result: failedResult('APPROVAL_CANCELLED'), expected: undefined },
    { name: 'SANDBOX_ESCALATION_CANCELLED → 丢弃', exec: execOf('pwsh', 'm-a'), result: failedResult('SANDBOX_ESCALATION_CANCELLED'), expected: undefined },
    { name: 'ABORTED → 丢弃', exec: execOf('pwsh', 'm-a'), result: failedResult('ABORTED'), expected: undefined },
    // 命令找不到：env 文本兜底（不要求退出码非零之外的条件；这里退出码本来就是 127）。
    { name: 'command not found → env/COMMAND_ENV_FAILED', exec: execOf('pwsh', 'm-a'), result: shellResult({ exitCode: 127, stderr: "pwsh: The term 'foo' is not recognized as an internal or external command" }), expected: { kind: 'env', code: 'COMMAND_ENV_FAILED' } },
  ]
  for (const item of cases) {
    const hit = classifyToolFailure(item.exec, item.result)
    if (item.expected === undefined) {
      assert.equal(hit, undefined, `${item.name}：不该被判成权限/环境失败，实际 ${JSON.stringify(hit)}`)
      continue
    }
    assert.ok(hit !== undefined, `${item.name}：应判成 ${item.expected.kind}/${item.expected.code}，实际 undefined`)
    assert.equal(hit.kind, item.expected.kind, item.name)
    assert.equal(hit.code, item.expected.code, item.name)
  }
})

test('判定矩阵：code 清单按宿主实现分组，且互不重叠', () => {
  for (const code of DENIED_CODES) assert.equal(ENV_CODES.has(code), false, `${code} 不能同时是 denied 与 env`)
  for (const code of INTERRUPT_CODES) assert.equal(DENIED_CODES.has(code), false, `${code} 是中断，不是 denied`)
  assert.equal(DENIED_CODES.has('SANDBOX_UNAVAILABLE'), false)
  assert.equal(ENV_CODES.has('SANDBOX_UNAVAILABLE'), true)
})

// #13 防御：畸形输入不抛、不产 hit。
test('防御：null / 缺 name / 非对象 value 一律 undefined，不抛', () => {
  assert.equal(classifyToolFailure(undefined, undefined), undefined)
  assert.equal(classifyToolFailure(null, null), undefined)
  assert.equal(classifyToolFailure({}, sampleAResult()), undefined)
  assert.equal(classifyToolFailure({ name: 'pwsh' }, null), undefined)
  assert.equal(classifyToolFailure({ name: 'pwsh' }, { isError: false, value: 'oops' }), undefined)
  assert.equal(classifyToolFailure({ name: 'pwsh' }, { isError: false, value: { stderr: { text: '' } } }), undefined)
})

// ---- 证据首行：脱敏与截断 ----------------------------------------------------------

test('failureHead：优先命中行、家目录脱敏、限长 240', () => {
  assert.equal(redactHomePath("'C:\\Users\\72489\\a\\b'"), "'~\\a\\b'")
  assert.equal(redactHomePath("'C:/Users/72489/a/b'"), "'~/a/b'")
  assert.equal(redactHomePath('/home/alice/x'), '~/x')
  assert.equal(redactHomePath('/Users/alice/x'), '~/x')
  assert.equal(redactHomePath(undefined), '')
  // 命中行优先（第一行是无关的 stdout 回显时）。
  const head = failureHead('done!\nfatal: Permission denied', /permission denied/i)
  assert.equal(head, 'fatal: Permission denied')
  // 长行截断。
  const long = failureHead('x'.repeat(1000), /permission denied/i)
  assert.equal(long.length, TOOL_FAILURE_HEAD_MAX)
})

// ---- 去重 / 三档告警 ---------------------------------------------------------------

const TASK = {
  id: 't-1a2b3c4d',
  ref: 'tk-abc123',
  title: '失败监听冒烟',
  status: 'running',
  read_only: false,
  access: null,
}

function runtime({ now = () => 1_000, task = TASK, coordinatorId = () => 's-1' } = {}) {
  const logs = []
  const notices = []
  const watcher = createChildToolFailureWatcher({
    logger: { log(event, fields) { logs.push({ event, fields }) } },
    notifier: { summary(items, text) { notices.push({ items, text }); return { delivered: true } } },
    taskOfAgent: agentId => (agentId === 'm-b' ? task : undefined),
    coordinatorId,
    labelFor: item => item.title,
    now,
    onWarn: () => {},
  })
  const events = name => logs.filter(entry => entry.event === name)
  return { logs, notices, watcher, events }
}

test('去重：同 (taskId, tool, code) 10 分钟内只通知一次，被压住的留 suppressed 审计行', () => {
  let clock = 1_000
  const r = runtime({ now: () => clock })
  for (let index = 0; index < 3; index += 1) r.watcher.handle(sampleBExec(), sampleBResult())
  assert.equal(r.notices.length, 1, '三次同键命中只发一条通知')
  assert.equal(r.events('subagent.tool.failure').length, 3, '日志每条都写（不丢证据）')
  const suppressed = r.events('subagent.tool.failure.suppressed')
  assert.deepEqual(suppressed.map(entry => entry.fields.detail.repeat), [1, 2])
  // 不同工具 / 不同 code 各自独立一条。
  r.watcher.handle(execOf('bash', 'm-b'), shellResult({ exitCode: 1, stderr: 'Permission denied', sandbox: { mode: 'workspace-write', denied: true } }))
  assert.equal(r.notices.length, 2)
  assert.equal(r.watcher.size(), 2)
  // 窗口过后允许再报（键还在表里，但时间超过了）。
  clock += TOOL_FAILURE_DEDUPE_MS + 1
  r.watcher.handle(sampleBExec(), sampleBResult())
  assert.equal(r.notices.length, 3)
})

test('去重窗口可用 DSH_ORCH_TOOL_FAILURE_MS 旁路（只调窗口、不改语义）', () => {
  assert.equal(toolFailureDedupeMs({}), TOOL_FAILURE_DEDUPE_MS)
  assert.equal(toolFailureDedupeMs({ DSH_ORCH_TOOL_FAILURE_MS: '0' }), 0)
  assert.equal(toolFailureDedupeMs({ DSH_ORCH_TOOL_FAILURE_MS: 'nope' }), TOOL_FAILURE_DEDUPE_MS)
  let clock = 0
  const r = runtime({ now: () => clock })
  const quick = createChildToolFailureWatcher({
    logger: { log(event, fields) { r.logs.push({ event, fields }) } },
    notifier: { summary(items, text) { r.notices.push({ items, text }); return { delivered: true } } },
    taskOfAgent: () => TASK,
    coordinatorId: () => undefined,
    labelFor: task => task.title,
    now: () => clock,
    dedupeMs: 0,
  })
  quick.handle(sampleBExec(), sampleBResult())
  clock += 1
  quick.handle(sampleBExec(), sampleBResult())
  assert.equal(r.notices.length, 2, '窗口 0 = 每次都能报（测试旁路）')
})

test('env 类只写日志、不发通知；终态任务的迟到事件也只写日志', () => {
  const r = runtime()
  r.watcher.handle(execOf('pwsh', 'm-b'), failedResult('SANDBOX_UNAVAILABLE', 'no sandbox backend'))
  assert.equal(r.events('subagent.tool.failure').length, 1)
  assert.equal(r.events('subagent.tool.failure')[0].fields.detail.kind, 'env')
  assert.equal(r.notices.length, 0, 'env 不进通知档')

  const done = runtime({ task: { ...TASK, status: 'done' } })
  done.watcher.handle(sampleBExec(), sampleBResult())
  assert.equal(done.events('subagent.tool.failure').length, 1, '终态任务的失败仍留日志')
  assert.equal(done.notices.length, 0, '终态任务不再打扰协调者')
})

test('归属过滤：协调者自身调用与非任务子会话都不进日志/通知', () => {
  const r = runtime()
  r.watcher.handle(execOf('pwsh', 's-1'), sampleBResult())       // 协调者自己
  r.watcher.handle(execOf('pwsh', 'pack-session'), sampleBResult()) // 能力包/普通 root 会话
  r.watcher.handle({ name: 'pwsh' }, sampleBResult())            // 没有 agent
  assert.equal(r.logs.length, 0)
  assert.equal(r.notices.length, 0)
})

test('通知文案：任务名 + tk- 引用 + code + 工具名，不出现台账内部编号', () => {
  const r = runtime()
  r.watcher.handle(sampleBExec(), sampleBResult())
  assert.equal(r.notices.length, 1)
  const { items, text } = r.notices[0]
  assert.equal(items[0].taskId, TASK.id)
  assert.equal(items[0].status, 'failed')
  assert.equal(items[0].system, true, '没有子会话 sender 的系统通知要带 system:true')
  assert.match(text, /tk-abc123/)
  assert.match(text, /失败监听冒烟/)
  assert.match(text, /COMMAND_PERMISSION_DENIED/)
  assert.match(text, /pwsh/)
  assert.match(text, /~\/Documents\/dsh-orchestrator/)
  assert.equal(/t-[0-9a-f]{8}/.test(text), false, '通知不许出现台账内部编号')
  assert.equal(text.includes('72489'), false, '通知里的家目录已脱敏')
  // 文案本体来自 copy.js（工具名/code 缺失时也有可读兜底）。
  assert.match(toolFailureNotice({ label: 'x', ref: '', tool: 'pwsh', code: 'C' }), /子会话被权限\/沙箱拒绝/)
})

test('内部异常不外溢：logger/notifier 抛错只 warn 一次，handle 不抛', () => {
  const warnings = []
  const watcher = createChildToolFailureWatcher({
    logger: { log() { throw new Error('log boom') } },
    notifier: { summary() { throw new Error('notify boom') } },
    taskOfAgent: () => TASK,
    coordinatorId: () => undefined,
    labelFor: () => 'x',
    onWarn: message => warnings.push(message),
  })
  // 观察者绝不能反过来打断工具链路：判定结果照常返回，异常走 onWarn（log 失败已被 log() 吞掉）。
  const hit = watcher.handle(sampleBExec(), sampleBResult())
  assert.equal(hit.kind, 'denied')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /通知失败/)
})
