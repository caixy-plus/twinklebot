import crypto from "node:crypto";
import type {
  BillingCurrency,
  ProviderEntry,
  ProviderType,
  RoutingSettings,
  RoutingTierRef,
  SanitizedProvider,
} from "../../shared/config.js";
import type { GeminiVertexRuntime } from "../../lib/gcp-env.js";
import { createGeminiDriver } from "./gemini-driver.js";
import { createOpenAiCompatDriver } from "./openai-compat-driver.js";

export const PROVIDER_TYPES: ProviderType[] = [
  "gemini",
  "openai",
  "deepseek",
  "openai-compatible",
];

interface ProviderPreset {
  type: ProviderType;
  name: string;
  baseUrl: string;
  billingCurrency: BillingCurrency;
  models: string[];
  imageModels: string[];
}

export const DEFAULT_PROVIDER_PRESETS: Record<string, ProviderPreset> = Object.freeze({
  gemini: Object.freeze({
    type: "gemini",
    name: "Google Gemini",
    baseUrl: "",
    billingCurrency: "USD",
    models: ["gemini-4-hydrogen", "gemini-4-argon", "gemini-4-carbon"],
    imageModels: [
      "gemini-3.1-flash-image",
      "gemini-3-pro-image",
      "gemini-2.5-flash-image",
    ],
  }),
  openai: Object.freeze({
    type: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    billingCurrency: "USD",
    models: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
    imageModels: [],
  }),
  deepseek: Object.freeze({
    type: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    billingCurrency: "CNY",
    models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    imageModels: [],
  }),
  "openai-compatible": Object.freeze({
    type: "openai-compatible",
    name: "自定义 OpenAI 兼容",
    baseUrl: "",
    billingCurrency: "USD",
    models: [],
    imageModels: [],
  }),
});

export function defaultBillingCurrencyForType(type: ProviderType): BillingCurrency {
  return type === "deepseek" ? "CNY" : "USD";
}

export function normalizeBillingCurrency(
  raw: unknown,
  providerType: ProviderType = "openai-compatible"
): BillingCurrency {
  const s = String(raw || "").trim().toUpperCase();
  if (s === "CNY" || s === "RMB") return "CNY";
  if (s === "USD") return "USD";
  return defaultBillingCurrencyForType(providerType);
}

export function normalizeProviderEntry(raw: Record<string, any> = {}): ProviderEntry {
  const src = raw && typeof raw === "object" ? raw : {};
  const rawTypeStr = String(src.type || "").trim().toLowerCase();
  // Seamlessly migrate legacy standalone "vertex" entries into unified "gemini"
  const migratedTypeStr = rawTypeStr === "vertex" ? "gemini" : rawTypeStr;
  const type: ProviderType = PROVIDER_TYPES.includes(migratedTypeStr as ProviderType)
    ? (migratedTypeStr as ProviderType)
    : "openai-compatible";
  const preset = DEFAULT_PROVIDER_PRESETS[type];
  const id =
    typeof src.id === "string" && src.id.trim()
      ? src.id.trim()
      : `${type}-${crypto.randomUUID().slice(0, 8)}`;
  const modelsRaw = Array.isArray(src.models)
    ? src.models
    : typeof src.models === "string"
      ? src.models.split(/[\n,]/)
      : preset.models;
  const models = [
    ...new Set(modelsRaw.map((m) => String(m || "").trim()).filter(Boolean)),
  ];
  const imageModelsRaw = Array.isArray(src.imageModels)
    ? src.imageModels
    : typeof src.imageModels === "string"
      ? src.imageModels.split(/[\n,]/)
      : preset.imageModels || [];
  const imageModels = [
    ...new Set(imageModelsRaw.map((m) => String(m || "").trim()).filter(Boolean)),
  ];

  const rawName = String(src.name || "").trim();
  const effectiveName =
    rawTypeStr === "vertex" && (!rawName || /vertex/i.test(rawName))
      ? preset.name
      : rawName || preset.name;

  return {
    id,
    type,
    name: effectiveName.slice(0, 48) || preset.name,
    apiKey: String(src.apiKey || "").trim(),
    baseUrl: String(src.baseUrl ?? preset.baseUrl).trim().replace(/\/+$/, ""),
    models,
    imageModels,
    billingCurrency: normalizeBillingCurrency(src.billingCurrency, type),
    enabled: src.enabled !== false,
  };
}

