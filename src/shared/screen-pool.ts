import type { ScreenPoolBudget, ScreenPoolSettings } from "./entities.js";

export const ABSOLUTE_MIN_CONCURRENT_SCREENS = 1;
export const ABSOLUTE_MAX_CONCURRENT_SCREENS = 16;

export const FALLBACK_SCREEN_POOL_BUDGET: ScreenPoolBudget = {
  min: 2,
  defaultBalanced: 4,
  max: 8,
  totalMemGiB: 16,
  cpuCores: 8,
};

/**
 * Tools on Bot's Computer that actively touch a virtual display or browser window
 * ("屏幕点点操作") and therefore require acquiring a concurrent screen slot lease.
 * Pure CLI (`run_shell`), file I/O (`read_file`, `write_file`), host tools, MCP tools,
 * and collaboration tools are intentionally excluded so unlimited Bots can execute
 * non-GUI tasks simultaneously without waiting in the screen queue.
 */
export const SCREEN_REQUIRED_TOOLS = new Set<string>([
  "screenshot",
  "click",
  "type_text",
  "key",
  "scroll",
  "drag",
  "list_windows",
  "focus_window",
  "open_url",
  "browser_snapshot",
  "browser_click",
  "browser_type",
]);

export function isScreenRequiredTool(toolName: string): boolean {
  return SCREEN_REQUIRED_TOOLS.has(String(toolName || ""));
}

/**
 * Budgets safe lower bound (`min`), balanced default (`defaultBalanced`), and upper bound (`max`)
 * for concurrently active virtual screens based on host/VM memory and logical CPU cores.
 *
 * Each active screen (`Xvfb` + `xfwm4` + `x11vnc` + `websockify` + `Chromium`) consumes ~500–600 MB
 * inside Linux (while WSL2/OrbStack typically receives ~50% of host RAM).
 */
export function computeScreenPoolBudget({
  totalMemBytes = 16 * 1024 ** 3,
  cpuCores = 8,
}: {
  totalMemBytes?: number;
  cpuCores?: number;
} = {}): ScreenPoolBudget {
  const safeMemBytes =
    Number.isFinite(totalMemBytes) && totalMemBytes > 0
      ? totalMemBytes
      : 16 * 1024 ** 3;
  const safeCores =
    Number.isFinite(cpuCores) && cpuCores > 0 ? Math.max(1, Math.round(cpuCores)) : 8;
  const totalMemGiB = Math.max(1, Math.round(safeMemBytes / 1024 ** 3));

  const min = totalMemGiB < 6 || safeCores <= 2 ? 1 : 2;

  const memCap =
    totalMemGiB < 6
      ? 3
      : totalMemGiB < 12
        ? 5
        : totalMemGiB < 20
          ? 8
          : totalMemGiB < 28
            ? 10
            : totalMemGiB < 48
              ? 12
              : ABSOLUTE_MAX_CONCURRENT_SCREENS;

  const cpuCap = Math.max(3, Math.min(ABSOLUTE_MAX_CONCURRENT_SCREENS, Math.ceil(safeCores * 1.25)));
  const max = Math.max(min + 2, Math.min(ABSOLUTE_MAX_CONCURRENT_SCREENS, Math.min(memCap, cpuCap)));
  const defaultBalanced = Math.max(
    min,
    Math.min(max, Math.round(max * 0.5))
  );

  return {
    min,
    defaultBalanced,
    max,
    totalMemGiB,
    cpuCores: safeCores,
  };
}

function clampScreenCount(val: unknown, fallback: number, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeScreenPoolSettings(
  raw: unknown,
  budget: ScreenPoolBudget = FALLBACK_SCREEN_POOL_BUDGET
): ScreenPoolSettings {
  const safeBudget =
    budget &&
    typeof budget === "object" &&
    Number.isFinite(budget.min) &&
    Number.isFinite(budget.max) &&
    Number.isFinite(budget.defaultBalanced)
      ? budget
      : FALLBACK_SCREEN_POOL_BUDGET;

  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const hasExplicitCount =
    src.maxConcurrentScreens !== undefined &&
    src.maxConcurrentScreens !== null &&
    src.maxConcurrentScreens !== "";

  const mode: "auto" | "custom" =
    src.mode === "custom" || (src.mode !== "auto" && hasExplicitCount)
      ? "custom"
      : "auto";

  const maxConcurrentScreens =
    mode === "auto"
      ? safeBudget.defaultBalanced
      : clampScreenCount(
          src.maxConcurrentScreens,
          safeBudget.defaultBalanced,
          safeBudget.min,
          safeBudget.max
        );

  return {
    mode,
    maxConcurrentScreens,
    budget: safeBudget,
  };
}

export type ScreenPoolPresetId = "min" | "balanced" | "max" | "custom";

export function matchScreenPoolPreset(
  raw: unknown,
  budget: ScreenPoolBudget = FALLBACK_SCREEN_POOL_BUDGET
): ScreenPoolPresetId {
  const normalized = normalizeScreenPoolSettings(raw, budget);
  if (normalized.mode === "auto" || normalized.maxConcurrentScreens === budget.defaultBalanced) {
    return "balanced";
  }
  if (normalized.maxConcurrentScreens === budget.min) {
    return "min";
  }
  if (normalized.maxConcurrentScreens === budget.max) {
    return "max";
  }
  return "custom";
}
