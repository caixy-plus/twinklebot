import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDotEnv, resolveDesktopConfig } from "../src/electron/env-loader.js";
import {
  clearDesktopRuntime,
  computeTrayPopoverPosition,
  isRectVisibleOnDisplays,
  loadDesktopPrefs,
  readDesktopRuntime,
  readSavedLocalControlToken,
  saveDesktopPrefs,
  writeDesktopRuntime,
} from "../src/electron/desktop-prefs.js";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";

test("parseDotEnv parses comments, quotes, and export prefixes safely", () => {
  const raw = `
    # comment line
    GEMINI_API_KEY="test-key-123"
    export TWINKLEBOT_EXECUTOR_TOKEN='tok-456'
    TWINKLEBOT_NOVNC_URL=http://127.0.0.1:6080/vnc.html
  `;
  const parsed = parseDotEnv(raw);
  assert.deepEqual(parsed, {
    GEMINI_API_KEY: "test-key-123",
    TWINKLEBOT_EXECUTOR_TOKEN: "tok-456",
    TWINKLEBOT_NOVNC_URL: "http://127.0.0.1:6080/vnc.html",
  });
});

test("resolveDesktopConfig discovers .env, supports cross-platform homeDir, and does not throw when unconfigured", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "electron-cfg-"));
  try {
    const fakeHome = path.join(tmp, "home");
    const userData = path.join(tmp, "userData");
    const appRoot = path.join(tmp, "app");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(appRoot, { recursive: true });

    // 1. Unconfigured fresh machine boots safely with isConfigured=false
    const unconf = resolveDesktopConfig({
      env: {},
      appRoot,
      userDataDir: userData,
      homeDir: fakeHome,
      isPackaged: true,
    });
    assert.equal(unconf.isConfigured, false);
    assert.equal(unconf.deployEnv, "local");
    assert.equal(unconf.port, 3230);
    assert.ok(unconf.localControlToken && unconf.localControlToken.length >= 16);
    assert.deepEqual(unconf.writeRoots, [
      path.join(fakeHome, "TwinkleBot", "workspace"),
      path.join(fakeHome, "Downloads"),
    ]);

    // 2. Configured via userData/.env
    fs.writeFileSync(
      path.join(userData, ".env"),
      "GEMINI_API_KEY=k1\nTWINKLEBOT_EXECUTOR_TOKEN=t1\n",
      "utf-8"
    );
    const conf = resolveDesktopConfig({
      env: {},
      appRoot,
      userDataDir: userData,
      homeDir: fakeHome,
      isPackaged: true,
    });
    assert.equal(conf.isConfigured, true);
    assert.equal(conf.geminiApiKey, "k1");
    assert.equal(conf.executorToken, "t1");
    assert.equal(conf.dataDir, path.join(userData, "data"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("desktop-prefs defaults to background alive and persists toggles safely", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-prefs-"));
  try {
    assert.equal(loadDesktopPrefs(tmp).keepRunningInBackground, true);
    const saved = saveDesktopPrefs(tmp, { keepRunningInBackground: false });
    assert.equal(saved.keepRunningInBackground, false);
    assert.equal(loadDesktopPrefs(tmp).keepRunningInBackground, false);

    // Corrupted JSON falls back cleanly to default true
    fs.writeFileSync(path.join(tmp, "desktop-prefs.json"), "{not valid json", "utf-8");
    assert.equal(loadDesktopPrefs(tmp).keepRunningInBackground, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("computeTrayPopoverPosition anchors cleanly within workArea across platforms", () => {
  // macOS top menu bar near right edge
  const macPos = computeTrayPopoverPosition(
    { x: 1410, y: 0, width: 28, height: 24 },
    { x: 0, y: 25, width: 1440, height: 875 },
    { width: 324, height: 414 },
    "darwin"
  );
  assert.equal(macPos.x, 1440 - 324 - 6);
  assert.equal(macPos.y, 31);

  // Windows bottom taskbar near right edge
  const winPos = computeTrayPopoverPosition(
    { x: 1700, y: 1036, width: 32, height: 40 },
    { x: 0, y: 0, width: 1920, height: 1032 },
    { width: 324, height: 414 },
    "win32"
  );
  assert.equal(winPos.x, 1700 + 16 - 162);
  assert.equal(winPos.y, 1036 - 414 - 6);
});

function readPngHeader(absPath: string) {
  const buf = fs.readFileSync(absPath);
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.length > 26 && buf.subarray(0, 8).equals(pngSig), `invalid PNG header: ${absPath}`);
  assert.equal(buf.subarray(12, 16).toString("ascii"), "IHDR", `missing IHDR: ${absPath}`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf.readUInt8(24),
    colorType: buf.readUInt8(25), // 2 = RGB, 6 = RGBA
  };
}

test("multi-platform application icons, status-bar template icons, iOS RGB icon, and Android mipmaps are synchronized", () => {
  const root = process.cwd();

  // Desktop & Web PNGs
  assert.deepEqual(readPngHeader(path.join(root, "build", "icon.png")), {
    width: 1024,
    height: 1024,
    bitDepth: 8,
    colorType: 6,
  });
  for (const rel of ["public/icon.png", "landing/icon.png"]) {
    assert.deepEqual(readPngHeader(path.join(root, rel)), {
      width: 256,
      height: 256,
      bitDepth: 8,
      colorType: 6,
    });
  }

  // macOS .icns & Windows .ico headers
  const icnsBuf = fs.readFileSync(path.join(root, "build", "icon.icns"));
  assert.equal(icnsBuf.subarray(0, 4).toString("ascii"), "icns");
  assert.ok(icnsBuf.length > 10_000);

  const icoBuf = fs.readFileSync(path.join(root, "build", "icon.ico"));
  assert.equal(icoBuf.readUInt16LE(0), 0);
  assert.equal(icoBuf.readUInt16LE(2), 1); // ICO type = 1
  assert.ok(icoBuf.readUInt16LE(4) >= 5); // multi-frame ICO

  // Status-bar / menu-bar icons (20pt / 40px@2x macOS Template + cross-platform color)
  for (const [file, dim] of [
    ["trayIconTemplate.png", 20],
    ["trayIconTemplate@2x.png", 40],
    ["trayIcon.png", 20],
    ["trayIcon@2x.png", 40],
  ] as const) {
    assert.deepEqual(readPngHeader(path.join(root, "build", file)), {
      width: dim,
      height: dim,
      bitDepth: 8,
      colorType: 6,
    });
  }

  // Verify Electron tray loads macOS Template image and sets setTemplateImage(true)
  const traySrc = fs.readFileSync(path.join(root, "src", "electron", "tray.ts"), "utf-8");
  assert.ok(traySrc.includes("trayIconTemplate.png"));
  assert.ok(traySrc.includes("setTemplateImage(true)"));

  // Verify Web index.html links /icon.png
  const indexHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf-8");
  assert.ok(indexHtml.includes('href="/icon.png"'));

  // iOS AppIcon must be 1024x1024 opaque RGB (colorType === 2, no alpha channel)
  assert.deepEqual(
    readPngHeader(
      path.join(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
    ),
    { width: 1024, height: 1024, bitDepth: 8, colorType: 2 }
  );

  // Android mipmap densities
  const densities: Array<[string, number, number]> = [
    ["mipmap-mdpi", 48, 108],
    ["mipmap-hdpi", 72, 162],
    ["mipmap-xhdpi", 96, 216],
    ["mipmap-xxhdpi", 144, 324],
    ["mipmap-xxxhdpi", 192, 432],
  ];
  for (const [folder, legacyPx, fgPx] of densities) {
    const dir = path.join(root, "android/app/src/main/res", folder);
    assert.deepEqual(readPngHeader(path.join(dir, "ic_launcher.png")), {
      width: legacyPx,
      height: legacyPx,
      bitDepth: 8,
      colorType: 6,
    });
    assert.deepEqual(readPngHeader(path.join(dir, "ic_launcher_round.png")), {
      width: legacyPx,
      height: legacyPx,
      bitDepth: 8,
      colorType: 6,
    });
    assert.deepEqual(readPngHeader(path.join(dir, "ic_launcher_foreground.png")), {
      width: fgPx,
      height: fgPx,
      bitDepth: 8,
      colorType: 6,
    });
  }
});

test("desktop-runtime telemetry, saved local token lookup, and display visibility bounds checks work cleanly", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-runtime-"));
  try {
    assert.equal(readDesktopRuntime(tmp), null);
    assert.equal(readSavedLocalControlToken(tmp), "");

    const written = writeDesktopRuntime(tmp, {
      pid: 4242,
      port: 3230,
      backendUrl: "http://127.0.0.1:3230",
      startedAt: 1000,
      lastSecondInstanceAt: 2000,
    });
    assert.equal(written.pid, 4242);
    assert.deepEqual(readDesktopRuntime(tmp), written);

    fs.writeFileSync(
      path.join(tmp, "desktop-config.json"),
      JSON.stringify({ TWINKLEBOT_LOCAL_TOKEN: "tok-local-xyz" }),
      "utf-8"
    );
    assert.equal(readSavedLocalControlToken(tmp), "tok-local-xyz");

    clearDesktopRuntime(tmp);
    assert.equal(readDesktopRuntime(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const primary = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.equal(
    isRectVisibleOnDisplays({ x: 100, y: 100, width: 1200, height: 800 }, primary),
    true
  );
  // Off-screen coordinates from a disconnected secondary monitor on the right
  assert.equal(
    isRectVisibleOnDisplays({ x: 2200, y: 120, width: 1200, height: 800 }, primary),
    false
  );
  // Barely peeking by 10px (< 60px threshold) counts as off-screen so win.center() recovers it
  assert.equal(
    isRectVisibleOnDisplays({ x: 1910, y: 120, width: 1200, height: 800 }, primary),
    false
  );
  // No display metadata falls back safely to visible
  assert.equal(isRectVisibleOnDisplays({ x: 0, y: 0, width: 800, height: 600 }, []), true);
});

test("loopback /api/desktop/wake and /api/desktop/quit require valid localControlToken and invoke desktopController", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-wake-srv-"));
  let wakeCount = 0;
  let quitCount = 0;
  const store = createStore(tmp);
  const server = createServer({
    config: {
      deployEnv: "local",
      host: "127.0.0.1",
      port: 0,
      localControlToken: "secret-desktop-wake-tok",
    },
    store,
    desktopController: {
      wakeWindow: async () => {
        wakeCount += 1;
        return { pid: process.pid, windowVisible: true };
      },
      quitApp: () => {
        quitCount += 1;
      },
    },
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Unauthorized without token
    const unauth = await fetch(`${baseUrl}/api/desktop/wake`, { method: "POST" });
    assert.equal(unauth.status, 401);
    assert.equal(wakeCount, 0);

    // Wrong token
    const badTok = await fetch(`${baseUrl}/api/desktop/wake`, {
      method: "POST",
      headers: { "x-local-token": "wrong-token" },
    });
    assert.equal(badTok.status, 401);

    // Valid token wakes window
    const okWake = await fetch(`${baseUrl}/api/desktop/wake`, {
      method: "POST",
      headers: { "x-local-token": "secret-desktop-wake-tok" },
    });
    assert.equal(okWake.status, 200);
    const wakeBody = (await okWake.json()) as any;
    assert.equal(wakeBody.ok, true);
    assert.equal(wakeBody.windowVisible, true);
    assert.equal(wakeCount, 1);

    // Valid token triggers quit via setImmediate
    const okQuit = await fetch(`${baseUrl}/api/desktop/quit`, {
      method: "POST",
      headers: { "x-local-token": "secret-desktop-wake-tok" },
    });
    assert.equal(okQuit.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(quitCount, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
