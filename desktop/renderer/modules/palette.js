/** Command palette — categorized: > commands, @ symbols, # workspaces, : line, plain = files */
window.QuillModules = window.QuillModules || {};

(() => {
  const S = () => window.QuillModules.state;
  const { escHtml } = window.QuillModules.util;

  let lastComposerText = "";

  function setLastComposerText(text) {
    lastComposerText = text;
  }

  function getCommands() {
    const cmds = [
      { id: "settings", label: "> Open settings", run: () => window.QuillModules.settings.openSettings("appearance") },
      { id: "new-pane", label: "> New terminal pane", run: () => window.QuillModules.terminals.addPane() },
      { id: "open-folder", label: "> Open folder", run: () => window.QuillModules.workspaces.openFolder() },
      { id: "theme", label: "> Cycle theme", run: () => window.QuillApp.cycleTheme() },
      { id: "mcp-settings", label: "> Open MCP settings", run: () => window.QuillModules.settings.openSettings("mcp") },
      { id: "git-refresh", label: "> Refresh git info", run: () => window.QuillModules.workspaces.refreshAllGitInfo() },
      { id: "toggle-agent", label: "> Toggle agent panel", run: () => window.QuillModules.agentPanel.toggleAgentPanel() },
      { id: "toggle-provider", label: "> Toggle LLM provider", run: () => {
        const sel = document.getElementById("status-provider");
        if (!sel) return;
        const opts = [...sel.options].filter((o) => !o.disabled);
        const idx = opts.findIndex((o) => o.value === sel.value);
        const next = opts[(idx + 1) % opts.length];
        if (next) { sel.value = next.value; sel.dispatchEvent(new Event("change")); }
      }},
      { id: "undo-turn", label: "> Undo last agent turn (revert edits)", run: async () => {
        const feat = window.QuillFeatures;
        const pending = feat?.getPendingEdits?.();
        const paths = pending ? [...pending.keys()] : [];
        const ws = window.QuillModules.workspaces.activeWs();
        if (!ws?.cwd) return;
        if (!paths.length) {
          window.QuillModules.util.showToast("No pending agent edits to undo");
          return;
        }
        if (!confirm(`Revert ${paths.length} file${paths.length > 1 ? "s" : ""} to git HEAD?`)) return;
        for (const p of paths) {
          try { await window.quill.gitRevertFile({ cwd: ws.cwd, filePath: p }); } catch (_) {}
        }
        // signal CLI too, in case it implements /undo later
        const pid = ws.paneIds?.[0];
        const t = pid ? S().termInstances.get(pid) : null;
        if (t?.ptyId) window.quill.ptyWrite(t.ptyId, "/undo\r");
        feat?.clearPendingEdits?.();
        await window.QuillModules.workspaces.refreshGitInfo();
        window.QuillModules.util.showToast(`Reverted ${paths.length} file(s)`);
      }},
      { id: "run-last", label: "> Run last task", run: () => {
        if (!lastComposerText) return;
        const input = document.getElementById("agent-composer-input");
        if (input) { input.value = lastComposerText; document.getElementById("agent-composer-send")?.click(); }
      }},
    ];
    const ws = window.QuillModules.workspaces.activeWs();
    (ws?.paneIds || []).forEach((pid, i) => {
      const persona = S().state.panes[pid]?.persona || `Pane ${i + 1}`;
      cmds.push({
        id: `focus-${pid}`,
        label: `> Focus pane ${i + 1} (${persona})`,
        run: () => window.QuillModules.terminals.focusPane(pid),
      });
    });
    S().state.workspaces.forEach((w) => {
      cmds.push({
        id: `ws-${w.id}`,
        label: `# Switch workspace: ${w.name}`,
        run: () => window.QuillModules.workspaces.switchWorkspace(w.id),
      });
    });
    return cmds;
  }

  function openPalette() {
    document.getElementById("palette").classList.remove("hidden");
    const input = document.getElementById("palette-input");
    input.value = "";
    input.focus();
    renderPalette("");
    input.oninput = () => {
      clearTimeout(S().paletteSearchTimer);
      S().paletteSearchTimer = setTimeout(() => renderPalette(input.value), 120);
    };
  }

  function closePalette() {
    document.getElementById("palette").classList.add("hidden");
  }

  function pushCat(items, cat, rows) {
    if (!rows.length) return;
    items.push({ id: `__cat-${cat}`, header: cat, run: null });
    items.push(...rows);
  }

  async function renderPalette(q) {
    const list = document.getElementById("palette-list");
    const raw = q.trim();
    const lead = raw.charAt(0);
    const body = [">", "@", "#", ":"].includes(lead) ? raw.slice(1).trim() : raw;
    const ql = body.toLowerCase();
    const items = [];

    const allCmds = getCommands();
    const cmdRows = allCmds
      .filter((c) => c.label.startsWith(">"))
      .filter((c) => !ql || c.label.toLowerCase().includes(ql))
      .map((c) => ({ id: c.id, label: c.label.replace(/^>\s*/, ""), run: c.run, kind: "command" }));

    const wsRows = allCmds
      .filter((c) => c.label.startsWith("#"))
      .filter((c) => !ql || c.label.toLowerCase().includes(ql))
      .map((c) => ({ id: c.id, label: c.label.replace(/^#\s*/, ""), run: c.run, kind: "workspace" }));

    if (!raw || lead === ">") pushCat(items, "Commands", cmdRows);
    if (!raw || lead === "#") pushCat(items, "Workspaces", wsRows);

    if (lead === ":") {
      const line = parseInt(body, 10);
      if (line > 0) {
        items.push({
          id: `goto-${line}`,
          label: `Go to line ${line}`,
          kind: "goto",
          run: () => S().monacoEditor?.revealLineInCenter(line),
        });
      } else {
        pushCat(items, "Go to line", [{ id: "goto-hint", label: "Type :42 to jump to line 42", run: null, kind: "hint" }]);
      }
    }

    if ((lead === "@" || (!["#", ":"].includes(lead) && ql.length >= 2)) && lead !== ">") {
      const symItems = [];
      const ws = window.QuillModules.workspaces.activeWs();
      const editorPath = S().editorFilePath;
      if (lead === "@" && editorPath) {
        const symRes = await window.quill.listSymbols({ filePath: editorPath });
        for (const s of (symRes.symbols || []).filter((s) => s.name.toLowerCase().includes(ql))) {
          symItems.push({
            id: `sym-${s.name}`,
            label: `@${s.name} (line ${s.line})`,
            kind: "symbol",
            run: () => S().monacoEditor?.revealLineInCenter(s.line),
          });
        }
      }
      if (ws?.cwd && ql.length >= 2) {
        const res = await window.quill.searchFiles({ cwd: ws.cwd, query: ql, limit: 12 });
        for (const f of res.files || []) {
          symItems.push({
            id: `file-${f.path}`,
            label: lead === "@" ? `@${f.rel}` : f.rel,
            kind: "file",
            run: () => window.QuillModules.editor.openFileInEditor(f.path),
          });
        }
      }
      pushCat(items, lead === "@" ? "Symbols & files" : "Files", symItems);
    }

    if (window.QuillFeatures && ql.length >= 2 && !["#", ":"].includes(lead)) {
      await window.QuillFeatures.extendPalette(items, ql);
    }

    S().paletteItems = items.filter((i) => i.run);
    const clickable = items.filter((i) => i.run);
    let activeIdx = 0;
    list.innerHTML = items.map((item) => {
      if (item.header) return `<li class="palette-cat">${escHtml(item.header)}</li>`;
      const idx = item.run ? activeIdx++ : -1;
      const cls = idx === 0 ? "active" : "";
      return `<li data-id="${escHtml(item.id)}" class="${cls}" data-kind="${item.kind || "command"}">${escHtml(item.label)}</li>`;
    }).join("");
    list.querySelectorAll("li[data-id]").forEach((li) => {
      if (!S().paletteItems.find((c) => c.id === li.dataset.id)) return;
      li.onclick = () => {
        S().paletteItems.find((c) => c.id === li.dataset.id)?.run();
        closePalette();
      };
    });
  }

  window.QuillModules.palette = {
    getCommands,
    openPalette,
    closePalette,
    renderPalette,
    setLastComposerText,
  };
})();
