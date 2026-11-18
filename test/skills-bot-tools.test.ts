import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/store/index.js";
import { normalizeMailAuthStore } from "../src/lib/mail-client.js";
import {
  BOT_COLLAB_TOOL_DECLARATIONS,
  runBotCollabTool,
  filterToolDeclarationsForSkills,
  redactToolArgsForDisplay,
} from "../src/agent/bot-tools.js";
import { createControl } from "../src/agent/loop.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";

const okVerify = async () => ({ messages: 5, latencyMs: 2 });

function setup(t: any, installedSkills?: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-skilltools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  if (installedSkills) store.writeSettings({ installedSkills });
  const events: any[] = [];
  const broadcasts: any[] = [];
  const ctx = (extra = {}) => ({
    store,
    senderSessionId: "s1",
    senderBot: { id: "s1", title: "Nori" },
    callId: "call-1",
    emit: (ev: any) => events.push(ev),
    broadcastGlobal: (ev: any) => broadcasts.push(ev),
    verifyMailFn: okVerify,
    ...extra,
  });
  return { store, events, broadcasts, ctx };
}

const accountsOf = (store: any) => normalizeMailAuthStore(store.readMailAuth()).accounts;

test("skill tools are declared and mail tools are filtered when no mail skill is added", () => {
  const names = BOT_COLLAB_TOOL_DECLARATIONS.map((d) => d.name);
  assert.ok(names.includes("skill_list"));
  assert.ok(names.includes("skill_configure_mail"));
  const cfg: any = BOT_COLLAB_TOOL_DECLARATIONS.find((d) => d.name === "skill_configure_mail");
  assert.deepEqual(cfg.parameters.properties.action.enum, [
    "upsert_account",
    "set_default",
    "test_account",
    "remove_account",
  ]);

  const none = filterToolDeclarationsForSkills(BOT_COLLAB_TOOL_DECLARATIONS, []).map((d) => d.name);
  assert.ok(!none.some((n) => n.startsWith("mail_")));
  assert.ok(none.includes("skill_configure_mail"));
  const some = filterToolDeclarationsForSkills(BOT_COLLAB_TOOL_DECLARATIONS, ["custom-mail"]).map(
    (d) => d.name
  );
  assert.ok(some.includes("mail_send_message"));
});

test("redactToolArgsForDisplay masks secrets", () => {
  assert.deepEqual(redactToolArgsForDisplay("skill_configure_mail", { secret: "x", email: "a" }), {
    secret: "••••",
    email: "a",
  });
  const other = { text: "hi" };
  assert.equal(redactToolArgsForDisplay("type_text", other), other);
});

test("skill_list reports platform (7 builtin + optional kimi-cu) and office categories without custom skills", async (t) => {
  const { ctx, store } = setup(t, ["custom-mail"]);
  const r = await runBotCollabTool("skill_list", {}, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.platform.length, 8);
  const kimiRow = r.platform.find((s: any) => s.id === "kimi-cu");
  assert.ok(kimiRow);
  assert.equal(kimiRow.removable, true);
  assert.equal(kimiRow.installed, false);
  assert.deepEqual(
    r.office.map((s: any) => [s.id, s.installed]),
    [
      ["qqmail", false],
      ["custom-mail", true],
    ]
  );
  assert.equal("custom" in r, false);

  store.writeSettings({ installedSkills: ["custom-mail", "kimi-cu"] });
  const r2 = await runBotCollabTool("skill_list", {}, ctx());
  assert.equal(r2.platform.find((s: any) => s.id === "kimi-cu").installed, true);
});

