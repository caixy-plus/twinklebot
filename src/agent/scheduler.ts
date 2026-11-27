import {
  getNextCronDate,
  parseCronExpression,
  resolvePresetCronExpression,
} from "../shared/cron.js";

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
    cron = "",
    intervalDays,
  }: {
    repeat?: string;
    scheduleLabel?: string;
    time?: string;
    delayMinutes?: number;
    cron?: string;
    intervalDays?: number;
  } = {},
  fromDate = new Date()
): string {
  const delayNum = Number(delayMinutes);
  if (delayMinutes != null && Number.isFinite(delayNum) && delayNum > 0) {
    return new Date(fromDate.getTime() + delayNum * 60_000).toISOString();
  }

  const fixedDays = Number(intervalDays);
  if (repeat !== "once" && Number.isInteger(fixedDays) && fixedDays >= 2) {
    const hm = extractHourMinute(time) || extractHourMinute(scheduleLabel) || { hour: 10, minute: 0 };
    const target = new Date(fromDate.getTime());
    target.setHours(hm.hour, hm.minute, 0, 0);
    if (String(scheduleLabel || "").includes("明天") || target.getTime() <= fromDate.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }

  const rawCron = String(cron || "").trim();
  if ((repeat === "cron" || rawCron) && rawCron) {
    const parsed = parseCronExpression(rawCron);
    if (parsed.ok) {
      const next = getNextCronDate(parsed.normalized, fromDate);
      if (next) return next.toISOString();
    }
  }

  const rawTime = String(time || "").trim();
  if (rawTime && rawTime.includes("T")) {
    const parsed = Date.parse(rawTime);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  if (repeat !== "once" && !String(scheduleLabel || "").includes("明天")) {
    const presetCron = resolvePresetCronExpression(repeat, { scheduleLabel, time });
    if (presetCron) {
      const next = getNextCronDate(presetCron, fromDate);
      if (next) return next.toISOString();
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
  scheduleLabel = "",
  cron = "",
  opts: { intervalDays?: number; anchorAt?: string } = {}
): string | null {
  if (repeat === "once") return null;
  const fixedDays = Number(opts?.intervalDays);
  if (Number.isInteger(fixedDays) && fixedDays >= 2) {
    const anchorMs = opts?.anchorAt ? Date.parse(String(opts.anchorAt)) : NaN;
    const base = Number.isFinite(anchorMs) ? new Date(anchorMs) : new Date(fromDate.getTime());
    const hm = extractHourMinute(scheduleLabel);
    if (hm && !Number.isFinite(anchorMs)) {
      base.setHours(hm.hour, hm.minute, 0, 0);
    }
    const candidate = new Date(base.getTime());
    let guard = 0;
    while (candidate.getTime() <= fromDate.getTime() && guard < 2000) {
      candidate.setDate(candidate.getDate() + fixedDays);
      guard += 1;
    }
    if (candidate.getTime() <= fromDate.getTime()) {
      const fallback = new Date(fromDate.getTime());
      fallback.setDate(fallback.getDate() + fixedDays);
      return fallback.toISOString();
    }
    return candidate.toISOString();
  }
  const effectiveCron =
    String(cron || "").trim() ||
    resolvePresetCronExpression(repeat, { scheduleLabel }) ||
    "";
  if (effectiveCron) {
    const nextCron = getNextCronDate(effectiveCron, fromDate);
    if (nextCron) return nextCron.toISOString();
  }
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
    // Intentionally a no-op: do not auto-seed default inspection schedules.
  }

  function recordAsyncRunOutcome(
    scheduleId: string,
    res: { status?: string; text?: string; error?: string } | null | undefined
  ): void {
    try {
      const list = store.readSchedules();
      const target = list.find((s: any) => s && s.id === scheduleId);
      if (!target) return;
      const nowMs = Date.now();
      const status = String(res?.status || "done");
      if (status === "error") {
        target.lastRunStatus = "error";
        target.lastRunError = String(res?.error || res?.text || "Scheduled task failed");
        const prevRetries = Number(target.retryCount) || 0;
        if (prevRetries < 1 && target.enabled) {
          target.retryCount = prevRetries + 1;
          const retryIso = new Date(nowMs + 2 * 60_000).toISOString();
          const curNextMs = target.nextRunAt ? Date.parse(target.nextRunAt) : NaN;
          if (!Number.isFinite(curNextMs) || nowMs + 2 * 60_000 < curNextMs) {
            target.nextRunAt = retryIso;
          }
        }
      } else {
        target.lastRunStatus = status === "stopped" ? "stopped" : "done";
        target.retryCount = 0;
        delete target.lastRunError;
      }
      store.writeSchedules(list);
      broadcastGlobal?.({ type: "schedules_updated" });
    } catch {
      // ignore persistence errors in async completion hook
    }
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

      const onComplete = (res: { status?: string; text?: string; error?: string }) => {
        recordAsyncRunOutcome(item.id, res);
      };

      if (runner.isSessionBusy?.(item.sessionId)) {
        if (typeof runner.enqueue === "function") {
          try {
            runner.enqueue(
              item.sessionId,
              `[例行任务 · ${item.title}] ${item.prompt}`,
              undefined,
              { onComplete }
            );
            triggered.push(item.id);
            item.lastRunAt = new Date(now).toISOString();
            item.lastRunStatus = "queued_busy";
            delete item.lastRunError;
            delete item.deferredUntil;
            const nextIso = computeNextRun(
              item.repeat,
              new Date(now),
              item.scheduleLabel,
              item.cron,
              { intervalDays: item.intervalDays, anchorAt: item.anchorAt }
            );
            if (nextIso) {
              item.nextRunAt = nextIso;
            } else {
              item.enabled = false;
            }
            dirty = true;
          } catch (err: any) {
            item.lastRunStatus = "error";
            item.lastRunError = err?.message || String(err);
            dirty = true;
          }
        } else {
          const deferredUntilMs = item.deferredUntil ? Date.parse(item.deferredUntil) : NaN;
          if (!Number.isFinite(deferredUntilMs)) {
            item.deferredUntil = new Date(now + 5 * 60_000).toISOString();
            item.lastRunStatus = "deferred_busy";
            dirty = true;
          } else if (now > deferredUntilMs) {
            item.lastRunStatus = "skipped_busy_timeout";
            item.lastRunError = "Session remained busy past 5-minute deferral window";
            delete item.deferredUntil;
            const nextIso = computeNextRun(
              item.repeat,
              new Date(now),
              item.scheduleLabel,
              item.cron,
              { intervalDays: item.intervalDays, anchorAt: item.anchorAt }
            );
            if (nextIso) {
              item.nextRunAt = nextIso;
            } else {
              item.enabled = false;
            }
            dirty = true;
          }
        }
        continue;
      }

      try {
        runner.start(
          item.sessionId,
          `[例行任务 · ${item.title}] ${item.prompt}`,
          undefined,
          { onComplete }
        );
        triggered.push(item.id);
        item.lastRunAt = new Date(now).toISOString();
        item.lastRunStatus = "started";
        delete item.lastRunError;
        delete item.deferredUntil;
        const nextIso = computeNextRun(
          item.repeat,
          new Date(now),
          item.scheduleLabel,
          item.cron
        );
        if (nextIso) {
          item.nextRunAt = nextIso;
        } else {
          item.enabled = false;
        }
        dirty = true;
      } catch (err: any) {
        item.lastRunStatus = "error";
        item.lastRunError = err?.message || String(err);
        dirty = true;
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
