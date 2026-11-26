import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import * as lark from "@larksuiteoapi/node-sdk";
import { Api as GrammyApi } from "grammy";
import { isSafePublicWebUrl } from "./web-search.js";

export type ChannelSkillId = "feishu-bot" | "telegram-bot";
export type ChannelApprovalMode = "channel_and_app" | "app_only";
export type TelegramConnectionMode = "polling" | "webhook";
export type FeishuConnectionMode = "websocket" | "webhook";
export type FeishuDomain = "feishu" | "lark";

export interface ChannelPendingPairing {
  code: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  createdAt: string;
}

export interface ChannelApprovedChat {
  chatId: string;
  senderId?: string;
  senderName?: string;
  approvedAt: string;
  enabled: boolean;
}

export interface TelegramChannelAccount {
  id: string;
  label: string;
  enabled: boolean;
  connectionMode: TelegramConnectionMode;
  botToken: string;
  webhookSecret: string;
  apiBaseUrl: string;
  proxy: string;
  defaultSessionId: string;
  requirePairing: boolean;
  allowedSenderIds: string[];
  approvedChats: ChannelApprovedChat[];
  pendingPairings: ChannelPendingPairing[];
  approvalMode: ChannelApprovalMode;
  updatedAt?: string;
}

export type TelegramChannelConfig = TelegramChannelAccount;

export interface FeishuChannelAccount {
  id: string;
  label: string;
  enabled: boolean;
  connectionMode: FeishuConnectionMode;
  domain: FeishuDomain;
  apiBaseUrl: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  defaultSessionId: string;
  requirePairing: boolean;
  allowedSenderIds: string[];
  approvedChats: ChannelApprovedChat[];
  pendingPairings: ChannelPendingPairing[];
  approvalMode: ChannelApprovalMode;
  updatedAt?: string;
}

export type FeishuChannelConfig = FeishuChannelAccount;

export interface ChannelsAuthStore {
  "telegram-bot": TelegramChannelAccount;
  "feishu-bot": FeishuChannelAccount;
  telegramAccounts: TelegramChannelAccount[];
  feishuAccounts: FeishuChannelAccount[];
  _tgMirrorSig?: string;
  _fsMirrorSig?: string;
}

export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
export const DEFAULT_FEISHU_API_BASE = "https://open.feishu.cn";
export const DEFAULT_LARK_API_BASE = "https://open.larksuite.com";
export const DEFAULT_FEISHU_ACCOUNT_ID = "fs_default";
export const DEFAULT_TELEGRAM_ACCOUNT_ID = "tg_default";

export const FEISHU_REACTION_TYPING = "Typing";
export const FEISHU_REACTION_FAILURE = "CrossMark";
export const TG_REACTION_TYPING = "👀";
export const TG_REACTION_FAILURE = "❌";

export function createChannelAccountId(channel: ChannelSkillId): string {
  const prefix = channel === "feishu-bot" ? "fs" : "tg";
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

export function sanitizeAccountId(raw: unknown, fallback: string): string {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

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

export function sanitizeTelegramProxyUrl(raw: unknown, fallback = ""): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const proto = u.protocol.toLowerCase();
    if (
      proto !== "http:" &&
      proto !== "https:" &&
      proto !== "socks5:" &&
      proto !== "socks5h:"
    ) {
      return fallback;
    }
    if (!u.hostname) return fallback;
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function redactProxyUrlForDisplay(proxyUrl: string): string {
  const clean = String(proxyUrl || "").trim();
  if (!clean) return "";
  try {
    const u = new URL(clean);
    if (!u.username && !u.password) {
      return `${u.protocol}//${u.host}`;
    }
    const user = decodeURIComponent(u.username || "");
    const auth = u.password ? `${user}:••••@` : `${user}@`;
    return `${u.protocol}//${auth}${u.host}`;
  } catch {
    return "";
  }
}

function normalizePendingPairings(raw: unknown): ChannelPendingPairing[] {
  if (!Array.isArray(raw)) return [];
  const out: ChannelPendingPairing[] = [];
  const seenCodes = new Set<string>();
  const seenChats = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const code = String((item as any).code || "").trim();
    const chatId = String((item as any).chatId || "").trim().slice(0, 128);
    if (!code || !chatId || seenCodes.has(code) || seenChats.has(chatId)) continue;
    seenCodes.add(code);
    seenChats.add(chatId);
    const senderId = String((item as any).senderId || chatId).trim().slice(0, 128);
    const senderName = String((item as any).senderName || "").trim().slice(0, 128);
    const createdAt =
      typeof (item as any).createdAt === "string" && (item as any).createdAt
        ? (item as any).createdAt
        : new Date().toISOString();
    out.push({
      code,
      chatId,
      senderId,
      ...(senderName && senderName !== senderId ? { senderName } : {}),
      createdAt,
    });
  }
  return out;
}

function normalizeApprovedChats(raw: unknown): ChannelApprovedChat[] {
  if (!Array.isArray(raw)) return [];
  const out: ChannelApprovedChat[] = [];
  const seenChats = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const chatId = String((item as any).chatId || "").trim().slice(0, 128);
    if (!chatId || seenChats.has(chatId)) continue;
    seenChats.add(chatId);
    const senderId = String((item as any).senderId || "").trim().slice(0, 128);
    const senderName = String((item as any).senderName || "").trim().slice(0, 128);
    const approvedAt =
      typeof (item as any).approvedAt === "string" && (item as any).approvedAt
        ? (item as any).approvedAt
        : new Date().toISOString();
    out.push({
      chatId,
      ...(senderId ? { senderId } : {}),
      ...(senderName ? { senderName } : {}),
      approvedAt,
      enabled: (item as any).enabled !== false,
    });
  }
  return out;
}

