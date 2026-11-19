import { isMobileAppTarget } from "../mobile-bridge.js";
import { getState, runtimeRefs, setState } from "../state/store.js";
import { apiJson, apiUrl, markLanReachable } from "./api-client.js";
import {
  applySessionClearedUI,
  applySessionRewoundUI,
  refreshComputerDisplays,
  refreshLibrary,
  refreshSchedules,
  refreshSettingsFromServer,
  refreshUsageAndHealth,
  refreshVault,
  renderEventForActiveSession,
  runWhenSettingsScrollIdle,
  selectSession,
  showToast,
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
          ? { error: `需要审批: ${data.reason || ""}` }
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
          deviceName: payload.deviceName || "手机端",
          code: String(payload.code),
        },
      });
      showToast(`📱 手机端配对码：${payload.code}`);
    }
    return;
  }

  if (payload.type === "lan_device_paired") {
    setState((prev) => ({
      desktopPairingModal: { ...prev.desktopPairingModal, open: false },
    }));
    showToast(`✓ 已完成配对：${payload.device?.name || "手机端"}`);
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
    showToast(`新 Bot「${payload.bot.title}」已创建`);
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

export function disconnectRealtimeTransport() {
  setRealtimeConnectedMarker(false);
  if (runtimeRefs.wsReconnectTimer) {
    clearTimeout(runtimeRefs.wsReconnectTimer);
    runtimeRefs.wsReconnectTimer = null;
  }
  if (runtimeRefs.wsSocket) {
    try {
      runtimeRefs.wsSocket.onclose = null;
      runtimeRefs.wsSocket.onerror = null;
      runtimeRefs.wsSocket.onmessage = null;
      runtimeRefs.wsSocket.close();
    } catch {}
    runtimeRefs.wsSocket = null;
  }
  if (runtimeRefs.eventSource) {
    try {
      runtimeRefs.eventSource.close();
    } catch {}
    runtimeRefs.eventSource = null;
  }
}

export function connectGlobalSse(epoch = getState().accountEpoch) {
  if (typeof EventSource !== "function") return;
  const cur = getState();
  const activeAcc = (cur.accountsState?.accounts || []).find(
    (a) => a.id === cur.accountsState?.activeAccountId
  );
  if (activeAcc?.type === "lan" && cur.lanNodeOffline) return;
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
  es.onopen = () => {
    if (epoch !== getState().accountEpoch) {
      es.close();
      return;
    }
    sseOpened = true;
    setRealtimeConnectedMarker(true);
    markLanReachable();
  };
  es.onmessage = (msg) => {
    if (epoch !== getState().accountEpoch) return;
    try {
      handleRealtimePayload(JSON.parse(msg.data));
    } catch {}
  };
  es.onerror = () => {
    if (epoch !== getState().accountEpoch || !sseOpened) {
      try {
        es.close();
      } catch {}
      if (runtimeRefs.eventSource === es) runtimeRefs.eventSource = null;
    }
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
  const epoch = s.accountEpoch;
  let wsTarget = s.activeWsUrl;
  if (!wsTarget && typeof window !== "undefined") {
    try {
      const httpBase = s.activeBaseUrl || window.location.origin;
      const u = new URL(httpBase);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/ws";
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

    ws.onopen = () => {
      if (epoch !== getState().accountEpoch) {
        ws.close();
        return;
      }
      const isReconnect = runtimeRefs.wsHasOpenedInEpoch === true;
      runtimeRefs.wsHasOpenedInEpoch = true;
      openedOnce = true;
      setRealtimeConnectedMarker(true);
      markLanReachable();

      const cur = getState();
      const activeAcc = (cur.accountsState?.accounts || []).find(
        (a) => a.id === cur.accountsState?.activeAccountId
      );
      if (activeAcc?.type === "cloud" && !isMobileAppTarget() && cur.localBackendUrl) {
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
      if (isReconnect) {
        syncSessionsAndActiveOnReconnect(epoch);
      }
    };

    ws.onmessage = (evt) => {
      if (epoch !== getState().accountEpoch) return;
      try {
        handleRealtimePayload(JSON.parse(String(evt.data)));
      } catch {}
    };

    ws.onerror = () => {
      if (!openedOnce && epoch === getState().accountEpoch && !runtimeRefs.eventSource) {
        connectGlobalSse(epoch);
      }
    };

    ws.onclose = () => {
      if (epoch !== getState().accountEpoch) return;
      runtimeRefs.wsSocket = null;
      if (!runtimeRefs.eventSource) {
        setRealtimeConnectedMarker(false);
      }
      if (!openedOnce) {
        connectGlobalSse(epoch);
        return;
      }
      runtimeRefs.wsReconnectTimer = setTimeout(() => {
        if (epoch === getState().accountEpoch) connectRealtimeTransport();
      }, 2000);
    };
  } catch {
    connectGlobalSse(epoch);
  }
}
