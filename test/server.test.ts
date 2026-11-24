import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";

async function setupTestServer(options: any = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
  const store = createStore(tmpDir);
  const config = {
    host: "127.0.0.1",
    port: 0,
    geminiApiKey: "fake-key",
    executorUrl: "http://ubuntu.orb.local:7300",
    executorToken: "fake-token",
    novncUrl: "http://ubuntu.orb.local:6080/vnc.html?autoconnect=true&resize=scale",
    defaultModel: "gemini-4-argon",
    deepModel: "gemini-4-carbon",
    fastModel: "gemini-4-hydrogen",
    models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
    maxSteps: 60,
    keepScreenshots: 3,
    shellTimeoutSec: 120,
    screen: { width: 1440, height: 900 },
    writeRoots: ["/tmp"],
    dataDir: tmpDir,
    ...options.config,
  };

  const subscribers = new Set();
  let fakeActiveSessionId = options.initialSessionId ?? null;
  let fakeState = options.initialState ?? (fakeActiveSessionId ? "running" : "idle");
  const approvedCalls: any[] = [];
  const controlActions: any[] = [];

  const fakeRunner = options.runner || {
    status() {
      return { sessionId: fakeActiveSessionId, state: fakeState };
    },
    start(sessionId: string, text: string) {
      if (fakeActiveSessionId !== null) {
        throw new Error("a task is already running");
      }
      fakeActiveSessionId = sessionId;
      fakeState = "running";
    },
    stop() {
      controlActions.push("stop");
      fakeState = "idle";
      fakeActiveSessionId = null;
    },
    pause() {
      controlActions.push("pause");
      fakeState = "paused";
    },
    resume() {
      controlActions.push("resume");
      fakeState = "running";
    },
    approve(callId: string, allowed: boolean) {
      approvedCalls.push({ callId, allowed });
    },
    subscribe(fn: any) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emit(event: any) {
      for (const fn of subscribers as Set<any>) {
        try {
          fn(event);
        } catch {
          // ignore
        }
      }
    },
  };

  const server = createServer({ config, store, runner: fakeRunner });
  return new Promise<any>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        baseUrl,
        store,
        config,
        runner: fakeRunner,
        approvedCalls,
        controlActions,
        cleanup: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          fs.rmSync(tmpDir, { recursive: true, force: true });
        },
      });
    });
  });
}

test("index page is served", async () => {
  const ctx = await setupTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("TwinkleBot"), `expected body to contain TwinkleBot, got: ${body}`);
  } finally {
    await ctx.cleanup();
  }
});

test("settings rejects unknown model", async () => {
  const ctx = await setupTestServer();
  try {
    // Unknown model returns 400
    const resBad = await fetch(`${ctx.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt" }),
    });
    assert.equal(resBad.status, 400);
    const badJson = await resBad.json();
    assert.equal(badJson.error, "invalid model");

    // Known model returns 200 and updates store settings
    const resGood = await fetch(`${ctx.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-4-hydrogen" }),
    });
    assert.equal(resGood.status, 200);
    const goodJson = await resGood.json();
    assert.equal(goodJson.model, "gemini-4-hydrogen");

    // Verify stored
    assert.equal(ctx.store.readSettings().model, "gemini-4-hydrogen");

    // Legacy gemini-3.8-flash setting auto-migrates to gemini-4-hydrogen on read
    ctx.store.writeSettings({ model: "gemini-3.8-flash" });
    const migrated = await fetch(`${ctx.baseUrl}/api/settings`).then((r) => r.json());
    assert.equal(migrated.model, "gemini-4-hydrogen");
  } finally {
    await ctx.cleanup();
  }
});

