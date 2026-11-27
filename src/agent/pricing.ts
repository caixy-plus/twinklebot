/**
 * Model Token Pricing & Usage Aggregation for TwinkleBot.
 * Native rates follow each provider's billing currency (USD or CNY per 1M tokens)
 * and are converted uniformly to RMB (¥) via `USD_TO_CNY` for display & cross-provider totals.
 */
import type { BillingCurrency, ProviderEntry, TokenUsage } from "../shared/config.js";

export const USD_TO_CNY = 7.25;

export function toCny(amount: number, currency: BillingCurrency = "USD"): number {
  const n = Number(amount) || 0;
  return currency === "CNY" ? n : n * USD_TO_CNY;
}

export function toUsd(amount: number, currency: BillingCurrency = "USD"): number {
  const n = Number(amount) || 0;
  return currency === "CNY" ? n / USD_TO_CNY : n;
}

export function fromCny(amountCny: number, targetCurrency: BillingCurrency = "USD"): number {
  const n = Number(amountCny) || 0;
  return targetCurrency === "CNY" ? n : n / USD_TO_CNY;
}

export interface ModelPricingEntry {
  model: string;
  label: string;
  shortLabel: string;
  role: string;
  accent: string;
  currency?: BillingCurrency;
  supportsOffPeakDiscount?: boolean;
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
  standardInputPer1M: number;
  standardOutputPer1M: number;
}

export const MODEL_PRICING_CATALOG: Record<string, ModelPricingEntry> = {
  "gemini-4-neon": {
    model: "gemini-4-neon",
    label: "Gemini 4 Neon",
    shortLabel: "Neon",
    role: "旗舰推理",
    accent: "violet",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.1,
    outputPer1M: 10.0,
    standardInputPer1M: 4.0,
    standardOutputPer1M: 20.0,
  },
  "gemini-4-carbon": {
    model: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    shortLabel: "Carbon",
    role: "深度旗舰",
    accent: "violet",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.1,
    outputPer1M: 10.0,
    standardInputPer1M: 4.0,
    standardOutputPer1M: 20.0,
  },
  "gemini-4-argon": {
    model: "gemini-4-argon",
    label: "Gemini 4 Argon",
    shortLabel: "Argon",
    role: "性能旗舰",
    accent: "blue",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.1,
    outputPer1M: 10.0,
    standardInputPer1M: 4.0,
    standardOutputPer1M: 20.0,
  },
  "gemini-4-hydrogen": {
    model: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    shortLabel: "Hydrogen",
    role: "轻量全能",
    accent: "emerald",
    inputPer1M: 1.5,
    cachedInputPer1M: 0.075,
    outputPer1M: 7.5,
    standardInputPer1M: 1.5,
    standardOutputPer1M: 7.5,
  },
  "gemini-3.8-flash": {
    model: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    shortLabel: "3.8 Flash",
    role: "极速对话",
    accent: "emerald",
    inputPer1M: 0.75,
    cachedInputPer1M: 0.075,
    outputPer1M: 3.75,
    standardInputPer1M: 1.5,
    standardOutputPer1M: 7.5,
  },
  "gemini-3.1-flash-image": {
    model: "gemini-3.1-flash-image",
    label: "Nano Banana 2 (3.1 Flash Image)",
    shortLabel: "3.1 Flash Image",
    role: "图像生成",
    accent: "amber",
    inputPer1M: 0.5,
    cachedInputPer1M: 0.05,
    outputPer1M: 60.0,
    standardInputPer1M: 0.5,
    standardOutputPer1M: 60.0,
  },
  "gemini-3-pro-image": {
    model: "gemini-3-pro-image",
    label: "Nano Banana Pro (3 Pro Image)",
    shortLabel: "3 Pro Image",
    role: "图像生成",
    accent: "rose",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.2,
    outputPer1M: 120.0,
    standardInputPer1M: 2.0,
    standardOutputPer1M: 120.0,
  },
  "gemini-3.1-flash-lite-image": {
    model: "gemini-3.1-flash-lite-image",
    label: "Nano Banana 2 Lite (3.1 Flash Lite Image)",
    shortLabel: "3.1 Lite Image",
    role: "图像生成",
    accent: "amber",
    inputPer1M: 0.25,
    cachedInputPer1M: 0.025,
    outputPer1M: 30.0,
    standardInputPer1M: 0.25,
    standardOutputPer1M: 30.0,
  },
  "gemini-2.5-flash-image": {
    model: "gemini-2.5-flash-image",
    label: "Nano Banana (2.5 Flash Image)",
    shortLabel: "2.5 Flash Image",
    role: "图像生成",
    accent: "amber",
    inputPer1M: 0.3,
    cachedInputPer1M: 0.03,
    outputPer1M: 30.0,
    standardInputPer1M: 0.3,
    standardOutputPer1M: 30.0,
  },
  "gpt-4o": {
    model: "gpt-4o",
    label: "GPT-4o",
    shortLabel: "GPT-4o",
    role: "OpenAI 旗舰",
    accent: "blue",
    inputPer1M: 2.5,
    cachedInputPer1M: 1.25,
    outputPer1M: 10.0,
    standardInputPer1M: 2.5,
    standardOutputPer1M: 10.0,
  },
  "gpt-4o-mini": {
    model: "gpt-4o-mini",
    label: "GPT-4o mini",
    shortLabel: "4o-mini",
    role: "OpenAI 极速",
    accent: "emerald",
    inputPer1M: 0.15,
    cachedInputPer1M: 0.075,
    outputPer1M: 0.6,
    standardInputPer1M: 0.15,
    standardOutputPer1M: 0.6,
  },
  "gpt-4.1": {
    model: "gpt-4.1",
    label: "GPT-4.1",
    shortLabel: "GPT-4.1",
    role: "OpenAI 工程",
    accent: "blue",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.5,
    outputPer1M: 8.0,
    standardInputPer1M: 2.0,
    standardOutputPer1M: 8.0,
  },
  "o4-mini": {
    model: "o4-mini",
    label: "o4-mini",
    shortLabel: "o4-mini",
    role: "OpenAI 推理",
    accent: "violet",
    inputPer1M: 1.1,
    cachedInputPer1M: 0.275,
    outputPer1M: 4.4,
    standardInputPer1M: 1.1,
    standardOutputPer1M: 4.4,
  },
  "deepseek-flash": {
    model: "deepseek-flash",
    label: "DeepSeek Flash",
    shortLabel: "DS-Flash",
    role: "DeepSeek 极速",
    accent: "emerald",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 2.0,
    cachedInputPer1M: 0.04,
    outputPer1M: 8.0,
    standardInputPer1M: 2.0,
    standardOutputPer1M: 8.0,
  },
  "deepseek-v4-pro": {
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    shortLabel: "DS-V4-Pro",
    role: "DeepSeek 旗舰",
    accent: "violet",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 9.0,
    cachedInputPer1M: 0.3,
    outputPer1M: 27.0,
    standardInputPer1M: 9.0,
    standardOutputPer1M: 27.0,
  },
  "deepseek-chat": {
    model: "deepseek-chat",
    label: "DeepSeek Chat",
    shortLabel: "DS-Chat",
    role: "DeepSeek 对话",
    accent: "emerald",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 2.0,
    cachedInputPer1M: 0.5,
    outputPer1M: 8.0,
    standardInputPer1M: 2.0,
    standardOutputPer1M: 8.0,
  },
  "deepseek-reasoner": {
    model: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    shortLabel: "DS-R1",
    role: "DeepSeek 推理",
    accent: "violet",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 4.0,
    cachedInputPer1M: 1.0,
    outputPer1M: 16.0,
    standardInputPer1M: 4.0,
    standardOutputPer1M: 16.0,
  },
};

