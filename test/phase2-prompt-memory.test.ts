import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { clearPromptTemplateCache } from "../src/agent/prompt-loader.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

test("PI-014/001/002/011: Markdown prompt templates load cleanly with App UI self-awareness, cross-origin iframe fallback & sandbox semantics", () => {
  clearPromptTemplateCache();
  const prompt = buildSystemInstruction({
    enableBotTools: true,
    hostExecutionMode: "always",
    hostPlatform: "darwin",
    botWorkspaceRoot: "/tmp/ws/bots/bot-1",
    writeRoots: ["/tmp/ws"],
  });

  // No unresolved placeholders
  assert.ok(!/\{\{[a-zA-Z0-9_]+\}\}/.test(prompt), "prompt must not leak unresolved template vars");

  // PI-001: App Built-in UI Self-Awareness
  assert.match(prompt, /App Built-in UI Self-Awareness/);
  assert.match(prompt, /Bot 的电脑/);
  assert.match(prompt, /NEVER paste raw noVNC URLs/i);

  // PI-002: Cross-origin iframe OS fallback
  assert.match(prompt, /cross-origin/i);
  assert.match(prompt, /screenshot.*click\(x, y\).*type_text/s);

  // PI-011: Sandbox auto-allowed vs Host mode distinction
  assert.match(prompt, /Isolated Ubuntu Sandbox, Auto-Allowed by Default/);
  assert.match(prompt, /automatically without user confirmation/i);

  // PI-009 preview: Windows host prompt does not leak Mac .app paths
  const winPrompt = buildSystemInstruction({
    enableBotTools: true,
    hostExecutionMode: "always",
    hostPlatform: "win32",
    installedSkills: ["kimi-cu"],
    mcpStatusNote: "not installed",
  });
  assert.ok(!winPrompt.includes("/Applications/KimiCU.app"), "Windows prompt must not leak /Applications/KimiCU.app");
});

test("PI-016: memory_manage deduplicates explicit saves and emits non-blocking suggestion card for auto trigger", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mem-dual-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStore(dir);
  const bot = store.createSession({ title: "周报助手" });

  // 1. Explicit save writes directly
  const r1 = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      scope: "bot",
      trigger: "explicit",
      name: "周报格式偏好",
      content: "每次发周报都要按项目进度、风险和下周计划三段式输出",
    },
    { store, senderSessionId: bot.id, senderBot: bot }
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.created, true);
  assert.equal(store.getSession(bot.id)?.memories?.length, 1);

  // 2. Near-duplicate save is deduplicated without adding spam
  const rDup = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      scope: "bot",
      trigger: "explicit",
      name: "周报输出习惯",
      content: "每次发周报都要按项目进度、风险和下周计划三段式输出！",
    },
    { store, senderSessionId: bot.id, senderBot: bot }
  );
  assert.equal(rDup.ok, true);
  assert.equal(rDup.deduplicated, true);
  assert.equal(store.getSession(bot.id)?.memories?.length, 1);

  // 3. Auto-inferred save emits non-blocking memory_suggestion event instead of mutating store
  const emitted: any[] = [];
  const rAuto = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      scope: "bot",
      trigger: "auto",
      name: "常用语言",
      content: "所有技术方案与代码注释默认使用中文撰写",
    },
    {
      store,
      senderSessionId: bot.id,
      senderBot: bot,
      emit: (evt: any) => emitted.push(evt),
    }
  );
  assert.equal(rAuto.ok, true);
  assert.equal(rAuto.pendingUserConfirm, true);
  assert.equal(store.getSession(bot.id)?.memories?.length, 1, "auto trigger must not silently write memory");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "memory_suggestion");
  assert.equal(emitted[0].status, "pending");

  // 4. HTTP accept & dismiss endpoints resolve suggestions cleanly
  const srv = createServer({
    store,
    config: { port: 0, host: "127.0.0.1", dataDir: dir },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => srv.close(() => resolve())));
  const addr = srv.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;

  const acceptRes: any = await (
    await fetch(`${base}/api/memories/suggestions/${emitted[0].suggestionId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "accept",
        sessionId: bot.id,
        scope: "bot",
        name: emitted[0].name,
        content: emitted[0].content,
      }),
    })
  ).json();
  assert.equal(acceptRes.ok, true);
  assert.equal(acceptRes.status, "accepted");
  assert.equal(store.getSession(bot.id)?.memories?.length, 2);

  const dismissRes: any = await (
    await fetch(`${base}/api/memories/suggestions/memsug-dismiss-1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "dismiss",
        sessionId: bot.id,
        scope: "bot",
        name: "忽略测试",
        content: "不需要记住的临时信息",
      }),
    })
  ).json();
  assert.equal(dismissRes.ok, true);
  assert.equal(dismissRes.status, "dismissed");
  assert.equal(store.getSession(bot.id)?.memories?.length, 2);
});