test("memory_manage supports list, save, toggle, and remove in conversation", async (t) => {
  const { store, ctx, broadcasts } = setup(t);
  const saved = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      name: "周报排版偏好",
      content: "所有周报统一使用 Markdown 表格输出",
    },
    ctx()
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.created, true);
  assert.equal(saved.memory.name, "周报排版偏好");
  assert.ok(broadcasts.some((b) => b.type === "skills_updated"));

  const listed = await runBotCollabTool("memory_manage", { action: "list" }, ctx());
  assert.equal(listed.ok, true);
  assert.equal(listed.memories.length, 1);
  assert.equal(listed.memories[0].content, "所有周报统一使用 Markdown 表格输出");

  const toggled = await runBotCollabTool(
    "memory_manage",
    { action: "toggle", memory: "周报排版" },
    ctx()
  );
  assert.equal(toggled.ok, true);
  assert.equal(toggled.memory.enabled, false);

  const removed = await runBotCollabTool(
    "memory_manage",
    { action: "remove", memory: "Markdown 表格" },
    ctx()
  );
  assert.equal(removed.ok, true);
  assert.equal(removed.removed.name, "周报排版偏好");
  assert.equal(store.readSettings().globalMemories.length, 0);
});

test("memory_manage manages per-bot dedicated memories when Bot session exists", async (t) => {
  const { store, ctx, broadcasts } = setup(t);
  const botSession = store.createSession({ title: "邮箱管家", roleDescription: "处理邮件" });
  const botCtx = () =>
    ctx({
      senderSessionId: botSession.id,
      senderBot: botSession,
    });

  // Default scope for an active Bot session is "bot"
  const saved = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      name: "邮件签名规范",
      content: "发送给客户的邮件末尾统一附带 Best regards, Nori",
    },
    botCtx()
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.scope, "bot");
  assert.equal(saved.created, true);
  assert.equal(store.getSession(botSession.id)!.memories!.length, 1);
  assert.equal(store.readSettings().globalMemories?.length || 0, 0);
  assert.ok(broadcasts.some((b) => b.type === "session_updated" && b.sessionId === botSession.id));

  // Explicit global scope still saves to globalMemories
  const savedGlobal = await runBotCollabTool(
    "memory_manage",
    {
      action: "save",
      scope: "global",
      name: "全局称呼",
      content: "称呼用户为 Alex",
    },
    botCtx()
  );
  assert.equal(savedGlobal.ok, true);
  assert.equal(savedGlobal.scope, "global");
  assert.equal(store.readSettings().globalMemories.length, 1);

  const listed = await runBotCollabTool("memory_manage", { action: "list" }, botCtx());
  assert.equal(listed.ok, true);
  assert.equal(listed.botMemories.length, 1);
  assert.equal(listed.globalMemories.length, 1);
  assert.equal(listed.memories.length, 2);

  // Prompt injection includes per-bot dedicated memory
  const sysPrompt = buildSystemInstruction({
    enableBotTools: true,
    botIdentity: store.getSession(botSession.id),
    privateSkills: store.readSettings().globalMemories,
  });
  assert.ok(sysPrompt.includes("Your Dedicated Bot Memory"));
  assert.ok(sysPrompt.includes("邮件签名规范"));
  assert.ok(sysPrompt.includes("Best regards, Nori"));
  assert.ok(sysPrompt.includes("全局称呼"));

  // Toggle and remove on bot memory
  const toggled = await runBotCollabTool(
    "memory_manage",
    { action: "toggle", memory: "邮件签名" },
    botCtx()
  );
  assert.equal(toggled.ok, true);
  assert.equal(toggled.scope, "bot");
  assert.equal(toggled.memory.enabled, false);

  const removed = await runBotCollabTool(
    "memory_manage",
    { action: "remove", memory: "Best regards" },
    botCtx()
  );
  assert.equal(removed.ok, true);
  assert.equal(removed.scope, "bot");
  assert.equal(store.getSession(botSession.id)!.memories!.length, 0);
});

test("skill_configure_mail rejects skills that are not added", async (t) => {
  const { ctx } = setup(t, ["custom-mail"]);
  const r = await runBotCollabTool(
    "skill_configure_mail",
    { action: "upsert_account", skill_id: "qqmail", email: "a@qq.com", secret: "x".repeat(16) },
    ctx()
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "该技能当前未添加，请先在左下角「技能商店」添加后再配置。");
});

