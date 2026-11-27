/**
 * L1 Model-Assisted Execution & Route Planner for TwinkleBot Smart Router v2.
 * At the start of each turn, a Hydrogen High call (`thinkingLevel: "high"`) analyzes
 * the task profile and produces a per-step execution plan specifying which model &
 * thinking level each step should use. Any failure falls back to regex heuristics.
 */
import crypto from "node:crypto";
import type { ModelAdapter, TokenUsage } from "../shared/config.js";
import type { RouteTier } from "./router.js";

// Give Hydrogen High enough headroom to think through multi-step model allocation
export const PLANNER_TIMEOUT_MS = 12000;
const CACHE_MAX = 200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const COMPLEXITIES = new Set(["trivial", "standard", "complex"]);
const RISKS = new Set(["low", "medium", "high"]);
export const ROUTE_CATEGORIES = [
  "chat",
  "qa",
  "ops",
  "coding",
  "gui",
  "data",
  "orchestration",
  "mail",
  "schedule",
  "creative",
  "other",
] as const;
const CATEGORY_SET = new Set<string>(ROUTE_CATEGORIES);

const WORK_HINT_RE =
  /(脚本|代码|日志|服务器|部署|排查|分析|统计|打开|点击|截图|邮件|邮箱|定时|每天|每小时|创建|bot|群|文件|安装|配置|发布|推送|上线|提交|删除|刷新|运行|执行|同步|构建|打包|链接|订阅|检查|重启|切换|查看|发送|为什么|为啥|怎么|如何|帮我|写|查|改|修|画|生成|\?|？|https?:\/\/)/i;

const SIMPLE_FOLLOWUP_RE =
  /^(?:继续|好的|好吧|行|可以|嗯|收到|明白|ok|okay|yes|go\s*on|continue|再来|再试一次)[！!。.~～\s]*$/i;

export interface StepPlanItem {
  fromStep: number;
  toStep: number;
  tier: RouteTier;
  model: string;
  thinking: string;
  task: string;
}

export interface RoutePlan {
  complexity: "trivial" | "standard" | "complex";
  needs_visual: boolean;
  needs_planning: boolean;
  expected_steps: number;
  risk: "low" | "medium" | "high";
  category: string;
  confidence: number;
  reason: string;
  isFollowUp?: boolean;
  step_plan?: readonly StepPlanItem[];
}

// botId::normalizedText -> { plan, expiresAt }
const planCache = new Map<string, { plan: RoutePlan; expiresAt: number }>();

export function resetRoutePlanCache(): void {
  planCache.clear();
}

function cacheKey(botId: string, text: string, recentContext = ""): string {
  const norm = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  const ctxNorm = String(recentContext || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-240)
    .toLowerCase();
  return crypto.createHash("sha1").update(`${botId || "-"}::${ctxNorm}::${norm}`).digest("hex");
}

function cacheGet(key: string, now: number): RoutePlan | null {
  const hit = planCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    planCache.delete(key);
    return null;
  }
  // refresh LRU order
  planCache.delete(key);
  planCache.set(key, hit);
  return hit.plan;
}

function cacheSet(key: string, plan: RoutePlan, now: number): void {
  planCache.set(key, { plan, expiresAt: now + CACHE_TTL_MS });
  while (planCache.size > CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
    else break;
  }
}

/** Obvious small talk (≤ 12 chars, no work hints, no attachments) skips the planner call entirely. */
export function isTrivialChat(
  text = "",
  { hasAttachments = false }: { hasAttachments?: boolean } = {}
): boolean {
  const s = String(text || "").trim();
  if (!s || hasAttachments) return false;
  if (s.length > 12) return false;
  return !WORK_HINT_RE.test(s);
}

/** Short continuation / acknowledgement phrases that need no planner LLM round-trip. */
export function isSimpleFollowUp(
  text = "",
  { hasAttachments = false }: { hasAttachments?: boolean } = {}
): boolean {
  const s = String(text || "").trim();
  if (!s || hasAttachments) return false;
  return SIMPLE_FOLLOWUP_RE.test(s);
}

export const TRIVIAL_PLAN: RoutePlan = Object.freeze({
  complexity: "trivial",
  needs_visual: false,
  needs_planning: false,
  expected_steps: 1,
  risk: "low",
  category: "chat",
  confidence: 0.95,
  reason: "纯文字对话（中档位）",
  step_plan: Object.freeze([
    Object.freeze({
      fromStep: 1,
      toStep: 1,
      tier: "fast" as const,
      model: "hydrogen",
      thinking: "medium",
      task: "纯文字对话直接回复",
    }),
  ]),
});

