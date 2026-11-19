import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SKILL_DIR = path.join(PROJECT_ROOT, ".agents", "skills", "twinklebot-e2e");

async function loadSyncModule(): Promise<any> {
  const modPath = path.join(SKILL_DIR, "scripts", "check-e2e-sync.mjs");
  return import(pathToFileURL(modPath).href);
}

async function loadReportModule(): Promise<any> {
  const modPath = path.join(SKILL_DIR, "scripts", "generate-report.mjs");
  return import(pathToFileURL(modPath).href);
}

test("twinklebot-e2e skill complies with Agent Skills standard and multi-agent discovery paths", () => {
  const skillMdPath = path.join(SKILL_DIR, "SKILL.md");
  assert.ok(fs.existsSync(skillMdPath), "Canonical .agents/skills/twinklebot-e2e/SKILL.md must exist");

  const skillMd = fs.readFileSync(skillMdPath, "utf8");
  assert.match(skillMd, /^---\n[\s\S]+?\n---/, "SKILL.md must start with YAML frontmatter");
  assert.match(skillMd, /\nname:\s*twinklebot-e2e\s*\n/, "Frontmatter name must match folder 'twinklebot-e2e'");
  assert.match(skillMd, /\ndescription:\s*/i, "Frontmatter must declare description");

  // Multi-agent discovery compatibility: Claude Code, OpenCode, Pi, Antigravity/Codex/Cursor
  const claudeSkill = path.join(PROJECT_ROOT, ".claude", "skills", "twinklebot-e2e", "SKILL.md");
  const piSkill = path.join(PROJECT_ROOT, ".pi", "skills", "twinklebot-e2e", "SKILL.md");
  const opencodeCmd = path.join(PROJECT_ROOT, ".opencode", "commands", "twinklebot-e2e.md");
  const piPrompt = path.join(PROJECT_ROOT, ".pi", "prompts", "twinklebot-e2e.md");
  const agentsMd = path.join(PROJECT_ROOT, "AGENTS.md");
  const claudeMd = path.join(PROJECT_ROOT, "CLAUDE.md");
  const preCommit = path.join(PROJECT_ROOT, ".githooks", "pre-commit");

  assert.equal(fs.realpathSync(claudeSkill), fs.realpathSync(skillMdPath), ".claude/skills must resolve to canonical .agents/skills");
  assert.equal(fs.realpathSync(piSkill), fs.realpathSync(skillMdPath), ".pi/skills must resolve to canonical .agents/skills");
  assert.ok(fs.existsSync(opencodeCmd), "OpenCode slash command .opencode/commands/twinklebot-e2e.md must exist");
  assert.match(fs.readFileSync(opencodeCmd, "utf8"), /\.agents\/skills\/twinklebot-e2e\/SKILL\.md/);
  assert.ok(fs.existsSync(piPrompt), "Pi slash prompt .pi/prompts/twinklebot-e2e.md must exist");
  assert.match(fs.readFileSync(piPrompt, "utf8"), /\.agents\/skills\/twinklebot-e2e\/SKILL\.md/);
  assert.match(fs.readFileSync(agentsMd, "utf8"), /twinklebot-e2e/);
  assert.match(fs.readFileSync(claudeMd, "utf8"), /@AGENTS\.md/);
  assert.ok(fs.existsSync(preCommit), ".githooks/pre-commit must exist");
});

test("references/catalog.json stays 100% synchronized with all 12 E2E suites and 82 atomic cases", async () => {
  const { loadCatalog, validateCatalog } = await loadSyncModule();
  const catalog = loadCatalog();
  const check = validateCatalog(catalog, PROJECT_ROOT);

  assert.equal(check.ok, true, `Catalog validation failed: ${check.errors.join("; ")}`);
  assert.equal(check.suiteCount, 12);
  assert.ok(check.caseCount >= 82, `Expected >= 82 atomic cases, got ${check.caseCount}`);

  // Also ensure test-plan.md mentions every case ID in catalog.json
  const planText = fs.readFileSync(path.join(SKILL_DIR, "references", "test-plan.md"), "utf8");
  for (const suite of catalog.suites) {
    for (const c of suite.cases) {
      assert.ok(planText.includes(c.id), `references/test-plan.md is missing case ID ${c.id}`);
    }
  }
});

