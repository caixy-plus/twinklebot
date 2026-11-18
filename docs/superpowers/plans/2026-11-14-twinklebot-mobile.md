# TwinkleBot Mobile Client & Android APK Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform TwinkleBot's frontend into a same-source Pure Client mobile app wrapped with Capacitor (Android & iOS), add LAN auto-discovery + 6-digit pairing + device-token security + multi-host cloud selection to the backend, implement the 2-level stack navigation + Bottom Sheet mobile UI, and configure GitHub Actions to build and publish Android APKs on push.

**Architecture:** All web UI stays in `public/` and shared browser-safe modules in `lib/`, runnable directly by `server.js` for desktop/web and compiled into `dist-web/` via `scripts/build-web.mjs` (`APP_TARGET=mobile` trims all backend/Electron/data files). Backend adds `lib/lan-discovery.js` (UDP responder + `/api/discovery/info`) and `lib/device-auth.js` (6-digit pairing + non-loopback Bearer token enforcement) plus multi-host selection on `lib/host-bridge.js`. Capacitor wraps `dist-web/` with custom native `LanDiscovery` plugins (Android Java + iOS Swift) and a `.github/workflows/android-apk.yml` CI pipeline producing signed/debug APKs.

**Tech Stack:** Node.js 22.13+ (ESM, `node:test`, `node:dgram`), `@google/genai` (only runtime dep), Vanilla HTML/CSS/JS, Capacitor 8 (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios`, `@capacitor/app`, `@capacitor/preferences` in `devDependencies`), Android Gradle (Java 21, SDK 35/36), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-14-twinklebot-mobile-design.md` (aligned with `/Users/YOUR_USERNAME/Downloads/Gmini Bot 移动端（Mobile Client）技术架构与开发规范 (SPEC).md` and 5 reference layout screenshots)

## Global Constraints

- Node.js >= 22.13, ESM, plain JavaScript; `@google/genai` MUST remain the only entry in `package.json` `dependencies` (Capacitor packages go in `devDependencies`).
- Desktop and mobile MUST share 100% of the frontend source (`public/` + `lib/accounts-store.js` + `lib/skills-catalog.js`); `APP_TARGET=mobile` build physically strips `server.js`, `store.js`, `agent/`, `executor/`, `electron/`, and `data/`.
- Static test invariants in `test/frontend-v2-transport.test.js`, `test/frontend-v2-ui.test.js`, `test/skills-store-ui.test.js`, `test/account-and-diagnostics.test.js`, and `test/non-interrupt-and-thinking-summary.test.js` MUST remain 100% green: zero raw `fetch("/api/...")` or `EventSource("/api/events")`; forbidden strings (`"获取移动版 Grok Bot"`, `"切换账户"`, `"退出登录"`, `">Jokes<"`, `">Premium<"`, `"连接应用"`, `"经此电脑转发流量"`, `"interrupt: true"`) MUST NEVER appear in `public/`; `.mail-advanced-details` count remains 2; `data-skill-filter="custom"` MUST NOT be added.
- Loopback requests (`127.0.0.1` / `::1`) in `local` mode remain unauthenticated for backward compatibility, while ALL non-loopback LAN requests (except `/api/discovery/info`, `/api/system/health`, `/api/lan/pair/*`) MUST verify `Authorization: Bearer <DeviceToken>` (or `?token=`).
- Mobile Edit Bot MUST hide the Phase 2 `语音通话` (`voice/speed/lang`) section; Skills Store uses real TwinkleBot skills (no `1Password`/`Android` placeholders); Settings uses `用量与账单` (no `管理订阅`) and `技能商店` (never `连接应用`).

## Review Focus

1. **X-Forwarded-For / IP Spoofing Bypass on LAN Auth**: Non-loopback clients spoofing `X-Forwarded-For: 127.0.0.1` must NEVER bypass `DeviceToken` enforcement; trust only `req.socket.remoteAddress` (pinned in Task 1).
2. **Stale Pairing / Brute-Force Code Guessing**: 6-digit pairing codes must expire after 5 minutes, lock out after 5 failed guesses, and NEVER echo the code in `/api/lan/pair/request` HTTP responses (pinned in Task 1).
3. **Host Bridge Multi-Host Disconnect & Null Selection**: Selecting a disconnected `host_executor` clientId or having 0 online hosts in cloud mode must cleanly report offline without hanging RPCs or crashing UI (pinned in Task 2).
4. **Capacitor `dist-web/` Trimming Leakage & Unprefixed Transport**: Running `APP_TARGET=mobile` build must assert zero backend files (`server.js`, `agent/`, `executor/`, `.env*`) exist in `dist-web/`, and mobile discovery/pairing calls must never hang on unreachable LAN IPs (3s abort timeout, pinned in Task 3 & Task 5).
5. **Desktop Existing Tests & Mobile Safe-Area / Forbidden String Regressions**: Adding mobile UI markup/styles must preserve all 263 baseline `npm test` assertions and keep `public/` clean of placeholder strings (pinned in Task 6 & Task 7).

---

### Task 1: Backend LAN Discovery, 6-Digit Pairing & Device Token Auth

**Files:**
- Create: `lib/device-auth.js`
- Create: `lib/lan-discovery.js`
- Modify: `lib/config.js`
- Modify: `electron/env-loader.js`
- Modify: `server.js`
- Test: `test/lan-discovery-and-auth.test.js`

**Interfaces:**
- Produces (`lib/device-auth.js`):
  - `isLoopbackAddress(remoteAddr: string) -> boolean`
  - `createDeviceAuthManager(store, { nowFn? }) -> { isAuthorized(req, url), listDevices(), revokeDevice(deviceId), createPairingRequest({ deviceName, platform, deviceId, remoteAddress }), verifyPairing({ pairingId, code, deviceName, platform }), cleanupExpired() }`
- Produces (`lib/lan-discovery.js`):
  - `DISCOVERY_UDP_PORT = 41234`
  - `buildDiscoveryInfo({ instanceId, hostname, platform, port, appVersion, lanAccessEnabled }) -> DiscoveryInfo`
  - `startLanDiscoveryResponder({ port, getInfo, bindAddress? }) -> { close(), address() }`
- Consumes (`server.js`): `createDeviceAuthManager`, `buildDiscoveryInfo`, `startLanDiscoveryResponder`
- Produces HTTP APIs in `server.js`:
  - `GET /api/discovery/info` (public)
  - `GET /api/lan/settings`, `POST /api/lan/settings` (loopback or authorized)
  - `POST /api/lan/pair/request` (public on LAN; broadcasts `lan_pairing_requested` to local UI with 6-digit code; NEVER returns code in HTTP response)
  - `POST /api/lan/pair/verify` (public on LAN; verifies 6-digit code, issues 256-bit `deviceToken`, stores SHA-256 hash in `data/devices.json` mode `0600`)
  - `GET /api/lan/devices`, `DELETE /api/lan/devices/:id` (loopback or authorized)

- [ ] **Step 1: Write the failing tests in `test/lan-discovery-and-auth.test.js`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../store.js";
import { createRunner } from "../agent/runner.js";
import { createServer } from "../server.js";
import { isLoopbackAddress, createDeviceAuthManager } from "../lib/device-auth.js";
import { startLanDiscoveryResponder } from "../lib/lan-discovery.js";

test("isLoopbackAddress recognizes IPv4/IPv6 loopback and rejects LAN IPs", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.42"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.42"), false);
});

