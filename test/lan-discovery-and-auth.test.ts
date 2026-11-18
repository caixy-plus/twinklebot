import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createRunner } from "../src/agent/runner.js";
import { createServer } from "../src/server/index.js";
import { isLoopbackAddress, createDeviceAuthManager } from "../src/lib/device-auth.js";
import { startLanDiscoveryResponder } from "../src/lib/lan-discovery.js";

test("isLoopbackAddress recognizes IPv4/IPv6 loopback and rejects LAN IPs", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.42"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.42"), false);
  assert.equal(isLoopbackAddress(""), false);
});

test("LAN pairing enforces 6-digit verification, rate limits, non-loopback Bearer auth, and revocation", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-lan-auth-"));
  const store = createStore(tmpDir);
  const events: any[] = [];
  const runner = createRunner({
    store,
    model: { async nextTurn() { return { text: "ok", calls: [] }; } },
    executor: { async health() { return { ok: true }; }, async call() { return {}; } },
  });
  const unsub = runner.subscribe((ev) => events.push(ev));
  t.after(() => unsub());

  const authMgr = createDeviceAuthManager(store);
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
  const verified = authMgr.verifyPairing({
    pairingId: req2.pairingId,
    code: req2.code,
    deviceName: "iPhone",
    platform: "ios",
  });
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
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
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

  // Verify via HTTP & check /api/lan/devices
  const verifyHttp = await fetch(`${base}/api/lan/pair/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingId: pairHttp.pairingId, code: pairEvt.code, deviceName: "Phone", platform: "android" }),
  }).then((r) => r.json());
  assert.equal(verifyHttp.ok, true);
  assert.ok(verifyHttp.deviceToken);

  const devList = await fetch(`${base}/api/lan/devices`).then((r) => r.json());
  assert.equal(devList.devices.length, 1);
  assert.equal(devList.devices[0].name, "Phone");
  assert.equal(devList.devices[0].tokenHash, undefined, "device list must never expose tokenHash");
});

test("UDP LAN discovery responder answers TWINKLEBOT_DISCOVER_V1 probes", async (t) => {
  const responder = await startLanDiscoveryResponder({
    port: 0,
    bindAddress: "127.0.0.1",
    getInfo: (): any => ({
      instanceId: "inst-1",
      hostname: "MacBook",
      platform: "darwin",
      port: 3230,
      appVersion: "0.1.0",
      lanAccessEnabled: true,
    }),
  });
  t.after(() => responder.close());
  const udpPort = (responder.address() as any).port;
  const client = dgram.createSocket("udp4");
  t.after(() => client.close());

  const reply = await new Promise<any>((resolve, reject) => {
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
