import fs from "node:fs";
import path from "node:path";
import {
  CURRENT_API_CAPABILITIES,
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
  OTA_CHANNEL_TAG,
  compareSemver,
  type DesktopArchKey,
  type PlatformBinaryAsset,
  type ShellReleaseInfo,
  type VersionManifest,
} from "../shared/versioning.js";

const CACHE_TTL_MS = 5 * 60_000;

export type GithubReleaseErrorCode =
  | "NO_PUBLISHED_RELEASE"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_UNREACHABLE";

export class GithubReleaseCheckError extends Error {
  code: GithubReleaseErrorCode;

  constructor(code: GithubReleaseErrorCode, message: string) {
    super(message);
    this.name = "GithubReleaseCheckError";
    this.code = code;
  }
}

let githubManifestCache: {
  fetchedAt: number;
  githubRepo: string;
  manifest: VersionManifest;
  source: string;
} | null = null;

function readJsonSafe(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveConfiguredGithubRepo(projectRoot?: string): string {
  const envRepo = String(process.env.TWINKLEBOT_GITHUB_REPO || "").trim();
  if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(envRepo)) {
    return envRepo;
  }
  if (projectRoot) {
    const policy = readJsonSafe(path.join(projectRoot, "version-policy.json"));
    const policyRepo = String(policy?.githubRepo || "").trim();
    if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(policyRepo)) {
      return policyRepo;
    }
  }
  return DEFAULT_GITHUB_REPO;
}

/**
 * Strictly validates that an update / installer asset URL belongs to official GitHub Releases
 * for the configured repository (or another official release repo under DEFAULT_GITHUB_OWNER,
 * or GitHub's official asset CDN).
 */
export function isTrustedGithubReleaseUrl(
  rawUrl: string,
  githubRepo?: string
): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "github.com") {
      const p = u.pathname.toLowerCase();
      if (githubRepo) {
        const repoPrefix = `/${String(githubRepo).toLowerCase()}/releases/`;
        return p.startsWith(repoPrefix);
      }
      const configuredPrefix = `/${resolveConfiguredGithubRepo().toLowerCase()}/releases/`;
      if (p.startsWith(configuredPrefix)) return true;
      const ownerRe = new RegExp(`^/${DEFAULT_GITHUB_OWNER.toLowerCase()}/[a-z0-9._-]+/releases/`);
      return ownerRe.test(p);
    }
    return (
      h === "objects.githubusercontent.com" ||
      h === "release-assets.githubusercontent.com" ||
      h === "github-releases.githubusercontent.com" ||
      h.endsWith(".githubusercontent.com")
    );
  } catch {
    return false;
  }
}

export function validateGithubManifestUrls(
  manifest: VersionManifest,
  githubRepo = DEFAULT_GITHUB_REPO
): boolean {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.shells) {
    return false;
  }
  const urlsToCheck: string[] = [];
  if (manifest.releaseUrl) urlsToCheck.push(manifest.releaseUrl);
  for (const shell of [
    manifest.shells.desktop,
    manifest.shells.android,
    manifest.shells.ios,
  ]) {
    if (shell?.downloadUrl) urlsToCheck.push(shell.downloadUrl);
    if (shell?.assets) {
      for (const item of Object.values(shell.assets)) {
        if (item?.downloadUrl) urlsToCheck.push(item.downloadUrl);
      }
    }
  }
  for (const b of [manifest.bundles?.desktop, manifest.bundles?.mobile]) {
    if (b?.bundleUrl) urlsToCheck.push(b.bundleUrl);
  }
  return urlsToCheck.every((u) => isTrustedGithubReleaseUrl(u, githubRepo));
}

export function readEffectiveWebMeta({
  effectivePublicDir,
  projectRoot,
  appVersion,
}: {
  effectivePublicDir: string;
  projectRoot: string;
  appVersion: string;
}) {
  const activeMeta = readJsonSafe(path.join(effectivePublicDir, "web-meta.json"));
  const policy = readJsonSafe(path.join(projectRoot, "version-policy.json"));
  const defaultCaps = Array.isArray(policy?.backend?.apiCapabilities)
    ? policy!.backend.apiCapabilities.map(String)
    : [...CURRENT_API_CAPABILITIES];

  if (activeMeta && activeMeta.webBuild) {
    return {
      appVersion: String(activeMeta.appVersion || appVersion),
      webBuild: String(activeMeta.webBuild),
      contentHash: String(activeMeta.contentHash || ""),
      requiredApiCapabilities: Array.isArray(activeMeta.requiredApiCapabilities)
        ? activeMeta.requiredApiCapabilities.map(String)
        : defaultCaps,
      builtAt: String(activeMeta.builtAt || ""),
    };
  }

  const pkg = readJsonSafe(path.join(projectRoot, "package.json"));
  const fallbackVer = String(pkg?.version || appVersion || "1.0.0");
  return {
    appVersion: fallbackVer,
    webBuild: `${fallbackVer}-builtin`,
    contentHash: "",
    requiredApiCapabilities: defaultCaps,
    builtAt: "",
  };
}