test("LAN pairing enforces 6-digit verification, rate limits, non-loopback Bearer auth, and revocation", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-lan-auth-"));
  const store = createStore(tmpDir);
  const events = [];
  const runner = createRunner({
    store,
    model: { async nextTurn() { return { text: "ok", calls: [] }; } },
    executor: { async health() { return { ok: true }; }, async call() { return {}; } },
  });
  const unsub = runner.subscribe((ev) => events.push(ev));
  t.after(() => unsub());

  const authMgr = createDeviceAuthManager(store);
  // Test direct manager + server remoteAddress enforcement
  const reqRes = authMgr.createPairingRequest({
    deviceName: "Pixel 9",
    platform: "android",
    deviceId: "dev-1",
  });
  assert.ok(reqRes.pairingId);
  assert.match(reqRes.code, /^\d{6}$/);

  // 5 failed guesses lock out pairingId
  for (let i = 0; i < 5; i++) {
    const wrong = reqRes.code === "000000" ? "111111" : "000000";
    assert.throws(() => authMgr.verifyPairing({ pairingId: reqRes.pairingId, code: wrong }));
  }
  assert.throws(() => authMgr.verifyPairing({ pairingId: reqRes.pairingId, code: reqRes.code }));

  // Fresh pairing succeeds and issues token
  const req2 = authMgr.createPairingRequest({ deviceName: "iPhone", platform: "ios", deviceId: "dev-2" });
  const verified = authMgr.verifyPairing({ pairingId: req2.pairingId, code: req2.code, deviceName: "iPhone", platform: "ios" });
  assert.ok(verified.deviceToken.length >= 32);

  // Spoofed X-Forwarded-For from LAN remoteAddress must still require Bearer token
  assert.equal(
    authMgr.isAuthorized(
      { headers: { "x-forwarded-for": "127.0.0.1" }, socket: { remoteAddress: "192.168.1.88" } },
      new URL("http://192.168.1.10:3230/api/sessions")
    ),
    false
  );
  assert.equal(
    authMgr.isAuthorized(
      {
        headers: { "x-forwarded-for": "127.0.0.1", authorization: `Bearer ${verified.deviceToken}` },
        socket: { remoteAddress: "192.168.1.88" },
      },
      new URL("http://192.168.1.10:3230/api/sessions")
    ),
    true
  );

  // Revoke invalidates immediately
  assert.equal(authMgr.revokeDevice(verified.device.id), true);
  assert.equal(
    authMgr.isAuthorized(
      { headers: { authorization: `Bearer ${verified.deviceToken}` }, socket: { remoteAddress: "192.168.1.88" } },
      new URL("http://192.168.1.10:3230/api/sessions")
    ),
    false
  );

  // Server discovery & pairing endpoints never leak code in HTTP response
  const srv = createServer({
    config: { port: 0, host: "127.0.0.1", dataDir: tmpDir, writeRoots: [tmpDir], lanAccess: true },
    store,
    runner,
    executor: { async health() { return { ok: true }; }, async call() { return {}; } },
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const disc = await fetch(`${base}/api/discovery/info`).then((r) => r.json());
  assert.equal(disc.ok, true);
  assert.equal(disc.lanAccessEnabled, true);
  assert.ok(disc.instanceId && disc.hostname);

  const pairHttp = await fetch(`${base}/api/lan/pair/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName: "Phone", platform: "android" }),
  }).then((r) => r.json());
  assert.equal(pairHttp.ok, true);
  assert.equal(pairHttp.code, undefined, "HTTP response must never leak 6-digit code");
  const pairEvt = events.find((e) => e.type === "lan_pairing_requested" && e.pairingId === pairHttp.pairingId);
  assert.ok(pairEvt && /^\d{6}$/.test(pairEvt.code));
});

test("UDP LAN discovery responder answers TWINKLEBOT_DISCOVER_V1 probes", async (t) => {
  const responder = await startLanDiscoveryResponder({
    port: 0,
    bindAddress: "127.0.0.1",
    getInfo: () => ({ instanceId: "inst-1", hostname: "MacBook", platform: "darwin", port: 3230, appVersion: "0.1.0", lanAccessEnabled: true }),
  });
  t.after(() => responder.close());
  const udpPort = responder.address().port;
  const client = dgram.createSocket("udp4");
  t.after(() => client.close());

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("UDP probe timeout")), 1500);
    client.on("message", (msg) => {
      clearTimeout(timer);
      resolve(JSON.parse(msg.toString("utf8")));
    });
    client.send(Buffer.from("TWINKLEBOT_DISCOVER_V1"), udpPort, "127.0.0.1");
  });
  assert.equal(reply.type, "TWINKLEBOT_OFFER_V1");
  assert.equal(reply.instanceId, "inst-1");
  assert.equal(reply.port, 3230);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lan-discovery-and-auth.test.js`
Expected: FAIL (`Cannot find module '../lib/device-auth.js'`)

- [ ] **Step 3: Implement `lib/device-auth.js` and `lib/lan-discovery.js`, wire into `lib/config.js`, `electron/env-loader.js`, and `server.js`**

1. `lib/device-auth.js`:
   - Implement `isLoopbackAddress(addr)` handling `"127.0.0.1"`, `"::1"`, `"::ffff:127.0.0.1"`, `"localhost"` (only from `req.socket.remoteAddress`).
   - Implement `createDeviceAuthManager(store, { nowFn = Date.now } = {})`:
     - Persist paired devices in `<store.dataDir>/devices.json` (`0o600` on POSIX) with `{ id, name, platform, deviceId, tokenHash (sha256 hex), tokenPrefix, createdAt, lastSeenAt }`.
     - `createPairingRequest`: generates `pairingId` (`crypto.randomUUID()`), 6-digit zero-padded `crypto.randomInt(0, 1_000_000)`, `expiresAt = now + 5 * 60_000`, `attempts = 0`.
     - `verifyPairing`: rejects expired/missing/`attempts >= 5` with clear error; uses `crypto.timingSafeEqual` on UTF-8 buffers of same length; increments `attempts` on mismatch; on match generates 32-byte hex `deviceToken`, stores SHA-256 hash, returns `{ device, deviceToken }`.
     - `isAuthorized(req, url)`: checks `isLoopbackAddress(req.socket?.remoteAddress)`; if non-loopback, extracts `Authorization: Bearer <tok>` or `url.searchParams.get("token")` and verifies SHA-256 hash against `devices.json` using `timingSafeEqual`, updating `lastSeenAt`.
2. `lib/lan-discovery.js`:
   - `DISCOVERY_UDP_PORT = 41234`.
   - `buildDiscoveryInfo(...)` returns `{ ok: true, instanceId, hostname, platform, port, appVersion, lanAccessEnabled, pairingRequired: true }`.
   - `startLanDiscoveryResponder({ port = DISCOVERY_UDP_PORT, bindAddress = "0.0.0.0", getInfo })` binds UDP4 socket (`reuseAddr: true`), responds to `"TWINKLEBOT_DISCOVER_V1"` with JSON `TWINKLEBOT_OFFER_V1` when `getInfo().lanAccessEnabled !== false`.
3. `lib/config.js` & `electron/env-loader.js`:
   - Support `lanAccess` (`TWINKLEBOT_LAN_ACCESS === "1"` or persisted in `settings.lanAccess`); when `lanAccess` is enabled in `local` mode, bind `host = env.HOST || "0.0.0.0"` (and `electron/main.js` keeps `backendUrl = http://127.0.0.1:<port>` for the local Electron BrowserWindow!).
4. `server.js`:
   - Wire `deviceAuth = createDeviceAuthManager(store)` and instance ID (persisted or generated UUID in `data/instance-id` or `settings.instanceId`).
   - In `local` mode, enforce `deviceAuth.isAuthorized(req, url)` on all non-loopback requests to `/api/*`, `/ws`, and `/novnc/websockify` (except `GET /api/discovery/info`, `GET /api/system/health`, `POST /api/lan/pair/request`, `POST /api/lan/pair/verify`).
   - Add `/api/discovery/info`, `/api/lan/settings`, `/api/lan/pair/request`, `/api/lan/pair/verify`, `/api/lan/devices`, `/api/lan/devices/:id`.
   - Also expose paired devices / LAN toggle in `GET /api/settings` (`lanAccess`, `pairedDevices`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lan-discovery-and-auth.test.js && npm test`
Expected: PASS (new tests + all 263 existing tests pass)

- [ ] **Step 5: Commit**

```bash
git add lib/device-auth.js lib/lan-discovery.js lib/config.js electron/env-loader.js electron/main.js server.js test/lan-discovery-and-auth.test.js
git commit -m "feat(lan): add LAN discovery responder, 6-digit pairing, and non-loopback device token auth"
```

---

### Task 2: Cloud Mode Multi-Host Online Registry & Host Selection API

**Files:**
- Modify: `lib/host-bridge.js`
- Modify: `server.js`
- Test: `test/host-bridge-multi.test.js`

**Interfaces:**
- Produces (`lib/host-bridge.js`):
  - `registerHostMeta(clientId, meta: { hostId?, hostname?, platform?, arch? })`
  - `listConnectedHosts() -> Array<{ clientId, hostId, hostname, platform, arch, connectedAt }>`
  - `getSelectedHostId() -> string | null`
  - `setSelectedHostId(clientId: string | null) -> string | null`
- Produces HTTP APIs in `server.js`:
  - `GET /api/computer/hosts` -> `{ ok: true, deployEnv, hosts, selectedHostId }`
  - `POST /api/computer/hosts/select` `{ clientId }` -> `{ ok: true, selectedHostId, hosts }` (returns `404` if `clientId` not currently connected)
  - Extends `GET /api/computer/host-info` and `GET /api/computer/status` with `connectedHosts` and `selectedHostId` when in `cloud` mode.

- [ ] **Step 1: Write the failing test in `test/host-bridge-multi.test.js`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../store.js";
import { createRunner } from "../agent/runner.js";
import { createServer } from "../server.js";

test("cloud mode lists multiple online host_executor clients, allows selection, and reports offline when none connected", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-multihost-"));
  const store = createStore(tmpDir);
  const runner = createRunner({ store, model: { async nextTurn() { return { text: "ok", calls: [] }; } }, executor: { async health() { return { ok: true }; } } });
  const srv = createServer({
    config: { port: 0, deployEnv: "cloud", cloudAuthToken: "tok-mh", dataDir: tmpDir, writeRoots: [tmpDir] },
    store,
    runner,
    executor: { async health() { return { ok: true }; } },
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const wsUrl = `ws://127.0.0.1:${srv.address().port}/ws?token=tok-mh`;
  const authHdr = { Authorization: "Bearer tok-mh" };

  // 0 hosts connected
  const emptyRes = await fetch(`${base}/api/computer/hosts`, { headers: authHdr }).then((r) => r.json());
  assert.equal(emptyRes.hosts.length, 0);
  assert.equal(emptyRes.selectedHostId, null);

  // Connect two host_executor WebSockets
  const ws1 = new WebSocket(wsUrl);
  const ws2 = new WebSocket(wsUrl);
  t.after(() => { ws1.close(); ws2.close(); });
  await Promise.all([
    new Promise((r) => ws1.addEventListener("open", r, { once: true })),
    new Promise((r) => ws2.addEventListener("open", r, { once: true })),
  ]);
  ws1.send(JSON.stringify({ type: "host_hello", hostId: "mac-home", hostname: "Home-MacBook", platform: "darwin" }));
  ws2.send(JSON.stringify({ type: "host_hello", hostId: "mac-work", hostname: "Work-Studio", platform: "darwin" }));
  await new Promise((r) => setTimeout(r, 40));

  const listRes = await fetch(`${base}/api/computer/hosts`, { headers: authHdr }).then((r) => r.json());
  assert.equal(listRes.hosts.length, 2);
  const home = listRes.hosts.find((h) => h.hostname === "Home-MacBook");
  assert.ok(home);

  // Select Home-MacBook explicitly
  const selRes = await fetch(`${base}/api/computer/hosts/select`, {
    method: "POST",
    headers: { ...authHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: home.clientId }),
  }).then((r) => r.json());
  assert.equal(selRes.selectedHostId, home.clientId);

  // Verify hostBridge routes RPC to selected client
  const rpcSeen = [];
  ws1.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "host_rpc_request") {
      rpcSeen.push("ws1");
      ws1.send(JSON.stringify({ type: "host_rpc_response", rpcId: msg.rpcId, ok: true, result: { ok: true } }));
    }
  });
  ws2.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "host_rpc_request") {
      rpcSeen.push("ws2");
      ws2.send(JSON.stringify({ type: "host_rpc_response", rpcId: msg.rpcId, ok: true, result: { ok: true } }));
    }
  });
  await srv.hostBridge.execute({ name: "host_open", args: { path: "/tmp" } });
  assert.deepEqual(rpcSeen, ["ws1"]);

  // Selecting nonexistent host fails 404
  const badSel = await fetch(`${base}/api/computer/hosts/select`, {
    method: "POST",
    headers: { ...authHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "missing-id" }),
  });
  assert.equal(badSel.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/host-bridge-multi.test.js`
Expected: FAIL (`404` on `/api/computer/hosts`)

- [ ] **Step 3: Implement multi-host tracking & selection in `lib/host-bridge.js` and `server.js`**

- In `lib/host-bridge.js`: store `hostMetaByClientId = new Map()`, `selectedHostId = null`; `registerHostMeta(clientId, meta)`, `listConnectedHosts()` (filtered to currently connected WS client IDs that sent `host_hello`), `getSelectedHostId()`, `setSelectedHostId(clientId)`, update `getTargetClientId()` to prefer `selectedHostId` if connected, else last `host_hello` client, else last WS client; clean up `hostMetaByClientId` & `selectedHostId` in `rejectAllForClient(clientId)`.
- In `server.js`: handle `msg.type === "host_hello"` in `/ws` `onMessage` (calling `hostBridge.registerHostMeta(client.id, msg)` and broadcasting `computer_status_updated`), add `GET /api/computer/hosts` and `POST /api/computer/hosts/select`, and include `connectedHosts` & `selectedHostId` in `/api/computer/status` and `/api/computer/host-info`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/host-bridge-multi.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/host-bridge.js server.js test/host-bridge-multi.test.js
git commit -m "feat(cloud): support multi-host selection and online status for host_executor"
```

---

### Task 3: Same-Source Build Trimming (`scripts/build-web.mjs`) & Capacitor Native Shell Config

**Files:**
- Create: `scripts/build-web.mjs`
- Create: `capacitor.config.json`
- Create: `public/mobile-bridge.js`
- Modify: `package.json` (add `@capacitor/*` to `devDependencies`, add `mobile:build:web`, `mobile:sync`, `mobile:apk:debug`, `mobile:apk:release` scripts; keep `dependencies` strictly `@google/genai` only)
- Modify: `.gitignore` (ignore `dist-web/`)
- Test: `test/mobile-build.test.js`

**Interfaces:**
- Produces (`scripts/build-web.mjs`):
  - `buildWebBundle({ target: "mobile" | "desktop", outDir?: string }) -> { outDir, target, files: string[] }`
  - CLI: `APP_TARGET=mobile node scripts/build-web.mjs` copies `public/**/*` + `lib/accounts-store.js` + `lib/skills-catalog.js` into `dist-web/`, injects `<script>window.__TWINKLEBOT_APP_TARGET__="mobile";</script>` into `dist-web/index.html`, and ensures NO backend files (`server.js`, `store.js`, `agent/`, `executor/`, `electron/`, `data/`, `.env*`) are present in `dist-web/`.
- Produces (`public/mobile-bridge.js`):
  - `isMobileAppTarget() -> boolean`
  - `isNativeMobileContainer() -> boolean`
  - `storageGet(key) -> Promise<string | null>` / `storageSet(key, val) -> Promise<void>` (uses `@capacitor/preferences` when native, `localStorage` fallback)
  - `getLanNetworkInfo() -> Promise<{ ip: string, subnetPrefix: string, isWifi: boolean } | null>`
  - `discoverLanDevices({ timeoutMs?: number }) -> Promise<Array<{ instanceId, hostname, platform, port, host, appVersion }>>`
  - `scanSubnetForDevices({ subnetPrefix, port?, timeoutMs?, batchSize? }) -> Promise<Array<...>>` (batches of 25 concurrent requests, 800ms per-request abort timeout)
  - `onAppForeground(cb) -> () => void` (wires Capacitor `App.addListener("appStateChange")` + `document.visibilitychange`)

- [ ] **Step 1: Install Capacitor devDependencies and write `test/mobile-build.test.js`**

Run: `npm install -D @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios @capacitor/app @capacitor/preferences`

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWebBundle } from "../scripts/build-web.mjs";

