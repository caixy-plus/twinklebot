import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import {
  createMockMcpServerScript,
  startLoopbackMailServer,
} from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P1 Suite 5: Skills Store, Custom SKILL.md, Loopback Mail (IMAP/POP3/SMTP) & kimi-cu MCP", async (t) => {
  const collector = createSuiteCollector("p1-skills-mail-and-mcp");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  const ws = await createE2EWorkspace({ smartRouter: false });
  t.after(() => ws.close());

  const mailSrv = await startLoopbackMailServer({
    validEmail: "e2e@corp.test",
    validPassword: "mail-secret-pass",
    initialMessages: [
      {
        uid: 101,
        unseen: true,
        raw: [
          "From: Boss <boss@corp.test>",
          "To: e2e@corp.test",
          "Subject: =?UTF-8?B?5ZGo5oql5o+Q6YaS?=",
          "Date: Thu, 19 Nov 2026 08:30:00 +0800",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "请查收本周 E2E 测试总结报告。",
        ].join("\r\n"),
      },
    ],
  });
  t.after(() => mailSrv.close());

  await chrome!.navigate(ws.baseUrl);
  await chrome!.waitFor(
    `document.querySelector('#header-bot-name')?.textContent?.includes('Twinkle') &&
     document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`
  );

  // ---------- P1-SKILL-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "技能商店搜索/分类筛选、内置常驻技能禁删(400)与一键创建「邮箱管家」模板 Bot",
      module: "Skills Store",
    },
    async () => {
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);

      // Filter by office vs platform & search
      await chrome!.click(`[data-skill-filter="office"]`);
      await chrome!.waitFor(`document.querySelector('#skills-store-sections')?.textContent?.includes('QQ 邮箱')`);
      await chrome!.click(`[data-skill-filter="platform"]`);
      await chrome!.waitFor(`document.querySelector('#skills-store-sections')?.textContent?.includes('KimiCU')`);
      await chrome!.click(`[data-skill-filter="all"]`);
      await chrome!.fill("#skills-search-input", "通用邮箱");
      await chrome!.waitFor(`document.querySelector('#skills-store-sections')?.textContent?.includes('通用邮箱')`);
      await chrome!.fill("#skills-search-input", "");

      // Built-in skill uninstall must return 400
      const delBuiltin = await fetch(`${ws.baseUrl}/api/skills/websearch`, { method: "DELETE" });
      assert.equal(delBuiltin.status, 400);

      // Click one-click '邮箱管家' template bot button
      await chrome!.click("#bot-templates-btn");
      await chrome!.waitFor(`document.querySelector('#apps-modal-backdrop')?.hidden`, 6000);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('邮箱管家')`, 6000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SKILL-02 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-02",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "自定义 SKILL.md 全生命周期(新建/YAML 预览/Slug 去重/重命名/启停/删除)与渐进式披露读取",
      module: "Custom Skills",
    },
    async () => {
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.click("#store-manage-custom-btn");
      await chrome!.waitFor(`!document.querySelector('#skills-manage-view')?.hidden`);

      await chrome!.click("#add-custom-skill-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('#custom-skill-editor-form'))`);
      await chrome!.fill("#custom-skill-name-input", "发布前自检");
      await chrome!.fill("#custom-skill-slug-input", "release-checklist");
      await chrome!.fill("#custom-skill-desc-input", "发版前自动核对清单");
      await chrome!.fill("#custom-skill-instructions-input", "1. 运行全量E2E\n2. 核对 SECRET_BODY_ONLY_ON_GET");

      // Toggle SKILL.md YAML frontmatter preview
      await chrome!.click("#custom-skill-preview-toggle-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('#custom-skill-md-preview'))`);
      const previewTxt = await chrome!.evalJs<string>(`document.querySelector('#custom-skill-md-preview')?.textContent || ''`);
      assert.match(previewTxt, /^---[\s\S]*name:\s*发布前自检/);
      await chrome!.click("#custom-skill-preview-toggle-btn");

      await chrome!.click("#custom-skill-save-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('[data-custom-skill-id="release-checklist"]'))`, 6000);

      // Verify on disk
      const mdFile = path.join(ws.dataDir, "custom-skills", "release-checklist.md");
      assert.ok(fs.existsSync(mdFile));

      // Verify auto-dedup slug on second creation with same name without explicit slug
      const dupRes = await fetch(`${ws.baseUrl}/api/custom-skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "发布前自检", description: "第二份", instructions: "step B" }),
      });
      assert.equal(dupRes.status, 201);
      const dup: any = await dupRes.json();
      assert.notEqual(dup.skill?.id, "release-checklist");

      // Atomic rename via PATCH newId
      const renRes = await fetch(`${ws.baseUrl}/api/custom-skills/${dup.skill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newId: "release-checklist-v2" }),
      });
      assert.equal(renRes.status, 200);
      assert.ok(fs.existsSync(path.join(ws.dataDir, "custom-skills", "release-checklist-v2.md")));

      // Verify progressive disclosure: system prompt includes summary, NOT full body; Agent calls custom_skill_manage(get)
      await chrome!.click("#close-apps-modal-btn");
      ws.mockLlm.clearRequests();
      let step = 0;
      let loadedBody = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (
          s.includes("ultra-short Chinese phrase") ||
          s.includes("Distill the current task progress") ||
          s.includes("短语") ||
          s.includes("概括")
        )
          return { text: "加载技能" };
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "cs-1", name: "custom_skill_manage", args: { action: "get", id: "release-checklist" } }] };
        }
        loadedBody = s;
        return { text: "已按需读取自定义技能步骤" };
      });
      await chrome!.typeText("#message-input", "按发布前自检执行", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('已按需读取自定义技能步骤'))`,
        8000
      );
      ws.mockLlm.setHandler(undefined);

      const firstSys = String(ws.mockLlm.capturedRequests.find((r) => String(r.body?.messages?.[0]?.content || "").includes("release-checklist"))?.body?.messages?.[0]?.content || "");
      assert.ok(firstSys.includes("release-checklist"), "System prompt must list custom skill metadata");
      assert.ok(!firstSys.includes("SECRET_BODY_ONLY_ON_GET"), "Progressive disclosure must omit full body from system prompt");
      assert.match(loadedBody, /SECRET_BODY_ONLY_ON_GET/, "Agent must receive full body on action=get");

      // Cleanup renamed skill
      assert.equal((await fetch(`${ws.baseUrl}/api/custom-skills/release-checklist-v2`, { method: "DELETE" })).status, 200);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SKILL-03 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-03",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "通用邮箱对接本地回环 IMAP/POP3/SMTP：域名预设推断、测试/发自测信/保存 + Agent 收读与草稿确认发信",
      module: "Mail Integration (Custom Mail)",
    },
    async () => {
      // Install custom-mail via UI store
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      const instRes = await fetch(`${ws.baseUrl}/api/skills/custom-mail/install`, { method: "POST" });
      assert.equal(instRes.status, 200);
      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);

      // Open custom-mail detail view
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row, #skills-store-sections .app-store-card, #skills-store-sections .skill-card'));
        const c = rows.find(el => el.textContent?.includes('通用邮箱'));
        const btn = c?.querySelector('button');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(
        `document.querySelector('#skill-detail-title')?.textContent?.includes('通用邮箱') && Boolean(document.querySelector('#custom-mail-config-form'))`,
        6000
      );

      // Verify domain auto-preset for 163.com (defaults to IMAP -> imap.163.com, switching to POP3 -> pop.163.com, back to IMAP -> imap.163.com)!
      await chrome!.fill("#custom-mail-email-input", "tester@163.com");
      await chrome!.waitFor(`document.querySelector('#custom-mail-inbound-host')?.value === 'imap.163.com'`, 4000);
      await chrome!.click("#custom-proto-pop3");
      await chrome!.waitFor(`document.querySelector('#custom-mail-inbound-host')?.value === 'pop.163.com'`, 4000);
      await chrome!.click("#custom-proto-imap");
      await chrome!.waitFor(`document.querySelector('#custom-mail-inbound-host')?.value === 'imap.163.com'`, 4000);

      // Re-point to loopback IMAP + SMTP (no TLS)
      await chrome!.fill("#custom-mail-email-input", mailSrv.validEmail);
      await chrome!.fill("#custom-mail-password-input", mailSrv.validPassword);
      await chrome!.fill("#custom-mail-label-input", "回环测试工作邮箱");
      await chrome!.click("#custom-proto-imap");
      await chrome!.fill("#custom-mail-inbound-host", "127.0.0.1");
      await chrome!.fill("#custom-mail-inbound-port", String(mailSrv.imapPort));
      // Uncheck inbound TLS
      const inTls = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('#custom-mail-inbound-tls')?.checked)`);
      if (inTls) await chrome!.click("#custom-mail-inbound-tls");
      await chrome!.click("#custom-smtp-none");
      await chrome!.fill("#custom-mail-smtp-host", "127.0.0.1");
      await chrome!.fill("#custom-mail-smtp-port", String(mailSrv.smtpPort));

      // Test connection & send self-test email & save
      await chrome!.click("#custom-mail-test-btn");
      await chrome!.waitFor(
        `document.querySelector('#custom-mail-feedback-box')?.classList.contains('is-success')`,
        6000
      );
      await chrome!.click("#custom-mail-save-btn");
      await chrome!.waitFor(`document.querySelector('#mail-accounts-list')?.textContent?.includes('e2e@corp.test')`, 6000);
      await chrome!.click("#close-apps-modal-btn");

      // Agent lists, reads MIME decoded UTF-8/RFC2047 message, and sends via mandatory DraftCard confirmation!
      let step = 0;
      let readOutput = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "处理邮件" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "ml-1", name: "mail_list_messages", args: { limit: 5 } }] };
        }
        if (step === 2) {
          return { toolCalls: [{ id: "ml-2", name: "mail_read_message", args: { uid: "101" } }] };
        }
        if (step === 3) {
          readOutput = s;
          return {
            toolCalls: [
              {
                id: "ml-3",
                name: "mail_send_message",
                args: { to: "boss@corp.test", subject: "周报回复\r\nBcc: evil@attacker.test", text: "原始回复" },
              },
            ],
          };
        }
        return { text: "邮件读取并经草稿确认发送成功" };
      });

      await chrome!.typeText("#message-input", "帮我查看最新邮件并回复老板", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.draft-card:not(.is-collapsed)'))`, 10_000);
      await chrome!.fill(".draft-card:not(.is-collapsed) .draft-body-textarea", "老板您好，已修订并确认发出！");
      await chrome!.click(".draft-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('邮件读取并经草稿确认发送成功'))`,
        10_000
      );
      ws.mockLlm.setHandler(undefined);

      assert.match(readOutput, /请查收本周 E2E 测试总结报告/);
      assert.ok(mailSrv.sentMessages.length >= 1, "SMTP server must capture sent mail");
      const lastSent = mailSrv.sentMessages[mailSrv.sentMessages.length - 1];
      assert.ok(!lastSent.raw.includes("evil@attacker.test"), "CRLF header injection must be stripped");
      assert.ok(lastSent.to.includes("boss@corp.test"));
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SKILL-04 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-04",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "QQ邮箱专项 + 对话式 skill_configure_mail 缺密凭据卡脱敏 + 卸载技能保留/清除凭据边界取证",
      module: "QQ Mail & Credential Cleanup",
    },
    async ({ setEvidence }) => {
      await fetch(`${ws.baseUrl}/api/skills/qqmail/install`, { method: "POST" });
      // Add QQ mail account pointing at loopback via API override
      const addQqRes = await fetch(`${ws.baseUrl}/api/integrations/mail/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "qqmail",
          email: mailSrv.validEmail,
          authCode: mailSrv.validPassword,
          inboundProtocol: "pop3",
          inboundHost: "127.0.0.1",
          inboundPort: mailSrv.pop3Port,
          inboundTls: false,
          smtpHost: "127.0.0.1",
          smtpPort: mailSrv.smtpPort,
          smtpTls: false,
          smtpStarttls: false,
        }),
      });
      assert.equal(addQqRes.status, 200);
      const qqAdded: any = await addQqRes.json();
      const qqAccountId = qqAdded.account?.id;
      assert.ok(qqAccountId);

      // Uninstall qqmail WITHOUT purge -> credentials stay dormant on disk
      assert.equal((await fetch(`${ws.baseUrl}/api/skills/qqmail`, { method: "DELETE" })).status, 200);
      const authAfterKeep = fs.readFileSync(path.join(ws.dataDir, "mail-auth.json"), "utf8");
      assert.ok(authAfterKeep.includes(qqAccountId), "Uninstall without purge must keep dormant account");

      // Fixed UX-03: DELETE /api/integrations/mail/accounts/:id while skill uninstalled cleans up dormant account (200)
      const delWhileUninstalled = await fetch(`${ws.baseUrl}/api/integrations/mail/accounts/${qqAccountId}`, {
        method: "DELETE",
      });
      setEvidence("deleteAccountWhileSkillUninstalledStatus", delWhileUninstalled.status);
      assert.equal(delWhileUninstalled.status, 200, "Deleting dormant mail account while skill uninstalled must succeed");

      // Reinstall, re-add account, then uninstall WITH purgeCredentials=true -> wipes qqmail accounts cleanly!
      await fetch(`${ws.baseUrl}/api/skills/qqmail/install`, { method: "POST" });
      const addQq2: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/mail/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "qqmail",
            email: mailSrv.validEmail,
            authCode: mailSrv.validPassword,
            inboundProtocol: "pop3",
            inboundHost: "127.0.0.1",
            inboundPort: mailSrv.pop3Port,
            inboundTls: false,
            smtpHost: "127.0.0.1",
            smtpPort: mailSrv.smtpPort,
            smtpTls: false,
            smtpStarttls: false,
          }),
        })
      ).json();
      const qqAccountId2 = addQq2.account?.id;
      assert.ok(qqAccountId2);
      assert.equal(
        (await fetch(`${ws.baseUrl}/api/skills/qqmail?purgeCredentials=true`, { method: "DELETE" })).status,
        200
      );
      const authAfterPurge = fs.readFileSync(path.join(ws.dataDir, "mail-auth.json"), "utf8");
      assert.ok(!authAfterPurge.includes(qqAccountId2), "Uninstall with purgeCredentials=true must delete qqmail credentials");

      // Conversational skill_configure_mail omitting secret -> pops CredentialCard with hideVaultCheckbox=true!
      await fetch(`${ws.baseUrl}/api/skills/qqmail/install`, { method: "POST" });
      let step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "配置邮箱" };
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [
              {
                id: "scm-1",
                name: "skill_configure_mail",
                args: {
                  action: "upsert_account",
                  skill_id: "qqmail",
                  email: mailSrv.validEmail,
                  inbound_protocol: "pop3",
                  inbound_host: "127.0.0.1",
                  inbound_port: mailSrv.pop3Port,
                  inbound_tls: false,
                  smtp_host: "127.0.0.1",
                  smtp_port: mailSrv.smtpPort,
                  smtp_tls: false,
                },
              },
            ],
          };
        }
        return { text: "对话式邮箱绑定完成" };
      });
      await chrome!.typeText("#message-input", "帮我用对话绑定 QQ 邮箱", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.credential-card:not(.is-collapsed)'))`, 8000);
      const vaultCheckHidden = await chrome!.evalJs<boolean>(
        `Boolean(document.querySelector('.credential-card:not(.is-collapsed) .credential-vault-check')?.hidden)`
      );
      assert.equal(vaultCheckHidden, true, "skill_configure_mail credential card must hide Vault checkbox");
      await chrome!.fill(".credential-card:not(.is-collapsed) .credential-secret-input", mailSrv.validPassword);
      await chrome!.click(".credential-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('对话式邮箱绑定完成'))`,
        8000
      );
      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SKILL-05 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-05",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "kimi-cu MCP 安装握手、工具芯片展示、截图回传、子进程 env 脱敏与反自控(com.twinklebot.desktop)拒绝",
      module: "MCP Client (kimi-cu)",
    },
    async () => {
      const mcpScript = createMockMcpServerScript(ws.tmpDir);
      await fetch(`${ws.baseUrl}/api/skills/kimi-cu/install`, { method: "POST" });
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostComputer: { executionMode: "always" },
          mcpServers: {
            "kimi-cu": {
              command: process.execPath,
              args: [mcpScript],
              enabled: true,
            },
          },
        }),
      });

      const statusRes: any = await (await fetch(`${ws.baseUrl}/api/mcp/status?server=kimi-cu&connect=true`)).json();
      assert.equal(statusRes.connected, true);
      assert.ok(statusRes.toolCount >= 3);

      // Run Agent calling mcp__kimi_cu__inspect_env (verify scrubbed env), mcp__kimi_cu__click (normal + screenshot), and self-control click (denied!)
      const mcpBot = ws.store.createSession({ title: "McpBot" });
      let step = 0;
      let envResultText = "";
      let selfControlResult = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (
          s.includes("ultra-short Chinese phrase") ||
          s.includes("Distill the current task progress") ||
          s.includes("短语") ||
          s.includes("概括")
        )
          return { text: "操控应用" };
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "mc-1", name: "mcp__kimi_cu__inspect_env", args: { risk: "low" } }] };
        }
        if (step === 2) {
          envResultText = s;
          return { toolCalls: [{ id: "mc-2", name: "mcp__kimi_cu__click", args: { app: "Notes", x: 100, y: 200, risk: "low" } }] };
        }
        if (step === 3) {
          return {
            toolCalls: [{ id: "mc-3", name: "mcp__kimi_cu__click", args: { app: "com.twinklebot.desktop", x: 50, y: 50, risk: "low" } }],
          };
        }
        selfControlResult = s;
        return { text: "MCP 实测完毕" };
      });

      await fetch(`${ws.baseUrl}/api/sessions/${mcpBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "测试 MCP 工具调用与反自控" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(mcpBot.id), 10_000, "MCP turn completes");
      ws.mockLlm.setHandler(undefined);

      assert.ok(!envResultText.includes("GEMINI_API_KEY"), "MCP child env must scrub GEMINI_API_KEY");
      assert.ok(!envResultText.includes("TWINKLEBOT_EXECUTOR_TOKEN"), "MCP child env must scrub executor token");
      assert.match(selfControlResult, /拒绝|deny|禁止|self|不允许|blocked/i, "Self-control of com.twinklebot.desktop must be denied");

      const evs = ws.store.readEvents(mcpBot.id);
      const clickResEv = evs.find((e: any) => e.type === "result" && e.name === "mcp__kimi_cu__click" && e.screenshot);
      assert.ok(clickResEv?.screenshot, "MCP image content block must be saved as step screenshot");
    },
    { getChrome: () => chrome }
  );
});
