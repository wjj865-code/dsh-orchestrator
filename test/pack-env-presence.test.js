import test from 'node:test'
import assert from 'node:assert/strict'
import { envPresence, envSummary, persistedEnvPresence } from '../src/pack/env.js'
import { checkPackHealth } from '../src/pack/health.js'

// 环境变量存在性：进程环境优先；宿主要素没加载时再看用户级持久变量（Windows）。
// 两个入口都只回答布尔，不返回/记录值。

test('envPresence：进程环境有非空值即已设置，空值不算', () => {
  assert.equal(envPresence('DEMO_TOKEN', { DEMO_TOKEN: 'secret-value' }).set, true)
  assert.equal(envPresence('DEMO_TOKEN', { DEMO_TOKEN: '' }).set, false)
  assert.equal(envPresence('DEMO_TOKEN', {}).set, false)
  assert.equal(envPresence('bad-ref', { 'bad-ref': 'x' }).valid, false)
})

test('envPresence：进程环境缺失时回退到用户级持久变量，且不回传值', () => {
  const stored = envPresence('DEMO_TOKEN', {}, { persistedEnv: ref => ref === 'DEMO_TOKEN' })
  assert.equal(stored.set, true)
  assert.deepEqual(Object.keys(stored).sort(), ['ref', 'set', 'valid'])
  assert.equal(envPresence('DEMO_TOKEN', {}, { persistedEnv: () => false }).set, false)
})

test('envSummary：用户级持久变量也算已设置，值不进入投影', () => {
  const manifest = {
    env: [{ ref: 'DEMO_TOKEN', kind: 'secret', required: true, purpose: '演示' }],
  }
  const [item] = envSummary(manifest, {}, { persistedEnv: ref => ref === 'DEMO_TOKEN' })
  assert.equal(item.set, true)
  assert.equal(JSON.stringify(item).includes('secret-value'), false)
})

test('persistedEnvPresence：只看 reg query 退出码，只查用户级 Environment', () => {
  const calls = []
  const ok = persistedEnvPresence('DEMO_TOKEN', {
    platform: 'win32',
    execFile: (command, args, options) => {
      calls.push({ command, args, options })
    },
  })
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'reg')
  assert.deepEqual(calls[0].args, ['query', 'HKCU\\Environment', '/v', 'DEMO_TOKEN'])
  assert.equal(calls[0].options.stdio, 'ignore')

  const missing = persistedEnvPresence('DEMO_TOKEN', {
    platform: 'win32',
    execFile: () => { throw new Error('not found') },
  })
  assert.equal(missing, false)
  assert.equal(persistedEnvPresence('DEMO_TOKEN', { platform: 'darwin', execFile: () => {} }), false)
  assert.equal(persistedEnvPresence('bad-ref', { platform: 'win32', execFile: () => { throw new Error('invalid') } }), false)
})

test('checkPackHealth：用户级持久变量已配置时 env 检查通过，不再误报待处理', () => {
  const manifest = {
    env: [{ ref: 'DEMO_TOKEN', kind: 'secret', required: true, purpose: '演示' }],
    cli: [],
    health: [{ id: 'env', kind: 'env', soft: true, spec: { refs: ['DEMO_TOKEN'] } }],
  }
  const health = checkPackHealth({
    manifest,
    packRoot: '.',
    id: 'demo',
    env: {},
    persistedEnv: ref => ref === 'DEMO_TOKEN',
  })
  assert.deepEqual(health.checks.map(check => [check.id, check.ok]), [['env', true]])
})
