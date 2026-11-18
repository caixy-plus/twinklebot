import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeCustomSkillSlug,
  isValidCustomSkillId,
  parseCustomSkillMarkdown,
  serializeCustomSkillMarkdown,
} from "../src/lib/custom-skills.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import { runBotCollabTool, BOT_COLLAB_TOOL_DECLARATIONS } from "../src/agent/bot-tools.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";

async function bootServer(t: any) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-custom-skills-"));
  const store = createStore(tmpDir);
  const broadcasts: any[] = [];
  const srv = createServer({
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal: (ev: any) => broadcasts.push(ev),
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      port: 0,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
      writeRoots: [tmpDir],
    },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const call = async (method: string, p: string, body?: any) => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };
  return { tmpDir, store, broadcasts, call };
}

test("SKILL.md markdown roundtrip preserves frontmatter and horizontal rules inside body", () => {
  assert.equal(normalizeCustomSkillSlug("Weekly Report! "), "weekly-report");
  assert.equal(isValidCustomSkillId("weekly-report_v2"), true);
  assert.equal(isValidCustomSkillId("../evil"), false);

  const md = serializeCustomSkillMarkdown({
    id: "weekly-report",
    name: "周报汇总发送",
    icon: "📊",
    description: "每周五汇总本周产出并邮件发送给团队",
    enabled: true,
    createdBy: "bot",
    createdByBotId: "bot-ops",
    createdByBotName: "运维助手",
    instructions: "## 步骤\n\n1. 收集产出\n\n---\n\n2. 邮件群发",
  });
  const parsed = parseCustomSkillMarkdown(md, "weekly-report");
  assert.equal(parsed.id, "weekly-report");
  assert.equal(parsed.name, "周报汇总发送");
  assert.equal(parsed.icon, "📊");
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.createdBy, "bot");
  assert.equal(parsed.createdByBotId, "bot-ops");
  assert.equal(parsed.createdByBotName, "运维助手");
  assert.match(parsed.instructions, /1\. 收集产出\n\n---\n\n2\. 邮件群发/);
});

test("store custom skills CRUD persists .md files, handles rename/toggle/delete, and rejects traversal", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-cs-store-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);

  const created = store.saveCustomSkill({
    id: "deploy-staging",
    name: "测试环境发布",
    icon: "🚀",
    description: "拉取最新代码并触发 staging 构建",
    instructions: "1. git pull\n2. npm test\n3. deploy",
    createdBy: "user",
  });
  assert.equal(created.id, "deploy-staging");
  assert.ok(fs.existsSync(path.join(tmpDir, "custom-skills", "deploy-staging.md")));

  // Slug collision on create rejected when explicit id is already used
  assert.throws(() =>
    store.saveCustomSkill({
      id: "deploy-staging",
      mode: "create",
      name: "Duplicate",
      description: "Dup",
      instructions: "Dup",
    })
  );

  // Rename slug removes old .md and writes new .md
  const renamed = store.saveCustomSkill({
    id: "deploy-staging",
    mode: "update",
    newId: "deploy-prod",
    name: "生产发布流程",
    description: "发布至生产环境",
    instructions: "1. run checks\n2. release",
  });
  assert.equal(renamed.id, "deploy-prod");
  assert.equal(fs.existsSync(path.join(tmpDir, "custom-skills", "deploy-staging.md")), false);
  assert.ok(fs.existsSync(path.join(tmpDir, "custom-skills", "deploy-prod.md")));

  // Toggle enabled/disabled
  const disabled = store.toggleCustomSkill("deploy-prod", false);
  assert.equal(disabled.enabled, false);
  assert.equal(store.listCustomSkills({ enabledOnly: true }).length, 0);
  assert.equal(store.listCustomSkills().length, 1);

  // Path traversal rejected
  assert.throws(() =>
    store.saveCustomSkill({
      id: "../../etc/passwd",
      name: "Bad",
      description: "Bad",
      instructions: "Bad",
    })
  );

  // Delete cleans up file
  const removed = store.deleteCustomSkill("deploy-prod");
  assert.equal(removed?.id, "deploy-prod");
  assert.equal(store.listCustomSkills().length, 0);
});

