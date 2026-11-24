import crypto from "node:crypto";

export type ChannelSkillId = "feishu-bot" | "telegram-bot";
export type ChannelApprovalMode = "channel_and_app" | "app_only";
export type TelegramConnectionMode = "polling" | "webhook";
export type FeishuConnectionMode = "websocket" | "webhook";
export type FeishuDomain = "feishu" | "lark";

export interface TelegramChannelConfig {
  enabled: boolean;
  connectionMode: TelegramConnectionMode;
  botToken: string;
  webhookSecret: string;
  apiBaseUrl: string;
  defaultSessionId: string;
  allowedSenderIds: string[];
  approvalMode: ChannelApprovalMode;
  updatedAt?: string;
}

export interface FeishuChannelConfig {
  enabled: boolean;
  connectionMode: FeishuConnectionMode;
  domain: FeishuDomain;
  apiBaseUrl: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  defaultSessionId: string;
  allowedSenderIds: string[];
  approvalMode: ChannelApprovalMode;
  updatedAt?: string;
}

export interface ChannelsAuthStore {
  "telegram-bot": TelegramChannelConfig;
  "feishu-bot": FeishuChannelConfig;
}

export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
export const DEFAULT_FEISHU_API_BASE = "https://open.feishu.cn";
export const DEFAULT_LARK_API_BASE = "https://open.larksuite.com";

export function parseWhitelistIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map((x) => String(x || ""))
    : typeof raw === "string"
      ? raw.split(/[\s,;，；]+/)
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const clean = item.trim().slice(0, 128);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function sanitizeBaseUrl(raw: unknown, fallback = ""): string {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return fallback;
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.toString().replace(/\/+$/, "");
    }
  } catch {
    // ignore invalid custom URL
  }
  return fallback;
}

export function normalizeTelegramChannelConfig(
  raw: unknown,
  existing?: Partial<TelegramChannelConfig>
): TelegramChannelConfig {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const prev = existing || {};
  const incomingToken = typeof src.botToken === "string" ? src.botToken.trim() : "";
  const incomingSecret =
    typeof src.webhookSecret === "string" ? src.webhookSecret.trim() : "";
  return {
    enabled:
      typeof src.enabled === "boolean" ? src.enabled : Boolean(prev.enabled),
    connectionMode:
      src.connectionMode === "webhook" || src.connectionMode === "polling"
        ? src.connectionMode
        : prev.connectionMode === "webhook"
          ? "webhook"
          : "polling",
    botToken: incomingToken || String(prev.botToken || ""),
    webhookSecret:
      src.clearWebhookSecret === true
        ? ""
        : incomingSecret || String(prev.webhookSecret || ""),
    apiBaseUrl: sanitizeBaseUrl(
      src.apiBaseUrl !== undefined ? src.apiBaseUrl : prev.apiBaseUrl,
      DEFAULT_TELEGRAM_API_BASE
    ),
    defaultSessionId:
      typeof src.defaultSessionId === "string"
        ? src.defaultSessionId.trim().slice(0, 128)
        : String(prev.defaultSessionId || ""),
    allowedSenderIds:
      src.allowedSenderIds !== undefined
        ? parseWhitelistIds(src.allowedSenderIds)
        : parseWhitelistIds(prev.allowedSenderIds),
    approvalMode:
      src.approvalMode === "app_only" || src.approvalMode === "channel_and_app"
        ? src.approvalMode
        : prev.approvalMode === "app_only"
          ? "app_only"
          : "channel_and_app",
    updatedAt:
      typeof src.updatedAt === "string"
        ? src.updatedAt
        : prev.updatedAt || undefined,
  };
}

