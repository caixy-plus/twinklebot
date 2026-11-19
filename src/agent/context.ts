import type { ContextCompressionSettings } from "../shared/entities.js";
import { DEFAULT_MODEL_CONTEXT_WINDOW } from "../shared/context-compression.js";

export const CONTEXT_SUMMARY_PREFIX = "[Auto Context Summary]";
export const LEGACY_CONTEXT_SUMMARY_PREFIX = "[自动上下文压缩摘要]";

export function isContextSummaryText(text: string): boolean {
  return (
    typeof text === "string" &&
    (text.startsWith(CONTEXT_SUMMARY_PREFIX) ||
      text.startsWith(LEGACY_CONTEXT_SUMMARY_PREFIX))
  );
}
export const DEFAULT_KEEP_SCREENSHOTS = 3;
export const DEFAULT_COMPACT_TOOL_OUTPUT_CHARS = 1200;
export const RECENT_BUDGET_RATIO = 0.4;
export const IN_TURN_MAX_WINDOW_RATIO = 0.92;
export const IN_TURN_HYSTERESIS_MULTIPLIER = 1.15;

const SURROGATE_PAIR_CLEANUP_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Removes unpaired UTF-16 surrogates (often created when truncating text across
 * emoji/CJK surrogate boundaries) so JSON payloads never fail provider UTF-8 checks.
 */
export function sanitizeSurrogates(text: string): string {
  if (typeof text !== "string" || !text) return "";
  return text.replace(SURROGATE_PAIR_CLEANUP_RE, "");
}

const OVERFLOW_ERROR_PATTERNS = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long/i,
  /exceeds (?:the )?(?:model'?s )?(?:context window|maximum context length)/i,
  /context window exceeded/i,
  /context[_ ]length[_ ]exceeded/i,
  /input token count.*exceeds/i,
  /maximum prompt length is \d+/i,
  /maximum context length is \d+/i,
  /exceeded model token limit/i,
  /too large for model/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /reduce the length of the messages/i,
  /range of input length should be/i,
];

const NON_OVERFLOW_ERROR_PATTERNS = [
  /rate[- ]?limit/i,
  /too many requests/i,
  /requests per minute/i,
  /quota exceeded/i,
  /insufficient[_ ]?(?:balance|quota)/i,
];

/**
 * Detects whether an LLM error indicates prompt/context overflow rather than
 * transient rate-limiting or quota exhaustion.
 */
export function isContextOverflowError(err: unknown): boolean {
  const status = Number((err as any)?.status ?? (err as any)?.statusCode ?? 0);
  const msg = String((err as any)?.message ?? err ?? "");
  if (status === 429) return false;
  if (NON_OVERFLOW_ERROR_PATTERNS.some((re) => re.test(msg))) return false;
  if (status === 413) return true;
  return OVERFLOW_ERROR_PATTERNS.some((re) => re.test(msg));
}

const READ_FILE_TOOLS = new Set(["read_file", "host_read_file"]);
const WRITE_FILE_TOOLS = new Set(["write_file", "host_write_file"]);

export interface ExtractedFileOperations {
  readFiles: string[];
  modifiedFiles: string[];
}

/**
 * Deterministically tracks files read/modified across older steps (including
 * prior `[文件操作记录]` sections) so context compaction never loses active file paths.
 */
export function extractFileOperationsFromSteps(steps: any[]): ExtractedFileOperations {
  const readSet = new Set<string>();
  const modifiedSet = new Set<string>();
  if (!Array.isArray(steps) || steps.length === 0) {
    return { readFiles: [], modifiedFiles: [] };
  }

  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    if (step.type === "function_call") {
      const name = String(step.name || "");
      const args = step.arguments ?? step.args;
      const filePath =
        args && typeof args === "object" && typeof args.path === "string"
          ? args.path.trim()
          : "";
      if (!filePath) continue;
      if (WRITE_FILE_TOOLS.has(name)) {
        modifiedSet.add(filePath);
      } else if (READ_FILE_TOOLS.has(name)) {
        readSet.add(filePath);
      }
      continue;
    }
    if (step.type === "user_input" && Array.isArray(step.content)) {
      for (const part of step.content) {
        if (part?.type !== "text" || typeof part.text !== "string") continue;
        if (!isContextSummaryText(part.text)) continue;
        const modMatch = part.text.match(/(?:Modified files|已修改文件)[：:]\s*([^\n]+)/i);
        if (modMatch) {
          for (const item of modMatch[1].split(/[,，]/)) {
            const p = item.trim();
            if (p) modifiedSet.add(p);
          }
        }
        const readMatch = part.text.match(/(?:Read files|已读取文件)[：:]\s*([^\n]+)/i);
        if (readMatch) {
          for (const item of readMatch[1].split(/[,，]/)) {
            const p = item.trim();
            if (p) readSet.add(p);
          }
        }
      }
    }
  }

  // Keep read-only list focused on files not already in modifiedFiles
  const readFiles = [...readSet].filter((p) => !modifiedSet.has(p)).slice(-16);
  const modifiedFiles = [...modifiedSet].slice(-16);
  return { readFiles, modifiedFiles };
}

