import { getState, runtimeRefs, setState } from "../state/store.js";

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
  if (!isActiveLanAccount(s)) return;
  const shouldOpenModal =
    !opts.suppressModal &&
    (opts.forceModal ||
      (!s.lanOfflineModalShown &&
        !s.lanOfflineDismissed &&
        !s.mobileSheets?.nodeOpen &&
        !s.mobilePairModalOpen &&
        !s.cloudAccountModal?.open));

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
  const { noLanTimeout, suppressLanOfflineModal, ...fetchOptions } = options || {};
  const headers: Record<string, string> = { ...(fetchOptions.headers || {}) };
  if (s.activeAuthToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${s.activeAuthToken}`;
  }
  const activeAcc = (s.accountsState?.accounts || []).find(
    (a) => a.id === s.accountsState?.activeAccountId
  );
  const isLanNode = activeAcc?.type === "lan";
  let lanTimeoutId: any = null;
  let timedOut = false;
  let localAbortCtrl: AbortController | null = null;
  const baseSignal = fetchOptions.signal || runtimeRefs.accountAbortController?.signal || null;
  if (isLanNode && !noLanTimeout) {
    localAbortCtrl = new AbortController();
    if (baseSignal) {
      if (baseSignal.aborted) localAbortCtrl.abort();
      else baseSignal.addEventListener("abort", () => localAbortCtrl?.abort(), { once: true });
    }
    lanTimeoutId = setTimeout(() => {
      timedOut = true;
      localAbortCtrl?.abort(new Error("LAN_TIMEOUT_3S"));
    }, 3000);
    fetchOptions.signal = localAbortCtrl.signal;
  } else if (!fetchOptions.signal && runtimeRefs.accountAbortController) {
    fetchOptions.signal = runtimeRefs.accountAbortController.signal;
  }
  try {
    const res = await fetch(apiUrl(url), { ...fetchOptions, headers });
    if (reqEpoch !== getState().accountEpoch) {
      const staleErr: any = new Error("stale account fetch ignored after switch");
      staleErr.code = "STALE_ACCOUNT_EPOCH";
      throw staleErr;
    }
    if (isLanNode) {
      markLanReachable();
    }
    return res;
  } catch (err: any) {
    if (isLanNode && reqEpoch === getState().accountEpoch && err?.code !== "STALE_ACCOUNT_EPOCH") {
      const isTimeoutOrNetworkFailure =
        timedOut ||
        err?.message === "LAN_TIMEOUT_3S" ||
        (err instanceof TypeError && !baseSignal?.aborted);
      if (isTimeoutOrNetworkFailure) {
        triggerLanUnreachableFallback(err, { suppressModal: Boolean(suppressLanOfflineModal) });
      }
    }
    throw err;
  } finally {
    if (lanTimeoutId) clearTimeout(lanTimeoutId);
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
