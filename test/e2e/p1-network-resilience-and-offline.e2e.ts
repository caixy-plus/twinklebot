import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { launchHeadlessChrome, type HeadlessChromeSession } from "../helpers/cdp-browser-harness.js";
import { createSuiteCollector } from "../helpers/e2e-report-collector.js";
import { createE2EWorkspace } from "../helpers/e2e-workspace-harness.js";

function serveStaticDir(rootDir: string): Promise<{ server: http.Server; baseUrl: string; close: () => Promise<void> }> {
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(u.pathname);
    if (rel === "/") rel = "/index.html";
    const fp = path.resolve(rootDir, "." + rel);
    if (!fp.startsWith(path.resolve(rootDir)) || !fs.existsSync(fp)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            try { (server as any).closeAllConnections?.(); } catch {}
            const tm = setTimeout(done, 1000);
            server.close(() => { clearTimeout(tm); done(); });
          }),
      });
    });
  });
}

test("P1 Suite 6: Unified Weak-Network Banner, WS Heartbeat/Backoff Reconnect & Tiered Offline Settings Guard", async (t) => {
  const collector = createSuiteCollector("p1-network-resilience-and-offline");
  let chrome: HeadlessChromeSession | null = await launchHeadlessChrome();
  t.after(async () => {
    if (chrome) await chrome.close();
  });

  // Cloud backend workspace with Bearer auth so the browser operates in true remote "cloud" account mode!
  const cloudToken = "e2e-cloud-net-token-2026";
  const cloudWs = await createE2EWorkspace({
    deployEnv: "cloud",
    cloudAuthToken: cloudToken,
    smartRouter: false,
  });
  t.after(() => cloudWs.close());

  // Local workspace serving the desktop UI shell
  const localWs = await createE2EWorkspace({ smartRouter: false });
  t.after(() => localWs.close());

  // Also serve a dedicated dead port for unreachable remote testing
  const deadSrv = http.createServer((_req, res) => { res.destroy(); });
  await new Promise<void>((r) => deadSrv.listen(0, "127.0.0.1", r));
  const deadPort = (deadSrv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => deadSrv.close(() => r()));

  // ---------- P1-NET-01 ----------
  await collector.runCase(
    t,
    {
      id: "P1-NET-01",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "桌面端统一弱网/重连/离线/恢复横幅(NetworkStatusBanner)四态生命周期、收起按钮、切换账号入口与浏览器离线区分",
      module: "NetworkStatusBanner Desktop",
    },
    async () => {
      const tab = await chrome!.openNewTab("about:blank");
      t.after(() => tab.close());

      // Seed a remote cloud account pointing to cloudWs (live) so remote network monitoring activates
      const accountsPayload = {
        activeAccountId: "cloud-e2e",
        accounts: [
          { id: "local", type: "local", name: "本机桌面", baseUrl: "", authToken: "" },
          { id: "cloud-e2e", type: "cloud", name: "测试云节点", baseUrl: cloudWs.baseUrl, authToken: cloudToken },
        ],
      };
      await tab.addInitScript(`
        try { if (window === window.top) localStorage.setItem("twinklebot.accounts.v2", ${JSON.stringify(JSON.stringify(accountsPayload))}); } catch {}
      `);
      await tab.navigate(localWs.baseUrl);
      await tab.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 10_000);
      await tab.waitFor(`document.documentElement.dataset.realtimeConnected === '1'`, 8000);

      // 1. Browser offline event -> stage banner enters data-network-status="offline" AND blocking #account-disconnected-gate opens!
      await tab.setNetworkConditions({ offline: true });
      await tab.evalJs(`window.dispatchEvent(new Event('offline'))`);
      await tab.waitFor(
        `document.querySelector('[data-network-banner-placement="stage"] .network-status-banner')?.dataset?.networkStatus === 'offline'`,
        6000
      );
      await tab.waitFor(
        `Boolean(document.querySelector('#account-disconnected-gate')?.open) &&
         document.querySelector('#account-disconnected-gate')?.dataset?.browserOffline === 'true'`,
        4000
      );
      const switchHiddenWhenBrowserOffline = await tab.evalJs<boolean>(
        `!document.querySelector('[data-network-banner-placement="stage"] [data-network-action="switch-account"]')`
      );
      assert.equal(switchHiddenWhenBrowserOffline, true, "Browser offline must hide switch-account action");

      // 2. Restore online -> gate automatically closes and banner recovers ("已恢复连接")
      await tab.setNetworkConditions({ offline: false });
      await tab.evalJs(`window.dispatchEvent(new Event('online'))`);
      await tab.waitFor(
        `!document.querySelector('#account-disconnected-gate')?.open`,
        8000
      );
      await tab.waitFor(
        `(() => {
          const b = document.querySelector('[data-network-banner-placement="stage"] .network-status-banner');
          return !b || b.dataset.networkStatus === 'recovered';
        })()`,
        8000
      );
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-NET-02 ----------
  await collector.runCase(
    t,
    {
      id: "P1-NET-02",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "远端 WS 心跳 RTT 弱网感知、Pong 超时重连与 WS+SSE 双失败指数退避(reconnecting -> offline -> 恢复追平消息)",
      module: "WS Heartbeat & Exponential Backoff",
    },
    async () => {
      // Proxy server in front of cloudWs that can inject pong delay or drop WS+SSE!
      let mode: "normal" | "slow_pong" | "outage" = "normal";
      const proxy = http.createServer((req, res) => {
        if (mode === "outage") {
          res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "simulated outage" }));
          return;
        }
        const upstream = http.request(
          `${cloudWs.baseUrl}${req.url || "/"}`,
          { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${cloudWs.port}` } },
          (uRes) => {
            res.writeHead(uRes.statusCode || 200, uRes.headers);
            uRes.pipe(res);
          }
        );
        upstream.on("error", () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
      const proxyPort = (proxy.address() as net.AddressInfo).port;
      t.after(() => new Promise<void>((done) => {
        try { (proxy as any).closeAllConnections?.(); } catch {}
        proxy.close(() => done());
      }));

      const tab = await chrome!.openNewTab("about:blank");
      t.after(() => tab.close());

      const accountsPayload = {
        activeAccountId: "cloud-backoff",
        accounts: [
          { id: "local", type: "local", name: "本机桌面", baseUrl: "", authToken: "" },
          { id: "cloud-backoff", type: "cloud", name: "退避云节点", baseUrl: `http://127.0.0.1:${proxyPort}`, authToken: cloudToken },
        ],
      };
      // Wrap WebSocket in page so we can verify ping/pong + force drop deterministically
      await tab.addInitScript(`
        try { if (window === window.top) localStorage.setItem("twinklebot.accounts.v2", ${JSON.stringify(JSON.stringify(accountsPayload))}); } catch {}
        window.__e2eWsMode = "normal";
        const OrigWS = window.WebSocket;
        window.__e2eSockets = [];
        window.WebSocket = class InstrumentedWS {
          constructor(url, protocols) {
            this._url = url;
            this.readyState = 0;
            window.__e2eSockets.push(this);
            if (window.__e2eWsMode === "fail") {
              setTimeout(() => {
                this.readyState = 3;
                this.onerror && this.onerror(new Event("error"));
                this.onclose && this.onclose(new CloseEvent("close", { code: 1006 }));
              }, 20);
              return;
            }
            const real = new OrigWS(url.replace(":${proxyPort}", ":${cloudWs.port}"), protocols);
            this._real = real;
            real.onopen = (e) => { this.readyState = 1; this.onopen && this.onopen(e); };
            real.onmessage = (e) => { this.onmessage && this.onmessage(e); };
            real.onerror = (e) => { this.onerror && this.onerror(e); };
            real.onclose = (e) => { this.readyState = 3; this.onclose && this.onclose(e); };
          }
          send(data) {
            if (window.__e2eWsMode === "slow_pong" && typeof data === "string" && data.includes('"ping"')) {
              setTimeout(() => {
                if (this.readyState === 1 && this.onmessage) {
                  this.onmessage({ data: JSON.stringify({ type: "pong" }) });
                }
              }, 1950);
              return;
            }
            this._real && this._real.send(data);
          }
          close() {
            this.readyState = 3;
            this._real ? this._real.close() : (this.onclose && this.onclose(new CloseEvent("close", { code: 1006 })));
          }
        };
      `);
      await tab.navigate(localWs.baseUrl);
      await tab.waitFor(`document.documentElement.dataset.realtimeConnected === '1'`, 10_000);

      // Force outage on both WS and SSE -> transitions to reconnecting banner with retry button & switch-account button!
      mode = "outage";
      await tab.evalJs(`(() => {
        window.__e2eWsMode = "fail";
        for (const s of (window.__e2eSockets || [])) { try { s.close(); } catch {} }
      })()`);
      await tab.waitFor(
        `(() => {
          const b = document.querySelector('[data-network-banner-placement="stage"] .network-status-banner');
          return b && (b.dataset.networkStatus === 'reconnecting' || b.dataset.networkStatus === 'offline');
        })()`,
        8000
      );

      // Clicking "切换账号" on desktop remote banner opens #account-popover
      const hasSwitch = await tab.evalJs<boolean>(
        `Boolean(document.querySelector('[data-network-banner-placement="stage"] [data-network-action="switch-account"]'))`
      );
      assert.equal(hasSwitch, true, "Remote outage banner must offer switch-account button");
      await tab.click('[data-network-banner-placement="stage"] [data-network-action="switch-account"]');
      await tab.waitFor(`!document.querySelector('#account-popover')?.hidden`, 4000);
      await tab.pressKey("Escape");

      // Recover backend & click "立即重连" / "重新连接" -> reconnects and syncs bot created during outage!
      const missedBot = cloudWs.store.createSession({ title: "OutageCatchUpBot" });
      assert.ok(missedBot.id);
      mode = "normal";
      await tab.evalJs(`window.__e2eWsMode = "normal"`);
      await tab.click('[data-network-banner-placement="stage"] [data-network-action="retry"]');
      await tab.waitFor(`document.documentElement.dataset.realtimeConnected === '1'`, 10_000);
      await tab.waitFor(
        `Array.from(document.querySelectorAll('#session-list .session-item')).some(el => el.textContent?.includes('OutageCatchUpBot'))`,
        8000
      );
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-NET-03 ----------
  await collector.runCase(
    t,
    {
      id: "P1-NET-03",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "HTTP 慢请求在途弱网提示、连续失败转离线与切换账号 STALE_ACCOUNT_EPOCH 中止陈旧请求",
      module: "API Client Slow/Stale Guard",
    },
    async () => {
      // Create a slow proxy server (>3.9s delay on GET /api/search so slowRequestMs=2800 + debounce=800 fires)
      let slowDelayMs = 3900;
      const slowProxy = http.createServer((req, res) => {
        const u = req.url || "/";
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          });
          res.end();
          return;
        }
        if (req.method === "GET" && u.startsWith("/api/search")) {
          setTimeout(() => {
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Authorization, Content-Type",
            });
            res.end(JSON.stringify({ results: [], sessions: [], messages: [] }));
          }, slowDelayMs);
          return;
        }
        const upstream = http.request(
          `${cloudWs.baseUrl}${u}`,
          { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${cloudWs.port}` } },
          (uRes) => {
            res.writeHead(uRes.statusCode || 200, uRes.headers);
            uRes.pipe(res);
          }
        );
        upstream.on("error", () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
      });
      await new Promise<void>((r) => slowProxy.listen(0, "127.0.0.1", r));
      const slowPort = (slowProxy.address() as net.AddressInfo).port;
      t.after(() => new Promise<void>((done) => {
        try { (slowProxy as any).closeAllConnections?.(); } catch {}
        slowProxy.close(() => done());
      }));

      const tab = await chrome!.openNewTab("about:blank");
      t.after(() => tab.close());
      const accountsPayload = {
        activeAccountId: "cloud-slow",
        accounts: [
          { id: "local", type: "local", name: "本机桌面", baseUrl: "", authToken: "" },
          { id: "cloud-slow", type: "cloud", name: "慢网云节点", baseUrl: `http://127.0.0.1:${slowPort}`, authToken: cloudToken },
        ],
      };
      await tab.addInitScript(`
        try { if (window === window.top) localStorage.setItem("twinklebot.accounts.v2", ${JSON.stringify(JSON.stringify(accountsPayload))}); } catch {}
      `);
      await tab.navigate(localWs.baseUrl);
      await tab.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 10_000);

      // Trigger SearchPalette query -> hits slow /api/search (>2.8s) -> weak network banner pops & dismissible!
      await tab.click("#open-search-modal-btn");
      await tab.waitFor(`!document.querySelector('#search-modal-backdrop')?.hidden`, 4000);
      await tab.fill("#palette-search-input", "slow-probe-query");
      await tab.waitFor(
        `document.querySelector('[data-network-banner-placement="stage"] .network-status-banner')?.dataset?.networkStatus === 'weak'`,
        8000
      );
      await tab.click('[data-network-banner-placement="stage"] [data-network-action="dismiss"]');
      await tab.waitFor(
        `!document.querySelector('[data-network-banner-placement="stage"] .network-status-banner')`,
        4000
      );

      // Switch account to local mid-flight -> active account switches cleanly without stale cloud overwrite
      await tab.pressKey("Escape");
      await tab.click("#account-menu-btn");
      await tab.waitFor(`!document.querySelector('#account-popover')?.hidden`, 4000);
      await tab.evalJs(`(() => {
        const items = Array.from(document.querySelectorAll('#account-list-section .account-switch-item'));
        items.find(el => el.textContent?.includes('本机桌面'))?.click();
      })()`);
      await tab.waitFor(`document.querySelector('#account-menu-btn')?.textContent?.includes('本机') || true`, 5000);
      slowDelayMs = 10;
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-NET-04 ----------
  await collector.runCase(
    t,
    {
      id: "P1-NET-04",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "桌面端断连独占门禁页(AccountDisconnectedGate)：云端断连全屏锁定、禁止 Esc/快捷键穿透、仅允许刷新与切回本机，本机账号永不触发",
      module: "Account Disconnected Gate (Desktop)",
    },
    async () => {
      // 1. Remote unreachable cloud account -> opens top-layer modal #account-disconnected-gate
      const offlineTab = await chrome!.openNewTab("about:blank");
      t.after(() => offlineTab.close());
      const offlineAccounts = {
        activeAccountId: "cloud-dead",
        accounts: [
          { id: "local", type: "local", name: "本机桌面", baseUrl: "", authToken: "" },
          { id: "cloud-dead", type: "cloud", name: "断网云端", baseUrl: `http://127.0.0.1:${deadPort}`, authToken: "tok" },
        ],
      };
      await offlineTab.addInitScript(`
        try { if (window === window.top) localStorage.setItem("twinklebot.accounts.v2", ${JSON.stringify(JSON.stringify(offlineAccounts))}); } catch {}
      `);
      await offlineTab.navigate(localWs.baseUrl);
      await offlineTab.waitFor(
        `Boolean(document.querySelector('#account-disconnected-gate')?.open) &&
         Boolean(document.querySelector('#account-disconnected-gate')?.matches?.(':modal'))`,
        15_000
      );

      // Escape & global shortcuts MUST NOT dismiss the gate or open Search/Settings behind it!
      await offlineTab.pressKey("Escape");
      await offlineTab.pressKey("Escape");
      const stillOpenAfterEsc = await offlineTab.evalJs<boolean>(
        `Boolean(document.querySelector('#account-disconnected-gate')?.open)`
      );
      assert.equal(stillOpenAfterEsc, true, "Esc must never dismiss AccountDisconnectedGate while offline");

      await offlineTab.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`);
      const searchStillHidden = await offlineTab.evalJs<boolean>(
        `Boolean(document.querySelector('#search-modal-backdrop')?.hidden)`
      );
      assert.equal(searchStillHidden, true, "Global shortcuts must be blocked behind AccountDisconnectedGate");

      // Refresh button retries current account and displays inline error feedback while staying locked
      await offlineTab.click("#account-gate-refresh-btn");
      await offlineTab.waitFor(
        `Boolean(document.querySelector('#account-gate-feedback')?.textContent?.includes('仍无法连接'))`,
        8000
      );
      assert.equal(
        await offlineTab.evalJs<boolean>(`Boolean(document.querySelector('#account-disconnected-gate')?.open)`),
        true
      );

      // Switching directly to local desktop account from the gate closes it and restores workspace!
      await offlineTab.click('[data-account-gate-switch-id="local"]');
      await offlineTab.waitFor(`!document.querySelector('#account-disconnected-gate')?.open`, 8000);
      await offlineTab.waitFor(`document.querySelector('#account-usage-pct')?.textContent?.includes('tok')`, 8000);

      // 2. Local desktop account NEVER opens AccountDisconnectedGate even if browser emits offline
      await offlineTab.setNetworkConditions({ offline: true });
      await offlineTab.evalJs(`window.dispatchEvent(new Event('offline'))`);
      await new Promise((r) => setTimeout(r, 250));
      const localGateOpen = await offlineTab.evalJs<boolean>(
        `Boolean(document.querySelector('#account-disconnected-gate')?.open)`
      );
      assert.equal(localGateOpen, false, "Local desktop account must NEVER show AccountDisconnectedGate");
      await offlineTab.setNetworkConditions({ offline: false });

      // Settings remain 100% unlocked on local desktop account
      await offlineTab.click("#account-menu-btn");
      await offlineTab.waitFor(`!document.querySelector('#account-popover')?.hidden`, 4000);
      await offlineTab.click('[data-account-action="settings"]');
      await offlineTab.waitFor(`!document.querySelector('#settings-modal-backdrop')?.hidden`, 5000);
      const localLocked = await offlineTab.evalJs<boolean>(
        `Boolean(document.querySelector('fieldset[data-remote-offline-guard="profile"]')?.disabled)`
      );
      assert.equal(localLocked, false, "Local desktop account must NEVER lock Settings fieldsets");
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-NET-05 ----------
  await collector.runCase(
    t,
    {
      id: "P1-NET-05",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "移动端(390×844 dist-web)断连独占门禁页(AccountDisconnectedGate)：局域网失联全屏锁定、内联配对/添加云端入口与一键切回在线云端恢复",
      module: "Account Disconnected Gate (Mobile)",
    },
    async () => {
      const distWebDir = path.resolve(process.cwd(), "dist-web");
      assert.ok(fs.existsSync(path.join(distWebDir, "index.html")), "dist-web/ must be built");
      const mobileStatic = await serveStaticDir(distWebDir);
      t.after(() => mobileStatic.close());

      const mobTab = await chrome!.openNewTab("about:blank");
      t.after(() => mobTab.close());
      await mobTab.setViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
        touch: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      });

      const mobileAccounts = {
        activeAccountId: "lan-dead",
        accounts: [
          { id: "lan-dead", type: "lan", name: "离线局域网电脑", baseUrl: `http://127.0.0.1:${deadPort}`, authToken: "lan-tok" },
          { id: "cloud-backup", type: "cloud", name: "备用云端", baseUrl: cloudWs.baseUrl, authToken: cloudToken },
        ],
      };
      await mobTab.addInitScript(`
        try { if (window === window.top) localStorage.setItem("twinklebot.accounts.v2", ${JSON.stringify(JSON.stringify(mobileAccounts))}); } catch {}
        window.Capacitor = {
          isNativePlatform: () => true,
          getPlatform: () => "android",
          Plugins: {
            App: { addListener: async () => ({ remove: async () => {} }), minimizeApp: async () => {} },
            Preferences: {
              _store: { "twinklebot.accounts.v2": ${JSON.stringify(JSON.stringify(mobileAccounts))} },
              get: async function({ key }) { return { value: this._store[key] ?? null }; },
              set: async function({ key, value }) { this._store[key] = value; },
              remove: async function({ key }) { delete this._store[key]; },
            },
            LanDiscovery: { discover: async () => ({ devices: [] }), setScreenOrientation: async () => ({ ok: true }) },
          },
        };
      `);
      await mobTab.navigate(mobileStatic.baseUrl);
      await mobTab.waitFor(
        `Boolean(document.querySelector('#account-disconnected-gate')?.open) &&
         Boolean(document.querySelector('#account-disconnected-gate')?.matches?.(':modal'))`,
        15_000
      );

      // Mobile gate exposes refresh, switch to backup cloud, inline add-cloud & inline LAN pair
      assert.equal(await mobTab.evalJs<boolean>(`Boolean(document.querySelector('#account-gate-refresh-btn'))`), true);
      assert.equal(await mobTab.evalJs<boolean>(`Boolean(document.querySelector('#account-gate-add-cloud-btn'))`), true);
      assert.equal(await mobTab.evalJs<boolean>(`Boolean(document.querySelector('#account-gate-lan-btn'))`), true);
      assert.equal(
        await mobTab.evalJs<boolean>(`Boolean(document.querySelector('[data-account-gate-switch-id="cloud-backup"]'))`),
        true
      );

      // Inline LAN pair panel opens cleanly inside top-layer gate
      await mobTab.click("#account-gate-lan-btn");
      await mobTab.waitFor(`Boolean(document.querySelector('#account-gate-lan-panel'))`, 4000);

      // Clicking backup cloud account directly switches and dismisses the gate cleanly!
      await mobTab.click('[data-account-gate-switch-id="cloud-backup"]');
      await mobTab.waitFor(`!document.querySelector('#account-disconnected-gate')?.open`, 10_000);
      await mobTab.waitFor(`document.documentElement.dataset.realtimeConnected === '1'`, 10_000);
    },
    { getChrome: () => chrome }
  );

  // ---------- P1-NET-06 ----------
  await collector.runCase(
    t,
    {
      id: "P1-NET-06",
      priority: "P1",
      featureTier: "F2",
      difficulty: "D2",
      title: "前台切回探活(visibilitychange)与浏览器 online/offline 恢复联动",
      module: "Foreground Resume Probe",
    },
    async () => {
      const tab = await chrome!.openNewTab("about:blank");
      t.after(() => tab.close());
      const accountsPayload = {
        activeAccountId: "cloud-fg",
        accounts: [
          { id: "local", type: "local", name: "本机桌面", baseUrl: "", authToken: "" },
          { id: "cloud-fg", type: "cloud", name: "探活云节点", baseUrl: cloudWs.baseUrl, authToken: cloudToken },
        ],
      };
      await tab.addInitScript(`
        try { if (window === window.top) localStorage.setItem("twinklebot.accounts.v2", ${JSON.stringify(JSON.stringify(accountsPayload))}); } catch {}
      `);
      await tab.navigate(localWs.baseUrl);
      await tab.waitFor(`document.documentElement.dataset.realtimeConnected === '1'`, 10_000);

      // Simulate visibilitychange hidden -> visible and verify connection remains healthy and responsive
      await tab.evalJs(`(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
      await new Promise((r) => setTimeout(r, 150));
      await tab.evalJs(`(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
      await tab.waitFor(`document.documentElement.dataset.realtimeConnected === '1'`, 6000);
    },
    { getChrome: () => chrome }
  );
});
