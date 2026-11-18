import {
  CURRENT_API_CAPABILITIES,
  DEFAULT_GITHUB_REPO,
  OTA_CHANNEL_TAG,
  compareSemver,
  evaluateConnectedNodeStatus,
  evaluateUpdateCompatibility,
  nodeSupportsCapability,
  type CompatibilityDecision,
  type DesktopArchKey,
  type LocalUpdateEnv,
  type PlatformBinaryAsset,
  type UpdateTargetPlatform,
  type VersionManifest,
} from "/shared/versioning.js";
import {
  confirmMobileWebOtaReady,
  downloadAndApplyMobileWebOta,
  fetchMobileGithubJson,
  getMobilePlatform,
  getMobileWebUpdaterState,
  isMobileAppTarget,
  isNativeMobileContainer,
  onMobileWebOtaProgress,
  rollbackMobileWebOtaToBuiltIn,
} from "../mobile-bridge.js";
import { getState, setState } from "../state/store.js";
import { apiJson } from "./api-client.js";

const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const COLD_START_CHECK_COOLDOWN_MS = 60 * 1000;
const LAST_CHECK_STORAGE_KEY = "twinkle_update_last_checked_at";
const LAST_MANIFEST_STORAGE_KEY = "twinkle_update_last_manifest";
const DISMISSED_KEY_STORAGE_KEY = "twinkle_update_dismissed_key";

let unsubDesktopProgress: (() => void) | null = null;
let unsubMobileProgress: (() => void) | null = null;
let checkInFlight: Promise<any> | null = null;
let sessionLastSilentCheckAt = 0;

