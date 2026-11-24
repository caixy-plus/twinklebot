import {
  DEFAULT_TELEGRAM_API_BASE,
  decodeFeishuPbFrame,
  encodeFeishuPbFrame,
  fetchFeishuTenantAccessToken,
  isSenderAllowed,
  normalizeChannelsAuthStore,
  parseApprovalCommand,
  parseFeishuWebhookPayload,
  parseTelegramUpdate,
  resolveFeishuApiBase,
  sanitizeChannelApiBaseUrl,
  sanitizeFeishuChannelConfig,
  sanitizeTelegramChannelConfig,
  sendFeishuMessage,
  sendTelegramMessage,
  testFeishuChannel,
  testTelegramChannel,
  timingSafeEqualStr,
  type ChannelSkillId,
  type FeishuChannelConfig,
  type FeishuPbFrame,
  type ParsedInboundChannelMessage,
  type TelegramChannelConfig,
} from "./channel-integrations.js";

export interface ChannelRuntimeState {
  connected: boolean;
  status: "stopped" | "connecting" | "connected" | "webhook_ready" | "error";
  mode: string;
  botName: string;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface CreateChannelManagerOptions {
  store: any;
  runner: any;
  getInstalledSkills: () => string[];
  fetchImpl?: typeof fetch;
}

interface PendingChannelApproval {
  sessionId: string;
  callId: string;
  toolName: string;
}

interface ActiveChannelTurn {
  channel: ChannelSkillId;
  chatId: string;
  sessionId: string;
  buffer: string[];
  lastError: string;
  delivered: boolean;
  choiceNotified: boolean;
  donePromise: Promise<void>;
  resolveDone: () => void;
}

interface FeishuSplitBuffer {
  createdAt: number;
  total: number;
  parts: Array<Buffer | undefined>;
}

const MAX_DEDUP_IDS = 500;
const TERMINAL_SESSION_STATUSES = new Set([
  "done",
  "max_steps",
  "completed",
  "idle",
  "error",
  "stopped",
]);

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function getHeaderVal(frame: FeishuPbFrame, key: string): string {
  const hit = frame.headers.find((h) => h.key === key);
  return hit ? hit.value : "";
}

export function createChannelManager({
  store,
  runner,
  getInstalledSkills,
  fetchImpl = fetch,
}: CreateChannelManagerOptions) {
  const seenEventIds: string[] = [];
  const seenEventSet = new Set<string>();
  const pendingApprovals = new Map<string, PendingChannelApproval>();
  const activeTurns = new Map<string, ActiveChannelTurn>();
  const sessionChains = new Map<string, Promise<void>>();
  const feishuSplitBuffers = new Map<string, FeishuSplitBuffer>();

  const runtimeState: Record<ChannelSkillId, ChannelRuntimeState> = {
    "telegram-bot": {
      connected: false,
      status: "stopped",
      mode: "polling",
      botName: "",
      lastEventAt: null,
      lastError: null,
    },
    "feishu-bot": {
      connected: false,
      status: "stopped",
      mode: "websocket",
      botName: "",
      lastEventAt: null,
      lastError: null,
    },
  };

  let tgAbort: AbortController | null = null;
  let tgOffset = 0;
  let lastTgBotToken = "";
  let fsWs: WebSocket | null = null;
  let fsEndpointAbort: AbortController | null = null;
  let fsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let fsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let fsConnEpoch = 0;
  let fsStopping = false;
  let fsTokenCache: { key: string; token: string; expiresAt: number } | null = null;
  let unsubscribeRunner: (() => void) | null = null;

  function markEventSeen(eventId: string): boolean {
    if (seenEventSet.has(eventId)) return false;
    seenEventSet.add(eventId);
    seenEventIds.push(eventId);
    if (seenEventIds.length > MAX_DEDUP_IDS) {
      const oldest = seenEventIds.shift();
      if (oldest) seenEventSet.delete(oldest);
    }
    return true;
  }

  function clearPendingApprovalsForSession(sessionId: string, matchCallId?: string): void {
    for (const [key, entry] of pendingApprovals.entries()) {
      if (entry.sessionId === sessionId && (!matchCallId || entry.callId === matchCallId)) {
        pendingApprovals.delete(key);
      }
    }
  }

  function readConfigs() {
    return normalizeChannelsAuthStore(store?.readChannelsAuth?.() || {});
  }

  async function getFeishuToken(cfg: FeishuChannelConfig): Promise<string> {
    const cacheKey = `${cfg.appId}:${cfg.domain}:${cfg.apiBaseUrl}`;
    if (
      fsTokenCache &&
      fsTokenCache.key === cacheKey &&
      fsTokenCache.expiresAt > Date.now() + 60_000
    ) {
      return fsTokenCache.token;
    }
    const { token, expireSec } = await fetchFeishuTenantAccessToken(cfg, fetchImpl);
    fsTokenCache = {
      key: cacheKey,
      token,
      expiresAt: Date.now() + expireSec * 1000,
    };
    return token;
  }

  async function sendChannelReply(
    channel: ChannelSkillId,
    chatId: string,
    text: string
  ): Promise<void> {
    const configs = readConfigs();
    if (channel === "telegram-bot") {
      await sendTelegramMessage(configs["telegram-bot"], chatId, text, fetchImpl);
    } else {
      const fsCfg = configs["feishu-bot"];
      await sendFeishuMessage(
        fsCfg,
        chatId,
        text,
        () => getFeishuToken(fsCfg),
        fetchImpl
      );
    }
  }

  function resolveTargetSessionId(preferredId: string): string {
    if (preferredId && store?.getSession?.(preferredId)) {
      return preferredId;
    }
    const sessions = store?.listSessions?.() || [];
    const admin = sessions.find((s: any) => s?.isAdmin);
    if (admin?.id) return admin.id;
    if (sessions[0]?.id) return sessions[0].id;
    const ensured = store?.ensureAdminBot?.();
    if (ensured?.id) return ensured.id;
    const created = store?.createSession?.({ title: "Twinkle", isAdmin: true });
    return created.id;
  }

  function invokeRunnerApprove(callId: string, allowed: boolean): Promise<any> {
    if (typeof runner?.approve !== "function") return Promise.resolve();
    return Promise.resolve(runner.approve(callId, Boolean(allowed)));
  }

  function ensureRunnerSubscribed(): void {
    if (unsubscribeRunner || typeof runner?.subscribe !== "function") return;
    unsubscribeRunner = runner.subscribe((event: any) => {
      if (!event || !event.sessionId) return;

      if (event.type === "approval" && event.callId) {
        clearPendingApprovalsForSession(event.sessionId, event.callId);
      }

      const turn = activeTurns.get(event.sessionId);
      if (!turn) {
        if (event.type === "status" && TERMINAL_SESSION_STATUSES.has(String(event.status || ""))) {
          clearPendingApprovalsForSession(event.sessionId);
        }
        return;
      }

      if (event.type === "approval_request" && event.callId) {
        const configs = readConfigs();
        const cfg = configs[turn.channel];
        const key = `${turn.channel}:${turn.chatId}`;
        if (cfg.approvalMode === "app_only") {
          void invokeRunnerApprove(event.callId, false);
          void sendChannelReply(
            turn.channel,
            turn.chatId,
            `🛡️ 高危操作（${event.name || "tool"}）已按策略自动拒绝，请在 TwinkleBot App 中执行或审批。`
          ).catch(() => {});
        } else {
          pendingApprovals.set(key, {
            sessionId: event.sessionId,
            callId: event.callId,
            toolName: String(event.name || "tool"),
          });
          void sendChannelReply(
            turn.channel,
            turn.chatId,
            `⚠️ 需要你的确认\n操作：${event.name || "tool"}\n说明：${event.reason || "涉及高风险操作"}\n\n请直接回复「允许」/「/approve」执行，回复「拒绝」/「/deny」取消（也可在 TwinkleBot App 中同步审批）。`
          ).catch(() => {});
        }
        return;
      }

      if (event.type === "status" && event.status === "awaiting_choice" && !turn.choiceNotified) {
        turn.choiceNotified = true;
        void sendChannelReply(
          turn.channel,
          turn.chatId,
          "🔔 当前任务需要你在 TwinkleBot App 中完成交互选择、草稿确认或填写安全凭据。"
        ).catch(() => {});
        return;
      }

      if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
        turn.lastError = event.message.trim();
        return;
      }

      if (
        (event.type === "answer" || event.type === "assistant_message") &&
        typeof event.text === "string" &&
        event.text.trim()
      ) {
        turn.buffer.push(event.text.trim());
        return;
      }

      if (
        event.type === "route_notice" &&
        event.level === "max_steps" &&
        typeof event.text === "string" &&
        event.text.trim()
      ) {
        turn.buffer.push(event.text.trim());
        return;
      }

      if (event.type === "status" && TERMINAL_SESSION_STATUSES.has(String(event.status || ""))) {
        clearPendingApprovalsForSession(event.sessionId);
        if (!turn.delivered) {
          turn.delivered = true;
          activeTurns.delete(event.sessionId);
          const replyText =
            turn.buffer.join("\n\n").trim() ||
            (event.status === "error"
              ? `执行任务时发生错误${turn.lastError ? `：${turn.lastError}` : "，请在 TwinkleBot App 查看详情。"}`
              : event.status === "stopped"
                ? "任务已停止。"
                : "");
          if (replyText) {
            void sendChannelReply(turn.channel, turn.chatId, replyText)
              .catch(() => {})
              .finally(() => turn.resolveDone());
          } else {
            turn.resolveDone();
          }
        }
      }
    });
  }