/**
 * Official Chinese statutory public holidays (2025–2026) in YYYY-MM-DD (Beijing Time, UTC+8).
 * DeepSeek API charges 50% off-peak rates all day on weekends and Chinese statutory holidays,
 * and outside 09:00–12:00 / 14:00–18:00 Beijing Time on regular weekdays.
 */
const CN_STATUTORY_HOLIDAYS = new Set<string>([
  // 2025
  "2025-01-01",
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
  "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
  "2025-04-04", "2025-04-05", "2025-04-06",
  "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
  "2025-05-31", "2025-06-01", "2025-06-02",
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04",
  "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",
  // 2026
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  "2026-10-05", "2026-10-06", "2026-10-07",
]);

export function isDeepSeekOffPeak(timestamp?: number | string | Date | null): boolean {
  if (timestamp === undefined || timestamp === null || timestamp === "") return false;
  const ms =
    timestamp instanceof Date
      ? timestamp.getTime()
      : typeof timestamp === "number"
        ? timestamp
        : Date.parse(String(timestamp));
  if (!Number.isFinite(ms) || ms <= 0) return false;

  // Shift to Beijing Time (UTC+8, no DST)
  const bj = new Date(ms + 8 * 3_600_000);
  const dow = bj.getUTCDay(); // 0 = Sun, 6 = Sat
  if (dow === 0 || dow === 6) return true;

  const yyyy = bj.getUTCFullYear();
  const mm = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bj.getUTCDate()).padStart(2, "0");
  if (CN_STATUTORY_HOLIDAYS.has(`${yyyy}-${mm}-${dd}`)) return true;

  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const isMorningPeak = mins >= 9 * 60 && mins < 12 * 60;
  const isAfternoonPeak = mins >= 14 * 60 && mins < 18 * 60;
  return !(isMorningPeak || isAfternoonPeak);
}

