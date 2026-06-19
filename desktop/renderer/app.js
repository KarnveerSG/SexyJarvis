/** Quill desktop renderer — workspace grid + xterm panes */

const state = { workspaces: [], activeWorkspace: null, theme: "dark", panes: {} };
const termInstances = new Map();
let bootstrap = null;
let personaIndex = 0;

const COMMANDS = [
  { id: "settings", label: "Open settings", run: () => openSettings("integrations") },
  { id: "new-pane", label: "New terminal pane", run: () => addPane() },
  { id: "toggle-theme", label: "Toggle i mode (light theme)", run: () => toggleTheme() },
  { id: "grid-2x2", label: "Layout: 2×2 grid", run: () => setGrid("grid-2x2", 4) },
  { id: "grid-3x2", label: "Layout: 3×2 grid", run: () => setGrid("grid-3x2", 6) },
  { id: "agent-mode", label: "New agent pane (Quill REPL)", run: () => addPane("agent") },
  { id: "shell-mode", label: "New shell pane (PowerShell)", run: () => addPane("shell") },
];

let settingsSection = "integrations";

async function init() {
  bootstrap = await window.quill.getBootstrap();
  Object.assign(state, bootstrap.state);
  applyTheme();
  renderWorkspaces();
  await renderPanes();
  document.getElementById("status-path").textContent = bootstrap.quillPath || "quill";
  renderSettingsNav();
  bindEvents();
  window.quill.onPtyData(({ id, data }) => {
    const t = termInstances.get(id);
    if (t) t.term.write(data);
  });
  window.quill.onPtyExit(({ id }) => {
    const t = termInstances.get(id);
    if (t) t.term.write("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
  });
}

function activeWs() {
  return state.workspaces.find((w) => w.id === state.activeWorkspace) || state.workspaces[0];
}

function applyTheme() {
  document.body.classList.toggle("theme-imode", state.theme === "imode");
  document.body.classList.toggle("theme-dark", state.theme !== "imode");
}

function renderWorkspaces() {
  const ul = document.getElementById("workspace-list");
  ul.innerHTML = "";
  state.workspaces.forEach((ws) => {
    const li = document.createElement("li");
    li.className = "ws-item" + (ws.id === state.activeWorkspace ? " active" : "");
    li.style.setProperty("--ws-color", ws.color);
    li.innerHTML = `<span class="ws-dot"></span><span>${ws.name}</span><span class="ws-badge">${ws.paneIds?.length || ws.panes || 0}</span>`;
    li.onclick = () => switchWorkspace(ws.id);
    ul.appendChild(li);
  });
}

async function switchWorkspace(id) {
  await killAllPanes();
  state.activeWorkspace = id;
  persist();
  renderWorkspaces();
  await renderPanes();
}

function setGrid(cls, count) {
  const grid = document.getElementById("pane-grid");
  grid.className = "pane-grid " + cls;
  const ws = activeWs();
  if (ws) {
    ws.layout = cls;
    ws.panes = count;
    if (!ws.paneIds) ws.paneIds = [];
    while (ws.paneIds.length < count) ws.paneIds.push(`pane-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    ws.paneIds = ws.paneIds.slice(0, count);
  }
  persist();
  renderPanes();
}

async function renderPanes() {
  const grid = document.getElementById("pane-grid");
  const ws = activeWs();
  if (!ws) {
    grid.innerHTML = '<div class="splash"><h1>.quill</h1><p>No workspace — add one from the sidebar</p></div>';
    return;
  }
  grid.className = "pane-grid " + (ws.layout || "grid-2x2");
  const count = ws.panes || 4;
  if (!ws.paneIds) {
    ws.paneIds = Array.from({ length: count }, (_, i) => `pane-${ws.id}-${i}`);
  }
  grid.innerHTML = "";
  for (const paneId of ws.paneIds.slice(0, count)) {
    grid.appendChild(createPaneElement(paneId, ws));
  }
  for (const paneId of ws.paneIds.slice(0, count)) {
    await mountTerminal(paneId, ws);
  }
  renderWorkspaces();
}

function createPaneElement(paneId, ws) {
  const persona = bootstrap.personas[personaIndex++ % bootstrap.personas.length];
  const meta = state.panes[paneId] || { persona, mode: "agent" };
  state.panes[paneId] = meta;

  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.paneId = paneId;
  el.innerHTML = `
    <div class="pane-header">
      <span class="pane-persona">${meta.persona}</span>
      <span class="pane-mode">${meta.mode}</span>
      <button type="button" class="pane-close" title="Close">×</button>
    </div>
    <div class="pane-term" id="term-${paneId}"></div>
    <div class="pane-footer">Build · ${meta.persona} · agent</div>
  `;
  el.querySelector(".pane-close").onclick = () => removePane(paneId);
  return el;
}

async function mountTerminal(paneId, ws) {
  const host = document.getElementById(`term-${paneId}`);
  if (!host || termInstances.has(paneId)) return;

  const meta = state.panes[paneId] || { persona: "Iris", mode: "agent" };
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "Cascadia Code, Consolas, monospace",
    theme: state.theme === "imode"
      ? { background: "#ffffff", foreground: "#1a1a24", cursor: "#2a7ab8" }
      : { background: "#14141c", foreground: "#e8e8f0", cursor: "#7eb8ff" },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  const { id } = await window.quill.ptyCreate({
    cwd: ws.cwd,
    persona: meta.persona,
    mode: meta.mode,
  });

  termInstances.set(paneId, { term, fit, ptyId: id });
  term.onData((data) => window.quill.ptyWrite(id, data));

  const ro = new ResizeObserver(() => {
    fit.fit();
    window.quill.ptyResize(id, term.cols, term.rows);
  });
  ro.observe(host);
}

async function killAllPanes() {
  for (const [, t] of termInstances) {
    await window.quill.ptyKill(t.ptyId);
    t.term.dispose();
  }
  termInstances.clear();
}

async function removePane(paneId) {
  const t = termInstances.get(paneId);
  if (t) {
    await window.quill.ptyKill(t.ptyId);
    t.term.dispose();
    termInstances.delete(paneId);
  }
  const ws = activeWs();
  if (ws?.paneIds) ws.paneIds = ws.paneIds.filter((p) => p !== paneId);
  delete state.panes[paneId];
  persist();
  await renderPanes();
}

async function addPane(mode = "agent") {
  const ws = activeWs();
  if (!ws) return;
  const paneId = `pane-${Date.now()}`;
  if (!ws.paneIds) ws.paneIds = [];
  ws.paneIds.push(paneId);
  state.panes[paneId] = {
    persona: bootstrap.personas[personaIndex++ % bootstrap.personas.length],
    mode,
  };
  ws.panes = ws.paneIds.length;
  persist();
  await renderPanes();
}

function toggleTheme() {
  state.theme = state.theme === "imode" ? "dark" : "imode";
  applyTheme();
  persist();
  for (const [, t] of termInstances) {
    t.term.options.theme = state.theme === "imode"
      ? { background: "#ffffff", foreground: "#1a1a24", cursor: "#2a7ab8" }
      : { background: "#14141c", foreground: "#e8e8f0", cursor: "#7eb8ff" };
  }
}

function persist() {
  window.quill.saveState(state);
}

function bindEvents() {
  document.querySelector('[data-action="settings"]').onclick = () => openSettings("integrations");
  document.querySelector('[data-action="new-pane"]').onclick = () => addPane();
  document.querySelector('[data-action="toggle-theme"]').onclick = () => toggleTheme();
  document.querySelector('[data-action="palette"]').onclick = () => openPalette();

  document.getElementById("add-workspace").onclick = () => {
    const i = state.workspaces.length;
    const id = `ws-${Date.now()}`;
    state.workspaces.push({
      id,
      name: `Workspace ${i + 1}`,
      color: bootstrap.rainbow[i % bootstrap.rainbow.length],
      cwd: (state.workspaces[0] && state.workspaces[0].cwd) || "",
      panes: 4,
      layout: "grid-2x2",
      paneIds: [],
    });
    state.activeWorkspace = id;
    persist();
    switchWorkspace(id);
  };

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "p") {
      e.preventDefault();
      openPalette();
    }
    if (e.key === "Escape") {
      closePalette();
      closeSettings();
    }
  });

  document.getElementById("settings-close").onclick = closeSettings;
}

function openSettings(section = "integrations") {
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
      <span class="nav-icon">${s.icon}</span>${s.label}
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

  if (settingsSection === "integrations") {
    el.innerHTML = `
      <div class="settings-page">
        <div class="settings-page-head">
          <div>
            <h3>Integrations</h3>
            <p class="settings-sub">Connect tools your agent can act on. Keys are saved to <code>~/.quill/.env</code>.</p>
          </div>
          <span class="integration-count">${bootstrap.integrationsSummary}</span>
        </div>
        <div class="integration-list" id="integration-list"></div>
      </div>`;
    renderIntegrationCards();
    return;
  }

  if (settingsSection === "models") {
    el.innerHTML = `
      <div class="settings-page">
        <h3>Models</h3>
        <p class="settings-sub">LLM provider keys — also used by the CLI agent.</p>
        <div class="env-form" id="models-form"></div>
        <button type="button" class="btn-primary" id="save-models">Save</button>
      </div>`;
    renderEnvForm("models-form", bootstrap.coreEnvKeys);
    document.getElementById("save-models").onclick = () => saveEnvForm("models-form", bootstrap.coreEnvKeys);
    return;
  }

  if (settingsSection === "appearance") {
    el.innerHTML = `
      <div class="settings-page">
        <h3>Appearance</h3>
        <p class="settings-sub">Theme and visual preferences.</p>
        <label class="field-row"><span>Theme</span>
          <select id="theme-select"><option value="dark">Dark</option><option value="imode">i mode (light)</option></select>
        </label>
        <button type="button" class="btn-primary" id="save-appearance">Apply</button>
      </div>`;
    document.getElementById("theme-select").value = state.theme || "dark";
    document.getElementById("save-appearance").onclick = () => {
      state.theme = document.getElementById("theme-select").value;
      applyTheme();
      persist();
    };
    return;
  }

  if (settingsSection === "voice") {
    el.innerHTML = `
      <div class="settings-page">
        <h3>Voice</h3>
        <p class="settings-sub">Per-persona voice settings (Iris, Thea, Nova, Sage, Luna, Wren). Configure in CLI with <code>/voicestyle</code>.</p>
        <ul class="persona-list">${bootstrap.personas.map((p) => `<li><strong>${p}</strong> — edge-tts neural voice</li>`).join("")}</ul>
        <div class="env-form" id="voice-form"></div>
        <button type="button" class="btn-primary" id="save-voice">Save voice keys</button>
      </div>`;
    const voiceKeys = [
      { env: "QUILL_TTS", label: "TTS enabled", placeholder: "true" },
      { env: "QUILL_STT", label: "STT enabled", placeholder: "true" },
      { env: "QUILL_TTS_VOICE", label: "Default voice", placeholder: "en-GB-SoniaNeural" },
      { env: "QUILL_TTS_STYLE", label: "Style", placeholder: "intimate | playful | bright" },
    ];
    renderEnvForm("voice-form", voiceKeys);
    document.getElementById("save-voice").onclick = () => saveEnvForm("voice-form", voiceKeys);
    return;
  }

  if (settingsSection === "terminal") {
    el.innerHTML = `
      <div class="settings-page">
        <h3>Terminal</h3>
        <p class="settings-sub">CLI path: <code>${bootstrap.quillPath}</code></p>
        <p class="settings-sub">Agent panes spawn <code>quill -w &lt;workspace&gt;</code>. Shell panes use PowerShell.</p>
      </div>`;
    return;
  }

  if (settingsSection === "about") {
    el.innerHTML = `
      <div class="settings-page about-page">
        <h3>.quill</h3>
        <p class="settings-sub">CODE BEAUTIFUL</p>
        <p>Version ${bootstrap.version || "0.2.0"}</p>
        <p class="settings-sub">IDE-style AI coding agent with multi-workspace terminals.</p>
      </div>`;
    return;
  }

  el.innerHTML = `<div class="settings-page"><h3>${settingsSection}</h3><p class="settings-sub">Coming soon.</p></div>`;
}

function renderIntegrationCards() {
  const list = document.getElementById("integration-list");
  if (!list) return;
  list.innerHTML = bootstrap.integrations.map((int) => `
    <details class="integration-card ${int.status}" ${int.status === "connected" ? "open" : ""}>
      <summary>
        <span class="int-name">${int.name}</span>
        <span class="int-badge ${int.status}">${int.status === "connected" ? "✓ Connected" : "Not connected"}</span>
      </summary>
      <p class="int-desc">${int.desc}</p>
      <div class="int-keys" data-id="${int.id}">
        ${int.keys.map((k) => `
          <label class="field-row">
            <span>${k.label}</span>
            <input type="password" data-env="${k.env}" placeholder="${k.placeholder}" autocomplete="off" />
          </label>`).join("")}
        <button type="button" class="btn-primary save-int" data-id="${int.id}">Save</button>
      </div>
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
      bootstrap.integrations.forEach((i) => {
        const st = res.integrations.find((x) => x.id === i.id);
        if (st) i.status = st.status;
      });
      document.querySelector(".integration-count").textContent = res.integrationsSummary;
      renderIntegrationCards();
    };
  });
}

