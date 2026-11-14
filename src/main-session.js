// 主会话：唯一协调者。创建/打开/重建都从这里走；不再由 task_create 自动绑定。
import { mkdir } from 'node:fs/promises'
import { getMainSessionId, setMainSessionId } from './ledger.js'

export const PRESET_ID = 'dsh-orchestrator-coordinator'
export const WORKER_PRESET_ID = 'dsh-orchestrator-worker'
export const MAIN_SESSION_HINT = '尚未打开主会话，请先从面板「打开主会话」。'

export function createMainSession({ db, config, agents, sessionController, workspaces, workspacePath, workspaceName = '指挥舱', log = () => {} }) {
  // 服务既可以直接传对象（测试/同步场景），也可以传 getter（index 惰性取，等 cordis 服务就绪）。
  const resolveAgents = () => typeof agents === 'function' ? agents() : agents
  const resolveSessionController = () => typeof sessionController === 'function' ? sessionController() : sessionController
  const resolveWorkspaces = () => typeof workspaces === 'function' ? workspaces() : workspaces
  const liveAgent = id => resolveAgents()?.get?.(id)
  const currentId = () => config?.coordinatorSession ?? getMainSessionId(db)
  // worker 预设只认 spawn provider（fork 不满足 capabilities.agentPreset）；不静默降级、不改用户配置。
  const spawnProvider = config?.spawnProvider ?? 'spawn'

  const ensureWorkspace = async () => {
    const services = resolveWorkspaces()
    if (services === undefined) return undefined
    // 工作区 API 是位置参数：create(path, title?)；目录必须先存在。
    let found
    try { found = services.resolveByPath?.(workspacePath) } catch { found = undefined }
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
    if (id !== undefined && liveAgent(id) !== undefined) return { ok: true, sessionId: id, created: false }
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
    log('main.session.created', { sessionId })
    return { ok: true, sessionId, created: true }
  }

  // 并发点击/路由重复调用只建一次：后来者 await 同一个 in-flight Promise。
  // finally 里清掉（失败也清），否则一次创建失败会让后续点击永久复用失败结果。
  let opening
  const open = () => {
    if (opening !== undefined) return opening
    opening = openOnce().finally(() => { opening = undefined })
    return opening
  }

  return { open, currentId }
}