export function normalizeModelId(modelName = ""): string {
  let clean = String(modelName || "").trim();
  const sepIdx = clean.indexOf("::");
  if (sepIdx !== -1) {
    clean = clean.slice(sepIdx + 2).trim();
  }
  clean = clean.replace(/^models\//i, "");
  return clean || "gemini-4-argon";
}

export function getModelPricing(modelName = ""): ModelPricingEntry {
  const id = normalizeModelId(modelName);
  if (MODEL_PRICING_CATALOG[id]) {
    return MODEL_PRICING_CATALOG[id];
  }
  const lower = id.toLowerCase();
  if (MODEL_PRICING_CATALOG[lower]) {
    return MODEL_PRICING_CATALOG[lower];
  }
  if (lower.startsWith("deepseek")) {
    if (lower.includes("v4-pro") || lower.includes("pro")) {
      const isCanonicalV4Pro = lower.startsWith("deepseek-v4-pro");
      return {
        ...MODEL_PRICING_CATALOG["deepseek-v4-pro"],
        model: isCanonicalV4Pro ? "deepseek-v4-pro" : id,
        label: isCanonicalV4Pro ? "DeepSeek V4 Pro" : id,
      };
    }
    if (lower.includes("reasoner") || lower.includes("r1")) {
      const isCanonicalReasoner = lower.startsWith("deepseek-reasoner");
      return {
        ...MODEL_PRICING_CATALOG["deepseek-reasoner"],
        model: isCanonicalReasoner ? "deepseek-reasoner" : id,
        label: isCanonicalReasoner ? "DeepSeek Reasoner" : id,
      };
    }
    if (lower.includes("flash")) {
      const isCanonicalFlash =
        lower === "deepseek-flash" ||
        lower.startsWith("deepseek-v4-flash") ||
        lower.startsWith("deepseek-v4.1-flash");
      return {
        ...MODEL_PRICING_CATALOG["deepseek-flash"],
        model: isCanonicalFlash ? "deepseek-flash" : id,
        label: isCanonicalFlash ? "DeepSeek Flash" : id,
      };
    }
    return {
      ...MODEL_PRICING_CATALOG["deepseek-chat"],
      model: lower.startsWith("deepseek-chat") ? "deepseek-chat" : id,
      label: lower.startsWith("deepseek-chat") ? "DeepSeek Chat" : id,
    };
  }
  if (lower.includes("image") || lower.includes("imagen")) {
    if (lower.includes("pro")) {
      return {
        ...MODEL_PRICING_CATALOG["gemini-3-pro-image"],
        model: id,
        label: id,
      };
    }
    return {
      ...MODEL_PRICING_CATALOG["gemini-3.1-flash-image"],
      model: id,
      label: id,
    };
  }
  if (lower.includes("neon")) {
    return {
      ...MODEL_PRICING_CATALOG["gemini-4-neon"],
      model: id,
      label: lower === "gemini-4-neon" ? "Gemini 4 Neon" : id,
    };
  }
  if (lower.includes("carbon")) {
    return {
      ...MODEL_PRICING_CATALOG["gemini-4-carbon"],
      model: id,
      label: id,
    };
  }
  if (lower.includes("argon") || lower.includes("pro")) {
    return {
      ...MODEL_PRICING_CATALOG["gemini-4-argon"],
      model: id,
      label: id,
    };
  }
  if (lower.includes("hydrogen")) {
    return {
      ...MODEL_PRICING_CATALOG["gemini-4-hydrogen"],
      model: id,
      label: lower === "gemini-4-hydrogen" ? "Gemini 4 Hydrogen" : id,
    };
  }
  if (lower.includes("flash-lite") || lower.includes("lite")) {
    return {
      model: id,
      label: id,
      shortLabel: "Flash Lite",
      role: "轻量极速模型",
      accent: "emerald",
      inputPer1M: 0.25,
      cachedInputPer1M: 0.025,
      outputPer1M: 1.5,
      standardInputPer1M: 0.5,
      standardOutputPer1M: 3.0,
    };
  }
  if (lower.includes("flash")) {
    return {
      model: id,
      label: lower === "gemini-3.8-flash" ? "Gemini 3.8 Flash" : id,
      shortLabel: "3.8 Flash",
      role: "极速对话",
      accent: "emerald",
      inputPer1M: 0.75,
      cachedInputPer1M: 0.075,
      outputPer1M: 3.75,
      standardInputPer1M: 1.5,
      standardOutputPer1M: 7.5,
    };
  }
  return {
    ...MODEL_PRICING_CATALOG["gemini-4-argon"],
    model: id,
    label: id,
    shortLabel: id,
    role: "自定义模型",
    accent: "slate",
  };
}

function roundCurrency(val: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round((Number(val) || 0) * factor) / factor;
}

export function estimateModelCost(
  modelName: string,
  { input = 0, output = 0, cached = 0, thoughts = 0 }: Partial<TokenUsage> = {},
  {
    providerCurrency,
    timestamp,
    exactCostNative,
  }: {
    providerCurrency?: BillingCurrency;
    timestamp?: number | string | Date | null;
    exactCostNative?: number | null;
  } = {}
) {
  const pricing = getModelPricing(modelName);
  const catalogCurrency: BillingCurrency = pricing.currency || "USD";
  const nativeCurrency: BillingCurrency = providerCurrency || catalogCurrency;
  const rateScale =
    nativeCurrency === catalogCurrency
      ? 1
      : nativeCurrency === "CNY"
        ? USD_TO_CNY
        : 1 / USD_TO_CNY;

  const inputPer1MNative = pricing.inputPer1M * rateScale;
  const cachedInputPer1MNative = pricing.cachedInputPer1M * rateScale;
  const outputPer1MNative = pricing.outputPer1M * rateScale;
  const standardInputPer1MNative = pricing.standardInputPer1M * rateScale;
  const standardOutputPer1MNative = pricing.standardOutputPer1M * rateScale;

  const inputTokens = Math.max(0, Number(input) || 0);
  const cachedTokens = Math.min(inputTokens, Math.max(0, Number(cached) || 0));
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const outputTokens = Math.max(0, Number(output) || 0);
  const thoughtTokens = Math.max(0, Number(thoughts) || 0);

  const appliedOffPeakDiscount =
    Boolean(pricing.supportsOffPeakDiscount) &&
    timestamp !== undefined &&
    timestamp !== null &&
    timestamp !== "" &&
    isDeepSeekOffPeak(timestamp);
  const timeMultiplier = appliedOffPeakDiscount ? 0.5 : 1;

  let inputCostNative =
    ((uncachedInput / 1_000_000) * inputPer1MNative +
      (cachedTokens / 1_000_000) * cachedInputPer1MNative) *
    timeMultiplier;
  let outputCostNative = (outputTokens / 1_000_000) * outputPer1MNative * timeMultiplier;
  let costNative = inputCostNative + outputCostNative;

  if (
    exactCostNative !== undefined &&
    exactCostNative !== null &&
    Number.isFinite(Number(exactCostNative)) &&
    Number(exactCostNative) >= 0
  ) {
    const targetCost = Math.max(0, Number(exactCostNative));
    if (costNative > 0) {
      const ratio = targetCost / costNative;
      inputCostNative *= ratio;
      outputCostNative *= ratio;
    } else {
      inputCostNative = targetCost;
      outputCostNative = 0;
    }
    costNative = targetCost;
  }

  const costCny = toCny(costNative, nativeCurrency);
  const inputCostCny = toCny(inputCostNative, nativeCurrency);
  const outputCostCny = toCny(outputCostNative, nativeCurrency);
  const costUsd = toUsd(costNative, nativeCurrency);
  const inputCostUsd = toUsd(inputCostNative, nativeCurrency);
  const outputCostUsd = toUsd(outputCostNative, nativeCurrency);

  return {
    model: pricing.model,
    label: pricing.label,
    shortLabel: pricing.shortLabel,
    role: pricing.role,
    accent: pricing.accent,
    nativeCurrency,
    offPeakHalfPrice: Boolean(pricing.supportsOffPeakDiscount),
    appliedOffPeakDiscount,
    rates: {
      inputPer1M: roundCurrency(inputPer1MNative, 6),
      cachedInputPer1M: roundCurrency(cachedInputPer1MNative, 6),
      outputPer1M: roundCurrency(outputPer1MNative, 6),
      standardInputPer1M: roundCurrency(standardInputPer1MNative, 6),
      standardOutputPer1M: roundCurrency(standardOutputPer1MNative, 6),
    },
    ratesCny: {
      inputPer1M: roundCurrency(toCny(inputPer1MNative, nativeCurrency), 4),
      cachedInputPer1M: roundCurrency(toCny(cachedInputPer1MNative, nativeCurrency), 4),
      outputPer1M: roundCurrency(toCny(outputPer1MNative, nativeCurrency), 4),
      standardInputPer1M: roundCurrency(toCny(standardInputPer1MNative, nativeCurrency), 4),
      standardOutputPer1M: roundCurrency(toCny(standardOutputPer1MNative, nativeCurrency), 4),
    },
    inputTokens,
    cachedTokens,
    outputTokens,
    thoughtTokens,
    totalTokens: inputTokens + outputTokens,
    inputCostNative: roundCurrency(inputCostNative, 6),
    outputCostNative: roundCurrency(outputCostNative, 6),
    costNative: roundCurrency(costNative, 6),
    inputCostUsd: roundCurrency(inputCostUsd, 6),
    outputCostUsd: roundCurrency(outputCostUsd, 6),
    costUsd: roundCurrency(costUsd, 6),
    inputCostCny: roundCurrency(inputCostCny, 4),
    outputCostCny: roundCurrency(outputCostCny, 4),
    costCny: roundCurrency(costCny, 4),
  };
}

export interface UsageBucket {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  calls: number;
  costNative?: number;
  costCurrency?: BillingCurrency;
  costVersion?: number;
}

export interface ProviderUsageBucket extends UsageBucket {
  providerId: string;
  model: string;
}

export function buildProviderModelKey(providerId = "", model = ""): string {
  const m = normalizeModelId(model);
  const p = String(providerId || "").trim() || "default";
  return `${p}::${m}`;
}

export function parseProviderModelKey(rawKey = ""): { providerId: string; model: string } {
  const clean = String(rawKey || "").trim();
  const sep = clean.indexOf("::");
  if (sep !== -1) {
    return {
      providerId: clean.slice(0, sep).trim() || "default",
      model: normalizeModelId(clean.slice(sep + 2)),
    };
  }
  return {
    providerId: "",
    model: normalizeModelId(clean),
  };
}

export function accumulateSessionUsagePatch(
  session: any,
  event: {
    model?: string;
    providerId?: string;
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    at?: number | string | Date;
  },
  opts: {
    timestamp?: number | string | Date;
    providers?: ProviderEntry[];
  } = {}
): Record<string, any> {
  const prevUsage = session?.usage || { input: 0, output: 0 };
  const inp = Math.max(0, Number(event.input) || 0);
  const out = Math.max(0, Number(event.output) || 0);
  const cached = Math.max(0, Number(event.cached) || 0);
  const thoughts = Math.max(0, Number(event.thoughts) || 0);
  const nextCached = (prevUsage.cached || 0) + cached;
  const nextThoughts = (prevUsage.thoughts || 0) + thoughts;
  const patch: Record<string, any> = {
    usage: {
      input: (prevUsage.input || 0) + inp,
      output: (prevUsage.output || 0) + out,
      ...(nextCached > 0 ? { cached: nextCached } : {}),
      ...(nextThoughts > 0 ? { thoughts: nextThoughts } : {}),
    },
    touch: false,
  };

  if (event.model && typeof event.model === "string") {
    const mKey = event.model.replace(/^models\//i, "").trim();
    if (mKey) {
      const parsed = parseProviderModelKey(mKey);
      const rawProv = String(event.providerId || parsed.providerId || "").trim();
      const provList = Array.isArray(opts.providers) ? opts.providers : [];
      const provInfo = inferProviderForModel(parsed.model, provList, rawProv);
      const providerCurrency = getProviderBillingCurrency(provInfo.provider, parsed.model);
      const explicitTs = event.at ?? opts.timestamp;
      const turnEst = estimateModelCost(
        parsed.model,
        { input: inp, output: out, cached, thoughts },
        {
          providerCurrency,
          ...(explicitTs !== undefined ? { timestamp: explicitTs } : {}),
        }
      );

      const prevByModel =
        session?.usageByModel && typeof session.usageByModel === "object"
          ? { ...session.usageByModel }
          : {};
      const prevBucket = prevByModel[mKey] || {
        input: 0,
        output: 0,
        cached: 0,
        thoughts: 0,
        calls: 0,
      };
      const prevModelWasEmpty =
        (Number(prevBucket.input) || 0) === 0 && (Number(prevBucket.output) || 0) === 0;
      const canTrackModelExactCost =
        prevModelWasEmpty ||
        (prevBucket.costVersion === 2 &&
          typeof prevBucket.costNative === "number" &&
          (!prevBucket.costCurrency || prevBucket.costCurrency === turnEst.nativeCurrency));
      prevByModel[mKey] = {
        input: (prevBucket.input || 0) + inp,
        output: (prevBucket.output || 0) + out,
        cached: (prevBucket.cached || 0) + cached,
        thoughts: (prevBucket.thoughts || 0) + thoughts,
        calls: (prevBucket.calls || 0) + 1,
        ...(canTrackModelExactCost
          ? {
              costNative: roundCurrency(
                (prevModelWasEmpty ? 0 : Number(prevBucket.costNative) || 0) +
                  turnEst.costNative,
                8
              ),
              costCurrency: turnEst.nativeCurrency,
              costVersion: 2,
            }
          : {}),
      };
      patch.usageByModel = prevByModel;

      if (rawProv) {
        const pmKey = buildProviderModelKey(rawProv, parsed.model);
        const prevByPm =
          session?.usageByProviderModel && typeof session.usageByProviderModel === "object"
            ? { ...session.usageByProviderModel }
            : {};
        const prevPmBucket = prevByPm[pmKey] || {
          input: 0,
          output: 0,
          cached: 0,
          thoughts: 0,
          calls: 0,
        };
        const prevPmWasEmpty =
          (Number(prevPmBucket.input) || 0) === 0 && (Number(prevPmBucket.output) || 0) === 0;
        const canTrackPmExactCost =
          prevPmWasEmpty ||
          (prevPmBucket.costVersion === 2 &&
            typeof prevPmBucket.costNative === "number" &&
            (!prevPmBucket.costCurrency || prevPmBucket.costCurrency === turnEst.nativeCurrency));
        prevByPm[pmKey] = {
          input: (prevPmBucket.input || 0) + inp,
          output: (prevPmBucket.output || 0) + out,
          cached: (prevPmBucket.cached || 0) + cached,
          thoughts: (prevPmBucket.thoughts || 0) + thoughts,
          calls: (prevPmBucket.calls || 0) + 1,
          ...(canTrackPmExactCost
            ? {
                costNative: roundCurrency(
                  (prevPmWasEmpty ? 0 : Number(prevPmBucket.costNative) || 0) +
                    turnEst.costNative,
                  8
                ),
                costCurrency: turnEst.nativeCurrency,
                costVersion: 2,
              }
            : {}),
        };
        patch.usageByProviderModel = prevByPm;
      }
    }
  }
  return patch;
}

function providerDeclaresModel(p: ProviderEntry, normModel: string): boolean {
  const all = [
    ...(Array.isArray(p.models) ? p.models : []),
    ...(Array.isArray(p.imageModels) ? p.imageModels : []),
  ];
  return all.some((m) => normalizeModelId(m) === normModel);
}

export function inferProviderForModel(
  modelId: string,
  providers: ProviderEntry[] = [],
  preferredProviderId = ""
): { providerId: string; provider: ProviderEntry | null } {
  const list = Array.isArray(providers) ? providers : [];
  if (preferredProviderId) {
    const exact = list.find((p) => p.id === preferredProviderId);
    if (exact) return { providerId: exact.id, provider: exact };
    return { providerId: preferredProviderId, provider: null };
  }
  const norm = normalizeModelId(modelId);
  const lower = norm.toLowerCase();
  const enabledMatch = list.find(
    (p) => p.enabled !== false && providerDeclaresModel(p, norm)
  );
  if (enabledMatch) return { providerId: enabledMatch.id, provider: enabledMatch };
  const anyMatch = list.find((p) => providerDeclaresModel(p, norm));
  if (anyMatch) return { providerId: anyMatch.id, provider: anyMatch };

  const findByType = (types: string[]) =>
    list.find((p) => p.enabled !== false && types.includes(p.type)) ||
    list.find((p) => types.includes(p.type)) ||
    null;

  if (lower.startsWith("deepseek")) {
    const ds = findByType(["deepseek"]);
    return { providerId: ds?.id || "deepseek", provider: ds };
  }
  if (lower.startsWith("gemini") || lower.startsWith("imagen")) {
    const gem = findByType(["vertex", "gemini"]);
    return { providerId: gem?.id || "gemini", provider: gem };
  }
  if (/^(gpt-|o[134]-|dall-e|tts-)/.test(lower)) {
    const oa = findByType(["openai", "openai-compatible"]);
    return { providerId: oa?.id || "openai", provider: oa };
  }
  const firstEnabled = list.find((p) => p.enabled !== false) || list[0] || null;
  return { providerId: firstEnabled?.id || "default", provider: firstEnabled };
}

export function getProviderBillingCurrency(
  provider: ProviderEntry | null | undefined,
  modelId = ""
): BillingCurrency {
  if (provider?.billingCurrency === "CNY" || provider?.billingCurrency === "USD") {
    return provider.billingCurrency;
  }
  if (provider?.type === "deepseek") return "CNY";
  if (provider) return "USD";
  if (modelId) {
    const pricing = getModelPricing(modelId);
    if (pricing.currency) return pricing.currency;
    if (normalizeModelId(modelId).toLowerCase().startsWith("deepseek")) return "CNY";
  }
  return "USD";
}

export interface ProviderUsageSummaryItem {
  providerId: string;
  providerName: string;
  providerType: string;
  billingCurrency: BillingCurrency;
  enabled: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  calls: number;
  nativeCost: number;
  costUsd: number;
  costCny: number;
  sharePct: number;
}

interface EventLogCanonicalCostBucket {
  input: number;
  output: number;
  cached: number;
  costNative: number;
  costCurrency: BillingCurrency;
}

const MAX_EVENT_BACKFILL_CACHE = 256;
const eventLogCostBackfillCache = new Map<
  string,
  Map<string, EventLogCanonicalCostBucket>
>();

function computeCanonicalEventLogCosts(
  events: any[],
  session: any,
  defaultModel: string,
  providers: ProviderEntry[]
): Map<string, EventLogCanonicalCostBucket> {
  const result = new Map<string, EventLogCanonicalCostBucket>();
  let lastObservedModel = normalizeModelId(session?.model || defaultModel);
  let lastObservedProvider = parseProviderModelKey(session?.model || "").providerId;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "thought" && ev.usedModel) {
      lastObservedModel = normalizeModelId(ev.usedModel);
      if (ev.providerId) lastObservedProvider = String(ev.providerId);
    } else if (ev.type === "usage") {
      const evModel = ev.model || lastObservedModel;
      const inp = Math.max(0, Number(ev.input) || 0);
      const out = Math.max(0, Number(ev.output) || 0);
      if (inp <= 0 && out <= 0) continue;

      const parsed = parseProviderModelKey(evModel);
      const provInfo = inferProviderForModel(
        parsed.model,
        providers,
        String(ev.providerId || lastObservedProvider || parsed.providerId || "")
      );
      const providerCurrency = getProviderBillingCurrency(provInfo.provider, parsed.model);
      const est = estimateModelCost(
        parsed.model,
        {
          input: inp,
          output: out,
          cached: Math.max(0, Number(ev.cached) || 0),
          thoughts: Math.max(0, Number(ev.thoughts) || 0),
        },
        {
          providerCurrency,
          ...(ev.at !== undefined ? { timestamp: ev.at } : {}),
        }
      );

      const canonKey = `${provInfo.providerId}::${est.model}`;
      const cur = result.get(canonKey) || {
        input: 0,
        output: 0,
        cached: 0,
        costNative: 0,
        costCurrency: est.nativeCurrency,
      };
      cur.input += inp;
      cur.output += out;
      cur.cached += est.cachedTokens;
      cur.costNative = roundCurrency(cur.costNative + est.costNative, 8);
      result.set(canonKey, cur);
    }
  }
  return result;
}