export function normalizeFeishuChannelConfig(
  raw: unknown,
  existing?: Partial<FeishuChannelConfig>
): FeishuChannelConfig {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const prev = existing || {};
  const domain: FeishuDomain =
    src.domain === "lark" || src.domain === "feishu"
      ? src.domain
      : prev.domain === "lark"
        ? "lark"
        : "feishu";
  const incomingSecret = typeof src.appSecret === "string" ? src.appSecret.trim() : "";
  const incomingVerify =
    typeof src.verificationToken === "string" ? src.verificationToken.trim() : "";
  const incomingEncrypt =
    typeof src.encryptKey === "string" ? src.encryptKey.trim() : "";
  return {
    enabled:
      typeof src.enabled === "boolean" ? src.enabled : Boolean(prev.enabled),
    connectionMode:
      src.connectionMode === "webhook" || src.connectionMode === "websocket"
        ? src.connectionMode
        : prev.connectionMode === "webhook"
          ? "webhook"
          : "websocket",
    domain,
    apiBaseUrl: sanitizeBaseUrl(
      src.apiBaseUrl !== undefined ? src.apiBaseUrl : prev.apiBaseUrl,
      ""
    ),
    appId:
      typeof src.appId === "string"
        ? src.appId.trim().slice(0, 128)
        : String(prev.appId || ""),
    appSecret: incomingSecret || String(prev.appSecret || ""),
    verificationToken:
      src.clearVerificationToken === true
        ? ""
        : incomingVerify || String(prev.verificationToken || ""),
    encryptKey:
      src.clearEncryptKey === true
        ? ""
        : incomingEncrypt || String(prev.encryptKey || ""),
    defaultSessionId:
      typeof src.defaultSessionId === "string"
        ? src.defaultSessionId.trim().slice(0, 128)
        : String(prev.defaultSessionId || ""),
    allowedSenderIds:
      src.allowedSenderIds !== undefined
        ? parseWhitelistIds(src.allowedSenderIds)
        : parseWhitelistIds(prev.allowedSenderIds),
    approvalMode:
      src.approvalMode === "app_only" || src.approvalMode === "channel_and_app"
        ? src.approvalMode
        : prev.approvalMode === "app_only"
          ? "app_only"
          : "channel_and_app",
    updatedAt:
      typeof src.updatedAt === "string"
        ? src.updatedAt
        : prev.updatedAt || undefined,
  };
}

export function normalizeChannelsAuthStore(raw: unknown): ChannelsAuthStore {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  return {
    "telegram-bot": normalizeTelegramChannelConfig(src["telegram-bot"]),
    "feishu-bot": normalizeFeishuChannelConfig(src["feishu-bot"]),
  };
}

export function sanitizeTelegramChannelConfig(cfg: TelegramChannelConfig) {
  return {
    enabled: cfg.enabled,
    connectionMode: cfg.connectionMode,
    hasBotToken: Boolean(cfg.botToken),
    hasWebhookSecret: Boolean(cfg.webhookSecret),
    apiBaseUrl: cfg.apiBaseUrl,
    defaultSessionId: cfg.defaultSessionId,
    allowedSenderIds: [...cfg.allowedSenderIds],
    approvalMode: cfg.approvalMode,
    configured: Boolean(cfg.botToken),
    updatedAt: cfg.updatedAt || null,
  };
}

export function sanitizeFeishuChannelConfig(cfg: FeishuChannelConfig) {
  return {
    enabled: cfg.enabled,
    connectionMode: cfg.connectionMode,
    domain: cfg.domain,
    apiBaseUrl: cfg.apiBaseUrl,
    appId: cfg.appId,
    hasAppSecret: Boolean(cfg.appSecret),
    hasVerificationToken: Boolean(cfg.verificationToken),
    hasEncryptKey: Boolean(cfg.encryptKey),
    defaultSessionId: cfg.defaultSessionId,
    allowedSenderIds: [...cfg.allowedSenderIds],
    approvalMode: cfg.approvalMode,
    configured: Boolean(cfg.appId && cfg.appSecret),
    updatedAt: cfg.updatedAt || null,
  };
}

export function resolveFeishuApiBase(cfg: Pick<FeishuChannelConfig, "domain" | "apiBaseUrl">): string {
  if (cfg.apiBaseUrl) return cfg.apiBaseUrl.replace(/\/+$/, "");
  return cfg.domain === "lark" ? DEFAULT_LARK_API_BASE : DEFAULT_FEISHU_API_BASE;
}

