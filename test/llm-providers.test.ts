import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_TYPES,
  normalizeProvidersConfig,
  sanitizeProvidersForClient,
  testProviderConnection,
} from "../src/agent/providers/registry.js";
import {
  createGeminiDriver,
  sanitizeInputForGemini,
} from "../src/agent/providers/gemini-driver.js";
import {
  canonicalToOpenAiMessages,
  createOpenAiCompatDriver,
  openAiResponseToTurn,
} from "../src/agent/providers/openai-compat-driver.js";
import { userStep, toolResultSteps } from "../src/agent/model.js";
import { pruneScreenshots, trimHistory } from "../src/agent/context.js";
import { buildScrubbedEnv } from "../src/lib/mcp-client.js";
import {
  probeGcpServerEnvironment,
  resolveGeminiVertexRuntime,
} from "../src/lib/gcp-env.js";

test("normalizeProvidersConfig & sanitizeProvidersForClient mask secrets and normalize presets", () => {
  assert.deepEqual(PROVIDER_TYPES, [
    "gemini",
    "openai",
    "deepseek",
    "openai-compatible",
  ]);

  const list = normalizeProvidersConfig(
    [
      {
        id: "oa-1",
        type: "openai",
        name: "OpenAI",
        apiKey: "sk-openai-12345678",
        models: ["gpt-4o-mini", "gpt-4o"],
      },
      {
        id: "ds-1",
        type: "deepseek",
        name: "DeepSeek",
        apiKey: "sk-ds-99887766",
      },
    ],
    ""
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].baseUrl, "https://api.openai.com/v1");
  assert.equal(list[1].baseUrl, "https://api.deepseek.com/v1");
  assert.ok(list[1].models.includes("deepseek-chat"));

  const sanitized = sanitizeProvidersForClient(list);
  assert.equal(sanitized[0].hasApiKey, true);
  assert.equal((sanitized[0] as any).apiKey, undefined);
  assert.equal(sanitized[0].maskedApiKey, "••••5678");
  assert.ok(!JSON.stringify(sanitized).includes("sk-openai-12345678"));
});

