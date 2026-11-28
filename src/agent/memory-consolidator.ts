import type { ModelAdapter } from "../shared/config.js";
import {
  normalizeMemoryCategory,
  type MemoryCategory,
} from "../shared/entities.js";
import { resolveUtilityModels } from "./router.js";
import {
  findDuplicateMemory,
  looksLikePoisonedToolMemory,
  looksLikeSecretMemory,
} from "./memory-extractor.js";

export interface MemoryEntryLike {
  id: string;
  name: string;
  content: string;
  category: MemoryCategory;
  enabled: boolean;
  source?: string;
  updatedAt?: string;
}

export interface MemoryConsolidationMerge {
  sourceIds: string[];
  sourceNames: string[];
  result: MemoryEntryLike;
  reason: string;
}

export interface MemoryConsolidationRemoval {
  id: string;
  name: string;
  content: string;
  reason: string;
}

export interface MemoryConsolidationPlan {
  scope: "bot" | "global";
  sessionId?: string;
  usedModel: string | null;
  beforeCount: number;
  afterCount: number;
  changed: boolean;
  summary: string;
  merges: MemoryConsolidationMerge[];
  removals: MemoryConsolidationRemoval[];
  recategorizedCount: number;
  proposedList: MemoryEntryLike[];
}

export interface ConsolidateMemoriesResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  plan?: MemoryConsolidationPlan;
}

const activeConsolidations = new Set<string>();

export function resetConsolidationLocksForTests(): void {
  activeConsolidations.clear();
}

function normalizeEntry(raw: any, index: number): MemoryEntryLike {
  const content = String(raw?.content || raw?.instruction || raw?.desc || "").trim();
  const rawName = String(raw?.name || "").trim();
  const name =
    rawName.slice(0, 28) || content.replace(/\s+/g, " ").slice(0, 18) || `记忆-${index + 1}`;
  const id = String(raw?.id || `mem-norm-${index}-${Date.now().toString(36)}`).trim();
  return {
    id,
    name,
    content,
    category: normalizeMemoryCategory(raw?.category),
    enabled: raw?.enabled !== false,
    ...(typeof raw?.source === "string" && raw.source ? { source: raw.source } : {}),
    ...(typeof raw?.updatedAt === "string" && raw.updatedAt
      ? { updatedAt: raw.updatedAt }
      : {}),
  };
}

