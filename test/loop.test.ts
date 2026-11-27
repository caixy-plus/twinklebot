import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildApprovalContextSummary,
  createControl,
  formatPreviousTurnCompletionHeader,
  runTask,
  truncateForDisplay,
} from "../src/agent/loop.js";
import { BOT_COLLAB_TOOL_DECLARATIONS, filterToolDeclarationsForSkills } from "../src/agent/bot-tools.js";
import { createStore } from "../src/store/index.js";
import { ExecutorError } from "../src/agent/executor-client.js";

function createTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-loop-test-"));
  const store = createStore(dir);
  return {
    store,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createFakeExecutor({
  screenshotPng = "mock-png-bytes",
  routes = {},
}: any = {}) {
  const calls: any[] = [];
  return {
    calls,
    async call(route: any, body: any) {
      calls.push({ route, body });
      if (typeof routes[route] === "function") {
        return routes[route](body);
      }
      if (routes[route] !== undefined) {
        return routes[route];
      }
      if (route === "/screenshot") {
        return {
          png_base64: Buffer.isBuffer(screenshotPng)
            ? screenshotPng.toString("base64")
            : Buffer.from(screenshotPng).toString("base64"),
          width: 1440,
          height: 900,
        };
      }
      return { ok: true };
    },
  };
}

function createFakeModel(turns: any[] = []) {
  const queue = [...turns];
  const historyCalls: any[] = [];
  return {
    historyCalls,
    async nextTurn({ model, systemInstruction, tools, input, signal }: any) {
      historyCalls.push({ model, systemInstruction, tools, input, signal });
      if (queue.length === 0) {
        return {
          thoughts: [],
          text: "default fallback answer",
          calls: [] as any[],
          outputSteps: [],
          usage: { input: 0, output: 0 },
        };
      }
      const turn = queue.shift();
      if (turn instanceof Error) throw turn;
      if (typeof turn === "function") {
        return turn({ model, systemInstruction, tools, input, signal });
      }
      return turn;
    },
  };
}

test("finishes when the model answers without calls", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Finishes task" });
    const events: any[] = [];
    const emit = (e: any) => events.push(e);

    const executor = createFakeExecutor({
      routes: {
        "/click": { ok: true },
      },
    });

    const model = createFakeModel([
      {
        thoughts: ["Click the start button"],
        calls: [
          {
            id: "call_click_1",
            name: "click",
            args: { x: 200, y: 300, risk: "low" },
          },
        ],
        outputSteps: [
          {
            type: "function_call",
            id: "call_click_1",
            name: "click",
            args: { x: 200, y: 300 },
          },
        ],
        usage: { input: 15, output: 25 },
      },
      {
        thoughts: ["Everything done"],
        text: "完成",
        calls: [] as any[],
        outputSteps: [
          {
            type: "model_output",
            text: "完成",
          },
        ],
        usage: { input: 30, output: 40 },
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "点击开始",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 10, keepScreenshots: 3, settleMs: 0 },
        emit,
      },
    });

    assert.equal(res.status, "done");
    assert.equal(res.text, "完成");

    // Check emitted events
    const eventTypes = events.map((e) => e.type);
    assert.ok(eventTypes.includes("user"));
    assert.ok(eventTypes.includes("action"));
    assert.ok(eventTypes.includes("result"));
    assert.ok(eventTypes.includes("thought"));
    assert.ok(eventTypes.includes("usage"));
    assert.ok(eventTypes.includes("answer"));
    assert.ok(eventTypes.includes("status"));

    const userEvt = events.find((e) => e.type === "user");
    assert.equal(userEvt.text, "点击开始");

    const actionEvt = events.find((e) => e.type === "action");
    assert.equal(actionEvt.callId, "call_click_1");
    assert.equal(actionEvt.name, "click");

    const resultEvt = events.find((e) => e.type === "result");
    assert.equal(resultEvt.callId, "call_click_1");
    assert.equal(resultEvt.name, "click");
    assert.equal(resultEvt.screenshot, "0001.png");

    const answerEvt = events.find((e) => e.type === "answer");
    assert.equal(answerEvt.text, "完成");

    const finalStatus = events.filter((e) => e.type === "status").at(-1);
    assert.equal(finalStatus.status, "done");

    // Session status updated in store
    const updatedSession = store.getSession(session.id);
    assert.equal(updatedSession!.status, "done");
  } finally {
    cleanup();
  }
});

test("confirm decision waits for approval; decline sends error result", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Confirm test" });
    const events: any[] = [];
    const control = createControl();

    const emit = (e: any) => {
      events.push(e);
      if (e.type === "approval_request" && e.callId === "call_shell_rm") {
        // As soon as approval is requested, decline it
        control.resolveApproval(e.callId, false);
      }
    };

    const executor = createFakeExecutor();

    const model = createFakeModel([
      {
        thoughts: ["Try rm command"],
        calls: [
          {
            id: "call_shell_rm",
            name: "run_shell",
            args: { command: "rm -rf /tmp/important" },
          },
        ],
        outputSteps: [
          {
            type: "function_call",
            id: "call_shell_rm",
            name: "run_shell",
            args: { command: "rm -rf /tmp/important" },
          },
        ],
        usage: { input: 10, output: 10 },
      },
      {
        thoughts: ["User declined, finishing"],
        text: "User refused to delete",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "User refused to delete" }],
        usage: { input: 20, output: 20 },
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "Delete the files",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0, sandboxMode: "restricted" },
        emit,
      },
      control,
    });

    assert.equal(res.status, "done");
    assert.equal(res.text, "User refused to delete");

    // Executor should NEVER have received /shell
    const shellCalls = executor.calls.filter((c) => c.route === "/shell");
    assert.equal(shellCalls.length, 0);

    // Approval request and approval response emitted
    const reqEvt = events.find((e) => e.type === "approval_request");
    assert.ok(reqEvt);
    assert.equal(reqEvt.callId, "call_shell_rm");

    const appEvt = events.find((e) => e.type === "approval");
    assert.ok(appEvt);
    assert.equal(appEvt.callId, "call_shell_rm");
    assert.equal(appEvt.allowed, false);

    const resEvt = events.find((e) => e.type === "result");
    assert.ok(resEvt);
    assert.equal(resEvt.callId, "call_shell_rm");
    assert.equal(resEvt.result.error, "the user declined this action");

    // Next model turn input should contain the decline error message
    assert.equal(model.historyCalls.length, 2);
    const secondTurnInput = model.historyCalls[1].input;
    const secondTurnStr = JSON.stringify(secondTurnInput);
    assert.ok(
      secondTurnStr.includes("the user declined this action"),
      "next model turn must include decline error"
    );
  } finally {
    cleanup();
  }
});

test("deny decision never reaches executor", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Deny test" });
    const events: any[] = [];
    const emit = (e: any) => events.push(e);

    const executor = createFakeExecutor();

    const model = createFakeModel([
      {
        thoughts: ["Read SSH key"],
        calls: [
          {
            id: "call_read_ssh",
            name: "read_file",
            args: { path: "/Users/YOUR_USERNAME/.ssh/id_rsa" },
          },
        ],
        outputSteps: [
          {
            type: "function_call",
            id: "call_read_ssh",
            name: "read_file",
            args: { path: "/Users/YOUR_USERNAME/.ssh/id_rsa" },
          },
        ],
      },
      {
        thoughts: ["Access denied, finish"],
        text: "I cannot read your SSH key",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "I cannot read your SSH key" }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "Read my ssh key",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit,
      },
    });

    assert.equal(res.status, "done");

    // Executor never received /read
    const readCalls = executor.calls.filter((c) => c.route === "/read");
    assert.equal(readCalls.length, 0);

    // Emitted result error starts with "denied by policy"
    const resEvt = events.find((e) => e.type === "result");
    assert.ok(resEvt);
    assert.equal(resEvt.callId, "call_read_ssh");
    assert.ok(
      typeof resEvt.result.error === "string" &&
        resEvt.result.error.startsWith("denied by policy"),
      `expected "denied by policy...", got ${resEvt.result.error}`
    );
  } finally {
    cleanup();
  }
});

