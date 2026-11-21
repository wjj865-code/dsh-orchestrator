import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostRoute } from '../src/host-route.js'

// P4 路由：能力包端点只做参数窄化 + 幂等 + 状态码；值绝不出现在响应/日志。
// 这里用假 packs，验证「路由没有偷偷多做一层业务」——confirm/planHash 必须原样交回 service。

const makeRoute = ({ packs } = {}) => {
  const calls = []
  const fakePacks = packs ?? {
    snapshot: () => ({ ok: true, usable: true, packs: [{ id: 'demo-pack' }] }),
    describe: id => ({ ok: true, pack: { id } }),
    open: async (id, cwd) => { calls.push(['open', id, cwd]); return { ok: true, sessionId: 's-1' } },
    install: async (id, cliId, options) => { calls.push(['install', id, cliId, options]); return { ok: true, installed: true } },
    uninstall: async (id, cliId) => { calls.push(['uninstall', id, cliId]); return { ok: true } },
    remove: async (id, options) => { calls.push(['remove', id, options]); return { ok: true } },
    envCopy: async (id, ref) => { calls.push(['envCopy', id, ref]); return { ok: true, command: `setx ${ref} "<你的值>"` } },
    envSet: async (id, ref, value, options) => {
      calls.push(['envSet', id, ref, value.length, options])
      return { ok: true, restartRequired: true }
    },
  }
  const fetch = createHostRoute({
    db: {},
    coordinatorStatus: () => ({ id: 's-main', live: true }),
    packs: packs === null ? undefined : fakePacks,
  })
  const post = async payload => {
    const response = await fetch(new Request('http://localhost/api/orchestrator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { post, calls }
}

test('P4 路由：pack-snapshot 只读投影；pack-describe 按 id', async () => {
  const { post } = makeRoute()
  const snapshot = await post({ endpoint: 'pack-snapshot' })
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.body.packs[0].id, 'demo-pack')
  const describe = await post({ endpoint: 'pack-describe', id: 'demo-pack' })
  assert.equal(describe.status, 200)
  assert.equal(describe.body.pack.id, 'demo-pack')
})

test('P4 路由：pack-open / pack-install 把 confirm 与 planHash 原样交给 service', async () => {
  const { post, calls } = makeRoute()
  const opened = await post({ endpoint: 'pack-open', id: 'demo-pack', cwd: 'D:/work' })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.sessionId, 's-1')
  const installed = await post({ endpoint: 'pack-install', id: 'demo-pack', cliId: 'wenyan', confirm: true, planHash: 'abc' })
  assert.equal(installed.status, 200)
  assert.deepEqual(calls[1], ['install', 'demo-pack', 'wenyan', { confirm: true, planHash: 'abc' }])
  // 未确认也照转（service 会拒绝并回确认卡），路由不替 service 做判断。
  const denied = await post({ endpoint: 'pack-install', id: 'demo-pack', cliId: 'wenyan' })
  assert.equal(denied.status, 200)
  assert.equal(calls[2][3].confirm, false)
})

test('P4 路由：pack-env-set 响应/错误都不含值；重复 clientRequestId 只执行一次', async () => {
  const { post, calls } = makeRoute()
  const secret = 'sk-live-very-secret'
  const first = await post({ endpoint: 'pack-env-set', id: 'demo-pack', ref: 'DEMO_SECRET', value: secret, confirm: true, clientRequestId: 'r-1' })
  assert.equal(first.status, 200)
  assert.equal(JSON.stringify(first.body).includes(secret), false, '响应绝不能回显值')
  assert.equal(calls.filter(call => call[0] === 'envSet').length, 1)
  const replay = await post({ endpoint: 'pack-env-set', id: 'demo-pack', ref: 'DEMO_SECRET', value: secret, confirm: true, clientRequestId: 'r-1' })
  assert.equal(replay.status, 200)
  assert.equal(calls.filter(call => call[0] === 'envSet').length, 1, '同 clientRequestId 不重复执行')
  assert.equal(JSON.stringify(replay.body).includes(secret), false)
})

test('P4 路由：pack-delete / pack-uninstall / pack-env-copy 的参数窄化', async () => {
  const { post, calls } = makeRoute()
  await post({ endpoint: 'pack-delete', id: 'demo-pack', confirm: true, clientRequestId: 'd-1' })
  await post({ endpoint: 'pack-uninstall', id: 'demo-pack', cliId: 'wenyan' })
  const copy = await post({ endpoint: 'pack-env-copy', id: 'demo-pack', ref: 'DEMO_SECRET' })
  assert.deepEqual(calls[0], ['remove', 'demo-pack', { confirm: true }])
  assert.deepEqual(calls[1], ['uninstall', 'demo-pack', 'wenyan'])
  assert.deepEqual(calls[2], ['envCopy', 'demo-pack', 'DEMO_SECRET'])
  assert.match(copy.body.command, /<你的值>/)
})

test('P4 路由：pack service 未装配 → 500 + 可读 code（不是 404 静默）', async () => {
  const { post } = makeRoute({ packs: null })
  const result = await post({ endpoint: 'pack-snapshot' })
  assert.equal(result.status, 500)
  assert.equal(result.body.code, 'CAPABILITY_PACKS_UNAVAILABLE')
})

test('P4 路由：服务失败按 code 映射状态码（确认缺失 409 / 未找到 404）', async () => {
  const packs = {
    snapshot: () => ({ ok: false, code: 'PLATFORM_UNSUPPORTED', error: 'Web' }),
    describe: () => ({ ok: false, code: 'PACK_NOT_FOUND', error: '没有' }),
    open: async () => ({ ok: false, code: 'CONFIRM_REQUIRED', error: '确认' }),
  }
  const { post } = makeRoute({ packs })
  assert.equal((await post({ endpoint: 'pack-snapshot' })).status, 400)
  assert.equal((await post({ endpoint: 'pack-describe', id: 'x' })).status, 404)
  const confirm = await post({ endpoint: 'pack-open', id: 'x' })
  assert.equal(confirm.status, 409)
  assert.equal(confirm.body.code, 'CONFIRM_REQUIRED')
})
