#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_PROJECT_ROOT = path.resolve(SKILL_ROOT, "..", "..", "..");
export const DEFAULT_CATALOG_PATH = path.join(SKILL_ROOT, "references", "catalog.json");

export function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  const raw = fs.readFileSync(catalogPath, "utf8");
  return JSON.parse(raw);
}

/**
 * Simple glob matcher supporting `*`, `**`, and exact paths (POSIX forward slashes).
 */
export function matchGlob(filePath, pattern) {
  const normFile = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const normPat = String(pattern || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (normPat.endsWith("/")) {
    return normFile.startsWith(normPat);
  }
  const escaped = normPat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`).test(normFile);
}

/**
 * Validates that every suite file and every atomic case ID in catalog.json exists in source.
 */
export function validateCatalog(catalog, projectRoot = DEFAULT_PROJECT_ROOT) {
  const errors = [];
  const suites = Array.isArray(catalog?.suites) ? catalog.suites : [];
  if (suites.length === 0) {
    errors.push("catalog.json has no suites");
    return { ok: false, errors, suiteCount: 0, caseCount: 0 };
  }

  const seenIds = new Set();
  let caseCount = 0;

  for (const suite of suites) {
    const absFile = path.join(projectRoot, suite.file);
    if (!fs.existsSync(absFile)) {
      errors.push(`Missing suite file: ${suite.file} (suite ${suite.id})`);
      continue;
    }
    const content = fs.readFileSync(absFile, "utf8");
    const lowerContent = content.toLowerCase();
    for (const c of suite.cases || []) {
      caseCount += 1;
      if (seenIds.has(c.id)) {
        errors.push(`Duplicate case ID in catalog: ${c.id}`);
      }
      seenIds.add(c.id);
      const snakeId = c.id.toLowerCase().replace(/-/g, "_");
      if (!content.includes(c.id) && !lowerContent.includes(snakeId)) {
        errors.push(`Case ID '${c.id}' not found in ${suite.file}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    suiteCount: suites.length,
    caseCount,
  };
}

function runGit(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
  };
}

function resolvePreviousReleaseTag(cwd) {
  // Find most recent v* or ota-* tag strictly before HEAD (so re-tagging HEAD still diffs against prior release)
  const prev = runGit(
    ["describe", "--tags", "--abbrev=0", "--match", "v*", "--match", "ota-*", "HEAD~1"],
    cwd
  );
  if (prev.ok && prev.stdout.trim()) return prev.stdout.trim();
  const anyTag = runGit(
    ["describe", "--tags", "--abbrev=0", "--match", "v*", "--match", "ota-*"],
    cwd
  );
  if (anyTag.ok && anyTag.stdout.trim()) return anyTag.stdout.trim();
  if (runGit(["rev-parse", "--verify", "HEAD~1"], cwd).ok) return "HEAD~1";
  return null;
}

function resolveDiffMode(argv, cwd) {
  if (argv.includes("--staged")) return { mode: "staged", baseRef: null };
  const baseArg = argv.find((a) => a.startsWith("--base="));
  if (baseArg) return { mode: "base", baseRef: baseArg.slice("--base=".length).trim() };
  if (argv.includes("--since-last-tag")) {
    const tag = resolvePreviousReleaseTag(cwd);
    if (tag) return { mode: "base", baseRef: tag };
    return { mode: "working", baseRef: null };
  }
  if (argv.includes("--ci")) {
    const ghBase = String(process.env.GITHUB_BASE_REF || "").trim();
    if (ghBase && runGit(["rev-parse", "--verify", `origin/${ghBase}`], cwd).ok) {
      return { mode: "base", baseRef: `origin/${ghBase}` };
    }
    if (runGit(["rev-parse", "--verify", "HEAD~1"], cwd).ok) {
      return { mode: "base", baseRef: "HEAD~1" };
    }
  }
  return { mode: "working", baseRef: null };
}

