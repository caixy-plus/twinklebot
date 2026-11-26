import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SSR_BUNDLE_PATH = path.join(ROOT, "dist-server", "web-ssr", "ssr-entry.js");

const CLOUD_ACCOUNTS = {
  activeAccountId: "cloud-1",
  accounts: [
    { id: "local", type: "local", name: "本地账号" },
    { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
  ],
};

test("computeReconnectDelayMs applies capped exponential backoff with optional jitter", async () => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  assert.equal(ssr.computeReconnectDelayMs(1, { jitterRatio: 0 }), 1000);
  assert.equal(ssr.computeReconnectDelayMs(2, { jitterRatio: 0 }), 2000);
  assert.equal(ssr.computeReconnectDelayMs(3, { jitterRatio: 0 }), 4000);
  assert.equal(ssr.computeReconnectDelayMs(4, { jitterRatio: 0 }), 8000);
  assert.equal(ssr.computeReconnectDelayMs(5, { jitterRatio: 0 }), 15000);
  assert.equal(ssr.computeReconnectDelayMs(9, { jitterRatio: 0 }), 15000);

  const jittered = ssr.computeReconnectDelayMs(2, { jitterRatio: 0.2, randomFn: () => 0.75 });
  assert.equal(jittered, 2200);
});

test("network-monitor transitions across weak -> reconnecting -> offline -> recovered and honors account type", async (t) => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  t.after(() => {
    ssr.clearNetworkMonitorTimers();
    ssr.disconnectRealtimeTransport();
  });

  // 1. Cloud account detects high heartbeat RTT as weak, supports dismiss, and escalates after 3 disconnects
  ssr.resetStoreForTest({
    accountsState: CLOUD_ACCOUNTS,
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 10,
  });
  ssr.clearNetworkMonitorTimers();

  assert.equal(ssr.getState().networkHealth.status, "online");
  assert.equal(ssr.isRemoteAccountOffline(ssr.getState()), false);

  ssr.reportHeartbeatRtt(2200);
  assert.equal(ssr.getState().networkHealth.status, "weak");
  assert.equal(ssr.getState().networkHealth.rttMs, 2200);
  assert.equal(ssr.isRemoteAccountOffline(ssr.getState()), false);

  ssr.dismissWeakNetworkBanner();
  assert.equal(ssr.getState().networkHealth.dismissedWeakBanner, true);

  ssr.reportTransportDisconnected({ attempt: 1, nextRetryDelayMs: 1000, reason: "ws_closed" });
  assert.equal(ssr.getState().networkHealth.status, "reconnecting");
  assert.equal(ssr.getState().networkHealth.reconnectAttempt, 1);

  ssr.reportTransportDisconnected({ attempt: 3, nextRetryDelayMs: 4000, reason: "ws_closed" });
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.isRemoteAccountOffline(ssr.getState()), true);

  // Reconnect transitions to brief "recovered" banner
  ssr.reportTransportConnected("ws", true);
  assert.equal(ssr.getState().networkHealth.status, "recovered");
  assert.equal(ssr.isRemoteAccountOffline(ssr.getState()), false);

  // Browser offline immediately forces offline regardless of attempt count
  ssr.handleBrowserOnlineChange(false);
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.getState().networkHealth.browserOffline, true);

  // Local desktop account is never locked by remote-offline guard
  ssr.resetStoreForTest({
    accountsState: { ...CLOUD_ACCOUNTS, activeAccountId: "local" },
    accountEpoch: 11,
  });
  ssr.clearNetworkMonitorTimers();
  ssr.reportTransportDisconnected({ attempt: 4, nextRetryDelayMs: 8000 });
  assert.equal(ssr.isRemoteAccountOffline(ssr.getState()), false);
});

