const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { INTEGRATIONS, SETTINGS_SECTIONS, CORE_ENV_KEYS } = require("./integrations");
const { THEMES } = require("./themes");

let nodePty = null;
try {
  nodePty = require("node-pty");
} catch (_) {}

const PERSONAS = ["Hera", "Artemis", "Athena", "Demeter", "Aphrodite", "Hestia", "Persephone", "Hecate", "Nike"];
const RAINBOW = ["#FF6B6B", "#FF9F43", "#FECA57", "#1DD1A1", "#54A0FF", "#5F27CD", "#A29BFE"];

let mainWindow = null;
const terminals = new Map();
let termCounter = 0;
let shuttingDown = false;
let workspaceWatcher = null;
let watchDebounce = null;
const WATCH_SKIP_DIRS = new Set([".git", "node_modules", ".codegraph", "__pycache__", "dist", "build"]);

function emitWorkspaceFileChanged(changedPath) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("workspace-file-changed", { path: changedPath });
  }
}

function setupWorkspaceWatcher(cwd) {
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
  }
  if (!cwd) return;
  const root = path.resolve(cwd);
  if (!fs.existsSync(root)) return;
  try {
    workspaceWatcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (rel.split(/[/\\]/).some((part) => WATCH_SKIP_DIRS.has(part))) return;
      const changedPath = path.join(root, rel);
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => emitWorkspaceFileChanged(changedPath), 250);
    });
    workspaceWatcher.on("error", () => {
      workspaceWatcher?.close();
      workspaceWatcher = null;
    });
  } catch (_) {}
}

function syncWorkspaceWatcher(state) {
  const ws = state?.workspaces?.find((w) => w.id === state.activeWorkspace) || state?.workspaces?.[0];
  setupWorkspaceWatcher(ws?.cwd);
}

function forceKillProc(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill();
  } catch (_) {}
  if (process.platform === "win32" && proc.pid) {
    try {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch (_) {}
  }
}

function gracefulKillTerm(id, t) {
  return new Promise((resolve) => {
    if (t?.pty) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        terminals.delete(id);
        resolve();
      };
      try {
        t.pty.onExit(() => finish());
        t.pty.write("/exit\r\n");
      } catch (_) {}
      setTimeout(() => {
        try {
          t.pty.kill();
        } catch (_) {}
        finish();
      }, 3000);
      return;
    }
    const proc = t?.proc;
    if (!proc || proc.killed) {
      terminals.delete(id);
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      terminals.delete(id);
      resolve();
    };
    proc.once("exit", finish);
    try {
      if (proc.stdin?.writable) proc.stdin.write("/exit\r\n");
    } catch (_) {}
    setTimeout(() => {
      forceKillProc(proc);
      finish();
    }, 3000);
  });
}

async function shutdownAllTerminals() {
  for (const [, t] of terminals) {
    try {
      t.pty?.kill();
    } catch (_) {}
    if (t?.proc && !t.proc.killed) forceKillProc(t.proc);
  }
  await Promise.all([...terminals.entries()].map(([id, t]) => gracefulKillTerm(id, t)));
  terminals.clear();
}

async function quitApp() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.webContents.executeJavaScript(
        "window.__quillShutdown ? window.__quillShutdown() : Promise.resolve()",
        true,
      );
    } catch (_) {}
  }
  await shutdownAllTerminals();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const wc = mainWindow.webContents;
      if (wc && !wc.isDestroyed()) {
        wc.session?.closeAllConnections?.();
        wc.removeAllListeners();
      }
      mainWindow.removeAllListeners();
    } catch (_) {}
    mainWindow.destroy();
    mainWindow = null;
  }
  app.quit();
  setTimeout(() => app.exit(0), 500);
}

function quillCliPath() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Quill", "Quill.exe"),
    path.join(__dirname, "..", "dist", "Quill.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "Quill";
}

