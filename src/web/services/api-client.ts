import { getState, runtimeRefs, setState } from "../state/store.js";
import {
  getActiveAccountMeta,
  getNetworkThresholds,
  isMobileAccountEnvironment,
  isRemoteAccountType,
  markActiveAccountOffline,
  reportHttpOutcome,
  reportHttpSlowInFlight,
} from "./network-monitor.js";

function isActiveLanAccount(s = getState()): boolean {
  const activeAcc = (s.accountsState?.accounts || []).find(
    (a) => a.id === s.accountsState?.activeAccountId
  );
  return activeAcc?.type === "lan";
}

export function markLanReachable() {
  const s = getState();
  if (!s.lanOfflineModalShown && !s.lanNodeOffline && !s.lanOfflineDismissed) return;
  setState({
    lanOfflineModalShown: false,
    lanNodeOffline: false,
    lanOfflineDismissed: false,
  });
}

export function dismissLanOfflineModal() {
  const s = getState();
  if (!s.lanOfflineModalShown && s.lanOfflineDismissed) return;
  setState({
    lanOfflineModalShown: false,
    lanOfflineDismissed: true,
  });
}

export function triggerLanUnreachableFallback(
  _err?: unknown,
  opts: { forceModal?: boolean; suppressModal?: boolean } = {}
) {
  const s = getState();
  if (s.updateState?.coreSwitchInProgress) return;
  if (!isActiveLanAccount(s)) return;
  // Non-blocking top NetworkStatusBanner is now the default UX for LAN disconnects;
  // only open the legacy blocking modal when explicitly forced.
  const shouldOpenModal = Boolean(opts.forceModal && !opts.suppressModal);

  if (s.lanNodeOffline && !shouldOpenModal) return;

  setState({
    lanNodeOffline: true,
    ...(shouldOpenModal ? { lanOfflineModalShown: true, lanOfflineDismissed: false } : {}),
  });
}

export function apiUrl(pathOrUrl = ""): string {
  const s = getState();
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return s.activeBaseUrl || "";
  if (/^(?:https?:\/\/|blob:|data:)/i.test(raw)) {
    if (
      s.activeBaseUrl &&
      s.activeAuthToken &&
      raw.startsWith(s.activeBaseUrl) &&
      (raw.includes("/api/screens/") || raw.includes("/api/workspace/file"))
    ) {
      const u = new URL(raw);
      if (!u.searchParams.has("token")) {
        u.searchParams.set("token", s.activeAuthToken);
      }
      return u.toString();
    }
    return raw;
  }
  const base = String(s.activeBaseUrl || "").replace(/\/+$/, "");
  const rel = raw.startsWith("/") ? raw : `/${raw}`;
  const joined = `${base}${rel}`;
  if (
    s.activeAuthToken &&
    (rel.startsWith("/api/screens/") || rel.startsWith("/api/workspace/file"))
  ) {
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3230";
      const u = new URL(joined, origin);
      if (!u.searchParams.has("token")) {
        u.searchParams.set("token", s.activeAuthToken);
      }
      return base ? u.toString() : `${u.pathname}${u.search}`;
    } catch {
      // ignore
    }
  }
  return joined;
}