test("stops at maxSteps", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Max steps test" });
    const events: any[] = [];
    const emit = (e: any) => events.push(e);

    const executor = createFakeExecutor();

    // Model always returns a screenshot tool call
    let callCounter = 0;
    const model = {
      historyCalls: [] as any[],
      async nextTurn({ model: m, systemInstruction, tools, input, signal }: any) {
        this.historyCalls.push({ model: m, systemInstruction, tools, input, signal });
        callCounter++;
        return {
          thoughts: [`Step ${callCounter}`],
          calls: [
            {
              id: `call_shot_${callCounter}`,
              name: "screenshot",
              args: {},
            },
          ],
          outputSteps: [
            {
              type: "function_call",
              id: `call_shot_${callCounter}`,
              name: "screenshot",
              args: {},
            },
          ],
          usage: { input: 10, output: 10 },
        };
      },
    };

    const res = await runTask({
      sessionId: session.id,
      userText: "Infinite screenshots",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 2, settleMs: 0 },
        emit,
      },
    });

    assert.equal(res.status, "max_steps");
    assert.match(res.text, /已达到单轮最大步数上限（2 步）/);
    assert.match(res.text, /已完成 2 次操作/);
    assert.match(res.text, /继续/);
    assert.equal(model.historyCalls.length, 2);

    const notice = events.find((e) => e.type === "route_notice" && e.level === "max_steps");
    assert.ok(notice, "must emit user-visible route_notice when reaching maxSteps");
    assert.equal(notice.maxSteps, 2);
    assert.equal(notice.toolCount, 2);
    assert.equal(notice.text, res.text);

    const savedHist = store.loadHistory(session.id);
    assert.equal(savedHist.at(-1)?.type, "model_output");

    const lastStatus = events.filter((e) => e.type === "status").at(-1);
    assert.equal(lastStatus.status, "max_steps");
  } finally {
    cleanup();
  }
});

test("stop() ends the task before the next model call", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Stop test" });
    const events: any[] = [];
    const control = createControl();

    const emit = (e: any) => {
      events.push(e);
      if (e.type === "result") {
        // Stop control right after the first tool result is emitted
        control.stop();
      }
    };

    const executor = createFakeExecutor();

    const model = createFakeModel([
      {
        thoughts: ["Take a screenshot"],
        calls: [{ id: "call_1", name: "screenshot", args: {} }],
        outputSteps: [{ type: "function_call", id: "call_1", name: "screenshot", args: {} }],
      },
      {
        thoughts: ["Should not be reached"],
        text: "Should never happen",
        calls: [] as any[],
        outputSteps: [],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "Take screenshot and stop",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit,
      },
      control,
    });

    assert.equal(res.status, "stopped");
    assert.equal(res.text, "");
    assert.equal(model.historyCalls.length, 1);

    const lastStatus = events.filter((e) => e.type === "status").at(-1);
    assert.equal(lastStatus.status, "stopped");
  } finally {
    cleanup();
  }
});

test("resume after pause adds a fresh screenshot step", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Pause resume test" });
    const events: any[] = [];
    const control = createControl();

    const executor = createFakeExecutor({
      screenshotPng: "resume-screen-png",
    });

    let pausedOnce = false;
    const emit = (e: any) => {
      events.push(e);
      if (e.type === "result" && !pausedOnce) {
        pausedOnce = true;
        control.pause();
        // Resume asynchronously
        setTimeout(() => {
          control.resume();
        }, 10);
      }
    };

    const model = createFakeModel([
      {
        thoughts: ["Step 1 screenshot"],
        calls: [{ id: "call_shot_1", name: "screenshot", args: {} }],
        outputSteps: [{ type: "function_call", id: "call_shot_1", name: "screenshot", args: {} }],
      },
      {
        thoughts: ["Done after resume"],
        text: "Finished after pause and resume",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "Finished after pause and resume" }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "Test pause",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit,
      },
      control,
    });

    assert.equal(res.status, "done");
    assert.equal(res.text, "Finished after pause and resume");
    assert.equal(model.historyCalls.length, 2);

    // Second turn input must include the pause note
    const secondInput = model.historyCalls[1].input;
    const pauseStep = secondInput.find(
      (s: any) =>
        s.type === "user_input" &&
        s.content?.some((c: any) =>
          c.text?.includes("The user paused and may have changed the screen")
        )
    );
    assert.ok(pauseStep, "must contain resume note user step");
    const imgPart = pauseStep.content.find((c: any) => c.type === "image");
    assert.ok(imgPart, "resume user step must include image");
  } finally {
    cleanup();
  }
});

test("executor down at start → error status, no model call", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Executor down test" });
    const events: any[] = [];
    const emit = (e: any) => events.push(e);

    const executor = {
      calls: [] as any[],
      async call(route: any, body: any) {
        this.calls.push({ route, body });
        throw new ExecutorError("executor unreachable: ECONNREFUSED", 0);
      },
    };

    const model = createFakeModel([]);

    const res = await runTask({
      sessionId: session.id,
      userText: "Hello when executor is down",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit,
      },
    });

    assert.equal(res.status, "error");
    assert.ok(res.text.includes("executor unreachable"));
    assert.equal(model.historyCalls.length, 0);

    const errorEvt = events.find((e) => e.type === "error");
    assert.ok(errorEvt);
    assert.ok(errorEvt.message.includes("executor unreachable"));

    const lastStatus = events.filter((e) => e.type === "status").at(-1);
    assert.equal(lastStatus.status, "error");
  } finally {
    cleanup();
  }
});

test("history saved after each step is pruned to 3 images", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Pruning test" });
    const events: any[] = [];
    const emit = (e: any) => events.push(e);

    const executor = createFakeExecutor({
      routes: {
        "/click": { ok: true },
      },
    });

    // 4 click turns (each adds a screenshot) + 1 finish turn
    const turns = [
      {
        thoughts: ["Click 1"],
        calls: [{ id: "c1", name: "click", args: { x: 10, y: 10 } }],
        outputSteps: [{ type: "function_call", id: "c1", name: "click", args: { x: 10, y: 10 } }],
      },
      {
        thoughts: ["Click 2"],
        calls: [{ id: "c2", name: "click", args: { x: 20, y: 20 } }],
        outputSteps: [{ type: "function_call", id: "c2", name: "click", args: { x: 20, y: 20 } }],
      },
      {
        thoughts: ["Click 3"],
        calls: [{ id: "c3", name: "click", args: { x: 30, y: 30 } }],
        outputSteps: [{ type: "function_call", id: "c3", name: "click", args: { x: 30, y: 30 } }],
      },
      {
        thoughts: ["Click 4"],
        calls: [{ id: "c4", name: "click", args: { x: 40, y: 40 } }],
        outputSteps: [{ type: "function_call", id: "c4", name: "click", args: { x: 40, y: 40 } }],
      },
      {
        thoughts: ["Done"],
        text: "Finished 4 clicks",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "Finished 4 clicks" }],
      },
    ];

    const model = createFakeModel(turns);

    const res = await runTask({
      sessionId: session.id,
      userText: "Perform 4 clicks",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 10, keepScreenshots: 3, settleMs: 0 },
        emit,
      },
    });

    assert.equal(res.status, "done");

    // History saved in store should have at most 3 images retained
    const savedHistory = store.loadHistory(session.id);
    assert.ok(savedHistory.length > 0);

    let imageCount = 0;
    let omittedCount = 0;
    for (const step of savedHistory) {
      if (Array.isArray(step.content)) {
        for (const part of step.content) {
          if (part.type === "image") imageCount++;
          if (
            part.type === "text" &&
            part.text?.includes("screenshot from an earlier step omitted")
          ) {
            omittedCount++;
          }
        }
      }
    }

    assert.equal(imageCount, 3);
    assert.ok(omittedCount >= 1, "at least 1 image was pruned to placeholder");
  } finally {
    cleanup();
  }
});

test("stop() while awaiting approval cancels approval and stops task", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Stop during approval" });
    const events: any[] = [];
    const control = createControl();

    const emit = (e: any) => {
      events.push(e);
      if (e.type === "approval_request") {
        // Stop the task instead of approving/declining
        control.stop();
      }
    };

    const executor = createFakeExecutor();

    const model = createFakeModel([
      {
        calls: [
          {
            id: "call_shell_rm2",
            name: "run_shell",
            args: { command: "rm -rf something" },
          },
        ],
        outputSteps: [],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "Delete file",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0, sandboxMode: "restricted" },
        emit,
      },
      control,
    });

    assert.equal(res.status, "stopped");
    assert.equal(res.text, "");

    // Shell was not called
    const shellCalls = executor.calls.filter((c) => c.route === "/shell");
    assert.equal(shellCalls.length, 0);

    const lastStatus = events.filter((e) => e.type === "status").at(-1);
    assert.equal(lastStatus.status, "stopped");
  } finally {
    cleanup();
  }
});

