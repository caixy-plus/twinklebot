#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PROJECT_ROOT = path.resolve(SKILL_ROOT, "..", "..", "..");

function gitInfo(cwd) {
  const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  return {
    sha: rev.status === 0 ? rev.stdout.trim() : "unknown",
    branch: branch.status === 0 ? branch.stdout.trim() : "unknown",
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTimestamps(date = new Date()) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return {
    human: `${y}-${m}-${d} ${hh}:${mm}:${ss}`,
    fileStamp: `${y}${m}${d}-${hh}${mm}${ss}`,
    dateOnly: `${y}-${m}-${d}`,
  };
}

function statusBadge(status) {
  switch (status) {
    case "PASS":
      return "✅ PASS";
    case "BUG":
      return "🐞 BUG";
    case "UX_DESIGN":
      return "💡 UX_DESIGN";
    case "ENV_SKIP":
      return "⏭️ ENV_SKIP";
    default:
      return String(status || "UNKNOWN");
  }
}

export function generateMarkdownReport(summary, opts = {}) {
  const projectRoot = opts.projectRoot || DEFAULT_PROJECT_ROOT;
  const isArchive = Boolean(opts.isArchive);
  const tierLabel = opts.tier || "all / aggregated";
  const git = opts.git || gitInfo(projectRoot);
  const ts = formatTimestamps(opts.now ? new Date(opts.now) : new Date());

  const records = Array.isArray(summary?.records) ? summary.records : [];
  const byPriority = summary?.byPriority || {};
  const byStatus = summary?.byStatus || {
    PASS: records.filter((r) => r.status === "PASS").length,
    BUG: records.filter((r) => r.status === "BUG").length,
    UX_DESIGN: records.filter((r) => r.status === "UX_DESIGN").length,
    ENV_SKIP: records.filter((r) => r.status === "ENV_SKIP").length,
  };

  const lines = [
    "# TwinkleBot 分级 E2E 测试与缺陷诊断报告",
    "",
    `- **生成时间**: \`${ts.human}\``,
    `- **Git 提交**: \`${git.branch}\` @ \`${git.sha}\``,
    `- **执行范围**: \`${tierLabel}\``,
    `- **报告类型**: ${isArchive ? "归档快照（docs/e2e-reports，已剥离本机临时截图路径依赖）" : "工作区运行报告（详细截图与 JSON 现场位于 `test-results/evidence/<case-id>/`）"}`,
    "",
    "---",
    "",
    "## 一、执行总览仪表盘",
    "",
    "| 优先级 | 总用例数 | ✅ PASS | 🐞 BUG | 💡 UX_DESIGN | ⏭️ ENV_SKIP |",
    "| :--- | :---: | :---: | :---: | :---: | :---: |",
  ];

  for (const p of ["P0", "P1", "P2", "P3"]) {
    const row = byPriority[p] || {
      total: records.filter((r) => r.priority === p).length,
      PASS: records.filter((r) => r.priority === p && r.status === "PASS").length,
      BUG: records.filter((r) => r.priority === p && r.status === "BUG").length,
      UX_DESIGN: records.filter((r) => r.priority === p && r.status === "UX_DESIGN").length,
      ENV_SKIP: records.filter((r) => r.priority === p && r.status === "ENV_SKIP").length,
    };
    lines.push(
      `| **${p}** | **${row.total}** | ${row.PASS} | ${row.BUG} | ${row.UX_DESIGN} | ${row.ENV_SKIP} |`
    );
  }
  lines.push(
    `| **合计** | **${records.length}** | **${byStatus.PASS || 0}** | **${byStatus.BUG || 0}** | **${byStatus.UX_DESIGN || 0}** | **${byStatus.ENV_SKIP || 0}** |`
  );
  lines.push("");

  const bugRecords = records.filter((r) => r.status === "BUG");
  const uxRecords = records.filter((r) => r.status === "UX_DESIGN");

  lines.push("---", "", "## 二、失败项诊断明细 (`BUG`)", "");
  if (bugRecords.length === 0) {
    lines.push("🎉 本轮未发现 `BUG` 级别失败项。", "");
  } else {
    bugRecords.forEach((r, idx) => {
      lines.push(`### \`[BUG-${pad2(idx + 1)}]\` ${r.id} — ${r.title}`);
      lines.push(`- **维度 / 套件**：\`${r.priority}\` · \`${r.featureTier}×${r.difficulty}\` · \`${r.suite || r.module}\``);
      lines.push(`- **错误信息**：\`${String(r.error || "Unknown error").split("\n")[0]}\``);
      if (!isArchive && r.evidenceDir) {
        const relEv = path.relative(projectRoot, r.evidenceDir).replace(/\\/g, "/");
        lines.push(`- **证据目录**：\`${relEv}/\``);
      }
      if (r.extraEvidence && Object.keys(r.extraEvidence).length > 0) {
        const preview = JSON.stringify(r.extraEvidence).slice(0, 320);
        lines.push(`- **附加证据摘要**：\`${preview}\``);
      }
      lines.push("");
    });
  }

  lines.push("---", "", "## 三、体验与契约瑕疵 (`UX_DESIGN`)", "");
  if (uxRecords.length === 0) {
    lines.push("本轮无新增 `UX_DESIGN` 记录。", "");
  } else {
    lines.push("| 用例 ID | 维度 | 模块 | 现象 / 建议 |");
    lines.push("| :--- | :---: | :--- | :--- |");
    for (const r of uxRecords) {
      lines.push(
        `| \`${r.id}\` | \`${r.featureTier}×${r.difficulty}\` | ${r.module || "-"} | ${String(r.error || r.title).replace(/\|/g, "\\|")} |`
      );
    }
    lines.push("");
  }

  lines.push("---", "", "## 四、原子用例逐条执行明细", "");
  lines.push("| 优先级 | 用例 ID | 维度 | 状态 | 耗时 | 模块 | 用例标题 |");
  lines.push("| :---: | :--- | :---: | :---: | :---: | :--- | :--- |");
  for (const r of records) {
    const dur = typeof r.durationMs === "number" ? `${r.durationMs}ms` : "-";
    const safeTitle = String(r.title || "").replace(/\|/g, "\\|");
    const safeMod = String(r.module || "-").replace(/\|/g, "\\|");
    lines.push(
      `| **${r.priority}** | \`${r.id}\` | \`${r.featureTier}×${r.difficulty}\` | ${statusBadge(r.status)} | ${dur} | ${safeMod} | ${safeTitle} |`
    );
  }
  lines.push("");

  return { markdown: lines.join("\n"), timestamps: ts };
}

export function writeReports({
  projectRoot = DEFAULT_PROJECT_ROOT,
  summaryPath = path.join(projectRoot, "test-results", "e2e-summary.json"),
  reportDir = path.join(projectRoot, "test-results", "reports"),
  archive = false,
  archivePath = "",
  tier = "aggregated",
  now,
} = {}) {
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Summary JSON not found: ${summaryPath} (run an E2E tier first)`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const { markdown, timestamps } = generateMarkdownReport(summary, {
    projectRoot,
    tier,
    isArchive: false,
    now,
  });

  fs.mkdirSync(reportDir, { recursive: true });
  const stampedPath = path.join(reportDir, `e2e-report-${timestamps.fileStamp}.md`);
  const latestPath = path.join(reportDir, "latest.md");
  fs.writeFileSync(stampedPath, markdown, "utf8");
  fs.writeFileSync(latestPath, markdown, "utf8");

  let writtenArchivePath = null;
  if (archive || archivePath) {
    const targetArchive = archivePath
      ? path.isAbsolute(archivePath)
        ? archivePath
        : path.join(projectRoot, archivePath)
      : path.join(projectRoot, "docs", "e2e-reports", `${timestamps.dateOnly}-e2e-report.md`);
    fs.mkdirSync(path.dirname(targetArchive), { recursive: true });
    const archived = generateMarkdownReport(summary, {
      projectRoot,
      tier,
      isArchive: true,
      now,
    });
    fs.writeFileSync(targetArchive, archived.markdown, "utf8");
    writtenArchivePath = targetArchive;
  }

  return {
    stampedPath,
    latestPath,
    archivePath: writtenArchivePath,
    total: Array.isArray(summary.records) ? summary.records.length : 0,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const summaryArg = argv.find((a) => a.startsWith("--summary="));
  const tierArg = argv.find((a) => a.startsWith("--tier="));
  const archiveEq = argv.find((a) => a.startsWith("--archive="));
  const archiveFlag = argv.includes("--archive") || Boolean(archiveEq);

  const res = writeReports({
    projectRoot: DEFAULT_PROJECT_ROOT,
    summaryPath: summaryArg
      ? path.resolve(DEFAULT_PROJECT_ROOT, summaryArg.slice("--summary=".length))
      : undefined,
    tier: tierArg ? tierArg.slice("--tier=".length) : "aggregated",
    archive: archiveFlag,
    archivePath: archiveEq ? archiveEq.slice("--archive=".length) : "",
  });

  console.log(`[e2e:report] Generated ${res.total}-case report:`);
  console.log(`  - ${path.relative(DEFAULT_PROJECT_ROOT, res.stampedPath)}`);
  console.log(`  - ${path.relative(DEFAULT_PROJECT_ROOT, res.latestPath)}`);
  if (res.archivePath) {
    console.log(`  - [archived] ${path.relative(DEFAULT_PROJECT_ROOT, res.archivePath)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
