import http from "node:http";
import os from "node:os";
import type { ServerContext } from "../context.js";
import { parseJsonBody, sendJson } from "../http-utils.js";
import { isLoopbackAddress } from "../../lib/device-auth.js";
import { renderQrSvg } from "../../shared/qr-svg.js";
import {
  LOCAL_ACCOUNT_ID,
  encodeRelayInviteUri,
  normalizeAccountsState,
  normalizeBaseUrl,
  parseRelayInvite,
  probeRemoteNodeIdentity,
  removeCloudAccount,
  upsertCloudAccount,
  type AccountEntry,
  type AccountsState,
} from "../../shared/accounts-store.js";

export function isRelayIngressRequest(req: http.IncomingMessage | any): boolean {
  return Boolean(req && req.__twinkleRelayIngress);
}

export function isLocalDesktopControlRequest(req: http.IncomingMessage | any): boolean {
  if (isRelayIngressRequest(req)) return false;
  const remoteAddr = req?.socket?.remoteAddress || req?.connection?.remoteAddress || "";
  return isLoopbackAddress(remoteAddr);
}

function resolveBestLanUrl(port: number): string {
  const ifaces = os.networkInterfaces();
  let fallback = "";
  for (const list of Object.values(ifaces)) {
    if (!Array.isArray(list)) continue;
    for (const info of list) {
      if (!info || info.family !== "IPv4" || info.internal) continue;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(info.address)) {
        return `http://${info.address}:${port}`;
      }
      if (!fallback) fallback = `http://${info.address}:${port}`;
    }
  }
  return fallback;
}

export function sanitizeAccountForDisplay(acc: AccountEntry) {
  const { authToken, relayToken, ...rest } = acc;
  return {
    ...rest,
    hasAuthToken: Boolean(authToken),
    hasRelayToken: Boolean(relayToken),
  };
}