test("package.json keeps @google/genai as sole runtime dependency", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["@google/genai"]);
  assert.ok(pkg.scripts["mobile:build:web"]);
});

test("buildWebBundle(target=mobile) copies pure frontend assets and physically strips backend/data", async () => {
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "gb-dist-web-"));
  try {
    const res = await buildWebBundle({ target: "mobile", outDir: tmpOut });
    assert.equal(res.target, "mobile");
    assert.ok(fs.existsSync(path.join(tmpOut, "index.html")));
    assert.ok(fs.existsSync(path.join(tmpOut, "app.js")));
    assert.ok(fs.existsSync(path.join(tmpOut, "mobile-bridge.js")));
    assert.ok(fs.existsSync(path.join(tmpOut, "accounts-store.js")));
    assert.ok(fs.existsSync(path.join(tmpOut, "skills-catalog.js")));

    const html = fs.readFileSync(path.join(tmpOut, "index.html"), "utf8");
    assert.ok(html.includes('window.__TWINKLEBOT_APP_TARGET__ = "mobile"'));

    // Physical exclusion checks
    for (const forbidden of ["server.js", "store.js", "agent", "executor", "electron", "data", ".env"]) {
      assert.equal(fs.existsSync(path.join(tmpOut, forbidden)), false, `${forbidden} must not exist in mobile bundle`);
    }
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mobile-build.test.js`
Expected: FAIL (`Cannot find module '../scripts/build-web.mjs'`)

- [ ] **Step 3: Implement `scripts/build-web.mjs`, `capacitor.config.json`, `public/mobile-bridge.js`, and update `package.json` & `.gitignore`**

- `capacitor.config.json`:
  ```json
  {
    "appId": "com.twinklebot.mobile",
    "appName": "TwinkleBot",
    "webDir": "dist-web",
    "server": {
      "androidScheme": "http",
      "cleartext": true
    },
    "plugins": {
      "CapacitorHttp": {
        "enabled": false
      }
    }
  }
  ```
- `scripts/build-web.mjs`: recursively copies `public/` -> `outDir`, copies `lib/accounts-store.js` and `lib/skills-catalog.js` into `outDir`, rewrites `<head>` of `outDir/index.html` to inject `<script>window.__TWINKLEBOT_APP_TARGET__ = "${target}";</script>` (preserving `public/index.html` untouched), removes any `.DS_Store`.
- `public/mobile-bridge.js`: implements `isMobileAppTarget()`, `isNativeMobileContainer()`, `storageGet`/`storageSet` (`window.Capacitor?.Plugins?.Preferences` + `localStorage`), `getLanNetworkInfo()`, `discoverLanDevices()`, `scanSubnetForDevices()` (batches of 25, 800ms AbortSignal timeout per `/api/discovery/info`), and `onAppForeground()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mobile-build.test.js && APP_TARGET=mobile npm run mobile:build:web`
Expected: PASS, and `dist-web/` created cleanly

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json capacitor.config.json scripts/build-web.mjs public/mobile-bridge.js .gitignore test/mobile-build.test.js
git commit -m "feat(mobile): add APP_TARGET build trimmer, Capacitor config, and mobile bridge"
```

---

### Task 4: Capacitor Android & iOS Native Projects, LAN Discovery Native Plugins & Permissions

**Files:**
- Create: `android/` (via `npx cap add android`, then customized)
- Create: `ios/` (via `npx cap add ios`, then customized)
- Create: `android/app/src/main/java/com/twinklebot/mobile/LanDiscoveryPlugin.java`
- Modify: `android/app/src/main/java/com/twinklebot/mobile/MainActivity.java` (register `LanDiscoveryPlugin`)
- Modify: `android/app/src/main/AndroidManifest.xml` (permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`; `usesCleartextTraffic="true"`; `networkSecurityConfig`; `windowSoftInputMode="adjustResize"`)
- Create: `android/app/src/main/res/xml/network_security_config.xml`
- Create: `ios/App/App/LanDiscoveryPlugin.swift`
- Modify: `ios/App/App/Info.plist` (`NSLocalNetworkUsageDescription`, `NSBonjourServices` `_twinklebot._tcp`, `NSAppTransportSecurity.NSAllowsLocalNetworking = true`)
- Test: `test/mobile-native-config.test.js` + local `./gradlew assembleDebug` verification

**Interfaces:**
- Produces Native Capacitor Plugin `"LanDiscovery"`:
  - `getNetworkInfo() -> { ip: string, subnetPrefix: string, isWifi: boolean }`
  - `discover({ timeoutMs?: number }) -> { devices: Array<{ instanceId, hostname, platform, port, host, appVersion }> }`

- [ ] **Step 1: Initialize Capacitor Android & iOS projects and write `test/mobile-native-config.test.js`**

Run: `npx cap add android && npx cap add ios`

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

test("Android manifest and network security config allow LAN cleartext & multicast discovery", () => {
  const manifest = fs.readFileSync(path.join(ROOT, "android/app/src/main/AndroidManifest.xml"), "utf8");
  for (const perm of [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.ACCESS_WIFI_STATE",
    "android.permission.CHANGE_WIFI_MULTICAST_STATE",
  ]) {
    assert.ok(manifest.includes(perm), `missing ${perm}`);
  }
  assert.ok(manifest.includes('android:usesCleartextTraffic="true"'));
  assert.ok(manifest.includes("network_security_config"));

  const netSec = fs.readFileSync(path.join(ROOT, "android/app/src/main/res/xml/network_security_config.xml"), "utf8");
  assert.ok(netSec.includes('cleartextTrafficPermitted="true"'));

  const pluginJava = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/twinklebot/mobile/LanDiscoveryPlugin.java"), "utf8");
  assert.ok(pluginJava.includes('@CapacitorPlugin(name = "LanDiscovery")'));
  assert.ok(pluginJava.includes("TWINKLEBOT_DISCOVER_V1"));
});

test("iOS Info.plist configures Local Network, Bonjour, and ATS local networking", () => {
  const plist = fs.readFileSync(path.join(ROOT, "ios/App/App/Info.plist"), "utf8");
  assert.ok(plist.includes("NSLocalNetworkUsageDescription"));
  assert.ok(plist.includes("_twinklebot._tcp"));
  assert.ok(plist.includes("NSAllowsLocalNetworking"));

  const swift = fs.readFileSync(path.join(ROOT, "ios/App/App/LanDiscoveryPlugin.swift"), "utf8");
  assert.ok(swift.includes("LanDiscoveryPlugin"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mobile-native-config.test.js`
Expected: FAIL (missing `LanDiscoveryPlugin.java`, `network_security_config.xml`, etc.)

- [ ] **Step 3: Write `LanDiscoveryPlugin.java`, register in `MainActivity.java`, update `AndroidManifest.xml` & `network_security_config.xml`, write `LanDiscoveryPlugin.swift`, update `Info.plist`, and run `npx cap sync`**

- `LanDiscoveryPlugin.java`:
  - `getNetworkInfo`: enumerates `NetworkInterface.getNetworkInterfaces()` for non-loopback site-local `Inet4Address`, returns `{ ip, subnetPrefix, isWifi: true }`.
  - `discover`: acquires `WifiManager.MulticastLock`, opens `DatagramSocket` with `setBroadcast(true)`, sends `"TWINKLEBOT_DISCOVER_V1"` to `255.255.255.255:41234` and `<subnet>.255:41234`, collects JSON `TWINKLEBOT_OFFER_V1` packets within `timeoutMs` (default `1200ms`), deduplicates by `instanceId`, returns `{ devices }`.
- `LanDiscoveryPlugin.swift`:
  - `getNetworkInfo` via `getifaddrs` (`en0` IPv4), `discover` via `NWBrowser` (`_twinklebot._tcp`) + BSD UDP broadcast to `255.255.255.255:41234`.
- Update `AndroidManifest.xml` (`usesCleartextTraffic="true"`, `android:networkSecurityConfig="@xml/network_security_config"`, `android:windowSoftInputMode="adjustResize"`, 4 network/multicast permissions) and `ios/App/App/Info.plist`.

- [ ] **Step 4: Run tests & local Android Gradle build**

Run: `node --test test/mobile-native-config.test.js && npx cap sync android && (cd android && ./gradlew assembleDebug)`
Expected: `test/mobile-native-config.test.js` PASS and `android/app/build/outputs/apk/debug/app-debug.apk` built cleanly!

- [ ] **Step 5: Commit**

```bash
git add android ios test/mobile-native-config.test.js
git commit -m "feat(mobile): add Capacitor Android & iOS projects with LAN discovery plugins and permissions"
```

---

### Task 5: Frontend Multi-Node Transport, LAN Pairing, Cloud Multi-Host & Network Resilience

**Files:**
- Modify: `lib/accounts-store.js` (support `lan` account entries with `instanceId`, `deviceToken`, `hostname`, alongside `local` and `cloud` accounts — keeping existing `local` + `cloud` tests 100% compatible!)
- Modify: `public/app.js` (wire `mobile-bridge.js`, `APP_TARGET=mobile` startup without local `127.0.0.1` loopback assumption, LAN discovery + `/24` fallback + 6-digit pairing modal, 3s LAN fast-fail -> "切换至云端账号" modal, foreground WebSocket reconnect + incremental event sync, cloud multi-host selection & offline gray-out)
- Test: `test/mobile-transport-and-resilience.test.js`

**Interfaces:**
- Produces (`lib/accounts-store.js`):
  - `upsertLanAccount(state, { id?, instanceId, name, baseUrl, deviceToken, hostname?, platform? }) -> AccountsState`
  - Preserves `normalizeAccountsState`, `upsertCloudAccount`, `removeCloudAccount`, `setActiveAccount`, `LOCAL_ACCOUNT_ID`
- Produces (`public/app.js`):
  - `scanAndRenderLanNodes() -> Promise<void>`
  - `initiateLanPairing(deviceInfo) -> Promise<void>`
  - `triggerLanUnreachableFallback(err) -> void`
  - `refreshOnlineCloudHosts() -> Promise<void>`

- [ ] **Step 1: Write failing tests in `test/mobile-transport-and-resilience.test.js`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeAccountsState, upsertLanAccount, removeCloudAccount } from "../lib/accounts-store.js";

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

  const s2 = removeCloudAccount(s1, lan.id);
  assert.equal(s2.accounts.some((a) => a.id === lan.id), false);
});

