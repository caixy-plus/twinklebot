import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWebBundle, readProjectShellMetadata } from "./build-web.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, "dist-ota");

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return {
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    sizeBytes: buf.length,
  };
}

function classifyAssetEntries(entries, downloadBase, resolveMeta) {
  const desktopAssets = {};
  let androidApkAsset = null;

  const sortedNames = entries.slice().sort();
  const makeAsset = (fileName) => {
    const meta = resolveMeta(fileName) || {};
    // GitHub Releases normalizes spaces in uploaded asset filenames to dots (`.`)
    const githubNormalizedName = String(fileName).replace(/\s+/g, ".");
    return {
      fileName: githubNormalizedName,
      downloadUrl: `${downloadBase}/${encodeURIComponent(githubNormalizedName)}`,
      ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
      ...(meta.sizeBytes ? { sizeBytes: meta.sizeBytes } : {}),
    };
  };

  const pick = (predicate) => sortedNames.find(predicate) || null;

  const macArmDmg =
    pick((n) => /arm64.*\.dmg$/i.test(n)) ||
    pick((n) => /arm64.*mac.*\.zip$/i.test(n));
  const macX64Dmg =
    pick((n) => /(?:x64|intel).*\.dmg$/i.test(n)) ||
    pick((n) => /\.dmg$/i.test(n) && !/arm64/i.test(n)) ||
    pick((n) => /x64.*mac.*\.zip$/i.test(n));
  const winExe =
    pick((n) => /\.exe$/i.test(n)) ||
    pick((n) => /win.*\.zip$/i.test(n));
  const linuxAppImage =
    pick((n) => /\.AppImage$/i.test(n)) ||
    pick((n) => /linux.*\.tar\.gz$/i.test(n));

  if (macArmDmg) desktopAssets["darwin-arm64"] = makeAsset(macArmDmg);
  if (macX64Dmg) desktopAssets["darwin-x64"] = makeAsset(macX64Dmg);
  if (winExe) desktopAssets["win32-x64"] = makeAsset(winExe);
  if (linuxAppImage) desktopAssets["linux-x64"] = makeAsset(linuxAppImage);

  const apkName =
    pick((n) => /release\.apk$/i.test(n) && !/unsigned/i.test(n)) ||
    pick((n) => /debug\.apk$/i.test(n)) ||
    pick((n) => /\.apk$/i.test(n));
  if (apkName) {
    androidApkAsset = makeAsset(apkName);
  }

  return { desktopAssets, androidApkAsset };
}

function scanReleaseAssets(assetsDir, downloadBase) {
  if (!assetsDir || !fs.existsSync(assetsDir)) {
    return { desktopAssets: {}, androidApkAsset: null };
  }
  const entries = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return classifyAssetEntries(entries, downloadBase, (fileName) =>
    sha256File(path.join(assetsDir, fileName))
  );
}

function scanReleaseAssetsMeta(metaDir, downloadBase) {
  if (!metaDir || !fs.existsSync(metaDir)) {
    return { desktopAssets: {}, androidApkAsset: null };
  }
  const byName = new Map();
  for (const ent of fs.readdirSync(metaDir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(metaDir, ent.name), "utf8"));
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item?.fileName) continue;
        byName.set(String(item.fileName), {
          sha256: item.sha256 ? String(item.sha256) : undefined,
          sizeBytes: Number(item.sizeBytes || 0) || undefined,
        });
      }
    } catch {}
  }
  return classifyAssetEntries([...byName.keys()], downloadBase, (fileName) =>
    byName.get(fileName)
  );
}

function parseCliArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) opts.mode = arg.slice("--mode=".length);
    else if (arg.startsWith("--assets-dir=")) opts.assetsDir = arg.slice("--assets-dir=".length);
    else if (arg.startsWith("--assets-meta=")) opts.assetsMetaDir = arg.slice("--assets-meta=".length);
    else if (arg.startsWith("--base-manifest=")) opts.baseManifestPath = arg.slice("--base-manifest=".length);
    else if (arg.startsWith("--release-tag=")) opts.releaseTag = arg.slice("--release-tag=".length);
    else if (arg.startsWith("--release-notes=")) opts.releaseNotes = arg.slice("--release-notes=".length);
    else if (arg.startsWith("--out-dir=")) opts.outDir = arg.slice("--out-dir=".length);
  }
  return opts;
}

