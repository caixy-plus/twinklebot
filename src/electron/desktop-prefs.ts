import fs from "node:fs";
import path from "node:path";

export interface DesktopPrefs {
  keepRunningInBackground: boolean;
}

export interface RectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopRuntimeState {
  pid: number;
  port: number;
  backendUrl: string;
  startedAt: number;
  lastSecondInstanceAt: number;
}

export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  keepRunningInBackground: true,
};

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpFile, filePath);
}

export function normalizeDesktopPrefs(raw: any): DesktopPrefs {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_DESKTOP_PREFS };
  }
  return {
    keepRunningInBackground:
      typeof raw.keepRunningInBackground === "boolean"
        ? raw.keepRunningInBackground
        : DEFAULT_DESKTOP_PREFS.keepRunningInBackground,
  };
}

export function loadDesktopPrefs(userDataDir: string): DesktopPrefs {
  const filePath = path.join(userDataDir, "desktop-prefs.json");
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return normalizeDesktopPrefs(parsed);
    }
  } catch {
    // fallback to defaults
  }
  return { ...DEFAULT_DESKTOP_PREFS };
}

export function saveDesktopPrefs(userDataDir: string, prefs: Partial<DesktopPrefs>): DesktopPrefs {
  const filePath = path.join(userDataDir, "desktop-prefs.json");
  const current = loadDesktopPrefs(userDataDir);
  const next = normalizeDesktopPrefs({ ...current, ...prefs });
  writeJsonAtomic(filePath, next);
  return next;
}

export function getDesktopRuntimePath(userDataDir: string): string {
  return path.join(userDataDir, "desktop-runtime.json");
}

export function readDesktopRuntime(userDataDir: string): DesktopRuntimeState | null {
  try {
    const filePath = getDesktopRuntimePath(userDataDir);
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    const pid = Number(raw.pid);
    const port = Number(raw.port);
    const backendUrl = typeof raw.backendUrl === "string" ? raw.backendUrl : "";
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      port: Number.isFinite(port) && port >= 0 ? port : 0,
      backendUrl,
      startedAt: Number(raw.startedAt) || 0,
      lastSecondInstanceAt: Number(raw.lastSecondInstanceAt) || 0,
    };
  } catch {
    return null;
  }
}

export function writeDesktopRuntime(
  userDataDir: string,
  state: DesktopRuntimeState
): DesktopRuntimeState {
  const filePath = getDesktopRuntimePath(userDataDir);
  const normalized: DesktopRuntimeState = {
    pid: Number(state.pid) || process.pid,
    port: Number(state.port) || 0,
    backendUrl: String(state.backendUrl || ""),
    startedAt: Number(state.startedAt) || Date.now(),
    lastSecondInstanceAt: Number(state.lastSecondInstanceAt) || 0,
  };
  writeJsonAtomic(filePath, normalized);
  return normalized;
}

export function clearDesktopRuntime(userDataDir: string): void {
  try {
    const filePath = getDesktopRuntimePath(userDataDir);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup failures on shutdown
  }
}

export function readSavedLocalControlToken(userDataDir: string): string {
  try {
    const cfgPath = path.join(userDataDir, "desktop-config.json");
    if (!fs.existsSync(cfgPath)) return "";
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    return typeof parsed?.TWINKLEBOT_LOCAL_TOKEN === "string"
      ? parsed.TWINKLEBOT_LOCAL_TOKEN.trim()
      : "";
  } catch {
    return "";
  }
}

export function isRectVisibleOnDisplays(bounds: RectBounds, workAreas: RectBounds[]): boolean {
  if (!workAreas || workAreas.length === 0) return true;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  const minOverlapX = Math.min(60, bounds.width);
  const minOverlapY = Math.min(40, bounds.height);
  return workAreas.some((area) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= minOverlapX && overlapY >= minOverlapY;
  });
}

export function computeTrayPopoverPosition(
  trayBounds: RectBounds,
  workArea: RectBounds,
  popoverSize: { width: number; height: number },
  platform: NodeJS.Platform = process.platform
): { x: number; y: number } {
  const margin = 6;
  const centeredX = Math.round(trayBounds.x + trayBounds.width / 2 - popoverSize.width / 2);
  const minX = workArea.x + margin;
  const maxX = Math.max(minX, workArea.x + workArea.width - popoverSize.width - margin);
  const x = Math.min(Math.max(centeredX, minX), maxX);

  // Determine whether tray sits near top or bottom of display work area
  const trayCenterY = trayBounds.y + trayBounds.height / 2;
  const workAreaMidY = workArea.y + workArea.height / 2;
  const isTopAnchored = platform === "darwin" || trayCenterY < workAreaMidY;

  let y: number;
  if (isTopAnchored) {
    y = Math.round(trayBounds.y + trayBounds.height + margin);
    const maxY = workArea.y + workArea.height - popoverSize.height - margin;
    y = Math.min(Math.max(y, workArea.y + margin), Math.max(workArea.y + margin, maxY));
  } else {
    y = Math.round(trayBounds.y - popoverSize.height - margin);
    y = Math.max(y, workArea.y + margin);
  }

  return { x, y };
}
