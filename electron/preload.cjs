const { contextBridge, ipcRenderer } = require("electron");

const platform = process.platform;
const arch = process.arch;

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.electron = "true";
  document.documentElement.dataset.platform = platform;
});

contextBridge.exposeInMainWorld("twinklebotDesktop", {
  isElectron: true,
  platform,
  arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  onMenuCommand(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, command, payload) => callback(command, payload);
    ipcRenderer.on("twinklebot:menu-command", handler);
    return () => ipcRenderer.removeListener("twinklebot:menu-command", handler);
  },
  getDesktopInfo() {
    return ipcRenderer.invoke("twinklebot:get-desktop-info");
  },
  loadAccounts() {
    return ipcRenderer.invoke("twinklebot:accounts-load");
  },
  saveAccounts(state) {
    return ipcRenderer.invoke("twinklebot:accounts-save", state);
  },
  quitApp() {
    return ipcRenderer.invoke("twinklebot:quit-app");
  },
  getOtaStatus() {
    return ipcRenderer.invoke("twinklebot:get-ota-status");
  },
  checkGithubManifest(opts) {
    return ipcRenderer.invoke("twinklebot:check-github-manifest", opts);
  },
  applyWebOta(payload) {
    return ipcRenderer.invoke("twinklebot:apply-web-ota", payload);
  },
  confirmWebOta(webBuild) {
    return ipcRenderer.invoke("twinklebot:confirm-web-ota", webBuild);
  },
  rollbackWebOta(mode) {
    return ipcRenderer.invoke("twinklebot:rollback-web-ota", mode);
  },
  downloadFullInstaller(payload) {
    return ipcRenderer.invoke("twinklebot:download-full-installer", payload);
  },
  onOtaProgress(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, ev) => callback(ev);
    ipcRenderer.on("twinklebot:ota-progress", handler);
    return () => ipcRenderer.removeListener("twinklebot:ota-progress", handler);
  },
});
