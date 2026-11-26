import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  BackendTraySnapshot,
  ParentToWorkerMessage,
  WorkerToParentMessage,
} from "./backend-ipc.js";
import type { CoreOtaManager, CoreOtaProgressEvent } from "./core-ota.js";

export interface DeferredCoreSwitch {
  buildId: string;
  queuedAt: number;
  activeRunCount: number;
}

export interface BackendSupervisorOptions {
  nodeExecPath?: string;
  repoFallbackRoot?: string;
  isPackaged?: boolean;
  bootTimeoutMs?: number;
  gracefulStopMs?: number;
  coreOtaManager: CoreOtaManager;
  getDesktopConfig: () => Record<string, any>;
  getWindowVisible?: () => boolean;
  onTraySnapshot?: (snapshot: BackendTraySnapshot) => void;
  onWakeWindow?: () => Promise<{ ok?: boolean; pid: number; windowVisible: boolean }>;
  onQuitApp?: () => void;
  onBackendUrlChanged?: (url: string, port: number) => void;
  onReloadWindow?: (reason: string) => void;
  onProgress?: (ev: CoreOtaProgressEvent) => void;
}

const DEFAULT_TRAY_SNAPSHOT: BackendTraySnapshot = {
  botCount: 0,
  groupCount: 0,
  scheduleCount: 0,
  activeRunCount: 0,
  relayConfigured: false,
};