  async function waitUntilSessionIdle(sessionId: string, maxWaitMs = 60_000): Promise<void> {
    if (typeof runner?.isSessionBusy !== "function") return;
    const deadline = Date.now() + maxWaitMs;
    while (runner.isSessionBusy(sessionId) && Date.now() < deadline) {
      await sleepMs(60);
    }
  }

  function enqueueSessionChannelTurn(
    sessionId: string,
    msg: ParsedInboundChannelMessage
  ): Promise<void> {
    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const prevChain = sessionChains.get(sessionId) || Promise.resolve();
    const nextChain = prevChain
      .catch(() => {})
      .then(async () => {
        await waitUntilSessionIdle(sessionId, 60_000);
        ensureRunnerSubscribed();

        const turn: ActiveChannelTurn = {
          channel: msg.channel,
          chatId: msg.chatId,
          sessionId,
          buffer: [],
          lastError: "",
          delivered: false,
          choiceNotified: false,
          donePromise,
          resolveDone,
        };
        activeTurns.set(sessionId, turn);

        // Safety timer so a stalled mock/session cannot permanently block subsequent turns
        const safetyTimer = setTimeout(() => {
          if (activeTurns.get(sessionId) === turn) {
            activeTurns.delete(sessionId);
          }
          resolveDone();
        }, 5 * 60_000);
        safetyTimer.unref?.();

        const userMeta = {
          clientSource: {
            deviceKind: "mobile" as const,
            platform: msg.channel,
          },
          channelMeta: {
            channel: msg.channel,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderName: msg.senderName,
          },
        };

        try {
          if (typeof runner?.enqueue === "function") {
            await runner.enqueue(sessionId, msg.text, userMeta);
          } else if (typeof runner?.start === "function") {
            await runner.start(sessionId, msg.text, userMeta);
          } else {
            activeTurns.delete(sessionId);
            resolveDone();
          }
          await donePromise;
        } catch (err: any) {
          if (activeTurns.get(sessionId) === turn) {
            activeTurns.delete(sessionId);
          }
          void sendChannelReply(
            msg.channel,
            msg.chatId,
            `执行任务失败：${err?.message || String(err)}`
          ).catch(() => {});
          resolveDone();
        } finally {
          clearTimeout(safetyTimer);
        }
      });

    sessionChains.set(sessionId, nextChain);
    return donePromise;
  }