test("realtime reconnect recovers after both initial WS and SSE fail (fixes permanent disconnect bug)", async (t) => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  const origWs = globalThis.WebSocket;
  const origEs = globalThis.EventSource;
  t.after(() => {
    ssr.disconnectRealtimeTransport();
    ssr.clearNetworkMonitorTimers();
    globalThis.WebSocket = origWs;
    globalThis.EventSource = origEs;
  });

  ssr.resetStoreForTest({
    accountsState: CLOUD_ACCOUNTS,
    activeBaseUrl: "https://cloud.example.com",
    activeWsUrl: "wss://cloud.example.com/ws",
    accountEpoch: 20,
  });
  ssr.runtimeRefs.wsReconnectAttempt = 0;

  let wsAttempts = 0;
  let sseAttempts = 0;

  class FailingWebSocket {
    static OPEN = 1;
    readyState = 0;
    onopen: any = null;
    onmessage: any = null;
    onerror: any = null;
    onclose: any = null;
    constructor() {
      wsAttempts += 1;
      queueMicrotask(() => {
        this.onerror?.(new Event("error"));
        this.onclose?.(new Event("close"));
      });
    }
    close() {}
    send() {}
  }

  class FailingEventSource {
    onopen: any = null;
    onmessage: any = null;
    onerror: any = null;
    constructor() {
      sseAttempts += 1;
      queueMicrotask(() => {
        this.onerror?.(new Event("error"));
      });
    }
    close() {}
  }

  globalThis.WebSocket = FailingWebSocket as any;
  globalThis.EventSource = FailingEventSource as any;

  ssr.connectRealtimeTransport();
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(wsAttempts, 1);
  assert.equal(sseAttempts, 1);
  assert.ok(ssr.runtimeRefs.wsReconnectTimer, "must schedule backoff reconnect even after both WS and SSE fail on initial connect");
  assert.equal(ssr.getState().networkHealth.status, "reconnecting");
  assert.equal(ssr.getState().networkHealth.reconnectAttempt, 1);
});

test("SSR renders unified NetworkStatusBanner copy (账号 terminology, uniform text buttons) and offline read-only Settings guard", async () => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);

  // 1. Weak state: unified text pill "收起", no isolated "×" button, no "节点" word
  const weakHtml = ssr.renderAppToStaticMarkup({
    accountsState: CLOUD_ACCOUNTS,
    networkHealth: {
      status: "weak",
      rttMs: 1900,
      reconnectAttempt: 0,
      nextRetryAt: null,
      transport: "ws",
      reason: "slow_rtt",
      browserOffline: false,
      dismissedWeakBanner: false,
      updatedAt: Date.now(),
    },
  });
  assert.ok(weakHtml.includes('data-network-status="weak"'));
  assert.ok(weakHtml.includes("当前网络较慢（1.9s），响应可能变慢"));
  assert.ok(weakHtml.includes(">收起</button>"));
  assert.ok(!weakHtml.includes("切换节点"), "banner must use 账号 terminology, never 节点");

  // 2. Offline state with SettingsModal open: shows banner with "重新连接" + "切换账号", disables remote fieldsets while keeping theme select enabled
  const offlineHtml = ssr.renderAppToStaticMarkup({
    accountsState: CLOUD_ACCOUNTS,
    settingsModal: { open: true, activeTab: "general" },
    networkHealth: {
      status: "offline",
      rttMs: null,
      reconnectAttempt: 3,
      nextRetryAt: null,
      transport: "none",
      reason: "ws_closed",
      browserOffline: false,
      dismissedWeakBanner: false,
      updatedAt: Date.now(),
    },
  });
  assert.ok(offlineHtml.includes('data-network-status="offline"'));
  assert.ok(offlineHtml.includes("无法连接至云端主账号"));
  assert.ok(offlineHtml.includes(">重新连接</button>"));
  assert.ok(offlineHtml.includes(">切换账号</button>"));
  assert.ok(offlineHtml.includes("远端配置暂为只读（外观与账号切换仍可用）"));
  assert.ok(offlineHtml.includes('data-remote-offline-guard="profile" disabled'));
  assert.ok(offlineHtml.includes('data-remote-offline-guard="models" disabled'));
  // Appearance theme select stays enabled (NOT inside a disabled fieldset)
  assert.ok(offlineHtml.includes('id="setting-theme-select"'));

  // 3. Recovered state: green confirmation without action buttons
  const recoveredHtml = ssr.renderAppToStaticMarkup({
    accountsState: CLOUD_ACCOUNTS,
    networkHealth: {
      status: "recovered",
      rttMs: 120,
      reconnectAttempt: 0,
      nextRetryAt: null,
      transport: "ws",
      reason: "",
      browserOffline: false,
      dismissedWeakBanner: false,
      updatedAt: Date.now(),
    },
  });
  assert.ok(recoveredHtml.includes('data-network-status="recovered"'));
  assert.ok(recoveredHtml.includes("连接已恢复，已同步最新状态"));
});

