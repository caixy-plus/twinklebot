/**
 * Automatic 3-Tier Model Router for TwinkleBot (Hydrogen / Argon / Carbon).
 * Dynamically balances speed, visual/engineering precision, and frontier reasoning:
 * - Fast (`gemini-4-hydrogen`): L1 route planner, IM chat/Q&A, routine shell/file/log ops, headless CDP web browsing, mail/schedule/bot handoffs
 * - Standard (`gemini-4-argon`): desktop GUI visual grounding (1440x900), image attachments, screen loops, heavy engineering/scripts, 1st-level error recovery
 * - Deep (`gemini-4-carbon`): complex architecture/debugging/multi-bot orchestration planning, error self-healing, stuck loops
 */

const DESKTOP_INTENT_RE =
  /(点击|双击|右击|拖动|拖拽|滚动|截图|截屏|看.*屏幕|看.*桌面|打开.*浏览器|打开.*应用|打开.*软件|打开.*网页|桌面.*窗口|关闭.*窗口|关掉.*窗口|登录.*页|界面|按钮|click|scroll|drag|screenshot|open_url|firefox|chromium|xfce)/i;

const MAC_HOST_GUI_INTENT_RE =
  /(kimi-?cu|访达|finder|微信|wechat|飞书|lark|钉钉|企业微信|safari|备忘录|系统设置|mac\s*上|宿主机.*(窗口|应用|软件)|你的电脑.*(窗口|应用|软件)|我的电脑.*(窗口|应用|软件)|本机.*(窗口|应用|软件))/i;

// Heavy engineering work that merits Argon directly in heuristic v1 fallback (routine single-step shell/log checks stay on Hydrogen).
const STANDARD_WORK_RE =
  /(全栈|重构|代码.*改造|迁移|并发|多线程|数据库.*设计|统计.*并写|编写.*脚本|python.*脚本|node.*项目|报表.*脚本|批量.*处理|编译|打包|docker.*compose|nginx.*配置|部署.*服务|派生.*bot)/i;

const DEEP_REASONING_RE =
  /(架构|设计方案|重构|深度分析|全面排查|排错|调试|根因|对比分析|多步计划|分步规划|安全审计|漏洞|拉个?群|建个?群|组建.*团队|多个\s*bot|协同|orchestrat|architect|refactor|debug|root\s*cause|audit)/i;

export const DEFAULT_COOLDOWN_MS = 60_000;

export type RouteTier = "fast" | "standard" | "deep";

export interface RouteDecision {
  tier: RouteTier;
  label: string;
  model: string;
  fallbackModel: string;
  thinkingLevel: string;
  timeoutMs: number;
  captureInitialScreen: boolean;
  reason?: string;
}

// modelName -> expiresAt timestamp (ms) or Infinity for permanent 404/unsupported errors
const unavailableUntil = new Map<string, number>();

export function isPermanentModelError(err: any): boolean {
  const msg = String(err?.message || err || "").toLowerCase();
  const status = err?.status ?? err?.statusCode ?? err?.code;
  if (status === 404) return true;
  return (
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("unsupported model") ||
    msg.includes("invalid model") ||
    msg.includes("model is not supported")
  );
}

export function isModelUnavailableError(err: any): boolean {
  if (isPermanentModelError(err)) return true;
  const msg = String(err?.message || err || "").toLowerCase();
  const status = Number(err?.status ?? err?.statusCode ?? err?.code ?? 0);
  if (status === 402 || status === 429 || status === 503 || status === 504) {
    return true;
  }
  return (
    msg.includes("402") ||
    msg.includes("payment required") ||
    msg.includes("insufficient balance") ||
    msg.includes("insufficient_quota") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("overloaded") ||
    msg.includes("resource exhausted")
  );
}

export function markModelUnavailable(
  modelName: string,
  {
    permanent = false,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    now = Date.now(),
  }: { permanent?: boolean; cooldownMs?: number; now?: number } = {}
): void {
  if (!modelName || typeof modelName !== "string") return;
  const expiry = permanent ? Infinity : now + Math.max(1000, cooldownMs);
  const existing = unavailableUntil.get(modelName) || 0;
  if (expiry > existing) {
    unavailableUntil.set(modelName, expiry);
  }
}

export function resetUnavailableModels(): void {
  unavailableUntil.clear();
}