test("skill_configure_mail rejects account of removed skill", async (t) => {
  const { store, ctx } = setup(t, ["custom-mail"]);
  store.writeMailAuth({
    accounts: [{ id: "qq1", provider: "qqmail", email: "me@qq.com", password: "p".repeat(16) }],
  });
  const r = await runBotCollabTool(
    "skill_configure_mail",
    { action: "set_default", account: "me@qq.com" },
    ctx()
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /未添加|未找到/);
});

test("upsert with secret creates account without leaking secret and broadcasts", async (t) => {
  const { store, ctx, broadcasts } = setup(t);
  const r = await runBotCollabTool(
    "skill_configure_mail",
    {
      action: "upsert_account",
      skill_id: "custom-mail",
      email: "ops@163.com",
      secret: "S3cretPass",
      label: "运维",
    },
    ctx()
  );
  assert.equal(r.ok, true, r.error);
  const json = JSON.stringify(r);
  assert.ok(!json.includes("S3cretPass"));
  assert.ok(!("secret" in r) && !("password" in (r.account || {})));
  const saved = accountsOf(store);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].inboundHost, "imap.163.com");
  assert.equal(saved[0].smtpHost, "smtp.163.com");
  assert.equal(saved[0].label, "运维");
  assert.ok(broadcasts.some((b) => b.type === "skills_updated"));
});

test("upsert without secret opens masked credential card and saves after submission", async (t) => {
  const { store, ctx, events } = setup(t);
  const control = createControl();
  control.resolveChoice("call-1", { value: "abcd abcd abcd abcd" });
  const r = await runBotCollabTool(
    "skill_configure_mail",
    { action: "upsert_account", skill_id: "qqmail", email: "work@qq.com" },
    ctx({ control })
  );
  assert.equal(r.ok, true, r.error);
  const req = events.find((e) => e.type === "credential_request");
  assert.ok(req);
  assert.equal(req.hideVaultCheckbox, true);
  assert.equal(req.fieldType, "password");
  assert.match(req.service, /QQ 邮箱 · work@qq.com/);
  const done = events.find((e) => e.type === "credential_resolved");
  assert.equal(done.submitted, true);
  assert.equal(done.resolvedText, "🔒 已连接 QQ 邮箱 · work@qq.com");
  assert.ok(!JSON.stringify(events).includes("abcdabcdabcdabcd"));
  assert.ok(!JSON.stringify(r).includes("abcdabcdabcdabcd"));
  assert.equal(accountsOf(store)[0].password, "abcdabcdabcdabcd");
});

test("set_default, test_account and remove_account operate on added skills", async (t) => {
  const { store, ctx } = setup(t);
  store.writeMailAuth({
    accounts: [
      { id: "qq1", provider: "qqmail", email: "me@qq.com", password: "p".repeat(16), isDefault: true },
      {
        id: "cm1",
        provider: "custom-mail",
        email: "me@163.com",
        password: "pw",
        inboundHost: "imap.163.com",
        smtpHost: "smtp.163.com",
        label: "备用",
      },
    ],
  });
  const d = await runBotCollabTool("skill_configure_mail", { action: "set_default", account: "备用" }, ctx());
  assert.equal(d.ok, true);
  assert.equal(accountsOf(store).find((a) => a.id === "cm1")!.isDefault, true);

  const tst = await runBotCollabTool("skill_configure_mail", { action: "test_account", account: "me@qq.com" }, ctx());
  assert.equal(tst.ok, true);
  assert.equal(tst.messages, 5);

  const rm = await runBotCollabTool("skill_configure_mail", { action: "remove_account", account: "me@qq.com" }, ctx());
  assert.equal(rm.ok, true);
  assert.deepEqual(accountsOf(store).map((a) => a.id), ["cm1"]);
});

