// 通用「环境变量配置」能力（计划 §5.5）。
//
// 硬约束（测试锁住）：
//   1. **永不读取/落盘值**：这里只回答「存在/不存在」（布尔），不返回长度、前后缀、指纹；
//   2. **默认零接触**：只生成可复制命令（`setx REF "<你的值>"`，值处是占位符，不预填）；
//   3. **执行需二次确认**：`setx` 把密钥短暂暴露在进程命令行、写入 HKCU\Environment；
//      成功只回 `{ ok, code }`，值只在这一次请求的内存里存在，不写日志、不回显、不进错误信息；
//   4. **只允许 manifest 声明过的变量**：未声明的 ref 直接拒绝（防「顺手设置一个我不知道的变量」）；
//   5. **只管 Windows**：非 Windows v1 只生成 export/launchctl 说明，不执行。

import { spawn } from 'node:child_process'

/** 环境变量名语法（与 manifest 校验同源；这里再守一次，防绕过 tool 直接调路由）。 */
export const ENV_REF = /^[A-Z_][A-Z0-9_]*$/

/** `setx` 的值上限（Windows 文档：1024 字符）。 */
export const SETX_MAX_CHARS = 1024

/** 只回答存在性，绝不读值。 */
export function envPresence(ref, env = process.env) {
  if (typeof ref !== 'string' || !ENV_REF.test(ref)) return { ref, set: false, valid: false }
  const value = env[ref]
  return { ref, set: typeof value === 'string' && value !== '', valid: true }
}

/** 按 manifest 汇总环境变量状态（面板/健康检查共用；顺序与声明一致）。 */
export function envSummary(manifest, env = process.env) {
  return manifest.env.map(item => ({
    ref: item.ref,
    kind: item.kind,
    required: item.required !== false,
    purpose: item.purpose,
    consumers: Array.isArray(item.consumers) ? item.consumers : [],
    ...(item.docs === undefined ? {} : { docs: item.docs }),
    ...envPresence(item.ref, env),
  }))
}

/** 生成可复制命令（默认路径：零接触）。值处只给占位符，绝不预填。 */
export function envCommand(ref, { platform = process.platform } = {}) {
  if (!ENV_REF.test(ref)) return { ok: false, error: `变量名不合法：${JSON.stringify(ref)}` }
  if (platform === 'win32') {
    return {
      ok: true,
      mode: 'copy',
      command: `setx ${ref} "<你的值>"`,
      notes: [
        'setx 写入用户级环境变量（HKCU\\Environment），对之后新启动的进程可见。',
        'setx 有 1024 字符上限；值会保存在注册表里（风险自担）。',
        '设置后必须**彻底退出 DSH 再启动**，宿主进程与包会话才能读到。',
        '只想临时验证当前 PowerShell 会话可用：`$env:' + ref + '="<你的值>"`（不持久）。',
      ],
    }
  }
  return {
    ok: true,
    mode: 'copy',
    command: `export ${ref}="<你的值>"`,
    notes: [
      'v1 只在 Windows 上提供持久化执行；macOS/Linux 请把变量写进 shell profile 或 launchctl。',
      '设置后需重启 DSH 才能让宿主进程读到。',
    ],
  }
}

/**
 * 由插件执行 setx（可选、需明确确认）。
 * 返回只含 `{ ok, code }`：值不回显、不写日志（调用方负责不记录 value）。
 * @param {object} options
 * @param {string} options.ref
 * @param {string} options.value - 只在本次请求内存里存在
 * @param {boolean} options.confirm - 必须显式 true
 * @param {string[]} options.allowedRefs - manifest 声明过的变量名
 * @param {string} [options.platform]
 * @param {(command: string, args: string[], options: object) => { on: Function, kill: Function }} [options.spawn]
 * @returns {Promise<{ ok: boolean, code?: string, error?: string }>}
 */
export function executeSetx({ ref, value, confirm, allowedRefs, platform = process.platform, spawnFn = spawn, timeoutMs = 15000 }) {
  if (platform !== 'win32') {
    return Promise.resolve({ ok: false, code: 'PLATFORM_UNSUPPORTED', error: '环境变量执行只在 Windows 上提供；请复制命令自行设置' })
  }
  if (!Array.isArray(allowedRefs) || !allowedRefs.includes(ref)) {
    return Promise.resolve({ ok: false, code: 'ENV_NOT_DECLARED', error: `包没有声明环境变量 ${JSON.stringify(ref)}，拒绝设置` })
  }
  if (confirm !== true) {
    return Promise.resolve({ ok: false, code: 'CONFIRM_REQUIRED', error: '执行 setx 需要二次确认（密钥会短暂出现在进程命令行并写入 HKCU\\Environment）' })
  }
  if (typeof value !== 'string' || value === '') {
    return Promise.resolve({ ok: false, code: 'ENV_VALUE_EMPTY', error: '值不能为空' })
  }
  if (value.length > SETX_MAX_CHARS) {
    return Promise.resolve({ ok: false, code: 'ENV_VALUE_TOO_LONG', error: `setx 上限 ${SETX_MAX_CHARS} 字符` })
  }
  return new Promise(resolve => {
    let settled = false
    const finish = (ok, code, error) => {
      if (settled) return
      settled = true
      resolve(error === undefined ? { ok, code } : { ok, code, error })
    }
    let child
    try {
      child = spawnFn('setx', [ref, value], { shell: false, windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      // 错误信息可能带命令（含值）：统一换成固定文案，绝不 `String(error)`。
      finish(false, 'ENV_SETX_FAILED', 'setx 启动失败（未写入）')
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(false, 'ENV_SETX_TIMEOUT', 'setx 超时（未确认写入）')
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      finish(false, 'ENV_SETX_FAILED', 'setx 启动失败（未写入）')
    })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code === 0) finish(true, 'OK')
      else finish(false, 'ENV_SETX_FAILED', `setx 退出码 ${code ?? '未知'}`)
    })
  })
}
