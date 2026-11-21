import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBackendSupervisor } from "../src/electron/backend-supervisor.js";
import { createCoreOtaManager } from "../src/electron/core-ota.js";
import { resolveDesktopConfig } from "../src/electron/env-loader.js";
import { createTarGzFromDir } from "../src/lib/tar-gzip.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeCoreRuntimeDir(
  dir: string,
  {
    coreBuild,
    coreVersion = "1.0.3",
    crashOnBoot = false,
    initialActiveRuns = 0,
  }: {
    coreBuild: string;
    coreVersion?: string;
    crashOnBoot?: boolean;
    initialActiveRuns?: number;
  }
) {
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "public", "index.html"),
    `<!doctype html><html><body>${coreBuild}</body></html>`
  );
  fs.writeFileSync(
    path.join(dir, "public", "web-meta.json"),
    JSON.stringify({ webBuild: coreBuild, appVersion: coreVersion })
  );
  fs.writeFileSync(
    path.join(dir, "core-meta.json"),
    JSON.stringify({ coreBuild, webBuild: coreBuild, coreVersion, minShellVersion: "1.0.3" })
  );

  const script = crashOnBoot
    ? `console.error("simulated crash"); process.exit(17);\n`
    : `
import http from "node:http";

let activeRunCount = ${initialActiveRuns};
let server = null;
let cfg = null;

function sendIpc(msg) {
  if (typeof process.send === "function") process.send(msg);
}

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "bootstrap") {
    cfg = msg.config || {};
    server = http.createServer((req, res) => {
      if (req.url === "/api/system/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, coreBuild: "${coreBuild}", appVersion: "${coreVersion}" }));
        return;
      }
      if (req.url === "/api/test/set-active" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}");
          activeRunCount = Number(parsed.activeRunCount || 0);
          sendIpc({
            type: "tray_snapshot",
            snapshot: {
              botCount: 2,
              groupCount: 1,
              scheduleCount: 0,
              activeRunCount,
              relayConfigured: false,
            },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, activeRunCount }));
        });
        return;
      }
      if (req.url === "/api/test/wake") {
        sendIpc({ type: "wake_window", reqId: "wake-1" });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("${coreBuild}");
    });
    const reqPort = Number(cfg.port || 0);
    await new Promise((resolve, reject) => {
      const tryListen = (p) => {
        const onErr = (err) => {
          if (err && err.code === "EADDRINUSE" && p !== 0) {
            server.off("error", onErr);
            tryListen(0);
            return;
          }
          reject(err);
        };
        server.once("error", onErr);
        server.listen(p, "127.0.0.1", () => {
          server.off("error", onErr);
          resolve();
        });
      };
      tryListen(reqPort);
    });
    const port = server.address().port;
    sendIpc({
      type: "ready",
      pid: process.pid,
      port,
      host: "127.0.0.1",
      backendUrl: "http://127.0.0.1:" + port,
      coreBuild: "${coreBuild}",
      coreVersion: "${coreVersion}",
      appVersion: "${coreVersion}",
    });
    sendIpc({
      type: "tray_snapshot",
      snapshot: {
        botCount: 2,
        groupCount: 1,
        scheduleCount: 0,
        activeRunCount,
        relayConfigured: false,
      },
    });
    return;
  }
  if (msg.type === "get_activity_status") {
    sendIpc({ type: "activity_status", reqId: msg.reqId, activeRunCount });
    return;
  }
  if (msg.type === "graceful_shutdown") {
    try { server?.closeAllConnections?.(); } catch {}
    server?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  }
});
`;
  fs.writeFileSync(path.join(dir, "server-bundle.mjs"), script, "utf8");
}