export function isModelAvailable(modelName: string, now = Date.now()): boolean {
  if (!modelName || typeof modelName !== "string") return false;
  const exp = unavailableUntil.get(modelName);
  if (exp === undefined) return true;
  if (exp !== Infinity && now >= exp) {
    unavailableUntil.delete(modelName);
    return true;
  }
  return false;
}

export function hasDesktopIntent(text = ""): boolean {
  return DESKTOP_INTENT_RE.test(String(text || ""));
}

export function hasMacHostGuiIntent(text = ""): boolean {
  return MAC_HOST_GUI_INTENT_RE.test(String(text || ""));
}

export function hasStandardWorkIntent(text = ""): boolean {
  const s = String(text || "").trim();
  if (STANDARD_WORK_RE.test(s)) return true;
  return s.length >= 220;
}

export function hasDeepReasoningIntent(text = ""): boolean {
  const s = String(text || "").trim();
  if (DEEP_REASONING_RE.test(s)) return true;
  return s.length >= 1000;
}

function formatTierBinding(entry: any): string {
  if (!entry) return "";
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "object" && entry.model) {
    const m = String(entry.model).trim();
    const p = String(entry.providerId || "").trim();
    return p ? `${p}::${m}` : m;
  }
  return "";
}

/**
 * Resolves concrete, currently-available models for each tier (honoring 404/429 cooldowns
 * and explicit user 3-tier bindings when configured).
 */
export function resolveTierModels(
  config: Record<string, any> = {},
  now = Date.now(),
  routingSettings: Record<string, any> = {}
): { standard: string; fast: string; deep: string } {
  const tiers = routingSettings?.tiers || config?.routing?.tiers || {};
  const boundFast = formatTierBinding(tiers.fast);
  const boundMedium = formatTierBinding(tiers.medium || tiers.standard);
  const boundAdvanced = formatTierBinding(tiers.advanced || tiers.deep);

  const defaultModel = boundMedium || config.defaultModel || "gemini-4-argon";
  const models: string[] = Array.isArray(config.models) ? config.models : [defaultModel];
  const configuredDeep =
    boundAdvanced || config.deepModel || models.find((m) => m.includes("carbon")) || defaultModel;
  const configuredFast =
    boundFast ||
    config.fastModel ||
    models.find((m) => m.includes("hydrogen")) ||
    models.find((m) => m.includes("flash")) ||
    defaultModel;
  const pickFirstAvailable = (candidates: string[]): string => {
    for (const c of candidates) {
      if (c && isModelAvailable(c, now)) return c;
    }
    return candidates.find(Boolean) || defaultModel;
  };
  return {
    standard: pickFirstAvailable([defaultModel, configuredDeep, configuredFast]),
    fast: pickFirstAvailable([configuredFast, defaultModel, configuredDeep]),
    deep: pickFirstAvailable([configuredDeep, defaultModel, configuredFast]),
  };
}

/**
 * Resolves utility/background models (progress summary, stop intent detector, auto-route fallbacks).
 * Honors explicit `routing.tiers` bindings when configured so users who route tiers away from Gemini
 * do not keep sending silent background calls to hardcoded `gemini-4-*` defaults.
 */
export function resolveUtilityModels(
  config: Record<string, any> = {},
  now = Date.now(),
  routingSettings: Record<string, any> = config?.routing || {}
): { fastModel: string; fallbackModel: string } {
  const tiers = routingSettings?.tiers || {};
  const hasTierBinding = Boolean(
    tiers?.fast?.model ||
      tiers?.medium?.model ||
      tiers?.standard?.model ||
      tiers?.advanced?.model ||
      tiers?.deep?.model
  );
  const resolved = resolveTierModels(config, now, routingSettings);
  if (hasTierBinding) {
    return {
      fastModel: resolved.fast || resolved.standard,
      fallbackModel: resolved.standard || resolved.fast,
    };
  }
  return {
    fastModel: config.thinkingSummaryModel || config.fastModel || "gemini-4-hydrogen",
    fallbackModel: config.defaultModel || "gemini-4-argon",
  };
}

