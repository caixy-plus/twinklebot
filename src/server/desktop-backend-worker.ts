import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  BackendTraySnapshot,
  ParentToWorkerMessage,
  WorkerToParentMessage,
} from "../electron/backend-ipc.js";
import { createModel } from "../agent/model.js";
import { createRunner } from "../agent/runner.js";
import { createScheduler } from "../agent/scheduler.js";
import { createLocalAwareExecutorClient } from "../lib/bot-computer-provisioner.js";
import { resolveProjectRoot } from "../lib/project-root.js";
import { stopWslKeepalive } from "../lib/wsl-ubuntu.js";
import { createServer } from "./index.js";
import { createStore } from "../store/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_ROOT = resolveProjectRoot(__dirname);

function readJsonSafe(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function sendIpc(msg: WorkerToParentMessage): void {
  if (typeof process.send === "function") {
    try {
      process.send(msg);
    } catch {
      // ignore closed IPC channel during shutdown
    }
  }
}

function computeTraySnapshot(store: any, runner: any): BackendTraySnapshot {
  let botCount = 0;
  let groupCount = 0;
  let scheduleCount = 0;
  try {
    const sessions = store?.listSessions?.() || [];
    for (const s of sessions) {
      if (s?.type === "group" || s?.isGroup) groupCount += 1;
      else botCount += 1;
    }
    const schedules = store?.readSchedules?.() || [];
    scheduleCount = schedules.filter((item: any) => item?.enabled !== false).length;
  } catch {
    // ignore snapshot read errors
  }

  let activeRunCount = 0;
  try {
    activeRunCount = Object.keys(runner?.activeSessions?.() || {}).length;
  } catch {
    activeRunCount = 0;
  }

  const relaySummary =
    typeof runner?.getRelayStatus === "function" ? runner.getRelayStatus() : null;
  const relayConfigured = Boolean(
    relaySummary?.enabled ||
      fs.existsSync(path.join(os.homedir(), ".config", "twinklebot-frpc", "frpc.toml")) ||
      fs.existsSync(path.join(os.homedir(), ".config", "geminibot-frpc", "frpc.toml"))
  );
  return {
    botCount,
    groupCount,
    scheduleCount,
    activeRunCount,
    relayConfigured,
  };
}

export async function runDesktopBackendWorker(): Promise<void> {
  let started = false;
  let shuttingDown = false;
  let backendServer: http.Server | null = null;
  let backendScheduler: any = null;
  let backendRunner: any = null;
  let backendStore: any = null;
  let unsubscribeRunner: (() => void) | null = null;
  let trayTimer: ReturnType<typeof setTimeout> | null = null;
  let cachedOtaStatus: Record<string, any> | null = null;
  let lastOtaStatusSyncAt = 0;
  let resolvedPublicDir = path.join(WORKER_ROOT, "public");

  const pendingReqs = new Map<
    string,
    { resolve: (val: any) => void; timer: ReturnType<typeof setTimeout> }
  >();

  function sendPendingRpc(
    msg: WorkerToParentMessage,
    reqId: string,
    timeoutMs = 2500,
    fallback: any = null
  ): Promise<any> {
    if (typeof process.send !== "function") {
      return Promise.resolve(fallback);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingReqs.delete(reqId);
        resolve(fallback);
      }, timeoutMs);
      timer.unref?.();
      pendingReqs.set(reqId, { resolve, timer });
      sendIpc(msg);
    });
  }

  function resolvePendingRpc(reqId: string, val: any) {
    const entry = pendingReqs.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingReqs.delete(reqId);
    entry.resolve(val);
  }

  function scheduleTrayBroadcast(delayMs = 80) {
    if (!backendStore || !backendRunner || shuttingDown) return;
    if (trayTimer) return;
    trayTimer = setTimeout(() => {
      trayTimer = null;
      if (!shuttingDown && backendStore && backendRunner) {
        sendIpc({
          type: "tray_snapshot",
          snapshot: computeTraySnapshot(backendStore, backendRunner),
        });
      }
    }, delayMs);
    trayTimer.unref?.();
  }

  async function shutdownAndExit(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (trayTimer) {
      clearTimeout(trayTimer);
      trayTimer = null;
    }
    for (const [reqId, entry] of pendingReqs.entries()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
      pendingReqs.delete(reqId);
    }
    try {
      unsubscribeRunner?.();
      unsubscribeRunner = null;
    } catch {}
    try {
      backendScheduler?.stop?.();
    } catch {}
    try {
      backendRunner?.stop?.();
    } catch {}
    if (backendServer) {
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(resolve, 1800);
        forceTimer.unref?.();
        try {
          backendServer?.close?.(() => {
            clearTimeout(forceTimer);
            resolve();
          });
          (backendServer as any)?.closeAllConnections?.();
        } catch {
          clearTimeout(forceTimer);
          resolve();
        }
      });
    }
    try {
      stopWslKeepalive();
    } catch {}
    process.exit(code);
  }

  async function handleBootstrap(msg: Extract<ParentToWorkerMessage, { type: "bootstrap" }>) {
    if (started) return;
    started = true;
    const cfg = msg.config || {};
    cachedOtaStatus = msg.otaStatus || null;
    if (
      typeof msg.effectivePublicDir === "string" &&
      msg.effectivePublicDir.trim() &&
      fs.existsSync(msg.effectivePublicDir)
    ) {
      resolvedPublicDir = msg.effectivePublicDir;
    } else if (fs.existsSync(path.join(WORKER_ROOT, "public"))) {
      resolvedPublicDir = path.join(WORKER_ROOT, "public");
    }

    const coreMeta = readJsonSafe(path.join(WORKER_ROOT, "core-meta.json"));
    const pkgMeta = readJsonSafe(path.join(WORKER_ROOT, "package.json"));
    const coreBuild = String(coreMeta?.coreBuild || coreMeta?.webBuild || "").trim();
    const coreVersion = String(coreMeta?.coreVersion || pkgMeta?.version || "1.0.0").trim();

    const store = createStore(cfg.dataDir);
    backendStore = store;
    const model = createModel({
      apiKey: cfg.geminiApiKey || "",
      getProviders: () => store.readSettings()?.providers || [],
      getRouting: () => store.readSettings()?.routing || {},
    });
    const executor = createLocalAwareExecutorClient({
      url: String(cfg.executorUrl || "http://127.0.0.1:7300"),
      token: cfg.executorToken || "unconfigured-token",
      deployEnv: cfg.deployEnv || "local",
      store,
    });
    const runner = createRunner({
      store,
      config: cfg,
      model,
      executor,
    });
    backendRunner = runner;
    unsubscribeRunner = runner.subscribe(() => {
      scheduleTrayBroadcast(60);
    });
    const scheduler = createScheduler({
      store,
      runner,
    });
    backendScheduler = scheduler;

    store.markInterrupted();
    scheduler.start();

    const server = createServer({
      config: cfg,
      store,
      runner,
      executor,
      model,
      scheduler,
      getEffectivePublicDir: () => resolvedPublicDir,
      otaController: {
        getStatus: () => {
          if (
            cachedOtaStatus?.pendingBuild &&
            typeof process.send === "function" &&
            Date.now() - lastOtaStatusSyncAt > 1000
          ) {
            lastOtaStatusSyncAt = Date.now();
            const reqId = `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            void sendPendingRpc(
              { type: "ota_status_request", reqId },
              reqId,
              1500,
              cachedOtaStatus
            ).then((updated) => {
              if (updated && typeof updated === "object") {
                cachedOtaStatus = updated;
              }
            });
          }
          return cachedOtaStatus;
        },
        confirmReady: (webBuild) => {
          if (cachedOtaStatus && cachedOtaStatus.pendingBuild && (!webBuild || webBuild === cachedOtaStatus.pendingBuild)) {
            cachedOtaStatus = {
              ...cachedOtaStatus,
              activeBuild: cachedOtaStatus.pendingBuild,
              lastGoodBuild: cachedOtaStatus.pendingBuild,
              pendingBuild: null,
              bootAttempts: 0,
              lastRollbackReason: "",
            };
          }
          const reqId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          void sendPendingRpc({ type: "ota_confirm", reqId, webBuild }, reqId, 2000, cachedOtaStatus).then(
            (updated) => {
              if (updated && typeof updated === "object") {
                cachedOtaStatus = updated;
              }
            }
          );
          return cachedOtaStatus;
        },
        rollback: (reason) => {
          const reqId = `rollback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          void sendPendingRpc({ type: "ota_rollback", reqId, reason }, reqId, 3000, cachedOtaStatus);
          return cachedOtaStatus;
        },
        getStatusAsync: async () => {
          if (typeof process.send !== "function") return cachedOtaStatus;
          const reqId = `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const updated = await sendPendingRpc(
            { type: "ota_status_request", reqId },
            reqId,
            2000,
            cachedOtaStatus
          );
          if (updated && typeof updated === "object") {
            cachedOtaStatus = updated;
          }
          return cachedOtaStatus;
        },
        applyUpdate: async (payload) => {
          if (typeof process.send !== "function") {
            return { ok: false, error: "当前未处于桌面端 Electron 托管运行模式" };
          }
          const reqId = `apply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const res = await sendPendingRpc(
            {
              type: "ota_apply",
              reqId,
              bundleUrl: payload.bundleUrl,
              sha256: payload.sha256,
              coreBuild: payload.coreBuild,
              force: Boolean(payload.force),
            },
            reqId,
            120_000,
            { ok: false, error: "OTA 下载或应用超时", status: cachedOtaStatus }
          );
          return res && typeof res === "object"
            ? res
            : { ok: false, error: "OTA 应用失败", status: cachedOtaStatus };
        },
        rollbackAsync: async (opts) => {
          if (typeof process.send !== "function") {
            return { ok: false, error: "当前未处于桌面端 Electron 托管运行模式" };
          }
          const reqId = `rollback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const res = await sendPendingRpc(
            {
              type: "ota_rollback",
              reqId,
              reason: opts?.reason,
              mode: opts?.mode,
              restart: opts?.restart !== false,
            },
            reqId,
            10_000,
            { ok: false, error: "OTA 回滚响应超时", status: cachedOtaStatus }
          );
          return res && typeof res === "object"
            ? res
            : { ok: false, error: "OTA 回滚失败", status: cachedOtaStatus };
        },
      },
      desktopController: {
        wakeWindow: async () => {
          const reqId = `wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const res = await sendPendingRpc({ type: "wake_window", reqId }, reqId, 2500, {
            pid: process.ppid || process.pid,
            windowVisible: true,
          });
          return {
            ok: true,
            pid: Number(res?.pid || process.pid),
            windowVisible: Boolean(res?.windowVisible),
          };
        },
        quitApp: () => {
          sendIpc({ type: "quit_app" });
        },
      },
    });
    backendServer = server;
    server.on("request", (req, res) => {
      const m = String(req.method || "GET").toUpperCase();
      if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
        res.once("finish", () => scheduleTrayBroadcast(120));
      }
    });

    const requestedPort = Number.isFinite(Number(cfg.port)) ? Number(cfg.port) : 3230;
    const host = String(cfg.host || "127.0.0.1");

    const MAX_PORT_RETRIES = 12;
    const PORT_RETRY_DELAY_MS = 150;
    await new Promise<void>((resolve, reject) => {
      let retries = 0;
      const tryListen = (portToBind: number) => {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err?.code === "EADDRINUSE" && portToBind !== 0) {
            server.off("error", onError);
            if (retries < MAX_PORT_RETRIES) {
              retries += 1;
              setTimeout(() => tryListen(portToBind), PORT_RETRY_DELAY_MS).unref?.();
              return;
            }
            tryListen(0);
            return;
          }
          reject(err);
        };
        server.once("error", onError);
        server.listen(portToBind, host, () => {
          server.off("error", onError);
          resolve();
        });
      };
      tryListen(requestedPort);
    });

    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
    const clientHost = !host || host === "0.0.0.0" ? "127.0.0.1" : host;
    const backendUrl = `http://${clientHost}:${actualPort}`;

    sendIpc({
      type: "ready",
      pid: process.pid,
      port: actualPort,
      host,
      backendUrl,
      coreBuild,
      coreVersion,
      appVersion: coreVersion,
    });
    scheduleTrayBroadcast(10);
  }

  process.on("message", (raw: ParentToWorkerMessage) => {
    if (!raw || typeof raw !== "object") return;
    if (raw.type === "bootstrap") {
      void handleBootstrap(raw).catch((err) => {
        console.error("[TwinkleBot Worker] Failed to start backend:", err);
        void shutdownAndExit(1);
      });
      return;
    }
    if (raw.type === "graceful_shutdown") {
      void shutdownAndExit(0);
      return;
    }
    if (raw.type === "get_activity_status") {
      const activeRunCount = backendRunner
        ? Object.keys(backendRunner.activeSessions?.() || {}).length
        : 0;
      sendIpc({
        type: "activity_status",
        reqId: raw.reqId,
        activeRunCount,
      });
      return;
    }
    if (raw.type === "wake_window_result") {
      resolvePendingRpc(raw.reqId, {
        pid: raw.pid,
        windowVisible: raw.windowVisible,
      });
      return;
    }
    if (raw.type === "ota_apply_result") {
      if (raw.status && typeof raw.status === "object") {
        cachedOtaStatus = raw.status;
      }
      if (raw.reqId) {
        resolvePendingRpc(raw.reqId, raw);
      }
      return;
    }
    if (
      raw.type === "ota_status_result" ||
      raw.type === "ota_confirm_result" ||
      raw.type === "ota_rollback_result" ||
      raw.type === "ota_status_update"
    ) {
      if (raw.status && typeof raw.status === "object") {
        cachedOtaStatus = raw.status;
      }
      if ("reqId" in raw && raw.reqId) {
        resolvePendingRpc(
          raw.reqId,
          raw.type === "ota_rollback_result" ? raw : (raw.status ?? null)
        );
      }
    }
  });

  // Prevent orphan worker processes if Electron parent crashes unexpectedly
  process.on("disconnect", () => {
    void shutdownAndExit(0);
  });
  process.on("SIGTERM", () => {
    void shutdownAndExit(0);
  });
  process.on("SIGINT", () => {
    void shutdownAndExit(0);
  });
}

function isDirectEntrypoint(): boolean {
  if (process.env.TWINKLEBOT_DESKTOP_WORKER === "1") return true;
  if (!process.argv[1]) return false;
  try {
    const resolvedArg = fs.realpathSync(path.resolve(process.argv[1]));
    const resolvedSelf = fs.realpathSync(fileURLToPath(import.meta.url));
    return resolvedArg === resolvedSelf;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (isDirectEntrypoint()) {
  await runDesktopBackendWorker();
}
