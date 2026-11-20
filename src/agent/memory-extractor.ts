import type { ModelAdapter } from "../shared/config.js";
import { resolveUtilityModels } from "./router.js";

export interface ExtractedMemoryCandidate {
  scope: "bot" | "global";
  name: string;
  content: string;
  confidence: number;
}

const EXPLICIT_MEMORY_ZH_RE =
  /(记住|记一下|帮我记|记下来|存到记忆|存入记忆|加入记忆|加到记忆|写入记忆|更新记忆|修改记忆|保存到记忆|以后都|以后请|以后每次|从现在开始.{0,12}都|别忘了我|请记住)/;
const EXPLICIT_MEMORY_EN_RE =
  /\b(remember\s+(that|to|my|i|this)|save\s+(this\s+)?to\s+(my\s+)?memor(y|ies)|add\s+(this\s+)?to\s+(my\s+)?memor(y|ies)|keep\s+in\s+mind|from\s+now\s+on|always\s+(use|reply|respond|format|send|write))\b/i;

const SIGNAL_MEMORY_ZH_RE =
  /(我喜欢|我不喜欢|我习惯|我是|我在|我的|习惯|偏好|默认|不要用|别再用|别再|下次|每次|固定|称呼|叫我|邮箱|时区|语言|格式|风格|公司|团队|老板|同事|周报|日报|模板|常用|一般用)/;
const SIGNAL_MEMORY_EN_RE =
  /\b(prefer|preference|my name|call me|i am|i'm|i work|my team|my boss|my email|timezone|always|never|don't use|stop using|format|style|tone|language|default)\b/i;

const TRIVIAL_UTTERANCE_RE =
  /^(你好|您好|嗨|哈喽|在吗|好的|好|行|ok|okay|yes|no|thanks|thank you|谢谢|收到|嗯|嗯嗯|明白了|继续|开始|可以|没问题)[！!。.?？\s]*$/i;

export function hasExplicitMemoryIntent(userText: unknown): boolean {
  const text = String(userText || "").trim();
  if (!text) return false;
  return EXPLICIT_MEMORY_ZH_RE.test(text) || EXPLICIT_MEMORY_EN_RE.test(text);
}