test("public/app.js implements mobile LAN fast-fail, foreground WS reconnect, and host offline state", () => {
  const appJs = fs.readFileSync(path.resolve("public/app.js"), "utf8");
  assert.ok(appJs.includes('from "./mobile-bridge.js"'));
  assert.ok(appJs.includes("triggerLanUnreachableFallback"));
  assert.ok(appJs.includes("/api/lan/pair/request"));
  assert.ok(appJs.includes("/api/lan/pair/verify"));
  assert.ok(appJs.includes("/api/computer/hosts"));
  assert.ok(appJs.includes("宿主机离线/不可用"));
  assert.ok(appJs.includes("onAppForeground"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mobile-transport-and-resilience.test.js`
Expected: FAIL (`upsertLanAccount` not exported)

- [ ] **Step 3: Implement `upsertLanAccount` in `lib/accounts-store.js` and wire mobile transport/pairing/resilience in `public/app.js`**

- In `lib/accounts-store.js`: preserve `type: "lan"` entries inside `normalizeAccountsState` (with `instanceId`, `hostname`, `platform`, `authToken`, `wsUrl`), add `upsertLanAccount`, allow `removeCloudAccount` (or alias `removeRemoteAccount`) to remove both `cloud` and `lan` entries while still blocking `local`.
- In `public/app.js`:
  - All API requests MUST continue using `apiFetch`/`apiUrl` (never raw `fetch("/api/...")`!) and respect `accountEpoch`.
  - When active account is `lan` (or mobile client targeting LAN URL), pass a combined 3000ms `AbortSignal` to `apiFetch` on health/session probes and catch `TimeoutError`/network error -> show LAN unreachable dialog (`“当前无法连接至局域网电脑，请检查是否处于同一 Wi-Fi 或切换至云端账号”`) with one-tap **【切换至云端账号】** button.
  - On `isMobileAppTarget()` startup, omit desktop `local` auto-connection if no `local` backend exists; load saved `lan`/`cloud` accounts from `storageGet(ACCOUNTS_STORAGE_KEY)` (`@capacitor/preferences` + `localStorage`); if none paired yet, open Node Switcher sheet to scan LAN or add Cloud server.
  - Register `onAppForeground(() => ...)` to run `/api/system/health`, silently reconnect `/ws`, and refresh active session messages (`selectSession(state.activeSessionId)` or incremental merge) + `refreshOnlineCloudHosts()`.
  - When Desktop UI receives `lan_pairing_requested` over `/ws`, show Desktop 6-digit pairing code banner/toast + paired devices management in Settings -> `电脑`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mobile-transport-and-resilience.test.js test/accounts-store.test.js test/frontend-v2-transport.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/accounts-store.js public/app.js test/mobile-transport-and-resilience.test.js
git commit -m "feat(mobile): wire multi-node LAN pairing, 3s fast-fail fallback, foreground sync, and multi-host selection"
```

---

### Task 6: Mobile Two-Level Stack Navigation, Bottom Sheets & 5-Screen Design Alignment

**Files:**
- Create: `public/mobile.css`
- Create: `public/mobile-ui.js`
- Modify: `public/index.html` (link `mobile.css`, add `viewport-fit=cover` + mobile-specific controls/modals: mobile chat header back & inspector button, mobile Node Switcher Bottom Sheet, mobile LAN 6-digit Pairing Modal, mobile LAN Offline Fallback Dialog, mobile Create/Edit Bot Sheet, mobile Settings Sheet; strictly preserve ALL desktop IDs and forbidden-string invariants!)
- Modify: `public/app.js` (wire `mobile-ui.js` view stack `list <-> chat`, mobile inspector Bottom Sheet tabs, mobile create/edit Bot hiding Phase 2 voice section, mobile settings timezone + node switcher + vault + skills store)
- Test: `test/mobile-ui-contract.test.js`

**Interfaces:**
- Produces (`public/mobile-ui.js`):
  - `isMobileViewport() -> boolean`
  - `setMobileView(view: "list" | "chat") -> void`
  - `openMobileInspectorSheet(tab?: "computer" | "persona" | "schedules" | "library") -> void`
  - `closeMobileInspectorSheet() -> void`
  - `openMobileBotEditor(mode: "create" | "edit", session?: Session) -> void`
  - `openMobileSettingsSheet() -> void`
  - `openMobileNodeSwitcherSheet() -> void`
- Consumes (`public/app.js`): existing DOM state (`state.sessions`, `state.accountsState`, `state.computerStatus`, `state.settings`) and actions (`selectSession`, `switchAccount`, `handleBotComputerCardActivate`, `openAppsModal`).

- [ ] **Step 1: Write failing tests in `test/mobile-ui-contract.test.js`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

test("public/index.html & mobile.css provide 2-level stack navigation, Bottom Sheets, and preserve forbidden-string rules", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  const mobileCss = fs.readFileSync(path.join(ROOT, "public/mobile.css"), "utf8");

  assert.ok(html.includes("viewport-fit=cover"));
  assert.ok(html.includes('href="/mobile.css'));
  for (const id of [
    "mobile-back-btn",
    "mobile-inspector-btn",
    "mobile-search-input",
    "mobile-tools-btn",
    "mobile-settings-btn",
    "mobile-node-switcher-card",
    "mobile-node-sheet",
    "mobile-lan-scan-btn",
    "mobile-lan-list",
    "mobile-cloud-list",
    "mobile-pair-modal",
    "mobile-pair-code-input",
    "mobile-lan-offline-modal",
    "mobile-bot-editor-sheet",
    "mobile-bot-name-input",
    "mobile-bot-save-btn",
    "mobile-inspector-sheet",
    "mobile-settings-sheet",
    "mobile-auto-timezone-toggle",
    "mobile-timezone-value",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }

  // Safe area & mobile breakpoint styles
  assert.ok(mobileCss.includes("env(safe-area-inset-top)"));
  assert.ok(mobileCss.includes("env(safe-area-inset-bottom)"));
  assert.ok(mobileCss.includes("@media (max-width: 768px)"));

  // Must never introduce forbidden placeholders
  for (const bad of ["Grok Bot", "管理订阅", "1Password", "连接应用", "语音通话", "经此电脑转发流量"]) {
    assert.equal(html.includes(bad), false, `forbidden mobile placeholder found in index.html: ${bad}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mobile-ui-contract.test.js`
Expected: FAIL (`ENOENT` on `public/mobile.css`)

- [ ] **Step 3: Implement `public/mobile.css`, `public/mobile-ui.js`, and wire into `public/index.html` & `public/app.js`**

Align strictly with the 5 screenshots + SPEC §4.1:
1. **Home Bot List (`data-mobile-view="list"`, Screenshot #1)**:
   - Top bar: Left user/node avatar (`#mobile-settings-btn`) with online status badge, Right `+` button (`#mobile-new-bot-btn`).
   - Centered Pinned Primary Bot (`#pinned-primary-bot` large 96px mascot + orange `★` badge + label).
   - Scrollable Bot & Group rows (`#session-list`) with 13×11 mascot/cluster avatar, name, last message snippet, time, `📎 附件` badge.
   - Floating bottom bar (`padding-bottom: calc(12px + env(safe-area-inset-bottom))`): Left circular grid button (`#mobile-tools-btn` -> opens Skills Store), Right pill search (`#mobile-search-input`).
2. **Full-Screen Chat + Capability Bottom Sheet (`data-mobile-view="chat"`)**:
   - Top chat bar: Left `<` (`#mobile-back-btn`), Center Bot avatar + name + status, Right `⋯` (`#mobile-inspector-btn`).
   - Full-screen `#event-stream` + bottom `#composer-wrap` respecting `env(safe-area-inset-bottom)` and `window.visualViewport` keyboard height.
   - `#mobile-inspector-sheet` Bottom Sheet with 4 Tabs (`电脑画面` [live noVNC / screenshot + online host selector + `"宿主机离线/不可用"` disabled state when cloud has no online host], `职责与记忆`, `即将进行`, `资料库`).
3. **Settings & Node Switcher (`#mobile-settings-sheet` + `#mobile-node-sheet`, Screenshot #2)**:
   - Top `✕`, Node Switcher Card (`#mobile-node-switcher-card`), `用量与账单`, `保险库`, `技能商店`, `Bot` section (`权限`, `自动设置时区` toggle + `时区` `Intl.DateTimeFormat().resolvedOptions().timeZone`, `Bot 电脑`, `模型接入与路由`, `关于与诊断`).
   - `#mobile-node-sheet`: Group 1 `局域网电脑（自动发现）` (Refresh Scan button, discovered & paired list, 6-digit Pairing Modal `#mobile-pair-modal`); Group 2 `云端服务器（手动添加）` (+ Add Cloud button reusing `#cloud-account-modal`, edit/delete/switch).
4. **Create / Edit Bot Sheet (`#mobile-bot-editor-sheet`, Screenshots #3 & #4)**:
   - Create mode: `✕`, `创建新 Bot`, large mascot preview, `为 Bot 取个名字`, 13 shapes (5+5+3), 11 colors (6+5), optional `rolePrompt` field, bottom `创建` pill.
   - Edit mode: `<`, `编辑 Bot`, `完成`, mascot + edit icon, `名称`, `外观 -> 头像 >`, and **NO** `语音通话` section (hidden per Phase 2 rule).
5. **Skills Store Mobile Sheet (Screenshot #5)**:
   - CSS adaptation on `#apps-modal-backdrop` inside `@media (max-width: 768px)` + `body[data-mobile-ui="true"]`: full-screen dark layout, top `✕` + `技能商店` + `已添加`, filter pills (`全部` / `办公` / `平台技能`), real Platform (KimiCU) + Office (QQ Mail, Generic Mail) + Custom Skills link, sticky bottom search bar.

- [ ] **Step 4: Run ALL tests (including existing desktop UI tests + new mobile tests)**

Run: `npm test`
Expected: ALL tests PASS (zero regressions in `frontend-v2-ui`, `frontend-v2-transport`, `skills-store-ui`, `account-and-diagnostics`, `non-interrupt-and-thinking-summary`, and `mobile-ui-contract`)

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/mobile.css public/mobile-ui.js public/app.js test/mobile-ui-contract.test.js
git commit -m "feat(mobile-ui): implement 2-level stack navigation, bottom sheets, node switcher, and 5-screen layout"
```

---

### Task 7: GitHub Actions Android APK Workflow, Full Verification & Push Trigger

**Files:**
- Create: `.github/workflows/android-apk.yml`
- Modify: `package.json` (ensure `mobile:apk:debug` / `mobile:apk:release` scripts exist and match CI)
- Test: Full `npm test`, `APP_TARGET=mobile npm run mobile:build:web`, `npx cap sync android`, and local `(cd android && ./gradlew assembleDebug)`

**Interfaces:**
- Produces (`.github/workflows/android-apk.yml`):
  - Triggers on `push` to `main` and `feat/**`, tags `v*`, and `workflow_dispatch`.
  - Runs Node 22 (`npm ci`, `npm test`), `APP_TARGET=mobile npm run mobile:build:web`, `npx cap sync android`, Java 21 (`actions/setup-java@v4`, temurin), Android SDK (`android-actions/setup-android@v3`), builds `app-debug.apk` and unsigned/release `app-release-unsigned.apk` (or signed if keystore secrets present) via `./gradlew assembleDebug assembleRelease`, renames cleanly to `TwinkleBot-mobile-debug.apk` / `TwinkleBot-mobile-release.apk`, uploads artifact `TwinkleBot-Android-APK`, and attaches to GitHub Release on `main` / `v*` / `workflow_dispatch`.

- [ ] **Step 1: Write `.github/workflows/android-apk.yml` and finalize `package.json` APK scripts**

- [ ] **Step 2: Run full end-to-end verification locally**

Run:
1. `npm test` (expect 100% pass)
2. `APP_TARGET=mobile npm run mobile:build:web && npx cap sync android`
3. `(cd android && ./gradlew assembleDebug)` (expect `BUILD SUCCESSFUL` and valid APK at `android/app/build/outputs/apk/debug/app-debug.apk`)
4. `python3 -m unittest discover -s executor -v` (expect executor tests pass)

- [ ] **Step 3: Commit & Push to trigger GitHub Actions APK build**

```bash
git add .github/workflows/android-apk.yml package.json
git commit -m "ci(mobile): add GitHub Actions workflow to build and publish Android APK"
git push -u origin feat/v2-architecture
```

- [ ] **Step 4: Verify GitHub Actions workflow triggered via `gh run list` and report run URL & artifact details**
