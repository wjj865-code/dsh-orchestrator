// 兼容声明（`engines.dsh`）的单一真源断言。
//
// 为什么单开一个文件：这条声明不是「文档口径」，而是**宿主硬闸门**——rc.5 的 app-boot 在装载插件前
// 用 `semver.satisfies(hostVersion, engines.dsh, { includePrerelease: true })` 判定，不满足就整行
// 禁用（`disabling profile plugin …`），安装侧还会在 pnpm 之前拒装。声明写错/两处漂移的后果不是
// 「诊断行难看」，而是「新宿主上插件直接不加载」，所以这里同时锁三件事：
//   1. `package.json:engines.dsh` == `src/host-capabilities.js:HOST_BASELINE`（逐字一致）；
//   2. 区间语义（与宿主同一套 includePrerelease 语义）的通过/拒绝矩阵；
//   3. README / docs/compat.md 与声明同口径，且不许再写「区间外只 warn」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { HOST_BASELINE, compareVersions, versionStatus } from '../src/host-capabilities.js'

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')
const readPackage = async () => JSON.parse(await read('package.json'))

/**
 * 与宿主同语义的区间判定：`semver.satisfies(version, range, { includePrerelease: true })`
 * 对单段 `>=min <upperExclusive` 的等价写法。
 *
 * 为什么不用 semver 包：本仓库不依赖 semver（宿主自带），而 `compareVersions` 是运行时判读
 * （诊断行/日志）用的同一份实现——测试直接吃它，才能保证「测试、诊断、声明」一个口径。
 * 已经用宿主安装包里自带的 semver 7.8.5 逐版本对拍过（见 test 里的边界断言）。
 * 不可解析/空值按「不满足」处理（宿主对空区间、非法区间也返回不满足）。
 */
function hostGateAllows(version, baseline = HOST_BASELINE) {
  if (compareVersions(version, baseline.min) === undefined) return false
  return compareVersions(version, baseline.min) >= 0 && compareVersions(version, baseline.upperExclusive) < 0
}

test('区间语义矩阵：rc.2–rc.5 通过，rc.1 及以下与 0.3.0（含预览）被拒', () => {
  for (const version of ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.2']) {
    assert.equal(hostGateAllows(version), true, `${version} 应落在声明区间内`)
  }
  for (const version of ['0.2.1', '0.2.2-rc.1', '0.3.0-rc.1', '0.3.0-rc.2', '0.3.0-0', '0.3.0']) {
    assert.equal(hostGateAllows(version), false, `${version} 应被声明区间拒绝`)
  }
  // 探测不到的宿主不会被判「不兼容」：gate 只用于已知版本；unknown 走诊断行。
  for (const version of ['not-a-version', '', undefined]) {
    assert.equal(hostGateAllows(version), false, `${String(version)} 不是可比较版本，按不满足处理`)
  }
})

test('上界是 `0.3.0-0`：includePrerelease 下也只有这样才拦得住 0.3.0 的预览', () => {
  // 宿主 bundled semver（7.8.5）语义：`0.3.0-rc.1 < 0.3.0` 成立，所以上界写成 `0.3.0` 时预览会被放行；
  // `0.3.0-0` 是 semver 的「小于 0.3.0 的任何预发布」写法（数字标识符优先级最低），预览一律被拒。
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), -1, '这是必须写 -0 的原因')
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0-0'), 1)
  assert.equal(compareVersions('0.3.0-0', '0.3.0'), -1)
  assert.equal(hostGateAllows('0.3.0-rc.1'), false)
  assert.equal(hostGateAllows('0.3.0-0'), false, '`-0` 本身也不在区间内（上界是开区间）')
  assert.equal(HOST_BASELINE.upperExclusive, '0.3.0-0', '删除/改回 0.3.0 会让 0.3.0 的预览重新溜进基线')
})

test('声明与运行时判读同源：engines.dsh == HOST_BASELINE.range，且保留 engines.node', async () => {
  const pkg = await readPackage()
  assert.equal(
    pkg.engines?.dsh,
    HOST_BASELINE.range,
    'package.json:engines.dsh 与 src/host-capabilities.js:HOST_BASELINE.range 必须逐字一致（宿主读前者、诊断用后者）',
  )
  assert.equal(pkg.engines?.node, '>=22.15', 'engines.node 不能被兼容声明挤掉')
  // 区间字符串与 min/upperExclusive 两个字段也不能各说各话（诊断行只显示 range，比较用两个字段）。
  assert.equal(HOST_BASELINE.range, `>=${HOST_BASELINE.min} <${HOST_BASELINE.upperExclusive}`)
  // 声明与 versionStatus 必须互不矛盾：inside ⇔ 宿主闸门放行。
  for (const version of ['0.2.1', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.5', '0.3.0-rc.1', '0.3.0-0', '0.3.0']) {
    assert.equal(versionStatus(version) === 'inside', hostGateAllows(version), `${version} 的诊断状态与闸门判定不一致`)
  }
})

test('文档同口径：README 与 docs/compat.md 写明声明区间与硬闸门（拒装/禁用/精确豁免）', async () => {
  const readme = await read('README.md')
  assert.ok(readme.includes(`\`${HOST_BASELINE.range}\``), 'README 首屏必须点名 engines.dsh 的完整区间')
  assert.match(readme, /兼容基线[\s\S]{0,80}rc\.2[\s\S]{0,40}rc\.5/, 'README 首屏仍要有人类可读的 rc.2–rc.5')

  const compat = await read('docs/compat.md')
  assert.ok(compat.includes(HOST_BASELINE.range), 'docs/compat.md 缺少声明区间')
  assert.ok(compat.includes('0.3.0-0'), 'docs/compat.md 要写明上界为什么是 `0.3.0-0`（预览一起拒）')
  assert.ok(compat.includes('0.2.2-rc.1'), 'docs/compat.md 要说明 rc.1 为何不在声明区间内（startActivation 形状不同）')
  for (const needle of ['engines.dsh', 'compatibility.json', 'allow-version', 'incompatible-version', 'disabling profile plugin']) {
    assert.ok(compat.includes(needle), `docs/compat.md 缺少闸门细节：${needle}`)
  }
  // 旧口径必须清掉：区间外不是「只 warn、照常加载」，而是拒装 / 启动禁用；上界也不再留「<0.3.0 也行」的两套说法。
  assert.doesNotMatch(compat, /照常加载|不拦加载|区间外只\s?warn/, 'docs/compat.md 仍在说「区间外只 warn/照常加载」')
  assert.doesNotMatch(compat, /尚未声明/, 'docs/compat.md 仍在说「本包尚未声明 engines.dsh」')
  assert.doesNotMatch(compat, /需写\s?`<0\.3\.0-0`|区间得写\s?`<0\.3\.0-0`/, 'docs/compat.md 仍把 `<0.3.0-0` 写成「将来要改」的建议，应写成现状')
})

test('启动自检文案不再承诺「照常加载」：越界时真正拦人的是宿主闸门', async () => {
  const index = await read('index.js')
  assert.doesNotMatch(index, /插件照常加载/, 'index.js 越界 warn 仍在说「插件照常加载」')
  assert.match(index, /engines\.dsh/, 'index.js 的越界说明要点到 engines.dsh（否则读者以为是插件自己拦）')
})
