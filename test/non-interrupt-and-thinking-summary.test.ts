import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createRunner } from "../src/agent/runner.js";
import { runTask } from "../src/agent/loop.js";
import { createServer } from "../src/server/index.js";
import {
  isExplicitStopCommand,
  detectSemanticStopIntent,
} from "../src/agent/stop-detector.js";
import {
  fallbackThinkingSummary,
  sanitizeThinkingSummary,
  summarizeThinkingProgress,
} from "../src/agent/thinking-summarizer.js";

function createTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-queue-sum-"));
  const store = createStore(path.join(dir, "data"));
  return {
    dir,
    store,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("isExplicitStopCommand recognizes explicit stop phrases and ignores normal tasks/queries", () => {
  for (const cmd of [
    "停下",
    "停止",
    "停",
    "别做了",
    "算了，别做了",
    "请停止当前任务",
    "stop",
    "Stop!",
    "please stop",
    "abort",
    "cancel",
  ]) {
    assert.equal(isExplicitStopCommand(cmd), true, `expected stop for: ${cmd}`);
  }

  for (const nonStop of [
    "帮我查一下 stop words 是什么",
    "把 nginx 服务停止然后重启",
    "stop docker container",
    "顺便把刚才的文件也发给我",
    "继续执行下一步",
  ]) {
    assert.equal(isExplicitStopCommand(nonStop), false, `expected non-stop for: ${nonStop}`);
  }
});

test("detectSemanticStopIntent uses gemini-4-hydrogen (low thinking) for ambiguous short stop cues", async () => {
  const summaryCalls: any[] = [];
  const modelYes = {
    async summarizeTurn(args: any) {
      summaryCalls.push(args);
      return { text: "YES", usedModel: "gemini-4-hydrogen" };
    },
  };
  const resYes = await detectSemanticStopIntent("先不用再查下去了吧", { model: modelYes as any });
  assert.equal(resYes.shouldStop, true);
  assert.equal(resYes.source, "model");
  assert.equal(summaryCalls[0].model, "gemini-4-hydrogen");
  assert.equal(summaryCalls[0].thinkingLevel, "low");

  const modelNo = {
    async summarizeTurn() {
      return { text: "NO", usedModel: "gemini-4-hydrogen" };
    },
  };
  const resNo = await detectSemanticStopIntent("把这个后台进程停掉看看", { model: modelNo as any });
  assert.equal(resNo.shouldStop, false);
  assert.equal(resNo.source, "model");

  const resNormal = await detectSemanticStopIntent("顺便帮我整理今天的日程安排", {
    model: {
      async summarizeTurn() {
        throw new Error("should not be called for non-cue messages");
      },
    } as any,
  });
  assert.equal(resNormal.shouldStop, false);
  assert.equal(resNormal.source, "rule");
});

test("summarizeThinkingProgress uses gemini-4-hydrogen (low thinking) and sanitizes out commands/paths", async () => {
  const calls: any[] = [];
  const model = {
    async summarizeTurn(args: any) {
      calls.push(args);
      return {
        text: "“正在查看服务器日志并排查异常原因…”",
        usedModel: "gemini-4-hydrogen",
        usage: { input: 60, output: 18 },
      };
    },
  };

  const res = await summarizeThinkingProgress({
    model: model as any,
    userText: "帮我查一下 nginx 为什么报错",
    thoughts: ["Check /var/log/nginx/error.log with run_shell"],
    calls: [{ name: "run_shell", args: { command: "tail -n 50 /var/log/nginx/error.log" } }],
    stepNo: 1,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gemini-4-hydrogen");
  assert.equal(calls[0].thinkingLevel, "minimal");
  assert.equal(res.text, "正在查看服务器日志");
  assert.ok(Array.from(res.text).length < 10);
  assert.equal(/[\p{P}\p{S}\s]/u.test(res.text), false);
  assert.equal(res.usedModel, "gemini-4-hydrogen");

  const leaked = sanitizeThinkingSummary(
    "正在执行 run_shell 查看 /Users/test/.env",
    fallbackThinkingSummary([{ name: "run_shell" }], 1)
  );
  assert.equal(leaked, "正在核查运行环境");

  const punctClause = sanitizeThinkingSummary("正在核对邮件，准备回复内容…");
  assert.equal(punctClause, "正在核对邮件");
  assert.ok(Array.from(punctClause).length < 10);
  assert.equal(/[\p{P}\p{S}\s]/u.test(punctClause), false);

  const sampleToolCalls = [
    [],
    [{ name: "run_shell" }],
    [{ name: "host_run_shell" }],
    [{ name: "read_file" }],
    [{ name: "write_file" }],
    [{ name: "web_search" }],
    [{ name: "web_fetch" }],
    [{ name: "browser_snapshot" }],
    [{ name: "click" }],
    [{ name: "mcp__kimi_cu__click" }],
    [{ name: "mail_list" }],
    [{ name: "generate_image" }],
    [{ name: "send_file" }],
    [{ name: "send_bot_message" }],
    [{ name: "schedule_manage" }],
    [{ name: "memory_manage" }],
    [{ name: "custom_skill_manage" }],
    [{ name: "ask_user_choice" }],
  ];
  for (const c of sampleToolCalls) {
    const fb = fallbackThinkingSummary(c, 1);
    assert.ok(Array.from(fb).length > 0 && Array.from(fb).length < 10, `fallback < 10 chars: ${fb}`);
    assert.equal(/[\p{P}\p{S}\s]/u.test(fb), false, `fallback has no punctuation: ${fb}`);
  }
});

test("summarizeThinkingProgress and detectSemanticStopIntent honor bound routing.tiers instead of falling back to gemini-4-hydrogen", async () => {
  const seenModels: Array<{ model: string; fallbackModel?: string }> = [];
  const fakeModel = {
    async summarizeTurn(args: any) {
      seenModels.push({ model: args.model, fallbackModel: args.fallbackModel });
      return {
        text: args.systemInstruction.includes("YES or NO") ? "NO" : "正在整理回复",
        usedModel: args.model,
        usage: { input: 10, output: 4 },
      };
    },
  };
  const customRoutingConfig = {
    defaultModel: "gemini-4-argon",
    fastModel: "gemini-4-hydrogen",
    thinkingSummaryModel: "gemini-4-hydrogen",
    routing: {
      tiers: {
        fast: { providerId: "deepseek-c0a84aa3", model: "deepseek-flash" },
        medium: { providerId: "deepseek-c0a84aa3", model: "deepseek-v4-pro" },
        advanced: { providerId: "deepseek-c0a84aa3", model: "deepseek-v4-pro" },
      },
    },
  };

  await summarizeThinkingProgress({
    model: fakeModel as any,
    userText: "你好",
    config: customRoutingConfig,
    stepNo: 1,
  });
  await detectSemanticStopIntent("把这个后台进程停掉看看", {
    model: fakeModel as any,
    config: customRoutingConfig,
  });

  assert.equal(seenModels.length, 2);
  for (const call of seenModels) {
    assert.equal(call.model, "deepseek-c0a84aa3::deepseek-flash");
    assert.equal(call.fallbackModel, "deepseek-c0a84aa3::deepseek-v4-pro");
  }
});

test("runTask emits single-sentence thinking_summary via gemini-4-hydrogen (low) without raw commands", async () => {
  const { store, cleanup } = createTempEnv();
  try {
    const s = store.createSession({ title: "Nori" });
    const events: any[] = [];
    let turnIdx = 0;

    const model = {
      async nextTurn() {
        turnIdx += 1;
        if (turnIdx === 1) {
          return {
            thoughts: ["Need to inspect disk space via df -h"],
            text: "",
            calls: [{ id: "c1", name: "run_shell", args: { command: "df -h" } }],
            outputSteps: [{ id: "c1", type: "function_call", name: "run_shell", args: { command: "df -h" } }],
            usage: { input: 20, output: 10 },
          };
        }
        return {
          thoughts: [],
          text: "磁盘空间充足。",
          calls: [],
          outputSteps: [{ type: "model_output", text: "磁盘空间充足。" }],
          usage: { input: 25, output: 15 },
        };
      },
      async summarizeTurn(args: any) {
        assert.equal(args.model, "gemini-4-hydrogen");
        assert.equal(args.thinkingLevel, "minimal");
        return {
          text: "正在核查磁盘空间！",
          usedModel: "gemini-4-hydrogen",
          usage: { input: 40, output: 14 },
        };
      },
    };

    const executor = {
      async call(route: any) {
        if (route === "/shell") {
          await new Promise((r) => setTimeout(r, 25));
          return { exit_code: 0, stdout: "Filesystem ...", stderr: "" };
        }
        return { png_base64: Buffer.from("png").toString("base64"), width: 1440, height: 900 };
      },
    };

    const res = await runTask({
      sessionId: s.id,
      userText: "检查磁盘空间",
      deps: {
        model,
        executor,
        store,
        config: { settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });

    assert.equal(res.status, "done");
    const summaries = events.filter((e) => e.type === "thinking_summary");
    assert.ok(summaries.length >= 1);
    assert.ok(
      summaries.some((e) => e.text === "正在核查磁盘空间"),
      "should emit sanitized summary under 10 chars without punctuation"
    );
    for (const sum of summaries) {
      assert.ok(!sum.text.includes("df -h"));
      assert.ok(!sum.text.includes("run_shell"));
      assert.ok(Array.from(sum.text).length < 10, `expected < 10 chars: ${sum.text}`);
      assert.equal(/[\p{P}\p{S}\s]/u.test(sum.text), false, `expected zero punctuation: ${sum.text}`);
    }
  } finally {
    cleanup();
  }
});

test("runner.enqueue live-steers active runs immediately without blocking behind a user queue", async () => {
  const { store, cleanup } = createTempEnv();
  try {
    const s = store.createSession({ title: "Nori" });
    let releaseFirst;
    const firstGate = new Promise((r) => {
      releaseFirst = r;
    });
    const executionOrder: any[] = [];
    const controls: any[] = [];
    const steeredObserved: any[] = [];

    async function mockRunTask({ userText, deps, control }: any) {
      executionOrder.push(userText);
      controls.push(control);
      if (userText === "任务一") {
        await firstGate;
        assert.equal(control.stopped, false, "first task must NOT be stopped by follow-up message");
      }
      deps.emit({ type: "answer", text: `完成:${userText}` });
      deps.emit({ type: "status", status: "done" });
      return { status: "done", text: `完成:${userText}` };
    }

    const runner = createRunner({
      store,
      config: { defaultModel: "gemini-4-argon" },
      runTaskImpl: mockRunTask as any,
    });

    const events: any[] = [];
    runner.subscribe((e) => events.push(e));

    const r1 = runner.enqueue(s.id, "任务一");
    assert.deepEqual(r1, { queued: false, steered: false, queueLength: 0 });
    await new Promise((r) => setTimeout(r, 15));

    const r2 = runner.enqueue(s.id, "任务二");
    assert.deepEqual(r2, { queued: false, steered: true, queueLength: 0 });
    assert.equal(controls[0].stopped, false);
    assert.equal(controls[0].hasSteeredMessages(), true);

    const r3 = runner.enqueue(s.id, "任务三");
    assert.deepEqual(r3, { queued: false, steered: true, queueLength: 0 });
    steeredObserved.push(...store.readEvents(s.id).filter((e) => e.type === "user"));

    // Follow-up user messages must appear immediately with queued != true
    assert.deepEqual(
      steeredObserved.map((e) => ({ text: e.text, queued: Boolean(e.queued) })),
      [
        { text: "任务二", queued: false },
        { text: "任务三", queued: false },
      ]
    );
    assert.equal(runner.queueStatus(s.id), 0);

    releaseFirst!();
    await new Promise((r) => setTimeout(r, 60));

    assert.deepEqual(executionOrder, ["任务一", "任务二\n\n任务三"]);
    assert.equal(runner.queueStatus(s.id), 0);
    assert.equal(runner.isSessionBusy(s.id), false);

    // Stop clears remaining steered tasks when active
    let releaseBlocked: any;
    const blockedRunner = createRunner({
      store,
      config: { defaultModel: "gemini-4-argon" },
      runTaskImpl: (async ({ userText }: any) => {
        if (userText === "长任务") {
          await new Promise((r) => {
            releaseBlocked = r;
          });
        }
        return { status: "done" };
      }) as any,
    });
    blockedRunner.enqueue(s.id, "长任务");
    await new Promise((r) => setTimeout(r, 10));
    const steeredRes = blockedRunner.enqueue(s.id, "不应执行的后续指令");
    assert.equal(steeredRes.steered, true);
    assert.equal(blockedRunner.queueStatus(s.id), 0);
    blockedRunner.stop(s.id);
    releaseBlocked?.();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(blockedRunner.isSessionBusy(s.id), false);
    assert.equal(
      store.readEvents(s.id).some((e) => e.type === "answer" && String(e.text).includes("不应执行的后续指令")),
      false
    );
  } finally {
    cleanup();
  }
});

test("HTTP POST /api/sessions/:id/messages live-steers while busy and stops only on explicit stop command", async () => {
  const { dir, store, cleanup } = createTempEnv();
  let releaseFirst;
  const firstGate = new Promise((r) => {
    releaseFirst = r;
  });
  const started: any[] = [];
  let activeCtrl: any = null;

  const runner = createRunner({
    store,
    config: { defaultModel: "gemini-4-argon" },
    runTaskImpl: (async ({ userText, deps, control }: any) => {
      started.push(userText);
      activeCtrl = control;
      if (userText === "第一步任务") {
        await firstGate;
      }
      if (!control.stopped) {
        deps.emit({ type: "answer", text: `ok:${userText}` });
        deps.emit({ type: "status", status: "done" });
      }
      return { status: control.stopped ? "stopped" : "done" };
    }) as any,
  });

  const server = createServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(dir, "data"),
      writeRoots: [dir],
    },
    store,
    runner,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as any;
  const base = `http://127.0.0.1:${port}`;

  try {
    const s = store.createSession({ title: "Nori" });

    const res1 = await fetch(`${base}/api/sessions/${s.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "第一步任务" }),
    });
    assert.equal(res1.status, 202);
    const b1 = await res1.json();
    assert.equal(b1.queued, false);

    await new Promise((r) => setTimeout(r, 15));

    // Normal message while busy -> 202 steered immediately without queueing, does NOT stop run
    const res2 = await fetch(`${base}/api/sessions/${s.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "顺便帮我再总结一下" }),
    });
    assert.equal(res2.status, 202);
    const b2 = await res2.json();
    assert.equal(b2.queued, false);
    assert.equal(b2.steered, true);
    assert.equal(b2.queueLength, 0);
    assert.equal(activeCtrl.stopped, false);

    releaseFirst!();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(started, ["第一步任务", "顺便帮我再总结一下"]);

    // Now test explicit stop command while busy
    let releaseLong: any;
    const runner2 = createRunner({
      store,
      config: { defaultModel: "gemini-4-argon" },
      runTaskImpl: (async ({ control }: any) => {
        activeCtrl = control;
        await new Promise((r) => {
          releaseLong = r;
        });
        return { status: "stopped" };
      }) as any,
    });
    const srv2 = createServer({
      config: { host: "127.0.0.1", port: 0, dataDir: path.join(dir, "data"), writeRoots: [dir] },
      store,
      runner: runner2,
    });
    await new Promise<void>((resolve) => srv2.listen(0, "127.0.0.1", resolve));
    const port2 = (srv2.address() as any).port;

    await fetch(`http://127.0.0.1:${port2}/api/sessions/${s.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "长耗时任务" }),
    });
    await new Promise((r) => setTimeout(r, 15));

    const stopRes = await fetch(`http://127.0.0.1:${port2}/api/sessions/${s.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "停下" }),
    });
    assert.equal(stopRes.status, 202);
    const stopBody = await stopRes.json();
    assert.equal(stopBody.stopped, true);
    assert.equal(activeCtrl.stopped, true);

    releaseLong?.();
    await new Promise<void>((r) => srv2.close(() => r()));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
  }
});

test("frontend unlocks composer during execution and renders compact thinking bubble fixed above composer with Stop button", async () => {
  const { readWebSourceTs, renderAppHtml } = await import("./helpers/react-test-helpers.js");
  const appJs = readWebSourceTs();
  const styleCss = fs.readFileSync(path.resolve(process.cwd(), "public/style.css"), "utf8");

  assert.ok(!appJs.includes("interrupt: true"), "frontend must not interrupt previous run on message send");
  assert.ok(!appJs.includes("sendBtn.disabled = true"), "send button must remain enabled during execution");
  assert.ok(!appJs.includes('sendBtn.dataset.mode = "stop"'), "composer right button must never enter stop mode");

  // Verify busy state declaratively mounts #live-working-bubble and #composer-queue-banner inside #composer-wrap
  const busyHtml = renderAppHtml({
    sessionStatus: "running",
    liveThinkingSummary: "正在分析当前需求",
    queuedCount: 2,
  });
  assert.match(busyHtml, /id="composer-wrap"[\s\S]*?id="live-working-bubble"[\s\S]*?正在分析当前需求[\s\S]*?id="live-working-stop-btn"/);
  assert.match(busyHtml, /id="composer-queue-banner"[\s\S]*?class="composer-queue-stop-btn"/);

  assert.ok(appJs.includes("sanitizeLiveThinkingSummary("), "frontend must sanitize thinking summary to < 10 chars with zero punctuation");
  assert.ok(appJs.includes('case "thinking_summary":'), "frontend must handle thinking_summary events");
  assert.ok(appJs.includes("stopCurrentSessionTask"));
  assert.ok(!appJs.includes("updateHeaderStats(liveHint)"), "thinking bubble must not show raw tool step commands");
  assert.ok(appJs.includes("liveThinkingSummary"), "thinking bubble must read sanitized summary");

  for (const label of ["等待确认当前操作", "等待你的选择确认", "已接管等待恢复", "正在思考处理中"]) {
    assert.ok(appJs.includes(`"${label}"`), `missing frontend working label: ${label}`);
    assert.ok(Array.from(label).length < 10, `frontend label must be < 10 chars: ${label}`);
    assert.equal(/[\p{P}\p{S}\s]/u.test(label), false, `frontend label must have zero punctuation: ${label}`);
  }

  assert.ok(
    appJs.includes("reduceSessionEvent(working, ev, { replay: true"),
    "selectSession must replay historical events without reviving stale running status"
  );
  assert.match(
    appJs,
    /if\s*\(!replay\s*&&\s*prev\.renderedSeqs\.has\(evt\.seq\)\)/,
    "replay must not drop events when historical logs contain colliding seq numbers"
  );
  assert.ok(
    /if\s*\(!replay\)\s*\{\s*sessionStatus\s*=\s*"awaiting_approval"/.test(appJs) ||
      /if\s*\(!replay\)\s*sessionStatus\s*=\s*"awaiting_approval"/.test(appJs),
    "replay of old approval requests must not overwrite authoritative session status"
  );
  assert.ok(
    /if\s*\(!replay\)\s*\{\s*sessionStatus\s*=\s*"awaiting_choice"/.test(appJs) ||
      /if\s*\(!replay\)\s*sessionStatus\s*=\s*"awaiting_choice"/.test(appJs),
    "replay of old choice requests must not overwrite authoritative session status"
  );
  assert.ok(appJs.includes("composer-queue-stop-btn"), "queue banner must include a stop abort button");
  assert.ok(styleCss.includes(".live-working-stop-btn"));
  assert.ok(styleCss.includes(".composer-queue-banner"));
  assert.ok(styleCss.includes(".composer-queue-stop-btn"));
  assert.ok(styleCss.includes("align-self: flex-end;"), "live-activity-row must align bottom-right above composer");
  assert.ok(styleCss.includes("has-live-bubble .scroll-bottom-btn"), "scroll-bottom-btn must shift up when live bubble is active");
});

test("runner.stop clears orphaned persisted awaiting_approval status even without activeRuns", () => {
  const { store, cleanup } = createTempEnv();
  try {
    const s = store.createSession({ title: "Stuck Bot" });
    store.updateSession(s.id, { status: "awaiting_approval" });

    const runner = createRunner({
      store,
      config: { defaultModel: "gemini-4-argon" },
    });

    runner.stop(s.id);
    assert.equal(store.getSession(s.id)!.status, "stopped");
    const events = store.readEvents(s.id);
    assert.equal(events[events.length - 1].status, "stopped");
  } finally {
    cleanup();
  }
});

test("live mid-turn steering preempts stalled model thinking immediately and preserves prior context", async () => {
  const { store, cleanup } = createTempEnv();
  try {
    const s = store.createSession({ title: "Nori" });
    let callCount = 0;
    let firstSignalAborted = false;
    let secondCallInputs: any = null;

    const fakeModel = {
      async nextTurn({ input, signal }: any) {
        callCount += 1;
        if (callCount === 1) {
          // Simulate slow thinking in first step that never resolves on its own until steered
          return await new Promise((resolve, reject) => {
            if (signal?.aborted) {
              firstSignalAborted = true;
              return reject(new Error("aborted"));
            }
            signal?.addEventListener("abort", () => {
              firstSignalAborted = true;
              reject(new Error("aborted"));
            });
          });
        }
        secondCallInputs = JSON.parse(JSON.stringify(input));
        return {
          text: "已结合第一轮上下文和新消息完成处理",
          calls: [],
          outputSteps: [{ type: "text", text: "已结合第一轮上下文和新消息完成处理" }],
          thoughts: [],
          usage: { input: 10, output: 10 },
          usedModel: "gemini-4-argon",
        };
      },
      async summarizeTurn() {
        return { text: "摘要", thoughts: [], calls: [], outputSteps: [], usage: { input: 1, output: 1 } };
      },
    };

    const runner = createRunner({
      store,
      model: fakeModel,
      executor: { call: async () => ({ png_base64: Buffer.from("png").toString("base64") }) },
      config: { defaultModel: "gemini-4-argon" },
      runTaskImpl: runTask,
    });

    const events: any[] = [];
    runner.subscribe((e) => events.push(e));

    runner.enqueue(s.id, "帮我分析项目代码架构");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(callCount, 1, "first nextTurn should already be in-flight thinking");

    const steerRes = runner.enqueue(s.id, "顺便优先检查 runner.js");
    assert.equal(steerRes.queued, false);
    assert.equal(steerRes.steered, true);

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(firstSignalAborted, true, "first in-flight thinking call must abort immediately on steer");
    assert.equal(callCount, 2, "second nextTurn must execute immediately with steered message");
    assert.equal(runner.isSessionBusy(s.id), false);

    const flatText = JSON.stringify(secondCallInputs);
    assert.ok(flatText.includes("帮我分析项目代码架构"), "must preserve original initial prompt");
    assert.ok(flatText.includes("顺便优先检查 runner.js"), "must include new follow-up message");
    assert.ok(
      events.some((e) => e.type === "answer" && e.text.includes("已结合第一轮上下文和新消息完成处理")),
      "must emit final answer cleanly"
    );
  } finally {
    cleanup();
  }
});

test("live mid-turn steering supersedes awaiting_choice cleanly while keeping function_call/result paired", async () => {
  const { store, cleanup } = createTempEnv();
  try {
    const s = store.createSession({ title: "Nori" });
    let callCount = 0;
    let secondCallInputs: any = null;

    const fakeModel = {
      async nextTurn({ input }: any) {
        callCount += 1;
        if (callCount === 1) {
          return {
            text: "",
            calls: [
              {
                id: "call_choice_1",
                name: "ask_user_choice",
                args: {
                  question: "选哪个方案？",
                  options: ["方案 A", "方案 B"],
                },
              },
            ],
            outputSteps: [
              {
                type: "function_call",
                id: "call_choice_1",
                name: "ask_user_choice",
                arguments: { question: "选哪个方案？", options: ["方案 A", "方案 B"] },
              },
            ],
            thoughts: [],
            usage: { input: 10, output: 10 },
            usedModel: "gemini-4-argon",
          };
        }
        secondCallInputs = JSON.parse(JSON.stringify(input));
        return {
          text: "好的，直接按方案 B 并加上测试继续执行",
          calls: [],
          outputSteps: [{ type: "text", text: "好的，直接按方案 B 并加上测试继续执行" }],
          thoughts: [],
          usage: { input: 10, output: 10 },
          usedModel: "gemini-4-argon",
        };
      },
      async summarizeTurn() {
        return { text: "摘要", thoughts: [], calls: [], outputSteps: [], usage: { input: 1, output: 1 } };
      },
    };

    const runner = createRunner({
      store,
      model: fakeModel,
      executor: { call: async () => ({ png_base64: Buffer.from("png").toString("base64") }) },
      config: { defaultModel: "gemini-4-argon", enableBotTools: true },
      runTaskImpl: runTask,
    });

    const events: any[] = [];
    runner.subscribe((e) => events.push(e));

    runner.enqueue(s.id, "重构登录模块");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.getSession(s.id)!.status, "awaiting_choice");

    const steerRes = runner.enqueue(s.id, "直接用方案 B 并加上测试");
    assert.equal(steerRes.steered, true);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(callCount, 2);
    assert.equal(runner.isSessionBusy(s.id), false);
    assert.ok(events.some((e) => e.type === "choice_superseded" && e.callId === "call_choice_1"));
    assert.ok(secondCallInputs.some((step: any) => step.type === "function_call" && step.id === "call_choice_1"));
    assert.ok(secondCallInputs.some((step: any) => step.type === "function_result" && step.call_id === "call_choice_1"));
    assert.ok(JSON.stringify(secondCallInputs).includes("直接用方案 B 并加上测试"));
    assert.ok(events.some((e) => e.type === "answer" && e.text.includes("方案 B")));
  } finally {
    cleanup();
  }
});

test("Phase 5 P1-1: thinking-summarizer throttles consecutive same-domain steps even when thoughts are present", async () => {
  const { store, cleanup } = createTempEnv();
  try {
    const s = store.createSession({ title: "Summary Throttle" });
    const summaryCalls: any[] = [];
    const emitted: any[] = [];
    let turnIdx = 0;

    const model = {
      async nextTurn() {
        turnIdx += 1;
        if (turnIdx <= 3) {
          return {
            thoughts: [`Thinking deeply on shell step ${turnIdx}`],
            text: "",
            calls: [{ id: `c_${turnIdx}`, name: "run_shell", args: { command: `echo step_${turnIdx}` } }],
            outputSteps: [
              { id: `c_${turnIdx}`, type: "function_call", name: "run_shell", args: { command: `echo step_${turnIdx}` } },
            ],
            usage: { input: 20, output: 10 },
          };
        }
        return {
          thoughts: [],
          text: "全部执行完成。",
          calls: [],
          outputSteps: [{ type: "model_output", text: "全部执行完成。" }],
          usage: { input: 25, output: 15 },
        };
      },
      async summarizeTurn(args: any) {
        summaryCalls.push(args);
        return {
          text: "正在执行脚本检查",
          usedModel: "gemini-4-hydrogen",
          usage: { input: 20, output: 4 },
        };
      },
    };

    const executor = {
      async call(route: any) {
        if (route === "/shell") {
          return { exit_code: 0, stdout: "ok", stderr: "" };
        }
        return { png_base64: Buffer.from("png").toString("base64"), width: 1440, height: 900 };
      },
    };

    const res = await runTask({
      sessionId: s.id,
      userText: "帮我检查一下几个服务器状态",
      deps: {
        model,
        executor,
        store,
        config: {
          fastModel: "gemini-4-hydrogen",
          thinkingSummaryModel: "gemini-4-hydrogen",
          settleMs: 0,
        },
        emit: (e: any) => emitted.push(e),
      },
    });
    assert.equal(res.status, "done");
    // Step 1 init + step 2 domain change init->shell call summarizeTurn, step 3 (same domain shell, <3 steps & <12s) uses fallback!
    assert.equal(summaryCalls.length, 2);
    assert.equal(summaryCalls[0].thinkingLevel, "minimal");
    assert.ok(emitted.some((e) => e.type === "thinking_summary" && e.source === "fallback"));
  } finally {
    cleanup();
  }
});