test("truncateForDisplay cuts strings > 2000 chars in result event", async () => {
  const longString = "x".repeat(3000);
  const truncated = truncateForDisplay({
    str: longString,
    nested: { arr: [longString, "short"] },
  });

  assert.equal(truncated.str.length, 2000);
  assert.equal(truncated.nested.arr[0].length, 2000);
  assert.equal(truncated.nested.arr[1], "short");
});

test("createControl getters and methods", async () => {
  const control = createControl();

  assert.equal(control.stopped, false);
  assert.equal(control.paused, false);

  // waitIfPaused when not paused returns immediately
  const notPausedRes = await control.waitIfPaused();
  assert.equal(notPausedRes, "not_paused");

  // pause and resume
  control.pause();
  assert.equal(control.paused, true);

  setTimeout(() => {
    control.resume();
  }, 10);

  const resumedRes = await control.waitIfPaused();
  assert.equal(resumedRes, "resumed");
  assert.equal(control.paused, false);

  // requestApproval and resolveApproval
  const approvalPromise = control.requestApproval("call_xyz");
  control.resolveApproval("call_xyz", true);
  const allowed = await approvalPromise;
  assert.equal(allowed, true);

  // stop resolves pending wait and pending approval
  control.pause();
  const pausePromise = control.waitIfPaused();
  const approvalPromise2 = control.requestApproval("call_abc");
  control.stop();

  assert.equal(control.stopped, true);
  const stoppedWait = await pausePromise;
  assert.equal(stoppedWait, "stopped");

  const stoppedApproval = await approvalPromise2;
  assert.equal(stoppedApproval, false);
});

test("model error emits error event and returns error status", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Model error test" });
    const events: any[] = [];
    const emit = (e: any) => events.push(e);

    const executor = createFakeExecutor();
    const model = {
      async nextTurn() {
        throw new Error("Quota exceeded 429");
      },
    };

    const res = await runTask({
      sessionId: session.id,
      userText: "Will fail in model",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5 },
        emit,
      },
    });

    assert.equal(res.status, "error");
    assert.equal(res.text, "Quota exceeded 429");

    const errEvt = events.find((e) => e.type === "error");
    assert.ok(errEvt);
    assert.equal(errEvt.message, "Quota exceeded 429");

    const lastStatus = events.filter((e) => e.type === "status").at(-1);
    assert.equal(lastStatus.status, "error");
  } finally {
    cleanup();
  }
});

test("allowed confirm action executes tool with executor", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Allow confirm test" });
    const events: any[] = [];
    const control = createControl();

    const emit = (e: any) => {
      events.push(e);
      if (e.type === "approval_request" && e.callId === "call_rm_allow") {
        control.resolveApproval(e.callId, true);
      }
    };

    const executor = createFakeExecutor({
      routes: {
        "/shell": { exit_code: 0, stdout: "deleted", stderr: "", truncated: false },
      },
    });

    const model = createFakeModel([
      {
        calls: [
          {
            id: "call_rm_allow",
            name: "run_shell",
            args: { command: "rm file.txt" },
          },
        ],
        outputSteps: [],
      },
      {
        text: "Deleted successfully",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "Deleted successfully" }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "Delete file.txt",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0, sandboxMode: "restricted" },
        emit,
      },
      control,
    });

    assert.equal(res.status, "done");
    assert.equal(res.text, "Deleted successfully");

    const shellCalls = executor.calls.filter((c) => c.route === "/shell");
    assert.equal(shellCalls.length, 1);
    assert.equal(shellCalls[0].body.command, "rm file.txt");

    const appEvt = events.find((e) => e.type === "approval");
    assert.ok(appEvt);
    assert.equal(appEvt.allowed, true);
  } finally {
    cleanup();
  }
});

test("stop() while model.nextTurn() is in-flight on final answer returns stopped status", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Stop during nextTurn" });
    const events: any[] = [];
    const control = createControl();
    const emit = (e: any) => events.push(e);

    const executor = createFakeExecutor();

    const model = {
      async nextTurn() {
        // Stop the control while nextTurn is in-flight
        control.stop();
        return {
          thoughts: ["Finishing up"],
          text: "Finished without tool calls",
          calls: [] as any[],
          outputSteps: [{ type: "model_output", text: "Finished without tool calls" }],
          usage: { input: 10, output: 10 },
        };
      },
    };

    const res = await runTask({
      sessionId: session.id,
      userText: "Do something and I will stop you",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5 },
        emit,
      },
      control,
    });

    assert.equal(res.status, "stopped");
    assert.equal(res.text, "");

    // Answer should not be emitted
    const answerEvt = events.find((e) => e.type === "answer");
    assert.equal(answerEvt, undefined);

    const lastStatus = events.filter((e) => e.type === "status").at(-1);
    assert.equal(lastStatus.status, "stopped");
  } finally {
    cleanup();
  }
});

test("loop exposes host tools by default, dynamically loads mcp__kimi_cu__* only when kimi-cu skill is added, and hides both when hostExecutionMode is off", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Dual computer + MCP test" });
    const events: any[] = [];
    const emit = (e: any) => events.push(e);
    const executor = createFakeExecutor();

    let listGeminiCalls = 0;
    const mcpCalls: any[] = [];
    const fakeMcpManager = {
      async listGeminiTools(ids: any) {
        listGeminiCalls += 1;
        assert.deepEqual(ids, ["kimi-cu"]);
        return [
          {
            type: "function",
            name: "mcp__kimi_cu__get_app_state",
            description: "Inspect Mac app",
            parameters: {
              type: "object",
              properties: {
                app: { type: "string" },
                risk: { type: "string", enum: ["low", "medium", "high"] },
              },
              required: ["app"],
            },
          },
        ];
      },
      async callTool(name: any, args: any) {
        mcpCalls.push({ name, args });
        return {
          result: {
            ok: true,
            text: "Finder Window [e1]",
            structuredContent: { snapshot_id: "s1", screenshot_id: "img1" },
          },
          screenshot: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
          mimeType: "image/jpeg",
        };
      },
    };

    // 1. Default installedSkills (["qqmail", "custom-mail"]): host tools present, kimi-cu NOT loaded
    const model1 = createFakeModel([
      {
        thoughts: [],
        text: "Done 1",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "Done 1" }],
      },
    ]);
    await runTask({
      sessionId: session.id,
      userText: "Check local tools",
      deps: {
        model: model1,
        executor,
        store,
        mcpManager: fakeMcpManager,
        enableBotTools: true,
        autoRoute: true,
        config: { maxSteps: 3, settleMs: 0 },
        emit,
      },
    });
    const tools1 = model1.historyCalls[0].tools.map((t: any) => t.name);
    assert.ok(tools1.includes("host_run_shell"));
    assert.ok(!tools1.includes("mcp__kimi_cu__get_app_state"));
    assert.equal(listGeminiCalls, 0);

    // 2. Add kimi-cu in settings: mcp__kimi_cu__get_app_state is loaded & executed, saving screenshot
    store.writeSettings({ installedSkills: ["qqmail", "kimi-cu"] });
    const model2 = createFakeModel([
      {
        thoughts: ["Inspecting Finder via KimiCU"],
        text: "我先看看你 Mac 上访达的窗口状态。",
        calls: [
          {
            id: "mcp_call_1",
            name: "mcp__kimi_cu__get_app_state",
            args: { app: "com.apple.finder", risk: "low" },
          },
        ],
        outputSteps: [
          {
            id: "mcp_call_1",
            type: "function_call",
            name: "mcp__kimi_cu__get_app_state",
            arguments: { app: "com.apple.finder", risk: "low" },
          },
        ],
      },
      {
        thoughts: [],
        text: "访达窗口处于打开状态。",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "访达窗口处于打开状态。" }],
      },
    ]);

    const res2 = await runTask({
      sessionId: session.id,
      userText: "用 kimi-cu 看一下访达窗口",
      deps: {
        model: model2,
        executor,
        store,
        mcpManager: fakeMcpManager,
        enableBotTools: true,
        autoRoute: true,
        config: { maxSteps: 5, settleMs: 0 },
        emit,
      },
    });
    assert.equal(res2.status, "done");
    assert.equal(listGeminiCalls, 2);
    assert.equal(mcpCalls.length, 1);
    assert.equal(mcpCalls[0].args.app, "com.apple.finder");
    const resultEvt = events.find(
      (e) => e.type === "result" && e.callId === "mcp_call_1"
    );
    assert.ok(resultEvt?.screenshot, "MCP window screenshot should be saved for chat stream");

    // 3. Turn hostExecutionMode to "off": both host_* and mcp__kimi_cu__* are hidden
    store.writeSettings({
      installedSkills: ["qqmail", "kimi-cu"],
      hostComputer: { executionMode: "off" },
    });
    const model3 = createFakeModel([
      {
        thoughts: [],
        text: "Sandbox only",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "Sandbox only" }],
      },
    ]);
    await runTask({
      sessionId: session.id,
      userText: "Sandbox check",
      deps: {
        model: model3,
        executor,
        store,
        mcpManager: fakeMcpManager,
        enableBotTools: true,
        autoRoute: true,
        config: { maxSteps: 3, settleMs: 0 },
        emit,
      },
    });
    const tools3 = model3.historyCalls[0].tools.map((t: any) => t.name);
    assert.ok(!tools3.includes("host_run_shell"));
    assert.ok(!tools3.includes("mcp__kimi_cu__get_app_state"));
    assert.equal(listGeminiCalls, 2);
  } finally {
    cleanup();
  }
});

