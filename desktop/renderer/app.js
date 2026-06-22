/** Quill desktop — workspace + xterm agent terminals */

const state = { workspaces: [], activeWorkspace: null, theme: "dark", panes: {} };
const termInstances = new Map();
const gitCache = {};
const expandedDirs = new Set();
let editorFilePath = null;
let editorDirty = false;
let monacoEditor = null;
let monacoDiff = null;
let monacoInitPromise = null;
let activeEditorTab = "file";
let bootstrap = null;
let settingsSection = "appearance";
let mcpDraft = { servers: {} };
let activeSidePanel = "explorer";
let agentChatLineBuffer = "";
let primaryPaneId = null;
let agentChatFlushTimer = null;
const wsChats = {};
const agentSeenChatLines = new Set();
const AGENT_DEDUPE_BANNERS = new Set([
  "code beautiful", "quill", "provider:", "model:", "fallback chain:",
  "workspace:", "instruction files:", "type /help", "tip:", "token savings:",
]);
const AGENT_DEDUPE_MAX = 240;
const TREE_SKIP = new Set(["node_modules", ".git", ".codegraph", "__pycache__", "dist", "build"]);
const TREE_SKIP_FILES = /^NTUSER\.DAT|^ntuser\.dat|^desktop\.ini$/i;
let agentPanelMode = "open";
/** When false (default), only structured markers + prose replies reach agent chat. */
let agentPtyToChat = false;
const MAX_PANES = 9;
const DEFAULT_PERSONA = "Hera";

/** CSS vars that themed presets may set inline on <html> — must clear when switching back to Dark. */
const THEME_CSS_VARS = [
  "--bg", "--bg-panel", "--bg-header", "--bg-activity", "--border",
  "--text", "--text-dim", "--accent", "--accent-purple",
];

function monacoThemeId() {
  return state.theme === "imode" ? "vs" : "vs-dark";
}

function ptyWorkspaceId(ptyId) {
  for (const [, t] of termInstances) {
    if (t.ptyId === ptyId) return t.wsId;
  }
  return null;
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\[\?[0-9;]*[hlm]/g, "")
    .replace(/\r/g, "");
}

function cleanTerminalLine(line) {
  return String(line || "")
    .replace(/[│┃┆┇┊┋║╭╮╰╯┌┐└┘├┤┬┴┼─═▌▀]+/g, " ")
    .replace(/\[[^\]]*\]/g, (m) => (/bold|dim|cyan|green|red|yellow|italic/i.test(m) ? " " : m))
    .replace(/\s+/g, " ")
    .trim();
}