const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh"]);

function parseStepModelTier(
  rawModel = "",
  rawTier = ""
): { tier: RouteTier; model: string } | null {
  const tierStr = String(rawTier || "").trim().toLowerCase();
  const modelStr = String(rawModel || "").trim().toLowerCase();
  const matchTierToken = (s: string): RouteTier | null => {
    if (!s) return null;
    if (
      s.includes("carbon") ||
      /\bdeep\b/.test(s) ||
      s.includes("advanced") ||
      s.includes("高级")
    ) {
      return "deep";
    }
    if (
      s.includes("argon") ||
      s.includes("standard") ||
      s.includes("medium") ||
      s.includes("中等")
    ) {
      return "standard";
    }
    if (s.includes("hydrogen") || s.includes("fast") || s.includes("极速")) {
      return "fast";
    }
    return null;
  };

  const resolvedTier = matchTierToken(tierStr) || matchTierToken(modelStr);
  if (!resolvedTier) return null;
  const fallbackModel =
    resolvedTier === "deep"
      ? "carbon"
      : resolvedTier === "standard"
        ? "argon"
        : "hydrogen";
  return { tier: resolvedTier, model: rawModel || fallbackModel };
}

function parseStepRange(item: any, fallbackStep: number): { fromStep: number; toStep: number } {
  if (Number.isFinite(Number(item?.fromStep)) || Number.isFinite(Number(item?.from))) {
    const fromStep = Math.max(1, Math.min(30, Math.round(Number(item.fromStep ?? item.from))));
    const rawTo = item.toStep ?? item.to ?? fromStep;
    const toStep = Math.max(fromStep, Math.min(30, Math.round(Number(rawTo) || fromStep)));
    return { fromStep, toStep };
  }
  if (Number.isFinite(Number(item?.step))) {
    const n = Math.max(1, Math.min(30, Math.round(Number(item.step))));
    return { fromStep: n, toStep: n };
  }
  const rangeStr = String(item?.steps ?? item?.step_range ?? "").trim();
  const match = rangeStr.match(/^(\d+)(?:\s*[-~到至]\s*(\d+))?$/);
  if (match) {
    const fromStep = Math.max(1, Math.min(30, Number(match[1])));
    const toStep = Math.max(fromStep, Math.min(30, Number(match[2] || match[1])));
    return { fromStep, toStep };
  }
  return { fromStep: fallbackStep, toStep: fallbackStep };
}

export function normalizeStepPlan(rawSteps: any, expectedSteps = 3): StepPlanItem[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];
  const out: StepPlanItem[] = [];
  let cursor = 1;
  for (const item of rawSteps.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const mapped = parseStepModelTier(item.model, item.tier);
    if (!mapped) continue;
    const { fromStep, toStep } = parseStepRange(item, cursor);
    cursor = Math.min(30, toStep + 1);
    const rawThinking = String(item.thinking || item.thinkingLevel || item.gear || "")
      .trim()
      .toLowerCase();
    const defaultThinking =
      mapped.tier === "deep" ? "high" : mapped.tier === "fast" ? "medium" : "low";
    const thinking = THINKING_LEVELS.has(rawThinking)
      ? mapped.tier !== "fast" && rawThinking === "xhigh"
        ? "high"
        : rawThinking
      : defaultThinking;
    const task = String(item.task || item.purpose || item.action || item.reason || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
    out.push({
      fromStep,
      toStep,
      tier: mapped.tier,
      model: mapped.model,
      thinking,
      task,
    });
  }
  if (out.length === 0) return [];
  if (expectedSteps >= 1 && out[out.length - 1].toStep < expectedSteps) {
    out[out.length - 1].toStep = Math.min(30, Math.round(expectedSteps));
  }
  return out;
}

/**
 * Strictly validates & normalizes a planner JSON object. Returns `null` if invalid.
 */
export function normalizeRoutePlan(raw: any): RoutePlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const complexity = String(raw.complexity || "").toLowerCase();
  if (!COMPLEXITIES.has(complexity)) return null;
  const risk = RISKS.has(String(raw.risk || "").toLowerCase())
    ? (String(raw.risk).toLowerCase() as "low" | "medium" | "high")
    : "low";
  const category = CATEGORY_SET.has(String(raw.category || "").toLowerCase())
    ? String(raw.category).toLowerCase()
    : "other";
  const conf = Number(raw.confidence);
  const steps = Number(raw.expected_steps);
  const expectedSteps = Number.isFinite(steps)
    ? Math.min(Math.max(Math.round(steps), 1), 30)
    : 3;
  const stepPlan = normalizeStepPlan(
    raw.step_plan || raw.execution_plan || raw.steps,
    expectedSteps
  );
  return {
    complexity: complexity as "trivial" | "standard" | "complex",
    needs_visual: raw.needs_visual === true,
    needs_planning: raw.needs_planning === true,
    expected_steps: expectedSteps,
    risk,
    category,
    confidence: Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0.5,
    reason: String(raw.reason || "").replace(/\s+/g, " ").trim().slice(0, 40),
    ...(stepPlan.length > 0 ? { step_plan: stepPlan } : {}),
  };
}

