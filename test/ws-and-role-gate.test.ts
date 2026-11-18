import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createRunner } from "../src/agent/runner.js";
import { createServer } from "../src/server/index.js";
import { attachWebSocketServer } from "../src/lib/ws-server.js";

function makeTempServer(t: any, extraConfig: any = {}, extraOpts: any = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-ws-role-"));
  const store = createStore(tmpDir);
  const runner = createRunner({
    store,
    model: { async nextTurn() { return { text: "ok", calls: [] }; } },
    executor: { async health() { return { ok: true }; }, async call() { return {}; } },
  });
  const srv = createServer({
    store,
    runner,
    executor: { async health() { return { ok: true }; }, async call() { return {}; } },
    config: {
      port: 0,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
      writeRoots: [tmpDir],
      ...extraConfig,
    },
    ...extraOpts,
  });
  return new Promise<any>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      t.after(async () => {
        srv.closeAllConnections?.();
        await new Promise<void>((r) => srv.close(() => r()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        store,
        runner,
        srv,
      });
    });
  });
}

test("host_executor locks master routes and allows role/diagnostics/host routes", async (t) => {
  const { baseUrl } = await makeTempServer(t, {
    deployEnv: "local",
    localControlToken: "loc-secret-123",
  });

  const initialRole = await fetch(`${baseUrl}/api/system/role`).then((r) => r.json());
  assert.equal(initialRole.deployEnv, "local");
  assert.equal(initialRole.role, "master");

  // Switching role without localControlToken is rejected when token is configured
  const unauthSwitch = await fetch(`${baseUrl}/api/system/role`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "host_executor" }),
  });
  assert.equal(unauthSwitch.status, 401);

  // Switch to host_executor with localControlToken
  const switchRes = await fetch(`${baseUrl}/api/system/role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Local-Token": "loc-secret-123",
    },
    body: JSON.stringify({
      role: "host_executor",
      cloudOrigin: "https://cloud.example.com",
    }),
  });
  assert.equal(switchRes.status, 200);
  const switchJson = await switchRes.json();
  assert.equal(switchJson.role, "host_executor");
  assert.equal(switchJson.cloudOrigin, "https://cloud.example.com");

  // Master routes return 409 Conflict
  const lockedSessions = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(lockedSessions.status, 409);
  const lockedSettings = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "dark" }),
  });
  assert.equal(lockedSettings.status, 409);

  // Role & diagnostics remain accessible
  const roleAfter = await fetch(`${baseUrl}/api/system/role`).then((r) => r.json());
  assert.equal(roleAfter.role, "host_executor");
  const diag = await fetch(`${baseUrl}/api/system/diagnostics`);
  assert.equal(diag.status, 200);

  // Switch back to master restores access
  const backRes = await fetch(`${baseUrl}/api/system/role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Local-Token": "loc-secret-123",
    },
    body: JSON.stringify({ role: "master" }),
  });
  assert.equal(backRes.status, 200);
  const unlockedSessions = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(unlockedSessions.status, 200);
});

