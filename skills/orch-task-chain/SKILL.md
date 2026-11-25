---
name: orch-task-chain
description: dependsOn 任务链的判断口径（什么时候该建链、派 A 之后同一回合就建 B、建完不用等、前置失败怎么传播、delivered 不算 done、chain:"auto" 自动放行、同一检出必须串行）。当一次需求要拆成有先后关系的多个子任务、B 的输入是 A 的产物、或需要决定是否传 task_create.dependsOn / chain:"auto" 时加载。
whenToUse: 准备把需求拆成实现→验收、构建→发布、修复→回归、迁移→回归复核这类有前后依赖的子任务；任务停在 waiting_dep 不知道要不要自己等；前置停在「已交付待确认」挡住下游；同一 worktree 检出要派第二个任务；要判断链上是否加 chain:"auto"。
---

## 任务链（dependsOn：依赖完成自动开始，不占你的回合）

- 判据（什么时候该建链）：B 的输入是 A 的产物时就是一条链——实现 → 验收/冒烟、构建 → 发布、修复 → 回归、迁移 → 回归复核都算；A 还没产出东西，B 就没法开始。
  建链时机：派 A 之后**同一回合**就把 B 建出来（`task_create({ dependsOn: [A 的编号] })`，A 的编号在创建回执里）——不要等 A 完成再来建 B，也不要为「等 A」跑 task_list 轮询。
- dependsOn 不是阻塞等待：B 先落 waiting_dep，前置全部 done 后由**插件队列自动晋升** pending 并派发，不占你的回合、不用你 wait_agent 也不用轮询——这一回合没有别的事就正常结束，B 到点自己开始。
- 前置失败 → 下游自动 failed：前置 failed / cancelled / orphaned / 不存在时下游直接失败并写明原因（失败沿链循环传播）；要接着做用 `task_message({ action: "retry" })` 重派，不要原地等一条已经死掉的链。
- 前置「已交付待确认」（delivered）不算 done：依赖就绪只认 done——前置停在等你确认时下游一直 waiting_dep；确实要推进就先 `task_message({ action: "close" })` 收成 done（或等超时自动完成），别重复派下游、也别把 delivered 当失败。
- 链式自动放行（`chain: "auto"`，派上游时显式加）：带标记的任务交付时**仍有 waiting_dep 下游在等**就自动确认完成（`accepted_by` / `close_reason` 都是 `chain`），下游随即由队列晋升；没有下游时照旧停在「已交付待确认」，不带标记的链行为不变。自动放行后**没有追问窗口**（`done` 不能追问；要接着改用 `resume` 续跑原会话，或 `retry` 新任务）。
- 同一 worktree 检出必须用 dependsOn 串行：两个任务同时写一个检出会互相覆盖——后一个带 dependsOn 排队，或者各建一个检出（worktree:true）**并行**（互不依赖、无需复用上下文时首选，见 orch-parallel 技能）；worktreeMode:"continue" 复用检出同样只能串行。
- 与既有口径的关系：这条不推翻「禁止阻塞等待/不轮询」「能直接回答就不派任务」「推进循环」「交付两段式」——建链属于「推进」那一类动作；晋升与失败传播是执行层硬机制，建不建链是你的判断（提示词约束）。
