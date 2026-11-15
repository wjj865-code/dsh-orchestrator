#!/usr/bin/env node
// 生成 orch-debug 预设 bundle（「创造模式」组合的副本），供调试子会话使用。
//
// 用法：
//   node scripts/orch-debug-preset.mjs                      # 生成到 $DSH_HOME/state/orchestrator/debug-presets/orch-debug
//   node scripts/orch-debug-preset.mjs --out <dir>          # 生成到指定目录
//   node scripts/orch-debug-preset.mjs --source <path>      # 指定源 presets/cordis.patch.yml（源码检出时用）
//   node scripts/orch-debug-preset.mjs --skills-dir <path>  # 用现成的技能目录（默认从安装包抄 dsh-doc）
//   node scripts/orch-debug-preset.mjs --no-skills          # 不挂 dsh-doc 技能
//   node scripts/orch-debug-preset.mjs --print              # 只打印补丁文本，不落盘
//   node scripts/orch-debug-preset.mjs --check              # 检查已生成的 bundle 是否仍与随包 cordis 对齐
//
// 失败（找不到源组合 / 写盘失败 / 对齐检查发现漂移）打印可读原因并以退出码 1 结束，不抛栈。
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEBUG_PRESET_ID,
  checkDebugPreset,
  debugPresetDir,
  prepareDebugPreset,
  renderBundlePatch,
  extractPluginsBlock,
  locateSourcePreset,
  replaceSkillDirs,
  SOURCE_PRESET_ID,
} from '../src/debug-preset.js'

const USAGE = '用法：node scripts/orch-debug-preset.mjs [--out <dir>] [--source <path>] [--skills-dir <path>] [--no-skills] [--print] [--check]'

function parseArgs(argv) {
  const args = { out: undefined, source: undefined, skillsDir: undefined, skills: undefined, print: false, check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--print') args.print = true
    else if (arg === '--check') args.check = true
    else if (arg === '--no-skills') args.skills = false
    else if (arg === '--out') args.out = argv[++index]
    else if (arg === '--source') args.source = argv[++index]
    else if (arg === '--skills-dir') args.skillsDir = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`未知参数：${arg}\n${USAGE}`)
  }
  return args
}

const stateDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'orchestrator')

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    return 1
  }
  if (args.help === true) {
    console.log(USAGE)
    return 0
  }

  if (args.check === true) {
    // 对齐检查：DSH 升级后组合会变，这个命令回答「已装的 bundle 还跟不跟得上」。只读，不写盘。
    const result = checkDebugPreset({ outDir: args.out ?? debugPresetDir(stateDir()), source: args.source })
    if (result.ok !== true) {
      console.error(`对齐检查失败（${result.reason}）：${result.hint ?? ''}`)
      for (const difference of result.differences ?? []) console.error(`  - ${difference.detail}`)
      return 1
    }
    console.log(`已对齐：${result.path}`)
    console.log(`  源：${result.source.kind === 'asar' ? `${result.source.path}#${result.source.entry}` : result.source.path}`)
    console.log(`  插件行：${result.plugins}（工具 / 技能 / 权限条件 / 系统提示与随包 cordis 一致）`)
    console.log(`  技能：${result.skills.dshDoc ? `已挂 dsh-doc（${result.skills.dir}）` : '未挂 dsh-doc（可能是 --no-skills 或复制失败，重新生成一次即可）'}`)
    return 0
  }

  if (args.print === true) {
    // 只读预览：不写盘、不抄技能，失败同样给可读原因。
    const located = locateSourcePreset({ source: args.source })
    if (located.ok !== true) {
      console.error(`没找到源预设：${located.reason}`)
      for (const item of located.tried ?? []) console.error(`  - ${item}`)
      return 1
    }
    const plugins = extractPluginsBlock(located.text, SOURCE_PRESET_ID)
    if (plugins === undefined) {
      console.error(`${located.path} 里没有 preset-${SOURCE_PRESET_ID} 的 plugins 列表`)
      return 1
    }
    // 预览按「不抄技能」渲染：customSkillDirs 会被删掉，避免打印出在 profile 里解析不了的表达式。
    process.stdout.write(renderBundlePatch({ plugins: replaceSkillDirs(plugins, args.skillsDir ?? undefined) }))
    return 0
  }

  const outDir = args.out ?? debugPresetDir(stateDir())
  const result = prepareDebugPreset({
    outDir,
    source: args.source,
    skills: args.skills,
    skillsDir: args.skillsDir,
  })
  if (result.ok !== true) {
    console.error(`生成 ${DEBUG_PRESET_ID} 预设失败（${result.reason}）：${result.hint ?? ''}`)
    return 1
  }
  console.log(`已生成 ${DEBUG_PRESET_ID} 预设：${result.outDir}`)
  console.log(`  来源：${result.source.kind === 'asar' ? `${result.source.path}#${result.source.entry}` : result.source.path}`)
  for (const file of result.files) console.log(`  - ${file}`)
  console.log(`  技能：${result.skills}${result.skillDir === undefined ? '' : `（${result.skillDir}）`}${result.skillNames.length === 0 ? '' : `；技能目录：${result.skillNames.join(', ')}`}`)
  console.log(`  对齐：${result.alignment.aligned ? `与随包 cordis 逐行一致（${result.alignment.generatedRows} 个插件行）` : `与随包 cordis 有 ${result.alignment.differences.length} 处不同（见下）`}`)
  for (const difference of result.alignment.differences) console.log(`    - ${difference.detail}`)
  console.log('')
  console.log('下一步：')
  console.log(`  1) 安装 bundle：plugin_manager 动作 install_bundle，target=${result.outDir}`)
  console.log('     （或把 cordis.patch.yml 里的 insert 行合并进 profile 的补丁文件后重启宿主）')
  console.log(`  2) 在插件配置里打开调试预设：workerPreset: ${DEBUG_PRESET_ID}`)
  console.log('  3) 彻底退出 DSH 再启动（只关窗口不生效），新派发的子会话才用新组合')
  console.log('  4) 派调试任务后用子会话工具表确认 cordis_inspect_list / cordis_inspect_query / plugin_manager')
  console.log('  5) 升级 DSH 后先跑 node scripts/orch-debug-preset.mjs --check 看组合是否漂移')
  return 0
}

process.exitCode = main()
