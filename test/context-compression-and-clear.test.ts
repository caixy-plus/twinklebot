import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";
import {
  CONTEXT_COMPRESSION_PRESETS,
  DEFAULT_CONTEXT_COMPRESSION,
  getModelContextWindow,
  matchContextCompressionPreset,
  normalizeContextCompressionSettings,
} from "../src/shared/context-compression.js";
import {
  CONTEXT_SUMMARY_PREFIX,
  applyCompressedSummary,
  buildCompressionTranscript,
  buildExtractiveFallbackSummary,
  compactToolResultText,
  compressContextHistory,
  estimateEffectiveHistoryTokens,
  estimateHistoryChars,
  estimateHistoryTokens,
  estimateTextTokens,
  extractFileOperationsFromSteps,
  isContextOverflowError,
  prepareIncrementalSummaryInput,
  resolveCompressionTokenBudgets,
  sanitizeOrphanedCalls,
  sanitizeSurrogates,
  shouldCompressContext,
  splitHistoryForCompression,
  splitHistoryForSummary,
  trimHistory,
  trimHistoryToTokenBudget,
} from "../src/agent/context.js";
import { createControl, runTask } from "../src/agent/loop.js";

test("normalizeContextCompressionSettings applies defaults, clamps percent, and migrates legacy maxContextChars", () => {
  const defaults = normalizeContextCompressionSettings(undefined);
  assert.deepEqual(defaults, DEFAULT_CONTEXT_COMPRESSION);
  assert.equal(defaults.triggerPercent, 75);

  const clamped = normalizeContextCompressionSettings({
    enabled: false,
    triggerPercent: 120,
    customInstruction: "  保留文件路径与结论  ",
  });
  assert.equal(clamped.enabled, false);
  assert.equal(clamped.triggerPercent, 95);
  assert.equal(clamped.customInstruction, "保留文件路径与结论");

  assert.equal(normalizeContextCompressionSettings({ triggerPercent: 10 }).triggerPercent, 30);
  assert.equal(normalizeContextCompressionSettings({ maxContextChars: 32000 }).triggerPercent, 50);
  assert.equal(normalizeContextCompressionSettings({ maxContextChars: 60000 }).triggerPercent, 75);
  assert.equal(normalizeContextCompressionSettings({ maxContextChars: 140000 }).triggerPercent, 85);
});

test("getModelContextWindow resolves provider-prefixed models and avoids Gemini 2x pricing tier", () => {
  assert.equal(getModelContextWindow("gemini-4-argon"), 200_000);
  assert.equal(getModelContextWindow("models/gemini-4-carbon"), 200_000);
  assert.equal(getModelContextWindow("custom::deepseek-chat"), 128_000);
  assert.equal(getModelContextWindow("openai::gpt-4o"), 128_000);
  assert.equal(getModelContextWindow("openrouter::openai/gpt-4.1-mini"), 400_000);
  assert.equal(getModelContextWindow("openai/gpt-5"), 400_000);
  assert.equal(getModelContextWindow("openai/o4-mini"), 200_000);
  assert.equal(getModelContextWindow("claude-sonnet-4"), 200_000);
  assert.equal(getModelContextWindow("custom::qwen-32k-instruct"), 32_000);
  assert.equal(getModelContextWindow("custom::qwen-turbo-1m"), 1_000_000);
  assert.equal(getModelContextWindow("local::smollm-135m"), 128_000);
  assert.equal(getModelContextWindow("local::smollm-135m-8k"), 8_000);
  assert.equal(getModelContextWindow("unknown-model"), 128_000);
});

test("shouldCompressContext triggers by context window percentage and splitHistoryForCompression preserves recent turns", () => {
  const rules = normalizeContextCompressionSettings({
    enabled: true,
    triggerPercent: 50,
  });

  const history = [
    { type: "user_input", content: [{ type: "text", text: "Turn 1 " + "alpha ".repeat(80) }] },
    { type: "text", text: "Reply 1 " + "beta ".repeat(80) },
    { type: "user_input", content: [{ type: "text", text: "Turn 2" }] },
    { type: "function_call", id: "c1", name: "run_shell", arguments: { cmd: "ls" } },
    { type: "function_result", call_id: "c1", name: "run_shell", result: "file.txt" },
    { type: "text", text: "Reply 2" },
    { type: "user_input", content: [{ type: "text", text: "Turn 3" }] },
    { type: "text", text: "Reply 3" },
  ];

  // With 400-token contextWindow @ 50% (200 tokens), Turn 1 pushes total well above budget
  assert.equal(shouldCompressContext(history, rules, { contextWindow: 400 }), true);
  assert.equal(
    shouldCompressContext(history, { ...rules, enabled: false }, { contextWindow: 400 }),
    false
  );

  const { older, recent } = splitHistoryForCompression(history, 2);
  assert.equal(older.length, 2);
  assert.equal(recent.length, 6);
  assert.equal(recent[0].content[0].text, "Turn 2");

  const transcript = buildCompressionTranscript(older);
  assert.match(transcript, /User: Turn 1/);
  assert.match(transcript, /Assistant: Reply 1/);

  const merged = applyCompressedSummary("用户询问了 Turn 1，已回复 Reply 1", recent);
  assert.equal(merged.length, recent.length + 1);
  assert.ok(merged[0].content[0].text.startsWith(CONTEXT_SUMMARY_PREFIX));
});

