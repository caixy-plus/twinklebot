import {
  DEFAULT_TELEGRAM_API_BASE,
  fetchFeishuTenantAccessToken,
  isSenderAllowed,
  normalizeChannelsAuthStore,
  parseApprovalCommand,
  parseFeishuWebhookPayload,
  parseTelegramUpdate,
  resolveFeishuApiBase,
  sanitizeFeishuChannelConfig,
  sanitizeTelegramChannelConfig,
  sendFeishuMessage,
  sendTelegramMessage,
  testFeishuChannel,
  testTelegramChannel,
  type ChannelSkillId,
  type FeishuChannelConfig,
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
  delivered: boolean;
}

const MAX_DEDUP_IDS = 500;

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
  let fsWs: WebSocket | null = null;
  let fsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let fsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
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

  function ensureRunnerSubscribed(): void {
    if (unsubscribeRunner || typeof runner?.subscribe !== "function") return;
    unsubscribeRunner = runner.subscribe((event: any) => {
      if (!event || !event.sessionId) return;
      const turn = activeTurns.get(event.sessionId);
      if (!turn) return;

      if (event.type === "approval_request" && event.callId) {
        const configs = readConfigs();
        const cfg = configs[turn.channel];
        const key = `${turn.channel}:${turn.chatId}`;
        if (cfg.approvalMode === "app_only") {
          void runner?.approve?.(event.sessionId, event.callId, false);
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

      if (event.type === "approval" && event.callId) {
        const key = `${turn.channel}:${turn.chatId}`;
        const pending = pendingApprovals.get(key);
        if (pending && pending.callId === event.callId) {
          pendingApprovals.delete(key);
        }
        return;
      }

      if (event.type === "assistant_message" && typeof event.text === "string" && event.text.trim()) {
        turn.buffer.push(event.text.trim());
        return;
      }

      if (
        event.type === "status" &&
        (event.status === "completed" ||
          event.status === "idle" ||
          event.status === "error" ||
          event.status === "stopped")
      ) {
        if (!turn.delivered) {
          turn.delivered = true;
          activeTurns.delete(event.sessionId);
          const replyText =
            turn.buffer.join("\n\n").trim() ||
            (event.status === "error"
              ? "执行任务时发生错误，请在 TwinkleBot App 查看详情。"
              : event.status === "stopped"
                ? "任务已停止。"
                : "");
          if (replyText) {
            void sendChannelReply(turn.channel, turn.chatId, replyText).catch(() => {});
          }
        }
      }
    });
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
        await runner?.approve?.(pending.sessionId, pending.callId, decision);
        await sendChannelReply(
          msg.channel,
          msg.chatId,
          decision
            ? `✅ 已允许执行：${pending.toolName}`
            : `❌ 已拒绝执行：${pending.toolName}`
        ).catch(() => {});
        return { handled: true };
      }
    }

    ensureRunnerSubscribed();
    const sessionId = resolveTargetSessionId(cfg.defaultSessionId);
    activeTurns.set(sessionId, {
      channel: msg.channel,
      chatId: msg.chatId,
      sessionId,
      buffer: [],
      delivered: false,
    });

    const userMeta = {
      clientSource: {
        deviceKind: "mobile",
        platform: msg.channel,
      },
      channelMeta: {
        channel: msg.channel,
        chatId: msg.chatId,
        senderId: msg.senderId,
        senderName: msg.senderName,
      },
    };

    if (typeof runner?.start === "function") {
      await runner.start(sessionId, msg.text, userMeta);
    } else if (typeof runner?.enqueue === "function") {
      await runner.enqueue(sessionId, msg.text, userMeta);
    }
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
    const abort = new AbortController();
    tgAbort = abort;
    runtimeState["telegram-bot"] = {
      ...runtimeState["telegram-bot"],
      connected: true,
      status: "connected",
      mode: "polling",
      lastError: null,
    };
    const base = (cfg.apiBaseUrl || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");

    const loop = async () => {
      let backoffMs = 1500;
      while (!abort.signal.aborted) {
        try {
          const url = `${base}/bot${encodeURIComponent(cfg.botToken)}/getUpdates?timeout=25&offset=${tgOffset}`;
          const resp = await fetchImpl(url, { method: "GET", signal: abort.signal });
          const data: any = await resp.json().catch(() => ({}));
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
            abort.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            }, { once: true });
          });
          backoffMs = Math.min(30_000, backoffMs * 2);
        }
      }
    };
    void loop();
  }

  function stopFeishuWebSocket(): void {
    fsStopping = true;
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
  }

  function startFeishuWebSocket(cfg: FeishuChannelConfig): void {
    stopFeishuWebSocket();
    fsStopping = false;
    runtimeState["feishu-bot"] = {
      ...runtimeState["feishu-bot"],
      connected: false,
      status: "connecting",
      mode: "websocket",
      lastError: null,
    };

    const connectOnce = async () => {
      if (fsStopping) return;
      try {
        const base = resolveFeishuApiBase(cfg);
        const resp = await fetchImpl(`${base}/callback/ws/endpoint`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
        });
        const data: any = await resp.json().catch(() => ({}));
        const wsUrl = String(data?.data?.URL || data?.URL || "").trim();
        if (!resp.ok || !wsUrl) {
          throw new Error(data?.msg || `Feishu WS endpoint failed (HTTP ${resp.status})`);
        }
        const WSImpl = globalThis.WebSocket;
        if (typeof WSImpl !== "function") {
          throw new Error("Global WebSocket unavailable");
        }
        const ws = new WSImpl(wsUrl);
        fsWs = ws;
        ws.addEventListener("open", () => {
          runtimeState["feishu-bot"].connected = true;
          runtimeState["feishu-bot"].status = "connected";
          runtimeState["feishu-bot"].lastError = null;
        });
        ws.addEventListener("message", (evt: any) => {
          try {
            const rawStr = typeof evt?.data === "string"
              ? evt.data
              : Buffer.from(evt?.data || "").toString("utf8");
            // Extract JSON object from plain text or protobuf-framed payload
            const jsonStart = rawStr.indexOf("{");
            const jsonEnd = rawStr.lastIndexOf("}");
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
              const payload = JSON.parse(rawStr.slice(jsonStart, jsonEnd + 1));
              const parsed = parseFeishuWebhookPayload(payload, cfg);
              if (parsed.kind === "message") {
                void handleInboundMessage(parsed.message).catch(() => {});
              }
            }
          } catch {
            // ignore control/ping frames
          }
        });
        ws.addEventListener("close", () => {
          runtimeState["feishu-bot"].connected = false;
          if (!fsStopping) {
            runtimeState["feishu-bot"].status = "connecting";
            fsReconnectTimer = setTimeout(() => void connectOnce(), 5000);
            fsReconnectTimer.unref?.();
          }
        });
        ws.addEventListener("error", () => {
          runtimeState["feishu-bot"].connected = false;
          runtimeState["feishu-bot"].status = "error";
          runtimeState["feishu-bot"].lastError = "Feishu WebSocket connection error";
        });
      } catch (err: any) {
        runtimeState["feishu-bot"].connected = false;
        runtimeState["feishu-bot"].status = "error";
        runtimeState["feishu-bot"].lastError = err?.message || String(err);
        if (!fsStopping) {
          fsReconnectTimer = setTimeout(() => void connectOnce(), 10_000);
          fsReconnectTimer.unref?.();
        }
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
          connected: true,
          status: "webhook_ready",
          mode: "webhook",
          lastError: null,
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
          connected: true,
          status: "webhook_ready",
          mode: "webhook",
          lastError: null,
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
    if (cfg.webhookSecret) {
      const supplied = String(
        headers["x-telegram-bot-api-secret-token"] || ""
      ).trim();
      if (supplied !== cfg.webhookSecret) {
        return { status: 401, body: { ok: false, error: "invalid telegram webhook secret" } };
      }
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
    let parsed: ReturnType<typeof parseFeishuWebhookPayload>;
    try {
      parsed = parseFeishuWebhookPayload(body, cfg);
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
      const merged = {
        ...configs["telegram-bot"],
        ...(overrideRaw?.botToken ? { botToken: String(overrideRaw.botToken).trim() } : {}),
        ...(overrideRaw?.apiBaseUrl ? { apiBaseUrl: String(overrideRaw.apiBaseUrl).trim() } : {}),
      };
      const res = await testTelegramChannel(merged, fetchImpl);
      if (res.ok && res.botName) {
        runtimeState["telegram-bot"].botName = res.botName;
      }
      return res;
    }
    const merged = {
      ...configs["feishu-bot"],
      ...(overrideRaw?.appId ? { appId: String(overrideRaw.appId).trim() } : {}),
      ...(overrideRaw?.appSecret ? { appSecret: String(overrideRaw.appSecret).trim() } : {}),
      ...(overrideRaw?.domain ? { domain: overrideRaw.domain } : {}),
      ...(overrideRaw?.apiBaseUrl ? { apiBaseUrl: String(overrideRaw.apiBaseUrl).trim() } : {}),
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
    activeTurns.clear();
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