function appendFileOpsToSummary(summaryText: string, olderSteps: any[]): string {
  const clean = String(summaryText || "").trim();
  if (!clean) return clean;
  const { readFiles, modifiedFiles } = extractFileOperationsFromSteps(olderSteps);
  if (readFiles.length === 0 && modifiedFiles.length === 0) {
    return clean;
  }
  const lines: string[] = [];
  if (modifiedFiles.length > 0 && !/(?:Modified files|已修改文件)[：:]/i.test(clean)) {
    lines.push(`Modified files: ${modifiedFiles.join(", ")}`);
  }
  if (readFiles.length > 0 && !/(?:Read files|已读取文件)[：:]/i.test(clean)) {
    lines.push(`Read files: ${readFiles.join(", ")}`);
  }
  if (lines.length === 0) return clean;
  return `${clean}\n\n[File Operations]\n${lines.join("\n")}`;
}

export function sanitizeOrphanedCalls(input: any[]): any[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [];
  }
  const pendingCallIndices = new Map<string, number[]>();
  const keep = new Array<boolean>(input.length).fill(true);
  let sawMatchedResultInBatch = false;

  const resetPendingBatch = () => {
    pendingCallIndices.clear();
    sawMatchedResultInBatch = false;
  };

  for (let i = 0; i < input.length; i++) {
    const step = input[i];
    if (isRealUserTurnStep(step)) {
      resetPendingBatch();
      continue;
    }
    if (
      step?.type === "thought" ||
      step?.type === "model_output" ||
      step?.type === "text"
    ) {
      if (sawMatchedResultInBatch) {
        resetPendingBatch();
      }
      continue;
    }
    if (step?.type === "function_call") {
      if (sawMatchedResultInBatch) {
        resetPendingBatch();
      }
      keep[i] = false;
      const id = typeof step.id === "string" ? step.id : String(step.id || "");
      if (!id) continue;
      let queue = pendingCallIndices.get(id);
      if (!queue) {
        queue = [];
        pendingCallIndices.set(id, queue);
      }
      queue.push(i);
    } else if (step?.type === "function_result") {
      keep[i] = false;
      const callId =
        typeof step.call_id === "string" ? step.call_id : String(step.call_id || "");
      if (!callId) continue;
      const queue = pendingCallIndices.get(callId);
      if (queue && queue.length > 0) {
        const callIdx = queue.shift()!;
        keep[callIdx] = true;
        keep[i] = true;
        sawMatchedResultInBatch = true;
      }
    }
  }

  return input.filter((_, i) => keep[i]);
}

function isRealUserTurnStep(step: any): boolean {
  return (
    step?.type === "user_input" &&
    !step.content?.some((p: any) => p?.type === "text" && p.text === "Current screen:")
  );
}

export interface HistoryTokenEstimate {
  steps: number;
  chars: number;
  tokens: number;
}

const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;
const CODE_PUNCT_DIGIT_RE = /[{}[\]":,;/\\=<>()+\-*&|!@#$%^~`?\n\r\t0-9]/g;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = Math.max(0, text.length - cjkCount);
  if (nonCjkCount === 0) {
    return Math.ceil(cjkCount * 0.68);
  }
  const symbolMatches = text.match(CODE_PUNCT_DIGIT_RE);
  const symbolCount = Math.min(nonCjkCount, symbolMatches ? symbolMatches.length : 0);
  const proseCount = nonCjkCount - symbolCount;
  return Math.ceil(cjkCount * 0.68 + proseCount * 0.27 + symbolCount * 0.42);
}

/**
 * Lightweight, dependency-free token estimator calibrated for CJK prose, ASCII code, and images.
 */
export function estimateStepTokens(step: any): number {
  if (!step || typeof step !== "object") return 0;
  let tokens = 4; // structural role/type wrapper overhead
  if (Array.isArray(step.content)) {
    for (const part of step.content) {
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") {
        tokens += estimateTextTokens(part.text);
      } else if (part.type === "image") {
        tokens += 768;
      }
    }
  }
  if (typeof step.text === "string") tokens += estimateTextTokens(step.text);
  if (typeof step.result === "string") tokens += estimateTextTokens(step.result);
  if (step.arguments && typeof step.arguments === "object") {
    try {
      tokens += estimateTextTokens(JSON.stringify(step.arguments));
    } catch {
      tokens += 36;
    }
  }
  return tokens;
}

export function estimateHistoryTokens(input: any[]): number {
  if (!Array.isArray(input) || input.length === 0) return 0;
  let total = 0;
  for (const step of input) {
    total += estimateStepTokens(step);
  }
  return total;
}

export function estimateHistoryChars(input: any[]): number {
  if (!Array.isArray(input)) return 0;
  let total = 0;
  for (const step of input) {
    if (!step || typeof step !== "object") continue;
    if (Array.isArray(step.content)) {
      for (const part of step.content) {
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string") {
          total += part.text.length;
        } else if (part.type === "image") {
          total += 1000;
        }
      }
    }
    if (typeof step.text === "string") total += step.text.length;
    if (typeof step.result === "string") total += step.result.length;
    if (step.arguments && typeof step.arguments === "object") {
      try {
        total += JSON.stringify(step.arguments).length;
      } catch {
        total += 120;
      }
    }
  }
  return total;
}

