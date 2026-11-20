#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CATALOG_PATH = path.join(PROJECT_ROOT, ".agents", "skills", "twinklebot-e2e", "references", "catalog.json");
const SYNC_SCRIPT = path.join(PROJECT_ROOT, ".agents", "skills", "twinklebot-e2e", "scripts", "check-e2e-sync.mjs");
const REPORT_SCRIPT = path.join(PROJECT_ROOT, ".agents", "skills", "twinklebot-e2e", "scripts", "generate-report.mjs");

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function getArgValue(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : "";
}

function parseTier() {
  const v = getArgValue("--tier=");
  if (v) return v.toLowerCase();
  return "chrome";
}

function parseTimeoutMs() {
  const raw = Number(getArgValue("--timeout="));
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 240_000;
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
    timeout: opts.timeoutMs ?? parseTimeoutMs(),
    env: { ...process.env, ...(opts.env || {}) },
  });
  const durationMs = Date.now() - started;
  if (res.error) {
    return { ok: false, status: -1, durationMs, cmd: pretty, error: res.error.message };
  }
  return { ok: res.status === 0, status: res.status ?? 1, durationMs, cmd: pretty };
}

function writePythonEnvSkipRecords(suite, reason) {
  if (!suite || !Array.isArray(suite.cases)) return;
  const casesDir = path.join(PROJECT_ROOT, "test-results", "cases");
  fs.mkdirSync(casesDir, { recursive: true });
  const now = new Date().toISOString();
  const records = suite.cases.map((c) => ({
    id: c.id,
    suite: suite.id,
    priority: c.priority,
    featureTier: c.featureTier,
    difficulty: c.difficulty,
    title: c.title,
    module: c.module,
    status: "ENV_SKIP",
    durationMs: 0,
    error: reason,
    reproCommand: `node scripts/run-e2e.mjs --case=${c.id}`,
    recordedAt: now,
  }));
  const outPath = path.join(casesDir, `${suite.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ suite: suite.id, updatedAt: now, records }, null, 2), "utf8");
}

function runPythonE2EFile(filename, suiteMeta = null, extraEnv = {}) {
  const reason = "Requires Linux Xvfb/Xtigervnc or macOS OrbStack 'ubuntu'";
  if (process.platform === "linux") {
    return runStep("python3", ["-m", "unittest", "discover", "-s", "executor", "-p", filename, "-v"], {
      env: { TWINKLEBOT_RUN_CHROME_E2E: "1", ...extraEnv },
    });
  }
  if (hasOrbUbuntu()) {
    const envPairs = Object.entries({ TWINKLEBOT_RUN_CHROME_E2E: "1", ...extraEnv })
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`);
    return runStep("orb", [
      "-m",
      "ubuntu",
      "env",
      ...envPairs,
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
  console.warn(`[e2e] Skipping ${filename}: ${reason}`);
  if (suiteMeta) writePythonEnvSkipRecords(suiteMeta, reason);
  return { ok: true, status: 0, durationMs: 0, cmd: filename, skipped: true };
}

function runSingleNodeE2EFile(relFile, extraEnv = {}) {
  const fullPath = path.join(PROJECT_ROOT, "dist-server", "test", relFile);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing compiled E2E file: ${fullPath} (run npm run build:ts first)`);
  }
  return runStep(process.execPath, ["--test", "--test-force-exit", fullPath], {
    env: extraEnv,
    timeoutMs: parseTimeoutMs(),
  });
}

function newestMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const st = fs.statSync(targetPath);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = st.mtimeMs;
  for (const ent of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist") continue;
    const childMax = newestMtimeMs(path.join(targetPath, ent.name));
    if (childMax > max) max = childMax;
  }
  return max;
}

function ensureMobileBundle() {
  const mobileIdx = path.join(PROJECT_ROOT, "dist-web", "index.html");
  let needsBuild = !fs.existsSync(mobileIdx);
  if (!needsBuild) {
    const builtAt = fs.statSync(mobileIdx).mtimeMs;
    const srcMtime = Math.max(
      newestMtimeMs(path.join(PROJECT_ROOT, "src", "web")),
      newestMtimeMs(path.join(PROJECT_ROOT, "public", "index.html")),
      newestMtimeMs(path.join(PROJECT_ROOT, "scripts", "build-web.mjs"))
    );
    if (srcMtime > builtAt) {
      needsBuild = true;
      console.log("[e2e] Detected newer src/web changes; rebuilding mobile web bundle (dist-web/)...");
    }
  } else {
    console.log("[e2e] Building mobile web bundle (dist-web/)...");
  }
  if (needsBuild) {
    const r = runStep(process.execPath, [path.join(PROJECT_ROOT, "scripts", "build-web.mjs")], {
      env: { APP_TARGET: "mobile" },
    });
    if (!r.ok) throw new Error("Failed to build mobile dist-web/ bundle");
  }
}

function cleanTestResults() {
  const casesDir = path.join(PROJECT_ROOT, "test-results", "cases");
  const evDir = path.join(PROJECT_ROOT, "test-results", "evidence");
  for (const dir of [casesDir, evDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function aggregateReport(tier = "aggregated", executedSuiteIds = null) {
  const casesDir = path.join(PROJECT_ROOT, "test-results", "cases");
  if (!fs.existsSync(casesDir)) return null;
  const allowedSet =
    Array.isArray(executedSuiteIds) && executedSuiteIds.length > 0
      ? new Set(executedSuiteIds)
      : null;

  const files = fs.readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  const allRecords = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(casesDir, f), "utf8"));
      if (allowedSet && parsed.suite && !allowedSet.has(parsed.suite)) continue;
      if (Array.isArray(parsed.records)) allRecords.push(...parsed.records);
    } catch {}
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    tier,
    executedSuites: allowedSet ? Array.from(allowedSet) : undefined,
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
  fs.mkdirSync(path.join(PROJECT_ROOT, "test-results"), { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_ROOT, "test-results", "e2e-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );
  console.log("\n[e2e] === Aggregated E2E Summary ===");
  console.log(JSON.stringify(summary.byStatus));
  console.log(JSON.stringify(summary.byPriority));

  if (fs.existsSync(REPORT_SCRIPT) && allRecords.length > 0) {
    const repArgs = [REPORT_SCRIPT, `--tier=${tier}`];
    if (process.argv.includes("--archive")) repArgs.push("--archive");
    const archiveEq = process.argv.find((a) => a.startsWith("--archive="));
    if (archiveEq) repArgs.push(archiveEq);
    spawnSync(process.execPath, repArgs, { cwd: PROJECT_ROOT, stdio: "inherit" });
  }
  return summary;
}

function resolveAffectedSuites() {
  const args = [SYNC_SCRIPT, "--json"];
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

function matchCasePattern(caseId, patterns) {
  const upper = caseId.toUpperCase();
  return patterns.some((pat) => {
    if (!pat.includes("*")) return upper === pat;
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(upper);
  });
}

function printCatalogList(catalog) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let total = 0;
  for (const s of catalog.suites || []) {
    const cases = s.cases || [];
    console.log(`\n[${s.tier}] ${s.id} (${cases.length} cases) — ${s.file}`);
    for (const c of cases) {
      counts[c.priority] = (counts[c.priority] || 0) + 1;
      total += 1;
      console.log(`  - ${c.id} [${c.featureTier}×${c.difficulty}] ${c.title}`);
    }
  }
  console.log(`\nTotal: ${catalog.suites.length} suites / ${total} atomic cases (${JSON.stringify(counts)})`);
}

function main() {
  if (process.argv.includes("--audit")) {
    const res = spawnSync(process.execPath, [SYNC_SCRIPT, "--audit", "--verbose"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    process.exit(res.status ?? 0);
  }

  const catalog = loadCatalog();
  if (process.argv.includes("--list")) {
    printCatalogList(catalog);
    return;
  }

  const suiteArg = getArgValue("--suite=");
  const caseArg = getArgValue("--case=");
  const tier = suiteArg ? `suite:${suiteArg}` : caseArg ? `case:${caseArg}` : parseTier();

  if (tier === "skip" || tier === "none") {
    console.log(`[e2e] E2E tier set to '${tier}'; skipping automated E2E run.`);
    return;
  }

  const shouldClean = process.argv.includes("--clean") || tier === "all";
  if (shouldClean) {
    cleanTestResults();
  }

  const continueOnError = process.argv.includes("--continue-on-error") || tier === "all";
  const stepResults = [];
  const executedSuiteIds = [];

  const exec = (fn) => {
    const r = fn();
    stepResults.push(r);
    if (!r.ok && !continueOnError) {
      aggregateReport(tier, executedSuiteIds);
      throw new Error(`E2E step failed (${r.status}): ${r.cmd}`);
    }
  };

  const runCatalogSuites = (suites, extraEnv = {}) => {
    if (suites.some((s) => s.requiresMobileBundle)) {
      ensureMobileBundle();
    }
    for (const s of suites) {
      executedSuiteIds.push(s.id);
      if (s.runtime === "python" && s.pythonPattern) {
        exec(() => runPythonE2EFile(s.pythonPattern, s, extraEnv));
      } else if (s.runtime === "node" && s.compiledFile) {
        exec(() => runSingleNodeE2EFile(s.compiledFile, extraEnv));
      }
    }
  };

  if (suiteArg) {
    const wanted = new Set(suiteArg.split(",").map((s) => s.trim()).filter(Boolean));
    const selected = (catalog.suites || []).filter(
      (s) => wanted.has(s.id) || wanted.has(s.file) || wanted.has(path.basename(s.file, ".e2e.ts"))
    );
    if (selected.length === 0) {
      throw new Error(`No suites matched --suite=${suiteArg}. Use --list to inspect suite IDs.`);
    }
    runCatalogSuites(selected, caseArg ? { TWINKLEBOT_E2E_CASES: caseArg } : {});
  } else if (caseArg) {
    const patterns = caseArg
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const selected = (catalog.suites || []).filter((s) =>
      (s.cases || []).some((c) => matchCasePattern(c.id, patterns))
    );
    if (selected.length === 0) {
      throw new Error(`No cases matched --case=${caseArg}. Use --list to inspect case IDs.`);
    }
    console.log(`[e2e] Running case filter '${caseArg}' across ${selected.length} suite(s): ${selected.map((s) => s.id).join(", ")}`);
    runCatalogSuites(selected, { TWINKLEBOT_E2E_CASES: patterns.join(",") });
  } else if (tier === "chrome") {
    exec(() => runPythonE2EFile("test_e2e_chrome.py"));
    exec(() => runSingleNodeE2EFile("web-ui-e2e.test.js", { TWINKLEBOT_REQUIRE_CHROME_E2E: "1" }));
  } else if (tier === "affected" || tier === "affected+p0" || tier === "release") {
    const includeP0Core = tier === "affected+p0" || tier === "release";
    const affected = resolveAffectedSuites();
    const affectedIds = new Set(affected.map((s) => s.id));
    const selected = (catalog.suites || []).filter(
      (s) => !s.liveOnly && (affectedIds.has(s.id) || (includeP0Core && s.tier === "P0"))
    );

    if (selected.length === 0) {
      console.log("[e2e] No E2E suites impacted by current git changes. Nothing to run.");
      return;
    }
    console.log(
      `[e2e] Running tier '${tier}': ${selected.length} suite(s)` +
        (includeP0Core ? " (includes P0 core baseline)" : "")
    );
    for (const s of affected) {
      console.log(`  - [affected ${s.tier}] ${s.file} (matched: ${(s.matchedBy || []).join(", ")})`);
    }
    runCatalogSuites(selected);
  } else if (tier === "live") {
    const liveSuites = (catalog.suites || []).filter((s) => s.liveOnly);
    runCatalogSuites(liveSuites, { TWINKLEBOT_E2E_LIVE: "1" });
  } else {
    const wantedTiers = new Set();
    if (tier === "p0" || tier === "p0+p1" || tier === "all") wantedTiers.add("P0");
    if (tier === "p1" || tier === "p0+p1" || tier === "all") wantedTiers.add("P1");
    if (tier === "p2" || tier === "all") wantedTiers.add("P2");
    if (tier === "p3" || tier === "all") wantedTiers.add("P3");

    if (wantedTiers.size === 0) {
      throw new Error(`Unknown --tier=${tier}. Valid tiers: p0, p1, p2, p3, p0+p1, all, affected, affected+p0, release, live, chrome, skip`);
    }
    const selected = (catalog.suites || []).filter((s) => wantedTiers.has(s.tier));
    runCatalogSuites(selected);
  }

  aggregateReport(tier, executedSuiteIds);
  const failed = stepResults.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[e2e] Completed with ${failed.length} failing suite step(s). See test-results/e2e-summary.json`);
    process.exit(1);
  }
  console.log(`\n[e2e] Tier '${tier}' completed cleanly.`);
}

main();