function isTerminalNoise(line) {
  const s = cleanTerminalLine(line);
  if (!s || s.length < 2) return true;
  if (/^[\[\?\d;]+[a-zA-Z]$/.test(s) || /^\[\?[0-9;]*[hlm]$/i.test(s)) return true;
  if (/file:\/\/|cursor-sdk|_MEI\d+|bridge\.dist|node_modules|Error \[ERR/i.test(s)) return true;
  if (/traceback|systemexit|httpx|httpcore|connecterror|readtimeout|connection refused/i.test(s)) return true;
  if (/^\s*file "/i.test(s) || /\bfile "[^"]+", line \d+/i.test(s)) return true;
  if (/^\s*at .+\(.+\)$/i.test(s) || /^raise .+ from /i.test(s)) return true;
  if (/^CODE BEAUTIFUL$/i.test(s) || /^Quill$/i.test(s)) return true;
  if (/^(Provider|Model|Fallback chain|Workspace|Instruction files|Type \/help|Tip|Token savings):/i.test(s)) return true;
  if (/^(thinking|reading|writing|running|searching|exploring|working|finishing)\.{0,3}$/i.test(s)) return true;
  if (/^you\s*[›>]|^You >|^Quill\s|^Workspace:|^Instruction files:|^Tip:|^Token savings:/i.test(s)) return true;
  if (/^[\\\/~]|^[A-Za-z]:\\|^[\$>#%]|^>>>|^In \[/i.test(s)) return true;
  if (/^[\W_]+$/.test(s) || /^[\d\s:.-]+$/.test(s)) return true;
  if (/^[\[(]?[?0-9;]+[a-zA-Z]\]?$/.test(s)) return true;
  if (/\.py:\d+|__pycache__|site-packages/i.test(s)) return true;
  if (/^(Error|Exception|Warning|INFO|DEBUG|CRITICAL):/i.test(s)) return true;
  if (/^[\s│┃─═╭╮╰╯┌┐└┘]+$/.test(s)) return true;
  if (/^(Task complete|----)/i.test(s)) return true;
  if (/^[🔧📖✍️✏️📂🔍🔎✅⚙️🤖📊🔄📁📝💡⏳✨🤔💭❌ℹ️🚨⚠️]/.test(s)) return true;
  return false;
}

function isAgentReplyLine(line) {
  const s = cleanTerminalLine(line);
  if (!s || s.length < 8 || s.length > 4000) return false;
  if (isTerminalNoise(s)) return false;
  if (!/[a-zA-Z]{2,}/.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2 && s.length < 24) return false;
  if (/^[\d\W_]+$/.test(s)) return false;
  return true;
}

function shouldDedupeBannerLine(line) {
  const key = cleanTerminalLine(line).toLowerCase();
  if (!key) return true;
  for (const banner of AGENT_DEDUPE_BANNERS) {
    if (key === banner || key.startsWith(banner)) return true;
  }
  return /^code beautiful$/i.test(key);
}

function rememberAgentChatLine(line) {
  agentSeenChatLines.add(line);
  if (agentSeenChatLines.size > AGENT_DEDUPE_MAX) {
    const first = agentSeenChatLines.values().next().value;
    agentSeenChatLines.delete(first);
  }
}

function isDuplicateAgentChatLine(line) {
  if (shouldDedupeBannerLine(line)) return true;
  if (agentSeenChatLines.has(line)) return true;
  rememberAgentChatLine(line);
  return false;
}

function shouldStreamPtyToAgentChat() {
  return agentPtyToChat && agentPanelMode !== "closed";
}

function getCommands() {
  const cmds = [
    { id: "settings", label: "Open settings", run: () => openSettings("appearance") },
    { id: "new-pane", label: "New terminal pane", run: () => addPane() },
    { id: "open-folder", label: "Open folder", run: () => openFolder() },
    { id: "theme", label: "Cycle theme", run: () => cycleTheme() },
    { id: "mcp-settings", label: "Open MCP settings", run: () => openSettings("mcp") },
    { id: "git-refresh", label: "Refresh git info", run: () => refreshAllGitInfo() },
    { id: "sync-workspace", label: "Export workspace sync", run: () => exportWorkspaceSync() },
    { id: "import-sync", label: "Import workspace sync", run: () => importWorkspaceSync() },
    { id: "toggle-agent", label: "Toggle agent panel", run: () => toggleAgentPanel() },
    { id: "stop-agent", label: "Stop workspace agent", run: () => stopWorkspaceAgent(state.activeWorkspace) },
    { id: "start-agent", label: "Start workspace agent", run: () => startWorkspaceAgent(state.activeWorkspace) },
  ];
  state.workspaces.forEach((ws) => {
    cmds.push({
      id: `ws-${ws.id}`,
      label: `Switch workspace: ${ws.name}`,
      run: () => switchWorkspace(ws.id),
    });
  });
  return cmds;
}

function createFitAddon() {
  if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) return new FitAddon.FitAddon();
  if (typeof FitAddon !== "undefined") return new FitAddon();
  return null;
}

function termTheme() {
  const t = bootstrap?.themes?.[state.theme];
  return t?.terminal || { background: "#0b0b0b", foreground: "#cccccc", cursor: "#3794ff" };
}

async function init() {
  bootstrap = await window.quill.getBootstrap();
  Object.assign(state, bootstrap.state);
  state.workspaces?.forEach((ws) => {
    if (ws.named == null) ws.named = false;
    if (ws.agentStopped == null) ws.agentStopped = false;
  });
  for (const ws of state.workspaces || []) {
    await sanitizeWorkspacePanes(ws);
  }
  persist();
  if (state.agentPanelMode == null) {
    state.agentPanelMode = state.agentPanelOpen === false ? "closed" : "open";
  }
  if (!state.workspaces?.length) resetDefaultState();
  if (!state.agentPanelWorkspaceId) state.agentPanelWorkspaceId = state.activeWorkspace;
  applyTheme();
  renderWorkspaces();
  renderAgentPanelWorkspaceSelect();
  bindAgentPanelWorkspaceSelect();
  await renderPanes();
  document.getElementById("status-path").textContent = bootstrap.quillPath || "Quill";
  await refreshAllGitInfo();
  await renderFileTree();
  renderSettingsNav();
  bindEvents();
  bindMenubar();
  bindEditorDrawer();
  bindScm();
  bindActivityBar();
  bindSideSearch();
  setAgentPanelMode(state.agentPanelMode || "open", { persist: false });
  void ensureMonaco();
  populateAgentPersona();
  updateTitlebar();
  updateWorkspaceHead();
  restoreAgentChat(state.agentPanelWorkspaceId || state.activeWorkspace);
  bindAgentStreamToggle();
  document.getElementById("ws-add-terminal")?.addEventListener("click", () => addPane());
  document.getElementById("ws-toggle-agent")?.addEventListener("click", () => toggleWorkspaceAgent());
  document.getElementById("agent-panel-minimize")?.addEventListener("click", () => setAgentPanelMode("minimized"));
  document.getElementById("agent-panel-hide")?.addEventListener("click", () => setAgentPanelMode("closed"));
  document.getElementById("agent-panel-expand")?.addEventListener("click", () => setAgentPanelMode("open"));
  document.getElementById("agent-panel")?.addEventListener("click", (e) => {
    if (agentPanelMode === "minimized" && !e.target.closest("button")) setAgentPanelMode("open");
  });
  document.querySelectorAll("[data-action='open-folder']").forEach((el) => {
    el.addEventListener("click", (e) => { e.preventDefault(); openFolder(); });
  });
  document.querySelectorAll("[data-action='focus-terminal']").forEach((el) => {
    el.addEventListener("click", (e) => { e.preventDefault(); focusWorkspaceTerminal(); });
  });

  window.QuillFeatures?.init({
    activeWs,
    ensureMonaco,
    getEditor: () => monacoEditor,
    getEditorPath: () => editorFilePath,
    setEditorPath: (p) => { editorFilePath = p; },
    setDirty: (d) => { editorDirty = d; },
    guessLang: guessMonacoLang,
    updateDirtyUI: updateEditorDirty,
    updateTitlebar,
    closeEditor,
    saveEditor,
    refreshEditor: refreshEditorContent,
    refreshGit: refreshGitInfo,
    openPalette,
    toggleTerminal: () => toggleTerminalPanel(),
    openFolder,
    showToast,
    pathsEqual,
    resolvePath: resolveWsPath,
    setEditorTab,
    getState: () => state,
    getEditorPath: () => editorFilePath,
    _lspRegistered: false,
  });

  window.QuillCowork?.init({
    activeWs: agentPanelWs,
    resolvePath: resolveWsPath,
    pathsEqual,
    refreshEditor: refreshEditorContent,
    refreshGit: refreshGitInfo,
    showToast,
    getEditorPath: () => editorFilePath,
    getPrimaryPtyId: () => {
      const ws = agentPanelWs();
      const pid = ws?.paneIds?.[0];
      return pid ? termInstances.get(pid)?.ptyId : termInstances.get(primaryPaneId)?.ptyId;
    },
    getPtyId: (paneId) => termInstances.get(paneId)?.ptyId,
    listPanes: () => agentPanelWs()?.paneIds || [],
    getPanePersona: (paneId) => state.panes[paneId]?.persona || "Agent",
    getPersonas: () => bootstrap?.personas || [],
    addPane: (persona) => addPane(persona),
    onDelegateChange: () => populateAgentPersona(),
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void saveEditor();
    }
  });

  window.quill.onPtyData(({ id, data }) => {
    const wsId = ptyWorkspaceId(id);
    for (const [paneId, t] of termInstances) {
      if (t.ptyId === id) {
        t.term.write(data);
        if (wsId === state.activeWorkspace) pulseActivity(paneId);
      }
    }
    const agentWsId = state.agentPanelWorkspaceId || state.activeWorkspace;
    if (wsId !== agentWsId) return;
    window.QuillFeatures?.parseAgentStream(data);
    if (shouldStreamPtyToAgentChat()) appendAgentStream(data);
    const editMatch = data.match(/\[QUILL_EDIT:([^\]\r\n]+)\]/);
    if (editMatch) void onWorkspaceFileChanged(resolveWsPath(editMatch[1]));
  });
  window.quill.onPtyExit(({ id }) => {
    for (const [, t] of termInstances) {
      if (t.ptyId === id) t.term.write("\r\n\x1b[33m[Agent exited]\x1b[0m\r\n");
    }
  });
  window.quill.onWorkspaceFileChanged(({ path }) => {
    void onWorkspaceFileChanged(path);
  });

  window.__quillShutdown = async () => {
    persist();
    await killAllPanes();
  };
}

function resetDefaultState() {
  const paneId = "pane-main";
  state.stateVersion = 3;
  state.workspaces = [{
    id: "ws-main", name: "Quill", color: bootstrap.rainbow[4], cwd: "",
    folders: [], panes: 1, layout: "grid-1x1", paneIds: [paneId], named: false,
  }];
  state.activeWorkspace = "ws-main";
  state.panes = { [paneId]: { persona: DEFAULT_PERSONA, mode: "agent" } };
}

function appendAgentChat(role, text) {
  const box = document.getElementById("agent-chat");
  if (!box || !text?.trim()) return;
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  el.textContent = text.trim();
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function appendAgentStream(raw) {
  agentChatLineBuffer += stripAnsi(raw);
  clearTimeout(agentChatFlushTimer);
  agentChatFlushTimer = setTimeout(flushAgentStreamBuffer, 450);
}

function flushAgentStreamBuffer() {
  const lines = agentChatLineBuffer.split("\n").map(cleanTerminalLine).filter(Boolean);
  agentChatLineBuffer = "";
  const filtered = lines.filter((l) => {
    if (/\[QUILL_(TOOL|EDIT|TASK|BROWSER|REPLY):/.test(l)) return false;
    if (isDuplicateAgentChatLine(l)) return false;
    return agentPtyToChat ? !isTerminalNoise(l) : isAgentReplyLine(l);
  });
  const chunk = filtered.slice(-4).join("\n");
  if (chunk.length > 2) appendAgentChat("agent", chunk);
}

window.QuillAgentStream = { stripAnsi, cleanTerminalLine, isTerminalNoise };

function saveAgentChat(wsId) {
  if (!wsId) return;
  const box = document.getElementById("agent-chat");
  if (!box) return;
  wsChats[wsId] = [...box.querySelectorAll(".chat-msg")].map((el) => ({
    role: [...el.classList].find((c) => c !== "chat-msg") || "agent",
    text: el.textContent || "",
  }));
}

function restoreAgentChat(wsId) {
  const box = document.getElementById("agent-chat");
  if (!box) return;
  box.innerHTML = "";
  const msgs = wsChats[wsId] || [];
  if (!msgs.length) {
    const ws = state.workspaces.find((w) => w.id === wsId);
    appendAgentChat("system", `${ws?.name || "Workspace"} — isolated agent (other workspaces can't see this chat).`);
  } else {
    msgs.forEach((m) => appendAgentChat(m.role, m.text));
  }
}

function setAgentPanelMode(mode, { persist: doPersist = true } = {}) {
  agentPanelMode = mode;
  state.agentPanelMode = mode;
  const panel = document.getElementById("agent-panel");
  const closed = mode === "closed";
  const minimized = mode === "minimized";
  panel?.classList.toggle("hidden", closed);
  panel?.classList.toggle("minimized", minimized);
  document.body.classList.toggle("agent-hidden", closed);
  document.querySelector('.activity-btn[data-panel="agent"]')
    ?.classList.toggle("active", !closed);
  if (doPersist) persist();
  setTimeout(() => fitActiveTerminals(), 120);
}

function toggleAgentPanel() {
  if (agentPanelMode === "closed") setAgentPanelMode("open");
  else setAgentPanelMode("closed");
}

function setAgentPanelOpen(open) {
  setAgentPanelMode(open ? "open" : "closed");
}

function isWorkspaceAgentRunning(ws) {
  if (!ws || ws.agentStopped) return false;
  return (ws.paneIds || []).some((id) => termInstances.has(id));
}

function updateAgentStoppedOverlay(ws) {
  const grid = getWsGrid(ws);
  if (!grid) return;
  grid.querySelector(".agent-stopped-overlay")?.remove();
  grid.classList.toggle("agent-stopped", Boolean(ws?.agentStopped));
  if (!ws?.agentStopped) return;
  const overlay = document.createElement("div");
  overlay.className = "agent-stopped-overlay";
  overlay.innerHTML = `<p>Agent stopped for this workspace</p><button type="button" class="btn-primary ws-start-agent">Start agent</button>`;
  overlay.querySelector(".ws-start-agent").onclick = () => startWorkspaceAgent(ws.id);
  grid.appendChild(overlay);
}

function updateAgentComposerState() {
  const wrap = document.querySelector(".agent-composer-wrap");
  const ws = agentPanelWs();
  wrap?.classList.toggle("agent-disabled", Boolean(ws?.agentStopped));
}

async function stopWorkspaceAgent(wsId) {
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws || ws.agentStopped) return;
  for (const paneId of ws.paneIds || []) {
    const t = termInstances.get(paneId);
    if (t) {
      await window.quill.ptyKill(t.ptyId);
      t.term.dispose();
      termInstances.delete(paneId);
    }
  }
  ws.agentStopped = true;
  persist();
  updateAgentStoppedOverlay(ws);
  renderWorkspaces();
  updateWorkspaceHead();
  updateAgentComposerState();
  if (wsId === (state.agentPanelWorkspaceId || state.activeWorkspace)) bindGlobalComposer();
}

async function startWorkspaceAgent(wsId) {
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws || !ws.agentStopped) return;
  ws.agentStopped = false;
  persist();
  await ensureWorkspaceUI(ws);
  const panelWs = state.agentPanelWorkspaceId || state.activeWorkspace;
  if (wsId === panelWs) {
    bindGlobalComposer();
    populateAgentPersona();
    window.QuillCowork?.populateDelegateSelect();
  }
  updateAgentStoppedOverlay(ws);
  renderWorkspaces();
  updateWorkspaceHead();
  updateAgentComposerState();
}

function toggleWorkspaceAgent() {
  const ws = activeWs();
  if (!ws) return;
  if (ws.agentStopped) void startWorkspaceAgent(ws.id);
  else void stopWorkspaceAgent(ws.id);
}

let wsContextMenuEl = null;
function hideWsContextMenu() {
  wsContextMenuEl?.remove();
  wsContextMenuEl = null;
}

function showWsContextMenu(e, ws) {
  hideWsContextMenu();
  const menu = document.createElement("div");
  menu.className = "ws-context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  const running = isWorkspaceAgentRunning(ws);
  if (running) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "danger";
    stop.textContent = "Stop agent";
    stop.onclick = () => { hideWsContextMenu(); void stopWorkspaceAgent(ws.id); };
    menu.appendChild(stop);
  } else if (ws.agentStopped) {
    const start = document.createElement("button");
    start.type = "button";
    start.textContent = "Start agent";
    start.onclick = () => { hideWsContextMenu(); void startWorkspaceAgent(ws.id); };
    menu.appendChild(start);
  }
  const switchBtn = document.createElement("button");
  switchBtn.type = "button";
  switchBtn.textContent = "Switch workspace";
  switchBtn.onclick = () => { hideWsContextMenu(); void switchWorkspace(ws.id); };
  menu.appendChild(switchBtn);
  const openFolderBtn = document.createElement("button");
  openFolderBtn.type = "button";
  openFolderBtn.textContent = "Open folder";
  openFolderBtn.onclick = () => { hideWsContextMenu(); void openFolderForWorkspace(ws.id); };
  menu.appendChild(openFolderBtn);
  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.textContent = "Rename";
  renameBtn.onclick = () => { hideWsContextMenu(); renameWorkspace(ws.id); };
  menu.appendChild(renameBtn);
  if (state.workspaces.length > 1) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "danger";
    closeBtn.textContent = "Close workspace";
    closeBtn.onclick = () => { hideWsContextMenu(); void closeWorkspace(ws.id); };
    menu.appendChild(closeBtn);
  }
  document.body.appendChild(menu);
  wsContextMenuEl = menu;
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    hideWsContextMenu();
    document.removeEventListener("click", close);
    document.removeEventListener("contextmenu", close);
  };
  setTimeout(() => {
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
  }, 0);
}

function bindAgentStreamToggle() {
  const actions = document.querySelector(".agent-toolbar-actions");
  if (!actions || document.getElementById("agent-stream-toggle")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "agent-stream-toggle";
  btn.className = "agent-icon-btn";
  btn.title = "Stream terminal output into chat (off = replies & tools only)";
  btn.textContent = "⌗";
  btn.setAttribute("aria-pressed", "false");
  btn.onclick = () => {
    agentPtyToChat = !agentPtyToChat;
    btn.classList.toggle("active", agentPtyToChat);
    btn.setAttribute("aria-pressed", agentPtyToChat ? "true" : "false");
  };
  actions.prepend(btn);
}

function focusWorkspaceTerminal() {
  const ws = activeWs();
  if (!ws) return;
  showWorkspaceGrid(ws.id);
  const paneId = (primaryPaneId && ws.paneIds?.includes(primaryPaneId))
    ? primaryPaneId
    : ws.paneIds?.[0];
  if (paneId) focusPane(paneId);
}

function focusPane(paneId) {
  primaryPaneId = paneId;
  const host = document.getElementById(`term-${paneId}`);
  termInstances.get(paneId)?.term?.focus();
  host?.focus();
  fitActiveTerminals();
  bindGlobalComposer();
}

function updateWorkspaceHead() {
  const ws = activeWs();
  const nameEl = document.getElementById("ws-center-name");
  const personaEl = document.getElementById("ws-center-persona");
  const dot = document.getElementById("ws-head-dot");
  const toggleBtn = document.getElementById("ws-toggle-agent");
  if (!ws) return;
  if (nameEl) nameEl.textContent = ws.name;
  if (dot) {
    const running = isWorkspaceAgentRunning(ws);
    dot.style.background = running ? "#4ec994" : "#e06c75";
  }
  const pid = ws.paneIds?.[0];
  const persona = pid ? state.panes[pid]?.persona : "";
  if (personaEl) personaEl.textContent = persona ? `· ${persona}` : "";
  if (toggleBtn) {
    const stopped = Boolean(ws.agentStopped);
    toggleBtn.textContent = stopped ? "Start agent" : "Stop agent";
    toggleBtn.title = stopped ? "Start workspace agent" : "Stop workspace agent (kill PTY)";
    toggleBtn.classList.toggle("ws-head-btn-danger", !stopped);
    toggleBtn.classList.toggle("ws-head-btn-start", stopped);
  }
  updateAgentStoppedOverlay(ws);
  updateAgentComposerState();
  const folder = ws.named && ws.cwd ? ws.cwd.split(/[/\\]/).pop() : "No folder — open one to browse files";
  document.getElementById("status-path").textContent = ws.cwd || folder;
}

let fitTerminalsRaf = null;
function fitActiveTerminals() {
  if (fitTerminalsRaf) return;
  fitTerminalsRaf = requestAnimationFrame(() => {
    fitTerminalsRaf = null;
    const ws = activeWs();
    if (!ws?.paneIds) return;
    for (const paneId of ws.paneIds) {
      termInstances.get(paneId)?.fit?.fit();
    }
  });
}

function getWsGrid(ws) {
  const stage = document.getElementById("workspace-stage");
  if (!stage || !ws) return null;
  let grid = document.getElementById(`pane-grid-${ws.id}`);
  if (!grid) {
    grid = document.createElement("div");
    grid.id = `pane-grid-${ws.id}`;
    grid.dataset.wsId = ws.id;
    grid.className = `pane-grid ${ws.layout || "grid-1x1"} ws-pane-grid hidden`;
    stage.appendChild(grid);
  }
  return grid;
}

function updateCenterView() {
  document.getElementById("empty-state")?.classList.add("hidden");
  const ws = activeWs();
  if (ws) {
    document.getElementById("workspace-center-head")?.classList.remove("hidden");
  }
}

function showWorkspaceGrid(wsId) {
  document.querySelectorAll(".ws-pane-grid").forEach((g) => {
    g.classList.toggle("hidden", g.dataset.wsId !== wsId);
  });
  updateCenterView();
  updateWorkspaceHead();
  setTimeout(() => fitActiveTerminals(), 150);
}

function updateTitlebar() {
  const ws = activeWs();
  const folder = ws?.cwd ? ws.cwd.split(/[/\\]/).pop() : "Quill";
  const file = editorFilePath ? editorFilePath.split(/[/\\]/).pop() : "";
  const el = document.getElementById("titlebar-title");
  if (el) el.textContent = file ? `${folder} — ${file}` : folder;
}

function toggleTerminalPanel() {
  const ws = activeWs();
  if (!ws) return;
  showWorkspaceGrid(ws.id);
  focusWorkspaceTerminal();
}

function bindActivityBar() {
  document.querySelectorAll(".activity-btn[data-panel]").forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.panel === "settings") {
        openSettings("appearance");
        return;
      }
      activeSidePanel = btn.dataset.panel;
      if (activeSidePanel === "agent") {
        if (agentPanelMode === "closed") setAgentPanelMode("open");
        else if (agentPanelMode === "minimized") setAgentPanelMode("open");
        else setAgentPanelMode("closed");
        if (agentPanelMode === "open") document.getElementById("agent-composer-input")?.focus();
        return;
      }
      document.querySelectorAll(".activity-btn[data-panel]").forEach((b) => {
        b.classList.toggle("active", b.dataset.panel === activeSidePanel);
      });
      document.querySelectorAll(".panel-view").forEach((p) => {
        p.classList.toggle("active", p.dataset.view === activeSidePanel);
      });
    };
  });
  document.querySelectorAll(".side-link-btn[data-action]").forEach((btn) => {
    btn.onclick = () => handleAction(btn.dataset.action);
  });
}

