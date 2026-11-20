import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessToolCall } from "../../src/agent/policy.js";
import { runTool } from "../../src/agent/tools.js";
import { isEncryptedEnvelope } from "../../src/lib/local-crypto.js";
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

  const ensureNavigated = async () => {
    const url = await chrome!.evalJs<string>(`window.location.href`).catch(() => "");
    if (!url.startsWith(ws.baseUrl)) {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`,
        10_000
      );
    }
  };

  // ---------- P0-SEC-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-SEC-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "硬编码安全禁区强制拦截：.ssh / .env / *auth*.json / accounts / vault / .aws / .gnupg / devices.json / Keychain dump",
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
        `${os.homedir()}/.aws/credentials`,
        `${os.homedir()}/.gnupg/secring.gpg`,
        `${ws.workspaceDir}/.env`,
        `${ws.workspaceDir}/.env.local`,
        `${ws.workspaceDir}/mail-auth.json`,
        `${ws.dataDir}/devices.json`,
        `${ws.dataDir}/accounts.json`,
        `${ws.dataDir}/desktop-config.json`,
        `${ws.dataDir}/vault.json`,
        `${ws.dataDir}/.vault.key`,
        `${ws.dataDir}/.vault.dpapi`,
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

        // Expand <details class="confirm-cmd-details"> if rendered before approving
        await chrome!.evalJs(`(() => {
          const det = document.querySelector('.confirm-card:not(.is-collapsed) .confirm-cmd-details summary');
          if (det) det.click();
        })()`);

        await chrome!.click(".confirm-card:not(.is-collapsed) .btn-approve");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('单次审批放行完成'))`,
          8000
        );
        assert.equal(shellCalled, 1);

        // 2. Deny via explicit .btn-deny button click
        step = 0;
        mockLlm.setHandler(async ({ body }) => {
          const s = JSON.stringify(body?.messages || "");
          if (s.includes("ultra-short Chinese phrase") || s.includes("Distill the current task progress") || s.includes("短语") || s.includes("概括")) {
            return { text: "等待批准" };
          }
          step += 1;
          if (step === 1) {
            return {
              toolCalls: [{ id: "app-deny-btn", name: "run_shell", args: { command: "echo should-deny-btn", risk: "high" } }],
            };
          }
          return { text: "用户点击暂不允许拒绝了操作" };
        });
        await chrome!.typeText("#message-input", "触发按钮拒绝", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(`Boolean(document.querySelector('.confirm-card:not(.is-collapsed) .btn-deny'))`, 8000);
        await chrome!.click(".confirm-card:not(.is-collapsed) .btn-deny");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('用户点击暂不允许拒绝了操作'))`,
          8000
        );
        assert.equal(shellCalled, 1, "Button-denied tool must not execute");

        // 3. Deny via Escape key
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

        // Verify POST /api/approvals/:id returns 400/404 for unknown callId
        const missingApp = await fetch(`${ws.baseUrl}/api/approvals/nonexistent-call-id`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: true }),
        });
        assert.ok(missingApp.status === 400 || missingApp.status === 404);
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
      await ensureNavigated();
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

      // askRules must take precedence over allowRules
      const askPrecedence = assessToolCall(
        "host_run_shell",
        { command: "echo always-rule-marker", risk: "medium" },
        {
          ...ws.config,
          hostExecutionMode: "ask",
          policy: {
            autoAudit: true,
            allowRules: [{ tool: "host_run_shell", pattern: "*" }],
            askRules: [{ tool: "host_run_shell", pattern: "echo always-rule-marker" }],
          },
        }
      );
      assert.equal(askPrecedence.decision, "confirm", "askRules must override allowRules");

      // autoAudit=false still enforces sensitive paths & askRules, skips automatic audit confirms
      const noAuditDecision = assessToolCall(
        "host_run_shell",
        { command: "echo safe-when-no-audit", risk: "medium" },
        {
          ...ws.config,
          hostExecutionMode: "always",
          policy: { autoAudit: false, allowRules: [], askRules: [] },
        }
      );
      assert.equal(noAuditDecision.decision, "allow");

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
      title: "CredentialCard + vault-secret-v1 全链路零泄漏：AES加密落盘、/reveal、vault_manage(get_secret)、browser_type 与 OS type_text 注入及跳过/OTP",
      module: "Credential Secret Ref & Vault Secret",
    },
    async () => {
      await ensureNavigated();
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
      let vaultSecretRef = "";
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
        if (step === 3) {
          // Retrieve encrypted password back from Vault via vault_manage(get_secret) and inject via OS type_text!
          return {
            toolCalls: [
              {
                id: "cred-3",
                name: "vault_manage",
                args: { action: "get_secret", query: "PortalAccount" },
              },
            ],
          };
        }
        if (step === 4) {
          const matches = [...s.matchAll(/\{\{secret:cred_[a-f0-9]+\}\}/g)];
          vaultSecretRef = matches.length ? matches[matches.length - 1][0] : "";
          return {
            toolCalls: [
              {
                id: "cred-4",
                name: "type_text",
                args: { text: vaultSecretRef, risk: "low" },
              },
            ],
          };
        }
        return { text: "安全登录与OS凭据注入全链路完成" };
      });

      await chrome!.typeText("#message-input", "请求登录密码并填入网页与系统输入框", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.credential-card:not(.is-collapsed)'))`, 8000);

      const plaintextSecret = "SuperSecretPwd!2026";
      await chrome!.fill(".credential-card:not(.is-collapsed) .credential-secret-input", plaintextSecret);
      const isChecked = await chrome!.evalJs<boolean>(
        `Boolean(document.querySelector('.credential-card:not(.is-collapsed) .credential-vault-check input')?.checked)`
      );
      if (!isChecked) {
        await chrome!.click(".credential-card:not(.is-collapsed) .credential-vault-check input");
      }
      await chrome!.click(".credential-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('安全登录与OS凭据注入全链路完成'))`,
        10_000
      );
      mockLlm.setHandler(undefined);

      assert.ok(capturedRef.startsWith("{{secret:cred_"), "Model must receive opaque secret_ref");
      assert.ok(vaultSecretRef.startsWith("{{secret:cred_"), "vault_manage(get_secret) must return opaque secret_ref");

      const browserTypeCall = ws.executorCalls.find((c) => c.route === "/browser/type");
      assert.equal(browserTypeCall?.body?.text, plaintextSecret, "Executor /browser/type must receive resolved plaintext");

      const osTypeCall = ws.executorCalls.find((c) => c.route === "/type");
      assert.equal(osTypeCall?.body?.text, plaintextSecret, "OS /type must receive resolved plaintext from vault_manage(get_secret)");
      assert.equal(osTypeCall?.body?.sensitive, true, "OS /type secret injection must set sensitive=true for clipboard wipe");

      // Check zero plaintext in DOM, NDJSON, History, and encrypted Vault file on disk!
      const bodyText = await chrome!.evalJs<string>(`document.body.innerText`);
      assert.ok(!bodyText.includes(plaintextSecret), "DOM must not contain plaintext secret");
      const ndjson = fs.readFileSync(path.join(ws.dataDir, "sessions", `${secretSession.id}.ndjson`), "utf8");
      const histJson = fs.readFileSync(path.join(ws.dataDir, "sessions", `${secretSession.id}.history.json`), "utf8");
      const vaultRaw = fs.readFileSync(path.join(ws.dataDir, "vault.json"), "utf8");
      assert.ok(!ndjson.includes(plaintextSecret), "NDJSON must never store plaintext secret");
      assert.ok(!histJson.includes(plaintextSecret), "History must never store plaintext secret");
      assert.ok(!vaultRaw.includes(plaintextSecret), "vault.json on disk must be AES-256-GCM encrypted (no plaintext)");
      assert.equal(isEncryptedEnvelope(JSON.parse(vaultRaw)), true, "vault.json must use encrypted envelope");

      // GET /api/vault strips password & exposes hasPassword: true; POST /api/vault/:id/reveal decrypts it
      const vaultList: any = await (await fetch(`${ws.baseUrl}/api/vault`)).json();
      const portalItem = (vaultList.items || []).find((it: any) => /PortalAccount/.test(it.title || ""));
      assert.ok(portalItem, "Saved credential must appear in GET /api/vault");
      assert.equal(portalItem.hasPassword, true, "GET /api/vault must set hasPassword=true");
      assert.equal(portalItem.password, undefined, "GET /api/vault must strip plaintext password");

      const revealRes = await fetch(`${ws.baseUrl}/api/vault/${encodeURIComponent(portalItem.id)}/reveal`, { method: "POST" });
      assert.equal(revealRes.status, 200);
      const revealed: any = await revealRes.json();
      assert.equal(revealed.password, plaintextSecret, "POST /api/vault/:id/reveal must return decrypted password");
      assert.equal((await fetch(`${ws.baseUrl}/api/vault/missing-id/reveal`, { method: "POST" })).status, 404);

      // Attempting to pass secret_ref to run_shell or using unknown/expired secret_ref must fail safely!
      const blocked = await runTool("run_shell", { command: `echo ${capturedRef}` }, ws.executor, { settleMs: 0 });
      assert.match(blocked.result?.error || "", /Refusing to inject credential secret_ref/);
      const expired = await runTool("type_text", { text: "{{secret:cred_deadbeef0000}}" }, ws.executor, { settleMs: 0 });
      assert.match(expired.result?.error || "", /expired|not found|未知|过期/i);

      // Test CredentialCard OTP field_type (saveToVault=false) + Skip (.btn-deny)
      step = 0;
      mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "等待验证码" };
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{ id: "cred-otp", name: "request_credential", args: { service: "SMSOTP", label: "短信验证码", field_type: "otp" } }],
          };
        }
        return { text: "用户跳过了验证码输入" };
      });
      await chrome!.typeText("#message-input", "请求短信验证码并跳过", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.credential-card:not(.is-collapsed)'))`, 8000);
      const otpAttrs = await chrome!.evalJs<{ ac: string; hasVaultCheck: boolean }>(`(() => {
        const card = document.querySelector('.credential-card:not(.is-collapsed)');
        const inp = card?.querySelector('.credential-secret-input');
        const chk = card?.querySelector('.credential-vault-check input');
        return { ac: inp?.getAttribute('autocomplete') || '', hasVaultCheck: Boolean(chk && chk.checked) };
      })()`);
      assert.equal(otpAttrs.ac, "one-time-code");
      assert.equal(otpAttrs.hasVaultCheck, false, "OTP credential must default saveToVault to false");
      await chrome!.click(".credential-card:not(.is-collapsed) .btn-deny");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('用户跳过了验证码输入'))`,
        8000
      );
      mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-SEC-05 ----------
  await collector.runCase(
    t,
    {
      id: "P0-SEC-05",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "双电脑权限策略矩阵(PI-010/011)：宿主机 always/ask/off、只读放行、高危命令确认、沙盒 full vs restricted 与跨 Bot 工作区确认",
      module: "Dual-Computer Policy Matrix",
    },
    async () => {
      const outsidePath = path.join(os.tmpdir(), "outside-write-root-test.txt");
      // 1. hostExecutionMode = "always": host_write_file outside writeRoots allowed, dangerous shell still confirms
      const alwaysCfg = { ...ws.config, hostExecutionMode: "always", policy: { autoAudit: true, allowRules: [], askRules: [] } };
      assert.equal(
        assessToolCall("host_write_file", { path: outsidePath, content: "ok" }, alwaysCfg).decision,
        "allow",
        "hostExecutionMode=always must allow host_write_file outside writeRoots (PI-010)"
      );
      assert.equal(
        assessToolCall("host_run_shell", { command: "rm -rf /tmp/foo", risk: "medium" }, alwaysCfg).decision,
        "confirm",
        "Dangerous shell rm must still require confirmation in always mode"
      );

      // 2. hostExecutionMode = "ask": read-only host tools allowed, write tools confirm
      const askCfg = { ...ws.config, hostExecutionMode: "ask", policy: { autoAudit: true, allowRules: [], askRules: [] } };
      assert.equal(
        assessToolCall("host_read_file", { path: outsidePath }, askCfg).decision,
        "allow",
        "Read-only host_read_file must auto-allow in ask mode"
      );
      assert.equal(
        assessToolCall("host_write_file", { path: outsidePath, content: "x" }, askCfg).decision,
        "confirm",
        "host_write_file must require confirmation in ask mode"
      );

      // 3. hostExecutionMode = "off": denies all host & MCP tools
      const offCfg = { ...ws.config, hostExecutionMode: "off", policy: { autoAudit: true, allowRules: [], askRules: [] } };
      assert.equal(assessToolCall("host_run_shell", { command: "echo hi" }, offCfg).decision, "deny");
      assert.equal(assessToolCall("mcp__kimi_cu__screenshot", {}, offCfg).decision, "deny");

      // 4. sandboxMode "full" vs "restricted"
      const fullSbox = { ...ws.config, sandboxMode: "full", policy: { autoAudit: true, allowRules: [], askRules: [] } };
      const restrictedSbox = { ...ws.config, sandboxMode: "restricted", policy: { autoAudit: true, allowRules: [], askRules: [] } };
      assert.equal(assessToolCall("run_shell", { command: "rm -rf /tmp/sbox-junk", risk: "medium" }, fullSbox).decision, "allow");
      assert.equal(assessToolCall("run_shell", { command: "rm -rf /tmp/sbox-junk", risk: "medium" }, restrictedSbox).decision, "confirm");
      assert.equal(assessToolCall("write_file", { path: outsidePath, content: "x" }, fullSbox).decision, "allow");
      assert.equal(assessToolCall("write_file", { path: outsidePath, content: "x" }, restrictedSbox).decision, "confirm");

      // 5. Cross-Bot private workspace write triggers confirm
      const botX = ws.store.createSession({ title: "PolicyBotX" });
      const botY = ws.store.createSession({ title: "PolicyBotY" });
      const crossFile = path.join(ws.workspaceDir, "bots", botY.id, "private.txt");
      const crossDec = assessToolCall(
        "write_file",
        { path: crossFile, content: "hijack" },
        { ...fullSbox, botWorkspaceSessionId: botX.id, baseWorkspaceRoot: ws.workspaceDir }
      );
      assert.equal(crossDec.decision, "confirm", "Cross-Bot private workspace access must require confirmation");
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
      await ensureNavigated();
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

      // Right-click -> Clone & Rename
      await chrome!.rightClick(`#session-list .session-item.is-active`);
      await chrome!.waitFor(`!document.querySelector('#sidebar-context-menu')?.hidden`);
      await chrome!.click(`[data-ctx-action="clone"]`);
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('副本')`,
        6000
      );

      // Verify context menu rename focuses #inspector-bot-name-input and saves
      await chrome!.rightClick(`#session-list .session-item.is-active`);
      await chrome!.waitFor(`!document.querySelector('#sidebar-context-menu')?.hidden`);
      await chrome!.click(`[data-ctx-action="rename"]`);
      await chrome!.waitFor(`document.activeElement?.id === 'inspector-bot-name-input'`, 4000);
      await chrome!.fill("#inspector-bot-name-input", "蓝色审计副本重命名");
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('蓝色审计副本重命名')`, 5000);

      // Direct API /clone & /clear smoke check
      const apiClone = await fetch(`${ws.baseUrl}/api/sessions/${createdBot!.id}/clone`, { method: "POST" });
      assert.equal(apiClone.status, 201);
      const clonedJson: any = await apiClone.json();
      assert.ok(clonedJson?.id, "POST /api/sessions/:id/clone must return cloned session with id");
      assert.equal((await fetch(`${ws.baseUrl}/api/sessions/${clonedJson.id}/clear`, { method: "POST" })).status, 200);
      await fetch(`${ws.baseUrl}/api/sessions/${clonedJson.id}`, { method: "DELETE" });

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
      await ensureNavigated();
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

      // Non-admin Bot trying to pin itself must be rejected with 400
      const normalBot = ws.store.createSession({ title: "NonAdminPinTest" });
      const pinNonAdmin = await fetch(`${ws.baseUrl}/api/sessions/${normalBot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      assert.equal(pinNonAdmin.status, 400);
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
      await ensureNavigated();
      const m1 = ws.store.createSession({ title: "前端专家", rolePrompt: "前端工程" });
      const m2 = ws.store.createSession({ title: "测试专家", rolePrompt: "质量保障" });
      const m3 = ws.store.createSession({ title: "后端专家", rolePrompt: "服务架构" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('后端专家'))`
      );

      // Open #new-chat-bar, switch to group mode, test chip remove + Backspace pop + <2 hides commit
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
      })()`);
      const commitHiddenWithOne = await chrome!.evalJs<boolean>(
        `Boolean(document.querySelector('#new-chat-commit-group-btn')?.hidden)`
      );
      assert.equal(commitHiddenWithOne, true, "<2 recipients must hide commit group button");
      // Backspace removes the chip
      await chrome!.click("#new-chat-input");
      await chrome!.pressKey("Backspace");
      const chipCountAfterPop = await chrome!.evalJs<number>(`document.querySelectorAll('#new-chat-bar .new-chat-chip').length`);
      assert.equal(chipCountAfterPop, 0, "Backspace on empty input must pop last group chip");

      // Select 2 bots and commit group
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#new-chat-dropdown .new-chat-row'));
        rows.find(r => r.textContent?.includes('前端专家'))?.click();
        rows.find(r => r.textContent?.includes('测试专家'))?.click();
      })()`);
      await chrome!.waitFor(`!document.querySelector('#new-chat-commit-group-btn')?.hidden`);
      await chrome!.click("#new-chat-commit-group-btn");
      await chrome!.waitFor(`document.querySelector('#new-chat-bar')?.hidden`);
      await chrome!.waitFor(`Boolean(document.querySelector('#group-members-section') && !document.querySelector('#group-members-section').hidden)`);

      // Test RightInspector Group Member Add & Remove (+ <2 guard)
      await chrome!.click("#add-group-member-btn");
      await chrome!.waitFor(`document.querySelectorAll('#group-members-list .grouped-row-btn').length >= 3`, 5000);
      // Remove the 3rd member via ConfirmDialog
      await chrome!.evalJs(`(() => {
        const btns = Array.from(document.querySelectorAll('#group-members-list .section-action-link.danger-text'));
        btns[btns.length - 1]?.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#app-confirm-dialog')?.open`, 4000);
      await chrome!.click("#app-confirm-ok-btn");
      await chrome!.waitFor(`document.querySelectorAll('#group-members-list .grouped-row-btn').length === 2`, 5000);
      assert.ok(m3.id);

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

      // Verify GET /api/discovery/info public handshake endpoint
      const discInfo: any = await (await fetch(`${lanOrigin}/api/discovery/info`)).json();
      assert.equal(discInfo.lanAccessEnabled, true);
      assert.ok(discInfo.instanceId && discInfo.appVersion);

      // Verify devices.json stores tokenHash only, never plaintext deviceToken
      const devicesRaw = fs.readFileSync(path.join(ws.dataDir, "devices.json"), "utf8");
      assert.ok(!devicesRaw.includes(verified.deviceToken), "devices.json must never store plaintext deviceToken");

      // Verify GET /api/lan/devices lists device without tokenHash, and DELETE /api/lan/devices/:id revokes it immediately
      const devList: any = await (await fetch(`${ws.baseUrl}/api/lan/devices`)).json();
      assert.ok(Array.isArray(devList.devices) && devList.devices.length >= 1);
      assert.equal(devList.devices[0].tokenHash, undefined, "GET /api/lan/devices must never expose tokenHash");
      const devId = devList.devices.find((d: any) => d.deviceName === "E2E iPhone")?.id || devList.devices[0].id;
      const revRes = await fetch(`${ws.baseUrl}/api/lan/devices/${encodeURIComponent(devId)}`, { method: "DELETE" });
      assert.equal(revRes.status, 200);
      assert.equal((await fetch(`${ws.baseUrl}/api/lan/devices/missing-dev-id`, { method: "DELETE" })).status, 404);
      const revokedHttp = await fetch(`${lanOrigin}/api/sessions`, {
        headers: { Authorization: `Bearer ${verified.deviceToken}` },
      });
      assert.equal(revokedHttp.status, 401, "Revoked deviceToken must immediately return 401");
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-MEM-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-MEM-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "自动与显式双路径记忆系统(PI-016)：显式「记住」直存、自动触发静默落库(零推荐卡片)、异步快模型提炼去重/防密钥与兼容 /resolve 校验",
      module: "Auto & Explicit Memory System",
    },
    async ({ setEvidence }) => {
      await ensureNavigated();
      const memBot = ws.store.createSession({ title: "DualTrackMemoryBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('DualTrackMemoryBot'))`,
        8000
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('DualTrackMemoryBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('DualTrackMemoryBot')`, 6000);

      // 1. Auto-triggered save, explicit save, and post-turn fast-tier extractor ALL write silently & directly (zero suggestion cards!)
      let phase: "auto" | "explicit" | "extractor" = "auto";
      let step = 0;
      mockLlm.setHandler(async ({ body }) => {
        const msgStr = JSON.stringify(body?.messages || "");
        // Post-turn memory extractor prompt detection
        if (msgStr.includes("memory extractor") || msgStr.includes("记忆提取") || msgStr.includes('"candidates"')) {
          if (phase === "extractor") {
            return {
              text: JSON.stringify({
                candidates: [
                  { scope: "global", name: "报告偏好", content: "周报统一使用 Markdown 三段式格式", confidence: 0.92 },
                  { scope: "bot", name: "密钥过滤", content: "密码: sk-secret999999999999", confidence: 0.98 },
                ],
              }),
            };
          }
          return { text: JSON.stringify({ candidates: [] }) };
        }
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "整理记忆" };
        step += 1;
        if (phase === "auto" && step === 1) {
          return {
            toolCalls: [
              {
                id: "mem-auto-1",
                name: "memory_manage",
                args: { action: "save", scope: "bot", name: "语言习惯", content: "回答保持极简中文风格", trigger: "auto" },
              },
            ],
          };
        }
        if (phase === "auto") {
          return { text: "好的，接口性能优化重点如下" };
        }
        if (phase === "explicit" && step === 1) {
          return {
            toolCalls: [
              {
                id: "mem-exp-1",
                name: "memory_manage",
                args: { action: "save", scope: "bot", name: "代码规范", content: "始终使用严格 TypeScript 类型", trigger: "explicit" },
              },
            ],
          };
        }
        if (phase === "explicit") {
          return { text: "已按你的要求直接存入记忆" };
        }
        return { text: "好的，周报会按你的格式习惯处理" };
      });

      try {
        // Turn 1: Auto-triggered memory_manage(save) persists silently directly to Bot memories with ZERO suggestion cards!
        await chrome!.typeText("#message-input", "今天帮我看看接口性能就行", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('接口性能优化重点如下'))`,
          8000
        );
        await ws.waitUntil(
          () => (ws.store.getSession(memBot.id)?.memories || []).some((m: any) => /极简中文/.test(m.content || m.instruction || "")),
          5000,
          "Auto-triggered memory_manage(save) must persist directly to Bot memories"
        );
        assert.equal(
          await chrome!.evalJs<number>(`document.querySelectorAll('.memory-suggestion-card').length`),
          0,
          "Zero memory suggestion cards should be rendered in chat"
        );

        // Turn 2: Explicit "请记住..." writes directly to Bot memories without any suggestion card!
        phase = "explicit";
        step = 0;
        await chrome!.typeText("#message-input", "请记住：以后始终使用严格 TypeScript 类型", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('已按你的要求直接存入记忆'))`,
          8000
        );
        const botMems = ws.store.getSession(memBot.id)?.memories || [];
        assert.ok(
          botMems.some((m: any) => /TypeScript/.test(m.content || m.instruction || "")),
          "Explicit user intent must persist directly to Bot memories"
        );

        // Turn 3: Async post-turn fast-tier extractor silently saves global memory & filters secrets (zero cards!)
        phase = "extractor";
        step = 0;
        await chrome!.typeText("#message-input", "我习惯周报统一使用 Markdown 三段式格式发给团队", { clear: true });
        await chrome!.pressKey("Enter");
        await ws.waitUntil(
          () => (ws.store.readSettings().globalMemories || []).some((m: any) => /Markdown 三段式/.test(m.content || m.instruction || "")),
          10_000,
          "Post-turn fast-tier extractor must silently persist global memory"
        );
        assert.equal(
          (ws.store.getSession(memBot.id)?.memories || []).some((m: any) => /sk-secret/.test(m.content || "")),
          false,
          "Post-turn extractor must never persist secret-like values"
        );
        assert.equal(
          await chrome!.evalJs<number>(`document.querySelectorAll('.memory-suggestion-card').length`),
          0,
          "Post-turn extractor must render zero suggestion cards"
        );

        // 4. Backward-compatible HTTP contract on POST /api/memories/suggestions/:id/resolve for older clients
        const badResolve = await fetch(`${ws.baseUrl}/api/memories/suggestions/sug-bad/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "accept", sessionId: memBot.id, scope: "global", content: "" }),
        });
        assert.equal(badResolve.status, 400);

        const goodResolve = await fetch(`${ws.baseUrl}/api/memories/suggestions/sug-edit-1/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "accept",
            sessionId: memBot.id,
            scope: "global",
            name: "时区",
            content: "默认使用 UTC+8 北京时间",
          }),
        });
        assert.equal(goodResolve.status, 200);
        const globalMems = ws.store.readSettings().globalMemories || [];
        assert.ok(globalMems.some((m: any) => /UTC\+8/.test(m.content || m.instruction || "")));
        setEvidence("botMemoriesCount", botMems.length);
        setEvidence("globalMemoriesCount", globalMems.length);
      } finally {
        mockLlm.setHandler(undefined);
      }
    },
    { getChrome: () => chrome }
  );
});
