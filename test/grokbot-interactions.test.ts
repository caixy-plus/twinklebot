import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store/index.js";
import { createRunner } from "../src/agent/runner.js";
import { runTask, createControl } from "../src/agent/loop.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import { selectGroupSpeakers } from "../src/agent/group-coordinator.js";
import { createServer } from "../src/server/index.js";

function createTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinklebot-grok-ux-"));
  const workspaceDir = path.join(dir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = createStore(path.join(dir, "data"));
  return {
    dir,
    workspaceDir,
    store,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("loop emits interim assistant_text bubble before tool execution when model provides pre-action text", async () => {
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
            thoughts: [],
            text: "我马上查一下我这台电脑现在的出口 IP 在哪。",
            calls: [
              {
                id: "c_ip",
                name: "run_shell",
                args: { command: "curl -s ipinfo.io", risk: "low" },
              },
            ],
            outputSteps: [
              {
                type: "function_call",
                id: "c_ip",
                name: "run_shell",
                args: { command: "curl -s ipinfo.io" },
              },
            ],
            usage: { input: 10, output: 12 },
          };
        }
        return {
          thoughts: [],
          text: "查到了，当前出口在伦敦。",
          calls: [],
          outputSteps: [{ type: "model_output", text: "查到了，当前出口在伦敦。" }],
          usage: { input: 15, output: 18 },
        };
      },
    };
    const executor = {
      async call(route: any) {
        if (route === "/screenshot") {
          return { png_base64: Buffer.from("png").toString("base64"), width: 1440, height: 900 };
        }
        return { exit_code: 0, stdout: "London", stderr: "" };
      },
    };

    const res = await runTask({
      sessionId: s.id,
      userText: "你的电脑是在哪里",
      userMeta: {
        replyTo: { seq: 1, author: "Nori", snippet: "你好" },
        quotes: ["出口 IP"],
      },
      deps: {
        model,
        executor,
        store,
        config: { settleMs: 0 },
        emit: (e: any) => events.push(e),
      },
    });

    assert.equal(res.status, "done");
    const userEvt = events.find((e) => e.type === "user");
    assert.equal(userEvt.replyTo.snippet, "你好");
    assert.deepEqual(userEvt.quotes, ["出口 IP"]);

    const interimIdx = events.findIndex(
      (e) => e.type === "assistant_text" && e.interim === true
    );
    const actionIdx = events.findIndex((e) => e.type === "action");
    const finalIdx = events.findIndex((e) => e.type === "answer");

    assert.ok(interimIdx !== -1, "should emit interim pre-action bubble");
    assert.ok(interimIdx < actionIdx, "interim bubble must precede tool action");
    assert.ok(actionIdx < finalIdx, "tool action must precede final answer");
    assert.equal(events[interimIdx].text, "我马上查一下我这台电脑现在的出口 IP 在哪。");
  } finally {
    cleanup();
  }
});

