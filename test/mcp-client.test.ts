import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MCP_SERVERS,
  getDefaultMcpServers,
  inferMcpToolReadOnly,
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
    command: process.platform === "darwin" ? "/Applications/KimiCU.app/Contents/MacOS/kimi-cu" : "",
    args: ["mcp", "-s", "user"],
  });
  assert.deepEqual(getDefaultMcpServers("darwin")["kimi-cu"], {
    type: "stdio",
    command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
    args: ["mcp", "-s", "user"],
  });
  assert.deepEqual(getDefaultMcpServers("win32")["kimi-cu"], {
    type: "stdio",
    command: "",
    args: ["mcp", "-s", "user"],
  });
  assert.deepEqual(getDefaultMcpServers("linux")["kimi-cu"], {
    type: "stdio",
    command: "",
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
  // Read-only MCP tools omit risk to prevent spurious confirmations, while mutating tools include it
  assert.equal(getAppState.parameters.properties.risk, undefined);
  const clickTool = tools.find((d) => d.name === "mcp__kimi_cu__click");
  assert.ok(clickTool?.parameters?.properties?.risk);

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

test("Phase 4 P0-5: createMcpManager caps oversized MCP text and structuredContent payloads", async (t) => {
  const hugeScript = `
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "huge", version: "1.0" }, capabilities: { tools: {} } } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "dump", description: "dump", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
        } else if (msg.method === "tools/call") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: "X".repeat(30000) }],
              structuredContent: { big: "Y".repeat(20000) }
            }
          }) + "\\n");
        }
      }
    });
  `;
  const mgr = createMcpManager({
    getServersConfig: () => ({
      "huge-mcp": {
        type: "stdio",
        command: process.execPath,
        args: ["--input-type=module", "-e", hugeScript],
      },
    }),
  });
  t.after(() => mgr.closeAll());

  const res = await mgr.callTool("mcp__huge_mcp__dump", {});
  assert.equal(res.result.ok, true);
  const resText = String((res.result as any).text || "");
  assert.ok(resText.length < 13000);
  assert.match(resText, /truncated 18000 MCP chars/);
  assert.equal(res.result.structuredContent._truncated, true);
});

test("createMcpManager auto-reloads upgraded binary on disk, honors tools/list_changed, and infers readOnly metadata", async (t) => {
  assert.equal(inferMcpToolReadOnly({ name: "subscribe_system_state" }), true);
  assert.equal(inferMcpToolReadOnly({ name: "get_app_state" }), true);
  assert.equal(inferMcpToolReadOnly({ name: "list_custom_views" }), true);
  assert.equal(inferMcpToolReadOnly({ name: "click" }), false);
  assert.equal(inferMcpToolReadOnly({ name: "drag_paths" }), false);
  assert.equal(
    inferMcpToolReadOnly({ name: "future_action", annotations: { readOnlyHint: true } }),
    true
  );
  assert.equal(
    inferMcpToolReadOnly({ name: "get_secret", annotations: { destructiveHint: true } }),
    false
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-mcp-upgrade-"));
  const scriptPath = path.join(tmpDir, "dynamic-kimicu.mjs");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writeMockScript = (mode: "v068" | "v077") => {
    const code =
      mode === "v068"
        ? `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "kimi-cu", version: "0.6.8" }, capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "click", description: "legacy click", inputSchema: { type: "object", properties: { app: { type: "string" }, element_id: { type: "string" }, snapshot_id: { type: "string" } } } },
      { name: "js", description: "legacy js repl", inputSchema: { type: "object", properties: { code: { type: "string" } } } }
    ] } });
  }
});
`
        : `
import readline from "node:readline";
let extraAdded = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "kimi-cu", version: "0.7.7" },
        instructions: "Prefer subscribe_system_state over polling.",
        capabilities: {
          tools: { listChanged: true },
          experimental: {
            "kimi-cu-runtime": {
              input_mode: "adaptive_background_first",
              moves_real_pointer: false,
              state_diff: true,
              supports_rich_paste: true
            }
          }
        }
      }
    });
  } else if (msg.method === "tools/list") {
    const tools = [
      { name: "click", description: "grounded click", inputSchema: { type: "object", properties: { app: { type: "string" }, index: { type: "integer" }, snapshot_id: { type: "string" } } } },
      { name: "paste", description: "background paste", inputSchema: { type: "object", properties: { app: { type: "string" }, text: { type: "string" } } } },
      { name: "subscribe_system_state", description: "subscribe focus", inputSchema: { type: "object", properties: {} } }
    ];
    if (extraAdded) {
      tools.push({ name: "inspect_displays", description: "live added display inspector", inputSchema: { type: "object", properties: {} } });
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call" && msg.params?.name === "paste") {
    extraAdded = true;
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pasted" }] } });
  }
});
`;
    fs.writeFileSync(scriptPath, code, "utf8");
  };

  writeMockScript("v068");
  const mgr = createMcpManager({
    platform: "darwin",
    getServersConfig: () => ({
      "kimi-cu": {
        type: "stdio",
        command: process.execPath,
        args: [scriptPath],
      },
    }),
  });
  t.after(() => mgr.closeAll());

  const toolsV1 = await mgr.listGeminiTools(["kimi-cu"]);
  assert.deepEqual(
    toolsV1.map((x) => x.name),
    ["mcp__kimi_cu__click", "mcp__kimi_cu__js"]
  );
  const profileV1 = mgr.getServerRuntimeProfile("kimi-cu");
  assert.equal(profileV1?.serverInfo?.version, "0.6.8");

  // Simulate in-place KimiCU upgrade on disk without calling reconnectServer
  writeMockScript("v077");
  const nextTime = new Date(Date.now() + 5000);
  fs.utimesSync(scriptPath, nextTime, nextTime);

  const toolsV2 = await mgr.listGeminiTools(["kimi-cu"]);
  assert.deepEqual(
    toolsV2.map((x) => x.name),
    ["mcp__kimi_cu__click", "mcp__kimi_cu__paste", "mcp__kimi_cu__subscribe_system_state"]
  );
  const profileV2 = mgr.getServerRuntimeProfile("kimi-cu");
  assert.equal(profileV2?.serverInfo?.version, "0.7.7");
  assert.equal(profileV2?.runtimeCapabilities?.input_mode, "adaptive_background_first");
  assert.equal(profileV2?.instructions, "Prefer subscribe_system_state over polling.");
  assert.equal(
    profileV2?.tools.find((x) => x.name === "subscribe_system_state")?.readOnly,
    true
  );

  // Trigger notifications/tools/list_changed -> next listGeminiTools refreshes automatically
  await mgr.callTool("mcp__kimi_cu__paste", { app: "Notes", text: "hi" });
  const toolsV3 = await mgr.listGeminiTools(["kimi-cu"]);
  assert.ok(toolsV3.some((x) => x.name === "mcp__kimi_cu__inspect_displays"));
});