function formatModelRouteLabel(modelName = "", fallback = "轻量全能"): string {
  const raw = String(modelName || "").trim();
  const sep = raw.indexOf("::");
  const clean = sep !== -1 ? raw.slice(sep + 2).trim() : raw;
  const lower = clean.toLowerCase();
  if (lower.includes("carbon")) return "深度旗舰 · Carbon";
  if (lower.includes("argon")) return "性能旗舰 · Argon";
  if (lower.includes("hydrogen")) return "轻量全能 · Hydrogen";
  if (lower.includes("flash")) return "极速对话 · Flash";
  if (clean) return `${fallback} · ${clean}`;
  return fallback;
}

function formatFastLabel(
  fastModel: string,
  _thinkingLevel = "low",
  _visual = false,
  isBotHandoff = false
): string {
  if (isBotHandoff) return "跨 Bot 协同";
  return formatModelRouteLabel(fastModel, "极速档");
}

function fastTimeoutForLevel(level = "low"): number {
  if (level === "xhigh") return 65_000;
  if (level === "high") return 45_000;
  if (level === "medium") return 35_000;
  return 25_000;
}

export interface BuildSmartRouteOptions {
  tier?: RouteTier;
  thinkingLevel?: string;
  reason?: string;
  visual?: boolean;
  captureInitialScreen?: boolean;
  config?: Record<string, any>;
  routingSettings?: Record<string, any>;
  now?: number;
}

/**
 * Smart Router v2: builds a concrete route for a tier decided by the planner (L1) and runtime signals (L2).
 * `reason` is surfaced in the UI so users can see WHY a model was chosen.
 */
export function buildSmartRoute({
  tier = "standard",
  thinkingLevel = "low",
  reason = "",
  visual = false,
  captureInitialScreen = false,
  config = {},
  routingSettings = {},
  now = Date.now(),
}: BuildSmartRouteOptions = {}): RouteDecision {
  const m = resolveTierModels(config, now, routingSettings);
  if (tier === "deep") {
    return {
      tier: "deep",
      label: formatModelRouteLabel(m.deep, "高级档"),
      model: m.deep,
      fallbackModel: m.standard !== m.deep ? m.standard : m.fast,
      thinkingLevel: thinkingLevel || "high",
      timeoutMs: 90_000,
      captureInitialScreen,
      reason,
    };
  }
  if (tier === "standard") {
    return {
      tier: "standard",
      label: formatModelRouteLabel(m.standard, "中等档"),
      model: m.standard,
      fallbackModel: m.fast,
      thinkingLevel: thinkingLevel || "low",
      timeoutMs: 90_000,
      captureInitialScreen,
      reason,
    };
  }
  const fastLevel = thinkingLevel || "low";
  const smartFastTimeout =
    fastLevel === "xhigh" || fastLevel === "high"
      ? 90_000
      : fastTimeoutForLevel(fastLevel);
  return {
    tier: "fast",
    label: formatFastLabel(m.fast, fastLevel, visual, false),
    model: m.fast,
    fallbackModel: m.standard,
    thinkingLevel: fastLevel,
    timeoutMs: smartFastTimeout,
    captureInitialScreen: Boolean(captureInitialScreen),
    reason,
  };
}

export interface SelectRouteOptions {
  userText?: string;
  rawUserText?: string;
  stepNo?: number;
  consecutiveErrors?: number;
  isBotHandoff?: boolean;
  hasAttachments?: boolean;
  hasScreenInHistory?: boolean;
  config?: Record<string, any>;
  routingSettings?: Record<string, any>;
  now?: number;
}

/**
 * Selects the optimal model, thinking level, per-call timeout, and initial-screenshot policy.
 */
