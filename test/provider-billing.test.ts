import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";
import {
  fetchDeepSeekBalance,
  normalizeProviderBillingMap,
  resolveDeepSeekBalanceUrl,
} from "../src/lib/provider-billing.js";
import { USD_TO_CNY } from "../src/agent/pricing.js";

test("resolveDeepSeekBalanceUrl normalizes baseUrl cleanly and fetchDeepSeekBalance parses CNY/USD infos", async () => {
  assert.equal(resolveDeepSeekBalanceUrl(""), "https://api.deepseek.com/user/balance");
  assert.equal(
    resolveDeepSeekBalanceUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/user/balance"
  );
  assert.equal(
    resolveDeepSeekBalanceUrl("http://127.0.0.1:18080/proxy/v1/"),
    "http://127.0.0.1:18080/proxy/user/balance"
  );

  let seenUrl = "";
  let seenAuth = "";
  const mockFetch: any = async (url: string, init: any) => {
    seenUrl = url;
    seenAuth = init?.headers?.Authorization || "";
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: "65.91",
              granted_balance: "10.00",
              topped_up_balance: "55.91",
            },
          ],
        });
      },
    };
  };

  const res = await fetchDeepSeekBalance(
    {
      id: "ds-1",
      type: "deepseek",
      name: "DeepSeek",
      apiKey: "sk-test-ds",
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-chat"],
      imageModels: [],
      billingCurrency: "CNY",
      enabled: true,
    },
    { fetchImpl: mockFetch }
  );

  assert.equal(seenUrl, "https://api.deepseek.com/user/balance");
  assert.equal(seenAuth, "Bearer sk-test-ds");
  assert.equal(res.available, true);
  assert.equal(res.currency, "CNY");
  assert.equal(res.totalNative, 65.91);
  assert.equal(res.grantedNative, 10);
  assert.equal(res.toppedUpNative, 55.91);
});

test("legacy settings.googleBilling migrates once to first USD calibrated provider", () => {
  const providers: any[] = [
    {
      id: "ds-1",
      type: "deepseek",
      name: "DeepSeek",
      apiKey: "sk-ds",
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-chat"],
      imageModels: [],
      billingCurrency: "CNY",
      enabled: true,
    },
    {
      id: "gem-1",
      type: "gemini",
      name: "Google Gemini",
      apiKey: "sk-gem",
      baseUrl: "",
      models: ["gemini-4-argon"],
      imageModels: [],
      billingCurrency: "USD",
      enabled: true,
    },
  ];
  const migrated = normalizeProviderBillingMap(
    {
      googleBilling: {
        baselineRemainingUsd: 100,
        baselineTotalCreditsUsd: 300,
        baselineWorkspaceSpentUsd: 5,
        calibratedAt: 1794700000000,
      },
    },
    providers
  );
  assert.equal(migrated["gem-1"].currency, "USD");
  assert.equal(migrated["gem-1"].baselineRemainingNative, 100);
  assert.equal(migrated["gem-1"].baselineTotalCreditsNative, 300);
  assert.equal(migrated["gem-1"].baselineProviderSpentNative, 5);
  assert.equal(migrated["ds-1"].mode, "live_api");
  assert.equal(migrated["ds-1"].autoRefreshMinutes, 15);
});