export function createBackendSupervisor(options: BackendSupervisorOptions) {
  const nodeExec = options.nodeExecPath || process.execPath;
  const bootTimeoutMs = Math.max(500, Number(options.bootTimeoutMs ?? 8000));
  const gracefulStopMs = Math.max(200, Number(options.gracefulStopMs ?? 2500));

  let child: ChildProcess | null = null;
  let currentUrl = "";
  let currentPort = 0;
  let expectedShutdown = false;
  let disposed = false;
  let switchingInFlight: Promise<any> | null = null;
  let deferredSwitch: DeferredCoreSwitch | null = null;
  let deferredRollback: {
    reason: string;
    mode: "previous" | "builtin";
    queuedAt: number;
  } | null = null;
  let deferredTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshot: BackendTraySnapshot = { ...DEFAULT_TRAY_SNAPSHOT };
  let crashWindowStart = 0;
  let consecutiveCrashes = 0;
  let startGeneration = 0;

  const pendingWorkerReqs = new Map<
    string,
    { resolve: (val: any) => void; timer: ReturnType<typeof setTimeout> }
  >();

  function sendToChild(proc: ChildProcess | null, msg: ParentToWorkerMessage): boolean {
    if (!proc || proc.killed || !proc.connected) return false;
    try {
      proc.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  function clearPendingReqs() {
    for (const [id, entry] of pendingWorkerReqs.entries()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
      pendingWorkerReqs.delete(id);
    }
  }

  async function queryActiveRunCount(timeoutMs = 1500): Promise<number> {
    if (!child || !child.connected) return 0;
    const reqId = `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingWorkerReqs.delete(reqId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      pendingWorkerReqs.set(reqId, {
        resolve: (val) => resolve(typeof val === "number" ? val : null),
        timer,
      });
      if (!sendToChild(child, { type: "get_activity_status", reqId })) {
        clearTimeout(timer);
        pendingWorkerReqs.delete(reqId);
        resolve(null);
      }
    });
    return res !== null ? res : lastSnapshot.activeRunCount || 0;
  }

  async function stopChild(proc: ChildProcess | null): Promise<void> {
    if (!proc) return;
    clearPendingReqs();
    if (proc.exitCode !== null || proc.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        proc.off("exit", done);
        resolve();
      };
      proc.once("exit", done);

      sendToChild(proc, { type: "graceful_shutdown", reason: "supervisor_stop" });

      const termTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill("SIGTERM");
          } catch {}
        }
      }, gracefulStopMs);
      termTimer.unref?.();

      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
        done();
      }, gracefulStopMs + 1500);
      killTimer.unref?.();
    });
  }

  function scheduleDeferredCheck() {
    if (!deferredSwitch || switchingInFlight || disposed) return;
    if (deferredTimer) return;
    deferredTimer = setTimeout(() => {
      deferredTimer = null;
      if (!deferredSwitch || switchingInFlight || disposed) return;
      const target = deferredSwitch;
      deferredSwitch = null;
      void requestCoreSwitch(target.buildId, { force: true }).catch((err) => {
        console.warn("[TwinkleBot] Deferred Core OTA switch failed:", err);
      });
    }, 150);
    deferredTimer.unref?.();
  }

  async function waitForHealth(backendUrl: string, proc: ChildProcess, deadlineAt: number): Promise<boolean> {
    while (Date.now() < deadlineAt) {
      if (proc.exitCode !== null || proc.signalCode !== null || disposed) return false;
      try {
        const res = await fetch(`${backendUrl}/api/system/health`, {
          signal: AbortSignal.timeout(1200),
        });
        if (res.ok) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 80));
    }
    return false;
  }

  async function spawnAndWaitReady(preferredPort?: number): Promise<{
    url: string;
    port: number;
    pid: number;
    coreBuild: string;
    coreVersion: string;
  }> {
    startGeneration += 1;
    const myGen = startGeneration;
    expectedShutdown = false;

    const coreDir = options.coreOtaManager.getEffectiveCoreDir();
    const entryPath = options.coreOtaManager.getEffectiveServerEntry(options.repoFallbackRoot);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`找不到本地后端入口文件: ${entryPath}`);
    }

    const baseCfg = options.getDesktopConfig();
    const effectiveConfig = {
      ...baseCfg,
      ...(preferredPort && preferredPort > 0 ? { port: preferredPort } : {}),
    };

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      TWINKLEBOT_DESKTOP_WORKER: "1",
    };

    const spawned = spawn(nodeExec, [entryPath], {
      cwd: coreDir,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child = spawned;

    const stderrLines: string[] = [];
    spawned.stdout?.on("data", (chunk) => {
      process.stdout.write(`[worker] ${chunk.toString("utf8")}`);
    });
    spawned.stderr?.on("data", (chunk) => {
      const txt = chunk.toString("utf8");
      for (const line of txt.split(/\r?\n/)) {
        if (line.trim()) {
          stderrLines.push(line.trim());
          if (stderrLines.length > 30) stderrLines.shift();
        }
      }
      process.stderr.write(`[worker] ${txt}`);
    });

    const readyInfo = await new Promise<{
      url: string;
      port: number;
      pid: number;
      coreBuild: string;
      coreVersion: string;
    }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`后端子进程在 ${bootTimeoutMs}ms 内未完成就绪启动`));
      }, bootTimeoutMs);
      timer.unref?.();

      const onMsg = (msg: WorkerToParentMessage) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "ready" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            url: msg.backendUrl,
            port: msg.port,
            pid: msg.pid,
            coreBuild: msg.coreBuild,
            coreVersion: msg.coreVersion,
          });
          return;
        }

        if (msg.type === "tray_snapshot") {
          lastSnapshot = msg.snapshot || { ...DEFAULT_TRAY_SNAPSHOT };
          options.onTraySnapshot?.(lastSnapshot);
          if (deferredSwitch) {
            deferredSwitch = {
              ...deferredSwitch,
              activeRunCount: lastSnapshot.activeRunCount,
            };
            if (lastSnapshot.activeRunCount === 0) {
              scheduleDeferredCheck();
            }
          }
          if (
            deferredRollback &&
            lastSnapshot.activeRunCount === 0 &&
            !deferredTimer &&
            !switchingInFlight &&
            !disposed
          ) {
            const rb = deferredRollback;
            deferredRollback = null;
            deferredTimer = setTimeout(() => {
              deferredTimer = null;
              if (!switchingInFlight && !disposed) {
                void applyRollbackAndRestart(rb.reason).catch((err) => {
                  console.warn("[TwinkleBot] Deferred rollback restart failed:", err);
                });
              }
            }, 150);
            deferredTimer.unref?.();
          }
          return;
        }

        if (msg.type === "activity_status") {
          const entry = pendingWorkerReqs.get(msg.reqId);
          if (entry) {
            clearTimeout(entry.timer);
            pendingWorkerReqs.delete(msg.reqId);
            entry.resolve(msg.activeRunCount);
          }
          return;
        }

        if (msg.type === "wake_window") {
          void Promise.resolve(
            options.onWakeWindow?.() || {
              ok: true,
              pid: process.pid,
              windowVisible: options.getWindowVisible?.() ?? true,
            }
          ).then((res) => {
            sendToChild(spawned, {
              type: "wake_window_result",
              reqId: msg.reqId,
              ok: true,
              pid: Number(res?.pid || process.pid),
              windowVisible: Boolean(res?.windowVisible),
            });
          });
          return;
        }

        if (msg.type === "quit_app") {
          options.onQuitApp?.();
          return;
        }

        if (msg.type === "ota_status_request") {
          sendToChild(spawned, {
            type: "ota_status_result",
            reqId: msg.reqId,
            status: options.coreOtaManager.getStatus(),
          });
          return;
        }

        if (msg.type === "ota_confirm") {
          const status = options.coreOtaManager.confirmReady(msg.webBuild);
          sendToChild(spawned, {
            type: "ota_confirm_result",
            reqId: msg.reqId,
            status,
          });
          return;
        }

        if (msg.type === "ota_apply") {
          void (async () => {
            try {
              const { cleanBuild } = await options.coreOtaManager.stageFromUrl({
                bundleUrl: String(msg.bundleUrl || ""),
                expectedSha256: String(msg.sha256 || ""),
                coreBuild: String(msg.coreBuild || ""),
              });
              const result = await requestCoreSwitch(cleanBuild, {
                force: Boolean(msg.force),
              });
              sendToChild(spawned, {
                type: "ota_apply_result",
                reqId: msg.reqId,
                ok: true,
                queuedForIdle: Boolean(result?.queuedForIdle),
                activeRunCount: Number(result?.activeRunCount || 0),
                status: result?.status || options.coreOtaManager.getStatus(),
                deferredSwitch: deferredSwitch ? { ...deferredSwitch } : null,
              });
            } catch (err: any) {
              sendToChild(spawned, {
                type: "ota_apply_result",
                reqId: msg.reqId,
                ok: false,
                error: err?.message || String(err),
                status: options.coreOtaManager.getStatus(),
              });
            }
          })();
          return;
        }

        if (msg.type === "ota_rollback") {
          void (async () => {
            const reason = msg.reason || "Bot 触发回滚";
            try {
              const status =
                msg.mode === "builtin"
                  ? options.coreOtaManager.rollbackToBuiltIn()
                  : options.coreOtaManager.rollback(reason);
              if (msg.restart) {
                const activeRuns = await queryActiveRunCount();
                if (activeRuns > 0) {
                  deferredRollback = {
                    reason,
                    mode: msg.mode === "builtin" ? "builtin" : "previous",
                    queuedAt: Date.now(),
                  };
                  sendToChild(spawned, {
                    type: "ota_rollback_result",
                    reqId: msg.reqId,
                    ok: true,
                    queuedForIdle: true,
                    activeRunCount: activeRuns,
                    status,
                  });
                  return;
                }
                sendToChild(spawned, {
                  type: "ota_rollback_result",
                  reqId: msg.reqId,
                  ok: true,
                  queuedForIdle: false,
                  activeRunCount: 0,
                  status,
                });
                setImmediate(() => {
                  if (!disposed && !switchingInFlight) {
                    void applyRollbackAndRestart(reason).catch((err) => {
                      console.warn("[TwinkleBot] Immediate rollback restart failed:", err);
                    });
                  }
                });
                return;
              }
              sendToChild(spawned, {
                type: "ota_rollback_result",
                reqId: msg.reqId,
                ok: true,
                status,
              });
            } catch (err: any) {
              sendToChild(spawned, {
                type: "ota_rollback_result",
                reqId: msg.reqId,
                ok: false,
                error: err?.message || String(err),
                status: options.coreOtaManager.getStatus(),
              });
            }
          })();
        }
      };

      const onExitBeforeReady = (code: number | null, sig: NodeJS.Signals | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const tail = stderrLines.slice(-4).join(" | ");
          reject(
            new Error(
              `后端子进程意外退出 (code=${code}, signal=${sig})${tail ? `: ${tail}` : ""}`
            )
          );
          return;
        }

        // Unexpected runtime crash AFTER ready
        if (disposed || expectedShutdown || child !== spawned || myGen !== startGeneration) {
          return;
        }
        const pending = options.coreOtaManager.getStatus().pendingBuild;
        if (pending) {
          console.warn(`[TwinkleBot] Pending Core OTA ${pending} crashed; rolling back...`);
          options.coreOtaManager.rollback(`新核心版本 ${pending} 运行时异常退出，已自动回滚`);
          return;
        }

        const now = Date.now();
        if (now - crashWindowStart > 60_000) {
          crashWindowStart = now;
          consecutiveCrashes = 0;
        }
        consecutiveCrashes += 1;
        if (consecutiveCrashes <= 3) {
          const delay = Math.min(2000, consecutiveCrashes * 300);
          setTimeout(() => {
            if (!disposed && !switchingInFlight) {
              void start(currentPort || undefined).catch((err) => {
                console.error("[TwinkleBot] Auto-restart backend worker failed:", err);
              });
            }
          }, delay).unref?.();
        }
      };

      spawned.on("message", onMsg);
      spawned.on("exit", onExitBeforeReady);

      const sent = sendToChild(spawned, {
        type: "bootstrap",
        config: effectiveConfig,
        otaStatus: options.coreOtaManager.getStatus(),
        effectivePublicDir: options.coreOtaManager.getEffectivePublicDir(),
      });
      if (!sent) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("无法通过 IPC 向后端子进程发送启动配置"));
      }
    });

    const healthy = await waitForHealth(readyInfo.url, spawned, Date.now() + 2500);
    if (!healthy) {
      throw new Error("后端子进程就绪后 /api/system/health 校验超时");
    }

    const prevUrl = currentUrl;
    currentUrl = readyInfo.url;
    currentPort = readyInfo.port;
    consecutiveCrashes = 0;
    if (prevUrl && prevUrl !== currentUrl) {
      options.onBackendUrlChanged?.(currentUrl, currentPort);
    }
    return readyInfo;
  }

  async function start(preferredPort?: number) {
    try {
      return await spawnAndWaitReady(preferredPort ?? (currentPort || undefined));
    } catch (err: any) {
      const pending = options.coreOtaManager.getStatus().pendingBuild;
      if (pending) {
        expectedShutdown = true;
        await stopChild(child);
        child = null;
        options.coreOtaManager.rollback(
          `新核心版本 ${pending} 启动失败，已自动回滚：${err?.message || "unknown error"}`
        );
        return await spawnAndWaitReady(preferredPort ?? (currentPort || undefined));
      }
      expectedShutdown = true;
      await stopChild(child);
      child = null;
      throw err;
    }
  }

  async function restartActiveRuntime(reason: string, isRollback = false) {
    const portToReuse = currentPort || undefined;
    options.onProgress?.({
      phase: isRollback ? "rollback" : "applying",
      percent: 92,
      message: isRollback ? reason : "正在平滑重启本地 Node 服务并加载新版本…",
      coreBuild: options.coreOtaManager.getStatus().activeCoreBuild,
      webBuild: options.coreOtaManager.getStatus().activeCoreBuild,
    });
    expectedShutdown = true;
    await stopChild(child);
    child = null;

    await start(portToReuse);
    const st = options.coreOtaManager.getStatus();
    if (!isRollback) {
      options.onProgress?.({
        phase: "done",
        percent: 100,
        message: "核心服务与前端热更新已就绪，正在刷新界面…",
        coreBuild: st.activeCoreBuild,
        webBuild: st.activeCoreBuild,
      });
    }
    options.onReloadWindow?.(reason);
    return st;
  }

  async function requestCoreSwitch(
    buildId: string,
    { force = false }: { force?: boolean } = {}
  ) {
    if (switchingInFlight) return await switchingInFlight;

    const run = async () => {
      if (!force) {
        const activeRuns = await queryActiveRunCount();
        if (activeRuns > 0) {
          deferredSwitch = {
            buildId,
            queuedAt: Date.now(),
            activeRunCount: activeRuns,
          };
          options.onProgress?.({
            phase: "waiting_idle",
            percent: 90,
            coreBuild: buildId,
            webBuild: buildId,
            activeRunCount: activeRuns,
            message: `新版本已下载就绪；当前有 ${activeRuns} 个 Bot 正在执行任务，完成后将自动平滑切换`,
          });
          return {
            queuedForIdle: true,
            activeRunCount: activeRuns,
            status: options.coreOtaManager.getStatus(),
          };
        }
      }

      deferredSwitch = null;
      deferredRollback = null;
      if (deferredTimer) {
        clearTimeout(deferredTimer);
        deferredTimer = null;
      }

      options.coreOtaManager.activatePreparedBuild(buildId);
      try {
        const status = await restartActiveRuntime(`切换核心热更新 ${buildId}`, false);
        return {
          queuedForIdle: false,
          activeRunCount: 0,
          status,
        };
      } catch (err: any) {
        // Fallback if even rollback failed unexpectedly
        throw err;
      }
    };

    switchingInFlight = run().finally(() => {
      switchingInFlight = null;
    });
    return await switchingInFlight;
  }

  async function forceSwitchDeferred() {
    if (!deferredSwitch) {
      return { queuedForIdle: false, status: options.coreOtaManager.getStatus() };
    }
    const targetBuild = deferredSwitch.buildId;
    deferredSwitch = null;
    if (deferredTimer) {
      clearTimeout(deferredTimer);
      deferredTimer = null;
    }
    return await requestCoreSwitch(targetBuild, { force: true });
  }

  function cancelDeferredSwitch() {
    deferredSwitch = null;
    deferredRollback = null;
    if (deferredTimer) {
      clearTimeout(deferredTimer);
      deferredTimer = null;
    }
    return { ok: true };
  }

  async function applyRollbackAndRestart(reason: string) {
    if (switchingInFlight) return;
    switchingInFlight = (async () => {
      deferredSwitch = null;
      deferredRollback = null;
      if (deferredTimer) {
        clearTimeout(deferredTimer);
        deferredTimer = null;
      }
      const prevUrl = currentUrl;
      const st = await restartActiveRuntime(reason, true);
      sendToChild(child, { type: "ota_status_update", status: st });
      if (prevUrl && prevUrl === currentUrl) {
        // Reload already requested inside restartActiveRuntime
      }
      return st;
    })().finally(() => {
      switchingInFlight = null;
    });
    return await switchingInFlight;
  }

  async function stop() {
    disposed = true;
    expectedShutdown = true;
    deferredSwitch = null;
    deferredRollback = null;
    if (deferredTimer) {
      clearTimeout(deferredTimer);
      deferredTimer = null;
    }
    await stopChild(child);
    child = null;
  }

  return {
    start,
    stop,
    requestCoreSwitch,
    forceSwitchDeferred,
    cancelDeferredSwitch,
    applyRollbackAndRestart,
    getBackendUrl: () => currentUrl,
    getPort: () => currentPort,
    getTraySnapshot: () => ({ ...lastSnapshot }),
    getDeferredSwitch: () => (deferredSwitch ? { ...deferredSwitch } : null),
    queryActiveRunCount,
  };
}

export type BackendSupervisor = ReturnType<typeof createBackendSupervisor>;
