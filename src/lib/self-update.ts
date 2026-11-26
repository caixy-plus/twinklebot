import fs from "node:fs";
import type { ServerContext } from "../server/context.js";
import {
  fetchLatestGithubManifest,
  readEffectiveWebMeta,
} from "./github-releases.js";
import {
  evaluateUpdateCompatibility,
  type DesktopArchKey,
} from "../shared/versioning.js";

export interface CreateSelfUpdateActionsOptions {
  projectRoot: string;
  publicDir: string;
  appVersion: string;
  getEffectivePublicDir?: () => string;
  otaController?: ServerContext["otaController"] | null;
  fetchImpl?: typeof globalThis.fetch;
}

function resolvePlatformArch(): DesktopArchKey | undefined {
  const key = `${process.platform}-${process.arch}`;
  if (
    key === "darwin-arm64" ||
    key === "darwin-x64" ||
    key === "win32-x64" ||
    key === "linux-x64"
  ) {
    return key;
  }
  return undefined;
}

export function createSelfUpdateActions(options: CreateSelfUpdateActionsOptions) {
  const {
    projectRoot,
    publicDir,
    appVersion,
    getEffectivePublicDir,
    otaController = null,
    fetchImpl = globalThis.fetch,
  } = options;

  function resolvePublicDir(): string {
    try {
      const candidate = getEffectivePublicDir?.();
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {}
    return publicDir;
  }

  async function readCurrentOtaStatus() {
    if (!otaController) return null;
    if (typeof otaController.getStatusAsync === "function") {
      try {
        return await otaController.getStatusAsync();
      } catch {}
    }
    try {
      return otaController.getStatus?.() || null;
    } catch {
      return null;
    }
  }

  async function status() {
    const otaStatus = await readCurrentOtaStatus();
    const webMeta = readEffectiveWebMeta({
      effectivePublicDir: resolvePublicDir(),
      projectRoot,
      appVersion,
    });
    const platformArch = `${process.platform}-${process.arch}`;
    return {
      ok: true,
      action: "status",
      appVersion: otaStatus?.builtInAppVersion || appVersion,
      webBuild: webMeta.webBuild,
      coreBuild: otaStatus?.activeCoreBuild || webMeta.webBuild,
      supportsCoreOta: Boolean(otaStatus?.supportsCoreOta),
      supportsSelfUpdate: Boolean(otaController?.applyUpdate),
      supportsRollback: Boolean(otaController?.rollbackAsync || otaController?.rollback),
      platformArch,
      otaStatus,
    };
  }

  async function check({ force = true }: { force?: boolean } = {}) {
    const otaStatus = await readCurrentOtaStatus();
    const webMeta = readEffectiveWebMeta({
      effectivePublicDir: resolvePublicDir(),
      projectRoot,
      appVersion,
    });
    const nativeVersion = String(otaStatus?.builtInAppVersion || appVersion || "1.0.0");
    const activeCoreBuild = String(otaStatus?.activeCoreBuild || webMeta.webBuild || "");
    const supportsCoreOta = Boolean(otaStatus?.supportsCoreOta);
    const desktopArch = resolvePlatformArch();

    let fetched: Awaited<ReturnType<typeof fetchLatestGithubManifest>>;
    try {
      fetched = await fetchLatestGithubManifest({
        projectRoot,
        currentAppVersion: nativeVersion,
        fetchImpl,
        force,
      });
    } catch (err: any) {
      return {
        ok: false,
        action: "check",
        code: String(err?.code || "GITHUB_UNREACHABLE"),
        error: String(err?.message || "检查版本更新失败"),
        currentVersion: nativeVersion,
        currentWebBuild: webMeta.webBuild,
        currentCoreBuild: activeCoreBuild,
        supportsSelfUpdate: Boolean(otaController?.applyUpdate),
      };
    }

    const decision = evaluateUpdateCompatibility(fetched.manifest, {
      platform: supportsCoreOta ? "desktop" : "web",
      nativeVersion,
      activeWebBuild: webMeta.webBuild,
      activeCoreBuild,
      supportsCoreOta,
      ...(desktopArch ? { desktopArch } : {}),
      locale: "zh-CN",
    });

    const bundle = decision.otaBundle || null;
    const latestCoreBuild =
      decision.latestCoreBuild ||
      fetched.manifest.bundles?.desktopCore?.coreBuild ||
      fetched.manifest.coreBuild ||
      "";
    const latestWebBuild = decision.latestWebBuild || fetched.manifest.webBuild || "";

    return {
      ok: true,
      action: "check",
      status: decision.status,
      source: fetched.source,
      cached: fetched.cached,
      githubRepo: fetched.githubRepo,
      currentVersion: nativeVersion,
      currentWebBuild: webMeta.webBuild,
      currentCoreBuild: activeCoreBuild,
      latestWebBuild,
      latestCoreBuild,
      releaseTag: decision.releaseTag || fetched.manifest.releaseTag,
      releaseUrl: decision.releaseUrl || fetched.manifest.releaseUrl,
      releaseNotes: decision.releaseNotes || fetched.manifest.releaseNotes,
      supportsSelfUpdate: Boolean(otaController?.applyUpdate),
      canApplyOta: Boolean(
        decision.status === "ota-available" &&
          bundle?.bundleUrl &&
          bundle?.sha256 &&
          otaController?.applyUpdate
      ),
      otaKind: decision.otaKind || (bundle ? "core" : undefined),
      otaBundle: bundle,
      coreBundle: decision.coreBundle || null,
      shellUpdate: decision.shellUpdate || null,
      optionalShellUpdate: decision.optionalShellUpdate || null,
      reason: decision.reason || "",
      otaStatus,
    };
  }

  async function apply({ force = false }: { force?: boolean } = {}) {
    const checked = await check({ force: true });
    if (!checked.ok) {
      return {
        ...checked,
        action: "apply",
      };
    }

    if (checked.status === "up-to-date") {
      return {
        ok: true,
        action: "apply",
        status: "up-to-date",
        alreadyUpToDate: true,
        currentVersion: checked.currentVersion,
        currentWebBuild: checked.currentWebBuild,
        currentCoreBuild: checked.currentCoreBuild,
        releaseTag: checked.releaseTag,
        message: "当前已是最新版本，无需更新。",
      };
    }

    if (checked.status === "shell-update-required") {
      return {
        ok: false,
        action: "apply",
        status: "shell-update-required",
        error:
          checked.reason ||
          "发现新版原生壳，热更新与原生壳版本严格绑定，请先下载安装新版安装包。",
        shellUpdate: checked.shellUpdate,
        releaseTag: checked.releaseTag,
        releaseUrl: checked.releaseUrl,
      };
    }

    if (checked.status !== "ota-available" || !checked.otaBundle?.bundleUrl || !checked.otaBundle?.sha256) {
      if (!otaController?.applyUpdate) {
        return {
          ok: false,
          action: "apply",
          unsupported: true,
          status: checked.status,
          releaseTag: checked.releaseTag,
          releaseUrl: checked.releaseUrl,
          latestWebBuild: checked.latestWebBuild,
          latestCoreBuild: checked.latestCoreBuild,
          error:
            "当前运行环境非桌面端 Electron Core OTA 托管模式，不支持 Bot 自动下载并应用热更新。",
        };
      }
      return {
        ok: false,
        action: "apply",
        status: checked.status,
        error: checked.reason || "当前更新包缺少可用的下载地址或 SHA-256 校验摘要。",
        releaseTag: checked.releaseTag,
        releaseUrl: checked.releaseUrl,
      };
    }

    if (!otaController?.applyUpdate) {
      return {
        ok: false,
        action: "apply",
        unsupported: true,
        status: checked.status,
        latestWebBuild: checked.latestWebBuild,
        latestCoreBuild: checked.latestCoreBuild,
        releaseTag: checked.releaseTag,
        releaseUrl: checked.releaseUrl,
        error:
          "当前运行环境非桌面端 Electron Core OTA 托管模式，不支持 Bot 自动下载并应用热更新。",
      };
    }

    const targetBuild =
      checked.otaBundle.webBuild || checked.latestCoreBuild || checked.latestWebBuild;
    const applyRes = await otaController.applyUpdate({
      bundleUrl: checked.otaBundle.bundleUrl,
      sha256: checked.otaBundle.sha256,
      coreBuild: targetBuild,
      force: Boolean(force),
    });

    if (!applyRes?.ok) {
      return {
        ok: false,
        action: "apply",
        status: "error",
        targetBuild,
        releaseTag: checked.releaseTag,
        otaStatus: applyRes?.status || checked.otaStatus,
        error: applyRes?.error || "下载或应用 OTA 热更新失败",
      };
    }

    const queuedForIdle = Boolean(applyRes.queuedForIdle);
    return {
      ok: true,
      action: "apply",
      status: queuedForIdle ? "deferred" : "applied",
      queuedForIdle,
      activeRunCount: Number(applyRes.activeRunCount || 0),
      targetBuild,
      releaseTag: checked.releaseTag,
      releaseNotes: checked.releaseNotes,
      otaStatus: applyRes.status || null,
      deferredSwitch: applyRes.deferredSwitch || null,
      message: queuedForIdle
        ? `新版本 ${targetBuild}（${checked.releaseTag}）已通过 SHA-256 校验并就绪；等当前 Bot 本轮回复结束后将自动平滑切换重启（含 Watchdog 自动回滚保护）。`
        : `已成功校验并切换至新版本 ${targetBuild}（${checked.releaseTag}），核心服务与前端资源已平滑重启加载。`,
    };
  }

  async function rollback({
    mode = "previous",
    reason,
  }: { mode?: "previous" | "builtin"; reason?: string } = {}) {
    const cleanMode = mode === "builtin" ? "builtin" : "previous";
    const cleanReason = String(reason || "").trim() || "Bot 触发回滚至稳定版本";

    if (!otaController) {
      return {
        ok: false,
        action: "rollback",
        unsupported: true,
        error: "当前运行环境不支持自动 OTA 回滚。",
      };
    }

    if (typeof otaController.rollbackAsync === "function") {
      const rbRes = await otaController.rollbackAsync({
        mode: cleanMode,
        reason: cleanReason,
        restart: true,
      });
      if (!rbRes?.ok) {
        return {
          ok: false,
          action: "rollback",
          mode: cleanMode,
          otaStatus: rbRes?.status || null,
          error: rbRes?.error || "OTA 回滚失败",
        };
      }
      const queuedForIdle = Boolean(rbRes.queuedForIdle);
      return {
        ok: true,
        action: "rollback",
        mode: cleanMode,
        status: queuedForIdle ? "deferred" : "rolled_back",
        queuedForIdle,
        activeRunCount: Number(rbRes.activeRunCount || 0),
        otaStatus: rbRes.status || null,
        message: queuedForIdle
          ? `已标记回滚至${cleanMode === "builtin" ? "随包内置基线版本" : "上一稳定版本"}，将在当前 Bot 回复结束后自动平滑重启生效。`
          : `已回滚至${cleanMode === "builtin" ? "随包内置基线版本" : "上一稳定版本"}并重启加载。`,
      };
    }

    if (typeof otaController.rollback === "function") {
      const st = otaController.rollback(cleanReason);
      return {
        ok: true,
        action: "rollback",
        mode: cleanMode,
        status: "rolled_back",
        queuedForIdle: false,
        otaStatus: st || null,
        message: "已执行回滚状态切换。",
      };
    }

    return {
      ok: false,
      action: "rollback",
      unsupported: true,
      error: "当前运行环境不支持自动 OTA 回滚。",
    };
  }

  return {
    status,
    check,
    apply,
    rollback,
  };
}

export type SelfUpdateActions = ReturnType<typeof createSelfUpdateActions>;