function bindSideSearch() {
  const input = document.getElementById("side-search");
  const ul = document.getElementById("search-results");
  if (!input || !ul) return;
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { ul.innerHTML = ""; return; }
      const ws = activeWs();
      const res = await window.quill.searchFiles({ cwd: ws?.cwd, query: q, limit: 30 });
      ul.innerHTML = (res.files || []).map((f) =>
        `<li data-path="${escHtml(f.path)}">${escHtml(f.rel)}</li>`
      ).join("");
      ul.querySelectorAll("li").forEach((li) => {
        li.onclick = () => openFileInEditor(li.dataset.path);
      });
    }, 150);
  };
}

function pickUnusedPersonaFromUsed(used) {
  const personas = bootstrap?.personas || [DEFAULT_PERSONA];
  for (const p of personas) {
    if (!used.has(p)) return p;
  }
  return personas[0];
}

function pickUnusedPersona(ws) {
  const used = new Set(
    (ws?.paneIds || []).map((id) => state.panes[id]?.persona).filter(Boolean)
  );
  return pickUnusedPersonaFromUsed(used);
}

async function sanitizeWorkspacePanes(ws) {
  if (!ws?.paneIds?.length) return;
  let changed = false;

  if (ws.paneIds.length > MAX_PANES) {
    const removed = ws.paneIds.splice(MAX_PANES);
    for (const paneId of removed) {
      const t = termInstances.get(paneId);
      if (t) {
        await window.quill.ptyKill(t.ptyId);
        t.term.dispose();
        termInstances.delete(paneId);
      }
      delete state.panes[paneId];
    }
    changed = true;
  }

  const used = new Set();
  for (const paneId of ws.paneIds) {
    if (!state.panes[paneId]) {
      state.panes[paneId] = { persona: pickUnusedPersonaFromUsed(used), mode: "agent" };
      used.add(state.panes[paneId].persona);
      changed = true;
      continue;
    }
    let persona = state.panes[paneId].persona;
    if (used.has(persona)) {
      persona = pickUnusedPersonaFromUsed(used);
      state.panes[paneId].persona = persona;
      changed = true;
    }
    used.add(persona);
  }

  ws.panes = ws.paneIds.length;
  ws.layout = layoutForPaneCount(ws.paneIds.length);
  if (changed) persist();
}

function getAgentDelegatePaneId(ws) {
  const sel = document.getElementById("agent-delegate");
  const val = sel?.value || "primary";
  if (val === "primary" || val === "spawn") return ws?.paneIds?.[0];
  if (ws?.paneIds?.includes(val)) return val;
  return ws?.paneIds?.[0];
}

function populateAgentPersona() {
  const sel = document.getElementById("agent-persona");
  const ws = agentPanelWs();
  const paneId = getAgentDelegatePaneId(ws);
  if (!sel || !paneId) return;
  const meta = state.panes[paneId] || { persona: DEFAULT_PERSONA };
  const paneCount = ws?.paneIds?.length || 1;
  const paneIdx = (ws.paneIds || []).indexOf(paneId);
  const paneLabel = paneCount > 1 ? `Pane ${paneIdx + 1}` : "Primary pane";
  sel.title = `${paneLabel} persona`;
  sel.setAttribute("aria-label", `${paneLabel} persona`);
  sel.innerHTML = `<option selected disabled>${escHtml(meta.persona)}</option>`;
  sel.disabled = true;
  sel.onchange = null;
}

function bindGlobalComposer() {
  const input = document.getElementById("agent-composer-input");
  const send = document.getElementById("agent-composer-send");
  const wrap = input?.closest(".agent-composer-wrap");
  const ws = agentPanelWs();
  primaryPaneId = getAgentDelegatePaneId(ws) || ws?.paneIds?.[0] || primaryPaneId;
  const t = primaryPaneId ? termInstances.get(primaryPaneId) : null;
  if (!input || !send || !t) return;

  let mentionMenu = null;
  let mentionAt = -1;
  const hideMentionMenu = () => { mentionMenu?.remove(); mentionMenu = null; mentionAt = -1; };

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    hideMentionMenu();
    appendAgentChat("user", text);
    const ptyId = window.QuillCowork
      ? await window.QuillCowork.resolveDelegateTarget()
      : t.ptyId;
    window.quill.ptyWrite(ptyId || t.ptyId, text + "\r");
    input.value = "";
    input.style.height = "auto";
  };

  send.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === "Escape") hideMentionMenu();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  input.oninput = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    const val = input.value;
    const at = val.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(val[at - 1]))) { hideMentionMenu(); return; }
    mentionAt = at;
    void (async () => {
      const ws = agentPanelWs();
      if (!ws?.cwd) return;
      hideMentionMenu();
      const res = await window.quill.searchFiles({ cwd: ws.cwd, query: val.slice(at + 1), limit: 8 });
      if (!res.files?.length) return;
      mentionMenu = document.createElement("div");
      mentionMenu.className = "mention-menu";
      res.files.forEach((f) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mention-item";
        btn.innerHTML = `${escHtml(f.name)}<small>${escHtml(f.rel)}</small>`;
        btn.onclick = () => {
          input.value = `${input.value.slice(0, mentionAt)}@${f.rel} `;
          hideMentionMenu();
          input.focus();
        };
        mentionMenu.appendChild(btn);
      });
      wrap?.querySelector(".agent-composer")?.appendChild(mentionMenu);
    })();
  };
}

function activeWs() {
  return state.workspaces.find((w) => w.id === state.activeWorkspace) || state.workspaces[0];
}

function agentPanelWs() {
  const id = state.agentPanelWorkspaceId || state.activeWorkspace;
  return state.workspaces.find((w) => w.id === id) || activeWs();
}

function renderAgentPanelWorkspaceSelect() {
  const sel = document.getElementById("agent-ws-select");
  if (!sel) return;
  const cur = state.agentPanelWorkspaceId || state.activeWorkspace;
  sel.innerHTML = state.workspaces.map((ws) =>
    `<option value="${escHtml(ws.id)}"${ws.id === cur ? " selected" : ""}>${escHtml(ws.name)}</option>`
  ).join("");
}

function bindAgentPanelWorkspaceSelect() {
  const sel = document.getElementById("agent-ws-select");
  if (!sel || sel._bound) return;
  sel._bound = true;
  sel.onchange = () => {
    const id = sel.value;
    if (id === state.agentPanelWorkspaceId) return;
    saveAgentChat(state.agentPanelWorkspaceId);
    state.agentPanelWorkspaceId = id;
    persist();
    restoreAgentChat(id);
    populateAgentPersona();
    bindGlobalComposer();
    window.QuillCowork?.populateDelegateSelect();
  };
}

function applyTheme() {
  const t = bootstrap?.themes?.[state.theme] || bootstrap?.themes?.dark;
  for (const key of THEME_CSS_VARS) {
    document.documentElement.style.removeProperty(key);
  }
  document.body.className = t?.cssClass || "theme-dark";
  if (t?.vars) {
    for (const [k, v] of Object.entries(t.vars)) {
      document.documentElement.style.setProperty(k, v);
    }
  }
  for (const [, inst] of termInstances) {
    inst.term.options.theme = termTheme();
    inst.term.refresh(0, inst.term.rows);
  }
  if (window.monaco?.editor) {
    monaco.editor.setTheme(monacoThemeId());
  }
}

function renderWorkspaces() {
  const ul = document.getElementById("workspace-list");
  ul.innerHTML = "";
  state.workspaces.forEach((ws) => {
    const li = document.createElement("li");
    const running = isWorkspaceAgentRunning(ws);
    li.className = "ws-item"
      + (ws.id === state.activeWorkspace ? " active" : "")
      + (ws.agentStopped ? " agent-stopped" : "");
    const folders = (ws.folders || []).length;
    const git = gitCache[ws.id];
    const gitLabel = git?.branch ? `${git.branch}${git.changes ? ` · ${git.changes}` : ""}` : "";
    const paneBadge = `${ws.paneIds?.length || 1}${folders > 1 ? ` · ${folders} folders` : ""}`;
    const dotClass = running ? "agent-running" : "agent-idle";
    li.innerHTML = `<span class="ws-dot ${dotClass}"></span><span>${escHtml(ws.name)}</span><span class="ws-badge">${escHtml(gitLabel || paneBadge)}</span>`;
    const actions = document.createElement("div");
    actions.className = "ws-item-actions";
    if (isWorkspaceAgentRunning(ws)) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "ws-item-action";
      stop.title = "Stop agent";
      stop.textContent = "■";
      stop.onclick = (e) => { e.stopPropagation(); void stopWorkspaceAgent(ws.id); };
      actions.appendChild(stop);
    } else if (ws.agentStopped) {
      const start = document.createElement("button");
      start.type = "button";
      start.className = "ws-item-action start";
      start.title = "Start agent";
      start.textContent = "▶";
      start.onclick = (e) => { e.stopPropagation(); void startWorkspaceAgent(ws.id); };
      actions.appendChild(start);
    }
    if (actions.childElementCount) li.appendChild(actions);
    li.onclick = () => switchWorkspace(ws.id);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      showWsContextMenu(e, ws);
    };
    ul.appendChild(li);
  });
  renderAgentPanelWorkspaceSelect();
}

