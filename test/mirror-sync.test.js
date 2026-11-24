import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENDPOINT,
  UPSTREAM,
  cacheBust,
  describeUnknown,
  main,
  parseArgs,
  probeVersion,
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

function statusResponse(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => ({}),
  }
}

// 镜像与上游各按顺序回状态码（用完之后一直重复最后一个），PUT 恒成功。
function routedFetch(mirrorSequence, { upstreamSequence = [200], calls = [] } = {}) {
  let mirrorHits = 0
  let upstreamHits = 0
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method })
    if (init?.method === 'PUT') return statusResponse(200, '{}')
    if (url.startsWith(UPSTREAM)) {
      const status = upstreamSequence[Math.min(upstreamHits, upstreamSequence.length - 1)]
      upstreamHits += 1
      return statusResponse(status)
    }
    const status = mirrorSequence[Math.min(mirrorHits, mirrorSequence.length - 1)]
    mirrorHits += 1
    return statusResponse(status)
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

test('parseArgs：默认触发并等待 180s、间隔 10s、重触发 60s', () => {
  const args = parseArgs([])
  assert.equal(args.check, false)
  assert.equal(args.wait, true)
  assert.equal(args.timeout, 180)
  assert.equal(args.interval, 10)
  assert.equal(args.retrigger, 60)
  assert.equal(args.version, undefined)
  assert.equal(args.packageName, undefined)
})

test('parseArgs：--check / --no-wait / --timeout / --interval / --retrigger / --version / --package', () => {
  const args = parseArgs(['--check', '--timeout', '600', '--interval', '5', '--retrigger', '30', '--version', '1.2.3', '--package', 'x'])
  assert.equal(args.check, true)
  assert.equal(args.wait, true)
  assert.equal(args.timeout, 600)
  assert.equal(args.interval, 5)
  assert.equal(args.retrigger, 30)
  assert.equal(args.version, '1.2.3')
  assert.equal(args.packageName, 'x')
  assert.equal(parseArgs(['--no-wait']).wait, false)
  assert.equal(parseArgs(['--help']).help, true)
})

test('parseArgs：非数字/非正数超时与未知参数给可读错误', () => {
  assert.throws(() => parseArgs(['--timeout', 'abc']), /--timeout/)
  assert.throws(() => parseArgs(['--timeout', '0']), /--timeout/)
  assert.throws(() => parseArgs(['--interval', '-1']), /--interval/)
  assert.throws(() => parseArgs(['--retrigger', '0']), /--retrigger/)
  assert.throws(() => parseArgs(['--wat']), /未知参数：--wat/)
})

test('等待循环：503 → 503 → 200 继续等并最终 exit 0，unknown 只记日志', async () => {
  const clock = fakeClock()
  // 首次探测 404（镜像缺）→ 上游版本端点已有 → PUT 触发 → 循环里 503、503、200
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

test('上游 npm 版本端点未就绪时先等，不提前 PUT', async () => {
  const clock = fakeClock()
  const { impl, calls } = routedFetch([404, 200], { upstreamSequence: [404, 200] })
  const { result, logs } = await captureConsole(() =>
    main(['--package', NAME, '--version', '0.34.0', '--timeout', '30', '--interval', '10'], {
      fetchImpl: impl,
      sleepImpl: clock.sleep,
      now: clock.now,
    }),
  )
  assert.equal(result, 0)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1)
  assert.match(logs.join('\n'), /上游 npm 还没出现（第 1 次探测：版本端点回 404），继续等/)
  assert.match(logs.join('\n'), /上游 npm 已有 0\.34\.0（第 2 次探测）/)
  const firstPut = calls.findIndex((call) => call.method === 'PUT')
  const firstUpstreamReady = calls.findIndex((call, index) => index > 0 && call.url.startsWith(UPSTREAM) && index < firstPut)
  assert.ok(firstUpstreamReady > 0, 'PUT 之前必须已经打到了上游版本端点')
})

test('同步任务空跑（镜像仍 404）时按间隔重新触发，直到版本出现', async () => {
  const clock = fakeClock()
  const { impl, calls } = routedFetch([404, 404, 404, 200])
  const { result, logs } = await captureConsole(() =>
    main(['--package', NAME, '--version', '0.34.0', '--timeout', '50', '--interval', '10', '--retrigger', '20'], {
      fetchImpl: impl,
      sleepImpl: clock.sleep,
      now: clock.now,
    }),
  )
  assert.equal(result, 0)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 2, '首次 PUT 后空跑，应再触发一次')
  assert.match(logs.join('\n'), /仍未出现，已重新触发同步（第 2 次）/)
})

test('上游 npm 等到超时仍没有版本：exit 1 且不 PUT', async () => {
  const clock = fakeClock()
  const { impl, calls } = routedFetch([404], { upstreamSequence: [503] })
  const { result, errors } = await captureConsole(() =>
    main(['--package', NAME, '--version', '0.34.0', '--timeout', '20', '--interval', '10'], {
      fetchImpl: impl,
      sleepImpl: clock.sleep,
      now: clock.now,
    }),
  )
  assert.equal(result, 1)
  assert.match(errors.join('\n'), /等满 20s 上游 npm 仍没有 0\.34\.0/)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0)
})

test('--no-wait 上游已就绪：只 PUT 一次并立即返回，不轮询镜像', async () => {
  const clock = fakeClock()
  const { impl, calls } = routedFetch([404], { upstreamSequence: [200] })
  const { result } = await captureConsole(() =>
    main(['--no-wait', '--package', NAME, '--version', '0.34.0'], {
      fetchImpl: impl,
      sleepImpl: async () => {
        throw new Error('--no-wait 不应该等待')
      },
      now: clock.now,
    }),
  )
  assert.equal(result, 0)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1)
})

test('--no-wait 上游未就绪：exit 1、不 PUT、不等待', async () => {
  const clock = fakeClock()
  const { impl, calls } = routedFetch([404], { upstreamSequence: [404] })
  const { result, errors } = await captureConsole(() =>
    main(['--no-wait', '--package', NAME, '--version', '0.34.0'], {
      fetchImpl: impl,
      sleepImpl: async () => {
        throw new Error('--no-wait 不应该等待')
      },
      now: clock.now,
    }),
  )
  assert.equal(result, 1)
  assert.match(errors.join('\n'), /上游 npm 还没有 0\.34\.0（版本端点回 404）：--no-wait 不等待/)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0)
})

test('--check 在镜像缺、上游已有时只报告不触发', async () => {
  const { impl, calls } = routedFetch([404], { upstreamSequence: [200] })
  const { result, errors } = await captureConsole(() =>
    main(['--check', '--package', NAME, '--version', '0.34.0'], {
      fetchImpl: impl,
      sleepImpl: async () => {
        throw new Error('--check 不应该等待')
      },
    }),
  )
  assert.equal(result, 1)
  assert.match(errors.join('\n'), /--check 只查询不触发/)
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0)
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
