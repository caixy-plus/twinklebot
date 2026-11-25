export const LOCAL_ACCOUNT_ID = "local";

export type AccountType = "local" | "cloud" | "lan";
export type AccountRoutePreference = "auto" | "lan" | "relay";

export interface AccountEntry {
  id: string;
  type: AccountType;
  name: string;
  baseUrl: string;
  wsUrl: string;
  authToken?: string;
  instanceId?: string;
  hostname?: string;
  platform?: string;
  nodeDeployEnv?: "local" | "cloud";
  relayUrl?: string;
  relayWsUrl?: string;
  relayToken?: string;
  preferredRoute?: AccountRoutePreference;
  createdAt: string;
}

export interface ParsedRelayInvite {
  relayUrl: string;
  relayToken: string;
  lanUrl?: string;
  instanceId?: string;
  hostname?: string;
  platform?: string;
  deployEnv?: "local" | "cloud";
  name?: string;
}

export interface AccountsState {
  activeAccountId: string;
  accounts: AccountEntry[];
}

export function normalizePreferredRoute(raw: unknown): AccountRoutePreference {
  const clean = String(raw || "").trim().toLowerCase();
  if (clean === "lan" || clean === "relay") return clean;
  return "auto";
}

function normalizeOptionalBaseUrl(rawUrl = ""): { valid: boolean; value: string } {
  const cleaned = String(rawUrl || "").trim();
  if (!cleaned) return { valid: true, value: "" };
  try {
    return { valid: true, value: normalizeBaseUrl(cleaned) };
  } catch {
    return { valid: false, value: "" };
  }
}

