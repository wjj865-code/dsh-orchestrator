// src/main-nav.js 的单测（t-a79e12d8：压力提醒「新建协调者会话」之后的跳转待办）。
//
// 守三件事：
//   1. 代建结果 → 待办（成功=跳转、失败=可读提示，旧主会话保持不动）；
//   2. 待办只存一条、短命（TTL），ack 要 id 匹配（多客户端时不重复导航）；
//   3. 成败都留审计（main.nav.pending / consumed / navigate-failed / expired），排查「为什么没跳」只看这几条。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_NAV_TTL_MS, createMainNav, planCoordinatorNav,
} from '../src/main-nav.js'

const recorder = () => {
  const events = []
  return { events, log: (event, fields) => events.push({ event, detail: fields?.detail }) }
}

test('planCoordinatorNav：成功 → 跳转待办；create 失败 / 指针失败 / 忙 → 各自的提示', () => {
  assert.deepEqual(planCoordinatorNav({ ok: true, sessionId: 's-new', created: true }), {
    kind: 'navigate', sessionId: 's-new',
  })
  const evicted = planCoordinatorNav({ ok: true, sessionId: 's-new', created: true, evicted: 's-old' })
  assert.equal(evicted.kind, 'navigate')
  assert.equal(evicted.sessionId, 's-new')
  assert.match(evicted.text, /名单已满/)
  assert.match(evicted.text, /会话保留/)
  const pointer = planCoordinatorNav({ ok: false, code: 'ADOPT_FAILED', params: { reason: '磁盘只读', sessionId: 's-new' } })
  assert.equal(pointer.kind, 'notice')
  assert.equal(pointer.code, 'ADOPT_FAILED')
  assert.match(pointer.text, /指针没切成功/)
  assert.match(pointer.text, /磁盘只读/)
  assert.match(pointer.text, /旧主会话保持不动/)
  const create = planCoordinatorNav({ ok: false, code: 'ADOPT_CREATE_FAILED', params: { reason: '缺少 sessionController 服务' } })
  assert.equal(create.kind, 'notice')
  assert.match(create.text, /新建协调者会话失败/)
  assert.match(create.text, /缺少 sessionController 服务/)
  assert.match(planCoordinatorNav({ ok: false, code: 'ADOPT_BUSY' }).text, /另一次协调者切换正在进行/)
  // 没 code 也没成功：不给用户编理由（也不假装成功）。
  assert.equal(planCoordinatorNav({ ok: false }), null)
  assert.equal(planCoordinatorNav(undefined), null)
  // 成功但没 sessionId：同样不产出待办（不会跳到一个空 id）。
  assert.equal(planCoordinatorNav({ ok: true }), null)
})

test('createMainNav：只存一条待办；ack 要 id 匹配；成败都留审计', () => {
  let now = 1000
  const { events, log } = recorder()
  let seq = 0
  const nav = createMainNav({ now: () => now, idOf: () => `nav-${++seq}`, log })

  assert.equal(nav.read(), null, '没有待办时读 null')
  const first = nav.publish({ kind: 'navigate', sessionId: 's-new' })
  assert.deepEqual({ id: first.id, kind: first.kind, sessionId: first.sessionId, at: first.at },
    { id: 'nav-1', kind: 'navigate', sessionId: 's-new', at: 1000 })
  assert.equal(nav.read().id, 'nav-1')
  assert.equal(events.filter(item => item.event === 'main.nav.pending').length, 1, '写入要留审计')

  // 别的客户端拿着旧 id 来 ack：不清（先到先得）。
  assert.deepEqual(nav.ack({ id: 'nav-999', ok: true }), { cleared: false })
  assert.equal(nav.read().id, 'nav-1')

  // 后一条待办覆盖前一条（新事实优先）。
  const second = nav.publish({ kind: 'notice', tone: 'error', text: '新建失败', code: 'ADOPT_CREATE_FAILED' })
  assert.equal(second.id, 'nav-2')
  assert.equal(nav.read().kind, 'notice')

  assert.deepEqual(nav.ack({ id: 'nav-2', ok: true }), { cleared: true, kind: 'notice', sessionId: null })
  assert.equal(nav.read(), null, 'ack 后就没有待办了')
  const consumed = events.find(item => item.event === 'main.nav.consumed')
  assert.ok(consumed !== undefined)
  assert.equal(consumed.detail.code, undefined, 'pending 审计带 code（可选），consumed 只带 kind/sessionId')
})

test('createMainNav：跳转失败 ack 记 navigate-failed（带原因）；非法待办不写', () => {
  const { events, log } = recorder()
  const nav = createMainNav({ now: () => 5, idOf: () => 'nav-x', log })
  assert.equal(nav.publish({ kind: 'navigate' }), null, 'navigate 没有 sessionId 不写')
  assert.equal(nav.publish({ kind: 'jump' }), null, '未知 kind 不写')
  assert.equal(nav.read(), null)
  nav.publish({ kind: 'navigate', sessionId: 's-new' })
  assert.deepEqual(nav.ack({ id: 'nav-x', ok: false, error: 'sessions.retain: unknown session s-new' }),
    { cleared: true, kind: 'navigate', sessionId: 's-new' })
  const failed = events.find(item => item.event === 'main.nav.navigate-failed')
  assert.ok(failed !== undefined)
  assert.match(failed.detail.error, /unknown session/)
  assert.equal(nav.read(), null, '失败也消费掉这条待办（不无限重试）')
})

test('createMainNav：待办会过期（客户端不在线时别在很久以后把人拽走）', () => {
  let now = 10_000
  const { events, log } = recorder()
  const nav = createMainNav({ now: () => now, ttlMs: 1000, idOf: () => 'nav-t', log })
  nav.publish({ kind: 'navigate', sessionId: 's-new' })
  now += 1001
  assert.equal(nav.read(), null)
  assert.ok(events.some(item => item.event === 'main.nav.expired'))
  assert.equal(MAIN_NAV_TTL_MS, 5 * 60_000, '默认 5 分钟（文档口径）')
  // 过期后再 ack：已经没了，不清。
  assert.deepEqual(nav.ack({ id: 'nav-t', ok: true }), { cleared: false })
})
