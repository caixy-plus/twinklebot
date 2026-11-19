/**
 * L2 Runtime Route Signals for TwinkleBot Smart Router v2.
 * Tracks per-turn execution health (hard errors, soft failures such as non-zero exit codes,
 * repeated identical calls, no-progress observation loops, and model self-escalation requests)
 * and decides when to escalate (Hydrogen → Argon → Carbon) or step back down.
 */
import crypto from "node:crypto";
import type { RouteTier } from "./router.js";

export const MAX_ESCALATION_REQUESTS = 2;

const OBSERVE_ONLY_TOOLS = new Set([
  "screenshot",
  "list_windows",
  "workspace_search",
  "library_manage",
  "skill_list",
  "list_bots",
]);

export const ROUTE_ESCALATE_TOOL_DECLARATION = {
  type: "function",
  name: "route_escalate",
  description:
    "Request higher reasoning depth or a stronger model for the NEXT step when stuck or tackling a tricky step: need=think: elevate Hydrogen to xhigh thinking without switching models; need=plan: Carbon multi-step plan; need=rescue: diagnose repeated errors; need=visual: switch to Argon for dense chart/document reading or high-precision GUI grounding. Limited to 2 requests per turn and subject to the per-turn budget.",
  parameters: {
    type: "object",
    properties: {
      need: { type: "string", enum: ["think", "plan", "rescue", "visual"] },
      reason: { type: "string", description: "One short sentence on why stronger reasoning is needed." },
    },
    required: ["need", "reason"],
  },
};

export interface RouteRuntime {
  consecutiveErrors: number;
  softFailures: number;
  repeatCount: number;
  lastCallHash: string;
  noProgressSteps: number;
  escalationRequests: number;
  pendingDeepSteps: number;
  pendingDeepReason: string;
  pendingStandard: boolean;
  pendingFastThinking: string;
  deepStepsUsed: number;
  lastStepHadFailure: boolean;
  tierPath: RouteTier[];
  errorsTotal: number;
  softFailuresTotal: number;
  escalationEvents: Array<{ need: string; reason: string }>;
}

export function createRouteRuntime(): RouteRuntime {
  return {
    consecutiveErrors: 0,
    softFailures: 0,
    repeatCount: 0,
    lastCallHash: "",
    noProgressSteps: 0,
    escalationRequests: 0,
    pendingDeepSteps: 0,
    pendingDeepReason: "",
    pendingStandard: false,
    pendingFastThinking: "",
    deepStepsUsed: 0,
    lastStepHadFailure: false,
    tierPath: [],
    errorsTotal: 0,
    softFailuresTotal: 0,
    escalationEvents: [],
  };
}

function hashCall(name: unknown, args: unknown): string {
  let s = "";
  try {
    s = JSON.stringify(args ?? {});
  } catch {
    s = String(args);
  }
  return crypto.createHash("sha1").update(`${name}::${s}`).digest("hex").slice(0, 16);
}

/** Classifies a tool result into `hard` (error), `soft` (non-zero exit / ok:false / unchanged screen), or `ok`. */
export function classifyToolResult(result: any): "hard" | "soft" | "ok" {
  if (!result || typeof result !== "object") return "ok";
  if (result.error) return "hard";
  if (typeof result.exit_code === "number" && result.exit_code !== 0) return "soft";
  if (typeof result.exitCode === "number" && result.exitCode !== 0) return "soft";
  if (result.ok === false) return "soft";
  if (result.screen_changed === false) return "soft";
  return "ok";
}

/** Must be called once at the beginning of each model step (before tools execute). */
export function beginStep(rt: RouteRuntime): void {
  rt.lastStepHadFailure = false;
}

/** Records the outcome of one executed tool call. */
export function recordToolOutcome(
  rt: RouteRuntime,
  { name = "", args = {}, result = undefined }: { name?: string; args?: unknown; result?: any } = {}
): "hard" | "soft" | "ok" {
  const kind = classifyToolResult(result);
  if (kind === "hard") {
    rt.consecutiveErrors += 1;
    rt.errorsTotal += 1;
    rt.lastStepHadFailure = true;
  } else {
    rt.consecutiveErrors = 0;
  }
  if (kind === "soft") {
    rt.softFailures += 1;
    rt.softFailuresTotal += 1;
    rt.lastStepHadFailure = true;
  } else if (kind === "ok") {
    rt.softFailures = 0;
  }

  const h = hashCall(name, args);
  rt.repeatCount = h === rt.lastCallHash ? rt.repeatCount + 1 : 0;
  rt.lastCallHash = h;

  rt.noProgressSteps = OBSERVE_ONLY_TOOLS.has(name) ? rt.noProgressSteps + 1 : 0;
  return kind;
}

