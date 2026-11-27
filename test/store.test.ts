import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { looksLikePoisonedToolMemory } from "../src/agent/memory-extractor.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-store-test-"));
}

test("createSession and getSession", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const session = store.createSession({ title: "Test task" });

    assert.ok(session.id);
    assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(session.title, "Test task");
    assert.equal(session.status, "idle");
    assert.deepEqual(session.usage, { input: 0, output: 0 });
    assert.ok(session.createdAt);
    assert.ok(session.updatedAt);
    assert.equal(session.createdAt, session.updatedAt);

    const retrieved = store.getSession(session.id);
    assert.deepEqual(retrieved, session);

    assert.equal(store.getSession("non-existent-id"), null);
    assert.equal(store.getSession(""), null);
    assert.equal(store.getSession("../etc/passwd"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createSession default title", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const session = store.createSession();
    assert.equal(session.title, "New Session");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSession merges patch, updates timestamp, and persists atomically", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const session = store.createSession({ title: "Initial" });
    const prevUpdatedAt = session.updatedAt;

    const updated = store.updateSession(session.id, {
      status: "running",
      usage: { input: 100, output: 50 },
    });

    assert.equal(updated.id, session.id);
    assert.equal(updated.title, "Initial");
    assert.equal(updated.status, "running");
    assert.deepEqual(updated.usage, { input: 100, output: 50 });
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(prevUpdatedAt));
    assert.ok(updated.updatedAt > prevUpdatedAt);

    const reloaded = store.getSession(session.id);
    assert.deepEqual(reloaded, updated);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listSessions newest first", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const s1 = store.createSession({ title: "First" });
    const s2 = store.createSession({ title: "Second" });

    // Both sessions exist, initially s2 was created after or at s1
    let list = store.listSessions();
    assert.equal(list.length, 2);

    // Update the first session so it becomes the most recently updated
    const s1Updated = store.updateSession(s1.id, { title: "First Updated" });
    list = store.listSessions();

    assert.equal(list.length, 2);
    assert.equal(list[0].id, s1Updated.id);
    assert.equal(list[0].title, "First Updated");
    assert.equal(list[1].id, s2.id);

    // Verify updateSession monotonically increments updatedAt even within same millisecond
    assert.ok(Date.parse(list[0].updatedAt) > Date.parse(list[1].updatedAt));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listSessions ignores history, ndjson, and tmp files", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const s = store.createSession({ title: "Real session" });
    store.saveHistory(s.id, [{ role: "user" }]);
    store.appendEvent(s.id, { type: "test" });

    // Write a dummy tmp file in sessions
    const sessionsDir = path.join(dir, "sessions");
    fs.writeFileSync(path.join(sessionsDir, "dummy.tmp"), "temp");

    const list = store.listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, s.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("events append with increasing seq and survive reopen", () => {
  const dir = makeTempDir();
  try {
    const store1 = createStore(dir);
    const s = store1.createSession({ title: "Session with events" });

    const ev1: any = store1.appendEvent(s.id, { type: "user", text: "hello" });
    assert.equal(ev1.seq, 1);
    assert.equal(ev1.type, "user");
    assert.equal(ev1.text, "hello");
    assert.ok(ev1.at);

    const ev2: any = store1.appendEvent(s.id, { type: "thought", text: "thinking" });
    assert.equal(ev2.seq, 2);
    assert.equal(ev2.type, "thought");

    // Reopen store from same directory
    const store2 = createStore(dir);
    const ev3 = store2.appendEvent(s.id, { type: "answer", text: "done" });
    assert.equal(ev3.seq, 3);

    const events = store2.readEvents(s.id);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(events.map((e) => e.type), ["user", "thought", "answer"]);

    // Legacy logs with non-monotonic seq or partial trailing line must advance past max seq and not lose history
    const ndjsonPath = path.join(dir, "sessions", `${s.id}.ndjson`);
    fs.appendFileSync(
      ndjsonPath,
      JSON.stringify({ type: "assistant_text", text: "spike", seq: 42 }) +
        "\n" +
        JSON.stringify({ type: "user", text: "tail", seq: 10 }) +
        "\n{corrupted-partial-line\n",
      "utf-8"
    );
    const store3 = createStore(dir);
    const evAfter = store3.appendEvent(s.id, { type: "status", status: "done" });
    assert.equal(evAfter.seq, 43);
    const recovered = store3.readEvents(s.id);
    assert.equal(recovered.length, 6);
    assert.equal(recovered[recovered.length - 1].seq, 43);

    // Reading non-existent events returns empty array
    assert.deepEqual(store2.readEvents("non-existent-id"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history save and load", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const s = store.createSession({ title: "History test" });

    assert.deepEqual(store.loadHistory(s.id), []);

    const steps = [
      { type: "user_input", content: [{ type: "text", text: "step 1" }] },
      { type: "thought", signature: "sig" },
    ];
    store.saveHistory(s.id, steps);

    const loaded = store.loadHistory(s.id);
    assert.deepEqual(loaded, steps);

    assert.deepEqual(store.loadHistory("non-existent"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("screenshot names are zero-padded and screenshotPath returns absolute path", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const s = store.createSession();
    const png = Buffer.from([1, 2, 3, 4]);

    const fileName = store.saveScreenshot(s.id, 7, png);
    assert.equal(fileName, "0007.png");

    const fullPath = store.screenshotPath(s.id, fileName);
    assert.ok(path.isAbsolute(fullPath));
    assert.equal(fullPath, path.join(dir, "screens", s.id, "0007.png"));
    assert.deepEqual(fs.readFileSync(fullPath), png);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings read and write", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    assert.deepEqual(store.readSettings(), {});

    const patch1 = store.writeSettings({ model: "gemini-3.8-flash" });
    assert.deepEqual(patch1, { model: "gemini-3.8-flash" });
    assert.deepEqual(store.readSettings(), { model: "gemini-3.8-flash" });

    const patch2 = store.writeSettings({ theme: "dark" });
    assert.deepEqual(patch2, { model: "gemini-3.8-flash", theme: "dark" });
    assert.deepEqual(store.readSettings(), { model: "gemini-3.8-flash", theme: "dark" });

    // Backup file preserves previous known-good settings snapshot
    const settingsPath = path.join(dir, "settings.json");
    const backupPath = path.join(dir, "settings.json.bak");
    assert.equal(fs.existsSync(backupPath), true);

    // Corrupting settings.json recovers from settings.json.bak instead of wiping user settings
    store.writeSettings({
      contextCompression: { enabled: true, triggerPercent: 85, customInstruction: "keep paths" },
    });
    fs.writeFileSync(settingsPath, "{corrupted-json", "utf-8");
    const recovered = store.readSettings();
    assert.equal(recovered.theme, "dark");
    assert.equal(recovered.model, "gemini-3.8-flash");

    // Writing a new patch repairs settings.json from backup without dropping recovered keys
    const repaired = store.writeSettings({ spellcheckEnabled: false });
    assert.equal(repaired.theme, "dark");
    assert.equal(repaired.spellcheckEnabled, false);
    assert.equal(store.readSettings().theme, "dark");
    assert.equal(store.readSettings().spellcheckEnabled, false);

    // If settings.json is unreadable AND no backup exists, refuse to overwrite with only the patch
    fs.rmSync(backupPath, { force: true });
    fs.writeFileSync(settingsPath, "{unreadable", "utf-8");
    assert.throws(() => store.writeSettings({ theme: "light" }), /Refusing to overwrite unreadable settings\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("markInterrupted flips live sessions only", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);

    const sRunning = store.createSession({ title: "running" });
    store.updateSession(sRunning.id, { status: "running" });

    const sPaused = store.createSession({ title: "paused" });
    store.updateSession(sPaused.id, { status: "paused" });

    const sApproval = store.createSession({ title: "awaiting_approval" });
    store.updateSession(sApproval.id, { status: "awaiting_approval" });

    const sDone = store.createSession({ title: "done" });
    store.updateSession(sDone.id, { status: "done" });

    const sIdle = store.createSession({ title: "idle" });
    // status is already idle

    const sStopped = store.createSession({ title: "stopped" });
    store.updateSession(sStopped.id, { status: "stopped" });

    const sError = store.createSession({ title: "error" });
    store.updateSession(sError.id, { status: "error" });

    const sMax = store.createSession({ title: "max_steps" });
    store.updateSession(sMax.id, { status: "max_steps" });

    const sInterrupted = store.createSession({ title: "interrupted" });
    store.updateSession(sInterrupted.id, { status: "interrupted" });

    const flippedCount = store.markInterrupted();
    assert.equal(flippedCount, 3);

    assert.equal(store.getSession(sRunning.id)!.status, "interrupted");
    assert.equal(store.getSession(sPaused.id)!.status, "interrupted");
    assert.equal(store.getSession(sApproval.id)!.status, "interrupted");
    assert.equal(
      store.readEvents(sRunning.id).some((e) => e.type === "status" && e.status === "interrupted"),
      true
    );
    assert.equal(store.getSession(sDone.id)!.status, "done");
    assert.equal(store.getSession(sIdle.id)!.status, "idle");
    assert.equal(store.getSession(sStopped.id)!.status, "stopped");
    assert.equal(store.getSession(sError.id)!.status, "error");
    assert.equal(store.getSession(sMax.id)!.status, "max_steps");
    assert.equal(store.getSession(sInterrupted.id)!.status, "interrupted");

    // Second call should flip 0
    assert.equal(store.markInterrupted(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 3 P2-4: saveHistory compact output, eventsCache/readEventsTail, and skipUserEvent truncate alignment", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const s = store.createSession({ title: "PerfStore" });

    // Compact history output
    store.saveHistory(s.id, [
      { type: "user_input", content: [{ type: "text", text: "first turn" }] },
      { type: "model_output", content: [{ type: "text", text: "first answer" }] },
      { type: "user_input", content: [{ type: "text", text: "[Inter-Bot Handoff · From \"A\"]\nhi" }] },
      { type: "model_output", content: [{ type: "text", text: "handoff answer" }] },
      { type: "user_input", content: [{ type: "text", text: "second turn" }] },
      { type: "model_output", content: [{ type: "text", text: "second answer" }] },
    ]);
    const rawHistory = fs.readFileSync(path.join(dir, "sessions", `${s.id}.history.json`), "utf-8");
    assert.equal(rawHistory.includes("\n  "), false, "history.json should be compact");

    // Events cache + readEventsTail
    const e1 = store.appendEvent(s.id, { type: "user", text: "first turn" });
    store.appendEvent(s.id, { type: "answer", text: "first answer" });
    const e3 = store.appendEvent(s.id, { type: "user", text: "second turn" });
    store.appendEvent(s.id, { type: "answer", text: "second answer" });
    assert.equal(store.readEventsTail(s.id, 2).length, 2);
    assert.equal(store.readEventsTail(s.id, 2)[0].seq, e3.seq);

    // Truncate at second turn preserves first turn + inter-bot handoff before second turn,
    // without miscounting the inter-bot handoff step as a real user event
    const trunc = store.truncateSessionFromSeq(s.id, e3.seq);
    assert.ok(trunc);
    assert.equal(trunc.keptEvents.length, 2);
    assert.equal(trunc.keptEvents[0].seq, e1.seq);
    assert.equal(store.loadHistory(s.id).length, 4);
    assert.equal(store.readEventsTail(s.id, 10).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4 P0-2: appendEvent and saveHistory redact persisted secrets while preserving base64 image blobs", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const s = store.createSession({ title: "RedactStore" });
    const fakeKey = ["sk-", "live1234567890abcdef123456"].join("");
    const fakeProxy = "vless://uuid-1111-2222@example.net:443?type=ws#node";
    const fakeUrl = "https://sub.example.net/feed?token=secretValue9988";
    const bigB64 = "A".repeat(700);

    store.appendEvent(s.id, {
      type: "thought",
      text: `checking ${fakeKey} and ${fakeProxy} and ${fakeUrl}`,
    });
    store.appendEvent(s.id, {
      type: "answer",
      text: `Authorization Bearer secretBearerToken1234567 and {"apiKey":"myTopSecretApiKey123"}`,
    });

    const evs = store.readEvents(s.id);
    assert.equal(evs[0].text.includes(fakeKey), false);
    assert.equal(evs[0].text.includes("uuid-1111-2222"), false);
    assert.equal(evs[0].text.includes("secretValue9988"), false);
    assert.equal(evs[1].text.includes("secretBearerToken1234567"), false);
    assert.equal(evs[1].text.includes("myTopSecretApiKey123"), false);

    store.saveHistory(s.id, [
      {
        type: "user_input",
        content: [
          { type: "text", text: `hi ${fakeKey}` },
          { type: "image", data: bigB64, mime_type: "image/png" },
        ],
      },
    ]);
    const hist = store.loadHistory(s.id);
    assert.equal(hist[0].content[0].text.includes(fakeKey), false);
    assert.equal(hist[0].content[1].data, bigB64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 6 P2-6: lazy-migrates legacy 3x memory fields to single content field and blocks poisoned tool memories", () => {
  const dir = makeTempDir();
  try {
    const store = createStore(dir);
    const bot = store.createSession({ title: "LegacyMemBot" });

    // Inject raw legacy 3x memory object directly on disk
    const sessionFile = path.join(dir, "sessions", `${bot.id}.json`);
    const rawSession = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    rawSession.memories = [
      {
        id: "mem-legacy-1",
        name: "旧格式记忆",
        desc: "始终使用中文回复",
        instruction: "始终使用中文回复",
        content: "始终使用中文回复",
        enabled: true,
      },
    ];
    fs.writeFileSync(sessionFile, JSON.stringify(rawSession, null, 2));

    const settingsFile = path.join(dir, "settings.json");
    store.writeSettings({ theme: "light" });
    const rawSettings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    rawSettings.globalMemories = [
      {
        id: "gmem-legacy-1",
        name: "全局旧记忆",
        desc: "回答简洁",
        instruction: "回答简洁",
        enabled: true,
      },
    ];
    fs.writeFileSync(settingsFile, JSON.stringify(rawSettings, null, 2));

    // Reading triggers lazy migration in memory and on disk
    const loadedBot = store.getSession(bot.id)!;
    assert.deepEqual(loadedBot.memories![0], {
      id: "mem-legacy-1",
      name: "旧格式记忆",
      content: "始终使用中文回复",
      enabled: true,
    });
    const persistedBot = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    assert.equal("desc" in persistedBot.memories[0], false);
    assert.equal("instruction" in persistedBot.memories[0], false);

    const loadedSettings = store.readSettings();
    assert.deepEqual(loadedSettings.globalMemories[0], {
      id: "gmem-legacy-1",
      name: "全局旧记忆",
      content: "回答简洁",
      enabled: true,
    });

    // Anti-memory-poisoning guard catches bundled code & tool-forbidding hallucinations
    assert.equal(looksLikePoisonedToolMemory("通过 server-bundle.mjs 分析得出：不要再用 send_file 卡片"), true);
    assert.equal(looksLikePoisonedToolMemory("以后回复使用简体中文"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
