#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function parseTier() {
  const arg = process.argv.find((a) => a.startsWith("--tier="));
  if (arg) return arg.slice("--tier=".length).trim().toLowerCase();
  return "chrome";
}

function hasOrbUbuntu() {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("orb", ["list"], { encoding: "utf8" });
  return r.status === 0 && /\bubuntu\b/i.test(r.stdout || "");
}

function runStep(cmd, args, opts = {}) {
  const pretty = `${cmd} ${args.join(" ")}`;
  console.log(`\n[e2e] >>> ${pretty}`);
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    timeout: opts.timeoutMs ?? 180_000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  const durationMs = Date.now() - started;
  if (res.error) {
    return { ok: false, status: -1, durationMs, cmd: pretty, error: res.error.message };
  }
  return { ok: res.status === 0, status: res.status ?? 1, durationMs, cmd: pretty };
}

function runPythonE2EFile(filename) {
  if (process.platform === "linux") {
    return runStep("python3", ["-m", "unittest", "discover", "-s", "executor", "-p", filename, "-v"], {
      env: { TWINKLEBOT_RUN_CHROME_E2E: "1" },
    });
  }
  if (hasOrbUbuntu()) {
    return runStep("orb", [
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
      filename,
      "-v",
    ]);
  }
  console.warn(`[e2e] Skipping ${filename}: requires Linux Xvfb/Xtigervnc or macOS OrbStack 'ubuntu'`);
  return { ok: true, status: 0, durationMs: 0, cmd: filename, skipped: true };
}

function runNodeE2EFiles(relFiles, extraEnv = {}) {
  const fullPaths = relFiles.map((f) => path.join(PROJECT_ROOT, "dist-server", "test", f));
  for (const fp of fullPaths) {
    if (!fs.existsSync(fp)) {
      throw new Error(`Missing compiled E2E file: ${fp} (run npm run build:ts first)`);
    }
  }
  return runStep(process.execPath, ["--test", "--test-force-exit", ...fullPaths], {
    env: extraEnv,
    timeoutMs: 180_000,
  });
}

function ensureMobileBundle() {
  const mobileIdx = path.join(PROJECT_ROOT, "dist-web", "index.html");
  if (!fs.existsSync(mobileIdx)) {
    console.log("[e2e] Building mobile web bundle (dist-web/)...");
    const r = runStep(process.execPath, [path.join(PROJECT_ROOT, "scripts", "build-web.mjs")], {
      env: { APP_TARGET: "mobile" },
    });
    if (!r.ok) throw new Error("Failed to build mobile dist-web/ bundle");
  }
}

function aggregateReport(tier = "aggregated") {
  const casesDir = path.join(PROJECT_ROOT, "test-results", "cases");
  if (!fs.existsSync(casesDir)) return null;
  const files = fs.readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  const allRecords = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(casesDir, f), "utf8"));
      if (Array.isArray(parsed.records)) allRecords.push(...parsed.records);
    } catch {}
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    total: allRecords.length,
    byStatus: {
      PASS: allRecords.filter((r) => r.status === "PASS").length,
      BUG: allRecords.filter((r) => r.status === "BUG").length,
      UX_DESIGN: allRecords.filter((r) => r.status === "UX_DESIGN").length,
      ENV_SKIP: allRecords.filter((r) => r.status === "ENV_SKIP").length,
    },
    byPriority: {},
    records: allRecords,
  };
  for (const p of ["P0", "P1", "P2", "P3"]) {
    const sub = allRecords.filter((r) => r.priority === p);
    summary.byPriority[p] = {
      total: sub.length,
      PASS: sub.filter((r) => r.status === "PASS").length,
      BUG: sub.filter((r) => r.status === "BUG").length,
      UX_DESIGN: sub.filter((r) => r.status === "UX_DESIGN").length,
      ENV_SKIP: sub.filter((r) => r.status === "ENV_SKIP").length,
    };
  }
  fs.writeFileSync(
    path.join(PROJECT_ROOT, "test-results", "e2e-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );
  console.log("\n[e2e] === Aggregated E2E Summary ===");
  console.log(JSON.stringify(summary.byStatus));
  console.log(JSON.stringify(summary.byPriority));

  // Automatically render Markdown report to test-results/reports/latest.md (and archive if --archive passed)
  const reportScript = path.join(
    PROJECT_ROOT,
    ".agents",
    "skills",
    "twinklebot-e2e",
    "scripts",
    "generate-report.mjs"
  );
  if (fs.existsSync(reportScript) && allRecords.length > 0) {
    const repArgs = [reportScript, `--tier=${tier}`];
    if (process.argv.includes("--archive")) repArgs.push("--archive");
    const archiveEq = process.argv.find((a) => a.startsWith("--archive="));
    if (archiveEq) repArgs.push(archiveEq);
    spawnSync(process.execPath, repArgs, { cwd: PROJECT_ROOT, stdio: "inherit" });
  }
  return summary;
}

function resolveAffectedSuites() {
  const syncScript = path.join(
    PROJECT_ROOT,
    ".agents",
    "skills",
    "twinklebot-e2e",
    "scripts",
    "check-e2e-sync.mjs"
  );
  const args = [syncScript, "--json"];
  if (process.argv.includes("--staged")) args.push("--staged");
  if (process.argv.includes("--since-last-tag")) args.push("--since-last-tag");
  const baseArg = process.argv.find((a) => a.startsWith("--base="));
  if (baseArg) args.push(baseArg);
  const res = spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`Failed to resolve affected E2E suites: ${res.stderr || res.stdout}`);
  }
  const parsed = JSON.parse(res.stdout || "{}");
  return Array.isArray(parsed.affectedSuites) ? parsed.affectedSuites : [];
}

