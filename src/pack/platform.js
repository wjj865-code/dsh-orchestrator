// Desktop-only 判定（计划 §6.5）。
//
// 为什么不在面板/工具里各自判断：三处输入（Electron 的 process.versions.electron、
// argv 里的 `.asar`、Electron-as-node 的 `ELECTRON_RUN_AS_NODE`）在真机上命中方式不同，
// 分散判断必然漂移——某处漏一个信号，就是「面板显示、工具却拒绝」或反过来的幽灵状态。
//
// 配置 `capabilityPacksAllowOnWeb=true` 是唯一覆盖入口：用户明确要在 Web 上试，按 Desktop 处理，
// 但安装器/环境变量执行仍然只在 Windows 生效（那条是执行面约束，不随本开关放开）。

/**
 * 是否 Desktop 宿主（或 Electron-as-node / asar 内运行）。
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string[]} [options.argv]
 * @param {string} [options.profileName] - `profileContext?.name`（宿主 launcher 提供）
 * @param {object} [options.versions] - `process.versions`
 * @returns {boolean}
 */
export function isDesktopHost({ env = process.env, argv = process.argv, profileName, versions = process.versions } = {}) {
  if (env?.ELECTRON_RUN_AS_NODE === '1') return true
  if (versions !== undefined && versions !== null && typeof versions.electron === 'string' && versions.electron !== '') return true
  if (Array.isArray(argv) && argv.some(value => typeof value === 'string' && value.includes('.asar'))) return true
  return profileName === 'desktop'
}

/**
 * 能力包是否可用：总开关 ∧（Desktop ∨ allowOnWeb）。
 * @param {object} config - `loadConfig()` 结果
 * @param {object} [hostInfo] - `{ desktop, profileName }`（由 index 传入，测试可注入）
 */
export function capabilityPacksUsable(config = {}, hostInfo = {}) {
  if (config.capabilityPacks === false) return { ok: false, code: 'CAPABILITY_PACKS_DISABLED', message: '能力包已在配置里停用（capabilityPacks=false）。' }
  const desktop = hostInfo.desktop === true || config.capabilityPacksAllowOnWeb === true
  if (!desktop) {
    return {
      ok: false,
      code: 'PLATFORM_UNSUPPORTED',
      message: '能力包只支持 Desktop（Electron 宿主）。Web 下不注册预设、不写文件；确需启用可设 capabilityPacksAllowOnWeb=true。',
    }
  }
  return { ok: true }
}
