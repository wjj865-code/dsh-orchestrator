(function() {
  "use strict";
  const CLIENT_ID = "@wjj865-code/dsh-orchestrator";
  const PANEL_ID = "orchestrator";
  const LAUNCHER_ID = "orchestrator-launcher";
  const ROUTE = "api/orchestrator";
  const POLL_MS = 2e3;
  const POLL_BACKOFF_MS = 3e4;
  const MAIN_VIEW_POLL_MS = 5e3;
  const CHIP_ID = "orchestrator-task-chips";
  const CHIP_MAX = 2;
  const CHIP_RECENT_MS = 30 * 60 * 1e3;
  const CHIP_POLL_MS = 3e3;
  const CHIP_IDLE_MS = 15e3;
  const CHIP_ACTIVE_STATUSES = ["waiting_dep", "pending", "running", "waiting_user", "waiting_auth", "delivered"];
  const CHIP_STATE_OF = {
    running: "running",
    pending: "waiting",
    waiting_dep: "waiting",
    waiting_user: "confirming",
    waiting_auth: "confirming",
    delivered: "confirming",
    done: "done",
    failed: "failed",
    orphaned: "failed",
    missing: "failed",
    cancelled: "cancelled"
  };
  const CHIP_STATE_VIEW = {
    running: { icon: "ring", className: "orch-taskchip-spin", tone: "info" },
    waiting: { icon: "dashed", className: "orch-taskchip-dashed", tone: "muted" },
    confirming: { icon: "dashed", className: "orch-taskchip-dashed", tone: "warn" },
    done: { icon: "check", className: "", tone: "good" },
    failed: { icon: "close", className: "", tone: "bad" },
    cancelled: { icon: "dash", className: "", tone: "muted" }
  };
  const STYLE_ID = "dsh-orchestrator-styles";
  const FILTERS = [
    ["all", "全部"],
    ["active", "进行中"],
    ["waiting", "待你决定"],
    ["done", "已完成"],
    ["failed", "失败"],
    ["closed", "已取消/丢失"],
    ["artifacts", "产物"]
  ];
  const METRICS = [["active", "进行中"], ["waiting", "待你决定"], ["done", "已完成"], ["failed", "失败"]];
  const STATUS_LABEL = {
    waiting_dep: "等前置",
    pending: "待派发",
    running: "进行中",
    waiting_user: "等你确认",
    waiting_auth: "要授权",
    delivered: "待确认",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
    orphaned: "会话丢失",
    missing: "缺失"
  };
  const STATUS_TONE = {
    waiting_dep: "warn",
    pending: "muted",
    running: "info",
    waiting_user: "warn",
    waiting_auth: "warn",
    delivered: "warn",
    done: "good",
    failed: "bad",
    cancelled: "muted",
    orphaned: "bad",
    missing: "bad"
  };
  const MESSAGE_KIND_LABEL = {
    brief: "任务简报",
    followup: "追加消息",
    delivery_failed: "投递失败",
    report: "回报",
    progress: "进展",
    settle: "结算"
  };
  const DELIVERY_LABEL = { pending: "待发", delivered: "已投递", failed: "投递失败" };
  const DELIVERY_TONE = { pending: "warn", delivered: "good", failed: "bad" };
  const GOAL_PHASE_LABEL = {
    active: "进行中",
    paused: "已暂停",
    blocked: "受阻",
    complete: "已完成",
    cleared: "已清除"
  };
  const GOAL_ACTIVATION_LABEL = { armed: "自动续轮已启用", disarmed: "不自动续轮" };
  const PLAN_STATE_LABEL = {
    none: "无计划状态",
    planning: "计划中（等批准）",
    approved: "已批准执行",
    rejected: "计划未通过"
  };
  const WORKTREE_STATE_LABEL = {
    none: "未隔离",
    requested: "待建检出",
    created: "已隔离",
    reused: "复用已有检出",
    degraded: "已降级（不是 git 仓库）",
    rejected: "隔离被拒绝",
    failed: "隔离创建失败",
    cleaned: "检出已清理"
  };
  const WORKTREE_SOURCE_LABEL = {
    task: "协调者传字段",
    config: "配置兜底",
    default: "都没说"
  };
  const TONE_COLOR = {
    good: "var(--dsw-alias-state-success-primary, #01a241)",
    bad: "var(--dsw-alias-state-error-primary, #ec1313)",
    warn: "var(--dsw-alias-state-warn-primary, #f59f0a)",
    info: "var(--dsw-alias-state-business-primary, #4d6bfe)",
    muted: "var(--dsw-alias-label-tertiary, #8a8f99)"
  };
  const shortId = (id) => String(id || "").replace(/^t-/, "").slice(0, 4);
  const displayNameOf = (task, all) => {
    const title = String(task && task.title || "").trim();
    if (title === "") return task && task.id ? `任务 ${task.id}` : "任务";
    const duplicate = all.some((other) => other !== task && other.id !== task.id && String(other && other.title || "").trim() === title);
    return duplicate ? `${title}（${shortId(task.id)}）` : title;
  };
  const textOf = (value) => typeof value === "string" ? value.trim() : "";
  const listOf = (value) => Array.isArray(value) ? value.map((item) => textOf(item)).filter(Boolean) : [];
  const countTasks = (tasks) => {
    const counts = { all: 0, active: 0, waiting: 0, done: 0, failed: 0, closed: 0, artifacts: 0 };
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (task === null || typeof task !== "object") continue;
      counts.all += 1;
      for (const filter of ["active", "waiting", "done", "failed", "closed"]) {
        if (matchesFilter(task, filter)) counts[filter] += 1;
      }
      if (matchesFilter(task, "artifacts")) counts.artifacts += 1;
    }
    return counts;
  };
  const matchesFilter = (task, filter) => {
    const status = task === null || task === void 0 ? void 0 : task.status;
    if (filter === "active") return status === "waiting_dep" || status === "pending" || status === "running";
    if (filter === "waiting") return status === "waiting_user" || status === "waiting_auth" || status === "delivered";
    if (filter === "done") return status === "done";
    if (filter === "failed") return status === "failed";
    if (filter === "closed") return status === "cancelled" || status === "orphaned";
    if (filter === "artifacts") return Array.isArray(task === null || task === void 0 ? void 0 : task.artifacts) && task.artifacts.length > 0;
    return true;
  };
  const matchesQuery = (task, query) => {
    const needle = String(query ?? "").trim().toLowerCase();
    if (needle === "") return true;
    return [task?.title, task?.id, task?.targetDir, task?.groupId].some((value) => String(value ?? "").toLowerCase().includes(needle));
  };
  const artifactDate = (at) => {
    if (typeof at !== "number" || !Number.isFinite(at)) return "日期未知";
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const artifactProject = (item) => {
    const project = typeof item?.project === "string" ? item.project : "";
    if (project !== "") return project;
    const dir = textOf(item?.targetDir);
    if (dir === "") return "未关联项目";
    return dir.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || dir;
  };
  const groupArtifacts = (items, mode) => {
    const groups = /* @__PURE__ */ new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (item === null || typeof item !== "object") continue;
      if (typeof item.path !== "string" || item.path === "") continue;
      const key = mode === "date" ? artifactDate(item.at) : artifactProject(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const rows = [...groups.entries()];
    rows.sort((left, right) => mode === "date" ? right[0].localeCompare(left[0]) : left[0].localeCompare(right[0], "zh-CN"));
    for (const [, list] of rows) {
      list.sort((left, right) => (right.at ?? 0) - (left.at ?? 0) || String(left.path).localeCompare(String(right.path)));
    }
    return rows;
  };
  const timeLabel = (ms) => {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
    const minutes = Math.max(0, Math.floor((Date.now() - ms) / 6e4));
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  };
  const shortPath = (value) => {
    const text = typeof value === "string" ? value : "";
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  };
  const encodeAddressSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ":");
  const fileAddressOf = (sessionId, path) => {
    if (fileAddressProblem(sessionId, path) !== null) return "";
    const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    try {
      const encoded = normalized.split("/").map(encodeAddressSegment).join("/");
      return `dsh-resource://file/session/${encodeAddressSegment(sessionId)}/${encoded}`;
    } catch {
      return "";
    }
  };
  const fileAddressProblem = (sessionId, path) => {
    if (typeof sessionId !== "string" || sessionId === "") return "no-session";
    if (typeof path !== "string" || path === "") return "bad-path";
    return null;
  };
  const CHIP_ACTIVE$1 = new Set(CHIP_ACTIVE_STATUSES);
  const chipStateOf = (status) => Object.hasOwn(CHIP_STATE_OF, status) ? CHIP_STATE_OF[status] : "waiting";
  const chipViewOf = (status) => {
    const state = chipStateOf(status);
    return { state, ...CHIP_STATE_VIEW[state] };
  };
  const chipNameOf = (task) => {
    const title = textOf(task === null || task === void 0 ? void 0 : task.title);
    if (title !== "") return title;
    const id = textOf(task === null || task === void 0 ? void 0 : task.id);
    return id === "" ? "任务" : `任务 ${id}`;
  };
  const chipOpenTargetOf = (task) => {
    const value = task === null || task === void 0 ? void 0 : task.childSessionId;
    const sessionId = textOf(value);
    return sessionId === "" ? { kind: "detail", sessionId: null } : { kind: "session", sessionId };
  };
  const chipTooltipOf = (task) => {
    const status = task === null || task === void 0 ? void 0 : task.status;
    const label = Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : "状态未知";
    const hint = chipOpenTargetOf(task).kind === "session" ? "点击打开子会话" : "无子会话，点击打开任务详情";
    return `${chipNameOf(task)}｜${label}｜${hint}`;
  };
  const CHIP_TITLE_MAX = 24;
  const chipVisibleTitle = (title, max = CHIP_TITLE_MAX) => {
    const text = textOf(title);
    if (text === "") return "任务";
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : CHIP_TITLE_MAX;
    const chars = [...text];
    return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
  };
  const selectTaskChips = (tasks, { sessionId, now = Date.now(), max = CHIP_MAX, recentMs = CHIP_RECENT_MS } = {}) => {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    const list = (Array.isArray(tasks) ? tasks : []).filter((task) => task !== null && typeof task === "object").filter((task) => task.coordinatorSession === sessionId).filter((task) => {
      if (CHIP_ACTIVE$1.has(task.status)) return true;
      const at = task.lastEventAt;
      return typeof at === "number" && Number.isFinite(at) && now - at <= recentMs;
    }).sort((left, right) => (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || String(left.id ?? "").localeCompare(String(right.id ?? "")));
    if (list.length === 0) return null;
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
    const chips = list.slice(0, limit);
    return { chips, rest: list.length - chips.length, total: list.length };
  };
  const turnNumberOf = (turn) => {
    if (typeof turn === "number") return Number.isFinite(turn) ? turn : null;
    if (turn === null || typeof turn !== "object") return null;
    const value = turn.turn;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const isLatestTurn = (snapshot, turn) => {
    const order = snapshot === null || snapshot === void 0 ? void 0 : snapshot.timeline?.turnOrder;
    const current = turnNumberOf(turn);
    return Array.isArray(order) && order.length > 0 && current !== null && order[order.length - 1] === current;
  };
  const createFocusRequest = () => {
    let pending = null;
    let pendingNotice = null;
    return {
      request: (id, options = {}) => {
        const value = textOf(id);
        if (value === "") return false;
        pending = value;
        pendingNotice = textOf(options === null || options === void 0 ? void 0 : options.notice) || null;
        return true;
      },
      take: () => {
        const value = pending;
        pending = null;
        return value;
      },
      // 取走即清空：面板只在挂载消费一次，提示跟着那一次走，不留到下次开面板。
      takeNotice: () => {
        const value = pendingNotice;
        pendingNotice = null;
        return value;
      },
      peek: () => pending,
      peekNotice: () => pendingNotice
    };
  };
  const readSnapshot = async (signal) => {
    const response = await fetch(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "snapshot" }),
      signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body === null || typeof body !== "object" || body.ok !== true) throw new Error(body && body.error || "bad-response");
    return body;
  };
  const openMainSession = async () => {
    const response = await fetch(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "open-main" })
    });
    const body = await response.json();
    if (body && body.ok === true && typeof body.sessionId === "string") return body;
    throw new Error(body && body.error || "打开主会话失败");
  };
  const actionFailure = (body, status) => {
    const failure = new Error(body && body.error || `HTTP ${status}`);
    if (body && typeof body.code === "string" && body.code !== "") failure.code = body.code;
    failure.status = status;
    return failure;
  };
  const newRequestId = () => {
    const source = typeof globalThis !== "undefined" ? globalThis.crypto : void 0;
    if (source && typeof source.randomUUID === "function") return source.randomUUID();
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };
  const readDetail = async (taskId) => {
    const response = await fetch(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "detail", taskId })
    });
    const body = await response.json();
    if (body && body.ok === true) return body;
    throw actionFailure(body, response.status);
  };
  const readArtifacts = async (limit = 200, signal) => {
    const response = await fetch(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "artifacts", limit }),
      signal
    });
    const body = await response.json();
    if (body && body.ok === true) return body;
    throw actionFailure(body, response.status);
  };
  const readPreview = async (taskId, path) => {
    const response = await fetch(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "preview", taskId, path })
    });
    const body = await response.json();
    if (body && body.ok === true) return body;
    throw actionFailure(body, response.status);
  };
  const panelAction = async (endpoint, taskId, extra = {}) => {
    const payload = { endpoint, taskId, ...extra };
    if (endpoint === "message" && (typeof payload.clientRequestId !== "string" || payload.clientRequestId === "")) {
      payload.clientRequestId = newRequestId();
    }
    const response = await fetch(ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (body && body.ok === true) return body;
    throw actionFailure(body, response.status);
  };
  let openMainInFlight = null;
  const openMainOnce = () => {
    if (openMainInFlight !== null) return openMainInFlight;
    const run = openMainSession();
    openMainInFlight = run;
    const clear = () => {
      if (openMainInFlight === run) openMainInFlight = null;
    };
    run.then(clear, clear);
    return run;
  };
  const CHIP_ACTIVE = new Set(CHIP_ACTIVE_STATUSES);
  const slimTask = (task) => ({
    id: typeof task.id === "string" ? task.id : "",
    title: typeof task.title === "string" ? task.title : "",
    status: typeof task.status === "string" ? task.status : "",
    coordinatorSession: typeof task.coordinatorSession === "string" ? task.coordinatorSession : null,
    childSessionId: typeof task.childSessionId === "string" && task.childSessionId !== "" ? task.childSessionId : null,
    lastEventAt: typeof task.lastEventAt === "number" ? task.lastEventAt : null,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : null
  });
  const recencyOf = (task, at) => {
    if (CHIP_ACTIVE.has(task.status)) return "active";
    if (typeof task.lastEventAt !== "number") return "stale";
    return at - task.lastEventAt <= CHIP_RECENT_MS ? "recent" : "stale";
  };
  const signatureOf = (tasks, at) => {
    let text = "";
    for (const task of tasks) {
      text += `${task.id}${task.status}${task.title}${task.coordinatorSession ?? ""}${task.childSessionId ?? ""}${task.lastEventAt ?? ""}${task.updatedAt ?? ""}${recencyOf(task, at)}`;
    }
    return text;
  };
  const normalizeFeedSnapshot = (body, at = Date.now()) => {
    if (body === null || typeof body !== "object" || body.ok !== true) return null;
    const tasks = (Array.isArray(body.tasks) ? body.tasks : []).filter((task) => task !== null && typeof task === "object").map(slimTask);
    return { tasks, signature: signatureOf(tasks, at) };
  };
  const hasActive = (snapshot) => snapshot !== null && snapshot.tasks.some((task) => CHIP_ACTIVE.has(task.status));
  const createTaskFeed = ({
    readSnapshot: readSnapshot2,
    now = () => Date.now(),
    setTimer = (run, ms) => setTimeout(run, ms),
    clearTimer = (handle) => clearTimeout(handle),
    activeMs = CHIP_POLL_MS,
    idleMs = CHIP_IDLE_MS,
    backoffMs = POLL_BACKOFF_MS
  }) => {
    let snapshot = null;
    let handle = null;
    let stopped = true;
    let running = false;
    const listeners = /* @__PURE__ */ new Set();
    const emit = () => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
        }
      }
    };
    const stop = () => {
      stopped = true;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    };
    const schedule = (ms) => {
      if (stopped) return;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      handle = setTimer(() => {
        handle = null;
        return step();
      }, ms);
    };
    const poll = async () => {
      if (running) return false;
      running = true;
      let next = null;
      let ok = false;
      const at = now();
      try {
        next = normalizeFeedSnapshot(await readSnapshot2(), at);
        ok = next !== null;
      } catch {
        ok = false;
      }
      running = false;
      if (ok && (snapshot === null || next.signature !== snapshot.signature)) {
        snapshot = { tasks: next.tasks, signature: next.signature, at };
        emit();
      }
      return ok;
    };
    const step = async () => {
      if (stopped || running) return;
      const ok = await poll();
      if (stopped) return;
      schedule(ok ? hasActive(snapshot) ? activeMs : idleMs : backoffMs);
    };
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        if (stopped) {
          stopped = false;
          schedule(0);
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stop();
        };
      },
      poll,
      stop
    };
  };
  const createMainViewGate = ({
    readSessionId,
    subscribeSession,
    fetchRole,
    timer,
    pollMs = MAIN_VIEW_POLL_MS,
    now = () => Date.now()
  }) => {
    let visible = false;
    let epoch = 0;
    let lastId = null;
    let lastVisible = false;
    let lastOk = false;
    let lastAt = 0;
    const listeners = /* @__PURE__ */ new Set();
    const setVisible = (next) => {
      const value = next === true;
      if (value === visible) return;
      visible = value;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
        }
      }
    };
    const evaluate = async (force = false) => {
      let sessionId;
      try {
        sessionId = readSessionId();
      } catch {
        sessionId = void 0;
      }
      if (typeof sessionId !== "string" || sessionId === "") {
        lastId = null;
        lastOk = false;
        lastAt = now();
        setVisible(false);
        return false;
      }
      if (!force && lastOk && lastId === sessionId) {
        setVisible(lastVisible);
        return lastVisible;
      }
      if (!force && lastId === sessionId && now() - lastAt < (lastOk ? 1e3 : pollMs)) return visible;
      const turn = ++epoch;
      lastAt = now();
      let next = false;
      let ok = false;
      try {
        next = await fetchRole(sessionId) === true;
        ok = true;
      } catch {
        ok = false;
      }
      if (turn !== epoch) return visible;
      lastId = sessionId;
      lastOk = ok;
      lastVisible = ok && next;
      setVisible(lastVisible);
      return lastVisible;
    };
    return {
      getSnapshot: () => visible,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh: () => evaluate(true),
      start: () => {
        const disposers = [];
        let sessionBound = false;
        const bindSession = () => {
          if (sessionBound || typeof subscribeSession !== "function") return;
          const off = subscribeSession(() => {
            void evaluate();
          });
          if (typeof off === "function") {
            sessionBound = true;
            disposers.push(off);
          }
        };
        bindSession();
        if (typeof timer === "function") {
          const off = timer(() => {
            bindSession();
            void evaluate();
          }, pollMs);
          if (typeof off === "function") disposers.push(off);
        }
        void evaluate(true);
        return () => {
          for (const off of disposers) {
            try {
              off();
            } catch {
            }
          }
        };
      }
    };
  };
  const STYLE_TEXT = `/* dsh-orchestrator 面板样式表（P7 / T7.2 从 client.js 的 STYLE_TEXT 迁入，内容逐字不变）。
 * 只消费宿主设计平台 token（--dsw-* / --ds-*），深浅色由宿主切换 body[data-ds-dark-theme] 时自动跟随。
 * 平台不 serve .css（assets 路由白名单只有图片），所以构建时用 ?inline 把整张表内联回 JS，
 * 运行时由 ensureStyles() 注入一个 <style id="dsh-orchestrator-styles">。 */
.orch-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-family: var(--dsw-font-family, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif);
  font-size: 13px;
  line-height: 1.5;
}

/* ---------- 第一段：顶部命令栏 ---------- */
.orch-topbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.orch-brand { display: flex; align-items: center; gap: 8px; min-width: 0; margin-right: auto; }
.orch-brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-specific-bubble, #eef2ff);
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.orch-title { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; }
.orch-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  white-space: nowrap;
}
.orch-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #c4c7cc); }
.orch-status[data-live='true'] .orch-status-dot { background: var(--dsw-alias-state-success-primary, #01a241); }
.orch-topbar-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }

/* 搜索框：focus-within 用设计平台的焦点环颜色 */
.orch-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-specific-input-major, #fff);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  transition:
    border-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-search:hover { border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)); }
.orch-search:focus-within {
  border-color: var(--dsw-alias-border-selected, #9aa4b2);
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, rgba(77, 107, 254, 0.35));
}
.orch-search input {
  width: 132px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font: inherit;
}
.orch-search input::placeholder { color: var(--dsw-alias-label-tertiary, #8a8f99); }

/* 按钮：hover / active / disabled / focus-visible 四态 */
.orch-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-btn:active { background: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, 0.1)); transform: scale(0.985); }
.orch-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
.orch-btn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: 1px;
}
.orch-btn--ghost { border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1)); }
.orch-btn--primary {
  background: var(--dsw-alias-button-primary-fill, #1f1f1f);
  color: var(--dsw-alias-label-primary-inverted, #fff);
  border-color: transparent;
}
.orch-btn--primary:hover {
  background: var(--dsw-alias-button-primary-hover, #3a3a3d);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.orch-btn--danger { color: var(--dsw-alias-state-error-primary, #ec1313); }
.orch-btn--danger:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
  color: var(--dsw-alias-state-error-primary, #ec1313);
}
.orch-btn--sm { height: 22px; padding: 0 7px; font-size: 11px; }
/* 会话头「任务」入口：按面板顶栏 .orch-brand 的语言（品牌色方块 + 半粗文字）。
   不画外框，与同排的协调者预设标签、子智能体计数一致——那两个都是无描边、透明底、
   hover 只换交互底色的 chip。所以这里只覆盖尺寸/字重：描边与底色一律沿用 .orch-btn 的
   border: 1px solid transparent + background: transparent，不重复声明；也不再有自己
   的 hover 覆盖（否则 hover 会冒出描边与悬浮阴影，又把它从同排里顶出来）。 */
.orch-btn--entry {
  height: 26px;
  padding: 0 4px;
  gap: 6px;
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-weight: 600;
}
.orch-entry-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-specific-bubble, #eef2ff);
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.orch-entry-label { font-size: 12px; letter-spacing: 0.01em; white-space: nowrap; }
.orch-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.orch-icon-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.orch-icon { flex: 0 0 auto; }
.orch-spin { animation: orch-rotate 0.9s linear infinite; }
@keyframes orch-rotate { to { transform: rotate(360deg); } }

/* ---------- 概览卡（第一段下半：4 个指标） ---------- */
.orch-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  flex: 0 0 auto;
  padding: 12px 16px 0;
}
.orch-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-metric:hover {
  background: var(--dsw-alias-card-fill-hover, #f1f2f4);
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.05));
  transform: translateY(-1px);
}
.orch-metric[data-active='true'] {
  border-color: var(--dsw-alias-border-selected, #9aa4b2);
  background: var(--dsw-alias-bg-layer-2, #fff);
}
.orch-metric:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.orch-metric-value {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-metric-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-metric[data-tone='info'] .orch-metric-value { color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.orch-metric[data-tone='warn'] .orch-metric-value { color: var(--dsw-alias-state-warn-primary, #f59f0a); }
.orch-metric[data-tone='good'] .orch-metric-value { color: var(--dsw-alias-state-success-primary, #01a241); }
.orch-metric[data-tone='bad'] .orch-metric-value { color: var(--dsw-alias-state-error-primary, #ec1313); }

/* ---------- 第二段：筛选轨 + 列表 ---------- */
.orch-body { display: flex; flex: 1 1 auto; min-height: 0; }
.orch-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
  width: 156px;
  padding: 12px;
  overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
}
.orch-rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-rail-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-rail-item[data-active='true'] {
  background: var(--dsw-specific-sidebar-nav-item-active, #eceff5);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-weight: 600;
}
.orch-rail-item:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: -2px; }
.orch-rail-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orch-rail-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  background: var(--dsw-alias-bg-multi-select, #eef0f3);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-rail-item[data-active='true'] .orch-rail-count {
  background: var(--dsw-specific-sidebar-nav-item-active-accent, #dce6ff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 12px 16px 24px;
  overflow: auto;
}

/* 提示条：error / notice / info 共用骨架，颜色取 --orch-tone */
.orch-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--orch-tone) 22%, transparent);
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--orch-tone) 8%, transparent);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 12px;
}
.orch-banner--error { --orch-tone: var(--dsw-alias-state-error-primary, #ec1313); }
.orch-banner--notice { --orch-tone: var(--dsw-alias-state-warn-primary, #f59f0a); }
.orch-banner--info { --orch-tone: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-banner-icon { display: inline-flex; margin-top: 1px; color: var(--orch-tone); }
.orch-banner-text { flex: 1 1 auto; overflow-wrap: anywhere; }

/* 任务卡 */
.orch-list { display: flex; flex-direction: column; gap: 8px; }
.orch-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-card:hover {
  background: var(--dsw-alias-card-fill-hover, #f1f2f4);
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.05));
}
.orch-card[data-open='true'] {
  border-color: var(--dsw-alias-border-selected, #9aa4b2);
  background: var(--dsw-alias-bg-layer-2, #fff);
}
.orch-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.orch-card-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-card-time { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.orch-card-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.orch-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent);
}
.orch-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 240px;
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  font-size: 11px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.orch-chip--warn { color: var(--dsw-alias-state-warn-label, #b45309); background: var(--dsw-alias-state-warn-tertiary, #fef3c7); }
.orch-chip--bad {
  color: var(--dsw-alias-state-error-primary, #ec1313);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 12%, transparent);
}
.orch-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  border-radius: var(--dsw-radius-xs, 4px);
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}
.orch-question {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59f0a) 10%, transparent);
  color: var(--dsw-alias-state-warn-label, #b45309);
  font-size: 12px;
}

/* 展开/折叠：grid-template-rows 0fr↔1fr，才能动画到内容真实高度 */
.orch-expand {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-expand[data-open='true'] { grid-template-rows: 1fr; }
.orch-expand > div { min-height: 0; overflow: hidden; }
.orch-artifact-list { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; }
.orch-chevron { transition: transform var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease); }
.orch-chevron[data-open='true'] { transform: rotate(180deg); }

/* 空态 / 加载骨架 / 错误态 */
.orch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--dsw-alias-card-fill, #f2f3f5);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-empty-title { font-size: 13px; color: var(--dsw-alias-label-secondary, #55585f); }
.orch-empty-hint { max-width: 360px; font-size: 12px; line-height: 1.6; }
.orch-skeleton {
  height: 10px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: linear-gradient(
    90deg,
    var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.04)) 25%,
    var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.06)) 37%,
    var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.04)) 63%
  );
  background-size: 400% 100%;
  animation: orch-shimmer 1.4s var(--ds-ease-in-out, ease) infinite;
}
@keyframes orch-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
.orch-skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
}
.orch-skeleton-row { display: flex; align-items: center; gap: 8px; }

/* ---------- 第三段：右侧抽屉详情 ---------- */
.orch-layer { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.orch-scrim {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-scrim[data-open='true'] { opacity: 1; pointer-events: auto; }
.orch-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(460px, 92%);
  pointer-events: none;
  transform: translateX(102%);
  background: var(--dsw-alias-bg-layer-2, #fff);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-elevation-prominent, 0 3px 8px rgba(0, 0, 0, 0.04));
  transition: transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
.orch-drawer[data-open='true'] { transform: translateX(0); pointer-events: auto; }
.orch-drawer-content { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
@keyframes orch-slide-in {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: translateX(0); }
}
.orch-drawer-content { animation: orch-slide-in var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, ease); }
.orch-drawer-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.orch-drawer-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.orch-drawer-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}
.orch-drawer-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 16px 20px;
  overflow: auto;
}
.orch-drawer-sections { display: flex; flex-direction: column; gap: 10px; }
.orch-drawer-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 0 0 auto;
  padding: 10px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  background: var(--dsw-alias-bg-layer-1, #fff);
}

/* 抽屉里的可折叠区块 */
.orch-section {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
  overflow: hidden;
}
.orch-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-section-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.orch-section-head:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: -2px; }
.orch-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.orch-section-hint { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-section-body-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-section[data-collapsed='true'] .orch-section-body-wrap { grid-template-rows: 0fr; }
.orch-section[data-collapsed='true'] .orch-section-head .orch-chevron { transform: rotate(-90deg); }
.orch-section-body { min-height: 0; overflow: hidden; }
.orch-section-inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #55585f);
}

/* 详情内部排版 */
.orch-kv { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 3px 8px; }
.orch-kv-key { color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-kv-val { color: var(--dsw-alias-label-secondary, #55585f); overflow-wrap: anywhere; }
.orch-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.orch-muted { color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-ul { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
.orch-quote {
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: 0 var(--dsw-radius-xs, 4px) var(--dsw-radius-xs, 4px) 0;
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.orch-pre {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-markdown-code-block, #f5f6f8);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-family: var(--ds-font-family-code, 'SF Mono', Consolas, monospace);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.orch-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
}
.orch-msg[data-kind='followup'] { background: var(--dsw-specific-bubble, #eef2ff); }
.orch-msg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.orch-msg-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.orch-msg-at { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-artifact {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-artifact:hover { background: var(--dsw-alias-card-fill-hover, #f1f2f4); }
.orch-artifact-path {
  flex: 1 1 220px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--ds-font-family-code, 'SF Mono', Consolas, monospace);
  font-size: 11px;
}
/* 可点开的产物路径：在会话右侧栏打开预览（不再是行内展开）。
   总是与 .orch-artifact-path 同时挂，字体/尺寸沿用那边，这里只加按钮复位与可点提示。 */
.orch-artifact-open {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #55585f);
  text-align: left;
  cursor: pointer;
  transition: color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-artifact-open:hover {
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  text-decoration: underline;
}
.orch-artifact-open:disabled { cursor: not-allowed; opacity: 0.6; text-decoration: none; }
.orch-artifact-open:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px; }
.orch-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-basis: 100%;
  padding-top: 6px;
  border-top: 1px dashed var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}
.orch-group { display: flex; flex-direction: column; gap: 6px; }
.orch-group-head { display: flex; align-items: baseline; gap: 6px; }
.orch-group-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.orch-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-multi-select, #eef0f3);
}
.orch-seg-item {
  padding: 2px 8px;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-seg-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.orch-seg-item[data-active='true'] {
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.05));
}
/* 破坏性动作的二次确认条 */
.orch-confirm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 2px 4px 2px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 8%, transparent);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 11px;
}

/* ---------- 回复底部「关联任务」chip（conversation.chat.turnTail 槽位） ----------
 * 挂在宿主会话流里（不在 .orch-shell 里），所以颜色全部走设计平台 token，并自带
 * prefers-reduced-motion 降级：宿主那份 reduced-motion 规则只作用在 .orch-shell 内。
 * 状态：运行中=旋转圆环；等前置/待确认=虚线静圈（待确认再加脉冲 + 半色）；
 *       完成=✓；失败=✗；取消=—。图标颜色走 TONE_COLOR 的语义 token（内联 style 下发）。 */
.orch-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.orch-taskchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  height: 24px;
  padding: 0 9px 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
/* 没有子会话的任务（待派发 / 等前置 / 台账里没有 session_id）：点击降级打开任务详情。
 * 它仍是可点的（详情入口），但不假装「跳会话」——cursor 不给手感上的误导，文案见 tooltip。 */
.orch-taskchip[data-orch-chip-open='detail'] {
  cursor: default;
}
.orch-taskchip:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
}
.orch-taskchip:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: 1px;
}
.orch-taskchip-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}
/* 长标题：先按码点截断（chipVisibleTitle），再由 CSS 按像素补省略号；宽度不撑破动作行。 */
.orch-taskchip-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 「+N」：同一行里最弱的一枚，点击打开任务面板。 */
.orch-taskchip--more {
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  font-variant-numeric: tabular-nums;
}
/* 运行中：圆环自转（留了缺口才看得出在转）。 */
.orch-taskchip-spin {
  animation: orch-rotate 1s linear infinite;
  transform-origin: 50% 50%;
}
/* 等前置 / 待确认：虚线静圈，不跟运行中抢动效。 */
.orch-taskchip-dashed { stroke-dasharray: 3 2.4; }
/* 待确认：半色 + 脉冲（呼吸），提示「等你/协调者拍板」。 */
.orch-taskchip[data-state='confirming'] {
  opacity: 0.72;
  animation: orch-chip-pulse 1.6s ease-in-out infinite;
}
@keyframes orch-chip-pulse {
  0%, 100% { opacity: 0.72; }
  50% { opacity: 0.4; }
}
/* 尊重系统「减少动态效果」：停转、停脉冲，但保留状态色与图标形状（信息不丢）。 */
@media (prefers-reduced-motion: reduce) {
  .orch-taskchip-spin { animation: none; }
  .orch-taskchip[data-state='confirming'] { animation: none; opacity: 0.6; }
  .orch-taskchip { transition: none; }
}

/* 启动器面板（侧栏「◈ 主会话」选中后一闪而过） */
.orch-launcher { align-items: center; justify-content: center; gap: 10px; padding: 32px; }
.orch-launcher-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
}
.orch-launcher-icon { font-size: 16px; line-height: 1; }

/* 窄屏：筛选轨变横向条，指标两列；抽屉铺满 */
@media (max-width: 860px) {
  .orch-body { flex-direction: column; }
  .orch-rail {
    width: 100%;
    flex-direction: row;
    gap: 4px;
    padding: 8px 12px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  }
  .orch-rail-item { width: auto; white-space: nowrap; }
  .orch-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .orch-drawer { width: 100%; }
  .orch-search input { width: 96px; }
}
/* 尊重系统「减少动态效果」偏好 */
@media (prefers-reduced-motion: reduce) {
  .orch-shell *,
  .orch-shell *::before,
  .orch-shell *::after {
    animation: none !important;
    transition: none !important;
  }
}

/* ── 插件页配置卡片（P10）─────────────────────────────────────────────
   渲染在 plugin-manager 的 bundle 页面里（不在本插件自己的面板里），
   所以只用 .orch-cfg* 前缀的局部类，不依赖 .orch-shell 的容器样式。 */
.orch-cfg { display: flex; flex-direction: column; gap: 10px; }
.orch-cfg--empty { gap: 4px; }
.orch-cfg-head { display: flex; align-items: center; gap: 8px; }
.orch-cfg-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1c1e24); }
.orch-cfg-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  overflow-wrap: anywhere;
}
.orch-cfg-hint--warn { color: var(--dsw-alias-state-warn-primary, #f59f0a); }
.orch-cfg-tag {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent);
}
.orch-cfg-tag--readonly {
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8a8f99) 14%, transparent);
}
.orch-cfg-group { display: flex; flex-direction: column; gap: 6px; }
.orch-cfg-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 2px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #4a4f57);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
}
.orch-cfg-group-header .orch-icon { color: var(--dsw-alias-label-tertiary, #8a8f99); }
/* 折叠态 chevron 指向右，展开态指向下：同一条图标靠旋转表达开合，不额外造图标。 */
.orch-cfg-chevron { transition: transform .15s ease; transform: rotate(-90deg); }
.orch-cfg-chevron--open { transform: rotate(0deg); }
.orch-cfg-group-label { flex: 1 1 auto; }
.orch-cfg-group-count { font-weight: 400; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-cfg-group-body { display: flex; flex-direction: column; gap: 8px; padding-top: 2px; }
.orch-cfg-row { display: grid; grid-template-columns: minmax(120px, 40%) minmax(0, 1fr); gap: 4px 10px; align-items: center; }
.orch-cfg-label { display: flex; align-items: center; gap: 6px; min-width: 0; }
.orch-cfg-name { font-size: 12px; color: var(--dsw-alias-label-primary, #1c1e24); overflow-wrap: anywhere; }
.orch-cfg-control { display: flex; align-items: center; min-width: 0; }
.orch-cfg-row .orch-cfg-hint { grid-column: 1 / -1; }
.orch-cfg-input {
  width: 100%;
  padding: 4px 7px;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #1c1e24);
  background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-sm, 6px);
}
.orch-cfg-input:disabled { color: var(--dsw-alias-label-tertiary, #8a8f99); background: transparent; }
.orch-cfg-switch {
  position: relative;
  width: 32px;
  height: 18px;
  padding: 0;
  cursor: pointer;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8a8f99) 35%, transparent);
  border: 0;
  border-radius: 9px;
  transition: background .15s ease;
}
.orch-cfg-switch--on { background: var(--dsw-alias-state-business-primary, #4d6bfe); }
.orch-cfg-switch:disabled { cursor: not-allowed; opacity: .5; }
.orch-cfg-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #fff;
  border-radius: 50%;
  transition: transform .15s ease;
}
.orch-cfg-switch--on .orch-cfg-switch-knob { transform: translateX(14px); }
.orch-cfg-actions { display: flex; align-items: center; gap: 8px; padding-top: 2px; }
`;
  const ensureStyles = () => {
    try {
      if (typeof document === "undefined" || document === null) return false;
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null && existing !== void 0) {
        if (existing.textContent === STYLE_TEXT) return false;
        existing.textContent = STYLE_TEXT;
        return true;
      }
      const host = document.head || document.documentElement;
      if (host === null || typeof host.appendChild !== "function") return false;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      host.appendChild(style);
      return true;
    } catch {
      return false;
    }
  };
  function createUi(h) {
    const ICON_PATHS = {
      refresh: ["M20 11a8 8 0 1 0-2.6 6.9", "M20 4v5h-5"],
      plus: ["M12 5v14", "M5 12h14"],
      close: ["M6 6l12 12", "M18 6L6 18"],
      chevron: ["M6 9l6 6 6-6"],
      search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4.2-4.2"],
      alert: ["M12 8v5", "M12 17h.01", "M10.3 3.9L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
      check: ["M20 6L9 17l-5-5"],
      clock: ["M12 7v5l3 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"],
      stop: ["M8 8h8v8H8z"],
      retry: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5"],
      trash: ["M4 7h16", "M9 7V5h6v2", "M6 7l1 13h10l1-13", "M10 11v5", "M14 11v5"],
      external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"],
      folder: ["M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
      copy: ["M9 9h10v10H9z", "M15 5H5v10"],
      goal: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
      inbox: ["M3 13h4l1.5 2.5h7L17 13h4", "M5.5 5h13l2.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z"],
      sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"],
      // 会话头「任务」入口：三条横线（面板顶栏同款图标语言，替代原来的裸字符 ☰）。
      menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
      // 回复底部 chip 的状态图标：运行中用一个留缺口的圆环（旋转时看得见在动），
      // 等前置/待确认用整圆（虚线由样式加），取消用一横。
      ring: ["M12 3a9 9 0 1 1-6.36 2.64"],
      dashed: ["M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18"],
      dash: ["M6 12h12"],
      dot: ["M12 12h.01"]
    };
    const Icon = ({ name, size = 14, className }) => /* @__PURE__ */ h(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className: className === void 0 ? "orch-icon" : `orch-icon ${className}`,
        "aria-hidden": "true",
        focusable: "false"
      },
      (ICON_PATHS[name] || ICON_PATHS.dot).map((d, index) => /* @__PURE__ */ h("path", { key: index, d }))
    );
    const Badge = ({ tone, children, title }) => /* @__PURE__ */ h("span", { className: "orch-badge", title, style: { color: TONE_COLOR[tone] || TONE_COLOR.muted } }, children);
    const Chip = ({ tone, title, children }) => /* @__PURE__ */ h("span", { className: tone === void 0 ? "orch-chip" : `orch-chip orch-chip--${tone}`, title }, children);
    const EmptyState = ({ icon = "inbox", title, hint, action }) => /* @__PURE__ */ h("div", { className: "orch-empty" }, /* @__PURE__ */ h("span", { className: "orch-empty-icon" }, /* @__PURE__ */ h(Icon, { name: icon, size: 20 })), title ? /* @__PURE__ */ h("div", { className: "orch-empty-title" }, title) : null, hint ? /* @__PURE__ */ h("div", { className: "orch-empty-hint" }, hint) : null, action === void 0 ? null : action);
    const Banner = ({ tone = "info", icon = "alert", action, children }) => /* @__PURE__ */ h("div", { className: `orch-banner orch-banner--${tone}` }, /* @__PURE__ */ h("span", { className: "orch-banner-icon" }, /* @__PURE__ */ h(Icon, { name: icon, size: 14 })), /* @__PURE__ */ h("span", { className: "orch-banner-text" }, children), action === void 0 ? null : action);
    const SkeletonList = ({ rows = 4 }) => /* @__PURE__ */ h("div", { className: "orch-list", "aria-hidden": "true" }, Array.from({ length: rows }, (_, index) => /* @__PURE__ */ h("div", { key: index, className: "orch-skeleton-card" }, /* @__PURE__ */ h("div", { className: "orch-skeleton-row" }, /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: 10, height: 10, borderRadius: 5 } }), /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: index % 2 === 0 ? "46%" : "62%" } }), /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: 40, marginLeft: "auto" } })), /* @__PURE__ */ h("div", { className: "orch-skeleton-row" }, /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: 68 } }), /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: 88 } })))));
    return { Icon, Badge, Chip, EmptyState, Banner, SkeletonList };
  }
  function createViews({
    React,
    h,
    Icon,
    Badge,
    Chip,
    EmptyState,
    Banner,
    SkeletonList,
    FILTERS: FILTERS2,
    METRICS: METRICS2,
    POLL_MS: POLL_MS2,
    POLL_BACKOFF_MS: POLL_BACKOFF_MS2,
    STATUS_LABEL: STATUS_LABEL2,
    STATUS_TONE: STATUS_TONE2,
    MESSAGE_KIND_LABEL: MESSAGE_KIND_LABEL2,
    DELIVERY_LABEL: DELIVERY_LABEL2,
    DELIVERY_TONE: DELIVERY_TONE2,
    GOAL_PHASE_LABEL: GOAL_PHASE_LABEL2,
    GOAL_ACTIVATION_LABEL: GOAL_ACTIVATION_LABEL2,
    PLAN_STATE_LABEL: PLAN_STATE_LABEL2,
    WORKTREE_STATE_LABEL: WORKTREE_STATE_LABEL2,
    WORKTREE_SOURCE_LABEL: WORKTREE_SOURCE_LABEL2,
    TONE_COLOR: TONE_COLOR2,
    displayNameOf: displayNameOf2,
    textOf: textOf2,
    listOf: listOf2,
    timeLabel: timeLabel2,
    shortPath: shortPath2,
    countTasks: countTasks2,
    matchesFilter: matchesFilter2,
    matchesQuery: matchesQuery2,
    groupArtifacts: groupArtifacts2,
    readSnapshot: readSnapshot2,
    readArtifacts: readArtifacts2,
    readDetail: readDetail2,
    readPreview: readPreview2,
    panelAction: panelAction2,
    openMainOnce: openMainOnce2,
    selectTaskChips: selectTaskChips2,
    chipViewOf: chipViewOf2,
    chipTooltipOf: chipTooltipOf2,
    chipVisibleTitle: chipVisibleTitle2,
    chipOpenTargetOf: chipOpenTargetOf2,
    isLatestTurn: isLatestTurn2
  }) {
    const HeaderButton = ({ openPanel, useMainView }) => {
      const visible = typeof useMainView === "function" ? useMainView((value) => value === true) : false;
      if (visible !== true) return null;
      return /* @__PURE__ */ h(
        "button",
        {
          type: "button",
          title: "任务面板",
          "aria-label": "打开任务面板",
          className: "orch-btn orch-btn--entry",
          onClick: openPanel
        },
        /* @__PURE__ */ h("span", { className: "orch-entry-mark" }, /* @__PURE__ */ h(Icon, { name: "menu", size: 12 })),
        /* @__PURE__ */ h("span", { className: "orch-entry-label" }, "任务")
      );
    };
    const LauncherIcon = () => /* @__PURE__ */ h("span", { "aria-hidden": true, className: "orch-launcher-icon" }, "◈");
    const TaskChipRow = ({ turn, sessionId, useMainView, useChat, chips, openTask, openPanel }) => {
      const isMain = typeof useMainView === "function" ? useMainView((value) => value === true) : false;
      const latest = typeof useChat === "function" ? useChat((snapshot2) => isLatestTurn2(snapshot2, turn)) : false;
      const enabled = isMain === true && latest === true;
      const [, setRevision] = React.useState(0);
      React.useEffect(() => {
        if (!enabled || chips === void 0 || chips === null || typeof chips.subscribe !== "function") return void 0;
        return chips.subscribe(() => setRevision((value) => value + 1));
      }, [enabled, chips]);
      if (!enabled) return null;
      const snapshot = chips !== void 0 && chips !== null && typeof chips.getSnapshot === "function" ? chips.getSnapshot() : null;
      const view = snapshot === null ? null : selectTaskChips2(snapshot.tasks, { sessionId, now: Date.now() });
      if (view === null) return null;
      const chipNode = (task) => {
        const visual = chipViewOf2(task.status);
        const tooltip = chipTooltipOf2(task);
        const target = chipOpenTargetOf2(task);
        const clickable = typeof openTask === "function" && typeof task.id === "string" && task.id !== "";
        return /* @__PURE__ */ h(
          "button",
          {
            key: `chip-${task.id}`,
            type: "button",
            className: "orch-taskchip",
            "data-state": visual.state,
            "data-task-id": task.id,
            "data-orch-chip-open": target.kind,
            title: tooltip,
            "aria-label": tooltip,
            onClick: clickable ? () => openTask(task) : void 0
          },
          /* @__PURE__ */ h(
            "span",
            {
              className: "orch-taskchip-mark",
              style: { color: TONE_COLOR2[visual.tone] || TONE_COLOR2.muted },
              "aria-hidden": "true"
            },
            /* @__PURE__ */ h(
              Icon,
              {
                name: visual.icon,
                size: 12,
                className: visual.className === "" ? void 0 : visual.className
              }
            )
          ),
          /* @__PURE__ */ h("span", { className: "orch-taskchip-title" }, chipVisibleTitle2(task.title))
        );
      };
      const more = view.rest > 0 ? /* @__PURE__ */ h(
        "button",
        {
          key: "chip-more",
          type: "button",
          className: "orch-taskchip orch-taskchip--more",
          title: `还有 ${view.rest} 个关联任务`,
          "aria-label": `还有 ${view.rest} 个关联任务`,
          onClick: typeof openPanel === "function" ? openPanel : void 0
        },
        `+${view.rest}`
      ) : null;
      return /* @__PURE__ */ h(
        "div",
        {
          className: "orch-chips",
          "data-orch-chip-row": "true",
          "data-orch-chip-total": String(view.total)
        },
        [...view.chips.map(chipNode), more]
      );
    };
    const LauncherPanel = ({ openMain, openSession, clearPanel }) => {
      const [error, setError] = React.useState(null);
      const started = React.useRef(false);
      const run = React.useCallback(async () => {
        setError(null);
        try {
          const body = await openMain();
          openSession(body.sessionId);
          clearPanel();
        } catch (failure) {
          setError(`打开主会话失败：${String(failure && failure.message || failure)}`);
        }
      }, [openMain, openSession, clearPanel]);
      React.useEffect(() => {
        if (started.current) return;
        started.current = true;
        void run();
      }, [run]);
      return /* @__PURE__ */ h("div", { className: "orch-shell orch-launcher" }, /* @__PURE__ */ h("div", { className: "orch-launcher-card" }, /* @__PURE__ */ h("span", { className: "orch-brand-mark" }, /* @__PURE__ */ h(Icon, { name: "sparkle", size: 14 })), /* @__PURE__ */ h("div", { className: "orch-title" }, error === null ? "正在打开主会话…" : "打开主会话失败"), error === null ? /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: 120 } }) : null, error === null ? null : /* @__PURE__ */ h("button", { type: "button", className: "orch-btn orch-btn--primary", onClick: run }, "重试")), error === null ? null : /* @__PURE__ */ h("div", { style: { width: "min(420px, 100%)" } }, /* @__PURE__ */ h(Banner, { tone: "error" }, error)));
    };
    const TasksPanel = ({ openSession, openArtifactPreview, focus }) => {
      const [snapshot, setSnapshot] = React.useState(null);
      const [snapshotError, setSnapshotError] = React.useState(null);
      const [actionError, setActionError] = React.useState(null);
      const [actionNotice, setActionNotice] = React.useState(null);
      const [refreshing, setRefreshing] = React.useState(false);
      const [openingMain, setOpeningMain] = React.useState(false);
      const [openedMain, setOpenedMain] = React.useState(false);
      const [expanded, setExpanded] = React.useState([]);
      const [filter, setFilter] = React.useState("all");
      const [query, setQuery] = React.useState("");
      const [detail, setDetail] = React.useState(null);
      const [detailError, setDetailError] = React.useState(null);
      const [detailLoading, setDetailLoading] = React.useState(false);
      const [detailTaskId, setDetailTaskId] = React.useState(null);
      const [collapsedSections, setCollapsedSections] = React.useState([]);
      const [confirmStop, setConfirmStop] = React.useState(null);
      const [confirmClose, setConfirmClose] = React.useState(null);
      const [confirmDelete, setConfirmDelete] = React.useState(null);
      const [artifactData, setArtifactData] = React.useState(null);
      const [artifactError, setArtifactError] = React.useState(null);
      const [artifactLoading, setArtifactLoading] = React.useState(false);
      const [artifactGroup, setArtifactGroup] = React.useState("project");
      const [preview, setPreview] = React.useState(null);
      const [copyNotice, setCopyNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const inFlight = React.useRef(/* @__PURE__ */ new Set());
      const detailSeq = React.useRef(0);
      const load = React.useCallback(async (signal) => {
        try {
          const next = await readSnapshot2(signal);
          setSnapshot(next);
          setSnapshotError(null);
          return true;
        } catch (failure) {
          if (signal === void 0 || !signal.aborted) setSnapshotError(String(failure && failure.message || failure));
          return false;
        }
      }, []);
      const loadArtifacts = React.useCallback(async (signal) => {
        setArtifactLoading(true);
        try {
          const next = await readArtifacts2(200, signal);
          setArtifactData(next);
          setArtifactError(null);
        } catch (failure) {
          if (signal === void 0 || !signal.aborted) setArtifactError(String(failure && failure.message || failure));
        } finally {
          if (signal === void 0 || !signal.aborted) setArtifactLoading(false);
        }
      }, []);
      React.useEffect(() => {
        if (filter !== "artifacts") return void 0;
        const controller = new AbortController();
        void loadArtifacts(controller.signal);
        return () => controller.abort();
      }, [filter, loadArtifacts]);
      React.useEffect(() => {
        const controller = new AbortController();
        let stopped = false;
        let timer;
        const tick = async () => {
          const ok = await load(controller.signal);
          if (stopped || controller.signal.aborted) return;
          timer = setTimeout(tick, ok ? POLL_MS2 : POLL_BACKOFF_MS2);
        };
        void tick();
        return () => {
          stopped = true;
          controller.abort();
          clearTimeout(timer);
        };
      }, [load]);
      const refresh = async () => {
        setRefreshing(true);
        await load(void 0);
        if (filter === "artifacts") await loadArtifacts(void 0);
        setRefreshing(false);
      };
      const open = (id) => {
        if (typeof id !== "string" || id === "") return;
        try {
          openSession(id);
          setActionError(null);
        } catch (failure) {
          setActionError(`打开会话失败：${String(failure && failure.message || failure)}`);
        }
      };
      const handleOpenMain = async () => {
        if (openingMain) return;
        setOpeningMain(true);
        setOpenedMain(false);
        try {
          const body = await openMainOnce2();
          setActionError(null);
          open(body.sessionId);
          setOpenedMain(true);
        } catch (failure) {
          setActionError(`打开主会话失败：${String(failure && failure.message || failure)}`);
        } finally {
          setOpeningMain(false);
        }
      };
      const toggleArtifacts = (id) => {
        setExpanded((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
      };
      const openDetail = async (id) => {
        if (typeof id !== "string" || id === "") return;
        const turn = ++detailSeq.current;
        setDetailTaskId(id);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(true);
        setCopyNotice(null);
        setConfirmStop(null);
        setConfirmClose(null);
        setConfirmDelete(null);
        try {
          const body = await readDetail2(id);
          if (turn !== detailSeq.current) return;
          setDetail(body);
        } catch (failure) {
          if (turn !== detailSeq.current) return;
          setDetailError(`详情加载失败：${String(failure && failure.message || failure)}`);
        } finally {
          if (turn === detailSeq.current) setDetailLoading(false);
        }
      };
      const closeDetail = () => {
        detailSeq.current += 1;
        setDetail(null);
        setDetailError(null);
        setDetailLoading(false);
        setDetailTaskId(null);
        setCopyNotice(null);
        setConfirmStop(null);
        setConfirmClose(null);
        setConfirmDelete(null);
        setFocusNotice(null);
      };
      const drawerOpen = detailLoading || detail !== null || detailError !== null;
      React.useEffect(() => {
        if (!drawerOpen) return void 0;
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return void 0;
        const onKeyDown = (event) => {
          if (event !== null && typeof event === "object" && event.key === "Escape") closeDetail();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
          try {
            window.removeEventListener("keydown", onKeyDown);
          } catch {
          }
        };
      }, [drawerOpen]);
      const [focusNotice, setFocusNotice] = React.useState(null);
      const focusConsumed = React.useRef(false);
      React.useEffect(() => {
        if (focusConsumed.current || focus === void 0 || focus === null || typeof focus.take !== "function") return;
        focusConsumed.current = true;
        const id = focus.take();
        const notice = typeof focus.takeNotice === "function" ? focus.takeNotice() : null;
        if (typeof notice === "string" && notice !== "") setFocusNotice(notice);
        if (typeof id === "string" && id !== "") void openDetail(id);
      }, [focus]);
      const copyPath = async (path) => {
        const value = String(path ?? "");
        if (value === "") return;
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(value);
          } else if (typeof document !== "undefined" && typeof document.execCommand === "function") {
            const area = document.createElement("textarea");
            area.value = value;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.top = "-1000px";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(area);
            if (!copied) throw new Error("浏览器拒绝写入剪贴板");
          } else {
            throw new Error("当前环境不支持剪贴板");
          }
          setActionError(null);
          setCopyNotice(`已复制路径：${value}`);
        } catch (failure) {
          setCopyNotice(null);
          setActionError(`复制路径失败：${String(failure && failure.message || failure)}`);
        }
      };
      const togglePreview = async (taskId, path) => {
        const key = `${taskId}:${path}`;
        if (preview !== null && preview.key === key && preview.loading !== true) {
          setPreview(null);
          return;
        }
        setPreview({ key, loading: true, data: null, error: null });
        try {
          const data = await readPreview2(taskId, path);
          setPreview((current) => current !== null && current.key === key ? { key, loading: false, data, error: null } : current);
        } catch (failure) {
          const message = String(failure && failure.message || failure);
          setPreview((current) => current !== null && current.key === key ? { key, loading: false, data: null, error: message } : current);
        }
      };
      const isRegisteredArtifact = (path) => typeof path === "string" && path !== "" && [
        ...tasks.flatMap((task) => Array.isArray(task.artifacts) ? task.artifacts : []),
        ...Array.isArray(artifactData?.items) ? artifactData.items : [],
        ...Array.isArray(detail?.task?.artifacts) ? detail.task.artifacts : []
      ].some((item) => item?.path === path);
      const previewInSidebar = async (taskId, path, inlineFallback = false) => {
        if (!isRegisteredArtifact(path)) {
          setActionNotice("这个路径不是本任务的已登记产物，不能预览；先「复制路径」再本地打开");
          return;
        }
        const opened = openArtifactPreview(path);
        if (opened.ok === true) {
          setPreview(null);
          setActionError(null);
          return;
        }
        const why = opened.reason === "sidebar-missing" ? "当前宿主没有右侧栏预览能力" : opened.reason === "no-session" ? "拿不到当前会话，无法定位预览作用域" : opened.reason === "bad-path" ? "这条产物路径不可用" : `宿主拒绝打开${opened.message === void 0 ? "" : `：${opened.message}`}`;
        if (inlineFallback === true) {
          setActionNotice(`右侧栏不可用（${why}），已改为行内预览`);
          await togglePreview(taskId, path);
          return;
        }
        setActionNotice(`右侧栏不可用（${why}）：到「产物」页可看行内预览，或先「复制路径」再本地打开`);
      };
      const runPanel = async (endpoint, id, extra = {}) => {
        const key = `${endpoint}:${id}`;
        if (inFlight.current.has(key)) return;
        inFlight.current.add(key);
        setBusy(key);
        setActionError(null);
        setActionNotice(null);
        setConfirmStop(null);
        setConfirmClose(null);
        setConfirmDelete(null);
        try {
          const result = await panelAction2(endpoint, id, extra);
          if (result && result.already === true) {
            if (endpoint === "message") setActionNotice("这条消息已发送过，未重复投递");
            else if (endpoint === "retry") {
              setActionNotice(`已有活跃重派任务（${STATUS_LABEL2[result.status] || result.status || "处理中"}），未重复创建`);
            } else if (endpoint === "close") {
              setActionNotice("任务已完成，无需重复确认");
            } else {
              setActionNotice(`任务已是该状态（${STATUS_LABEL2[result.status] || result.status || "已结束"}），无需重复停止`);
            }
          }
          if (endpoint === "close" && result && result.ok === true && result.already !== true) {
            setActionNotice("已确认交付，任务完成");
          }
          if (endpoint === "delete" && result && result.ok === true) {
            setActionNotice("已删除这条任务记录（消息/通知已级联清理）");
          }
          await load(void 0);
          if (filter === "artifacts") await loadArtifacts(void 0);
          if (detailTaskId === id) {
            if (endpoint === "delete") closeDetail();
            else await openDetail(id);
          }
        } catch (failure) {
          const code = failure && typeof failure.code === "string" && failure.code !== "" ? `（${failure.code}）` : "";
          setActionError(`${endpoint} 失败${code}：${String(failure && failure.message || failure)}`);
        } finally {
          inFlight.current.delete(key);
          setBusy(null);
        }
      };
      const mainSession = snapshot && snapshot.mainSession || { id: null, live: false };
      const tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : [];
      const counts = countTasks2(tasks);
      const visible = tasks.filter((task) => matchesFilter2(task, filter) && matchesQuery2(task, query));
      const mainState = mainSession.id === null ? "主会话未创建" : mainSession.live ? "主会话在线" : "主会话已失效";
      const inboxCount = Number(snapshot && snapshot.inboxCount) || 0;
      const detailTask = detail !== null && detail !== void 0 && detail.task !== null && typeof detail.task === "object" ? detail.task : null;
      const drawerTitle = detailTask === null ? detailTaskId === null ? "任务详情" : `任务 ${detailTaskId}` : displayNameOf2(detailTask, tasks);
      const act = (handler) => (event) => {
        if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") event.stopPropagation();
        handler(event);
      };
      const statusBadge = (status) => /* @__PURE__ */ h(Badge, { tone: STATUS_TONE2[status] || "muted", title: STATUS_LABEL2[status] || status }, STATUS_LABEL2[status] || status || "未知");
      const stopControl = (task) => {
        if (task.status === "done" || task.status === "cancelled" || task.status === "orphaned") return null;
        if (confirmStop === task.id) {
          return /* @__PURE__ */ h("span", { key: "stop-confirm", className: "orch-confirm" }, /* @__PURE__ */ h("span", null, "确认停止？"), /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm orch-btn--danger",
              disabled: busy === `stop:${task.id}`,
              onClick: act(() => void runPanel("stop", task.id))
            },
            "确认停止"
          ), /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: act(() => setConfirmStop(null))
            },
            "取消"
          ));
        }
        return /* @__PURE__ */ h(
          "button",
          {
            key: "stop",
            type: "button",
            className: "orch-btn orch-btn--sm orch-btn--danger",
            title: "停止子会话（需要二次确认）",
            disabled: busy === `stop:${task.id}`,
            onClick: act(() => setConfirmStop(task.id))
          },
          /* @__PURE__ */ h(Icon, { name: "stop" }),
          busy === `stop:${task.id}` ? "停止中…" : "停止"
        );
      };
      const retryControl = (task) => task.status === "failed" || task.status === "orphaned" ? /* @__PURE__ */ h(
        "button",
        {
          key: "retry",
          type: "button",
          className: "orch-btn orch-btn--sm",
          title: "用同一份 brief 重派",
          disabled: busy === `retry:${task.id}`,
          onClick: act(() => void runPanel("retry", task.id))
        },
        /* @__PURE__ */ h(Icon, { name: "retry", className: busy === `retry:${task.id}` ? "orch-spin" : void 0 }),
        busy === `retry:${task.id}` ? "重派中…" : "重派"
      ) : null;
      const closeControl = (task) => {
        if (task === null || task === void 0 || task.canClose !== true) return null;
        if (task.status === "done") return null;
        if (confirmClose === task.id) {
          return /* @__PURE__ */ h("span", { key: "close-confirm", className: "orch-confirm" }, /* @__PURE__ */ h("span", null, "确认交付完成？"), /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm",
              disabled: busy === `close:${task.id}`,
              onClick: act(() => void runPanel("close", task.id))
            },
            busy === `close:${task.id}` ? "确认中…" : "确认"
          ), /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: act(() => setConfirmClose(null))
            },
            "取消"
          ));
        }
        return /* @__PURE__ */ h(
          "button",
          {
            key: "close",
            type: "button",
            className: "orch-btn orch-btn--sm",
            title: "确认这条已交付任务完成（done，不可逆）",
            disabled: busy === `close:${task.id}`,
            onClick: act(() => setConfirmClose(task.id))
          },
          /* @__PURE__ */ h(Icon, { name: "check" }),
          "确认交付"
        );
      };
      const deleteControl = (task) => {
        const deletable = task !== null && task !== void 0 && task.canDelete === true;
        if (!deletable) return null;
        if (confirmDelete === task.id) {
          return /* @__PURE__ */ h("span", { key: "delete-confirm", className: "orch-confirm" }, /* @__PURE__ */ h("span", null, "确认删除？"), /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm orch-btn--danger",
              disabled: busy === `delete:${task.id}`,
              onClick: act(() => void runPanel("delete", task.id))
            },
            busy === `delete:${task.id}` ? "删除中…" : "确认删除"
          ), /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: act(() => setConfirmDelete(null))
            },
            "取消"
          ));
        }
        return /* @__PURE__ */ h(
          "button",
          {
            key: "delete",
            type: "button",
            className: "orch-btn orch-btn--sm orch-btn--danger",
            title: "从台账删除这条任务与它的消息/通知（需要二次确认）",
            disabled: busy === `delete:${task.id}`,
            onClick: act(() => setConfirmDelete(task.id))
          },
          /* @__PURE__ */ h(Icon, { name: "trash" }),
          "删除"
        );
      };
      const openControl = (sessionId, label) => /* @__PURE__ */ h(
        "button",
        {
          key: `open:${label || "child"}`,
          type: "button",
          className: "orch-btn orch-btn--sm",
          disabled: sessionId === null || sessionId === void 0,
          onClick: act(() => open(sessionId))
        },
        /* @__PURE__ */ h(Icon, { name: "external" }),
        label || "打开子会话"
      );
      const topbar = () => /* @__PURE__ */ h("header", { className: "orch-topbar" }, /* @__PURE__ */ h("div", { className: "orch-brand" }, /* @__PURE__ */ h("span", { className: "orch-brand-mark" }, /* @__PURE__ */ h(Icon, { name: "sparkle", size: 14 })), /* @__PURE__ */ h("span", { className: "orch-title" }, inboxCount > 0 ? `任务 · 待你决定 ${inboxCount}` : "任务"), /* @__PURE__ */ h(
        "span",
        {
          className: "orch-status",
          "data-live": mainSession.live === true ? "true" : "false",
          title: mainSession.id === null ? "还没有主会话" : `主会话编号 ${mainSession.id}`
        },
        /* @__PURE__ */ h("span", { className: "orch-status-dot" }),
        mainState
      )), /* @__PURE__ */ h("div", { className: "orch-topbar-actions" }, /* @__PURE__ */ h("label", { className: "orch-search", title: "按标题 / 编号 / 目录搜索" }, /* @__PURE__ */ h(Icon, { name: "search", size: 13 }), /* @__PURE__ */ h(
        "input",
        {
          type: "search",
          value: query,
          placeholder: "搜索任务",
          "aria-label": "搜索任务",
          onChange: (event) => setQuery(event.target.value)
        }
      )), /* @__PURE__ */ h(
        "button",
        {
          type: "button",
          className: "orch-btn orch-btn--ghost",
          title: "重新拉取台账快照",
          onClick: refresh,
          disabled: refreshing
        },
        /* @__PURE__ */ h(Icon, { name: "refresh", className: refreshing ? "orch-spin" : void 0 }),
        refreshing ? "刷新中…" : "刷新"
      ), /* @__PURE__ */ h(
        "button",
        {
          type: "button",
          className: "orch-btn orch-btn--primary",
          onClick: handleOpenMain,
          disabled: openingMain
        },
        /* @__PURE__ */ h(Icon, { name: "plus" }),
        openingMain ? "打开中…" : "打开主会话"
      )));
      const metrics = () => /* @__PURE__ */ h("div", { className: "orch-metrics" }, METRICS2.map(([value, label]) => /* @__PURE__ */ h(
        "button",
        {
          key: value,
          type: "button",
          className: "orch-metric",
          "data-active": filter === value ? "true" : "false",
          "data-tone": value === "failed" ? "bad" : value === "done" ? "good" : value === "waiting" ? "warn" : "info",
          onClick: () => setFilter(value)
        },
        /* @__PURE__ */ h("span", { className: "orch-metric-value" }, String(counts[value] || 0)),
        /* @__PURE__ */ h("span", { className: "orch-metric-label" }, label)
      )));
      const rail = () => /* @__PURE__ */ h("nav", { className: "orch-rail", "aria-label": "任务筛选" }, FILTERS2.map(([value, label]) => /* @__PURE__ */ h(
        "button",
        {
          key: value,
          type: "button",
          className: "orch-rail-item",
          "data-active": filter === value ? "true" : "false",
          "aria-pressed": filter === value,
          onClick: () => setFilter(value)
        },
        /* @__PURE__ */ h(
          Icon,
          {
            name: value === "artifacts" ? "folder" : value === "waiting" ? "inbox" : value === "failed" ? "alert" : value === "done" ? "check" : "clock",
            size: 13
          }
        ),
        /* @__PURE__ */ h("span", { className: "orch-rail-label" }, label),
        /* @__PURE__ */ h("span", { className: "orch-rail-count" }, String(value === "all" ? counts.all : counts[value] || 0))
      )));
      const alerts = () => /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, snapshotError !== null ? /* @__PURE__ */ h(
        Banner,
        {
          tone: "error",
          icon: "alert",
          action: /* @__PURE__ */ h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: refresh }, "重试")
        },
        `台账暂不可用：${snapshotError}`
      ) : null, actionError !== null ? /* @__PURE__ */ h(
        Banner,
        {
          tone: "error",
          icon: "alert",
          action: /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: () => setActionError(null)
            },
            "关闭"
          )
        },
        actionError
      ) : null, actionNotice !== null ? /* @__PURE__ */ h(Banner, { tone: "notice", icon: "check" }, actionNotice) : null, copyNotice !== null ? /* @__PURE__ */ h(Banner, { tone: "info", icon: "copy" }, copyNotice) : null, inboxCount > 0 ? /* @__PURE__ */ h(
        Banner,
        {
          tone: "notice",
          icon: "inbox",
          action: /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: () => setFilter("waiting")
            },
            "查看"
          )
        },
        `有 ${inboxCount} 个任务等你决定，切到「待你决定」查看。`
      ) : null, openedMain ? /* @__PURE__ */ h(Banner, { tone: "info", icon: "check" }, "主会话已就绪；若仍停在 Bot 会话里，请从左侧会话列表打开「主会话」。") : null, snapshot !== null && mainSession.id === null ? /* @__PURE__ */ h(Banner, { tone: "notice", icon: "alert" }, "尚未打开主会话：点右上角「打开主会话」，在指挥舱里创建。") : null);
      const renderTask = (task, all) => {
        const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
        const isExpanded = expanded.includes(task.id);
        const displayName = displayNameOf2(task, all);
        const tone = TONE_COLOR2[task.tone] || TONE_COLOR2.muted;
        return /* @__PURE__ */ h(
          "article",
          {
            key: task.id,
            className: "orch-card",
            "data-open": detailTaskId === task.id ? "true" : "false",
            "data-status": task.status,
            onClick: (event) => {
              if (event !== null && typeof event === "object") void openDetail(task.id);
            }
          },
          /* @__PURE__ */ h("div", { className: "orch-card-top" }, /* @__PURE__ */ h("span", { className: "orch-dot", style: { background: tone, color: tone } }), /* @__PURE__ */ h("span", { className: "orch-card-title", title: displayName }, displayName), statusBadge(task.status), task.planState === "planning" ? /* @__PURE__ */ h(Badge, { tone: "info", title: "计划模式：子会话只读探索，用 task_report blocked 上报计划，批准后自动切回可写" }, "计划中") : null, ["created", "reused"].includes(task.worktreeState) ? /* @__PURE__ */ h(Badge, { tone: "info", title: `worktree 隔离：产物在分支 ${task.worktreeBranch || "(未知)"} 的检出目录 ${task.worktreePath || "(未知)"}，合并由你决定` }, "隔离") : null, /* @__PURE__ */ h("span", { className: "orch-card-time", title: "最近事件" }, timeLabel2(task.lastEventAt))),
          /* @__PURE__ */ h("div", { className: "orch-card-meta" }, task.targetDir !== null && task.targetDir !== void 0 ? /* @__PURE__ */ h(Chip, { title: task.targetDir }, /* @__PURE__ */ h(Icon, { name: "folder", size: 11 }), shortPath2(task.targetDir)) : null, task.groupId ? /* @__PURE__ */ h(Chip, { title: "分组" }, `组 ${task.groupId}`) : null, task.priority ? /* @__PURE__ */ h(Chip, { title: "优先级" }, `P${task.priority}`) : null, task.dependsOn && task.dependsOn.length > 0 ? /* @__PURE__ */ h(Chip, { title: task.dependsOn.join("、") }, `依赖 ${task.dependsOn.length}`) : null, task.queued ? /* @__PURE__ */ h(Chip, null, "排队中") : null, task.stale ? /* @__PURE__ */ h(Chip, { tone: "warn", title: "超过 30 分钟没有新事件" }, "⚠ 可能卡住") : null, task.goalState ? /* @__PURE__ */ h(Chip, { title: "平台目标状态（只读）" }, /* @__PURE__ */ h(Icon, { name: "goal", size: 11 }), `目标·${GOAL_PHASE_LABEL2[task.goalState.phase] || task.goalState.phase || "未知"}`) : null, task.readOnly === true ? /* @__PURE__ */ h(Chip, { tone: "warn", title: "只读任务：写文件/写 shell 会被沙箱拒绝" }, "只读") : null, task.planFirst === true ? /* @__PURE__ */ h(
            Chip,
            {
              tone: task.planState === "planning" ? "info" : "muted",
              title: "计划模式：plan_state 由台账下发（只读展示）"
            },
            `计划·${PLAN_STATE_LABEL2[task.planState] || task.planState || "无计划状态"}`
          ) : null, task.worktreeState && task.worktreeState !== "none" ? /* @__PURE__ */ h(
            Chip,
            {
              tone: task.worktreeState === "failed" ? "bad" : ["created", "reused"].includes(task.worktreeState) ? "info" : "muted",
              title: task.worktreePath ? `检出 ${task.worktreePath}` : "未建检出"
            },
            `隔离·${WORKTREE_STATE_LABEL2?.[task.worktreeState] || task.worktreeState}`
          ) : null, artifacts.length > 0 ? /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--sm",
              "aria-expanded": isExpanded,
              onClick: act(() => toggleArtifacts(task.id))
            },
            /* @__PURE__ */ h(Icon, { name: "chevron", className: "orch-chevron", "data-open": isExpanded ? "true" : "false" }),
            `产物 ${artifacts.length}`
          ) : null),
          /* @__PURE__ */ h("div", { className: "orch-card-actions" }, /* @__PURE__ */ h(
            "button",
            {
              key: "detail",
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: act(() => void openDetail(task.id))
            },
            /* @__PURE__ */ h(Icon, { name: "chevron" }),
            "详情"
          ), stopControl(task), closeControl(task), retryControl(task), openControl(task.childSessionId), deleteControl(task)),
          artifacts.length > 0 ? /* @__PURE__ */ h("div", { className: "orch-expand", "data-open": isExpanded ? "true" : "false" }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "orch-artifact-list" }, artifacts.map((item, index) => {
            const itemTone = item.exists === false ? TONE_COLOR2.bad : TONE_COLOR2.good;
            return /* @__PURE__ */ h("div", { key: `${item.path}:${index}`, className: "orch-artifact" }, /* @__PURE__ */ h("span", { className: "orch-dot", style: { background: itemTone, color: itemTone } }), /* @__PURE__ */ h(
              "button",
              {
                type: "button",
                className: "orch-artifact-path orch-artifact-open",
                title: item.exists === false ? `${item.path}（未找到）` : `在右侧栏预览 ${item.path}`,
                disabled: item.exists === false,
                onClick: act(() => void previewInSidebar(task.id, item.path))
              },
              `${item.path}${item.exists === false ? "（未找到）" : ""}`
            ), item.label ? /* @__PURE__ */ h("span", { className: "orch-muted" }, item.label) : null);
          })))) : null,
          task.question ? /* @__PURE__ */ h("div", { className: "orch-question" }, /* @__PURE__ */ h(Icon, { name: "alert", size: 13 }), /* @__PURE__ */ h("span", null, `需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(" / ")}）` : ""}`)) : null
        );
      };
      const artifactItems = Array.isArray(artifactData && artifactData.items) ? artifactData.items : [];
      const previewBlock = () => {
        if (preview === null) return null;
        if (preview.loading === true) {
          return /* @__PURE__ */ h("div", { className: "orch-preview" }, /* @__PURE__ */ h("div", { className: "orch-muted" }, "加载预览…"), /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: "72%" } }));
        }
        if (preview.error !== null) {
          return /* @__PURE__ */ h("div", { className: "orch-preview" }, /* @__PURE__ */ h(Banner, { tone: "error" }, `预览失败：${preview.error}`));
        }
        const data = preview.data || {};
        if (data.kind === "text") {
          return /* @__PURE__ */ h("div", { className: "orch-preview" }, /* @__PURE__ */ h("div", { className: "orch-muted" }, `${data.size ?? 0} 字节${data.truncated === true ? "（仅显示前 64 KiB）" : ""}`), /* @__PURE__ */ h("pre", { className: "orch-pre" }, data.text === "" ? "（空文件）" : data.text));
        }
        if (data.kind === "directory") {
          return /* @__PURE__ */ h("div", { className: "orch-preview" }, /* @__PURE__ */ h(Banner, { tone: "notice", icon: "folder" }, "这是目录，不能预览内容；复制路径后在文件管理器打开。"));
        }
        if (data.kind === "binary") {
          return /* @__PURE__ */ h("div", { className: "orch-preview" }, /* @__PURE__ */ h(Banner, { tone: "notice", icon: "alert" }, "二进制文件，不能按文本预览；复制路径后在本地打开。"));
        }
        return /* @__PURE__ */ h("div", { className: "orch-preview" }, /* @__PURE__ */ h("div", { className: "orch-muted" }, "没有可预览的内容。"));
      };
      const artifactRow = (item) => {
        const key = `${item.taskId}:${item.path}`;
        const tone = item.exists === false ? TONE_COLOR2.bad : TONE_COLOR2.good;
        return /* @__PURE__ */ h("div", { key, className: "orch-artifact" }, /* @__PURE__ */ h("span", { className: "orch-dot", style: { background: tone, color: tone } }), /* @__PURE__ */ h("span", { className: "orch-artifact-path", title: item.path }, item.path), item.label ? /* @__PURE__ */ h("span", { className: "orch-muted" }, item.label) : null, item.exists === false ? /* @__PURE__ */ h(Chip, { tone: "bad" }, "（未找到）") : null, /* @__PURE__ */ h(Chip, { title: "来源任务" }, `${item.title || item.taskId}${item.status ? ` · ${STATUS_LABEL2[item.status] || item.status}` : ""}`), /* @__PURE__ */ h("span", { className: "orch-msg-at" }, timeLabel2(item.at)), /* @__PURE__ */ h(
          "button",
          {
            type: "button",
            className: "orch-btn orch-btn--sm",
            disabled: item.exists === false,
            onClick: () => void previewInSidebar(item.taskId, item.path, true)
          },
          "预览"
        ), /* @__PURE__ */ h(
          "button",
          {
            type: "button",
            className: "orch-btn orch-btn--sm",
            onClick: () => void copyPath(item.path)
          },
          "复制路径"
        ), item.childSessionId ? /* @__PURE__ */ h(
          "button",
          {
            type: "button",
            className: "orch-btn orch-btn--sm",
            onClick: () => open(item.childSessionId)
          },
          "打开子会话"
        ) : null, /* @__PURE__ */ h(
          "button",
          {
            type: "button",
            className: "orch-btn orch-btn--sm",
            onClick: () => void openDetail(item.taskId)
          },
          "详情"
        ), preview !== null && preview.key === key ? previewBlock() : null);
      };
      const artifactView = () => {
        if (artifactData === null) {
          if (artifactError !== null) {
            return /* @__PURE__ */ h(
              Banner,
              {
                tone: "error",
                icon: "alert",
                action: /* @__PURE__ */ h(
                  "button",
                  {
                    type: "button",
                    className: "orch-btn orch-btn--sm",
                    onClick: () => void loadArtifacts(void 0)
                  },
                  "重新加载"
                )
              },
              `产物加载失败：${artifactError}`
            );
          }
          return artifactLoading ? /* @__PURE__ */ h(SkeletonList, { rows: 3 }) : /* @__PURE__ */ h(EmptyState, { icon: "folder", title: "产物库还没加载", hint: "点「刷新」重新拉取产物库。" });
        }
        return /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, /* @__PURE__ */ h("div", { className: "orch-card-meta" }, /* @__PURE__ */ h("span", { className: "orch-muted" }, `共 ${artifactItems.length} 个产物${artifactError !== null ? "（刷新失败，显示上次结果）" : ""}`), /* @__PURE__ */ h("div", { className: "orch-seg" }, /* @__PURE__ */ h(
          "button",
          {
            type: "button",
            className: "orch-seg-item",
            "data-active": artifactGroup === "project" ? "true" : "false",
            onClick: () => setArtifactGroup("project")
          },
          "按项目"
        ), /* @__PURE__ */ h(
          "button",
          {
            type: "button",
            className: "orch-seg-item",
            "data-active": artifactGroup === "date" ? "true" : "false",
            onClick: () => setArtifactGroup("date")
          },
          "按日期"
        ))), artifactError !== null ? /* @__PURE__ */ h(Banner, { tone: "error", icon: "alert" }, `产物加载失败：${artifactError}`) : null, artifactItems.length === 0 ? /* @__PURE__ */ h(
          EmptyState,
          {
            icon: "folder",
            title: "还没有产物",
            hint: "还没有产物。任务 done 时会自动收集改动文件；也可以显式传 task_report.artifacts。"
          }
        ) : /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } }, groupArtifacts2(artifactItems, artifactGroup).map(([name, rows]) => /* @__PURE__ */ h("section", { key: `${artifactGroup}:${name}`, className: "orch-group" }, /* @__PURE__ */ h("div", { className: "orch-group-head" }, /* @__PURE__ */ h("span", { className: "orch-group-title" }, name), /* @__PURE__ */ h("span", { className: "orch-muted" }, `${rows.length} 个`)), /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, rows.map(artifactRow))))));
      };
      const listView = () => {
        if (snapshot === null) {
          if (snapshotError === null) return /* @__PURE__ */ h(SkeletonList, { rows: 5 });
          return /* @__PURE__ */ h(
            EmptyState,
            {
              icon: "alert",
              title: "台账还没就绪",
              hint: "快照请求失败，点上面的「重试」重新拉取；也可以直接「打开主会话」进去看看。"
            }
          );
        }
        if (visible.length === 0) {
          return tasks.length === 0 ? /* @__PURE__ */ h(
            EmptyState,
            {
              icon: "inbox",
              title: "还没有任务",
              hint: "在主会话里用 task_create 建第一个任务；面板会实时同步状态、依赖和产物。"
            }
          ) : /* @__PURE__ */ h(
            EmptyState,
            {
              icon: "search",
              title: "没有匹配的任务",
              hint: "换个筛选项，或清空搜索框再试。",
              action: /* @__PURE__ */ h(
                "button",
                {
                  type: "button",
                  className: "orch-btn orch-btn--ghost orch-btn--sm",
                  onClick: () => {
                    setFilter("all");
                    setQuery("");
                  }
                },
                "清空筛选"
              )
            }
          );
        }
        return /* @__PURE__ */ h("div", { className: "orch-list" }, visible.map((task) => renderTask(task, tasks)));
      };
      const drawerLoading = () => /* @__PURE__ */ h("div", { className: "orch-drawer-sections" }, /* @__PURE__ */ h("div", { className: "orch-skeleton-card" }, /* @__PURE__ */ h("div", { className: "orch-skeleton-row" }, /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: "40%" } }), /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: 60, marginLeft: "auto" } })), /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: "86%" } }), /* @__PURE__ */ h("div", { className: "orch-skeleton", style: { width: "72%" } })), /* @__PURE__ */ h(SkeletonList, { rows: 2 }));
      const drawerError = () => /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ h(Banner, { tone: "error", icon: "alert" }, detailError), /* @__PURE__ */ h("div", { className: "orch-card-actions" }, /* @__PURE__ */ h(
        "button",
        {
          type: "button",
          className: "orch-btn orch-btn--ghost",
          onClick: () => {
            if (detailTaskId !== null) void openDetail(detailTaskId);
          }
        },
        "重新加载"
      ), /* @__PURE__ */ h("button", { type: "button", className: "orch-btn", onClick: closeDetail }, "关闭")));
      const detailSection = (key, title, hint, body) => {
        const isCollapsed = collapsedSections.includes(key);
        return /* @__PURE__ */ h("section", { key, className: "orch-section", "data-collapsed": isCollapsed ? "true" : "false" }, /* @__PURE__ */ h(
          "button",
          {
            type: "button",
            className: "orch-section-head",
            "aria-expanded": !isCollapsed,
            onClick: () => setCollapsedSections((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
          },
          /* @__PURE__ */ h(Icon, { name: "chevron", className: "orch-chevron" }),
          /* @__PURE__ */ h("span", { className: "orch-section-title" }, title),
          hint ? /* @__PURE__ */ h("span", { className: "orch-section-hint" }, hint) : null
        ), /* @__PURE__ */ h("div", { className: "orch-section-body-wrap" }, /* @__PURE__ */ h("div", { className: "orch-section-body" }, /* @__PURE__ */ h("div", { className: "orch-section-inner" }, body))));
      };
      const detailBody = () => {
        const task = detail.task || {};
        const overviewBody = /* @__PURE__ */ h("div", { className: "orch-kv" }, [
          ["编号", task.id],
          ["状态", STATUS_LABEL2[task.status] || task.status || "未知"],
          // delivered 两段式：交付时间与关闭原因（协调者确认 / 超时自动完成）。
          ...task.deliveredAt ? [["交付", `${timeLabel2(task.deliveredAt)}（待确认：确认交付收成已完成；追问由协调者 task_message 续派原会话）`]] : [],
          ...task.closeReason ? [["关闭", task.closeReasonLabel || task.closeReason]] : [],
          ["目标目录", task.targetDir || "（未设置）"],
          ["分组", task.group || "（未分组）"],
          ["优先级", `P${task.priority === void 0 || task.priority === null ? 0 : task.priority}`],
          ["计划", task.planFirst === true ? PLAN_STATE_LABEL2[task.planState] || task.planState || "无计划状态" : "（不是计划任务）"],
          ["隔离", task.worktreeState && task.worktreeState !== "none" ? `${WORKTREE_STATE_LABEL2?.[task.worktreeState] || task.worktreeState}｜分支 ${task.worktreeBranch || "-"}｜检出 ${task.worktreePath || "-"}｜决定 ${WORKTREE_SOURCE_LABEL2?.[task.worktreeSource] || task.worktreeSource || "未知"}` : "（未隔离）"],
          ["写域", Array.isArray(task.writeScopes) && task.writeScopes.length > 0 ? task.writeScopes.join("、") : "（未声明）"],
          ["创建", timeLabel2(task.createdAt)],
          ["更新", timeLabel2(task.updatedAt)]
        ].flatMap(([key, value]) => [
          /* @__PURE__ */ h("span", { key: `${key}:k`, className: "orch-kv-key" }, key),
          /* @__PURE__ */ h("span", { key: `${key}:v`, className: "orch-kv-val" }, String(value === void 0 || value === null ? "" : value))
        ]));
        const lastMessage = task.lastMessage !== null && typeof task.lastMessage === "object" ? task.lastMessage : null;
        const lastMessageBody = lastMessage === null ? /* @__PURE__ */ h("div", { className: "orch-muted" }, "还没有返回消息（子会话结算后自动记录最后一条回复）。") : /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, /* @__PURE__ */ h("div", { className: "orch-card-meta" }, /* @__PURE__ */ h(Badge, { tone: "info" }, lastMessage.stored === "file" ? "全文在报告文件" : "内联正文"), lastMessage.stopReason ? /* @__PURE__ */ h(Chip, { title: "结束原因" }, lastMessage.stopReason) : null, /* @__PURE__ */ h("span", { className: "orch-msg-at" }, timeLabel2(lastMessage.at)), typeof lastMessage.chars === "number" ? /* @__PURE__ */ h("span", { className: "orch-msg-at" }, `${lastMessage.chars} 字`) : null), /* @__PURE__ */ h("pre", { className: "orch-pre" }, lastMessage.stored === "file" ? `${lastMessage.summary || ""}

全文：${lastMessage.path || "（路径缺失）"}` : String(lastMessage.text || lastMessage.summary || "（空）")));
        const brief = task.brief !== null && typeof task.brief === "object" && !Array.isArray(task.brief) ? task.brief : {};
        const briefGoal = textOf2(brief.goal) || textOf2(task.goal);
        const acceptance = listOf2(brief.acceptance);
        const constraints = listOf2(brief.constraints);
        const refs = listOf2(brief.refs);
        const verbatim = textOf2(brief.user_verbatim);
        const briefEmpty = briefGoal === "" && acceptance.length === 0 && constraints.length === 0 && refs.length === 0 && verbatim === "";
        const briefLists = (label, items) => /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "orch-kv-key" }, label), /* @__PURE__ */ h("ul", { className: "orch-ul" }, items.map((item, index) => /* @__PURE__ */ h("li", { key: index }, item))));
        const briefBody = briefEmpty ? /* @__PURE__ */ h("div", { className: "orch-muted" }, "这条任务没有 brief 信息。") : /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, briefGoal !== "" ? /* @__PURE__ */ h("div", { className: "orch-text" }, briefGoal) : null, acceptance.length > 0 ? briefLists("验收标准：", acceptance) : null, constraints.length > 0 ? briefLists("约束：", constraints) : null, refs.length > 0 ? briefLists("背景资料：", refs) : null, verbatim !== "" ? /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "orch-kv-key" }, "用户原话："), /* @__PURE__ */ h("blockquote", { className: "orch-quote" }, verbatim)) : null);
        const goalState = task.goalState !== null && typeof task.goalState === "object" ? task.goalState : null;
        const goalBody = goalState === null ? /* @__PURE__ */ h("div", { className: "orch-muted" }, "没有平台目标状态（goal 服务不可用，或任务尚未派发/已收口）。") : /* @__PURE__ */ h("div", { className: "orch-kv" }, [
          ["目标", textOf2(goalState.objective) || "（未记录）"],
          ["阶段", GOAL_PHASE_LABEL2[goalState.phase] || goalState.phase || "未知"],
          ["续轮", `${GOAL_ACTIVATION_LABEL2[goalState.activation] || goalState.activation || "未知"}（插件声明式接入，恒为不自动续轮）`],
          ["轮次", goalState.roundsStarted === null || goalState.roundsStarted === void 0 ? "-" : `${goalState.roundsStarted}/${goalState.maxGoalRounds === null || goalState.maxGoalRounds === void 0 ? "?" : goalState.maxGoalRounds}`],
          ["修订", goalState.revision === null || goalState.revision === void 0 ? "-" : String(goalState.revision)]
        ].flatMap(([key, value]) => [
          /* @__PURE__ */ h("span", { key: `${key}:k`, className: "orch-kv-key" }, key),
          /* @__PURE__ */ h("span", { key: `${key}:v`, className: "orch-kv-val" }, String(value))
        ]));
        const goalNote = /* @__PURE__ */ h("div", { className: "orch-muted" }, "只读展示：由插件在派发、续派与终态时自动维护；面板不提供暂停/恢复/清除操作。");
        const messages = Array.isArray(detail.messages) ? detail.messages : [];
        const shownMessages = messages.slice(-20);
        const messageBody = messages.length === 0 ? /* @__PURE__ */ h("div", { className: "orch-muted" }, "还没有消息。") : /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, shownMessages.map((row, index) => /* @__PURE__ */ h("div", { key: row.seq === void 0 ? index : row.seq, className: "orch-msg", "data-kind": row.kind }, /* @__PURE__ */ h("div", { className: "orch-msg-head" }, /* @__PURE__ */ h(Badge, { tone: "muted" }, MESSAGE_KIND_LABEL2[row.kind] || row.kind), row.delivery ? /* @__PURE__ */ h(
          Badge,
          {
            tone: DELIVERY_TONE2[row.delivery] || "muted",
            title: `投递状态：${DELIVERY_LABEL2[row.delivery] || row.delivery}`
          },
          DELIVERY_LABEL2[row.delivery] || row.delivery
        ) : null, /* @__PURE__ */ h("span", { className: "orch-msg-at" }, timeLabel2(row.at))), /* @__PURE__ */ h("div", { className: "orch-msg-text" }, row.text))), messages.length > shownMessages.length ? /* @__PURE__ */ h("div", { className: "orch-muted" }, `仅显示最近 ${shownMessages.length} 条（共 ${messages.length} 条）。`) : null);
        const dependencies = Array.isArray(detail.dependencies) ? detail.dependencies : [];
        const dependents = Array.isArray(detail.dependents) ? detail.dependents : [];
        const depRow = (row) => {
          const tone = TONE_COLOR2[STATUS_TONE2[row.status]] || TONE_COLOR2.muted;
          return /* @__PURE__ */ h("div", { key: `${row.status}:${row.id}`, className: "orch-artifact" }, /* @__PURE__ */ h("span", { className: "orch-dot", style: { background: tone, color: tone } }), /* @__PURE__ */ h("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere" }, title: row.error || row.id }, row.title), /* @__PURE__ */ h(Badge, { tone: STATUS_TONE2[row.status] || "muted" }, STATUS_LABEL2[row.status] || row.status || "未知"), row.error ? /* @__PURE__ */ h(Chip, { tone: "bad", title: row.error }, "有错误") : null);
        };
        const depBody = /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, /* @__PURE__ */ h("div", { className: "orch-kv-key" }, "上游（前置任务）"), dependencies.length === 0 ? /* @__PURE__ */ h("div", { className: "orch-muted" }, "没有前置任务。") : /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, dependencies.map(depRow)), /* @__PURE__ */ h("div", { className: "orch-kv-key" }, "下游（依赖本任务）"), dependents.length === 0 ? /* @__PURE__ */ h("div", { className: "orch-muted" }, "没有下游任务。") : /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, dependents.map(depRow)));
        const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
        const artifactBody = artifacts.length === 0 ? /* @__PURE__ */ h("div", { className: "orch-muted" }, "还没有产物。") : /* @__PURE__ */ h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, artifacts.map((item, index) => {
          const tone = item.exists === false ? TONE_COLOR2.bad : TONE_COLOR2.good;
          return /* @__PURE__ */ h("div", { key: `${item.path}:${index}`, className: "orch-artifact" }, /* @__PURE__ */ h("span", { className: "orch-dot", style: { background: tone, color: tone } }), /* @__PURE__ */ h(
            "button",
            {
              type: "button",
              className: "orch-artifact-path orch-artifact-open",
              title: item.exists === false ? `${item.path}（未找到）` : `在右侧栏预览 ${item.path}`,
              disabled: item.exists === false,
              onClick: act(() => void previewInSidebar(task.id, item.path))
            },
            item.path
          ), item.label ? /* @__PURE__ */ h("span", { className: "orch-muted" }, item.label) : null, item.exists === false ? /* @__PURE__ */ h(Chip, { tone: "bad" }, "（未找到）") : null, /* @__PURE__ */ h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: () => void copyPath(item.path) }, "复制路径"));
        }));
        return /* @__PURE__ */ h("div", { className: "orch-drawer-sections" }, task.question ? /* @__PURE__ */ h(
          Banner,
          {
            tone: "notice",
            icon: "alert"
          },
          `需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(" / ")}）` : ""}`
        ) : null, task.error ? /* @__PURE__ */ h(Banner, { tone: "error", icon: "alert" }, `错误：${task.error}`) : null, detailSection("概览", "概览", "", overviewBody), detailSection("最新回复", "最新回复", lastMessage === null ? "" : timeLabel2(lastMessage.at), lastMessageBody), detailSection("Brief", "Brief", acceptance.length > 0 ? `验收 ${acceptance.length} 条` : "", briefBody), detailSection("目标状态", "目标状态", goalState === null ? "" : GOAL_PHASE_LABEL2[goalState.phase] || goalState.phase || "", goalBody), detailSection("消息", "消息", messages.length > 0 ? `${messages.length} 条` : "", messageBody), detailSection("依赖", "依赖", `上游 ${dependencies.length} · 下游 ${dependents.length}`, depBody), detailSection("产物", "产物", artifacts.length > 0 ? `${artifacts.length} 个` : "", artifactBody), goalNote);
      };
      const drawerFoot = () => {
        const buttons = [
          stopControl(detailTask),
          closeControl(detailTask),
          retryControl(detailTask),
          detailTask.target ? openControl(detailTask.target, "打开子会话") : null,
          deleteControl(detailTask),
          // 不能删就说清原因：活跃任务先「停止」；终态但还有活跃下游先处理下游。
          detailTask.canDelete !== true ? /* @__PURE__ */ h("span", { key: "delete-hint", className: "orch-muted" }, "当前不能删除：活跃任务先「停止」；有活跃下游依赖则先处理下游。") : null
        ].filter(Boolean);
        return buttons.length === 0 ? null : /* @__PURE__ */ h("footer", { className: "orch-drawer-foot" }, buttons);
      };
      const drawerContent = () => /* @__PURE__ */ h("div", { className: "orch-drawer-content" }, /* @__PURE__ */ h("header", { className: "orch-drawer-head" }, /* @__PURE__ */ h("div", { className: "orch-drawer-title-row" }, /* @__PURE__ */ h("span", { className: "orch-drawer-title", title: drawerTitle }, drawerTitle), detailTask === null ? null : statusBadge(detailTask.status), /* @__PURE__ */ h(
        "button",
        {
          type: "button",
          className: "orch-icon-btn",
          title: "关闭（Esc）",
          onClick: closeDetail
        },
        /* @__PURE__ */ h(Icon, { name: "close" })
      )), /* @__PURE__ */ h("div", { className: "orch-drawer-sub" }, detailTask === null ? null : /* @__PURE__ */ h("span", null, `编号 ${detailTask.id}`), detailTask === null ? null : /* @__PURE__ */ h("span", null, `更新 ${timeLabel2(detailTask.updatedAt)}`), detailTask !== null && detailTask.readOnly === true ? /* @__PURE__ */ h("span", null, "只读任务") : null, detailTask !== null && detailTask.planFirst === true ? /* @__PURE__ */ h("span", null, `计划：${PLAN_STATE_LABEL2[detailTask.planState] || detailTask.planState || "无计划状态"}`) : null)), /* @__PURE__ */ h("div", { className: "orch-drawer-body" }, focusNotice === null ? null : /* @__PURE__ */ h(Banner, { tone: "notice", icon: "alert" }, focusNotice), detailLoading ? drawerLoading() : null, detailError !== null ? drawerError() : null, detailTask === null ? null : detailBody()), detailTask === null ? null : drawerFoot());
      return /* @__PURE__ */ h("div", { className: "orch-shell" }, topbar(), metrics(), /* @__PURE__ */ h("div", { className: "orch-body" }, rail(), /* @__PURE__ */ h("main", { className: "orch-main" }, alerts(), filter === "artifacts" ? artifactView() : listView())), /* @__PURE__ */ h("div", { className: "orch-layer" }, /* @__PURE__ */ h(
        "div",
        {
          className: "orch-scrim",
          "data-open": drawerOpen ? "true" : "false",
          "aria-hidden": "true",
          onClick: closeDetail
        }
      ), /* @__PURE__ */ h(
        "aside",
        {
          className: "orch-drawer",
          "data-open": drawerOpen ? "true" : "false",
          "aria-hidden": drawerOpen ? "false" : "true",
          "aria-label": "任务详情"
        },
        drawerOpen ? drawerContent() : null
      )));
    };
    return { HeaderButton, LauncherIcon, LauncherPanel, TasksPanel, TaskChipRow };
  }
  const FIELD_GROUPS = Object.freeze([
    Object.freeze({ id: "dispatch", label: "派发与队列" }),
    Object.freeze({ id: "watchdog", label: "看门狗与陈旧判定" }),
    Object.freeze({ id: "keepalive", label: "回合间续跑" }),
    Object.freeze({ id: "delivery", label: "交付与通知" }),
    Object.freeze({ id: "isolation", label: "隔离与并发" }),
    Object.freeze({ id: "memory", label: "记忆与快照" }),
    Object.freeze({ id: "preferences", label: "偏好注入" }),
    Object.freeze({ id: "rotation", label: "主会话轮换（只读）" })
  ]);
  const CONFIG_FIELDS = Object.freeze([
    // ── 派发与队列 ────────────────────────────────────────────────
    Object.freeze({
      key: "spawnProvider",
      group: "dispatch",
      kind: "string",
      default: "spawn",
      label: "子会话 provider",
      hint: "本地 fresh 子会话的 provider 名"
    }),
    Object.freeze({
      key: "workerPreset",
      group: "dispatch",
      kind: "string",
      default: "dsh-orchestrator-worker",
      label: "子会话预设",
      hint: "只认小写字母/数字/连字符；非法值回落 dsh-orchestrator-worker"
    }),
    Object.freeze({
      key: "maxQueue",
      group: "dispatch",
      kind: "number",
      min: 1,
      max: 1e4,
      integer: true,
      default: 50,
      label: "队列安全阀",
      hint: "pending + waiting_dep 的上限"
    }),
    Object.freeze({
      key: "autoResumeQueue",
      group: "dispatch",
      kind: "boolean",
      default: true,
      label: "重启后自动恢复排队任务"
    }),
    Object.freeze({
      key: "mergeWindowMs",
      group: "dispatch",
      kind: "number",
      min: 1,
      max: 6e5,
      integer: true,
      default: 5e3,
      label: "完成通知合并窗口（ms）"
    }),
    Object.freeze({
      key: "staleMinutes",
      group: "dispatch",
      kind: "number",
      min: 1,
      max: 1440,
      integer: true,
      default: 30,
      label: "陈旧判定（分钟）",
      hint: "多久无动静标陈旧 / stall 提醒间隔"
    }),
    Object.freeze({
      key: "stallRounds",
      group: "dispatch",
      kind: "number",
      min: 1,
      max: 1e3,
      integer: true,
      default: 3,
      label: "stall 提醒轮数",
      hint: "连续 progress 达阈值后提醒一次「可能卡住」"
    }),
    // ── 看门狗 ────────────────────────────────────────────────────
    Object.freeze({
      key: "idleWatchdog",
      group: "watchdog",
      kind: "boolean",
      default: true,
      label: "空闲看门狗",
      hint: "只告警，不杀任务"
    }),
    Object.freeze({
      key: "watchdogIntervalMinutes",
      group: "watchdog",
      kind: "number",
      min: 1,
      max: 1440,
      integer: true,
      default: 5,
      label: "巡检间隔（分钟）"
    }),
    Object.freeze({
      key: "watchdogIdleMinutes",
      group: "watchdog",
      kind: "number",
      min: 1,
      max: 1440,
      integer: true,
      default: 15,
      label: "空闲阈值（分钟）",
      hint: "同一段空闲每任务只报一次"
    }),
    // ── 续跑 ──────────────────────────────────────────────────────
    Object.freeze({
      key: "keepAlive",
      group: "keepalive",
      kind: "boolean",
      default: false,
      label: "回合间续跑",
      hint: "需要 ctx.goals；默认关闭，升级后行为不突变"
    }),
    Object.freeze({
      key: "keepAliveMode",
      group: "keepalive",
      kind: "enum",
      values: ["steer", "followup"],
      default: "steer",
      label: "续跑方式",
      hint: "steer = 同回合再走一步；followup = 新回合（会写 turn/end）"
    }),
    Object.freeze({
      key: "keepAliveMaxRounds",
      group: "keepalive",
      kind: "number",
      min: 1,
      max: 50,
      integer: true,
      default: 8,
      label: "续跑轮数上限"
    }),
    Object.freeze({
      key: "keepAlivePrompt",
      group: "keepalive",
      kind: "string",
      default: "",
      label: "续跑提示词",
      hint: "留空 = 用内置默认提示"
    }),
    // ── 交付与通知 ────────────────────────────────────────────────
    Object.freeze({
      key: "deliveredTimeoutMinutes",
      group: "delivery",
      kind: "number",
      min: 1,
      max: 1440,
      integer: true,
      default: 60,
      label: "待确认超时（分钟）",
      hint: "设成 1 约等于「交付即完成」的旧行为"
    }),
    Object.freeze({
      key: "digestAt",
      group: "delivery",
      kind: "string",
      default: "",
      label: "每日日报时刻",
      hint: "HH:MM（如 09:00）；留空 = 关闭",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d$"
    }),
    Object.freeze({
      key: "digestTimeZone",
      group: "delivery",
      kind: "string",
      default: "",
      label: "日报时区",
      hint: "如 Asia/Shanghai；留空 = 系统时区"
    }),
    // ── 隔离与并发 ────────────────────────────────────────────────
    Object.freeze({
      key: "sameDirGuard",
      group: "isolation",
      kind: "enum",
      values: ["require", "warn", "off"],
      default: "require",
      label: "同写域并发防护",
      hint: "require = 拒绝并给可操作错误；非法值一律回落 require（默认必须安全）"
    }),
    Object.freeze({
      key: "worktreePolicy",
      group: "isolation",
      kind: "enum",
      values: ["required", "auto", "off"],
      default: "auto",
      label: "worktree 隔离策略",
      hint: "required = 每个需求都隔离；auto = 满足三条件才建议"
    }),
    Object.freeze({
      key: "worktreeBranchPrefix",
      group: "isolation",
      kind: "string",
      default: "orch/",
      label: "隔离分支前缀",
      hint: "默认分支名 <prefix><taskId>"
    }),
    Object.freeze({
      key: "worktreeRecentDays",
      group: "isolation",
      kind: "number",
      min: 1,
      max: 90,
      integer: true,
      default: 7,
      label: "近期活跃分支窗口（天）"
    }),
    // ── 记忆与快照 ────────────────────────────────────────────────
    Object.freeze({
      key: "memoryInject",
      group: "memory",
      kind: "boolean",
      default: true,
      label: "注入事实层记忆",
      hint: "新任务是否注入跨项目记忆"
    }),
    Object.freeze({
      key: "memoryLimit",
      group: "memory",
      kind: "number",
      min: 1,
      max: 10,
      integer: true,
      default: 3,
      label: "注入记忆条数"
    }),
    Object.freeze({
      key: "snapshotRetentionDays",
      group: "memory",
      kind: "number",
      min: 1,
      max: 30,
      integer: true,
      default: 7,
      label: "台账快照保留（天）"
    }),
    // ── 偏好注入 ──────────────────────────────────────────────────
    Object.freeze({
      key: "preferencesInject",
      group: "preferences",
      kind: "boolean",
      default: true,
      label: "注入偏好段",
      hint: "协调者 policy 的第 4 段；关闭则整段消失"
    }),
    Object.freeze({
      key: "preferencesMaxChars",
      group: "preferences",
      kind: "number",
      min: 200,
      max: 4e3,
      integer: true,
      default: 1200,
      label: "偏好字数上限"
    }),
    Object.freeze({
      key: "preferencesMaxItems",
      group: "preferences",
      kind: "number",
      min: 1,
      max: 20,
      integer: true,
      default: 12,
      label: "偏好条数上限"
    }),
    // ── 主会话轮换（只读，Q3） ─────────────────────────────────────
    Object.freeze({
      key: "coordinatorSession",
      group: "rotation",
      kind: "string",
      default: "",
      readonly: true,
      label: "协调者会话覆盖",
      hint: "留空 = 读台账 settings.main_session_id；只在运维兜底时手改 YAML"
    }),
    Object.freeze({
      key: "mainRotation",
      group: "rotation",
      kind: "enum",
      values: ["auto", "off"],
      default: "off",
      readonly: true,
      label: "轮换总开关",
      hint: "默认 off（默认必须安全）；拼错也回落 off"
    }),
    Object.freeze({
      key: "rotateAfterMainLogMiB",
      group: "rotation",
      kind: "number",
      min: 0.5,
      max: 4096,
      integer: false,
      default: 6,
      readonly: true,
      label: "触发：主会话日志体积（MiB）"
    }),
    Object.freeze({
      key: "rotateAfterDays",
      group: "rotation",
      kind: "number",
      min: 1,
      max: 365,
      integer: true,
      default: 10,
      readonly: true,
      label: "触发：运行天数"
    }),
    Object.freeze({
      key: "rotateCooldownHours",
      group: "rotation",
      kind: "number",
      min: 1,
      max: 720,
      integer: true,
      default: 48,
      readonly: true,
      label: "冷却期（小时）"
    }),
    Object.freeze({
      key: "rotateMinAgeHours",
      group: "rotation",
      kind: "number",
      min: 1,
      max: 720,
      integer: true,
      default: 12,
      readonly: true,
      label: "最小龄（小时）"
    }),
    Object.freeze({
      key: "rotateIdleMinutes",
      group: "rotation",
      kind: "number",
      min: 1,
      max: 1440,
      integer: true,
      default: 10,
      readonly: true,
      label: "闲置判定（分钟）"
    }),
    Object.freeze({
      key: "rotateArchiveOld",
      group: "rotation",
      kind: "boolean",
      default: true,
      readonly: true,
      label: "轮换后归档旧主会话",
      hint: "不可逆：平台没有 unarchive"
    })
  ]);
  const EDITABLE_FIELDS = Object.freeze(CONFIG_FIELDS.filter((field) => field.readonly !== true));
  Object.freeze(
    Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, field]))
  );
  const FIELDS_BY_GROUP = Object.freeze(
    FIELD_GROUPS.map((group) => Object.freeze({
      ...group,
      fields: Object.freeze(CONFIG_FIELDS.filter((field) => field.group === group.id))
    })).filter((group) => group.fields.length > 0)
  );
  Object.freeze(CONFIG_FIELDS.map((field) => field.key));
  const EDITABLE_KEYS = Object.freeze(EDITABLE_FIELDS.map((field) => field.key));
  const CONFIG_SLOT_KEY = "@wjj865-code/dsh-orchestrator";
  const CONFIG_ENTRY_ID = "orchestrator";
  const COLLAPSED_BY_DEFAULT = Object.freeze(["rotation"]);
  const plainValues = (value) => typeof value === "object" && value !== null ? value : {};
  const overriddenKeys = (user) => new Set(Object.keys(plainValues(user)));
  const isDirty = (draft, saved) => {
    const keys = /* @__PURE__ */ new Set([...Object.keys(draft), ...Object.keys(saved)]);
    for (const key of keys) {
      if (!EDITABLE_KEYS.includes(key)) continue;
      if (draft[key] !== saved[key]) return true;
    }
    return false;
  };
  function buildOps(draft, saved, overridden) {
    const ops = [];
    for (const key of EDITABLE_KEYS) {
      if (draft[key] === saved[key]) continue;
      if (draft[key] === "" || draft[key] === void 0 || draft[key] === null) {
        if (overridden.has(key)) ops.push({ op: "unset", path: [key] });
        continue;
      }
      ops.push({ op: "set", path: [key], value: draft[key] });
    }
    return ops;
  }
  function parseInput(field, text) {
    if (field.kind === "boolean") return text === true || text === "true";
    if (field.kind === "number") {
      if (text === "") return "";
      const numeric = Number(text);
      return Number.isFinite(numeric) ? numeric : text;
    }
    return text;
  }
  function createConfigCard({ React, h, Icon }) {
    const useFormSnapshot = (form) => {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        if (form === void 0 || form === null || typeof form.subscribe !== "function") return void 0;
        return form.subscribe(() => bump((value) => value + 1));
      }, [form]);
      if (form === void 0 || form === null || typeof form.getSnapshot !== "function") {
        return { status: "loading", value: void 0, user: void 0, revision: void 0, writable: false };
      }
      return form.getSnapshot();
    };
    const Row = ({ field, draft, overridden, disabled, onChange }) => {
      const value = draft[field.key];
      const isOverridden = overridden.has(field.key);
      const common = {
        className: "orch-cfg-input",
        disabled: disabled || field.readonly === true,
        value: value === void 0 || value === null ? "" : String(value),
        onChange: (event) => onChange(field, event.target.value),
        "aria-label": field.label
      };
      return /* @__PURE__ */ h("div", { className: "orch-cfg-row" }, /* @__PURE__ */ h("div", { className: "orch-cfg-label" }, /* @__PURE__ */ h("span", { className: "orch-cfg-name" }, field.label), isOverridden ? /* @__PURE__ */ h("span", { className: "orch-cfg-tag" }, "已覆盖") : null, field.readonly === true ? /* @__PURE__ */ h("span", { className: "orch-cfg-tag orch-cfg-tag--readonly" }, "只读") : null), /* @__PURE__ */ h("div", { className: "orch-cfg-control" }, field.kind === "boolean" ? /* @__PURE__ */ h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": value === true,
          "aria-label": field.label,
          className: value === true ? "orch-cfg-switch orch-cfg-switch--on" : "orch-cfg-switch",
          disabled: disabled || field.readonly === true,
          onClick: () => onChange(field, value !== true)
        },
        /* @__PURE__ */ h("span", { className: "orch-cfg-switch-knob" })
      ) : field.kind === "enum" ? /* @__PURE__ */ h("select", { ...common }, field.values.map((option) => /* @__PURE__ */ h("option", { key: option, value: option }, option))) : /* @__PURE__ */ h(
        "input",
        {
          ...common,
          type: field.kind === "number" ? "number" : "text",
          placeholder: field.kind === "number" ? String(field.default) : ""
        }
      )), field.hint === void 0 ? null : /* @__PURE__ */ h("div", { className: "orch-cfg-hint" }, field.hint), field.pattern !== void 0 && value !== "" && !new RegExp(field.pattern).test(String(value)) ? /* @__PURE__ */ h("div", { className: "orch-cfg-hint orch-cfg-hint--warn" }, "格式不符（例：09:00）；非法值保存后会回落默认") : null);
    };
    return function OrchestratorConfigCard(props) {
      const form = props.form;
      const snapshot = useFormSnapshot(form === void 0 ? void 0 : form);
      const saved = React.useMemo(() => plainValues(snapshot.value), [snapshot.value]);
      const overridden = React.useMemo(() => overriddenKeys(snapshot.user), [snapshot.user]);
      const [draft, setDraft] = React.useState(saved);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState(() => new Set(COLLAPSED_BY_DEFAULT));
      React.useEffect(() => {
        setDraft(saved);
        setError(null);
      }, [saved]);
      const dirty = isDirty(draft, saved);
      const readonly = snapshot.writable !== true;
      const onChange = (field, next) => {
        setNotice(null);
        setDraft((current) => ({ ...current, [field.key]: field.kind === "string" || field.kind === "enum" ? next : parseInput(field, next) }));
      };
      const onSave = async () => {
        if (form === void 0 || typeof form.mutate !== "function") return;
        const ops = buildOps(draft, saved, overridden);
        if (ops.length === 0) {
          setNotice("没有需要保存的改动");
          return;
        }
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
          const accepted = await form.mutate(ops, snapshot.revision);
          if (accepted === true) {
            setNotice("已保存。配置即时生效（插件会重载，台账不受影响）。");
          } else {
            setError("保存被拒绝：配置可能已被别处改动，或该字段不允许写入。表单已按最新值刷新，请重试。");
          }
        } catch (failure) {
          setError(`保存失败：${String(failure && failure.message || failure)}`);
        } finally {
          setSaving(false);
        }
      };
      const onReset = () => {
        setDraft(saved);
        setError(null);
        setNotice("已放弃未保存的改动");
      };
      const toggleGroup = (id) => setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      if (snapshot.status === "unavailable") {
        return h("div", { className: "orch-cfg orch-cfg--empty" }, [
          h("div", { key: "title", className: "orch-cfg-title" }, "配置"),
          h("p", { key: "body", className: "orch-cfg-hint" }, "该插件当前未加载，暂时无法配置。")
        ]);
      }
      if (snapshot.status === "loading") {
        return h("div", { className: "orch-cfg orch-cfg--empty" }, [
          h("div", { key: "title", className: "orch-cfg-title" }, "配置"),
          h("p", { key: "body", className: "orch-cfg-hint" }, "正在读取配置…")
        ]);
      }
      const groups = FIELDS_BY_GROUP.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        const header = h("button", {
          key: "header",
          type: "button",
          className: "orch-cfg-group-header",
          "aria-expanded": !isCollapsed,
          onClick: () => toggleGroup(group.id)
        }, [
          // 折叠时图标旋转 90°（同一条 chevron，靠 CSS 表达开合，不额外造图标）。
          h(Icon, { key: "icon", name: "chevron", className: isCollapsed ? "orch-cfg-chevron" : "orch-cfg-chevron orch-cfg-chevron--open" }),
          h("span", { key: "label", className: "orch-cfg-group-label" }, group.label),
          h("span", { key: "count", className: "orch-cfg-group-count" }, String(group.fields.length))
        ]);
        const body = isCollapsed ? null : h(
          "div",
          { key: "body", className: "orch-cfg-group-body" },
          group.fields.map((field) => h(Row, {
            key: field.key,
            field,
            draft,
            overridden,
            disabled: readonly || saving,
            onChange
          }))
        );
        return h("section", { key: group.id, className: "orch-cfg-group" }, [header, body]);
      });
      const actions = readonly ? null : h("div", { key: "actions", className: "orch-cfg-actions" }, [
        h("button", {
          key: "save",
          type: "button",
          className: "orch-btn orch-btn--primary",
          disabled: !dirty || saving,
          onClick: onSave
        }, saving ? "保存中…" : "保存"),
        h("button", {
          key: "reset",
          type: "button",
          className: "orch-btn",
          disabled: !dirty || saving,
          onClick: onReset
        }, "放弃改动"),
        dirty ? h("span", { key: "dirty", className: "orch-cfg-hint" }, "有未保存的改动") : null
      ]);
      return h("div", { className: "orch-cfg", "data-orchestrator-config": "true" }, [
        h("div", { key: "head", className: "orch-cfg-head" }, [
          h("div", { key: "title", className: "orch-cfg-title" }, "配置"),
          readonly ? h("span", { key: "ro", className: "orch-cfg-tag orch-cfg-tag--readonly" }, "只读") : null
        ]),
        h(
          "p",
          { key: "intro", className: "orch-cfg-hint" },
          "保存在当前 profile 的 cordis.patch.yml；保存后插件即时重载（台账不受影响）。"
        ),
        error === null ? null : h("div", { key: "error", className: "orch-banner orch-banner--error", role: "alert" }, error),
        notice === null ? null : h("div", { key: "notice", className: "orch-banner orch-banner--info", role: "status" }, notice),
        ...groups,
        actions
      ]);
    };
  }
  const createClient = (req) => {
    const React = req("react");
    const { createElement: h } = React;
    const inject = ["slots", "layout", "uiWorkspace"];
    const { Icon, Badge, Chip, EmptyState, Banner, SkeletonList } = createUi(h);
    const OrchestratorConfigCard = createConfigCard({ React, h, Icon });
    const focusRequest = createFocusRequest();
    const {
      HeaderButton,
      LauncherIcon,
      LauncherPanel,
      TasksPanel,
      TaskChipRow
    } = createViews({
      React,
      h,
      Icon,
      Badge,
      Chip,
      EmptyState,
      Banner,
      SkeletonList,
      FILTERS,
      METRICS,
      POLL_MS,
      POLL_BACKOFF_MS,
      STATUS_LABEL,
      STATUS_TONE,
      MESSAGE_KIND_LABEL,
      DELIVERY_LABEL,
      DELIVERY_TONE,
      GOAL_PHASE_LABEL,
      GOAL_ACTIVATION_LABEL,
      PLAN_STATE_LABEL,
      WORKTREE_STATE_LABEL,
      WORKTREE_SOURCE_LABEL,
      TONE_COLOR,
      displayNameOf,
      textOf,
      listOf,
      timeLabel,
      shortPath,
      countTasks,
      matchesFilter,
      matchesQuery,
      groupArtifacts,
      readSnapshot,
      readArtifacts,
      readDetail,
      readPreview,
      panelAction,
      openMainOnce,
      selectTaskChips,
      chipViewOf,
      chipTooltipOf,
      chipVisibleTitle,
      chipOpenTargetOf,
      isLatestTurn
    });
    function apply(ctx) {
      ensureStyles();
      const serviceOf = (name) => {
        try {
          return ctx.get?.(name);
        } catch {
          return void 0;
        }
      };
      const readSessionId = () => {
        try {
          const current = serviceOf("uiSession")?.adapter?.current?.getSnapshot?.();
          if (current && typeof current.key === "string" && current.key !== "") return current.key;
        } catch {
        }
        try {
          const list = serviceOf("sessions")?.list?.getSnapshot?.();
          const rows = list && list.byId ? Object.values(list.byId) : [];
          const found = rows.find((row) => row && (row.retainedBy?.mainView ?? 0) > 0);
          if (found && typeof found.id === "string" && found.id !== "") return found.id;
        } catch {
        }
        return void 0;
      };
      const subscribeSession = (listener) => {
        const disposers = [];
        try {
          const off = serviceOf("uiSession")?.adapter?.current?.subscribe?.(listener);
          if (typeof off === "function") disposers.push(off);
        } catch {
        }
        try {
          const off = serviceOf("sessions")?.list?.subscribe?.(listener);
          if (typeof off === "function") disposers.push(off);
        } catch {
        }
        if (disposers.length === 0) return void 0;
        return () => {
          for (const off of disposers) {
            try {
              off();
            } catch {
            }
          }
        };
      };
      const fetchRole = async (sessionId) => {
        const response = await fetch(ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: "session-role", sessionId })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (body === null || typeof body !== "object" || body.ok !== true) throw new Error("bad-response");
        return body.isMain === true;
      };
      const mainView = createMainViewGate({
        readSessionId,
        subscribeSession,
        fetchRole,
        timer: typeof setTimeout === "function" ? (run, ms) => {
          let cancelled = false;
          let handle;
          const tick = () => {
            if (cancelled) return;
            run();
            if (!cancelled) handle = setTimeout(tick, ms);
          };
          handle = setTimeout(tick, ms);
          return () => {
            cancelled = true;
            try {
              clearTimeout(handle);
            } catch {
            }
          };
        } : void 0
      });
      if (typeof ctx.effect === "function") {
        ctx.effect(() => {
          const stop = mainView.start();
          return () => {
            stop();
          };
        }, "dsh-orchestrator: main-view gate");
      } else {
        void mainView.refresh();
      }
      const chipFeed = createTaskFeed({ readSnapshot: () => readSnapshot() });
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => chipFeed.stop(), "dsh-orchestrator: task chip feed");
      }
      const openArtifactPreview = (path) => {
        const sidebar = serviceOf("sidebarRight");
        if (typeof sidebar?.openResource !== "function") return { ok: false, reason: "sidebar-missing" };
        const sessionId = readSessionId();
        const problem = fileAddressProblem(sessionId, path);
        if (problem !== null) return { ok: false, reason: problem };
        const address = fileAddressOf(sessionId, path);
        if (address === "") return { ok: false, reason: "bad-path" };
        ctx.layout.selectPanel(null);
        try {
          sidebar.openResource(address);
          return { ok: true };
        } catch (error) {
          ctx.layout.selectPanel(PANEL_ID);
          return { ok: false, reason: "host-refused", message: String(error?.message ?? error) };
        }
      };
      const openChildSession = (sessionId) => ctx.uiWorkspace.openSession(sessionId);
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        inject: () => ({
          openSession: openChildSession,
          openArtifactPreview,
          // chip 的「打开并定位」请求交给面板自己消费（挂载时 take 一次，取走即清空）。
          focus: focusRequest
        })
      }, TasksPanel));
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: LAUNCHER_ID,
        inject: () => ({
          openMain: openMainOnce,
          openSession: openChildSession,
          clearPanel: () => ctx.layout.selectPanel(null)
        })
      }, LauncherPanel));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: LAUNCHER_ID,
        order: 5,
        label: () => "主会话"
      }, LauncherIcon));
      ctx.slots.inject("conversation.header.leading", () => ctx.slots.register({
        name: "conversation.header.leading",
        inject: () => ({
          openPanel: () => ctx.layout.selectPanel(PANEL_ID),
          hooks: { mainView }
        })
      }, HeaderButton));
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: CHIP_ID,
        order: 20,
        inject: () => ({
          openTask: (task) => {
            const target = chipOpenTargetOf(task);
            if (target.kind === "session") {
              try {
                openChildSession(target.sessionId);
                return;
              } catch (error) {
                const reason = String(error && error.message || error);
                if (focusRequest.request(task.id, { notice: `子会话已打不开（${reason}），已改为展示任务详情` })) {
                  ctx.layout.selectPanel(PANEL_ID);
                }
                return;
              }
            }
            if (focusRequest.request(task.id)) ctx.layout.selectPanel(PANEL_ID);
          },
          openPanel: () => ctx.layout.selectPanel(PANEL_ID),
          hooks: { mainView },
          chips: chipFeed
        })
      }, TaskChipRow));
      ctx.inject?.(["configForms"], (child) => {
        const forms = child.get?.("configForms");
        if (forms === void 0 || forms === null) return;
        if (typeof forms.get !== "function" || typeof forms.whileServed !== "function") return;
        child.effect?.(() => forms.whileServed([CONFIG_ENTRY_ID], () => child.slots.inject("plugins.bundle.config", () => child.slots.register({
          name: "plugins.bundle.config",
          key: CONFIG_SLOT_KEY
        }, (props) => {
          const form = forms.get(CONFIG_ENTRY_ID);
          return h(OrchestratorConfigCard, {
            ...props,
            form: {
              getSnapshot: () => form.getSnapshot(),
              subscribe: (listener) => form.subscribe(listener),
              mutate: (ops, revision) => form.mutate(ops, revision)
            }
          });
        }))), "dsh-orchestrator: plugins-page config card");
      });
    }
    return {
      inject,
      apply,
      __test: {
        createMainViewGate,
        countTasks,
        matchesFilter,
        matchesQuery,
        groupArtifacts,
        artifactDate,
        artifactProject,
        fileAddressOf,
        fileAddressProblem,
        selectTaskChips,
        chipStateOf,
        chipViewOf,
        chipTooltipOf,
        chipVisibleTitle,
        chipOpenTargetOf,
        isLatestTurn,
        createFocusRequest,
        createTaskFeed,
        TONE_COLOR,
        STYLE_TEXT
      }
    };
  };
  window.__ModuleLoader__.load({
    id: CLIENT_ID,
    factory: (req) => createClient(req)
  });
})();
//# sourceMappingURL=client.js.map
