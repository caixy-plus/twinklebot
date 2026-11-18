import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunner } from "../src/agent/runner.js";
import { createScreenLeasePool } from "../src/agent/screen-pool-manager.js";
import { createServer } from "../src/server/index.js";
import { createNovncUpgradeHandler } from "../src/server/static.js";
import {
  computeScreenPoolBudget,
  matchScreenPoolPreset,
  normalizeScreenPoolSettings,
} from "../src/shared/screen-pool.js";
import { createStore } from "../src/store/index.js";
import { buildNovncSrc } from "../src/web/state/helpers.js";

test("createRunner runs different Bots concurrently with isolated desktopMutex and bot-scoped executor headers", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-md-runner-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);
  const admin = store.createSession({ title: "Twinkle", isAdmin: true });
  const secondary = store.createSession({ title: "图", isAdmin: false });

  const startedAt: Record<string, number> = {};
  const finishedAt: Record<string, number> = {};
  const observedHeaders: Record<string, any> = {};
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const runner = createRunner({
    store,
    config: {},
    model: {},
    executor: {
      health: async () => ({ ok: true }),
      call: async (_route: string, _body: any, opts: any) => {
        const bid = String(opts?.headers?.["X-Twinkle-Bot-Id"] || "");
        observedHeaders[bid] = opts?.headers;
        return { ok: true };
      },
    },
    runTaskImpl: (async ({ sessionId, deps }: any) => {
      await deps.desktopMutex.runExclusive(async () => {
        currentConcurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        startedAt[sessionId] = Date.now();
        await deps.executor.call("/screenshot", {});
        await new Promise((r) => setTimeout(r, 80));
        finishedAt[sessionId] = Date.now();
        currentConcurrent -= 1;
      });
      return { status: "done", text: "ok" };
    }) as any,
  });

  runner.start(admin.id, "task 1");
  runner.start(secondary.id, "task 2");

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (!finishedAt[admin.id] || !finishedAt[secondary.id])) {
    await new Promise((r) => setTimeout(r, 15));
  }

  assert.ok(finishedAt[admin.id] && finishedAt[secondary.id], "both bots should finish");
  assert.equal(maxConcurrent, 2, "different Bots must execute desktop work concurrently without serializing");
  assert.equal(observedHeaders[admin.id]["X-Twinkle-Bot-Admin"], "1");
  assert.equal(observedHeaders[secondary.id]["X-Twinkle-Bot-Id"], secondary.id);
  assert.equal(observedHeaders[secondary.id]["X-Twinkle-Bot-Admin"], "0");
});

