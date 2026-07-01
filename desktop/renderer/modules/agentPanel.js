/** Agent chat panel, composer, panel mode */
window.QuillModules = window.QuillModules || {};

(() => {
  const S = () => window.QuillModules.state;
  const { escHtml, stripAnsi, cleanTerminalLine } = window.QuillModules.util;

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
    for (const banner of S().AGENT_DEDUPE_BANNERS) {
      if (key === banner || key.startsWith(banner)) return true;
    }
    return /^code beautiful$/i.test(key);
  }

  function rememberAgentChatLine(line) {
    S().agentSeenChatLines.add(line);
    if (S().agentSeenChatLines.size > S().AGENT_DEDUPE_MAX) {
      const first = S().agentSeenChatLines.values().next().value;
      S().agentSeenChatLines.delete(first);
    }
  }

  function isDuplicateAgentChatLine(line) {
    if (shouldDedupeBannerLine(line)) return true;
    if (S().agentSeenChatLines.has(line)) return true;
    rememberAgentChatLine(line);
    return false;
  }

  function shouldStreamPtyToAgentChat() {
    return S().agentPtyToChat && S().agentPanelMode !== "closed";
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
    S().agentChatLineBuffer += stripAnsi(raw);
    clearTimeout(S().agentChatFlushTimer);
    S().agentChatFlushTimer = setTimeout(flushAgentStreamBuffer, 450);
  }

  function flushAgentStreamBuffer() {
    const lines = S().agentChatLineBuffer.split("\n").map(cleanTerminalLine).filter(Boolean);
    S().agentChatLineBuffer = "";
    const filtered = lines.filter((l) => {
      if (/\[QUILL_(TOOL|EDIT|TASK|BROWSER|REPLY):/.test(l)) return false;
      if (isDuplicateAgentChatLine(l)) return false;
      return S().agentPtyToChat ? !isTerminalNoise(l) : isAgentReplyLine(l);
    });
    const chunk = filtered.slice(-4).join("\n");
    if (chunk.length > 2) appendAgentChat("agent", chunk);
  }

  window.QuillAgentStream = { stripAnsi, cleanTerminalLine, isTerminalNoise };

  function saveAgentChat(wsId) {
    if (!wsId) return;
    const box = document.getElementById("agent-chat");
    if (!box) return;
    S().wsChats[wsId] = [...box.querySelectorAll(".chat-msg")].map((el) => ({
      role: [...el.classList].find((c) => c !== "chat-msg") || "agent",
      text: el.textContent || "",
    }));
  }

  function restoreAgentChat(wsId) {
    const box = document.getElementById("agent-chat");
    if (!box) return;
    box.innerHTML = "";
    const msgs = S().wsChats[wsId] || [];
    if (!msgs.length) {
      const ws = S().state.workspaces.find((w) => w.id === wsId);
      appendAgentChat("system", `${ws?.name || "Workspace"} — isolated agent (other workspaces can't see this chat).`);
    } else {
      msgs.forEach((m) => appendAgentChat(m.role, m.text));
    }
  }

  function setAgentPanelMode(mode, { persist: doPersist = true } = {}) {
    S().agentPanelMode = mode;
    S().state.agentPanelMode = mode;
    const panel = document.getElementById("agent-panel");
    const closed = mode === "closed";
    const minimized = mode === "minimized";
    panel?.classList.toggle("hidden", closed);
    panel?.classList.toggle("minimized", minimized);
    document.body.classList.toggle("agent-hidden", closed);
    document.querySelector('.activity-btn[data-panel="agent"]')
      ?.classList.toggle("active", !closed);
    if (doPersist) window.QuillModules.workspaces.persist();
    setTimeout(() => window.QuillModules.terminals.fitActiveTerminals(), 120);
  }

  function toggleAgentPanel() {
    if (S().agentPanelMode === "closed") setAgentPanelMode("open");
    else setAgentPanelMode("closed");
  }

  function setAgentPanelOpen(open) {
    setAgentPanelMode(open ? "open" : "closed");
  }

  function updateAgentComposerState() {
    const wrap = document.querySelector(".agent-composer-wrap");
    const ws = window.QuillModules.workspaces.agentPanelWs();
    wrap?.classList.toggle("agent-disabled", Boolean(ws?.agentStopped));
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
      S().agentPtyToChat = !S().agentPtyToChat;
      btn.classList.toggle("active", S().agentPtyToChat);
      btn.setAttribute("aria-pressed", S().agentPtyToChat ? "true" : "false");
    };
    actions.prepend(btn);
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
    const ws = window.QuillModules.workspaces.agentPanelWs();
    const paneId = getAgentDelegatePaneId(ws);
    if (!sel || !paneId) return;
    const meta = S().state.panes[paneId] || { persona: S().DEFAULT_PERSONA };
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
    const ws = window.QuillModules.workspaces.agentPanelWs();
    S().primaryPaneId = getAgentDelegatePaneId(ws) || ws?.paneIds?.[0] || S().primaryPaneId;
    const t = S().primaryPaneId ? S().termInstances.get(S().primaryPaneId) : null;
    if (!input || !send || !t) return;

    let mentionMenu = null;
    let mentionAt = -1;
    const hideMentionMenu = () => { mentionMenu?.remove(); mentionMenu = null; mentionAt = -1; };

    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      hideMentionMenu();
      appendAgentChat("user", text);
      window.QuillModules.palette?.setLastComposerText?.(text);
      let ptyId = t.ptyId;
      let paneId = S().primaryPaneId;
      if (window.QuillCowork) {
        const target = await window.QuillCowork.resolveDelegateTarget();
        if (target && typeof target === "object") {
          ptyId = target.ptyId || ptyId;
          paneId = target.paneId || paneId;
        } else if (typeof target === "string") {
          ptyId = target;
        }
      }
      const body = window.QuillMultiAgent?.formatComposerWrite?.(text, paneId) ?? text;
      window.quill.ptyWrite(ptyId, `${body}\r`);
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
        const ws = window.QuillModules.workspaces.agentPanelWs();
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

  async function openHistoryBrowser() {
    const modal = document.getElementById("history-modal");
    const body = document.getElementById("history-modal-body");
    if (!modal || !body) return;
    const wsId = S().state.agentPanelWorkspaceId || S().state.activeWorkspace;
    const ws = S().state.workspaces.find((w) => w.id === wsId);
    const res = await window.quill.historyList?.(wsId) || { items: [] };
    const rows = (res.items || []).map((it) => `
      <div class="skill-row" style="align-items:flex-start">
        <div style="flex:1">
          <div><strong>${escHtml(it.title || `Snapshot ${it.id}`)}</strong></div>
          <div class="settings-sub">${new Date(it.ts).toLocaleString()} · ${it.count} message${it.count === 1 ? "" : "s"}</div>
        </div>
        <button type="button" class="btn-secondary" data-h-load="${escHtml(it.id)}">Restore</button>
        <button type="button" class="btn-secondary" data-h-del="${escHtml(it.id)}">Delete</button>
      </div>`).join("");
    body.innerHTML = `
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
        <span class="settings-sub" style="flex:1">Workspace: <strong>${escHtml(ws?.name || "?")}</strong></span>
        <button type="button" class="btn-primary" id="history-save-current">Save current chat</button>
      </div>
      ${rows || `<p class="settings-sub">No saved snapshots.</p>`}`;
    modal.classList.remove("hidden");
    document.getElementById("history-save-current").onclick = async () => {
      saveAgentChat(wsId);
      const messages = S().wsChats[wsId] || [];
      if (!messages.length) { window.QuillModules.util.showToast("Nothing to save"); return; }
      const title = messages.find((m) => m.role === "user")?.text?.slice(0, 60) || "Snapshot";
      await window.quill.historySave?.({ wsId, snapshot: { ts: Date.now(), title, messages } });
      openHistoryBrowser();
    };
    body.querySelectorAll("[data-h-load]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.hLoad;
        const r = await window.quill.historyLoad?.({ wsId, id });
        if (!r?.ok) { window.QuillModules.util.showToast(r?.error || "Load failed"); return; }
        saveAgentChat(wsId);
        S().wsChats[wsId] = r.snapshot.messages || [];
        restoreAgentChat(wsId);
        modal.classList.add("hidden");
        window.QuillModules.util.showToast("Restored");
      };
    });
    body.querySelectorAll("[data-h-del]").forEach((btn) => {
      btn.onclick = async () => {
        await window.quill.historyDelete?.({ wsId, id: btn.dataset.hDel });
        openHistoryBrowser();
      };
    });
  }
  function bindHistoryBrowser() {
    document.getElementById("agent-history-btn")?.addEventListener("click", openHistoryBrowser);
    document.getElementById("history-modal-close")?.addEventListener("click", () => document.getElementById("history-modal")?.classList.add("hidden"));
    document.getElementById("history-modal")?.addEventListener("click", (e) => {
      if (e.target?.id === "history-modal") e.currentTarget.classList.add("hidden");
    });
  }

  let promptsCache = null;
  async function loadPrompts() {
    if (promptsCache) return promptsCache;
    try {
      const res = await window.quill.getPrompts?.();
      promptsCache = Array.isArray(res?.prompts) ? res.prompts : [];
    } catch { promptsCache = []; }
    return promptsCache;
  }
  async function savePrompts(list) {
    promptsCache = list;
    try { await window.quill.savePrompts?.(list); } catch (_) {}
  }
  async function openPromptLibrary() {
    const modal = document.getElementById("prompts-modal");
    const body = document.getElementById("prompts-modal-body");
    if (!modal || !body) return;
    const prompts = await loadPrompts();
    const input = document.getElementById("agent-composer-input");
    const rows = prompts.length ? prompts.map((p, i) => `
      <div class="skill-row" style="align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div><strong>${escHtml(p.title || "(untitled)")}</strong></div>
          <div class="settings-sub" style="white-space:pre-wrap">${escHtml(p.body || "")}</div>
        </div>
        <button type="button" class="btn-secondary" data-prompt-insert="${i}">Insert</button>
        <button type="button" class="btn-secondary" data-prompt-delete="${i}">Delete</button>
      </div>`).join("") : `<p class="settings-sub">No prompts saved yet.</p>`;
    body.innerHTML = `
      <div style="margin-bottom:12px">
        <input type="text" id="prompt-new-title" placeholder="Title" style="width:100%;padding:6px;margin-bottom:6px" />
        <textarea id="prompt-new-body" placeholder="Prompt body — use {{selection}} or {{file}} placeholders" rows="3" style="width:100%;padding:6px"></textarea>
        <button type="button" class="btn-primary" id="prompt-save-btn" style="margin-top:6px">Save prompt</button>
      </div>
      <div>${rows}</div>`;
    modal.classList.remove("hidden");
    document.getElementById("prompt-save-btn").onclick = async () => {
      const title = document.getElementById("prompt-new-title").value.trim();
      const bodyText = document.getElementById("prompt-new-body").value.trim();
      if (!title || !bodyText) return;
      const list = [...await loadPrompts(), { title, body: bodyText }];
      await savePrompts(list);
      openPromptLibrary();
    };
    body.querySelectorAll("[data-prompt-insert]").forEach((btn) => {
      btn.onclick = async () => {
        const i = Number(btn.dataset.promptInsert);
        const list = await loadPrompts();
        const p = list[i];
        if (!p || !input) return;
        const ws = window.QuillModules.workspaces.agentPanelWs();
        const filePath = S().editorFilePath ? S().editorFilePath.replace(ws?.cwd || "", "").replace(/^[/\\]+/, "") : "";
        const body = String(p.body || "").replace(/\{\{file\}\}/g, filePath || "(no file)");
        input.value = (input.value ? input.value + "\n" : "") + body;
        input.focus();
        modal.classList.add("hidden");
      };
    });
    body.querySelectorAll("[data-prompt-delete]").forEach((btn) => {
      btn.onclick = async () => {
        const i = Number(btn.dataset.promptDelete);
        const list = await loadPrompts();
        list.splice(i, 1);
        await savePrompts(list);
        openPromptLibrary();
      };
    });
  }
  function bindPromptLibrary() {
    document.getElementById("prompt-library-btn")?.addEventListener("click", openPromptLibrary);
    document.getElementById("prompts-modal-close")?.addEventListener("click", () => document.getElementById("prompts-modal")?.classList.add("hidden"));
    document.getElementById("prompts-modal")?.addEventListener("click", (e) => {
      if (e.target?.id === "prompts-modal") e.currentTarget.classList.add("hidden");
    });
  }

  function renderAgentPanelWorkspaceSelect() {
    const sel = document.getElementById("agent-ws-select");
    if (!sel) return;
    const cur = S().state.agentPanelWorkspaceId || S().state.activeWorkspace;
    sel.innerHTML = S().state.workspaces.map((ws) =>
      `<option value="${escHtml(ws.id)}"${ws.id === cur ? " selected" : ""}>${escHtml(ws.name)}</option>`
    ).join("");
  }

  function bindAgentPanelWorkspaceSelect() {
    const sel = document.getElementById("agent-ws-select");
    if (!sel || sel._bound) return;
    sel._bound = true;
    sel.onchange = () => {
      const id = sel.value;
      if (id === S().state.agentPanelWorkspaceId) return;
      saveAgentChat(S().state.agentPanelWorkspaceId);
      S().state.agentPanelWorkspaceId = id;
      window.QuillModules.workspaces.persist();
      restoreAgentChat(id);
      populateAgentPersona();
      bindGlobalComposer();
      window.QuillCowork?.populateDelegateSelect();
    };
  }

  window.QuillModules.agentPanel = {
    isTerminalNoise,
    isAgentReplyLine,
    shouldStreamPtyToAgentChat,
    appendAgentChat,
    appendAgentStream,
    flushAgentStreamBuffer,
    saveAgentChat,
    restoreAgentChat,
    setAgentPanelMode,
    toggleAgentPanel,
    setAgentPanelOpen,
    updateAgentComposerState,
    bindAgentStreamToggle,
    getAgentDelegatePaneId,
    populateAgentPersona,
    bindGlobalComposer,
    bindPromptLibrary,
    bindHistoryBrowser,
    renderAgentPanelWorkspaceSelect,
    bindAgentPanelWorkspaceSelect,
  };
})();
