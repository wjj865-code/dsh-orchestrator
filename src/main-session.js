// 主会话：协调者会话。创建/打开/重建/**加入协调者名单**/**退出名单**都从这里走；不再由 task_create 自动绑定。
//
// 0.25.0（B' → 宿主自压 + 插件只提醒 + 手动 adopt）：
//   - 「主会话轮换」（超阈值自动归档旧会话、切到干净会话）**整套删除**；
//   - 会话可以并存多个，`settings.main_session_id` 仍然是「谁是主协调者」的唯一指针；
//   - 换协调者只有两条路：①用户在会话头点「设为协调者」（adopt 一个已有会话）
//     ②压力提醒卡里选「新建协调者会话」（插件代建一个空白协调者会话再切过去）。
//     两条路都**只切指针**：旧会话不改名、不归档、不退役，用户随时可以回去看。
//
// 0.36.0（多协调者，用户 2026-11-26 拍板）：真源变成**有序名单** `settings.main_session_ids`
// （见 src/coordinator-set.js / ledger.js），`main_session_id` 只是首位的镜像。
//   - adopt = **加入名单并提升为主**（前插），旧协调者留在名单里（仍有任务入口/工具/权限）；
//   - `dropSession` = 退出名单（删首位则下一位升主；删光等价「尚未打开主会话」，下次 open 重建）；
//   - `open()` 只开/重建**主协调者**；首位失效重建时**原位替换**首位，名单长度不增长；
//   - 名单上限 4（`MAX_COORDINATORS` 常量，不进配置面），满员再 adopt → `ADOPT_LIMIT`；压力代建则淘汰最早成员腾位。
//
// C（2026-11-21，权限徽标一致性）：见 `MAIN_PERMISSION_PRESET`。协调者会话在三条路上钉只读——
// 新建（`open` 与 `createCoordinatorSession`）、adopt、以及每次「打开主会话」复用已有会话时把
// 用户手动切走的预设拉回。**每个名单成员都钉**（index.js 的 agent/created 也会对成员补钉）。
// 宿主没有「锁死权限选择器」的 API，能做的只有这个（如实写进 LIMITATIONS）。
import { mkdir } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import {
  addCoordinatorId, getCoordinatorIds, getMainSessionPreset, removeCoordinatorId,
  setCoordinatorIds, setMainSessionPreset, setSetting,
} from './ledger.js'
import { MAX_COORDINATORS } from './coordinator-set.js'
import { onboardingKey } from './onboarding.js'

export const PRESET_ID = 'dsh-orchestrator-coordinator'
export const WORKER_PRESET_ID = 'dsh-orchestrator-worker'
export const MAIN_SESSION_HINT = '尚未打开主会话，请先从面板「打开主会话」。'
// C（主会话权限徽标一致性）：协调者会话的权限预设钉成宿主的出厂只读预设
// （`read-only` = 沙箱 read-only + 审批 ask）。理由：协调者预设里没有 read/write/bash，
// 而宿主给新会话的默认预设是 `workspace-write`，输入区徽标就显示「工作区写入」——徽标说能写、
// 实际写不了。钉成只读后徽标与实际工具面一致。**只写协调者会话**，普通任务子会话照旧
// workspace-write（`src/dispatch.js` 显式钉，父会话覆盖会被宿主种进子会话）。
export const MAIN_PERMISSION_PRESET = 'read-only'

/** 路径等价判断：同一目录（Windows 大小写不敏感）。adopt 只接受「指挥舱」工作区里的会话。 */
const sameDir = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.trim() === '' || right.trim() === '') return false
  try {
    const a = resolvePath(left).replace(/[\\/]+$/, '').toLowerCase()
    const b = resolvePath(right).replace(/[\\/]+$/, '').toLowerCase()
    return a === b
  } catch {
    return false
  }
}