/**
 * Resolves per-(provider, model) usage for a single session, preferring `usageByProviderModel`,
 * falling back to `usageByModel`, event log backfill, and session remainder attribution.
 */
export function resolveSessionUsageByProviderModel(
  session: any,
  {
    readEvents,
    defaultModel = "gemini-4-argon",
    providers = [],
  }: {
    readEvents?: (sessionId: string) => any[];
    defaultModel?: string;
    providers?: ProviderEntry[];
  } = {}
): Map<string, ProviderUsageBucket> {
  const sessionInput = Math.max(0, Number(session?.usage?.input) || 0);
  const sessionOutput = Math.max(0, Number(session?.usage?.output) || 0);
  const sessionCached = Math.max(0, Number(session?.usage?.cached) || 0);
  const sessionThoughts = Math.max(0, Number(session?.usage?.thoughts) || 0);

  const map = new Map<string, ProviderUsageBucket>();
  const addBucket = (
    rawModel: string,
    stats: Partial<UsageBucket>,
    preferredProviderId = ""
  ) => {
    const parsed = parseProviderModelKey(rawModel || session?.model || defaultModel);
    const provInfo = inferProviderForModel(
      parsed.model,
      providers,
      preferredProviderId || parsed.providerId
    );
    const key = buildProviderModelKey(provInfo.providerId, parsed.model);
    const cur = map.get(key) || {
      providerId: provInfo.providerId,
      model: parsed.model,
      input: 0,
      output: 0,
      cached: 0,
      thoughts: 0,
      calls: 0,
    };
    const curWasEmpty = cur.input === 0 && cur.output === 0;
    const sIn = Math.max(0, Number(stats.input) || 0);
    const sOut = Math.max(0, Number(stats.output) || 0);
    const statsHasExact =
      stats.costVersion === 2 &&
      typeof stats.costNative === "number" &&
      Number.isFinite(stats.costNative);

    if (sIn > 0 || sOut > 0) {
      if (curWasEmpty) {
        if (statsHasExact) {
          cur.costNative = stats.costNative;
          cur.costCurrency = stats.costCurrency;
          cur.costVersion = 2;
        }
      } else if (
        cur.costVersion === 2 &&
        typeof cur.costNative === "number" &&
        statsHasExact &&
        cur.costCurrency === stats.costCurrency
      ) {
        cur.costNative = roundCurrency(cur.costNative + (stats.costNative || 0), 8);
      } else {
        delete cur.costNative;
        delete cur.costCurrency;
        delete cur.costVersion;
      }
    }

    cur.input += sIn;
    cur.output += sOut;
    cur.cached += Math.max(0, Number(stats.cached) || 0);
    cur.thoughts += Math.max(0, Number(stats.thoughts) || 0);
    cur.calls += Math.max(0, Number(stats.calls) || 0);
    map.set(key, cur);
  };

  let hasProviderBuckets = false;
  if (
    session?.usageByProviderModel &&
    typeof session.usageByProviderModel === "object"
  ) {
    for (const [pmKey, bucket] of Object.entries(session.usageByProviderModel)) {
      if (bucket && typeof bucket === "object") {
        const parsed = parseProviderModelKey(pmKey);
        addBucket(parsed.model, bucket as Partial<UsageBucket>, parsed.providerId);
        hasProviderBuckets = true;
      }
    }
  }

  let accountedInput = 0;
  let accountedOutput = 0;
  for (const b of map.values()) {
    accountedInput += b.input;
    accountedOutput += b.output;
  }

  if (
    !hasProviderBuckets &&
    session?.usageByModel &&
    typeof session.usageByModel === "object"
  ) {
    for (const [m, bucket] of Object.entries(session.usageByModel)) {
      if (bucket && typeof bucket === "object") {
        addBucket(m, bucket as Partial<UsageBucket>);
      }
    }
    accountedInput = 0;
    accountedOutput = 0;
    for (const b of map.values()) {
      accountedInput += b.input;
      accountedOutput += b.output;
    }
  }

  // Backfill legacy sessions whose `session.usage` predates `session.usageByModel`
  if (
    accountedInput === 0 &&
    accountedOutput === 0 &&
    (sessionInput > 0 || sessionOutput > 0)
  ) {
    let events: any[] = [];
    try {
      if (typeof readEvents === "function" && session?.id) {
        events = readEvents(session.id) || [];
      }
    } catch {
      events = [];
    }

    let lastObservedModel = normalizeModelId(session?.model || defaultModel);
    let lastObservedProvider = parseProviderModelKey(session?.model || "").providerId;
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "thought" && ev.usedModel) {
        lastObservedModel = normalizeModelId(ev.usedModel);
        if (ev.providerId) lastObservedProvider = String(ev.providerId);
      } else if (ev.type === "usage") {
        const evModel = ev.model || lastObservedModel;
        const inp = Math.max(0, Number(ev.input) || 0);
        const out = Math.max(0, Number(ev.output) || 0);
        if (inp > 0 || out > 0) {
          const parsed = parseProviderModelKey(evModel);
          const prefProv = String(ev.providerId || lastObservedProvider || "");
          const provInfo = inferProviderForModel(parsed.model, providers, prefProv || parsed.providerId);
          const provCurr = getProviderBillingCurrency(provInfo.provider, parsed.model);
          const evEst = estimateModelCost(
            parsed.model,
            {
              input: inp,
              output: out,
              cached: ev.cached || 0,
              thoughts: ev.thoughts || 0,
            },
            {
              providerCurrency: provCurr,
              ...(ev.at !== undefined ? { timestamp: ev.at } : {}),
            }
          );
          addBucket(
            evModel,
            {
              input: inp,
              output: out,
              cached: ev.cached || 0,
              thoughts: ev.thoughts || 0,
              calls: 1,
              costNative: evEst.costNative,
              costCurrency: evEst.nativeCurrency,
              costVersion: 2,
            },
            prefProv
          );
          accountedInput += inp;
          accountedOutput += out;
        }
      }
    }
  }

  // Ensure any remaining unattributed delta matches session.usage exactly
  const remInput = Math.max(0, sessionInput - accountedInput);
  const remOutput = Math.max(0, sessionOutput - accountedOutput);
  if (remInput > 0 || remOutput > 0) {
    addBucket(session?.model || defaultModel, {
      input: remInput,
      output: remOutput,
      cached: accountedInput === 0 ? sessionCached : 0,
      thoughts: accountedOutput === 0 ? sessionThoughts : 0,
      calls: 0,
    });
  }

  // Backfill exact per-turn Peak/Off-Peak + Cache Hit costs from `.ndjson` events
  // for pre-v2 buckets whose model supports time-of-day discounts (e.g. DeepSeek).
  if (typeof readEvents === "function" && session?.id) {
    const needsEventCostBackfill = Array.from(map.values()).some(
      (b) =>
        b.costVersion !== 2 &&
        (b.input > 0 || b.output > 0) &&
        Boolean(getModelPricing(b.model).supportsOffPeakDiscount)
    );
    if (needsEventCostBackfill) {
      const provSig = (Array.isArray(providers) ? providers : [])
        .map((p) => `${p.id}:${p.type}:${p.billingCurrency || ""}`)
        .join(",");
      const cacheKey = `${session.id}|${session.updatedAt || ""}|${sessionInput}|${sessionOutput}|${sessionCached}|${provSig}`;
      let canonCostMap = eventLogCostBackfillCache.get(cacheKey);
      if (!canonCostMap) {
        let events: any[] = [];
        try {
          events = readEvents(session.id) || [];
        } catch {
          events = [];
        }
        if (events.length > 0) {
          canonCostMap = computeCanonicalEventLogCosts(
            events,
            session,
            defaultModel,
            providers
          );
          if (eventLogCostBackfillCache.size >= MAX_EVENT_BACKFILL_CACHE) {
            const oldestKey = eventLogCostBackfillCache.keys().next().value;
            if (oldestKey !== undefined) eventLogCostBackfillCache.delete(oldestKey);
          }
          eventLogCostBackfillCache.set(cacheKey, canonCostMap);
        }
      }

      if (canonCostMap && canonCostMap.size > 0) {
        const byCanon = new Map<string, ProviderUsageBucket[]>();
        for (const b of map.values()) {
          if (b.costVersion === 2 || (b.input <= 0 && b.output <= 0)) continue;
          const pricing = getModelPricing(b.model);
          if (!pricing.supportsOffPeakDiscount) continue;
          const ck = `${b.providerId}::${pricing.model}`;
          const arr = byCanon.get(ck) || [];
          arr.push(b);
          byCanon.set(ck, arr);
        }

        for (const [ck, group] of byCanon.entries()) {
          const evBucket = canonCostMap.get(ck);
          if (!evBucket || (evBucket.input <= 0 && evBucket.output <= 0)) continue;

          const groupTotalTok = group.reduce((acc, b) => acc + b.input + b.output, 0);
          if (groupTotalTok <= 0) continue;
          const evTotalTok = evBucket.input + evBucket.output;
          const coveredScale = evTotalTok > groupTotalTok ? groupTotalTok / evTotalTok : 1;
          const coveredCostTotal = evBucket.costNative * coveredScale;

          for (const b of group) {
            const share = (b.input + b.output) / groupTotalTok;
            const coveredIn = evBucket.input * coveredScale * share;
            const coveredOut = evBucket.output * coveredScale * share;
            const coveredCached = evBucket.cached * coveredScale * share;
            const remIn = Math.max(0, b.input - coveredIn);
            const remOut = Math.max(0, b.output - coveredOut);
            const remCached = Math.min(remIn, Math.max(0, b.cached - coveredCached));
            const remCost =
              remIn > 0.5 || remOut > 0.5
                ? estimateModelCost(
                    b.model,
                    { input: remIn, output: remOut, cached: remCached },
                    { providerCurrency: evBucket.costCurrency }
                  ).costNative
                : 0;
            b.costNative = roundCurrency(coveredCostTotal * share + remCost, 8);
            b.costCurrency = evBucket.costCurrency;
            b.costVersion = 2;
          }
        }
      }
    }
  }

  return map;
}