test("AccountDisconnectedGate blocks remote offline accounts (cloud/LAN) with native <dialog closedby=none> and never blocks local desktop account or Core OTA switch", async () => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);

  // 1. Remote cloud offline -> gate opens with refresh + account switch list
  const cloudOfflineHtml = ssr.renderAppToStaticMarkup({
    accountsState: CLOUD_ACCOUNTS,
    networkHealth: {
      status: "offline",
      rttMs: null,
      reconnectAttempt: 3,
      nextRetryAt: null,
      transport: "none",
      reason: "ws_closed",
      browserOffline: false,
      dismissedWeakBanner: false,
      updatedAt: Date.now(),
    },
  });
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);
  assert.match(cloudOfflineHtml, /<dialog[^>]*id="account-disconnected-gate"[^>]*closedby="none"/);
  assert.ok(cloudOfflineHtml.includes('data-account-gate-open="true"'));
  assert.ok(cloudOfflineHtml.includes('id="account-gate-refresh-btn"'));
  assert.ok(cloudOfflineHtml.includes("刷新当前账号"));
  assert.ok(cloudOfflineHtml.includes('data-account-gate-switch-id="local"'));
  assert.ok(cloudOfflineHtml.includes("本地账号 · 始终可用"));
  assert.ok(!cloudOfflineHtml.includes('id="account-disconnected-gate" open'), "native modal <dialog> must not use open attribute");

  // 2. Core OTA hot-swap in progress -> gate suppressed
  ssr.resetStoreForTest({
    accountsState: CLOUD_ACCOUNTS,
    networkHealth: {
      status: "offline",
      rttMs: null,
      reconnectAttempt: 3,
      nextRetryAt: null,
      transport: "none",
      reason: "ws_closed",
      browserOffline: false,
      dismissedWeakBanner: false,
      updatedAt: Date.now(),
    },
    updateState: {
      ...ssr.createInitialState().updateState,
      coreSwitchInProgress: true,
    },
  });
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), false);

  // 3. Desktop local account -> gate NEVER activates even when browserOffline=true
  const localOfflineHtml = ssr.renderAppToStaticMarkup({
    accountsState: { ...CLOUD_ACCOUNTS, activeAccountId: "local" },
    networkHealth: {
      status: "offline",
      rttMs: null,
      reconnectAttempt: 4,
      nextRetryAt: null,
      transport: "none",
      reason: "browser_offline",
      browserOffline: true,
      dismissedWeakBanner: false,
      updatedAt: Date.now(),
    },
  });
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), false);
  assert.ok(localOfflineHtml.includes('data-account-gate-open="false"'));

  // 4. Mobile LAN offline -> gate activates via lanNodeOffline
  const lanOfflineHtml = ssr.renderAppToStaticMarkup({
    accountsState: {
      activeAccountId: "lan-1",
      accounts: [
        { id: "lan-1", type: "lan", name: "办公室 Mac", baseUrl: "http://192.168.1.10:3230" },
        { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
      ],
    },
    lanNodeOffline: true,
  });
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);
  assert.ok(lanOfflineHtml.includes('data-account-gate-open="true"'));
  assert.ok(lanOfflineHtml.includes('data-account-gate-switch-id="cloud-1"'));
});