export async function buildOtaPackages({
  mode = process.env.OTA_BUILD_MODE || "full",
  outDir = DEFAULT_OUT_DIR,
  assetsDir = process.env.RELEASE_ASSETS_DIR || "",
  assetsMetaDir = process.env.RELEASE_ASSETS_META_DIR || "",
  baseManifestPath = process.env.BASE_MANIFEST_PATH || "",
  releaseTag = process.env.RELEASE_TAG || "",
  releaseNotes = process.env.RELEASE_NOTES || "",
  releaseUrl = "",
  githubRepo = "",
} = {}) {
  const tarGzipPath = path.join(
    PROJECT_ROOT,
    "dist-server",
    "src",
    "lib",
    "tar-gzip.js"
  );
  if (!fs.existsSync(tarGzipPath)) {
    throw new Error(
      `Missing compiled tar-gzip helper at ${tarGzipPath}. Run npm run build:ts first.`
    );
  }
  const { createTarGzFromDir } = await import(pathToFileURL(tarGzipPath).href);

  const normalizedMode = String(mode || "full").trim().toLowerCase() === "ota-only"
    ? "ota-only"
    : "full";
  const resolvedOut = path.resolve(outDir);
  fs.mkdirSync(resolvedOut, { recursive: true });

  const shellsMeta = readProjectShellMetadata();
  const repo = githubRepo || process.env.TWINKLEBOT_GITHUB_REPO || shellsMeta.githubRepo;
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-ota-"));

  let baseManifest = null;
  if (baseManifestPath && fs.existsSync(baseManifestPath)) {
    try {
      baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, "utf8"));
    } catch {}
  }

  try {
    const desktopStage = path.join(stageRoot, "desktop");
    const mobileStage = path.join(stageRoot, "mobile");

    const desktopBuild = await buildWebBundle({ target: "desktop", outDir: desktopStage });
    const mobileBuild = await buildWebBundle({ target: "mobile", outDir: mobileStage });

    const desktopArchiveName = "twinklebot-web-desktop.tar.gz";
    const mobileArchiveName = "twinklebot-web-mobile.tar.gz";

    const desktopPkg = createTarGzFromDir(
      desktopStage,
      path.join(resolvedOut, desktopArchiveName)
    );
    const mobilePkg = createTarGzFromDir(
      mobileStage,
      path.join(resolvedOut, mobileArchiveName)
    );

    const effectiveTag =
      releaseTag ||
      (normalizedMode === "ota-only"
        ? `ota-${mobileBuild.meta.webBuild}`
        : `v${shellsMeta.desktopVersion}`);
    const bundleDownloadBase = `https://github.com/${repo}/releases/download/${effectiveTag}`;
    const resolvedReleaseUrl =
      releaseUrl || `https://github.com/${repo}/releases/tag/${effectiveTag}`;

    let shellsBlock;
    let backendBlock;

    if (normalizedMode === "ota-only" && baseManifest?.shells) {
      // Pure-frontend OTA mode: preserve exact binary download URLs & SHA-256s from latest full v* release,
      // while honoring any raised minVersionForOta / minBuildCodeForOta in version-policy.json!
      shellsBlock = {
        desktop: {
          ...baseManifest.shells.desktop,
          minVersionForOta: shellsMeta.minDesktopVersionForOta,
        },
        android: {
          ...baseManifest.shells.android,
          minVersionForOta: shellsMeta.minAndroidVersionForOta,
          minBuildCodeForOta: shellsMeta.minAndroidBuildCodeForOta,
        },
        ios: {
          ...baseManifest.shells.ios,
          minVersionForOta: shellsMeta.minIosVersionForOta,
          minBuildCodeForOta: shellsMeta.minIosBuildCodeForOta,
        },
      };
      backendBlock = baseManifest.backend || {
        latestVersion: shellsMeta.backendVersion,
        minCompatibleVersion: shellsMeta.minBackendCompatibleVersion,
        apiCapabilities: shellsMeta.policyApiCapabilities,
      };
    } else {
      const shellTag = normalizedMode === "ota-only"
        ? `v${shellsMeta.desktopVersion}`
        : effectiveTag;
      const shellDownloadBase = `https://github.com/${repo}/releases/download/${shellTag}`;
      const shellReleasePage = `https://github.com/${repo}/releases/tag/${shellTag}`;
      const { desktopAssets, androidApkAsset } = assetsMetaDir
        ? scanReleaseAssetsMeta(assetsMetaDir, shellDownloadBase)
        : scanReleaseAssets(assetsDir, shellDownloadBase);
      const primaryDesktop =
        desktopAssets["darwin-arm64"] ||
        desktopAssets["win32-x64"] ||
        desktopAssets["linux-x64"] ||
        desktopAssets["darwin-x64"];

      shellsBlock = {
        desktop: {
          latestVersion: shellsMeta.desktopVersion,
          minVersionForOta: shellsMeta.minDesktopVersionForOta,
          fileName: primaryDesktop?.fileName || `TwinkleBot-${shellsMeta.desktopVersion}-arm64.dmg`,
          downloadUrl: primaryDesktop?.downloadUrl || shellReleasePage,
          ...(primaryDesktop?.sha256 ? { sha256: primaryDesktop.sha256 } : {}),
          ...(primaryDesktop?.sizeBytes ? { sizeBytes: primaryDesktop.sizeBytes } : {}),
          ...(Object.keys(desktopAssets).length > 0 ? { assets: desktopAssets } : {}),
        },
        android: {
          latestVersion: shellsMeta.androidVersion,
          latestBuildCode: shellsMeta.androidBuildCode,
          minVersionForOta: shellsMeta.minAndroidVersionForOta,
          minBuildCodeForOta: shellsMeta.minAndroidBuildCodeForOta,
          fileName: androidApkAsset?.fileName || "TwinkleBot-mobile-release.apk",
          downloadUrl:
            androidApkAsset?.downloadUrl ||
            `${shellDownloadBase}/TwinkleBot-mobile-release.apk`,
          ...(androidApkAsset?.sha256 ? { sha256: androidApkAsset.sha256 } : {}),
          ...(androidApkAsset?.sizeBytes ? { sizeBytes: androidApkAsset.sizeBytes } : {}),
        },
        ios: {
          latestVersion: shellsMeta.iosVersion,
          latestBuildCode: shellsMeta.iosBuildCode,
          minVersionForOta: shellsMeta.minIosVersionForOta,
          minBuildCodeForOta: shellsMeta.minIosBuildCodeForOta,
        },
      };
      backendBlock = {
        latestVersion: shellsMeta.backendVersion,
        minCompatibleVersion: shellsMeta.minBackendCompatibleVersion,
        apiCapabilities: shellsMeta.policyApiCapabilities,
      };
    }

    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      releaseTag: effectiveTag,
      releaseUrl: resolvedReleaseUrl,
      releaseNotes:
        releaseNotes ||
        (normalizedMode === "ota-only"
          ? `TwinkleBot 纯前端热更新 (${mobileBuild.meta.webBuild})`
          : `TwinkleBot ${shellsMeta.desktopVersion} 全平台发布清单`),
      webBuild: mobileBuild.meta.webBuild,
      shells: shellsBlock,
      backend: backendBlock,
      bundles: {
        desktop: {
          target: "desktop",
          webBuild: desktopBuild.meta.webBuild,
          contentHash: desktopBuild.meta.contentHash,
          bundleUrl: `${bundleDownloadBase}/${desktopArchiveName}`,
          sha256: desktopPkg.sha256,
          sizeBytes: desktopPkg.sizeBytes,
          requiredApiCapabilities: desktopBuild.meta.requiredApiCapabilities,
        },
        mobile: {
          target: "mobile",
          webBuild: mobileBuild.meta.webBuild,
          contentHash: mobileBuild.meta.contentHash,
          bundleUrl: `${bundleDownloadBase}/${mobileArchiveName}`,
          sha256: mobilePkg.sha256,
          sizeBytes: mobilePkg.sizeBytes,
          requiredApiCapabilities: mobileBuild.meta.requiredApiCapabilities,
        },
      },
    };

    const manifestPath = path.join(resolvedOut, "version-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return {
      mode: normalizedMode,
      outDir: resolvedOut,
      manifestPath,
      manifest,
      desktopPkg,
      mobilePkg,
    };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  const res = await buildOtaPackages(cliOpts);
  console.log(
    `[build-ota] mode=${res.mode} manifest=${res.manifestPath} desktop=${res.desktopPkg.sizeBytes}B mobile=${res.mobilePkg.sizeBytes}B webBuild=${res.manifest.webBuild}`
  );
}