test("buildNovncSrc embeds sessionId on websockify path and createNovncUpgradeHandler routes by session display", async (t) => {
  const src = buildNovncSrc(
    "http://127.0.0.1:6080/vnc.html",
    true,
    "http://127.0.0.1:3230",
    "tok-1",
    { sessionId: "bot-sec-2" }
  );
  const u = new URL(src);
  assert.equal(u.searchParams.get("path"), "novnc/websockify?token=tok-1&sessionId=bot-sec-2");

  const upstreamRequests: string[] = [];
  const dynSrv = net.createServer((sock) => {
    sock.on("data", (buf) => {
      upstreamRequests.push(buf.toString("utf8"));
      sock.write("HTTP/1.1 101 Switching Protocols\r\n\r\nws-ok");
      sock.end();
    });
  });
  await new Promise<void>((resolve) => dynSrv.listen(0, "127.0.0.1", resolve));
  t.after(() => dynSrv.close());
  const dynPort = (dynSrv.address() as net.AddressInfo).port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-md-ws-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);
  const botSec = store.createSession({ title: "图", isAdmin: false });

  const ensureCalls: any[] = [];
  const upgradeHandler = createNovncUpgradeHandler({
    effectiveNovncProxyTarget: "http://127.0.0.1:6080",
    runtimeState: { deployEnv: "local" },
    finalConfig: {},
    deviceAuth: { isAuthorized: () => true },
    store,
    executor: {
      call: async (route: string, body: any) => {
        ensureCalls.push({ route, body });
        return { ok: true, novnc_port: dynPort, display: ":2" };
      },
    },
  } as any);

  const clientChunks: Buffer[] = [];
  let doneResolve!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  // Pipe via loopback net pair so socket.pipe / socket.destroy work authentically
  const clientSrv = net.createServer((srvSock) => {
    upgradeHandler(
      { headers: { host: "127.0.0.1:3230", connection: "Upgrade", upgrade: "websocket" } } as any,
      srvSock,
      Buffer.alloc(0),
      new URL(`http://127.0.0.1:3230/novnc/websockify?sessionId=${botSec.id}`)
    );
  });
  await new Promise<void>((resolve) => clientSrv.listen(0, "127.0.0.1", resolve));
  t.after(() => clientSrv.close());
  const cPort = (clientSrv.address() as net.AddressInfo).port;

  const cli = net.connect(cPort, "127.0.0.1", () => {});
  cli.on("data", (d) => clientChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
  cli.on("close", () => doneResolve());
  await donePromise;

  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].route, "/displays/ensure");
  assert.equal(ensureCalls[0].body.bot_id, botSec.id);
  assert.equal(ensureCalls[0].body.is_admin, false);
  const upText = upstreamRequests.join("");
  assert.match(upText, /GET \/websockify HTTP\/1\.1/);
  assert.match(Buffer.concat(clientChunks).toString("utf8"), /ws-ok/);

  // Regression: socket emitting 'error' while /displays/ensure is still awaiting must not throw unhandled error
  const { EventEmitter } = await import("node:events");
  const fakeSocket: any = new EventEmitter();
  fakeSocket.destroyed = false;
  fakeSocket.destroy = () => {
    fakeSocket.destroyed = true;
  };
  fakeSocket.write = () => {};
  fakeSocket.pipe = () => {};

  let releaseEnsure!: () => void;
  const ensureGate = new Promise<void>((resolve) => {
    releaseEnsure = resolve;
  });
  let upstreamConnected = false;
  const slowUpgradeHandler = createNovncUpgradeHandler({
    effectiveNovncProxyTarget: `http://127.0.0.1:${dynPort}`,
    runtimeState: { deployEnv: "local" },
    finalConfig: {},
    deviceAuth: { isAuthorized: () => true },
    store,
    executor: {
      call: async () => {
        await ensureGate;
        return { ok: true, novnc_port: dynPort, display: ":2" };
      },
    },
  } as any);

  const prevUpstreamCount = upstreamRequests.length;
  slowUpgradeHandler(
    { headers: { host: "127.0.0.1:3230", connection: "Upgrade", upgrade: "websocket" } } as any,
    fakeSocket,
    Buffer.alloc(0),
    new URL(`http://127.0.0.1:3230/novnc/websockify?sessionId=${botSec.id}`)
  );
  // Emit ECONNRESET before /displays/ensure resolves
  fakeSocket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  assert.equal(fakeSocket.destroyed, true);
  releaseEnsure();
  await new Promise((r) => setTimeout(r, 20));
  upstreamConnected = upstreamRequests.length > prevUpstreamCount;
  assert.equal(upstreamConnected, false, "should abort upstream connect after early client socket error");
});

test("computeScreenPoolBudget and normalizeScreenPoolSettings derive min < balanced < max from hardware specs", () => {
  const b4g = computeScreenPoolBudget({ totalMemBytes: 4 * 1024 ** 3, cpuCores: 2 });
  assert.equal(b4g.min, 1);
  assert.equal(b4g.defaultBalanced, 2);
  assert.equal(b4g.max, 3);

  const b8g = computeScreenPoolBudget({ totalMemBytes: 8 * 1024 ** 3, cpuCores: 4 });
  assert.equal(b8g.min, 2);
  assert.equal(b8g.defaultBalanced, 3);
  assert.equal(b8g.max, 5);

  const b16g = computeScreenPoolBudget({ totalMemBytes: 16 * 1024 ** 3, cpuCores: 8 });
  assert.equal(b16g.min, 2);
  assert.equal(b16g.defaultBalanced, 4);
  assert.equal(b16g.max, 8);

  const b32g = computeScreenPoolBudget({ totalMemBytes: 32 * 1024 ** 3, cpuCores: 12 });
  assert.equal(b32g.min, 2);
  assert.equal(b32g.defaultBalanced, 6);
  assert.equal(b32g.max, 12);

  const autoNorm = normalizeScreenPoolSettings(undefined, b16g);
  assert.equal(autoNorm.mode, "auto");
  assert.equal(autoNorm.maxConcurrentScreens, 4);
  assert.equal(matchScreenPoolPreset(autoNorm, b16g), "balanced");

  const clampedHigh = normalizeScreenPoolSettings({ mode: "custom", maxConcurrentScreens: 99 }, b16g);
  assert.equal(clampedHigh.maxConcurrentScreens, 8);
  assert.equal(matchScreenPoolPreset(clampedHigh, b16g), "max");

  const clampedLow = normalizeScreenPoolSettings({ mode: "custom", maxConcurrentScreens: 1 }, b16g);
  assert.equal(clampedLow.maxConcurrentScreens, 2);
  assert.equal(matchScreenPoolPreset(clampedLow, b16g), "min");
});

