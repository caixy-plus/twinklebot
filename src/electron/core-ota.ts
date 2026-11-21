import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isTrustedGithubReleaseUrl } from "../lib/github-releases.js";
import { extractTarGzSafely } from "../lib/tar-gzip.js";
import { compareSemver, compareWebBuild } from "../shared/versioning.js";
import { sanitizeOtaBuildId } from "./web-ota.js";

export interface DesktopCoreOtaState {
  builtInAppVersion: string;
  activeBuild: string | null;
  lastGoodBuild: string | null;
  pendingBuild: string | null;
  bootAttempts: number;
  lastRollbackReason: string;
  updatedAt: string;
}

export interface CoreOtaProgressEvent {
  phase:
    | "downloading"
    | "verifying"
    | "extracting"
    | "waiting_idle"
    | "applying"
    | "rollback"
    | "done"
    | "error";
  percent: number;
  message?: string;
  webBuild?: string;
  coreBuild?: string;
  activeRunCount?: number;
}

export interface DesktopCoreOtaStatus extends DesktopCoreOtaState {
  supportsCoreOta: true;
  usingBuiltIn: boolean;
  effectiveCoreDir: string;
  effectivePublicDir: string;
  activeCoreBuild: string;
  activeCoreVersion: string;
  activeWebMeta: Record<string, any> | null;
  activeCoreMeta: Record<string, any> | null;
}

export interface CoreOtaManagerOptions {
  userDataDir: string;
  appVersion: string;
  builtInCoreDir: string;
  fallbackBuiltInPublicDir?: string;
  watchdogTimeoutMs?: number;
  allowLoopbackForTest?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  onProgress?: (ev: CoreOtaProgressEvent) => void;
  onRollbackApplied?: (status: DesktopCoreOtaStatus, reason: string) => void | Promise<void>;
}

const DEFAULT_WATCHDOG_MS = 8000;

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function resolveUnpackedElectronPath(rawPath: string): string {
  const unpacked = rawPath.replace(/\.asar([/\\])/, ".asar.unpacked$1");
  if (unpacked !== rawPath && fs.existsSync(unpacked)) {
    return unpacked;
  }
  return rawPath;
}

function isAllowedDesktopOtaUrl(rawUrl: string, allowLoopback = false): boolean {
  if (isTrustedGithubReleaseUrl(rawUrl)) return true;
  if (!allowLoopback) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol === "http:") {
      const h = u.hostname.toLowerCase();
      return h === "127.0.0.1" || h === "localhost" || h === "::1";
    }
    return false;
  } catch {
    return false;
  }
}

