import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModel } from "../src/agent/model.js";
import { createOpenAiCompatDriver } from "../src/agent/providers/openai-compat-driver.js";
import { resetUnavailableModels } from "../src/agent/router.js";
import {
  estimateModelCost,
  aggregateWorkspaceUsage,
} from "../src/agent/pricing.js";
import { runTask } from "../src/agent/loop.js";
import {
  BOT_COLLAB_TOOL_DECLARATIONS,
  runBotCollabTool,
} from "../src/agent/bot-tools.js";
import {
  executeImageGenerationWithFallback,
  extractAndSanitizeSvg,
  resolveSvgFallbackModels,
} from "../src/agent/image-fallback.js";
import { convertImageBuffer } from "../src/lib/image-convert.js";
import { buildSystemInstruction } from "../src/agent/prompt.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

// Tiny valid 1x1 PNG base64
const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// Fake JPEG header base64 (/9j/4AAQ...)
const SAMPLE_JPG_B64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]).toString("base64");

test("createModel.generateImage uses Interactions API only, parses output_image & steps, and falls back on 429", async () => {
  resetUnavailableModels();
  const recordedCalls: any[] = [];
  let attempt = 0;

  const fakeClient = {
    interactions: {
      async create(params: any) {
        recordedCalls.push(params);
        attempt += 1;
        if (attempt === 1) {
          const err: any = new Error("Resource exhausted");
          err.status = 429;
          throw err;
        }
        return {
          status: "completed",
          model: params.model,
          output_image: {
            type: "image",
            data: SAMPLE_JPG_B64,
            mime_type: "image/jpeg",
          },
          steps: [
            {
              type: "image",
              data: SAMPLE_JPG_B64,
              mime_type: "image/jpeg",
            },
          ],
          usage: {
            total_input_tokens: 22,
            total_output_tokens: 1120,
            total_tokens: 1142,
          },
        };
      },
    },
  };

  const model = createModel({ client: fakeClient });
  const res = await model.generateImage!({
    prompt: "A rainbow robot mascot flat icon",
    model: "gemini-3.1-flash-image",
    fallbackModel: "gemini-2.5-flash-image",
    aspectRatio: "16:9",
  });

  assert.equal(recordedCalls.length, 2);
  assert.equal(recordedCalls[0].model, "gemini-3.1-flash-image");
  assert.equal(recordedCalls[1].model, "gemini-2.5-flash-image");
  assert.deepEqual(recordedCalls[0].response_modalities, ["image"]);
  assert.equal(recordedCalls[0].store, false);
  assert.equal(
    recordedCalls[0].generation_config?.image_config?.aspect_ratio,
    "16:9"
  );

  assert.equal(res.usedModel, "gemini-2.5-flash-image");
  assert.equal(res.images.length, 1, "deduplicates output_image and steps image");
  assert.equal(res.images[0].mimeType, "image/jpeg");
  assert.equal(res.images[0].data, SAMPLE_JPG_B64);
  assert.deepEqual(res.usage, { input: 22, output: 1120 });
});

test("createModel.generateImage supports referenceImages for image-to-image editing via Interactions API", async () => {
  resetUnavailableModels();
  let capturedParams: any = null;
  const fakeClient = {
    interactions: {
      async create(params: any) {
        capturedParams = params;
        return {
          status: "completed",
          output_image: {
            type: "image",
            data: SAMPLE_PNG_B64,
          },
          usage: {
            total_input_tokens: 280,
            total_output_tokens: 1120,
            total_tokens: 1400,
          },
        };
      },
    },
  };

  const model = createModel({ client: fakeClient });
  const res = await model.generateImage!({
    prompt: "Restyle this avatar into watercolor",
    model: "gemini-3-pro-image",
    aspectRatio: "1:1",
    referenceImages: [{ data: SAMPLE_PNG_B64, mimeType: "image/png" }],
  });

  assert.ok(Array.isArray(capturedParams.input));
  assert.equal(capturedParams.input[0].type, "user_input");
  assert.equal(capturedParams.input[0].content[0].type, "image");
  assert.equal(capturedParams.input[0].content[0].data, SAMPLE_PNG_B64);
  assert.equal(capturedParams.input[0].content[1].type, "text");
  assert.equal(res.images[0].mimeType, "image/png");
  assert.equal(res.usedModel, "gemini-3-pro-image");
});

