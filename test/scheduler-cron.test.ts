import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  CRON_PRESETS,
  describeCronExpression,
  getNextCronDate,
  getNextCronDates,
  isValidCronExpression,
  parseCronExpression,
} from "../src/shared/cron.js";
import { computeInitialNextRun, computeNextRun, createScheduler } from "../src/agent/scheduler.js";
import { runBotCollabTool } from "../src/agent/bot-tools.js";
import { createStore } from "../src/store/index.js";
import { createServer } from "../src/server/index.js";

test("parseCronExpression validates standard 5-field expressions, aliases, names, and rejects invalid inputs", () => {
  const validCases = [
    "0 10 */3 * *",
    "30 9 * * 1-5",
    "*/15 * * * *",
    "0 0 29 2 *",
    "0 8 1,15 JAN-JUN MON-FRI",
    "@daily",
    "@weekly",
    "@hourly",
    "0 9 * * 7",
    "0 9 * * 5-7",
  ];
  for (const expr of validCases) {
    const res = parseCronExpression(expr);
    assert.equal(res.ok, true, `Expected valid cron: ${expr}`);
    assert.equal(isValidCronExpression(expr), true);
  }

  const sunNormalized = parseCronExpression("0 9 * * 7");
  assert.equal(sunNormalized.ok, true);
  if (sunNormalized.ok) {
    assert.equal(sunNormalized.value.daysOfWeek[0], true);
  }
  const friSun = parseCronExpression("0 9 * * 5-7");
  assert.equal(friSun.ok, true);
  if (friSun.ok) {
    assert.equal(friSun.value.daysOfWeek[5], true);
    assert.equal(friSun.value.daysOfWeek[6], true);
    assert.equal(friSun.value.daysOfWeek[0], true);
  }

  const invalidCases = [
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "0 25 * * *",
    "0 0 32 * *",
    "0 0 * 13 *",
    "*/0 * * * *",
    "5-2 * * * *",
    "0 0 31 2 *",
    "not-a-cron",
  ];
  for (const expr of invalidCases) {
    const res = parseCronExpression(expr);
    assert.equal(res.ok, false, `Expected invalid cron: ${expr}`);
    assert.equal(isValidCronExpression(expr), false);
  }

  assert.ok(CRON_PRESETS.length >= 4);
  for (const p of CRON_PRESETS) {
    assert.equal(isValidCronExpression(p.expr), true);
  }
});

test("getNextCronDate & getNextCronDates handle multi-day step, weekdays, Vixie DOM+DOW OR, leap years, and same-minute skip", () => {
  // 1. Every 3 days at 10:00 local time (DOM 1,4,7,10,...)
  const baseMultiDay = new Date(2026, 2, 1, 9, 30, 0, 0); // 2026-03-01 09:30 local
  const dates3 = getNextCronDates("0 10 */3 * *", 3, baseMultiDay);
  assert.equal(dates3.length, 3);
  assert.equal(dates3[0].getDate(), 1);
  assert.equal(dates3[0].getHours(), 10);
  assert.equal(dates3[1].getDate(), 4);
  assert.equal(dates3[2].getDate(), 7);

  // Strictly after fromDate (at 10:00:05 it must NOT double-fire at 10:00 same day)
  const exactFire = new Date(2026, 2, 1, 10, 0, 5, 0);
  const nextAfterFire = getNextCronDate("0 10 */3 * *", exactFire);
  assert.ok(nextAfterFire);
  assert.equal(nextAfterFire.getDate(), 4);
  assert.equal(nextAfterFire.getHours(), 10);
  assert.equal(nextAfterFire.getMinutes(), 0);

  // 2. Weekdays 09:30 skips Saturday & Sunday (2026-03-06 is Friday)
  const fridayAfter = new Date(2026, 2, 6, 10, 0, 0, 0);
  const monday = getNextCronDate("30 9 * * 1-5", fridayAfter);
  assert.ok(monday);
  assert.equal(monday.getDay(), 1); // Monday
  assert.equal(monday.getDate(), 9);
  assert.equal(monday.getHours(), 9);
  assert.equal(monday.getMinutes(), 30);

  // 3. Vixie Cron DOM + DOW union (15th of month OR every Monday)
  const march14Sat = new Date(2026, 2, 14, 0, 0, 0, 0); // Saturday 2026-03-14
  const unionDates = getNextCronDates("0 9 15 * 1", 2, march14Sat);
  assert.equal(unionDates.length, 2);
  assert.equal(unionDates[0].getDate(), 15); // Sunday 15th (DOM match)
  assert.equal(unionDates[1].getDate(), 16); // Monday 16th (DOW match)

  // 4. Leap year Feb 29 (2026 -> 2028-02-29)
  const leapNext = getNextCronDate("0 0 29 2 *", new Date(2026, 0, 1, 0, 0, 0, 0));
  assert.ok(leapNext);
  assert.equal(leapNext.getFullYear(), 2028);
  assert.equal(leapNext.getMonth(), 1);
  assert.equal(leapNext.getDate(), 29);

  // 5. Descriptions
  assert.equal(describeCronExpression("0 10 */3 * *"), "每 3 天 10:00");
  assert.equal(describeCronExpression("*/30 * * * *"), "每 30 分钟");
  assert.equal(describeCronExpression("30 9 * * 1-5"), "每周一至周五 09:30");
  assert.equal(describeCronExpression("@daily"), "每天 00:00");
});

