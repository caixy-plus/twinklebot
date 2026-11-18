import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectRoute,
  markModelUnavailable,
  resetUnavailableModels,
  isModelAvailable,
  isPermanentModelError,
} from "../src/agent/router.js";
import {
  estimateModelCost,
  getModelPricing,
  isDeepSeekOffPeak,
  resolveSessionUsageByModel,
  resolveSessionUsageByProviderModel,
  buildSessionCostSummary,
  aggregateWorkspaceUsage,
  accumulateSessionUsagePatch,
  USD_TO_CNY,
} from "../src/agent/pricing.js";
import { getModelContextWindow } from "../src/shared/context-compression.js";
import { createServer } from "../src/server/index.js";
import { createStore } from "../src/store/index.js";

const BASE_CONFIG = {
  defaultModel: "gemini-4-argon",
  deepModel: "gemini-4-carbon",
  fastModel: "gemini-4-hydrogen",
  models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
};

test("3-tier router selects Hydrogen 4-gear (Low/Med/High/XHigh) for chat/desktop/attachments, Argon for Mac GUI/heavy coding, and Carbon for deep reasoning", () => {
  resetUnavailableModels();

  const fast = selectRoute({
    rawUserText: "你好，帮我看一下今天有哪些待办",
    config: BASE_CONFIG,
  });
  assert.equal(fast.tier, "fast");
  assert.equal(fast.model, "gemini-4-hydrogen");
  assert.equal(fast.thinkingLevel, "medium");
  assert.equal(fast.captureInitialScreen, false);
  assert.equal(fast.timeoutMs, 35_000);

  const routineShell = selectRoute({
    rawUserText: "帮我查一下 /var/log/caddy.log 最近的 502 错误",
    config: BASE_CONFIG,
  });
  assert.equal(routineShell.tier, "fast");
  assert.equal(routineShell.model, "gemini-4-hydrogen");
  assert.equal(routineShell.thinkingLevel, "medium");

  const desktop = selectRoute({
    rawUserText: "帮我打开浏览器并截图桌面窗口",
    config: BASE_CONFIG,
  });
  assert.equal(desktop.tier, "fast");
  assert.equal(desktop.model, "gemini-4-hydrogen");
  assert.equal(desktop.thinkingLevel, "medium");
  assert.equal(desktop.captureInitialScreen, true);
  assert.equal(desktop.timeoutMs, 35_000);

  const standardWork = selectRoute({
    rawUserText: "帮我统计服务器 Caddy 日志今日 PV/UV，并写个 Python 脚本输出报表",
    config: BASE_CONFIG,
  });
  assert.equal(standardWork.tier, "standard");
  assert.equal(standardWork.model, "gemini-4-argon");
  assert.equal(standardWork.captureInitialScreen, false);
  assert.equal(standardWork.timeoutMs, 45_000);

  const withAttachment = selectRoute({
    rawUserText: "这张图里写了什么？",
    hasAttachments: true,
    config: BASE_CONFIG,
  });
  assert.equal(withAttachment.tier, "fast");
  assert.equal(withAttachment.model, "gemini-4-hydrogen");
  assert.equal(withAttachment.thinkingLevel, "high");
  assert.equal(withAttachment.captureInitialScreen, true);
  assert.equal(withAttachment.timeoutMs, 45_000);

  const macGui = selectRoute({
    rawUserText: "用 kimi-cu 看看我 Mac 上微信和访达窗口现在是什么状态",
    config: BASE_CONFIG,
  });
  assert.equal(macGui.tier, "standard");
  assert.equal(macGui.model, "gemini-4-argon");
  assert.equal(macGui.captureInitialScreen, false);

  const deep = selectRoute({
    rawUserText: "请做一次全面排查和架构重构设计方案，对比分析三种多步计划",
    stepNo: 1,
    config: BASE_CONFIG,
  });
  assert.equal(deep.tier, "deep");
  assert.equal(deep.model, "gemini-4-carbon");
  assert.equal(deep.fallbackModel, "gemini-4-argon");
  assert.equal(deep.thinkingLevel, "high");
  assert.equal(deep.timeoutMs, 90_000);
});

