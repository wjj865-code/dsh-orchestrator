---
name: orch-worktree
description: worktree 隔离与同写域并发防护的判断口径（要不要建检出、基线怎么选、分支名怎么传、写域撞车被拒后走哪条路）。当 task_create 要落笔派任务、需要判断是否用 worktree:true / worktreeMode / worktreeBranch / worktreeBase / worktreeCleanup，或 task_create 因目标目录/写域与活跃未隔离任务重叠而被拒、需要选一条出路时加载。
whenToUse: 准备 task_create 派发写文件的子任务；目标仓库是 git 仓库且同一需求已有任务在执行；同一写域要和另一个活跃任务并行；task_create 返回 needsBranchChoice 或写域冲突报错；需要复用已有检出（worktreeMode:"continue"）或收尾清理检出时。
---

## worktree 隔离（插件策略，非硬拦截）

当前配置策略：auto（required | auto | off）｜分支命名：<type>/<slug>（必填，由你传）｜最近活跃窗口：7 天
- required：每个需求都用 task_create({ worktree: true, worktreeBranch: "<type>/<slug>" }) 派发；只读/计划阶段的任务跳过并说明。**名字仍归你**：required 只决定「默认要隔离」，不包办分支名（漏传直接报错）。
- auto：默认不隔离；目标仓库是 git 仓库、同一需求已有任务在执行、且本次是新需求时，建议隔离。**同一写域要和另一个活跃任务并行、且两者互不依赖、无需复用上下文时，优先传 worktree:true 隔离并行**（见 orch-parallel 技能），不要先排队。
- off：一律不隔离。
- 用户当场表述或 AGENTS.md 里的要求优先于本默认；判断后传结构化字段，不要问「怎么解析文件」。
判断流程（你做判断，插件只执行）：
1. 读指引：上下文里 DSH 已注入用户级/工作区级 AGENTS.md；再用 context({ mode: 'project', target }) 看目标仓库的 AGENTS.md（有就按它，回复里写明来源）。用户当场表述优先于文件。
2. 拿事实：context({ mode: 'project', target }) 看顶层结构是不是 git 仓库；task_list 看同 group / dependsOn 链上有没有在跑的任务。isRepo/defaultBranch/recentBranches 这类仓库事实由插件在 worktree:true 的返回里给，你不要跑 git。
3. 判要不要建（默认三条件，仅在用户/配置都没说死时用）：A 目标是 git 仓库 ∧ B 同一需求已有任务在执行 ∧ C 本次是新需求 → worktree:true；若与某个活跃未隔离任务同写域、而两个任务互不依赖且无需复用上下文，也传 true（并行优先，见 orch-parallel 技能）；否则省略或传 false，并在回复里说一句原因（「不是 git 仓库」「续派复用已有检出」…）。
4. 判基线 + 分支名：用户指定就从哪起（worktreeBase）；没说时插件给事实——近 7 天 0 个活跃分支用默认分支、1 个直接用那条；**≥2 个时插件返回 needsBranchChoice 且不创建任务**，你用 ask_user_question 问用户，拿到答案后带 worktreeBase 重调 task_create。**分支名必须你传**：worktreeBranch: "<type>/<slug>"（type 白名单 feat | fix | docs | refactor | chore | test | perf | build | ci | style | revert；slug 小写 ASCII kebab，1–40 字符，如 feat/login-retry）；不传或不规范当场报错，插件不猜、不改名、不再有默认 orch/<taskId>（worktreeMode:'continue' 复用检出时不需要）。
5. 收尾标注：按返回的 worktree 块在回复里写「产物在分支 X 的检出目录 Y，合并由你决定」；hint 非空时一并解释。
- 隔离任务在检出目录里干活：产物不在用户工作树里，合并/提交由用户决定（插件不合并、不 push、不碰远程）。
- worktree 与 readOnly / planFirst 互斥（创建期拒绝）；计划批准后要隔离就重新派发一个带 worktree:true 的任务。
- 同一需求续写用 worktreeMode:'continue' 复用已有检出；**同一检出不并发**：复用时插件会按检出路径查活跃占用，被占就拒绝并给两条路——把占用任务设为 dependsOn 前置串行，或改用 worktreeMode:'new' 新建检出（见 orch-task-chain 技能）。
- worktreeCleanup 默认 off（检出+分支都保留）；要清理传 'checkout-only'（只删检出）或 'full'（连分支一起删）。

## 同写域并发防护

当前配置：sameDirGuard=require（require | warn | off）｜默认拒绝：目标目录（相同或互相包含）或写域与活跃未隔离任务重叠时 task_create 直接报错、不建任务。
- 判定对象：同一 target 目录（含父子目录）或 writeScopes 重叠的**活跃未隔离**任务；只读任务、worktree 隔离任务、dependsOn 链上的前置任务、以及**已交付待确认（delivered，写根已释放）**都不算冲突。
- 被拒时按顺序选一条，不要原样重试同一个调用：
  1. 两个任务互不依赖、也不需要复用同一子会话上下文 → 传 worktree:true 让新任务在独立检出里**并行**跑（首选，产物合并由你/用户决定，见 orch-parallel 技能）；
  2. 这个目录确实只该有一个任务在写 → 先 task_message({ action: 'close' })（待确认）或 task_message({ action: 'stop' })（还在跑），再重派；
  3. 用户明确要求并发写同一目录 → 显式传 allowConcurrent:true，并把返回里的「并发风险」原话转告用户。
- 不要为了绕过这条把任务改成 readOnly/planFirst（那会让子会话写不了文件），也不要自己改配置。
- 已交付待确认（delivered）**不占目录**：交付那一刻就释放写根，同目录可以正常新派。要继续改就追问原会话——追问回 running 前会复判写域，被占用时按上面两条出路处理（等占用任务确认/关闭，或 worktree:true 新派；追问没有 allowConcurrent 这条放行口）。
