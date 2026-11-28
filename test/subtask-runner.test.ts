import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SUBTASK_READONLY_TOOLS,
  getSubtaskToolDeclarations,
  runSubtask,
} from "../src/agent/subtask-runner.js";
import { runBotCollabTool, BOT_COLLAB_TOOL_DECLARATIONS } from "../src/agent/bot-tools.js";

test("run_subtask is registered and exposes only strict read-only tool declarations", () => {
  assert.ok(BOT_COLLAB_TOOL_DECLARATIONS.some((d) => d.name === "run_subtask"));
  const decls = getSubtaskToolDeclarations();
  const names = decls.map((d) => d.name);
  for (const name of names) {
    assert.ok(SUBTASK_READONLY_TOOLS.has(name), `Unexpected tool in subtask whitelist: ${name}`);
  }
  for (const forbidden of [
    "run_shell",
    "host_run_shell",
    "write_file",
    "host_write_file",
    "edit_file",
    "send_bot_message",
    "mail_send_message",
    "run_subtask",
  ]) {
    assert.equal(names.includes(forbidden), false, `Forbidden tool exposed: ${forbidden}`);
  }
});

test("runSubtask blocks recursive calls, enforces read-only library_manage, and forwards usage", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-subtask-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const sampleFile = path.join(tmpDir, "report.txt");
  fs.writeFileSync(sampleFile, "Revenue Q1: $120k\n", "utf8");

  // Recursive call must be blocked
  const recursiveRes = await runSubtask({ goal: "nested" }, { isSubtask: true });
  assert.equal(recursiveRes.ok, false);
  assert.match(String(recursiveRes.error || ""), /recursively/);

  let step = 0;
  let capturedTools: string[] = [];
  const usageCalls: any[] = [];

  const mockModel: any = {
    nextTurn: async ({ tools }: any) => {
      step += 1;
      capturedTools = (tools || []).map((t: any) => t.name);
      if (step === 1) {
        return {
          calls: [
            { id: "c1", name: "host_read_file", args: { path: sampleFile } },
            { id: "c2", name: "library_manage", args: { action: "save_note", title: "x", content: "y" } },
            { id: "c3", name: "host_read_file", args: { path: "/Users/demo/.ssh/id_rsa" } },
          ],
          usage: { input: 100, output: 20 },
        };
      }
      return {
        text: "汇总完成：Q1 营收为 $120k。秘钥示例 sk-1234567890abcdef12345678",
        calls: [],
        usage: { input: 150, output: 30 },
      };
    },
  };

  const res = await runBotCollabTool(
    "run_subtask",
    {
      goal: "读取 report.txt 并提炼营收数字",
      context_hints: sampleFile,
      expected_format: "单行结论",
      max_steps: 4,
    },
    {
      model: mockModel,
      config: { hostExecutionMode: "always" },
      onUsage: (u: any) => usageCalls.push(u),
    }
  );

  assert.equal(res.ok, true);
  assert.equal(res.stepsUsed, 2);
  assert.equal(capturedTools.includes("host_read_file"), true);
  assert.equal(capturedTools.includes("run_shell"), false);
  assert.equal(usageCalls.length, 2);
  assert.match(res.summary, /Q1 营收为 \$120k/);
  assert.equal(res.summary.includes("sk-1234567890abcdef12345678"), false);
});

test("runSubtask truncates overly long outputs and enforces step cap", async () => {
  const hugeText = "A".repeat(10_000);
  const mockModel: any = {
    nextTurn: async () => ({ text: hugeText, calls: [] }),
  };
  const res = await runSubtask({ goal: "return huge summary" }, { model: mockModel });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.ok(res.summary.length <= 8050);

  let turns = 0;
  const loopingModel: any = {
    nextTurn: async () => {
      turns += 1;
      return {
        calls: [{ id: `c-${turns}`, name: "app_knowledge", args: { action: "list" } }],
      };
    },
  };
  const capped = await runSubtask({ goal: "loop", max_steps: 2 }, { model: loopingModel });
  assert.equal(capped.ok, true);
  assert.equal(capped.stepsUsed, 2);
  assert.equal(capped.reachedMaxSteps, true);
});