export function normalizeTelegramChannelConfig(
  raw: unknown,
  existing?: Partial<TelegramChannelAccount>
): TelegramChannelAccount {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const prev = existing || {};
  const incomingToken = cleanSecretInput(src.botToken);
  const incomingSecret = cleanSecretInput(src.webhookSecret);
  const proxyRaw =
    src.clearProxy === true
      ? ""
      : src.proxy !== undefined
        ? src.proxy
        : prev.proxy;
  const sanitizedProxy =
    typeof proxyRaw === "string" && proxyRaw.includes("••••") && prev.proxy
      ? String(prev.proxy)
      : sanitizeTelegramProxyUrl(proxyRaw, String(prev.proxy || ""));
  return {
    id: sanitizeAccountId(src.id !== undefined ? src.id : prev.id, DEFAULT_TELEGRAM_ACCOUNT_ID),
    label:
      typeof src.label === "string"
        ? src.label.trim().slice(0, 80)
        : String(prev.label || ""),
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
    proxy: sanitizedProxy,
    defaultSessionId:
      typeof src.defaultSessionId === "string"
        ? src.defaultSessionId.trim().slice(0, 128)
        : String(prev.defaultSessionId || ""),
    requirePairing:
      typeof src.requirePairing === "boolean"
        ? src.requirePairing
        : typeof prev.requirePairing === "boolean"
          ? prev.requirePairing
          : true,
    allowedSenderIds:
      src.allowedSenderIds !== undefined
        ? parseWhitelistIds(src.allowedSenderIds)
        : parseWhitelistIds(prev.allowedSenderIds),
    approvedChats:
      src.approvedChats !== undefined
        ? normalizeApprovedChats(src.approvedChats)
        : normalizeApprovedChats(prev.approvedChats),
    pendingPairings:
      src.pendingPairings !== undefined
        ? normalizePendingPairings(src.pendingPairings)
        : normalizePendingPairings(prev.pendingPairings),
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
  existing?: Partial<FeishuChannelAccount>
): FeishuChannelAccount {
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
    id: sanitizeAccountId(src.id !== undefined ? src.id : prev.id, DEFAULT_FEISHU_ACCOUNT_ID),
    label:
      typeof src.label === "string"
        ? src.label.trim().slice(0, 80)
        : String(prev.label || ""),
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
    requirePairing:
      typeof src.requirePairing === "boolean"
        ? src.requirePairing
        : typeof prev.requirePairing === "boolean"
          ? prev.requirePairing
          : true,
    allowedSenderIds:
      src.allowedSenderIds !== undefined
        ? parseWhitelistIds(src.allowedSenderIds)
        : parseWhitelistIds(prev.allowedSenderIds),
    approvedChats:
      src.approvedChats !== undefined
        ? normalizeApprovedChats(src.approvedChats)
        : normalizeApprovedChats(prev.approvedChats),
    pendingPairings:
      src.pendingPairings !== undefined
        ? normalizePendingPairings(src.pendingPairings)
        : normalizePendingPairings(prev.pendingPairings),
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

function mirrorSignature(obj: unknown): string {
  try {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(obj || {}), "utf8")
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "";
  }
}

function hasMeaningfulLegacyTelegramData(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  return Boolean(
    raw.enabled ||
      raw.botToken ||
      raw.webhookSecret ||
      raw.proxy ||
      raw.defaultSessionId ||
      (Array.isArray(raw.allowedSenderIds) && raw.allowedSenderIds.length > 0) ||
      (Array.isArray(raw.approvedChats) && raw.approvedChats.length > 0) ||
      (Array.isArray(raw.pendingPairings) && raw.pendingPairings.length > 0) ||
      raw.updatedAt
  );
}

function hasMeaningfulLegacyFeishuData(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  return Boolean(
    raw.enabled ||
      raw.appId ||
      raw.appSecret ||
      raw.verificationToken ||
      raw.encryptKey ||
      raw.defaultSessionId ||
      (Array.isArray(raw.allowedSenderIds) && raw.allowedSenderIds.length > 0) ||
      (Array.isArray(raw.approvedChats) && raw.approvedChats.length > 0) ||
      (Array.isArray(raw.pendingPairings) && raw.pendingPairings.length > 0) ||
      raw.updatedAt
  );
}

export function normalizeChannelsAuthStore(raw: unknown): ChannelsAuthStore {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};

  let telegramAccounts: TelegramChannelAccount[];
  if (Array.isArray(src.telegramAccounts)) {
    const seen = new Set<string>();
    telegramAccounts = [];
    for (const item of src.telegramAccounts) {
      const acct = normalizeTelegramChannelConfig(item);
      if (seen.has(acct.id)) continue;
      seen.add(acct.id);
      telegramAccounts.push(acct);
    }
    if (
      telegramAccounts.length > 0 &&
      src["telegram-bot"] &&
      typeof src["telegram-bot"] === "object" &&
      typeof src._tgMirrorSig === "string"
    ) {
      const normalizedLegacy = normalizeTelegramChannelConfig(src["telegram-bot"], {
        id: telegramAccounts[0].id,
      });
      if (
        mirrorSignature(normalizedLegacy) !== src._tgMirrorSig &&
        mirrorSignature(telegramAccounts[0]) === src._tgMirrorSig
      ) {
        telegramAccounts[0] = normalizedLegacy;
      }
    }
  } else if (hasMeaningfulLegacyTelegramData(src["telegram-bot"])) {
    telegramAccounts = [
      normalizeTelegramChannelConfig(src["telegram-bot"], { id: DEFAULT_TELEGRAM_ACCOUNT_ID }),
    ];
  } else {
    telegramAccounts = [];
  }

  let feishuAccounts: FeishuChannelAccount[];
  if (Array.isArray(src.feishuAccounts)) {
    const seen = new Set<string>();
    feishuAccounts = [];
    for (const item of src.feishuAccounts) {
      const acct = normalizeFeishuChannelConfig(item);
      if (seen.has(acct.id)) continue;
      seen.add(acct.id);
      feishuAccounts.push(acct);
    }
    if (
      feishuAccounts.length > 0 &&
      src["feishu-bot"] &&
      typeof src["feishu-bot"] === "object" &&
      typeof src._fsMirrorSig === "string"
    ) {
      const normalizedLegacy = normalizeFeishuChannelConfig(src["feishu-bot"], {
        id: feishuAccounts[0].id,
      });
      if (
        mirrorSignature(normalizedLegacy) !== src._fsMirrorSig &&
        mirrorSignature(feishuAccounts[0]) === src._fsMirrorSig
      ) {
        feishuAccounts[0] = normalizedLegacy;
      }
    }
  } else if (hasMeaningfulLegacyFeishuData(src["feishu-bot"])) {
    feishuAccounts = [
      normalizeFeishuChannelConfig(src["feishu-bot"], { id: DEFAULT_FEISHU_ACCOUNT_ID }),
    ];
  } else {
    feishuAccounts = [];
  }

  const primaryTg =
    telegramAccounts[0] || normalizeTelegramChannelConfig({ id: DEFAULT_TELEGRAM_ACCOUNT_ID });
  const primaryFs =
    feishuAccounts[0] || normalizeFeishuChannelConfig({ id: DEFAULT_FEISHU_ACCOUNT_ID });

  return {
    "telegram-bot": primaryTg,
    "feishu-bot": primaryFs,
    telegramAccounts,
    feishuAccounts,
    _tgMirrorSig: mirrorSignature(primaryTg),
    _fsMirrorSig: mirrorSignature(primaryFs),
  };
}