test("cloud deployEnv enforces Bearer auth, CORS, locks host_executor switch, and bridges /ws", async (t) => {
  const { baseUrl, wsUrl, runner } = await makeTempServer(t, {
    deployEnv: "cloud",
    cloudAuthToken: "cloud-tok-999",
  });

  // Public health endpoint works without auth
  const healthRes = await fetch(`${baseUrl}/api/system/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.deployEnv, "cloud");

  // Protected API rejects missing/wrong token
  const noAuth = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(noAuth.status, 401);

  // Valid Bearer token succeeds + returns CORS header
  const withAuth = await fetch(`${baseUrl}/api/sessions`, {
    headers: {
      Authorization: "Bearer cloud-tok-999",
      Origin: "http://127.0.0.1:3230",
    },
  });
  assert.equal(withAuth.status, 200);
  assert.equal(withAuth.headers.get("access-control-allow-origin"), "http://127.0.0.1:3230");

  // Cannot switch cloud server into host_executor
  const badRole = await fetch(`${baseUrl}/api/system/role`, {
    method: "POST",
    headers: {
      Authorization: "Bearer cloud-tok-999",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "host_executor" }),
  });
  assert.equal(badRole.status, 400);

  // WebSocket rejects missing token, accepts valid token, and receives broadcasts
  const ws = new WebSocket(`${wsUrl}?token=cloud-tok-999`);
  t.after(() => ws.close());

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const received: any[] = [];
  ws.addEventListener("message", (ev) => {
    received.push(JSON.parse(String(ev.data)));
  });

  runner.broadcastGlobal({ type: "ws_ping_test", value: 42 });

  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (received.some((m) => m.type === "ws_ping_test" && m.value === 42)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 2000) {
        clearInterval(timer);
        reject(new Error("timed out waiting for ws broadcast"));
      }
    }, 20);
  });
});

test("cloud /novnc proxy serves noVNC static files and enforces cloudAuthToken on /novnc/websockify", async (t) => {
  // Mock local websockify/noVNC upstream on 127.0.0.1:0
  const upstream = http.createServer((req, res) => {
    if (req.url?.startsWith("/vnc.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>noVNC Mock</body></html>");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const upWs = attachWebSocketServer(upstream, {
    path: "/websockify",
    onConnection(client) {
      client.send({ type: "rfb_ready" });
    },
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(async () => {
    upWs.close();
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  const upPort = (upstream.address() as any).port;

  const { baseUrl } = await makeTempServer(t, {
    deployEnv: "cloud",
    cloudAuthToken: "vnc-sec-888",
    novncUrl: "/novnc/vnc.html?autoconnect=1&resize=scale",
    novncProxyTarget: `http://127.0.0.1:${upPort}`,
  });

  // Static noVNC HTML loads cleanly through /novnc/ and hides the built-in noVNC control bar
  const htmlRes = await fetch(`${baseUrl}/novnc/vnc.html?autoconnect=1`);
  assert.equal(htmlRes.status, 200);
  const htmlBody = await htmlRes.text();
  assert.match(htmlBody, /noVNC Mock/);
  assert.match(htmlBody, /#noVNC_control_bar_anchor/);

  // Unauthenticated /novnc/websockify must be rejected
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const badWs = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/novnc/websockify`);
        badWs.addEventListener("open", () => {
          badWs.close();
          resolve("unexpected open");
        });
        badWs.addEventListener("error", () => reject(new Error("rejected")));
      })
  );

  // Authenticated /novnc/websockify?token=vnc-sec-888 proxies frames
  const goodWs = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/novnc/websockify?token=vnc-sec-888`
  );
  t.after(() => goodWs.close());
  const msg = await new Promise((resolve, reject) => {
    goodWs.addEventListener("message", (ev) => resolve(JSON.parse(String(ev.data))), {
      once: true,
    });
    goodWs.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
  });
  assert.deepEqual(msg, { type: "rfb_ready" });
});

test("local mode derives /novnc proxy target from novncUrl and strips built-in noVNC control bar", async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url?.startsWith("/vnc.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head></head><body><div id='noVNC_control_bar'></div></body></html>");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(async () => {
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  const upPort = (upstream.address() as any).port;

  const { baseUrl } = await makeTempServer(t, {
    deployEnv: "local",
    novncUrl: `http://127.0.0.1:${upPort}/vnc.html?autoconnect=true&resize=scale`,
  });

  const htmlRes = await fetch(`${baseUrl}/novnc/vnc.html?autoconnect=1`);
  assert.equal(htmlRes.status, 200);
  const htmlBody = await htmlRes.text();
  assert.match(htmlBody, /#noVNC_control_bar/);
  assert.match(htmlBody, /display:none!important/);
});

test("cloud server mode exposes APIs only: / returns 'ok' and frontend UI pages return 404", async (t) => {
  const { baseUrl } = await makeTempServer(t, {
    deployEnv: "cloud",
    cloudAuthToken: "cloud-api-only-tok",
  });

  const rootRes = await fetch(`${baseUrl}/`);
  assert.equal(rootRes.status, 200);
  assert.equal(await rootRes.text(), "ok");

  for (const uiPath of ["/index.html", "/dist/app.js", "/style.css", "/public/index.html", "/skills-catalog.js", "/accounts-store.js"]) {
    const r = await fetch(`${baseUrl}${uiPath}`);
    assert.equal(r.status, 404, `expected 404 for ${uiPath} in cloud mode`);
  }

  const healthRes = await fetch(`${baseUrl}/api/system/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.deployEnv, "cloud");
});
