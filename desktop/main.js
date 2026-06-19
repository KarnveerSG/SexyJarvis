const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { INTEGRATIONS, SETTINGS_SECTIONS, CORE_ENV_KEYS } = require("./integrations");

const PERSONAS = ["Iris", "Thea", "Nova", "Sage", "Luna", "Wren"];
const RAINBOW = ["#FF6B6B", "#FF9F43", "#FECA57", "#1DD1A1", "#54A0FF", "#5F27CD", "#A29BFE"];

let mainWindow = null;
const terminals = new Map();
let termCounter = 0;

function quillCliPath() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Quill", "quill.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "quill", "quill.exe"),
    path.join(__dirname, "..", "dist", "quill.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "quill";
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
  const keys = Object.keys(data).sort();
  for (const k of keys) {
    if (data[k]) lines.push(`${k}=${data[k]}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function integrationStatus(env, integration) {
  const connected = integration.keys.every((k) => Boolean((env[k.env] || "").trim()));
  return connected ? "connected" : "disconnected";
}

function defaultWorkspaces() {
  const home = os.homedir();
  return [
    { id: "ws-1", name: "Workspace 1", color: RAINBOW[0], cwd: home, panes: 4 },
    { id: "ws-2", name: "Workspace 2", color: RAINBOW[2], cwd: home, panes: 4 },
    { id: "ws-3", name: "Projects", color: RAINBOW[4], cwd: home, panes: 4 },
  ];
}

function statePath() {
  return path.join(app.getPath("userData"), "quill-state.json");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return { workspaces: defaultWorkspaces(), activeWorkspace: "ws-1", theme: "dark" };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0d0d12",
    title: ".quill",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
    for (const [id, t] of terminals) {
      try { t.proc.kill(); } catch (_) {}
      terminals.delete(id);
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function spawnTerm(id, opts) {
  const cwd = opts.cwd || os.homedir();
  const mode = opts.mode || "agent";
  const persona = opts.persona || "Iris";
  const shellExe = process.env.COMSPEC || "powershell.exe";

  let cmd, args;
  if (mode === "agent" || mode === "hybrid") {
    cmd = quillCliPath();
    args = ["-w", cwd];
  } else {
    cmd = shellExe;
    args = ["-NoLogo", "-NoExit", "-Command", "-"];
  }

  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, TERM: "xterm-256color", QUILL_PERSONA: persona },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  terminals.set(id, { proc, persona, mode, cwd });

  const emit = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-data", { id, data: data.toString() });
    }
  };
  proc.stdout.on("data", emit);
  proc.stderr.on("data", emit);
  proc.on("exit", (code) => {
    terminals.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-exit", { id, exitCode: code });
    }
  });
  proc.on("error", (err) => emit(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`));

  return { id, persona, mode };
}

ipcMain.handle("get-bootstrap", () => {
  const env = parseEnvFile(envPath());
  const integrations = INTEGRATIONS.map((i) => ({
    ...i,
    status: integrationStatus(env, i),
    keys: i.keys.map((k) => ({ ...k, set: Boolean((env[k.env] || "").trim()) })),
  }));
  const connected = integrations.filter((i) => i.status === "connected").length;
  return {
    state: loadState(),
    personas: PERSONAS,
    rainbow: RAINBOW,
    quillPath: quillCliPath(),
    envPath: envPath(),
    version: app.getVersion(),
    settingsSections: SETTINGS_SECTIONS,
    integrations,
    integrationsSummary: `${connected} of ${INTEGRATIONS.length} connected`,
    coreEnvKeys: CORE_ENV_KEYS.map((k) => ({ ...k, set: Boolean((env[k.env] || "").trim()) })),
  };
});

ipcMain.handle("save-state", (_e, state) => {
  saveState(state);
  return true;
});

ipcMain.handle("get-env", () => {
  const env = parseEnvFile(envPath());
  const masked = {};
  for (const [k, v] of Object.entries(env)) {
    masked[k] = v ? "••••••••" : "";
  }
  return { path: envPath(), keys: Object.keys(env), masked, raw: env };
});

ipcMain.handle("save-env-keys", (_e, updates) => {
  const file = envPath();
  const env = parseEnvFile(file);
  for (const [k, v] of Object.entries(updates || {})) {
    if (v === "" || v === null || v === undefined) delete env[k];
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

ipcMain.handle("pty-create", (_e, opts) => {
  const id = `term-${++termCounter}`;
  return spawnTerm(id, opts);
});

ipcMain.handle("pty-write", (_e, { id, data }) => {
  const t = terminals.get(id);
  if (t?.proc?.stdin?.writable) t.proc.stdin.write(data);
});

ipcMain.handle("pty-resize", () => {});

ipcMain.handle("pty-kill", (_e, { id }) => {
  const t = terminals.get(id);
  if (t) {
    try { t.proc.kill(); } catch (_) {}
    terminals.delete(id);
  }
});

ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