export function sanitizeTelegramChannelConfig(cfg: TelegramChannelAccount) {
  return {
    id: cfg.id,
    label: cfg.label,
    enabled: cfg.enabled,
    connectionMode: cfg.connectionMode,
    hasBotToken: Boolean(cfg.botToken),
    hasWebhookSecret: Boolean(cfg.webhookSecret),
    apiBaseUrl: cfg.apiBaseUrl,
    proxy: redactProxyUrlForDisplay(cfg.proxy),
    hasProxy: Boolean(cfg.proxy),
    defaultSessionId: cfg.defaultSessionId,
    requirePairing: cfg.requirePairing !== false,
    allowedSenderIds: [...cfg.allowedSenderIds],
    approvedChats: cfg.approvedChats.map((c) => ({ ...c })),
    pendingPairings: cfg.pendingPairings.map((p) => ({ ...p })),
    approvalMode: cfg.approvalMode,
    configured: Boolean(cfg.botToken),
    updatedAt: cfg.updatedAt || null,
  };
}

export function sanitizeFeishuChannelConfig(cfg: FeishuChannelAccount) {
  return {
    id: cfg.id,
    label: cfg.label,
    enabled: cfg.enabled,
    connectionMode: cfg.connectionMode,
    domain: cfg.domain,
    apiBaseUrl: cfg.apiBaseUrl,
    appId: cfg.appId,
    hasAppSecret: Boolean(cfg.appSecret),
    hasVerificationToken: Boolean(cfg.verificationToken),
    hasEncryptKey: Boolean(cfg.encryptKey),
    defaultSessionId: cfg.defaultSessionId,
    requirePairing: cfg.requirePairing !== false,
    allowedSenderIds: [...cfg.allowedSenderIds],
    approvedChats: cfg.approvedChats.map((c) => ({ ...c })),
    pendingPairings: cfg.pendingPairings.map((p) => ({ ...p })),
    approvalMode: cfg.approvalMode,
    configured: Boolean(cfg.appId && cfg.appSecret),
    updatedAt: cfg.updatedAt || null,
  };
}

export interface SanitizedChannelMeta {
  channel: ChannelSkillId;
  accountId?: string;
  accountLabel?: string;
  chatId?: string;
  senderId?: string;
  senderName?: string;
}

