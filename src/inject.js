// 通知注入：直接驱动协调者会话，不经过 Team roster 的发送方校验。
// 与 TeamService 给 lead 投递时内部做的 root.steer(createUserMessage(...)) 同构。
import { randomUUID } from 'node:crypto'

export function injectNotification(agent, { text, senderId }) {
  if (typeof agent?.steer !== 'function') {
    throw new Error('协调者会话不可用：缺少 steer 方法')
  }
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: senderId === undefined
      ? { kind: 'orchestrator-notification' }
      : { kind: 'agent-message', form: 'relay', senderSessionId: String(senderId) },
  }
  agent.steer(message)
  return message
}