  async function handleInboundMessage(
    msg: ParsedInboundChannelMessage
  ): Promise<{ handled: boolean; rejected?: boolean; reason?: string }> {
    if (!markEventSeen(msg.eventId)) {
      return { handled: false, reason: "duplicate" };
    }
    const configs = readConfigs();
    const installed = getInstalledSkills();
    if (!installed.includes(msg.channel)) {
      return { handled: false, reason: "skill_not_installed" };
    }
    const cfg = configs[msg.channel];
    if (!cfg.enabled) {
      return { handled: false, reason: "channel_disabled" };
    }

    runtimeState[msg.channel].lastEventAt = new Date().toISOString();

    if (!isSenderAllowed(cfg.allowedSenderIds, [msg.senderId, msg.chatId])) {
      void sendChannelReply(
        msg.channel,
        msg.chatId,
        `🔒 未授权发送者：请先在 TwinkleBot「技能商店 → ${
          msg.channel === "feishu-bot" ? "飞书机器人" : "Telegram 机器人"
        }」白名单中添加你的 ID：${msg.senderId}（会话 ID：${msg.chatId}）`
      ).catch(() => {});
      return { handled: false, rejected: true, reason: "unauthorized_sender" };
    }

    const pendingKey = `${msg.channel}:${msg.chatId}`;
    const pending = pendingApprovals.get(pendingKey);
    if (pending) {
      const decision = parseApprovalCommand(msg.text);
      if (decision !== null) {
        pendingApprovals.delete(pendingKey);
        const runningTurn = activeTurns.get(pending.sessionId);
        await invokeRunnerApprove(pending.callId, decision);
        await sendChannelReply(
          msg.channel,
          msg.chatId,
          decision
            ? `✅ 已允许执行：${pending.toolName}`
            : `❌ 已拒绝执行：${pending.toolName}`
        ).catch(() => {});
        if (runningTurn) {
          await Promise.race([runningTurn.donePromise, sleepMs(150)]);
        }
        return { handled: true };
      }
    }

    const sessionId = resolveTargetSessionId(cfg.defaultSessionId);
    const donePromise = enqueueSessionChannelTurn(sessionId, msg);
    // Allow fast/mock runs to flush synchronously while returning quickly (<150ms) for long LLM runs
    await Promise.race([donePromise, sleepMs(150)]);
    return { handled: true };
  }