export interface CompressionBudgetOptions {
  contextWindow?: number;
  overheadTokens?: number;
  inTurnStep?: boolean;
  /**
   * Empirical calibration multiplier (>= 1.0) derived from API `usage.input / localEstimatedInput`
   * so dense code/JSON/images never overrun the real tokenizer window.
   */
  tokenScale?: number;
}

export interface ResolvedCompressionBudgets {
  contextWindow: number;
  triggerTokens: number;
  effectiveTriggerTokens: number;
  historyTokenBudget: number;
  recentTokenBudget: number;
}

/**
 * Ignores stale thought steps from earlier completed turns so historical reasoning
 * never inflates the active context occupancy check.
 */
export function estimateEffectiveHistoryTokens(input: any[]): number {
  if (!Array.isArray(input) || input.length === 0) return 0;
  let lastUserTurnIdx = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    if (isRealUserTurnStep(input[i])) {
      lastUserTurnIdx = i;
      break;
    }
  }
  let total = 0;
  for (let i = 0; i < input.length; i++) {
    const step = input[i];
    if (
      i < lastUserTurnIdx &&
      (step?.type === "thought" || step?.type === "thought_signature")
    ) {
      continue;
    }
    total += estimateStepTokens(step);
  }
  return total;
}

export function resolveCompressionTokenBudgets(
  rules: Pick<ContextCompressionSettings, "triggerPercent">,
  options?: CompressionBudgetOptions
): ResolvedCompressionBudgets {
  const contextWindow = Math.max(
    200,
    Math.round(options?.contextWindow || DEFAULT_MODEL_CONTEXT_WINDOW)
  );
  const pct = Math.min(95, Math.max(30, Number(rules?.triggerPercent) || 75));
  const triggerTokens = Math.round(contextWindow * (pct / 100));
  const effectiveTriggerTokens = options?.inTurnStep
    ? Math.max(
        triggerTokens,
        Math.min(
          Math.round(contextWindow * IN_TURN_MAX_WINDOW_RATIO),
          Math.round(triggerTokens * IN_TURN_HYSTERESIS_MULTIPLIER)
        )
      )
    : triggerTokens;
  const tokenScale = Math.min(2.5, Math.max(1, Number(options?.tokenScale) || 1));
  const scaledEffectiveTrigger = Math.round(effectiveTriggerTokens / tokenScale);
  const overheadTokens = Math.max(0, Math.round(options?.overheadTokens || 0));
  const historyTokenBudget = Math.max(50, scaledEffectiveTrigger - overheadTokens);
  const recentTokenBudget = Math.max(
    40,
    Math.floor(historyTokenBudget * RECENT_BUDGET_RATIO)
  );
  return {
    contextWindow,
    triggerTokens,
    effectiveTriggerTokens,
    historyTokenBudget,
    recentTokenBudget,
  };
}

export function shouldCompressContext(
  input: any[],
  rules: ContextCompressionSettings,
  options?: CompressionBudgetOptions
): boolean {
  if (!rules?.enabled || !Array.isArray(input) || input.length === 0) {
    return false;
  }
  const { historyTokenBudget } = resolveCompressionTokenBudgets(rules, options);
  return estimateEffectiveHistoryTokens(input) > historyTokenBudget;
}

export function splitHistoryForCompression(
  input: any[],
  keepRecentTurns: number
): { older: any[]; recent: any[] } {
  const sanitized = sanitizeOrphanedCalls(input);
  if (sanitized.length === 0) {
    return { older: [], recent: [] };
  }
  const keepTurns = Math.max(1, Math.round(keepRecentTurns || 1));
  const userTurnIndices: number[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    if (isRealUserTurnStep(sanitized[i])) {
      userTurnIndices.push(i);
    }
  }
  if (userTurnIndices.length <= keepTurns) {
    return { older: [], recent: sanitized };
  }
  const splitIdx = userTurnIndices[userTurnIndices.length - keepTurns];
  if (splitIdx <= 0) {
    return { older: [], recent: sanitized };
  }
  return {
    older: sanitized.slice(0, splitIdx),
    recent: sanitized.slice(splitIdx),
  };
}

