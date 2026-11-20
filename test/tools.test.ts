import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_DECLARATIONS,
  SCREEN_CHANGING,
  clearEphemeralSecrets,
  registerEphemeralSecret,
  runTool,
  hashScreenshot,
} from "../src/agent/tools.js";

function fakeClient(routes: any = {}) {
  const calls: any[] = [];
  return {
    calls,
    async health() {
      return { ok: true };
    },
    async call(route: any, body: any) {
      calls.push({ route, body });
      if (typeof routes[route] === "function") {
        return routes[route](body);
      }
      if (routes[route] !== undefined) {
        return routes[route];
      }
      return { ok: true };
    },
  };
}

test("TOOL_DECLARATIONS has expected shape and covers all 15 action tools", () => {
  assert.ok(Array.isArray(TOOL_DECLARATIONS), "TOOL_DECLARATIONS must be an array");
  assert.equal(TOOL_DECLARATIONS.length, 15);

  const expectedTools = [
    "screenshot",
    "click",
    "type_text",
    "key",
    "scroll",
    "drag",
    "list_windows",
    "focus_window",
    "run_shell",
    "read_file",
    "write_file",
    "open_url",
    "browser_snapshot",
    "browser_click",
    "browser_type",
  ];

  const toolMap = new Map();
  for (const decl of TOOL_DECLARATIONS) {
    assert.equal(decl.type, "function");
    assert.ok(typeof decl.name === "string" && decl.name.length > 0);
    assert.ok(typeof decl.description === "string" && decl.description.length > 0);
    assert.equal(decl.parameters.type, "object");
    assert.ok(decl.parameters.properties, "parameters must have properties");
    assert.ok(
      decl.parameters.properties.risk,
      `${decl.name} must define risk property`
    );
    assert.equal(decl.parameters.properties.risk.type, "string");
    assert.deepEqual(decl.parameters.properties.risk.enum, ["low", "high"]);
    assert.ok(Array.isArray(decl.parameters.required));
    toolMap.set(decl.name, decl);
  }

  for (const name of expectedTools) {
    assert.ok(toolMap.has(name), `Missing declaration for ${name}`);
  }

  // type_text description mentions run_shell for terminal windows
  const typeTextDecl = toolMap.get("type_text");
  assert.match(
    typeTextDecl.description,
    /run_shell.*terminal|terminal.*run_shell/i,
    "type_text description must instruct using run_shell inside terminal windows"
  );
});

test("SCREEN_CHANGING contains the 7 interactive desktop tools", () => {
  assert.ok(SCREEN_CHANGING instanceof Set);
  const expected = new Set([
    "click",
    "type_text",
    "key",
    "scroll",
    "drag",
    "focus_window",
    "open_url",
  ]);
  assert.deepEqual(SCREEN_CHANGING, expected);
});

test("unknown tool returns error result, not throw", async () => {
  const r = await runTool("fly", {}, fakeClient());
  assert.deepEqual(r, {
    result: { error: "unknown tool: fly" },
    screenshot: null,
  });
});

test("executor error becomes error result", async () => {
  const rejectingClient = {
    async health() {
      return { ok: true };
    },
    async call() {
      const err: any = new Error("bad x");
      err.status = 400;
      throw err;
    },
  };
  const r = await runTool("click", { x: 10, y: 20 }, rejectingClient);
  assert.deepEqual(r, {
    result: { error: "bad x" },
    screenshot: null,
  });
});

test("screen-changing tool returns fresh screenshot and strips risk", async () => {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const client = fakeClient({
    "/click": { ok: true },
    "/screenshot": { png_base64: pngBase64, width: 1440, height: 900 },
  });

  const r = await runTool("click", { x: 1, y: 2, risk: "high" }, client, { settleMs: 0 });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[0], { route: "/click", body: { x: 1, y: 2 } });
  assert.deepEqual(client.calls[1], { route: "/screenshot", body: {} });
  assert.deepEqual(r.result, { ok: true });
  assert.ok(Buffer.isBuffer(r.screenshot));
  assert.equal(r.screenshot.toString("base64"), pngBase64);
});

test("run_shell does not screenshot", async () => {
  const client = fakeClient({
    "/shell": { exit_code: 0, stdout: "hello", stderr: "", truncated: false },
  });

  const r = await runTool("run_shell", { command: "echo hello", risk: "low" }, client, { settleMs: 0 });

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { route: "/shell", body: { command: "echo hello" } });
  assert.deepEqual(r.result, { exit_code: 0, stdout: "hello", stderr: "", truncated: false });
  assert.equal(r.screenshot, null);
});

test("screenshot tool decodes png_base64 and avoids keeping huge base64 in result", async () => {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const client = fakeClient({
    "/screenshot": { png_base64: pngBase64, width: 1440, height: 900 },
  });

  const r = await runTool("screenshot", { risk: "low" }, client, { settleMs: 0 });

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { route: "/screenshot", body: {} });
  assert.deepEqual(r.result, { ok: true, width: 1440, height: 900 });
  assert.ok((r.result as any).png_base64 === undefined, "base64 string should not be kept in result object");
  assert.ok(Buffer.isBuffer(r.screenshot));
  assert.equal(r.screenshot.toString("base64"), pngBase64);
});