export function sanitizeChannelMeta(raw: unknown): SanitizedChannelMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const cm = raw as Record<string, any>;
  if (cm.channel !== "feishu-bot" && cm.channel !== "telegram-bot") return null;
  const trimCap = (val: unknown, maxLen: number): string | undefined => {
    const s = String(val ?? "").trim();
    return s ? s.slice(0, maxLen) : undefined;
  };
  const accountId = trimCap(cm.accountId, 64);
  const accountLabel = trimCap(cm.accountLabel, 80);
  const chatId = trimCap(cm.chatId, 120);
  const senderId = trimCap(cm.senderId, 120);
  const senderName = trimCap(cm.senderName, 80);
  return {
    channel: cm.channel,
    ...(accountId ? { accountId } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(chatId ? { chatId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
  };
}

export interface SanitizedClientSource {
  deviceKind: "mobile" | "desktop";
  platform?: string;
}

export function sanitizeClientSource(raw: unknown): SanitizedClientSource | null {
  if (!raw || typeof raw !== "object") return null;
  const cs = raw as Record<string, any>;
  if (cs.deviceKind !== "mobile" && cs.deviceKind !== "desktop") return null;
  const platform = String(cs.platform ?? "").trim().slice(0, 32);
  return {
    deviceKind: cs.deviceKind,
    ...(platform ? { platform } : {}),
  };
}

export function formatClientSourceHeader(clientSource: unknown): string {
  const cs = sanitizeClientSource(clientSource);
  if (!cs) return "";
  const p = (cs.platform || "").toLowerCase();
  if (cs.deviceKind === "mobile") {
    if (p === "ios-web") return "[消息来源：TwinkleBot 手机网页端（iOS）]";
    if (p === "android-web") return "[消息来源：TwinkleBot 手机网页端（Android）]";
    if (p === "mobile-web" || p === "web") return "[消息来源：TwinkleBot 手机网页端]";
    if (p === "ios") return "[消息来源：TwinkleBot 手机端（iOS）]";
    if (p === "android") return "[消息来源：TwinkleBot 手机端（Android）]";
    return "[消息来源：TwinkleBot 手机端]";
  }
  if (p === "web") return "[消息来源：TwinkleBot 桌面网页端]";
  if (p === "darwin" || p === "macos") return "[消息来源：TwinkleBot 桌面端（macOS）]";
  if (p === "win32" || p === "windows") return "[消息来源：TwinkleBot 桌面端（Windows）]";
  if (p === "linux") return "[消息来源：TwinkleBot 桌面端（Linux）]";
  return "[消息来源：TwinkleBot 桌面端]";
}

export function formatChannelSourceHeader(channelMeta: unknown): string {
  const cm = sanitizeChannelMeta(channelMeta);
  if (!cm) return "";
  const platformName = cm.channel === "feishu-bot" ? "飞书机器人" : "Telegram 机器人";
  const botLabel = cm.accountLabel ? `「${cm.accountLabel}」` : "";
  const senderLabel =
    cm.senderName && cm.senderId && cm.senderName !== cm.senderId
      ? `${cm.senderName} (${cm.senderId})`
      : cm.senderName || cm.senderId || cm.chatId || "未知用户";
  return `[消息来源：${platformName}${botLabel} · 发送者：${senderLabel}]`;
}

export function formatMessageSourceHeader(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "";
  const m = meta as Record<string, any>;
  const channelHeader = formatChannelSourceHeader(m.channelMeta);
  if (channelHeader) return channelHeader;
  return formatClientSourceHeader(m.clientSource);
}

function summarizeSingleAccountForBot(
  id: ChannelSkillId,
  cfg: Record<string, any>,
  rt: Record<string, any>
) {
  const allowedSenderIds = Array.isArray(cfg.allowedSenderIds)
    ? cfg.allowedSenderIds.map((v: any) => String(v))
    : [];
  const approvedChats = Array.isArray(cfg.approvedChats)
    ? cfg.approvedChats.map((c: any) => ({
        chatId: String(c.chatId || ""),
        ...(c.senderId ? { senderId: String(c.senderId) } : {}),
        ...(c.senderName ? { senderName: String(c.senderName) } : {}),
        approvedAt: String(c.approvedAt || ""),
        enabled: c.enabled !== false,
      }))
    : [];
  const pendingPairings = Array.isArray(cfg.pendingPairings)
    ? cfg.pendingPairings.map((p: any) => ({
        code: String(p.code || ""),
        chatId: String(p.chatId || ""),
        senderId: String(p.senderId || ""),
        ...(p.senderName ? { senderName: String(p.senderName) } : {}),
        createdAt: String(p.createdAt || ""),
      }))
    : [];
  const rawRejected =
    rt.lastRejectedSender && typeof rt.lastRejectedSender === "object"
      ? {
          senderId: String(rt.lastRejectedSender.senderId || ""),
          chatId: String(rt.lastRejectedSender.chatId || ""),
          ...(rt.lastRejectedSender.senderName
            ? { senderName: String(rt.lastRejectedSender.senderName) }
            : {}),
          at: String(rt.lastRejectedSender.at || ""),
        }
      : null;
  return {
    id: String(cfg.id || ""),
    label: String(cfg.label || ""),
    configured: Boolean(cfg.configured),
    enabled: Boolean(cfg.enabled),
    connectionMode: String(cfg.connectionMode || rt.mode || ""),
    ...(id === "feishu-bot"
      ? {
          domain: String(cfg.domain || "feishu"),
          appId: String(cfg.appId || ""),
        }
      : {}),
    defaultSessionId: String(cfg.defaultSessionId || ""),
    requirePairing: cfg.requirePairing !== false,
    allowedSenderIds,
    allowedSenderCount: allowedSenderIds.length,
    approvedChats,
    pendingPairings,
    connected: Boolean(rt.connected),
    status: String(rt.status || "stopped"),
    botName: String(rt.botName || ""),
    lastEventAt: rt.lastEventAt ? String(rt.lastEventAt) : null,
    lastError: rt.lastError ? String(rt.lastError) : null,
    lastSendError: rt.lastSendError ? String(rt.lastSendError) : null,
    lastRejectedSender: rawRejected,
  };
}

export function summarizeChannelStatusForBot(
  rawStatus: Record<string, any> | null | undefined
): Record<string, any> {
  if (!rawStatus || typeof rawStatus !== "object") return {};
  const out: Record<string, any> = {};
  for (const id of ["feishu-bot", "telegram-bot"] as const) {
    const entry = rawStatus[id];
    if (!entry || typeof entry !== "object") continue;
    const rawAccounts = Array.isArray(entry.accounts) && entry.accounts.length > 0
      ? entry.accounts
      : [{ config: entry.config, runtime: entry.runtime }];
    const accounts = rawAccounts.map((a: any) =>
      summarizeSingleAccountForBot(
        id,
        a?.config && typeof a.config === "object" ? a.config : {},
        a?.runtime && typeof a.runtime === "object" ? a.runtime : {}
      )
    );
    const primary = accounts[0] || summarizeSingleAccountForBot(id, {}, {});
    const pendingPairingCount = accounts.reduce(
      (sum: number, a: any) => sum + (a.pendingPairings?.length || 0),
      0
    );
    out[id] = {
      ...primary,
      configured: accounts.some((a: any) => a.configured),
      connected: accounts.some((a: any) => a.connected),
      accountCount: accounts.length,
      pendingPairingCount,
      accounts,
    };
  }
  return out;
}

export function generatePairingCode(existingCodes: Set<string> = new Set()): string {
  for (let i = 0; i < 64; i++) {
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    if (!existingCodes.has(code)) return code;
  }
  return String(Date.now() % 1_000_000).padStart(6, "0");
}

export function checkChatAuthorization(
  acct: Pick<FeishuChannelAccount, "approvedChats" | "allowedSenderIds">,
  senderId: string,
  chatId: string
): "approved" | "suspended" | "unapproved" {
  const cleanChat = String(chatId || "").trim();
  const cleanSender = String(senderId || "").trim();
  const approvedList = Array.isArray(acct.approvedChats) ? acct.approvedChats : [];
  const matched = approvedList.find(
    (c) =>
      (cleanChat && c.chatId === cleanChat) ||
      (cleanSender && (c.chatId === cleanSender || c.senderId === cleanSender))
  );
  if (matched) {
    return matched.enabled !== false ? "approved" : "suspended";
  }
  if (isSenderAllowed(acct.allowedSenderIds || [], [cleanSender, cleanChat])) {
    return "approved";
  }
  return "unapproved";
}

export function resolveFeishuApiBase(cfg: Pick<FeishuChannelConfig, "domain" | "apiBaseUrl">): string {
  if (cfg.apiBaseUrl) return cfg.apiBaseUrl.replace(/\/+$/, "");
  return cfg.domain === "lark" ? DEFAULT_LARK_API_BASE : DEFAULT_FEISHU_API_BASE;
}

export function resolveFeishuSdkDomain(
  cfg: Pick<FeishuChannelConfig, "domain" | "apiBaseUrl">
): string | lark.Domain {
  if (cfg.apiBaseUrl) return cfg.apiBaseUrl.replace(/\/+$/, "");
  return cfg.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

/**
 * Adapts a custom `fetch` implementation (e.g. unit-test mocks) to `@larksuiteoapi/node-sdk`'s
 * `HttpInstance` interface. In production (`fetchImpl === fetch`), we return `undefined` so the
 * official Lark SDK uses its built-in HTTP stack directly.
 */
export function createLarkHttpInstance(fetchImpl?: typeof fetch): any {
  if (!fetchImpl || fetchImpl === fetch) return undefined;
  const doRequest = async (opts: Record<string, any> = {}) => {
    const method = String(opts.method || "GET").toUpperCase();
    let targetUrl = String(opts.url || "");
    if (opts.params && typeof opts.params === "object") {
      const u = new URL(targetUrl);
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
      targetUrl = u.toString();
    }
    const headers: Record<string, string> = {};
    if (opts.headers && typeof opts.headers === "object") {
      for (const [k, v] of Object.entries(opts.headers)) {
        if (v !== undefined && v !== null) headers[k] = String(v);
      }
    }
    let body: string | undefined;
    if (opts.data !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof opts.data === "string") {
        body = opts.data;
      } else {
        body = JSON.stringify(opts.data);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json; charset=utf-8";
        }
      }
    }
    const resp = await fetchImpl(targetUrl, { method, headers, body });
    const parsed = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err: any = new Error(parsed?.msg || `Request failed with status code ${resp.status}`);
      err.response = { status: resp.status, data: parsed, headers: Object.fromEntries(resp.headers.entries()) };
      throw err;
    }
    if (opts.$return_headers) {
      return { resp: parsed, headers: Object.fromEntries(resp.headers.entries()) };
    }
    return parsed;
  };
  return {
    request: doRequest,
    get: (url: string, opts: any = {}) => doRequest({ ...opts, url, method: "GET" }),
    delete: (url: string, opts: any = {}) => doRequest({ ...opts, url, method: "DELETE" }),
    head: (url: string, opts: any = {}) => doRequest({ ...opts, url, method: "HEAD" }),
    options: (url: string, opts: any = {}) => doRequest({ ...opts, url, method: "OPTIONS" }),
    post: (url: string, data?: any, opts: any = {}) => doRequest({ ...opts, url, data, method: "POST" }),
    put: (url: string, data?: any, opts: any = {}) => doRequest({ ...opts, url, data, method: "PUT" }),
    patch: (url: string, data?: any, opts: any = {}) => doRequest({ ...opts, url, data, method: "PATCH" }),
  };
}

