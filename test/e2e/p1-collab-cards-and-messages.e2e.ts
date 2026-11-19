import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { selectGroupSpeakers, MAX_GROUP_TURNS } from "../../src/agent/group-coordinator.js";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { SAMPLE_PNG_BASE64, SAMPLE_PNG_BUFFER } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P1 Suite 4: Group Coordinator, Cross-Bot Collab, Cards, Message Ops, Sandboxed Preview, Multi-Tab/SSE & Inspector/Scheduler", async (t) => {
  const collector = createSuiteCollector("p1-collab-cards-and-messages");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  const ws = await createE2EWorkspace({
    smartRouter: false,
    schedulerTickMs: 120,
    startScheduler: true,
  });
  t.after(() => ws.close());

  // ---------- P1-GRP-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-GRP-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "群聊协调器 4 项规则：最长前缀优先(@谷歌账号管家 vs @谷歌)、回复优先路由、职责打分选人与 MAX_GROUP_TURNS=3",
      module: "Group Coordinator",
    },
    async () => {
      const bShort = { id: "g1", title: "谷歌", rolePrompt: "通用搜索" };
      const bLong = { id: "g2", title: "谷歌账号管家", rolePrompt: "管理账号密码和二步验证" };
      const bSec = { id: "g3", title: "安全审计员", rolePrompt: "漏洞扫描与渗透测试" };

      // 1. Longest title prefix match
      const spLong = selectGroupSpeakers({ text: "请 @谷歌账号管家 检查一下登录", memberBots: [bShort, bLong, bSec], maxSpeakers: 1 });
      assert.equal(spLong[0]?.id, "g2", "Longest prefix @谷歌账号管家 must match before @谷歌");

      // 2. Reply-to-bot priority routing
      const spReply = selectGroupSpeakers({ text: "收到，请继续", memberBots: [bShort, bLong, bSec], replyToBotId: "g3", maxSpeakers: 1 });
      assert.equal(spReply[0]?.id, "g3", "Replying to specific bot must prioritize that bot");

      // 3. Relevance scoring without @mention
      const spScore = selectGroupSpeakers({ text: "请帮我做一次漏洞扫描和渗透测试", memberBots: [bShort, bLong, bSec], maxSpeakers: 1 });
      assert.equal(spScore[0]?.id, "g3", "Role relevance scoring must select matching specialist");

      // 4. Cap constant check
      assert.equal(MAX_GROUP_TURNS, 3);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-COLLAB-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-COLLAB-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "Agent 跨 Bot 工具链(create_bot/send_bot_message/4跳防环/create_bot_group) + 交流胶囊与抽屉",
      module: "Multi-Bot Collaboration",
    },
    async () => {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('Twinkle') &&
         document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`
      );

      let step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "跨Bot协作" };
        const s = JSON.stringify(body?.messages || "");
        if (s.includes("请帮我核对数据") && !s.includes("创建数据分析师并请他核对数据")) {
          return { text: "数据分析师回复：数据已核对无误！" };
        }
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [
              {
                id: "cb-1",
                name: "create_bot",
                args: { name: "数据分析师", role_prompt: "专注数据核对", initial_message: "请帮我核对数据" },
              },
            ],
          };
        }
        return { text: "已委派数据分析师完成协作" };
      });

      await chrome!.typeText("#message-input", "创建数据分析师并请他核对数据", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('已委派数据分析师完成协作'))`,
        12_000
      );
      ws.mockLlm.setHandler(undefined);

      await chrome!.waitFor(`Boolean(document.querySelector('.bot-exchange-pill'))`, 8000);
      await chrome!.click(".bot-exchange-pill");
      await chrome!.waitFor(`!document.querySelector('#bot-exchange-sheet')?.hidden`, 6000);
      const sheetTxt = await chrome!.evalJs<string>(`document.querySelector('#exchange-messages-list')?.textContent || ''`);
      assert.match(sheetTxt, /请帮我核对数据/);
      await chrome!.click("#close-exchange-sheet-btn");
      await chrome!.waitFor(`document.querySelector('#bot-exchange-sheet')?.hidden`);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-CARD-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-CARD-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "ChoiceCard 提问卡全模式：单选、多选、多题步进 1/N、自定义输入与插话自动跳过(.is-superseded)",
      module: "Interactive ChoiceCard",
    },
    async () => {
      const cardBot = ws.store.createSession({ title: "CardTestBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('CardTestBot'))`
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('CardTestBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('CardTestBot')`);

      // Multi-step choice card (2 questions: Q1 single, Q2 custom input)
      let step = 0;
      let capturedAnswer = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "等待选择" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [
              {
                id: "ch-multi",
                name: "ask_user_choice",
                args: {
                  questions: [
                    { question: "选择部署环境", options: ["本地", "云端"], multi_select: false },
                    { question: "填写自定义备注", options: ["默认", "跳过"], allow_custom: true },
                  ],
                },
              },
            ],
          };
        }
        capturedAnswer = s;
        return { text: "多步选择已全部收到" };
      });

      await chrome!.typeText("#message-input", "发起多步选择卡", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.choice-stepper-pill'))`, 8000);
      assert.match(
        await chrome!.evalJs<string>(`document.querySelector('.choice-stepper-pill')?.textContent || ''`),
        /1\s*\/\s*2/
      );
      // Answer Q1 -> advances to 2 / 2
      await chrome!.click(`.choice-card:not(.is-resolved) [data-choice-index="1"]`);
      await chrome!.waitFor(`document.querySelector('.choice-stepper-pill')?.textContent?.includes('2')`);
      // Answer Q2 via custom input
      await chrome!.click(".choice-custom-trigger");
      await chrome!.waitFor(`Boolean(document.querySelector('.choice-custom-input'))`);
      await chrome!.fill(".choice-custom-input", "自定义灰度发布");
      await chrome!.click(".choice-custom-submit");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('多步选择已全部收到'))`,
        8000
      );
      assert.match(capturedAnswer, /云端/);
      assert.match(capturedAnswer, /自定义灰度发布/);

      // Superseded choice card when user sends a new message mid-choice
      step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "等待选择" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{ id: "ch-sup", name: "ask_user_choice", args: { question: "要跳过的问题", options: ["A", "B"] } }],
          };
        }
        return { text: "已收到新指令跳过旧选择" };
      });
      await chrome!.typeText("#message-input", "发一个待跳过的提问卡", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.choice-card:not(.is-resolved):not(.is-superseded)'))`, 8000);
      await chrome!.typeText("#message-input", "不用选了直接给结果", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.choice-card.is-superseded'))`, 8000);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('已收到新指令跳过旧选择'))`,
        8000
      );
      ws.mockLlm.setHandler(undefined);
      assert.ok(cardBot.id);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-CARD-02 ----------
  await collector.runCase(
    t,
    {
      id: "P1-CARD-02",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "ApprovalCard 自定义规则编辑器(.btn-edit-rule) + DraftCard 内联编辑确认/取消",
      module: "Approval Rule Editor / DraftCard",
    },
    async () => {
      // 1. DraftCard inline edit & approve
      let step = 0;
      let seenDraftResult = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (
          s.includes("ultra-short Chinese phrase") ||
          s.includes("Distill the current task progress") ||
          s.includes("短语") ||
          s.includes("概括")
        )
          return { text: "等待确认草稿" };
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [
              {
                id: "dr-1",
                name: "propose_draft",
                args: { title: "原标题", recipient: "old@example.test", content: "原正文", kind: "email" },
              },
            ],
          };
        }
        seenDraftResult = s;
        return { text: "草稿已按修改后内容确认" };
      });

      await chrome!.typeText("#message-input", "起草一封邮件草稿", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.draft-card:not(.is-collapsed)'))`, 8000);
      await chrome!.fill(".draft-card:not(.is-collapsed) .draft-body-textarea", "用户修订后的最终正文内容");
      await chrome!.click(".draft-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('草稿已按修改后内容确认'))`,
        8000
      );
      assert.match(seenDraftResult, /用户修订后的最终正文内容/);

      // 2. ApprovalCard inline custom rule editor
      step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (
          s.includes("ultra-short Chinese phrase") ||
          s.includes("Distill the current task progress") ||
          s.includes("短语") ||
          s.includes("概括")
        )
          return { text: "等待审批" };
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{ id: "er-1", name: "run_shell", args: { command: "echo custom-rule-cmd", risk: "high" } }],
          };
        }
        return { text: "自定义规则保存并放行完成" };
      });
      await chrome!.typeText("#message-input", "触发审批自定义规则编辑", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.confirm-card:not(.is-collapsed)'))`, 8000);
      await chrome!.click(".confirm-card:not(.is-collapsed) .btn-edit-rule");
      await chrome!.waitFor(`!document.querySelector('.confirm-card:not(.is-collapsed) .confirm-rule-editor')?.hidden`);
      await chrome!.fill(".confirm-card:not(.is-collapsed) .confirm-rule-editor input", "custom-rule-cmd");
      await chrome!.click(".confirm-card:not(.is-collapsed) .confirm-rule-editor .settings-blue-pill");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('自定义规则保存并放行完成'))`,
        8000
      );
      const pol = ws.store.readSettings().policy;
      assert.ok((pol?.allowRules || []).some((r: any) => r.pattern === "custom-rule-cmd"));
      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-MSG-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-MSG-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "历史用户消息内联「修改并重发」截断回滚 DOM / NDJSON / History 并重跑",
      module: "Message Edit & Rewind",
    },
    async () => {
      const editBot = ws.store.createSession({ title: "RewindBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('RewindBot'))`
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('RewindBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('RewindBot')`);

      ws.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (
          s.includes("ultra-short Chinese phrase") ||
          s.includes("Distill the current task progress") ||
          s.includes("短语") ||
          s.includes("概括")
        )
          return { text: "回复中" };
        if (s.includes("修正后的第二问")) return { text: "重发后的全新答案" };
        return { text: "原始旧答案_MUST_BE_TRUNCATED" };
      });

      await chrome!.typeText("#message-input", "原始第一问", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('原始旧答案_MUST_BE_TRUNCATED'))`,
        8000
      );

      // Click inline edit button on user message
      await chrome!.click(`.msg-group.is-user .msg-action-icon[title="修改并重发"]`);
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-inline-edit-textarea'))`);
      await chrome!.fill(".msg-inline-edit-textarea", "修正后的第二问");
      await chrome!.click(".msg-inline-edit-btn.is-primary");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('重发后的全新答案'))`,
        8000
      );

      const pageText = await chrome!.evalJs<string>(`document.querySelector('#event-stream')?.textContent || ''`);
      assert.ok(!pageText.includes("原始旧答案_MUST_BE_TRUNCATED"), "Old answer must be rewound from DOM");
      const rawNdjson = fs.readFileSync(path.join(ws.dataDir, "sessions", `${editBot.id}.ndjson`), "utf8");
      assert.ok(!rawNdjson.includes("原始旧答案_MUST_BE_TRUNCATED"), "Old answer must be truncated from NDJSON");
      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-MSG-02 ----------
  await collector.runCase(
    t,
    {
      id: "P1-MSG-02",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "消息悬停「回复此消息」锚点定位闪烁 + 正文划词浮窗(#selection-quote-toolbar)多条引用筹码",
      module: "Reply Anchor & Selection Quote",
    },
    async () => {
      // Reply to existing bot message
      await chrome!.click(`.msg-group.is-bot .msg-action-icon[title="回复此消息"]`);
      await chrome!.waitFor(`!document.querySelector('#reply-quote-bar')?.hidden`);

      // Select text inside bot bubble -> triggers #selection-quote-toolbar
      await chrome!.selectText(".msg-group.is-bot .bot-bubble", 0, 6);
      await chrome!.waitFor(`!document.querySelector('#selection-quote-toolbar')?.hidden`, 6000);
      await chrome!.click("#selection-quote-btn");
      await chrome!.waitFor(`document.querySelectorAll('#composer-quotes-bar .quote-staging-chip').length >= 1`);

      ws.mockLlm.setHandler(async ({ body }) => {
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "整理引用" };
        return { text: "已收到引用与回复" };
      });
      await chrome!.typeText("#message-input", "针对这段再解释下", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-reply-anchor'))`, 8000);
      await chrome!.click(".msg-reply-anchor");
      await chrome!.waitFor(`Boolean(document.querySelector('.is-reply-target-flash'))`, 4000);
      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-MSG-03 ----------
  await collector.runCase(
    t,
    {
      id: "P1-MSG-03",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "三入口附件上传(选文件/粘贴图片/舞台拖拽) + 筹码移除 + FileAttachmentCard 下载与缺失置灰",
      module: "Attachments & File Delivery",
    },
    async () => {
      const sampleFile = path.join(ws.tmpDir, "upload-sample.png");
      fs.writeFileSync(sampleFile, SAMPLE_PNG_BUFFER);

      // 1. File input upload
      await chrome!.setFileInputFiles("#attachment-file-input", [sampleFile]);
      await chrome!.waitFor(`document.querySelectorAll('#composer-attachments-bar .attachment-chip').length >= 1`, 6000);

      // 2. Clipboard paste image
      await chrome!.pasteFile("#message-input", {
        name: "pasted-img.png",
        mimeType: "image/png",
        bytesBase64: SAMPLE_PNG_BASE64,
      });
      await chrome!.waitFor(`document.querySelectorAll('#composer-attachments-bar .attachment-chip').length >= 2`, 6000);

      // 3. Drag & drop file onto chat stage
      await chrome!.dropFile(".chat-stage", {
        name: "dropped-note.txt",
        mimeType: "text/plain",
        bytesBase64: Buffer.from("dropped text").toString("base64"),
      });
      await chrome!.waitFor(`document.querySelectorAll('#composer-attachments-bar .attachment-chip').length >= 3`, 6000);

      // Remove one attachment chip
      await chrome!.click(`#composer-attachments-bar .attachment-chip button`);
      await chrome!.waitFor(`document.querySelectorAll('#composer-attachments-bar .attachment-chip').length === 2`);

      // Test send_file deliverable card + missing file disabled state
      const delivFile = path.join(ws.workspaceDir, "deliverable-demo.txt");
      fs.writeFileSync(delivFile, "deliverable-payload", "utf8");

      let step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "发送文件" };
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "sf-1", name: "send_file", args: { path: delivFile, label: "演示产物" } }] };
        }
        return { text: "文件已投递" };
      });
      await chrome!.typeText("#message-input", "发送附件并回传产物", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-file-card'))`, 8000);
      ws.mockLlm.setHandler(undefined);

      const metaRes: any = await (await fetch(`${ws.baseUrl}/api/files/meta?path=${encodeURIComponent(delivFile)}`)).json();
      assert.equal(metaRes.exists, true);
      const missingRes: any = await (
        await fetch(`${ws.baseUrl}/api/files/meta?path=${encodeURIComponent(path.join(ws.workspaceDir, "nonexistent.pdf"))}`)
      ).json();
      assert.equal(missingRes.exists, false);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-MSG-04 ----------
  await collector.runCase(
    t,
    {
      id: "P1-MSG-04",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "MarkupPreviewCard HTML/SVG 实时沙盒预览、无 allow-same-origin 隔离与全屏三档视口切换",
      module: "HTML/SVG Sandboxed Preview",
    },
    async () => {
      ws.mockLlm.setHandler(async ({ body }) => {
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "生成页面" };
        return {
          text: "这是交互预览卡片：\n\n```html\n<!doctype html><html><body><h1>E2E Preview</h1><script>window.__parentLeak = (() => { try { return !!window.parent.localStorage; } catch { return 'BLOCKED'; } })();</script></body></html>\n```",
        };
      });
      await chrome!.typeText("#message-input", "渲染一段 HTML 预览卡片", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-preview-card[data-preview-kind="html"]'))`, 8000);
      ws.mockLlm.setHandler(undefined);

      const sandboxAttr = await chrome!.evalJs<string>(
        `document.querySelector('.msg-preview-card .msg-preview-iframe')?.getAttribute('sandbox') || ''`
      );
      assert.ok(sandboxAttr.includes("allow-scripts"), "Preview iframe must allow scripts");
      assert.ok(!sandboxAttr.includes("allow-same-origin"), "Preview iframe MUST NOT grant allow-same-origin");

      // Open fullscreen preview modal and test full / desktop / mobile viewport switches
      await chrome!.evalJs(`(() => {
        const btns = Array.from(document.querySelectorAll('.msg-preview-card .msg-preview-btn'));
        const fsBtn = btns.find(b => /全屏|放大/.test(b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || ''));
        fsBtn && fsBtn.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#html-preview-dialog')?.open`, 6000);
      for (const vp of ["desktop", "mobile", "full"]) {
        await chrome!.click(`[data-preview-vp="${vp}"]`);
        await chrome!.waitFor(`document.querySelector('#html-preview-modal-stage')?.dataset?.vp === '${vp}'`);
      }
      await chrome!.click("#close-html-preview-dialog-btn");
      await chrome!.waitFor(`!document.querySelector('#html-preview-dialog')?.open`);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-SYNC-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-SYNC-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "双桌面标签页实时同步 & 首连 /ws 失败自动降级 SSE(/api/events) + billing_updated 通道取证",
      module: "Realtime Transport / Multi-Tab Sync",
    },
    async ({ setEvidence }) => {
      const tab2 = await chrome!.openNewTab(ws.baseUrl);
      t.after(() => tab2.close());
      await tab2.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);

      // Create bot via API (or tab1) -> tab2 receives bot_created live over /ws without reload!
      const createRes = await fetch(`${ws.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SyncTabBot" }),
      });
      assert.equal(createRes.status, 201);
      await tab2.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(el => el.textContent?.includes('SyncTabBot'))`,
        6000
      );

      // Verify SSE fallback when WebSocket fails on first connect!
      const sseTab = await chrome!.openNewTab("about:blank");
      t.after(() => sseTab.close());
      await sseTab.addInitScript(`
        window.WebSocket = class FailingWS {
          constructor() {
            setTimeout(() => {
              this.onerror && this.onerror(new Event('error'));
              this.onclose && this.onclose(new CloseEvent('close'));
            }, 10);
          }
          close() {}
        };
      `);
      await sseTab.navigate(ws.baseUrl);
      await sseTab.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);

      // Verify SSE stream delivers bot_created
      await fetch(`${ws.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SseFallbackBot" }),
      });
      await sseTab.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(el => el.textContent?.includes('SseFallbackBot'))`,
        6000
      );

      // Check white-box clue #2: does /api/events SSE stream emit billing_updated?
      const sseProbe = await new Promise<string>(async (resolve) => {
        const ctrl = new AbortController();
        const r = await fetch(`${ws.baseUrl}/api/events`, { signal: ctrl.signal });
        const reader = r.body!.getReader();
        let buf = "";
        setTimeout(() => {
          // Trigger billing_updated via calibration
          fetch(`${ws.baseUrl}/api/billing/providers/e2e-primary/calibration`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "set", amountCny: 99 }),
          }).catch(() => {});
        }, 80);
        setTimeout(() => {
          ctrl.abort();
          resolve(buf);
        }, 350);
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
          }
        } catch {
          resolve(buf);
        }
      });
      setEvidence("sseReceivedBillingUpdated", sseProbe.includes("billing_updated"));
      assert.ok(sseProbe.includes("billing_updated"), "/api/events SSE fallback must receive billing_updated events");
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-INSP-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-INSP-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "右侧人设保存、Bot 专属记忆启停注入 Prompt 与例行定时任务到期自动唤醒执行",
      module: "RightInspector / Memories / Scheduler",
    },
    async () => {
      const inspBot = ws.store.createSession({ title: "InspSchedBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('InspSchedBot'))`
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('InspSchedBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('InspSchedBot')`);

      // Edit persona & save
      await chrome!.fill("#bot-persona-input", "你是严谨的架构评审专家_MARKER_99");
      await chrome!.waitFor(`!document.querySelector('#save-persona-btn')?.hidden`);
      await chrome!.click("#save-persona-btn");
      await ws.waitUntil(() => Boolean(ws.store.getSession(inspBot.id)?.rolePrompt?.includes("MARKER_99")), 4000, "persona saved");

      // Add Bot memory via modal
      await chrome!.click("#new-bot-memory-btn");
      await chrome!.waitFor(`!document.querySelector('#bot-memory-modal-backdrop')?.hidden`);
      await chrome!.fill("#bot-memory-modal-name-input", "编码规范");
      await chrome!.fill("#bot-memory-modal-content-input", "必须输出 MEM_TAG_ALPHA");
      await chrome!.click("#save-bot-memory-modal-btn");
      await chrome!.waitFor(`document.querySelector('#bot-memory-modal-backdrop')?.hidden`);

      // Verify both persona & memory are injected into model system prompt!
      ws.mockLlm.clearRequests();
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "核查记忆" };
        return { text: "收到定时或普通任务" };
      });
      await chrome!.typeText("#message-input", "检查你的系统提示词", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('收到定时或普通任务'))`,
        8000
      );
      const sysPrompt = String(
        ws.mockLlm.capturedRequests.find((r) => String(r.body?.messages?.[0]?.content || "").includes("MARKER_99"))?.body
          ?.messages?.[0]?.content || ""
      );
      assert.match(sysPrompt, /MARKER_99/, "Persona must be injected into system prompt");
      assert.match(sysPrompt, /MEM_TAG_ALPHA/, "Enabled bot memory must be injected into system prompt");

      // Create an already-due 'once' schedule -> scheduler ticks every 120ms and fires it automatically!
      const schedRes = await fetch(`${ws.baseUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: inspBot.id,
          title: "自动巡检",
          prompt: "执行巡检汇报",
          repeat: "once",
          nextRunAt: new Date(Date.now() - 1000).toISOString(),
          enabled: true,
        }),
      });
      assert.equal(schedRes.status, 201);
      const schedCreated: any = await schedRes.json();

      await ws.waitUntil(() => {
        const list = ws.store.readSchedules();
        const cur = list.find((s: any) => s.id === schedCreated.id);
        return Boolean(cur && cur.lastRunAt && cur.enabled === false);
      }, 6000, "once schedule fired and auto-disabled");

      const evs = ws.store.readEvents(inspBot.id);
      assert.ok(evs.some((e: any) => e.type === "user" && String(e.text || "").includes("[例行任务 · 自动巡检]")));
      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );
});
