import { isMobileViewport } from "../mobile-ui.js";
import {
  createInitialNetworkHealth,
  getState,
  setState,
  type AppState,
  type NetworkHealthState,
  type NetworkStatus,
} from "../state/store.js";

export type ActiveAccountKind = "local" | "lan" | "cloud";

const RECOVERED_VISIBLE_MS = 2500;
const WEAK_SHOW_DEBOUNCE_MS = 800;
const WEAK_MIN_VISIBLE_MS = 2500;
const OFFLINE_RECONNECT_THRESHOLD = 3;

let weakDebounceTimer: any = null;
let weakClearTimer: any = null;
let recoveredClearTimer: any = null;
let weakShownAt = 0;
let consecutiveHttpFailures = 0;

export function clearNetworkMonitorTimers() {
  if (weakDebounceTimer) {
    clearTimeout(weakDebounceTimer);
    weakDebounceTimer = null;
  }
  if (weakClearTimer) {
    clearTimeout(weakClearTimer);
    weakClearTimer = null;
  }
  if (recoveredClearTimer) {
    clearTimeout(recoveredClearTimer);
    recoveredClearTimer = null;
  }
  weakShownAt = 0;
  consecutiveHttpFailures = 0;
}

export function getActiveAccountMeta(s: AppState = getState()): {
  type: ActiveAccountKind;
  label: string;
  hasOtherAccounts: boolean;
} {
  const accounts = Array.isArray(s.accountsState?.accounts) ? s.accountsState.accounts : [];
  const activeAcc = accounts.find((a) => a.id === s.accountsState?.activeAccountId);
  const rawType = activeAcc?.type;
  const type: ActiveAccountKind =
    rawType === "cloud" ? "cloud" : rawType === "lan" ? "lan" : "local";

  const customName = String(activeAcc?.name || "").trim();
  const label =
    type === "cloud"
      ? customName || "云端账号"
      : type === "lan"
        ? customName || "本地账号"
        : customName || "本地账号";

  return {
    type,
    label,
    hasOtherAccounts: accounts.length > 1,
  };
}

export function isRemoteAccountType(type: ActiveAccountKind): boolean {
  return type === "cloud" || type === "lan";
}

export function isRemoteAccountOffline(s: AppState = getState()): boolean {
  const meta = getActiveAccountMeta(s);
  if (!isRemoteAccountType(meta.type)) return false;
  return (
    s.networkHealth?.status === "offline" ||
    Boolean(s.networkHealth?.browserOffline) ||
    (meta.type === "lan" && Boolean(s.lanNodeOffline))
  );
}

export function shouldShowAccountDisconnectedGate(s: AppState = getState()): boolean {
  if (s.updateState?.coreSwitchInProgress) return false;
  return isRemoteAccountOffline(s);
}

export function getNetworkThresholds(mobile = isMobileViewport()) {
  return {
    weakRttMs: mobile ? 1500 : 1800,
    slowRequestMs: mobile ? 2500 : 2800,
    lanTimeoutMs: 5000,
    cloudTimeoutMs: 15000,
    pingIntervalMs: mobile ? 15000 : 25000,
    pongTimeoutMs: 5000,
    resumeBgThresholdMs: mobile ? 3000 : 5000,
  };
}

export function computeReconnectDelayMs(
  attempt: number,
  { jitterRatio = 0.2, randomFn = Math.random }: { jitterRatio?: number; randomFn?: () => number } = {}
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt || 1));
  const base = Math.min(15_000, 1000 * Math.pow(2, safeAttempt - 1));
  if (jitterRatio <= 0) return base;
  const factor = 1 + (randomFn() * 2 - 1) * jitterRatio;
  return Math.max(500, Math.round(base * factor));
}

function patchNetworkHealth(patch: Partial<NetworkHealthState>) {
  setState((prev) => ({
    networkHealth: {
      ...(prev.networkHealth || createInitialNetworkHealth()),
      ...patch,
      updatedAt: Date.now(),
    },
  }));
}

function scheduleRecoveredAutoHide() {
  if (recoveredClearTimer) clearTimeout(recoveredClearTimer);
  recoveredClearTimer = setTimeout(() => {
    recoveredClearTimer = null;
    const cur = getState().networkHealth;
    if (cur?.status === "recovered") {
      patchNetworkHealth({
        status: "online",
        reason: "",
        nextRetryAt: null,
      });
    }
  }, RECOVERED_VISIBLE_MS);
}