test("HTTP /api/custom-skills CRUD broadcasts updates and stays strictly separated from skillsCatalog", async (t) => {
  const { broadcasts, call } = await bootServer(t);

  const createRes = await call("POST", "/api/custom-skills", {
    id: "invoice-audit",
    name: "发票核验规范",
    icon: "🧾",
    description: "报销单与增值税发票字段核对 SOP",
    instructions: "### Step 1\nCheck tax ID\n### Step 2\nVerify amount",
    createdBy: "user",
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.json.skill.id, "invoice-audit");
  assert.ok(broadcasts.some((ev) => ev.type === "skills_updated"));

  // Listed on /api/custom-skills and /api/settings.customSkills, NEVER inside skillsCatalog
  const listRes = await call("GET", "/api/custom-skills");
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.customSkills.length, 1);

  const settingsRes = await call("GET", "/api/settings");
  assert.equal(settingsRes.status, 200);
  assert.equal(settingsRes.json.customSkills.length, 1);
  assert.equal(settingsRes.json.customSkills[0].id, "invoice-audit");
  const allStoreIds = [
    ...settingsRes.json.skillsCatalog.office.map((s: any) => s.id),
    ...settingsRes.json.skillsCatalog.platform.map((s: any) => s.id),
  ];
  assert.equal(allStoreIds.includes("invoice-audit"), false);
  assert.ok(allStoreIds.includes("custom-skill-manager"));

  // Toggle + Edit via PATCH
  const patchRes = await call("PATCH", "/api/custom-skills/invoice-audit", {
    enabled: false,
    description: "报销单与电子发票自动核对 SOP",
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.json.skill.enabled, false);
  assert.equal(patchRes.json.skill.description, "报销单与电子发票自动核对 SOP");

  // Delete via DELETE
  const delRes = await call("DELETE", "/api/custom-skills/invoice-audit");
  assert.equal(delRes.status, 200);
  assert.equal(delRes.json.deleted?.id, "invoice-audit");

  const afterList = await call("GET", "/api/custom-skills");
  assert.equal(afterList.json.customSkills.length, 0);
});

test("Bot tool custom_skill_manage attributes bot creator, executes CRUD, and feeds progressive-disclosure prompt", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-cs-bot-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);
  const bot = store.createSession({ title: "研发管家", avatar: "bot" });
  const otherBot = store.createSession({ title: "行政助手", avatar: "bot" });
  const broadcasts: any[] = [];

  assert.ok(BOT_COLLAB_TOOL_DECLARATIONS.some((d) => d.name === "custom_skill_manage"));

  // Bot creates a custom skill directly
  const created = await runBotCollabTool(
    "custom_skill_manage",
    {
      action: "create",
      name: "发布前自检清单",
      icon: "✅",
      description: "每次发版前运行单元测试与打包校验",
      instructions: "1. 运行 npm test\n2. 运行 node --check\n3. 汇报结果",
    },
    {
      store,
      senderSessionId: bot.id,
      senderBot: bot,
      broadcastGlobal: (ev: any) => broadcasts.push(ev),
    }
  );
  assert.equal(created.ok, true);
  assert.equal(created.skill.createdBy, "bot");
  assert.equal(created.skill.createdByBotId, bot.id);
  assert.equal(created.skill.createdByBotName, "研发管家");
  assert.ok(broadcasts.some((ev) => ev.type === "skills_updated"));

  // Cross-bot sharing: another Bot's system prompt sees only lightweight summary index, NOT full body
  const promptForOtherBot = buildSystemInstruction({
    enableBotTools: true,
    botIdentity: { name: otherBot.title },
    customSkills: store.listCustomSkills({ enabledOnly: true }),
    installedSkills: [],
  });
  assert.match(promptForOtherBot, /Shared Custom Workflow Skills/);
  assert.match(promptForOtherBot, /发布前自检清单/);
  assert.match(promptForOtherBot, /每次发版前运行单元测试与打包校验/);
  assert.match(promptForOtherBot, /custom_skill_manage\(action: "get"/);
  assert.equal(promptForOtherBot.includes("2. 运行 node --check"), false);
  // Auto-judgment instructions present
  assert.match(promptForOtherBot, /自动判断 记忆 vs 共享自定义技能/);

  // Other Bot calls `get` on demand to load full instructions
  const loaded = await runBotCollabTool(
    "custom_skill_manage",
    { action: "get", skill: "发布前自检" },
    { store, senderSessionId: otherBot.id, senderBot: otherBot }
  );
  assert.equal(loaded.ok, true);
  assert.match(loaded.skill.instructions, /2\. 运行 node --check/);

  // Update, toggle, delete via tool
  const updated = await runBotCollabTool(
    "custom_skill_manage",
    { action: "update", skill: loaded.skill.id, description: "新版发版前校验 SOP" },
    { store, senderSessionId: otherBot.id, senderBot: otherBot }
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.skill.description, "新版发版前校验 SOP");

  const toggled = await runBotCollabTool(
    "custom_skill_manage",
    { action: "toggle", skill: loaded.skill.id, enabled: false },
    { store, senderSessionId: otherBot.id, senderBot: otherBot }
  );
  assert.equal(toggled.ok, true);
  assert.equal(toggled.skill.enabled, false);

  const deleted = await runBotCollabTool(
    "custom_skill_manage",
    { action: "delete", skill: loaded.skill.id },
    { store, senderSessionId: otherBot.id, senderBot: otherBot }
  );
  assert.equal(deleted.ok, true);
  assert.equal(deleted.deleted, true);
  assert.equal(store.listCustomSkills().length, 0);
});

test("UI HTML & JS enforce Store vs Custom Skills separation and include CRUD editor controls", async () => {
  const { readWebDistJs, renderFullAppHtml } = await import("./helpers/react-test-helpers.js");
  const html = renderFullAppHtml();
  const appJs = readWebDistJs();

  assert.match(html, /id="skills-store-view"[\s\S]*?id="store-manage-custom-btn"/);
  assert.match(html, /id="skills-manage-view"[\s\S]*?id="custom-skills-section"[\s\S]*?id="custom-skill-editor-form"/);
  assert.match(html, /id="custom-skill-preview-toggle-btn"/);
  assert.match(html, /id="installed-plugins-grid"/);
  assert.match(html, /商店已添加\s*\d+\s*个\s*·\s*自定义\s*\d+\s*个/);

  assert.match(appJs, /\/api\/custom-skills/);
});
