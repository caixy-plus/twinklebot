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
import { aggregateWorkspaceUsage, toCny, USD_TO_CNY } from "../../agent/pricing.js";
import {
  buildBillingBalanceSummary,
  applyBalanceCalibration,
  normalizeGoogleBillingSettings,
} from "../../lib/gcp-billing.js";
import {
  applyProviderCalibration,
  buildWorkspaceProviderBillingSummary,
  isProviderDueForRefresh,
  normalizeProviderBillingMap,
  refreshProviderLiveBalance,
  supportsLiveBalance,
  updateProviderRefreshSchedule,
} from "../../lib/provider-billing.js";
import { isProviderUsable, resolveProviderApiKey } from "../../agent/providers/registry.js";
import { normalizeRoutingSettings } from "../../agent/route-stats.js";
import {
  fetchLatestGithubManifest,
  readEffectiveWebMeta,
} from "../../lib/github-releases.js";
import { isLoopbackAddress } from "../../lib/device-auth.js";
import { CURRENT_API_CAPABILITIES } from "../../shared/versioning.js";

function resolveConfiguredModelsForUsage(ctx: ServerContext, rawProviders: any[]): string[] {
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
    return Array.isArray(ctx.finalConfig?.models) ? ctx.finalConfig.models : [];
  }
  const models: string[] = [];
  for (const p of rawProviders) {
    if (!isProviderUsable(p, process.env, ctx.geminiVertexRuntime)) continue;
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (m && !models.includes(m)) models.push(m);
    }
  }
  return models;
}

export function buildFullProviderBillingSummary(
  ctx: ServerContext,
  { includeDisabled = false }: { includeDisabled?: boolean } = {}
) {
  const rawProviders = ctx.resolveRawProviders?.() || [];
  const sessions = ctx.store?.listSessions?.() || [];
  const configuredModels = resolveConfiguredModelsForUsage(ctx, rawProviders);
  const usageSummary = aggregateWorkspaceUsage({
    sessions,
    readEvents: (sid) => ctx.store?.readEvents?.(sid) || [],
    configuredModels,
    defaultModel: ctx.finalConfig.defaultModel,
    providers: rawProviders,
    includeDisabled: true,
  });
  const rawSettings = ctx.store?.readSettings?.() || {};
  const billingSummary = buildWorkspaceProviderBillingSummary({
    settings: rawSettings,
    providers: rawProviders,
    byProviderUsage: usageSummary.byProvider || [],
    includeDisabled,
  });
  return {
    ok: true,
    merged: billingSummary.merged,
    providers: billingSummary.providers,
    usdToCnyRate: USD_TO_CNY,
    billingMap: billingSummary.billingMap,
    usageSummary,
  };
}

export async function runDueLiveBalanceRefreshes(
  ctx: ServerContext,
  now = Date.now()
): Promise<{ refreshedIds: string[]; summary: ReturnType<typeof buildFullProviderBillingSummary> } | null> {
  const rawProviders = ctx.resolveRawProviders?.() || [];
  const rawSettings = ctx.store?.readSettings?.() || {};
  const currentMap = normalizeProviderBillingMap(rawSettings, rawProviders);
  const due = rawProviders.filter((p) => isProviderDueForRefresh(currentMap[p.id], p, now));
  if (due.length === 0) return null;

  const nextMap = { ...currentMap };
  const refreshedIds: string[] = [];
  await Promise.all(
    due.map(async (p) => {
      const res = await refreshProviderLiveBalance(currentMap[p.id], p, {
        fetchImpl: ctx.billingFetchImpl,
        now,
      });
      nextMap[p.id] = res.entry;
      refreshedIds.push(p.id);
    })
  );
  ctx.store?.writeSettings?.({ providerBilling: nextMap });
  const summary = buildFullProviderBillingSummary(ctx, { includeDisabled: false });
  const payload = { ok: true, merged: summary.merged, providers: summary.providers, usdToCnyRate: USD_TO_CNY };
  try {
    ctx.broadcastEvent?.({ type: "billing_updated", summary: payload });
  } catch {}
  return { refreshedIds, summary };
}

