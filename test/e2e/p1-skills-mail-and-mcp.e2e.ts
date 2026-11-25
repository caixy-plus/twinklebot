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

test("P1 Suite 5: Skills Store, Custom SKILL.md, Multi-Account Mail (IMAP/POP3/SMTP), QQ Mail & KimiCU MCP (Full PI-013 Coverage)", async (t) => {
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
      {
        uid: 102,
        unseen: false,
        raw: [
          "From: HR <hr@corp.test>",
          "To: e2e@corp.test",
          "Subject: Holiday Notice",
          "Date: Thu, 19 Nov 2026 09:00:00 +0800",
          "MIME-Version: 1.0",
          "Content-Type: text/html; charset=utf-8",
          "",
          "<html><body><p>放假通知：下周五调休。</p></body></html>",
        ].join("\r\n"),
      },
    ],
  });
  t.after(() => mailSrv.close());

  const mailSrv2 = await startLoopbackMailServer({
    validEmail: "alt@corp.test",
    validPassword: "alt-password-16ch",
    initialMessages: [
      {
        uid: 201,
        unseen: true,
        raw: [
          "From: Ops <ops@corp.test>",
          "To: alt@corp.test",
          "Subject: Second Mailbox Alert",
          "Date: Thu, 19 Nov 2026 10:00:00 +0800",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "第二邮箱告警：一切正常。",
        ].join("\r\n"),
      },
    ],
  });
  t.after(() => mailSrv2.close());

  const ensureAtWorkspace = async () => {
    const url = await chrome!.evalJs<string>(`window.location.href`).catch(() => "");
    if (!url.startsWith(ws.baseUrl)) {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`,
        10_000
      );
    }
    // Close modal if left open from previous case
    const modalOpen = await chrome!.evalJs<boolean>(
      `Boolean(document.querySelector('#apps-modal-backdrop') && !document.querySelector('#apps-modal-backdrop').hidden)`
    );
    if (modalOpen) {
      await chrome!.click("#close-apps-modal-btn").catch(() => {});
      await chrome!.waitFor(`document.querySelector('#apps-modal-backdrop')?.hidden`, 4000).catch(() => {});
    }
  };

  // ---------- P1-SKILL-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "技能商店搜索/空搜索态/分类筛选/已添加入口/内置常驻标签禁删(400)、遮罩关闭与一键创建「邮箱管家」模板 Bot",
      module: "Skills Store",
    },
    async () => {
      await ensureAtWorkspace();
      const skillsApiRes = await fetch(`${ws.baseUrl}/api/skills`);
      assert.equal(skillsApiRes.status, 200);

      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);

      // Category filter: office vs platform vs all
      await chrome!.click(`[data-skill-filter="office"]`);
      await chrome!.waitFor(`document.querySelector('#skills-store-sections')?.textContent?.includes('QQ 邮箱')`);
      await chrome!.click(`[data-skill-filter="platform"]`);
      await chrome!.waitFor(`document.querySelector('#skills-store-sections')?.textContent?.includes('KimiCU')`);
      // Issue #14: Non-configurable built-in platform skills belong to hidden "builtin" category and must stay hidden from user UI
      const hasBuiltinTag = await chrome!.evalJs<boolean>(
        `Array.from(document.querySelectorAll('#skills-store-sections .skill-builtin-tag')).length > 0`
      );
      assert.equal(hasBuiltinTag, false, "Hidden built-in skills must NOT be shown in Skills Store UI (#14)");

      await chrome!.click(`[data-skill-filter="all"]`);
      await chrome!.fill("#skills-search-input", "通用邮箱");
      await chrome!.waitFor(`document.querySelector('#skills-store-sections')?.textContent?.includes('通用邮箱')`);

      // Empty search state boundary (.skills-empty)
      await chrome!.fill("#skills-search-input", "不存在的神秘技能XYZ999");
      await chrome!.waitFor(`Boolean(document.querySelector('#skills-store-sections .skills-empty'))`, 4000);
      await chrome!.fill("#skills-search-input", "");

      // Open Manage view via #open-installed-plugins-btn pill and return via #back-to-apps-btn
      await chrome!.click("#open-installed-plugins-btn");
      await chrome!.waitFor(`!document.querySelector('#skills-manage-view')?.hidden`, 4000);
      const hasPermanentTag = await chrome!.evalJs<boolean>(
        `Array.from(document.querySelectorAll('#installed-plugins-grid .skill-builtin-tag')).length > 0`
      );
      assert.equal(hasPermanentTag, false, "Manage view must hide non-configurable built-in skills (#14)");
      await chrome!.click("#back-to-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#skills-store-view')?.hidden`, 4000);

      // Built-in skill uninstall must return 400
      const delBuiltin = await fetch(`${ws.baseUrl}/api/skills/websearch`, { method: "DELETE" });
      assert.equal(delBuiltin.status, 400);

      // Backdrop click closes modal cleanly
      await chrome!.evalJs(`document.querySelector('#apps-modal-backdrop')?.click()`);
      await chrome!.waitFor(`document.querySelector('#apps-modal-backdrop')?.hidden`, 4000);

      // Reopen & click one-click '邮箱管家' template bot button
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
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
      title: "自定义 SKILL.md 全 UI 生命周期(新建/校验/YAML预览/搜索/启停开关/内联编辑重命名/删除确认)与 Agent custom_skill_manage 全动作",
      module: "Custom Skills",
    },
    async () => {
      await ensureAtWorkspace();
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.click("#store-manage-custom-btn");
      await chrome!.waitFor(`!document.querySelector('#skills-manage-view')?.hidden`);

      // Empty list state initially
      const initCount = await chrome!.evalJs<string>(`document.querySelector('#custom-skills-count-badge')?.textContent || ''`);
      assert.ok(initCount.includes("0 项") || initCount.includes("已启用"));

      // Validation check: whitespace-only fields trigger #custom-skill-form-feedback error; cancel closes form
      await chrome!.click("#add-custom-skill-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('#custom-skill-editor-form'))`);
      await chrome!.fill("#custom-skill-name-input", "   ");
      await chrome!.fill("#custom-skill-desc-input", "   ");
      await chrome!.fill("#custom-skill-instructions-input", "   ");
      await chrome!.click("#custom-skill-save-btn");
      await chrome!.waitFor(
        `Boolean(document.querySelector('#custom-skill-form-feedback')?.textContent?.trim().length)`,
        4000
      );
      await chrome!.click("#custom-skill-cancel-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('#custom-skill-editor-form')?.hidden)`, 4000);

      // Create custom skill via UI (with icon + YAML preview)
      await chrome!.click("#add-custom-skill-btn");
      await chrome!.waitFor(`!document.querySelector('#custom-skill-editor-form')?.hidden`, 4000);
      await chrome!.fill("#custom-skill-name-input", "发布前自检");
      await chrome!.fill("#custom-skill-slug-input", "release-checklist");
      await chrome!.fill("#custom-skill-icon-input", "🚀");
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

      // Verify on disk + GET /api/custom-skills & /api/custom-skills/:id (200 & 404)
      const mdFile = path.join(ws.dataDir, "custom-skills", "release-checklist.md");
      assert.ok(fs.existsSync(mdFile));
      assert.equal((await fetch(`${ws.baseUrl}/api/custom-skills`)).status, 200);
      assert.equal((await fetch(`${ws.baseUrl}/api/custom-skills/release-checklist`)).status, 200);
      assert.equal((await fetch(`${ws.baseUrl}/api/custom-skills/nonexistent-slug`)).status, 404);

      // Search custom skills (miss -> empty state, hit -> card visible, clear)
      await chrome!.fill("#custom-skill-search-input", "不存在的自定义技能");
      await chrome!.waitFor(`document.querySelector('#custom-skills-list .skills-empty')?.textContent?.includes('没有找到')`, 4000);
      await chrome!.fill("#custom-skill-search-input", "发布前自检");
      await chrome!.waitFor(`Boolean(document.querySelector('[data-custom-skill-id="release-checklist"]'))`, 4000);
      await chrome!.fill("#custom-skill-search-input", "");

      // UI Enable/Disable toggle (.ios-switch -> .is-disabled) & re-enable
      await chrome!.click('[data-custom-skill-id="release-checklist"] .ios-switch input');
      await chrome!.waitFor(
        `document.querySelector('[data-custom-skill-id="release-checklist"]')?.classList.contains('is-disabled')`,
        5000
      );
      await chrome!.click('[data-custom-skill-id="release-checklist"] .ios-switch input');
      await chrome!.waitFor(
        `!document.querySelector('[data-custom-skill-id="release-checklist"]')?.classList.contains('is-disabled')`,
        5000
      );

      // Verify auto-dedup slug on second creation without explicit slug
      const dupRes = await fetch(`${ws.baseUrl}/api/custom-skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "发布前自检", description: "第二份", instructions: "step B" }),
      });
      assert.equal(dupRes.status, 201);
      const dup: any = await dupRes.json();
      assert.notEqual(dup.skill?.id, "release-checklist");

      // Refresh view to see second skill -> UI inline edit/rename slug -> UI inline delete confirm (cancel then confirm)
      await chrome!.waitFor(`Boolean(document.querySelector('[data-custom-skill-id="${dup.skill.id}"]'))`, 6000);
      await chrome!.evalJs(`(() => {
        const card = document.querySelector('[data-custom-skill-id="${dup.skill.id}"]');
        const btn = Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent?.includes('查看 / 编辑'));
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('[data-custom-skill-id="${dup.skill.id}"] #custom-skill-slug-input'))`, 4000);
      await chrome!.fill(`[data-custom-skill-id="${dup.skill.id}"] #custom-skill-slug-input`, "release-checklist-v2");
      await chrome!.click(`[data-custom-skill-id="${dup.skill.id}"] #custom-skill-save-btn`);
      await chrome!.waitFor(`Boolean(document.querySelector('[data-custom-skill-id="release-checklist-v2"]'))`, 6000);
      assert.ok(fs.existsSync(path.join(ws.dataDir, "custom-skills", "release-checklist-v2.md")));

      // UI inline delete confirm: click 删除 -> 取消 -> 删除 -> 确认删除
      await chrome!.evalJs(`(() => {
        const card = document.querySelector('[data-custom-skill-id="release-checklist-v2"]');
        const btn = Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '删除');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('[data-custom-skill-id="release-checklist-v2"] .skill-remove-confirm'))`, 4000);
      await chrome!.evalJs(`(() => {
        const box = document.querySelector('[data-custom-skill-id="release-checklist-v2"] .skill-remove-confirm');
        const btn = Array.from(box?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '取消');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`!document.querySelector('[data-custom-skill-id="release-checklist-v2"] .skill-remove-confirm')`, 4000);
      await chrome!.evalJs(`(() => {
        const card = document.querySelector('[data-custom-skill-id="release-checklist-v2"]');
        const btn = Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '删除');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('[data-custom-skill-id="release-checklist-v2"] .skill-remove-confirm'))`, 4000);
      await chrome!.click('[data-custom-skill-id="release-checklist-v2"] .skill-remove-confirm .is-danger');
      await chrome!.waitFor(`!document.querySelector('[data-custom-skill-id="release-checklist-v2"]')`, 6000);

      // Verify progressive disclosure & Agent custom_skill_manage ALL actions (list/get/create/update/toggle/delete)
      await chrome!.click("#close-apps-modal-btn");
      await chrome!.waitFor(`document.querySelector('#apps-modal-backdrop')?.hidden`, 4000);

      ws.mockLlm.clearRequests();
      let step = 0;
      let loadedBody = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "管理技能" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) return { toolCalls: [{ id: "cs-1", name: "custom_skill_manage", args: { action: "list" } }] };
        if (step === 2) return { toolCalls: [{ id: "cs-2", name: "custom_skill_manage", args: { action: "get", id: "release-checklist" } }] };
        if (step === 3) {
          loadedBody = s;
          return {
            toolCalls: [{
              id: "cs-3",
              name: "custom_skill_manage",
              args: { action: "create", name: "Bot自动技能", id: "bot-auto-skill", description: "测试", instructions: "run step 1" },
            }],
          };
        }
        if (step === 4) {
          return {
            toolCalls: [{
              id: "cs-4",
              name: "custom_skill_manage",
              args: { action: "update", id: "bot-auto-skill", description: "已更新描述" },
            }],
          };
        }
        if (step === 5) {
          return { toolCalls: [{ id: "cs-5", name: "custom_skill_manage", args: { action: "toggle", id: "bot-auto-skill", enabled: false } }] };
        }
        if (step === 6) {
          return { toolCalls: [{ id: "cs-6", name: "custom_skill_manage", args: { action: "delete", id: "bot-auto-skill" } }] };
        }
        return { text: "custom_skill_manage 全 6 项动作与渐进披露验证完毕" };
      });

      await chrome!.typeText("#message-input", "按发布前自检执行并测试自定义技能工具链", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('全 6 项动作与渐进披露验证完毕'))`,
        12_000
      );
      ws.mockLlm.setHandler(undefined);

      const firstSys = String(
        ws.mockLlm.capturedRequests.find((r) => String(r.body?.messages?.[0]?.content || "").includes("release-checklist"))?.body?.messages?.[0]?.content || ""
      );
      assert.ok(firstSys.includes("release-checklist"), "System prompt must list custom skill metadata");
      assert.ok(!firstSys.includes("SECRET_BODY_ONLY_ON_GET"), "Progressive disclosure must omit full body from system prompt");
      assert.match(loadedBody, /SECRET_BODY_ONLY_ON_GET/, "Agent must receive full body on action=get");
      assert.equal(fs.existsSync(path.join(ws.dataDir, "custom-skills", "bot-auto-skill.md")), false, "Agent delete must remove .md file");
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
      title: "通用邮箱表单全交互(域名预设/手动改Host保护/密码显隐/协议端口联动/测试/发自测信/两级返回) + Agent 查账号/收读/草稿确认发信",
      module: "Mail Integration (Custom Mail)",
    },
    async () => {
      await ensureAtWorkspace();
      const instRes = await fetch(`${ws.baseUrl}/api/skills/custom-mail/install`, { method: "POST" });
      assert.equal(instRes.status, 200);
      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);

      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const c = rows.find(el => el.textContent?.includes('通用邮箱'));
        c?.querySelector('button')?.click();
      })()`);
      await chrome!.waitFor(
        `document.querySelector('#skill-detail-title')?.textContent?.includes('通用邮箱') && Boolean(document.querySelector('#custom-mail-config-form'))`,
        6000
      );

      // 1. Domain auto-preset inference + protocol port sync + user-edited host override protection
      await chrome!.fill("#custom-mail-email-input", "tester@163.com");
      await chrome!.waitFor(`document.querySelector('#custom-mail-inbound-host')?.value === 'imap.163.com'`, 4000);
      await chrome!.click("#custom-proto-pop3");
      await chrome!.waitFor(`document.querySelector('#custom-mail-inbound-host')?.value === 'pop.163.com'`, 4000);
      await chrome!.click("#custom-proto-imap");
      await chrome!.waitFor(`document.querySelector('#custom-mail-inbound-host')?.value === 'imap.163.com'`, 4000);

      // Toggle SMTP SSL/STARTTLS port auto-sync (465 <-> 587)
      await chrome!.click("#custom-smtp-starttls");
      await chrome!.waitFor(`document.querySelector('#custom-mail-smtp-port')?.value === '587'`, 3000);
      await chrome!.click("#custom-smtp-ssl");
      await chrome!.waitFor(`document.querySelector('#custom-mail-smtp-port')?.value === '465'`, 3000);

      // Toggle password visibility (#custom-mail-toggle-secret-btn)
      await chrome!.fill("#custom-mail-password-input", mailSrv.validPassword);
      assert.equal(await chrome!.evalJs<string>(`document.querySelector('#custom-mail-password-input')?.type`), "password");
      await chrome!.click("#custom-mail-toggle-secret-btn");
      assert.equal(await chrome!.evalJs<string>(`document.querySelector('#custom-mail-password-input')?.type`), "text");
      await chrome!.click("#custom-mail-toggle-secret-btn");

      // Point to loopback IMAP + SMTP
      await chrome!.fill("#custom-mail-email-input", mailSrv.validEmail);
      await chrome!.fill("#custom-mail-label-input", "回环测试工作邮箱");
      await chrome!.fill("#custom-mail-inbound-host", "127.0.0.1");
      await chrome!.fill("#custom-mail-inbound-port", String(mailSrv.imapPort));
      const inTls = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('#custom-mail-inbound-tls')?.checked)`);
      if (inTls) await chrome!.click("#custom-mail-inbound-tls");
      await chrome!.click("#custom-smtp-none");
      await chrome!.fill("#custom-mail-smtp-host", "127.0.0.1");
      await chrome!.fill("#custom-mail-smtp-port", String(mailSrv.smtpPort));

      // Test connection + SEND SELF-TEST EMAIL (#custom-mail-send-test-btn) + Save!
      await chrome!.click("#custom-mail-test-btn");
      await chrome!.waitFor(`document.querySelector('#custom-mail-feedback-box')?.classList.contains('is-success')`, 6000);

      const sentBeforeSelfTest = mailSrv.sentMessages.length;
      await chrome!.click("#custom-mail-send-test-btn");
      await chrome!.waitFor(
        `document.querySelector('#custom-mail-feedback-box')?.classList.contains('is-success') &&
         /自测|测试信|已发送|成功/.test(document.querySelector('#custom-mail-feedback-box')?.textContent || '')`,
        6000
      );
      assert.ok(mailSrv.sentMessages.length > sentBeforeSelfTest, "Self-test button must actually deliver test mail via SMTP");

      await chrome!.click("#custom-mail-save-btn");
      await chrome!.waitFor(`document.querySelector('#mail-accounts-list')?.textContent?.includes('e2e@corp.test')`, 6000);

      // Search by bound mail email in Store view!
      await chrome!.click("#skill-detail-back-btn");
      await chrome!.waitFor(`!document.querySelector('#skills-store-view')?.hidden`, 4000);
      await chrome!.fill("#skills-search-input", "e2e@corp.test");
      await chrome!.waitFor(`document.querySelector('#skills-store-sections')?.textContent?.includes('通用邮箱')`, 4000);
      await chrome!.fill("#skills-search-input", "");
      await chrome!.click("#close-apps-modal-btn");

      // Agent calls mail_list_accounts, mail_list_messages (unseen_only), mail_read_message (UTF-8 + HTML), and mail_send_message (cc + DraftCard confirm)
      let step = 0;
      let accountsOut = "";
      let readOutput = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "处理邮件" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) return { toolCalls: [{ id: "ml-0", name: "mail_list_accounts", args: {} }] };
        if (step === 2) {
          accountsOut = s;
          return { toolCalls: [{ id: "ml-1", name: "mail_list_messages", args: { limit: 5, unseen_only: true } }] };
        }
        if (step === 3) return { toolCalls: [{ id: "ml-2", name: "mail_read_message", args: { uid: "101" } }] };
        if (step === 4) {
          readOutput = s;
          return {
            toolCalls: [{
              id: "ml-3",
              name: "mail_send_message",
              args: { to: "boss@corp.test", cc: "pm@corp.test", subject: "周报回复\r\nBcc: evil@attacker.test", text: "原始回复" },
            }],
          };
        }
        return { text: "邮件全流程读取与发信成功" };
      });

      await chrome!.typeText("#message-input", "帮我查看邮箱账号和未读邮件并抄送回复老板", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.draft-card:not(.is-collapsed)'))`, 10_000);
      await chrome!.fill(".draft-card:not(.is-collapsed) .draft-body-textarea", "老板您好，已修订并确认发出！");
      await chrome!.click(".draft-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('邮件全流程读取与发信成功'))`,
        10_000
      );
      ws.mockLlm.setHandler(undefined);

      assert.match(accountsOut, /e2e@corp\.test/);
      assert.match(readOutput, /请查收本周 E2E 测试总结报告/);
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
      title: "多邮箱账号全流程(PI-013)：新增第2账号、设为默认、单账号测试成功/认证失败诊断、内联编辑留空保密、POP3收读、删除单账号与兼容路由",
      module: "Mail Multi-Account & Diagnostics",
    },
    async () => {
      await ensureAtWorkspace();
      await fetch(`${ws.baseUrl}/api/skills/custom-mail/install`, { method: "POST" });

      // Ensure account 1 exists for standalone --case=P1-SKILL-04 execution
      const initMail: any = await (await fetch(`${ws.baseUrl}/api/integrations/mail`)).json();
      if (!(initMail.accounts || []).some((a: any) => a.email === mailSrv.validEmail)) {
        await fetch(`${ws.baseUrl}/api/integrations/mail/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "custom-mail",
            label: "工作邮箱1",
            email: mailSrv.validEmail,
            password: mailSrv.validPassword,
            inboundProtocol: "imap",
            inboundHost: "127.0.0.1",
            inboundPort: mailSrv.imapPort,
            inboundTls: false,
            smtpHost: "127.0.0.1",
            smtpPort: mailSrv.smtpPort,
            smtpTls: false,
            smtpStarttls: false,
          }),
        });
      }

      // Direct POST /api/integrations/mail/test failure diagnostic (wrong password -> error!)
      const badTestRes = await fetch(`${ws.baseUrl}/api/integrations/mail/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom-mail",
          email: mailSrv2.validEmail,
          password: "wrong-password-xyz",
          inboundProtocol: "pop3",
          inboundHost: "127.0.0.1",
          inboundPort: mailSrv2.pop3Port,
          inboundTls: false,
          smtpHost: "127.0.0.1",
          smtpPort: mailSrv2.smtpPort,
          smtpTls: false,
          smtpStarttls: false,
        }),
      });
      assert.ok(badTestRes.status >= 400 || !(await badTestRes.clone().json()).ok, "Wrong password mail test must fail");

      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const c = rows.find(el => el.textContent?.includes('通用邮箱'));
        c?.querySelector('button')?.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#start-new-mail-btn'))`, 6000);

      // 1. Add 2nd mailbox (POP3) via UI #start-new-mail-btn
      await chrome!.click("#start-new-mail-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('#custom-mail-config-form'))`, 4000);
      await chrome!.fill("#custom-mail-email-input", mailSrv2.validEmail);
      await chrome!.fill("#custom-mail-password-input", "wrong-pass-ui-test");
      await chrome!.fill("#custom-mail-label-input", "备用POP3邮箱");
      await chrome!.click("#custom-proto-pop3");
      await chrome!.fill("#custom-mail-inbound-host", "127.0.0.1");
      await chrome!.fill("#custom-mail-inbound-port", String(mailSrv2.pop3Port));
      const tls2 = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('#custom-mail-inbound-tls')?.checked)`);
      if (tls2) await chrome!.click("#custom-mail-inbound-tls");
      await chrome!.click("#custom-smtp-none");
      await chrome!.fill("#custom-mail-smtp-host", "127.0.0.1");
      await chrome!.fill("#custom-mail-smtp-port", String(mailSrv2.smtpPort));

      // Verify UI test failure diagnostic (.mail-feedback-box.is-error)!
      await chrome!.click("#custom-mail-test-btn");
      await chrome!.waitFor(`document.querySelector('#custom-mail-feedback-box')?.classList.contains('is-error')`, 6000);

      // Fix password & save 2nd account
      await chrome!.fill("#custom-mail-password-input", mailSrv2.validPassword);
      await chrome!.click("#custom-mail-save-btn");
      await chrome!.waitFor(
        `document.querySelector('#mail-accounts-list')?.textContent?.includes('alt@corp.test') &&
         document.querySelectorAll('#mail-accounts-list .mail-account-card').length >= 2`,
        6000
      );

      // 2. Click "设为默认" on 2nd account -> .mail-default-badge moves to alt@corp.test
      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#mail-accounts-list .mail-account-card'));
        const c2 = cards.find(c => c.textContent?.includes('alt@corp.test'));
        const btn = Array.from(c2?.querySelectorAll('button') || []).find(b => b.textContent?.includes('设为默认'));
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`(() => {
        const cards = Array.from(document.querySelectorAll('#mail-accounts-list .mail-account-card'));
        const c2 = cards.find(c => c.textContent?.includes('alt@corp.test'));
        return Boolean(c2?.querySelector('.mail-default-badge'));
      })()`, 6000);

      // 3. Click per-account "测试" button on 2nd account -> #mail-list-feedback-box turns .is-success
      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#mail-accounts-list .mail-account-card'));
        const c2 = cards.find(c => c.textContent?.includes('alt@corp.test'));
        const btn = Array.from(c2?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '测试');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#mail-list-feedback-box')?.classList.contains('is-success')`, 6000);

      // 4. Inline "编辑" preserving blank password + changing label
      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#mail-accounts-list .mail-account-card'));
        const c2 = cards.find(c => c.textContent?.includes('alt@corp.test'));
        const btn = Array.from(c2?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '编辑');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#custom-mail-label-input'))`, 4000);
      await chrome!.fill("#custom-mail-label-input", "备用POP3已改名");
      await chrome!.click("#custom-mail-save-btn");
      await chrome!.waitFor(`document.querySelector('#mail-accounts-list')?.textContent?.includes('备用POP3已改名')`, 6000);

      // 5. Verify POP3 read via Agent on default 2nd account (alt@corp.test)!
      await chrome!.click("#close-apps-modal-btn");
      let step = 0;
      let pop3ReadOut = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "读取POP3" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) return { toolCalls: [{ id: "pop-1", name: "mail_list_messages", args: { account: "alt@corp.test", limit: 3 } }] };
        if (step === 2) return { toolCalls: [{ id: "pop-2", name: "mail_read_message", args: { account: "alt@corp.test", uid: "1" } }] };
        pop3ReadOut = s;
        return { text: "POP3多账号收信成功" };
      });
      await chrome!.typeText("#message-input", "检查备用POP3邮箱的告警邮件", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('POP3多账号收信成功'))`,
        10_000
      );
      ws.mockLlm.setHandler(undefined);
      assert.match(pop3ReadOut, /第二邮箱告警/);

      // 6. Delete single account via UI #custom-mail-disconnect-btn + ConfirmDialog
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const c = rows.find(el => el.textContent?.includes('通用邮箱'));
        c?.querySelector('button')?.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#mail-accounts-list')?.textContent?.includes('alt@corp.test')`, 6000);
      await chrome!.evalJs(`(() => {
        const cards = Array.from(document.querySelectorAll('#mail-accounts-list .mail-account-card'));
        const c2 = cards.find(c => c.textContent?.includes('alt@corp.test'));
        const btn = Array.from(c2?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '编辑');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#custom-mail-disconnect-btn'))`, 4000);
      await chrome!.click("#custom-mail-disconnect-btn");
      await chrome!.waitFor(`document.querySelector('#app-confirm-dialog')?.open`, 4000);
      await chrome!.click("#app-confirm-ok-btn");
      await chrome!.waitFor(
        `!document.querySelector('#mail-accounts-list')?.textContent?.includes('alt@corp.test')`,
        6000
      );
      await chrome!.click("#close-apps-modal-btn");
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
      title: "QQ邮箱专用表单(PI-013：16位授权码提示/短码校验/显隐/高级协议切换) + 对话式 skill_configure_mail 全动作与缺密凭据卡脱敏",
      module: "QQ Mail UI & Conversational Config",
    },
    async () => {
      await ensureAtWorkspace();
      await fetch(`${ws.baseUrl}/api/skills/qqmail/install`, { method: "POST" });
      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);

      // 1. Open QQ Mail detail view & exercise #qqmail-config-form UI controls!
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const c = rows.find(el => el.textContent?.includes('QQ 邮箱'));
        c?.querySelector('button')?.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#qqmail-config-form'))`, 6000);

      // Verify 16-char auth code hint & <8 char validation error
      const qqHintText = await chrome!.evalJs<string>(`document.querySelector('#qqmail-config-form')?.textContent || ''`);
      assert.match(qqHintText, /16\s*位|授权码/);

      await chrome!.fill("#qqmail-email-input", "123456@qq.com");
      await chrome!.fill("#qqmail-label-input", "我的QQ主邮箱");
      await chrome!.fill("#qqmail-authcode-input", "short");
      assert.equal(await chrome!.evalJs<string>(`document.querySelector('#qqmail-authcode-input')?.type`), "password");
      await chrome!.click("#qqmail-toggle-secret-btn");
      assert.equal(await chrome!.evalJs<string>(`document.querySelector('#qqmail-authcode-input')?.type`), "text");

      // Expand <details> advanced protocol options & switch POP3/IMAP
      await chrome!.evalJs(`(() => {
        const det = document.querySelector('#qqmail-config-form details');
        if (det) det.open = true;
      })()`);
      await chrome!.click("#qqmail-proto-pop3");
      await chrome!.click("#qqmail-proto-imap");
      await chrome!.click("#qqmail-test-btn");
      await chrome!.waitFor(`document.querySelector('#qqmail-feedback-box')?.classList.contains('is-error')`, 5000);
      await chrome!.click("#close-apps-modal-btn");

      // 2. Conversational skill_configure_mail ALL actions: upsert_account (missing secret -> CredentialCard with hideVaultCheckbox=true), test_account, set_default, remove_account!
      let step = 0;
      let capturedAcctId = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "配置邮箱" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{
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
            }],
          };
        }
        if (step === 2) {
          const m = s.match(/mail-[a-z0-9-]+/i);
          capturedAcctId = m ? m[0] : "";
          return {
            toolCalls: [{
              id: "scm-2",
              name: "skill_configure_mail",
              args: { action: "test_account", account_id: capturedAcctId || mailSrv.validEmail, send_test_mail: true },
            }],
          };
        }
        if (step === 3) {
          return {
            toolCalls: [{
              id: "scm-3",
              name: "skill_configure_mail",
              args: { action: "set_default", account_id: capturedAcctId || mailSrv.validEmail },
            }],
          };
        }
        if (step === 4) {
          return {
            toolCalls: [{
              id: "scm-4",
              name: "skill_configure_mail",
              args: { action: "remove_account", account_id: capturedAcctId || mailSrv.validEmail },
            }],
          };
        }
        return { text: "对话式邮箱绑定测试设默认删除全闭环完成" };
      });

      await chrome!.typeText("#message-input", "帮我用对话绑定并测试 QQ 邮箱再移除", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.credential-card:not(.is-collapsed)'))`, 8000);
      const vaultCheckHidden = await chrome!.evalJs<boolean>(
        `Boolean(document.querySelector('.credential-card:not(.is-collapsed) .credential-vault-check')?.hidden)`
      );
      assert.equal(vaultCheckHidden, true, "skill_configure_mail credential card must hide Vault checkbox");
      await chrome!.fill(".credential-card:not(.is-collapsed) .credential-secret-input", mailSrv.validPassword);
      await chrome!.click(".credential-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('对话式邮箱绑定测试设默认删除全闭环完成'))`,
        12_000
      );
      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SKILL-06 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-06",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "技能安装/卸载确认 UI(PI-013)：商店添加、管理页/详情页移除取消、卸载保留加密凭据与勾选清除凭据边界",
      module: "Skill Uninstall & Credential Cleanup",
    },
    async ({ setEvidence }) => {
      await ensureAtWorkspace();
      await fetch(`${ws.baseUrl}/api/skills/qqmail/install`, { method: "POST" });
      const addQq: any = await (
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
      const qqAccountId = addQq.account?.id;
      assert.ok(qqAccountId);

      // 1. Open Manage view -> click 移除 on QQ 邮箱 -> test cancel -> click 移除 -> uninstall KEEPING credentials
      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.click("#open-installed-plugins-btn");
      await chrome!.waitFor(`!document.querySelector('#skills-manage-view')?.hidden`);

      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#installed-plugins-grid .skill-row'));
        const qq = rows.find(r => r.textContent?.includes('QQ 邮箱'));
        const btn = Array.from(qq?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '移除');
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#installed-plugins-grid .skill-remove-confirm'))`, 4000);
      // Cancel uninstall
      await chrome!.evalJs(`(() => {
        const box = document.querySelector('#installed-plugins-grid .skill-remove-confirm');
        Array.from(box?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '取消')?.click();
      })()`);
      await chrome!.waitFor(`!document.querySelector('#installed-plugins-grid .skill-remove-confirm')`, 4000);

      // Uninstall keeping credentials (leave purge checkbox unchecked)
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#installed-plugins-grid .skill-row'));
        const qq = rows.find(r => r.textContent?.includes('QQ 邮箱'));
        Array.from(qq?.querySelectorAll('button') || []).find(b => b.textContent?.trim() === '移除')?.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#installed-plugins-grid .skill-remove-confirm'))`, 4000);
      await chrome!.click("#installed-plugins-grid .skill-remove-confirm .is-danger");
      await chrome!.waitFor(`!document.querySelector('#installed-plugins-grid')?.textContent?.includes('QQ 邮箱')`, 6000);

      const authKeepRaw = fs.readFileSync(path.join(ws.dataDir, "mail-auth.json"), "utf8");
      assert.ok(authKeepRaw.includes("__twinklebot_encrypted__"), "mail-auth.json must remain AES-256-GCM encrypted");
      assert.ok(!authKeepRaw.includes(mailSrv.validPassword), "mail-auth.json must never store plaintext password");
      assert.ok(JSON.stringify(ws.store.readMailAuth()).includes(qqAccountId), "Uninstall without purge must preserve dormant account");

      // Deleting dormant account while skill uninstalled succeeds (200)
      const delDormant = await fetch(`${ws.baseUrl}/api/integrations/mail/accounts/${qqAccountId}`, { method: "DELETE" });
      setEvidence("deleteDormantStatus", delDormant.status);
      assert.equal(delDormant.status, 200);

      // 2. Reinstall via Store UI "添加", then click "配置" to open Detail view!
      await chrome!.click("#back-to-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#skills-store-view')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const qq = rows.find(r => r.textContent?.includes('QQ 邮箱'));
        const btn = Array.from(qq?.querySelectorAll('button') || []).find(b => b.textContent?.includes('添加'));
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const qq = rows.find(r => r.textContent?.includes('QQ 邮箱'));
        return Boolean(qq?.textContent?.includes('配置') || (document.querySelector('#skill-detail-view') && !document.querySelector('#skill-detail-view').hidden));
      })()`, 6000);

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

      // Click #skill-detail-remove-btn -> check purge checkbox -> confirm removal
      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const qq = rows.find(r => r.textContent?.includes('QQ 邮箱'));
        qq?.querySelector('button')?.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#skill-detail-remove-btn'))`, 6000);
      await chrome!.click("#skill-detail-remove-btn");
      await chrome!.waitFor(`Boolean(document.querySelector('#skill-detail-remove-slot .skill-remove-confirm input[type="checkbox"]'))`, 4000);
      await chrome!.click('#skill-detail-remove-slot .skill-remove-confirm input[type="checkbox"]');
      await chrome!.click('#skill-detail-remove-slot .skill-remove-confirm .is-danger');
      await chrome!.waitFor(`!document.querySelector('#skills-store-view')?.hidden`, 6000);

      assert.ok(!JSON.stringify(ws.store.readMailAuth()).includes(qqAccountId2), "Uninstall with purge checkbox must delete qqmail credentials");
      await chrome!.click("#close-apps-modal-btn");
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SKILL-07 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SKILL-07",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "KimiCU / MCP 全面板 UI 与安全闭环(PI-013)：未安装检测态、JSON配置错误校验、保存并重连、重新握手、工具芯片、截图回传、env脱敏与反自控",
      module: "MCP Client & UI (kimi-cu)",
    },
    async () => {
      await ensureAtWorkspace();
      const mcpScript = createMockMcpServerScript(ws.tmpDir);

      // 1. Install kimi-cu pointing to a non-existent binary -> verify UI shows "未安装" / missing binary badge!
      await fetch(`${ws.baseUrl}/api/skills/kimi-cu/install`, { method: "POST" });
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostComputer: { executionMode: "always" },
          mcpServers: {
            "kimi-cu": {
              command: "/nonexistent/path/to/missing-kimi-cu-bin",
              args: [],
              enabled: true,
            },
          },
        }),
      });

      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#connect-apps-btn");
      await chrome!.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`);
      await chrome!.evalJs(`(() => {
        const rows = Array.from(document.querySelectorAll('#skills-store-sections .skill-row'));
        const kc = rows.find(r => r.textContent?.includes('KimiCU'));
        kc?.querySelector('button')?.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('#mcp-skill-config-panel'))`, 6000);
      await chrome!.waitFor(
        `/未安装|连接异常|不可用/.test(document.querySelector('#mcp-status-badge')?.textContent || '')`,
        6000
      );

      // 2. Test invalid JSON in #mcp-config-json-input -> shows error in #mcp-config-feedback
      await chrome!.fill("#mcp-config-json-input", "{ invalid json");
      await chrome!.click("#mcp-save-reconnect-btn");
      await chrome!.waitFor(`document.querySelector('#mcp-config-feedback')?.classList.contains('is-error')`, 4000);

      // 3. Save valid local mock MCP config via UI #mcp-save-reconnect-btn -> badge turns "已就绪" + #mcp-tools-chips populated!
      const validJson = JSON.stringify({ command: process.execPath, args: [mcpScript], enabled: true }, null, 2);
      await chrome!.fill("#mcp-config-json-input", validJson);
      await chrome!.click("#mcp-save-reconnect-btn");
      await chrome!.waitFor(
        `document.querySelector('#mcp-status-badge')?.textContent?.includes('已就绪') &&
         document.querySelectorAll('#mcp-tools-chips .mcp-tool-chip, #mcp-tools-chips code, #mcp-tools-chips span').length >= 3`,
        8000
      );

      // 4. Test #mcp-test-reconnect-btn (hits POST /api/mcp/reconnect) -> success feedback!
      await chrome!.click("#mcp-test-reconnect-btn");
      await chrome!.waitFor(
        `document.querySelector('#mcp-config-feedback')?.classList.contains('is-success') &&
         document.querySelector('#mcp-config-feedback')?.textContent?.includes('重新握手成功')`,
        8000
      );
      const directRecon = await fetch(`${ws.baseUrl}/api/mcp/reconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "kimi-cu" }),
      });
      assert.equal(directRecon.status, 200);
      await chrome!.click("#close-apps-modal-btn");

      // 5. Run Agent calling inspect_env (scrubbed), click (screenshot saved), and self-control click (denied!)
      const mcpBot = ws.store.createSession({ title: "McpBot" });
      let step = 0;
      let envResultText = "";
      let selfControlResult = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "操控应用" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) return { toolCalls: [{ id: "mc-1", name: "mcp__kimi_cu__inspect_env", args: { risk: "low" } }] };
        if (step === 2) {
          envResultText = s;
          return { toolCalls: [{ id: "mc-2", name: "mcp__kimi_cu__click", args: { app: "Notes", x: 100, y: 200, risk: "low" } }] };
        }
        if (step === 3) {
          return { toolCalls: [{ id: "mc-3", name: "mcp__kimi_cu__click", args: { app: "com.twinklebot.desktop", x: 50, y: 50, risk: "low" } }] };
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

      // 6. Chat Channels (#13): install feishu-bot & telegram-bot, verify GET/POST/test & webhook endpoints
      assert.equal((await fetch(`${ws.baseUrl}/api/skills/feishu-bot/install`, { method: "POST" })).status, 200);
      assert.equal((await fetch(`${ws.baseUrl}/api/skills/telegram-bot/install`, { method: "POST" })).status, 200);
      const chList: any = await (await fetch(`${ws.baseUrl}/api/integrations/channels`)).json();
      assert.equal(chList.ok, true);
      assert.ok(chList.channels["feishu-bot"] && chList.channels["telegram-bot"]);

      const tgSave = await fetch(`${ws.baseUrl}/api/integrations/channels/telegram-bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          connectionMode: "webhook",
          botToken: "123:e2e-tok",
          webhookSecret: "tg-sec",
          allowedSenderIds: ["999001"],
        }),
      });
      assert.equal(tgSave.status, 200);
      const tgTestBad = await fetch(`${ws.baseUrl}/api/integrations/channels/telegram-bot/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: "" }),
      });
      assert.ok(tgTestBad.status === 400 || tgTestBad.status === 200);
      const tgHookBad = await fetch(`${ws.baseUrl}/api/channels/telegram/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: JSON.stringify({ update_id: 1 }),
      });
      assert.equal(tgHookBad.status, 401);

      const fsSave = await fetch(`${ws.baseUrl}/api/integrations/channels/feishu-bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          connectionMode: "webhook",
          appId: "cli_e2e",
          appSecret: "sec_e2e",
          verificationToken: "vtok_e2e",
          allowedSenderIds: ["ou_e2e"],
        }),
      });
      assert.equal(fsSave.status, 200);
      const fsChallenge: any = await (
        await fetch(`${ws.baseUrl}/api/channels/feishu/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "url_verification", token: "vtok_e2e", challenge: "chal-123" }),
        })
      ).json();
      assert.equal(fsChallenge.challenge, "chal-123");

      // 7. Multi-Bot Channels + 6-Digit Pairing + Conversational Config + Capability Gate ("channel-multi-bot-pairing-v1")
      const diagCapRes: any = await (await fetch(`${ws.baseUrl}/api/system/diagnostics`)).json();
      assert.ok(
        Array.isArray(diagCapRes.apiCapabilities) &&
          diagCapRes.apiCapabilities.includes("channel-multi-bot-pairing-v1"),
        "Diagnostics must advertise channel-multi-bot-pairing-v1 capability"
      );

      const chAfterLegacy: any = await (await fetch(`${ws.baseUrl}/api/integrations/channels`)).json();
      const tgAcctId = chAfterLegacy.channels?.["telegram-bot"]?.accounts?.[0]?.id || "tg_default";
      const tgAcctHookBad = await fetch(`${ws.baseUrl}/api/channels/telegram/webhook/${tgAcctId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: JSON.stringify({ update_id: 2 }),
      });
      assert.equal(tgAcctHookBad.status, 401);

      const fsCreate2: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/channels/feishu-bot/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: "E2E 飞书助手2",
            enabled: true,
            connectionMode: "webhook",
            appId: "cli_e2e_2",
            appSecret: "sec_e2e_2",
            verificationToken: "vtok_e2e_2",
            defaultSessionId: mcpBot.id,
            requirePairing: true,
            allowedSenderIds: [],
          }),
        })
      ).json();
      assert.equal(fsCreate2.ok, true);
      const fsAcct2 = fsCreate2.accountId;
      assert.ok(fsAcct2);
      assert.equal(fsCreate2.channels["feishu-bot"].accounts.length, 2);

      const fsPatch2: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/channels/feishu-bot/accounts/${fsAcct2}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: "E2E 飞书助手2-更新" }),
        })
      ).json();
      assert.equal(fsPatch2.ok, true);
      assert.equal(
        fsPatch2.channels["feishu-bot"].accounts.find((a: any) => a.id === fsAcct2)?.config?.label,
        "E2E 飞书助手2-更新"
      );

      const fsTestAcct2 = await fetch(
        `${ws.baseUrl}/api/integrations/channels/feishu-bot/accounts/${fsAcct2}/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      assert.ok(fsTestAcct2.status === 200 || fsTestAcct2.status === 400);

      // Account-scoped Feishu webhook verification + pairing code 1 (reject path)
      const fsAcctChallenge: any = await (
        await fetch(`${ws.baseUrl}/api/channels/feishu/webhook/${fsAcct2}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "url_verification", token: "vtok_e2e_2", challenge: "chal-acct-2" }),
        })
      ).json();
      assert.equal(fsAcctChallenge.challenge, "chal-acct-2");

      await fetch(`${ws.baseUrl}/api/channels/feishu/webhook/${fsAcct2}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: { event_id: "e2e_ev_pair_1", event_type: "im.message.receive_v1", token: "vtok_e2e_2" },
          event: {
            sender: { sender_id: { open_id: "ou_e2e_stranger_1" } },
            message: {
              message_id: "om_e2e_p1",
              chat_id: "oc_e2e_pair_1",
              message_type: "text",
              content: JSON.stringify({ text: "请求配对1" }),
            },
          },
        }),
      });
      const pairList1: any = await (await fetch(`${ws.baseUrl}/api/integrations/channels/pairings`)).json();
      assert.equal(pairList1.ok, true);
      const pending1 = (pairList1.pending || []).find((p: any) => p.accountId === fsAcct2 && p.chatId === "oc_e2e_pair_1");
      assert.match(pending1?.code || "", /^\d{6}$/);

      const rejectRes: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/channels/pairings/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: pending1.code }),
        })
      ).json();
      assert.equal(rejectRes.ok, true);

      // Pairing code 2 -> approve via App-side Bot tool (channel_pairing_manage)
      await fetch(`${ws.baseUrl}/api/channels/feishu/webhook/${fsAcct2}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: { event_id: "e2e_ev_pair_2", event_type: "im.message.receive_v1", token: "vtok_e2e_2" },
          event: {
            sender: { sender_id: { open_id: "ou_e2e_stranger_2" } },
            message: {
              message_id: "om_e2e_p2",
              chat_id: "oc_e2e_pair_2",
              message_type: "text",
              content: JSON.stringify({ text: "请求配对2" }),
            },
          },
        }),
      });
      const pairList2: any = await (await fetch(`${ws.baseUrl}/api/integrations/channels/pairings`)).json();
      const pending2 = (pairList2.pending || []).find((p: any) => p.accountId === fsAcct2 && p.chatId === "oc_e2e_pair_2");
      assert.match(pending2?.code || "", /^\d{6}$/);

      let pairStep = 0;
      let toolApproveOutput = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "配对审批" };
        const s = JSON.stringify(body?.messages || "");
        pairStep += 1;
        if (pairStep === 1) {
          return {
            toolCalls: [
              {
                id: "pm-1",
                name: "channel_pairing_manage",
                args: { action: "approve", code: pending2.code },
              },
            ],
          };
        }
        toolApproveOutput = s;
        return { text: `已放行配对码 ${pending2.code}` };
      });
      await fetch(`${ws.baseUrl}/api/sessions/${mcpBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `请审批飞书配对码 ${pending2.code}` }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(mcpBot.id), 10_000, "channel_pairing_manage turn completes");
      ws.mockLlm.setHandler(undefined);
      assert.ok(toolApproveOutput.includes("oc_e2e_pair_2"));

      // Conversational channel config tool (`skill_configure_channel`) bound to `mcpBot`
      let cfgStep = 0;
      let toolCfgOutput = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "渠道配置" };
        const s = JSON.stringify(body?.messages || "");
        cfgStep += 1;
        if (cfgStep === 1) {
          return {
            toolCalls: [
              {
                id: "cc-1",
                name: "skill_configure_channel",
                args: {
                  action: "whitelist",
                  channel: "feishu-bot",
                  account_id: fsAcct2,
                  add_allowed_sender_ids: ["ou_e2e_added_via_tool"],
                },
              },
            ],
          };
        }
        toolCfgOutput = s;
        return { text: "已把 ou_e2e_added_via_tool 加入飞书白名单" };
      });
      await fetch(`${ws.baseUrl}/api/sessions/${mcpBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "把 ou_e2e_added_via_tool 加入飞书白名单" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(mcpBot.id), 10_000, "skill_configure_channel turn completes");
      ws.mockLlm.setHandler(undefined);
      assert.ok(toolCfgOutput.includes("ou_e2e_added_via_tool"));
      const chAfterCfgTool: any = await (await fetch(`${ws.baseUrl}/api/integrations/channels`)).json();
      const acct2AfterCfg = (chAfterCfgTool.channels?.["feishu-bot"]?.accounts || []).find(
        (a: any) => a.id === fsAcct2
      );
      assert.ok(acct2AfterCfg?.config?.allowedSenderIds?.includes("ou_e2e_added_via_tool"));

      // Pairing code 3 -> approve / toggle / delete via HTTP
      await fetch(`${ws.baseUrl}/api/channels/feishu/webhook/${fsAcct2}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: { event_id: "e2e_ev_pair_3", event_type: "im.message.receive_v1", token: "vtok_e2e_2" },
          event: {
            sender: { sender_id: { open_id: "ou_e2e_stranger_3" } },
            message: {
              message_id: "om_e2e_p3",
              chat_id: "oc_e2e_pair_3",
              message_type: "text",
              content: JSON.stringify({ text: "请求配对3" }),
            },
          },
        }),
      });
      const pairList3: any = await (await fetch(`${ws.baseUrl}/api/integrations/channels/pairings`)).json();
      const pending3 = (pairList3.pending || []).find((p: any) => p.accountId === fsAcct2 && p.chatId === "oc_e2e_pair_3");
      assert.match(pending3?.code || "", /^\d{6}$/);

      const httpApproveRes: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/channels/pairings/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: pending3.code }),
        })
      ).json();
      assert.equal(httpApproveRes.ok, true);

      const toggleOff: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/channels/pairings/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: "feishu-bot",
            accountId: fsAcct2,
            chatId: "oc_e2e_pair_3",
            enabled: false,
          }),
        })
      ).json();
      assert.equal(toggleOff.ok, true);
      assert.equal(toggleOff.enabled, false);

      const delApprovedRes: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/channels/pairings/approved`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: "feishu-bot",
            accountId: fsAcct2,
            chatId: "oc_e2e_pair_3",
          }),
        })
      ).json();
      assert.equal(delApprovedRes.ok, true);

      const delAcct2Res: any = await (
        await fetch(`${ws.baseUrl}/api/integrations/channels/feishu-bot/accounts/${fsAcct2}`, {
          method: "DELETE",
        })
      ).json();
      assert.equal(delAcct2Res.ok, true);
      assert.equal(delAcct2Res.channels["feishu-bot"].accounts.length, 1);
    },
    { getChrome: () => chrome }
  );
});