test("ask_user_choice supports multi-question stepper, custom answer, and supersedes cleanly on stop", async () => {
  const { store, cleanup } = createTempEnv();
  try {
    const s = store.createSession({ title: "Nori" });
    const ctrl = createControl();
    const emitted: any[] = [];

    const p = runBotCollabTool(
      "ask_user_choice",
      {
        questions: [
          {
            id: "step",
            question: "接下来先帮你做哪一步？",
            options: ["清理归档旧邮件", "检查安全提醒"],
          },
          {
            id: "notify",
            question: "处理完怎么通知你？",
            options: ["直接发总结", "静默归档"],
          },
        ],
      },
      {
        store,
        senderSessionId: s.id,
        control: ctrl,
        callId: "q_batch_1",
        emit: (e: any) => emitted.push(e),
      }
    );

    await new Promise((r) => setTimeout(r, 10));
    const reqEvt = emitted.find((e) => e.type === "choice_request");
    assert.ok(reqEvt);
    assert.equal(reqEvt.questions.length, 2);
    assert.equal(reqEvt.allowCustom, true);

    // Resolve with custom "Your own answer" on q1 and preset on q2
    ctrl.resolveChoice("q_batch_1", {
      answers: {
        step: "先只归档 Claude 相关的旧信",
        notify: "直接发总结",
      },
      isCustom: true,
    });

    const out = await p;
    assert.equal(out.ok, true);
    assert.equal(out.selected.answers.step, "先只归档 Claude 相关的旧信");

    // Test supersede when stopped mid-card
    const ctrl2 = createControl();
    const emitted2: any[] = [];
    const p2 = runBotCollabTool(
      "propose_draft",
      {
        title: "回复客户邮件草稿",
        recipient: "alice@example.com",
        content: "您好，问题已修复。",
      },
      {
        store,
        senderSessionId: s.id,
        control: ctrl2,
        callId: "draft_1",
        emit: (e: any) => emitted2.push(e),
      }
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(emitted2.some((e) => e.type === "draft_request"));
    ctrl2.stop();
    const out2 = await p2;
    assert.ok(out2.error);
    assert.ok(emitted2.some((e) => e.type === "choice_superseded"));
  } finally {
    cleanup();
  }
});

test("selectGroupSpeakers prioritizes replyToBotId in group chats", () => {
  const bots = [
    { id: "b1", title: "Nori", rolePrompt: "总管" },
    { id: "b2", title: "代码动画师", rolePrompt: "前端动画" },
    { id: "b3", title: "Gmail 小助理", rolePrompt: "邮件清理" },
  ];
  const speakers = selectGroupSpeakers({
    text: "把这个细节再改顺滑一点",
    memberBots: bots,
    replyToBotId: "b2",
    maxSpeakers: 2,
  });
  assert.equal(speakers[0].id, "b2");
});

test("HTTP APIs: message replyTo/quotes, removed reactions/feedback routes return 404, and approval Edit rule", async () => {
  const { dir, workspaceDir, store, cleanup } = createTempEnv();
  const executor = {
    async call() {
      return { png_base64: Buffer.from("png").toString("base64"), width: 1440, height: 900 };
    },
  };
  const model = {
    async nextTurn() {
      return {
        thoughts: [],
        text: "这是给你的回复方案。",
        calls: [],
        outputSteps: [{ type: "model_output", text: "这是给你的回复方案。" }],
        usage: { input: 5, output: 8 },
      };
    },
  };
  const config = {
    host: "127.0.0.1",
    port: 0,
    writeRoots: [workspaceDir],
    dataDir: path.join(dir, "data"),
    settleMs: 0,
  };
  const runner = createRunner({ store, config, model, executor });
  const server = createServer({ config, store, runner, executor });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as any;
  const base = `http://127.0.0.1:${port}`;

  try {
    const sRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gmail 小助理" }),
    });
    const session = await sRes.json();

    // 1. Send message with replyTo and quotes
    const mRes = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "按这个执行",
        replyTo: { seq: 1, author: "Gmail 小助理", snippet: "可清理旧信" },
        quotes: ["Claude 退款相关旧信"],
      }),
    });
    assert.equal(mRes.status, 202);
    await new Promise((r) => setTimeout(r, 80));

    const detailRes = await fetch(`${base}/api/sessions/${session.id}`);
    const detail = await detailRes.json();
    const userEv = detail.events.find((e: any) => e.type === "user");
    const ansEv = detail.events.find((e: any) => e.type === "answer");
    assert.equal(userEv.replyTo.snippet, "可清理旧信");
    assert.deepEqual(userEv.quotes, ["Claude 退款相关旧信"]);
    assert.ok(ansEv);

    // 2. Removed reactions / feedback / tts endpoints return 404
    const rReact = await fetch(`${base}/api/sessions/${session.id}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: ansEv.seq, emoji: "⏰" }),
    });
    assert.equal(rReact.status, 404);
    const rFb = await fetch(`${base}/api/sessions/${session.id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: ansEv.seq, reasonTag: "格式不对" }),
    });
    assert.equal(rFb.status, 404);
    const rTts = await fetch(`${base}/api/tts/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "测试" }),
    });
    assert.equal(rTts.status, 404);

    // 3. Approval inline Edit rule (`customRule` with mode: "ask")
    const appRes = await fetch(`${base}/api/approvals/test_call_99`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allow: false,
        customRule: {
          mode: "ask",
          tool: "run_shell",
          pattern: "ssh",
          label: "所有 ssh 命令必须先询问",
        },
      }),
    });
    assert.equal(appRes.status, 200);
    const settingsAfterRule = store.readSettings();
    assert.ok(
      settingsAfterRule.policy.askRules.some((r: any) => r.pattern === "ssh")
    );
  } finally {
    server.close();
    cleanup();
  }
});