test("runTask feeds uploaded visual image attachments directly into userStep for the model", async () => {
  const { store, dir, cleanup } = createTestStore();
  try {
    const uploadsDir = path.join(dir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const imgPath = path.join(uploadsDir, "sample.jpg");
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    fs.writeFileSync(imgPath, jpegBytes);

    const session = store.createSession({ title: "Vision Attachment Test" });
    const events: any[] = [];
    const executor = createFakeExecutor();
    const model = createFakeModel([
      {
        thoughts: [],
        text: "我看到了你上传的图片。",
        calls: [] as any[],
        outputSteps: [{ type: "model_output", text: "我看到了你上传的图片。" }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "这是什么图片？",
      userMeta: {
        attachments: [
          {
            name: "sample.jpg",
            path: imgPath,
            size: jpegBytes.length,
            isMedia: true,
            url: `/api/workspace/file?path=${encodeURIComponent(imgPath)}`,
          },
        ],
      },
      deps: {
        model,
        executor,
        store,
        autoRoute: true,
        smartRouter: true,
        config: {
          maxSteps: 3,
          settleMs: 0,
          writeRoots: [dir],
        },
        emit: (e: any) => events.push(e),
      },
    });

    assert.equal(res.status, "done");
    const sentInput = model.historyCalls[0].input;
    const firstUserStep = sentInput.find((s: any) => s.type === "user_input");
    assert.ok(firstUserStep, "should include initial user_input step");
    const imageParts = firstUserStep.content.filter((p: any) => p.type === "image");
    assert.equal(imageParts.length, 1);
    assert.equal(imageParts[0].data, jpegBytes.toString("base64"));
    assert.equal(imageParts[0].mime_type, "image/jpeg");
    // Should not unnecessarily capture Ubuntu desktop screenshot for a pure visual attachment query
    assert.equal(executor.calls.filter((c) => c.route === "/screenshot").length, 0);
  } finally {
    cleanup();
  }
});

test("runTask seals failed/timed-out user_input turns in history so follow-up messages stay alternating", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Recovery Bot" });
    const executor = createFakeExecutor();
    const events: any[] = [];

    const failingModel = {
      async nextTurn() {
        throw new Error("The operation was aborted due to timeout");
      },
    };
    const r1 = await runTask({
      sessionId: session.id,
      userText: "生成一个超级复杂的图",
      deps: {
        model: failingModel as any,
        executor,
        store,
        config: { maxSteps: 3, settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });
    assert.equal(r1.status, "error");
    const savedAfterErr = store.loadHistory(session.id);
    assert.equal(savedAfterErr[savedAfterErr.length - 1]?.type, "model_output");

    // Next turn succeeds and sees alternating history rather than consecutive dangling user_input
    const okModel = createFakeModel([
      {
        thoughts: [],
        text: "收到，2",
        calls: [],
        outputSteps: [{ type: "model_output", text: "收到，2" }],
      },
    ]);
    const r2 = await runTask({
      sessionId: session.id,
      userText: "1+1等于几",
      deps: {
        model: okModel,
        executor,
        store,
        config: { maxSteps: 3, settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });
    assert.equal(r2.status, "done");
    assert.equal(r2.text, "收到，2");
    const types = okModel.historyCalls[0].input.map((s: any) => s.type);
    assert.deepEqual(types, ["user_input", "model_output", "user_input"]);
  } finally {
    cleanup();
  }
});

test("runTask keeps parallel tool function_result steps contiguous before appending Current screen user_input", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Parallel Tool Screen Order" });
    const executor = createFakeExecutor();
    const model = createFakeModel([
      {
        thoughts: [],
        text: "",
        calls: [
          { id: "call_screen_1", name: "screenshot", args: {} },
          { id: "call_wait_2", name: "wait", args: { ms: 10 } },
        ],
        outputSteps: [
          { type: "function_call", id: "call_screen_1", name: "screenshot", arguments: {} },
          { type: "function_call", id: "call_wait_2", name: "wait", arguments: { ms: 10 } },
        ],
      },
      {
        thoughts: [],
        text: "Parallel tools completed.",
        calls: [],
        outputSteps: [{ type: "model_output", text: "Parallel tools completed." }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "截个图并等待一下",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit: () => {},
      },
    });
    assert.equal(res.status, "done");

    const step2Input = model.historyCalls[1].input;
    const callIdx = step2Input.findIndex((s: any) => s.type === "function_call");
    assert.ok(callIdx >= 0);
    assert.deepEqual(
      step2Input.slice(callIdx).map((s: any) => ({
        type: s.type,
        id: s.id,
        call_id: s.call_id,
      })),
      [
        { type: "function_call", id: "call_screen_1", call_id: undefined },
        { type: "function_call", id: "call_wait_2", call_id: undefined },
        { type: "function_result", id: undefined, call_id: "call_screen_1" },
        { type: "function_result", id: undefined, call_id: "call_wait_2" },
        { type: "user_input", id: undefined, call_id: undefined },
      ]
    );
  } finally {
    cleanup();
  }
});

test("runTask blocks truncated (finishReason=length) and malformed-JSON tool calls from executing", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Truncated Tool Guard" });
    const executor = createFakeExecutor();
    const events: any[] = [];

    const model = createFakeModel([
      {
        thoughts: [],
        text: "",
        finishReason: "length",
        calls: [{ id: "call_cut", name: "screenshot", args: {} }],
        outputSteps: [{ type: "function_call", id: "call_cut", name: "screenshot", arguments: {} }],
      },
      {
        thoughts: [],
        text: "",
        calls: [
          {
            id: "call_bad_json",
            name: "run_shell",
            args: {},
            parseError: "Invalid JSON tool arguments: Unexpected end of JSON input",
          },
        ],
        outputSteps: [{ type: "function_call", id: "call_bad_json", name: "run_shell", arguments: {} }],
      },
      {
        thoughts: [],
        text: "Recovered safely.",
        calls: [],
        outputSteps: [{ type: "model_output", text: "Recovered safely." }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "执行测试",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 6, settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });

    assert.equal(res.status, "done");
    assert.equal(res.text, "Recovered safely.");
    // Only the initial screenshot ran; neither call_cut nor call_bad_json hit executor
    assert.equal(executor.calls.filter((c) => c.route === "/run_shell").length, 0);
    assert.equal(executor.calls.filter((c) => c.route === "/screenshot").length, 1);

    const cutResultEvt = events.find((e) => e.type === "result" && e.callId === "call_cut");
    assert.match(cutResultEvt?.result?.error || "", /finish_reason=length/);
    const badJsonEvt = events.find((e) => e.type === "result" && e.callId === "call_bad_json");
    assert.match(badJsonEvt?.result?.error || "", /Invalid JSON tool arguments/);
  } finally {
    cleanup();
  }
});

test("runTask reactively compacts history and retries when model throws a context-overflow error", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Overflow Recovery" });
    const hugePriorHistory: any[] = [];
    for (let i = 0; i < 6; i++) {
      hugePriorHistory.push({
        type: "user_input",
        content: [{ type: "text", text: `历史消息 ${i} ` + "detail ".repeat(180) }],
      });
      hugePriorHistory.push({
        type: "model_output",
        content: [{ type: "text", text: `历史回复 ${i} ` + "output ".repeat(180) }],
      });
    }
    store.saveHistory(session.id, hugePriorHistory);

    const executor = createFakeExecutor();
    const events: any[] = [];
    let attempt = 0;
    const model = {
      async nextTurn() {
        attempt++;
        if (attempt === 1) {
          throw new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens.");
        }
        return {
          thoughts: [],
          text: "压缩后恢复成功",
          calls: [],
          outputSteps: [{ type: "model_output", text: "压缩后恢复成功" }],
        };
      },
    };

    const res = await runTask({
      sessionId: session.id,
      userText: "继续当前工作",
      deps: {
        model: model as any,
        executor,
        store,
        config: { maxSteps: 4, settleMs: 0, contextWindow: 4000 },
        emit: (e: any) => events.push(e),
      },
    });

    assert.equal(res.status, "done");
    assert.equal(res.text, "压缩后恢复成功");
    assert.equal(attempt, 2);
    assert.ok(events.some((e) => e.type === "context_compressed"));
  } finally {
    cleanup();
  }
});

test("runTask preserves in-memory Prompt Cache screenshot buffer mid-turn while keeping persisted history capped", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Prompt Cache Screenshot Buffer" });
    const executor = createFakeExecutor({ routes: { "/click": { ok: true } } });
    const turns = [1, 2, 3, 4].map((i) => ({
      thoughts: [],
      calls: [{ id: `c${i}`, name: "click", args: { x: i * 10, y: 10 } }],
      outputSteps: [{ type: "function_call", id: `c${i}`, name: "click", arguments: { x: i * 10, y: 10 } }],
    }));
    const model = createFakeModel([
      ...turns,
      {
        thoughts: [],
        text: "All 4 clicks done",
        calls: [],
        outputSteps: [{ type: "model_output", text: "All 4 clicks done" }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "连续点击4次",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 10, keepScreenshots: 3, settleMs: 0 },
        emit: () => {},
      },
    });

    assert.equal(res.status, "done");
    // Step 5 (before final answer) sees 1 initial + 4 click screenshots = 5 images <= keepScreenshots(3) + 2,
    // so the in-memory prefix was NOT mutated mid-turn!
    const step5Input = model.historyCalls[4].input;
    const inMemoryImageCount = step5Input.reduce(
      (sum: number, s: any) =>
        sum + (Array.isArray(s.content) ? s.content.filter((p: any) => p?.type === "image").length : 0),
      0
    );
    assert.equal(inMemoryImageCount, 5);

    // Meanwhile persisted history on disk stays capped at keepScreenshots (3)
    const persisted = store.loadHistory(session.id);
    const persistedImageCount = persisted.reduce(
      (sum: number, s: any) =>
        sum + (Array.isArray(s.content) ? s.content.filter((p: any) => p?.type === "image").length : 0),
      0
    );
    assert.equal(persistedImageCount, 3);
  } finally {
    cleanup();
  }
});

