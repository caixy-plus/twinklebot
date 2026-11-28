import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { selectGroupSpeakers, MAX_GROUP_TURNS } from "../../src/agent/group-coordinator.js";
import { buildSystemInstruction } from "../../src/agent/prompt.js";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { SAMPLE_PNG_BASE64, SAMPLE_PNG_BUFFER } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P1 Suite 4: Group Coordinator, Cross-Bot Collab, Built-in Tools, Modular Prompts, Cards, Message Ops, Sandboxed Preview, Multi-Tab/SSE & Inspector/Scheduler", async (t) => {
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

  const ensureAtWorkspace = async () => {
    const url = await chrome!.evalJs<string>(`window.location.href`).catch(() => "");
    if (!url.startsWith(ws.baseUrl)) {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`,
        10_000
      );
    }
  };

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
      title: "Agent 跨 Bot 工具链全实测(list_bots/create_bot/send_bot_message/4跳防环/create_bot_group/bot_manage) + 交流胶囊与抽屉",
      module: "Multi-Bot Collaboration",
    },
    async () => {
      await ensureAtWorkspace();
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('Twinkle')`, 8000);

      let step = 0;
      let createdBotId = "";
      let createdGroupId = "";
      let hopBlocked = false;
      let selfSendBlocked = false;

      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "跨Bot协作" };
        const sys = String(body?.messages?.[0]?.content || "");
        const s = JSON.stringify(body?.messages || "");
        const isMainTwinkle = !sys.includes("数据分析师") && !sys.includes("协作接力B");

        // Sub-bot handlers
        if (!isMainTwinkle) {
          if (s.includes("PING_HOP_CHAIN")) {
            if (s.includes("已达最大") || s.includes("跳数") || s.includes("MAX_BOT_HOPS") || s.includes("hop")) {
              hopBlocked = true;
              return { text: "检测到防环限制已停止转发" };
            }
            const target = sys.includes("数据分析师") ? "协作接力B" : "数据分析师";
            return {
              toolCalls: [{ id: `hop-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, name: "send_bot_message", args: { target_bot: target, message: "PING_HOP_CHAIN" } }],
            };
          }
          if (s.includes("群聊初始议题")) return { text: "收到群聊初始议题！" };
          return { text: "数据分析师回复：数据已核对无误！" };
        }

        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "cb-0", name: "list_bots", args: {} }] };
        }
        if (step === 2) {
          return {
            toolCalls: [{
              id: "cb-1",
              name: "create_bot",
              args: { name: "数据分析师", role_prompt: "专注数据核对", initial_message: "请帮我核对数据" },
            }],
          };
        }
        if (step === 3) {
          const found = ws.store.listSessions().find((x: any) => x.title === "数据分析师");
          createdBotId = found?.id || "";
          return {
            toolCalls: [{
              id: "cb-2",
              name: "create_bot",
              args: { name: "协作接力B", role_prompt: "接力测试" },
            }],
          };
        }
        if (step === 4) {
          return {
            toolCalls: [
              { id: "cb-self", name: "send_bot_message", args: { target_bot: "Twinkle", message: "self test" } },
              { id: "cb-hop", name: "send_bot_message", args: { target_bot: "数据分析师", message: "PING_HOP_CHAIN" } },
            ],
          };
        }
        if (step === 5) {
          if (s.includes("不能给自己发送") || s.includes("自身") || s.includes("self")) selfSendBlocked = true;
          return {
            toolCalls: [{
              id: "cb-grp",
              name: "create_bot_group",
              args: { title: "全栈协作群", member_bots: ["数据分析师", "协作接力B"], initial_message: "群聊初始议题" },
            }],
          };
        }
        if (step === 6) {
          const g = ws.store.listSessions().find((x: any) => x.title === "全栈协作群");
          createdGroupId = g?.id || "";
          return {
            toolCalls: [
              { id: "cb-bm1", name: "bot_manage", args: { action: "update_profile", target_bot: createdBotId || "数据分析师", name: "资深数据分析师" } },
              { id: "cb-bm2", name: "bot_manage", args: { action: "clone", target_bot: "协作接力B", name: "协作接力B克隆" } },
            ],
          };
        }
        if (step === 7 && createdGroupId) {
          return {
            toolCalls: [{
              id: "cb-bm3",
              name: "bot_manage",
              args: { action: "update_group_members", group: createdGroupId, add_bots: ["协作接力B克隆"] },
            }],
          };
        }
        return { text: "全套跨Bot协作工具链验证完成" };
      });

      await chrome!.typeText("#message-input", "创建数据分析师并完成全套跨Bot协作", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('全套跨Bot协作工具链验证完成'))`,
        15_000
      );
      ws.mockLlm.setHandler(undefined);

      assert.equal(selfSendBlocked, true, "send_bot_message to self must be blocked");
      assert.equal(hopBlocked, true, "MAX_BOT_HOPS=4 anti-loop guard must halt infinite relay");
      assert.ok(ws.store.listSessions().some((x: any) => x.title === "资深数据分析师"), "bot_manage update_profile must rename bot");
      assert.ok(ws.store.listSessions().some((x: any) => x.title === "协作接力B克隆"), "bot_manage clone must create clone");
      const grpAfter = ws.store.getSession(createdGroupId);
      assert.ok((grpAfter?.memberBotIds || []).length >= 3, "bot_manage update_group_members must add 3rd member");

      // Verify exchange pill, GET /api/exchanges/:id & #bot-exchange-sheet UI
      await chrome!.waitFor(`Boolean(document.querySelector('.bot-exchange-pill'))`, 8000);
      const exId = await chrome!.evalJs<string>(
        `document.querySelector('.bot-exchange-pill')?.getAttribute('data-exchange-id') || ''`
      );
      if (exId) {
        const exRes = await fetch(`${ws.baseUrl}/api/exchanges/${encodeURIComponent(exId)}`);
        assert.equal(exRes.status, 200);
      } else {
        assert.equal((await fetch(`${ws.baseUrl}/api/exchanges/nonexistent-ex`)).status, 404);
      }
      await chrome!.click(".bot-exchange-pill");
      await chrome!.waitFor(`!document.querySelector('#bot-exchange-sheet')?.hidden`, 6000);
      const sheetTxt = await chrome!.evalJs<string>(`document.querySelector('#exchange-messages-list')?.textContent || ''`);
      assert.match(sheetTxt, /请帮我核对数据|PING_HOP_CHAIN/);
      await chrome!.click("#close-exchange-sheet-btn");
      await chrome!.waitFor(`document.querySelector('#bot-exchange-sheet')?.hidden`);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-TOOL-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-TOOL-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "内置系统工具全覆盖：memory_manage / schedule_manage / vault_manage / workspace_search / library_manage / system_diagnostics / computer_provision / account_manage / skill_list / self_update / app_knowledge",
      module: "Built-in System Bot Tools",
    },
    async () => {
      const workerBot = ws.store.createSession({ title: "SystemToolsWorkerBot" });
      let step = 0;
      const toolResults: string[] = [];

      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "执行工具" };
        const msgs = body?.messages || [];
        const lastToolMsgs = msgs.filter((m: any) => m.role === "tool").map((m: any) => String(m.content || ""));
        if (lastToolMsgs.length > toolResults.length) {
          toolResults.push(...lastToolMsgs.slice(toolResults.length));
        }
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [
              { id: "st-1", name: "skill_list", args: {} },
              { id: "st-2", name: "memory_manage", args: { action: "save", scope: "bot", name: "工具测试记忆", content: "记住工具测试要点", trigger: "explicit" } },
              { id: "st-3", name: "vault_manage", args: { action: "save", category: "contact", title: "测试联系人", subtitle: "contact@test.local", notes: "重要伙伴" } },
            ],
          };
        }
        if (step === 2) {
          return {
            toolCalls: [
              { id: "st-4", name: "memory_manage", args: { action: "list" } },
              { id: "st-5", name: "vault_manage", args: { action: "list" } },
              { id: "st-6", name: "schedule_manage", args: { action: "create", title: "每日早报", prompt: "汇总早报", repeat: "daily", time: "09:00" } },
              { id: "st-7", name: "library_manage", args: { action: "save_note", title: "架构纪要", content: "LIBRARY_NOTE_BODY_OK" } },
            ],
          };
        }
        if (step === 3) {
          return {
            toolCalls: [
              { id: "st-8", name: "schedule_manage", args: { action: "list" } },
              { id: "st-9", name: "library_manage", args: { action: "list", filter: "all" } },
              { id: "st-10", name: "workspace_search", args: { action: "recent_messages", limit: 5 } },
              { id: "st-11", name: "workspace_search", args: { action: "search", query: "记住工具测试" } },
              { id: "st-12", name: "system_diagnostics", args: { action: "status" } },
              { id: "st-13", name: "computer_provision", args: { action: "probe" } },
              // Non-admin bot trying computer_provision(install), account_manage(upsert), or self_update(apply) must be denied cleanly!
              { id: "st-14", name: "computer_provision", args: { action: "install" } },
              { id: "st-15", name: "account_manage", args: { action: "list" } },
              { id: "st-16", name: "account_manage", args: { action: "upsert", name: "BlockedBotAdd", base_url: "https://blocked.example.com" } },
              { id: "st-17", name: "self_update", args: { action: "status" } },
              { id: "st-18", name: "self_update", args: { action: "apply" } },
              { id: "st-19", name: "app_knowledge", args: { action: "search", query: "外网中继" } },
              { id: "st-20", name: "run_subtask", args: { goal: "列出应用知识库主题清单", max_steps: 2 } },
            ],
          };
        }
        return { text: "全部 12 项系统级 Bot 工具实测完成" };
      });

      await fetch(`${ws.baseUrl}/api/sessions/${workerBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "请记住工具测试要点，并测试所有内置系统工具" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(workerBot.id), 12_000, "system tools turn finishes");
      ws.mockLlm.setHandler(undefined);

      const joined = toolResults.join("\n");
      assert.match(joined, /测试联系人/, "vault_manage must save & list items");
      assert.match(joined, /每日早报/, "schedule_manage must create & list schedules");
      assert.match(joined, /架构纪要|saved|path/i, "library_manage must save note & list library");
      assert.match(joined, /仅管理员|管理员|admin/i, "Non-admin computer_provision(install) / self_update(apply) must be denied");
      assert.match(joined, /"supportsCoreOta"|self_update|status/i, "self_update(status) must return runtime update capability");
      assert.match(joined, /ui-navigation-desktop|accounts-relay-and-updates/, "app_knowledge(search) must return matching self-knowledge topic IDs");
      assert.ok(ws.store.readSchedules().some((s: any) => s.title === "每日早报"));
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-PROMPT-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-PROMPT-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D1",
      title: "模块化 Markdown 系统提示词(PI-001/002/011/014)：5 份模板装配、UI 自认知、跨域 iframe 兜底与动态注入校验",
      module: "Modular Prompts & Prompt Loader",
    },
    async () => {
      const assembled = buildSystemInstruction({
        botIdentity: {
          name: "PromptAuditBot",
          schedules: [{ id: "s1", title: "晨报", repeat: "daily", scheduleLabel: "08:30", prompt: "生成晨报", enabled: true }],
        },
        enableBotTools: true,
        isAdminBot: true,
        sandboxMode: "full",
        hostExecutionMode: "always",
        kimiCuActive: true,
        vaultItems: [{ id: "v1", category: "credential", title: "CorpSSO", subtitle: "a@b.com", hasPassword: true }],
        mailAccounts: [{ id: "m1", email: "a@b.com", provider: "custom-mail", isDefault: true }],
      });
      // PI-001 app self-awareness (Bot's Computer panel, never raw VNC URL)
      assert.match(assembled, /Bot 的电脑|Bot's Computer/i, "Prompt must include app-capabilities.md self-awareness");
      // PI-002 cross-origin iframe OS-level fallback
      assert.match(assembled, /iframe|screenshot|type_text/i, "Prompt must include web-grounding.md cross-origin fallback");
      // PI-011 dual-computer semantics
      assert.match(assembled, /Bot's Computer|Your Computer|宿主机|沙盒/i, "Prompt must include dual-computer.md rules");
      // Dynamic injections
      assert.match(assembled, /CorpSSO/, "Prompt must inject vault item summary");
      assert.match(assembled, /晨报/, "Prompt must inject active schedules");
      assert.match(assembled, /a@b\.com/, "Prompt must inject configured mail accounts");
      assert.match(assembled, /KimiCU|kimi_cu/i, "Prompt must inject KimiCU active section");
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
      await ensureAtWorkspace();
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

      // Multi-step choice card (3 questions: Q1 single, Q2 REAL multi_select=true, Q3 custom input!)
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
                    { question: "选择启用能力(多选)", options: ["邮件", "沙盒", "定时任务"], multi_select: true },
                    { question: "填写自定义备注", options: ["默认", "跳过"], allow_custom: true },
                  ],
                },
              },
            ],
          };
        }
        capturedAnswer = s;
        return { text: "多步单选多选自定义已全部收到" };
      });

      await chrome!.typeText("#message-input", "发起三步单选多选提问卡", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.choice-stepper-pill'))`, 8000);
      assert.match(
        await chrome!.evalJs<string>(`document.querySelector('.choice-stepper-pill')?.textContent || ''`),
        /1\s*\/\s*3/
      );
      // Answer Q1 (single) -> advances to 2 / 3 (multi_select!)
      await chrome!.click(`.choice-card:not(.is-resolved) [data-choice-index="1"]`);
      await chrome!.waitFor(`document.querySelector('.choice-stepper-pill')?.textContent?.includes('2')`);
      await chrome!.click(`.choice-card:not(.is-resolved) [data-choice-index="0"]`);
      await chrome!.click(`.choice-card:not(.is-resolved) [data-choice-index="2"]`);
      await chrome!.waitFor(`document.querySelectorAll('.choice-card:not(.is-resolved) .is-checked').length === 2`, 4000);
      await chrome!.click(`.choice-card:not(.is-resolved) .choice-multi-footer .settings-blue-pill`);
      await chrome!.waitFor(`document.querySelector('.choice-stepper-pill')?.textContent?.includes('3')`, 4000);
      // Answer Q3 via custom input
      await chrome!.click(".choice-custom-trigger");
      await chrome!.waitFor(`Boolean(document.querySelector('.choice-custom-input'))`);
      await chrome!.fill(".choice-custom-input", "自定义灰度发布");
      await chrome!.click(".choice-custom-submit");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('多步单选多选自定义已全部收到'))`,
        8000
      );
      assert.match(capturedAnswer, /云端/);
      assert.match(capturedAnswer, /邮件/);
      assert.match(capturedAnswer, /定时任务/);
      assert.match(capturedAnswer, /自定义灰度发布/);

      // Direct POST /api/choices/:id missing selected payload must return 400
      const missingChoice = await fetch(`${ws.baseUrl}/api/choices/nonexistent-choice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(missingChoice.status, 400);

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
      await ensureAtWorkspace();
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

      // 1b. DraftCard CANCEL (.btn-deny "取消草稿") + collapsed cancel receipt!
      step = 0;
      let cancelResult = "";
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "等待确认草稿" };
        const s = JSON.stringify(body?.messages || "");
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{ id: "dr-cancel", name: "propose_draft", args: { title: "待取消草稿", recipient: "x@test.com", content: "测试取消", kind: "email" } }],
          };
        }
        cancelResult = s;
        return { text: "已收到用户取消草稿指令" };
      });
      await chrome!.typeText("#message-input", "起草一份待取消的草稿", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.draft-card:not(.is-collapsed) .btn-deny'))`, 8000);
      await chrome!.click(".draft-card:not(.is-collapsed) .btn-deny");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('已收到用户取消草稿指令'))`,
        8000
      );
      assert.match(cancelResult, /cancel|取消|false|rejected/i);

      // 2. ApprovalCard inline custom rule editor
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy: {
            autoAudit: true,
            askRules: [{ id: "e2e-inline-edit", tool: "browser_click", pattern: "", label: "e2e inline edit" }],
            allowRules: [],
          },
        }),
      });
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
            toolCalls: [{ id: "er-1", name: "browser_click", args: { ref: "e9", risk: "high" } }],
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
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: { autoAudit: true, askRules: [], allowRules: [] } }),
      }).catch(() => {});
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

      // Also verify hover Copy action button & POST /api/sessions/:id/edit-message 400 validation
      await chrome!.click(`.msg-group.is-bot .msg-action-icon[title="复制文本"]`).catch(() => {});
      const badEdit = await fetch(`${ws.baseUrl}/api/sessions/${editBot.id}/edit-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq: 99999, text: "" }),
      });
      assert.equal(badEdit.status, 400);
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
      title: "消息悬停「回复此消息」锚点定位闪烁 + 正文划词浮窗(#selection-quote-toolbar)复制与多条引用筹码",
      module: "Reply Anchor & Selection Quote",
    },
    async () => {
      await ensureAtWorkspace();
      // Ensure at least one bot message exists if run standalone via --case=P1-MSG-02
      const hasBotBubble = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('.msg-group.is-bot .bot-bubble'))`);
      if (!hasBotBubble) {
        ws.mockLlm.setHandler(async () => ({ text: "第一段引用样本内容用于多条划词测试" }));
        await chrome!.typeText("#message-input", "生成一段文本用于引用", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(`Boolean(document.querySelector('.msg-group.is-bot .bot-bubble'))`, 8000);
        ws.mockLlm.setHandler(undefined);
      }

      // Reply to existing bot message -> test #reply-quote-clear then re-attach reply
      await chrome!.click(`.msg-group.is-bot .msg-action-icon[title="回复此消息"]`);
      await chrome!.waitFor(`!document.querySelector('#reply-quote-bar')?.hidden`);
      await chrome!.click("#reply-quote-clear");
      await chrome!.waitFor(`document.querySelector('#reply-quote-bar')?.hidden`);
      await chrome!.click(`.msg-group.is-bot .msg-action-icon[title="回复此消息"]`);
      await chrome!.waitFor(`!document.querySelector('#reply-quote-bar')?.hidden`);

      // Select TWO distinct text spans inside bot bubble -> stage >= 2 quote chips!
      await chrome!.selectText(".msg-group.is-bot .bot-bubble", 0, 4);
      await chrome!.waitFor(`!document.querySelector('#selection-quote-toolbar')?.hidden`, 6000);
      await chrome!.click("#selection-quote-btn");
      await chrome!.waitFor(`document.querySelectorAll('#composer-quotes-bar .quote-staging-chip').length >= 1`);

      await chrome!.selectText(".msg-group.is-bot .bot-bubble", 4, 8);
      await chrome!.waitFor(`!document.querySelector('#selection-quote-toolbar')?.hidden`, 6000);
      await chrome!.click("#selection-quote-btn");
      await chrome!.waitFor(`document.querySelectorAll('#composer-quotes-bar .quote-staging-chip').length >= 2`, 4000);

      // Remove 1 chip -> leaves 1 chip
      await chrome!.click("#composer-quotes-bar .quote-staging-chip button");
      await chrome!.waitFor(`document.querySelectorAll('#composer-quotes-bar .quote-staging-chip').length === 1`, 4000);

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
      const missingPath = path.join(ws.workspaceDir, "nonexistent.pdf");
      const missingRes: any = await (
        await fetch(`${ws.baseUrl}/api/files/meta?path=${encodeURIComponent(missingPath)}`)
      ).json();
      assert.equal(missingRes.exists, false);

      // Verify actual download Content-Disposition + POST /api/files/open 403/404 security boundaries!
      const dlRes = await fetch(
        `${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(delivFile)}&download=1&name=demo.txt`
      );
      assert.equal(dlRes.status, 200);
      assert.match(dlRes.headers.get("content-disposition") || "", /attachment/i);

      const openSensitive = await fetch(`${ws.baseUrl}/api/files/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(ws.workspaceDir, ".env") }),
      });
      assert.equal(openSensitive.status, 403, "POST /api/files/open must block sensitive .env with 403");
      const openMissing = await fetch(`${ws.baseUrl}/api/files/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: missingPath }),
      });
      assert.equal(openMissing.status, 404, "POST /api/files/open must return 404 for nonexistent file");

      // Delete BOTH the original deliverable file and any staged copy inside Bot workspace & reload to verify FileAttachmentCard renders disabled state (.msg-file-btn.is-disabled)!
      const stagedPath = await chrome!.evalJs<string>(
        `(() => {
          const btn = document.querySelector('.msg-file-card .msg-file-btn');
          const href = btn?.getAttribute('href') || '';
          try { return new URL(href, location.origin).searchParams.get('path') || ''; } catch { return ''; }
        })()`
      );
      if (fs.existsSync(delivFile)) fs.unlinkSync(delivFile);
      if (stagedPath && fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
      await chrome!.reload(true);
      await chrome!.waitFor(`Boolean(document.querySelector('.msg-file-card .msg-file-btn.is-disabled'))`, 8000);
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

      // Verify OPTIONS CORS preflight 204, malformed URI 400, and GET /api/screens/:id/:file 200 PNG serving!
      const corsRes = await fetch(`${ws.baseUrl}/api/sessions`, {
        method: "OPTIONS",
        headers: { Origin: "http://127.0.0.1:9999" },
      });
      assert.equal(corsRes.status, 204);
      assert.ok(corsRes.headers.get("access-control-allow-origin"));

      const badUri = await fetch(`${ws.baseUrl}/api/sessions/%E0%A4%A`);
      assert.equal(badUri.status, 400);

      const scrSession = ws.store.createSession({ title: "ScreenServeBot" });
      const savedFile = ws.store.saveScreenshot(scrSession.id, 1, SAMPLE_PNG_BUFFER);
      const scrRes = await fetch(`${ws.baseUrl}/api/screens/${scrSession.id}/${encodeURIComponent(savedFile)}`);
      assert.equal(scrRes.status, 200);
      assert.match(scrRes.headers.get("content-type") || "", /image\/png/);
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
      title: "右侧人设保存、Bot 专属记忆 UI 启停开关注入/剥离 Prompt、例行定时任务 UI 弹窗 CRUD 与到期自动唤醒执行",
      module: "RightInspector / Memories / Scheduler",
    },
    async () => {
      await ensureAtWorkspace();
      ws.store.ensureAdminBot();
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
      const userReqJson = JSON.stringify(
        ws.mockLlm.capturedRequests.find((r) =>
          String(r.body?.messages?.[0]?.content || "").includes("MARKER_99")
        )?.body?.messages || []
      );
      assert.match(
        userReqJson,
        /\[发送时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\]/,
        "Issue #24: LLM request must receive hidden [发送时间：YYYY-MM-DD HH:mm:ss ±HH:MM] header"
      );
      const visibleUserBubblesText = await chrome!.evalJs(
        `Array.from(document.querySelectorAll('.user-bubble')).map(el => el.textContent || '').join(' ')`
      );
      assert.ok(
        !String(visibleUserBubblesText || "").includes("[发送时间："),
        "Issue #24: Visible user chat bubble must NOT expose raw [发送时间：…] header"
      );
      const sysPrompt = String(
        ws.mockLlm.capturedRequests.find((r) => String(r.body?.messages?.[0]?.content || "").includes("MARKER_99"))?.body
          ?.messages?.[0]?.content || ""
      );
      assert.match(sysPrompt, /MARKER_99/, "Persona must be injected into system prompt");
      assert.match(sysPrompt, /MEM_TAG_ALPHA/, "Enabled bot memory must be injected into system prompt");

      // Toggle Bot memory switch OFF via RightInspector UI -> verify MEM_TAG_ALPHA is NO LONGER injected!
      await chrome!.click("#bot-memories-list .ios-switch input");
      await ws.waitUntil(() => ws.store.getSession(inspBot.id)?.memories?.[0]?.enabled === false, 5000, "bot memory toggled off");
      ws.mockLlm.clearRequests();
      await chrome!.typeText("#message-input", "再次检查停用记忆后的提示词", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`document.querySelectorAll('.bot-bubble').length >= 2`, 8000);
      const sysAfterOff = String(
        ws.mockLlm.capturedRequests.find((r) => String(r.body?.messages?.[0]?.content || "").includes("MARKER_99"))?.body
          ?.messages?.[0]?.content || ""
      );
      assert.ok(!sysAfterOff.includes("MEM_TAG_ALPHA"), "Disabled bot memory must NOT be injected into prompt");

      // Create & toggle & delete a daily schedule via RightInspector #new-schedule-btn -> #schedule-modal-backdrop UI!
      await chrome!.click("#new-schedule-btn");
      await chrome!.waitFor(`!document.querySelector('#schedule-modal-backdrop')?.hidden`, 4000);
      await chrome!.fill("#sched-title-input", "UI创建每日任务");
      await chrome!.fill("#sched-prompt-input", "发送日报提醒");
      await chrome!.selectOption("#sched-repeat-select", "daily");
      await chrome!.fill("#sched-label-input", "09:30");
      await chrome!.click("#save-sched-modal-btn");
      await chrome!.waitFor(`document.querySelector('#schedule-modal-backdrop')?.hidden`, 5000);
      await chrome!.waitFor(`document.querySelector('#upcoming-schedules-list')?.textContent?.includes('UI创建每日任务')`, 5000);

      // Verify GET /api/schedules, PATCH /api/schedules/:id, DELETE /api/schedules/:id
      const listSch: any = await (await fetch(`${ws.baseUrl}/api/schedules`)).json();
      const uiSch = (listSch.schedules || listSch || []).find((x: any) => x.title === "UI创建每日任务");
      assert.ok(uiSch?.id);
      assert.equal(
        (await fetch(`${ws.baseUrl}/api/schedules/${uiSch.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })).status,
        200
      );
      assert.equal((await fetch(`${ws.baseUrl}/api/schedules/${uiSch.id}`, { method: "DELETE" })).status, 200);

      // Verify schedule-cron-v1 capability + Cron UI validation/live preview + API 400 guard
      const cronDiag: any = await (await fetch(`${ws.baseUrl}/api/system/diagnostics`)).json();
      assert.ok(
        Array.isArray(cronDiag.apiCapabilities) &&
          cronDiag.apiCapabilities.includes("schedule-cron-v1"),
        "Diagnostics must advertise schedule-cron-v1 capability"
      );

      const badCronPost = await fetch(`${ws.baseUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: inspBot.id,
          title: "非法Cron",
          prompt: "noop",
          repeat: "cron",
          cron: "bad-cron",
        }),
      });
      assert.equal(badCronPost.status, 400);

      await chrome!.click("#new-schedule-btn");
      await chrome!.waitFor(`!document.querySelector('#schedule-modal-backdrop')?.hidden`, 4000);
      await chrome!.fill("#sched-title-input", "Cron每3天任务");
      await chrome!.fill("#sched-prompt-input", "每3天执行检查");
      await chrome!.selectOption("#sched-repeat-select", "cron");
      await chrome!.waitFor(`Boolean(document.querySelector('#sched-cron-input'))`, 4000);
      await chrome!.fill("#sched-cron-input", "99 * * *");
      await chrome!.click("#save-sched-modal-btn");
      await chrome!.waitFor(
        `!document.querySelector('#sched-cron-error')?.hidden &&
         document.querySelector('#sched-cron-input')?.getAttribute('aria-invalid') === 'true' &&
         !document.querySelector('#schedule-modal-backdrop')?.hidden`,
        4000
      );
      await chrome!.fill("#sched-cron-input", "0 10 */3 * *");
      await chrome!.waitFor(
        `document.querySelector('#sched-cron-preview')?.textContent?.includes('每 3 天 10:00') &&
         document.querySelector('#sched-cron-preview')?.textContent?.includes('下次执行：')`,
        4000
      );
      await chrome!.click("#save-sched-modal-btn");
      await chrome!.waitFor(`document.querySelector('#schedule-modal-backdrop')?.hidden`, 5000);
      await chrome!.waitFor(
        `document.querySelector('#upcoming-schedules-list')?.textContent?.includes('0 10 */3 * *')`,
        5000
      );
      const listAfterCron: any = await (await fetch(`${ws.baseUrl}/api/schedules`)).json();
      const cronUiItem = (listAfterCron.schedules || []).find((x: any) => x.title === "Cron每3天任务");
      assert.equal(cronUiItem?.repeat, "cron");
      assert.equal(cronUiItem?.cron, "0 10 */3 * *");
      assert.equal((await fetch(`${ws.baseUrl}/api/schedules/${cronUiItem.id}`, { method: "DELETE" })).status, 200);

      // Verify schedule-optimizer-v1 capability + /api/schedules/:id/optimize & apply-optimization (Phase H4-B)
      const diagH4 = await (await fetch(`${ws.baseUrl}/api/system/diagnostics`)).json() as any;
      assert.ok(
        Array.isArray(diagH4?.apiCapabilities) &&
          diagH4.apiCapabilities.includes("schedule-optimizer-v1"),
        "Diagnostics must advertise schedule-optimizer-v1 capability"
      );
      const optTargetRes = await fetch(`${ws.baseUrl}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: inspBot.id,
          title: "优化测试巡检",
          prompt: "检查服务状态",
          repeat: "daily",
          time: "08:00",
        }),
      });
      assert.equal(optTargetRes.status, 201);
      const optTarget: any = await optTargetRes.json();
      ws.mockLlm.setHandler(async () => ({ text: '{"decision":"KEEP_BASE","reason":"already concise"}' }));
      const optRunRes = await fetch(`${ws.baseUrl}/api/schedules/${optTarget.id}/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(optRunRes.status, 200);
      ws.mockLlm.setHandler(undefined);
      const optApplyRes = await fetch(`${ws.baseUrl}/api/schedules/${optTarget.id}/apply-optimization`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimizedPrompt: "每日检查服务健康状态并输出结构化摘要" }),
      });
      assert.equal(optApplyRes.status, 200);
      assert.equal((await fetch(`${ws.baseUrl}/api/schedules/${optTarget.id}`, { method: "DELETE" })).status, 200);

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

      // Issue #23: Desktop RightInspector collapsible sections (count >= 2 defaults collapsed, < 2 expanded)
      assert.equal(
        await chrome!.evalJs(`document.querySelector('#bot-memory-toggle-btn')?.getAttribute('aria-expanded')`),
        "true",
        "1 memory (< 2) should be expanded"
      );
      // Add a 2nd memory and create 2 schedules for inspBot, plus a group with 2 members, then switch session & back
      await chrome!.click("#new-bot-memory-btn");
      await chrome!.waitFor(`!document.querySelector('#bot-memory-modal-backdrop')?.hidden`, 4000);
      await chrome!.fill("#bot-memory-modal-name-input", "设计原则");
      await chrome!.fill("#bot-memory-modal-content-input", "保持界面简洁");
      await chrome!.click("#save-bot-memory-modal-btn");
      await chrome!.waitFor(`document.querySelector('#bot-memory-modal-backdrop')?.hidden`, 4000);

      for (const title of ["巡检A", "巡检B"]) {
        const resSch = await fetch(`${ws.baseUrl}/api/schedules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: inspBot.id,
            title,
            prompt: "noop",
            repeat: "daily",
            timeLabel: "10:00",
            enabled: true,
          }),
        });
        assert.equal(resSch.status, 201);
      }

      const otherBot = ws.store.createSession({ title: "SwitchTargetBot" });
      ws.store.createSession({
        type: "group",
        title: "CollapseGroup",
        memberBotIds: [inspBot.id, otherBot.id],
      });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('InspSchedBot')) &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('CollapseGroup'))`,
        6000
      );

      // Select InspSchedBot -> both #bot-memory-section (2 memories >= 2) and #upcoming-section (>= 2 schedules) default collapsed
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('InspSchedBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('InspSchedBot')`, 4000);
      await chrome!.waitFor(
        `document.querySelector('#bot-memory-toggle-btn')?.getAttribute('aria-expanded') === 'false' &&
         document.querySelector('#bot-memory-body')?.hidden === true &&
         document.querySelector('#upcoming-toggle-btn')?.getAttribute('aria-expanded') === 'false' &&
         document.querySelector('#upcoming-body')?.hidden === true &&
         !document.querySelector('#new-bot-memory-btn')?.hidden &&
         !document.querySelector('#new-schedule-btn')?.hidden`,
        5000
      );

      // Manual toggle expands & persists within same session
      await chrome!.click("#bot-memory-toggle-btn");
      await chrome!.click("#upcoming-toggle-btn");
      await chrome!.waitFor(
        `document.querySelector('#bot-memory-toggle-btn')?.getAttribute('aria-expanded') === 'true' &&
         document.querySelector('#bot-memory-body')?.hidden === false &&
         document.querySelector('#upcoming-toggle-btn')?.getAttribute('aria-expanded') === 'true' &&
         document.querySelector('#upcoming-body')?.hidden === false`,
        4000
      );

      // Switch to CollapseGroup -> #group-members-section (2 members >= 2) defaults collapsed & manual toggle expands
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('CollapseGroup'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('CollapseGroup')`, 4000);
      await chrome!.waitFor(
        `document.querySelector('#group-members-toggle-btn')?.getAttribute('aria-expanded') === 'false' &&
         document.querySelector('#group-members-body')?.hidden === true`,
        4000
      );
      await chrome!.click("#group-members-toggle-btn");
      await chrome!.waitFor(
        `document.querySelector('#group-members-toggle-btn')?.getAttribute('aria-expanded') === 'true' &&
         document.querySelector('#group-members-body')?.hidden === false`,
        4000
      );

      // Switching back to InspSchedBot resets per-session overrides back to default collapsed
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('InspSchedBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(
        `document.querySelector('#bot-memory-toggle-btn')?.getAttribute('aria-expanded') === 'false' &&
         document.querySelector('#bot-memory-body')?.hidden === true`,
        4000
      );

      ws.mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );
});
