import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectRoute,
  resetUnavailableModels,
} from "../src/agent/router.js";
import { createModel } from "../src/agent/model.js";
import { createStore } from "../src/store/index.js";
import { createRunner } from "../src/agent/runner.js";
import { createServer } from "../src/server/index.js";
import { assessToolCall } from "../src/agent/policy.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import {
  runBotCollabTool,
  MAX_BOT_HOPS,
} from "../src/agent/bot-tools.js";
import {
  extractMentionedBots,
  selectGroupSpeakers,
} from "../src/agent/group-coordinator.js";
import { createScheduler } from "../src/agent/scheduler.js";

test("router dispatches fast / standard / deep tiers and skips screen on pure chat", () => {
  resetUnavailableModels();
  const cfg = {
    defaultModel: "gemini-4-argon",
    models: ["gemini-4-argon", "gemini-4-hydrogen"],
  };

  const fast = selectRoute({ userText: "你好，今天天气怎么样？", stepNo: 1, config: cfg });
  assert.equal(fast.tier, "fast");
  assert.equal(fast.model, "gemini-4-hydrogen");
  assert.equal(fast.captureInitialScreen, false);

  const browserFast = selectRoute({
    userText: "打开浏览器访问 https://example.com 并点击登录",
    stepNo: 1,
    config: cfg,
  });
  assert.equal(browserFast.tier, "fast");
  assert.equal(browserFast.model, "gemini-4-hydrogen");
  assert.equal(browserFast.thinkingLevel, "medium");
  assert.equal(browserFast.captureInitialScreen, true);

  const standard = selectRoute({
    userText: "帮我编写自动化 Python 报表脚本处理服务器日志",
    stepNo: 1,
    config: cfg,
  });
  assert.equal(standard.tier, "standard");
  assert.equal(standard.model, "gemini-4-argon");

  const deep = selectRoute({
    userText: "请做全面排错分析并组建多个 Bot 协同架构方案",
    stepNo: 1,
    config: cfg,
  });
  assert.equal(deep.tier, "deep");
  assert.equal(deep.model, "gemini-4-argon");
  assert.equal(deep.thinkingLevel, "high");

  const retryStandard = selectRoute({
    userText: "点击按钮",
    stepNo: 2,
    consecutiveErrors: 1,
    config: cfg,
  });
  assert.equal(retryStandard.tier, "standard");
  assert.equal(retryStandard.thinkingLevel, "medium");

  const retryDeep = selectRoute({
    userText: "点击按钮",
    stepNo: 3,
    consecutiveErrors: 2,
    config: cfg,
  });
  assert.equal(retryDeep.tier, "deep");
  assert.equal(retryDeep.thinkingLevel, "high");
});

test("model automatically falls back to fallbackModel when fast model is unavailable", async () => {
  resetUnavailableModels();
  const triedModels: any[] = [];
  const fakeClient = {
    interactions: {
      async create(params: any) {
        triedModels.push(params.model);
        if (params.model === "gemini-4-hydrogen") {
          const err: any = new Error("Model gemini-4-hydrogen not found");
          err.status = 404;
          throw err;
        }
        return {
          steps: [{ type: "model_output", content: [{ type: "text", text: "ok fallback" }] }],
          usage: { total_input_tokens: 10, total_output_tokens: 5 },
        };
      },
    },
  };

  const model = createModel({ client: fakeClient });
  const res = await model.nextTurn({
    model: "gemini-4-hydrogen",
    fallbackModel: "gemini-4-argon",
    thinkingLevel: "low",
    systemInstruction: "sys",
    tools: [],
    input: [],
  });

  assert.deepEqual(triedModels, ["gemini-4-hydrogen", "gemini-4-argon"]);
  assert.equal(res.text, "ok fallback");
  assert.equal(res.usedModel, "gemini-4-argon");
  resetUnavailableModels();
});