export function selectRoute({
  userText = "",
  rawUserText,
  stepNo = 1,
  consecutiveErrors = 0,
  isBotHandoff = false,
  hasAttachments = false,
  hasScreenInHistory = false,
  config = {},
  routingSettings = {},
  now = Date.now(),
}: SelectRouteOptions = {}): RouteDecision {
  const tierResolved = resolveTierModels(config, now, routingSettings);
  const defaultModel = tierResolved.standard || config.defaultModel || "gemini-4-argon";
  const models: string[] = Array.isArray(config.models) ? config.models : [defaultModel];
  const configuredDeep =
    tierResolved.deep ||
    config.deepModel ||
    models.find((m) => m.includes("carbon")) ||
    defaultModel;
  const configuredFast =
    tierResolved.fast ||
    config.fastModel ||
    models.find((m) => m.includes("hydrogen")) ||
    models.find((m) => m.includes("flash")) ||
    defaultModel;

  const pickFirstAvailable = (candidates: string[]): string => {
    for (const c of candidates) {
      if (c && isModelAvailable(c, now)) return c;
    }
    return candidates.find(Boolean) || defaultModel;
  };

  const standardModel = pickFirstAvailable([
    defaultModel,
    configuredDeep,
    configuredFast,
  ]);
  const fastModel = pickFirstAvailable([
    configuredFast,
    defaultModel,
    configuredDeep,
  ]);
  const deepModel = pickFirstAvailable([
    configuredDeep,
    defaultModel,
    configuredFast,
  ]);

  // Evaluate intent against the raw user input (never inflated by group chat history or quote blocks)
  const intentText =
    typeof rawUserText === "string" ? rawUserText : String(userText || "");

  const macGuiIntent = hasMacHostGuiIntent(intentText);
  const ubuntuDesktopIntent =
    (hasDesktopIntent(intentText) && !macGuiIntent) || Boolean(hasAttachments);
  const desktopIntent = ubuntuDesktopIntent || macGuiIntent;
  const visualActive = desktopIntent || Boolean(hasScreenInHistory);
  const deepIntent = hasDeepReasoningIntent(intentText);
  const standardWorkIntent = hasStandardWorkIntent(intentText);

  const isHardErrorRescue =
    consecutiveErrors >= 2 || (stepNo >= 8 && consecutiveErrors >= 1);
  const isInitialDeepPlan = deepIntent && stepNo <= 2;
  const isReplanPulse = stepNo === 10 || stepNo === 18;
  const deepNeeded = isHardErrorRescue || isInitialDeepPlan || isReplanPulse;

  if (deepNeeded) {
    const fallback =
      standardModel !== deepModel ? standardModel : fastModel;
    const isHydrogenFallback = deepModel.includes("hydrogen");
    const thinkingLevel = isHydrogenFallback
      ? "xhigh"
      : isHardErrorRescue || isInitialDeepPlan
        ? "high"
        : "medium";
    return {
      tier: "deep",
      label: formatModelRouteLabel(deepModel, "深度旗舰"),
      model: deepModel,
      fallbackModel: fallback,
      thinkingLevel,
      timeoutMs: 90_000,
      captureInitialScreen: ubuntuDesktopIntent,
    };
  }

  const standardNeeded =
    macGuiIntent ||
    standardWorkIntent ||
    deepIntent ||
    stepNo >= 5 ||
    consecutiveErrors === 1;

  if (standardNeeded) {
    const isHydrogenFallback = standardModel.includes("hydrogen");
    const thinkingLevel = isHydrogenFallback
      ? "xhigh"
      : consecutiveErrors >= 1 || deepIntent
        ? "medium"
        : "low";
    const label = formatModelRouteLabel(standardModel, "性能旗舰");
    return {
      tier: "standard",
      label,
      model: standardModel,
      fallbackModel: fastModel,
      thinkingLevel,
      timeoutMs: 45_000,
      captureInitialScreen: ubuntuDesktopIntent,
    };
  }

  // Fast route (`gemini-4-hydrogen` defaults to Medium thinking tier for pure-text chat & standard steps):
  let thinkingLevel = "medium";
  if (hasAttachments || (visualActive && stepNo >= 3) || stepNo >= 4) {
    thinkingLevel = "high";
  }
  return {
    tier: "fast",
    label: formatFastLabel(fastModel, thinkingLevel, visualActive, isBotHandoff),
    model: fastModel,
    fallbackModel: standardModel,
    thinkingLevel,
    timeoutMs: fastTimeoutForLevel(thinkingLevel),
    captureInitialScreen: ubuntuDesktopIntent,
  };
}

export default {
  selectRoute,
  buildSmartRoute,
  resolveTierModels,
  resolveUtilityModels,
  hasDesktopIntent,
  hasMacHostGuiIntent,
  hasStandardWorkIntent,
  hasDeepReasoningIntent,
  markModelUnavailable,
  resetUnavailableModels,
  isModelAvailable,
  isModelUnavailableError,
  isPermanentModelError,
  DEFAULT_COOLDOWN_MS,
};