test("Issue #4: silent reconnects, weak->online settling, and rapid recovery cooldown never spam recovered banner", async (t) => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  t.after(() => {
    ssr.clearNetworkMonitorTimers();
    ssr.disconnectRealtimeTransport();
  });

  ssr.resetStoreForTest({
    accountsState: CLOUD_ACCOUNTS,
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 30,
  });
  ssr.clearNetworkMonitorTimers();

  // 1. Mobile thresholds use relaxed anti-flap heartbeat timeouts
  const mobThresh = ssr.getNetworkThresholds(true);
  assert.ok(mobThresh.pingIntervalMs >= 25000);
  assert.ok(mobThresh.pongTimeoutMs >= 10000);
  assert.ok(mobThresh.resumeBgThresholdMs >= 8000);

  // 2. Silent reconnect while already online must stay online (never flash "recovered")
  ssr.reportTransportConnected("ws", true);
  assert.equal(ssr.getState().networkHealth.status, "online");

  // 3. Settling from weak back to connected must NOT flash "recovered"
  ssr.reportHeartbeatRtt(2400);
  assert.equal(ssr.getState().networkHealth.status, "weak");
  ssr.reportTransportConnected("ws", true);
  assert.equal(ssr.getState().networkHealth.status, "online");

  // 4. Genuine disruption (reconnecting -> connected) shows recovered once, then cooldown suppresses immediate repeat spam
  ssr.reportTransportDisconnected({ attempt: 1, nextRetryDelayMs: 1000, reason: "ws_closed" });
  assert.equal(ssr.getState().networkHealth.status, "reconnecting");
  ssr.reportTransportConnected("ws", true);
  assert.equal(ssr.getState().networkHealth.status, "recovered");

  // Immediate second blip within 15s cooldown settles quietly to online
  ssr.reportTransportDisconnected({ attempt: 1, nextRetryDelayMs: 1000, reason: "ws_closed" });
  ssr.reportTransportConnected("ws", true);
  assert.equal(ssr.getState().networkHealth.status, "online");

  // 5. Healthy WS pong clears stuck reconnecting/offline AND shields against late pre-recovery HTTP timeouts
  ssr.reportTransportDisconnected({ attempt: 3, nextRetryDelayMs: 4000, reason: "ws_closed" });
  assert.equal(ssr.getState().networkHealth.status, "offline");
  ssr.reportHeartbeatRtt(120);
  assert.ok(
    ssr.getState().networkHealth.status === "online" || ssr.getState().networkHealth.status === "recovered",
    "Live WS pong must clear stuck offline/reconnecting status"
  );
  ssr.reportHttpOutcome({ ok: false, elapsedMs: 15000, timedOut: true, accountType: "cloud" });
  ssr.reportHttpOutcome({ ok: false, elapsedMs: 15000, timedOut: true, accountType: "cloud" });
  assert.notEqual(
    ssr.getState().networkHealth.status,
    "offline",
    "Late pre-recovery HTTP timeouts must not pop AccountDisconnectedGate while WS pong is fresh"
  );
});

