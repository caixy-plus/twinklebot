import test from "node:test";
import assert from "node:assert/strict";
import { createModel } from "../src/agent/model.js";
import { getModelPricing, normalizeModelId } from "../src/agent/pricing.js";
import { resolveTierModels, buildSmartRoute, resetUnavailableModels } from "../src/agent/router.js";
import { normalizeStepPlan } from "../src/agent/route-planner.js";
import { normalizeRoutingSettings } from "../src/agent/route-stats.js";

test("normalizeRoutingSettings preserves 3-tier provider/model bindings", () => {
  const norm = normalizeRoutingSettings({
    smartRouter: true,
    mode: "balanced",
    maxTurnUsd: 0.8,
    tiers: {
      fast: { providerId: "ds", model: "deepseek-chat" },
      medium: { providerId: "oa", model: "gpt-4o" },
      advanced: { providerId: "ds", model: "deepseek-reasoner" },
    },
  });
  assert.deepEqual(norm.tiers, {
    fast: { providerId: "ds", model: "deepseek-chat" },
    medium: { providerId: "oa", model: "gpt-4o" },
    advanced: { providerId: "ds", model: "deepseek-reasoner" },
  });
});

test("resolveTierModels & buildSmartRoute bind fast/medium/advanced to configured providers", () => {
  resetUnavailableModels();
  const routing = {
    tiers: {
      fast: { providerId: "ds", model: "deepseek-chat" },
      medium: { providerId: "oa", model: "gpt-4o" },
      advanced: { providerId: "ds", model: "deepseek-reasoner" },
    },
  };
  const resolved = resolveTierModels({}, Date.now(), routing);
  assert.equal(resolved.fast, "ds::deepseek-chat");
  assert.equal(resolved.standard, "oa::gpt-4o");
  assert.equal(resolved.deep, "ds::deepseek-reasoner");

  const routeFast = buildSmartRoute({ tier: "fast", routingSettings: routing });
  assert.equal(routeFast.model, "ds::deepseek-chat");
  assert.match(routeFast.label, /deepseek-chat/i);

  const routeAdv = buildSmartRoute({ tier: "deep", routingSettings: routing });
  assert.equal(routeAdv.model, "ds::deepseek-reasoner");
});

test("createModel routes providerId::model across OpenAI and DeepSeek without a Gemini key", async () => {
  const seen: any[] = [];
  const fetchImpl = async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ url, model: body.model, auth: init.headers.Authorization });
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: "assistant", content: `reply:${body.model}` } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const model = createModel({
    providers: [
      {
        id: "ds",
        type: "deepseek",
        name: "DeepSeek",
        apiKey: "sk-ds-1",
        baseUrl: "https://api.deepseek.com/v1",
        models: ["deepseek-chat", "deepseek-reasoner"],
        imageModels: [],
        enabled: true,
      },
      {
        id: "oa",
        type: "openai",
        name: "OpenAI",
        apiKey: "sk-oa-1",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4o"],
        imageModels: [],
        enabled: true,
      },
    ],
    fetchImpl,
  });

  const r1 = await model.nextTurn({
    model: "ds::deepseek-reasoner",
    systemInstruction: "sys",
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(r1.text, "reply:deepseek-reasoner");
  assert.equal(seen[0].url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(seen[0].auth, "Bearer sk-ds-1");

  const r2 = await model.nextTurn({
    model: "oa::gpt-4o",
    systemInstruction: "sys",
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(r2.text, "reply:gpt-4o");
  assert.equal(seen[1].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(seen[1].auth, "Bearer sk-oa-1");
});

test("route-planner normalizeStepPlan supports fast/medium/advanced tiers with non-Gemini models", () => {
  const plan = normalizeStepPlan(
    [
      { steps: "1", tier: "advanced", model: "deepseek-reasoner", thinking: "high", task: "设计" },
      { steps: "2-3", tier: "medium", model: "gpt-4o", thinking: "medium", task: "执行" },
      { steps: "4", tier: "fast", model: "deepseek-chat", thinking: "low", task: "总结" },
    ],
    4
  );
  assert.equal(plan.length, 3);
  assert.equal(plan[0].tier, "deep");
  assert.equal(plan[1].tier, "standard");
  assert.equal(plan[2].tier, "fast");
});

test("pricing catalog covers OpenAI and DeepSeek models and strips provider prefix", () => {
  assert.equal(normalizeModelId("ds::deepseek-chat"), "deepseek-chat");
  const dsChat = getModelPricing("ds::deepseek-chat");
  assert.notEqual(dsChat.role, "自定义模型");
  assert.equal(dsChat.currency, "CNY");
  assert.equal(dsChat.inputPer1M, 2.0);
  assert.equal(dsChat.outputPer1M, 8.0);

  const oa4o = getModelPricing("oa::gpt-4o");
  assert.notEqual(oa4o.role, "自定义模型");
  assert.equal(oa4o.currency || "USD", "USD");
  assert.equal(oa4o.inputPer1M, 2.5);
});