async function refreshGitInfo(ws = activeWs()) {
  if (!ws?.cwd) return;
  gitCache[ws.id] = await window.quill.getGitInfo(ws.cwd);
  updateGitStatus();
  renderWorkspaces();
  await refreshScmPanel();
  await refreshBranchDropdown();
  await window.QuillFeatures?.refreshGitFileStatus();
  await renderFileTree();
}

async function refreshAllGitInfo() {
  await Promise.all(state.workspaces.map(async (ws) => {
    if (ws?.cwd) gitCache[ws.id] = await window.quill.getGitInfo(ws.cwd);
  }));
  updateGitStatus();
  renderWorkspaces();
  await refreshScmPanel();
  await refreshBranchDropdown();
}

function updateGitStatus() {
  const ws = activeWs();
  const info = ws ? gitCache[ws.id] : null;
  const changesEl = document.getElementById("status-git-changes");
  if (changesEl) {
    changesEl.textContent = info?.changes ? `(${info.changes} changed)` : "";
  }
}

const SCM_STATUS_LABELS = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  "?": "Untracked",
};

function scmStatusLabel(code) {
  return SCM_STATUS_LABELS[code] || code;
}

function relToWorkspace(absPath, workspaceCwd) {
  const a = String(absPath || "").replace(/\\/g, "/");
  const w = String(workspaceCwd || "").replace(/\\/g, "/").replace(/\/$/, "");
  if (!w) return null;
  const prefix = `${w}/`;
  if (a.toLowerCase().startsWith(prefix.toLowerCase())) return a.slice(prefix.length);
  return null;
}

function renderScmFileRow(f, ws) {
  const displayPath = relToWorkspace(f.absPath, ws.cwd) || f.path;
  const label = scmStatusLabel(f.status);
  const unstaged = !f.staged || (f.worktree !== " " && f.worktree !== "?");
  return `
    <li class="scm-file${f.staged ? " staged" : ""}${unstaged && f.staged ? " partial" : ""}" data-path="${escHtml(f.absPath)}">
      <span class="scm-code scm-code-${f.status}" title="${escHtml(label)}">${escHtml(label)}</span>
      <span class="scm-name" title="${escHtml(f.path)}">${escHtml(displayPath)}</span>
      ${unstaged ? `<button type="button" class="scm-stage-one" data-rel="${escHtml(f.path)}" title="Stage">+</button>` : ""}
    </li>`;
}

function bindScmFileRows(container) {
  container.querySelectorAll(".scm-file").forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest(".scm-stage-one")) return;
      openFileInEditor(li.dataset.path);
    };
  });
  container.querySelectorAll(".scm-stage-one").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await stageFiles([btn.dataset.rel]);
    };
  });
}

async function refreshScmPanel() {
  const ws = activeWs();
  const container = document.getElementById("scm-files");
  const statusEl = document.getElementById("scm-status");
  if (!ws?.cwd || !container) return;
  const res = await window.quill.gitStatusFiles(ws.cwd);
  if (!res.ok) {
    container.innerHTML = `<p class="scm-empty">${escHtml(res.error || "Not a git repo")}</p>`;
    return;
  }
  const staged = res.files.filter((f) => f.staged);
  const unstaged = res.files.filter((f) => !f.staged || (f.worktree !== " " && f.worktree !== "?"));
  const showRepoHint = res.repoRoot && !pathsEqual(res.repoRoot, ws.cwd);
  const parts = [];
  if (showRepoHint) {
    parts.push(`<p class="scm-repo-hint" title="${escHtml(res.repoRoot)}">Repo: ${escHtml(res.repoRoot)}</p>`);
  }
  if (!res.files.length) {
    parts.push(`<p class="scm-empty">No changes</p>`);
  } else {
    if (staged.length) {
      parts.push(`
        <section class="scm-section">
          <h4 class="scm-section-title">Staged (${staged.length})</h4>
          <ul class="scm-list">${staged.map((f) => renderScmFileRow(f, ws)).join("")}</ul>
        </section>`);
    }
    if (unstaged.length) {
      parts.push(`
        <section class="scm-section">
          <h4 class="scm-section-title">Changes (${unstaged.length})</h4>
          <ul class="scm-list">${unstaged.map((f) => renderScmFileRow(f, ws)).join("")}</ul>
        </section>`);
    }
  }
  container.innerHTML = parts.join("");
  bindScmFileRows(container);
  if (statusEl && !statusEl.dataset.sticky) statusEl.textContent = "";
}

