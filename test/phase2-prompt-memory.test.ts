import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { clearPromptTemplateCache } from "../src/agent/prompt-loader.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import {
  hasExplicitMemoryIntent,
  shouldRunMemoryExtraction,
  runPostTurnMemoryExtraction,
} from "../src/agent/memory-extractor.js";
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

test("PI-016 guard: server downgrades unauthorized explicit memory_manage save when userText lacks explicit memory intent", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mem-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStore(dir);
  const bot = store.createSession({ title: "日常助手" });
  const emitted: any[] = [];

  // 1. Model tries trigger="explicit", but user never asked to remember -> forced downgrade to suggestion card!
  const downgraded = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      scope: "bot",
      trigger: "explicit",
      name: "回答语言",
      content: "回答问题时优先使用简洁的要点列表",
    },
    {
      store,
      senderSessionId: bot.id,
      senderBot: bot,
      userText: "帮我总结一下这份 PDF 的重点",
      emit: (evt: any) => emitted.push(evt),
    }
  );
  assert.equal(downgraded.ok, true);
  assert.equal(downgraded.pendingUserConfirm, true);
  assert.equal(downgraded.downgradedToAuto, true);
  assert.equal(store.getSession(bot.id)?.memories?.length ?? 0, 0, "must NOT silently mutate memory");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "memory_suggestion");
  assert.equal(emitted[0].downgradedFromExplicit, true);

  // 2. When user explicitly says "记住...", direct save is allowed
  const direct = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      scope: "bot",
      trigger: "explicit",
      name: "表格周报",
      content: "每周五的周报统一用 Markdown 表格输出",
    },
    {
      store,
      senderSessionId: bot.id,
      senderBot: bot,
      userText: "记住我以后每周五的周报统一用 Markdown 表格输出",
      emit: (evt: any) => emitted.push(evt),
    }
  );
  assert.equal(direct.ok, true);
  assert.equal(direct.created, true);
  assert.equal(store.getSession(bot.id)?.memories?.length, 1);
});

test("PI-016 extractor: pre-filter skips chatter, fast-tier post-turn extractor catches missed preferences and skips dismissed/duplicate items", async (t) => {
  // Pre-filter assertions
  assert.equal(hasExplicitMemoryIntent("帮我记一下我的收件邮箱是 a@b.com"), true);
  assert.equal(hasExplicitMemoryIntent("帮我查一下上海天气"), false);
  assert.equal(shouldRunMemoryExtraction("好的", "没问题"), false);
  assert.equal(shouldRunMemoryExtraction("谢谢！", "不客气"), false);
  assert.equal(shouldRunMemoryExtraction("[例行任务 · 日报] 汇总今日新闻", "好的"), false);
  assert.equal(shouldRunMemoryExtraction("https://example.com", "已打开"), false);
  assert.equal(shouldRunMemoryExtraction("我平时习惯用英文写代码注释，别写中文注释了", "明白"), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mem-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStore(dir);
  const bot = store.createSession({
    title: "编程助手",
    memories: [
      {
        id: "mem-existing-1",
        name: "语言偏好",
        content: "对话说明默认使用中文",
        enabled: true,
      },
    ],
  });

  let summarizeCalls = 0;
  const fakeFastModel: any = {
    summarizeTurn: async () => {
      summarizeCalls += 1;
      return {
        text: JSON.stringify({
          candidates: [
            {
              scope: "global",
              name: "代码注释语言",
              content: "所有代码注释默认使用英文撰写，不使用中文注释",
              confidence: 0.92,
            },
            {
              scope: "bot",
              name: "低置信噪音",
              content: "今天刚修了一个测试",
              confidence: 0.35,
            },
            {
              scope: "bot",
              name: "重复偏好",
              content: "对话说明默认使用中文",
              confidence: 0.95,
            },
          ],
        }),
      };
    },
  };

  const emitted: any[] = [];
  const emitAndPersist = (evt: any) => {
    emitted.push(evt);
    store.appendEvent(bot.id, evt);
  };

  const extracted1 = await runPostTurnMemoryExtraction({
    store,
    model: fakeFastModel,
    sessionId: bot.id,
    botSession: bot,
    userText: "我平时习惯用英文写代码注释，别写中文注释了",
    assistantText: "好的，后面的代码注释我都会用英文来写。",
    emit: emitAndPersist,
  });

  assert.equal(summarizeCalls, 1);
  assert.equal(extracted1.length, 1, "must keep only high-confidence non-duplicate candidate");
  assert.equal(extracted1[0].scope, "global");
  assert.equal(extracted1[0].name, "代码注释语言");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "memory_suggestion");
  assert.equal(emitted[0].source, "post_turn_extractor");
  // Must NOT silently write into store memories
  assert.equal(store.getSession(bot.id)?.memories?.length, 1);

  // Running again in the same session must NOT re-suggest the already suggested/dismissed item
  const extracted2 = await runPostTurnMemoryExtraction({
    store,
    model: fakeFastModel,
    sessionId: bot.id,
    botSession: bot,
    userText: "我平时习惯用英文写代码注释，别写中文注释了",
    assistantText: "好的",
    emit: emitAndPersist,
  });
  assert.equal(extracted2.length, 0, "previously suggested content must not be suggested twice");
  assert.equal(emitted.length, 1);
});
