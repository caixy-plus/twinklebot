import http from "node:http";
import type { ServerContext } from "../context.js";
import { parseJsonBody, sendJson } from "../http-utils.js";
import type { ChannelSkillId } from "../../lib/channel-integrations.js";

const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

function isChannelId(id: string): id is ChannelSkillId {
  return id === "feishu-bot" || id === "telegram-bot";
}

export async function handleChannelRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
  // GET /api/integrations/channels
  if (method === "GET" && pathname === "/api/integrations/channels") {
    const payload = ctx.channelManager?.getStatusPayload?.() || {};
    return sendJson(res, 200, { ok: true, channels: payload });
  }

  // Pairing management endpoints (MUST match before /:channel catch-all)
  // GET /api/integrations/channels/pairings
  if (method === "GET" && pathname === "/api/integrations/channels/pairings") {
    const pairings = ctx.channelManager?.listPairings?.() || { pending: [], approved: [] };
    return sendJson(res, 200, { ok: true, ...pairings });
  }

  // POST /api/integrations/channels/pairings/approve
  if (method === "POST" && pathname === "/api/integrations/channels/pairings/approve") {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const result = ctx.channelManager?.approvePairing?.(String(body.code || ""));
    if (!result?.ok) {
      return sendJson(res, 404, { ok: false, error: result?.error || "pairing code not found" });
    }
    ctx.broadcastSkillsUpdated();
    return sendJson(res, 200, {
      ...result,
      channels: ctx.channelManager?.getStatusPayload?.() || {},
      settings: ctx.getMergedSettings(),
    });
  }

  // POST /api/integrations/channels/pairings/reject
  if (method === "POST" && pathname === "/api/integrations/channels/pairings/reject") {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const result = ctx.channelManager?.rejectPairing?.(String(body.code || ""));
    if (!result?.ok) {
      return sendJson(res, 404, { ok: false, error: result?.error || "pairing code not found" });
    }
    ctx.broadcastSkillsUpdated();
    return sendJson(res, 200, {
      ...result,
      channels: ctx.channelManager?.getStatusPayload?.() || {},
      settings: ctx.getMergedSettings(),
    });
  }

  // POST /api/integrations/channels/pairings/toggle
  if (method === "POST" && pathname === "/api/integrations/channels/pairings/toggle") {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const channelId = String(body.channel || "");
    if (!isChannelId(channelId)) {
      return sendJson(res, 400, { error: "invalid channel" });
    }
    const result = ctx.channelManager?.setApprovalEnabled?.(
      channelId,
      String(body.accountId || ""),
      String(body.chatId || ""),
      Boolean(body.enabled)
    );
    if (!result?.ok) {
      return sendJson(res, 404, { ok: false, error: result?.error || "approved chat not found" });
    }
    ctx.broadcastSkillsUpdated();
    return sendJson(res, 200, {
      ...result,
      channels: ctx.channelManager?.getStatusPayload?.() || {},
      settings: ctx.getMergedSettings(),
    });
  }

  // DELETE /api/integrations/channels/pairings/approved
  if (method === "DELETE" && pathname === "/api/integrations/channels/pairings/approved") {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const channelId = String(body.channel || "");
    if (!isChannelId(channelId)) {
      return sendJson(res, 400, { error: "invalid channel" });
    }
    const result = ctx.channelManager?.deleteApproval?.(
      channelId,
      String(body.accountId || ""),
      String(body.chatId || "")
    );
    if (!result?.ok) {
      return sendJson(res, 404, { ok: false, error: result?.error || "approved chat not found" });
    }
    ctx.broadcastSkillsUpdated();
    return sendJson(res, 200, {
      ...result,
      channels: ctx.channelManager?.getStatusPayload?.() || {},
      settings: ctx.getMergedSettings(),
    });
  }

  // POST /api/integrations/channels/:channel/accounts/:accountId/test
  const acctTestMatch = pathname.match(
    /^\/api\/integrations\/channels\/([^/]+)\/accounts\/([^/]+)\/test$/
  );
  if (method === "POST" && acctTestMatch) {
    const channelId = decodeURIComponent(acctTestMatch[1]);
    const accountId = decodeURIComponent(acctTestMatch[2]);
    if (!isChannelId(channelId)) {
      return sendJson(res, 404, { error: "unknown channel" });
    }
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const result = await ctx.channelManager?.testChannel?.(channelId, body, accountId);
    return sendJson(
      res,
      result?.ok ? 200 : 400,
      result || { ok: false, error: "channel manager unavailable" }
    );
  }

  // POST /api/integrations/channels/:channel/accounts (create a new bot instance)
  const acctCreateMatch = pathname.match(/^\/api\/integrations\/channels\/([^/]+)\/accounts$/);
  if (method === "POST" && acctCreateMatch) {
    const channelId = decodeURIComponent(acctCreateMatch[1]);
    if (!isChannelId(channelId)) {
      return sendJson(res, 404, { error: "unknown channel" });
    }
    if (!ctx.getInstalledSkills().includes(channelId)) {
      return sendJson(res, 400, {
        error: "请先在技能商店添加该渠道技能后再配置",
      });
    }
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const saved = ctx.channelManager?.upsertAccount?.(channelId, body, { createNew: true });
    if (!saved?.ok) {
      return sendJson(res, saved?.status || 400, { error: saved?.error || "save failed" });
    }
    ctx.broadcastSkillsUpdated();
    return sendJson(res, 200, {
      ok: true,
      accountId: saved.accountId,
      channels: ctx.channelManager?.getStatusPayload?.() || {},
      settings: ctx.getMergedSettings(),
    });
  }

  // PATCH / DELETE /api/integrations/channels/:channel/accounts/:accountId
  const acctItemMatch = pathname.match(
    /^\/api\/integrations\/channels\/([^/]+)\/accounts\/([^/]+)$/
  );
  if (acctItemMatch) {
    const channelId = decodeURIComponent(acctItemMatch[1]);
    const accountId = decodeURIComponent(acctItemMatch[2]);
    if (!isChannelId(channelId)) {
      return sendJson(res, 404, { error: "unknown channel" });
    }
    if (method === "PATCH") {
      if (!ctx.getInstalledSkills().includes(channelId)) {
        return sendJson(res, 400, {
          error: "请先在技能商店添加该渠道技能后再配置",
        });
      }
      let body: Record<string, any> = {};
      try {
        body = await parseJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "invalid json" });
      }
      const saved = ctx.channelManager?.upsertAccount?.(channelId, body, { accountId });
      if (!saved?.ok) {
        return sendJson(res, saved?.status || 400, { error: saved?.error || "save failed" });
      }
      ctx.broadcastSkillsUpdated();
      return sendJson(res, 200, {
        ok: true,
        accountId: saved.accountId,
        channels: ctx.channelManager?.getStatusPayload?.() || {},
        settings: ctx.getMergedSettings(),
      });
    }
    if (method === "DELETE") {
      const removed = ctx.channelManager?.deleteAccount?.(channelId, accountId);
      if (!removed?.ok) {
        return sendJson(res, removed?.status || 404, { error: removed?.error || "delete failed" });
      }
      ctx.broadcastSkillsUpdated();
      return sendJson(res, 200, {
        ok: true,
        channels: ctx.channelManager?.getStatusPayload?.() || {},
        settings: ctx.getMergedSettings(),
      });
    }
  }

  // POST /api/integrations/channels/:channel/test
  const testMatch = pathname.match(/^\/api\/integrations\/channels\/([^/]+)\/test$/);
  if (method === "POST" && testMatch) {
    const channelId = decodeURIComponent(testMatch[1]);
    if (!isChannelId(channelId)) {
      return sendJson(res, 404, { error: "unknown channel" });
    }
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const result = await ctx.channelManager?.testChannel?.(channelId, body);
    return sendJson(
      res,
      result?.ok ? 200 : 400,
      result || { ok: false, error: "channel manager unavailable" }
    );
  }

  // POST /api/integrations/channels/:channel (legacy primary-bot upsert)
  const cfgMatch = pathname.match(/^\/api\/integrations\/channels\/([^/]+)$/);
  if (method === "POST" && cfgMatch) {
    const channelId = decodeURIComponent(cfgMatch[1]);
    if (!isChannelId(channelId)) {
      return sendJson(res, 404, { error: "unknown channel" });
    }
    if (!ctx.getInstalledSkills().includes(channelId)) {
      return sendJson(res, 400, {
        error: "请先在技能商店添加该渠道技能后再配置",
      });
    }
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const saved = ctx.channelManager?.upsertAccount?.(channelId, body, {
      accountId: body.accountId ? String(body.accountId) : undefined,
    });
    if (!saved?.ok) {
      return sendJson(res, saved?.status || 400, { error: saved?.error || "save failed" });
    }
    ctx.broadcastSkillsUpdated();
    return sendJson(res, 200, {
      ok: true,
      accountId: saved.accountId,
      channels: ctx.channelManager?.getStatusPayload?.() || {},
      settings: ctx.getMergedSettings(),
    });
  }

  // POST /api/channels/telegram/webhook[/:accountId] (unauthenticated external callback -> strict 64KB cap)
  const tgWebhookMatch = pathname.match(/^\/api\/channels\/telegram\/webhook(?:\/([^/]+))?$/);
  if (method === "POST" && tgWebhookMatch) {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req, WEBHOOK_MAX_BODY_BYTES);
    } catch (err: any) {
      const status = err?.statusCode === 413 ? 413 : 400;
      return sendJson(res, status, { error: status === 413 ? "payload too large" : "invalid json" });
    }
    const accountId = tgWebhookMatch[1] ? decodeURIComponent(tgWebhookMatch[1]) : undefined;
    const out = await ctx.channelManager?.handleTelegramWebhook?.(body, req.headers, accountId);
    return sendJson(res, out?.status || 200, out?.body || { ok: true });
  }

  // POST /api/channels/feishu/webhook[/:accountId] (unauthenticated external callback -> strict 64KB cap)
  const fsWebhookMatch = pathname.match(/^\/api\/channels\/feishu\/webhook(?:\/([^/]+))?$/);
  if (method === "POST" && fsWebhookMatch) {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req, WEBHOOK_MAX_BODY_BYTES);
    } catch (err: any) {
      const status = err?.statusCode === 413 ? 413 : 400;
      return sendJson(res, status, { error: status === 413 ? "payload too large" : "invalid json" });
    }
    const accountId = fsWebhookMatch[1] ? decodeURIComponent(fsWebhookMatch[1]) : undefined;
    const out = await ctx.channelManager?.handleFeishuWebhook?.(body, accountId);
    return sendJson(res, out?.status || 200, out?.body || { ok: true });
  }

  return false;
}
