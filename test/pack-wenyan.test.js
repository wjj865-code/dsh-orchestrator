import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWenyanArgs, classifyWenyanFailure, draftRecordPath, duplicateDraftPrompt, parseMediaId,
  parsePublishResult, publishDraft, readDraftRecord, renderSmoke, renderToFile, resolveInvocation,
  versionCheck, writeDraftRecord,
} from '../src/pack/wenyan.js'

// P5 文颜封装：命令解析、render 冒烟、publish 解析、错误映射、草稿记账。
// 每条都对着一个真会发生的坏结局：猜成功（草稿没建成却报成功）、自动重试（草稿箱重复）、
// 凭据进命令行、入口用 junction 路径直接跑、HTML 写进用户 APPDATA。

const INVOCATION = Object.freeze({
  ok: true,
  node: 'C:/node/node.exe',
  entry: 'C:/state/tools/wechat-mp-article/node_modules/@wenyan-md/cli/dist/cli.js',
  version: '2.0.12',
  appDataDir: 'C:/state/packs/wechat-mp-article/.state/wenyan',
})

const workDir = () => mkdtempSync(join(tmpdir(), 'dsh-wenyan-'))

test('P5 调用解析：未装 / 失败 / 入口丢失 / 正常四种形态', () => {
  assert.equal(resolveInvocation(undefined).code, 'CLI_NOT_INSTALLED')
  assert.equal(resolveInvocation({ status: 'failed', error: 'boom' }).code, 'CLI_NOT_INSTALLED')
  assert.match(resolveInvocation({ status: 'failed', error: 'boom' }).error, /boom/)
  assert.equal(resolveInvocation({ status: 'installed', resolved: {} }).code, 'CLI_BROKEN')
  const missing = resolveInvocation({ status: 'installed', resolved: { node: 'n', entry: 'e' } }, { exists: () => false })
  assert.equal(missing.code, 'CLI_BROKEN')
  const ok = resolveInvocation({
    status: 'installed', version: '2.0.12', appDataDir: 'C:/w',
    resolved: { node: 'C:/node/node.exe', entry: 'C:/cli.js' },
  }, { exists: () => true })
  assert.equal(ok.ok, true)
  assert.equal(ok.appDataDir, 'C:/w')
})

test('P5 argv：render/publish 只带必要参数；publish 绝不用 --app-id/--env-file/--api-key', () => {
  assert.deepEqual(buildWenyanArgs({ command: 'render', file: 'out/article.md' }),
    ['render', '-f', 'out/article.md', '-t', 'default'])
  const publish = buildWenyanArgs({ command: 'publish', file: 'out/article.md', theme: 'orange' })
  assert.deepEqual(publish, ['publish', '-f', 'out/article.md', '-t', 'orange'])
  for (const forbidden of ['--app-id', '--env-file', '--api-key', '--api-key-file']) {
    assert.equal(publish.includes(forbidden), false, `publish 不得出现 ${forbidden}（凭据只走 env）`)
  }
  assert.deepEqual(buildWenyanArgs({ command: '--version' }), ['--version'])
  assert.deepEqual(buildWenyanArgs({ command: 'theme', extra: ['-l'] }), ['theme', '-l'])
  assert.throws(() => buildWenyanArgs({ command: 'serve' }), /不支持/)
  assert.throws(() => buildWenyanArgs({ command: 'render', file: '' }), /需要 -f/)
})