function enterWeakStatus(rttMs: number | null, reason: string, immediate = false) {
  const cur = getState().networkHealth;
  if (cur.status === "offline" || cur.status === "reconnecting") return;
  if (weakClearTimer) {
    clearTimeout(weakClearTimer);
    weakClearTimer = null;
  }
  const applyWeak = () => {
    weakDebounceTimer = null;
    const latest = getState().networkHealth;
    if (latest.status === "offline" || latest.status === "reconnecting") return;
    if (latest.status !== "weak") {
      weakShownAt = Date.now();
    }
    patchNetworkHealth({
      status: "weak",
      rttMs: rttMs ?? latest.rttMs,
      reason,
      dismissedWeakBanner: latest.status === "weak" ? latest.dismissedWeakBanner : false,
    });
  };
  if (immediate || cur.status === "weak") {
    if (weakDebounceTimer) {
      clearTimeout(weakDebounceTimer);
      weakDebounceTimer = null;
    }
    applyWeak();
    return;
  }
  if (!weakDebounceTimer) {
    weakDebounceTimer = setTimeout(applyWeak, WEAK_SHOW_DEBOUNCE_MS);
  }
}

function settleWeakBackToOnline(rttMs: number | null) {
  if (weakDebounceTimer) {
    clearTimeout(weakDebounceTimer);
    weakDebounceTimer = null;
  }
  const cur = getState().networkHealth;
  if (cur.status !== "weak") {
    if (rttMs !== null && cur.rttMs !== rttMs) {
      patchNetworkHealth({ rttMs });
    }
    return;
  }
  const elapsedVisible = Date.now() - weakShownAt;
  const remaining = Math.max(0, WEAK_MIN_VISIBLE_MS - elapsedVisible);
  if (remaining === 0) {
    patchNetworkHealth({
      status: "online",
      rttMs,
      reason: "",
      dismissedWeakBanner: false,
    });
    return;
  }
  if (!weakClearTimer) {
    weakClearTimer = setTimeout(() => {
      weakClearTimer = null;
      const latest = getState().networkHealth;
      if (latest.status === "weak") {
        patchNetworkHealth({
          status: "online",
          rttMs: rttMs ?? latest.rttMs,
          reason: "",
          dismissedWeakBanner: false,
        });
      }
    }, remaining);
  }
}

export function reportHttpSlowInFlight(accountType: ActiveAccountKind, elapsedMs?: number) {
  if (!isRemoteAccountType(accountType)) return;
  const thresholds = getNetworkThresholds();
  enterWeakStatus(elapsedMs ?? thresholds.slowRequestMs, "slow_request");
}

export function reportHttpOutcome({
  ok,
  elapsedMs,
  timedOut = false,
  networkError = false,
  accountType,
}: {
  ok: boolean;
  elapsedMs: number;
  timedOut?: boolean;
  networkError?: boolean;
  accountType: ActiveAccountKind;
}) {
  const thresholds = getNetworkThresholds();
  if (ok) {
    consecutiveHttpFailures = 0;
    const cur = getState().networkHealth;
    if (cur.status === "offline" || cur.status === "reconnecting") {
      patchNetworkHealth({
        status: "recovered",
        rttMs: Math.round(elapsedMs),
        reconnectAttempt: 0,
        nextRetryAt: null,
        browserOffline: false,
        reason: "",
        dismissedWeakBanner: false,
      });
      scheduleRecoveredAutoHide();
      return;
    }
    if (isRemoteAccountType(accountType) && elapsedMs >= thresholds.slowRequestMs) {
      enterWeakStatus(Math.round(elapsedMs), "slow_request", true);
    } else {
      settleWeakBackToOnline(Math.round(elapsedMs));
    }
    return;
  }

  if (!timedOut && !networkError) return;
  if (getState().updateState?.coreSwitchInProgress) return;
  if (!isRemoteAccountType(accountType)) return;

  consecutiveHttpFailures += 1;
  const browserOff =
    typeof navigator !== "undefined" && navigator.onLine === false;

  if (browserOff) {
    patchNetworkHealth({
      status: "offline",
      browserOffline: true,
      reason: "browser_offline",
    });
    return;
  }

  const cur = getState().networkHealth;
  if (timedOut && consecutiveHttpFailures < 2 && cur.status === "online") {
    enterWeakStatus(Math.round(elapsedMs), "timeout", true);
    return;
  }

  if (consecutiveHttpFailures >= 2 || (networkError && cur.status !== "online")) {
    patchNetworkHealth({
      status: "offline",
      reason: timedOut ? "timeout" : "network_error",
    });
  } else if (networkError) {
    patchNetworkHealth({
      status: "reconnecting",
      reconnectAttempt: Math.max(1, cur.reconnectAttempt || 1),
      reason: "network_error",
    });
  }
}

