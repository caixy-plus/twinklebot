import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MCP_SERVERS,
  toMcpFunctionName,
  parseMcpFunctionName,
  isMcpToolName,
  sanitizeMcpSchemaForGemini,
  createMcpManager,
} from "../src/lib/mcp-client.js";

const MOCK_MCP_SERVER_SCRIPT = `
import readline from "node:readline";

let initializedNotified = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized") {
    initializedNotified = true;
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kimi-cu", version: "0.6.8" },
      },
    });
    return;
  }
  if (!initializedNotified) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32002, message: "Server not initialized" },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "get_app_state",
            description: "Inspect app window and AX tree",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                app: { type: "string", description: "Bundle identifier" },
                max_depth: { type: "integer", default: 10, minimum: 1, maximum: 50 },
                point: {
                  type: "array",
                  minItems: 2,
                  maxItems: 2,
                  items: { type: "number" },
                },
              },
              required: ["app"],
            },
          },
          {
            name: "click",
            description: "Click background macOS window",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                app: { type: "string" },
                element_id: { type: "string" },
                snapshot_id: { type: "string" },
              },
              required: ["app"],
            },
          },
          {
            name: "check_env",
            description: "Echo sensitive env presence for test",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    if (name === "get_app_state") {
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: "AXWindow Finder [e1]" },
            { type: "image", data: jpegBytes.toString("base64"), mimeType: "image/jpeg" },
          ],
          structuredContent: {
            app: args.app,
            snapshot_id: "snap_1",
            screenshot_id: "shot_1",
          },
        },
      });
      return;
    }
    if (name === "check_env") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
                hasExecutorToken: Boolean(process.env.TWINKLEBOT_EXECUTOR_TOKEN),
              }),
            },
          ],
        },
      });
      return;
    }
    if (name === "crash_now") {
      process.exit(1);
    }
    if (name === "tool_error") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Window not found" }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "ok:" + name }],
      },
    });
  }
});
`;

test("DEFAULT_MCP_SERVERS contains exact kimi-cu stdio definition", () => {
  assert.deepEqual(DEFAULT_MCP_SERVERS["kimi-cu"], {
    type: "stdio",
    command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
    args: ["mcp", "-s", "user"],
  });
});

test("MCP tool namespacing maps serverId and toolName losslessly for known servers", () => {
  const fnName = toMcpFunctionName("kimi-cu", "get_app_state");
  assert.equal(fnName, "mcp__kimi_cu__get_app_state");
  assert.equal(isMcpToolName(fnName), true);
  assert.equal(isMcpToolName("click"), false);
  assert.deepEqual(parseMcpFunctionName(fnName, ["kimi-cu"]), {
    serverId: "kimi-cu",
    toolName: "get_app_state",
  });
});

test("sanitizeMcpSchemaForGemini strips unsupported JSON Schema keywords recursively", () => {
  const dirty = {
    type: "object",
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
    properties: {
      app: { type: "string", description: "Bundle ID", default: "com.apple.finder" },
      depth: { type: "integer", minimum: 1, maximum: 20 },
      coords: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: { type: "number", minimum: 0 },
      },
    },
    required: ["app"],
  };

  const clean = sanitizeMcpSchemaForGemini(dirty);
  assert.deepEqual(clean, {
    type: "object",
    properties: {
      app: {
        type: "string",
        description: "Bundle ID",
        ...(clean.properties.app.risk ? {} : {}),
      },
      depth: { type: "integer" },
      coords: {
        type: "array",
        items: { type: "number" },
      },
    },
    required: ["app"],
  });
});