async function refreshBranchDropdown() {
  const sel = document.getElementById("status-branch");
  if (!sel) return;
  const ws = activeWs();
  if (!ws?.cwd) {
    sel.innerHTML = `<option value="">—</option>`;
    sel.disabled = true;
    return;
  }
  const res = await window.quill.gitBranches(ws.cwd);
  if (!res.ok || !res.branches?.length) {
    sel.innerHTML = `<option value="">${escHtml(res.current || "—")}</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = res.branches.map((b) =>
    `<option value="${escHtml(b.name)}"${b.current ? " selected" : ""}>⎇ ${escHtml(b.name)}</option>`
  ).join("");
}

async function switchBranch(branch) {
  const ws = activeWs();
  const statusEl = document.getElementById("scm-status");
  if (!ws?.cwd || !branch) return;
  const res = await window.quill.gitCheckout({ cwd: ws.cwd, branch });
  if (!res.ok) {
    if (statusEl) {
      statusEl.textContent = res.error;
      statusEl.dataset.sticky = "1";
      setTimeout(() => { statusEl.dataset.sticky = ""; }, 4000);
    }
    await refreshBranchDropdown();
    return;
  }
  if (statusEl) statusEl.textContent = "";
  await refreshGitInfo();
}

async function stageFiles(files, all = false) {
  const ws = activeWs();
  const statusEl = document.getElementById("scm-status");
  const res = await window.quill.gitStage({ cwd: ws?.cwd, files: files || undefined, all });
  if (!res.ok) {
    if (statusEl) statusEl.textContent = res.error;
    return;
  }
  if (statusEl) statusEl.textContent = "";
  await refreshGitInfo();
}

async function commitChanges() {
  const ws = activeWs();
  const input = document.getElementById("scm-message");
  const statusEl = document.getElementById("scm-status");
  const msg = input?.value?.trim();
  if (!msg) {
    if (statusEl) statusEl.textContent = "Commit message required.";
    return;
  }
  const res = await window.quill.gitCommit({ cwd: ws?.cwd, message: msg });
  if (!res.ok) {
    if (statusEl) statusEl.textContent = res.error;
    return;
  }
  if (input) input.value = "";
  if (statusEl) statusEl.textContent = "Committed.";
  setTimeout(() => { if (statusEl?.textContent === "Committed.") statusEl.textContent = ""; }, 3000);
  await refreshGitInfo();
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function pathsEqual(a, b) {
  return normPath(a) === normPath(b);
}

function resolveWsPath(relOrAbs) {
  const ws = activeWs();
  const raw = String(relOrAbs || "").trim();
  if (!raw) return raw;
  if (/^[a-z]:\/|^\//i.test(raw.replace(/\\/g, "/"))) return raw;
  const base = (ws?.cwd || "").replace(/\\/g, "/").replace(/\/$/, "");
  return `${base}/${raw.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
}

function showToast(msg) {
  let toast = document.getElementById("quill-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "quill-toast";
    toast.className = "quill-toast hidden";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function showFileChangedBadge() {
  const title = document.getElementById("editor-title");
  if (title && !title.querySelector(".file-changed-badge")) {
    const badge = document.createElement("span");
    badge.className = "file-changed-badge";
    badge.textContent = "file changed";
    title.appendChild(badge);
  }
  showToast("File changed — editor refreshed");
  clearTimeout(showFileChangedBadge._clearTimer);
  showFileChangedBadge._clearTimer = setTimeout(() => {
    title?.querySelector(".file-changed-badge")?.remove();
  }, 8000);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function ensureMonaco() {
  if (monacoInitPromise) return monacoInitPromise;
  monacoInitPromise = (async () => {
    if (window.monaco?.editor) return;
    const vsBase = window.QuillFeatures ? await window.QuillFeatures.monacoVsBase() : "./vendor/monaco/vs";
    await loadScript(`${vsBase}/loader.js`);
    window.require.config({ paths: { vs: vsBase } });
    await new Promise((resolve, reject) => {
      window.require(["vs/editor/editor.main"], () => resolve(), reject);
    });
    const el = document.getElementById("monaco-editor");
    if (el && !monacoEditor) {
      monacoEditor = monaco.editor.create(el, {
        theme: monacoThemeId(),
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 13,
        fontFamily: "Cascadia Code, Consolas, monospace",
        scrollBeyondLastLine: false,
        glyphMargin: true,
      });
      monacoEditor.onDidChangeModelContent(() => {
        editorDirty = true;
        updateEditorDirty();
        window.QuillFeatures?.onEditorContentChange();
      });
    }
    const diffEl = document.getElementById("monaco-diff");
    if (diffEl && !monacoDiff) {
      monacoDiff = monaco.editor.createDiffEditor(diffEl, {
        theme: monacoThemeId(),
        automaticLayout: true,
        readOnly: true,
        renderSideBySide: true,
        fontSize: 13,
        fontFamily: "Cascadia Code, Consolas, monospace",
      });
    }
    window.QuillFeatures?.registerLspProviders();
  })();
  return monacoInitPromise;
}

function updateEditorDirty() {
  const tabs = window.QuillFeatures?.getOpenTabs?.();
  if (tabs && editorFilePath && tabs.has(editorFilePath)) {
    window.QuillFeatures.renderTabs();
    return;
  }
  const dot = document.getElementById("editor-dirty");
  if (dot) dot.classList.toggle("hidden", !editorDirty);
}

async function saveEditor() {
  if (!editorFilePath || !monacoEditor) return;
  const ws = activeWs();
  const content = monacoEditor.getValue();
  const res = await window.quill.writeFile({ filePath: editorFilePath, content, cwd: ws?.cwd });
  if (!res.ok) {
    showToast(res.error || "Save failed");
    return;
  }
  editorDirty = false;
  updateEditorDirty();
  window.QuillFeatures?.markSaved();
  showToast("Saved");
  await refreshGitInfo();
}

async function loadDiffView() {
  if (!editorFilePath) return;
  await ensureMonaco();
  const ws = activeWs();
  const current = monacoEditor?.getValue() ?? "";
  const head = await window.quill.gitShowFile({ cwd: ws?.cwd, filePath: editorFilePath });
  const original = head.ok ? head.content : "";
  const lang = guessMonacoLang(editorFilePath);
  monacoDiff.setModel({
    original: monaco.editor.createModel(original, lang),
    modified: monaco.editor.createModel(current, lang),
  });
}

function guessMonacoLang(filePath) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  const map = {
    js: "javascript", ts: "typescript", py: "python", json: "json", md: "markdown",
    html: "html", css: "css", yml: "yaml", yaml: "yaml", rs: "rust", go: "go",
  };
  return map[ext] || "plaintext";
}

async function refreshEditorContent(showNotice = false) {
  if (!editorFilePath) return;
  const res = await window.quill.readFile(editorFilePath);
  if (!res.ok) return;
  await ensureMonaco();
  if (!editorDirty && monacoEditor) {
    const lang = guessMonacoLang(editorFilePath);
    monacoEditor.setModel(monaco.editor.createModel(res.content, lang));
  }
  if (activeEditorTab === "diff") await loadDiffView();
  if (showNotice) showFileChangedBadge();
  refreshGitInfo();
}

let fileChangeRefreshTimer = null;

async function onWorkspaceFileChanged(changedPath) {
  if (!editorFilePath || !pathsEqual(changedPath, editorFilePath)) return;
  clearTimeout(fileChangeRefreshTimer);
  fileChangeRefreshTimer = setTimeout(() => {
    void refreshEditorContent(true);
  }, 120);
}

function bindEditorDrawer() {
  document.getElementById("editor-close")?.addEventListener("click", () => {
    const p = editorFilePath;
    if (p && window.QuillFeatures) void window.QuillFeatures.closeTab(p);
    else closeEditor();
  });
  document.getElementById("editor-save")?.addEventListener("click", () => void saveEditor());
  document.querySelectorAll(".editor-tab-btn[data-tab]").forEach((tab) => {
    tab.onclick = () => void setEditorTab(tab.dataset.tab);
  });
}

function closeEditor() {
  editorFilePath = null;
  editorDirty = false;
  window.QuillFeatures?.getOpenTabs()?.clear?.();
  document.getElementById("editor-area")?.classList.add("hidden");
  document.getElementById("inline-diff-bar")?.classList.add("hidden");
  updateCenterView();
  updateTitlebar();
  window.QuillFeatures?.renderTabs?.();
}

async function setEditorTab(tab) {
  activeEditorTab = tab;
  document.querySelectorAll(".editor-tab-btn[data-tab]").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  document.getElementById("monaco-editor")?.classList.toggle("hidden", tab !== "file");
  document.getElementById("monaco-diff")?.classList.toggle("hidden", tab !== "diff");
  if (tab === "diff") await loadDiffView();
  else monacoEditor?.layout();
}

async function openFileInEditor(filePath) {
  if (window.QuillFeatures) {
    await window.QuillFeatures.openTab(filePath);
    return;
  }
  const res = await window.quill.readFile(filePath);
  if (!res.ok) {
    showToast(res.error || "Cannot open file");
    return;
  }
  await ensureMonaco();
  editorFilePath = filePath;
  editorDirty = false;
  const title = document.getElementById("editor-title");
  if (!monacoEditor) return;
  updateCenterView();
  document.getElementById("editor-area")?.classList.remove("hidden");
  if (title) title.textContent = filePath.split(/[/\\]/).pop() || filePath;
  monacoEditor.setModel(monaco.editor.createModel(res.content, guessMonacoLang(filePath)));
  updateEditorDirty();
  updateTitlebar();
  await setEditorTab("file");
  const fileStatus = document.getElementById("status-file");
  if (fileStatus) fileStatus.textContent = filePath;
  document.querySelectorAll(".tree-item.tree-file").forEach((el) => {
    el.classList.toggle("selected", el.dataset.path === filePath);
  });
}

function fileIconClass(name) {
  const ext = (name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  if (ext === ".py") return "tree-kind-python";
  if (ext === ".md") return "tree-kind-md";
  if ([".json", ".toml", ".yaml", ".yml"].includes(ext)) return "tree-kind-config";
  if ([".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"].includes(ext)) return "tree-kind-js";
  if ([".html", ".css", ".scss", ".less"].includes(ext)) return "tree-kind-web";
  return "tree-kind-file";
}

function treeRowHtml(depth, isDir, name, gitBadge = "") {
  const pad = 4 + depth * 14;
  const chevron = isDir
    ? `<span class="tree-chevron" aria-hidden="true">›</span>`
    : `<span class="tree-chevron tree-chevron-spacer" aria-hidden="true">›</span>`;
  const kind = isDir
    ? `<span class="tree-kind tree-kind-folder" aria-hidden="true"></span>`
    : `<span class="tree-kind ${fileIconClass(name)}" aria-hidden="true"></span>`;
  return `<div class="tree-row" style="padding-left:${pad}px">${chevron}${kind}<span class="tree-name">${escHtml(name)}</span>${gitBadge}</div>`;
}

async function appendTreeDir(parentUl, dirPath, depth) {
  if (window.QuillFeatures?.lazyTreeLimit?.(depth)) return;
  const res = await window.quill.listDirectory(dirPath);
  if (!res.ok) return;
  const maxEntries = depth === 0 ? 200 : 80;
  for (const entry of res.entries.slice(0, maxEntries)) {
    if (TREE_SKIP.has(entry.name)) continue;
    if (!entry.isDirectory && TREE_SKIP_FILES.test(entry.name)) continue;
    const li = document.createElement("li");
    li.className = "tree-item" + (entry.isDirectory ? " tree-dir" : " tree-file");
    li.dataset.path = entry.path;
    const expanded = entry.isDirectory && expandedDirs.has(entry.path);
    if (expanded) li.classList.add("expanded");
    li.innerHTML = treeRowHtml(depth, entry.isDirectory, entry.name, window.QuillFeatures?.treeGitBadge(entry.path) || "");
    const row = li.querySelector(".tree-row");
    if (entry.isDirectory) {
      row.onclick = async (e) => {
        e.stopPropagation();
        if (expandedDirs.has(entry.path)) expandedDirs.delete(entry.path);
        else expandedDirs.add(entry.path);
        await renderFileTree();
      };
      if (expanded) {
        const childUl = document.createElement("ul");
        childUl.className = "tree-children";
        li.appendChild(childUl);
        await appendTreeDir(childUl, entry.path, depth + 1);
      }
    } else {
      row.onclick = (e) => {
        e.stopPropagation();
        openFileInEditor(entry.path);
      };
    }
    parentUl.appendChild(li);
  }
}

let treeRootContextMenuEl = null;
function hideTreeRootContextMenu() {
  treeRootContextMenuEl?.remove();
  treeRootContextMenuEl = null;
}

function showTreeRootContextMenu(e, folderPath) {
  hideTreeRootContextMenu();
  e.preventDefault();
  const menu = document.createElement("div");
  menu.className = "pane-context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "danger";
  removeBtn.textContent = "Remove folder from workspace";
  removeBtn.onclick = () => { hideTreeRootContextMenu(); void removeFolderFromWorkspace(folderPath); };
  menu.appendChild(removeBtn);
  document.body.appendChild(menu);
  treeRootContextMenuEl = menu;
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    hideTreeRootContextMenu();
    document.removeEventListener("click", close);
    document.removeEventListener("contextmenu", close);
  };
  setTimeout(() => {
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
  }, 0);
}

async function appendTreeRoot(parentUl, rootPath) {
  const name = rootPath.split(/[/\\]/).pop() || rootPath;
  const expanded = expandedDirs.has(rootPath);
  const li = document.createElement("li");
  li.className = "tree-item tree-dir tree-root" + (expanded ? " expanded" : "");
  li.dataset.path = rootPath;
  li.title = rootPath;
  li.innerHTML = treeRowHtml(0, true, name);
  const row = li.querySelector(".tree-row");
  row.onclick = async (e) => {
    e.stopPropagation();
    if (expandedDirs.has(rootPath)) expandedDirs.delete(rootPath);
    else expandedDirs.add(rootPath);
    await renderFileTree();
  };
  row.addEventListener("contextmenu", (e) => showTreeRootContextMenu(e, rootPath));
  parentUl.appendChild(li);
  if (expanded) {
    const childUl = document.createElement("ul");
    childUl.className = "tree-children";
    li.appendChild(childUl);
    await appendTreeDir(childUl, rootPath, 1);
  }
}

let renderFileTreeTimer = null;
let renderFileTreeWaiters = [];

async function renderFileTreeImpl() {
  const ul = document.getElementById("file-tree");
  if (!ul) return;
  const ws = activeWs();
  renderWsFolderRoots();
  if (!ws?.named || !ws?.cwd) {
    ul.innerHTML = `<li class="tree-empty tree-cta">
      <p>No project folder — agents run in your home dir until you open one.</p>
      <button type="button" class="scm-btn tree-cta-btn" id="tree-open-folder">Open folder…</button>
      <button type="button" class="scm-btn tree-cta-btn" id="tree-add-folder">Add folder to workspace…</button>
    </li>`;
    document.getElementById("tree-open-folder")?.addEventListener("click", openFolder);
    document.getElementById("tree-add-folder")?.addEventListener("click", addFolderToWorkspace);
    return;
  }
  ul.innerHTML = "";
  const roots = [...new Set((ws.folders?.length ? ws.folders : [ws.cwd]).filter(Boolean))];
  if (!expandedDirs.size) roots.forEach((r) => expandedDirs.add(r));
  if (roots.length === 1) {
    await appendTreeDir(ul, roots[0], 0);
  } else {
    for (const root of roots) await appendTreeRoot(ul, root);
    const addLi = document.createElement("li");
    addLi.className = "tree-add-root";
    addLi.innerHTML = `<button type="button" class="tree-add-root-btn" id="tree-add-folder-root">+ Add folder to workspace</button>`;
    ul.appendChild(addLi);
    document.getElementById("tree-add-folder-root")?.addEventListener("click", addFolderToWorkspace);
  }
  if (!ul.querySelector(".tree-item")) {
    ul.innerHTML = `<li class="tree-empty">No files in folder</li>`;
  }
}

function renderFileTree() {
  return new Promise((resolve) => {
    renderFileTreeWaiters.push(resolve);
    clearTimeout(renderFileTreeTimer);
    renderFileTreeTimer = setTimeout(async () => {
      const waiters = renderFileTreeWaiters.splice(0);
      await renderFileTreeImpl();
      waiters.forEach((r) => r());
    }, 80);
  });
}

function renderWsFolderRoots() {
  const el = document.getElementById("ws-folder-roots");
  if (!el) return;
  el.classList.add("hidden");
  el.innerHTML = "";
}

async function switchWorkspace(id) {
  if (id === state.activeWorkspace) return;
  state.activeWorkspace = id;
  persist();
  renderWorkspaces();
  await ensureWorkspaceUI(activeWs());
  showWorkspaceGrid(id);
  await refreshGitInfo();
  expandedDirs.clear();
  await renderFileTree();
  updateTitlebar();
  closeEditor();
}

async function ensureWorkspaceUI(ws) {
  if (!ws) return;
  const grid = getWsGrid(ws);
  if (!grid) return;

  ws.panes = ws.paneIds?.length || 1;

  if (!ws.paneIds?.length) {
    const paneId = `pane-${ws.id}-0`;
    ws.paneIds = [paneId];
    state.panes[paneId] = { persona: DEFAULT_PERSONA, mode: "agent" };
  }

  applyGridLayout(grid, ws);
  syncGridPanes(grid, ws);

  for (const paneId of ws.paneIds) {
    if (!ws.agentStopped && !termInstances.has(paneId)) await mountTerminal(paneId, ws);
  }
  updateAgentStoppedOverlay(ws);
}

function layoutForPaneCount(n) {
  if (n <= 1) return "grid-1x1";
  if (n === 2) return "split-h2";
  if (n <= 4) return "grid-2x2";
  return "grid-3x3";
}

function applyGridLayout(grid, ws) {
  const layout = layoutForPaneCount(ws.paneIds.length);
  ws.layout = layout;
  grid.className = `pane-grid ${layout} ws-pane-grid`;
  if (grid.dataset.wsId !== ws.id) grid.dataset.wsId = ws.id;

  if (layout === "split-h2") {
    ws.splitPct = ws.splitPct ?? 50;
    grid.style.gridTemplateColumns = `${ws.splitPct}% 5px 1fr`;
    grid.style.gridTemplateRows = "";
  } else {
    grid.style.gridTemplateColumns = "";
    grid.style.gridTemplateRows = "";
  }
}

function createSplitGutter(grid, ws) {
  const gutter = document.createElement("div");
  gutter.className = "pane-split-gutter";
  gutter.onmousedown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startPct = ws.splitPct;
    const onMove = (ev) => {
      const delta = ev.clientX - startX;
      const w = grid.clientWidth || 1;
      ws.splitPct = Math.min(80, Math.max(20, startPct + (delta / w) * 100));
      grid.style.gridTemplateColumns = `${ws.splitPct}% 5px 1fr`;
      fitActiveTerminals();
    };
    const onUp = () => {
      persist();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  return gutter;
}

function syncGridPanes(grid, ws) {
  const split = ws.paneIds.length === 2;
  const paneMap = new Map();
  grid.querySelectorAll(".pane").forEach((p) => {
    paneMap.set(p.dataset.paneId, p);
    p.remove();
  });
  grid.querySelectorAll(".pane-split-gutter").forEach((g) => g.remove());

  for (let i = 0; i < ws.paneIds.length; i++) {
    const paneId = ws.paneIds[i];
    let paneEl = paneMap.get(paneId);
    if (!paneEl) paneEl = createPaneElement(paneId, ws);
    else updatePaneHeader(paneEl, paneId);
    grid.appendChild(paneEl);
    if (split && i === 0) grid.appendChild(createSplitGutter(grid, ws));
  }
}

function updatePaneHeader(paneEl, paneId) {
  const meta = state.panes[paneId];
  if (!meta) return;
  const personaEl = paneEl.querySelector(".pane-persona");
  if (personaEl) personaEl.textContent = meta.persona;
}

function bindPaneHeader(el, paneId) {
  const header = el.querySelector(".pane-header");
  header?.addEventListener("click", (e) => {
    if (e.target.closest(".pane-close")) return;
    focusPane(paneId);
  });
  header?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showPaneContextMenu(e, paneId);
  });
  el.querySelector(".pane-term")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showPaneContextMenu(e, paneId);
  });
  el.querySelector(".pane-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void removePane(paneId);
  });
}

