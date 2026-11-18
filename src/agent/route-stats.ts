/**
 * L3 Turn Budget Guard + L4 Outcome Stats & Category Bias for TwinkleBot Smart Router v2.
 */
import type { RoutingMode, RoutingSettings, RoutingTierRef, TokenUsage } from "../shared/config.js";
import { estimateModelCost } from "./pricing.js";
import type { RoutePlan } from "./route-planner.js";
import type { RouteTier } from "./router.js";

export const ROUTING_MODES: RoutingMode[] = ["economy", "balanced", "quality"];

export const MODE_PRESETS: Record<
  RoutingMode,
  { deepCap: number; tierShift: number; defaultMaxTurnUsd: number }
> = {
  economy: { deepCap: 1, tierShift: -0.5, defaultMaxTurnUsd: 0.25 },
  balanced: { deepCap: 3, tierShift: 0, defaultMaxTurnUsd: 0.5 },
  quality: { deepCap: 5, tierShift: 0.5, defaultMaxTurnUsd: 1.5 },
};

export const DEFAULT_ROUTING_SETTINGS = Object.freeze({
  smartRouter: true,
  mode: "balanced" as RoutingMode,
  maxTurnUsd: 0.5,
});

function normalizeTierBinding(raw: any): RoutingTierRef | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    const sep = s.indexOf("::");
    return sep !== -1
      ? { providerId: s.slice(0, sep).trim(), model: s.slice(sep + 2).trim() }
      : { providerId: "", model: s };
  }
  if (typeof raw === "object") {
    const model = String(raw.model || "").trim();
    const providerId = String(raw.providerId || "").trim();
    if (!model) return null;
    return { providerId, model };
  }
  return null;
}

/** Normalizes `settings.routing` with safe defaults and value ranges. */
export function normalizeRoutingSettings(raw: Record<string, any> = {}): RoutingSettings {
  const src = raw && typeof raw === "object" ? raw : {};
  const mode: RoutingMode = ROUTING_MODES.includes(src.mode)
    ? src.mode
    : DEFAULT_ROUTING_SETTINGS.mode;
  const maxRaw = Number(src.maxTurnUsd);
  const maxTurnUsd = Number.isFinite(maxRaw)
    ? Math.min(Math.max(maxRaw, 0.05), 10)
    : MODE_PRESETS[mode].defaultMaxTurnUsd;
  const out: RoutingSettings = {
    smartRouter: src.smartRouter !== false,
    mode,
    maxTurnUsd: Math.round(maxTurnUsd * 100) / 100,
  };
  if (src.tiers && typeof src.tiers === "object" && !Array.isArray(src.tiers)) {
    const fast = normalizeTierBinding(src.tiers.fast);
    const medium = normalizeTierBinding(src.tiers.medium || src.tiers.standard);
    const advanced = normalizeTierBinding(src.tiers.advanced || src.tiers.deep);
    const image = normalizeTierBinding(src.tiers.image);
    const tiers: NonNullable<RoutingSettings["tiers"]> = {};
    if (fast) tiers.fast = fast;
    if (medium) tiers.medium = medium;
    if (advanced) tiers.advanced = advanced;
    if (image) tiers.image = image;
    if (Object.keys(tiers).length > 0) {
      out.tiers = tiers;
    }
  }
  return out;
}

export interface TurnBudget {
  readonly maxTurnUsd: number;
  readonly spentUsd: number;
  add(modelName: string, usage?: Partial<TokenUsage>): number;
  ratio(): number;
  canUseDeep(): boolean;
  canEscalate(): boolean;
  takeNotice(): 0 | 1 | 2;
}

/**
 * Per-turn cost budget. Deep (Carbon) escalation is blocked at 80% of budget; at 100% all escalation stops.
 */
export function createTurnBudget({ maxTurnUsd = 0.5 }: { maxTurnUsd?: number } = {}): TurnBudget {
  let spentUsd = 0;
  let notifiedLevel = 0; // 0 none, 1 = 80%, 2 = 100%
  return {
    get maxTurnUsd() {
      return maxTurnUsd;
    },
    get spentUsd() {
      return spentUsd;
    },
    add(modelName: string, usage: Partial<TokenUsage> = {}) {
      const est = estimateModelCost(modelName, usage);
      spentUsd += Number(est.costUsd) || 0;
      return est.costUsd;
    },
    ratio() {
      return maxTurnUsd > 0 ? spentUsd / maxTurnUsd : 0;
    },
    canUseDeep() {
      return this.ratio() < 0.8;
    },
    canEscalate() {
      return this.ratio() < 1;
    },
    /** Returns a notice level (1 or 2) exactly once per threshold crossing, else 0. */
    takeNotice(): 0 | 1 | 2 {
      const r = this.ratio();
      if (r >= 1 && notifiedLevel < 2) {
        notifiedLevel = 2;
        return 2;
      }
      if (r >= 0.8 && notifiedLevel < 1) {
        notifiedLevel = 1;
        return 1;
      }
      return 0;
    },
  };
}

