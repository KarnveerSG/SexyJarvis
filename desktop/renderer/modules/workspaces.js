/** Workspace CRUD, git info, folder management */
window.QuillModules = window.QuillModules || {};

(() => {
  const S = () => window.QuillModules.state;
  const { escHtml, pathsEqual, showToast } = window.QuillModules.util;

  function activeWs() {
    return S().state.workspaces.find((w) => w.id === S().state.activeWorkspace) || S().state.workspaces[0];
  }

  function agentPanelWs() {
    const id = S().state.agentPanelWorkspaceId || S().state.activeWorkspace;
    return S().state.workspaces.find((w) => w.id === id) || activeWs();
  }

  function persist() {
    window.quill.saveState(S().state);
    const ws = activeWs();
    if (ws?.named && ws.cwd) window.quill.saveWorkspaceProfile(ws);
  }

  function resetDefaultState() {
    const paneId = "pane-main";
    S().state.stateVersion = 3;
    S().state.workspaces = [{
      id: "ws-main", name: "Quill", color: S().bootstrap.rainbow[4], cwd: "",
      folders: [], panes: 1, layout: "grid-1x1", paneIds: [paneId], named: false,
    }];
    S().state.activeWorkspace = "ws-main";
    S().state.panes = { [paneId]: { persona: S().DEFAULT_PERSONA, mode: "agent" } };
  }

  function pickUnusedPersonaFromUsed(used) {
    const personas = S().bootstrap?.personas || [S().DEFAULT_PERSONA];
    for (const p of personas) {
      if (!used.has(p)) return p;
    }
    return personas[0];
  }

  function pickUnusedPersona(ws) {
    const used = new Set(
      (ws?.paneIds || []).map((id) => S().state.panes[id]?.persona).filter(Boolean)
    );
    return pickUnusedPersonaFromUsed(used);
  }

  async function sanitizeWorkspacePanes(ws) {
    if (!ws?.paneIds?.length) return;
    let changed = false;

    if (ws.paneIds.length > S().MAX_PANES) {
      const removed = ws.paneIds.splice(S().MAX_PANES);
      for (const paneId of removed) {
        const t = S().termInstances.get(paneId);
        if (t) {
          await window.quill.ptyKill(t.ptyId);
          t.term.dispose();
          S().termInstances.delete(paneId);
        }
        delete S().state.panes[paneId];
      }
      changed = true;
    }

    const validPersonas = new Set(S().bootstrap?.personas || []);
    const used = new Set();
    for (const paneId of ws.paneIds) {
      if (!S().state.panes[paneId]) {
        S().state.panes[paneId] = { persona: pickUnusedPersonaFromUsed(used), mode: "agent" };
        used.add(S().state.panes[paneId].persona);
        changed = true;
        continue;
      }
      let persona = S().state.panes[paneId].persona;
      if (!validPersonas.has(persona) || used.has(persona)) {
        persona = pickUnusedPersonaFromUsed(used);
        S().state.panes[paneId].persona = persona;
        changed = true;
      }
      used.add(persona);
    }

    ws.panes = ws.paneIds.length;
    ws.layout = window.QuillModules.terminals.layoutForPaneCount(ws.paneIds.length);
    if (changed) persist();
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
      const running = window.QuillModules.terminals.isWorkspaceAgentRunning(ws);
      dot.style.background = running ? "#4ec994" : "#e06c75";
    }
    const pid = ws.paneIds?.[0];
    const persona = pid ? S().state.panes[pid]?.persona : "";
    if (personaEl) personaEl.textContent = persona ? `· ${persona}` : "";
    if (toggleBtn) {
      const stopped = Boolean(ws.agentStopped);
      toggleBtn.textContent = stopped ? "Start agent" : "Stop agent";
      toggleBtn.title = stopped ? "Start workspace agent" : "Stop workspace agent (kill PTY)";
      toggleBtn.classList.toggle("ws-head-btn-danger", !stopped);
      toggleBtn.classList.toggle("ws-head-btn-start", stopped);
    }
    window.QuillModules.terminals.updateAgentStoppedOverlay(ws);
    window.QuillModules.agentPanel.updateAgentComposerState();
    const folder = ws.named && ws.cwd ? ws.cwd.split(/[/\\]/).pop() : "No folder — open one to browse files";
    document.getElementById("status-path").textContent = ws.cwd || folder;
  }

  function updateTitlebar() {
    const ws = activeWs();
    const folder = ws?.cwd ? ws.cwd.split(/[/\\]/).pop() : "Quill";
    const file = S().editorFilePath ? S().editorFilePath.split(/[/\\]/).pop() : "";
    const el = document.getElementById("titlebar-title");
    if (el) el.textContent = file ? `${folder} — ${file}` : folder;
  }

  function updateGitStatus() {
    const ws = activeWs();
    const info = ws ? S().gitCache[ws.id] : null;
    const changesEl = document.getElementById("status-git-changes");
    if (changesEl) {
      changesEl.textContent = info?.changes ? `(${info.changes} changed)` : "";
    }
  }

  function renderWorkspaces() {
    const ul = document.getElementById("workspace-list");
    ul.innerHTML = "";
    S().state.workspaces.forEach((ws) => {
      const li = document.createElement("li");
      const running = window.QuillModules.terminals.isWorkspaceAgentRunning(ws);
      li.className = "ws-item"
        + (ws.id === S().state.activeWorkspace ? " active" : "")
        + (ws.agentStopped ? " agent-stopped" : "");
      const folders = (ws.folders || []).length;
      const git = S().gitCache[ws.id];
      const gitLabel = git?.branch ? `${git.branch}${git.changes ? ` · ${git.changes}` : ""}` : "";
      const paneBadge = `${ws.paneIds?.length || 1}${folders > 1 ? ` · ${folders} folders` : ""}`;
      const dotClass = running ? "agent-running" : "agent-idle";
      li.innerHTML = `<span class="ws-dot ${dotClass}"></span><span>${escHtml(ws.name)}</span><span class="ws-badge">${escHtml(gitLabel || paneBadge)}</span>`;
      const actions = document.createElement("div");
      actions.className = "ws-item-actions";
      if (window.QuillModules.terminals.isWorkspaceAgentRunning(ws)) {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "ws-item-action";
        stop.title = "Stop agent";
        stop.textContent = "■";
        stop.onclick = (e) => { e.stopPropagation(); void window.QuillModules.terminals.stopWorkspaceAgent(ws.id); };
        actions.appendChild(stop);
      } else if (ws.agentStopped) {
        const start = document.createElement("button");
        start.type = "button";
        start.className = "ws-item-action start";
        start.title = "Start agent";
        start.textContent = "▶";
        start.onclick = (e) => { e.stopPropagation(); void window.QuillModules.terminals.startWorkspaceAgent(ws.id); };
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
    window.QuillModules.agentPanel.renderAgentPanelWorkspaceSelect();
  }

  async function refreshGitInfo(ws = activeWs()) {
    if (!ws?.cwd) return;
    S().gitCache[ws.id] = await window.quill.getGitInfo(ws.cwd);
    updateGitStatus();
    renderWorkspaces();
    await window.QuillModules.scm.refreshScmPanel();
    await window.QuillModules.scm.refreshBranchDropdown();
    await window.QuillFeatures?.refreshGitFileStatus();
    await window.QuillModules.editor.renderFileTree();
  }

  async function refreshAllGitInfo() {
    await Promise.all(S().state.workspaces.map(async (ws) => {
      if (ws?.cwd) S().gitCache[ws.id] = await window.quill.getGitInfo(ws.cwd);
    }));
    updateGitStatus();
    renderWorkspaces();
    await window.QuillModules.scm.refreshScmPanel();
    await window.QuillModules.scm.refreshBranchDropdown();
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
    const running = window.QuillModules.terminals.isWorkspaceAgentRunning(ws);
    if (running) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "danger";
      stop.textContent = "Stop agent";
      stop.onclick = () => { hideWsContextMenu(); void window.QuillModules.terminals.stopWorkspaceAgent(ws.id); };
      menu.appendChild(stop);
    } else if (ws.agentStopped) {
      const start = document.createElement("button");
      start.type = "button";
      start.textContent = "Start agent";
      start.onclick = () => { hideWsContextMenu(); void window.QuillModules.terminals.startWorkspaceAgent(ws.id); };
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
    if (S().state.workspaces.length > 1) {
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

  async function switchWorkspace(id) {
    if (id === S().state.activeWorkspace) return;
    S().state.activeWorkspace = id;
    persist();
    renderWorkspaces();
    await window.QuillModules.terminals.ensureWorkspaceUI(activeWs());
    window.QuillModules.terminals.showWorkspaceGrid(id);
    await refreshGitInfo();
    S().expandedDirs.clear();
    await window.QuillModules.editor.renderFileTree();
    updateTitlebar();
    window.QuillModules.editor.closeEditor();
    const nextWs = activeWs();
    if (nextWs?.openFiles?.length && window.QuillFeatures?.restoreTabs) {
      await window.QuillFeatures.restoreTabs(nextWs.openFiles, nextWs.activeFile);
    }
    window.QuillMultiAgent?.onWorkspaceChange?.();
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
      S().expandedDirs.clear();
      await window.QuillModules.editor.renderFileTree();
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
    await window.QuillModules.editor.renderFileTree();
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
    S().expandedDirs.delete(folderPath);
    persist();
    renderWorkspaces();
    await window.QuillModules.editor.renderFileTree();
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
    S().state.workspaces.push(ws);
    ws.paneIds.forEach((pid) => {
      if (!S().state.panes[pid]) S().state.panes[pid] = { persona: S().DEFAULT_PERSONA, mode: "agent" };
    });
    await sanitizeWorkspacePanes(ws);
    persist();
    await switchWorkspace(ws.id);
  }

  async function closeWorkspace(wsId) {
    if (S().state.workspaces.length <= 1) {
      showToast("Can't close the last workspace");
      return;
    }
    const ws = S().state.workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    if (S().state.agentPanelWorkspaceId === wsId) window.QuillModules.agentPanel.saveAgentChat(wsId);
    for (const paneId of ws.paneIds || []) {
      const t = S().termInstances.get(paneId);
      if (t) {
        await window.quill.ptyKill(t.ptyId);
        t.term.dispose();
        S().termInstances.delete(paneId);
      }
      delete S().state.panes[paneId];
    }
    delete S().wsChats[wsId];
    document.getElementById(`pane-grid-${wsId}`)?.remove();
    S().state.workspaces = S().state.workspaces.filter((w) => w.id !== wsId);
    if (S().state.activeWorkspace === wsId) {
      S().state.activeWorkspace = S().state.workspaces[0].id;
      await switchWorkspace(S().state.activeWorkspace);
    } else {
      renderWorkspaces();
    }
    if (S().state.agentPanelWorkspaceId === wsId) {
      S().state.agentPanelWorkspaceId = S().state.activeWorkspace;
      persist();
      window.QuillModules.agentPanel.restoreAgentChat(S().state.agentPanelWorkspaceId);
      window.QuillModules.agentPanel.populateAgentPersona();
      window.QuillModules.agentPanel.bindGlobalComposer();
      window.QuillCowork?.populateDelegateSelect();
    } else {
      persist();
    }
    showToast(`Closed ${ws.name}`);
  }

  function renameWorkspace(wsId) {
    const ws = S().state.workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const name = prompt("Rename workspace", ws.name);
    if (!name?.trim()) return;
    ws.name = name.trim();
    persist();
    renderWorkspaces();
    if (wsId === S().state.activeWorkspace) updateWorkspaceHead();
  }

  async function openFolderForWorkspace(wsId) {
    const folder = await window.quill.pickFolder();
    if (!folder) return;
    const ws = S().state.workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    ws.cwd = folder;
    ws.named = true;
    if (!ws.folders) ws.folders = [];
    if (!ws.folders.includes(folder)) ws.folders.unshift(folder);
    ws.name = folder.split(/[/\\]/).pop() || ws.name;
    persist();
    renderWorkspaces();
    if (wsId === S().state.activeWorkspace) {
      await refreshGitInfo();
      S().expandedDirs.clear();
      await window.QuillModules.editor.renderFileTree();
      updateTitlebar();
      updateWorkspaceHead();
    }
    showToast(`Workspace folder: ${ws.name}`);
  }

  async function addWorkspaceFromPath(folderPath) {
    if (!folderPath) return;
    const stat = await window.quill.statPath?.(folderPath);
    if (stat && !stat.isDirectory) {
      showToast("Drop a folder, not a file");
      return;
    }
    const i = S().state.workspaces.length;
    const id = `ws-${Date.now()}`;
    const paneId = `pane-${id}-0`;
    const name = folderPath.split(/[/\\]/).filter(Boolean).pop() || "Workspace";
    S().state.workspaces.push({
      id, name, color: S().bootstrap.rainbow[i % S().bootstrap.rainbow.length],
      cwd: folderPath, folders: [folderPath], panes: 1, layout: "grid-1x1",
      paneIds: [paneId], named: true, openFiles: [],
    });
    S().state.panes[paneId] = { persona: pickUnusedPersonaFromUsed(new Set()), mode: "agent" };
    persist();
    await switchWorkspace(id);
    showToast(`Added workspace: ${name}`);
  }

  function bindWorkspaceDrop() {
    const targets = [document.getElementById("workspace-list"), document.getElementById("file-tree")].filter(Boolean);
    for (const el of targets) {
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        el.classList.add("drop-target");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
      el.addEventListener("drop", async (e) => {
        e.preventDefault();
        el.classList.remove("drop-target");
        const files = Array.from(e.dataTransfer?.files || []);
        for (const f of files) {
          const p = window.quill.getDroppedPath?.(f) || f.path;
          if (p) await addWorkspaceFromPath(p);
        }
      });
    }
  }

  function addWorkspace() {
    const i = S().state.workspaces.length;
    const id = `ws-${Date.now()}`;
    const paneId = `pane-${id}-0`;
    S().state.workspaces.push({
      id,
      name: `Workspace ${i + 1}`,
      color: S().bootstrap.rainbow[i % S().bootstrap.rainbow.length],
      cwd: "",
      folders: [],
      panes: 1,
      layout: "grid-1x1",
      paneIds: [paneId],
      named: false,
    });
    S().state.panes[paneId] = { persona: S().bootstrap.personas[i % S().bootstrap.personas.length], mode: "agent" };
    persist();
    void switchWorkspace(id);
  }

  async function exportWorkspaceSync() {
    await window.quill.exportWorkspaceSync(S().state);
    showToast("Workspace exported to ~/.quill/workspace-sync.json");
  }

  async function importWorkspaceSync() {
    const res = await window.quill.importWorkspaceSync();
    if (!res.ok) { showToast(res.error || "Import failed"); return; }
    Object.assign(S().state, res.state);
    if (!S().state.agentPanelWorkspaceId) S().state.agentPanelWorkspaceId = S().state.activeWorkspace;
    persist();
    renderWorkspaces();
    window.QuillModules.agentPanel.renderAgentPanelWorkspaceSelect();
    window.QuillModules.agentPanel.bindAgentPanelWorkspaceSelect();
    await window.QuillModules.terminals.renderPanes();
    window.QuillModules.agentPanel.restoreAgentChat(S().state.agentPanelWorkspaceId);
    await refreshGitInfo();
    await window.QuillModules.editor.renderFileTree();
    showToast("Workspace imported");
  }

  window.QuillModules.workspaces = {
    activeWs,
    agentPanelWs,
    persist,
    resetDefaultState,
    pickUnusedPersonaFromUsed,
    pickUnusedPersona,
    sanitizeWorkspacePanes,
    updateWorkspaceHead,
    updateTitlebar,
    updateGitStatus,
    renderWorkspaces,
    refreshGitInfo,
    refreshAllGitInfo,
    switchWorkspace,
    openFolder,
    addFolderToWorkspace,
    removeFolderFromWorkspace,
    openWorkspaceFile,
    closeWorkspace,
    renameWorkspace,
    openFolderForWorkspace,
    addWorkspace,
    addWorkspaceFromPath,
    bindWorkspaceDrop,
    exportWorkspaceSync,
    importWorkspaceSync,
  };
})();
