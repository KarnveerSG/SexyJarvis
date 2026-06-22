/** Quill desktop phases 2–6: tabs, tool cards, search, gutter, onboarding, keybindings */

const QuillFeatures = (() => {
  const openTabs = new Map();
  let activeTabPath = null;
  let gitFileStatus = {};
  let gutterDecoIds = [];
  let pendingEditPath = null;
  let customKeybindings = {};
  let deps = null;
  const seenToolCards = new Set();
  const seenAgentReplies = new Set();

  function stripStream(raw) {
    return window.QuillAgentStream?.stripAnsi(raw) ?? String(raw || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  async function monacoVsBase() {
    try {
      const r = await fetch("./vendor/monaco/vs/loader.js", { method: "HEAD" });
      if (r.ok) return "./vendor/monaco/vs";
    } catch (_) {}
    return "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";
  }

  function renderTabs() {
    const row = document.getElementById("editor-tabs-row");
    if (!row) return;
    row.innerHTML = "";
    for (const [path, tab] of openTabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `file-tab${path === activeTabPath ? " active" : ""}`;
      btn.dataset.path = path;
      const name = path.split(/[/\\]/).pop() || path;
      btn.innerHTML = `<span>${esc(name)}</span>${tab.dirty ? '<span class="editor-dirty">●</span>' : ""}<span class="tab-close" title="Close">×</span>`;
      btn.onclick = (e) => {
        if (e.target.classList.contains("tab-close")) { void closeTab(path); return; }
        void switchTab(path);
      };
      row.appendChild(btn);
    }
  }

  async function switchTab(filePath) {
    if (!deps) return;
    if (activeTabPath && deps.getEditor() && openTabs.has(activeTabPath)) {
      openTabs.get(activeTabPath).content = deps.getEditor().getValue();
    }
    activeTabPath = filePath;
    deps.setEditorPath(filePath);
    const tab = openTabs.get(filePath);
    if (!tab) return;
    await deps.ensureMonaco();
    const ed = deps.getEditor();
    if (!ed) return;
    document.getElementById("editor-area")?.classList.remove("hidden");
    ed.setModel(monaco.editor.createModel(tab.content, deps.guessLang(filePath)));
    deps.setDirty(tab.dirty);
    deps.updateDirtyUI();
    deps.updateTitlebar();
    renderTabs();
    document.querySelectorAll(".tree-item.tree-file").forEach((el) => {
      el.classList.toggle("selected", el.dataset.path === filePath);
    });
    const fs = document.getElementById("status-file");
    if (fs) fs.textContent = filePath;
    await applyGutterDecorations(filePath);
    await deps.setEditorTab("file");
  }

  async function openTab(filePath) {
    if (!openTabs.has(filePath)) {
      const res = await window.quill.readFile(filePath);
      if (!res.ok) { deps.showToast(res.error || "Cannot open"); return; }
      openTabs.set(filePath, { content: res.content, dirty: false });
    }
    await switchTab(filePath);
    renderTabs();
  }

  async function closeTab(filePath) {
    openTabs.delete(filePath);
    if (activeTabPath === filePath) {
      const next = openTabs.keys().next().value;
      if (next) await switchTab(next);
      else deps.closeEditor();
      activeTabPath = next || null;
    }
    renderTabs();
  }

  function markDirty() {
    if (!activeTabPath || !openTabs.has(activeTabPath)) return;
    openTabs.get(activeTabPath).dirty = true;
    deps.setDirty(true);
    renderTabs();
  }

  function markSaved() {
    if (!activeTabPath || !openTabs.has(activeTabPath)) return;
    const tab = openTabs.get(activeTabPath);
    tab.dirty = false;
    tab.content = deps.getEditor()?.getValue() ?? tab.content;
    deps.setDirty(false);
    renderTabs();
  }

  function onEditorContentChange() {
    markDirty();
  }

  async function refreshGitFileStatus() {
    const ws = deps.activeWs();
    if (!ws?.cwd) { gitFileStatus = {}; return; }
    const res = await window.quill.gitStatusFiles(ws.cwd);
    gitFileStatus = {};
    if (res.ok) {
      for (const f of res.files) gitFileStatus[f.absPath] = f.status;
    }
    updateScmBadge(res.files?.length || 0);
  }

  function updateScmBadge(count) {
    const badge = document.getElementById("scm-badge");
    if (!badge) return;
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.toggle("hidden", count === 0);
  }

  function treeGitBadge(path) {
    const st = gitFileStatus[path];
    if (!st) return "";
    return `<span class="tree-git tree-git-${st}">${esc(st)}</span>`;
  }

  async function applyGutterDecorations(filePath) {
    const ed = deps.getEditor();
    if (!ed || !window.monaco) return;
    const ws = deps.activeWs();
    const res = await window.quill.gitFileGutter({ cwd: ws?.cwd, filePath });
    gutterDecoIds = ed.deltaDecorations(gutterDecoIds, (res.lines || []).map((l) => ({
      range: new monaco.Range(l.line, 1, l.line, 1),
      options: {
        isWholeLine: true,
        className: l.type === "add" ? "gutter-add" : "gutter-del",
        glyphMarginClassName: l.type === "add" ? "glyph-add" : "glyph-del",
        glyphMargin: true,
      },
    })));
  }

  function appendToolCard(name, detail) {
    const key = `${name}:${detail}`;
    if (seenToolCards.has(key)) return;
    seenToolCards.add(key);
    if (seenToolCards.size > 200) {
      const first = seenToolCards.values().next().value;
      seenToolCards.delete(first);
    }
    const box = document.getElementById("agent-chat");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "tool-card";
    const icons = { read_file: "📄", write_file: "✎", edit_file: "✎", bash: "▶", grep: "⌕", glob: "◫" };
    el.innerHTML = `<span class="tool-icon">${icons[name] || "⚙"}</span><div><strong>${esc(name)}</strong><p>${esc(detail)}</p></div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function appendAgentReply(text) {
    const body = String(text || "").trim();
    if (!body || seenAgentReplies.has(body)) return;
    seenAgentReplies.add(body);
    if (seenAgentReplies.size > 100) {
      const first = seenAgentReplies.values().next().value;
      seenAgentReplies.delete(first);
    }
    const box = document.getElementById("agent-chat");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "chat-msg agent";
    el.textContent = body;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function parseQuillReplies(clean) {
    const re = /\[QUILL_REPLY:([^\]\r\n]+)\]/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
      try {
        appendAgentReply(JSON.parse(m[1]));
      } catch (_) {
        appendAgentReply(m[1]);
      }
    }
  }

  function parseAgentStream(raw) {
    if (window.QuillCowork) {
      window.QuillCowork.parseStream(raw);
    }
    const clean = stripStream(raw);
    parseQuillReplies(clean);
    const toolRe = /\[QUILL_TOOL:([^:\]]+):([^\]\r\n]*)\]/g;
    let m;
    while ((m = toolRe.exec(clean)) !== null) appendToolCard(m[1], m[2]);
  }

  function showInlineDiffBar(filePath) {
    pendingEditPath = filePath;
    const bar = document.getElementById("inline-diff-bar");
    if (!bar) return;
    bar.classList.remove("hidden");
    bar.querySelector(".inline-diff-path").textContent = filePath.split(/[/\\]/).pop() || filePath;
    if (deps.getEditorPath() && deps.pathsEqual(filePath, deps.getEditorPath())) {
      void deps.refreshEditor(false);
      void applyGutterDecorations(filePath);
    }
  }

  async function acceptEdit() {
    const p = pendingEditPath || deps.getEditorPath();
    window.QuillCowork?.clearPending(p);
    pendingEditPath = null;
    document.getElementById("inline-diff-bar")?.classList.add("hidden");
    await deps.refreshGit();
    deps.showToast("Changes kept");
  }

  async function rejectEdit() {
    const p = pendingEditPath || deps.getEditorPath();
    if (!p) return;
    const ws = deps.activeWs();
    const res = await window.quill.gitRevertFile({ cwd: ws?.cwd, filePath: p });
    window.QuillCowork?.clearPending(p);
    pendingEditPath = null;
    document.getElementById("inline-diff-bar")?.classList.add("hidden");
    if (res.ok) {
      await deps.refreshEditor(false);
      await deps.refreshGit();
      deps.showToast("Reverted file");
    } else deps.showToast(res.error || "Revert failed");
  }

  function bindInlineDiff() {
    document.getElementById("diff-accept")?.addEventListener("click", () => void acceptEdit());
    document.getElementById("diff-reject")?.addEventListener("click", () => void rejectEdit());
  }

  function bindGlobalSearch() {
    const modal = document.getElementById("global-search");
    const input = document.getElementById("global-search-input");
    const list = document.getElementById("global-search-results");
    if (!modal || !input || !list) return;
    let timer = null;
    const open = () => {
      modal.classList.remove("hidden");
      input.value = "";
      input.focus();
      list.innerHTML = "";
    };
    const close = () => modal.classList.add("hidden");
    document.getElementById("global-search-close")?.addEventListener("click", close);
    input.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { list.innerHTML = ""; return; }
        const ws = deps.activeWs();
        const res = await window.quill.searchContent({ cwd: ws?.cwd, query: q, limit: 60 });
        list.innerHTML = (res.matches || []).map((m) =>
          `<li data-path="${esc(m.path)}" data-line="${m.line}"><span class="gs-path">${esc(m.path.split(/[/\\]/).pop())}:${m.line}</span><span class="gs-text">${esc(m.text)}</span></li>`
        ).join("");
        list.querySelectorAll("li").forEach((li) => {
          li.onclick = async () => {
            await openTab(li.dataset.path);
            close();
            const ed = deps.getEditor();
            if (ed) ed.revealLineInCenter(Number(li.dataset.line));
          };
        });
      }, 200);
    };
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === "F") { e.preventDefault(); open(); }
      if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
    });
    return { open, close };
  }

  async function loadKeybindings() {
    const res = await window.quill.getKeybindings();
    customKeybindings = res.bindings || {};
  }

  function bindKeybindings() {
    document.addEventListener("keydown", (e) => {
      for (const [combo, action] of Object.entries(customKeybindings)) {
        if (!matchCombo(e, combo)) continue;
        e.preventDefault();
        runKeyAction(action);
      }
    });
  }

  function matchCombo(e, combo) {
    const parts = combo.toLowerCase().split("+");
    const key = parts.pop();
    if (parts.includes("ctrl") !== (e.ctrlKey || e.metaKey)) return false;
    if (parts.includes("shift") !== e.shiftKey) return false;
    if (parts.includes("alt") !== e.altKey) return false;
    return e.key.toLowerCase() === key || e.code.toLowerCase() === `key${key}`;
  }

  function runKeyAction(action) {
    const map = {
      "open-palette": () => deps.openPalette(),
      "global-search": () => document.getElementById("global-search")?.classList.remove("hidden"),
      "toggle-terminal": () => deps.toggleTerminal(),
      "focus-agent": () => document.getElementById("agent-composer-input")?.focus(),
      "save-file": () => void deps.saveEditor(),
    };
    map[action]?.();
  }

  async function renderKeybindingsSettings(container) {
    const defaults = [
      { combo: "ctrl+p", action: "open-palette", label: "Command palette" },
      { combo: "ctrl+shift+f", action: "global-search", label: "Search in files" },
      { combo: "ctrl+`", action: "toggle-terminal", label: "Toggle terminal" },
      { combo: "ctrl+l", action: "focus-agent", label: "Focus agent" },
      { combo: "ctrl+s", action: "save-file", label: "Save file" },
    ];
    const merged = { ...Object.fromEntries(defaults.map((d) => [d.combo, d.action])), ...customKeybindings };
    container.innerHTML = `<div class="settings-page"><h3>Keyboard shortcuts</h3>
      <p class="settings-sub">Overrides saved to <code>~/.quill/keybindings.json</code></p>
      <div id="kb-list"></div>
      <button type="button" class="btn-primary" id="kb-save">Save overrides</button></div>`;
    const list = container.querySelector("#kb-list");
    list.innerHTML = defaults.map((d) => {
      const val = merged[d.combo] || d.action;
      return `<label class="field-row"><span>${esc(d.label)}</span>
        <input type="text" data-kb-combo="${esc(d.combo)}" value="${esc(val)}" /></label>`;
    }).join("");
    container.querySelector("#kb-save").onclick = async () => {
      const bindings = {};
      list.querySelectorAll("[data-kb-combo]").forEach((inp) => {
        const def = defaults.find((d) => d.combo === inp.dataset.kbCombo)?.action;
        if (inp.value.trim() && inp.value.trim() !== def) bindings[inp.dataset.kbCombo] = inp.value.trim();
      });
      await window.quill.saveKeybindings(bindings);
      customKeybindings = bindings;
      deps.showToast("Keybindings saved");
    };
  }

  function registerLspProviders() {
    if (!window.monaco || deps._lspRegistered) return;
    deps._lspRegistered = true;
    const langs = ["javascript", "typescript", "python"];
    for (const lang of langs) {
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: [".", "@"],
        provideCompletionItems: async (model, position) => {
          const ws = deps.activeWs();
          if (!ws?.cwd) return { suggestions: [] };
          const sym = await window.quill.listSymbols({ filePath: model.uri.path.replace(/^\//, "") });
          const fileSyms = (sym.symbols || []).map((s) => ({
            label: s.name,
            kind: s.kind === "class" ? monaco.languages.CompletionItemKind.Class : monaco.languages.CompletionItemKind.Function,
            insertText: s.name,
            range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
          }));
          return { suggestions: fileSyms.slice(0, 40) };
        },
      });
      monaco.languages.registerHoverProvider(lang, {
        provideHover: async (model, position) => {
          const sym = await window.quill.listSymbols({ filePath: deps.getEditorPath() || "" });
          const line = position.lineNumber;
          const hit = (sym.symbols || []).find((s) => s.line === line);
          if (!hit) return null;
          return { contents: [{ value: `**${hit.name}** (${hit.kind})` }] };
        },
      });
    }
  }

  function bindSplitEditor() {
    document.getElementById("editor-split")?.addEventListener("click", () => {
      deps.showToast("Split editor: drag tabs (coming in next release)");
    });
  }

  async function checkOnboarding() {
    if (localStorage.getItem("quill-onboarded")) return;
    const ws = deps.activeWs();
    if (ws?.named) { localStorage.setItem("quill-onboarded", "1"); return; }
    const modal = document.getElementById("onboarding");
    if (!modal) return;
    modal.classList.remove("hidden");
    document.getElementById("onboard-open")?.addEventListener("click", async () => {
      modal.classList.add("hidden");
      localStorage.setItem("quill-onboarded", "1");
      await deps.openFolder();
    });
    document.getElementById("onboard-skip")?.addEventListener("click", () => {
      modal.classList.add("hidden");
      localStorage.setItem("quill-onboarded", "1");
    });
  }

  async function checkAutoUpdate() {
    try {
      const res = await window.quill.checkForUpdates();
      if (res.updateAvailable) {
        let banner = document.getElementById("update-banner");
        if (!banner) {
          banner = document.createElement("div");
          banner.id = "update-banner";
          banner.className = "update-banner";
          document.body.appendChild(banner);
        }
        banner.innerHTML = `Update ${esc(res.latest)} available <button type="button" id="update-open">View release</button><button type="button" id="update-dismiss">×</button>`;
        banner.querySelector("#update-open")?.addEventListener("click", () => {
          if (res.url) window.quill.openExternal(res.url);
        });
        banner.querySelector("#update-dismiss")?.addEventListener("click", () => banner.remove());
      }
    } catch (_) {}
  }

  function renderExtensionsSettings(container) {
    container.innerHTML = `<div class="settings-page">
      <h3>Extensions</h3>
      <p class="badge-soon">Preview</p>
      <p class="settings-sub">WASM extension host for custom tools and themes. Enable CodeGraph MCP for deep code intelligence today.</p>
      <button type="button" class="btn-secondary" id="ext-codegraph">Open CodeGraph docs</button>
    </div>`;
    container.querySelector("#ext-codegraph")?.addEventListener("click", () => {
      window.quill.openExternal("https://github.com/KarnveerSG/Quill#codegraph");
    });
  }

  async function extendPalette(items, ql) {
    const ws = deps.activeWs();
    if (!ws?.cwd || ql.length < 2) return items;
    const editorPath = deps.getEditorPath();
    const symRes = editorPath
      ? await window.quill.listSymbols({ filePath: editorPath })
      : { symbols: [] };
    const contentRes = await window.quill.searchContent({ cwd: ws.cwd, query: ql, limit: 8 });
    for (const s of (symRes.symbols || []).filter((s) => s.name.toLowerCase().includes(ql))) {
      items.push({ id: `sym-${s.name}`, label: `Symbol: ${s.name}`, kind: "symbol", run: async () => {
        if (deps.getEditorPath()) deps.getEditor()?.revealLineInCenter(s.line);
      }});
    }
    for (const m of contentRes.matches || []) {
      items.push({
        id: `content-${m.path}-${m.line}`,
        label: `${m.path.split(/[/\\]/).pop()}:${m.line} — ${m.text.slice(0, 40)}`,
        kind: "content",
        run: async () => { await openTab(m.path); deps.getEditor()?.revealLineInCenter(m.line); },
      });
    }
    return items;
  }

  function pathJoin(a, b) {
    return `${a.replace(/\\/g, "/").replace(/\/$/, "")}/${b}`.replace(/\/+/g, "/");
  }

  async function syncWorkspace() {
    await window.quill.exportWorkspaceSync(deps.getState());
    deps.showToast("Workspace synced locally");
  }

  function bindMcpToggles(root) {
    root?.querySelectorAll("[data-mcp-enabled]").forEach((cb) => {
      cb.onchange = () => {
        const name = cb.dataset.mcpEnabled;
        if (mcpDraftRef?.servers?.[name]) mcpDraftRef.servers[name].enabled = cb.checked;
      };
    });
  }

  let mcpDraftRef = null;
  function setMcpDraftRef(draft) { mcpDraftRef = draft; }

  function lazyTreeLimit(depth) {
    return depth > 8;
  }

  function init(hooks) {
    deps = hooks;
    bindInlineDiff();
    bindGlobalSearch();
    void loadKeybindings().then(() => bindKeybindings());
    bindSplitEditor();
    void checkOnboarding();
    void checkAutoUpdate();
    void refreshGitFileStatus();
  }

  return {
    init,
    monacoVsBase,
    openTab,
    closeTab,
    switchTab,
    renderTabs,
    markSaved,
    onEditorContentChange,
    refreshGitFileStatus,
    treeGitBadge,
    parseAgentStream,
    applyGutterDecorations,
    extendPalette,
    renderKeybindingsSettings,
    renderExtensionsSettings,
    registerLspProviders,
    setMcpDraftRef,
    bindMcpToggles,
    lazyTreeLimit,
    syncWorkspace,
    getOpenTabs: () => openTabs,
    getActiveTab: () => activeTabPath,
    showInlineDiffBar,
  };
})();

window.QuillFeatures = QuillFeatures;
