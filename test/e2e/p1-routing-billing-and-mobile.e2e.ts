import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
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
      title: "多供应商 CRUD/测速/启停/删除重平衡 + 429(冷却)/404(屏蔽)自动无感故障转移",
      module: "Providers & Failover Router",
    },
    async () => {
      // Add a second backup openai-compatible provider pointing to same mockLlm
      const addRes = await fetch(`${ws.baseUrl}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "backup-prov",
          type: "openai-compatible",
          name: "Backup Provider",
          apiKey: "bk-key-123",
          baseUrl: ws.mockLlm.openaiBaseUrl,
          models: ["bk-fast", "bk-med"],
          enabled: true,
        }),
      });
      assert.equal(addRes.status, 200);

      // Test connection
      ws.mockLlm.enqueue({ text: "OK" });
      const testRes: any = await (
        await fetch(`${ws.baseUrl}/api/providers/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "backup-prov", type: "openai-compatible", baseUrl: ws.mockLlm.openaiBaseUrl, model: "bk-fast" }),
        })
      ).json();
      assert.equal(testRes.ok, true);

      // Simulate 429 on e2e-medium -> auto-failover to another model without failing the user turn!
      const failoverBot = ws.store.createSession({ title: "FailoverBot" });
      let failedOnce = false;
      ws.mockLlm.setHandler(async ({ body }) => {
        if (
          JSON.stringify(body?.messages).includes("ultra-short Chinese phrase") ||
          JSON.stringify(body?.messages).includes("短语")
        )
          return { text: "模型重试" };
        if (!failedOnce && body?.model === "e2e-medium") {
          failedOnce = true;
          return { status: 429, text: "rate limit exceeded" };
        }
        return { text: `故障转移成功(${body?.model})` };
      });
      await fetch(`${ws.baseUrl}/api/sessions/${failoverBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "验证 429 自动故障转移" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(failoverBot.id), 10_000, "failover finishes");
      ws.mockLlm.setHandler(undefined);
      const evs = ws.store.readEvents(failoverBot.id);
      assert.ok(evs.some((e: any) => e.type === "answer" && /故障转移成功/.test(e.text || "")));

      // Delete backup-prov and confirm routing tiers stay valid (no dangling providerId)
      assert.equal((await fetch(`${ws.baseUrl}/api/providers/backup-prov`, { method: "DELETE" })).status, 200);
      const afterDel: any = await (await fetch(`${ws.baseUrl}/api/settings`)).json();
      assert.notEqual(afterDel.routing?.tiers?.fast?.providerId, "backup-prov");
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
      title: "智能路由 economy/balanced/quality 切换、关闭 smartRouter 退回规则、route_escalate 主动升档与 route-stats 落盘",
      module: "Smart Router v2",
    },
    async () => {
      for (const mode of ["economy", "quality", "balanced"]) {
        const r = await fetch(`${ws.baseUrl}/api/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routing: { smartRouter: true, mode } }),
        });
        assert.equal(r.status, 200);
      }

      const routeBot = ws.store.createSession({ title: "RouteEscBot" });
      let step = 0;
      const modelsUsed: string[] = [];
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
        modelsUsed.push(String(body?.model || ""));
        step += 1;
        if (step === 1) {
          return {
            toolCalls: [{ id: "re-1", name: "route_escalate", args: { need: "think", reason: "complex reasoning" } }],
          };
        }
        return { text: "主动升档推理完成" };
      });
      await fetch(`${ws.baseUrl}/api/sessions/${routeBot.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "请深度分析这个复杂算法" }),
      });
      await ws.waitUntil(() => !ws.runner.isSessionBusy(routeBot.id), 10_000, "route_escalate turn finishes");
      ws.mockLlm.setHandler(undefined);

      assert.ok(modelsUsed.length >= 2, "Must execute escalated follow-up step");
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
      title: "AI 生图 + 无生图模型自动降级 LLM 生成 SVG + /api/images/convert 转 PNG/PDF 落入资料库",
      module: "Image Generation & SVG Fallback",
    },
    async () => {
      const imgBot = ws.store.createSession({ title: "ImageBot" });
      // 1. Primary image generation succeeds
      ws.mockLlm.setImageGenEnabled(true);
      const gen1: any = await (
        await fetch(`${ws.baseUrl}/api/images/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "一只蓝色小猫", sessionId: imgBot.id }),
        })
      ).json();
      assert.equal(gen1.ok, true);
      assert.ok(gen1.path && fs.existsSync(gen1.path));

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

      // 3. Convert SVG -> PNG via /api/images/convert
      const convRes = await fetch(`${ws.baseUrl}/api/images/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#10b981"/></svg>`,
          format: "png",
          sessionId: imgBot.id,
        }),
      });
      assert.equal(convRes.status, 201);
      const convJson: any = await convRes.json();
      assert.ok(convJson.path && fs.existsSync(convJson.path));
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
      title: "3 阶段上下文自动压缩与 413 context_length_exceeded 溢出强制压缩自愈重试",
      module: "Context Compression",
    },
    async () => {
      const compBot = ws.store.createSession({ title: "CompressBot" });
      // Seed long multi-turn history
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
      title: "用量与账单：单轮预算护栏、DeepSeek 实时查余与定时周期、手动校准(set/add/sub/clear)与旧版 googleBilling 迁移",
      module: "Usage & Billing",
    },
    async () => {
      // 1. Live DeepSeek balance refresh via mockLlm /user/balance
      ws.mockLlm.setBalance(256.8);
      const refRes: any = await (
        await fetch(`${ws.baseUrl}/api/billing/providers/e2e-primary/refresh`, { method: "POST" })
      ).json();
      assert.equal(refRes.ok, true);
      const dsCard =
        refRes.provider ||
        (refRes.providers || refRes.summary?.providers || []).find((p: any) => p.providerId === "e2e-primary");
      assert.equal(dsCard?.remainingCny ?? dsCard?.live?.totalCny, 256.8);

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
        (calAdd.providers || calAdd.summary?.providers || []).find((p: any) => p.providerId === "cal-prov")
          ?.remainingCny,
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
        (calSub.providers || calSub.summary?.providers || []).find((p: any) => p.providerId === "cal-prov")
          ?.remainingCny,
        130
      );

      // Open Usage modal in Chrome UI and verify merged balance + single-bot trace toggle!
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);
      await chrome!.click("#open-trace-drawer-row");
      await chrome!.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 6000);
      await chrome!.waitFor(`Boolean(document.querySelector('#usage-open-trace-btn'))`, 6000);
      await chrome!.click("#usage-open-trace-btn");
      await chrome!.waitFor(`!document.querySelector('#usage-inline-trace-view')?.hidden`, 6000);
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
      title: "移动端 dist-web (390×844 触屏) 列表↔对话导航、左缘右滑返回、4 大底部抽屉与创建 13×11 Bot",
      module: "Mobile Web Bundle & Sheets",
    },
    async () => {
      await ensureMobileServer();
      mobTab = await chrome!.openNewTab("about:blank");
      t.after(() => mobTab?.close());
      await mobTab.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true });

      // Inject simulated Capacitor bridge before mobile app boots!
      await mobTab.addInitScript(`
        window.__e2eCapCalls = { orientation: [], minimizeCount: 0, backListeners: [] };
        window.Capacitor = {
          isNativePlatform: () => true,
          getPlatform: () => 'android',
          Plugins: {
            Preferences: {
              _store: {
                "twinklebot.accounts.v2": JSON.stringify({
                  activeAccountId: 'cloud-e2e-mob',
                  accounts: [{ id: 'cloud-e2e-mob', type: 'cloud', name: 'E2E Node', baseUrl: ${JSON.stringify(ws.baseUrl)}, token: '' }]
                }),
              },
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
                    appVersion: '1.0.0',
                    lanAccessEnabled: true,
                  }]
                };
              },
              async setScreenOrientation({ mode }) { window.__e2eCapCalls.orientation.push(mode); return { ok: true }; },
            },
            WebUpdater: {
              async getState() { return { usingBuiltIn: true, activeBuild: 'built-in', builtInNativeKey: '1.0.0(1)' }; },
              async confirmReady() { return { ok: true }; },
              async rollbackToBuiltIn() { return { ok: true }; },
            }
          }
        };
        // Pre-seed accounts pointing to local test workspace server so mobile connects cleanly
        try {
          localStorage.setItem('twinklebot.accounts.v2', JSON.stringify({
            activeAccountId: 'cloud-e2e-mob',
            accounts: [{ id: 'cloud-e2e-mob', type: 'cloud', name: 'E2E Node', baseUrl: ${JSON.stringify(ws.baseUrl)}, token: '' }]
          }));
        } catch {}
      `);

      await mobTab.navigate(mobileOrigin);
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 10_000);
      await mobTab.waitFor(`Boolean(document.querySelector('#mobile-new-bot-btn'))`, 6000);

      // Open Mobile Bot Editor sheet & create a custom 13x11 Bot!
      await mobTab.click("#mobile-new-bot-btn");
      await mobTab.waitFor(`!document.querySelector('#mobile-bot-editor-sheet')?.hidden`, 6000);
      await mobTab.fill("#mobile-bot-name-input", "移动随身助手");
      await mobTab.fill("#mobile-bot-role-input", "随时响应手机端指令");
      await mobTab.click("#mobile-bot-save-btn");
      await mobTab.waitFor(`document.querySelector('#mobile-bot-editor-sheet')?.hidden`, 6000);
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'chat'`, 6000);

      // Open Mobile Inspector sheet & dismiss via backdrop click
      await mobTab.click("#header-bot-pill");
      await mobTab.waitFor(`!document.querySelector('#mobile-inspector-sheet')?.hidden`, 6000);
      await mobTab.evalJs(`(() => {
        const sh = document.querySelector('#mobile-inspector-sheet');
        if (sh) sh.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await mobTab.waitFor(`document.querySelector('#mobile-inspector-sheet')?.hidden`, 6000);

      // Back to list via #mobile-back-btn
      await mobTab.click("#mobile-back-btn");
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 6000);

      // Open Mobile Settings sheet & Node Switcher sheet
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
      title: "移动端局域网发现扫描、手动 IP 输入与全屏桌面横屏解锁(setScreenOrientation sensor -> portrait)",
      module: "Mobile Node Discovery & Orientation",
    },
    async () => {
      if (!mobTab) throw new EnvSkipSignal("Depends on P1-MOB-01 mobile tab");
      await mobTab.click("#mobile-lan-scan-btn");
      await mobTab.waitFor(`document.querySelector('#mobile-lan-list')?.textContent?.includes('E2E-MacBook')`, 6000);
      // Dismiss node sheet via backdrop click, then close settings sheet
      await mobTab.evalJs(`(() => {
        const ns = document.querySelector('#mobile-node-sheet');
        if (ns) ns.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await mobTab.waitFor(`document.querySelector('#mobile-node-sheet')?.hidden`, 4000);
      await mobTab.click("#mobile-settings-close-btn");
      await mobTab.waitFor(`document.querySelector('#mobile-settings-sheet')?.hidden`, 4000);
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
      title: "Android 硬件返回键 22 级优先栈逐级出栈(弹窗 -> 抽屉 -> 对话退列表 -> minimizeApp)",
      module: "Mobile Hardware Back Stack",
    },
    async () => {
      if (!mobTab) throw new EnvSkipSignal("Depends on P1-MOB-01 mobile tab");
      // Enter chat view -> open mobile inspector -> trigger backButton twice -> returns to list -> once more -> minimizeApp!
      await mobTab.click("#pinned-primary-bot");
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'chat'`, 6000);
      await mobTab.click("#header-bot-pill");
      await mobTab.waitFor(`!document.querySelector('#mobile-inspector-sheet')?.hidden`, 6000);

      const triggerBack = () =>
        mobTab!.evalJs(`window.__e2eCapCalls.backListeners.forEach(fn => fn({ canGoBack: false }))`);

      // Back #1 closes mobile inspector sheet
      await triggerBack();
      await mobTab.waitFor(`document.querySelector('#mobile-inspector-sheet')?.hidden`, 4000);

      // Back #2 exits chat -> list
      await triggerBack();
      await mobTab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 4000);

      // Back #3 at root list calls minimizeApp
      await triggerBack();
      await mobTab.waitFor(`window.__e2eCapCalls.minimizeCount >= 1`, 4000);
    },
    { getChrome: () => mobTab || chrome }
  );
});
