import {
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  ipcMain,
  nativeImage,
  screen,
  type MenuItemConstructorOptions,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { computeTrayPopoverPosition } from "./desktop-prefs.js";

export interface TrayStatusSnapshot {
  appVersion: string;
  backendUrl: string;
  port: number;
  botCount: number;
  groupCount: number;
  scheduleCount: number;
  activeRunCount: number;
  windowVisible: boolean;
  keepRunningInBackground: boolean;
  relayConfigured: boolean;
}

export interface TrayManagerOptions {
  appRoot: string;
  getStatusSnapshot: () => TrayStatusSnapshot;
  onShowWindow: () => void;
  onMenuCommand: (command: string, payload?: Record<string, any>) => void;
  onOpenInBrowser: () => void;
  onSetKeepInBackground: (enabled: boolean) => void;
  onQuit: () => void;
}

const POPOVER_WIDTH = 332;
const POPOVER_HEIGHT = 446;

export function createTrayManager(options: TrayManagerOptions) {
  let tray: Tray | null = null;
  let popoverWindow: BrowserWindow | null = null;
  let lastHiddenAt = 0;
  let disposed = false;

  function loadTrayIcon() {
    const buildDir = path.join(options.appRoot, "build");
    if (process.platform === "darwin") {
      const macTemplatePath = path.join(buildDir, "trayIconTemplate.png");
      if (fs.existsSync(macTemplatePath)) {
        const img = nativeImage.createFromPath(macTemplatePath);
        if (!img.isEmpty()) {
          img.setTemplateImage(true);
          return img;
        }
      }
    }
    const candidates =
      process.platform === "win32"
        ? [path.join(buildDir, "trayIcon.png"), path.join(buildDir, "icon.ico")]
        : [path.join(buildDir, "trayIcon.png")];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const img = nativeImage.createFromPath(candidate);
        if (!img.isEmpty()) return img;
      }
    }
    const fallbackPath = path.join(buildDir, "icon.png");
    return nativeImage.createFromPath(fallbackPath).resize({ width: 20, height: 20, quality: "best" });
  }

  function pushStateToPopover() {
    if (!popoverWindow || popoverWindow.isDestroyed()) return;
    const snap = options.getStatusSnapshot();
    popoverWindow.webContents.send("twinklebot-tray:state", snap);
  }

  function hidePopover() {
    if (!popoverWindow || popoverWindow.isDestroyed()) return;
    if (popoverWindow.isVisible()) {
      popoverWindow.hide();
      lastHiddenAt = Date.now();
    }
  }

  function ensurePopoverWindow(): BrowserWindow {
    if (popoverWindow && !popoverWindow.isDestroyed()) {
      return popoverWindow;
    }

    const isMac = process.platform === "darwin";
    const win = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      ...(isMac
        ? {
            vibrancy: "popover",
            visualEffectState: "active",
          }
        : {}),
      webPreferences: {
        preload: path.join(options.appRoot, "electron", "tray-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.on("blur", () => {
      hidePopover();
    });

    win.on("closed", () => {
      if (popoverWindow === win) {
        popoverWindow = null;
      }
    });

    win.loadFile(path.join(options.appRoot, "electron", "tray.html"));
    popoverWindow = win;
    return win;
  }

  function showPopover() {
    if (!tray || tray.isDestroyed()) return;
    const win = ensurePopoverWindow();
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: trayBounds.x + Math.round(trayBounds.width / 2),
      y: trayBounds.y + Math.round(trayBounds.height / 2),
    });
    const pos = computeTrayPopoverPosition(
      trayBounds,
      display.workArea,
      { width: POPOVER_WIDTH, height: POPOVER_HEIGHT },
      process.platform
    );

    const present = () => {
      pushStateToPopover();
      win.setPosition(pos.x, pos.y, false);
      win.show();
      win.focus();
    };

    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", present);
    } else {
      present();
    }
  }

  function togglePopover() {
    if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
      hidePopover();
      return;
    }
    // Avoid immediate reopen if blur just hid the popover on the same click
    if (Date.now() - lastHiddenAt < 180) {
      return;
    }
    showPopover();
  }

  function buildContextMenu() {
    const snap = options.getStatusSnapshot();
    const statusLine = snap.activeRunCount > 0
      ? `后台活跃中 · ${snap.activeRunCount} 个任务执行中`
      : `后台活跃中 · 端口 ${snap.port}`;
    const template: MenuItemConstructorOptions[] = [
      { label: "TwinkleBot", enabled: false },
      { label: statusLine, enabled: false },
      { type: "separator" },
      {
        label: snap.windowVisible ? "前置显示主窗口" : "打开 TwinkleBot 主窗口",
        click: () => options.onShowWindow(),
      },
      {
        label: "新建 Bot",
        click: () => options.onMenuCommand("new-bot"),
      },
      {
        label: "搜索聊天…",
        click: () => options.onMenuCommand("open-search"),
      },
      {
        label: "偏好设置…",
        click: () => options.onMenuCommand("open-settings", { tab: "general" }),
      },
      { type: "separator" },
      {
        label: "关闭窗口时保持后台运行",
        type: "checkbox",
        checked: snap.keepRunningInBackground,
        click: (menuItem) => {
          options.onSetKeepInBackground(Boolean(menuItem.checked));
          pushStateToPopover();
        },
      },
      { type: "separator" },
      {
        label: "退出 TwinkleBot",
        accelerator: "CmdOrCtrl+Q",
        click: () => options.onQuit(),
      },
    ];
    return Menu.buildFromTemplate(template);
  }

  function registerIpc() {
    ipcMain.removeHandler("twinklebot-tray:get-state");
    ipcMain.removeHandler("twinklebot-tray:action");
    ipcMain.removeHandler("twinklebot-tray:set-keep-background");
    ipcMain.removeHandler("twinklebot-tray:copy-text");
    ipcMain.removeHandler("twinklebot-tray:quit");

    ipcMain.handle("twinklebot-tray:get-state", () => options.getStatusSnapshot());
    ipcMain.handle("twinklebot-tray:action", (_ev, action: string) => {
      hidePopover();
      if (action === "show-window") {
        options.onShowWindow();
      } else if (action === "new-bot") {
        options.onMenuCommand("new-bot");
      } else if (action === "open-search") {
        options.onMenuCommand("open-search");
      } else if (action === "open-settings") {
        options.onMenuCommand("open-settings", { tab: "general" });
      } else if (action === "open-browser") {
        options.onOpenInBrowser();
      }
      return { ok: true };
    });
    ipcMain.handle("twinklebot-tray:set-keep-background", (_ev, enabled: boolean) => {
      options.onSetKeepInBackground(Boolean(enabled));
      pushStateToPopover();
      return { ok: true };
    });
    ipcMain.handle("twinklebot-tray:copy-text", (_ev, text: string) => {
      clipboard.writeText(String(text || ""));
      return { ok: true };
    });
    ipcMain.handle("twinklebot-tray:quit", () => {
      hidePopover();
      options.onQuit();
      return { ok: true };
    });
  }

  function updateTooltip() {
    if (!tray || tray.isDestroyed()) return;
    const snap = options.getStatusSnapshot();
    const runInfo = snap.activeRunCount > 0 ? ` (${snap.activeRunCount} 个执行中)` : "";
    tray.setToolTip(`TwinkleBot · 后台活跃${runInfo} · :${snap.port}`);
  }

  function init() {
    disposed = false;
    if (tray && !tray.isDestroyed()) return;
    registerIpc();
    tray = new Tray(loadTrayIcon());
    updateTooltip();

    tray.on("click", () => {
      togglePopover();
    });

    tray.on("double-click", () => {
      hidePopover();
      options.onShowWindow();
    });

    tray.on("right-click", () => {
      hidePopover();
      tray?.popUpContextMenu(buildContextMenu());
    });
  }

  function ensure() {
    if (disposed) return;
    if (!tray || tray.isDestroyed()) {
      try {
        init();
      } catch {
        // ignore if desktop shell tray host is not ready yet
      }
    }
  }

  function refresh() {
    if (disposed) return;
    ensure();
    updateTooltip();
    if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
      pushStateToPopover();
    }
  }

  function destroy() {
    disposed = true;
    hidePopover();
    if (popoverWindow && !popoverWindow.isDestroyed()) {
      popoverWindow.destroy();
      popoverWindow = null;
    }
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
  }

  return {
    init,
    ensure,
    refresh,
    destroy,
    hidePopover,
  };
}
