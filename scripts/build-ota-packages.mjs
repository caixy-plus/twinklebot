import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWebBundle, readProjectShellMetadata } from "./build-web.mjs";
import { buildCoreBundle } from "./build-core-bundle.mjs";

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
    else if (arg.startsWith("--shell-tag=")) opts.shellTag = arg.slice("--shell-tag=".length);
    else if (arg.startsWith("--out-file=")) opts.outFile = arg.slice("--out-file=".length);
  }
  return opts;
}

export async function refreshManifestShellAssets({
  baseManifestPath = process.env.BASE_MANIFEST_PATH || "",
  assetsMetaDir = process.env.RELEASE_ASSETS_META_DIR || "",
  shellTag = process.env.SHELL_TAG || "",
  githubRepo = "",
  outFile = "",
} = {}) {
  const resolvedBase = path.resolve(String(baseManifestPath || "").trim());
  if (!baseManifestPath || !fs.existsSync(resolvedBase)) {
    throw new Error(`Missing base manifest at ${resolvedBase || "<empty>"}`);
  }
  let baseManifest;
  try {
    baseManifest = JSON.parse(fs.readFileSync(resolvedBase, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in base manifest (${resolvedBase}): ${err?.message || err}`);
  }
  if (!baseManifest || typeof baseManifest !== "object") {
    throw new Error(`Invalid base manifest payload in ${resolvedBase}`);
  }

  const shellsMeta = readProjectShellMetadata();
  const repo = githubRepo || process.env.TWINKLEBOT_GITHUB_REPO || shellsMeta.githubRepo;
  const effectiveShellTag = String(shellTag || "").trim() || `v${shellsMeta.desktopVersion}`;
  const targetVer = effectiveShellTag.replace(/^v/i, "").trim();
  const manifestVersion = String(baseManifest.shells?.desktop?.latestVersion || "").trim();

  if (manifestVersion && manifestVersion !== targetVer) {
    const unchangedPath = outFile ? path.resolve(outFile) : "";
    if (unchangedPath) {
      fs.mkdirSync(path.dirname(unchangedPath), { recursive: true });
      fs.writeFileSync(unchangedPath, JSON.stringify(baseManifest, null, 2), "utf8");
    }
    return {
      skipped: true,
      reason: "shell-version-mismatch",
      targetVer,
      manifestVersion,
      ...(unchangedPath ? { manifestPath: unchangedPath } : {}),
      manifest: baseManifest,
    };
  }

  const shellDownloadBase = `https://github.com/${repo}/releases/download/${effectiveShellTag}`;
  const { desktopAssets, androidApkAsset } = scanReleaseAssetsMeta(assetsMetaDir, shellDownloadBase);
  if (Object.keys(desktopAssets).length === 0 && !androidApkAsset) {
    throw new Error(`No refreshed shell asset metadata found in ${assetsMetaDir || "<empty>"}`);
  }

  const updated = JSON.parse(JSON.stringify(baseManifest));
  updated.generatedAt = new Date().toISOString();
  updated.shells = updated.shells && typeof updated.shells === "object" ? updated.shells : {};

  if (Object.keys(desktopAssets).length > 0) {
    const primaryDesktop =
      desktopAssets["darwin-arm64"] ||
      desktopAssets["win32-x64"] ||
      desktopAssets["linux-x64"] ||
      desktopAssets["darwin-x64"];
    const prevDesktop =
      updated.shells.desktop && typeof updated.shells.desktop === "object"
        ? updated.shells.desktop
        : {};
    updated.shells.desktop = {
      ...prevDesktop,
      ...(primaryDesktop?.fileName ? { fileName: primaryDesktop.fileName } : {}),
      ...(primaryDesktop?.downloadUrl ? { downloadUrl: primaryDesktop.downloadUrl } : {}),
      ...(primaryDesktop?.sha256 ? { sha256: primaryDesktop.sha256 } : {}),
      ...(primaryDesktop?.sizeBytes ? { sizeBytes: primaryDesktop.sizeBytes } : {}),
      assets: {
        ...(prevDesktop.assets && typeof prevDesktop.assets === "object"
          ? prevDesktop.assets
          : {}),
        ...desktopAssets,
      },
    };
  }

  if (androidApkAsset) {
    const prevAndroid =
      updated.shells.android && typeof updated.shells.android === "object"
        ? updated.shells.android
        : {};
    updated.shells.android = {
      ...prevAndroid,
      fileName: androidApkAsset.fileName,
      downloadUrl: androidApkAsset.downloadUrl,
      ...(androidApkAsset.sha256 ? { sha256: androidApkAsset.sha256 } : {}),
      ...(androidApkAsset.sizeBytes ? { sizeBytes: androidApkAsset.sizeBytes } : {}),
    };
  }

  const resolvedOutFile = path.resolve(outFile || path.join(DEFAULT_OUT_DIR, "version-manifest.json"));
  fs.mkdirSync(path.dirname(resolvedOutFile), { recursive: true });
  fs.writeFileSync(resolvedOutFile, JSON.stringify(updated, null, 2), "utf8");

  return {
    skipped: false,
    manifestPath: resolvedOutFile,
    manifest: updated,
  };
}

export function rewriteManifestRepoUrls(manifest, fromRepo, toRepo) {
  const fromNorm = String(fromRepo || "").trim().replace(/^\/+|\/+$/g, "");
  const toNorm = String(toRepo || "").trim().replace(/^\/+|\/+$/g, "");
  const cloned = JSON.parse(JSON.stringify(manifest));
  if (!fromNorm || !toNorm || fromNorm.toLowerCase() === toNorm.toLowerCase()) {
    return cloned;
  }
  const fromPrefix = `https://github.com/${fromNorm}/releases/`;
  const toPrefix = `https://github.com/${toNorm}/releases/`;
  const rewriteUrl = (val) => {
    const s = typeof val === "string" ? val : "";
    if (!s) return val;
    if (s.toLowerCase().startsWith(fromPrefix.toLowerCase())) {
      return `${toPrefix}${s.slice(fromPrefix.length)}`;
    }
    return s;
  };
  if (cloned.releaseUrl) cloned.releaseUrl = rewriteUrl(cloned.releaseUrl);
  if (cloned.shells && typeof cloned.shells === "object") {
    for (const shell of Object.values(cloned.shells)) {
      if (!shell || typeof shell !== "object") continue;
      if (shell.downloadUrl) shell.downloadUrl = rewriteUrl(shell.downloadUrl);
      if (shell.assets && typeof shell.assets === "object") {
        for (const asset of Object.values(shell.assets)) {
          if (asset && typeof asset === "object" && asset.downloadUrl) {
            asset.downloadUrl = rewriteUrl(asset.downloadUrl);
          }
        }
      }
    }
  }
  if (cloned.bundles && typeof cloned.bundles === "object") {
    for (const bundle of Object.values(cloned.bundles)) {
      if (bundle && typeof bundle === "object" && bundle.bundleUrl) {
        bundle.bundleUrl = rewriteUrl(bundle.bundleUrl);
      }
    }
  }
  return cloned;
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
    const desktopCoreStage = path.join(stageRoot, "desktop-core");

    const desktopBuild = await buildWebBundle({ target: "desktop", outDir: desktopStage });
    const mobileBuild = await buildWebBundle({ target: "mobile", outDir: mobileStage });
    const coreBuild = await buildCoreBundle({
      outDir: desktopCoreStage,
      desktopWebDir: desktopStage,
    });

    const desktopArchiveName = "twinklebot-web-desktop.tar.gz";
    const desktopCoreArchiveName = "twinklebot-core-desktop.tar.gz";
    const mobileArchiveName = "twinklebot-web-mobile.tar.gz";

    const desktopPkg = createTarGzFromDir(
      desktopStage,
      path.join(resolvedOut, desktopArchiveName)
    );
    const desktopCorePkg = createTarGzFromDir(
      desktopCoreStage,
      path.join(resolvedOut, desktopCoreArchiveName)
    );
    const mobilePkg = createTarGzFromDir(
      mobileStage,
      path.join(resolvedOut, mobileArchiveName)
    );

    const effectiveTag =
      releaseTag ||
      (normalizedMode === "ota-only"
        ? `ota-${coreBuild.meta.coreBuild}`
        : `v${shellsMeta.desktopVersion}`);
    const bundleDownloadBase = `https://github.com/${repo}/releases/download/${effectiveTag}`;
    const resolvedReleaseUrl =
      releaseUrl || `https://github.com/${repo}/releases/tag/${effectiveTag}`;

    let shellsBlock;
    let backendBlock;

    if (normalizedMode === "ota-only" && baseManifest?.shells) {
      // Core + Frontend OTA mode: preserve exact binary download URLs & SHA-256s from latest full v* release,
      // while honoring raised minVersionForOta / minVersionForCoreOta / minBuildCodeForOta AND refreshing backend capabilities!
      shellsBlock = {
        desktop: {
          ...baseManifest.shells.desktop,
          minVersionForOta: shellsMeta.minDesktopVersionForOta,
          minVersionForCoreOta: shellsMeta.minDesktopVersionForCoreOta,
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
      backendBlock = {
        latestVersion: coreBuild.meta.coreVersion || shellsMeta.backendVersion,
        minCompatibleVersion:
          baseManifest.backend?.minCompatibleVersion ||
          shellsMeta.minBackendCompatibleVersion,
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
          minVersionForCoreOta: shellsMeta.minDesktopVersionForCoreOta,
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
          ? `TwinkleBot 前后端一体化热更新 (${coreBuild.meta.coreBuild})`
          : `TwinkleBot ${shellsMeta.desktopVersion} 全平台发布清单`),
      webBuild: mobileBuild.meta.webBuild,
      coreBuild: coreBuild.meta.coreBuild,
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
        desktopCore: {
          target: "desktop",
          coreBuild: coreBuild.meta.coreBuild,
          coreVersion: coreBuild.meta.coreVersion,
          webBuild: coreBuild.meta.webBuild,
          contentHash: coreBuild.meta.contentHash,
          executorSha256: coreBuild.meta.executorSha256,
          bundleUrl: `${bundleDownloadBase}/${desktopCoreArchiveName}`,
          sha256: desktopCorePkg.sha256,
          sizeBytes: desktopCorePkg.sizeBytes,
          minShellVersion: coreBuild.meta.minShellVersion,
          apiCapabilities: coreBuild.meta.apiCapabilities,
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
      desktopCorePkg,
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
  if (String(cliOpts.mode || "").trim().toLowerCase() === "refresh-shells") {
    const res = await refreshManifestShellAssets(cliOpts);
    console.log(
      `[refresh-shells] skipped=${Boolean(res.skipped)} shellTag=${cliOpts.shellTag || ""} manifest=${res.manifestPath || cliOpts.outFile || ""}`
    );
  } else {
    const res = await buildOtaPackages(cliOpts);
    console.log(
      `[build-ota] mode=${res.mode} manifest=${res.manifestPath} core=${res.desktopCorePkg.sizeBytes}B desktop=${res.desktopPkg.sizeBytes}B mobile=${res.mobilePkg.sizeBytes}B coreBuild=${res.manifest.coreBuild}`
    );
  }
}