export function isSenderAllowed(
  allowedSenderIds: string[],
  candidateIds: Array<string | number | null | undefined>
): boolean {
  if (!Array.isArray(allowedSenderIds) || allowedSenderIds.length === 0) {
    return false;
  }
  const allowSet = new Set(allowedSenderIds.map((s) => String(s).trim()).filter(Boolean));
  if (allowSet.has("*")) return true;
  for (const cid of candidateIds) {
    const val = String(cid ?? "").trim();
    if (val && allowSet.has(val)) return true;
  }
  return false;
}

export function parseApprovalCommand(text: string): boolean | null {
  const norm = String(text || "").trim().toLowerCase();
  if (!norm) return null;
  if (
    norm === "/approve" ||
    norm === "approve" ||
    norm === "允许" ||
    norm === "同意" ||
    norm === "批准" ||
    norm === "确认" ||
    norm === "yes" ||
    norm === "y"
  ) {
    return true;
  }
  if (
    norm === "/deny" ||
    norm === "deny" ||
    norm === "拒绝" ||
    norm === "不同意" ||
    norm === "取消" ||
    norm === "no" ||
    norm === "n"
  ) {
    return false;
  }
  return null;
}

export function chunkChannelText(text: string, maxLen = 3800): string[] {
  const clean = String(text || "").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < Math.floor(maxLen * 0.5)) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Decrypts Feishu / Lark AES-256-CBC encrypted webhook event payload.
 * Spec: key = SHA256(encryptKey), payload = base64(iv[16] + ciphertext), PKCS7 padded UTF-8 JSON.
 */
export function decryptFeishuEvent(encryptedBase64: string, encryptKey: string): Record<string, any> {
  if (!encryptKey) {
    throw new Error("Feishu event is encrypted but encryptKey is not configured");
  }
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const rawBuf = Buffer.from(String(encryptedBase64 || ""), "base64");
  if (rawBuf.length < 32) {
    throw new Error("Invalid Feishu encrypted payload");
  }
  const iv = rawBuf.subarray(0, 16);
  const cipherData = rawBuf.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(cipherData), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted);
}

export interface ParsedInboundChannelMessage {
  channel: ChannelSkillId;
  eventId: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
}

export function parseTelegramUpdate(update: any): ParsedInboundChannelMessage | null {
  if (!update || typeof update !== "object") return null;
  const msg = update.message || update.edited_message;
  if (!msg || typeof msg !== "object") return null;
  const text = String(msg.text || msg.caption || "").trim();
  if (!text) return null;
  const chatId = String(msg.chat?.id ?? "").trim();
  const senderId = String(msg.from?.id ?? chatId).trim();
  if (!chatId) return null;
  const firstName = String(msg.from?.first_name || "").trim();
  const lastName = String(msg.from?.last_name || "").trim();
  const username = String(msg.from?.username || "").trim();
  const senderName =
    [firstName, lastName].filter(Boolean).join(" ") || username || senderId;
  const eventId = `tg:${update.update_id ?? msg.message_id ?? Date.now()}`;
  return {
    channel: "telegram-bot",
    eventId,
    chatId,
    senderId,
    senderName,
    text,
  };
}