export async function handleSystemRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        if (method === "GET" && pathname === "/api/search") {
          const q = url.searchParams.get("q") || "";
          const result = ctx.store?.search?.(q) || { bots: [], messages: [] };
          return sendJson(res, 200, result);
        }

        // GET /api/usage (supports optional ?sessionId=<id> for single-Bot breakdown)
        if (method === "GET" && pathname === "/api/usage") {
          const sessions = ctx.store?.listSessions?.() || [];
          const sessionId = (url.searchParams.get("sessionId") || "").trim();
          const rawProviders = ctx.resolveRawProviders?.() || [];
          const configuredModels = resolveConfiguredModelsForUsage(ctx, rawProviders);
          const summary = aggregateWorkspaceUsage({
            sessions,
            sessionId,
            readEvents: (sid) => ctx.store?.readEvents?.(sid) || [],
            configuredModels,
            defaultModel: ctx.finalConfig.defaultModel,
            providers: rawProviders,
            includeDisabled: false,
          });
          return sendJson(res, 200, summary);
        }

        // GET /api/billing/summary (Merged RMB balance + per-provider live/calibrated cards, filtering disabled providers)
        if (method === "GET" && pathname === "/api/billing/summary") {
          const full = buildFullProviderBillingSummary(ctx, { includeDisabled: false });
          return sendJson(res, 200, {
            ok: true,
            merged: full.merged,
            providers: full.providers,
            usdToCnyRate: full.usdToCnyRate,
          });
        }

        // POST /api/billing/refresh (Manual refresh for all enabled providers with live balance API)
        if (method === "POST" && pathname === "/api/billing/refresh") {
          const rawProviders = ctx.resolveRawProviders?.() || [];
          const rawSettings = ctx.store?.readSettings?.() || {};
          const currentMap = normalizeProviderBillingMap(rawSettings, rawProviders);
          const targets = rawProviders.filter(
            (p) => p.enabled !== false && supportsLiveBalance(p)
          );
          const nextMap = { ...currentMap };
          const results: Array<{ providerId: string; ok: boolean; error: string | null }> = [];
          await Promise.all(
            targets.map(async (p) => {
              const r = await refreshProviderLiveBalance(currentMap[p.id], p, {
                fetchImpl: ctx.billingFetchImpl,
              });
              nextMap[p.id] = r.entry;
              results.push({ providerId: p.id, ok: r.ok, error: r.error });
            })
          );
          ctx.store?.writeSettings?.({ providerBilling: nextMap });
          const full = buildFullProviderBillingSummary(ctx, { includeDisabled: false });
          const payload = {
            ok: true,
            merged: full.merged,
            providers: full.providers,
            usdToCnyRate: full.usdToCnyRate,
            results,
          };
          ctx.broadcastEvent?.({
            type: "billing_updated",
            summary: { ok: true, merged: full.merged, providers: full.providers, usdToCnyRate: full.usdToCnyRate },
          });
          return sendJson(res, 200, payload);
        }

        // POST /api/billing/providers/:id/refresh
        const providerRefreshMatch = pathname.match(/^\/api\/billing\/providers\/([^/]+)\/refresh$/);
        if (providerRefreshMatch && method === "POST") {
          const targetId = decodeURIComponent(providerRefreshMatch[1]);
          const rawProviders = ctx.resolveRawProviders?.() || [];
          const provider = rawProviders.find((p) => p.id === targetId);
          if (!provider) {
            return sendJson(res, 404, { error: "provider not found" });
          }
          if (!supportsLiveBalance(provider)) {
            return sendJson(res, 400, { error: "当前供应商暂不支持实时余额查询接口" });
          }
          const rawSettings = ctx.store?.readSettings?.() || {};
          const currentMap = normalizeProviderBillingMap(rawSettings, rawProviders);
          const r = await refreshProviderLiveBalance(currentMap[targetId], provider, {
            fetchImpl: ctx.billingFetchImpl,
          });
          const nextMap = { ...currentMap, [targetId]: r.entry };
          ctx.store?.writeSettings?.({ providerBilling: nextMap });
          const full = buildFullProviderBillingSummary(ctx, { includeDisabled: false });
          const card = full.providers.find((c) => c.providerId === targetId) || null;
          ctx.broadcastEvent?.({
            type: "billing_updated",
            summary: { ok: true, merged: full.merged, providers: full.providers, usdToCnyRate: full.usdToCnyRate },
          });
          return sendJson(res, 200, {
            ok: r.ok,
            error: r.error,
            provider: card,
            merged: full.merged,
            providers: full.providers,
            usdToCnyRate: full.usdToCnyRate,
          });
        }

        // PATCH /api/billing/providers/:id/schedule
        const providerScheduleMatch = pathname.match(/^\/api\/billing\/providers\/([^/]+)\/schedule$/);
        if (providerScheduleMatch && method === "PATCH") {
          const targetId = decodeURIComponent(providerScheduleMatch[1]);
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const rawProviders = ctx.resolveRawProviders?.() || [];
          const provider = rawProviders.find((p) => p.id === targetId);
          if (!provider) {
            return sendJson(res, 404, { error: "provider not found" });
          }
          const rawSettings = ctx.store?.readSettings?.() || {};
          const currentMap = normalizeProviderBillingMap(rawSettings, rawProviders);
          let nextEntry;
          try {
            nextEntry = updateProviderRefreshSchedule(
              currentMap[targetId],
              provider,
              body?.autoRefreshMinutes
            );
          } catch (err: any) {
            return sendJson(res, 400, { error: err?.message || "刷新周期无效" });
          }
          ctx.store?.writeSettings?.({
            providerBilling: { ...currentMap, [targetId]: nextEntry },
          });
          const full = buildFullProviderBillingSummary(ctx, { includeDisabled: false });
          ctx.broadcastEvent?.({
            type: "billing_updated",
            summary: { ok: true, merged: full.merged, providers: full.providers, usdToCnyRate: full.usdToCnyRate },
          });
          return sendJson(res, 200, {
            ok: true,
            merged: full.merged,
            providers: full.providers,
            usdToCnyRate: full.usdToCnyRate,
          });
        }

        // POST /api/billing/providers/:id/calibration
        const providerCalMatch = pathname.match(/^\/api\/billing\/providers\/([^/]+)\/calibration$/);
        if (providerCalMatch && method === "POST") {
          const targetId = decodeURIComponent(providerCalMatch[1]);
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          if (!body || typeof body !== "object") {
            return sendJson(res, 400, { error: "invalid payload" });
          }
          const rawProviders = ctx.resolveRawProviders?.() || [];
          const provider = rawProviders.find((p) => p.id === targetId);
          if (!provider) {
            return sendJson(res, 404, { error: "provider not found" });
          }
          const preFull = buildFullProviderBillingSummary(ctx, { includeDisabled: true });
          const spentCny =
            preFull.usageSummary.byProvider?.find((u) => u.providerId === targetId)?.costCny || 0;
          const amountCny =
            body.amountCny !== undefined
              ? Number(body.amountCny)
              : body.amountUsd !== undefined
                ? toCny(Number(body.amountUsd), "USD")
                : undefined;
          const totalCreditsCny =
            body.totalCreditsCny !== undefined
              ? Number(body.totalCreditsCny)
              : body.totalCreditsUsd !== undefined
                ? toCny(Number(body.totalCreditsUsd), "USD")
                : undefined;
          let nextEntry;
          try {
            nextEntry = applyProviderCalibration({
              entry: preFull.billingMap[targetId],
              provider,
              providerSpentCny: spentCny,
              mode: body.mode || "set",
              amountCny,
              amountNative:
                body.amountNative !== undefined ? Number(body.amountNative) : undefined,
              totalCreditsCny,
              note: body.note,
              clear: body.clear === true,
            });
          } catch (err: any) {
            return sendJson(res, 400, { error: err?.message || "校准参数无效" });
          }
          ctx.store?.writeSettings?.({
            providerBilling: { ...preFull.billingMap, [targetId]: nextEntry },
          });
          const full = buildFullProviderBillingSummary(ctx, { includeDisabled: false });
          ctx.broadcastEvent?.({
            type: "billing_updated",
            summary: { ok: true, merged: full.merged, providers: full.providers, usdToCnyRate: full.usdToCnyRate },
          });
          return sendJson(res, 200, {
            ok: true,
            merged: full.merged,
            providers: full.providers,
            usdToCnyRate: full.usdToCnyRate,
          });
        }

        // GET /api/billing/gcp (Instant local calibrated balance deducted by workspace usage cost)
        if (method === "GET" && pathname === "/api/billing/gcp") {
          const sessions = ctx.store?.listSessions?.() || [];
          const workspaceSummary = aggregateWorkspaceUsage({
            sessions,
            readEvents: (sid) => ctx.store?.readEvents?.(sid) || [],
            configuredModels: ctx.finalConfig.models,
            defaultModel: ctx.finalConfig.defaultModel,
          });
          const rawSettings = ctx.store?.readSettings?.() || {};
          return sendJson(
            res,
            200,
            buildBillingBalanceSummary({
              settings: rawSettings,
              workspaceEstimatedCostUsd: workspaceSummary.estimatedCostUsd,
            })
          );
        }

        // POST /api/billing/gcp/calibration (Set, add, subtract, or clear local balance calibration)
        if (method === "POST" && pathname === "/api/billing/gcp/calibration") {
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          if (!body || typeof body !== "object") {
            return sendJson(res, 400, { error: "invalid payload" });
          }
          const sessions = ctx.store?.listSessions?.() || [];
          const workspaceSummary = aggregateWorkspaceUsage({
            sessions,
            readEvents: (sid) => ctx.store?.readEvents?.(sid) || [],
            configuredModels: ctx.finalConfig.models,
            defaultModel: ctx.finalConfig.defaultModel,
          });

          let nextGoogleBilling;
          try {
            nextGoogleBilling = applyBalanceCalibration({
              currentSettings: ctx.store?.readSettings?.()?.googleBilling,
              workspaceEstimatedCostUsd: workspaceSummary.estimatedCostUsd,
              clear: body.clear === true,
              mode: body.mode || "set",
              amountUsd: body.amountUsd,
              baselineRemainingUsd: body.baselineRemainingUsd,
              baselineTotalCreditsUsd: body.baselineTotalCreditsUsd,
            });
          } catch (err: any) {
            return sendJson(res, 400, { error: err?.message || "校准参数无效" });
          }

          ctx.store?.writeSettings?.({ googleBilling: nextGoogleBilling });
          const payload = buildBillingBalanceSummary({
            settings: ctx.store?.readSettings?.() || { googleBilling: nextGoogleBilling },
            workspaceEstimatedCostUsd: workspaceSummary.estimatedCostUsd,
          });
          return sendJson(res, 200, payload);
        }

        // GET /api/system/diagnostics (Sanitized runtime & connectivity diagnostics — never exposes secrets)
        if (method === "GET" && pathname === "/api/system/diagnostics") {
          const startMs = Date.now();
          let executorOnline = false;
          let executorError = "";
          if (!ctx.executor?.health) {
            executorOnline = true;
          } else {
            try {
              await ctx.executor.health();
              executorOnline = true;
            } catch (err: any) {
              executorOnline = false;
              executorError = String(err?.message || "unreachable");
            }
          }
          const executorLatencyMs = Date.now() - startMs;
          const sessions = ctx.store?.listSessions?.() || [];
          const rawProviders = ctx.resolveRawProviders();
          const usableProviders = rawProviders.filter((p) =>
            isProviderUsable(p, process.env, ctx.geminiVertexRuntime)
          );
          const llmConfigured = usableProviders.length > 0;
          const enabledModels = [
            ...new Set(usableProviders.flatMap((p) => p.models || []).filter(Boolean)),
          ];
          const rawRouting = normalizeRoutingSettings(ctx.store?.readSettings?.()?.routing);
          const configuredImageTier = rawRouting.tiers?.image;
          const configuredImageOk =
            configuredImageTier?.providerId &&
            configuredImageTier?.model &&
            usableProviders.some((p) => p.id === configuredImageTier.providerId);
          const imageModels = [
            ...new Set([
              ...(configuredImageOk ? [configuredImageTier.model] : []),
              ...usableProviders.flatMap((p) => p.imageModels || []).filter(Boolean),
            ]),
          ];
          const resolvedEffectiveDir = (() => {
            try {
              const d = ctx.getEffectivePublicDir?.();
              if (d && fs.existsSync(d)) return d;
            } catch {}
            return ctx.publicDir;
          })();
          const webMeta = readEffectiveWebMeta({
            effectivePublicDir: resolvedEffectiveDir,
            projectRoot: ctx.projectRoot,
            appVersion: ctx.appVersion,
          });
          const otaStatus = ctx.otaController?.getStatus?.() || null;

          return sendJson(res, 200, {
            appVersion: ctx.appVersion,
            webBuild: webMeta.webBuild,
            apiCapabilities: [...CURRENT_API_CAPABILITIES],
            otaStatus,
            nodeVersion: process.version,
            platform: `${process.platform}/${process.arch}`,
            geminiKeyConfigured: Boolean(
              (rawProviders.length === 0 && ctx.finalConfig.geminiApiKey) ||
                rawProviders.some((p) => p.type === "gemini" && resolveProviderApiKey(p.apiKey))
            ),
            vertexConfigured: Boolean(ctx.geminiVertexRuntime?.vertexActive),
            gcpServerVerified: Boolean(ctx.geminiVertexRuntime?.isGcpServer),
            gcpVertexActive: Boolean(ctx.geminiVertexRuntime?.vertexActive),
            ...(ctx.geminiVertexRuntime?.blockedReason
              ? { blockedVertexReason: ctx.geminiVertexRuntime.blockedReason }
              : {}),
            llmConfigured,
            deployEnv: ctx.runtimeState.deployEnv,
            role: ctx.runtimeState.role,
            executorOnline,
            executorLatencyMs,
            executorUrl: ctx.finalConfig.executorUrl || "http://127.0.0.1:7300",
            ...(executorError ? { executorError } : {}),
            models: enabledModels,
            imageModels,
            writeRoots: ctx.finalConfig.writeRoots,
            sessionCount: sessions.length,
          });
        }

        // POST /api/system/ota/confirm (Desktop local web bundle readiness confirmation)
        if (method === "POST" && pathname === "/api/system/ota/confirm") {
          let body: any = {};
          try {
            body = await parseJsonBody(req);
          } catch {}
          const status = ctx.otaController?.confirmReady?.(
            typeof body?.webBuild === "string" ? body.webBuild : undefined
          );
          return sendJson(res, 200, { ok: true, otaStatus: status || null });
        }

        // GET /api/system/updates/check?force=1 (GitHub Releases single-source update check)
        if (method === "GET" && pathname === "/api/system/updates/check") {
          const force = url.searchParams.get("force") === "1";
          try {
            const result = await fetchLatestGithubManifest({
              projectRoot: ctx.projectRoot,
              currentAppVersion: ctx.appVersion,
              fetchImpl: ctx.billingFetchImpl,
              force,
            });
            return sendJson(res, 200, {
              ok: true,
              appVersion: ctx.appVersion,
              apiCapabilities: [...CURRENT_API_CAPABILITIES],
              ...result,
            });
          } catch (err: any) {
            return sendJson(res, 200, {
              ok: false,
              code: String(err?.code || "GITHUB_UNREACHABLE"),
              error: String(err?.message || "检查版本更新失败"),
            });
          }
        }

        // Loopback-only authenticated Desktop Shell wake/quit fallback (used when Chromium ProcessSingleton cannot signal across Windows desktop/UIPI boundaries)
        if (
          method === "POST" &&
          (pathname === "/api/desktop/wake" || pathname === "/api/desktop/quit")
        ) {
          if (!isLoopbackAddress(req.socket?.remoteAddress || "")) {
            return sendJson(res, 403, { error: "forbidden: loopback only" });
          }
          const expectedToken = String(ctx.finalConfig.localControlToken || "").trim();
          const headerToken =
            String(req.headers["x-local-token"] || "").trim() ||
            (String(req.headers.authorization || "")
              .toLowerCase()
              .startsWith("bearer ")
              ? String(req.headers.authorization || "").slice(7).trim()
              : "");
          const expectedBuf = Buffer.from(expectedToken, "utf8");
          const actualBuf = Buffer.from(headerToken, "utf8");
          if (
            !expectedToken ||
            expectedBuf.length !== actualBuf.length ||
            !crypto.timingSafeEqual(expectedBuf, actualBuf)
          ) {
            return sendJson(res, 401, { error: "unauthorized: invalid local control token" });
          }
          if (!ctx.desktopController) {
            return sendJson(res, 404, { error: "desktop controller unavailable" });
          }
          if (pathname === "/api/desktop/wake") {
            const wakeResult = await ctx.desktopController.wakeWindow();
            return sendJson(res, 200, { ok: true, ...wakeResult });
          }
          sendJson(res, 200, { ok: true, pid: process.pid });
          setImmediate(() => {
            ctx.desktopController?.quitApp?.();
          });
          return true;
        }

  return false;
}