export function createCoreOtaManager(options: CoreOtaManagerOptions) {
  const userDataDir = path.resolve(options.userDataDir);
  const builtInCoreDir = resolveUnpackedElectronPath(path.resolve(options.builtInCoreDir));
  const fallbackBuiltInPublicDir = options.fallbackBuiltInPublicDir
    ? resolveUnpackedElectronPath(path.resolve(options.fallbackBuiltInPublicDir))
    : path.join(builtInCoreDir, "public");

  const otaRoot = path.join(userDataDir, "ota-core");
  const releasesDir = path.join(otaRoot, "releases");
  const stagingDir = path.join(otaRoot, "staging");
  const statePath = path.join(otaRoot, "state.json");
  const watchdogMs = Math.max(20, Number(options.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_MS));
  const fetchFn = options.fetchImpl || globalThis.fetch;

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let state = initState();

  function releaseDirFor(buildId: string): string {
    return path.join(releasesDir, sanitizeOtaBuildId(buildId));
  }

  function hasValidCoreFilesInDir(dir: string): boolean {
    try {
      const hasEntry =
        fs.existsSync(path.join(dir, "server-bundle.mjs")) ||
        fs.existsSync(path.join(dir, "dist-server", "src", "server", "desktop-backend-worker.js"));
      const hasHtml = fs.existsSync(path.join(dir, "public", "index.html"));
      if (!hasEntry || !hasHtml) return false;

      const meta = readJsonSafe<{ minShellVersion?: string }>(path.join(dir, "core-meta.json"));
      if (meta?.minShellVersion) {
        if (compareSemver(options.appVersion || "0.0.0", meta.minShellVersion) < 0) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  function hasValidRelease(buildId: string | null): boolean {
    if (!buildId) return false;
    try {
      return hasValidCoreFilesInDir(releaseDirFor(buildId));
    } catch {
      return false;
    }
  }

  function saveState(next: DesktopCoreOtaState): DesktopCoreOtaState {
    state = next;
    writeJsonAtomic(statePath, state);
    return state;
  }

  function clearWatchdog(): void {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function initState(): DesktopCoreOtaState {
    fs.mkdirSync(releasesDir, { recursive: true });
    const loaded = readJsonSafe<Partial<DesktopCoreOtaState>>(statePath);
    const builtInCoreMeta = readJsonSafe<{ coreBuild?: string; webBuild?: string }>(
      path.join(builtInCoreDir, "core-meta.json")
    );
    const builtInWebMeta = readJsonSafe<{ webBuild?: string }>(
      path.join(fallbackBuiltInPublicDir, "web-meta.json")
    );
    const builtInBuild = String(
      builtInCoreMeta?.coreBuild || builtInCoreMeta?.webBuild || builtInWebMeta?.webBuild || ""
    ).trim();
    const cachedBuildRef =
      loaded?.activeBuild || loaded?.pendingBuild || loaded?.lastGoodBuild || "";
    const builtInNewerOrEqual =
      Boolean(builtInBuild) &&
      Boolean(cachedBuildRef) &&
      compareWebBuild(builtInBuild, cachedBuildRef) >= 0;

    // Clear stale Core / legacy Web OTA caches whenever native shell upgrades or ships a newer/equal built-in runtime
    if (!loaded || loaded.builtInAppVersion !== options.appVersion || builtInNewerOrEqual) {
      try {
        fs.rmSync(releasesDir, { recursive: true, force: true });
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.rmSync(path.join(userDataDir, "ota-web"), { recursive: true, force: true });
        fs.mkdirSync(releasesDir, { recursive: true });
      } catch {}
      const fresh: DesktopCoreOtaState = {
        builtInAppVersion: options.appVersion,
        activeBuild: null,
        lastGoodBuild: null,
        pendingBuild: null,
        bootAttempts: 0,
        lastRollbackReason: "",
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(statePath, fresh);
      return fresh;
    }

    let activeBuild = loaded.activeBuild || null;
    let lastGoodBuild = loaded.lastGoodBuild || null;
    let pendingBuild = loaded.pendingBuild || null;
    let bootAttempts = Number(loaded.bootAttempts || 0);
    let lastRollbackReason = String(loaded.lastRollbackReason || "");

    if (lastGoodBuild && !hasValidRelease(lastGoodBuild)) {
      lastGoodBuild = null;
    }

    // Boot crash-loop protection: unconfirmed pendingBuild exceeding 1 prior failed boot rolls back cleanly
    if (pendingBuild) {
      bootAttempts += 1;
      if (bootAttempts >= 2 || !hasValidRelease(pendingBuild)) {
        const failed = pendingBuild;
        const fallback = lastGoodBuild && hasValidRelease(lastGoodBuild) ? lastGoodBuild : null;
        lastRollbackReason = `核心更新包 ${failed} 未通过启动确认，已自动回滚至${
          fallback || "内置基线版"
        }`;
        activeBuild = fallback;
        pendingBuild = null;
        bootAttempts = 0;
        try {
          fs.rmSync(releaseDirFor(failed), { recursive: true, force: true });
        } catch {}
      }
    } else if (activeBuild && !hasValidRelease(activeBuild)) {
      activeBuild = lastGoodBuild && hasValidRelease(lastGoodBuild) ? lastGoodBuild : null;
    }

    const next: DesktopCoreOtaState = {
      builtInAppVersion: options.appVersion,
      activeBuild,
      lastGoodBuild,
      pendingBuild,
      bootAttempts,
      lastRollbackReason,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(statePath, next);
    return next;
  }

  function getEffectiveCoreDir(): string {
    if (state.activeBuild && hasValidRelease(state.activeBuild)) {
      return releaseDirFor(state.activeBuild);
    }
    return builtInCoreDir;
  }

  function getEffectivePublicDir(): string {
    const coreDir = getEffectiveCoreDir();
    const candidate = path.join(coreDir, "public");
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
    return fallbackBuiltInPublicDir;
  }

  function getEffectiveServerEntry(repoFallbackRoot?: string): string {
    const coreDir = getEffectiveCoreDir();
    const bundled = path.join(coreDir, "server-bundle.mjs");
    if (fs.existsSync(bundled)) return bundled;
    const workerJs = path.join(coreDir, "dist-server", "src", "server", "desktop-backend-worker.js");
    if (fs.existsSync(workerJs)) return workerJs;
    if (repoFallbackRoot) {
      const repoBundled = resolveUnpackedElectronPath(
        path.join(repoFallbackRoot, "dist-server", "core-runtime", "server-bundle.mjs")
      );
      if (fs.existsSync(repoBundled)) return repoBundled;
      const repoWorker = path.join(
        repoFallbackRoot,
        "dist-server",
        "src",
        "server",
        "desktop-backend-worker.js"
      );
      if (fs.existsSync(repoWorker)) return repoWorker;
    }
    return bundled;
  }

  function getStatus(): DesktopCoreOtaStatus {
    const coreDir = getEffectiveCoreDir();
    const publicDir = getEffectivePublicDir();
    const coreMeta = readJsonSafe<Record<string, any>>(path.join(coreDir, "core-meta.json"));
    const webMeta = readJsonSafe<Record<string, any>>(path.join(publicDir, "web-meta.json"));
    const activeCoreBuild = String(
      coreMeta?.coreBuild || state.activeBuild || webMeta?.webBuild || `${options.appVersion}-builtin`
    );
    const activeCoreVersion = String(coreMeta?.coreVersion || options.appVersion);
    return {
      ...state,
      supportsCoreOta: true,
      usingBuiltIn: coreDir === builtInCoreDir,
      effectiveCoreDir: coreDir,
      effectivePublicDir: publicDir,
      activeCoreBuild,
      activeCoreVersion,
      activeWebMeta: webMeta,
      activeCoreMeta: coreMeta,
    };
  }

  function armWatchdog(buildId: string): void {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (state.pendingBuild === buildId) {
        rollback(`核心热更新包 ${buildId} 在 ${watchdogMs}ms 内未完成首屏与服务就绪确认，已自动回滚`);
      }
    }, watchdogMs);
    watchdogTimer.unref?.();
  }

  function activatePreparedBuild(buildId: string): DesktopCoreOtaStatus {
    const cleanBuild = sanitizeOtaBuildId(buildId);
    if (!hasValidRelease(cleanBuild)) {
      throw new Error(`核心热更新包 ${cleanBuild} 校验无效或文件缺失`);
    }
    saveState({
      ...state,
      activeBuild: cleanBuild,
      pendingBuild: cleanBuild,
      bootAttempts: 1,
      lastRollbackReason: "",
      updatedAt: new Date().toISOString(),
    });
    armWatchdog(cleanBuild);
    return getStatus();
  }

  function confirmReady(buildId?: string): DesktopCoreOtaStatus {
    clearWatchdog();
    if (
      state.pendingBuild &&
      (!buildId || buildId === state.pendingBuild || buildId === getStatus().activeWebMeta?.webBuild)
    ) {
      const confirmed = state.pendingBuild;
      const oldLastGood = state.lastGoodBuild;
      saveState({
        ...state,
        activeBuild: confirmed,
        lastGoodBuild: confirmed,
        pendingBuild: null,
        bootAttempts: 0,
        lastRollbackReason: "",
        updatedAt: new Date().toISOString(),
      });
      try {
        for (const ent of fs.readdirSync(releasesDir)) {
          if (ent !== confirmed && ent !== oldLastGood && hasValidRelease(ent)) {
            fs.rmSync(path.join(releasesDir, ent), { recursive: true, force: true });
          } else if (ent !== confirmed && ent !== oldLastGood) {
            fs.rmSync(path.join(releasesDir, ent), { recursive: true, force: true });
          }
        }
      } catch {}
    } else if (state.bootAttempts > 0) {
      saveState({
        ...state,
        bootAttempts: 0,
        updatedAt: new Date().toISOString(),
      });
    }
    return getStatus();
  }

  function rollback(reason = "用户手动触发回滚"): DesktopCoreOtaStatus {
    clearWatchdog();
    const failed = state.pendingBuild || state.activeBuild;
    const fallback =
      state.lastGoodBuild &&
      state.lastGoodBuild !== failed &&
      hasValidRelease(state.lastGoodBuild)
        ? state.lastGoodBuild
        : null;

    saveState({
      ...state,
      activeBuild: fallback,
      pendingBuild: null,
      bootAttempts: 0,
      lastRollbackReason: reason,
      updatedAt: new Date().toISOString(),
    });
    if (failed && failed !== fallback) {
      try {
        fs.rmSync(releaseDirFor(failed), { recursive: true, force: true });
      } catch {}
    }
    const status = getStatus();
    options.onProgress?.({
      phase: "rollback",
      percent: 100,
      message: reason,
      coreBuild: status.activeCoreBuild,
      webBuild: status.activeCoreBuild,
    });
    void Promise.resolve(options.onRollbackApplied?.(status, reason)).catch(() => {});
    return status;
  }

  function rollbackToBuiltIn(): DesktopCoreOtaStatus {
    clearWatchdog();
    saveState({
      ...state,
      activeBuild: null,
      lastGoodBuild: null,
      pendingBuild: null,
      bootAttempts: 0,
      lastRollbackReason: "",
      updatedAt: new Date().toISOString(),
    });
    try {
      fs.rmSync(releasesDir, { recursive: true, force: true });
      fs.mkdirSync(releasesDir, { recursive: true });
    } catch {}
    const status = getStatus();
    void Promise.resolve(
      options.onRollbackApplied?.(status, "已恢复随包内置基线核心版本")
    ).catch(() => {});
    return status;
  }

  function notifyRenderFailure(reason: string): DesktopCoreOtaStatus {
    if (!state.pendingBuild) return getStatus();
    return rollback(reason);
  }

  async function stageFromUrl(params: {
    bundleUrl: string;
    expectedSha256: string;
    coreBuild?: string;
    webBuild?: string;
  }): Promise<{ cleanBuild: string; releaseDir: string; coreMeta: Record<string, any> | null }> {
    const cleanBuild = sanitizeOtaBuildId(params.coreBuild || params.webBuild || "");
    const expectedHash = String(params.expectedSha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error("无效的核心更新包 SHA-256 摘要");
    }
    const allowLoopback = Boolean(options.allowLoopbackForTest);
    if (!isAllowedDesktopOtaUrl(params.bundleUrl, allowLoopback)) {
      throw new Error(`未受信任的 GitHub Releases 下载地址: ${params.bundleUrl}`);
    }

    options.onProgress?.({
      phase: "downloading",
      percent: 15,
      webBuild: cleanBuild,
      coreBuild: cleanBuild,
      message: "正在从 GitHub Releases 下载核心运行时热更新包…",
    });

    const res = await fetchFn(params.bundleUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`下载核心更新包失败: HTTP ${res.status}`);
    }
    const finalUrl = res.url || params.bundleUrl;
    if (!isAllowedDesktopOtaUrl(finalUrl, allowLoopback)) {
      throw new Error(`更新包重定向到了未受信任地址: ${finalUrl}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());

    options.onProgress?.({
      phase: "verifying",
      percent: 55,
      webBuild: cleanBuild,
      coreBuild: cleanBuild,
      message: "正在校验 SHA-256 与包结构安全性…",
    });
    const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(
        `更新包 SHA-256 校验失败 (expected ${expectedHash.slice(0, 12)}, got ${actualHash.slice(0, 12)})`
      );
    }

    fs.mkdirSync(stagingDir, { recursive: true });
    const tmpArchive = path.join(stagingDir, `${cleanBuild}.tar.gz`);
    const tmpExtract = path.join(stagingDir, `${cleanBuild}-extract`);
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.writeFileSync(tmpArchive, buf);

    options.onProgress?.({
      phase: "extracting",
      percent: 78,
      webBuild: cleanBuild,
      coreBuild: cleanBuild,
      message: "正在安全解压核心服务与前端资源…",
    });

    try {
      await extractTarGzSafely(tmpArchive, tmpExtract);
      if (!hasValidCoreFilesInDir(tmpExtract)) {
        throw new Error("核心热更新包不完整，或当前桌面原生壳版本过低无法兼容该 Core 包");
      }
      const targetDir = releaseDirFor(cleanBuild);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(releasesDir, { recursive: true });
      fs.renameSync(tmpExtract, targetDir);
      const coreMeta = readJsonSafe<Record<string, any>>(path.join(targetDir, "core-meta.json"));
      return { cleanBuild, releaseDir: targetDir, coreMeta };
    } finally {
      try {
        fs.rmSync(tmpArchive, { force: true });
        fs.rmSync(tmpExtract, { recursive: true, force: true });
      } catch {}
    }
  }

  async function applyFromUrl(params: {
    bundleUrl: string;
    expectedSha256: string;
    coreBuild?: string;
    webBuild?: string;
  }): Promise<DesktopCoreOtaStatus> {
    const { cleanBuild } = await stageFromUrl(params);
    return activatePreparedBuild(cleanBuild);
  }

  function dispose(): void {
    clearWatchdog();
  }

  return {
    getStatus,
    getEffectiveCoreDir,
    getEffectivePublicDir,
    getEffectiveServerEntry,
    hasValidRelease,
    stageFromUrl,
    activatePreparedBuild,
    applyFromUrl,
    confirmReady,
    rollback,
    rollbackToBuiltIn,
    notifyRenderFailure,
    dispose,
  };
}

export type CoreOtaManager = ReturnType<typeof createCoreOtaManager>;
