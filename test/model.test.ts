import test from "node:test";
import assert from "node:assert/strict";
import { userStep, toolResultSteps, createModel } from "../src/agent/model.js";

test("userStep creates step without image when png is null or undefined", () => {
  const step = userStep("Open browser", null);
  assert.deepEqual(step, {
    type: "user_input",
    content: [{ type: "text", text: "Open browser" }],
  });

  const stepUndef = userStep("Just text");
  assert.deepEqual(stepUndef, {
    type: "user_input",
    content: [{ type: "text", text: "Just text" }],
  });
});

test("userStep creates step with base64 image when png Buffer is provided", () => {
  const buf = Buffer.from("fake-png-data");
  const step = userStep("Click here", buf);
  assert.deepEqual(step, {
    type: "user_input",
    content: [
      { type: "text", text: "Click here" },
      { type: "image", data: buf.toString("base64"), mime_type: "image/png" },
    ],
  });
});

test("userStep infers image/jpeg and image/webp mime_type from magic bytes", () => {
  const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const jpegStep = userStep("Window JPEG", jpegBuf);
  assert.equal(jpegStep.content[1].mime_type, "image/jpeg");

  const webpBuf = Buffer.from("RIFF\x00\x00\x00\x00WEBP", "binary");
  const webpStep = userStep("Window WebP", webpBuf);
  assert.equal(webpStep.content[1].mime_type, "image/webp");
});

test("userStep accepts multiple image descriptors/buffers for user attachments", () => {
  const pngBuf = Buffer.from("fake-png-data");
  const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const step = userStep("Check both images", [
    { data: pngBuf.toString("base64"), mimeType: "image/png" },
    jpegBuf,
  ]);
  assert.equal(step.type, "user_input");
  assert.equal(step.content.length, 3);
  assert.equal(step.content[1].type, "image");
  assert.equal(step.content[1].mime_type, "image/png");
  assert.equal(step.content[2].type, "image");
  assert.equal(step.content[2].mime_type, "image/jpeg");
});

test("toolResultSteps returns single function_result step when png is null", () => {
  const call = { id: "call_123", name: "run_shell", args: { command: "ls" } };
  const steps = toolResultSteps(call, { exitCode: 0, stdout: "file.txt" }, null);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], {
    type: "function_result",
    call_id: "call_123",
    name: "run_shell",
    result: JSON.stringify({ exitCode: 0, stdout: "file.txt" }),
  });
});

test("toolResultSteps handles string result directly", () => {
  const call = { id: "call_456", name: "read_file" };
  const steps = toolResultSteps(call, "file contents here");
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], {
    type: "function_result",
    call_id: "call_456",
    name: "read_file",
    result: "file contents here",
  });
});

test("toolResultSteps returns function_result followed by user_input with screen when png is present", () => {
  const call = { id: "call_789", name: "click" };
  const buf = Buffer.from("screen-pixels");
  const steps = toolResultSteps(call, { ok: true }, buf);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], {
    type: "function_result",
    call_id: "call_789",
    name: "click",
    result: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(steps[1], {
    type: "user_input",
    content: [
      { type: "text", text: "Current screen:" },
      { type: "image", data: buf.toString("base64"), mime_type: "image/png" },
    ],
  });
});

test("nextTurn passes tools, system instruction, store:false every call", async () => {
  const calls: any[] = [];
  const fakeClient = {
    interactions: {
      async create(params: any, options: any) {
        calls.push({ params, options });
        return {
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "Done" }],
            },
          ],
          usage: {
            total_input_tokens: 100,
            total_output_tokens: 20,
          },
        };
      },
    },
  };

  const model = createModel({ client: fakeClient });
  const tools = [{ type: "function", name: "click" }];
  const input = [{ type: "user_input", content: [{ type: "text", text: "hello" }] }];
  const controller = new AbortController();

  await model.nextTurn({
    model: "gemini-4-argon",
    systemInstruction: "You are TwinkleBot",
    tools,
    input,
    signal: controller.signal,
  });

  assert.equal(calls.length, 1);
  const { params, options } = calls[0];
  assert.equal(params.model, "gemini-4-argon");
  assert.equal(params.system_instruction, "You are TwinkleBot");
  assert.deepEqual(params.tools, tools);
  assert.deepEqual(params.input, input);
  assert.equal(params.store, false);
  assert.deepEqual(params.generation_config, {
    thinking_summaries: "auto",
    thinking_level: "low",
  });
  assert.equal(options?.signal, controller.signal);
});