test("unlimited Bots share a bounded concurrent screen pool: GUI Bots queue FIFO past limit while CLI/chat Bots never queue", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-screen-queue-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);
  store.writeSettings({
    screenPool: { mode: "custom", maxConcurrentScreens: 2 },
  });

  // Create 10 Bots (no upper limit on Bot count)
  const bots = Array.from({ length: 10 }, (_, idx) =>
    store.createSession({ title: `Bot-${idx + 1}`, isAdmin: idx === 0 })
  );

  let activeGuiScreens = 0;
  let peakGuiScreens = 0;
  const guiAcquireOrder: string[] = [];
  const observedStatuses: Array<{ sessionId: string; status: string }> = [];
  const cliFinishedWhilePoolFull: string[] = [];

  let releaseFirstTwo!: () => void;
  const firstTwoGate = new Promise<void>((resolve) => {
    releaseFirstTwo = resolve;
  });

  const model = {
    async nextTurn({ input }: any) {
      const hasResult = input.some((s: any) => s.type === "function_result");
      if (hasResult) {
        return {
          thoughts: [],
          text: "done",
          calls: [],
          outputSteps: [{ type: "model_output", text: "done" }],
        };
      }
      const userTxt = JSON.stringify(input[0] || "");
      const isCliOnly = userTxt.includes("CLI_ONLY");
      const toolName = isCliOnly ? "run_shell" : "browser_click";
      const toolArgs = isCliOnly ? { command: "echo fast" } : { ref: "e1" };
      return {
        thoughts: [],
        text: "",
        calls: [{ id: "c1", name: toolName, args: toolArgs }],
        outputSteps: [{ type: "function_call", id: "c1", name: toolName, arguments: toolArgs }],
      };
    },
  };

  const runner = createRunner({
    store,
    config: { maxSteps: 4, settleMs: 0, maxConcurrentScreens: 2 },
    model,
    executor: {
      health: async () => ({ ok: true }),
      call: async (route: string, _body: any, opts: any) => {
        const bid = String(opts?.headers?.["X-Twinkle-Bot-Id"] || "");
        if (route === "/shell") {
          return { exit_code: 0, stdout: "cli-ok", stderr: "" };
        }
        if (route === "/browser/click") {
          guiAcquireOrder.push(bid);
          activeGuiScreens += 1;
          peakGuiScreens = Math.max(peakGuiScreens, activeGuiScreens);
          if (guiAcquireOrder.length <= 2) {
            await firstTwoGate;
          } else {
            await new Promise((r) => setTimeout(r, 15));
          }
          activeGuiScreens -= 1;
          return { ok: true, clicked: { ref: "e1" } };
        }
        return { ok: true };
      },
    },
  });

  runner.subscribe((ev: any) => {
    if (ev.type === "status" && ev.sessionId) {
      observedStatuses.push({ sessionId: ev.sessionId, status: ev.status });
    }
  });

  // Launch 4 GUI Bots simultaneously against maxConcurrentScreens = 2
  runner.start(bots[1].id, "GUI_1");
  runner.start(bots[2].id, "GUI_2");
  await new Promise((r) => setTimeout(r, 25));
  runner.start(bots[3].id, "GUI_3");
  runner.start(bots[4].id, "GUI_4");

  await new Promise((r) => setTimeout(r, 40));
  const midStats = runner.getScreenPoolStats();
  assert.equal(midStats.activeCount, 2, "exactly 2 Bots hold active screen leases");
  assert.equal(midStats.queuedCount, 2, "bots 3 and 4 wait in FIFO screen queue");
  assert.deepEqual(midStats.queuedBotIds, [bots[3].id, bots[4].id]);
  assert.ok(
    observedStatuses.some((s) => s.sessionId === bots[3].id && s.status === "waiting_screen"),
    "queued Bot emits waiting_screen status"
  );

  // While all 2 screen slots are 100% occupied, launch 3 CLI-only Bots (bots 5, 6, 7): they must finish immediately!
  runner.start(bots[5].id, "CLI_ONLY_5");
  runner.start(bots[6].id, "CLI_ONLY_6");
  runner.start(bots[7].id, "CLI_ONLY_7");
  const cliDeadline = Date.now() + 1500;
  while (
    Date.now() < cliDeadline &&
    [bots[5].id, bots[6].id, bots[7].id].some((id) => runner.isSessionBusy(id))
  ) {
    await new Promise((r) => setTimeout(r, 15));
  }
  for (const id of [bots[5].id, bots[6].id, bots[7].id]) {
    assert.equal(runner.isSessionBusy(id), false, "CLI-only Bot must never block on full screen pool");
    cliFinishedWhilePoolFull.push(id);
  }
  assert.equal(cliFinishedWhilePoolFull.length, 3);
  assert.equal(runner.getScreenPoolStats().queuedCount, 2);

  // Release the first 2 GUI Bots -> queued Bots 3 and 4 drain in strict FIFO order without exceeding limit 2
  releaseFirstTwo();
  const allDeadline = Date.now() + 3000;
  while (
    Date.now() < allDeadline &&
    [bots[1].id, bots[2].id, bots[3].id, bots[4].id].some((id) => runner.isSessionBusy(id))
  ) {
    await new Promise((r) => setTimeout(r, 15));
  }

  assert.equal(peakGuiScreens, 2, "concurrent screen operations must never exceed maxConcurrentScreens=2");
  assert.deepEqual(guiAcquireOrder.slice(2), [bots[3].id, bots[4].id], "queued GUI Bots execute in FIFO order");
  assert.equal(runner.getScreenPoolStats().activeCount, 0);
  assert.equal(runner.getScreenPoolStats().queuedCount, 0);
});

