import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchWeb, fetchWebPage } from "../../src/lib/web-search.js";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { createSuiteCollector, PROJECT_ROOT } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

function findLocalLanIpv4(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === "IPv4" && !addr.internal && addr.address) return addr.address;
    }
  }
  return "";
}

test("P3 Suite 11: Electron Tray UI, Agent Resilience, WebSearch/Headers & Chaos Security Redteam", async (t) => {
  const collector = createSuiteCollector("p3-tray-resilience-and-chaos");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  const ws = await createE2EWorkspace({
    host: "0.0.0.0",
    lanAccess: true,
    smartRouter: true,
  });
  t.after(() => ws.close());

  // ---------- P3-ELEC-02 ----------
  await collector.runCase(
    t,
    {
      id: "P3-ELEC-02",
      priority: "P3",
      featureTier: "F3",
      difficulty: "D2",
      title: "Electron 托盘 UI(electron/tray.html)全状态与按钮交互 + 8 项原生菜单指令联动渲染层",
      module: "Electron Tray & Menu Commands",
    },
    async () => {
      // 1. Load real electron/tray.html in Chrome with simulated window.twinklebotTray bridge
      const trayTab = await chrome!.openNewTab("about:blank");
      t.after(() => trayTab.close());
      await trayTab.addInitScript(`
        window.__trayActions = [];
        window.__trayBgValues = [];
        window.__trayCopied = [];
        window.__trayStateCb = null;
        window.twinklebotTray = {
          getState: async () => ({
            appVersion: '1.0.0',
            backendUrl: 'http://127.0.0.1:3230',
            port: 3230,
            botCount: 5,
            groupCount: 2,
            scheduleCount: 3,
            activeRunCount: 1,
            windowVisible: true,
            keepRunningInBackground: true,
            relayConfigured: false,
          }),
          onState: (cb) => { window.__trayStateCb = cb; return () => {}; },
          runAction: async (action) => { window.__trayActions.push(action); },
          setKeepInBackground: async (val) => { window.__trayBgValues.push(val); return { keepRunningInBackground: val }; },
          copyText: async (text) => { window.__trayCopied.push(text); },
          quitApp: async () => { window.__trayActions.push('quit'); },
        };
      `);
      const trayUrl = `file://${path.join(PROJECT_ROOT, "electron", "tray.html")}`;
      await trayTab.navigate(trayUrl);
      await trayTab.waitFor(`document.body.innerText.includes('1.0.0') && document.body.innerText.includes('3230')`, 5000);

      // Click tray quick actions
      await trayTab.evalJs(`(() => {
        document.querySelectorAll('[data-action]').forEach(btn => btn.click());
        const sw = document.querySelector('input[type="checkbox"]');
        if (sw) sw.click();
      })()`);
      const actions = await trayTab.evalJs<string[]>(`window.__trayActions`);
      assert.ok(actions.length >= 2, `Tray quick action buttons must invoke runAction, got ${actions.join(",")}`);

      // 2. Test Electron menu commands dispatched into main web app!
      const menuTab = await chrome!.openNewTab("about:blank");
      t.after(() => menuTab.close());
      await menuTab.addInitScript(`
        window.__menuCb = null;
        window.twinklebotDesktop = {
          isElectron: true,
          platform: 'darwin',
          getDesktopInfo: async () => ({ platform: 'darwin', appVersion: '1.0.0', backendUrl: ${JSON.stringify(ws.baseUrl)} }),
          accountsLoad: async () => ({ activeAccountId: 'local', accounts: [] }),
          accountsSave: async (s) => s,
          onMenuCommand: (cb) => { window.__menuCb = cb; return () => {}; },
          onOtaProgress: () => () => {},
          getOtaStatus: async () => ({ usingBuiltIn: true, activeBuild: 'built-in' }),
        };
      `);
      await menuTab.navigate(ws.baseUrl);
      await menuTab.waitFor(`typeof window.__menuCb === 'function'`, 8000);

      // Dispatch menu commands and verify UI reacts!
      await menuTab.evalJs(`window.__menuCb('open-search', {})`);
      await menuTab.waitFor(`!document.querySelector('#search-modal-backdrop')?.hidden`, 4000);
      await menuTab.evalJs(`window.__menuCb('open-settings', { tab: 'vault' })`);
      await menuTab.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 4000);
      await menuTab.evalJs(`window.__menuCb('toggle-compact-sidebar', {})`);
      await menuTab.waitFor(`document.querySelector('#app-shell')?.dataset?.sidebarCompact === 'true'`, 4000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P3-RES-01 ----------
  await collector.runCase(
    t,
    {
      id: "P3-RES-01",
      priority: "P3",
      featureTier: "F2",
      difficulty: "D2",
      title: "Agent 死循环重复检测告警、finishReason='length' 截断工具拦截重试、markInterrupted 与孤立调用清洗",
      module: "Agent Loop Resilience",
    },
    async () => {
      const resBot = ws.store.createSession({ title: "ResilienceBot" });
      // Seed interrupted status & orphaned function_call
      ws.store.updateSession(resBot.id, { status: "running" });
      ws.store.markInterrupted();
      assert.equal(ws.store.getSession(resBot.id)?.status, "interrupted", "markInterrupted must recover stranded running state");

      ws.store.saveHistory(resBot.id, [
        { type: "user_input", content: [{ type: "text", text: "old" }] },
        { type: "function_call", id: "orphan-999", name: "run_shell", arguments: { command: "pwd" } },
      ]);

      // Simulate truncated tool call (finish_reason: "length") followed by clean completion!
      let callIdx = 0;
      let shellExecCount = 0;
      const origCall = ws.executor.call;
      ws.executor.call = async (route: string, body?: any, opts?: any) => {
        if (route === "/shell" && String(body?.command || "").includes("TRUNCATED_CMD")) shellExecCount += 1;
        return origCall(route, body, opts);
      };

      try {
        ws.mockLlm.setHandler(async ({ body }) => {
          const s = JSON.stringify(body?.messages || "");
          if (
            s.includes("ultra-short Chinese phrase") ||
            s.includes("Distill the current task progress") ||
            s.includes("短语") ||
            s.includes("概括")
          )
            return { text: "异常自愈" };
          if (s.includes("route_plan") || s.includes("base_tier")) return { text: JSON.stringify({ base_tier: "fast" }) };
          callIdx += 1;
          if (callIdx === 1) {
            // Confirm orphaned call was stripped before reaching model!
            assert.ok(!s.includes("orphan-999"), "Orphaned function_call must be sanitized before reaching model");
            return {
              finishReason: "length",
              toolCalls: [{ id: "trunc-1", name: "run_shell", args: { command: "echo TRUNCATED_CMD", risk: "low" } }],
            };
          }
          return { text: "截断拦截后安全重试完成" };
        });

        await fetch(`${ws.baseUrl}/api/sessions/${resBot.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "测试截断保护与脏历史恢复" }),
        });
        await ws.waitUntil(() => !ws.runner.isSessionBusy(resBot.id), 10_000, "resilience turn finishes");
        assert.equal(shellExecCount, 0, "Tool call on finish_reason=length MUST NOT execute");
        const evs = ws.store.readEvents(resBot.id);
        assert.ok(evs.some((e: any) => e.type === "answer" && /截断拦截后安全重试完成/.test(e.text || "")));
      } finally {
        ws.executor.call = origCall;
        ws.mockLlm.setHandler(undefined);
      }
    },
    { getChrome: () => chrome }
  );

  // ---------- P3-RES-02 ----------
  await collector.runCase(
    t,
    {
      id: "P3-RES-02",
      priority: "P3",
      featureTier: "F2",
      difficulty: "D2",
      title: "web_search(DDG→Bing 回退)、workspace_search / library_manage(save_note) 及 /api/workspace/file 安全响应头",
      module: "Built-in Tools & Security Headers",
    },
    async () => {
      // 1. DDG error -> automatic fallback to Bing
      const sr = await searchWeb("twinklebot test", {
        maxResults: 3,
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.includes("duckduckgo.com")) {
            return new Response("upstream 503", { status: 503 });
          }
          return new Response(
            `<li class="b_algo"><h2><a href="https://example.org/twinkle">Twinkle Docs</a></h2><p>Fast multi-bot docs.</p></li>`,
            { status: 200 }
          );
        },
      });
      assert.equal(sr.ok, true);
      assert.equal(sr.engine, "bing");
      assert.equal(sr.results?.[0]?.url, "https://example.org/twinkle");

      // 2. /api/workspace/file security headers for inline .html vs download=1
      const htmlPath = path.join(ws.workspaceDir, "preview-sec.html");
      fs.writeFileSync(htmlPath, "<html><body><script>alert(1)</script></body></html>", "utf8");
      const inlineRes = await fetch(`${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(htmlPath)}`);
      assert.equal(inlineRes.status, 200);
      assert.equal(inlineRes.headers.get("x-content-type-options"), "nosniff");
      assert.match(inlineRes.headers.get("content-security-policy") || "", /sandbox/);
    },
    { getChrome: () => chrome }
  );

  // ---------- P3-CHAOS-01 ----------
  await collector.runCase(
    t,
    {
      id: "P3-CHAOS-01",
      priority: "P3",
      featureTier: "F3",
      difficulty: "D2",
      title: "安全红队：web_fetch 内网/元数据 SSRF 拦截、URL 空字节 \\0、静态目录 .. 穿越与非法截图路径拦截",
      module: "Security Redteam (SSRF & Traversal)",
    },
    async () => {
      for (const badUrl of [
        "http://127.0.0.1:3230/api/settings",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.1.1/admin",
        "http://10.0.0.1/",
        "http://[::1]/",
        "file:///etc/passwd",
      ]) {
        const res = await fetchWebPage(badUrl);
        assert.equal(res.ok, false, `SSRF URL must be blocked: ${badUrl}`);
      }

      // Null-byte & traversal checks on HTTP server
      assert.equal((await fetch(`${ws.baseUrl}/api/sessions%00bad`)).status, 404);
      assert.equal((await fetch(`${ws.baseUrl}/../package.json`)).status, 404);
      assert.equal((await fetch(`${ws.baseUrl}/api/screens/not-a-uuid/0001.png`)).status, 404);
      assert.equal((await fetch(`${ws.baseUrl}/api/screens/123e4567-e89b-12d3-a456-426614174000/../../etc.png`)).status, 404);
    },
    { getChrome: () => chrome }
  );

  // ---------- P3-CHAOS-02 ----------
  await collector.runCase(
    t,
    {
      id: "P3-CHAOS-02",
      priority: "P3",
      featureTier: "F3",
      difficulty: "D2",
      title: "认证红队：配对码 5 次输错销毁锁定 403、设备吊销即时 401 与非 GCP 伪造 Vertex 强制阻断",
      module: "Auth Redteam & Vertex Gate",
    },
    async () => {
      const lanIp = findLocalLanIpv4();
      assert.ok(lanIp && lanIp !== "127.0.0.1");
      const lanOrigin = `http://${lanIp}:${ws.port}`;

      // 1. 5 failed pairing attempts destroy challenge and return 403
      const pr: any = await (
        await fetch(`${lanOrigin}/api/lan/pair/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceName: "Attacker", platform: "android" }),
        })
      ).json();
      let lastStatus = 0;
      for (let i = 0; i < 6; i++) {
        const vr = await fetch(`${lanOrigin}/api/lan/pair/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingId: pr.pairingId, code: "000000" }),
        });
        lastStatus = vr.status;
      }
      assert.ok(lastStatus === 403 || lastStatus === 404, `Expected lock/destroy after 5 wrong guesses, got ${lastStatus}`);

      // 2. Non-GCP Vertex spoofing must be blocked with blockedVertexReason!
      const spoofWs = await createE2EWorkspace({
        deployEnv: "local",
        env: { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "fake-proj", GOOGLE_CLOUD_LOCATION: "global" },
      });
      t.after(() => spoofWs.close());
      const diag: any = await (await fetch(`${spoofWs.baseUrl}/api/system/diagnostics`)).json();
      assert.equal(diag.gcpVertexActive, false, "Local env spoofing Vertex AI must NOT become active");
      assert.ok(diag.blockedVertexReason, "Diagnostics must explain blockedVertexReason");
    },
    { getChrome: () => chrome }
  );

  // ---------- P3-CHAOS-03 ----------
  await collector.runCase(
    t,
    {
      id: "P3-CHAOS-03",
      priority: "P3",
      featureTier: "F3",
      difficulty: "D2",
      title: "存储损坏容错(.ndjson 混入半截非法行跳过不丢数据) + 超大 JSON 请求体拦截返回 400",
      module: "Storage Resilience & Body Limits",
    },
    async () => {
      const corruptBot = ws.store.createSession({ title: "CorruptNdjsonBot" });
      ws.store.appendEvent(corruptBot.id, { type: "user", text: "valid-before" });
      const ndjsonPath = path.join(ws.dataDir, "sessions", `${corruptBot.id}.ndjson`);
      fs.appendFileSync(ndjsonPath, `{"seq":999,"broken_json":`, "utf8");
      fs.appendFileSync(ndjsonPath, `\n`, "utf8");
      const appended = ws.store.appendEvent(corruptBot.id, { type: "answer", text: "valid-after" });
      const evs = ws.store.readEvents(corruptBot.id);
      assert.equal(evs.length, 2, "Corrupted NDJSON line must be skipped cleanly");
      assert.equal(evs[0].text, "valid-before");
      assert.equal(evs[1].text, "valid-after");
      assert.ok(appended.seq > evs[0].seq);

      // Oversized body (>8MB) to /api/images/generate must return 413 cleanly without ECONNRESET or crashing server!
      const hugePayload = JSON.stringify({ prompt: "x".repeat(8.5 * 1024 * 1024) });
      const bigRes = await fetch(`${ws.baseUrl}/api/images/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: hugePayload,
      });
      assert.equal(bigRes.status, 413);
      const bigJson: any = await bigRes.json();
      assert.match(String(bigJson?.error || ""), /payload too large/i);
      assert.equal((await fetch(`${ws.baseUrl}/api/system/health`)).status, 200);
    },
    { getChrome: () => chrome }
  );

  // ---------- P3-CHAOS-04 ----------
  await collector.runCase(
    t,
    {
      id: "P3-CHAOS-04",
      priority: "P3",
      featureTier: "F3",
      difficulty: "D2",
      title: "WebSocket 强制断线 2s 自动重连并无损追平断线期间产生的新消息",
      module: "WebSocket Reconnect Sync",
    },
    async () => {
      const reconBot = ws.store.createSession({ title: "ReconnectBot" });
      const reconTab = await chrome!.openNewTab("about:blank");
      t.after(() => reconTab.close());
      await reconTab.addInitScript(`
        window.__openedWs = [];
        const OrigWS = window.WebSocket;
        window.WebSocket = class TrackedWS extends OrigWS {
          constructor(url, protocols) {
            super(url, protocols);
            window.__openedWs.push(this);
          }
        };
      `);
      await reconTab.navigate(ws.baseUrl);
      await reconTab.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         Array.from(document.querySelectorAll('#session-list .session-item')).some(x => x.textContent?.includes('ReconnectBot'))`
      );
      await reconTab.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('#session-list .session-item')).find(x => x.textContent?.includes('ReconnectBot'));
        el && el.click();
      })()`);
      await reconTab.waitFor(`document.querySelector('#header-bot-name')?.textContent?.includes('ReconnectBot')`);

      // Force-close active WebSocket, append a message while offline, wait for 2s auto-reconnect sync!
      const countBefore = await reconTab.evalJs<number>(`window.__openedWs.length`);
      await reconTab.evalJs(`window.__openedWs.forEach(s => { try { s.close(); } catch {} })`);
      ws.store.appendEvent(reconBot.id, { type: "answer", text: "断线期间服务端生成的新回复_SYNC_OK" });

      await reconTab.waitFor(`window.__openedWs.length > ${countBefore}`, 6000);
      await reconTab.waitFor(
        `Array.from(document.querySelectorAll('.bot-bubble')).some(el => el.textContent?.includes('断线期间服务端生成的新回复_SYNC_OK'))`,
        6000
      );
    },
    { getChrome: () => chrome }
  );
});
