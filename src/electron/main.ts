import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  ipcMain,
  nativeTheme,
  screen,
  type MenuItemConstructorOptions,
} from "electron";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDesktopConfig } from "./env-loader.js";
import {
  clearDesktopRuntime,
  isRectVisibleOnDisplays,
  loadDesktopPrefs,
  readDesktopRuntime,
  readSavedLocalControlToken,
  saveDesktopPrefs,
  writeDesktopRuntime,
} from "./desktop-prefs.js";
import { createTrayManager } from "./tray.js";
import { normalizeAccountsState } from "../shared/accounts-store.js";
import { createStore } from "../store/index.js";
import { createModel } from "../agent/model.js";
import { createLocalAwareExecutorClient } from "../lib/bot-computer-provisioner.js";
import { createRunner } from "../agent/runner.js";
import { createScheduler } from "../agent/scheduler.js";
import { createServer } from "../server/index.js";
import { resolveProjectRoot } from "../lib/project-root.js";
import {
  fetchLatestGithubManifest,
  isTrustedGithubReleaseUrl,
} from "../lib/github-releases.js";
import { stopWslKeepalive } from "../lib/wsl-ubuntu.js";
import { createWebOtaManager } from "./web-ota.js";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = resolveProjectRoot(__dirname);

let mainWindow: BrowserWindow | null = null;
let backendServer: http.Server | null = null;
let backendUrl: string | null = null;
let actualBackendPort = 0;
let backendStore: ReturnType<typeof createStore> | null = null;
let backendRunner: any = null;
let backendScheduler: any = null;
let desktopConfig: any = null;
let trayManager: ReturnType<typeof createTrayManager> | null = null;
let webOtaManager: ReturnType<typeof createWebOtaManager> | null = null;
let unsubscribeRunner: (() => void) | null = null;
let isQuitting = false;
let keepRunningInBackground = true;
let pendingShowWindow = false;
let hiddenToBackground = false;
const processStartedAt = Date.now();
let lastSecondInstanceAt = 0;

// Set application display name on macOS menu bar & Dock, and AppUserModelId on Windows
app.setName("TwinkleBot");
if (process.platform === "win32") {
  app.setAppUserModelId("com.twinklebot.desktop");
}

app.commandLine.appendSwitch("force-renderer-accessibility");

const initialUserDataDir = app.getPath("userData");
const ackBeforeSecondInstance = readDesktopRuntime(initialUserDataDir)?.lastSecondInstanceAt || 0;