test("createBackendSupervisor handles same-port Core OTA switch, idle-deferred switch, force switch, and broken bundle auto-rollback", async () => {
  const root = makeTempDir("sup-root-");
  const userDataDir = path.join(root, "userData");
  const builtInDir = path.join(root, "builtin-core");
  const pkgSrcV2 = path.join(root, "src-v2");
  const pkgSrcV3 = path.join(root, "src-v3");
  const pkgSrcBad = path.join(root, "src-bad");
  const tgzV2 = path.join(root, "v2.tar.gz");
  const tgzV3 = path.join(root, "v3.tar.gz");
  const tgzBad = path.join(root, "bad.tar.gz");

  writeFakeCoreRuntimeDir(builtInDir, { coreBuild: "20261121.010000-builtin", initialActiveRuns: 0 });
  writeFakeCoreRuntimeDir(pkgSrcV2, { coreBuild: "20261121.020000-vvvvvv2", initialActiveRuns: 2 });
  writeFakeCoreRuntimeDir(pkgSrcV3, { coreBuild: "20261121.030000-vvvvvv3", initialActiveRuns: 0 });
  writeFakeCoreRuntimeDir(pkgSrcBad, { coreBuild: "20261121.040000-badbad4", crashOnBoot: true });

  const metaV2 = createTarGzFromDir(pkgSrcV2, tgzV2);
  const metaV3 = createTarGzFromDir(pkgSrcV3, tgzV3);
  const metaBad = createTarGzFromDir(pkgSrcBad, tgzBad);

  const assetBytes = new Map<string, Buffer>([
    ["/v2.tar.gz", fs.readFileSync(tgzV2)],
    ["/v3.tar.gz", fs.readFileSync(tgzV3)],
    ["/bad.tar.gz", fs.readFileSync(tgzBad)],
  ]);
  const assetServer = http.createServer((req, res) => {
    const b = assetBytes.get(req.url || "");
    if (!b) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(b);
  });
  await new Promise<void>((r) => assetServer.listen(0, "127.0.0.1", r));
  const assetPort = (assetServer.address() as any).port;

  let reloadCount = 0;
  let wokenCount = 0;
  const progressEvents: any[] = [];
  let supervisor: ReturnType<typeof createBackendSupervisor> | null = null;

  const coreOta = createCoreOtaManager({
    userDataDir,
    appVersion: "1.0.3",
    builtInCoreDir: builtInDir,
    allowLoopbackForTest: true,
    watchdogTimeoutMs: 5000,
    onProgress: (ev) => progressEvents.push(ev),
    onRollbackApplied: async (_st, reason) => {
      await supervisor?.applyRollbackAndRestart(reason);
    },
  });

  supervisor = createBackendSupervisor({
    coreOtaManager: coreOta,
    bootTimeoutMs: 5000,
    gracefulStopMs: 1500,
    getDesktopConfig: () => ({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(root, "data"),
      userDataDir,
      deployEnv: "local",
    }),
    onWakeWindow: async () => {
      wokenCount += 1;
      return { ok: true, pid: process.pid, windowVisible: true };
    },
    onReloadWindow: () => {
      reloadCount += 1;
    },
    onProgress: (ev) => progressEvents.push(ev),
  });

  try {
    // 1. Initial boot on built-in core
    const ready1 = await supervisor.start(0);
    assert.ok(ready1.port > 0);
    const initialPort = ready1.port;

    const health1 = (await (await fetch(`${ready1.url}/api/system/health`)).json()) as any;
    assert.equal(health1.coreBuild, "20261121.010000-builtin");

    await fetch(`${ready1.url}/api/test/wake`);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(wokenCount, 1);
    assert.equal(supervisor.getTraySnapshot().botCount, 2);

    // 2. Idle same-port switch to V2
    await coreOta.stageFromUrl({
      bundleUrl: `http://127.0.0.1:${assetPort}/v2.tar.gz`,
      expectedSha256: metaV2.sha256,
      coreBuild: "20261121.020000-vvvvvv2",
    });
    const sw2 = await supervisor.requestCoreSwitch("20261121.020000-vvvvvv2");
    assert.equal(sw2.queuedForIdle, false);
    assert.equal(supervisor.getPort(), initialPort);
    const health2 = (await (await fetch(`${supervisor.getBackendUrl()}/api/system/health`)).json()) as any;
    assert.equal(health2.coreBuild, "20261121.020000-vvvvvv2");
    coreOta.confirmReady("20261121.020000-vvvvvv2");
    assert.equal(coreOta.getStatus().lastGoodBuild, "20261121.020000-vvvvvv2");
    assert.ok(reloadCount >= 1);

    // 3. Active runs > 0 on V2 -> stages V3 into waiting_idle, then auto-switches when runs drop to 0
    await coreOta.stageFromUrl({
      bundleUrl: `http://127.0.0.1:${assetPort}/v3.tar.gz`,
      expectedSha256: metaV3.sha256,
      coreBuild: "20261121.030000-vvvvvv3",
    });
    const sw3 = await supervisor.requestCoreSwitch("20261121.030000-vvvvvv3");
    assert.equal(sw3.queuedForIdle, true);
    assert.equal(sw3.activeRunCount, 2);
    assert.ok(progressEvents.some((e) => e.phase === "waiting_idle"));
    assert.equal(supervisor.getDeferredSwitch()?.buildId, "20261121.030000-vvvvvv3");

    // Verify old V2 stays live during waiting_idle, then mark activeRunCount = 0
    await fetch(`${supervisor.getBackendUrl()}/api/test/set-active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeRunCount: 0 }),
    });

    // Wait for deferred check + smooth restart onto V3
    for (let i = 0; i < 40; i++) {
      const h = (await (await fetch(`${supervisor.getBackendUrl()}/api/system/health`).catch(() => null))?.json().catch(() => null)) as any;
      if (h?.coreBuild === "20261121.030000-vvvvvv3") break;
      await new Promise((r) => setTimeout(r, 80));
    }
    const health3 = (await (await fetch(`${supervisor.getBackendUrl()}/api/system/health`)).json()) as any;
    assert.equal(health3.coreBuild, "20261121.030000-vvvvvv3");
    assert.equal(supervisor.getPort(), initialPort);
    coreOta.confirmReady("20261121.030000-vvvvvv3");
    assert.equal(coreOta.getStatus().lastGoodBuild, "20261121.030000-vvvvvv3");

    // 4. Crashing Bad OTA bundle triggers automatic rollback back to V3 (lastGoodBuild) on same port
    await coreOta.stageFromUrl({
      bundleUrl: `http://127.0.0.1:${assetPort}/bad.tar.gz`,
      expectedSha256: metaBad.sha256,
      coreBuild: "20261121.040000-badbad4",
    });
    await supervisor.requestCoreSwitch("20261121.040000-badbad4", { force: true });
    assert.equal(coreOta.getStatus().activeBuild, "20261121.030000-vvvvvv3");
    assert.match(coreOta.getStatus().lastRollbackReason, /自动回滚/);
    const healthAfterRollback = (await (
      await fetch(`${supervisor.getBackendUrl()}/api/system/health`)
    ).json()) as any;
    assert.equal(healthAfterRollback.coreBuild, "20261121.030000-vvvvvv3");
  } finally {
    await supervisor.stop();
    coreOta.dispose();
    assetServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createBackendSupervisor boots the real compiled dist-server/core-runtime bundle and stops cleanly", async () => {
  const realCoreDir = path.resolve(process.cwd(), "dist-server", "core-runtime");
  if (!fs.existsSync(path.join(realCoreDir, "server-bundle.mjs"))) {
    return;
  }

  const root = makeTempDir("sup-real-");
  const userDataDir = path.join(root, "userData");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const coreOta = createCoreOtaManager({
    userDataDir,
    appVersion: "1.0.3",
    builtInCoreDir: realCoreDir,
    fallbackBuiltInPublicDir: path.resolve(process.cwd(), "public"),
  });

  const supervisor = createBackendSupervisor({
    coreOtaManager: coreOta,
    bootTimeoutMs: 10_000,
    gracefulStopMs: 2500,
    getDesktopConfig: () => ({
      port: 0,
      host: "127.0.0.1",
      dataDir,
      userDataDir,
      deployEnv: "local",
      localControlToken: "tok-real-test",
    }),
  });

  try {
    const ready = await supervisor.start(0);
    assert.ok(ready.port > 0);
    const res = await fetch(`${ready.url}/api/system/health`);
    assert.equal(res.status, 200);
    const health = (await res.json()) as any;
    assert.equal(health.ok, true);

    const diagRes = await fetch(`${ready.url}/api/system/diagnostics`);
    assert.equal(diagRes.status, 200);
    const diag = (await diagRes.json()) as any;
    assert.ok(Array.isArray(diag.apiCapabilities));
    assert.equal(diag.otaStatus?.supportsCoreOta, true);
    assert.ok(diag.otaStatus?.activeCoreBuild);

    const deskCfg = resolveDesktopConfig({
      env: { ...process.env, TWINKLEBOT_DESKTOP_PORT: "0", TWINKLEBOT_DATA_DIR: dataDir },
      appRoot: process.cwd(),
      userDataDir,
      isPackaged: false,
    });
    assert.ok(deskCfg.executorUrl);
  } finally {
    await supervisor.stop();
    coreOta.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