export function createLarkClient(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch
): lark.Client {
  return new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: resolveFeishuSdkDomain(cfg),
    loggerLevel: lark.LoggerLevel.error,
    httpInstance: createLarkHttpInstance(fetchImpl),
  });
}

function readSocketBytes(
  socket: net.Socket,
  predicate: (buf: Buffer) => boolean,
  signal?: AbortSignal | null,
  timeoutMs = 15_000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      if (predicate(acc)) {
        settled = true;
        cleanup();
        resolve(acc);
      }
    };
    const onErr = (err: Error) => finishErr(err);
    const onClose = () => finishErr(new Error("Proxy socket closed unexpectedly"));
    const onAbort = () => {
      try {
        socket.destroy();
      } catch {}
      finishErr(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {}
      finishErr(new Error("Proxy handshake timed out"));
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("close", onClose);
  });
}

function readExactBytes(
  socket: net.Socket,
  count: number,
  signal?: AbortSignal | null
): Promise<{ data: Buffer; extra: Buffer }> {
  return readSocketBytes(socket, (b) => b.length >= count, signal).then((buf) => ({
    data: buf.subarray(0, count),
    extra: buf.subarray(count),
  }));
}

async function openProxyTunnel(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal | null
): Promise<net.Socket> {
  const proto = proxy.protocol.toLowerCase();
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  const defaultPort = proto === "https:" ? 443 : proto === "http:" ? 80 : 1080;
  const proxyPort = Number(proxy.port || defaultPort);

  const socket: net.Socket =
    proto === "https:"
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })
      : net.connect({ host: proxyHost, port: proxyPort });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => {
      socket.off("connect", onReady);
      socket.off("secureConnect", onReady);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    };
    const onReady = () => {
      socket.off("error", onErr);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      try {
        socket.destroy();
      } catch {}
      onErr(new Error("Aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onErr);
    socket.once(proto === "https:" ? "secureConnect" : "connect", onReady);
  });

  const user = decodeURIComponent(proxy.username || "");
  const pass = decodeURIComponent(proxy.password || "");

  if (proto === "socks5:" || proto === "socks5h:") {
    const hasAuth = Boolean(user || pass);
    socket.write(
      hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])
    );
    const greet = await readExactBytes(socket, 2, signal);
    if (greet.data[0] !== 0x05) {
      socket.destroy();
      throw new Error("Invalid SOCKS5 greeting version");
    }
    const authMethod = greet.data[1];
    if (authMethod === 0x02) {
      const uBuf = Buffer.from(user, "utf8").subarray(0, 255);
      const pBuf = Buffer.from(pass, "utf8").subarray(0, 255);
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, uBuf.length]),
          uBuf,
          Buffer.from([pBuf.length]),
          pBuf,
        ])
      );
      const authRes = await readExactBytes(socket, 2, signal);
      if (authRes.data[1] !== 0x00) {
        socket.destroy();
        throw new Error("SOCKS5 username/password authentication failed");
      }
    } else if (authMethod !== 0x00) {
      socket.destroy();
      throw new Error(`Unsupported SOCKS5 auth method: ${authMethod}`);
    }

    const hostBuf = Buffer.from(targetHost, "utf8");
    if (hostBuf.length > 255) {
      socket.destroy();
      throw new Error("Target hostname exceeds SOCKS5 limit");
    }
    const portBuf = Buffer.allocUnsafe(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuf,
      ])
    );

    const head = await readSocketBytes(
      socket,
      (buf) => {
        if (buf.length < 4) return false;
        const atyp = buf[3];
        if (atyp === 0x01) return buf.length >= 10;
        if (atyp === 0x04) return buf.length >= 22;
        if (atyp === 0x03) {
          if (buf.length < 5) return false;
          return buf.length >= 7 + buf[4];
        }
        return true;
      },
      signal
    );
    if (head[1] !== 0x00) {
      socket.destroy();
      throw new Error(`SOCKS5 CONNECT failed (reply ${head[1]})`);
    }
    const atyp = head[3];
    const replyLen =
      atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + head[4] : 4;
    const extra = head.subarray(replyLen);
    if (extra.length > 0) socket.unshift(extra);
    return socket;
  }

  // HTTP/HTTPS CONNECT tunnel
  const connectTarget = `${targetHost}:${targetPort}`;
  const headerLines = [
    `CONNECT ${connectTarget} HTTP/1.1`,
    `Host: ${connectTarget}`,
  ];
  if (user || pass) {
    const creds = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
    headerLines.push(`Proxy-Authorization: Basic ${creds}`);
  }
  headerLines.push("Connection: keep-alive", "", "");
  socket.write(headerLines.join("\r\n"));

  const headerBuf = await readSocketBytes(
    socket,
    (buf) => buf.indexOf("\r\n\r\n") !== -1,
    signal
  );
  const splitIdx = headerBuf.indexOf("\r\n\r\n");
  const statusLine = headerBuf.subarray(0, splitIdx).toString("latin1").split("\r\n")[0] || "";
  const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
  const code = statusMatch ? Number(statusMatch[1]) : 0;
  if (code < 200 || code >= 300) {
    socket.destroy();
    throw new Error(`Proxy CONNECT failed (${statusLine || "unknown response"})`);
  }
  const extra = headerBuf.subarray(splitIdx + 4);
  if (extra.length > 0) socket.unshift(extra);
  return socket;
}

/**
 * Bridges polyfilled AbortSignal objects (e.g. grammy's `abort-controller` polyfill)
 * to a native `globalThis.AbortSignal` so Electron's WebIDL checks on `fetch`/`Request` succeed.
 */