function persistRuntimeState() {
  const dir = desktopConfig?.userDataDir || app.getPath("userData");
  try {
    writeDesktopRuntime(dir, {
      pid: process.pid,
      port: actualBackendPort || desktopConfig?.port || 0,
      backendUrl: backendUrl || "",
      startedAt: processStartedAt,
      lastSecondInstanceAt,
    });
  } catch {
    // ignore runtime telemetry write failures
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return !isPidAlive(pid);
}

async function handleSecondInstanceFallback(userDataDir: string, beforeAckAt: number): Promise<void> {
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    const rt = readDesktopRuntime(userDataDir);
    if (rt && rt.lastSecondInstanceAt > beforeAckAt) {
      app.exit(0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  // Chromium ProcessSingleton could not notify the running instance (e.g. UAC elevation/UIPI, isolated desktop session, or frozen UI).
  const runtime = readDesktopRuntime(userDataDir);
  const localToken = readSavedLocalControlToken(userDataDir);
  let wakeSucceeded = false;
  if (runtime?.backendUrl && localToken) {
    try {
      const wakeRes = await fetch(`${runtime.backendUrl}/api/desktop/wake`, {
        method: "POST",
        headers: { "x-local-token": localToken },
        signal: AbortSignal.timeout(2500),
      });
      if (wakeRes.ok) {
        wakeSucceeded = true;
      }
    } catch {
      wakeSucceeded = false;
    }
  }

  try {
    await app.whenReady();
    if (wakeSucceeded && runtime) {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "TwinkleBot",
        message: `TwinkleBot 后台服务正在运行（端口 ${runtime.port || 3230}）`,
        detail:
          "当前桌面未能直接唤起已运行实例的窗口（可能它运行在管理员权限或另一个桌面会话中）。您可以将其重启到当前桌面，或直接在浏览器中打开。",
        buttons: ["在此重启并打开窗口", "在浏览器中打开", "取消"],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) {
        try {
          if (localToken) {
            await fetch(`${runtime.backendUrl}/api/desktop/quit`, {
              method: "POST",
              headers: { "x-local-token": localToken },
              signal: AbortSignal.timeout(1500),
            });
          }
        } catch {}
        const exitedCleanly = await waitForPidExit(runtime.pid, 1800);
        if (!exitedCleanly && isPidAlive(runtime.pid)) {
          try {
            process.kill(runtime.pid, "SIGKILL");
          } catch {}
          await waitForPidExit(runtime.pid, 1000);
        }
        app.relaunch();
      } else if (response === 1) {
        await shell.openExternal(runtime.backendUrl).catch(() => {});
      }
      app.exit(0);
      return;
    }

    const pidNote = runtime?.pid ? `（PID ${runtime.pid}）` : "";
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "TwinkleBot",
      message: `TwinkleBot 已在后台运行${pidNote}，但未响应窗口唤醒信号`,
      detail: "可能是旧进程窗口无响应或状态异常。是否结束旧进程并重新打开 TwinkleBot？",
      buttons: ["结束旧进程并重新打开", "取消"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      if (runtime?.pid && isPidAlive(runtime.pid)) {
        try {
          process.kill(runtime.pid, "SIGTERM");
        } catch {}
        const stopped = await waitForPidExit(runtime.pid, 1500);
        if (!stopped && isPidAlive(runtime.pid)) {
          try {
            process.kill(runtime.pid, "SIGKILL");
          } catch {}
          await waitForPidExit(runtime.pid, 1000);
        }
      }
      app.relaunch();
    }
  } catch {
    // ignore UI fallback errors during shutdown
  }
  app.exit(0);
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  void handleSecondInstanceFallback(initialUserDataDir, ackBeforeSecondInstance);
} else {
  app.on("second-instance", () => {
    lastSecondInstanceAt = Math.max(Date.now(), lastSecondInstanceAt + 1);
    persistRuntimeState();
    pendingShowWindow = true;
    void showMainWindow();
  });
}

function createSafeModel(apiKey: string, getProviders: () => any[]) {
  return createModel({ apiKey: apiKey || "", getProviders });
}

async function startEmbeddedBackend() {
  desktopConfig = resolveDesktopConfig({
    env: process.env,
    appRoot: APP_ROOT,
    userDataDir: app.getPath("userData"),
    isPackaged: app.isPackaged,
  });

  const store = createStore(desktopConfig.dataDir);
  backendStore = store;
  const model = createSafeModel(
    desktopConfig.geminiApiKey,
    () => store.readSettings()?.providers || []
  );
  const executor = createLocalAwareExecutorClient({
    url: desktopConfig.executorUrl,
    token: desktopConfig.executorToken || "unconfigured-token",
    deployEnv: desktopConfig.deployEnv,
    store,
  });

  backendRunner = createRunner({
    store,
    config: desktopConfig,
    model,
    executor,
  });
  unsubscribeRunner?.();
  unsubscribeRunner = backendRunner.subscribe(() => {
    trayManager?.refresh();
  });
  backendScheduler = createScheduler({
    store,
    runner: backendRunner,
  });

  store.markInterrupted();
  backendScheduler.start();

  webOtaManager = createWebOtaManager({
    userDataDir: desktopConfig.userDataDir || app.getPath("userData"),
    appVersion: app.getVersion(),
    builtInPublicDir: path.join(APP_ROOT, "public"),
    watchdogTimeoutMs: 5000,
    onReloadRequest: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.webContents.session
          .clearCache()
          .catch(() => {})
          .finally(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.reloadIgnoringCache();
            }
          });
      }
    },
    onProgress: (ev) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("twinklebot:ota-progress", ev);
      }
    },
  });

  const server = createServer({
    config: desktopConfig,
    store,
    runner: backendRunner,
    executor,
    model,
    scheduler: backendScheduler,
    getEffectivePublicDir: () =>
      webOtaManager?.getEffectivePublicDir() || path.join(APP_ROOT, "public"),
    otaController: {
      getStatus: () => webOtaManager?.getStatus() || null,
      confirmReady: (webBuild) => webOtaManager?.confirmReady(webBuild) || null,
      rollback: (reason) => webOtaManager?.rollback(reason) || null,
    },
    desktopController: {
      wakeWindow: async () => {
        pendingShowWindow = true;
        const win = await showMainWindow();
        return {
          pid: process.pid,
          windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
        };
      },
      quitApp: () => {
        quitAppCleanly();
      },
    },
  });
  backendServer = server;

  await new Promise<void>((resolve, reject) => {
    const tryListen = (portToBind: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err?.code === "EADDRINUSE" && portToBind !== 0) {
          server.off("error", onError);
          tryListen(0);
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(portToBind, desktopConfig.host, () => {
        server.off("error", onError);
        resolve();
      });
    };
    tryListen(desktopConfig.port);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : desktopConfig.port;
  actualBackendPort = actualPort;
  const clientHost =
    !desktopConfig.host || desktopConfig.host === "0.0.0.0" ? "127.0.0.1" : desktopConfig.host;
  backendUrl = `http://${clientHost}:${actualPort}`;
  persistRuntimeState();
  return backendUrl;
}

async function showMainWindow(): Promise<BrowserWindow | null> {
  if (process.platform === "darwin" && app.dock) {
    try {
      await app.dock.show();
    } catch {}
  }
  trayManager?.ensure?.();
  let win = mainWindow;
  if (win && !win.isDestroyed() && win.webContents.isCrashed()) {
    try {
      win.destroy();
    } catch {}
    win = null;
    mainWindow = null;
  }
  if (!win || win.isDestroyed()) {
    win = createMainWindow();
  }
  if (!win) return null;
  pendingShowWindow = false;
  hiddenToBackground = false;
  try {
    win.setSkipTaskbar(false);
  } catch {}
  try {
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    if (!isRectVisibleOnDisplays(win.getBounds(), workAreas)) {
      win.center();
    }
  } catch {}
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  if (process.platform === "win32") {
    // Briefly toggle alwaysOnTop so Windows DWM raises a background-restored window reliably
    const wasAlwaysOnTop = win.isAlwaysOnTop();
    if (!wasAlwaysOnTop) {
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    }
  }
  win.focus();
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  trayManager?.refresh();
  return win;
}

function hideMainWindowToBackground(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  hiddenToBackground = true;
  win.hide();
  if (process.platform === "darwin" && app.dock && keepRunningInBackground && !isQuitting) {
    try {
      app.dock.hide();
    } catch {}
  }
  trayManager?.refresh();
}

function quitAppCleanly() {
  isQuitting = true;
  trayManager?.destroy();
  app.quit();
}

function buildTraySnapshot() {
  let botCount = 0;
  let groupCount = 0;
  let scheduleCount = 0;
  try {
    const sessions = backendStore?.listSessions?.() || [];
    for (const s of sessions) {
      if (s?.type === "group" || s?.isGroup) groupCount += 1;
      else botCount += 1;
    }
    const schedules = backendStore?.readSchedules?.() || [];
    scheduleCount = schedules.filter((item: any) => item?.enabled !== false).length;
  } catch {
    // ignore telemetry errors
  }

  let activeRunCount = 0;
  try {
    activeRunCount = Object.keys(backendRunner?.activeSessions?.() || {}).length;
  } catch {
    activeRunCount = 0;
  }

  const relayConfigured = fs.existsSync(path.join(os.homedir(), ".config", "twinklebot-frpc", "frpc.toml"));
  const windowVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());

  return {
    appVersion: app.getVersion(),
    backendUrl: backendUrl || "",
    port: actualBackendPort || desktopConfig?.port || 3230,
    botCount,
    groupCount,
    scheduleCount,
    activeRunCount,
    windowVisible,
    keepRunningInBackground,
    relayConfigured,
  };
}

