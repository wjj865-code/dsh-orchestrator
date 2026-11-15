import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENDPOINT,
  UPSTREAM,
  isSynced,
  packumentUrl,
  parseArgs,
  readMirrorState,
  syncUrl,
} from '../scripts/mirror-sync.mjs'

const NAME = '@wjj865-code/dsh-orchestrator'

test('syncUrl：scoped 包名要 URL 编码，路径落在 /-/package/:name/syncs', () => {
  assert.equal(syncUrl(NAME), `${ENDPOINT}/-/package/%40wjj865-code%2Fdsh-orchestrator/syncs`)
  assert.equal(syncUrl('plain-pkg'), `${ENDPOINT}/-/package/plain-pkg/syncs`)
  // 只编码一次：% 不能再被编码成 %25
  assert.ok(!syncUrl(NAME).includes('%2540'))
  assert.equal(syncUrl(NAME, 'https://example.test'), 'https://example.test/-/package/%40wjj865-code%2Fdsh-orchestrator/syncs')
})

test('packumentUrl：scoped 包的 / 编码成 %2F（@ 保持原样，与 npm CLI 一致），域名带协议', () => {
  assert.equal(packumentUrl(NAME), `${ENDPOINT}/@wjj865-code%2Fdsh-orchestrator`)
  assert.equal(packumentUrl(NAME, UPSTREAM), `${UPSTREAM}/@wjj865-code%2Fdsh-orchestrator`)
  assert.equal(packumentUrl('plain-pkg'), `${ENDPOINT}/plain-pkg`)
  assert.ok(!packumentUrl(NAME).includes('@wjj865-code/dsh-orchestrator'))
})

test('readMirrorState：摘 latest 与版本列表，缺字段一律当空', () => {
  const state = readMirrorState({
    'dist-tags': { latest: '0.11.0', next: '0.12.0-beta.1' },
    versions: { '0.10.0': {}, '0.11.0': {} },
  })
  assert.deepEqual(state, { latest: '0.11.0', versions: ['0.10.0', '0.11.0'] })
  assert.deepEqual(readMirrorState({}), { latest: undefined, versions: [] })
  assert.deepEqual(readMirrorState(undefined), { latest: undefined, versions: [] })
  assert.deepEqual(readMirrorState({ 'dist-tags': { latest: 42 }, versions: null }), { latest: undefined, versions: [] })
})

test('isSynced：latest 命中或版本列表命中都算已同步', () => {
  const state = readMirrorState({ 'dist-tags': { latest: '0.10.0' }, versions: { '0.10.0': {}, '0.11.0': {} } })
  assert.equal(isSynced(state, '0.10.0'), true)
  assert.equal(isSynced(state, '0.11.0'), true, '没推到 latest 但版本已在列表里也算同步完成')
  assert.equal(isSynced(state, '0.12.0'), false)
  assert.equal(isSynced(readMirrorState({}), '0.11.0'), false)
})

test('parseArgs：默认触发并等待 180s、间隔 10s', () => {
  const args = parseArgs([])
  assert.equal(args.check, false)
  assert.equal(args.wait, true)
  assert.equal(args.timeout, 180)
  assert.equal(args.interval, 10)
  assert.equal(args.version, undefined)
  assert.equal(args.packageName, undefined)
})

test('parseArgs：--check / --no-wait / --timeout / --interval / --version / --package', () => {
  const args = parseArgs(['--check', '--timeout', '600', '--interval', '5', '--version', '1.2.3', '--package', 'x'])
  assert.equal(args.check, true)
  assert.equal(args.wait, true)
  assert.equal(args.timeout, 600)
  assert.equal(args.interval, 5)
  assert.equal(args.version, '1.2.3')
  assert.equal(args.packageName, 'x')
  assert.equal(parseArgs(['--no-wait']).wait, false)
  assert.equal(parseArgs(['--help']).help, true)
})

test('parseArgs：非数字/非正数超时与未知参数给可读错误', () => {
  assert.throws(() => parseArgs(['--timeout', 'abc']), /--timeout/)
  assert.throws(() => parseArgs(['--timeout', '0']), /--timeout/)
  assert.throws(() => parseArgs(['--interval', '-1']), /--interval/)
  assert.throws(() => parseArgs(['--wat']), /未知参数：--wat/)
})
