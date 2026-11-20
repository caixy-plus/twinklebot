import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import type { ServerContext } from "../context.js";
import { stripVaultItemSecret } from "../../store/index.js";
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
import { computeInitialNextRun } from "../../agent/scheduler.js";

export async function handleSchedulesVaultRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        if (method === "GET" && pathname === "/api/mcp/status") {
          const serverId = url.searchParams.get("server") || "kimi-cu";
          const connect = url.searchParams.get("connect") !== "false";
          const st = await ctx.activeMcpManager.getServerStatus(serverId, { connect });
          return sendJson(res, 200, st);
        }

        // POST /api/mcp/reconnect
        if (method === "POST" && pathname === "/api/mcp/reconnect") {
          let body: Record<string, any> = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const serverId = String(body?.serverId || "kimi-cu").trim() || "kimi-cu";
          const st = await ctx.activeMcpManager.reconnectServer(serverId);
          return sendJson(res, 200, st);
        }



        // GET / POST / PATCH / DELETE /api/schedules
        if (pathname === "/api/schedules") {
          if (method === "GET") {
            return sendJson(res, 200, {
              schedules: ctx.store?.readSchedules?.() || [],
            });
          }
          if (method === "POST") {
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            if (!body?.sessionId || !body?.title || !body?.prompt) {
              return sendJson(res, 400, {
                error: "sessionId, title, and prompt are required",
              });
            }
            const list = ctx.store?.readSchedules?.() || [];
            const repeat = body.repeat || "daily";
            const scheduleLabel = body.scheduleLabel || "每天 10:00";
            const item = {
              id: crypto.randomUUID(),
              sessionId: body.sessionId,
              title: String(body.title).trim(),
              scheduleLabel,
              repeat,
              prompt: String(body.prompt).trim(),
              nextRunAt:
                body.nextRunAt ||
                computeInitialNextRun({
                  repeat,
                  scheduleLabel,
                  time: body.time,
                  delayMinutes: body.delayMinutes,
                }),
              enabled: body.enabled !== false,
              createdAt: new Date().toISOString(),
            };
            list.unshift(item);
            ctx.store?.writeSchedules?.(list);
            ctx.runner?.broadcastGlobal?.({
              type: "schedules_updated",
              sessionId: item.sessionId,
            });
            return sendJson(res, 201, item);
          }
        }

        const scheduleIdMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
        if (scheduleIdMatch) {
          const sid = scheduleIdMatch[1];
          const list = ctx.store?.readSchedules?.() || [];
          const idx = list.findIndex((x: any) => x.id === sid);
          if (idx === -1) {
            return sendJson(res, 404, { error: "schedule not found" });
          }
          if (method === "PATCH") {
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            list[idx] = { ...list[idx], ...body, id: sid };
            ctx.store?.writeSchedules?.(list);
            ctx.runner?.broadcastGlobal?.({
              type: "schedules_updated",
              sessionId: list[idx].sessionId,
            });
            return sendJson(res, 200, list[idx]);
          }
          if (method === "DELETE") {
            const removed = list[idx];
            list.splice(idx, 1);
            ctx.store?.writeSchedules?.(list);
            ctx.runner?.broadcastGlobal?.({
              type: "schedules_updated",
              sessionId: removed?.sessionId,
            });
            return sendJson(res, 200, { ok: true });
          }
        }

        // GET / POST / DELETE /api/vault
        if (pathname === "/api/vault") {
          if (method === "GET") {
            const items =
              ctx.store?.readVaultPublic?.() ||
              (ctx.store?.readVault?.() || []).map(stripVaultItemSecret);
            return sendJson(res, 200, { items });
          }
          if (method === "POST") {
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            if (!body?.title) {
              return sendJson(res, 400, { error: "title is required" });
            }
            const items = ctx.store?.readVault?.() || [];
            const incomingId = typeof body.id === "string" ? body.id.trim() : "";
            const hasIncomingPassword = body.password !== undefined;
            const normalizedPassword =
              body.password === null || body.password === ""
                ? undefined
                : typeof body.password === "string"
                  ? body.password
                  : undefined;

            if (incomingId) {
              const idx = items.findIndex((x: any) => x.id === incomingId);
              if (idx !== -1) {
                const updated: Record<string, any> = {
                  ...items[idx],
                  category: body.category || items[idx].category || "contact",
                  title: String(body.title).trim(),
                  subtitle:
                    body.subtitle !== undefined
                      ? String(body.subtitle || "").trim()
                      : items[idx].subtitle || "",
                  notes:
                    body.notes !== undefined
                      ? String(body.notes || "").trim()
                      : items[idx].notes || "",
                };
                if (hasIncomingPassword) {
                  if (normalizedPassword) {
                    updated.password = normalizedPassword;
                  } else {
                    delete updated.password;
                  }
                }
                items[idx] = updated;
                ctx.store?.writeVault?.(items);
                return sendJson(res, 200, stripVaultItemSecret(updated));
              }
            }
            const created: Record<string, any> = {
              id: crypto.randomUUID(),
              category: body.category || "contact",
              title: String(body.title).trim(),
              subtitle: String(body.subtitle || "").trim(),
              notes: String(body.notes || "").trim(),
              ...(normalizedPassword ? { password: normalizedPassword } : {}),
            };
            items.unshift(created);
            ctx.store?.writeVault?.(items);
            return sendJson(res, 201, stripVaultItemSecret(created));
          }
        }

        const vaultRevealMatch = pathname.match(/^\/api\/vault\/([^/]+)\/reveal$/);
        if (method === "POST" && vaultRevealMatch) {
          const vid = decodeURIComponent(vaultRevealMatch[1]);
          const items = ctx.store?.readVault?.() || [];
          const found = items.find((x: any) => x.id === vid);
          if (!found) {
            return sendJson(res, 404, { error: "vault item not found" });
          }
          const password = typeof found.password === "string" ? found.password : "";
          return sendJson(res, 200, {
            id: found.id,
            hasPassword: password.length > 0,
            password,
          });
        }

        const vaultIdMatch = pathname.match(/^\/api\/vault\/([^/]+)$/);
        if (method === "PATCH" && vaultIdMatch) {
          const vid = decodeURIComponent(vaultIdMatch[1]);
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const items = ctx.store?.readVault?.() || [];
          const idx = items.findIndex((x: any) => x.id === vid);
          if (idx === -1) {
            return sendJson(res, 404, { error: "vault item not found" });
          }
          const nextTitle =
            body?.title !== undefined ? String(body.title).trim() : String(items[idx].title || "").trim();
          if (!nextTitle) {
            return sendJson(res, 400, { error: "title is required" });
          }
          const updated: Record<string, any> = {
            ...items[idx],
            category: body?.category || items[idx].category || "contact",
            title: nextTitle,
            subtitle:
              body?.subtitle !== undefined
                ? String(body.subtitle || "").trim()
                : items[idx].subtitle || "",
            notes:
              body?.notes !== undefined
                ? String(body.notes || "").trim()
                : items[idx].notes || "",
          };
          if (body?.password !== undefined) {
            if (typeof body.password === "string" && body.password.length > 0) {
              updated.password = body.password;
            } else {
              delete updated.password;
            }
          }
          items[idx] = updated;
          ctx.store?.writeVault?.(items);
          return sendJson(res, 200, stripVaultItemSecret(updated));
        }

        if (method === "DELETE" && vaultIdMatch) {
          const vid = decodeURIComponent(vaultIdMatch[1]);
          const items = (ctx.store?.readVault?.() || []).filter((x: any) => x.id !== vid);
          ctx.store?.writeVault?.(items);
          return sendJson(res, 200, { ok: true });
        }

  return false;
}