function extractStepTexts(step: any): string {
  const parts: string[] = [];
  if (Array.isArray(step?.content)) {
    for (const part of step.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        const trimmed = part.text.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
  }
  if (typeof step?.text === "string" && step.text.trim()) {
    parts.push(step.text.trim());
  }
  return parts.join("\n").trim();
}

export function splitHistoryForSummary(
  input: any[],
  rules: Pick<ContextCompressionSettings, "triggerPercent">,
  options?: CompressionBudgetOptions
): { older: any[]; recent: any[] } {
  const sanitized = sanitizeOrphanedCalls(input);
  if (sanitized.length === 0) {
    return { older: [], recent: [] };
  }
  const userTurnIndices: number[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    if (isRealUserTurnStep(sanitized[i])) {
      userTurnIndices.push(i);
    }
  }
  if (userTurnIndices.length < 2) {
    return { older: [], recent: sanitized };
  }

  // Reserve a low-watermark share of the trigger budget for verbatim recent turns
  // so a single compression provides a generous Prompt Cache runway.
  const { recentTokenBudget } = resolveCompressionTokenBudgets(rules, options);

  for (let keep = userTurnIndices.length - 1; keep >= 1; keep--) {
    const splitIdx = userTurnIndices[userTurnIndices.length - keep];
    if (splitIdx <= 0) continue;
    const recent = sanitized.slice(splitIdx);
    if (keep === 1 || estimateEffectiveHistoryTokens(recent) <= recentTokenBudget) {
      return {
        older: sanitized.slice(0, splitIdx),
        recent,
      };
    }
  }

  return splitHistoryForCompression(sanitized, 1);
}

/**
 * Bidirectional head+tail folding for oversized tool outputs so both context headers and trailing
 * errors / exit codes remain intact while keeping compacted output strictly below `limit`.
 */
export function compactToolResultText(text: string, limit: number): string {
  if (typeof text !== "string") return "";
  const safeLimit = Math.max(120, Math.round(limit || 800));
  if (
    text.length <= safeLimit ||
    text.includes("[omitted earlier tool output]") ||
    /\.\.\.\[omitted earlier tool output: \d+ chars\]\.\.\./.test(text)
  ) {
    return text;
  }

  const approxOmitted = Math.max(1, text.length - safeLimit + 64);
  const marker = `\n...[omitted earlier tool output: ${approxOmitted} chars]...\n`;
  // Fallback cleanly when safeLimit is tiny
  const maxContent = Math.max(40, safeLimit - 1);
  if (marker.length >= maxContent - 24) {
    const simpleMarker = "...[omitted earlier tool output]";
    const previewLen = Math.max(20, maxContent - simpleMarker.length);
    return `${text.slice(0, previewLen)}${simpleMarker}`;
  }
  const budget = maxContent - marker.length;
  const headLen = Math.max(20, Math.floor(budget * 0.62));
  const tailLen = Math.max(16, budget - headLen);
  const head = sanitizeSurrogates(text.slice(0, headLen));
  const tail = sanitizeSurrogates(text.slice(-tailLen));
  const exactOmitted = Math.max(1, text.length - head.length - tail.length);
  const finalMarker = `\n...[omitted earlier tool output: ${exactOmitted} chars]...\n`;
  if (head.length + finalMarker.length + tail.length <= maxContent) {
    return `${head}${finalMarker}${tail}`;
  }
  const trimTotal = head.length + finalMarker.length + tail.length - maxContent;
  return `${head.slice(0, Math.max(16, head.length - trimTotal))}${finalMarker}${tail}`;
}

export interface IncrementalSummaryInput {
  priorSummary: string;
  deltaTranscript: string;
  fullTranscript: string;
}

function truncateMiddleText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.35);
  const tail = Math.floor(maxChars * 0.6);
  return `${text.slice(0, head)}\n...[middle omitted]...\n${text.slice(-tail)}`;
}

export function prepareIncrementalSummaryInput(
  olderSteps: any[],
  maxChars = 24000
): IncrementalSummaryInput {
  if (!Array.isArray(olderSteps) || olderSteps.length === 0) {
    return { priorSummary: "", deltaTranscript: "", fullTranscript: "" };
  }
  const priorParts: string[] = [];
  const deltaLines: string[] = [];

  for (const step of olderSteps) {
    if (!step || typeof step !== "object") continue;
    if (step.type === "user_input") {
      const joined = extractStepTexts(step);
      if (!joined || joined === "Current screen:" || joined === "Current desktop screen:") {
        continue;
      }
      if (isContextSummaryText(joined)) {
        const prefixLen = joined.startsWith(CONTEXT_SUMMARY_PREFIX)
          ? CONTEXT_SUMMARY_PREFIX.length
          : LEGACY_CONTEXT_SUMMARY_PREFIX.length;
        const cleaned = joined
          .slice(prefixLen)
          .replace(/^\s*(?:The following is an auto-compressed summary[^\n:]*:|以下是较早对话的自动压缩摘要[^：\n]*[：:]?)\s*/i, "")
          .trim();
        if (cleaned) priorParts.push(cleaned);
      } else {
        deltaLines.push(`User: ${joined.slice(0, 1200)}`);
      }
    } else if (step.type === "model_output" || step.type === "text") {
      const joined = extractStepTexts(step);
      if (joined) {
        deltaLines.push(`Assistant: ${joined.slice(0, 1200)}`);
      }
    } else if (step.type === "function_call" && step.name) {
      let argsPreview = "";
      try {
        argsPreview = JSON.stringify(step.arguments || {}).slice(0, 240);
      } catch {
        argsPreview = "";
      }
      deltaLines.push(`ToolCall ${step.name}(${argsPreview})`);
    } else if (step.type === "function_result" && typeof step.result === "string") {
      const preview = compactToolResultText(step.result, 500);
      deltaLines.push(`ToolResult(${step.name || "tool"}): ${preview}`);
    }
  }

  const priorSummary = priorParts.join("\n").trim().slice(0, 3200);
  const rawDelta = deltaLines.join("\n").trim();
  const deltaBudget = priorSummary ? Math.max(4000, maxChars - priorSummary.length - 200) : maxChars;
  const deltaTranscript = truncateMiddleText(rawDelta, deltaBudget);
  const fullParts: string[] = [];
  if (priorSummary) fullParts.push(`PriorSummary: ${priorSummary}`);
  if (deltaTranscript) fullParts.push(deltaTranscript);

  return {
    priorSummary,
    deltaTranscript,
    fullTranscript: truncateMiddleText(fullParts.join("\n"), maxChars),
  };
}