function normalizeRequestInitSignal(init?: RequestInit): {
  init: RequestInit | undefined;
  cleanup: () => void;
} {
  const rawSignal = init?.signal as any;
  if (
    !rawSignal ||
    (typeof globalThis.AbortSignal !== "undefined" &&
      rawSignal instanceof globalThis.AbortSignal)
  ) {
    return { init, cleanup: () => {} };
  }
  const ctrl = new globalThis.AbortController();
  const onAbort = () => {
    if (!ctrl.signal.aborted) {
      ctrl.abort(rawSignal.reason);
    }
  };
  if (rawSignal.aborted) {
    onAbort();
  } else if (typeof rawSignal.addEventListener === "function") {
    rawSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    init: { ...(init || {}), signal: ctrl.signal },
    cleanup: () => {
      if (typeof rawSignal.removeEventListener === "function") {
        rawSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function wrapFetchWithNativeAbortSignal(targetFetch: typeof fetch): typeof fetch {
  return (async (input: any, init?: RequestInit): Promise<Response> => {
    const { init: safeInit, cleanup } = normalizeRequestInitSignal(init);
    try {
      return await targetFetch(input, safeInit);
    } finally {
      cleanup();
    }
  }) as typeof fetch;
}

export function createProxiedFetch(
  proxyUrl: string,
  baseFetch: typeof fetch = fetch
): typeof fetch {
  const cleanProxy = sanitizeTelegramProxyUrl(proxyUrl);
  if (!cleanProxy) return baseFetch;
  const parsedProxy = new URL(cleanProxy);

  const proxied = (async (input: any, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const targetUrl = new URL(req.url);
    if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
      throw new Error(`Unsupported target protocol: ${targetUrl.protocol}`);
    }
    const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, "");
    const targetPort = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));
    const method = (req.method || "GET").toUpperCase();
    const bodyBuf =
      method !== "GET" && method !== "HEAD" && req.body
        ? Buffer.from(await req.arrayBuffer())
        : undefined;

    const reqHeaders: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      reqHeaders[key] = value;
    });
    if (bodyBuf && !reqHeaders["content-length"]) {
      reqHeaders["content-length"] = String(bodyBuf.length);
    }

    const proxyProto = parsedProxy.protocol.toLowerCase();
    const isDirectHttpProxy =
      (proxyProto === "http:" || proxyProto === "https:") && targetUrl.protocol === "http:";

    if (isDirectHttpProxy) {
      const proxyHost = parsedProxy.hostname.replace(/^\[|\]$/g, "");
      const proxyPort = Number(parsedProxy.port || (proxyProto === "https:" ? 443 : 80));
      const user = decodeURIComponent(parsedProxy.username || "");
      const pass = decodeURIComponent(parsedProxy.password || "");
      const headers = {
        ...reqHeaders,
        host: targetUrl.host,
        ...(user || pass
          ? {
              "proxy-authorization": `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`,
            }
          : {}),
      };
      const transport = proxyProto === "https:" ? https : http;
      return await new Promise<Response>((resolve, reject) => {
        const clientReq = transport.request(
          {
            hostname: proxyHost,
            port: proxyPort,
            method,
            path: targetUrl.toString(),
            headers,
            agent: false,
            signal: init?.signal || undefined,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              const status = res.statusCode || 200;
              const buf = Buffer.concat(chunks);
              const outHeaders = new Headers();
              for (const [k, v] of Object.entries(res.headers)) {
                if (Array.isArray(v)) {
                  for (const item of v) outHeaders.append(k, item);
                } else if (v !== undefined) {
                  outHeaders.set(k, v);
                }
              }
              const bodyAllowed = status !== 204 && status !== 304 && status !== 205;
              resolve(
                new Response(bodyAllowed ? buf : null, {
                  status,
                  statusText: res.statusMessage || "",
                  headers: outHeaders,
                })
              );
            });
            res.on("error", reject);
          }
        );
        clientReq.on("error", reject);
        if (bodyBuf) clientReq.write(bodyBuf);
        clientReq.end();
      });
    }

    const tunnel = await openProxyTunnel(parsedProxy, targetHost, targetPort, init?.signal);
    const wrappedStream: net.Socket =
      targetUrl.protocol === "https:"
        ? tls.connect({ socket: tunnel, servername: targetHost })
        : tunnel;

    const transport = targetUrl.protocol === "https:" ? https : http;
    return await new Promise<Response>((resolve, reject) => {
      const clientReq = transport.request(
        {
          hostname: targetHost,
          port: targetPort,
          method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: reqHeaders,
          agent: false,
          createConnection: () => wrappedStream,
          signal: init?.signal || undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const status = res.statusCode || 200;
            const buf = Buffer.concat(chunks);
            const outHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) {
                for (const item of v) outHeaders.append(k, item);
              } else if (v !== undefined) {
                outHeaders.set(k, v);
              }
            }
            const bodyAllowed = status !== 204 && status !== 304 && status !== 205;
            resolve(
              new Response(bodyAllowed ? buf : null, {
                status,
                statusText: res.statusMessage || "",
                headers: outHeaders,
              })
            );
          });
          res.on("error", reject);
        }
      );
      clientReq.on("error", reject);
      if (bodyBuf) clientReq.write(bodyBuf);
      clientReq.end();
    });
  }) as typeof fetch;

  return wrapFetchWithNativeAbortSignal(proxied);
}

export function createTelegramFetch(
  cfg: Partial<Pick<TelegramChannelConfig, "proxy">>,
  fetchImpl: typeof fetch = fetch
): typeof fetch {
  if (fetchImpl === fetch && cfg.proxy) {
    return createProxiedFetch(cfg.proxy, fetchImpl);
  }
  return wrapFetchWithNativeAbortSignal(fetchImpl);
}

export function createTelegramApi(
  cfg: Pick<TelegramChannelConfig, "botToken" | "apiBaseUrl"> & { proxy?: string },
  fetchImpl: typeof fetch = fetch
): GrammyApi {
  const base = sanitizeChannelApiBaseUrl(cfg.apiBaseUrl, DEFAULT_TELEGRAM_API_BASE);
  const resolvedFetch = createTelegramFetch(cfg, fetchImpl);
  return new GrammyApi(cfg.botToken, {
    apiRoot: base,
    fetch: resolvedFetch as any,
    baseFetchConfig: {},
  });
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
  accountId?: string;
  eventId: string;
  messageId?: string;
  chatType?: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
}

function renderFeishuPostParagraph(elements: unknown): string {
  if (!Array.isArray(elements)) return "";
  const parts: string[] = [];
  for (const el of elements) {
    if (!el || typeof el !== "object") continue;
    const node = el as Record<string, any>;
    const tag = String(node.tag || "").toLowerCase();
    if (tag === "text") {
      if (typeof node.text === "string") parts.push(node.text);
    } else if (tag === "a") {
      const label = typeof node.text === "string" ? node.text : "";
      const href = typeof node.href === "string" ? node.href : "";
      if (label && href && !label.includes(href)) {
        parts.push(`${label} (${href})`);
      } else {
        parts.push(label || href);
      }
    } else if (tag === "at") {
      const uname = String(node.user_name || node.user_id || "").trim();
      if (uname) parts.push(`@${uname}`);
    } else if (tag === "code_block" || tag === "code") {
      const codeText = String(node.text || node.content || "");
      if (codeText) parts.push(codeText);
    }
  }
  return parts.join("");
}