export interface TurnBudgetLike {
  canUseDeep(): boolean;
  canEscalate(): boolean;
}

/**
 * Handles a `route_escalate` tool call. Returns the tool result handed back to the model.
 */
export function requestEscalation(
  rt: RouteRuntime,
  { need = "plan", reason = "" }: { need?: string; reason?: string } = {},
  { budget, deepCap }: { budget?: TurnBudgetLike; deepCap?: number } = {}
) {
  if (rt.escalationRequests >= MAX_ESCALATION_REQUESTS) {
    return { ok: true, granted: false, reason: `本轮升档申请已达上限（${MAX_ESCALATION_REQUESTS} 次），请用当前模型继续` };
  }
  rt.escalationRequests += 1;
  if (need === "think") {
    if (budget && !budget.canEscalate()) {
      return { ok: true, granted: false, reason: "本轮预算已达上限，请用当前档位继续" };
    }
    rt.pendingFastThinking = "xhigh";
    rt.escalationEvents.push({ need, reason });
    return { ok: true, granted: true, nextTier: "fast", thinkingLevel: "xhigh", reason: "下一步升级 Hydrogen XHigh 极限推理" };
  }
  if (need === "visual") {
    rt.pendingStandard = true;
    rt.escalationEvents.push({ need, reason });
    return { ok: true, granted: true, nextTier: "standard", reason: "下一步切换到视觉工程主力 Argon" };
  }
  if (budget && !budget.canUseDeep()) {
    // When Carbon budget is capped at 80%, fall back to Hydrogen XHigh if budget remains
    if (budget.canEscalate()) {
      rt.pendingFastThinking = "xhigh";
      rt.escalationEvents.push({ need, reason });
      return { ok: true, granted: true, nextTier: "fast", thinkingLevel: "xhigh", reason: "已触发深度预算保护，改用 Hydrogen XHigh 极限推理" };
    }
    return { ok: true, granted: false, reason: "本轮预算已接近上限，无法升级到深度推理，请用当前模型继续" };
  }
  if (typeof deepCap === "number" && rt.deepStepsUsed >= deepCap) {
    return { ok: true, granted: false, reason: "本轮深度推理步数已用完，请用当前模型继续" };
  }
  rt.pendingDeepSteps = Math.max(rt.pendingDeepSteps, 1);
  rt.pendingDeepReason = need === "rescue" ? "模型申请救援" : "模型申请规划";
  rt.escalationEvents.push({ need, reason });
  return { ok: true, granted: true, nextTier: "deep", reason: "下一步切换到深度推理模型" };
}

export interface EscalationDecision {
  tier: RouteTier;
  reason: string;
  thinkingLevel?: string;
  nudge?: string;
  promoteBase?: boolean;
}

/**
 * Decides whether the NEXT step must deviate from the base tier.
 */
