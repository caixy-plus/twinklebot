import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import { Bot as GrammyBot } from "grammy";
import {
  DEFAULT_FEISHU_ACCOUNT_ID,
  DEFAULT_TELEGRAM_ACCOUNT_ID,
  DEFAULT_TELEGRAM_API_BASE,
  FEISHU_REACTION_FAILURE,
  FEISHU_REACTION_TYPING,
  TG_REACTION_FAILURE,
  TG_REACTION_TYPING,
  addFeishuMessageReaction,
  checkChatAuthorization,
  createChannelAccountId,
  createLarkClient,
  createLarkHttpInstance,
  createTelegramFetch,
  deleteFeishuMessageReaction,
  generatePairingCode,
  normalizeChannelsAuthStore,
  normalizeFeishuChannelConfig,
  normalizeTelegramChannelConfig,
  parseApprovalCommand,
  parseFeishuSdkMessageEvent,
  parseFeishuWebhookPayload,
  parseTelegramUpdate,
  redactSensitiveTokensInText,
  resolveFeishuSdkDomain,
  sanitizeAccountId,
  sanitizeChannelApiBaseUrl,
  sanitizeFeishuChannelConfig,
  sanitizeTelegramChannelConfig,
  sanitizeTelegramProxyUrl,
  sendFeishuMedia,
  sendFeishuMessage,
  sendTelegramMedia,
  sendTelegramMessage,
  setTelegramMessageReaction,
  testFeishuChannel,
  testTelegramChannel,
  timingSafeEqualStr,
  type ChannelApprovedChat,
  type ChannelOutboundMedia,
  type ChannelPendingPairing,
  type ChannelSkillId,
  type ChannelsAuthStore,
  type FeishuChannelAccount,
  type ParsedInboundChannelMessage,
  type TelegramChannelAccount,
} from "./channel-integrations.js";

export interface ChannelRejectedSender {
  senderId: string;
  chatId: string;
  senderName?: string;
  at: string;
}

/**
 * Strips system-appended local `/api/workspace/file` attachment links before
 * sending assistant text to external channels (Telegram / Feishu), so users
 * do not see unreachable localhost URLs alongside uploaded media.
 */
export function stripLocalWorkspaceEmbedsForChannel(
  text: string,
  _mediaItems: ChannelOutboundMedia[] = []
): string {
  const raw = String(text || "");
  if (!raw.trim()) return "";
  const cleanedLines = raw
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*\[文件附件:[^\]]*·\s*路径:[^\]]+\]\s*$/.test(line)) {
        return "";
      }
      if (/^\s*!?\[[^\]]*\]\(\/api\/workspace\/file\?[^)]+\)\s*$/.test(line)) {
        return "";
      }
      return line.replace(/!?\[([^\]]+)\]\(\/api\/workspace\/file\?[^)]+\)/g, "$1");
    });
  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ChannelRuntimeState {
  connected: boolean;
  status: "stopped" | "connecting" | "connected" | "webhook_ready" | "error";
  mode: string;
  botName: string;
  lastEventAt: string | null;
  lastError: string | null;
  lastSendError: string | null;
  lastRejectedSender: ChannelRejectedSender | null;
}

export interface CreateChannelManagerOptions {
  store: any;
  runner: any;
  getInstalledSkills: () => string[];
  fetchImpl?: typeof fetch;
  onStateChange?: () => void;
}

interface PendingChannelApproval {
  channel: ChannelSkillId;
  accountId: string;
  chatId: string;
  sessionId: string;
  callId: string;
  toolName: string;
}

interface PendingChannelChoiceQuestion {
  question: string;
  options: string[];
  multiSelect: boolean;
  allowCustom: boolean;
}

interface PendingChannelChoice {
  kind: "choice" | "draft";
  channel: ChannelSkillId;
  accountId: string;
  chatId: string;
  sessionId: string;
  callId: string;
  questions?: PendingChannelChoiceQuestion[];
  stepIndex?: number;
  answers?: Record<string, any>;
  draftTitle?: string;
}

interface ActiveChannelTurn {
  channel: ChannelSkillId;
  accountId: string;
  chatId: string;
  sessionId: string;
  messageId?: string;
  reactionPromise?: Promise<string | null>;
  buffer: string[];
  pendingMedia: ChannelOutboundMedia[];
  lastError: string;
  delivered: boolean;
  choiceNotified: boolean;
  steeredCount?: number;
  steerGraceTimer?: ReturnType<typeof setTimeout> | null;
  donePromise: Promise<void>;
  resolveDone: () => void;
}

interface TelegramConnEntry {
  bot: GrammyBot | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  epoch: number;
  sig: string;
}

interface FeishuConnEntry {
  wsClient: lark.WSClient | null;
  epoch: number;
  sig: string;
}

