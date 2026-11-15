(function() {
  "use strict";
  const CLIENT_ID = "@wjj865-code/dsh-orchestrator";
  const PANEL_ID = "orchestrator";
  const LAUNCHER_ID = "orchestrator-launcher";
  const ROUTE = "api/orchestrator";
  const POLL_MS = 2e3;
  const POLL_BACKOFF_MS = 3e4;
  const MAIN_VIEW_POLL_MS = 5e3;
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
    if (filter === "waiting") return status === "waiting_user" || status === "waiting_auth";
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
.orch-btn--header { height: 24px; padding: 0 8px; }
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
`;
  const ensureStyles = () => {
    try {
      if (typeof document === "undefined" || document === null) return false;
      if (document.getElementById(STYLE_ID) !== null) return false;
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
      message: ["M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 12z"],
      trash: ["M4 7h16", "M9 7V5h6v2", "M6 7l1 13h10l1-13", "M10 11v5", "M14 11v5"],
      external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"],
      folder: ["M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
      copy: ["M9 9h10v10H9z", "M15 5H5v10"],
      goal: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
      inbox: ["M3 13h4l1.5 2.5h7L17 13h4", "M5.5 5h13l2.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z"],
      sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"],
      dot: ["M12 12h.01"]
    };
    const Icon = ({ name, size = 14, className }) => h("svg", {
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
    }, (ICON_PATHS[name] || ICON_PATHS.dot).map((d, index) => h("path", { key: index, d })));
    const Badge = ({ tone, children, title }) => h("span", {
      className: "orch-badge",
      title,
      style: { color: TONE_COLOR[tone] || TONE_COLOR.muted }
    }, children);
    const Chip = ({ tone, title, children }) => h("span", {
      className: tone === void 0 ? "orch-chip" : `orch-chip orch-chip--${tone}`,
      title
    }, children);
    const EmptyState = ({ icon = "inbox", title, hint, action }) => h(
      "div",
      { className: "orch-empty" },
      h("span", { className: "orch-empty-icon" }, h(Icon, { name: icon, size: 20 })),
      title ? h("div", { className: "orch-empty-title" }, title) : null,
      hint ? h("div", { className: "orch-empty-hint" }, hint) : null,
      action === void 0 ? null : action
    );
    const Banner = ({ tone = "info", icon = "alert", action, children }) => h(
      "div",
      {
        className: `orch-banner orch-banner--${tone}`
      },
      h("span", { className: "orch-banner-icon" }, h(Icon, { name: icon, size: 14 })),
      h("span", { className: "orch-banner-text" }, children),
      action === void 0 ? null : action
    );
    const SkeletonList = ({ rows = 4 }) => h(
      "div",
      { className: "orch-list", "aria-hidden": "true" },
      Array.from({ length: rows }, (_, index) => h(
        "div",
        { key: index, className: "orch-skeleton-card" },
        h(
          "div",
          { className: "orch-skeleton-row" },
          h("div", { className: "orch-skeleton", style: { width: 10, height: 10, borderRadius: 5 } }),
          h("div", { className: "orch-skeleton", style: { width: index % 2 === 0 ? "46%" : "62%" } }),
          h("div", { className: "orch-skeleton", style: { width: 40, marginLeft: "auto" } })
        ),
        h(
          "div",
          { className: "orch-skeleton-row" },
          h("div", { className: "orch-skeleton", style: { width: 68 } }),
          h("div", { className: "orch-skeleton", style: { width: 88 } })
        )
      ))
    );
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
    WORKTREE_STATE_LABEL,
    WORKTREE_SOURCE_LABEL,
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
    openMainOnce: openMainOnce2
  }) {
    const HeaderButton = ({ openPanel, useMainView }) => {
      const visible = typeof useMainView === "function" ? useMainView((value) => value === true) : false;
      if (visible !== true) return null;
      return h("button", {
        type: "button",
        title: "任务面板",
        className: "orch-btn orch-btn--ghost orch-btn--header",
        onClick: openPanel
      }, "☰ 任务");
    };
    const LauncherIcon = () => h("span", { "aria-hidden": true, className: "orch-launcher-icon" }, "◈");
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
      return h(
        "div",
        { className: "orch-shell orch-launcher" },
        h(
          "div",
          { className: "orch-launcher-card" },
          h("span", { className: "orch-brand-mark" }, h(Icon, { name: "sparkle", size: 14 })),
          h("div", { className: "orch-title" }, error === null ? "正在打开主会话…" : "打开主会话失败"),
          error === null ? h("div", { className: "orch-skeleton", style: { width: 120 } }) : null,
          error === null ? null : h("button", { type: "button", className: "orch-btn orch-btn--primary", onClick: run }, "重试")
        ),
        error === null ? null : h("div", { style: { width: "min(420px, 100%)" } }, h(Banner, { tone: "error" }, error))
      );
    };
    const TasksPanel = ({ openSession }) => {
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
        setConfirmDelete(null);
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
      const runPanel = async (endpoint, id, extra = {}) => {
        const key = `${endpoint}:${id}`;
        if (inFlight.current.has(key)) return;
        inFlight.current.add(key);
        setBusy(key);
        setActionError(null);
        setActionNotice(null);
        setConfirmStop(null);
        setConfirmDelete(null);
        try {
          const result = await panelAction2(endpoint, id, extra);
          if (result && result.already === true) {
            if (endpoint === "message") setActionNotice("这条消息已发送过，未重复投递");
            else if (endpoint === "retry") {
              setActionNotice(`已有活跃重派任务（${STATUS_LABEL2[result.status] || result.status || "处理中"}），未重复创建`);
            } else {
              setActionNotice(`任务已是该状态（${STATUS_LABEL2[result.status] || result.status || "已结束"}），无需重复停止`);
            }
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
      const sendMessage = (id) => {
        const text = typeof window.prompt === "function" ? window.prompt("追加一条消息给子会话：") : "";
        if (typeof text === "string" && text.trim() !== "") void runPanel("message", id, { message: text.trim() });
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
      const statusBadge = (status) => h(Badge, {
        tone: STATUS_TONE2[status] || "muted",
        title: STATUS_LABEL2[status] || status
      }, STATUS_LABEL2[status] || status || "未知");
      const stopControl = (task) => {
        if (task.status === "done" || task.status === "cancelled" || task.status === "orphaned") return null;
        if (confirmStop === task.id) {
          return h(
            "span",
            { key: "stop-confirm", className: "orch-confirm" },
            h("span", null, "确认停止？"),
            h("button", {
              type: "button",
              className: "orch-btn orch-btn--sm orch-btn--danger",
              disabled: busy === `stop:${task.id}`,
              onClick: act(() => void runPanel("stop", task.id))
            }, "确认停止"),
            h("button", {
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: act(() => setConfirmStop(null))
            }, "取消")
          );
        }
        return h("button", {
          key: "stop",
          type: "button",
          className: "orch-btn orch-btn--sm orch-btn--danger",
          title: "停止子会话（需要二次确认）",
          disabled: busy === `stop:${task.id}`,
          onClick: act(() => setConfirmStop(task.id))
        }, h(Icon, { name: "stop" }), busy === `stop:${task.id}` ? "停止中…" : "停止");
      };
      const retryControl = (task) => task.status === "failed" || task.status === "orphaned" ? h(
        "button",
        {
          key: "retry",
          type: "button",
          className: "orch-btn orch-btn--sm",
          title: "用同一份 brief 重派",
          disabled: busy === `retry:${task.id}`,
          onClick: act(() => void runPanel("retry", task.id))
        },
        h(Icon, { name: "retry", className: busy === `retry:${task.id}` ? "orch-spin" : void 0 }),
        busy === `retry:${task.id}` ? "重派中…" : "重派"
      ) : null;
      const messageControl = (task, label = "追加") => task !== null && task !== void 0 && task.canFollowup === true ? h("button", {
        key: "message",
        type: "button",
        className: "orch-btn orch-btn--sm",
        title: "给子会话追加一条消息",
        disabled: busy === `message:${task.id}`,
        onClick: act(() => sendMessage(task.id))
      }, h(Icon, { name: "message" }), label) : null;
      const deleteControl = (task) => {
        const deletable = task !== null && task !== void 0 && task.canDelete === true;
        if (!deletable) return null;
        if (confirmDelete === task.id) {
          return h(
            "span",
            { key: "delete-confirm", className: "orch-confirm" },
            h("span", null, "确认删除？"),
            h("button", {
              type: "button",
              className: "orch-btn orch-btn--sm orch-btn--danger",
              disabled: busy === `delete:${task.id}`,
              onClick: act(() => void runPanel("delete", task.id))
            }, busy === `delete:${task.id}` ? "删除中…" : "确认删除"),
            h("button", {
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: act(() => setConfirmDelete(null))
            }, "取消")
          );
        }
        return h("button", {
          key: "delete",
          type: "button",
          className: "orch-btn orch-btn--sm orch-btn--danger",
          title: "从台账删除这条任务与它的消息/通知（需要二次确认）",
          disabled: busy === `delete:${task.id}`,
          onClick: act(() => setConfirmDelete(task.id))
        }, h(Icon, { name: "trash" }), "删除");
      };
      const openControl = (sessionId, label) => h("button", {
        key: `open:${label || "child"}`,
        type: "button",
        className: "orch-btn orch-btn--sm",
        disabled: sessionId === null || sessionId === void 0,
        onClick: act(() => open(sessionId))
      }, h(Icon, { name: "external" }), label || "打开子会话");
      const topbar = () => h(
        "header",
        { className: "orch-topbar" },
        h(
          "div",
          { className: "orch-brand" },
          h("span", { className: "orch-brand-mark" }, h(Icon, { name: "sparkle", size: 14 })),
          h("span", { className: "orch-title" }, inboxCount > 0 ? `任务 · 待你决定 ${inboxCount}` : "任务"),
          h("span", {
            className: "orch-status",
            "data-live": mainSession.live === true ? "true" : "false",
            title: mainSession.id === null ? "还没有主会话" : `主会话编号 ${mainSession.id}`
          }, h("span", { className: "orch-status-dot" }), mainState)
        ),
        h(
          "div",
          { className: "orch-topbar-actions" },
          h(
            "label",
            { className: "orch-search", title: "按标题 / 编号 / 目录搜索" },
            h(Icon, { name: "search", size: 13 }),
            h("input", {
              type: "search",
              value: query,
              placeholder: "搜索任务",
              "aria-label": "搜索任务",
              onChange: (event) => setQuery(event.target.value)
            })
          ),
          h(
            "button",
            {
              type: "button",
              className: "orch-btn orch-btn--ghost",
              title: "重新拉取台账快照",
              onClick: refresh,
              disabled: refreshing
            },
            h(Icon, { name: "refresh", className: refreshing ? "orch-spin" : void 0 }),
            refreshing ? "刷新中…" : "刷新"
          ),
          h("button", {
            type: "button",
            className: "orch-btn orch-btn--primary",
            onClick: handleOpenMain,
            disabled: openingMain
          }, h(Icon, { name: "plus" }), openingMain ? "打开中…" : "打开主会话")
        )
      );
      const metrics = () => h(
        "div",
        { className: "orch-metrics" },
        METRICS2.map(([value, label]) => h(
          "button",
          {
            key: value,
            type: "button",
            className: "orch-metric",
            "data-active": filter === value ? "true" : "false",
            "data-tone": value === "failed" ? "bad" : value === "done" ? "good" : value === "waiting" ? "warn" : "info",
            onClick: () => setFilter(value)
          },
          h("span", { className: "orch-metric-value" }, String(counts[value] || 0)),
          h("span", { className: "orch-metric-label" }, label)
        ))
      );
      const rail = () => h(
        "nav",
        { className: "orch-rail", "aria-label": "任务筛选" },
        FILTERS2.map(([value, label]) => h(
          "button",
          {
            key: value,
            type: "button",
            className: "orch-rail-item",
            "data-active": filter === value ? "true" : "false",
            "aria-pressed": filter === value,
            onClick: () => setFilter(value)
          },
          h(Icon, {
            name: value === "artifacts" ? "folder" : value === "waiting" ? "inbox" : value === "failed" ? "alert" : value === "done" ? "check" : "clock",
            size: 13
          }),
          h("span", { className: "orch-rail-label" }, label),
          h("span", { className: "orch-rail-count" }, String(value === "all" ? counts.all : counts[value] || 0))
        ))
      );
      const alerts = () => h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        snapshotError !== null ? h(Banner, {
          tone: "error",
          icon: "alert",
          action: h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: refresh }, "重试")
        }, `台账暂不可用：${snapshotError}`) : null,
        actionError !== null ? h(Banner, {
          tone: "error",
          icon: "alert",
          action: h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: () => setActionError(null) }, "关闭")
        }, actionError) : null,
        actionNotice !== null ? h(Banner, { tone: "notice", icon: "check" }, actionNotice) : null,
        copyNotice !== null ? h(Banner, { tone: "info", icon: "copy" }, copyNotice) : null,
        inboxCount > 0 ? h(Banner, {
          tone: "notice",
          icon: "inbox",
          action: h("button", {
            type: "button",
            className: "orch-btn orch-btn--sm",
            onClick: () => setFilter("waiting")
          }, "查看")
        }, `有 ${inboxCount} 个任务等你决定，切到「待你决定」查看。`) : null,
        openedMain ? h(Banner, { tone: "info", icon: "check" }, "主会话已就绪；若仍停在 Bot 会话里，请从左侧会话列表打开「主会话」。") : null,
        snapshot !== null && mainSession.id === null ? h(Banner, { tone: "notice", icon: "alert" }, "尚未打开主会话：点右上角「打开主会话」，在指挥舱里创建。") : null
      );
      const renderTask = (task, all) => {
        const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
        const isExpanded = expanded.includes(task.id);
        const displayName = displayNameOf2(task, all);
        const tone = TONE_COLOR2[task.tone] || TONE_COLOR2.muted;
        return h(
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
          h(
            "div",
            { className: "orch-card-top" },
            h("span", { className: "orch-dot", style: { background: tone, color: tone } }),
            h("span", { className: "orch-card-title", title: displayName }, displayName),
            statusBadge(task.status),
            // P8：计划阶段小标（只在「等批准」时出现；批准后正常执行，不占视觉）。
            task.planState === "planning" ? h(Badge, { tone: "info", title: "计划模式：子会话只读探索，用 task_report blocked 上报计划，批准后自动切回可写" }, "计划中") : null,
            // P9：真的隔离了才给小标（产物在检出目录里，合并由用户决定）。
            ["created", "reused"].includes(task.worktreeState) ? h(Badge, { tone: "info", title: `worktree 隔离：产物在分支 ${task.worktreeBranch || "(未知)"} 的检出目录 ${task.worktreePath || "(未知)"}，合并由你决定` }, "隔离") : null,
            h("span", { className: "orch-card-time", title: "最近事件" }, timeLabel2(task.lastEventAt))
          ),
          h(
            "div",
            { className: "orch-card-meta" },
            task.targetDir !== null && task.targetDir !== void 0 ? h(Chip, { title: task.targetDir }, h(Icon, { name: "folder", size: 11 }), shortPath2(task.targetDir)) : null,
            task.groupId ? h(Chip, { title: "分组" }, `组 ${task.groupId}`) : null,
            task.priority ? h(Chip, { title: "优先级" }, `P${task.priority}`) : null,
            task.dependsOn && task.dependsOn.length > 0 ? h(Chip, { title: task.dependsOn.join("、") }, `依赖 ${task.dependsOn.length}`) : null,
            task.queued ? h(Chip, null, "排队中") : null,
            task.stale ? h(Chip, { tone: "warn", title: "超过 30 分钟没有新事件" }, "⚠ 可能卡住") : null,
            task.goalState ? h(Chip, { title: "平台目标状态（只读）" }, h(Icon, { name: "goal", size: 11 }), `目标·${GOAL_PHASE_LABEL2[task.goalState.phase] || task.goalState.phase || "未知"}`) : null,
            task.readOnly === true ? h(Chip, { tone: "warn", title: "只读任务：写文件/写 shell 会被沙箱拒绝" }, "只读") : null,
            task.planFirst === true ? h(Chip, {
              tone: task.planState === "planning" ? "info" : "muted",
              title: "计划模式：plan_state 由台账下发（只读展示）"
            }, `计划·${PLAN_STATE_LABEL2[task.planState] || task.planState || "无计划状态"}`) : null,
            task.worktreeState && task.worktreeState !== "none" ? h(Chip, {
              tone: task.worktreeState === "failed" ? "bad" : ["created", "reused"].includes(task.worktreeState) ? "info" : "muted",
              title: task.worktreePath ? `检出 ${task.worktreePath}` : "未建检出"
            }, `隔离·${WORKTREE_STATE_LABEL[task.worktreeState] || task.worktreeState}`) : null,
            artifacts.length > 0 ? h(
              "button",
              {
                type: "button",
                className: "orch-btn orch-btn--sm",
                "aria-expanded": isExpanded,
                onClick: act(() => toggleArtifacts(task.id))
              },
              h(Icon, { name: "chevron", className: "orch-chevron", "data-open": isExpanded ? "true" : "false" }),
              `产物 ${artifacts.length}`
            ) : null
          ),
          h(
            "div",
            { className: "orch-card-actions" },
            h("button", {
              key: "detail",
              type: "button",
              className: "orch-btn orch-btn--sm",
              onClick: act(() => void openDetail(task.id))
            }, h(Icon, { name: "chevron" }), "详情"),
            stopControl(task),
            retryControl(task),
            messageControl(task),
            openControl(task.childSessionId),
            deleteControl(task)
          ),
          artifacts.length > 0 ? h(
            "div",
            { className: "orch-expand", "data-open": isExpanded ? "true" : "false" },
            h(
              "div",
              null,
              h(
                "div",
                { className: "orch-artifact-list" },
                artifacts.map((item, index) => {
                  const itemTone = item.exists === false ? TONE_COLOR2.bad : TONE_COLOR2.good;
                  return h(
                    "div",
                    { key: `${item.path}:${index}`, className: "orch-artifact" },
                    h("span", { className: "orch-dot", style: { background: itemTone, color: itemTone } }),
                    h(
                      "span",
                      { className: "orch-artifact-path", title: item.path },
                      `${item.path}${item.exists === false ? "（未找到）" : ""}`
                    ),
                    item.label ? h("span", { className: "orch-muted" }, item.label) : null
                  );
                })
              )
            )
          ) : null,
          task.question ? h(
            "div",
            { className: "orch-question" },
            h(Icon, { name: "alert", size: 13 }),
            h("span", null, `需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(" / ")}）` : ""}`)
          ) : null
        );
      };
      const artifactItems = Array.isArray(artifactData && artifactData.items) ? artifactData.items : [];
      const previewBlock = () => {
        if (preview === null) return null;
        if (preview.loading === true) {
          return h(
            "div",
            { className: "orch-preview" },
            h("div", { className: "orch-muted" }, "加载预览…"),
            h("div", { className: "orch-skeleton", style: { width: "72%" } })
          );
        }
        if (preview.error !== null) {
          return h("div", { className: "orch-preview" }, h(Banner, { tone: "error" }, `预览失败：${preview.error}`));
        }
        const data = preview.data || {};
        if (data.kind === "text") {
          return h(
            "div",
            { className: "orch-preview" },
            h("div", { className: "orch-muted" }, `${data.size ?? 0} 字节${data.truncated === true ? "（仅显示前 64 KiB）" : ""}`),
            h("pre", { className: "orch-pre" }, data.text === "" ? "（空文件）" : data.text)
          );
        }
        if (data.kind === "directory") {
          return h(
            "div",
            { className: "orch-preview" },
            h(Banner, { tone: "notice", icon: "folder" }, "这是目录，不能预览内容；复制路径后在文件管理器打开。")
          );
        }
        if (data.kind === "binary") {
          return h(
            "div",
            { className: "orch-preview" },
            h(Banner, { tone: "notice", icon: "alert" }, "二进制文件，不能按文本预览；复制路径后在本地打开。")
          );
        }
        return h("div", { className: "orch-preview" }, h("div", { className: "orch-muted" }, "没有可预览的内容。"));
      };
      const artifactRow = (item) => {
        const key = `${item.taskId}:${item.path}`;
        const isPreview = preview !== null && preview.key === key;
        const tone = item.exists === false ? TONE_COLOR2.bad : TONE_COLOR2.good;
        return h(
          "div",
          { key, className: "orch-artifact" },
          h("span", { className: "orch-dot", style: { background: tone, color: tone } }),
          h("span", { className: "orch-artifact-path", title: item.path }, item.path),
          item.label ? h("span", { className: "orch-muted" }, item.label) : null,
          item.exists === false ? h(Chip, { tone: "bad" }, "（未找到）") : null,
          h(Chip, { title: "来源任务" }, `${item.title || item.taskId}${item.status ? ` · ${STATUS_LABEL2[item.status] || item.status}` : ""}`),
          h("span", { className: "orch-msg-at" }, timeLabel2(item.at)),
          h("button", {
            type: "button",
            className: "orch-btn orch-btn--sm",
            "aria-expanded": isPreview,
            disabled: item.exists === false,
            onClick: () => void togglePreview(item.taskId, item.path)
          }, isPreview ? "收起预览" : "预览"),
          h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: () => void copyPath(item.path) }, "复制路径"),
          item.childSessionId ? h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: () => open(item.childSessionId) }, "打开子会话") : null,
          h("button", {
            type: "button",
            className: "orch-btn orch-btn--sm",
            onClick: () => void openDetail(item.taskId)
          }, "详情"),
          isPreview ? previewBlock() : null
        );
      };
      const artifactView = () => {
        if (artifactData === null) {
          if (artifactError !== null) {
            return h(Banner, {
              tone: "error",
              icon: "alert",
              action: h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: () => void loadArtifacts(void 0) }, "重新加载")
            }, `产物加载失败：${artifactError}`);
          }
          return artifactLoading ? h(SkeletonList, { rows: 3 }) : h(EmptyState, { icon: "folder", title: "产物库还没加载", hint: "点「刷新」重新拉取产物库。" });
        }
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 10 } },
          h(
            "div",
            { className: "orch-card-meta" },
            h(
              "span",
              { className: "orch-muted" },
              `共 ${artifactItems.length} 个产物${artifactError !== null ? "（刷新失败，显示上次结果）" : ""}`
            ),
            h(
              "div",
              { className: "orch-seg" },
              h("button", {
                type: "button",
                className: "orch-seg-item",
                "data-active": artifactGroup === "project" ? "true" : "false",
                onClick: () => setArtifactGroup("project")
              }, "按项目"),
              h("button", {
                type: "button",
                className: "orch-seg-item",
                "data-active": artifactGroup === "date" ? "true" : "false",
                onClick: () => setArtifactGroup("date")
              }, "按日期")
            )
          ),
          artifactError !== null ? h(Banner, { tone: "error", icon: "alert" }, `产物加载失败：${artifactError}`) : null,
          artifactItems.length === 0 ? h(EmptyState, {
            icon: "folder",
            title: "还没有产物",
            hint: "还没有产物。任务 done 时会自动收集改动文件；也可以显式传 task_report.artifacts。"
          }) : h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 12 } },
            groupArtifacts2(artifactItems, artifactGroup).map(([name, rows]) => h(
              "section",
              {
                key: `${artifactGroup}:${name}`,
                className: "orch-group"
              },
              h(
                "div",
                { className: "orch-group-head" },
                h("span", { className: "orch-group-title" }, name),
                h("span", { className: "orch-muted" }, `${rows.length} 个`)
              ),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, rows.map(artifactRow))
            ))
          )
        );
      };
      const listView = () => {
        if (snapshot === null) {
          if (snapshotError === null) return h(SkeletonList, { rows: 5 });
          return h(EmptyState, {
            icon: "alert",
            title: "台账还没就绪",
            hint: "快照请求失败，点上面的「重试」重新拉取；也可以直接「打开主会话」进去看看。"
          });
        }
        if (visible.length === 0) {
          return tasks.length === 0 ? h(EmptyState, {
            icon: "inbox",
            title: "还没有任务",
            hint: "在主会话里用 task_create 建第一个任务；面板会实时同步状态、依赖和产物。"
          }) : h(EmptyState, {
            icon: "search",
            title: "没有匹配的任务",
            hint: "换个筛选项，或清空搜索框再试。",
            action: h("button", {
              type: "button",
              className: "orch-btn orch-btn--ghost orch-btn--sm",
              onClick: () => {
                setFilter("all");
                setQuery("");
              }
            }, "清空筛选")
          });
        }
        return h("div", { className: "orch-list" }, visible.map((task) => renderTask(task, tasks)));
      };
      const drawerLoading = () => h(
        "div",
        { className: "orch-drawer-sections" },
        h(
          "div",
          { className: "orch-skeleton-card" },
          h(
            "div",
            { className: "orch-skeleton-row" },
            h("div", { className: "orch-skeleton", style: { width: "40%" } }),
            h("div", { className: "orch-skeleton", style: { width: 60, marginLeft: "auto" } })
          ),
          h("div", { className: "orch-skeleton", style: { width: "86%" } }),
          h("div", { className: "orch-skeleton", style: { width: "72%" } })
        ),
        h(SkeletonList, { rows: 2 })
      );
      const drawerError = () => h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        h(Banner, { tone: "error", icon: "alert" }, detailError),
        h(
          "div",
          { className: "orch-card-actions" },
          h("button", {
            type: "button",
            className: "orch-btn orch-btn--ghost",
            onClick: () => {
              if (detailTaskId !== null) void openDetail(detailTaskId);
            }
          }, "重新加载"),
          h("button", { type: "button", className: "orch-btn", onClick: closeDetail }, "关闭")
        )
      );
      const detailSection = (key, title, hint, body) => {
        const isCollapsed = collapsedSections.includes(key);
        return h(
          "section",
          { key, className: "orch-section", "data-collapsed": isCollapsed ? "true" : "false" },
          h(
            "button",
            {
              type: "button",
              className: "orch-section-head",
              "aria-expanded": !isCollapsed,
              onClick: () => setCollapsedSections((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
            },
            h(Icon, { name: "chevron", className: "orch-chevron" }),
            h("span", { className: "orch-section-title" }, title),
            hint ? h("span", { className: "orch-section-hint" }, hint) : null
          ),
          h(
            "div",
            { className: "orch-section-body-wrap" },
            h(
              "div",
              { className: "orch-section-body" },
              h("div", { className: "orch-section-inner" }, body)
            )
          )
        );
      };
      const detailBody = () => {
        const task = detail.task || {};
        const overviewBody = h("div", { className: "orch-kv" }, [
          ["编号", task.id],
          ["状态", STATUS_LABEL2[task.status] || task.status || "未知"],
          ["目标目录", task.targetDir || "（未设置）"],
          ["分组", task.group || "（未分组）"],
          ["优先级", `P${task.priority === void 0 || task.priority === null ? 0 : task.priority}`],
          ["计划", task.planFirst === true ? PLAN_STATE_LABEL2[task.planState] || task.planState || "无计划状态" : "（不是计划任务）"],
          ["隔离", task.worktreeState && task.worktreeState !== "none" ? `${WORKTREE_STATE_LABEL[task.worktreeState] || task.worktreeState}｜分支 ${task.worktreeBranch || "-"}｜检出 ${task.worktreePath || "-"}｜决定 ${WORKTREE_SOURCE_LABEL[task.worktreeSource] || task.worktreeSource || "未知"}` : "（未隔离）"],
          ["写域", Array.isArray(task.writeScopes) && task.writeScopes.length > 0 ? task.writeScopes.join("、") : "（未声明）"],
          ["创建", timeLabel2(task.createdAt)],
          ["更新", timeLabel2(task.updatedAt)]
        ].flatMap(([key, value]) => [
          h("span", { key: `${key}:k`, className: "orch-kv-key" }, key),
          h("span", { key: `${key}:v`, className: "orch-kv-val" }, String(value === void 0 || value === null ? "" : value))
        ]));
        const lastMessage = task.lastMessage !== null && typeof task.lastMessage === "object" ? task.lastMessage : null;
        const lastMessageBody = lastMessage === null ? h("div", { className: "orch-muted" }, "还没有返回消息（子会话结算后自动记录最后一条回复）。") : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 6 } },
          h(
            "div",
            { className: "orch-card-meta" },
            h(Badge, { tone: "info" }, lastMessage.stored === "file" ? "全文在报告文件" : "内联正文"),
            lastMessage.stopReason ? h(Chip, { title: "结束原因" }, lastMessage.stopReason) : null,
            h("span", { className: "orch-msg-at" }, timeLabel2(lastMessage.at)),
            typeof lastMessage.chars === "number" ? h("span", { className: "orch-msg-at" }, `${lastMessage.chars} 字`) : null
          ),
          h("pre", { className: "orch-pre" }, lastMessage.stored === "file" ? `${lastMessage.summary || ""}

全文：${lastMessage.path || "（路径缺失）"}` : String(lastMessage.text || lastMessage.summary || "（空）"))
        );
        const brief = task.brief !== null && typeof task.brief === "object" && !Array.isArray(task.brief) ? task.brief : {};
        const briefGoal = textOf2(brief.goal) || textOf2(task.goal);
        const acceptance = listOf2(brief.acceptance);
        const constraints = listOf2(brief.constraints);
        const refs = listOf2(brief.refs);
        const verbatim = textOf2(brief.user_verbatim);
        const briefEmpty = briefGoal === "" && acceptance.length === 0 && constraints.length === 0 && refs.length === 0 && verbatim === "";
        const briefLists = (label, items) => h(
          "div",
          null,
          h("div", { className: "orch-kv-key" }, label),
          h("ul", { className: "orch-ul" }, items.map((item, index) => h("li", { key: index }, item)))
        );
        const briefBody = briefEmpty ? h("div", { className: "orch-muted" }, "这条任务没有 brief 信息。") : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 8 } },
          briefGoal !== "" ? h("div", { className: "orch-text" }, briefGoal) : null,
          acceptance.length > 0 ? briefLists("验收标准：", acceptance) : null,
          constraints.length > 0 ? briefLists("约束：", constraints) : null,
          refs.length > 0 ? briefLists("背景资料：", refs) : null,
          verbatim !== "" ? h(
            "div",
            null,
            h("div", { className: "orch-kv-key" }, "用户原话："),
            h("blockquote", { className: "orch-quote" }, verbatim)
          ) : null
        );
        const goalState = task.goalState !== null && typeof task.goalState === "object" ? task.goalState : null;
        const goalBody = goalState === null ? h("div", { className: "orch-muted" }, "没有平台目标状态（goal 服务不可用，或任务尚未派发/已收口）。") : h("div", { className: "orch-kv" }, [
          ["目标", textOf2(goalState.objective) || "（未记录）"],
          ["阶段", GOAL_PHASE_LABEL2[goalState.phase] || goalState.phase || "未知"],
          ["续轮", `${GOAL_ACTIVATION_LABEL2[goalState.activation] || goalState.activation || "未知"}（插件声明式接入，恒为不自动续轮）`],
          ["轮次", goalState.roundsStarted === null || goalState.roundsStarted === void 0 ? "-" : `${goalState.roundsStarted}/${goalState.maxGoalRounds === null || goalState.maxGoalRounds === void 0 ? "?" : goalState.maxGoalRounds}`],
          ["修订", goalState.revision === null || goalState.revision === void 0 ? "-" : String(goalState.revision)]
        ].flatMap(([key, value]) => [
          h("span", { key: `${key}:k`, className: "orch-kv-key" }, key),
          h("span", { key: `${key}:v`, className: "orch-kv-val" }, String(value))
        ]));
        const goalNote = h(
          "div",
          { className: "orch-muted" },
          "只读展示：由插件在派发、续派与终态时自动维护；面板不提供暂停/恢复/清除操作。"
        );
        const messages = Array.isArray(detail.messages) ? detail.messages : [];
        const shownMessages = messages.slice(-20);
        const messageBody = messages.length === 0 ? h("div", { className: "orch-muted" }, "还没有消息。") : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 4 } },
          shownMessages.map((row, index) => h(
            "div",
            {
              key: row.seq === void 0 ? index : row.seq,
              className: "orch-msg",
              "data-kind": row.kind
            },
            h(
              "div",
              { className: "orch-msg-head" },
              h(Badge, { tone: "muted" }, MESSAGE_KIND_LABEL2[row.kind] || row.kind),
              row.delivery ? h(Badge, {
                tone: DELIVERY_TONE2[row.delivery] || "muted",
                title: `投递状态：${DELIVERY_LABEL2[row.delivery] || row.delivery}`
              }, DELIVERY_LABEL2[row.delivery] || row.delivery) : null,
              h("span", { className: "orch-msg-at" }, timeLabel2(row.at))
            ),
            h("div", { className: "orch-msg-text" }, row.text)
          )),
          messages.length > shownMessages.length ? h("div", { className: "orch-muted" }, `仅显示最近 ${shownMessages.length} 条（共 ${messages.length} 条）。`) : null
        );
        const dependencies = Array.isArray(detail.dependencies) ? detail.dependencies : [];
        const dependents = Array.isArray(detail.dependents) ? detail.dependents : [];
        const depRow = (row) => {
          const tone = TONE_COLOR2[STATUS_TONE2[row.status]] || TONE_COLOR2.muted;
          return h(
            "div",
            { key: `${row.status}:${row.id}`, className: "orch-artifact" },
            h("span", { className: "orch-dot", style: { background: tone, color: tone } }),
            h("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere" }, title: row.error || row.id }, row.title),
            h(Badge, { tone: STATUS_TONE2[row.status] || "muted" }, STATUS_LABEL2[row.status] || row.status || "未知"),
            row.error ? h(Chip, { tone: "bad", title: row.error }, "有错误") : null
          );
        };
        const depBody = h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("div", { className: "orch-kv-key" }, "上游（前置任务）"),
          dependencies.length === 0 ? h("div", { className: "orch-muted" }, "没有前置任务。") : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, dependencies.map(depRow)),
          h("div", { className: "orch-kv-key" }, "下游（依赖本任务）"),
          dependents.length === 0 ? h("div", { className: "orch-muted" }, "没有下游任务。") : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, dependents.map(depRow))
        );
        const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
        const artifactBody = artifacts.length === 0 ? h("div", { className: "orch-muted" }, "还没有产物。") : h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 4 } },
          artifacts.map((item, index) => {
            const tone = item.exists === false ? TONE_COLOR2.bad : TONE_COLOR2.good;
            return h(
              "div",
              { key: `${item.path}:${index}`, className: "orch-artifact" },
              h("span", { className: "orch-dot", style: { background: tone, color: tone } }),
              h("span", { className: "orch-artifact-path", title: item.path }, item.path),
              item.label ? h("span", { className: "orch-muted" }, item.label) : null,
              item.exists === false ? h(Chip, { tone: "bad" }, "（未找到）") : null,
              h("button", { type: "button", className: "orch-btn orch-btn--sm", onClick: () => void copyPath(item.path) }, "复制路径")
            );
          })
        );
        return h(
          "div",
          { className: "orch-drawer-sections" },
          task.question ? h(Banner, {
            tone: "notice",
            icon: "alert"
          }, `需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(" / ")}）` : ""}`) : null,
          task.error ? h(Banner, { tone: "error", icon: "alert" }, `错误：${task.error}`) : null,
          detailSection("概览", "概览", "", overviewBody),
          detailSection("最新回复", "最新回复", lastMessage === null ? "" : timeLabel2(lastMessage.at), lastMessageBody),
          detailSection("Brief", "Brief", acceptance.length > 0 ? `验收 ${acceptance.length} 条` : "", briefBody),
          detailSection("目标状态", "目标状态", goalState === null ? "" : GOAL_PHASE_LABEL2[goalState.phase] || goalState.phase || "", goalBody),
          detailSection("消息", "消息", messages.length > 0 ? `${messages.length} 条` : "", messageBody),
          detailSection("依赖", "依赖", `上游 ${dependencies.length} · 下游 ${dependents.length}`, depBody),
          detailSection("产物", "产物", artifacts.length > 0 ? `${artifacts.length} 个` : "", artifactBody),
          goalNote
        );
      };
      const drawerFoot = () => {
        const buttons = [
          stopControl(detailTask),
          retryControl(detailTask),
          messageControl(detailTask, "追加消息"),
          detailTask.target ? openControl(detailTask.target, "打开子会话") : null,
          deleteControl(detailTask),
          // 不能删就说清原因：活跃任务先「停止」；终态但还有活跃下游先处理下游。
          detailTask.canDelete !== true ? h("span", { key: "delete-hint", className: "orch-muted" }, "当前不能删除：活跃任务先「停止」；有活跃下游依赖则先处理下游。") : null
        ].filter(Boolean);
        return buttons.length === 0 ? null : h("footer", { className: "orch-drawer-foot" }, buttons);
      };
      const drawerContent = () => h(
        "div",
        { className: "orch-drawer-content" },
        h(
          "header",
          { className: "orch-drawer-head" },
          h(
            "div",
            { className: "orch-drawer-title-row" },
            h("span", { className: "orch-drawer-title", title: drawerTitle }, drawerTitle),
            detailTask === null ? null : statusBadge(detailTask.status),
            h("button", {
              type: "button",
              className: "orch-icon-btn",
              title: "关闭（Esc）",
              onClick: closeDetail
            }, h(Icon, { name: "close" }))
          ),
          h(
            "div",
            { className: "orch-drawer-sub" },
            detailTask === null ? null : h("span", null, `编号 ${detailTask.id}`),
            detailTask === null ? null : h("span", null, `更新 ${timeLabel2(detailTask.updatedAt)}`),
            detailTask !== null && detailTask.readOnly === true ? h("span", null, "只读任务") : null,
            detailTask !== null && detailTask.planFirst === true ? h("span", null, `计划：${PLAN_STATE_LABEL2[detailTask.planState] || detailTask.planState || "无计划状态"}`) : null
          )
        ),
        h(
          "div",
          { className: "orch-drawer-body" },
          detailLoading ? drawerLoading() : null,
          detailError !== null ? drawerError() : null,
          detailTask === null ? null : detailBody()
        ),
        detailTask === null ? null : drawerFoot()
      );
      return h(
        "div",
        { className: "orch-shell" },
        topbar(),
        metrics(),
        h(
          "div",
          { className: "orch-body" },
          rail(),
          h(
            "main",
            { className: "orch-main" },
            alerts(),
            filter === "artifacts" ? artifactView() : listView()
          )
        ),
        // 第三段：抽屉常驻挂载，靠 data-open 触发 transform 过渡（关闭时滑出而不是瞬移）。
        h(
          "div",
          { className: "orch-layer" },
          h("div", {
            className: "orch-scrim",
            "data-open": drawerOpen ? "true" : "false",
            "aria-hidden": "true",
            onClick: closeDetail
          }),
          h("aside", {
            className: "orch-drawer",
            "data-open": drawerOpen ? "true" : "false",
            "aria-hidden": drawerOpen ? "false" : "true",
            "aria-label": "任务详情"
          }, drawerOpen ? drawerContent() : null)
        )
      );
    };
    return { HeaderButton, LauncherIcon, LauncherPanel, TasksPanel };
  }
  const createClient = (req) => {
    const React = req("react");
    const h = React.createElement;
    const inject = ["slots", "layout", "uiWorkspace"];
    const { Icon, Badge, Chip, EmptyState, Banner, SkeletonList } = createUi(h);
    const {
      HeaderButton,
      LauncherIcon,
      LauncherPanel,
      TasksPanel
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
      openMainOnce
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
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        inject: () => ({ openSession: (id) => ctx.uiWorkspace.openSession(id) })
      }, TasksPanel));
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: LAUNCHER_ID,
        inject: () => ({
          openMain: openMainOnce,
          openSession: (id) => ctx.uiWorkspace.openSession(id),
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
