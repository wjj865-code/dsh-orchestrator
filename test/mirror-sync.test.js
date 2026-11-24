import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENDPOINT,
  UPSTREAM,
  cacheBust,
  describeUnknown,
  fetchPackument,
  isSynced,
  main,
  packumentUrl,
  parseArgs,
  probeVersion,
  readMirrorState,
  syncUrl,
  versionUrl,
} from '../scripts/mirror-sync.mjs'

const NAME = '@wjj865-code/dsh-orchestrator'

// 假 fetch：记录调用，按 handler 回响应（不碰网络）。
function stubFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { impl, calls }
}

// 拦 console.log / console.error，把 main() 的输出拿来断言（跑完立刻还原）。
async function captureConsole(run) {
  const logs = []
  const errors = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const result = await run()
    return { result, logs, errors }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

// 假时钟 + 假 sleep：sleep 只推进时钟，测试里不真的等。
function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
  }
}

// 镜像侧按顺序回状态码（用完之后一直重复最后一个），上游 packument 恒有 version，PUT 恒成功。
function routedFetch(sequence, { calls = [] } = {}) {
  let mirrorHits = 0
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method })
    if (init?.method === 'PUT') return { ok: true, status: 200, text: async () => '{}' }
    if (url.startsWith(UPSTREAM)) {
      return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '0.34.0' }, versions: { '0.34.0': {} } }) }
    }
    const status = sequence[Math.min(mirrorHits, sequence.length - 1)]
    mirrorHits += 1
    return { ok: status === 200, status }
  }
  return { impl, calls }
}

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

test('versionUrl：版本专用端点（scoped 包的 / 编码），版本号单独编码', () => {
  assert.equal(versionUrl(NAME, '0.34.0'), `${ENDPOINT}/@wjj865-code%2Fdsh-orchestrator/0.34.0`)
  assert.equal(versionUrl(NAME, '0.34.0', UPSTREAM), `${UPSTREAM}/@wjj865-code%2Fdsh-orchestrator/0.34.0`)
  assert.equal(versionUrl('plain-pkg', '1.2.3'), `${ENDPOINT}/plain-pkg/1.2.3`)
  // 版本号里的 + 要编码，否则会被当成 URL 里的空格
  assert.equal(versionUrl(NAME, '1.0.0-rc.1+build.2'), `${ENDPOINT}/@wjj865-code%2Fdsh-orchestrator/1.0.0-rc.1%2Bbuild.2`)
})

test('cacheBust：追加 ?t= 时间戳；已有查询串用 & 拼接', () => {
  assert.equal(cacheBust(`${ENDPOINT}/plain-pkg`, 1700000000000), `${ENDPOINT}/plain-pkg?t=1700000000000`)
  assert.equal(cacheBust(`${ENDPOINT}/plain-pkg?x=1`, 42), `${ENDPOINT}/plain-pkg?x=1&t=42`)
})

