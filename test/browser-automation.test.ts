import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_BROWSER_AUTOMATION_SETTINGS,
  DEFAULT_BROWSER_DEBUG_PORT,
  formatBrowserAutomationModeLabel,
  isBrowserAutomationTool,
  normalizeBotBrowserMode,
  normalizeBrowserAutomationSettings,
  resolveEffectiveBrowserMode,
} from "../src/shared/browser-automation.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { runTool, registerEphemeralSecret } from "../src/agent/tools.js";
import {
  closeAllLocalBrowsers,
  detectLocalChromeExecutable,
  getDefaultLocalChromeManager,
  probeLocalChromeStatus,
  resolveDebugProfileDir,
} from "../src/lib/local-chrome-cdp.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

test("browser automation settings normalization & per-Bot override resolution", () => {
  assert.deepEqual(
    normalizeBrowserAutomationSettings(undefined),
    DEFAULT_BROWSER_AUTOMATION_SETTINGS
  );
  assert.deepEqual(
    normalizeBrowserAutomationSettings({
      mode: "invalid_mode",
      debugPort: 80,
      executablePath: "  /usr/bin/chrome  ",
    }),
    {
      mode: "bot_computer",
      debugPort: DEFAULT_BROWSER_DEBUG_PORT,
      executablePath: "/usr/bin/chrome",
    }
  );
  assert.deepEqual(
    normalizeBrowserAutomationSettings({
      mode: "local_debug",
      debugPort: 9444,
      executablePath: "",
    }),
    {
      mode: "local_debug",
      debugPort: 9444,
      executablePath: "",
    }
  );

  assert.equal(normalizeBotBrowserMode(undefined), "inherit");
  assert.equal(normalizeBotBrowserMode("bogus"), "inherit");
  assert.equal(normalizeBotBrowserMode("local_headless"), "local_headless");

  assert.equal(
    resolveEffectiveBrowserMode({ mode: "bot_computer" }, "inherit"),
    "bot_computer"
  );
  assert.equal(
    resolveEffectiveBrowserMode({ mode: "bot_computer" }, "local_headless"),
    "local_headless"
  );
  assert.equal(
    resolveEffectiveBrowserMode({ mode: "local_headless" }, "bot_computer"),
    "bot_computer"
  );
  assert.equal(
    resolveEffectiveBrowserMode({ mode: "local_debug" }, "inherit"),
    "local_debug"
  );

  assert.equal(isBrowserAutomationTool("browser_snapshot"), true);
  assert.equal(isBrowserAutomationTool("browser_upload_file"), true);
  assert.equal(isBrowserAutomationTool("run_shell"), false);
  assert.ok(formatBrowserAutomationModeLabel("local_headless").includes("Headless"));
  assert.ok(formatBrowserAutomationModeLabel("local_debug").includes("Debug"));
});

test("runTool delegates browser_* to localBrowserExecutor while preserving secret_ref resolution & protection", async () => {
  const executorCalls: string[] = [];
  const fakeClient: any = {
    call: async (route: string) => {
      executorCalls.push(route);
      return { ok: true, from: "executor" };
    },
  };
  const localCalls: Array<{ name: string; args: Record<string, any> }> = [];
  const localBrowserExecutor = async (name: string, args: Record<string, any>) => {
    localCalls.push({ name, args });
    return { ok: true, from: "local_chrome", url: "https://example.com" };
  };

  const secretRef = registerEphemeralSecret("s3cr3t-pass!");
  const typed = await runTool(
    "browser_type",
    { ref: "e2", text: secretRef, submit: true },
    fakeClient,
    { localBrowserExecutor }
  );
  assert.equal(typed.result.from, "local_chrome");
  assert.equal(executorCalls.length, 0);
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].args.text, "s3cr3t-pass!");

  // Secret ref must still be blocked on non-injectable browser tools like browser_snapshot
  const blocked = await runTool(
    "browser_snapshot",
    { url: `https://example.com/?p=${secretRef}` },
    fakeClient,
    { localBrowserExecutor }
  );
  assert.match(String(blocked.result?.error || ""), /Refusing to inject credential secret_ref/);
  assert.equal(localCalls.length, 1);

  // Non-browser tools still go to executor
  const shellOut = await runTool("run_shell", { command: "echo hi" }, fakeClient, {
    localBrowserExecutor,
  });
  assert.equal(shellOut.result.from, "executor");
  assert.deepEqual(executorCalls, ["/shell"]);
});

test("buildSystemInstruction communicates active browser automation engine & login-state trade-offs", () => {
  const headlessPrompt = buildSystemInstruction({
    enableBotTools: true,
    browserAutomationMode: "local_headless",
  });
  assert.ok(headlessPrompt.includes("Local Host Chrome Headless"));
  assert.ok(headlessPrompt.includes("ephemeral clean profile"));

  const debugPrompt = buildSystemInstruction({
    enableBotTools: true,
    browserAutomationMode: "local_debug",
    browserDebugPort: 9333,
  });
  assert.ok(debugPrompt.includes("Local Host Chrome Debug CDP"));
  assert.ok(debugPrompt.includes("9333"));
  assert.ok(debugPrompt.includes("dedicated isolated debug profile"));

  const botCompPrompt = buildSystemInstruction({
    enableBotTools: true,
    browserAutomationMode: "bot_computer",
  });
  assert.ok(botCompPrompt.includes("Bot's Computer Chrome"));
});

