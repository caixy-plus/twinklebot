#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function runStep(cmd, args, opts = {}) {
  const pretty = `${cmd} ${args.join(" ")}`;
  console.log(`\n[e2e] >>> ${pretty}`);
  const res = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${pretty}`);
  }
}

function hasOrbUbuntu() {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("orb", ["list"], { encoding: "utf8" });
  return r.status === 0 && /\bubuntu\b/i.test(r.stdout || "");
}

function main() {
  // 1. Real official Google Chrome + X11 multi-tab shared-profile E2E
  if (process.platform === "linux") {
    runStep(
      "python3",
      ["-m", "unittest", "discover", "-s", "executor", "-p", "test_e2e_*.py", "-v"],
      { env: { TWINKLEBOT_RUN_CHROME_E2E: "1" } }
    );
  } else if (hasOrbUbuntu()) {
    runStep("orb", [
      "-m",
      "ubuntu",
      "env",
      "TWINKLEBOT_RUN_CHROME_E2E=1",
      "python3",
      "-m",
      "unittest",
      "discover",
      "-s",
      "executor",
      "-p",
      "test_e2e_*.py",
      "-v",
    ]);
  } else {
    throw new Error(
      "Real Linux X11 + Google Chrome E2E requires Linux Xvfb/Xtigervnc or macOS OrbStack 'ubuntu' VM."
    );
  }

  // 2. Real Headless Google Chrome Web UI E2E against built TwinkleBot server & public/dist
  const compiledUiTest = path.join(PROJECT_ROOT, "dist-server", "test", "web-ui-e2e.test.js");
  if (!fs.existsSync(compiledUiTest)) {
    throw new Error(`Missing compiled UI E2E test: ${compiledUiTest} (run npm run build:ts first)`);
  }
  runStep(process.execPath, ["--test", compiledUiTest], {
    env: { TWINKLEBOT_REQUIRE_CHROME_E2E: "1" },
  });

  console.log("\n[e2e] All real Chrome multi-tab & Web UI E2E suites passed.");
}

main();