test("Google image models have dedicated token pricing and surface in billing breakdown", () => {
  const flashImg = estimateModelCost("gemini-3.1-flash-image", {
    input: 1_000,
    output: 1_120,
  });
  assert.ok(flashImg.label.includes("Nano Banana 2"));
  assert.equal(flashImg.accent, "amber");
  // 1,000 * $0.50/1M + 1,120 * $60/1M = 0.0005 + 0.0672 = $0.0677
  assert.equal(flashImg.costUsd, 0.0677);

  const proImg = estimateModelCost("gemini-3-pro-image", {
    input: 1_000,
    output: 1_120,
  });
  assert.ok(proImg.label.includes("Nano Banana Pro"));
  assert.equal(proImg.accent, "rose");
  assert.ok(proImg.costUsd > flashImg.costUsd);

  const agg = aggregateWorkspaceUsage({
    sessions: [
      {
        id: "s-img",
        title: "插画师 Bot",
        usage: { input: 2_000, output: 1_500 },
        usageByModel: {
          "gemini-3.8-flash": { input: 1_980, output: 380, calls: 2 },
          "gemini-3.1-flash-image": { input: 20, output: 1_120, calls: 1 },
        },
      },
    ],
    configuredModels: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
  });

  const imgRow = agg.byModel.find((m) => m.model === "gemini-3.1-flash-image");
  assert.ok(imgRow, "used image model appears in workspace billing breakdown");
  assert.equal(imgRow.calls, 1);
  assert.equal(imgRow.outputTokens, 1_120);
});

