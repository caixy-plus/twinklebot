import type { ModelAdapter } from "../shared/config.js";
import {
  VALID_MEMORY_CATEGORIES,
  normalizeMemoryCategory,
  normalizeMemorySettings,
  type MemoryCategory,
} from "../shared/entities.js";
import { resolveUtilityModels } from "./router.js";

export { VALID_MEMORY_CATEGORIES, normalizeMemoryCategory };

export interface ExtractedMemoryCandidate {
  op?: "add" | "update";
  targetId?: string;
  scope: "bot" | "global";
  category: MemoryCategory;
  name: string;
  content: string;
  confidence: number;
}

export const DEFAULT_MEMORY_EXTRACT_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_AUTO_EXTRACT_CONFIDENCE = 0.88;
const MAX_AUTO_MEMORY_CONTENT_CHARS = 220;
const MAX_EXISTING_MEMORY_INDEX = 80;

const lastMemoryExtractedBySession = new Map<string, number>();

export function resetMemoryExtractionCooldownForTests(): void {
  lastMemoryExtractedBySession.clear();
}

const EXPLICIT_MEMORY_ZH_RE =
  /(记住|记一下|帮我记|记下来|存到记忆|存入记忆|加入记忆|加到记忆|写入记忆|更新记忆|修改记忆|保存到记忆|以后都|以后请|以后每次|从现在开始.{0,12}都|别忘了我|请记住)/;
const EXPLICIT_MEMORY_EN_RE =
  /\b(remember\s+(that|to|my|i|this)|save\s+(this\s+)?to\s+(my\s+)?memor(y|ies)|add\s+(this\s+)?to\s+(my\s+)?memor(y|ies)|keep\s+in\s+mind|from\s+now\s+on|always\s+(use|reply|respond|format|send|write))\b/i;

const SIGNAL_MEMORY_ZH_RE =
  /(?:我(?:平时|一般|通常|习惯|喜欢|不喜欢|偏好|固定|主要|常用|叫|是做)|叫我|称呼我|别再|不要再|以后(?:都|请|统一|默认|别|不要|.{0,12}(?:改成|换成|用|按))|每次(?:都|请|统一)|默认(?:输出|回复|按|使用.{0,6}(?:格式|风格|模板|语言))|(?:回答|输出|回复|周报|日报|注释|排版).{0,8}(?:默认|统一|一律|都要|请用|改成))/;
