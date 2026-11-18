import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createRunner } from "../src/agent/runner.js";
import { createServer } from "../src/server/index.js";
import { createModel } from "../src/agent/model.js";
import {
  isProviderUsable,
  parseApiKeyEnvRef,
  resolveProviderApiKey,
  sanitizeProvidersForClient,
} from "../src/agent/providers/registry.js";

function bootTestServer(
  t: any,
  { geminiApiKey = "", deployEnv = "local", gcpProbe = null, env = {}, testProviderFn }: any = {}
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-prov-api-"));
  const store = createStore(tmpDir);
  const runner = createRunner({
    store,
    model: { async nextTurn() { return { text: "ok", calls: [] }; } },
    executor: { async health() { return { ok: true }; }, async call() { return {}; } },
  });
  const srv = createServer({
    store,
    runner,
    executor: { async health() { return { ok: true }; }, async call() { return {}; } },
    testProviderFn,
    gcpProbe,
    env,
    config: {
      port: 0,
      deployEnv,
      geminiApiKey,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
      writeRoots: [tmpDir],
    },
  });
  return new Promise<any>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
      t.after(async () => {
        srv.closeAllConnections?.();
        await new Promise<void>((r) => srv.close(() => r()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
      resolve({ baseUrl, store });
    });
  });
}

test("unconfigured server requires onboarding and masks provider secrets across CRUD", async (t) => {
  const testedPayloads: any[] = [];
  const { baseUrl, store } = await bootTestServer(t, {
    geminiApiKey: "",
    testProviderFn: async (payload: any) => {
      testedPayloads.push(payload);
      return { ok: true, latencyMs: 12, model: payload.model || "gpt-4o-mini" };
    },
  });

  // Initially requires onboarding
  const initSettings = await fetch(`${baseUrl}/api/settings`).then((r) => r.json());
  assert.equal(initSettings.onboardingRequired, true);
  assert.deepEqual(initSettings.providers, []);

  // Test connection endpoint without saving
  const testRes = await fetch(`${baseUrl}/api/providers/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "openai",
      apiKey: "sk-test-1234",
      model: "gpt-4o-mini",
    }),
  });
  assert.equal(testRes.status, 200);
  const testJson = await testRes.json();
  assert.equal(testJson.ok, true);
  assert.equal(testedPayloads.length, 1);

  // Complete onboarding with OpenAI provider + 3-tier bindings
  const onbRes = await fetch(`${baseUrl}/api/onboarding/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: {
        id: "oa-main",
        type: "openai",
        name: "OpenAI",
        apiKey: "sk-live-secret-9876",
        models: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
      },
      tiers: {
        fast: { providerId: "oa-main", model: "gpt-4o-mini" },
        medium: { providerId: "oa-main", model: "gpt-4o" },
        advanced: { providerId: "oa-main", model: "o4-mini" },
      },
    }),
  });
  assert.equal(onbRes.status, 200);
  const onbJson = await onbRes.json();
  assert.equal(onbJson.onboardingRequired, false);
  assert.equal(onbJson.providers.length, 1);
  assert.equal(onbJson.providers[0].hasApiKey, true);
  assert.equal(onbJson.providers[0].maskedApiKey, "••••9876");
  assert.ok(!JSON.stringify(onbJson).includes("sk-live-secret-9876"));
  assert.equal(onbJson.routing.tiers.fast.model, "gpt-4o-mini");
  assert.equal(onbJson.routing.tiers.advanced.model, "o4-mini");

  // Updating provider with blank apiKey preserves stored key
  const updRes = await fetch(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "oa-main",
      type: "openai",
      name: "OpenAI Work",
      apiKey: "",
      models: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
    }),
  });
  assert.equal(updRes.status, 200);
  const rawStored = store.readSettings().providers.find((p: any) => p.id === "oa-main");
  assert.equal(rawStored.apiKey, "sk-live-secret-9876");
  assert.equal(rawStored.name, "OpenAI Work");

  // Diagnostics reflects llmConfigured
  const diag = await fetch(`${baseUrl}/api/system/diagnostics`).then((r) => r.json());
  assert.equal(diag.llmConfigured, true);

  // Deleting provider cleans up dangling tier refs and re-triggers onboardingRequired
  const delRes = await fetch(`${baseUrl}/api/providers/oa-main`, {
    method: "DELETE",
  });
  assert.equal(delRes.status, 200);
  const afterDel = await delRes.json();
  assert.equal(afterDel.providers.length, 0);
  assert.equal(afterDel.onboardingRequired, true);
});

