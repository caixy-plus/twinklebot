import type {
  ImageGenerationResult,
  ModelAdapter,
  ModelTurnResult,
  ProviderEntry,
} from "../shared/config.js";
import {
  isModelUnavailableError,
  isPermanentModelError,
  markModelUnavailable,
} from "./router.js";
import {
  createDriverForProvider,
  isGeminiUsingGcpVertex,
  isProviderUsable,
  normalizeProvidersConfig,
  resolveProviderApiKey,
} from "./providers/registry.js";
import type { GeminiVertexRuntime } from "../lib/gcp-env.js";
import {
  createGeminiDriver,
  inferImageMimeType,
} from "./providers/gemini-driver.js";

export { inferImageMimeType };

export function splitProviderModelRef(modelRef = ""): { providerId: string; model: string } {
  const raw = String(modelRef || "").trim();
  const sep = raw.indexOf("::");
  if (sep !== -1) {
    return {
      providerId: raw.slice(0, sep).trim(),
      model: raw.slice(sep + 2).trim(),
    };
  }
  return { providerId: "", model: raw };
}

export function userStep(text: string, png?: unknown): { type: "user_input"; content: any[] } {
  const content: any[] = [{ type: "text", text }];
  const images = Array.isArray(png) ? png : png != null ? [png] : [];
  for (const item of images) {
    if (item == null) continue;
    const isDescriptor =
      typeof item === "object" && !Buffer.isBuffer(item);
    const rawData = isDescriptor ? (item as any).data : item;
    if (rawData == null) continue;
    const data = Buffer.isBuffer(rawData)
      ? rawData.toString("base64")
      : String(rawData);
    if (!data) continue;
    const explicitMime = isDescriptor
      ? (item as any).mimeType || (item as any).mime_type || ""
      : "";
    content.push({
      type: "image",
      data,
      mime_type: inferImageMimeType(data, explicitMime),
    });
  }
  return {
    type: "user_input",
    content,
  };
}

function cleanTerminalStream(str: string, maxChars = 3500): string {
  if (typeof str !== "string" || str.length <= 200) return str;
  // Collapse carriage-return (\r) progress-bar spam by keeping the last segment per line
  const cleaned = str
    .split("\n")
    .map((line) => (line.includes("\r") ? line.split("\r").filter(Boolean).pop() || "" : line))
    .join("\n");
  if (cleaned.length <= maxChars) return cleaned;
  const half = Math.floor(maxChars / 2);
  return `${cleaned.slice(0, half)}\n...[truncated ${cleaned.length - maxChars} chars]...\n${cleaned.slice(-half)}`;
}

function compactResultForModel(result: unknown): string {
  if (typeof result === "string") {
    return cleanTerminalStream(result, 4000);
  }
  if (!result || typeof result !== "object") {
    return JSON.stringify(result ?? {});
  }
  const copy: Record<string, any> = { ...(result as Record<string, any>) };
  if (typeof copy.stdout === "string" && copy.stdout.length > 200) {
    copy.stdout = cleanTerminalStream(copy.stdout, 3000);
  }
  if (typeof copy.stderr === "string" && copy.stderr.length > 200) {
    copy.stderr = cleanTerminalStream(copy.stderr, 1500);
  }
  if (typeof copy.content === "string" && copy.content.length > 6000) {
    copy.content = cleanTerminalStream(copy.content, 6000);
  }
  return JSON.stringify(copy);
}

export function toolResultSteps(
  call: { id?: string; name?: string },
  result: unknown,
  png?: unknown
): any[] {
  const firstStep = {
    type: "function_result",
    call_id: call.id,
    name: call.name,
    result: compactResultForModel(result),
  };
  if (png != null) {
    return [firstStep, userStep("Current screen:", png)];
  }
  return [firstStep];
}

