import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  planRoute,
  normalizeRoutePlan,
  extractJsonObject,
  isSimpleFollowUp,
  isTrivialChat,
  resetRoutePlanCache,
} from "../src/agent/route-planner.js";
import {
  createRouteRuntime,
  beginStep,
  recordToolOutcome,
  requestEscalation,
  decideEscalation,
  commitStepTier,
  classifyToolResult,
  formatTierPath,
} from "../src/agent/route-signals.js";
import {
  createTurnBudget,
  tierFromPlan,
  computeCategoryBias,
  normalizeRoutingSettings,
  resetCategoryBiasCache,
} from "../src/agent/route-stats.js";
import { buildSmartRoute, resetUnavailableModels } from "../src/agent/router.js";
import { runTask } from "../src/agent/loop.js";
import { createStore } from "../src/store/index.js";

const CFG = {
  defaultModel: "gemini-4-argon",
  deepModel: "gemini-4-carbon",
  fastModel: "gemini-4-hydrogen",
  models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
};

const COMPLEX_OPS_JSON = JSON.stringify({
  complexity: "complex",
  needs_visual: false,
  needs_planning: true,
  expected_steps: 4,
  risk: "low",
  category: "ops",
  confidence: 0.9,
  reason: "博客统计异常排查",
});

function plannerModel(responses: any[]): any {
  const calls: any[] = [];
  const queue = [...responses];
  return {
    calls,
    async planTurn(args: any) {
      calls.push(args);
      const r = queue.shift();
      if (r instanceof Error) throw r;
      if (typeof r === "function") return r(args);
      return r;
    },
  };
}

// ---------------- L1 Planner ----------------

test("planner: trivial chat skips the model; valid JSON is normalized and cached; usage reported", async () => {
  resetRoutePlanCache();
  const m = plannerModel([
    { text: `好的：\n${COMPLEX_OPS_JSON}`, usage: { input: 900, output: 60 }, usedModel: "gemini-4-hydrogen" },
  ]);

  const trivial = await planRoute({ model: m, rawUserText: "谢谢", config: CFG });
  assert.equal(trivial.source, "trivial");
  assert.equal(trivial.plan!.complexity, "trivial");
  assert.equal(m.calls.length, 0);

  const first = await planRoute({
    model: m,
    rawUserText: "帮我看看为啥博客访问量统计不对",
    botId: "b1",
    config: CFG,
  });
  assert.equal(first.source, "model");
  assert.equal(first.plan!.complexity, "complex");
  assert.equal(first.plan!.category, "ops");
  assert.equal(first.usage!.input, 900);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].model, "gemini-4-hydrogen");
  assert.equal(m.calls[0].thinkingLevel, "high");

  const second = await planRoute({
    model: m,
    rawUserText: "帮我看看为啥博客访问量统计不对",
    botId: "b1",
    config: CFG,
  });
  assert.equal(second.source, "cache");
  assert.equal(m.calls.length, 1);
});

test("planner: invalid JSON, thrown errors, timeouts, and models without planTurn fall back to heuristic", async () => {
  resetRoutePlanCache();
  const bad = await planRoute({
    model: plannerModel([{ text: "我觉得挺复杂的" }]),
    rawUserText: "部署一下 nginx 配置",
    config: CFG,
  });
  assert.equal(bad.source, "heuristic");
  assert.equal(bad.plan, null);

  const thrown = await planRoute({
    model: plannerModel([new Error("429 resource exhausted")]),
    rawUserText: "部署一下 caddy 配置",
    config: CFG,
  });
  assert.equal(thrown.source, "heuristic");

  const slow = await planRoute({
    model: plannerModel([() => new Promise(() => {})]),
    rawUserText: "部署一下 docker 配置",
    config: CFG,
    timeoutMs: 20,
  });
  assert.equal(slow.source, "heuristic");
  assert.match(slow.error!, /timed out/);

  const noPlanTurn = await planRoute({ model: { nextTurn() {} } as any, rawUserText: "你好", config: CFG });
  assert.equal(noPlanTurn.source, "heuristic");
});

