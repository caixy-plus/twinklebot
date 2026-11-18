import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/lib/config.js";

const _UP_ONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.basename(_UP_ONE) === "dist-server" ? path.dirname(_UP_ONE) : _UP_ONE;

test("loadConfig requires keys", () => {
  assert.throws(() => loadConfig({}), /GEMINI_API_KEY is not set/);
  assert.throws(() => loadConfig({ GEMINI_API_KEY: "k" }), /TWINKLEBOT_EXECUTOR_TOKEN is not set/);
});

test("loadConfig defaults", () => {
  const c = loadConfig({ GEMINI_API_KEY: "k", TWINKLEBOT_EXECUTOR_TOKEN: "t" });
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 3230);
  assert.equal(c.geminiApiKey, "k");
  const expectedLocalHost =
    process.platform === "win32" ? "127.0.0.1" : "ubuntu.orb.local";
  assert.equal(c.executorUrl, `http://${expectedLocalHost}:7300`);
  assert.equal(c.executorToken, "t");
  assert.equal(
    c.novncUrl,
    `http://${expectedLocalHost}:6080/vnc.html?autoconnect=true&resize=scale`
  );
  assert.equal(c.defaultModel, "gemini-4-argon");
  assert.equal(c.deepModel, "gemini-4-carbon");
  assert.equal(c.fastModel, "gemini-4-hydrogen");
  assert.deepEqual(c.models, ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"]);
  assert.equal(c.maxSteps, 60);
  assert.equal(c.keepScreenshots, 3);
  assert.equal(c.shellTimeoutSec, 120);
  assert.deepEqual(c.screen, { width: 1440, height: 900 });
  assert.deepEqual(c.writeRoots, [
    path.join(os.homedir(), "TwinkleBot", "workspace"),
    path.join(os.homedir(), "Downloads"),
  ]);
  assert.equal(c.dataDir, path.join(PROJECT_ROOT, "data"));
  assert.equal(c.deployEnv, "local");
  assert.equal(c.initialRole, "master");
});

test("loadConfig supports DEPLOY_ENV=cloud and unconfigured onboarding mode", () => {
  const cloud = loadConfig({
    DEPLOY_ENV: "cloud",
    TWINKLEBOT_CLOUD_TOKEN: "cloud-secret",
    TWINKLEBOT_EXECUTOR_TOKEN: "exec-tok",
  });
  assert.equal(cloud.deployEnv, "cloud");
  assert.equal(cloud.host, "0.0.0.0");
  assert.equal(cloud.geminiApiKey, "");
  assert.equal(cloud.cloudAuthToken, "cloud-secret");

  const onboardingLocal = loadConfig({
    TWINKLEBOT_ALLOW_UNCONFIGURED: "1",
    TWINKLEBOT_EXECUTOR_TOKEN: "exec-tok",
  });
  assert.equal(onboardingLocal.deployEnv, "local");
  assert.equal(onboardingLocal.host, "127.0.0.1");
  assert.equal(onboardingLocal.geminiApiKey, "");
});

test("loadConfig overrides via env", () => {
  const c = loadConfig({
    GEMINI_API_KEY: "my-gemini-key",
    TWINKLEBOT_EXECUTOR_TOKEN: "my-token",
    PORT: "4000",
    TWINKLEBOT_EXECUTOR_URL: "http://custom-host:8000",
    TWINKLEBOT_NOVNC_URL: "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale",
    TWINKLEBOT_DATA_DIR: "/tmp/custom-data",
  });
  assert.equal(c.port, 4000);
  assert.equal(c.executorUrl, "http://custom-host:8000");
  assert.equal(c.novncUrl, "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale");
  assert.equal(c.dataDir, "/tmp/custom-data");
});
