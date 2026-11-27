import test from "node:test";
import assert from "node:assert/strict";
import { readWebSourceTs, renderAppHtml, renderFullAppHtml } from "./helpers/react-test-helpers.js";

const html = renderFullAppHtml();
const appJs = readWebSourceTs();

test("skills store modal has GrokBot three-view structure", () => {
  for (const id of ["skills-store-view", "skills-manage-view", "skill-detail-view"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes("技能商店"));
  assert.ok(html.includes("已添加"));
  assert.ok(html.includes("在技能中搜索"));
  assert.ok(html.includes("管理已添加技能"));
  for (const f of ["all", "office", "platform"]) {
    assert.ok(html.includes(`data-skill-filter="${f}"`), `missing filter ${f}`);
  }
  assert.ok(!html.includes('data-skill-filter="custom"'), "custom filter should not be in skills store");
  assert.ok(html.includes('id="global-memories-list"'), "global memories list should live in settings");
  assert.ok(html.includes("全局记忆"));
  assert.ok(html.includes('id="bot-memory-section"'), "per-bot memory section should live in right inspector");
  assert.ok(html.includes('id="bot-memories-list"'), "per-bot memories list should live in right inspector");
  assert.ok(html.includes("专属记忆"));
  assert.equal((html.match(/class="mail-advanced-details"/g) || []).length, 2);
  assert.ok(!html.includes("连接应用"));
  assert.ok(!html.includes("provider-tab-qqmail"));
});

test("frontend wires skills APIs, SSE refresh and domain prefill", () => {
  assert.ok(appJs.includes('from "/skills-catalog.js"'));
  assert.ok(appJs.includes("inferMailServerPreset"));
  assert.ok(appJs.includes("/api/skills/"));
  assert.ok(appJs.includes('"skills_updated"'));
  assert.ok(appJs.includes("hideVaultCheckbox"));
  assert.ok(appJs.includes("resolvedText"));
  assert.ok(!appJs.includes("连接应用"));
});

test("computer settings pane adopts GrokBot dual-computer model without traffic forwarding", () => {
  assert.ok(html.includes("你的电脑"));
  assert.ok(html.includes("在这台电脑上执行"));
  assert.ok(html.includes('id="host-exec-mode-select"'));
  assert.ok(html.includes("始终允许"));
  assert.ok(html.includes("每次询问"));
  assert.ok(html.includes("从不允许"));
  assert.ok(!html.includes("经此电脑转发流量"), "must not implement traffic forwarding");
  assert.ok(!appJs.includes("经此电脑转发流量"), "must not implement traffic forwarding in JS");

  assert.ok(html.includes('id="host-device-hostname"'));
  assert.ok(html.includes('id="host-device-status-line"'));
  assert.ok(html.includes('id="computer-health-line"'));
  assert.ok(html.includes('id="settings-update-computer-btn"'));
  assert.ok(html.includes("更新 Bot 的电脑"));
  assert.ok(html.includes('id="settings-reset-computer-btn"'));
  assert.ok(!html.includes('id="auto-expand-toggle"'), "auto-expand screen toggle must be removed");
});

test("skills store supports optional platform MCP skill (kimi-cu) manual add, config and status", () => {
  for (const id of [
    "mcp-skill-config-panel",
    "mcp-status-badge",
    "mcp-status-detail",
    "mcp-tools-chips",
    "mcp-config-json-input",
    "mcp-save-reconnect-btn",
    "mcp-test-reconnect-btn",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.equal(
    (html.match(/class="mail-advanced-details"/g) || []).length,
    2,
    "mail-advanced-details count must remain 2"
  );
  assert.ok(appJs.includes("/api/mcp/status"));
  assert.ok(appJs.includes("/api/mcp/reconnect"));
  assert.ok(appJs.includes("/api/computer/update"));
  assert.ok(appJs.includes("hostComputer"));
  assert.ok(appJs.includes("mcpServers"));
  assert.ok(appJs.includes("mcp__kimi_cu__"));
});

test("skills store renders kimi-cu as macOS-only disabled row sorted after supported skills on Windows", () => {
  const baseCatalog = {
    office: [
      { id: "qqmail", name: "QQ 邮箱", desc: "收发邮件", installed: true, removable: true },
      { id: "custom-mail", name: "通用邮箱", desc: "收发邮件", installed: true, removable: true },
    ],
    platform: [
      {
        id: "kimi-cu",
        name: "KimiCU 桌面软件操控",
        desc: "操控 Mac 软件",
        category: "platform",
        builtin: false,
        removable: true,
        supportedPlatforms: ["darwin"],
        mcpServerId: "kimi-cu",
        installed: false,
        supported: false,
      },
      {
        id: "feishu-bot",
        name: "飞书机器人",
        desc: "飞书对话渠道",
        category: "platform",
        builtin: false,
        removable: true,
        installed: false,
        supported: true,
      },
      {
        id: "telegram-bot",
        name: "Telegram 机器人",
        desc: "Telegram 对话渠道",
        category: "platform",
        builtin: false,
        removable: true,
        installed: false,
        supported: true,
      },
    ],
  };

  const winHtml = renderAppHtml({
    appsModalOpen: true,
    skillsView: "store",
    settings: {
      hostPlatform: "win32",
      hostComputer: { executionMode: "always" },
      skillsCatalog: baseCatalog,
      installedSkills: ["qqmail", "custom-mail"],
      mailAccounts: [],
    },
  });

  assert.ok(winHtml.includes('data-skill-id="kimi-cu"'));
  assert.ok(winHtml.includes('data-skill-unsupported="true"'));
  assert.ok(winHtml.includes("is-unsupported"));
  assert.ok(winHtml.includes('title="该技能仅支持 macOS 宿主机，当前系统暂不支持添加"'));
  assert.ok(winHtml.includes("当前系统暂不支持"));
  const winKimiSlice = winHtml.slice(winHtml.indexOf('data-skill-id="kimi-cu"'));
  assert.ok(winKimiSlice.includes('class="skill-pill-btn is-unsupported"'));
  assert.ok(winKimiSlice.includes('disabled=""'));
  assert.ok(winKimiSlice.includes(">添加</button>"));
  assert.ok(
    winHtml.indexOf('data-skill-id="feishu-bot"') < winHtml.indexOf('data-skill-id="kimi-cu"'),
    "supported platform skills should appear before unsupported kimi-cu on Windows"
  );

  const macHtml = renderAppHtml({
    appsModalOpen: true,
    skillsView: "store",
    settings: {
      hostPlatform: "darwin",
      hostComputer: { executionMode: "always" },
      skillsCatalog: {
        ...baseCatalog,
        platform: baseCatalog.platform.map((s) =>
          s.id === "kimi-cu" ? { ...s, supported: true } : s
        ),
      },
      installedSkills: ["qqmail", "custom-mail"],
      mailAccounts: [],
    },
  });

  assert.ok(!macHtml.includes('data-skill-unsupported="true"'));
  const macKimiSlice = macHtml.slice(
    macHtml.indexOf('data-skill-id="kimi-cu"'),
    macHtml.indexOf('data-skill-id="feishu-bot"')
  );
  assert.ok(macKimiSlice.includes(">添加</button>"));
});