test("router evaluates intent on rawUserText so group-chat/quote context never falsely triggers Carbon", () => {
  resetUnavailableModels();
  const inflatedGroupPrompt =
    "[群聊上下文]\n" + "历史对话内容很长很长……".repeat(40) + "\n用户最新发言：收到，谢谢！";

  const route = selectRoute({
    userText: inflatedGroupPrompt,
    rawUserText: "收到，谢谢！",
    config: BASE_CONFIG,
  });
  assert.equal(route.tier, "fast");
  assert.equal(route.model, "gemini-4-hydrogen");
});

test("router uses progressive ladder: Hydrogen handles steps 1-4 (incl. Ubuntu screen on Med/High), Carbon plans steps 1-2 then hands off to Argon, step 5+ / 1st error use Argon, 2nd error escalates to Carbon", () => {
  resetUnavailableModels();

  const midScreen = selectRoute({
    rawUserText: "继续下一步",
    stepNo: 2,
    hasScreenInHistory: true,
    config: BASE_CONFIG,
  });
  assert.equal(midScreen.tier, "fast");
  assert.equal(midScreen.model, "gemini-4-hydrogen");
  assert.equal(midScreen.thinkingLevel, "medium");
  assert.equal(midScreen.captureInitialScreen, false);

  const midScreenHigh = selectRoute({
    rawUserText: "继续下一步",
    stepNo: 3,
    hasScreenInHistory: true,
    config: BASE_CONFIG,
  });
  assert.equal(midScreenHigh.tier, "fast");
  assert.equal(midScreenHigh.model, "gemini-4-hydrogen");
  assert.equal(midScreenHigh.thinkingLevel, "high");

  // Hydrogen stays active on steps 1-4 for routine non-visual tasks, then upgrades to Argon on step 5+
  for (const sNo of [1, 3, 4]) {
    const fastStep = selectRoute({
      rawUserText: "帮我查个文件",
      stepNo: sNo,
      consecutiveErrors: 0,
      config: BASE_CONFIG,
    });
    assert.equal(fastStep.tier, "fast", `Expected Hydrogen on step ${sNo}`);
    assert.equal(fastStep.model, "gemini-4-hydrogen");
  }
  for (const sNo of [5, 6, 7, 9, 11]) {
    const steadyStep = selectRoute({
      rawUserText: "帮我查个文件",
      stepNo: sNo,
      consecutiveErrors: 0,
      config: BASE_CONFIG,
    });
    assert.equal(steadyStep.tier, "standard", `Expected Argon on step ${sNo}`);
    assert.equal(steadyStep.model, "gemini-4-argon");
  }

  // Deep intent uses Carbon on steps 1-2, then hands off execution to Argon (medium) on step 3+ when error-free
  const deepStep2 = selectRoute({
    rawUserText: "重构当前模块架构",
    stepNo: 2,
    consecutiveErrors: 0,
    config: BASE_CONFIG,
  });
  assert.equal(deepStep2.tier, "deep");
  assert.equal(deepStep2.model, "gemini-4-carbon");
  assert.equal(deepStep2.thinkingLevel, "high");

  const deepFollowup = selectRoute({
    rawUserText: "重构当前模块架构",
    stepNo: 3,
    consecutiveErrors: 0,
    config: BASE_CONFIG,
  });
  assert.equal(deepFollowup.tier, "standard");
  assert.equal(deepFollowup.model, "gemini-4-argon");
  assert.equal(deepFollowup.thinkingLevel, "medium");

  // 1st error recovers on Argon (medium); 2nd consecutive error escalates to Carbon (high)
  const firstError = selectRoute({
    rawUserText: "帮我查个文件",
    stepNo: 2,
    consecutiveErrors: 1,
    config: BASE_CONFIG,
  });
  assert.equal(firstError.tier, "standard");
  assert.equal(firstError.model, "gemini-4-argon");
  assert.equal(firstError.thinkingLevel, "medium");

  const secondError = selectRoute({
    rawUserText: "帮我查个文件",
    stepNo: 3,
    consecutiveErrors: 2,
    config: BASE_CONFIG,
  });
  assert.equal(secondError.tier, "deep");
  assert.equal(secondError.model, "gemini-4-carbon");
  assert.equal(secondError.thinkingLevel, "high");
});