test("Mobile client never exposes local account, locks gate on unconfigured/offline/502/401, and probes before unlocking", async (t) => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  const prevFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prevFetch;
    ssr.clearNetworkMonitorTimers();
    ssr.disconnectRealtimeTransport();
  });

  // 1. Mobile with empty accounts -> gate locked in setup mode without any local account
  const emptyMobileHtml = ssr.renderAppToStaticMarkup({
    isMobileClient: true,
    accountsState: { activeAccountId: "", accounts: [] },
  });
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);
  assert.ok(emptyMobileHtml.includes('data-account-gate-open="true"'));
  assert.ok(emptyMobileHtml.includes('data-account-gate-mode="setup"'));
  assert.equal(emptyMobileHtml.includes('data-account-gate-switch-id="local"'), false);

  // 2. Mobile offline with ghost local entry in state -> local never appears in gate switch list
  const mobileWithGhostLocalHtml = ssr.renderAppToStaticMarkup({
    isMobileClient: true,
    accountsState: {
      activeAccountId: "lan-1",
      accounts: [
        { id: "local", type: "local", name: "本地账号", baseUrl: "" },
        { id: "lan-1", type: "lan", name: "办公室 Mac", baseUrl: "http://192.168.1.10:3230" },
        { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
      ],
    },
    lanNodeOffline: true,
  });
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);
  assert.equal(mobileWithGhostLocalHtml.includes('data-account-gate-switch-id="local"'), false);
  assert.equal(mobileWithGhostLocalHtml.includes("本地账号 · 始终可用"), false);
  assert.ok(mobileWithGhostLocalHtml.includes('data-account-gate-switch-id="cloud-1"'));

  // 3. Probe-before-unlock: switching from gate to an unreachable account keeps gate locked
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as any;
  const switchFail = await ssr.switchAccountFromGate("cloud-1");
  assert.equal(switchFail.ok, false);
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);
  assert.equal(ssr.getState().accountsState.activeAccountId, "lan-1");

  // 4. Gateway 502 and remote 401 mark mobile remote account offline instead of reporting ok
  ssr.resetStoreForTest({
    isMobileClient: true,
    accountsState: {
      activeAccountId: "cloud-1",
      accounts: [
        { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
      ],
    },
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 40,
  });
  globalThis.fetch = (async () => new Response("Bad Gateway", { status: 502 })) as any;
  await ssr.apiFetch("/api/system/health");
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);

  ssr.resetStoreForTest({
    isMobileClient: true,
    accountsState: {
      activeAccountId: "cloud-1",
      accounts: [
        { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
      ],
    },
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 41,
  });
  globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as any;
  await ssr.apiFetch("/api/system/health");
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.getState().networkHealth.reason, "auth_failed");
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);
});

test("401 auth_failed renders auth-failed gate, probes /api/relay/ping without flapping, and ignores local-control 401", async (t) => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  const prevFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prevFetch;
    ssr.clearNetworkMonitorTimers();
    ssr.disconnectRealtimeTransport();
  });

  // 1. Local-control endpoints (X-Local-Token) returning 401 must NOT lock remote account
  ssr.resetStoreForTest({
    accountsState: CLOUD_ACCOUNTS,
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 50,
  });
  ssr.clearNetworkMonitorTimers();
  globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as any;
  await ssr.apiFetch("http://127.0.0.1:3230/api/desktop/wake");
  assert.equal(ssr.getState().networkHealth.status, "online");
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), false);

  // 2. Remote API 401 sets reason="auth_failed", renders auth-failed gate, and refresh probes /api/relay/ping
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const urlStr = typeof input === "string" ? input : String((input as Request).url || input);
    requestedUrls.push(urlStr);
    if (urlStr.includes("/api/system/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }) as any;

  await ssr.apiFetch("/api/config");
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.getState().networkHealth.reason, "auth_failed");

  const authGateHtml = ssr.renderAppToStaticMarkup({
    isMobileClient: true,
    accountsState: {
      activeAccountId: "cloud-1",
      accounts: [
        { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
      ],
    },
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 51,
    networkHealth: ssr.getState().networkHealth,
  });
  assert.ok(authGateHtml.includes('data-account-gate-mode="auth-failed"'));
  assert.ok(authGateHtml.includes("账号认证已失效"));

  requestedUrls.length = 0;
  const refreshRes = await ssr.refreshActiveAccountConnection(51);
  assert.equal(refreshRes.ok, false);
  assert.ok(
    requestedUrls.some((u) => u.includes("/api/relay/ping")),
    "refreshActiveAccountConnection must probe /api/relay/ping"
  );
  assert.equal(
    requestedUrls.some((u) => u.includes("/api/system/health")),
    false,
    "refreshActiveAccountConnection must NOT fall back to unauthenticated /api/system/health on 401"
  );
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.getState().networkHealth.reason, "auth_failed");
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);
});

