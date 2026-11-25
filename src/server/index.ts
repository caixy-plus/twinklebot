import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../lib/config.js";
import {
  probeGcpServerEnvironment,
  resolveGeminiVertexRuntime,
  type GcpEnvironmentProbe,
} from "../lib/gcp-env.js";
import { createStore } from "../store/index.js";
import { createModel } from "../agent/model.js";
import { createLocalAwareExecutorClient } from "../lib/bot-computer-provisioner.js";
import { createRunner } from "../agent/runner.js";
import { createScheduler } from "../agent/scheduler.js";
import {
  normalizeMailAuthStore,
  sanitizeMailAccount,
} from "../lib/mail-client.js";
import {
  PLATFORM_SKILLS,
  OFFICE_SKILLS,
  resolveInstalledSkillIds,
} from "../shared/skills-catalog.js";
import { normalizeContextCompressionSettings } from "../shared/context-compression.js";
import { normalizeScreenPoolSettings } from "../shared/screen-pool.js";
import { normalizeBrowserAutomationSettings } from "../shared/browser-automation.js";
import { normalizeLanguagePreference } from "../shared/i18n.js";
import { closeAllLocalBrowsers } from "../lib/local-chrome-cdp.js";
import { getHostScreenPoolBudget } from "../agent/screen-pool-manager.js";
import {
  DEFAULT_MCP_SERVERS,
  createMcpManager,
} from "../lib/mcp-client.js";
import { updateBotComputer } from "../lib/bot-computer-updater.js";
import { probeBotComputerState } from "../lib/bot-computer-provisioner.js";
import { stopWslKeepalive } from "../lib/wsl-ubuntu.js";
import { createRuntimeState } from "../lib/runtime-state.js";
import { attachWebSocketServer } from "../lib/ws-server.js";
import { createHostBridge } from "../lib/host-bridge.js";
import { createDeviceAuthManager } from "../lib/device-auth.js";
import { buildDiscoveryInfo, startLanDiscoveryResponder } from "../lib/lan-discovery.js";
import {
  isProviderUsable,
  normalizeProvidersConfig,
  reconcileRoutingTiers,
  sanitizeProvidersForClient,
  testProviderConnection,
} from "../agent/providers/registry.js";
import { normalizeRoutingSettings } from "../agent/route-stats.js";
import { normalizeGoogleBillingSettings } from "../lib/gcp-billing.js";
import { resolveProjectRoot } from "../lib/project-root.js";
import {
  DEFAULT_POLICY,
  DEFAULT_PRIVATE_SKILLS,
  VALID_HOST_EXEC_MODES,
  VALID_PROFILE_COLORS,
  parseJsonBody,
  sendJson,
} from "./http-utils.js";
import type { RouteHandler, ServerContext } from "./context.js";
import { createNovncUpgradeHandler, handleStaticAndNoVnc } from "./static.js";
import { handleLanHostRoutes } from "./routes/lan-host.js";
import { handleSettingsProvidersRoutes } from "./routes/settings-providers.js";
import { handleSkillsRoutes } from "./routes/skills.js";
import { handleMailRoutes } from "./routes/mail.js";
import { handleChannelRoutes } from "./routes/channels.js";
import { handleSystemRoutes, runDueLiveBalanceRefreshes } from "./routes/system.js";
import { handleSchedulesVaultRoutes } from "./routes/schedules-vault.js";
import { handleMediaFilesRoutes } from "./routes/media-files.js";
import { handleSessionRoutes } from "./routes/sessions.js";
import { createChannelManager } from "../lib/channel-manager.js";

const __filename = fileURLToPath(import.meta.url);
const _DIR = path.resolve(path.dirname(__filename));
const PROJECT_ROOT = resolveProjectRoot(_DIR);
const PUBLIC_DIR = path.resolve(PROJECT_ROOT, "public");
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8")
    );
    return String(pkg.version || "1.0.0");
  } catch {
    return "1.0.0";
  }
})();

