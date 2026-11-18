import crypto from "node:crypto";

export interface HostMeta {
  clientId: string;
  hostId: string;
  hostname: string;
  platform: string;
  arch: string;
  connectedAt: string;
}

interface PendingRpc {
  clientId: string;
  resolve: (value: { result: unknown; screenshot: unknown }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: (() => void) | null;
}

export function createHostBridge({
  wsServer,
  timeoutMs = 120_000,
}: {
  wsServer?: any;
  timeoutMs?: number;
} = {}) {
  const pending = new Map<string, PendingRpc>();
  const hostMetaByClientId = new Map<string, HostMeta>();
  let selectedHostId: string | null = null;

  function listConnectedHosts(): HostMeta[] {
    const clients: any[] = wsServer?.getClients?.() || [];
    const activeIds = new Set(clients.map((c) => c.id));
    for (const key of [...hostMetaByClientId.keys()]) {
      if (!activeIds.has(key)) {
        hostMetaByClientId.delete(key);
      }
    }
    return [...hostMetaByClientId.values()];
  }

  function hasConnectedHost(clientId?: string): boolean {
    const hosts = listConnectedHosts();
    if (clientId) {
      return hosts.some((h) => h.clientId === clientId || h.hostId === clientId);
    }
    return hosts.length > 0;
  }

  function registerHostMeta(clientId: string, meta: Record<string, any> = {}): HostMeta | null {
    if (!clientId) return null;
    const entry: HostMeta = {
      clientId,
      hostId: String(meta.hostId || clientId).trim(),
      hostname: String(meta.hostname || "在线电脑").trim().slice(0, 64) || "在线电脑",
      platform: String(meta.platform || "").trim().slice(0, 32),
      arch: String(meta.arch || "").trim().slice(0, 32),
      connectedAt: meta.connectedAt || new Date().toISOString(),
    };
    hostMetaByClientId.set(clientId, entry);
    if (!selectedHostId || !hasConnectedHost(selectedHostId)) {
      selectedHostId = clientId;
    }
    return entry;
  }

  function getSelectedHostId(): string | null {
    const hosts = listConnectedHosts();
    if (selectedHostId && hosts.some((h) => h.clientId === selectedHostId)) {
      return selectedHostId;
    }
    selectedHostId = hosts.length > 0 ? hosts[hosts.length - 1].clientId : null;
    return selectedHostId;
  }

  function setSelectedHostId(clientId: string | null | undefined): string | null {
    if (!clientId) {
      selectedHostId = null;
      return null;
    }
    const hosts = listConnectedHosts();
    const match = hosts.find((h) => h.clientId === clientId || h.hostId === clientId);
    if (!match) {
      return null;
    }
    selectedHostId = match.clientId;
    return selectedHostId;
  }

  function getTargetClientId(): string | null {
    const hosts = listConnectedHosts();
    if (selectedHostId && hosts.some((h) => h.clientId === selectedHostId)) {
      return selectedHostId;
    }
    if (hosts.length > 0) {
      return hosts[hosts.length - 1].clientId;
    }
    return null;
  }

  function cleanupRpc(rpcId: string): PendingRpc | null {
    const entry = pending.get(rpcId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    pending.delete(rpcId);
    return entry;
  }

  function resolveRpc(rpcId: string, payload: Record<string, any> = {}): boolean {
    const entry = cleanupRpc(rpcId);
    if (!entry) return false;
    if (payload.ok === false && !payload.result) {
      entry.reject(new Error(payload.error || "host bridge execution failed"));
      return true;
    }
    entry.resolve({
      result:
        payload.result ?? {
          ok: Boolean(payload.ok),
          ...(payload.error ? { error: payload.error } : {}),
        },
      screenshot: payload.screenshot ?? null,
    });
    return true;
  }

  function rejectAllForClient(clientId?: string): void {
    if (clientId) {
      hostMetaByClientId.delete(clientId);
      if (selectedHostId === clientId) {
        selectedHostId = null;
      }
    } else {
      hostMetaByClientId.clear();
      selectedHostId = null;
    }
    for (const [rpcId, entry] of [...pending.entries()]) {
      if (!clientId || entry.clientId === clientId) {
        cleanupRpc(rpcId);
        entry.reject(new Error("host bridge client disconnected"));
      }
    }
  }

  function execute({
    name,
    args = {},
    callId = "",
    sessionId = "",
    approved = true,
    clientId,
    signal,
  }: {
    name?: string;
    args?: Record<string, unknown>;
    callId?: string;
    sessionId?: string;
    approved?: boolean;
    clientId?: string;
    signal?: AbortSignal;
  } = {}): Promise<{ result: unknown; screenshot: unknown }> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason || new Error("Aborted"));
    }
    const hosts = listConnectedHosts();
    let targetClientId: string | null = null;
    if (clientId) {
      const matched = hosts.find((h) => h.clientId === clientId || h.hostId === clientId);
      targetClientId = matched ? matched.clientId : null;
    } else {
      targetClientId = getTargetClientId();
    }
    if (!targetClientId) {
      return Promise.reject(new Error("当前没有在线的客户端主机（host_executor）连接"));
    }

    const rpcId = `rpc_${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanupRpc(rpcId);
        reject(new Error(`host bridge rpc timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const entry: PendingRpc = {
        clientId: targetClientId!,
        resolve,
        reject,
        timer,
        signal,
        onAbort: null,
      };
      if (signal) {
        entry.onAbort = () => {
          cleanupRpc(rpcId);
          reject(signal.reason || new Error("Aborted"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      pending.set(rpcId, entry);

      const sent = wsServer.sendToClient(targetClientId, {
        type: "host_rpc_request",
        rpcId,
        callId,
        sessionId,
        tool: name,
        args,
        approved,
      });
      if (!sent) {
        cleanupRpc(rpcId);
        reject(new Error("host bridge client disconnected"));
      }
    });
  }

  return {
    hasConnectedHost,
    registerHostMeta,
    listConnectedHosts,
    getSelectedHostId,
    setSelectedHostId,
    execute,
    resolveRpc,
    rejectAllForClient,
  };
}

export default { createHostBridge };