test("runTask recovers from empty finishReason=length reasoning exhaustion instead of finishing with blank text", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Length Exhaustion Recovery" });
    const executor = createFakeExecutor();
    const model = createFakeModel([
      {
        thoughts: ["spent entire output token cap thinking..."],
        text: "",
        finishReason: "length",
        calls: [],
        outputSteps: [{ type: "thought", text: "spent entire output token cap thinking..." }],
      },
      {
        thoughts: [],
        text: "精简结论：已完成。",
        calls: [],
        outputSteps: [{ type: "model_output", text: "精简结论：已完成。" }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "分析并给出结论",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 4, settleMs: 0 },
        emit: () => {},
      },
    });
    assert.equal(res.status, "done");
    assert.equal(res.text, "精简结论：已完成。");
    assert.equal(model.historyCalls.length, 2);
  } finally {
    cleanup();
  }
});

test("runTask warns model on final step when maxSteps >= 4 and cleanly resumes on follow-up continue", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Long multi-step video task" });
    const events: any[] = [];
    const executor = createFakeExecutor();
    let stepCalls = 0;
    const model = {
      historyCalls: [] as any[],
      async nextTurn({ input }: any) {
        this.historyCalls.push(input);
        stepCalls++;
        if (stepCalls <= 4) {
          return {
            thoughts: [`Step ${stepCalls}`],
            calls: [{ id: `c_${stepCalls}`, name: "run_shell", args: { command: `echo step ${stepCalls}` } }],
            outputSteps: [
              { type: "function_call", id: `c_${stepCalls}`, name: "run_shell", args: { command: `echo step ${stepCalls}` } },
            ],
          };
        }
        return {
          thoughts: [],
          text: "已接续完成剩余视频分镜与渲染。",
          calls: [],
          outputSteps: [{ type: "model_output", text: "已接续完成剩余视频分镜与渲染。" }],
        };
      },
    };

    const res1 = await runTask({
      sessionId: session.id,
      userText: "执行长视频多步生成任务",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 4, settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });
    assert.equal(res1.status, "max_steps");
    assert.match(res1.text, /已达到单轮最大步数上限（4 步）/);
    assert.match(res1.text, /run_shell/);
    const fourthInputTexts = JSON.stringify(model.historyCalls[3]);
    assert.match(fourthInputTexts, /final step allowed for this turn/);

    // Follow-up continue turn should NOT see interrupted/crashed notice
    const res2 = await runTask({
      sessionId: session.id,
      userText: "继续",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 4, settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });
    assert.equal(res2.status, "done");
    assert.equal(res2.text, "已接续完成剩余视频分镜与渲染。");
    const fifthInputTexts = JSON.stringify(model.historyCalls[4]);
    assert.doesNotMatch(fifthInputTexts, /previous turn was interrupted before completion/);
  } finally {
    cleanup();
  }
});

test("runTask retries empty model turns instead of silently finishing done, and surfaces error if empty repeats", async () => {
  const { store, cleanup } = createTestStore();
  try {
    // 1. Transient empty turn recovers on the next step
    const s1 = store.createSession({ title: "Empty Turn Recovery" });
    const executor = createFakeExecutor();
    const recoveringModel = createFakeModel([
      { thoughts: [], text: "", calls: [], outputSteps: [] },
      {
        thoughts: [],
        text: "重试后正常完成了任务。",
        calls: [],
        outputSteps: [{ type: "model_output", text: "重试后正常完成了任务。" }],
      },
    ]);
    const res1 = await runTask({
      sessionId: s1.id,
      userText: "继续操作",
      deps: {
        model: recoveringModel,
        executor,
        store,
        config: { maxSteps: 4, settleMs: 0 },
        emit: () => {},
      },
    });
    assert.equal(res1.status, "done");
    assert.equal(res1.text, "重试后正常完成了任务。");
    assert.equal(recoveringModel.historyCalls.length, 2);

    // 2. Repeated empty turns MUST end with status=error (never silent done with blank answer)
    const s2 = store.createSession({ title: "Repeated Empty Turn Error" });
    const events: any[] = [];
    const alwaysEmptyModel = createFakeModel([
      { thoughts: [], text: "", calls: [], outputSteps: [] },
      { thoughts: [], text: "", calls: [], outputSteps: [] },
      { thoughts: [], text: "", calls: [], outputSteps: [] },
    ]);
    const res2 = await runTask({
      sessionId: s2.id,
      userText: "继续操作",
      deps: {
        model: alwaysEmptyModel,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });
    assert.equal(res2.status, "error");
    assert.match(res2.text, /空响应/);
    assert.equal(events.some((e) => e.type === "error"), true);
    assert.equal(events.some((e) => e.type === "answer" && e.text === ""), false);
  } finally {
    cleanup();
  }
});

test("runTask recovers when model prints pseudo '[Tool call <name>(...)]' text instead of calling native tool", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const session = store.createSession({ title: "Pseudo Tool Call Recovery" });
    const executor = createFakeExecutor();
    const model = createFakeModel([
      {
        thoughts: [],
        text: '我先截个图。[Tool call screenshot({})]',
        calls: [],
        outputSteps: [{ type: "model_output", text: '我先截个图。[Tool call screenshot({})]' }],
      },
      {
        thoughts: [],
        text: "",
        calls: [{ id: "call_real_ss", name: "screenshot", args: {} }],
        outputSteps: [{ type: "function_call", id: "call_real_ss", name: "screenshot", arguments: {} }],
      },
      {
        thoughts: [],
        text: "已截屏完成。",
        calls: [],
        outputSteps: [{ type: "model_output", text: "已截屏完成。" }],
      },
    ]);

    const res = await runTask({
      sessionId: session.id,
      userText: "截个图看看",
      deps: {
        model,
        executor,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit: () => {},
      },
    });
    assert.equal(res.status, "done");
    assert.equal(res.text, "已截屏完成。");
    assert.equal(model.historyCalls.length, 3);
  } finally {
    cleanup();
  }
});