const SIGNAL_MEMORY_EN_RE =
  /\b(?:call\s+me|my\s+name\s+is|i\s+(?:always|never|usually|typically)\s+(?:prefer|use|write|want)|my\s+(?:preference|timezone|preferred)|stop\s+using|don't\s+use\s+.{1,24}\s+anymore|from\s+now\s+on|always\s+(?:reply|respond|format|use|write))\b/i;

const QUESTION_LIKE_END_RE = /(?:吗|呢|[?？])[！!。.\s]*$/i;

const IMPLICIT_CORRECTION_RE =
  /(以后|每次|默认|总是|永远|一律|改成|换成|不要再|别再|不对|错了|偏好|instead|next time|from now on|every time|always|don't use|prefer)/i;
const DURABLE_SCOPE_CUE_RE =
  /(以后|每次|默认|总是|永远|一律|长期|一直|always|from now on|every time|permanently)/i;

const TRIVIAL_UTTERANCE_RE =
  /^(你好|您好|嗨|哈喽|在吗|好的|好|行|ok|okay|yes|no|thanks|thank you|谢谢|收到|嗯|嗯嗯|明白了|继续|开始|可以|没问题)[！!。.?？\s]*$/i;

const SECRET_LIKE_RE =
  /(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN\s+[A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,}|(?:password|passwd|api[_-]?key|secret[_-]?key|授权码|密码)\s*[:：=]\s*\S{6,})/i;

export function looksLikeSecretMemory(text: unknown): boolean {
  return SECRET_LIKE_RE.test(String(text || ""));
}

const POISONED_TOOL_MEMORY_RE =
  /(?:server-bundle\.mjs|dist-server\/|(?:不要再(?:用|使用)|不要(?:用|使用)|别再(?:用|使用)|禁用|禁止使用|never use|do not use|avoid using)\s*[`"'「]?(?:send_file|generate_image|schedule_manage|memory_manage|vault_manage|web_search|web_fetch|browser_snapshot|browser_click|browser_type|host_run_shell))/i;

export function looksLikePoisonedToolMemory(text: unknown): boolean {
  return POISONED_TOOL_MEMORY_RE.test(String(text || ""));
}

export function hasExplicitMemoryIntent(userText: unknown): boolean {
  const text = String(userText || "").trim();
  if (!text) return false;
  return EXPLICIT_MEMORY_ZH_RE.test(text) || EXPLICIT_MEMORY_EN_RE.test(text);
}

export function shouldRunMemoryExtraction(
  userText: unknown,
  assistantText: unknown = "",
  opts: { memorySettings?: unknown } = {}
): boolean {
  const text = String(userText || "").trim();
  if (!text || text.length < 6) return false;
  if (text.startsWith("[例行任务")) return false;
  if (TRIVIAL_UTTERANCE_RE.test(text)) return false;
  // Skip pure URL / command dumps that have no personal preference context
  if (/^https?:\/\/\S+$/i.test(text)) return false;

  const explicit = hasExplicitMemoryIntent(text);
  const autoMode = normalizeMemorySettings(opts?.memorySettings).autoMode;
  if (autoMode === "explicit_only" && !explicit) {
    return false;
  }
  if (!explicit && QUESTION_LIKE_END_RE.test(text)) {
    return false;
  }

  if (explicit || SIGNAL_MEMORY_ZH_RE.test(text) || SIGNAL_MEMORY_EN_RE.test(text)) {
    return true;
  }

  // Only trigger background extraction for longer messages that carry BOTH a standing/durable cue and a correction
  const hasAssistantReply = String(assistantText || "").trim().length >= 8;
  return (
    text.length >= 40 &&
    hasAssistantReply &&
    DURABLE_SCOPE_CUE_RE.test(text) &&
    IMPLICIT_CORRECTION_RE.test(text)
  );
}

export function normalizeMemoryText(s: unknown): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function bigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const gramsA = new Set<string>();
  const gramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) gramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) gramsB.add(b.slice(i, i + 2));
  let inter = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) inter += 1;
  }
  const union = gramsA.size + gramsB.size - inter;
  return union > 0 ? inter / union : 0;
}

export function findDuplicateMemory(list: any[], candidateContent: string): any | null {
  const normCand = normalizeMemoryText(candidateContent);
  if (!normCand) return null;
  for (const item of list) {
    const existingText =
      typeof item === "string"
        ? item
        : item?.instruction || item?.content || item?.desc || "";
    const normExist = normalizeMemoryText(existingText);
    if (!normExist) continue;
    if (normCand === normExist) return item;
    if (
      normCand.length >= 8 &&
      normExist.length >= 8 &&
      (normCand.includes(normExist) || normExist.includes(normCand))
    ) {
      return item;
    }
    if (bigramJaccard(normCand, normExist) >= 0.68) {
      return item;
    }
  }
  return null;
}

function parseJsonPayload(rawText: string): any {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface ExtractMemoryCandidatesOptions {
  model?: ModelAdapter | null;
  userText: string;
  assistantText?: string;
  botName?: string;
  botMemories?: any[];
  globalMemories?: any[];
  recentSuggestedContents?: string[];
  config?: Record<string, any>;
  timeoutMs?: number;
  onUsage?: (info: { model: string; providerId?: string | null; usage: any }) => void;
}

export async function extractMemoryCandidates({
  model = null,
  userText,
  assistantText = "",
  botName = "Twinkle",
  botMemories = [],
  globalMemories = [],
  recentSuggestedContents = [],
  config = {},
  timeoutMs = 9000,
  onUsage,
}: ExtractMemoryCandidatesOptions): Promise<ExtractedMemoryCandidate[]> {
  if (!model || typeof model.summarizeTurn !== "function") return [];
  if (!shouldRunMemoryExtraction(userText, assistantText, { memorySettings: config?.memorySettings })) {
    return [];
  }

  const { fastModel: targetModel, fallbackModel } = resolveUtilityModels(config);
  const existingCombined = [
    ...botMemories.map((m, idx) => ({
      id: String(m?.id || `bot-${idx}`),
      scope: "bot" as const,
      category: normalizeMemoryCategory(m?.category),
      text: `${m?.name || ""}: ${m?.instruction || m?.content || m?.desc || ""}`,
    })),
    ...globalMemories.map((m, idx) => ({
      id: String(m?.id || `global-${idx}`),
      scope: "global" as const,
      category: normalizeMemoryCategory(m?.category),
      text: `${m?.name || ""}: ${m?.instruction || m?.content || m?.desc || ""}`,
    })),
  ].filter((x) => x.text.trim().length > 2);

  const existingBlock =
    existingCombined.length > 0
      ? existingCombined
          .slice(0, MAX_EXISTING_MEMORY_INDEX)
          .map((x) => `- [id:${x.id}][${x.scope}][${x.category}] ${x.text}`)
          .join("\n")
      : "(none)";

  const prompt = [
    `Analyze the latest single conversation turn between the user and assistant "${botName}".`,
    "Extract AT MOST 2 high-value, long-term, cross-session user preferences, identity facts, or standing output/workflow rules that genuinely improve future sessions.",
    "",
    "STRICT EXCLUSIONS (return {\"operations\": []} if none apply):",
    "- One-off task instructions, temporary file paths, single-session debugging details, or ephemeral questions.",
    "- Anything already covered by Existing Memories below (unless the user explicitly changed/updated an existing rule — then use op:\"update\" with targetId!).",
    "- Passwords, API keys, tokens, or secrets (never store secrets in memory).",
    "- Speculative inferences from inspecting bundled source code (e.g. server-bundle.mjs) or rules forbidding/overriding built-in TwinkleBot tools (e.g. send_file, schedule_manage, memory_manage).",
    "- Speculative guesses not clearly stated or confirmed by the user.",
    "",
    "Choose scope & category:",
    "- scope: \"global\" (universal user identity/preferences across all Bots) or \"bot\" (specific to this Bot's role).",
    "- category: \"identity\" (name, role, contact/org), \"preference\" (tone, language, format habits), \"rule\" (strict standing constraints), \"context\" (long-term project/domain facts), or \"general\".",
    "- op: \"add\" for genuinely new facts, or \"update\" + \"targetId\" (exact id from Existing Memories) when replacing/refining an existing conflicting entry.",
    "",
    "Output STRICT JSON ONLY with no markdown prose (uses `operations` schema, replacing legacy `candidates`):",
    '{"operations":[{"op":"add"|"update","targetId":"optional existing id","scope":"bot"|"global","category":"identity"|"preference"|"rule"|"context"|"general","name":"short title <=18 chars","content":"concise durable rule/fact <=200 chars","confidence":0.0-1.0}]}',
    "",
    "Existing Memories:",
    existingBlock,
    "",
    `User message:\n${String(userText).slice(0, 1200)}`,
    assistantText ? `\nAssistant reply excerpt:\n${String(assistantText).slice(0, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const timeoutCtrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turnPromise = model.summarizeTurn({
      model: targetModel,
      fallbackModel,
      thinkingLevel: "low",
      timeoutMs,
      systemInstruction:
        "You are a precision memory extractor and governor. Return strict JSON only (`{\"operations\": [...]}`). Prefer returning an empty array over saving low-value, transient, or duplicate details; prefer `update` with `targetId` over adding conflicting entries.",
      input: [{ type: "user_input", content: [{ type: "text", text: prompt }] }],
      signal: timeoutCtrl.signal,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutCtrl.abort();
        reject(new Error("memory extraction timed out"));
      }, timeoutMs);
    });
    turnPromise.catch(() => {});
    const turn = await Promise.race([turnPromise, timeoutPromise]).finally(() =>
      clearTimeout(timer)
    );

    if (turn?.usage && typeof onUsage === "function") {
      try {
        onUsage({
          model: turn.usedModel || targetModel,
          providerId: turn.usedProviderId || null,
          usage: turn.usage,
        });
      } catch {
        // ignore accounting callback failure
      }
    }

    const parsed = parseJsonPayload(turn?.text || "");
    const rawList = Array.isArray(parsed?.operations)
      ? parsed.operations
      : Array.isArray(parsed?.candidates)
        ? parsed.candidates
        : [];
    const dedupPool: any[] = [
      ...botMemories,
      ...globalMemories,
      ...recentSuggestedContents,
    ];
    const existingIdsByScope = {
      bot: new Set(botMemories.map((m) => String(m?.id || "")).filter(Boolean)),
      global: new Set(globalMemories.map((m) => String(m?.id || "")).filter(Boolean)),
    };
    const accepted: ExtractedMemoryCandidate[] = [];

    for (const item of rawList) {
      if (accepted.length >= 2) break;
      if (!item || typeof item !== "object") continue;
      const content = String(item.content || "").trim();
      const name =
        String(item.name || "").trim().slice(0, 24) ||
        content.replace(/\s+/g, " ").slice(0, 18);
      const scope: "bot" | "global" = item.scope === "global" ? "global" : "bot";
      const category = normalizeMemoryCategory(item.category);
      const confidence = Number(item.confidence);
      const targetId = typeof item.targetId === "string" ? item.targetId.trim() : "";
      const isValidUpdate =
        item.op === "update" && Boolean(targetId && existingIdsByScope[scope].has(targetId));
      const op: "add" | "update" = isValidUpdate ? "update" : "add";

      if (!content || content.length < 4 || content.length > MAX_AUTO_MEMORY_CONTENT_CHARS) continue;
      if (looksLikeSecretMemory(content) || looksLikeSecretMemory(name)) continue;
      if (looksLikePoisonedToolMemory(content) || looksLikePoisonedToolMemory(name)) continue;
      if (Number.isFinite(confidence) && confidence < MIN_AUTO_EXTRACT_CONFIDENCE) continue;
      if (op === "add") {
        if (findDuplicateMemory(dedupPool, content)) continue;
        dedupPool.push({ content });
      }
      accepted.push({
        op,
        ...(op === "update" ? { targetId } : {}),
        scope,
        category,
        name,
        content,
        confidence: Number.isFinite(confidence) ? confidence : 0.9,
      });
    }

    return accepted;
  } catch {
    return [];
  }
}

export async function runPostTurnMemoryExtraction({
  store,
  model,
  sessionId,
  botSession,
  userText,
  assistantText,
  config = {},
  nowMs,
  cooldownMs = DEFAULT_MEMORY_EXTRACT_COOLDOWN_MS,
  emit,
  onUsage,
  broadcastGlobal,
}: {
  store: any;
  model?: ModelAdapter | null;
  sessionId: string;
  botSession?: any;
  userText: string;
  assistantText: string;
  config?: Record<string, any>;
  nowMs?: number;
  cooldownMs?: number;
  emit?: (evt: Record<string, any>) => void;
  onUsage?: (info: { model: string; providerId?: string | null; usage: any }) => void;
  broadcastGlobal?: (evt: Record<string, any>) => void;
}): Promise<ExtractedMemoryCandidate[]> {
  if (!store || !sessionId) return [];
  const latestSettings = store.readSettings?.() || {};
  const effectiveMemorySettings = normalizeMemorySettings(
    config?.memorySettings ?? latestSettings?.memorySettings
  );
  const explicit = hasExplicitMemoryIntent(userText);
  if (effectiveMemorySettings.autoMode === "explicit_only" && !explicit) {
    return [];
  }

  const effectiveNowMs = typeof nowMs === "number" ? nowMs : Date.now();
  const lastMs = lastMemoryExtractedBySession.get(sessionId) || 0;
  if (!explicit && cooldownMs > 0 && lastMs > 0 && effectiveNowMs - lastMs < cooldownMs) {
    return [];
  }

  const latestSession = store.getSession?.(sessionId) || botSession || null;
  const botMemories = Array.isArray(latestSession?.memories) ? [...latestSession.memories] : [];
  const globalMemories = Array.isArray(latestSettings.globalMemories)
    ? [...latestSettings.globalMemories]
    : Array.isArray(latestSettings.privateSkills)
      ? [...latestSettings.privateSkills]
      : [];

  if (
    !shouldRunMemoryExtraction(userText, assistantText, {
      memorySettings: effectiveMemorySettings,
    })
  ) {
    return [];
  }
  if (!explicit) {
    lastMemoryExtractedBySession.set(sessionId, effectiveNowMs);
  }

  const candidates = await extractMemoryCandidates({
    model,
    userText,
    assistantText,
    botName: latestSession?.title || "Twinkle",
    botMemories,
    globalMemories,
    config: { ...config, memorySettings: effectiveMemorySettings },
    onUsage: (info) => {
      if (typeof emit === "function" && info?.usage) {
        emit({
          type: "usage",
          model: info.model,
          ...(info.providerId ? { providerId: info.providerId } : {}),
          routeTier: "memory",
          routeLabel: "记忆提炼",
          input: info.usage.input ?? 0,
          output: info.usage.output ?? 0,
          ...(info.usage.cached ? { cached: info.usage.cached } : {}),
          ...(info.usage.thoughts ? { thoughts: info.usage.thoughts } : {}),
        });
      }
      if (typeof onUsage === "function") {
        onUsage(info);
      }
    },
  });

  if (candidates.length === 0) return [];

  // Re-read freshest store state before persisting silently to prevent races or duplicates
  const freshSession = store.getSession?.(sessionId) || null;
  if (store.getSession && !freshSession) return [];
  const freshSettings = store.readSettings?.() || {};
  const nextBotList = Array.isArray(freshSession?.memories) ? [...freshSession.memories] : [];
  const nextGlobalList = Array.isArray(freshSettings.globalMemories)
    ? [...freshSettings.globalMemories]
    : Array.isArray(freshSettings.privateSkills)
      ? [...freshSettings.privateSkills]
      : [];

  const saved: ExtractedMemoryCandidate[] = [];
  let botChanged = false;
  let globalChanged = false;

  for (const cand of candidates) {
    const targetScope: "bot" | "global" =
      cand.scope === "global" || !freshSession ? "global" : "bot";
    const targetList = targetScope === "bot" ? nextBotList : nextGlobalList;
    const nowIso = new Date().toISOString();

    if (cand.op === "update" && cand.targetId) {
      const idx = targetList.findIndex((m) => m && String(m.id || "") === cand.targetId);
      if (idx >= 0) {
        const prev = targetList[idx];
        const { desc: _d, instruction: _i, ...restPrev } = prev || {};
        targetList[idx] = {
          ...restPrev,
          name: cand.name || prev.name,
          content: cand.content,
          category: cand.category || normalizeMemoryCategory(prev?.category),
          source: prev?.source || "auto",
          updatedAt: nowIso,
        };
        if (targetScope === "bot") botChanged = true;
        else globalChanged = true;
        saved.push({ ...cand, scope: targetScope });
        continue;
      }
    }

    if (findDuplicateMemory([...nextBotList, ...nextGlobalList], cand.content)) {
      continue;
    }
    const entry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: cand.name,
      content: cand.content,
      category: cand.category || "general",
      enabled: true,
      source: "auto",
      updatedAt: nowIso,
    };
    if (targetScope === "bot") {
      nextBotList.unshift(entry);
      botChanged = true;
    } else {
      nextGlobalList.unshift(entry);
      globalChanged = true;
    }
    saved.push({ ...cand, op: "add", scope: targetScope });
  }

  if (botChanged && freshSession) {
    const updatedSession = store.updateSession?.(freshSession.id, {
      memories: nextBotList,
      touch: false,
    });
    broadcastGlobal?.({
      type: "session_updated",
      sessionId: freshSession.id,
      session: updatedSession || { ...freshSession, memories: nextBotList },
    });
  }
  if (globalChanged) {
    store.writeSettings?.({
      globalMemories: nextGlobalList,
      privateSkills: [],
    });
    broadcastGlobal?.({ type: "skills_updated" });
  }

  return saved;
}
