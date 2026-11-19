// 版本口径断言的单测（P0-1）：正例用仓库真实文件，反例证明「README/CHANGELOG/files 漂移」会被抓到。
// 为什么要有反例：这条断言的唯一价值是**发版时拦住漂移**，只测正例等于什么都没测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { changelogHeadVersion, collectVersionProblems, readmeVersionPoints } from '../scripts/check-version.mjs'

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')
const pkg = async () => JSON.parse(await read('package.json'))

test('版本口径：仓库当前三处一致，且 CHANGELOG 随包发布', async () => {
  const problems = collectVersionProblems({
    pkg: await pkg(), readme: await read('README.md'), changelog: await read('CHANGELOG.md'),
  })
  assert.deepEqual(problems, [])
})

test('版本口径：README 定位行与安装命令都被纳入断言（不是只看第一处）', () => {
  const points = readmeVersionPoints('当前 `1.2.3`\n装 @wjj865-code/dsh-orchestrator@1.2.3\n再装 @wjj865-code/dsh-orchestrator@1.2.4')
  assert.deepEqual(points.map(point => [point.version, point.line]), [['1.2.3', 1], ['1.2.3', 2], ['1.2.4', 3]])
})

test('版本口径：README 漂移 / CHANGELOG 落后 / files 缺 CHANGELOG 都能被报出来', () => {
  const pkgFixture = { version: '0.20.1', files: ['index.js'] }
  const problems = collectVersionProblems({
    pkg: pkgFixture,
    readme: '当前 `0.19.1`\n@wjj865-code/dsh-orchestrator@0.19.1',
    changelog: '# Changelog\n\n## 0.19.2（2026-11-17）\n',
  })
  assert.equal(problems.length, 4)
  assert.match(problems.join('\n'), /README\.md:1/)
  assert.match(problems.join('\n'), /README\.md:2/)
  assert.match(problems.join('\n'), /CHANGELOG\.md 首条版本/)
  assert.match(problems.join('\n'), /files 没包含 CHANGELOG\.md/)
})

test('版本口径：CHANGELOG 首条只认版本标题', () => {
  assert.equal(changelogHeadVersion('# Changelog\n\n## 0.20.1（2026-11-17）\n'), '0.20.1')
  assert.equal(changelogHeadVersion('# Changelog\n\n没有版本标题\n'), undefined)
})
