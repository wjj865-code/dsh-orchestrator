// 派发层：把「建子会话 / 投递 / 停止」收成一个窄接口。
// 后端：subagent（唯一实现，直连 ctx.subagents）。旧的 team 后端与 `backend` 配置键已删除
// （P0-1 删实现，P1-A 删键与占位派发器）。
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { messageText } from './last-message.js'
import { EXIT_PLAN_MODE_DENIAL } from './plan-mode.js'
import { WRITE_DOMAIN_DENIED } from './action-errors.js'

let counter = 0

function slugify(title) {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  counter += 1
  return ascii === '' ? `task-${Date.now()}-${counter}` : `${ascii.slice(0, 32)}-${counter}`
}

const sleep = ms => ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms))
const noop = () => {}

const errorText = error => `${error?.code === undefined ? '' : `[${error.code}] `}${error?.message ?? error}`

/**
 * `sendMessage` 返回值归一（X4）：`{messageId}` / `{id}` / 裸字符串都收成 `string | undefined`。
 * 归一后的 string 才进 `planWrite.messageId` / `sentCache` / followup 行 `meta.messageId`（幂等链的同一口径）。
 */
export const normalizeMessageId = raw => {
  if (typeof raw === 'string') return raw === '' ? undefined : raw
  const value = raw?.messageId ?? raw?.id
  return typeof value === 'string' && value !== '' ? value : undefined
}

// 结算事件带一段可读输出（与平台 SubagentResult.output 同形），供台账记「死因」用。
const settleOutput = (output, max = 240) => {
  const blocks = Array.isArray(output) ? output : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? '' : (text.length > max ? `${text.slice(0, max)}…` : text)
}

/** 两个目录是否同一个：Windows 大小写不敏感；解析失败就按原串比较。 */
export function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  try {
    const a = resolvePath(left)
    const b = resolvePath(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return left === right
  }
}