test("openai compat tool roundtrip preserves canonical IR and retries without reasoning_effort on 400", async () => {
  const pngBuf = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const history = [userStep("查看当前目录", pngBuf)];

  const messages = canonicalToOpenAiMessages("You are helpful.", history);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content[1].type, "image_url");

  let callCount = 0;
  const requests: any[] = [];
  const driver = createOpenAiCompatDriver({
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    providerType: "openai-compatible",
    fetchImpl: async (url: any, init: any) => {
      callCount++;
      const parsedBody = JSON.parse(init!.body as string);
      requests.push({ url, body: parsedBody });
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Unsupported parameter: reasoning_effort" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      if (callCount === 2) {
        return new Response(
          JSON.stringify({
            model: "custom-model-1",
            choices: [
              {
                message: {
                  role: "assistant",
                  reasoning_content: "checking directory first",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "run_shell",
                        arguments: JSON.stringify({ command: "ls" }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 25 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          model: "custom-model-1",
          choices: [
            {
              message: {
                role: "assistant",
                content: "目录里只有一个 file.txt。",
              },
            },
          ],
          usage: { prompt_tokens: 140, completion_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const turn1 = await driver.nextTurn({
    model: "custom-model-1",
    thinkingLevel: "high",
    systemInstruction: "You are helpful.",
    tools: [
      {
        type: "function",
        name: "run_shell",
        description: "run shell",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    input: history,
  });

  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.equal(requests[1].body.reasoning_effort, undefined);
  assert.deepEqual(turn1.thoughts, ["checking directory first"]);
  assert.equal(turn1.calls!.length, 1);
  assert.equal(turn1.calls![0].name, "run_shell");
  assert.deepEqual(turn1.calls![0].args, { command: "ls" });
  assert.equal(turn1.usage!.input, 100);
  assert.equal(turn1.usage!.output, 25);

  history.push(...((turn1.outputSteps || []) as any[]));
  history.push(...toolResultSteps(turn1.calls![0], { stdout: "file.txt" }, null));

  // Canonical IR works seamlessly with pruneScreenshots & trimHistory
  const pruned = pruneScreenshots(trimHistory(history, 24), 3);
  const turn2 = await driver.nextTurn({
    model: "custom-model-1",
    thinkingLevel: "low",
    systemInstruction: "You are helpful.",
    input: pruned,
  });
  assert.equal(turn2.text, "目录里只有一个 file.txt。");
  assert.equal(turn2.calls!.length, 0);
});

test("testProviderConnection checks OpenAI-compatible and Gemini drivers", async () => {
  const oaOk = await testProviderConnection(
    {
      type: "deepseek",
      apiKey: "sk-ds",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-chat",
            choices: [{ message: { role: "assistant", content: "pong" } }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    }
  );
  assert.equal(oaOk.ok, true);
  assert.equal(oaOk.model, "deepseek-chat");

  const missingKey = await testProviderConnection({ type: "openai", apiKey: "" });
  assert.equal(missingKey.ok, false);
  assert.match(missingKey.error!, /API Key/i);
});

test("buildScrubbedEnv strips multi-provider and cloud/local tokens", () => {
  const scrubbed = buildScrubbedEnv({
    PATH: "/usr/bin",
    GEMINI_API_KEY: "g1",
    VERTEX_API_KEY: "v1",
    OPENAI_API_KEY: "o1",
    DEEPSEEK_API_KEY: "d1",
    CUSTOM_LLM_API_KEY: "c1",
    TWINKLEBOT_CLOUD_TOKEN: "ct",
    TWINKLEBOT_LOCAL_TOKEN: "lt",
    TWINKLEBOT_EXECUTOR_TOKEN: "et",
  });
  assert.equal(scrubbed.PATH, "/usr/bin");
  for (const k of [
    "GEMINI_API_KEY",
    "VERTEX_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "CUSTOM_LLM_API_KEY",
    "TWINKLEBOT_CLOUD_TOKEN",
    "TWINKLEBOT_LOCAL_TOKEN",
    "TWINKLEBOT_EXECUTOR_TOKEN",
  ]) {
    assert.equal(scrubbed[k], undefined);
  }
});

test("Google Gemini merges legacy vertex entries and enforces GCP-server-only Vertex AI gate", async () => {
  // 1. Legacy standalone "vertex" entries seamlessly migrate to "gemini"
  const migrated = normalizeProvidersConfig(
    [
      {
        id: "vx-legacy",
        type: "vertex",
        name: "Google Vertex AI",
        project: "old-proj",
        location: "us-central1",
      },
    ],
    ""
  );
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].type, "gemini");
  assert.equal(migrated[0].name, "Google Gemini");
  assert.equal((migrated[0] as any).project, undefined);

  // 2. Local deployEnv unconditionally rejects GCP Vertex AI even if env vars are set
  const localProbe = await probeGcpServerEnvironment({ deployEnv: "local" });
  assert.equal(localProbe.isGcpServer, false);
  const localRuntime = resolveGeminiVertexRuntime({
    deployEnv: "local",
    env: {
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "my-gcp-proj",
      GOOGLE_CLOUD_LOCATION: "global",
    },
    gcpProbe: localProbe,
  });
  assert.equal(localRuntime.vertexActive, false);
  assert.match(localRuntime.blockedReason, /仅支持 GCP 云服务器部署/);

  const blockedLocalTest = await testProviderConnection(
    { type: "gemini" },
    { geminiVertexRuntime: localRuntime }
  );
  assert.equal(blockedLocalTest.ok, false);
  assert.match(blockedLocalTest.error!, /仅支持 GCP 云服务器部署/);

  // 3. Non-GCP cloud server (e.g. Alibaba Cloud ECS metadata without Metadata-Flavor: Google) is blocked
  const aliyunProbe = await probeGcpServerEnvironment({
    deployEnv: "cloud",
    fetchImpl: (async () =>
      new Response("i-bp123456", {
        status: 200,
        headers: { Server: "ECS-Metadata" },
      })) as any,
  });
  assert.equal(aliyunProbe.isGcpServer, false);
  assert.equal(aliyunProbe.reason, "metadata_missing_google_flavor");
  const aliyunRuntime = resolveGeminiVertexRuntime({
    deployEnv: "cloud",
    env: {
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "spoofed-proj",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    },
    gcpProbe: aliyunProbe,
  });
  assert.equal(aliyunRuntime.vertexActive, false);
  assert.match(aliyunRuntime.blockedReason, /GEMINI_API_KEY/);

  // 4. Verified GCP server with Metadata-Flavor: Google + official env vars activates Vertex ADC
  const gcpProbe = await probeGcpServerEnvironment({
    deployEnv: "cloud",
    fetchImpl: (async () =>
      new Response("twinkle-gcp-prod", {
        status: 200,
        headers: { "Metadata-Flavor": "Google" },
      })) as any,
  });
  assert.equal(gcpProbe.isGcpServer, true);
  assert.equal(gcpProbe.projectId, "twinkle-gcp-prod");

  const gcpRuntime = resolveGeminiVertexRuntime({
    deployEnv: "cloud",
    env: {
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "twinkle-gcp-prod",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    },
    gcpProbe,
  });
  assert.equal(gcpRuntime.vertexActive, true);

  const implicitGcp = normalizeProvidersConfig([], {
    geminiVertexRuntime: gcpRuntime,
  });
  assert.equal(implicitGcp.length, 1);
  assert.equal(implicitGcp[0].type, "gemini");

  const sanitizedGcp = sanitizeProvidersForClient(implicitGcp, {}, gcpRuntime);
  assert.equal(sanitizedGcp[0].authMode, "gcp-vertex");
  assert.equal(
    sanitizedGcp[0].gcpVertexLabel,
    "GCP Vertex AI · twinkle-gcp-prod (us-central1)"
  );

  const okGcp = await testProviderConnection(
    { type: "gemini" },
    {
      geminiVertexRuntime: gcpRuntime,
      client: {
        interactions: {
          async create() {
            return { steps: [{ type: "model_output", text: "OK" }] };
          },
        },
      },
    }
  );
  assert.equal(okGcp.ok, true);
});

test("gemini driver strips unsigned thoughts upfront and retries without foreign thought signatures on 400 Invalid thought signature", async () => {
  const seenInputs: any[] = [];
  const driver = createGeminiDriver({
    vertexai: true,
    project: "p1",
    location: "global",
    client: {
      interactions: {
        async create(params: any) {
          seenInputs.push(params.input);
          const hasAnyThought = params.input.some(
            (s: any) => s?.type === "thought" || s?.type === "thought_signature" || s?.signature
          );
          if (hasAnyThought) {
            const err: any = new Error("400 Invalid thought signature.");
            err.status = 400;
            throw err;
          }
          return { steps: [{ type: "model_output", text: "recovered" }] };
        },
      },
    },
  });

  const turn = await driver.nextTurn({
    model: "gemini-4-hydrogen",
    systemInstruction: "sys",
    input: [
      userStep("q1"),
      { type: "thought", text: "unsigned openai reasoning" },
      { type: "thought", signature: "ai-studio-foreign-sig", summary: [{ type: "text", text: "old" }] },
      { type: "model_output", content: [{ type: "text", text: "a1" }] },
      userStep("q2"),
    ],
  });

  assert.equal(turn.text, "recovered");
  assert.equal(seenInputs.length, 2);
  assert.equal(seenInputs[0].some((s: any) => s.text === "unsigned openai reasoning"), false);
  assert.equal(seenInputs[1].some((s: any) => s.type === "thought"), false);
});

test("gemini driver folds unsigned cross-provider tool turns upfront and recovers from generic 400 invalid argument", async () => {
  // 1. DeepSeek/OpenAI history (thought without signature + model_output + function_call + function_result)
  //    is cleanly folded into user_input execution notes (never pseudo `[Tool call ...]` inside model_output)
  //    while preserving Gemini signed tool turns (including thought(sig) -> model_output -> function_call)!
  const mixedHistory = [
    userStep("check page"),
    // Gemini native signed tool turn with interim model_output -> preserved intact!
    { type: "thought", signature: "gem-sig-1", summary: [{ type: "text", text: "plan" }] },
    { type: "model_output", content: [{ type: "text", text: "先看下目录" }] },
    { type: "function_call", id: "call_gem_1", name: "run_shell", arguments: { command: "pwd" } },
    { type: "function_result", call_id: "call_gem_1", name: "run_shell", result: '{"stdout":"/tmp"}' },
    { type: "model_output", content: [{ type: "text", text: "done step 1" }] },
    userStep("now open browser"),
    // DeepSeek/OpenAI unsigned turn with pre-action model_output + function_call -> MUST be folded!
    { type: "thought", text: "deepseek reasoning without signature" },
    { type: "model_output", content: [{ type: "text", text: "好的，我去看看" }] },
    { type: "function_call", id: "call_00_IuRG", name: "browser_snapshot", arguments: { url: "https://example.com" } },
    { type: "function_result", call_id: "call_00_IuRG", name: "browser_snapshot", result: '{"ok":true,"title":"Example"}' },
  ];

  const firstSanitized = sanitizeInputForGemini(mixedHistory, {
    stripAllThoughts: false,
    foldUnsignedToolTurns: true,
  });
  // Gemini native signed call preserved even with interim model_output before function_call
  assert.ok(firstSanitized.some((s: any) => s.type === "function_call" && s.id === "call_gem_1"));
  // Foreign unsigned DeepSeek call folded (never sent as raw unsigned function_call!)
  assert.equal(
    firstSanitized.some((s: any) => s.type === "function_call" && s.id === "call_00_IuRG"),
    false
  );
  // Folded context preserves tool call & result text inside user_input and NEVER injects `[Tool call ...]` into model_output
  const serialized = JSON.stringify(firstSanitized);
  assert.ok(serialized.includes("browser_snapshot"));
  assert.ok(serialized.includes("Example"));
  assert.equal(serialized.includes("[Tool call "), false);
  const modelOutputs = firstSanitized.filter((s: any) => s.type === "model_output");
  assert.ok(
    modelOutputs.every((s: any) => !JSON.stringify(s).includes("browser_snapshot")),
    "folded unsigned tool calls must live in user_input notes, never model_output"
  );

  // 2. If Gemini still returns generic `400 Request contains an invalid argument.` (e.g. cross-version
  //    Gemini signature mismatch), driver automatically retries with all thoughts stripped & tool turns folded!
  const seen: any[] = [];
  const driver = createGeminiDriver({
    apiKey: "test-key",
    client: {
      interactions: {
        async create(params: any) {
          seen.push(params.input);
          if (params.input.some((s: any) => s.type === "thought" || s.type === "function_call")) {
            const err: any = new Error("400 Request contains an invalid argument.");
            err.status = 400;
            throw err;
          }
          return { steps: [{ type: "model_output", content: [{ type: "text", text: "recovered-400" }] }] };
        },
      },
    },
  });

  const turn = await driver.nextTurn({
    model: "gemini-3.1-pro-preview",
    systemInstruction: "sys",
    input: mixedHistory,
  });

  assert.equal(turn.text, "recovered-400");
  assert.equal(seen.length, 2);
  assert.equal(seen[1].some((s: any) => s.type === "thought" || s.type === "function_call"), false);
});

test("gemini driver retries malformed_tool_call failed interactions, merges usage, and throws if failure persists", async () => {
  // 1. First call returns HTTP 200 status=failed + malformed_tool_call -> auto-retries once and succeeds
  const calls: any[] = [];
  const recoveringDriver = createGeminiDriver({
    apiKey: "test-key",
    client: {
      interactions: {
        async create(params: any) {
          calls.push(params.input);
          if (calls.length === 1) {
            return {
              status: "failed",
              errors: [
                {
                  code: "malformed_tool_call",
                  message: "Model generated invalid JSON syntax and the output could not be parsed.",
                },
              ],
              usage: { total_input_tokens: 1000, total_output_tokens: 0 },
              steps: [],
            };
          }
          return {
            status: "completed",
            usage: { total_input_tokens: 1050, total_output_tokens: 120 },
            steps: [
              { type: "function_call", id: "fc_ok_1", name: "run_shell", arguments: { command: "ls" } },
            ],
          };
        },
      },
    },
  });

  const recovered = await recoveringDriver.nextTurn({
    model: "gemini-4-hydrogen",
    systemInstruction: "sys",
    input: [
      userStep("list files"),
      { type: "thought", signature: "sig-old", summary: [{ type: "text", text: "old" }] },
      { type: "model_output", content: [{ type: "text", text: "checking" }] },
    ],
  });
  assert.equal(calls.length, 2);
  assert.equal(recovered.calls!.length, 1);
  assert.equal(recovered.calls![0].name, "run_shell");
  assert.equal(recovered.usage!.input, 2050);
  assert.equal(recovered.usage!.output, 120);
  assert.match(JSON.stringify(calls[1]), /malformed_tool_call|invalid JSON syntax/i);

  // 2. If status=failed persists after retry, driver MUST throw instead of returning empty done turn
  let failAttempts = 0;
  const failingDriver = createGeminiDriver({
    apiKey: "test-key",
    client: {
      interactions: {
        async create() {
          failAttempts++;
          return {
            status: "failed",
            errors: [{ code: "malformed_tool_call", message: "still malformed JSON" }],
            usage: { total_input_tokens: 500, total_output_tokens: 0 },
            steps: [],
          };
        },
      },
    },
  });

  await assert.rejects(
    failingDriver.nextTurn({
      model: "gemini-4-hydrogen",
      systemInstruction: "sys",
      input: [userStep("do work")],
    }),
    /Gemini interaction failed.*malformed_tool_call/i
  );
  assert.equal(failAttempts, 2);

  // 3. status=incomplete propagates finishReason="length"
  const incompleteDriver = createGeminiDriver({
    apiKey: "test-key",
    client: {
      interactions: {
        async create() {
          return {
            status: "incomplete",
            usage: { total_input_tokens: 500, total_output_tokens: 400 },
            steps: [{ type: "thought", text: "still thinking" }],
          };
        },
      },
    },
  });
  const incTurn = await incompleteDriver.nextTurn({
    model: "gemini-4-hydrogen",
    systemInstruction: "sys",
    input: [userStep("think")],
  });
  assert.equal(incTurn.finishReason, "length");
});

test("openAiResponseToTurn extracts DeepSeek prompt_cache_hit_tokens and prompt_cache_miss_tokens accurately", () => {
  // DeepSeek standard response with both prompt_tokens and explicit hit/miss split
  const dsTurn = openAiResponseToTurn(
    {
      model: "DeepSeek-V4.1-Flash-1017",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 48_000,
        completion_tokens: 600,
        prompt_cache_hit_tokens: 44_800,
        prompt_cache_miss_tokens: 3_200,
        prompt_tokens_details: { cached_tokens: 44_800 },
      },
    },
    "deepseek-flash"
  );
  assert.equal(dsTurn.usage?.input, 48_000);
  assert.equal(dsTurn.usage?.cached, 44_800);
  assert.equal(dsTurn.usage?.output, 600);
  assert.equal((dsTurn.usage?.input || 0) - (dsTurn.usage?.cached || 0), 3_200);

  // Fallback when prompt_tokens is omitted and only hit + miss are returned
  const hitMissOnly = openAiResponseToTurn(
    {
      model: "DeepSeek-V4-Pro-0813",
      choices: [{ message: { role: "assistant", content: "done" } }],
      usage: {
        prompt_cache_hit_tokens: 19_200,
        prompt_cache_miss_tokens: 800,
        completion_tokens: 350,
        completion_tokens_details: { reasoning_tokens: 120 },
      },
    },
    "deepseek-v4-pro"
  );
  assert.equal(hitMissOnly.usage?.input, 20_000);
  assert.equal(hitMissOnly.usage?.cached, 19_200);
  assert.equal(hitMissOnly.usage?.output, 350);
  assert.equal(hitMissOnly.usage?.thoughts, 120);
});

test("openai compat driver accumulates SSE chunks across long active streams without false idle timeout and supports same-provider fallback", async () => {
  const enc = new TextEncoder();
  const requests: any[] = [];
  const driver = createOpenAiCompatDriver({
    apiKey: "sk-ds",
    baseUrl: "https://api.deepseek.com/v1",
    providerType: "deepseek",
    fetchImpl: async (_url, init: any) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      // Primary model simulates a hard 503 failure -> falls back to fallbackModel
      if (body.model === "deepseek-flash") {
        return new Response(
          JSON.stringify({ error: { message: "overloaded" } }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }
      // Fallback model streams chunks spaced 35ms apart totaling > 100ms (with idle timeoutMs = 80ms!)
      const stream = new ReadableStream({
        async start(controller) {
          const chunks = [
            `data: ${JSON.stringify({ model: "deepseek-v4-pro", choices: [{ delta: { reasoning_content: "think-" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "step2" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "你好，" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "世界", tool_calls: [{ index: 0, id: "call_sse_1", type: "function", function: { name: "run_", arguments: '{"com' } }] } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "shell", arguments: 'mand":"ls"}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 18, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20, completion_tokens_details: { reasoning_tokens: 8 } } })}\n\n`,
            `data: [DONE]\n\n`,
          ];
          for (const ch of chunks) {
            await new Promise((r) => setTimeout(r, 35));
            controller.enqueue(enc.encode(ch));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  const turn = await driver.nextTurn({
    model: "deepseek-flash",
    fallbackModel: "deepseek-v4-pro",
    thinkingLevel: "medium",
    timeoutMs: 80,
    input: [{ type: "user_input", content: [{ type: "text", text: "测试流式" }] }],
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[1].model, "deepseek-v4-pro");
  assert.deepEqual(turn.thoughts, ["think-step2"]);
  assert.equal(turn.text, "你好，世界");
  assert.equal(turn.calls?.length, 1);
  assert.equal(turn.calls?.[0].name, "run_shell");
  assert.deepEqual(turn.calls?.[0].args, { command: "ls" });
  assert.equal(turn.usage?.input, 50);
  assert.equal(turn.usage?.cached, 30);
  assert.equal(turn.usage?.thoughts, 8);
});

test("canonicalToOpenAiMessages keeps all tool responses contiguous after assistant.tool_calls even when screenshots or user turns interleave", () => {
  const pngBuf = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  // Simulate saved legacy history where call_1 returned a "Current screen:" user_input before call_2's result
  const interleaved = [
    userStep("检查桌面和系统状态", null),
    { type: "function_call", id: "call_1", name: "screenshot", arguments: {} },
    { type: "function_call", id: "call_2", name: "system_diagnostics", arguments: {} },
    { type: "function_result", call_id: "call_1", name: "screenshot", result: '{"ok":true}' },
    userStep("Current screen:", pngBuf),
    { type: "function_result", call_id: "call_2", name: "system_diagnostics", result: '{"ready":true}' },
    { type: "model_output", content: [{ type: "text", text: "全部正常。" }] },
  ];

  const msgs = canonicalToOpenAiMessages("sys", interleaved);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["system", "user", "assistant", "tool", "tool", "user", "assistant"]
  );
  assert.deepEqual(
    msgs[2].tool_calls.map((tc: any) => tc.id),
    ["call_1", "call_2"]
  );
  assert.equal(msgs[3].tool_call_id, "call_1");
  assert.equal(msgs[4].tool_call_id, "call_2");
  assert.equal(msgs[5].role, "user");
  assert.equal(msgs[5].content[0].text, "Current screen:");
  assert.equal(msgs[6].content, "全部正常。");

  // Also test partial/unanswered tool calls and orphaned tool results
  const broken = [
    userStep("第一轮", null),
    { type: "function_call", id: "c_ok", name: "run_shell", arguments: {} },
    { type: "function_call", id: "c_missing", name: "screenshot", arguments: {} },
    { type: "function_result", call_id: "c_ok", name: "run_shell", result: "done" },
    { type: "function_result", call_id: "c_orphan", name: "run_shell", result: "stale" },
    userStep("继续", null),
    { type: "function_call", id: "c_all_missing", name: "run_shell", arguments: {} },
    userStep("重来", null),
  ];

  const repaired = canonicalToOpenAiMessages("", broken);
  assert.deepEqual(
    repaired.map((m) => m.role),
    ["user", "assistant", "tool", "user", "user"]
  );
  assert.deepEqual(
    repaired[1].tool_calls.map((tc: any) => tc.id),
    ["c_ok"]
  );
  assert.equal(repaired[2].tool_call_id, "c_ok");
});

test("openAiResponseToTurn captures finishReason=length and flags malformed tool-call JSON instead of silently running {}", async () => {
  const truncated = openAiResponseToTurn(
    {
      model: "deepseek-chat",
      choices: [
        {
          finish_reason: "length",
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_trunc_1",
                type: "function",
                function: {
                  name: "host_write_file",
                  arguments: '{"path":"C:/tmp/a.txt","content":"half',
                },
              },
            ],
          },
        },
      ],
    },
    "deepseek-chat"
  );
  assert.equal(truncated.finishReason, "length");
  assert.equal(truncated.calls?.length, 1);
  assert.ok(truncated.calls?.[0].parseError);

  const enc = new TextEncoder();
  const driver = createOpenAiCompatDriver({
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    fetchImpl: async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                model: "gpt-4o",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_sse_trunc",
                          type: "function",
                          function: { name: "write_file", arguments: '{"path":"/a.txt"' },
                        },
                      ],
                    },
                    finish_reason: "length",
                  },
                ],
              })}\n\n`
            )
          );
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const sseTurn = await driver.nextTurn({
    model: "gpt-4o",
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(sseTurn.finishReason, "length");
  assert.ok(sseTurn.calls?.[0].parseError);
});

test("canonicalToOpenAiMessages omits empty thought-only assistant messages and strips unpaired UTF-16 surrogates", () => {
  const loneHigh = String.fromCharCode(0xd83d);
  const steps = [
    userStep(`Hello ${loneHigh} 🙈`, null),
    { type: "thought", text: "aborted before replying" },
    { type: "model_output", content: [{ type: "text", text: "" }] },
    userStep("next", null),
    { type: "model_output", content: [{ type: "text", text: `Done ${loneHigh}!` }] },
  ];

  const msgs = canonicalToOpenAiMessages("sys", steps);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["system", "user", "user", "assistant"]
  );
  assert.equal(msgs[1].content, "Hello  🙈");
  assert.equal(msgs[3].content, "Done !");
});

test("openai compat driver retries transient 429 rate-limit responses when no fallback model exists, but skips insufficient_quota", async () => {
  let transientCalls = 0;
  const driver = createOpenAiCompatDriver({
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    fetchImpl: async () => {
      transientCalls++;
      if (transientCalls === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Rate limit reached" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "retry-after-ms": "10",
            },
          }
        );
      }
      return new Response(
        JSON.stringify({
          model: "gpt-4o",
          choices: [{ message: { role: "assistant", content: "ok after retry" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const ok = await driver.nextTurn({
    model: "gpt-4o",
    input: [{ type: "user_input", content: [{ type: "text", text: "ping" }] }],
  });
  assert.equal(transientCalls, 2);
  assert.equal(ok.text, "ok after retry");

  let quotaCalls = 0;
  const quotaDriver = createOpenAiCompatDriver({
    apiKey: "sk-test",
    baseUrl: "https://api.example.com/v1",
    fetchImpl: async () => {
      quotaCalls++;
      return new Response(
        JSON.stringify({ error: { message: "insufficient_quota: billing limit reached" } }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  await assert.rejects(
    quotaDriver.nextTurn({
      model: "gpt-4o",
      input: [{ type: "user_input", content: [{ type: "text", text: "ping" }] }],
    }),
    /insufficient_quota/
  );
  assert.equal(quotaCalls, 1);
});

test("openai compat driver drops unanswered thought+tool_call turns, sanitizes broken string args, and backfills reasoning_content for DeepSeek", async () => {
  const steps = [
    userStep("turn 1", null),
    // Thought + unanswered tool_call -> must be dropped completely, not left as content:""
    { type: "thought", text: "aborted tool thought" },
    { type: "function_call", id: "unanswered_1", name: "run_shell", arguments: {} },
    userStep("turn 2", null),
    // Valid paired call whose stored arguments string was corrupted -> normalized to "{}"
    { type: "function_call", id: "paired_bad_args", name: "run_shell", arguments: '{"cmd":broken' },
    { type: "function_result", call_id: "paired_bad_args", name: "run_shell", result: "ok" },
    { type: "model_output", content: [{ type: "text", text: "prior reply without thought" }] },
    userStep("turn 3", null),
  ];

  const msgs = canonicalToOpenAiMessages("", steps);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "user", "assistant", "tool", "assistant", "user"]
  );
  assert.equal(msgs[2].tool_calls[0].function.arguments, "{}");

  // DeepSeek reasoner proactively attaches reasoning_content: "" on prior assistant messages
  const payloads: any[] = [];
  const dsDriver = createOpenAiCompatDriver({
    apiKey: "sk-ds",
    baseUrl: "https://api.deepseek.com/v1",
    providerType: "deepseek",
    fetchImpl: async (_url, init: any) => {
      payloads.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          model: "deepseek-reasoner",
          choices: [{ message: { role: "assistant", reasoning_content: "r", content: "done" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  await dsDriver.nextTurn({
    model: "deepseek-reasoner",
    input: steps,
  });
  const sentAssistants = payloads[0].messages.filter((m: any) => m.role === "assistant");
  assert.equal(sentAssistants.length, 2);
  assert.ok(sentAssistants.every((m: any) => typeof m.reasoning_content === "string"));
});
