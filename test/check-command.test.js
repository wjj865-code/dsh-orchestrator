import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_EXTENSIONS, DEFAULT_PATHEXT, RUNNABLE_EXTENSIONS, comspecPlan, escapeCmdArgument, looksLikePath,
  pathExtList, planCheckSpawn, resolveWindowsCommand, searchedText, unsafeCmdIndex,
} from '../src/check-command.js'

// 这些用例都是纯函数：注入 platform/env/isFile 就能在 Linux CI 上稳定覆盖 Windows 分支，
// 不依赖真的装了 pnpm，也不依赖跑测试的机器是 Windows。

const winEnv = (overrides = {}) => ({
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  PATH: 'C:\\tools;C:\\nodejs',
  PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
  ...overrides,
})
const files = (...paths) => {
  const set = new Set(paths.map(path => path.toLowerCase()))
  return candidate => set.has(String(candidate).toLowerCase())
}

test('pathExtList：照 PATHEXT 原顺序、只留可执行扩展、缺的补在末尾', () => {
  assert.deepEqual(pathExtList({ PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1' }), ['.COM', '.EXE', '.BAT', '.CMD'])
  // 自定义顺序要尊重（PATHEXT 是 Windows 的优先级声明）
  assert.deepEqual(pathExtList({ PATHEXT: '.CMD;.EXE' }), ['.CMD', '.EXE', '.COM', '.BAT'])
  // PATHEXT 缺失/为空/全是不可执行项：兜底成默认顺序，.cmd 仍然有机会被找到
  assert.deepEqual(pathExtList({}), RUNNABLE_EXTENSIONS)
  assert.deepEqual(pathExtList({ PATHEXT: '' }), RUNNABLE_EXTENSIONS)
  assert.deepEqual(pathExtList({ PATHEXT: 'exe;.PS1;.VBS' }), RUNNABLE_EXTENSIONS)
  assert.equal(DEFAULT_PATHEXT, '.COM;.EXE;.BAT;.CMD')
})

test('resolveWindowsCommand：按 PATH 顺序 × PATHEXT 顺序找入口，只认可执行扩展', () => {
  const env = winEnv()
  // 第一个目录里只有 bash shim（无扩展名）→ 不算命中，继续找下一个目录的 .cmd
  const shimFirst = resolveWindowsCommand('pnpm', {
    env,
    isFile: files('C:\\tools\\pnpm', 'C:\\nodejs\\pnpm.cmd'),
  })
  assert.equal(shimFirst.found, true)
  // 候选名里的扩展名按 PATHEXT 原样（大写），Windows 上大小写不敏感
  assert.equal(shimFirst.command, 'C:\\nodejs\\pnpm.CMD')
  assert.deepEqual(shimFirst.searched.slice(0, 4), [
    'C:\\tools\\pnpm.COM', 'C:\\tools\\pnpm.EXE', 'C:\\tools\\pnpm.BAT', 'C:\\tools\\pnpm.CMD',
  ])

  // PATH 顺序优先：前面的目录命中就停，不再看后面的
  const firstWins = resolveWindowsCommand('pnpm', {
    env: winEnv({ PATH: 'C:\\a;C:\\b' }),
    isFile: files('C:\\a\\pnpm.cmd', 'C:\\b\\pnpm.exe'),
  })
  assert.equal(firstWins.command, 'C:\\a\\pnpm.CMD')

  // 同一目录里 .EXE 在 PATHEXT 里排前面 → 优先 .exe（不是「.cmd 一定赢」）
  const exeFirst = resolveWindowsCommand('pnpm', {
    env: winEnv({ PATH: 'C:\\a' }),
    isFile: files('C:\\a\\pnpm.exe', 'C:\\a\\pnpm.cmd'),
  })
  assert.equal(exeFirst.command, 'C:\\a\\pnpm.EXE')

  // 大小写不敏感（Windows 上实际存的是 pnpm.CMD）
  const upper = resolveWindowsCommand('pnpm', {
    env: winEnv({ PATH: 'C:\\pnpm\\bin' }),
    isFile: files('C:\\pnpm\\bin\\pnpm.CMD'),
  })
  assert.equal(upper.found, true)
})

test('resolveWindowsCommand：没找到时把找过的候选路径按顺序交回来；坏 PATH 项不认', () => {
  const env = winEnv({ PATH: 'C:\\a;"";  ;relative\\bin;C:\\b', PATHEXT: '.EXE;.CMD' })
  const result = resolveWindowsCommand('pnpm', { env, isFile: () => false })
  assert.equal(result.found, false)
  assert.equal(result.command, null)
  // 相对 PATH 项按宿主 cwd 解析会和任务 cwd 错位：跳过，不列进候选
  assert.deepEqual(result.searched, [
    'C:\\a\\pnpm.EXE', 'C:\\a\\pnpm.CMD',
    'C:\\a\\pnpm.COM', 'C:\\a\\pnpm.BAT',
    'C:\\b\\pnpm.EXE', 'C:\\b\\pnpm.CMD',
    'C:\\b\\pnpm.COM', 'C:\\b\\pnpm.BAT',
  ])
  assert.match(searchedText(result.searched, 4), /C:\\a\\pnpm\.EXE、C:\\a\\pnpm\.CMD、C:\\a\\pnpm\.COM、C:\\a\\pnpm\.BAT …（共 8 个）/)
  assert.equal(searchedText([]), '')
})

test('resolveWindowsCommand：带引号的 PATH 项能用，空 PATH 不炸', () => {
  const quoted = resolveWindowsCommand('pnpm', {
    env: winEnv({ PATH: '"C:\\Program Files\\nodejs"' }),
    isFile: candidate => candidate.toLowerCase() === 'c:\\program files\\nodejs\\pnpm.cmd',
  })
  assert.equal(quoted.command, 'C:\\Program Files\\nodejs\\pnpm.CMD')
  const empty = resolveWindowsCommand('pnpm', { env: { PATHEXT: '.CMD' }, isFile: () => true })
  assert.deepEqual([empty.found, empty.searched], [false, []])
  assert.deepEqual(resolveWindowsCommand('', { env: winEnv(), isFile: () => true }), {
    found: false, command: null, searched: [],
  })
})

test('looksLikePath：带目录分隔符或盘符就算路径（这些命令不做二次解析）', () => {
  for (const value of ['C:\\tools\\pnpm', '.\\pnpm', '/usr/bin/node', 'a/b', 'C:pnpm']) {
    assert.equal(looksLikePath(value), true, value)
  }
  for (const value of ['pnpm', 'pnpm.cmd', 'node']) assert.equal(looksLikePath(value), false, value)
})

test('escapeCmdArgument：反斜杠加倍 + 双引号包裹 + cmd 元字符 ^ 兜住', () => {
  // 普通参数：就是一层引号
  assert.equal(escapeCmdArgument('test'), '^"test^"')
  // 含空格：被引号包住，空格 ^ 兜住（整项仍是一个参数）
  assert.equal(escapeCmdArgument('a b'), '^"a^ b^"')
  // 元字符全部 ^ 兜住：& | % < > ( ) ; , * ? ^ ` !
  assert.equal(escapeCmdArgument('a&b|c'), '^"a^&b^|c^"')
  assert.equal(escapeCmdArgument('%PATH%'), '^"^%PATH^%^"')
  // 结尾反斜杠加倍，避免吃掉收尾引号；结尾两个反斜杠加两倍
  assert.equal(escapeCmdArgument('C:\\a b\\'), '^"C:\\a^ b\\\\^"')
  // 内嵌双引号按 CreateProcess 规则转义（能还原，但经 cmd 仍有边界，见 planCheckSpawn 的 fail-closed）
  assert.equal(escapeCmdArgument('a"b'), '^"a\\^"b^"')
  assert.equal(escapeCmdArgument(''), '^"^"')
})

test('comspecPlan：/d /s /c + 外层引号 + windowsVerbatimArguments', () => {
  const env = winEnv()
  const plan = comspecPlan('C:\\pnpm\\bin\\pnpm.cmd', ['test', '--', 'a b'], env)
  assert.equal(plan.command, env.ComSpec)
  assert.equal(plan.args.length, 4)
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  const line = plan.args[3]
  assert.match(line, /^".*"$/, '整条命令行要被外层引号包住（/s 之后原样交给 cmd）')
  assert.ok(line.includes('pnpm.cmd'), '命令路径在里面')
  assert.ok(line.includes('^"a^ b^"'), '含空格的参数被引号包住且不被拆开')
  assert.equal(plan.options.windowsVerbatimArguments, true)
  // 没有 ComSpec 时兜底 cmd.exe（老环境/注入的 env 缺这一项）
  assert.equal(comspecPlan('a.cmd', [], {}).command, 'cmd.exe')
})

test('planCheckSpawn：非 Windows 原样 spawn（行为不变）', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const plan = planCheckSpawn(['pnpm', 'test'], { platform, env: winEnv(), isFile: () => false })
    assert.equal(plan.kind, 'spawn')
    assert.equal(plan.command, 'pnpm')
    assert.deepEqual(plan.args, ['test'])
    assert.deepEqual(plan.options, {})
  }
})

test('planCheckSpawn：Windows 无扩展名命令解析到 .cmd → 经 ComSpec', () => {
  const env = winEnv({ PATH: 'C:\\pnpm\\bin' })
  const plan = planCheckSpawn(['pnpm', 'test'], {
    platform: 'win32', env, isFile: files('C:\\pnpm\\bin\\pnpm.CMD'),
  })
  assert.equal(plan.kind, 'spawn')
  assert.equal(plan.command, env.ComSpec)
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.ok(plan.args[3].includes('pnpm.CMD'))
  assert.equal(plan.options.windowsVerbatimArguments, true)
})

test('planCheckSpawn：Windows 解析到 .exe → 直接 spawn（不绕 ComSpec）', () => {
  const plan = planCheckSpawn(['node', '--test'], {
    platform: 'win32', env: winEnv(), isFile: files('C:\\nodejs\\node.exe'),
  })
  assert.equal(plan.kind, 'spawn')
  assert.equal(plan.command, 'C:\\nodejs\\node.EXE')
  assert.deepEqual(plan.args, ['--test'])
  assert.deepEqual(plan.options, {})
})

test('planCheckSpawn：带路径 / 带扩展名的命令不再二次解析', () => {
  const isFile = () => { throw new Error('带路径/带扩展名的命令不该进 PATH 解析') }
  // 带路径的无扩展名命令：原样交给 spawn（和旧行为一致，找不到就 ENOENT）
  const pathOnly = planCheckSpawn(['.\\node_modules\\.bin\\eslint', '.'], {
    platform: 'win32', env: winEnv(), isFile,
  })
  assert.equal(pathOnly.kind, 'spawn')
  assert.equal(pathOnly.command, '.\\node_modules\\.bin\\eslint')
  assert.deepEqual(pathOnly.options, {})
  // 显式写 .exe：不再找 PATH
  const exe = planCheckSpawn(['C:\\tools\\node.exe', '-e', '0'], { platform: 'win32', env: winEnv(), isFile })
  assert.equal(exe.command, 'C:\\tools\\node.exe')
  // 显式写 .cmd（带路径）：不解析，但仍要 ComSpec（CreateProcess 执行不了批处理）
  const cmd = planCheckSpawn(['.\\scripts\\build.cmd', 'all'], { platform: 'win32', env: winEnv(), isFile })
  assert.equal(cmd.command, winEnv().ComSpec)
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.ok(cmd.args[3].includes('build.cmd'))
  assert.ok(BATCH_EXTENSIONS.includes('.cmd'))
})

test('planCheckSpawn：Windows 上解析不到命令 → missing（带候选路径，交给 skipIfMissing 决定）', () => {
  const plan = planCheckSpawn(['pnpm', 'test'], {
    platform: 'win32', env: winEnv({ PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' }), isFile: () => false,
  })
  assert.equal(plan.kind, 'missing')
  assert.equal(plan.command, 'pnpm')
  assert.deepEqual(plan.args, ['test'])
  assert.deepEqual(plan.searched, [
    'C:\\tools\\pnpm.EXE', 'C:\\tools\\pnpm.CMD', 'C:\\tools\\pnpm.COM', 'C:\\tools\\pnpm.BAT',
  ])
})

test('planCheckSpawn：.cmd 的参数含双引号/控制字符 → unsafe（fail-closed，不拼串）', () => {
  const env = winEnv({ PATH: 'C:\\pnpm\\bin' })
  const base = { platform: 'win32', env, isFile: files('C:\\pnpm\\bin\\pnpm.cmd') }
  const quotes = planCheckSpawn(['pnpm', 'exec', 'node', '-e', 'console.log("x")'], base)
  assert.equal(quotes.kind, 'unsafe')
  assert.equal(quotes.unsafeIndex, 4)
  const newline = planCheckSpawn(['pnpm', 'test\necho pwned'], base)
  assert.equal(newline.kind, 'unsafe')
  assert.equal(newline.unsafeIndex, 1)
  // 反例：同样的参数交给 .exe 就没有 cmd 边界，照原样 spawn
  const exe = planCheckSpawn(['node', '-e', 'console.log("x")'], {
    platform: 'win32', env: winEnv({ PATH: 'C:\\nodejs' }), isFile: files('C:\\nodejs\\node.exe'),
  })
  assert.equal(exe.kind, 'spawn')
  assert.equal(exe.command, 'C:\\nodejs\\node.EXE')
  assert.equal(unsafeCmdIndex(['pnpm', 'test', 'a&b', '100%']), -1)
})

test('安全回归：ComSpec 命令行里每个参数都被单独引用，注入串不会变成独立命令', () => {
  const env = winEnv()
  const injection = '& echo pwned > pwned.txt &'
  const plan = comspecPlan('C:\\pnpm\\bin\\pnpm.cmd', ['test', injection], env)
  const line = plan.args[3]
  // 每个 & / | 都必须紧跟在一个 ^ 后面（cmd 只认 ^ 转义），没有漏网的裸分隔符
  const separators = line.match(/[&|]/g) ?? []
  const escapedSeparators = line.match(/\^[&|]/g) ?? []
  assert.equal(separators.length, escapedSeparators.length)
  assert.ok(line.includes('^&^ echo^ pwned^ ^>^ pwned.txt^ ^&'))
  // 也没有把 argv 直接 join 成一条裸命令（那正是要禁的写法）
  assert.notEqual(line, `"${['C:\\pnpm\\bin\\pnpm.cmd', 'test', injection].join(' ')}"`)
  assert.equal(plan.options.shell, undefined, '不在 options 里开 shell：ComSpec 是唯一入口')
})