test("Browser online resume keeps remote gate locked until probe succeeds, and reconnecting timeout escalates to offline", async (t) => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  t.after(() => {
    ssr.clearNetworkMonitorTimers();
    ssr.disconnectRealtimeTransport();
  });

  ssr.resetStoreForTest({
    isMobileClient: true,
    accountsState: {
      activeAccountId: "cloud-1",
      accounts: [
        { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
      ],
    },
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 60,
  });
  ssr.clearNetworkMonitorTimers();

  // Offline -> online on remote account clears browserOffline while keeping status="offline"
  ssr.handleBrowserOnlineChange(false);
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.getState().networkHealth.browserOffline, true);

  ssr.handleBrowserOnlineChange(true);
  assert.equal(ssr.getState().networkHealth.browserOffline, false);
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.shouldShowAccountDisconnectedGate(ssr.getState()), true);

  // Local account still enters reconnecting on browser online resume
  ssr.resetStoreForTest({
    isMobileClient: false,
    accountsState: { ...CLOUD_ACCOUNTS, activeAccountId: "local" },
    accountEpoch: 61,
  });
  ssr.handleBrowserOnlineChange(false);
  ssr.handleBrowserOnlineChange(true);
  assert.equal(ssr.getState().networkHealth.status, "reconnecting");

  // Single HTTP timeout while already reconnecting escalates remote account to offline
  ssr.resetStoreForTest({
    isMobileClient: true,
    accountsState: {
      activeAccountId: "cloud-1",
      accounts: [
        { id: "cloud-1", type: "cloud", name: "云端主账号", baseUrl: "https://cloud.example.com" },
      ],
    },
    activeBaseUrl: "https://cloud.example.com",
    accountEpoch: 62,
    networkHealth: {
      ...ssr.createInitialState().networkHealth,
      status: "reconnecting",
      reconnectAttempt: 1,
      reason: "ws_closed",
    },
  });
  ssr.clearNetworkMonitorTimers();
  ssr.reportHttpOutcome({ ok: false, elapsedMs: 5000, timedOut: true, accountType: "cloud" });
  assert.equal(ssr.getState().networkHealth.status, "offline");
  assert.equal(ssr.getState().networkHealth.reason, "timeout");
});

test("Mobile setup mode (no active account) short-circuits connectRealtimeTransport, probe, and reconnectRealtimeNow", async (t) => {
  const ssr = await import(pathToFileURL(SSR_BUNDLE_PATH).href);
  const origWs = globalThis.WebSocket;
  const origEs = globalThis.EventSource;
  const origFetch = globalThis.fetch;
  t.after(() => {
    ssr.disconnectRealtimeTransport();
    ssr.clearNetworkMonitorTimers();
    globalThis.WebSocket = origWs;
    globalThis.EventSource = origEs;
    globalThis.fetch = origFetch;
  });

  let wsCalls = 0;
  let esCalls = 0;
  let fetchCalls = 0;

  globalThis.WebSocket = class MockWs {
    constructor() {
      wsCalls += 1;
    }
    close() {}
  } as any;
  globalThis.EventSource = class MockEs {
    constructor() {
      esCalls += 1;
    }
    close() {}
  } as any;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("ok", { status: 200 });
  }) as any;

  ssr.resetStoreForTest({
    isMobileClient: true,
    accountsState: { activeAccountId: "", accounts: [] },
    activeBaseUrl: "",
    activeWsUrl: "",
    accountEpoch: 70,
  });

  ssr.connectRealtimeTransport();
  ssr.probeActiveTransportOnResume();
  const reconnectOk = await ssr.reconnectRealtimeNow();

  assert.equal(reconnectOk, false);
  assert.equal(wsCalls, 0, "Setup mode must not open WebSocket");
  assert.equal(esCalls, 0, "Setup mode must not open EventSource");
  assert.equal(fetchCalls, 0, "Setup mode must not call fetch during reconnect");
});