function encodeBase64UrlUtf8(text: string): string {
  const bytes = new TextEncoder().encode(String(text || ""));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64UrlUtf8(raw: string): string {
  const norm = String(raw || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (norm.length % 4)) % 4;
  const bin = atob(norm + "=".repeat(padLen));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function normalizeBaseUrl(rawUrl = ""): string {
  const cleaned = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  try {
    const u = new URL(cleaned);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("Only http:// or https:// URLs are supported");
    }
    return u.origin + (u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "");
  } catch (err: any) {
    throw new Error(`Invalid server URL: ${err?.message || rawUrl}`);
  }
}

export function buildWsUrlFromBase(baseUrl = ""): string {
  const clean = normalizeBaseUrl(baseUrl);
  if (!clean) return "";
  const u = new URL(clean);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/ws`;
  return u.toString();
}

export function normalizeAccountsState(raw: any, localBaseUrl = ""): AccountsState {
  const src = raw && typeof raw === "object" ? raw : {};
  const list: any[] = Array.isArray(src.accounts) ? src.accounts : [];
  const cleanLocalBase = localBaseUrl ? normalizeBaseUrl(localBaseUrl) : "";
  const existingLocal = list.find(
    (a) => a && (a.id === LOCAL_ACCOUNT_ID || a.type === "local")
  );
  const localAccount: AccountEntry = {
    id: LOCAL_ACCOUNT_ID,
    type: "local",
    name: String(existingLocal?.name || "本地账号").trim() || "本地账号",
    baseUrl: cleanLocalBase || existingLocal?.baseUrl || "",
    wsUrl: cleanLocalBase
      ? buildWsUrlFromBase(cleanLocalBase)
      : existingLocal?.wsUrl || "",
    createdAt: existingLocal?.createdAt || new Date().toISOString(),
  };

  const remoteAccounts: AccountEntry[] = [];
  const seenIds = new Set<string>([LOCAL_ACCOUNT_ID]);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (item.id === LOCAL_ACCOUNT_ID || item.type === "local") continue;
    const id = String(item.id || "").trim();
    if (!id || seenIds.has(id)) continue;
    const rawBase = String(item.baseUrl || "").trim();
    const rawRelay = String(item.relayUrl || "").trim();
    const baseParsed = normalizeOptionalBaseUrl(rawBase);
    const relayParsed = normalizeOptionalBaseUrl(rawRelay);
    if (!baseParsed.valid || !relayParsed.valid) continue;
    const normBase = baseParsed.value;
    const normRelay = relayParsed.value;
    const entryType: AccountType = item.type === "lan" ? "lan" : "cloud";
    if (!normBase && !(entryType === "lan" && normRelay)) continue;
    seenIds.add(id);
    const nodeDeployEnv: "local" | "cloud" =
      item.nodeDeployEnv === "local" || item.nodeDeployEnv === "cloud"
        ? item.nodeDeployEnv
        : entryType === "lan"
          ? "local"
          : "cloud";
    remoteAccounts.push({
      id,
      type: entryType,
      name: String(item.name || item.hostname || normBase || normRelay).trim().slice(0, 48) || normBase || normRelay,
      baseUrl: normBase,
      wsUrl: normBase ? buildWsUrlFromBase(normBase) : "",
      authToken: String(item.authToken || item.deviceToken || "").trim(),
      nodeDeployEnv,
      ...(normRelay
        ? {
            relayUrl: normRelay,
            relayWsUrl: buildWsUrlFromBase(normRelay),
            relayToken: String(item.relayToken || "").trim(),
            preferredRoute: normalizePreferredRoute(item.preferredRoute),
          }
        : {}),
      ...(item.instanceId ? { instanceId: String(item.instanceId).trim() } : {}),
      ...(item.hostname ? { hostname: String(item.hostname).trim() } : {}),
      ...(item.platform ? { platform: String(item.platform).trim() } : {}),
      createdAt: item.createdAt || new Date().toISOString(),
    });
  }

  const accounts = [localAccount, ...remoteAccounts];
  const requestedActive = String(src.activeAccountId || LOCAL_ACCOUNT_ID).trim();
  const activeAccountId = accounts.some((a) => a.id === requestedActive)
    ? requestedActive
    : LOCAL_ACCOUNT_ID;

  return {
    activeAccountId,
    accounts,
  };
}

export function upsertCloudAccount(state: any, input: Record<string, any> = {}): AccountsState {
  const current = normalizeAccountsState(state);
  if (String(input.type || "").trim().toLowerCase() === "local") {
    throw new Error("Only one local account is allowed");
  }
  const normBase = normalizeBaseUrl(input.baseUrl || input.serverUrl || "");
  if (!normBase) {
    throw new Error("Cloud server URL is required");
  }
  const rawId = String(input.id || "").trim();
  if (rawId === LOCAL_ACCOUNT_ID) {
    throw new Error("Only one local account is allowed");
  }
  const instanceId = String(input.instanceId || "").trim();
  const existing =
    (rawId ? current.accounts.find((a) => a.id === rawId) : null) ||
    (instanceId
      ? current.accounts.find((a) => a.type === "cloud" && a.instanceId === instanceId)
      : null) ||
    current.accounts.find((a) => a.type === "cloud" && a.baseUrl === normBase) ||
    null;
  const id =
    existing?.id ||
    rawId ||
    `cloud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const nextInstanceId = instanceId || existing?.instanceId || "";
  const nextHostname = String(input.hostname || existing?.hostname || "").trim();
  const nextPlatform = String(input.platform || existing?.platform || "").trim();
  const entry: AccountEntry = {
    id,
    type: "cloud",
    name: String(input.name || nextHostname || existing?.name || normBase).trim().slice(0, 48) || normBase,
    baseUrl: normBase,
    wsUrl: buildWsUrlFromBase(normBase),
    nodeDeployEnv:
      input.nodeDeployEnv === "local"
        ? "local"
        : input.nodeDeployEnv === "cloud"
          ? "cloud"
          : existing?.nodeDeployEnv || "cloud",
    authToken:
      input.authToken !== undefined
        ? String(input.authToken || "").trim()
        : existing?.authToken || "",
    ...(nextInstanceId ? { instanceId: nextInstanceId } : {}),
    ...(nextHostname ? { hostname: nextHostname } : {}),
    ...(nextPlatform ? { platform: nextPlatform } : {}),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  const nextAccounts = existing
    ? current.accounts.map((a) => (a.id === id ? entry : a))
    : [...current.accounts, entry];
  return {
    activeAccountId: current.activeAccountId,
    accounts: nextAccounts,
  };
}

export function upsertLanAccount(state: any, input: Record<string, any> = {}): AccountsState {
  const current = normalizeAccountsState(state);
  const normBase = normalizeBaseUrl(input.baseUrl || input.serverUrl || "");
  if (!normBase) {
    throw new Error("LAN server URL is required");
  }
  const rawId = String(input.id || "").trim();
  const instanceId = String(input.instanceId || "").trim();
  const existing =
    (rawId ? current.accounts.find((a) => a.id === rawId) : null) ||
    (instanceId
      ? current.accounts.find((a) => a.type === "lan" && a.instanceId === instanceId)
      : null);
  const id =
    existing?.id ||
    rawId ||
    `lan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const existingRelayUrl = String(existing?.relayUrl || "").trim();
  const nextRelayRaw =
    input.relayUrl !== undefined ? String(input.relayUrl || "").trim() : existingRelayUrl;
  const nextRelayUrl = nextRelayRaw ? normalizeBaseUrl(nextRelayRaw) : "";
  const entry: AccountEntry = {
    id,
    type: "lan",
    instanceId: instanceId || existing?.instanceId || "",
    hostname: String(input.hostname || existing?.hostname || "").trim(),
    platform: String(input.platform || existing?.platform || "").trim(),
    nodeDeployEnv: "local",
    name:
      String(input.name || input.hostname || existing?.name || normBase)
        .trim()
        .slice(0, 48) || normBase,
    baseUrl: normBase,
    wsUrl: buildWsUrlFromBase(normBase),
    authToken:
      input.deviceToken !== undefined || input.authToken !== undefined
        ? String(input.deviceToken ?? input.authToken ?? "").trim()
        : existing?.authToken || "",
    ...(nextRelayUrl
      ? {
          relayUrl: nextRelayUrl,
          relayWsUrl: buildWsUrlFromBase(nextRelayUrl),
          relayToken:
            input.relayToken !== undefined
              ? String(input.relayToken || "").trim()
              : existing?.relayToken || "",
          preferredRoute: normalizePreferredRoute(
            input.preferredRoute !== undefined ? input.preferredRoute : existing?.preferredRoute
          ),
        }
      : {}),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  const nextAccounts = existing
    ? current.accounts.map((a) => (a.id === id ? entry : a))
    : [...current.accounts, entry];
  return {
    activeAccountId: current.activeAccountId,
    accounts: nextAccounts,
  };
}

export function upsertRelayForLanAccount(state: any, input: Record<string, any> = {}): AccountsState {
  const current = normalizeAccountsState(state);
  const normRelay = normalizeBaseUrl(input.relayUrl || input.baseUrl || input.serverUrl || "");
  if (!normRelay) {
    throw new Error("Relay server URL is required");
  }
  const lanCandidate = String(input.lanUrl || input.lanBaseUrl || "").trim();
  const normLan = lanCandidate ? normalizeBaseUrl(lanCandidate) : "";
  const rawId = String(input.id || "").trim();
  const instanceId = String(input.instanceId || "").trim();
  const existing =
    (rawId ? current.accounts.find((a) => a.id === rawId && a.type === "lan") : null) ||
    (instanceId
      ? current.accounts.find((a) => a.type === "lan" && a.instanceId === instanceId)
      : null) ||
    current.accounts.find((a) => a.type === "lan" && a.relayUrl === normRelay) ||
    (normLan ? current.accounts.find((a) => a.type === "lan" && a.baseUrl === normLan) : null);

  const id =
    existing?.id ||
    rawId ||
    `lan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const effectiveLanBase = existing?.baseUrl || normLan;
  const entry: AccountEntry = {
    id,
    type: "lan",
    instanceId: instanceId || existing?.instanceId || "",
    hostname: String(input.hostname || existing?.hostname || "").trim(),
    platform: String(input.platform || existing?.platform || "").trim(),
    nodeDeployEnv: "local",
    name:
      String(input.name || existing?.name || input.hostname || normRelay)
        .trim()
        .slice(0, 48) || normRelay,
    baseUrl: effectiveLanBase,
    wsUrl: effectiveLanBase ? buildWsUrlFromBase(effectiveLanBase) : "",
    authToken:
      input.deviceToken !== undefined || input.authToken !== undefined
        ? String(input.deviceToken ?? input.authToken ?? "").trim()
        : existing?.authToken || "",
    relayUrl: normRelay,
    relayWsUrl: buildWsUrlFromBase(normRelay),
    relayToken:
      input.relayToken !== undefined
        ? String(input.relayToken || "").trim()
        : existing?.relayToken || "",
    preferredRoute: normalizePreferredRoute(
      input.preferredRoute !== undefined ? input.preferredRoute : existing?.preferredRoute
    ),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  const nextAccounts = existing
    ? current.accounts.map((a) => (a.id === id ? entry : a))
    : [...current.accounts, entry];
  return {
    activeAccountId: current.activeAccountId,
    accounts: nextAccounts,
  };
}

export function encodeRelayInviteUri(payload: Record<string, any> = {}): string {
  const relayUrl = normalizeBaseUrl(payload.relayUrl || payload.url || "");
  const cleanPayload: Record<string, any> = {
    v: 1,
    r: relayUrl,
    ...(payload.relayToken || payload.token
      ? { t: String(payload.relayToken || payload.token).trim() }
      : {}),
    ...(payload.instanceId ? { id: String(payload.instanceId).trim() } : {}),
    ...(payload.hostname ? { h: String(payload.hostname).trim() } : {}),
    ...(payload.platform ? { p: String(payload.platform).trim() } : {}),
    ...(payload.deployEnv || payload.nodeDeployEnv
      ? { e: String(payload.deployEnv || payload.nodeDeployEnv).trim() }
      : {}),
    ...(payload.lanUrl ? { l: String(payload.lanUrl).trim() } : {}),
    ...(payload.name ? { n: String(payload.name).trim() } : {}),
  };
  return `twinklebot://relay?data=${encodeBase64UrlUtf8(JSON.stringify(cleanPayload))}`;
}

export function parseRelayInvite(rawInput = ""): ParsedRelayInvite | null {
  const raw = String(rawInput || "").trim();
  if (!raw) return null;

  const fromObject = (obj: any): ParsedRelayInvite | null => {
    if (!obj || typeof obj !== "object") return null;
    const candidateUrl = String(obj.relayUrl || obj.r || obj.baseUrl || obj.url || "").trim();
    if (!candidateUrl) return null;
    try {
      const parsedUrl = new URL(candidateUrl);
      const tokenFromQuery = parsedUrl.searchParams.get("token") || "";
      parsedUrl.searchParams.delete("token");
      const cleanRelayUrl = normalizeBaseUrl(parsedUrl.toString());
      const relayToken = String(
        obj.relayToken || obj.t || obj.authToken || obj.token || tokenFromQuery || ""
      ).trim();
      const rawLan = String(obj.lanUrl || obj.l || obj.lanBaseUrl || "").trim();
      const lanParsed = normalizeOptionalBaseUrl(rawLan);
      const envRaw = String(obj.deployEnv || obj.nodeDeployEnv || obj.e || "").trim().toLowerCase();
      return {
        relayUrl: cleanRelayUrl,
        relayToken,
        ...(lanParsed.valid && lanParsed.value ? { lanUrl: lanParsed.value } : {}),
        ...(obj.instanceId || obj.id ? { instanceId: String(obj.instanceId || obj.id).trim() } : {}),
        ...(obj.hostname || obj.h ? { hostname: String(obj.hostname || obj.h).trim() } : {}),
        ...(obj.platform || obj.p ? { platform: String(obj.platform || obj.p).trim() } : {}),
        ...(envRaw === "local" || envRaw === "cloud" ? { deployEnv: envRaw } : {}),
        ...(obj.name || obj.n ? { name: String(obj.name || obj.n).trim() } : {}),
      };
    } catch {
      return null;
    }
  };

  if (raw.startsWith("{")) {
    try {
      return fromObject(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  if (/^twinklebot:\/\/relay/i.test(raw)) {
    try {
      const normalized = raw.replace(/^twinklebot:\/\//i, "https://");
      const u = new URL(normalized);
      const dataParam = u.searchParams.get("data");
      if (dataParam) {
        const decoded = JSON.parse(decodeBase64UrlUtf8(dataParam));
        return fromObject(decoded);
      }
      return fromObject({
        relayUrl: u.searchParams.get("url") || u.searchParams.get("relayUrl") || "",
        relayToken: u.searchParams.get("token") || u.searchParams.get("relayToken") || "",
        lanUrl: u.searchParams.get("lanUrl") || "",
        instanceId: u.searchParams.get("instanceId") || "",
        hostname: u.searchParams.get("hostname") || "",
        platform: u.searchParams.get("platform") || "",
        deployEnv: u.searchParams.get("deployEnv") || "",
        name: u.searchParams.get("name") || "",
      });
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const hashMatch = u.hash.match(/token=([^&]+)/i);
      const tok =
        u.searchParams.get("token") || (hashMatch ? decodeURIComponent(hashMatch[1]) : "") || "";
      u.searchParams.delete("token");
      u.hash = "";
      return {
        relayUrl: normalizeBaseUrl(u.toString()),
        relayToken: tok.trim(),
      };
    } catch {
      return null;
    }
  }

  return null;
}

export function removeCloudAccount(state: any, id: string): AccountsState {
  const targetId = String(id || "").trim();
  if (targetId === LOCAL_ACCOUNT_ID) {
    throw new Error("Local account cannot be deleted");
  }
  const current = normalizeAccountsState(state);
  const nextAccounts = current.accounts.filter((a) => a.id !== targetId);
  const nextActive =
    current.activeAccountId === targetId
      ? LOCAL_ACCOUNT_ID
      : current.activeAccountId;
  return {
    activeAccountId: nextActive,
    accounts: nextAccounts,
  };
}

export function setActiveAccount(state: any, id: string): AccountsState {
  const current = normalizeAccountsState(state);
  const targetId = String(id || "").trim();
  const found = current.accounts.find((a) => a.id === targetId);
  if (!found) {
    throw new Error(`Account not found: ${targetId}`);
  }
  return {
    ...current,
    activeAccountId: found.id,
  };
}

export interface ProbedNodeIdentity {
  ok: boolean;
  deployEnv: "local" | "cloud" | "";
  instanceId: string;
  hostname: string;
  platform: string;
  appVersion: string;
  latencyMs: number;
  status: number;
  error?: string;
}

export async function probeRemoteNodeIdentity(
  baseUrl: string,
  authToken = "",
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 4500,
  }: {
    fetchImpl?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {}
): Promise<ProbedNodeIdentity> {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const started = Date.now();
  const headers: Record<string, string> = {};
  if (authToken) {
    headers.Authorization = `Bearer ${String(authToken).trim()}`;
  }

  const pingAttempt = async (endpointPath: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeoutMs));
    try {
      const res = await fetchImpl(`${cleanBase}${endpointPath}`, {
        headers,
        signal: ctrl.signal,
      });
      const data: any = await res.json().catch(() => null);
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const { res, data } = await pingAttempt("/api/relay/ping");
    if (res.ok && data?.ok) {
      const env = data.deployEnv === "cloud" ? "cloud" : data.deployEnv === "local" ? "local" : "";
      return {
        ok: true,
        deployEnv: env,
        instanceId: String(data.instanceId || "").trim(),
        hostname: String(data.hostname || "").trim(),
        platform: String(data.platform || "").trim(),
        appVersion: String(data.appVersion || "").trim(),
        latencyMs: Math.max(1, Date.now() - started),
        status: res.status,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        deployEnv: "",
        instanceId: "",
        hostname: "",
        platform: "",
        appVersion: "",
        latencyMs: Math.max(1, Date.now() - started),
        status: res.status,
        error: "认证失败（Token 无效或缺失）",
      };
    }
    // Fallback to /api/system/health for older nodes lacking /api/relay/ping
    const health = await pingAttempt("/api/system/health");
    if (health.res.ok && health.data?.ok) {
      const env =
        health.data.deployEnv === "cloud"
          ? "cloud"
          : health.data.deployEnv === "local"
            ? "local"
            : "";
      return {
        ok: true,
        deployEnv: env,
        instanceId: String(health.data.instanceId || "").trim(),
        hostname: "",
        platform: "",
        appVersion: String(health.data.appVersion || "").trim(),
        latencyMs: Math.max(1, Date.now() - started),
        status: health.res.status,
      };
    }
    return {
      ok: false,
      deployEnv: "",
      instanceId: "",
      hostname: "",
      platform: "",
      appVersion: "",
      latencyMs: Math.max(1, Date.now() - started),
      status: health.res.status || res.status,
      error: health.data?.error || data?.error || `HTTP ${health.res.status || res.status}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      deployEnv: "",
      instanceId: "",
      hostname: "",
      platform: "",
      appVersion: "",
      latencyMs: Math.max(1, Date.now() - started),
      status: 0,
      error: err?.name === "AbortError" ? "请求超时" : err?.message || "连接失败",
    };
  }
}
