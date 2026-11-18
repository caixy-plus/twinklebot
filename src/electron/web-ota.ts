import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isTrustedGithubReleaseUrl } from "../lib/github-releases.js";
import { extractTarGzSafely } from "../lib/tar-gzip.js";

export interface DesktopWebOtaState {
  builtInAppVersion: string;
  activeBuild: string | null;
  lastGoodBuild: string | null;
  pendingBuild: string | null;
  bootAttempts: number;
  lastRollbackReason: string;
  updatedAt: string;
}

export interface DesktopWebOtaStatus extends DesktopWebOtaState {
  usingBuiltIn: boolean;
  effectivePublicDir: string;
  activeWebMeta: Record<string, any> | null;
}

export interface WebOtaManagerOptions {
  userDataDir: string;
  appVersion: string;
  builtInPublicDir: string;
  watchdogTimeoutMs?: number;
  allowLoopbackForTest?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  onReloadRequest?: (reason: string) => void;
  onProgress?: (ev: {
    phase: "downloading" | "verifying" | "extracting" | "applying" | "rollback" | "done" | "error";
    percent: number;
    message?: string;
    webBuild?: string;
  }) => void;
}

const DEFAULT_WATCHDOG_MS = 5000;

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, payload: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
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

export function sanitizeOtaBuildId(raw: string): string {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9._+-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("Invalid webBuild identifier");
  }
  return cleaned;
}

