import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRunner } from "../src/agent/runner.js";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";
import { launchHeadlessChrome } from "./helpers/cdp-browser-harness.js";

const SHOULD_RUN_UI_E2E =
  process.env.TWINKLEBOT_REQUIRE_CHROME_E2E === "1" ||
  process.env.TWINKLEBOT_RUN_UI_E2E === "1";

test(
  "Web UI E2E (Headless Google Chrome): Settings screen pool, queue badge, group speaker follow & v1.0.0 gate",
  {
    skip: SHOULD_RUN_UI_E2E
      ? false
      : "Set TWINKLEBOT_REQUIRE_CHROME_E2E=1 (or run npm run test:e2e:chrome) to execute Headless Chrome UI E2E",
  },
  async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ui-e2e-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    // Lightweight static noVNC fixture so opening BotComputerOverlay has zero 404 errors
    const novncSrv = http.createServer((req, res) => {
      if ((req.url || "").startsWith("/vnc.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><body><div id='novnc-ready'>noVNC OK</div></body></html>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => novncSrv.listen(0, "127.0.0.1", resolve));
    t.after(() => novncSrv.close());
    const novncPort = (novncSrv.address() as net.AddressInfo).port;

    const store = createStore(tmpDir);
    store.writeSettings({
      routing: { smartRouter: false },
    });
    const adminBot = store.createSession({ title: "Twinkle", isAdmin: true });
    const worker1 = store.createSession({ title: "研究员", isAdmin: false });
    const worker2 = store.createSession({ title: "工程师", isAdmin: false });
    const queuedBot = store.createSession({ title: "排队员", isAdmin: false });
    const groupSession = store.createSession({
      title: "UI联调群",
      type: "group",
      memberBotIds: [worker1.id, worker2.id],
    });

    const bindings: Record<string, string> = {
      [adminBot.id]: "标签 #1",
      [worker1.id]: "标签 #2",
      [worker2.id]: "标签 #3",
    };

    let releaseHeldSlots!: () => void;
    let holdGate = new Promise<void>((resolve) => {
      releaseHeldSlots = resolve;
    });

    const executor = {
      health: async () => ({ ok: true, screen: { width: 1440, height: 900 } }),
      call: async (route: string, _body?: any) => {
        if (route === "/displays") {
          return {
            ok: true,
            mode: "shared-profile-multi-tab",
            bindings,
            displays: [{ display_num: 1, display: ":1", novnc_online: true, cdp_online: true }],
          };
        }
        if (route === "/displays/ensure") {
          return { ok: true, novnc_port: novncPort, display: ":1" };
        }
        if (route === "/browser/snapshot") {
          await holdGate;
          return { ok: true, url: "https://example.test", elements: [] };
        }
        return { ok: true };
      },
    };

    const model = {
      async nextTurn({ input }: any) {
        if (input.some((s: any) => s.type === "function_result")) {
          return {
            thoughts: [],
            text: "ui-e2e-done",
            calls: [],
            outputSteps: [{ type: "model_output", text: "ui-e2e-done" }],
          };
        }
        return {
          thoughts: [],
          text: "",
          calls: [{ id: "c1", name: "browser_snapshot", args: { url: "https://example.test", risk: "low" } }],
          outputSteps: [
            {
              type: "function_call",
              id: "c1",
              name: "browser_snapshot",
              arguments: { url: "https://example.test", risk: "low" },
            },
          ],
        };
      },
    };

    const config = {
      deployEnv: "local",
      host: "127.0.0.1",
      port: 0,
      geminiApiKey: "ui-e2e-key",
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
      maxSteps: 4,
      settleMs: 0,
      novncUrl: `http://127.0.0.1:${novncPort}/vnc.html`,
      novncProxyTarget: `http://127.0.0.1:${novncPort}`,
      screen: { width: 1440, height: 900 },
      writeRoots: [tmpDir],
      dataDir: tmpDir,
    };

    const runner = createRunner({ store, config, model, executor });
    const appServer = createServer({ store, config, runner, executor, model });
    await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => appServer.close(() => resolve())));
    const appPort = (appServer.address() as net.AddressInfo).port;
    const rawAppUrl = `http://127.0.0.1:${appPort}`;

    // Helper proxy so Linux CI runners (where native VM provisioning says "unsupported")
    // present a deterministic online Bot Computer state to Chrome, and legacy mode strips capabilities.
    const makeUiProxy = async ({ legacyV1 = false } = {}) => {
      const proxySrv = http.createServer(async (req, res) => {
        const targetUrl = `${rawAppUrl}${req.url || "/"}`;
        const method = req.method || "GET";
        const chunks: Buffer[] = [];
        if (method !== "GET" && method !== "HEAD") {
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
        const upstreamRes = await fetch(targetUrl, {
          method,
          headers: req.headers as any,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
        });
        if ((req.url || "").startsWith("/api/computer/status")) {
          const stBody: any = await upstreamRes.json();
          stBody.online = true;
          stBody.state = "ready";
          stBody.provider = "orbstack";
          stBody.latencyMs = stBody.latencyMs ?? 2;
          stBody.detail = "Ubuntu 桌面已就绪";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(stBody));
          return;
        }
        if (legacyV1 && (req.url || "").startsWith("/api/system/diagnostics")) {
          const diag: any = await upstreamRes.json();
          diag.appVersion = "1.0.0";
          diag.apiCapabilities = (diag.apiCapabilities || []).filter(
            (c: string) => c !== "multi-display-v1"
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(diag));
          return;
        }
        const buf = Buffer.from(await upstreamRes.arrayBuffer());
        const headers: Record<string, string> = {};
        upstreamRes.headers.forEach((v, k) => {
          if (k.toLowerCase() !== "content-length" && k.toLowerCase() !== "transfer-encoding") {
            headers[k] = v;
          }
        });
        res.writeHead(upstreamRes.status, headers);
        res.end(buf);
      });
      proxySrv.on("upgrade", (req, socket, head) => {
        const up = net.connect(appPort, "127.0.0.1", () => {
          const hdrLines = Object.entries(req.headers)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
            .join("\r\n");
          up.write(`${req.method || "GET"} ${req.url || "/"} HTTP/1.1\r\n${hdrLines}\r\n\r\n`);
          if (head && head.length) up.write(head);
          socket.pipe(up);
          up.pipe(socket);
        });
        up.on("error", () => socket.destroy());
        socket.on("error", () => up.destroy());
      });
      await new Promise<void>((resolve) => proxySrv.listen(0, "127.0.0.1", resolve));
      t.after(() => proxySrv.close());
      return (proxySrv.address() as net.AddressInfo).port;
    };

    const uiPort = await makeUiProxy({ legacyV1: false });
    const legacyPort = await makeUiProxy({ legacyV1: true });
    const baseUrl = `http://127.0.0.1:${uiPort}`;

    const chrome = await launchHeadlessChrome();
    t.after(() => chrome.close());

    // Read server-computed hardware screen budget
    const initialSettings: any = await (await fetch(`${baseUrl}/api/settings`)).json();
    const budget = initialSettings.screenPool.budget;

    // ---------- UI-1: SettingsModal screen pool presets + range slider persistence ----------
    await chrome.navigate(baseUrl);
    await chrome.waitFor(`Boolean(document.querySelector('#account-menu-btn'))`);
    await chrome.waitFor(
      `document.querySelectorAll('#session-list .session-item').length >= 4`
    );

    // Open Settings -> Computer via Account Popover (just like desktop users)
    await chrome.click("#account-menu-btn");
    await chrome.waitFor(`!document.querySelector('#account-popover').hidden`);
    await chrome.click(`[data-account-action="computer"]`);
    await chrome.waitFor(`!document.querySelector('#settings-modal-backdrop').hidden`);
    await chrome.waitFor(`Boolean(document.querySelector('#settings-screen-pool-block'))`);

    const balancedActive = await chrome.evalJs<boolean>(
      `document.querySelector('[data-screen-preset="balanced"]')?.classList.contains('is-active')`
    );
    assert.equal(balancedActive, true, "default balanced preset must be active");

    // Click 'high concurrency' preset and verify label + backend persistence
    await chrome.click(`[data-screen-preset="max"]`);
    await chrome.waitFor(
      `document.querySelector('#screen-pool-limit-label')?.textContent?.includes('${budget.max} 屏')`
    );
    let afterMax: any = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(afterMax.screenPool.maxConcurrentScreens, budget.max);
    assert.equal(afterMax.screenPool.mode, "custom");

    // Drag range slider to min lower bound and verify persistence
    await chrome.setRangeValue("#setting-max-concurrent-screens", budget.min);
    await chrome.waitFor(
      `document.querySelector('#screen-pool-limit-label')?.textContent?.includes('${budget.min} 屏')`
    );
    let afterMin: any = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(afterMin.screenPool.maxConcurrentScreens, budget.min);

    await chrome.click("#close-settings-modal-btn");
    await chrome.waitFor(`document.querySelector('#settings-modal-backdrop').hidden`);

    // ---------- UI-2: RightInspector shows '排队等待空闲屏幕…' & queue count live ----------
    // Occupy all `budget.min` screen slots, then launch `queuedBot`
    const waitPool = async (pred: () => boolean, label: string) => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`waitPool timeout: ${label}`);
    };

    const fillerBots = [adminBot, worker1, worker2].slice(0, budget.min);
    for (const fb of fillerBots) {
      await fetch(`${baseUrl}/api/sessions/${fb.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hold screen" }),
      });
    }
    await waitPool(
      () => runner.getScreenPoolStats().activeCount >= budget.min,
      `activeCount >= ${budget.min}`
    );

    await fetch(`${baseUrl}/api/sessions/${queuedBot.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "queue me" }),
    });
    await waitPool(
      () => runner.getScreenPoolStats().queuedCount >= 1,
      "queuedCount >= 1"
    );

    // Switch to queuedBot in left sidebar and assert RightInspector status card!
    const clickedQueued = await chrome.evalJs<boolean>(`(() => {
      const items = Array.from(document.querySelectorAll('#session-list .session-item'));
      const target = items.find(el => el.textContent && el.textContent.includes('排队员'));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(clickedQueued, true);
    await chrome.waitFor(
      `document.querySelector('#computer-card-status')?.textContent?.includes('排队等待空闲屏幕')`
    );

    // Switch to active worker1 (if budget.min >= 2) or adminBot and confirm active tab label + queue count
    const activeCheckBot = budget.min >= 2 ? worker1 : adminBot;
    await chrome.evalJs(`(() => {
      if (${JSON.stringify(activeCheckBot.isAdmin)}) {
        document.querySelector('#pinned-primary-bot')?.click();
        return;
      }
      const items = Array.from(document.querySelectorAll('#session-list .session-item'));
      const target = items.find(el => el.textContent && el.textContent.includes(${JSON.stringify(activeCheckBot.title)}));
      target && target.click();
    })()`);
    await chrome.waitFor(
      `(() => {
        const txt = document.querySelector('#computer-card-status')?.textContent || '';
        return txt.includes('运行中') && txt.includes('排队 1');
      })()`
    );

    // Release held screen slots so all UI-2 tasks finish cleanly
    releaseHeldSlots();
    const drainDeadline = Date.now() + 5000;
    while (
      Date.now() < drainDeadline &&
      [...fillerBots, queuedBot].some((b) => runner.isSessionBusy(b.id))
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // ---------- UI-3: BotComputerOverlay group speaker follow & member switcher ----------
    const clickedGroup = await chrome.evalJs<boolean>(`(() => {
      const items = Array.from(document.querySelectorAll('#session-list .session-item'));
      const target = items.find(el => el.textContent && el.textContent.includes('UI联调群'));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(clickedGroup, true);
    await chrome.waitFor(
      `document.querySelector('#computer-card-status')?.textContent?.includes('运行中')`
    );

    await chrome.click("#bot-computer-card");
    await chrome.waitFor(`!document.querySelector('#bot-screen-overlay').hidden`);
    await chrome.waitFor(`Boolean(document.querySelector('#group-screen-member-select'))`);

    // Broadcast active speaker = worker2 -> overlay must follow worker2 in real time!
    runner.broadcastGlobal({
      type: "status",
      sessionId: groupSession.id,
      botId: worker2.id,
      status: "running",
    });
    await chrome.waitFor(
      `document.querySelector('#screen-status-label')?.textContent?.includes('${worker2.title}') &&
       document.querySelector('#novnc-frame')?.getAttribute('src')?.includes('${worker2.id}')`
    );

    // Manually select worker1 from dropdown -> novnc-frame & status pill must switch immediately!
    await chrome.selectOption("#group-screen-member-select", worker1.id);
    await chrome.waitFor(
      `document.querySelector('#screen-status-label')?.textContent?.includes('${worker1.title}') &&
       document.querySelector('#novnc-frame')?.getAttribute('src')?.includes('${worker1.id}')`
    );
    await chrome.click("#exit-fullscreen-btn");

    // ---------- UI-4: v1.0.0 legacy node capability gating ----------
    await chrome.navigate(`http://127.0.0.1:${legacyPort}`);
    await chrome.waitFor(`Boolean(document.querySelector('#account-menu-btn'))`);
    await chrome.click("#account-menu-btn");
    await chrome.waitFor(`!document.querySelector('#account-popover').hidden`);
    await chrome.click(`[data-account-action="computer"]`);
    await chrome.waitFor(`!document.querySelector('#settings-modal-backdrop').hidden`);
    await new Promise((r) => setTimeout(r, 150));

    const hasScreenPoolOnLegacy = await chrome.evalJs<boolean>(
      `Boolean(document.querySelector('#settings-screen-pool-block'))`
    );
    assert.equal(
      hasScreenPoolOnLegacy,
      false,
      "settings-screen-pool-block must stay hidden on v1.0.0 legacy backend without multi-display-v1 capability"
    );

    assert.deepEqual(chrome.pageErrors, [], `Expected zero uncaught browser JS errors, got: ${chrome.pageErrors.join("; ")}`);
  }
);