test("createScheduler.tick advances due cron jobs without disabling and scheduler helpers honor cron field", () => {
  const start = new Date(2026, 2, 1, 9, 0, 0, 0);
  const initNext = computeInitialNextRun(
    {
      repeat: "cron",
      cron: "0 10 */3 * *",
      scheduleLabel: "每 3 天 10:00",
    },
    start
  );
  assert.equal(new Date(initNext).getDate(), 1);
  assert.equal(new Date(initNext).getHours(), 10);

  const afterFirst = computeNextRun("cron", new Date(initNext), "每 3 天 10:00", "0 10 */3 * *");
  assert.ok(afterFirst);
  assert.equal(new Date(afterFirst).getDate(), 4);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cron-tick-"));
  try {
    const store = createStore(tmpDir);
    const adminBot = store.ensureAdminBot();
    const pastIso = new Date(Date.now() - 2000).toISOString();
    store.writeSchedules([
      {
        id: "sched-cron-1",
        sessionId: adminBot.id,
        title: "每3天检查",
        prompt: "检查订阅",
        repeat: "cron",
        cron: "0 10 */3 * *",
        scheduleLabel: "每 3 天 10:00",
        nextRunAt: pastIso,
        enabled: true,
      },
    ]);

    const startedCalls: string[] = [];
    const scheduler = createScheduler({
      store,
      runner: {
        isSessionBusy: () => false,
        start: (sid: string, msg: string) => {
          startedCalls.push(`${sid}:${msg}`);
        },
      },
    });
    const fired = scheduler.tick();
    assert.deepEqual(fired, ["sched-cron-1"]);
    assert.equal(startedCalls.length, 1);

    const saved = store.readSchedules()[0];
    assert.equal(saved.enabled, true, "cron schedule must stay enabled after firing");
    assert.ok(Date.parse(saved.nextRunAt) > Date.now(), "nextRunAt must advance into the future");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HTTP /api/schedules & schedule_manage tool support cron creation, validation, and PATCH recomputation", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cron-api-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = createStore(tmpDir);
  const adminBot = store.ensureAdminBot();
  const srv = createServer({
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      deployEnv: "local",
      models: ["gemini-4-hydrogen"],
      defaultModel: "gemini-4-hydrogen",
      writeRoots: [tmpDir],
      screen: { width: 1440, height: 900 },
    },
    store,
    executor: { health: async () => ({ ok: true }), call: async () => ({ ok: true }) } as any,
    runner: {
      isSessionBusy: () => false,
      start: () => {},
      subscribe: () => () => {},
      broadcastGlobal: () => {},
      mcpManager: { listConfigured: () => [] },
    } as any,
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => srv.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  // 1. Invalid cron rejected with 400 on POST
  const badPost = await fetch(`${baseUrl}/api/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: adminBot.id,
      title: "非法Cron",
      prompt: "do nothing",
      repeat: "cron",
      cron: "99 * * *",
    }),
  });
  assert.equal(badPost.status, 400);

  // 2. Valid cron created via POST & exposes normalized cron + auto-label
  const goodPost: any = await (
    await fetch(`${baseUrl}/api/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: adminBot.id,
        title: "JMS 每3天",
        prompt: "刷新节点",
        repeat: "cron",
        cron: "0 10 */3 * *",
      }),
    })
  ).json();
  assert.equal(goodPost.repeat, "cron");
  assert.equal(goodPost.cron, "0 10 */3 * *");
  assert.equal(goodPost.scheduleLabel, "每 3 天 10:00");
  assert.ok(Date.parse(goodPost.nextRunAt) > Date.now());

  // 3. Invalid cron rejected on PATCH
  const badPatch = await fetch(`${baseUrl}/api/schedules/${goodPost.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cron: "bad-expr" }),
  });
  assert.equal(badPatch.status, 400);

  // 4. PATCH updating cron recomputes nextRunAt cleanly; PATCH switching back to daily clears cron
  const prevNext = goodPost.nextRunAt;
  const patchCron: any = await (
    await fetch(`${baseUrl}/api/schedules/${goodPost.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "*/15 * * * *", scheduleLabel: "每 15 分钟" }),
    })
  ).json();
  assert.equal(patchCron.cron, "*/15 * * * *");
  assert.notEqual(patchCron.nextRunAt, prevNext);

  const patchDaily: any = await (
    await fetch(`${baseUrl}/api/schedules/${goodPost.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repeat: "daily", scheduleLabel: "每天 08:30" }),
    })
  ).json();
  assert.equal(patchDaily.repeat, "daily");
  assert.equal(patchDaily.cron, undefined);

  // 5. Bot tool schedule_manage supports create/update/list with cron & blocks bad cron
  const toolBad: any = await runBotCollabTool(
    "schedule_manage",
    { action: "create", title: "坏Cron", prompt: "test", repeat: "cron", cron: "60 0 * * *" },
    { store, senderSessionId: adminBot.id, senderBot: adminBot }
  );
  assert.equal(toolBad.ok, false);

  const toolCreate: any = await runBotCollabTool(
    "schedule_manage",
    {
      action: "create",
      title: "工作日早报",
      prompt: "发送早报",
      cron: "30 9 * * 1-5",
    },
    { store, senderSessionId: adminBot.id, senderBot: adminBot }
  );
  assert.equal(toolCreate.ok, true);
  assert.equal(toolCreate.schedule.repeat, "cron");
  assert.equal(toolCreate.schedule.cron, "30 9 * * 1-5");
  assert.equal(toolCreate.schedule.scheduleLabel, "每周一至周五 09:30");

  const toolUpdate: any = await runBotCollabTool(
    "schedule_manage",
    {
      action: "update",
      schedule: "工作日早报",
      cron: "0 10 */3 * *",
    },
    { store, senderSessionId: adminBot.id, senderBot: adminBot }
  );
  assert.equal(toolUpdate.ok, true);
  assert.equal(toolUpdate.schedule.cron, "0 10 */3 * *");
});