test("ScreenLeasePool supports live limit increase and abort removal, and /api/settings persists screenPool", async (t) => {
  let limit = 1;
  const pool = createScreenLeasePool({ getMaxConcurrentScreens: () => limit });

  const rel1 = await pool.acquire("bot-1");
  const ac2 = new AbortController();
  const wait2 = pool.acquire("bot-2", { signal: ac2.signal });
  const wait3 = pool.acquire("bot-3");

  assert.equal(pool.getStats().queuedCount, 2);
  ac2.abort();
  await assert.rejects(wait2, /aborted/i);
  assert.deepEqual(pool.getStats().queuedBotIds, ["bot-3"]);

  // Raising limit from 1 -> 2 wakes bot-3 immediately even before bot-1 releases!
  limit = 2;
  pool.reconcile();
  const rel3 = await wait3;
  assert.equal(pool.getStats().activeCount, 2);
  rel1();
  rel3();
  assert.equal(pool.getStats().activeCount, 0);

  // Verify HTTP GET/POST /api/settings exposes budget and clamps screenPool
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-sp-http-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createStore(tmpDir);
  const runner = createRunner({
    store,
    config: {},
    model: {},
    executor: { health: async () => ({ ok: true }), call: async () => ({ ok: true }) },
  });
  const srv = createServer({
    store,
    runner,
    config: {
      deployEnv: "local",
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
    } as any,
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const port = (srv.address() as net.AddressInfo).port;

  const getRes = await fetch(`http://127.0.0.1:${port}/api/settings`);
  const initialSettings: any = await getRes.json();
  assert.equal(initialSettings.screenPool.mode, "auto");
  assert.equal(
    initialSettings.screenPool.maxConcurrentScreens,
    initialSettings.screenPool.budget.defaultBalanced
  );

  const postRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenPool: { mode: "custom", maxConcurrentScreens: 999 } }),
  });
  assert.equal(postRes.status, 200);
  const updatedSettings: any = await postRes.json();
  assert.equal(updatedSettings.screenPool.mode, "custom");
  assert.equal(
    updatedSettings.screenPool.maxConcurrentScreens,
    updatedSettings.screenPool.budget.max
  );
});
