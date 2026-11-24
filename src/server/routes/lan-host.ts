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
import { isHostTool, runHostTool } from "../../agent/host-tools.js";
import { assessToolCall } from "../../agent/policy.js";
import { probeBotComputerState, provisionBotComputer } from "../../lib/bot-computer-provisioner.js";
import { probeLocalChromeStatus } from "../../lib/local-chrome-cdp.js";
import {
  resolveBaseWorkspaceRoot,
  resolveBotWorkspaceRoot,
  resolveBotWriteRoots,
  sanitizeBotWorkspaceId,
} from "../../lib/bot-workspace.js";

async function collectComputerStatusPayload(ctx: ServerContext) {
  const startMs = Date.now();
  const mergedSettings = ctx.getMergedSettings();
  const executionMode = mergedSettings.hostComputer.executionMode;
  const hostComputer = ctx.getHostDeviceInfo(executionMode);
  const [probed, localBrowser] = await Promise.all([
    ctx.probeBotComputerFn({
      deployEnv: ctx.runtimeState.deployEnv,
      executor: ctx.executor,
      store: ctx.store,
    }),
    ctx.runtimeState.deployEnv === "cloud"
      ? Promise.resolve(null)
      : probeLocalChromeStatus(mergedSettings.browserAutomation, ctx.finalConfig.dataDir),
  ]);
  const latencyMs = Math.max(1, Date.now() - startMs);
  const commonFields = {
    online: Boolean(probed.online),
    state: probed.state,
    provider: probed.provider,
    latencyMs,
    detail: probed.detail,
    executorUrl: ctx.finalConfig.executorUrl || "http://127.0.0.1:7300",
    ...(localBrowser ? { localBrowser } : {}),
    ...(probed.vmInstalled !== undefined ? { vmInstalled: probed.vmInstalled } : {}),
    ...(probed.vmRunning !== undefined ? { vmRunning: probed.vmRunning } : {}),
    ...(probed.errorCode ? { errorCode: probed.errorCode } : {}),
  };

  if (!ctx.executor?.health || ctx.runtimeState.deployEnv === "cloud") {
    const connectedHosts = ctx.hostBridge?.listConnectedHosts?.() || [];
    const selectedHostId = ctx.hostBridge?.getSelectedHostId?.() || null;
    return {
      ...commonFields,
      screen: ctx.finalConfig.screen,
      hostComputer:
        ctx.runtimeState.deployEnv === "cloud"
          ? {
              ...hostComputer,
              online: connectedHosts.length > 0,
              connectedHosts,
              selectedHostId,
            }
          : hostComputer,
    };
  }

  if (probed.online) {
    return {
      ...commonFields,
      screen: (probed as any).screen || ctx.finalConfig.screen,
      hostComputer,
    };
  }

  return {
    ...commonFields,
    screen: ctx.finalConfig.screen,
    error: (probed as any).healthError || probed.detail,
    hostComputer,
  };
}

function broadcastComputerStatus(ctx: ServerContext, status: Record<string, any>) {
  try {
    ctx.runner?.broadcastGlobal?.({
      type: "computer_status_updated",
      state: status.state,
      online: Boolean(status.online),
      provider: status.provider,
      latencyMs: status.latencyMs,
      screen: status.screen,
      detail: status.detail || "",
      error: status.online ? undefined : status.error,
      errorCode: status.online ? undefined : status.errorCode,
      vmInstalled: status.vmInstalled,
      vmRunning: status.vmRunning,
    });
  } catch {}
}