export function reportHeartbeatRtt(rttMs: number) {
  const meta = getActiveAccountMeta();
  if (!isRemoteAccountType(meta.type)) return;
  const cleanRtt = Math.max(1, Math.round(rttMs));
  const thresholds = getNetworkThresholds();
  if (cleanRtt >= thresholds.weakRttMs) {
    enterWeakStatus(cleanRtt, "slow_rtt", true);
  } else {
    settleWeakBackToOnline(cleanRtt);
  }
}

export function reportHeartbeatTimeout() {
  if (weakDebounceTimer) {
    clearTimeout(weakDebounceTimer);
    weakDebounceTimer = null;
  }
  const cur = getState().networkHealth;
  patchNetworkHealth({
    status: cur.browserOffline ? "offline" : "reconnecting",
    reconnectAttempt: Math.max(1, (cur.reconnectAttempt || 0) + 1),
    reason: "ping_timeout",
  });
}

export function reportTransportConnected(transport: "ws" | "sse", wasReconnect = false) {
  if (weakDebounceTimer) {
    clearTimeout(weakDebounceTimer);
    weakDebounceTimer = null;
  }
  if (weakClearTimer) {
    clearTimeout(weakClearTimer);
    weakClearTimer = null;
  }
  consecutiveHttpFailures = 0;

  const cur = getState().networkHealth;
  const shouldShowRecovered =
    wasReconnect ||
    cur.status === "reconnecting" ||
    cur.status === "offline" ||
    cur.status === "weak";

  patchNetworkHealth({
    status: shouldShowRecovered ? "recovered" : "online",
    transport,
    reconnectAttempt: 0,
    nextRetryAt: null,
    browserOffline: false,
    reason: "",
    dismissedWeakBanner: false,
  });

  if (shouldShowRecovered) {
    scheduleRecoveredAutoHide();
  }
}

export function reportTransportDisconnected({
  attempt,
  nextRetryDelayMs,
  reason = "transport_closed",
}: {
  attempt: number;
  nextRetryDelayMs?: number | null;
  reason?: string;
}) {
  if (getState().updateState?.coreSwitchInProgress) return;
  if (weakDebounceTimer) {
    clearTimeout(weakDebounceTimer);
    weakDebounceTimer = null;
  }
  if (recoveredClearTimer) {
    clearTimeout(recoveredClearTimer);
    recoveredClearTimer = null;
  }
  const browserOff =
    typeof navigator !== "undefined" && navigator.onLine === false;
  const safeAttempt = Math.max(1, Math.floor(attempt || 1));
  const nextStatus: NetworkStatus =
    browserOff || safeAttempt >= OFFLINE_RECONNECT_THRESHOLD
      ? "offline"
      : "reconnecting";

  patchNetworkHealth({
    status: nextStatus,
    transport: "none",
    reconnectAttempt: safeAttempt,
    nextRetryAt:
      !browserOff && typeof nextRetryDelayMs === "number" && nextRetryDelayMs > 0
        ? Date.now() + nextRetryDelayMs
        : null,
    browserOffline: browserOff,
    reason: browserOff ? "browser_offline" : reason,
  });
}

export function handleBrowserOnlineChange(isOnline: boolean) {
  if (!isOnline) {
    clearNetworkMonitorTimers();
    patchNetworkHealth({
      status: "offline",
      transport: "none",
      nextRetryAt: null,
      browserOffline: true,
      reason: "browser_offline",
    });
    return;
  }
  const cur = getState().networkHealth;
  if (cur.status === "offline" || cur.browserOffline) {
    patchNetworkHealth({
      status: "reconnecting",
      browserOffline: false,
      reconnectAttempt: 1,
      nextRetryAt: Date.now() + 500,
      reason: "browser_online_resume",
    });
  }
}

export function inspectNavigatorConnectionHint() {
  if (typeof navigator === "undefined") return;
  const meta = getActiveAccountMeta();
  if (!isRemoteAccountType(meta.type)) return;
  const conn = (navigator as any).connection;
  if (!conn) return;
  const eff = String(conn.effectiveType || "").toLowerCase();
  const rtt = Number(conn.rtt || 0);
  const thresholds = getNetworkThresholds();
  if (eff === "slow-2g" || eff === "2g" || (rtt >= thresholds.weakRttMs && rtt > 0)) {
    enterWeakStatus(rtt > 0 ? rtt : thresholds.weakRttMs, "navigator_connection");
  }
}

export function dismissWeakNetworkBanner() {
  const cur = getState().networkHealth;
  if (cur.status === "weak" && !cur.dismissedWeakBanner) {
    patchNetworkHealth({ dismissedWeakBanner: true });
  }
}

export function resetNetworkHealthForAccountSwitch() {
  clearNetworkMonitorTimers();
  setState({ networkHealth: createInitialNetworkHealth() });
}