const API_ROUTE_HANDLERS: RouteHandler[] = [
  handleLanHostRoutes,
  handleSettingsProvidersRoutes,
  handleSkillsRoutes,
  handleMailRoutes,
  handleChannelRoutes,
  handleSystemRoutes,
  handleSchedulesVaultRoutes,
  handleMediaFilesRoutes,
  handleSessionRoutes,
];

export function createServer({
  config = {},
  store,
  runner,
  executor,
  model,
  mcpManager,
  scheduler,
  updateBotComputerFn = updateBotComputer,
  probeBotComputerFn = probeBotComputerState,
  testProviderFn = testProviderConnection,
  billingFetchImpl,
  gcpProbe = null,
  getEffectivePublicDir,
  otaController,
  desktopController,
  env = process.env,
}: {
  config?: Record<string, any>;
  store?: any;
  runner?: any;
  executor?: any;
  model?: any;
  mcpManager?: any;
  scheduler?: any;
  updateBotComputerFn?: typeof updateBotComputer;
  probeBotComputerFn?: typeof probeBotComputerState;
  testProviderFn?: typeof testProviderConnection;
  billingFetchImpl?: typeof globalThis.fetch;
  gcpProbe?: GcpEnvironmentProbe | null;
  getEffectivePublicDir?: () => string;
  otaController?: ServerContext["otaController"];
  desktopController?: ServerContext["desktopController"];
  env?: Record<string, string | undefined>;
} = {}): http.Server & { hostBridge?: any } {
  const activeMcpManager =
    mcpManager ??
    runner?.mcpManager ??
    createMcpManager({
      getServersConfig: () => store?.readSettings?.()?.mcpServers || {},
    });

  const finalConfig: Record<string, any> = {
    deployEnv: "local",
    initialRole: "master",
    sandboxMode: "full",
    host: "127.0.0.1",
    port: 3230,
    cloudAuthToken: "",
    localControlToken: "",
    novncUrl: "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale",
    defaultModel: "gemini-4-argon",
    deepModel: "gemini-4-carbon",
    fastModel: "gemini-4-hydrogen",
    thinkingSummaryModel: "gemini-4-hydrogen",
    imageModel: "gemini-3.1-flash-image",
    proImageModel: "gemini-3-pro-image",
    fallbackImageModel: "gemini-2.5-flash-image",
    models: ["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"],
    screen: { width: 1440, height: 900 },
    writeRoots: [
      path.join(os.homedir(), "TwinkleBot", "workspace"),
      path.join(os.homedir(), "Downloads"),
    ],
    ...config,
  };

  const effectiveEnv: Record<string, string | undefined> = {
    ...env,
    ...(finalConfig.useVertexAi && env.GOOGLE_GENAI_USE_VERTEXAI === undefined
      ? { GOOGLE_GENAI_USE_VERTEXAI: "true" }
      : {}),
    ...(finalConfig.vertexProject && !env.GOOGLE_CLOUD_PROJECT
      ? { GOOGLE_CLOUD_PROJECT: String(finalConfig.vertexProject) }
      : {}),
    ...(finalConfig.vertexLocation && !env.GOOGLE_CLOUD_LOCATION
      ? { GOOGLE_CLOUD_LOCATION: String(finalConfig.vertexLocation) }
      : {}),
  };

  const geminiVertexRuntime = resolveGeminiVertexRuntime({
    deployEnv: finalConfig.deployEnv,
    env: effectiveEnv,
    gcpProbe,
  });

  const effectiveNovncProxyTarget = (() => {
    const explicit = String(finalConfig.novncProxyTarget || "").trim();
    if (explicit) return explicit;
    if (/^https?:\/\//i.test(String(finalConfig.novncUrl || ""))) {
      try {
        return new URL(finalConfig.novncUrl).origin;
      } catch {
        return "";
      }
    }
    return "";
  })();

  const runtimeState = createRuntimeState({
    deployEnv: finalConfig.deployEnv,
    initialRole: finalConfig.initialRole,
  });
  const deviceAuth = createDeviceAuthManager(store, {
    dataDir: finalConfig.dataDir,
  });

  let cachedInstanceId = "";
  function getInstanceId() {
    if (cachedInstanceId) return cachedInstanceId;
    const raw = store?.readSettings?.() || {};
    if (raw.instanceId && typeof raw.instanceId === "string") {
      cachedInstanceId = raw.instanceId;
      return cachedInstanceId;
    }
    cachedInstanceId = crypto.randomUUID();
    try {
      store?.writeSettings?.({ instanceId: cachedInstanceId });
    } catch {}
    return cachedInstanceId;
  }

  function isLanAccessEnabled() {
    const raw = store?.readSettings?.() || {};
    if (typeof raw.lanAccess === "boolean") return raw.lanAccess;
    return Boolean(finalConfig.lanAccess || finalConfig.host === "0.0.0.0");
  }

  function getDiscoveryPayload() {
    const addr = server.address();
    const listeningPort =
      typeof addr === "object" && addr && addr.port ? addr.port : finalConfig.port;
    return buildDiscoveryInfo({
      instanceId: getInstanceId(),
      hostname: os.hostname(),
      platform: process.platform,
      port: listeningPort,
      appVersion: APP_VERSION,
      lanAccessEnabled: isLanAccessEnabled(),
    });
  }

  const defaultUserName = (() => {
    try {
      const u = os.userInfo()?.username;
      return u && String(u).trim() ? String(u).trim() : "本地用户";
    } catch {
      return "本地用户";
    }
  })();

  function getInstalledSkills() {
    return resolveInstalledSkillIds(store?.readSettings?.() || {});
  }

  const channelManager = createChannelManager({
    store,
    runner,
    getInstalledSkills,
    fetchImpl: billingFetchImpl || fetch,
    onStateChange: () => broadcastSkillsUpdated(),
  });
  if (runner && typeof runner === "object") {
    runner.getChannelStatus = () => channelManager.getStatusPayload();
    runner.channelPairingActions = {
      listPairings: (filter?: any) => channelManager.listPairings(filter),
      approvePairing: (code: string, opts?: any) => channelManager.approvePairing(code, opts),
      rejectPairing: (code: string) => channelManager.rejectPairing(code),
      setApprovalEnabled: (
        channelId: any,
        accountId: string,
        chatId: string,
        enabled: boolean
      ) => channelManager.setApprovalEnabled(channelId, accountId, chatId, enabled),
      deleteApproval: (channelId: any, accountId: string, chatId: string) =>
        channelManager.deleteApproval(channelId, accountId, chatId),
    };
    runner.channelConfigActions = {
      ensureInstalled: (channelId: "feishu-bot" | "telegram-bot") => {
        const current = getInstalledSkills();
        if (!current.includes(channelId)) {
          const next = Array.from(new Set([...current, channelId]));
          store?.writeSettings?.({ installedSkills: next });
          channelManager.syncFromStore();
          broadcastSkillsUpdated();
        }
        return { ok: true };
      },
      upsertAccount: (
        channelId: "feishu-bot" | "telegram-bot",
        body: Record<string, any>,
        optsOrId?: string | { accountId?: string; createNew?: boolean }
      ) => {
        const opts =
          typeof optsOrId === "string"
            ? { accountId: optsOrId }
            : optsOrId && typeof optsOrId === "object"
              ? optsOrId
              : {};
        const res = channelManager.upsertAccount(channelId, body, opts);
        broadcastSkillsUpdated();
        return res;
      },
      deleteAccount: (channelId: "feishu-bot" | "telegram-bot", accountId: string) => {
        const res = channelManager.deleteAccount(channelId, accountId);
        broadcastSkillsUpdated();
        return res;
      },
      testChannel: (
        channelId: "feishu-bot" | "telegram-bot",
        overrides?: Record<string, any>,
        accountId?: string
      ) => channelManager.testChannel(channelId, overrides, accountId),
      reconnectAccount: (channelId: "feishu-bot" | "telegram-bot", accountId?: string) => {
        channelManager.reconnectAccount(channelId, accountId);
        broadcastSkillsUpdated();
      },
    };
  }

  function broadcastSkillsUpdated() {
    try {
      runner?.broadcastGlobal?.({ type: "skills_updated" });
    } catch {}
  }

  function getSanitizedMailState() {
    const installed = getInstalledSkills();
    const channelStatus = channelManager.getStatusPayload() as Record<string, any>;
    const { accounts } = normalizeMailAuthStore(store?.readMailAuth?.() || {});
    const allSanitized = accounts.map((acct) =>
      sanitizeMailAccount(acct, acct.provider)
    );
    const mailAccounts = allSanitized.filter((a) => installed.includes(a.provider));
    if (mailAccounts.length > 0 && !mailAccounts.some((a) => a.isDefault)) {
      const fallback = mailAccounts.find((a) => a.enabled) || mailAccounts[0];
      fallback.isDefault = Boolean(fallback.enabled);
    }
    const skillsCatalog = {
      platform: PLATFORM_SKILLS.map((s) => {
        const isBuiltin = s.builtin !== false;
        const chEntry = channelStatus[s.id];
        const chAccounts: any[] = Array.isArray(chEntry?.accounts) ? chEntry.accounts : [];
        const configured = chEntry
          ? chAccounts.length > 0
            ? chAccounts.some((a) => Boolean(a?.config?.configured))
            : Boolean(chEntry.config?.configured)
          : false;
        const connected = chEntry
          ? chAccounts.length > 0
            ? chAccounts.some((a) => Boolean(a?.runtime?.connected))
            : Boolean(chEntry.runtime?.connected)
          : false;
        const accountCount = chEntry
          ? chAccounts.length > 0
            ? chAccounts.filter((a) => Boolean(a?.config?.configured)).length
            : chEntry.config?.configured
              ? 1
              : 0
          : 0;
        const hasAnySaved = (cfg: any) =>
          Boolean(
            cfg?.configured ||
              cfg?.hasWebhookSecret ||
              cfg?.hasVerificationToken ||
              cfg?.hasEncryptKey
          );
        const savedAccountCount = chEntry
          ? chAccounts.length > 0
            ? chAccounts.filter((a) => hasAnySaved(a?.config)).length
            : hasAnySaved(chEntry.config)
              ? 1
              : 0
          : 0;
        const pendingPairingCount = chEntry
          ? chAccounts.reduce(
              (sum, a) =>
                sum + (Array.isArray(a?.config?.pendingPairings) ? a.config.pendingPairings.length : 0),
              0
            )
          : 0;
        return {
          ...s,
          installed: isBuiltin ? true : installed.includes(s.id),
          removable: !isBuiltin,
          ...(chEntry
            ? {
                configured,
                connected,
                accountCount,
                savedAccountCount,
                pendingPairingCount,
              }
            : {}),
        };
      }),
      office: OFFICE_SKILLS.map((s) => {
        const saved = allSanitized.filter((a) => a.provider === s.id).length;
        const isInstalled = installed.includes(s.id);
        return {
          ...s,
          installed: isInstalled,
          removable: true,
          accountCount: isInstalled ? saved : 0,
          savedAccountCount: saved,
        };
      }),
    };
    const pickProviderSummary = (provider: string) => {
      const matching = mailAccounts.filter((a) => a.provider === provider);
      return (
        matching.find((a) => a.isDefault && a.enabled) ||
        matching.find((a) => a.enabled) ||
        matching[0] ||
        sanitizeMailAccount({}, provider)
      );
    };
    const mailIntegrations = {
      qqmail: pickProviderSummary("qqmail"),
      "custom-mail": pickProviderSummary("custom-mail"),
    };
    const connectedApps = ["qqmail", "custom-mail"].filter((provider) =>
      mailAccounts.some((a) => a.provider === provider && a.enabled && a.configured)
    );
    return {
      rawAccounts: accounts,
      mailAccounts,
      mailIntegrations,
      connectedApps,
      installedSkills: installed,
      skillsCatalog,
    };
  }

  function sanitizeMcpServersMap(rawMap: unknown) {
    const merged: Record<string, any> = {
      ...DEFAULT_MCP_SERVERS,
      ...(rawMap && typeof rawMap === "object" && !Array.isArray(rawMap) ? rawMap : {}),
    };
    const clean: Record<string, any> = {};
    for (const [id, cfg] of Object.entries(merged)) {
      if (!cfg || typeof cfg !== "object") continue;
      clean[id] = {
        type: cfg.type === "stdio" || !cfg.type ? "stdio" : String(cfg.type),
        command: String(cfg.command || ""),
        args: Array.isArray(cfg.args) ? cfg.args.map((a: any) => String(a)) : [],
      };
    }
    return clean;
  }

  function getHostDeviceInfo(executionMode = "always") {
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      online: true,
      executionMode,
    };
  }

  function resolveRawProviders() {
    const raw = store?.readSettings?.() || {};
    return normalizeProvidersConfig(raw.providers, {
      geminiApiKey: finalConfig.geminiApiKey || "",
      geminiVertexRuntime,
    });
  }

  function hasUsableProviderConfig(providers: any[] = []) {
    return (Array.isArray(providers) ? providers : []).some((p) =>
      isProviderUsable(p, effectiveEnv, geminiVertexRuntime)
    );
  }

  function getMergedSettings() {
    const raw = store?.readSettings?.() || {};
    const rawProviders = resolveRawProviders();
    const onboardingRequired = !hasUsableProviderConfig(rawProviders);
    const rawProfile = raw.profile && typeof raw.profile === "object" ? raw.profile : {};
    const profileName =
      String(rawProfile.name || defaultUserName).trim().slice(0, 32) ||
      defaultUserName;
    const profileColor = VALID_PROFILE_COLORS.has(rawProfile.color)
      ? rawProfile.color
      : "slate";
    const executionMode = VALID_HOST_EXEC_MODES.has(raw.hostComputer?.executionMode)
      ? raw.hostComputer.executionMode
      : "always";
    const { mailAccounts, mailIntegrations, connectedApps, installedSkills, skillsCatalog } =
      getSanitizedMailState();
    const resolvedModel =
      raw.model === "gemini-3.8-flash"
        ? finalConfig.fastModel || "gemini-4-hydrogen"
        : raw.model || finalConfig.defaultModel;
    return {
      model: resolvedModel,
      language: normalizeLanguagePreference(raw.language),
      theme: raw.theme || "system",
      accentMode: raw.accentMode || "bot",
      spellcheckEnabled: raw.spellcheckEnabled !== false,
      profile: {
        name: profileName,
        color: profileColor,
      },
      voice: raw.voice || { name: "Liora", speed: 1, lang: "Auto-detect" },
      autoExpandScreen: Boolean(raw.autoExpandScreen),
      hostComputer: {
        executionMode,
      },
      browserAutomation: normalizeBrowserAutomationSettings(raw.browserAutomation),
      contextCompression: normalizeContextCompressionSettings(raw.contextCompression),
      screenPool: normalizeScreenPoolSettings(
        raw.screenPool,
        runner?.getScreenPoolBudget?.() || getHostScreenPoolBudget()
      ),
      mcpServers: sanitizeMcpServersMap(raw.mcpServers),
      routing: normalizeRoutingSettings(
        reconcileRoutingTiers(
          rawProviders,
          raw.routing,
          effectiveEnv,
          geminiVertexRuntime
        ).routing
      ),
      providers: sanitizeProvidersForClient(
        rawProviders,
        effectiveEnv,
        geminiVertexRuntime
      ),
      gcpVertexActive: geminiVertexRuntime.vertexActive,
      ...(geminiVertexRuntime.vertexActive
        ? {
            gcpVertexProject: geminiVertexRuntime.project,
            gcpVertexLocation: geminiVertexRuntime.location,
          }
        : {}),
      ...(geminiVertexRuntime.blockedReason
        ? { blockedVertexReason: geminiVertexRuntime.blockedReason }
        : {}),
      onboardingRequired,
      onboardingCompleted: raw.onboardingCompleted === true || !onboardingRequired,
      googleBilling: normalizeGoogleBillingSettings(raw.googleBilling),
      policy: raw.policy || DEFAULT_POLICY,
      globalMemories: Array.isArray(raw.globalMemories)
        ? raw.globalMemories
        : Array.isArray(raw.privateSkills)
          ? raw.privateSkills
          : DEFAULT_PRIVATE_SKILLS,
      privateSkills: Array.isArray(raw.globalMemories)
        ? raw.globalMemories
        : Array.isArray(raw.privateSkills)
          ? raw.privateSkills
          : DEFAULT_PRIVATE_SKILLS,
      connectedApps,
      mailAccounts,
      mailIntegrations,
      channelIntegrations: channelManager.getStatusPayload(),
      installedSkills,
      skillsCatalog,
      customSkills: store?.listCustomSkills?.() || [],
    };
  }

  let ctx!: ServerContext;

  const server: http.Server & { hostBridge?: any } = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const rawPathname = url.pathname;
      let pathname: string;
      try {
        pathname = decodeURIComponent(rawPathname);
      } catch {
        return sendJson(res, 400, { error: "bad request" });
      }
      if (pathname.includes("\0")) {
        return sendJson(res, 404, { error: "not found" });
      }
      const method = (req.method || "GET").toUpperCase();

      const origin = req.headers.origin;
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Local-Token"
        );
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PATCH, DELETE, OPTIONS"
        );
      }
      if (method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }

      if (method === "GET" && pathname === "/api/system/health") {
        return sendJson(res, 200, {
          ok: true,
          deployEnv: runtimeState.deployEnv,
          role: runtimeState.role,
          appVersion: APP_VERSION,
        });
      }

      if (method === "GET" && pathname === "/api/discovery/info") {
        return sendJson(res, 200, getDiscoveryPayload());
      }

      if (method === "POST" && pathname === "/api/lan/pair/request") {
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return sendJson(res, 400, { error: "invalid json" });
        }
        const challenge = deviceAuth.createPairingRequest({
          deviceName: body?.deviceName,
          platform: body?.platform,
          deviceId: body?.deviceId,
          remoteAddress: req.socket?.remoteAddress || "",
        });
        try {
          runner?.broadcastGlobal?.({
            type: "lan_pairing_requested",
            pairingId: challenge.pairingId,
            code: challenge.code,
            deviceName: challenge.deviceName,
            platform: challenge.platform,
            expiresAt: challenge.expiresAt,
          });
        } catch {}
        return sendJson(res, 200, {
          ok: true,
          pairingId: challenge.pairingId,
          expiresAt: challenge.expiresAt,
        });
      }

      if (method === "POST" && pathname === "/api/lan/pair/verify") {
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          return sendJson(res, 400, { error: "invalid json" });
        }
        try {
          const result = deviceAuth.verifyPairing({
            pairingId: body?.pairingId,
            code: body?.code,
            deviceName: body?.deviceName,
            platform: body?.platform,
          });
          try {
            runner?.broadcastGlobal?.({
              type: "lan_device_paired",
              device: result.device,
            });
          } catch {}
          return sendJson(res, 200, {
            ...getDiscoveryPayload(),
            ok: true,
            device: result.device,
            deviceId: result.device.id,
            deviceToken: result.deviceToken,
          });
        } catch (err: any) {
          return sendJson(res, 403, { error: err?.message || "配对验证失败" });
        }
      }

      const isExternalChannelWebhook =
        method === "POST" &&
        (pathname === "/api/channels/telegram/webhook" ||
          pathname === "/api/channels/feishu/webhook");

      if (
        !isExternalChannelWebhook &&
        runtimeState.deployEnv === "local" &&
        (pathname.startsWith("/api/") || pathname === "/ws") &&
        !deviceAuth.isAuthorized(req, url)
      ) {
        return sendJson(res, 401, { error: "unauthorized: device pairing required" });
      }

      if (
        !isExternalChannelWebhook &&
        runtimeState.deployEnv === "cloud" &&
        finalConfig.cloudAuthToken &&
        (pathname.startsWith("/api/") || pathname === "/ws")
      ) {
        const authHeader = String(req.headers.authorization || "").trim();
        const bearerTok = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        const queryTok = (url.searchParams.get("token") || "").trim();
        const suppliedTok = bearerTok || queryTok;
        if (!suppliedTok || suppliedTok !== finalConfig.cloudAuthToken) {
          return sendJson(res, 401, { error: "unauthorized: invalid cloud token" });
        }
      }

      const accessCheck = runtimeState.canAccessRoute(pathname, method);
      if (!accessCheck.allowed) {
        return sendJson(res, accessCheck.status || 409, {
          error: accessCheck.reason || "suspended in host_executor mode",
          role: runtimeState.role,
        });
      }

      if (pathname.startsWith("/api/")) {
        for (const handler of API_ROUTE_HANDLERS) {
          if (await handler(req, res, url, pathname, method, ctx)) {
            return;
          }
        }
        return sendJson(res, 404, { error: "not found" });
      }

      return handleStaticAndNoVnc(req, res, url, pathname, method, ctx);
    } catch {
      if (!res.headersSent) {
        return sendJson(res, 500, { error: "internal server error" });
      }
    }
  });

  let hostBridge: any = null;
  const wsServer = attachWebSocketServer(server, {
    path: "/ws",
    authenticate(_req, parsedUrl) {
      if (runtimeState.deployEnv === "local") {
        return deviceAuth.isAuthorized(_req, parsedUrl);
      }
      if (runtimeState.deployEnv === "cloud" && finalConfig.cloudAuthToken) {
        const authHeader = String(_req.headers.authorization || "").trim();
        const bearerTok = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        const queryTok = (parsedUrl.searchParams.get("token") || "").trim();
        return (bearerTok || queryTok) === finalConfig.cloudAuthToken;
      }
      return true;
    },
    onMessage(client, msg) {
      if (msg && msg.type === "ping") {
        client.send({ type: "pong", at: Date.now() });
      } else if (msg && msg.type === "host_hello") {
        hostBridge?.registerHostMeta?.(client.id, msg);
        try {
          runner?.broadcastGlobal?.({
            type: "computer_status_updated",
            connectedHosts: hostBridge?.listConnectedHosts?.() || [],
            selectedHostId: hostBridge?.getSelectedHostId?.() || null,
          });
        } catch {}
      } else if (msg && msg.type === "host_rpc_response" && msg.rpcId) {
        hostBridge?.resolveRpc?.(msg.rpcId, msg);
      }
    },
    onClose(client) {
      const hadHost = hostBridge
        ?.listConnectedHosts?.()
        ?.some((h: any) => h.clientId === client.id);
      hostBridge?.rejectAllForClient?.(client.id);
      if (hadHost) {
        try {
          runner?.broadcastGlobal?.({
            type: "computer_status_updated",
            connectedHosts: hostBridge?.listConnectedHosts?.() || [],
            selectedHostId: hostBridge?.getSelectedHostId?.() || null,
          });
        } catch {}
      }
    },
    onOtherUpgrade(req, socket, head, parsedUrl) {
      return createNovncUpgradeHandler(ctx)(req, socket, head, parsedUrl);
    },
  });

  hostBridge = createHostBridge({ wsServer });
  server.hostBridge = hostBridge;
  if (runner && typeof runner === "object" && !runner.hostBridge) {
    runner.hostBridge = hostBridge;
  }

  ctx = {
    projectRoot: PROJECT_ROOT,
    publicDir: PUBLIC_DIR,
    getEffectivePublicDir,
    otaController,
    desktopController,
    appVersion: APP_VERSION,
    server,
    finalConfig,
    geminiVertexRuntime,
    effectiveNovncProxyTarget,
    runtimeState,
    deviceAuth,
    store,
    runner,
    executor,
    model,
    scheduler,
    activeMcpManager,
    channelManager,
    hostBridge,
    updateBotComputerFn,
    probeBotComputerFn,
    testProviderFn,
    getDiscoveryPayload,
    isLanAccessEnabled,
    getInstalledSkills,
    broadcastSkillsUpdated,
    getSanitizedMailState,
    sanitizeMcpServersMap,
    getHostDeviceInfo,
    resolveRawProviders,
    hasUsableProviderConfig,
    getMergedSettings,
    billingFetchImpl,
    broadcastEvent: (ev: Record<string, unknown>) => {
      if (typeof runner?.broadcastGlobal === "function") {
        runner.broadcastGlobal(ev);
      } else {
        wsServer.broadcast(ev);
      }
    },
  };

  let billingRefreshInFlight = false;
  const billingRefreshTimer = setInterval(() => {
    if (billingRefreshInFlight) return;
    billingRefreshInFlight = true;
    runDueLiveBalanceRefreshes(ctx)
      .catch(() => {})
      .finally(() => {
        billingRefreshInFlight = false;
      });
  }, 60_000);
  if (typeof billingRefreshTimer.unref === "function") {
    billingRefreshTimer.unref();
  }

  const unsubscribeWs =
    typeof runner?.subscribe === "function"
      ? runner.subscribe((event: any) => {
          wsServer.broadcast(event);
        })
      : () => {};

  let lanResponder: any = null;
  server.on("listening", () => {
    try {
      channelManager.syncFromStore();
    } catch {}
    if (
      runtimeState.deployEnv === "local" &&
      finalConfig.lanAccess &&
      finalConfig.host === "0.0.0.0" &&
      !lanResponder
    ) {
      startLanDiscoveryResponder({
        getInfo: getDiscoveryPayload,
      })
        .then((r) => {
          lanResponder = r;
        })
        .catch(() => {});
    }
  });

  const origClose = server.close.bind(server);
  server.close = (cb?: (err?: Error) => void) => {
    try {
      clearInterval(billingRefreshTimer);
    } catch {}
    try {
      unsubscribeWs();
    } catch {}
    try {
      lanResponder?.close?.();
      lanResponder = null;
    } catch {}
    wsServer.close();
    return origClose(cb);
  };

  server.on("close", () => {
    try {
      clearInterval(billingRefreshTimer);
    } catch {}
    try {
      unsubscribeWs();
    } catch {}
    try {
      lanResponder?.close?.();
      lanResponder = null;
    } catch {}
    wsServer.close();
    activeMcpManager?.closeAll?.();
    channelManager.stopAll();
    void closeAllLocalBrowsers();
    stopWslKeepalive();
  });

  return server;
}

