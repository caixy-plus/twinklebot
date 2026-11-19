import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import {
  BASELINE_V1_2_CAPABILITIES,
  CURRENT_API_CAPABILITIES,
  compareSemver,
  compareWebBuild,
  evaluateConnectedNodeStatus,
  evaluateUpdateCompatibility,
  nodeSupportsCapability,
  resolveDesktopAssetForPlatform,
  type VersionManifest,
} from "../src/shared/versioning.js";
import { createTarGzFromDir, extractTarGzSafely } from "../src/lib/tar-gzip.js";
import { createWebOtaManager } from "../src/electron/web-ota.js";
import {
  clearGithubManifestCacheForTest,
  fetchLatestGithubManifest,
  isTrustedGithubReleaseUrl,
} from "../src/lib/github-releases.js";
import { createServer } from "../src/server/index.js";

const _UP_ONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.basename(_UP_ONE) === "dist-server" ? path.dirname(_UP_ONE) : _UP_ONE;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRawUstarTarGz(entries: Array<{ name: string; type?: string; content?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const ent of entries) {
    const data = Buffer.from(ent.content || "", "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(ent.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(ent.type || "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header);
    if (data.length > 0) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks));
}

test("version-policy.json stays strictly synchronized with package.json, Android build.gradle, iOS project.pbxproj, and API capabilities", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "version-policy.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const gradle = fs.readFileSync(path.join(ROOT, "android", "app", "build.gradle"), "utf8");
  const pbx = fs.readFileSync(
    path.join(ROOT, "ios", "App", "App.xcodeproj", "project.pbxproj"),
    "utf8"
  );

  assert.equal(policy.baselineVersion, "1.0.0");
  assert.equal(policy.shells.desktop.version, pkg.version);
  assert.equal(policy.backend.version, pkg.version);
  assert.ok(compareSemver(policy.shells.desktop.version, policy.shells.desktop.minVersionForOta) >= 0);

  const gradleVer = gradle.match(/versionName\s+"([^"]+)"/)?.[1];
  const gradleCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
  assert.equal(policy.shells.android.version, gradleVer);
  assert.equal(policy.shells.android.buildCode, gradleCode);
  assert.ok(compareSemver(policy.shells.android.version, policy.shells.android.minVersionForOta) >= 0);

  const iosVer = pbx.match(/MARKETING_VERSION\s*=\s*([^;\s]+);/)?.[1];
  const iosCode = Number(pbx.match(/CURRENT_PROJECT_VERSION\s*=\s*(\d+);/)?.[1]);
  assert.equal(policy.shells.ios.version, iosVer);
  assert.equal(policy.shells.ios.buildCode, iosCode);
  assert.ok(compareSemver(policy.shells.ios.version, policy.shells.ios.minVersionForOta) >= 0);

  assert.deepEqual(policy.backend.apiCapabilities, [...CURRENT_API_CAPABILITIES]);
});

test("compareSemver and compareWebBuild enforce monotonic ordering and short-circuit identical hashes", () => {
  assert.equal(compareSemver("1.2.0", "1.2.0"), 0);
  assert.equal(compareSemver("v1.2.1", "1.2.0"), 1);
  assert.equal(compareSemver("1.2.0-beta.1", "1.2.0"), -1);
  assert.equal(compareSemver("1.10.0", "1.2.9"), 1);

  assert.equal(compareWebBuild("20261117.1600-abcd123456", "20261116.1200-abcd123456"), 0);
  assert.equal(compareWebBuild("20261117.1605-ff00112233", "20261117.1600-abcd123456"), 1);
  assert.equal(compareWebBuild("20261117.1500-ff00112233", "20261117.1600-abcd123456"), -1);
});