test("trimHistory respects compactToolOutputChars and estimateHistoryChars counts text", () => {
  const longOutput = "x".repeat(1200);
  const history = [
    { type: "user_input", content: [{ type: "text", text: "Turn 1" }] },
    { type: "function_call", id: "c1", name: "run_shell", arguments: { cmd: "cat a" } },
    { type: "function_result", call_id: "c1", name: "run_shell", result: longOutput },
    { type: "user_input", content: [{ type: "text", text: "Turn 2" }] },
    { type: "text", text: "Done" },
  ];
  assert.ok(estimateHistoryChars(history) > 1200);
  const trimmed = trimHistory(history, 24, { compactToolOutputChars: 300 });
  const resultStep = trimmed.find((s) => s.type === "function_result");
  assert.ok(resultStep);
  assert.ok(resultStep.result.length < 300);
  assert.match(resultStep.result, /omitted earlier tool output/);
});

test("store.clearSession clears history, events, and screenshots while preserving bot metadata", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-session-store-"));
  const store = createStore(tmpDir);
  const admin = store.ensureAdminBot();
  store.appendEvent(admin.id, { type: "user", text: "hello" });
  store.saveHistory(admin.id, [{ type: "user_input", content: [{ type: "text", text: "hello" }] }]);
  store.saveScreenshot(admin.id, 1, Buffer.from([1, 2, 3]));
  store.updateSession(admin.id, {
    lastMessagePreview: "hello",
    stepCount: 5,
    unreadCount: 2,
  });

  const cleared = store.clearSession(admin.id);
  assert.ok(cleared);
  assert.equal(cleared.isAdmin, true);
  assert.equal(cleared.title, admin.title);
  assert.equal(cleared.status, "idle");
  assert.equal(cleared.lastMessagePreview, "");
  assert.equal(cleared.stepCount, 0);
  assert.equal(cleared.unreadCount, 0);
  assert.deepEqual(store.readEvents(admin.id), []);
  assert.deepEqual(store.loadHistory(admin.id), []);
  assert.deepEqual(store.listScreenshots(admin.id), []);
});