export function createSubagentDispatcher({ subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs = [1000, 2000, 4000], onWarn = noop, onEvent = noop, agents, sessions, sandboxPolicy, onSessionCreated, onAgentCreated, sessionWaitMs = 5000, goalBridge, writableRootJudge }) {
  const currentAgent = () => getAgent === undefined ? agent : getAgent()
  const requireAgent = () => {
    const current = currentAgent()
    if (current === undefined) throw new Error('未找到协调者会话：请配置 coordinatorSession（协调者会话 id），并确保该会话已加载')
    return current
  }
  // rc.3 改名 listDescendants ; rc.1 是 listChildren。按服务方法探测，不按版本号猜。
  const listChildren = (parentId, signal) => typeof subagents.listDescendants === 'function'
    ? subagents.listDescendants(parentId, signal)
    : subagents.listChildren(parentId, signal)
  const parentSessionId = () => {
    const current = requireAgent()
    return current.session?.id ?? current.id
  }
  const live = new Map()
  // 只读子任务：派发时把 childId 记下来，agent/created 一到就设沙箱（压首回合窗口）。
  const readOnlyChildren = new Set()
  // per-task 完整访问（access:'full'）：同一机制、同一条注入路径，只是模式换成 danger-full-access。
  // 只按 childId 记，绝不写全局默认/父会话，也不从配置或 brief 继承——漏传就什么都没发生。
  const fullAccessChildren = new Set()
  // P8 计划任务：同样在派发前登记，agent/created 一到就设只读 + 置 plan mode + 装 exit_plan_mode guard。
  const planChildren = new Set()
  // C（主会话钉只读）配套：普通任务子会话显式钉 workspace-write。
  // 为什么必须显式写：宿主把**父会话的显式 sandbox/mode 覆盖**按 `source:'delegation'` 种进每个
  // 子会话（@deepseek-ai/dsh-subagent 的 appendDelegatedPolicyOverrides）。主会话钉成 read-only
  // 以后，不清回来就会让所有普通子任务跟着只读、写不了文件。只写我们派出的 childId。
  const defaultChildren = new Set()
  // 子会话 agent 作用域 guard 的 disposer；按 childId 收口（任务终态/停止时释放，不留悬挂监听）。
  const planGuards = new Map()
  // planMode 服务缺失只 warn 一次/子会话（rc 包/预设没挂时每个任务都 warn 会刷日志）。
  const planModeWarned = new Set()
  // 已经成功置过 plan mode 的子会话：agent/created 与激活返回两条路都会调一次，靠它去重。
  const planApplied = new Set()
  // 已批准计划任务的「写入意图」：targetId → { targetDir, taskId, state:'switching'|'granted', reason, messageId, updatedAt }。
  // 批准只记账（台账事实），真正的可写根授予发生在**续派投递的 post-send**；hook 只是「尽力提前」。
  // 这张表不随 activation 结算清理（冷恢复要按同一个 target 重试授予），只在 stop/终态/重批重置时删。
  const planWrite = new Map()
  // 投递幂等：attemptKey → messageId。同一逻辑投递（同一 followup 行 / 同一续派）重放时不再 sendMessage。
  const sentCache = new Map()
  const PLAN_WRITE_LIMIT = 500
  const SENT_CACHE_LIMIT = 1000
  /** 任务结束时清掉该任务的幂等缓存（attemptKey 形如 `followup:<taskId>:<seq>`，按 taskId 段匹配）。 */
  const clearSentCacheFor = taskId => {
    if (typeof taskId !== 'string' || taskId === '') return
    const marker = `:${taskId}:`
    for (const key of [...sentCache.keys()]) {
      if (key.includes(marker)) sentCache.delete(key)
    }
  }
  const trimDispatchCaches = () => {
    if (planWrite.size > PLAN_WRITE_LIMIT) {
      const entries = [...planWrite.entries()].sort((left, right) => (left[1]?.updatedAt ?? 0) - (right[1]?.updatedAt ?? 0))
      for (const [key] of entries.slice(0, planWrite.size - PLAN_WRITE_LIMIT)) planWrite.delete(key)
    }
    while (sentCache.size > SENT_CACHE_LIMIT) {
      const oldest = sentCache.keys().next().value
      sentCache.delete(oldest)
    }
  }
  const markPlanSwitching = (targetId, reason) => {
    const pending = planWrite.get(targetId)
    if (pending === undefined) return
    pending.state = 'switching'
    pending.reason = reason ?? 'unknown'
    pending.updatedAt = Date.now()
  }
  /** 审计事件出口：任何阶段都不能让事件消费方把投递/授予带崩。 */
  const safeEvent = (event, fields) => {
    try {
      onEvent(event, fields)
    } catch { /* 审计事件失败不能外溢 */ }
  }

  // 服务按调用时惰性取：插件加载顺序不保证 agents/sessions/sandboxPolicy 已就绪。
  const serviceOf = value => typeof value === 'function' ? value() : value
  // 可写根授权按 targetId → (Session 对象 → (目录 → disposer)) 记：同一会话 resume 前后可能有多个会话对象，
  // 注册只追加不替换；终态/stop 按 targetId 全量释放，旧对象不残留、新对象也不会没人管。
  // 幂等 key 仍是 (Session 对象, 目录)：sandboxPolicy 内部按对象身份查 WeakMap，换对象就得重新注册。
  const writableRootGrants = new Map()
  const grantSessions = targetId => {
    let sessions = writableRootGrants.get(targetId)
    if (sessions === undefined) {
      sessions = new Map()
      writableRootGrants.set(targetId, sessions)
    }
    return sessions
  }
  const grantDirs = (targetId, session) => {
    const sessions = grantSessions(targetId)
    let dirs = sessions.get(session)
    if (dirs === undefined) {
      dirs = new Map()
      sessions.set(session, dirs)
    }
    return dirs
  }
  const childSessionOf = childId => {
    const childAgent = serviceOf(agents)?.get?.(childId)
    if (childAgent?.session !== undefined) return childAgent.session
    return serviceOf(sessions)?.get?.(childId)
  }
  // 沙箱模式注入：平台唯一写入口就是 session.append('sandbox/mode', { mode })
  // （导出的 setSandboxMode 只是它的薄包装）。只写目标 child session，不动全局默认与父会话。
  // 投影已有同一模式时跳过：续派/重启 replay 都会保留，不需要重复 append。
  // 完整访问带 source:'delegation'（与平台把父会话覆盖种进子会话时的事件形状一致，见
  // @deepseek-ai/dsh-subagent 的 appendDelegatedPolicyOverrides），只读保持历史形状不变。
  const SANDBOX_LABEL = { 'read-only': '只读', 'workspace-write': '可写', 'danger-full-access': '完整访问' }
  const SANDBOX_EVENT = {
    'read-only': 'subagent.read-only',
    'workspace-write': 'subagent.workspace-write',
    'danger-full-access': 'subagent.full-access',
  }
  const ensureSandboxMode = (childId, mode, sessionHint) => {
    try {
      const session = sessionHint ?? childSessionOf(childId)
      if (session === undefined) return false
      const policy = serviceOf(sandboxPolicy)
      if (policy?.overrideOf?.(session) === mode) return false
      if (typeof session.append !== 'function') return false
      const payload = mode === 'read-only' ? { mode } : { mode, source: 'delegation' }
      session.append('sandbox/mode', payload)
      onEvent(SANDBOX_EVENT[mode] ?? 'subagent.sandbox', {
        sessionId: childId,
        detail: { sessionId: session.id ?? childId, mode },
      })
      return true
    } catch (error) {
      onWarn(`dsh-orchestrator: 设置${SANDBOX_LABEL[mode] ?? mode}沙箱失败：${errorText(error)}`)
      return false
    }
  }
  const ensureReadOnly = (childId, sessionHint) => ensureSandboxMode(childId, 'read-only', sessionHint)
  // 该 childId 应注入的沙箱模式（只读/计划优先；完整访问其次；普通任务钉 workspace-write；
  // 未登记返回 undefined = 什么都不动）。
  const sandboxModeFor = childId => {
    if (readOnlyChildren.has(childId) || planChildren.has(childId)) return 'read-only'
    if (fullAccessChildren.has(childId)) return 'danger-full-access'
    if (defaultChildren.has(childId)) return 'workspace-write'
    return undefined
  }
  // agent/created 监听器在下方（grant chokepoint 定义之后）注册：approved 分支要先于
  // sandboxModeFor / `mode===undefined` 的提前 return 生效，且整段 try/catch、绝不抛错、返回恒 undefined。

  // P8：取子 agent。
  const childAgentOf = (childId, hint) => hint ?? serviceOf(agents)?.get?.(childId)

  /**
   * P8：读子会话的 planMode 服务。
   *
   * 平台现状（DSH 0.2.2-rc.3 桌面 profile）：
   * - 宿主 base bundle 的 `plan-mode` 行被 web-app 的 patch `disabled: true` 关掉了；
   * - plan-mode 由各 agent 预设自己在 `isolate: { planMode: true }` 的组里提供
   *   （见 @deepseek-ai/dsh-web-app/presets/standard.patch.yml），即**预设隔离域**服务；
   * - 宿主为这种服务提供的读法是 `agentPresets.serviceFor(agent, name)`
   *   （见 @deepseek-ai/dsh-agent-preset-registry 的 serviceFor 文档），
   *   `agent.ctx.get('planMode')` 只在服务落在外层非隔离作用域时才看得到。
   *
   * 关键约束：cordis 的 ctx 是 Proxy，读一个「当前 fiber 链上拿不到、又没声明 inject」的服务属性会
   * **直接抛** `cannot get property "x" without inject`（cordis src/reflect.ts 的 get trap），
   * 所以这里绝不能让属性读成为裸调用：每条更易抛的读法都包 try，全部失败按「服务缺失」降级。
   */
  const planModeServiceOf = childAgent => {
    const ctx = childAgent?.ctx
    if (ctx === undefined || ctx === null) return undefined
    const lookups = [
      // 首选：宿主公开 API —— 读 agent 预设隔离域里的服务（plan-mode 通常装在这里）。
      () => {
        const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
        return typeof presets?.serviceFor === 'function' ? presets.serviceFor(childAgent, 'planMode') : undefined
      },
      // 次选：服务落在 agent ctx 可达的非隔离作用域（自定义预设直接挂 plan-mode 的旧形态）。
      () => typeof ctx.get === 'function' ? ctx.get('planMode') : undefined,
      // 兜底：旧平台/测试替身把服务直接挂成 ctx 属性；cordis 代理可能抛，靠上面的 try 兜住。
      () => ctx.planMode,
    ]
    for (const lookup of lookups) {
      let service
      try {
        service = lookup()
      } catch {
        continue
      }
      if (service !== undefined && service !== null) return service
    }
    return undefined
  }

  /** 置/关 plan mode；服务缺失、agent 还没出现、调用失败都只降级（只读沙箱仍在）。 */
  const applyPlanMode = (childId, active, agentHint) => {
    if (active === true && planApplied.has(childId)) return { ok: true, outcome: 'noop', skipped: true }
    let childAgent
    let service
    try {
      childAgent = childAgentOf(childId, agentHint)
      if (childAgent === undefined) return { ok: false, reason: 'agent-missing' }
      service = planModeServiceOf(childAgent)
    } catch (error) {
      // 读取服务本身失败（宿主代理抛错等）同样按降级处理：只读沙箱是硬拦，plan mode 只是软引导，
      // 绝不能因为读不到软引导而把整次派发/批准弄失败。
      if (!planModeWarned.has(childId)) {
        planModeWarned.add(childId)
        onWarn(`dsh-orchestrator: 读取 planMode 服务失败，已降级为只有只读沙箱：${errorText(error)}`)
      }
      return { ok: false, reason: 'service-lookup-failed' }
    }
    if (service === undefined || typeof service.set !== 'function') {
      if (!planModeWarned.has(childId)) {
        planModeWarned.add(childId)
        onWarn('dsh-orchestrator: planMode 服务不可用（平台未挂载或子会话预设作用域看不到），已降级为只有只读沙箱')
      }
      return { ok: false, reason: 'service-missing' }
    }
    try {
      const outcome = service.set(childAgent, active === true)
      if (active === true) planApplied.add(childId)
      else planApplied.delete(childId)
      return { ok: true, outcome }
    } catch (error) {
      onWarn(`dsh-orchestrator: 设置 plan mode 失败：${errorText(error)}`)
      return { ok: false, reason: errorText(error) }
    }
  }

  /**
   * P8：子会话的 exit_plan_mode 一律拒绝，并指向 task_report blocked 出口。
   * 必须注册在 agent 作用域（agent.ctx.tools.guard）：插件根的 ctx.tools.guard 是全局的，会误伤协调者。
   */
  const installExitPlanGuard = (childId, agentHint) => {
    if (planGuards.has(childId)) return true
    let tools
    try {
      // 同上：ctx 是 cordis 代理，读不到的服务属性会抛；guard 装不上只降级（task_report 出口仍在文案里）。
      tools = childAgentOf(childId, agentHint)?.ctx?.tools
    } catch (error) {
      onWarn(`dsh-orchestrator: 读取子会话 tools 服务失败，未安装 exit_plan_mode guard：${errorText(error)}`)
      return false
    }
    if (tools === undefined || typeof tools.guard !== 'function') return false
    try {
      const dispose = tools.guard(exec => {
        if (exec?.name !== 'exit_plan_mode') return undefined
        // agent 作用域本身已经限定；这里再挡一道，防止同一 ctx 被复用时的串扰。
        const caller = exec?.agent?.id ?? exec?.agent?.session?.id
        if (caller !== undefined && caller !== childId) return undefined
        return EXIT_PLAN_MODE_DENIAL
      })
      if (typeof dispose === 'function') planGuards.set(childId, dispose)
      return true
    } catch (error) {
      onWarn(`dsh-orchestrator: 安装 exit_plan_mode guard 失败：${errorText(error)}`)
      return false
    }
  }

  /** 计划期的 guard 收口：一段 activation 结束就释放，续派/冷恢复按 agent/created 重新装。 */
  const releasePlanGuard = childId => {
    const dispose = planGuards.get(childId)
    if (dispose === undefined) return
    planGuards.delete(childId)
    try {
      dispose()
    } catch (error) {
      onWarn(`dsh-orchestrator: 释放 exit_plan_mode guard 失败：${errorText(error)}`)
    }
  }

  /** 任务终态/停止：guard + 计划登记一起收口（不再在后续 agent/created 里重新进入计划模式）。 */
  const releasePlan = childId => {
    planChildren.delete(childId)
    planModeWarned.delete(childId)
    planApplied.delete(childId)
    releasePlanGuard(childId)
    // S11：终态/stop 连「已批准待授予」的写入意图与幂等缓存一起删（别留下永远 switching 的幽灵行）。
    planWrite.delete(childId)
    clearSentCacheFor(childId)
  }
  // 激活返回时子 Session 可能还没进表：等一次 session/created 再设只读，不阻塞派发。
  const ensureModeReady = (childId, mode) => {
    const apply = session => ensureSandboxMode(childId, mode, session)
    if (childSessionOf(childId) !== undefined || typeof onSessionCreated !== 'function') {
      apply(childSessionOf(childId))
      return
    }
    const label = SANDBOX_LABEL[mode] ?? mode
    void resolveChildSession(childId).then(session => {
      if (session === undefined) {
        onWarn(`dsh-orchestrator: 未拿到子会话 ${childId}，${label}沙箱未设置`)
        return
      }
      apply(session)
    }).catch(error => onWarn(`dsh-orchestrator: 设置${label}沙箱失败：${errorText(error)}`))
  }
  const ensureReadOnlyReady = childId => ensureModeReady(childId, 'read-only')
  // activation 返回时子 Session 可能还没进会话表：挂一次 session/created 等同一个 childId；
  // 超时只 warn、不重试，也不阻塞派发。判同只看 id，不看 header.cwd（那正是坏的字段）。
  const resolveChildSession = childId => {
    const found = childSessionOf(childId)
    if (found !== undefined) return Promise.resolve(found)
    if (typeof onSessionCreated !== 'function') return Promise.resolve(undefined)
    return new Promise(resolveChild => {
      let done = false
      let unsubscribe
      let timer
      const finish = session => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { unsubscribe?.() } catch { /* 取消订阅失败不影响结果 */ }
        resolveChild(session)
      }
      timer = setTimeout(() => finish(undefined), sessionWaitMs)
      try {
        unsubscribe = onSessionCreated(event => {
          if (event?.id !== childId) return
          finish(childSessionOf(childId) ?? event)
        })
      } catch {
        finish(undefined)
      }
    })
  }
  /** 释放某个 targetId 名下**所有** Session 对象的全部可写根（含 resume 前后的多个对象）。 */
  const releaseWritableRoot = targetId => {
    const sessions = writableRootGrants.get(targetId)
    if (sessions === undefined) return
    writableRootGrants.delete(targetId)
    for (const dirs of sessions.values()) {
      for (const disposer of dirs.values()) {
        try {
          disposer()
        } catch (error) {
          onWarn(`dsh-orchestrator: 释放 target 可写根失败：${errorText(error)}`)
        }
      }
    }
  }
  // —— 写域判定（由 index.js 注入，走 write-gate 的同源判定）——
  const judgeWritableRoot = (taskId, directory) => {
    if (typeof writableRootJudge !== 'function') return undefined
    try {
      const verdict = writableRootJudge({ taskId, directory })
      if (verdict === undefined || verdict === null) return undefined
      return verdict
    } catch (error) {
      // 判定自身抛错只降级为 warn：不能因为护栏坏了就停掉全部派发。
      onWarn(`dsh-orchestrator: 写域判定失败（按放行处理）：${errorText(error)}`)
      return undefined
    }
  }
  const reportWriteDenied = (taskId, sessionId, directory, verdict) => {
    safeEvent('subagent.writable-root.denied', {
      taskId,
      sessionId: sessionId ?? null,
      detail: { directory: directory ?? null, code: verdict?.code ?? WRITE_DOMAIN_DENIED, reason: verdict?.text ?? null },
    })
  }
  const writeDomainError = text => {
    const error = new Error(typeof text === 'string' && text.trim() !== '' ? text : '写域被其他任务占用：稍后重试，或先关闭占用任务')
    error.code = WRITE_DOMAIN_DENIED
    return error
  }
  /** 判定被拒（spawn 前置 / send preflight）→ 返回错误对象；放行/无判定返回 undefined。 */
  const deniedChild = (taskId, directory, sessionId) => {
    const verdict = judgeWritableRoot(taskId, directory)
    if (verdict === undefined || verdict.ok === true) return undefined
    reportWriteDenied(taskId, sessionId, directory, verdict)
    return writeDomainError(verdict.text)
  }

  /**
   * 可写根授予的**唯一** chokepoint（S1：`registerWritableRoot` 全仓只在这里调用）。
   *
   * - 幂等 key = (childId 的登记表, Session 对象, 目录)：resume 换 Session 对象要重新注册，同一对象重复授予跳过；
   * - disposer 记进 `grantDirs`，stop/终态按 targetId 全量释放；
   * - 只返回结果、不抛：失败由调用方翻译成 switching / 文案。
   *
   * @returns {{ok:true, skipped?:string} | {ok:false, code:string, text?:string}}
   */
  const grantWritableRoot = (childId, session, target, taskId) => {
    const policy = serviceOf(sandboxPolicy)
    if (policy === undefined || typeof policy.registerWritableRoot !== 'function') return { ok: true, skipped: 'no-policy' }
    if (session === undefined || session === null) return { ok: false, code: 'WRITE_ROOT_NO_SESSION' }
    const dirs = grantDirs(childId, session)
    if (dirs.has(target)) return { ok: true, skipped: 'already-granted' }
    try {
      const disposer = policy.registerWritableRoot(session, target)
      if (typeof disposer === 'function') dirs.set(target, disposer)
      // 审计/对表用：sessionId + directory 都带上，能直接和 task_message 投递时间对齐。
      safeEvent('subagent.writable-root', { sessionId: childId, taskId, detail: { directory: target } })
      return { ok: true }
    } catch (error) {
      onWarn(`dsh-orchestrator: 登记 target 可写根失败：${errorText(error)}`)
      return { ok: false, code: 'WRITE_ROOT_FAILED', text: errorText(error) }
    }
  }

  /**
   * 已批准计划任务的授予（judge → append workspace-write → grant）。
   *
   * 原子化顺序：判定被拒时**不 append、不注册**；沙箱 append 成功但注册失败时，post-send 才做 read-only 补偿
   * （`compensateOnFailure:true`）；hook 内传 `false`——在 agent/created 的 serial 监听器里 append read-only
   * 会在投递前生效，等于把刚批的计划又锁回只读。
   *
   * 只返回结果、不抛；调用方（hook / post-send / retryPlanGrant）再决定状态。
   */
  const grantApprovedWrite = (childId, session, targetDir, taskId, { compensateOnFailure = false } = {}) => {
    if (session === undefined || session === null) return { ok: false, code: 'WRITE_ROOT_NO_SESSION' }
    const actual = typeof targetDir === 'string' && targetDir.trim() !== '' ? targetDir : session.header?.cwd
    if (typeof actual !== 'string' || actual.trim() === '') return { ok: true, skipped: 'no-target' }
    const denied = judgeWritableRoot(taskId, actual)
    if (denied !== undefined && denied.ok !== true) {
      reportWriteDenied(taskId, childId, actual, denied)
      return { ok: false, code: denied.code ?? WRITE_DOMAIN_DENIED, text: denied.text }
    }
    const policy = serviceOf(sandboxPolicy)
    const alreadyWritable = policy?.overrideOf?.(session) === 'workspace-write'
    // P0-1（审计 2026-11-23）：平台根 == target 只说明「不需要注册可写根」，**不等于**沙箱已经可写。
    // 计划任务批准前的沙箱是 read-only，所以 append 必须在这条捷径**之前**做——否则「批准了却写不了」
    // （无 target 的批准任务会继承父 cwd，正是这条路径）。下面平台根分支只跳过注册。
    if (!alreadyWritable) {
      if (typeof session.append !== 'function') return { ok: false, code: 'WRITE_SANDBOX_APPEND_FAILED', text: '会话没有 append' }
      try {
        session.append('sandbox/mode', { mode: 'workspace-write' })
        safeEvent('subagent.sandbox.resumed', { sessionId: childId, detail: { mode: 'workspace-write' } })
      } catch (error) {
        return { ok: false, code: 'WRITE_SANDBOX_APPEND_FAILED', text: errorText(error) }
      }
    }
    // 平台根已经是 target：沙箱已切好，但没有额外根要注册（注册同一个 cwd 是多余的，且某些实现会拒绝）。
    if (sameDirectory(actual, session.header?.cwd)) return { ok: true, sandbox: 'workspace-write', skipped: 'platform-root' }
    const granted = grantWritableRoot(childId, session, actual, taskId)
    if (granted.ok !== true) {
      if (compensateOnFailure) {
        // 尽力补偿：把沙箱退回只读，避免「判为切换失败但实际能写」的半吊子状态。
        ensureSandboxMode(childId, 'read-only', session)
      }
      safeEvent('subagent.plan-write.partial', {
        taskId,
        sessionId: childId,
        detail: { directory: actual, reason: granted.code ?? 'WRITE_ROOT_FAILED', compensated: compensateOnFailure === true },
      })
      return { ok: false, code: granted.code ?? 'WRITE_ROOT_FAILED', text: granted.text }
    }
    return { ok: true, sandbox: 'workspace-write' }
  }
  /** 授予包一层 catch：任何异常都翻成结果，绝不外抛（hook/post-send 都不许被它打断）。 */
  const tryGrant = (childId, session, targetDir, taskId, options) => {
    try {
      return grantApprovedWrite(childId, session, targetDir, taskId, options)
    } catch (error) {
      return { ok: false, code: 'WRITE_GRANT_THROWN', text: errorText(error) }
    }
  }

  // rc.3 平台缺陷：子会话 header.cwd 取父会话目录（childSessionMeta），spec.cwd 只记一条 working-directory 事件，
  // 而 sandboxPolicy 的 workspaceRoot 只读 session.header.cwd → workspace-write 下子会话写不进 target。
  // 兜法：给子会话登记 target 为可写根（幂等）。注意 Windows 上只对 harness 文件工具生效，pwsh 进程写仍会被拒。
  // wait=true 只用于派发（子 Session 可能晚几毫秒进表）；续派走非等待解析，避免冷恢复时干等超时。
  //
  // P0-2 chokepoint：授予之前再判一次写域（判定由 index.js 注入 `{taskId, directory} => {ok, code, text}`）；
  // 拒绝时**不注册**并记 `subagent.writable-root.denied`，把结果交回调用动作（spawn/send/pump）。
  //
  // phase（X12）：`spawn` 的 wait 允许 no-session（skipped，会话可能晚入表）；`post-send` 时 session 必已 resolve，
  // 拿不到就是**诚实失败**（事件 + 结果 ok:false），不再当成功。
  const ensureWritableRoot = async (childId, target, { wait = false, warnOnMiss = true, taskId, phase } = {}) => {
    if (typeof target !== 'string' || target === '') return { ok: true, skipped: 'no-target' }
    const policy = serviceOf(sandboxPolicy)
    if (policy === undefined || typeof policy.registerWritableRoot !== 'function') return { ok: true, skipped: 'no-policy' }
    const session = wait ? await resolveChildSession(childId) : childSessionOf(childId)
    if (session === undefined) {
      if (phase === 'post-send') {
        onWarn(`dsh-orchestrator: 续派已投递，但未拿到子会话 ${childId}，未登记 target 可写根（首回合可能是只读）`)
        safeEvent('subagent.writable-root.no-session', { taskId, sessionId: childId, phase: 'post-send' })
        return { ok: false, skipped: 'no-session', code: 'WRITE_ROOT_NO_SESSION' }
      }
      if (warnOnMiss) onWarn(`dsh-orchestrator: 未拿到子会话 ${childId}，未登记 target 可写根`)
      return { ok: true, skipped: 'no-session' }
    }
    // 平台根已经是 target 时不用授权；同一个 (session 对象, 目录) 只注册一次。
    if (sameDirectory(target, session.header?.cwd)) return { ok: true, skipped: 'platform-root' }
    const dirs = grantDirs(childId, session)
    if (dirs.has(target)) return { ok: true, skipped: 'already-granted' }
    const verdict = judgeWritableRoot(taskId, target)
    if (verdict !== undefined && verdict.ok !== true) {
      reportWriteDenied(taskId, childId, target, verdict)
      return { ok: false, denied: true, code: verdict.code ?? WRITE_DOMAIN_DENIED, text: verdict.text }
    }
    return grantWritableRoot(childId, session, target, taskId)
  }

  /**
   * 已批准计划任务的「重试授予」入口（X6/G10）：不投递、不写台账，只按当前 live Session 重试切可写。
   *
   * - 每次调用都先把 `planWrite` 重置成 `switching`：旧 `granted` 可能属于已被中止/换对象的 activation；
   * - 没有 live Session → 停在 `switching`（reason `retry-no-session`），返回 info（可再试）；
   * - 有 live Session → `tryGrant(compensate:true)`：成功 `granted`，失败 `switching` + 原因。
   */
  const retryPlanGrantImpl = (target, { taskId, targetDir, messageId } = {}) => {
    const existing = planWrite.get(target)
    const pending = {
      targetDir: targetDir ?? existing?.targetDir ?? '',
      taskId: taskId ?? existing?.taskId ?? null,
      state: 'switching',
      reason: 'retry',
      messageId: messageId ?? existing?.messageId ?? null,
      updatedAt: Date.now(),
    }
    planWrite.set(target, pending)
    trimDispatchCaches()
    let session
    try {
      session = childSessionOf(target)
    } catch {
      // 宿主代理读服务抛错只按「没有 live 会话」降级：重试授予是尽力而为，绝不能把批准/续派弄失败。
      session = undefined
    }
    if (session === undefined) {
      pending.reason = 'retry-no-session'
      return planWriteInfoOf(target)
    }
    const result = tryGrant(target, session, pending.targetDir, pending.taskId, { compensateOnFailure: true })
    if (result.ok === true) {
      pending.state = 'granted'
      pending.reason = result.skipped ?? null
    } else {
      pending.state = 'switching'
      pending.reason = result.code ?? 'grant-failed'
    }
    pending.updatedAt = Date.now()
    return planWriteInfoOf(target)
  }
  /** 计划写入意图的只读快照（task_detail/诊断用）；读失败按 unknown，绝不抛。 */
  const planWriteInfoOf = target => {
    try {
      const entry = planWrite.get(target)
      if (entry === undefined) return { state: 'unknown' }
      return {
        state: entry.state,
        reason: entry.reason ?? null,
        messageId: entry.messageId ?? null,
        targetDir: entry.targetDir ?? null,
        taskId: entry.taskId ?? null,
        updatedAt: entry.updatedAt ?? null,
      }
    } catch {
      return { state: 'unknown' }
    }
  }

  /**
   * 投递幂等重放时的「授予」（P0-3，审计 2026-11-23）。
   *
   * 旧行为：`messageId` / `attemptKey` 命中就无条件 `retryPlanGrant`，而它内部会 append `workspace-write`——
   * 只读任务 / 计划未批准的任务被重放一次就偷偷拿到可写沙箱，绕过了「批准前不切可写」。
   *
   * 现在的口径（只按调用方给的运行期事实分流，不新增持久化字段）：
   * - `readOnly === true`（只读任务，或计划任务未批准——调用方按 `plan-mode.dispatchReadOnly` 算）→ 什么都不做；
   * - 已登记过写入意图（即已批准计划任务的 planWrite 行）→ `retryPlanGrantImpl`（切可写 + 注册）；
   * - 其余（普通可写任务）→ 只幂等补注册可写根，**不 append 沙箱**（沙箱从派发起就是 workspace-write）。
   */
  const replayGrant = async (target, { taskId, targetDir, readOnly, messageId }) => {
    if (readOnly === true) return
    try {
      if (planWrite.has(target)) {
        retryPlanGrantImpl(target, { taskId, targetDir, messageId })
        return
      }
      const granted = await ensureWritableRoot(target, targetDir, { taskId, phase: 'post-send' })
      if (granted.ok !== true) {
        safeEvent('subagent.writable-root.post-send-failed', {
          taskId,
          sessionId: target,
          detail: { reason: granted.code ?? granted.skipped ?? null, text: granted.text ?? null, replay: true },
        })
      }
    } catch (error) {
      // 重放只补授予：补不上也不改「已投递」这个事实（调用方已按 attemptKey 幂等返回缓存 messageId）。
      onWarn(`dsh-orchestrator: 投递重放补授予失败（不影响已投递）：${errorText(error)}`)
    }
  }

  // agent/created 早于首个模型请求，能压掉「首回合还没设只读/可写」的窗口。
  //
  // 宿主事实（H1）：`agent/created` 是 cordis serial —— 逐条 await、不吞错；任一监听器 throw 都会让
  // `announce` reject → `submitMaterialized` 不执行 → **投递不发生**。所以我们的监听器：
  //   1) 整段 try/catch，绝不抛错；2) 所有分支返回 undefined（返回非 undefined 即 bail）；
  //   3) 绝不 append read-only（补偿只在 post-send 做）；4) 绝不删 planWrite（只改 state/reason）。
  // approved 分支必须放在 `sandboxModeFor` 与 `mode===undefined` 的提前 return **之前**：计划任务批准后
  // `planChildren` 已被 releasePlan 清掉，按沙箱表查就是 undefined，提前 return 会让 hook 永远不授予。
  if (typeof onAgentCreated === 'function') {
    try {
      onAgentCreated(created => {
        let pending
        try {
          if (created?.id === undefined) return undefined
          pending = planWrite.get(created.id)
          if (pending !== undefined && created.session !== undefined) {
            // 即使上一次已 granted 也对**当前 Session 对象**重做一次幂等授予：
            // 被其它 listener 抛错中止的 activation、或冷恢复换了 Session 后，旧 disposer 不再生效。
            const result = tryGrant(created.id, created.session, pending.targetDir, pending.taskId, { compensateOnFailure: false })
            pending.state = result.ok === true ? 'granted' : 'switching'
            pending.reason = result.ok === true ? (result.skipped ?? null) : (result.code ?? 'grant-failed')
            pending.updatedAt = Date.now()
          }
          const plan = planChildren.has(created.id)
          const mode = sandboxModeFor(created.id)
          if (mode === undefined) return undefined
          ensureSandboxMode(created.id, mode, created.session)
          if (!plan) return undefined
          installExitPlanGuard(created.id, created)
          const applied = applyPlanMode(created.id, true, created)
          safeEvent('subagent.plan-mode.entered', {
            sessionId: created.id,
            detail: { planMode: applied.outcome ?? null, reason: applied.ok === true ? null : (applied.reason ?? null) },
          })
        } catch (error) {
          // 只记录：外抛会 reject announce → 投递不发生。
          if (pending !== undefined) {
            pending.state = 'switching'
            pending.reason = 'hook-error'
            pending.updatedAt = Date.now()
          }
          onWarn(`dsh-orchestrator: approved 写权限提前授予失败（已降级 switching）：${errorText(error)}`)
        }
        return undefined
      })
    } catch (error) {
      onWarn(`dsh-orchestrator: 订阅 agent/created 失败：${errorText(error)}`)
    }
  }

  // 起过又必须收掉的子会话：登记表 + 本地的只读/计划/完整访问/普通标记一起清（别攒废弃 UUID）。
  const forgetChild = childId => {
    readOnlyChildren.delete(childId)
    fullAccessChildren.delete(childId)
    planChildren.delete(childId)
    defaultChildren.delete(childId)
    live.delete(childId)
  }

  // delivery: 'caller' 时没人 await 会变成未处理拒绝，这里必须挂上；同时把 settle 抛给上层驱动队列。
  // 回调里的异常（日志/事件消费方抛错）也不能变成宿主层面的未处理拒绝。
  // 注意：settle 只是这一轮结束（continuable 会话还会续派），**不释放**可写根；释放留给 stop/终态清理。
  const track = activation => {
    live.set(activation.childId, activation)
    activation.result.then(
      result => {
        try {
          live.delete(activation.childId)
          readOnlyChildren.delete(activation.childId)
          fullAccessChildren.delete(activation.childId)
          defaultChildren.delete(activation.childId)
          releasePlanGuard(activation.childId)
          onEvent('subagent.settled', {
            taskId: activation.taskId,
            sessionId: activation.childId,
            detail: { stopReason: result?.stopReason ?? null, output: settleOutput(result?.output) },
            // 非日志字段（logger 只取 detail）：完整返回消息交给结算上报器持久化（B1），
            // 超 64KB 由结算侧写 reports 文件，日志里仍只留 240 字摘要。
            lastMessage: messageText(result?.output),
          })
        } catch { /* 结算事件失败不能外溢 */ }
      },
      error => {
        try {
          live.delete(activation.childId)
          readOnlyChildren.delete(activation.childId)
          fullAccessChildren.delete(activation.childId)
          defaultChildren.delete(activation.childId)
          releasePlanGuard(activation.childId)
          onEvent('subagent.failed', {
            taskId: activation.taskId,
            sessionId: activation.childId,
            detail: { error: errorText(error) },
          })
        } catch { /* 结算事件失败不能外溢 */ }
      },
    ).catch(() => {})
    return activation
  }

  return {
    slug(title) {
      return slugify(title)
    },
    async spawn({ name, label, prompt, signal, taskId, cwd, readOnly, planFirst, access, goal }) {
      const parent = requireAgent()
      // agent 已创建但 session 还没挂上时，平台 startActivation 会在 parent.session 上取 .id 抛 TypeError；
      // 这里先给可读错误，并由 queue 当成可重试（等会话就绪）。
      if (parent?.session === undefined || parent.session === null) {
        throw new Error('协调者会话尚未就绪（agent.session 为空），稍后重试')
      }
      if (parent.id === undefined) throw new Error('协调者会话缺少 id，稍后重试')
      const childId = randomUUID()
      // 只读任务：在开始创建前记下 childId，agent/created 时立刻设沙箱；激活返回后再补一次幂等设置。
      if (readOnly === true) readOnlyChildren.add(childId)
      // 完整访问（access:'full'）：同一条注入路径换成 danger-full-access。只认显式 'full'。
      const fullAccess = access === 'full' && readOnly !== true && planFirst !== true
      if (fullAccess) fullAccessChildren.add(childId)
      // P8 计划任务：同一机制（只读沙箱是硬拦），另外在 agent 作用域置 plan mode + 装 exit guard。
      if (planFirst === true) planChildren.add(childId)
      // 普通任务：显式钉 workspace-write（主会话可能被钉成 read-only，宿主会把父会话覆盖种进来）。
      if (readOnly !== true && planFirst !== true && !fullAccess) defaultChildren.add(childId)
      // 目标目录优先；没给就沿用父会话 cwd（保持旧行为）。
      const baseCwd = cwd ?? parent.session?.header?.cwd
      const activationPrompt = [{ type: 'text', text: String(prompt ?? '') }]
      // 子会话显式用 worker 预设，绕开 composeFrom 继承协调者的 preset restrict（探针 §1）。
      // 只有 spawn provider 支持 agentPreset；fork 没有该能力，带上去会被平台拒绝（UNSUPPORTED_CAPABILITY）。
      const agentPreset = provider === 'spawn' ? { agentPreset: workerPreset ?? 'dsh-orchestrator-worker' } : {}
      const location = baseCwd === undefined ? {} : { cwd: baseCwd }
      const base = {
        provider,
        label: label ?? name ?? slugify(String(prompt ?? '').slice(0, 20)),
        delivery: 'caller',
        signal: signal ?? new AbortController().signal,
        childId,
      }
      // DSH 0.2.2-rc.3（当前桌面）的 startActivation 是扁平 spec：spec.parent/spec.prompt/…
      const spec = { ...base, parent, prompt: activationPrompt, ...agentPreset, ...location }
      // rc.1 及更早：旧平台读 spec.request.*，扁平字段会被忽略。
      const legacySpec = {
        ...base,
        request: { parent, prompt: activationPrompt, ...agentPreset, ...location },
      }
      const shapeError = error => /reading '(parent|request)'|spec\.(parent|request)|request\.parent/.test(error?.message ?? '')
      let activation
      // 写域 chokepoint：起子会话之前最后判一次（动作层 guard 是快速失败，这里才是唯一授予点）。
      // 拒绝 → 一个子会话都不起，直接把可读拒绝抛给 queue（走既有非可重试分支标 failed + 通知）。
      if (readOnly !== true && planFirst !== true) {
        const denied = deniedChild(taskId, cwd)
        if (denied !== undefined) throw denied
      }
      onEvent('subagent.spawn.requested', { taskId, detail: { childId, label: spec.label, provider } })
      try {
        try {
          activation = await subagents.startActivation(spec)
        } catch (error) {
          if (!shapeError(error)) throw error
          // 升级前的旧安装：扁平 spec 读不到 request.parent，回退一次旧包装。
          onEvent('subagent.spawn.legacy-spec', { taskId, detail: { childId, error: error?.message ?? String(error) } })
          activation = await subagents.startActivation(legacySpec)
        }
      } catch (error) {
        // 两次都失败：清掉只读/计划/完整访问/普通登记，别攒废弃 UUID。
        readOnlyChildren.delete(childId)
        fullAccessChildren.delete(childId)
        planChildren.delete(childId)
        defaultChildren.delete(childId)
        throw error
      }
      onEvent('subagent.spawn.accepted', {
        taskId,
        sessionId: activation.childId,
        detail: { childId: activation.childId, messageId: activation.messageId ?? null, provider },
      })
      // 结算事件带上 taskId：台账按任务精确回写，不依赖 session_id 反查。
      activation.taskId = taskId
      track(activation)
      if (readOnly === true) ensureReadOnlyReady(activation.childId)
      // 完整访问：同一入口（ensureModeReady），只读/计划优先，互斥由 tools 层在创建期就拦住。
      if (fullAccess) ensureModeReady(activation.childId, 'danger-full-access')
      // 普通任务：激活返回后再幂等补一次（agent/created 可能早于会话入表；已有同模式会跳过）。
      if (defaultChildren.has(activation.childId)) ensureModeReady(activation.childId, 'workspace-write')
      // P8：计划任务也走只读沙箱；plan mode 与 guard 尽量在激活返回时就装上，
      // agent 还没进表时由 agent/created 那条路补（不阻塞派发）。
      if (planFirst === true) {
        ensureReadOnlyReady(activation.childId)
        installExitPlanGuard(activation.childId)
        const applied = applyPlanMode(activation.childId, true)
        onEvent('subagent.plan-mode.entered', {
          sessionId: activation.childId,
          detail: { planMode: applied.outcome ?? null, reason: applied.ok === true ? null : (applied.reason ?? null) },
        })
      }
      // 目标目录才需要补可写根；只读任务绝不能注册可写根（否则「只读」有后门）。
      // 计划任务同理：批准前不注册，批准后的续派由 send() 按 readOnly=false 补。
      // 完整访问任务照旧注册（danger-full-access 下它用不上，只当注入失败时的兜底可写面）。
      if (readOnly !== true && planFirst !== true && typeof cwd === 'string' && cwd !== '') {
        const granted = await ensureWritableRoot(activation.childId, cwd, { wait: true, taskId, phase: 'spawn' })
        // 竞态兜底：判定在授予前又变了 → 尽力收掉刚起的子会话，再抛同一 code（不留白占并发位的孤儿）。
        if (granted.ok !== true && granted.denied === true) {
          try {
            await activation.dispose?.()
          } catch (error) {
            onWarn(`dsh-orchestrator: 写域被拒后收子会话失败：${errorText(error)}`)
          }
          forgetChild(activation.childId)
          throw writeDomainError(granted.text)
        }
        if (granted.ok !== true) onWarn(`dsh-orchestrator: 登记 target 可写根失败：${granted.text}`)
      }
      // G1：子会话起来后声明式建 goal（create + disarm，不驱动续轮）。
      // 不 await：goal 服务不可用/子 agent 晚出现都不能拖慢派发；桥内部吞错。
      if (goalBridge !== undefined && typeof goalBridge.attach === 'function' && typeof goal === 'string' && goal.trim() !== '') {
        void Promise.resolve(goalBridge.attach(taskId, activation.childId, goal)).catch(error => {
          onWarn(`dsh-orchestrator: 创建子会话目标失败：${errorText(error)}`)
        })
      }
      return { id: activation.childId, name: spec.label, sessionId: activation.childId, target: activation.childId }
    },
    // access 是尾部可选参数（新参数只追加不改位置：老调用方按位置传 readOnly/objective 不受影响）。
    // options（第 9 参，X5）：`{ planApproved?, messageId?, attemptKey? }`
    //   - planApproved：已批准计划任务的续派 → 先关 plan mode，再在 post-send 授予可写根；
    //   - messageId / attemptKey：同一逻辑投递的重放（跨重启靠 followup 行 meta.messageId）→ 只重试授予，不再投递。
    async send(target, message, signal, targetDir, taskId, readOnly, objective, access, options = {}) {
      const opts = options ?? {}
      // 0) 幂等：已有一条「同一次投递」的记录 → 只按运行期事实补授予并返回原 messageId，绝不二次 sendMessage。
      //    只读/计划未批准的任务在这里**不授予**（P0-3）：否则重放一次就能绕过「批准前不切可写」。
      if (typeof opts.messageId === 'string' && opts.messageId !== '') {
        await replayGrant(target, { taskId, targetDir, readOnly, messageId: opts.messageId })
        return opts.messageId
      }
      if (typeof opts.attemptKey === 'string' && opts.attemptKey !== '' && sentCache.has(opts.attemptKey)) {
        const messageId = sentCache.get(opts.attemptKey)
        await replayGrant(target, { taskId, targetDir, readOnly, messageId })
        return messageId
      }
      const parent = requireAgent()
      // 1) 投递前 preflight：写域判定被拒 → 消息**不外发**（投递之后注册失败只能 warn，无法回滚）。
      // 无 target 的任务按「父会话 cwd」归一：否则两条无 target 的任务会同时从同一个 cwd 写。
      if (readOnly !== true) {
        const denied = deniedChild(taskId, targetDir ?? parent.session?.header?.cwd, target)
        if (denied !== undefined) throw denied
      }
      const planApproved = opts.planApproved === true && readOnly !== true
      // 2) 已批准计划任务：先关 plan mode / 释放 guard，再把「写入意图」登记成 switching（等 post-send 授予）。
      //    顺序写死（v7）：必须在 planChildren 被删之前取 wasPlan，否则 planEvents 里永远没有 set(false)。
      //    失败只记事件/日志，**不阻断投递**（plan mode 是软引导；只读由 grant 决定）。
      if (planApproved) {
        try {
          const wasPlan = planChildren.has(target) || planApplied.has(target)
          if (wasPlan) {
            const applied = applyPlanMode(target, false)
            releasePlan(target) // 清 planChildren/planApplied/guard（也会清旧的 planWrite 行）
            safeEvent('subagent.plan-mode.approved', {
              sessionId: target,
              detail: { planMode: applied.outcome ?? null, reason: applied.ok === true ? null : (applied.reason ?? null) },
            })
          }
          planChildren.delete(target) // 防御性（releasePlan 已清）
          planWrite.set(target, {
            targetDir: targetDir ?? parent.session?.header?.cwd ?? '',
            taskId,
            state: 'switching',
            reason: 'pending',
            messageId: null,
            updatedAt: Date.now(),
          })
          trimDispatchCaches()
        } catch (error) {
          onWarn(`dsh-orchestrator: 续派前关 plan mode 失败（不影响投递）：${errorText(error)}`)
        }
      }
      // 3) 只有 sendMessage 失败才算「未投递」。
      const raw = await subagents.sendMessage(parent, target, [{ type: 'text', text: message }], {
        signal: signal ?? new AbortController().signal,
      })
      const messageId = normalizeMessageId(raw)
      // 4) post-send：消息已是事实。**从这里到 return 整段 try/catch，任何异常只 warn，绝不外抛**（option ①）。
      //    否则 action 层会把「已投递」当「失败」、sendReliable 还可能重发同一条消息。
      try {
        // 投递已经是事实：第一件事是把「已投递」告诉调用方（sendReliable 的已投递标记），
        // 之后任何记账/授予异常都不许让它变成「重发一次」。
        if (typeof opts.onDelivered === 'function') {
          try { opts.onDelivered(messageId) } catch { /* 标记回调失败不影响已投递 */ }
        }
        // 投递成功先记事件（代码顺序：投递 → 注册），日志时间序可自证「注册在投递之后」。
        safeEvent('task.message.sent', { taskId, sessionId: target, detail: { targetDir: targetDir ?? null } })
        if (typeof opts.attemptKey === 'string' && opts.attemptKey !== '' && messageId !== undefined) {
          sentCache.set(opts.attemptKey, messageId)
          trimDispatchCaches()
        }
        if (planApproved) {
          const pending = planWrite.get(target)
          if (pending !== undefined) pending.messageId = messageId ?? null
        }
        // 只读任务续派：resume 后按同一会话日志仍应保留 read-only；这里幂等补一次（已有则跳过）。
        if (readOnly === true) ensureReadOnly(target)
        // 完整访问续派同理（resume 出的新 Session 对象投影可能还没读回模式；已有则跳过）。
        if (access === 'full' && readOnly !== true) ensureModeReady(target, 'danger-full-access')
        // 冷恢复/续派时子会话在发送前还取不到，sendMessage 之后才 resolve 出**新的 Session 对象**；
        // 权威授予在这里（hook 只是尽力提前）：投递前的 preflight 已判过，这里失败只改 switching。
        if (readOnly !== true) {
          if (planApproved) {
            const session = childSessionOf(target)
            if (session === undefined) {
              markPlanSwitching(target, 'post-send-no-session')
              safeEvent('subagent.writable-root.no-session', { taskId, sessionId: target, phase: 'post-send' })
            } else {
              const granted = tryGrant(target, session, targetDir, taskId, { compensateOnFailure: true })
              const pending = planWrite.get(target)
              if (pending !== undefined) {
                pending.state = granted.ok === true ? 'granted' : 'switching'
                pending.reason = granted.ok === true ? (granted.skipped ?? null) : (granted.code ?? 'grant-failed')
                pending.updatedAt = Date.now()
              }
            }
          } else {
            const granted = await ensureWritableRoot(target, targetDir, { taskId, phase: 'post-send' })
            if (granted.ok !== true) {
              safeEvent('subagent.writable-root.post-send-failed', {
                taskId,
                sessionId: target,
                detail: { reason: granted.code ?? granted.skipped ?? null, text: granted.text ?? null },
              })
            }
          }
        }
        // G1：续派后目标文本可能变化 → edit（桥内部比较文本；agent 冷恢复晚出现时等一会儿）。
        if (goalBridge !== undefined && typeof goalBridge.update === 'function' && typeof objective === 'string' && objective.trim() !== '') {
          void Promise.resolve(goalBridge.update(taskId, target, objective)).catch(error => {
            onWarn(`dsh-orchestrator: 更新子会话目标失败：${errorText(error)}`)
          })
        }
      } catch (error) {
        onWarn(`dsh-orchestrator: 投递后记账/授予失败（不影响已投递）：${errorText(error)}`)
      }
      return messageId ?? raw
    },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly, objective, access, options = {}) {
      let lastError
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        // 已投递标记：由 send 在 `sendMessage` 成功的那一刻回调置位（投递是事实，之后任何异常都不许重发）。
        // 之前这里是「await send 之后才置位」，catch 里永远读到 false，等于没有保护。
        let delivered = false
        const attemptOptions = { ...(options ?? {}), onDelivered: () => { delivered = true } }
        try {
          const sent = await this.send(target, message, signal, targetDir, taskId, readOnly, objective, access, attemptOptions)
          delivered = true
          return sent
        } catch (error) {
          if (delivered) throw error
          lastError = error
          // 写域被拒是「等别人收尾」的确定结果，重试 3 次只会把拒绝文案糊成「投递失败」。
          if (error?.code === WRITE_DOMAIN_DENIED) throw error
          if (attempt < retryDelaysMs.length) {
            onWarn(`续派第 ${attempt + 1} 次投递失败：${error?.message ?? error}`)
            await sleep(retryDelaysMs[attempt])
          }
        }
      }
      throw new Error(`投递失败：${lastError?.message ?? lastError}`)
    },
    /**
     * 已批准计划任务的「重试授予」入口（`task_message({action:'approve'})` 在已 approved 时走这里）。
     * 不投递、不重写审计；底层按当前 live Session 重新判写域 + 切 workspace-write + 注册可写根。
     * 返回 `planWriteInfo`：`{state:'granted'|'switching', reason, messageId, ...}`。
     */
    retryPlanGrant(target, input = {}) {
      return retryPlanGrantImpl(target, input)
    },
    /** 计划写入意图的只读快照（task_detail/诊断）：`{state, reason, messageId, targetDir, taskId, updatedAt}`。 */
    planWriteInfo(target) {
      return planWriteInfoOf(target)
    },
    /** 有本地 activation 直接 dispose（提前取消）；没有（重启后）走 interrupt。两种都释放可写根。 */
    async stop(target, taskId) {
      try {
        const activation = live.get(target)
        if (activation !== undefined) {
          await activation.dispose()
          live.delete(target)
          return
        }
        // rc.3：interrupt(targetSessionId, authority)，authority 只认 { kind: 'ancestor' | 'user' }。
        // 工具层 stop（task_message action:stop）是用户动作，按平台 interruptByUser 的写法传 { kind: 'user' }；裸 agent 不在契约里。
        // rc.1：interruptByParent(childId, parentSessionId, mode)。
        if (typeof subagents.interrupt === 'function') return subagents.interrupt(target, { kind: 'user' })
        return subagents.interruptByParent(target, parentSessionId(), 'continuable')
      } finally {
        releaseWritableRoot(target)
        releasePlan(target)
        // 幂等缓存按 taskId 段清（stop 拿得到 taskId；releaseWritableRoots 只有 session，靠容量上限兜底）。
        clearSentCacheFor(taskId)
        // G1：停止 = 放弃该目标，清掉平台 goal（不留下「active」误导后续续派/面板）。
        if (goalBridge !== undefined && typeof goalBridge.clear === 'function') {
          void Promise.resolve(goalBridge.clear(taskId, target)).catch(error => {
            onWarn(`dsh-orchestrator: 清除子会话目标失败：${errorText(error)}`)
          })
        }
      }
    },
    /** 任务进入终态（done/cancelled/orphaned/failed）时由上层调用，释放该会话的可写根。 */
    releaseWritableRoots(target) {
      releaseWritableRoot(target)
      releasePlan(target)
    },
    members() {
      return listChildren(parentSessionId()).catch(error => {
        onWarn(`子会话目录读取失败：${errorText(error)}`)
        return []
      })
    },
    catalog() {
      return listChildren(parentSessionId())
    },
    has(target) {
      return live.has(target)
    },
  }
}

// 派发后端只剩 subagent：`backend` 键已随 P1-A 删除（P0-1 已删 team 实现），这里不再有分派。
export function createDispatcher({ subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs, onWarn = noop, onEvent = noop, agents, sessions, sandboxPolicy, onSessionCreated, onAgentCreated, sessionWaitMs, goalBridge, writableRootJudge }) {
  return createSubagentDispatcher({ subagents, agent, getAgent, provider, workerPreset, retryDelaysMs, onWarn, onEvent, agents, sessions, sandboxPolicy, onSessionCreated, onAgentCreated, sessionWaitMs, goalBridge, writableRootJudge })
}
