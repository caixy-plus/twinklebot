import type { ContextCompressionSettings } from "./entities.js";

export const DEFAULT_CONTEXT_COMPRESSION: ContextCompressionSettings = {
  enabled: true,
  triggerPercent: 75,
  customInstruction: "",
};

export interface ContextCompressionPreset {
  id: "compact" | "balanced" | "long";
  label: string;
  badge?: string;
  desc: string;
  values: Pick<ContextCompressionSettings, "triggerPercent">;
}

export const CONTEXT_COMPRESSION_PRESETS: ContextCompressionPreset[] = [
  {
    id: "compact",
    label: "省 Token",
    desc: "窗口 50% 触发 · 更省开销",
    values: {
      triggerPercent: 50,
    },
  },
  {
    id: "balanced",
    label: "均衡",
    badge: "推荐",
    desc: "窗口 75% 触发 · 兼顾记忆与成本",
    values: {
      triggerPercent: 75,
    },
  },
  {
    id: "long",
    label: "长记忆",
    desc: "窗口 85% 触发 · 保留更长对话",
    values: {
      triggerPercent: 85,
    },
  },
];

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

/**
 * Resolves the effective context window budget (in tokens) for a given model ID.
 * Gemini keeps a 200K standard-tier ceiling to avoid stepping into 2x pricing tiers.
 */
export function getModelContextWindow(modelName = ""): number {
  let clean = String(modelName || "").trim();
  const sepIdx = clean.indexOf("::");
  if (sepIdx !== -1) {
    clean = clean.slice(sepIdx + 2).trim();
  }
  clean = clean.replace(/^models\//i, "").toLowerCase();
  if (!clean) return DEFAULT_MODEL_CONTEXT_WINDOW;

  if (clean.includes("gemini")) return 200_000;
  if (clean.includes("claude")) return 200_000;
  if (/(?:^|\/)gpt-4\.1(?:\b|[-_])|(?:^|\/)gpt-5(?:\b|[-_])/.test(clean)) return 400_000;
  if (/(?:^|\/)o[134](?:\b|-)/.test(clean)) return 200_000;
  if (
    clean.includes("deepseek-flash") ||
    clean.includes("deepseek-v4")
  ) {
    return 1_000_000;
  }
  if (clean.includes("gpt-4o") || clean.includes("deepseek")) return 128_000;

  for (const m of clean.matchAll(/(?:^|[-_/:])(\d+)\s*([km])(?=$|[-_/:])/g)) {
    const qty = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (unit === "m" && qty <= 10) {
      return Math.min(2_000_000, Math.max(8_000, qty * 1_000_000));
    }
    if (unit === "k" && qty >= 4 && qty <= 2_048) {
      return Math.min(2_000_000, Math.max(8_000, qty * 1_000));
    }
  }
  return DEFAULT_MODEL_CONTEXT_WINDOW;
}

export function matchContextCompressionPreset(
  raw: unknown
): ContextCompressionPreset["id"] | "custom" {
  const c = normalizeContextCompressionSettings(raw);
  for (const preset of CONTEXT_COMPRESSION_PRESETS) {
    if (c.triggerPercent === preset.values.triggerPercent) {
      return preset.id;
    }
  }
  return "custom";
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function migrateLegacyPercent(src: Record<string, unknown>): number | undefined {
  const legacyChars = Number(src.maxContextChars);
  if (!Number.isFinite(legacyChars) || legacyChars <= 0) return undefined;
  if (legacyChars <= 36_000) return 50;
  if (legacyChars <= 90_000) return 75;
  return 85;
}

export function normalizeContextCompressionSettings(
  raw: unknown
): ContextCompressionSettings {
  const src = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  const migratedPercent =
    src.triggerPercent !== undefined ? src.triggerPercent : migrateLegacyPercent(src);

  return {
    enabled:
      typeof src.enabled === "boolean"
        ? src.enabled
        : DEFAULT_CONTEXT_COMPRESSION.enabled,
    triggerPercent: clampInt(
      migratedPercent,
      DEFAULT_CONTEXT_COMPRESSION.triggerPercent,
      30,
      95
    ),
    customInstruction:
      typeof src.customInstruction === "string"
        ? src.customInstruction.trim().slice(0, 500)
        : "",
  };
}