export function createAccountDirectoryActions({
  store,
  fetchImpl = globalThis.fetch,
  broadcastEvent,
  getOwnInstanceId,
  getOwnPublicUrl,
  getOwnPorts,
  getOwnDeployEnv,
}: {
  store: any;
  fetchImpl?: typeof globalThis.fetch;
  broadcastEvent?: (ev: Record<string, unknown>) => void;
  getOwnInstanceId?: () => string;
  getOwnPublicUrl?: () => string;
  getOwnPorts?: () => number[];
  getOwnDeployEnv?: () => "local" | "cloud";
}) {
  function isSelfTarget(candidateUrl: string, candidateInstanceId = ""): boolean {
    const ownEnv = getOwnDeployEnv?.() || "local";
    if (ownEnv !== "local") return false;
    const ownId = String(getOwnInstanceId?.() || "").trim();
    if (ownId && candidateInstanceId && candidateInstanceId === ownId) {
      return true;
    }
    const ownPublic = String(getOwnPublicUrl?.() || "").trim();
    if (ownPublic && candidateUrl) {
      try {
        if (normalizeBaseUrl(ownPublic) === normalizeBaseUrl(candidateUrl)) {
          return true;
        }
      } catch {}
    }
    if (candidateUrl) {
      try {
        const u = new URL(candidateUrl);
        const host = u.hostname.toLowerCase();
        const isLoop =
          host === "127.0.0.1" ||
          host === "localhost" ||
          host === "::1" ||
          host === "[::1]" ||
          host === "0.0.0.0";
        if (isLoop) {
          const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
          const ownPorts = (getOwnPorts?.() || []).filter((p) => Number.isFinite(p) && p > 0);
          if (ownPorts.includes(port)) {
            return true;
          }
        }
      } catch {}
    }
    return false;
  }

  function readDirectoryState(): AccountsState {
    const raw = store?.readAccountsAuth?.() || {};
    return normalizeAccountsState(raw);
  }

  function writeDirectoryState(next: AccountsState): AccountsState {
    const normalized = normalizeAccountsState(next);
    const saved = {
      activeAccountId: LOCAL_ACCOUNT_ID,
      accounts: normalized.accounts.filter((a) => a.id !== LOCAL_ACCOUNT_ID),
    };
    store?.writeAccountsAuth?.(saved);
    return normalizeAccountsState(saved);
  }

  function list({ includeSecrets = false }: { includeSecrets?: boolean } = {}) {
    const remote = readDirectoryState().accounts.filter((a) => a.id !== LOCAL_ACCOUNT_ID);
    return includeSecrets ? remote : remote.map(sanitizeAccountForDisplay);
  }

  async function upsert(input: Record<string, any> = {}) {
    const inviteRaw = String(input.inviteUri || input.invite_uri || "").trim();
    const parsedInvite = inviteRaw ? parseRelayInvite(inviteRaw) : null;
    if (inviteRaw && !parsedInvite) {
      return { ok: false, error: "无法识别的配对链接或中继地址格式" };
    }

    const rawUrl = String(
      input.baseUrl ||
        input.base_url ||
        input.relayUrl ||
        input.relay_url ||
        parsedInvite?.relayUrl ||
        ""
    ).trim();
    if (!rawUrl) {
      return { ok: false, error: "请提供有效的服务器或中继地址（https://...）" };
    }

    let cleanUrl = "";
    let inlineToken = "";
    try {
      const u = new URL(rawUrl);
      const qTok = u.searchParams.get("token") || "";
      u.searchParams.delete("token");
      cleanUrl = normalizeBaseUrl(u.toString());
      inlineToken = qTok.trim();
    } catch (err: any) {
      return { ok: false, error: `地址格式无效：${err?.message || rawUrl}` };
    }

    const inviteInstanceId = String(input.instanceId || parsedInvite?.instanceId || "").trim();
    if (isSelfTarget(cleanUrl, inviteInstanceId)) {
      return {
        ok: false,
        error: "不能添加当前本机作为云端账号，请直接使用本地账号。",
      };
    }

    const suppliedToken = String(
      input.authToken ??
        input.auth_token ??
        input.relayToken ??
        input.relay_token ??
        parsedInvite?.relayToken ??
        inlineToken ??
        ""
    ).trim();
    const shouldProbe = input.probe !== false;
    const probe = shouldProbe
      ? await probeRemoteNodeIdentity(cleanUrl, suppliedToken, { fetchImpl })
      : null;

    if (probe && !probe.ok && (probe.status === 401 || probe.status === 403)) {
      return {
        ok: false,
        error: probe.error || "目标节点认证失败（401/403），请检查令牌是否正确",
        probe,
      };
    }

    const resolvedInstanceId = String(
      probe?.instanceId || inviteInstanceId || ""
    ).trim();
    if (isSelfTarget(cleanUrl, resolvedInstanceId)) {
      return {
        ok: false,
        error: "不能添加当前本机作为云端账号，请直接使用本地账号。",
        ...(probe ? { probe } : {}),
      };
    }

    const probedEnv =
      probe?.ok && probe.deployEnv
        ? probe.deployEnv
        : parsedInvite?.deployEnv ||
          (input.nodeDeployEnv === "local" || input.type === "lan"
            ? "local"
            : "cloud");

    const current = readDirectoryState();
    const resolvedName = String(
      input.name || parsedInvite?.name || probe?.hostname || parsedInvite?.hostname || ""
    ).trim();

    // All remote/scanned connections appear in the Cloud Accounts list without exposing internal relay vs VPS distinctions;
    // internal `nodeDeployEnv` still tracks whether the remote host runs `local` vs `cloud` so Desktop doesn't mis-switch host_executor.
    const nextState = upsertCloudAccount(current, {
      id: String(input.id || "").trim(),
      name: resolvedName || cleanUrl,
      baseUrl: cleanUrl,
      nodeDeployEnv: probedEnv === "local" ? "local" : "cloud",
      instanceId: resolvedInstanceId,
      hostname: probe?.hostname || parsedInvite?.hostname || "",
      platform: probe?.platform || parsedInvite?.platform || "",
      ...(suppliedToken ? { authToken: suppliedToken } : {}),
    });

    const persisted = writeDirectoryState(nextState);
    const savedEntry =
      persisted.accounts.find(
        (a) =>
          a.id !== LOCAL_ACCOUNT_ID &&
          ((resolvedInstanceId && a.instanceId === resolvedInstanceId) ||
            a.baseUrl === cleanUrl)
      ) || persisted.accounts[persisted.accounts.length - 1];

    const sanitized = savedEntry ? sanitizeAccountForDisplay(savedEntry) : null;
    try {
      broadcastEvent?.({
        type: "accounts_updated",
        action: "upsert",
        account: sanitized,
      });
    } catch {}

    return {
      ok: true,
      account: sanitized,
      ...(probe ? { probe } : {}),
    };
  }

  async function testAccount(accountRef = "") {
    const ref = String(accountRef || "").trim();
    const listAll = readDirectoryState().accounts.filter((a) => a.id !== LOCAL_ACCOUNT_ID);
    const target =
      listAll.find((a) => a.id === ref || a.name === ref || a.baseUrl === ref || a.relayUrl === ref) ||
      (listAll.length === 1 && !ref ? listAll[0] : null);
    if (!target) {
      return { ok: false, error: "未找到指定的账号" };
    }
    const targetUrl = target.relayUrl || target.baseUrl;
    const token = target.relayUrl ? target.relayToken || target.authToken || "" : target.authToken || "";
    const probe = await probeRemoteNodeIdentity(targetUrl, token, { fetchImpl });
    return {
      ok: probe.ok,
      account: sanitizeAccountForDisplay(target),
      probe,
    };
  }

  function remove(accountRef = "") {
    const ref = String(accountRef || "").trim();
    if (!ref || ref === LOCAL_ACCOUNT_ID) {
      return { ok: false, error: "不可删除当前默认本地账号" };
    }
    const current = readDirectoryState();
    const target = current.accounts.find(
      (a) => a.id !== LOCAL_ACCOUNT_ID && (a.id === ref || a.name === ref || a.baseUrl === ref || a.relayUrl === ref)
    );
    if (!target) {
      return { ok: false, error: `未找到账号：${ref}` };
    }
    const next = removeCloudAccount(current, target.id);
    writeDirectoryState(next);
    try {
      broadcastEvent?.({
        type: "accounts_updated",
        action: "remove",
        removedId: target.id,
      });
    } catch {}
    return {
      ok: true,
      removedId: target.id,
      removedName: target.name,
    };
  }

  return {
    list,
    upsert,
    testAccount,
    remove,
  };
}