  function stopTelegramPolling(): void {
    if (tgAbort) {
      tgAbort.abort();
      tgAbort = null;
    }
  }

  function startTelegramPolling(cfg: TelegramChannelConfig): void {
    stopTelegramPolling();
    if (cfg.botToken !== lastTgBotToken) {
      tgOffset = 0;
      lastTgBotToken = cfg.botToken;
    }
    const abort = new AbortController();
    tgAbort = abort;
    runtimeState["telegram-bot"] = {
      ...runtimeState["telegram-bot"],
      connected: true,
      status: "connected",
      mode: "polling",
      lastError: null,
    };
    const base = sanitizeChannelApiBaseUrl(cfg.apiBaseUrl, DEFAULT_TELEGRAM_API_BASE);

    const loop = async () => {
      let backoffMs = 1500;
      while (!abort.signal.aborted) {
        try {
          const url = `${base}/bot${encodeURIComponent(cfg.botToken)}/getUpdates?timeout=25&offset=${tgOffset}`;
          const reqSignal =
            typeof AbortSignal?.any === "function" && typeof AbortSignal?.timeout === "function"
              ? AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)])
              : abort.signal;
          const resp = await fetchImpl(url, { method: "GET", signal: reqSignal });
          const data: any = await resp.json().catch(() => ({}));
          if (abort.signal.aborted) break;
          if (!resp.ok || !data?.ok) {
            throw new Error(data?.description || `HTTP ${resp.status}`);
          }
          backoffMs = 1500;
          runtimeState["telegram-bot"].connected = true;
          runtimeState["telegram-bot"].status = "connected";
          runtimeState["telegram-bot"].lastError = null;
          const updates = Array.isArray(data.result) ? data.result : [];
          for (const upd of updates) {
            if (typeof upd?.update_id === "number" && upd.update_id >= tgOffset) {
              tgOffset = upd.update_id + 1;
            }
            const parsed = parseTelegramUpdate(upd);
            if (parsed) {
              void handleInboundMessage(parsed).catch(() => {});
            }
          }
        } catch (err: any) {
          if (abort.signal.aborted) break;
          runtimeState["telegram-bot"].connected = false;
          runtimeState["telegram-bot"].status = "error";
          runtimeState["telegram-bot"].lastError = err?.message || String(err);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, backoffMs);
            t.unref?.();
            abort.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true }
            );
          });
          backoffMs = Math.min(30_000, backoffMs * 2);
        }
      }
    };
    void loop();
  }

  function stopFeishuWebSocket(): void {
    fsStopping = true;
    fsConnEpoch += 1;
    if (fsEndpointAbort) {
      fsEndpointAbort.abort();
      fsEndpointAbort = null;
    }
    if (fsReconnectTimer) {
      clearTimeout(fsReconnectTimer);
      fsReconnectTimer = null;
    }
    if (fsHeartbeatTimer) {
      clearInterval(fsHeartbeatTimer);
      fsHeartbeatTimer = null;
    }
    if (fsWs) {
      try {
        fsWs.close();
      } catch {
        // ignore
      }
      fsWs = null;
    }
    feishuSplitBuffers.clear();
  }

  function reassembleFeishuPayload(frame: FeishuPbFrame): Buffer | null {
    const raw = frame.payload || Buffer.alloc(0);
    const sum = Number(getHeaderVal(frame, "sum") || "1");
    const seq = Number(getHeaderVal(frame, "seq") || "0");
    const msgId = getHeaderVal(frame, "message_id");
    if (!Number.isFinite(sum) || sum <= 1 || !msgId) {
      return raw;
    }
    const now = Date.now();
    for (const [k, entry] of feishuSplitBuffers.entries()) {
      if (now - entry.createdAt > 15_000) feishuSplitBuffers.delete(k);
    }
    let state = feishuSplitBuffers.get(msgId);
    if (!state || state.total !== sum) {
      state = { createdAt: now, total: sum, parts: Array.from({ length: sum }, () => undefined) };
      feishuSplitBuffers.set(msgId, state);
    }
    if (seq >= 0 && seq < sum) {
      state.parts[seq] = raw;
    }
    if (state.parts.every((p) => Buffer.isBuffer(p))) {
      feishuSplitBuffers.delete(msgId);
      return Buffer.concat(state.parts as Buffer[]);
    }
    return null;
  }

  async function extractWsBinaryOrText(
    rawData: unknown
  ): Promise<{ kind: "text"; text: string } | { kind: "binary"; buf: Buffer } | null> {
    if (typeof rawData === "string") {
      return { kind: "text", text: rawData };
    }
    if (Buffer.isBuffer(rawData)) {
      return { kind: "binary", buf: rawData };
    }
    if (rawData instanceof ArrayBuffer) {
      return { kind: "binary", buf: Buffer.from(rawData) };
    }
    if (ArrayBuffer.isView(rawData)) {
      return {
        kind: "binary",
        buf: Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength),
      };
    }
    if (rawData && typeof (rawData as Blob).arrayBuffer === "function") {
      const ab = await (rawData as Blob).arrayBuffer();
      return { kind: "binary", buf: Buffer.from(ab) };
    }
    return null;
  }

  function startFeishuWebSocket(cfg: FeishuChannelConfig): void {
    stopFeishuWebSocket();
    fsStopping = false;
    const myEpoch = ++fsConnEpoch;
    runtimeState["feishu-bot"] = {
      ...runtimeState["feishu-bot"],
      connected: false,
      status: "connecting",
      mode: "websocket",
      lastError: null,
    };

    const connectOnce = async () => {
      if (fsStopping || myEpoch !== fsConnEpoch) return;
      const endpointCtrl = new AbortController();
      fsEndpointAbort = endpointCtrl;
      try {
        const base = resolveFeishuApiBase(cfg);
        const resp = await fetchImpl(`${base}/callback/ws/endpoint`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
          signal: endpointCtrl.signal,
        });
        const data: any = await resp.json().catch(() => ({}));
        if (fsStopping || myEpoch !== fsConnEpoch) return;
        const wsUrl = String(data?.data?.URL || data?.URL || "").trim();
        if (!resp.ok || !wsUrl) {
          throw new Error(data?.msg || `Feishu WS endpoint failed (HTTP ${resp.status})`);
        }

        let serviceId = 0;
        try {
          serviceId = Number(new URL(wsUrl).searchParams.get("service_id") || "0") || 0;
        } catch {
          serviceId = 0;
        }
        const rawPingSec = Number(
          data?.data?.ClientConfig?.PingInterval ?? data?.ClientConfig?.PingInterval ?? 90
        );
        const pingIntervalMs = Math.max(15, Math.min(300, Number.isFinite(rawPingSec) ? rawPingSec : 90)) * 1000;

        const WSImpl = globalThis.WebSocket;
        if (typeof WSImpl !== "function") {
          throw new Error("Global WebSocket unavailable");
        }
        const ws = new WSImpl(wsUrl);
        try {
          ws.binaryType = "arraybuffer";
        } catch {
          // ignore if custom mock WS has read-only binaryType
        }
        fsWs = ws;

        ws.addEventListener("open", () => {
          if (fsStopping || myEpoch !== fsConnEpoch) {
            try {
              ws.close();
            } catch {}
            return;
          }
          runtimeState["feishu-bot"].connected = true;
          runtimeState["feishu-bot"].status = "connected";
          runtimeState["feishu-bot"].lastError = null;

          if (fsHeartbeatTimer) clearInterval(fsHeartbeatTimer);
          fsHeartbeatTimer = setInterval(() => {
            if (ws.readyState !== 1) return;
            try {
              const pingFrame = encodeFeishuPbFrame({
                seqId: 0n,
                logId: 0n,
                service: serviceId,
                method: 0,
                headers: [{ key: "type", value: "ping" }],
              });
              ws.send(new Uint8Array(pingFrame));
            } catch {
              // ignore transient send error
            }
          }, pingIntervalMs);
          fsHeartbeatTimer.unref?.();
        });

        ws.addEventListener("message", (evt: any) => {
          void (async () => {
            try {
              const extracted = await extractWsBinaryOrText(evt?.data);
              if (!extracted) return;

              if (extracted.kind === "text") {
                const payload = JSON.parse(extracted.text);
                const parsed = parseFeishuWebhookPayload(payload, cfg, {
                  requireVerificationToken: false,
                  requireEncryptionIfConfigured: false,
                });
                if (parsed.kind === "message") {
                  await handleInboundMessage(parsed.message);
                }
                return;
              }

              const startedAt = Date.now();
              const frame = decodeFeishuPbFrame(extracted.buf);
              if (frame.method === 0) {
                // Control frame (pong / config update)
                return;
              }
              const msgType = getHeaderVal(frame, "type");
              const combined = reassembleFeishuPayload(frame);
              if (!combined) return; // awaiting remaining fragments

              // Acknowledge DATA frame within Feishu's 3-second SLA before running LLM work
              if (ws.readyState === 1) {
                const ackPayload = Buffer.from(JSON.stringify({ code: 200 }), "utf8");
                const ackFrame = encodeFeishuPbFrame({
                  seqId: frame.seqId,
                  logId: frame.logId,
                  service: frame.service || serviceId,
                  method: frame.method,
                  headers: [
                    ...frame.headers,
                    { key: "biz_rt", value: String(Math.max(1, Date.now() - startedAt)) },
                  ],
                  payload: ackPayload,
                  ...(frame.logIdNew ? { logIdNew: frame.logIdNew } : {}),
                });
                try {
                  ws.send(new Uint8Array(ackFrame));
                } catch {
                  // ignore send error
                }
              }

              if (msgType && msgType !== "event") return;
              if (combined.length === 0) return;

              const payload = JSON.parse(combined.toString("utf8"));
              const parsed = parseFeishuWebhookPayload(payload, cfg, {
                requireVerificationToken: false,
                requireEncryptionIfConfigured: false,
              });
              if (parsed.kind === "message") {
                await handleInboundMessage(parsed.message);
              }
            } catch {
              // ignore malformed or control frames
            }
          })();
        });

        ws.addEventListener("close", () => {
          if (fsHeartbeatTimer) {
            clearInterval(fsHeartbeatTimer);
            fsHeartbeatTimer = null;
          }
          if (myEpoch !== fsConnEpoch) return;
          runtimeState["feishu-bot"].connected = false;
          if (!fsStopping) {
            runtimeState["feishu-bot"].status = "connecting";
            fsReconnectTimer = setTimeout(() => void connectOnce(), 5000);
            fsReconnectTimer.unref?.();
          }
        });

        ws.addEventListener("error", () => {
          if (myEpoch !== fsConnEpoch) return;
          runtimeState["feishu-bot"].connected = false;
          runtimeState["feishu-bot"].status = "error";
          runtimeState["feishu-bot"].lastError = "Feishu WebSocket connection error";
        });
      } catch (err: any) {
        if (fsStopping || myEpoch !== fsConnEpoch) return;
        runtimeState["feishu-bot"].connected = false;
        runtimeState["feishu-bot"].status = "error";
        runtimeState["feishu-bot"].lastError = err?.message || String(err);
        fsReconnectTimer = setTimeout(() => void connectOnce(), 10_000);
        fsReconnectTimer.unref?.();
      }
    };
    void connectOnce();
  }

  function syncFromStore(): void {
    const configs = readConfigs();
    const installed = getInstalledSkills();

    // Telegram
    const tgCfg = configs["telegram-bot"];
    if (installed.includes("telegram-bot") && tgCfg.enabled && tgCfg.botToken) {
      if (tgCfg.connectionMode === "polling") {
        startTelegramPolling(tgCfg);
      } else {
        stopTelegramPolling();
        runtimeState["telegram-bot"] = {
          ...runtimeState["telegram-bot"],
          connected: Boolean(tgCfg.webhookSecret),
          status: tgCfg.webhookSecret ? "webhook_ready" : "error",
          mode: "webhook",
          lastError: tgCfg.webhookSecret ? null : "Webhook Secret 未配置",
        };
      }
    } else {
      stopTelegramPolling();
      runtimeState["telegram-bot"] = {
        ...runtimeState["telegram-bot"],
        connected: false,
        status: "stopped",
        mode: tgCfg.connectionMode,
      };
    }

    // Feishu
    const fsCfg = configs["feishu-bot"];
    if (installed.includes("feishu-bot") && fsCfg.enabled && fsCfg.appId && fsCfg.appSecret) {
      if (fsCfg.connectionMode === "websocket") {
        startFeishuWebSocket(fsCfg);
      } else {
        stopFeishuWebSocket();
        runtimeState["feishu-bot"] = {
          ...runtimeState["feishu-bot"],
          connected: Boolean(fsCfg.verificationToken),
          status: fsCfg.verificationToken ? "webhook_ready" : "error",
          mode: "webhook",
          lastError: fsCfg.verificationToken ? null : "Verification Token 未配置",
        };
      }
    } else {
      stopFeishuWebSocket();
      runtimeState["feishu-bot"] = {
        ...runtimeState["feishu-bot"],
        connected: false,
        status: "stopped",
        mode: fsCfg.connectionMode,
      };
    }
  }

  function getStatusPayload() {
    const configs = readConfigs();
    return {
      "telegram-bot": {
        config: sanitizeTelegramChannelConfig(configs["telegram-bot"]),
        runtime: { ...runtimeState["telegram-bot"] },
        webhookPath: "/api/channels/telegram/webhook",
      },
      "feishu-bot": {
        config: sanitizeFeishuChannelConfig(configs["feishu-bot"]),
        runtime: { ...runtimeState["feishu-bot"] },
        webhookPath: "/api/channels/feishu/webhook",
      },
    };
  }

  async function handleTelegramWebhook(
    body: any,
    headers: Record<string, string | string[] | undefined>
  ): Promise<{ status: number; body: Record<string, any> }> {
    const configs = readConfigs();
    const cfg = configs["telegram-bot"];
    if (!getInstalledSkills().includes("telegram-bot") || !cfg.enabled) {
      return { status: 403, body: { ok: false, error: "telegram-bot channel is disabled" } };
    }
    if (cfg.connectionMode !== "webhook") {
      return {
        status: 403,
        body: { ok: false, error: "telegram-bot webhook mode is not active" },
      };
    }
    if (!cfg.webhookSecret) {
      return {
        status: 401,
        body: { ok: false, error: "telegram webhook secret is not configured" },
      };
    }
    const supplied = String(headers["x-telegram-bot-api-secret-token"] || "").trim();
    if (!timingSafeEqualStr(supplied, cfg.webhookSecret)) {
      return { status: 401, body: { ok: false, error: "invalid telegram webhook secret" } };
    }
    const parsed = parseTelegramUpdate(body);
    if (!parsed) {
      return { status: 200, body: { ok: true, ignored: true } };
    }
    const outcome = await handleInboundMessage(parsed);
    return { status: 200, body: { ok: true, ...outcome } };
  }

  async function handleFeishuWebhook(
    body: any
  ): Promise<{ status: number; body: Record<string, any> }> {
    const configs = readConfigs();
    const cfg = configs["feishu-bot"];
    if (!getInstalledSkills().includes("feishu-bot")) {
      return { status: 403, body: { ok: false, error: "feishu-bot skill is not installed" } };
    }
    if (cfg.connectionMode !== "webhook") {
      return {
        status: 403,
        body: { ok: false, error: "feishu-bot webhook mode is not active" },
      };
    }
    if (!cfg.verificationToken) {
      return {
        status: 401,
        body: { ok: false, error: "feishu verificationToken is not configured" },
      };
    }
    let parsed: ReturnType<typeof parseFeishuWebhookPayload>;
    try {
      parsed = parseFeishuWebhookPayload(body, cfg, {
        requireVerificationToken: true,
        requireEncryptionIfConfigured: true,
      });
    } catch (err: any) {
      return { status: 401, body: { ok: false, error: err?.message || "invalid feishu event" } };
    }
    if (parsed.kind === "challenge") {
      return { status: 200, body: { challenge: parsed.challenge } };
    }
    if (!cfg.enabled) {
      return { status: 403, body: { ok: false, error: "feishu-bot channel is disabled" } };
    }
    if (parsed.kind === "ignore") {
      return { status: 200, body: { ok: true, ignored: true } };
    }
    const outcome = await handleInboundMessage(parsed.message);
    return { status: 200, body: { ok: true, ...outcome } };
  }

  async function testChannel(
    channelId: ChannelSkillId,
    overrideRaw?: Record<string, any>
  ) {
    const configs = readConfigs();
    if (channelId === "telegram-bot") {
      const stored = configs["telegram-bot"];
      const overrideBase =
        typeof overrideRaw?.apiBaseUrl === "string" && overrideRaw.apiBaseUrl.trim()
          ? sanitizeChannelApiBaseUrl(overrideRaw.apiBaseUrl, "")
          : "";
      if (overrideRaw?.apiBaseUrl && !overrideBase) {
        return { ok: false, error: "不安全的自定义 Telegram API Base URL（仅允许公网 HTTPS 或本机回环）" };
      }
      const explicitToken =
        typeof overrideRaw?.botToken === "string" ? overrideRaw.botToken.trim() : "";
      // Prevent exfiltrating stored decrypted token to an overridden apiBaseUrl
      if (overrideBase && overrideBase !== stored.apiBaseUrl && !explicitToken) {
        return {
          ok: false,
          error: "修改 API Base URL 测试连接时必须同时重新填写 Bot Token",
        };
      }
      const merged = {
        ...stored,
        ...(explicitToken ? { botToken: explicitToken } : {}),
        ...(overrideBase ? { apiBaseUrl: overrideBase } : {}),
      };
      const res = await testTelegramChannel(merged, fetchImpl);
      if (res.ok && res.botName) {
        runtimeState["telegram-bot"].botName = res.botName;
      }
      return res;
    }

    const stored = configs["feishu-bot"];
    const overrideBase =
      typeof overrideRaw?.apiBaseUrl === "string" && overrideRaw.apiBaseUrl.trim()
        ? sanitizeChannelApiBaseUrl(overrideRaw.apiBaseUrl, "")
        : "";
    if (overrideRaw?.apiBaseUrl && !overrideBase) {
      return { ok: false, error: "不安全的自定义飞书 API Base URL（仅允许公网 HTTPS 或本机回环）" };
    }
    const explicitSecret =
      typeof overrideRaw?.appSecret === "string" ? overrideRaw.appSecret.trim() : "";
    const overrideDomain =
      overrideRaw?.domain === "lark" || overrideRaw?.domain === "feishu"
        ? overrideRaw.domain
        : stored.domain;
    if (
      ((overrideBase && overrideBase !== stored.apiBaseUrl) || overrideDomain !== stored.domain) &&
      !explicitSecret &&
      stored.appSecret
    ) {
      if (overrideBase && overrideBase !== stored.apiBaseUrl) {
        return {
          ok: false,
          error: "修改自定义飞书 API 地址测试连接时必须同时重新填写 App Secret",
        };
      }
    }
    const merged = {
      ...stored,
      ...(overrideRaw?.appId ? { appId: String(overrideRaw.appId).trim() } : {}),
      ...(explicitSecret ? { appSecret: explicitSecret } : {}),
      domain: overrideDomain,
      ...(overrideBase ? { apiBaseUrl: overrideBase } : {}),
    };
    const res = await testFeishuChannel(merged, fetchImpl);
    if (res.ok && res.botName) {
      runtimeState["feishu-bot"].botName = res.botName;
    }
    return res;
  }

  function stopChannel(channelId: ChannelSkillId): void {
    if (channelId === "telegram-bot") {
      stopTelegramPolling();
      runtimeState["telegram-bot"].connected = false;
      runtimeState["telegram-bot"].status = "stopped";
    } else {
      stopFeishuWebSocket();
      runtimeState["feishu-bot"].connected = false;
      runtimeState["feishu-bot"].status = "stopped";
    }
  }

  function stopAll(): void {
    stopTelegramPolling();
    stopFeishuWebSocket();
    if (unsubscribeRunner) {
      try {
        unsubscribeRunner();
      } catch {}
      unsubscribeRunner = null;
    }
    pendingApprovals.clear();
    for (const turn of activeTurns.values()) {
      turn.resolveDone();
    }
    activeTurns.clear();
    sessionChains.clear();
  }

  return {
    syncFromStore,
    getStatusPayload,
    handleTelegramWebhook,
    handleFeishuWebhook,
    handleInboundMessage,
    testChannel,
    stopChannel,
    stopAll,
  };
}
