import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRunner } from "../src/agent/runner.js";
import { createStore } from "../src/store/index.js";

function setupRunnerTest(options: any = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
  const store = createStore(tmpDir);
  const config = {
    defaultModel: "gemini-4-argon",
    models: ["gemini-4-argon", "gemini-3.8-flash"],
    dataDir: tmpDir,
    ...options.config,
  };
  const model = options.model || {};
  const executor = options.executor || {};

  return {
    tmpDir,
    store,
    config,
    model,
    executor,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("runner starts task, emits events, accumulates usage, and updates store", async () => {
  const ctx = setupRunnerTest();
  try {
    const session = ctx.store.createSession({ title: "New Session" });

    let runTaskCalled = false;
    let runTaskControl: any = null;

    async function fakeRunTask({ sessionId, userText, modelName, deps, control }: any) {
      runTaskCalled = true;
      runTaskControl = control;
      assert.equal(sessionId, session.id);
      assert.equal(userText, "find the report");
      assert.equal(modelName, "gemini-4-argon");

      deps.emit({ type: "thought", text: "thinking..." });
      deps.emit({ type: "usage", input: 100, output: 50 });
      deps.emit({ type: "status", status: "done" });
      return { status: "done" };
    }

    const runner = createRunner({
      store: ctx.store,
      config: ctx.config,
      model: ctx.model,
      executor: ctx.executor,
      runTaskImpl: fakeRunTask as any,
    });

    const receivedEvents: any[] = [];
    const unsubscribe = runner.subscribe((ev) => {
      receivedEvents.push(ev);
    });

    assert.deepEqual(runner.status(), { sessionId: null, state: "idle" });

    runner.start(session.id, "find the report");

    // Wait a tick for runTask to finish
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(runTaskCalled, true);
    assert.ok(runTaskControl);

    // Idle after completion
    assert.deepEqual(runner.status(), { sessionId: null, state: "idle" });

    // Events were emitted to subscriber with sessionId and seq
    assert.equal(receivedEvents.length, 3);
    assert.equal(receivedEvents[0].sessionId, session.id);
    assert.equal(receivedEvents[0].type, "thought");
    assert.equal(receivedEvents[0].text, "thinking...");
    assert.equal(receivedEvents[1].type, "usage");
    assert.equal(receivedEvents[2].type, "status");
    assert.equal(receivedEvents[2].status, "done");

    // Events persisted in store
    const storedEvents = ctx.store.readEvents(session.id);
    assert.equal(storedEvents.length, 3);
    assert.equal(storedEvents[0].type, "thought");

    // Session title updated from "New Session"
    const updatedSession = ctx.store.getSession(session.id)!;
    assert.equal(updatedSession.title, "find the report");
    assert.equal(updatedSession.status, "done");
    assert.deepEqual(updatedSession.usage, { input: 100, output: 50 });

    unsubscribe();
  } finally {
    ctx.cleanup();
  }
});

test("runner rejects start when task is already active", async () => {
  const ctx = setupRunnerTest();
  try {
    const session = ctx.store.createSession();
    let releaseTask: any;
    const taskPromise = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });

    async function hangingRunTask() {
      await taskPromise;
      return { status: "done" };
    }

    const runner = createRunner({
      store: ctx.store,
      config: ctx.config,
      model: ctx.model,
      executor: ctx.executor,
      runTaskImpl: hangingRunTask as any,
    });

    runner.start(session.id, "first task");
    assert.equal(runner.status().sessionId, session.id);
    assert.equal(runner.status().state, "running");

    assert.throws(
      () => runner.start(session.id, "second task"),
      /a task is already running/
    );

    releaseTask!();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(runner.status(), { sessionId: null, state: "idle" });
  } finally {
    ctx.cleanup();
  }
});

test("runner pause and resume update state, control, and emit status events", async () => {
  const ctx = setupRunnerTest();
  try {
    const session = ctx.store.createSession();
    let releaseTask;
    let savedControl: any;
    const taskPromise = new Promise((resolve) => {
      releaseTask = resolve;
    });

    async function longRunTask({ control }: any) {
      savedControl = control;
      await taskPromise;
      return { status: "done" };
    }

    const runner = createRunner({
      store: ctx.store,
      config: ctx.config,
      model: ctx.model,
      executor: ctx.executor,
      runTaskImpl: longRunTask as any,
    });

    const events: any[] = [];
    runner.subscribe((ev) => events.push(ev));

    runner.start(session.id, "long task");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(runner.status().state, "running");

    runner.pause();
    assert.equal(runner.status().state, "paused");
    assert.equal(savedControl.paused, true);
    assert.equal(ctx.store.getSession(session.id)!.status, "paused");

    runner.resume();
    assert.equal(runner.status().state, "running");
    assert.equal(savedControl.paused, false);
    assert.equal(ctx.store.getSession(session.id)!.status, "running");

    runner.stop();
    assert.equal(savedControl.stopped, true);

    releaseTask!();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(runner.status(), { sessionId: null, state: "idle" });

    // Verify status events were broadcast
    const pauseEvent = events.find((e) => e.type === "status" && e.status === "paused");
    const resumeEvent = events.find((e) => e.type === "status" && e.status === "running");
    assert.ok(pauseEvent);
    assert.ok(resumeEvent);
  } finally {
    ctx.cleanup();
  }
});