test("POST /api/settings persists spellcheckEnabled, merges partial policy, and broadcasts settings_updated", async () => {
  const broadcasts: any[] = [];
  const ctx = await setupTestServer({
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      approve: () => {},
      subscribe: () => () => {},
      broadcastGlobal: (ev: any) => broadcasts.push(ev),
    },
  });
  try {
    // 1. Persist spellcheckEnabled = false and confirm GET /api/settings returns it
    const resSpell = await fetch(`${ctx.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spellcheckEnabled: false }),
    });
    assert.equal(resSpell.status, 200);
    const spellJson = await resSpell.json();
    assert.equal(spellJson.spellcheckEnabled, false);
    assert.equal(ctx.store.readSettings().spellcheckEnabled, false);
    assert.ok(
      broadcasts.some((ev) => ev?.type === "settings_updated"),
      "POST /api/settings must broadcast settings_updated"
    );

    // 2. Persist allowRules via approval endpoint, verify broadcast, then send partial policy patch
    broadcasts.length = 0;
    const resApprove = await fetch(`${ctx.baseUrl}/api/approvals/call-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allow: true,
        alwaysRule: { tool: "host_run_shell", pattern: "npm test", label: "host_run_shell npm test" },
      }),
    });
    assert.equal(resApprove.status, 200);
    assert.ok(
      broadcasts.some((ev) => ev?.type === "settings_updated"),
      "POST /api/approvals/:callId with alwaysRule must broadcast settings_updated"
    );
    assert.equal(ctx.store.readSettings().policy.allowRules.length, 1);

    // Sending partial policy { autoAudit: false } must NOT wipe existing allowRules
    const resPartialPolicy = await fetch(`${ctx.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: { autoAudit: false } }),
    });
    assert.equal(resPartialPolicy.status, 200);
    const partialJson = await resPartialPolicy.json();
    assert.equal(partialJson.policy.autoAudit, false);
    assert.equal(partialJson.policy.allowRules.length, 1);
    assert.equal(partialJson.policy.allowRules[0].pattern, "npm test");
  } finally {
    await ctx.cleanup();
  }
});

test("screens route rejects traversal", async () => {
  const ctx = await setupTestServer();
  try {
    const validUuid = "12345678-1234-1234-1234-123456789abc";

    // Path traversal attempt should 404
    const resTraversal = await fetch(`${ctx.baseUrl}/api/screens/${validUuid}/..%2F..%2F.env`);
    assert.equal(resTraversal.status, 404);

    // Non-UUID id should 404
    const resInvalidId = await fetch(`${ctx.baseUrl}/api/screens/not-a-uuid/0001.png`);
    assert.equal(resInvalidId.status, 404);

    // Non-image / invalid file name should 404
    const resInvalidFile = await fetch(`${ctx.baseUrl}/api/screens/${validUuid}/data.txt`);
    assert.equal(resInvalidFile.status, 404);

    // Non-existent image should 404
    const resMissing = await fetch(`${ctx.baseUrl}/api/screens/${validUuid}/0001.png`);
    assert.equal(resMissing.status, 404);

    // Existing screenshot returns 200 with image/png
    const pngBuffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes
    ctx.store.saveScreenshot(validUuid, 1, pngBuffer);

    const resValid = await fetch(`${ctx.baseUrl}/api/screens/${validUuid}/0001.png`);
    assert.equal(resValid.status, 200);
    assert.equal(resValid.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await resValid.arrayBuffer());
    assert.deepEqual(bytes, pngBuffer);
  } finally {
    await ctx.cleanup();
  }
});

test("message while busy returns 409", async () => {
  const ctx = await setupTestServer();
  try {
    const session = ctx.store.createSession();

    // Start a first task to make runner busy
    ctx.runner.start(session.id, "busy task");

    // Attempting another message returns 409
    const res = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "another task" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "a task is already running");
  } finally {
    await ctx.cleanup();
  }
});

test("SSE delivers runner events", async () => {
  const ctx = await setupTestServer();
  try {
    const response = await fetch(`${ctx.baseUrl}/api/events`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // First chunk usually contains ": connected\n\n"
    let buffer = "";
    const readUntil = async (condition: (b: string) => boolean) => {
      while (!condition(buffer)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil((b) => b.includes(": connected"));
    assert.ok(buffer.includes(": connected"));

    // Emit an event through the runner
    const testEvent = {
      sessionId: "test-sess-1",
      type: "thought",
      text: "hello from runner",
    };
    ctx.runner.emit(testEvent);

    await readUntil((b) => b.includes("hello from runner"));
    assert.ok(buffer.includes(`data: ${JSON.stringify(testEvent)}`));

    await reader.cancel();
  } finally {
    await ctx.cleanup();
  }
});

test("GET /api/config returns configuration and active model", async () => {
  const ctx = await setupTestServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/api/config`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.novncUrl, ctx.config.novncUrl);
    assert.deepEqual(json.models, ctx.config.models);
    assert.equal(json.model, "gemini-4-argon");
    assert.deepEqual(json.screen, { width: 1440, height: 900 });
  } finally {
    await ctx.cleanup();
  }
});