export function createWebOtaManager(options: WebOtaManagerOptions) {
  const otaRoot = path.join(path.resolve(options.userDataDir), "ota-web");
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

  function hasValidRelease(buildId: string | null): boolean {
    if (!buildId) return false;
    try {
      const dir = releaseDirFor(buildId);
      return fs.existsSync(path.join(dir, "index.html"));
    } catch {
      return false;
    }
  }

  function saveState(next: DesktopWebOtaState): DesktopWebOtaState {
    state = next;
    writeJsonAtomic(statePath, state);
    return state;
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function initState(): DesktopWebOtaState {
    fs.mkdirSync(releasesDir, { recursive: true });
    const loaded = readJsonSafe<Partial<DesktopWebOtaState>>(statePath);

    // If native binary upgraded to a new appVersion, clear old OTA overrides cleanly
    if (!loaded || loaded.builtInAppVersion !== options.appVersion) {
      try {
        fs.rmSync(releasesDir, { recursive: true, force: true });
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.mkdirSync(releasesDir, { recursive: true });
      } catch {}
      const fresh: DesktopWebOtaState = {
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

    // Boot crash loop guard: if pendingBuild exceeded attempts without confirmReady -> roll back immediately
    if (pendingBuild) {
      bootAttempts += 1;
      if (bootAttempts >= 2 || !hasValidRelease(pendingBuild)) {
        const failed = pendingBuild;
        const fallback = lastGoodBuild && hasValidRelease(lastGoodBuild) ? lastGoodBuild : null;
        lastRollbackReason = `版本 ${failed} 未通过启动确认，已自动回滚至${fallback || "内置基线版"}`;
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

    const next: DesktopWebOtaState = {
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

  function startWatchdog(buildId: string) {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (state.pendingBuild === buildId) {
        rollback(
          `前端热更新包 ${buildId} 在 ${watchdogMs}ms 内未完成首屏就绪确认，已自动回滚`
        );
      }
    }, watchdogMs);
    if (typeof watchdogTimer.unref === "function") {
      watchdogTimer.unref();
    }
  }

  if (state.pendingBuild) {
    startWatchdog(state.pendingBuild);
  }

  function getEffectivePublicDir(): string {
    if (state.activeBuild && hasValidRelease(state.activeBuild)) {
      return releaseDirFor(state.activeBuild);
    }
    return options.builtInPublicDir;
  }

  function getStatus(): DesktopWebOtaStatus {
    const dir = getEffectivePublicDir();
    const meta = readJsonSafe<Record<string, any>>(path.join(dir, "web-meta.json"));
    return {
      ...state,
      usingBuiltIn: dir === options.builtInPublicDir,
      effectivePublicDir: dir,
      activeWebMeta: meta,
    };
  }

  function confirmReady(webBuild?: string): DesktopWebOtaStatus {
    clearWatchdog();
    if (state.pendingBuild && (!webBuild || webBuild === state.pendingBuild)) {
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
      // Prune older releases beyond current + previous
      try {
        for (const ent of fs.readdirSync(releasesDir)) {
          if (ent !== confirmed && ent !== oldLastGood) {
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

  function rollback(reason = "用户手动触发回滚"): DesktopWebOtaStatus {
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
    options.onProgress?.({ phase: "rollback", percent: 100, message: reason });
    options.onReloadRequest?.(reason);
    return getStatus();
  }

  function rollbackToBuiltIn(): DesktopWebOtaStatus {
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
    options.onReloadRequest?.("已恢复内置基线前端资源");
    return getStatus();
  }

  function notifyRenderFailure(reason: string): DesktopWebOtaStatus {
    if (!state.pendingBuild) return getStatus();
    return rollback(reason);
  }

  async function applyFromUrl(params: {
    bundleUrl: string;
    expectedSha256: string;
    webBuild: string;
  }): Promise<DesktopWebOtaStatus> {
    const cleanBuild = sanitizeOtaBuildId(params.webBuild);
    const expectedHash = String(params.expectedSha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error("无效的更新包 SHA-256 摘要");
    }
    const allowLoopback = Boolean(options.allowLoopbackForTest);
    if (!isAllowedDesktopOtaUrl(params.bundleUrl, allowLoopback)) {
      throw new Error(`未受信任的 GitHub Releases 下载地址: ${params.bundleUrl}`);
    }

    options.onProgress?.({
      phase: "downloading",
      percent: 15,
      webBuild: cleanBuild,
      message: "正在从 GitHub Releases 下载前端热更新包…",
    });

    const res = await fetchFn(params.bundleUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      throw new Error(`下载更新包失败: HTTP ${res.status}`);
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
      message: "正在校验 SHA-256 完整性…",
    });
    const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error("更新包 SHA-256 校验失败，已中止应用");
    }

    options.onProgress?.({
      phase: "extracting",
      percent: 78,
      webBuild: cleanBuild,
      message: "正在安全解压资源…",
    });
    const stagePath = path.join(stagingDir, `${cleanBuild}-${Date.now()}`);
    const targetReleaseDir = releaseDirFor(cleanBuild);
    try {
      fs.rmSync(stagePath, { recursive: true, force: true });
      extractTarGzSafely(buf, stagePath);
      if (!fs.existsSync(path.join(stagePath, "index.html"))) {
        throw new Error("更新包缺少 index.html");
      }
      const meta = readJsonSafe<Record<string, any>>(path.join(stagePath, "web-meta.json"));
      if (meta && meta.webBuild && String(meta.webBuild) !== cleanBuild) {
        throw new Error(
          `更新包版本标识不匹配 (${meta.webBuild} !== ${cleanBuild})`
        );
      }

      fs.rmSync(targetReleaseDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetReleaseDir), { recursive: true });
      fs.renameSync(stagePath, targetReleaseDir);
    } finally {
      fs.rmSync(stagePath, { recursive: true, force: true });
    }

    options.onProgress?.({
      phase: "applying",
      percent: 94,
      webBuild: cleanBuild,
      message: "正在切换版本并刷新界面…",
    });

    const previousStable =
      state.activeBuild && !state.pendingBuild && hasValidRelease(state.activeBuild)
        ? state.activeBuild
        : state.lastGoodBuild;

    saveState({
      ...state,
      activeBuild: cleanBuild,
      lastGoodBuild: previousStable || null,
      pendingBuild: cleanBuild,
      bootAttempts: 0,
      lastRollbackReason: "",
      updatedAt: new Date().toISOString(),
    });

    startWatchdog(cleanBuild);
    options.onReloadRequest?.(`应用前端热更新 ${cleanBuild}`);
    options.onProgress?.({
      phase: "done",
      percent: 100,
      webBuild: cleanBuild,
      message: "热更新已就绪，正在刷新…",
    });
    return getStatus();
  }

  return {
    getEffectivePublicDir,
    getStatus,
    confirmReady,
    rollback,
    rollbackToBuiltIn,
    notifyRenderFailure,
    applyFromUrl,
    dispose: clearWatchdog,
  };
}