test("planner helpers: JSON extraction and strict normalization", () => {
  assert.deepEqual(extractJsonObject('x {"a":{"b":"}"}} y'), { a: { b: "}" } });
  assert.equal(normalizeRoutePlan({ complexity: "huge" }), null);
  const p = normalizeRoutePlan({ complexity: "standard", category: "weird", confidence: 7, expected_steps: 99 });
  assert.equal(p!.category, "other");
  assert.equal(p!.confidence, 1);
  assert.equal(p!.expected_steps, 30);
  assert.equal(isTrivialChat("好的"), true);
  assert.equal(isTrivialChat("帮我写脚本"), false);
  assert.equal(isTrivialChat("你好", { hasAttachments: true }), false);
});

// ---------------- Plan → Tier mapping ----------------

test("tierFromPlan maps all 4 Hydrogen gears (low/medium/high/xhigh), Argon, and Carbon across modes and bias", () => {
  const trivial: any = { complexity: "trivial", needs_visual: false, needs_planning: false, expected_steps: 1, risk: "low", confidence: 0.9 };
  const compactStandard = { ...trivial, complexity: "standard", expected_steps: 3 };
  const deepHydrogenStandard = { ...trivial, complexity: "standard", expected_steps: 5 };
  const heavyStandard = { ...trivial, complexity: "standard", expected_steps: 7 };
  const complexNoPlan = { ...trivial, complexity: "complex", needs_planning: false, expected_steps: 4 };
  const complex = { ...trivial, complexity: "complex", needs_planning: true, expected_steps: 8 };

  assert.equal(tierFromPlan(trivial).baseTier, "fast");
  assert.equal(tierFromPlan(trivial).thinkingLevel, "medium");

  // Compact 1-3 step standard work runs on Hydrogen Med in balanced mode
  const compactDec = tierFromPlan(compactStandard);
  assert.equal(compactDec.baseTier, "fast");
  assert.equal(compactDec.thinkingLevel, "medium");
  assert.equal(tierFromPlan(compactStandard, { mode: "quality" }).baseTier, "standard");
  assert.equal(tierFromPlan(compactStandard, { bias: 0.5 }).baseTier, "standard");

  // 4-5 step standard uses Hydrogen High in balanced mode; >=6 step heavy standard uses Argon (Hydrogen XHigh in economy)
  const highDec = tierFromPlan(deepHydrogenStandard);
  assert.equal(highDec.baseTier, "fast");
  assert.equal(highDec.thinkingLevel, "high");
  assert.equal(tierFromPlan(heavyStandard).baseTier, "standard");
  assert.equal(tierFromPlan(heavyStandard, { mode: "economy" }).baseTier, "fast");
  assert.equal(tierFromPlan(heavyStandard, { mode: "economy" }).thinkingLevel, "xhigh");

  // Pure single-step complex reasoning without multi-step planning uses Hydrogen XHigh
  const xhighDec = tierFromPlan(complexNoPlan);
  assert.equal(xhighDec.baseTier, "fast");
  assert.equal(xhighDec.thinkingLevel, "xhigh");

  // Hydrogen native vision handles routine GUI/screenshots on Med, and explicit image attachments on High
  const visualDec = tierFromPlan({ ...trivial, needs_visual: true });
  assert.equal(visualDec.baseTier, "fast");
  assert.equal(visualDec.thinkingLevel, "medium");
  const attachDec = tierFromPlan({ ...trivial, needs_visual: true }, { hasAttachments: true });
  assert.equal(attachDec.baseTier, "fast");
  assert.equal(attachDec.thinkingLevel, "high");
  assert.equal(tierFromPlan({ ...trivial, needs_visual: true }, { mode: "quality" }).baseTier, "standard");

  assert.equal(tierFromPlan(trivial, { mode: "quality", bias: 0.5 }).baseTier, "standard");
  assert.equal(tierFromPlan({ ...trivial, risk: "high" }).baseTier, "standard");
  assert.equal(tierFromPlan({ ...compactStandard, confidence: 0.4 }).baseTier, "standard");
  assert.equal(tierFromPlan({ ...trivial, confidence: 0.4 }).baseTier, "fast");

  const c = tierFromPlan(complex);
  assert.equal(c.baseTier, "standard"); // Deep is never a base tier
  assert.equal(c.openWithDeepSteps, 1);
  assert.equal(c.thinkingLevel, "medium");
  assert.equal(tierFromPlan({ ...complex, expected_steps: 12 }).openWithDeepSteps, 2);
  assert.equal(tierFromPlan(complex, { mode: "quality" }).openWithDeepSteps, 2);
});

