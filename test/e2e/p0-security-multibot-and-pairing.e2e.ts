import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessToolCall } from "../../src/agent/policy.js";
import { runTool } from "../../src/agent/tools.js";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { startMockLlmServer } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

function findLocalLanIpv4(): string {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const addr of list || []) {
      if (addr.family === "IPv4" && !addr.internal && addr.address) {
        return addr.address;
      }
    }
  }
  return "";
}

test("P0 Suite 2: Security Redlines, Approvals, Secret Zero-Leak, Multi-Bot Core & Non-Loopback LAN Pairing", async (t) => {
  const collector = createSuiteCollector("p0-security-multibot-and-pairing");
  const mockLlm = await startMockLlmServer();
  t.after(() => mockLlm.close());

  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  // Listen on 0.0.0.0 so non-loopback LAN pairing test hits real deviceAuth!
  const ws = await createE2EWorkspace({
    host: "0.0.0.0",
    lanAccess: true,
    mockLlm,
    smartRouter: false,
  });
  t.after(() => ws.close());

  const adminBot = ws.store.ensureAdminBot();

  // ---------- P0-SEC-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-SEC-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "硬编码安全禁区强制拦截：.ssh / .env / *auth*.json / devices.json / Keychain dump",
      module: "Policy / Static Guard",
    },
    async () => {
      const wildcardPolicyConfig = {
        ...ws.config,
        sandboxMode: "full",
        policy: {
          autoAudit: true,
          allowRules: [
            { tool: "read_file", pattern: "*" },
            { tool: "write_file", pattern: "*" },
            { tool: "host_run_shell", pattern: "*" },
          ],
          askRules: [],
        },
      };
      for (const badPath of [
        `${os.homedir()}/.ssh/id_rsa`,
        `${ws.workspaceDir}/.env`,
        `${ws.workspaceDir}/mail-auth.json`,
        `${ws.dataDir}/devices.json`,
      ]) {
        const dec = assessToolCall("read_file", { path: badPath }, wildcardPolicyConfig);
        assert.equal(dec.decision, "deny", `Expected deny for ${badPath}`);
      }
      const kc = assessToolCall(
        "host_run_shell",
        { command: "security dump-keychain -d login.keychain" },
        wildcardPolicyConfig
      );
      assert.equal(kc.decision, "deny", "Keychain dump must always be denied");

      const staticRes = await fetch(
        `${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(`${ws.workspaceDir}/.env`)}`
      );
      assert.equal(staticRes.status, 403);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-SEC-02 ----------
  await collector.runCase(
    t,
    {
      id: "P0-SEC-02",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "ApprovalCard 审批闭环：单次允许、暂不允许与 Escape 快捷键拒绝",
      module: "Interactive Approval",
    },
    async () => {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('Twinkle') &&
         document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`
      );

      let shellCalled = 0;
      const origCall = ws.executor.call;
      ws.executor.call = async (route: string, body?: any, opts?: any) => {
        if (route === "/shell") shellCalled += 1;
        return origCall(route, body, opts);
      };

      try {
        // 1. Approve once
        let step = 0;
        mockLlm.setHandler(async ({ body }) => {
          const s = JSON.stringify(body?.messages || "");
          if (
            s.includes("ultra-short Chinese phrase") ||
            s.includes("Distill the current task progress") ||
            s.includes("短语") ||
            s.includes("概括")
          )
            return { text: "等待批准" };
          step += 1;
          if (step === 1) {
            return {
              toolCalls: [{ id: "app-1", name: "run_shell", args: { command: "echo approve-once-ok", risk: "high" } }],
            };
          }
          return { text: "单次审批放行完成" };
        });

        await chrome!.typeText("#message-input", "跑一个需审批的命令", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(`Boolean(document.querySelector('.confirm-card:not(.is-collapsed)'))`, 8000);
        assert.equal(shellCalled, 0, "Tool must NOT execute before approval");

        await chrome!.click(".confirm-card:not(.is-collapsed) .btn-approve");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('单次审批放行完成'))`,
          8000
        );
        assert.equal(shellCalled, 1);

        // 2. Deny via Escape key
        step = 0;
        mockLlm.setHandler(async ({ body }) => {
          const s = JSON.stringify(body?.messages || "");
          if (
            s.includes("ultra-short Chinese phrase") ||
            s.includes("Distill the current task progress") ||
            s.includes("短语") ||
            s.includes("概括")
          )
            return { text: "等待批准" };
          step += 1;
          if (step === 1) {
            return {
              toolCalls: [{ id: "app-2", name: "run_shell", args: { command: "echo should-deny-esc", risk: "high" } }],
            };
          }
          return { text: "用户按Escape拒绝了操作" };
        });

        await chrome!.typeText("#message-input", "触发Escape拒绝", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(`Boolean(document.querySelector('.confirm-card:not(.is-collapsed)'))`, 8000);
        await chrome!.pressKey("Escape");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('用户按Escape拒绝了操作'))`,
          8000
        );
        assert.equal(shellCalled, 1, "Denied tool must not execute");
      } finally {
        ws.executor.call = origCall;
        mockLlm.setHandler(undefined);
      }
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-SEC-03 ----------
  await collector.runCase(
    t,
    {
      id: "P0-SEC-03",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "ApprovalCard 始终允许持久化 allowRules 与 risk=high 不可绕过保护",
      module: "Policy AllowRules",
    },
    async () => {
      // Configure hostExecutionMode = ask so host_run_shell triggers confirm unless allowlisted
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostComputer: { executionMode: "ask" } }),
      });

      let step = 0;
      mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (
          s.includes("ultra-short Chinese phrase") ||
          s.includes("Distill the current task progress") ||
          s.includes("短语") ||
          s.includes("概括")
        )
          return { text: "等待授权" };
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{ id: "alw-1", name: "host_run_shell", args: { command: "echo always-rule-marker", risk: "medium" } }],
          };
        }
        return { text: "始终允许规则已生效" };
      });

      await chrome!.typeText("#message-input", "测试始终允许", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.confirm-card:not(.is-collapsed)'))`, 8000);
      await chrome!.click(".confirm-card:not(.is-collapsed) .btn-always-allow");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('始终允许规则已生效'))`,
        8000
      );

      const settings = ws.store.readSettings();
      assert.ok(
        (settings.policy?.allowRules || []).some((r: any) => r.tool === "host_run_shell"),
        "allowRules must be persisted to settings.json"
      );

      // Verify medium-risk same pattern now allows automatically, while risk: "high" still confirms!
      const medDecision = assessToolCall(
        "host_run_shell",
        { command: "echo always-rule-marker", risk: "medium" },
        { ...ws.config, hostExecutionMode: "ask", policy: settings.policy }
      );
      assert.equal(medDecision.decision, "allow");

      const highDecision = assessToolCall(
        "host_run_shell",
        { command: "echo always-rule-marker", risk: "high" },
        { ...ws.config, hostExecutionMode: "ask", policy: settings.policy }
      );
      assert.equal(highDecision.decision, "confirm", "risk=high must NEVER be bypassed by allowRules");

      mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-SEC-04 ----------
  await collector.runCase(
    t,
    {
      id: "P0-SEC-04",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "CredentialCard 加密凭据零明文泄漏：browser_type 真实输入、禁入 run_shell、Vault 仅存非敏元数据",
      module: "Credential Secret Ref",
    },
    async () => {
      const secretSession = ws.store.createSession({ title: "SecretZeroLeakBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('SecretZeroLeakBot'))`
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('SecretZeroLeakBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('SecretZeroLeakBot')`, 6000);

      let step = 0;
      let capturedRef = "";
      mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "等待凭据" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [
              {
                id: "cred-1",
                name: "request_credential",
                args: { service: "PortalAccount", label: "登录密码", field_type: "password" },
              },
            ],
          };
        }
        if (step === 2) {
          const m = s.match(/\{\{secret:cred_[a-f0-9]+\}\}/);
          capturedRef = m ? m[0] : "";
          return {
            toolCalls: [
              {
                id: "cred-2",
                name: "browser_type",
                args: { ref: "e1", text: capturedRef, submit: false, clear: true, risk: "low" },
              },
            ],
          };
        }
        return { text: "安全登录流程完成" };
      });

      await chrome!.typeText("#message-input", "请求登录密码并填入网页", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.credential-card:not(.is-collapsed)'))`, 8000);

      const plaintextSecret = "SuperSecretPwd!2026";
      await chrome!.fill(".credential-card:not(.is-collapsed) .credential-secret-input", plaintextSecret);
      // Check "Save to Vault" checkbox
      const isChecked = await chrome!.evalJs<boolean>(
        `Boolean(document.querySelector('.credential-card:not(.is-collapsed) .credential-vault-check input')?.checked)`
      );
      if (!isChecked) {
        await chrome!.click(".credential-card:not(.is-collapsed) .credential-vault-check input");
      }
      await chrome!.click(".credential-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('安全登录流程完成'))`,
        8000
      );
      mockLlm.setHandler(undefined);

      assert.ok(capturedRef.startsWith("{{secret:cred_"), "Model must receive opaque secret_ref");
      const browserTypeCall = ws.executorCalls.find((c) => c.route === "/browser/type");
      assert.equal(browserTypeCall?.body?.text, plaintextSecret, "Executor /browser/type must receive resolved plaintext");

      // Check zero plaintext in DOM, NDJSON, History, and Vault!
      const bodyText = await chrome!.evalJs<string>(`document.body.innerText`);
      assert.ok(!bodyText.includes(plaintextSecret), "DOM must not contain plaintext secret");
      const ndjson = fs.readFileSync(path.join(ws.dataDir, "sessions", `${secretSession.id}.ndjson`), "utf8");
      const histJson = fs.readFileSync(path.join(ws.dataDir, "sessions", `${secretSession.id}.history.json`), "utf8");
      const vaultJson = fs.readFileSync(path.join(ws.dataDir, "vault.json"), "utf8");
      assert.ok(!ndjson.includes(plaintextSecret), "NDJSON must never store plaintext secret");
      assert.ok(!histJson.includes(plaintextSecret), "History must never store plaintext secret");
      assert.ok(!vaultJson.includes(plaintextSecret), "Vault must only store non-secret metadata, never plaintext secret");

      // Attempting to pass secret_ref to run_shell must be rejected!
      const blocked = await runTool("run_shell", { command: `echo ${capturedRef}` }, ws.executor, { settleMs: 0 });
      assert.match(blocked.result?.error || "", /Refusing to inject credential secret_ref/);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-BOT-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-BOT-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "新建单聊 Bot(语义头像自动匹配)、右键克隆、清空历史与删除清理私有目录",
      module: "Bot Lifecycle",
    },
    async () => {
      await chrome!.click("#new-session-btn");
      await chrome!.waitFor(`!document.querySelector('#new-chat-bar')?.hidden`);
      await chrome!.fill("#new-chat-input", "蓝色代码审计助手");
      await chrome!.click("#new-chat-dropdown .new-chat-row");
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('蓝色代码审计助手')`,
        6000
      );

      // Verify semantic color matching ("蓝色" -> blue)
      const accent = await chrome!.evalJs<string>(`document.querySelector('#app-shell')?.dataset?.accentColor || ''`);
      assert.equal(accent, "blue", "Semantic avatar parser must match 蓝色 -> blue");

      const createdBot = ws.store.listSessions().find((s: any) => s.title === "蓝色代码审计助手");
      assert.ok(createdBot);
      const botWorkspace = path.join(ws.workspaceDir, "bots", createdBot!.id);
      fs.mkdirSync(botWorkspace, { recursive: true });
      fs.writeFileSync(path.join(botWorkspace, "temp.txt"), "x");

      // Right-click -> Clone
      await chrome!.rightClick(`#session-list .session-item.is-active`);
      await chrome!.waitFor(`!document.querySelector('#sidebar-context-menu')?.hidden`);
      await chrome!.click(`[data-ctx-action="clone"]`);
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('副本')`,
        6000
      );

      // Right-click -> Clear
      await chrome!.rightClick(`#session-list .session-item.is-active`);
      await chrome!.waitFor(`!document.querySelector('#sidebar-context-menu')?.hidden`);
      await chrome!.click(`[data-ctx-action="clear"]`);
      await chrome!.waitFor(`document.querySelector('#app-confirm-dialog')?.open`);
      await chrome!.click("#app-confirm-ok-btn");
      await chrome!.waitFor(`!document.querySelector('#app-confirm-dialog')?.open`);

      // Right-click original -> Delete
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('蓝色代码审计助手') && !x.textContent?.includes('副本'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent === '蓝色代码审计助手'`);
      await chrome!.rightClick(`#session-list .session-item.is-active`);
      await chrome!.waitFor(`!document.querySelector('#sidebar-context-menu')?.hidden`);
      await chrome!.click(`[data-ctx-action="delete"]`);
      await chrome!.waitFor(`document.querySelector('#app-confirm-dialog')?.open`);
      await chrome!.click("#app-confirm-ok-btn");
      await chrome!.waitFor(`!document.querySelector('#app-confirm-dialog')?.open`);
      await ws.waitUntil(() => !fs.existsSync(botWorkspace), 5000, "Bot workspace dir removed on delete");
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-BOT-02 ----------
  await collector.runCase(
    t,
    {
      id: "P0-BOT-02",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "管理员 Bot 固顶与禁删双重保护(UI隐藏删除 + API 403/400)",
      module: "Admin Bot Guard",
    },
    async () => {
      await chrome!.rightClick("#pinned-primary-bot");
      await chrome!.waitFor(`!document.querySelector('#sidebar-context-menu')?.hidden`);
      const deleteBtnHidden = await chrome!.evalJs<boolean>(
        `Boolean(document.querySelector('#sidebar-context-menu [data-ctx-action="delete"]')?.hidden)`
      );
      assert.equal(deleteBtnHidden, true, "Delete action must be hidden for Admin Bot");
      await chrome!.pressKey("Escape");

      const delRes = await fetch(`${ws.baseUrl}/api/sessions/${adminBot.id}`, { method: "DELETE" });
      assert.equal(delRes.status, 403);
      const unpinRes = await fetch(`${ws.baseUrl}/api/sessions/${adminBot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: false }),
      });
      assert.equal(unpinRes.status, 400);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-BOT-03 ----------
  await collector.runCase(
    t,
    {
      id: "P0-BOT-03",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "单 Bot 私有工作区目录隔离：跨 Bot 文件读取 403 与资料库隔离",
      module: "Workspace Isolation",
    },
    async () => {
      const botA = ws.store.createSession({ title: "IsoBotA" });
      const botB = ws.store.createSession({ title: "IsoBotB" });
      const dirB = path.join(ws.workspaceDir, "bots", botB.id);
      fs.mkdirSync(dirB, { recursive: true });
      const fileB = path.join(dirB, "secret-b.txt");
      fs.writeFileSync(fileB, "only-for-b", "utf8");

      const crossRes = await fetch(
        `${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(fileB)}&sessionId=${encodeURIComponent(botA.id)}`
      );
      assert.equal(crossRes.status, 403, "Bot A must be denied reading Bot B private file");

      const ownRes = await fetch(
        `${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(fileB)}&sessionId=${encodeURIComponent(botB.id)}`
      );
      assert.equal(ownRes.status, 200);
      assert.equal(await ownRes.text(), "only-for-b");
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-BOT-04 ----------
  await collector.runCase(
    t,
    {
      id: "P0-BOT-04",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "多选拉群、#mention-popover @Bot 自动补全点名路由与群聊发言者头部渲染",
      module: "Group Chat / Mention",
    },
    async () => {
      const m1 = ws.store.createSession({ title: "前端专家", rolePrompt: "前端工程" });
      const m2 = ws.store.createSession({ title: "测试专家", rolePrompt: "质量保障" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('测试专家'))`
      );

      // Open #new-chat-bar, switch to group mode, select 2 bots, commit group
      await chrome!.click("#new-session-btn");
      await chrome!.waitFor(`!document.querySelector('#new-chat-bar')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#new-chat-dropdown .new-chat-row'));
        const grpRow = rows.find(r => r.textContent?.includes('创建 Bot 群聊'));
        grpRow && grpRow.click();
      })()`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#new-chat-dropdown .new-chat-row'));
        rows.find(r => r.textContent?.includes('前端专家'))?.click();
        rows.find(r => r.textContent?.includes('测试专家'))?.click();
      })()`);
      await chrome!.waitFor(`!document.querySelector('#new-chat-commit-group-btn')?.hidden`);
      await chrome!.click("#new-chat-commit-group-btn");
      await chrome!.waitFor(`document.querySelector('#new-chat-bar')?.hidden`);
      await chrome!.waitFor(`Boolean(document.querySelector('#group-members-section') && !document.querySelector('#group-members-section').hidden)`);

      // Test @ mention popover autocomplete
      await chrome!.typeText("#message-input", "@测试", { clear: true });
      await chrome!.waitFor(`!document.querySelector('#mention-popover')?.hidden`);
      await chrome!.click("#mention-popover .menu-item-row");
      const inputVal = await chrome!.evalJs<string>(`document.querySelector('#message-input')?.value`);
      assert.match(inputVal, /@测试专家\s+/);

      mockLlm.setHandler(async ({ body }) => {
        const sys = String(body?.messages?.[0]?.content || "");
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "群聊协作" };
        if (sys.includes("测试专家")) return { text: "我是测试专家，收到点名！" };
        return { text: "我是前端专家" };
      });
      await chrome!.typeText("#message-input", "请汇报用例进度");
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('我是测试专家，收到点名'))`,
        10_000
      );
      mockLlm.setHandler(undefined);

      const speakerName = await chrome!.evalJs<string>(
        `Array.from(document.querySelectorAll('.msg-speaker-header')).map(x => x.textContent).join(' | ')`
      );
      assert.match(speakerName, /测试专家/);
      assert.ok(!speakerName.includes("前端专家"), "Only @mentioned bot should reply here");
      assert.ok(m1.id && m2.id);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-PAIR-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-PAIR-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "真实非回环局域网 IPv4 401 鉴权拦截 + 双标签 6 位配对码握手换取 deviceToken",
      module: "LAN Device Auth & Pairing",
    },
    async ({ setEvidence }) => {
      const lanIp = findLocalLanIpv4();
      assert.ok(lanIp && lanIp !== "127.0.0.1", "Need a non-loopback local IPv4 address for true deviceAuth test");
      const lanOrigin = `http://${lanIp}:${ws.port}`;
      setEvidence("lanOrigin", lanOrigin);

      // 1. Verify non-loopback unauthenticated request returns 401!
      const unauthRes = await fetch(`${lanOrigin}/api/sessions`);
      assert.equal(unauthRes.status, 401, "Non-loopback request without token MUST return 401");

      // 2. Desktop tab stays on loopback URL listening to WS lan_pairing_requested
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         document.documentElement.dataset.realtimeConnected === '1'`
      );

      // 3. Mobile tab initiates pairing against non-loopback lanOrigin
      const pairReqRes = await fetch(`${lanOrigin}/api/lan/pair/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceName: "E2E iPhone", platform: "ios", deviceId: "dev-e2e-1" }),
      });
      assert.equal(pairReqRes.status, 200);
      const pairReq: any = await pairReqRes.json();
      assert.ok(pairReq.pairingId);
      assert.equal(pairReq.code, undefined, "Pair request response must never expose secret code");

      // Desktop UI must automatically pop #desktop-pairing-modal with 6-digit code!
      await chrome!.waitFor(`!document.querySelector('#desktop-pairing-modal')?.hidden`, 6000);
      const code = await chrome!.evalJs<string>(
        `document.querySelector('#desktop-pairing-code-display')?.textContent?.trim() || ''`
      );
      assert.match(code, /^\d{6}$/, "Desktop pairing modal must display 6-digit PIN");

      // Verify code from non-loopback LAN origin
      const verifyRes = await fetch(`${lanOrigin}/api/lan/pair/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairingId: pairReq.pairingId,
          code,
          deviceName: "E2E iPhone",
          platform: "ios",
          deviceId: "dev-e2e-1",
        }),
      });
      assert.equal(verifyRes.status, 200);
      const verified: any = await verifyRes.json();
      assert.ok(verified.deviceToken && verified.deviceToken.length >= 32);

      // Desktop modal must auto-close on lan_device_paired broadcast!
      await chrome!.waitFor(`document.querySelector('#desktop-pairing-modal')?.hidden`, 6000);

      // Verify token works over non-loopback HTTP and WebSocket!
      const authedSessions = await fetch(`${lanOrigin}/api/sessions`, {
        headers: { Authorization: `Bearer ${verified.deviceToken}` },
      });
      assert.equal(authedSessions.status, 200);

      const wsConnected = await new Promise<boolean>((resolve) => {
        const sock = new WebSocket(`ws://${lanIp}:${ws.port}/ws?token=${encodeURIComponent(verified.deviceToken)}`);
        const timer = setTimeout(() => {
          try { sock.close(); } catch {}
          resolve(false);
        }, 4000);
        sock.addEventListener("open", () => {
          clearTimeout(timer);
          sock.close();
          resolve(true);
        });
        sock.addEventListener("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      assert.equal(wsConnected, true, "Paired deviceToken must authorize non-loopback WebSocket");

      // Verify devices.json stores tokenHash only, never plaintext deviceToken
      const devicesRaw = fs.readFileSync(path.join(ws.dataDir, "devices.json"), "utf8");
      assert.ok(!devicesRaw.includes(verified.deviceToken), "devices.json must never store plaintext deviceToken");
    },
    { getChrome: () => chrome }
  );
});