export function decideEscalation(
  rt: RouteRuntime,
  { baseTier = "standard", budget, deepCap = 3 }: { baseTier?: RouteTier; budget?: TurnBudgetLike; deepCap?: number } = {}
): EscalationDecision | null {
  const deepAllowed = (!budget || budget.canUseDeep()) && rt.deepStepsUsed < deepCap;
  const rescueAllowed = !budget || budget.canUseDeep();
  const canSubstituteXhigh = baseTier === "fast" && (!budget || budget.canEscalate());

  // 1. Hard rescue: 2+ consecutive hard errors or soft failures (bypasses deepCap, still budget-bound)
  if (rt.consecutiveErrors >= 2 || rt.softFailures >= 2) {
    if (rescueAllowed) {
      return { tier: "deep", reason: "连续失败 · Carbon 救援", thinkingLevel: "high" };
    }
    if (canSubstituteXhigh) {
      return { tier: "fast", reason: "预算保护 · Hydrogen XHigh 救援", thinkingLevel: "xhigh" };
    }
  }

  // 2. Repeated identical call → one-shot re-plan with a nudge
  if (rt.repeatCount >= 2) {
    if (deepAllowed) {
      return {
        tier: "deep",
        reason: "重复操作 · 重新规划",
        thinkingLevel: "high",
        nudge: "Warning: You have repeated the exact same action multiple times with no progress. Try a different approach or explain the blocker directly to the user.",
      };
    }
    if (canSubstituteXhigh && !budget?.canUseDeep?.()) {
      return {
        tier: "fast",
        reason: "预算保护 · Hydrogen XHigh 重规划",
        thinkingLevel: "xhigh",
        nudge: "Warning: You have repeated the exact same action multiple times with no progress. Try a different approach or explain the blocker directly to the user.",
      };
    }
  }

  // 3. No progress (observation-only loop)
  if (rt.noProgressSteps >= 4 && deepAllowed) {
    return { tier: "deep", reason: "无进展 · 重新规划", thinkingLevel: "medium" };
  }

  // 4. Pending deep steps (initial planning or model self-request)
  if (rt.pendingDeepSteps > 0 && deepAllowed) {
    return { tier: "deep", reason: rt.pendingDeepReason || "深度规划", thinkingLevel: "high" };
  }

  // 5. Hydrogen requested XHigh thinking self-elevation
  if (rt.pendingFastThinking) {
    return { tier: "fast", reason: "Hydrogen 极限推理", thinkingLevel: rt.pendingFastThinking };
  }

  // 6. Hydrogen had a failure → step up to Argon for the rest of the turn (never jump Hydrogen → Carbon directly)
  if (baseTier === "fast" && (rt.lastStepHadFailure || rt.consecutiveErrors >= 1 || rt.softFailures >= 1)) {
    return { tier: "standard", reason: "执行受阻 · 升级 Argon", thinkingLevel: "medium", promoteBase: true };
  }

  // 7. Visual self-request
  if (rt.pendingStandard && baseTier === "fast") {
    return { tier: "standard", reason: "模型申请视觉 · 切换 Argon", thinkingLevel: "low", promoteBase: true };
  }

  // 8. Single recoverable failure on Argon → medium thinking, same tier
  if (baseTier !== "fast" && (rt.consecutiveErrors === 1 || rt.softFailures === 1)) {
    return { tier: baseTier, reason: "错误恢复", thinkingLevel: "medium" };
  }

  return null;
}

/** Must be called after a model step was executed with the given tier. */
export function commitStepTier(rt: RouteRuntime, tier: RouteTier): void {
  rt.tierPath.push(tier);
  if (tier === "fast" && rt.pendingFastThinking) {
    rt.pendingFastThinking = "";
  }
  if (tier === "deep") {
    rt.deepStepsUsed += 1;
    if (rt.pendingDeepSteps > 0) rt.pendingDeepSteps -= 1;
    // After a rescue/re-plan, reset loop detectors so we do not immediately re-trigger
    rt.repeatCount = 0;
    rt.noProgressSteps = 0;
    if (rt.consecutiveErrors >= 2) rt.consecutiveErrors = 1;
    if (rt.softFailures >= 2) rt.softFailures = 1;
  }
  if (tier === "standard") rt.pendingStandard = false;
}

/** Compresses a tier path into a readable label, e.g. `Hydrogen → Argon → Carbon×2 → Argon`. */
export function formatTierPath(path: RouteTier[] = []): string {
  const names: Record<string, string> = { fast: "Hydrogen", standard: "Argon", deep: "Carbon" };
  const out: Array<{ name: string; count: number }> = [];
  for (const t of path) {
    const n = names[t] || t;
    const last = out[out.length - 1];
    if (last && last.name === n) last.count += 1;
    else out.push({ name: n, count: 1 });
  }
  return out.map((s) => (s.count > 1 ? `${s.name}×${s.count}` : s.name)).join(" → ");
}

export default {
  createRouteRuntime,
  beginStep,
  recordToolOutcome,
  requestEscalation,
  decideEscalation,
  commitStepTier,
  classifyToolResult,
  formatTierPath,
  ROUTE_ESCALATE_TOOL_DECLARATION,
  MAX_ESCALATION_REQUESTS,
};