function collectGitChanges({ mode, baseRef }, cwd) {
  const entries = [];
  let diffText = "";

  if (mode === "staged") {
    const ns = runGit(["diff", "--cached", "--name-status"], cwd);
    if (ns.ok) entries.push(...parseNameStatus(ns.stdout));
    diffText = runGit(["diff", "--cached", "--unified=0"], cwd).stdout;
  } else if (mode === "base" && baseRef) {
    const ns = runGit(["diff", "--name-status", `${baseRef}...HEAD`], cwd);
    if (ns.ok) entries.push(...parseNameStatus(ns.stdout));
    diffText = runGit(["diff", "--unified=0", `${baseRef}...HEAD`], cwd).stdout;
  } else {
    const ns = runGit(["diff", "--name-status", "HEAD"], cwd);
    if (ns.ok) entries.push(...parseNameStatus(ns.stdout));
    diffText = runGit(["diff", "--unified=0", "HEAD"], cwd).stdout;
    const untracked = runGit(["ls-files", "--others", "--exclude-standard"], cwd);
    if (untracked.ok) {
      for (const line of untracked.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        entries.push({ status: "A", file: line });
      }
    }
  }

  // Deduplicate by file path
  const byFile = new Map();
  for (const e of entries) {
    const prev = byFile.get(e.file);
    if (!prev || e.status === "A") byFile.set(e.file, e);
  }
  return { changes: Array.from(byFile.values()), diffText };
}

function parseNameStatus(stdout) {
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\t+/);
    const code = parts[0] || "M";
    const file = code.startsWith("R") || code.startsWith("C") ? parts[2] || parts[1] : parts[1];
    if (file) {
      out.push({ status: code[0], file: file.replace(/\\/g, "/") });
    }
  }
  return out;
}

/**
 * Extracts newly added API routes, bot tool names, and executor endpoints from unified diff text.
 */
export function extractAddedFeatureSymbols(diffText) {
  const addedRoutes = new Set();
  const addedTools = new Set();
  const addedExecutorRoutes = new Set();

  let currentFile = "";
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length).trim();
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    if (currentFile.startsWith("src/server/routes/") || currentFile === "src/server/index.ts") {
      const m1 = line.match(/pathname\s*===\s*["'`](\/api\/[^"'`]+)["'`]/);
      if (m1) addedRoutes.add(`${currentFile}: ${m1[1]}`);
    }
    if (currentFile === "src/agent/bot-tools/declarations.ts" || currentFile === "src/agent/tools.ts") {
      const m2 = line.match(/\bname:\s*["'`]([a-z][a-z0-9_]{2,})["'`]/);
      if (m2) addedTools.add(`${currentFile}: ${m2[1]}`);
    }
    if (currentFile === "executor/executor.py") {
      const m3 = line.match(/\b(?:if|elif)\s+path\s*==\s*["'](\/[^"']+)["']/);
      if (m3) addedExecutorRoutes.add(`executor/executor.py: ${m3[1]}`);
    }
  }

  return {
    addedRoutes: Array.from(addedRoutes),
    addedTools: Array.from(addedTools),
    addedExecutorRoutes: Array.from(addedExecutorRoutes),
  };
}

function suggestPriorityForFile(filePath) {
  if (/policy|device-auth|gemini-driver|loop\.ts|OnboardingOverlay|InteractiveCards/.test(filePath)) {
    return "P0 (F1×D1/D2)";
  }
  if (/executor\.py|electron\/|mobile|mail|skills|route|billing/.test(filePath)) {
    return "P1 (F1/F2×D2/D3)";
  }
  return "P2 (F3×D1/D2)";
}

/**
 * Pure analysis function usable both by CLI and unit tests.
 */