export function parseFeishuWebhookPayload(
  rawBody: any,
  cfg: Pick<FeishuChannelConfig, "verificationToken" | "encryptKey">
):
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; message: ParsedInboundChannelMessage }
  | { kind: "ignore" } {
  let payload = rawBody;
  if (payload && typeof payload.encrypt === "string" && payload.encrypt.trim()) {
    payload = decryptFeishuEvent(payload.encrypt, cfg.encryptKey);
  }
  if (!payload || typeof payload !== "object") return { kind: "ignore" };

  const token = String(payload.token || payload.header?.token || "").trim();
  if (cfg.verificationToken && token !== cfg.verificationToken) {
    throw new Error("invalid Feishu verification token");
  }

  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return { kind: "challenge", challenge: payload.challenge };
  }

  const eventType = String(payload.header?.event_type || payload.event?.type || "");
  if (eventType !== "im.message.receive_v1") {
    return { kind: "ignore" };
  }

  const msg = payload.event?.message;
  const sender = payload.event?.sender;
  if (!msg || typeof msg !== "object") return { kind: "ignore" };
  const chatId = String(msg.chat_id || "").trim();
  const senderId = String(
    sender?.sender_id?.open_id ||
      sender?.sender_id?.user_id ||
      sender?.sender_id?.union_id ||
      chatId
  ).trim();
  if (!chatId) return { kind: "ignore" };

  let text = "";
  if (typeof msg.content === "string") {
    try {
      const parsed = JSON.parse(msg.content);
      text = String(parsed?.text || "").trim();
    } catch {
      text = msg.content.trim();
    }
  }
  // Strip Feishu @mention placeholders like @_user_1
  text = text.replace(/@_user_\d+\s*/g, "").trim();
  if (!text) return { kind: "ignore" };

  const eventId = `fs:${String(payload.header?.event_id || msg.message_id || Date.now())}`;
  return {
    kind: "message",
    message: {
      channel: "feishu-bot",
      eventId,
      chatId,
      senderId,
      senderName: senderId,
      text,
    },
  };
}

export async function testTelegramChannel(
  cfg: Pick<TelegramChannelConfig, "botToken" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; botId?: number; botUsername?: string; botName?: string; error?: string }> {
  if (!cfg.botToken) {
    return { ok: false, error: "请先填写 Telegram Bot Token" };
  }
  const base = (cfg.apiBaseUrl || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");
  const resp = await fetchImpl(`${base}/bot${encodeURIComponent(cfg.botToken)}/getMe`, {
    method: "GET",
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok || !data?.result) {
    return {
      ok: false,
      error: data?.description || `Telegram API HTTP ${resp.status}`,
    };
  }
  return {
    ok: true,
    botId: data.result.id,
    botUsername: data.result.username || "",
    botName: data.result.first_name || data.result.username || "Telegram Bot",
  };
}

export async function sendTelegramMessage(
  cfg: Pick<TelegramChannelConfig, "botToken" | "apiBaseUrl">,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!cfg.botToken || !chatId) return;
  const base = (cfg.apiBaseUrl || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");
  const chunks = chunkChannelText(text, 3900);
  for (const chunk of chunks) {
    await fetchImpl(`${base}/bot${encodeURIComponent(cfg.botToken)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
      }),
    });
  }
}

export async function fetchFeishuTenantAccessToken(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch
): Promise<{ token: string; expireSec: number }> {
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error("请先填写飞书 App ID 和 App Secret");
  }
  const base = resolveFeishuApiBase(cfg);
  const resp = await fetchImpl(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: cfg.appId,
      app_secret: cfg.appSecret,
    }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0 || !data?.tenant_access_token) {
    throw new Error(data?.msg || `Feishu auth failed (HTTP ${resp.status})`);
  }
  return {
    token: String(data.tenant_access_token),
    expireSec: Math.max(60, Number(data.expire) || 7200),
  };
}

export async function testFeishuChannel(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; botName?: string; openId?: string; error?: string }> {
  try {
    const { token } = await fetchFeishuTenantAccessToken(cfg, fetchImpl);
    const base = resolveFeishuApiBase(cfg);
    const infoResp = await fetchImpl(`${base}/open-apis/bot/v3/info`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const infoData: any = await infoResp.json().catch(() => ({}));
    if (infoResp.ok && infoData?.code === 0 && infoData?.bot) {
      return {
        ok: true,
        botName: infoData.bot.app_name || "Feishu Bot",
        openId: infoData.bot.open_id || "",
      };
    }
    return {
      ok: true,
      botName: `Feishu App (${cfg.appId})`,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}

export async function sendFeishuMessage(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  chatId: string,
  text: string,
  tokenGetter: () => Promise<string>,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!cfg.appId || !cfg.appSecret || !chatId) return;
  const base = resolveFeishuApiBase(cfg);
  const token = await tokenGetter();
  const chunks = chunkChannelText(text, 3500);
  for (const chunk of chunks) {
    await fetchImpl(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: chunk }),
      }),
    });
  }
}