const TIER_ORDER: RouteTier[] = ["fast", "standard", "deep"];

/**
 * Maps a planner task profile to a base execution tier + opening plan across Hydrogen (4 thinking levels) / Argon / Carbon.
 */
export function tierFromPlan(
  plan: RoutePlan,
  {
    mode = "balanced",
    bias = 0,
    hasAttachments = false,
  }: { mode?: RoutingMode; bias?: number; hasAttachments?: boolean } = {}
): {
  baseTier: RouteTier;
  openWithDeepSteps: number;
  thinkingLevel: string;
  score: number;
} {
  const preset = MODE_PRESETS[mode] || MODE_PRESETS.balanced;
  const steps = Math.max(1, Number(plan.expected_steps) || 1);
  const conf = Number.isFinite(Number(plan.confidence)) ? Number(plan.confidence) : 0.9;
  const isVisual = Boolean(plan.needs_visual || hasAttachments);

  const openWithDeepSteps =
    plan.complexity === "complex" && plan.needs_planning && mode !== "economy"
      ? steps >= 10 || mode === "quality"
        ? 2
        : 1
      : plan.complexity === "complex" && plan.needs_planning && mode === "economy"
        ? 1
        : 0;

  let score = 0;
  if (plan.complexity === "trivial") {
    score = 0;
  } else if (plan.complexity === "standard") {
    score = steps >= 6 || plan.needs_planning ? 1.0 : 0.45;
  } else {
    // Non-planning complex tasks can leverage Hydrogen XHigh directly outside quality mode
    score = !plan.needs_planning && !hasAttachments && plan.risk !== "high" && mode !== "quality" ? 0.6 : 1.1;
  }

  score += preset.tierShift + (Number(bias) || 0);
  if (conf < 0.6) score += 0.6;
  if (steps >= 6) score += 0.2;
  if (plan.risk === "medium") score += 0.2;

  let baseTier: RouteTier = score >= 0.75 ? "standard" : "fast";
  if (plan.risk === "high") baseTier = "standard";
  if (mode === "quality" && (isVisual || plan.complexity !== "trivial")) baseTier = "standard";

  // Pure-text chat uses Medium tier (`medium`); higher complexity scales to `high` / `xhigh`
  let thinkingLevel = "medium";
  if (baseTier === "fast") {
    if (plan.complexity === "complex" || steps >= 6 || (conf < 0.6 && plan.complexity !== "trivial")) {
      thinkingLevel = "xhigh";
    } else if (hasAttachments || steps >= 4 || plan.needs_planning || plan.risk === "medium" || conf < 0.75) {
      thinkingLevel = "high";
    } else {
      thinkingLevel = "medium";
    }
  } else if (plan.risk === "high" || plan.complexity === "complex" || conf < 0.6) {
    thinkingLevel = "medium";
  } else {
    thinkingLevel = "low";
  }

  return { baseTier, openWithDeepSteps, thinkingLevel, score: Math.round(score * 100) / 100 };
}

/**
 * Resolves the model tier & thinking level assigned for a specific `stepNo`
 * from Hydrogen High's `plan.step_plan`, while enforcing mode & budget guardrails.
 */
