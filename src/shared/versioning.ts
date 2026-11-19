export const BASELINE_V1_2_CAPABILITIES = [
  "core-v1",
  "vault-patch-v1",
  "gemini-vertex-gate-v1",
  "ota-v1",
] as const;

export const CURRENT_API_CAPABILITIES = [
  ...BASELINE_V1_2_CAPABILITIES,
  "multi-display-v1",
] as const;

export const DEFAULT_GITHUB_OWNER = "caixy-plus";
export const DEFAULT_GITHUB_REPO = "caixy-plus/twinklebot-releases";
export const OTA_CHANNEL_TAG = "ota-channel";

export type UpdateTargetPlatform = "desktop" | "android" | "ios" | "web";
export type DesktopArchKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "win32-x64"
  | "linux-x64";

export interface WebMetaInfo {
  appVersion: string;
  target: "desktop" | "mobile";
  webBuild: string;
  contentHash: string;
  githubRepo?: string;
  requiredApiCapabilities: string[];
  minDesktopShellVersion: string;
  minAndroidShellVersion: string;
  minAndroidBuildCode: number;
  minIosShellVersion: string;
  minIosBuildCode: number;
  minBackendVersion: string;
  builtAt: string;
}

export interface PlatformBinaryAsset {
  fileName: string;
  downloadUrl: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface ShellReleaseInfo {
  latestVersion: string;
  latestBuildCode?: number;
  minVersionForOta: string;
  minBuildCodeForOta?: number;
  downloadUrl?: string;
  fileName?: string;
  sha256?: string;
  sizeBytes?: number;
  assets?: Partial<Record<DesktopArchKey, PlatformBinaryAsset>>;
}

export interface WebOtaBundleInfo {
  target: "desktop" | "mobile";
  webBuild: string;
  contentHash?: string;
  bundleUrl: string;
  sha256: string;
  sizeBytes: number;
  requiredApiCapabilities?: string[];
}

export interface BackendReleaseInfo {
  latestVersion: string;
  minCompatibleVersion: string;
  apiCapabilities: string[];
}

export interface VersionManifest {
  schemaVersion: 1;
  generatedAt: string;
  releaseTag?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  webBuild: string;
  shells: {
    desktop?: ShellReleaseInfo;
    android?: ShellReleaseInfo;
    ios?: ShellReleaseInfo;
  };
  backend?: BackendReleaseInfo;
  bundles?: {
    desktop?: WebOtaBundleInfo;
    mobile?: WebOtaBundleInfo;
  };
}

export interface LocalUpdateEnv {
  platform: UpdateTargetPlatform;
  desktopArch?: string;
  nativeVersion: string;
  nativeBuildCode?: number;
  activeWebBuild: string;
  builtInWebBuild?: string;
}

export type CompatibilityDecisionStatus =
  | "up-to-date"
  | "ota-available"
  | "shell-update-required"
  | "reload-required";

export interface CompatibilityDecision {
  status: CompatibilityDecisionStatus;
  sourceKind: "github";
  latestWebBuild: string;
  releaseTag?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  reason?: string;
  otaBundle?: WebOtaBundleInfo;
  shellUpdate?: ShellReleaseInfo;
  resolvedAsset?: PlatformBinaryAsset;
  optionalShellUpdate?: ShellReleaseInfo;
}

export interface ConnectedNodeVersionStatus {
  hasDiagnostics: boolean;
  deployEnv: string;
  nodeVersion: string;
  latestBackendVersion: string;
  nodeOutdated: boolean;
  nodeCapabilities: string[];
  missingLatestCapabilities: string[];
}

function parseSemverParts(raw: string): {
  major: number;
  minor: number;
  patch: number;
  pre: string;
} {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^v/i, "");
  const [mainPart, prePart = ""] = cleaned.split("-", 2);
  const nums = mainPart.split(".").map((n) => {
    const parsed = Number.parseInt(n.replace(/[^\d].*$/, ""), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });
  return {
    major: nums[0] || 0,
    minor: nums[1] || 0,
    patch: nums[2] || 0,
    pre: prePart.trim(),
  };
}

/**
 * Compares two SemVer strings (`1.2.0`, `v1.2.1-beta.1`).
 * Returns `1` if `a > b`, `-1` if `a < b`, or `0` if equal.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

export const PROJECT_VERSION_MAX_PATCH = 9;
export const PROJECT_VERSION_MAX_MINOR = 19;

/**
 * Validates TwinkleBot's project version convention (aligned with cc-gateway):
 * - Format: `MAJOR.MINOR.PATCH` (no leading zeros on multi-digit parts)
 * - `PATCH`: 0–9 (at 9, next bump rolls over to 0 and increments MINOR)
 * - `MINOR`: 0–19 (at 19, next bump rolls over to 0 and increments MAJOR)
 */
export function isValidProjectVersion(raw: string): boolean {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^v/i, "");
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(cleaned);
  if (!m) return false;
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return (
    minor >= 0 &&
    minor <= PROJECT_VERSION_MAX_MINOR &&
    patch >= 0 &&
    patch <= PROJECT_VERSION_MAX_PATCH
  );
}