async function renderPanes() {
  const ws = activeWs();
  if (!ws) return;
  await ensureWorkspaceUI(ws);
  showWorkspaceGrid(ws.id);
  primaryPaneId = ws.paneIds[0];
  populateAgentPersona();
  bindGlobalComposer();
  window.QuillCowork?.populateDelegateSelect();
  renderWorkspaces();
  for (const other of state.workspaces) {
    if (other.id !== ws.id) void ensureWorkspaceUI(other);
  }
}

function createPaneElement(paneId, ws) {
  const meta = state.panes[paneId] || { persona: DEFAULT_PERSONA, mode: "agent" };
  state.panes[paneId] = meta;
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.paneId = paneId;
  el.innerHTML = `
    <div class="pane-header" data-pane-id="${paneId}">
      <span class="pane-activity" id="activity-${paneId}"></span>
      <span class="pane-persona">${escHtml(meta.persona)}</span>
      <button type="button" class="pane-close" title="Close pane">×</button>
    </div>
    <div class="pane-term" id="term-${paneId}"></div>
  `;
  bindPaneHeader(el, paneId);
  return el;
}

async function remountPane(paneId) {
  const ws = state.workspaces.find((w) => w.paneIds?.includes(paneId));
  if (!ws || ws.agentStopped) return;
  const t = termInstances.get(paneId);
  if (t) {
    await window.quill.ptyKill(t.ptyId);
    t.term.dispose();
    termInstances.delete(paneId);
  }
  await mountTerminal(paneId, ws);
}

async function mountTerminal(paneId, ws) {
  const host = document.getElementById(`term-${paneId}`);
  if (!host || termInstances.has(paneId)) return;

  const meta = state.panes[paneId] || { persona: DEFAULT_PERSONA, mode: "agent" };
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "Cascadia Code, Consolas, monospace",
    theme: termTheme(),
    convertEol: true,
  });
  const fit = createFitAddon();
  if (fit) term.loadAddon(fit);
  term.open(host);
  if (fit) fit.fit();

  const { id } = await window.quill.ptyCreate({
    cwd: ws.cwd,
    persona: meta.persona,
    mode: "agent",
    named: Boolean(ws.named),
    workspaceId: ws.id,
    cols: term.cols,
    rows: term.rows,
  });
  termInstances.set(paneId, { term, fit, ptyId: id, wsId: ws.id });
  term.onData((data) => window.quill.ptyWrite(id, data));
  if (paneId === primaryPaneId) bindGlobalComposer();

  let lastResizeAt = 0;
  const ro = new ResizeObserver(() => {
    const now = Date.now();
    if (now - lastResizeAt < 100) return;
    lastResizeAt = now;
    if (fit) fit.fit();
    window.quill.ptyResize(id, term.cols, term.rows);
  });
  ro.observe(host);

  setTimeout(() => { if (fit) fit.fit(); }, 200);
}

function bindComposer(paneId, ptyId) {
  const composer = document.querySelector(`#composer-${paneId}`)?.closest(".pane-composer");
  const input = document.getElementById(`composer-${paneId}`);
  const send = document.getElementById(`composer-send-${paneId}`);
  if (!input || !send) return;

  let mentionMenu = null;
  let mentionAt = -1;

  const hideMentionMenu = () => {
    mentionMenu?.remove();
    mentionMenu = null;
    mentionAt = -1;
  };

  const submit = () => {
    const text = input.value;
    if (!text) return;
    hideMentionMenu();
    window.quill.ptyWrite(ptyId, text + "\r");
    input.value = "";
  };

  const showMentionMenu = async (query) => {
    const ws = activeWs();
    if (!ws?.cwd) return;
    hideMentionMenu();
    const res = await window.quill.searchFiles({ cwd: ws.cwd, query, limit: 8 });
    if (!res.files?.length) return;
    mentionMenu = document.createElement("div");
    mentionMenu.className = "mention-menu";
    res.files.forEach((f) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mention-item";
      btn.innerHTML = `${escHtml(f.name)}<small>${escHtml(f.rel)}</small>`;
      btn.onclick = () => {
        const before = input.value.slice(0, mentionAt);
        input.value = `${before}@${f.rel} `;
        hideMentionMenu();
        input.focus();
      };
      mentionMenu.appendChild(btn);
    });
    composer?.appendChild(mentionMenu);
  };

  send.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === "Escape") hideMentionMenu();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  input.oninput = () => {
    const val = input.value;
    const at = val.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(val[at - 1]))) {
      hideMentionMenu();
      return;
    }
    mentionAt = at;
    showMentionMenu(val.slice(at + 1));
  };
}

async function killAllPanes() {
  for (const [, t] of termInstances) {
    await window.quill.ptyKill(t.ptyId);
    t.term.dispose();
  }
  termInstances.clear();
}

async function removePane(paneId) {
  const ws = activeWs();
  if (!ws || ws.paneIds.length <= 1) return;
  const t = termInstances.get(paneId);
  if (t) {
    await window.quill.ptyKill(t.ptyId);
    t.term.dispose();
    termInstances.delete(paneId);
  }
  ws.paneIds = ws.paneIds.filter((p) => p !== paneId);
  delete state.panes[paneId];
  ws.panes = ws.paneIds.length;
  ws.layout = layoutForPaneCount(ws.paneIds.length);
  if (primaryPaneId === paneId) primaryPaneId = ws.paneIds[0];
  persist();
  await renderPanes();
}

async function addPane(personaOverride) {
  const ws = activeWs();
  if (!ws) return;
  if (ws.agentStopped) await startWorkspaceAgent(ws.id);
  if (ws.paneIds.length >= MAX_PANES) {
    showToast(`Maximum ${MAX_PANES} terminal panes`);
    return;
  }
  const paneId = `pane-${Date.now()}`;
  ws.paneIds = ws.paneIds || [];
  const persona = personaOverride || pickUnusedPersona(ws);
  ws.paneIds.push(paneId);
  state.panes[paneId] = { persona, mode: "agent" };
  ws.panes = ws.paneIds.length;
  ws.layout = layoutForPaneCount(ws.paneIds.length);
  persist();
  await renderPanes();
  focusPane(paneId);
  window.QuillCowork?.populateDelegateSelect();
}

let paneContextMenuEl = null;
function hidePaneContextMenu() {
  paneContextMenuEl?.remove();
  paneContextMenuEl = null;
}

function showPaneContextMenu(e, paneId) {
  hidePaneContextMenu();
  const ws = activeWs();
  if (!ws) return;
  const menu = document.createElement("div");
  menu.className = "pane-context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const splitBtn = document.createElement("button");
  splitBtn.type = "button";
  splitBtn.textContent = "Split right";
  splitBtn.onclick = () => { hidePaneContextMenu(); void splitPaneRight(paneId); };
  menu.appendChild(splitBtn);

  const dupBtn = document.createElement("button");
  dupBtn.type = "button";
  dupBtn.textContent = "Duplicate";
  dupBtn.onclick = () => { hidePaneContextMenu(); void duplicatePane(paneId); };
  menu.appendChild(dupBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "danger";
  closeBtn.textContent = "Close";
  closeBtn.onclick = () => { hidePaneContextMenu(); void removePane(paneId); };
  if (ws.paneIds.length <= 1) closeBtn.disabled = true;
  menu.appendChild(closeBtn);

  document.body.appendChild(menu);
  paneContextMenuEl = menu;
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    hidePaneContextMenu();
    document.removeEventListener("click", close);
    document.removeEventListener("contextmenu", close);
  };
  setTimeout(() => {
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
  }, 0);
}

async function splitPaneRight(paneId) {
  const ws = activeWs();
  if (!ws || ws.paneIds.length >= MAX_PANES) {
    showToast(`Maximum ${MAX_PANES} terminal panes`);
    return;
  }
  if (ws.agentStopped) await startWorkspaceAgent(ws.id);
  const idx = ws.paneIds.indexOf(paneId);
  const meta = state.panes[paneId];
  const persona = pickUnusedPersona(ws);
  const newPaneId = `pane-${Date.now()}`;
  ws.paneIds.splice(idx + 1, 0, newPaneId);
  state.panes[newPaneId] = { persona, mode: meta?.mode || "agent" };
  ws.panes = ws.paneIds.length;
  ws.layout = layoutForPaneCount(ws.paneIds.length);
  persist();
  await renderPanes();
  focusPane(newPaneId);
}

async function duplicatePane(paneId) {
  await addPane();
}

async function openFolder() {
  const folder = await window.quill.pickFolder();
  if (!folder) return;
  const ws = activeWs();
  if (ws) {
    ws.cwd = folder;
    ws.named = true;
    if (!ws.folders) ws.folders = [];
    if (!ws.folders.includes(folder)) ws.folders.unshift(folder);
    ws.name = folder.split(/[/\\]/).pop() || ws.name;
    persist();
    renderWorkspaces();
    await refreshGitInfo();
    expandedDirs.clear();
    await renderFileTree();
    updateTitlebar();
    updateWorkspaceHead();
    showToast(`Workspace folder: ${ws.name}`);
  }
}

async function addFolderToWorkspace() {
  const folder = await window.quill.pickFolder();
  if (!folder) return;
  const ws = activeWs();
  if (!ws.cwd) {
    ws.cwd = folder;
    ws.named = true;
    ws.folders = [folder];
    ws.name = folder.split(/[/\\]/).pop() || ws.name;
  } else {
    if (!ws.folders) ws.folders = [ws.cwd];
    if (!ws.folders.includes(folder)) ws.folders.push(folder);
  }
  persist();
  renderWorkspaces();
  await renderFileTree();
  showToast("Folder added to workspace");
}

async function removeFolderFromWorkspace(folderPath) {
  const ws = activeWs();
  if (!ws) return;
  if (!ws.folders?.length) ws.folders = ws.cwd ? [ws.cwd] : [];
  const roots = [...new Set(ws.folders.filter(Boolean))];
  const idx = roots.findIndex((r) => pathsEqual(r, folderPath));
  if (idx < 0) return;
  if (roots.length <= 1) {
    showToast("Cannot remove the only folder in workspace");
    return;
  }
  ws.folders = ws.folders.filter((f) => !pathsEqual(f, folderPath));
  if (pathsEqual(ws.cwd, folderPath)) {
    ws.cwd = ws.folders[0] || "";
    if (!ws.cwd) ws.named = false;
    ws.name = ws.cwd ? ws.cwd.split(/[/\\]/).pop() || ws.name : ws.name;
  }
  expandedDirs.delete(folderPath);
  persist();
  renderWorkspaces();
  await renderFileTree();
  updateTitlebar();
  updateWorkspaceHead();
  showToast("Folder removed from workspace");
}

async function openWorkspaceFile() {
  const file = await window.quill.pickWorkspaceFile();
  if (!file) return;
  const res = await window.quill.importWorkspaceFile(file);
  if (!res?.ok || !res.workspace) {
    alert(res?.error || "Could not import workspace file.");
    return;
  }
  const ws = res.workspace;
  ws.id = ws.id || `ws-${Date.now()}`;
  ws.paneIds = ws.paneIds?.length ? ws.paneIds : [`pane-${ws.id}-0`];
  ws.panes = ws.paneIds.length;
  ws.named = true;
  state.workspaces.push(ws);
  ws.paneIds.forEach((pid) => {
    if (!state.panes[pid]) state.panes[pid] = { persona: DEFAULT_PERSONA, mode: "agent" };
  });
  await sanitizeWorkspacePanes(ws);
  persist();
  await switchWorkspace(ws.id);
}