test("mail tools ignore accounts of removed skills", async (t) => {
  const { store, ctx } = setup(t, ["custom-mail"]);
  store.writeMailAuth({
    accounts: [{ id: "qq1", provider: "qqmail", email: "me@qq.com", password: "p".repeat(16) }],
  });
  const r = await runBotCollabTool("mail_list_accounts", {}, ctx());
  assert.equal(r.count, 0);
});

test("system prompt describes added skills, dual-computer model, and kimi-cu grounding rules", () => {
  const sWithoutKimi = buildSystemInstruction({
    enableBotTools: true,
    installedSkills: ["qqmail"],
    hostExecutionMode: "always",
    mailAccounts: [],
    skillsSummary: [{ id: "qqmail", name: "QQ 邮箱", accountCount: 0 }],
  });
  assert.ok(sWithoutKimi.includes("skill_configure_mail"));
  assert.ok(sWithoutKimi.includes("QQ 邮箱"));
  assert.ok(sWithoutKimi.includes("你的电脑"));
  assert.ok(sWithoutKimi.includes("host_run_shell"));
  assert.ok(sWithoutKimi.includes("KimiCU"));
  assert.ok(!sWithoutKimi.includes("连接应用"));

  const sWithKimi = buildSystemInstruction({
    enableBotTools: true,
    installedSkills: ["qqmail", "kimi-cu"],
    hostExecutionMode: "always",
    kimiCuActive: true,
    mailAccounts: [],
    skillsSummary: [{ id: "qqmail", name: "QQ 邮箱", accountCount: 0 }],
  });
  assert.ok(sWithKimi.includes("mcp__kimi_cu__get_app_state"));
  assert.ok(sWithKimi.includes("snapshot_id"));
  assert.ok(sWithKimi.includes("screenshot_id"));
  assert.ok(sWithKimi.includes("schedule_manage"));
});

test("schedule_manage supports create, list, update, toggle, and remove for a Bot and injects into system prompt", async (t) => {
  const { store, ctx, broadcasts } = setup(t);
  const botSession = store.createSession({ title: "博客管理员", roleDescription: "维护个人博客" });
  const botCtx = () =>
    ctx({
      senderSessionId: botSession.id,
      senderBot: botSession,
    });

  const created = await runBotCollabTool(
    "schedule_manage",
    {
      action: "create",
      title: "每日博客流量统计日报",
      prompt: "统计服务器 Caddy 日志今日 PV/UV（排除本人 IP），在当前窗口发送日报并发邮件到 you@example.com",
      repeat: "daily",
      schedule_label: "每天 21:00",
      time: "21:00",
    },
    botCtx()
  );
  assert.equal(created.ok, true);
  assert.equal(created.schedule.sessionId, botSession.id);
  assert.equal(created.schedule.title, "每日博客流量统计日报");
  assert.equal(created.schedule.scheduleLabel, "每天 21:00");
  assert.equal(created.schedule.repeat, "daily");
  assert.equal(created.schedule.enabled, true);
  const runDate = new Date(created.schedule.nextRunAt);
  assert.equal(runDate.getHours(), 21);
  assert.equal(runDate.getMinutes(), 0);
  assert.ok(broadcasts.some((b) => b.type === "schedules_updated"));

  const listed = await runBotCollabTool("schedule_manage", { action: "list" }, botCtx());
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 1);
  assert.equal(listed.schedules[0].title, "每日博客流量统计日报");

  // Prompt injection includes Bot's active scheduled routines
  const sysPrompt = buildSystemInstruction({
    enableBotTools: true,
    botIdentity: {
      name: botSession.title,
      rolePrompt: botSession.rolePrompt,
      schedules: store.readSchedules().filter((s) => s.sessionId === botSession.id),
    },
  });
  assert.ok(sysPrompt.includes("Your Scheduled Routines"));
  assert.ok(sysPrompt.includes("每日博客流量统计日报"));
  assert.ok(sysPrompt.includes("每天 21:00"));
  assert.ok(sysPrompt.includes("schedule_manage"));

  // Update schedule time
  const updated = await runBotCollabTool(
    "schedule_manage",
    {
      action: "update",
      schedule: "博客流量",
      schedule_label: "每天 22:30",
      time: "22:30",
    },
    botCtx()
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.schedule.scheduleLabel, "每天 22:30");
  assert.equal(new Date(updated.schedule.nextRunAt).getHours(), 22);
  assert.equal(new Date(updated.schedule.nextRunAt).getMinutes(), 30);

  // Toggle pause
  const toggled = await runBotCollabTool(
    "schedule_manage",
    {
      action: "toggle",
      schedule: "博客流量",
    },
    botCtx()
  );
  assert.equal(toggled.ok, true);
  assert.equal(toggled.schedule.enabled, false);

  // Remove
  const removed = await runBotCollabTool(
    "schedule_manage",
    {
      action: "remove",
      schedule: "博客流量",
    },
    botCtx()
  );
  assert.equal(removed.ok, true);
  assert.equal(
    store.readSchedules().filter((s) => s.sessionId === botSession.id).length,
    0
  );
});