test("HTTP provider billing endpoints: DeepSeek live refresh, cache on error, schedule, RMB calibration, merged RMB total, and hiding disabled providers", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-prov-billing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);

  const providers = [
    {
      id: "ds-main",
      type: "deepseek",
      name: "DeepSeek 主力",
      apiKey: "sk-ds-live",
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-chat", "deepseek-reasoner"],
      imageModels: [],
      billingCurrency: "CNY",
      enabled: true,
    },
    {
      id: "gem-main",
      type: "gemini",
      name: "Google Gemini",
      apiKey: "sk-gem-live",
      baseUrl: "",
      models: ["gemini-4-argon"],
      imageModels: [],
      billingCurrency: "USD",
      enabled: true,
    },
    {
      id: "oa-disabled",
      type: "openai",
      name: "OpenAI (已禁用)",
      apiKey: "sk-oa-disabled",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o"],
      imageModels: [],
      billingCurrency: "USD",
      enabled: false,
    },
  ];
  store.writeSettings({ providers });

  const s = store.createSession({ title: "工作台 Bot", model: "deepseek-chat" });
  store.updateSession(s.id, {
    usage: { input: 1_600_000, output: 500_000 },
    usageByProviderModel: {
      // deepseek-chat: 1M uncached * 2 + 0.5M * 8 = 6.00 CNY
      "ds-main::deepseek-chat": { input: 1_000_000, output: 500_000, calls: 2 },
      // gemini-4-argon: 500k input * $2/M = $1.00 = 7.25 CNY
      "gem-main::gemini-4-argon": { input: 500_000, output: 0, calls: 1 },
      // disabled provider spend: gpt-4o 100k input * $2.5/M = $0.25 = 1.8125 CNY (should be hidden!)
      "oa-disabled::gpt-4o": { input: 100_000, output: 0, calls: 1 },
    },
  });

  let dsFailMode = false;
  let dsBalanceValue = "65.91";
  const mockBillingFetch: any = async (url: string) => {
    if (!url.includes("/user/balance")) {
      throw new Error(`unexpected url: ${url}`);
    }
    if (dsFailMode) {
      return {
        ok: false,
        status: 500,
        async text() {
          return JSON.stringify({ error: { message: "upstream timeout" } });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "CNY",
              total_balance: dsBalanceValue,
              granted_balance: "5.91",
              topped_up_balance: "60.00",
            },
          ],
        });
      },
    };
  };

  const server = createServer({
    config: { host: "127.0.0.1", port: 0, dataDir: dir, writeRoots: [dir] },
    store,
    billingFetchImpl: mockBillingFetch,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  // 1. Usage filters out disabled provider oa-disabled (shows only 6.00 + 7.25 = 13.25 CNY)
  const usageRes = await fetch(`${base}/api/usage`).then((r) => r.json());
  assert.equal(usageRes.estimatedCostCny, 13.25);
  assert.equal(usageRes.byProvider.length, 2);
  assert.ok(!usageRes.byProvider.some((p: any) => p.providerId === "oa-disabled"));

  // 2. Initial billing summary shows only 2 enabled providers
  const initialSummary = await fetch(`${base}/api/billing/summary`).then((r) => r.json());
  assert.equal(initialSummary.providers.length, 2);
  assert.equal(initialSummary.merged.hasAnyBalance, false);

  // 3. Refresh DeepSeek live balance -> merged RMB = 65.91
  const dsRefreshed = await fetch(`${base}/api/billing/providers/ds-main/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  assert.equal(dsRefreshed.ok, true);
  assert.equal(dsRefreshed.provider.remainingCny, 65.91);
  assert.equal(dsRefreshed.merged.remainingCny, 65.91);

  // 4. Calibrate Gemini in RMB (¥100.00) -> merged RMB = 65.91 + 100.00 = 165.91
  const gemCalibrated = await fetch(`${base}/api/billing/providers/gem-main/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "set", amountCny: 100, totalCreditsCny: 200 }),
  }).then((r) => r.json());
  assert.equal(gemCalibrated.ok, true);
  assert.equal(gemCalibrated.merged.remainingCny, 165.91);
  assert.equal(gemCalibrated.merged.providersWithBalanceCount, 2);

  // Additional Gemini spend ($1.00 = ¥7.25) auto-deducts from ¥100 -> ¥92.75
  store.updateSession(s.id, {
    usage: { input: 2_100_000, output: 500_000 },
    usageByProviderModel: {
      "ds-main::deepseek-chat": { input: 1_000_000, output: 500_000, calls: 2 },
      "gem-main::gemini-4-argon": { input: 1_000_000, output: 0, calls: 2 },
      "oa-disabled::gpt-4o": { input: 100_000, output: 0, calls: 1 },
    },
  });
  const afterSpendSummary = await fetch(`${base}/api/billing/summary`).then((r) => r.json());
  const gemCardAfter = afterSpendSummary.providers.find((p: any) => p.providerId === "gem-main");
  assert.equal(gemCardAfter.remainingCny, 92.75);
  assert.equal(afterSpendSummary.merged.remainingCny, Math.round((65.91 + 92.75) * 100) / 100);

  // 5. Update auto-refresh schedule -> rejects invalid, persists valid 30m
  const badSched = await fetch(`${base}/api/billing/providers/ds-main/schedule`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoRefreshMinutes: 7 }),
  });
  assert.equal(badSched.status, 400);

  const okSched = await fetch(`${base}/api/billing/providers/ds-main/schedule`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoRefreshMinutes: 30 }),
  }).then((r) => r.json());
  assert.equal(okSched.providers.find((p: any) => p.providerId === "ds-main").autoRefreshMinutes, 30);

  // 6. Upstream failure preserves last cached 65.91 RMB and records lastError
  dsFailMode = true;
  const failRefresh = await fetch(`${base}/api/billing/providers/ds-main/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  assert.equal(failRefresh.ok, false);
  assert.equal(failRefresh.provider.remainingCny, 65.91);
  assert.match(failRefresh.provider.lastError, /500/);

  // 7. Disabling gem-main removes its usage & balance from both /api/usage and /api/billing/summary
  await fetch(`${base}/api/providers/gem-main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  const usageOnlyDs = await fetch(`${base}/api/usage`).then((r) => r.json());
  assert.equal(usageOnlyDs.estimatedCostCny, 6);
  const summaryOnlyDs = await fetch(`${base}/api/billing/summary`).then((r) => r.json());
  assert.equal(summaryOnlyDs.providers.length, 1);
  assert.equal(summaryOnlyDs.merged.remainingCny, 65.91);

  // Re-enabling gem-main restores both usage and calibrated balance immediately
  await fetch(`${base}/api/providers/gem-main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  const summaryRestored = await fetch(`${base}/api/billing/summary`).then((r) => r.json());
  assert.equal(summaryRestored.providers.length, 2);
  assert.equal(summaryRestored.providers.find((p: any) => p.providerId === "gem-main").remainingCny, 92.75);
});