export function buildCompressionTranscript(
  olderSteps: any[],
  maxChars = 24000
): string {
  return prepareIncrementalSummaryInput(olderSteps, maxChars).fullTranscript;
}

export function applyCompressedSummary(
  summaryText: string,
  recentSteps: any[]
): any[] {
  const cleanSummary = String(summaryText || "").trim();
  const safeRecent = Array.isArray(recentSteps) ? recentSteps : [];
  if (!cleanSummary) return safeRecent;
  const summaryStep = {
    type: "user_input",
    content: [
      {
        type: "text",
        text: `${CONTEXT_SUMMARY_PREFIX}\nThe following is an auto-compressed summary of earlier conversation turns. Use it as background context to continue the current task:\n${cleanSummary}`,
      },
    ],
  };
  return [summaryStep, ...safeRecent];
}

export function pruneScreenshots(input: any[], keep?: number): any[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const keepCount = Math.max(0, typeof keep === "number" ? keep : 0);

  // Count total image parts across all steps
  let totalImages = 0;
  for (const step of input) {
    if (step && Array.isArray(step.content)) {
      for (const part of step.content) {
        if (part && part.type === "image") {
          totalImages++;
        }
      }
    }
  }

  const pruneCount = Math.max(0, totalImages - keepCount);
  let seenImages = 0;

  return input.map((step) => {
    if (!step || !Array.isArray(step.content)) {
      return step && typeof step === "object" ? { ...step } : step;
    }

    const newContent = step.content.map((part: any) => {
      if (part && part.type === "image") {
        seenImages++;
        if (seenImages <= pruneCount) {
          return {
            type: "text",
            text: "[screenshot from an earlier step omitted]",
          };
        }
      }
      return part && typeof part === "object" ? { ...part } : part;
    });

    return {
      ...step,
      content: newContent,
    };
  });
}

/**
 * Deterministic zero-LLM extractive summary builder used when strategy === "trim" or LLM summarization fails.
 */
export function buildExtractiveFallbackSummary(
  olderSteps: any[],
  maxChars = 1600
): string {
  if (!Array.isArray(olderSteps) || olderSteps.length === 0) return "";
  const { priorSummary } = prepareIncrementalSummaryInput(olderSteps, 12000);

  const userRequests: string[] = [];
  const assistantNotes: string[] = [];
  const toolNames = new Set<string>();
  const fileRefs = new Set<string>();
  const FILE_REF_RE = /\b(?:src|test|public|dist|executor|scripts|data)\/[\w./-]+\b/g;

  for (const step of olderSteps) {
    if (!step || typeof step !== "object") continue;
    if (step.type === "user_input") {
      const txt = extractStepTexts(step);
      if (
        txt &&
        !isContextSummaryText(txt) &&
        txt !== "Current screen:" &&
        txt !== "Current desktop screen:"
      ) {
        const compact = txt.replace(/\s+/g, " ").trim();
        userRequests.push(compact.length > 140 ? `${compact.slice(0, 137)}...` : compact);
        for (const m of compact.match(FILE_REF_RE) || []) fileRefs.add(m);
      }
    } else if (step.type === "model_output" || step.type === "text") {
      const txt = extractStepTexts(step);
      if (txt) {
        const compact = txt.replace(/\s+/g, " ").trim();
        const snippet =
          compact.length > 180
            ? `${compact.slice(0, 95)} ... ${compact.slice(-75)}`
            : compact;
        assistantNotes.push(snippet);
        for (const m of compact.match(FILE_REF_RE) || []) fileRefs.add(m);
      }
    } else if (step.type === "function_call" && step.name) {
      toolNames.add(String(step.name));
      try {
        for (const m of JSON.stringify(step.arguments || {}).match(FILE_REF_RE) || []) {
          fileRefs.add(m);
        }
      } catch {
        // ignore
      }
    }
  }

  const sections: string[] = [];
  if (priorSummary) {
    sections.push(`[Carried-Over Prior Summary]\n${priorSummary.slice(0, Math.floor(maxChars * 0.45))}`);
  }
  if (userRequests.length > 0) {
    const keptReqs = userRequests.slice(-6).map((r, i) => `${i + 1}. ${r}`).join("\n");
    sections.push(`[Earlier User Instructions]\n${keptReqs}`);
  }
  if (assistantNotes.length > 0) {
    const keptNotes = assistantNotes.slice(-4).map((n) => `- ${n}`).join("\n");
    sections.push(`[Key Assistant Replies]\n${keptNotes}`);
  }
  const metaParts: string[] = [];
  if (fileRefs.size > 0) metaParts.push(`Paths: ${[...fileRefs].slice(0, 10).join(", ")}`);
  if (toolNames.size > 0) metaParts.push(`Tools called: ${[...toolNames].slice(0, 8).join(", ")}`);
  if (metaParts.length > 0) {
    sections.push(`[Files & Tools]\n${metaParts.join("; ")}`);
  }

  const combined = sections.join("\n\n").trim();
  if (!combined) return "";
  return combined.length <= maxChars
    ? combined
    : `${combined.slice(0, Math.max(80, maxChars - 3))}...`;
}