test("buildSmartRoute resolves all 4 Hydrogen gears, Argon, and Carbon cleanly", () => {
  resetUnavailableModels();
  const hLow = buildSmartRoute({ tier: "fast", config: CFG });
  assert.equal(hLow.model, "gemini-4-hydrogen");
  assert.equal(hLow.thinkingLevel, "low");
  assert.equal(hLow.label, "轻量全能 · Hydrogen");
  const hMed = buildSmartRoute({ tier: "fast", thinkingLevel: "medium", config: CFG });
  assert.equal(hMed.model, "gemini-4-hydrogen");
  assert.equal(hMed.thinkingLevel, "medium");
  assert.equal(hMed.label, "轻量全能 · Hydrogen");
  const hHigh = buildSmartRoute({ tier: "fast", thinkingLevel: "high", visual: true, config: CFG });
  assert.equal(hHigh.model, "gemini-4-hydrogen");
  assert.equal(hHigh.thinkingLevel, "high");
  assert.equal(hHigh.label, "轻量全能 · Hydrogen");
  const hXHigh = buildSmartRoute({ tier: "fast", thinkingLevel: "xhigh", config: CFG });
  assert.equal(hXHigh.model, "gemini-4-hydrogen");
  assert.equal(hXHigh.thinkingLevel, "xhigh");
  assert.equal(hXHigh.label, "轻量全能 · Hydrogen");
  const std = buildSmartRoute({ tier: "standard", visual: true, reason: "看屏幕", config: CFG });
  assert.equal(std.model, "gemini-4-argon");
  assert.equal(std.label, "性能旗舰 · Argon");
  assert.equal(std.reason, "看屏幕");
  const deep = buildSmartRoute({ tier: "deep", config: CFG });
  assert.equal(deep.model, "gemini-4-carbon");
  assert.equal(deep.label, "深度旗舰 · Carbon");
  assert.equal(deep.fallbackModel, "gemini-4-argon");
});

// ---------------- L2 Runtime Signals ----------------

test("runtime signals: Hydrogen failure promotes to Argon; 2 soft failures rescue on Carbon then step down", () => {
  const rt = createRouteRuntime();
  assert.equal(classifyToolResult({ exit_code: 1 }), "soft");
  assert.equal(classifyToolResult({ error: "boom" }), "hard");
  assert.equal(classifyToolResult({ ok: true }), "ok");

  beginStep(rt);
  recordToolOutcome(rt, { name: "run_shell", args: { command: "a" }, result: { exit_code: 2 } });
  commitStepTier(rt, "fast");
  const up = decideEscalation(rt, { baseTier: "fast" });
  assert.equal(up!.tier, "standard");
  assert.equal(up!.promoteBase, true);

  beginStep(rt);
  recordToolOutcome(rt, { name: "run_shell", args: { command: "b" }, result: { exit_code: 2 } });
  commitStepTier(rt, "standard");
  const rescue = decideEscalation(rt, { baseTier: "standard" });
  assert.equal(rescue!.tier, "deep");
  assert.equal(rescue!.thinkingLevel, "high");

  beginStep(rt);
  commitStepTier(rt, "deep");
  recordToolOutcome(rt, { name: "run_shell", args: { command: "c" }, result: { exit_code: 0 } });
  assert.equal(decideEscalation(rt, { baseTier: "standard" }), null);
  assert.equal(formatTierPath(rt.tierPath), "Hydrogen → Argon → Carbon");
});

