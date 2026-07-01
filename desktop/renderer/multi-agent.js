/** Phase 2 — multi-agent tray, pane status, task board, handoff */

const QuillMultiAgent = (() => {
  let deps = null;
  const tasksByCwd = new Map();
  let agentsMenuEl = null;
  const spendByWs = new Map();

  const PRICE_PER_MTOK = {
    anthropic: { in: 3.0, out: 15.0 },
    cursor: { in: 3.0, out: 15.0 },
    local: { in: 0, out: 0 },
    auto: { in: 3.0, out: 15.0 },
  };

  function activeProvider() {
    return (deps?.getBootstrap?.()?.activeProvider || "auto").toLowerCase();
  }

  function estimateUsd(inTok, outTok, provider = activeProvider()) {
    const p = PRICE_PER_MTOK[provider] || PRICE_PER_MTOK.auto;
    return ((inTok * p.in) + (outTok * p.out)) / 1_000_000;
  }

  function fmtUsd(n) { return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }
  function fmtTok(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

  function ensureSpend(wsId) {
    if (!wsId) return null;
    if (!spendByWs.has(wsId)) spendByWs.set(wsId, { in: 0, out: 0, turns: 0, provider: activeProvider() });
    return spendByWs.get(wsId);
  }

  function updateSpendChip() {
    const wsId = deps?.activeWs?.()?.id;
    const chip = document.getElementById("status-spend");
    if (!chip) return;
    const s = wsId ? spendByWs.get(wsId) : null;
    if (!s || (!s.in && !s.out)) { chip.classList.add("hidden"); return; }
    const usd = estimateUsd(s.in, s.out, s.provider);
    chip.textContent = `${fmtUsd(usd)} · ${fmtTok(s.in + s.out)} tok`;
    chip.title = `In: ${s.in.toLocaleString()} / Out: ${s.out.toLocaleString()} across ${s.turns} turn(s)\nProvider: ${s.provider}`;
    chip.classList.remove("hidden");
  }

  function openSpendModal() {
    const modal = document.getElementById("spend-modal");
    const body = document.getElementById("spend-modal-body");
    if (!modal || !body) return;
    const state = deps?.getState?.() || { workspaces: [] };
    const rows = (state.workspaces || []).map((ws) => {
      const s = spendByWs.get(ws.id) || { in: 0, out: 0, turns: 0, provider: activeProvider() };
      const usd = estimateUsd(s.in, s.out, s.provider);
      return `<tr><td>${esc(ws.name)}</td><td>${esc(s.provider)}</td><td class="num">${s.in.toLocaleString()}</td><td class="num">${s.out.toLocaleString()}</td><td class="num">${s.turns}</td><td class="num">${fmtUsd(usd)}</td></tr>`;
    }).join("");
    const totals = [...spendByWs.values()].reduce((a, s) => ({ in: a.in + s.in, out: a.out + s.out, turns: a.turns + s.turns }), { in: 0, out: 0, turns: 0 });
    const totalUsd = estimateUsd(totals.in, totals.out);
    body.innerHTML = `
      <table>
        <thead><tr><th>Workspace</th><th>Provider</th><th>In</th><th>Out</th><th>Turns</th><th>Est. cost</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">No spend yet this session.</td></tr>`}</tbody>
        <tfoot><tr><td colspan="2"><strong>Total</strong></td><td class="num"><strong>${totals.in.toLocaleString()}</strong></td><td class="num"><strong>${totals.out.toLocaleString()}</strong></td><td class="num"><strong>${totals.turns}</strong></td><td class="num"><strong>${fmtUsd(totalUsd)}</strong></td></tr></tfoot>
      </table>
      <p style="margin-top:12px;color:var(--text-dim);font-size:11px">Estimates use approximate $3/M input, $15/M output. Local LLM = $0.</p>`;
    modal.classList.remove("hidden");
  }

  function bindSpendChip() {
    document.getElementById("status-spend")?.addEventListener("click", openSpendModal);
    document.getElementById("spend-modal-close")?.addEventListener("click", () => document.getElementById("spend-modal")?.classList.add("hidden"));
    document.getElementById("spend-modal")?.addEventListener("click", (e) => {
      if (e.target?.id === "spend-modal") e.currentTarget.classList.add("hidden");
    });
  }

  const TOOL_STATUS = {
    write_file: "editing",
    edit_file: "editing",
    multi_edit: "editing",
    apply_patch: "editing",
    execute_bash: "thinking",
    execute_bash_async: "thinking",
    bash: "thinking",
    finish: "idle",
    read_file: "thinking",
    grep: "thinking",
    glob: "thinking",
    code_search: "thinking",
    web_fetch: "thinking",
    spawn_agent: "thinking",
    bash_job_status: "waiting",
    bash_job_output: "waiting",
    wait_for_file: "waiting",
  };

  function strip(raw) {
    return window.QuillAgentStream?.stripAnsi(raw)
      ?? String(raw || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function defaultStatus() {
    return { status: "idle", currentTask: "", tokens: { in: 0, out: 0 }, lastUpdate: Date.now() };
  }

  function ensureStatus(inst) {
    if (!inst.status) Object.assign(inst, defaultStatus());
  }

  function updatePaneStatusUI(paneId, inst) {
    ensureStatus(inst);
    const pill = document.getElementById(`pane-status-${paneId}`);
    if (!pill) return;
    const { status, currentTask, tokens } = inst;
    pill.className = `pane-status ${status}`;
    const tok = (tokens.in || tokens.out) ? ` · ${tokens.in + tokens.out}` : "";
    const task = currentTask ? ` — ${currentTask.slice(0, 36)}` : "";
    pill.textContent = `${status}${task}${tok}`;
    pill.title = `${status}${task}\n${tokens.in || 0} in / ${tokens.out || 0} out`;
  }

  function mapToolStatus(name) {
    return TOOL_STATUS[name] || "thinking";
  }

  function parsePtyData(paneId, inst, raw) {
    if (!inst) return;
    ensureStatus(inst);
    const clean = strip(raw);

    const toolRe = /\[QUILL_TOOL:([^:\]]+):([^\]\r\n]*)\]/g;
    let m;
    while ((m = toolRe.exec(clean)) !== null) {
      const name = m[1];
      const detail = m[2] || "";
      inst.status = mapToolStatus(name);
      inst.currentTask = detail || name;
      inst.lastUpdate = Date.now();
    }

    const tokM = clean.match(/↳ turn used ([\d,]+) in \/ ([\d,]+) out tokens/);
    if (tokM) {
      const inTok = parseInt(tokM[1].replace(/,/g, ""), 10) || 0;
      const outTok = parseInt(tokM[2].replace(/,/g, ""), 10) || 0;
      inst.tokens.in = inTok || inst.tokens.in;
      inst.tokens.out = outTok || inst.tokens.out;
      inst.lastUpdate = Date.now();
      const wsId = inst.wsId || deps?.activeWs?.()?.id;
      if (wsId && (inTok || outTok)) {
        const s = ensureSpend(wsId);
        s.in += inTok;
        s.out += outTok;
        s.turns += 1;
        s.provider = activeProvider();
        updateSpendChip();
      }
    }

    const errM = /\b(error|failed|is_error)\b/i.test(clean) && /\[QUILL_TOOL:/.test(clean);
    if (errM) inst.status = "error";

    updatePaneStatusUI(paneId, inst);
    void ingestTaskMarkers(clean, inst.wsId);
  }

  function countRunningAgents() {
    const state = deps?.getState?.() || { workspaces: [] };
    const terms = deps?.getTermInstances?.() || new Map();
    let n = 0;
    for (const ws of state.workspaces || []) {
      if (ws.agentStopped) continue;
      if ((ws.paneIds || []).some((pid) => terms.has(pid))) n += 1;
    }
    return n;
  }

  function hideAgentsMenu() {
    agentsMenuEl?.remove();
    agentsMenuEl = null;
  }

  function updateAgentsTrayBadge() {
    const badge = document.getElementById("agents-tray-badge");
    if (!badge) return;
    const n = countRunningAgents();
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("hidden", n === 0);
  }

  function showAgentsTrayMenu(e) {
    hideAgentsMenu();
    const state = deps?.getState?.() || { workspaces: [] };
    const terms = deps?.getTermInstances?.() || new Map();
    const items = (state.workspaces || []).filter((ws) => {
      if (ws.agentStopped) return false;
      return (ws.paneIds || []).some((pid) => terms.has(pid));
    });
    if (!items.length) return;

    const menu = document.createElement("div");
    menu.className = "agents-tray-menu";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    items.forEach((ws) => {
      const panes = (ws.paneIds || []).filter((pid) => terms.has(pid)).length;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `<span class="agents-tray-dot"></span><span>${esc(ws.name)}</span><small>${panes} pane${panes === 1 ? "" : "s"}</small>`;
      btn.onclick = () => {
        hideAgentsMenu();
        deps?.switchWorkspace?.(ws.id);
      };
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    agentsMenuEl = menu;
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target.id !== "agents-tray-btn") {
        hideAgentsMenu();
        document.removeEventListener("click", close, true);
      }
    };
    setTimeout(() => document.addEventListener("click", close, true), 0);
  }

  async function loadTasksForCwd(cwd) {
    if (!cwd) return [];
    if (tasksByCwd.has(cwd)) return tasksByCwd.get(cwd);
    try {
      const res = await window.quill.getTasks(cwd);
      const tasks = res.tasks || [];
      tasksByCwd.set(cwd, tasks);
      return tasks;
    } catch (_) {
      return [];
    }
  }

  async function saveTasksForCwd(cwd, tasks) {
    if (!cwd) return;
    tasksByCwd.set(cwd, tasks);
    try {
      await window.quill.saveTasks({ cwd, tasks });
    } catch (_) {}
    renderTaskBoard();
  }

  const recentNotifyKeys = new Set();
  function notifyBackgroundDone(ws, title) {
    try {
      const state = deps?.getState?.();
      if (!state || !ws) return;
      if (state.activeWorkspace === ws.id) return;
      const key = `${ws.id}:${title}`;
      if (recentNotifyKeys.has(key)) return;
      recentNotifyKeys.add(key);
      setTimeout(() => recentNotifyKeys.delete(key), 30_000);
      window.QuillModules?.util?.showToast?.(`${ws.name} finished: ${title}`);
      const prefs = state.notifications || {};
      if (prefs.osNotifications !== false && "Notification" in window) {
        try {
          if (Notification.permission === "granted") {
            new Notification(`Quill — ${ws.name}`, { body: `Task complete: ${title}`, silent: true });
          } else if (Notification.permission !== "denied") {
            Notification.requestPermission();
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  async function ingestTaskMarkers(clean, wsId) {
    const ws = deps?.getState?.()?.workspaces?.find((w) => w.id === wsId);
    const cwd = ws?.cwd;
    if (!cwd) return;
    let tasks = await loadTasksForCwd(cwd);
    let changed = false;

    const startRe = /\[QUILL:TASK_START\s+([^\s\]]+)\s+([^\]]+)\]/g;
    let sm;
    while ((sm = startRe.exec(clean)) !== null) {
      const id = sm[1];
      const title = sm[2].trim();
      const existing = tasks.find((t) => t.id === id);
      if (existing) {
        existing.title = title;
        existing.status = existing.status || "pending";
      } else {
        tasks.push({ id, title, status: "pending", createdAt: Date.now() });
      }
      changed = true;
    }

    const doneRe = /\[QUILL:TASK_DONE\s+([^\s\]]+)\]/g;
    let dm;
    while ((dm = doneRe.exec(clean)) !== null) {
      const id = dm[1];
      const t = tasks.find((x) => x.id === id);
      if (t) {
        t.status = "done";
        t.doneAt = Date.now();
        changed = true;
        notifyBackgroundDone(ws, t.title || id);
      }
    }

    const legacyM = clean.match(/\[QUILL_TASK:([^\]]+)\]/);
    if (legacyM) {
      try {
        const parsed = JSON.parse(legacyM[1]);
        if (Array.isArray(parsed)) {
          tasks = parsed.map((t, i) => ({
            id: String(i + 1),
            title: t.text || t.title || "",
            status: t.status || "pending",
          }));
          changed = true;
        }
      } catch (_) {}
    }

    if (changed) await saveTasksForCwd(cwd, tasks);
  }

  function renderTaskBoard() {
    const list = document.getElementById("task-board-list");
    if (!list) return;
    const ws = deps?.activeWs?.();
    const cwd = ws?.cwd;
    if (!cwd) {
      list.innerHTML = `<li class="task-empty">Open a folder to track tasks</li>`;
      return;
    }
    void loadTasksForCwd(cwd).then((tasks) => {
      if (!tasks.length) {
        list.innerHTML = `<li class="task-empty">No tasks yet — agent uses task_track</li>`;
        return;
      }
      const icons = { pending: "○", in_progress: "◐", done: "●" };
      list.innerHTML = tasks.map((t) =>
        `<li class="task-item task-${esc(t.status || "pending")}" data-id="${esc(t.id)}">
          <span class="task-icon">${icons[t.status] || "○"}</span>
          <span class="task-title">${esc(t.title)}</span>
        </li>`
      ).join("");
    });
  }

  function formatComposerWrite(text, targetPaneId) {
    const ws = deps?.agentPanelWs?.();
    if (!targetPaneId || !ws?.paneIds?.includes(targetPaneId)) return text;
    const primary = ws.paneIds[0];
    if (targetPaneId === primary) return text;
    const persona = deps?.getPanePersona?.(targetPaneId) || "Agent";
    return `/handoff ${persona}\n${text}`;
  }

  function bindAgentsTray() {
    document.getElementById("agents-tray-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      showAgentsTrayMenu(e);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideAgentsMenu();
    });
  }

  function bindProviderSwitcher() {
    const sel = document.getElementById("status-provider");
    if (!sel) return;
    const providers = deps?.getBootstrap?.()?.providers || ["auto", "anthropic", "cursor", "local"];
    const active = deps?.getBootstrap?.()?.activeProvider || "auto";
    const localOk = deps?.getBootstrap?.()?.localLlmAvailable;
    sel.innerHTML = providers.map((p) => {
      const label = p === "local" && !localOk ? `${p} (offline)` : p;
      const dis = p === "local" && !localOk ? " disabled" : "";
      return `<option value="${esc(p)}"${p === active ? " selected" : ""}${dis}>${esc(label)}</option>`;
    }).join("");
    sel.onchange = async () => {
      const v = sel.value;
      const res = await window.quill.setProvider(v);
      if (res?.ok) deps?.showToast?.(`Provider: ${v}`);
      else deps?.showToast?.(res?.error || "Provider switch failed");
    };
  }

  function onPaneMounted(paneId, inst) {
    Object.assign(inst, defaultStatus());
    updatePaneStatusUI(paneId, inst);
    updateAgentsTrayBadge();
  }

  function onPaneRemoved() {
    updateAgentsTrayBadge();
  }

  function onWorkspaceChange() {
    updateAgentsTrayBadge();
    renderTaskBoard();
    tasksByCwd.clear();
    updateSpendChip();
  }

  function init(hooks) {
    deps = hooks;
    bindAgentsTray();
    bindProviderSwitcher();
    bindSpendChip();
    updateAgentsTrayBadge();
    updateSpendChip();
    renderTaskBoard();
  }

  return {
    init,
    parsePtyData,
    updateAgentsTrayBadge,
    formatComposerWrite,
    onPaneMounted,
    onPaneRemoved,
    onWorkspaceChange,
    renderTaskBoard,
    updatePaneStatusUI,
  };
})();

window.QuillMultiAgent = QuillMultiAgent;