test("P1-2 & P1-4: non-Admin filtering hides privileged tools, trivial chat trims heavy tools until route_escalate, and memory remove blocks post-turn re-extraction", async () => {
  // 1. Direct declaration filter verification
  const nonAdminFiltered = filterToolDeclarationsForSkills(BOT_COLLAB_TOOL_DECLARATIONS, [], {
    isAdminBot: false,
  });
  assert.equal(nonAdminFiltered.some((t) => t.name === "computer_provision"), false);
  assert.equal(nonAdminFiltered.some((t) => t.name === "account_manage"), false);
  const restrictedSelfUpdate = nonAdminFiltered.find((t) => t.name === "self_update");
  assert.deepEqual(restrictedSelfUpdate?.parameters?.properties?.action?.enum, ["check", "status"]);

  const { store, cleanup } = createTestStore();
  try {
    const bot = store.createSession({
      title: "HelperBot",
      isAdmin: false,
      memories: [
        {
          id: "mem-del-1",
          name: "旧偏好",
          content: "以后请用复古风格输出",
          enabled: true,
        },
      ],
    });
    const capturedToolNamesPerCall: string[][] = [];
    let memoryExtractCalls = 0;

    const fakeModel: any = {
      async nextTurn(opts: any) {
        const names = (opts.tools || []).map((t: any) => String(t.name));
        capturedToolNamesPerCall.push(names);
        if (capturedToolNamesPerCall.length === 1) {
          return {
            thoughts: [],
            text: "",
            calls: [
              { id: "c_rm", name: "memory_manage", args: { action: "remove", memory: "mem-del-1" } },
              { id: "c_esc", name: "route_escalate", args: { need: "think", reason: "need full tools" } },
            ],
            outputSteps: [
              { type: "function_call", id: "c_rm", name: "memory_manage", arguments: { action: "remove", memory: "mem-del-1" } },
              { type: "function_call", id: "c_esc", name: "route_escalate", arguments: { need: "think", reason: "need full tools" } },
            ],
          };
        }
        return {
          thoughts: [],
          text: "已为你删掉这条偏好记忆。",
          calls: [],
          outputSteps: [{ type: "model_output", text: "已为你删掉这条偏好记忆。" }],
        };
      },
      async planTurn() {
        return { text: "{}" };
      },
      async summarizeTurn(opts: any) {
        if (String(opts?.systemInstruction || "").includes("memory extractor")) {
          memoryExtractCalls += 1;
        }
        return { text: '{"candidates":[]}' };
      },
    };

    store.writeSettings({
      routing: { mode: "balanced", smartRouter: true },
    });

    const res = await runTask({
      sessionId: bot.id,
      userText: "嗨", // trivial/chat L0 greeting -> trimmed toolset on step 1
      deps: {
        model: fakeModel,
        executor: createFakeExecutor(),
        store,
        enableBotTools: true,
        autoRoute: true,
        smartRouter: true,
        config: {
          maxSteps: 4,
          settleMs: 0,
        },
        emit: () => {},
      },
    });
    assert.equal(res.status, "done");
    // Step 1 trimmed out heavy desktop/shell tools while still exposing core memory_manage & route_escalate
    assert.equal(capturedToolNamesPerCall[0].includes("click"), false);
    assert.equal(capturedToolNamesPerCall[0].includes("host_run_shell"), false);
    assert.equal(capturedToolNamesPerCall[0].includes("computer_provision"), false);
    assert.equal(capturedToolNamesPerCall[0].includes("memory_manage"), true);
    // Step 2 unlocked full non-admin toolset after route_escalate while still excluding Admin-only tools
    assert.equal(capturedToolNamesPerCall[1].includes("read_file"), true);
    assert.equal(capturedToolNamesPerCall[1].includes("computer_provision"), false);
    assert.equal(capturedToolNamesPerCall[1].includes("account_manage"), false);
    // Wait briefly to confirm post-turn background extractor did NOT run after memory_manage(remove)
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(memoryExtractCalls, 0);
    assert.equal(store.getSession(bot.id)?.memories?.length, 0);
  } finally {
    cleanup();
  }
});

test("Phase 3 P2-2: pause suspends queued tool calls until resume and long-thinking short-reply triggers 1 self-check", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const bot = store.ensureAdminBot();
    const ctrl = createControl();
    assert.equal(ctrl.isPaused(), false);

    let executedShellWhilePaused = false;
    const execCalls: string[] = [];
    const exec = createFakeExecutor({
      routes: {
        "/shell": () => {
          execCalls.push("shell");
          if (ctrl.isPaused()) executedShellWhilePaused = true;
          return { ok: true, stdout: "ran", stderr: "", code: 0 };
        },
      },
    });

    let turnCount = 0;
    const fakeModel = {
      async nextTurn() {
        turnCount += 1;
        if (turnCount === 1) {
          // Simulate user clicking Pause right as the model response arrives
          ctrl.pause();
          return {
            thoughts: [],
            text: "",
            calls: [{ id: "c_pause_1", name: "run_shell", args: { command: "echo hi" } }],
            outputSteps: [
              { type: "function_call", id: "c_pause_1", name: "run_shell", arguments: { command: "echo hi" } },
            ],
          };
        }
        if (turnCount === 2) {
          return {
            thoughts: ["heavy reasoning..."],
            usage: { input: 500, output: 10, thoughts: 950 },
            text: "扫完",
            calls: [],
            outputSteps: [{ type: "model_output", text: "扫完" }],
          };
        }
        return {
          thoughts: [],
          usage: { input: 600, output: 40 },
          text: "已完成全部检查并确认命令执行成功。",
          calls: [],
          outputSteps: [{ type: "model_output", text: "已完成全部检查并确认命令执行成功。" }],
        };
      },
    };

    const statuses: string[] = [];
    const runPromise = runTask({
      sessionId: bot.id,
      userText: "检查一下",
      control: ctrl,
      deps: {
        model: fakeModel,
        executor: exec,
        store,
        config: { maxSteps: 5, settleMs: 0 },
        emit: (ev: any) => {
          if (ev?.type === "status") statuses.push(ev.status);
        },
      },
    });

    await new Promise((r) => setTimeout(r, 35));
    assert.equal(ctrl.isPaused(), true);
    assert.equal(execCalls.length, 0, "tool must NOT execute while paused");
    ctrl.resume();
    assert.equal(ctrl.isPaused(), false);

    const res = await runPromise;
    assert.equal(res.status, "done");
    assert.equal(executedShellWhilePaused, false);
    assert.deepEqual(execCalls, ["shell"]);
    assert.equal(turnCount, 3, "short reply '扫完' after >=800 thoughts triggers 1 self-check turn");
    assert.equal(res.text, "已完成全部检查并确认命令执行成功。");
  } finally {
    cleanup();
  }
});

test("Phase 4 P0-1/P0-3/P0-5: keeps full tools on follow-up/tool history, persists tokenScale, and prunes old-turn screenshots cleanly", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const bot = store.ensureAdminBot();
    const fakePng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    // Prior turn with an old screenshot + function_call/function_result
    store.saveHistory(bot.id, [
      {
        type: "user_input",
        content: [
          { type: "text", text: "上一轮检查服务" },
          { type: "image", data: fakePng.toString("base64"), mime_type: "image/png" },
        ],
      },
      { type: "function_call", id: "old_c1", name: "host_run_shell", arguments: { command: "ls" } },
      { type: "function_result", call_id: "old_c1", name: "host_run_shell", result: "ok" },
      { type: "model_output", content: [{ type: "text", text: "上一步中断" }] },
    ]);
    store.updateSession(bot.id, { status: "interrupted" });
    store.writeSettings({ routing: { mode: "balanced", smartRouter: true } });

    const seenInputs: any[] = [];
    const seenToolNames: string[][] = [];
    const model = {
      async planTurn() {
        return { text: "{}" };
      },
      async nextTurn(opts: any) {
        seenInputs.push(opts.input);
        seenToolNames.push((opts.tools || []).map((t: any) => String(t.name)));
        return {
          thoughts: [],
          usage: { input: 240, output: 10 },
          text: "已恢复继续执行完毕。",
          calls: [],
          outputSteps: [{ type: "model_output", text: "已恢复继续执行完毕。" }],
        };
      },
    };

    const res = await runTask({
      sessionId: bot.id,
      userText: "继续",
      deps: {
        model,
        executor: createFakeExecutor(),
        store,
        enableBotTools: true,
        autoRoute: true,
        smartRouter: true,
        config: { maxSteps: 3, settleMs: 0 },
        emit: () => {},
      },
    });
    assert.equal(res.status, "done");
    // Old-turn screenshot must be stripped at turn boundary so it neither bloats nor pins visual
    const hasOldImage = seenInputs[0][0].content.some((p: any) => p.type === "image");
    assert.equal(hasOldImage, false, "old-turn screenshot must be pruned on new turn start");
    // Follow-up / prior tool history must NOT strip host_run_shell/read_file
    assert.equal(seenToolNames[0].includes("host_run_shell"), true);
    assert.equal(seenToolNames[0].includes("read_file"), true);
    // Token scale > 1 should persist to session record when real > estimate
    const updatedBot = store.getSession(bot.id);
    assert.ok((updatedBot?.tokenScale || 1) >= 1);
  } finally {
    cleanup();
  }
});