function sendMenuCommand(command: string, payload: Record<string, any> = {}) {
  void showMainWindow().then((win) => {
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => {
        if (!win.isDestroyed()) {
          win.webContents.send("twinklebot:menu-command", command, payload);
        }
      });
      return;
    }
    win.webContents.send("twinklebot:menu-command", command, payload);
  });
}

function buildApplicationMenu() {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "TwinkleBot",
            submenu: [
              { role: "about" as const, label: "关于 TwinkleBot" },
              {
                label: "检查更新…",
                click: () => sendMenuCommand("open-settings", { tab: "updates" }),
              },
              { type: "separator" as const },
              {
                label: "设置…",
                accelerator: "CmdOrCtrl+,",
                click: () => sendMenuCommand("open-settings", { tab: "general" }),
              },
              { type: "separator" as const },
              { role: "services" as const, label: "服务" },
              { type: "separator" as const },
              { role: "hide" as const, label: "隐藏 TwinkleBot" },
              { role: "hideOthers" as const, label: "隐藏其他" },
              { role: "unhide" as const, label: "全部显示" },
              { type: "separator" as const },
              { role: "quit" as const, label: "退出 TwinkleBot" },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        {
          label: "新建 Bot",
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuCommand("new-bot"),
        },
        {
          label: "新建 Bot 群聊",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => sendMenuCommand("new-group"),
        },
        {
          label: "搜索 Bot 与聊天…",
          accelerator: "CmdOrCtrl+K",
          click: () => sendMenuCommand("open-search"),
        },
        { type: "separator" },
        isMac
          ? { role: "close", label: "关闭窗口" }
          : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        {
          label: "切换紧凑侧边栏",
          accelerator: "CmdOrCtrl+\\",
          click: () => sendMenuCommand("toggle-compact-sidebar"),
        },
        {
          label: "切换右侧对话详情",
          accelerator: "CmdOrCtrl+I",
          click: () => sendMenuCommand("toggle-inspector"),
        },
        {
          label: "打开 Bot 的电脑 (全屏桌面)",
          accelerator: "Ctrl+CmdOrCtrl+C",
          click: () => sendMenuCommand("open-computer"),
        },
        { type: "separator" },
        {
          label: "外观主题",
          submenu: [
            {
              label: "跟随系统",
              click: () => sendMenuCommand("set-theme", { theme: "system" }),
            },
            {
              label: "浅色模式",
              click: () => sendMenuCommand("set-theme", { theme: "light" }),
            },
            {
              label: "深色模式",
              click: () => sendMenuCommand("set-theme", { theme: "dark" }),
            },
          ],
        },
        { type: "separator" },
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏幕" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const, label: "前置全部窗口" },
            ]
          : [{ role: "close" as const, label: "关闭" }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  if (!backendUrl) return null;

  const isMac = process.platform === "darwin";
  const initialBg = nativeTheme.shouldUseDarkColors ? "#161616" : "#ffffff";
  const windowIcon = path.join(
    APP_ROOT,
    "build",
    process.platform === "win32" ? "icon.ico" : "icon.png"
  );

  const win = new BrowserWindow({
    title: "TwinkleBot",
    width: 1360,
    height: 840,
    minWidth: 560,
    minHeight: 540,
    center: true,
    show: false,
    backgroundColor: initialBg,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {
          icon: windowIcon,
          autoHideMenuBar: true,
        }),
    webPreferences: {
      preload: path.join(APP_ROOT, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    if (!hiddenToBackground && !win.isDestroyed()) {
      win.show();
    }
  });

  const emitScrollTouch = (phase: "begin" | "fling" | "end") => {
    if (!win.isDestroyed()) {
      win.webContents.send("twinklebot:scroll-touch", {
        phase,
        active: phase === "begin",
      });
    }
  };
  win.webContents.on("input-event", (_event, inputEvent) => {
    if (inputEvent.type === "gestureScrollBegin") {
      emitScrollTouch("begin");
    } else if (inputEvent.type === "gestureFlingStart") {
      emitScrollTouch("fling");
    } else if (inputEvent.type === "gestureScrollEnd") {
      emitScrollTouch("end");
    }
  });
  win.on("blur", () => emitScrollTouch("end"));

  // Handle target="_blank" / window.open safely
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (backendUrl && url.startsWith(backendUrl)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 980,
          height: 720,
          title: "TwinkleBot 预览",
          autoHideMenuBar: true,
        },
      };
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  win.on("close", (event) => {
    if (!isQuitting && keepRunningInBackground && win === mainWindow) {
      event.preventDefault();
      if (win.isFullScreen()) {
        win.once("leave-full-screen", () => {
          if (!isQuitting && !win.isDestroyed()) {
            hideMainWindowToBackground(win);
          }
        });
        win.setFullScreen(false);
      } else {
        hideMainWindowToBackground(win);
      }
    }
  });

  win.on("show", () => {
    trayManager?.refresh();
  });

  win.on("hide", () => {
    trayManager?.refresh();
  });

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
    trayManager?.refresh();
  });

  win.webContents.on("did-fail-load", (_ev, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      webOtaManager?.notifyRenderFailure(`页面加载失败 (${errorCode}: ${errorDescription})`);
      if (!hiddenToBackground && !win.isDestroyed() && !win.isVisible()) {
        win.show();
      }
    }
  });

  win.webContents.on("render-process-gone", (_ev, details) => {
    webOtaManager?.notifyRenderFailure(`渲染进程异常退出 (${details?.reason || "unknown"})`);
  });

  win.loadURL(backendUrl);
  mainWindow = win;
  return win;
}