/** Extracts the first balanced `{...}` JSON object from model text output. */
export function extractJsonObject(text = ""): any {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function buildPlannerPrompt({
  rawUserText = "",
  recentContext = "",
  botRole = "",
  hasAttachments = false,
  isScheduledRun = false,
}: {
  rawUserText?: string;
  recentContext?: string;
  botRole?: string;
  hasAttachments?: boolean;
  isScheduledRun?: boolean;
} = {}): string {
  return [
    "You are TwinkleBot's task planner and model router (executed by the fast routing tier). Output ONLY a single JSON object with no explanation or markdown code fences.",
    "TwinkleBot capabilities: running shell commands on the Ubuntu desktop or user's local computer, reading/writing files, browser and GUI automation (which may require screenshots), reading/sending emails, scheduled routines, creating/coordinating multiple Bots, and image generation.",
    "Schema:",
    '{"complexity":"trivial|standard|complex","needs_visual":bool,"needs_planning":bool,"expected_steps":1-30,"risk":"low|medium|high","category":"chat|qa|ops|coding|gui|data|orchestration|mail|schedule|creative|other","confidence":0-1,"reason":"concise Chinese phrase <=20 chars","step_plan":[{"steps":"1-2","model":"hydrogen|argon|carbon","thinking":"low|medium|high|xhigh","task":"concise Chinese goal <=24 chars"}]}',
    "Per-step model allocation rules (for Hydrogen [low/medium/high/xhigh], Argon, and Carbon):",
    "- Pure text chat / general Q&A (category=chat or trivial, requiring no tools, screenshots, or code): always use hydrogen at thinking=medium with a 1-step step_plan (model=hydrogen, thinking=medium).",
    "- standard (routine scripts/ops, multi-step desktop GUI actions and vision, routine data analysis): use hydrogen (medium/high) for steps 1-5; for step 6+, heavy coding, dense charts/PDF reading, or high-risk actions, switch to argon (low/medium) in step_plan.",
    "- complex (system architecture/design, deep root-cause debugging, multi-Bot orchestration, hard algorithms/concurrency): explicitly assign each phase in step_plan — e.g., step 1 on carbon (high) or hydrogen (xhigh) for deep design, subsequent implementation on argon (medium) or hydrogen (high), and final verification on argon/hydrogen.",
    "- Direct frontend/SVG/HTML code drawing & preview (e.g., user asks to draw with code, generate SVG, or write an HTML/Canvas page): the chat UI natively previews ```svg``` / ```html``` blocks directly. NEVER plan opening a desktop browser or taking screenshots (set needs_visual=false, expected_steps=1); for detailed or complex artwork, assign directly to argon (medium) or carbon (high) in 1 step.",
    "- needs_visual: true ONLY when inspecting screen/window pixels or image contents is required. Standard webpage reading, clicking, scrolling, dropdown selection, file upload, or form filling should use screenshot-free browser_snapshot/browser_click/browser_type/browser_scroll/browser_wait/browser_select/browser_upload_file, so set needs_visual=false.",
    "- needs_planning: true when a multi-step plan is needed before acting.",
    "- Scheduled routines (Trigger: scheduled routine): default needs_visual=false unless the prompt explicitly asks to inspect desktop/GUI pixels.",
    "- risk=high: sending emails/messages, deleting data, making payments, or publishing externally.",
    "- When uncertain, lower confidence instead of guessing high.",
    "- Output language for UI display fields: write `reason` (<=20 Chinese chars) and each `step_plan[].task` (<=24 Chinese chars) in concise Chinese.",
    botRole ? `Current Bot role: ${String(botRole).slice(0, 300)}` : "",
    recentContext ? `Recent conversation context:\n${String(recentContext).slice(0, 600)}` : "",
    `Attachments: ${hasAttachments ? "has image/file attachments" : "none"}; Trigger: ${isScheduledRun ? "scheduled routine" : "user message"}`,
    `User request:\n${String(rawUserText || "").slice(0, 1500)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PlanRouteOptions {
  model?: ModelAdapter | null;
  rawUserText?: string;
  recentContext?: string;
  botId?: string;
  botRole?: string;
  hasAttachments?: boolean;
  isScheduledRun?: boolean;
  config?: Record<string, any>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
}

export interface PlanRouteResult {
  plan: RoutePlan | null;
  source: "model" | "cache" | "trivial" | "heuristic";
  latencyMs: number;
  usage?: TokenUsage;
  usedModel?: string;
  error?: string;
}

/**
 * Plans the route for a new turn.
 */
export async function planRoute({
  model,
  rawUserText = "",
  recentContext = "",
  botId = "",
  botRole = "",
  hasAttachments = false,
  isScheduledRun = false,
  config = {},
  signal,
  timeoutMs = PLANNER_TIMEOUT_MS,
  now = Date.now(),
}: PlanRouteOptions = {}): Promise<PlanRouteResult> {
  const started = Date.now();

  // Smart routing requires a planner-capable model; otherwise degrade to v1 heuristics entirely.
  if (!model || typeof model.planTurn !== "function") {
    return { plan: null, source: "heuristic", latencyMs: 0, error: "model has no planTurn" };
  }

  if (isSimpleFollowUp(rawUserText, { hasAttachments })) {
    return {
      plan: { ...TRIVIAL_PLAN, isFollowUp: true, reason: "简短追问（快速直通）" },
      source: "trivial",
      latencyMs: 0,
    };
  }

  if (isTrivialChat(rawUserText, { hasAttachments })) {
    return { plan: { ...TRIVIAL_PLAN }, source: "trivial", latencyMs: 0 };
  }

  const key = cacheKey(
    botId,
    `${isScheduledRun ? "[sched]" : ""}${hasAttachments ? "[att]" : ""}${rawUserText}`,
    isScheduledRun ? "" : recentContext
  );
  const cached = cacheGet(key, now);
  if (cached) {
    return { plan: { ...cached }, source: "cache", latencyMs: 0 };
  }

  const tierFast = config?.routing?.tiers?.fast;
  const boundFast =
    tierFast && typeof tierFast === "object" && tierFast.model
      ? tierFast.providerId
        ? `${tierFast.providerId}::${tierFast.model}`
        : tierFast.model
      : typeof tierFast === "string"
        ? tierFast
        : "";
  const plannerModel =
    config.routerModel ||
    boundFast ||
    config.fastModel ||
    (Array.isArray(config.models) &&
      (config.models.find((m: string) => String(m).includes("hydrogen")) ||
        config.models.find((m: string) => String(m).includes("flash")))) ||
    config.defaultModel;

  const prompt = buildPlannerPrompt({
    rawUserText,
    recentContext,
    botRole,
    hasAttachments,
    isScheduledRun,
  });

  try {
    const timeoutCtrl = new AbortController();
    const combinedSignal =
      signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeoutCtrl.signal])
        : timeoutCtrl.signal;
    const turnPromise = model.planTurn({
      model: plannerModel,
      thinkingLevel: "low",
      timeoutMs,
      systemInstruction:
        "You are an execution planner that outputs strict JSON including per-step model allocation.",
      input: [{ type: "user_input", content: [{ type: "text", text: prompt }] }],
      signal: combinedSignal,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutCtrl.abort();
        reject(new Error("route planner timed out"));
      }, timeoutMs);
    });
    turnPromise.catch(() => {}); // avoid unhandled rejection after abort
    const turn = await Promise.race([turnPromise, timeoutPromise]).finally(() =>
      clearTimeout(timer)
    );

    const plan = normalizeRoutePlan(extractJsonObject(turn?.text || ""));
    const latencyMs = Date.now() - started;
    if (!plan) {
      return {
        plan: null,
        source: "heuristic",
        latencyMs,
        usage: turn?.usage,
        usedModel: turn?.usedModel || plannerModel,
        error: "invalid planner json",
      };
    }
    cacheSet(key, plan, now);
    return {
      plan,
      source: "model",
      latencyMs,
      usage: turn?.usage,
      usedModel: turn?.usedModel || plannerModel,
    };
  } catch (err: any) {
    return {
      plan: null,
      source: "heuristic",
      latencyMs: Date.now() - started,
      error: err?.message || String(err),
    };
  }
}

export default {
  planRoute,
  normalizeRoutePlan,
  extractJsonObject,
  isTrivialChat,
  buildPlannerPrompt,
  resetRoutePlanCache,
  TRIVIAL_PLAN,
  ROUTE_CATEGORIES,
};