test("nextTurn extracts calls, text, thoughts, usage", async () => {
  const fakeClient = {
    interactions: {
      async create() {
        return {
          steps: [
            {
              type: "thought",
              signature: "sig123",
              summary: "I will click the button at 100, 200",
            },
            {
              type: "thought",
              summary: [{ type: "text", text: "Second thought summary" }],
            },
            {
              type: "model_output",
              content: [{ type: "text", text: "Clicking start..." }],
            },
            {
              id: "call_001",
              type: "function_call",
              name: "click",
              arguments: { x: 100, y: 200 },
            },
          ],
          usage: {
            total_input_tokens: 350,
            total_output_tokens: 42,
          },
        };
      },
    },
  };

  const model = createModel({ client: fakeClient });
  const turn = await model.nextTurn({
    model: "gemini-4-argon",
    systemInstruction: "test",
    tools: [],
    input: [],
  });

  assert.deepEqual(turn.thoughts, [
    "I will click the button at 100, 200",
    "Second thought summary",
  ]);
  assert.equal(turn.text, "Clicking start...");
  assert.equal(turn.calls!.length, 1);
  assert.deepEqual(turn.calls![0], {
    id: "call_001",
    name: "click",
    args: { x: 100, y: 200 },
  });
  assert.deepEqual(turn.usage, {
    input: 350,
    output: 42,
  });
  assert.equal(turn.outputSteps!.length, 4);
});

test("nextTurn handles fallback step and usage structures", async () => {
  const fakeClient = {
    interactions: {
      async create() {
        return {
          outputs: [
            {
              type: "text",
              text: "Plain text answer",
            },
            {
              id: "call_002",
              type: "function_call",
              name: "open_url",
              args: { url: "https://example.com" },
            },
          ],
          usage: {
            input_tokens: 120,
            output_tokens: 15,
          },
        };
      },
    },
  };

  const model = createModel({ client: fakeClient });
  const turn = await model.nextTurn({
    model: "gemini-4-argon",
    systemInstruction: "test",
    tools: [],
    input: [],
  });

  assert.equal(turn.text, "Plain text answer");
  assert.deepEqual(turn.calls, [
    {
      id: "call_002",
      name: "open_url",
      args: { url: "https://example.com" },
    },
  ]);
  assert.deepEqual(turn.usage, { input: 120, output: 15 });
  assert.equal(turn.outputSteps!.length, 2);
});

test("Phase 5 P1-1: gemini driver sets thinking_summaries=none when thinkingLevel is minimal or none", async () => {
  const seenConfigs: any[] = [];
  const fakeClient = {
    interactions: {
      async create(params: any) {
        seenConfigs.push(params.generation_config);
        return {
          outputs: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };

  const model = createModel({ client: fakeClient });
  await model.nextTurn({
    model: "gemini-4-hydrogen",
    thinkingLevel: "minimal",
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });
  await model.nextTurn({
    model: "gemini-4-hydrogen",
    thinkingLevel: "none",
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });
  await model.nextTurn({
    model: "gemini-4-hydrogen",
    thinkingLevel: "low",
    input: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
  });

  assert.deepEqual(seenConfigs, [
    { thinking_summaries: "none", thinking_level: "minimal" },
    { thinking_summaries: "none", thinking_level: "minimal" },
    { thinking_summaries: "auto", thinking_level: "low" },
  ]);
});
