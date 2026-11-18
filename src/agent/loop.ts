import fs from "node:fs";
import path from "node:path";
import { TOOL_DECLARATIONS, runTool, hashScreenshot } from "./tools.js";
import { SCREEN_REQUIRED_TOOLS } from "../shared/screen-pool.js";
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
  pruneScreenshots,
  sanitizeOrphanedCalls,
  trimHistoryToTokenBudget,
} from "./context.js";
import {
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
import { planRoute } from "./route-planner.js";
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
import { summarizeThinkingProgress } from "./thinking-summarizer.js";
import { USD_TO_CNY } from "./pricing.js";

const MAX_SESSION_TOKEN_SCALES = 256;
const sessionTokenScaleMap = new Map<string, number>();

function getSessionTokenScale(sessionId: string): number {
  return sessionTokenScaleMap.get(sessionId) ?? 1;
}

function updateSessionTokenScale(
  sessionId: string,
  rawEstimatedInput: number,
  actualInputTokens: unknown
): void {
  const actual = Number(actualInputTokens);
  if (!sessionId || !Number.isFinite(actual) || actual <= 0 || rawEstimatedInput <= 0) {
    return;
  }
  // Ignore tiny synthetic test fixtures (< 50% of local estimate) so mocked usage does not skew budgets
  if (actual < rawEstimatedInput * 0.5) {
    return;
  }
  const nextScale = Math.min(2.5, Math.max(1, actual / rawEstimatedInput));
  if (
    !sessionTokenScaleMap.has(sessionId) &&
    sessionTokenScaleMap.size >= MAX_SESSION_TOKEN_SCALES
  ) {
    const oldestKey = sessionTokenScaleMap.keys().next().value;
    if (oldestKey !== undefined) sessionTokenScaleMap.delete(oldestKey);
  }
  sessionTokenScaleMap.set(sessionId, nextScale);
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
  writeRoots: string[] = []
): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;
    const rawPath = typeof att.path === "string" ? att.path.trim() : "";
    if (!rawPath) continue;
    const resolved = expandUserPath(rawPath);
    if (!resolved || isSensitiveFilePath(resolved)) continue;
    if (!isPathInsideWriteRoots(resolved, writeRoots)) continue;
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
    return val.length > maxLen ? val.slice(0, maxLen) : val;
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
        tierPathLabel: formatTierPath(routeTrace.runtime?.tierPath || []),
        steps: routeTrace.runtime?.tierPath?.length || 0,
        errors: routeTrace.runtime?.errorsTotal || 0,
        softFailures: routeTrace.runtime?.softFailuresTotal || 0,
        escalations: routeTrace.runtime?.escalationEvents?.length || 0,
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
          `${e.type === "user" ? "用户" : "Bot"}：${String(e.text || "").replace(/\s+/g, " ").slice(0, 200)}`
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
        } else if (hasModelSummary) {
          return;
        }
        if (res?.usage && res?.usedModel) {
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

  if (String(userText || "").trim()) {
    scheduleThinkingSummary({ thoughts: [], calls: [], stepNo: 1 });
  }

  try {
    function formatContextualUserText(rawText: string, meta: any, includeAttachments = false): string {
      let out = String(rawText || "");
      if (!meta || typeof meta !== "object") return out;
      const prefixParts: string[] = [];
      if (meta.replyTo?.snippet) {
        prefixParts.push(
          `[回复消息 (${meta.replyTo.author || "对话"}): "${meta.replyTo.snippet}"]`
        );
      }
      if (Array.isArray(meta.quotes) && meta.quotes.length > 0) {
        prefixParts.push(meta.quotes.map((q: unknown) => `> ${q}`).join("\n"));
      }
      if (includeAttachments && Array.isArray(meta.attachments) && meta.attachments.length > 0) {
        const attDesc = meta.attachments
          .map((a: any) => {
            if (!a) return "";
            const label = a.name || a.filename || a.path || "附件";
            const loc = a.path || a.url || "";
            return loc ? `[附件: ${label} (${loc})]` : `[附件: ${label}]`;
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

    let contextualUserText = promptText
      ? userText
      : formatContextualUserText(userText, userMeta, false);

    const hasUserAttachments = Boolean(
      Array.isArray(userMeta?.attachments) && userMeta.attachments.length > 0
    );
    const userAttachmentImages = loadVisualAttachmentImages(
      userMeta?.attachments,
      config?.writeRoots
    );
    const hasVisualAttachments = Boolean(
      userAttachmentImages.length > 0 ||
        (Array.isArray(userMeta?.attachments) &&
          userMeta.attachments.some((att: any) => att && att.isMedia))
    );
    let effectiveInputText = promptText || contextualUserText;

    // ---- Smart Router v2 (L0/L1): model-assisted task profiling ----
    const routingSettings = normalizeRoutingSettings(store?.readSettings?.()?.routing);
    const smartCandidate = Boolean(autoRoute && smartRouter && routingSettings.smartRouter);
    let smart: Record<string, any> | null = null;
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
          isScheduledRun: /^\[例行任务/.test(String(userText || "")),
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
        smart = {
          plan,
          source: planned.source,
          mode: routingSettings.mode,
          bias,
          baseTier: decision.baseTier,
          baseThinking: decision.thinkingLevel,
          deepCap: preset.deepCap,
          runtime,
          budget,
          captureScreen:
            plan.needs_visual &&
            !hasMacHostGuiIntent(userText) &&
            !(userAttachmentImages.length > 0 && plan.category !== "gui") &&
            !(plan.category === "creative" && !hasDesktopIntent(userText)),
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
        ? initialRoute!.captureInitialScreen && userAttachmentImages.length === 0
        : userAttachmentImages.length === 0;

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
    if (history.length === 0) {
      sessionTokenScaleMap.delete(sessionId);
    } else if (history[history.length - 1]?.type === "user_input") {
      // Seal dangling unanswered user_input from a prior crashed/timed-out run so new turns don't re-trigger it
      history.push({
        type: "model_output",
        content: [{ type: "text", text: "[系统提示：更早一轮请求未完成即中断，请专注响应用户最新消息]" }],
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

    const maxSteps = config?.maxSteps ?? 60;
    const rawCompression =
      initialSettings?.contextCompression &&
      typeof initialSettings.contextCompression === "object"
        ? initialSettings.contextCompression
        : {};
    let compressionRules = normalizeContextCompressionSettings(rawCompression);
    const keepScreenshots = config?.keepScreenshots ?? DEFAULT_KEEP_SCREENSHOTS;
    const settleMs = config?.settleMs ?? 150;
    const defaultModel = resolveUtilityModels(config, Date.now(), routingSettings).fallbackModel;
    const allTools = enableBotTools
      ? [...TOOL_DECLARATIONS, ...BOT_COLLAB_TOOL_DECLARATIONS]
      : TOOL_DECLARATIONS;

    if (!skipHistorySave && store?.saveHistory) {
      store.saveHistory(sessionId, pruneScreenshots(history, keepScreenshots));
    }

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
        config?.writeRoots
      );
      if (steeredImages.length > 0) hasVisualSteer = true;
      const joined = formattedTexts.join("\n\n");
      if (rawTexts.length > 0) {
        latestUserText = rawTexts[rawTexts.length - 1];
      }
      effectiveInputText = `${effectiveInputText}\n\n${joined}`.trim();
      history.push(
        userStep(
          `[用户在你当前处理过程中发来了新的补充/指令，请结合以上已完成进度与新要求立即调整并继续处理]\n${joined}`,
          steeredImages.length > 0 ? steeredImages : null
        )
      );
      if (hasVisualSteer && smart) {
        smart.plan.needs_visual = true;
      }
      if (!skipHistorySave && store?.saveHistory) {
        store.saveHistory(sessionId, pruneScreenshots(history, keepScreenshots));
      }
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
      const contextWindow = config?.contextWindow || getModelContextWindow(activeModel);
      const targetTriggerTokens = Math.round(
        contextWindow * (compressionRules.triggerPercent / 100)
      );

      const result = await compressContextHistory(history, compressionRules, {
        contextWindow,
        overheadTokens,
        tokenScale: getSessionTokenScale(sessionId),
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
                ? `\n额外保留规则：${compressionRules.customInstruction}`
                : "";
              const userPrompt = meta?.priorSummary
                ? `请将「已有摘要」与「新增待归档对话」合并更新为一版完整的结构化中文记忆摘要：\n\n[已有摘要]\n${meta.priorSummary}\n\n[新增待归档对话]\n${meta.deltaTranscript || transcript}`
                : `请将以下较早历史记录压缩为结构化中文摘要：\n\n${transcript}`;

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
                    `你是上下文压缩助手。请将较早的对话与工具调用记录压缩为四栏结构化中文记忆摘要：【核心目标与约束】【已完成结论】【关键文件与环境】【待办与当前衔接】。若提供了已有摘要，请在其基础上做增量状态合并与刷新，保留仍然有效的文件路径、端口、命令结果与用户约束，剔除已废弃信息。总字数控制在 ${summaryWordCap} 字以内，严禁编造信息。` +
                    ruleHint,
                  input: [userStep(userPrompt, null)],
                  tools: [],
                  signal: combinedSignal,
                });
                if (summaryRes?.usage) {
                  emitTagged({
                    type: "usage",
                    model: summaryRes.usedModel || summaryModel,
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
        // Guard against unbounded screenshot buildup mid-turn while leaving a +2 buffer for Prompt Cache
        if (countHistoryImages(history) > keepScreenshots + 2) {
          history = pruneScreenshots(history, keepScreenshots);
        }
        return false;
      }

      history = result.history;
      if (!skipHistorySave && store?.saveHistory) {
        store.saveHistory(sessionId, pruneScreenshots(history, keepScreenshots));
      }
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

    let consecutiveErrors = 0;
    let lastScreenSha1 = hashScreenshot(initialPng);
    const generatedImageEmbeds: Array<{
      url: string;
      markdown: string;
      degraded?: boolean;
      degradedReason?: string;
      fallbackNotice?: string;
    }> = [];
    const deliveredFileEmbeds: Array<{ path?: string; url?: string; markdown: string }> = [];

    for (let stepNo = 1; stepNo <= maxSteps; stepNo++) {
      if (ctrl.stopped) {
        setStatus("stopped");
        return { status: "stopped", text: "" };
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
        smartEsc = decideEscalation(smart.runtime, {
          baseTier: smart.baseTier,
          budget: smart.budget,
          deepCap: smart.deepCap,
        });
        if (smartEsc?.promoteBase && tierRank(smartEsc.tier) > tierRank(smart.baseTier)) {
          smart.baseTier = smartEsc.tier;
        }
        if (smartEsc?.nudge) {
          history.push(userStep(`[系统提示] ${smartEsc.nudge}`, null));
        }
        beginStep(smart.runtime);
      }

      const hasScreenInHistoryBeforeCompress = sanitizeOrphanedCalls(history).some(
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
      const promptConfig = {
        ...config,
        routing: settings.routing || config.routing,
        providers: settings.providers || config.providers,
        enableBotTools,
        isAdminBot: Boolean(sessionObj?.isAdmin),
        deployEnv: config?.deployEnv || "local",
        smartRouterActive: Boolean(smart),
        hostExecutionMode,
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
        vaultItems: store?.readVault?.() || config.vaultItems || [],
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

      const stepTools = enableBotTools
        ? [
            ...filterToolDeclarationsForSkills(allTools, installedSkills),
            ...(hostExecutionMode !== "off" ? HOST_TOOL_DECLARATIONS : []),
            ...activeMcpTools,
            ...(smart ? [ROUTE_ESCALATE_TOOL_DECLARATION] : []),
          ]
        : allTools;

      const requestedModel = autoRoute ? stepRoute.model : modelName || defaultModel;
      const systemInstruction = buildSystemInstruction(promptConfig);
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
              if (!skipHistorySave && store?.saveHistory) {
                store.saveHistory(sessionId, pruneScreenshots(history, keepScreenshots));
              }
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
        if (!skipHistorySave && store?.saveHistory) {
          history.push({
            type: "model_output",
            content: [
              {
                type: "text",
                text: `[系统提示：本轮请求执行中断或超时（${err?.message || "unknown error"}），未生成有效回复]`,
              },
            ],
          });
          store.saveHistory(sessionId, pruneScreenshots(history, keepScreenshots));
        }
        emitTagged({ type: "error", message: err.message });
        setStatus("error");
        return { status: "error", text: err.message };
      } finally {
        ctrl.setStepAbort(null);
      }

      if (ctrl.stopped) {
        setStatus("stopped");
        return { status: "stopped", text: "" };
      }

      if (turn?.usage) {
        updateSessionTokenScale(sessionId, rawEstimatedInput, turn.usage.input);
      }

      const actualUsedModel = turn?.usedModel || requestedModel;

      if (smart) {
        commitStepTier(smart.runtime, stepRoute.tier);
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
              text: thought,
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
                ...(smart ? { tierPath: formatTierPath(smart.runtime.tierPath) } : {}),
              }
            : {}),
          input: turn.usage.input ?? 0,
          output: turn.usage.output ?? 0,
          ...(turn.usage.cached ? { cached: turn.usage.cached } : {}),
          ...(turn.usage.thoughts ? { thoughts: turn.usage.thoughts } : {}),
        });
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
        // If a reasoning model exhausted max_tokens inside reasoning (finish_reason=length)
        // and emitted neither text nor tool calls, recover once instead of finishing blank.
        if (
          turn?.finishReason === "length" &&
          !String(turn?.text || "").trim() &&
          consecutiveErrors < 2 &&
          stepNo < maxSteps
        ) {
          consecutiveErrors += 1;
          history.push(
            userStep(
              "[系统提示：上一轮输出因达到长度上限被截断且未生成可见正文或工具调用，请直接给出精简结论或分步调用工具]",
              null
            )
          );
          continue;
        }
        const prunedFinal = pruneScreenshots(history, keepScreenshots);
        if (!skipHistorySave && store?.saveHistory) {
          store.saveHistory(sessionId, prunedFinal);
        }
        let answerText = turn?.text ?? "";
        const appendedNotices = new Set<string>();
        for (const embed of generatedImageEmbeds) {
          if (embed?.url && embed?.markdown && !answerText.includes(embed.url)) {
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
          if (
            embed?.markdown &&
            (!embed.path || !answerText.includes(embed.path)) &&
            (!embed.url || !answerText.includes(embed.url))
          ) {
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
        emitTagged({
          type: "answer",
          text: answerText,
          ...(effectiveReplyAnchor ? { replyTo: effectiveReplyAnchor } : {}),
        });
        setStatus("done");
        return { status: "done", text: answerText };
      }

      // GrokBot conversational UX: emit natural pre-action acknowledgment bubble before running tools
      if (typeof turn?.text === "string" && turn.text.trim()) {
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
      for (const call of turn.calls) {
        if (ctrl.stopped) {
          setStatus("stopped");
          return { status: "stopped", text: "" };
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
          const collabResult: any = await runBotCollabTool(call.name, call.args, {
            store,
            model,
            executor,
            mcpManager,
            config: promptConfig,
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
          ...config,
          hostExecutionMode,
          sandboxMode: config?.sandboxMode || settings?.sandboxMode || "restricted",
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
        const needsScreenLock = SCREEN_REQUIRED_TOOLS.has(call.name);

        const executeApprovedCall = async (approvedByUser = false): Promise<{ result: any; screenshot: Buffer | null }> => {
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
              return await runHostTool(call.name, call.args, {
                shellTimeoutSec: config?.shellTimeoutSec ?? 60,
                workspaceRoot: config?.writeRoots?.[0],
                signal: ctrl.signal,
              });
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
          return withOptionalMutex(
            desktopMutex,
            needsScreenLock,
            () =>
              runTool(call.name, call.args, executor, {
                settleMs,
                signal: ctrl.signal,
                prevScreenshotSha1: lastScreenSha1,
              })
          );
        };

        if (decision === "deny") {
          toolResult = { error: `denied by policy: ${reason}` };
          screenshotBuf = null;
        } else if (decision === "confirm") {
          const approvalPromise = ctrl.requestApproval(call.id);

          emitTagged({
            type: "approval_request",
            callId: call.id,
            name: call.name,
            args: call.args,
            reason,
          });
          setStatus("awaiting_approval");

          const allowed = await approvalPromise;
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

      if (!skipHistorySave && store?.saveHistory) {
        store.saveHistory(sessionId, pruneScreenshots(history, keepScreenshots));
      }
    }

    setStatus("max_steps");
    return { status: "max_steps", text: "" };
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