test("server rejects standalone vertex provider, blocks non-GCP Vertex env, activates GCP-server Vertex ADC, and supports PATCH /api/vault/:id", async (t) => {
  // 1. Non-GCP server (e.g. Alibaba Cloud) attempting GOOGLE_GENAI_USE_VERTEXAI=true is blocked
  const nonGcp = await bootTestServer(t, {
    deployEnv: "cloud",
    geminiApiKey: "",
    gcpProbe: { isGcpServer: false, projectId: "", reason: "metadata_missing_google_flavor" },
    env: {
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "aliyun-proj",
      GOOGLE_CLOUD_LOCATION: "global",
    },
  });

  const legacyVertexPost = await fetch(`${nonGcp.baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "vertex",
      name: "Vertex ADC",
    }),
  });
  assert.equal(legacyVertexPost.status, 400);

  const keylessGeminiOnNonGcp = await fetch(`${nonGcp.baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "gemini",
      name: "Google Gemini",
    }),
  });
  assert.equal(keylessGeminiOnNonGcp.status, 400);
  const nonGcpErr = await keylessGeminiOnNonGcp.json();
  assert.match(nonGcpErr.error, /仅支持 GCP 云服务器部署/);

  const nonGcpDiag = await fetch(`${nonGcp.baseUrl}/api/system/diagnostics`).then((r) => r.json());
  assert.equal(nonGcpDiag.gcpServerVerified, false);
  assert.equal(nonGcpDiag.gcpVertexActive, false);
  assert.match(nonGcpDiag.blockedVertexReason, /GEMINI_API_KEY/);

  // Vault create + PATCH update works cleanly
  const vCreate = await fetch(`${nonGcp.baseUrl}/api/vault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "login", title: "测试后台", subtitle: "ops@example.com" }),
  }).then((r) => r.json());
  assert.ok(vCreate.id);

  const vPatch = await fetch(`${nonGcp.baseUrl}/api/vault/${encodeURIComponent(vCreate.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "contact", title: "测试后台（已更新）", subtitle: "admin@example.com" }),
  });
  assert.equal(vPatch.status, 200);
  const vPatchJson = await vPatch.json();
  assert.equal(vPatchJson.title, "测试后台（已更新）");
  assert.equal(vPatchJson.subtitle, "admin@example.com");
  assert.equal(vPatchJson.category, "contact");

  // 2. Verified GCP Cloud Server with env vars auto-enables Google Gemini via Vertex ADC
  const gcpSrv = await bootTestServer(t, {
    deployEnv: "cloud",
    geminiApiKey: "",
    gcpProbe: {
      isGcpServer: true,
      projectId: "twinkle-gcp-cloud",
      reason: "verified_gcp_metadata",
    },
    env: {
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "twinkle-gcp-cloud",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    },
  });

  const gcpSettings = await fetch(`${gcpSrv.baseUrl}/api/settings`).then((r) => r.json());
  assert.equal(gcpSettings.onboardingRequired, false);
  assert.equal(gcpSettings.gcpVertexActive, true);
  assert.equal(gcpSettings.providers.length, 1);
  assert.equal(gcpSettings.providers[0].type, "gemini");
  assert.equal(gcpSettings.providers[0].authMode, "gcp-vertex");

  const diag = await fetch(`${gcpSrv.baseUrl}/api/system/diagnostics`).then((r) => r.json());
  assert.equal(diag.llmConfigured, true);
  assert.equal(diag.gcpServerVerified, true);
  assert.equal(diag.gcpVertexActive, true);
  assert.equal(diag.vertexConfigured, true);
  assert.deepEqual(diag.models, ["gemini-4-hydrogen", "gemini-4-argon", "gemini-4-carbon"]);
});

