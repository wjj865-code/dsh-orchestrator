import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_CHECKS, MAX_OUTPUT_BYTES, acceptanceCountText, acceptanceDetailBlock, acceptanceFailureText,
  acceptancePassText, acceptanceStatusLines, checksOf, commandText, executionDirOf, normalizeChecks, runChecks,
} from '../src/acceptance.js'
import { canSpawnWithPipes, PIPE_SPAWN_SKIP_REASON } from './helpers.js'

const dir = () => mkdtempSync(join(tmpdir(), 'orch-accept-'))

// 假子进程：只实现 runChecks 真正用到的接口（stdout/stderr/on/kill/exitCode）。
const fakeChild = ({ stdout = '', stderr = '', code = 0, error, hang = false } = {}) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.killed = false
  child.kill = signal => {
    child.killed = true
    if (hang) queueMicrotask(() => { child.exitCode = null; child.emit('close', null, signal ?? 'SIGTERM') })
  }
  if (hang) return child
  process.nextTick(() => {
    if (error === true) {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      return
    }
    if (stdout !== '') child.stdout.emit('data', Buffer.from(stdout))
    if (stderr !== '') child.stderr.emit('data', Buffer.from(stderr))
    child.exitCode = code
    child.emit('close', code, null)
  })
  return child
}

const check = (name, argv, extra = {}) => ({ name, argv, timeoutMs: 120_000, skipIfMissing: false, ...extra })

test('normalizeChecks：缺省/空数组 = 没有检查；缺省 name 与 timeout 归一', () => {
  assert.deepEqual(normalizeChecks(undefined), { ok: true, checks: [] })
  assert.deepEqual(normalizeChecks(null), { ok: true, checks: [] })
  assert.deepEqual(normalizeChecks([]), { ok: true, checks: [] })
  const normalized = normalizeChecks([{ command: ['node', '--test'] }, { name: '类型检查', command: ['pnpm', 'typecheck'], timeoutMs: 600000, skipIfMissing: true }])
  assert.equal(normalized.ok, true)
  assert.deepEqual(normalized.checks[0], { name: 'check-1', argv: ['node', '--test'], timeoutMs: 120_000, skipIfMissing: false })
  assert.deepEqual(normalized.checks[1], { name: '类型检查', argv: ['pnpm', 'typecheck'], timeoutMs: 600000, skipIfMissing: true })
})

