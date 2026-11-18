import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeAccountsState,
  upsertLanAccount,
  removeCloudAccount,
} from "../src/shared/accounts-store.js";

test("accounts-store supports paired LAN computer nodes alongside local and cloud accounts", () => {
  const init = normalizeAccountsState(null, "");
  const s1 = upsertLanAccount(init, {
    instanceId: "mac-123",
    name: "MacBook Pro",
    baseUrl: "http://192.168.1.25:3230",
    deviceToken: "tok-lan-abc",
    hostname: "MacBook-Pro.local",
    platform: "darwin",
  });
  const lan = s1.accounts.find((a) => a.type === "lan");
  assert.ok(lan);
  assert.equal(lan.baseUrl, "http://192.168.1.25:3230");
  assert.equal(lan.wsUrl, "ws://192.168.1.25:3230/ws");
  assert.equal(lan.authToken, "tok-lan-abc");
  assert.equal(lan.instanceId, "mac-123");

  // Updating by same instanceId updates in place without duplicates
  const s1b = upsertLanAccount(s1, {
    instanceId: "mac-123",
    name: "MacBook Pro",
    baseUrl: "http://192.168.1.33:3230",
    deviceToken: "tok-lan-new",
  });
  assert.equal(s1b.accounts.filter((a) => a.type === "lan").length, 1);
  assert.equal(s1b.accounts.find((a) => a.type === "lan")?.baseUrl, "http://192.168.1.33:3230");

  const s2 = removeCloudAccount(s1b, lan.id);
  assert.equal(s2.accounts.some((a) => a.id === lan.id), false);
});

test("public/app.js implements mobile LAN fast-fail, foreground WS reconnect, and host offline state", async () => {
  const { readWebDistJs, readWebSourceTs } = await import("./helpers/react-test-helpers.js");
  const appJs = readWebSourceTs();
  const distJs = readWebDistJs();
  assert.ok(appJs.includes("./mobile-bridge.js"));
  assert.ok(distJs.includes("./mobile-bridge.js"));
  assert.ok(appJs.includes("triggerLanUnreachableFallback"));
  assert.ok(appJs.includes("/api/lan/pair/request"));
  assert.ok(appJs.includes("/api/lan/pair/verify"));
  assert.ok(appJs.includes("/api/computer/hosts"));
  assert.ok(appJs.includes("宿主机离线/不可用"));
  assert.ok(appJs.includes("onAppForeground"));

  const bridgeJs = fs.readFileSync(path.resolve("public/dist/mobile-bridge.js"), "utf8");
  assert.ok(bridgeJs.includes("baseUrl"), "discoverLanDevices must preserve baseUrl for LAN pairing");
  assert.ok(appJs.includes("syncSessionsAndActiveOnReconnect"));
  assert.ok(appJs.includes("activeState"));
});