export async function handleRelayAndAccountsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
  // GET /api/relay/ping — authoritative server identity & latency probe
  if (method === "GET" && pathname === "/api/relay/ping") {
    return sendJson(res, 200, {
      ok: true,
      relay: isRelayIngressRequest(req),
      deployEnv: ctx.runtimeState.deployEnv,
      instanceId: ctx.getInstanceId?.() || "",
      hostname: os.hostname(),
      platform: process.platform,
      appVersion: ctx.appVersion,
    });
  }

  if (pathname === "/api/relay/status" && method === "GET") {
    if (!ctx.relayManager) {
      return sendJson(res, 503, { error: "relay manager unavailable" });
    }
    await ctx.waitRelayListener?.();
    const reveal = url.searchParams.get("reveal") === "1" && isLocalDesktopControlRequest(req);
    const listeningPort = ctx.getRelayListeningPort?.() ?? null;
    const status = ctx.relayManager.getStatus({
      reveal,
      relayPortListening: Boolean(listeningPort),
    });
    return sendJson(res, 200, {
      ok: true,
      ...status,
      runtime: {
        ...status.runtime,
        relayListeningPort: listeningPort,
      },
    });
  }

  if (pathname === "/api/relay/config" && method === "POST") {
    if (!isLocalDesktopControlRequest(req)) {
      return sendJson(res, 403, { error: "Relay config changes require local desktop access" });
    }
    if (!ctx.relayManager) {
      return sendJson(res, 503, { error: "relay manager unavailable" });
    }
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const saved = ctx.relayManager.updateConfig(body);
    await ctx.syncRelayListener?.();
    if (saved.enabled && saved.mode === "frpc") {
      await ctx.relayManager.restart();
    } else if (saved.enabled && saved.mode === "external") {
      await ctx.relayManager.stop();
      ctx.relayManager.start();
    } else {
      await ctx.relayManager.stop();
    }
    ctx.broadcastEvent?.({ type: "relay_updated" });
    const listeningPort = ctx.getRelayListeningPort?.() ?? null;
    return sendJson(res, 200, {
      ok: true,
      ...ctx.relayManager.getStatus({ reveal: false, relayPortListening: Boolean(listeningPort) }),
    });
  }

  if (pathname === "/api/relay/control" && method === "POST") {
    if (!isLocalDesktopControlRequest(req)) {
      return sendJson(res, 403, { error: "Relay control requires local desktop access" });
    }
    if (!ctx.relayManager) {
      return sendJson(res, 503, { error: "relay manager unavailable" });
    }
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const action = String(body.action || "").trim();
    if (action === "start") {
      await ctx.syncRelayListener?.();
      const r = ctx.relayManager.start();
      ctx.broadcastEvent?.({ type: "relay_updated" });
      return sendJson(res, 200, { ok: r.ok, runtime: r });
    }
    if (action === "stop") {
      await ctx.relayManager.stop();
      ctx.broadcastEvent?.({ type: "relay_updated" });
      return sendJson(res, 200, { ok: true });
    }
    if (action === "restart") {
      await ctx.syncRelayListener?.();
      const r = await ctx.relayManager.restart();
      ctx.broadcastEvent?.({ type: "relay_updated" });
      return sendJson(res, 200, { ok: r.ok, runtime: r });
    }
    if (action === "test") {
      const result = await ctx.relayManager.testPublicEndpoint(String(body.publicUrl || ""));
      return sendJson(res, 200, result);
    }
    if (action === "rotate_token") {
      ctx.relayManager.rotateAccessToken();
      await ctx.syncRelayListener?.();
      return sendJson(res, 200, {
        ok: true,
        ...ctx.relayManager.getStatus({
          reveal: true,
          relayPortListening: Boolean(ctx.getRelayListeningPort?.()),
        }),
      });
    }
    if (action === "import_legacy") {
      try {
        const resImport = await ctx.relayManager.importLegacyRelay({
          unloadLaunchAgent: body.unloadLaunchAgent !== false,
          publicUrlOverride: String(body.publicUrl || ""),
        });
        await ctx.syncRelayListener?.();
        ctx.broadcastEvent?.({ type: "relay_updated" });
        return sendJson(res, 200, {
          ok: true,
          legacy: resImport.legacy,
          ...ctx.relayManager.getStatus({
            reveal: false,
            relayPortListening: Boolean(ctx.getRelayListeningPort?.()),
          }),
        });
      } catch (err: any) {
        return sendJson(res, 400, { error: err?.message || "导入失败" });
      }
    }
    return sendJson(res, 400, { error: `unknown action: ${action}` });
  }

  if (pathname === "/api/relay/invite" && method === "POST") {
    if (!isLocalDesktopControlRequest(req)) {
      return sendJson(res, 403, { error: "Relay invite generation requires local desktop access" });
    }
    if (!ctx.relayManager) {
      return sendJson(res, 503, { error: "relay manager unavailable" });
    }
    const cfg = ctx.relayManager.readConfig();
    if (!cfg.publicUrl) {
      return sendJson(res, 400, { error: "请先配置公网访问地址（publicUrl）" });
    }
    const mainPort = Number(ctx.finalConfig?.port || 3230);
    const lanUrl = ctx.isLanAccessEnabled?.() ? resolveBestLanUrl(mainPort) : "";
    const payload = {
      v: 1,
      instanceId: ctx.getInstanceId?.() || "",
      hostname: os.hostname(),
      platform: process.platform,
      deployEnv: ctx.runtimeState.deployEnv,
      relayUrl: cfg.publicUrl,
      relayToken: cfg.accessToken,
      ...(lanUrl ? { lanUrl } : {}),
    };
    const inviteUri = encodeRelayInviteUri(payload);
    const qrSvg = renderQrSvg(inviteUri, { size: 184, margin: 2 });
    return sendJson(res, 200, {
      ok: true,
      inviteUri,
      qrSvg,
      publicUrl: cfg.publicUrl,
      ...(lanUrl ? { lanUrl } : {}),
    });
  }

  if (pathname === "/api/relay/templates" && method === "POST") {
    if (!isLocalDesktopControlRequest(req)) {
      return sendJson(res, 403, { error: "Relay templates require local desktop access" });
    }
    if (!ctx.relayManager) {
      return sendJson(res, 503, { error: "relay manager unavailable" });
    }
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const cfg = ctx.relayManager.readConfig();
    const templates = ctx.relayManager.generateServerTemplates({
      domain: String(body.domain || "bot.example.com"),
      mainDomain: String(body.mainDomain || cfg.frpc?.serverAddr || "example.com"),
      pathMode: body.pathMode === "subpath" ? "subpath" : "subdomain",
      subpath: String(body.subpath || "/twinklebot"),
      remotePort: Number(body.remotePort || cfg.frpc?.remotePort || 13230),
      wsPath: String(body.wsPath || cfg.frpc?.wsPath || "/~!frp"),
      frpAuthToken: String(body.frpAuthToken || cfg.frpc?.authToken || "<FRP_AUTH_TOKEN>"),
      caddyStaticToken: body.includeCaddyToken ? cfg.accessToken : "",
    });
    return sendJson(res, 200, { ok: true, ...templates });
  }

  // Shared Account Directory API (strictly manual-switch-only; no switch endpoint!)
  const dirActions = ctx.accountDirectoryActions;
  if (pathname === "/api/accounts" && method === "GET") {
    if (!dirActions) return sendJson(res, 200, { ok: true, accounts: [] });
    const wantSync = url.searchParams.get("sync") === "1" && !isRelayIngressRequest(req);
    return sendJson(res, 200, {
      ok: true,
      accounts: dirActions.list({ includeSecrets: wantSync }),
    });
  }

  if (pathname === "/api/accounts" && method === "POST") {
    if (!dirActions) return sendJson(res, 503, { error: "account directory unavailable" });
    let body: Record<string, any> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    const result = await dirActions.upsert(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  const accDeleteMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accDeleteMatch && method === "DELETE") {
    if (!dirActions) return sendJson(res, 503, { error: "account directory unavailable" });
    const targetId = decodeURIComponent(accDeleteMatch[1]);
    const result = dirActions.remove(targetId);
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  return false;
}