test("createMcpManager performs stdio handshake, lists Gemini-safe tools, extracts screenshots, and scrubs secrets", async (t) => {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevTok = process.env.TWINKLEBOT_EXECUTOR_TOKEN;
  process.env.GEMINI_API_KEY = "super-secret-gemini-key";
  process.env.TWINKLEBOT_EXECUTOR_TOKEN = "super-secret-exec-token";

  const manager = createMcpManager({
    getServersConfig: () => ({
      "kimi-cu": {
        type: "stdio",
        command: process.execPath,
        args: ["--input-type=module", "-e", MOCK_MCP_SERVER_SCRIPT],
      },
    }),
  });

  t.after(async () => {
    await manager.closeAll();
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.TWINKLEBOT_EXECUTOR_TOKEN;
    else process.env.TWINKLEBOT_EXECUTOR_TOKEN = prevTok;
  });

  const tools = await manager.listGeminiTools(["kimi-cu"]);
  assert.equal(tools.length, 3);
  const getAppState = tools.find((d) => d.name === "mcp__kimi_cu__get_app_state");
  assert.ok(getAppState);
  assert.equal(getAppState.type, "function");
  assert.equal("additionalProperties" in getAppState.parameters, false);
  assert.equal("minimum" in getAppState.parameters.properties.max_depth, false);
  // Ensure risk parameter is available for policy engine
  assert.ok(getAppState.parameters.properties.risk);

  const status = await manager.getServerStatus("kimi-cu", { connect: false });
  assert.equal(status.connected, true);
  assert.equal(status.serverInfo?.version, "0.6.8");
  assert.equal(status.toolCount, 3);

  // Call tool returning image + structuredContent
  const execRes = await manager.callTool("mcp__kimi_cu__get_app_state", {
    app: "com.apple.finder",
    risk: "low",
  });
  assert.ok(Buffer.isBuffer(execRes.screenshot));
  assert.equal(execRes.mimeType, "image/jpeg");
  assert.equal(execRes.result.structuredContent.snapshot_id, "snap_1");
  assert.match((execRes.result as any).text, /AXWindow Finder/);
  // Base64 image should NOT remain duplicated in result JSON
  assert.equal(JSON.stringify(execRes.result).includes("/9j/"), false);

  // Secret env vars must be scrubbed from child process
  const envCheck = await manager.callTool("mcp__kimi_cu__check_env", {});
  const parsedEnv = JSON.parse((envCheck.result as any).text);
  assert.equal(parsedEnv.hasGeminiKey, false);
  assert.equal(parsedEnv.hasExecutorToken, false);

  // Error result surfaces ok: false
  const errRes = await manager.callTool("mcp__kimi_cu__tool_error", {});
  assert.equal(errRes.result.ok, false);
  assert.match((errRes.result as any).error, /Window not found/);

  // Auto-reconnect after child crash
  await assert.rejects(() => manager.callTool("mcp__kimi_cu__crash_now", {}));
  const afterCrash = await manager.callTool("mcp__kimi_cu__get_app_state", {
    app: "com.apple.finder",
  });
  assert.equal(afterCrash.result.structuredContent.snapshot_id, "snap_1");
});

test("createMcpManager reports clear error when MCP binary does not exist", async (t) => {
  const manager = createMcpManager({
    getServersConfig: () => ({
      "kimi-cu": {
        type: "stdio",
        command: "/nonexistent/path/to/KimiCU/kimi-cu",
        args: ["mcp", "-s", "user"],
      },
    }),
  });
  t.after(() => manager.closeAll());

  const status = await manager.getServerStatus("kimi-cu", { connect: true });
  assert.equal(status.connected, false);
  assert.equal(status.binaryExists, false);
  assert.ok(status.error);
});

test("PI-009: createMcpManager on Windows never leaks macOS /Applications/KimiCU.app path or KimiCU.app copy", async (t) => {
  const winMgr = createMcpManager({
    platform: "win32",
    getServersConfig: () => ({
      "kimi-cu": {
        type: "stdio",
        command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
        args: ["mcp", "-s", "user"],
      },
    }),
  });
  t.after(() => winMgr.closeAll());

  const st = await winMgr.getServerStatus("kimi-cu", { connect: false });
  assert.equal(st.connected, false);
  assert.equal(st.binaryExists, false);
  assert.equal(st.command, "");
  assert.equal((st as any).unsupportedPlatform, true);
  assert.ok(!String(st.error || "").includes("/Applications/KimiCU.app"));
  assert.ok(!String(st.error || "").includes("KimiCU.app"));
});
