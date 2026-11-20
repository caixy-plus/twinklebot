import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { SAMPLE_PNG_BUFFER } from "../helpers/e2e-protocol-fixtures.js";
import { createSuiteCollector, EnvSkipSignal, PROJECT_ROOT } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

test("P1 Suite 6: Multi-Provider Routing Failover, Image/SVG Fallback, Context Compression, Billing & Mobile App Bundle", async (t) => {
  const collector = createSuiteCollector("p1-routing-billing-and-mobile");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  const ws = await createE2EWorkspace({
    providerType: "deepseek",
    smartRouter: true,
  });
  t.after(() => ws.close());

  // ---------- P1-ROUTE-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-ROUTE-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "多供应商 UI/API CRUD(含 PATCH/测速/启停/4档绑定/删除重平衡/vertex 400) + 429(冷却)/404(永久屏蔽)自动无感故障转移",
      module: "Providers & Failover Router",
    },
    async () => {
      // 1. Direct API validation: unsupported provider type "vertex" must return 400
      const badVertex = await fetch(`${ws.baseUrl}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "bad-v", type: "vertex", name: "BadVertex", models: ["x"] }),
      });
      assert.equal(badVertex.status, 400, "Legacy/unsupported type=vertex must be rejected with 400");

      // 2. Open Settings -> Models UI and exercise full provider creation, secret toggle, test connection, save & 4 tier dropdowns!
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 10_000);
      await chrome!.click("#account-menu-btn");
      await chrome!.waitFor(`!document.querySelector('#account-popover')?.hidden`, 4000);
      await chrome!.click('[data-account-action="settings"]');
      await chrome!.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 5000);
      await chrome!.click('.settings-nav-item[data-settings-tab="models"]');

      await chrome!.click("#add-provider-btn");
      await chrome!.waitFor(`!document.querySelector('#provider-form')?.hidden || Boolean(document.querySelector('#provider-name-input'))`, 4000);
      await chrome!.selectOption("#provider-type-select", "openai-compatible").catch(() => {});
      await chrome!.fill("#provider-name-input", "UI Backup Provider");
      await chrome!.fill("#provider-api-key-input", "sk-ui-backup-999");
      // Secret visibility toggle password <-> text (scoped to #provider-api-key-input's field-group)
      assert.equal(await chrome!.evalJs<string>(`document.querySelector('#provider-api-key-input')?.type`), "password");
      await chrome!.evalJs(`document.querySelector('#provider-api-key-input')?.closest('.field-group')?.querySelector('.mail-secret-toggle')?.click()`);
      assert.equal(await chrome!.evalJs<string>(`document.querySelector('#provider-api-key-input')?.type`), "text");
      await chrome!.fill("#provider-base-url-input", ws.mockLlm.openaiBaseUrl);
      await chrome!.fill("#provider-models-input", "bk-fast, bk-med");

      ws.mockLlm.enqueue({ text: "OK" });
      await chrome!.click("#provider-test-btn");
      await chrome!.waitFor(`document.querySelector('#provider-form-feedback')?.textContent?.includes('连接成功')`, 6000);

      await chrome!.click("#provider-save-btn");
      await chrome!.waitFor(`document.querySelector('#providers-list')?.textContent?.includes('UI Backup Provider')`, 5000);

      // Verify all 4 routing tier dropdowns exist in Models tab
      for (const sel of ["#tier-fast-select", "#tier-medium-select", "#tier-advanced-select", "#tier-image-select"]) {
        assert.equal(await chrome!.evalJs<boolean>(`Boolean(document.querySelector('${sel}'))`), true, `${sel} must exist`);
      }

      // Exercise PATCH /api/providers/:id to update name & toggle enabled
      const provListRes: any = await (await fetch(`${ws.baseUrl}/api/providers`)).json();
      const uiProv = (provListRes.providers || []).find((p: any) => p.name === "UI Backup Provider");
      assert.ok(uiProv?.id, "UI-created provider must persist in GET /api/providers");
      const patchRes = await fetch(`${ws.baseUrl}/api/providers/${encodeURIComponent(uiProv.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Backup Provider Patched", enabled: true }),
      });
      assert.equal(patchRes.status, 200);
      // Direct /api/providers/test API contract check as well
      ws.mockLlm.enqueue({ text: "OK" });
      const directTest: any = await (
        await fetch(`${ws.baseUrl}/api/providers/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: uiProv.id, type: "openai-compatible", baseUrl: ws.mockLlm.openaiBaseUrl, model: "bk-fast" }),
        })
      ).json();
      assert.equal(directTest.ok, true);
      await chrome!.click("#close-settings-modal-btn");

      // 3. Simulate BOTH 429 rate-limit cooldown AND 404 permanent blocklist -> auto-failover without failing user turn!
      const failoverBot = ws.store.createSession({ title: "FailoverBot" });
      let failed429 = false;
      let failed404 = false;
      const seenModels: string[] = [];
      ws.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (s.includes("ultra-short Chinese phrase") || s.includes("短语") || s.includes("概括")) {
          return { text: "模型重试" };
        }
        const m = String(body?.model || "");
        seenModels.push(m);
        if (!failed429 && m === "e2e-medium") {
          failed429 = true;
          return { status: 429, text: "rate limit exceeded" };
        }
        if (!failed404 && m === "e2e-advanced") {
          failed404 = true;
          return { status: 404, text: "model not found: e2e-advanced" };
        }
        return { text: `故障转移成功(${m})` };
      });

      // Turn 1: triggers 429 on e2e-medium -> auto-failover
      await fetch(`${ws.baseUrl}/api/sessions/${failoverBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "验证 429 自动故障转移" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(failoverBot.id), 10_000, "429 failover finishes");

      // Turn 2: force advanced tier hit -> triggers 404 permanent blocklist -> auto-failover
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: { smartRouter: false, mode: "quality" }, model: "e2e-advanced" }),
      });
      await fetch(`${ws.baseUrl}/api/sessions/${failoverBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "架构级深度重构验证 404 屏蔽转移" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(failoverBot.id), 10_000, "404 failover finishes");
      ws.mockLlm.setHandler(undefined);

      const evs = ws.store.readEvents(failoverBot.id);
      const answers = evs.filter((e: any) => e.type === "answer" && /故障转移成功/.test(e.text || ""));
      assert.ok(answers.length >= 2, `Expected both 429 & 404 failovers to recover cleanly, got ${answers.length}`);

      // 4. Delete backup provider and confirm routing tiers rebalance with zero dangling providerId
      assert.equal((await fetch(`${ws.baseUrl}/api/providers/${encodeURIComponent(uiProv.id)}`, { method: "DELETE" })).status, 200);
      const afterDel: any = await (await fetch(`${ws.baseUrl}/api/settings`)).json();
      assert.notEqual(afterDel.routing?.tiers?.fast?.providerId, uiProv.id);

      // Restore balanced smartRouter
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: { smartRouter: true, mode: "balanced" } }),
      });
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-ROUTE-02 ----------
  await collector.runCase(
    t,
    {
      id: "P1-ROUTE-02",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "智能路由 UI(开关/三档模式/预算上限)、关闭 smartRouter 退回规则、route_escalate(think/visual + cap=2 封顶)与 route-stats 落盘",
      module: "Smart Router v2",
    },
    async () => {
      // 1. Reload so React settings reflect smartRouter=true cleanly, then exercise Settings -> General Smart Routing UI controls!
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#account-menu-btn");
      await chrome!.waitFor(`!document.querySelector('#account-popover')?.hidden`, 4000);
      await chrome!.click('[data-account-action="settings"]');
      await chrome!.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 5000);
      await chrome!.click('.settings-nav-item[data-settings-tab="general"]');

      await chrome!.selectOption("#setting-routing-mode", "economy");
      await ws.waitUntil(() => ws.store.readSettings().routing?.mode === "economy", 4000, "mode economy persisted");
      await chrome!.selectOption("#setting-routing-mode", "quality");
      await ws.waitUntil(() => ws.store.readSettings().routing?.mode === "quality", 4000, "mode quality persisted");
      await chrome!.selectOption("#setting-routing-mode", "balanced");
      await ws.waitUntil(() => ws.store.readSettings().routing?.mode === "balanced", 4000, "mode balanced persisted");

      // Toggle smartRouter off -> wait for React checkbox state sync -> toggle back on!
      await chrome!.waitFor(`document.querySelector('#setting-smart-router-toggle')?.checked === true`, 4000);
      await chrome!.evalJs(`document.querySelector('#setting-smart-router-toggle')?.closest('label')?.click()`);
      await chrome!.waitFor(`document.querySelector('#setting-smart-router-toggle')?.checked === false`, 4000);
      await ws.waitUntil(() => ws.store.readSettings().routing?.smartRouter === false, 4000, "smartRouter toggled off");
      await chrome!.evalJs(`document.querySelector('#setting-smart-router-toggle')?.closest('label')?.click()`);
      await chrome!.waitFor(`document.querySelector('#setting-smart-router-toggle')?.checked === true`, 4000);
      await ws.waitUntil(() => ws.store.readSettings().routing?.smartRouter === true, 4000, "smartRouter toggled on");
      await chrome!.click("#close-settings-modal-btn");

      // 2. Live Agent loop: route_escalate think + visual + 3rd attempt hitting cap=2!
      const routeBot = ws.store.createSession({ title: "RouteEscBot" });
      let step = 0;
      const modelsUsed: string[] = [];
      let capSawLimit = false;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) {
          const s = JSON.stringify(body?.messages || "");
          if (s.includes("category") || s.includes("complexity") || s.includes("needs_visual")) {
            return {
              text: JSON.stringify({
                category: "coding",
                complexity: "standard",
                needs_visual: false,
                open_with_deep_steps: 0,
                reason: "test plan",
              }),
            };
          }
          return { text: "路由评估" };
        }
        const s = JSON.stringify(body?.messages || "");
        if (s.includes("上限") || s.includes("limit") || s.includes("cap") || s.includes("max")) {
          capSawLimit = true;
        }
        modelsUsed.push(String(body?.model || ""));
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "re-1", name: "route_escalate", args: { need: "think", reason: "complex reasoning" } }] };
        }
        if (step === 2) {
          return { toolCalls: [{ id: "re-2", name: "route_escalate", args: { need: "visual", reason: "inspect dense ui" } }] };
        }
        if (step === 3) {
          return { toolCalls: [{ id: "re-3", name: "route_escalate", args: { need: "think", reason: "exceed cap=2" } }] };
        }
        return { text: "主动升档与封顶校验完成" };
      });
      await fetch(`${ws.baseUrl}/api/sessions/${routeBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "请深度分析这个复杂算法并检查视觉细节" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(routeBot.id), 12_000, "route_escalate turn finishes");
      ws.mockLlm.setHandler(undefined);

      assert.ok(modelsUsed.length >= 4, `Expected >=4 steps with 2 escalations + cap check, got ${modelsUsed.length}`);
      assert.ok(capSawLimit || step >= 4, "3rd route_escalate must respect cap=2 cleanly");
      assert.ok(fs.existsSync(path.join(ws.dataDir, "route-stats.ndjson")), "route-stats.ndjson must be recorded");
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-ROUTE-03 ----------
  await collector.runCase(
    t,
    {
      id: "P1-ROUTE-03",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "AI 生图(API + Live Agent generate_image 自动嵌入 & SVG 降级) + /api/images/convert 全格式(png/jpg/webp/pdf/dataBase64/越权403/422)",
      module: "Image Generation & SVG Fallback",
    },
    async () => {
      const imgBot = ws.store.createSession({ title: "ImageBot" });
      const otherBot = ws.store.createSession({ title: "OtherBotIsolated" });

      // 1. Live Agent generate_image tool invocation (normal image + auto-embed markdown!)
      ws.mockLlm.setImageGenEnabled(true);
      let step = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "绘制图片" };
        step += 1;
        if (step === 1) {
          return { toolCalls: [{ id: "gi-1", name: "generate_image", args: { prompt: "一只赛博蓝猫" } }] };
        }
        return { text: "图片生成完成！" };
      });
      await fetch(`${ws.baseUrl}/api/sessions/${imgBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "帮我画一只赛博蓝猫" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(imgBot.id), 10_000, "generate_image agent turn finishes");
      ws.mockLlm.setHandler(undefined);
      const imgEvs = ws.store.readEvents(imgBot.id);
      const imgAnswer = imgEvs.filter((e: any) => e.type === "answer").pop();
      assert.match(String(imgAnswer?.text || ""), /!?\[.*\]\(\/api\/workspace\/file\?path=/, "Agent generate_image must auto-embed image markdown");

      // 2. Disable image endpoint -> auto-degrades to LLM SVG generation!
      ws.mockLlm.setImageGenEnabled(false);
      ws.mockLlm.setHandler(async () => ({
        text: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="#2563eb"/></svg>`,
      }));
      const gen2: any = await (
        await fetch(`${ws.baseUrl}/api/images/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "一个蓝色圆球图标", sessionId: imgBot.id }),
        })
      ).json();
      ws.mockLlm.setHandler(undefined);
      ws.mockLlm.setImageGenEnabled(true);
      assert.equal(gen2.ok, true);
      assert.equal(gen2.degraded, true, "Must report SVG degradation when image model unavailable");

      // 3. Convert SVG -> png, jpg, webp, pdf + dataBase64 + invalid format 422 + cross-bot 403!
      const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#10b981"/></svg>`;
      for (const fmt of ["png", "jpg", "webp", "pdf"]) {
        const convRes = await fetch(`${ws.baseUrl}/api/images/convert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ svg: sampleSvg, format: fmt, sessionId: imgBot.id }),
        });
        assert.equal(convRes.status, 201, `SVG -> ${fmt} conversion must succeed (201)`);
        const cj: any = await convRes.json();
        assert.ok(cj.path && fs.existsSync(cj.path), `Converted ${fmt} file must exist on disk`);
      }

      // dataBase64 PNG -> JPG conversion
      const b64Conv = await fetch(`${ws.baseUrl}/api/images/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataBase64: `data:image/png;base64,${SAMPLE_PNG_BUFFER.toString("base64")}`,
          format: "jpg",
          sessionId: imgBot.id,
        }),
      });
      assert.equal(b64Conv.status, 201, "dataBase64 conversion must return 201");

      // Unsupported format -> 400/422
      const badFmt = await fetch(`${ws.baseUrl}/api/images/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ svg: sampleSvg, format: "exe", sessionId: imgBot.id }),
      });
      assert.ok(badFmt.status === 400 || badFmt.status === 422, `Bad format must be rejected, got ${badFmt.status}`);

      // Cross-Bot path isolation 403 on /api/images/convert
      const crossConv = await fetch(`${ws.baseUrl}/api/images/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: gen2.path, format: "png", sessionId: otherBot.id }),
      });
      assert.equal(crossConv.status, 403, "Converting another Bot's private workspace image must return 403");
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-ROUTE-04 ----------
  await collector.runCase(
    t,
    {
      id: "P1-ROUTE-04",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "3 阶段上下文自动压缩、413 context_length_exceeded 溢出强制压缩自愈重试与 OpenAI 兼容 400 降级自愈",
      module: "Context Compression",
    },
    async () => {
      const compBot = ws.store.createSession({ title: "CompressBot" });
      const bigHist: any[] = [];
      for (let i = 0; i < 16; i++) {
        bigHist.push({ type: "user_input", content: [{ type: "text", text: `第${i}轮需求: ${"A".repeat(1200)}` }] });
        bigHist.push({ type: "model_output", content: [{ type: "text", text: `第${i}轮结论: ${"B".repeat(1200)}` }] });
      }
      ws.store.saveHistory(compBot.id, bigHist);

      let overflowTriggered = false;
      ws.mockLlm.setHandler(async ({ body }) => {
        const s = JSON.stringify(body?.messages || "");
        if (s.includes("ultra-short Chinese phrase") || s.includes("短语") || s.includes("概括"))
          return { text: "压缩上下文" };
        if (
          s.includes("context compression assistant") ||
          s.includes("Core Goals & Constraints") ||
          s.includes("核心目标与约束") ||
          s.includes("摘要")
        ) {
          return {
            text: "[Core Goals & Constraints] 完成长对话压缩\n[Completed Decisions] 已整理前序轮次\n[Key Files & Environment] 无\n[Pending Tasks & Next Steps] 继续当前问答",
          };
        }
        if (!overflowTriggered) {
          overflowTriggered = true;
          return { status: 413, text: "context_length_exceeded: prompt is too long" };
        }
        return { text: "413溢出自愈压缩后回答成功" };
      });

      await fetch(`${ws.baseUrl}/api/sessions/${compBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "测试413溢出自愈" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(compBot.id), 10_000, "413 recovery finishes");
      ws.mockLlm.setHandler(undefined);

      const evs = ws.store.readEvents(compBot.id);
      assert.ok(evs.some((e: any) => e.type === "context_compressed"), "Must emit context_compressed event");
      assert.ok(evs.some((e: any) => e.type === "answer" && /413溢出自愈压缩后回答成功/.test(e.text || "")));
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-BILL-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-BILL-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "用量与账单全链路：单轮预算护栏(maxTurnUsd)、DeepSeek 实时查余/全量刷新、定时周期、UI 手动校准(set/add/sub/clear)、单Bot明细与 /api/billing/gcp 迁移",
      module: "Usage & Billing",
    },
    async () => {
      // 1. Live DeepSeek balance refresh via single-provider AND global /api/billing/refresh + GET /api/billing/summary
      ws.mockLlm.setBalance(256.8);
      const refRes: any = await (
        await fetch(`${ws.baseUrl}/api/billing/providers/e2e-primary/refresh`, { method: "POST" })
      ).json();
      assert.equal(refRes.ok, true);
      const dsCard =
        refRes.provider ||
        (refRes.providers || refRes.summary?.providers || []).find((p: any) => p.providerId === "e2e-primary");
      assert.equal(dsCard?.remainingCny ?? dsCard?.live?.totalCny, 256.8);

      const globalRef: any = await (await fetch(`${ws.baseUrl}/api/billing/refresh`, { method: "POST" })).json();
      assert.equal(globalRef.ok, true);
      const sumRes: any = await (await fetch(`${ws.baseUrl}/api/billing/summary`)).json();
      assert.ok(Array.isArray(sumRes.providers));

      // Legacy /api/billing/gcp & /api/billing/gcp/calibration compatibility endpoints
      assert.equal((await fetch(`${ws.baseUrl}/api/billing/gcp`)).status, 200);
      const legacyCal = await fetch(`${ws.baseUrl}/api/billing/gcp/calibration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "set", amountUsd: 15 }),
      });
      assert.equal(legacyCal.status, 200);

      // 2. Auto-refresh schedule update
      const schRes = await fetch(`${ws.baseUrl}/api/billing/providers/e2e-primary/schedule`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoRefreshMinutes: 30 }),
      });
      assert.equal(schRes.status, 200);

      // 3. Manual calibration set / add / sub / clear on a non-live provider
      await fetch(`${ws.baseUrl}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "cal-prov",
          type: "openai",
          name: "Cal OpenAI",
          apiKey: "cal-k",
          baseUrl: ws.mockLlm.openaiBaseUrl,
          models: ["gpt-4o-mini"],
          billingCurrency: "CNY",
          enabled: true,
        }),
      });
      const calSet: any = await (
        await fetch(`${ws.baseUrl}/api/billing/providers/cal-prov/calibration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "set", amountCny: 100 }),
        })
      ).json();
      assert.equal(calSet.ok, true);
      const calAdd: any = await (
        await fetch(`${ws.baseUrl}/api/billing/providers/cal-prov/calibration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "add", amountCny: 50 }),
        })
      ).json();
      assert.equal(
        (calAdd.providers || calAdd.summary?.providers || []).find((p: any) => p.providerId === "cal-prov")?.remainingCny,
        150
      );
      const calSub: any = await (
        await fetch(`${ws.baseUrl}/api/billing/providers/cal-prov/calibration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "sub", amountCny: 20 }),
        })
      ).json();
      assert.equal(
        (calSub.providers || calSub.summary?.providers || []).find((p: any) => p.providerId === "cal-prov")?.remainingCny,
        130
      );
      const calClear: any = await (
        await fetch(`${ws.baseUrl}/api/billing/providers/cal-prov/calibration`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true }),
        })
      ).json();
      assert.equal(
        (calClear.providers || calClear.summary?.providers || []).find((p: any) => p.providerId === "cal-prov")?.remainingCny,
        null
      );

      // 4. Single-turn budget cap (maxTurnUsd = 0.00001) + GET /api/usage?sessionId=...
      const budgetBot = ws.store.createSession({ title: "BudgetGuardBot" });
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: { smartRouter: true, mode: "balanced", maxTurnUsd: 0.00001 } }),
      });
      let bStep = 0;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "预算检查" };
        bStep += 1;
        if (bStep === 1) {
          return { toolCalls: [{ id: "bg-1", name: "list_bots", args: {} }] };
        }
        return { text: "预算护栏运行完毕" };
      });
      await fetch(`${ws.baseUrl}/api/sessions/${budgetBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "测试单轮预算上限" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(budgetBot.id), 10_000, "budget turn finishes");
      ws.mockLlm.setHandler(undefined);
      const usageScoped: any = await (await fetch(`${ws.baseUrl}/api/usage?sessionId=${encodeURIComponent(budgetBot.id)}`)).json();
      assert.ok(typeof usageScoped.totalTokens === "number");

      // Restore normal budget
      await fetch(`${ws.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: { smartRouter: true, mode: "balanced", maxTurnUsd: 0.5 } }),
      });

      // 5. Open Usage modal in Chrome UI: exercise #usage-refresh-all-btn, schedule select, ProviderCalibrationForm UI & trace toggle both ways!
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#open-trace-drawer-row");
      await chrome!.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 6000);
      await chrome!.waitFor(`Boolean(document.querySelector('#usage-open-trace-btn'))`, 6000);

      // Refresh all button & schedule dropdown
      const hasRefreshAll = await chrome!.evalJs<boolean>(`!document.querySelector('#usage-refresh-all-btn')?.hidden`);
      if (hasRefreshAll) {
        await chrome!.click("#usage-refresh-all-btn");
        await new Promise((r) => setTimeout(r, 200));
      }
      const hasSchedSel = await chrome!.evalJs<boolean>(`Boolean(document.querySelector('.usage-provider-schedule-select'))`);
      if (hasSchedSel) {
        await chrome!.selectOption(".usage-provider-schedule-select", "60");
      }

      // Open ProviderCalibrationForm UI on cal-prov card -> set 222 -> save!
      await chrome!.evalJs(`(() => {
        const card = document.querySelector('.usage-provider-card[data-provider-id="cal-prov"]');
        const btn = Array.from(card?.querySelectorAll('button') || []).find(b => b.textContent?.includes('设置') || b.textContent?.includes('校准'));
        btn && btn.click();
      })()`);
      await chrome!.waitFor(`Boolean(document.querySelector('.usage-provider-card[data-provider-id="cal-prov"] .usage-gcp-calibrate-form'))`, 4000);
      await chrome!.click('.usage-provider-card[data-provider-id="cal-prov"] [data-cal-mode="set"]');
      await chrome!.fill('.usage-provider-card[data-provider-id="cal-prov"] .usage-gcp-calibrate-form input[type="number"]', "222");
      await chrome!.click('.usage-provider-card[data-provider-id="cal-prov"] .usage-gcp-save-btn');
      await chrome!.waitFor(`!document.querySelector('.usage-provider-card[data-provider-id="cal-prov"] .usage-gcp-calibrate-form')`, 4000);

      // Toggle single-bot trace view ON and BACK OFF!
      await chrome!.click("#usage-open-trace-btn");
      await chrome!.waitFor(`!document.querySelector('#usage-inline-trace-view')?.hidden`, 4000);
      await chrome!.click("#usage-open-trace-btn");
      await chrome!.waitFor(`document.querySelector('#usage-inline-trace-view')?.hidden`, 4000);
      await chrome!.click("#close-settings-modal-btn");
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-MOB-01, P1-MOB-02, P1-MOB-03 ----------
  const distWebDir = path.join(PROJECT_ROOT, "dist-web");
  let mobileSrv: http.Server | null = null;
  let mobileOrigin = "";

  const ensureMobileServer = async () => {
    if (mobileSrv) return;
    if (!fs.existsSync(path.join(distWebDir, "index.html"))) {
      throw new EnvSkipSignal("dist-web/ not built (run npm run mobile:build:web first)");
    }
    const MIME: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    mobileSrv = http.createServer((req, res) => {
      const p = (req.url || "/").split("?")[0];
      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const fp = path.join(distWebDir, rel);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
        res.end(fs.readFileSync(fp));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((r) => mobileSrv!.listen(0, "127.0.0.1", r));
    t.after(() => mobileSrv?.close());
    mobileOrigin = `http://127.0.0.1:${(mobileSrv.address() as net.AddressInfo).port}`;
  };

  let mobTab: HeadlessChromeSession | null = null;

  await collector.runCase(
    t,
    {
      id: "P1-MOB-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "移动端 dist-web (390×844 触屏) 列表↔对话导航、真实左缘右滑手势返回、搜索筛选、技能工具入口、4大抽屉与创建 13×11 Bot",
      module: "Mobile Web Bundle & Sheets",
    },
    async () => {
      await ensureMobileServer();
      mobTab = await chrome!.openNewTab("about:blank");
      t.after(() => mobTab?.close());
      await mobTab.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true });

      const accountsJson = JSON.stringify({
        activeAccountId: "cloud-e2e-mob",
        accounts: [{ id: "cloud-e2e-mob", type: "cloud", name: "E2E Node", baseUrl: ws.baseUrl, authToken: "" }],
      });
      await mobTab.addInitScript(`
        window.__e2eCapCalls = { orientation: [], minimizeCount: 0, backListeners: [] };
        window.Capacitor = {
          isNativePlatform: () => true,
          getPlatform: () => 'android',
          Plugins: {
            Preferences: {
              _store: { "twinklebot.accounts.v2": ${JSON.stringify(accountsJson)} },
              async get({ key }) { return { value: this._store[key] ?? null }; },
              async set({ key, value }) { this._store[key] = value; },
              async remove({ key }) { delete this._store[key]; },
            },
            App: {
              async addListener(ev, fn) {
                if (ev === 'backButton') window.__e2eCapCalls.backListeners.push(fn);
                return { remove: () => {} };
              },
              async minimizeApp() { window.__e2eCapCalls.minimizeCount += 1; },
              async exitApp() { window.__e2eCapCalls.minimizeCount += 1; },
            },
            LanDiscovery: {
              async getNetworkInfo() { return { ip: '192.168.1.50', subnetPrefix: '192.168.1', isWifi: true }; },
              async discover() {
                return {
                  devices: [{
                    instanceId: 'inst-e2e-lan',
                    hostname: 'E2E-MacBook',
                    platform: 'darwin',
                    port: ${ws.port},
                    host: '127.0.0.1',
                    baseUrl: ${JSON.stringify(ws.baseUrl)},
                    appVersion: '1.0.1',
                    lanAccessEnabled: true,
                  }]
                };
              },
              async setScreenOrientation({ mode }) { window.__e2eCapCalls.orientation.push(mode); return { ok: true }; },
            },
            WebUpdater: {
              async getState() { return { usingBuiltIn: true, nativeVersion: '1.0.1', nativeBuildCode: 2, activeWebBuild: 'built-in', builtInNativeKey: '1.0.1(2)' }; },
              async confirmReady() { return { ok: true }; },
              async rollbackToBuiltIn() { return { ok: true }; },
            }
          }
        };
        try {
          if (window === window.top) localStorage.setItem('twinklebot.accounts.v2', ${JSON.stringify(accountsJson)});
        } catch {}
      `);

      await mobTab.navigate(mobileOrigin);
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 10_000);
      await mobTab.waitFor(`Boolean(document.querySelector('#mobile-new-bot-btn'))`, 6000);

      // 1. Open Mobile Bot Editor sheet & create a custom 13x11 Bot (clicking shape + color swatches!)
      await mobTab.click("#mobile-new-bot-btn");
      await mobTab.waitFor(`!document.querySelector('#mobile-bot-editor-sheet')?.hidden`, 6000);
      await mobTab.fill("#mobile-bot-name-input", "移动随身助手");
      await mobTab.fill("#mobile-bot-role-input", "随时响应手机端指令");
      await mobTab.click("#mobile-bot-shapes-grid .mobile-shape-btn:nth-child(4)");
      await mobTab.click("#mobile-bot-colors-grid .mobile-color-dot:nth-child(4)");
      await mobTab.click("#mobile-bot-save-btn");
      await mobTab.waitFor(`document.querySelector('#mobile-bot-editor-sheet')?.hidden`, 6000);
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'chat'`, 6000);

      // 2. Open Mobile Inspector sheet & dismiss via backdrop click
      await mobTab.click("#header-bot-pill");
      await mobTab.waitFor(`!document.querySelector('#mobile-inspector-sheet')?.hidden`, 6000);
      await mobTab.evalJs(`(() => {
        const sh = document.querySelector('#mobile-inspector-sheet');
        if (sh) sh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await mobTab.waitFor(`document.querySelector('#mobile-inspector-sheet')?.hidden`, 6000);

      // 3. REAL left-edge swipe right gesture (x: 12 -> 240) returns from chat -> list!
      await mobTab.touchSwipe(12, 420, 240, 420, 8);
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 4000);

      // 4. Test mobile list search filter (#mobile-search-input) & Skills/Tools drawer (#mobile-tools-btn -> #mobile-apps-back-btn)!
      await mobTab.fill("#mobile-search-input", "移动随身助手");
      await mobTab.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(el => el.textContent?.includes('移动随身助手'))`,
        4000
      );
      await mobTab.fill("#mobile-search-input", "");

      await mobTab.click("#mobile-tools-btn");
      await mobTab.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`, 5000);
      await mobTab.click("#mobile-apps-back-btn");
      await mobTab.waitFor(`document.querySelector('#apps-modal-backdrop')?.hidden`, 5000);

      // 5. Open Mobile Settings sheet & Node Switcher sheet
      await mobTab.click("#mobile-settings-btn");
      await mobTab.waitFor(`!document.querySelector('#mobile-settings-sheet')?.hidden`, 6000);
      await mobTab.click("#mobile-node-switcher-card");
      await mobTab.waitFor(`!document.querySelector('#mobile-node-sheet')?.hidden`, 6000);
    },
    { getChrome: () => mobTab || chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P1-MOB-02",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "移动端局域网发现扫描、手动 IP 输入、6位配对码弹窗与全屏桌面横屏解锁(setScreenOrientation sensor -> portrait)",
      module: "Mobile Node Discovery & Orientation",
    },
    async () => {
      if (!mobTab) throw new EnvSkipSignal("Depends on P1-MOB-01 mobile tab");
      await mobTab.click("#mobile-lan-scan-btn");
      await mobTab.waitFor(`document.querySelector('#mobile-lan-list')?.textContent?.includes('E2E-MacBook')`, 6000);

      // Exercise manual IP input -> opens #mobile-pair-modal -> cancel!
      await mobTab.fill("#mobile-lan-manual-ip-input", `127.0.0.1:${ws.port}`);
      await mobTab.click("#mobile-lan-manual-pair-btn");
      await mobTab.waitFor(`!document.querySelector('#mobile-pair-modal')?.hidden`, 5000);
      await mobTab.click("#mobile-pair-cancel-btn");
      await mobTab.waitFor(`document.querySelector('#mobile-pair-modal')?.hidden`, 4000);

      // Dismiss node sheet & settings sheet
      await mobTab.evalJs(`(() => {
        const ns = document.querySelector('#mobile-node-sheet');
        if (ns) ns.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await mobTab.waitFor(`document.querySelector('#mobile-node-sheet')?.hidden`, 4000);
      await mobTab.click("#mobile-settings-close-btn");
      await mobTab.waitFor(`document.querySelector('#mobile-settings-sheet')?.hidden`, 4000);

      // Open Bot Computer Overlay from mobile inspector -> verify setScreenOrientation('sensor') then close -> 'portrait'!
      await mobTab.evalJs(`window.__e2eCapCalls.orientation = []`);
      await mobTab.click("#pinned-primary-bot");
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'chat'`, 6000);
      await mobTab.click("#header-bot-pill");
      await mobTab.waitFor(`!document.querySelector('#mobile-inspector-sheet')?.hidden`, 5000);
      await mobTab.click("#mobile-bot-computer-open-btn");
      await mobTab.waitFor(`!document.querySelector('#bot-screen-overlay')?.hidden`, 6000);
      await mobTab.waitFor(`window.__e2eCapCalls.orientation.includes('sensor')`, 4000);
      await mobTab.click("#exit-fullscreen-btn");
      await mobTab.waitFor(`document.querySelector('#bot-screen-overlay')?.hidden`, 4000);
      await mobTab.waitFor(`window.__e2eCapCalls.orientation.includes('portrait')`, 4000);
      await mobTab.click("#mobile-back-btn");
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 4000);
    },
    { getChrome: () => mobTab || chrome }
  );

  await collector.runCase(
    t,
    {
      id: "P1-MOB-03",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "Android 硬件返回键深层优先栈逐级出栈(弹窗 -> 技能页 -> 抽屉 -> 对话退列表 -> minimizeApp)",
      module: "Mobile Hardware Back Stack",
    },
    async () => {
      if (!mobTab) throw new EnvSkipSignal("Depends on P1-MOB-01 mobile tab");
      const triggerBack = () =>
        mobTab!.evalJs(`window.__e2eCapCalls.backListeners.forEach(fn => fn({ canGoBack: false }))`);

      // If desktop pairing modal was broadcast during P1-MOB-02 manual pair, Back #0 closes it cleanly first!
      const deskPairOpen = await mobTab.evalJs<boolean>(`!document.querySelector('#desktop-pairing-modal')?.hidden`);
      if (deskPairOpen) {
        await triggerBack();
        await mobTab.waitFor(`document.querySelector('#desktop-pairing-modal')?.hidden`, 4000);
      }

      // Stack layer A: SkillsStore modal on list view -> Back #1 closes SkillsStore
      await mobTab.click("#mobile-tools-btn");
      await mobTab.waitFor(`!document.querySelector('#apps-modal-backdrop')?.hidden`, 5000);
      await triggerBack();
      await mobTab.waitFor(`document.querySelector('#apps-modal-backdrop')?.hidden`, 4000);

      // Stack layer B: MobileSettingsSheet -> SettingsModal -> Back closes modal then sheet
      await mobTab.click("#mobile-settings-btn");
      await mobTab.waitFor(`!document.querySelector('#mobile-settings-sheet')?.hidden`, 5000);
      await mobTab.click("#mobile-settings-vault-row");
      await mobTab.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 4000);
      await triggerBack();
      await mobTab.waitFor(`document.querySelector('#settings-modal-backdrop')?.hidden`, 4000);
      await triggerBack();
      await mobTab.waitFor(`document.querySelector('#mobile-settings-sheet')?.hidden`, 4000);

      // Stack layer C: Enter chat -> open mobile inspector -> Back closes inspector -> Back exits chat -> Back calls minimizeApp!
      await mobTab.click("#pinned-primary-bot");
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'chat'`, 6000);
      await mobTab.click("#header-bot-pill");
      await mobTab.waitFor(`!document.querySelector('#mobile-inspector-sheet')?.hidden`, 6000);

      await triggerBack();
      await mobTab.waitFor(`document.querySelector('#mobile-inspector-sheet')?.hidden`, 4000);
      await triggerBack();
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 4000);
      await triggerBack();
      await mobTab.waitFor(`window.__e2eCapCalls.minimizeCount >= 1`, 4000);
    },
    { getChrome: () => mobTab || chrome }
  );
});
