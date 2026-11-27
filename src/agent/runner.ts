import path from "node:path";
import { runTask, createControl } from "./loop.js";
import { createBotScopedExecutorClient } from "./executor-client.js";
import { resolveBotWorkspaceRoot } from "../lib/bot-workspace.js";
import {
  formatMessageSourceHeader,
  formatMessageTimeHeader,
  sanitizeChannelMeta,
  sanitizeClientTimeZone,
} from "../lib/channel-integrations.js";
import {
  createScreenLeasePool,
  getHostScreenPoolBudget,
  resolveConfiguredMaxScreens,
  type AcquireScreenLeaseOptions,
} from "./screen-pool-manager.js";
import { createMcpManager } from "../lib/mcp-client.js";
import {
  selectGroupSpeakers,
  extractMentionedBots,
  buildGroupPromptContext,
  MAX_GROUP_TURNS,
} from "./group-coordinator.js";
import { accumulateSessionUsagePatch } from "./pricing.js";
import { resolveUtilityModels } from "./router.js";

function createAsyncMutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
      const run = chain.then(() => fn());
      chain = run.catch(() => {});
      return run;
    },
  };
}

export interface CreateRunnerOptions {
  store?: any;
  config?: Record<string, any>;
  model?: any;
  executor?: any;
  mcpManager?: any;
  runTaskImpl?: typeof runTask;
}

