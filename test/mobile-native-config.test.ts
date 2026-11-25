import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _UP_ONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.basename(_UP_ONE) === "dist-server" ? path.dirname(_UP_ONE) : _UP_ONE;

test("Android manifest and network security config allow LAN cleartext & multicast discovery", () => {
  const manifest = fs.readFileSync(
    path.join(ROOT, "android/app/src/main/AndroidManifest.xml"),
    "utf8"
  );
  for (const perm of [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.ACCESS_WIFI_STATE",
    "android.permission.CHANGE_WIFI_MULTICAST_STATE",
    "android.permission.CAMERA",
  ]) {
    assert.ok(manifest.includes(perm), `missing ${perm}`);
  }
  assert.ok(manifest.includes('android:usesCleartextTraffic="true"'));
  assert.ok(manifest.includes('android:screenOrientation="portrait"'));
  assert.ok(manifest.includes("network_security_config"));

  const netSec = fs.readFileSync(
    path.join(ROOT, "android/app/src/main/res/xml/network_security_config.xml"),
    "utf8"
  );
  assert.ok(netSec.includes('cleartextTrafficPermitted="true"'));

  const pluginJava = fs.readFileSync(
    path.join(ROOT, "android/app/src/main/java/com/twinklebot/mobile/LanDiscoveryPlugin.java"),
    "utf8"
  );
  assert.ok(pluginJava.includes('@CapacitorPlugin(name = "LanDiscovery")'));
  assert.ok(pluginJava.includes("TWINKLEBOT_DISCOVER_V1"));
  assert.ok(pluginJava.includes("setScreenOrientation"));

  const gradle = fs.readFileSync(
    path.join(ROOT, "android/app/build.gradle"),
    "utf8"
  );
  assert.ok(gradle.includes("zxing-android-embedded"));

  const qrPluginJava = fs.readFileSync(
    path.join(ROOT, "android/app/src/main/java/com/twinklebot/mobile/QrScannerPlugin.java"),
    "utf8"
  );
  assert.ok(qrPluginJava.includes('@CapacitorPlugin'));
  assert.ok(qrPluginJava.includes('name = "QrScanner"'));
  assert.ok(qrPluginJava.includes("ScanOptions"));

  const mainActivityJava = fs.readFileSync(
    path.join(ROOT, "android/app/src/main/java/com/twinklebot/mobile/MainActivity.java"),
    "utf8"
  );
  assert.ok(mainActivityJava.includes("registerPlugin(QrScannerPlugin.class)"));
});

test("iOS Info.plist configures Local Network, Bonjour, ATS, and native plugins", () => {
  const plist = fs.readFileSync(path.join(ROOT, "ios/App/App/Info.plist"), "utf8");
  assert.ok(plist.includes("NSLocalNetworkUsageDescription"));
  assert.ok(plist.includes("NSCameraUsageDescription"));
  assert.ok(plist.includes("_twinklebot._tcp"));
  assert.ok(plist.includes("NSAllowsLocalNetworking"));

  const swiftPath = fs.existsSync(path.join(ROOT, "ios/App/App/LanDiscoveryPlugin.swift"))
    ? path.join(ROOT, "ios/App/App/LanDiscoveryPlugin.swift")
    : path.join(ROOT, "ios/App/App/SceneDelegate.swift");
  const swift = fs.readFileSync(swiftPath, "utf8");
  assert.ok(swift.includes("LanDiscoveryPlugin"));

  const sceneSwift = fs.readFileSync(
    path.join(ROOT, "ios/App/App/SceneDelegate.swift"),
    "utf8"
  );
  assert.ok(sceneSwift.includes("QrScannerPlugin"));
  assert.ok(sceneSwift.includes("AVCaptureSession"));
  assert.ok(sceneSwift.includes("QrScannerPlugin()"));
});
