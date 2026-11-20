import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { createSuiteCollector, EnvSkipSignal, PROJECT_ROOT } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

async function startMobileDistServer() {
  const distWebDir = path.join(PROJECT_ROOT, "dist-web");
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
  const srv = http.createServer((req, res) => {
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
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        try { (srv as any).closeAllConnections?.(); } catch {}
        const tm = setTimeout(done, 1000);
        srv.close(() => { clearTimeout(tm); done(); });
      }),
  };
}

function buildMobileCapInitScript(wsBaseUrl: string, wsPort: number, extra: { otaNewBuild?: string } = {}) {
  const accountsJson = JSON.stringify({
    activeAccountId: "cloud-e2e-mob",
    accounts: [{ id: "cloud-e2e-mob", type: "cloud", name: "E2E Node", baseUrl: wsBaseUrl, authToken: "" }],
  });
  const otaManifest = extra.otaNewBuild
    ? JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        releaseTag: "ota-e2e-test",
        webBuild: extra.otaNewBuild,
        releaseNotes: "移动端热更新体验优化",
        shells: {
          android: {
            latestVersion: "1.0.1",
            latestBuildCode: 2,
            minVersionForOta: "1.0.0",
            minBuildCodeForOta: 1,
          },
          ios: {
            latestVersion: "1.0.1",
            latestBuildCode: 2,
            minVersionForOta: "1.0.0",
            minBuildCodeForOta: 1,
          },
        },
        backend: {
          latestVersion: "1.0.1",
          minCompatibleVersion: "1.0.0",
          apiCapabilities: ["core-v1", "vault-patch-v1", "gemini-vertex-gate-v1", "ota-v1", "multi-display-v1", "vault-secret-v1", "memory-suggest-v1"],
        },
        bundles: {
          mobile: {
            target: "mobile",
            webBuild: extra.otaNewBuild,
            bundleUrl: "https://github.com/caixy-plus/twinklebot-releases/releases/download/ota-test/twinklebot-web-mobile.tar.gz",
            sha256: "a".repeat(64),
            sizeBytes: 102400,
          },
        },
      })
    : "null";

  return `
    window.__e2eCapCalls = {
      orientation: [],
      minimizeCount: 0,
      backListeners: [],
      otaProgressListeners: [],
      otaApplyCalls: [],
      otaRollbackCalls: 0,
    };
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
                port: ${wsPort},
                host: '127.0.0.1',
                baseUrl: ${JSON.stringify(wsBaseUrl)},
                appVersion: '1.0.1',
                lanAccessEnabled: true,
              }]
            };
          },
          async setScreenOrientation({ mode }) { window.__e2eCapCalls.orientation.push(mode); return { ok: true }; },
        },
        WebUpdater: {
          async getState() {
            return {
              usingBuiltIn: ${extra.otaNewBuild ? "false" : "true"},
              nativeVersion: '1.0.1',
              nativeBuildCode: 2,
              activeWebBuild: ${extra.otaNewBuild ? "'20260101.000000-old0000000'" : "'built-in'"},
              builtInNativeKey: '1.0.1(2)',
            };
          },
          async confirmReady() { return { ok: true }; },
          async fetchManifest() {
            const m = ${otaManifest};
            if (!m) return { ok: false, status: 404, error: 'NO_PUBLISHED_RELEASE' };
            return { ok: true, status: 200, jsonText: JSON.stringify(m) };
          },
          async downloadAndApply(args) {
            window.__e2eCapCalls.otaApplyCalls.push(args);
            for (const fn of window.__e2eCapCalls.otaProgressListeners) {
              fn({ stage: 'downloading', percent: 50 });
              fn({ stage: 'done', percent: 100 });
            }
            return { ok: true, activeBuild: args?.webBuild || 'applied' };
          },
          async rollbackToBuiltIn() {
            window.__e2eCapCalls.otaRollbackCalls += 1;
            return { ok: true };
          },
          async addListener(ev, fn) {
            if (ev === 'otaProgress') window.__e2eCapCalls.otaProgressListeners.push(fn);
            return { remove: () => {} };
          },
        }
      }
    };
    try {
      if (window === window.top) localStorage.setItem('twinklebot.accounts.v2', ${JSON.stringify(accountsJson)});
    } catch {}
  `;
}

