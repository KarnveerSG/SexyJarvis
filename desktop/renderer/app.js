/** Quill desktop — thin entry, wires modules */
window.QuillApp = window.QuillApp || {};

(() => {
  const S = () => window.QuillModules.state;
  const M = window.QuillModules;

  function applyTheme() {
    const t = S().bootstrap?.themes?.[S().state.theme] || S().bootstrap?.themes?.dark;
    for (const key of S().THEME_CSS_VARS) {
      document.documentElement.style.removeProperty(key);
    }
    document.body.className = t?.cssClass || "theme-dark";
    if (t?.vars) {
      for (const [k, v] of Object.entries(t.vars)) {
        document.documentElement.style.setProperty(k, v);
      }
    }
    for (const [, inst] of S().termInstances) {
      inst.term.options.theme = M.terminals.termTheme();
      inst.term.refresh(0, inst.term.rows);
    }
    if (window.monaco?.editor) {
      monaco.editor.setTheme(M.editor.monacoThemeId());
    }
  }

  function cycleTheme() {
    const ids = Object.keys(S().bootstrap.themes || { dark: 1, imode: 1 });
    const idx = ids.indexOf(S().state.theme);
    S().state.theme = ids[(idx + 1) % ids.length];
    applyTheme();
    M.workspaces.persist();
  }

  function toggleBrowserPanel(show) {
    const panel = document.getElementById("browser-panel");
    if (!panel) return;
    const open = typeof show === "boolean" ? show : panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !open);
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

  function handleAction(action) {
    const map = {
      "open-workspace": M.workspaces.openWorkspaceFile,
      "open-folder": M.workspaces.openFolder,
      "add-folder": M.workspaces.addFolderToWorkspace,
      "sync-export": M.workspaces.exportWorkspaceSync,
      "sync-import": M.workspaces.importWorkspaceSync,
      settings: () => M.settings.openSettings("appearance"),
      "settings-appearance": () => M.settings.openSettings("appearance"),
      "mcp-settings": () => M.settings.openSettings("mcp"),
      "save-file": () => M.editor.saveEditor(),
      "toggle-terminal": () => M.terminals.toggleTerminalPanel(),
      "toggle-agent": () => M.agentPanel.toggleAgentPanel(),
      "focus-terminal": () => M.terminals.focusWorkspaceTerminal(),
      "toggle-browser": () => toggleBrowserPanel(),
      quit: () => window.quill.quit(),
      palette: M.palette.openPalette,
      "new-pane": M.terminals.addPane,
      about: () => M.settings.openSettings("about"),
    };
    map[action]?.();
  }

  function bindActivityBar() {
    document.querySelectorAll(".activity-btn[data-panel]").forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.panel === "settings") {
          M.settings.openSettings("appearance");
          return;
        }
        S().activeSidePanel = btn.dataset.panel;
        if (S().activeSidePanel === "agent") {
          if (S().agentPanelMode === "closed") M.agentPanel.setAgentPanelMode("open");
          else if (S().agentPanelMode === "minimized") M.agentPanel.setAgentPanelMode("open");
          else M.agentPanel.setAgentPanelMode("closed");
          if (S().agentPanelMode === "open") document.getElementById("agent-composer-input")?.focus();
          return;
        }
        if (btn.dataset.panel === "tasks") window.QuillMultiAgent?.renderTaskBoard?.();
        document.querySelectorAll(".activity-btn[data-panel]").forEach((b) => {
          b.classList.toggle("active", b.dataset.panel === S().activeSidePanel);
        });
        document.querySelectorAll(".panel-view").forEach((p) => {
          p.classList.toggle("active", p.dataset.view === S().activeSidePanel);
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
        const ws = M.workspaces.activeWs();
        const res = await window.quill.searchFiles({ cwd: ws?.cwd, query: q, limit: 30 });
        ul.innerHTML = (res.files || []).map((f) =>
          `<li data-path="${M.util.escHtml(f.path)}">${M.util.escHtml(f.rel)}</li>`
        ).join("");
        ul.querySelectorAll("li").forEach((li) => {
          li.onclick = () => M.editor.openFileInEditor(li.dataset.path);
        });
      }, 150);
    };
  }

  const PANEL_DEFAULTS = { side: 260, agent: 420 };
  const PANEL_MIN = 180;
  const PANEL_MAX_FRAC = 0.5;

  function applyPanelWidths() {
    const pw = S().state.panelWidths || {};
    if (pw.side) document.documentElement.style.setProperty("--side-width", `${pw.side}px`);
    if (pw.agent) document.documentElement.style.setProperty("--agent-width", `${pw.agent}px`);
  }

  function bindPanelGutters() {
    const gutters = [
      { el: document.getElementById("gutter-side"), key: "side", edge: "left" },
      { el: document.getElementById("gutter-agent"), key: "agent", edge: "right" },
    ];
    for (const g of gutters) {
      if (!g.el) continue;
      g.el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        g.el.classList.add("dragging");
        const startX = e.clientX;
        const startW = S().state.panelWidths?.[g.key] || PANEL_DEFAULTS[g.key];
        const max = window.innerWidth * PANEL_MAX_FRAC;
        const onMove = (ev) => {
          const delta = g.edge === "left" ? ev.clientX - startX : startX - ev.clientX;
          const next = Math.max(PANEL_MIN, Math.min(max, startW + delta));
          if (!S().state.panelWidths) S().state.panelWidths = { ...PANEL_DEFAULTS };
          S().state.panelWidths[g.key] = Math.round(next);
          applyPanelWidths();
          M.terminals.fitActiveTerminals();
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          g.el.classList.remove("dragging");
          M.workspaces.persist();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      g.el.addEventListener("dblclick", () => {
        if (!S().state.panelWidths) S().state.panelWidths = { ...PANEL_DEFAULTS };
        S().state.panelWidths[g.key] = PANEL_DEFAULTS[g.key];
        applyPanelWidths();
        M.workspaces.persist();
        M.terminals.fitActiveTerminals();
      });
    }
  }

  function bindEvents() {
    document.getElementById("add-workspace")?.addEventListener("click", M.workspaces.addWorkspace);
    document.getElementById("settings-close")?.addEventListener("click", M.settings.closeSettings);
    const stage = document.getElementById("workspace-stage");
    if (stage) new ResizeObserver(() => M.terminals.fitActiveTerminals()).observe(stage);
    window.addEventListener("resize", () => M.terminals.fitActiveTerminals());
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "p") { e.preventDefault(); M.palette.openPalette(); }
      if (e.ctrlKey && e.key === "o") { e.preventDefault(); M.workspaces.openFolder(); }
      if (e.ctrlKey && e.key === "`") { e.preventDefault(); M.terminals.toggleTerminalPanel(); }
      if (e.ctrlKey && e.key === "l") {
        e.preventDefault();
        M.agentPanel.toggleAgentPanel();
        if (S().agentPanelMode === "open") document.getElementById("agent-composer-input")?.focus();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "F") { e.preventDefault(); document.getElementById("global-search")?.classList.remove("hidden"); document.getElementById("global-search-input")?.focus(); }
      if (e.ctrlKey && e.shiftKey && e.key === "I") { cycleTheme(); }
      if (e.key === "Escape") { M.palette.closePalette(); M.settings.closeSettings(); }
    });
  }

  async function init() {
    S().bootstrap = await window.quill.getBootstrap();
    Object.assign(S().state, S().bootstrap.state);
    S().state.workspaces?.forEach((ws) => {
      if (ws.named == null) ws.named = false;
      if (ws.agentStopped == null) ws.agentStopped = false;
    });
    for (const ws of S().state.workspaces || []) {
      await M.workspaces.sanitizeWorkspacePanes(ws);
    }
    M.workspaces.persist();
    if (S().state.agentPanelMode == null) {
      S().state.agentPanelMode = S().state.agentPanelOpen === false ? "closed" : "open";
    }
    if (!S().state.workspaces?.length) M.workspaces.resetDefaultState();
    if (!S().state.agentPanelWorkspaceId) S().state.agentPanelWorkspaceId = S().state.activeWorkspace;
    if (!S().state.panelWidths) S().state.panelWidths = { side: 280, agent: 360 };
    for (const ws of S().state.workspaces || []) {
      if (!Array.isArray(ws.openFiles)) ws.openFiles = [];
    }
    applyTheme();
    applyPanelWidths();
    M.workspaces.renderWorkspaces();
    M.agentPanel.renderAgentPanelWorkspaceSelect();
    M.agentPanel.bindAgentPanelWorkspaceSelect();
    await M.terminals.renderPanes();
    document.getElementById("status-path").textContent = S().bootstrap.quillPath || "Quill";
    const localEl = document.getElementById("status-local-llm");
    if (localEl) {
      const b = S().bootstrap;
      if (b.localLlmAvailable) {
        localEl.textContent = `Local LLM: ${b.localLlmModel || "ready"}`;
        localEl.classList.remove("hidden");
      } else {
        localEl.textContent = "";
        localEl.classList.add("hidden");
      }
    }
    await M.workspaces.refreshAllGitInfo();
    await M.editor.renderFileTree();
    M.settings.renderSettingsNav();
    bindEvents();
    bindMenubar();
    M.editor.bindEditorDrawer();
    M.scm.bindScm();
    bindActivityBar();
    bindPanelGutters();
    bindSideSearch();
    M.agentPanel.setAgentPanelMode(S().state.agentPanelMode || "open", { persist: false });
    void M.editor.ensureMonaco();
    M.agentPanel.populateAgentPersona();
    M.workspaces.updateTitlebar();
    M.workspaces.updateWorkspaceHead();
    M.agentPanel.restoreAgentChat(S().state.agentPanelWorkspaceId || S().state.activeWorkspace);
    M.agentPanel.bindAgentStreamToggle();
    document.getElementById("ws-add-terminal")?.addEventListener("click", () => M.terminals.addPane());
    document.getElementById("ws-toggle-agent")?.addEventListener("click", () => M.terminals.toggleWorkspaceAgent());
    document.getElementById("agent-panel-minimize")?.addEventListener("click", () => M.agentPanel.setAgentPanelMode("minimized"));
    document.getElementById("agent-panel-hide")?.addEventListener("click", () => M.agentPanel.setAgentPanelMode("closed"));
    document.getElementById("agent-panel-expand")?.addEventListener("click", () => M.agentPanel.setAgentPanelMode("open"));
    document.getElementById("agent-panel")?.addEventListener("click", (e) => {
      if (S().agentPanelMode === "minimized" && !e.target.closest("button")) M.agentPanel.setAgentPanelMode("open");
    });
    document.querySelectorAll("[data-action='open-folder']").forEach((el) => {
      el.addEventListener("click", (e) => { e.preventDefault(); M.workspaces.openFolder(); });
    });
    document.querySelectorAll("[data-action='focus-terminal']").forEach((el) => {
      el.addEventListener("click", (e) => { e.preventDefault(); M.terminals.focusWorkspaceTerminal(); });
    });

    window.QuillFeatures?.init({
      activeWs: M.workspaces.activeWs,
      ensureMonaco: M.editor.ensureMonaco,
      getEditor: () => S().monacoEditor,
      getEditorPath: () => S().editorFilePath,
      setEditorPath: (p) => { S().editorFilePath = p; },
      setDirty: (d) => { S().editorDirty = d; },
      guessLang: M.editor.guessMonacoLang,
      updateDirtyUI: M.editor.updateEditorDirty,
      updateTitlebar: M.workspaces.updateTitlebar,
      closeEditor: M.editor.closeEditor,
      saveEditor: M.editor.saveEditor,
      refreshEditor: M.editor.refreshEditorContent,
      refreshGit: M.workspaces.refreshGitInfo,
      openPalette: M.palette.openPalette,
      toggleTerminal: () => M.terminals.toggleTerminalPanel(),
      openFolder: M.workspaces.openFolder,
      showToast: M.util.showToast,
      pathsEqual: M.util.pathsEqual,
      resolvePath: M.util.resolveWsPath,
      setEditorTab: M.editor.setEditorTab,
      getState: () => S().state,
      _lspRegistered: false,
    });

    (async () => {
      const ws = M.workspaces.activeWs();
      if (ws?.openFiles?.length && window.QuillFeatures?.restoreTabs) {
        await window.QuillFeatures.restoreTabs(ws.openFiles, ws.activeFile);
      }
    })();

    window.QuillCowork?.init({
      activeWs: M.workspaces.agentPanelWs,
      resolvePath: M.util.resolveWsPath,
      pathsEqual: M.util.pathsEqual,
      refreshEditor: M.editor.refreshEditorContent,
      refreshGit: M.workspaces.refreshGitInfo,
      showToast: M.util.showToast,
      getEditorPath: () => S().editorFilePath,
      getPrimaryPtyId: () => {
        const ws = M.workspaces.agentPanelWs();
        const pid = ws?.paneIds?.[0];
        return pid ? S().termInstances.get(pid)?.ptyId : S().termInstances.get(S().primaryPaneId)?.ptyId;
      },
      getPtyId: (paneId) => S().termInstances.get(paneId)?.ptyId,
      listPanes: () => M.workspaces.agentPanelWs()?.paneIds || [],
      getPanePersona: (paneId) => S().state.panes[paneId]?.persona || "Agent",
      getPersonas: () => S().bootstrap?.personas || [],
      addPane: (persona) => M.terminals.addPane(persona),
      onDelegateChange: () => M.agentPanel.populateAgentPersona(),
    });

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void M.editor.saveEditor();
      }
    });

    window.quill.onPtyData(({ id, data }) => {
      const wsId = M.terminals.ptyWorkspaceId(id);
      for (const [paneId, t] of S().termInstances) {
        if (t.ptyId === id) {
          t.term.write(data);
          window.QuillMultiAgent?.parsePtyData?.(paneId, t, data);
          if (wsId === S().state.activeWorkspace) M.terminals.pulseActivity(paneId);
        }
      }
      const agentWsId = S().state.agentPanelWorkspaceId || S().state.activeWorkspace;
      if (wsId !== agentWsId) return;
      window.QuillFeatures?.parseAgentStream(data);
      if (M.agentPanel.shouldStreamPtyToAgentChat()) M.agentPanel.appendAgentStream(data);
      const editMatch = data.match(/\[QUILL_EDIT:([^\]\r\n]+)\]/);
      if (editMatch) void M.editor.onWorkspaceFileChanged(M.util.resolveWsPath(editMatch[1]));
    });
    window.quill.onPtyExit(({ id }) => {
      for (const [, t] of S().termInstances) {
        if (t.ptyId === id) t.term.write("\r\n\x1b[33m[Agent exited]\x1b[0m\r\n");
      }
    });
    window.quill.onWorkspaceFileChanged(({ path }) => {
      void M.editor.onWorkspaceFileChanged(path);
    });

    window.__quillShutdown = async () => {
      M.workspaces.persist();
      await M.terminals.killAllPanes();
    };

    window.QuillMultiAgent?.init({
      activeWs: M.workspaces.activeWs,
      agentPanelWs: M.workspaces.agentPanelWs,
      getBootstrap: () => S().bootstrap,
      getPanePersona: (paneId) => S().state.panes[paneId]?.persona || "Agent",
      switchWorkspace: M.workspaces.switchWorkspace,
      showToast: M.util.showToast,
      getState: () => S().state,
      getTermInstances: () => S().termInstances,
    });
  }

  window.QuillApp = { init, applyTheme, cycleTheme, handleAction, toggleBrowserPanel };

  init().catch((err) => {
    document.body.innerHTML = `<pre style="color:#ff6b6b;padding:20px">Quill failed: ${err.message}</pre>`;
  });
})();
