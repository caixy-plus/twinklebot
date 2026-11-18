import crypto from "node:crypto";
import {
  stripHeaderCrlf,
  normalizeMailConfig,
  normalizeMailAuthStore,
  verifyMailConnection,
} from "./mail-client.js";

/**
 * Shared mailbox account operations used by both the REST API (server.ts)
 * and the conversational `skill_configure_mail` Bot tool.
 * Secrets are only ever written to the store's 0o600 mail-auth file.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readAccounts(store: any): any[] {
  return normalizeMailAuthStore(store?.readMailAuth?.() || {}).accounts;
}

function writeAccounts(store: any, accounts: any[]): void {
  store?.writeMailAuth?.(normalizeMailAuthStore({ accounts }));
}

function fail(status: number, error: string) {
  return { ok: false as const, status, error };
}

export function findMailAccount(
  accounts: any[] = [],
  ref: unknown,
  { providers }: { providers?: string[] } = {}
) {
  const pool = Array.isArray(providers)
    ? accounts.filter((a) => providers.includes(a.provider))
    : accounts;
  const needle = String(ref || "").trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  return (
    pool.find((a) => a.id === needle) ||
    pool.find((a) => String(a.email || "").toLowerCase() === lower) ||
    pool.find((a) => a.label && a.label.toLowerCase() === lower) ||
    pool.find(
      (a) =>
        String(a.email || "").toLowerCase().includes(lower) ||
        (a.label && a.label.toLowerCase().includes(lower))
    ) ||
    null
  );
}

export async function upsertMailAccount(
  store: any,
  body: Record<string, any> = {},
  {
    forcedProvider = null,
    explicitId = null,
    verify = true,
    verifyFn = verifyMailConnection,
  }: {
    forcedProvider?: string | null;
    explicitId?: string | null;
    verify?: boolean;
    verifyFn?: typeof verifyMailConnection;
  } = {}
) {
  const accounts = readAccounts(store);
  const targetId = explicitId || (body.id ? String(body.id).trim() : "");
  let existingIdx = -1;

  if (targetId) {
    existingIdx = accounts.findIndex((a) => a.id === targetId);
    if (existingIdx === -1) return fail(404, "未找到指定的邮箱账号");
  } else if (body.email && body.forceNew !== true) {
    const lowerEmail = String(body.email).trim().toLowerCase();
    const wantProvider =
      forcedProvider || (body.provider === "qqmail" ? "qqmail" : "custom-mail");
    existingIdx = accounts.findIndex(
      (a) => a.email.toLowerCase() === lowerEmail && a.provider === wantProvider
    );
  } else if (
    forcedProvider &&
    !body.email &&
    accounts.filter((a) => a.provider === forcedProvider).length === 1
  ) {
    existingIdx = accounts.findIndex((a) => a.provider === forcedProvider);
  }

  const existing: Record<string, any> = existingIdx >= 0 ? accounts[existingIdx] : {};
  const provider =
    forcedProvider ||
    (body.provider === "qqmail"
      ? "qqmail"
      : existing.provider === "qqmail"
        ? "qqmail"
        : "custom-mail");

  const incomingSecret = String(body.password ?? body.authCode ?? "").replace(/\s+/g, "");
  const finalSecret = incomingSecret || String(existing.password || "");
  const cfg = normalizeMailConfig({ ...existing, ...body, password: finalSecret }, provider);

  if (!cfg.email || !EMAIL_RE.test(cfg.email)) return fail(400, "请输入有效的邮箱地址");
  if (!cfg.password) {
    return fail(
      400,
      provider === "qqmail"
        ? "请输入 QQ 邮箱 16 位 IMAP/SMTP 授权码"
        : "请输入邮箱密码或客户端授权码"
    );
  }
  if (!cfg.inboundHost || !cfg.smtpHost) {
    return fail(400, "请填写完整的收件服务器与 SMTP 发件服务器地址");
  }

  let inboxStats = existing.inboxStats || null;
  let lastVerifiedAt = existing.lastVerifiedAt || null;
  if (verify) {
    try {
      const v: any = await verifyFn(cfg);
      inboxStats = {
        messages: v.messages,
        ...(v.unseen !== undefined ? { unseen: v.unseen } : {}),
        latencyMs: v.latencyMs,
      };
      lastVerifiedAt = new Date().toISOString();
    } catch (err: any) {
      return fail(400, err?.message || "邮箱登录验证失败，请检查账号、授权码与服务器端口");
    }
  }

  const nowIso = new Date().toISOString();
  const wantDefault =
    body.isDefault === true ? true : body.isDefault === false ? false : Boolean(existing.isDefault);
  if (wantDefault) {
    for (const a of accounts) a.isDefault = false;
  }

  const record = {
    id: existing.id || crypto.randomUUID(),
    ...cfg,
    label: stripHeaderCrlf(body.label !== undefined ? body.label : existing.label || ""),
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled !== false,
    isDefault: wantDefault,
    createdAt: existing.createdAt || nowIso,
    updatedAt: nowIso,
    lastVerifiedAt,
    inboxStats,
  };

  if (existingIdx >= 0) accounts[existingIdx] = record;
  else accounts.push(record);
  writeAccounts(store, accounts);

  return { ok: true as const, record, created: existingIdx < 0, inboxStats };
}

export function setDefaultMailAccount(store: any, id: string) {
  const accounts = readAccounts(store);
  const target = accounts.find((a) => a.id === id);
  if (!target) return fail(404, "未找到指定的邮箱账号");
  for (const a of accounts) a.isDefault = a.id === id;
  writeAccounts(store, accounts);
  return { ok: true as const, record: target };
}

export function removeMailAccount(store: any, id: string) {
  const accounts = readAccounts(store);
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return fail(404, "未找到指定的邮箱账号");
  const [removed] = accounts.splice(idx, 1);
  writeAccounts(store, accounts);
  return { ok: true as const, removed };
}

export function purgeProviderAccounts(store: any, provider: string): number {
  const accounts = readAccounts(store);
  const remaining = accounts.filter((a) => a.provider !== provider);
  const removed = accounts.length - remaining.length;
  if (removed > 0) writeAccounts(store, remaining);
  return removed;
}
