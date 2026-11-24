import http from "node:http";
import type { ServerContext } from "../context.js";
import { parseJsonBody, sendJson } from "../http-utils.js";
import {
  normalizeChannelsAuthStore,
  normalizeFeishuChannelConfig,
  normalizeTelegramChannelConfig,
  type ChannelSkillId,
} from "../../lib/channel-integrations.js";

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
    return sendJson(res, result?.ok ? 200 : 400, result || { ok: false, error: "channel manager unavailable" });
  }

  // POST /api/integrations/channels/:channel
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
    const curStore = normalizeChannelsAuthStore(ctx.store?.readChannelsAuth?.() || {});
    const nowIso = new Date().toISOString();
    if (channelId === "telegram-bot") {
      const nextTg = {
        ...normalizeTelegramChannelConfig(body, curStore["telegram-bot"]),
        updatedAt: nowIso,
      };
      if (nextTg.enabled && nextTg.connectionMode === "webhook" && !nextTg.webhookSecret) {
        return sendJson(res, 400, {
          error: "启用 Telegram Webhook 模式时必须配置 Webhook Secret Token，以防未授权伪造调用",
        });
      }
      curStore["telegram-bot"] = nextTg;
    } else {
      const nextFs = {
        ...normalizeFeishuChannelConfig(body, curStore["feishu-bot"]),
        updatedAt: nowIso,
      };
      if (nextFs.enabled && nextFs.connectionMode === "webhook" && !nextFs.verificationToken) {
        return sendJson(res, 400, {
          error: "启用飞书 Webhook 模式时必须配置 Verification Token，以防未授权伪造调用",
        });
      }
      curStore["feishu-bot"] = nextFs;
    }
    ctx.store?.writeChannelsAuth?.(curStore);
    ctx.channelManager?.syncFromStore?.();
    ctx.broadcastSkillsUpdated();
    return sendJson(res, 200, {
      ok: true,
      channels: ctx.channelManager?.getStatusPayload?.() || {},
      settings: ctx.getMergedSettings(),
    });
  }

  // POST /api/channels/telegram/webhook (unauthenticated external callback -> strict 64KB cap)
  if (method === "POST" && pathname === "/api/channels/telegram/webhook") {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req, WEBHOOK_MAX_BODY_BYTES);
    } catch (err: any) {
      const status = err?.statusCode === 413 ? 413 : 400;
      return sendJson(res, status, { error: status === 413 ? "payload too large" : "invalid json" });
    }
    const out = await ctx.channelManager?.handleTelegramWebhook?.(body, req.headers);
    return sendJson(res, out?.status || 200, out?.body || { ok: true });
  }

  // POST /api/channels/feishu/webhook (unauthenticated external callback -> strict 64KB cap)
  if (method === "POST" && pathname === "/api/channels/feishu/webhook") {
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req, WEBHOOK_MAX_BODY_BYTES);
    } catch (err: any) {
      const status = err?.statusCode === 413 ? 413 : 400;
      return sendJson(res, status, { error: status === 413 ? "payload too large" : "invalid json" });
    }
    const out = await ctx.channelManager?.handleFeishuWebhook?.(body);
    return sendJson(res, out?.status || 200, out?.body || { ok: true });
  }

  return false;
}