test("runtime signals: repeated identical calls trigger a re-plan with nudge; deep cap is respected", () => {
  const rt = createRouteRuntime();
  for (let i = 0; i < 3; i += 1) {
    recordToolOutcome(rt, { name: "read_file", args: { path: "/x" }, result: { ok: true, text: "same" } });
  }
  const esc = decideEscalation(rt, { baseTier: "standard", deepCap: 3 });
  assert.equal(esc!.tier, "deep");
  assert.ok(esc!.nudge);

  rt.deepStepsUsed = 3;
  assert.equal(decideEscalation(rt, { baseTier: "standard", deepCap: 3 }), null);
});

test("route_escalate: supports think->Hydrogen XHigh, falls back to Hydrogen XHigh at 80-99% budget, and blocks at 100% or >2 per turn", () => {
  const rt = createRouteRuntime();
  const budget = createTurnBudget({ maxTurnUsd: 0.1 });
  const g0 = requestEscalation(rt, { need: "think", reason: "单步深度推理" }, { budget, deepCap: 3 });
  assert.equal(g0.granted, true);
  assert.equal(g0.nextTier, "fast");
  assert.equal(g0.thinkingLevel, "xhigh");
  const d0 = decideEscalation(rt, { baseTier: "fast", budget });
  assert.equal(d0!.tier, "fast");
  assert.equal(d0!.thinkingLevel, "xhigh");

  budget.add("gemini-4-argon", { input: 45_000, output: 0 }); // $0.09 → 90% (>=80% blocks Carbon, falls back to Hydrogen XHigh)
  const g2 = requestEscalation(rt, { need: "rescue", reason: "遇到困难" }, { budget, deepCap: 3 });
  assert.equal(g2.granted, true);
  assert.equal(g2.nextTier, "fast");
  assert.equal(g2.thinkingLevel, "xhigh");

  const g3 = requestEscalation(rt, { need: "visual" }, { budget, deepCap: 3 });
  assert.equal(g3.granted, false); // 3rd request exceeds the per-turn limit

  // Separate runtime verifies 100% budget hard-blocks escalation
  const rtFull = createRouteRuntime();
  budget.add("gemini-4-argon", { input: 10_000, output: 0 }); // $0.11 → 110%
  const gFull = requestEscalation(rtFull, { need: "rescue" }, { budget, deepCap: 3 });
  assert.equal(gFull.granted, false);
});

// ---------------- L3 Budget & L4 Bias ----------------

test("turn budget: 80% blocks deep, 100% blocks escalation, notices fire once per threshold", () => {
  const b = createTurnBudget({ maxTurnUsd: 0.1 });
  b.add("gemini-4-argon", { input: 20_000, output: 0 }); // $0.04
  assert.equal(b.canUseDeep(), true);
  assert.equal(b.takeNotice(), 0);
  b.add("gemini-4-argon", { input: 21_000, output: 0 }); // $0.082
  assert.equal(b.canUseDeep(), false);
  assert.equal(b.canEscalate(), true);
  assert.equal(b.takeNotice(), 1);
  assert.equal(b.takeNotice(), 0);
  b.add("gemini-4-argon", { input: 10_000, output: 0 });
  assert.equal(b.canEscalate(), false);
  assert.equal(b.takeNotice(), 2);
});