function renderEnvForm(containerId, keys) {
  const form = document.getElementById(containerId);
  if (!form) return;
  form.innerHTML = keys.map((k) => `
    <label class="field-row">
      <span>${k.label}</span>
      <input type="password" data-env="${k.env}" placeholder="${k.placeholder || ""}" autocomplete="off" />
    </label>`).join("");
}

async function saveEnvForm(containerId, keys) {
  const form = document.getElementById(containerId);
  const updates = {};
  form.querySelectorAll("input[data-env]").forEach((inp) => {
    if (inp.value.trim()) updates[inp.dataset.env] = inp.value.trim();
  });
  await window.quill.saveEnvKeys(updates);
  bootstrap = await window.quill.getBootstrap();
  alert("Saved to ~/.quill/.env");
}

function openPalette() {
  const pal = document.getElementById("palette");
  pal.classList.remove("hidden");
  const input = document.getElementById("palette-input");
  input.value = "";
  input.focus();
  renderPalette("");
  input.oninput = () => renderPalette(input.value);
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      const active = document.querySelector("#palette-list li.active");
      if (active) COMMANDS.find((c) => c.id === active.dataset.id)?.run();
      closePalette();
    }
  };
}

function closePalette() {
  document.getElementById("palette").classList.add("hidden");
}

function renderPalette(q) {
  const list = document.getElementById("palette-list");
  const filtered = COMMANDS.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  list.innerHTML = filtered.map((c, i) =>
    `<li data-id="${c.id}" class="${i === 0 ? "active" : ""}">${c.label}</li>`
  ).join("");
  list.querySelectorAll("li").forEach((li) => {
    li.onclick = () => {
      COMMANDS.find((c) => c.id === li.dataset.id)?.run();
      closePalette();
    };
  });
}

init().catch((err) => {
  document.body.innerHTML = `<pre style="color:#ff6b6b;padding:20px">Quill failed to start: ${err.message}\n${err.stack}</pre>`;
});