test("check-e2e-sync detects unmapped new features and resolves affected E2E suites accurately", async () => {
  const { loadCatalog, analyzeE2ESync } = await loadSyncModule();
  const catalog = loadCatalog();

  // 1. Modifying an existing mapped source file resolves targeted suites without false drift alarm
  const targeted = analyzeE2ESync({
    catalog,
    changes: [{ status: "M", file: "src/agent/providers/gemini-driver.ts" }],
    diffText: "",
    projectRoot: PROJECT_ROOT,
  });
  assert.equal(targeted.integrity.ok, true);
  assert.equal(targeted.needsE2EUpdate, false);
  assert.ok(
    targeted.affectedSuites.some((s: any) => s.id === "p0-onboarding-and-chat"),
    "Changing gemini-driver.ts must map to p0-onboarding-and-chat"
  );

  // 2. Adding a brand-new unmapped route file & API endpoint triggers E2E sync reminder
  const drift = analyzeE2ESync({
    catalog,
    changes: [
      { status: "A", file: "src/server/routes/brand-new-feature.ts" },
      { status: "M", file: "src/server/routes/system.ts" },
    ],
    diffText: [
      "+++ b/src/server/routes/system.ts",
      '+if (method === "POST" && pathname === "/api/system/brand-new-endpoint") {',
    ].join("\n"),
    projectRoot: PROJECT_ROOT,
  });
  assert.equal(drift.needsE2EUpdate, true);
  assert.equal(drift.unmappedNewFiles.length, 1);
  assert.equal(drift.unmappedNewFiles[0].file, "src/server/routes/brand-new-feature.ts");
  assert.ok(
    drift.addedSymbols.addedRoutes.some((r: string) => r.includes("/api/system/brand-new-endpoint")),
    "Must detect newly added API route literal"
  );

  // 3. If the same diff also updates test/e2e/ and only modifies mapped files, no sync alarm fires
  const synced = analyzeE2ESync({
    catalog,
    changes: [
      { status: "M", file: "src/server/routes/system.ts" },
      { status: "M", file: "test/e2e/p2-settings-vault-and-permissions.e2e.ts" },
    ],
    diffText: [
      "+++ b/src/server/routes/system.ts",
      '+if (method === "POST" && pathname === "/api/system/brand-new-endpoint") {',
    ].join("\n"),
    projectRoot: PROJECT_ROOT,
  });
  assert.equal(synced.touchedE2E, true);
  assert.equal(synced.needsE2EUpdate, false);
});

test("generate-report writes latest.md, timestamped report, and optional docs archive", async (t) => {
  const { writeReports } = await loadReportModule();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tb-e2e-rep-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const summaryPath = path.join(tmpRoot, "test-results", "e2e-summary.json");
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({
      generatedAt: "2026-11-19T06:30:00.000Z",
      total: 2,
      byStatus: { PASS: 1, BUG: 1, UX_DESIGN: 0, ENV_SKIP: 0 },
      byPriority: {
        P0: { total: 2, PASS: 1, BUG: 1, UX_DESIGN: 0, ENV_SKIP: 0 },
      },
      records: [
        {
          id: "P0-ONB-01",
          priority: "P0",
          featureTier: "F1",
          difficulty: "D1",
          title: "Onboarding init",
          module: "Onboarding",
          status: "PASS",
          durationMs: 120,
        },
        {
          id: "P0-GEM-01",
          priority: "P0",
          featureTier: "F1",
          difficulty: "D2",
          title: "Gemini outputs check",
          module: "Gemini Driver",
          suite: "p0-onboarding-and-chat",
          status: "BUG",
          durationMs: 95,
          error: "Empty text returned",
          evidenceDir: path.join(tmpRoot, "test-results", "evidence", "P0-GEM-01"),
        },
      ],
    }),
    "utf8"
  );

  const out = writeReports({
    projectRoot: tmpRoot,
    summaryPath,
    reportDir: path.join(tmpRoot, "test-results", "reports"),
    archive: true,
    tier: "p0",
    now: "2026-11-19T15:10:00+08:00",
  });

  assert.ok(fs.existsSync(out.latestPath), "latest.md must be written");
  assert.ok(fs.existsSync(out.stampedPath), "timestamped report must be written");
  assert.ok(out.archivePath && fs.existsSync(out.archivePath), "archived report must be written");

  const latestText = fs.readFileSync(out.latestPath, "utf8");
  assert.match(latestText, /P0-ONB-01/);
  assert.match(latestText, /P0-GEM-01/);
  assert.match(latestText, /test-results\/evidence\/P0-GEM-01\//);

  const archiveText = fs.readFileSync(out.archivePath!, "utf8");
  assert.match(archiveText, /归档快照/);
  assert.ok(!archiveText.includes("test-results/evidence/P0-GEM-01/"), "Archive snapshot must stay self-contained without local gitignored paths");
});

test("GitHub Release workflow and rules enforce interactive E2E level gate (default affected+p0) and silence on small local edits", async () => {
  const { spawnSync } = await import("node:child_process");

  const releaseYml = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(releaseYml, /e2e_level:/, "release.yml must expose e2e_level input");
  assert.match(releaseYml, /default:\s*"affected\+p0"/, "release.yml e2e_level must default to affected+p0");
  for (const level of ["affected+p0", "all", "p0+p1", "p0", "affected", "skip"]) {
    assert.ok(releaseYml.includes(`- ${level}`), `release.yml must support e2e_level option '${level}'`);
  }
  assert.match(releaseYml, /release-e2e:/, "release.yml must include release-e2e pre-release gate job");

  const ruleText = fs.readFileSync(
    path.join(PROJECT_ROOT, ".agents", "rules", "twinklebot-e2e-sync.md"),
    "utf8"
  );
  assert.match(ruleText, /affected\+p0/);
  assert.match(ruleText, /DO NOT/i);
  assert.ok(fs.existsSync(path.join(PROJECT_ROOT, ".githooks", "pre-push")), ".githooks/pre-push must exist");

  // Verify scripts/run-e2e.mjs --tier=skip exits 0 immediately
  const skipRun = spawnSync(
    process.execPath,
    [path.join(PROJECT_ROOT, "scripts", "run-e2e.mjs"), "--tier=skip"],
    { cwd: PROJECT_ROOT, encoding: "utf8" }
  );
  assert.equal(skipRun.status, 0, `Expected --tier=skip to exit 0, got ${skipRun.status}: ${skipRun.stderr}`);
  assert.match(skipRun.stdout, /skipping automated E2E/i);
});