export interface CreateModelOptions {
  apiKey?: string;
  geminiVertexRuntime?: GeminiVertexRuntime | null;
  getGeminiVertexRuntime?: () => GeminiVertexRuntime | null | undefined;
  client?: any;
  providers?: ProviderEntry[];
  getProviders?: () => ProviderEntry[];
  getRouting?: () => Record<string, any> | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createModel({
  apiKey,
  geminiVertexRuntime,
  getGeminiVertexRuntime,
  client,
  providers = [],
  getProviders,
  getRouting,
  fetchImpl,
  timeoutMs = 15000,
}: CreateModelOptions = {}): ModelAdapter {
  const driverCache = new Map<string, any>();
  let defaultGeminiDriver: any = null;

  function activeVertexRuntime(): GeminiVertexRuntime | null | undefined {
    return typeof getGeminiVertexRuntime === "function"
      ? getGeminiVertexRuntime()
      : geminiVertexRuntime;
  }

  function resolveProvidersList(): ProviderEntry[] {
    const raw = typeof getProviders === "function" ? getProviders() : providers;
    return normalizeProvidersConfig(raw, {
      geminiApiKey: apiKey || "",
      geminiVertexRuntime: activeVertexRuntime(),
    });
  }

  function hasExplicitConfiguredProviders(): boolean {
    const raw = typeof getProviders === "function" ? getProviders() : providers;
    return Array.isArray(raw) && raw.length > 0;
  }

  function getGeminiFallbackDriver(): {
    driver: any;
    isVertex: boolean;
    providerId?: string;
  } | null {
    if (client) {
      if (!defaultGeminiDriver) {
        defaultGeminiDriver = createGeminiDriver({ client, timeoutMs });
      }
      return { driver: defaultGeminiDriver, isVertex: false };
    }
    const vRuntime = activeVertexRuntime();
    const hasExplicitProviders = hasExplicitConfiguredProviders();
    const list = resolveProvidersList();
    const gemProvider = list.find(
      (p) =>
        p.enabled !== false &&
        p.type === "gemini" &&
        isProviderUsable(p, process.env, vRuntime)
    );
    if (gemProvider) {
      return {
        driver: getDriverForProvider(gemProvider),
        isVertex: isGeminiUsingGcpVertex(gemProvider, process.env, vRuntime),
        providerId: gemProvider.id,
      };
    }
    // Once providers are explicitly configured in settings, never silently fall back to env keys.
    if (hasExplicitProviders) {
      return null;
    }
    if (vRuntime?.vertexActive) {
      if (!defaultGeminiDriver) {
        defaultGeminiDriver = createGeminiDriver({
          vertexai: true,
          project: vRuntime.project,
          location: vRuntime.location,
          timeoutMs,
        });
      }
      return { driver: defaultGeminiDriver, isVertex: true, providerId: "gemini" };
    }
    if (apiKey) {
      if (!defaultGeminiDriver) {
        defaultGeminiDriver = createGeminiDriver({ vertexai: false, apiKey, timeoutMs });
      }
      return { driver: defaultGeminiDriver, isVertex: false, providerId: "gemini" };
    }
    return null;
  }

  function getDriverForProvider(provider: ProviderEntry) {
    const vRuntime = activeVertexRuntime();
    const resolvedKey = resolveProviderApiKey(provider.apiKey);
    const vFlag = isGeminiUsingGcpVertex(provider, process.env, vRuntime)
      ? `gcp-vertex:${vRuntime?.project}:${vRuntime?.location}`
      : "std";
    const cacheKey = `${provider.id}:${provider.type}:${provider.baseUrl}:${vFlag}:${resolvedKey}`;
    if (driverCache.has(cacheKey)) {
      return driverCache.get(cacheKey);
    }
    const driver = createDriverForProvider(provider, {
      geminiVertexRuntime: vRuntime,
      client: provider.type === "gemini" ? client : undefined,
      fetchImpl,
      timeoutMs,
    });
    driverCache.set(cacheKey, driver);
    return driver;
  }

  function resolveTargetDriver(modelRef: string): {
    provider: ProviderEntry | null;
    model: string;
    driver: any;
  } {
    const { providerId, model } = splitProviderModelRef(modelRef);
    const list = resolveProvidersList();
    if (providerId) {
      const matched = list.find((p) => p.id === providerId && p.enabled !== false);
      if (!matched) {
        throw new Error(`Provider not found or disabled: ${providerId}`);
      }
      return {
        provider: matched,
        model,
        driver: getDriverForProvider(matched),
      };
    }

    if (!client) {
      const byModel = list.find(
        (p) => p.enabled !== false && Array.isArray(p.models) && p.models.includes(model)
      );
      if (byModel) {
        return {
          provider: byModel,
          model,
          driver: getDriverForProvider(byModel),
        };
      }
      const firstEnabled = list.find((p) =>
        isProviderUsable(p, process.env, activeVertexRuntime())
      );
      if (firstEnabled && (hasExplicitConfiguredProviders() || !apiKey)) {
        return {
          provider: firstEnabled,
          model: model || firstEnabled.models[0],
          driver: getDriverForProvider(firstEnabled),
        };
      }
    }

    const gemEntry = getGeminiFallbackDriver();
    if (!gemEntry?.driver) {
      throw new Error("尚未配置可用的大模型 API Key，请先在设置或引导页完成配置。");
    }
    return { provider: null, model, driver: gemEntry.driver };
  }

  const api: ModelAdapter = {
    async planTurn({
      model,
      fallbackModel,
      thinkingLevel = "high",
      timeoutMs: planTimeoutMs = 12000,
      systemInstruction,
      input,
      signal,
    }: Record<string, any>): Promise<ModelTurnResult> {
      return api.nextTurn({
        model,
        fallbackModel,
        thinkingLevel,
        timeoutMs: planTimeoutMs,
        systemInstruction,
        tools: undefined,
        input,
        signal,
      });
    },

    async summarizeTurn({
      model = "gemini-4-hydrogen",
      fallbackModel = "gemini-4-argon",
      thinkingLevel = "low",
      timeoutMs: summaryTimeoutMs = 8000,
      systemInstruction,
      input,
      signal,
    }: Record<string, any>): Promise<ModelTurnResult> {
      return api.nextTurn({
        model,
        fallbackModel,
        thinkingLevel,
        timeoutMs: summaryTimeoutMs,
        systemInstruction,
        tools: undefined,
        input,
        signal,
      });
    },

    async nextTurn({
      model,
      fallbackModel,
      thinkingLevel = "low",
      timeoutMs: callTimeoutMs,
      systemInstruction,
      tools,
      input,
      signal,
    }: Record<string, any>): Promise<ModelTurnResult> {
      const primary = resolveTargetDriver(model);
      const hasDistinctFallback = Boolean(fallbackModel && fallbackModel !== model);
      const fallbackTarget = hasDistinctFallback ? splitProviderModelRef(fallbackModel) : null;
      const sameProviderFallback =
        fallbackTarget &&
        ((!primary.provider && !fallbackTarget.providerId) ||
          (primary.provider && fallbackTarget.providerId === primary.provider.id))
          ? fallbackTarget.model
          : undefined;

      try {
        const res = await primary.driver.nextTurn({
          model: primary.model,
          fallbackModel: sameProviderFallback,
          thinkingLevel,
          timeoutMs: callTimeoutMs,
          systemInstruction,
          tools,
          input,
          signal,
        });
        if (res && !res.usedProviderId && primary.provider?.id) {
          res.usedProviderId = primary.provider.id;
        }
        return res;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (hasDistinctFallback && !sameProviderFallback && isModelUnavailableError(err)) {
          markModelUnavailable(model, {
            permanent: isPermanentModelError(err),
          });
          const fb = resolveTargetDriver(fallbackModel);
          const fbRes = await fb.driver.nextTurn({
            model: fb.model,
            thinkingLevel,
            timeoutMs: callTimeoutMs,
            systemInstruction,
            tools,
            input,
            signal,
          });
          if (fbRes && !fbRes.usedProviderId && fb.provider?.id) {
            fbRes.usedProviderId = fb.provider.id;
          }
          return fbRes;
        }
        throw err;
      }
    },

    async generateImage(opts: Record<string, any> = {}): Promise<ImageGenerationResult> {
      const configuredImage =
        typeof getRouting === "function" ? getRouting()?.tiers?.image : null;
      const explicitRef =
        opts.model && String(opts.model).includes("::")
          ? String(opts.model)
          : configuredImage?.providerId && configuredImage?.model
            ? `${configuredImage.providerId}::${configuredImage.model}`
            : "";

      if (explicitRef) {
        const resolved = resolveTargetDriver(explicitRef);
        if (resolved.driver && typeof resolved.driver.generateImage === "function") {
          const imgRes = await resolved.driver.generateImage({
            ...opts,
            model: resolved.model,
            fallbackModel:
              opts.fallbackModel && !String(opts.fallbackModel).includes("::")
                ? opts.fallbackModel
                : undefined,
          });
          if (imgRes && !imgRes.usedProviderId && resolved.provider?.id) {
            imgRes.usedProviderId = resolved.provider.id;
          }
          return imgRes;
        }
      }

      if (!client) {
        throw new Error("当前未配置可用的生图模型，请在「设置 → 模型接入与路由 → 生图模型」中配置生图模型。");
      }

      const gemEntry = getGeminiFallbackDriver();
      if (!gemEntry?.driver || typeof gemEntry.driver.generateImage !== "function") {
        throw new Error("当前未配置可用的生图模型，请在「设置 → 模型接入与路由 → 生图模型」中配置生图模型。");
      }
      try {
        const imgRes = await gemEntry.driver.generateImage(opts);
        if (imgRes && !imgRes.usedProviderId && gemEntry.providerId) {
          imgRes.usedProviderId = gemEntry.providerId;
        }
        return imgRes;
      } catch (err: any) {
        if (
          gemEntry.isVertex &&
          /not supported by the Interactions API/i.test(String(err?.message || ""))
        ) {
          throw new Error(
            "Vertex AI 的 Interactions API 暂不支持 Nano Banana 生图模型；请在「模型接入与路由」额外添加一个 Google Gemini (AI Studio) API Key 用于生图（对话仍可继续走 Vertex 无密钥）。"
          );
        }
        throw err;
      }
    },
  };
  return api;
}