test("GET /api/sessions/:id reports live activeState so mobile reconnect clears stale status bubbles", async (t) => {
  const os = await import("node:os");
  const { createStore } = await import("../src/store/index.js");
  const { createServer } = await import("../src/server/index.js");
  const tmpDir = fs.mkdtempSync(path.join(os.default.tmpdir(), "gb-session-activestate-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const sBusy = store.createSession({ title: "Busy Bot" });
  const sDone = store.createSession({ title: "Done Bot" });
  store.updateSession(sDone.id, { status: "done" });

  const srv = createServer({
    store,
    runner: {
      status: () => ({ sessionId: sBusy.id, state: "running" }),
      activeSessions: () => ({ [sBusy.id]: "running" }),
      queueStatus: () => 0,
      subscribe: () => () => {},
      broadcastGlobal: () => {},
      stop: () => {},
    },
    executor: { health: async () => ({ ok: true }) },
    config: { port: 0, writeRoots: [tmpDir] },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const busyRes = await fetch(`${base}/api/sessions/${sBusy.id}`).then((r) => r.json());
  assert.equal(busyRes.activeState, "running");

  const doneRes = await fetch(`${base}/api/sessions/${sDone.id}`).then((r) => r.json());
  assert.equal(doneRes.activeState, null);
});

test("LAN unreachable offline modal does not re-pop repeatedly after dismissal or during reload/poll cascades", async (t) => {
  const { ssr, renderAppHtml } = await import("./helpers/react-test-helpers.js");
  const prevFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prevFetch;
  });

  const lanAccountsState = {
    activeAccountId: "lan-mac",
    accounts: [
      { id: "local", type: "local", name: "本地电脑", baseUrl: "", wsUrl: "" },
      {
        id: "lan-mac",
        type: "lan",
        name: "MacBook Pro",
        baseUrl: "http://192.168.1.99:3230",
        wsUrl: "ws://192.168.1.99:3230/ws",
        authToken: "lan-tok",
      },
    ],
  };

  ssr.resetStoreForTest({
    accountsState: lanAccountsState,
    activeBaseUrl: "http://192.168.1.99:3230",
    activeWsUrl: "ws://192.168.1.99:3230/ws",
    activeAuthToken: "lan-tok",
    accountEpoch: 1,
  });

  // 1) Initial network failure opens the offline modal once
  let fetchUrls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    fetchUrls.push(String(url));
    throw new TypeError("Failed to fetch");
  }) as any;

  await ssr.reloadWorkspaceForActiveAccount(1);
  assert.equal(ssr.getState().lanOfflineModalShown, true);
  assert.equal(ssr.getState().lanNodeOffline, true);
  // Early-exit stops reload cascade right after /api/config fails instead of firing settings/sessions/schedules/usage
  assert.deepEqual(fetchUrls, ["http://192.168.1.99:3230/api/config"]);

  // 2) Dismissing modal (hardware back / close btn / backdrop) keeps offline dot red without re-opening on subsequent failures
  ssr.dismissLanOfflineModal();
  assert.equal(ssr.getState().lanOfflineModalShown, false);
  assert.equal(ssr.getState().lanOfflineDismissed, true);
  assert.equal(ssr.getState().lanNodeOffline, true);

  const dismissedHtml = renderAppHtml({
    accountsState: lanAccountsState,
    lanOfflineModalShown: false,
    lanNodeOffline: true,
    lanOfflineDismissed: true,
  });
  assert.ok(dismissedHtml.includes('id="mobile-node-dot" class="mobile-node-dot" data-online="false"'));
  assert.ok(dismissedHtml.includes('id="mobile-lan-offline-close-btn"'));

  ssr.triggerLanUnreachableFallback(new TypeError("Failed to fetch"));
  assert.equal(ssr.getState().lanOfflineModalShown, false, "background trigger after dismiss must not re-open modal");

  // 3) Deliberate AbortError from caller signal must not open offline modal even before dismissal
  ssr.resetStoreForTest({
    accountsState: lanAccountsState,
    activeBaseUrl: "http://192.168.1.99:3230",
    accountEpoch: 2,
  });
  const callerAbort = new AbortController();
  callerAbort.abort();
  globalThis.fetch = (async (_url: string, init: any) => {
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return new Response("{}", { status: 200 });
  }) as any;
  await assert.rejects(() => ssr.apiFetch("/api/usage", { signal: callerAbort.signal }));
  assert.equal(ssr.getState().lanOfflineModalShown, false);
  assert.equal(ssr.getState().lanNodeOffline, false);

  // 4) Clicking Retry ("留在此页重试") while still offline closes modal and stays dismissed without popping again
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as any;
  const retriedOk = await ssr.retryActiveLanConnection(2);
  assert.equal(retriedOk, false);
  assert.equal(ssr.getState().lanOfflineModalShown, false);
  assert.equal(ssr.getState().lanOfflineDismissed, true);
  assert.equal(ssr.getState().lanNodeOffline, true);

  // 5) Once LAN becomes reachable again, offline & dismissal flags reset cleanly so a later disconnect can surface once
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/api/system/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(url).endsWith("/api/sessions")) {
      return new Response(JSON.stringify({ sessions: [], activeSessions: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  await ssr.apiFetch("/api/system/health");
  assert.equal(ssr.getState().lanNodeOffline, false);
  assert.equal(ssr.getState().lanOfflineDismissed, false);
  assert.equal(ssr.getState().lanOfflineModalShown, false);

  ssr.triggerLanUnreachableFallback(new TypeError("Failed to fetch"));
  assert.equal(ssr.getState().lanOfflineModalShown, true, "new disconnect after recovery may notify once");
});
