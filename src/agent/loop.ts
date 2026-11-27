import fs from "node:fs";
import path from "node:path";
import { TOOL_DECLARATIONS, runTool, hashScreenshot } from "./tools.js";
import { SCREEN_REQUIRED_TOOLS } from "../shared/screen-pool.js";
import {
  isBrowserAutomationTool,
  normalizeBrowserAutomationSettings,
  resolveEffectiveBrowserMode,
} from "../shared/browser-automation.js";
import { resolveEffectiveLocale } from "../shared/i18n.js";
import { getDefaultLocalChromeManager } from "../lib/local-chrome-cdp.js";
import {
  formatLocalTimestampWithOffset,
  formatMessageSourceHeader,
  formatMessageTimeHeader,
  redactSensitiveTokensInText,
  sanitizeChannelMeta,
  sanitizeClientTimeZone,
} from "../lib/channel-integrations.js";
import {
  HOST_TOOL_DECLARATIONS,
  isHostTool,
  runHostTool,
} from "./host-tools.js";
import { isMcpToolName } from "../lib/mcp-client.js";
import {
  CHAT_INLINE_IMAGE_EXTS,
  expandUserPath,
  inferFileMimeType,
  isSensitiveFilePath,
} from "../lib/file-attachments.js";
import {
  ensureBotWorkspaceDir,
  isPathInsideBotAccessibleRoots,
  resolveBaseWorkspaceRoot,
  resolveBotWorkspaceRoot,
  resolveBotWriteRoots,
  sanitizeBotWorkspaceId,
} from "../lib/bot-workspace.js";
import {
  BOT_COLLAB_TOOL_DECLARATIONS,
  isBotCollabTool,
  runBotCollabTool,
  filterToolDeclarationsForSkills,
  redactToolArgsForDisplay,
} from "./bot-tools.js";
import { assessToolCall } from "./policy.js";
import { buildSystemInstruction } from "./prompt.js";
import { userStep, toolResultSteps } from "./model.js";
import {
  DEFAULT_KEEP_SCREENSHOTS,
  compressContextHistory,
  estimateEffectiveHistoryTokens,
  estimateHistoryChars,
  estimateStepTokens,
  estimateTextTokens,
  isContextOverflowError,
  isRealUserTurnStep,
  pruneScreenshots,
  pruneScreenshotsOlderThanTurns,
  sanitizeOrphanedCalls,
  trimHistoryToTokenBudget,
} from "./context.js";
import {
  getEffectiveCompressionWindow,
  getModelContextWindow,
  normalizeContextCompressionSettings,
} from "../shared/context-compression.js";
import {
  selectRoute,
  buildSmartRoute,
  hasDesktopIntent,
  hasMacHostGuiIntent,
  resolveTierModels,
  resolveUtilityModels,
} from "./router.js";
import { isSimpleFollowUp, isTrivialChat, planRoute } from "./route-planner.js";
import {
  createRouteRuntime,
  beginStep,
  recordToolOutcome,
  requestEscalation,
  decideEscalation,
  commitStepTier,
  formatTierPath,
  ROUTE_ESCALATE_TOOL_DECLARATION,
} from "./route-signals.js";
import {
  MODE_PRESETS,
  normalizeRoutingSettings,
  createTurnBudget,
  tierFromPlan,
  resolveStepFromPlan,
  tierRank,
  getCategoryBias,
  recordRouteOutcome,
} from "./route-stats.js";
import { normalizeMailAuthStore } from "../lib/mail-client.js";
import { OFFICE_SKILLS, resolveInstalledSkillIds } from "../shared/skills-catalog.js";
import {
  fallbackThinkingSummary,
  summarizeThinkingProgress,
} from "./thinking-summarizer.js";
import { runPostTurnMemoryExtraction } from "./memory-extractor.js";
import { USD_TO_CNY } from "./pricing.js";

const MAX_SESSION_TOKEN_SCALES = 256;
const sessionTokenScaleMap = new Map<string, number>();

function getSessionTokenScale(sessionId: string, store?: any): number {
  const cached = sessionTokenScaleMap.get(sessionId);
  if (cached !== undefined) return cached;
  try {
    const persisted = Number(store?.getSession?.(sessionId)?.tokenScale);
    if (Number.isFinite(persisted) && persisted > 1) {
      const clamped = Math.min(2.5, Math.max(1, persisted));
      sessionTokenScaleMap.set(sessionId, clamped);
      return clamped;
    }
  } catch {
    // ignore store lookup failures
  }
  return 1;
}

function updateSessionTokenScale(
  sessionId: string,
  rawEstimatedInput: number,
  actualInputTokens: unknown,
  store?: any,
  skipPersist = false
): void {
  const actual = Number(actualInputTokens);
  if (!sessionId || !Number.isFinite(actual) || actual <= 0 || rawEstimatedInput <= 0) {
    return;
  }
  // Ignore tiny synthetic test fixtures (< 50% of local estimate) so mocked usage does not skew budgets
  if (actual < rawEstimatedInput * 0.5) {
    return;
  }
  const prevScale = getSessionTokenScale(sessionId, store);
  const nextScale = Math.min(2.5, Math.max(1, actual / rawEstimatedInput));
  if (
    !sessionTokenScaleMap.has(sessionId) &&
    sessionTokenScaleMap.size >= MAX_SESSION_TOKEN_SCALES
  ) {
    const oldestKey = sessionTokenScaleMap.keys().next().value;
    if (oldestKey !== undefined) sessionTokenScaleMap.delete(oldestKey);
  }
  sessionTokenScaleMap.set(sessionId, nextScale);
  if (
    !skipPersist &&
    store?.updateSession &&
    Math.abs(nextScale - prevScale) >= 0.05
  ) {
    try {
      store.updateSession(sessionId, {
        tokenScale: Number(nextScale.toFixed(3)),
        touch: false,
      });
    } catch {
      // ignore missing/transient session persist error
    }
  }
}

function isPathInsideWriteRoots(targetPath: string, writeRoots: string[] = []): boolean {
  if (!Array.isArray(writeRoots) || writeRoots.length === 0) return true;
  const resolved = path.resolve(targetPath);
  return writeRoots.some((root) => {
    if (!root) return false;
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

function loadVisualAttachmentImages(
  attachments: any,
  writeRoots: string[] = [],
  {
    sessionId = "",
    config = null,
  }: { sessionId?: string; config?: Record<string, any> | null } = {}
): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;
    const rawPath = typeof att.path === "string" ? att.path.trim() : "";
    if (!rawPath) continue;
    const resolved = expandUserPath(rawPath);
    if (!resolved || isSensitiveFilePath(resolved)) continue;
    if (Array.isArray(writeRoots) && writeRoots.length > 0) {
      if (sessionId) {
        if (!isPathInsideBotAccessibleRoots(resolved, { config, writeRoots, sessionId })) {
          continue;
        }
      } else if (!isPathInsideWriteRoots(resolved, writeRoots)) {
        continue;
      }
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!CHAT_INLINE_IMAGE_EXTS.has(ext)) continue;
    try {
      if (!fs.existsSync(resolved)) continue;
      const st = fs.statSync(resolved);
      if (!st.isFile() || st.size <= 0 || st.size > 10 * 1024 * 1024) continue;
      const buf = fs.readFileSync(resolved);
      images.push({
        data: buf.toString("base64"),
        mimeType: inferFileMimeType(ext),
      });
      if (images.length >= 6) break;
    } catch {
      // ignore unreadable attachment
    }
  }
  return images;
}

export function truncateForDisplay(val: any, maxLen = 2000): any {
  if (typeof val === "string") {
    const clean = redactSensitiveTokensInText(val);
    return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
  }
  if (Array.isArray(val)) {
    return val.map((item) => truncateForDisplay(item, maxLen));
  }
  if (val !== null && typeof val === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = truncateForDisplay(v, maxLen);
    }
    return out;
  }
  return val;
}

export function createControl() {
  let _stopped = false;
  let _paused = false;
  const abortController = new AbortController();
  const pauseWaiters = new Set<(reason: string) => void>();
  const pendingApprovals = new Map<string, (allowed: boolean) => void>();
  const resolvedApprovals = new Map<string, boolean>();
  const supersededApprovals = new Set<string>();
  const pendingChoices = new Map<string, (selection: any) => void>();
  const resolvedChoices = new Map<string, any>();
  const steeredMessages: Array<{ text: string; userMeta: any }> = [];
  let activeStepAbort: AbortController | null = null;

  return {
    get stopped() {
      return _stopped;
    },
    get paused() {
      return _paused;
    },
    isPaused() {
      return _paused;
    },
    get signal() {
      return abortController.signal;
    },
    stop() {
      _stopped = true;
      steeredMessages.length = 0;
      if (activeStepAbort && !activeStepAbort.signal.aborted) {
        try {
          activeStepAbort.abort(new Error("stopped"));
        } catch {
          // ignore
        }
      }
      activeStepAbort = null;
      try {
        abortController.abort(new Error("stopped"));
      } catch {
        // ignore
      }
      for (const resolve of pauseWaiters) {
        resolve("stopped");
      }
      pauseWaiters.clear();
      for (const [, resolve] of pendingApprovals) {
        resolve(false);
      }
      pendingApprovals.clear();
      resolvedApprovals.clear();
      supersededApprovals.clear();
      for (const [, resolve] of pendingChoices) {
        resolve(null);
      }
      pendingChoices.clear();
      resolvedChoices.clear();
    },
    pause() {
      if (!_stopped) {
        _paused = true;
      }
    },
    resume() {
      if (_paused) {
        _paused = false;
        for (const resolve of pauseWaiters) {
          resolve("resumed");
        }
        pauseWaiters.clear();
      }
    },
    /**
     * Injects a new follow-up user message into an active run immediately:
     * aborts any in-flight thinking request and wakes up paused/approval/choice gates
     * without losing prior conversation context or completed tool results.
     */
    steer(message: string | { text?: string; userMeta?: any }) {
      if (_stopped) return false;
      const entry =
        typeof message === "string"
          ? { text: message, userMeta: null }
          : {
              text: String(message?.text ?? ""),
              userMeta: message?.userMeta ?? null,
            };
      if (!entry.text && !entry.userMeta?.attachments?.length) {
        return false;
      }
      steeredMessages.push(entry);
      if (_paused) {
        _paused = false;
        for (const resolve of pauseWaiters) {
          resolve("steered");
        }
        pauseWaiters.clear();
      }
      for (const [callId, resolve] of [...pendingApprovals.entries()]) {
        pendingApprovals.delete(callId);
        supersededApprovals.add(callId);
        resolve(false);
      }
      for (const [callId, resolve] of [...pendingChoices.entries()]) {
        pendingChoices.delete(callId);
        resolve(null);
      }
      if (activeStepAbort && !activeStepAbort.signal.aborted) {
        try {
          activeStepAbort.abort(
            Object.assign(new Error("steered"), { name: "SteerAbortError", code: "STEERED" })
          );
        } catch {
          // ignore
        }
      }
      return true;
    },
    hasSteeredMessages() {
      return steeredMessages.length > 0;
    },
    consumeSteeredMessages() {
      if (steeredMessages.length === 0) return [];
      return steeredMessages.splice(0, steeredMessages.length);
    },
    setStepAbort(abortCtrl: AbortController | null) {
      activeStepAbort = abortCtrl || null;
    },
    wasApprovalSuperseded(callId: string) {
      if (!supersededApprovals.has(callId)) return false;
      supersededApprovals.delete(callId);
      return true;
    },
    async waitIfPaused(): Promise<string> {
      if (_stopped) return "stopped";
      if (!_paused) return "not_paused";
      return new Promise((resolve) => {
        pauseWaiters.add(resolve);
      });
    },
    async requestApproval(callId: string): Promise<boolean> {
      if (_stopped) return false;
      if (resolvedApprovals.has(callId)) {
        const val = resolvedApprovals.get(callId)!;
        resolvedApprovals.delete(callId);
        return val;
      }
      return new Promise((resolve) => {
        pendingApprovals.set(callId, resolve);
      });
    },
    resolveApproval(callId: string, allowed: boolean) {
      if (pendingApprovals.has(callId)) {
        const resolve = pendingApprovals.get(callId)!;
        pendingApprovals.delete(callId);
        resolve(Boolean(allowed));
      } else {
        resolvedApprovals.set(callId, Boolean(allowed));
      }
    },
    hasPendingApproval(callId: string) {
      return pendingApprovals.has(callId);
    },
    async requestChoice(callId: string): Promise<any> {
      if (_stopped) return null;
      if (resolvedChoices.has(callId)) {
        const val = resolvedChoices.get(callId);
        resolvedChoices.delete(callId);
        return val;
      }
      return new Promise((resolve) => {
        pendingChoices.set(callId, resolve);
      });
    },
    resolveChoice(callId: string, selection: any) {
      if (pendingChoices.has(callId)) {
        const resolve = pendingChoices.get(callId)!;
        pendingChoices.delete(callId);
        resolve(selection);
      } else {
        resolvedChoices.set(callId, selection);
      }
    },
    hasPendingChoice(callId: string) {
      return pendingChoices.has(callId);
    },
  };
}