export function resolveStepFromPlan(
  plan: RoutePlan | null | undefined,
  stepNo = 1,
  {
    mode = "balanced",
    hasAttachments = false,
    budget = null,
  }: { mode?: RoutingMode; hasAttachments?: boolean; budget?: TurnBudget | null } = {}
): { tier: RouteTier; thinkingLevel: string; reason: string } | null {
  const stepPlan = Array.isArray(plan?.step_plan) ? plan.step_plan : null;
  if (!stepPlan || stepPlan.length === 0) return null;

  const matched = stepPlan.find(
    (entry) => stepNo >= Number(entry.fromStep) && stepNo <= Number(entry.toStep)
  );
  if (!matched) return null;

  let tier: RouteTier = matched.tier || "fast";
  let thinkingLevel = matched.thinking || "medium";
  const isPureTextChat =
    !plan?.needs_visual &&
    !hasAttachments &&
    (plan?.category === "chat" || plan?.complexity === "trivial");

  if (mode === "quality" && plan?.complexity !== "trivial" && tier === "fast") {
    tier = "standard";
    thinkingLevel = "medium";
  }
  if (mode === "economy" && tier === "deep" && stepNo > 1) {
    tier = "fast";
    thinkingLevel = "xhigh";
  }
  if (tier === "deep" && budget && !budget.canUseDeep()) {
    if (budget.canEscalate()) {
      tier = "fast";
      thinkingLevel = "xhigh";
    } else {
      tier = "standard";
      thinkingLevel = "medium";
    }
  }
  if (tier === "fast" && hasAttachments && thinkingLevel === "low") {
    thinkingLevel = "high";
  }
  if (tier === "fast" && isPureTextChat && thinkingLevel === "low") {
    thinkingLevel = "medium";
  }

  return {
    tier,
    thinkingLevel,
    reason: matched.task || plan?.reason || "",
  };
}

export function tierRank(tier: RouteTier): number {
  return Math.max(0, TIER_ORDER.indexOf(tier));
}

// ---------------- L4 Outcome Stats & Category Bias ----------------

const biasCache = new Map<string, { bias: number; expiresAt: number }>();
const BIAS_TTL_MS = 5 * 60 * 1000;
const MIN_SAMPLES = 8;

export function resetCategoryBiasCache(): void {
  biasCache.clear();
}

/**
 * Computes a tier bias (-0.5 | 0 | +0.5) for a category from recent outcomes.
 */
export function computeCategoryBias(entries: any[] = [], category?: string): number {
  if (!category) return 0;
  const turns = entries.filter((e) => e && e.type !== "feedback" && e.category === category).slice(-50);
  if (turns.length < MIN_SAMPLES) return 0;

  const feedbackSessions = new Set(
    entries
      .filter((e) => e && e.type === "feedback" && e.category === category)
      .map((e) => `${e.sessionId}`)
  );

  const fastStarts = turns.filter((t) => t.baseTier === "fast");
  if (fastStarts.length >= MIN_SAMPLES / 2) {
    const bad = fastStarts.filter(
      (t) =>
        (Array.isArray(t.tierPath) && t.tierPath.some((x: string) => x !== "fast")) ||
        t.status === "error" ||
        t.status === "max_steps" ||
        feedbackSessions.has(`${t.sessionId}`)
    ).length;
    if (bad / fastStarts.length >= 0.4) return 0.5;
  }

  const stdStarts = turns.filter((t) => t.baseTier === "standard");
  if (stdStarts.length >= MIN_SAMPLES) {
    const easy = stdStarts.filter(
      (t) =>
        (t.steps || 0) <= 3 &&
        (t.errors || 0) === 0 &&
        (t.softFailures || 0) === 0 &&
        t.status === "done" &&
        !feedbackSessions.has(`${t.sessionId}`)
    ).length;
    if (easy / stdStarts.length >= 0.8) return -0.5;
  }
  return 0;
}

export function getCategoryBias(store: any, category?: string, now = Date.now()): number {
  if (!category || !store?.readRouteStats) return 0;
  const hit = biasCache.get(category);
  if (hit && hit.expiresAt > now) return hit.bias;
  let bias = 0;
  try {
    bias = computeCategoryBias(store.readRouteStats({ limit: 600 }), category);
  } catch {
    bias = 0;
  }
  biasCache.set(category, { bias, expiresAt: now + BIAS_TTL_MS });
  return bias;
}

export function recordRouteOutcome(store: any, entry: Record<string, any>): void {
  if (!store?.appendRouteStat) return;
  try {
    store.appendRouteStat({ at: new Date().toISOString(), ...entry });
  } catch {
    // stats are best-effort
  }
}

export default {
  ROUTING_MODES,
  MODE_PRESETS,
  DEFAULT_ROUTING_SETTINGS,
  normalizeRoutingSettings,
  createTurnBudget,
  tierFromPlan,
  resolveStepFromPlan,
  tierRank,
  computeCategoryBias,
  getCategoryBias,
  recordRouteOutcome,
  resetCategoryBiasCache,
};