test("GET /api/sessions and POST /api/sessions", async () => {
  const ctx = await setupTestServer();
  try {
    // Create session via POST
    const resPost = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Custom Title" }),
    });
    assert.equal(resPost.status, 201);
    const created = await resPost.json();
    assert.equal(created.title, "Custom Title");
    assert.ok(created.id);

    // List sessions via GET
    const resGet = await fetch(`${ctx.baseUrl}/api/sessions`);
    assert.equal(resGet.status, 200);
    const list = await resGet.json();
    assert.ok(Array.isArray(list.sessions));
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].id, created.id);
    assert.deepEqual(list.runner, { sessionId: null, state: "idle" });
  } finally {
    await ctx.cleanup();
  }
});

test("GET /api/sessions/:id returns session and events", async () => {
  const ctx = await setupTestServer();
  try {
    const session = ctx.store.createSession({ title: "Inspect Me" });
    ctx.store.appendEvent(session.id, { type: "thought", text: "aha" });

    const res = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.session.id, session.id);
    assert.equal(json.session.title, "Inspect Me");
    assert.equal(json.events.length, 1);
    assert.equal(json.events[0].text, "aha");

    // Non-existent returns 404
    const resMissing = await fetch(`${ctx.baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000`);
    assert.equal(resMissing.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test("POST /api/sessions/:id/messages validation and success", async () => {
  const ctx = await setupTestServer();
  try {
    const session = ctx.store.createSession();

    // Missing or empty text returns 400
    const resEmpty = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(resEmpty.status, 400);

    // Missing session returns 404
    const res404 = await fetch(`${ctx.baseUrl}/api/sessions/nonexistent/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(res404.status, 404);

    // Valid message returns 202
    const resOk = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "valid message" }),
    });
    assert.equal(resOk.status, 202);
    const okJson = await resOk.json();
    assert.equal(okJson.ok, true);
    assert.equal(okJson.sessionId, session.id);
  } finally {
    await ctx.cleanup();
  }
});

test("POST /api/control validates action and delegates to runner", async () => {
  const ctx = await setupTestServer();
  try {
    // Bad action returns 400
    const resBad = await fetch(`${ctx.baseUrl}/api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "destroy" }),
    });
    assert.equal(resBad.status, 400);

    // Pause action
    const resPause = await fetch(`${ctx.baseUrl}/api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(resPause.status, 200);
    assert.ok(ctx.controlActions.includes("pause"));

    // Resume action
    const resResume = await fetch(`${ctx.baseUrl}/api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });
    assert.equal(resResume.status, 200);
    assert.ok(ctx.controlActions.includes("resume"));

    // Stop action
    const resStop = await fetch(`${ctx.baseUrl}/api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(resStop.status, 200);
    assert.ok(ctx.controlActions.includes("stop"));
  } finally {
    await ctx.cleanup();
  }
});

test("POST /api/approvals/:callId validates allow and delegates to runner", async () => {
  const ctx = await setupTestServer();
  try {
    // Bad body (missing allow boolean) returns 400
    const resBad = await fetch(`${ctx.baseUrl}/api/approvals/call-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: "yes" }),
    });
    assert.equal(resBad.status, 400);

    // Valid allow=true
    const resOk = await fetch(`${ctx.baseUrl}/api/approvals/call-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: true }),
    });
    assert.equal(resOk.status, 200);
    assert.deepEqual(ctx.approvedCalls, [{ callId: "call-1", allowed: true }]);
  } finally {
    await ctx.cleanup();
  }
});

test("static file serving and path traversal protection", async () => {
  const _upOne = path.resolve(import.meta.dirname ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url)), "..");
  const _rootDir = path.basename(_upOne) === "dist-server" ? path.dirname(_upOne) : _upOne;
  const publicDir = path.resolve(_rootDir, "public");
  const testFile = path.join(publicDir, "test-asset.txt");
  let createdPublic = false;
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
    createdPublic = true;
  }
  fs.writeFileSync(testFile, "hello static asset", "utf-8");

  const ctx = await setupTestServer();
  try {
    // Top-level /test-asset.txt
    const res1 = await fetch(`${ctx.baseUrl}/test-asset.txt`);
    assert.equal(res1.status, 200);
    assert.equal(await res1.text(), "hello static asset");

    // /public/test-asset.txt
    const res2 = await fetch(`${ctx.baseUrl}/public/test-asset.txt`);
    assert.equal(res2.status, 200);
    assert.equal(await res2.text(), "hello static asset");

    // Traversal rejection
    const resTraversal = await fetch(`${ctx.baseUrl}/public/..%2F..%2Fpackage.json`);
    assert.equal(resTraversal.status, 404);

    // Unsupported method on static route
    const resMethod = await fetch(`${ctx.baseUrl}/test-asset.txt`, { method: "DELETE" });
    assert.equal(resMethod.status, 405);
  } finally {
    await ctx.cleanup();
    try {
      fs.unlinkSync(testFile);
      if (createdPublic) {
        fs.rmdirSync(publicDir);
      }
    } catch {
      // ignore
    }
  }
});

test("POST /api/sessions/:id/errors/dismiss persists error_dismissed, broadcasts, and is idempotent", async () => {
  const broadcasted: any[] = [];
  const ctx = await setupTestServer({
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal(ev: any) {
        broadcasted.push(ev);
      },
    },
  });
  try {
    const session = ctx.store.createSession({ title: "ErrorSyncBot" });
    const errEvt = ctx.store.appendEvent(session.id, {
      type: "error",
      message: "402 API error occurred",
    });

    // 404 for unknown session
    const res404 = await fetch(`${ctx.baseUrl}/api/sessions/non-existent/errors/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: errEvt.seq }),
    });
    assert.equal(res404.status, 404);

    // 400 when neither seq nor dismissKey is supplied
    const res400 = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/errors/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res400.status, 400);

    // 200 persists error_dismissed and broadcasts to all clients
    const dismissKey = `${session.id}:${errEvt.seq}:402 API error occurred`;
    const resOk = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/errors/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: errEvt.seq, dismissKey }),
    });
    assert.equal(resOk.status, 200);
    const bodyOk: any = await resOk.json();
    assert.equal(bodyOk.ok, true);
    assert.equal(bodyOk.event?.type, "error_dismissed");
    assert.equal(bodyOk.event?.targetSeq, errEvt.seq);
    assert.equal(bodyOk.event?.dismissKey, dismissKey);

    const eventsAfterFirst = ctx.store.readEvents(session.id);
    const dismissEvents = eventsAfterFirst.filter((e: any) => e.type === "error_dismissed");
    assert.equal(dismissEvents.length, 1);
    assert.equal(dismissEvents[0].targetSeq, errEvt.seq);

    const bcast = broadcasted.find((e) => e.type === "error_dismissed");
    assert.ok(bcast, "must broadcast error_dismissed event globally");
    assert.equal(bcast.sessionId, session.id);
    assert.equal(bcast.targetSeq, errEvt.seq);
    assert.equal(bcast.seq, bodyOk.event.seq);

    // Second dismiss for same seq is idempotent (no duplicate NDJSON line, no extra broadcast)
    const countBefore = broadcasted.length;
    const resDup = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/errors/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: errEvt.seq, dismissKey }),
    });
    assert.equal(resDup.status, 200);
    const bodyDup: any = await resDup.json();
    assert.equal(bodyDup.ok, true);
    assert.equal(bodyDup.alreadyDismissed, true);
    assert.equal(
      ctx.store.readEvents(session.id).filter((e: any) => e.type === "error_dismissed").length,
      1
    );
    assert.equal(broadcasted.length, countBefore);
  } finally {
    await ctx.cleanup();
  }
});