/**
 * Bumps a `MAJOR.MINOR.PATCH` version following the cc-gateway rollover convention:
 * - `patch`: PATCH 0–9 (9 -> 0, MINOR + 1); MINOR 0–19 (19 -> 0, MAJOR + 1)
 * - `minor`: resets PATCH to 0; MINOR 0–19 (19 -> 0, MAJOR + 1)
 * - `major`: MAJOR + 1, resets MINOR and PATCH to 0
 * Examples: `1.0.9 -> 1.1.0`, `1.5.9 -> 1.6.0`, `1.19.9 -> 2.0.0`.
 */
export function bumpProjectVersion(
  current: string,
  level: "patch" | "minor" | "major" = "patch"
): string {
  if (!isValidProjectVersion(current)) {
    throw new Error(
      `Invalid project version "${current}": expected MAJOR.MINOR.PATCH with MINOR 0-${PROJECT_VERSION_MAX_MINOR} and PATCH 0-${PROJECT_VERSION_MAX_PATCH}`
    );
  }
  let { major, minor, patch } = parseSemverParts(current);
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    patch = 0;
    if (minor >= PROJECT_VERSION_MAX_MINOR) {
      major += 1;
      minor = 0;
    } else {
      minor += 1;
    }
  } else {
    if (patch >= PROJECT_VERSION_MAX_PATCH) {
      patch = 0;
      if (minor >= PROJECT_VERSION_MAX_MINOR) {
        major += 1;
        minor = 0;
      } else {
        minor += 1;
      }
    } else {
      patch += 1;
    }
  }
  return `${major}.${minor}.${patch}`;
}

export function extractWebBuildParts(raw: string): {
  stampNums: number[];
  hash: string;
  normalized: string;
} {
  const normalized = String(raw || "").trim();
  if (!normalized) {
    return { stampNums: [], hash: "", normalized: "" };
  }
  const dashIdx = normalized.lastIndexOf("-");
  const left = dashIdx > 0 ? normalized.slice(0, dashIdx) : normalized;
  const right = dashIdx > 0 ? normalized.slice(dashIdx + 1) : "";
  const hash = /^[a-f0-9]{6,64}$/i.test(right) ? right.toLowerCase() : "";
  const stampSource = hash ? left : normalized;
  const stampNums = stampSource
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
  return { stampNums, hash, normalized };
}

/**
 * Compares two webBuild identifiers (`YYYYMMDD.HHmmss-<hash>` or `20261117.1-<hash>`).
 * Returns `0` immediately when both non-empty content hashes match so identical builds never re-download.
 */
export function compareWebBuild(candidate: string, current: string): -1 | 0 | 1 {
  const a = extractWebBuildParts(candidate);
  const b = extractWebBuildParts(current);
  if (!a.normalized) return b.normalized ? -1 : 0;
  if (!b.normalized) return 1;
  if (a.hash && b.hash && a.hash === b.hash) return 0;
  if (a.normalized === b.normalized) return 0;

  const maxLen = Math.max(a.stampNums.length, b.stampNums.length);
  for (let i = 0; i < maxLen; i += 1) {
    const na = a.stampNums[i] ?? 0;
    const nb = b.stampNums[i] ?? 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return a.normalized > b.normalized ? 1 : -1;
}

export function normalizeDesktopArchKey(raw?: string): DesktopArchKey {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "darwin-x64" || v === "mac-x64" || v === "macos-x64") return "darwin-x64";
  if (v.startsWith("win32") || v.startsWith("windows")) return "win32-x64";
  if (v.startsWith("linux")) return "linux-x64";
  return "darwin-arm64";
}

export function resolveDesktopAssetForPlatform(
  shell: ShellReleaseInfo | undefined,
  desktopArch?: string
): PlatformBinaryAsset | undefined {
  if (!shell) return undefined;
  const key = normalizeDesktopArchKey(desktopArch);
  const exact = shell.assets?.[key];
  if (exact && exact.downloadUrl) return exact;
  if (key === "darwin-x64" && shell.assets?.["darwin-arm64"]) {
    // Only fall back to generic release URL rather than wrong CPU binary
    return shell.downloadUrl
      ? { fileName: shell.fileName || "", downloadUrl: shell.downloadUrl }
      : undefined;
  }
  if (shell.downloadUrl) {
    return {
      fileName: shell.fileName || "",
      downloadUrl: shell.downloadUrl,
      sha256: shell.sha256,
      sizeBytes: shell.sizeBytes,
    };
  }
  return undefined;
}