test("category bias: few samples → 0; Hydrogen often escalates → +0.5; Argon easy wins → -0.5; 👎 counts", () => {
  resetCategoryBiasCache();
  const mk = (n: number, row: any) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, ...row }));
  assert.equal(computeCategoryBias(mk(3, { category: "ops", baseTier: "fast", tierPath: ["fast", "standard"] }), "ops"), 0);

  const flashBad = [
    ...mk(5, { category: "ops", baseTier: "fast", tierPath: ["fast", "standard"], status: "done" }),
    ...mk(5, { category: "ops", baseTier: "fast", tierPath: ["fast"], status: "done" }).map((e, i) => ({ ...e, sessionId: `ok${i}` })),
  ];
  assert.equal(computeCategoryBias(flashBad, "ops"), 0.5);

  const argonEasy = mk(10, { category: "qa", baseTier: "standard", tierPath: ["standard"], steps: 1, errors: 0, softFailures: 0, status: "done" });
  assert.equal(computeCategoryBias(argonEasy, "qa"), -0.5);

  const withFeedback = [
    ...mk(10, { category: "mail", baseTier: "fast", tierPath: ["fast"], status: "done" }),
    ...mk(4, { type: "feedback", category: "mail" }),
  ];
  assert.equal(computeCategoryBias(withFeedback, "mail"), 0.5);
});

test("normalizeRoutingSettings applies defaults and clamps ranges", () => {
  assert.deepEqual(normalizeRoutingSettings(undefined), { smartRouter: true, mode: "balanced", maxTurnUsd: 0.5 });
  assert.equal(normalizeRoutingSettings({ mode: "bogus" }).mode, "balanced");
  assert.equal(normalizeRoutingSettings({ maxTurnUsd: 999 }).maxTurnUsd, 10);
  assert.equal(normalizeRoutingSettings({ smartRouter: false }).smartRouter, false);
});

// ---------------- Loop integration ----------------

test("runTask with smartRouter: plans via Hydrogen, opens on Carbon, recovers on Argon, rescues on Carbon, records stats", async (t) => {
  resetRoutePlanCache();
  resetCategoryBiasCache();
  resetUnavailableModels();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-smart-router-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const session = store.createSession({ title: "博客管理员" });

  const shellCall = (id: string) => ({
    thoughts: [],
    text: "",
    calls: [{ id, name: "run_shell", args: { command: "cat /var/log/caddy.log" } }],
    outputSteps: [{ id, type: "function_call", name: "run_shell", arguments: { command: "cat /var/log/caddy.log" } }],
    usage: { input: 10_000, output: 100 },
  });
  const turns = [
    shellCall("c1"),
    shellCall("c2"),
    { thoughts: [], text: "日志文件权限不足，已定位原因。", calls: [], outputSteps: [], usage: { input: 10_000, output: 50 } },
  ];
  const nextCalls: any[] = [];
  const model = {
    async planTurn() {
      return { text: COMPLEX_OPS_JSON, usage: { input: 800, output: 40 }, usedModel: "gemini-4-hydrogen" };
    },
    async nextTurn(args: any) {
      nextCalls.push(args);
      return turns.shift();
    },
  };
  const executor = {
    async call(route: any) {
      if (route === "/shell") return { stdout: "", stderr: "Permission denied", exit_code: 1 };
      return { ok: true };
    },
  };
  const events: any[] = [];

  const res = await runTask({
    sessionId: session.id,
    userText: "帮我看看为啥博客访问量统计不对",
    deps: {
      model,
      executor,
      store,
      enableBotTools: true,
      autoRoute: true,
      smartRouter: true,
      config: { ...CFG, maxSteps: 6, settleMs: 0 },
      emit: (e: any) => events.push(e),
    },
  });

  assert.equal(res.status, "done");
  assert.deepEqual(
    nextCalls.map((c) => c.model),
    ["gemini-4-carbon", "gemini-4-argon", "gemini-4-carbon"]
  );
  assert.ok(nextCalls[0].tools.some((d: any) => d.name === "route_escalate"));
  assert.match(nextCalls[0].systemInstruction, /route_escalate/);

  const planEvt = events.find((e) => e.type === "route_plan");
  assert.equal(planEvt.source, "model");
  assert.equal(planEvt.baseTier, "standard");
  assert.ok(events.some((e) => e.type === "usage" && e.routeLabel === "路由判断"));
  const lastUsage = events.filter((e) => e.type === "usage").pop();
  assert.equal(lastUsage.tierPath, "Carbon → Argon → Carbon");

  const stats = store.readRouteStats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].category, "ops");
  assert.deepEqual(stats[0].tierPath, ["deep", "standard", "deep"]);
  assert.equal(stats[0].softFailures, 2);
  assert.equal(stats[0].status, "done");
  assert.ok(stats[0].costUsd > 0);
});

