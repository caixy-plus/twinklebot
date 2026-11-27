import type { ExecutorClient } from "../shared/config.js";

export class ExecutorError extends Error {
  status: number;
  details?: Record<string, any>;

  constructor(message: string, status = 0, details?: Record<string, any>) {
    super(message);
    this.name = "ExecutorError";
    this.status = status;
    if (details && typeof details === "object") {
      this.details = details;
    }
  }
}

export interface CreateExecutorClientOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUnreachableWake?: () => Promise<boolean>;
}

export function createExecutorClient({
  url,
  token,
  fetchImpl = fetch,
  timeoutMs = 150000,
  onUnreachableWake,
}: CreateExecutorClientOptions): ExecutorClient {
  const baseUrl = url.replace(/\/+$/, "");
  let wakingInProgress = false;

  function buildSignal(externalSignal?: AbortSignal, customTimeoutMs?: number): AbortSignal {
    const effectiveTimeout = customTimeoutMs && customTimeoutMs > 0 ? customTimeoutMs : timeoutMs;
    const timeoutSig = AbortSignal.timeout(effectiveTimeout);
    if (externalSignal && typeof AbortSignal.any === "function") {
      return AbortSignal.any([timeoutSig, externalSignal]);
    }
    return externalSignal || timeoutSig;
  }

  async function request<T = any>(
    method: "GET" | "POST",
    route: string,
    body?: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      headers?: Record<string, string>;
      skipWake?: boolean;
    } = {}
  ): Promise<T> {
    const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
    const targetUrl = `${baseUrl}${normalizedRoute}`;

    const headers: Record<string, string> = {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    };

    let serializedBody: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(body ?? {});
    }

    let res: Response | null = null;
    const tryWakeAndRefetch = async (): Promise<Response | null> => {
      if (
        !onUnreachableWake ||
        options.skipWake ||
        wakingInProgress ||
        options.signal?.aborted
      ) {
        return null;
      }
      let woke = false;
      wakingInProgress = true;
      try {
        woke = Boolean(await onUnreachableWake());
      } catch {
        return null;
      } finally {
        wakingInProgress = false;
      }
      if (!woke || options.signal?.aborted) return null;
      try {
        return await fetchImpl(targetUrl, {
          method,
          headers,
          body: serializedBody,
          signal: buildSignal(options.signal, options.timeoutMs),
        });
      } catch (wakeFetchErr) {
        if (targetUrl.includes("//ubuntu.orb.local:")) {
          const fallbackUrl = targetUrl.replace("//ubuntu.orb.local:", "//127.0.0.1:");
          return fetchImpl(fallbackUrl, {
            method,
            headers,
            body: serializedBody,
            signal: buildSignal(options.signal, options.timeoutMs),
          });
        }
        throw wakeFetchErr;
      }
    };

    try {
      res = await fetchImpl(targetUrl, {
        method,
        headers,
        body: serializedBody,
        signal: buildSignal(options.signal, options.timeoutMs),
      });
    } catch (err: any) {
      if (options.signal?.aborted) {
        throw new ExecutorError("execution aborted", 0);
      }
      if (targetUrl.includes("//ubuntu.orb.local:")) {
        const fallbackUrl = targetUrl.replace("//ubuntu.orb.local:", "//127.0.0.1:");
        try {
          res = await fetchImpl(fallbackUrl, {
            method,
            headers,
            body: serializedBody,
            signal: buildSignal(options.signal, options.timeoutMs),
          });
        } catch {
          // Fall through to tryWakeAndRefetch() so sleeping OrbStack VMs auto-wake
        }
      }
      if (res === null) {
        try {
          const wokenRes = await tryWakeAndRefetch();
          if (wokenRes) {
            res = wokenRes;
          } else {
            throw new ExecutorError(`executor unreachable: ${err?.message || String(err)}`, 0);
          }
        } catch (retryErr: any) {
          if (retryErr instanceof ExecutorError) throw retryErr;
          throw new ExecutorError(
            `executor unreachable: ${retryErr?.message || err?.message || String(err)}`,
            0
          );
        }
      }
    }

    if (!res) {
      throw new ExecutorError("executor unreachable", 0);
    }

    if (!res.ok) {
      let errorMessage: string | undefined;
      let errorDetails: Record<string, any> | undefined;
      try {
        const data: any = await res.json();
        if (data && typeof data === "object") {
          errorDetails = data;
          if (typeof data.error === "string") {
            errorMessage = data.error;
          }
        }
      } catch {
        // Response was not JSON
      }
      if (!errorMessage) {
        errorMessage = res.statusText || `HTTP ${res.status}`;
      }
      throw new ExecutorError(errorMessage, res.status, errorDetails);
    }

    try {
      return (await res.json()) as T;
    } catch (err: any) {
      throw new ExecutorError(`executor unreachable: ${err?.message || String(err)}`, 0);
    }
  }

  return {
    async health(options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      headers?: Record<string, string>;
      skipWake?: boolean;
    }) {
      return request("GET", "/health", undefined, {
        timeoutMs: 3500,
        ...options,
        skipWake: options?.skipWake ?? true,
      });
    },
    async call<T = unknown>(
      route: string,
      body?: Record<string, unknown>,
      options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
        headers?: Record<string, string>;
        skipWake?: boolean;
      }
    ): Promise<T> {
      return request<T>("POST", route, body, options);
    },
  };
}

/**
 * Wraps an ExecutorClient so every tool call carries the Bot's identity headers
 * (`X-Twinkle-Bot-Id`, `X-Twinkle-Bot-Admin`, and optional `X-Twinkle-Bot-Workspace`),
 * routing execution to that Bot's dedicated display tab and workspace.
 */
export function createBotScopedExecutorClient(
  baseClient: ExecutorClient | null | undefined,
  {
    botId,
    isAdmin = false,
    botWorkspace = "",
    getMaxConcurrentScreens,
  }: {
    botId?: string | null;
    isAdmin?: boolean;
    botWorkspace?: string;
    getMaxConcurrentScreens?: () => number;
  } = {}
): ExecutorClient | null | undefined {
  if (!baseClient) return baseClient;
  const normalizedId = String(botId || "").trim();
  const normalizedWorkspace = String(botWorkspace || "").trim();
  if (!normalizedId && !isAdmin && !normalizedWorkspace && !getMaxConcurrentScreens) return baseClient;
  const scopeHeaders: Record<string, string> = {
    ...(normalizedId ? { "X-Twinkle-Bot-Id": normalizedId } : {}),
    "X-Twinkle-Bot-Admin": isAdmin ? "1" : "0",
    ...(normalizedWorkspace ? { "X-Twinkle-Bot-Workspace": normalizedWorkspace } : {}),
  };
  return {
    health: (opts) => baseClient.health(opts),
    call: (route, body, opts = {}) => {
      const dynMax = getMaxConcurrentScreens ? Number(getMaxConcurrentScreens()) : 0;
      const maxHeader =
        Number.isFinite(dynMax) && dynMax >= 1
          ? { "X-Twinkle-Max-Screens": String(Math.round(dynMax)) }
          : {};
      return baseClient.call(route, body, {
        ...opts,
        headers: {
          ...scopeHeaders,
          ...maxHeader,
          ...((opts?.headers as Record<string, string> | undefined) || {}),
        },
      });
    },
  };
}