test("Phase 5 P1-2 & P1-3 & P1-5: browser_* batch abort, paused final answer guard & lightweight scheduled run", async () => {
  const { store, cleanup } = createTestStore();
  try {
    // 1. P1-2: batched browser_type failure aborts subsequent browser_click in same step
    const bot1 = store.createSession({ title: "P1-2 Bot" });
    const execCalls: any[] = [];
    let step1Count = 0;
    const resP12 = await runTask({
      sessionId: bot1.id,
      userText: "填写日期并提交表单",
      deps: {
        store,
        model: {
          async nextTurn() {
            step1Count += 1;
            if (step1Count === 1) {
              return {
                text: "",
                calls: [
                  { id: "b1", name: "browser_type", args: { ref: "e5", text: "bad-date" } },
                  { id: "b2", name: "browser_click", args: { ref: "e9" } },
                ],
                outputSteps: [
                  { type: "function_call", id: "b1", name: "browser_type", arguments: { ref: "e5", text: "bad-date" } },
                  { type: "function_call", id: "b2", name: "browser_click", arguments: { ref: "e9" } },
                ],
                thoughts: [],
              };
            }
            return { text: "日期校验失败，已停止点击提交。", calls: [], outputSteps: [], thoughts: [] };
          },
        },
        executor: {
          async call(route: string, body: any) {
            execCalls.push({ route, body });
            if (route === "/browser/type") {
              return { ok: false, error: 'browser_type failed to set <input type="date"> value' };
            }
            if (route === "/browser/click") {
              throw new Error("browser_click must NOT run after failed browser_type in same batch");
            }
            return { png_base64: Buffer.from("png").toString("base64") };
          },
        },
        config: { maxSteps: 4, settleMs: 0 },
      },
    });
    assert.equal(resP12.status, "done");
    assert.equal(execCalls.some((c) => c.route === "/browser/click"), false);

    // 2. P1-3: pause during in-flight final calls=[] step blocks answer & done; stop exits cleanly
    const bot2 = store.createSession({ title: "P1-3 Bot" });
    const ctrl = createControl();
    const pauseEvents: any[] = [];
    let resolveInflight!: (v: any) => void;
    const inflightPromise = runTask({
      sessionId: bot2.id,
      userText: "总结汇报",
      control: ctrl,
      deps: {
        store,
        model: {
          nextTurn() {
            return new Promise((resolve) => {
              resolveInflight = resolve;
            });
          },
        },
        executor: createFakeExecutor(),
        config: { maxSteps: 3, settleMs: 0 },
        emit: (e: any) => pauseEvents.push(e),
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    ctrl.pause();
    resolveInflight({
      text: "不应该在暂停期间发送的最终回复",
      calls: [],
      outputSteps: [{ type: "model_output", text: "不应该在暂停期间发送的最终回复" }],
      thoughts: [],
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pauseEvents.some((e) => e.type === "answer"), false);
    assert.equal(ctrl.isPaused(), true);
    assert.notEqual(store.getSession(bot2.id)?.status, "done");
    ctrl.stop();
    const resP13 = await inflightPromise;
    assert.equal(resP13.status, "stopped");
    assert.equal(pauseEvents.some((e) => e.type === "answer"), false);

    // 3. P1-5: scheduled run avoids stray desktop screenshot and omits >16K cold history while keeping full persisted history
    const bot3 = store.createSession({ title: "P1-5 Bot" });
    const hugeOldText = "A".repeat(32_000);
    store.saveHistory(bot3.id, [
      { type: "user_input", content: [{ type: "text", text: `历史1 ${hugeOldText}` }] },
      { type: "model_output", content: [{ type: "text", text: "历史回复1" }] },
      { type: "user_input", content: [{ type: "text", text: `历史2 ${hugeOldText}` }] },
      { type: "model_output", content: [{ type: "text", text: "历史回复2" }] },
      { type: "user_input", content: [{ type: "text", text: "历史3 较近对话" }] },
      { type: "model_output", content: [{ type: "text", text: "历史回复3" }] },
    ]);
    let seenInputLen = 0;
    let seenOldestText = "";
    let seenInputSerialized = "";
    let screenshotCalls = 0;
    const resP15 = await runTask({
      sessionId: bot3.id,
      userText: "[例行任务：检查服务器]\n运行 df -h 检查磁盘",
      deps: {
        store,
        model: {
          async nextTurn(opts: any) {
            seenInputLen = opts.input.length;
            seenOldestText = String(opts.input[0]?.content?.[0]?.text || "");
            seenInputSerialized = JSON.stringify(opts.input);
            return { text: "磁盘正常。", calls: [], outputSteps: [], thoughts: [] };
          },
        },
        executor: {
          async call(route: string) {
            if (route === "/screenshot") screenshotCalls += 1;
            return { ok: true };
          },
        },
        config: { maxSteps: 2, settleMs: 0 },
      },
    });
    assert.equal(resP15.status, "done");
    assert.equal(screenshotCalls, 0, "scheduled non-GUI run must not take initial desktop screenshot");
    assert.match(seenOldestText, /Scheduled routine lightweight context/);
    assert.equal(seenInputLen, 7, `expected 2 notice + 4 recent + 1 new = 7 steps, got ${seenInputLen}`);
    assert.equal(seenInputSerialized.includes("历史1"), false, "omitted old prefix must not be sent to LLM");
    const persisted = store.loadHistory(bot3.id);
    assert.ok(
      String(persisted[0]?.content?.[0]?.text || "").startsWith("历史1"),
      "full interactive history prefix must remain persisted in store"
    );
  } finally {
    cleanup();
  }
});

test("Phase 6 P2-2 & P2-7: approval context/draft reuse/reminder & on-demand prev-turn completion header", async () => {
  const { store, cleanup } = createTestStore();
  try {
    // 1. buildApprovalContextSummary produces readable element label + page host
    const labels = new Map<string, string>([["e12", "发布文章 (button)"]]);
    const summary = buildApprovalContextSummary(
      "browser_click",
      { ref: "e12", risk: "high" },
      { browserElements: labels, browserUrl: "https://mp.example.com/editor" }
    );
    assert.match(summary, /发布文章 \(button\)/);
    assert.match(summary, /mp\.example\.com/);

    // 2. Same-turn approved propose_draft skips duplicate high-risk browser_click confirmation
    const bot1 = store.createSession({ title: "DraftReuse Bot" });
    let draftStep = 0;
    const approvalsSeen: any[] = [];
    const draftEvents: any[] = [];
    const ctrl1 = createControl();
    const runDraftPromise = runTask({
      sessionId: bot1.id,
      userText: "发布文章",
      control: ctrl1,
      deps: {
        store,
        enableBotTools: true,
        model: {
          async nextTurn() {
            draftStep += 1;
            if (draftStep === 1) {
              return {
                text: "",
                calls: [
                  {
                    id: "d_1",
                    name: "propose_draft",
                    args: { title: "发布动态", recipient: "博客", content: "正文内容" },
                  },
                ],
                outputSteps: [
                  {
                    type: "function_call",
                    id: "d_1",
                    name: "propose_draft",
                    arguments: { title: "发布动态", recipient: "博客", content: "正文内容" },
                  },
                ],
                thoughts: [],
              };
            }
            if (draftStep === 2) {
              return {
                text: "",
                calls: [
                  { id: "c_pub", name: "browser_click", args: { ref: "e12", risk: "high" } },
                ],
                outputSteps: [
                  {
                    type: "function_call",
                    id: "c_pub",
                    name: "browser_click",
                    arguments: { ref: "e12", risk: "high" },
                  },
                ],
                thoughts: [],
              };
            }
            return { text: "已发布完成。", calls: [], outputSteps: [], thoughts: [] };
          },
        },
        executor: {
          async call(route: string) {
            if (route === "/browser/click") return { ok: true, clicked: "e12" };
            return { ok: true };
          },
        },
        config: { maxSteps: 5, settleMs: 0, sandboxMode: "restricted" },
        emit: (e: any) => {
          draftEvents.push(e);
          if (e.type === "approval_request") approvalsSeen.push(e);
          if (e.type === "draft_request" && e.callId) {
            setTimeout(() => ctrl1.resolveChoice(e.callId, { approved: true }), 10);
          }
        },
      },
    });
    const draftRes = await runDraftPromise;
    assert.equal(draftRes.status, "done");
    assert.equal(approvalsSeen.length, 0, "approved propose_draft must suppress duplicate high-risk click card");

    // 3. Approval reminder fires after approvalReminderMs while awaiting approval
    const bot2 = store.createSession({ title: "Reminder Bot" });
    let remStep = 0;
    const remEvents: any[] = [];
    const ctrl2 = createControl();
    const resRem = await runTask({
      sessionId: bot2.id,
      userText: "执行危险操作",
      control: ctrl2,
      deps: {
        store,
        model: {
          async nextTurn() {
            remStep += 1;
            if (remStep === 1) {
              return {
                text: "",
                calls: [{ id: "rm_1", name: "host_run_shell", args: { command: "rm -rf /tmp/test-x" } }],
                outputSteps: [
                  {
                    type: "function_call",
                    id: "rm_1",
                    name: "host_run_shell",
                    arguments: { command: "rm -rf /tmp/test-x" },
                  },
                ],
                thoughts: [],
              };
            }
            return { text: "已取消。", calls: [], outputSteps: [], thoughts: [] };
          },
        },
        executor: createFakeExecutor(),
        config: { maxSteps: 3, settleMs: 0, hostExecutionMode: "ask", approvalReminderMs: 25 },
        emit: (e: any) => {
          remEvents.push(e);
          if (e.type === "approval_request") {
            assert.match(e.reason, /rm -rf \/tmp\/test-x/);
            setTimeout(() => ctrl2.resolveApproval(e.callId, false), 70);
          }
        },
      },
    });
    assert.equal(resRem.status, "done");
    assert.ok(remEvents.some((e) => e.type === "approval_reminder" && e.callId === "rm_1"));

    // 4. P2-7: <60s normal DM omits completion header; >=60s or approval/pause injects [上轮回复完成：…] in NEXT user header only
    assert.equal(
      formatPreviousTurnCompletionHeader({
        lastTurnCompletedAt: "2026-11-27T02:00:00.000Z",
        lastTurnDurationMs: 4000,
        lastTurnHadPauseOrApproval: false,
      }),
      ""
    );
    const bot3 = store.createSession({ title: "TimeHeader Bot" });
    // Quick <60s turn first
    await runTask({
      sessionId: bot3.id,
      userText: "第一句短聊",
      userMeta: { sentAt: "2026-11-27T02:00:00.000Z", clientTimeZone: "Asia/Shanghai" },
      deps: {
        store,
        model: {
          async nextTurn(opts: any) {
            const firstText = String(opts.input.slice(-1)[0]?.content?.[0]?.text || "");
            assert.equal(firstText.includes("[上轮回复完成："), false);
            return { text: "短聊回复", calls: [], outputSteps: [{ type: "model_output", text: "短聊回复" }], thoughts: [] };
          },
        },
        executor: createFakeExecutor(),
        config: { maxSteps: 2, settleMs: 0 },
      },
    });
    // Second turn must NOT receive completion header because previous turn was <60s and had no pause/approval
    let secondSawHeader = false;
    await runTask({
      sessionId: bot3.id,
      userText: "第二句追问",
      userMeta: { sentAt: "2026-11-27T02:01:00.000Z", clientTimeZone: "Asia/Shanghai" },
      deps: {
        store,
        model: {
          async nextTurn(opts: any) {
            const lastText = String(opts.input.slice(-1)[0]?.content?.[0]?.text || "");
            secondSawHeader = lastText.includes("[上轮回复完成：");
            return { text: "第二句回复", calls: [], outputSteps: [{ type: "model_output", text: "第二句回复" }], thoughts: [] };
          },
        },
        executor: createFakeExecutor(),
        config: { maxSteps: 2, settleMs: 0 },
      },
    });
    assert.equal(secondSawHeader, false);

    // Simulate previous turn took >= 60s -> third turn receives [上轮回复完成：…] in user header, leaving assistant text untouched
    store.updateSession(bot3.id, {
      lastTurnCompletedAt: "2026-11-27T02:05:30.000Z",
      lastTurnDurationMs: 125_000,
      lastTurnHadPauseOrApproval: false,
    });
    let thirdPromptText = "";
    let thirdAllText = "";
    await runTask({
      sessionId: bot3.id,
      userText: "刚才那步花了多久？",
      userMeta: { sentAt: "2026-11-27T02:06:00.000Z", clientTimeZone: "Asia/Shanghai" },
      deps: {
        store,
        model: {
          async nextTurn(opts: any) {
            const lastUser = opts.input[opts.input.length - 1];
            thirdPromptText = String(lastUser?.content?.[0]?.text || "");
            thirdAllText = JSON.stringify(opts.input.filter((s: any) => s.type === "model_output"));
            return { text: "刚才花了 2 分 5 秒。", calls: [], outputSteps: [], thoughts: [] };
          },
        },
        executor: createFakeExecutor(),
        config: { maxSteps: 2, settleMs: 0 },
      },
    });
    assert.match(thirdPromptText, /\[上轮回复完成：2026-11-27 10:05:30 \+08:00，耗时 2m5s\]/);
    assert.equal(thirdAllText.includes("[上轮回复完成："), false, "assistant history must remain unpolluted");
  } finally {
    cleanup();
  }
});

test("loop reloads live settings.policy per call so clicking Always Allow takes effect within the same batched turn", async () => {
  const { store, cleanup } = createTestStore();
  try {
    const bot = store.createSession({ title: "BatchLivePolicyBot" });
    store.writeSettings({
      hostComputer: { executionMode: "ask" },
      policy: { autoAudit: true, askRules: [], allowRules: [] },
    });

    let llmStep = 0;
    const ctrl = createControl();
    const events: any[] = [];
    const seenApprovalRequests: string[] = [];

    const runPromise = runTask({
      sessionId: bot.id,
      userText: "连续执行两条主机只读或写入测试",
      control: ctrl,
      deps: {
        store,
        enableBotTools: true,
        model: {
          async nextTurn() {
            llmStep += 1;
            if (llmStep === 1) {
              return {
                text: "",
                calls: [
                  { id: "b1", name: "host_run_shell", args: { command: "echo batch-one", risk: "medium" } },
                  { id: "b2", name: "host_run_shell", args: { command: "echo batch-two", risk: "medium" } },
                ],
                outputSteps: [
                  { type: "function_call", id: "b1", name: "host_run_shell", arguments: { command: "echo batch-one", risk: "medium" } },
                  { type: "function_call", id: "b2", name: "host_run_shell", arguments: { command: "echo batch-two", risk: "medium" } },
                ],
                thoughts: [],
              };
            }
            return { text: "批量执行完成。", calls: [], outputSteps: [], thoughts: [] };
          },
        },
        executor: createFakeExecutor(),
        config: { maxSteps: 4, settleMs: 0, hostExecutionMode: "ask" },
        emit: (e: any) => {
          events.push(e);
          if (e.type === "approval_request") {
            seenApprovalRequests.push(e.callId);
            // Simulate user clicking "Always Allow" on the first card and persisting allowRule immediately
            store.writeSettings({
              policy: {
                autoAudit: true,
                askRules: [],
                allowRules: [{ id: "allow-echo", tool: "host_run_shell", pattern: "echo batch", label: "allow batch echo" }],
              },
            });
            setTimeout(() => ctrl.resolveApproval(e.callId, true), 10);
          }
        },
      },
    });

    await runPromise;
    assert.deepEqual(
      seenApprovalRequests,
      ["b1"],
      "Approving b1 with persisted allowRule must suppress b2 confirmation in the exact same turn"
    );
  } finally {
    cleanup();
  }
});