test("bot_manage supports update_profile, clone, and update_group_members", async (t) => {
  const { store, ctx, broadcasts } = setup(t);
  const botSession = store.createSession({
    title: "旧管家",
    rolePrompt: "初始职责",
    avatar: { shape: "blob", color: "sky" },
    memories: [{ id: "m1", name: "规则1", content: "每天备份", enabled: true }],
  });
  const botCtx = () =>
    ctx({
      senderSessionId: botSession.id,
      senderBot: store.getSession(botSession.id),
    });

  const updated = await runBotCollabTool(
    "bot_manage",
    {
      action: "update_profile",
      name: "新博客管家",
      role_prompt: "负责维护个人博客与统计日报",
      shape: "sparkle",
      color: "green",
    },
    botCtx()
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.bot.name, "新博客管家");
  assert.equal(updated.bot.avatar.shape, "sparkle");
  assert.equal(updated.bot.avatar.color, "green");
  assert.ok(broadcasts.some((b) => b.type === "session_updated" && b.sessionId === botSession.id));

  const cloned = await runBotCollabTool(
    "bot_manage",
    {
      action: "clone",
      name: "SEO 专员",
      role_prompt: "专注分析搜索引擎收录情况",
    },
    botCtx()
  );
  assert.equal(cloned.ok, true);
  assert.equal(cloned.bot.name, "SEO 专员");
  const clonedSession = store.getSession(cloned.bot.id);
  assert.equal(clonedSession!.memories!.length, 1);
  assert.ok(clonedSession!.rolePrompt!.includes("专注分析搜索引擎收录情况"));

  const grp = store.createSession({
    title: "运营群",
    type: "group",
    memberBotIds: [botSession.id],
  });
  const grpUpdated = await runBotCollabTool(
    "bot_manage",
    {
      action: "update_group_members",
      group: grp.id,
      add_bots: ["SEO 专员"],
    },
    botCtx()
  );
  assert.equal(grpUpdated.ok, true);
  assert.equal(grpUpdated.memberBotIds.length, 2);
});

