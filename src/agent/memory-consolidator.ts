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
  beforeChars: number;
  afterChars: number;
  shrinkPercent: number;
  missingTokens: string[];
  highShrinkWarning?: boolean;
}

export interface MemoryConsolidationRejectedMerge {
  sourceIds: string[];
  sourceNames: string[];
  beforeChars: number;
  afterChars: number;
  shrinkPercent: number;
  missingTokens: string[];
  reason: string;
}

export interface MemoryConsolidationRemoval {
  id: string;
  name: string;
  content: string;
  reason: string;
}

export interface MemoryPatchMergeOp {
  sourceIds: string[];
  name: string;
  content: string;
  category?: MemoryCategory;
  enabled?: boolean;
  reason?: string;
}

export type MemoryPatchRemovalOp = string | { id: string; reason?: string };

export interface MemoryPatchRecategorizeOp {
  id: string;
  category: MemoryCategory;
}

export interface MemoryPatchUpdateOp {
  id: string;
  name?: string;
  content?: string;
  category?: MemoryCategory;
  enabled?: boolean;
  reason?: string;
}

export interface MemoryPatchOps {
  merges?: MemoryPatchMergeOp[];
  removals?: MemoryPatchRemovalOp[];
  recategorizations?: MemoryPatchRecategorizeOp[];
  updates?: MemoryPatchUpdateOp[];
}

export interface MemoryConsolidationDiffItem {
  type: "merge" | "remove" | "recategorize" | "update";
  sourceIds: string[];
  sourceNames: string[];
  beforeChars: number;
  afterChars: number;
  deltaChars: number;
  reason: string;
  resultName?: string;
  resultContent?: string;
  fromCategory?: MemoryCategory;
  toCategory?: MemoryCategory;
  missingTokens?: string[];
  highShrinkWarning?: boolean;
}

export interface MemoryConsolidationPlan {
  scope: "bot" | "global";
  mode: "llm" | "deterministic";
  sessionId?: string;
  usedModel: string | null;
  beforeCount: number;
  afterCount: number;
  totalBeforeChars: number;
  totalAfterChars: number;
  deltaChars: number;
  changed: boolean;
  summary: string;
  originalList: MemoryEntryLike[];
  merges: MemoryConsolidationMerge[];
  rejectedMerges: MemoryConsolidationRejectedMerge[];
  removals: MemoryConsolidationRemoval[];
  recategorizations: Array<{ id: string; category: MemoryCategory }>;
  recategorizedCount: number;
  diffs: MemoryConsolidationDiffItem[];
  ops: MemoryPatchOps;
  proposedList: MemoryEntryLike[];
}

const GENERIC_PROPER_TOKENS = new Set([
  "the", "and", "for", "with", "when", "always", "never", "only", "all", "not", "but",
  "this", "that", "from", "into", "each", "also", "must", "should", "use", "using",
  "json", "html", "http", "https", "url", "uri", "api", "bot", "llm", "strict",
  "never", "markdown", "true", "false", "null", "none", "auto", "mode", "mac",
  "macos", "windows", "linux", "rule", "rules", "context", "identity", "preference",
  "general",
]);