test("diagnostics models reflect enabled providers (e.g. DeepSeek) and PATCH /api/providers/:id toggles enabled state", async (t) => {
  const { baseUrl } = await bootTestServer(t, {
    geminiApiKey: "",
  });

  const createRes = await fetch(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "ds-main",
      type: "deepseek",
      name: "DeepSeek 主力",
      apiKey: "sk-deepseek-test-1234",
      models: ["deepseek-chat", "deepseek-reasoner"],
    }),
  });
  assert.equal(createRes.status, 200);

  const diagEnabled = await fetch(`${baseUrl}/api/system/diagnostics`).then((r) => r.json());
  assert.equal(diagEnabled.llmConfigured, true);
  assert.deepEqual(diagEnabled.models, ["deepseek-chat", "deepseek-reasoner"]);
  assert.deepEqual(diagEnabled.imageModels, []);

  // Disable provider via PATCH
  const disableRes = await fetch(`${baseUrl}/api/providers/ds-main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRes.status, 200);
  const disableJson = await disableRes.json();
  assert.equal(disableJson.provider.enabled, false);
  assert.equal(disableJson.onboardingRequired, true);

  const diagDisabled = await fetch(`${baseUrl}/api/system/diagnostics`).then((r) => r.json());
  assert.equal(diagDisabled.llmConfigured, false);
  assert.deepEqual(diagDisabled.models, []);

  // Re-enable provider via PATCH
  const enableRes = await fetch(`${baseUrl}/api/providers/ds-main`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enableRes.status, 200);
  const enableJson = await enableRes.json();
  assert.equal(enableJson.provider.enabled, true);
  assert.equal(enableJson.onboardingRequired, false);

  const diagReEnabled = await fetch(`${baseUrl}/api/system/diagnostics`).then((r) => r.json());
  assert.equal(diagReEnabled.llmConfigured, true);
  assert.deepEqual(diagReEnabled.models, ["deepseek-chat", "deepseek-reasoner"]);

  // Unknown provider returns 404
  const missingRes = await fetch(`${baseUrl}/api/providers/not-exist`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(missingRes.status, 404);
});

test("provider create/toggle/delete auto-assigns 3-tier routing without leaving blank tiers", async (t) => {
  const { baseUrl } = await bootTestServer(t, { geminiApiKey: "" });

  // Adding DeepSeek auto-assigns all 3 tiers
  const dsRes = await fetch(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "ds-1",
      type: "deepseek",
      name: "DeepSeek",
      apiKey: "sk-ds-1234",
      models: ["deepseek-chat", "deepseek-reasoner"],
    }),
  });
  assert.equal(dsRes.status, 200);
  const dsJson = await dsRes.json();
  assert.equal(dsJson.autoAssignedTiers, true);
  assert.equal(dsJson.routing.tiers.fast.providerId, "ds-1");
  assert.equal(dsJson.routing.tiers.fast.model, "deepseek-chat");
  assert.equal(dsJson.routing.tiers.medium.model, "deepseek-chat");
  assert.equal(dsJson.routing.tiers.advanced.model, "deepseek-reasoner");

  // Adding OpenAI preserves existing valid bindings (autoAssignedTiers: false)
  const oaRes = await fetch(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "oa-1",
      type: "openai",
      name: "OpenAI",
      apiKey: "sk-oa-1234",
      models: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
    }),
  });
  assert.equal(oaRes.status, 200);
  const oaJson = await oaRes.json();
  assert.equal(oaJson.autoAssignedTiers, false);
  assert.equal(oaJson.routing.tiers.fast.providerId, "ds-1");

  // Disabling ds-1 auto-reassigns all 3 tiers to oa-1
  const disRes = await fetch(`${baseUrl}/api/providers/ds-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disRes.status, 200);
  const disJson = await disRes.json();
  assert.equal(disJson.autoAssignedTiers, true);
  assert.equal(disJson.routing.tiers.fast.providerId, "oa-1");
  assert.equal(disJson.routing.tiers.fast.model, "gpt-4o-mini");
  assert.equal(disJson.routing.tiers.medium.model, "gpt-4o");
  assert.equal(disJson.routing.tiers.advanced.model, "o4-mini");
});