export function analyzeE2ESync({ catalog, changes, diffText = "", projectRoot = DEFAULT_PROJECT_ROOT }) {
  const integrity = validateCatalog(catalog, projectRoot);
  const suites = Array.isArray(catalog?.suites) ? catalog.suites : [];
  const watchRoots = Array.isArray(catalog?.watchRoots) ? catalog.watchRoots : [];

  const touchedE2E = changes.some(
    (c) =>
      c.file.startsWith("test/e2e/") ||
      c.file === "executor/test_e2e_x11_desktop.py" ||
      c.file.endsWith("/catalog.json") ||
      c.file.endsWith("/test-plan.md")
  );

  const affectedMap = new Map();
  const unmappedNewFiles = [];

  for (const ch of changes) {
    const f = ch.file;
    let matchedAnySuite = false;

    for (const suite of suites) {
      if (suite.liveOnly) continue;
      const directMatch = f === suite.file;
      const globMatch = (suite.sourceGlobs || []).some((g) => matchGlob(f, g));
      if (directMatch || globMatch) {
        matchedAnySuite = true;
        const entry = affectedMap.get(suite.id) || {
          id: suite.id,
          tier: suite.tier,
          runtime: suite.runtime,
          file: suite.file,
          compiledFile: suite.compiledFile || null,
          pythonPattern: suite.pythonPattern || null,
          requiresMobileBundle: Boolean(suite.requiresMobileBundle),
          matchedBy: [],
        };
        if (!entry.matchedBy.includes(f)) entry.matchedBy.push(f);
        affectedMap.set(suite.id, entry);
      }
    }

    const inWatchRoot = watchRoots.some((r) => matchGlob(f, r));
    if (ch.status === "A" && inWatchRoot && !matchedAnySuite) {
      unmappedNewFiles.push({
        file: f,
        suggestedPriority: suggestPriorityForFile(f),
      });
    }
  }

  const symbols = extractAddedFeatureSymbols(diffText);
  const newFeatureSymbols = [
    ...symbols.addedRoutes,
    ...symbols.addedTools,
    ...symbols.addedExecutorRoutes,
  ];
  const needsE2EUpdate =
    unmappedNewFiles.length > 0 || (newFeatureSymbols.length > 0 && !touchedE2E);

  const affectedSuites = Array.from(affectedMap.values()).sort((a, b) =>
    a.tier.localeCompare(b.tier) || a.id.localeCompare(b.id)
  );

  return {
    integrity,
    changedFilesCount: changes.length,
    touchedE2E,
    affectedSuites,
    unmappedNewFiles,
    addedSymbols: symbols,
    needsE2EUpdate,
  };
}