export function extractCriticalFactTokens(text: unknown): string[] {
  const src = String(text || "");
  if (!src.trim()) return [];
  const found = new Map<string, string>();
  const add = (tok: string) => {
    const clean = tok.replace(/[),.;:，。；：、]+$/g, "").trim();
    if (!clean || clean.length < 2) return;
    const key = clean.toLowerCase();
    if (GENERIC_PROPER_TOKENS.has(key)) return;
    if (!found.has(key)) found.set(key, clean);
  };

  for (const m of src.matchAll(/@[A-Za-z0-9_.-]{2,}/g)) add(m[0]);
  for (const m of src.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) add(m[0]);
  for (const m of src.matchAll(/https?:\/\/[^\s，。、；)"'<>]+/gi)) add(m[0]);
  for (const m of src.matchAll(/\b[a-zA-Z0-9-]+\.(?:com|io|dev|to|org|net|cn|ai|app|gg)\b/gi)) add(m[0]);
  for (const m of src.matchAll(/(?:~\/|\/[A-Za-z0-9._-]+\/)[A-Za-z0-9._\/-]+/g)) add(m[0]);

  const addPort = (rawDigits: string | undefined) => {
    const num = Number(rawDigits);
    if (!Number.isInteger(num) || num < 10 || num > 65535) return;
    add(`port:${rawDigits}`);
  };
  for (const m of src.matchAll(/(?:port|端口)\s*[:：]?\s*(\d{2,5})\b/gi)) addPort(m[1]);
  for (const m of src.matchAll(/(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z][a-zA-Z0-9.-]*):(\d{2,5})\b/gi)) {
    addPort(m[1]);
  }
  for (const m of src.matchAll(/(?:^|[\s(（\[【'"`:：]):(\d{3,5})\b/g)) addPort(m[1]);

  for (const m of src.matchAll(/\b[A-Z][A-Za-z0-9.+-]{2,}\b/g)) add(m[0]);

  return Array.from(found.values());
}

function isTokenPresentInText(tokenKey: string, textLower: string): boolean {
  if (tokenKey.startsWith("port:")) {
    const portDigits = tokenKey.slice(5);
    if (!portDigits) return false;
    return new RegExp(`(?:^|[^\\d])${portDigits}(?:$|[^\\d])`).test(textLower);
  }
  return textLower.includes(tokenKey);
}

function isHardStructuredEntityToken(tok: string): boolean {
  return (
    tok.startsWith("@") ||
    tok.includes("://") ||
    tok.startsWith("~/") ||
    tok.startsWith("/") ||
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/i.test(tok) ||
    /\.(?:com|io|dev|to|org|net|cn|ai|app|gg)$/i.test(tok)
  );
}

export function analyzeMergeFidelity(
  members: MemoryEntryLike[],
  mergedText: string
): {
  beforeChars: number;
  afterChars: number;
  shrinkPercent: number;
  missingTokens: string[];
  hasCriticalEntityLoss: boolean;
  isLossy: boolean;
} {
  const beforeChars = members.reduce((sum, m) => sum + String(m.content || "").trim().length, 0);
  const afterChars = String(mergedText || "").trim().length;
  const shrinkPercent =
    beforeChars > 0 ? Math.max(0, Math.round(((beforeChars - afterChars) / beforeChars) * 100)) : 0;

  const sourceTokens = new Map<string, string>();
  for (const m of members) {
    for (const tok of extractCriticalFactTokens(`${m.name} ${m.content}`)) {
      const k = tok.toLowerCase();
      if (!sourceTokens.has(k)) sourceTokens.set(k, tok);
    }
  }

  const mergedLower = String(mergedText || "").toLowerCase();
  const missingTokens: string[] = [];
  for (const [k, tok] of sourceTokens.entries()) {
    if (!isTokenPresentInText(k, mergedLower)) {
      missingTokens.push(tok);
    }
  }

  const hasCriticalEntityLoss = missingTokens.some(
    (tok) =>
      tok.startsWith("@") ||
      tok.startsWith("port:") ||
      tok.includes("://") ||
      tok.includes("/") ||
      /\.[a-z]{2,}$/i.test(tok)
  );
  const isLossy =
    hasCriticalEntityLoss ||
    missingTokens.length >= 2 ||
    (beforeChars >= 120 && shrinkPercent >= 60 && missingTokens.length >= 1);

  return {
    beforeChars,
    afterChars,
    shrinkPercent,
    missingTokens,
    hasCriticalEntityLoss,
    isLossy,
  };
}

export function checkProposedListFidelity(
  origList: unknown[],
  sanitizedList: MemoryEntryLike[]
): {
  isLossy: boolean;
  missingTokens: string[];
  beforeChars: number;
  afterChars: number;
  shrinkPercent: number;
} {
  const origNorms = (Array.isArray(origList) ? origList : []).map((m, idx) =>
    normalizeEntry(m, idx)
  );
  const origById = new Map(origNorms.map((m) => [m.id, m]));
  const combinedAfterText = sanitizedList
    .map((m) => `${String(m.name || "")} ${String(m.content || "")}`)
    .join("\n");
  const combinedAfterLower = combinedAfterText.toLowerCase();

  const missingSet = new Map<string, string>();
  for (const next of sanitizedList) {
    const orig = origById.get(String(next.id || "").trim());
    if (!orig) continue;
    if (next.content !== orig.content || next.name !== orig.name) {
      const fid = analyzeMergeFidelity([orig], `${next.name} ${next.content}`);
      if (fid.isLossy) {
        for (const tok of fid.missingTokens) {
          const k = tok.toLowerCase();
          if (!missingSet.has(k)) missingSet.set(k, tok);
        }
      }
    }
  }

  if (sanitizedList.length < origNorms.length) {
    for (const orig of origNorms) {
      for (const tok of extractCriticalFactTokens(`${orig.name} ${orig.content}`)) {
        if (!isHardStructuredEntityToken(tok)) continue;
        const k = tok.toLowerCase();
        if (!isTokenPresentInText(k, combinedAfterLower) && !missingSet.has(k)) {
          missingSet.set(k, tok);
        }
      }
    }
  }

  const beforeChars = origNorms.reduce((sum, m) => sum + String(m.content || "").trim().length, 0);
  const afterChars = sanitizedList.reduce((sum, m) => sum + String(m.content || "").trim().length, 0);
  const shrinkPercent =
    beforeChars > 0 ? Math.max(0, Math.round(((beforeChars - afterChars) / beforeChars) * 100)) : 0;
  const missingTokens = Array.from(missingSet.values());

  return {
    isLossy: missingTokens.length > 0,
    missingTokens,
    beforeChars,
    afterChars,
    shrinkPercent,
  };
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

function buildPlanDiffsAndOps(
  originalList: MemoryEntryLike[],
  merges: MemoryConsolidationMerge[],
  removals: MemoryConsolidationRemoval[],
  recategorizations: Array<{ id: string; category: MemoryCategory }>,
  proposedList: MemoryEntryLike[]
): {
  totalBeforeChars: number;
  totalAfterChars: number;
  deltaChars: number;
  diffs: MemoryConsolidationDiffItem[];
  ops: MemoryPatchOps;
} {
  const origById = new Map(originalList.map((m) => [m.id, m]));
  const diffs: MemoryConsolidationDiffItem[] = [];

  for (const m of merges) {
    diffs.push({
      type: "merge",
      sourceIds: [...m.sourceIds],
      sourceNames: [...m.sourceNames],
      beforeChars: m.beforeChars,
      afterChars: m.afterChars,
      deltaChars: m.afterChars - m.beforeChars,
      reason: m.reason,
      resultName: m.result.name,
      resultContent: m.result.content,
      toCategory: m.result.category,
      ...(m.missingTokens?.length ? { missingTokens: [...m.missingTokens] } : {}),
      ...(m.highShrinkWarning ? { highShrinkWarning: true } : {}),
    });
  }

  for (const r of removals) {
    const beforeChars = String(r.content || "").trim().length;
    diffs.push({
      type: "remove",
      sourceIds: [r.id],
      sourceNames: [r.name],
      beforeChars,
      afterChars: 0,
      deltaChars: -beforeChars,
      reason: r.reason,
    });
  }

  for (const rc of recategorizations) {
    const orig = origById.get(rc.id);
    const chars = String(orig?.content || "").trim().length;
    diffs.push({
      type: "recategorize",
      sourceIds: [rc.id],
      sourceNames: [orig?.name || rc.id],
      beforeChars: chars,
      afterChars: chars,
      deltaChars: 0,
      reason: `归类调整：${orig?.category || "general"} → ${rc.category}`,
      ...(orig?.category ? { fromCategory: orig.category } : {}),
      toCategory: rc.category,
    });
  }

  const ops: MemoryPatchOps = {
    merges: merges.map((m) => ({
      sourceIds: [...m.sourceIds],
      name: m.result.name,
      content: m.result.content,
      category: m.result.category,
      enabled: m.result.enabled,
      reason: m.reason,
    })),
    removals: removals.map((r) => ({ id: r.id, reason: r.reason })),
    recategorizations: recategorizations.map((rc) => ({ id: rc.id, category: rc.category })),
  };

  const totalBeforeChars = originalList.reduce(
    (sum, m) => sum + String(m.content || "").trim().length,
    0
  );
  const totalAfterChars = proposedList.reduce(
    (sum, m) => sum + String(m.content || "").trim().length,
    0
  );

  return {
    totalBeforeChars,
    totalAfterChars,
    deltaChars: totalAfterChars - totalBeforeChars,
    diffs,
    ops,
  };
}

function runDeterministicPrepass(
  scope: "bot" | "global",
  rawMemories: any[],
  sessionId?: string
): MemoryConsolidationPlan {
  const normalized = rawMemories.map((m, idx) => normalizeEntry(m, idx));
  const removals: MemoryConsolidationRemoval[] = [];
  const merges: MemoryConsolidationMerge[] = [];
  const recategorizations: Array<{ id: string; category: MemoryCategory }> = [];
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
      recategorizations.push({ id: item.id, category: inferredCategory });
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
        const memberEntries = existingMerge.sourceIds
          .map((sid) => normalized.find((x) => x.id === sid))
          .filter(Boolean) as MemoryEntryLike[];
        const fid = analyzeMergeFidelity(memberEntries, `${mergedItem.name} ${mergedItem.content}`);
        existingMerge.beforeChars = fid.beforeChars;
        existingMerge.afterChars = mergedItem.content.length;
        existingMerge.shrinkPercent = fid.shrinkPercent;
        existingMerge.missingTokens = fid.missingTokens;
      } else {
        const fid = analyzeMergeFidelity([dup, enrichedItem], `${mergedItem.name} ${mergedItem.content}`);
        merges.push({
          sourceIds: [dup.id, enrichedItem.id],
          sourceNames: [dup.name, enrichedItem.name],
          result: mergedItem,
          reason: "内容高度重复，已合并为同一条",
          beforeChars: fid.beforeChars,
          afterChars: mergedItem.content.length,
          shrinkPercent: fid.shrinkPercent,
          missingTokens: fid.missingTokens,
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
  const diffMeta = buildPlanDiffsAndOps(normalized, merges, removals, recategorizations, kept);

  return {
    scope,
    mode: "deterministic",
    ...(sessionId ? { sessionId } : {}),
    usedModel: null,
    beforeCount,
    afterCount,
    totalBeforeChars: diffMeta.totalBeforeChars,
    totalAfterChars: diffMeta.totalAfterChars,
    deltaChars: diffMeta.deltaChars,
    changed,
    summary,
    originalList: normalized,
    merges,
    rejectedMerges: [],
    removals,
    recategorizations,
    recategorizedCount,
    diffs: diffMeta.diffs,
    ops: diffMeta.ops,
    proposedList: kept,
  };
}

const MAX_CONSOLIDATED_MEMORY_CHARS = 8000;
const MAX_MERGED_MEMORY_CHARS = 2000;
const MAX_BOT_ROLE_PROMPT_PREVIEW_CHARS = 1600;

export interface ConsolidationDroppedItem {
  id: string;
  name: string;
  reason: string;
}

export function validateConsolidatedMemoryListWithReport(
  rawList: unknown,
  originalList: unknown[] = []
): { memories: MemoryEntryLike[]; dropped: ConsolidationDroppedItem[] } {
  if (!Array.isArray(rawList)) return { memories: [], dropped: [] };
  const origRawMap = new Map<string, any>();
  const origMap = new Map<string, MemoryEntryLike>();
  originalList.forEach((m, idx) => {
    const rawId = m && typeof m === "object" ? String((m as any).id || "").trim() : "";
    if (rawId) origRawMap.set(rawId, m);
    const norm = normalizeEntry(m, idx);
    if (norm.id) origMap.set(norm.id, norm);
  });

  const seenIds = new Set<string>();
  const out: MemoryEntryLike[] = [];
  const dropped: ConsolidationDroppedItem[] = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < rawList.length && out.length < 200; i++) {
    const raw = rawList[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const norm = normalizeEntry(raw, i);
    const isExistingEntry = Boolean(norm.id && origMap.has(norm.id));
    if (!norm.content || norm.content.length < 2) {
      dropped.push({ id: norm.id, name: norm.name, reason: "内容为空或过短" });
      continue;
    }
    if (!isExistingEntry && norm.content.length > MAX_CONSOLIDATED_MEMORY_CHARS) {
      dropped.push({
        id: norm.id,
        name: norm.name,
        reason: `内容超过 ${MAX_CONSOLIDATED_MEMORY_CHARS} 字符上限`,
      });
      continue;
    }
    if (
      looksLikeSecretMemory(norm.content) ||
      looksLikeSecretMemory(norm.name) ||
      looksLikePoisonedToolMemory(norm.content) ||
      looksLikePoisonedToolMemory(norm.name)
    ) {
      dropped.push({
        id: norm.id,
        name: norm.name,
        reason: "含敏感凭据或受限工具规则，已拦截",
      });
      continue;
    }
    let id = norm.id;
    if (!id || seenIds.has(id)) {
      id = `mem-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 5)}`;
    }
    seenIds.add(id);
    const origRaw = origRawMap.get(id);
    const orig = origMap.get(id);
    if (
      origRaw &&
      orig &&
      String(raw.name ?? "") === String(origRaw.name ?? "") &&
      String(raw.content ?? raw.instruction ?? raw.desc ?? "") ===
        String(origRaw.content ?? origRaw.instruction ?? origRaw.desc ?? "") &&
      normalizeMemoryCategory(raw.category ?? origRaw.category) === orig.category &&
      (raw.enabled !== undefined ? Boolean(raw.enabled) : orig.enabled) === orig.enabled
    ) {
      out.push({ ...origRaw });
      continue;
    }
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
  return { memories: out, dropped };
}

export interface MemoryPatchApplyResult {
  ok: boolean;
  blockedByFidelityGuard?: boolean;
  missingTokens?: string[];
  beforeChars?: number;
  afterChars?: number;
  shrinkPercent?: number;
  error?: string;
  memories?: any[];
  dropped?: ConsolidationDroppedItem[];
  warnings?: Array<{ id: string; name: string; tokens: string[]; reason: string }>;
  appliedOps?: {
    mergedCount: number;
    removedCount: number;
    recategorizedCount: number;
    updatedCount: number;
    untouchedCount: number;
  };
  diffs?: MemoryConsolidationDiffItem[];
}

export function applyMemoryPatchOps(
  origList: unknown[],
  ops: MemoryPatchOps,
  options?: { allowEntityDrop?: boolean }
): MemoryPatchApplyResult {
  const sourceList = Array.isArray(origList) ? origList : [];
  const allowEntityDrop = options?.allowEntityDrop === true;
  const nowIso = new Date().toISOString();

  const keyedEntries = sourceList.map((raw, idx) => {
    const rawObj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const id = String((rawObj as any).id || `mem-orig-${idx}`).trim();
    return { id, raw: rawObj, norm: normalizeEntry(rawObj, idx) };
  });
  const byId = new Map(keyedEntries.map((e) => [e.id, e]));

  const consumedIds = new Set<string>();
  const mergeResultByFirstId = new Map<string, any>();
  const updatedById = new Map<string, any>();
  const dropped: ConsolidationDroppedItem[] = [];
  const warnings: Array<{ id: string; name: string; tokens: string[]; reason: string }> = [];
  const diffs: MemoryConsolidationDiffItem[] = [];

  let mergedCount = 0;
  let removedCount = 0;
  let recategorizedCount = 0;
  let updatedCount = 0;

  if (Array.isArray(ops?.merges)) {
    for (const m of ops.merges) {
      if (!m || !Array.isArray(m.sourceIds)) continue;
      const validIds = Array.from(
        new Set(
          m.sourceIds
            .map((x) => String(x || "").trim())
            .filter((id) => byId.has(id) && !consumedIds.has(id))
        )
      );
      if (validIds.length < 2) continue;
      const members = validIds.map((id) => byId.get(id)!.norm);
      const content = String(m.content || "").trim();
      const name =
        String(m.name || "").trim().slice(0, 28) ||
        content.replace(/\s+/g, " ").slice(0, 18);

      if (
        !content ||
        content.length > MAX_MERGED_MEMORY_CHARS ||
        looksLikeSecretMemory(content) ||
        looksLikeSecretMemory(name) ||
        looksLikePoisonedToolMemory(content) ||
        looksLikePoisonedToolMemory(name)
      ) {
        dropped.push({
          id: validIds[0],
          name,
          reason: !content
            ? "合并内容为空"
            : content.length > MAX_MERGED_MEMORY_CHARS
              ? `合并内容超过 ${MAX_MERGED_MEMORY_CHARS} 字符上限`
              : "含敏感凭据或受限工具规则，已拦截",
        });
        continue;
      }

      const fidelity = analyzeMergeFidelity(members, `${name} ${content}`);
      if (fidelity.isLossy && !allowEntityDrop) {
        return {
          ok: false,
          blockedByFidelityGuard: true,
          missingTokens: fidelity.missingTokens,
          beforeChars: fidelity.beforeChars,
          afterChars: fidelity.afterChars,
          shrinkPercent: fidelity.shrinkPercent,
          error: `合并操作遗漏了关键实体/账号/端口/路径（${fidelity.missingTokens.slice(0, 6).join(", ")}），已自动拦截并保留全部原条目。请保留全部关键实体后重试；若主人明确确认要删除，可传 allowEntityDrop: true。`,
        };
      }

      validIds.forEach((id) => consumedIds.add(id));
      const mergedEntry: MemoryEntryLike = {
        id: validIds[0],
        name,
        content,
        category: normalizeMemoryCategory(m.category || members[0].category),
        enabled: m.enabled !== undefined ? Boolean(m.enabled) : members.some((x) => x.enabled),
        source: members.some((x) => x.source !== "auto") ? "explicit" : "auto",
        updatedAt: nowIso,
      };
      mergeResultByFirstId.set(validIds[0], mergedEntry);
      mergedCount += 1;
      diffs.push({
        type: "merge",
        sourceIds: validIds,
        sourceNames: members.map((x) => x.name),
        beforeChars: fidelity.beforeChars,
        afterChars: content.length,
        deltaChars: content.length - fidelity.beforeChars,
        reason: String(m.reason || "合并记忆条目").slice(0, 120),
        resultName: mergedEntry.name,
        resultContent: mergedEntry.content,
        toCategory: mergedEntry.category,
        ...(fidelity.missingTokens.length > 0 ? { missingTokens: fidelity.missingTokens } : {}),
        ...(fidelity.shrinkPercent >= 45 ? { highShrinkWarning: true } : {}),
      });
    }
  }

  if (Array.isArray(ops?.removals)) {
    for (const r of ops.removals) {
      const id = typeof r === "string" ? r.trim() : String(r?.id || "").trim();
      const reason =
        typeof r === "string" ? "指定删除" : String(r?.reason || "指定删除").slice(0, 120);
      if (!id || !byId.has(id) || consumedIds.has(id)) continue;
      const target = byId.get(id)!.norm;
      const entityTokens = extractCriticalFactTokens(`${target.name} ${target.content}`);
      if (entityTokens.length > 0) {
        warnings.push({
          id: target.id,
          name: target.name,
          tokens: entityTokens,
          reason: `已删除条目含关键实体/标识（${entityTokens.slice(0, 5).join(", ")}）`,
        });
      }
      consumedIds.add(id);
      removedCount += 1;
      const chars = String(target.content || "").trim().length;
      diffs.push({
        type: "remove",
        sourceIds: [target.id],
        sourceNames: [target.name],
        beforeChars: chars,
        afterChars: 0,
        deltaChars: -chars,
        reason,
      });
    }
  }

  if (Array.isArray(ops?.updates)) {
    for (const u of ops.updates) {
      const id = String(u?.id || "").trim();
      if (!id || !byId.has(id) || consumedIds.has(id)) continue;
      const entry = byId.get(id)!;
      const origRaw: any = entry.raw;
      const origNorm = entry.norm;
      const nextName = u.name !== undefined ? String(u.name).trim() : String(origRaw.name || origNorm.name);
      const nextContent =
        u.content !== undefined
          ? String(u.content).trim()
          : String(origRaw.content ?? origRaw.instruction ?? origRaw.desc ?? origNorm.content).trim();
      if (
        !nextContent ||
        nextContent.length < 2 ||
        looksLikeSecretMemory(nextContent) ||
        looksLikeSecretMemory(nextName) ||
        looksLikePoisonedToolMemory(nextContent) ||
        looksLikePoisonedToolMemory(nextName)
      ) {
        dropped.push({
          id,
          name: nextName,
          reason: !nextContent || nextContent.length < 2 ? "更新内容为空或过短" : "含敏感凭据或受限工具规则，已拦截",
        });
        continue;
      }

      const fidelity = analyzeMergeFidelity([origNorm], `${nextName} ${nextContent}`);
      if (fidelity.isLossy && !allowEntityDrop) {
        return {
          ok: false,
          blockedByFidelityGuard: true,
          missingTokens: fidelity.missingTokens,
          beforeChars: fidelity.beforeChars,
          afterChars: fidelity.afterChars,
          shrinkPercent: fidelity.shrinkPercent,
          error: `修改条目「${origNorm.name}」时遗漏了关键实体/账号/端口/路径（${fidelity.missingTokens.slice(0, 6).join(", ")}），已自动拦截并保留原条目。若主人明确确认要删改，可传 allowEntityDrop: true。`,
        };
      }

      const nextCategory =
        u.category !== undefined ? normalizeMemoryCategory(u.category) : origNorm.category;
      const patched = {
        ...origRaw,
        ...(u.name !== undefined ? { name: nextName } : {}),
        ...(u.content !== undefined ? { content: nextContent } : {}),
        ...(u.category !== undefined ? { category: nextCategory } : {}),
        ...(u.enabled !== undefined ? { enabled: Boolean(u.enabled) } : {}),
        updatedAt: nowIso,
      };
      updatedById.set(id, patched);
      updatedCount += 1;
      diffs.push({
        type: "update",
        sourceIds: [id],
        sourceNames: [origNorm.name],
        beforeChars: origNorm.content.length,
        afterChars: nextContent.length,
        deltaChars: nextContent.length - origNorm.content.length,
        reason: String(u.reason || "定点更新条目").slice(0, 120),
        resultName: nextName,
        resultContent: nextContent,
        fromCategory: origNorm.category,
        toCategory: nextCategory,
        ...(fidelity.missingTokens.length > 0 ? { missingTokens: fidelity.missingTokens } : {}),
      });
    }
  }

  if (Array.isArray(ops?.recategorizations)) {
    for (const rc of ops.recategorizations) {
      const id = String(rc?.id || "").trim();
      if (!id || !byId.has(id) || consumedIds.has(id)) continue;
      const entry = byId.get(id)!;
      const baseRaw: any = updatedById.get(id) || entry.raw;
      const prevCat = normalizeMemoryCategory(baseRaw.category);
      const nextCat = normalizeMemoryCategory(rc?.category);
      if (nextCat === prevCat) continue;
      updatedById.set(id, {
        ...baseRaw,
        category: nextCat,
        updatedAt: nowIso,
      });
      recategorizedCount += 1;
      const chars = entry.norm.content.length;
      diffs.push({
        type: "recategorize",
        sourceIds: [id],
        sourceNames: [entry.norm.name],
        beforeChars: chars,
        afterChars: chars,
        deltaChars: 0,
        reason: `归类调整：${prevCat} → ${nextCat}`,
        fromCategory: prevCat,
        toCategory: nextCat,
      });
    }
  }

  const nextList: any[] = [];
  let untouchedCount = 0;
  for (const item of keyedEntries) {
    if (mergeResultByFirstId.has(item.id)) {
      nextList.push(mergeResultByFirstId.get(item.id)!);
      continue;
    }
    if (consumedIds.has(item.id)) continue;
    if (updatedById.has(item.id)) {
      nextList.push(updatedById.get(item.id)!);
      continue;
    }
    untouchedCount += 1;
    nextList.push({ ...item.raw });
  }

  return {
    ok: true,
    memories: nextList,
    dropped,
    warnings,
    appliedOps: {
      mergedCount,
      removedCount,
      recategorizedCount,
      updatedCount,
      untouchedCount,
    },
    diffs,
  };
}

export function validateConsolidatedMemoryList(
  rawList: unknown,
  originalList: unknown[] = []
): MemoryEntryLike[] {
  return validateConsolidatedMemoryListWithReport(rawList, originalList).memories;
}

export async function consolidateMemories({
  scope,
  sessionId,
  memories = [],
  model = null,
  config = {},
  botName = "Twinkle",
  botRolePrompt = "",
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
  botRolePrompt?: string;
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
    const cleanRolePrompt =
      scope === "bot" ? String(botRolePrompt || "").trim().slice(0, MAX_BOT_ROLE_PROMPT_PREVIEW_CHARS) : "";
    const shouldInvokeLlm =
      basePlan.proposedList.length >= 2 ||
      (basePlan.proposedList.length === 1 &&
        (basePlan.proposedList[0].category === "general" || Boolean(cleanRolePrompt)));

    if (
      mode === "deterministic" ||
      !model ||
      typeof model.summarizeTurn !== "function" ||
      !shouldInvokeLlm
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
      ...(cleanRolePrompt
        ? [
            "",
            `Bot Role / Persona (already permanently injected into system prompt; if a memory merely duplicates this persona without adding extra value, you may list it in \`removals\` with a clear reason):`,
            cleanRolePrompt,
          ]
        : []),
      "",
      "STRICT RULES:",
      "- NEVER invent new facts or preferences not present in the source items.",
      "- NEVER drop valid standalone user preferences, identity facts, or standing rules.",
      "- DO NOT merge distinct complementary rules that merely share a broad topic (for example, do NOT merge a platform/account roster with a platform verification workflow).",
      "- Keep `merges` strictly to 2+ sourceIds that say the exact same thing or are mutually contradictory versions of the same rule.",
      "- LOSSLESS ENTITY PRESERVATION: When merging, preserve EVERY concrete account handle (`@xxx`), email, URL, file path, platform name, tool name, and exact number verbatim. If preserving all details makes the merge awkward, DO NOT MERGE — leave both entries separate and only recategorize them.",
      "- Keep `removals` strictly to obvious temporary noise (one-off errors, transient file paths, meaningless chatter) or entries completely redundant with the Bot Role / Persona above.",
      "- Valid categories: \"identity\", \"preference\", \"rule\", \"context\", \"general\".",
      "",
      "Output STRICT JSON ONLY:",
      '{"summary":"concise 1-sentence Chinese summary","merges":[{"sourceIds":["id1","id2"],"name":"<=18 chars","content":"concise merged rule","category":"preference","reason":"why merged"}],"removals":[{"id":"id3","reason":"why temporary noise or persona-duplicate"}],"recategorizations":[{"id":"id4","category":"rule"}]}',
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
      const rejectedMerges: MemoryConsolidationRejectedMerge[] = [];
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
            content.length > MAX_MERGED_MEMORY_CHARS ||
            looksLikeSecretMemory(content) ||
            looksLikeSecretMemory(name) ||
            looksLikePoisonedToolMemory(content) ||
            looksLikePoisonedToolMemory(name)
          ) {
            continue;
          }
          const members = validIds.map((id) => byId.get(id)!);
          const fidelity = analyzeMergeFidelity(members, `${name} ${content}`);
          if (fidelity.isLossy) {
            rejectedMerges.push({
              sourceIds: validIds,
              sourceNames: members.map((x) => x.name),
              beforeChars: fidelity.beforeChars,
              afterChars: content.length,
              shrinkPercent: fidelity.shrinkPercent,
              missingTokens: fidelity.missingTokens,
              reason: `合并压缩遗漏关键实体（${fidelity.missingTokens.slice(0, 5).join(", ")}），已自动拦截保护原条目`,
            });
            continue;
          }
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
            beforeChars: fidelity.beforeChars,
            afterChars: content.length,
            shrinkPercent: fidelity.shrinkPercent,
            missingTokens: fidelity.missingTokens,
            ...(fidelity.shrinkPercent >= 45 ? { highShrinkWarning: true } : {}),
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
      const recategorizations = [
        ...basePlan.recategorizations.filter((r) => !recatMap.has(r.id)),
        ...Array.from(recatMap.entries()).map(([id, category]) => ({ id, category })),
      ];
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
      const diffMeta = buildPlanDiffsAndOps(
        basePlan.originalList,
        merges,
        removals,
        recategorizations,
        finalProposed
      );

      return {
        ok: true,
        plan: {
          scope,
          mode: "llm",
          ...(sessionId ? { sessionId } : {}),
          usedModel: turn?.usedModel || targetModel,
          beforeCount,
          afterCount,
          totalBeforeChars: diffMeta.totalBeforeChars,
          totalAfterChars: diffMeta.totalAfterChars,
          deltaChars: diffMeta.deltaChars,
          changed,
          summary: summaryText,
          originalList: basePlan.originalList,
          merges,
          rejectedMerges,
          removals,
          recategorizations,
          recategorizedCount,
          diffs: diffMeta.diffs,
          ops: diffMeta.ops,
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
