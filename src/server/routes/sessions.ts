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
  sendJson,
} from "../http-utils.js";
import {
  removeBotWorkspaceDir,
  resolveBotWorkspaceRoot,
  scanWorkspaceFiles,
} from "../../lib/bot-workspace.js";
import { buildSessionCostSummary } from "../../agent/pricing.js";
import { detectSemanticStopIntent } from "../../agent/stop-detector.js";
import {
  VALID_BOT_BROWSER_MODES,
  normalizeBotBrowserMode,
} from "../../shared/browser-automation.js";

export async function handleSessionRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        if (method === "GET" && pathname === "/api/sessions") {
          ctx.store?.ensureAdminBot?.();
          const sessions = ctx.store?.listSessions?.() || [];
          const runnerStatus = ctx.runner?.status?.() || {
            sessionId: null,
            state: "idle",
          };
          const activeMap = ctx.runner?.activeSessions?.() || {};
          return sendJson(res, 200, {
            sessions,
            runner: runnerStatus,
            activeSessions: activeMap,
          });
        }

        // POST /api/sessions
        if (method === "POST" && pathname === "/api/sessions") {
          let body: Record<string, any> = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }

          const title =
            (body && typeof body.title === "string" && body.title.trim()) ||
            "New Session";
          const session = ctx.store?.createSession?.({
            title,
            type: body.type === "group" ? "group" : body.type,
            avatar: body.avatar,
            rolePrompt: body.rolePrompt,
            memberBotIds: body.memberBotIds,
            pinned: false,
            isAdmin: false,
          });
          ctx.runner?.broadcastGlobal?.({
            type: "bot_created",
            sessionId: session.id,
            bot: session,
          });
          return sendJson(res, 201, session);
        }


        const exchangeMatch = pathname.match(/^\/api\/exchanges\/([^/]+)$/);
        if (method === "GET" && exchangeMatch) {
          const ex = ctx.store?.getExchange?.(exchangeMatch[1]);
          if (!ex) {
            return sendJson(res, 404, { error: "exchange not found" });
          }
          return sendJson(res, 200, ex);
        }


        const cloneMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/clone$/);
        if (method === "POST" && cloneMatch) {
          const id = cloneMatch[1];
          let body: Record<string, any> = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            body = {};
          }
          const cloned = ctx.store?.cloneSession?.(id, body);
          if (!cloned) {
            return sendJson(res, 404, { error: "session not found" });
          }
          ctx.runner?.broadcastGlobal?.({
            type: "bot_created",
            sessionId: cloned.id,
            bot: cloned,
          });
          return sendJson(res, 201, cloned);
        }

        // GET /api/sessions/:id/library
        const libMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/library$/);
        if (method === "GET" && libMatch) {
          const id = libMatch[1];
          const session = ctx.store?.getSession?.(id);
          if (!session) {
            return sendJson(res, 404, { error: "session not found" });
          }
          const screenshots = (ctx.store?.listScreenshots?.(id) || []).map((s: any) => ({
            name: `桌面截图 ${s.file}`,
            type: "media",
            size: s.size,
            mtime: s.mtime,
            url: s.url,
            source: "screen",
          }));
          const workspaceRoot = resolveBotWorkspaceRoot({
            config: ctx.finalConfig,
            sessionId: id,
          });
          const workspaceFiles = scanWorkspaceFiles(workspaceRoot, 40);
          return sendJson(res, 200, {
            workspaceRoot,
            items: [...screenshots, ...workspaceFiles],
          });
        }

        // GET / PATCH / DELETE /api/sessions/:id
        const sessionGetMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (sessionGetMatch) {
          const id = sessionGetMatch[1];
          if (method === "GET") {
            const session = ctx.store?.getSession?.(id);
            if (!session) {
              return sendJson(res, 404, { error: "session not found" });
            }
            const events = ctx.store?.readEvents?.(id) || [];
            const usageSummary = buildSessionCostSummary(session, {
              readEvents: () => events,
              defaultModel: ctx.finalConfig.defaultModel,
              providers: ctx.resolveRawProviders?.() || [],
              includeDisabled: false,
            });
            const queueLength =
              typeof ctx.runner?.queueStatus === "function" ? ctx.runner.queueStatus(id) : 0;
            const activeMap = ctx.runner?.activeSessions?.() || {};
            const activeState = Object.prototype.hasOwnProperty.call(activeMap, id)
              ? activeMap[id]
              : null;
            return sendJson(res, 200, {
              session,
              events,
              usageSummary,
              queueLength,
              activeState,
            });
          }

          if (method === "PATCH") {
            const session = ctx.store?.getSession?.(id);
            if (!session) {
              return sendJson(res, 404, { error: "session not found" });
            }
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            const allowedPatch: Record<string, any> = {};
            if (typeof body.title === "string" && body.title.trim()) {
              allowedPatch.title = body.title.trim().slice(0, 52);
            }
            if (body.avatar && typeof body.avatar === "object") {
              allowedPatch.avatar = body.avatar;
            }
            if (typeof body.rolePrompt === "string") {
              allowedPatch.rolePrompt = body.rolePrompt;
            }
            if ("browserMode" in body) {
              if (
                body.browserMode !== null &&
                body.browserMode !== "" &&
                !VALID_BOT_BROWSER_MODES.includes(body.browserMode)
              ) {
                return sendJson(res, 400, { error: "invalid browserMode" });
              }
              allowedPatch.browserMode = normalizeBotBrowserMode(body.browserMode);
            }
            if (Array.isArray(body.memories)) {
              allowedPatch.memories = body.memories;
            }
            if (typeof body.pinned === "boolean") {
              if (session.isAdmin === true && body.pinned === false) {
                return sendJson(res, 400, { error: "管理员 Bot 独占置顶位，不可取消置顶" });
              }
              if (session.isAdmin !== true && body.pinned === true) {
                return sendJson(res, 400, { error: "仅管理员 Bot 可置顶，普通 Bot 不支持置顶" });
              }
              allowedPatch.pinned = body.pinned;
            }
            if (typeof body.unreadCount === "number") {
              allowedPatch.unreadCount = Math.max(0, body.unreadCount);
              allowedPatch.touch = false;
            }
            if (Array.isArray(body.memberBotIds)) {
              allowedPatch.memberBotIds = body.memberBotIds;
            }
            if (body.touch === false) {
              allowedPatch.touch = false;
            }
            let updated;
            try {
              updated = ctx.store?.updateSession?.(id, allowedPatch);
            } catch (err: any) {
              return sendJson(res, 400, { error: err?.message || "更新失败" });
            }
            try {
              ctx.runner?.broadcastGlobal?.({
                type: "session_updated",
                sessionId: id,
                session: updated,
              });
            } catch {
              // ignore
            }
            return sendJson(res, 200, updated);
          }

          if (method === "DELETE") {
            const existing = ctx.store?.getSession?.(id);
            if (!existing) {
              return sendJson(res, 404, { error: "session not found" });
            }
            if (existing.isAdmin === true) {
              return sendJson(res, 403, { error: "管理员 Bot 严禁删除" });
            }
            ctx.runner?.stop?.(id);
            const ok = ctx.store?.deleteSession?.(id);
            if (!ok) {
              return sendJson(res, 404, { error: "session not found" });
            }
            try {
              removeBotWorkspaceDir({
                config: ctx.finalConfig,
                sessionId: id,
              });
            } catch {
              // ignore workspace cleanup errors after session metadata removal
            }
            if (!existing.isAdmin && existing.type !== "group" && ctx.executor?.call) {
              Promise.resolve(ctx.executor.call("/displays/release", { bot_id: id })).catch(() => {});
            }
            return sendJson(res, 200, { ok: true });
          }
        }

        // POST /api/sessions/:id/clear
        const clearSessionMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/clear$/
        );
        if (method === "POST" && clearSessionMatch) {
          const id = clearSessionMatch[1];
          const existing = ctx.store?.getSession?.(id);
          if (!existing) {
            return sendJson(res, 404, { error: "session not found" });
          }
          ctx.runner?.stop?.(id);
          const updated = ctx.store?.clearSession?.(id);
          if (!updated) {
            return sendJson(res, 404, { error: "session not found" });
          }
          try {
            ctx.runner?.broadcastGlobal?.({
              type: "session_cleared",
              sessionId: id,
              session: updated,
            });
            ctx.runner?.broadcastGlobal?.({
              type: "session_updated",
              sessionId: id,
              session: updated,
            });
          } catch {
            // ignore
          }
          return sendJson(res, 200, { ok: true, session: updated });
        }

        // POST /api/sessions/:id/edit-message
        const editMsgMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/edit-message$/
        );
        if (method === "POST" && editMsgMatch) {
          const id = editMsgMatch[1];
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }

          const targetSeq = Number(body?.seq);
          const nextText = typeof body?.text === "string" ? body.text.trim() : "";
          if (!Number.isFinite(targetSeq) || targetSeq <= 0) {
            return sendJson(res, 400, { error: "valid seq is required" });
          }
          if (!nextText) {
            return sendJson(res, 400, { error: "text is required" });
          }

          const existing = ctx.store?.getSession?.(id);
          if (!existing) {
            return sendJson(res, 404, { error: "session not found" });
          }

          ctx.runner?.stop?.(id);
          const truncated = ctx.store?.truncateSessionFromSeq?.(id, targetSeq);
          if (!truncated) {
            return sendJson(res, 404, { error: "target user message not found" });
          }

          try {
            ctx.runner?.broadcastGlobal?.({
              type: "session_rewound",
              sessionId: id,
              seq: targetSeq,
              events: truncated.keptEvents,
              session: truncated.session,
            });
            ctx.runner?.broadcastGlobal?.({
              type: "session_updated",
              sessionId: id,
              session: truncated.session,
            });
          } catch {
            // ignore
          }

          const orig = truncated.targetEvent || {};
          const userMeta = {
            ...(orig.replyTo && typeof orig.replyTo === "object"
              ? { replyTo: orig.replyTo }
              : {}),
            ...(Array.isArray(orig.quotes) ? { quotes: orig.quotes } : {}),
            ...(Array.isArray(orig.attachments)
              ? { attachments: orig.attachments }
              : {}),
            ...(orig.clientSource && typeof orig.clientSource === "object"
              ? { clientSource: orig.clientSource }
              : {}),
          };
          const cleanMeta = Object.keys(userMeta).length > 0 ? userMeta : null;

          if (typeof ctx.runner?.enqueue === "function") {
            const enq = ctx.runner.enqueue(id, nextText, cleanMeta);
            return sendJson(res, 202, {
              ok: true,
              sessionId: id,
              rewoundToSeq: targetSeq,
              queued: Boolean(enq?.queued),
              steered: Boolean(enq?.steered),
              queueLength: enq?.queueLength || 0,
            });
          }
          ctx.runner?.start?.(id, nextText, cleanMeta);
          return sendJson(res, 202, {
            ok: true,
            sessionId: id,
            rewoundToSeq: targetSeq,
          });
        }

        // POST /api/sessions/:id/messages
        const sessionMsgMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/messages$/
        );
        if (method === "POST" && sessionMsgMatch) {
          const id = sessionMsgMatch[1];
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }

          if (!body || typeof body.text !== "string" || !body.text.trim()) {
            return sendJson(res, 400, { error: "text is required" });
          }

          const session = ctx.store?.getSession?.(id);
          if (!session) {
            return sendJson(res, 404, { error: "session not found" });
          }

          try {
            const rawClientSource = body.clientSource;
            const validDeviceKind =
              rawClientSource &&
              typeof rawClientSource === "object" &&
              (rawClientSource.deviceKind === "mobile" || rawClientSource.deviceKind === "desktop")
                ? rawClientSource.deviceKind
                : null;
            const userMeta = {
              ...(body.replyTo && typeof body.replyTo === "object"
                ? { replyTo: body.replyTo }
                : {}),
              ...(Array.isArray(body.quotes) ? { quotes: body.quotes } : {}),
              ...(Array.isArray(body.attachments)
                ? { attachments: body.attachments }
                : {}),
              ...(validDeviceKind
                ? {
                    clientSource: {
                      deviceKind: validDeviceKind,
                      ...(rawClientSource.platform
                        ? { platform: String(rawClientSource.platform).slice(0, 32) }
                        : {}),
                    },
                  }
                : {}),
            };
            const cleanMeta = Object.keys(userMeta).length > 0 ? userMeta : null;

            if (typeof ctx.runner?.enqueue === "function") {
              if (ctx.runner?.isSessionBusy?.(id)) {
                const liveSettings = ctx.store?.readSettings?.() || {};
                const stopCheck = await detectSemanticStopIntent(body.text, {
                  model: ctx.model,
                  config: { ...ctx.finalConfig, routing: liveSettings.routing },
                });
                if (stopCheck.shouldStop) {
                  ctx.runner.recordUserMessage?.(id, body.text, cleanMeta);
                  ctx.runner.stop(id);
                  return sendJson(res, 202, {
                    ok: true,
                    sessionId: id,
                    stopped: true,
                    reason: stopCheck.source,
                  });
                }
              }
              const enq = ctx.runner.enqueue(id, body.text, cleanMeta);
              return sendJson(res, 202, {
                ok: true,
                sessionId: id,
                queued: Boolean(enq?.queued),
                steered: Boolean(enq?.steered),
                queueLength: enq?.queueLength || 0,
              });
            }

            if (body.interrupt === true && ctx.runner?.isSessionBusy?.(id)) {
              ctx.runner.stop(id);
            }
            ctx.runner.start(id, body.text, cleanMeta);
            return sendJson(res, 202, { ok: true, sessionId: id });
          } catch (err: any) {
            if (
              err.message &&
              err.message.includes("a task is already running")
            ) {
              return sendJson(res, 409, { error: "a task is already running" });
            }
            return sendJson(res, 500, {
              error: err.message || "internal error",
            });
          }
        }

        // POST /api/control
        if (method === "POST" && pathname === "/api/control") {
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }

          if (!body || !["stop", "pause", "resume"].includes(body.action)) {
            return sendJson(res, 400, { error: "invalid action" });
          }

          if (typeof ctx.runner?.[body.action] === "function") {
            ctx.runner[body.action](body.sessionId);
          }
          return sendJson(res, 200, {
            ok: true,
            status: ctx.runner?.status?.() || { sessionId: null, state: "idle" },
          });
        }

        // POST /api/approvals/:callId
        const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (method === "POST" && approvalMatch) {
          const callId = approvalMatch[1];
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }

          if (!body || typeof body.allow !== "boolean") {
            return sendJson(res, 400, { error: "allow boolean is required" });
          }

          // Persist rule from `始终允许` (`alwaysRule`) or inline `编辑规则` (`customRule`)
          const incomingRule =
            body.customRule && typeof body.customRule === "object"
              ? body.customRule
              : body.allow && body.alwaysRule && typeof body.alwaysRule === "object"
                ? { ...body.alwaysRule, mode: "allow" }
                : null;
          if (incomingRule) {
            const current = ctx.getMergedSettings();
            const policy = current.policy || { ...DEFAULT_POLICY };
            const ruleEntry = {
              id: crypto.randomUUID(),
              tool: String(incomingRule.tool || "*"),
              pattern: String(incomingRule.pattern || ""),
              label: String(
                incomingRule.label ||
                  `${incomingRule.tool || "*"} · ${
                    incomingRule.mode === "ask" ? "每次先询问" : "自动允许"
                  }`
              ),
            };
            if (incomingRule.mode === "ask") {
              const askRules = Array.isArray(policy.askRules)
                ? [...policy.askRules, ruleEntry]
                : [ruleEntry];
              ctx.store?.writeSettings?.({ policy: { ...policy, askRules } });
            } else {
              const allowRules = Array.isArray(policy.allowRules)
                ? [...policy.allowRules, ruleEntry]
                : [ruleEntry];
              ctx.store?.writeSettings?.({ policy: { ...policy, allowRules } });
            }
            try {
              ctx.runner?.broadcastGlobal?.({ type: "settings_updated" });
            } catch {}
          }

          ctx.runner?.approve?.(callId, body.allow);
          return sendJson(res, 200, { ok: true });
        }

        // POST /api/choices/:callId (for `ask_user_choice` A/B/C/D cards)
        const choiceMatch = pathname.match(/^\/api\/choices\/([^/]+)$/);
        if (method === "POST" && choiceMatch) {
          const callId = choiceMatch[1];
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          if (body?.selected === undefined) {
            return sendJson(res, 400, { error: "selected is required" });
          }
          ctx.runner?.choose?.(callId, body.selected);
          return sendJson(res, 200, { ok: true });
        }

        // GET /api/events (SSE)
        if (method === "GET" && pathname === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");

          const unsubscribe =
            ctx.runner?.subscribe?.((ev: any) => {
              res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }) || (() => {});

          const pingTimer = setInterval(() => {
            res.write(": ping\n\n");
          }, 15000);
          pingTimer.unref();

          req.on("close", () => {
            clearInterval(pingTimer);
            unsubscribe();
          });
          return true;
        }

        // GET /api/screens/:id/:file
        const screenMatch = url.pathname.match(
          /^\/api\/screens\/([^/]+)\/([^/]+)$/
        );
        if (method === "GET" && screenMatch) {
          let id;
          let file;
          try {
            id = decodeURIComponent(screenMatch[1]);
            file = decodeURIComponent(screenMatch[2]);
          } catch {
            return sendJson(res, 404, { error: "not found" });
          }

          if (!UUID_REGEX.test(id) || !SCREENSHOT_FILE_REGEX.test(file)) {
            return sendJson(res, 404, { error: "not found" });
          }

          const filePath = ctx.store?.screenshotPath?.(id, file);
          if (!filePath || !fs.existsSync(filePath)) {
            return sendJson(res, 404, { error: "not found" });
          }

          try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
              return sendJson(res, 404, { error: "not found" });
            }
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": stat.size,
            });
            fs.createReadStream(filePath).pipe(res);
            return true;
          } catch {
            return sendJson(res, 404, { error: "not found" });
          }
        }
  return false;
}