test('normalizeChecks：拒绝 shell 字符串 / 空命令 / 超限 / 非法 timeout / 未知字段 / 重名', () => {
  const cases = [
    [{ command: 'pnpm test' }, /argv 数组/],
    [{ command: [] }, /不能是空数组/],
    [{ command: ['node', ''] }, /不能为空/],
    [{ command: [123] }, /必须是字符串/],
    [{ command: ['node', 'a\u0000b'] }, /NUL/],
    [{ command: ['node'], timeoutMs: 999 }, /timeoutMs 必须在/],
    [{ command: ['node'], timeoutMs: 600001 }, /timeoutMs 必须在/],
    [{ command: ['node'], timeoutMs: 1000.5 }, /timeoutMs 必须在/],
    [{ command: ['node'], timeoutMs: '1000' }, /必须是数字/],
    [{ command: ['node'], skipIfMissing: 'yes' }, /必须是布尔值/],
    [{ command: ['node'], shell: true }, /不认识的字段/],
    [{ command: ['x'.repeat(2001)] }, /太长/],
  ]
  for (const [input, pattern] of cases) {
    const result = normalizeChecks([input])
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(input)}`)
    assert.match(result.error, pattern)
  }
  assert.equal(normalizeChecks([{ name: 'a', command: ['node'] }, { name: 'a', command: ['node'] }]).ok, false)
  assert.equal(normalizeChecks(Array.from({ length: MAX_CHECKS + 1 }, () => ({ command: ['node'] }))).ok, false)
  assert.equal(normalizeChecks('node --test').ok, false)
})

test('展示辅助：commandText 会引号包住含空白的参数；checksOf 只认 brief 快照', () => {
  assert.equal(commandText(['node', '-e', 'process.exit(0)']), 'node -e "process.exit(0)"')
  const task = { brief: { checks: [{ name: 'c1', command: ['node', '--test'] }] } }
  assert.deepEqual(checksOf(task).map(item => item.argv), [['node', '--test']])
  // 坏数据（旧版字符串命令/手工改库）当没有检查，不让交付流程崩。
  assert.deepEqual(checksOf({ brief: { checks: [{ command: 'pnpm test' }] } }), [])
  assert.deepEqual(checksOf({ brief: { checks: 'oops' } }), [])
  // 执行目录：worktree 检出优先，其次 target_dir，绝不回落到主会话目录。
  assert.equal(executionDirOf({ worktree_path: 'C:/wt', target_dir: 'C:/repo' }), 'C:/wt')
  assert.equal(executionDirOf({ worktree_path: null, target_dir: 'C:/repo' }), 'C:/repo')
  assert.equal(executionDirOf({}), '')
})

test('runChecks：全通过；argv 原样传参、shell:false、cwd=任务目录', async () => {
  const cwd = dir()
  const calls = []
  const result = await runChecks({
    checks: [check('测试', ['node', '--test']), check('类型', ['pnpm', 'typecheck'])],
    cwd,
    // 用 linux 平台锁「非 Windows 原样 spawn argv」这条契约；Windows 的解析/ComSpec 分支见下面的专测。
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return fakeChild({ stdout: `ok ${command}\n` })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.total, 2)
  assert.equal(result.passed, 2)
  assert.equal(result.skipped, 0)
  assert.equal(result.failed, 0)
  assert.equal(result.cwd, cwd)
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[0].exitCode, 0)
  assert.equal(result.results[0].outputTail, 'ok node\n')
  assert.equal(calls.length, 2)
  // 安全边界：命令拆成 argv、shell 关闭、cwd 固定——这三点是「不能注入 shell」的全部依据。
  assert.equal(calls[0].command, 'node')
  assert.deepEqual(calls[0].args, ['--test'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.cwd, cwd)
  assert.equal(acceptanceCountText(result), '验收：2/2 通过')
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：非零退出 → 失败并带输出尾部；失败文案点名检查', async () => {
  const cwd = dir()
  const result = await runChecks({
    checks: [check('单测', ['node', '-e', 'process.exit(3)'])],
    cwd,
    spawnImpl: () => fakeChild({ code: 3, stderr: 'boom\n' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.failed, 1)
  assert.equal(result.results[0].exitCode, 3)
  assert.match(result.results[0].outputTail, /\[stderr\]\nboom/)
  assert.equal(acceptanceCountText(result), '验收：0/1 通过（未通过 单测）')
  const failure = acceptanceFailureText(result)
  assert.match(failure, /验收未通过/)
  assert.match(failure, /单测/)
  assert.match(failure, /退出码 3/)
  assert.match(failure, /boom/)
  assert.match(failure, /状态不变/)
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：超时 → timedOut=true、exitCode=null、不通过', async () => {
  const cwd = dir()
  const result = await runChecks({
    checks: [check('慢', ['node', 'slow.js'], { timeoutMs: 20 })],
    cwd,
    killGraceMs: 20,
    spawnImpl: () => fakeChild({ hang: true }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.results[0].timedOut, true)
  assert.equal(result.results[0].exitCode, null)
  assert.equal(result.results[0].ok, false)
  assert.match(acceptanceFailureText(result), /超时被杀/)
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：命令不存在 → skipIfMissing 决定「跳过」还是「失败」', async () => {
  const cwd = dir()
  const missing = () => fakeChild({ error: true })
  // 用 linux 平台走「spawn 报 ENOENT」这条路径；Windows 的 PATH 解析失败见下一条专测。
  const strict = await runChecks({
    checks: [check('缺失', ['orch-no-such-cmd'])], cwd, platform: 'linux', spawnImpl: missing,
  })
  assert.equal(strict.ok, false)
  assert.equal(strict.results[0].error, 'ENOENT')
  assert.equal(strict.results[0].skipped, false)
  assert.match(acceptanceFailureText(strict), /命令不存在（ENOENT）/)

  const lenient = await runChecks({
    checks: [check('缺失', ['orch-no-such-cmd'], { skipIfMissing: true })],
    cwd,
    platform: 'linux',
    spawnImpl: missing,
  })
  assert.equal(lenient.ok, true, '§ 跳过不算失败：缺 pnpm 不该卡死交付')
  assert.equal(lenient.skipped, 1)
  assert.equal(lenient.failed, 0)
  assert.match(acceptancePassText(lenient), /跳过 1 条/)
  // spawn 同步抛（个别平台/注入实现）也按同一个口径处理。
  const syncThrow = await runChecks({
    checks: [check('缺失', ['orch-no-such-cmd'], { skipIfMissing: true })],
    cwd,
    platform: 'linux',
    spawnImpl: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) },
  })
  assert.equal(syncThrow.ok, true)
  assert.equal(syncThrow.skipped, 1)
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：Windows 上解析不到命令 → 不再 spawn，按 ENOENT 记账并把查找过的路径写进输出尾部', async () => {
  const cwd = dir()
  const calls = []
  const spawnImpl = () => { calls.push(1); return fakeChild() }
  const options = {
    cwd,
    platform: 'win32',
    env: { PATH: 'C:\\pnpm\\bin', PATHEXT: '.EXE;.CMD' },
    isFile: () => false,
    spawnImpl,
  }
  const strict = await runChecks({ ...options, checks: [check('缺', ['pnpm', 'test'])] })
  assert.equal(strict.ok, false)
  assert.equal(strict.results[0].error, 'ENOENT')
  assert.equal(strict.results[0].missing, true)
  assert.equal(strict.results[0].skipped, false)
  const failure = acceptanceFailureText(strict)
  assert.match(failure, /命令不存在（ENOENT）/)
  assert.match(failure, /未找到命令「pnpm」/)
  assert.match(failure, /C:\\pnpm\\bin\\pnpm\.EXE/)
  assert.match(failure, /PATHEXT/)

  const lenient = await runChecks({
    ...options,
    checks: [check('缺', ['pnpm', 'test'], { skipIfMissing: true })],
  })
  assert.equal(lenient.ok, true)
  assert.equal(lenient.skipped, 1)
  // 跳过也要说清原因：旧版在 Windows 上就是这么静默跳过的
  assert.match(acceptancePassText(lenient), /已跳过（skipIfMissing）：缺（命令未找到）/)
  assert.match(acceptanceStatusLines(lenient)[1], /已跳过（命令未找到）/)
  assert.deepEqual(calls, [], '没解析到命令就不该再 spawn')
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：Windows 上无扩展名的 pnpm 解析到 .cmd → 经 ComSpec /d /s /c 执行（逐项转义）', async () => {
  const cwd = dir()
  const calls = []
  const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATH: 'C:\\pnpm\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const result = await runChecks({
    checks: [check('测试', ['pnpm', 'test', '--', 'a&b c'])],
    cwd,
    platform: 'win32',
    env,
    isFile: candidate => candidate.toLowerCase() === 'c:\\pnpm\\bin\\pnpm.cmd',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return fakeChild({ stdout: 'ok\n' })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.command, env.ComSpec, '批处理只能由 ComSpec 执行（CreateProcess 直接跑 .cmd 会 EINVAL）')
  assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c'])
  const line = call.args[3]
  assert.match(line, /^".*"$/)
  assert.ok(line.includes('pnpm.CMD'))
  assert.ok(line.includes('^&'), '& 必须被 ^ 兜住，不能变成命令分隔符')
  assert.ok(line.includes('^"a^&b^ c^"'), '含空格/元字符的参数整项被引号包住')
  // 安全边界：shell 仍是 false，命令行由我们逐项转义后原样交给 ComSpec
  assert.equal(call.options.shell, false)
  assert.equal(call.options.windowsVerbatimArguments, true)
  assert.equal(call.options.cwd, cwd)
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：Windows 上 .cmd 参数含双引号 → 判失败（不做拼接），skipIfMissing 也不跳过', async () => {
  const cwd = dir()
  const calls = []
  const result = await runChecks({
    checks: [check('引号', ['pnpm', 'exec', 'node', '-e', 'console.log("x")'], { skipIfMissing: true })],
    cwd,
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATH: 'C:\\pnpm\\bin', PATHEXT: '.CMD' },
    isFile: () => true,
    spawnImpl: () => { calls.push(1); return fakeChild() },
  })
  assert.equal(result.ok, false, '参数无法安全传递是配置问题，不是「命令缺失」')
  assert.equal(result.results[0].error, 'UNSAFE_ARG')
  assert.equal(result.results[0].skipped, false)
  assert.match(result.results[0].outputTail, /command\[4\]/)
  assert.match(acceptanceFailureText(result), /参数无法安全传给 cmd\.exe/)
  assert.deepEqual(calls, [], '拒绝执行，绝不拼串')
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：输出只留尾部且标记截断', async () => {
  const cwd = dir()
  const result = await runChecks({
    checks: [check('啰嗦', ['node', 'verbose.js'])],
    cwd,
    maxOutputBytes: 32,
    spawnImpl: () => fakeChild({ stdout: 'a'.repeat(100) + 'TAIL' }),
  })
  assert.equal(result.results[0].truncated, true)
  assert.ok(result.results[0].outputTail.length <= 32)
  assert.match(result.results[0].outputTail, /TAIL$/)
  assert.ok(MAX_OUTPUT_BYTES >= 4096, '默认每条流 4 KiB 才够排查构建/测试失败')
  rmSync(cwd, { recursive: true, force: true })
})

test('runChecks：没有执行目录 / 目录不存在 → 不执行、全判失败（不回落主会话目录）', async () => {
  const calls = []
  const spawnImpl = () => { calls.push(1); return fakeChild() }
  const noDir = await runChecks({ checks: [check('c', ['node'])], cwd: '', spawnImpl })
  assert.equal(noDir.ok, false)
  assert.equal(noDir.cwd, null)
  assert.equal(noDir.results[0].error, 'CWD_MISSING')
  assert.match(noDir.results[0].outputTail, /任务没有目标目录/)
  const parent = dir()
  const missingDir = await runChecks({ checks: [check('c', ['node'])], cwd: join(parent, 'nope'), spawnImpl })
  assert.equal(missingDir.ok, false)
  assert.match(missingDir.results[0].outputTail, /不存在/)
  assert.deepEqual(calls, [], '目录不合格时一条命令都不能执行')
  rmSync(parent, { recursive: true, force: true })
})

test('文案：task_detail 检查清单、task_status 验收段', () => {
  const block = acceptanceDetailBlock([check('c1', ['node', '--test'], { timeoutMs: 60_000, skipIfMissing: true })])
  assert.match(block, /【可执行检查】/)
  assert.match(block, /c1：node --test（超时 60s；命令缺失时跳过）/)
  const lines = acceptanceStatusLines({
    ok: false, total: 2, passed: 1, skipped: 0, failed: 1, ranAt: 1_700_000_000_000, cwd: 'C:/w',
    results: [
      { name: 'a', command: 'node a', ok: true, durationMs: 5, exitCode: 0, truncated: false },
      { name: 'b', command: 'node b', ok: false, durationMs: 7, exitCode: 2, truncated: true },
    ],
  })
  assert.match(lines[0], /验收：1\/2 通过（未通过 b）/)
  assert.match(lines[0], /C:\/w/)
  assert.match(lines[1], /a（node a）：通过/)
  assert.match(lines[2], /b（node b）：失败\(2\)｜7ms｜输出已截断/)
  assert.deepEqual(acceptanceStatusLines(null), [])
})

test('真进程：退出码 0 通过、非 0 被拒、命令不存在触发 ENOENT', async t => {
  if (!canSpawnWithPipes()) return t.skip(PIPE_SPAWN_SKIP_REASON)
  const cwd = dir()
  const ok = await runChecks({ checks: [check('pass', [process.execPath, '-e', 'process.exit(0)'])], cwd })
  assert.equal(ok.ok, true)
  assert.equal(ok.results[0].exitCode, 0)
  const bad = await runChecks({ checks: [check('fail', [process.execPath, '-e', 'process.exit(7)', 'ignored'])], cwd })
  assert.equal(bad.ok, false)
  assert.equal(bad.results[0].exitCode, 7)
  const missing = await runChecks({ checks: [check('missing', ['orch-definitely-no-such-command-xyz'])], cwd })
  assert.equal(missing.ok, false)
  assert.equal(missing.results[0].error, 'ENOENT')
  rmSync(cwd, { recursive: true, force: true })
})

test('真进程：超时会被杀掉（timedOut=true），不会一直挂住', async t => {
  if (!canSpawnWithPipes()) return t.skip(PIPE_SPAWN_SKIP_REASON)
  const cwd = dir()
  const result = await runChecks({
    checks: [check('hang', [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 50 })],
    cwd,
    killGraceMs: 200,
  })
  assert.equal(result.ok, false)
  assert.equal(result.results[0].timedOut, true)
  assert.equal(result.results[0].ok, false)
  rmSync(cwd, { recursive: true, force: true })
})

test('真进程：cwd 就是任务目录（命令拿到的 process.cwd() 一致）', async t => {
  if (!canSpawnWithPipes()) return t.skip(PIPE_SPAWN_SKIP_REASON)
  const cwd = dir()
  const result = await runChecks({
    checks: [check('pwd', [process.execPath, '-e', 'process.stdout.write(process.cwd())'])],
    cwd,
  })
  assert.equal(result.ok, true)
  assert.equal(result.results[0].outputTail, cwd)
  rmSync(cwd, { recursive: true, force: true })
})

// —— Windows 真机用例：这两条是本次修复的回归点（裸 pnpm 被静默跳过、.cmd 执行不了）。
// Linux CI 上没有 PATHEXT/.cmd 语义可复现，明确 skip 并说明原因，不假装通过。

test('真进程（Windows）：裸 pnpm 解析到 pnpm.CMD 并真跑通，不再被 skipIfMissing 静默跳过', async t => {
  if (process.platform !== 'win32') {
    return t.skip('只有 Windows 才有「无扩展名命令 → *.cmd shim」这套语义（PATHEXT/ComSpec）：Linux CI 无法复现，纯函数分支已由 check-command.test.js 覆盖')
  }
  if (!canSpawnWithPipes()) return t.skip(PIPE_SPAWN_SKIP_REASON)
  const cwd = dir()
  const result = await runChecks({ checks: [check('pnpm', ['pnpm', '-v'], { skipIfMissing: true })], cwd })
  if (result.skipped === 1) {
    return t.skip('这台机器确实没有 pnpm（PATH 里找不到 .cmd/.exe 入口）：跳过，不是被测逻辑静默跳过')
  }
  assert.equal(result.ok, true, `有 pnpm 就必须真跑通：${result.results[0].outputTail}`)
  assert.match(result.results[0].outputTail, /\d+\.\d+/, 'pnpm -v 的版本号应出现在输出里')
  rmSync(cwd, { recursive: true, force: true })
})

test('真进程（Windows）：.cmd 经 ComSpec 执行，带空格的参数原样到达', async t => {
  if (process.platform !== 'win32') {
    return t.skip('只有 Windows 才有 .cmd/ComSpec 边界：Linux CI 无法复现，ComSpec 参数构造已由 check-command.test.js 断言')
  }
  if (!canSpawnWithPipes()) return t.skip(PIPE_SPAWN_SKIP_REASON)
  const cwd = dir()
  const probe = join(cwd, 'orch-args-probe.cmd')
  writeFileSync(probe, '@echo off\r\n> "%~dp0args.txt" echo(%~1\r\nexit /b 0\r\n', 'utf8')
  const result = await runChecks({ checks: [check('探针', [probe, 'a b'])] , cwd })
  assert.equal(result.ok, true, `经 ComSpec 的 .cmd 应退出 0：${result.results[0].outputTail}`)
  assert.equal(readFileSync(join(cwd, 'args.txt'), 'utf8').trim(), 'a b')
  rmSync(cwd, { recursive: true, force: true })
})