/**
 * Resolves per-model usage for a single session, backfilling from its event log
 * if historical tokens were recorded prior to `session.usageByModel`.
 */
export function resolveSessionUsageByModel(
  session: any,
  {
    readEvents,
    defaultModel = "gemini-4-argon",
  }: { readEvents?: (sessionId: string) => any[]; defaultModel?: string } = {}
): Map<string, UsageBucket> {
  const pmMap = resolveSessionUsageByProviderModel(session, {
    readEvents,
    defaultModel,
  });
  const map = new Map<string, UsageBucket>();
  for (const b of pmMap.values()) {
    const cur = map.get(b.model) || {
      input: 0,
      output: 0,
      cached: 0,
      thoughts: 0,
      calls: 0,
    };
    cur.input += b.input;
    cur.output += b.output;
    cur.cached += b.cached;
    cur.thoughts += b.thoughts;
    cur.calls += b.calls;
    map.set(b.model, cur);
  }
  return map;
}

export function buildSessionCostSummary(
  session: any,
  {
    readEvents,
    defaultModel = "gemini-4-argon",
    providers = [],
    includeDisabled = true,
  }: {
    readEvents?: (sessionId: string) => any[];
    defaultModel?: string;
    providers?: ProviderEntry[];
    includeDisabled?: boolean;
  } = {}
) {
  const pmMap = resolveSessionUsageByProviderModel(session, {
    readEvents,
    defaultModel,
    providers,
  });
  const providerById = new Map<string, ProviderEntry>(
    (Array.isArray(providers) ? providers : []).map((p) => [p.id, p])
  );
  const disabledIds = new Set(
    (Array.isArray(providers) ? providers : [])
      .filter((p) => p.enabled === false)
      .map((p) => p.id)
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let thoughtTokens = 0;
  let costUsd = 0;
  let costCny = 0;

  type ModelItem = ReturnType<typeof estimateModelCost> & {
    calls: number;
    sharePct?: number;
    providerId?: string;
  };
  const byModelMap = new Map<string, ModelItem>();
  const byProviderBuckets: Array<{
    providerId: string;
    model: string;
    est: ReturnType<typeof estimateModelCost>;
    calls: number;
  }> = [];

  for (const bucket of pmMap.values()) {
    if (!includeDisabled && disabledIds.has(bucket.providerId)) {
      continue;
    }
    const prov = providerById.get(bucket.providerId) || null;
    const providerCurrency = getProviderBillingCurrency(prov, bucket.model);
    const exactCostNative =
      bucket.costVersion === 2 &&
      typeof bucket.costNative === "number" &&
      (!bucket.costCurrency || bucket.costCurrency === providerCurrency)
        ? bucket.costNative
        : undefined;
    const est = estimateModelCost(bucket.model, bucket, {
      providerCurrency,
      ...(exactCostNative !== undefined ? { exactCostNative } : {}),
    });

    inputTokens += est.inputTokens;
    outputTokens += est.outputTokens;
    cachedTokens += est.cachedTokens;
    thoughtTokens += est.thoughtTokens;
    costUsd += est.costUsd;
    costCny += est.costCny;

    byProviderBuckets.push({
      providerId: bucket.providerId,
      model: bucket.model,
      est,
      calls: bucket.calls || 0,
    });

    const prev = byModelMap.get(est.model);
    if (!prev) {
      byModelMap.set(est.model, {
        ...est,
        calls: bucket.calls || 0,
        providerId: bucket.providerId,
      });
    } else {
      prev.inputTokens += est.inputTokens;
      prev.cachedTokens += est.cachedTokens;
      prev.outputTokens += est.outputTokens;
      prev.thoughtTokens += est.thoughtTokens;
      prev.totalTokens += est.totalTokens;
      prev.inputCostNative = roundCurrency(prev.inputCostNative + est.inputCostNative, 6);
      prev.outputCostNative = roundCurrency(prev.outputCostNative + est.outputCostNative, 6);
      prev.costNative = roundCurrency(prev.costNative + est.costNative, 6);
      prev.inputCostUsd = roundCurrency(prev.inputCostUsd + est.inputCostUsd, 6);
      prev.outputCostUsd = roundCurrency(prev.outputCostUsd + est.outputCostUsd, 6);
      prev.costUsd = roundCurrency(prev.costUsd + est.costUsd, 6);
      prev.inputCostCny = roundCurrency(prev.inputCostCny + est.inputCostCny, 4);
      prev.outputCostCny = roundCurrency(prev.outputCostCny + est.outputCostCny, 4);
      prev.costCny = roundCurrency(prev.costCny + est.costCny, 4);
      prev.calls += bucket.calls || 0;
    }
  }

  const byModel = Array.from(byModelMap.values());
  const totalTokens = inputTokens + outputTokens;
  for (const item of byModel) {
    item.sharePct =
      totalTokens > 0
        ? Math.round((item.totalTokens / totalTokens) * 1000) / 10
        : 0;
  }
  byModel.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    thoughtTokens,
    totalTokens,
    estimatedCostUsd: roundCurrency(costUsd, 6),
    estimatedCostCny: roundCurrency(costCny, 4),
    byModel,
    byProviderBuckets,
  };
}

