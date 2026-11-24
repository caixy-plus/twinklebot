import crypto from "node:crypto";
import { isSafePublicWebUrl } from "./web-search.js";

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

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function cleanSecretInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";
  // Guard against accidental submission of UI masked placeholders (e.g. "••••••••" or "******")
  if (/^[•*·]+$/.test(s)) return "";
  return s;
}

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

export function sanitizeChannelApiBaseUrl(raw: unknown, fallback = ""): string {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return fallback;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return fallback;
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLoopback = host === "127.0.0.1" || host === "localhost";
    // Only allow public HTTPS endpoints (or explicit local loopback for self-hosted Bot API proxy / tests)
    if (u.protocol === "https:" && isSafePublicWebUrl(u.toString())) {
      return u.toString().replace(/\/+$/, "");
    }
    if (isLoopback) {
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
  const incomingToken = cleanSecretInput(src.botToken);
  const incomingSecret = cleanSecretInput(src.webhookSecret);
  return {
    enabled:
      typeof src.enabled === "boolean" ? src.enabled : Boolean(prev.enabled),
    connectionMode:
      src.connectionMode === "webhook" || src.connectionMode === "polling"
        ? src.connectionMode
        : prev.connectionMode === "webhook"
          ? "webhook"
          : "polling",
    botToken:
      src.clearBotToken === true
        ? ""
        : incomingToken || String(prev.botToken || ""),
    webhookSecret:
      src.clearWebhookSecret === true
        ? ""
        : incomingSecret || String(prev.webhookSecret || ""),
    apiBaseUrl: sanitizeChannelApiBaseUrl(
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
  const incomingSecret = cleanSecretInput(src.appSecret);
  const incomingVerify = cleanSecretInput(src.verificationToken);
  const incomingEncrypt = cleanSecretInput(src.encryptKey);
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
    apiBaseUrl: sanitizeChannelApiBaseUrl(
      src.apiBaseUrl !== undefined ? src.apiBaseUrl : prev.apiBaseUrl,
      ""
    ),
    appId:
      typeof src.appId === "string"
        ? src.appId.trim().slice(0, 128)
        : String(prev.appId || ""),
    appSecret:
      src.clearAppSecret === true
        ? ""
        : incomingSecret || String(prev.appSecret || ""),
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

/**
 * Minimal zero-dependency Protocol Buffers codec for Feishu / Lark WebSocket Long Connection (`pbbp2.Frame`).
 * Official schema (`@larksuiteoapi/node-sdk` `ws-client/proto-buf/pbbp2.proto`):
 *   Header: 1=key (string), 2=value (string)
 *   Frame:  1=SeqID (uint64), 2=LogID (uint64), 3=service (int32), 4=method (int32: 0=CONTROL, 1=DATA),
 *           5=headers (repeated Header), 6=payloadEncoding (string), 7=payloadType (string),
 *           8=payload (bytes), 9=LogIDNew (string)
 */
export interface FeishuPbHeader {
  key: string;
  value: string;
}

export interface FeishuPbFrame {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;
  headers: FeishuPbHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Buffer;
  logIdNew?: string;
}

function encodeVarint(val: bigint | number): Buffer {
  let n = typeof val === "bigint" ? val : BigInt(Math.max(0, Math.trunc(val)));
  if (n < 0n) n = BigInt.asUintN(64, n);
  const bytes: number[] = [];
  while (n >= 0x80n) {
    bytes.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, offset: number): { value: bigint; nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error("Feishu pbbp2 varint overflow");
    }
  }
  throw new Error("Unexpected EOF reading Feishu pbbp2 varint");
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeBytesField(fieldNumber: number, data: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(data.length), data]);
}

function encodeStringField(fieldNumber: number, str: string): Buffer {
  return encodeBytesField(fieldNumber, Buffer.from(str, "utf8"));
}

export function encodeFeishuPbFrame(frame: FeishuPbFrame): Buffer {
  const parts: Buffer[] = [
    Buffer.concat([encodeTag(1, 0), encodeVarint(frame.seqId)]),
    Buffer.concat([encodeTag(2, 0), encodeVarint(frame.logId)]),
    Buffer.concat([encodeTag(3, 0), encodeVarint(frame.service)]),
    Buffer.concat([encodeTag(4, 0), encodeVarint(frame.method)]),
  ];
  for (const h of frame.headers || []) {
    const hBuf = Buffer.concat([
      encodeStringField(1, String(h.key || "")),
      encodeStringField(2, String(h.value || "")),
    ]);
    parts.push(encodeBytesField(5, hBuf));
  }
  if (frame.payloadEncoding) {
    parts.push(encodeStringField(6, frame.payloadEncoding));
  }
  if (frame.payloadType) {
    parts.push(encodeStringField(7, frame.payloadType));
  }
  if (frame.payload && frame.payload.length > 0) {
    parts.push(encodeBytesField(8, frame.payload));
  }
  if (frame.logIdNew) {
    parts.push(encodeStringField(9, frame.logIdNew));
  }
  return Buffer.concat(parts);
}

function skipUnknownField(buf: Buffer, offset: number, wireType: number): number {
  if (wireType === 0) return readVarint(buf, offset).nextOffset;
  if (wireType === 1) {
    if (offset + 8 > buf.length) throw new Error("EOF in fixed64");
    return offset + 8;
  }
  if (wireType === 2) {
    const { value: len, nextOffset } = readVarint(buf, offset);
    const end = nextOffset + Number(len);
    if (end > buf.length) throw new Error("EOF in length-delimited field");
    return end;
  }
  if (wireType === 5) {
    if (offset + 4 > buf.length) throw new Error("EOF in fixed32");
    return offset + 4;
  }
  throw new Error(`Unsupported protobuf wireType ${wireType}`);
}

function decodeFeishuPbHeader(buf: Buffer): FeishuPbHeader {
  let pos = 0;
  let key = "";
  let value = "";
  while (pos < buf.length) {
    const { value: tag, nextOffset } = readVarint(buf, pos);
    pos = nextOffset;
    const fieldNo = Number(tag >> 3n);
    const wireType = Number(tag & 0x07n);
    if (wireType === 2 && (fieldNo === 1 || fieldNo === 2)) {
      const { value: len, nextOffset: dataStart } = readVarint(buf, pos);
      const dataEnd = dataStart + Number(len);
      if (dataEnd > buf.length) throw new Error("EOF in Feishu header string");
      const str = buf.subarray(dataStart, dataEnd).toString("utf8");
      if (fieldNo === 1) key = str;
      else value = str;
      pos = dataEnd;
    } else {
      pos = skipUnknownField(buf, pos, wireType);
    }
  }
  return { key, value };
}

export function decodeFeishuPbFrame(buf: Buffer): FeishuPbFrame {
  let pos = 0;
  const out: FeishuPbFrame = {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
  };
  while (pos < buf.length) {
    const { value: tag, nextOffset } = readVarint(buf, pos);
    pos = nextOffset;
    const fieldNo = Number(tag >> 3n);
    const wireType = Number(tag & 0x07n);
    if (wireType === 0 && (fieldNo >= 1 && fieldNo <= 4)) {
      const { value, nextOffset: afterVar } = readVarint(buf, pos);
      pos = afterVar;
      if (fieldNo === 1) out.seqId = value;
      else if (fieldNo === 2) out.logId = value;
      else if (fieldNo === 3) out.service = Number(BigInt.asIntN(32, value));
      else if (fieldNo === 4) out.method = Number(BigInt.asIntN(32, value));
    } else if (wireType === 2 && fieldNo >= 5 && fieldNo <= 9) {
      const { value: len, nextOffset: dataStart } = readVarint(buf, pos);
      const dataEnd = dataStart + Number(len);
      if (dataEnd > buf.length) throw new Error("EOF in Feishu frame bytes");
      const slice = Buffer.from(buf.subarray(dataStart, dataEnd));
      pos = dataEnd;
      if (fieldNo === 5) out.headers.push(decodeFeishuPbHeader(slice));
      else if (fieldNo === 6) out.payloadEncoding = slice.toString("utf8");
      else if (fieldNo === 7) out.payloadType = slice.toString("utf8");
      else if (fieldNo === 8) out.payload = slice;
      else if (fieldNo === 9) out.logIdNew = slice.toString("utf8");
    } else {
      pos = skipUnknownField(buf, pos, wireType);
    }
  }
  return out;
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

export interface ParseFeishuPayloadOptions {
  requireVerificationToken?: boolean;
  requireEncryptionIfConfigured?: boolean;
}

export function parseFeishuWebhookPayload(
  rawBody: any,
  cfg: Pick<FeishuChannelConfig, "verificationToken" | "encryptKey">,
  opts: ParseFeishuPayloadOptions = {}
):
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; message: ParsedInboundChannelMessage }
  | { kind: "ignore" } {
  const requireEncryption = opts.requireEncryptionIfConfigured !== false;
  let payload = rawBody;
  const hasEncryptedEnvelope = Boolean(
    payload && typeof payload.encrypt === "string" && payload.encrypt.trim()
  );
  if (cfg.encryptKey && requireEncryption && !hasEncryptedEnvelope) {
    throw new Error("Feishu encryptKey is configured; unencrypted webhook payload rejected");
  }
  if (hasEncryptedEnvelope) {
    payload = decryptFeishuEvent(payload.encrypt, cfg.encryptKey);
  }
  if (!payload || typeof payload !== "object") return { kind: "ignore" };

  const token = String(payload.token || payload.header?.token || "").trim();
  if (opts.requireVerificationToken && !cfg.verificationToken) {
    throw new Error("Feishu verificationToken is not configured");
  }
  if (cfg.verificationToken && !timingSafeEqualStr(token, cfg.verificationToken)) {
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
  const base = sanitizeChannelApiBaseUrl(cfg.apiBaseUrl, DEFAULT_TELEGRAM_API_BASE);
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
  const base = sanitizeChannelApiBaseUrl(cfg.apiBaseUrl, DEFAULT_TELEGRAM_API_BASE);
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