test("runTask executes generate_image tool host-side, saves file, records image usage, and embeds image in answer", async () => {
  resetUnavailableModels();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-imggen-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = createStore(path.join(tmpDir, "data"));
  const session = store.createSession({ title: "Nori" });

  // Create a valid reference image inside workspace and a secret file outside workspace
  const refPath = path.join(workspaceDir, "uploads", "ref.png");
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(refPath, Buffer.from(SAMPLE_PNG_B64, "base64"));
  const outsidePath = path.join(tmpDir, "outside-secret.png");
  fs.writeFileSync(outsidePath, Buffer.from(SAMPLE_PNG_B64, "base64"));

  let turnCount = 0;
  const generateCalls: any[] = [];
  const fakeModel = {
    async nextTurn() {
      turnCount += 1;
      if (turnCount === 1) {
        return {
          thoughts: ["用户想生成一张赛博猫咪插画，调用 generate_image"],
          text: "我马上用谷歌图像模型为你绘制这张赛博猫咪插画。",
          calls: [
            {
              id: "call_img_1",
              name: "generate_image",
              args: {
                prompt: "Cyberpunk neon cat wearing visor, digital illustration",
                title: "赛博霓虹猫咪",
                aspect_ratio: "16:9",
                quality: "standard",
                reference_image_path: refPath,
              },
            },
          ],
          outputSteps: [
            {
              type: "function_call",
              id: "call_img_1",
              name: "generate_image",
              arguments: {
                prompt: "Cyberpunk neon cat wearing visor, digital illustration",
                title: "赛博霓虹猫咪",
                aspect_ratio: "16:9",
                quality: "standard",
                reference_image_path: refPath,
              },
            },
          ],
          usage: { input: 500, output: 60 },
          usedModel: "gemini-3.8-flash",
        };
      }
      // Deliberately omit markdown image link in final text to verify guaranteed inline auto-embed!
      return {
        thoughts: [],
        text: "已经为你画好了这张赛博霓虹猫咪插画！",
        calls: [],
        outputSteps: [],
        usage: { input: 620, output: 30 },
        usedModel: "gemini-3.8-flash",
      };
    },
    async generateImage(opts: any) {
      generateCalls.push(opts);
      return {
        images: [{ data: SAMPLE_PNG_B64, mimeType: "image/png" }],
        text: "",
        usage: { input: 35, output: 1120 },
        usedModel: opts.model,
      };
    },
  };

  let executorTouched = false;
  const fakeExecutor = {
    call: async () => {
      executorTouched = true;
      return { png_base64: SAMPLE_PNG_B64 };
    },
  };

  const emitted: any[] = [];
  const taskRes = await runTask({
    sessionId: session.id,
    userText: "帮我画一张赛博霓虹猫咪",
    deps: {
      autoRoute: true,
      enableBotTools: true,
      config: {
        defaultModel: "gemini-4-argon",
        deepModel: "gemini-4-carbon",
        fastModel: "gemini-3.8-flash",
        imageModel: "gemini-3.1-flash-image",
        proImageModel: "gemini-3-pro-image",
        models: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
        writeRoots: [workspaceDir],
      },
      model: fakeModel,
      executor: fakeExecutor,
      store,
      emit: (ev: any) => emitted.push(ev),
    },
  });

  try {
    assert.equal(taskRes.status, "done");
    assert.equal(executorTouched, false, "pure image generation skips Ubuntu desktop screenshot");
    assert.equal(generateCalls.length, 1);
    assert.equal(generateCalls[0].model, "gemini-3.1-flash-image");
    assert.equal(generateCalls[0].aspectRatio, "16:9");
    assert.equal(generateCalls[0].referenceImages.length, 1);

    // Security check: reference_image_path outside writeRoots is rejected
    const deniedRes = await runBotCollabTool(
      "generate_image",
      {
        prompt: "Edit secret image",
        reference_image_path: outsidePath,
      },
      {
        store,
        model: fakeModel,
        config: { writeRoots: [workspaceDir] },
      }
    );
    assert.match(deniedRes.error || "", /denied/i);

    // Check usage events include gemini-3.1-flash-image
    const imgUsageEv = emitted.find(
      (e) => e.type === "usage" && e.model === "gemini-3.1-flash-image"
    );
    assert.ok(imgUsageEv, "emits usage event for Google image model");
    assert.equal(imgUsageEv.output, 1120);

    // Check file saved inside this Bot's exclusive <workspaceDir>/bots/<sessionId>/generated/
    const genDir = path.join(workspaceDir, "bots", session.id, "generated");
    const files = fs.readdirSync(genDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".png"));

    // Check final answer embeds inline [图片附件: ...](/api/workspace/file?path=...)
    const answerEv = emitted.find((e) => e.type === "answer");
    assert.ok(answerEv.text.includes("[图片附件:"));
    assert.ok(answerEv.text.includes("/api/workspace/file?path="));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("POST /api/images/generate creates image, updates session billing, and indexes into /api/sessions/:id/library", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-imgapi-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = createStore(path.join(tmpDir, "data"));
  const session = store.createSession({ title: "设计师 Bot" });

  const fakeModel = {
    async generateImage({ prompt, model, aspectRatio }: any) {
      assert.ok(prompt.includes("极简彩虹小机器人头像"));
      return {
        images: [{ data: SAMPLE_PNG_B64, mimeType: "image/png" }],
        text: "",
        usage: { input: 24, output: 1120 },
        usedModel: model || "gemini-3.1-flash-image",
      };
    },
  };

  const fakeRunner = {
    status: () => ({ sessionId: null, state: "idle", activeSessions: {} }),
    subscribe: () => () => {},
  };

  const srv = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      imageModel: "gemini-3.1-flash-image",
      proImageModel: "gemini-3-pro-image",
      writeRoots: [workspaceDir],
      dataDir: path.join(tmpDir, "data"),
    },
    store,
    runner: fakeRunner,
    model: fakeModel,
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as any;

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/images/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "极简彩虹小机器人头像",
        title: "彩虹头像",
        aspectRatio: "1:1",
        quality: "pro",
        sessionId: session.id,
      }),
    });
    assert.equal(resp.status, 201);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, "gemini-3-pro-image");
    assert.ok(body.url.startsWith("/api/workspace/file?path="));
    assert.ok(body.dataUrl.startsWith("data:image/png;base64,"));

    // Verify served file via /api/workspace/file
    const fileRes = await fetch(`http://127.0.0.1:${port}${body.url}`);
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get("content-type"), "image/png");

    // Verify library includes generated image
    const libRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${session.id}/library`
    ).then((r) => r.json());
    assert.ok(libRes.items.some((i: any) => i.type === "media" && i.url === body.url));

    // Verify session usageByModel recorded gemini-3-pro-image
    const updatedSession = store.getSession(session.id);
    assert.equal(updatedSession!.usageByModel["gemini-3-pro-image"].output, 1120);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runTask degrades to LLM-coded SVG by default when no image model is configured and guarantees degradation notice", async () => {
  resetUnavailableModels();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-svg-unconf-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = createStore(path.join(tmpDir, "data"));
  const session = store.createSession({ title: "Nori" });

  let generateImageCalled = false;
  let llmNextTurnCalls = 0;

  const fakeModel = {
    async nextTurn(opts: any) {
      llmNextTurnCalls += 1;
      // Call 1: agent decides to call generate_image
      if (llmNextTurnCalls === 1) {
        return {
          thoughts: ["调用 generate_image 绘制太阳图标"],
          text: "我帮你画一个太阳图标。",
          calls: [
            {
              id: "call_svg_1",
              name: "generate_image",
              args: {
                prompt: "Minimalist golden sun icon",
                title: "极简太阳图标",
                aspect_ratio: "16:9",
              },
            },
          ],
          outputSteps: [
            {
              type: "function_call",
              id: "call_svg_1",
              name: "generate_image",
              arguments: {
                prompt: "Minimalist golden sun icon",
                title: "极简太阳图标",
                aspect_ratio: "16:9",
              },
            },
          ],
          usage: { input: 200, output: 40 },
          usedModel: "ds::deepseek-chat",
        };
      }
      // Call 2: inside executeImageGenerationWithFallback -> generateSvgWithLlm
      if (opts.systemInstruction.includes("SVG")) {
        return {
          text: [
            "```svg",
            '<svg onclick="alert(1)"><script>evil()</script><rect width="100%" height="100%" fill="#0f172a"/><circle cx="640" cy="360" r="140" fill="#fbbf24"/></svg>',
            "```",
          ].join("\n"),
          calls: [],
          outputSteps: [],
          usage: { input: 180, output: 260 },
          usedModel: "ds::deepseek-chat",
          usedProviderId: "ds",
        };
      }
      // Call 3: agent final reply deliberately omits fallback notice to test loop.ts fallback guard
      return {
        text: "太阳图标已画好！",
        calls: [],
        outputSteps: [],
        usage: { input: 300, output: 20 },
        usedModel: "ds::deepseek-chat",
      };
    },
    async generateImage() {
      generateImageCalled = true;
      throw new Error("should not be called when unconfigured");
    },
  };

  const emitted: any[] = [];
  try {
    const taskRes = await runTask({
      sessionId: session.id,
      userText: "帮我画一个太阳图标",
      deps: {
        autoRoute: false,
        defaultModel: "ds::deepseek-chat",
        enableBotTools: true,
        config: {
          defaultModel: "ds::deepseek-chat",
          providers: [
            {
              id: "ds",
              type: "deepseek",
              name: "DeepSeek",
              apiKey: "sk-ds-test",
              models: ["deepseek-chat"],
              imageModels: [],
              enabled: true,
            },
          ],
          routing: {
            tiers: {
              fast: { providerId: "ds", model: "deepseek-chat" },
              medium: { providerId: "ds", model: "deepseek-chat" },
              advanced: { providerId: "ds", model: "deepseek-chat" },
            },
          },
          writeRoots: [workspaceDir],
        },
        model: fakeModel,
        executor: { call: async () => ({}) },
        store,
        emit: (ev: any) => emitted.push(ev),
      },
    });

    assert.equal(taskRes.status, "done");
    assert.equal(generateImageCalled, false);
    assert.equal(llmNextTurnCalls, 3);

    // Saved file must default to .svg with sanitized attributes inside this Bot's dedicated workspace
    const genDir = path.join(workspaceDir, "bots", session.id, "generated");
    const files = fs.readdirSync(genDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".svg"));
    const savedSvg = fs.readFileSync(path.join(genDir, files[0]), "utf-8");
    assert.ok(savedSvg.includes('xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(savedSvg.includes('viewBox="0 0 1280 720"'));
    assert.equal(savedSvg.includes("<script"), false);
    assert.equal(savedSvg.includes("onclick="), false);

    // Tool result carries degraded=true and unconfigured reason
    const toolResEv = emitted.find(
      (e) => e.type === "result" && e.name === "generate_image"
    );
    assert.ok(toolResEv);
    assert.equal(toolResEv.result.degraded, true);
    assert.equal(toolResEv.result.output_format, "svg");
    assert.match(toolResEv.result.degraded_reason, /未配置图像生成模型/);

    // Final answer embeds .svg attachment AND explains fallback + reason
    const answerEv = emitted.find((e) => e.type === "answer");
    assert.match(answerEv.text, /\[图片附件: .*\.svg\]\(\/api\/workspace\/file\?path=/);
    assert.match(answerEv.text, /降级/);
    assert.match(answerEv.text, /未配置图像生成模型/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("generate_image degrades to LLM SVG when configured image model fails unexpectedly (e.g. 429) and informs reason", async () => {
  resetUnavailableModels();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-svg-err-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = createStore(path.join(tmpDir, "data"));

  const fakeModel = {
    async generateImage() {
      const err: any = new Error("Resource exhausted");
      err.status = 429;
      throw err;
    },
    async nextTurn() {
      return {
        text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><circle cx="512" cy="512" r="300" fill="#38bdf8"/></svg>',
        usage: { input: 100, output: 150 },
        usedModel: "gemini-4-argon",
      };
    },
  };

  try {
    const res = await runBotCollabTool(
      "generate_image",
      { prompt: "Blue glowing orb", title: "蓝球" },
      {
        store,
        model: fakeModel,
        activeLlmModel: "gemini-4-argon",
        config: {
          routing: {
            tiers: {
              image: { providerId: "gem", model: "gemini-3.1-flash-image" },
              medium: { providerId: "gem", model: "gemini-4-argon" },
            },
          },
          providers: [
            {
              id: "gem",
              type: "gemini",
              apiKey: "AIzaFake",
              models: ["gemini-4-argon"],
              imageModels: ["gemini-3.1-flash-image"],
              enabled: true,
            },
          ],
          writeRoots: [workspaceDir],
        },
      }
    );

    assert.equal(res.ok, true);
    assert.equal(res.degraded, true);
    assert.equal(res.fallback_mode, "llm_svg");
    assert.equal(res.output_format, "svg");
    assert.equal(res.mime_type, "image/svg+xml");
    assert.ok(res.path.endsWith(".svg"));
    assert.match(res.degraded_reason, /429|限流|配额/);
    assert.match(res.fallback_notice, /大语言模型/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("generate_image fallback converts SVG to requested format ONLY when user explicitly specifies output_format", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-svg-conv-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = createStore(path.join(tmpDir, "data"));

  const fakeModel = {
    async generateImage() {
      const err: any = new Error("Invalid API key");
      err.status = 401;
      throw err;
    },
    async nextTurn() {
      return {
        text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><rect width="256" height="256" fill="#0f172a"/><polygon points="128,24 224,224 32,224" fill="#22d3ee"/></svg>',
        usage: { input: 80, output: 110 },
        usedModel: "oa::gpt-4o",
      };
    },
  };

  try {
    // 1. Real system converter SVG -> PNG
    const pngRes = await runBotCollabTool(
      "generate_image",
      {
        prompt: "Cyan triangle badge",
        title: "三角徽章",
        output_format: "png",
      },
      {
        store,
        model: fakeModel,
        activeLlmModel: "oa::gpt-4o",
        config: {
          routing: {
            tiers: {
              image: { providerId: "oa", model: "gpt-image-1" },
              medium: { providerId: "oa", model: "gpt-4o" },
            },
          },
          providers: [
            {
              id: "oa",
              type: "openai",
              apiKey: "sk-fake",
              models: ["gpt-4o"],
              imageModels: ["gpt-image-1"],
              enabled: true,
            },
          ],
          writeRoots: [workspaceDir],
        },
      }
    );

    assert.equal(pngRes.ok, true);
    assert.equal(pngRes.degraded, true);
    assert.equal(pngRes.converted_from_svg, true);
    assert.equal(pngRes.output_format, "png");
    assert.equal(pngRes.mime_type, "image/png");
    assert.ok(pngRes.path.endsWith(".png"));
    assert.match(pngRes.degraded_reason, /鉴权失败/);

    const pngBytes = fs.readFileSync(pngRes.path);
    assert.equal(pngBytes.subarray(0, 4).toString("hex"), "89504e47", "must be valid PNG signature");

    // 2. Real system converter SVG -> JPG via convertImageBuffer
    const jpgConv = await convertImageBuffer({
      inputBuffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><rect width="128" height="128" fill="#ef4444"/></svg>',
        "utf-8"
      ),
      inputMimeType: "image/svg+xml",
      targetFormat: "jpg",
    });
    assert.equal(jpgConv.format, "jpg");
    assert.equal(jpgConv.mimeType, "image/jpeg");
    assert.equal(jpgConv.buffer[0], 0xff);
    assert.equal(jpgConv.buffer[1], 0xd8);
    assert.equal(jpgConv.buffer[2], 0xff);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("executeImageGenerationWithFallback does not degrade when caller signal is aborted", async () => {
  const controller = new AbortController();
  let nextTurnCalled = false;

  const fakeModel = {
    async generateImage() {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
    async nextTurn() {
      nextTurnCalled = true;
      return { text: "<svg></svg>" };
    },
  };

  await assert.rejects(
    () =>
      executeImageGenerationWithFallback({
        model: fakeModel,
        prompt: "Test abort",
        config: { imageModel: "gemini-3.1-flash-image" },
        signal: controller.signal,
      }),
    (err: any) => err?.name === "AbortError"
  );
  assert.equal(nextTurnCalled, false);
});

test("POST /api/images/convert & /api/images/generate fallback APIs work end-to-end with security checks", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-imgconv-api-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = createStore(path.join(tmpDir, "data"));
  const session = store.createSession({ title: "矢量设计师 Bot" });
  store.writeSettings({
    providers: [
      {
        id: "ds",
        type: "deepseek",
        name: "DeepSeek",
        apiKey: "sk-ds-fake",
        models: ["deepseek-chat"],
        imageModels: [],
        enabled: true,
      },
    ],
    routing: {
      tiers: {
        fast: { providerId: "ds", model: "deepseek-chat" },
        medium: { providerId: "ds", model: "deepseek-chat" },
        advanced: { providerId: "ds", model: "deepseek-chat" },
      },
    },
  });

  const fakeModel = {
    async nextTurn() {
      return {
        text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><rect width="200" height="200" fill="#1e293b"/><circle cx="100" cy="100" r="70" fill="#10b981"/></svg>',
        usage: { input: 60, output: 140 },
        usedModel: "ds::deepseek-chat",
        usedProviderId: "ds",
      };
    },
  };

  const srv = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      writeRoots: [workspaceDir],
      dataDir: path.join(tmpDir, "data"),
    },
    store,
    runner: {
      status: () => ({ sessionId: null, state: "idle", activeSessions: {} }),
      subscribe: () => () => {},
    },
    model: fakeModel,
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as any;

  try {
    // 1. /api/images/generate degrades to SVG when no image tier is configured
    const genResp = await fetch(`http://127.0.0.1:${port}/api/images/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "翡翠绿圆徽章",
        title: "翡翠徽章",
        sessionId: session.id,
      }),
    });
    assert.equal(genResp.status, 201);
    const genBody = await genResp.json();
    assert.equal(genBody.ok, true);
    assert.equal(genBody.degraded, true);
    assert.equal(genBody.outputFormat, "svg");
    assert.equal(genBody.mimeType, "image/svg+xml");
    assert.ok(genBody.path.endsWith(".svg"));
    assert.match(genBody.degradedReason, /未配置图像生成模型/);
    assert.ok(genBody.dataUrl.startsWith("data:image/svg+xml;base64,"));

    // 2. /api/images/convert converts that generated .svg file into .png
    const convResp = await fetch(`http://127.0.0.1:${port}/api/images/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: genBody.path,
        format: "png",
        title: "翡翠徽章_导出",
      }),
    });
    assert.equal(convResp.status, 201);
    const convBody = await convResp.json();
    assert.equal(convBody.ok, true);
    assert.equal(convBody.format, "png");
    assert.equal(convBody.mimeType, "image/png");
    assert.ok(convBody.path.endsWith(".png"));
    const fetchedPng = await fetch(`http://127.0.0.1:${port}${convBody.url}`);
    assert.equal(fetchedPng.status, 200);
    assert.equal(fetchedPng.headers.get("content-type"), "image/png");

    // 3. Path outside writeRoots is rejected
    const outsideFile = path.join(tmpDir, "outside.svg");
    fs.writeFileSync(outsideFile, "<svg></svg>");
    const deniedResp = await fetch(`http://127.0.0.1:${port}/api/images/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: outsideFile, format: "png" }),
    });
    assert.equal(deniedResp.status, 403);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("declarations, system prompt, and SVG sanitizer expose fallback and /api/images/convert contract", async () => {
  const genDecl = BOT_COLLAB_TOOL_DECLARATIONS.find((d) => d.name === "generate_image");
  assert.ok(genDecl);
  assert.ok(genDecl.parameters.properties.output_format);
  assert.equal(
    genDecl.parameters.properties.output_format.enum.includes("svg"),
    false,
    "output_format enum should exclude svg so explicit SVG code requests do not hijack generate_image"
  );
  assert.match(genDecl.description, /DO NOT call `generate_image`/i);
  assert.match(genDecl.description, /\/api\/images\/convert/);
  assert.match(genDecl.description, /SVG/i);

  // No standalone convert_image tool declaration added
  assert.equal(
    BOT_COLLAB_TOOL_DECLARATIONS.some((d) => d.name === "convert_image"),
    false
  );

  const sysUnconfigured = buildSystemInstruction({
    enableBotTools: true,
    providers: [],
    routing: { tiers: {} },
  });
  assert.match(sysUnconfigured, /generate_image/);
  assert.match(sysUnconfigured, /SKIP `generate_image` completely/);
  assert.match(sysUnconfigured, /\/api\/images\/convert/);

  const sanitized = extractAndSanitizeSvg(
    '<svg width="100%" height="100%" onload="bad()"><script>x()</script><text>J &amp; R & Co</text><circle cx="10" cy="10" r="5"/></svg>',
    800,
    600
  );
  assert.ok(sanitized.includes('viewBox="0 0 800 600"'));
  assert.ok(sanitized.includes('width="800"'));
  assert.ok(sanitized.includes('height="600"'));
  assert.ok(sanitized.includes("J &amp; R &amp; Co"));
  assert.equal(sanitized.includes("<script"), false);
  assert.equal(sanitized.includes("onload="), false);

  const fastFirst = resolveSvgFallbackModels({
    preferFast: true,
    config: {
      routing: {
        tiers: {
          fast: { providerId: "ds", model: "deepseek-flash" },
          medium: { providerId: "ds", model: "deepseek-v4-pro" },
        },
      },
    },
  });
  assert.equal(fastFirst[0], "ds::deepseek-flash");

  // Verify DeepSeek driver passes reasoning_effort: "none" when thinkingLevel === "none"
  const sentBodies: any[] = [];
  const dsDriver = createOpenAiCompatDriver({
    apiKey: "sk-ds",
    baseUrl: "https://api.deepseek.com/v1",
    providerType: "deepseek",
    fetchImpl: async (_url, init: any) => {
      sentBodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          model: "deepseek-flash",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });
  await dsDriver.nextTurn({
    model: "deepseek-flash",
    thinkingLevel: "none",
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(sentBodies[0].reasoning_effort, "none");
});