test("workspace_search supports search, recent_messages, and read_exchange across Bots", async (t) => {
  const { store, ctx } = setup(t);
  const vpsBot = store.createSession({ title: "VPS 调研员", rolePrompt: "服务器运维" });
  store.appendEvent(vpsBot.id, {
    type: "answer",
    text: "Caddy 日志位于 /var/log/caddy-access.log，已开启 JSON 格式。",
  });
  store.recordExchangeMessage({
    fromBot: { id: "s1", title: "Nori" },
    toBot: vpsBot,
    text: "请帮我确认 Caddy 日志路径",
  });

  const searchRes = await runBotCollabTool(
    "workspace_search",
    { action: "search", query: "caddy-access.log" },
    ctx()
  );
  assert.equal(searchRes.ok, true);
  assert.equal(searchRes.messages.length, 1);
  assert.equal(searchRes.messages[0].sessionTitle, "VPS 调研员");

  const recentRes = await runBotCollabTool(
    "workspace_search",
    { action: "recent_messages", peer_bot: "VPS 调研员", limit: 5 },
    ctx()
  );
  assert.equal(recentRes.ok, true);
  assert.equal(recentRes.messages.length, 1);
  assert.ok(recentRes.messages[0].text.includes("caddy-access.log"));

  const exchRes = await runBotCollabTool(
    "workspace_search",
    { action: "read_exchange", peer_bot: "VPS 调研员" },
    ctx()
  );
  assert.equal(exchRes.ok, true);
  assert.equal(exchRes.messages.length, 1);
  assert.equal(exchRes.messages[0].text, "请帮我确认 Caddy 日志路径");
});

test("library_manage and vault_manage list and persist notes/contacts cleanly", async (t) => {
  const { store, ctx, broadcasts } = setup(t);
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "gb-libws-"));
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));
  const libCtx = () => ctx({ config: { writeRoots: [tmpWs] } });

  const noteRes = await runBotCollabTool(
    "library_manage",
    {
      action: "save_note",
      title: "服务器 IP 清单",
      content: "# 节点列表\n- 主站: 203.0.113.10",
    },
    libCtx()
  );
  assert.equal(noteRes.ok, true);
  assert.ok(broadcasts.some((b) => b.type === "library_updated"));

  const libList = await runBotCollabTool("library_manage", { action: "list" }, libCtx());
  assert.equal(libList.ok, true);
  assert.ok(libList.items.some((it: any) => it.name.includes("服务器_IP_清单")));

  const vaultSaved = await runBotCollabTool(
    "vault_manage",
    {
      action: "save",
      title: "工作常用 QQ 邮箱",
      subtitle: "blog-digest@example.com",
      notes: "每日博客流量统计收件箱",
    },
    libCtx()
  );
  assert.equal(vaultSaved.ok, true);
  assert.equal(vaultSaved.created, true);
  assert.ok(broadcasts.some((b) => b.type === "vault_updated"));

  const vaultList = await runBotCollabTool("vault_manage", { action: "list" }, libCtx());
  assert.equal(vaultList.ok, true);
  assert.ok(vaultList.items.some((it: any) => it.subtitle === "blog-digest@example.com"));

  const sysPrompt = buildSystemInstruction({
    enableBotTools: true,
    vaultItems: store.readVault(),
  });
  assert.ok(sysPrompt.includes("blog-digest@example.com"));
  assert.ok(sysPrompt.includes("每日博客流量统计收件箱"));

  const vaultRemoved = await runBotCollabTool(
    "vault_manage",
    { action: "remove", item: "blog-digest@example.com" },
    libCtx()
  );
  assert.equal(vaultRemoved.ok, true);
  assert.ok(!store.readVault().some((it) => it.subtitle === "blog-digest@example.com"));
});

test("system_diagnostics status reports session cost, executor health, and mcp status", async (t) => {
  const { store, ctx } = setup(t);
  const botSession = store.createSession({ title: "Nori" });
  const diag = await runBotCollabTool(
    "system_diagnostics",
    { action: "status" },
    ctx({
      senderSessionId: botSession.id,
      senderBot: botSession,
      executor: {
        health: async () => ({ status: "ok", display: ":1" }),
      },
      mcpManager: {
        getServerStatus: async () => ({ serverId: "kimi-cu", connected: false, error: "not running" }),
      },
    })
  );
  assert.equal(diag.ok, true);
  assert.equal(diag.botComputer.online, true);
  assert.equal(diag.kimiCuSkill.mcpStatus.serverId, "kimi-cu");
  assert.ok(diag.sessionUsage);
});

