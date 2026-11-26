import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSelfUpdateActions } from "../src/lib/self-update.js";
import { clearGithubManifestCacheForTest } from "../src/lib/github-releases.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import { CURRENT_API_CAPABILITIES, DEFAULT_GITHUB_REPO } from "../src/shared/versioning.js";

function makeTempProject(prefix: string): { projectRoot: string; publicDir: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const publicDir = path.join(projectRoot, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "version-policy.json"),
    JSON.stringify({
      baselineVersion: "1.0.0",
      githubRepo: DEFAULT_GITHUB_REPO,
      shells: {
        desktop: { version: "1.0.5", minVersionForOta: "1.0.0", minVersionForCoreOta: "1.0.4" },
      },
    })
  );
  fs.writeFileSync(
    path.join(publicDir, "web-meta.json"),
    JSON.stringify({ webBuild: "20261101.010000-aaa", appVersion: "1.0.5" })
  );
  return { projectRoot, publicDir };
}

function makeManifestFetch(manifest: Record<string, any>) {
  return (async (url: string | URL) => {
    const u = String(url);
    if (
      u.includes("version-manifest.json") ||
      u.includes("/releases/tags/ota-channel") ||
      u.includes("/releases/latest")
    ) {
      if (u.includes("/releases/tags/ota-channel")) {
        return new Response(
          JSON.stringify({
            tag_name: "ota-channel",
            html_url: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/tag/ota-channel`,
            assets: [
              {
                name: "version-manifest.json",
                browser_download_url: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/ota-channel/version-manifest.json`,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("createSelfUpdateActions reports status and checks updates across up-to-date, ota-available, and shell-update-required", async (t) => {
  clearGithubManifestCacheForTest();
  t.after(() => clearGithubManifestCacheForTest());

  const { projectRoot, publicDir } = makeTempProject("twinkle-self-update-");
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const fakeOtaStatus = {
    supportsCoreOta: true,
    builtInAppVersion: "1.0.5",
    activeCoreBuild: "20261101.010000-aaa",
    previousCoreBuild: "20261030.120000-zzz",
  };

  // 1. ota-available + apply deferred while Bot turn is active
  const otaActions = createSelfUpdateActions({
    projectRoot,
    publicDir,
    appVersion: "1.0.5",
    otaController: {
      getStatus: () => fakeOtaStatus,
      getStatusAsync: async () => fakeOtaStatus,
      applyUpdate: async (req) => ({
        ok: true,
        queuedForIdle: true,
        activeRunCount: 1,
        targetBuild: req.coreBuild,
        deferredSwitch: { buildId: req.coreBuild },
        status: fakeOtaStatus,
      }),
      rollbackAsync: async (req) => ({
        ok: true,
        queuedForIdle: true,
        activeRunCount: 1,
        mode: req?.mode || "previous",
        status: fakeOtaStatus,
      }),
      confirmReady: () => fakeOtaStatus,
      rollback: () => fakeOtaStatus,
    },
    fetchImpl: makeManifestFetch({
      schemaVersion: 1,
      generatedAt: "2026-11-26T00:00:00.000Z",
      releaseTag: "ota-20261126",
      releaseUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/tag/ota-20261126`,
      releaseNotes: "Hotfix release",
      webBuild: "20261126.100000-bbb",
      coreBuild: "20261126.100000-bbb",
      shells: {
        desktop: {
          latestVersion: "1.0.5",
          minVersionForOta: "1.0.0",
          minVersionForCoreOta: "1.0.4",
        },
      },
      backend: {
        latestVersion: "1.0.5",
        minCompatibleVersion: "1.0.0",
        apiCapabilities: [...CURRENT_API_CAPABILITIES],
      },
      bundles: {
        mobile: {
          target: "mobile",
          webBuild: "20261126.100000-bbb",
          bundleUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/ota-20261126/twinklebot-web-mobile.tar.gz`,
          sha256: "b".repeat(64),
          sizeBytes: 1024,
        },
        desktopCore: {
          target: "desktop",
          coreBuild: "20261126.100000-bbb",
          coreVersion: "1.0.5",
          webBuild: "20261126.100000-bbb",
          minShellVersion: "1.0.4",
          bundleUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/ota-20261126/twinklebot-core-desktop.tar.gz`,
          sha256: "c".repeat(64),
          sizeBytes: 2048,
        },
      },
    }),
  });

  const st = await otaActions.status();
  assert.equal(st.ok, true);
  assert.equal(st.supportsCoreOta, true);
  assert.equal(st.supportsSelfUpdate, true);
  assert.equal(st.coreBuild, "20261101.010000-aaa");

  const chk = await otaActions.check({ force: true });
  assert.equal(chk.ok, true);
  assert.equal(chk.status, "ota-available");
  assert.equal(chk.canApplyOta, true);

  const appRes = await otaActions.apply();
  assert.equal(appRes.ok, true);
  assert.equal(appRes.status, "deferred");
  assert.equal(appRes.queuedForIdle, true);

  const rbRes = await otaActions.rollback({ mode: "builtin", reason: "test rollback" });
  assert.equal(rbRes.ok, true);
  assert.equal(rbRes.status, "deferred");
  assert.equal(rbRes.mode, "builtin");

  // 2. up-to-date
  clearGithubManifestCacheForTest();
  const upToDateActions = createSelfUpdateActions({
    projectRoot,
    publicDir,
    appVersion: "1.0.5",
    otaController: {
      getStatus: () => fakeOtaStatus,
      getStatusAsync: async () => fakeOtaStatus,
      applyUpdate: async () => ({ ok: true }),
      confirmReady: () => fakeOtaStatus,
      rollback: () => fakeOtaStatus,
    },
    fetchImpl: makeManifestFetch({
      schemaVersion: 1,
      generatedAt: "2026-11-26T00:00:00.000Z",
      releaseTag: "ota-20261101",
      releaseUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/tag/ota-20261101`,
      webBuild: "20261101.010000-aaa",
      coreBuild: "20261101.010000-aaa",
      shells: {
        desktop: {
          latestVersion: "1.0.5",
          minVersionForOta: "1.0.0",
          minVersionForCoreOta: "1.0.4",
        },
      },
      bundles: {
        desktopCore: {
          target: "desktop",
          coreBuild: "20261101.010000-aaa",
          coreVersion: "1.0.5",
          webBuild: "20261101.010000-aaa",
          minShellVersion: "1.0.4",
          bundleUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/ota-20261101/twinklebot-core-desktop.tar.gz`,
          sha256: "a".repeat(64),
          sizeBytes: 2048,
        },
      },
    }),
  });
  const applyUpToDate = await upToDateActions.apply();
  assert.equal(applyUpToDate.ok, true);
  assert.equal(applyUpToDate.status, "up-to-date");
  assert.equal(applyUpToDate.alreadyUpToDate, true);

  // 3. shell-update-required refuses apply cleanly
  clearGithubManifestCacheForTest();
  const shellRequiredActions = createSelfUpdateActions({
    projectRoot,
    publicDir,
    appVersion: "1.0.5",
    otaController: {
      getStatus: () => fakeOtaStatus,
      getStatusAsync: async () => fakeOtaStatus,
      applyUpdate: async () => ({ ok: true }),
      confirmReady: () => fakeOtaStatus,
      rollback: () => fakeOtaStatus,
    },
    fetchImpl: makeManifestFetch({
      schemaVersion: 1,
      generatedAt: "2026-11-26T00:00:00.000Z",
      releaseTag: "v1.1.0",
      releaseUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/tag/v1.1.0`,
      webBuild: "20261126.120000-ddd",
      coreBuild: "20261126.120000-ddd",
      shells: {
        desktop: {
          latestVersion: "1.1.0",
          minVersionForOta: "1.1.0",
          minVersionForCoreOta: "1.1.0",
          assets: {
            "darwin-arm64": {
              fileName: "TwinkleBot-1.1.0-arm64.dmg",
              downloadUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/v1.1.0/TwinkleBot-1.1.0-arm64.dmg`,
            },
            "darwin-x64": {
              fileName: "TwinkleBot-1.1.0-x64.dmg",
              downloadUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/v1.1.0/TwinkleBot-1.1.0-x64.dmg`,
            },
            "win32-x64": {
              fileName: "TwinkleBot-1.1.0-x64.exe",
              downloadUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/v1.1.0/TwinkleBot-1.1.0-x64.exe`,
            },
            "linux-x64": {
              fileName: "TwinkleBot-1.1.0-x86_64.AppImage",
              downloadUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/v1.1.0/TwinkleBot-1.1.0-x86_64.AppImage`,
            },
          },
        },
      },
    }),
  });
  const applyBlocked = await shellRequiredActions.apply();
  assert.equal(applyBlocked.ok, false);
  assert.equal(applyBlocked.status, "shell-update-required");
  assert.equal(applyBlocked.releaseTag, "v1.1.0");

  // 4. Non-desktop runtime returns unsupported on apply/rollback
  clearGithubManifestCacheForTest();
  const nonDesktopActions = createSelfUpdateActions({
    projectRoot,
    publicDir,
    appVersion: "1.0.5",
    otaController: null,
    fetchImpl: makeManifestFetch({
      schemaVersion: 1,
      generatedAt: "2026-11-26T00:00:00.000Z",
      releaseTag: "ota-20261126",
      releaseUrl: `https://github.com/${DEFAULT_GITHUB_REPO}/releases/tag/ota-20261126`,
      webBuild: "20261126.100000-bbb",
      shells: {
        desktop: {
          latestVersion: "1.0.5",
          minVersionForOta: "1.0.0",
        },
      },
    }),
  });
  const nonDesktopApply = await nonDesktopActions.apply();
  assert.equal(nonDesktopApply.ok, false);
  assert.equal(nonDesktopApply.unsupported, true);
  const nonDesktopRollback = await nonDesktopActions.rollback();
  assert.equal(nonDesktopRollback.ok, false);
  assert.equal(nonDesktopRollback.unsupported, true);
});

test("runBotCollabTool('self_update') gates apply/rollback to admin Bots while keeping status/check accessible", async () => {
  const calls: string[] = [];
  const mockStore = {
    getSession: (id: string) => ({ id, isAdmin: id === "admin-1" }),
  };
  const mockSelfUpdateActions = {
    status: async () => {
      calls.push("status");
      return { ok: true, action: "status", coreBuild: "20261126-test" };
    },
    check: async () => {
      calls.push("check");
      return { ok: true, action: "check", status: "up-to-date" };
    },
    apply: async ({ force = false }: { force?: boolean } = {}) => {
      calls.push(`apply:${force}`);
      return { ok: true, action: "apply", status: "deferred" };
    },
    rollback: async ({ mode = "previous", reason = "" }: { mode?: "previous" | "builtin"; reason?: string } = {}) => {
      calls.push(`rollback:${mode}:${reason}`);
      return { ok: true, action: "rollback", status: "deferred", mode };
    },
  };

  const workerCtx: any = {
    store: mockStore,
    senderBot: { id: "worker-1", isAdmin: false },
    senderSessionId: "worker-1",
    selfUpdateActions: mockSelfUpdateActions,
  };
  const adminCtx: any = {
    store: mockStore,
    senderBot: { id: "admin-1", isAdmin: true },
    senderSessionId: "admin-1",
    selfUpdateActions: mockSelfUpdateActions,
  };

  const wStatus = await runBotCollabTool("self_update", { action: "status" }, workerCtx);
  assert.equal(wStatus.ok, true);
  const wCheck = await runBotCollabTool("self_update", { action: "check" }, workerCtx);
  assert.equal(wCheck.ok, true);

  const wApplyDenied = await runBotCollabTool("self_update", { action: "apply" }, workerCtx);
  assert.equal(wApplyDenied.ok, false);
  assert.match(wApplyDenied.error, /管理员/);

  const wRbDenied = await runBotCollabTool("self_update", { action: "rollback" }, workerCtx);
  assert.equal(wRbDenied.ok, false);
  assert.match(wRbDenied.error, /管理员/);

  const aApply = await runBotCollabTool("self_update", { action: "apply", force: true }, adminCtx);
  assert.equal(aApply.ok, true);
  assert.equal(aApply.status, "deferred");

  const aRb = await runBotCollabTool(
    "self_update",
    { action: "rollback", rollback_mode: "builtin", reason: "恢复内置版本" },
    adminCtx
  );
  assert.equal(aRb.ok, true);
  assert.equal(aRb.mode, "builtin");
  assert.deepEqual(calls, ["status", "check", "apply:true", "rollback:builtin:恢复内置版本"]);
});