const P0_CORE_FILES = [
  "e2e/p0-onboarding-and-chat.e2e.js",
  "e2e/p0-security-multibot-and-pairing.e2e.js",
];

function main() {
  const tier = parseTier();
  if (tier === "skip" || tier === "none") {
    console.log(`[e2e] E2E tier set to '${tier}'; skipping automated E2E run.`);
    return;
  }

  const continueOnError = process.argv.includes("--continue-on-error") || tier === "all";
  const stepResults = [];

  const exec = (fn) => {
    const r = fn();
    stepResults.push(r);
    if (!r.ok && !continueOnError) {
      aggregateReport(tier);
      throw new Error(`E2E step failed (${r.status}): ${r.cmd}`);
    }
  };

  if (tier === "chrome") {
    // Original backward-compatible Chrome multi-tab + Web UI E2E
    exec(() => runPythonE2EFile("test_e2e_chrome.py"));
    exec(() => runNodeE2EFiles(["web-ui-e2e.test.js"], { TWINKLEBOT_REQUIRE_CHROME_E2E: "1" }));
  } else if (tier === "affected" || tier === "affected+p0" || tier === "release") {
    const includeP0Core = tier === "affected+p0" || tier === "release";
    const affected = resolveAffectedSuites();
    const pyPatterns = Array.from(
      new Set(affected.filter((s) => s.runtime === "python" && s.pythonPattern).map((s) => s.pythonPattern))
    );
    const nodeSet = new Set(includeP0Core ? P0_CORE_FILES : []);
    for (const s of affected) {
      if (s.runtime === "node" && s.compiledFile) nodeSet.add(s.compiledFile);
    }
    const nodeFiles = Array.from(nodeSet);

    if (pyPatterns.length === 0 && nodeFiles.length === 0) {
      console.log("[e2e] No E2E suites impacted by current git changes. Nothing to run.");
      return;
    }
    console.log(
      `[e2e] Running tier '${tier}': ${nodeFiles.length} Node suite(s) + ${pyPatterns.length} Python suite(s)` +
        (includeP0Core ? " (includes P0 core baseline)" : "")
    );
    for (const s of affected) {
      console.log(`  - [affected ${s.tier}] ${s.file} (matched: ${(s.matchedBy || []).join(", ")})`);
    }
    if (affected.some((s) => s.requiresMobileBundle)) {
      ensureMobileBundle();
    }
    for (const pat of pyPatterns) {
      exec(() => runPythonE2EFile(pat));
    }
    if (nodeFiles.length > 0) {
      exec(() => runNodeE2EFiles(nodeFiles));
    }
  } else {
    const runP0 = tier === "p0" || tier === "p0+p1" || tier === "all";
    const runP1 = tier === "p1" || tier === "p0+p1" || tier === "all";
    const runP2 = tier === "p2" || tier === "all";
    const runP3 = tier === "p3" || tier === "all";
    const runLive = tier === "live";

    if (runP0) {
      exec(() =>
        runNodeE2EFiles([
          "e2e/p0-onboarding-and-chat.e2e.js",
          "e2e/p0-security-multibot-and-pairing.e2e.js",
        ])
      );
    }
    if (runP1) {
      ensureMobileBundle();
      exec(() =>
        runNodeE2EFiles([
          "e2e/p1-sandbox-electron-and-bridge.e2e.js",
          "e2e/p1-collab-cards-and-messages.e2e.js",
          "e2e/p1-skills-mail-and-mcp.e2e.js",
          "e2e/p1-routing-billing-and-mobile.e2e.js",
        ])
      );
    }
    if (runP2) {
      exec(() =>
        runNodeE2EFiles([
          "e2e/p2-settings-vault-and-permissions.e2e.js",
          "e2e/p2-micro-ui-markdown-and-shortcuts.e2e.js",
          "e2e/p2-cli-and-landing.e2e.js",
        ])
      );
    }
    if (runP3) {
      exec(() => runPythonE2EFile("test_e2e_x11_desktop.py"));
      exec(() =>
        runNodeE2EFiles([
          "e2e/p3-tray-resilience-and-chaos.e2e.js",
          "e2e/p3-live-smoke.e2e.js",
        ])
      );
    }
    if (runLive) {
      exec(() => runNodeE2EFiles(["e2e/p3-live-smoke.e2e.js"], { TWINKLEBOT_E2E_LIVE: "1" }));
    }
  }

  aggregateReport(tier);
  const failed = stepResults.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[e2e] Completed with ${failed.length} failing suite step(s). See test-results/e2e-summary.json`);
    process.exit(1);
  }
  console.log(`\n[e2e] Tier '${tier}' completed cleanly.`);
}

main();
