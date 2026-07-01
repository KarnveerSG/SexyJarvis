/** Settings modal — nav, content, MCP, integrations */
window.QuillModules = window.QuillModules || {};

(() => {
  const S = () => window.QuillModules.state;
  const { escHtml } = window.QuillModules.util;

  function openSettings(section = "appearance") {
    S().settingsSection = section;
    document.getElementById("settings").classList.remove("hidden");
    renderSettingsNav();
    renderSettingsContent();
  }

  function closeSettings() {
    document.getElementById("settings").classList.add("hidden");
  }

  function renderSettingsNav() {
    const nav = document.getElementById("settings-nav");
    if (!nav || !S().bootstrap) return;
    nav.innerHTML = S().bootstrap.settingsSections.map((s) => {
      const comingSoon = s.comingSoon ? '<em class="soon">Soon</em>' : "";
      return `<button type="button" class="settings-nav-item${s.id === S().settingsSection ? " active" : ""}" data-section="${s.id}">
      <span class="nav-icon">${s.icon}</span>
      <span class="nav-label">${s.label}</span>
      ${comingSoon}
    </button>`;
    }).join("");
    nav.querySelectorAll(".settings-nav-item").forEach((btn) => {
      btn.onclick = () => {
        S().settingsSection = btn.dataset.section;
        renderSettingsNav();
        renderSettingsContent();
      };
    });
  }

  function renderSettingsContent() {
    const el = document.getElementById("settings-content");
    if (!el || !S().bootstrap) return;
    const sec = S().bootstrap.settingsSections.find((s) => s.id === S().settingsSection);

    if (S().settingsSection === "mcp") {
      void renderMcpSettings(el);
      return;
    }

    if (S().settingsSection === "keybindings") {
      void window.QuillFeatures?.renderKeybindingsSettings(el);
      return;
    }

    if (S().settingsSection === "extensions") {
      window.QuillFeatures?.renderExtensionsSettings(el);
      return;
    }

    if (S().settingsSection === "remote") {
      el.innerHTML = `<div class="settings-page coming-soon-page">
      <h3>${sec?.label || "Remote Integration"}</h3>
      <p class="badge-soon">Coming Soon</p>
      <p class="settings-sub">Planned for a future release. See <code>future_features.md</code> in the repo.</p>
    </div>`;
      return;
    }

    if (S().settingsSection === "skills") {
      void renderSkillsPanel(el);
      return;
    }

    if (S().settingsSection === "notifications") {
      const prefs = S().state.notifications || {};
      const osOn = prefs.osNotifications !== false;
      const toastOn = prefs.toasts !== false;
      el.innerHTML = `<div class="settings-page"><h3>Notifications</h3>
        <p class="settings-sub">How Quill alerts you when a background workspace task completes.</p>
        <label class="field-row"><span>In-app toast</span><input type="checkbox" id="notif-toast"${toastOn ? " checked" : ""} /></label>
        <label class="field-row"><span>OS notification</span><input type="checkbox" id="notif-os"${osOn ? " checked" : ""} /></label>
        <p class="settings-sub" id="notif-status"></p></div>`;
      const save = () => {
        S().state.notifications = {
          toasts: document.getElementById("notif-toast").checked,
          osNotifications: document.getElementById("notif-os").checked,
        };
        window.QuillModules.workspaces.persist();
        const st = document.getElementById("notif-status");
        if (st) st.textContent = "Saved.";
      };
      document.getElementById("notif-toast").onchange = save;
      document.getElementById("notif-os").onchange = () => {
        save();
        if (document.getElementById("notif-os").checked && "Notification" in window && Notification.permission === "default") {
          Notification.requestPermission();
        }
      };
      return;
    }

    if (S().settingsSection === "appearance") {
      const opts = Object.entries(S().bootstrap.themes || {}).map(([id, t]) =>
        `<option value="${id}"${S().state.theme === id ? " selected" : ""}>${t.label}</option>`
      ).join("");
      el.innerHTML = `<div class="settings-page">
      <h3>Appearance</h3>
      <p class="settings-sub">Color theme for the IDE shell and terminals.</p>
      <label class="field-row"><span>Theme</span><select id="theme-select">${opts}</select></label>
      <button type="button" class="btn-primary" id="save-appearance">Apply</button>
      <p class="settings-sub">Shortcut: Ctrl+Shift+I to cycle themes.</p>
    </div>`;
      const onThemeApply = () => {
        S().state.theme = document.getElementById("theme-select").value;
        window.QuillApp.applyTheme();
        window.QuillModules.workspaces.persist();
      };
      document.getElementById("save-appearance").onclick = onThemeApply;
      document.getElementById("theme-select").onchange = onThemeApply;
      return;
    }

    if (S().settingsSection === "integrations") {
      el.innerHTML = `<div class="settings-page">
      <div class="settings-page-head"><div><h3>Integrations</h3>
      <p class="settings-sub">Keys saved to <code>~/.quill/.env</code>.</p></div>
      <span class="integration-count">${S().bootstrap.integrationsSummary}</span></div>
      <div class="integration-list" id="integration-list"></div></div>`;
      renderIntegrationCards();
      return;
    }

    if (S().settingsSection === "models") {
      el.innerHTML = `<div class="settings-page"><h3>Models</h3><p class="settings-sub">LLM provider keys.</p>
      <div class="env-form" id="models-form"></div><button type="button" class="btn-primary" id="save-models">Save</button></div>`;
      renderEnvForm("models-form", S().bootstrap.coreEnvKeys);
      document.getElementById("save-models").onclick = () => saveEnvForm("models-form");
      return;
    }

    if (S().settingsSection === "about") {
      const pty = S().bootstrap.ptyAvailable ? "ConPTY / node-pty" : "pipe fallback";
      el.innerHTML = `<div class="settings-page about-page"><h3>Quill</h3><p class="settings-sub">CODE BEAUTIFUL</p>
      <p>Version ${S().bootstrap.version || "0.2.0"} · Terminal: ${pty}</p>
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

    el.innerHTML = `<div class="settings-page"><h3>${sec?.label || S().settingsSection}</h3><p class="settings-sub">Coming soon.</p></div>`;
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
    const count = Object.keys(S().mcpDraft.servers).length;
    const el = document.getElementById("mcp-count");
    if (el) el.textContent = `${count} server${count === 1 ? "" : "s"}`;
  }

  function renderMcpServerList() {
    const list = document.getElementById("mcp-server-list");
    if (!list) return;
    const names = Object.keys(S().mcpDraft.servers).sort();
    if (!names.length) {
      list.innerHTML = `<p class="settings-sub">No MCP servers configured.</p>`;
      return;
    }
    list.innerHTML = names.map((name) => {
      const spec = S().mcpDraft.servers[name] || {};
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
        delete S().mcpDraft.servers[btn.dataset.name];
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
    const ws = window.QuillModules.workspaces.activeWs();
    const cwd = ws?.cwd || "";
    el.innerHTML = `<div class="settings-page"><h3>MCP</h3><p class="settings-sub">Loading…</p></div>`;
    const res = await window.quill.getMcpConfig(cwd);
    S().mcpDraft = { servers: { ...(res.config?.servers || {}) } };
    const count = Object.keys(S().mcpDraft.servers).length;
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
    window.QuillFeatures?.setMcpDraftRef(S().mcpDraft);
    document.getElementById("mcp-add-btn").onclick = () => {
      const name = document.getElementById("mcp-new-name").value.trim();
      const command = document.getElementById("mcp-new-command").value.trim();
      const argsText = document.getElementById("mcp-new-args").value.trim();
      const status = document.getElementById("mcp-status");
      if (!name || !command) {
        status.textContent = "Name and command are required.";
        return;
      }
      if (S().mcpDraft.servers[name]) {
        status.textContent = `Server "${name}" already exists.`;
        return;
      }
      const entry = { command };
      const args = parseMcpArgs(argsText);
      if (args.length) entry.args = args;
      S().mcpDraft.servers[name] = entry;
      document.getElementById("mcp-new-name").value = "";
      document.getElementById("mcp-new-command").value = "";
      document.getElementById("mcp-new-args").value = "";
      status.textContent = "";
      renderMcpServerList();
      updateMcpCount();
    };
    document.getElementById("mcp-save-btn").onclick = async () => {
      const status = document.getElementById("mcp-status");
      S().mcpDraft.servers = mcpServersFromForm();
      try {
        const saveRes = await window.quill.saveMcpConfig(cwd, S().mcpDraft);
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

  async function renderSkillsPanel(el) {
    el.innerHTML = `<div class="settings-page"><h3>Skills (MCP)</h3><p class="settings-sub">Loading…</p></div>`;
    const workspaces = S().state.workspaces || [];
    const configs = await Promise.all(workspaces.map(async (ws) => {
      const res = ws?.cwd ? await window.quill.getMcpConfig(ws.cwd) : { config: { servers: {} } };
      return { ws, servers: res?.config?.servers || {} };
    }));
    const rows = configs.map(({ ws, servers }) => {
      const names = Object.keys(servers);
      const cards = names.length
        ? names.map((name) => {
          const spec = servers[name] || {};
          const enabled = spec.enabled !== false;
          const args = (spec.args || []).join(" ");
          return `<div class="skill-row">
            <label class="mcp-toggle"><input type="checkbox" data-skill-toggle data-ws="${escHtml(ws.id)}" data-server="${escHtml(name)}"${enabled ? " checked" : ""} />
              <span class="int-name">${escHtml(name)}</span></label>
            <span class="settings-sub skill-cmd"><code>${escHtml(spec.command || "")} ${escHtml(args)}</code></span>
          </div>`;
        }).join("")
        : `<p class="settings-sub">No MCP servers configured for this workspace. Open MCP settings to add one.</p>`;
      return `<details class="integration-card" open>
        <summary><span class="int-name">${escHtml(ws.name)}</span><span class="int-badge">${names.length} skill${names.length === 1 ? "" : "s"}</span></summary>
        <div class="int-keys">${cards}</div>
      </details>`;
    }).join("");
    el.innerHTML = `<div class="settings-page">
      <div class="settings-page-head">
        <div><h3>Skills (MCP)</h3>
        <p class="settings-sub">Enable or disable an MCP server per workspace. Saved to each workspace's <code>.quill/mcp.json</code>.</p></div>
        <button type="button" class="btn-secondary" id="skills-open-mcp">Open MCP settings…</button>
      </div>
      <div class="integration-list">${rows || `<p class="settings-sub">No workspaces yet.</p>`}</div>
      <p class="settings-sub" id="skills-status"></p>
    </div>`;
    document.getElementById("skills-open-mcp")?.addEventListener("click", () => openSettings("mcp"));
    el.querySelectorAll("[data-skill-toggle]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        const wsId = cb.dataset.ws;
        const server = cb.dataset.server;
        const ws = workspaces.find((w) => w.id === wsId);
        if (!ws?.cwd) return;
        const cur = await window.quill.getMcpConfig(ws.cwd);
        const cfg = { servers: { ...(cur?.config?.servers || {}) } };
        if (!cfg.servers[server]) return;
        if (cb.checked) delete cfg.servers[server].enabled;
        else cfg.servers[server].enabled = false;
        const res = await window.quill.saveMcpConfig(ws.cwd, cfg);
        const status = document.getElementById("skills-status");
        if (status) status.textContent = res?.ok ? `${server} ${cb.checked ? "enabled" : "disabled"} for ${ws.name}.` : "Save failed.";
      });
    });
  }

  function renderIntegrationCards() {
    const list = document.getElementById("integration-list");
    if (!list) return;
    list.innerHTML = S().bootstrap.integrations.map((int) => `
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
        S().bootstrap.integrationsSummary = res.integrationsSummary;
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
    S().bootstrap = await window.quill.getBootstrap();
  }

  window.QuillModules.settings = {
    openSettings,
    closeSettings,
    renderSettingsNav,
    renderSettingsContent,
  };
})();