test("runTask with smartRouter falls back to v1 heuristics when the planner fails (no stats recorded)", async (t) => {
  resetRoutePlanCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-smart-router-fb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const session = store.createSession({ title: "Nori" });
  const nextCalls: any[] = [];
  const model = {
    async planTurn() {
      throw new Error("503 overloaded");
    },
    async nextTurn(args: any) {
      nextCalls.push(args);
      return { thoughts: [], text: "你好！", calls: [], outputSteps: [] };
    },
  };
  const events: any[] = [];
  const res = await runTask({
    sessionId: session.id,
    userText: "今天适合做什么运动呢请推荐一下",
    deps: {
      model,
      executor: { async call() { return { ok: true }; } },
      store,
      enableBotTools: true,
      autoRoute: true,
      smartRouter: true,
      config: { ...CFG, maxSteps: 3, settleMs: 0 },
      emit: (e: any) => events.push(e),
    },
  });
  assert.equal(res.status, "done");
  assert.equal(nextCalls[0].model, "gemini-4-hydrogen"); // v1 fast route
  assert.ok(!nextCalls[0].tools.some((d: any) => d.name === "route_escalate"));
  assert.ok(!events.some((e) => e.type === "route_plan"));
  assert.equal(store.readRouteStats().length, 0);
});