export function extractFeishuMessageText(
  contentRaw: unknown,
  messageType = "text"
): string {
  if (typeof contentRaw !== "string") return "";
  const rawTrimmed = contentRaw.trim();
  if (!rawTrimmed) return "";
  let text = "";
  try {
    const parsed = JSON.parse(rawTrimmed);
    if (typeof parsed === "string") {
      text = parsed;
    } else if (parsed && typeof parsed === "object") {
      if (typeof parsed.text === "string" && messageType !== "post") {
        text = parsed.text;
      } else {
        const directPost =
          typeof parsed.title === "string" || Array.isArray(parsed.content)
            ? parsed
            : null;
        const localized =
          directPost ||
          parsed.zh_cn ||
          parsed.en_us ||
          parsed.ja_jp ||
          Object.values(parsed).find(
            (v: any) =>
              v &&
              typeof v === "object" &&
              (typeof v.title === "string" || Array.isArray(v.content))
          );
        if (localized && typeof localized === "object") {
          const lines: string[] = [];
          if (typeof (localized as any).title === "string" && (localized as any).title.trim()) {
            lines.push((localized as any).title.trim());
          }
          if (Array.isArray((localized as any).content)) {
            for (const para of (localized as any).content) {
              const line = renderFeishuPostParagraph(para).trim();
              if (line) lines.push(line);
            }
          }
          text = lines.join("\n");
        } else if (typeof parsed.text === "string") {
          text = parsed.text;
        }
      }
    }
  } catch {
    text = rawTrimmed;
  }
  return String(text || "").replace(/@_user_\d+\s*/g, "").trim();
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
  const messageId =
    msg.message_id !== undefined && msg.message_id !== null
      ? String(msg.message_id)
      : undefined;
  const chatType =
    typeof msg.chat?.type === "string" && msg.chat.type ? msg.chat.type : undefined;
  return {
    channel: "telegram-bot",
    eventId,
    ...(messageId ? { messageId } : {}),
    ...(chatType ? { chatType } : {}),
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

  const messageType = String(msg.message_type || msg.msg_type || "text").trim();
  const text = extractFeishuMessageText(msg.content, messageType);
  if (!text) return { kind: "ignore" };

  const eventId = `fs:${String(payload.header?.event_id || msg.message_id || Date.now())}`;
  const messageId =
    typeof msg.message_id === "string" && msg.message_id ? msg.message_id : undefined;
  const chatType =
    typeof msg.chat_type === "string" && msg.chat_type ? msg.chat_type : undefined;
  return {
    kind: "message",
    message: {
      channel: "feishu-bot",
      eventId,
      ...(messageId ? { messageId } : {}),
      ...(chatType ? { chatType } : {}),
      chatId,
      senderId,
      senderName: senderId,
      text,
    },
  };
}

export function parseFeishuSdkMessageEvent(data: any): ParsedInboundChannelMessage | null {
  if (!data || typeof data !== "object") return null;
  const msg = data.message;
  const sender = data.sender;
  if (!msg || typeof msg !== "object") return null;
  const chatId = String(msg.chat_id || "").trim();
  const senderId = String(
    sender?.sender_id?.open_id ||
      sender?.sender_id?.user_id ||
      sender?.sender_id?.union_id ||
      chatId
  ).trim();
  if (!chatId) return null;

  const messageType = String(msg.message_type || msg.msg_type || "text").trim();
  const text = extractFeishuMessageText(msg.content, messageType);
  if (!text) return null;

  const eventId = `fs:${String(data.event_id || msg.message_id || Date.now())}`;
  const messageId =
    typeof msg.message_id === "string" && msg.message_id ? msg.message_id : undefined;
  const chatType =
    typeof msg.chat_type === "string" && msg.chat_type ? msg.chat_type : undefined;
  return {
    channel: "feishu-bot",
    eventId,
    ...(messageId ? { messageId } : {}),
    ...(chatType ? { chatType } : {}),
    chatId,
    senderId,
    senderName: senderId,
    text,
  };
}

export async function testTelegramChannel(
  cfg: Pick<TelegramChannelConfig, "botToken" | "apiBaseUrl"> & { proxy?: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; botId?: number; botUsername?: string; botName?: string; error?: string }> {
  if (!cfg.botToken) {
    return { ok: false, error: "请先填写 Telegram Bot Token" };
  }
  try {
    const api = createTelegramApi(cfg, fetchImpl);
    const me = await api.getMe();
    return {
      ok: true,
      botId: me.id,
      botUsername: me.username || "",
      botName: me.first_name || me.username || "Telegram Bot",
    };
  } catch (err: any) {
    const innerMsg = (err?.error as any)?.description || (err?.error as any)?.message;
    const rawMsg =
      err?.description ||
      (innerMsg && err?.message ? `${err.message} (${innerMsg})` : err?.message) ||
      String(err);
    return {
      ok: false,
      error: String(rawMsg).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]"),
    };
  }
}

export async function sendTelegramMessage(
  cfg: Pick<TelegramChannelConfig, "botToken" | "apiBaseUrl"> & { proxy?: string },
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!cfg.botToken || !chatId) return;
  const api = createTelegramApi(cfg, fetchImpl);
  const chunks = chunkChannelText(text, 3900);
  for (const chunk of chunks) {
    await api.sendMessage(chatId, chunk);
  }
}

export async function setTelegramMessageReaction(
  cfg: Pick<TelegramChannelConfig, "botToken" | "apiBaseUrl"> & { proxy?: string },
  chatId: string,
  messageId: string,
  emoji: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const numMsg = Number(messageId);
  if (!cfg.botToken || !chatId || !Number.isFinite(numMsg) || numMsg <= 0) return;
  try {
    const api = createTelegramApi(cfg, fetchImpl);
    await api.setMessageReaction(
      chatId,
      numMsg,
      emoji ? [{ type: "emoji", emoji: emoji as any }] : []
    );
  } catch {
    // Best-effort reaction: never fail a turn if reaction permission is missing or unsupported
  }
}

export function formatFeishuApiError(
  code: unknown,
  msg: unknown,
  httpStatus?: number
): string {
  const numCode = typeof code === "number" ? code : Number(code);
  const rawMsg = String(msg || "").trim();
  if (numCode === 21001) {
    return "飞书平台策略拦截（code 21001：Access denied due to platform policy）。请确认：1) 应用创建在飞书「企业/团队组织」账号下（个人版或豆包关联账号会被平台拦截）；2) 已在飞书开放平台创建版本并发布生效；3) 企业安全策略 / IP 白名单未拦截当前网络出口。";
  }
  if (numCode === 10014 || numCode === 1000040345) {
    return `飞书 App ID 或 App Secret 无效（code ${numCode}），请核对凭据及飞书/Lark 区域选择。`;
  }
  if (rawMsg) {
    return Number.isFinite(numCode) && numCode > 0 ? `${rawMsg} (code ${numCode})` : rawMsg;
  }
  return `Feishu API failed (HTTP ${httpStatus ?? 0})`;
}