function isNewerShellAvailable(
  spec: ShellReleaseInfo | undefined,
  nativeVersion: string,
  nativeBuildCode?: number
): boolean {
  if (!spec) return false;
  const verCmp = spec.latestVersion
    ? compareSemver(spec.latestVersion, nativeVersion || "0.0.0")
    : 0;
  if (verCmp > 0) return true;
  if (
    verCmp === 0 &&
    typeof spec.latestBuildCode === "number" &&
    typeof nativeBuildCode === "number" &&
    spec.latestBuildCode > nativeBuildCode
  ) {
    return true;
  }
  return false;
}

function meetsMinimumShellForOta(
  spec: ShellReleaseInfo | undefined,
  nativeVersion: string,
  nativeBuildCode?: number
): boolean {
  if (!spec) return true;
  if (spec.minVersionForOta) {
    const cmp = compareSemver(nativeVersion || "0.0.0", spec.minVersionForOta);
    if (cmp < 0) return false;
  }
  if (
    typeof spec.minBuildCodeForOta === "number" &&
    typeof nativeBuildCode === "number" &&
    nativeBuildCode < spec.minBuildCodeForOta
  ) {
    return false;
  }
  return true;
}

function withResolvedShellAsset(
  shellSpec: ShellReleaseInfo | undefined,
  platform: UpdateTargetPlatform,
  desktopArch?: string
): { shellUpdate?: ShellReleaseInfo; resolvedAsset?: PlatformBinaryAsset } {
  if (!shellSpec) return {};
  if (platform === "desktop") {
    const resolved = resolveDesktopAssetForPlatform(shellSpec, desktopArch);
    return {
      shellUpdate: resolved
        ? {
            ...shellSpec,
            fileName: resolved.fileName || shellSpec.fileName,
            downloadUrl: resolved.downloadUrl || shellSpec.downloadUrl,
            sha256: resolved.sha256 || shellSpec.sha256,
            sizeBytes: resolved.sizeBytes || shellSpec.sizeBytes,
          }
        : shellSpec,
      resolvedAsset: resolved,
    };
  }
  if (platform === "android" && shellSpec.downloadUrl) {
    return {
      shellUpdate: shellSpec,
      resolvedAsset: {
        fileName: shellSpec.fileName || "TwinkleBot-mobile-release.apk",
        downloadUrl: shellSpec.downloadUrl,
        sha256: shellSpec.sha256,
        sizeBytes: shellSpec.sizeBytes,
      },
    };
  }
  return { shellUpdate: shellSpec };
}

/**
 * Evaluates client update eligibility from the single authoritative GitHub VersionManifest:
 * - Strictly monotonic (`compareWebBuild > 0`), preventing downgrade / ping-pong across nodes.
 * - Independent per-platform shell gates (`desktop`, `android`, `ios`).
 * - Decoupled from whichever remote LAN/Cloud node is currently selected on mobile.
 */
