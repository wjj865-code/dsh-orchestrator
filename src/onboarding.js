// 仅新建主会话启动一次；老会话没有 pending 标记，不因升级补欢迎。
import { getSetting, setSetting, rebindSetting } from './ledger.js'
import { injectNotification } from './inject.js'

export const onboardingKey = id => `main_onboarding:${id}`
export const ONBOARDING_PROMPT = `这是新主会话首次打开的初始化请求，不是用户手写项目指令。
先向用户简短介绍：你能拆任务、派子会话、看进度/回报、交付与追问、检索项目背景和记忆，并管理DSH原生自动化（schedule_create/list/view/edit，写操作需明确授权；自动编排只用this_session）。你只协调、不直接读写文件/执行命令、不阻塞等待；默认worker不开放自动化，full只改变单条任务沙箱。
介绍后立即调用 task_create({title:'工作区与仓库索引',goal:'只读扫描DSH已登记的全部工作区，持久化标题→路径→git仓库映射供后续需求定位',readOnly:true,worktree:false,acceptance:['逐项回报title/path、git与否、repoRoot、branch、origin、HEAD和worktree commonDir；含采样时间，非实时状态','非仓库/不存在/无权限单项记录，不中断；remote脱敏，不fetch/pull，不写文件','用task_report.workspace_index回报完整JSON，持久化后可由project_context查询']})。
插件会在task_detail附创建时workspaceRegistry名单及只读扫描脚本，不需你直接扫描，也不要给full。任务失败可见：报告原因后停止盲重试，用户要重试用task_retry；后续映射有歧义列候选，不猜路径。`

export function createOnboarding({ db, resolveAgent, ensurePreset, warn = () => {} }) {
  const start = async id => {
    const key = onboardingKey(id)
    if (getSetting(db, key) !== 'pending') return { ok: true, skipped: true }
    const agent = resolveAgent(id)
    if (agent === undefined) return { ok: false, error: '首次介绍待启动：主会话尚未加载，重新打开后重试' }
    try {
      if (await ensurePreset(agent) !== true) {
        return { ok: false, error: '首次介绍待启动：协调者预设恢复未成功，修正后重新打开重试' }
      }
    } catch {
      return { ok: false, error: '首次介绍待启动：协调者预设恢复失败，修正后重新打开重试' }
    }
    // await 后重新CAS，重复入口只投递一次；失败保留pending，不以默认预设开启首轮。
    if (!rebindSetting(db, key, 'pending', 'sending')) return { ok: true, skipped: true }
    try {
      injectNotification(agent, { text: ONBOARDING_PROMPT })
      setSetting(db, key, 'sent')
      return { ok: true }
    } catch {
      setSetting(db, key, 'pending')
      const error = '首次介绍投递失败：重新打开主会话可重试；没有派发扫描任务'
      warn(error)
      return { ok: false, error }
    }
  }
  return { start }
}