function extractLarkErrorInfo(err: any): { code?: number; msg?: string; status?: number } {
  const respData = err?.response?.data;
  const status = err?.response?.status;
  const msg = String(respData?.msg || err?.msg || err?.message || "").trim();
  let code =
    typeof respData?.code === "number"
      ? respData.code
      : typeof err?.code === "number"
        ? err.code
        : undefined;
  if (code === undefined && msg) {
    const m = msg.match(/\bcode\s*[:=]\s*(\d+)\b/i);
    if (m) code = Number(m[1]);
  }
  return { code, msg, status };
}

export async function fetchFeishuTenantAccessToken(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch
): Promise<{ token: string; expireSec: number }> {
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error("请先填写飞书 App ID 和 App Secret");
  }
  const client = createLarkClient(cfg, fetchImpl);
  let data: any;
  try {
    data = await client.auth.v3.tenantAccessToken.internal({
      data: {
        app_id: cfg.appId,
        app_secret: cfg.appSecret,
      },
    });
  } catch (rawErr: any) {
    const info = extractLarkErrorInfo(rawErr);
    const err: any = new Error(formatFeishuApiError(info.code, info.msg, info.status));
    if (info.code !== undefined) err.feishuCode = info.code;
    throw err;
  }
  if (data?.code !== 0 || !data?.tenant_access_token) {
    const err: any = new Error(formatFeishuApiError(data?.code, data?.msg, 200));
    if (data?.code !== undefined) err.feishuCode = Number(data.code);
    throw err;
  }
  return {
    token: String(data.tenant_access_token),
    expireSec: Math.max(60, Number(data.expire) || 7200),
  };
}

export async function probeFeishuWsEndpoint(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; wsUrl?: string; pingIntervalSec?: number; error?: string; code?: number }> {
  const base = resolveFeishuApiBase(cfg);
  const resp = await fetchImpl(`${base}/callback/ws/endpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", locale: "zh" },
    body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
  });
  const data: any = await resp.json().catch(() => ({}));
  const wsUrl = String(data?.data?.URL || data?.URL || "").trim();
  if (!resp.ok || !wsUrl) {
    return {
      ok: false,
      code: typeof data?.code === "number" ? data.code : undefined,
      error: formatFeishuApiError(data?.code, data?.msg, resp.status),
    };
  }
  const rawPing = Number(
    data?.data?.ClientConfig?.PingInterval ?? data?.ClientConfig?.PingInterval ?? 90
  );
  return {
    ok: true,
    wsUrl,
    pingIntervalSec: Math.max(15, Math.min(300, Number.isFinite(rawPing) ? rawPing : 90)),
  };
}

export async function testFeishuChannel(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl"> & {
    connectionMode?: FeishuConnectionMode;
  },
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; botName?: string; openId?: string; warning?: string; error?: string }> {
  try {
    const { token } = await fetchFeishuTenantAccessToken(cfg, fetchImpl);
    const client = createLarkClient(cfg, fetchImpl);
    let botName = `Feishu App (${cfg.appId})`;
    let openId = "";
    let warning = "";

    try {
      const infoData: any = await client.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (infoData?.code === 0 && infoData?.bot) {
        botName = infoData.bot.app_name || "Feishu Bot";
        openId = infoData.bot.open_id || "";
      } else if (typeof infoData?.code === "number" && infoData.code !== 0) {
        warning = `鉴权成功，但读取机器人信息返回 code ${infoData.code}（请确认已在飞书应用后台开启「机器人」能力并发布版本）`;
      }
    } catch (infoErr: any) {
      const info = extractLarkErrorInfo(infoErr);
      if (info.code) {
        warning = `鉴权成功，但读取机器人信息返回 code ${info.code}（请确认已在飞书应用后台开启「机器人」能力并发布版本）`;
      }
    }

    if (cfg.connectionMode === "websocket") {
      const wsProbe = await probeFeishuWsEndpoint(cfg, fetchImpl).catch((e: any) => ({
        ok: false,
        error: e?.message || String(e),
      }));
      if (!wsProbe.ok) {
        return {
          ok: false,
          error: `鉴权成功，但飞书长连接（WebSocket）入口校验失败：${wsProbe.error}`,
        };
      }
    }

    return {
      ok: true,
      botName,
      ...(openId ? { openId } : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err: any) {
    if (err?.feishuCode === 21001 && cfg.connectionMode === "websocket") {
      const wsProbe = await probeFeishuWsEndpoint(cfg, fetchImpl).catch(() => ({ ok: false }));
      if (wsProbe.ok) {
        return {
          ok: false,
          error: `App ID / App Secret 正确且飞书长连接入口可通，但获取发消息凭据 tenant_access_token 被飞书拦截：${err.message}`,
        };
      }
    }
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
  fetchImpl: typeof fetch = fetch,
  clientOverride?: lark.Client
): Promise<void> {
  if (!cfg.appId || !cfg.appSecret || !chatId) return;
  const client = clientOverride || createLarkClient(cfg, fetchImpl);
  const chunks = chunkChannelText(text, 3500);
  for (const chunk of chunks) {
    let data: any;
    try {
      data = await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
    } catch (rawErr: any) {
      const info = extractLarkErrorInfo(rawErr);
      const err: any = new Error(formatFeishuApiError(info.code, info.msg, info.status));
      if (info.code !== undefined) err.feishuCode = info.code;
      throw err;
    }
    if (typeof data?.code === "number" && data.code !== 0) {
      const err: any = new Error(formatFeishuApiError(data.code, data.msg, 200));
      err.feishuCode = Number(data.code);
      throw err;
    }
  }
}

export async function addFeishuMessageReaction(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  messageId: string,
  emojiType = FEISHU_REACTION_TYPING,
  fetchImpl: typeof fetch = fetch,
  clientOverride?: lark.Client
): Promise<string | null> {
  if (!cfg.appId || !cfg.appSecret || !messageId) return null;
  try {
    const client = clientOverride || createLarkClient(cfg, fetchImpl);
    const res = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    if (res?.code === 0 && res?.data?.reaction_id) {
      return String(res.data.reaction_id);
    }
  } catch {
    // Best-effort reaction: never fail a turn if reaction scope or token is unavailable
  }
  return null;
}

export async function deleteFeishuMessageReaction(
  cfg: Pick<FeishuChannelConfig, "appId" | "appSecret" | "domain" | "apiBaseUrl">,
  messageId: string,
  reactionId: string,
  fetchImpl: typeof fetch = fetch,
  clientOverride?: lark.Client
): Promise<void> {
  if (!cfg.appId || !cfg.appSecret || !messageId || !reactionId) return;
  try {
    const client = clientOverride || createLarkClient(cfg, fetchImpl);
    await client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {
    // Best-effort cleanup
  }
}