ipcMain.handle("twinklebot:get-desktop-info", () => ({
  platform: process.platform,
  arch: process.arch,
  platformArch: `${process.platform}-${process.arch}`,
  appVersion: app.getVersion(),
  backendUrl,
  localControlToken: desktopConfig?.localControlToken || "",
  deployEnv: desktopConfig?.deployEnv || "local",
  dataDir: desktopConfig?.dataDir || "",
  isConfigured: Boolean(desktopConfig?.isConfigured),
}));

ipcMain.handle("twinklebot:accounts-load", () => {
  const userDataDir = desktopConfig?.userDataDir || app.getPath("userData");
  const filePath = path.join(userDataDir, "accounts.json");
  let raw = null;
  try {
    if (fs.existsSync(filePath)) {
      raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    raw = null;
  }
  return normalizeAccountsState(raw, backendUrl || "");
});

ipcMain.handle("twinklebot:accounts-save", (_event, nextState) => {
  const userDataDir = desktopConfig?.userDataDir || app.getPath("userData");
  const filePath = path.join(userDataDir, "accounts.json");
  const normalized = normalizeAccountsState(nextState, backendUrl || "");
  fs.mkdirSync(userDataDir, { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(normalized, null, 2), "utf-8");
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(tmpFile, 0o600);
    } catch {}
  }
  fs.renameSync(tmpFile, filePath);
  return normalized;
});