test("circuit breaker uses TTL cooldown for transient 429/timeout and permanent block only for 404", () => {
  resetUnavailableModels();
  const t0 = 1_000_000;

  assert.equal(isPermanentModelError({ status: 429, message: "Too Many Requests" }), false);
  assert.equal(isPermanentModelError({ status: 404, message: "Model not found" }), true);

  markModelUnavailable("gemini-4-hydrogen", { permanent: false, cooldownMs: 60_000, now: t0 });
  assert.equal(isModelAvailable("gemini-4-hydrogen", t0 + 10_000), false);

  // Falls back to Argon while Hydrogen is cooling down
  const duringCooldown = selectRoute({
    rawUserText: "你好",
    config: BASE_CONFIG,
    now: t0 + 10_000,
  });
  assert.equal(duringCooldown.model, "gemini-4-argon");

  // Automatically recovers once cooldown expires
  assert.equal(isModelAvailable("gemini-4-hydrogen", t0 + 61_000), true);
  const afterCooldown = selectRoute({
    rawUserText: "你好",
    config: BASE_CONFIG,
    now: t0 + 61_000,
  });
  assert.equal(afterCooldown.model, "gemini-4-hydrogen");

  // Permanent 404 stays disabled
  markModelUnavailable("gemini-4-carbon", { permanent: true, now: t0 });
  assert.equal(isModelAvailable("gemini-4-carbon", t0 + 999_999_999), false);
  resetUnavailableModels();
});

test("pricing estimates per-model USD/CNY accurately and backfills legacy session events", () => {
  const carbonEst = estimateModelCost("models/gemini-4-carbon", {
    input: 100_000,
    cached: 40_000,
    output: 20_000,
    thoughts: 8_000,
  });
  // Uncached input: 60k * $2/1M = $0.12; Cached: 40k * $0.10/1M = $0.004; Output: 20k * $10/1M = $0.20 => $0.324
  assert.equal(carbonEst.costUsd, 0.324);
  assert.equal(carbonEst.totalTokens, 120_000);

  const hydrogenEst = estimateModelCost("models/gemini-4-hydrogen", {
    input: 100_000,
    cached: 40_000,
    output: 20_000,
    thoughts: 6_000,
  });
  // Uncached input: 60k * $1.50/1M = $0.09; Cached: 40k * $0.075/1M = $0.003; Output: 20k * $7.50/1M = $0.15 => $0.243
  assert.equal(hydrogenEst.costUsd, 0.243);
  assert.equal(hydrogenEst.totalTokens, 120_000);

  const flashEst = estimateModelCost("gemini-3.8-flash", {
    input: 200_000,
    cached: 0,
    output: 40_000,
  });
  // Legacy backfill check: 0.2M * $0.75 = $0.15; Output: 0.04M * $3.75 = $0.15 => $0.30
  assert.equal(flashEst.costUsd, 0.3);

  // Legacy session backfill from events.ndjson
  const legacySession = {
    id: "leg-1",
    title: "Nori",
    model: "gemini-4-argon",
    usage: { input: 15_000, output: 3_000 },
  };
  const legacyEvents = [
    { type: "thought", usedModel: "gemini-3.8-flash", text: "fast step" },
    { type: "usage", input: 5_000, output: 1_000 },
    { type: "thought", usedModel: "gemini-4-argon", text: "screen step" },
    { type: "usage", input: 10_000, output: 2_000 },
  ];
  const map = resolveSessionUsageByModel(legacySession, {
    readEvents: () => legacyEvents,
  });
  assert.deepEqual(map.get("gemini-3.8-flash"), {
    input: 5_000,
    output: 1_000,
    cached: 0,
    thoughts: 0,
    calls: 1,
  });
  assert.deepEqual(map.get("gemini-4-argon"), {
    input: 10_000,
    output: 2_000,
    cached: 0,
    thoughts: 0,
    calls: 1,
  });

  const agg = aggregateWorkspaceUsage({
    sessions: [legacySession],
    readEvents: () => legacyEvents,
    configuredModels: BASE_CONFIG.models,
  });
  assert.equal(agg.totalTokens, 18_000);
  // Active configured trio (Carbon, Argon, Hydrogen) + legacy backfill bucket (3.8 Flash)
  assert.equal(agg.byModel.length, 4);
  assert.ok(agg.estimatedCostUsd > 0);
  assert.ok(agg.estimatedCostCny > 0);
});

