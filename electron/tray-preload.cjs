const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twinklebotTray", {
  getState() {
    return ipcRenderer.invoke("twinklebot-tray:get-state");
  },
  onStateUpdate(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("twinklebot-tray:state", handler);
    return () => ipcRenderer.removeListener("twinklebot-tray:state", handler);
  },
  runAction(action, payload) {
    return ipcRenderer.invoke("twinklebot-tray:action", action, payload);
  },
  setKeepInBackground(enabled) {
    return ipcRenderer.invoke("twinklebot-tray:set-keep-background", Boolean(enabled));
  },
  copyText(text) {
    return ipcRenderer.invoke("twinklebot-tray:copy-text", String(text || ""));
  },
  quitApp() {
    return ipcRenderer.invoke("twinklebot-tray:quit");
  },
});