function envPath() {
  const dir = path.join(os.homedir(), ".quill");
  const legacy = path.join(os.homedir(), ".sexyjarvis", ".env");
  const target = path.join(dir, ".env");
  if (!fs.existsSync(target) && fs.existsSync(legacy)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(legacy, target);
  }
  return target;
}

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function writeEnvFile(filePath, data) {
  const lines = ["# Quill — keys saved from Settings → Integrations", ""];
  for (const k of Object.keys(data).sort()) {
    if (data[k]) lines.push(`${k}=${data[k]}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function fetchLocalModel(base, timeout = 1200) {
  return new Promise((resolve) => {
    try {
      const url = new URL(`${String(base).replace(/\/$/, "")}/models`);
      const req = http.get(url, { timeout }, (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const j = JSON.parse(buf);
            const models = j.data || j.models || [];
            const first = models[0];
            const name = first?.id || first?.name || (typeof first === "string" ? first : null);
            resolve(name || "ready");
          } catch (_) {
            resolve("ready");
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function detectLocalLLM() {
  for (const base of ["http://localhost:1234/v1", "http://localhost:11434/v1"]) {
    const model = await fetchLocalModel(base);
    if (model) return { url: base, model };
  }
  return null;
}

function getActiveProvider() {
  const env = parseEnvFile(envPath());
  return String(env.QUILL_PROVIDER || env.SEXYJARVIS_PROVIDER || "auto").toLowerCase();
}

function tasksFilePath(cwd) {
  return path.join(path.resolve(cwd || os.homedir()), ".quill", "tasks.json");
}

function integrationStatus(env, integration) {
  return integration.keys.every((k) => Boolean((env[k.env] || "").trim()))
    ? "connected" : "disconnected";
}

function resolveWorkspaceCwd(cwd) {
  if (cwd) return cwd;
  const st = loadState();
  const ws = st.workspaces?.find((w) => w.id === st.activeWorkspace) || st.workspaces?.[0];
  return ws?.cwd || os.homedir();
}

function mcpConfigPath(cwd) {
  return path.join(resolveWorkspaceCwd(cwd), ".quill", "mcp.json");
}

function loadMcpConfigFile(cwd) {
  const filePath = mcpConfigPath(cwd);
  if (!fs.existsSync(filePath)) return { path: filePath, config: { servers: {} } };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const servers = data?.servers && typeof data.servers === "object" ? data.servers : {};
    return { path: filePath, config: { servers } };
  } catch {
    return { path: filePath, config: { servers: {} } };
  }
}

function saveMcpConfigFile(cwd, config) {
  const filePath = mcpConfigPath(cwd);
  const servers = config?.servers && typeof config.servers === "object" ? config.servers : {};
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ servers }, null, 2) + "\n", "utf8");
  return { ok: true, path: filePath };
}

function notifyMcpReload(cwd) {
  const root = resolveWorkspaceCwd(cwd);
  const flagPath = path.join(root, ".quill", "mcp.reload");
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    fs.writeFileSync(flagPath, String(Date.now()) + "\n", "utf8");
  } catch (_) {}
  for (const [, t] of terminals) {
    if (t.cwd !== root) continue;
    try {
      if (t.pty) t.pty.write("/mcp reload\r");
      else if (t.proc?.stdin?.writable) t.proc.stdin.write("/mcp reload\r");
    } catch (_) {}
  }
  return { ok: true };
}

function workspacesProfileDir() {
  return path.join(os.homedir(), ".quill", "workspaces");
}

function saveWorkspaceProfile(ws) {
  if (!ws?.named || !ws?.id) return { ok: false };
  const dir = workspacesProfileDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ws.id}.json`);
  fs.writeFileSync(file, JSON.stringify(ws, null, 2) + "\n", "utf8");
  return { ok: true, path: file };
}

function importWorkspaceFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const ws = raw.workspaces?.[0] || raw;
    if (!ws.cwd) return { ok: false, error: "Workspace file missing cwd." };
    return { ok: true, workspace: ws };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

const STATE_VERSION = 2;

function defaultState() {
  const home = os.homedir();
  const paneId = "pane-main";
  return {
    stateVersion: STATE_VERSION,
    workspaces: [{
      id: "ws-main",
      name: "Quill",
      color: RAINBOW[4],
      cwd: home,
      folders: [home],
      panes: 1,
      layout: "grid-1x1",
      paneIds: [paneId],
      named: false,
    }],
    activeWorkspace: "ws-main",
    theme: "dark",
    panes: { [paneId]: { persona: "Hera", mode: "agent" } },
  };
}

function statePath() {
  return path.join(app.getPath("userData"), "quill-state.json");
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (!raw.workspaces?.length || (raw.stateVersion || 1) < STATE_VERSION) {
      const fresh = defaultState();
      saveState(fresh);
      return fresh;
    }
    return raw;
  } catch {
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: "#0d0d12",
    title: "Quill",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function spawnTerm(id, opts) {
  const cwd = opts.cwd || os.homedir();
  const persona = opts.persona || "Hera";
  const quill = quillCliPath();
  const args = ["-w", cwd, "--no-speech"];
  if (opts.named) args.push("--resume");
  const envObj = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
    QUILL_PERSONA: persona,
    QUILL_DESKTOP: "1",
    QUILL_NAMED_WORKSPACE: opts.named ? "1" : "0",
    QUILL_WORKSPACE_ID: opts.workspaceId || "",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
  if (opts.provider) {
    envObj.QUILL_PROVIDER_OVERRIDE = String(opts.provider);
    envObj.QUILL_PROVIDER = String(opts.provider);
  }
  if (opts.model) envObj.QUILL_MODEL_OVERRIDE = String(opts.model);
  const cols = opts.cols || 120;
  const rows = opts.rows || 30;

  const canSendToRenderer = () => {
    if (shuttingDown) return false;
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const wc = mainWindow.webContents;
    return wc && !wc.isDestroyed() && !wc.isCrashed();
  };

  const emit = (data) => {
    if (!canSendToRenderer()) return;
    try {
      mainWindow.webContents.send("pty-data", { id, data: data.toString() });
    } catch { /* render frame disposed mid-quit */ }
  };
  const onExit = (code) => {
    terminals.delete(id);
    if (!canSendToRenderer()) return;
    try {
      mainWindow.webContents.send("pty-exit", { id, exitCode: code ?? 0 });
    } catch { /* render frame disposed mid-quit */ }
  };

  if (nodePty) {
    try {
      const pty = nodePty.spawn(quill, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: envObj,
        useConpty: process.platform === "win32",
      });
      terminals.set(id, { pty, proc: null, persona, cwd, cols, rows, named: Boolean(opts.named), workspaceId: opts.workspaceId || "" });
      pty.onData(emit);
      pty.onExit(({ exitCode }) => onExit(exitCode));
      return { id, persona, mode: "agent", pty: true };
    } catch (err) {
      emit(`\r\n\x1b[33mPTY fallback: ${err.message}\x1b[0m\r\n`);
    }
  }

  const proc = spawn(quill, args, {
    cwd,
    env: envObj,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  terminals.set(id, { proc, pty: null, persona, cwd, cols, rows, named: Boolean(opts.named), workspaceId: opts.workspaceId || "" });
  proc.stdout.on("data", emit);
  proc.stderr.on("data", emit);
  proc.on("exit", (code) => onExit(code));
  proc.on("error", (err) => emit(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`));

  return { id, persona, mode: "agent", pty: false };
}

ipcMain.handle("get-bootstrap", async () => {
  const env = parseEnvFile(envPath());
  const integrations = INTEGRATIONS.map((i) => ({
    ...i,
    status: integrationStatus(env, i),
    keys: i.keys.map((k) => ({ ...k, set: Boolean((env[k.env] || "").trim()) })),
  }));
  const connected = integrations.filter((i) => i.status === "connected").length;
  const localLlm = await detectLocalLLM();
  if (localLlm?.url?.includes("1234")) {
    const envNow = parseEnvFile(envPath());
    if (!(envNow.LM_STUDIO_URL || "").trim()) {
      envNow.LM_STUDIO_URL = localLlm.url;
      writeEnvFile(envPath(), envNow);
    }
  }
  return {
    state: loadState(),
    personas: PERSONAS,
    rainbow: RAINBOW,
    themes: THEMES,
    quillPath: quillCliPath(),
    envPath: envPath(),
    version: app.getVersion(),
    ptyAvailable: Boolean(nodePty),
    settingsSections: SETTINGS_SECTIONS,
    integrations,
    integrationsSummary: `${connected} of ${INTEGRATIONS.length} connected`,
    coreEnvKeys: CORE_ENV_KEYS.map((k) => ({ ...k, set: Boolean((env[k.env] || "").trim()) })),
    providers: ["auto", "anthropic", "cursor", "local"],
    activeProvider: getActiveProvider(),
    localLlmAvailable: Boolean(localLlm),
    localLlmUrl: localLlm?.url || "",
    localLlmModel: localLlm?.model || "",
  };
});

ipcMain.handle("save-state", (_e, state) => {
  saveState(state);
  syncWorkspaceWatcher(state);
  return true;
});
ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Folder",
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
ipcMain.handle("pick-workspace-file", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Quill Workspace", extensions: ["json", "yaml", "yml"] }],
    title: "Open Workspace",
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
ipcMain.handle("get-env", () => {
  const env = parseEnvFile(envPath());
  return { path: envPath(), keys: Object.keys(env) };
});
ipcMain.handle("get-mcp-config", (_e, cwd) => loadMcpConfigFile(cwd));
ipcMain.handle("save-mcp-config", (_e, { cwd, config }) => {
  const result = saveMcpConfigFile(cwd, config);
  if (result.ok) notifyMcpReload(cwd);
  return result;
});
ipcMain.handle("reload-mcp-agents", (_e, cwd) => notifyMcpReload(cwd));
ipcMain.handle("save-workspace-profile", (_e, ws) => saveWorkspaceProfile(ws));
ipcMain.handle("import-workspace-file", (_e, filePath) => importWorkspaceFile(filePath));
ipcMain.handle("save-env-keys", (_e, updates) => {
  const file = envPath();
  const env = parseEnvFile(file);
  for (const [k, v] of Object.entries(updates || {})) {
    if (v === "" || v == null) delete env[k];
    else env[k] = String(v).trim();
  }
  writeEnvFile(file, env);
  const integrations = INTEGRATIONS.map((i) => ({
    id: i.id,
    status: integrationStatus(env, i),
  }));
  const connected = integrations.filter((i) => i.status === "connected").length;
  return { ok: true, integrationsSummary: `${connected} of ${INTEGRATIONS.length} connected`, integrations };
});
ipcMain.handle("get-provider", () => ({ provider: getActiveProvider() }));
ipcMain.handle("set-provider", async (_e, provider) => {
  const p = String(provider || "auto").toLowerCase();
  if (p === "local" && !(await detectLocalLLM())) {
    return { ok: false, error: "No local LLM detected (LM Studio / Ollama)" };
  }
  const file = envPath();
  const env = parseEnvFile(file);
  env.QUILL_PROVIDER = p;
  writeEnvFile(file, env);
  return { ok: true, activeProvider: p };
});
ipcMain.handle("get-tasks", (_e, cwd) => {
  const fp = tasksFilePath(cwd);
  try {
    if (!fs.existsSync(fp)) return { tasks: [] };
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    return { tasks: Array.isArray(raw) ? raw : [] };
  } catch (_) {
    return { tasks: [] };
  }
});
ipcMain.handle("save-tasks", (_e, { cwd, tasks }) => {
  const fp = tasksFilePath(cwd);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(tasks || [], null, 2));
  return { ok: true };
});
ipcMain.handle("pty-create", (_e, opts) => spawnTerm(`term-${++termCounter}`, opts));
ipcMain.handle("pty-write", (_e, { id, data }) => {
  const t = terminals.get(id);
  if (t?.pty) {
    try {
      t.pty.write(data);
    } catch (_) {}
  } else if (t?.proc?.stdin?.writable) t.proc.stdin.write(data);
});
ipcMain.handle("pty-resize", (_e, { id, cols, rows }) => {
  const t = terminals.get(id);
  if (!t) return;
  t.cols = cols;
  t.rows = rows;
  if (t.pty) {
    try {
      t.pty.resize(cols, rows);
    } catch (_) {}
  }
});
ipcMain.handle("pty-kill", async (_e, { id }) => {
  const t = terminals.get(id);
  if (t) await gracefulKillTerm(id, t);
});
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));
ipcMain.handle("app-quit", async () => { await quitApp(); return true; });

async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function runGitEx(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    const error = (err.stderr || err.stdout || err.message || "git failed").toString().trim();
    return { ok: false, error };
  }
}

function parseGitStatusPorcelain(text, root) {
  const lines = text ? text.split(/\r?\n/).filter(Boolean) : [];
  return lines.map((line) => {
    const indexStatus = line[0] || " ";
    const workStatus = line[1] || " ";
    let relPath = line.slice(3);
    if (relPath.includes(" -> ")) relPath = relPath.split(" -> ").pop();
    const status =
      indexStatus === "?" && workStatus === "?" ? "?" :
      indexStatus === "A" || workStatus === "A" ? "A" :
      indexStatus === "D" || workStatus === "D" ? "D" :
      indexStatus === "R" || workStatus === "R" ? "R" : "M";
    const staged = indexStatus !== " " && indexStatus !== "?";
    return {
      path: relPath,
      absPath: path.join(root, relPath),
      status,
      staged,
      index: indexStatus,
      worktree: workStatus,
    };
  });
}

function normalizeGitPath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

function isPathUnderDir(filePath, dirPath) {
  const file = normalizeGitPath(filePath);
  const dir = normalizeGitPath(dirPath);
  if (process.platform === "win32") {
    const fl = file.toLowerCase();
    const dl = dir.toLowerCase();
    return fl === dl || fl.startsWith(`${dl}/`);
  }
  return file === dir || file.startsWith(`${dir}/`);
}

async function gitRevParseRoot(cwd) {
  const res = await runGitEx(cwd, ["rev-parse", "--show-toplevel"]);
  if (!res.ok || !res.stdout) return null;
  return path.resolve(res.stdout);
}

function filterGitFilesUnderCwd(files, workspaceCwd) {
  return files.filter((f) => isPathUnderDir(f.absPath, workspaceCwd));
}

async function gitStatusFilesForRoot(repoRoot, workspaceCwd = null) {
  const out = await runGit(repoRoot, ["status", "--porcelain"]);
  let files = parseGitStatusPorcelain(out, repoRoot);
  if (workspaceCwd) files = filterGitFilesUnderCwd(files, workspaceCwd);
  return files;
}

ipcMain.handle("get-git-info", async (_e, cwd) => {
  const root = resolveWorkspaceCwd(cwd);
  const branch = await runGit(root, ["branch", "--show-current"]);
  const status = await runGit(root, ["status", "--short"]);
  const lines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  return { branch: branch || null, changes: lines.length, status };
});

ipcMain.handle("git-status-files", async (_e, cwd) => {
  const workspaceCwd = path.resolve(resolveWorkspaceCwd(cwd));
  const check = await runGitEx(workspaceCwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok) return { ok: false, error: check.error, files: [], repoRoot: null };
  const repoRoot = await gitRevParseRoot(workspaceCwd);
  if (!repoRoot) return { ok: false, error: "Not a git repository", files: [], repoRoot: null };
  const files = await gitStatusFilesForRoot(repoRoot, workspaceCwd);
  return { ok: true, files, repoRoot };
});

ipcMain.handle("git-branches", async (_e, cwd) => {
  const root = resolveWorkspaceCwd(cwd);
  const check = await runGitEx(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok) return { ok: false, error: check.error, branches: [], current: null };
  const out = await runGit(root, ["for-each-ref", "--format=%(refname:short)|%(HEAD)", "refs/heads/"]);
  const branches = out
    ? out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, head] = line.split("|");
      return { name, current: head === "*" };
    })
    : [];
  const current = branches.find((b) => b.current)?.name || (await runGit(root, ["branch", "--show-current"])) || null;
  return { ok: true, branches, current };
});

ipcMain.handle("git-checkout", async (_e, { cwd, branch }) => {
  const root = resolveWorkspaceCwd(cwd);
  const name = (branch || "").trim();
  if (!name) return { ok: false, error: "Branch name required." };
  const res = await runGitEx(root, ["checkout", name]);
  if (!res.ok) return { ok: false, error: res.error };
  const files = await gitStatusFilesForRoot(root);
  return { ok: true, branch: name, files };
});

ipcMain.handle("git-stage", async (_e, { cwd, files, all }) => {
  const root = resolveWorkspaceCwd(cwd);
  let res;
  if (all) {
    res = await runGitEx(root, ["add", "-A"]);
  } else if (files?.length) {
    res = await runGitEx(root, ["add", "--", ...files]);
  } else {
    return { ok: false, error: "No files specified." };
  }
  if (!res.ok) return { ok: false, error: res.error };
  const changed = await gitStatusFilesForRoot(root);
  return { ok: true, files: changed };
});

ipcMain.handle("git-commit", async (_e, { cwd, message }) => {
  const root = resolveWorkspaceCwd(cwd);
  const msg = (message || "").trim();
  if (!msg) return { ok: false, error: "Commit message required." };
  const res = await runGitEx(root, ["commit", "-m", msg]);
  if (!res.ok) return { ok: false, error: res.error };
  const files = await gitStatusFilesForRoot(root);
  return { ok: true, output: res.stdout, files };
});

ipcMain.handle("list-directory", (_e, dirPath) => {
  const target = dirPath || resolveWorkspaceCwd();
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { ok: false, path: target, entries: [] };
    }
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => ({
        name: d.name,
        path: path.join(target, d.name),
        isDirectory: d.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    return { ok: true, path: target, entries };
  } catch {
    return { ok: false, path: target, entries: [] };
  }
});

const MAX_READ_BYTES = 512 * 1024;

ipcMain.handle("read-file", (_e, filePath) => {
  try {
    const target = path.resolve(filePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { ok: false, error: "File not found." };
    }
    const size = fs.statSync(target).size;
    if (size > MAX_READ_BYTES) {
      return { ok: false, error: `File too large (${size} bytes). Max ${MAX_READ_BYTES}.` };
    }
    const content = fs.readFileSync(target, "utf8");
    return { ok: true, path: target, content };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

function isPathInWorkspace(filePath, cwd) {
  const root = path.resolve(resolveWorkspaceCwd(cwd));
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

ipcMain.handle("write-file", (_e, { filePath, content, cwd }) => {
  try {
    const target = path.resolve(filePath);
    if (!isPathInWorkspace(target, cwd)) {
      return { ok: false, error: "Path outside workspace." };
    }
    const text = String(content ?? "");
    if (Buffer.byteLength(text, "utf8") > MAX_READ_BYTES) {
      return { ok: false, error: "Content too large." };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("git-show-file", async (_e, { cwd, filePath, ref }) => {
  const root = resolveWorkspaceCwd(cwd);
  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return { ok: false, error: "Invalid path." };
  const r = await runGitEx(root, ["show", `${ref || "HEAD"}:${rel}`]);
  if (!r.ok) return { ok: false, error: r.error || "Not in git." };
  return { ok: true, content: r.stdout };
});

ipcMain.handle("check-for-updates", async () => {
  const current = app.getVersion();
  try {
    const https = require("https");
    const body = await new Promise((resolve, reject) => {
      https.get(
        "https://api.github.com/repos/KarnveerSG/Quill/releases/latest",
        { headers: { "User-Agent": "Quill-Desktop" } },
        (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => resolve(data));
        },
      ).on("error", reject);
    });
    const json = JSON.parse(body);
    const latest = (json.tag_name || "").replace(/^v/, "") || current;
    const updateAvailable = latest !== current;
    return { ok: true, current, latest, updateAvailable, url: json.html_url || null };
  } catch {
    return { ok: true, current, latest: current, updateAvailable: false, url: null };
  }
});

ipcMain.handle("search-content", async (_e, { cwd, query, limit }) => {
  const root = resolveWorkspaceCwd(cwd);
  const q = String(query || "").trim();
  const max = Math.min(Number(limit) || 50, 200);
  if (!q) return { ok: true, matches: [] };
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["grep", "-n", "-i", "--full-name", q, "--", "."],
      { cwd: root, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const matches = stdout.split(/\r?\n/).filter(Boolean).slice(0, max).map((line) => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      return m ? { path: path.resolve(root, m[1]), line: Number(m[2]), text: m[3] } : null;
    }).filter(Boolean);
    return { ok: true, matches };
  } catch {
    const matches = [];
    const skip = new Set(["node_modules", ".git", "dist", "build"]);
    function walk(dir, depth) {
      if (matches.length >= max || depth > 5) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        if (matches.length >= max) break;
        if (d.name.startsWith(".") || skip.has(d.name)) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full, depth + 1);
        else if (d.isFile() && fs.statSync(full).size < 256000) {
          try {
            const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
            lines.forEach((text, i) => {
              if (matches.length < max && text.toLowerCase().includes(q.toLowerCase())) {
                matches.push({ path: full, line: i + 1, text: text.trim().slice(0, 200) });
              }
            });
          } catch (_) {}
        }
      }
    }
    walk(root, 0);
    return { ok: true, matches };
  }
});

ipcMain.handle("list-symbols", (_e, { filePath }) => {
  try {
    const target = path.resolve(filePath);
    if (!fs.existsSync(target)) return { ok: false, symbols: [] };
    const ext = path.extname(target).toLowerCase();
    const lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
    const symbols = [];
    const patterns = ext === ".py"
      ? [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/]
      : [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, /^\s*(?:export\s+)?class\s+(\w+)/, /^\s*(?:const|let|var)\s+(\w+)\s*=/];
    lines.forEach((line, i) => {
      for (const re of patterns) {
        const m = line.match(re);
        if (m) symbols.push({ name: m[1], line: i + 1, kind: line.includes("class") ? "class" : "function" });
      }
    });
    return { ok: true, symbols: symbols.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), symbols: [] };
  }
});

ipcMain.handle("git-file-gutter", async (_e, { cwd, filePath }) => {
  const root = resolveWorkspaceCwd(cwd);
  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return { ok: false, lines: [] };
  const r = await runGitEx(root, ["diff", "-U0", "--", rel]);
  if (!r.ok) return { ok: true, lines: [] };
  const lines = [];
  let current = 0;
  for (const line of r.stdout.split(/\r?\n/)) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { current = Number(h[1]); continue; }
    if (line.startsWith("+") && !line.startsWith("+++")) lines.push({ line: current++, type: "add" });
    else if (line.startsWith("-") && !line.startsWith("---")) lines.push({ line: current, type: "del" });
    else if (line.startsWith(" ")) current++;
  }
  return { ok: true, lines };
});

function keybindingsPath() {
  return path.join(os.homedir(), ".quill", "keybindings.json");
}

ipcMain.handle("get-keybindings", () => {
  const file = keybindingsPath();
  if (!fs.existsSync(file)) return { ok: true, bindings: {} };
  try {
    return { ok: true, bindings: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ok: true, bindings: {} };
  }
});

ipcMain.handle("save-keybindings", (_e, bindings) => {
  const file = keybindingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bindings || {}, null, 2) + "\n", "utf8");
  return { ok: true };
});

ipcMain.handle("export-workspace-sync", (_e, state) => {
  const file = path.join(os.homedir(), ".quill", "workspace-sync.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ exportedAt: Date.now(), state }, null, 2) + "\n", "utf8");
  return { ok: true, path: file };
});

ipcMain.handle("import-workspace-sync", () => {
  const file = path.join(os.homedir(), ".quill", "workspace-sync.json");
  if (!fs.existsSync(file)) return { ok: false, error: "No sync file." };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: true, state: data.state };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("git-revert-file", async (_e, { cwd, filePath }) => {
  const root = resolveWorkspaceCwd(cwd);
  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, "/");
  const r = await runGitEx(root, ["checkout", "--", rel]);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
});

ipcMain.handle("git-diff", async (_e, { cwd, filePath }) => {
  const root = resolveWorkspaceCwd(cwd);
  const args = filePath ? ["diff", "--", filePath] : ["diff"];
  const out = await runGit(root, args);
  return { ok: true, diff: out || "(no changes)" };
});

ipcMain.handle("search-files", (_e, { cwd, query, limit }) => {
  const root = resolveWorkspaceCwd(cwd);
  const q = (query || "").toLowerCase();
  const max = Math.min(Number(limit) || 40, 100);
  const results = [];
  const skip = new Set(["node_modules", ".git", ".codegraph", "dist", "build", "__pycache__"]);
  function walk(dir, depth) {
    if (results.length >= max || depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (results.length >= max) break;
      if (d.name.startsWith(".") || skip.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full, depth + 1);
      else if (!q || d.name.toLowerCase().includes(q)) {
        results.push({ name: d.name, path: full, rel: path.relative(root, full) });
      }
    }
  }
  walk(root, 0);
  return { ok: true, files: results.slice(0, max) };
});

function historyDir(wsId) {
  const safe = String(wsId || "default").replace(/[^\w.-]/g, "_");
  return path.join(os.homedir(), ".quill", "history", safe);
}
ipcMain.handle("history-list", (_e, wsId) => {
  const dir = historyDir(wsId);
  if (!fs.existsSync(dir)) return { ok: true, items: [] };
  const items = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return { id: f.replace(/\.json$/, ""), ts: j.ts || 0, title: j.title || "", count: (j.messages || []).length };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.ts - a.ts);
  return { ok: true, items };
});
ipcMain.handle("history-save", (_e, { wsId, snapshot }) => {
  const dir = historyDir(wsId);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}`;
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(snapshot || {}, null, 2), "utf8");
  return { ok: true, id };
});
ipcMain.handle("history-load", (_e, { wsId, id }) => {
  const f = path.join(historyDir(wsId), `${id}.json`);
  if (!fs.existsSync(f)) return { ok: false, error: "not found" };
  try { return { ok: true, snapshot: JSON.parse(fs.readFileSync(f, "utf8")) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle("history-delete", (_e, { wsId, id }) => {
  const f = path.join(historyDir(wsId), `${id}.json`);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

function promptsPath() { return path.join(os.homedir(), ".quill", "prompts.json"); }
ipcMain.handle("get-prompts", () => {
  const f = promptsPath();
  if (!fs.existsSync(f)) return { ok: true, prompts: [] };
  try { return { ok: true, prompts: JSON.parse(fs.readFileSync(f, "utf8")) || [] }; }
  catch { return { ok: true, prompts: [] }; }
});
ipcMain.handle("save-prompts", (_e, prompts) => {
  const f = promptsPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(prompts || [], null, 2) + "\n", "utf8");
  return { ok: true };
});

ipcMain.handle("stat-path", (_e, p) => {
  try {
    const st = fs.statSync(path.resolve(p));
    return { ok: true, isDirectory: st.isDirectory(), isFile: st.isFile() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("test-mcp-server", async (_e, spec) => {
  const command = (spec?.command || "").trim();
  if (!command) return { ok: false, error: "Command required." };
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [command], { windowsHide: true });
    return { ok: true, message: `Command "${command}" found on PATH.` };
  } catch {
    return { ok: false, error: `Command "${command}" not found on PATH.` };
  }
});

app.on("before-quit", (e) => {
  if (shuttingDown) return;
  e.preventDefault();
  quitApp();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  syncWorkspaceWatcher(loadState());
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