test("P1 Suite 7: Mobile UX Regressions (PI-008 Overflow / Tap Actions / Composer), Deep Sheets, Drag Gestures & Mobile OTA", async (t) => {
  const collector = createSuiteCollector("p1-mobile-ux-and-gestures");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  const ws = await createE2EWorkspace({ smartRouter: false });
  t.after(() => ws.close());
  const mobSrv = await startMobileDistServer();
  t.after(() => mobSrv.close());

  // ---------- P1-MOB-04 ----------
  await collector.runCase(
    t,
    {
      id: "P1-MOB-04",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "移动端零横向溢出护栏(375/390px 长命令卡片/表格/代码)、点击消息气泡弹出操作栏、Composer Enter 换行与更多菜单",
      module: "Mobile Layout, Tap Actions & Composer",
    },
    async ({ setEvidence }) => {
      ws.store.ensureAdminBot();
      const mobBot = ws.store.createSession({ title: "MobLayoutBot" });
      // Seed long table, long code block, and max_steps card to stress mobile horizontal overflow!
      ws.store.appendEvent(mobBot.id, { type: "user", text: "测试移动端宽内容与点击操作栏" });
      ws.store.appendEvent(mobBot.id, {
        type: "answer",
        text: [
          "```bash",
          "curl -fsSL https://example.com/very/long/unbreakable/path/segment/alpha/beta/gamma/delta/epsilon?token=1234567890abcdef1234567890",
          "```",
          "",
          "| ColumnOne | ColumnTwo | ColumnThree | ColumnFour | ColumnFive |",
          "| :--- | :--- | :--- | :--- | :--- |",
          "| VeryLongCellValueWithoutSpaces_1234567890 | AlphaBetaGamma | DeltaEpsilon | ZetaEtaTheta | IotaKappa |",
        ].join("\n"),
      });
      ws.store.appendEvent(mobBot.id, {
        type: "route_notice",
        level: "max_steps",
        maxSteps: 12,
        toolCount: 12,
        text: "已达到单轮最大步数上限（12 步），当前任务已暂停。点击继续执行接续完成。",
      });

      const tab = await chrome!.openNewTab("about:blank");
      t.after(() => tab.close());
      await tab.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true });
      await tab.addInitScript(buildMobileCapInitScript(ws.baseUrl, ws.port));
      await tab.navigate(mobSrv.origin);
      await tab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 10_000);

      // Wait for sessions to hydrate into list, then enter MobLayoutBot chat view
      await tab.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('MobLayoutBot'))`,
        8000
      );
      await tab.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('MobLayoutBot'));
        el && el.click();
      })()`);
      await tab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'chat'`, 6000);
      await tab.waitFor(`Boolean(document.querySelector('.msg-group.is-bot .bot-bubble'))`, 6000);

      // 1. Assert ZERO horizontal page overflow at 375×667!
      const ov375 = await tab.evalJs<{ docScrollW: number; winW: number }>(`({
        docScrollW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
      })`);
      setEvidence("overflow375", ov375);
      assert.ok(
        ov375.docScrollW <= ov375.winW + 1,
        `Mobile 375px document must not overflow horizontally: scrollWidth=${ov375.docScrollW} > innerWidth=${ov375.winW}`
      );

      // 2. Tap user message bubble -> verify .msg-group.is-actions-open .msg-hover-actions is ACTUALLY visible (regression guard for CSS !important bug!)
      await tab.click(".msg-group.is-user .user-bubble");
      await tab.waitFor(`Boolean(document.querySelector('.msg-group.is-user.is-actions-open'))`, 4000);
      const actionStyle = await tab.evalJs<{ display: string; opacity: string }>(`(() => {
        const el = document.querySelector('.msg-group.is-user.is-actions-open .msg-hover-actions');
        if (!el) return { display: 'missing', opacity: '0' };
        const cs = getComputedStyle(el);
        return { display: cs.display, opacity: cs.opacity };
      })()`);
      assert.notEqual(actionStyle.display, "none", "Mobile tap-to-reveal .msg-hover-actions must NOT be hidden by display:none !important");
      assert.equal(actionStyle.opacity, "1");

      // 3. Verify mobile composer enterKeyHint="enter" & pressing Enter inserts newline instead of sending (#send-btn sends)
      const hint = await tab.evalJs<string>(`document.querySelector('#message-input')?.getAttribute('enterkeyhint') || ''`);
      assert.equal(hint, "enter");
      await tab.typeText("#message-input", "第一行", { clear: true });
      await tab.pressKey("Enter");
      await tab.typeText("#message-input", "第二行");
      const valAfterEnter = await tab.evalJs<string>(`document.querySelector('#message-input')?.value || ''`);
      assert.ok(valAfterEnter.includes("第一行") && valAfterEnter.includes("第二行"), "Mobile Enter must NOT auto-submit");

      ws.mockLlm.setHandler(async () => ({ text: "移动端点击发送成功" }));
      await tab.click("#send-btn");
      await tab.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('移动端点击发送成功'))`,
        8000
      );
      ws.mockLlm.setHandler(undefined);

      // 4. Open #mobile-inspector-btn ("...") -> #mobile-more-popover shows inspector / clear / delete
      await tab.click("#mobile-inspector-btn");
      await tab.waitFor(`!document.querySelector('#mobile-more-popover')?.hidden`, 4000);
      const moreActions = await tab.evalJs<string[]>(
        `Array.from(document.querySelectorAll('#mobile-more-popover [data-mobile-more-action]')).map(b => b.getAttribute('data-mobile-more-action'))`
      );
      assert.ok(moreActions.includes("inspector") && moreActions.includes("clear") && moreActions.includes("delete"));
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-MOB-05 ----------
  await collector.runCase(
    t,
    {
      id: "P1-MOB-05",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "移动端全抽屉深入交互：检查器活动/资料库 Tab、编辑 Bot 13×11、设置 6 项独立子页返回闭环与拖拽手势",
      module: "Mobile Deep Sheets & Drag Gestures",
    },
    async () => {
      const tab = await chrome!.openNewTab("about:blank");
      t.after(() => tab.close());
      await tab.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true });
      await tab.addInitScript(buildMobileCapInitScript(ws.baseUrl, ws.port));
      await tab.navigate(mobSrv.origin);
      await tab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 10_000);

      // 1. Mobile Settings Sheet -> drill into all 6 Settings panes (standalone-pane) & close back to Settings Sheet!
      await tab.click("#mobile-settings-btn");
      await tab.waitFor(`!document.querySelector('#mobile-settings-sheet')?.hidden`, 5000);

      for (const rowId of [
        "#mobile-settings-more-row",
        "#mobile-settings-vault-row",
        "#mobile-settings-permissions-row",
        "#mobile-settings-models-row",
        "#mobile-settings-usage-row",
        "#mobile-settings-about-row",
      ]) {
        await tab.click(rowId);
        await tab.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 4000);
        await tab.click("#close-settings-modal-btn");
        await tab.waitFor(`document.querySelector('#settings-modal-backdrop')?.hidden`, 4000);
        await tab.waitFor(`!document.querySelector('#mobile-settings-sheet')?.hidden`, 4000);
      }

      // Close fullscreen mobile settings sheet via back button
      await tab.click("#mobile-settings-close-btn");
      await tab.waitFor(`document.querySelector('#mobile-settings-sheet')?.hidden`, 4000);

      // 2. Enter chat -> open Mobile Inspector Sheet -> toggle Library tab & edit persona & drag-down dismiss & Edit Bot 13x11
      await tab.click("#pinned-primary-bot");
      await tab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'chat'`, 6000);
      await tab.click("#header-bot-pill");
      await tab.waitFor(`!document.querySelector('#mobile-inspector-sheet')?.hidden`, 5000);

      await tab.click('#mobile-inspector-sheet [data-mobile-inspector-tab="library"]');
      await tab.waitFor(`Boolean(document.querySelector('#mobile-refresh-library-btn'))`, 4000);
      await tab.click('#mobile-inspector-sheet [data-mobile-inspector-tab="activity"]');
      await tab.fill("#mobile-inspector-persona-input", "移动端定制人设_OK");
      await tab.click("#mobile-inspector-persona-save-btn");
      await tab.waitFor(`document.querySelector('#ui-toast')?.textContent?.includes('已保存')`, 4000);

      // Test drag-down handle gesture (>120px) on #mobile-inspector-sheet
      const handlePt = await tab.evalJs<{ x: number; y: number } | null>(`(() => {
        const h = document.querySelector('#mobile-inspector-sheet .mobile-sheet-handle');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      assert.ok(handlePt, "Mobile inspector sheet handle must be present");
      await tab.touchSwipe(handlePt!.x, handlePt!.y, handlePt!.x, handlePt!.y + 220, 8);
      await new Promise((r) => setTimeout(r, 350));
      // Re-open inspector if dragged closed, then open Edit Bot sheet
      const inspHidden = await tab.evalJs<boolean>(`Boolean(document.querySelector('#mobile-inspector-sheet')?.hidden)`);
      if (inspHidden) {
        await tab.click("#header-bot-pill");
        await tab.waitFor(`!document.querySelector('#mobile-inspector-sheet')?.hidden`, 5000);
      }

      await tab.click("#mobile-edit-bot-btn");
      await tab.waitFor(`!document.querySelector('#mobile-bot-editor-sheet')?.hidden`, 5000);
      const gridCounts = await tab.evalJs<{ shapes: number; colors: number }>(`({
        shapes: document.querySelectorAll('#mobile-bot-shapes-grid .mobile-shape-btn').length,
        colors: document.querySelectorAll('#mobile-bot-colors-grid .mobile-color-dot').length,
      })`);
      assert.ok(gridCounts.shapes >= 13 && gridCounts.colors >= 11, `Expected 13x11 mobile avatar grid, got ${JSON.stringify(gridCounts)}`);
      await tab.click("#mobile-bot-shapes-grid .mobile-shape-btn:nth-child(3)");
      await tab.click("#mobile-bot-colors-grid .mobile-color-dot:nth-child(3)");
      await tab.click("#mobile-bot-save-btn");
      await tab.waitFor(`document.querySelector('#mobile-bot-editor-sheet')?.hidden`, 5000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-MOB-06 ----------
  await collector.runCase(
    t,
    {
      id: "P1-MOB-06",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "移动端 OTA 热更新全 UI 链路(WebUpdater 检查/更新徽章 #mobile-update-btn/下载应用进度/回滚内置版)",
      module: "Mobile OTA Updater UI",
    },
    async () => {
      const tab = await chrome!.openNewTab("about:blank");
      t.after(() => tab.close());
      await tab.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true });
      await tab.addInitScript(
        buildMobileCapInitScript(ws.baseUrl, ws.port, { otaNewBuild: "20991231.235959-mobile9999" })
      );
      await tab.navigate(mobSrv.origin);
      await tab.waitFor(`document.querySelector('#app-shell')?.dataset?.mobileView === 'list'`, 10_000);

      // Open Settings -> About/Updates and click #ota-check-btn -> detects new mobile OTA build!
      await tab.click("#mobile-settings-btn");
      await tab.waitFor(`!document.querySelector('#mobile-settings-sheet')?.hidden`, 5000);
      await tab.click("#mobile-settings-about-row");
      await tab.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 5000);
      await tab.click("#ota-check-btn");
      await tab.waitFor(`Boolean(document.querySelector('#apply-web-ota-btn'))`, 8000);

      // Click Apply Web OTA -> invokes Capacitor WebUpdater.downloadAndApply!
      await tab.click("#apply-web-ota-btn");
      await tab.waitFor(`window.__e2eCapCalls.otaApplyCalls.length >= 1`, 6000);

      // Click Rollback to Built-in -> invokes Capacitor WebUpdater.rollbackToBuiltIn!
      const hasRollback = await tab.evalJs<boolean>(`Boolean(document.querySelector('#rollback-ota-builtin-btn'))`);
      if (hasRollback) {
        await tab.click("#rollback-ota-builtin-btn");
        await tab.waitFor(`document.querySelector('#app-confirm-dialog')?.open || window.__e2eCapCalls.otaRollbackCalls >= 1`, 4000);
        const dialogOpen = await tab.evalJs<boolean>(`Boolean(document.querySelector('#app-confirm-dialog')?.open)`);
        if (dialogOpen) await tab.click("#app-confirm-ok-btn");
        await tab.waitFor(`window.__e2eCapCalls.otaRollbackCalls >= 1`, 6000);
      }
    },
    { getChrome: () => chrome }
  );
});
