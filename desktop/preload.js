const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quill", {
  getBootstrap: () => ipcRenderer.invoke("get-bootstrap"),
  saveState: (state) => ipcRenderer.invoke("save-state", state),
  getEnv: () => ipcRenderer.invoke("get-env"),
  saveEnvKeys: (updates) => ipcRenderer.invoke("save-env-keys", updates),
  ptyCreate: (opts) => ipcRenderer.invoke("pty-create", opts),
  ptyWrite: (id, data) => ipcRenderer.invoke("pty-write", { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke("pty-resize", { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.invoke("pty-kill", { id }),
  onPtyData: (cb) => ipcRenderer.on("pty-data", (_e, payload) => cb(payload)),
  onPtyExit: (cb) => ipcRenderer.on("pty-exit", (_e, payload) => cb(payload)),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
