import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import {
  buildBillingBalanceSummary,
  applyBalanceCalibration,
  computeCalibratedBalance,
  normalizeGoogleBillingSettings,
} from "../src/lib/gcp-billing.js";

test("computeCalibratedBalance deducts incremental workspace spend since calibration", () => {
  const cal = normalizeGoogleBillingSettings({
    baselineRemainingUsd: 280.0,
    baselineTotalCreditsUsd: 300,
    baselineWorkspaceSpentUsd: 2.5,
    calibratedAt: 1794550000000,
  });

  const bal = computeCalibratedBalance(cal, 3.75);
  assert.equal(bal.calibrated, true);
  assert.equal(bal.deltaSinceCalibrationUsd, 1.25);
  assert.equal(bal.estimatedRemainingUsd, 278.75);
  assert.equal(bal.remainingPct, 92.9);

  const clamped = computeCalibratedBalance(cal, 500);
  assert.equal(clamped.estimatedRemainingUsd, 0);
  assert.equal(clamped.remainingPct, 0);
});

test("applyBalanceCalibration supports set (直接修改), add (+), sub (-), and clear", () => {
  // Subtracting before calibration fails clearly
  assert.throws(
    () =>
      applyBalanceCalibration({
        currentSettings: {},
        workspaceEstimatedCostUsd: 1,
        mode: "sub",
        amountUsd: 5,
      }),
    /尚未设置初始余额/
  );

  // Direct set at $2.00 workspace spend -> baselineRemainingUsd = $290
  const setCal = applyBalanceCalibration({
    currentSettings: {},
    workspaceEstimatedCostUsd: 2.0,
    mode: "set",
    amountUsd: 290,
    baselineTotalCreditsUsd: 300,
    now: 1000,
  });
  assert.equal(setCal.baselineRemainingUsd, 290);
  assert.equal(setCal.baselineWorkspaceSpentUsd, 2);
  assert.equal(setCal.baselineTotalCreditsUsd, 300);

  // Workspace spends another $3.00 (total $5.00), so current remaining is $287.00.
  // Adding +$20 should yield $307.00 and rebase baselineWorkspaceSpentUsd to $5.00.
  const addCal = applyBalanceCalibration({
    currentSettings: setCal,
    workspaceEstimatedCostUsd: 5.0,
    mode: "add",
    amountUsd: 20,
    now: 2000,
  });
  assert.equal(addCal.baselineRemainingUsd, 307);
  assert.equal(addCal.baselineWorkspaceSpentUsd, 5);

  // Workspace spends another $1.50 (total $6.50) -> remaining is $305.50.
  // Subtracting -$5.50 should yield $300.00 and rebase baselineWorkspaceSpentUsd to $6.50.
  const subCal = applyBalanceCalibration({
    currentSettings: addCal,
    workspaceEstimatedCostUsd: 6.5,
    mode: "sub",
    amountUsd: 5.5,
    now: 3000,
  });
  assert.equal(subCal.baselineRemainingUsd, 300);
  assert.equal(subCal.baselineWorkspaceSpentUsd, 6.5);

  // Build summary reflects instant calculation without external CLI
  const summary = buildBillingBalanceSummary({
    settings: { googleBilling: subCal },
    workspaceEstimatedCostUsd: 8.5,
  });
  assert.equal(summary.mode, "local_calibrated");
  assert.equal(summary.balance.deltaSinceCalibrationUsd, 2);
  assert.equal(summary.balance.estimatedRemainingUsd, 298);

  // Clear resets everything
  const cleared = applyBalanceCalibration({ clear: true });
  assert.equal(cleared.baselineRemainingUsd, null);
  assert.equal(cleared.calibratedAt, null);
});

test("HTTP GET /api/billing/gcp and POST /api/billing/gcp/calibration handle set, +, -, and workspace deduction", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-local-billing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const s = store.createSession({ title: "Nori" });
  store.updateSession(s.id, {
    usage: { input: 1_000_000, output: 0 },
    usageByModel: { "gemini-4-argon": { input: 1_000_000, output: 0, calls: 1 } },
  }); // $2.00 workspace spend

  const server = createServer({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, writeRoots: [dir] },
    store,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const getInitial = await fetch(`${base}/api/billing/gcp`).then((r) => r.json());
  assert.equal(getInitial.mode, "local_calibrated");
  assert.equal(getInitial.balance.calibrated, false);
  assert.equal(getInitial.workspaceEstimatedCostUsd, 2);

  // Reject negative amount
  const badAmount = await fetch(`${base}/api/billing/gcp/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "set", amountUsd: -5 }),
  });
  assert.equal(badAmount.status, 400);

  // Set initial balance = $295.50 at $2.00 workspace spend
  const setRes = await fetch(`${base}/api/billing/gcp/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "set", amountUsd: 295.5, baselineTotalCreditsUsd: 300 }),
  }).then((r) => r.json());
  assert.equal(setRes.balance.calibrated, true);
  assert.equal(setRes.balance.estimatedRemainingUsd, 295.5);

  // Add another $1.00 usage (500k input tokens on argon = $1.00) -> balance automatically becomes $294.50
  store.updateSession(s.id, {
    usage: { input: 1_500_000, output: 0 },
    usageByModel: { "gemini-4-argon": { input: 1_500_000, output: 0, calls: 2 } },
  });
  const afterSpend = await fetch(`${base}/api/billing/gcp`).then((r) => r.json());
  assert.equal(afterSpend.workspaceEstimatedCostUsd, 3);
  assert.equal(afterSpend.balance.deltaSinceCalibrationUsd, 1);
  assert.equal(afterSpend.balance.estimatedRemainingUsd, 294.5);

  // Calibrate + $10.00 -> $304.50
  const addRes = await fetch(`${base}/api/billing/gcp/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "add", amountUsd: 10 }),
  }).then((r) => r.json());
  assert.equal(addRes.balance.estimatedRemainingUsd, 304.5);

  // Calibrate - $4.50 -> $300.00
  const subRes = await fetch(`${base}/api/billing/gcp/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "sub", amountUsd: 4.5 }),
  }).then((r) => r.json());
  assert.equal(subRes.balance.estimatedRemainingUsd, 300);

  // Clear calibration
  const clearRes = await fetch(`${base}/api/billing/gcp/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear: true }),
  }).then((r) => r.json());
  assert.equal(clearRes.balance.calibrated, false);

  // UI exposes unified RMB merged balance + per-provider balance section (no legacy single GCP USD card)
  const { readWebSourceTs, renderFullAppHtml } = await import("./helpers/react-test-helpers.js");
  const html = renderFullAppHtml();
  const appJs = readWebSourceTs();
  assert.ok(html.includes('id="usage-merged-balance-card"'));
  assert.ok(html.includes('id="usage-provider-balance-list"'));
  assert.ok(html.includes('id="usage-refresh-all-btn"'));
  assert.ok(!html.includes('id="usage-total-cost-usd"'));
  assert.ok(!html.includes('id="usage-gcp-console-link"'));
  assert.ok(!html.includes("打开 GCP 结算台"));
  assert.ok(appJs.includes("refreshAllLiveProviderBalances"));
  assert.ok(appJs.includes("ProviderCalibrationForm"));
  assert.ok(appJs.includes("providerBillingFetchSeq"));
});
