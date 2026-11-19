import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

async function bootServer(t: any, extra: any = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-host-mcp-"));
  const store = createStore(tmpDir);
  const stoppedMcpServers: any[] = [];
  let runnerStopped = 0;

  const fakeMcpManager = extra.mcpManager || {
    getResolvedServersConfig: () => ({
      "kimi-cu": {
        type: "stdio",
        command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
        args: ["mcp", "-s", "user"],
      },
      ...(store.readSettings()?.mcpServers || {}),
    }),
    async getServerStatus(serverId: string, { connect = false }: any = {}) {
      return {
        serverId,
        configured: true,
        command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
        args: ["mcp", "-s", "user"],
        binaryExists: true,
        connected: Boolean(connect),
        serverInfo: connect ? { name: "kimi-cu", version: "0.6.8" } : null,
        toolCount: connect ? 20 : 0,
        tools: connect ? ["list_apps", "get_app_state", "click"] : [],
      };
    },
    async reconnectServer(serverId: string) {
      return {
        serverId,
        configured: true,
        command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
        args: ["mcp", "-s", "user"],
        binaryExists: true,
        connected: true,
        serverInfo: { name: "kimi-cu", version: "0.6.8" },
        toolCount: 20,
        tools: ["list_apps", "get_app_state", "click"],
      };
    },
    async stopServer(serverId: string) {
      stoppedMcpServers.push(serverId);
    },
    async closeAll() {},
  };

  let updateCalls = 0;
  const srv = createServer({
    store,
    mcpManager: fakeMcpManager,
    updateBotComputerFn:
      extra.updateBotComputerFn ||
      (async () => {
        updateCalls += 1;
        return {
          ok: true,
          updatedAt: "2026-11-11T15:30:00.000Z",
          screen: { width: 1440, height: 900 },
        };
      }),
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      stop: () => {
        runnerStopped += 1;
      },
      broadcastGlobal: () => {},
    },
    executor: { health: async () => ({ ok: true, screen: { width: 1440, height: 900 } }) },
    config: {
      port: 0,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
      writeRoots: [tmpDir],
    },
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = async (method: string, p: string, body?: any) => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };

  return {
    store,
    call,
    stoppedMcpServers,
    getRunnerStopped: () => runnerStopped,
    getUpdateCalls: () => updateCalls,
  };
}

test("kimi-cu optional platform skill can be manually added and removed while built-in skills remain locked", async (t) => {
  const { call, stoppedMcpServers } = await bootServer(t);

  // Initially not installed
  const initRes = await call("GET", "/api/skills");
  assert.deepEqual(initRes.json.installedSkills, ["qqmail", "custom-mail"]);

  // Manual install
  const addRes = await call("POST", "/api/skills/kimi-cu/install");
  assert.equal(addRes.status, 200);
  assert.deepEqual(addRes.json.installedSkills, [
    "qqmail",
    "custom-mail",
    "kimi-cu",
  ]);
  const kimiRow = addRes.json.skillsCatalog.platform.find((s: any) => s.id === "kimi-cu");
  assert.equal(kimiRow.installed, true);
  assert.equal(kimiRow.removable, true);

  // Manual remove stops MCP server process
  const rmRes = await call("DELETE", "/api/skills/kimi-cu");
  assert.equal(rmRes.status, 200);
  assert.deepEqual(rmRes.json.installedSkills, ["qqmail", "custom-mail"]);
  assert.deepEqual(stoppedMcpServers, ["kimi-cu"]);
});

test("settings persist hostComputer executionMode (without traffic forwarding) and mcpServers config", async (t) => {
  const { call } = await bootServer(t);

  const initial = await call("GET", "/api/settings");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json.hostComputer, { executionMode: "always" });
  assert.deepEqual(initial.json.mcpServers["kimi-cu"], {
    type: "stdio",
    command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
    args: ["mcp", "-s", "user"],
  });

  // Switch hostComputer executionMode to "ask"
  const updated = await call("POST", "/api/settings", {
    hostComputer: { executionMode: "ask" },
    mcpServers: {
      "kimi-cu": {
        type: "stdio",
        command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
        args: ["mcp", "-s", "user"],
      },
    },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.hostComputer, { executionMode: "ask" });

  // Invalid executionMode returns 400
  const invalid = await call("POST", "/api/settings", {
    hostComputer: { executionMode: "bogus" },
  });
  assert.equal(invalid.status, 400);
});

test("routing settings persist with validation", async (t) => {
  const { call } = await bootServer(t);

  const initial = await call("GET", "/api/settings");
  assert.deepEqual(initial.json.routing, { smartRouter: true, mode: "balanced", maxTurnUsd: 0.5 });

  const saved = await call("POST", "/api/settings", { routing: { mode: "economy", maxTurnUsd: 0.2 } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.routing, { smartRouter: true, mode: "economy", maxTurnUsd: 0.2 });

  assert.equal((await call("POST", "/api/settings", { routing: { mode: "turbo" } })).status, 400);
  assert.equal((await call("POST", "/api/settings", { routing: { maxTurnUsd: 50 } })).status, 400);
});

test("GET /api/computer/status includes local Mac hostComputer info and POST /api/computer/update & reset update Bot's computer", async (t) => {
  const { call, getRunnerStopped, getUpdateCalls } = await bootServer(t);

  const comp = await call("GET", "/api/computer/status");
  assert.equal(comp.status, 200);
  assert.equal(comp.json.online, process.platform !== "linux");
  assert.ok(comp.json.hostComputer);
  assert.equal(comp.json.hostComputer.online, true);
  assert.equal(comp.json.hostComputer.hostname, os.hostname());
  assert.equal(comp.json.hostComputer.executionMode, "always");

  const upd = await call("POST", "/api/computer/update");
  assert.equal(upd.status, 200);
  assert.equal(upd.json.ok, true);
  assert.ok(upd.json.status);
  assert.equal(getRunnerStopped(), 1);
  assert.equal(getUpdateCalls(), 1);

  const rst = await call("POST", "/api/computer/reset");
  assert.equal(rst.status, 200);
  assert.equal(rst.json.ok, true);
  assert.ok(rst.json.status);
  assert.equal(getRunnerStopped(), 2);
});

test("GET /api/mcp/status and POST /api/mcp/reconnect report KimiCU connection details", async (t) => {
  const { call } = await bootServer(t);

  const st = await call("GET", "/api/mcp/status?server=kimi-cu&connect=true");
  assert.equal(st.status, 200);
  assert.equal(st.json.connected, true);
  assert.equal(st.json.serverInfo.version, "0.6.8");
  assert.equal(st.json.toolCount, 20);

  const rc = await call("POST", "/api/mcp/reconnect", { serverId: "kimi-cu" });
  assert.equal(rc.status, 200);
  assert.equal(rc.json.connected, true);
  assert.equal(rc.json.toolCount, 20);
});
