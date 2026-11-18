import test from "node:test";
import assert from "node:assert/strict";
import { pruneScreenshots, trimHistory } from "../src/agent/context.js";
import { userStep, toolResultSteps } from "../src/agent/model.js";

function countImages(steps: any[]) {
  let count = 0;
  for (const step of steps) {
    if (step && Array.isArray(step.content)) {
      for (const part of step.content) {
        if (part && part.type === "image") {
          count++;
        }
      }
    }
  }
  return count;
}

test("pruneScreenshots keeps last N images", () => {
  const input = [1, 2, 3, 4, 5].map((n) => userStep(`s${n}`, Buffer.from([n])));
  const out = pruneScreenshots(input, 3);
  assert.equal(countImages(out), 3);
  assert.equal(countImages(input), 5); // input unchanged
  assert.match(JSON.stringify(out[0]), /screenshot from an earlier step omitted/);
  assert.match(JSON.stringify(out[1]), /screenshot from an earlier step omitted/);
  assert.doesNotMatch(JSON.stringify(out[2]), /screenshot from an earlier step omitted/);
  assert.doesNotMatch(JSON.stringify(out[4]), /screenshot from an earlier step omitted/);
});

test("pruneScreenshots with keep <= 0 replaces all images", () => {
  const input = [1, 2, 3].map((n) => userStep(`s${n}`, Buffer.from([n])));
  const out = pruneScreenshots(input, 0);
  assert.equal(countImages(out), 0);
  assert.equal(countImages(input), 3);
  for (const step of out) {
    assert.match(JSON.stringify(step), /screenshot from an earlier step omitted/);
  }

  const outNeg = pruneScreenshots(input, -2);
  assert.equal(countImages(outNeg), 0);
});

test("pruneScreenshots with keep >= total images retains all images", () => {
  const input = [1, 2].map((n) => userStep(`s${n}`, Buffer.from([n])));
  const out = pruneScreenshots(input, 5);
  assert.equal(countImages(out), 2);
  assert.doesNotMatch(JSON.stringify(out), /screenshot from an earlier step omitted/);
});

test("pruneScreenshots preserves non-image steps and content intact", () => {
  const call = { id: "call_1", name: "click" };
  const input = [
    userStep("Step 1", Buffer.from([1])),
    ...toolResultSteps(call, { ok: true }, Buffer.from([2])),
    userStep("Step 3 without image", null),
    userStep("Step 4", Buffer.from([3])),
  ];

  assert.equal(countImages(input), 3);
  const out = pruneScreenshots(input, 1);
  assert.equal(countImages(out), 1);
  assert.equal(out.length, input.length);

  // First two images pruned
  assert.match(JSON.stringify(out[0]), /screenshot from an earlier step omitted/);
  assert.match(JSON.stringify(out[2]), /screenshot from an earlier step omitted/);
  // function_result preserved
  assert.equal(out[1].type, "function_result");
  assert.equal(out[1].call_id, "call_1");
  // Step 3 text preserved
  assert.equal(out[3].content[0].text, "Step 3 without image");
  // Last image kept
  assert.equal(out[4].content[1].type, "image");
});

test("pruneScreenshots does not mutate input or inner arrays", () => {
  const originalStep = userStep("orig", Buffer.from([99]));
  const input = [originalStep];
  const originalJson = JSON.stringify(input);

  const out = pruneScreenshots(input, 0);
  assert.notEqual(out, input);
  assert.notEqual(out[0], originalStep);
  assert.notEqual(out[0].content, originalStep.content);
  assert.equal(JSON.stringify(input), originalJson);
});

test("pruneScreenshots handles non-array or empty input", () => {
  assert.deepEqual(pruneScreenshots([], 3), []);
  assert.deepEqual(pruneScreenshots(null as any, 3), []);
  assert.deepEqual(pruneScreenshots(undefined as any, 3), []);
});

test("trimHistory drops stale thought steps from prior turns while keeping current-turn thoughts", () => {
  const input = [
    userStep("turn 1"),
    { type: "thought", signature: "old-sig-1", summary: [{ type: "text", text: "t1" }] },
    { type: "model_output", content: [{ type: "text", text: "ans 1" }] },
    userStep("turn 2"),
    { type: "thought", signature: "cur-sig-2", summary: [{ type: "text", text: "t2" }] },
    { type: "function_call", id: "c2", name: "screenshot", arguments: {} },
    ...toolResultSteps({ id: "c2", name: "screenshot" }, { ok: true }, null),
  ];

  const out = trimHistory(input, 24);
  assert.equal(out.some((s) => s.signature === "old-sig-1"), false);
  assert.equal(out.some((s) => s.signature === "cur-sig-2"), true);
});
