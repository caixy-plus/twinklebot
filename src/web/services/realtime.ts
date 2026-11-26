import { isMobileAppTarget } from "../mobile-bridge.js";
import { getState, runtimeRefs, setState } from "../state/store.js";
import { apiFetch, apiJson, apiUrl, markLanReachable } from "./api-client.js";
import { tr } from "./i18n.js";
import {
  computeReconnectDelayMs,
  getActiveAccountMeta,
  getNetworkThresholds,
  isMobileAccountEnvironment,
  isRemoteAccountType,
  reportHeartbeatRtt,
  reportHeartbeatTimeout,
  reportTransportConnected,
  reportTransportDisconnected,
} from "./network-monitor.js";
import {
  applySessionClearedUI,
  applySessionRewoundUI,
  refreshComputerDisplays,
  refreshLibrary,
  refreshRelayStatus,
  refreshSchedules,
  refreshSettingsFromServer,
  refreshUsageAndHealth,
  refreshVault,
  renderEventForActiveSession,
  runWhenSettingsScrollIdle,
  selectSession,
  showToast,
  syncBackendAccountsDirectory,
  upsertLocalSession,
} from "./actions.js";

export async function forwardHostRpcToLocalExecutor(msg: any) {
  const s = getState();
  const localBase = String(
    s.localBackendUrl || (typeof window !== "undefined" ? window.location.origin : "")
  ).replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.localControlToken) {
    headers["X-Local-Control-Token"] = s.localControlToken;
  }
  try {
    const resp = await fetch(`${localBase}/api/host/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tool: msg.tool,
        args: msg.args || {},
        approved: msg.approved !== false,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    return {
      type: "host_rpc_response",
      rpcId: msg.rpcId,
      ok: Boolean(resp.ok && data?.ok !== false),
      result:
        data?.result ||
        (data?.needsApproval
          ? { error: tr("realtime.needsApproval", { reason: data.reason || "" }) }
          : { error: data?.error || `HTTP ${resp.status}` }),
      screenshot: data?.screenshot || null,
    };
  } catch (err: any) {
    return {
      type: "host_rpc_response",
      rpcId: msg.rpcId,
      ok: false,
      error: err?.message || "local host_executor unreachable",
    };
  }
}

export function handleRealtimePayload(payload: any) {
  if (!payload || typeof payload !== "object") return;
  const s = getState();

  if (payload.type === "host_rpc_request" && payload.rpcId) {
    if (isMobileAppTarget() || !s.localBackendUrl) {
      try {
        if (runtimeRefs.wsSocket && runtimeRefs.wsSocket.readyState === WebSocket.OPEN) {
          runtimeRefs.wsSocket.send(
            JSON.stringify({
              type: "host_rpc_response",
              rpcId: payload.rpcId,
              ok: false,
              error: "current client is not a host_executor",
            })
          );
        }
      } catch {}
      return;
    }
    forwardHostRpcToLocalExecutor(payload).then((reply) => {
      try {
        if (runtimeRefs.wsSocket && runtimeRefs.wsSocket.readyState === WebSocket.OPEN) {
          runtimeRefs.wsSocket.send(JSON.stringify(reply));
        }
      } catch {}
    });
    return;
  }

  if (payload.type === "skills_updated" || payload.type === "settings_updated") {
    refreshSettingsFromServer();
    refreshUsageAndHealth();
    return;
  }

  if (payload.type === "accounts_updated") {
    const toastName =
      payload.action === "upsert"
        ? String(
            payload.account?.name ||
              payload.account?.hostname ||
              payload.account?.baseUrl ||
              ""
          )
        : "";
    void syncBackendAccountsDirectory({
      toastForAccountName: toastName,
      removedId: payload.action === "remove" ? String(payload.accountId || "") : "",
    });
    return;
  }

  if (payload.type === "relay_updated") {
    if (getState().settingsModal?.open) {
      void refreshRelayStatus().catch(() => {});
    }
    return;
  }

  if (payload.type === "billing_updated") {
    if (payload.summary && typeof payload.summary === "object") {
      runWhenSettingsScrollIdle("provider-billing", () => {
        setState({ providerBilling: payload.summary });
      });
    } else {
      refreshUsageAndHealth();
    }
    return;
  }

  if (payload.type === "lan_pairing_requested" && payload.code) {
    if (!isMobileAppTarget()) {
      setState({
        desktopPairingModal: {
          open: true,
          deviceName: payload.deviceName || tr("source.mobile"),
          code: String(payload.code),
        },
      });
      showToast(tr("realtime.pairingCodeToast", { code: payload.code }));
    }
    return;
  }

  if (payload.type === "lan_device_paired") {
    setState((prev) => ({
      desktopPairingModal: { ...prev.desktopPairingModal, open: false },
    }));
    showToast(
      tr("realtime.devicePairedToast", {
        name: payload.device?.name || tr("source.mobile"),
      })
    );
    return;
  }

  if (payload.type === "computer_status_updated") {
    setState((prev) => {
      const nextOnline =
        payload.online !== undefined
          ? Boolean(payload.online)
          : Boolean(prev.computerStatus?.online);
      return {
        computerStatus: {
          ...prev.computerStatus,
          state: payload.state || prev.computerStatus?.state || "uncreated",
          online: nextOnline,
          ...(payload.provider ? { provider: payload.provider } : {}),
          ...(payload.latencyMs !== undefined ? { latencyMs: payload.latencyMs } : {}),
          ...(payload.screen !== undefined ? { screen: payload.screen } : {}),
          ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
          ...(payload.vmInstalled !== undefined ? { vmInstalled: payload.vmInstalled } : {}),
          ...(payload.vmRunning !== undefined ? { vmRunning: payload.vmRunning } : {}),
          error: nextOnline ? undefined : payload.error ?? prev.computerStatus?.error,
          errorCode: nextOnline
            ? undefined
            : payload.errorCode ?? prev.computerStatus?.errorCode,
          ...(payload.localBrowser !== undefined
            ? { localBrowser: payload.localBrowser }
            : prev.computerStatus?.localBrowser
              ? { localBrowser: prev.computerStatus.localBrowser }
              : {}),
        },
        ...(Array.isArray(payload.connectedHosts) ? { onlineCloudHosts: payload.connectedHosts } : {}),
        ...(payload.selectedHostId !== undefined ? { selectedCloudHostId: payload.selectedHostId } : {}),
      };
    });
    return;
  }

  if (payload.type === "schedules_updated") {
    refreshSchedules();
    return;
  }

  if (payload.type === "library_updated") {
    if (
      (!payload.sessionId || payload.sessionId === s.activeSessionId) &&
      (s.inspectorTab === "library" || s.mobileSheets.inspectorOpen)
    ) {
      refreshLibrary();
    }
    return;
  }

  if (payload.type === "vault_updated") {
    refreshVault();
    return;
  }

  if (payload.type === "session_cleared" && payload.sessionId) {
    applySessionClearedUI(payload.sessionId, payload.session || null);
    return;
  }

  if (payload.type === "session_rewound" && payload.sessionId) {
    applySessionRewoundUI(payload.sessionId, payload.events || [], payload.session || null);
    return;
  }

  if (payload.type === "session_updated" && payload.session) {
    upsertLocalSession(payload.session);
    return;
  }

  if (payload.type === "bot_created" && payload.bot) {
    upsertLocalSession(payload.bot);
    showToast(tr("realtime.botCreatedToast", { title: payload.bot.title }));
    return;
  }

  const sid = payload.sessionId;
  if (!sid) return;

  if (payload.botId && typeof payload.botId === "string") {
    const prevSpeaker = getState().groupActiveSpeakerBySession?.[sid];
    if (prevSpeaker !== payload.botId) {
      setState((prev) => ({
        groupActiveSpeakerBySession: {
          ...prev.groupActiveSpeakerBySession,
          [sid]: payload.botId,
        },
      }));
    }
  }
  if (payload.type === "screen_queue") {
    void refreshComputerDisplays();
  }

  const nextActiveMap = { ...getState().activeMap };
  if (payload.type === "status") {
    if (
      payload.status === "done" ||
      payload.status === "completed" ||
      payload.status === "stopped" ||
      payload.status === "error" ||
      payload.status === "idle" ||
      payload.status === "max_steps" ||
      payload.status === "interrupted"
    ) {
      delete nextActiveMap[sid];
    } else {
      nextActiveMap[sid] = payload.status;
    }
    setState({ activeMap: nextActiveMap });
  } else if (payload.type === "done" || payload.type === "error") {
    delete nextActiveMap[sid];
    setState({ activeMap: nextActiveMap });
  }

  if (sid === getState().activeSessionId) {
    renderEventForActiveSession(payload);
  } else {
    setState((prev) => ({
      sessions: prev.sessions.map((item) => {
        if (item.id !== sid) return item;
        if (payload.type === "answer" && payload.text) {
          return {
            ...item,
            subtitle: String(payload.text).replace(/\s+/g, " ").slice(0, 48),
            unreadCount: (Number(item.unreadCount) || 0) + 1,
          };
        }
        if (payload.type === "bot_exchange") {
          return {
            ...item,
            unreadCount: (Number(item.unreadCount) || 0) + 1,
          };
        }
        return item;
      }),
    }));
  }
}

function setRealtimeConnectedMarker(connected: boolean) {
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.dataset.realtimeConnected = connected ? "1" : "0";
    }
  } catch {}
}

function clearHeartbeatTimers() {
  if (runtimeRefs.wsPingTimer) {
    clearInterval(runtimeRefs.wsPingTimer);
    runtimeRefs.wsPingTimer = null;
  }
  if (runtimeRefs.wsPongTimeoutTimer) {
    clearTimeout(runtimeRefs.wsPongTimeoutTimer);
    runtimeRefs.wsPongTimeoutTimer = null;
  }
  runtimeRefs.wsLastPingSentAt = 0;
  runtimeRefs.wsMissedPongs = 0;
}

function sendWsHeartbeatPing(
  ws: WebSocket,
  epoch: number,
  timeoutMs = getNetworkThresholds().pongTimeoutMs,
  { force = false }: { force?: boolean } = {}
) {
  if (epoch !== getState().accountEpoch || runtimeRefs.wsSocket !== ws) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  if (runtimeRefs.wsPongTimeoutTimer) return; // ping already in-flight
  const thresholds = getNetworkThresholds();
  if (
    !force &&
    runtimeRefs.wsLastMessageAt > 0 &&
    Date.now() - runtimeRefs.wsLastMessageAt < thresholds.pingIntervalMs * 0.7
  ) {
    return;
  }
  runtimeRefs.wsLastPingSentAt = Date.now();
  try {
    ws.send(JSON.stringify({ type: "ping", at: runtimeRefs.wsLastPingSentAt }));
  } catch {
    return;
  }
  runtimeRefs.wsPongTimeoutTimer = setTimeout(() => {
    runtimeRefs.wsPongTimeoutTimer = null;
    if (epoch !== getState().accountEpoch || runtimeRefs.wsSocket !== ws) return;
    runtimeRefs.wsMissedPongs = (runtimeRefs.wsMissedPongs || 0) + 1;
    // Require 2 consecutive missed pongs before treating the socket as dead so transient
    // mobile WebView timer jitter or momentary WiFi latency spikes don't flap the connection.
    if (runtimeRefs.wsMissedPongs < 2) {
      sendWsHeartbeatPing(ws, epoch, timeoutMs, { force: true });
      return;
    }
    runtimeRefs.wsMissedPongs = 0;
    reportHeartbeatTimeout();
    try {
      ws.close();
    } catch {}
  }, timeoutMs);
}

function startWsHeartbeat(ws: WebSocket, epoch: number) {
  clearHeartbeatTimers();
  const meta = getActiveAccountMeta();
  if (!isRemoteAccountType(meta.type)) return;
  const thresholds = getNetworkThresholds();
  runtimeRefs.wsPingTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    sendWsHeartbeatPing(ws, epoch, thresholds.pongTimeoutMs);
  }, thresholds.pingIntervalMs);
}

function scheduleTransportReconnect(epoch: number, reason: string) {
  if (epoch !== getState().accountEpoch) return;
  if (runtimeRefs.wsReconnectTimer) return;

  runtimeRefs.wsReconnectAttempt = (runtimeRefs.wsReconnectAttempt || 0) + 1;
  const attempt = runtimeRefs.wsReconnectAttempt;
  const browserOff = typeof navigator !== "undefined" && navigator.onLine === false;

  if (browserOff) {
    reportTransportDisconnected({ attempt, nextRetryDelayMs: null, reason: "browser_offline" });
    return;
  }

  const delayMs = computeReconnectDelayMs(attempt);
  reportTransportDisconnected({ attempt, nextRetryDelayMs: delayMs, reason });

  runtimeRefs.wsReconnectTimer = setTimeout(() => {
    runtimeRefs.wsReconnectTimer = null;
    if (epoch === getState().accountEpoch) {
      connectRealtimeTransport();
    }
  }, delayMs);
}

export function disconnectRealtimeTransport() {
  setRealtimeConnectedMarker(false);
  clearHeartbeatTimers();
  if (runtimeRefs.wsConnectTimeoutTimer) {
    clearTimeout(runtimeRefs.wsConnectTimeoutTimer);
    runtimeRefs.wsConnectTimeoutTimer = null;
  }
  if (runtimeRefs.sseConnectTimeoutTimer) {
    clearTimeout(runtimeRefs.sseConnectTimeoutTimer);
    runtimeRefs.sseConnectTimeoutTimer = null;
  }
  if (runtimeRefs.wsReconnectTimer) {
    clearTimeout(runtimeRefs.wsReconnectTimer);
    runtimeRefs.wsReconnectTimer = null;
  }
  if (runtimeRefs.wsSocket) {
    try {
      runtimeRefs.wsSocket.onopen = null;
      runtimeRefs.wsSocket.onclose = null;
      runtimeRefs.wsSocket.onerror = null;
      runtimeRefs.wsSocket.onmessage = null;
      runtimeRefs.wsSocket.close();
    } catch {}
    runtimeRefs.wsSocket = null;
  }
  if (runtimeRefs.eventSource) {
    try {
      runtimeRefs.eventSource.onopen = null;
      runtimeRefs.eventSource.onmessage = null;
      runtimeRefs.eventSource.onerror = null;
      runtimeRefs.eventSource.close();
    } catch {}
    runtimeRefs.eventSource = null;
  }
}

function hasActiveTransportTarget(s = getState()): boolean {
  if (isMobileAccountEnvironment(s) && !s.activeBaseUrl && !s.activeWsUrl) {
    return false;
  }
  return true;
}

export function connectGlobalSse(epoch = getState().accountEpoch) {
  if (!hasActiveTransportTarget()) {
    disconnectRealtimeTransport();
    return;
  }
  if (typeof EventSource !== "function") {
    scheduleTransportReconnect(epoch, "sse_unavailable");
    return;
  }
  const cur = getState();
  if (runtimeRefs.sseConnectTimeoutTimer) {
    clearTimeout(runtimeRefs.sseConnectTimeoutTimer);
    runtimeRefs.sseConnectTimeoutTimer = null;
  }
  if (runtimeRefs.eventSource) {
    try {
      runtimeRefs.eventSource.close();
    } catch {}
  }
  let sseUrl = apiUrl("/api/events");
  if (cur.activeAuthToken) {
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3230";
      const u = new URL(sseUrl, origin);
      u.searchParams.set("token", cur.activeAuthToken);
      sseUrl = cur.activeBaseUrl ? u.toString() : `${u.pathname}${u.search}`;
    } catch {}
  }
  const es = new EventSource(sseUrl);
  runtimeRefs.eventSource = es;
  let sseOpened = false;
  const connectTimeoutMs = getActiveAccountMeta().type === "lan" ? 5000 : 8000;
  runtimeRefs.sseConnectTimeoutTimer = setTimeout(() => {
    runtimeRefs.sseConnectTimeoutTimer = null;
    if (sseOpened || epoch !== getState().accountEpoch || runtimeRefs.eventSource !== es) return;
    try {
      es.onopen = null;
      es.onmessage = null;
      es.onerror = null;
      es.close();
    } catch {}
    if (runtimeRefs.eventSource === es) runtimeRefs.eventSource = null;
    setRealtimeConnectedMarker(false);
    scheduleTransportReconnect(epoch, "sse_connect_timeout");
  }, connectTimeoutMs);

  es.onopen = () => {
    if (runtimeRefs.sseConnectTimeoutTimer) {
      clearTimeout(runtimeRefs.sseConnectTimeoutTimer);
      runtimeRefs.sseConnectTimeoutTimer = null;
    }
    if (epoch !== getState().accountEpoch) {
      es.close();
      return;
    }
    const curNetStatus = getState().networkHealth?.status;
    const wasDisrupted =
      curNetStatus === "offline" ||
      curNetStatus === "reconnecting" ||
      runtimeRefs.wsReconnectAttempt > 0;
    const shouldSync = runtimeRefs.wsHasOpenedInEpoch || wasDisrupted;
    runtimeRefs.wsReconnectAttempt = 0;
    runtimeRefs.wsHasOpenedInEpoch = true;
    sseOpened = true;
    setRealtimeConnectedMarker(true);
    markLanReachable();
    reportTransportConnected("sse", wasDisrupted);
    if (shouldSync) {
      syncSessionsAndActiveOnReconnect(epoch);
    }
  };
  es.onmessage = (msg) => {
    if (epoch !== getState().accountEpoch) return;
    try {
      handleRealtimePayload(JSON.parse(msg.data));
    } catch {}
  };
  es.onerror = () => {
    if (runtimeRefs.sseConnectTimeoutTimer) {
      clearTimeout(runtimeRefs.sseConnectTimeoutTimer);
      runtimeRefs.sseConnectTimeoutTimer = null;
    }
    if (epoch !== getState().accountEpoch) {
      try {
        es.close();
      } catch {}
      return;
    }
    if (!sseOpened) {
      try {
        es.close();
      } catch {}
      if (runtimeRefs.eventSource === es) runtimeRefs.eventSource = null;
      setRealtimeConnectedMarker(false);
      // Fix: previously stopped reconnecting permanently when both initial WS & SSE failed!
      scheduleTransportReconnect(epoch, "sse_connect_error");
      return;
    }
    setRealtimeConnectedMarker(false);
    scheduleTransportReconnect(epoch, "sse_dropped");
  };
}

export async function syncSessionsAndActiveOnReconnect(epoch = getState().accountEpoch) {
  if (epoch !== getState().accountEpoch) return;
  if (runtimeRefs.inflightReconnectSync) {
    return runtimeRefs.inflightReconnectSync;
  }
  let run: Promise<void> | null = null;
  run = (async () => {
    try {
      void refreshSettingsFromServer({ retries: 1 });
      const data = await apiJson("/api/sessions");
      if (epoch !== getState().accountEpoch) return;
      if (Array.isArray(data.sessions)) {
        setState({
          sessions: data.sessions,
          activeMap: data.activeSessions || {},
        });
      }
      const activeSid = getState().activeSessionId;
      if (activeSid) {
        runtimeRefs.nextSelectOpts = { preserveScrollIfUnpinned: true };
        await selectSession(activeSid);
      }
    } catch {
      // Ignore transient reconnect sync errors
    } finally {
      if (runtimeRefs.inflightReconnectSync === run) {
        runtimeRefs.inflightReconnectSync = null;
      }
    }
  })();
  runtimeRefs.inflightReconnectSync = run;
  return run;
}

export function connectRealtimeTransport() {
  disconnectRealtimeTransport();
  const s = getState();
  if (!hasActiveTransportTarget(s)) {
    return;
  }
  const epoch = s.accountEpoch;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    reportTransportDisconnected({
      attempt: Math.max(1, runtimeRefs.wsReconnectAttempt || 1),
      nextRetryDelayMs: null,
      reason: "browser_offline",
    });
    return;
  }
  let wsTarget = s.activeWsUrl;
  if (!wsTarget && typeof window !== "undefined") {
    try {
      const httpBase = s.activeBaseUrl || window.location.origin;
      const u = new URL(httpBase);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      const basePath = u.pathname.replace(/\/+$/, "");
      u.pathname = `${basePath}/ws`;
      u.search = "";
      wsTarget = u.toString();
    } catch {
      wsTarget = "";
    }
  }
  if (!wsTarget || typeof WebSocket !== "function") {
    connectGlobalSse(epoch);
    return;
  }
  try {
    const u = new URL(wsTarget);
    if (s.activeAuthToken && !u.searchParams.has("token")) {
      u.searchParams.set("token", s.activeAuthToken);
    }
    const ws = new WebSocket(u.toString());
    runtimeRefs.wsSocket = ws;
    let openedOnce = false;
    const connectTimeoutMs = getActiveAccountMeta().type === "lan" ? 5000 : 8000;
    runtimeRefs.wsConnectTimeoutTimer = setTimeout(() => {
      runtimeRefs.wsConnectTimeoutTimer = null;
      if (openedOnce || epoch !== getState().accountEpoch || runtimeRefs.wsSocket !== ws) return;
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch {}
      if (runtimeRefs.wsSocket === ws) runtimeRefs.wsSocket = null;
      setRealtimeConnectedMarker(false);
      if (!runtimeRefs.eventSource) {
        connectGlobalSse(epoch);
      }
    }, connectTimeoutMs);

    ws.onopen = () => {
      if (runtimeRefs.wsConnectTimeoutTimer) {
        clearTimeout(runtimeRefs.wsConnectTimeoutTimer);
        runtimeRefs.wsConnectTimeoutTimer = null;
      }
      if (epoch !== getState().accountEpoch) {
        ws.close();
        return;
      }
      const curNetStatus = getState().networkHealth?.status;
      const wasDisrupted =
        curNetStatus === "offline" ||
        curNetStatus === "reconnecting" ||
        runtimeRefs.wsReconnectAttempt > 0;
      const shouldSync = runtimeRefs.wsHasOpenedInEpoch === true || wasDisrupted;
      runtimeRefs.wsHasOpenedInEpoch = true;
      runtimeRefs.wsReconnectAttempt = 0;
      runtimeRefs.wsLastMessageAt = Date.now();
      runtimeRefs.wsMissedPongs = 0;
      openedOnce = true;
      setRealtimeConnectedMarker(true);
      markLanReachable();
      reportTransportConnected("ws", wasDisrupted);
      startWsHeartbeat(ws, epoch);

      const cur = getState();
      const activeAcc = (cur.accountsState?.accounts || []).find(
        (a) => a.id === cur.accountsState?.activeAccountId
      );
      if (
        activeAcc?.type === "cloud" &&
        activeAcc?.nodeDeployEnv !== "local" &&
        !isMobileAppTarget() &&
        cur.localBackendUrl
      ) {
        try {
          ws.send(
            JSON.stringify({
              type: "host_hello",
              hostId: window.twinklebotDesktop?.platform || "desktop-host",
              hostname:
                cur.computerStatus?.hostComputer?.hostname ||
                cur.settings?.profile?.name ||
                "Desktop Host",
              platform: window.twinklebotDesktop?.platform || "desktop",
            })
          );
        } catch {}
      }
      if (shouldSync) {
        syncSessionsAndActiveOnReconnect(epoch);
      }
    };

    ws.onmessage = (evt) => {
      if (epoch !== getState().accountEpoch) return;
      runtimeRefs.wsLastMessageAt = Date.now();
      runtimeRefs.wsMissedPongs = 0;
      if (runtimeRefs.wsPongTimeoutTimer) {
        clearTimeout(runtimeRefs.wsPongTimeoutTimer);
        runtimeRefs.wsPongTimeoutTimer = null;
      }
      try {
        const payload = JSON.parse(String(evt.data));
        if (payload && payload.type === "pong") {
          if (runtimeRefs.wsLastPingSentAt > 0) {
            const rtt = Math.max(1, Date.now() - runtimeRefs.wsLastPingSentAt);
            runtimeRefs.wsLastPingSentAt = 0;
            reportHeartbeatRtt(rtt);
          }
          return;
        }
        handleRealtimePayload(payload);
      } catch {}
    };

    ws.onerror = () => {
      if (runtimeRefs.wsConnectTimeoutTimer) {
        clearTimeout(runtimeRefs.wsConnectTimeoutTimer);
        runtimeRefs.wsConnectTimeoutTimer = null;
      }
      if (!openedOnce && epoch === getState().accountEpoch && !runtimeRefs.eventSource) {
        connectGlobalSse(epoch);
      }
    };

    ws.onclose = () => {
      if (runtimeRefs.wsConnectTimeoutTimer) {
        clearTimeout(runtimeRefs.wsConnectTimeoutTimer);
        runtimeRefs.wsConnectTimeoutTimer = null;
      }
      if (epoch !== getState().accountEpoch) return;
      clearHeartbeatTimers();
      runtimeRefs.wsSocket = null;
      if (!runtimeRefs.eventSource) {
        setRealtimeConnectedMarker(false);
      }
      if (!openedOnce) {
        if (!runtimeRefs.eventSource) {
          connectGlobalSse(epoch);
        }
        return;
      }
      scheduleTransportReconnect(epoch, "ws_closed");
    };
  } catch {
    connectGlobalSse(epoch);
  }
}

export async function reconnectRealtimeNow(): Promise<boolean> {
  const s = getState();
  if (!hasActiveTransportTarget(s)) {
    disconnectRealtimeTransport();
    return false;
  }
  const epoch = s.accountEpoch;
  try {
    const probeOpts = { timeoutMs: 4000, suppressLanOfflineModal: true };
    let res = await apiFetch("/api/relay/ping", probeOpts);
    if (res.status === 404) {
      res = await apiFetch("/api/system/health", probeOpts);
    }
    if (!res.ok || epoch !== getState().accountEpoch) {
      return false;
    }
    runtimeRefs.wsReconnectAttempt = 0;
    connectRealtimeTransport();
    markLanReachable();
    await syncSessionsAndActiveOnReconnect(epoch);
    return true;
  } catch {
    return false;
  }
}

export function probeActiveTransportOnResume() {
  const s = getState();
  if (!hasActiveTransportTarget(s)) {
    disconnectRealtimeTransport();
    return;
  }
  const now = Date.now();
  if (runtimeRefs.lastVisibilityProbeAt && now - runtimeRefs.lastVisibilityProbeAt < 2000) {
    return;
  }
  runtimeRefs.lastVisibilityProbeAt = now;
  const epoch = s.accountEpoch;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const ws = runtimeRefs.wsSocket;
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendWsHeartbeatPing(ws, epoch, 6000, { force: true });
    return;
  }
  if (!runtimeRefs.eventSource && !ws) {
    runtimeRefs.wsReconnectAttempt = 0;
    connectRealtimeTransport();
  }
}
