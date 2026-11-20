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

function normalizeRouteRegex(rawRegex) {
  return rawRegex
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\[\^\/\]\+\)/g, ":id")
    .replace(/\(\[\^\/\]\*\)/g, ":id")
    .replace(/\(\?:([^)]+)\)/g, "($1)")
    .replace(/\(\/([^)]+)\)\?/g, "[/$1]")
    .replace(/\\\./g, ".");
}

/**
 * Extracts all HTTP API routes declared in a server source file (===, startsWith, .match).
 */
export function extractServerRoutesFromSource(relFile, content) {
  const routes = new Set();
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // 1. pathname === "/api/..."
    for (const m of line.matchAll(/pathname\s*===\s*["'`](\/api\/[^"'`]+)["'`]/g)) {
      routes.add(m[1]);
    }
    // 2. pathname.startsWith("/api/...") — ignore broad "/api/" auth guard
    for (const m of line.matchAll(/pathname\.startsWith\(\s*["'`](\/api\/[^"'`]+)["'`]\s*\)/g)) {
      if (m[1] !== "/api/") {
        routes.add(m[1].endsWith("/") ? `${m[1]}:id` : m[1]);
      }
    }
    // 3. pathname.match(/^\/api\/.../) or multi-line /^\/api\/.../
    const regexPat = /\/(\^\\\/api\\\/(?:\\.|\[[^\]]*\]|[^/\n])+)\/[a-z]*/g;
    for (const m of line.matchAll(regexPat)) {
      routes.add(normalizeRouteRegex(m[1]));
    }
  }
  return Array.from(routes).sort();
}

/**
 * Extracts declared LLM tool names accurately from tools.ts, host-tools.ts, declarations.ts.
 */
export function extractToolsFromSource(relFile, content) {
  const tools = new Set();
  const text = String(content || "");
  // Match declaration objects where `name: "snake_case"` is followed shortly by `description:`
  const declRe = /\bname:\s*["'`]([a-z][a-z0-9_]{2,})["'`]\s*,\s*(?:\/\/[^\n]*\n\s*)?description:/g;
  for (const m of text.matchAll(declRe)) {
    tools.add(m[1]);
  }
  return Array.from(tools).sort();
}

/**
 * Extracts all GET and POST endpoints from executor/executor.py.
 */
export function extractExecutorEndpointsFromSource(content) {
  const endpoints = new Set();
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/\b(?:if|elif)\s+(?:parsed\.)?path\s*==\s*["'](\/[^"']+)["']/);
    if (m) endpoints.add(m[1]);
    const m2 = line.match(/\b(?:if|elif)\s+(?:parsed\.)?path\.startswith\(\s*["'](\/[^"']+)["']\s*\)/);
    if (m2) endpoints.add(m2[1]);
  }
  return Array.from(endpoints).sort();
}

/**
 * Validates bidirectional consistency between catalog.json, test/e2e/*.e2e.ts,
 * executor/test_e2e_x11_desktop.py, and references/test-plan.md.
 */