test("evaluateUpdateCompatibility decouples Desktop/Android/iOS shells, selects per-OS assets, and handles LAN-vs-Cloud backend skew", () => {
  const manifest: VersionManifest = {
    schemaVersion: 1,
    generatedAt: "2026-11-18T08:00:00.000Z",
    releaseTag: "v1.3.0",
    releaseUrl: "https://github.com/caixy-plus/twinklebot/releases/tag/v1.3.0",
    webBuild: "20261118.1200-aabbccddee",
    shells: {
      desktop: {
        latestVersion: "1.3.0",
        minVersionForOta: "1.2.0",
        downloadUrl: "https://github.com/caixy-plus/twinklebot/releases/tag/v1.3.0",
        assets: {
          "darwin-arm64": {
            fileName: "TwinkleBot-1.3.0-arm64.dmg",
            downloadUrl: "https://github.com/caixy-plus/twinklebot/releases/download/v1.3.0/TwinkleBot-1.3.0-arm64.dmg",
            sha256: "1".repeat(64),
          },
          "win32-x64": {
            fileName: "TwinkleBot-Setup-1.3.0.exe",
            downloadUrl: "https://github.com/caixy-plus/twinklebot/releases/download/v1.3.0/TwinkleBot-Setup-1.3.0.exe",
            sha256: "2".repeat(64),
          },
          "linux-x64": {
            fileName: "TwinkleBot-1.3.0.AppImage",
            downloadUrl: "https://github.com/caixy-plus/twinklebot/releases/download/v1.3.0/TwinkleBot-1.3.0.AppImage",
            sha256: "3".repeat(64),
          },
        },
      },
      // Android published an optional 1.2.1 native tweak while keeping minVersionForOta = 1.2.0!
      android: {
        latestVersion: "1.2.1",
        latestBuildCode: 4,
        minVersionForOta: "1.2.0",
        minBuildCodeForOta: 3,
        fileName: "TwinkleBot-mobile-release.apk",
        downloadUrl: "https://github.com/caixy-plus/twinklebot/releases/download/v1.3.0/TwinkleBot-mobile-release.apk",
      },
      ios: {
        latestVersion: "1.2.0",
        latestBuildCode: 1,
        minVersionForOta: "1.2.0",
        minBuildCodeForOta: 1,
      },
    },
    backend: {
      latestVersion: "1.3.0",
      minCompatibleVersion: "1.2.0",
      apiCapabilities: [...CURRENT_API_CAPABILITIES, "swarm-v2"],
    },
    bundles: {
      desktop: {
        target: "desktop",
        webBuild: "20261118.1200-aabbccddee",
        bundleUrl: "https://github.com/caixy-plus/twinklebot/releases/download/v1.3.0/twinklebot-web-desktop.tar.gz",
        sha256: "a".repeat(64),
        sizeBytes: 400_000,
      },
      mobile: {
        target: "mobile",
        webBuild: "20261118.1200-aabbccddee",
        bundleUrl: "https://github.com/caixy-plus/twinklebot/releases/download/v1.3.0/twinklebot-web-mobile.tar.gz",
        sha256: "b".repeat(64),
        sizeBytes: 400_000,
      },
    },
  };

  // 1. Desktop 1.2.0 on Windows x64 gets full installer update matched to win32-x64 (.exe, NOT .dmg!)
  const winDesk = evaluateUpdateCompatibility(manifest, {
    platform: "desktop",
    desktopArch: "win32-x64",
    nativeVersion: "1.2.0",
    activeWebBuild: "20261117.1000-1122334455",
  });
  assert.equal(winDesk.status, "shell-update-required");
  assert.equal(winDesk.resolvedAsset?.fileName, "TwinkleBot-Setup-1.3.0.exe");
  assert.equal(winDesk.resolvedAsset?.sha256, "2".repeat(64));
  assert.equal(
    resolveDesktopAssetForPlatform(manifest.shells.desktop, "darwin-arm64")?.fileName,
    "TwinkleBot-1.3.0-arm64.dmg"
  );

  // 2. Desktop already on 1.3.0 receiving a newer webBuild gets pure-frontend OTA!
  const deskOn130 = evaluateUpdateCompatibility(manifest, {
    platform: "desktop",
    desktopArch: "darwin-arm64",
    nativeVersion: "1.3.0",
    activeWebBuild: "20261118.0900-1122334455",
  });
  assert.equal(deskOn130.status, "ota-available");
  assert.equal(deskOn130.otaBundle?.target, "desktop");

  // 3. Android 1.2.0 (build 3) STILL gets pure-frontend OTA because minVersionForOta is 1.2.0, plus optionalShellUpdate!
  const and120 = evaluateUpdateCompatibility(manifest, {
    platform: "android",
    nativeVersion: "1.2.0",
    nativeBuildCode: 3,
    activeWebBuild: "20261117.1000-1122334455",
  });
  assert.equal(and120.status, "ota-available");
  assert.equal(and120.optionalShellUpdate?.latestVersion, "1.2.1");

  // 4. Never downgrades if client already has a newer webBuild (prevents ping-pong!)
  const noDowngrade = evaluateUpdateCompatibility(manifest, {
    platform: "ios",
    nativeVersion: "1.2.0",
    nativeBuildCode: 1,
    activeWebBuild: "20261119.0001-9988776655",
  });
  assert.equal(noDowngrade.status, "up-to-date");

  // 5. Multi-node skew: Phone updated to 1.3.0 UI switches between Cloud (1.3.0) and LAN (1.2.0)
  const cloudDiag = {
    appVersion: "1.3.0",
    deployEnv: "cloud",
    apiCapabilities: [...CURRENT_API_CAPABILITIES, "swarm-v2"],
  };
  const lanDiag = {
    appVersion: "1.2.0",
    deployEnv: "local",
    apiCapabilities: [...BASELINE_V1_2_CAPABILITIES],
  };

  const cloudStatus = evaluateConnectedNodeStatus(manifest, cloudDiag);
  assert.equal(cloudStatus.nodeOutdated, false);
  assert.equal(nodeSupportsCapability("swarm-v2", cloudDiag), true);
  assert.equal(nodeSupportsCapability("vault-patch-v1", cloudDiag), true);

  const lanStatus = evaluateConnectedNodeStatus(manifest, lanDiag);
  assert.equal(lanStatus.nodeOutdated, true);
  assert.equal(lanStatus.nodeVersion, "1.2.0");
  assert.equal(lanStatus.latestBackendVersion, "1.3.0");
  assert.deepEqual(lanStatus.missingLatestCapabilities, ["multi-display-v1", "swarm-v2"]);
  // v1.2.0 baseline features stay 100% enabled on LAN 1.2.0 while 1.3.0-only feature gracefully gates!
  assert.equal(nodeSupportsCapability("vault-patch-v1", lanDiag), true);
  assert.equal(nodeSupportsCapability("swarm-v2", lanDiag), false);
});