export async function handleLanHostRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        // LAN Access settings & paired mobile devices management
        if (pathname === "/api/lan/settings") {
          if (method === "GET") {
            return sendJson(res, 200, {
              ok: true,
              lanAccess: ctx.isLanAccessEnabled(),
              discovery: ctx.getDiscoveryPayload(),
              devices: ctx.deviceAuth.listDevices(),
            });
          }
          if (method === "POST") {
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            if (typeof body?.lanAccess === "boolean") {
              ctx.store?.writeSettings?.({ lanAccess: body.lanAccess });
            }
            return sendJson(res, 200, {
              ok: true,
              lanAccess: ctx.isLanAccessEnabled(),
              discovery: ctx.getDiscoveryPayload(),
              devices: ctx.deviceAuth.listDevices(),
            });
          }
        }

        if (method === "GET" && pathname === "/api/lan/devices") {
          return sendJson(res, 200, {
            ok: true,
            devices: ctx.deviceAuth.listDevices(),
          });
        }

        if (method === "DELETE" && pathname.startsWith("/api/lan/devices/")) {
          const devId = pathname.slice("/api/lan/devices/".length).trim();
          const removed = ctx.deviceAuth.revokeDevice(devId);
          if (!removed) {
            return sendJson(res, 404, { error: "device not found" });
          }
          return sendJson(res, 200, {
            ok: true,
            devices: ctx.deviceAuth.listDevices(),
          });
        }

        // GET / POST /api/system/role
        if (pathname === "/api/system/role") {
          if (method === "GET") {
            return sendJson(res, 200, {
              ok: true,
              deployEnv: ctx.runtimeState.deployEnv,
              role: ctx.runtimeState.role,
              cloudOrigin: ctx.runtimeState.cloudOrigin,
              updatedAt: ctx.runtimeState.updatedAt,
            });
          }
          if (method === "POST") {
            if (ctx.finalConfig.localControlToken) {
              const localTok =
                String(req.headers["x-local-token"] || "").trim() ||
                (String(req.headers.authorization || "")
                  .toLowerCase()
                  .startsWith("bearer ")
                  ? String(req.headers.authorization || "").slice(7).trim()
                  : "");
              if (localTok !== ctx.finalConfig.localControlToken) {
                return sendJson(res, 401, {
                  error: "unauthorized: invalid local control token",
                });
              }
            }
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            if (!body || typeof body !== "object" || !body.role) {
              return sendJson(res, 400, { error: "role is required" });
            }
            try {
              const nextState = ctx.runtimeState.setRole(body.role, {
                cloudOrigin: body.cloudOrigin,
              });
              if (nextState.role === "host_executor") {
                try {
                  ctx.runner?.stop?.();
                } catch {}
                try {
                  ctx.scheduler?.stop?.();
                } catch {}
              } else {
                try {
                  ctx.scheduler?.start?.();
                } catch {}
              }
              ctx.runner?.broadcastGlobal?.({
                type: "runtime_role_changed",
                ...nextState,
              });
              return sendJson(res, 200, { ok: true, ...nextState });
            } catch (err: any) {
              return sendJson(res, 400, {
                error: err?.message || "invalid runtime role",
              });
            }
          }
        }

        // GET /api/computer/host-info (allowed in master & host_executor)
        if (method === "GET" && pathname === "/api/computer/host-info") {
          const executionMode = ctx.getMergedSettings().hostComputer.executionMode;
          return sendJson(res, 200, {
            ok: true,
            deployEnv: ctx.runtimeState.deployEnv,
            role: ctx.runtimeState.role,
            hostComputer: ctx.getHostDeviceInfo(executionMode),
          });
        }

        // POST /api/host/execute (restricted host execution in master & host_executor)
        if (method === "POST" && pathname === "/api/host/execute") {
          if (ctx.finalConfig.localControlToken) {
            const localTok =
              String(req.headers["x-local-control-token"] || "").trim() ||
              String(req.headers["x-local-token"] || "").trim() ||
              (String(req.headers.authorization || "")
                .toLowerCase()
                .startsWith("bearer ")
                ? String(req.headers.authorization || "").slice(7).trim()
                : "");
            if (localTok !== ctx.finalConfig.localControlToken) {
              return sendJson(res, 401, {
                error: "unauthorized: invalid local control token",
              });
            }
          }
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const toolName = String(body?.tool || body?.name || "").trim();
          if (!isHostTool(toolName)) {
            return sendJson(res, 400, { error: `unsupported host tool: ${toolName}` });
          }
          const toolArgs = body?.args && typeof body.args === "object" ? body.args : {};
          const rawSessionId = String(body?.sessionId || body?.botId || "").trim();
          const sessionId = rawSessionId ? sanitizeBotWorkspaceId(rawSessionId) : "";
          const baseWriteRoots = Array.isArray(ctx.finalConfig.writeRoots)
            ? ctx.finalConfig.writeRoots
            : [];
          const scopedWriteRoots = sessionId
            ? resolveBotWriteRoots({ writeRoots: baseWriteRoots, sessionId })
            : baseWriteRoots;
          const rawSettings = ctx.store?.readSettings?.() || {};
          const hostExecMode = rawSettings?.hostComputer?.executionMode || "always";
          const policyAssessment = assessToolCall(toolName, toolArgs, {
            hostExecutionMode: hostExecMode,
            policy: rawSettings.policy || DEFAULT_POLICY,
            writeRoots: scopedWriteRoots,
            ...(sessionId && baseWriteRoots[0]
              ? {
                  botWorkspaceSessionId: sessionId,
                  baseWorkspaceRoot: resolveBaseWorkspaceRoot({ writeRoots: baseWriteRoots }),
                }
              : {}),
            sandboxMode: "restricted",
          });
          if (policyAssessment.decision === "deny") {
            return sendJson(res, 403, {
              ok: false,
              error: `denied by policy: ${policyAssessment.reason}`,
            });
          }
          if (policyAssessment.decision === "confirm" && body?.approved !== true) {
            return sendJson(res, 200, {
              ok: false,
              needsApproval: true,
              reason: policyAssessment.reason,
            });
          }
          const workspaceRoot = resolveBotWorkspaceRoot({
            config: ctx.finalConfig,
            sessionId,
            fallbackDir: path.join(os.homedir(), "TwinkleBot", "workspace"),
          });
          const out = await runHostTool(toolName, toolArgs, {
            shellTimeoutSec: ctx.finalConfig.shellTimeoutSec ?? 60,
            workspaceRoot,
          });
          if (sessionId && toolName === "host_record_screen" && out?.result?.ok) {
            ctx.runner?.broadcastGlobal?.({
              type: "library_updated",
              sessionId,
            });
          }
          return sendJson(res, 200, {
            ok: out?.result?.ok !== false,
            result: out?.result ?? {},
            screenshot: out?.screenshot ?? null,
          });
        }

        if (method === "GET" && pathname === "/api/computer/status") {
          const payload = await collectComputerStatusPayload(ctx);
          return sendJson(res, 200, payload);
        }

        // GET /api/computer/hosts & POST /api/computer/hosts/select
        if (method === "GET" && pathname === "/api/computer/hosts") {
          const hosts = ctx.hostBridge?.listConnectedHosts?.() || [];
          const selectedHostId = ctx.hostBridge?.getSelectedHostId?.() || null;
          return sendJson(res, 200, {
            ok: true,
            deployEnv: ctx.runtimeState.deployEnv,
            hosts,
            selectedHostId,
          });
        }

        if (method === "POST" && pathname === "/api/computer/hosts/select") {
          let body: Record<string, any> = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const targetId = String(body?.clientId || "").trim();
          const selected = ctx.hostBridge?.setSelectedHostId?.(targetId);
          if (!selected) {
            return sendJson(res, 404, { error: "host_executor client not online" });
          }
          const hosts = ctx.hostBridge?.listConnectedHosts?.() || [];
          try {
            ctx.runner?.broadcastGlobal?.({
              type: "computer_status_updated",
              connectedHosts: hosts,
              selectedHostId: selected,
            });
          } catch {}
          return sendJson(res, 200, {
            ok: true,
            selectedHostId: selected,
            hosts,
          });
        }

        // GET /api/computer/displays
        if (method === "GET" && pathname === "/api/computer/displays") {
          const pool = ctx.runner?.getScreenPoolStats?.() || null;
          if (!ctx.executor?.call) {
            return sendJson(res, 200, { ok: true, bindings: {}, displays: [], pool });
          }
          try {
            const maxHdr =
              pool && Number.isFinite(pool.maxConcurrentScreens)
                ? { "X-Twinkle-Max-Screens": String(pool.maxConcurrentScreens) }
                : undefined;
            const info = await ctx.executor.call(
              "/displays",
              {},
              { skipWake: true, ...(maxHdr ? { headers: maxHdr } : {}) }
            );
            return sendJson(res, 200, { ...(info || {}), pool });
          } catch (err: any) {
            return sendJson(res, 200, {
              ok: false,
              bindings: {},
              displays: [],
              pool,
              error: err?.message || "displays unavailable",
            });
          }
        }

        // POST /api/computer/provision (Admin-only Bot Computer initialization)
        if (method === "POST" && pathname === "/api/computer/provision") {
          let body: Record<string, any> = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const sessionId = String(body?.sessionId || "").trim();
          const caller = sessionId ? ctx.store?.getSession?.(sessionId) : null;
          if (ctx.runtimeState.deployEnv === "local" && sessionId && !caller?.isAdmin) {
            return sendJson(res, 403, {
              ok: false,
              error: "仅管理员 Bot 有权初始化 Bot 电脑环境",
            });
          }
          ctx.runner?.broadcastGlobal?.({
            type: "computer_status_updated",
            state: "creating",
          });
          const resProv = await provisionBotComputer({
            deployEnv: ctx.runtimeState.deployEnv,
            projectRoot: ctx.projectRoot,
            store: ctx.store,
            executor: ctx.executor,
            executorToken: ctx.finalConfig.executorToken,
          });
          ctx.runner?.broadcastGlobal?.({
            type: "computer_status_updated",
            state: resProv.state,
            online: Boolean(resProv.online),
            provider: resProv.provider,
            detail: resProv.detail || (resProv as any).error || "",
          });
          return sendJson(res, resProv.ok ? 200 : 500, resProv);
        }

        // POST /api/computer/update
        if (method === "POST" && pathname === "/api/computer/update") {
          ctx.runner?.stop?.();
          ctx.runner?.reconcileScreenPool?.();
          try {
            const upd = await ctx.updateBotComputerFn({
              projectRoot: ctx.projectRoot,
              executor: ctx.executor,
              executorToken: ctx.finalConfig.executorToken,
            });
            const status = await collectComputerStatusPayload(ctx);
            broadcastComputerStatus(ctx, status);
            return sendJson(res, 200, { ...upd, ok: true, status });
          } catch (err: any) {
            try {
              const status = await collectComputerStatusPayload(ctx);
              broadcastComputerStatus(ctx, status);
            } catch {}
            return sendJson(res, 500, {
              ok: false,
              error: err?.message || "更新 Bot 的电脑失败",
            });
          }
        }

        // POST /api/computer/reset
        if (method === "POST" && pathname === "/api/computer/reset") {
          ctx.runner?.stop?.();
          ctx.runner?.reconcileScreenPool?.();
          if (ctx.executor?.call) {
            try {
              const dispInfo: any = await ctx.executor.call(
                "/displays",
                {},
                { skipWake: true, timeoutMs: 2000 }
              );
              const boundKeys = Object.keys(dispInfo?.bindings || {}).filter(
                (bk) => bk && !bk.startsWith("__primary__")
              );
              await Promise.allSettled(
                boundKeys.map((bk) =>
                  ctx.executor.call(
                    "/displays/release",
                    { bot_id: bk },
                    { skipWake: true, timeoutMs: 2000 }
                  )
                )
              );
            } catch {
              // ignore unreachable executor during reset; probed status below reports live state
            }
          }
          const status = await collectComputerStatusPayload(ctx);
          broadcastComputerStatus(ctx, status);
          return sendJson(res, 200, {
            ok: true,
            online: Boolean(status.online),
            status,
          });
        }

        // POST /api/computer/input (Mobile/touch remote keyboard text & special key input -> executor /type or /key)
        if (method === "POST" && pathname === "/api/computer/input") {
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const text = typeof body?.text === "string" ? body.text : "";
          const key = typeof body?.key === "string" ? body.key.trim() : "";
          const pressEnter = Boolean(body?.pressEnter);
          const botId = String(body?.botId || body?.sessionId || "").trim();
          const SAFE_KEYS = new Set([
            "Return",
            "BackSpace",
            "Escape",
            "Tab",
            "space",
            "Left",
            "Right",
            "Up",
            "Down",
            "Delete",
            "Home",
            "End",
            "ctrl+a",
            "ctrl+c",
            "ctrl+v",
            "ctrl+z",
          ]);
          if (!text && !key) {
            return sendJson(res, 400, { error: "text or key is required" });
          }
          if (text.length > 2000) {
            return sendJson(res, 400, { error: "text exceeds 2000 characters" });
          }
          if (key && !SAFE_KEYS.has(key)) {
            return sendJson(res, 400, { error: `unsupported key: ${key}` });
          }
          if (!ctx.executor?.call) {
            return sendJson(res, 503, { ok: false, error: "executor unavailable" });
          }
          try {
            if (text) {
              await ctx.executor.call(
                "/type",
                {
                  text,
                  ...(pressEnter ? { press_enter: true } : {}),
                  ...(botId ? { bot_id: botId } : {}),
                },
                { timeoutMs: 8000 }
              );
              return sendJson(res, 200, { ok: true, mode: "type", length: text.length });
            }
            await ctx.executor.call(
              "/key",
              {
                key,
                ...(botId ? { bot_id: botId } : {}),
              },
              { timeoutMs: 5000 }
            );
            return sendJson(res, 200, { ok: true, mode: "key", key });
          } catch (err: any) {
            return sendJson(res, 502, {
              ok: false,
              error: err?.message || "远程输入失败",
            });
          }
        }
  return false;
}
