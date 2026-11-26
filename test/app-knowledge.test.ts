import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearKnowledgeCache,
  listKnowledgeTopics,
  readKnowledgeTopic,
  searchKnowledge,
} from "../src/agent/knowledge-loader.js";
import { BOT_COLLAB_TOOL_DECLARATIONS, runBotCollabTool } from "../src/agent/bot-tools.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { clearPromptTemplateCache } from "../src/agent/prompt-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

test("self-knowledge markdown docs load cleanly and return accurate hits across Desktop, Mobile, Relay, Cards, and Dual-Computer queries", () => {
  clearKnowledgeCache();
  const topics = listKnowledgeTopics();
  assert.equal(topics.length, 6);
  const ids = topics.map((t) => t.topic);
  for (const expectedId of [
    "ui-navigation-desktop",
    "ui-navigation-mobile",
    "chat-cards-and-workflows",
    "accounts-relay-and-updates",
    "skills-channels-and-vault",
    "computers-and-memory",
  ]) {
    assert.ok(ids.includes(expectedId), `Missing knowledge topic: ${expectedId}`);
  }

  // Search tests for Chinese product questions
  const relaySearch = searchKnowledge("外网中继在哪里设置");
  assert.ok(relaySearch.results.length >= 1);
  assert.ok(
    relaySearch.results.some((r) => r.topic === "ui-navigation-desktop" || r.topic === "accounts-relay-and-updates"),
    "Relay search should match desktop navigation or relay docs"
  );

  const shortcutSearch = searchKnowledge("全局快捷键");
  assert.equal(shortcutSearch.results[0]?.topic, "ui-navigation-desktop");

  const mobileQrSearch = searchKnowledge("手机扫码连接电脑");
  assert.ok(
    mobileQrSearch.results.some((r) => r.topic === "ui-navigation-mobile" || r.topic === "accounts-relay-and-updates")
  );

  const cardSearch = searchKnowledge("ChoiceCard 提问卡");
  assert.equal(cardSearch.results[0]?.topic, "chat-cards-and-workflows");

  const browserSearch = searchKnowledge("浏览器引擎 Headless Debug");
  assert.equal(browserSearch.results[0]?.topic, "computers-and-memory");

  // Full topic read & filtered section read
  const fullDesktop = readKnowledgeTopic("ui-navigation-desktop");
  assert.equal(fullDesktop.ok, true);
  assert.match(fullDesktop.content, /通用/);
  assert.match(fullDesktop.content, /外网中继/);
  assert.match(fullDesktop.content, /⌘K/);

  const sectionOnly = readKnowledgeTopic("ui-navigation-desktop", { section: "快捷键" });
  assert.equal(sectionOnly.ok, true);
  assert.match(sectionOnly.content, /⌘,/);
  assert.equal(sectionOnly.content.includes("## 三栏主界面结构"), false);

  const missing = readKnowledgeTopic("nonexistent-topic");
  assert.equal(missing.ok, false);
  assert.ok(Array.isArray(missing.availableTopics) && missing.availableTopics.length === 6);
});

test("app_knowledge Bot tool is registered, accessible to all Bots, and prompt includes concise self-knowledge index", async () => {
  clearPromptTemplateCache();
  assert.ok(BOT_COLLAB_TOOL_DECLARATIONS.some((d) => d.name === "app_knowledge"));

  const prompt = buildSystemInstruction({
    enableBotTools: true,
    hostExecutionMode: "always",
  });
  assert.match(prompt, /SELF-KNOWLEDGE DOCS \(app_knowledge\)/);
  assert.match(prompt, /ui-navigation-desktop/);

  const mockStore = {
    getSession: (id: string) => ({ id, isAdmin: false }),
  };
  const workerCtx: any = {
    store: mockStore,
    senderBot: { id: "worker-bot", isAdmin: false },
    senderSessionId: "worker-bot",
  };

  const listRes = await runBotCollabTool("app_knowledge", { action: "list" }, workerCtx);
  assert.equal(listRes.ok, true);
  assert.equal(listRes.topics.length, 6);

  const searchRes = await runBotCollabTool("app_knowledge", { action: "search", query: "外网中继" }, workerCtx);
  assert.equal(searchRes.ok, true);
  assert.ok(searchRes.results.length >= 1);

  const readRes = await runBotCollabTool(
    "app_knowledge",
    { action: "read", topic: "accounts-relay-and-updates" },
    workerCtx
  );
  assert.equal(readRes.ok, true);
  assert.match(readRes.content, /本地账号/);
  assert.match(readRes.content, /self_update/);
});

test("core-runtime and dist-server stage self-knowledge markdown files", () => {
  const stagedRuntimeKnowledge = path.join(PROJECT_ROOT, "dist-server", "core-runtime", "knowledge");
  const stagedServerKnowledge = path.join(PROJECT_ROOT, "dist-server", "src", "agent", "knowledge");
  for (const dir of [stagedRuntimeKnowledge, stagedServerKnowledge]) {
    assert.equal(fs.existsSync(dir), true, `Expected staged knowledge dir: ${dir}`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 6, `Expected 6 staged knowledge markdown files in ${dir}`);
  }
});
