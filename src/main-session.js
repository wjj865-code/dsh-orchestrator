// 主会话：唯一协调者。创建/打开/重建/**切换协调者**都从这里走；不再由 task_create 自动绑定。
//
// 0.25.0（B' → 宿主自压 + 插件只提醒 + 手动 adopt）：
//   - 「主会话轮换」（超阈值自动归档旧会话、切到干净会话）**整套删除**；
//   - 会话可以并存多个，`settings.main_session_id` 仍然是「谁是协调者」的唯一指针；
//   - 换协调者只有两条路：①用户在会话头点「设为协调者」（adopt 一个已有会话）
//     ②压力提醒卡里选「新建协调者会话」（插件代建一个空白协调者会话再切过去）。
//     两条路都**只切指针**：旧会话不改名、不归档、不退役，用户随时可以回去看。
import { mkdir } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { getMainSessionId, getMainSessionPreset, setMainSessionId, setMainSessionPreset, setSetting } from './ledger.js'
import { onboardingKey } from './onboarding.js'

export const PRESET_ID = 'dsh-orchestrator-coordinator'
export const WORKER_PRESET_ID = 'dsh-orchestrator-worker'
export const MAIN_SESSION_HINT = '尚未打开主会话，请先从面板「打开主会话」。'

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
  db, config, agents, sessionController, workspaces, sessions, presetFor, selectPreset,
  workspacePath, workspaceName = '指挥舱', onOpened, now = () => Date.now(), log = () => {},
}) {
  // 服务既可以直接传对象（测试/同步场景），也可以传 getter（index 惰性取，等 cordis 服务就绪）。
  const resolveAgents = () => typeof agents === 'function' ? agents() : agents
  const resolveSessionController = () => typeof sessionController === 'function' ? sessionController() : sessionController
  const resolveWorkspaces = () => typeof workspaces === 'function' ? workspaces() : workspaces
  const resolveSessions = () => typeof sessions === 'function' ? sessions() : sessions
  // 刚创建/刚轮换出来的新会话在平台异步起 agent 之前不 live；这段时间里再点「打开主会话」不能再建一个
  // （openOnce 的「不 live 就新建」会把一次切换变成两次 + 一个空白残留）。窗口只拦这一条路，过期后照旧重建。
  const FRESH_MAIN_LOAD_GRACE_MS = 60_000
  let freshMain
  // 同一时刻只允许一次「换协调者」（adopt 与代建共用同一把锁）：进行中再点直接 busy。
  let mutating = false
  const liveAgent = id => resolveAgents()?.get?.(id)
  const currentId = () => config?.coordinatorSession ?? getMainSessionId(db)
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
   * 把已有会话设为协调者（会话头「设为协调者」/ 提醒卡）。
   *
   * 只切指针：不改名、不归档、不退役。校验（失败给可读 code，宿主路由渲染文案）：
   *   `ADOPT_NO_SESSION` 会话不存在/未加载；
   *   `ADOPT_NOT_COCKPIT` 不在「指挥舱」工作区；
   *   `ADOPT_NOT_LIVE` agent 还没起（先在该会话里发一条消息再试）；
   *   `ADOPT_PRESET_LOCKED` 已用其他预设开始（宿主拒绝中途换预设：请新建空白会话并选「协调者」）；
   *   `ADOPT_BUSY` 另一次切换正在进行。
   *
   * @returns {Promise<{ok:true, sessionId:string, previous:string|null, unchanged?:boolean}
   *   | {ok:false, code:string, params?:object}>}
   */
  const adoptSession = async ({ sessionId, source = 'panel' } = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'ADOPT_NO_SESSION' }
    const previous = currentId() ?? null
    if (sessionId === previous) return { ok: true, sessionId, previous, unchanged: true }
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
      try {
        setMainSessionId(db, sessionId)
        setMainSessionPreset(db, PRESET_ID)
      } catch (error) {
        return { ok: false, code: 'ADOPT_FAILED', params: { reason: `${error?.message ?? error}` } }
      }
      log('main.session.adopted', {
        previous,
        sessionId,
        source,
        preset,
      })
      return { ok: true, sessionId, previous }
    } finally {
      mutating = false
    }
  }

  /**
   * 代建一个空白协调者会话并切过去（压力提醒卡里「新建协调者会话」那一项）。
   *
   * 顺序：建工作区 → create → 切指针 → preset 标记 → onboarding=sent（跳过首次介绍/索引任务）
   * → 改名「主会话」→ 审计。**旧会话零处置**（不改名不归档）。
   * 失败处置：
   *   - create 失败：什么都没发生（不写指针），`ADOPT_CREATE_FAILED`；
   *   - 切指针失败：**新会话留着待重用**（不归档不删除——归档会把一个刚建好的空白会话藏进历史，
   *     而且平台归档对用户是「不可见」的副作用；留着它用户可以直接点开用它）。`ADOPT_FAILED`。
   * @returns {Promise<{ok:true, sessionId:string, previous:string|null, created:true}
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
      try {
        setMainSessionId(db, sessionId)
        setMainSessionPreset(db, createdPreset(created))
      } catch (error) {
        // 指针没切成功：新会话留着（可见、可点开），不归档；旧协调者原样可用。
        log('main.adopt.pointer-failed', {
          previous, newId: sessionId, error: `${error?.message ?? error}`, source,
        })
        return { ok: false, code: 'ADOPT_FAILED', params: { reason: `${error?.message ?? error}`, sessionId } }
      }
      // 以下都只降级：指针已切，新会话可用。
      try { setSetting(db, onboardingKey(sessionId), 'sent') } catch (error) {
        log('main.adopt.onboarding.failed', { newId: sessionId, error: `${error?.message ?? error}` })
      }
      try { await resolveSessionController()?.rename?.({ sessionId, title: '主会话' }) } catch (error) {
        log('main.adopt.rename.failed', { newId: sessionId, error: `${error?.message ?? error}` })
      }
      freshMain = { sessionId, at: now() }
      log('main.adopt.created', { previous, newId: sessionId, source })
      return { ok: true, sessionId, previous, created: true }
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
      notifyOpened({ sessionId: override, created: false }, agent)
      return { ok: true, sessionId: override, created: false }
    }
    if (spawnProvider !== 'spawn') {
      return { ok: false, error: `主会话的子任务需要 spawn provider（当前 spawnProvider=${spawnProvider}）：请把 spawnProvider 改回 spawn，或改用配置覆盖的会话` }
    }
    const id = getMainSessionId(db)
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
        notifyOpened({ sessionId: id, created: false }, live)
        return { ok: true, sessionId: id, created: false, agentPreset: PRESET_ID, presetMismatch: mismatch }
      }
      // 旧版主会话没有台账标记：能明确读到协调者预设就认领复用，否则重建一次。
      if (marker === undefined && preset === PRESET_ID) {
        setMainSessionPreset(db, PRESET_ID)
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
    // create 不接受 title；标题单独 rename，失败只记日志，不影响主会话可用。
    try {
      await engines.rename?.({ sessionId, title: '主会话' })
    } catch (error) {
      log('main.session.rename.failed', { sessionId, error: `${error?.message ?? error}` })
    }
    setSetting(db, onboardingKey(sessionId), 'pending')
    setMainSessionId(db, sessionId)
    setMainSessionPreset(db, createdPreset(created))
    log('main.session.created', { sessionId, agentPreset: created?.agentPreset ?? null })
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

  return { open, currentId, guardPreset, adoptSession, createCoordinatorSession, isMutating: () => mutating }
}