async function closeWorkspace(wsId) {
  if (state.workspaces.length <= 1) {
    showToast("Can't close the last workspace");
    return;
  }
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  if (state.agentPanelWorkspaceId === wsId) saveAgentChat(wsId);
  for (const paneId of ws.paneIds || []) {
    const t = termInstances.get(paneId);
    if (t) {
      await window.quill.ptyKill(t.ptyId);
      t.term.dispose();
      termInstances.delete(paneId);
    }
    delete state.panes[paneId];
  }
  delete wsChats[wsId];
  document.getElementById(`pane-grid-${wsId}`)?.remove();
  state.workspaces = state.workspaces.filter((w) => w.id !== wsId);
  if (state.activeWorkspace === wsId) {
    state.activeWorkspace = state.workspaces[0].id;
    await switchWorkspace(state.activeWorkspace);
  } else {
    renderWorkspaces();
  }
  if (state.agentPanelWorkspaceId === wsId) {
    state.agentPanelWorkspaceId = state.activeWorkspace;
    persist();
    restoreAgentChat(state.agentPanelWorkspaceId);
    populateAgentPersona();
    bindGlobalComposer();
    window.QuillCowork?.populateDelegateSelect();
  } else {
    persist();
  }
  showToast(`Closed ${ws.name}`);
}

function renameWorkspace(wsId) {
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const name = prompt("Rename workspace", ws.name);
  if (!name?.trim()) return;
  ws.name = name.trim();
  persist();
  renderWorkspaces();
  if (wsId === state.activeWorkspace) updateWorkspaceHead();
}

async function openFolderForWorkspace(wsId) {
  const folder = await window.quill.pickFolder();
  if (!folder) return;
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  ws.cwd = folder;
  ws.named = true;
  if (!ws.folders) ws.folders = [];
  if (!ws.folders.includes(folder)) ws.folders.unshift(folder);
  ws.name = folder.split(/[/\\]/).pop() || ws.name;
  persist();
  renderWorkspaces();
  if (wsId === state.activeWorkspace) {
    await refreshGitInfo();
    expandedDirs.clear();
    await renderFileTree();
    updateTitlebar();
    updateWorkspaceHead();
  }
  showToast(`Workspace folder: ${ws.name}`);
}

function addWorkspace() {
  const i = state.workspaces.length;
  const id = `ws-${Date.now()}`;
  const paneId = `pane-${id}-0`;
  state.workspaces.push({
    id,
    name: `Workspace ${i + 1}`,
    color: bootstrap.rainbow[i % bootstrap.rainbow.length],
    cwd: "",
    folders: [],
    panes: 1,
    layout: "grid-1x1",
    paneIds: [paneId],
    named: false,
  });
  state.panes[paneId] = { persona: bootstrap.personas[i % bootstrap.personas.length], mode: "agent" };
  persist();
  void switchWorkspace(id);
}

function persist() {
  window.quill.saveState(state);
  const ws = activeWs();
  if (ws?.named && ws.cwd) window.quill.saveWorkspaceProfile(ws);
}

function bindMenubar() {
  document.querySelectorAll(".menu-item").forEach((item) => {
    const trigger = item.querySelector(".menu-trigger");
    const dropdown = item.querySelector(".menu-dropdown");
    if (!dropdown) return;
    trigger.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".menu-dropdown").forEach((d) => d.classList.add("hidden"));
      dropdown.classList.toggle("hidden");
    };
    dropdown.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.onclick = () => {
        dropdown.classList.add("hidden");
        handleAction(btn.dataset.action);
      };
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".menu-dropdown").forEach((d) => d.classList.add("hidden"));
  });
}

function toggleBrowserPanel(show) {
  const panel = document.getElementById("browser-panel");
  if (!panel) return;
  const open = typeof show === "boolean" ? show : panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
}

async function exportWorkspaceSync() {
  await window.quill.exportWorkspaceSync(state);
  showToast("Workspace exported to ~/.quill/workspace-sync.json");
}

async function importWorkspaceSync() {
  const res = await window.quill.importWorkspaceSync();
  if (!res.ok) { showToast(res.error || "Import failed"); return; }
  Object.assign(state, res.state);
  if (!state.agentPanelWorkspaceId) state.agentPanelWorkspaceId = state.activeWorkspace;
  persist();
  renderWorkspaces();
  renderAgentPanelWorkspaceSelect();
  bindAgentPanelWorkspaceSelect();
  await renderPanes();
  restoreAgentChat(state.agentPanelWorkspaceId);
  await refreshGitInfo();
  await renderFileTree();
  showToast("Workspace imported");
}

function handleAction(action) {
  const map = {
    "open-workspace": openWorkspaceFile,
    "open-folder": openFolder,
    "add-folder": addFolderToWorkspace,
    "sync-export": exportWorkspaceSync,
    "sync-import": importWorkspaceSync,
    settings: () => openSettings("appearance"),
    "settings-appearance": () => openSettings("appearance"),
    "mcp-settings": () => openSettings("mcp"),
    "save-file": () => saveEditor(),
    "toggle-terminal": () => toggleTerminalPanel(),
    "toggle-agent": () => toggleAgentPanel(),
    "focus-terminal": () => focusWorkspaceTerminal(),
    "toggle-browser": () => toggleBrowserPanel(),
    quit: () => window.quill.quit(),
    palette: openPalette,
    "new-pane": addPane,
    about: () => openSettings("about"),
  };
  map[action]?.();
}

function bindScm() {
  document.getElementById("scm-stage-all")?.addEventListener("click", () => stageFiles(null, true));
  document.getElementById("scm-refresh")?.addEventListener("click", () => refreshScmPanel());
  document.getElementById("scm-commit")?.addEventListener("click", commitChanges);
  document.getElementById("scm-message")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commitChanges(); }
  });
  const branchSel = document.getElementById("status-branch");
  if (branchSel) {
    branchSel.addEventListener("change", () => {
      const ws = activeWs();
      const current = ws ? gitCache[ws.id]?.branch : null;
      if (branchSel.value && branchSel.value !== current) switchBranch(branchSel.value);
    });
  }
}

function bindEvents() {
  document.getElementById("add-workspace")?.addEventListener("click", addWorkspace);
  document.getElementById("settings-close")?.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "p") { e.preventDefault(); openPalette(); }
    if (e.ctrlKey && e.key === "o") { e.preventDefault(); openFolder(); }
    if (e.ctrlKey && e.key === "`") { e.preventDefault(); toggleTerminalPanel(); }
    if (e.ctrlKey && e.key === "l") {
      e.preventDefault();
      toggleAgentPanel();
      if (agentPanelMode === "open") document.getElementById("agent-composer-input")?.focus();
    }
    if (e.ctrlKey && e.shiftKey && e.key === "F") { e.preventDefault(); document.getElementById("global-search")?.classList.remove("hidden"); document.getElementById("global-search-input")?.focus(); }
    if (e.ctrlKey && e.shiftKey && e.key === "I") { cycleTheme(); }
    if (e.key === "Escape") { closePalette(); closeSettings(); }
  });
}

function cycleTheme() {
  const ids = Object.keys(bootstrap.themes || { dark: 1, imode: 1 });
  const idx = ids.indexOf(state.theme);
  state.theme = ids[(idx + 1) % ids.length];
  applyTheme();
  persist();
}

function openSettings(section = "appearance") {
  settingsSection = section;
  document.getElementById("settings").classList.remove("hidden");
  renderSettingsNav();
  renderSettingsContent();
}

function closeSettings() {
  document.getElementById("settings").classList.add("hidden");
}

function renderSettingsNav() {
  const nav = document.getElementById("settings-nav");
  if (!nav || !bootstrap) return;
  nav.innerHTML = bootstrap.settingsSections.map((s) => {
    const comingSoon = s.comingSoon ? '<em class="soon">Soon</em>' : "";
    return `<button type="button" class="settings-nav-item${s.id === settingsSection ? " active" : ""}" data-section="${s.id}">
      <span class="nav-icon">${s.icon}</span>
      <span class="nav-label">${s.label}</span>
      ${comingSoon}
    </button>`;
  }).join("");
  nav.querySelectorAll(".settings-nav-item").forEach((btn) => {
    btn.onclick = () => {
      settingsSection = btn.dataset.section;
      renderSettingsNav();
      renderSettingsContent();
    };
  });
}

function renderSettingsContent() {
  const el = document.getElementById("settings-content");
  if (!el || !bootstrap) return;
  const sec = bootstrap.settingsSections.find((s) => s.id === settingsSection);

  if (settingsSection === "mcp") {
    void renderMcpSettings(el);
    return;
  }

  if (settingsSection === "keybindings") {
    void window.QuillFeatures?.renderKeybindingsSettings(el);
    return;
  }

  if (settingsSection === "extensions") {
    window.QuillFeatures?.renderExtensionsSettings(el);
    return;
  }

  if (settingsSection === "remote") {
    el.innerHTML = `<div class="settings-page coming-soon-page">
      <h3>${sec?.label || "Remote Integration"}</h3>
      <p class="badge-soon">Coming Soon</p>
      <p class="settings-sub">Planned for a future release. See <code>future_features.md</code> in the repo.</p>
    </div>`;
    return;
  }

  if (settingsSection === "skills") {
    el.innerHTML = `<div class="settings-page coming-soon-page">
      <h3>MCP Skills</h3>
      <p class="badge-soon">Coming Soon</p>
      <p class="settings-sub">Configure MCP servers and agent skills from one panel.</p>
    </div>`;
    return;
  }

  if (settingsSection === "appearance") {
    const opts = Object.entries(bootstrap.themes || {}).map(([id, t]) =>
      `<option value="${id}"${state.theme === id ? " selected" : ""}>${t.label}</option>`
    ).join("");
    el.innerHTML = `<div class="settings-page">
      <h3>Appearance</h3>
      <p class="settings-sub">Color theme for the IDE shell and terminals.</p>
      <label class="field-row"><span>Theme</span><select id="theme-select">${opts}</select></label>
      <button type="button" class="btn-primary" id="save-appearance">Apply</button>
      <p class="settings-sub">Shortcut: Ctrl+Shift+I to cycle themes.</p>
    </div>`;
    const onThemeApply = () => {
      state.theme = document.getElementById("theme-select").value;
      applyTheme();
      persist();
    };
    document.getElementById("save-appearance").onclick = onThemeApply;
    document.getElementById("theme-select").onchange = onThemeApply;
    return;
  }

  if (settingsSection === "integrations") {
    el.innerHTML = `<div class="settings-page">
      <div class="settings-page-head"><div><h3>Integrations</h3>
      <p class="settings-sub">Keys saved to <code>~/.quill/.env</code>.</p></div>
      <span class="integration-count">${bootstrap.integrationsSummary}</span></div>
      <div class="integration-list" id="integration-list"></div></div>`;
    renderIntegrationCards();
    return;
  }

  if (settingsSection === "models") {
    el.innerHTML = `<div class="settings-page"><h3>Models</h3><p class="settings-sub">LLM provider keys.</p>
      <div class="env-form" id="models-form"></div><button type="button" class="btn-primary" id="save-models">Save</button></div>`;
    renderEnvForm("models-form", bootstrap.coreEnvKeys);
    document.getElementById("save-models").onclick = () => saveEnvForm("models-form");
    return;
  }

  if (settingsSection === "about") {
    const pty = bootstrap.ptyAvailable ? "ConPTY / node-pty" : "pipe fallback";
    el.innerHTML = `<div class="settings-page about-page"><h3>Quill</h3><p class="settings-sub">CODE BEAUTIFUL</p>
      <p>Version ${bootstrap.version || "0.2.0"} · Terminal: ${pty}</p>
      <p class="settings-sub">Monaco editor · Git SCM · MCP hot-reload · @mentions · agent diff sync</p>
      <button type="button" class="btn-primary" id="check-updates">Check for updates</button>
      <p class="settings-sub" id="update-status"></p></div>`;
    document.getElementById("check-updates").onclick = async () => {
      const st = document.getElementById("update-status");
      const res = await window.quill.checkForUpdates();
      st.textContent = res.updateAvailable
        ? `Update available: ${res.latest}`
        : `Up to date (${res.current}).`;
    };
    return;
  }

  el.innerHTML = `<div class="settings-page"><h3>${sec?.label || settingsSection}</h3><p class="settings-sub">Coming soon.</p></div>`;
}

