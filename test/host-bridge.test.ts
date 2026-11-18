import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import { createHostBridge } from "../src/lib/host-bridge.js";
import { runTask } from "../src/agent/loop.js";

test("cloud-to-local host_executor WebSocket RPC bridge executes host_run_shell end-to-end", async (t) => {
  const cloudDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-bridge-cloud-"));
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-bridge-local-"));
  t.after(() => {
    fs.rmSync(cloudDir, { recursive: true, force: true });
    fs.rmSync(localDir, { recursive: true, force: true });
  });

  const localStore = createStore(localDir);
  const localServer = createServer({
    store: localStore,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal: () => {},
      stop: () => {},
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      deployEnv: "local",
      initialRole: "host_executor",
      port: 0,
      localControlToken: "local-ctrl-tok",
      writeRoots: [localDir],
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
    },
  });

  const cloudStore = createStore(cloudDir);
  const cloudSession = cloudStore.createSession({ title: "Cloud Bot" });

  let step = 0;
  const mockModel = {
    async nextTurn() {
      step += 1;
      if (step === 1) {
        return {
          text: "",
          thoughts: [],
          usage: { input: 10, output: 10 },
          outputSteps: [
            {
              type: "function_call",
              id: "call_host_1",
              name: "host_run_shell",
              args: { command: "echo BRIDGE_OK" },
            },
          ],
          calls: [
            {
              id: "call_host_1",
              name: "host_run_shell",
              args: { command: "echo BRIDGE_OK" },
            },
          ],
        };
      }
      return {
        text: "宿主机命令已执行完成：BRIDGE_OK",
        thoughts: [],
        usage: { input: 10, output: 10 },
        outputSteps: [],
        calls: [],
      };
    },
  };

  let cloudHostBridge: any = null;
  const cloudServer = createServer({
    store: cloudStore,
    model: mockModel,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal: () => {},
      stop: () => {},
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      deployEnv: "cloud",
      port: 0,
      cloudAuthToken: "cloud-tok",
      writeRoots: [cloudDir],
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
    },
  });
  cloudHostBridge = cloudServer.hostBridge;
  assert.ok(cloudHostBridge, "server should expose hostBridge");

  await new Promise<void>((r) => localServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => cloudServer.listen(0, "127.0.0.1", r));
  t.after(async () => {
    localServer.closeAllConnections?.();
    cloudServer.closeAllConnections?.();
    await new Promise<void>((r) => localServer.close(() => r()));
    await new Promise<void>((r) => cloudServer.close(() => r()));
  });

  const localUrl = `http://127.0.0.1:${(localServer.address() as any).port}`;
  const cloudPort = (cloudServer.address() as any).port;

  // Connect Client UI bridge over WebSocket to cloudServer
  const ws = new WebSocket(`ws://127.0.0.1:${cloudPort}/ws?token=cloud-tok`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  t.after(() => ws.close());
  ws.send(
    JSON.stringify({
      type: "host_hello",
      hostId: "test-mac",
      hostname: "Test-Mac",
      platform: "darwin",
    })
  );
  await new Promise((r) => setTimeout(r, 30));

  ws.addEventListener("message", async (evt) => {
    const msg = JSON.parse(String(evt.data));
    if (msg.type === "host_rpc_request") {
      const res = await fetch(`${localUrl}/api/host/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Local-Control-Token": "local-ctrl-tok",
        },
        body: JSON.stringify({
          tool: msg.tool,
          args: msg.args,
          approved: msg.approved,
        }),
      });
      const json = await res.json();
      ws.send(
        JSON.stringify({
          type: "host_rpc_response",
          rpcId: msg.rpcId,
          ok: Boolean(json.ok),
          result: json.result || { error: json.error },
          screenshot: json.screenshot || null,
        })
      );
    }
  });

  const events: any[] = [];
  const runRes = await runTask({
    sessionId: cloudSession.id,
    userText: "检查宿主机",
    deps: {
      model: mockModel,
      executor: { health: async () => ({ ok: true }), call: async () => ({}) },
      store: cloudStore,
      hostBridge: cloudHostBridge,
      config: {
        deployEnv: "cloud",
        writeRoots: [cloudDir],
        defaultModel: "gemini-4-argon",
        models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
      },
      emit: (e: any) => events.push(e),
    },
  });

  assert.equal(runRes.status, "done");
  assert.match(runRes.text, /BRIDGE_OK/);
  const resultEvt = events.find((e) => e.type === "result" && e.name === "host_run_shell");
  assert.ok(resultEvt);
  assert.equal(resultEvt.result.exitCode, 0);
  assert.match(resultEvt.result.stdout, /BRIDGE_OK/);
});

test("host bridge rejects pending rpc on ws disconnect without hanging", async () => {
  const sent: any[] = [];
  const fakeWsServer = {
    getClients: () => [{ id: "client_1" }],
    sendToClient: (clientId: any, payload: any) => {
      sent.push({ clientId, payload });
      return true;
    },
  };

  const bridge = createHostBridge({ wsServer: fakeWsServer, timeoutMs: 5000 });
  bridge.registerHostMeta("client_1", { hostId: "test-mac", hostname: "Test-Mac" });
  const rpcPromise = bridge.execute({
    name: "host_run_shell",
    args: { command: "sleep 10" },
    callId: "c1",
    sessionId: "s1",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.type, "host_rpc_request");
  bridge.rejectAllForClient("client_1");

  await assert.rejects(() => rpcPromise, /host bridge client disconnected/i);
});

test("host bridge ignores non-host mobile/web WebSocket clients that did not send host_hello", async (t) => {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-bridge-nonhost-"));
  t.after(() => {
    fs.rmSync(localDir, { recursive: true, force: true });
  });

  const localStore = createStore(localDir);
  const localSession = localStore.createSession({ title: "Local Bot" });

  let step = 0;
  const mockModel = {
    async nextTurn() {
      step += 1;
      if (step === 1) {
        return {
          text: "",
          thoughts: [],
          usage: { input: 10, output: 10 },
          outputSteps: [
            {
              type: "function_call",
              id: "call_local_host_1",
              name: "host_run_shell",
              args: { command: "echo LOCAL_EXEC_OK" },
            },
          ],
          calls: [
            {
              id: "call_local_host_1",
              name: "host_run_shell",
              args: { command: "echo LOCAL_EXEC_OK" },
            },
          ],
        };
      }
      return {
        text: "LOCAL_EXEC_OK",
        thoughts: [],
        usage: { input: 10, output: 10 },
        outputSteps: [],
        calls: [],
      };
    },
  };

  const localServer = createServer({
    store: localStore,
    model: mockModel,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal: () => {},
      stop: () => {},
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      deployEnv: "local",
      port: 0,
      writeRoots: [localDir],
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
    },
  });
  await new Promise<void>((r) => localServer.listen(0, "127.0.0.1", r));
  t.after(async () => {
    localServer.closeAllConnections?.();
    await new Promise<void>((r) => localServer.close(() => r()));
  });

  // Connect a mobile/web WS client without sending host_hello
  const mobileWs = new WebSocket(`ws://127.0.0.1:${(localServer.address() as any).port}/ws`);
  await new Promise((resolve, reject) => {
    mobileWs.addEventListener("open", resolve, { once: true });
    mobileWs.addEventListener("error", reject, { once: true });
  });
  t.after(() => mobileWs.close());

  let mobileReceivedRpc = false;
  mobileWs.addEventListener("message", (evt) => {
    const msg = JSON.parse(String(evt.data));
    if (msg.type === "host_rpc_request") {
      mobileReceivedRpc = true;
    }
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(localServer.hostBridge.hasConnectedHost(), false);
  assert.deepEqual(localServer.hostBridge.listConnectedHosts(), []);
  await assert.rejects(
    () => localServer.hostBridge.execute({ name: "host_run_shell", args: { command: "echo nope" } }),
    /当前没有在线的客户端主机/
  );

  // In local mode, runTask should execute host_run_shell locally rather than routing to mobileWs
  const events: any[] = [];
  const res = await runTask({
    sessionId: localSession.id,
    userText: "检查本机",
    deps: {
      model: mockModel,
      executor: { health: async () => ({ ok: true }), call: async () => ({}) },
      store: localStore,
      hostBridge: localServer.hostBridge,
      config: {
        deployEnv: "local",
        writeRoots: [localDir],
        defaultModel: "gemini-4-argon",
        models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
      },
      emit: (e: any) => events.push(e),
    },
  });

  assert.equal(mobileReceivedRpc, false);
  assert.equal(res.status, "done");
  const resultEvt = events.find((e) => e.type === "result" && e.name === "host_run_shell");
  assert.ok(resultEvt);
  assert.equal(resultEvt.result.exitCode, 0);
  assert.match(resultEvt.result.stdout, /LOCAL_EXEC_OK/);
});
