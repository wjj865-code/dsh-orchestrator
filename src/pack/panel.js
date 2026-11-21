// 能力包面板的服务端投影（P4）：只做「读快照 / 窄写口」，不新增任何派发语义。
//
// 为什么要单独一层而不是让路由直接调 service：
//   - 路由层只该做「鉴权 → 参数 → 结果 → HTTP」，投影里要处理「哪些字段能下发、只读投影不许写」；
//   - 面板与工具共用 service 闸门（confirm/planHash/幂等），这层只做参数窄化与字段白名单，
//     不复制业务判断（复制就一定会漂移）。
//
// 硬约束：
//   - `snapshot()` **不写盘、不 spawn**（`persist:false`：不写 health.json、不清理 trash）；
//   - `envSet` 的值只在调用栈里过一手，绝不进返回值/日志（service 已保证，这里也不附加）；
//   - 打开包会话/安装/删除都要宿主侧再判一次（面板按钮不是授权）。

/**
 * @param {object} options
 * @param {object} options.service - createPackService()
 */
export function createPackPanel({ service } = {}) {
  if (service === undefined) throw new Error('createPackPanel 需要 service')

  /** 只读快照：包列表 + 可用性 + 实测安装数据。 */
  const snapshot = () => {
    const result = service.list({ persist: false })
    return {
      ok: result.ok === true,
      usable: result.usable === true,
      ...(result.ok === true ? {} : { code: result.code, error: result.error }),
      packs: result.packs ?? [],
    }
  }

  const describe = id => service.describe(id)

  const open = (id, cwd) => service.open(id, { cwd })

  const install = (id, cliId, { confirm, planHash } = {}) => service.install(id, cliId, { confirm, expectedPlanHash: planHash })

  const uninstall = (id, cliId) => service.uninstall(id, cliId)

  const remove = (id, { confirm } = {}) => service.delete(id, { confirm })

  const envCopy = (id, ref) => service.envCopy(id, ref)

  const envSet = (id, ref, value, { confirm } = {}) => service.envSet(id, ref, value, { confirm })

  return { snapshot, describe, open, install, uninstall, remove, envCopy, envSet }
}