test("4 Hydrogen High generates step_plan allocating per-step models, and pure text chat runs on Hydrogen Medium", async (t) => {
  resetRoutePlanCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-step-plan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  const s1 = store.createSession({ title: "Nori" });
  const s2 = store.createSession({ title: "Nori" });

  // 1) Multi-step task where 4 Hydrogen High assigns step 1 -> Carbon High, step 2 -> Argon Medium, step 3 -> Hydrogen Medium
  const planCalls: any[] = [];
  const stepCalls: any[] = [];
  let turnIdx = 0;
  const stepResponses = [
    {
      thoughts: [],
      text: "",
      calls: [{ id: "sp1", name: "run_shell", args: { command: "echo plan" } }],
      outputSteps: [{ id: "sp1", type: "function_call", name: "run_shell", arguments: { command: "echo plan" } }],
      usage: { input: 500, output: 40 },
    },
    {
      thoughts: [],
      text: "",
      calls: [{ id: "sp2", name: "run_shell", args: { command: "echo impl" } }],
      outputSteps: [{ id: "sp2", type: "function_call", name: "run_shell", arguments: { command: "echo impl" } }],
      usage: { input: 500, output: 40 },
    },
    {
      thoughts: [],
      text: "已按分步计划完成全部操作。",
      calls: [],
      outputSteps: [],
      usage: { input: 500, output: 40 },
    },
  ];
  const model1 = {
    async planTurn(args: any) {
      planCalls.push(args);
      return {
        text: JSON.stringify({
          complexity: "complex",
          needs_visual: false,
          needs_planning: true,
          expected_steps: 3,
          risk: "low",
          category: "coding",
          confidence: 0.92,
          reason: "分步执行规划",
          step_plan: [
            { steps: "1", model: "carbon", thinking: "high", task: "梳理方案" },
            { steps: "2", model: "argon", thinking: "medium", task: "修改配置" },
            { steps: "3", model: "hydrogen", thinking: "medium", task: "汇总反馈" },
          ],
        }),
        usage: { input: 700, output: 90 },
        usedModel: "gemini-4-hydrogen",
      };
    },
    async nextTurn(args: any) {
      stepCalls.push({ model: args.model, thinkingLevel: args.thinkingLevel });
      return stepResponses[turnIdx++];
    },
  };
  const events1: any[] = [];
  const res1 = await runTask({
    sessionId: s1.id,
    userText: "帮我规划并改造项目路由配置，再总结说明",
    deps: {
      model: model1,
      executor: { async call() { return { stdout: "ok", stderr: "", exit_code: 0 }; } },
      store,
      enableBotTools: true,
      autoRoute: true,
      smartRouter: true,
      config: { ...CFG, maxSteps: 6, settleMs: 0 },
      emit: (e: any) => events1.push(e),
    },
  });
  assert.equal(res1.status, "done");
  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0].model, "gemini-4-hydrogen");
  assert.equal(planCalls[0].thinkingLevel, "high");
  assert.deepEqual(stepCalls, [
    { model: "gemini-4-carbon", thinkingLevel: "high" },
    { model: "gemini-4-argon", thinkingLevel: "medium" },
    { model: "gemini-4-hydrogen", thinkingLevel: "medium" },
  ]);
  const rp = events1.find((e) => e.type === "route_plan");
  assert.equal(rp.plan.step_plan.length, 3);

  // 2) Pure-text chat runs on Hydrogen Medium (中档位) both via TRIVIAL_PLAN and model classification
  const chatCalls: any[] = [];
  const chatModel = {
    async planTurn(args: any) {
      chatCalls.push({ stage: "plan", model: args.model, thinkingLevel: args.thinkingLevel });
      return {
        text: JSON.stringify({
          complexity: "trivial",
          needs_visual: false,
          needs_planning: false,
          expected_steps: 1,
          risk: "low",
          category: "chat",
          confidence: 0.95,
          reason: "纯文字聊天",
          step_plan: [{ steps: "1", model: "hydrogen", thinking: "low", task: "纯文字回答" }],
        }),
        usage: { input: 300, output: 30 },
        usedModel: "gemini-4-hydrogen",
      };
    },
    async nextTurn(args: any) {
      chatCalls.push({ stage: "exec", model: args.model, thinkingLevel: args.thinkingLevel });
      return { thoughts: [], text: "今天天气不错，适合出门散步！", calls: [], outputSteps: [] };
    },
  };
  const res2 = await runTask({
    sessionId: s2.id,
    userText: "随便跟我聊聊今天晚上吃点什么比较好呢",
    deps: {
      model: chatModel,
      executor: { async call() { return { ok: true }; } },
      store,
      enableBotTools: true,
      autoRoute: true,
      smartRouter: true,
      config: { ...CFG, maxSteps: 3, settleMs: 0 },
    },
  });
  assert.equal(res2.status, "done");
  assert.deepEqual(chatCalls, [
    { stage: "plan", model: "gemini-4-hydrogen", thinkingLevel: "high" },
    { stage: "exec", model: "gemini-4-hydrogen", thinkingLevel: "medium" },
  ]);
});