/**
 * Compact prior-turn thoughts and oversized tool outputs (and older in-turn tool outputs in
 * long Hot/Warm tool chains) without dropping any conversation turns.
 */
export function compactHistorySteps(
  input: any[],
  compactToolOutputChars = 800,
  options?: { keepRecentToolCalls?: number }
): any[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [];
  }

  const sanitized = sanitizeOrphanedCalls(input);
  const compactLimit = Math.max(200, Math.round(compactToolOutputChars));
  const inTurnWarmLimit = Math.max(compactLimit * 2, 2400);
  const keepRecentToolCalls = Math.max(2, options?.keepRecentToolCalls ?? 4);

  let lastUserTurnIdx = 0;
  for (let i = sanitized.length - 1; i >= 0; i--) {
    if (isRealUserTurnStep(sanitized[i])) {
      lastUserTurnIdx = i;
      break;
    }
  }

  const activeTurnToolResultIndices: number[] = [];
  for (let i = lastUserTurnIdx + 1; i < sanitized.length; i++) {
    if (sanitized[i]?.type === "function_result") {
      activeTurnToolResultIndices.push(i);
    }
  }
  const hotToolResultStartIdx =
    activeTurnToolResultIndices.length > keepRecentToolCalls
      ? activeTurnToolResultIndices[activeTurnToolResultIndices.length - keepRecentToolCalls]
      : sanitized.length;

  const compacted: any[] = [];
  for (let idx = 0; idx < sanitized.length; idx++) {
    const step = sanitized[idx];
    if (
      idx < lastUserTurnIdx &&
      (step?.type === "thought" || step?.type === "thought_signature")
    ) {
      continue;
    }
    if (
      idx < lastUserTurnIdx &&
      step?.type === "function_result" &&
      typeof step.result === "string" &&
      step.result.length > compactLimit
    ) {
      compacted.push({
        ...step,
        result: compactToolResultText(step.result, compactLimit),
      });
      continue;
    }
    if (
      idx > lastUserTurnIdx &&
      idx < hotToolResultStartIdx &&
      activeTurnToolResultIndices.length > 8 &&
      step?.type === "function_result" &&
      typeof step.result === "string" &&
      step.result.length > inTurnWarmLimit
    ) {
      compacted.push({
        ...step,
        result: compactToolResultText(step.result, inTurnWarmLimit),
      });
      continue;
    }
    compacted.push(step);
  }
  return compacted;
}

function collectTurnAnchorIndices(steps: any[]): number[] {
  const realTurns: number[] = [];
  const allUserInputs: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.type === "user_input") {
      allUserInputs.push(i);
      if (isRealUserTurnStep(steps[i])) {
        realTurns.push(i);
      }
    }
  }
  return realTurns.length > 0 ? realTurns : allUserInputs;
}

export interface CompressContextResult {
  changed: boolean;
  history: any[];
  strategy: "summary" | "trim";
  mode: "compact" | "summary" | "extractive-trim";
  beforeSteps: number;
  afterSteps: number;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
}