export function evaluateUpdateCompatibility(
  manifest: VersionManifest,
  localEnv: LocalUpdateEnv
): CompatibilityDecision {
  const platform = localEnv.platform;
  const shellSpec =
    platform === "desktop"
      ? manifest.shells?.desktop
      : platform === "android"
        ? manifest.shells?.android
        : platform === "ios"
          ? manifest.shells?.ios
          : undefined;

  const baseMeta = {
    sourceKind: "github" as const,
    latestWebBuild: manifest.webBuild || "",
    releaseTag: manifest.releaseTag,
    releaseUrl: manifest.releaseUrl,
    releaseNotes: manifest.releaseNotes,
  };

  if (platform === "web") {
    if (
      manifest.webBuild &&
      compareWebBuild(manifest.webBuild, localEnv.activeWebBuild) > 0
    ) {
      return {
        ...baseMeta,
        status: "reload-required",
        reason: "前端静态资源已更新，刷新浏览器页面即可加载最新版本",
      };
    }
    return { ...baseMeta, status: "up-to-date" };
  }

  const newerShell = isNewerShellAvailable(
    shellSpec,
    localEnv.nativeVersion,
    localEnv.nativeBuildCode
  );
  const shellMeetsOtaMin = meetsMinimumShellForOta(
    shellSpec,
    localEnv.nativeVersion,
    localEnv.nativeBuildCode
  );
  const resolvedShell = withResolvedShellAsset(
    shellSpec,
    platform,
    localEnv.desktopArch
  );

  // 1. Current platform's native shell is below minimum OTA bound -> require shell reinstall
  if (!shellMeetsOtaMin) {
    return {
      ...baseMeta,
      status: "shell-update-required",
      ...resolvedShell,
      reason:
        platform === "desktop"
          ? `当前桌面端版本（v${localEnv.nativeVersion}）低于热更新最低要求（v${shellSpec?.minVersionForOta}），请下载新版安装包`
          : `当前原生客户端（v${localEnv.nativeVersion}）低于热更新最低要求（v${shellSpec?.minVersionForOta}），请更新安装包`,
    };
  }

  // 2. Desktop embeds its own Node.js backend: if a newer desktop version exists, upgrade full installer
  if (platform === "desktop" && newerShell) {
    return {
      ...baseMeta,
      status: "shell-update-required",
      ...resolvedShell,
      reason: `发现新版桌面客户端 v${shellSpec?.latestVersion}（包含内嵌后端引擎与宿主更新）`,
    };
  }

  // 3. Check pure-frontend OTA bundle strictly monotonically (candidate > current)
  const bundleTarget = platform === "desktop" ? "desktop" : "mobile";
  const bundle = manifest.bundles?.[bundleTarget];
  const bundleIsNewer = Boolean(
    bundle &&
      bundle.bundleUrl &&
      bundle.sha256 &&
      compareWebBuild(bundle.webBuild, localEnv.activeWebBuild) > 0
  );

  if (bundle && bundleIsNewer) {
    return {
      ...baseMeta,
      status: "ota-available",
      otaBundle: bundle,
      ...(newerShell && resolvedShell.shellUpdate
        ? { optionalShellUpdate: resolvedShell.shellUpdate }
        : {}),
      reason: "GitHub Releases 已发布兼容的纯前端热更新包，可免重装秒级生效",
    };
  }

  // 4. No newer frontend OTA needed; if mobile has an optional newer native shell, surface it cleanly
  if (newerShell && resolvedShell.shellUpdate) {
    return {
      ...baseMeta,
      status: "shell-update-required",
      ...resolvedShell,
      reason: `发现 ${platform === "ios" ? "iOS" : "Android"} 原生客户端新版本 v${resolvedShell.shellUpdate.latestVersion}`,
    };
  }

  return {
    ...baseMeta,
    status: "up-to-date",
  };
}

/**
 * Evaluates whether a connected LAN / Cloud backend node supports a given API capability.
 * All v1.2.0 baseline capabilities default to true on >=1.2.0 nodes even before diagnostics finish loading.
 */
export function nodeSupportsCapability(
  capability: string,
  diagnostics?: { appVersion?: string; apiCapabilities?: string[] } | null
): boolean {
  const cap = String(capability || "").trim();
  if (!cap) return true;
  if (Array.isArray(diagnostics?.apiCapabilities) && diagnostics!.apiCapabilities.length > 0) {
    return diagnostics!.apiCapabilities.includes(cap);
  }
  return (BASELINE_V1_2_CAPABILITIES as readonly string[]).includes(cap);
}

/**
 * Evaluates the version status of the currently connected backend node (LAN / Cloud / Local)
 * against the latest backend version published on GitHub Releases.
 */
export function evaluateConnectedNodeStatus(
  manifest: VersionManifest | null | undefined,
  diagnostics?: {
    appVersion?: string;
    deployEnv?: string;
    apiCapabilities?: string[];
  } | null
): ConnectedNodeVersionStatus {
  const nodeVersion = String(diagnostics?.appVersion || "").trim();
  const deployEnv = String(diagnostics?.deployEnv || "local").trim();
  const nodeCapabilities =
    Array.isArray(diagnostics?.apiCapabilities) && diagnostics!.apiCapabilities.length > 0
      ? diagnostics!.apiCapabilities.map(String)
      : [...BASELINE_V1_2_CAPABILITIES];

  const latestBackendVersion = String(
    manifest?.backend?.latestVersion ||
      manifest?.shells?.desktop?.latestVersion ||
      ""
  ).trim();
  const latestCaps = Array.isArray(manifest?.backend?.apiCapabilities)
    ? manifest!.backend!.apiCapabilities.map(String)
    : [...CURRENT_API_CAPABILITIES];

  if (!nodeVersion) {
    return {
      hasDiagnostics: false,
      deployEnv,
      nodeVersion: "",
      latestBackendVersion,
      nodeOutdated: false,
      nodeCapabilities,
      missingLatestCapabilities: [],
    };
  }

  const nodeOutdated = Boolean(
    latestBackendVersion && compareSemver(latestBackendVersion, nodeVersion) > 0
  );
  const missingLatestCapabilities = latestCaps.filter(
    (c) => !nodeCapabilities.includes(c)
  );

  return {
    hasDiagnostics: true,
    deployEnv,
    nodeVersion,
    latestBackendVersion: latestBackendVersion || nodeVersion,
    nodeOutdated,
    nodeCapabilities,
    missingLatestCapabilities,
  };
}