test("create_bot, send_bot_message, exchange transcript, and MAX_BOT_HOPS loop guard", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multibot-test-"));
  try {
    const store = createStore(tmpDir);
    const nori = store.createSession({
      title: "Nori",
      avatar: { shape: "blob", color: "black" },
    });

    const dispatched: any[] = [];
    const broadcasts: any[] = [];

    // 1. Nori creates a specialist Bot with initial handoff
    const createRes = await runBotCollabTool(
      "create_bot",
      {
        name: "Gmail 小助理",
        role_prompt: "负责整理邮件与跟进账单",
        shape: "cloud",
        color: "orange",
        initial_message: "请接手 you@example.com 的收据核对",
      },
      {
        store,
        senderSessionId: nori.id,
        senderBot: nori,
        hopDepth: 0,
        broadcastGlobal: (ev: any) => broadcasts.push(ev),
        onDispatchBotTurn: (job: any) => dispatched.push(job),
      }
    );

    assert.equal(createRes.ok, true);
    assert.equal(createRes.bot.name, "Gmail 小助理");
    assert.equal(createRes.bot.color, "orange");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].hopDepth, 1);

    // Exchange transcript recorded
    const ex = store.getExchange(createRes.handoff.exchangeId);
    assert.ok(ex);
    assert.equal(ex.messages.length, 1);
    assert.equal(ex.messages[0].fromBotName, "Nori");
    assert.equal(ex.messages[0].toBotName, "Gmail 小助理");

    // Both bots have `bot_exchange` event in their stream
    const noriEvents = store.readEvents(nori.id);
    const gmailEvents = store.readEvents(createRes.bot.id);
    assert.equal(noriEvents[0].type, "bot_exchange");
    assert.equal(gmailEvents[0].type, "bot_exchange");

    // 2. Enforce MAX_BOT_HOPS guard
    const blocked = await runBotCollabTool(
      "send_bot_message",
      {
        target_bot: "Gmail 小助理",
        message: "infinite ping",
      },
      {
        store,
        senderSessionId: nori.id,
        senderBot: nori,
        hopDepth: MAX_BOT_HOPS,
      }
    );
    assert.ok(blocked.error);
    assert.match(blocked.error, /Maximum inter-Bot hop depth/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("group coordinator routes @mentions and relevance scoring", () => {
  const bots = [
    { id: "b1", title: "Nori", rolePrompt: "主控协调员" },
    { id: "b2", title: "代码动画师", rolePrompt: "编写前端 CSS 动画和 Canvas 特效" },
    { id: "b3", title: "博客管理员", rolePrompt: "负责博客部署与加密文章管理" },
  ];

  const explicit = extractMentionedBots("请 @博客管理员 和 @代码动画师 配合一下", bots);
  assert.deepEqual(
    explicit.map((b) => b.id),
    ["b3", "b2"]
  );

  const relevant = selectGroupSpeakers({
    text: "帮我看看这段前端动画特效怎么调",
    memberBots: bots,
    maxSpeakers: 2,
  });
  assert.equal(relevant[0].id, "b2");
});

test("dynamic policy rules work while NEVER bypassing .ssh or .env deny list", () => {
  const cfgWithWildcardAllow = {
    writeRoots: ["/tmp/ws"],
    policy: {
      autoAudit: true,
      askRules: [{ id: "r1", tool: "open_url", pattern: "bank.com", label: "访问网银需批准" }],
      allowRules: [{ id: "r2", tool: "*", pattern: "", label: "允许一切常规操作" }],
    },
  };

  // Sensitive paths MUST still be denied even with wildcard allowRule!
  assert.equal(
    assessToolCall("read_file", { path: "/Users/YOUR_USERNAME/.ssh/id_rsa" }, cfgWithWildcardAllow)
      .decision,
    "deny"
  );
  assert.equal(
    assessToolCall("write_file", { path: "/tmp/ws/.env", content: "x" }, cfgWithWildcardAllow)
      .decision,
    "deny"
  );

  // Custom askRule triggers confirm
  assert.equal(
    assessToolCall("open_url", { url: "https://my.bank.com" }, cfgWithWildcardAllow).decision,
    "confirm"
  );

  // Custom allowRule exempts non-high-risk shell mv/rm
  assert.equal(
    assessToolCall("run_shell", { command: "rm /tmp/ws/old.log" }, cfgWithWildcardAllow).decision,
    "allow"
  );
});

test("private skills and group identity inject into buildSystemInstruction", () => {
  const prompt = buildSystemInstruction({
    enableBotTools: true,
    botIdentity: {
      name: "代码动画师",
      rolePrompt: "专注 SVG 与交互动效",
      isGroup: true,
      groupTitle: "落地页攻坚群",
      groupMembers: [{ title: "Nori", rolePrompt: "总控" }],
    },
    privateSkills: [
      { id: "s1", name: "动效帧率规范", instruction: "优先使用 transform 和 opacity", enabled: true },
      { id: "s2", name: "已禁用技能", instruction: "不应出现", enabled: false },
    ],
  });

  assert.ok(prompt.includes("代码动画师"));
  assert.ok(prompt.includes("专注 SVG 与交互动效"));
  assert.ok(prompt.includes("落地页攻坚群"));
  assert.ok(prompt.includes("优先使用 transform 和 opacity"));
  assert.ok(!prompt.includes("不应出现"));
  assert.ok(prompt.includes("ask_user_choice"));
});

test("scheduler triggers due tasks when session is idle and disables once-only tasks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-test-"));
  try {
    const store = createStore(tmpDir);
    const bot = store.createSession({ title: "巡检员" });
    const started: any[] = [];

    const fakeRunner = {
      isSessionBusy: () => false,
      start(sessionId: string, text: string) {
        started.push({ sessionId, text });
      },
    };

    store.writeSchedules([
      {
        id: "sched-1",
        sessionId: bot.id,
        title: "一次性提醒",
        repeat: "once",
        prompt: "检查收件箱",
        nextRunAt: new Date(Date.now() - 5000).toISOString(),
        enabled: true,
      },
    ]);

    const scheduler = createScheduler({ store, runner: fakeRunner });
    const triggered = scheduler.tick();
    assert.deepEqual(triggered, ["sched-1"]);
    assert.equal(started.length, 1);
    assert.match(started[0].text, /检查收件箱/);
    assert.equal(store.readSchedules()[0].enabled, false);

    // Starting scheduler with empty schedules must not seed any default inspection task
    store.writeSchedules([]);
    scheduler.start();
    try {
      assert.deepEqual(store.readSchedules(), []);
    } finally {
      scheduler.stop();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("end-to-end new HTTP APIs: search, clone, patch, delete, attachments, library, choices, alwaysRule, schedules, vault", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-full-test-"));
  const wsDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });

  const store = createStore(tmpDir);
  const chosenCalls: any[] = [];
  const runner = {
    status: () => ({ sessionId: null, state: "idle" }),
    activeSessions: () => ({}),
    start: () => {},
    stop: () => {},
    pause: () => {},
    resume: () => {},
    approve: () => {},
    choose: (callId: string, selected: any) => chosenCalls.push({ callId, selected }),
    broadcastGlobal: () => {},
    subscribe: () => () => {},
  };

  const server = createServer({
    config: {
      writeRoots: [wsDir],
      models: ["gemini-4-argon", "gemini-4-hydrogen"],
    },
    store,
    runner,
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  try {
    // 1. Create + Patch + Clone Bot
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Klip 推广官",
        avatar: { shape: "clover", color: "green" },
        rolePrompt: "负责撰写产品推广文案",
      }),
    });
    const bot = await createRes.json();
    assert.equal(bot.title, "Klip 推广官");
    assert.equal(bot.avatar.shape, "clover");

    store.appendEvent(bot.id, { type: "answer", text: "草稿已按真实评论更新好" });

    // 2. Full-text Search
    const searchRes = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("真实评论")}`);
    const searchJson = await searchRes.json();
    assert.equal(searchJson.messages.length, 1);
    assert.equal(searchJson.messages[0].sessionId, bot.id);

    // 3. Clone Bot (`分享 -> 创建副本`)
    const cloneRes = await fetch(`${baseUrl}/api/sessions/${bot.id}/clone`, {
      method: "POST",
    });
    const cloned = await cloneRes.json();
    assert.equal(cloned.title, "Klip 推广官 副本");
    assert.equal(cloned.avatar.color, "green");

    // 4. Upload Attachment scoped to Bot + Read via exclusive Library & Safe Workspace File Endpoint
    const uploadRes = await fetch(`${baseUrl}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: bot.id,
        name: "note.txt",
        dataBase64: Buffer.from("hello workspace").toString("base64"),
      }),
    });
    assert.equal(uploadRes.status, 201);
    const uploaded = await uploadRes.json();
    assert.ok(fs.existsSync(uploaded.path));

    const libRes = await fetch(`${baseUrl}/api/sessions/${bot.id}/library`);
    const libJson = await libRes.json();
    assert.ok(libJson.items.some((i: any) => i.name.includes("note.txt")));

    const clonedLibRes = await fetch(`${baseUrl}/api/sessions/${cloned.id}/library`);
    const clonedLibJson = await clonedLibRes.json();
    assert.equal(
      clonedLibJson.items.some((i: any) => i.name.includes("note.txt")),
      false,
      "Cloned Bot must start with an isolated empty Library"
    );

    const fileRes = await fetch(
      `${baseUrl}/api/workspace/file?path=${encodeURIComponent(uploaded.path)}`
    );
    assert.equal(fileRes.status, 200);
    assert.equal(await fileRes.text(), "hello workspace");

    // Block path traversal outside workspace
    const forbiddenRes = await fetch(
      `${baseUrl}/api/workspace/file?path=${encodeURIComponent("/etc/hosts")}`
    );
    assert.equal(forbiddenRes.status, 403);

    // 5. Approval with `alwaysRule` writes directly into settings.policy.allowRules
    const appRes = await fetch(`${baseUrl}/api/approvals/call-99`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allow: true,
        alwaysRule: { tool: "run_shell", pattern: "git status", label: "允许 git status" },
      }),
    });
    assert.equal(appRes.status, 200);
    const settingsRes = await fetch(`${baseUrl}/api/settings`);
    const settingsJson = await settingsRes.json();
    assert.ok(settingsJson.policy.allowRules.some((r: any) => r.pattern === "git status"));

    // 6. Choice resolution (`ask_user_choice` card)
    const choiceRes = await fetch(`${baseUrl}/api/choices/call-choice-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected: "先这样，有事再叫我" }),
    });
    assert.equal(choiceRes.status, 200);
    assert.deepEqual(chosenCalls, [
      { callId: "call-choice-1", selected: "先这样，有事再叫我" },
    ]);

    // 7. Delete cloned session
    const delRes = await fetch(`${baseUrl}/api/sessions/${cloned.id}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    assert.equal(store.getSession(cloned.id), null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("fresh-install store and HTTP APIs return empty globalMemories, schedules, and vault without sample data", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-install-empty-"));
  const wsDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });

  const store = createStore(tmpDir);
  const runner = {
    status: () => ({ sessionId: null, state: "idle" }),
    activeSessions: () => ({}),
    start: () => {},
    stop: () => {},
    pause: () => {},
    resume: () => {},
    approve: () => {},
    choose: () => {},
    broadcastGlobal: () => {},
    subscribe: () => () => {},
  };
  const scheduler = createScheduler({ store, runner });
  const server = createServer({
    config: {
      dataDir: tmpDir,
      writeRoots: [wsDir],
      models: ["gemini-4-argon", "gemini-4-hydrogen"],
    },
    store,
    runner,
    scheduler,
  });

  t.after(async () => {
    scheduler.stop();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  assert.deepEqual(store.readSchedules(), []);
  scheduler.start();
  assert.deepEqual(store.readSchedules(), []);
  assert.deepEqual(store.readVault(), []);
  assert.deepEqual(store.readVaultPublic(), []);

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  const schedulesJson: any = await (await fetch(`${baseUrl}/api/schedules`)).json();
  assert.deepEqual(schedulesJson.schedules, []);

  const vaultJson: any = await (await fetch(`${baseUrl}/api/vault`)).json();
  assert.deepEqual(vaultJson.items, []);

  const settingsJson: any = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.deepEqual(settingsJson.globalMemories, []);
  assert.deepEqual(settingsJson.privateSkills, []);

  const sessionsJson: any = await (await fetch(`${baseUrl}/api/sessions`)).json();
  assert.equal(sessionsJson.sessions.length, 1);
  assert.equal(sessionsJson.sessions[0].isAdmin, true);
  assert.equal((sessionsJson.sessions[0].memories || []).length, 0);
});
