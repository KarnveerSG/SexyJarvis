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
const TREE_SKIP = new Set(["node_modules", ".git", ".codegraph", "__pycache__", "dist", "build"]);
const TREE_SKIP_FILES = /^NTUSER\.DAT|^ntuser\.dat|^desktop\.ini$/i;
let agentPanelOpen = true;

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

function isAgentNoise(line) {
  const s = String(line || "").trim();
  if (!s || s.length < 2) return true;
  if (/file:\/\/|cursor-sdk|_MEI\d+|bridge\.dist|node_modules|Error \[ERR/i.test(s)) return true;
  if (/^\[\??\d*[A-Za-z;]*[hlm]$/.test(s) || /^[\[\?\d;]+[a-zA-Z]$/.test(s)) return true;
  if (/^You >|^Quill |^Workspace:|^Instruction files:|^Tip:|^Token savings:/i.test(s)) return false;
  return false;
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
    { id: "close-editor", label: "Close editor panel", run: () => closeEditor() },
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
  });
  if (!state.workspaces?.length) resetDefaultState();
  applyTheme();
  renderWorkspaces();
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
  void ensureMonaco();
  populateAgentPersona();
  updateTitlebar();
  updateWorkspaceHead();
  restoreAgentChat(state.activeWorkspace);
  document.getElementById("ws-add-terminal")?.addEventListener("click", () => addPane());
  document.getElementById("agent-panel-hide")?.addEventListener("click", () => setAgentPanelOpen(false));
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
    activeWs,
    resolvePath: resolveWsPath,
    pathsEqual,
    refreshEditor: refreshEditorContent,
    refreshGit: refreshGitInfo,
    showToast,
    getEditorPath: () => editorFilePath,
    getPrimaryPtyId: () => termInstances.get(primaryPaneId)?.ptyId,
    getPtyId: (paneId) => termInstances.get(paneId)?.ptyId,
    listPanes: () => activeWs()?.paneIds || [],
    getPanePersona: (paneId) => state.panes[paneId]?.persona || "Agent",
    getPersonas: () => bootstrap?.personas || [],
    addPane: (persona) => addPane(persona),
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
    if (wsId !== state.activeWorkspace) return;
    appendAgentStream(data);
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
  state.panes = { [paneId]: { persona: "Iris", mode: "agent" } };
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
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
  window.QuillFeatures?.parseAgentStream(raw);
  agentChatLineBuffer += stripAnsi(raw);
  clearTimeout(agentChatFlushTimer);
  agentChatFlushTimer = setTimeout(() => {
    const lines = agentChatLineBuffer.split("\n").map((l) => l.trim()).filter(Boolean);
    agentChatLineBuffer = "";
    const filtered = lines.filter((l) => !/\[QUILL_(TOOL|EDIT|TASK|BROWSER):/.test(l) && !isAgentNoise(l));
    const chunk = filtered.slice(-6).join("\n");
    if (chunk.length > 2) appendAgentChat("agent", chunk);
  }, 500);
}

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

function setAgentPanelOpen(open) {
  agentPanelOpen = open;
  document.getElementById("agent-panel")?.classList.toggle("hidden", !open);
  document.body.classList.toggle("agent-hidden", !open);
  setTimeout(() => fitActiveTerminals(), 120);
}

function focusWorkspaceTerminal() {
  const ws = activeWs();
  const paneId = ws?.paneIds?.[0];
  const host = paneId ? document.getElementById(`term-${paneId}`) : null;
  host?.focus();
  fitActiveTerminals();
}

function updateWorkspaceHead() {
  const ws = activeWs();
  const nameEl = document.getElementById("ws-center-name");
  const personaEl = document.getElementById("ws-center-persona");
  const dot = document.getElementById("ws-head-dot");
  const label = document.getElementById("agent-ws-label");
  if (!ws) return;
  if (nameEl) nameEl.textContent = ws.name;
  if (dot) dot.style.background = ws.color;
  const pid = ws.paneIds?.[0];
  const persona = pid ? state.panes[pid]?.persona : "";
  if (personaEl) personaEl.textContent = persona ? `· ${persona}` : "";
  if (label) label.textContent = ws.name;
  const folder = ws.named && ws.cwd ? ws.cwd.split(/[/\\]/).pop() : "No folder — open one to browse files";
  document.getElementById("status-path").textContent = ws.cwd || folder;
}

function fitActiveTerminals() {
  const ws = activeWs();
  if (!ws?.paneIds) return;
  for (const paneId of ws.paneIds) {
    termInstances.get(paneId)?.fit?.fit();
  }
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

function showWorkspaceGrid(wsId) {
  document.querySelectorAll(".ws-pane-grid").forEach((g) => {
    g.classList.toggle("hidden", g.dataset.wsId !== wsId);
  });
  document.getElementById("workspace-center-head")?.classList.remove("hidden");
  document.getElementById("empty-state")?.classList.add("hidden");
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
  focusWorkspaceTerminal();
}

function bindActivityBar() {
  document.querySelectorAll(".activity-btn[data-panel]").forEach((btn) => {
    btn.onclick = () => {
      activeSidePanel = btn.dataset.panel;
      if (activeSidePanel === "agent") {
        setAgentPanelOpen(!agentPanelOpen);
        if (agentPanelOpen) document.getElementById("agent-composer-input")?.focus();
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

function populateAgentPersona() {
  const sel = document.getElementById("agent-persona");
  const ws = activeWs();
  const paneId = ws?.paneIds?.[0];
  if (!sel || !bootstrap?.personas || !paneId) return;
  const meta = state.panes[paneId] || { persona: "Iris" };
  sel.innerHTML = bootstrap.personas.map((p) =>
    `<option value="${escHtml(p)}"${p === meta.persona ? " selected" : ""}>${escHtml(p)}</option>`
  ).join("");
  sel.onchange = async () => {
    state.panes[paneId].persona = sel.value;
    persist();
    await remountPane(paneId);
  };
}

function bindGlobalComposer() {
  const input = document.getElementById("agent-composer-input");
  const send = document.getElementById("agent-composer-send");
  const wrap = input?.closest(".agent-composer-wrap");
  const ws = activeWs();
  primaryPaneId = ws?.paneIds?.[0] || primaryPaneId;
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
      const ws = activeWs();
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
    li.className = "ws-item" + (ws.id === state.activeWorkspace ? " active" : "");
    li.style.setProperty("--ws-color", ws.color);
    const folders = (ws.folders || []).length;
    const git = gitCache[ws.id];
    const gitLabel = git?.branch ? `${git.branch}${git.changes ? ` · ${git.changes}` : ""}` : "";
    const paneBadge = `${ws.paneIds?.length || 1}${folders > 1 ? ` · ${folders} folders` : ""}`;
    li.innerHTML = `<span class="ws-dot"></span><span>${ws.name}</span><span class="ws-badge">${gitLabel || paneBadge}</span>`;
    li.onclick = () => switchWorkspace(ws.id);
    ul.appendChild(li);
  });
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

async function refreshScmPanel() {
  const ws = activeWs();
  const ul = document.getElementById("scm-files");
  const statusEl = document.getElementById("scm-status");
  if (!ws?.cwd || !ul) return;
  const res = await window.quill.gitStatusFiles(ws.cwd);
  if (!res.ok) {
    ul.innerHTML = `<li class="scm-empty">${escHtml(res.error || "Not a git repo")}</li>`;
    return;
  }
  if (!res.files.length) {
    ul.innerHTML = `<li class="scm-empty">No changes</li>`;
  } else {
    ul.innerHTML = res.files.map((f) => `
      <li class="scm-file${f.staged ? " staged" : ""}" data-path="${escHtml(f.absPath)}">
        <span class="scm-code scm-code-${f.status}">${escHtml(f.status)}</span>
        <span class="scm-name" title="${escHtml(f.path)}">${escHtml(f.path)}</span>
        ${!f.staged ? `<button type="button" class="scm-stage-one" data-rel="${escHtml(f.path)}" title="Stage">+</button>` : ""}
      </li>`).join("");
    ul.querySelectorAll(".scm-file").forEach((li) => {
      li.onclick = (e) => {
        if (e.target.closest(".scm-stage-one")) return;
        openFileInEditor(li.dataset.path);
      };
    });
    ul.querySelectorAll(".scm-stage-one").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        await stageFiles([btn.dataset.rel]);
      };
    });
  }
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
  document.getElementById("empty-state")?.classList.remove("hidden");
  document.getElementById("inline-diff-bar")?.classList.add("hidden");
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
  document.getElementById("empty-state")?.classList.add("hidden");
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
    li.style.paddingLeft = `${6 + depth * 12}px`;
    li.dataset.path = entry.path;
    const expanded = entry.isDirectory && expandedDirs.has(entry.path);
    if (expanded) li.classList.add("expanded");
    li.innerHTML = `<span class="tree-icon">${entry.isDirectory ? "▸" : "·"}</span><span class="tree-name">${escHtml(entry.name)}</span>${window.QuillFeatures?.treeGitBadge(entry.path) || ""}`;
    parentUl.appendChild(li);
    if (entry.isDirectory) {
      li.onclick = async (e) => {
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
      li.onclick = (e) => {
        e.stopPropagation();
        openFileInEditor(entry.path);
      };
    }
  }
}

async function renderFileTree() {
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
  for (const root of roots) {
    if (roots.length > 1) {
      const head = document.createElement("li");
      head.className = "tree-root-label";
      head.textContent = root.split(/[/\\]/).pop() || root;
      ul.appendChild(head);
    }
    await appendTreeDir(ul, root, 0);
  }
  if (!ul.querySelector(".tree-item")) {
    ul.innerHTML = `<li class="tree-empty">No files in folder</li>`;
  }
}

function renderWsFolderRoots() {
  const el = document.getElementById("ws-folder-roots");
  const ws = activeWs();
  if (!el || !ws?.named) { el?.classList.add("hidden"); return; }
  const roots = [...new Set((ws.folders?.length ? ws.folders : [ws.cwd]).filter(Boolean))];
  if (roots.length <= 1) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = roots.map((r) =>
    `<div class="ws-folder-chip" title="${escHtml(r)}">${escHtml(r.split(/[/\\]/).pop())}</div>`
  ).join("") + `<button type="button" class="ws-folder-add" id="ws-folder-add" title="Add folder">+</button>`;
  document.getElementById("ws-folder-add")?.addEventListener("click", addFolderToWorkspace);
}

async function switchWorkspace(id) {
  if (id === state.activeWorkspace) return;
  saveAgentChat(state.activeWorkspace);
  state.activeWorkspace = id;
  persist();
  renderWorkspaces();
  await ensureWorkspaceUI(activeWs());
  showWorkspaceGrid(id);
  restoreAgentChat(id);
  await refreshGitInfo();
  expandedDirs.clear();
  await renderFileTree();
  populateAgentPersona();
  bindGlobalComposer();
  window.QuillCowork?.populateDelegateSelect();
  updateTitlebar();
  closeEditor();
}

async function ensureWorkspaceUI(ws) {
  if (!ws) return;
  const grid = getWsGrid(ws);
  if (!grid) return;

  ws.layout = ws.layout || "grid-1x1";
  ws.panes = ws.paneIds?.length || 1;
  grid.className = `pane-grid ${ws.layout || "grid-1x1"} ws-pane-grid`;
  if (grid.dataset.wsId !== ws.id) grid.dataset.wsId = ws.id;

  if (!ws.paneIds?.length) {
    const paneId = `pane-${ws.id}-0`;
    ws.paneIds = [paneId];
    state.panes[paneId] = { persona: "Iris", mode: "agent" };
  }

  const split = ws.paneIds.length === 2;
  const needsDom = !ws.paneIds.every((id) => document.getElementById(`term-${id}`));
  if (needsDom) {
    grid.innerHTML = "";
    if (split) {
      ws.splitPct = ws.splitPct ?? 50;
      grid.classList.add("split-h2");
      grid.style.gridTemplateColumns = `${ws.splitPct}% 5px 1fr`;
    } else {
      grid.classList.remove("split-h2");
      grid.style.gridTemplateColumns = "";
      grid.style.gridTemplateRows = "";
    }
    for (let i = 0; i < ws.paneIds.length; i++) {
      const paneId = ws.paneIds[i];
      grid.appendChild(createPaneElement(paneId, ws));
      if (split && i === 0) {
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
        grid.appendChild(gutter);
      }
    }
  }

  for (const paneId of ws.paneIds) {
    if (!termInstances.has(paneId)) await mountTerminal(paneId, ws);
  }
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
  const meta = state.panes[paneId] || { persona: "Iris", mode: "agent" };
  state.panes[paneId] = meta;
  primaryPaneId = paneId;
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<div class="pane-term" id="term-${paneId}"></div>`;
  return el;
}

async function remountPane(paneId) {
  const ws = activeWs();
  if (!ws) return;
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

  const meta = state.panes[paneId] || { persona: "Iris", mode: "agent" };
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

  const ro = new ResizeObserver(() => {
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
  persist();
  await renderPanes();
}

async function addPane(personaOverride) {
  const ws = activeWs();
  if (!ws) return;
  const paneId = `pane-${Date.now()}`;
  ws.paneIds = ws.paneIds || [];
  ws.paneIds.push(paneId);
  const persona = personaOverride || bootstrap.personas[ws.paneIds.length % bootstrap.personas.length];
  state.panes[paneId] = { persona, mode: "agent" };
  ws.panes = ws.paneIds.length;
  ws.layout = ws.paneIds.length <= 1 ? "grid-1x1" : ws.paneIds.length <= 4 ? "grid-2x2" : "grid-3x2";
  persist();
  await renderPanes();
  window.QuillCowork?.populateDelegateSelect();
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
    if (!state.panes[pid]) state.panes[pid] = { persona: "Iris", mode: "agent" };
  });
  state.activeWorkspace = ws.id;
  persist();
  await switchWorkspace(ws.id);
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
  state.activeWorkspace = id;
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
  persist();
  renderWorkspaces();
  await renderPanes();
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
    "toggle-terminal": () => focusWorkspaceTerminal(),
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
      setAgentPanelOpen(!agentPanelOpen);
      if (agentPanelOpen) document.getElementById("agent-composer-input")?.focus();
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
  nav.innerHTML = bootstrap.settingsSections.map((s) =>
    `<button type="button" class="settings-nav-item${s.id === settingsSection ? " active" : ""}" data-section="${s.id}">
      <span class="nav-icon">${s.icon}</span>${s.label}${s.comingSoon ? ' <em class="soon">Soon</em>' : ""}
    </button>`
  ).join("");
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