function pulseActivity(paneId) {
  const dot = document.getElementById(`activity-${paneId}`) || document.getElementById("agent-activity");
  if (!dot) return;
  dot.classList.add("active");
  clearTimeout(dot._pulseTimer);
  dot._pulseTimer = setTimeout(() => dot.classList.remove("active"), 1500);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function parseMcpArgs(text) {
  return String(text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mcpServersFromForm() {
  const servers = {};
  document.querySelectorAll("#mcp-server-list .integration-card").forEach((card) => {
    const name = card.querySelector('[data-mcp-field="name"]')?.value.trim();
    const command = card.querySelector('[data-mcp-field="command"]')?.value.trim();
    const argsText = card.querySelector('[data-mcp-field="args"]')?.value || "";
    const enabledCb = card.querySelector("[data-mcp-enabled]");
    if (!name || !command) return;
    const entry = { command };
    const args = parseMcpArgs(argsText);
    if (args.length) entry.args = args;
    if (enabledCb && !enabledCb.checked) entry.enabled = false;
    servers[name] = entry;
  });
  return servers;
}

function updateMcpCount() {
  const count = Object.keys(mcpDraft.servers).length;
  const el = document.getElementById("mcp-count");
  if (el) el.textContent = `${count} server${count === 1 ? "" : "s"}`;
}

function renderMcpServerList() {
  const list = document.getElementById("mcp-server-list");
  if (!list) return;
  const names = Object.keys(mcpDraft.servers).sort();
  if (!names.length) {
    list.innerHTML = `<p class="settings-sub">No MCP servers configured.</p>`;
    return;
  }
  list.innerHTML = names.map((name) => {
    const spec = mcpDraft.servers[name] || {};
    const args = (spec.args || []).join(", ");
    const enabled = spec.enabled !== false;
    return `
    <details class="integration-card" open>
      <summary>
        <label class="mcp-toggle"><input type="checkbox" data-mcp-enabled="${escHtml(name)}"${enabled ? " checked" : ""} /> <span class="int-name">${escHtml(name)}</span></label>
        <button type="button" class="mcp-delete-btn" data-name="${escHtml(name)}" title="Remove">×</button>
      </summary>
      <div class="int-keys">
        <label class="field-row"><span>Name</span>
          <input type="text" data-mcp-field="name" value="${escHtml(name)}" /></label>
        <label class="field-row"><span>Command</span>
          <input type="text" data-mcp-field="command" value="${escHtml(spec.command || "")}" placeholder="npx" /></label>
        <label class="field-row"><span>Args</span>
          <input type="text" data-mcp-field="args" value="${escHtml(args)}" placeholder="-y, @modelcontextprotocol/server-github" /></label>
        <p class="settings-sub">Comma-separated arguments.</p>
        <button type="button" class="mcp-test-btn" data-mcp-test="${escHtml(name)}">Test command</button>
      </div>
    </details>`;
  }).join("");
  list.querySelectorAll(".mcp-delete-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      delete mcpDraft.servers[btn.dataset.name];
      renderMcpServerList();
      updateMcpCount();
    };
  });
  list.querySelectorAll("[data-mcp-test]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".integration-card");
      const command = card?.querySelector('[data-mcp-field="command"]')?.value.trim();
      const status = document.getElementById("mcp-status");
      const res = await window.quill.testMcpServer({ command });
      if (status) status.textContent = res.ok ? res.message : res.error;
    };
  });
  window.QuillFeatures?.bindMcpToggles(list);
}

async function renderMcpSettings(el) {
  const ws = activeWs();
  const cwd = ws?.cwd || "";
  el.innerHTML = `<div class="settings-page"><h3>MCP</h3><p class="settings-sub">Loading…</p></div>`;
  const res = await window.quill.getMcpConfig(cwd);
  mcpDraft = { servers: { ...(res.config?.servers || {}) } };
  const count = Object.keys(mcpDraft.servers).length;
  el.innerHTML = `
    <div class="settings-page">
      <div class="settings-page-head">
        <div>
          <h3>MCP</h3>
          <p class="settings-sub">Stdio servers saved to <code>.quill/mcp.json</code> in the active workspace.</p>
          <p class="settings-sub mcp-workspace">${escHtml(cwd)}</p>
        </div>
        <span class="integration-count" id="mcp-count">${count} server${count === 1 ? "" : "s"}</span>
      </div>
      <div class="integration-list" id="mcp-server-list"></div>
      <details class="integration-card mcp-add-card" open>
        <summary><span class="int-name">Add stdio server</span></summary>
        <div class="int-keys">
          <label class="field-row"><span>Name</span>
            <input type="text" id="mcp-new-name" placeholder="github" autocomplete="off" /></label>
          <label class="field-row"><span>Command</span>
            <input type="text" id="mcp-new-command" placeholder="npx" autocomplete="off" /></label>
          <label class="field-row"><span>Args</span>
            <input type="text" id="mcp-new-args" placeholder="-y, @modelcontextprotocol/server-github" autocomplete="off" /></label>
          <p class="settings-sub">Comma-separated arguments.</p>
          <button type="button" class="btn-primary" id="mcp-add-btn">Add server</button>
        </div>
      </details>
      <button type="button" class="btn-primary" id="mcp-save-btn">Save configuration</button>
      <button type="button" class="btn-secondary" id="mcp-reload-btn">Reload running agents</button>
      <p class="settings-sub mcp-status" id="mcp-status"></p>
    </div>`;
  renderMcpServerList();
  window.QuillFeatures?.setMcpDraftRef(mcpDraft);
  document.getElementById("mcp-add-btn").onclick = () => {
    const name = document.getElementById("mcp-new-name").value.trim();
    const command = document.getElementById("mcp-new-command").value.trim();
    const argsText = document.getElementById("mcp-new-args").value.trim();
    const status = document.getElementById("mcp-status");
    if (!name || !command) {
      status.textContent = "Name and command are required.";
      return;
    }
    if (mcpDraft.servers[name]) {
      status.textContent = `Server "${name}" already exists.`;
      return;
    }
    const entry = { command };
    const args = parseMcpArgs(argsText);
    if (args.length) entry.args = args;
    mcpDraft.servers[name] = entry;
    document.getElementById("mcp-new-name").value = "";
    document.getElementById("mcp-new-command").value = "";
    document.getElementById("mcp-new-args").value = "";
    status.textContent = "";
    renderMcpServerList();
    updateMcpCount();
  };
  document.getElementById("mcp-save-btn").onclick = async () => {
    const status = document.getElementById("mcp-status");
    mcpDraft.servers = mcpServersFromForm();
    try {
      const saveRes = await window.quill.saveMcpConfig(cwd, mcpDraft);
      if (saveRes?.ok) {
        status.textContent = `Saved to ${saveRes.path || ".quill/mcp.json"}. Running agents reloaded.`;
      } else {
        status.textContent = "Save failed.";
      }
      renderMcpServerList();
      updateMcpCount();
    } catch (err) {
      status.textContent = `Save failed: ${err.message || err}`;
    }
  };
  document.getElementById("mcp-reload-btn").onclick = async () => {
    const status = document.getElementById("mcp-status");
    try {
      await window.quill.reloadMcpAgents(cwd);
      status.textContent = "Sent MCP reload to running agents.";
    } catch (err) {
      status.textContent = `Reload failed: ${err.message || err}`;
    }
  };
}

function renderIntegrationCards() {
  const list = document.getElementById("integration-list");
  if (!list) return;
  list.innerHTML = bootstrap.integrations.map((int) => `
    <details class="integration-card ${int.status}">
      <summary><span class="int-name">${int.name}</span>
      <span class="int-badge ${int.status}">${int.status === "connected" ? "✓ Connected" : "Not connected"}</span></summary>
      <p class="int-desc">${int.desc}</p>
      <div class="int-keys">${int.keys.map((k) => `
        <label class="field-row"><span>${k.label}</span>
        <input type="password" data-env="${k.env}" placeholder="${k.placeholder}" autocomplete="off" /></label>`).join("")}
        <button type="button" class="btn-primary save-int">Save</button></div>
    </details>`).join("");
  list.querySelectorAll(".save-int").forEach((btn) => {
    btn.onclick = async () => {
      const wrap = btn.closest(".int-keys");
      const updates = {};
      wrap.querySelectorAll("input[data-env]").forEach((inp) => {
        if (inp.value.trim()) updates[inp.dataset.env] = inp.value.trim();
      });
      const res = await window.quill.saveEnvKeys(updates);
      bootstrap.integrationsSummary = res.integrationsSummary;
      renderIntegrationCards();
    };
  });
}

function renderEnvForm(id, keys) {
  const form = document.getElementById(id);
  if (!form) return;
  form.innerHTML = keys.map((k) => `
    <label class="field-row"><span>${k.label}</span>
    <input type="password" data-env="${k.env}" placeholder="${k.placeholder || ""}" autocomplete="off" /></label>`).join("");
}

async function saveEnvForm(id) {
  const form = document.getElementById(id);
  const updates = {};
  form.querySelectorAll("input[data-env]").forEach((inp) => {
    if (inp.value.trim()) updates[inp.dataset.env] = inp.value.trim();
  });
  await window.quill.saveEnvKeys(updates);
  bootstrap = await window.quill.getBootstrap();
}

let paletteItems = [];
let paletteSearchTimer = null;

function openPalette() {
  document.getElementById("palette").classList.remove("hidden");
  const input = document.getElementById("palette-input");
  input.value = "";
  input.focus();
  renderPalette("");
  input.oninput = () => {
    clearTimeout(paletteSearchTimer);
    paletteSearchTimer = setTimeout(() => renderPalette(input.value), 120);
  };
}

function closePalette() {
  document.getElementById("palette").classList.add("hidden");
}

async function renderPalette(q) {
  const list = document.getElementById("palette-list");
  const ql = q.trim().toLowerCase();
  const items = getCommands()
    .filter((c) => !ql || c.label.toLowerCase().includes(ql))
    .map((c) => ({ id: c.id, label: c.label, run: c.run, kind: "command" }));

  if (ql.length >= 2) {
    const ws = activeWs();
    if (ws?.cwd) {
      const res = await window.quill.searchFiles({ cwd: ws.cwd, query: ql, limit: 12 });
      for (const f of res.files || []) {
        items.push({
          id: `file-${f.path}`,
          label: `Open file: ${f.rel}`,
          kind: "file",
          run: () => openFileInEditor(f.path),
        });
      }
    }
  }

  if (window.QuillFeatures && ql.length >= 2) {
    await window.QuillFeatures.extendPalette(items, ql);
  }

  paletteItems = items;
  list.innerHTML = items.map((item, i) =>
    `<li data-id="${escHtml(item.id)}" class="${i === 0 ? "active" : ""}" data-kind="${item.kind || "command"}">${escHtml(item.label)}</li>`
  ).join("");
  list.querySelectorAll("li").forEach((li) => {
    li.onclick = () => {
      paletteItems.find((c) => c.id === li.dataset.id)?.run();
      closePalette();
    };
  });
}

init().catch((err) => {
  document.body.innerHTML = `<pre style="color:#ff6b6b;padding:20px">Quill failed: ${err.message}</pre>`;
});