ipcMain.handle("twinklebot:quit-app", () => {
  quitAppCleanly();
  return { ok: true };
});

ipcMain.handle("twinklebot:get-ota-status", () => {
  const st = webOtaManager?.getStatus() || null;
  return st
    ? {
        ...st,
        platformArch: `${process.platform}-${process.arch}`,
      }
    : null;
});

ipcMain.handle("twinklebot:check-github-manifest", async (_event, opts) => {
  try {
    const res = await fetchLatestGithubManifest({
      projectRoot: desktopConfig?.projectRoot,
      currentAppVersion: app.getVersion(),
      force: Boolean(opts?.force),
    });
    return {
      ok: true,
      ...res,
      platformArch: `${process.platform}-${process.arch}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      code: String(err?.code || "GITHUB_UNREACHABLE"),
      error: String(err?.message || "检查版本更新失败"),
      platformArch: `${process.platform}-${process.arch}`,
    };
  }
});

ipcMain.handle("twinklebot:apply-web-ota", async (_event, payload) => {
  if (!webOtaManager) throw new Error("OTA manager unavailable");
  return await webOtaManager.applyFromUrl({
    bundleUrl: String(payload?.bundleUrl || ""),
    expectedSha256: String(payload?.sha256 || payload?.expectedSha256 || ""),
    webBuild: String(payload?.webBuild || ""),
  });
});

ipcMain.handle("twinklebot:confirm-web-ota", (_event, webBuild) => {
  return webOtaManager?.confirmReady(typeof webBuild === "string" ? webBuild : undefined) || null;
});

ipcMain.handle("twinklebot:rollback-web-ota", (_event, mode) => {
  if (!webOtaManager) return null;
  if (mode === "builtin") {
    return webOtaManager.rollbackToBuiltIn();
  }
  return webOtaManager.rollback("用户手动触发回滚上一稳定版本");
});

ipcMain.handle("twinklebot:download-full-installer", async (_event, payload) => {
  const url = String(payload?.downloadUrl || "").trim();
  if (!isTrustedGithubReleaseUrl(url)) {
    throw new Error(`未受信任的 GitHub 安装包地址: ${url}`);
  }
  const safeName = String(payload?.fileName || path.basename(new URL(url).pathname) || "TwinkleBot-update")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const expectedSha = String(payload?.sha256 || "").trim().toLowerCase();
  const downloadsDir = app.getPath("downloads");
  const destPath = path.join(downloadsDir, safeName);

  const emit = (phase: string, percent: number, message: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("twinklebot:ota-progress", {
        phase,
        percent,
        message,
      });
    }
  };

  emit("downloading", 15, `正在下载安装包 ${safeName}…`);
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`下载安装包失败: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedSha && /^[a-f0-9]{64}$/.test(expectedSha)) {
    emit("verifying", 80, "正在校验安装包完整性…");
    const actualSha = crypto.createHash("sha256").update(buf).digest("hex");
    if (actualSha !== expectedSha) {
      throw new Error("安装包 SHA-256 校验失败，已终止打开");
    }
  }
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.writeFileSync(destPath, buf);
  emit("done", 100, `已保存至下载目录: ${safeName}`);
  await shell.openPath(destPath).catch(() => {});
  return { ok: true, filePath: destPath };
});

if (gotSingleLock) {
  persistRuntimeState();

  app.whenReady().then(async () => {
    try {
      app.accessibilitySupportEnabled = true;
      if (process.platform === "darwin" && app.dock) {
        const iconPath = path.join(APP_ROOT, "build", "icon.png");
        try {
          app.dock.setIcon(iconPath);
        } catch {
          // ignore if icon missing in dev
        }
      }
      keepRunningInBackground = loadDesktopPrefs(app.getPath("userData")).keepRunningInBackground;
      await startEmbeddedBackend();

      trayManager = createTrayManager({
        appRoot: APP_ROOT,
        getStatusSnapshot: buildTraySnapshot,
        onShowWindow: () => {
          void showMainWindow();
        },
        onMenuCommand: (command, payload) => {
          sendMenuCommand(command, payload);
        },
        onOpenInBrowser: () => {
          if (backendUrl) {
            shell.openExternal(backendUrl).catch(() => {});
          }
        },
        onSetKeepInBackground: (enabled) => {
          const saved = saveDesktopPrefs(desktopConfig?.userDataDir || app.getPath("userData"), {
            keepRunningInBackground: enabled,
          });
          keepRunningInBackground = saved.keepRunningInBackground;
          trayManager?.refresh();
        },
        onQuit: () => {
          quitAppCleanly();
        },
      });
      try {
        trayManager.init();
      } catch (trayErr) {
        console.warn("Tray initialization failed; continuing desktop launch:", trayErr);
      }

      buildApplicationMenu();
      const win = createMainWindow();
      if (win) {
        await win.webContents.session.clearCache().catch(() => {});
        if (pendingShowWindow) {
          void showMainWindow();
        }
      }
    } catch (err) {
      console.error("Failed to start TwinkleBot Electron desktop app:", err);
      quitAppCleanly();
    }

    app.on("activate", () => {
      void showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (isQuitting || (!keepRunningInBackground && process.platform !== "darwin")) {
      quitAppCleanly();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    clearDesktopRuntime(desktopConfig?.userDataDir || app.getPath("userData"));
    try {
      webOtaManager?.dispose();
    } catch {}
    try {
      unsubscribeRunner?.();
      unsubscribeRunner = null;
    } catch {}
    try {
      trayManager?.destroy();
    } catch {}
    try {
      backendScheduler?.stop?.();
    } catch {}
    try {
      backendRunner?.stop?.();
    } catch {}
    try {
      backendServer?.close?.();
    } catch {}
    try {
      stopWslKeepalive();
    } catch {}
  });
}
