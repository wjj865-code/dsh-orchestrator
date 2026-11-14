// 主会话：唯一协调者。创建/打开/重建都从这里走；不再由 task_create 自动绑定。
import { mkdir } from 'node:fs/promises'
import { getMainSessionId, getMainSessionPreset, setMainSessionId, setMainSessionPreset } from './ledger.js'

export const PRESET_ID = 'dsh-orchestrator-coordinator'
export const WORKER_PRESET_ID = 'dsh-orchestrator-worker'
export const MAIN_SESSION_HINT = '尚未打开主会话，请先从面板「打开主会话」。'

export function createMainSession({ db, config, agents, sessionController, workspaces, presetFor, selectPreset, workspacePath, workspaceName = '指挥舱', log = () => {} }) {
  // 服务既可以直接传对象（测试/同步场景），也可以传 getter（index 惰性取，等 cordis 服务就绪）。
  const resolveAgents = () => typeof agents === 'function' ? agents() : agents
  const resolveSessionController = () => typeof sessionController === 'function' ? sessionController() : sessionController
  const resolveWorkspaces = () => typeof workspaces === 'function' ? workspaces() : workspaces
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
    const select = typeof selectPreset === 'function' ? selectPreset(agent, PRESET_ID) : undefined
    try {
      await select
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

  const openOnce = async () => {
    const override = config?.coordinatorSession
    if (override !== undefined) {
      if (liveAgent(override) === undefined) return { ok: false, error: `配置的协调者会话 ${override} 当前未加载` }
      return { ok: true, sessionId: override, created: false }
    }
    if (spawnProvider !== 'spawn') {
      return { ok: false, error: `主会话的子任务需要 spawn provider（当前 spawnProvider=${spawnProvider}）：请把 spawnProvider 改回 spawn，或改用配置覆盖的会话` }
    }
    const id = getMainSessionId(db)
    const live = id === undefined ? undefined : liveAgent(id)
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
        return { ok: true, sessionId: id, created: false, agentPreset: PRESET_ID, presetMismatch: mismatch }
      }
      // 旧版主会话没有台账标记：能明确读到协调者预设就认领复用，否则重建一次。
      if (marker === undefined && preset === PRESET_ID) {
        setMainSessionPreset(db, PRESET_ID)
        log('main.session.preset-adopted', { sessionId: id, preset })
        return { ok: true, sessionId: id, created: false, agentPreset: PRESET_ID, presetMismatch: false }
      }
      log('main.session.recreate', {
        sessionId: id,
        reason: marker === undefined ? (preset === undefined ? 'preset-unknown' : 'preset-mismatch') : 'marker-mismatch',
        marker: marker ?? null,
        preset: preset ?? null,
      })
    }
    const sessions = resolveSessionController()
    if (sessions?.create === undefined) return { ok: false, error: '创建主会话失败：缺少 sessionController 服务（平台尚未就绪）' }
    let workspaceId
    try { workspaceId = await ensureWorkspace() } catch (error) {
      return { ok: false, error: `指挥舱工作区不可用：${error?.message ?? error}` }
    }
    let created
    try {
      created = await sessions.create({ workspaceId, agentPreset: PRESET_ID })
    } catch (error) {
      return { ok: false, error: `创建主会话失败：${error?.message ?? error}` }
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '创建主会话失败：没有返回 sessionId' }
    // create 不接受 title；标题单独 rename，失败只记日志，不影响主会话可用。
    try {
      await sessions.rename?.({ sessionId, title: '主会话' })
    } catch (error) {
      log('main.session.rename.failed', { sessionId, error: `${error?.message ?? error}` })
    }
    setMainSessionId(db, sessionId)
    setMainSessionPreset(db, typeof created?.agentPreset === 'string' && created.agentPreset !== '' ? created.agentPreset : PRESET_ID)
    log('main.session.created', { sessionId, agentPreset: created?.agentPreset ?? null })
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

  return { open, currentId, guardPreset }
}