export function createMainSession({
  db, config, agents, sessionController, workspaces, sessions, presetFor, selectPreset, permissionPresets,
  workspacePath, workspaceName = '指挥舱', onOpened, now = () => Date.now(), log = () => {},
}) {
  // 服务既可以直接传对象（测试/同步场景），也可以传 getter（index 惰性取，等 cordis 服务就绪）。
  const resolveAgents = () => typeof agents === 'function' ? agents() : agents
  const resolveSessionController = () => typeof sessionController === 'function' ? sessionController() : sessionController
  const resolveWorkspaces = () => typeof workspaces === 'function' ? workspaces() : workspaces
  const resolveSessions = () => typeof sessions === 'function' ? sessions() : sessions
  // 宿主 `ctx.permissionPresets`（权限预设服务）。老宿主/裁剪过的 profile 可能没有 → 整段降级为「不动权限」。
  const resolvePermissionPresets = () => typeof permissionPresets === 'function' ? permissionPresets() : permissionPresets
  // 刚创建/刚轮换出来的新会话在平台异步起 agent 之前不 live；这段时间里再点「打开主会话」不能再建一个
  // （openOnce 的「不 live 就新建」会把一次切换变成两次 + 一个空白残留）。窗口只拦这一条路，过期后照旧重建。
  const FRESH_MAIN_LOAD_GRACE_MS = 60_000
  let freshMain
  // 同一时刻只允许一次「换协调者」（adopt 与代建共用同一把锁）：进行中再点直接 busy。
  let mutating = false
  const liveAgent = id => resolveAgents()?.get?.(id)
  // 名单：配置 `coordinatorSession`（运维兜底）覆盖成单元素；否则读台账名单（首位 = 主协调者）。
  // 统一走 getCoordinatorIds，保证这里永远是数组（配置通道是字符串，直接拿会漏掉 .filter/.length 语义）。
  const currentIds = () => getCoordinatorIds(db, config?.coordinatorSession)
  const currentId = () => currentIds()[0]
  // worker 预设只认 spawn provider（fork 不满足 capabilities.agentPreset）；不静默降级、不改用户配置。
  const spawnProvider = config?.spawnProvider ?? 'spawn'

  // 读 live agent 实际跑的预设：优先 agentPresets.presetForSession，退到 session.header.agentPreset。
  // 读不到一律视为「不是协调者预设」——旧版建的主会话没有预设，必须重建而不是一直复用。
  const sessionPreset = agent => {
    try {
      const value = typeof presetFor === 'function' ? presetFor(agent) : undefined
      if (typeof value === 'string' && value !== '') return value
    } catch { /* 读不到就当未知 */ }
    const header = agent?.session?.header
    return typeof header?.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined
  }

  // UI 打开空白会话时可能把预设 rebind 成 default（standard）；平台允许空白会话重绑，
  // 这里在复用前/agent 创建时拉回协调者预设，非空白会话会抛 locked，交给 guard 兜底。
  const guardPreset = async agent => {
    if (agent === undefined) return false
    const current = sessionPreset(agent)
    if (current === PRESET_ID) return true
    if (typeof selectPreset !== 'function') return false
    try {
      await selectPreset(agent, PRESET_ID)
      log('main.session.preset-restored', { sessionId: agent.id, from: current ?? null })
      return true
    } catch (error) {
      const reason = error?.message ?? String(error)
      if (/locked|already started/i.test(reason)) {
        log('main.session.preset-locked', { sessionId: agent.id, from: current ?? null })
        return false
      }
      log('main.session.preset-restore-failed', { sessionId: agent.id, from: current ?? null, error: reason })
      return false
    }
  }

  const ensureWorkspace = async () => {
    const services = resolveWorkspaces()
    if (services === undefined) return undefined
    // 工作区 API 是位置参数：create(path, title?)；目录必须先存在。
    // 注意 resolveByPath 是 async（内部 realpath，目录不存在会 reject ENOENT），必须 await 才能接住。
    let found
    try { found = await services.resolveByPath?.(workspacePath) } catch { found = undefined }
    if (found !== undefined) return found.id
    await mkdir(workspacePath, { recursive: true })
    const created = await services.create?.(workspacePath, workspaceName)
    return created?.id
  }

  const createdPreset = created =>
    typeof created?.agentPreset === 'string' && created.agentPreset !== '' ? created.agentPreset : PRESET_ID

  /** 会话记录（用于 adopt 校验 cwd/预设）：优先 live agent，退 `sessions.get`。 */
  const sessionOf = (sessionId, agent) => {
    if (agent?.session !== undefined) return agent.session
    try {
      return resolveSessions()?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * 把协调者会话的权限预设钉成只读（C：徽标 = 实际工具面）。
   *
   * 写路径只有宿主公开的 `permissionPresets.set(session, 'read-only')`：它追加
   * `permission/preset` + `sandbox/mode` + `approval/policy` 三条会话事件，`permissions` 投影
   * （= 输入区徽标的数据源）跟着变。已经就是只读时什么都不追加（宿主 set 自己也幂等）。
   *
   * 覆盖：新建（open / 代建）、adopt、复用已有主会话时的漂移拉回。失败只记日志，**绝不挡打开主会话**；
   * 宿主没有 permissionPresets 服务（老宿主/裁剪 profile）时整段降级为「不动权限」、不报错。
   * @param {string} sessionId - 目标会话 id（找不到会话对象时只记日志）。
   * @param {object} [sessionHint] - 已知的 Session 对象（adopt/agent/created 路径直接给，省一次查找）。
   * @returns {'pinned'|'unchanged'|'unavailable'|'failed'}
   */
  const pinPermission = (sessionId, sessionHint) => {
    const presets = resolvePermissionPresets()
    if (typeof presets?.set !== 'function') return 'unavailable'
    const session = sessionHint ?? liveAgent(sessionId)?.session ?? sessionOf(sessionId)
    if (session === undefined) return 'unavailable'
    let current
    try { current = presets.current?.(session) } catch { current = undefined }
    if (current === MAIN_PERMISSION_PRESET) return 'unchanged'
    try {
      presets.set(session, MAIN_PERMISSION_PRESET)
    } catch (error) {
      log('main.session.permission-pin-failed', {
        sessionId, from: current ?? null, preset: MAIN_PERMISSION_PRESET, error: `${error?.message ?? error}`,
      })
      return 'failed'
    }
    log('main.session.permission-pinned', { sessionId, from: current ?? null, preset: MAIN_PERMISSION_PRESET })
    return 'pinned'
  }

  /**
   * 把已有会话设为协调者（会话头「设为协调者」/ 提醒卡）。
   *
   * 0.36.0：**加入名单并提升为主**（不再替换指针）——旧协调者留在名单里，仍有任务入口与工具权限。
   * 不改名、不归档、不退役。校验（失败给可读 code，宿主路由渲染文案）：
   *   `ADOPT_NO_SESSION` 会话不存在/未加载；
   *   `ADOPT_NOT_COCKPIT` 不在「指挥舱」工作区；
   *   `ADOPT_NOT_LIVE` agent 还没起（先在该会话里发一条消息再试）；
   *   `ADOPT_PRESET_LOCKED` 已用其他预设开始（宿主拒绝中途换预设：请新建空白会话并选「协调者」）；
   *   `ADOPT_LIMIT` 名单已满（4 个），先让某个会话「退出协调者」；
   *   `ADOPT_BUSY` 另一次切换正在进行。
   *
   * @returns {Promise<{ok:true, sessionId:string, previous:string|null, ids:string[], primary:string,
   *   added:boolean, promoted:boolean, unchanged?:boolean} | {ok:false, code:string, params?:object}>}
   */
  const adoptSession = async ({ sessionId, source = 'panel' } = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'ADOPT_NO_SESSION' }
    const previous = currentId() ?? null
    // 已经是主协调者：什么都不用做（不再重复写台账、不再钉权限）。
    if (sessionId === previous) return { ok: true, sessionId, previous, unchanged: true, ids: currentIds() }
    if (mutating) return { ok: false, code: 'ADOPT_BUSY' }
    mutating = true
    try {
      const agent = liveAgent(sessionId)
      const session = sessionOf(sessionId, agent)
      if (session === undefined) return { ok: false, code: 'ADOPT_NO_SESSION' }
      const cwd = session?.header?.cwd
      if (!sameDir(cwd, workspacePath)) {
        return { ok: false, code: 'ADOPT_NOT_COCKPIT', params: { cwd: cwd ?? '未知', workspace: workspacePath } }
      }
      if (agent === undefined) return { ok: false, code: 'ADOPT_NOT_LIVE' }
      let preset = sessionPreset(agent) ?? (typeof session?.header?.agentPreset === 'string' ? session.header.agentPreset : undefined)
      if (preset !== PRESET_ID) {
        if (typeof selectPreset !== 'function') return { ok: false, code: 'ADOPT_PRESET_LOCKED', params: { preset: preset ?? '未知' } }
        try {
          await selectPreset(agent, PRESET_ID)
          preset = PRESET_ID
        } catch (error) {
          return {
            ok: false,
            code: 'ADOPT_PRESET_LOCKED',
            params: { preset: preset ?? '未知', reason: `${error?.message ?? error}` },
          }
        }
      }
      let outcome
      try {
        outcome = addCoordinatorId(db, sessionId)
        if (outcome.limitReached === true) {
          return { ok: false, code: 'ADOPT_LIMIT', params: { max: MAX_COORDINATORS } }
        }
        setMainSessionPreset(db, PRESET_ID)
      } catch (error) {
        return { ok: false, code: 'ADOPT_FAILED', params: { reason: `${error?.message ?? error}` } }
      }
      // C：adopt 进来的会话也钉只读（用户选的会话可能带着 workspace-write/full 的旧权限）。
      const permission = pinPermission(sessionId, agent.session)
      log('main.session.adopted', {
        previous,
        sessionId,
        source,
        preset,
        permission,
        ids: outcome.ids,
        added: outcome.added,
        promoted: outcome.promoted,
      })
      return {
        ok: true,
        sessionId,
        previous,
        ids: outcome.ids,
        primary: outcome.ids[0],
        added: outcome.added,
        promoted: outcome.promoted,
      }
    } finally {
      mutating = false
    }
  }

  /**
   * 让一个会话退出协调者名单（会话头/面板「本会话退出协调者」）。
   *
   * 只改名单：不改名、不归档、不回滚权限（它仍是只读会话）。删首位 → 下一位升主；
   * 删光 → 两个 settings 键都清掉，等价回到「尚未打开主会话」，下一次打开会重建。
   * @returns {Promise<{ok:true, sessionId:string, ids:string[], primary:string|null, primaryChanged:boolean}
   *   | {ok:false, code:string, params?:object}>}
   */
  const dropSession = async ({ sessionId, source = 'panel' } = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'DROP_NO_SESSION' }
    if (mutating) return { ok: false, code: 'ADOPT_BUSY' }
    mutating = true
    try {
      let outcome
      try {
        outcome = removeCoordinatorId(db, sessionId)
      } catch (error) {
        return { ok: false, code: 'DROP_FAILED', params: { reason: `${error?.message ?? error}` } }
      }
      if (outcome.dropped !== true) return { ok: false, code: 'DROP_NOT_FOUND' }
      if (freshMain !== undefined && freshMain.sessionId === sessionId) freshMain = undefined
      log('main.session.dropped', {
        sessionId,
        source,
        ids: outcome.ids,
        primaryChanged: outcome.primaryChanged,
      })
      return {
        ok: true,
        sessionId,
        ids: outcome.ids,
        primary: outcome.ids[0] ?? null,
        primaryChanged: outcome.primaryChanged,
      }
    } finally {
      mutating = false
    }
  }

  /**
   * 代建一个空白协调者会话并**加入名单、提升为主**（压力提醒卡里「新建协调者会话」那一项）。
   *
   * 顺序：建工作区 → create → 写名单（前插；满 4 个时淘汰最早成员腾位）→ preset 标记 → onboarding=sent（跳过首次介绍/索引任务）
   * → 改名「主会话」→ 审计。**旧会话零处置**（留在名单里，不改名不归档）。
   * 名单已满时**让最早加入的成员退出协调者腾位**（会话保留、不改名不归档），保证压力换新不会被
   * `ADOPT_LIMIT` 卡住；旧主协调者仍留在名单里。
   * 失败处置：
   *   - create 失败：什么都没发生（不写名单），`ADOPT_CREATE_FAILED`；
   *   - 写名单失败：**新会话留着待重用**（不归档不删除——归档会把一个刚建好的空白会话藏进历史，
   *     而且平台归档对用户是「不可见」的副作用；留着它用户可以直接点开用它）。`ADOPT_FAILED`。
   * @returns {Promise<{ok:true, sessionId:string, previous:string|null, ids:string[], primary:string, created:true,
   *   evicted:string|null}
   *   | {ok:false, code:string, params?:object}>}
   */
  const createCoordinatorSession = async ({ source = 'pressure-reminder' } = {}) => {
    if (mutating) return { ok: false, code: 'ADOPT_BUSY' }
    mutating = true
    const previous = currentId() ?? null
    try {
      const engine = resolveSessionController()
      if (engine?.create === undefined) return { ok: false, code: 'ADOPT_CREATE_FAILED', params: { reason: '缺少 sessionController 服务（平台尚未就绪）' } }
      let workspaceId
      try {
        workspaceId = await ensureWorkspace()
      } catch (error) {
        return { ok: false, code: 'ADOPT_CREATE_FAILED', params: { reason: `指挥舱工作区不可用：${error?.message ?? error}` } }
      }
      let created
      try {
        created = await engine.create({ workspaceId, agentPreset: PRESET_ID })
      } catch (error) {
        log('main.adopt.create-failed', { previous, error: `${error?.message ?? error}`, source })
        return { ok: false, code: 'ADOPT_CREATE_FAILED', params: { reason: `${error?.message ?? error}` } }
      }
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        log('main.adopt.create-failed', { previous, reason: 'no-session-id', source })
        return { ok: false, code: 'ADOPT_CREATE_FAILED', params: { reason: '创建协作者会话没有返回 sessionId' } }
      }
      let outcome
      let evicted
      try {
        // 压力换新必须成功：名单满 4 个时让最早加入的成员退出（会话保留，不改名不归档），
        // 而不是把用户卡在 ADOPT_LIMIT。旧主协调者仍留在名单里。
        const current = currentIds().filter(id => id !== sessionId)
        evicted = current.length >= MAX_COORDINATORS ? current[current.length - 1] : undefined
        const ids = setCoordinatorIds(db, [sessionId, ...current].slice(0, MAX_COORDINATORS))
        outcome = { ids, added: true, promoted: false, unchanged: false, limitReached: false }
        setMainSessionPreset(db, createdPreset(created))
      } catch (error) {
        // 名单没写成功：新会话留着（可见、可点开），不归档；旧协调者原样可用。
        log('main.adopt.pointer-failed', {
          previous, newId: sessionId, error: `${error?.message ?? error}`, source,
        })
        return { ok: false, code: 'ADOPT_FAILED', params: { reason: `${error?.message ?? error}`, sessionId } }
      }
      // 以下都只降级：名单已加，新会话可用。
      // C：新建的协调者会话同样钉只读（顺序放在写名单之后：写名单失败时它还不是协调者）。
      const permission = pinPermission(sessionId)
      try { setSetting(db, onboardingKey(sessionId), 'sent') } catch (error) {
        log('main.adopt.onboarding.failed', { newId: sessionId, error: `${error?.message ?? error}` })
      }
      try { await resolveSessionController()?.rename?.({ sessionId, title: '主会话' }) } catch (error) {
        log('main.adopt.rename.failed', { newId: sessionId, error: `${error?.message ?? error}` })
      }
      freshMain = { sessionId, at: now() }
      log('main.adopt.created', {
        previous, newId: sessionId, source, permission, ids: outcome.ids, evicted: evicted ?? null,
      })
      return {
        ok: true, sessionId, previous, ids: outcome.ids, primary: outcome.ids[0], created: true, evicted: evicted ?? null,
      }
    } finally {
      mutating = false
    }
  }

  /**
   * 打开成功后的旁路回调（观测/提醒）：绝不 await，失败也不影响打开结果。
   *
   * **契约**（真机验证发现过一次断链）：`onOpened` 收到的 `result` 必须与 `open()` 的返回值同形
   * ——`{ ok: true, sessionId, created }`。消费方（index.js 的上下文压力观测）只在
   * `result.ok === true` 时做事；早先这里直接回传调用点的轻量描述（没有 `ok`），
   * 结果「压力提醒」整条链在真机上永远不触发（单测因为各自只测一半而全绿）。
   */
  const notifyOpened = (result, agent) => {
    if (typeof onOpened !== 'function') return
    const opened = { ok: true, ...result }
    try {
      void Promise.resolve(onOpened({ result: opened, agent })).catch(() => { /* 观测失败不影响打开 */ })
    } catch { /* 同步抛错同样吞掉 */ }
  }

  const openOnce = async () => {
    const override = config?.coordinatorSession
    if (override !== undefined) {
      const agent = liveAgent(override)
      if (agent === undefined) return { ok: false, error: `配置的协调者会话 ${override} 当前未加载` }
      // C：配置覆盖的会话也是协调者，权限同样钉只读（服务缺失时静默降级）。
      pinPermission(override, agent.session)
      notifyOpened({ sessionId: override, created: false }, agent)
      return { ok: true, sessionId: override, created: false }
    }
    if (spawnProvider !== 'spawn') {
      return { ok: false, error: `主会话的子任务需要 spawn provider（当前 spawnProvider=${spawnProvider}）：请把 spawnProvider 改回 spawn，或改用配置覆盖的会话` }
    }
    const ids = getCoordinatorIds(db)
    const id = ids[0]
    const live = id === undefined ? undefined : liveAgent(id)
    // 刚创建出来的新会话还没 live（平台异步起 agent）：别再建一个，直接把同一个 id 交回去。
    if (live === undefined && id !== undefined && freshMain !== undefined
      && freshMain.sessionId === id && now() - freshMain.at < FRESH_MAIN_LOAD_GRACE_MS) {
      return { ok: true, sessionId: id, created: true, loading: true, agentPreset: getMainSessionPreset(db) }
    }
    if (live !== undefined) {
      const marker = getMainSessionPreset(db)
      const preset = sessionPreset(live)
      // 台账为准：我们创建时记过协调者预设就复用，不再因读回漂移而重建（重建会换 id、通知漂移）。
      if (marker === PRESET_ID) {
        const mismatch = preset !== undefined && preset !== PRESET_ID
        if (mismatch) {
          log('main.session.preset-mismatch', {
            sessionId: id,
            marker,
            preset,
            header: live.session?.header?.agentPreset ?? null,
          })
          await guardPreset(live)
        }
        // C：复用已有主会话时把用户手动切走的权限预设拉回只读（宿主的 agent 预设锁不覆盖权限选择器）。
        const permission = pinPermission(id, live.session)
        notifyOpened({ sessionId: id, created: false }, live)
        return {
          ok: true,
          sessionId: id,
          created: false,
          agentPreset: PRESET_ID,
          presetMismatch: mismatch,
          ...(permission === 'pinned' ? { permissionRestored: true } : {}),
        }
      }
      // 旧版主会话没有台账标记：能明确读到协调者预设就认领复用，否则重建一次。
      if (marker === undefined && preset === PRESET_ID) {
        setMainSessionPreset(db, PRESET_ID)
        pinPermission(id, live.session)
        log('main.session.preset-adopted', { sessionId: id, preset })
        notifyOpened({ sessionId: id, created: false }, live)
        return { ok: true, sessionId: id, created: false, agentPreset: PRESET_ID, presetMismatch: false }
      }
      log('main.session.recreate', {
        sessionId: id,
        reason: marker === undefined ? (preset === undefined ? 'preset-unknown' : 'preset-mismatch') : 'marker-mismatch',
        marker: marker ?? null,
        preset: preset ?? null,
      })
    }
    const engines = resolveSessionController()
    if (engines?.create === undefined) return { ok: false, error: '创建主会话失败：缺少 sessionController 服务（平台尚未就绪）' }
    let workspaceId
    try { workspaceId = await ensureWorkspace() } catch (error) {
      return { ok: false, error: `指挥舱工作区不可用：${error?.message ?? error}` }
    }
    let created
    try {
      created = await engines.create({ workspaceId, agentPreset: PRESET_ID })
    } catch (error) {
      return { ok: false, error: `创建主会话失败：${error?.message ?? error}` }
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '创建主会话失败：没有返回 sessionId' }
    // C：新建主会话第一件事就是把权限钉只读（徽标从第一条投影起就是 read-only，不会先闪一下
    // workspace-write）；失败只记日志，不影响打开。
    const permission = pinPermission(sessionId)
    // create 不接受 title；标题单独 rename，失败只记日志，不影响主会话可用。
    try {
      await engines.rename?.({ sessionId, title: '主会话' })
    } catch (error) {
      log('main.session.rename.failed', { sessionId, error: `${error?.message ?? error}` })
    }
    setSetting(db, onboardingKey(sessionId), 'pending')
    // 0.36.0：写名单——首位是本次新建的主协调者；**其余成员原位保留**（重建不增长名单）。
    // 之前没有名单（首次打开）→ 只有它一个。
    setCoordinatorIds(db, [sessionId, ...ids.slice(1)])
    setMainSessionPreset(db, createdPreset(created))
    log('main.session.created', {
      sessionId,
      agentPreset: created?.agentPreset ?? null,
      permission,
      replaced: id ?? null,
      ids: [sessionId, ...ids.slice(1)],
    })
    notifyOpened({ sessionId, created: true }, undefined)
    return { ok: true, sessionId, created: true, agentPreset: created?.agentPreset }
  }

  // 并发点击/路由重复调用只建一次：后来者 await 同一个 in-flight Promise。
  // finally 里清掉（失败也清），否则一次创建失败会让后续点击永久复用失败结果。
  // catch 兜底：open() 对调用方永不 reject（宿主把未处理拒绝当 fatal load failure）。
  let opening
  const open = () => {
    if (opening !== undefined) return opening
    opening = Promise.resolve()
      .then(openOnce)
      .catch(error => ({ ok: false, error: `打开主会话失败：${error?.message ?? error}` }))
      .finally(() => { opening = undefined })
    return opening
  }

  return {
    open, currentId, currentIds, guardPreset, pinPermission, adoptSession, dropSession,
    createCoordinatorSession, isMutating: () => mutating,
  }
}