test('probeVersion：200 → ready，URL 带 ?t= 缓存穿透 + no-cache 头', async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, ok: true }))
  const result = await probeVersion(NAME, '0.34.0', { now: 1700000000000, fetchImpl: impl })
  assert.equal(result.state, 'ready')
  assert.equal(result.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${ENDPOINT}/@wjj865-code%2Fdsh-orchestrator/0.34.0?t=1700000000000`)
  assert.equal(calls[0].init.headers['cache-control'], 'no-cache')
  assert.equal(calls[0].init.headers.pragma, 'no-cache')
})

test('probeVersion：404 → absent；503/429/网络错 → unknown（不冒充「有」也不冒充「缺」）', async () => {
  const missing = await probeVersion(NAME, '9.9.9', { fetchImpl: async () => ({ status: 404, ok: false }) })
  assert.equal(missing.state, 'absent')
  assert.equal(missing.status, 404)

  const unavailable = await probeVersion(NAME, '0.34.0', { fetchImpl: async () => ({ status: 503, ok: false }) })
  assert.equal(unavailable.state, 'unknown')
  assert.equal(unavailable.status, 503)
  assert.match(unavailable.reason, /HTTP 503/)
  assert.match(unavailable.hint, /\?t=\d+/)
  assert.equal(describeUnknown(unavailable), 'HTTP 503')

  const throttled = await probeVersion(NAME, '0.34.0', { fetchImpl: async () => ({ status: 429, ok: false }) })
  assert.equal(throttled.state, 'unknown')
  assert.equal(throttled.status, 429)
  assert.equal(describeUnknown(throttled), 'HTTP 429')

  const offline = await probeVersion(NAME, '0.34.0', {
    fetchImpl: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(offline.state, 'unknown')
  assert.equal(offline.status, undefined)
  assert.match(offline.reason, /请求失败：boom/)
  assert.equal(describeUnknown(offline), '请求失败：boom')
})

test('fetchPackument：packument 也带 ?t= 与 no-cache（不吃 CDN 缓存），404 当空', async () => {
  const { impl, calls } = stubFetch(() => ({
    status: 200,
    ok: true,
    json: async () => ({ 'dist-tags': { latest: '0.34.0' }, versions: { '0.34.0': {} } }),
  }))
  const result = await fetchPackument(NAME, ENDPOINT, { now: 123, fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.deepEqual(result.state, { latest: '0.34.0', versions: ['0.34.0'] })
  assert.equal(calls[0].url, `${ENDPOINT}/@wjj865-code%2Fdsh-orchestrator?t=123`)
  assert.equal(calls[0].init.headers['cache-control'], 'no-cache')
  assert.equal(calls[0].init.headers.accept, 'application/vnd.npm.install-v1+json')

  const missing = await fetchPackument(NAME, ENDPOINT, { fetchImpl: async () => ({ status: 404, ok: false }) })
  assert.equal(missing.ok, true)
  assert.deepEqual(missing.state, { latest: undefined, versions: [] })
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

test('等待循环：503 → 503 → 200 继续等并最终 exit 0，unknown 只记日志', async () => {
  const clock = fakeClock()
  // 首次探测 404（镜像缺）→ 上游已有 → PUT 触发 → 循环里 503、503、200
  const { impl, calls } = routedFetch([404, 503, 503, 200])
  const { result, logs } = await captureConsole(() =>
    main(['--package', NAME, '--version', '0.34.0', '--timeout', '30', '--interval', '10'], {
      fetchImpl: impl,
      sleepImpl: clock.sleep,
      now: clock.now,
    }),
  )
  assert.equal(result, 0, '第 3 次轮询拿到 200 就该 exit 0')
  const text = logs.join('\n')
  assert.match(text, /第 1 次轮询：HTTP 503（暂时不可用，继续等）/)
  assert.match(text, /第 2 次轮询：HTTP 503（暂时不可用，继续等）/)
  assert.match(text, /镜像已就绪（第 3 次轮询/)
  assert.equal(text.match(/暂时不可用，继续等/g).length, 2)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1)
})

test('--check 遇 503：报「镜像状态未知」exit 1，不冒充缺版本也不触发同步', async () => {
  const { impl, calls } = routedFetch([503])
  const { result, errors } = await captureConsole(() =>
    main(['--check', '--package', NAME, '--version', '0.34.0'], {
      fetchImpl: impl,
      sleepImpl: async () => {
        throw new Error('--check 不应该等待')
      },
    }),
  )
  assert.equal(result, 1)
  const text = errors.join('\n')
  assert.match(text, /镜像状态未知（HTTP 503）：稍后用 --check 复查/)
  assert.doesNotMatch(text, /镜像缺|镜像已有/)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0, '--check 不触发同步')
  assert.equal(calls.length, 1, '状态未知时不该再去读上游 packument')
})

test('同步模式首次探测遇 503：不触发 PUT，如实报状态未知并 exit 1', async () => {
  const { impl, calls } = routedFetch([503])
  const { result, errors } = await captureConsole(() =>
    main(['--package', NAME, '--version', '0.34.0'], { fetchImpl: impl, sleepImpl: async () => {} }),
  )
  assert.equal(result, 1)
  assert.match(errors.join('\n'), /镜像状态未知（HTTP 503）：现在判断不了要不要同步/)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0)
})