test('P5 publish 解析：只有 exit 0 + Media ID 才算成功；没有就是 unknown（不猜）', () => {
  assert.equal(parseMediaId('发布成功，Media ID: abc-123_X'), 'abc-123_X')
  assert.equal(parseMediaId('media id：xyz'), 'xyz')
  assert.equal(parseMediaId('发布成功'), undefined)
  assert.deepEqual(parsePublishResult({ exitCode: 0, stdout: '发布成功，Media ID: abc' }), { ok: true, mediaId: 'abc' })
  const unknown = parsePublishResult({ exitCode: 0, stdout: '发布成功（没有 id）' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'PUBLISH_UNKNOWN')
  assert.match(unknown.hint, /不猜成功/)
})

test('P5 错误映射：invalid ip / 凭据 / 图片 / 超时 / frontmatter 都给可操作提示', () => {
  assert.equal(classifyWenyanFailure({ stderr: 'invalid ip 1.2.3.4' }).code, 'WECHAT_IP_NOT_ALLOWED')
  assert.match(classifyWenyanFailure({ stderr: 'invalid ip' }).hint, /白名单/)
  assert.equal(classifyWenyanFailure({ stderr: '{"errcode":40013,"errmsg":"invalid appid"}' }).code, 'WECHAT_CREDENTIALS_INVALID')
  assert.equal(classifyWenyanFailure({ stderr: 'invalid secret' }).code, 'WECHAT_CREDENTIALS_INVALID')
  assert.equal(classifyWenyanFailure({ stderr: 'image not exist: assets/a.png' }).code, 'IMAGE_INVALID')
  assert.equal(classifyWenyanFailure({ stderr: 'connect ETIMEDOUT' }).code, 'NETWORK_FAILED')
  assert.equal(classifyWenyanFailure({ stderr: 'frontmatter title required' }).code, 'FRONTMATTER_INVALID')
  const generic = classifyWenyanFailure({ stderr: 'boom', exitCode: 2 })
  assert.equal(generic.code, 'WENYAN_FAILED')
  assert.match(generic.error, /退出码 2/)
})

test('P5 renderToFile：stdout 落文件、APPDATA 重定向、入口走 resolved、空文件判失败', async () => {
  const dir = workDir()
  const input = join(dir, 'article.md')
  writeFileSync(input, '---\ntitle: t\n---\n\n正文\n')
  const calls = []
  const runner = async ({ command, args, env, stdoutFile }) => {
    calls.push({ command, args, env, stdoutFile })
    writeFileSync(stdoutFile, '<section id="wenyan">html</section>')
    return { code: 0, stdout: '', stderrTail: '', bytes: 27, timedOut: false }
  }
  const out = join(dir, 'article.html')
  const result = await renderToFile({ invocation: INVOCATION, inputFile: input, outFile: out, runner, env: { PATH: 'x', APPDATA: 'C:/Users/x/AppData/Roaming' } })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.bytes > 0, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, INVOCATION.node)
  assert.deepEqual(calls[0].args.slice(0, 3), [INVOCATION.entry, 'render', '-f'])
  assert.equal(calls[0].env.APPDATA, INVOCATION.appDataDir, 'APPDATA 必须重定向到包内 .state/wenyan')
  assert.equal(calls[0].env.LOCALAPPDATA, INVOCATION.appDataDir)

  const empty = await renderToFile({
    invocation: INVOCATION, inputFile: input, outFile: join(dir, 'empty.html'),
    runner: async ({ stdoutFile }) => { writeFileSync(stdoutFile, ''); return { code: 0, stdout: '', stderrTail: '' } },
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'RENDER_EMPTY')

  const missing = await renderToFile({ invocation: INVOCATION, inputFile: join(dir, 'nope.md'), outFile: out, runner })
  assert.equal(missing.code, 'INPUT_MISSING')
})

test('P5 render 冒烟：有 <section> 才算通过；失败给可读原因', async () => {
  const dir = workDir()
  const smoke = join(dir, 'smoke.md')
  writeFileSync(smoke, '---\ntitle: smoke\n---\n\n正文\n')
  const good = await renderSmoke({
    invocation: INVOCATION, smokeFile: smoke,
    runner: async ({ stdoutFile }) => { writeFileSync(stdoutFile, '<section>ok</section>'); return { code: 0 } },
  })
  assert.equal(good.ok, true, good.error)
  const bad = await renderSmoke({
    invocation: INVOCATION, smokeFile: smoke,
    runner: async ({ stdoutFile }) => { writeFileSync(stdoutFile, '<div>not wechat</div>'); return { code: 0 } },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'SMOKE_INVALID')
  const missing = await renderSmoke({ invocation: INVOCATION, smokeFile: join(dir, 'none.md') })
  assert.equal(missing.code, 'SMOKE_MISSING')
})

test('P5 publish：失败只调用一次（不自动重试），成功解析 Media ID 并保留尾部输出', async () => {
  const dir = workDir()
  const input = join(dir, 'article.md')
  writeFileSync(input, '---\ntitle: t\n---\n\n正文\n')
  let calls = 0
  const failing = async () => {
    calls += 1
    return { code: 1, stdout: '', stderrTail: '{"errcode":40013,"errmsg":"invalid appid"}', timedOut: false }
  }
  const failed = await publishDraft({ invocation: INVOCATION, inputFile: input, runner: failing })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'WECHAT_CREDENTIALS_INVALID')
  assert.equal(calls, 1, '失败不自动重试（publish 无幂等）')
  assert.match(failed.stderrTail, /40013/)

  const okRunner = async () => ({ code: 0, stdout: '发布成功，Media ID: media-9', stderrTail: '', timedOut: false })
  const ok = await publishDraft({ invocation: INVOCATION, inputFile: input, runner: okRunner })
  assert.equal(ok.ok, true)
  assert.equal(ok.mediaId, 'media-9')
})

test('P5 草稿记账：out/draft.json 只含 mediaId/标题/时间/主题，重复提示可读', () => {
  const dir = workDir()
  const written = writeDraftRecord({ workDir: dir, mediaId: 'm-1', title: '标题', theme: 'default', now: () => 1700000000000 })
  assert.equal(written.path, draftRecordPath(dir))
  const record = JSON.parse(readFileSync(draftRecordPath(dir), 'utf8'))
  assert.equal(record.mediaId, 'm-1')
  assert.equal(record.title, '标题')
  assert.equal(record.theme, 'default')
  assert.equal(record.at, '2023-11-14T22:13:20.000Z')
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(serialized, /WECHAT_APP_SECRET|secret|token/i, '草稿记录不得包含凭据字段')
  const read = readDraftRecord(dir)
  assert.equal(read.record.mediaId, 'm-1')
  assert.match(duplicateDraftPrompt(read.record), /Media ID m-1/)
  assert.match(duplicateDraftPrompt(read.record), /新建一条草稿/)
  assert.equal(duplicateDraftPrompt(undefined), undefined)
  const missing = readDraftRecord(workDir())
  assert.equal(missing.record, undefined)
})

test('P5 version 自检：未装直接失败，装上输出版本', async () => {
  const notInstalled = await versionCheck({ invocation: resolveInvocation(undefined) })
  assert.equal(notInstalled.ok, false)
  assert.equal(notInstalled.code, 'CLI_NOT_INSTALLED')
  const ok = await versionCheck({
    invocation: INVOCATION,
    runner: async ({ args }) => {
      assert.equal(args[1], '--version')
      return { code: 0, stdout: '2.0.12\n', stderrTail: '' }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.version, '2.0.12')
})