export function aggregateWorkspaceUsage({
  sessions = [],
  readEvents,
  sessionId = "",
  configuredModels = [
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-4-hydrogen",
  ],
  defaultModel = "gemini-4-argon",
  weeklyQuota = 2_000_000,
  providers = [],
  includeDisabled = true,
}: {
  sessions?: any[];
  readEvents?: (sessionId: string) => any[];
  sessionId?: string;
  configuredModels?: string[];
  defaultModel?: string;
  weeklyQuota?: number;
  providers?: ProviderEntry[];
  includeDisabled?: boolean;
} = {}) {
  const scopedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const targetSession = scopedSessionId
    ? sessions.find((s) => s?.id === scopedSessionId) || null
    : null;

  const providerList = Array.isArray(providers) ? providers : [];
  const providerById = new Map<string, ProviderEntry>(
    providerList.map((p) => [p.id, p])
  );
  const disabledIds = new Set(
    providerList.filter((p) => p.enabled === false).map((p) => p.id)
  );

  type AggModelAcc = ReturnType<typeof estimateModelCost> & {
    calls: number;
    sharePct?: number;
    providerId?: string;
  };
  const globalModelMap = new Map<string, AggModelAcc>();
  for (const m of configuredModels) {
    const norm = normalizeModelId(m);
    const provInfo = inferProviderForModel(norm, providerList);
    if (!includeDisabled && disabledIds.has(provInfo.providerId)) continue;
    if (!globalModelMap.has(norm)) {
      const currency = getProviderBillingCurrency(provInfo.provider, norm);
      const zeroEst = estimateModelCost(
        norm,
        { input: 0, output: 0, cached: 0, thoughts: 0 },
        { providerCurrency: currency }
      );
      globalModelMap.set(norm, {
        ...zeroEst,
        calls: 0,
        providerId: provInfo.providerId,
      });
    }
  }

  const providerAccMap = new Map<string, ProviderUsageSummaryItem>();
  for (const p of providerList) {
    if (!includeDisabled && p.enabled === false) continue;
    providerAccMap.set(p.id, {
      providerId: p.id,
      providerName: p.name || p.id,
      providerType: p.type,
      billingCurrency: getProviderBillingCurrency(p),
      enabled: p.enabled !== false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtTokens: 0,
      totalTokens: 0,
      calls: 0,
      nativeCost: 0,
      costUsd: 0,
      costCny: 0,
      sharePct: 0,
    });
  }

  const bySession: Array<{
    id: string;
    title: string;
    type: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    costCny: number;
  }> = [];

  for (const s of sessions) {
    const sSummary = buildSessionCostSummary(s, {
      readEvents,
      defaultModel,
      providers: providerList,
      includeDisabled,
    });
    const includeInScope = !scopedSessionId || (targetSession && s.id === targetSession.id);
    if (includeInScope) {
      for (const b of sSummary.byProviderBuckets) {
        const est = b.est;
        const prev = globalModelMap.get(est.model);
        if (!prev) {
          globalModelMap.set(est.model, {
            ...est,
            calls: b.calls,
            providerId: b.providerId,
          });
        } else {
          prev.inputTokens += est.inputTokens;
          prev.cachedTokens += est.cachedTokens;
          prev.outputTokens += est.outputTokens;
          prev.thoughtTokens += est.thoughtTokens;
          prev.totalTokens += est.totalTokens;
          prev.inputCostNative = roundCurrency(prev.inputCostNative + est.inputCostNative, 6);
          prev.outputCostNative = roundCurrency(prev.outputCostNative + est.outputCostNative, 6);
          prev.costNative = roundCurrency(prev.costNative + est.costNative, 6);
          prev.inputCostUsd = roundCurrency(prev.inputCostUsd + est.inputCostUsd, 6);
          prev.outputCostUsd = roundCurrency(prev.outputCostUsd + est.outputCostUsd, 6);
          prev.costUsd = roundCurrency(prev.costUsd + est.costUsd, 6);
          prev.inputCostCny = roundCurrency(prev.inputCostCny + est.inputCostCny, 4);
          prev.outputCostCny = roundCurrency(prev.outputCostCny + est.outputCostCny, 4);
          prev.costCny = roundCurrency(prev.costCny + est.costCny, 4);
          prev.calls += b.calls;
        }

        const matchedProv = providerById.get(b.providerId) || null;
        const provCurrency = getProviderBillingCurrency(matchedProv, est.model);
        const pAcc = providerAccMap.get(b.providerId) || {
          providerId: b.providerId,
          providerName: matchedProv?.name || b.providerId,
          providerType: matchedProv?.type || "custom",
          billingCurrency: provCurrency,
          enabled: matchedProv ? matchedProv.enabled !== false : true,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtTokens: 0,
          totalTokens: 0,
          calls: 0,
          nativeCost: 0,
          costUsd: 0,
          costCny: 0,
          sharePct: 0,
        };
        pAcc.inputTokens += est.inputTokens;
        pAcc.outputTokens += est.outputTokens;
        pAcc.cachedTokens += est.cachedTokens;
        pAcc.thoughtTokens += est.thoughtTokens;
        pAcc.totalTokens += est.totalTokens;
        pAcc.calls += b.calls;
        pAcc.nativeCost = roundCurrency(
          pAcc.nativeCost + fromCny(est.costCny, pAcc.billingCurrency),
          6
        );
        pAcc.costUsd = roundCurrency(pAcc.costUsd + est.costUsd, 6);
        pAcc.costCny = roundCurrency(pAcc.costCny + est.costCny, 4);
        providerAccMap.set(b.providerId, pAcc);
      }
    }

    if (sSummary.totalTokens > 0) {
      bySession.push({
        id: s.id,
        title: s.title || "Bot",
        type: s.type || "bot",
        inputTokens: sSummary.inputTokens,
        outputTokens: sSummary.outputTokens,
        totalTokens: sSummary.totalTokens,
        costUsd: sSummary.estimatedCostUsd,
        costCny: sSummary.estimatedCostCny,
      });
    }
  }

  bySession.sort((a, b) => b.costCny - a.costCny || b.totalTokens - a.totalTokens);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalThoughts = 0;
  let totalCostUsd = 0;
  let totalCostCny = 0;
  const byModel: AggModelAcc[] = [];

  const orderRank = (m: string) => {
    const idx = configuredModels.map(normalizeModelId).indexOf(m);
    return idx === -1 ? 999 : idx;
  };

  for (const item of globalModelMap.values()) {
    totalInput += item.inputTokens;
    totalOutput += item.outputTokens;
    totalCached += item.cachedTokens;
    totalThoughts += item.thoughtTokens;
    totalCostUsd += item.costUsd;
    totalCostCny += item.costCny;
    byModel.push(item);
  }

  const totalTokens = totalInput + totalOutput;
  for (const item of byModel) {
    item.sharePct =
      totalTokens > 0
        ? Math.round((item.totalTokens / totalTokens) * 1000) / 10
        : 0;
  }

  const byProvider = Array.from(providerAccMap.values()).map((p) => ({
    ...p,
    sharePct:
      totalTokens > 0
        ? Math.round((p.totalTokens / totalTokens) * 1000) / 10
        : 0,
  }));
  byProvider.sort((a, b) => b.costCny - a.costCny || b.totalTokens - a.totalTokens);

  byModel.sort((a, b) => orderRank(a.model) - orderRank(b.model));

  const percentUsed =
    totalTokens === 0
      ? 0
      : Math.min(100, Math.max(1, Math.round((totalTokens / weeklyQuota) * 100)));

  return {
    scope: scopedSessionId ? "session" : "all",
    session: targetSession
      ? {
          id: targetSession.id,
          title: targetSession.title || "Bot",
          type: targetSession.type || "bot",
        }
      : null,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cachedTokens: totalCached,
    thoughtTokens: totalThoughts,
    totalTokens,
    sessionCount: scopedSessionId ? (targetSession ? 1 : 0) : sessions.length,
    weeklyQuota,
    percentUsed,
    estimatedCostUsd: roundCurrency(totalCostUsd, 6),
    estimatedCostCny: roundCurrency(totalCostCny, 4),
    usdToCnyRate: USD_TO_CNY,
    pricingNote:
      "各供应商按各自结算币种（USD / CNY）原币计费，界面统一按 ¥ 人民币实时汇总显示",
    byModel,
    byProvider,
    bySession,
  };
}