export async function compressContextHistory(
  input: any[],
  rules: ContextCompressionSettings,
  options?: CompressionBudgetOptions & {
    keepScreenshots?: number;
    force?: boolean;
    summarize?: (
      transcript: string,
      meta?: { priorSummary: string; deltaTranscript: string }
    ) => Promise<string>;
  }
): Promise<CompressContextResult> {
  const beforeSteps = Array.isArray(input) ? input.length : 0;
  const beforeChars = estimateHistoryChars(input);
  const beforeTokens = estimateHistoryTokens(input);
  const budgetOpts: CompressionBudgetOptions = {
    contextWindow: options?.contextWindow,
    overheadTokens: options?.overheadTokens,
    inTurnStep: options?.inTurnStep,
    tokenScale: options?.tokenScale,
  };

  if (!options?.force && !shouldCompressContext(input, rules, budgetOpts)) {
    return {
      changed: false,
      history: input,
      strategy: "summary",
      mode: "compact",
      beforeSteps,
      afterSteps: beforeSteps,
      beforeChars,
      afterChars: beforeChars,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  const keepScreens = options?.keepScreenshots ?? DEFAULT_KEEP_SCREENSHOTS;
  const screenPruned = pruneScreenshots(input, keepScreens);
  // Stage 1: lossless/warm compaction without dropping any conversation turn
  const compacted = compactHistorySteps(screenPruned, DEFAULT_COMPACT_TOOL_OUTPUT_CHARS);
  if (!options?.force && !shouldCompressContext(compacted, rules, budgetOpts)) {
    const afterChars = estimateHistoryChars(compacted);
    const afterTokens = estimateHistoryTokens(compacted);
    const changed = compacted.length < beforeSteps || afterTokens < beforeTokens;
    return {
      changed,
      history: changed ? compacted : input,
      strategy: "trim",
      mode: "compact",
      beforeSteps,
      afterSteps: compacted.length,
      beforeChars,
      afterChars,
      beforeTokens,
      afterTokens: changed ? afterTokens : beforeTokens,
    };
  }

  const { historyTokenBudget } = resolveCompressionTokenBudgets(rules, budgetOpts);
  const { older, recent } = splitHistoryForSummary(compacted, rules, budgetOpts);
  const maxRecentTokens = Math.max(200, Math.floor(historyTokenBudget * 0.85));
  const boundRecent = (steps: any[]) =>
    estimateEffectiveHistoryTokens(steps) > maxRecentTokens
      ? trimHistoryToTokenBudget(steps, maxRecentTokens, {
          compactToolOutputChars: DEFAULT_COMPACT_TOOL_OUTPUT_CHARS,
        })
      : steps;

  // Stage 2: Incremental structured LLM summary compression
  if (typeof options?.summarize === "function" && older.length > 0) {
    const inc = prepareIncrementalSummaryInput(older);
    if (inc.fullTranscript) {
      try {
        const summaryText = String(
          (await options.summarize(inc.fullTranscript, {
            priorSummary: inc.priorSummary,
            deltaTranscript: inc.deltaTranscript,
          })) || ""
        ).trim();
        if (summaryText) {
          const enrichedSummary = appendFileOpsToSummary(summaryText, older);
          const merged = applyCompressedSummary(enrichedSummary, boundRecent(recent));
          return {
            changed: true,
            history: merged,
            strategy: "summary",
            mode: "summary",
            beforeSteps,
            afterSteps: merged.length,
            beforeChars,
            afterChars: estimateHistoryChars(merged),
            beforeTokens,
            afterTokens: estimateHistoryTokens(merged),
          };
        }
      } catch {
        // Fall through to zero-LLM extractive archive below
      }
    }
  }

  // Stage 3: Deterministic zero-LLM extractive fallback before token-budget trim
  if (older.length > 0) {
    const extractive = buildExtractiveFallbackSummary(older);
    if (extractive) {
      const enrichedExtractive = appendFileOpsToSummary(extractive, older);
      const merged = applyCompressedSummary(enrichedExtractive, boundRecent(recent));
      const afterTokens = estimateHistoryTokens(merged);
      const changed = merged.length < beforeSteps || afterTokens < beforeTokens;
      if (changed) {
        return {
          changed: true,
          history: merged,
          strategy: "trim",
          mode: "extractive-trim",
          beforeSteps,
          afterSteps: merged.length,
          beforeChars,
          afterChars: estimateHistoryChars(merged),
          beforeTokens,
          afterTokens,
        };
      }
    }
  }

  const trimmed = trimHistoryToTokenBudget(compacted, historyTokenBudget, {
    compactToolOutputChars: DEFAULT_COMPACT_TOOL_OUTPUT_CHARS,
  });
  const afterTokens = estimateHistoryTokens(trimmed);
  const changed = trimmed.length < beforeSteps || afterTokens < beforeTokens;
  return {
    changed,
    history: changed ? trimmed : input,
    strategy: "trim",
    mode: "extractive-trim",
    beforeSteps,
    afterSteps: trimmed.length,
    beforeChars,
    afterChars: estimateHistoryChars(trimmed),
    beforeTokens,
    afterTokens: changed ? afterTokens : beforeTokens,
  };
}

export function trimHistoryToTokenBudget(
  input: any[],
  maxTokens: number,
  options?: { compactToolOutputChars?: number }
): any[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [];
  }
  const safeMaxTokens = Math.max(50, Math.round(maxTokens || 24_000));
  const compacted = compactHistorySteps(
    input,
    options?.compactToolOutputChars ?? DEFAULT_COMPACT_TOOL_OUTPUT_CHARS
  );
  if (estimateEffectiveHistoryTokens(compacted) <= safeMaxTokens) {
    return compacted;
  }

  const turnIndices = collectTurnAnchorIndices(compacted);
  const minAnchorIdx =
    turnIndices.length >= 2
      ? turnIndices[turnIndices.length - 2]
      : (turnIndices[0] ?? 0);

  // Drop oldest turn slices first while preserving at least the latest turn (or 2 turns if affordable)
  let sliced = compacted;
  for (const idx of turnIndices) {
    if (idx > minAnchorIdx) break;
    const candidate = compacted.slice(idx);
    sliced = candidate;
    if (estimateEffectiveHistoryTokens(candidate) <= safeMaxTokens) {
      return sanitizeOrphanedCalls(candidate);
    }
  }
  if (turnIndices.length >= 2) {
    const latestOnly = compacted.slice(turnIndices[turnIndices.length - 1]);
    if (estimateEffectiveHistoryTokens(latestOnly) <= safeMaxTokens) {
      return sanitizeOrphanedCalls(latestOnly);
    }
    if (estimateEffectiveHistoryTokens(latestOnly) < estimateEffectiveHistoryTokens(sliced)) {
      sliced = latestOnly;
    }
  }

  // Within a single mega-turn, remove stale thoughts and oldest paired tool calls/results in O(N)
  const base = sanitizeOrphanedCalls(sliced);
  const slicedTurns = collectTurnAnchorIndices(base);
  const latestTurnIdx = slicedTurns[slicedTurns.length - 1] ?? 0;

  const stepEffectiveTokens = new Array<number>(base.length);
  let runningTokens = 0;
  for (let i = 0; i < base.length; i++) {
    const step = base[i];
    const isStaleThought =
      i < latestTurnIdx &&
      (step?.type === "thought" || step?.type === "thought_signature");
    const t = isStaleThought ? 0 : estimateStepTokens(step);
    stepEffectiveTokens[i] = t;
    runningTokens += t;
  }

  const removableThoughtGroups: number[][] = [];
  const toolGroupsById = new Map<string, number[]>();
  const orderedToolGroups: number[][] = [];

  for (let i = 0; i < base.length; i++) {
    const step = base[i];
    if (step?.type === "function_call") {
      const key = step.id ? `call:${step.id}` : `idx:${i}`;
      let grp = toolGroupsById.get(key);
      if (!grp) {
        grp = [];
        toolGroupsById.set(key, grp);
        orderedToolGroups.push(grp);
      }
      grp.push(i);
    } else if (step?.type === "function_result") {
      const key = step.call_id ? `call:${step.call_id}` : `idx:${i}`;
      let grp = toolGroupsById.get(key);
      if (!grp) {
        grp = [];
        toolGroupsById.set(key, grp);
        orderedToolGroups.push(grp);
      }
      grp.push(i);
    } else if (
      i < latestTurnIdx &&
      (step?.type === "thought" || step?.type === "thought_signature")
    ) {
      removableThoughtGroups.push([i]);
    }
  }

  const dropSet = new Set<number>();
  for (const grp of [...removableThoughtGroups, ...orderedToolGroups]) {
    if (runningTokens <= safeMaxTokens) {
      break;
    }
    for (const idx of grp) {
      if (!dropSet.has(idx)) {
        dropSet.add(idx);
        runningTokens -= stepEffectiveTokens[idx];
      }
    }
  }
  if (dropSet.size === 0) {
    return base;
  }
  return sanitizeOrphanedCalls(base.filter((_, i) => !dropSet.has(i)));
}

export function trimHistory(
  input: any[],
  maxSteps = 24,
  options?: { compactToolOutputChars?: number }
): any[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [];
  }

  const safeMaxSteps = Math.max(2, Math.round(maxSteps || 24));
  // Compact stale prior-turn thoughts and long tool outputs BEFORE counting steps
  const compacted = compactHistorySteps(
    input,
    options?.compactToolOutputChars ?? 800
  );
  if (compacted.length <= safeMaxSteps) {
    return compacted;
  }

  const turnIndices = collectTurnAnchorIndices(compacted);
  const minAnchorIdx =
    turnIndices.length >= 2
      ? turnIndices[turnIndices.length - 2]
      : (turnIndices[0] ?? 0);

  const targetStart = Math.max(0, compacted.length - safeMaxSteps);
  let cutIdx = turnIndices.find((idx) => idx >= targetStart && idx <= minAnchorIdx);
  if (cutIdx === undefined) {
    cutIdx = minAnchorIdx;
  }

  const sliced = compacted.slice(cutIdx);
  if (sliced.length <= safeMaxSteps) {
    return sanitizeOrphanedCalls(sliced);
  }

  // When recent 1-2 turns still exceed maxSteps (tool-heavy turn), prune oldest intermediate
  // steps first while protecting BOTH user prompts AND the immediate recent tail of the active turn
  // so the model never loses the tool calls/results it just executed (preventing mid-turn amnesia loops).
  const slicedTurns = collectTurnAnchorIndices(sliced);
  const latestTurnIdx = slicedTurns[slicedTurns.length - 1] ?? 0;
  const protectedTailCount = Math.min(10, Math.max(4, Math.floor(safeMaxSteps * 0.4)));
  const protectedTailStart = Math.max(latestTurnIdx + 1, sliced.length - protectedTailCount);

  const priorTurnThoughtIndices: number[] = [];
  const priorTurnToolIndices: number[] = [];
  const activeTurnOldIndices: number[] = [];

  for (let i = 0; i < sliced.length; i++) {
    const step = sliced[i];
    if (i < latestTurnIdx) {
      if (step?.type === "thought" || step?.type === "thought_signature") {
        priorTurnThoughtIndices.push(i);
      } else if (step?.type === "function_call" || step?.type === "function_result") {
        priorTurnToolIndices.push(i);
      }
    } else if (i > latestTurnIdx && i < protectedTailStart && !isRealUserTurnStep(step)) {
      activeTurnOldIndices.push(i);
    }
  }

  const dropSet = new Set<number>();
  let remaining = sliced.length;
  for (const idx of [
    ...priorTurnThoughtIndices,
    ...priorTurnToolIndices,
    ...activeTurnOldIndices,
  ]) {
    if (remaining <= safeMaxSteps) break;
    dropSet.add(idx);
    remaining--;
  }

  let pruned = sanitizeOrphanedCalls(sliced.filter((_, idx) => !dropSet.has(idx)));
  if (pruned.length > safeMaxSteps) {
    // Still over budget: drop oldest non-user-turn steps from the front while preserving user turn anchors
    const result: any[] = [];
    let excess = pruned.length - safeMaxSteps;
    for (let i = 0; i < pruned.length; i++) {
      if (excess > 0 && i < pruned.length - 4 && !isRealUserTurnStep(pruned[i])) {
        excess--;
        continue;
      }
      result.push(pruned[i]);
    }
    pruned = sanitizeOrphanedCalls(result);
  }
  return pruned;
}