test("route-signals detects A->B->A->B cycles, sleep polling, CAPTCHA stall, fast/xhigh decay, and same-model collapse", () => {
  // 1. Alternating A->B->A->B cycle detection
  const rtCycle = createRouteRuntime();
  recordToolOutcome(rtCycle, { name: "click", args: { x: 183, y: 351 }, result: { ok: true, screen_changed: true } });
  recordToolOutcome(rtCycle, { name: "click", args: { x: 1084, y: 608 }, result: { ok: true, screen_changed: true } });
  recordToolOutcome(rtCycle, { name: "click", args: { x: 183, y: 351 }, result: { ok: true, screen_changed: true } });
  recordToolOutcome(rtCycle, { name: "click", args: { x: 1084, y: 608 }, result: { ok: true, screen_changed: true } });
  assert.equal(rtCycle.cycleDetected, true);
  const cycEsc = decideEscalation(rtCycle, { baseTier: "fast" });
  assert.ok(cycEsc?.nudge && cycEsc.tier === "deep");

  // 2. Sleep polling fuse
  const rtSleep = createRouteRuntime();
  recordToolOutcome(rtSleep, { name: "run_shell", args: { command: "sleep 25" }, result: { exit_code: 0 } });
  recordToolOutcome(rtSleep, { name: "run_shell", args: { command: "sleep 25" }, result: { exit_code: 0 } });
  const sleepEsc = decideEscalation(rtSleep, { baseTier: "fast" });
  assert.match(sleepEsc?.reason || "", /sleep/i);

  // 3. CAPTCHA / verification challenge fuse
  const rtCap = createRouteRuntime();
  recordToolOutcome(rtCap, { name: "browser_snapshot", args: {}, result: { ok: true, challenge_detected: true } });
  const capEsc = decideEscalation(rtCap, { baseTier: "fast" });
  assert.match(capEsc?.nudge || "", /Bot 的电脑/);

  // 4. Expanded OBSERVE_ONLY_TOOLS (read_file / browser_snapshot)
  const rtObs = createRouteRuntime();
  for (let i = 0; i < 4; i++) {
    recordToolOutcome(rtObs, { name: i % 2 === 0 ? "read_file" : "browser_snapshot", args: { i }, result: { ok: true } });
  }
  assert.equal(rtObs.noProgressSteps, 4);

  // 5. fast === standard same-model collapse + autoEscalations + fast/xhigh softFailures decay
  const rtSame = createRouteRuntime();
  beginStep(rtSame);
  recordToolOutcome(rtSame, { name: "run_shell", args: { command: "bad1" }, result: { exit_code: 1 } });
  const sameEsc = decideEscalation(rtSame, { baseTier: "fast", sameFastStandard: true });
  assert.equal(sameEsc?.tier, "fast");
  assert.equal(sameEsc?.thinkingLevel, "high");
  assert.equal(Boolean(sameEsc?.promoteBase), false);
  commitStepTier(rtSame, "fast", { usedEscalation: true, thinkingLevel: "high" });
  assert.equal(rtSame.autoEscalations, 1);

  recordToolOutcome(rtSame, { name: "run_shell", args: { command: "bad2" }, result: { exit_code: 1 } });
  commitStepTier(rtSame, "fast", { usedEscalation: true, thinkingLevel: "xhigh" });
  assert.equal(rtSame.softFailures, 1, "fast/xhigh rescue must decay softFailures >= 2 down to 1");
});

test("isSimpleFollowUp skips planner and planCache separates identical inputs with distinct recentContext", async () => {
  resetRoutePlanCache();
  assert.equal(isSimpleFollowUp("继续"), true);
  assert.equal(isSimpleFollowUp("好的！"), true);
  assert.equal(isSimpleFollowUp("继续帮我写个脚本"), false);

  let planCalls = 0;
  const model = {
    async planTurn() {
      planCalls += 1;
      return {
        text: JSON.stringify({
          complexity: "standard",
          needs_visual: false,
          needs_planning: false,
          expected_steps: 2,
          risk: "low",
          category: "coding",
          confidence: 0.9,
          reason: "上下文分析",
        }),
      };
    },
  } as any;

  const follow = await planRoute({ model, rawUserText: "继续", config: CFG });
  assert.equal(follow.source, "trivial");
  assert.equal(planCalls, 0);

  await planRoute({
    model,
    rawUserText: "帮我处理一下这个报错",
    recentContext: "User: 刚才跑 Python 脚本报 ImportError",
    botId: "b1",
    config: CFG,
  });
  await planRoute({
    model,
    rawUserText: "帮我处理一下这个报错",
    recentContext: "User: 刚才编译 Android Gradle 报 SDK missing",
    botId: "b1",
    config: CFG,
  });
  assert.equal(planCalls, 2, "Different recentContext must not collide in planCache");
});
