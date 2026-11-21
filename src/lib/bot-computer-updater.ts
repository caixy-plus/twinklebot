import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildScrubbedEnv } from "./mcp-client.js";
import { resolveProjectRoot } from "./project-root.js";
import { buildMacOrbExecutorDeployScript } from "./bot-computer-provisioner.js";
import {
  buildWslProvisionScript,
  ensureWslKeepalive,
  parseWslDistroList,
  pickWslUbuntuDistro,
  resolveUnpackedExecutorPath,
  resolveWindowsProxyHint,
  syncFileToWslViaChunks,
  windowsPathToWsl,
} from "./wsl-ubuntu.js";
import type { ExecutorClient } from "../shared/config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_PROJECT_ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

function defaultUpdaterExec(cmd: string, args: string[], timeout = 120_000) {
  return execFileAsync(cmd, args, {
    env: { ...buildScrubbedEnv(), WSL_UTF8: "1" },
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UpdateBotComputerResult {
  ok: true;
  updatedAt: string;
  distro?: string;
  screen?: unknown;
}

export async function updateBotComputer({
  platform = process.platform,
  projectRoot = DEFAULT_PROJECT_ROOT,
  executor,
  executorToken = "",
  execFileFn = defaultUpdaterExec,
  maxHealthRetries = 15,
  retryDelayMs = 300,
}: {
  platform?: string;
  projectRoot?: string;
  executor?: Partial<ExecutorClient> | null;
  executorToken?: string;
  execFileFn?: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  maxHealthRetries?: number;
  retryDelayMs?: number;
} = {}): Promise<UpdateBotComputerResult> {
  const localExecutorPy = resolveUnpackedExecutorPath(projectRoot);
  let activeDistro: string | undefined;

  if (platform === "win32") {
    const listOut = await execFileFn("wsl", ["-l", "-q"]);
    const distro =
      pickWslUbuntuDistro(parseWslDistroList(String(listOut?.stdout || ""))) || "Ubuntu";
    activeDistro = distro;
    if (execFileFn === defaultUpdaterExec) {
      ensureWslKeepalive(distro);
    }

    const resolvedToken =
      executorToken || process.env.TWINKLEBOT_EXECUTOR_TOKEN || "unconfigured-token";
    const hasLocalExecutor = fs.existsSync(localExecutorPy);
    const proxyHint = await resolveWindowsProxyHint({
      platform,
      execFileFn: execFileFn === defaultUpdaterExec ? execFileFn : undefined,
    });
    const script = buildWslProvisionScript({
      executorWslPath: hasLocalExecutor ? windowsPathToWsl(localExecutorPy) : "",
      executorToken: resolvedToken,
      proxyHint,
    });
    const checkSuffix = hasLocalExecutor
      ? `\nif [ ! -s /opt/twinklebot/executor.py ]; then echo "__MISSING_EXECUTOR_PY__"; fi\n`
      : "";
    const scriptB64 = Buffer.from(script + checkSuffix, "utf-8").toString("base64");

    const deployOut = await execFileFn(
      "wsl",
      [
        "-d",
        distro,
        "-u",
        "root",
        "--",
        "bash",
        "-lc",
        `printf '%s' '${scriptB64}' | base64 -d | bash`,
      ],
      600_000
    );

    if (
      hasLocalExecutor &&
      String(deployOut?.stdout || "").includes("__MISSING_EXECUTOR_PY__")
    ) {
      await syncFileToWslViaChunks({
        distro,
        localPath: localExecutorPy,
        remotePath: "/opt/twinklebot/executor.py",
        mode: "0755",
        execFileFn,
      });
      await execFileFn("wsl", [
        "-d",
        distro,
        "-u",
        "root",
        "--",
        "bash",
        "-lc",
        "if [ \"$(ps -p 1 -o comm= 2>/dev/null || true)\" = \"systemd\" ]; then systemctl restart twinklebot-executor.service; else pkill -f '[/]opt/twinklebot/executor.py' || true; set -a; . /etc/twinklebot/executor.env; set +a; nohup /usr/bin/python3 /opt/twinklebot/executor.py </dev/null >/var/log/twinklebot/executor.log 2>&1 & fi",
      ]);
    }
  } else {
    const rawExecutorPy = path.join(projectRoot, "executor", "executor.py");
    const macExecutorPy = rawExecutorPy.replace(/\.asar([/\\])/, ".asar.unpacked$1");
    const explicitOrEnvToken =
      String(executorToken || process.env.TWINKLEBOT_EXECUTOR_TOKEN || "").trim();

    await execFileFn("orb", [
      "-m",
      "ubuntu",
      "-u",
      "root",
      "install",
      "-D",
      "-m",
      "0755",
      macExecutorPy,
      "/opt/twinklebot/executor.py",
    ]);

    const macDeployScript = buildMacOrbExecutorDeployScript({
      executorToken: explicitOrEnvToken,
      overwriteToken: Boolean(explicitOrEnvToken),
    });
    await execFileFn("orb", [
      "-m",
      "ubuntu",
      "-u",
      "root",
      "bash",
      "-lc",
      macDeployScript,
    ]);
  }

  let lastErr: any = null;
  if (executor && typeof executor.health === "function") {
    for (let attempt = 1; attempt <= maxHealthRetries; attempt += 1) {
      try {
        const health = await executor.health();
        if (health && health.ok) {
          return {
            ok: true,
            updatedAt: new Date().toISOString(),
            ...(activeDistro ? { distro: activeDistro } : {}),
            screen: health.screen || null,
          };
        }
      } catch (err) {
        lastErr = err;
      }
      if (attempt < maxHealthRetries) {
        await sleep(retryDelayMs);
      }
    }
    throw new Error(
      `服务已重启但健康检查未恢复：${lastErr?.message || "unknown error"}`
    );
  }

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    ...(activeDistro ? { distro: activeDistro } : {}),
  };
}

export function computeBundledExecutorSha256(projectRoot = DEFAULT_PROJECT_ROOT): string {
  try {
    const localPath = resolveUnpackedExecutorPath(projectRoot);
    if (!fs.existsSync(localPath)) return "";
    const content = fs.readFileSync(localPath);
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

export interface AutoSyncExecutorResult {
  ok: boolean;
  synced: boolean;
  reason?: string;
  updatedAt?: string;
  error?: string;
}

export interface ExecutorAutoSyncController {
  syncIfOutdated(reason?: string): Promise<AutoSyncExecutorResult>;
  scheduleStartupSync(delayMs?: number): void;
  isSynced(): boolean;
  dispose(): void;
}

/**
 * Keeps the local Ubuntu VM's `/opt/twinklebot/executor.py` automatically synchronized
 * with the Desktop App's bundled `executor.py` whenever their SHA-256 hashes differ:
 * - Triggered non-blockingly ~1.5s after App startup (if the VM is already running), AND
 * - Triggered lazily before the first Bot Computer `executor.call(...)` if the VM woke up later.
 * - Once verified up-to-date in this process, subsequent checks are a 0ms in-memory no-op.
 */
export function createExecutorAutoSyncController({
  platform = process.platform,
  deployEnv = "local",
  projectRoot = DEFAULT_PROJECT_ROOT,
  executor,
  executorToken = "",
  store = null,
  updateBotComputerFn = updateBotComputer,
  execFileFn,
  cooldownMs = 5 * 60_000,
  localShaOverride,
}: {
  platform?: string;
  deployEnv?: string;
  projectRoot?: string;
  executor?: Partial<ExecutorClient> | null;
  executorToken?: string;
  store?: any;
  updateBotComputerFn?: typeof updateBotComputer;
  execFileFn?: (cmd: string, args: string[], timeout?: number) => Promise<any>;
  cooldownMs?: number;
  localShaOverride?: string;
} = {}): ExecutorAutoSyncController {
  const localSha =
    typeof localShaOverride === "string"
      ? localShaOverride.trim()
      : computeBundledExecutorSha256(projectRoot);
  const eligible =
    deployEnv === "local" &&
    (platform === "darwin" || platform === "win32") &&
    Boolean(localSha) &&
    Boolean(executor && typeof executor.health === "function");

  let verifiedSha = "";
  let inflight: Promise<AutoSyncExecutorResult> | null = null;
  let lastFailedAt = 0;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function runCheck(reason: string): Promise<AutoSyncExecutorResult> {
    if (!eligible || disposed) {
      return { ok: true, synced: false, reason: "ineligible" };
    }
    if (verifiedSha === localSha) {
      return { ok: true, synced: false, reason: "up-to-date" };
    }
    if (lastFailedAt > 0 && Date.now() - lastFailedAt < cooldownMs) {
      return { ok: false, synced: false, reason: "cooldown" };
    }

    const persistedState = store?.readSettings?.()?.botComputer?.state;
    if (persistedState === "creating" || persistedState === "uncreated") {
      return { ok: true, synced: false, reason: `state:${persistedState}` };
    }

    let health: any = null;
    try {
      health = await executor!.health!({ timeoutMs: 2500, skipWake: true });
    } catch {
      return { ok: true, synced: false, reason: "unreachable" };
    }
    if (!health || health.ok === false) {
      return { ok: true, synced: false, reason: "unhealthy" };
    }

    const remoteSha = String(health.executor_sha256 || "").trim();
    if (remoteSha && remoteSha === localSha) {
      verifiedSha = localSha;
      return { ok: true, synced: false, reason: "up-to-date" };
    }

    try {
      const upd = await updateBotComputerFn({
        platform,
        projectRoot,
        executor,
        executorToken,
        ...(execFileFn ? { execFileFn } : {}),
      });
      verifiedSha = localSha;
      lastFailedAt = 0;
      try {
        const prevBc = store?.readSettings?.()?.botComputer || {};
        store?.writeSettings?.({
          botComputer: {
            ...prevBc,
            state: "ready",
            updatedAt: upd.updatedAt,
            ...(upd.distro ? { distro: upd.distro } : {}),
          },
        });
      } catch {
        // non-fatal persistence error
      }
      console.log(
        `[TwinkleBot] Auto-synced Bot Computer executor.py (${reason}, ${remoteSha || "legacy"} -> ${localSha})`
      );
      return { ok: true, synced: true, updatedAt: upd.updatedAt };
    } catch (err: any) {
      lastFailedAt = Date.now();
      const msg = err?.message || String(err);
      console.warn(`[TwinkleBot] Auto-sync executor.py skipped (${reason}): ${msg}`);
      return { ok: false, synced: false, error: msg };
    }
  }

  return {
    syncIfOutdated(reason = "manual"): Promise<AutoSyncExecutorResult> {
      if (!eligible || disposed || verifiedSha === localSha) {
        return Promise.resolve({ ok: true, synced: false, reason: "up-to-date" });
      }
      if (!inflight) {
        inflight = runCheck(reason).finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    scheduleStartupSync(delayMs = 1500): void {
      if (!eligible || disposed || startupTimer) return;
      startupTimer = setTimeout(() => {
        startupTimer = null;
        if (!disposed) {
          void this.syncIfOutdated("startup").catch(() => {});
        }
      }, Math.max(0, delayMs));
      if (typeof (startupTimer as any)?.unref === "function") {
        (startupTimer as any).unref();
      }
    },
    isSynced(): boolean {
      return Boolean(localSha) && verifiedSha === localSha;
    },
    dispose(): void {
      disposed = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
    },
  };
}