export function inferMemoryCategoryDeterministic(
  name: string,
  content: string,
  currentCategory?: unknown
): MemoryCategory {
  const existing = normalizeMemoryCategory(currentCategory);
  if (existing !== "general") return existing;
  const text = `${name} ${content}`;
  if (/(叫我|称呼|邮箱|email|电话|手机号|职位|我是|我叫|公司|团队|时区|timezone|call me)/i.test(text)) {
    return "identity";
  }
  if (/(禁止|不要|别用|必须|一律|红线|规范|规则|never|must|always\s+check|do not)/i.test(text)) {
    return "rule";
  }
  if (/(喜欢|偏好|习惯|风格|语气|格式|语言|简短|中文|英文|表格|prefer|style|tone|format)/i.test(text)) {
    return "preference";
  }
  if (/(项目|仓库|环境|背景|架构|目录|端口|域名|project|repo|workspace|domain)/i.test(text)) {
    return "context";
  }
  return "general";
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

function pickPreferredEntry(a: MemoryEntryLike, b: MemoryEntryLike): MemoryEntryLike {
  const score = (m: MemoryEntryLike) => {
    let s = 0;
    if (m.enabled) s += 4;
    if (m.source !== "auto") s += 2;
    if (m.category !== "general") s += 1;
    return s;
  };
  const sa = score(a);
  const sb = score(b);
  if (sa !== sb) return sa > sb ? a : b;
  const ta = Date.parse(a.updatedAt || "") || 0;
  const tb = Date.parse(b.updatedAt || "") || 0;
  return tb > ta ? b : a;
}

function runDeterministicPrepass(
  scope: "bot" | "global",
  rawMemories: any[],
  sessionId?: string
): MemoryConsolidationPlan {
  const normalized = rawMemories.map((m, idx) => normalizeEntry(m, idx));
  const removals: MemoryConsolidationRemoval[] = [];
  const merges: MemoryConsolidationMerge[] = [];
  const kept: MemoryEntryLike[] = [];
  let recategorizedCount = 0;

  for (const item of normalized) {
    if (!item.content || item.content.length < 2) {
      removals.push({
        id: item.id,
        name: item.name,
        content: item.content,
        reason: "内容为空",
      });
      continue;
    }
    if (
      looksLikeSecretMemory(item.content) ||
      looksLikeSecretMemory(item.name) ||
      looksLikePoisonedToolMemory(item.content) ||
      looksLikePoisonedToolMemory(item.name)
    ) {
      removals.push({
        id: item.id,
        name: item.name,
        content: item.content,
        reason: "含敏感凭据或受限规则，已建议清理",
      });
      continue;
    }

    const inferredCategory = inferMemoryCategoryDeterministic(
      item.name,
      item.content,
      item.category
    );
    const enrichedItem: MemoryEntryLike =
      inferredCategory !== item.category
        ? { ...item, category: inferredCategory }
        : item;
    if (inferredCategory !== item.category) {
      recategorizedCount += 1;
    }

    const dup = findDuplicateMemory(kept, enrichedItem.content) as MemoryEntryLike | null;
    if (dup) {
      const winner = pickPreferredEntry(dup, enrichedItem);
      const mergedItem: MemoryEntryLike = {
        ...winner,
        enabled: dup.enabled || enrichedItem.enabled,
        category:
          winner.category !== "general"
            ? winner.category
            : enrichedItem.category !== "general"
              ? enrichedItem.category
              : dup.category,
        updatedAt: new Date().toISOString(),
      };
      const idx = kept.findIndex((x) => x.id === dup.id);
      if (idx >= 0) kept[idx] = mergedItem;

      const existingMerge = merges.find((m) => m.result.id === mergedItem.id || m.sourceIds.includes(dup.id));
      if (existingMerge) {
        existingMerge.sourceIds.push(enrichedItem.id);
        existingMerge.sourceNames.push(enrichedItem.name);
        existingMerge.result = mergedItem;
      } else {
        merges.push({
          sourceIds: [dup.id, enrichedItem.id],
          sourceNames: [dup.name, enrichedItem.name],
          result: mergedItem,
          reason: "内容高度重复，已合并为同一条",
        });
      }
      continue;
    }

    kept.push(enrichedItem);
  }

  const beforeCount = normalized.length;
  const afterCount = kept.length;
  const changed =
    merges.length > 0 || removals.length > 0 || recategorizedCount > 0 || afterCount !== beforeCount;
  const summary = changed
    ? `检测到 ${merges.length} 组重复合并、${removals.length} 条待清理条目、${recategorizedCount} 条自动归类。`
    : "当前记忆已较为精简清晰，暂无需要合并或清理的条目。";

  return {
    scope,
    ...(sessionId ? { sessionId } : {}),
    usedModel: null,
    beforeCount,
    afterCount,
    changed,
    summary,
    merges,
    removals,
    recategorizedCount,
    proposedList: kept,
  };
}

export function validateConsolidatedMemoryList(
  rawList: unknown,
  originalList: unknown[] = []
): MemoryEntryLike[] {
  if (!Array.isArray(rawList)) return [];
  const origMap = new Map<string, MemoryEntryLike>();
  originalList.forEach((m, idx) => {
    const norm = normalizeEntry(m, idx);
    if (norm.id) origMap.set(norm.id, norm);
  });

  const seenIds = new Set<string>();
  const out: MemoryEntryLike[] = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < rawList.length && out.length < 200; i++) {
    const raw = rawList[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const norm = normalizeEntry(raw, i);
    if (!norm.content || norm.content.length < 2 || norm.content.length > 500) continue;
    if (
      looksLikeSecretMemory(norm.content) ||
      looksLikeSecretMemory(norm.name) ||
      looksLikePoisonedToolMemory(norm.content) ||
      looksLikePoisonedToolMemory(norm.name)
    ) {
      continue;
    }
    let id = norm.id;
    if (!id || seenIds.has(id)) {
      id = `mem-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 5)}`;
    }
    seenIds.add(id);
    const orig = origMap.get(id);
    out.push({
      id,
      name: norm.name,
      content: norm.content,
      category: norm.category,
      enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : orig ? orig.enabled : true,
      ...(norm.source
        ? { source: norm.source }
        : orig?.source
          ? { source: orig.source }
          : {}),
      updatedAt: norm.updatedAt || nowIso,
    });
  }
  return out;
}

export async function consolidateMemories({
  scope,
  sessionId,
  memories = [],
  model = null,
  config = {},
  botName = "Twinkle",
  mode = "llm",
  timeoutMs = 15000,
  onUsage,
}: {
  scope: "bot" | "global";
  sessionId?: string;
  memories: any[];
  model?: ModelAdapter | null;
  config?: Record<string, any>;
  botName?: string;
  mode?: "llm" | "deterministic";
  timeoutMs?: number;
  onUsage?: (info: { model: string; providerId?: string | null; usage: any }) => void;
}): Promise<ConsolidateMemoriesResult> {
  const lockKey = `${scope}:${scope === "bot" ? sessionId || "bot" : "global"}`;
  if (activeConsolidations.has(lockKey)) {
    return {
      ok: false,
      statusCode: 409,
      error: "当前正在整理记忆，请等待本次预览完成后再试。",
    };
  }
  activeConsolidations.add(lockKey);

  try {
    const rawList = Array.isArray(memories) ? memories : [];
    const basePlan = runDeterministicPrepass(scope, rawList, sessionId);

    if (
      mode === "deterministic" ||
      !model ||
      typeof model.summarizeTurn !== "function" ||
      basePlan.proposedList.length < 2
    ) {
      return { ok: true, plan: basePlan };
    }

    const { fastModel: targetModel, fallbackModel } = resolveUtilityModels(config);
    const workingList = basePlan.proposedList.slice(0, 100);
    const byId = new Map(workingList.map((m) => [m.id, m]));

    const serializedItems = workingList
      .map(
        (m, i) =>
          `${i + 1}. [id:${m.id}][cat:${m.category}][source:${m.source || "manual"}][${m.enabled ? "on" : "off"}] ${m.name}: ${m.content}`
      )
      .join("\n");

    const prompt = [
      `Review and consolidate the following ${scope === "global" ? "Global Memories (shared across all Bots)" : `Dedicated Memories for Bot "${botName}"`}.`,
      "Your goal is to clean up clutter, merge semantic duplicates or conflicting rules (preferring newer/clearer intent), remove obvious one-off temporary task debris, and assign accurate categories.",
      "",
      "STRICT RULES:",
      "- NEVER invent new facts or preferences not present in the source items.",
      "- NEVER drop valid standalone user preferences, identity facts, or standing rules.",
      "- Keep `merges` strictly to 2+ sourceIds that express the same or conflicting rule on the same topic.",
      "- Keep `removals` strictly to obvious temporary noise (one-off errors, transient file paths, meaningless chatter).",
      "- Valid categories: \"identity\", \"preference\", \"rule\", \"context\", \"general\".",
      "",
      "Output STRICT JSON ONLY:",
      '{"summary":"concise 1-sentence Chinese summary","merges":[{"sourceIds":["id1","id2"],"name":"<=18 chars","content":"concise merged rule","category":"preference","reason":"why merged"}],"removals":[{"id":"id3","reason":"why temporary noise"}],"recategorizations":[{"id":"id4","category":"rule"}]}',
      "",
      "Memories to consolidate:",
      serializedItems,
    ].join("\n");

    const timeoutCtrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const turnPromise = model.summarizeTurn({
        model: targetModel,
        fallbackModel,
        thinkingLevel: "low",
        timeoutMs,
        systemInstruction:
          "You are a memory governance optimizer. Return strict JSON only (`{\"summary\",\"merges\",\"removals\",\"recategorizations\"}`). Never fabricate memories.",
        input: [{ type: "user_input", content: [{ type: "text", text: prompt }] }],
        signal: timeoutCtrl.signal,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timeoutCtrl.abort();
          reject(new Error("memory consolidation timed out"));
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
          // ignore usage error
        }
      }

      const parsed = parseJsonPayload(turn?.text || "");
      if (!parsed || typeof parsed !== "object") {
        return { ok: true, plan: basePlan };
      }

      const consumed = new Set<string>();
      const llmMerges: MemoryConsolidationMerge[] = [];
      const llmRemovals: MemoryConsolidationRemoval[] = [];
      const recatMap = new Map<string, MemoryCategory>();
      const mergeInsertByFirstId = new Map<string, MemoryEntryLike>();
      const nowIso = new Date().toISOString();

      if (Array.isArray(parsed.merges)) {
        for (const m of parsed.merges) {
          if (!m || !Array.isArray(m.sourceIds)) continue;
          const validIds = Array.from(
            new Set(
              m.sourceIds
                .map((x: unknown) => String(x || "").trim())
                .filter((id: string) => byId.has(id) && !consumed.has(id))
            )
          ) as string[];
          if (validIds.length < 2) continue;
          const content = String(m.content || "").trim();
          const name =
            String(m.name || "").trim().slice(0, 24) ||
            content.replace(/\s+/g, " ").slice(0, 18);
          if (
            !content ||
            content.length > 400 ||
            looksLikeSecretMemory(content) ||
            looksLikeSecretMemory(name) ||
            looksLikePoisonedToolMemory(content) ||
            looksLikePoisonedToolMemory(name)
          ) {
            continue;
          }
          const members = validIds.map((id) => byId.get(id)!);
          validIds.forEach((id) => consumed.add(id));
          const mergedResult: MemoryEntryLike = {
            id: validIds[0],
            name,
            content,
            category: normalizeMemoryCategory(m.category || members[0].category),
            enabled: members.some((x) => x.enabled),
            source: members.some((x) => x.source !== "auto") ? "explicit" : "auto",
            updatedAt: nowIso,
          };
          mergeInsertByFirstId.set(validIds[0], mergedResult);
          llmMerges.push({
            sourceIds: validIds,
            sourceNames: members.map((x) => x.name),
            result: mergedResult,
            reason: String(m.reason || "语义重复或新旧偏好冲突合并").slice(0, 120),
          });
        }
      }

      if (Array.isArray(parsed.removals)) {
        for (const r of parsed.removals) {
          const id = String(r?.id || "").trim();
          if (!id || !byId.has(id) || consumed.has(id)) continue;
          const target = byId.get(id)!;
          consumed.add(id);
          llmRemovals.push({
            id,
            name: target.name,
            content: target.content,
            reason: String(r?.reason || "临时任务碎片或无效记忆").slice(0, 120),
          });
        }
      }

      let llmRecatCount = 0;
      if (Array.isArray(parsed.recategorizations)) {
        for (const rc of parsed.recategorizations) {
          const id = String(rc?.id || "").trim();
          if (!id || !byId.has(id) || consumed.has(id)) continue;
          const nextCat = normalizeMemoryCategory(rc?.category);
          const cur = byId.get(id)!;
          if (nextCat !== cur.category) {
            recatMap.set(id, nextCat);
            llmRecatCount += 1;
          }
        }
      }

      const finalProposed: MemoryEntryLike[] = [];
      for (const item of basePlan.proposedList) {
        if (mergeInsertByFirstId.has(item.id)) {
          finalProposed.push(mergeInsertByFirstId.get(item.id)!);
          continue;
        }
        if (consumed.has(item.id)) continue;
        const nextCat = recatMap.get(item.id);
        finalProposed.push(nextCat ? { ...item, category: nextCat } : item);
      }

      const merges = [...basePlan.merges, ...llmMerges];
      const removals = [...basePlan.removals, ...llmRemovals];
      const recategorizedCount = basePlan.recategorizedCount + llmRecatCount;
      const beforeCount = basePlan.beforeCount;
      const afterCount = finalProposed.length;
      const changed =
        merges.length > 0 ||
        removals.length > 0 ||
        recategorizedCount > 0 ||
        afterCount !== beforeCount;
      const summaryText =
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim().slice(0, 220)
          : changed
            ? `已识别 ${merges.length} 组合并、${removals.length} 条清理、${recategorizedCount} 条归类，可将 ${beforeCount} 条整理为 ${afterCount} 条。`
            : basePlan.summary;

      return {
        ok: true,
        plan: {
          scope,
          ...(sessionId ? { sessionId } : {}),
          usedModel: turn?.usedModel || targetModel,
          beforeCount,
          afterCount,
          changed,
          summary: summaryText,
          merges,
          removals,
          recategorizedCount,
          proposedList: finalProposed,
        },
      };
    } catch {
      return { ok: true, plan: basePlan };
    }
  } finally {
    activeConsolidations.delete(lockKey);
  }
}
