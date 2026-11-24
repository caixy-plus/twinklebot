export type BrowserAutomationMode = "bot_computer" | "local_headless" | "local_debug";
export type BotBrowserModeOverride = "inherit" | BrowserAutomationMode;

export interface BrowserAutomationSettings {
  mode: BrowserAutomationMode;
  debugPort: number;
  executablePath: string;
}

export interface LocalBrowserStatusInfo {
  available: boolean;
  executablePath: string;
  debugPort: number;
  debugReachable: boolean;
  activeSessions: number;
  profileDir?: string;
}

export const VALID_BROWSER_AUTOMATION_MODES: readonly BrowserAutomationMode[] = [
  "bot_computer",
  "local_headless",
  "local_debug",
] as const;

export const VALID_BOT_BROWSER_MODES: readonly BotBrowserModeOverride[] = [
  "inherit",
  "bot_computer",
  "local_headless",
  "local_debug",
] as const;

export const DEFAULT_BROWSER_DEBUG_PORT = 9223;

export const DEFAULT_BROWSER_AUTOMATION_SETTINGS: BrowserAutomationSettings = {
  mode: "bot_computer",
  debugPort: DEFAULT_BROWSER_DEBUG_PORT,
  executablePath: "",
};

export const BROWSER_AUTOMATION_TOOLS = new Set<string>([
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_tabs",
  "browser_scroll",
  "browser_wait",
  "browser_select",
  "browser_upload_file",
]);

export function isBrowserAutomationTool(toolName: string): boolean {
  return BROWSER_AUTOMATION_TOOLS.has(String(toolName || ""));
}

export function normalizeBrowserAutomationMode(raw: unknown): BrowserAutomationMode {
  const s = String(raw || "").trim();
  if (s === "local_headless" || s === "local_debug" || s === "bot_computer") {
    return s;
  }
  return "bot_computer";
}

export function normalizeBotBrowserMode(raw: unknown): BotBrowserModeOverride {
  const s = String(raw || "").trim();
  if (s === "bot_computer" || s === "local_headless" || s === "local_debug") {
    return s;
  }
  return "inherit";
}

export function normalizeBrowserDebugPort(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BROWSER_DEBUG_PORT;
  const rounded = Math.round(n);
  if (rounded < 1024 || rounded > 65535) return DEFAULT_BROWSER_DEBUG_PORT;
  return rounded;
}

export function normalizeBrowserAutomationSettings(
  raw: unknown
): BrowserAutomationSettings {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const executablePath =
    typeof src.executablePath === "string"
      ? src.executablePath.trim().slice(0, 512)
      : "";
  return {
    mode: normalizeBrowserAutomationMode(src.mode),
    debugPort: normalizeBrowserDebugPort(src.debugPort),
    executablePath,
  };
}

export function resolveEffectiveBrowserMode(
  globalSettings: Partial<BrowserAutomationSettings> | null | undefined,
  sessionBrowserMode?: unknown
): BrowserAutomationMode {
  const override = normalizeBotBrowserMode(sessionBrowserMode);
  if (override !== "inherit") return override;
  return normalizeBrowserAutomationMode(globalSettings?.mode);
}

export function formatBrowserAutomationModeLabel(
  mode: BrowserAutomationMode | BotBrowserModeOverride
): string {
  switch (mode) {
    case "local_headless":
      return "本机 Chrome Headless";
    case "local_debug":
      return "本机 Chrome Debug";
    case "bot_computer":
      return "Bot 电脑 Chrome";
    default:
      return "跟随全局设置";
  }
}
