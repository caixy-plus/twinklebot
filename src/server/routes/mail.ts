import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import type { ServerContext } from "../context.js";
import {
  DEFAULT_POLICY,
  DEFAULT_PRIVATE_SKILLS,
  FALLBACK_HTML,
  MIME_TYPES,
  SCREENSHOT_FILE_REGEX,
  UUID_REGEX,
  VALID_HOST_EXEC_MODES,
  VALID_PROFILE_COLORS,
  isInsideAllowedRoots,
  parseJsonBody,
  scanWorkspaceFiles,
  sendJson,
} from "../http-utils.js";
import {
  stripHeaderCrlf,
  normalizeMailConfig,
  normalizeMailAuthStore,
  sanitizeMailAccount,
  verifyMailConnection,
  sendMailMessage,
} from "../../lib/mail-client.js";
import {
  upsertMailAccount,
  removeMailAccount,
} from "../../lib/mail-accounts.js";

export async function handleMailRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        if (method === "GET" && pathname === "/api/integrations/mail") {
          const { mailAccounts, mailIntegrations } = ctx.getSanitizedMailState();
          return sendJson(res, 200, {
            accounts: mailAccounts,
            qqmail: mailIntegrations.qqmail,
            "custom-mail": mailIntegrations["custom-mail"],
            customMail: mailIntegrations["custom-mail"],
          });
        }

        // Helper for testing or upserting a mailbox (shared by multi-account & legacy endpoints)
        const MAIL_SKILL_NOT_INSTALLED = "请先在技能商店添加该邮箱技能后再配置";
        const resolveTargetMailProvider = ({
          body = {},
          forcedProvider,
          explicitId,
        }: {
          body?: Record<string, any>;
          forcedProvider?: string | null;
          explicitId?: string | null;
        }) => {
          const { accounts } = normalizeMailAuthStore(ctx.store?.readMailAuth?.() || {});
          const id = explicitId || (body.id ? String(body.id).trim() : "");
          if (id) {
            const hit = accounts.find((a) => a.id === id);
            if (hit) return hit.provider;
          }
          return forcedProvider || (body.provider === "qqmail" ? "qqmail" : "custom-mail");
        };

        const handleMailUpsertOrTest = async ({
          body = {},
          forcedProvider = null,
          isTestOnly = false,
          explicitId = null,
        }: {
          body?: Record<string, any>;
          forcedProvider?: string | null;
          isTestOnly?: boolean;
          explicitId?: string | null;
        }) => {
          const targetProvider = resolveTargetMailProvider({ body, forcedProvider, explicitId });
          if (!ctx.getInstalledSkills().includes(targetProvider)) {
            return sendJson(res, 400, { error: MAIL_SKILL_NOT_INSTALLED });
          }

          if (!isTestOnly) {
            const result = await upsertMailAccount(ctx.store, body, {
              forcedProvider,
              explicitId,
              verify: body.verify !== false,
            });
            if (!result.ok) {
              return sendJson(res, result.status, { error: result.error });
            }
            ctx.broadcastSkillsUpdated();
            const merged = ctx.getMergedSettings();
            const sanitizedSaved =
              merged.mailAccounts.find((a: any) => a.id === result.record.id) ||
              sanitizeMailAccount(result.record, result.record.provider);
            return sendJson(res, 200, {
              ok: true,
              account: sanitizedSaved,
              integration: sanitizedSaved,
              accounts: merged.mailAccounts,
              inboxStats: result.inboxStats,
              connectedApps: merged.connectedApps,
              mailIntegrations: merged.mailIntegrations,
            });
          }

          // Test-only: verify candidate (or saved) credentials without persisting new secrets
          const { accounts } = normalizeMailAuthStore(ctx.store?.readMailAuth?.() || {});
          const targetId = explicitId || (body.id ? String(body.id).trim() : "");
          let existingIdx = -1;
          if (targetId) {
            existingIdx = accounts.findIndex((a) => a.id === targetId);
            if (existingIdx === -1) {
              return sendJson(res, 404, { error: "未找到指定的邮箱账号" });
            }
          } else if (body.email && body.forceNew !== true) {
            const lowerEmail = String(body.email).trim().toLowerCase();
            existingIdx = accounts.findIndex(
              (a) => a.email.toLowerCase() === lowerEmail && a.provider === targetProvider
            );
          } else if (
            forcedProvider &&
            !body.email &&
            accounts.filter((a) => a.provider === forcedProvider).length === 1
          ) {
            existingIdx = accounts.findIndex((a) => a.provider === forcedProvider);
          }
          const existing: any = existingIdx >= 0 ? accounts[existingIdx] : {};
          const provider = existing.provider || targetProvider;
          const incomingSecret = String(body.password ?? body.authCode ?? "").replace(/\s+/g, "");
          const cfg = normalizeMailConfig(
            { ...existing, ...body, password: incomingSecret || String(existing.password || "") },
            provider
          );

          if (!cfg.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.email)) {
            return sendJson(res, 400, { error: "请输入有效的邮箱地址" });
          }
          if (!cfg.password) {
            return sendJson(res, 400, {
              error:
                provider === "qqmail"
                  ? "请输入 QQ 邮箱 16 位 IMAP/SMTP 授权码"
                  : "请输入邮箱密码或客户端授权码",
            });
          }
          if (!cfg.inboundHost || !cfg.smtpHost) {
            return sendJson(res, 400, {
              error: "请填写完整的收件服务器与 SMTP 发件服务器地址",
            });
          }

          try {
            const v = await verifyMailConnection(cfg);
            let sentInfo: any = null;
            if (body.sendTestMail) {
              sentInfo = await sendMailMessage(cfg, {
                to: cfg.email,
                subject: "TwinkleBot 邮箱连接测试成功",
                text: `你好！这是一封来自本地 TwinkleBot 的连通性测试邮件。\n\n账号备注：${
                  stripHeaderCrlf(body.label || existing.label || "") || "无"
                }\n接入类型：${
                  provider === "qqmail" ? "QQ 邮箱" : "通用邮箱"
                }\n收件协议：${cfg.inboundProtocol.toUpperCase()} (${cfg.inboundHost}:${cfg.inboundPort})\n发件协议：SMTP (${cfg.smtpHost}:${cfg.smtpPort})\n验证时间：${new Date().toLocaleString("zh-CN")}`,
              });
            }
            const inboxStats = {
              messages: v.messages,
              ...(v.unseen !== undefined ? { unseen: v.unseen } : {}),
              latencyMs: v.latencyMs,
            };
            if (existingIdx >= 0 && existing.email && existing.password) {
              accounts[existingIdx] = {
                ...existing,
                lastVerifiedAt: new Date().toISOString(),
                inboxStats,
              };
              ctx.store?.writeMailAuth?.(normalizeMailAuthStore({ accounts }));
            }
            const merged = ctx.getMergedSettings();
            return sendJson(res, 200, {
              ...v,
              ok: true,
              inboxStats,
              accounts: merged.mailAccounts,
              ...(sentInfo ? { testMailSent: true, messageId: sentInfo.messageId } : {}),
            });
          } catch (err: any) {
            return sendJson(res, 400, {
              error: err?.message || "邮箱服务器连接测试失败",
            });
          }
        };

        // POST /api/integrations/mail/accounts (Add or edit mailbox in multi-account list)
        if (method === "POST" && pathname === "/api/integrations/mail/accounts") {
          let body: Record<string, any> = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          return handleMailUpsertOrTest({ body, isTestOnly: false });
        }

        // POST /api/integrations/mail/test (Test candidate or edited mailbox)
        if (method === "POST" && pathname === "/api/integrations/mail/test") {
          let body: Record<string, any> = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          return handleMailUpsertOrTest({ body, isTestOnly: true });
        }

        // PATCH / DELETE / POST(/test) /api/integrations/mail/accounts/:id
        const mailAccountIdMatch = pathname.match(
          /^\/api\/integrations\/mail\/accounts\/([^/]+)(\/test)?$/
        );
        if (mailAccountIdMatch) {
          const accountId = mailAccountIdMatch[1];
          const isTestSub = Boolean(mailAccountIdMatch[2]);

          if (method === "POST" && isTestSub) {
            let body: Record<string, any> = {};
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            return handleMailUpsertOrTest({
              body,
              isTestOnly: true,
              explicitId: accountId,
            });
          }

          if (method === "PATCH" && !isTestSub) {
            let body: Record<string, any> = {};
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            return handleMailUpsertOrTest({
              body: { ...body, verify: Boolean(body.verify) },
              isTestOnly: false,
              explicitId: accountId,
            });
          }

          if (method === "DELETE" && !isTestSub) {
            const removed = removeMailAccount(ctx.store, accountId);
            if (!removed.ok) {
              return sendJson(res, removed.status, { error: removed.error });
            }
            ctx.broadcastSkillsUpdated();
            const merged = ctx.getMergedSettings();
            return sendJson(res, 200, {
              ok: true,
              accounts: merged.mailAccounts,
              connectedApps: merged.connectedApps,
              mailIntegrations: merged.mailIntegrations,
            });
          }
        }

        // Backward-compatible POST / DELETE /api/integrations/mail/:provider(& /test)
        const mailProviderMatch = pathname.match(
          /^\/api\/integrations\/mail\/(qqmail|custom-mail)(\/test)?$/
        );
        if (mailProviderMatch) {
          const provider = mailProviderMatch[1];
          const isTestSubroute = Boolean(mailProviderMatch[2]);

          if (method === "DELETE" && !isTestSubroute) {
            const targetId = url.searchParams.get("id") || "";
            const { accounts } = normalizeMailAuthStore(
              ctx.store?.readMailAuth?.() || {}
            );
            const remaining = targetId
              ? accounts.filter((a) => a.id !== targetId)
              : accounts.filter((a) => a.provider !== provider);
            ctx.store?.writeMailAuth?.(normalizeMailAuthStore({ accounts: remaining }));
            ctx.broadcastSkillsUpdated();
            const merged = ctx.getMergedSettings();
            return sendJson(res, 200, {
              ok: true,
              accounts: merged.mailAccounts,
              connectedApps: merged.connectedApps,
              mailIntegrations: merged.mailIntegrations,
            });
          }

          if (method === "POST") {
            let body: Record<string, any> = {};
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            return handleMailUpsertOrTest({
              body,
              forcedProvider: provider,
              isTestOnly: isTestSubroute,
            });
          }
        }

  return false;
}
