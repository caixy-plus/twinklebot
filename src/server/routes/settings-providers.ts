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
  isGeminiUsingGcpVertex,
  normalizeProvidersConfig,
  normalizeProviderEntry,
  reconcileRoutingTiers,
  resolveProviderApiKey,
  sanitizeProvidersForClient,
} from "../../agent/providers/registry.js";
import {
  ROUTING_MODES,
  normalizeRoutingSettings,
  resetCategoryBiasCache,
} from "../../agent/route-stats.js";
import { normalizeGoogleBillingSettings } from "../../lib/gcp-billing.js";
import {
  VALID_BROWSER_AUTOMATION_MODES,
  normalizeBrowserAutomationSettings,
} from "../../shared/browser-automation.js";
import {
  isExplicitLanguagePreference,
  normalizeLanguagePreference,
} from "../../shared/i18n.js";
import { normalizeContextCompressionSettings } from "../../shared/context-compression.js";
import { normalizeScreenPoolSettings } from "../../shared/screen-pool.js";

export async function handleSettingsProvidersRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        // GET /api/config
        if (method === "GET" && pathname === "/api/config") {
          const settings = ctx.getMergedSettings();
          return sendJson(res, 200, {
            novncUrl: ctx.finalConfig.novncUrl,
            models: ctx.finalConfig.models,
            imageModels: [
              ctx.finalConfig.imageModel,
              ctx.finalConfig.proImageModel,
              ctx.finalConfig.fallbackImageModel,
            ].filter(Boolean),
            model: settings.model,
            screen: ctx.finalConfig.screen,
            writeRoots: ctx.finalConfig.writeRoots,
            autoRouter: true,
          });
        }

        // GET /api/settings
        if (method === "GET" && pathname === "/api/settings") {
          return sendJson(res, 200, ctx.getMergedSettings());
        }

        // Providers & Onboarding CRUD
        if (pathname === "/api/providers") {
          if (method === "GET") {
            const merged = ctx.getMergedSettings();
            return sendJson(res, 200, {
              ok: true,
              providers: merged.providers,
              routingTiers: merged.routing?.tiers || {},
              onboardingRequired: merged.onboardingRequired,
            });
          }
          if (method === "POST") {
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return sendJson(res, 400, { error: "invalid payload" });
            }
            if (String(body.type || "").trim().toLowerCase() === "vertex") {
              return sendJson(res, 400, {
                error:
                  "独立 Vertex AI 供应商已合并至 Google Gemini；仅在 GCP 云服务器部署且配置 GOOGLE_GENAI_USE_VERTEXAI=true 时自动启用，当前环境请使用 Google Gemini",
              });
            }
            const existingList = ctx.resolveRawProviders();
            const existing = body.id
              ? existingList.find((p) => p.id === String(body.id).trim())
              : null;
            const incomingKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
            const nextEntry = normalizeProviderEntry({
              ...(existing || {}),
              ...body,
              apiKey: incomingKey || existing?.apiKey || "",
            });
            const resolvedKey = resolveProviderApiKey(nextEntry.apiKey);
            const gcpVertex = isGeminiUsingGcpVertex(
              nextEntry,
              process.env,
              ctx.geminiVertexRuntime
            );
            if (!resolvedKey && !gcpVertex && nextEntry.type !== "openai-compatible") {
              return sendJson(res, 400, {
                error:
                  nextEntry.type === "gemini" && ctx.geminiVertexRuntime?.blockedReason
                    ? ctx.geminiVertexRuntime.blockedReason
                    : "API Key 不能为空",
              });
            }
            if (nextEntry.type === "openai-compatible" && !nextEntry.baseUrl) {
              return sendJson(res, 400, { error: "自定义模型必须填写 Base URL" });
            }
            const nextList = existing
              ? existingList.map((p) => (p.id === nextEntry.id ? nextEntry : p))
              : [...existingList, nextEntry];
            const rawRouting = normalizeRoutingSettings(ctx.store?.readSettings?.()?.routing);
            const { routing: nextRouting, autoAssigned } = reconcileRoutingTiers(
              nextList,
              rawRouting,
              process.env,
              ctx.geminiVertexRuntime
            );
            ctx.store?.writeSettings?.({ providers: nextList, routing: nextRouting });
            const merged = ctx.getMergedSettings();
            ctx.runner?.broadcastGlobal?.({ type: "settings_updated" });
            return sendJson(res, 200, {
              ok: true,
              provider: sanitizeProvidersForClient(
                [nextEntry],
                process.env,
                ctx.geminiVertexRuntime
              )[0],
              autoAssignedTiers: autoAssigned,
              ...merged,
            });
          }
        }

        if (method === "POST" && pathname === "/api/providers/test") {
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return sendJson(res, 400, { error: "invalid payload" });
          }
          const existingList = ctx.resolveRawProviders();
          const existing = body.id
            ? existingList.find((p) => p.id === String(body.id).trim())
            : null;
          const incomingKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
          const testResult = await ctx.testProviderFn(
            {
              ...(existing || {}),
              ...body,
              apiKey: incomingKey || existing?.apiKey || "",
            },
            { geminiVertexRuntime: ctx.geminiVertexRuntime }
          );
          return sendJson(res, 200, testResult);
        }

        const providerItemMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
        if (providerItemMatch && method === "PATCH") {
          const targetId = decodeURIComponent(providerItemMatch[1]);
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return sendJson(res, 400, { error: "invalid payload" });
          }
          const existingList = ctx.resolveRawProviders();
          const existing = existingList.find((p) => p.id === targetId);
          if (!existing) {
            return sendJson(res, 404, { error: "provider not found" });
          }
          const nextEntry = normalizeProviderEntry({
            ...existing,
            ...body,
            id: existing.id,
            apiKey:
              typeof body.apiKey === "string" && body.apiKey.trim()
                ? body.apiKey.trim()
                : existing.apiKey,
            enabled:
              typeof body.enabled === "boolean"
                ? body.enabled
                : existing.enabled !== false,
          });
          const nextList = existingList.map((p) =>
            p.id === targetId ? nextEntry : p
          );
          const rawRouting = normalizeRoutingSettings(ctx.store?.readSettings?.()?.routing);
          const { routing: nextRouting, autoAssigned } = reconcileRoutingTiers(
            nextList,
            rawRouting,
            process.env,
            ctx.geminiVertexRuntime
          );
          ctx.store?.writeSettings?.({ providers: nextList, routing: nextRouting });
          const merged = ctx.getMergedSettings();
          ctx.runner?.broadcastGlobal?.({ type: "settings_updated" });
          return sendJson(res, 200, {
            ok: true,
            provider: sanitizeProvidersForClient(
              [nextEntry],
              process.env,
              ctx.geminiVertexRuntime
            )[0],
            autoAssignedTiers: autoAssigned,
            ...merged,
          });
        }

        if (providerItemMatch && method === "DELETE") {
          const targetId = decodeURIComponent(providerItemMatch[1]);
          const existingList = ctx.resolveRawProviders();
          const nextList = existingList.filter((p) => p.id !== targetId);
          if (nextList.length === existingList.length) {
            return sendJson(res, 404, { error: "provider not found" });
          }
          const rawRouting = normalizeRoutingSettings(ctx.store?.readSettings?.()?.routing);
          if (rawRouting.tiers) {
            for (const tierKey of ["fast", "medium", "advanced", "image"]) {
              if (rawRouting.tiers[tierKey]?.providerId === targetId) {
                delete rawRouting.tiers[tierKey];
              }
            }
          }
          const { routing: nextRouting, autoAssigned } = reconcileRoutingTiers(
            nextList,
            rawRouting,
            process.env,
            ctx.geminiVertexRuntime
          );
          const rawBilling = ctx.store?.readSettings?.()?.providerBilling;
          const nextBilling =
            rawBilling && typeof rawBilling === "object"
              ? { ...rawBilling }
              : undefined;
          if (nextBilling) delete nextBilling[targetId];
          ctx.store?.writeSettings?.({
            providers: nextList,
            routing: nextRouting,
            ...(nextBilling ? { providerBilling: nextBilling } : {}),
          });
          const merged = ctx.getMergedSettings();
          ctx.runner?.broadcastGlobal?.({ type: "settings_updated" });
          ctx.broadcastEvent?.({ type: "billing_updated" });
          return sendJson(res, 200, {
            ok: true,
            autoAssignedTiers: autoAssigned,
            ...merged,
          });
        }

        if (method === "POST" && pathname === "/api/onboarding/complete") {
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return sendJson(res, 400, { error: "invalid payload" });
          }
          let nextList = ctx.resolveRawProviders();
          if (body.provider && typeof body.provider === "object") {
            if (String(body.provider.type || "").trim().toLowerCase() === "vertex") {
              return sendJson(res, 400, {
                error:
                  "独立 Vertex AI 供应商已合并至 Google Gemini；当前环境请选择 Google Gemini",
              });
            }
            const existing = body.provider.id
              ? nextList.find((p) => p.id === String(body.provider.id).trim())
              : null;
            const incomingKey =
              typeof body.provider.apiKey === "string" ? body.provider.apiKey.trim() : "";
            const entry = normalizeProviderEntry({
              ...(existing || {}),
              ...body.provider,
              apiKey: incomingKey || existing?.apiKey || "",
              enabled: true,
            });
            const resolvedKey = resolveProviderApiKey(entry.apiKey);
            const gcpVertex = isGeminiUsingGcpVertex(
              entry,
              process.env,
              ctx.geminiVertexRuntime
            );
            if (!resolvedKey && !gcpVertex && entry.type !== "openai-compatible") {
              return sendJson(res, 400, {
                error:
                  entry.type === "gemini" && ctx.geminiVertexRuntime?.blockedReason
                    ? ctx.geminiVertexRuntime.blockedReason
                    : "API Key 不能为空",
              });
            }
            if (entry.models.length === 0) {
              return sendJson(res, 400, { error: "请至少配置一个可用模型" });
            }
            nextList = existing
              ? nextList.map((p) => (p.id === entry.id ? entry : p))
              : [...nextList, entry];
          }
          if (!ctx.hasUsableProviderConfig(nextList)) {
            return sendJson(res, 400, { error: "请先完成至少一个可用的模型供应商配置" });
          }
          const curRouting = ctx.store?.readSettings?.()?.routing || {};
          const nextRouting = normalizeRoutingSettings({
            ...curRouting,
            ...(body.tiers ? { tiers: body.tiers } : {}),
          });
          ctx.store?.writeSettings?.({
            providers: nextList,
            routing: nextRouting,
            onboardingCompleted: true,
          });
          const merged = ctx.getMergedSettings();
          ctx.runner?.broadcastGlobal?.({ type: "settings_updated" });
          return sendJson(res, 200, { ok: true, ...merged });
        }


        if (method === "POST" && pathname === "/api/settings") {
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }

          if (!body || typeof body !== "object") {
            return sendJson(res, 400, { error: "invalid settings payload" });
          }

          // Preserve backward-compatible validation when `model` is passed or when body has no recognized keys
          const hasExtendedKeys = [
            "language",
            "theme",
            "accentMode",
            "spellcheckEnabled",
            "profile",
            "voice",
            "autoExpandScreen",
            "hostComputer",
            "mcpServers",
            "policy",
            "globalMemories",
            "privateSkills",
            "connectedApps",
            "routing",
            "contextCompression",
            "screenPool",
            "browserAutomation",
          ].some((k) => k in body);

          if ("model" in body || !hasExtendedKeys) {
            if (
              typeof body.model !== "string" ||
              !ctx.finalConfig.models.includes(body.model)
            ) {
              return sendJson(res, 400, { error: "invalid model" });
            }
          }

          const patch: Record<string, any> = {};
          if (typeof body.model === "string") patch.model = body.model;
          if ("language" in body) {
            if (!isExplicitLanguagePreference(body.language)) {
              return sendJson(res, 400, { error: "invalid language (expected system | zh-CN | en)" });
            }
            patch.language = normalizeLanguagePreference(body.language);
          }
          if (typeof body.theme === "string") patch.theme = body.theme;
          if (typeof body.accentMode === "string") patch.accentMode = body.accentMode;
          if (typeof body.spellcheckEnabled === "boolean") {
            patch.spellcheckEnabled = body.spellcheckEnabled;
          }
          if (body.profile && typeof body.profile === "object") {
            const cur = ctx.getMergedSettings().profile;
            const nextName =
              typeof body.profile.name === "string"
                ? body.profile.name.trim().slice(0, 32)
                : "";
            patch.profile = {
              name: nextName || cur.name,
              color: VALID_PROFILE_COLORS.has(body.profile.color)
                ? body.profile.color
                : cur.color,
            };
          }
          if (body.voice && typeof body.voice === "object") patch.voice = body.voice;
          if (typeof body.autoExpandScreen === "boolean") {
            patch.autoExpandScreen = body.autoExpandScreen;
          }
          if ("hostComputer" in body) {
            if (
              !body.hostComputer ||
              typeof body.hostComputer !== "object" ||
              !VALID_HOST_EXEC_MODES.has(body.hostComputer.executionMode)
            ) {
              return sendJson(res, 400, {
                error: "invalid hostComputer.executionMode",
              });
            }
            patch.hostComputer = {
              executionMode: body.hostComputer.executionMode,
            };
            if (body.hostComputer.executionMode === "off") {
              await ctx.activeMcpManager?.closeAll?.();
            }
          }
          if ("mcpServers" in body) {
            const incoming =
              body.mcpServers?.mcpServers &&
              typeof body.mcpServers.mcpServers === "object"
                ? body.mcpServers.mcpServers
                : body.mcpServers;
            if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
              return sendJson(res, 400, { error: "invalid mcpServers payload" });
            }
            for (const [srvId, srvCfg] of Object.entries(incoming as Record<string, any>)) {
              if (
                !srvCfg ||
                typeof srvCfg !== "object" ||
                typeof srvCfg.command !== "string" ||
                !srvCfg.command.trim()
              ) {
                return sendJson(res, 400, {
                  error: `MCP 服务 ${srvId} 缺少有效的 command`,
                });
              }
            }
            patch.mcpServers = ctx.sanitizeMcpServersMap(incoming);
          }
          if (body.policy && typeof body.policy === "object" && !Array.isArray(body.policy)) {
            const curPolicy = ctx.getMergedSettings().policy || DEFAULT_POLICY;
            patch.policy = {
              ...curPolicy,
              ...(typeof body.policy.autoAudit === "boolean"
                ? { autoAudit: body.policy.autoAudit }
                : {}),
              ...(Array.isArray(body.policy.askRules) ? { askRules: body.policy.askRules } : {}),
              ...(Array.isArray(body.policy.allowRules)
                ? { allowRules: body.policy.allowRules }
                : {}),
            };
          }
          if (Array.isArray(body.globalMemories)) {
            patch.globalMemories = body.globalMemories;
            patch.privateSkills = [];
          } else if (Array.isArray(body.privateSkills)) {
            patch.globalMemories = body.privateSkills;
            patch.privateSkills = [];
          }
          if ("routing" in body) {
            const r = body.routing;
            if (!r || typeof r !== "object" || Array.isArray(r)) {
              return sendJson(res, 400, { error: "invalid routing payload" });
            }
            if (r.mode !== undefined && !ROUTING_MODES.includes(r.mode)) {
              return sendJson(res, 400, { error: "invalid routing.mode" });
            }
            if (r.maxTurnUsd !== undefined) {
              const v = Number(r.maxTurnUsd);
              if (!Number.isFinite(v) || v < 0.05 || v > 10) {
                return sendJson(res, 400, { error: "routing.maxTurnUsd must be between 0.05 and 10" });
              }
            }
            const cur = ctx.getMergedSettings().routing;
            patch.routing = normalizeRoutingSettings({ ...cur, ...r });
          }
          if ("contextCompression" in body) {
            const c = body.contextCompression;
            if (!c || typeof c !== "object" || Array.isArray(c)) {
              return sendJson(res, 400, { error: "invalid contextCompression payload" });
            }
            const cur = ctx.getMergedSettings().contextCompression;
            patch.contextCompression = normalizeContextCompressionSettings({
              ...cur,
              ...c,
            });
          }
          if ("screenPool" in body) {
            const sp = body.screenPool;
            if (!sp || typeof sp !== "object" || Array.isArray(sp)) {
              return sendJson(res, 400, { error: "invalid screenPool payload" });
            }
            const mergedCur = ctx.getMergedSettings().screenPool;
            const normalizedSp = normalizeScreenPoolSettings(
              { ...mergedCur, ...sp },
              mergedCur?.budget
            );
            patch.screenPool = {
              mode: normalizedSp.mode,
              maxConcurrentScreens: normalizedSp.maxConcurrentScreens,
            };
          }
          if ("browserAutomation" in body) {
            const ba = body.browserAutomation;
            if (!ba || typeof ba !== "object" || Array.isArray(ba)) {
              return sendJson(res, 400, { error: "invalid browserAutomation payload" });
            }
            if (
              ba.mode !== undefined &&
              !VALID_BROWSER_AUTOMATION_MODES.includes(ba.mode)
            ) {
              return sendJson(res, 400, { error: "invalid browserAutomation.mode" });
            }
            const curBa = ctx.getMergedSettings().browserAutomation;
            patch.browserAutomation = normalizeBrowserAutomationSettings({
              ...curBa,
              ...ba,
            });
          }

          const saved = ctx.store?.writeSettings?.(patch) || patch;
          if (patch.screenPool) {
            ctx.runner?.reconcileScreenPool?.();
            if (ctx.executor?.call) {
              Promise.resolve(
                ctx.executor.call(
                  "/displays/config",
                  { max_concurrent_screens: patch.screenPool.maxConcurrentScreens },
                  { skipWake: true }
                )
              ).catch(() => {});
            }
          }
          const merged = ctx.getMergedSettings();
          try {
            ctx.runner?.broadcastGlobal?.({ type: "settings_updated" });
          } catch {}
          return sendJson(res, 200, {
            ...merged,
            ...(ctx.store?.writeSettings ? {} : saved),
            connectedApps: merged.connectedApps,
          });
        }

  return false;
}
