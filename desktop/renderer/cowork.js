/** Claude Cowork parity — task plan, batch review, browser, delegation */

const QuillCowork = (() => {
  let deps = null;
  const pendingEdits = new Map();
  let taskItems = [];

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function renderTaskPlan() {
    const panel = document.getElementById("agent-plan");
    const list = document.getElementById("agent-plan-list");
    if (!panel || !list) return;
    if (!taskItems.length) {
      panel.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    panel.classList.remove("hidden");
    const icons = { pending: "○", in_progress: "◐", done: "●" };
    list.innerHTML = taskItems.map((t, i) =>
      `<li class="plan-item plan-${esc(t.status || "pending")}" data-idx="${i + 1}">
        <span class="plan-icon">${icons[t.status] || "○"}</span>
        <span class="plan-text">${esc(t.text)}</span>
      </li>`
    ).join("");
  }

  function ingestTasks(jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        taskItems = parsed;
        renderTaskPlan();
      }
    } catch (_) {}
  }

  function parseMarkdownPlan(text) {
    const lines = String(text || "").split("\n");
    let inPlan = false;
    const found = [];
    for (const line of lines) {
      if (/^##\s+plan/i.test(line.trim())) { inPlan = true; continue; }
      if (inPlan && /^##\s+/.test(line.trim())) break;
      const m = line.match(/^\s*[-*]\s+\[([ x~X])\]\s+(.+)/);
      if (m) {
        const st = m[1].toLowerCase() === "x" ? "done" : m[1] === "~" ? "in_progress" : "pending";
        found.push({ text: m[2].trim(), status: st });
      } else if (inPlan && /^\s*\d+\.\s+(.+)/.test(line)) {
        found.push({ text: line.replace(/^\s*\d+\.\s+/, "").trim(), status: "pending" });
      }
    }
    if (found.length) {
      taskItems = found;
      renderTaskPlan();
    }
  }

  function queueEdit(filePath) {
    const resolved = deps.resolvePath(filePath);
    pendingEdits.set(resolved, Date.now());
    updateBatchBar();
    if (window.QuillFeatures?.showInlineDiffBar) window.QuillFeatures.showInlineDiffBar(resolved);
    else showInlineDiff(resolved);
    if (deps.getEditorPath?.() && deps.pathsEqual(resolved, deps.getEditorPath())) {
      void deps.refreshEditor(false);
    }
  }

  function clearPending(filePath) {
    if (filePath) pendingEdits.delete(deps.resolvePath(filePath));
    else pendingEdits.clear();
    updateBatchBar();
  }

  function showInlineDiff(filePath) {
    const bar = document.getElementById("inline-diff-bar");
    if (!bar) return;
    bar.classList.remove("hidden");
    bar.querySelector(".inline-diff-path").textContent = filePath.split(/[/\\]/).pop() || filePath;
  }

  function updateBatchBar() {
    const bar = document.getElementById("batch-review-bar");
    if (!bar) return;
    const n = pendingEdits.size;
    bar.classList.toggle("hidden", n === 0);
    const label = bar.querySelector(".batch-count");
    if (label) label.textContent = `${n} file${n === 1 ? "" : "s"} changed by agent`;
  }

  async function applyAll() {
    pendingEdits.clear();
    document.getElementById("batch-review-bar")?.classList.add("hidden");
    document.getElementById("inline-diff-bar")?.classList.add("hidden");
    await deps.refreshGit();
    deps.showToast("All changes kept");
  }

  async function revertAll() {
    const ws = deps.activeWs();
    for (const p of pendingEdits.keys()) {
      await window.quill.gitRevertFile({ cwd: ws?.cwd, filePath: p });
    }
    pendingEdits.clear();
    document.getElementById("batch-review-bar")?.classList.add("hidden");
    document.getElementById("inline-diff-bar")?.classList.add("hidden");
    await deps.refreshEditor(false);
    await deps.refreshGit();
    deps.showToast("All changes reverted");
  }

  function normalizeUrl(u) {
    const t = String(u || "").trim();
    if (!t) return "";
    if (/^[a-z]+:\/\//i.test(t) || t.startsWith("about:")) return t;
    if (/^[\w-]+(\.[\w-]+)+/.test(t)) return `https://${t}`;
    return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
  }

  function openBrowser(url) {
    const panel = document.getElementById("browser-panel");
    const view = document.getElementById("cowork-browser");
    if (!panel || !view || !url) return;
    panel.classList.remove("hidden");
    const norm = normalizeUrl(url);
    view.src = norm;
    const inp = document.getElementById("browser-url");
    if (inp) { if ("value" in inp) inp.value = norm; else inp.textContent = norm; }
  }

  function closeBrowser() {
    document.getElementById("browser-panel")?.classList.add("hidden");
    const view = document.getElementById("cowork-browser");
    if (view) view.src = "about:blank";
  }

  function parseStream(raw) {
    const clean = window.QuillAgentStream?.stripAnsi(raw)
      ?? String(raw || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
    const taskM = clean.match(/\[QUILL_TASK:([^\]]+)\]/);
    if (taskM) ingestTasks(taskM[1]);
    let taskMarkerHit = false;
    const taskStartRe = /\[QUILL:TASK_START\s+([^\s\]]+)\s+([^\]]+)\]/g;
    let ts;
    while ((ts = taskStartRe.exec(clean)) !== null) {
      taskMarkerHit = true;
      const id = ts[1];
      const title = ts[2].trim();
      const hit = taskItems.find((t) => t.id === id);
      if (hit) { hit.text = title; }
      else taskItems.push({ id, text: title, status: "pending" });
    }
    const taskDoneRe = /\[QUILL:TASK_DONE\s+([^\s\]]+)\]/g;
    let td;
    while ((td = taskDoneRe.exec(clean)) !== null) {
      taskMarkerHit = true;
      const hit = taskItems.find((t) => t.id === td[1]);
      if (hit) hit.status = "done";
    }
    if (taskMarkerHit) renderTaskPlan();
    const browserM = clean.match(/\[QUILL_BROWSER:([^\]\r\n]+)\]/);
    if (browserM) openBrowser(browserM[1].trim());
    const editRe = /\[QUILL_EDIT:([^\]\r\n]+)\]/g;
    let em;
    while ((em = editRe.exec(clean)) !== null) queueEdit(em[1]);
    parseMarkdownPlan(clean);
  }

  function bindBatchReview() {
    document.getElementById("batch-apply-all")?.addEventListener("click", () => void applyAll());
    document.getElementById("batch-revert-all")?.addEventListener("click", () => void revertAll());
    document.getElementById("browser-panel-close")?.addEventListener("click", closeBrowser);
    const urlEl = document.getElementById("browser-url");
    const getUrl = () => (urlEl && "value" in urlEl ? urlEl.value : urlEl?.textContent) || "";
    document.getElementById("browser-open-external")?.addEventListener("click", () => {
      const url = getUrl();
      if (url) window.quill.openExternal(url);
    });
    const view = document.getElementById("cowork-browser");
    document.getElementById("browser-back")?.addEventListener("click", () => { try { view?.goBack?.(); } catch (_) {} });
    document.getElementById("browser-forward")?.addEventListener("click", () => { try { view?.goForward?.(); } catch (_) {} });
    document.getElementById("browser-reload")?.addEventListener("click", () => { try { view?.reload?.(); } catch (_) {} });
    document.getElementById("browser-devtools")?.addEventListener("click", () => { try { view?.openDevTools?.(); } catch (_) {} });
    if (urlEl && "value" in urlEl) {
      urlEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const norm = normalizeUrl(urlEl.value);
          if (norm && view) view.src = norm;
        }
      });
    }
    view?.addEventListener?.("did-navigate", (e) => {
      const u = e?.url || view.getURL?.();
      if (u && urlEl && "value" in urlEl) urlEl.value = u;
    });
    view?.addEventListener?.("did-navigate-in-page", (e) => {
      const u = e?.url || view.getURL?.();
      if (u && urlEl && "value" in urlEl) urlEl.value = u;
    });
  }

  function populateDelegateSelect() {
    const sel = document.getElementById("agent-delegate");
    if (!sel || !deps) return;
    const panes = deps.listPanes?.() || [];
    const personas = deps.getPersonas?.() || [];
    let html = `<option value="primary">Primary agent</option>`;
    html += `<option value="spawn">+ New planner pane</option>`;
    panes.forEach((pid) => {
      const persona = deps.getPanePersona?.(pid) || "Agent";
      html += `<option value="${esc(pid)}">${esc(persona)}</option>`;
    });
    sel.innerHTML = html;
    if (!sel._delegateBound) {
      sel._delegateBound = true;
      sel.onchange = () => deps.onDelegateChange?.();
    }
  }

  async function resolveDelegateTarget() {
    const sel = document.getElementById("agent-delegate");
    const val = sel?.value || "primary";
    if (val === "spawn") {
      await deps.addPane?.();
      populateDelegateSelect();
      const panes = deps.listPanes?.() || [];
      const last = panes[panes.length - 1];
      return { ptyId: deps.getPtyId?.(last) || deps.getPrimaryPtyId?.(), paneId: last };
    }
    if (val === "primary") {
      const pid = deps.getPrimaryPaneId?.() || deps.listPanes?.()?.[0];
      return { ptyId: deps.getPrimaryPtyId?.(), paneId: pid };
    }
    return {
      ptyId: deps.getPtyId?.(val) || deps.getPrimaryPtyId?.(),
      paneId: val,
    };
  }

  function bindDelegation() {
    populateDelegateSelect();
  }

  function init(hooks) {
    deps = hooks;
    bindBatchReview();
    bindDelegation();
  }

  return {
    init,
    parseStream,
    populateDelegateSelect,
    resolveDelegateTarget,
    applyAll,
    revertAll,
    clearPending,
    getPendingCount: () => pendingEdits.size,
    getPendingPaths: () => [...pendingEdits.keys()],
  };
})();

window.QuillCowork = QuillCowork;