test("GET /api/usage and GET /api/sessions/:id expose per-model breakdown and cost estimates", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-billing-"));
  const store = createStore(tmpDir);
  const s = store.createSession({ title: "架构师 Bot", model: "gemini-4-argon" });
  store.updateSession(s.id, {
    usage: { input: 50_000, output: 10_000, cached: 10_000, thoughts: 4_000 },
    usageByModel: {
      "gemini-4-carbon": { input: 30_000, output: 8_000, cached: 10_000, thoughts: 4_000, calls: 2 },
      "gemini-4-hydrogen": { input: 20_000, output: 2_000, cached: 0, thoughts: 0, calls: 3 },
    },
  });

  const s2 = store.createSession({ title: "日常助手 Bot", model: "gemini-4-hydrogen" });
  store.updateSession(s2.id, {
    usage: { input: 10_000, output: 1_000 },
    usageByModel: {
      "gemini-4-hydrogen": { input: 10_000, output: 1_000, calls: 1 },
    },
  });

  const fakeRunner = {
    status: () => ({ sessionId: null, state: "idle", activeSessions: {} }),
    subscribe: () => () => {},
  };
  const srv = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      geminiApiKey: "k",
      executorUrl: "http://ubuntu.orb.local:7300",
      executorToken: "t",
      novncUrl: "http://ubuntu.orb.local:6080/vnc.html",
      ...BASE_CONFIG,
      maxSteps: 60,
      keepScreenshots: 3,
      shellTimeoutSec: 120,
      screen: { width: 1440, height: 900 },
      writeRoots: ["/tmp"],
      dataDir: tmpDir,
    },
    store,
    runner: fakeRunner,
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as any;
  try {
    const usageRes = await fetch(`http://127.0.0.1:${port}/api/usage`).then((r) => r.json());
    assert.equal(usageRes.scope, "all");
    assert.equal(usageRes.totalTokens, 71_000);
    assert.ok(usageRes.estimatedCostUsd > 0);
    assert.ok(usageRes.estimatedCostCny > 0);
    assert.equal(usageRes.byModel.length, 3);
    const carbonRow = usageRes.byModel.find((m: any) => m.model === "gemini-4-carbon");
    const hydrogenRow = usageRes.byModel.find((m: any) => m.model === "gemini-4-hydrogen");
    assert.equal(carbonRow.totalTokens, 38_000);
    assert.equal(hydrogenRow.totalTokens, 33_000);
    assert.equal(usageRes.bySession.length, 2);
    assert.equal(usageRes.bySession[0].title, "架构师 Bot");

    const scopedRes = await fetch(
      `http://127.0.0.1:${port}/api/usage?sessionId=${encodeURIComponent(s.id)}`
    ).then((r) => r.json());
    assert.equal(scopedRes.scope, "session");
    assert.equal(scopedRes.session?.id, s.id);
    assert.equal(scopedRes.session?.title, "架构师 Bot");
    assert.equal(scopedRes.totalTokens, 60_000);
    assert.equal(
      scopedRes.byModel.find((m: any) => m.model === "gemini-4-hydrogen")?.totalTokens,
      22_000
    );

    const sessionRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${s.id}`).then((r) =>
      r.json()
    );
    assert.equal(sessionRes.usageSummary.totalTokens, 60_000);
    assert.equal(sessionRes.usageSummary.byModel.length, 2);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("multi-currency pricing computes native CNY/USD accurately, sums in RMB, and filters disabled providers", () => {
  // DeepSeek uses native CNY (2 CNY/M uncached, 0.5 CNY/M cached, 8 CNY/M output)
  const dsEst = estimateModelCost("deepseek-chat", {
    input: 1_000_000,
    cached: 400_000,
    output: 500_000,
  });
  // Uncached: 0.6 * 2 = 1.2; cached: 0.4 * 0.5 = 0.2; output: 0.5 * 8 = 4.0 => 5.4 CNY
  assert.equal(dsEst.nativeCurrency, "CNY");
  assert.equal(dsEst.costNative, 5.4);
  assert.equal(dsEst.costCny, 5.4);

  // Override providerCurrency: custom CNY provider running gpt-4o-mini converts catalog USD rates cleanly
  const customMiniCny = estimateModelCost(
    "gpt-4o-mini",
    { input: 1_000_000, output: 1_000_000 },
    { providerCurrency: "CNY" }
  );
  assert.equal(customMiniCny.nativeCurrency, "CNY");
  const baseMiniUsd = 0.15 + 0.6;
  assert.equal(customMiniCny.costCny, Math.round(baseMiniUsd * USD_TO_CNY * 10000) / 10000);

  // accumulateSessionUsagePatch records exact usageByProviderModel alongside usageByModel
  let mockSession: any = { id: "s1", title: "Mix Bot", type: "single", model: "deepseek-chat" };
  mockSession = {
    ...mockSession,
    ...accumulateSessionUsagePatch(mockSession, {
      model: "deepseek-chat",
      providerId: "prov-ds",
      input: 1_000_000,
      cached: 400_000,
      output: 500_000,
    }),
  };
  mockSession = {
    ...mockSession,
    ...accumulateSessionUsagePatch(mockSession, {
      model: "gemini-4-argon",
      providerId: "prov-gem",
      input: 500_000, // $1.00 => ¥7.25
      output: 0,
    }),
  };
  assert.ok(mockSession.usageByProviderModel["prov-ds::deepseek-chat"]);
  assert.ok(mockSession.usageByProviderModel["prov-gem::gemini-4-argon"]);

  const providers: any[] = [
    {
      id: "prov-ds",
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
      id: "prov-gem",
      type: "gemini",
      name: "Google Gemini",
      apiKey: "sk-gem",
      baseUrl: "",
      models: ["gemini-4-argon"],
      imageModels: [],
      billingCurrency: "USD",
      enabled: false,
    },
  ];

  // With includeDisabled: true -> includes both (5.4 + 7.25 = 12.65 CNY)
  const allAgg = aggregateWorkspaceUsage({
    sessions: [mockSession],
    configuredModels: ["deepseek-chat"],
    providers,
    includeDisabled: true,
  });
  assert.equal(allAgg.estimatedCostCny, 12.65);
  assert.equal(allAgg.byProvider.length, 2);

  // With includeDisabled: false -> excludes disabled prov-gem, showing only DeepSeek (5.4 CNY)
  const activeAgg = aggregateWorkspaceUsage({
    sessions: [mockSession],
    configuredModels: ["deepseek-chat"],
    providers,
    includeDisabled: false,
  });
  assert.equal(activeAgg.estimatedCostCny, 5.4);
  assert.equal(activeAgg.totalTokens, 1_500_000);
  assert.equal(activeAgg.byProvider.length, 1);
  assert.equal(activeAgg.byProvider[0].providerId, "prov-ds");
  assert.ok(!activeAgg.byModel.some((m) => m.model === "gemini-4-argon"));
});

test("DeepSeek exact billing: V4/Flash catalog rates, cache-hit pricing, Beijing off-peak 50% discount, and .ndjson historical backfill", () => {
  // 1. Official DeepSeek V4.1-Flash & V4-Pro catalog pricing (never falls through to Gemini USD pro/flash)
  const flashPricing = getModelPricing("DeepSeek-V4.1-Flash-1017");
  assert.equal(flashPricing.model, "deepseek-flash");
  assert.equal(flashPricing.currency, "CNY");
  assert.equal(flashPricing.inputPer1M, 2.0);
  assert.equal(flashPricing.cachedInputPer1M, 0.04);
  assert.equal(flashPricing.outputPer1M, 8.0);
  assert.equal(flashPricing.supportsOffPeakDiscount, true);

  const v4ProPricing = getModelPricing("DeepSeek-V4-Pro-0813");
  assert.equal(v4ProPricing.model, "deepseek-v4-pro");
  assert.equal(v4ProPricing.currency, "CNY");
  assert.equal(v4ProPricing.inputPer1M, 9.0);
  assert.equal(v4ProPricing.cachedInputPer1M, 0.3);
  assert.equal(v4ProPricing.outputPer1M, 27.0);
  assert.equal(v4ProPricing.supportsOffPeakDiscount, true);

  // Context window for DeepSeek V4 / Flash is 1M, legacy chat/reasoner stays 128k
  assert.equal(getModelContextWindow("deepseek-flash"), 1_000_000);
  assert.equal(getModelContextWindow("ds::deepseek-v4-pro"), 1_000_000);
  assert.equal(getModelContextWindow("deepseek-chat"), 128_000);

  // 2. Beijing Time (UTC+8) Peak vs Off-Peak schedule
  // Weekday morning peak: Monday 2026-11-16 10:30+08:00 -> Peak (false)
  assert.equal(isDeepSeekOffPeak("2026-11-16T10:30:00+08:00"), false);
  // Weekday afternoon peak: Monday 2026-11-16 15:00+08:00 -> Peak (false)
  assert.equal(isDeepSeekOffPeak("2026-11-16T15:00:00+08:00"), false);
  // Weekday lunch break: Monday 2026-11-16 12:30+08:00 -> Off-Peak (true)
  assert.equal(isDeepSeekOffPeak("2026-11-16T12:30:00+08:00"), true);
  // Weekday evening: Monday 2026-11-16 19:30+08:00 -> Off-Peak (true)
  assert.equal(isDeepSeekOffPeak("2026-11-16T19:30:00+08:00"), true);
  // Weekend morning: Sunday 2026-11-15 10:30+08:00 -> Off-Peak (true)
  assert.equal(isDeepSeekOffPeak("2026-11-15T10:30:00+08:00"), true);
  // Chinese National Day statutory holiday: Thursday 2026-10-01 10:30+08:00 -> Off-Peak (true)
  assert.equal(isDeepSeekOffPeak("2026-10-01T10:30:00+08:00"), true);

  // 3. Cache Hit vs Cache Miss + Off-Peak 50% calculation for deepseek-v4-pro & deepseek-flash
  // 1M input (900k cache hit + 100k cache miss) + 50k output on deepseek-v4-pro:
  // Peak: uncached 0.1 * 9.0 = 0.90 + cached 0.9 * 0.30 = 0.27 + output 0.05 * 27.0 = 1.35 => 2.52 CNY
  const proPeak = estimateModelCost(
    "deepseek-v4-pro",
    { input: 1_000_000, cached: 900_000, output: 50_000 },
    { timestamp: "2026-11-16T10:30:00+08:00" }
  );
  assert.equal(proPeak.appliedOffPeakDiscount, false);
  assert.equal(proPeak.costCny, 2.52);

  // Off-Peak (exact 50%): 2.52 * 0.5 = 1.26 CNY
  const proOffPeak = estimateModelCost(
    "deepseek-v4-pro",
    { input: 1_000_000, cached: 900_000, output: 50_000 },
    { timestamp: "2026-11-16T21:15:00+08:00" }
  );
  assert.equal(proOffPeak.appliedOffPeakDiscount, true);
  assert.equal(proOffPeak.costCny, 1.26);

  // deepseek-flash: 1M input (950k cache hit + 50k cache miss) + 100k output:
  // Peak: uncached 0.05 * 2.0 = 0.10 + cached 0.95 * 0.04 = 0.038 + output 0.1 * 8.0 = 0.80 => 0.938 CNY
  // Off-Peak: 0.469 CNY
  const flashOffPeak = estimateModelCost(
    "deepseek-flash",
    { input: 1_000_000, cached: 950_000, output: 100_000 },
    { timestamp: "2026-11-15T11:00:00+08:00" }
  );
  assert.equal(flashOffPeak.appliedOffPeakDiscount, true);
  assert.equal(flashOffPeak.costCny, 0.469);

  // 4. Live per-turn accumulateSessionUsagePatch records costVersion: 2 with mixed Peak + Off-Peak turns
  const dsProviders: any[] = [
    {
      id: "ds-main",
      type: "deepseek",
      name: "DeepSeek",
      apiKey: "sk-ds",
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-flash", "deepseek-v4-pro"],
      imageModels: [],
      billingCurrency: "CNY",
      enabled: true,
    },
  ];
  let liveSession: any = { id: "live-ds-1", title: "DS Live", model: "ds-main::deepseek-v4-pro" };
  liveSession = {
    ...liveSession,
    ...accumulateSessionUsagePatch(
      liveSession,
      {
        model: "deepseek-v4-pro",
        providerId: "ds-main",
        input: 1_000_000,
        cached: 900_000,
        output: 50_000,
        at: "2026-11-16T10:30:00+08:00", // Peak -> 2.52 CNY
      },
      { providers: dsProviders }
    ),
  };
  liveSession = {
    ...liveSession,
    ...accumulateSessionUsagePatch(
      liveSession,
      {
        model: "deepseek-v4-pro",
        providerId: "ds-main",
        input: 1_000_000,
        cached: 900_000,
        output: 50_000,
        at: "2026-11-16T22:00:00+08:00", // Off-Peak -> 1.26 CNY
      },
      { providers: dsProviders }
    ),
  };
  const liveBucket = liveSession.usageByProviderModel["ds-main::deepseek-v4-pro"];
  assert.equal(liveBucket.costVersion, 2);
  assert.equal(liveBucket.costCurrency, "CNY");
  assert.equal(liveBucket.costNative, 3.78); // 2.52 + 1.26

  const liveSummary = buildSessionCostSummary(liveSession, { providers: dsProviders });
  assert.equal(liveSummary.estimatedCostCny, 3.78);

  // 5. Historical pre-v2 session backfill from .ndjson event log timestamps & cached tokens
  const histSession: any = {
    id: "hist-ds-1",
    updatedAt: "2026-11-15T15:00:00.000Z",
    title: "DS History",
    model: "ds-main::deepseek-v4-pro",
    usage: { input: 2_000_000, cached: 1_850_000, output: 150_000 },
    usageByProviderModel: {
      // Pre-v2 buckets without costVersion / costNative
      "ds-main::deepseek-v4-pro": {
        input: 1_000_000,
        cached: 900_000,
        output: 50_000,
        thoughts: 0,
        calls: 1,
      },
      "ds-main::deepseek-flash": {
        input: 1_000_000,
        cached: 950_000,
        output: 100_000,
        thoughts: 0,
        calls: 1,
      },
    },
  };
  const histEvents = [
    {
      seq: 1,
      at: "2026-11-16T21:15:00+08:00", // Off-Peak -> 1.26 CNY
      type: "usage",
      model: "DeepSeek-V4-Pro-0813",
      providerId: "ds-main",
      input: 1_000_000,
      cached: 900_000,
      output: 50_000,
    },
    {
      seq: 2,
      at: "2026-11-15T11:00:00+08:00", // Sunday Off-Peak -> 0.469 CNY
      type: "usage",
      model: "DeepSeek-V4.1-Flash-1017",
      providerId: "ds-main",
      input: 1_000_000,
      cached: 950_000,
      output: 100_000,
    },
  ];
  const resolvedHist = resolveSessionUsageByProviderModel(histSession, {
    readEvents: () => histEvents,
    providers: dsProviders,
  });
  assert.equal(resolvedHist.get("ds-main::deepseek-v4-pro")?.costVersion, 2);
  assert.equal(resolvedHist.get("ds-main::deepseek-v4-pro")?.costNative, 1.26);
  assert.equal(resolvedHist.get("ds-main::deepseek-flash")?.costVersion, 2);
  assert.equal(resolvedHist.get("ds-main::deepseek-flash")?.costNative, 0.469);

  const histAgg = aggregateWorkspaceUsage({
    sessions: [histSession],
    readEvents: () => histEvents,
    configuredModels: ["deepseek-flash", "deepseek-v4-pro"],
    providers: dsProviders,
  });
  // Total = 1.26 + 0.469 = 1.729 CNY (instead of ~3.458 peak or ~97 CNY old USD Gemini fallback!)
  assert.equal(histAgg.estimatedCostCny, 1.729);
  assert.equal(histAgg.cachedTokens, 1_850_000);
});
