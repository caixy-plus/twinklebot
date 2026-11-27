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

  // 3. Auto-inferred save persists directly & silently without emitting any suggestion card
  const emitted: any[] = [];
  const broadcasts: any[] = [];
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
      broadcastGlobal: (evt: any) => broadcasts.push(evt),
    }
  );
  assert.equal(rAuto.ok, true);
  assert.equal(rAuto.created, true);
  assert.equal(rAuto.trigger, "auto");
  assert.equal(store.getSession(bot.id)?.memories?.length, 2, "auto trigger saves silently & directly");
  assert.equal(emitted.length, 0, "auto trigger must NOT emit memory_suggestion card");
  assert.ok(broadcasts.some((b) => b.type === "session_updated"));

  // 4. Legacy HTTP accept & dismiss endpoints remain backward-compatible for older clients
  const srv = createServer({
    store,
    config: { port: 0, host: "127.0.0.1", dataDir: dir },
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => srv.close(() => resolve())));
  const addr = srv.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;

  const acceptRes: any = await (
    await fetch(`${base}/api/memories/suggestions/memsug-legacy-1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "accept",
        sessionId: bot.id,
        scope: "bot",
        name: "兼容记忆",
        content: "旧客户端兼容写入的记忆条目",
      }),
    })
  ).json();
  assert.equal(acceptRes.ok, true);
  assert.equal(acceptRes.status, "accepted");
  assert.equal(store.getSession(bot.id)?.memories?.length, 3);

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
  assert.equal(store.getSession(bot.id)?.memories?.length, 3);
});

test("Direct memory save: both auto-inferred and explicit memory_manage saves persist silently with zero suggestion cards", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mem-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStore(dir);
  const bot = store.createSession({ title: "日常助手" });
  const emitted: any[] = [];

  // 1. Implicit turn save writes directly with trigger='auto' and NO suggestion card
  const autoSaved = await runBotCollabTool(
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
  assert.equal(autoSaved.ok, true);
  assert.equal(autoSaved.created, true);
  assert.equal(autoSaved.trigger, "auto");
  assert.equal(store.getSession(bot.id)?.memories?.length, 1);
  assert.equal(emitted.length, 0, "must never emit memory_suggestion card");

  // 2. When user explicitly says "记住...", direct save uses trigger='explicit'
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
  assert.equal(direct.trigger, "explicit");
  assert.equal(store.getSession(bot.id)?.memories?.length, 2);
  assert.equal(emitted.length, 0);
});

test("Auto memory extractor: pre-filter skips chatter, fast-tier post-turn extractor silently persists high-confidence preferences and filters secrets/low-confidence/duplicates", async (t) => {
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
              name: "密钥泄露拦截",
              content: "我的 OpenAI API Key 是 sk-secret1234567890abcdef",
              confidence: 0.99,
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
  const broadcasts: any[] = [];

  const extracted1 = await runPostTurnMemoryExtraction({
    store,
    model: fakeFastModel,
    sessionId: bot.id,
    botSession: bot,
    userText: "我平时习惯用英文写代码注释，别写中文注释了",
    assistantText: "好的，后面的代码注释我都会用英文来写。",
    emit: (evt: any) => emitted.push(evt),
    broadcastGlobal: (evt: any) => broadcasts.push(evt),
  });

  assert.equal(summarizeCalls, 1);
  assert.equal(extracted1.length, 1, "must keep only high-confidence non-duplicate non-secret candidate");
  assert.equal(extracted1[0].scope, "global");
  assert.equal(extracted1[0].name, "代码注释语言");
  assert.equal(emitted.length, 0, "post-turn extractor must NOT emit memory_suggestion card");
  assert.ok(broadcasts.some((b) => b.type === "skills_updated"));
  // Saved memory uses single `content` field and stops mirroring to `privateSkills`
  const savedGlobal = store.readSettings().globalMemories || [];
  assert.equal(savedGlobal.length, 1);
  assert.match(savedGlobal[0].content, /英文撰写/);
  assert.equal(savedGlobal[0].desc, undefined, "must not duplicate desc");
  assert.equal(savedGlobal[0].instruction, undefined, "must not duplicate instruction");
  assert.deepEqual(store.readSettings().privateSkills || [], [], "must not double-write privateSkills");

  // Running again in the same session must deduplicate against persisted globalMemories
  const extracted2 = await runPostTurnMemoryExtraction({
    store,
    model: fakeFastModel,
    sessionId: bot.id,
    botSession: bot,
    userText: "我平时习惯用英文写代码注释，别写中文注释了",
    assistantText: "好的",
    emit: (evt: any) => emitted.push(evt),
    broadcastGlobal: (evt: any) => broadcasts.push(evt),
  });
  assert.equal(extracted2.length, 0, "already persisted memory must not be saved twice");
  assert.equal(emitted.length, 0);
  assert.equal((store.readSettings().globalMemories || []).length, 1);

  // Tightened extraction guard rejects ordinary 25-char task commands lacking preference cues
  assert.equal(
    shouldRunMemoryExtraction("帮我打开浏览器访问一下 GitHub 查看最新的 issues", "好的，已打开"),
    false
  );
  assert.equal(
    shouldRunMemoryExtraction(
      "这个接口文档的结构其实不对，以后提交类似分析时请改成表格+结论的格式输出",
      "明白"
    ),
    true
  );

  // ensureAdminBot populates default non-empty rolePrompt & list_bots/prompt expose workspace awareness
  const admin = store.ensureAdminBot();
  assert.ok(String(admin.rolePrompt || "").trim().length > 10, "Admin Bot must have non-empty default rolePrompt");

  const botsListRes = await runBotCollabTool(
    "list_bots",
    {},
    {
      store,
      senderSessionId: admin.id,
      senderBot: admin,
      config: { writeRoots: [dir] },
    }
  );
  assert.equal(botsListRes.ok, true);
  assert.ok(String(botsListRes.bots_workspace_root || "").endsWith(path.join(dir, "bots")));
  assert.ok(botsListRes.bots.every((b: any) => typeof b.workspace_dir === "string" && b.workspace_dir.includes(b.id)));

  const wsPrompt = buildSystemInstruction({
    enableBotTools: true,
    botWorkspaceRoot: path.join(dir, "bots", bot.id),
    writeRoots: [dir],
  });
  assert.match(wsPrompt, /Multi-Bot Shared Parent Workspace/);
  assert.match(wsPrompt, /\/mnt\/c\//);
  assert.match(wsPrompt, /edit_file/);
});