async function withOptionalMutex<T>(
  mutex: { runExclusive<U>(fn: () => Promise<U> | U): Promise<U> } | null | undefined,
  shouldLock: boolean,
  fn: () => Promise<T> | T
): Promise<T> {
  if (!mutex || !shouldLock) {
    return fn();
  }
  return mutex.runExclusive(fn);
}

/**
 * Formats an on-demand completion header for the *previous* turn to inject into the
 * next `user` prompt ONLY when the prior turn took >= 60s or paused/awaited approval.
 */
export function formatPreviousTurnCompletionHeader(
  prevTurn?: {
    lastTurnCompletedAt?: string;
    lastTurnDurationMs?: number;
    lastTurnHadPauseOrApproval?: boolean;
  } | null,
  clientTimeZone?: string
): string {
  if (!prevTurn || !prevTurn.lastTurnCompletedAt) return "";
  const completedMs = Date.parse(String(prevTurn.lastTurnCompletedAt));
  if (!Number.isFinite(completedMs)) return "";
  const durMs = Math.max(0, Number(prevTurn.lastTurnDurationMs) || 0);
  const hadPause = Boolean(prevTurn.lastTurnHadPauseOrApproval);
  if (durMs < 60_000 && !hadPause) return "";
  const totalSec = Math.max(1, Math.round(durMs / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const durLabel =
    hours > 0
      ? `${hours}h${mins}m${secs}s`
      : mins > 0
        ? `${mins}m${secs}s`
        : `${secs}s`;
  const formattedTs = formatLocalTimestampWithOffset(completedMs, clientTimeZone);
  return `[上轮回复完成：${formattedTs}，耗时 ${durLabel}]`;
}

/**
 * Builds a concise human-readable summary of an approval target (button label/URL,
 * shell command, file path, or mail recipient) so ApprovalCards never show bare refs alone.
 */
export function buildApprovalContextSummary(
  toolName: string,
  args: Record<string, any> = {},
  ctx: { browserElements?: Map<string, string>; browserUrl?: string } = {}
): string {
  const safeArgs = args && typeof args === "object" ? args : {};
  if (
    toolName === "browser_click" ||
    toolName === "browser_type" ||
    toolName === "browser_select" ||
    toolName === "browser_upload_file"
  ) {
    const ref = String(safeArgs.ref || "").trim();
    const label = ref && ctx.browserElements ? ctx.browserElements.get(ref) : "";
    let hostHint = "";
    if (ctx.browserUrl) {
      try {
        const u = new URL(ctx.browserUrl);
        hostHint = u.host || ctx.browserUrl.slice(0, 60);
      } catch {
        hostHint = String(ctx.browserUrl).slice(0, 60);
      }
    }
    const pagePart = hostHint ? ` · 页面：${hostHint}` : "";
    if (label && ref) return `元素：「${label}」(${ref})${pagePart}`;
    if (ref && hostHint) return `元素 ${ref}${pagePart}`;
    if (hostHint) return `页面：${hostHint}`;
    return "";
  }
  if (toolName === "host_run_shell" || toolName === "run_shell") {
    const cmd = String(safeArgs.command || "").replace(/\s+/g, " ").trim().slice(0, 140);
    return cmd ? `命令：${cmd}` : "";
  }
  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "host_write_file" ||
    toolName === "host_edit_file"
  ) {
    const p = String(safeArgs.path || "").trim();
    return p ? `文件：${p}` : "";
  }
  if (toolName === "mail_send_message") {
    const to = String(safeArgs.to || "").trim();
    const subj = String(safeArgs.subject || "").trim().slice(0, 60);
    if (to || subj) return `收件人：${to || "未指定"}${subj ? ` · 主题：${subj}` : ""}`;
  }
  return "";
}

/**
 * Public entry point: runs a turn and records Smart Router v2 outcome stats (L4) on every exit path.
 */
export async function runTask(opts: Record<string, any> = {}): Promise<{ status: string; text: string }> {
  const routeTrace: Record<string, any> = { active: false };
  let result: { status: string; text: string } | undefined;
  try {
    result = await runTaskInner({ ...opts, routeTrace });
    return result;
  } finally {
    if (routeTrace.active) {
      recordRouteOutcome(opts?.deps?.store, {
        sessionId: opts.sessionId || "default",
        botId: routeTrace.botId,
        category: routeTrace.plan?.category || "other",
        complexity: routeTrace.plan?.complexity,
        planSource: routeTrace.planSource,
        mode: routeTrace.mode,
        baseTier: routeTrace.initialBaseTier,
        tierPath: routeTrace.runtime?.tierPath || [],
        tierPathLabel: formatTierPath(routeTrace.runtime?.tierPath || [], {
          modelPath: routeTrace.runtime?.modelPath,
        }),
        steps: routeTrace.runtime?.tierPath?.length || 0,
        errors: routeTrace.runtime?.errorsTotal || 0,
        softFailures: routeTrace.runtime?.softFailuresTotal || 0,
        escalations:
          (routeTrace.runtime?.escalationEvents?.length || 0) +
          (routeTrace.runtime?.autoEscalations || 0),
        deepSteps: routeTrace.runtime?.deepStepsUsed || 0,
        costUsd: Math.round((routeTrace.budget?.spentUsd || 0) * 1e6) / 1e6,
        status: result?.status || "error",
      });
    }
  }
}

function buildRecentRouteContext(store: any, sessionId: string): string {
  try {
    const evs = store?.readEvents?.(sessionId) || [];
    const picked = evs
      .filter((e: any) => e && (e.type === "user" || e.type === "answer"))
      .slice(-5, -1); // exclude the user message just emitted for this turn
    return picked
      .map(
        (e: any) =>
          `${e.type === "user" ? "User" : "Bot"}: ${String(e.text || "").replace(/\s+/g, " ").slice(0, 200)}`
      )
      .join("\n");
  } catch {
    return "";
  }
}

async function runTaskInner({
  routeTrace = { active: false },
  sessionId = "default",
  userText = "",
  userMeta = null,
  promptText,
  modelName,
  deps = {},
  control,
}: Record<string, any> = {}): Promise<{ status: string; text: string }> {
  const ctrl = control ?? createControl();
  const {
    model,
    executor,
    mcpManager = null,
    hostBridge = null,
    getChannelStatus = null,
    channelPairingActions = null,
    channelConfigActions = null,
    getRelayStatus = null,
    accountActions = null,
    selfUpdateActions = null,
    store,
    config = {},
    emit = () => {},
    autoRoute = false,
    smartRouter = false,
    enableBotTools = false,
    desktopMutex = null,
    acquireScreenLease = null,
    speakerBot = null,
    groupMeta = null,
    replyToAnchor = null,
    skipUserEvent = false,
    skipHistorySave = false,
    hopDepth = 0,
    isBotHandoff = false,
    broadcastGlobal,
    onDispatchBotTurn,
    onDispatchGroupTurn,
  } = deps;

  const speakerTag = speakerBot
    ? {
        botId: speakerBot.id,
        botName: speakerBot.title || "Bot",
        botAvatar: speakerBot.avatar || null,
      }
    : {};

  function emitTagged(ev: Record<string, any>): void {
    emit({ ...speakerTag, ...ev });
  }

  function setStatus(status: string): void {
    emitTagged({ type: "status", status });
    try {
      if (store?.getSession && store.getSession(sessionId)) {
        store.updateSession(sessionId, { status });
      }
    } catch {
      // ignore
    }
  }

  const turnStartedAtMs = Date.now();
  let turnHadPauseOrApproval = false;
  const prevTurnSnapshot =
    !speakerBot && !promptText && store?.getSession ? store.getSession(sessionId) || null : null;

  const validClientTimeZone = sanitizeClientTimeZone(userMeta?.clientTimeZone);
  const parsedSentAt = userMeta?.sentAt ? Date.parse(String(userMeta.sentAt)) : NaN;
  const resolvedSentAt = Number.isFinite(parsedSentAt)
    ? new Date(parsedSentAt).toISOString()
    : !promptText
      ? new Date().toISOString()
      : undefined;

  let emittedUserSeq: number | null = null;
  if (!skipUserEvent) {
    const cleanMeta: Record<string, any> = {};
    if (userMeta?.replyTo && typeof userMeta.replyTo === "object") {
      cleanMeta.replyTo = {
        seq: userMeta.replyTo.seq,
        author: String(userMeta.replyTo.author || ""),
        ...(userMeta.replyTo.botId ? { botId: String(userMeta.replyTo.botId) } : {}),
        snippet: String(userMeta.replyTo.snippet || "").slice(0, 140),
      };
    }
    if (Array.isArray(userMeta?.quotes) && userMeta.quotes.length > 0) {
      cleanMeta.quotes = userMeta.quotes
        .map((q: unknown) => String(q || "").trim())
        .filter(Boolean)
        .slice(0, 6);
    }
    if (Array.isArray(userMeta?.attachments) && userMeta.attachments.length > 0) {
      cleanMeta.attachments = userMeta.attachments.slice(0, 10);
    }
    if (
      userMeta?.clientSource &&
      typeof userMeta.clientSource === "object" &&
      (userMeta.clientSource.deviceKind === "mobile" ||
        userMeta.clientSource.deviceKind === "desktop")
    ) {
      cleanMeta.clientSource = {
        deviceKind: userMeta.clientSource.deviceKind,
        ...(userMeta.clientSource.platform
          ? { platform: String(userMeta.clientSource.platform).slice(0, 32) }
          : {}),
        ...(typeof userMeta.clientSource.viaRelay === "boolean"
          ? { viaRelay: userMeta.clientSource.viaRelay }
          : {}),
      };
    }
    const cleanChannelMeta = sanitizeChannelMeta(userMeta?.channelMeta);
    if (cleanChannelMeta) {
      cleanMeta.channelMeta = cleanChannelMeta;
    }
    if (validClientTimeZone) {
      cleanMeta.clientTimeZone = validClientTimeZone;
    }
    if (resolvedSentAt) {
      cleanMeta.sentAt = resolvedSentAt;
    }
    emit({ type: "user", text: userText, ...cleanMeta });
    try {
      const evs = store?.readEvents?.(sessionId);
      if (Array.isArray(evs) && evs.length > 0) {
        const lastUser = [...evs].reverse().find((e) => e.type === "user");
        if (lastUser?.seq) emittedUserSeq = lastUser.seq;
      }
    } catch {
      // ignore
    }
  }
  setStatus("running");
  emitTagged({
    type: "thinking_summary",
    text: "正在分析当前需求",
    source: "initial",
  });

  let latestUserText = userText;
  let memoryManagedInTurn = false;
  let runEnded = false;
  let hasModelSummary = false;
  let activeSummaryCtrl: AbortController | null = null;
  let releaseTaskScreenLease: (() => void) | null = null;
  let inflightScreenLeasePromise: Promise<void> | null = null;

  const ensureTaskScreenLease = async (signal?: AbortSignal): Promise<void> => {
    if (releaseTaskScreenLease || typeof acquireScreenLease !== "function") {
      return;
    }
    if (inflightScreenLeasePromise) {
      return inflightScreenLeasePromise;
    }
    const effectiveSignal = signal || ctrl.signal;
    inflightScreenLeasePromise = (async () => {
      let didQueue = false;
      const release = await acquireScreenLease({
        signal: effectiveSignal,
        onQueueWait: ({ position, limit, activeCount }: any) => {
          didQueue = true;
          setStatus("waiting_screen");
          emitTagged({
            type: "screen_queue",
            status: "waiting",
            position,
            limit,
            activeCount,
          });
          emitTagged({
            type: "thinking_summary",
            text: `等待空闲屏幕（排第${position}位）`,
            source: "screen_queue",
          });
        },
        onQueueAcquired: ({ waitedMs, limit }: any) => {
          if (didQueue && !ctrl.stopped) {
            setStatus("running");
            emitTagged({
              type: "screen_queue",
              status: "acquired",
              waitedMs,
              limit,
            });
          }
        },
      });
      if (runEnded || ctrl.stopped) {
        release();
        throw new Error("execution aborted");
      }
      releaseTaskScreenLease = release;
    })().finally(() => {
      inflightScreenLeasePromise = null;
    });
    return inflightScreenLeasePromise;
  };
  let smart: Record<string, any> | null = null;
  let consecutiveErrors = 0;
  let lastSummaryDomain = "";
  let lastModelSummaryStep = 0;
  let lastModelSummaryAt = 0;
  const classifySummaryDomain = (calls: any[] = []): string => {
    const first = String(calls?.[0]?.name || "");
    if (!first) return "init";
    if (first === "run_shell" || first === "host_run_shell") return "shell";
    if (first.includes("read_file") || first.includes("write_file") || first.includes("edit_file")) return "file";
    if (first === "open_url" || first.startsWith("browser_")) return "browser";
    if (first === "web_search" || first === "web_fetch") return "web";
    if (first.startsWith("mail_")) return "mail";
    return first;
  };
  const scheduleThinkingSummary = ({
    thoughts = [],
    calls = [],
    stepNo = 1,
  }: {
    thoughts?: string[];
    calls?: any[];
    stepNo?: number;
  }) => {
    if (ctrl.stopped || runEnded) return;
    const summaryDomain = classifySummaryDomain(calls);
    const isDomainChanged = Boolean(lastSummaryDomain && summaryDomain !== lastSummaryDomain);
    const hasNewError = consecutiveErrors > 0;
    const elapsedSinceLast = lastModelSummaryAt > 0 ? Date.now() - lastModelSummaryAt : Infinity;
    const reachedCadence = stepNo - lastModelSummaryStep >= 3 || elapsedSinceLast >= 12_000;
    if (
      stepNo > 1 &&
      Array.isArray(calls) &&
      calls.length > 0 &&
      !isDomainChanged &&
      !hasNewError &&
      !reachedCadence
    ) {
      lastSummaryDomain = summaryDomain;
      const initialSettings = store?.readSettings?.() || {};
      const initialRouting = normalizeRoutingSettings(initialSettings?.routing);
      const { fastModel: utilityFastModel, fallbackModel: utilityDefaultModel } = resolveUtilityModels(
        config,
        Date.now(),
        initialRouting
      );
      emitTagged({
        type: "thinking_summary",
        text: fallbackThinkingSummary(calls, stepNo),
        model: utilityFastModel || utilityDefaultModel,
        source: "fallback",
      });
      return;
    }
    if (activeSummaryCtrl) {
      try {
        activeSummaryCtrl.abort();
      } catch {
        // ignore
      }
    }
    const summaryCtrl = new AbortController();
    activeSummaryCtrl = summaryCtrl;
    const combinedSignal =
      typeof AbortSignal?.any === "function"
        ? AbortSignal.any([ctrl.signal, summaryCtrl.signal])
        : summaryCtrl.signal;

    const initialSettings = store?.readSettings?.() || {};
    const initialRouting = normalizeRoutingSettings(initialSettings?.routing);
    const { fastModel: utilityFastModel, fallbackModel: utilityDefaultModel } = resolveUtilityModels(
      config,
      Date.now(),
      initialRouting
    );

    summarizeThinkingProgress({
      model,
      userText: latestUserText,
      thoughts,
      calls,
      stepNo,
      config: { ...config, routing: initialRouting },
      signal: combinedSignal,
    })
      .then((res) => {
        if (
          runEnded ||
          ctrl.stopped ||
          summaryCtrl.signal.aborted ||
          activeSummaryCtrl !== summaryCtrl
        ) {
          return;
        }
        if (res?.source === "model") {
          hasModelSummary = true;
          lastModelSummaryStep = stepNo;
          lastModelSummaryAt = Date.now();
          lastSummaryDomain = summaryDomain;
        } else if (hasModelSummary) {
          return;
        }
        if (res?.usage && res?.usedModel) {
          smart?.budget?.add?.(res.usedModel, res.usage);
          emitTagged({
            type: "usage",
            model: res.usedModel,
            ...(res.usedProviderId ? { providerId: res.usedProviderId } : {}),
            routeTier: "summary",
            routeLabel: "进度提炼",
            input: res.usage.input ?? 0,
            output: res.usage.output ?? 0,
            ...(res.usage.cached ? { cached: res.usage.cached } : {}),
            ...(res.usage.thoughts ? { thoughts: res.usage.thoughts } : {}),
          });
        }
        if (res?.text) {
          emitTagged({
            type: "thinking_summary",
            text: res.text,
            model: res.usedModel || utilityFastModel || utilityDefaultModel,
            source: res.source,
          });
        }
      })
      .catch(() => {});
  };

  if (String(userText || "").trim() && !isTrivialChat(userText, { hasAttachments: false })) {
    scheduleThinkingSummary({ thoughts: [], calls: [], stepNo: 1 });
  }

  try {
    const hasConfiguredWriteRoots =
      Array.isArray(config?.writeRoots) && config.writeRoots.length > 0;
    const fallbackWorkspaceBase =
      !hasConfiguredWriteRoots && store?.dataDir
        ? path.join(store.dataDir, "workspaces")
        : "";
    const rawConfiguredWriteRoots: string[] = hasConfiguredWriteRoots
      ? config.writeRoots
      : fallbackWorkspaceBase
        ? [fallbackWorkspaceBase]
        : [];
    const botWorkspaceSessionId = sanitizeBotWorkspaceId(sessionId);
    const baseWorkspaceRoot = rawConfiguredWriteRoots[0]
      ? resolveBaseWorkspaceRoot({ config, writeRoots: rawConfiguredWriteRoots })
      : "";
    const botWorkspaceRoot = rawConfiguredWriteRoots[0]
      ? resolveBotWorkspaceRoot({
          config,
          writeRoots: rawConfiguredWriteRoots,
          sessionId: botWorkspaceSessionId,
        })
      : "";
    const botWriteRoots =
      rawConfiguredWriteRoots.length > 0
        ? resolveBotWriteRoots({
            config,
            writeRoots: rawConfiguredWriteRoots,
            sessionId: botWorkspaceSessionId,
          })
        : [];
    const scopedRuntimeConfig: Record<string, any> = {
      ...config,
      ...(botWriteRoots.length > 0 ? { writeRoots: botWriteRoots } : {}),
      ...(baseWorkspaceRoot ? { baseWorkspaceRoot } : {}),
      ...(botWorkspaceRoot ? { botWorkspaceRoot } : {}),
      ...(botWorkspaceSessionId ? { botWorkspaceSessionId } : {}),
    };

    function formatContextualUserText(
      rawText: string,
      meta: any,
      includeAttachments = false,
      prevTurnHeader = ""
    ): string {
      let out = String(rawText || "");
      const effectiveMeta = meta && typeof meta === "object" ? meta : {};
      const prefixParts: string[] = [];
      const sourceHeader = formatMessageSourceHeader(effectiveMeta);
      if (sourceHeader) {
        prefixParts.push(sourceHeader);
      }
      const timeHeader = formatMessageTimeHeader(effectiveMeta);
      if (timeHeader) {
        prefixParts.push(timeHeader);
      }
      if (prevTurnHeader) {
        prefixParts.push(prevTurnHeader);
      }
      if (effectiveMeta.replyTo?.snippet) {
        prefixParts.push(
          `[Replying to (${effectiveMeta.replyTo.author || "message"}): "${effectiveMeta.replyTo.snippet}"]`
        );
      }
      if (Array.isArray(effectiveMeta.quotes) && effectiveMeta.quotes.length > 0) {
        prefixParts.push(effectiveMeta.quotes.map((q: unknown) => `> ${q}`).join("\n"));
      }
      if (
        includeAttachments &&
        Array.isArray(effectiveMeta.attachments) &&
        effectiveMeta.attachments.length > 0
      ) {
        const attDesc = effectiveMeta.attachments
          .map((a: any) => {
            if (!a) return "";
            const label = a.name || a.filename || a.path || "attachment";
            const loc = a.path || a.url || "";
            return loc ? `[Attachment: ${label} (${loc})]` : `[Attachment: ${label}]`;
          })
          .filter(Boolean);
        if (attDesc.length > 0) {
          prefixParts.push(attDesc.join("\n"));
        }
      }
      if (prefixParts.length > 0) {
        out = out ? `${prefixParts.join("\n")}\n\n${out}` : prefixParts.join("\n");
      }
      return out;
    }

    const initialMetaForPrompt =
      resolvedSentAt || validClientTimeZone
        ? {
            ...(userMeta && typeof userMeta === "object" ? userMeta : {}),
            ...(resolvedSentAt ? { sentAt: resolvedSentAt } : {}),
            ...(validClientTimeZone ? { clientTimeZone: validClientTimeZone } : {}),
          }
        : userMeta;

    const prevTurnCompletionHeader = formatPreviousTurnCompletionHeader(
      prevTurnSnapshot,
      validClientTimeZone
    );
    let contextualUserText = promptText
      ? userText
      : formatContextualUserText(userText, initialMetaForPrompt, false, prevTurnCompletionHeader);

    const hasUserAttachments = Boolean(
      Array.isArray(userMeta?.attachments) && userMeta.attachments.length > 0
    );
    const userAttachmentImages = loadVisualAttachmentImages(
      userMeta?.attachments,
      rawConfiguredWriteRoots,
      { sessionId: botWorkspaceSessionId, config: scopedRuntimeConfig }
    );
    const hasVisualAttachments = Boolean(
      userAttachmentImages.length > 0 ||
        (Array.isArray(userMeta?.attachments) &&
          userMeta.attachments.some((att: any) => att && att.isMedia))
    );
    let effectiveInputText = promptText || contextualUserText;

    const isScheduledRun = /^\[例行任务/.test(String(userText || ""));
    // ---- Smart Router v2 (L0/L1): model-assisted task profiling ----
    const routingSettings = normalizeRoutingSettings(store?.readSettings?.()?.routing);
    const smartCandidate = Boolean(autoRoute && smartRouter && routingSettings.smartRouter);
    smart = null;
    if (smartCandidate) {
      const routeBot = speakerBot || store?.getSession?.(sessionId) || null;
      const planCtrl = new AbortController();
      ctrl.setStepAbort(planCtrl);
      const planSignal =
        typeof AbortSignal?.any === "function"
          ? AbortSignal.any([ctrl.signal, planCtrl.signal])
          : planCtrl.signal;
      let planned: any;
      try {
        planned = await planRoute({
          model,
          rawUserText: userText,
          recentContext: buildRecentRouteContext(store, sessionId),
          botId: routeBot?.id || sessionId,
          botRole: routeBot?.rolePrompt || "",
          hasAttachments: hasUserAttachments,
          isScheduledRun,
          config: { ...config, routing: routingSettings },
          signal: planSignal,
        });
      } finally {
        ctrl.setStepAbort(null);
      }
      if (planned.usage) {
        emitTagged({
          type: "usage",
          model: planned.usedModel,
          ...(planned.usedProviderId ? { providerId: planned.usedProviderId } : {}),
          routeTier: "router",
          routeLabel: "路由判断",
          input: planned.usage.input ?? 0,
          output: planned.usage.output ?? 0,
          ...(planned.usage.cached ? { cached: planned.usage.cached } : {}),
          ...(planned.usage.thoughts ? { thoughts: planned.usage.thoughts } : {}),
        });
      }
      if (planned.plan) {
        const plan = { ...planned.plan };
        if (hasVisualAttachments) plan.needs_visual = true; // L0: image attachments require a vision-grade model
        const preset = MODE_PRESETS[routingSettings.mode] || MODE_PRESETS.balanced;
        const bias = getCategoryBias(store, plan.category);
        const decision = tierFromPlan(plan, {
          mode: routingSettings.mode,
          bias,
          hasAttachments: hasUserAttachments,
        });
        const runtime = createRouteRuntime();
        const hasExplicitStepPlan =
          Array.isArray(plan.step_plan) && plan.step_plan.length > 0;
        runtime.pendingDeepSteps = hasExplicitStepPlan ? 0 : decision.openWithDeepSteps;
        runtime.pendingDeepReason = "开局深度规划";
        const budget = createTurnBudget({ maxTurnUsd: routingSettings.maxTurnUsd });
        if (planned.usage && planned.usedModel) budget.add(planned.usedModel, planned.usage);
        const resolvedTiers = resolveTierModels(config, Date.now(), routingSettings);
        smart = {
          plan,
          source: planned.source,
          mode: routingSettings.mode,
          bias,
          initialBaseTier: decision.baseTier,
          baseTier: decision.baseTier,
          baseThinking: decision.thinkingLevel,
          sameFastStandard: Boolean(resolvedTiers.fast && resolvedTiers.fast === resolvedTiers.standard),
          deepCap: preset.deepCap,
          runtime,
          budget,
          captureScreen:
            plan.needs_visual &&
            !hasMacHostGuiIntent(userText) &&
            !(userAttachmentImages.length > 0 && plan.category !== "gui") &&
            !(plan.category === "creative" && !hasDesktopIntent(userText)) &&
            !(isScheduledRun && plan.category !== "gui" && !hasDesktopIntent(userText)),
        };
        Object.assign(routeTrace, {
          active: true,
          botId: routeBot?.id || sessionId,
          plan,
          planSource: planned.source,
          mode: routingSettings.mode,
          initialBaseTier: decision.baseTier,
          runtime,
          budget,
        });
        emitTagged({
          type: "route_plan",
          plan,
          source: planned.source,
          mode: routingSettings.mode,
          bias,
          baseTier: decision.baseTier,
          openWithDeepSteps: decision.openWithDeepSteps,
          latencyMs: planned.latencyMs,
        });
      }
    }

    const initialRoute = autoRoute && !smart
      ? selectRoute({
          userText: effectiveInputText,
          rawUserText: userText,
          stepNo: 1,
          consecutiveErrors: 0,
          isBotHandoff,
          hasAttachments: hasUserAttachments,
          config,
        })
      : null;

    const shouldCaptureInitialScreen = smart
      ? smart.captureScreen
      : autoRoute
        ? initialRoute!.captureInitialScreen &&
          userAttachmentImages.length === 0 &&
          !(isScheduledRun && !hasDesktopIntent(userText))
        : userAttachmentImages.length === 0 && !(isScheduledRun && !hasDesktopIntent(userText));

    const initialSettings = store?.readSettings?.() || {};
    const initialHostMode =
      initialSettings?.hostComputer?.executionMode ||
      config?.hostExecutionMode ||
      "always";

    let initialPng: Buffer | null = null;
    if (shouldCaptureInitialScreen) {
      try {
        await ensureTaskScreenLease(ctrl.signal);
        const shot: any = await withOptionalMutex(desktopMutex, true, () =>
          executor.call("/screenshot", {})
        );
        if (shot?.png_base64) {
          initialPng = Buffer.from(shot.png_base64, "base64");
        } else if (Buffer.isBuffer(shot)) {
          initialPng = shot;
        }
      } catch (err: any) {
        if (autoRoute && initialHostMode !== "off") {
          initialPng = null;
        } else {
          emitTagged({ type: "error", message: err.message });
          setStatus("error");
          return { status: "error", text: err.message };
        }
      }
    }

    let history: any[] = [];
    let preservedScheduledPrefix: any[] = [];
    const SCHEDULED_LIGHTWEIGHT_MARKER = "[System Notice: Scheduled routine lightweight context";
    if (!skipHistorySave) {
      try {
        if (store?.loadHistory) {
          const loaded = store.loadHistory(sessionId);
          if (Array.isArray(loaded)) {
            history = [...loaded];
          }
        }
      } catch {
        // ignore
      }
    }
    if (
      isScheduledRun &&
      !skipHistorySave &&
      history.length > 0 &&
      Math.round(estimateEffectiveHistoryTokens(history) * getSessionTokenScale(sessionId, store)) >
        16_000
    ) {
      let recentRealTurns = 0;
      let cutIdx = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (isRealUserTurnStep(history[i])) {
          recentRealTurns += 1;
          if (recentRealTurns >= 2) {
            cutIdx = i;
            break;
          }
        }
      }
      if (cutIdx > 0) {
        preservedScheduledPrefix = history.slice(0, cutIdx);
        history = [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text: `${SCHEDULED_LIGHTWEIGHT_MARKER} — older interactive history omitted to avoid cold-loading stale context; retaining the most recent 2 turns.]`,
              },
            ],
          },
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: "Understood. Proceeding with the scheduled routine using recent context.",
              },
            ],
          },
          ...history.slice(cutIdx),
        ];
      }
    }
    const recentToolHistoryDetected = (() => {
      let realCount = 0;
      let startIdx = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        if (isRealUserTurnStep(history[i])) {
          realCount += 1;
          if (realCount >= 2) {
            startIdx = i;
            break;
          }
        }
      }
      for (let i = startIdx; i < history.length; i++) {
        const st = history[i];
        if (st?.type === "function_call" || st?.type === "function_result") {
          return true;
        }
      }
      const prevStatus = String(store?.getSession?.(sessionId)?.status || "");
      return (
        prevStatus === "error" ||
        prevStatus === "interrupted" ||
        prevStatus === "max_steps" ||
        prevStatus === "stopped"
      );
    })();
    if (history.length === 0) {
      sessionTokenScaleMap.delete(sessionId);
    } else if (history[history.length - 1]?.type === "user_input") {
      // Seal dangling unanswered user_input from a prior crashed/timed-out run so new turns don't re-trigger it
      history.push({
        type: "model_output",
        content: [
          {
            type: "text",
            text: "[System Notice: The previous turn was interrupted before completion. Focus on responding to the user's latest message.]",
          },
        ],
      });
    }
    if (userAttachmentImages.length > 0) {
      history.push(userStep(effectiveInputText, userAttachmentImages));
      if (initialPng != null) {
        history.push(userStep("Current desktop screen:", initialPng));
      }
    } else {
      history.push(userStep(effectiveInputText, initialPng));
    }
    // Strip screenshots belonging to completed earlier turns while keeping all images from this active turn
    history = pruneScreenshotsOlderThanTurns(history, 1);

    const maxSteps = config?.maxSteps ?? 60;
    const rawCompression =
      initialSettings?.contextCompression &&
      typeof initialSettings.contextCompression === "object"
        ? initialSettings.contextCompression
        : {};
    let compressionRules = normalizeContextCompressionSettings(rawCompression);
    const settleMs = config?.settleMs ?? 150;
    const defaultModel = resolveUtilityModels(config, Date.now(), routingSettings).fallbackModel;
    const allTools = enableBotTools
      ? [...TOOL_DECLARATIONS, ...BOT_COLLAB_TOOL_DECLARATIONS]
      : TOOL_DECLARATIONS;
    const TRIVIAL_CHAT_CORE_TOOLS = new Set([
      "memory_manage",
      "app_knowledge",
      "web_search",
      "web_fetch",
      "schedule_manage",
      "vault_manage",
      "list_bots",
      "send_bot_message",
      "ask_user_choice",
      "propose_draft",
      "route_escalate",
      "custom_skill_manage",
      "self_update",
    ]);
    let fullToolsUnlocked = Boolean(
      recentToolHistoryDetected ||
        smart?.plan?.isFollowUp ||
        isBotHandoff ||
        isScheduledRun
    );
    let frozenSystemInstruction: string | null = null;
    const keepScreenshots = config?.keepScreenshots ?? DEFAULT_KEEP_SCREENSHOTS;
    const persistSessionHistory = (stepsToSave: any[], maxScreens = keepScreenshots) => {
      if (skipHistorySave || !store?.saveHistory) return;
      let mergedSteps = stepsToSave;
      if (preservedScheduledPrefix.length > 0) {
        const firstText = String(stepsToSave?.[0]?.content?.[0]?.text || "");
        if (firstText.startsWith(SCHEDULED_LIGHTWEIGHT_MARKER)) {
          mergedSteps = [...preservedScheduledPrefix, ...stepsToSave.slice(2)];
        }
      }
      store.saveHistory(sessionId, pruneScreenshots(mergedSteps, maxScreens));
    };

    persistSessionHistory(history);

    const appendSteeredMessages = (messages: any[]): boolean => {
      if (!Array.isArray(messages) || messages.length === 0) return false;
      let hasVisualSteer = false;
      const steeredAttachments: any[] = [];
      const rawTexts: string[] = [];
      const formattedTexts: string[] = [];
      for (const m of messages) {
        const t = typeof m === "string" ? m : String(m?.text ?? "");
        const meta = typeof m === "object" && m ? m.userMeta : null;
        if (Array.isArray(meta?.attachments)) {
          if (meta.attachments.some((a: any) => a && a.isMedia)) {
            hasVisualSteer = true;
          }
          steeredAttachments.push(...meta.attachments);
        }
        if (t.trim()) rawTexts.push(t.trim());
        const formatted = formatContextualUserText(t, meta, true).trim();
        if (formatted) formattedTexts.push(formatted);
      }
      if (formattedTexts.length === 0) return false;
      const steeredImages = loadVisualAttachmentImages(
        steeredAttachments,
        rawConfiguredWriteRoots,
        { sessionId: botWorkspaceSessionId, config: scopedRuntimeConfig }
      );
      if (steeredImages.length > 0) hasVisualSteer = true;
      const joined = formattedTexts.join("\n\n");
      if (rawTexts.length > 0) {
        latestUserText = rawTexts[rawTexts.length - 1];
      }
      effectiveInputText = `${effectiveInputText}\n\n${joined}`.trim();
      history.push(
        userStep(
          `[The user sent new follow-up instructions while you were working. Immediately adjust based on completed progress and the new instructions below, then continue.]\n${joined}`,
          steeredImages.length > 0 ? steeredImages : null
        )
      );
      if (hasVisualSteer && smart) {
        smart.plan.needs_visual = true;
      }
      fullToolsUnlocked = true;
      frozenSystemInstruction = null;
      persistSessionHistory(history);
      setStatus("running");
      emitTagged({
        type: "thinking_summary",
        text: "正在处理最新消息",
        source: "steered",
      });
      scheduleThinkingSummary({ thoughts: [], calls: [], stepNo: 1 });
      return true;
    };

    if (ctrl.hasSteeredMessages()) {
      appendSteeredMessages(ctrl.consumeSteeredMessages());
    }

    const countHistoryImages = (steps: any[]): number => {
      let count = 0;
      for (const s of steps) {
        if (Array.isArray(s?.content)) {
          for (const part of s.content) {
            if (part?.type === "image") count++;
          }
        }
      }
      return count;
    };

    const maybeAutoCompressHistory = async (
      inTurnStep = false,
      activeModel = defaultModel,
      overheadTokens = 0,
      force = false
    ): Promise<boolean> => {
      const summaryInvoke =
        typeof model?.summarizeTurn === "function"
          ? model.summarizeTurn.bind(model)
          : typeof model?.nextTurn === "function"
            ? model.nextTurn.bind(model)
            : null;
      const contextWindow =
        config?.contextWindow ||
        getEffectiveCompressionWindow(activeModel, config?.effectiveContextCeiling);
      const targetTriggerTokens = Math.round(
        contextWindow * (compressionRules.triggerPercent / 100)
      );

      const result = await compressContextHistory(history, compressionRules, {
        contextWindow,
        overheadTokens,
        tokenScale: getSessionTokenScale(sessionId, store),
        keepScreenshots: force ? Math.min(keepScreenshots, 1) : keepScreenshots,
        inTurnStep,
        force,
        summarize: summaryInvoke
          ? async (transcript, meta) => {
              const tierModels = resolveTierModels(config, Date.now(), routingSettings);
              const summaryModel = tierModels.fast || config?.fastModel || defaultModel;
              const fallbackModel = tierModels.standard || defaultModel;
              const summaryWordCap =
                targetTriggerTokens >= 96_000
                  ? 1800
                  : targetTriggerTokens >= 48_000
                    ? 1200
                    : 800;
              const ruleHint = compressionRules.customInstruction
                ? `\nAdditional retention rule: ${compressionRules.customInstruction}`
                : "";
              const userPrompt = meta?.priorSummary
                ? `Merge and update the "Prior Summary" and "New Turns to Archive" into a single complete structured memory summary:\n\n[Prior Summary]\n${meta.priorSummary}\n\n[New Turns to Archive]\n${meta.deltaTranscript || transcript}`
                : `Compress the following earlier conversation history into a structured memory summary:\n\n${transcript}`;

              const timeoutCtrl = new AbortController();
              const timer = setTimeout(() => timeoutCtrl.abort(), 12_000);
              const combinedSignal =
                ctrl.signal && typeof AbortSignal?.any === "function"
                  ? AbortSignal.any([ctrl.signal, timeoutCtrl.signal])
                  : timeoutCtrl.signal;

              try {
                const summaryRes = await summaryInvoke!({
                  model: summaryModel,
                  fallbackModel,
                  thinkingLevel: "low",
                  timeoutMs: 12_000,
                  systemInstruction:
                    `You are a context compression assistant. Compress earlier conversation turns and tool calls into a structured 4-section memory summary using these exact section headers: [Core Goals & Constraints], [Completed Decisions], [Key Files & Environment], and [Pending Tasks & Next Steps]. Write the summary body in the primary language of the conversation while preserving exact file paths, ports, command outputs, proper nouns, and user constraints verbatim. If a Prior Summary is provided, perform an incremental state merge and refresh — keep still-valid facts and drop obsolete details. Keep the total length concise (under ~${summaryWordCap} characters/words) and NEVER fabricate information.` +
                    ruleHint,
                  input: [userStep(userPrompt, null)],
                  tools: [],
                  signal: combinedSignal,
                });
                if (summaryRes?.usage) {
                  const summaryUsedModel = summaryRes.usedModel || summaryModel;
                  smart?.budget?.add?.(summaryUsedModel, summaryRes.usage);
                  emitTagged({
                    type: "usage",
                    model: summaryUsedModel,
                    ...(summaryRes.usedProviderId ? { providerId: summaryRes.usedProviderId } : {}),
                    routeTier: "summary",
                    routeLabel: "上下文摘要",
                    input: summaryRes.usage.input ?? 0,
                    output: summaryRes.usage.output ?? 0,
                    ...(summaryRes.usage.cached ? { cached: summaryRes.usage.cached } : {}),
                    ...(summaryRes.usage.thoughts
                      ? { thoughts: summaryRes.usage.thoughts }
                      : {}),
                  });
                }
                return String(summaryRes?.text || "").trim();
              } finally {
                clearTimeout(timer);
              }
            }
          : undefined,
      });

      if (!result.changed) {
        // Leave mid-turn history append-only unless real compression triggers so Prompt Cache prefix stays intact.
        return false;
      }

      history = result.history;
      persistSessionHistory(history);
      emitTagged({
        type: "context_compressed",
        strategy: result.strategy,
        mode: result.mode,
        beforeSteps: result.beforeSteps,
        afterSteps: result.afterSteps,
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      });
      return true;
    };

    let shortReplyRetried = false;
    let executedToolCount = 0;
    const recentExecutedTools: string[] = [];
    let lastScreenSha1 = hashScreenshot(initialPng);
    const generatedImageEmbeds: Array<{
      url: string;
      markdown: string;
      degraded?: boolean;
      degradedReason?: string;
      fallbackNotice?: string;
    }> = [];
    const deliveredFileEmbeds: Array<{ path?: string; url?: string; markdown: string }> = [];
    const browserElementLabels = new Map<string, string>();
    let lastBrowserUrl = "";
    const approvedDraftsInTurn: Array<{ title: string; recipient: string; kind: string }> = [];
    let lastStepCachedTokens = 0;
    let lastStepThinkingLevel = "";

    for (let stepNo = 1; stepNo <= maxSteps; stepNo++) {
      if (ctrl.stopped) {
        setStatus("stopped");
        return { status: "stopped", text: "" };
      }

      if (ctrl.isPaused?.()) {
        turnHadPauseOrApproval = true;
      }
      const pauseState = await ctrl.waitIfPaused();
      if (pauseState === "stopped" || ctrl.stopped) {
        setStatus("stopped");
        return { status: "stopped", text: "" };
      }

      if (pauseState === "steered") {
        setStatus("running");
      }

      if (pauseState === "resumed") {
        try {
          await ensureTaskScreenLease(ctrl.signal);
          const shot: any = await withOptionalMutex(desktopMutex, true, () =>
            executor.call("/screenshot", {})
          );
          const freshPng = shot?.png_base64
            ? Buffer.from(shot.png_base64, "base64")
            : Buffer.isBuffer(shot)
              ? shot
              : null;
          lastScreenSha1 = hashScreenshot(freshPng) || lastScreenSha1;
          history.push(
            userStep(
              "The user paused and may have changed the screen. Current screen:",
              freshPng
            )
          );
        } catch (err: any) {
          emitTagged({ type: "error", message: err.message });
          setStatus("error");
          return { status: "error", text: err.message };
        }
      }

      if (ctrl.hasSteeredMessages()) {
        appendSteeredMessages(ctrl.consumeSteeredMessages());
      }

      // ---- Smart Router v2 (L2/L3): runtime escalation decision for this step ----
      let smartEsc: any = null;
      if (smart) {
        if (
          !smart.runtime.lastStepHadFailure &&
          smart.runtime.consecutiveOkSteps >= 3 &&
          smart.initialBaseTier &&
          tierRank(smart.baseTier) > tierRank(smart.initialBaseTier)
        ) {
          smart.baseTier = smart.initialBaseTier;
        }
        smartEsc = decideEscalation(smart.runtime, {
          baseTier: smart.baseTier,
          budget: smart.budget,
          deepCap: smart.deepCap,
          sameFastStandard: Boolean(smart.sameFastStandard),
          hotCacheContext:
            lastStepCachedTokens >= 60_000 ||
            (lastStepCachedTokens >= 30_000 && estimateEffectiveHistoryTokens(history) >= 60_000),
          currentThinkingLevel: lastStepThinkingLevel,
        });
        if (smartEsc?.promoteBase && tierRank(smartEsc.tier) > tierRank(smart.baseTier)) {
          smart.baseTier = smartEsc.tier;
        }
        if (smartEsc?.nudge) {
          history.push(userStep(`[System Notice] ${smartEsc.nudge}`, null));
        }
        beginStep(smart.runtime);
      }

      const sanitizedForVisual = sanitizeOrphanedCalls(history);
      let currentTurnStartIdx = 0;
      for (let i = sanitizedForVisual.length - 1; i >= 0; i--) {
        if (isRealUserTurnStep(sanitizedForVisual[i])) {
          currentTurnStartIdx = i;
          break;
        }
      }
      const hasScreenInHistoryBeforeCompress = sanitizedForVisual
        .slice(currentTurnStartIdx)
        .some(
          (step) =>
            Array.isArray(step?.content) &&
            step.content.some((part: any) => part && part.type === "image")
        );

      let stepRoute: Record<string, any>;
      if (smart) {
        const plannedStep = !smartEsc
          ? resolveStepFromPlan(smart.plan, stepNo, {
              mode: smart.mode,
              hasAttachments: hasUserAttachments,
              budget: smart.budget,
            })
          : null;
        const tier = smartEsc?.tier || plannedStep?.tier || smart.baseTier;
        const visual =
          hasScreenInHistoryBeforeCompress || smart.plan.needs_visual || hasUserAttachments;
        let thinkingLevel =
          smartEsc?.thinkingLevel || plannedStep?.thinkingLevel || smart.baseThinking;
        // Routine desktop screenshots & image attachments run natively on Hydrogen Med/High
        if (tier === "fast" && visual && thinkingLevel === "low") {
          thinkingLevel = hasUserAttachments ? "high" : "medium";
        }
        // Pure-text chat defaults to Medium tier (`medium`) on Hydrogen
        if (
          tier === "fast" &&
          !visual &&
          (smart.plan.category === "chat" || smart.plan.complexity === "trivial") &&
          thinkingLevel === "low"
        ) {
          thinkingLevel = "medium";
        }
        stepRoute = buildSmartRoute({
          tier,
          thinkingLevel,
          reason: smartEsc?.reason || plannedStep?.reason || smart.plan.reason || "",
          visual,
          captureInitialScreen: smart.captureScreen,
          config,
          routingSettings,
        });
      } else if (autoRoute) {
        stepRoute = selectRoute({
          userText: effectiveInputText,
          rawUserText: userText,
          stepNo,
          consecutiveErrors,
          isBotHandoff,
          hasAttachments: hasUserAttachments,
          hasScreenInHistory: hasScreenInHistoryBeforeCompress,
          config,
          routingSettings,
        });
      } else {
        stepRoute = {
          tier: "standard",
          label: "默认",
          model: modelName || defaultModel,
          fallbackModel: defaultModel,
          thinkingLevel: "low",
        };
      }

      const settings = store?.readSettings?.() || {};
      if (settings?.contextCompression && typeof settings.contextCompression === "object") {
        compressionRules = normalizeContextCompressionSettings(settings.contextCompression);
      }
      const hostExecutionMode =
        settings?.hostComputer?.executionMode ||
        config?.hostExecutionMode ||
        "always";
      const installedSkills = resolveInstalledSkillIds(settings);
      let activeMcpTools: any[] = [];
      let kimiCuActive = false;
      let mcpStatusNote = "";
      if (
        enableBotTools &&
        hostExecutionMode !== "off" &&
        installedSkills.includes("kimi-cu") &&
        mcpManager
      ) {
        try {
          activeMcpTools = await mcpManager.listGeminiTools(["kimi-cu"]);
          kimiCuActive = activeMcpTools.length > 0;
        } catch (err: any) {
          mcpStatusNote = err?.message || String(err);
        }
      }
      const { accounts: normalizedMailList } = normalizeMailAuthStore(
        store?.readMailAuth?.() || {}
      );
      const mailAccounts = normalizedMailList
        .filter(
          (entry) =>
            entry &&
            installedSkills.includes(entry.provider) &&
            entry.enabled !== false &&
            entry.email &&
            entry.password
        )
        .map((entry) => ({
          id: entry.id,
          provider: entry.provider,
          label:
            entry.label ||
            (entry.provider === "qqmail" ? "QQ 邮箱" : "通用邮箱"),
          email: entry.email,
          inboundProtocol: String(entry.inboundProtocol || "imap").toUpperCase(),
          isDefault: Boolean(entry.isDefault),
        }));
      const sessionObj = speakerBot || store?.getSession?.(sessionId) || null;
      const browserAutomationSettings = normalizeBrowserAutomationSettings(
        settings?.browserAutomation || config?.browserAutomation
      );
      const effectiveBrowserMode = resolveEffectiveBrowserMode(
        browserAutomationSettings,
        sessionObj?.browserMode
      );
      const promptConfig = {
        ...scopedRuntimeConfig,
        routing: settings.routing || config.routing,
        providers: settings.providers || config.providers,
        enableBotTools,
        isAdminBot: Boolean(sessionObj?.isAdmin),
        deployEnv: config?.deployEnv || "local",
        smartRouterActive: Boolean(smart),
        hostExecutionMode,
        browserAutomationMode:
          config?.deployEnv === "cloud" ? "bot_computer" : effectiveBrowserMode,
        browserDebugPort: browserAutomationSettings.debugPort,
        uiLocale: resolveEffectiveLocale(settings?.language || config?.language),
        kimiCuActive,
        mcpStatusNote,
        globalMemories:
          settings.globalMemories ||
          settings.privateSkills ||
          config.globalMemories ||
          config.privateSkills,
        privateSkills:
          settings.globalMemories ||
          settings.privateSkills ||
          config.globalMemories ||
          config.privateSkills,
        mailAccounts,
        vaultItems:
          store?.readVaultPublic?.() ||
          (Array.isArray(store?.readVault?.())
            ? store.readVault().map((v: any) => {
                if (!v || typeof v !== "object") return v;
                const { password, ...rest } = v;
                return { ...rest, hasPassword: Boolean(password) };
              })
            : null) ||
          config.vaultItems ||
          [],
        installedSkills,
        customSkills: store?.listCustomSkills?.({ enabledOnly: true }) || config.customSkills || [],
        skillsSummary: OFFICE_SKILLS.filter((s) => installedSkills.includes(s.id)).map((s) => ({
          id: s.id,
          name: s.name,
          accountCount: normalizedMailList.filter((a) => a.provider === s.id).length,
        })),
        botIdentity: sessionObj
          ? {
              name: sessionObj.title || "Twinkle",
              rolePrompt: sessionObj.rolePrompt || "",
              memories: Array.isArray(sessionObj.memories) ? sessionObj.memories : [],
              schedules: (store?.readSchedules?.() || []).filter(
                (s: any) => s && s.sessionId === sessionObj.id
              ),
              isGroup: Boolean(groupMeta),
              groupTitle: groupMeta?.title,
              groupMembers: groupMeta?.members,
            }
          : config.botIdentity,
      };

      const filteredBotTools = filterToolDeclarationsForSkills(allTools, installedSkills, {
        isAdminBot: Boolean(sessionObj?.isAdmin),
      });
      const rawStepTools = enableBotTools
        ? [
            ...filteredBotTools,
            ...(hostExecutionMode !== "off" ? HOST_TOOL_DECLARATIONS : []),
            ...activeMcpTools,
            ...(smart ? [ROUTE_ESCALATE_TOOL_DECLARATION] : []),
          ]
        : allTools;
      const shouldTrimTrivialChatTools =
        enableBotTools &&
        !fullToolsUnlocked &&
        Boolean(smart) &&
        smart?.plan?.complexity === "trivial" &&
        smart?.plan?.category === "chat" &&
        !smart?.plan?.needs_visual &&
        !hasUserAttachments;
      const stepTools = shouldTrimTrivialChatTools
        ? rawStepTools.filter((t: any) => TRIVIAL_CHAT_CORE_TOOLS.has(String(t?.name || "")))
        : rawStepTools;

      const requestedModel = autoRoute ? stepRoute.model : modelName || defaultModel;
      if (stepNo === maxSteps && maxSteps >= 4 && !ctrl.hasSteeredMessages()) {
        history.push(
          userStep(
            `[System Notice: This is step ${stepNo}/${maxSteps} (the final step allowed for this turn). Finish and respond directly to the user if ready; otherwise summarize completed work and remaining steps so the user can continue.]`,
            null
          )
        );
      }
      if (frozenSystemInstruction === null) {
        frozenSystemInstruction = buildSystemInstruction(promptConfig);
      }
      const systemInstruction = frozenSystemInstruction;
      const overheadTokens =
        estimateTextTokens(systemInstruction) +
        estimateStepTokens({ arguments: stepTools });

      await maybeAutoCompressHistory(stepNo > 1, requestedModel, overheadTokens);
      // Keep append-only history prefix untouched until hysteresis watermark triggers (preserves Prompt Cache)
      let pruned = sanitizeOrphanedCalls(history);
      let rawEstimatedInput = overheadTokens + estimateEffectiveHistoryTokens(pruned);
      const stepCtrl = new AbortController();
      ctrl.setStepAbort(stepCtrl);
      const stepSignal =
        typeof AbortSignal?.any === "function"
          ? AbortSignal.any([ctrl.signal, stepCtrl.signal])
          : stepCtrl.signal;
      if (ctrl.hasSteeredMessages()) {
        ctrl.setStepAbort(null);
        appendSteeredMessages(ctrl.consumeSteeredMessages());
        stepNo -= 1;
        continue;
      }

      const invokeStepModel = () =>
        model.nextTurn({
          model: requestedModel,
          ...(autoRoute
            ? {
                fallbackModel: stepRoute.fallbackModel,
                thinkingLevel: stepRoute.thinkingLevel,
                timeoutMs: stepRoute.timeoutMs,
              }
            : {}),
          systemInstruction,
          tools: stepTools,
          input: pruned,
          signal: stepSignal,
        });

      let turn: any;
      try {
        try {
          turn = await invokeStepModel();
        } catch (firstErr: any) {
          if (
            ctrl.stopped ||
            stepCtrl.signal.aborted ||
            ctrl.hasSteeredMessages() ||
            !isContextOverflowError(firstErr)
          ) {
            throw firstErr;
          }
          // Reactive context-overflow recovery: calibrate token scale, force compaction / emergency trim, then retry once.
          const emergencyWindow = config?.contextWindow || getModelContextWindow(requestedModel);
          updateSessionTokenScale(
            sessionId,
            rawEstimatedInput,
            Math.max(emergencyWindow, Math.round(rawEstimatedInput * 1.35))
          );
          const beforeOverflowTokens = estimateEffectiveHistoryTokens(pruned);
          const beforeOverflowChars = estimateHistoryChars(pruned);
          const compressed = await maybeAutoCompressHistory(true, requestedModel, overheadTokens, true);
          let nextPruned = sanitizeOrphanedCalls(history);
          if (!compressed || estimateEffectiveHistoryTokens(nextPruned) >= beforeOverflowTokens * 0.9) {
            const emergencyBudget = Math.max(
              1500,
              Math.min(
                Math.floor(beforeOverflowTokens * 0.55),
                Math.floor(emergencyWindow * 0.45) - overheadTokens
              )
            );
            const trimmed = trimHistoryToTokenBudget(
              pruneScreenshots(nextPruned, Math.min(keepScreenshots, 1)),
              emergencyBudget,
              { compactToolOutputChars: 600 }
            );
            if (trimmed.length < nextPruned.length || estimateEffectiveHistoryTokens(trimmed) < beforeOverflowTokens) {
              history = trimmed;
              nextPruned = sanitizeOrphanedCalls(history);
              persistSessionHistory(history);
              emitTagged({
                type: "context_compressed",
                strategy: "trim",
                mode: "extractive-trim",
                beforeSteps: pruned.length,
                afterSteps: nextPruned.length,
                beforeChars: beforeOverflowChars,
                afterChars: estimateHistoryChars(nextPruned),
                beforeTokens: beforeOverflowTokens,
                afterTokens: estimateEffectiveHistoryTokens(nextPruned),
              });
            }
          }
          if (estimateEffectiveHistoryTokens(nextPruned) >= beforeOverflowTokens && nextPruned.length >= pruned.length) {
            throw firstErr;
          }
          pruned = nextPruned;
          rawEstimatedInput = overheadTokens + estimateEffectiveHistoryTokens(pruned);
          turn = await invokeStepModel();
        }
      } catch (err: any) {
        if (ctrl.stopped) {
          setStatus("stopped");
          return { status: "stopped", text: "" };
        }
        if (stepCtrl.signal.aborted || ctrl.hasSteeredMessages()) {
          appendSteeredMessages(ctrl.consumeSteeredMessages());
          stepNo -= 1;
          continue;
        }
        if (!skipHistorySave) {
          history.push({
            type: "model_output",
            content: [
              {
                type: "text",
                text: `[System Notice: This turn was interrupted or timed out (${err?.message || "unknown error"}) without producing a valid reply.]`,
              },
            ],
          });
          persistSessionHistory(history);
        }
        if (smart?.runtime) {
          smart.runtime.errorsTotal = (smart.runtime.errorsTotal || 0) + 1;
        }
        emitTagged({ type: "error", message: redactSensitiveTokensInText(err.message) });
        setStatus("error");
        return { status: "error", text: redactSensitiveTokensInText(err.message) };
      } finally {
        ctrl.setStepAbort(null);
      }

      if (ctrl.stopped) {
        setStatus("stopped");
        return { status: "stopped", text: "" };
      }

      if (turn?.usage) {
        updateSessionTokenScale(sessionId, rawEstimatedInput, turn.usage.input, store, skipHistorySave);
      }

      const actualUsedModel = turn?.usedModel || requestedModel;
      if (turn?.usage) {
        lastStepCachedTokens = Number(turn.usage.cached) || 0;
      }
      lastStepThinkingLevel = String(stepRoute?.thinkingLevel || "");

      if (smart) {
        commitStepTier(smart.runtime, stepRoute.tier, {
          usedEscalation: Boolean(smartEsc),
          thinkingLevel: stepRoute.thinkingLevel,
          model: actualUsedModel,
        });
        if (turn?.usage) smart.budget.add(actualUsedModel, turn.usage);
        const noticeLevel = smart.budget.takeNotice();
        if (noticeLevel) {
          const maxTurnCny = Math.round(smart.budget.maxTurnUsd * USD_TO_CNY * 100) / 100;
          const spentCny = Math.round(smart.budget.spentUsd * USD_TO_CNY * 100) / 100;
          emitTagged({
            type: "route_notice",
            level: noticeLevel === 2 ? "budget_exhausted" : "budget_warning",
            spentUsd: Math.round(smart.budget.spentUsd * 10000) / 10000,
            maxTurnUsd: smart.budget.maxTurnUsd,
            spentCny,
            maxTurnCny,
            text:
              noticeLevel === 2
                ? `本轮费用已达预算上限 ¥${maxTurnCny.toFixed(2)}，后续不再升级模型`
                : `本轮费用已接近预算（¥${spentCny.toFixed(2)} / ¥${maxTurnCny.toFixed(2)}），暂停深度推理升级`,
          });
        }
      }

      if (Array.isArray(turn?.thoughts)) {
        for (const thought of turn.thoughts) {
          if (thought && typeof thought === "string" && thought.trim()) {
            emitTagged({
              type: "thought",
              text: redactSensitiveTokensInText(thought),
              ...(autoRoute
                ? {
                    routeTier: stepRoute.tier,
                    routeLabel: stepRoute.label,
                    usedModel: actualUsedModel,
                  }
                : {}),
            });
          }
        }
      }

      if (turn?.usage) {
        emitTagged({
          type: "usage",
          model: actualUsedModel,
          ...(turn?.usedProviderId ? { providerId: turn.usedProviderId } : {}),
          ...(autoRoute
            ? {
                routeTier: stepRoute.tier,
                routeLabel: stepRoute.label,
                ...(stepRoute.reason ? { routeReason: stepRoute.reason } : {}),
                ...(smart
                  ? {
                      tierPath: formatTierPath(smart.runtime.tierPath, {
                        modelPath: smart.runtime.modelPath,
                      }),
                    }
                  : {}),
              }
            : {}),
          input: turn.usage.input ?? 0,
          output: turn.usage.output ?? 0,
          ...(turn.usage.cached ? { cached: turn.usage.cached } : {}),
          ...(turn.usage.thoughts ? { thoughts: turn.usage.thoughts } : {}),
        });
      }

      if (ctrl.isPaused?.()) {
        const postModelPause = await ctrl.waitIfPaused();
        if (postModelPause === "stopped" || ctrl.stopped) {
          setStatus("stopped");
          return { status: "stopped", text: "" };
        }
        if (postModelPause === "steered" || postModelPause === "resumed") {
          setStatus("running");
        }
      }

      // If a follow-up user message arrived right as the model returned tool calls,
      // skip pushing/executing stale calls so we don't leave unpaired function_calls
      // and immediately respond to the new message with existing history intact.
      if (Array.isArray(turn?.calls) && turn.calls.length > 0 && ctrl.hasSteeredMessages()) {
        appendSteeredMessages(ctrl.consumeSteeredMessages());
        stepNo -= 1;
        continue;
      }

      if (Array.isArray(turn?.outputSteps)) {
        history.push(...turn.outputSteps);
      }

      if (!turn?.calls || turn.calls.length === 0) {
        if (ctrl.hasSteeredMessages()) {
          if (typeof turn?.text === "string" && turn.text.trim()) {
            emitTagged({
              type: "assistant_text",
              text: turn.text.trim(),
              interim: true,
            });
          }
          appendSteeredMessages(ctrl.consumeSteeredMessages());
          continue;
        }
        const trimmedTurnText = String(turn?.text || "").trim();
        const hasPendingEmbeds =
          generatedImageEmbeds.length > 0 || deliveredFileEmbeds.length > 0;

        // Recover when a model emits neither text nor tool calls (e.g. length-truncated
        // reasoning or an empty/malformed upstream response) instead of silently finishing blank.
        if (!trimmedTurnText && !hasPendingEmbeds) {
          if (consecutiveErrors < 2 && stepNo < maxSteps) {
            consecutiveErrors += 1;
            history.push(
              userStep(
                turn?.finishReason === "length"
                  ? "[System Notice: The previous output hit the length limit and was truncated before producing visible text or tool calls. Provide a concise answer directly or issue tool calls in smaller steps.]"
                  : "[System Notice: The previous model response was empty (produced neither visible text nor tool calls). Continue executing the task using native tool calls, or provide a clear final answer to the user.]",
                null
              )
            );
            continue;
          }
          const emptyErrMessage =
            turn?.finishReason === "length"
              ? "模型输出连续触达长度上限且未返回有效内容，任务已中止，请重试或切换模型。"
              : "模型连续返回空响应（未输出文本或工具调用），任务未能继续，请重试或切换模型。";
          if (!skipHistorySave) {
            history.push({
              type: "model_output",
              content: [
                {
                  type: "text",
                  text: `[System Notice: This turn ended with an empty model response (${turn?.finishReason || "empty"}) without producing a valid reply.]`,
                },
              ],
            });
            persistSessionHistory(history);
          }
          if (smart?.runtime) {
            smart.runtime.errorsTotal = (smart.runtime.errorsTotal || 0) + 1;
          }
          emitTagged({ type: "error", message: emptyErrMessage });
          setStatus("error");
          return { status: "error", text: emptyErrMessage };
        }

        // Recover if the model accidentally echoed a pseudo `[Tool call <toolName>(...)]`
        // string as plain text instead of issuing a real native function_call.
        if (
          trimmedTurnText &&
          stepTools.length > 0 &&
          consecutiveErrors < 2 &&
          stepNo < maxSteps
        ) {
          const pseudoCallMatch = trimmedTurnText.match(/\[Tool call\s+([a-zA-Z0-9_.:-]+)\s*\(/);
          if (
            pseudoCallMatch &&
            stepTools.some((t: any) => t && t.name === pseudoCallMatch[1])
          ) {
            consecutiveErrors += 1;
            history.push(
              userStep(
                `[System Notice: You wrote "[Tool call ${pseudoCallMatch[1]}(...)]" as plain text instead of invoking the native tool. Do not print pseudo tool-call syntax; invoke "${pseudoCallMatch[1]}" via native function calling now.]`,
                null
              )
            );
            continue;
          }
        }
        // Self-check when the model spent substantial reasoning (>= 800 thoughts tokens)
        // yet emitted an ultra-terse (< 7 char) non-acknowledgment reply.
        const thoughtTokens = Number(turn?.usage?.thoughts) || 0;
        const isShortAckReply =
          /^(?:ok|okay|done|yes|no|好的|好|收到|嗯|明白|完成|已处理|已发|行|是|对)[.!。！]?$/i.test(
            trimmedTurnText
          );
        if (
          !shortReplyRetried &&
          !hasPendingEmbeds &&
          thoughtTokens >= 800 &&
          trimmedTurnText.length > 0 &&
          trimmedTurnText.length <= 6 &&
          !isShortAckReply &&
          stepNo < maxSteps
        ) {
          shortReplyRetried = true;
          history.push(
            userStep(
              `[System Notice: Your reply ("${trimmedTurnText}") after extensive reasoning was unusually brief. Expand with a clear, complete summary of your findings, result, or next step for the user.]`,
              null
            )
          );
          continue;
        }
        persistSessionHistory(history);
        let answerText = turn?.text ?? "";
        const normalizeEmbedRef = (raw?: string): string => {
          const s = String(raw || "").trim();
          if (!s) return "";
          try {
            return decodeURIComponent(s).replace(/\\/g, "/");
          } catch {
            return s.replace(/\\/g, "/");
          }
        };
        const answerHasEmbed = (embed?: { url?: string; path?: string; markdown?: string }): boolean => {
          if (!embed) return false;
          const normAnswer = normalizeEmbedRef(answerText);
          const normUrl = normalizeEmbedRef(embed.url);
          const normPath = normalizeEmbedRef(embed.path);
          const normMd = normalizeEmbedRef(embed.markdown);
          if (normUrl && (answerText.includes(String(embed.url)) || normAnswer.includes(normUrl))) {
            return true;
          }
          if (normPath && (answerText.includes(String(embed.path)) || normAnswer.includes(normPath))) {
            return true;
          }
          if (normMd && normAnswer.includes(normMd)) {
            return true;
          }
          return false;
        };
        const appendedNotices = new Set<string>();
        const appendedEmbedKeys = new Set<string>();
        for (const embed of generatedImageEmbeds) {
          const dedupKey = normalizeEmbedRef(embed?.url || embed?.markdown);
          if (
            embed?.url &&
            embed?.markdown &&
            !appendedEmbedKeys.has(dedupKey) &&
            !answerHasEmbed(embed)
          ) {
            appendedEmbedKeys.add(dedupKey);
            answerText = answerText.trim()
              ? `${answerText.trim()}\n\n${embed.markdown}`
              : embed.markdown;
          }
          if (
            embed?.degraded &&
            (embed.fallbackNotice || embed.degradedReason) &&
            !/(?:降级|fallback|degrad)/i.test(answerText)
          ) {
            const noticeLine = `> 说明：${embed.fallbackNotice || `本次图片生成已降级为大语言模型代码生成 SVG（原因：${embed.degradedReason}）`}`;
            if (!appendedNotices.has(noticeLine)) {
              appendedNotices.add(noticeLine);
              answerText = answerText.trim()
                ? `${answerText.trim()}\n\n${noticeLine}`
                : noticeLine;
            }
          }
        }
        for (const embed of deliveredFileEmbeds) {
          const dedupKey = normalizeEmbedRef(embed?.url || embed?.path || embed?.markdown);
          if (
            embed?.markdown &&
            !appendedEmbedKeys.has(dedupKey) &&
            !answerHasEmbed(embed)
          ) {
            appendedEmbedKeys.add(dedupKey);
            answerText = answerText.trim()
              ? `${answerText.trim()}\n\n${embed.markdown}`
              : embed.markdown;
          }
        }
        const effectiveReplyAnchor =
          replyToAnchor ||
          (userMeta?.replyTo && emittedUserSeq
            ? {
                seq: emittedUserSeq,
                author: "你",
                snippet: String(userText || "").replace(/\s+/g, " ").slice(0, 72),
              }
            : null);
        const redactedAnswer = redactSensitiveTokensInText(answerText);
        emitTagged({
          type: "answer",
          text: redactedAnswer,
          ...(effectiveReplyAnchor ? { replyTo: effectiveReplyAnchor } : {}),
        });
        setStatus("done");
        if (!skipHistorySave && !speakerBot && store?.updateSession) {
          try {
            if (store?.getSession?.(sessionId)) {
              store.updateSession(sessionId, {
                lastTurnCompletedAt: new Date().toISOString(),
                lastTurnDurationMs: Math.max(0, Date.now() - turnStartedAtMs),
                lastTurnHadPauseOrApproval: turnHadPauseOrApproval,
                touch: false,
              });
            }
          } catch {
            // ignore turn timing persistence failure
          }
        }
        if (
          enableBotTools &&
          !memoryManagedInTurn &&
          !speakerBot &&
          !ctrl.stopped &&
          config?.autoMemoryExtract !== false &&
          typeof model?.summarizeTurn === "function"
        ) {
          const postSettings = store?.readSettings?.() || {};
          const postRouting = normalizeRoutingSettings(postSettings?.routing);
          void runPostTurnMemoryExtraction({
            store,
            model,
            sessionId,
            botSession: sessionObj,
            userText: latestUserText,
            assistantText: redactedAnswer,
            config: { ...config, routing: postRouting },
            emit: emitTagged,
            onUsage: (info) => {
              if (smart?.budget && info?.usage && info?.model) {
                smart.budget.add(info.model, info.usage);
              }
            },
            broadcastGlobal,
          }).catch(() => {});
        }
        return { status: "done", text: redactedAnswer };
      }

      if (ctrl.isPaused?.()) {
        const preCallPause = await ctrl.waitIfPaused();
        if (preCallPause === "stopped" || ctrl.stopped) {
          setStatus("stopped");
          return { status: "stopped", text: "" };
        }
        if (preCallPause === "steered" || preCallPause === "resumed") {
          setStatus("running");
        }
      }

      // GrokBot conversational UX: emit natural pre-action acknowledgment bubble before running tools
      if (typeof turn?.text === "string" && turn.text.trim() && !ctrl.hasSteeredMessages()) {
        emitTagged({
          type: "assistant_text",
          text: turn.text.trim(),
          interim: true,
        });
      }

      scheduleThinkingSummary({
        thoughts: Array.isArray(turn?.thoughts) ? turn.thoughts : [],
        calls: turn.calls,
        stepNo,
      });

      // Keep all function_result steps for this turn's parallel tool calls contiguous
      // before appending any "Current screen:" user_input steps so Chat Completions
      // providers never see a user message splitting assistant.tool_calls and tool results.
      const deferredScreenSteps: any[] = [];
      const isTruncatedTurn = turn?.finishReason === "length";
      const BATCHED_GUI_ACTIONS = new Set([
        "click",
        "double_click",
        "right_click",
        "move",
        "drag",
        "scroll",
        "type_text",
        "key",
      ]);
      let abortRemainingGuiBatch = false;
      for (const call of turn.calls) {
        if (ctrl.stopped) {
          setStatus("stopped");
          return { status: "stopped", text: "" };
        }

        if (ctrl.isPaused?.()) {
          const midCallPause = await ctrl.waitIfPaused();
          if (midCallPause === "stopped" || ctrl.stopped) {
            setStatus("stopped");
            return { status: "stopped", text: "" };
          }
          if (midCallPause === "steered" || midCallPause === "resumed") {
            setStatus("running");
          }
        }

        if (ctrl.hasSteeredMessages()) {
          // Keep function_call / function_result strictly paired in history
          // without running remaining queued calls from before the user's new message.
          history.push(
            ...toolResultSteps(
              call,
              { error: "skipped due to user's new follow-up message" },
              null
            )
          );
          continue;
        }

        if (abortRemainingGuiBatch && (BATCHED_GUI_ACTIONS.has(call.name) || isBrowserAutomationTool(call.name))) {
          const skipRes = {
            error:
              "skipped remaining batched GUI/browser action after prior failure, page change, or verification challenge",
          };
          emitTagged({
            type: "result",
            callId: call.id,
            name: call.name,
            result: skipRes,
          });
          history.push(...toolResultSteps(call, skipRes, null));
          continue;
        }

        emitTagged({
          type: "action",
          callId: call.id,
          name: call.name,
          args: redactToolArgsForDisplay(call.name, call.args),
        });

        if (isTruncatedTurn || call.parseError) {
          const guardError = isTruncatedTurn
            ? `Tool call "${call.name}" was not executed because the model output hit the token limit (finish_reason=length) and arguments may be truncated. Please retry with complete arguments or split into smaller steps.`
            : `Tool call "${call.name}" was not executed: ${call.parseError}. Please re-issue with a valid JSON object.`;
          const guardResult = { error: guardError };
          consecutiveErrors += 1;
          if (smart) {
            recordToolOutcome(smart.runtime, { name: call.name, args: call.args, result: guardResult });
          }
          emitTagged({
            type: "result",
            callId: call.id,
            name: call.name,
            result: guardResult,
          });
          history.push(...toolResultSteps(call, guardResult, null));
          continue;
        }

        // Smart Router v2: model self-escalation request (handled host-side, no executor round-trip)
        if (call.name === "route_escalate") {
          fullToolsUnlocked = true;
          const escResult = smart
            ? requestEscalation(smart.runtime, call.args || {}, {
                budget: smart.budget,
                deepCap: smart.deepCap,
              })
            : { ok: false, granted: false, reason: "智能路由未启用" };
          emitTagged({
            type: "result",
            callId: call.id,
            name: call.name,
            result: escResult,
          });
          history.push(...toolResultSteps(call, escResult, null));
          continue;
        }

        // Handle Built-in Bot Collaboration, Interactive Choice & Image Generation Tools
        if (enableBotTools && isBotCollabTool(call.name)) {
          executedToolCount += 1;
          recentExecutedTools.push(call.name);
          if (
            call.name === "memory_manage" &&
            (call.args?.action === "save" ||
              call.args?.action === "remove" ||
              call.args?.action === "toggle")
          ) {
            memoryManagedInTurn = true;
          }
          const collabResult: any = await runBotCollabTool(call.name, call.args, {
            store,
            model,
            executor,
            mcpManager,
            getChannelStatus,
            channelPairingActions,
            channelConfigActions,
            getRelayStatus,
            accountActions,
            selfUpdateActions,
            userMeta,
            config: promptConfig,
            userText: latestUserText,
            activeLlmModel: requestedModel,
            fallbackLlmModel: autoRoute ? stepRoute.fallbackModel : defaultModel,
            senderSessionId: sessionId,
            senderBot: sessionObj,
            hopDepth,
            control: ctrl,
            callId: call.id,
            emit: emitTagged,
            broadcastGlobal,
            onDispatchBotTurn,
            onDispatchGroupTurn,
          });
          if (
            call.name === "propose_draft" ||
            call.name === "ask_user_choice" ||
            call.name === "request_credential"
          ) {
            turnHadPauseOrApproval = true;
          }
          if (
            call.name === "propose_draft" &&
            collabResult?.ok &&
            collabResult?.approved === true
          ) {
            approvedDraftsInTurn.push({
              title: String(collabResult.title || ""),
              recipient: String(collabResult.recipient || ""),
              kind: String(collabResult.kind || ""),
            });
          }
          if (smart) {
            recordToolOutcome(smart.runtime, { name: call.name, args: call.args, result: collabResult });
          }
          if (collabResult?.error) {
            consecutiveErrors += 1;
          } else {
            consecutiveErrors = 0;
            if (
              call.name === "generate_image" &&
              collabResult?.ok &&
              collabResult?.url &&
              collabResult?.markdown
            ) {
              generatedImageEmbeds.push({
                url: collabResult.url,
                markdown: collabResult.markdown,
                degraded: Boolean(collabResult.degraded),
                degradedReason: collabResult.degraded_reason || "",
                fallbackNotice: collabResult.fallback_notice || "",
              });
            } else if (
              call.name === "send_file" &&
              collabResult?.ok &&
              collabResult?.markdown
            ) {
              deliveredFileEmbeds.push({
                path: collabResult.path,
                url: collabResult.url,
                markdown: collabResult.markdown,
              });
            }
          }

          const displayCollab = truncateForDisplay(collabResult);
          emitTagged({
            type: "result",
            callId: call.id,
            name: call.name,
            result: displayCollab,
          });
          history.push(...toolResultSteps(call, collabResult, null));
          continue;
        }

        const policyConfig = {
          ...scopedRuntimeConfig,
          hostExecutionMode,
          browserAutomationMode:
            config?.deployEnv === "cloud" ? "bot_computer" : effectiveBrowserMode,
          botWorkspaceRoot,
          sandboxMode: config?.sandboxMode || settings?.sandboxMode || "full",
          isAdminBot: Boolean(speakerBot?.isAdmin || store?.getSession?.(sessionId)?.isAdmin),
          policy: settings.policy || config.policy,
        };
        const { decision, reason } = assessToolCall(
          call.name,
          call.args,
          policyConfig
        );
        let toolResult: any;
        let screenshotBuf: Buffer | null = null;
        const useLocalBrowser =
          isBrowserAutomationTool(call.name) &&
          effectiveBrowserMode !== "bot_computer" &&
          config?.deployEnv !== "cloud";
        const needsScreenLock =
          SCREEN_REQUIRED_TOOLS.has(call.name) && !useLocalBrowser;

        const executeApprovedCall = async (approvedByUser = false): Promise<{ result: any; screenshot: Buffer | null }> => {
          executedToolCount += 1;
          recentExecutedTools.push(call.name);
          if (isHostTool(call.name)) {
            if (config?.deployEnv === "cloud" || hostBridge?.hasConnectedHost?.()) {
              if (!hostBridge) {
                return {
                  result: { ok: false, error: "当前没有可用的客户端主机桥接通道" },
                  screenshot: null,
                };
              }
              try {
                return await hostBridge.execute({
                  name: call.name,
                  args: call.args,
                  callId: call.id,
                  sessionId,
                  approved: approvedByUser || decision === "allow",
                  signal: ctrl.signal,
                });
              } catch (err: any) {
                if (ctrl.stopped) throw err;
                return { result: { ok: false, error: err.message || String(err) }, screenshot: null };
              }
            }
            try {
              const hostOut = await runHostTool(call.name, call.args, {
                shellTimeoutSec: config?.shellTimeoutSec ?? 60,
                workspaceRoot: botWorkspaceRoot || config?.writeRoots?.[0],
                signal: ctrl.signal,
              });
              if (
                hostOut?.result?.ok &&
                (call.name === "host_record_screen" ||
                  (call.name === "host_write_file" &&
                    botWorkspaceRoot &&
                    typeof hostOut.result.path === "string" &&
                    hostOut.result.path.startsWith(botWorkspaceRoot)))
              ) {
                broadcastGlobal?.({
                  type: "library_updated",
                  sessionId,
                });
              }
              return hostOut;
            } catch (err: any) {
              if (ctrl.stopped) throw err;
              return { result: { ok: false, error: err.message || String(err) }, screenshot: null };
            }
          }
          if (isMcpToolName(call.name)) {
            if (!mcpManager) {
              return { result: { ok: false, error: "MCP manager is not configured" }, screenshot: null };
            }
            try {
              return await mcpManager.callTool(call.name, call.args, {
                signal: ctrl.signal,
              });
            } catch (err: any) {
              if (ctrl.stopped) throw err;
              return { result: { ok: false, error: err.message || String(err) }, screenshot: null };
            }
          }
          if (needsScreenLock) {
            await ensureTaskScreenLease(ctrl.signal);
          }
          if (
            (call.name === "run_shell" ||
              call.name === "write_file" ||
              call.name === "edit_file") &&
            botWorkspaceRoot &&
            hasConfiguredWriteRoots
          ) {
            try {
              ensureBotWorkspaceDir({
                config: scopedRuntimeConfig,
                writeRoots: rawConfiguredWriteRoots,
                sessionId: botWorkspaceSessionId,
              });
            } catch {
              // ignore uncreatable mock/custom paths
            }
          }
          const sandboxOut = await withOptionalMutex(
            desktopMutex,
            needsScreenLock,
            () =>
              runTool(call.name, call.args, executor, {
                settleMs,
                signal: ctrl.signal,
                prevScreenshotSha1: lastScreenSha1,
                ...(useLocalBrowser
                  ? {
                      localBrowserExecutor: (
                        toolName: string,
                        toolArgs: Record<string, any>,
                        toolSignal?: AbortSignal
                      ) =>
                        getDefaultLocalChromeManager().executeTool(toolName, toolArgs, {
                          mode: effectiveBrowserMode as "local_headless" | "local_debug",
                          sessionKey: speakerBot?.id || sessionId,
                          settings: browserAutomationSettings,
                          dataDir: store?.dataDir || config?.dataDir,
                          blockedLocalPorts: [Number(config?.port) || 3230, 7300],
                          allowedFileRoots: botWorkspaceRoot ? [botWorkspaceRoot] : [],
                          signal: toolSignal,
                        }),
                    }
                  : {}),
              })
          );
          if (
            (call.name === "write_file" ||
              call.name === "edit_file" ||
              call.name === "run_shell") &&
            !sandboxOut?.result?.error
          ) {
            broadcastGlobal?.({
              type: "library_updated",
              sessionId,
            });
          }
          return sandboxOut;
        };

        const DRAFT_REUSE_ELIGIBLE_TOOLS = new Set([
          "browser_click",
          "browser_type",
          "click",
          "key",
          "mail_send_message",
        ]);
        const reuseApprovedDraft =
          decision === "confirm" &&
          approvedDraftsInTurn.length > 0 &&
          DRAFT_REUSE_ELIGIBLE_TOOLS.has(call.name) &&
          reason === "Action is flagged as high risk";

        if (decision === "deny") {
          toolResult = { error: `denied by policy: ${reason}` };
          screenshotBuf = null;
        } else if (decision === "confirm" && !reuseApprovedDraft) {
          turnHadPauseOrApproval = true;
          const contextSummary = buildApprovalContextSummary(call.name, call.args, {
            browserElements: browserElementLabels,
            browserUrl: lastBrowserUrl,
          });
          const enrichedReason =
            contextSummary && !reason.includes(contextSummary)
              ? `${reason}（${contextSummary}）`
              : reason;
          const approvalPromise = ctrl.requestApproval(call.id);

          emitTagged({
            type: "approval_request",
            callId: call.id,
            name: call.name,
            args: call.args,
            reason: enrichedReason,
            ...(contextSummary ? { contextSummary } : {}),
          });
          setStatus("awaiting_approval");

          const approvalReminderMs =
            typeof config?.approvalReminderMs === "number"
              ? config.approvalReminderMs
              : 120_000;
          let reminderTimer: ReturnType<typeof setTimeout> | null = null;
          if (approvalReminderMs > 0 && Number.isFinite(approvalReminderMs)) {
            reminderTimer = setTimeout(() => {
              if (runEnded || ctrl.stopped) return;
              emitTagged({
                type: "approval_reminder",
                callId: call.id,
                name: call.name,
                reason: enrichedReason,
                waitedMs: approvalReminderMs,
              });
            }, approvalReminderMs);
            reminderTimer.unref?.();
          }

          let allowed = false;
          try {
            allowed = await approvalPromise;
          } finally {
            if (reminderTimer) {
              clearTimeout(reminderTimer);
              reminderTimer = null;
            }
          }
          const approvalSuperseded = ctrl.wasApprovalSuperseded(call.id);
          emitTagged({
            type: "approval",
            callId: call.id,
            allowed: Boolean(allowed),
            ...(approvalSuperseded ? { superseded: true } : {}),
          });

          if (ctrl.stopped) {
            setStatus("stopped");
            return { status: "stopped", text: "" };
          }

          setStatus("running");

          if (!allowed) {
            toolResult = {
              error: approvalSuperseded
                ? "superseded by user's new follow-up message"
                : "the user declined this action",
              ...(approvalSuperseded ? { superseded: true } : {}),
            };
            screenshotBuf = null;
          } else {
            const runRes = await executeApprovedCall(true);
            toolResult = runRes.result;
            screenshotBuf = runRes.screenshot;
          }
        } else if (decision === "confirm" && reuseApprovedDraft) {
          const runRes = await executeApprovedCall(true);
          toolResult = runRes.result;
          screenshotBuf = runRes.screenshot;
        } else {
          const runRes = await executeApprovedCall(false);
          toolResult = runRes.result;
          screenshotBuf = runRes.screenshot;
        }

        if (ctrl.stopped) {
          setStatus("stopped");
          return { status: "stopped", text: "" };
        }

        if (toolResult?.error && !toolResult?.superseded && !ctrl.hasSteeredMessages()) {
          consecutiveErrors += 1;
        } else {
          consecutiveErrors = 0;
        }
        if (smart) {
          recordToolOutcome(smart.runtime, { name: call.name, args: call.args, result: toolResult });
        }
        if (isBrowserAutomationTool(call.name) && toolResult && typeof toolResult === "object") {
          if (typeof toolResult.url === "string" && toolResult.url.trim()) {
            lastBrowserUrl = toolResult.url.trim();
          }
          if (Array.isArray(toolResult.elements)) {
            browserElementLabels.clear();
            for (const el of toolResult.elements) {
              if (!el || typeof el !== "object") continue;
              const elRef = String(el.ref || "").trim();
              if (!elRef) continue;
              const textPart = String(el.name || el.text || el.label || el.placeholder || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 48);
              const tagPart = String(el.tag || el.role || "").trim();
              const labelStr = textPart
                ? tagPart
                  ? `${textPart} (${tagPart})`
                  : textPart
                : tagPart;
              if (labelStr) {
                browserElementLabels.set(elRef, labelStr);
              }
            }
          }
        }
        if (
          ((BATCHED_GUI_ACTIONS.has(call.name) || isBrowserAutomationTool(call.name)) &&
            (toolResult?.error ||
              toolResult?.ok === false ||
              toolResult?.challenge_detected === true)) ||
          ((call.name === "browser_click" || call.name === "browser_type") &&
            (toolResult?.switched_to_new_tab ||
              toolResult?.submitted === true ||
              toolResult?.typed?.submit === true))
        ) {
          abortRemainingGuiBatch = true;
        }

        let screenshotFile: string | undefined;
        if (screenshotBuf != null) {
          lastScreenSha1 = hashScreenshot(screenshotBuf) || lastScreenSha1;
          if (store?.saveScreenshot) {
            screenshotFile = store.saveScreenshot(
              sessionId,
              stepNo,
              screenshotBuf
            );
          }
        }

        const displayResult = truncateForDisplay(toolResult);
        emitTagged({
          type: "result",
          callId: call.id,
          name: call.name,
          result: displayResult,
          ...(screenshotFile ? { screenshot: screenshotFile } : {}),
        });

        const resultSteps = toolResultSteps(call, toolResult, null);
        history.push(...resultSteps);
        if (screenshotBuf != null) {
          deferredScreenSteps.push(userStep("Current screen:", screenshotBuf));
        }
      }
      if (deferredScreenSteps.length > 0) {
        history.push(...deferredScreenSteps);
      }

      persistSessionHistory(history);
    }

    const recentUnique = [...new Set(recentExecutedTools.slice(-8))].slice(-4);
    const progressDetail =
      executedToolCount > 0
        ? `已完成 ${executedToolCount} 次操作${recentUnique.length ? `（近期：${recentUnique.join("、")}）` : ""}。`
        : "";
    const maxStepsMessage =
      `已达到单轮最大步数上限（${maxSteps} 步），当前任务已暂停。` +
      `${progressDetail}你可以直接回复「继续」或点击下方「继续执行」让我从当前进度接续完成。`;

    if (!skipHistorySave && store?.saveHistory) {
      const lastStep = history[history.length - 1];
      if (lastStep?.type !== "model_output") {
        history.push({
          type: "model_output",
          content: [
            {
              type: "text",
              text: `[System Notice: Reached the single-turn limit of ${maxSteps} steps (${executedToolCount} tool calls executed). Paused cleanly and notified the user that they can reply "继续" to resume from current progress.]`,
            },
          ],
        });
      }
      persistSessionHistory(history);
    }

    emitTagged({
      type: "route_notice",
      level: "max_steps",
      maxSteps,
      stepsUsed: maxSteps,
      toolCount: executedToolCount,
      recentTools: recentUnique,
      text: maxStepsMessage,
    });
    setStatus("max_steps");
    return { status: "max_steps", text: maxStepsMessage };
  } finally {
    runEnded = true;
    if (releaseTaskScreenLease) {
      try {
        releaseTaskScreenLease();
      } catch {
        // ignore
      }
      releaseTaskScreenLease = null;
    }
    try {
      (activeSummaryCtrl as AbortController | null)?.abort();
    } catch {
      // ignore
    }
  }
}
