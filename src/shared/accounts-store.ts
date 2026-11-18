export const LOCAL_ACCOUNT_ID = "local";

export type AccountType = "local" | "cloud" | "lan";

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
  createdAt: string;
}

export interface AccountsState {
  activeAccountId: string;
  accounts: AccountEntry[];
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
    let normBase = "";
    try {
      normBase = normalizeBaseUrl(item.baseUrl || "");
    } catch {
      continue;
    }
    if (!normBase) continue;
    seenIds.add(id);
    const entryType: AccountType = item.type === "lan" ? "lan" : "cloud";
    remoteAccounts.push({
      id,
      type: entryType,
      name: String(item.name || item.hostname || normBase).trim().slice(0, 48) || normBase,
      baseUrl: normBase,
      wsUrl: buildWsUrlFromBase(normBase),
      authToken: String(item.authToken || item.deviceToken || "").trim(),
      ...(entryType === "lan"
        ? {
            instanceId: String(item.instanceId || "").trim(),
            hostname: String(item.hostname || "").trim(),
            platform: String(item.platform || "").trim(),
          }
        : {}),
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
  const existing = rawId ? current.accounts.find((a) => a.id === rawId) : null;
  const id =
    existing?.id ||
    rawId ||
    `cloud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const entry: AccountEntry = {
    id,
    type: "cloud",
    name: String(input.name || normBase).trim().slice(0, 48) || normBase,
    baseUrl: normBase,
    wsUrl: buildWsUrlFromBase(normBase),
    authToken:
      input.authToken !== undefined
        ? String(input.authToken || "").trim()
        : existing?.authToken || "",
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
  const entry: AccountEntry = {
    id,
    type: "lan",
    instanceId: instanceId || existing?.instanceId || "",
    hostname: String(input.hostname || existing?.hostname || "").trim(),
    platform: String(input.platform || existing?.platform || "").trim(),
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
