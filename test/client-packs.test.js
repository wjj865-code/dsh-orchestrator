import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { CLIENT_SIZE_LIMIT } from '../scripts/check-client-size.mjs'

// P4 客户端：能力包面板的契约用「源码 + 产物标记」守住。React 组件本身不在这里跑
// （源码是 JSX，Node 不能直接 import）；真正渲染由产物 build + 浏览器冒烟覆盖。
// 守的是「改名/改端点只改一半」与「值泄漏」两类真会坏的改动：
//   - 面板必须用 api.js 的 pack-* 端点，不能自己拼 fetch；
//   - 安装确认必须带 planHash、环境变量输入必须是 password 且不回显；
//   - 侧栏 id / main key 与常量同源。

const root = new URL('../', import.meta.url)
const source = name => readFileSync(new URL(`client/src/${name}`, root), 'utf8')

test('P4 面板源码：端点走 api.js，安装带 planHash，环境变量是 password 且不清空前不回显', () => {
  const panel = source('capability-packs.js')
  for (const name of ['readPackSnapshot', 'openPackSession', 'installPackCli', 'uninstallPackCli', 'deletePack', 'copyPackEnvCommand', 'setPackEnv']) {
    assert.ok(panel.includes(name), `面板缺少 ${name}（端点必须走 client/src/api.js）`)
  }
  assert.match(panel, /installPackCli\(pack\.id, cli\.id, plan\.planHash\)/, '安装确认必须带 planHash（计划变了要拒绝）')
  assert.match(panel, /type="password"/, '环境变量输入必须是密码框（不显示值）')
  assert.match(panel, /永不显示值/)
  assert.match(panel, /value=\{value\}/, '输入值只出现在受控 input 上')
  assert.doesNotMatch(panel, /value\.length|\.slice\(0, *\d+\)/, '面板显示值长度也算泄漏面（不显示）')
  assert.match(panel, /确认删除|取消（推荐先取消）/, '删除/安装都要二次确认')
  assert.doesNotMatch(panel, /fetch\(/, '面板不直接 fetch：统一走 api.js（便于断言与错误映射）')
})

test('P4 端点与常量：pack-* 端点写全，面板 key/轮询间隔与 client.js 同源', () => {
  const api = source('api.js')
  for (const endpoint of ['pack-snapshot', 'pack-describe', 'pack-open', 'pack-install', 'pack-uninstall', 'pack-delete', 'pack-env-copy', 'pack-env-set']) {
    assert.ok(api.includes(`'${endpoint}'`), `api.js 缺少端点 ${endpoint}`)
  }
  const constants = source('constants.js')
  assert.match(constants, /CAPABILITY_PACKS_PANEL_ID = 'capability-packs'/)
  assert.match(constants, /PACK_POLL_MS = 15000/)
  const client = source('client.js')
  assert.match(client, /name: 'main', key: CAPABILITY_PACKS_PANEL_ID/)
  assert.match(client, /id: CAPABILITY_PACKS_PANEL_ID, order: 15, label: \(\) => '能力包'/)
  assert.match(client, /createCapabilityPacksPanel/)
})

test('P4 产物：能力包面板真的打进 dist/client.js（不是只写源码）', () => {
  const artifact = readFileSync(new URL('dist/client.js', root), 'utf8')
  const size = statSync(new URL('dist/client.js', root)).size
  assert.ok(size <= CLIENT_SIZE_LIMIT, `dist/client.js ${size} B 超出预算 ${CLIENT_SIZE_LIMIT} B`)
  for (const marker of ['pack-snapshot', 'pack-install', 'pack-env-set', 'capability-packs', '能力包']) {
    assert.ok(artifact.includes(marker), `产物缺少能力包标记 ${marker}`)
  }
})