function classifyDesktopAssets(assets: any[], fallbackUrl: string) {
  const map: Partial<Record<DesktopArchKey, PlatformBinaryAsset>> = {};
  const pick = (re: RegExp) =>
    assets.find((a) => re.test(String(a?.name || "")) && a?.browser_download_url) || null;

  const macArm = pick(/arm64.*\.dmg$/i) || pick(/(?:mac|darwin).*arm64.*\.zip$/i);
  const macX64 =
    pick(/(?:x64|intel).*\.dmg$/i) ||
    assets.find(
      (a) =>
        /\.dmg$/i.test(String(a?.name || "")) &&
        !/arm64/i.test(String(a?.name || "")) &&
        a?.browser_download_url
    );
  const winX64 = pick(/\.exe$/i) || pick(/win.*\.zip$/i);
  const linuxX64 = pick(/\.AppImage$/i) || pick(/linux.*\.tar\.gz$/i);

  const toAsset = (raw: any): PlatformBinaryAsset | undefined =>
    raw
      ? {
          fileName: String(raw.name || ""),
          downloadUrl: String(raw.browser_download_url || fallbackUrl),
          sizeBytes: Number(raw.size || 0) || undefined,
        }
      : undefined;

  if (macArm) map["darwin-arm64"] = toAsset(macArm);
  if (macX64) map["darwin-x64"] = toAsset(macX64);
  if (winX64) map["win32-x64"] = toAsset(winX64);
  if (linuxX64) map["linux-x64"] = toAsset(linuxX64);
  return map;
}

function synthesizeManifestFromReleasesApi(
  releases: any[],
  currentAppVersion: string,
  githubRepo: string
): VersionManifest {
  const semverReleases = releases
    .filter(
      (r) =>
        r &&
        !r.draft &&
        /^v\d+\.\d+\.\d+/i.test(String(r.tag_name || ""))
    )
    .sort((a, b) =>
      compareSemver(String(b.tag_name || "0.0.0"), String(a.tag_name || "0.0.0"))
    );

  const topRel = semverReleases[0] || releases.find((r) => !r.draft) || releases[0];
  const tagName = String(topRel?.tag_name || `v${currentAppVersion}`);
  const parsedVer = /^v\d+\.\d+\.\d+/i.test(tagName)
    ? tagName.replace(/^v/i, "")
    : currentAppVersion;
  const releaseUrl = String(
    topRel?.html_url || `https://github.com/${githubRepo}/releases`
  );

  const allAssets = [
    ...(Array.isArray(topRel?.assets) ? topRel.assets : []),
    ...releases.flatMap((r) => (Array.isArray(r?.assets) ? r.assets : [])),
  ];
  const desktopAssets = classifyDesktopAssets(allAssets, releaseUrl);
  const apkAsset =
    allAssets.find((a) => /release\.apk$/i.test(String(a?.name || ""))) ||
    allAssets.find((a) => /\.apk$/i.test(String(a?.name || "")));

  const primaryDesktop =
    desktopAssets["darwin-arm64"] ||
    desktopAssets["win32-x64"] ||
    desktopAssets["linux-x64"] ||
    desktopAssets["darwin-x64"];

  const desktopShell: ShellReleaseInfo = {
    latestVersion: parsedVer,
    minVersionForOta: "1.0.0",
    fileName: primaryDesktop?.fileName,
    downloadUrl: primaryDesktop?.downloadUrl || releaseUrl,
    sizeBytes: primaryDesktop?.sizeBytes,
    assets: desktopAssets,
  };

  return {
    schemaVersion: 1,
    generatedAt: String(topRel?.published_at || new Date().toISOString()),
    releaseTag: tagName,
    releaseUrl,
    releaseNotes: String(topRel?.body || "").trim() || `${tagName} 发布版本`,
    webBuild: `${parsedVer}-release`,
    shells: {
      desktop: desktopShell,
      android: {
        latestVersion: parsedVer,
        minVersionForOta: "1.0.0",
        fileName: apkAsset?.name ? String(apkAsset.name) : undefined,
        downloadUrl: apkAsset?.browser_download_url || releaseUrl,
        sizeBytes: Number(apkAsset?.size || 0) || undefined,
      },
      ios: {
        latestVersion: parsedVer,
        minVersionForOta: "1.0.0",
      },
    },
    backend: {
      latestVersion: parsedVer,
      minCompatibleVersion: "1.0.0",
      apiCapabilities: [...CURRENT_API_CAPABILITIES],
    },
    bundles: {},
  };
}

/**
 * Fetches the authoritative VersionManifest exclusively from GitHub Releases:
 * 1) Zero-rate-limit CDN pointer `releases/download/ota-channel/version-manifest.json`
 * 2) Zero-rate-limit CDN latest `releases/latest/download/version-manifest.json`
 * 3) REST API `api.github.com/repos/<repo>/releases?per_page=6` fallback
 */