test("HTTP settings, per-Bot session PATCH, and /api/computer/status persist & report browser automation config", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-browser-auto-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const bot = store.createSession({ title: "Research Bot" });
  const srv = createServer({
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      deployEnv: "local",
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
      writeRoots: [tmpDir],
      screen: { width: 1440, height: 900 },
    },
    store,
    executor: {
      health: async () => ({ ok: true }),
      call: async () => ({ ok: true }),
    } as any,
    runner: {
      broadcastGlobal: () => {},
      getState: () => ({ status: "idle" }),
    } as any,
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  // 1. Default settings
  const initialSettings: any = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(initialSettings.browserAutomation?.mode, "bot_computer");
  assert.equal(initialSettings.browserAutomation?.debugPort, 9223);

  // 2. Reject invalid browserAutomation.mode
  const badRes = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browserAutomation: { mode: "bad_mode" } }),
  });
  assert.equal(badRes.status, 400);

  // 3. Persist local_debug settings
  const okRes = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      browserAutomation: { mode: "local_debug", debugPort: 9445, executablePath: "" },
    }),
  });
  assert.equal(okRes.status, 200);
  const savedSettings: any = await okRes.json();
  assert.equal(savedSettings.browserAutomation?.mode, "local_debug");
  assert.equal(savedSettings.browserAutomation?.debugPort, 9445);

  // 4. Per-Bot browserMode override + invalid rejection
  const badBotRes = await fetch(`${baseUrl}/api/sessions/${bot.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browserMode: "unknown_engine" }),
  });
  assert.equal(badBotRes.status, 400);

  const patchBotRes = await fetch(`${baseUrl}/api/sessions/${bot.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browserMode: "local_headless", touch: false }),
  });
  assert.equal(patchBotRes.status, 200);
  const patchedBot: any = await patchBotRes.json();
  assert.equal(patchedBot.browserMode, "local_headless");

  // 5. /api/computer/status exposes localBrowser probe info with isolated profileDir
  const compStatus: any = await (await fetch(`${baseUrl}/api/computer/status`)).json();
  assert.ok(compStatus.localBrowser && typeof compStatus.localBrowser === "object");
  assert.equal(compStatus.localBrowser.debugPort, 9445);
  assert.equal(compStatus.localBrowser.profileDir, resolveDebugProfileDir(tmpDir));

  const probe = await probeLocalChromeStatus({ mode: "local_debug", debugPort: 9445 }, tmpDir);
  assert.equal(probe.debugPort, 9445);

  // 6. /api/computer/input forwards special keys via `combo` + `is_admin` headers/body (P0-4 regression)
  const adminSess = store.ensureAdminBot();
  const capturedExecCalls: Array<{ route: string; body: any; opts: any }> = [];
  const srvInput = createServer({
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      deployEnv: "local",
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
      writeRoots: [tmpDir],
      screen: { width: 1440, height: 900 },
    },
    store,
    executor: {
      health: async () => ({ ok: true }),
      call: async (route: string, body: any, opts: any) => {
        capturedExecCalls.push({ route, body, opts });
        return { ok: true };
      },
    } as any,
  });
  await new Promise<void>((r) => srvInput.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise<void>((r) => srvInput.close(() => r()));
  });
  const inputBaseUrl = `http://127.0.0.1:${(srvInput.address() as AddressInfo).port}`;
  const keyResp = await fetch(`${inputBaseUrl}/api/computer/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "Return", botId: adminSess.id }),
  });
  assert.equal(keyResp.status, 200);
  assert.equal(capturedExecCalls.length, 1);
  assert.equal(capturedExecCalls[0].route, "/key");
  assert.equal(capturedExecCalls[0].body.combo, "Return");
  assert.equal(capturedExecCalls[0].body.is_admin, true);
  assert.equal(capturedExecCalls[0].opts?.headers?.["X-Twinkle-Bot-Admin"], "1");
});

test("Local Chrome security guardrails: directory executablePath safety, loopback SSRF block, and browser_upload_file policy enforcement", async (t) => {
  const { assessToolCall } = await import("../src/agent/policy.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-browser-sec-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. Directory path (not a regular file) must not pass detectLocalChromeExecutable or crash spawn
  assert.equal(detectLocalChromeExecutable(tmpDir, "linux"), "");
  const mgr = getDefaultLocalChromeManager();
  await assert.rejects(
    () =>
      mgr.executeTool(
        "browser_snapshot",
        { url: "https://example.com" },
        { mode: "local_headless", sessionKey: "bad-exec", settings: { executablePath: tmpDir } }
      ),
    /无效或不存在|未检测到/
  );

  // 2. String `paths` parameter on browser_upload_file must NOT bypass sensitive path blacklist!
  const sshBlocked = assessToolCall(
    "browser_upload_file",
    { ref: "e1", paths: path.join(os.homedir(), ".ssh", "id_rsa") },
    { sandboxMode: "full", hostExecutionMode: "always" }
  );
  assert.equal(sshBlocked.decision, "deny");

  const debugCookiesBlocked = assessToolCall(
    "browser_upload_file",
    { ref: "e1", paths: "/tmp/data/chrome-debug-profile/Default/Cookies" },
    { sandboxMode: "full", hostExecutionMode: "always" }
  );
  assert.equal(debugCookiesBlocked.decision, "deny");

  // 3. When running in local_headless/local_debug and hostExecutionMode === "off", host file uploads are denied
  const dummyDoc = path.join(tmpDir, "report.txt");
  fs.writeFileSync(dummyDoc, "hello", "utf8");
  const offBlocked = assessToolCall(
    "browser_upload_file",
    { ref: "e1", paths: [dummyDoc] },
    {
      sandboxMode: "full",
      hostExecutionMode: "off",
      browserAutomationMode: "local_headless",
    }
  );
  assert.equal(offBlocked.decision, "deny");
});

test("LocalChromeManager live headless smoke test (snapshot + type + click) when host Chrome is present", async (t) => {
  const chromePath = detectLocalChromeExecutable();
  if (!chromePath) {
    t.skip("No local Chrome/Chromium installed on test host");
    return;
  }

  const pageSrv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html><head><title>Local Chrome Smoke</title></head>
      <body>
        <input id="q" type="text" placeholder="Search box" />
        <input id="otp" type="text" placeholder="OTP code" />
        <input id="pwd" type="password" value="PreFilledTopSecretPwd!" />
        <button id="go" type="button" onclick="document.getElementById('out').textContent='Hello ' + document.getElementById('q').value">Run</button>
        <div id="out">Waiting</div>
      </body></html>`);
  });
  await new Promise<void>((resolve) => pageSrv.listen(0, "127.0.0.1", resolve));
  const testUrl = `http://127.0.0.1:${(pageSrv.address() as AddressInfo).port}/`;

  t.after(async () => {
    await closeAllLocalBrowsers();
    await new Promise<void>((resolve) => pageSrv.close(() => resolve()));
  });

  const mgr = getDefaultLocalChromeManager();
  const snap = await mgr.executeTool(
    "browser_snapshot",
    { url: testUrl },
    { mode: "local_headless", sessionKey: "unit-smoke" }
  );
  assert.equal(snap.ok, true);
  assert.equal(snap.browser_engine, "local_headless");
  assert.equal(snap.title, "Local Chrome Smoke");
  const inputEl = (snap.elements || []).find((e: any) => e.tag === "input");
  const btnEl = (snap.elements || []).find((e: any) => e.tag === "button");
  assert.ok(inputEl?.ref, "snapshot must index input ref");
  assert.ok(btnEl?.ref, "snapshot must index button ref");

  const typed = await mgr.executeTool(
    "browser_type",
    { ref: inputEl.ref, text: "TwinkleBot" },
    { mode: "local_headless", sessionKey: "unit-smoke" }
  );
  assert.equal(typed.ok, true);

  const clicked = await mgr.executeTool(
    "browser_click",
    { ref: btnEl.ref },
    { mode: "local_headless", sessionKey: "unit-smoke" }
  );
  assert.equal(clicked.ok, true);
  assert.ok(
    String(clicked.text || "").includes("Hello TwinkleBot"),
    `expected click result text to contain 'Hello TwinkleBot', got: ${clicked.text}`
  );
  // Password input without placeholder/aria-label must NEVER leak its value in elements[].name or elements[].value
  assert.ok(
    !JSON.stringify(clicked).includes("PreFilledTopSecretPwd!"),
    "Password input value must never leak into snapshot elements"
  );

  // Typing an ephemeral {{secret:cred_...}} into a text OTP input via runTool must redact secret from returned snapshot!
  const otpEl = (snap.elements || []).find((e: any) => e.name === "OTP code");
  assert.ok(otpEl?.ref);
  const secretToken = registerEphemeralSecret("OTP_SUPER_SECRET_889900");
  const secretTyped = await runTool(
    "browser_type",
    { ref: otpEl.ref, text: secretToken },
    { health: async () => ({ ok: true }), call: async () => ({ ok: true }) } as any,
    {
      localBrowserExecutor: (toolName, toolArgs, sig) =>
        mgr.executeTool(toolName, toolArgs, {
          mode: "local_headless",
          sessionKey: "unit-smoke",
          signal: sig,
        }),
    }
  );
  assert.equal(secretTyped.result?.ok, true);
  assert.ok(
    !JSON.stringify(secretTyped).includes("OTP_SUPER_SECRET_889900"),
    "Ephemeral secret typed into <input type='text'> must never echo back in browser_type snapshot"
  );

  // Loopback TwinkleBot API port (3230) and metadata IP must be blocked in LocalChromeManager
  await assert.rejects(
    () =>
      mgr.executeTool(
        "browser_snapshot",
        { url: "http://127.0.0.1:3230/api/settings" },
        { mode: "local_headless", sessionKey: "unit-smoke", blockedLocalPorts: [3230, 7300] }
      ),
    /blocked internal service port/i
  );
});
