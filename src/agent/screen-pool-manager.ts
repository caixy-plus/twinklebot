import os from "node:os";
import {
  ABSOLUTE_MAX_CONCURRENT_SCREENS,
  ABSOLUTE_MIN_CONCURRENT_SCREENS,
  computeScreenPoolBudget,
  normalizeScreenPoolSettings,
} from "../shared/screen-pool.js";
import type { ScreenPoolBudget } from "../shared/entities.js";

export function getHostScreenPoolBudget({
  totalMemBytes = os.totalmem(),
  cpuCores = os.cpus()?.length || 4,
}: {
  totalMemBytes?: number;
  cpuCores?: number;
} = {}): ScreenPoolBudget {
  return computeScreenPoolBudget({ totalMemBytes, cpuCores });
}

export function resolveConfiguredMaxScreens(
  store?: { readSettings?: () => any } | null,
  budget: ScreenPoolBudget = getHostScreenPoolBudget(),
  env: Record<string, string | undefined> = process.env
): number {
  const envRaw = String(env.TWINKLEBOT_MAX_CONCURRENT_SCREENS || "").trim();
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= ABSOLUTE_MIN_CONCURRENT_SCREENS) {
      return Math.min(ABSOLUTE_MAX_CONCURRENT_SCREENS, Math.round(parsed));
    }
  }
  const rawSettings = store?.readSettings?.()?.screenPool;
  return normalizeScreenPoolSettings(rawSettings, budget).maxConcurrentScreens;
}

export interface ScreenQueueWaitInfo {
  position: number;
  limit: number;
  activeCount: number;
}

export interface ScreenQueueAcquiredInfo {
  waitedMs: number;
  limit: number;
}

export interface AcquireScreenLeaseOptions {
  signal?: AbortSignal;
  onQueueWait?: (info: ScreenQueueWaitInfo) => void;
  onQueueAcquired?: (info: ScreenQueueAcquiredInfo) => void;
}

export interface ScreenPoolStats {
  maxConcurrentScreens: number;
  activeCount: number;
  activeBotIds: string[];
  queuedCount: number;
  queuedBotIds: string[];
}

export interface ScreenLeasePool {
  acquire(botId: string, options?: AcquireScreenLeaseOptions): Promise<() => void>;
  reconcile(): void;
  getStats(): ScreenPoolStats;
}

interface WaitQueueEntry {
  botKey: string;
  enqueuedAt: number;
  lastReportedPosition: number;
  onQueueWait?: (info: ScreenQueueWaitInfo) => void;
  onQueueAcquired?: (info: ScreenQueueAcquiredInfo) => void;
  cleanupAbort: () => void;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

/**
 * Coordinates concurrent virtual screen leases across an unlimited number of Bots.
 *
 * - Up to `getMaxConcurrentScreens()` distinct Bots may hold active screen leases simultaneously.
 * - Re-entrant calls for a `botId` that already holds an active lease return immediately (ref-counted).
 * - When all slots are actively leased, additional Bots needing GUI/browser operations wait in
 *   strict FIFO order (abort-aware) and wake up automatically as active tasks finish or when the
 *   configured limit is raised.
 */
export function createScreenLeasePool({
  getMaxConcurrentScreens,
}: {
  getMaxConcurrentScreens: () => number;
}): ScreenLeasePool {
  const activeHolders = new Map<string, { refCount: number; acquiredAt: number }>();
  const waitQueue: WaitQueueEntry[] = [];

  function currentLimit(): number {
    const raw = Number(getMaxConcurrentScreens());
    if (!Number.isFinite(raw) || raw < ABSOLUTE_MIN_CONCURRENT_SCREENS) {
      return 2;
    }
    return Math.min(ABSOLUTE_MAX_CONCURRENT_SCREENS, Math.round(raw));
  }

  function notifyQueuePositions(): void {
    const limit = currentLimit();
    const activeCount = activeHolders.size;
    for (let i = 0; i < waitQueue.length; i++) {
      const pos = i + 1;
      const entry = waitQueue[i];
      if (entry.lastReportedPosition !== pos) {
        entry.lastReportedPosition = pos;
        try {
          entry.onQueueWait?.({ position: pos, limit, activeCount });
        } catch {
          // ignore observer error
        }
      }
    }
  }

  function makeReleaseFn(botKey: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const holder = activeHolders.get(botKey);
      if (!holder) return;
      holder.refCount -= 1;
      if (holder.refCount <= 0) {
        activeHolders.delete(botKey);
        pumpQueue();
      }
    };
  }

  function pumpQueue(): void {
    const limit = currentLimit();
    let dequeuedAny = false;
    while (activeHolders.size < limit && waitQueue.length > 0) {
      const next = waitQueue.shift()!;
      dequeuedAny = true;
      next.cleanupAbort();
      const existing = activeHolders.get(next.botKey);
      if (existing) {
        existing.refCount += 1;
      } else {
        activeHolders.set(next.botKey, { refCount: 1, acquiredAt: Date.now() });
      }
      const waitedMs = Math.max(0, Date.now() - next.enqueuedAt);
      try {
        next.onQueueAcquired?.({ waitedMs, limit });
      } catch {
        // ignore observer error
      }
      next.resolve(makeReleaseFn(next.botKey));
    }
    if (dequeuedAny && waitQueue.length > 0) {
      notifyQueuePositions();
    }
  }

  return {
    acquire(botId: string, options: AcquireScreenLeaseOptions = {}): Promise<() => void> {
      const botKey = String(botId || "").trim() || "__primary__";
      const { signal, onQueueWait, onQueueAcquired } = options;

      if (signal?.aborted) {
        return Promise.reject(
          signal.reason instanceof Error ? signal.reason : new Error("execution aborted")
        );
      }

      const existing = activeHolders.get(botKey);
      if (existing) {
        existing.refCount += 1;
        return Promise.resolve(makeReleaseFn(botKey));
      }

      const limit = currentLimit();
      if (activeHolders.size < limit && waitQueue.length === 0) {
        activeHolders.set(botKey, { refCount: 1, acquiredAt: Date.now() });
        return Promise.resolve(makeReleaseFn(botKey));
      }

      return new Promise<() => void>((resolve, reject) => {
        const entry: WaitQueueEntry = {
          botKey,
          enqueuedAt: Date.now(),
          lastReportedPosition: 0,
          onQueueWait,
          onQueueAcquired,
          cleanupAbort: () => {},
          resolve,
          reject,
        };

        if (signal) {
          const onAbort = () => {
            const idx = waitQueue.indexOf(entry);
            if (idx !== -1) {
              waitQueue.splice(idx, 1);
              notifyQueuePositions();
            }
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("execution aborted")
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
        }

        waitQueue.push(entry);
        notifyQueuePositions();
      });
    },

    reconcile(): void {
      pumpQueue();
      notifyQueuePositions();
    },

    getStats(): ScreenPoolStats {
      return {
        maxConcurrentScreens: currentLimit(),
        activeCount: activeHolders.size,
        activeBotIds: [...activeHolders.keys()],
        queuedCount: waitQueue.length,
        queuedBotIds: waitQueue.map((w) => w.botKey),
      };
    },
  };
}