test("buildOtaPackages supports both full mode (per-OS SHA-256 asset scan) and ota-only mode (shell link inheritance)", async () => {
  const { buildOtaPackages } = await import(
    pathToFileURL(path.join(ROOT, "scripts", "build-ota-packages.mjs")).href
  );
  const tmpRoot = makeTempDir("ota-builder-");
  const fakeAssets = path.join(tmpRoot, "assets");
  const fullOut = path.join(tmpRoot, "out-full");
  const otaOnlyOut = path.join(tmpRoot, "out-ota-only");

  try {
    fs.mkdirSync(fakeAssets, { recursive: true });
    fs.writeFileSync(path.join(fakeAssets, "TwinkleBot-1.2.0-arm64.dmg"), "mac-arm64-binary");
    fs.writeFileSync(path.join(fakeAssets, "TwinkleBot-Setup-1.2.0.exe"), "win-x64-binary");
    fs.writeFileSync(path.join(fakeAssets, "TwinkleBot-1.2.0.AppImage"), "linux-x64-binary");
    fs.writeFileSync(path.join(fakeAssets, "TwinkleBot-mobile-release.apk"), "android-apk-binary");

    const fullRes = await buildOtaPackages({
      mode: "full",
      assetsDir: fakeAssets,
      outDir: fullOut,
      releaseTag: "v1.2.0",
    });

    const fullManifest = fullRes.manifest as VersionManifest;
    assert.equal(fullManifest.releaseTag, "v1.2.0");
    assert.equal(
      fullManifest.shells.desktop?.assets?.["darwin-arm64"]?.sha256,
      crypto.createHash("sha256").update("mac-arm64-binary").digest("hex")
    );
    assert.equal(
      fullManifest.shells.desktop?.assets?.["win32-x64"]?.fileName,
      "TwinkleBot-Setup-1.2.0.exe"
    );
    assert.equal(
      fullManifest.shells.android?.sha256,
      crypto.createHash("sha256").update("android-apk-binary").digest("hex")
    );

    // Run ota-only mode inheriting shells from fullManifest
    const otaRes = await buildOtaPackages({
      mode: "ota-only",
      baseManifestPath: fullRes.manifestPath,
      outDir: otaOnlyOut,
      releaseTag: "ota-20261118.1",
    });
    const otaManifest = otaRes.manifest as VersionManifest;
    assert.equal(otaManifest.releaseTag, "ota-20261118.1");
    // Shell download URLs & SHA-256 still point to v1.2.0 installers!
    assert.equal(
      otaManifest.shells.desktop?.assets?.["win32-x64"]?.downloadUrl,
      "https://github.com/caixy-plus/twinklebot-releases/releases/download/v1.2.0/TwinkleBot-Setup-1.2.0.exe"
    );
    assert.equal(
      otaManifest.shells.android?.downloadUrl,
      "https://github.com/caixy-plus/twinklebot-releases/releases/download/v1.2.0/TwinkleBot-mobile-release.apk"
    );
    // While OTA bundles point to the new ota-20261118.1 tag!
    assert.match(
      otaManifest.bundles?.mobile?.bundleUrl || "",
      /\/releases\/download\/ota-20261118\.1\/twinklebot-web-mobile\.tar\.gz$/
    );

    // Verify --assets-meta mode produces identical sha256/sizeBytes manifest without storing large binaries in workflow artifacts
    const metaDir = makeTempDir("meta-json-");
    const metaOut = makeTempDir("meta-out-");
    fs.writeFileSync(
      path.join(metaDir, "mac.json"),
      JSON.stringify([
        {
          fileName: "TwinkleBot-1.2.0-arm64.dmg",
          sha256: fullManifest.shells.desktop?.assets?.["darwin-arm64"]?.sha256,
          sizeBytes: fullManifest.shells.desktop?.assets?.["darwin-arm64"]?.sizeBytes,
        },
      ])
    );
    fs.writeFileSync(
      path.join(metaDir, "android.json"),
      JSON.stringify([
        {
          fileName: "TwinkleBot-mobile-release.apk",
          sha256: fullManifest.shells.android?.sha256,
          sizeBytes: fullManifest.shells.android?.sizeBytes,
        },
      ])
    );
    const metaRes = await buildOtaPackages({
      mode: "full",
      assetsMetaDir: metaDir,
      outDir: metaOut,
      releaseTag: "v1.2.0",
      githubRepo: "caixy-plus/twinklebot-releases",
    });
    assert.equal(
      metaRes.manifest.shells.desktop?.assets?.["darwin-arm64"]?.sha256,
      fullManifest.shells.desktop?.assets?.["darwin-arm64"]?.sha256
    );
    assert.equal(
      metaRes.manifest.shells.android?.sha256,
      fullManifest.shells.android?.sha256
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("tar-gzip packs cleanly and rejects Tar-Slip traversal, absolute paths, and symlinks", () => {
  const srcDir = makeTempDir("tar-src-");
  const outDir = makeTempDir("tar-out-");
  const badDir = makeTempDir("tar-bad-");
  try {
    fs.mkdirSync(path.join(srcDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "index.html"), "<html>ok</html>");
    fs.writeFileSync(path.join(srcDir, "dist", "app.js"), "console.log(1);");
    fs.writeFileSync(path.join(srcDir, "dist", "app.js.map"), "ignored");

    const archive = path.join(outDir, "bundle.tar.gz");
    const pkg = createTarGzFromDir(srcDir, archive);
    assert.equal(pkg.fileCount, 2);
    assert.match(pkg.sha256, /^[a-f0-9]{64}$/);

    const extracted = extractTarGzSafely(archive, path.join(outDir, "unpacked"));
    assert.equal(extracted.fileCount, 2);
    assert.throws(
      () => extractTarGzSafely(makeRawUstarTarGz([{ name: "../evil.txt", content: "x" }]), badDir),
      /traversal|escape/i
    );
    assert.throws(
      () => extractTarGzSafely(makeRawUstarTarGz([{ name: "/etc/passwd", content: "x" }]), badDir),
      /absolute/i
    );
    assert.throws(
      () => extractTarGzSafely(makeRawUstarTarGz([{ name: "link", type: "2", content: "" }]), badDir),
      /link/i
    );
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(badDir, { recursive: true, force: true });
  }
});

test("createWebOtaManager enforces GitHub URL allowlist in production, 5s watchdog rollback, and binary version reset", async () => {
  const userDataDir = makeTempDir("ota-user-");
  const builtInDir = makeTempDir("ota-builtin-");
  const pkgSrcDir = makeTempDir("ota-pkg-");
  const outArchive = path.join(pkgSrcDir, "bundle.tar.gz");

  fs.writeFileSync(path.join(builtInDir, "index.html"), "<html>builtin</html>");
  fs.mkdirSync(path.join(pkgSrcDir, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(pkgSrcDir, "bundle", "index.html"), "<html>ota-v2</html>");
  fs.writeFileSync(
    path.join(pkgSrcDir, "bundle", "web-meta.json"),
    JSON.stringify({ webBuild: "20261117.1700-1234567890" })
  );
  const pkg = createTarGzFromDir(path.join(pkgSrcDir, "bundle"), outArchive);
  const gzBytes = fs.readFileSync(outArchive);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(gzBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const loopbackUrl = `http://127.0.0.1:${port}/bundle.tar.gz`;

  try {
    assert.equal(
      isTrustedGithubReleaseUrl("https://github.com/caixy-plus/twinklebot/releases/download/v1.2.0/a.tar.gz"),
      true
    );
    assert.equal(
      isTrustedGithubReleaseUrl("https://objects.githubusercontent.com/github-production-release-asset/123"),
      true
    );
    assert.equal(
      isTrustedGithubReleaseUrl("https://github.com/caixy-plus/twinklebot-releases/releases/download/v1.2.0/a.tar.gz"),
      true
    );
    assert.equal(
      isTrustedGithubReleaseUrl("https://github.com/other-org/repo/releases/download/v1/a.tar.gz"),
      false
    );
    assert.equal(isTrustedGithubReleaseUrl(loopbackUrl), false);

    // Production default (allowLoopbackForTest = false) blocks non-GitHub loopback URLs!
    const prodMgr = createWebOtaManager({
      userDataDir,
      appVersion: "1.2.0",
      builtInPublicDir: builtInDir,
    });
    await assert.rejects(
      () =>
        prodMgr.applyFromUrl({
          bundleUrl: loopbackUrl,
          expectedSha256: pkg.sha256,
          webBuild: "20261117.1700-1234567890",
        }),
      /未受信任的 GitHub/
    );
    prodMgr.dispose();

    // Test lifecycle with allowLoopbackForTest: true
    const mgr = createWebOtaManager({
      userDataDir,
      appVersion: "1.2.0",
      builtInPublicDir: builtInDir,
      allowLoopbackForTest: true,
      watchdogTimeoutMs: 60,
    });
    await mgr.applyFromUrl({
      bundleUrl: loopbackUrl,
      expectedSha256: pkg.sha256,
      webBuild: "20261117.1700-1234567890",
    });
    mgr.confirmReady("20261117.1700-1234567890");
    assert.equal(mgr.getStatus().lastGoodBuild, "20261117.1700-1234567890");

    // Unconfirmed update triggers 5s watchdog auto-rollback
    fs.writeFileSync(path.join(pkgSrcDir, "bundle", "index.html"), "<html>bad-v3</html>");
    fs.writeFileSync(
      path.join(pkgSrcDir, "bundle", "web-meta.json"),
      JSON.stringify({ webBuild: "20261117.1800-abcdef0123" })
    );
    const badPkg = createTarGzFromDir(path.join(pkgSrcDir, "bundle"), outArchive);
    const badBytes = fs.readFileSync(outArchive);

    const mgrWatchdog = createWebOtaManager({
      userDataDir,
      appVersion: "1.2.0",
      builtInPublicDir: builtInDir,
      allowLoopbackForTest: true,
      watchdogTimeoutMs: 40,
      fetchImpl: async () => new Response(badBytes, { status: 200 }),
    });
    await mgrWatchdog.applyFromUrl({
      bundleUrl: loopbackUrl,
      expectedSha256: badPkg.sha256,
      webBuild: "20261117.1800-abcdef0123",
    });
    await new Promise((r) => setTimeout(r, 95));
    assert.equal(mgrWatchdog.getStatus().activeBuild, "20261117.1700-1234567890");
    assert.match(mgrWatchdog.getStatus().lastRollbackReason, /自动回滚/);
    mgrWatchdog.dispose();
    mgr.dispose();

    // Reinstalling same appVersion with a newer built-in webBuild also clears stale OTA cache
    const newerBuiltInDir = makeTempDir("ota-builtin-newer-");
    try {
      fs.writeFileSync(path.join(newerBuiltInDir, "index.html"), "<html>builtin-newer</html>");
      fs.writeFileSync(
        path.join(newerBuiltInDir, "web-meta.json"),
        JSON.stringify({ webBuild: "20261118.0900-9999999999" })
      );
      const reinstalledSameSemver = createWebOtaManager({
        userDataDir,
        appVersion: "1.2.0",
        builtInPublicDir: newerBuiltInDir,
      });
      assert.equal(reinstalledSameSemver.getStatus().usingBuiltIn, true);
      assert.equal(reinstalledSameSemver.getStatus().activeBuild, null);
      reinstalledSameSemver.dispose();
    } finally {
      fs.rmSync(newerBuiltInDir, { recursive: true, force: true });
    }

    // Re-seed an active OTA build at 1.2.0 to also verify semver bump reset
    const reseed = createWebOtaManager({
      userDataDir,
      appVersion: "1.2.0",
      builtInPublicDir: builtInDir,
      allowLoopbackForTest: true,
    });
    await reseed.applyFromUrl({
      bundleUrl: loopbackUrl,
      expectedSha256: pkg.sha256,
      webBuild: "20261117.1700-1234567890",
    });
    reseed.confirmReady("20261117.1700-1234567890");
    reseed.dispose();

    // Binary upgrade clears stale OTA cache
    const upgraded = createWebOtaManager({
      userDataDir,
      appVersion: "1.3.0",
      builtInPublicDir: builtInDir,
    });
    assert.equal(upgraded.getStatus().usingBuiltIn, true);
    assert.equal(upgraded.getStatus().activeBuild, null);
    upgraded.dispose();
  } finally {
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(builtInDir, { recursive: true, force: true });
    fs.rmSync(pkgSrcDir, { recursive: true, force: true });
  }
});

test("GitHub CDN manifest resolution & server endpoints work cleanly and host bundle routes are removed", async () => {
  clearGithubManifestCacheForTest();
  const validManifest: VersionManifest = {
    schemaVersion: 1,
    generatedAt: "2026-11-17T08:00:00.000Z",
    releaseTag: "ota-20261117.1",
    releaseUrl: "https://github.com/caixy-plus/twinklebot-releases/releases/tag/ota-20261117.1",
    webBuild: "20261117.1645-ffeedd1122",
    shells: {
      desktop: {
        latestVersion: "1.2.0",
        minVersionForOta: "1.2.0",
        downloadUrl: "https://github.com/caixy-plus/twinklebot-releases/releases/tag/v1.2.0",
      },
    },
    bundles: {
      mobile: {
        target: "mobile",
        webBuild: "20261117.1645-ffeedd1122",
        bundleUrl: "https://github.com/caixy-plus/twinklebot-releases/releases/download/ota-20261117.1/twinklebot-web-mobile.tar.gz",
        sha256: "c".repeat(64),
        sizeBytes: 12345,
      },
    },
  };

  // Rejects manifest containing untrusted bundleUrl, then falls back cleanly
  let callIdx = 0;
  const fetched = await fetchLatestGithubManifest({
    force: true,
    fetchImpl: async (url) => {
      callIdx += 1;
      const u = String(url);
      if (u.includes("/ota-channel/")) {
        const poisoned = {
          ...validManifest,
          bundles: {
            mobile: {
              ...validManifest.bundles!.mobile!,
              bundleUrl: "https://attacker.example.com/evil.tar.gz",
            },
          },
        };
        return new Response(JSON.stringify(poisoned), { status: 200 });
      }
      if (u.includes("/releases/latest/download/")) {
        return new Response(JSON.stringify(validManifest), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  assert.equal(fetched.source, "github-latest-cdn");
  assert.equal(fetched.manifest.webBuild, "20261117.1645-ffeedd1122");
  assert.ok(callIdx >= 2);

  clearGithubManifestCacheForTest();
  const server = createServer({
    config: { deployEnv: "local", host: "127.0.0.1", port: 0 },
    billingFetchImpl: async () =>
      new Response(JSON.stringify(validManifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Host-served OTA bundle endpoints are completely removed (single-source GitHub!)
    const removedManifest = await fetch(`${baseUrl}/api/system/ota/manifest`);
    assert.equal(removedManifest.status, 404);
    const removedBundle = await fetch(`${baseUrl}/api/system/ota/bundle?target=mobile`);
    assert.equal(removedBundle.status, 404);

    // Diagnostics & GitHub update check remain active
    const diagRes = await fetch(`${baseUrl}/api/system/diagnostics`);
    assert.equal(diagRes.status, 200);
    const diag = (await diagRes.json()) as any;
    assert.ok(Array.isArray(diag.apiCapabilities));

    const updRes = await fetch(`${baseUrl}/api/system/updates/check?force=1`);
    assert.equal(updRes.status, 200);
    const upd = (await updRes.json()) as any;
    assert.equal(upd.ok, true);
    assert.equal(upd.source, "github-ota-channel-cdn");
    assert.equal(upd.manifest.webBuild, "20261117.1645-ffeedd1122");
  } finally {
    server.close();
    clearGithubManifestCacheForTest();
  }

  // Graceful HTTP 200 structured response when GitHub has no published release (404) or hits rate limit (403)
  let mockStatus = 404;
  const errServer = createServer({
    config: { deployEnv: "local", host: "127.0.0.1", port: 0 },
    billingFetchImpl: async () => new Response("upstream error", { status: mockStatus }),
  });
  await new Promise<void>((resolve) => errServer.listen(0, "127.0.0.1", resolve));
  const errPort = (errServer.address() as any).port;
  const errBaseUrl = `http://127.0.0.1:${errPort}`;
  try {
    const res404 = await fetch(`${errBaseUrl}/api/system/updates/check?force=1`);
    assert.equal(res404.status, 200);
    const body404 = (await res404.json()) as any;
    assert.equal(body404.ok, false);
    assert.equal(body404.code, "NO_PUBLISHED_RELEASE");

    mockStatus = 403;
    const res403 = await fetch(`${errBaseUrl}/api/system/updates/check?force=1`);
    assert.equal(res403.status, 200);
    const body403 = (await res403.json()) as any;
    assert.equal(body403.ok, false);
    assert.equal(body403.code, "GITHUB_RATE_LIMITED");
  } finally {
    errServer.close();
    clearGithubManifestCacheForTest();
  }
});