export function validateCatalog(catalog, projectRoot = DEFAULT_PROJECT_ROOT) {
  const errors = [];
  const suites = Array.isArray(catalog?.suites) ? catalog.suites : [];
  if (suites.length === 0) {
    errors.push("catalog.json has no suites");
    return { ok: false, errors, suiteCount: 0, caseCount: 0 };
  }

  const seenIds = new Set();
  const registeredFiles = new Set();
  let caseCount = 0;

  for (const suite of suites) {
    registeredFiles.add(String(suite.file || "").replace(/\\/g, "/"));
    const absFile = path.join(projectRoot, suite.file);
    if (!fs.existsSync(absFile)) {
      errors.push(`Missing suite file: ${suite.file} (suite ${suite.id})`);
      continue;
    }
    const content = fs.readFileSync(absFile, "utf8");
    const lowerContent = content.toLowerCase();
    const suiteCatalogIds = new Set();
    for (const c of suite.cases || []) {
      caseCount += 1;
      suiteCatalogIds.add(c.id);
      if (seenIds.has(c.id)) {
        errors.push(`Duplicate case ID in catalog: ${c.id}`);
      }
      seenIds.add(c.id);
      const snakeId = c.id.toLowerCase().replace(/-/g, "_");
      if (!content.includes(c.id) && !lowerContent.includes(snakeId)) {
        errors.push(`Case ID '${c.id}' not found in ${suite.file}`);
      }
    }

    // Reverse check: every collector.runCase({ id: "P..." }) in TS suites must be in catalog.json
    if (suite.file.endsWith(".e2e.ts")) {
      for (const m of content.matchAll(/\bid:\s*["'`](P[0-3]-[A-Z0-9]+-\d+)["'`]/g)) {
        if (!suiteCatalogIds.has(m[1])) {
          errors.push(`Unregistered case ID '${m[1]}' in ${suite.file} (missing from catalog.json)`);
        }
      }
    }
  }

  // Reverse check: every test/e2e/*.e2e.ts file on disk must be registered in catalog.json
  const e2eDir = path.join(projectRoot, "test", "e2e");
  if (fs.existsSync(e2eDir)) {
    for (const f of fs.readdirSync(e2eDir)) {
      if (!f.endsWith(".e2e.ts")) continue;
      const rel = `test/e2e/${f}`;
      if (!registeredFiles.has(rel)) {
        errors.push(`Orphan E2E suite file not in catalog.json: ${rel}`);
      }
    }
  }

  // Sync check against references/test-plan.md if present in projectRoot
  const planPath = path.join(projectRoot, ".agents", "skills", "twinklebot-e2e", "references", "test-plan.md");
  if (fs.existsSync(planPath)) {
    const planText = fs.readFileSync(planPath, "utf8");
    for (const id of seenIds) {
      if (!planText.includes(id)) {
        errors.push(`references/test-plan.md is missing case ID '${id}'`);
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

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      ent.name === "node_modules" ||
      ent.name === "dist" ||
      ent.name === "dist-server" ||
      ent.name === "dist-web" ||
      ent.name === "__pycache__" ||
      ent.name.startsWith(".")
    ) {
      continue;
    }
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Full-codebase 6-dimension static coverage audit:
 *   1. Source files mapped by catalog.json sourceGlobs
 *   2. Server HTTP API routes covered by E2E suites / catalog
 *   3. Agent / Host / Sandbox / Router tools covered by E2E suites / catalog
 *   4. Executor (executor.py) GET/POST endpoints covered by E2E suites / catalog
 *   5. Web React component files mapped & referenced
 *   6. Backend API capabilities (version-policy.json) covered by E2E suites
 */
export function runFullCoverageAudit(catalog, projectRoot = DEFAULT_PROJECT_ROOT) {
  const suites = Array.isArray(catalog?.suites) ? catalog.suites : [];
  const activeSuites = suites.filter((s) => !s.liveOnly);
  const allGlobs = activeSuites.flatMap((s) => s.sourceGlobs || []);

  // Load combined E2E corpus (all registered E2E test files + helpers + catalog metadata)
  const corpusParts = [JSON.stringify(catalog)];
  for (const s of suites) {
    const abs = path.join(projectRoot, s.file);
    if (fs.existsSync(abs)) corpusParts.push(fs.readFileSync(abs, "utf8"));
  }
  const helperDir = path.join(projectRoot, "test", "helpers");
  if (fs.existsSync(helperDir)) {
    for (const f of fs.readdirSync(helperDir)) {
      if (f.endsWith(".ts")) corpusParts.push(fs.readFileSync(path.join(helperDir, f), "utf8"));
    }
  }
  const corpus = corpusParts.join("\n");

  // 1. Source files
  const rel = (abs) => path.relative(projectRoot, abs).replace(/\\/g, "/");
  const allSourceFiles = [
    ...walkFiles(path.join(projectRoot, "src")),
    ...walkFiles(path.join(projectRoot, "electron")),
    ...walkFiles(path.join(projectRoot, "executor")).filter(
      (f) => f.endsWith(".py") && !path.basename(f).startsWith("test_")
    ),
    ...walkFiles(path.join(projectRoot, "landing")).filter(
      (f) => !f.endsWith(".png") && !f.includes(`${path.sep}dist${path.sep}`)
    ),
  ]
    .map(rel)
    .sort();
  const unmappedSourceFiles = allSourceFiles.filter((f) => !allGlobs.some((g) => matchGlob(f, g)));

  // 2. Server HTTP API routes
  const serverRouteFiles = [
    path.join(projectRoot, "src", "server", "index.ts"),
    ...walkFiles(path.join(projectRoot, "src", "server", "routes")).filter((f) => f.endsWith(".ts")),
  ].filter((f) => fs.existsSync(f));
  const routeSet = new Set();
  for (const f of serverRouteFiles) {
    const content = fs.readFileSync(f, "utf8");
    for (const r of extractServerRoutesFromSource(rel(f), content)) {
      routeSet.add(r);
    }
  }
  const allRoutes = Array.from(routeSet).sort();
  const uncoveredRoutes = allRoutes.filter((r) => {
    if (corpus.includes(r)) return false;
    // Strip optional suffix notation like [/(test)] -> base path
    const cleaned = r.replace(/\[[^\]]*\]/g, "");
    const parts = cleaned.split(/:[a-zA-Z0-9_]+|\([^)]+\)/).filter((p) => p && p !== "/");
    if (parts.length === 0) return true;
    // Prefix must exist in E2E corpus, and if there's a trailing static segment (e.g. /reveal, /resolve, /clear),
    // it must also appear near the prefix (as /prefix/.../suffix in a string/template literal).
    const first = parts[0].replace(/\/$/, "");
    if (first.length <= 4) return true;
    if (parts.length === 1) {
      return !corpus.includes(first);
    }
    const last = parts[parts.length - 1];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dynamicRe = new RegExp(`${esc(first)}[^\\n"'\\\`]{1,80}${esc(last)}`);
    return !dynamicRe.test(corpus);
  });

  // 3. Tools (sandbox + host + bot + route_escalate)
  const toolFiles = [
    path.join(projectRoot, "src", "agent", "tools.ts"),
    path.join(projectRoot, "src", "agent", "host-tools.ts"),
    path.join(projectRoot, "src", "agent", "bot-tools", "declarations.ts"),
  ].filter((f) => fs.existsSync(f));
  const toolSet = new Set(["route_escalate"]);
  for (const f of toolFiles) {
    for (const t of extractToolsFromSource(rel(f), fs.readFileSync(f, "utf8"))) {
      toolSet.add(t);
    }
  }
  const allTools = Array.from(toolSet).sort();
  const uncoveredTools = allTools.filter((t) => !corpus.includes(t));

  // 4. Executor endpoints
  const execFile = path.join(projectRoot, "executor", "executor.py");
  const allExecutorEndpoints = fs.existsSync(execFile)
    ? extractExecutorEndpointsFromSource(fs.readFileSync(execFile, "utf8"))
    : [];
  const uncoveredExecutorEndpoints = allExecutorEndpoints.filter((ep) => !corpus.includes(ep));

  // 5. Web React components
  const webComponentFiles = walkFiles(path.join(projectRoot, "src", "web", "components"))
    .filter((f) => f.endsWith(".tsx"))
    .map(rel)
    .sort();
  const unmappedWebComponents = webComponentFiles.filter(
    (f) => !allGlobs.some((g) => matchGlob(f, g))
  );

  // 6. Backend API capabilities
  const vpPath = path.join(projectRoot, "version-policy.json");
  let allCapabilities = [];
  if (fs.existsSync(vpPath)) {
    try {
      const vp = JSON.parse(fs.readFileSync(vpPath, "utf8"));
      allCapabilities = Array.isArray(vp?.backend?.apiCapabilities) ? vp.backend.apiCapabilities : [];
    } catch {}
  }
  const uncoveredCapabilities = allCapabilities.filter((cap) => !corpus.includes(cap));

  const pct = (covered, total) => (total === 0 ? 100 : Math.round((covered / total) * 1000) / 10);

  const dimensions = {
    sourceFiles: {
      total: allSourceFiles.length,
      covered: allSourceFiles.length - unmappedSourceFiles.length,
      pct: pct(allSourceFiles.length - unmappedSourceFiles.length, allSourceFiles.length),
      uncovered: unmappedSourceFiles,
    },
    apiRoutes: {
      total: allRoutes.length,
      covered: allRoutes.length - uncoveredRoutes.length,
      pct: pct(allRoutes.length - uncoveredRoutes.length, allRoutes.length),
      uncovered: uncoveredRoutes,
    },
    tools: {
      total: allTools.length,
      covered: allTools.length - uncoveredTools.length,
      pct: pct(allTools.length - uncoveredTools.length, allTools.length),
      uncovered: uncoveredTools,
    },
    executorEndpoints: {
      total: allExecutorEndpoints.length,
      covered: allExecutorEndpoints.length - uncoveredExecutorEndpoints.length,
      pct: pct(allExecutorEndpoints.length - uncoveredExecutorEndpoints.length, allExecutorEndpoints.length),
      uncovered: uncoveredExecutorEndpoints,
    },
    webComponents: {
      total: webComponentFiles.length,
      covered: webComponentFiles.length - unmappedWebComponents.length,
      pct: pct(webComponentFiles.length - unmappedWebComponents.length, webComponentFiles.length),
      uncovered: unmappedWebComponents,
    },
    apiCapabilities: {
      total: allCapabilities.length,
      covered: allCapabilities.length - uncoveredCapabilities.length,
      pct: pct(allCapabilities.length - uncoveredCapabilities.length, allCapabilities.length),
      uncovered: uncoveredCapabilities,
    },
  };

  const ok =
    unmappedSourceFiles.length === 0 &&
    uncoveredRoutes.length === 0 &&
    uncoveredTools.length === 0 &&
    uncoveredExecutorEndpoints.length === 0 &&
    unmappedWebComponents.length === 0 &&
    uncoveredCapabilities.length === 0;

  return { ok, dimensions };
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
        // Also synthesize unified-diff lines for untracked source files so added symbols are detected
        if (/\.(ts|tsx|py|json)$/.test(line) && (line.startsWith("src/") || line.startsWith("executor/"))) {
          try {
            const abs = path.join(cwd, line);
            if (fs.existsSync(abs) && fs.statSync(abs).size < 256 * 1024) {
              const content = fs.readFileSync(abs, "utf8");
              diffText += `\n+++ b/${line}\n` + content.split(/\r?\n/).map((l) => `+${l}`).join("\n") + "\n";
            }
          } catch {}
        }
      }
    }
  }

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
 * Extracts newly added API routes (===, startsWith, .match), bot/host/sandbox tools,
 * executor GET/POST endpoints, exported React components, and API capabilities from diff text.
 */
export function extractAddedFeatureSymbols(diffText) {
  const addedRoutes = new Set();
  const addedTools = new Set();
  const addedExecutorRoutes = new Set();
  const addedCapabilities = new Set();
  const addedComponents = new Set();

  let currentFile = "";
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length).trim();
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const code = line.slice(1);

    if (currentFile.startsWith("src/server/routes/") || currentFile === "src/server/index.ts") {
      for (const r of extractServerRoutesFromSource(currentFile, code)) {
        addedRoutes.add(`${currentFile}: ${r}`);
      }
    }
    if (
      currentFile === "src/agent/bot-tools/declarations.ts" ||
      currentFile === "src/agent/tools.ts" ||
      currentFile === "src/agent/host-tools.ts"
    ) {
      const m2 = code.match(/\bname:\s*["'`]([a-z][a-z0-9_]{2,})["'`]/);
      if (m2) addedTools.add(`${currentFile}: ${m2[1]}`);
    }
    if (currentFile === "executor/executor.py") {
      for (const ep of extractExecutorEndpointsFromSource(code)) {
        addedExecutorRoutes.add(`executor/executor.py: ${ep}`);
      }
    }
    if (currentFile === "src/shared/versioning.ts" || currentFile === "version-policy.json") {
      const mCap = code.match(/["'`]([a-z][a-z0-9-]+-v\d+)["'`]/);
      if (mCap) addedCapabilities.add(`${currentFile}: ${mCap[1]}`);
    }
    if (currentFile.startsWith("src/web/components/") && currentFile.endsWith(".tsx")) {
      const mComp = code.match(/export\s+function\s+([A-Z][A-Za-z0-9]+)/);
      if (mComp) addedComponents.add(`${currentFile}: ${mComp[1]}`);
    }
  }

  return {
    addedRoutes: Array.from(addedRoutes),
    addedTools: Array.from(addedTools),
    addedExecutorRoutes: Array.from(addedExecutorRoutes),
    addedCapabilities: Array.from(addedCapabilities),
    addedComponents: Array.from(addedComponents),
  };
}

function suggestPriorityForFile(filePath) {
  if (/policy|device-auth|local-crypto|memory-extractor|gemini-driver|loop\.ts|OnboardingOverlay|InteractiveCards/.test(filePath)) {
    return "P0 (F1×D1/D2)";
  }
  if (/executor\.py|electron\/|mobile|network-monitor|NetworkStatusBanner|mail|skills|route|billing/.test(filePath)) {
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
  const touchedCatalog = changes.some((c) => c.file.endsWith("/catalog.json"));

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
    ...symbols.addedCapabilities,
    ...symbols.addedComponents,
  ];
  const needsE2EUpdate =
    unmappedNewFiles.length > 0 || (newFeatureSymbols.length > 0 && !touchedE2E);
  const needsCatalogReminder = newFeatureSymbols.length > 0 && touchedE2E && !touchedCatalog;

  const affectedSuites = Array.from(affectedMap.values()).sort((a, b) =>
    a.tier.localeCompare(b.tier) || a.id.localeCompare(b.id)
  );

  return {
    integrity,
    changedFilesCount: changes.length,
    touchedE2E,
    touchedCatalog,
    affectedSuites,
    unmappedNewFiles,
    addedSymbols: symbols,
    needsE2EUpdate,
    needsCatalogReminder,
  };
}

function formatAuditOutput(audit) {
  const d = audit.dimensions;
  const rows = [
    ["Source Files (sourceGlobs)", d.sourceFiles],
    ["HTTP API Routes", d.apiRoutes],
    ["Bot / Host / Sandbox Tools", d.tools],
    ["Executor Endpoints", d.executorEndpoints],
    ["Web UI Components", d.webComponents],
    ["API Capabilities", d.apiCapabilities],
  ];
  const lines = ["[e2e:audit] Full-Codebase 6-Dimension Static Coverage Audit:"];
  for (const [label, stat] of rows) {
    const mark = stat.uncovered.length === 0 ? "✅" : "⚠️";
    lines.push(`  ${mark} ${label}: ${stat.covered}/${stat.total} (${stat.pct}%)`);
    for (const u of stat.uncovered.slice(0, 20)) {
      lines.push(`     - UNCOVERED: ${u}`);
    }
    if (stat.uncovered.length > 20) {
      lines.push(`     - ... (+${stat.uncovered.length - 20} more)`);
    }
  }
  lines.push(
    audit.ok
      ? "[e2e:audit] PASS — 100% static coverage across all 6 dimensions."
      : "[e2e:audit] GAPS DETECTED — run '/twinklebot-e2e update' to register & cover missing items."
  );
  return lines.join("\n");
}

function formatMarkdownSummary(report, modeLabel, audit = null) {
  const lines = [
    `### TwinkleBot E2E Sync Check (\`${modeLabel}\`)`,
    "",
    `- **Catalog Integrity**: ${report.integrity.ok ? `PASS (${report.integrity.suiteCount} suites / ${report.integrity.caseCount} cases)` : `FAIL (${report.integrity.errors.length} error(s))`}`,
    `- **Changed Files Analyzed**: ${report.changedFilesCount}`,
    `- **Affected E2E Suites**: ${report.affectedSuites.length}`,
    `- **E2E Plan/Tests Updated in Diff**: ${report.touchedE2E ? "Yes" : "No"}`,
    "",
  ];

  if (audit) {
    const d = audit.dimensions;
    lines.push("#### 6-Dimension Static Coverage Audit");
    lines.push("| Dimension | Covered | Total | Coverage |");
    lines.push("| :--- | :---: | :---: | :---: |");
    for (const [label, st] of [
      ["Source Files", d.sourceFiles],
      ["HTTP API Routes", d.apiRoutes],
      ["Tools (Bot/Host/Sandbox)", d.tools],
      ["Executor Endpoints", d.executorEndpoints],
      ["Web UI Components", d.webComponents],
      ["API Capabilities", d.apiCapabilities],
    ]) {
      lines.push(`| ${label} | ${st.covered} | ${st.total} | **${st.pct}%** |`);
    }
    lines.push("");
  }

  if (report.affectedSuites.length > 0) {
    lines.push("#### Recommended Targeted E2E Suites");
    lines.push("| Tier | Suite | Triggered By |");
    lines.push("| :---: | :--- | :--- |");
    for (const s of report.affectedSuites) {
      lines.push(
        `| **${s.tier}** | \`${s.file}\` | ${s.matchedBy.slice(0, 4).map((f) => `\`${f}\``).join(", ")}${s.matchedBy.length > 4 ? ` (+${s.matchedBy.length - 4})` : ""} |`
      );
    }
    lines.push("");
  }

  if (report.needsE2EUpdate) {
    lines.push("#### New Feature E2E Sync Reminder");
    for (const item of report.unmappedNewFiles) {
      lines.push(`- New unmapped source file: \`${item.file}\` → suggested **${item.suggestedPriority}**`);
    }
    for (const r of report.addedSymbols.addedRoutes) lines.push(`- New API route detected: \`${r}\``);
    for (const t of report.addedSymbols.addedTools) lines.push(`- New tool detected: \`${t}\``);
    for (const e of report.addedSymbols.addedExecutorRoutes) lines.push(`- New Executor endpoint detected: \`${e}\``);
    for (const c of report.addedSymbols.addedCapabilities) lines.push(`- New API capability detected: \`${c}\``);
    for (const comp of report.addedSymbols.addedComponents) lines.push(`- New UI component detected: \`${comp}\``);
    lines.push("");
    lines.push(
      "Run `/twinklebot-e2e update` (update `catalog.json`, `test-plan.md`, and add an atomic E2E case), then run `npm run test:e2e:affected`."
    );
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
  const doAudit = argv.includes("--audit");

  const catalog = loadCatalog();
  const diffMode = resolveDiffMode(argv, DEFAULT_PROJECT_ROOT);
  const { changes, diffText } = collectGitChanges(diffMode, DEFAULT_PROJECT_ROOT);
  const report = analyzeE2ESync({
    catalog,
    changes,
    diffText,
    projectRoot: DEFAULT_PROJECT_ROOT,
  });
  const audit = doAudit ? runFullCoverageAudit(catalog, DEFAULT_PROJECT_ROOT) : null;

  if (asJson) {
    console.log(
      JSON.stringify(
        { mode: diffMode.mode, baseRef: diffMode.baseRef, ...report, ...(audit ? { audit } : {}) },
        null,
        2
      )
    );
  } else {
    if (!report.integrity.ok) {
      console.error("[e2e:sync] Catalog integrity check FAILED:");
      for (const err of report.integrity.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    if (audit) {
      console.log(formatAuditOutput(audit));
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
        for (const t of report.addedSymbols.addedTools) console.log(`  * New tool: ${t}`);
        for (const e of report.addedSymbols.addedExecutorRoutes) console.log(`  * New Executor route: ${e}`);
        for (const c of report.addedSymbols.addedCapabilities) console.log(`  * New capability: ${c}`);
        for (const comp of report.addedSymbols.addedComponents) console.log(`  * New UI component: ${comp}`);
        console.log("  -> Run '/twinklebot-e2e update' to update references/catalog.json, references/test-plan.md & test/e2e/.");
      } else if (report.needsCatalogReminder && !quietIfSynced) {
        console.log("\n[e2e:sync] NOTE: New feature symbols detected with test/e2e/ edits, but references/catalog.json was not updated.");
      }
    }

    if (isCi && process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          formatMarkdownSummary(report, diffMode.baseRef ? `diff ${diffMode.baseRef}...HEAD` : diffMode.mode, audit),
          "utf8"
        );
      } catch {}
    }
  }

  if (!report.integrity.ok) process.exit(1);
  if (strict && report.needsE2EUpdate) process.exit(2);
  if (strict && audit && !audit.ok) process.exit(3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