export async function apiFetch(url: string, options: any = {}): Promise<Response> {
  const s = getState();
  const reqEpoch = s.accountEpoch;
  const {
    noLanTimeout,
    noTimeout,
    timeoutMs: customTimeoutMs,
    suppressLanOfflineModal,
    ...fetchOptions
  } = options || {};
  const headers: Record<string, string> = { ...(fetchOptions.headers || {}) };
  if (s.activeAuthToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${s.activeAuthToken}`;
  }

  const accMeta = getActiveAccountMeta(s);
  const accountType = accMeta.type;
  const isLanNode = accountType === "lan";
  const isRemote = isRemoteAccountType(accountType);
  const thresholds = getNetworkThresholds();

  const resolvedTimeoutMs =
    typeof customTimeoutMs === "number" && customTimeoutMs > 0
      ? customTimeoutMs
      : noTimeout
        ? 0
        : isLanNode
          ? noLanTimeout
            ? 0
            : thresholds.lanTimeoutMs
          : accountType === "cloud"
            ? thresholds.cloudTimeoutMs
            : 0;

  let timeoutId: any = null;
  let slowTimerId: any = null;
  let timedOut = false;
  let localAbortCtrl: AbortController | null = null;
  const startedAt = Date.now();
  const baseSignal = fetchOptions.signal || runtimeRefs.accountAbortController?.signal || null;

  if (resolvedTimeoutMs > 0) {
    localAbortCtrl = new AbortController();
    if (baseSignal) {
      if (baseSignal.aborted) localAbortCtrl.abort();
      else baseSignal.addEventListener("abort", () => localAbortCtrl?.abort(), { once: true });
    }
    timeoutId = setTimeout(() => {
      timedOut = true;
      localAbortCtrl?.abort(new Error(isLanNode ? "LAN_TIMEOUT" : "REMOTE_TIMEOUT"));
    }, resolvedTimeoutMs);
    fetchOptions.signal = localAbortCtrl.signal;
  } else if (!fetchOptions.signal && runtimeRefs.accountAbortController) {
    fetchOptions.signal = runtimeRefs.accountAbortController.signal;
  }

  if (isRemote && !baseSignal?.aborted) {
    slowTimerId = setTimeout(() => {
      if (reqEpoch === getState().accountEpoch) {
        reportHttpSlowInFlight(accountType, Date.now() - startedAt);
      }
    }, thresholds.slowRequestMs);
  }

  try {
    const res = await fetch(apiUrl(url), { ...fetchOptions, headers });
    if (reqEpoch !== getState().accountEpoch) {
      const staleErr: any = new Error("stale account fetch ignored after switch");
      staleErr.code = "STALE_ACCOUNT_EPOCH";
      throw staleErr;
    }
    const reqPath = (() => {
      try {
        return new URL(apiUrl(url), "http://127.0.0.1").pathname;
      } catch {
        return String(url || "");
      }
    })();
    const isLocalControlEndpoint =
      reqPath === "/api/system/role" ||
      reqPath.endsWith("/api/system/role") ||
      reqPath === "/api/host/execute" ||
      reqPath.endsWith("/api/host/execute") ||
      reqPath === "/api/desktop" ||
      reqPath.includes("/api/desktop/");
    const isGatewayUnreachableStatus =
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504 ||
      (res.status >= 520 && res.status <= 530);
    const isRemoteAuthFailure = isRemote && !isLocalControlEndpoint && res.status === 401;

    if (isRemote && (isGatewayUnreachableStatus || isRemoteAuthFailure)) {
      const failureReason = isRemoteAuthFailure ? "auth_failed" : `http_${res.status}`;
      reportHttpOutcome({
        ok: false,
        elapsedMs: Date.now() - startedAt,
        networkError: true,
        accountType,
      });
      if (isLanNode) {
        triggerLanUnreachableFallback(new Error(failureReason), {
          suppressModal: Boolean(suppressLanOfflineModal),
        });
      }
      if (isMobileAccountEnvironment(getState()) || isRemoteAuthFailure) {
        markActiveAccountOffline(failureReason);
      }
      return res;
    }
    if (isLanNode) {
      markLanReachable();
    }
    reportHttpOutcome({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      accountType,
    });
    return res;
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    if (reqEpoch === getState().accountEpoch && err?.code !== "STALE_ACCOUNT_EPOCH") {
      const callerAborted = Boolean(baseSignal?.aborted);
      const isTimeoutFailure =
        timedOut ||
        err?.message === "LAN_TIMEOUT" ||
        err?.message === "REMOTE_TIMEOUT";
      const isNetworkFailure =
        !callerAborted &&
        (err instanceof TypeError || err?.name === "TypeError");

      if (isTimeoutFailure || isNetworkFailure) {
        reportHttpOutcome({
          ok: false,
          elapsedMs,
          timedOut: isTimeoutFailure,
          networkError: isNetworkFailure,
          accountType,
        });
        if (isLanNode) {
          triggerLanUnreachableFallback(err, {
            suppressModal: Boolean(suppressLanOfflineModal),
          });
        }
      }
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (slowTimerId) clearTimeout(slowTimerId);
  }
}

export async function apiJson(url: string, options: any = {}): Promise<any> {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await apiFetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
