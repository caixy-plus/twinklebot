import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalCrypto, isEncryptedEnvelope } from "../../src/lib/local-crypto.js";
import { createStore } from "../../src/store/index.js";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { startMockLlmServer } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P0 Suite 1: Onboarding, Gemini Interactions, Streaming Chat, Steering, Stop, MaxSteps, F5 & Local Crypto", async (t) => {
  const collector = createSuiteCollector("p0-onboarding-and-chat");
  const mockLlm = await startMockLlmServer();
  t.after(() => mockLlm.close());

  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  // Start with NO seeded provider so P0-ONB-01 & P0-ONB-02 test true first-run onboarding
  const ws = await createE2EWorkspace({
    seedDefaultProvider: false,
    mockLlm,
    smartRouter: true,
  });
  t.after(() => ws.close());

  const ensureProviderReady = async () => {
    const s = ws.store.readSettings();
    if (!s.onboardingCompleted || !Array.isArray(s.providers) || s.providers.length === 0) {
      ws.store.writeSettings({
        onboardingCompleted: true,
        routing: {
          smartRouter: true,
          mode: "balanced",
          tiers: {
            fast: { providerId: "openai-compatible-primary", model: "e2e-fast" },
            medium: { providerId: "openai-compatible-primary", model: "e2e-medium" },
            advanced: { providerId: "openai-compatible-primary", model: "e2e-advanced" },
          },
        },
        providers: [
          {
            id: "openai-compatible-primary",
            type: "openai-compatible",
            name: "E2E OpenAI Compat",
            apiKey: "sk-e2e-secret-987654",
            baseUrl: mockLlm.openaiBaseUrl,
            models: ["e2e-fast", "e2e-medium", "e2e-advanced"],
            imageModels: [],
            billingCurrency: "USD",
            enabled: true,
          },
        ],
      });
    }
    const url = await chrome!.evalJs<string>(`window.location.href`).catch(() => "");
    if (!url.startsWith(ws.baseUrl)) {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 10_000);
    }
  };

  // ---------- P0-ONB-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-ONB-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "空工作台自动初始化唯一置顶管理员 Bot Twinkle 并弹出首屏引导遮罩",
      module: "Onboarding / Session Bootstrap",
    },
    async ({ setEvidence }) => {
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`!document.querySelector('#onboarding-overlay')?.hidden`);
      await chrome!.waitFor(`Boolean(document.querySelector('#pinned-primary-bot'))`);

      const sessions = ws.store.listSessions();
      const admins = sessions.filter((s: any) => s.isAdmin === true);
      setEvidence("sessionsCount", sessions.length);
      assert.equal(admins.length, 1, "Must initialize exactly one isAdmin bot");
      assert.equal(admins[0].pinned, true, "Admin bot must be pinned");
      const rawFiles = fs.readdirSync(path.join(ws.dataDir, "sessions")).filter((f) => f.endsWith(".json") && !f.endsWith(".history.json"));
      assert.ok(rawFiles.length >= 1, "Admin session JSON must be persisted to disk");
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-ONB-02 ----------
  await collector.runCase(
    t,
    {
      id: "P0-ONB-02",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "引导页 4 类供应商预设切换、去重联动 3 档、测速(败/胜)与提交脱敏落盘",
      module: "Onboarding / Providers",
    },
    async ({ setEvidence }) => {
      // Switch through presets and verify hint + fields update (scoped to #onboarding-overlay!)
      for (const preset of ["gemini", "openai", "deepseek", "openai-compatible"]) {
        await chrome!.click(`#onboarding-overlay [data-provider-preset="${preset}"]`);
        await chrome!.waitFor(
          `document.querySelector('#onboarding-overlay [data-provider-preset="${preset}"]')?.classList.contains('is-active')`
        );
      }

      // Configure openai-compatible pointing to local mockLlm
      await chrome!.fill("#onboarding-provider-name", "E2E OpenAI Compat");
      await chrome!.fill("#onboarding-base-url", mockLlm.openaiBaseUrl);
      await chrome!.fill("#onboarding-api-key", "sk-e2e-secret-987654");
      await chrome!.fill("#onboarding-models-input", "e2e-fast, e2e-medium, e2e-fast, e2e-advanced");

      // Verify deduplicated models populate all 3 tier selects & tier selection works
      const tierOpts = await chrome!.evalJs<string[]>(
        `Array.from(document.querySelectorAll('#onboarding-tier-fast option')).map(o => o.value)`
      );
      assert.deepEqual(tierOpts, ["e2e-fast", "e2e-medium", "e2e-advanced"]);
      await chrome!.selectOption("#onboarding-tier-fast", "e2e-fast");
      await chrome!.selectOption("#onboarding-tier-medium", "e2e-medium");
      await chrome!.selectOption("#onboarding-tier-advanced", "e2e-advanced");

      // Empty models validation on /api/onboarding/complete & /api/config contract
      const badOnb = await fetch(`${ws.baseUrl}/api/onboarding/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: { type: "openai-compatible", apiKey: "", baseUrl: "" } }),
      });
      assert.equal(badOnb.status, 400, "Incomplete onboarding payload must return 400");
      const cfgRes: any = await (await fetch(`${ws.baseUrl}/api/config`)).json();
      assert.ok(cfgRes && Array.isArray(cfgRes.models) && cfgRes.autoRouter === true, "GET /api/config must return runtime config");

      // Test connection failure first
      mockLlm.enqueue({ status: 401, text: "bad mock key" });
      await chrome!.click("#onboarding-test-btn");
      await chrome!.waitFor(
        `document.querySelector('#onboarding-feedback')?.classList.contains('is-error')`
      );

      // Test connection success (returns ms latency)
      mockLlm.enqueue({ text: "OK" });
      await chrome!.click("#onboarding-test-btn");
      await chrome!.waitFor(
        `document.querySelector('#onboarding-feedback')?.classList.contains('is-ok') &&
         /ms/.test(document.querySelector('#onboarding-feedback')?.textContent || '')`
      );

      // Submit onboarding
      await chrome!.click("#onboarding-submit-btn");
      await chrome!.waitFor(`document.querySelector('#onboarding-overlay')?.hidden`);

      const settingsOnDisk = ws.store.readSettings();
      assert.equal(settingsOnDisk.onboardingCompleted, true);
      assert.equal(settingsOnDisk.providers.length, 1);
      assert.equal(settingsOnDisk.providers[0].id, "openai-compatible-primary");

      const provListRes: any = await (await fetch(`${ws.baseUrl}/api/providers`)).json();
      assert.equal(provListRes.onboardingRequired, false);
      assert.ok(Array.isArray(provListRes.providers) && provListRes.providers.length === 1);
      const apiSettings: any = await (await fetch(`${ws.baseUrl}/api/settings`)).json();
      const rawJsonStr = JSON.stringify(apiSettings);
      assert.ok(!rawJsonStr.includes("sk-e2e-secret-987654"), "Raw API key must never be returned to client");
      setEvidence("maskedApiKey", apiSettings.providers?.[0]?.maskedApiKey);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-GEM-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-GEM-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "原生 Gemini Interactions API 驱动链路：thought_tokens 计费与 invalid thought signature 自动剥离重试",
      module: "Gemini Driver",
    },
    async ({ setEvidence }) => {
      await ensureProviderReady();
      // Add a Gemini provider pointing baseUrl to mockLlm and run a session turn
      const gemProvider = {
        id: "gemini-e2e",
        type: "gemini",
        name: "Gemini Mock",
        apiKey: "gem-e2e-key-1234",
        baseUrl: mockLlm.baseUrl,
        models: ["gemini-4-hydrogen", "gemini-4-argon", "gemini-4-carbon"],
        imageModels: ["gemini-3.1-flash-image"],
        billingCurrency: "USD",
        enabled: true,
      };
      const addRes = await fetch(`${ws.baseUrl}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gemProvider),
      });
      assert.equal(addRes.status, 200);
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routing: {
            smartRouter: false,
            tiers: {
              fast: { providerId: "gemini-e2e", model: "gemini-4-hydrogen" },
              medium: { providerId: "gemini-e2e", model: "gemini-4-argon" },
              advanced: { providerId: "gemini-e2e", model: "gemini-4-carbon" },
            },
          },
        }),
      });

      const gemSession = ws.store.createSession({ title: "GeminiVerify" });
      ws.store.saveHistory(gemSession.id, [
        { type: "user_input", content: [{ type: "text", text: "prior" }] },
        { type: "thought", text: "old thought", signature: "stale-bad-sig" },
        { type: "model_output", content: [{ type: "text", text: "prior ans" }] },
      ]);

      mockLlm.clearRequests();
      // First attempt WITH stale-bad-sig rejects with invalid thought signature; stripped retry succeeds with thought tokens
      let gemStepRejectOnce = true;
      mockLlm.setHandler(async ({ body }) => {
        const inpStr = JSON.stringify(body?.input || "");
        if (
          inpStr.includes("Distill the current task progress") ||
          inpStr.includes("ultra-short Chinese phrase") ||
          inpStr.includes("提炼成极简中文短语")
        ) {
          return { geminiOutputs: [{ type: "text", text: "测试驱动" }] };
        }
        if (gemStepRejectOnce && inpStr.includes("stale-bad-sig")) {
          gemStepRejectOnce = false;
          return { status: 400, text: "Invalid thought signature in input" };
        }
        return {
          geminiOutputs: [{ type: "text", text: "Gemini 剥离签名恢复成功" }],
          geminiUsage: { total_input_tokens: 210, total_output_tokens: 45, total_thought_tokens: 18 },
        };
      });

      try {
        const msgRes = await fetch(`${ws.baseUrl}/api/sessions/${gemSession.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "测试 Gemini 驱动" }),
        });
        assert.equal(msgRes.status, 202);
        await ws.waitUntil(() => !ws.runner.isSessionBusy(gemSession.id), 8000, "Gemini turn completes");
        mockLlm.setHandler(undefined);

        const intReqs = mockLlm.capturedRequests.filter((r) => {
          const s = JSON.stringify(r.body?.input || "");
          return (
            r.url.includes("/v1beta/interactions") &&
            !s.includes("Distill the current task progress") &&
            !s.includes("ultra-short Chinese phrase") &&
            !s.includes("提炼成极简中文短语")
          );
        });
        setEvidence("interactionsRequests", intReqs.length);
        assert.equal(intReqs.length, 2, "Must retry once after stripping thought signature");
        assert.ok(
          JSON.stringify(intReqs[0].body.input).includes("stale-bad-sig"),
          "First attempt should send prior signed thought"
        );
        assert.ok(
          !JSON.stringify(intReqs[1].body.input).includes("stale-bad-sig"),
          "Retry payload must strip invalid thought signature"
        );

        const events = ws.store.readEvents(gemSession.id);
        const hasThoughtUsage = events.some((e: any) => e.type === "usage" && e.thoughts === 18);
        assert.equal(hasThoughtUsage, true, "Gemini usage event must record total_thought_tokens = 18");
        const ansEv = events.find((e: any) => e.type === "answer");
        assert.match(ansEv?.text || "", /Gemini 剥离签名恢复成功/);
      } finally {
        mockLlm.setHandler(undefined);
        // Always restore OpenAI-compatible provider as active default for remaining UI cases
        await fetch(`${ws.baseUrl}/api/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routing: {
              smartRouter: true,
              tiers: {
                fast: { providerId: "openai-compatible-primary", model: "e2e-fast" },
                medium: { providerId: "openai-compatible-primary", model: "e2e-medium" },
                advanced: { providerId: "openai-compatible-primary", model: "e2e-advanced" },
              },
            },
          }),
        });
      }
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-CHAT-01 ----------
  let chatSessionId = "";
  await collector.runCase(
    t,
    {
      id: "P0-CHAT-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "单聊收发(Enter 发送 / Shift+Enter 换行)、自动改名、流式多气泡与状态徽章流转",
      module: "Chat / Composer",
    },
    async () => {
      await ensureProviderReady();
      const created = ws.store.createSession({ title: "New Session" });
      chatSessionId = created.id;
      await chrome!.reload(true);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(el => el.textContent?.includes('新 Bot'))`
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('新 Bot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(
        `document.querySelector('#session-list .session-item.is-active')?.textContent?.includes('新 Bot') &&
         document.querySelector('#header-bot-name')?.textContent?.trim() === '新 Bot'`
      );

      // Test Shift+Enter inserts newline without sending
      await chrome!.typeText("#message-input", "第一行问题", { clear: true });
      await chrome!.pressKey("Enter", { shift: true });
      await chrome!.typeText("#message-input", "第二行补充");
      const valBeforeSend = await chrome!.evalJs<string>(`document.querySelector('#message-input')?.value`);
      assert.ok(valBeforeSend.includes("\n"), "Shift+Enter must insert newline instead of sending");

      mockLlm.setHandler(async ({ body }) => {
        const sys = JSON.stringify(body?.messages || "");
        if (
          sys.includes("ultra-short Chinese phrase") ||
          sys.includes("Distill the current task progress") ||
          sys.includes("只输出") ||
          sys.includes("短语")
        ) {
          return { text: "正在整理要点" };
        }
        return {
          streamChunks: [
            "第一段说明内容。\n\n",
            "```ts\nconst ok = true;\n```\n\n",
            "第三段总结完毕。",
          ],
          delayMs: 80,
        };
      });

      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `document.querySelector('#header-bot-name')?.textContent?.includes('第一行问题')`,
        8000
      );
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('第三段总结完毕'))`,
        10_000
      );
      mockLlm.setHandler(undefined);

      const bubbleCount = await chrome!.evalJs<number>(`document.querySelectorAll('.bot-bubble').length`);
      assert.ok(bubbleCount >= 2, `Expected multi-bubble split, got ${bubbleCount}`);
      const codeBlocks = await chrome!.evalJs<number>(`document.querySelectorAll('.msg-code-block').length`);
      assert.equal(codeBlocks, 1, "Code block must remain intact inside bubble");

      // Check NDJSON seq monotonicity and history persistence
      const events = ws.store.readEvents(chatSessionId);
      for (let i = 1; i < events.length; i++) {
        assert.ok(events[i].seq > events[i - 1].seq, "NDJSON seq must strictly increase");
      }
      const hist = ws.store.loadHistory(chatSessionId);
      assert.ok(hist.length >= 2, "History JSON must persist turns");

      // Also verify #send-btn click sends message & /api/sessions/:id/library responds 200
      mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "发送按钮" };
        return { text: "按钮点击发送成功" };
      });
      await chrome!.typeText("#message-input", "用发送按钮发送", { clear: true });
      await chrome!.click("#send-btn");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('按钮点击发送成功'))`,
        8000
      );
      mockLlm.setHandler(undefined);
      const libRes = await fetch(`${ws.baseUrl}/api/sessions/${chatSessionId}/library`);
      assert.equal(libRes.status, 200);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-CHAT-02 ----------
  await collector.runCase(
    t,
    {
      id: "P0-CHAT-02",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "运行中呼吸工作条浓缩思考摘要(<=9字)及脏工具路径泄漏拦截",
      module: "Thinking Summarizer",
    },
    async () => {
      await ensureProviderReady();
      let releaseTurn!: () => void;
      const gate = new Promise<void>((r) => {
        releaseTurn = r;
      });
      mockLlm.setHandler(async ({ body }) => {
        const mStr = JSON.stringify(body?.messages || "");
        if (
          mStr.includes("ultra-short Chinese phrase") ||
          mStr.includes("Distill the current task progress") ||
          mStr.includes("思考") ||
          mStr.includes("短语") ||
          mStr.includes("概括")
        ) {
          // Deliberately leak raw tool name and path to test sanitizeThinkingSummary!
          return { text: "run_shell /Users/secret/key.txt" };
        }
        await gate;
        return { text: "摘要拦截验证结束" };
      });

      await chrome!.typeText("#message-input", "触发摘要过滤检查", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`!document.querySelector('#live-working-bubble')?.hidden`, 8000);
      await new Promise((r) => setTimeout(r, 150));

      const workingTxt = await chrome!.evalJs<string>(
        `document.querySelector('.live-working-text')?.textContent || ''`
      );
      assert.ok(!workingTxt.includes("run_shell"), "Raw tool name must never leak to working bubble");
      assert.ok(!workingTxt.includes("/Users/"), "Raw path must never leak to working bubble");

      releaseTurn();
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('摘要拦截验证结束'))`,
        10_000
      );
      mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-CHAT-03 ----------
  await collector.runCase(
    t,
    {
      id: "P0-CHAT-03",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "运行中 Live Steering 非打断插话：并行多 tool_call 中途插话自动补齐配对并续答",
      module: "Agent Loop / Live Steering",
    },
    async ({ setEvidence }) => {
      await ensureProviderReady();
      let stepCallCount = 0;
      let holdSecondTool = false;
      let releaseHold!: () => void;
      const holdPromise = new Promise<void>((r) => {
        releaseHold = r;
      });

      // Switch to fresh steering harness using controlled mock handler
      const sBot = ws.store.createSession({ title: "ParallelSteerBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('ParallelSteerBot'))`
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('ParallelSteerBot'));
        el && el.click();
      })()`);

      mockLlm.clearRequests();
      mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) {
          return { text: "执行读取" };
        }
        const mStr = JSON.stringify(body?.messages || "");
        stepCallCount += 1;
        if (stepCallCount === 1) {
          // Emit TWO parallel tool calls!
          return {
            toolCalls: [
              { id: "tc-p1", name: "run_shell", args: { command: "echo first", risk: "low" } },
              { id: "tc-p2", name: "run_shell", args: { command: "echo second", risk: "low" } },
            ],
          };
        }
        // Check if steered message arrived in messages
        if (mStr.includes("改查第三个目标")) {
          return { text: "收到插话并完成第三个目标" };
        }
        await holdPromise;
        return { text: "未收到插话" };
      });

      // Wrap executor.call momentarily to delay the first tool just long enough for user steer!
      const origCall = ws.executor.call;
      ws.executor.call = async (route: string, body?: any, callOpts?: any) => {
        if (route === "/shell" && !holdSecondTool) {
          holdSecondTool = true;
          // Send live steering message while inside first tool!
          setTimeout(async () => {
            await fetch(`${ws.baseUrl}/api/sessions/${sBot.id}/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: "改查第三个目标" }),
            });
            setTimeout(() => releaseHold(), 50);
          }, 80);
          await new Promise((r) => setTimeout(r, 180));
        }
        return origCall(route, body, callOpts);
      };

      try {
        await chrome!.typeText("#message-input", "并行跑两个命令", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('收到插话并完成第三个目标'))`,
          10_000
        );
      } finally {
        ws.executor.call = origCall;
        mockLlm.setHandler(undefined);
      }

      const hist = ws.store.loadHistory(sBot.id);
      const calls = hist.filter((s: any) => s.type === "function_call");
      const results = hist.filter((s: any) => s.type === "function_result");
      setEvidence("parallelCalls", calls.length);
      setEvidence("parallelResults", results.length);
      assert.equal(calls.length, results.length, "All parallel function_calls must have paired function_results after steering");
      assert.ok(
        results.some((r: any) => JSON.stringify(r).includes("skipped")),
        "Unexecuted second parallel tool call must be filled with skipped function_result"
      );
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-CHAT-04 ----------
  await collector.runCase(
    t,
    {
      id: "P0-CHAT-04",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "显式停止按钮 + 自然语言停止词('停下'/'stop')中止 vs 正常指令('stop nginx')区分",
      module: "Stop Detector / Control",
    },
    async () => {
      await ensureProviderReady();
      // Validate POST /api/control rejects invalid action with 400
      const badCtrl = await fetch(`${ws.baseUrl}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invalid_action" }),
      });
      assert.equal(badCtrl.status, 400, "POST /api/control invalid action must return 400");

      let releaseSlow!: () => void;
      let slowGate = new Promise<void>((r) => {
        releaseSlow = r;
      });
      mockLlm.setHandler(async ({ body }) => {
        const txt = JSON.stringify(body?.messages || "");
        if (txt.includes("意图判断") || txt.includes("STOP") || txt.includes("中止")) {
          const lastMsg = String(body?.messages?.[body.messages.length - 1]?.content || "");
          return { text: lastMsg.includes("停下") ? "YES" : "NO" };
        }
        if (
          txt.includes("ultra-short Chinese phrase") ||
          txt.includes("Distill the current task progress") ||
          txt.includes("短语") ||
          txt.includes("概括")
        )
          return { text: "处理中" };
        await slowGate;
        return { text: "slow finished" };
      });

      // 1. Explicit stop button
      await chrome!.typeText("#message-input", "执行慢任务1", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`!document.querySelector('#live-working-bubble')?.hidden`, 6000);
      await chrome!.click("#live-working-stop-btn");
      await chrome!.waitFor(`document.querySelector('#status-badge')?.dataset?.status === 'stopped'`, 6000);
      releaseSlow();

      // 2. Natural language stop ("停下")
      slowGate = new Promise<void>((r) => {
        releaseSlow = r;
      });
      await chrome!.typeText("#message-input", "执行慢任务2", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`!document.querySelector('#live-working-bubble')?.hidden`, 6000);
      await chrome!.typeText("#message-input", "停下", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`document.querySelector('#status-badge')?.dataset?.status === 'stopped'`, 6000);
      releaseSlow();

      // 3. Non-stop instruction ("stop nginx") must NOT stop the run; it should steer and finish!
      let seenStopNginx = false;
      mockLlm.setHandler(async ({ body }) => {
        const txt = JSON.stringify(body?.messages || "");
        if (txt.includes("意图判断") || txt.includes("中止")) return { text: "NO" };
        if (
          txt.includes("ultra-short Chinese phrase") ||
          txt.includes("Distill the current task progress") ||
          txt.includes("短语") ||
          txt.includes("概括")
        )
          return { text: "处理中" };
        if (txt.includes("stop nginx")) {
          seenStopNginx = true;
          return { text: "已执行 stop nginx 指令" };
        }
        await new Promise((r) => setTimeout(r, 150));
        return { text: "first part" };
      });
      await chrome!.typeText("#message-input", "先准备环境", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`!document.querySelector('#live-working-bubble')?.hidden`, 6000);
      await chrome!.typeText("#message-input", "stop nginx", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('已执行 stop nginx 指令'))`,
        8000
      );
      assert.equal(seenStopNginx, true);
      mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-RELOAD-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-RELOAD-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "F5 整页刷新后挂起审批态(awaiting_approval)无损恢复与错误提示跨端持久化同步关闭",
      module: "Session Persistence / Reload Recovery",
    },
    async ({ setEvidence }) => {
      await ensureProviderReady();
      const reloadBot = ws.store.createSession({ title: "ReloadRecoveryBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('ReloadRecoveryBot'))`,
        8000
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('ReloadRecoveryBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('ReloadRecoveryBot')`, 6000);

      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy: {
            autoAudit: true,
            askRules: [{ id: "e2e-reload", tool: "browser_click", pattern: "", label: "e2e reload confirm" }],
            allowRules: [],
          },
        }),
      });

      let step = 0;
      mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "等待确认" };
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{ id: "c-reload", name: "browser_click", args: { ref: "e1", risk: "high" } }],
          };
        }
        return { text: "刷新恢复并完成执行" };
      });

      await chrome!.typeText("#message-input", "触发需审批任务并刷新", { clear: true });
      await chrome!.pressKey("Enter");
      await chrome!.waitFor(`Boolean(document.querySelector('.confirm-card:not(.is-collapsed)'))`, 8000);
      await chrome!.waitFor(`document.querySelector('#status-badge')?.dataset?.status === 'awaiting_approval'`, 5000);

      // Reload the browser page while awaiting approval!
      await chrome!.reload(true);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.waitFor(`Boolean(document.querySelector('.confirm-card:not(.is-collapsed)'))`, 8000);
      const activeAfterReload = await chrome!.evalJs<string>(
        `document.querySelector('#header-bot-name')?.textContent?.trim() || ''`
      );
      setEvidence("activeBotAfterF5Reload", activeAfterReload);
      assert.ok(
        activeAfterReload.includes("ReloadRecoveryBot"),
        `F5 reload must restore last active session ReloadRecoveryBot, got ${activeAfterReload}`
      );
      await chrome!.click(".confirm-card:not(.is-collapsed) .btn-approve");
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('刷新恢复并完成执行'))`,
        8000
      );
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: { autoAudit: true, askRules: [], allowRules: [] } }),
      });

      // Cross-client error dismissal: closing once persists on server and syncs live across devices
      const err1 = ws.store.appendEvent(reloadBot.id, {
        type: "error",
        message: "Cross-device error notice 1",
      });
      ws.runner.broadcastGlobal({ sessionId: reloadBot.id, ...err1 });
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.error-card-body')).some(el => el.textContent?.includes('Cross-device error notice 1'))`,
        6000
      );
      await chrome!.click(".error-card .error-card-close-btn");
      await chrome!.waitFor(`document.querySelectorAll('.error-card').length === 0`, 6000);
      // Wait for server persistence of error_dismissed, then wipe localStorage and reload (simulating another device)
      const deadline = Date.now() + 5000;
      while (
        !ws.store
          .readEvents(reloadBot.id)
          .some((ev: any) => ev.type === "error_dismissed" && ev.targetSeq === err1.seq) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.ok(
        ws.store
          .readEvents(reloadBot.id)
          .some((ev: any) => ev.type === "error_dismissed" && ev.targetSeq === err1.seq),
        "Closing .error-card must persist error_dismissed on the server"
      );
      await chrome!.evalJs(`window.localStorage.removeItem('twinklebot.dismissedErrorCards.v1')`);
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('刷新恢复并完成执行'))`,
        8000
      );
      const errCountAfterFreshDeviceReload = await chrome!.evalJs<number>(
        `document.querySelectorAll('.error-card').length`
      );
      assert.equal(
        errCountAfterFreshDeviceReload,
        0,
        "Dismissed error must stay dismissed even with empty localStorage (fresh device)"
      );

      // Remote dismissal from another client removes .error-card live without reload
      const err2 = ws.store.appendEvent(reloadBot.id, {
        type: "error",
        message: "Cross-device error notice 2",
      });
      ws.runner.broadcastGlobal({ sessionId: reloadBot.id, ...err2 });
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('.error-card-body')).some(el => el.textContent?.includes('Cross-device error notice 2'))`,
        6000
      );
      const remoteDismissRes = await fetch(
        `${ws.baseUrl}/api/sessions/${reloadBot.id}/errors/dismiss`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seq: err2.seq }),
        }
      );
      assert.equal(remoteDismissRes.status, 200);
      await chrome!.waitFor(`document.querySelectorAll('.error-card').length === 0`, 6000);
      mockLlm.setHandler(undefined);
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-CHAT-05 ----------
  await collector.runCase(
    t,
    {
      id: "P0-CHAT-05",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D2",
      title: "单轮最大步数上限暂停(.max-steps-card)、尾步提醒、历史封口与点击「继续执行」无缝接续",
      module: "Agent Loop / Max Steps Continue",
    },
    async ({ setEvidence }) => {
      await ensureProviderReady();
      const prevMaxSteps = ws.config.maxSteps;
      ws.config.maxSteps = 4;
      const msBot = ws.store.createSession({ title: "MaxStepsContinueBot" });
      await chrome!.reload(true);
      await chrome!.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('MaxStepsContinueBot'))`,
        8000
      );
      await chrome!.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('MaxStepsContinueBot'));
        el && el.click();
      })()`);
      await chrome!.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('MaxStepsContinueBot')`, 6000);

      let seenFinalStepNotice = false;
      let turnPhase: "first" | "continued" = "first";
      let stepIdx = 0;

      mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "执行步骤" };
        const msgStr = JSON.stringify(body?.messages || "");
        if (msgStr.includes("This is step 4/4")) {
          seenFinalStepNotice = true;
        }
        if (turnPhase === "first") {
          stepIdx += 1;
          return {
            toolCalls: [{ id: `ms-call-${stepIdx}`, name: "run_shell", args: { command: `echo step-${stepIdx}`, risk: "low" } }],
          };
        }
        return { text: "已从步数上限暂停处接续完成全部任务！" };
      });

      try {
        await chrome!.typeText("#message-input", "执行多步骤长任务", { clear: true });
        await chrome!.pressKey("Enter");
        await chrome!.waitFor(`Boolean(document.querySelector('.max-steps-card .max-steps-continue-btn'))`, 12_000);

        assert.equal(seenFinalStepNotice, true, "Final step 4/4 must inject system wrap-up notice into LLM prompt");
        const events = ws.store.readEvents(msBot.id);
        const msNotice = events.find((e: any) => e.type === "route_notice" && e.level === "max_steps");
        assert.ok(msNotice, "route_notice with level='max_steps' must be persisted");
        assert.ok((msNotice.toolCount || 0) >= 4, `Expected toolCount >= 4, got ${msNotice.toolCount}`);

        const sessAfterPause = ws.store.getSession(msBot.id);
        assert.match(sessAfterPause?.subtitle || "", /最大步数上限/, "Session subtitle must reflect max_steps pause");

        const hist = ws.store.loadHistory(msBot.id);
        assert.equal(hist[hist.length - 1]?.type, "model_output", "History must be cleanly sealed with model_output on max_steps");

        // Click "继续执行" button inside .max-steps-card
        turnPhase = "continued";
        await chrome!.click(".max-steps-card .max-steps-continue-btn");
        await chrome!.waitFor(
          `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('已从步数上限暂停处接续完成全部任务'))`,
          10_000
        );
        await chrome!.waitFor(`Boolean(document.querySelector('.max-steps-card .max-steps-continued-hint'))`, 5000);
        setEvidence("maxStepsToolCount", msNotice.toolCount);
      } finally {
        ws.config.maxSteps = prevMaxSteps;
        mockLlm.setHandler(undefined);
      }
    },
    { getChrome: () => chrome }
  );

  // ---------- P0-CRYPTO-01 ----------
  await collector.runCase(
    t,
    {
      id: "P0-CRYPTO-01",
      priority: "P0",
      featureTier: "F1",
      difficulty: "D1",
      title: "本地 AES-256-GCM 静态加密落盘、明文自动迁移、篡改容错与 8 项 backend apiCapabilities 宣告",
      module: "Local Crypto & Capabilities",
    },
    async ({ setEvidence }) => {
      const cryptoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-e2e-crypto-"));
      try {
        // 1. Legacy plaintext vault.json auto-migrates to AES-256-GCM envelope on first read
        const vaultFile = path.join(cryptoDir, "vault.json");
        const legacyItems = [
          { id: "v-mig-1", category: "credential", title: "LegacyBank", subtitle: "u@test.com", password: "LegacyPlainPassword#99" },
        ];
        fs.writeFileSync(vaultFile, JSON.stringify(legacyItems, null, 2), "utf8");

        const tmpStore = createStore(cryptoDir);
        const loaded = tmpStore.readVault();
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0].password, "LegacyPlainPassword#99");

        const migratedRaw = fs.readFileSync(vaultFile, "utf8");
        assert.ok(!migratedRaw.includes("LegacyPlainPassword#99"), "Migrated vault.json must not contain plaintext password");
        const parsedEnv = JSON.parse(migratedRaw);
        assert.equal(isEncryptedEnvelope(parsedEnv), true, "Migrated vault.json must be an AES-256-GCM envelope");

        const keyFile = path.join(cryptoDir, ".vault.key");
        assert.ok(fs.existsSync(keyFile), ".vault.key must be created");
        if (process.platform !== "win32") {
          const mode = fs.statSync(keyFile).mode & 0o777;
          assert.equal(mode, 0o600, `.vault.key mode must be 0600, got ${mode.toString(8)}`);
        }

        // 2. Tampered ciphertext/tag fails decryption cleanly & returns fallback without crashing
        const cryptoInst = createLocalCrypto(cryptoDir, { forceKeyfile: true });
        const tampered = { ...parsedEnv, ciphertext: Buffer.from("tampered-bytes").toString("base64") };
        const tamperFile = path.join(cryptoDir, "tamper-test.json");
        fs.writeFileSync(tamperFile, JSON.stringify(tampered), "utf8");
        const fallback = cryptoInst.readEncryptedJsonFile(tamperFile, [{ ok: "fallback" }]);
        assert.deepEqual(fallback, [{ ok: "fallback" }], "Tampered ciphertext must return fallback safely");

        // 3. Verify GET /api/system/diagnostics advertises all 11 current backend apiCapabilities
        const diag: any = await (await fetch(`${ws.baseUrl}/api/system/diagnostics`)).json();
        const caps: string[] = diag?.apiCapabilities || [];
        for (const expectedCap of [
          "core-v1",
          "vault-patch-v1",
          "gemini-vertex-gate-v1",
          "ota-v1",
          "multi-display-v1",
          "vault-secret-v1",
          "memory-suggest-v1",
          "computer-remote-input-v1",
          "local-browser-automation-v1",
          "i18n-v1",
          "channel-integrations-v1",
        ]) {
          assert.ok(caps.includes(expectedCap), `Diagnostics must advertise capability '${expectedCap}', got ${caps.join(",")}`);
        }
        setEvidence("capabilitiesCount", caps.length);
      } finally {
        fs.rmSync(cryptoDir, { recursive: true, force: true });
      }
    },
    { getChrome: () => chrome }
  );
});