export function createRunner({
  store,
  config = {},
  model,
  executor,
  mcpManager = null,
  runTaskImpl = runTask,
}: CreateRunnerOptions = {}) {
  const sharedMcpManager =
    mcpManager ??
    createMcpManager({
      getServersConfig: () => store?.readSettings?.()?.mcpServers || {},
    });
  // Per-session active run map: sessionId -> { state, control, onSteer, replyListeners }
  const activeRuns = new Map<
    string,
    {
      state: string;
      control: ReturnType<typeof createControl>;
      onSteer?: ((msg: { text: string; userMeta: any }) => void) | null;
      replyListeners?: Array<(res: { status?: string; text?: string; error?: string }) => void>;
    }
  >();
  // Queued follow-up messages (user messages + inter-Bot handoffs arriving while target Bot is busy)
  const pendingUserQueue = new Map<string, Array<{ text: string; userMeta: any; skipUserEvent?: boolean }>>();
  const pendingBotInbox = new Map<string, any[]>();
  const botDesktopMutexes = new Map<string, ReturnType<typeof createAsyncMutex>>();
  function getBotDesktopMutex(botKey: string | null | undefined) {
    const key = String(botKey || "").trim() || "__primary__";
    let m = botDesktopMutexes.get(key);
    if (!m) {
      m = createAsyncMutex();
      botDesktopMutexes.set(key, m);
    }
    return m;
  }
  const hostScreenBudget = getHostScreenPoolBudget();
  const getMaxConcurrentScreens = () =>
    Number.isFinite(Number(config?.maxConcurrentScreens)) && Number(config.maxConcurrentScreens) >= 1
      ? Math.round(Number(config.maxConcurrentScreens))
      : resolveConfiguredMaxScreens(store, hostScreenBudget);
  const screenLeasePool = createScreenLeasePool({ getMaxConcurrentScreens });
  const subscribers = new Set<(payload: any) => void>();

  function getPrimaryActive(): { sessionId: string | null; state: string } {
    for (const [sessionId, entry] of activeRuns.entries()) {
      return { sessionId, state: entry.state };
    }
    return { sessionId: null, state: "idle" };
  }

  function status() {
    return getPrimaryActive();
  }

  function activeSessions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, entry] of activeRuns.entries()) {
      out[id] = entry.state;
    }
    return out;
  }

  function isSessionBusy(sessionId: string): boolean {
    return activeRuns.has(sessionId);
  }

  function subscribe(fn: (payload: any) => void): () => void {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  function broadcastGlobal(payload: any): void {
    for (const fn of subscribers) {
      try {
        fn(payload);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  function emitForSession(sessionId: string, event: Record<string, any>): void {
    let saved = event;
    try {
      if (store?.appendEvent) {
        saved = store.appendEvent(sessionId, event);
      }
    } catch {
      // ignore
    }

    if (event.type === "status") {
      const entry = activeRuns.get(sessionId);
      if (entry) {
        entry.state = event.status;
      }
      try {
        if (store?.updateSession) {
          store.updateSession(sessionId, { status: event.status, touch: false });
        }
      } catch {
        // ignore
      }
    } else if (event.type === "usage") {
      try {
        if (store?.getSession && store?.updateSession) {
          const s = store.getSession(sessionId);
          const providers = store?.readSettings?.()?.providers || [];
          const patch = accumulateSessionUsagePatch(
            s,
            {
              model: event.model,
              providerId: event.providerId,
              input: event.input,
              output: event.output,
              cached: event.cached,
              thoughts: event.thoughts,
              ...(saved?.at !== undefined ? { at: saved.at } : {}),
            },
            { providers }
          );
          store.updateSession(sessionId, patch);
        }
      } catch {
        // ignore
      }
    } else if (event.type === "answer" && event.text) {
      try {
        if (store?.getSession && store?.updateSession) {
          const prefix = event.botName ? `${event.botName}: ` : "";
          store.updateSession(sessionId, {
            subtitle: `${prefix}${String(event.text).replace(/\s+/g, " ").slice(0, 48)}`,
          });
        }
      } catch {
        // ignore
      }
    } else if (event.type === "route_notice" && event.level === "max_steps" && event.text) {
      try {
        if (store?.updateSession) {
          store.updateSession(sessionId, {
            subtitle: String(event.text).replace(/\s+/g, " ").slice(0, 48),
          });
        }
      } catch {
        // ignore
      }
    }

    broadcastGlobal({ sessionId, ...saved });
  }

  function enqueueOrRunBotHandoff({
    targetBotId,
    fromBot,
    exchangeId,
    message,
    hopDepth = 1,
    onReplyComplete = null,
  }: {
    targetBotId: string;
    fromBot?: any;
    exchangeId?: string;
    message: string;
    hopDepth?: number;
    onReplyComplete?: ((res: { status?: string; text?: string; error?: string }) => void) | null;
  }): void {
    const promptForTarget =
      `[Inter-Bot Handoff · From "${fromBot?.title || "Bot"}"]\n` +
      `${message}\n\n` +
      `Please handle this handoff according to your role and conclude with a concise, clear status update. If another Bot needs to take over next, you may call send_bot_message.`;

    const job = {
      text: promptForTarget,
      hopDepth,
      isBotHandoff: true,
      skipUserEvent: true,
      exchangeId,
      fromBot,
      onReplyComplete,
    };

    if (activeRuns.has(targetBotId)) {
      const q = pendingBotInbox.get(targetBotId) || [];
      q.push(job);
      pendingBotInbox.set(targetBotId, q);
      return;
    }

    startInternal(targetBotId, job.text, job);
  }

  function sanitizeUserMeta(userMeta: any): Record<string, any> {
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
      };
    }
    const cleanChannelMeta = sanitizeChannelMeta(userMeta?.channelMeta);
    if (cleanChannelMeta) {
      cleanMeta.channelMeta = cleanChannelMeta;
    }
    const validClientTimeZone = sanitizeClientTimeZone(userMeta?.clientTimeZone);
    if (validClientTimeZone) {
      cleanMeta.clientTimeZone = validClientTimeZone;
    }
    if (userMeta?.sentAt && Number.isFinite(Date.parse(String(userMeta.sentAt)))) {
      cleanMeta.sentAt = new Date(String(userMeta.sentAt)).toISOString();
    }
    return cleanMeta;
  }

  function ensureServerSentAt(userMeta: any): Record<string, any> {
    const base = userMeta && typeof userMeta === "object" ? { ...userMeta } : {};
    const parsed = base.sentAt ? Date.parse(String(base.sentAt)) : NaN;
    base.sentAt = Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : new Date().toISOString();
    return base;
  }

  function recordUserMessage(
    sessionId: string,
    text: string,
    userMeta: any = null,
    extra: Record<string, any> = {}
  ): void {
    const cleanMeta = sanitizeUserMeta(userMeta);
    emitForSession(sessionId, { type: "user", text, ...cleanMeta, ...extra });
  }

  function queueStatus(sessionId: string): number {
    return (pendingUserQueue.get(sessionId) || []).length;
  }

  function enqueue(
    sessionId: string,
    text: string,
    userMeta: any = null,
    opts?: { onComplete?: ((res: { status?: string; text?: string; error?: string }) => void) | null }
  ) {
    const session = store?.getSession?.(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const effectiveMeta = ensureServerSentAt(userMeta);
    if (!activeRuns.has(sessionId)) {
      startInternal(sessionId, text, {
        userMeta: effectiveMeta,
        ...(opts?.onComplete ? { onReplyComplete: opts.onComplete } : {}),
      });
      return { queued: false, steered: false, queueLength: 0 };
    }
    const entry = activeRuns.get(sessionId);
    if (opts?.onComplete && entry?.replyListeners) {
      entry.replyListeners.push(opts.onComplete);
    }
    // Live-steer the running task immediately instead of blocking behind a queue
    recordUserMessage(sessionId, text, effectiveMeta);
    entry?.onSteer?.({ text, userMeta: effectiveMeta });
    if (typeof entry?.control?.steer === "function") {
      entry.control.steer({ text, userMeta: effectiveMeta });
      return { queued: false, steered: true, queueLength: 0 };
    }
    const q = pendingUserQueue.get(sessionId) || [];
    q.push({ text, userMeta: effectiveMeta, skipUserEvent: true });
    pendingUserQueue.set(sessionId, q);
    broadcastGlobal({
      type: "queue_updated",
      sessionId,
      queueLength: q.length,
    });
    return { queued: true, steered: false, queueLength: q.length };
  }

  function drainSessionQueue(sessionId: string): void {
    const uq = pendingUserQueue.get(sessionId);
    if (uq && uq.length > 0) {
      const nextUser = uq.shift()!;
      if (uq.length === 0) pendingUserQueue.delete(sessionId);
      broadcastGlobal({
        type: "queue_updated",
        sessionId,
        queueLength: uq.length,
      });
      startInternal(sessionId, nextUser.text, {
        userMeta: nextUser.userMeta,
        skipUserEvent: true,
      });
      return;
    }
    const q = pendingBotInbox.get(sessionId);
    if (!q || q.length === 0) return;
    const nextJob = q.shift()!;
    if (q.length === 0) pendingBotInbox.delete(sessionId);
    startInternal(sessionId, nextJob.text, nextJob);
  }

  async function runGroupConversation({
    groupSession,
    userText,
    userMeta = null,
    modelName,
    control,
    emit,
    initiatorBot = null,
    skipUserEvent = false,
    hopDepth = 0,
    groupSteers = [],
  }: {
    groupSession: any;
    userText: string;
    userMeta?: any;
    modelName: string;
    control: ReturnType<typeof createControl>;
    emit: (event: any) => void;
    initiatorBot?: any;
    skipUserEvent?: boolean;
    hopDepth?: number;
    groupSteers?: Array<{ text: string; userMeta?: any }>;
  }) {
    const allSessions = store?.listSessions?.() || [];
    const memberIds: string[] = Array.isArray(groupSession.memberBotIds)
      ? groupSession.memberBotIds
      : [];
    let memberBots = memberIds
      .map((id) => store?.getSession?.(id))
      .filter(Boolean);

    if (memberBots.length === 0) {
      memberBots = allSessions.filter((s: any) => s.type !== "group").slice(0, 2);
    }

    let userEvtSeq: number | null = null;
    if (initiatorBot) {
      emit({
        type: "answer",
        botId: initiatorBot.id,
        botName: initiatorBot.title,
        botAvatar: initiatorBot.avatar || null,
        text: userText,
      });
    } else {
      if (!skipUserEvent) {
        const cleanMeta = sanitizeUserMeta(userMeta);
        emit({ type: "user", text: userText, ...cleanMeta });
      }
      try {
        const evs = store?.readEvents?.(groupSession.id) || [];
        const lastU = [...evs].reverse().find((e) => e.type === "user");
        if (lastU?.seq) userEvtSeq = lastU.seq;
      } catch {
        // ignore
      }
    }
    emit({ type: "status", status: "running" });

    let activeUserText = userText;
    let activeUserMeta = userMeta;
    let pendingSpeakers = selectGroupSpeakers({
      text: activeUserText,
      memberBots,
      excludeBotId: initiatorBot?.id || null,
      replyToBotId: activeUserMeta?.replyTo?.botId || null,
      maxSpeakers: 2,
    });

    let turnsTaken = 0;
    const spokenSet = new Set<string>();

    const applyPendingGroupSteers = () => {
      if (!Array.isArray(groupSteers) || groupSteers.length === 0) return false;
      const batch = groupSteers.splice(0, groupSteers.length);
      const merged = batch
        .map((m) => String(m?.text || "").trim())
        .filter(Boolean)
        .join("\n\n");
      const latestMeta =
        [...batch].reverse().find((m) => m?.userMeta)?.userMeta || activeUserMeta;
      if (merged) activeUserText = merged;
      activeUserMeta = latestMeta;
      spokenSet.clear();
      pendingSpeakers = selectGroupSpeakers({
        text: activeUserText,
        memberBots,
        excludeBotId: null,
        replyToBotId: activeUserMeta?.replyTo?.botId || null,
        maxSpeakers: 2,
      });
      return true;
    };

    while (
      (pendingSpeakers.length > 0 || groupSteers.length > 0) &&
      turnsTaken < MAX_GROUP_TURNS &&
      !control.stopped
    ) {
      applyPendingGroupSteers();
      const speaker = pendingSpeakers.shift();
      if (!speaker) continue;
      turnsTaken += 1;
      spokenSet.add(speaker.id);

      const eventsSoFar = store?.readEvents?.(groupSession.id) || [];
      let enrichedUserText = activeUserText;
      const sourcePrefixParts: string[] = [];
      const chHeader = formatMessageSourceHeader(activeUserMeta);
      if (chHeader) sourcePrefixParts.push(chHeader);
      const timeHeader = formatMessageTimeHeader(activeUserMeta);
      if (timeHeader) sourcePrefixParts.push(timeHeader);
      if (activeUserMeta?.replyTo?.snippet) {
        sourcePrefixParts.push(
          `[Replying to ${activeUserMeta.replyTo.author || "message"}: "${activeUserMeta.replyTo.snippet}"]`
        );
      }
      if (sourcePrefixParts.length > 0) {
        enrichedUserText = `${sourcePrefixParts.join("\n")}\n${enrichedUserText}`;
      }
      const groupPrompt = buildGroupPromptContext(eventsSoFar, enrichedUserText);

      const runnerWorkspaceBase =
        (Array.isArray(config?.writeRoots) && config.writeRoots[0]) ||
        (store?.dataDir ? path.join(store.dataDir, "workspaces") : "");
      const groupWorkspace = runnerWorkspaceBase
        ? resolveBotWorkspaceRoot({
            writeRoots: [runnerWorkspaceBase],
            sessionId: groupSession.id,
          })
        : "";

      const speakerExecutor = createBotScopedExecutorClient(executor, {
        botId: speaker.id,
        isAdmin: Boolean(speaker.isAdmin),
        botWorkspace: groupWorkspace,
        getMaxConcurrentScreens,
      });
      const speakerKey = speaker.isAdmin ? "__primary__" : speaker.id;
      const speakerMutex = getBotDesktopMutex(speakerKey);
      const speakerAcquireScreenLease = (opts?: AcquireScreenLeaseOptions) =>
        screenLeasePool.acquire(speakerKey, opts);

      const res = await runTaskImpl({
        sessionId: groupSession.id,
        userText: activeUserText,
        userMeta: activeUserMeta,
        promptText: groupPrompt,
        modelName,
        deps: {
          model,
          executor: speakerExecutor,
          mcpManager: sharedMcpManager,
          hostBridge: runnerApi.hostBridge || null,
          getChannelStatus: runnerApi.getChannelStatus || null,
          channelPairingActions: runnerApi.channelPairingActions || null,
          channelConfigActions: runnerApi.channelConfigActions || null,
          getRelayStatus: runnerApi.getRelayStatus || null,
          accountActions: runnerApi.accountActions || null,
          selfUpdateActions: runnerApi.selfUpdateActions || null,
          store,
          config,
          emit,
          autoRoute: runTaskImpl === runTask,
          smartRouter: runTaskImpl === runTask,
          enableBotTools: runTaskImpl === runTask,
          hopDepth,
          desktopMutex: speakerMutex,
          acquireScreenLease: speakerAcquireScreenLease,
          speakerBot: speaker,
          groupMeta: {
            title: groupSession.title,
            members: memberBots,
          },
          replyToAnchor:
            turnsTaken === 1 && userEvtSeq
              ? {
                  seq: userEvtSeq,
                  author: "你",
                  snippet: String(activeUserText || "").replace(/\s+/g, " ").slice(0, 64),
                }
              : null,
          skipUserEvent: true,
          skipHistorySave: true,
          broadcastGlobal,
          onDispatchBotTurn: enqueueOrRunBotHandoff,
          onDispatchGroupTurn: ({
            groupId,
            text: gText,
            initiatorBot: initBot,
          }: {
            groupId: string;
            text: string;
            initiatorBot?: any;
          }) => {
            if (!activeRuns.has(groupId)) {
              startInternal(groupId, gText, { initiatorBot: initBot });
            }
          },
        },
        control,
      });

      if (control.stopped) break;
      if (applyPendingGroupSteers()) {
        continue;
      }

      if (res?.text && turnsTaken < MAX_GROUP_TURNS) {
        const mentionedFollowUps = extractMentionedBots(res.text, memberBots).filter(
          (b) => b.id !== speaker.id && !spokenSet.has(b.id)
        );
        for (const nextBot of mentionedFollowUps) {
          if (!pendingSpeakers.some((p) => p.id === nextBot.id)) {
            pendingSpeakers.push(nextBot);
          }
        }
      }
    }

    if (!control.stopped) {
      emit({ type: "status", status: "done" });
    }
    return { status: control.stopped ? "stopped" : "done" };
  }

  function startInternal(sessionId: string, text: string, options: Record<string, any> = {}): void {
    if (activeRuns.has(sessionId)) {
      throw new Error("a task is already running");
    }

    const session = store?.getSession?.(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (
      !options.isBotHandoff &&
      !session.pinned &&
      session.type !== "group" &&
      (!session.title || session.title === "New Session")
    ) {
      try {
        store.updateSession(sessionId, {
          title: (text || "").slice(0, 40),
        });
      } catch {
        // ignore
      }
    }

    const currentControl = createControl();
    const groupSteers: Array<{ text: string; userMeta?: any }> = [];
    const replyListeners: Array<(res: { status?: string; text?: string; error?: string }) => void> = [];
    if (typeof options.onReplyComplete === "function") {
      replyListeners.push(options.onReplyComplete);
    }
    let replyNotified = false;
    const notifyReply = (payload: { status?: string; text?: string; error?: string }) => {
      if (replyNotified) return;
      replyNotified = true;
      for (const listener of [...replyListeners]) {
        try {
          listener(payload);
        } catch {
          // ignore reply listener errors
        }
      }
    };
    activeRuns.set(sessionId, {
      state: "running",
      control: currentControl,
      replyListeners,
      ...(session.type === "group"
        ? {
            onSteer: (msg: { text: string; userMeta: any }) => {
              groupSteers.push(msg);
            },
          }
        : {}),
    });

    const liveSettings = store?.readSettings?.() || {};
    const modelName =
      liveSettings.model ||
      resolveUtilityModels(config, Date.now(), liveSettings.routing).fallbackModel;

    function emit(event: Record<string, any>): void {
      // If this run was superseded by a newer run after stop(), suppress late events
      const currentEntry = activeRuns.get(sessionId);
      if (currentEntry && currentEntry.control !== currentControl) {
        return;
      }
      emitForSession(sessionId, event);
    }

    const isDefaultRunTask = runTaskImpl === runTask;

    const effectiveUserMeta = ensureServerSentAt(options.userMeta);

    Promise.resolve()
      .then(() => {
        if (session.type === "group" && isDefaultRunTask) {
          return runGroupConversation({
            groupSession: session,
            userText: text,
            userMeta: effectiveUserMeta,
            modelName,
            control: currentControl,
            emit,
            initiatorBot: options.initiatorBot || null,
            skipUserEvent: Boolean(options.skipUserEvent),
            hopDepth: options.hopDepth || 0,
            groupSteers,
          });
        }

        const dmIsAdmin = Boolean(session?.isAdmin);
        const runnerWorkspaceBase =
          (Array.isArray(config?.writeRoots) && config.writeRoots[0]) ||
          (store?.dataDir ? path.join(store.dataDir, "workspaces") : "");
        const dmWorkspace = runnerWorkspaceBase
          ? resolveBotWorkspaceRoot({
              writeRoots: [runnerWorkspaceBase],
              sessionId,
            })
          : "";
        const scopedExecutor = createBotScopedExecutorClient(executor, {
          botId: sessionId,
          isAdmin: dmIsAdmin,
          botWorkspace: dmWorkspace,
          getMaxConcurrentScreens,
        });
        const dmKey = dmIsAdmin ? "__primary__" : sessionId;
        const scopedMutex = getBotDesktopMutex(dmKey);
        const dmAcquireScreenLease = (opts?: AcquireScreenLeaseOptions) =>
          screenLeasePool.acquire(dmKey, opts);

        return runTaskImpl({
          sessionId,
          userText: text,
          userMeta: effectiveUserMeta,
          modelName,
          deps: {
            model,
            executor: scopedExecutor,
            store,
            config,
            emit,
            desktopMutex: scopedMutex,
            acquireScreenLease: dmAcquireScreenLease,
            ...(isDefaultRunTask
              ? {
                  mcpManager: sharedMcpManager,
                  hostBridge: runnerApi.hostBridge || null,
                  getChannelStatus: runnerApi.getChannelStatus || null,
                  channelPairingActions: runnerApi.channelPairingActions || null,
                  channelConfigActions: runnerApi.channelConfigActions || null,
                  getRelayStatus: runnerApi.getRelayStatus || null,
                  accountActions: runnerApi.accountActions || null,
                  selfUpdateActions: runnerApi.selfUpdateActions || null,
                  autoRoute: true,
                  smartRouter: true,
                  enableBotTools: true,
                  hopDepth: options.hopDepth || 0,
                  isBotHandoff: Boolean(options.isBotHandoff),
                  skipUserEvent: Boolean(options.skipUserEvent),
                  broadcastGlobal,
                  onDispatchBotTurn: enqueueOrRunBotHandoff,
                  onDispatchGroupTurn: ({
                    groupId,
                    text: gText,
                    initiatorBot,
                  }: {
                    groupId: string;
                    text: string;
                    initiatorBot?: any;
                  }) => {
                    if (!activeRuns.has(groupId)) {
                      startInternal(groupId, gText, { initiatorBot });
                    }
                  },
                }
              : {}),
          },
          control: currentControl,
        });
      })
      .then((res: any) => {
        // If this turn was triggered by an inter-bot exchange and produced a reply, record it back into the exchange sheet
        if (
          options.exchangeId &&
          options.fromBot &&
          res?.text &&
          store?.recordExchangeMessage
        ) {
          const selfBot = store.getSession(sessionId);
          if (selfBot) {
            store.recordExchangeMessage({
              exchangeId: options.exchangeId,
              fromBot: selfBot,
              toBot: options.fromBot,
              text: res.text,
            });
          }
        }
        notifyReply({ status: res?.status || "done", text: res?.text || "" });
      })
      .catch((err) => {
        emit({ type: "error", message: err?.message || String(err) });
        emit({ type: "status", status: "error" });
        notifyReply({ status: "error", error: err?.message || String(err) });
      })
      .finally(() => {
        notifyReply({ status: currentControl.stopped ? "stopped" : "done", text: "" });
        if (activeRuns.get(sessionId)?.control === currentControl) {
          activeRuns.delete(sessionId);
          const leftoverSteered =
            !currentControl.stopped &&
            typeof currentControl.consumeSteeredMessages === "function"
              ? currentControl.consumeSteeredMessages()
              : [];
          if (leftoverSteered.length > 0) {
            const mergedText = leftoverSteered
              .map((m: any) => String(m?.text || "").trim())
              .filter(Boolean)
              .join("\n\n");
            const lastMeta =
              [...leftoverSteered].reverse().find((m: any) => m?.userMeta)?.userMeta || null;
            if (mergedText || lastMeta) {
              startInternal(sessionId, mergedText, {
                userMeta: lastMeta,
                skipUserEvent: true,
              });
              return;
            }
          }
          drainSessionQueue(sessionId);
        }
      });
  }

  function start(
    sessionId: string,
    text: string,
    userMeta: any = null,
    opts?: {
      onComplete?: ((res: { status?: string; text?: string; error?: string }) => void) | null;
      isBotHandoff?: boolean;
    }
  ): void {
    return startInternal(sessionId, text, {
      userMeta,
      ...(opts?.isBotHandoff ? { isBotHandoff: true } : {}),
      ...(opts?.onComplete ? { onReplyComplete: opts.onComplete } : {}),
    });
  }

  function resolveTargetEntry(
    targetSessionId?: string
  ): [string | null, { state: string; control: ReturnType<typeof createControl> } | null] {
    if (targetSessionId && activeRuns.has(targetSessionId)) {
      return [targetSessionId, activeRuns.get(targetSessionId)!];
    }
    for (const pair of activeRuns.entries()) {
      return pair;
    }
    return [null, null];
  }

  function pause(targetSessionId?: string): void {
    const [sid, entry] = resolveTargetEntry(targetSessionId);
    if (entry && !entry.control.paused && !entry.control.stopped) {
      entry.control.pause();
      entry.state = "paused";
      if (sid) {
        emitForSession(sid, { type: "status", status: "paused" });
      }
    }
  }

  function resume(targetSessionId?: string): void {
    const [sid, entry] = resolveTargetEntry(targetSessionId);
    if (entry && entry.control.paused && !entry.control.stopped) {
      entry.control.resume();
      entry.state = "running";
      if (sid) {
        emitForSession(sid, { type: "status", status: "running" });
      }
    }
  }

  function clearSessionQueues(sessionId: string): void {
    const hadUserQ = (pendingUserQueue.get(sessionId) || []).length > 0;
    pendingUserQueue.delete(sessionId);
    pendingBotInbox.delete(sessionId);
    if (hadUserQ) {
      broadcastGlobal({
        type: "queue_updated",
        sessionId,
        queueLength: 0,
      });
    }
  }

  function stop(targetSessionId?: string): void {
    if (targetSessionId) {
      clearSessionQueues(targetSessionId);
      if (activeRuns.has(targetSessionId)) {
        const entry = activeRuns.get(targetSessionId)!;
        activeRuns.delete(targetSessionId);
        if (!entry.control.stopped) {
          entry.control.stop();
        }
        emitForSession(targetSessionId, { type: "status", status: "stopped" });
        return;
      }
      const persistedStatus = store?.getSession?.(targetSessionId)?.status;
      if (
        persistedStatus === "running" ||
        persistedStatus === "paused" ||
        persistedStatus === "awaiting_approval" ||
        persistedStatus === "awaiting_choice"
      ) {
        emitForSession(targetSessionId, { type: "status", status: "stopped" });
      }
      return;
    }
    for (const sid of new Set([...pendingUserQueue.keys(), ...pendingBotInbox.keys()])) {
      clearSessionQueues(sid);
    }
    for (const [sid, entry] of [...activeRuns.entries()]) {
      activeRuns.delete(sid);
      if (!entry.control.stopped) {
        entry.control.stop();
      }
      emitForSession(sid, { type: "status", status: "stopped" });
    }
  }

  function approve(callId: string, allowed: boolean): void {
    for (const entry of activeRuns.values()) {
      if (entry.control.hasPendingApproval?.(callId)) {
        entry.control.resolveApproval(callId, Boolean(allowed));
        return;
      }
    }
    console.warn(`[runner] approve ignored: no active run matched callId=${callId}`);
  }

  function choose(callId: string, selection: any): void {
    for (const entry of activeRuns.values()) {
      if (entry.control.hasPendingChoice?.(callId)) {
        entry.control.resolveChoice(callId, selection);
        return;
      }
    }
    console.warn(`[runner] choose ignored: no active run matched callId=${callId}`);
  }

  const runnerApi = {
    start,
    enqueue,
    recordUserMessage,
    queueStatus,
    stop,
    pause,
    resume,
    approve,
    choose,
    status,
    activeSessions,
    isSessionBusy,
    broadcastGlobal,
    subscribe,
    getScreenPoolStats: () => screenLeasePool.getStats(),
    reconcileScreenPool: () => screenLeasePool.reconcile(),
    getScreenPoolBudget: () => hostScreenBudget,
    mcpManager: sharedMcpManager,
    hostBridge: null as any,
    getChannelStatus: null as (() => Record<string, any>) | null,
    channelPairingActions: null as Record<string, any> | null,
    channelConfigActions: null as Record<string, any> | null,
    getRelayStatus: null as (() => Record<string, any>) | null,
    accountActions: null as Record<string, any> | null,
    selfUpdateActions: null as Record<string, any> | null,
  };
  return runnerApi;
}

export default { createRunner };