test("all 15 tools map to their correct executor routes", async () => {
  const routeExpectations = {
    screenshot: "/screenshot",
    click: "/click",
    type_text: "/type",
    key: "/key",
    scroll: "/scroll",
    drag: "/drag",
    list_windows: "/windows",
    focus_window: "/focus",
    run_shell: "/shell",
    read_file: "/read",
    write_file: "/write",
    open_url: "/open_url",
    browser_snapshot: "/browser/snapshot",
    browser_click: "/browser/click",
    browser_type: "/browser/type",
  };

  for (const [toolName, expectedRoute] of Object.entries(routeExpectations)) {
    const client = fakeClient({
      "/screenshot": { png_base64: "YWJj", width: 1440, height: 900 },
    });
    await runTool(toolName, { risk: "low" }, client, { settleMs: 0 });
    assert.equal(
      client.calls[0].route,
      expectedRoute,
      `Tool ${toolName} should call route ${expectedRoute}`
    );
  }
});

test("browser_snapshot, browser_click, and browser_type do NOT take screenshots", async () => {
  const client = fakeClient({
    "/browser/snapshot": { ok: true, url: "https://example.com", elements: [{ ref: "e1" }] },
    "/browser/click": { ok: true, clicked: { ref: "e1" }, elements: [] },
    "/browser/type": { ok: true, typed: { ref: "e1", submit: true }, elements: [] },
  });

  const s = await runTool("browser_snapshot", { url: "https://example.com", risk: "low" }, client, { settleMs: 0 });
  assert.equal(s.screenshot, null);
  assert.equal(s.result.ok, true);

  const c = await runTool("browser_click", { ref: "e1", risk: "low" }, client, { settleMs: 0 });
  assert.equal(c.screenshot, null);
  assert.equal(c.result.ok, true);

  const t = await runTool("browser_type", { ref: "e1", text: "hi", submit: true, risk: "low" }, client, { settleMs: 0 });
  assert.equal(t.screenshot, null);
  assert.equal(t.result.ok, true);
  assert.equal(client.calls.length, 3);
});

test("screen_changed detection marks unchanged and changed desktop screenshots", async () => {
  const pngA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const pngB = Buffer.from("different-png-bytes").toString("base64");
  const prevSha1 = hashScreenshot(Buffer.from(pngA, "base64"));

  const unchangedClient = fakeClient({
    "/click": () => ({ ok: true }),
    "/screenshot": { png_base64: pngA, width: 1440, height: 900 },
  });
  const rUnchanged = await runTool(
    "click",
    { x: 10, y: 10, risk: "low" },
    unchangedClient,
    { settleMs: 0, prevScreenshotSha1: prevSha1 }
  );
  assert.equal(rUnchanged.result.screen_changed, false);
  assert.match(rUnchanged.result.screen_note, /did not change/i);

  const changedClient = fakeClient({
    "/click": () => ({ ok: true }),
    "/screenshot": { png_base64: pngB, width: 1440, height: 900 },
  });
  const rChanged = await runTool(
    "click",
    { x: 10, y: 10, risk: "low" },
    changedClient,
    { settleMs: 0, prevScreenshotSha1: prevSha1 }
  );
  assert.equal(rChanged.result.screen_changed, true);
});

test("runTool resolves ephemeral credential secret_ref in host memory for browser_type without mutating caller args", async () => {
  clearEphemeralSecrets();
  const ref = registerEphemeralSecret("MySecret#123");
  assert.match(ref, /^\{\{secret:cred_[a-f0-9]+\}\}$/);

  const client = fakeClient({
    "/browser/type": { ok: true, typed: { ref: "e1", submit: true } },
  });
  const callerArgs = { ref: "e1", text: ref, submit: true, risk: "low" };
  const r = await runTool("browser_type", callerArgs, client, { settleMs: 0 });

  assert.equal(r.result.ok, true);
  assert.equal(client.calls[0].body.text, "MySecret#123");
  assert.equal(callerArgs.text, ref, "caller args passed to logs/history must stay redacted");

  clearEphemeralSecrets();
  const expired = await runTool("browser_type", { ref: "e1", text: ref }, client, { settleMs: 0 });
  assert.match(expired.result.error || "", /expired or not found/);

  const osSecretRef = registerEphemeralSecret("TopSecret!1");
  const osClient = fakeClient({
    "/type": { ok: true },
    "/screenshot": { png_base64: Buffer.from("fake-png").toString("base64") },
  });
  const osCallerArgs = { text: osSecretRef };
  const osRes = await runTool("type_text", osCallerArgs, osClient, { settleMs: 0 });
  assert.equal(osRes.result.ok, true);
  assert.equal(osClient.calls[0].route, "/type");
  assert.equal(osClient.calls[0].body.text, "TopSecret!1");
  assert.equal(osClient.calls[0].body.sensitive, true, "OS-level type_text secret injection must mark sensitive=true");
  assert.equal(osCallerArgs.text, osSecretRef, "caller args for type_text must stay redacted");

  const prevCalls = client.calls.length;
  const blockedShell = await runTool("run_shell", { command: `echo ${osSecretRef}` }, client, { settleMs: 0 });
  assert.match(blockedShell.result.error || "", /Refusing to inject credential secret_ref/);
  const blockedKey = await runTool("key", { combo: osSecretRef }, client, { settleMs: 0 });
  assert.match(blockedKey.result.error || "", /Refusing to inject credential secret_ref/);
  assert.equal(client.calls.length, prevCalls, "disallowed tools with secret_ref must not reach executor");
});