test("runner approve delegates to active control", async () => {
  const ctx = setupRunnerTest();
  try {
    const session = ctx.store.createSession();
    let resolvedValue: any = null;

    async function approvalTask({ control }: any) {
      resolvedValue = await control.requestApproval("call-42");
      return { status: "done" };
    }

    const runner = createRunner({
      store: ctx.store,
      config: ctx.config,
      model: ctx.model,
      executor: ctx.executor,
      runTaskImpl: approvalTask as any,
    });

    runner.start(session.id, "needs approval");
    await new Promise((r) => setTimeout(r, 20));

    runner.approve("call-42", true);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(resolvedValue, true);
  } finally {
    ctx.cleanup();
  }
});

test("runner catches unhandled error in runTaskImpl and resets to idle", async () => {
  const ctx = setupRunnerTest();
  try {
    const session = ctx.store.createSession();

    async function failingTask() {
      throw new Error("unexpected explosion");
    }

    const runner = createRunner({
      store: ctx.store,
      config: ctx.config,
      model: ctx.model,
      executor: ctx.executor,
      runTaskImpl: failingTask as any,
    });

    const events: any[] = [];
    runner.subscribe((ev) => events.push(ev));

    runner.start(session.id, "doomed");
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(runner.status(), { sessionId: null, state: "idle" });

    const errEvent = events.find((e) => e.type === "error");
    assert.ok(errEvent);
    assert.equal(errEvent.message, "unexpected explosion");

    const statusEvent = events.find((e) => e.type === "status" && e.status === "error");
    assert.ok(statusEvent);
  } finally {
    ctx.cleanup();
  }
});

test("runner.stop immediately frees active session so a follow-up start succeeds without 409", async () => {
  const ctx = setupRunnerTest();
  try {
    const session = ctx.store.createSession();
    let releaseFirstTask;
    const firstPromise = new Promise((r) => {
      releaseFirstTask = r;
    });
    const startedTexts: any[] = [];

    async function mockRunTask({ userText }: any) {
      startedTexts.push(userText);
      if (userText === "slow stuck task") {
        await firstPromise;
      }
      return { status: "done", text: `finished ${userText}` };
    }

    const runner = createRunner({
      store: ctx.store,
      config: ctx.config,
      model: ctx.model,
      executor: ctx.executor,
      runTaskImpl: mockRunTask as any,
    });

    runner.start(session.id, "slow stuck task");
    assert.equal(runner.isSessionBusy(session.id), true);

    // Stop the stuck task and immediately start a new message (0ms delay)
    runner.stop(session.id);
    assert.equal(runner.isSessionBusy(session.id), false);

    assert.doesNotThrow(() => {
      runner.start(session.id, "immediate follow-up");
    });

    releaseFirstTask!();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(startedTexts, ["slow stuck task", "immediate follow-up"]);
  } finally {
    ctx.cleanup();
  }
});

test("Phase 3 P2-4: approve/choose never fall back across active sessions on unmatched callId", async () => {
  const ctx = setupRunnerTest();
  try {
    const s1 = ctx.store.createSession({ title: "SessA" });
    const s2 = ctx.store.createSession({ title: "SessB" });
    const approvedCalls: string[] = [];
    let settledS1 = false;
    let settledS2 = false;

    async function mockRunTask({ sessionId, control }: any) {
      if (sessionId === s1.id) {
        const res = await control.requestApproval("call-s1");
        settledS1 = true;
        if (res) approvedCalls.push("call-s1");
      } else {
        const res = await control.requestChoice("call-s2");
        settledS2 = true;
        if (res) approvedCalls.push(`choice:${res}`);
      }
      return { status: "done", text: "ok" };
    }

    const runner = createRunner({
      store: ctx.store,
      config: ctx.config,
      model: ctx.model,
      executor: ctx.executor,
      runTaskImpl: mockRunTask as any,
    });

    runner.start(s1.id, "task 1");
    runner.start(s2.id, "task 2");
    await new Promise((r) => setTimeout(r, 20));

    // Unmatched callId must NOT resolve either session
    runner.approve("non-existent-call", true);
    runner.choose("non-existent-choice", "wrong");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settledS1, false);
    assert.equal(settledS2, false);

    // Exact callId resolves only its owning session
    runner.approve("call-s1", true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settledS1, true);
    assert.equal(settledS2, false);

    runner.choose("call-s2", "picked-b");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settledS2, true);
    assert.deepEqual(approvedCalls, ["call-s1", "choice:picked-b"]);
  } finally {
    ctx.cleanup();
  }
});