export async function fetchLatestGithubManifest({
  githubRepo,
  projectRoot,
  currentAppVersion = "1.0.0",
  fetchImpl = globalThis.fetch,
  force = false,
}: {
  githubRepo?: string;
  projectRoot?: string;
  currentAppVersion?: string;
  fetchImpl?: typeof globalThis.fetch;
  force?: boolean;
} = {}): Promise<{ manifest: VersionManifest; source: string; cached: boolean; githubRepo: string }> {
  const effectiveRepo = githubRepo || resolveConfiguredGithubRepo(projectRoot);
  const now = Date.now();
  if (
    !force &&
    githubManifestCache &&
    githubManifestCache.githubRepo === effectiveRepo &&
    now - githubManifestCache.fetchedAt < CACHE_TTL_MS
  ) {
    return {
      manifest: githubManifestCache.manifest,
      source: githubManifestCache.source,
      cached: true,
      githubRepo: effectiveRepo,
    };
  }

  const bucket = Math.floor(now / 60_000);
  const directCandidates: Array<{ url: string; source: string }> = [
    {
      url: `https://github.com/${effectiveRepo}/releases/download/${OTA_CHANNEL_TAG}/version-manifest.json?cb=${bucket}`,
      source: "github-ota-channel-cdn",
    },
    {
      url: `https://github.com/${effectiveRepo}/releases/latest/download/version-manifest.json?cb=${bucket}`,
      source: "github-latest-cdn",
    },
  ];

  for (const cand of directCandidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetchImpl(cand.url, {
          headers: { "User-Agent": "TwinkleBot-Updater/1.0.0" },
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404) break; // asset/release genuinely absent, move to next candidate
        if (!res.ok) continue;
        const parsed = (await res.json()) as VersionManifest;
        if (validateGithubManifestUrls(parsed, effectiveRepo)) {
          githubManifestCache = {
            fetchedAt: now,
            githubRepo: effectiveRepo,
            manifest: parsed,
            source: cand.source,
          };
          return { manifest: parsed, source: cand.source, cached: false, githubRepo: effectiveRepo };
        }
        break;
      } catch {
        // retry transient network/timeout jitter once before moving on
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  }

  // Fallback to GitHub Releases REST API (uses optional server/dev token if configured to avoid shared IP 60/hr quota)
  const apiUrl = `https://api.github.com/repos/${effectiveRepo}/releases?per_page=6`;
  const ghToken = String(
    process.env.TWINKLEBOT_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      ""
  ).trim();
  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "TwinkleBot-Updater/1.0.0",
  };
  if (ghToken) {
    apiHeaders.Authorization = `Bearer ${ghToken}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(apiUrl, {
      headers: apiHeaders,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new GithubReleaseCheckError(
      "GITHUB_UNREACHABLE",
      `无法连接 GitHub Releases 服务：${err?.message || "网络超时"}`
    );
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new GithubReleaseCheckError(
        "NO_PUBLISHED_RELEASE",
        `GitHub 仓库 (${effectiveRepo}) 暂无公开 Release（尚未发布首个版本，或当前仓库为私有）`
      );
    }
    if (res.status === 403 || res.status === 429) {
      throw new GithubReleaseCheckError(
        "GITHUB_RATE_LIMITED",
        `GitHub 匿名 API 请求已达当前网络每小时限额；首次发布公开 ota-channel Release 后将自动切换至零限流 CDN 通道`
      );
    }
    throw new GithubReleaseCheckError(
      "GITHUB_UNREACHABLE",
      `GitHub Releases 查询失败: HTTP ${res.status}`
    );
  }

  const releases = (await res.json()) as any[];
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new GithubReleaseCheckError(
      "NO_PUBLISHED_RELEASE",
      `GitHub 仓库 (${effectiveRepo}) 暂无已发布 Release`
    );
  }

  for (const rel of releases) {
    if (rel?.draft || !Array.isArray(rel?.assets)) continue;
    const asset = rel.assets.find(
      (a: any) => String(a?.name || "").toLowerCase() === "version-manifest.json"
    );
    if (!asset?.browser_download_url) continue;
    try {
      const mRes = await fetchImpl(asset.browser_download_url, {
        headers: { "User-Agent": "TwinkleBot-Updater/1.0.0" },
        redirect: "follow",
        signal: AbortSignal.timeout(8_000),
      });
      if (!mRes.ok) continue;
      const parsed = (await mRes.json()) as VersionManifest;
      if (validateGithubManifestUrls(parsed, effectiveRepo)) {
        githubManifestCache = {
          fetchedAt: now,
          githubRepo: effectiveRepo,
          manifest: parsed,
          source: "github-release-asset",
        };
        return {
          manifest: parsed,
          source: "github-release-asset",
          cached: false,
          githubRepo: effectiveRepo,
        };
      }
    } catch {}
  }

  const synthesized = synthesizeManifestFromReleasesApi(
    releases,
    currentAppVersion,
    effectiveRepo
  );
  githubManifestCache = {
    fetchedAt: now,
    githubRepo: effectiveRepo,
    manifest: synthesized,
    source: "github-releases-synthesized",
  };
  return {
    manifest: synthesized,
    source: "github-releases-synthesized",
    cached: false,
    githubRepo: effectiveRepo,
  };
}

export function clearGithubManifestCacheForTest() {
  githubManifestCache = null;
}
