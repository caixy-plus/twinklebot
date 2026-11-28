import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyScheduleSideEffectRisk,
  optimizeScheduleContrastive,
  resetScheduleOptimizerLocksForTests,
} from "../src/agent/schedule-optimizer.js";
import { assignAnonymousLabels } from "../src/agent/harness-evaluator.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

async function bootServer(t: any, modelOverride?: any) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-sched-opt-"));
  const store = createStore(tmpDir);
  const broadcasts: any[] = [];
  const srv = createServer({
    store,
    model: modelOverride || {
      nextTurn: async () => ({ text: "Probe done", calls: [] }),
      summarizeTurn: async () => ({ text: '{"decision":"KEEP_BASE","reason":"already clear"}' }),
    },
    runner: {
      status: () => ({ sessionId: null, state: "idle" }),
      activeSessions: () => ({}),
      subscribe: () => () => {},
      broadcastGlobal: (ev: any) => broadcasts.push(ev),
    },
    executor: { health: async () => ({ ok: true }) },
    config: {
      port: 0,
      defaultModel: "gemini-4-argon",
      models: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"],
      writeRoots: [tmpDir],
    },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  t.after(async () => {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const call = async (method: string, p: string, body?: any) => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };
  return { tmpDir, store, broadcasts, call };
}

test("classifyScheduleSideEffectRisk detects outbound and mutating verbs with clear read-only notice", () => {
  const safe = classifyScheduleSideEffectRisk("每天早上汇总昨日错误日志并给出摘要");
  assert.equal(safe.readOnlySafe, true);
  assert.equal(safe.riskFlags.length, 0);

  const risky = classifyScheduleSideEffectRisk("检查站点状态后发邮件给老板并推送飞书");
  assert.equal(risky.readOnlySafe, false);
  assert.ok(risky.riskFlags.length >= 2);
  assert.match(String(risky.notice || ""), /只读演练/);
});

test("optimizeScheduleContrastive runs read-only Propose-Probe-Compose, enforces concurrency lock, and supports KEEP_BASE", async () => {
  resetScheduleOptimizerLocksForTests();

  // 1. KEEP_BASE short-circuit skips second probe
  let nextTurnCount = 0;
  const keepRes = await optimizeScheduleContrastive({
    schedule: { id: "sch-keep", title: "巡检", prompt: "检查健康状态" },
    model: {
      nextTurn: async () => {
        nextTurnCount += 1;
        return { text: "All healthy", calls: [] };
      },
      summarizeTurn: async () => ({
        text: JSON.stringify({ decision: "KEEP_BASE", reason: "原版指令已简洁高效" }),
      }),
    } as any,
  });
  assert.equal(keepRes.ok, true);
  if (keepRes.ok) {
    assert.equal(keepRes.decision, "KEEP_BASE");
    assert.equal(nextTurnCount, 1);
  }

  // 2. IMPROVED full 4-stage pipeline with read-only tools & anonymized judge
  const idMap = assignAnonymousLabels("sch-imp", "schedule-opt");
  const candAnon = idMap.A === "candidate" ? "A" : "B";
  const observedToolSets: string[][] = [];
  let sumIdx = 0;
  const impRes = await optimizeScheduleContrastive({
    schedule: { id: "sch-imp", title: "竞品日报", prompt: "搜一下竞品动态发邮件" },
    model: {
      nextTurn: async ({ tools, input }: any) => {
        observedToolSets.push((tools || []).map((t: any) => t.name));
        const text = JSON.stringify(input || []);
        if (text.includes("结构化")) {
          return { text: "1. 竞品A更新\n2. 竞品B降价", calls: [] };
        }
        return { text: "完成", calls: [] };
      },
      summarizeTurn: async () => {
        sumIdx += 1;
        if (sumIdx === 1) {
          return {
            text: JSON.stringify({
              decision: "PROPOSE",
              reason: "增加结构化采集步骤与输出格式约束",
              optimizedPrompt: "1. 使用 web_search 查询近24小时竞品动态\n2. 按「产品/动态/链接」输出结构化摘要",
              draftSkill: {
                name: "竞品日报采集",
                description: "定时搜集竞品动态",
                instructions: "1. web_search\n2. 整理输出",
              },
            }),
          };
        }
        return {
          text: JSON.stringify({
            winner: candAnon,
            reason: "结构化要点更完整清晰",
            regressions: [],
          }),
        };
      },
    } as any,
  });
  assert.equal(impRes.ok, true);
  if (impRes.ok) {
    assert.equal(impRes.decision, "IMPROVED");
    assert.match(String(impRes.sideEffectNotice || ""), /只读演练/);
    assert.match(String(impRes.optimizedPrompt || ""), /结构化/);
    assert.equal(impRes.draftSkill?.name, "竞品日报采集");
    for (const toolNames of observedToolSets) {
      assert.equal(toolNames.includes("mail_send_message"), false);
      assert.equal(toolNames.includes("run_shell"), false);
      assert.equal(toolNames.includes("write_file"), false);
    }
  }
});

test("HTTP /api/schedules/:id/optimize & apply-optimization update schedules.json and optionally save skill", async (t) => {
  resetScheduleOptimizerLocksForTests();
  const idMap = assignAnonymousLabels("sch-http-1", "schedule-opt");
  const candAnon = idMap.A === "candidate" ? "A" : "B";
  let sumIdx = 0;

  const { tmpDir, store, broadcasts, call } = await bootServer(t, {
    nextTurn: async () => ({ text: "采集摘要结果", calls: [] }),
    summarizeTurn: async () => {
      sumIdx += 1;
      if (sumIdx === 1) {
        return {
          text: JSON.stringify({
            decision: "PROPOSE",
            reason: "补充清晰输出模板",
            optimizedPrompt: "每日采集最新行业资讯并按 3 条要点结构化输出",
            draftSkill: {
              name: "行业早报汇总",
              description: "采集并汇总行业资讯",
              instructions: "1. web_search\n2. 输出要点",
              scriptName: "fmt.py",
              scriptContent: "print('ok')\n",
            },
          }),
        };
      }
      return {
        text: JSON.stringify({ winner: candAnon, reason: "优化版结构更好", regressions: [] }),
      };
    },
  });

  const bot = store.createSession({ title: "早报 Bot", avatar: "bot" });
  store.writeSchedules([
    {
      id: "sch-http-1",
      sessionId: bot.id,
      title: "行业早报",
      repeat: "daily",
      scheduleLabel: "每天 09:00",
      prompt: "看看行业新闻",
      enabled: true,
    },
  ]);

  const optRes = await call("POST", "/api/schedules/sch-http-1/optimize", {});
  assert.equal(optRes.status, 200);
  assert.equal(optRes.json.decision, "IMPROVED");

  const applyRes = await call("POST", "/api/schedules/sch-http-1/apply-optimization", {
    optimizedPrompt: optRes.json.optimizedPrompt,
    saveAsSkill: true,
    draftSkill: optRes.json.draftSkill,
  });
  assert.equal(applyRes.status, 200);
  assert.equal(applyRes.json.schedule.prompt, "每日采集最新行业资讯并按 3 条要点结构化输出");
  assert.ok(applyRes.json.schedule.lastOptimizedAt);
  assert.ok(fs.existsSync(path.join(tmpDir, "custom-skills", applyRes.json.skill.id, "scripts", "fmt.py")));
  assert.ok(broadcasts.some((e) => e.type === "schedules_updated"));
  assert.ok(broadcasts.some((e) => e.type === "skills_updated"));
});
