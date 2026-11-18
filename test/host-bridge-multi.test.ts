import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createRunner } from "../src/agent/runner.js";
import { createServer } from "../src/server/index.js";

test("cloud mode lists multiple online host_executor clients, allows selection, and reports offline when none connected", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-multihost-"));
  const store = createStore(tmpDir);
  const runner = createRunner({
    store,
    model: { async nextTurn() { return { text: "ok", calls: [] }; } },
    executor: { async health() { return { ok: true }; } },
  });
  const srv = createServer({
    config: {
      port: 0,
      deployEnv: "cloud",
      cloudAuthToken: "tok-mh",
      dataDir: tmpDir,
      writeRoots: [tmpDir],
    },
    store,
    runner,
    executor: { async health() { return { ok: true }; } },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const wsUrl = `ws://127.0.0.1:${(srv.address() as any).port}/ws?token=tok-mh`;
  const authHdr = { Authorization: "Bearer tok-mh" };

  // 0 hosts connected
  const emptyRes = await fetch(`${base}/api/computer/hosts`, { headers: authHdr }).then((r) => r.json());
  assert.equal(emptyRes.hosts.length, 0);
  assert.equal(emptyRes.selectedHostId, null);

  // Connect two host_executor WebSockets
  const ws1 = new WebSocket(wsUrl);
  const ws2 = new WebSocket(wsUrl);
  t.after(() => {
    try { ws1.close(); } catch {}
    try { ws2.close(); } catch {}
  });
  await Promise.all([
    new Promise((r) => ws1.addEventListener("open", r, { once: true })),
    new Promise((r) => ws2.addEventListener("open", r, { once: true })),
  ]);
  ws1.send(JSON.stringify({ type: "host_hello", hostId: "mac-home", hostname: "Home-MacBook", platform: "darwin" }));
  ws2.send(JSON.stringify({ type: "host_hello", hostId: "mac-work", hostname: "Work-Studio", platform: "darwin" }));
  await new Promise((r) => setTimeout(r, 40));

  const listRes = await fetch(`${base}/api/computer/hosts`, { headers: authHdr }).then((r) => r.json());
  assert.equal(listRes.hosts.length, 2);
  const home = listRes.hosts.find((h: any) => h.hostname === "Home-MacBook");
  assert.ok(home);

  // Select Home-MacBook explicitly
  const selRes = await fetch(`${base}/api/computer/hosts/select`, {
    method: "POST",
    headers: { ...authHdr, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: home.clientId }),
  }).then((r) => r.json());
  assert.equal(selRes.selectedHostId, home.clientId);

  // Verify hostBridge routes RPC to selected client
  const rpcSeen: any[] = [];
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