export function parseApiKeyEnvRef(rawValue = ""): string | null {
  const s = String(rawValue || "").trim();
  if (!s) return null;
  if (s.startsWith("env:") || s.startsWith("$")) {
    const explicitMatch = s.match(/^(?:env:|\$\{?)([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    return explicitMatch ? explicitMatch[1] : null;
  }
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(s)) {
    return s;
  }
  return null;
}

export function resolveProviderApiKey(
  rawValue = "",
  env: Record<string, string | undefined> = process.env
): string {
  const s = String(rawValue || "").trim();
  if (!s) return "";
  const envName = parseApiKeyEnvRef(s);
  if (envName) {
    return String(env?.[envName] || "").trim();
  }
  return s;
}

export function isGeminiUsingGcpVertex(
  provider: ProviderEntry | null | undefined,
  env: Record<string, string | undefined> = process.env,
  geminiVertexRuntime?: GeminiVertexRuntime | null
): boolean {
  if (!provider || provider.type !== "gemini") return false;
  if (!geminiVertexRuntime?.vertexActive) return false;
  const resolvedKey = resolveProviderApiKey(provider.apiKey, env);
  return !resolvedKey;
}

export function isProviderUsable(
  provider: ProviderEntry | null | undefined,
  env: Record<string, string | undefined> = process.env,
  geminiVertexRuntime?: GeminiVertexRuntime | null
): boolean {
  if (!provider || provider.enabled === false) return false;
  const hasModels = Array.isArray(provider.models) && provider.models.length > 0;
  const hasImageModels =
    Array.isArray(provider.imageModels) && provider.imageModels.length > 0;
  if (!hasModels && !hasImageModels) return false;
  if (isGeminiUsingGcpVertex(provider, env, geminiVertexRuntime)) {
    return true;
  }
  const resolvedKey = resolveProviderApiKey(provider.apiKey, env);
  if (provider.type === "openai-compatible") {
    return Boolean(resolvedKey || provider.baseUrl);
  }
  return Boolean(resolvedKey);
}

export interface FallbackEnvOptions {
  geminiApiKey?: string;
  geminiVertexRuntime?: GeminiVertexRuntime | null;
}

export function normalizeProvidersConfig(
  rawProviders: unknown,
  fallbackEnv: string | FallbackEnvOptions = ""
): ProviderEntry[] {
  const list = Array.isArray(rawProviders)
    ? rawProviders.map((p) => normalizeProviderEntry(p))
    : [];
  const envOpts: FallbackEnvOptions =
    typeof fallbackEnv === "string"
      ? { geminiApiKey: fallbackEnv }
      : fallbackEnv && typeof fallbackEnv === "object"
        ? fallbackEnv
        : {};
  if (list.length === 0) {
    if (envOpts.geminiVertexRuntime?.vertexActive) {
      return [
        normalizeProviderEntry({
          id: "gemini-default",
          type: "gemini",
          name: "Google Gemini",
          apiKey: "",
          models: DEFAULT_PROVIDER_PRESETS.gemini.models,
          imageModels: [],
          enabled: true,
        }),
      ];
    }
    if (envOpts.geminiApiKey) {
      return [
        normalizeProviderEntry({
          id: "gemini-default",
          type: "gemini",
          name: "Google Gemini",
          apiKey: envOpts.geminiApiKey,
          models: DEFAULT_PROVIDER_PRESETS.gemini.models,
          enabled: true,
        }),
      ];
    }
  }
  return list;
}

export function maskSecretTail(secret = ""): string {
  const s = String(secret || "").trim();
  if (!s) return "";
  if (s.length <= 4) return "••••";
  return `••••${s.slice(-4)}`;
}

export function sanitizeProvidersForClient(
  providers: ProviderEntry[] = [],
  env: Record<string, string | undefined> = process.env,
  geminiVertexRuntime?: GeminiVertexRuntime | null
): SanitizedProvider[] {
  return (Array.isArray(providers) ? providers : []).map((p) => {
    const clean: any = { ...p };
    const key = clean.apiKey || "";
    delete clean.apiKey;
    const envName = parseApiKeyEnvRef(key);
    const resolvedKey = resolveProviderApiKey(key, env);
    const gcpVertex = isGeminiUsingGcpVertex(p, env, geminiVertexRuntime);
    return {
      ...clean,
      hasApiKey: Boolean(resolvedKey),
      apiKeySource: envName ? "env" : key ? "literal" : "",
      ...(envName ? { apiKeyEnvName: envName } : {}),
      ...(p.type === "gemini"
        ? {
            authMode: gcpVertex ? ("gcp-vertex" as const) : ("ai-studio" as const),
            ...(gcpVertex && geminiVertexRuntime
              ? {
                  gcpVertexLabel: `GCP Vertex AI · ${geminiVertexRuntime.project} (${geminiVertexRuntime.location})`,
                }
              : {}),
          }
        : {}),
      maskedApiKey: gcpVertex
        ? "GCP 服务账号 (ADC)"
        : envName
          ? resolvedKey
            ? `ENV:${envName} (${maskSecretTail(resolvedKey)})`
            : `ENV:${envName} (未设置)`
          : maskSecretTail(resolvedKey),
    };
  });
}

export interface CreateDriverOptions {
  env?: Record<string, string | undefined>;
  geminiVertexRuntime?: GeminiVertexRuntime | null;
  client?: any;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createDriverForProvider(
  provider: ProviderEntry,
  opts: CreateDriverOptions = {}
) {
  if (!provider) {
    throw new Error("Provider configuration is required");
  }
  const resolvedApiKey = resolveProviderApiKey(provider.apiKey, opts.env);
  if (provider.type === "gemini") {
    if (isGeminiUsingGcpVertex(provider, opts.env, opts.geminiVertexRuntime)) {
      return createGeminiDriver({
        vertexai: true,
        project: opts.geminiVertexRuntime!.project,
        location: opts.geminiVertexRuntime!.location,
        baseUrl: provider.baseUrl || undefined,
        client: opts.client,
        timeoutMs: opts.timeoutMs,
      });
    }
    return createGeminiDriver({
      vertexai: false,
      apiKey: resolvedApiKey,
      baseUrl: provider.baseUrl || undefined,
      client: opts.client,
      timeoutMs: opts.timeoutMs,
    });
  }
  return createOpenAiCompatDriver({
    apiKey: resolvedApiKey,
    baseUrl: provider.baseUrl || DEFAULT_PROVIDER_PRESETS[provider.type]?.baseUrl,
    providerType: provider.type,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export interface TestProviderConnectionResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  error?: string;
}

export async function testProviderConnection(
  rawProvider: Record<string, any> = {},
  opts: CreateDriverOptions = {}
): Promise<TestProviderConnectionResult> {
  if (String(rawProvider.type || "").trim().toLowerCase() === "vertex") {
    return {
      ok: false,
      latencyMs: 0,
      error:
        "独立 Vertex AI 供应商已合并至 Google Gemini；仅在 GCP 云服务器部署且设置 GOOGLE_GENAI_USE_VERTEXAI=true 时自动启用，本地与非 GCP 环境请使用 Google Gemini (GEMINI_API_KEY)",
    };
  }
  const provider = normalizeProviderEntry(rawProvider);
  const envName = parseApiKeyEnvRef(provider.apiKey);
  const resolvedApiKey = resolveProviderApiKey(provider.apiKey, opts.env);
  if (envName && !resolvedApiKey) {
    return {
      ok: false,
      latencyMs: 0,
      error: `环境变量 ${envName} 未设置或为空`,
    };
  }
  const gcpVertex = isGeminiUsingGcpVertex(
    provider,
    opts.env,
    opts.geminiVertexRuntime
  );
  if (!resolvedApiKey && !gcpVertex && provider.type !== "openai-compatible") {
    if (provider.type === "gemini" && opts.geminiVertexRuntime?.blockedReason) {
      return {
        ok: false,
        latencyMs: 0,
        error: opts.geminiVertexRuntime.blockedReason,
      };
    }
    return { ok: false, latencyMs: 0, error: "API Key 不能为空" };
  }
  if (provider.type === "openai-compatible" && !provider.baseUrl) {
    return { ok: false, latencyMs: 0, error: "自定义兼容接口必须填写 Base URL" };
  }
  const targetModel =
    String(rawProvider.model || "").trim() ||
    provider.models[0] ||
    DEFAULT_PROVIDER_PRESETS[provider.type]?.models?.[0] ||
    "";
  if (!targetModel) {
    return { ok: false, latencyMs: 0, error: "请至少填写一个模型名称用于连通性测试" };
  }

  const startedAt = Date.now();
  try {
    const driver = createDriverForProvider(provider, opts);
    const turn = await driver.nextTurn({
      model: targetModel,
      thinkingLevel: "low",
      timeoutMs: opts.timeoutMs || 15_000,
      systemInstruction: "Reply with OK.",
      input: [{ type: "user_input", content: [{ type: "text", text: "ping" }] }],
    });
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: turn?.usedModel || targetModel,
    };
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: targetModel,
      error: err?.message || "连接测试失败",
    };
  }
}

function pickTierCandidate(
  candidates: RoutingTierRef[],
  tierKey: "fast" | "medium" | "advanced"
): RoutingTierRef | null {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const patterns: Record<"fast" | "medium" | "advanced", RegExp[]> = {
    fast: [/hydrogen/i, /flash/i, /mini/i, /nano/i, /lite/i, /haiku/i, /fast/i],
    medium: [/argon/i, /chat/i, /sonnet/i, /gpt-4o(?!-mini)/i, /pro(?!-image)/i],
    advanced: [/carbon/i, /reasoner/i, /\bo[134]-/i, /opus/i, /ultra/i, /thinking/i, /pro/i],
  };
  for (const re of patterns[tierKey] || []) {
    const hit = candidates.find((c) => re.test(c.model));
    if (hit) return hit;
  }
  if (tierKey === "fast") return candidates[0];
  if (tierKey === "advanced") return candidates[candidates.length - 1];
  return candidates[Math.min(1, candidates.length - 1)];
}

export function reconcileRoutingTiers(
  providers: ProviderEntry[] = [],
  rawRouting: Partial<RoutingSettings> | Record<string, any> = {},
  env: Record<string, string | undefined> = process.env,
  geminiVertexRuntime?: GeminiVertexRuntime | null
): { routing: RoutingSettings; autoAssigned: boolean } {
  const usable = (Array.isArray(providers) ? providers : []).filter((p) =>
    isProviderUsable(p, env, geminiVertexRuntime)
  );
  const candidates: RoutingTierRef[] = [];
  for (const p of usable) {
    for (const m of p.models || []) {
      if (m) candidates.push({ providerId: p.id, model: m });
    }
  }
  const baseRouting: Record<string, any> =
    rawRouting && typeof rawRouting === "object" && !Array.isArray(rawRouting)
      ? { ...rawRouting }
      : {};
  const prevTiers =
    baseRouting.tiers && typeof baseRouting.tiers === "object"
      ? baseRouting.tiers
      : {};
  const nextTiers: NonNullable<RoutingSettings["tiers"]> = {};
  let autoAssigned = false;

  if (candidates.length === 0) {
    return {
      routing: { ...baseRouting, tiers: {} } as RoutingSettings,
      autoAssigned: false,
    };
  }

  for (const tierKey of ["fast", "medium", "advanced"] as const) {
    const cur = prevTiers[tierKey];
    const stillValid =
      cur &&
      cur.providerId &&
      cur.model &&
      candidates.some(
        (c) => c.providerId === cur.providerId && c.model === cur.model
      );
    if (stillValid) {
      nextTiers[tierKey] = { providerId: cur.providerId, model: cur.model };
    } else {
      const picked = pickTierCandidate(candidates, tierKey);
      if (picked) {
        nextTiers[tierKey] = { ...picked };
        autoAssigned = true;
      }
    }
  }

  if (prevTiers.image?.providerId && prevTiers.image?.model) {
    const imgProviderOk = usable.some(
      (p) =>
        p.id === prevTiers.image.providerId &&
        ((p.imageModels || []).includes(prevTiers.image.model) ||
          (p.models || []).includes(prevTiers.image.model))
    );
    if (imgProviderOk) {
      nextTiers.image = {
        providerId: prevTiers.image.providerId,
        model: prevTiers.image.model,
      };
    }
  }

  return {
    routing: { ...baseRouting, tiers: nextTiers } as RoutingSettings,
    autoAssigned,
  };
}
