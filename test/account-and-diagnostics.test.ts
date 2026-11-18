import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";

const _UP_ONE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PROJECT_ROOT = path.basename(_UP_ONE) === "dist-server" ? path.dirname(_UP_ONE) : _UP_ONE;

test("GET /api/settings exposes OS-derived profile default and POST /api/settings persists custom profile", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-profile-"));
  const store = createStore(tmpDir);
  const srv = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      geminiApiKey: "super-secret-gemini-key-9999",
      executorToken: "super-secret-exec-token-8888",
      dataDir: tmpDir,
      writeRoots: [tmpDir],
    },
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle", activeSessions: {} }),
      subscribe: () => () => {},
    },
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as any;

  try {
    const initial = await fetch(`http://127.0.0.1:${port}/api/settings`).then(
      (r) => r.json()
    );
    assert.ok(initial.profile && typeof initial.profile.name === "string");
    assert.ok(initial.profile.name.length > 0);
    assert.notEqual(initial.profile.name, "Jokes");

    const updated = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          name: "Alex",
          color: "blue",
        },
      }),
    }).then((r) => r.json());

    assert.equal(updated.profile.name, "Alex");
    assert.equal(updated.profile.color, "blue");

    const reloaded = await fetch(`http://127.0.0.1:${port}/api/settings`).then(
      (r) => r.json()
    );
    assert.equal(reloaded.profile.name, "Alex");
    assert.equal(reloaded.profile.color, "blue");
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/system/diagnostics returns real runtime & executor status without leaking secrets", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-diag-"));
  const store = createStore(tmpDir);
  const SECRET_KEY = "AIzaSyFAKE_SECRET_DO_NOT_LEAK_123456";
  const SECRET_TOKEN = "EXEC_BEARER_DO_NOT_LEAK_654321";

  const srv = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      geminiApiKey: SECRET_KEY,
      executorToken: SECRET_TOKEN,
      executorUrl: "http://ubuntu.orb.local:7300",
      dataDir: tmpDir,
      writeRoots: [tmpDir],
    },
    store,
    executor: {
      health: async () => ({ status: "ok", display: ":1" }),
    },
    runner: {
      status: () => ({ sessionId: null, state: "idle", activeSessions: {} }),
      subscribe: () => () => {},
    },
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as any;

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/system/diagnostics`);
    assert.equal(resp.status, 200);
    const rawText = await resp.text();
    assert.ok(!rawText.includes(SECRET_KEY), "must never leak GEMINI_API_KEY");
    assert.ok(
      !rawText.includes(SECRET_TOKEN),
      "must never leak TWINKLEBOT_EXECUTOR_TOKEN"
    );

    const diag = JSON.parse(rawText);
    assert.equal(diag.geminiKeyConfigured, true);
    assert.equal(diag.executorOnline, true);
    assert.ok(typeof diag.executorLatencyMs === "number");
    assert.ok(typeof diag.nodeVersion === "string" && diag.nodeVersion.startsWith("v"));
    assert.ok(typeof diag.appVersion === "string" && diag.appVersion.length > 0);
    assert.ok(Array.isArray(diag.models) && diag.models.includes("gemini-4-carbon"));
    assert.ok(
      Array.isArray(diag.imageModels) &&
        diag.imageModels.includes("gemini-3.1-flash-image")
    );
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("public/index.html and React App remove all fake Grok/Jokes/SaaS account placeholders", async () => {
  const { renderFullAppHtml } = await import("./helpers/react-test-helpers.js");
  const html = renderFullAppHtml();
  assert.ok(!html.includes("获取移动版 Grok Bot"));
  assert.ok(!html.includes("切换账户"));
  assert.ok(!html.includes("退出登录"));
  assert.ok(!html.includes(">Jokes<"));
  assert.ok(!html.includes('title="Jokes"'));
  assert.ok(!html.includes(">Premium<"));
});