function readStorageStr(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorageStr(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {}
}

function readCachedManifest(): VersionManifest | null {
  try {
    const raw = readStorageStr(LAST_MANIFEST_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === 1 && parsed.shells) {
      return parsed as VersionManifest;
    }
  } catch {}
  return null;
}

function writeCachedManifest(manifest: VersionManifest) {
  try {
    writeStorageStr(LAST_MANIFEST_STORAGE_KEY, JSON.stringify(manifest));
  } catch {}
}

async function readLocalWebMeta(): Promise<Record<string, any> | null> {
  try {
    const res = await fetch("./web-meta.json", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

function resolveCurrentPlatform(): UpdateTargetPlatform {
  if (typeof window !== "undefined" && window.twinklebotDesktop?.isElectron) {
    return "desktop";
  }
  if (isNativeMobileContainer() || isMobileAppTarget()) {
    const mp = getMobilePlatform();
    if (mp === "android" || mp === "ios") return mp;
    return "android";
  }
  return "web";
}

function detectBrowserDesktopArch(): string {
  if (typeof window !== "undefined" && window.twinklebotDesktop?.platform) {
    return `${window.twinklebotDesktop.platform}-${window.twinklebotDesktop.arch || "arm64"}`;
  }
  const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "").toLowerCase() : "";
  if (ua.includes("win")) return "win32-x64";
  if (ua.includes("linux")) return "linux-x64";
  return "darwin-arm64";
}

export function computeUpdateDecisionKey(decision: CompatibilityDecision | null): string {
  if (!decision || decision.status === "up-to-date") return "";
  if (decision.status === "ota-available" && decision.otaBundle?.webBuild) {
    return `ota:${decision.otaBundle.webBuild}`;
  }
  if (decision.status === "shell-update-required" && decision.shellUpdate?.latestVersion) {
    return `shell:${decision.shellUpdate.latestVersion}:${decision.shellUpdate.latestBuildCode || 0}`;
  }
  return `${decision.status}:${decision.latestWebBuild || decision.releaseTag || ""}`;
}

/**
 * Runtime feature gate for multi-node deployments (e.g. mobile switching between a v1.2.0 LAN server
 * and a v1.3.0 Cloud server). Baseline v1.2.0 capabilities are always enabled on >=1.2.0 nodes.
 */
export function hasConnectedNodeCapability(
  capability: string,
  stateSnapshot: { diagnostics?: any } | null = getState()
): boolean {
  return nodeSupportsCapability(capability, stateSnapshot?.diagnostics);
}

/**
 * Re-evaluates the connected backend node's version status whenever `/api/system/diagnostics`
 * completes (such as after switching between LAN and Cloud accounts), without re-querying GitHub.
 */
export function syncConnectedNodeStatusWithManifest(diagnosticsOverride?: any) {
  const s = getState();
  const diag = diagnosticsOverride !== undefined ? diagnosticsOverride : s.diagnostics;
  const manifest = s.updateState?.latestManifest as VersionManifest | null;
  const connectedNodeStatus = evaluateConnectedNodeStatus(manifest, diag);
  setState((prev) => ({
    updateState: {
      ...prev.updateState,
      connectedNodeStatus,
    },
  }));
}

export async function refreshLocalUpdateMetadata() {
  const platform = resolveCurrentPlatform();
  const webMeta = await readLocalWebMeta();
  const diag = getState().diagnostics;

  let desktopArch = detectBrowserDesktopArch();
  let nativeVersion = String(webMeta?.appVersion || diag?.appVersion || "1.0.0");
  let nativeBuildCode: number | undefined;
  let activeWebBuild = String(webMeta?.webBuild || diag?.webBuild || "");
  let usingBuiltIn = true;
  let lastRollbackReason = "";

  if (platform === "desktop" && window.twinklebotDesktop?.getOtaStatus) {
    try {
      const st = await window.twinklebotDesktop.getOtaStatus();
      if (st) {
        if (st.platformArch) desktopArch = String(st.platformArch);
        nativeVersion = String(st.builtInAppVersion || nativeVersion);
        usingBuiltIn = st.usingBuiltIn !== false;
        lastRollbackReason = String(st.lastRollbackReason || "");
        if (st.activeWebMeta?.webBuild) {
          activeWebBuild = String(st.activeWebMeta.webBuild);
        } else if (st.activeBuild) {
          activeWebBuild = String(st.activeBuild);
        }
      }
    } catch {}
  } else if ((platform === "ios" || platform === "android") && isNativeMobileContainer()) {
    const st = await getMobileWebUpdaterState();
    if (st) {
      nativeVersion = String(st.nativeVersion || nativeVersion);
      if (typeof st.nativeBuildCode === "number") {
        nativeBuildCode = st.nativeBuildCode;
      }
      usingBuiltIn = st.usingBuiltIn !== false;
      lastRollbackReason = String(st.lastRollbackReason || "");
      if (st.activeWebBuild) {
        activeWebBuild = String(st.activeWebBuild);
      }
    }
  }

  const githubRepo = String(webMeta?.githubRepo || DEFAULT_GITHUB_REPO).trim() || DEFAULT_GITHUB_REPO;
  const localMeta = {
    platform,
    desktopArch,
    githubRepo,
    nativeVersion,
    nativeBuildCode,
    activeWebBuild: activeWebBuild || `${nativeVersion}-builtin`,
    usingBuiltIn,
    lastRollbackReason,
  };

  setState((prev) => {
    const manifestToEval =
      (prev.updateState.latestManifest as VersionManifest | null) || readCachedManifest();
    const decision = manifestToEval
      ? evaluateUpdateCompatibility(manifestToEval, {
          platform: localMeta.platform,
          desktopArch: localMeta.desktopArch,
          nativeVersion: localMeta.nativeVersion,
          nativeBuildCode: localMeta.nativeBuildCode,
          activeWebBuild: localMeta.activeWebBuild,
        })
      : prev.updateState.decision;
    return {
      updateState: {
        ...prev.updateState,
        localMeta,
        latestManifest: manifestToEval,
        decision,
        connectedNodeStatus: evaluateConnectedNodeStatus(
          manifestToEval,
          prev.diagnostics
        ),
        dismissedVersionKey:
          prev.updateState.dismissedVersionKey || readStorageStr(DISMISSED_KEY_STORAGE_KEY),
      },
    };
  });
  return localMeta;
}

/**
 * Confirms to the Desktop / Mobile native watchdog that the booted frontend rendered cleanly.
 * Clears the 5-second auto-rollback timer if an OTA update is pending verification.
 */
export async function confirmBootedWebBundleReady() {
  const webMeta = await readLocalWebMeta();
  const webBuild = webMeta?.webBuild ? String(webMeta.webBuild) : undefined;
  const platform = resolveCurrentPlatform();

  if (platform === "desktop" && window.twinklebotDesktop?.confirmWebOta) {
    try {
      await window.twinklebotDesktop.confirmWebOta(webBuild);
    } catch {}
  } else if ((platform === "ios" || platform === "android") && isNativeMobileContainer()) {
    await confirmMobileWebOtaReady(webBuild);
  }

  await refreshLocalUpdateMetadata();
}

function synthesizeFromReleasesArray(releases: any[]): VersionManifest | null {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  const semverRels = releases
    .filter((r) => r && !r.draft && /^v\d+\.\d+\.\d+/i.test(String(r.tag_name || "")))
    .sort((a, b) =>
      compareSemver(String(b.tag_name || "0.0.0"), String(a.tag_name || "0.0.0"))
    );
  const top = semverRels[0] || releases.find((r) => !r.draft) || releases[0];
  if (!top) return null;
  const tag = String(top.tag_name || "v1.0.0");
  const ver = /^v\d+\.\d+\.\d+/i.test(tag) ? tag.replace(/^v/i, "") : "1.0.0";
  const releaseUrl = String(
    top.html_url || `https://github.com/${DEFAULT_GITHUB_REPO}/releases`
  );
  const allAssets = [
    ...(Array.isArray(top.assets) ? top.assets : []),
    ...releases.flatMap((r) => (Array.isArray(r?.assets) ? r.assets : [])),
  ];

  const desktopAssets: Partial<Record<DesktopArchKey, PlatformBinaryAsset>> = {};
  const findAsset = (re: RegExp) =>
    allAssets.find((a: any) => re.test(String(a?.name || "")) && a?.browser_download_url);
  const macArm = findAsset(/arm64.*\.dmg$/i);
  const winExe = findAsset(/\.exe$/i);
  const linuxApp = findAsset(/\.AppImage$/i);
  if (macArm) {
    desktopAssets["darwin-arm64"] = {
      fileName: String(macArm.name),
      downloadUrl: String(macArm.browser_download_url),
      sizeBytes: Number(macArm.size || 0) || undefined,
    };
  }
  if (winExe) {
    desktopAssets["win32-x64"] = {
      fileName: String(winExe.name),
      downloadUrl: String(winExe.browser_download_url),
      sizeBytes: Number(winExe.size || 0) || undefined,
    };
  }
  if (linuxApp) {
    desktopAssets["linux-x64"] = {
      fileName: String(linuxApp.name),
      downloadUrl: String(linuxApp.browser_download_url),
      sizeBytes: Number(linuxApp.size || 0) || undefined,
    };
  }
  const apk = findAsset(/release\.apk$/i) || findAsset(/\.apk$/i);

  return {
    schemaVersion: 1,
    generatedAt: String(top.published_at || new Date().toISOString()),
    releaseTag: tag,
    releaseUrl,
    releaseNotes: String(top.body || "").trim() || `${tag} 发布版本`,
    webBuild: `${ver}-release`,
    shells: {
      desktop: {
        latestVersion: ver,
        minVersionForOta: "1.0.0",
        downloadUrl: releaseUrl,
        assets: desktopAssets,
      },
      android: {
        latestVersion: ver,
        minVersionForOta: "1.0.0",
        fileName: apk?.name,
        downloadUrl: apk?.browser_download_url || releaseUrl,
      },
      ios: { latestVersion: ver, minVersionForOta: "1.0.0" },
    },
    backend: {
      latestVersion: ver,
      minCompatibleVersion: "1.0.0",
      apiCapabilities: [...CURRENT_API_CAPABILITIES],
    },
    bundles: {},
  };
}

function makeUpdaterError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function fetchGithubManifestAuthoritative(
  platform: UpdateTargetPlatform,
  force: boolean,
  githubRepo = DEFAULT_GITHUB_REPO
): Promise<VersionManifest> {
  // 1. Desktop Electron Main IPC: direct Node fetch against zero-quota GitHub CDN
  if (platform === "desktop" && window.twinklebotDesktop?.checkGithubManifest) {
    const res = await window.twinklebotDesktop.checkGithubManifest({ force });
    if (res?.manifest && res.manifest.schemaVersion === 1) {
      return res.manifest as VersionManifest;
    }
    if (res && res.ok === false) {
      throw makeUpdaterError(
        String(res.code || "GITHUB_UNREACHABLE"),
        String(res.error || "检查版本更新失败")
      );
    }
  }

  // 2. Native iOS / Android: direct URLSession / HttpURLConnection against zero-quota GitHub CDN (zero CORS, works even before pairing any host!)
  if ((platform === "ios" || platform === "android") && isNativeMobileContainer()) {
    const bucket = Math.floor(Date.now() / 60_000);
    const cdnUrls = [
      `https://github.com/${githubRepo}/releases/download/${OTA_CHANNEL_TAG}/version-manifest.json?cb=${bucket}`,
      `https://github.com/${githubRepo}/releases/latest/download/version-manifest.json?cb=${bucket}`,
    ];
    for (const url of cdnUrls) {
      try {
        const parsed = await fetchMobileGithubJson(url);
        if (parsed && parsed.schemaVersion === 1 && parsed.shells) {
          return parsed as VersionManifest;
        }
      } catch {}
    }
    try {
      const releases = await fetchMobileGithubJson(
        `https://api.github.com/repos/${githubRepo}/releases?per_page=6`
      );
      if (Array.isArray(releases)) {
        for (const rel of releases) {
          const asset = (rel?.assets || []).find(
            (a: any) => String(a?.name || "").toLowerCase() === "version-manifest.json"
          );
          if (asset?.browser_download_url) {
            try {
              const m = await fetchMobileGithubJson(asset.browser_download_url);
              if (m && m.schemaVersion === 1 && m.shells) return m as VersionManifest;
            } catch {}
          }
        }
        const synth = synthesizeFromReleasesArray(releases);
        if (synth) return synth;
        throw makeUpdaterError(
          "NO_PUBLISHED_RELEASE",
          `GitHub 仓库 (${githubRepo}) 暂无已发布 Release`
        );
      }
    } catch (mobileErr: any) {
      if (mobileErr?.code === "NO_PUBLISHED_RELEASE") throw mobileErr;
      const msg = String(mobileErr?.message || "");
      if (msg.includes("404")) {
        throw makeUpdaterError(
          "NO_PUBLISHED_RELEASE",
          `GitHub 仓库 (${githubRepo}) 暂无公开 Release（尚未发布首个版本，或当前仓库为私有）`
        );
      }
      if (msg.includes("403") || msg.includes("429")) {
        throw makeUpdaterError(
          "GITHUB_RATE_LIMITED",
          "GitHub 匿名 API 请求已达当前网络每小时限额；首次发布公开 ota-channel Release 后将自动切换至零限流 CDN 通道"
        );
      }
    }
  }

  // 3. Connected backend proxy (/api/system/updates/check) for Web Browser or fallback
  const s = getState();
  if (platform === "web" || Boolean(s.activeBaseUrl && !s.lanNodeOffline)) {
    let proxyRes: any = null;
    try {
      proxyRes = await apiJson(
        `/api/system/updates/check${force ? "?force=1" : ""}`,
        { suppressLanOfflineModal: true }
      );
    } catch {
      proxyRes = null;
    }
    if (proxyRes?.ok && proxyRes?.manifest && proxyRes.manifest.schemaVersion === 1) {
      return proxyRes.manifest as VersionManifest;
    }
    if (proxyRes && proxyRes.ok === false) {
      throw makeUpdaterError(
        String(proxyRes.code || "GITHUB_UNREACHABLE"),
        String(proxyRes.error || "检查版本更新失败")
      );
    }
  }

  // 4. Direct browser REST fallback (only when no backend proxy responded)
  const apiRes = await fetch(
    `https://api.github.com/repos/${githubRepo}/releases?per_page=6`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!apiRes.ok) {
    if (apiRes.status === 404) {
      throw makeUpdaterError(
        "NO_PUBLISHED_RELEASE",
        `GitHub 仓库 (${githubRepo}) 暂无公开 Release（尚未发布首个版本，或当前仓库为私有）`
      );
    }
    if (apiRes.status === 403 || apiRes.status === 429) {
      throw makeUpdaterError(
        "GITHUB_RATE_LIMITED",
        "GitHub 匿名 API 请求已达当前网络每小时限额；首次发布公开 ota-channel Release 后将自动切换至零限流 CDN 通道"
      );
    }
    throw makeUpdaterError(
      "GITHUB_UNREACHABLE",
      `GitHub 版本查询失败 (HTTP ${apiRes.status})`
    );
  }
  const releases = (await apiRes.json()) as any[];
  const synth = synthesizeFromReleasesArray(releases);
  if (!synth) {
    throw makeUpdaterError("NO_PUBLISHED_RELEASE", "GitHub 暂无可用版本记录");
  }
  return synth;
}

export async function checkForAppUpdates({
  force = false,
  silent = false,
}: { force?: boolean; silent?: boolean } = {}) {
  if (checkInFlight) return await checkInFlight;

  const nowBefore = Date.now();
  const lastStored = Number(readStorageStr(LAST_CHECK_STORAGE_KEY) || 0);
  if (!force && silent) {
    if (sessionLastSilentCheckAt > 0 && nowBefore - sessionLastSilentCheckAt < AUTO_CHECK_INTERVAL_MS) {
      return await refreshLocalUpdateMetadata();
    }
    if (lastStored > 0 && nowBefore - lastStored < COLD_START_CHECK_COOLDOWN_MS) {
      sessionLastSilentCheckAt = lastStored;
      return await refreshLocalUpdateMetadata();
    }
  }

  const run = async () => {
    setState((prev) => ({
      updateState: {
        ...prev.updateState,
        checking: true,
        error: "",
        errorCode: "",
      },
    }));

    try {
      const localMeta = await refreshLocalUpdateMetadata();
      const manifest = await fetchGithubManifestAuthoritative(
        localMeta.platform,
        force,
        localMeta.githubRepo || DEFAULT_GITHUB_REPO
      );

      const env: LocalUpdateEnv = {
        platform: localMeta.platform,
        desktopArch: localMeta.desktopArch,
        nativeVersion: localMeta.nativeVersion,
        nativeBuildCode: localMeta.nativeBuildCode,
        activeWebBuild: localMeta.activeWebBuild,
      };
      const decision = evaluateUpdateCompatibility(manifest, env);
      const connectedNodeStatus = evaluateConnectedNodeStatus(
        manifest,
        getState().diagnostics
      );
      const now = Date.now();
      sessionLastSilentCheckAt = now;
      writeStorageStr(LAST_CHECK_STORAGE_KEY, String(now));
      writeCachedManifest(manifest);

      setState((prev) => ({
        updateState: {
          ...prev.updateState,
          checking: false,
          lastCheckedAt: now,
          error: "",
          errorCode: "",
          latestManifest: manifest,
          decision,
          connectedNodeStatus,
        },
      }));
      return decision;
    } catch (err: any) {
      setState((prev) => ({
        updateState: {
          ...prev.updateState,
          checking: false,
          lastCheckedAt: Date.now(),
          error: String(err?.message || "检测更新失败"),
          errorCode: String(err?.code || "GITHUB_UNREACHABLE"),
        },
      }));
      return null;
    } finally {
      checkInFlight = null;
    }
  };

  checkInFlight = run();
  return await checkInFlight;
}

export async function applyAvailableOtaUpdate() {
  const st = getState().updateState;
  const decision = st.decision as CompatibilityDecision | null;
  if (!decision) return;

  if (decision.status === "reload-required") {
    window.location.reload();
    return;
  }

  if (decision.status !== "ota-available" || !decision.otaBundle) {
    throw new Error(decision.reason || "当前没有可用的前端热更新包");
  }

  const bundle = decision.otaBundle;
  const platform = st.localMeta?.platform || resolveCurrentPlatform();

  setState((prev) => ({
    updateState: {
      ...prev.updateState,
      applying: true,
      error: "",
      progress: {
        phase: "downloading",
        percent: 10,
        message: "正在从 GitHub Releases 准备热更新…",
      },
    },
  }));

  try {
    if (platform === "desktop" && window.twinklebotDesktop?.applyWebOta) {
      unsubDesktopProgress?.();
      unsubDesktopProgress = window.twinklebotDesktop.onOtaProgress?.((ev: any) => {
        setState((prev) => ({
          updateState: {
            ...prev.updateState,
            progress: {
              phase: String(ev?.phase || "downloading"),
              percent: Number(ev?.percent || 0),
              message: String(ev?.message || ""),
            },
          },
        }));
      });
      await window.twinklebotDesktop.applyWebOta({
        bundleUrl: bundle.bundleUrl,
        sha256: bundle.sha256,
        webBuild: bundle.webBuild,
      });
    } else if ((platform === "ios" || platform === "android") && isNativeMobileContainer()) {
      unsubMobileProgress?.();
      unsubMobileProgress = onMobileWebOtaProgress((ev: any) => {
        setState((prev) => ({
          updateState: {
            ...prev.updateState,
            progress: {
              phase: String(ev?.phase || "downloading"),
              percent: Number(ev?.percent || 0),
              message: String(ev?.message || ""),
            },
          },
        }));
      });
      await downloadAndApplyMobileWebOta({
        url: bundle.bundleUrl,
        sha256: bundle.sha256,
        webBuild: bundle.webBuild,
      });
    } else {
      throw new Error("当前运行环境不支持本地热更新包替换，请直接刷新页面");
    }
  } catch (err: any) {
    setState((prev) => ({
      updateState: {
        ...prev.updateState,
        applying: false,
        progress: null,
        error: String(err?.message || "热更新失败"),
      },
    }));
    throw err;
  } finally {
    unsubDesktopProgress?.();
    unsubDesktopProgress = null;
    unsubMobileProgress?.();
    unsubMobileProgress = null;
  }
}

export async function downloadOrOpenFullShellUpdate() {
  const st = getState().updateState;
  const decision = st.decision as CompatibilityDecision | null;
  const resolved = decision?.resolvedAsset;
  const shell = decision?.shellUpdate || decision?.optionalShellUpdate;
  const downloadUrl =
    resolved?.downloadUrl ||
    shell?.downloadUrl ||
    decision?.releaseUrl ||
    `https://github.com/${DEFAULT_GITHUB_REPO}/releases`;
  const fileName = resolved?.fileName || shell?.fileName;
  const sha256 = resolved?.sha256 || shell?.sha256;

  if (
    st.localMeta?.platform === "desktop" &&
    window.twinklebotDesktop?.downloadFullInstaller &&
    /\.(dmg|exe|appimage|zip|tar\.gz)$/i.test(downloadUrl)
  ) {
    setState((prev) => ({
      updateState: {
        ...prev.updateState,
        applying: true,
        error: "",
        progress: {
          phase: "downloading",
          percent: 15,
          message: `正在从 GitHub 下载安装包 ${fileName || ""}…`,
        },
      },
    }));
    unsubDesktopProgress?.();
    unsubDesktopProgress = window.twinklebotDesktop.onOtaProgress?.((ev: any) => {
      setState((prev) => ({
        updateState: {
          ...prev.updateState,
          progress: {
            phase: String(ev?.phase || "downloading"),
            percent: Number(ev?.percent || 0),
            message: String(ev?.message || ""),
          },
        },
      }));
    });
    try {
      await window.twinklebotDesktop.downloadFullInstaller({
        downloadUrl,
        fileName,
        sha256,
      });
    } finally {
      unsubDesktopProgress?.();
      unsubDesktopProgress = null;
      setState((prev) => ({
        updateState: { ...prev.updateState, applying: false },
      }));
    }
    return;
  }

  window.open(downloadUrl, "_blank", "noopener");
}

export async function rollbackOtaToBuiltIn() {
  const platform = resolveCurrentPlatform();
  if (platform === "desktop" && window.twinklebotDesktop?.rollbackWebOta) {
    await window.twinklebotDesktop.rollbackWebOta("builtin");
    return;
  }
  if ((platform === "ios" || platform === "android") && isNativeMobileContainer()) {
    await rollbackMobileWebOtaToBuiltIn();
    return;
  }
  window.location.reload();
}

export function dismissCurrentUpdateNotice() {
  const decision = getState().updateState?.decision as CompatibilityDecision | null;
  const key = computeUpdateDecisionKey(decision);
  if (!key) return;
  writeStorageStr(DISMISSED_KEY_STORAGE_KEY, key);
  setState((prev) => ({
    updateState: {
      ...prev.updateState,
      dismissedVersionKey: key,
    },
  }));
}