export function shouldRunMemoryExtraction(userText: unknown, assistantText: unknown = ""): boolean {
  const text = String(userText || "").trim();
  if (!text || text.length < 6) return false;
  if (text.startsWith("[例行任务")) return false;
  if (TRIVIAL_UTTERANCE_RE.test(text)) return false;
  // Skip pure URL / command dumps that have no personal preference context
  if (/^https?:\/\/\S+$/i.test(text)) return false;

  if (
    hasExplicitMemoryIntent(text) ||
    SIGNAL_MEMORY_ZH_RE.test(text) ||
    SIGNAL_MEMORY_EN_RE.test(text)
  ) {
    return true;
  }

  // Allow longer natural-language messages that may contain implicit preferences/corrections
  const hasAssistantReply = String(assistantText || "").trim().length >= 8;
  return text.length >= 24 && hasAssistantReply;
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
    if (bigramJaccard(normCand, normExist) >= 0.75) {
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
}: ExtractMemoryCandidatesOptions): Promise<ExtractedMemoryCandidate[]> {
  if (!model || typeof model.summarizeTurn !== "function") return [];
  if (!shouldRunMemoryExtraction(userText, assistantText)) return [];

  const { fastModel: targetModel, fallbackModel } = resolveUtilityModels(config);
  const existingCombined = [
    ...botMemories.map((m) => ({
      scope: "bot",
      text: `${m?.name || ""}: ${m?.instruction || m?.content || m?.desc || ""}`,
    })),
    ...globalMemories.map((m) => ({
      scope: "global",
      text: `${m?.name || ""}: ${m?.instruction || m?.content || m?.desc || ""}`,
    })),
  ].filter((x) => x.text.trim().length > 2);

  const existingBlock =
    existingCombined.length > 0
      ? existingCombined
          .slice(0, 30)
          .map((x) => `- [${x.scope}] ${x.text}`)
          .join("\n")
      : "(none)";

  const prompt = [
    `Analyze the latest single conversation turn between the user and assistant "${botName}".`,
    "Extract AT MOST 2 high-value, long-term, cross-session user preferences, identity facts, recurring formatting/output rules, or durable corrections that would genuinely improve future sessions.",
    "",
    "STRICT EXCLUSIONS (return {\"candidates\": []} if none apply):",
    "- One-off task requests, temporary file paths, single-session debugging details, or ephemeral questions.",
    "- Anything already covered by Existing Memories below.",
    "- Passwords, API keys, tokens, or secrets (never store secrets in memory).",
    "- Speculative guesses not clearly stated or confirmed by the user.",
    "",
    "Choose scope:",
    "- \"global\": universal user identity, language, formatting style, timezone, or cross-bot preferences.",
    "- \"bot\": rules/context specific only to this Bot's dedicated role.",
    "",
    "Output STRICT JSON ONLY with no markdown prose:",
    '{"candidates":[{"scope":"bot"|"global","name":"short title <=18 chars","content":"concise durable rule/fact","confidence":0.0-1.0}]}',
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
        "You are a precision memory extractor. Return strict JSON only (`{\"candidates\": [...]}`). Prefer returning an empty array over saving low-value or transient details.",
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

    const parsed = parseJsonPayload(turn?.text || "");
    const rawList = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    const dedupPool: any[] = [
      ...botMemories,
      ...globalMemories,
      ...recentSuggestedContents,
    ];
    const accepted: ExtractedMemoryCandidate[] = [];

    for (const item of rawList) {
      if (accepted.length >= 2) break;
      if (!item || typeof item !== "object") continue;
      const content = String(item.content || "").trim();
      const name =
        String(item.name || "").trim().slice(0, 24) ||
        content.replace(/\s+/g, " ").slice(0, 18);
      const scope: "bot" | "global" = item.scope === "global" ? "global" : "bot";
      const confidence = Number(item.confidence);
      if (!content || content.length < 4 || content.length > 260) continue;
      if (Number.isFinite(confidence) && confidence < 0.75) continue;
      if (findDuplicateMemory(dedupPool, content)) continue;
      dedupPool.push({ content });
      accepted.push({
        scope,
        name,
        content,
        confidence: Number.isFinite(confidence) ? confidence : 0.8,
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
  emit,
}: {
  store: any;
  model?: ModelAdapter | null;
  sessionId: string;
  botSession?: any;
  userText: string;
  assistantText: string;
  config?: Record<string, any>;
  emit?: (evt: Record<string, any>) => void;
}): Promise<ExtractedMemoryCandidate[]> {
  if (!store || !emit || !sessionId) return [];
  const latestSession = store.getSession?.(sessionId) || botSession || null;
  const settings = store.readSettings?.() || {};
  const botMemories = Array.isArray(latestSession?.memories) ? latestSession.memories : [];
  const globalMemories = Array.isArray(settings.globalMemories)
    ? settings.globalMemories
    : Array.isArray(settings.privateSkills)
      ? settings.privateSkills
      : [];

  // Collect previously suggested / resolved contents in this session so dismissed items are never re-suggested
  const recentEvents = Array.isArray(store.readEvents?.(sessionId))
    ? store.readEvents(sessionId).slice(-80)
    : [];
  const recentSuggestedContents = recentEvents
    .filter((e: any) => e && (e.type === "memory_suggestion" || e.type === "memory_suggestion_resolved"))
    .map((e: any) => String(e.content || ""))
    .filter(Boolean);

  const candidates = await extractMemoryCandidates({
    model,
    userText,
    assistantText,
    botName: latestSession?.title || "Twinkle",
    botMemories,
    globalMemories,
    recentSuggestedContents,
    config,
  });

  for (const cand of candidates) {
    if (store.getSession && !store.getSession(sessionId)) break;
    const suggestionId = `memsug-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    emit({
      type: "memory_suggestion",
      suggestionId,
      sessionId,
      scope: cand.scope,
      name: cand.name,
      content: cand.content,
      status: "pending",
      source: "post_turn_extractor",
    });
  }

  return candidates;
}
