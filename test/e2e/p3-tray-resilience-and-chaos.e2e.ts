import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchWeb, fetchWebPage } from "../../src/lib/web-search.js";
import {
  buildMacOrbExecutorDeployScript,
  probeBotComputerState,
} from "../../src/lib/bot-computer-provisioner.js";
import { updateBotComputer } from "../../src/lib/bot-computer-updater.js";
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

test("P3 Suite 11: Electron Tray UI, Agent Resilience, WebSearch/Headers, Provisioner/Updater & Chaos Security Redteam", async (t) => {
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
      title: "Electron 托盘 UI(electron/tray.html)实时状态推送/全按钮交互 + 全部 8 项原生菜单指令联动渲染层",
      module: "Electron Tray & Menu Commands",
    },
    async () => {
      // 1. Load real electron/tray.html with exact twinklebotTray preload contract (onStateUpdate, NOT onState!)
      const trayTab = await chrome!.openNewTab("about:blank");
      t.after(() => trayTab.close());
      await trayTab.addInitScript(`
        window.__trayActions = [];
        window.__trayBgValues = [];
        window.__trayCopied = [];
        window.__trayStateCb = null;
        window.twinklebotTray = {
          getState: async () => ({
            appVersion: '1.0.1',
            backendUrl: 'http://127.0.0.1:3230',
            port: 3230,
            botCount: 5,
            groupCount: 2,
            scheduleCount: 3,
            activeRunCount: 0,
            windowVisible: true,
            keepRunningInBackground: true,
            relayConfigured: false,
          }),
          onStateUpdate: (cb) => { window.__trayStateCb = cb; return () => {}; },
          runAction: async (action) => { window.__trayActions.push(action); },
          setKeepInBackground: async (val) => { window.__trayBgValues.push(val); return { keepRunningInBackground: val }; },
          copyText: async (text) => { window.__trayCopied.push(text); },
          quitApp: async () => { window.__trayActions.push('quit'); },
        };
      `);
      const trayUrl = `file://${path.join(PROJECT_ROOT, "electron", "tray.html")}`;
      await trayTab.navigate(trayUrl);
      await trayTab.waitFor(`document.body.innerText.includes('1.0.1') && document.body.innerText.includes(':3230')`, 5000);
      assert.equal(await trayTab.evalJs<string>(`document.querySelector('#bot-count-val')?.textContent?.trim()`), "5 个");
      assert.equal(await trayTab.evalJs<string>(`document.querySelector('#schedule-count-val')?.textContent?.trim()`), "3 个");

      // Push live state update via onStateUpdate -> busy badge + hidden window + relay footer!
      await trayTab.evalJs(`window.__trayStateCb({
        appVersion: '1.0.1', backendUrl: 'http://127.0.0.1:3230', port: 3230,
        botCount: 7, groupCount: 2, scheduleCount: 4, activeRunCount: 2,
        windowVisible: false, keepRunningInBackground: true, relayConfigured: true
      })`);
      await trayTab.waitFor(`document.querySelector('#status-pill')?.classList.contains('is-busy')`, 3000);
      assert.match(await trayTab.evalJs<string>(`document.querySelector('#status-text')?.textContent || ''`), /2 个执行中/);
      assert.match(await trayTab.evalJs<string>(`document.querySelector('#footer-hint')?.textContent || ''`), /外网中继/);

      // Exercise EVERY tray button: #open-window-btn, #copy-endpoint-btn, all 4 [data-action], #keep-bg-toggle, #quit-app-btn!
      await trayTab.click("#open-window-btn");
      await trayTab.click("#copy-endpoint-btn");
      await trayTab.waitFor(`document.querySelector('#endpoint-label')?.textContent?.includes('已复制')`, 3000);
      await trayTab.evalJs(`document.querySelectorAll('[data-action]').forEach(btn => btn.click())`);
      await trayTab.evalJs(`document.querySelector('#keep-bg-toggle').click()`);
      await trayTab.click("#quit-app-btn");

      const trayOut = await trayTab.evalJs<{ actions: string[]; bg: boolean[]; copied: string[] }>(`({
        actions: window.__trayActions,
        bg: window.__trayBgValues,
        copied: window.__trayCopied,
      })`);
      for (const expected of ["show-window", "new-bot", "open-search", "open-settings", "open-browser", "quit"]) {
        assert.ok(trayOut.actions.includes(expected), `Tray must dispatch '${expected}', got ${trayOut.actions.join(",")}`);
      }
      assert.deepEqual(trayOut.bg, [false]);
      assert.deepEqual(trayOut.copied, ["http://127.0.0.1:3230"]);

      // 2. Test ALL 8 Electron menu commands dispatched into main web app with exact preload contract (loadAccounts/saveAccounts)!
      const menuTab = await chrome!.openNewTab("about:blank");
      t.after(() => menuTab.close());
      await menuTab.addInitScript(`
        window.__menuCb = null;
        window.twinklebotDesktop = {
          isElectron: true,
          platform: 'darwin',
          arch: 'arm64',
          getDesktopInfo: async () => ({ platform: 'darwin', appVersion: '1.0.1', backendUrl: ${JSON.stringify(ws.baseUrl)} }),
          loadAccounts: async () => ({ activeAccountId: 'local', accounts: [{ id: 'local', type: 'local', name: '本地账号', baseUrl: '' }] }),
          saveAccounts: async (s) => s,
          onMenuCommand: (cb) => { window.__menuCb = cb; return () => {}; },
          onOtaProgress: () => () => {},
          getOtaStatus: async () => ({ usingBuiltIn: true, activeBuild: 'built-in' }),
          confirmWebOta: async () => ({ ok: true }),
        };
      `);
      await menuTab.navigate(ws.baseUrl);
      await menuTab.waitFor(`typeof window.__menuCb === 'function'`, 8000);

      // 1) open-search
      await menuTab.evalJs(`window.__menuCb('open-search', {})`);
      await menuTab.waitFor(`!document.querySelector('#search-modal-backdrop')?.hidden`, 4000);
      await menuTab.pressKey("Escape");
      // 2) open-settings
      await menuTab.evalJs(`window.__menuCb('open-settings', { tab: 'vault' })`);
      await menuTab.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 4000);
      await menuTab.pressKey("Escape");
      // 3) toggle-compact-sidebar
      await menuTab.evalJs(`window.__menuCb('toggle-compact-sidebar', {})`);
      await menuTab.waitFor(`document.querySelector('#app-shell')?.dataset?.sidebarCompact === 'true'`, 4000);
      await menuTab.evalJs(`window.__menuCb('toggle-compact-sidebar', {})`);
      // 4) toggle-inspector
      const prevInsp = await menuTab.evalJs<string>(`document.querySelector('#app-shell')?.dataset?.inspectorOpen`);
      await menuTab.evalJs(`window.__menuCb('toggle-inspector', {})`);
      await menuTab.waitFor(`document.querySelector('#app-shell')?.dataset?.inspectorOpen !== '${prevInsp}'`, 4000);
      // 5) new-bot & 6) new-group
      await menuTab.evalJs(`window.__menuCb('new-bot', {})`);
      await menuTab.waitFor(`!document.querySelector('#new-chat-bar')?.hidden`, 4000);
      await menuTab.evalJs(`window.__menuCb('new-group', {})`);
      await menuTab.waitFor(`!document.querySelector('#new-chat-bar')?.hidden`, 4000);
      await menuTab.pressKey("Escape");
      // 7) open-computer
      await menuTab.evalJs(`window.__menuCb('open-computer', {})`);
      await menuTab.waitFor(`!document.querySelector('#bot-screen-overlay')?.hidden`, 4000);
      await menuTab.click("#exit-fullscreen-btn");
      // 8) set-theme
      await menuTab.evalJs(`window.__menuCb('set-theme', { theme: 'dark' })`);
      await menuTab.waitFor(`localStorage.getItem('color-scheme') === 'dark'`, 4000);
      await menuTab.evalJs(`window.__menuCb('set-theme', { theme: 'system' })`);
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
      title: "Agent 死循环重复检测告警(repeatCount>=2)、finishReason='length' 截断工具拦截重试、markInterrupted 与孤立调用清洗",
      module: "Agent Loop Resilience",
    },
    async () => {
      const resBot = ws.store.createSession({ title: "ResilienceBot" });
      ws.store.updateSession(resBot.id, { status: "running" });
      ws.store.markInterrupted();
      assert.equal(ws.store.getSession(resBot.id)?.status, "interrupted", "markInterrupted must recover stranded running state");

      ws.store.saveHistory(resBot.id, [
        { type: "user_input", content: [{ type: "text", text: "old" }] },
        { type: "function_call", id: "orphan-999", name: "run_shell", arguments: { command: "pwd" } },
      ]);

      let callIdx = 0;
      let shellExecCount = 0;
      let sawRepeatWarning = false;
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
          if (s.includes("route_plan") || s.includes("base_tier") || s.includes("needs_visual")) {
            return { text: JSON.stringify({ category: "general", complexity: "simple", needs_visual: false, open_with_deep_steps: 0 }) };
          }
          if (s.includes("重复") || s.includes("repeat") || s.includes("loop") || s.includes("identical")) {
            sawRepeatWarning = true;
          }
          callIdx += 1;
          if (callIdx === 1) {
            assert.ok(!s.includes("orphan-999"), "Orphaned function_call must be sanitized before reaching model");
            return {
              finishReason: "length",
              toolCalls: [{ id: "trunc-1", name: "run_shell", args: { command: "echo TRUNCATED_CMD", risk: "low" } }],
            };
          }
          // Repeat identical action 3 times in a row to trigger dead-loop repeat detector!
          if (callIdx >= 2 && callIdx <= 4) {
            return {
              toolCalls: [{ id: `rep-${callIdx}`, name: "list_bots", args: {} }],
            };
          }
          return { text: "截断拦截与死循环告警自愈完成" };
        });

        await fetch(`${ws.baseUrl}/api/sessions/${resBot.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "测试截断保护与死循环检测" }),
        });
        await ws.waitUntil(() => !ws.runner.isSessionBusy(resBot.id), 12_000, "resilience turn finishes");
        assert.equal(shellExecCount, 0, "Tool call on finish_reason=length MUST NOT execute");
        assert.equal(sawRepeatWarning, true, "Repeated identical tool calls must inject dead-loop warning");
        const evs = ws.store.readEvents(resBot.id);
        assert.ok(evs.some((e: any) => e.type === "answer" && /截断拦截与死循环告警自愈完成/.test(e.text || "")));
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
      title: "web_search(DDG→Bing 回退)、web_fetch 正文抽取、workspace_search / library_manage 及 /api/workspace/file(.html/.svg/download)安全响应头",
      module: "Built-in Tools & Security Headers",
    },
    async () => {
      // 1. DDG 503 -> automatic fallback to Bing
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

      // 2. Public web_fetch HTML extraction (with injected fetchImpl)
      const fetched = await fetchWebPage("https://example.org/article", {
        fetchImpl: async () =>
          new Response(
            `<!doctype html><html><head><title>Article Title</title></head><body><script>bad()</script><main><p>TwinkleBot clean text extraction.</p></main></body></html>`,
            { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
          ),
      });
      assert.equal(fetched.ok, true);
      assert.match(String(fetched.content || ""), /TwinkleBot clean text extraction/);
      assert.ok(!String(fetched.content || "").includes("bad()"));

      // 3. /api/workspace/file security headers for inline .html, .svg AND ?download=1!
      const htmlPath = path.join(ws.workspaceDir, "preview-sec.html");
      const svgPath = path.join(ws.workspaceDir, "preview-sec.svg");
      fs.writeFileSync(htmlPath, "<html><body><script>alert(1)</script></body></html>", "utf8");
      fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, "utf8");

      const inlineRes = await fetch(`${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(htmlPath)}`);
      assert.equal(inlineRes.status, 200);
      assert.equal(inlineRes.headers.get("x-content-type-options"), "nosniff");
      assert.match(inlineRes.headers.get("content-security-policy") || "", /sandbox/);

      const svgRes = await fetch(`${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(svgPath)}`);
      assert.equal(svgRes.status, 200);
      assert.equal(svgRes.headers.get("x-content-type-options"), "nosniff");
      assert.match(svgRes.headers.get("content-security-policy") || "", /sandbox/);

      const dlRes = await fetch(`${ws.baseUrl}/api/workspace/file?path=${encodeURIComponent(htmlPath)}&download=1`);
      assert.equal(dlRes.status, 200);
      assert.match(dlRes.headers.get("content-disposition") || "", /attachment/i);
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
      title: "认证红队：配对码 5 次输错销毁锁定 403、已配对设备吊销即时 401 与非 GCP 伪造 Vertex 强制阻断",
      module: "Auth Redteam & Vertex Gate",
    },
    async () => {
      const lanIp = findLocalLanIpv4();
      assert.ok(lanIp && lanIp !== "127.0.0.1");
      const lanOrigin = `http://${lanIp}:${ws.port}`;

      // 1. 5 failed pairing attempts destroy challenge and return 403/404
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

      // 2. Real paired device -> works (200) -> DELETE /api/lan/devices/:id -> immediate 401!
      await chrome!.navigate(ws.baseUrl);
      await chrome!.waitFor(
        `document.querySelector('#account-usage-pct')?.textContent?.includes('tok') &&
         document.documentElement.dataset.realtimeConnected === '1'`,
        8000
      );
      const pr2: any = await (
        await fetch(`${lanOrigin}/api/lan/pair/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceName: "RevokePhone", platform: "ios" }),
        })
      ).json();
      await chrome!.waitFor(`!document.querySelector('#desktop-pairing-modal')?.hidden`, 5000);
      const code = await chrome!.evalJs<string>(
        `document.querySelector('#desktop-pairing-code-display')?.textContent?.trim() || ''`
      );
      assert.match(code, /^\d{6}$/, "Desktop pairing modal must display 6-digit PIN");
      const v2: any = await (
        await fetch(`${lanOrigin}/api/lan/pair/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairingId: pr2.pairingId, code }),
        })
      ).json();
      assert.ok(v2.deviceToken);
      assert.equal((await fetch(`${lanOrigin}/api/sessions`, { headers: { Authorization: `Bearer ${v2.deviceToken}` } })).status, 200);
      const devs: any = await (await fetch(`${ws.baseUrl}/api/lan/devices`)).json();
      const devEntry = (devs.devices || []).find((d: any) => d.name === "RevokePhone" || d.deviceName === "RevokePhone");
      assert.ok(devEntry?.id);
      assert.equal((await fetch(`${ws.baseUrl}/api/lan/devices/${encodeURIComponent(devEntry.id)}`, { method: "DELETE" })).status, 200);
      assert.equal(
        (await fetch(`${lanOrigin}/api/sessions`, { headers: { Authorization: `Bearer ${v2.deviceToken}` } })).status,
        401,
        "Revoked LAN device token must immediately fail with 401"
      );

      // 3. Non-GCP Vertex spoofing must be blocked with blockedVertexReason!
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
      title: "存储损坏容错(.ndjson 混入半截非法行跳过不丢数据) + 超大 JSON 请求体拦截返回 413",
      module: "Storage Resilience & Body Limits",
    },
    async () => {
      const corruptBot = ws.store.createSession({ title: "CorruptNdjsonBot" });
      ws.store.appendEvent(corruptBot.id, { type: "user", text: "valid-before" });
      const ndjsonPath = path.join(ws.dataDir, "sessions", `${corruptBot.id}.ndjson`);
      fs.appendFileSync(ndjsonPath, `{"seq":999,"broken_json":\n`, "utf8");
      const appended = ws.store.appendEvent(corruptBot.id, { type: "answer", text: "valid-after" });
      const evs = ws.store.readEvents(corruptBot.id);
      assert.equal(evs.length, 2, "Corrupted NDJSON line must be skipped cleanly");
      assert.equal(evs[0].text, "valid-before");
      assert.equal(evs[1].text, "valid-after");
      assert.ok(appended.seq > evs[0].seq);

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
      title: "WebSocket 强制断线自动重连并无损追平断线期间产生的新消息",
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

  // ---------- P3-CHAOS-05 ----------
  await collector.runCase(
    t,
    {
      id: "P3-CHAOS-05",
      priority: "P3",
      featureTier: "F3",
      difficulty: "D2",
      title: "Bot 电脑环境探针与一键热更新状态机(probeBotComputerState / buildMacOrbExecutorDeployScript / updateBotComputer)",
      module: "Bot Computer Provisioner & Updater",
    },
    async () => {
      // 1. probeBotComputerState across cloud, linux(unsupported), creating, darwin ready, darwin 401 unauthorized, win32 uncreated
      const cloudRes = await probeBotComputerState({ deployEnv: "cloud", platform: "linux" });
      assert.equal(cloudRes.state, "ready");
      assert.equal(cloudRes.provider, "cloud-linux");

      const linuxRes = await probeBotComputerState({ deployEnv: "local", platform: "linux" });
      assert.equal(linuxRes.state, "unsupported");
      assert.equal(linuxRes.errorCode, "unsupported");

      const creatingRes = await probeBotComputerState({
        deployEnv: "local",
        platform: "darwin",
        store: { readSettings: () => ({ botComputer: { state: "creating" } }) },
      });
      assert.equal(creatingRes.state, "creating");

      const readyRes = await probeBotComputerState({
        deployEnv: "local",
        platform: "darwin",
        executor: { health: async () => ({ ok: true, screen: { width: 1440, height: 900 } }) },
      });
      assert.equal(readyRes.state, "ready");
      assert.equal(readyRes.online, true);

      const authErrRes = await probeBotComputerState({
        deployEnv: "local",
        platform: "darwin",
        executor: {
          health: async () => {
            const e: any = new Error("unauthorized");
            e.status = 401;
            throw e;
          },
        },
        execFileFn: async () => ({ stdout: "NAME STATE\nubuntu running\n" }),
      });
      assert.equal(authErrRes.state, "error");
      assert.equal(authErrRes.errorCode, "unauthorized");

      const uncreatedWin = await probeBotComputerState({
        deployEnv: "local",
        platform: "win32",
        execFileFn: async () => ({ stdout: "" }),
      });
      assert.equal(uncreatedWin.state, "uncreated");

      // 2. buildMacOrbExecutorDeployScript includes token sync & Chrome wrapper & systemd restart
      const script = buildMacOrbExecutorDeployScript({ executorToken: "tok-e2e-xyz" });
      assert.match(script, /twinklebot-executor\.service/);
      assert.match(script, /TWINKLEBOT_EXECUTOR_TOKEN=/);

      // 3. updateBotComputer with mocked execFileFn + executor.health retry recovery (fails once then recovers!)
      const execCalls: string[] = [];
      let healthAttempts = 0;
      const updRes = await updateBotComputer({
        platform: "darwin",
        projectRoot: PROJECT_ROOT,
        executorToken: "tok-upd-123",
        execFileFn: async (cmd, args) => {
          execCalls.push(`${cmd} ${args.slice(0, 4).join(" ")}`);
          return { stdout: "ok", stderr: "" };
        },
        executor: {
          health: async () => {
            healthAttempts += 1;
            if (healthAttempts === 1) throw new Error("starting up");
            return { ok: true, screen: { width: 1440, height: 900 } };
          },
        },
        maxHealthRetries: 4,
        retryDelayMs: 20,
      });
      assert.equal(updRes.ok, true);
      assert.equal(healthAttempts, 2);
      assert.ok(execCalls.length >= 2);
    }
  );
});