test("configurable image model tier persists via settings, appears in diagnostics, and routes generateImage", async (t) => {
  const { baseUrl } = await bootTestServer(t, { geminiApiKey: "" });

  const oaRes = await fetch(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "oa-img",
      type: "openai",
      name: "OpenAI",
      apiKey: "sk-oa-img",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o-mini", "gpt-image-1"],
    }),
  });
  assert.equal(oaRes.status, 200);

  const saveRes = await fetch(`${baseUrl}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing: {
        tiers: {
          fast: { providerId: "oa-img", model: "gpt-4o-mini" },
          medium: { providerId: "oa-img", model: "gpt-4o-mini" },
          advanced: { providerId: "oa-img", model: "gpt-4o-mini" },
          image: { providerId: "oa-img", model: "gpt-image-1" },
        },
      },
    }),
  });
  assert.equal(saveRes.status, 200);
  const saved = await saveRes.json();
  assert.deepEqual(saved.routing.tiers.image, {
    providerId: "oa-img",
    model: "gpt-image-1",
  });

  const diag = await fetch(`${baseUrl}/api/system/diagnostics`).then((r) => r.json());
  assert.ok(diag.imageModels.includes("gpt-image-1"));

  const calls: any[] = [];
  const model = createModel({
    getProviders: (): any[] => [
      {
        id: "oa-img",
        type: "openai",
        apiKey: "sk-oa-img",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4o-mini", "gpt-image-1"],
        enabled: true,
      },
    ],
    getRouting: () => ({
      tiers: {
        image: { providerId: "oa-img", model: "gpt-image-1" },
      },
    }),
    fetchImpl: async (url: any, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ data: [{ b64_json: "AQIDBA==" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const imgRes = await model.generateImage!({ prompt: "a cute robot", aspectRatio: "16:9" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(calls[0].body.model, "gpt-image-1");
  assert.equal(calls[0].body.size, "1536x1024");
  assert.equal(imgRes.usedModel, "gpt-image-1");
  assert.equal(imgRes.images[0].data, "AQIDBA==");
});

test("createModel does not fall back to env GEMINI_API_KEY when providers are configured and image tier is unset", async () => {
  const model = createModel({
    apiKey: "env-gemini-key-should-not-be-used",
    getProviders: (): any[] => [
      {
        id: "deepseek-only",
        type: "deepseek",
        apiKey: "sk-ds",
        models: ["deepseek-flash"],
        enabled: true,
      },
    ],
    getRouting: () => ({
      tiers: {
        fast: { providerId: "deepseek-only", model: "deepseek-flash" },
      },
    }),
  });

  await assert.rejects(
    () => model.generateImage!({ prompt: "a frog", aspectRatio: "1:1" }),
    /当前未配置可用的生图模型/
  );
});

test("provider apiKey auto-detects literal keys vs environment variable names", async () => {
  const fakeEnv = {
    MY_TEST_OPENAI_KEY: "sk-from-env-9876",
    DEEPSEEK_API_KEY: "sk-ds-env-4321",
  };

  assert.equal(parseApiKeyEnvRef("sk-literal-1234"), null);
  assert.equal(parseApiKeyEnvRef("AIzaSyAbcDef"), null);
  assert.equal(parseApiKeyEnvRef("MY_TEST_OPENAI_KEY"), "MY_TEST_OPENAI_KEY");
  assert.equal(parseApiKeyEnvRef("$DEEPSEEK_API_KEY"), "DEEPSEEK_API_KEY");
  assert.equal(parseApiKeyEnvRef("${DEEPSEEK_API_KEY}"), "DEEPSEEK_API_KEY");
  assert.equal(parseApiKeyEnvRef("env:MY_TEST_OPENAI_KEY"), "MY_TEST_OPENAI_KEY");

  assert.equal(resolveProviderApiKey("sk-literal-1234", fakeEnv), "sk-literal-1234");
  assert.equal(resolveProviderApiKey("MY_TEST_OPENAI_KEY", fakeEnv), "sk-from-env-9876");
  assert.equal(resolveProviderApiKey("$DEEPSEEK_API_KEY", fakeEnv), "sk-ds-env-4321");
  assert.equal(resolveProviderApiKey("MISSING_ENV_KEY", fakeEnv), "");

  assert.equal(
    isProviderUsable(
      { id: "p1", type: "openai", apiKey: "MY_TEST_OPENAI_KEY", models: ["gpt-4o"], enabled: true } as any,
      fakeEnv
    ),
    true
  );
  assert.equal(
    isProviderUsable(
      { id: "p2", type: "openai", apiKey: "MISSING_ENV_KEY", models: ["gpt-4o"], enabled: true } as any,
      fakeEnv
    ),
    false
  );

  const sanitized = sanitizeProvidersForClient(
    [
      { id: "p1", type: "openai", apiKey: "MY_TEST_OPENAI_KEY", models: ["gpt-4o"] },
      { id: "p2", type: "openai", apiKey: "MISSING_ENV_KEY", models: ["gpt-4o"] },
      { id: "p3", type: "openai", apiKey: "sk-literal-1234", models: ["gpt-4o"] },
    ] as any,
    fakeEnv
  );
  assert.equal(sanitized[0].hasApiKey, true);
  assert.equal(sanitized[0].apiKeySource, "env");
  assert.equal(sanitized[0].apiKeyEnvName, "MY_TEST_OPENAI_KEY");
  assert.match(sanitized[0].maskedApiKey, /ENV:MY_TEST_OPENAI_KEY/);
  assert.equal(sanitized[1].hasApiKey, false);
  assert.match(sanitized[1].maskedApiKey, /未设置/);
  assert.equal(sanitized[2].hasApiKey, true);
  assert.equal(sanitized[2].apiKeySource, "literal");

  const prevVal = process.env.GB_TEST_RUNTIME_KEY;
  process.env.GB_TEST_RUNTIME_KEY = "sk-runtime-env-5555";
  try {
    let seenAuth = "";
    const model = createModel({
      getProviders: (): any[] => [
        {
          id: "oa-env",
          type: "openai",
          apiKey: "GB_TEST_RUNTIME_KEY",
          baseUrl: "https://api.openai.com/v1",
          models: ["gpt-4o-mini"],
          enabled: true,
        },
      ],
      fetchImpl: async (_url: any, init: any) => {
        seenAuth = init.headers.Authorization;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
    });
    await model.nextTurn({
      model: "oa-env::gpt-4o-mini",
      input: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    assert.equal(seenAuth, "Bearer sk-runtime-env-5555");
  } finally {
    if (prevVal === undefined) delete process.env.GB_TEST_RUNTIME_KEY;
    else process.env.GB_TEST_RUNTIME_KEY = prevVal;
  }
});
