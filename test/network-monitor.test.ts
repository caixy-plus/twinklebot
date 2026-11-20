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