export interface ChannelPairingSummaryItem {
  code?: string;
  channel: ChannelSkillId;
  accountId: string;
  accountLabel: string;
  defaultSessionId: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  createdAt?: string;
  approvedAt?: string;
  enabled?: boolean;
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

function accountKey(channel: ChannelSkillId, accountId: string): string {
  return `${channel}:${accountId}`;
}

function defaultRuntimeState(channel: ChannelSkillId): ChannelRuntimeState {
  return {
    connected: false,
    status: "stopped",
    mode: channel === "telegram-bot" ? "polling" : "websocket",
    botName: "",
    lastEventAt: null,
    lastError: null,
    lastSendError: null,
    lastRejectedSender: null,
  };
}

export function createChannelManager({
  store,
  runner,
  getInstalledSkills,
  fetchImpl = fetch,
  onStateChange,
}: CreateChannelManagerOptions) {
  function notifyStateChange(): void {
    try {
      onStateChange?.();
    } catch {
      // ignore listener errors
    }
  }

  const seenEventIds: string[] = [];
  const seenEventSet = new Set<string>();
  const pendingApprovals = new Map<string, PendingChannelApproval>();
  const pendingChoices = new Map<string, PendingChannelChoice>();
  const activeTurns = new Map<string, ActiveChannelTurn>();
  const sessionChains = new Map<string, Promise<void>>();

  const runtimeStates = new Map<string, ChannelRuntimeState>();
  const tgConns = new Map<string, TelegramConnEntry>();
  const fsConns = new Map<string, FeishuConnEntry>();
  const fsClients = new Map<string, { key: string; client: lark.Client }>();
  let unsubscribeRunner: (() => void) | null = null;

  function getRuntime(channel: ChannelSkillId, accountId: string): ChannelRuntimeState {
    const k = accountKey(channel, accountId);
    let rt = runtimeStates.get(k);
    if (!rt) {
      rt = defaultRuntimeState(channel);
      runtimeStates.set(k, rt);
    }
    return rt;
  }

  function markEventSeen(dedupKey: string): boolean {
    if (seenEventSet.has(dedupKey)) return false;
    seenEventSet.add(dedupKey);
    seenEventIds.push(dedupKey);
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
    for (const [key, entry] of pendingChoices.entries()) {
      if (entry.sessionId === sessionId && (!matchCallId || entry.callId === matchCallId)) {
        pendingChoices.delete(key);
      }
    }
  }

  function readConfigs(): ChannelsAuthStore {
    return normalizeChannelsAuthStore(store?.readChannelsAuth?.() || {});
  }

  function writeConfigs(next: ChannelsAuthStore): ChannelsAuthStore {
    const normalized = normalizeChannelsAuthStore(next);
    store?.writeChannelsAuth?.(normalized);
    return normalized;
  }

  function findAccount<T extends FeishuChannelAccount | TelegramChannelAccount>(
    list: T[],
    fallback: T,
    accountId?: string
  ): T | null {
    if (accountId) {
      const match = list.find((a) => a.id === accountId);
      if (match) return match;
      return fallback.id === accountId ? fallback : null;
    }
    return list.find((a) => a.enabled) || list[0] || fallback;
  }

  function resolveChannelAccount(
    configs: ChannelsAuthStore,
    channel: ChannelSkillId,
    accountId?: string
  ): FeishuChannelAccount | TelegramChannelAccount | null {
    if (channel === "telegram-bot") {
      return findAccount(configs.telegramAccounts, configs["telegram-bot"], accountId);
    }
    return findAccount(configs.feishuAccounts, configs["feishu-bot"], accountId);
  }

  function getFeishuClient(cfg: FeishuChannelAccount): lark.Client {
    const k = accountKey("feishu-bot", cfg.id);
    const cacheKey = `${cfg.appId}:${cfg.appSecret}:${cfg.domain}:${cfg.apiBaseUrl}`;
    const existing = fsClients.get(k);
    if (existing && existing.key === cacheKey) {
      return existing.client;
    }
    const client = createLarkClient(cfg, fetchImpl);
    fsClients.set(k, { key: cacheKey, client });
    return client;
  }

  async function sendChannelReply(
    channel: ChannelSkillId,
    accountId: string,
    chatId: string,
    text: string
  ): Promise<void> {
    const safeText = redactSensitiveTokensInText(text);
    const configs = readConfigs();
    if (channel === "telegram-bot") {
      const tgCfg = findAccount(configs.telegramAccounts, configs["telegram-bot"], accountId);
      if (!tgCfg) return;
      await sendTelegramMessage(tgCfg, chatId, safeText, fetchImpl);
    } else {
      const fsCfg = findAccount(configs.feishuAccounts, configs["feishu-bot"], accountId);
      if (!fsCfg) return;
      try {
        await sendFeishuMessage(fsCfg, chatId, safeText, fetchImpl, getFeishuClient(fsCfg));
      } catch (err: any) {
        const code = Number(err?.feishuCode);
        if (code === 99991663 || code === 99991664 || code === 99991661) {
          fsClients.delete(accountKey("feishu-bot", fsCfg.id));
          await sendFeishuMessage(fsCfg, chatId, safeText, fetchImpl, getFeishuClient(fsCfg));
          return;
        }
        throw err;
      }
    }
  }

  async function sendChannelMedia(
    channel: ChannelSkillId,
    accountId: string,
    chatId: string,
    media: ChannelOutboundMedia
  ): Promise<void> {
    const configs = readConfigs();
    if (channel === "telegram-bot") {
      const tgCfg = findAccount(configs.telegramAccounts, configs["telegram-bot"], accountId);
      if (!tgCfg) return;
      await sendTelegramMedia(tgCfg, chatId, media, fetchImpl);
    } else {
      const fsCfg = findAccount(configs.feishuAccounts, configs["feishu-bot"], accountId);
      if (!fsCfg) return;
      try {
        await sendFeishuMedia(fsCfg, chatId, media, fetchImpl, getFeishuClient(fsCfg));
      } catch (err: any) {
        const code = Number(err?.feishuCode);
        if (code === 99991663 || code === 99991664 || code === 99991661) {
          fsClients.delete(accountKey("feishu-bot", fsCfg.id));
          await sendFeishuMedia(fsCfg, chatId, media, fetchImpl, getFeishuClient(fsCfg));
          return;
        }
        throw err;
      }
    }
  }

  async function sendChannelMediaTracked(
    channel: ChannelSkillId,
    accountId: string,
    chatId: string,
    media: ChannelOutboundMedia
  ): Promise<{ ok: boolean; error?: string }> {
    const rt = getRuntime(channel, accountId);
    try {
      await sendChannelMedia(channel, accountId, chatId, media);
      if (rt.lastSendError !== null) {
        rt.lastSendError = null;
        notifyStateChange();
      }
      return { ok: true };
    } catch (err: any) {
      const errMsg = String(err?.message || err || "发送媒体文件失败").trim();
      console.warn(`[channel-manager] ${channel}:${accountId} media failed: ${errMsg}`);
      if (rt.lastSendError !== errMsg) {
        rt.lastSendError = errMsg;
        notifyStateChange();
      }
      return { ok: false, error: errMsg };
    }
  }

  async function sendChannelReplyTracked(
    channel: ChannelSkillId,
    accountId: string,
    chatId: string,
    text: string
  ): Promise<boolean> {
    const rt = getRuntime(channel, accountId);
    try {
      await sendChannelReply(channel, accountId, chatId, text);
      if (rt.lastSendError !== null) {
        rt.lastSendError = null;
        notifyStateChange();
      }
      return true;
    } catch (err: any) {
      const errMsg = String(err?.message || err || "发送消息失败").trim();
      console.warn(`[channel-manager] ${channel}:${accountId} reply failed: ${errMsg}`);
      if (rt.lastSendError !== errMsg) {
        rt.lastSendError = errMsg;
        notifyStateChange();
      }
      return false;
    }
  }

  function startTurnReaction(turn: ActiveChannelTurn): void {
    if (!turn.messageId) return;
    const msgId = turn.messageId;
    const configs = readConfigs();
    if (turn.channel === "telegram-bot") {
      const tgCfg = findAccount(configs.telegramAccounts, configs["telegram-bot"], turn.accountId);
      if (!tgCfg || !tgCfg.botToken) return;
      turn.reactionPromise = setTelegramMessageReaction(
        tgCfg,
        turn.chatId,
        msgId,
        TG_REACTION_TYPING,
        fetchImpl
      ).then(() => null);
    } else {
      const fsCfg = findAccount(configs.feishuAccounts, configs["feishu-bot"], turn.accountId);
      if (!fsCfg || !fsCfg.appId || !fsCfg.appSecret) return;
      turn.reactionPromise = addFeishuMessageReaction(
        fsCfg,
        msgId,
        FEISHU_REACTION_TYPING,
        fetchImpl,
        getFeishuClient(fsCfg)
      );
    }
  }

  async function finalizeTurnReaction(turn: ActiveChannelTurn, failed: boolean): Promise<void> {
    if (!turn.messageId) return;
    const msgId = turn.messageId;
    let reactionId: string | null = null;
    if (turn.reactionPromise) {
      try {
        reactionId = await turn.reactionPromise;
      } catch {
        reactionId = null;
      }
    }
    const configs = readConfigs();
    if (turn.channel === "telegram-bot") {
      const tgCfg = findAccount(configs.telegramAccounts, configs["telegram-bot"], turn.accountId);
      if (!tgCfg || !tgCfg.botToken) return;
      await setTelegramMessageReaction(
        tgCfg,
        turn.chatId,
        msgId,
        failed ? TG_REACTION_FAILURE : null,
        fetchImpl
      );
    } else {
      const fsCfg = findAccount(configs.feishuAccounts, configs["feishu-bot"], turn.accountId);
      if (!fsCfg || !fsCfg.appId || !fsCfg.appSecret) return;
      const client = getFeishuClient(fsCfg);
      if (reactionId) {
        await deleteFeishuMessageReaction(fsCfg, msgId, reactionId, fetchImpl, client);
      }
      if (failed) {
        await addFeishuMessageReaction(fsCfg, msgId, FEISHU_REACTION_FAILURE, fetchImpl, client);
      }
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

  function invokeRunnerChoose(callId: string, selection: any): Promise<any> {
    if (typeof runner?.choose !== "function") return Promise.resolve();
    return Promise.resolve(runner.choose(callId, selection));
  }

  function formatChoiceQuestionPrompt(
    q: PendingChannelChoiceQuestion,
    stepIdx = 0,
    totalSteps = 1
  ): string {
    const stepPrefix = totalSteps > 1 ? `(${stepIdx + 1}/${totalSteps}) ` : "";
    const optionLines = q.options.map((opt, idx) => `${idx + 1}. ${opt}`).join("\n");
    const hint = q.multiSelect
      ? `请直接回复选项序号（可用逗号分隔多选，如 1,2）${q.allowCustom ? "，或直接输入自定义内容" : ""}。`
      : `请直接回复数字序号（1-${q.options.length}）${q.allowCustom ? "或自定义回复内容" : ""}。`;
    return `❓ ${stepPrefix}${q.question}\n${optionLines}\n\n${hint}`;
  }

  function ensureRunnerSubscribed(): void {
    if (unsubscribeRunner || typeof runner?.subscribe !== "function") return;
    unsubscribeRunner = runner.subscribe((event: any) => {
      if (!event || !event.sessionId) return;

      if (
        (event.type === "approval" ||
          event.type === "choice_resolved" ||
          event.type === "choice_superseded" ||
          event.type === "draft_resolved") &&
        event.callId
      ) {
        clearPendingApprovalsForSession(event.sessionId, event.callId);
      }

      const turn = activeTurns.get(event.sessionId);
      if (!turn) {
        if (event.type === "status" && TERMINAL_SESSION_STATUSES.has(String(event.status || ""))) {
          clearPendingApprovalsForSession(event.sessionId);
        }
        return;
      }

      if (event.type === "status" && event.status === "running" && turn.steerGraceTimer) {
        clearTimeout(turn.steerGraceTimer);
        turn.steerGraceTimer = null;
        turn.delivered = false;
        turn.choiceNotified = false;
        return;
      }

      if (event.type === "approval_request" && event.callId) {
        const configs = readConfigs();
        const acct = resolveChannelAccount(configs, turn.channel, turn.accountId);
        const approvalKey = `${turn.channel}:${turn.accountId}:${turn.chatId}`;
        if (acct?.approvalMode === "app_only") {
          void invokeRunnerApprove(event.callId, false);
          void sendChannelReplyTracked(
            turn.channel,
            turn.accountId,
            turn.chatId,
            `🛡️ 高危操作（${event.name || "tool"}）已按策略自动拒绝，请在 TwinkleBot App 中执行或审批。`
          );
        } else {
          pendingApprovals.set(approvalKey, {
            channel: turn.channel,
            accountId: turn.accountId,
            chatId: turn.chatId,
            sessionId: event.sessionId,
            callId: event.callId,
            toolName: String(event.name || "tool"),
          });
          void sendChannelReplyTracked(
            turn.channel,
            turn.accountId,
            turn.chatId,
            `⚠️ 需要你的确认\n操作：${event.name || "tool"}\n说明：${event.reason || "涉及高风险操作"}\n\n请直接回复「允许」/「/approve」执行，回复「拒绝」/「/deny」取消（也可在 TwinkleBot App 中同步审批）。`
          );
        }
        return;
      }

      if (event.type === "approval_reminder" && event.callId) {
        const toolLabel = String(event.name || "高危操作");
        const reasonText = String(event.reason || "请确认是否执行");
        void sendChannelReplyTracked(
          turn.channel,
          turn.accountId,
          turn.chatId,
          `⏰ 审批已等待较长时间（${toolLabel}）：${reasonText}\n请回复「允许」/「/approve」执行，或回复「拒绝」/「/deny」取消。`
        );
        return;
      }

      if (event.type === "choice_request" && event.callId) {
        const rawQuestions =
          Array.isArray(event.questions) && event.questions.length > 0
            ? event.questions
            : [
                {
                  question: event.question || "请选择",
                  options: Array.isArray(event.options) ? event.options : [],
                  multiSelect: Boolean(event.multiSelect),
                  allowCustom: event.allowCustom !== false,
                },
              ];
        const questions: PendingChannelChoiceQuestion[] = rawQuestions.map((q: any) => ({
          question: String(q?.question || "请选择"),
          options: Array.isArray(q?.options) ? q.options.map((o: any) => String(o)) : [],
          multiSelect: Boolean(q?.multiSelect),
          allowCustom: q?.allowCustom !== false,
        }));
        const choiceKey = `${turn.channel}:${turn.accountId}:${turn.chatId}`;
        pendingChoices.set(choiceKey, {
          kind: "choice",
          channel: turn.channel,
          accountId: turn.accountId,
          chatId: turn.chatId,
          sessionId: event.sessionId,
          callId: String(event.callId),
          questions,
          stepIndex: 0,
          answers: {},
        });
        turn.choiceNotified = true;
        void sendChannelReplyTracked(
          turn.channel,
          turn.accountId,
          turn.chatId,
          formatChoiceQuestionPrompt(questions[0], 0, questions.length)
        );
        return;
      }

      if (event.type === "draft_request" && event.callId) {
        const choiceKey = `${turn.channel}:${turn.accountId}:${turn.chatId}`;
        const draftTitle = String(event.title || "待确认草稿");
        pendingChoices.set(choiceKey, {
          kind: "draft",
          channel: turn.channel,
          accountId: turn.accountId,
          chatId: turn.chatId,
          sessionId: event.sessionId,
          callId: String(event.callId),
          draftTitle,
        });
        turn.choiceNotified = true;
        const recipientLine = event.recipient ? `\n对象：${event.recipient}` : "";
        const previewBody = String(event.content || "").trim().slice(0, 500);
        void sendChannelReplyTracked(
          turn.channel,
          turn.accountId,
          turn.chatId,
          `📝 待确认草稿：${draftTitle}${recipientLine}${previewBody ? `\n\n${previewBody}` : ""}\n\n请回复「1」或「确认」发送，回复「2」或「取消」放弃。`
        );
        return;
      }

      if (event.type === "status" && event.status === "awaiting_choice" && !turn.choiceNotified) {
        turn.choiceNotified = true;
        void sendChannelReplyTracked(
          turn.channel,
          turn.accountId,
          turn.chatId,
          "🔔 当前任务需要你在 TwinkleBot App 中输入加密凭据或完成安全验证。"
        );
        return;
      }

      if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
        turn.lastError = event.message.trim();
        return;
      }

      if (
        event.type === "result" &&
        (event.name === "send_file" || event.name === "generate_image") &&
        event.result?.ok
      ) {
        const filePath = String(event.result.source_path || event.result.path || "").trim();
        if (
          filePath &&
          !turn.pendingMedia.some((item) => item.filePath === filePath)
        ) {
          turn.pendingMedia.push({
            filePath,
            name: String(event.result.name || path.basename(filePath)),
            mimeType: event.result.mime_type ? String(event.result.mime_type) : undefined,
            isMedia: Boolean(event.result.is_media || event.name === "generate_image"),
            caption: event.result.caption ? String(event.result.caption) : undefined,
          });
        }
        return;
      }

      if (
        (event.type === "answer" || event.type === "assistant_message") &&
        typeof event.text === "string" &&
        event.text.trim()
      ) {
        if (turn.steerGraceTimer) {
          clearTimeout(turn.steerGraceTimer);
          turn.steerGraceTimer = null;
          turn.delivered = false;
        }
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
          const remainingSteers = Math.max(0, Number(turn.steeredCount) || 0);
          if (remainingSteers === 0) {
            activeTurns.delete(event.sessionId);
          } else {
            turn.steeredCount = remainingSteers - 1;
          }
          const failed = String(event.status) === "error";
          void finalizeTurnReaction(turn, failed);
          const replyText =
            turn.buffer.join("\n\n").trim() ||
            (failed
              ? `执行任务时发生错误${turn.lastError ? `：${turn.lastError}` : "，请在 TwinkleBot App 查看详情。"}`
              : event.status === "stopped"
                ? "任务已停止。"
                : "");
          turn.buffer = [];
          const mediaItems = [...turn.pendingMedia];
          turn.pendingMedia = [];
          const deliverAll = async () => {
            const outboundText = stripLocalWorkspaceEmbedsForChannel(replyText, mediaItems);
            if (outboundText) {
              await sendChannelReplyTracked(turn.channel, turn.accountId, turn.chatId, outboundText);
            }
            for (const mediaItem of mediaItems) {
              const mediaRes = await sendChannelMediaTracked(
                turn.channel,
                turn.accountId,
                turn.chatId,
                mediaItem
              );
              if (!mediaRes.ok) {
                const fileLabel = mediaItem.name || path.basename(mediaItem.filePath) || "附件";
                const errDetail = mediaRes.error || "未知错误";
                const sizeHint = /too big|413|size|large|exceed|limit/i.test(errDetail)
                  ? "（可能超过外部通道单文件大小限制）"
                  : "";
                await sendChannelReplyTracked(
                  turn.channel,
                  turn.accountId,
                  turn.chatId,
                  `⚠️ 文件发送失败（${fileLabel}）：${errDetail}${sizeHint}`
                );
              }
            }
          };
          const finishTurn = () => {
            if (remainingSteers > 0) {
              if (turn.steerGraceTimer) clearTimeout(turn.steerGraceTimer);
              turn.steerGraceTimer = setTimeout(() => {
                turn.steerGraceTimer = null;
                if (activeTurns.get(event.sessionId) === turn) {
                  activeTurns.delete(event.sessionId);
                }
                turn.resolveDone();
              }, 80);
              turn.steerGraceTimer.unref?.();
            } else {
              turn.resolveDone();
            }
          };
          if (replyText || mediaItems.length > 0) {
            void deliverAll().finally(finishTurn);
          } else {
            finishTurn();
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
    acctId: string,
    acctLabel: string,
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
          accountId: acctId,
          chatId: msg.chatId,
          sessionId,
          messageId: msg.messageId,
          buffer: [],
          pendingMedia: [],
          lastError: "",
          delivered: false,
          choiceNotified: false,
          donePromise,
          resolveDone,
        };
        activeTurns.set(sessionId, turn);
        startTurnReaction(turn);

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
            accountId: acctId,
            ...(acctLabel ? { accountLabel: acctLabel } : {}),
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
          void finalizeTurnReaction(turn, true);
          void sendChannelReplyTracked(
            msg.channel,
            acctId,
            msg.chatId,
            `执行任务失败：${err?.message || String(err)}`
          );
          resolveDone();
        } finally {
          clearTimeout(safetyTimer);
        }
      });

    sessionChains.set(sessionId, nextChain);
    return donePromise;
  }

  function collectAllPendingCodes(configs: ChannelsAuthStore): Set<string> {
    const codes = new Set<string>();
    for (const a of configs.feishuAccounts) {
      for (const p of a.pendingPairings) codes.add(p.code);
    }
    for (const a of configs.telegramAccounts) {
      for (const p of a.pendingPairings) codes.add(p.code);
    }
    return codes;
  }

  function getOrCreatePendingPairing(
    channel: ChannelSkillId,
    accountId: string,
    msg: ParsedInboundChannelMessage,
    createdAt: string
  ): string {
    const configs = readConfigs();
    const list = channel === "feishu-bot" ? configs.feishuAccounts : configs.telegramAccounts;
    const target = list.find((a) => a.id === accountId);
    if (!target) {
      return generatePairingCode(collectAllPendingCodes(configs));
    }
    const existing = target.pendingPairings.find((p) => p.chatId === msg.chatId);
    if (existing) return existing.code;

    const existingCodes = collectAllPendingCodes(configs);
    const code = generatePairingCode(existingCodes);
    const nextPending: ChannelPendingPairing = {
      code,
      chatId: msg.chatId,
      senderId: msg.senderId,
      ...(msg.senderName && msg.senderName !== msg.senderId ? { senderName: msg.senderName } : {}),
      createdAt,
    };
    target.pendingPairings.push(nextPending);
    writeConfigs(configs);
    return code;
  }

  async function handleInboundMessage(
    msg: ParsedInboundChannelMessage
  ): Promise<{ handled: boolean; rejected?: boolean; reason?: string; pairingCode?: string }> {
    const configs = readConfigs();
    const installed = getInstalledSkills();
    if (!installed.includes(msg.channel)) {
      return { handled: false, reason: "skill_not_installed" };
    }
    const acct = resolveChannelAccount(configs, msg.channel, msg.accountId);
    if (!acct || !acct.enabled) {
      return { handled: false, reason: "channel_disabled" };
    }

    const dedupKey = `${msg.channel}:${acct.id}:${msg.eventId}`;
    if (!markEventSeen(dedupKey)) {
      return { handled: false, reason: "duplicate" };
    }

    const eventAt = new Date().toISOString();
    const rt = getRuntime(msg.channel, acct.id);
    rt.lastEventAt = eventAt;

    const authStatus = checkChatAuthorization(acct, msg.senderId, msg.chatId);
    if (authStatus === "suspended") {
      rt.lastRejectedSender = {
        senderId: msg.senderId,
        chatId: msg.chatId,
        ...(msg.senderName && msg.senderName !== msg.senderId
          ? { senderName: msg.senderName }
          : {}),
        at: eventAt,
      };
      notifyStateChange();
      return { handled: false, rejected: true, reason: "chat_suspended" };
    }

    if (authStatus === "unapproved") {
      rt.lastRejectedSender = {
        senderId: msg.senderId,
        chatId: msg.chatId,
        ...(msg.senderName && msg.senderName !== msg.senderId
          ? { senderName: msg.senderName }
          : {}),
        at: eventAt,
      };
      if (acct.requirePairing !== false) {
        const code = getOrCreatePendingPairing(msg.channel, acct.id, msg, eventAt);
        notifyStateChange();
        const botTitle =
          acct.label || (msg.channel === "feishu-bot" ? "飞书机器人" : "Telegram 机器人");
        void sendChannelReplyTracked(
          msg.channel,
          acct.id,
          msg.chatId,
          `🔐 等待管理员放行「${botTitle}」，你的 6 位配对码为：${code}\n\n请将配对码发送给 TwinkleBot 内的 Bot（如「放行 ${code}」），或在 TwinkleBot App「技能商店 → ${
            msg.channel === "feishu-bot" ? "飞书机器人" : "Telegram 机器人"
          }」点击放行。（你的 ID：${msg.senderId}，会话 ID：${msg.chatId}）`
        );
        return {
          handled: false,
          rejected: true,
          reason: "unauthorized_sender",
          pairingCode: code,
        };
      }
      // requirePairing === false: silently ignore unknown senders (keep approved chats only)
      notifyStateChange();
      return { handled: false, rejected: true, reason: "unauthorized_sender" };
    }

    const prevRejected = rt.lastRejectedSender;
    if (
      prevRejected &&
      (checkChatAuthorization(acct, prevRejected.senderId, prevRejected.chatId) === "approved" ||
        prevRejected.senderId === msg.senderId ||
        prevRejected.chatId === msg.chatId)
    ) {
      rt.lastRejectedSender = null;
    }
    notifyStateChange();

    const pendingKey = `${msg.channel}:${acct.id}:${msg.chatId}`;
    const pending = pendingApprovals.get(pendingKey);
    if (pending) {
      const decision = parseApprovalCommand(msg.text);
      if (decision !== null) {
        pendingApprovals.delete(pendingKey);
        const runningTurn = activeTurns.get(pending.sessionId);
        await invokeRunnerApprove(pending.callId, decision);
        await sendChannelReplyTracked(
          msg.channel,
          acct.id,
          msg.chatId,
          decision
            ? `✅ 已允许执行：${pending.toolName}`
            : `❌ 已拒绝执行：${pending.toolName}`
        );
        if (runningTurn) {
          await Promise.race([runningTurn.donePromise, sleepMs(150)]);
        }
        return { handled: true };
      }
    }

    const pendingChoice = pendingChoices.get(pendingKey);
    if (pendingChoice) {
      const replyRaw = String(msg.text || "").trim();
      if (pendingChoice.kind === "draft") {
        let approved: boolean | null = parseApprovalCommand(replyRaw);
        if (approved === null) {
          if (/^(?:1|确认|发送|同意|ok|yes|confirm|send)$/i.test(replyRaw)) approved = true;
          else if (/^(?:2|取消|拒绝|放弃|no|cancel)$/i.test(replyRaw)) approved = false;
        }
        if (approved !== null) {
          pendingChoices.delete(pendingKey);
          const runningTurn = activeTurns.get(pendingChoice.sessionId);
          await invokeRunnerChoose(pendingChoice.callId, { approved });
          await sendChannelReplyTracked(
            msg.channel,
            acct.id,
            msg.chatId,
            approved
              ? `✅ 已确认草稿：${pendingChoice.draftTitle || ""}`.trim()
              : `❌ 已取消草稿：${pendingChoice.draftTitle || ""}`.trim()
          );
          if (runningTurn) {
            await Promise.race([runningTurn.donePromise, sleepMs(150)]);
          }
          return { handled: true };
        }
      } else if (Array.isArray(pendingChoice.questions) && pendingChoice.questions.length > 0) {
        const qList = pendingChoice.questions;
        const idx = pendingChoice.stepIndex || 0;
        const curQ = qList[idx];
        let parsedSelection: any = null;
        if (curQ) {
          if (curQ.multiSelect) {
            const parts = replyRaw
              .split(/[,，\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            const resolved: string[] = [];
            let allNumeric = parts.length > 0;
            for (const p of parts) {
              const n = /^\d+$/.test(p) ? Number(p) : NaN;
              if (Number.isInteger(n) && n >= 1 && n <= curQ.options.length) {
                resolved.push(curQ.options[n - 1]);
              } else {
                allNumeric = false;
              }
            }
            if (allNumeric && resolved.length > 0) {
              parsedSelection = Array.from(new Set(resolved));
            } else if (curQ.options.includes(replyRaw)) {
              parsedSelection = [replyRaw];
            } else if (curQ.allowCustom && replyRaw) {
              parsedSelection = [replyRaw];
            }
          } else {
            const n = /^\d+$/.test(replyRaw) ? Number(replyRaw) : NaN;
            if (Number.isInteger(n) && n >= 1 && n <= curQ.options.length) {
              parsedSelection = curQ.options[n - 1];
            } else if (curQ.options.includes(replyRaw)) {
              parsedSelection = replyRaw;
            } else if (curQ.allowCustom && replyRaw) {
              parsedSelection = replyRaw;
            }
          }
        }
        if (parsedSelection !== null) {
          const answers = pendingChoice.answers || {};
          answers[curQ.question] = parsedSelection;
          if (idx + 1 < qList.length) {
            pendingChoice.stepIndex = idx + 1;
            pendingChoice.answers = answers;
            await sendChannelReplyTracked(
              msg.channel,
              acct.id,
              msg.chatId,
              formatChoiceQuestionPrompt(qList[idx + 1], idx + 1, qList.length)
            );
            return { handled: true };
          }
          pendingChoices.delete(pendingKey);
          const payload = qList.length > 1 ? { answers } : parsedSelection;
          const runningTurn = activeTurns.get(pendingChoice.sessionId);
          await invokeRunnerChoose(pendingChoice.callId, payload);
          const displayChosen = Array.isArray(parsedSelection)
            ? parsedSelection.join("、")
            : String(parsedSelection);
          await sendChannelReplyTracked(
            msg.channel,
            acct.id,
            msg.chatId,
            `✅ 已选择：${displayChosen}`
          );
          if (runningTurn) {
            await Promise.race([runningTurn.donePromise, sleepMs(150)]);
          }
          return { handled: true };
        }
      }
    }

    const sessionId = resolveTargetSessionId(acct.defaultSessionId);
    const activeTurn = activeTurns.get(sessionId);
    if (
      activeTurn &&
      typeof runner?.isSessionBusy === "function" &&
      runner.isSessionBusy(sessionId) &&
      typeof runner?.enqueue === "function"
    ) {
      activeTurn.messageId = msg.messageId;
      activeTurn.steeredCount = (activeTurn.steeredCount || 0) + 1;
      const steerMeta = {
        clientSource: {
          deviceKind: "mobile" as const,
          platform: msg.channel,
        },
        channelMeta: {
          channel: msg.channel,
          accountId: acct.id,
          ...(acct.label ? { accountLabel: acct.label } : {}),
          chatId: msg.chatId,
          senderId: msg.senderId,
          senderName: msg.senderName,
        },
      };
      await runner.enqueue(sessionId, msg.text, steerMeta);
      await Promise.race([activeTurn.donePromise, sleepMs(150)]);
      return { handled: true };
    }

    const donePromise = enqueueSessionChannelTurn(sessionId, acct.id, acct.label, msg);
    await Promise.race([donePromise, sleepMs(150)]);
    return { handled: true };
  }

  function stopTelegramPolling(accountId?: string): void {
    const keys = accountId
      ? [accountKey("telegram-bot", accountId)]
      : Array.from(tgConns.keys());
    for (const k of keys) {
      const entry = tgConns.get(k);
      if (!entry) continue;
      entry.epoch += 1;
      entry.sig = "";
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }
      if (entry.bot) {
        const old = entry.bot;
        entry.bot = null;
        void old.stop().catch(() => {});
      }
    }
  }

  function startTelegramPolling(cfg: TelegramChannelAccount, sig: string): void {
    stopTelegramPolling(cfg.id);
    const k = accountKey("telegram-bot", cfg.id);
    const entry: TelegramConnEntry = tgConns.get(k) || {
      bot: null,
      retryTimer: null,
      epoch: 0,
      sig: "",
    };
    const myEpoch = ++entry.epoch;
    entry.sig = sig;
    tgConns.set(k, entry);

    const base = sanitizeChannelApiBaseUrl(cfg.apiBaseUrl, DEFAULT_TELEGRAM_API_BASE);
    const resolvedFetch = createTelegramFetch(cfg, fetchImpl);
    const rt = getRuntime("telegram-bot", cfg.id);
    rt.connected = false;
    rt.status = "connecting";
    rt.mode = "polling";
    rt.lastError = null;
    rt.lastSendError = null;

    let backoffMs = 2000;
    const launchOnce = () => {
      if (myEpoch !== entry.epoch) return;
      const bot = new GrammyBot(cfg.botToken, {
        client: {
          apiRoot: base,
          fetch: resolvedFetch as any,
          baseFetchConfig: {},
        },
      });
      entry.bot = bot;

      bot.on(
        ["message:text", "message:caption", "edited_message:text", "edited_message:caption"],
        (ctx) => {
          if (myEpoch !== entry.epoch) return;
          const parsed = parseTelegramUpdate(ctx.update);
          if (parsed) {
            void handleInboundMessage({ ...parsed, accountId: cfg.id }).catch(() => {});
          }
        }
      );

      bot.catch((botErr) => {
        if (myEpoch !== entry.epoch) return;
        const msg =
          (botErr?.error as any)?.description ||
          (botErr?.error as any)?.message ||
          botErr?.message ||
          "Telegram polling error";
        getRuntime("telegram-bot", cfg.id).lastError = String(msg);
        notifyStateChange();
      });

      void bot
        .start({
          allowed_updates: ["message", "edited_message"],
          onStart: (botInfo) => {
            if (myEpoch !== entry.epoch) {
              void bot.stop().catch(() => {});
              return;
            }
            backoffMs = 2000;
            const curRt = getRuntime("telegram-bot", cfg.id);
            curRt.connected = true;
            curRt.status = "connected";
            curRt.mode = "polling";
            curRt.botName = botInfo.first_name || botInfo.username || "Telegram Bot";
            curRt.lastError = null;
            notifyStateChange();
          },
        })
        .catch((err: any) => {
          if (myEpoch !== entry.epoch) return;
          const nextErr = err?.description || err?.message || String(err);
          const curRt = getRuntime("telegram-bot", cfg.id);
          curRt.connected = false;
          curRt.status = "error";
          curRt.lastError = nextErr;
          notifyStateChange();
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            launchOnce();
          }, backoffMs);
          entry.retryTimer.unref?.();
          backoffMs = Math.min(30_000, backoffMs * 2);
        });
    };

    launchOnce();
  }

  function stopFeishuWebSocket(accountId?: string): void {
    const keys = accountId
      ? [accountKey("feishu-bot", accountId)]
      : Array.from(fsConns.keys());
    for (const k of keys) {
      const entry = fsConns.get(k);
      if (!entry) continue;
      entry.epoch += 1;
      entry.sig = "";
      if (entry.wsClient) {
        const old = entry.wsClient;
        entry.wsClient = null;
        try {
          old.close({ force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  function startFeishuWebSocket(cfg: FeishuChannelAccount, sig: string): void {
    stopFeishuWebSocket(cfg.id);
    const k = accountKey("feishu-bot", cfg.id);
    const entry: FeishuConnEntry = fsConns.get(k) || {
      wsClient: null,
      epoch: 0,
      sig: "",
    };
    const myEpoch = ++entry.epoch;
    entry.sig = sig;
    fsConns.set(k, entry);

    const rt = getRuntime("feishu-bot", cfg.id);
    rt.connected = false;
    rt.status = "connecting";
    rt.mode = "websocket";
    rt.lastError = null;
    rt.lastSendError = null;

    const eventDispatcher = new lark.EventDispatcher({
      loggerLevel: lark.LoggerLevel.error,
    }).register({
      "im.message.receive_v1": async (data: any) => {
        if (myEpoch !== entry.epoch) return;
        const parsed = parseFeishuSdkMessageEvent(data);
        if (parsed) {
          void handleInboundMessage({ ...parsed, accountId: cfg.id }).catch(() => {});
        }
      },
    });

    const wsClient = new lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: resolveFeishuSdkDomain(cfg),
      loggerLevel: lark.LoggerLevel.error,
      httpInstance: createLarkHttpInstance(fetchImpl),
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 30 },
      onReady: () => {
        if (myEpoch !== entry.epoch) {
          try {
            wsClient.close({ force: true });
          } catch {}
          return;
        }
        const curRt = getRuntime("feishu-bot", cfg.id);
        curRt.connected = true;
        curRt.status = "connected";
        curRt.lastError = null;
        notifyStateChange();
      },
      onReconnecting: () => {
        if (myEpoch !== entry.epoch) return;
        const curRt = getRuntime("feishu-bot", cfg.id);
        curRt.connected = false;
        curRt.status = "connecting";
        notifyStateChange();
      },
      onReconnected: () => {
        if (myEpoch !== entry.epoch) return;
        const curRt = getRuntime("feishu-bot", cfg.id);
        curRt.connected = true;
        curRt.status = "connected";
        curRt.lastError = null;
        notifyStateChange();
      },
      onError: (err: Error) => {
        if (myEpoch !== entry.epoch) return;
        const curRt = getRuntime("feishu-bot", cfg.id);
        curRt.connected = false;
        curRt.status = "error";
        curRt.lastError = err?.message || String(err);
        notifyStateChange();
      },
    });

    entry.wsClient = wsClient;
    void wsClient.start({ eventDispatcher }).catch((err: any) => {
      if (myEpoch !== entry.epoch) return;
      const curRt = getRuntime("feishu-bot", cfg.id);
      curRt.connected = false;
      curRt.status = "error";
      curRt.lastError = err?.message || String(err);
      notifyStateChange();
    });
  }

  function clearResolvedRejectedSender(
    channel: ChannelSkillId,
    acct: FeishuChannelAccount | TelegramChannelAccount
  ): void {
    const rt = getRuntime(channel, acct.id);
    const rej = rt.lastRejectedSender;
    if (rej && checkChatAuthorization(acct, rej.senderId, rej.chatId) === "approved") {
      rt.lastRejectedSender = null;
    }
  }

  function syncFromStore(): void {
    const configs = readConfigs();
    const installed = getInstalledSkills();
    const tgInstalled = installed.includes("telegram-bot");
    const fsInstalled = installed.includes("feishu-bot");

    const activeTgKeys = new Set<string>(
      configs.telegramAccounts.map((a) => accountKey("telegram-bot", a.id))
    );
    for (const k of Array.from(tgConns.keys())) {
      if (!activeTgKeys.has(k)) {
        const id = k.slice("telegram-bot:".length);
        stopTelegramPolling(id);
        tgConns.delete(k);
        runtimeStates.delete(k);
      }
    }

    for (const tgCfg of configs.telegramAccounts) {
      const k = accountKey("telegram-bot", tgCfg.id);
      clearResolvedRejectedSender("telegram-bot", tgCfg);
      const rt = getRuntime("telegram-bot", tgCfg.id);
      const sig = `${tgInstalled}|${tgCfg.enabled}|${tgCfg.connectionMode}|${tgCfg.apiBaseUrl}|${tgCfg.proxy}|${tgCfg.botToken}`;
      const existing = tgConns.get(k);

      if (tgInstalled && tgCfg.enabled && tgCfg.botToken) {
        if (tgCfg.connectionMode === "polling") {
          if (!existing || existing.sig !== sig || !existing.bot) {
            startTelegramPolling(tgCfg, sig);
          }
        } else {
          stopTelegramPolling(tgCfg.id);
          const cur = tgConns.get(k) || { bot: null, retryTimer: null, epoch: 0, sig: "" };
          cur.sig = sig;
          tgConns.set(k, cur);
          rt.connected = Boolean(tgCfg.webhookSecret);
          rt.status = tgCfg.webhookSecret ? "webhook_ready" : "error";
          rt.mode = "webhook";
          rt.lastError = tgCfg.webhookSecret ? null : "Webhook Secret 未配置";
          rt.lastSendError = null;
        }
      } else {
        stopTelegramPolling(tgCfg.id);
        const cur = tgConns.get(k) || { bot: null, retryTimer: null, epoch: 0, sig: "" };
        cur.sig = "";
        tgConns.set(k, cur);
        rt.connected = false;
        rt.status = "stopped";
        rt.mode = tgCfg.connectionMode;
        rt.lastError = null;
        rt.lastSendError = null;
      }
    }

    const activeFsKeys = new Set<string>(
      configs.feishuAccounts.map((a) => accountKey("feishu-bot", a.id))
    );
    for (const k of Array.from(fsConns.keys())) {
      if (!activeFsKeys.has(k)) {
        const id = k.slice("feishu-bot:".length);
        stopFeishuWebSocket(id);
        fsConns.delete(k);
        fsClients.delete(k);
        runtimeStates.delete(k);
      }
    }

    for (const fsCfg of configs.feishuAccounts) {
      const k = accountKey("feishu-bot", fsCfg.id);
      clearResolvedRejectedSender("feishu-bot", fsCfg);
      const rt = getRuntime("feishu-bot", fsCfg.id);
      const sig = `${fsInstalled}|${fsCfg.enabled}|${fsCfg.connectionMode}|${fsCfg.domain}|${fsCfg.apiBaseUrl}|${fsCfg.appId}|${fsCfg.appSecret}`;
      const existing = fsConns.get(k);

      if (fsInstalled && fsCfg.enabled && fsCfg.appId && fsCfg.appSecret) {
        if (fsCfg.connectionMode === "websocket") {
          if (!existing || existing.sig !== sig || !existing.wsClient) {
            startFeishuWebSocket(fsCfg, sig);
          }
        } else {
          stopFeishuWebSocket(fsCfg.id);
          const cur = fsConns.get(k) || { wsClient: null, epoch: 0, sig: "" };
          cur.sig = sig;
          fsConns.set(k, cur);
          rt.connected = Boolean(fsCfg.verificationToken);
          rt.status = fsCfg.verificationToken ? "webhook_ready" : "error";
          rt.mode = "webhook";
          rt.lastError = fsCfg.verificationToken ? null : "Verification Token 未配置";
          rt.lastSendError = null;
        }
      } else {
        stopFeishuWebSocket(fsCfg.id);
        const cur = fsConns.get(k) || { wsClient: null, epoch: 0, sig: "" };
        cur.sig = "";
        fsConns.set(k, cur);
        rt.connected = false;
        rt.status = "stopped";
        rt.mode = fsCfg.connectionMode;
        rt.lastError = null;
        rt.lastSendError = null;
      }
    }
  }

  function listPairings(filter?: { channel?: ChannelSkillId; accountId?: string }): {
    pending: ChannelPairingSummaryItem[];
    approved: ChannelPairingSummaryItem[];
  } {
    const configs = readConfigs();
    const pending: ChannelPairingSummaryItem[] = [];
    const approved: ChannelPairingSummaryItem[] = [];

    const collect = (
      channel: ChannelSkillId,
      accts: Array<FeishuChannelAccount | TelegramChannelAccount>
    ) => {
      if (filter?.channel && filter.channel !== channel) return;
      for (const a of accts) {
        if (filter?.accountId && filter.accountId !== a.id) continue;
        const label = a.label || (channel === "feishu-bot" ? (a as any).appId || a.id : a.id);
        for (const p of a.pendingPairings) {
          pending.push({
            code: p.code,
            channel,
            accountId: a.id,
            accountLabel: label,
            defaultSessionId: a.defaultSessionId,
            chatId: p.chatId,
            senderId: p.senderId,
            ...(p.senderName ? { senderName: p.senderName } : {}),
            createdAt: p.createdAt,
          });
        }
        for (const c of a.approvedChats) {
          approved.push({
            channel,
            accountId: a.id,
            accountLabel: label,
            defaultSessionId: a.defaultSessionId,
            chatId: c.chatId,
            ...(c.senderId ? { senderId: c.senderId } : {}),
            ...(c.senderName ? { senderName: c.senderName } : {}),
            approvedAt: c.approvedAt,
            enabled: c.enabled !== false,
          });
        }
      }
    };

    collect("feishu-bot", configs.feishuAccounts);
    collect("telegram-bot", configs.telegramAccounts);
    return { pending, approved };
  }

  function approvePairing(
    code: string,
    opts: { notifyChat?: boolean } = {}
  ):
    | {
        ok: true;
        channel: ChannelSkillId;
        accountId: string;
        accountLabel: string;
        defaultSessionId: string;
        chatId: string;
        senderId: string;
      }
    | { ok: false; error: string } {
    const cleanCode = String(code || "").trim();
    if (!cleanCode) {
      return { ok: false, error: "请提供 6 位配对码" };
    }
    const configs = readConfigs();
    const channelsToCheck: Array<{
      channel: ChannelSkillId;
      accounts: Array<FeishuChannelAccount | TelegramChannelAccount>;
    }> = [
      { channel: "feishu-bot", accounts: configs.feishuAccounts },
      { channel: "telegram-bot", accounts: configs.telegramAccounts },
    ];

    for (const { channel, accounts } of channelsToCheck) {
      for (const acct of accounts) {
        const idx = acct.pendingPairings.findIndex((p) => p.code === cleanCode);
        if (idx === -1) continue;
        const pending = acct.pendingPairings[idx];
        acct.pendingPairings.splice(idx, 1);

        const nowIso = new Date().toISOString();
        const existingIdx = acct.approvedChats.findIndex((c) => c.chatId === pending.chatId);
        const approvedEntry: ChannelApprovedChat = {
          chatId: pending.chatId,
          senderId: pending.senderId,
          ...(pending.senderName ? { senderName: pending.senderName } : {}),
          approvedAt: existingIdx >= 0 ? acct.approvedChats[existingIdx].approvedAt : nowIso,
          enabled: true,
        };
        if (existingIdx >= 0) {
          acct.approvedChats[existingIdx] = approvedEntry;
        } else {
          acct.approvedChats.push(approvedEntry);
        }
        acct.updatedAt = nowIso;
        writeConfigs(configs);

        const rt = getRuntime(channel, acct.id);
        if (
          rt.lastRejectedSender &&
          (rt.lastRejectedSender.chatId === pending.chatId ||
            rt.lastRejectedSender.senderId === pending.senderId)
        ) {
          rt.lastRejectedSender = null;
        }
        notifyStateChange();

        if (opts.notifyChat !== false) {
          void sendChannelReplyTracked(
            channel,
            acct.id,
            pending.chatId,
            "✅ 管理员已通过你的配对请求，现在可以直接开始对话！"
          );
        }

        return {
          ok: true,
          channel,
          accountId: acct.id,
          accountLabel: acct.label,
          defaultSessionId: acct.defaultSessionId,
          chatId: pending.chatId,
          senderId: pending.senderId,
        };
      }
    }

    return { ok: false, error: `未找到或已失效的配对码：${cleanCode}` };
  }

  function rejectPairing(
    code: string
  ): { ok: true; channel: ChannelSkillId; accountId: string; chatId: string } | { ok: false; error: string } {
    const cleanCode = String(code || "").trim();
    if (!cleanCode) return { ok: false, error: "请提供 6 位配对码" };
    const configs = readConfigs();
    for (const [channel, accounts] of [
      ["feishu-bot", configs.feishuAccounts],
      ["telegram-bot", configs.telegramAccounts],
    ] as const) {
      for (const acct of accounts) {
        const idx = acct.pendingPairings.findIndex((p) => p.code === cleanCode);
        if (idx === -1) continue;
        const [removed] = acct.pendingPairings.splice(idx, 1);
        acct.updatedAt = new Date().toISOString();
        writeConfigs(configs);
        notifyStateChange();
        return { ok: true, channel, accountId: acct.id, chatId: removed.chatId };
      }
    }
    return { ok: false, error: `未找到或已失效的配对码：${cleanCode}` };
  }

  function setApprovalEnabled(
    channel: ChannelSkillId,
    accountId: string,
    chatId: string,
    enabled: boolean
  ): { ok: true; enabled: boolean } | { ok: false; error: string } {
    const cleanChat = String(chatId || "").trim();
    if (!cleanChat) return { ok: false, error: "缺少 chatId" };
    const configs = readConfigs();
    const list = channel === "feishu-bot" ? configs.feishuAccounts : configs.telegramAccounts;
    const candidates = accountId ? list.filter((a) => a.id === accountId) : list;
    for (const acct of candidates) {
      const entry = acct.approvedChats.find(
        (c) => c.chatId === cleanChat || c.senderId === cleanChat
      );
      if (entry) {
        entry.enabled = Boolean(enabled);
        acct.updatedAt = new Date().toISOString();
        writeConfigs(configs);
        if (enabled) clearResolvedRejectedSender(channel, acct);
        notifyStateChange();
        return { ok: true, enabled: entry.enabled };
      }
    }
    return { ok: false, error: "未找到对应的已放行会话记录" };
  }

  function deleteApproval(
    channel: ChannelSkillId,
    accountId: string,
    chatId: string
  ): { ok: true } | { ok: false; error: string } {
    const cleanChat = String(chatId || "").trim();
    if (!cleanChat) return { ok: false, error: "缺少 chatId" };
    const configs = readConfigs();
    const list = channel === "feishu-bot" ? configs.feishuAccounts : configs.telegramAccounts;
    const candidates = accountId ? list.filter((a) => a.id === accountId) : list;
    for (const acct of candidates) {
      const idx = acct.approvedChats.findIndex(
        (c) => c.chatId === cleanChat || c.senderId === cleanChat
      );
      if (idx >= 0) {
        const [removed] = acct.approvedChats.splice(idx, 1);
        acct.allowedSenderIds = acct.allowedSenderIds.filter(
          (id) => id !== removed.chatId && id !== removed.senderId
        );
        acct.updatedAt = new Date().toISOString();
        writeConfigs(configs);
        notifyStateChange();
        return { ok: true };
      }
    }
    return { ok: false, error: "未找到对应的已放行会话记录" };
  }

  function upsertAccount(
    channelId: ChannelSkillId,
    body: Record<string, any> = {},
    opts: { accountId?: string; createNew?: boolean } = {}
  ): { ok: true; accountId: string } | { ok: false; status: number; error: string } {
    const configs = readConfigs();
    const nowIso = new Date().toISOString();

    if (channelId === "telegram-bot") {
      const list = configs.telegramAccounts;
      let idx = -1;
      let targetId = opts.accountId
        ? sanitizeAccountId(opts.accountId, "")
        : body.id
          ? sanitizeAccountId(body.id, "")
          : "";
      if (!opts.createNew) {
        if (targetId) {
          idx = list.findIndex((a) => a.id === targetId);
          if (idx === -1 && opts.accountId) {
            return { ok: false, status: 404, error: "未找到指定的 Telegram 机器人配置" };
          }
        } else if (list.length > 0) {
          idx = 0;
          targetId = list[0].id;
        }
      }
      if (!targetId) {
        targetId =
          opts.createNew || list.length > 0
            ? createChannelAccountId("telegram-bot")
            : DEFAULT_TELEGRAM_ACCOUNT_ID;
      }
      if (body.proxy !== undefined && String(body.proxy || "").trim() && !String(body.proxy).includes("••••")) {
        if (!sanitizeTelegramProxyUrl(body.proxy)) {
          return {
            ok: false,
            status: 400,
            error: "Telegram 代理地址无效（仅支持 http://、https://、socks5://、socks5h://）",
          };
        }
      }
      const existing = idx >= 0 ? list[idx] : { id: targetId };
      const nextTg: TelegramChannelAccount = {
        ...normalizeTelegramChannelConfig({ ...body, id: targetId }, existing),
        updatedAt: nowIso,
      };
      if (nextTg.enabled && nextTg.connectionMode === "webhook" && !nextTg.webhookSecret) {
        return {
          ok: false,
          status: 400,
          error: "启用 Telegram Webhook 模式时必须配置 Webhook Secret Token，以防未授权伪造调用",
        };
      }
      if (idx >= 0) list[idx] = nextTg;
      else list.push(nextTg);
      writeConfigs(configs);
      syncFromStore();
      notifyStateChange();
      return { ok: true, accountId: nextTg.id };
    }

    const list = configs.feishuAccounts;
    let idx = -1;
    let targetId = opts.accountId
      ? sanitizeAccountId(opts.accountId, "")
      : body.id
        ? sanitizeAccountId(body.id, "")
        : "";
    if (!opts.createNew) {
      if (targetId) {
        idx = list.findIndex((a) => a.id === targetId);
        if (idx === -1 && opts.accountId) {
          return { ok: false, status: 404, error: "未找到指定的飞书机器人配置" };
        }
      } else if (list.length > 0) {
        idx = 0;
        targetId = list[0].id;
      }
    }
    if (!targetId) {
      targetId =
        opts.createNew || list.length > 0
          ? createChannelAccountId("feishu-bot")
          : DEFAULT_FEISHU_ACCOUNT_ID;
    }
    const existing = idx >= 0 ? list[idx] : { id: targetId };
    const nextFs: FeishuChannelAccount = {
      ...normalizeFeishuChannelConfig({ ...body, id: targetId }, existing),
      updatedAt: nowIso,
    };
    if (nextFs.enabled && nextFs.connectionMode === "webhook" && !nextFs.verificationToken) {
      return {
        ok: false,
        status: 400,
        error: "启用飞书 Webhook 模式时必须配置 Verification Token，以防未授权伪造调用",
      };
    }
    if (idx >= 0) list[idx] = nextFs;
    else list.push(nextFs);
    writeConfigs(configs);
    syncFromStore();
    notifyStateChange();
    return { ok: true, accountId: nextFs.id };
  }

  function deleteAccount(
    channelId: ChannelSkillId,
    accountId: string
  ): { ok: true } | { ok: false; status: number; error: string } {
    const cleanId = sanitizeAccountId(accountId, "");
    if (!cleanId) return { ok: false, status: 400, error: "缺少机器人 ID" };
    const configs = readConfigs();
    const list = channelId === "telegram-bot" ? configs.telegramAccounts : configs.feishuAccounts;
    const idx = list.findIndex((a) => a.id === cleanId);
    if (idx === -1) {
      return { ok: false, status: 404, error: "未找到指定的机器人配置" };
    }
    list.splice(idx, 1);
    for (const [k, entry] of pendingApprovals.entries()) {
      if (entry.channel === channelId && entry.accountId === cleanId) {
        pendingApprovals.delete(k);
      }
    }
    writeConfigs(configs);
    syncFromStore();
    notifyStateChange();
    return { ok: true };
  }

  function getStatusPayload() {
    const configs = readConfigs();
    const cloneRuntime = (id: ChannelSkillId, accountId: string) => {
      const rt = getRuntime(id, accountId);
      return {
        ...rt,
        lastRejectedSender: rt.lastRejectedSender ? { ...rt.lastRejectedSender } : null,
      };
    };

    const tgAccounts = configs.telegramAccounts.map((cfg) => ({
      id: cfg.id,
      config: sanitizeTelegramChannelConfig(cfg),
      runtime: cloneRuntime("telegram-bot", cfg.id),
      webhookPath: `/api/channels/telegram/webhook/${encodeURIComponent(cfg.id)}`,
      legacyWebhookPath: "/api/channels/telegram/webhook",
    }));

    const fsAccounts = configs.feishuAccounts.map((cfg) => ({
      id: cfg.id,
      config: sanitizeFeishuChannelConfig(cfg),
      runtime: cloneRuntime("feishu-bot", cfg.id),
      webhookPath: `/api/channels/feishu/webhook/${encodeURIComponent(cfg.id)}`,
      legacyWebhookPath: "/api/channels/feishu/webhook",
    }));

    return {
      "telegram-bot": {
        config: tgAccounts[0]?.config || sanitizeTelegramChannelConfig(configs["telegram-bot"]),
        runtime:
          tgAccounts[0]?.runtime || cloneRuntime("telegram-bot", configs["telegram-bot"].id),
        webhookPath: "/api/channels/telegram/webhook",
        accounts: tgAccounts,
      },
      "feishu-bot": {
        config: fsAccounts[0]?.config || sanitizeFeishuChannelConfig(configs["feishu-bot"]),
        runtime: fsAccounts[0]?.runtime || cloneRuntime("feishu-bot", configs["feishu-bot"].id),
        webhookPath: "/api/channels/feishu/webhook",
        accounts: fsAccounts,
      },
      pairings: listPairings(),
    };
  }

  async function handleTelegramWebhook(
    body: any,
    headers: Record<string, string | string[] | undefined>,
    accountId?: string
  ): Promise<{ status: number; body: Record<string, any> }> {
    const configs = readConfigs();
    const cfg = accountId
      ? configs.telegramAccounts.find((a) => a.id === accountId) || null
      : configs.telegramAccounts.find((a) => a.enabled && a.connectionMode === "webhook") ||
        configs.telegramAccounts[0] ||
        configs["telegram-bot"];
    if (!cfg) {
      return { status: 404, body: { ok: false, error: "telegram-bot account not found" } };
    }
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
    const outcome = await handleInboundMessage({ ...parsed, accountId: cfg.id });
    return { status: 200, body: { ok: true, ...outcome } };
  }

  async function handleFeishuWebhook(
    body: any,
    accountId?: string
  ): Promise<{ status: number; body: Record<string, any> }> {
    const configs = readConfigs();
    const cfg = accountId
      ? configs.feishuAccounts.find((a) => a.id === accountId) || null
      : configs.feishuAccounts.find((a) => a.enabled && a.connectionMode === "webhook") ||
        configs.feishuAccounts[0] ||
        configs["feishu-bot"];
    if (!cfg) {
      return { status: 404, body: { ok: false, error: "feishu-bot account not found" } };
    }
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
    const outcome = await handleInboundMessage({ ...parsed.message, accountId: cfg.id });
    return { status: 200, body: { ok: true, ...outcome } };
  }

  async function testChannel(
    channelId: ChannelSkillId,
    overrideRaw?: Record<string, any>,
    explicitAccountId?: string
  ) {
    const configs = readConfigs();
    const targetAcctId = explicitAccountId || (overrideRaw?.accountId ? String(overrideRaw.accountId) : undefined);
    const isNewTest = overrideRaw?.isNew === true;

    if (channelId === "telegram-bot") {
      const stored = isNewTest
        ? normalizeTelegramChannelConfig({})
        : (targetAcctId ? configs.telegramAccounts.find((a) => a.id === targetAcctId) : null) ||
          configs.telegramAccounts[0] ||
          configs["telegram-bot"];
      const overrideBase =
        typeof overrideRaw?.apiBaseUrl === "string" && overrideRaw.apiBaseUrl.trim()
          ? sanitizeChannelApiBaseUrl(overrideRaw.apiBaseUrl, "")
          : "";
      if (overrideRaw?.apiBaseUrl && !overrideBase) {
        return { ok: false, error: "不安全的自定义 Telegram API Base URL（仅允许公网 HTTPS 或本机回环）" };
      }
      const explicitToken =
        typeof overrideRaw?.botToken === "string" ? overrideRaw.botToken.trim() : "";
      if (overrideBase && overrideBase !== stored.apiBaseUrl && !explicitToken) {
        return {
          ok: false,
          error: "修改 API Base URL 测试连接时必须同时重新填写 Bot Token",
        };
      }
      const rawProxy =
        overrideRaw?.clearProxy === true
          ? ""
          : overrideRaw?.proxy !== undefined
            ? String(overrideRaw.proxy).trim()
            : undefined;
      if (rawProxy && !rawProxy.includes("••••") && !sanitizeTelegramProxyUrl(rawProxy)) {
        return {
          ok: false,
          error: "Telegram 代理地址无效（仅支持 http://、https://、socks5://、socks5h://）",
        };
      }
      const overrideProxy =
        rawProxy === undefined
          ? stored.proxy
          : rawProxy.includes("••••")
            ? stored.proxy
            : sanitizeTelegramProxyUrl(rawProxy);
      if (overrideProxy && overrideProxy !== stored.proxy && !explicitToken && stored.botToken) {
        return {
          ok: false,
          error: "修改 Telegram 代理测试连接时必须同时重新填写 Bot Token",
        };
      }
      const merged = {
        ...stored,
        ...(explicitToken ? { botToken: explicitToken } : {}),
        ...(overrideBase ? { apiBaseUrl: overrideBase } : {}),
        proxy: overrideProxy,
      };
      const res = await testTelegramChannel(merged, fetchImpl);
      if (res.ok && res.botName && (!targetAcctId || targetAcctId === stored.id)) {
        getRuntime("telegram-bot", stored.id).botName = res.botName;
      }
      return res;
    }

    const stored = isNewTest
      ? normalizeFeishuChannelConfig({})
      : (targetAcctId ? configs.feishuAccounts.find((a) => a.id === targetAcctId) : null) ||
        configs.feishuAccounts[0] ||
        configs["feishu-bot"];
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
    if (overrideBase && overrideBase !== stored.apiBaseUrl && !explicitSecret && stored.appSecret) {
      return {
        ok: false,
        error: "修改自定义飞书 API 地址测试连接时必须同时重新填写 App Secret",
      };
    }
    const overrideMode =
      overrideRaw?.connectionMode === "webhook" || overrideRaw?.connectionMode === "websocket"
        ? overrideRaw.connectionMode
        : undefined;
    const merged = {
      ...stored,
      ...(overrideRaw?.appId ? { appId: String(overrideRaw.appId).trim() } : {}),
      ...(explicitSecret ? { appSecret: explicitSecret } : {}),
      domain: overrideDomain,
      ...(overrideBase ? { apiBaseUrl: overrideBase } : {}),
      ...(overrideMode ? { connectionMode: overrideMode } : {}),
    };
    const res = await testFeishuChannel(merged, fetchImpl);
    if (res.ok && res.botName && (!targetAcctId || targetAcctId === stored.id)) {
      getRuntime("feishu-bot", stored.id).botName = res.botName;
    }
    return res;
  }

  function stopChannel(channelId: ChannelSkillId, accountId?: string): void {
    if (channelId === "telegram-bot") {
      stopTelegramPolling(accountId);
      for (const [k, rt] of runtimeStates.entries()) {
        if (k.startsWith("telegram-bot:") && (!accountId || k === accountKey("telegram-bot", accountId))) {
          rt.connected = false;
          rt.status = "stopped";
        }
      }
    } else {
      stopFeishuWebSocket(accountId);
      for (const [k, rt] of runtimeStates.entries()) {
        if (k.startsWith("feishu-bot:") && (!accountId || k === accountKey("feishu-bot", accountId))) {
          rt.connected = false;
          rt.status = "stopped";
        }
      }
    }
  }

  function reconnectAccount(channelId: ChannelSkillId, accountId?: string): void {
    stopChannel(channelId, accountId);
    syncFromStore();
    notifyStateChange();
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
    upsertAccount,
    deleteAccount,
    listPairings,
    approvePairing,
    rejectPairing,
    setApprovalEnabled,
    deleteApproval,
    reconnectAccount,
    stopChannel,
    stopAll,
  };
}
