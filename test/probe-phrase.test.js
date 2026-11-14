// 契约探针的双版本短语判定：rc.1 / rc.3 两种写法都必须被接受，错写法与 absent 语义不能被改坏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesPhrase } from '../docs/probes/lib/phrase-match.mjs'

// 取自 rc.1 与 rc.3 的真实源码原文（见 docs/probes/main-session-probe.md 的摘录）。
const RC1 = 'composition: { agentPreset: request.agentPreset }'
const RC3 = 'composition: { agentPreset: spec.agentPreset }'

test('双版本短语：数组里任一写法命中即算命中', () => {
  assert.equal(matchesPhrase(`... ${RC1} ...`, [RC3, RC1]).hit, true)
  assert.equal(matchesPhrase(`... ${RC3} ...`, [RC3, RC1]).hit, true)
  assert.equal(matchesPhrase(`... ${RC1} ...`, [RC3, RC1]).at, 4)
})

test('双版本短语：两版都不在时判未命中（不能被数组绕过）', () => {
  assert.equal(matchesPhrase('composition: { agentPreset: other.agentPreset }', [RC3, RC1]).hit, false)
})

test('单字符串语义不变', () => {
  assert.equal(matchesPhrase(RC3, RC3).hit, true)
  assert.equal(matchesPhrase(RC1, RC3).hit, false)
})

test('双版本短语：带名字的写法回报命中的是哪一版', () => {
  const variants = [
    { name: 'rc.3', phrase: RC3 },
    { name: 'rc.1', phrase: RC1 },
  ]
  assert.equal(matchesPhrase(`... ${RC1} ...`, variants).matched, 'rc.1')
  assert.equal(matchesPhrase(`... ${RC3} ...`, variants).matched, 'rc.3')
  assert.equal(matchesPhrase('neither', variants).matched, undefined)
})

test('absent：任一写法出现即算失败', () => {
  assert.equal(matchesPhrase(RC1, [RC3, RC1], { absent: true }).hit, false)
  assert.equal(matchesPhrase(RC3, [RC3, RC1], { absent: true }).hit, false)
  assert.equal(matchesPhrase('nothing here', [RC3, RC1], { absent: true }).hit, true)
})
