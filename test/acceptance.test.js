import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const strict = await runChecks({ checks: [check('缺失', ['orch-no-such-cmd'])], cwd, spawnImpl: missing })
  assert.equal(strict.ok, false)
  assert.equal(strict.results[0].error, 'ENOENT')
  assert.equal(strict.results[0].skipped, false)
  assert.match(acceptanceFailureText(strict), /命令不存在（ENOENT）/)

  const lenient = await runChecks({
    checks: [check('缺失', ['orch-no-such-cmd'], { skipIfMissing: true })],
    cwd,
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
    spawnImpl: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) },
  })
  assert.equal(syncThrow.ok, true)
  assert.equal(syncThrow.skipped, 1)
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
