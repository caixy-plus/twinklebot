import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export function extractHourMinute(text = ""): { hour: number; minute: number } | null {
  const m = String(text || "").match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function computeInitialNextRun(
  {
    repeat = "daily",
    scheduleLabel = "",
    time = "",
    delayMinutes,
  }: {
    repeat?: string;
    scheduleLabel?: string;
    time?: string;
    delayMinutes?: number;
  } = {},
  fromDate = new Date()
): string {
  const delayNum = Number(delayMinutes);
  if (delayMinutes != null && Number.isFinite(delayNum) && delayNum > 0) {
    return new Date(fromDate.getTime() + delayNum * 60_000).toISOString();
  }

  const rawTime = String(time || "").trim();
  if (rawTime && rawTime.includes("T")) {
    const parsed = Date.parse(rawTime);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  const hm = extractHourMinute(rawTime) || extractHourMinute(scheduleLabel);
  if (hm) {
    const target = new Date(fromDate.getTime());
    target.setHours(hm.hour, hm.minute, 0, 0);
    if (
      String(scheduleLabel || "").includes("明天") ||
      target.getTime() <= fromDate.getTime()
    ) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }

  if (repeat === "once") {
    return new Date(fromDate.getTime() + 60 * 1000).toISOString();
  }
  if (repeat === "hourly") {
    return new Date(fromDate.getTime() + 3600 * 1000).toISOString();
  }
  if (repeat === "weekly") {
    return new Date(fromDate.getTime() + 7 * 24 * 3600 * 1000).toISOString();
  }
  const tomorrow10am = new Date(fromDate.getTime());
  tomorrow10am.setDate(tomorrow10am.getDate() + 1);
  tomorrow10am.setHours(10, 0, 0, 0);
  return tomorrow10am.toISOString();
}

export function computeNextRun(
  repeat: string,
  fromDate = new Date(),
  scheduleLabel = ""
): string | null {
  const next = new Date(fromDate.getTime());
  const hm = extractHourMinute(scheduleLabel);
  if (repeat === "hourly") {
    next.setHours(next.getHours() + 1);
    return next.toISOString();
  }
  if (repeat === "daily") {
    next.setDate(next.getDate() + 1);
    if (hm) next.setHours(hm.hour, hm.minute, 0, 0);
    return next.toISOString();
  }
  if (repeat === "weekly") {
    next.setDate(next.getDate() + 7);
    if (hm) next.setHours(hm.hour, hm.minute, 0, 0);
    return next.toISOString();
  }
  return null;
}

export interface CreateSchedulerOptions {
  store?: any;
  runner?: any;
  broadcastGlobal?: (msg: Record<string, any>) => void;
  tickMs?: number;
}

/**
 * Lightweight per-Bot task scheduler (`即将进行` / 例行任务).
 * Persists schedules in `store.readSchedules()` / `store.writeSchedules()`.
 */
export function createScheduler({
  store,
  runner,
  broadcastGlobal,
  tickMs = 15000,
}: CreateSchedulerOptions = {}) {
  let timer: ReturnType<typeof setInterval> | null = null;

  function ensureDefaults(): void {
    if (!store?.readSchedules || !store?.writeSchedules) return;
    const existing = store.readSchedules();
    if (existing.length > 0) return;
    const sessions = store.listSessions?.() || [];
    const primaryId = sessions[0]?.id || null;
    if (!primaryId) return;

    const tomorrow10am = new Date();
    tomorrow10am.setDate(tomorrow10am.getDate() + 1);
    tomorrow10am.setHours(10, 0, 0, 0);

    const workspaceDir = path.join(os.homedir(), "TwinkleBot", "workspace");

    store.writeSchedules([
      {
        id: crypto.randomUUID(),
        sessionId: primaryId,
        title: "工作区状态与待办巡检",
        scheduleLabel: "每天 10:00",
        repeat: "daily",
        prompt: `请检查 ${workspaceDir} 目录的最新文件变动，并给我一份简短日报。`,
        nextRunAt: tomorrow10am.toISOString(),
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  function tick(): string[] {
    if (!store?.readSchedules || !runner) return [];
    const now = Date.now();
    const schedules = store.readSchedules();
    let dirty = false;
    const triggered: string[] = [];

    for (const item of schedules) {
      if (!item || !item.enabled || !item.nextRunAt || !item.sessionId) continue;
      const dueTime = Date.parse(item.nextRunAt);
      if (Number.isNaN(dueTime) || now < dueTime) continue;

      if (runner.isSessionBusy?.(item.sessionId)) {
        continue;
      }

      try {
        runner.start(item.sessionId, `[例行任务 · ${item.title}] ${item.prompt}`);
        triggered.push(item.id);
        item.lastRunAt = new Date(now).toISOString();
        const nextIso = computeNextRun(
          item.repeat,
          new Date(now),
          item.scheduleLabel
        );
        if (nextIso) {
          item.nextRunAt = nextIso;
        } else {
          item.enabled = false;
        }
        dirty = true;
      } catch {
        // session busy or missing; retry next tick
      }
    }

    if (dirty) {
      store.writeSchedules(schedules);
      broadcastGlobal?.({ type: "schedules_updated" });
    }
    return triggered;
  }

  function start(): void {
    ensureDefaults();
    if (timer) return;
    timer = setInterval(tick, tickMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    tick,
    ensureDefaults,
  };
}

export default { createScheduler };