test("HTTP POST /api/settings persists contextCompression and POST /api/sessions/:id/clear clears session", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-session-http-"));
  const store = createStore(tmpDir);
  const session = store.createSession({ title: "测试 Bot" });
  store.appendEvent(session.id, { type: "user", text: "hi" });
  store.saveHistory(session.id, [{ type: "user_input", content: [{ type: "text", text: "hi" }] }]);

  const broadcasts: any[] = [];
  const stopped: string[] = [];
  const fakeRunner = {
    status: () => ({ sessionId: null, state: "idle" }),
    stop: (id: string) => {
      stopped.push(id);
      return true;
    },
    subscribe: () => () => {},
    broadcastGlobal: (ev: any) => broadcasts.push(ev),
    activeMap: {},
  };

  const srv = createServer({
    store,
    runner: fakeRunner as any,
    config: {
      host: "127.0.0.1",
      port: 0,
      geminiApiKey: "fake-key",
      executorUrl: "http://127.0.0.1:7300",
      executorToken: "fake-token",
      novncUrl: "",
      defaultModel: "gemini-4-argon",
      deepModel: "gemini-4-carbon",
      fastModel: "gemini-4-hydrogen",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
      maxSteps: 60,
      keepScreenshots: 3,
      shellTimeoutSec: 120,
      screen: { width: 1440, height: 900 },
      writeRoots: [tmpDir],
      dataDir: tmpDir,
    },
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address() as any;
  const port = addr.port;
  try {
    const saveRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contextCompression: {
          enabled: true,
          triggerPercent: 60,
          customInstruction: "保留命令结论",
        },
      }),
    });
    assert.equal(saveRes.status, 200);
    const saved = await saveRes.json();
    assert.equal(saved.contextCompression.enabled, true);
    assert.equal(saved.contextCompression.triggerPercent, 60);
    assert.equal(saved.contextCompression.customInstruction, "保留命令结论");

    const clearRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/clear`, {
      method: "POST",
    });
    assert.equal(clearRes.status, 200);
    const clearJson = await clearRes.json();
    assert.equal(clearJson.ok, true);
    assert.equal(clearJson.session.id, session.id);
    assert.deepEqual(store.readEvents(session.id), []);
    assert.deepEqual(store.loadHistory(session.id), []);
    assert.ok(stopped.includes(session.id));
    assert.ok(broadcasts.some((e) => e.type === "session_cleared" && e.sessionId === session.id));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("POST /api/sessions/:id/edit-message truncates subsequent events/history and re-sends edited text", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-message-http-"));
  const store = createStore(tmpDir);
  const session = store.createSession({ title: "编辑重发测试" });
  const u1 = store.appendEvent(session.id, { type: "user", text: "第一句" });
  store.appendEvent(session.id, { type: "assistant", text: "回复一" });
  const u2 = store.appendEvent(session.id, {
    type: "user",
    text: "第二句",
    quotes: ["引用片段"],
  });
  store.appendEvent(session.id, { type: "assistant", text: "回复二" });

  store.saveHistory(session.id, [
    { type: "user_input", content: [{ type: "text", text: "第一句" }] },
    { type: "text", text: "回复一" },
    { type: "user_input", content: [{ type: "text", text: "第二句" }] },
    { type: "text", text: "回复二" },
  ]);

  const broadcasts: any[] = [];
  const enqueued: any[] = [];
  const fakeRunner = {
    status: () => ({ sessionId: null, state: "idle" }),
    stop: () => true,
    enqueue: (sid: string, text: string, meta: any) => {
      enqueued.push({ sid, text, meta });
      return { queued: false, steered: false, queueLength: 0 };
    },
    subscribe: () => () => {},
    broadcastGlobal: (ev: any) => broadcasts.push(ev),
    activeMap: {},
  };

  const srv = createServer({
    store,
    runner: fakeRunner as any,
    config: {
      host: "127.0.0.1",
      port: 0,
      geminiApiKey: "fake-key",
      executorUrl: "http://127.0.0.1:7300",
      executorToken: "fake-token",
      novncUrl: "",
      defaultModel: "gemini-4-argon",
      deepModel: "gemini-4-carbon",
      fastModel: "gemini-4-hydrogen",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
      maxSteps: 60,
      keepScreenshots: 3,
      shellTimeoutSec: 120,
      screen: { width: 1440, height: 900 },
      writeRoots: [tmpDir],
      dataDir: tmpDir,
    },
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/edit-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: u2.seq, text: "修改后的第二句" }),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.rewoundToSeq, u2.seq);

    const remainingEvents = store.readEvents(session.id);
    assert.equal(remainingEvents.length, 2);
    assert.equal(remainingEvents[0].seq, u1.seq);
    assert.equal(remainingEvents[1].text, "回复一");

    const remainingHistory = store.loadHistory(session.id);
    assert.equal(remainingHistory.length, 2);
    assert.equal(remainingHistory[0].content[0].text, "第一句");
    assert.equal(remainingHistory[1].text, "回复一");

    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].text, "修改后的第二句");
    assert.deepEqual(enqueued[0].meta?.quotes, ["引用片段"]);
    assert.ok(broadcasts.some((b) => b.type === "session_rewound" && b.sessionId === session.id));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("CONTEXT_COMPRESSION_PRESETS and matchContextCompressionPreset map presets and custom edits cleanly", () => {
  assert.equal(CONTEXT_COMPRESSION_PRESETS.length, 3);
  assert.equal(matchContextCompressionPreset(DEFAULT_CONTEXT_COMPRESSION), "balanced");
  const compactPreset = CONTEXT_COMPRESSION_PRESETS.find((p) => p.id === "compact")!;
  assert.equal(matchContextCompressionPreset({ enabled: true, ...compactPreset.values }), "compact");
  const longPreset = CONTEXT_COMPRESSION_PRESETS.find((p) => p.id === "long")!;
  assert.equal(matchContextCompressionPreset({ enabled: false, ...longPreset.values }), "long");
  assert.equal(
    matchContextCompressionPreset({ ...DEFAULT_CONTEXT_COMPRESSION, customInstruction: "保留命令" }),
    "balanced"
  );
  assert.equal(
    matchContextCompressionPreset({ ...DEFAULT_CONTEXT_COMPRESSION, triggerPercent: 60 }),
    "custom"
  );
});

test("sanitizeOrphanedCalls drops both unpaired function_call and unpaired function_result", () => {
  const input = [
    { type: "user_input", content: [{ type: "text", text: "Turn 1" }] },
    { type: "function_call", id: "orphan_call", name: "run_shell", arguments: {} },
    { type: "function_result", call_id: "orphan_result", name: "run_shell", result: "stale" },
    { type: "function_call", id: "paired_1", name: "run_shell", arguments: {} },
    { type: "function_result", call_id: "paired_1", name: "run_shell", result: "ok" },
  ];
  const out = sanitizeOrphanedCalls(input);
  assert.equal(out.length, 3);
  assert.equal(out.some((s) => s.id === "orphan_call"), false);
  assert.equal(out.some((s) => s.call_id === "orphan_result"), false);
  assert.equal(out.some((s) => s.id === "paired_1"), true);
  assert.equal(out.some((s) => s.call_id === "paired_1"), true);
});

test("buildCompressionTranscript extracts model_output replies and PriorSummary markers", () => {
  const older = [
    {
      type: "user_input",
      content: [{ type: "text", text: `${CONTEXT_SUMMARY_PREFIX}\n早期摘要：已修复构建` }],
    },
    { type: "user_input", content: [{ type: "text", text: "回车还有个问题没发现吗" }] },
    {
      type: "model_output",
      content: [{ type: "text", text: "手机端点击发送后键盘收起，而且 Enter 无法换行。" }],
    },
  ];
  const transcript = buildCompressionTranscript(older);
  assert.match(transcript, /PriorSummary:/);
  assert.match(transcript, /User: 回车还有个问题没发现吗/);
  assert.match(transcript, /Assistant: 手机端点击发送后键盘收起/);
});

test("trimHistory never wipes all prior turns down to 1 step on tool-heavy 63-step history", () => {
  // Reproduce 8 turns / 63+ steps where turn 7 alone has >20 tool pairs + current user prompt at step 62
  const history: any[] = [];
  for (let t = 1; t <= 6; t++) {
    history.push({ type: "user_input", content: [{ type: "text", text: `历史第 ${t} 轮请求` }] });
    history.push({ type: "thought", signature: `sig-${t}`, summary: [{ type: "text", text: "thinking" }] });
    history.push({ type: "model_output", content: [{ type: "text", text: `历史第 ${t} 轮回复` }] });
  }
  history.push({ type: "user_input", content: [{ type: "text", text: "除了回车的问题还有个问题没发现吗" }] });
  for (let i = 0; i < 22; i++) {
    history.push({ type: "function_call", id: `c_${i}`, name: "run_shell", arguments: { i } });
    history.push({ type: "function_result", call_id: `c_${i}`, name: "run_shell", result: `out_${i}` });
  }
  history.push({
    type: "model_output",
    content: [{ type: "text", text: "发现两个问题：1. 手机软键盘换行被当成发送；2. 上下文压缩把前面忘光。" }],
  });
  history.push({ type: "user_input", content: [{ type: "text", text: "那就用opencode改" }] });

  assert.ok(history.length > 48);
  const trimmed = trimHistory(history, 48, { compactToolOutputChars: 1500 });
  assert.ok(trimmed.length <= 48);
  assert.ok(trimmed.length > 10, `expected prior turn context preserved, got ${trimmed.length} steps`);
  const allText = JSON.stringify(trimmed);
  assert.match(allText, /除了回车的问题还有个问题没发现吗/);
  assert.match(allText, /发现两个问题/);
  assert.match(allText, /那就用opencode改/);
});

test("compressContextHistory adaptively splits history by token budget and runs LLM summary", async () => {
  const rules = normalizeContextCompressionSettings({
    enabled: true,
    triggerPercent: 50,
  });

  const history: any[] = [];
  for (let t = 1; t <= 4; t++) {
    history.push({ type: "user_input", content: [{ type: "text", text: `第 ${t} 轮问题：检查构建与移动端问题` }] });
    history.push({ type: "function_call", id: `call_${t}`, name: "run_shell", arguments: { t } });
    history.push({ type: "function_result", call_id: `call_${t}`, name: "run_shell", result: `result_${t} ` + "log line ".repeat(50) });
    history.push({ type: "model_output", content: [{ type: "text", text: `第 ${t} 轮结论：已定位细节 ${t}` }] });
  }
  history.push({ type: "user_input", content: [{ type: "text", text: "除了回车的问题还有个问题没发现吗" }] });
  for (let i = 0; i < 3; i++) {
    history.push({ type: "function_call", id: `lat_${i}`, name: "read_file", arguments: { i } });
    history.push({ type: "function_result", call_id: `lat_${i}`, name: "read_file", result: `file_${i}` });
  }
  history.push({ type: "model_output", content: [{ type: "text", text: "还存在输入法换行与长上下文丢失问题。" }] });

  const adaptive = splitHistoryForSummary(history, rules, { contextWindow: 800 });
  assert.ok(adaptive.older.length > 0);
  assert.ok(adaptive.recent.length > 0);

  let capturedTranscript = "";
  const result = await compressContextHistory(history, rules, {
    contextWindow: 800,
    summarize: async (transcript) => {
      capturedTranscript = transcript;
      return "核心目标：修复移动端软键盘换行与上下文压缩丢记忆；已确认结论 1..4。";
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.strategy, "summary");
  assert.match(capturedTranscript, /Assistant: 第 1 轮结论：已定位细节 1/);
  assert.ok(result.history[0].content[0].text.startsWith(CONTEXT_SUMMARY_PREFIX));
  assert.ok(result.afterTokens < result.beforeTokens);
  assert.match(JSON.stringify(result.history), /除了回车的问题还有个问题没发现吗/);
});

test("compactToolResultText preserves both header and trailing errors strictly below limit", () => {
  const middleNoise = "INFO building chunk...\n".repeat(80);
  const rawOutput = `[build-start] Compiling src/agent/context.ts\n${middleNoise}FATAL: Error: EADDRINUSE: address already in use 127.0.0.1:3230\nExit code: 1`;
  const compacted = compactToolResultText(rawOutput, 300);
  assert.ok(compacted.length < 300, `expected < 300 chars, got ${compacted.length}`);
  assert.match(compacted, /\[build-start\] Compiling src\/agent\/context\.ts/);
  assert.match(compacted, /EADDRINUSE: address already in use 127\.0\.0\.1:3230/);
  assert.match(compacted, /\.\.\.\[omitted earlier tool output: \d+ chars\]\.\.\./);
  // Idempotent on already-folded outputs
  assert.equal(compactToolResultText(compacted, 300), compacted);
});

test("shouldCompressContext ignores prior-turn thoughts and caps in-turn hysteresis safely below 92% window", () => {
  const rules = normalizeContextCompressionSettings({
    enabled: true,
    triggerPercent: 85,
  });
  // contextWindow = 1000 => base trigger = 850 tokens; 85% * 1.15 = 978 capped at 92% = 920 tokens
  const budgets = resolveCompressionTokenBudgets(rules, { contextWindow: 1000, inTurnStep: true });
  assert.equal(budgets.triggerTokens, 850);
  assert.equal(budgets.effectiveTriggerTokens, 920);

  // Build ~600 tokens of history plus bulky prior-turn thoughts (~300 tokens)
  const historyWithOldThoughts: any[] = [
    { type: "user_input", content: [{ type: "text", text: "turn 1" }] },
    { type: "thought", signature: "old-1", text: "verbose prior reasoning ".repeat(50) },
    { type: "model_output", content: [{ type: "text", text: "word ".repeat(350) }] },
    { type: "user_input", content: [{ type: "text", text: "turn 2" }] },
  ];

  // Prior-turn thoughts are excluded from effective tokens
  const effTokens = estimateEffectiveHistoryTokens(historyWithOldThoughts);
  assert.ok(effTokens < 850, `expected < 850 effective tokens, got ${effTokens}`);
  assert.equal(shouldCompressContext(historyWithOldThoughts, rules, { contextWindow: 1000 }), false);

  // Add active-turn tokens to sit between 850 and 920 -> triggers at turn start, defers mid-turn
  const midTurnHistory = [
    ...historyWithOldThoughts,
    { type: "function_call", id: "c1", name: "run_shell", arguments: {} },
    { type: "function_result", call_id: "c1", name: "run_shell", result: "chunk ".repeat(220) },
  ];
  const midTokens = estimateEffectiveHistoryTokens(midTurnHistory);
  assert.ok(midTokens > 850 && midTokens <= 920, `expected 850 < ${midTokens} <= 920`);
  assert.equal(
    shouldCompressContext(midTurnHistory, rules, { contextWindow: 1000, inTurnStep: false }),
    true
  );
  assert.equal(
    shouldCompressContext(midTurnHistory, rules, { contextWindow: 1000, inTurnStep: true }),
    false
  );
});

test("prepareIncrementalSummaryInput & compressContextHistory merge prior summary with new delta turns", async () => {
  const rules = normalizeContextCompressionSettings({
    enabled: true,
    triggerPercent: 50,
  });

  const history = [
    {
      type: "user_input",
      content: [
        {
          type: "text",
          text: `${CONTEXT_SUMMARY_PREFIX}\n以下是较早对话的自动压缩摘要，请将其作为背景上下文继续当前任务：\n【核心目标与约束】端口固定为 3230；不可修改 .env。`,
        },
      ],
    },
    { type: "user_input", content: [{ type: "text", text: "检查 src/agent/context.ts 编译是否正常" }] },
    { type: "function_call", id: "f1", name: "run_shell", arguments: { cmd: "npm run typecheck" } },
    { type: "function_result", call_id: "f1", name: "run_shell", result: "typecheck passed " + "ok ".repeat(250) },
    { type: "model_output", content: [{ type: "text", text: "已通过类型检查，无报错。" }] },
    { type: "user_input", content: [{ type: "text", text: "补一下 Android 测试" }] },
    { type: "model_output", content: [{ type: "text", text: "正在准备构建 APK。" }] },
    { type: "user_input", content: [{ type: "text", text: "顺便检查 test/mobile-ui-contract.test.ts" }] },
    { type: "function_call", id: "f2", name: "run_shell", arguments: { cmd: "npm test" } },
    { type: "function_result", call_id: "f2", name: "run_shell", result: "305 passed" },
    { type: "user_input", content: [{ type: "text", text: "总结全部状态" }] },
  ];

  let capturedMeta: { priorSummary: string; deltaTranscript: string } | undefined;
  const res = await compressContextHistory(history, rules, {
    contextWindow: 600,
    summarize: async (_transcript, meta) => {
      capturedMeta = meta;
      return "【核心目标与约束】端口 3230。\n【已完成结论】typecheck 与 305 项测试均通过。";
    },
  });

  assert.equal(res.changed, true);
  assert.equal(res.mode, "summary");
  assert.ok(capturedMeta?.priorSummary.includes("端口固定为 3230"));
  assert.ok(capturedMeta?.deltaTranscript.includes("检查 src/agent/context.ts"));
  assert.equal(capturedMeta?.deltaTranscript.includes(CONTEXT_SUMMARY_PREFIX), false);
  assert.ok(res.beforeTokens > 0);
  assert.ok(res.afterTokens > 0 && res.afterTokens <= res.beforeTokens);
});

test("compressContextHistory falls back to zero-LLM extractive archive when summarize fails", async () => {
  const older = [
    { type: "user_input", content: [{ type: "text", text: "先排查 src/agent/loop.ts 的摘要触发" }] },
    { type: "function_call", id: "c1", name: "host_run_shell", arguments: { cmd: "rg summarize src/agent/loop.ts" } },
    { type: "function_result", call_id: "c1", name: "host_run_shell", result: "matched line 845 " + "detail ".repeat(120) },
    { type: "model_output", content: [{ type: "text", text: "已确认 src/agent/loop.ts 错误调用了 runStep。" }] },
  ];
  const fallbackText = buildExtractiveFallbackSummary(older);
  assert.match(fallbackText, /先排查 src\/agent\/loop\.ts 的摘要触发/);
  assert.match(fallbackText, /已确认 src\/agent\/loop\.ts 错误调用了 runStep/);
  assert.match(fallbackText, /host_run_shell/);

  const full = [
    ...older,
    { type: "user_input", content: [{ type: "text", text: "现在修复它" }] },
    { type: "function_call", id: "c2", name: "run_shell", arguments: {} },
    { type: "function_result", call_id: "c2", name: "run_shell", result: "done" },
    { type: "model_output", content: [{ type: "text", text: "已修复为 summarizeTurn。" }] },
    { type: "user_input", content: [{ type: "text", text: "继续验证" }] },
  ];
  const rules = normalizeContextCompressionSettings({
    enabled: true,
    triggerPercent: 50,
  });

  const res = await compressContextHistory(full, rules, {
    contextWindow: 400,
    summarize: async () => {
      throw new Error("network timeout");
    },
  });
  assert.equal(res.changed, true);
  assert.equal(res.mode, "extractive-trim");
  assert.equal(res.strategy, "trim");
  assert.ok(res.history[0].content[0].text.startsWith(CONTEXT_SUMMARY_PREFIX));
  assert.match(res.history[0].content[0].text, /先排查 src\/agent\/loop\.ts 的摘要触发/);
  assert.ok(estimateHistoryTokens(res.history) > 0);
});

test("runTask invokes model.summarizeTurn (not non-existent runStep) with tier fast model and emits usage", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-summary-v2-"));
  const store = createStore(tmpDir);
  const session = store.createSession({ title: "摘要端到端测试" });
  store.writeSettings({
    contextCompression: {
      enabled: true,
      triggerPercent: 50,
    },
    routing: {
      smartRouter: false,
      tiers: {
        fast: { providerId: "custom", model: "deepseek-chat" },
        medium: { providerId: "custom", model: "deepseek-chat" },
      },
    },
  });

  // Pre-seed bulky multi-turn history so total tokens exceed 50% of 8K context window
  store.saveHistory(session.id, [
    { type: "user_input", content: [{ type: "text", text: "第1步需求：端口设为 3230，并且排查一下多平台打包脚本与安卓端长文本输入表现。" }] },
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text:
            "收到，端口为 3230。详细排查日志如下：\n" +
            "checked scripts/build-web.mjs and executor/executor.py ok; ".repeat(80),
        },
      ],
    },
    { type: "user_input", content: [{ type: "text", text: "第2步需求：保留 test/context.test.ts 并检查构建产物的详细校验日志。" }] },
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "已记录 test/context.test.ts。\n" + "verified package integrity chunk; ".repeat(80),
        },
      ],
    },
    { type: "user_input", content: [{ type: "text", text: "第3步：继续" }] },
    { type: "model_output", content: [{ type: "text", text: "好的。" }] },
  ]);

  const events: any[] = [];
  const summarizeCalls: any[] = [];
  const nextTurnCalls: any[] = [];

  // Realistic ModelAdapter WITHOUT runStep — only summarizeTurn + nextTurn
  const model = {
    async summarizeTurn(opts: any) {
      summarizeCalls.push(opts);
      return {
        text: "【核心目标与约束】端口固定 3230；保留 test/context.test.ts。",
        usage: { input: 320, output: 48, cached: 0 },
        usedModel: opts.model,
      };
    },
    async nextTurn(opts: any) {
      nextTurnCalls.push(opts);
      return {
        thoughts: [],
        text: "我记得端口 3230 与 test/context.test.ts。",
        calls: [],
        outputSteps: [{ type: "model_output", content: [{ type: "text", text: "我记得端口 3230 与 test/context.test.ts。" }] }],
        usage: { input: 200, output: 20, cached: 120 },
        usedModel: opts.model,
      };
    },
  };

  try {
    const out = await runTask({
      userText: "现在还记得前面说的端口和文件吗",
      sessionId: session.id,
      deps: {
        store,
        model: model as any,
        executor: {
          async call() {
            return {
              png_base64: Buffer.from("mock-png").toString("base64"),
              width: 1440,
              height: 900,
            };
          },
        } as any,
        config: {
          defaultModel: "gemini-4-argon",
          fastModel: "gemini-4-hydrogen",
          contextWindow: 8000,
          maxSteps: 3,
          settleMs: 0,
        },
        emit: (e: any) => events.push(e),
      },
      ctrl: createControl(),
      autoRoute: false,
    });

    assert.equal(out.status, "done");
    const ctxSummarizeCalls = summarizeCalls.filter((c) =>
      String(c.systemInstruction || "").includes("context compression assistant")
    );
    assert.equal(ctxSummarizeCalls.length, 1, "expected loop to invoke model.summarizeTurn for context compression");
    assert.equal(ctxSummarizeCalls[0].model, "custom::deepseek-chat");
    const compEvt = events.find((e) => e.type === "context_compressed");
    assert.ok(compEvt);
    assert.equal(compEvt.strategy, "summary");
    assert.equal(compEvt.mode, "summary");
    assert.ok(typeof compEvt.beforeTokens === "number" && compEvt.afterTokens < compEvt.beforeTokens);
    const sumUsage = events.find((e) => e.type === "usage" && e.routeTier === "summary");
    assert.ok(sumUsage);
    assert.equal(sumUsage.model, "custom::deepseek-chat");
    assert.equal(nextTurnCalls.length, 1);
    assert.ok(nextTurnCalls[0].input[0].content[0].text.startsWith(CONTEXT_SUMMARY_PREFIX));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("estimateTextTokens weights dense JSON symbols and trimHistoryToTokenBudget trims mega-turns cleanly in O(N)", () => {
  const prose = "a".repeat(200);
  const denseJson = '{"k":1,"v":[2,3]}'.repeat(12); // ~204 chars rich in JSON punctuation/digits
  assert.ok(
    estimateTextTokens(denseJson) > estimateTextTokens(prose),
    "dense JSON must estimate higher token density than plain ASCII letters"
  );

  const megaTurn: any[] = [
    { type: "user_input", content: [{ type: "text", text: "Run 120 checks" }] },
  ];
  for (let i = 0; i < 120; i++) {
    megaTurn.push({
      type: "function_call",
      id: `call_${i}`,
      name: "run_shell",
      arguments: { cmd: `check_${i}` },
    });
    megaTurn.push({
      type: "function_result",
      call_id: `call_${i}`,
      name: "run_shell",
      result: `status=${i}; ` + "detail ".repeat(30),
    });
  }

  const trimmed = trimHistoryToTokenBudget(megaTurn, 600);
  assert.ok(estimateEffectiveHistoryTokens(trimmed) <= 600);
  assert.equal(trimmed.length, sanitizeOrphanedCalls(trimmed).length, "must leave zero orphaned tool calls");
  assert.equal(trimmed[0].type, "user_input");
});

test("runTask calibrates compression budget using real API usage.input across turns", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-usage-calibration-"));
  const store = createStore(tmpDir);
  store.writeSettings({
    contextCompression: {
      enabled: true,
      triggerPercent: 60,
      customInstruction: "",
    },
  });
  const session = store.createSession({ title: "Usage 校准测试" });

  let ctxSummarizeCount = 0;
  const events: any[] = [];
  const model = {
    async summarizeTurn(opts: any) {
      if (String(opts?.systemInstruction || "").includes("context compression assistant")) {
        ctxSummarizeCount += 1;
      }
      return {
        thoughts: [],
        text: "【核心目标与约束】已完成首轮校准",
        calls: [],
        outputSteps: [],
        usage: { input: 100, output: 30 },
        usedModel: "gemini-4-hydrogen",
      };
    },
    async nextTurn(opts: any) {
      return {
        thoughts: [],
        text: "收到，这是回复内容 " + "payload ".repeat(60),
        calls: [],
        outputSteps: [
          {
            type: "model_output",
            content: [{ type: "text", text: "收到，这是回复内容 " + "payload ".repeat(60) }],
          },
        ],
        // Simulate real tokenizer counting ~2x more input tokens than local heuristic
        usage: { input: 15_000, output: 120 },
        usedModel: opts.model,
      };
    },
  };

  const deps = {
    store,
    model: model as any,
    executor: {
      async call() {
        return {
          png_base64: Buffer.from("mock-png").toString("base64"),
          width: 1440,
          height: 900,
        };
      },
    } as any,
    config: {
      defaultModel: "gemini-4-argon",
      fastModel: "gemini-4-hydrogen",
      // 20,000 window @ 60% = 12,000 trigger tokens.
      // Local heuristic (~7k–8.5k) stays below 12,000 on both turns,
      // so Turn 2 only compresses thanks to Turn 1's API usage.input calibration.
      contextWindow: 20_000,
      maxSteps: 2,
      settleMs: 0,
    },
    emit: (e: any) => events.push(e),
  };

  try {
    await runTask({
      userText: "第一轮输入 " + "context ".repeat(60),
      sessionId: session.id,
      deps,
      ctrl: createControl(),
      autoRoute: false,
    });
    assert.equal(ctxSummarizeCount, 0, "first turn starts fresh before API usage arrives");

    await runTask({
      userText: "第二轮输入 " + "context ".repeat(60),
      sessionId: session.id,
      deps,
      ctrl: createControl(),
      autoRoute: false,
    });
    assert.equal(
      ctxSummarizeCount,
      1,
      "second turn must trigger summary compression once calibrated with turn 1 API usage.input"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("trimHistory preserves recent tool calls/results at the tail of a long active turn instead of leaving orphaned narration", () => {
  const history: any[] = [
    { type: "user_input", content: [{ type: "text", text: "请检测并初始化当前系统的 Bot 电脑环境" }] },
  ];
  for (let i = 0; i < 18; i++) {
    history.push({ type: "thought", signature: `sig-${i}`, summary: [{ type: "text", text: `step ${i}` }] });
    history.push({ type: "model_output", content: [{ type: "text", text: `正在执行第 ${i} 步探测…` }] });
    history.push({ type: "function_call", id: `call_${i}`, name: "host_run_shell", arguments: { step: i } });
    history.push({ type: "function_result", call_id: `call_${i}`, name: "host_run_shell", result: `result_${i}` });
  }

  const trimmed = trimHistory(history, 24, { compactToolOutputChars: 800 });
  assert.ok(trimmed.length <= 24, `expected <= 24 steps, got ${trimmed.length}`);
  assert.equal(trimmed[0].type, "user_input");
  // The immediate recent tool call & result (step 17) must remain intact so the model never loops in amnesia
  assert.ok(trimmed.some((s) => s.type === "function_call" && s.id === "call_17"));
  assert.ok(trimmed.some((s) => s.type === "function_result" && s.call_id === "call_17"));
});

test("sanitizeOrphanedCalls pairs calls 1-to-1 even when call IDs repeat across turns and drops empty IDs", () => {
  const input = [
    { type: "user_input", content: [{ type: "text", text: "Turn 1" }] },
    { type: "function_call", id: "call_1", name: "run_shell", arguments: {} },
    { type: "function_result", call_id: "call_1", name: "run_shell", result: "ok" },
    { type: "user_input", content: [{ type: "text", text: "Turn 2" }] },
    { type: "function_call", id: "call_1", name: "run_shell", arguments: {} },
    { type: "function_call", id: "", name: "run_shell", arguments: {} },
    { type: "function_result", call_id: "", name: "run_shell", result: "bad" },
  ];
  const out = sanitizeOrphanedCalls(input);
  assert.equal(out.filter((s) => s.type === "function_call").length, 1);
  assert.equal(out.filter((s) => s.type === "function_result").length, 1);
  assert.equal(out[1].id, "call_1");
  assert.equal(out[2].call_id, "call_1");
});

test("isContextOverflowError distinguishes prompt-size overflow from 429 rate-limit errors", () => {
  assert.equal(isContextOverflowError(new Error("This model's maximum context length is 128000 tokens")), true);
  assert.equal(isContextOverflowError(new Error("prompt is too long: 213462 tokens > 200000 maximum")), true);
  assert.equal(isContextOverflowError(Object.assign(new Error("Payload Too Large"), { status: 413 })), true);
  assert.equal(isContextOverflowError(Object.assign(new Error("Rate limit exceeded: too many requests"), { status: 429 })), false);
  assert.equal(isContextOverflowError(new Error("Request rate limit exceeded, please retry later")), false);
  assert.equal(isContextOverflowError(new Error("The operation was aborted due to timeout")), false);
});

test("extractFileOperationsFromSteps and compressContextHistory preserve read/modified file ledger across compactions", async () => {
  const olderHistory: any[] = [
    { type: "user_input", content: [{ type: "text", text: "读取并修改配置文件" }] },
    { type: "function_call", id: "fc1", name: "host_read_file", arguments: { path: "C:\\proj\\README.md" } },
    { type: "function_result", call_id: "fc1", name: "host_read_file", result: "readme " + "x".repeat(400) },
    { type: "function_call", id: "fc2", name: "host_write_file", arguments: { path: "C:\\proj\\src\\index.ts", content: "ok" } },
    { type: "function_result", call_id: "fc2", name: "host_write_file", result: "written" },
    { type: "model_output", content: [{ type: "text", text: "已更新 index.ts" }] },
    { type: "user_input", content: [{ type: "text", text: "继续下一步" }] },
  ];

  const ops = extractFileOperationsFromSteps(olderHistory);
  assert.deepEqual(ops.modifiedFiles, ["C:\\proj\\src\\index.ts"]);
  assert.deepEqual(ops.readFiles, ["C:\\proj\\README.md"]);

  const compressed = await compressContextHistory(
    olderHistory,
    { enabled: true, triggerPercent: 50, customInstruction: "" },
    {
      force: true,
      contextWindow: 1000,
      summarize: async () => "【核心目标与约束】更新项目配置。",
    }
  );
  assert.equal(compressed.changed, true);
  const summaryText = compressed.history[0]?.content?.[0]?.text || "";
  assert.match(summaryText, /\[File Operations\]/);
  assert.match(summaryText, /Modified files: C:\\proj\\src\\index\.ts/);
  assert.match(summaryText, /Read files: C:\\proj\\README\.md/);

  // Verify backward compatibility when extracting file ops from legacy Chinese summaries
  const legacyOps = extractFileOperationsFromSteps([
    {
      type: "user_input",
      content: [
        {
          type: "text",
          text: "[自动上下文压缩摘要]\n[文件操作记录]\n已修改文件：C:\\proj\\legacy.ts\n已读取文件：C:\\proj\\old.md",
        },
      ],
    },
  ]);
  assert.deepEqual(legacyOps.modifiedFiles, ["C:\\proj\\legacy.ts"]);
  assert.deepEqual(legacyOps.readFiles, ["C:\\proj\\old.md"]);
});

test("sanitizeSurrogates strips unpaired UTF-16 surrogates while keeping valid emoji pairs intact", () => {
  const loneHigh = String.fromCharCode(0xd83d);
  const loneLow = String.fromCharCode(0xdc00);
  assert.equal(sanitizeSurrogates(`A${loneHigh}B🙈C${loneLow}D`), "AB🙈CD");
});

test("sanitizeOrphanedCalls never pairs an earlier turn's orphaned call_id with a later turn's result", () => {
  const input = [
    { type: "user_input", content: [{ type: "text", text: "Turn 1" }] },
    { type: "function_call", id: "call_1", name: "first_orphan", arguments: {} },
    { type: "user_input", content: [{ type: "text", text: "Turn 2" }] },
    { type: "function_call", id: "call_1", name: "second_valid", arguments: {} },
    { type: "function_result", call_id: "call_1", name: "second_valid", result: "ok" },
  ];
  const out = sanitizeOrphanedCalls(input);
  assert.deepEqual(
    out.map((s) => ({ type: s.type, name: s.name })),
    [
      { type: "user_input", name: undefined },
      { type: "user_input", name: undefined },
      { type: "function_call", name: "second_valid" },
      { type: "function_result", name: "second_valid" },
    ]
  );

  // Interleaved thought/model_output within the SAME assistant turn before tool results must NOT wipe earlier calls
  const interleavedTurn = [
    { type: "user_input", content: [{ type: "text", text: "Run two tools" }] },
    { type: "thought", text: "first thought" },
    { type: "function_call", id: "c1", name: "tool_a", arguments: {} },
    { type: "thought", text: "second thought" },
    { type: "function_call", id: "c2", name: "tool_b", arguments: {} },
    { type: "model_output", content: [{ type: "text", text: "Executing both..." }] },
    { type: "function_result", call_id: "c1", name: "tool_a", result: "ok1" },
    { type: "function_result", call_id: "c2", name: "tool_b", result: "ok2" },
  ];
  const keptInterleaved = sanitizeOrphanedCalls(interleavedTurn);
  assert.equal(keptInterleaved.filter((s) => s.type === "function_call").length, 2);
  assert.equal(keptInterleaved.filter((s) => s.type === "function_result").length, 2);
});