function formatMarkdownSummary(report, modeLabel) {
  const lines = [
    `### TwinkleBot E2E Sync Check (\`${modeLabel}\`)`,
    "",
    `- **Catalog Integrity**: ${report.integrity.ok ? `PASS (${report.integrity.suiteCount} suites / ${report.integrity.caseCount} cases)` : `FAIL (${report.integrity.errors.length} error(s))`}`,
    `- **Changed Files Analyzed**: ${report.changedFilesCount}`,
    `- **Affected E2E Suites**: ${report.affectedSuites.length}`,
    `- **E2E Plan/Tests Updated in Diff**: ${report.touchedE2E ? "Yes" : "No"}`,
    "",
  ];

  if (report.affectedSuites.length > 0) {
    lines.push("#### Recommended Targeted E2E Suites");
    lines.push("| Tier | Suite | Triggered By |");
    lines.push("| :---: | :--- | :--- |");
    for (const s of report.affectedSuites) {
      lines.push(`| **${s.tier}** | \`${s.file}\` | ${s.matchedBy.slice(0, 4).map((f) => `\`${f}\``).join(", ")}${s.matchedBy.length > 4 ? ` (+${s.matchedBy.length - 4})` : ""} |`);
    }
    lines.push("");
  }

  if (report.needsE2EUpdate) {
    lines.push("#### New Feature E2E Sync Reminder");
    for (const item of report.unmappedNewFiles) {
      lines.push(`- New unmapped source file: \`${item.file}\` → suggested **${item.suggestedPriority}**`);
    }
    for (const r of report.addedSymbols.addedRoutes) {
      lines.push(`- New API route detected: \`${r}\``);
    }
    for (const t of report.addedSymbols.addedTools) {
      lines.push(`- New Bot tool detected: \`${t}\``);
    }
    for (const e of report.addedSymbols.addedExecutorRoutes) {
      lines.push(`- New Executor endpoint detected: \`${e}\``);
    }
    lines.push("");
    lines.push("Run `/twinklebot-e2e update` (update `catalog.json`, `test-plan.md`, and add an atomic E2E case), then run `npm run test:e2e:affected`.");
  }

  return lines.join("\n") + "\n";
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const strict = argv.includes("--strict");
  const isCi = argv.includes("--ci");
  const verbose = argv.includes("--verbose");
  const quietIfSynced = argv.includes("--quiet-if-synced");

  const catalog = loadCatalog();
  const diffMode = resolveDiffMode(argv, DEFAULT_PROJECT_ROOT);
  const { changes, diffText } = collectGitChanges(diffMode, DEFAULT_PROJECT_ROOT);
  const report = analyzeE2ESync({
    catalog,
    changes,
    diffText,
    projectRoot: DEFAULT_PROJECT_ROOT,
  });

  if (asJson) {
    console.log(JSON.stringify({ mode: diffMode.mode, baseRef: diffMode.baseRef, ...report }, null, 2));
  } else {
    if (!report.integrity.ok) {
      console.error("[e2e:sync] Catalog integrity check FAILED:");
      for (const err of report.integrity.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    if (quietIfSynced && !report.needsE2EUpdate) {
      // Stay completely silent on routine local edits when no brand-new unmapped feature is staged
    } else if (report.affectedSuites.length === 0 && !report.needsE2EUpdate) {
      if (verbose || isCi) {
        console.log(
          `[e2e:sync] OK (${report.integrity.suiteCount} suites / ${report.integrity.caseCount} cases verified; no E2E-impacting changes in ${diffMode.mode}).`
        );
      }
    } else {
      console.log(
        `[e2e:sync] Catalog OK (${report.integrity.suiteCount} suites / ${report.integrity.caseCount} cases). Mode: ${diffMode.baseRef ? `diff ${diffMode.baseRef}...HEAD` : diffMode.mode}`
      );
      if (report.affectedSuites.length > 0 && !quietIfSynced) {
        console.log("[e2e:sync] Impacted E2E suites (recommended targeted re-test):");
        for (const s of report.affectedSuites) {
          console.log(`  - [${s.tier}] ${s.file}  (via ${s.matchedBy.join(", ")})`);
        }
        console.log("  -> Run: npm run test:e2e:affected  (or for GitHub Release: npm run test:e2e:release)");
      }
      if (report.needsE2EUpdate) {
        console.log("\n[e2e:sync] REMINDER: New feature surface detected without E2E catalog/test update:");
        for (const item of report.unmappedNewFiles) {
          console.log(`  * New file: ${item.file}  [suggested ${item.suggestedPriority}]`);
        }
        for (const r of report.addedSymbols.addedRoutes) console.log(`  * New API route: ${r}`);
        for (const t of report.addedSymbols.addedTools) console.log(`  * New Bot tool: ${t}`);
        for (const e of report.addedSymbols.addedExecutorRoutes) console.log(`  * New Executor route: ${e}`);
        console.log("  -> Run '/twinklebot-e2e update' to update references/catalog.json, references/test-plan.md & test/e2e/.");
      }
    }

    if (isCi && process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          formatMarkdownSummary(report, diffMode.baseRef ? `diff ${diffMode.baseRef}...HEAD` : diffMode.mode),
          "utf8"
        );
      } catch {}
    }
  }

  if (!report.integrity.ok) process.exit(1);
  if (strict && report.needsE2EUpdate) process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