if (
  process.env.TWINKLEBOT_DESKTOP_WORKER !== "1" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const config = loadConfig(process.env);
  const gcpProbe = await probeGcpServerEnvironment({ deployEnv: config.deployEnv });
  const geminiVertexRuntime = resolveGeminiVertexRuntime({
    deployEnv: config.deployEnv,
    env: process.env,
    gcpProbe,
  });
  if (geminiVertexRuntime.blockedReason) {
    console.warn(`[TwinkleBot] ${geminiVertexRuntime.blockedReason}`);
  }
  const store = createStore(config.dataDir);
  const model = createModel({
    apiKey: config.geminiApiKey,
    geminiVertexRuntime,
    getProviders: () => store.readSettings()?.providers || [],
    getRouting: () => store.readSettings()?.routing || {},
  });
  const executor = createLocalAwareExecutorClient({
    url: config.executorUrl,
    token: config.executorToken,
    deployEnv: config.deployEnv,
    store,
  });
  const runner = createRunner({ store, config, model, executor });
  const scheduler = createScheduler({ store, runner });
  store.markInterrupted();
  scheduler.start();
  const server = createServer({
    config,
    store,
    runner,
    executor,
    model,
    scheduler,
    gcpProbe,
  });
  server.listen(config.port, config.host, () => {
    console.log(
      `TwinkleBot server listening on http://${config.host}:${config.port}`
    );
  });
  const shutdownStandalone = () => {
    void closeAllLocalBrowsers().finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  };
  process.once("SIGINT", shutdownStandalone);
  process.once("SIGTERM", shutdownStandalone);
}

export default { createServer };
