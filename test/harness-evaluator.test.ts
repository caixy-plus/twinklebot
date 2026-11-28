import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignAnonymousLabels,
  scoreDeterministicMetrics,
  judgeContrastivePair,
  runHarnessBenchmarkSuite,
  renderHarnessEvalMarkdown,
} from "../src/agent/harness-evaluator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

test("eval/harness-bench.json contains 16 valid sanitized cases without secret leaks", () => {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, "eval", "harness-bench.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.cases.length, 16);
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(raw), false);
  for (const c of parsed.cases) {
    assert.ok(c.id && c.category && c.prompt && Array.isArray(c.hardChecks));
  }
});

test("assignAnonymousLabels is deterministic per caseId+seed and shuffles both positions across cases", () => {
  const a1 = assignAnonymousLabels("HB-01", "seed-1");
  const a2 = assignAnonymousLabels("HB-01", "seed-1");
  assert.deepEqual(a1, a2);

  let aIsCandidate = 0;
  for (let i = 1; i <= 16; i++) {
    const m = assignAnonymousLabels(`HB-${String(i).padStart(2, "0")}`, "seed-1");
    assert.notEqual(m.A, m.B);
    if (m.A === "candidate") aIsCandidate += 1;
  }
  assert.ok(aIsCandidate > 0 && aIsCandidate < 16, "Shuffle must produce both A=candidate and A=base");
});

test("judgeContrastivePair supports deterministic mode, anonymized LLM reverse-mapping, and hard safety overrides", async () => {
  const baseRun = {
    label: "base",
    output: "Done with 2 errors",
    steps: 4,
    toolErrors: 2,
    estimatedUsd: 0.03,
    hardChecksPassed: true,
  };
  const betterCandidate = {
    label: "candidate",
    output: "Clean completion",
    steps: 2,
    toolErrors: 0,
    estimatedUsd: 0.01,
    hardChecksPassed: true,
  };

  assert.ok(scoreDeterministicMetrics(betterCandidate) > scoreDeterministicMetrics(baseRun));

  const det = await judgeContrastivePair({
    caseId: "HB-01",
    taskPrompt: "Summarize report",
    baseRun,
    candidateRun: betterCandidate,
    mode: "deterministic",
    seed: "s1",
  });
  assert.equal(det.winner, "candidate");
  assert.equal(det.metricDelta.stepsDelta, -2);
  assert.equal(det.metricDelta.errorsDelta, -2);

  // LLM mode: reverse-map anonymized A/B without leaking labels
  const idMap = assignAnonymousLabels("HB-02", "s2");
  const expectedAnonForCandidate = idMap.A === "candidate" ? "A" : "B";
  let capturedSystem = "";
  let capturedPrompt = "";
  const llm = await judgeContrastivePair({
    caseId: "HB-02",
    taskPrompt: "Summarize report",
    baseRun,
    candidateRun: betterCandidate,
    mode: "llm",
    seed: "s2",
    model: {
      summarizeTurn: async ({ systemInstruction, input }: any) => {
        capturedSystem = systemInstruction;
        capturedPrompt = input?.[0]?.content?.[0]?.text || "";
        return {
          text: JSON.stringify({
            winner: expectedAnonForCandidate,
            reason: "Fewer errors and clearer output",
            regressions: [],
          }),
        };
      },
    } as any,
  });
  assert.match(capturedSystem, /ANSWER_FREE/);
  assert.match(capturedSystem, /EVIDENCE_BOUNDARY/);
  assert.equal(capturedPrompt.includes("### Candidate base"), false);
  assert.equal(llm.winner, "candidate");
  assert.equal(llm.anonWinner, expectedAnonForCandidate);

  // Safety hard gate overrides even if LLM would pick candidate
  const unsafeCandidate = {
    ...betterCandidate,
    policyViolations: 1,
    leakedSecrets: true,
  };
  const blocked = await judgeContrastivePair({
    caseId: "HB-03",
    taskPrompt: "Read file",
    baseRun,
    candidateRun: unsafeCandidate,
    mode: "llm",
    model: {
      summarizeTurn: async () => ({ text: '{"winner":"A","reason":"looks good"}' }),
    } as any,
  });
  assert.equal(blocked.winner, "base");
  assert.ok(blocked.regressions.length >= 2);
});

test("runHarnessBenchmarkSuite aggregates stats and renders markdown report", async () => {
  const report = await runHarnessBenchmarkSuite({
    benchCases: [
      { id: "C1", category: "test", title: "Case 1", prompt: "p1" },
      { id: "C2", category: "test", title: "Case 2", prompt: "p2" },
    ],
    runBaseline: () => ({
      label: "base",
      output: "ok",
      steps: 4,
      toolErrors: 1,
      estimatedUsd: 0.02,
      hardChecksPassed: true,
    }),
    runCandidate: () => ({
      label: "cand",
      output: "ok",
      steps: 2,
      toolErrors: 0,
      estimatedUsd: 0.01,
      hardChecksPassed: true,
    }),
    mode: "deterministic",
  });
  assert.equal(report.total, 2);
  assert.equal(report.candidateWins, 2);
  assert.equal(report.winRate, 100);
  const md = renderHarnessEvalMarkdown(report);
  assert.match(md, /综合胜率 \*\*100%\*\*/);
  assert.match(md, /\| C1 \|/);
});
