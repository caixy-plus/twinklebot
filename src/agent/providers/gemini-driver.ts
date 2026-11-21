import { GoogleGenAI } from "@google/genai";
import type {
  ImageGenerationResult,
  ModelTurnResult,
  TokenUsage,
} from "../../shared/config.js";
import {
  isModelUnavailableError,
  isPermanentModelError,
  markModelUnavailable,
} from "../router.js";

export function extractInteractionSteps(res: any): any[] {
  if (Array.isArray(res?.steps) && res.steps.length > 0) return res.steps;
  if (Array.isArray(res?.outputs) && res.outputs.length > 0) return res.outputs;
  return Array.isArray(res?.steps)
    ? res.steps
    : Array.isArray(res?.outputs)
      ? res.outputs
      : [];
}

export function parseToolArguments(rawArgs: unknown): {
  args: Record<string, unknown>;
  parseError?: string;
} {
  if (rawArgs === undefined || rawArgs === null || rawArgs === "") {
    return { args: {} };
  }
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    if (!trimmed) return { args: {} };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown> };
      }
      return {
        args: {},
        parseError: `Tool arguments must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      };
    } catch (err: any) {
      return {
        args: {},
        parseError: `Invalid JSON tool arguments: ${err?.message || "parse failed"}`,
      };
    }
  }
  if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return { args: rawArgs as Record<string, unknown> };
  }
  return {
    args: {},
    parseError: `Tool arguments must be an object, got ${Array.isArray(rawArgs) ? "array" : typeof rawArgs}`,
  };
}

export function inferImageMimeType(base64Data = "", explicitMime = ""): string {
  const cleanMime = String(explicitMime || "").split(";")[0].trim().toLowerCase();
  if (cleanMime.startsWith("image/") || cleanMime === "application/pdf") {
    return cleanMime;
  }
  const head = String(base64Data || "").trim().slice(0, 24);
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("UklGR")) return "image/webp";
  if (head.startsWith("R0lGOD")) return "image/gif";
  if (head.startsWith("Qk")) return "image/bmp";
  if (head.startsWith("JVBERi")) return "application/pdf";
  if (head.startsWith("PHN2Zw") || head.startsWith("PD94bWw")) return "image/svg+xml";
  return "image/png";
}

export function extractGeminiUsage(res: any): TokenUsage {
  const rawInput =
    res?.usage?.total_input_tokens ?? res?.usage?.input_tokens ?? 0;
  const rawOutput =
    res?.usage?.total_output_tokens ?? res?.usage?.output_tokens ?? 0;
  const rawCached = res?.usage?.total_cached_tokens ?? 0;
  const rawThoughts = res?.usage?.total_thought_tokens ?? 0;
  const rawTotal = res?.usage?.total_tokens;

  const billableOutput =
    typeof rawTotal === "number" && rawTotal > rawInput + rawOutput
      ? rawTotal - rawInput
      : rawOutput;

  return {
    input: rawInput,
    output: billableOutput,
    ...(rawCached > 0 ? { cached: rawCached } : {}),
    ...(rawThoughts > 0 ? { thoughts: rawThoughts } : {}),
  };
}

function isInvalidThoughtSignatureError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || "");
  return /invalid[\s_]+thought[\s_]+signature|thought[\s_]+signature/i.test(msg);
}

function isGeminiInvalidArgumentError(err: unknown): boolean {
  const status = Number((err as any)?.status ?? (err as any)?.statusCode ?? 0);
  const msg = String((err as any)?.message || err || "");
  if (status === 400) return true;
  return /\b400\b.*(?:invalid[\s_]+argument|bad[\s_]+request)|request contains an invalid argument/i.test(
    msg
  );
}

function normalizeTextParts(content: any): any[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.length > 0) {
        out.push({ type: "text", text: part.text });
      }
      continue;
    }
    out.push(part);
  }
  return out;
}

function formatPlainArgValue(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "string") {
    const clean = val.replace(/\s+/g, " ").trim();
    return clean.length > 100 ? `"${clean.slice(0, 100)}…"` : `"${clean}"`;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  if (Array.isArray(val)) {
    return `[${val.length} items]`;
  }
  if (typeof val === "object") {
    const keys = Object.keys(val as Record<string, unknown>);
    return `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
  }
  return String(val);
}

function summarizeFunctionCallForNote(fc: any): string {
  const name = String(fc?.name || "tool");
  const rawArgs = fc?.arguments;
  let argSummary = "";
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    const entries = Object.entries(rawArgs);
    if (entries.length > 0) {
      const shown = entries.slice(0, 8).map(([k, v]) => `${k}=${formatPlainArgValue(v)}`);
      if (entries.length > 8) shown.push(`+${entries.length - 8} more`);
      argSummary = shown.join(", ");
      if (argSummary.length > 360) argSummary = `${argSummary.slice(0, 360)}…`;
    }
  } else if (typeof rawArgs === "string" && rawArgs.trim()) {
    const clean = rawArgs.replace(/\s+/g, " ").trim();
    argSummary = clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
  }
  return argSummary
    ? `Earlier step ran tool "${name}" (${argSummary}).`
    : `Earlier step ran tool "${name}".`;
}

function extractFunctionResultParts(fr: any): any[] {
  const name = String(fr?.name || "tool");
  const raw = fr?.result;
  const parts: any[] = [];
  if (typeof raw === "string") {
    const trimmed = raw.length > 8000 ? `${raw.slice(0, 8000)}…` : raw;
    parts.push({ type: "text", text: `Output from "${name}": ${trimmed || "(empty)"}` });
    return parts;
  }
  if (Array.isArray(raw)) {
    const textChunks: string[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") {
        textChunks.push(item.text);
      } else if (item.type === "image" && item.data) {
        parts.push(item);
      }
    }
    const joined = textChunks.join("\n");
    const clipped = joined.length > 8000 ? `${joined.slice(0, 8000)}…` : joined;
    parts.unshift({ type: "text", text: `Output from "${name}": ${clipped || "(ok)"}` });
    return parts;
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(raw ?? {});
  } catch {
    serialized = String(raw ?? "");
  }
  if (serialized.length > 8000) serialized = `${serialized.slice(0, 8000)}…`;
  parts.push({ type: "text", text: `Output from "${name}": ${serialized || "(ok)"}` });
  return parts;
}

function pushMergedStep(out: any[], step: any): void {
  if (!step || typeof step !== "object") return;
  if (step.type === "model_output" || step.type === "user_input") {
    const parts = normalizeTextParts(step.content ?? step.text);
    if (parts.length === 0) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === step.type && Array.isArray(prev.content)) {
      prev.content = [...prev.content, ...parts];
      return;
    }
    out.push({ type: step.type, content: parts });
    return;
  }
  out.push(step);
}

/**
 * Sanitize shared multi-provider history into a strictly valid Gemini Interactions API `input`:
 * 1. Drops unsigned `thought` steps (e.g. DeepSeek/OpenAI `reasoning_content`).
 * 2. Preserves Gemini-native signed tool turns (`[thought(sig), (optional model_output), function_call..., function_result...]`)
 *    intact so Prompt Cache & Gemini reasoning continuity are preserved.
 * 3. Folds cross-provider unsigned `function_call` + `function_result` turns (e.g. DeepSeek -> Gemini
 *    escalation) into plain-language `user_input` execution notes — NEVER injecting pseudo-syntax
 *    `[Tool call ...({...}…)]` into `model_output`, which otherwise poisons Gemini into imitating
 *    plain-text tool calls or emitting `malformed_tool_call` invalid JSON.
 * 4. Merges consecutive same-role text steps and drops empty content blocks.
 */
export function sanitizeInputForGemini(
  input: any,
  {
    stripAllThoughts = false,
    foldUnsignedToolTurns = true,
  }: { stripAllThoughts?: boolean; foldUnsignedToolTurns?: boolean } = {}
): any {
  if (!Array.isArray(input)) return input;

  // Step 1: filter raw thoughts and strip signatures when requested
  const filtered: any[] = [];
  for (const step of input) {
    if (!step || typeof step !== "object") continue;
    if (step.type === "thought" || step.type === "thought_signature") {
      if (stripAllThoughts) continue;
      if (typeof step.signature !== "string" || !step.signature.trim()) continue;
      filtered.push(step);
      continue;
    }
    if (stripAllThoughts && "signature" in step) {
      const { signature: _ignored, ...rest } = step;
      filtered.push(rest);
      continue;
    }
    filtered.push(step);
  }

  if (!foldUnsignedToolTurns) {
    return filtered;
  }

  // Step 2: walk steps; preserve Gemini-native signed turns (including thought(sig) -> model_output -> function_call),
  // and fold unsigned cross-provider tool turns cleanly into user_input execution notes.
  const out: any[] = [];
  let turnHasSignedThought = false;
  let i = 0;
  while (i < filtered.length) {
    const step = filtered[i];

    if (step.type === "thought") {
      out.push(step);
      turnHasSignedThought =
        !stripAllThoughts &&
        typeof step.signature === "string" &&
        step.signature.trim().length > 0;
      i += 1;
      continue;
    }

    if (step.type === "function_call") {
      // Collect consecutive function_call steps in this model turn
      const calls: any[] = [];
      while (i < filtered.length && filtered[i]?.type === "function_call") {
        calls.push(filtered[i]);
        i += 1;
      }
      // Collect immediately following function_result steps
      const results: any[] = [];
      const callIds = new Set(calls.map((c) => String(c.id || "")).filter(Boolean));
      while (
        i < filtered.length &&
        filtered[i]?.type === "function_result" &&
        (callIds.size === 0 || !filtered[i].call_id || callIds.has(String(filtered[i].call_id)))
      ) {
        results.push(filtered[i]);
        i += 1;
      }

      if (!stripAllThoughts && turnHasSignedThought) {
        for (const fc of calls) out.push(fc);
        for (const fr of results) out.push(fr);
      } else {
        // Place folded tool call + result notes in user_input (never model_output) so Gemini
        // never learns to mimic pseudo-tool-call syntax or truncated JSON from prior assistant turns.
        const foldedParts: any[] = [];
        const callSummary = calls.map(summarizeFunctionCallForNote).join("\n");
        if (callSummary) {
          foldedParts.push({ type: "text", text: callSummary });
        }
        for (const fr of results) {
          foldedParts.push(...extractFunctionResultParts(fr));
        }
        if (foldedParts.length > 0) {
          pushMergedStep(out, {
            type: "user_input",
            content: foldedParts,
          });
        }
      }
      turnHasSignedThought = false;
      continue;
    }

    if (step.type === "function_result") {
      // Stray/unpaired function_result -> fold safely as user_input
      pushMergedStep(out, {
        type: "user_input",
        content: extractFunctionResultParts(step),
      });
      turnHasSignedThought = false;
      i += 1;
      continue;
    }

    if (step.type === "text") {
      pushMergedStep(out, {
        type: "model_output",
        content: normalizeTextParts(step.content ?? step.text),
      });
      i += 1;
      continue;
    }

    if (step.type === "user_input") {
      turnHasSignedThought = false;
    }

    pushMergedStep(out, step);
    i += 1;
  }

  return out;
}

function extractInteractionErrors(res: any): Array<{ code: string; message: string }> {
  if (!Array.isArray(res?.errors)) return [];
  return res.errors
    .filter((e: any) => e && typeof e === "object")
    .map((e: any) => ({
      code: String(e.code || "").trim(),
      message: String(e.message || e.detail || "").trim(),
    }))
    .filter((e: { code: string; message: string }) => Boolean(e.code || e.message));
}

function formatInteractionErrors(res: any): string {
  const errs = extractInteractionErrors(res);
  if (errs.length === 0) return "";
  return errs
    .map((e) => (e.code && e.message ? `${e.code}: ${e.message}` : e.code || e.message))
    .join("; ");
}

function mergeTokenUsage(a: TokenUsage | null | undefined, b: TokenUsage | null | undefined): TokenUsage {
  const input = (a?.input ?? 0) + (b?.input ?? 0);
  const output = (a?.output ?? 0) + (b?.output ?? 0);
  const cached = (a?.cached ?? 0) + (b?.cached ?? 0);
  const thoughts = (a?.thoughts ?? 0) + (b?.thoughts ?? 0);
  return {
    input,
    output,
    ...(cached > 0 ? { cached } : {}),
    ...(thoughts > 0 ? { thoughts } : {}),
  };
}

function appendRetryNoticeToInput(baseInput: any, noticeText: string): any {
  const noticePart = { type: "text", text: noticeText };
  if (typeof baseInput === "string") {
    return `${baseInput}\n\n${noticeText}`;
  }
  if (!Array.isArray(baseInput)) {
    return [{ type: "user_input", content: [noticePart] }];
  }
  const cloned = baseInput.map((step) =>
    step && typeof step === "object" && Array.isArray(step.content)
      ? { ...step, content: [...step.content] }
      : step
  );
  pushMergedStep(cloned, { type: "user_input", content: [noticePart] });
  return cloned;
}

function shouldRetryInteractionResponse(res: any): { retry: boolean; reason: string; isMalformedToolCall: boolean } {
  const status = String(res?.status || "").trim().toLowerCase();
  const steps = extractInteractionSteps(res);
  const errs = extractInteractionErrors(res);
  const hasOutputText = typeof res?.output_text === "string" && res.output_text.trim().length > 0;
  const isMalformedToolCall = errs.some(
    (e) =>
      /malformed_tool_call/i.test(e.code) ||
      /invalid\s+json\s+syntax|malformed.*tool|could\s+not\s+be\s+parsed/i.test(e.message)
  );
  if (isMalformedToolCall) {
    return {
      retry: true,
      reason: formatInteractionErrors(res) || "malformed_tool_call",
      isMalformedToolCall: true,
    };
  }
  if (status === "failed" && steps.length === 0) {
    return {
      retry: true,
      reason: formatInteractionErrors(res) || "interaction status failed with empty steps",
      isMalformedToolCall: false,
    };
  }
  if ((status === "" || status === "completed") && steps.length === 0 && !hasOutputText) {
    return {
      retry: true,
      reason: "interaction completed with empty output",
      isMalformedToolCall: false,
    };
  }
  return { retry: false, reason: "", isMalformedToolCall: false };
}

export interface CreateGeminiDriverOptions {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  baseUrl?: string;
  client?: any;
  timeoutMs?: number;
}

export function createGeminiDriver({
  apiKey,
  vertexai = false,
  project,
  location,
  baseUrl,
  client,
  timeoutMs = 15000,
}: CreateGeminiDriverOptions = {}) {
  // Explicitly pass vertexai: false whenever Vertex AI is not authorized so
  // @google/genai cannot silently pick up GOOGLE_GENAI_USE_VERTEXAI from process.env
  const genaiOpts: Record<string, any> = vertexai
    ? {
        vertexai: true,
        ...(project ? { project } : {}),
        ...(location ? { location } : {}),
      }
    : {
        vertexai: false,
        apiKey: apiKey || "",
      };
  if (baseUrl) {
    genaiOpts.httpOptions = { baseUrl };
  }
  const aiClient = client ?? new GoogleGenAI(genaiOpts);
  const isCustomClient = Boolean(client);

  async function invokeCreate(params: any, signal?: AbortSignal, perCallTimeoutMs = 0) {
    if (!isCustomClient && perCallTimeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      const timeoutSig = AbortSignal.timeout(perCallTimeoutMs);
      const combined =
        signal && typeof AbortSignal?.any === "function"
          ? AbortSignal.any([signal, timeoutSig])
          : timeoutSig;
      return aiClient.interactions.create(params, { signal: combined });
    }
    if (signal) {
      return aiClient.interactions.create(params, { signal });
    }
    return aiClient.interactions.create(params);
  }

  return {
    async nextTurn({
      model,
      fallbackModel,
      thinkingLevel = "low",
      timeoutMs: callTimeoutMs,
      systemInstruction,
      tools,
      input,
      signal,
    }: {
      model: string;
      fallbackModel?: string;
      thinkingLevel?: string;
      timeoutMs?: number;
      systemInstruction?: string;
      tools?: any[];
      input: any;
      signal?: AbortSignal;
    }): Promise<ModelTurnResult> {
      const normalizedThinking = String(thinkingLevel || "low").trim().toLowerCase();
      const effectiveThinkingLevel =
        normalizedThinking === "none" || normalizedThinking === "off"
          ? "minimal"
          : normalizedThinking || "low";
      const buildParams = (targetModel: string, sanitizedInput: any) => ({
        model: targetModel,
        system_instruction: systemInstruction,
        tools,
        input: sanitizedInput,
        store: false,
        generation_config: {
          thinking_summaries: "auto",
          thinking_level: effectiveThinkingLevel,
        },
      });

      const invokeWithRecovery = async (
        targetModel: string,
        perCallTimeoutMs: number
      ): Promise<{ res: any; usage: TokenUsage }> => {
        const firstInput = sanitizeInputForGemini(input, {
          stripAllThoughts: false,
          foldUnsignedToolTurns: true,
        });
        let activeInput = firstInput;
        let usedStripped = false;
        let res: any;
        try {
          res = await invokeCreate(
            buildParams(targetModel, firstInput),
            signal,
            perCallTimeoutMs
          );
        } catch (err) {
          if (
            signal?.aborted ||
            (!isInvalidThoughtSignatureError(err) && !isGeminiInvalidArgumentError(err))
          ) {
            throw err;
          }
          const strippedInput = sanitizeInputForGemini(input, {
            stripAllThoughts: true,
            foldUnsignedToolTurns: true,
          });
          const changed = JSON.stringify(strippedInput) !== JSON.stringify(firstInput);
          if (!changed) {
            throw err;
          }
          activeInput = strippedInput;
          usedStripped = true;
          res = await invokeCreate(
            buildParams(targetModel, strippedInput),
            signal,
            perCallTimeoutMs
          );
        }

        let totalUsage = extractGeminiUsage(res);
        const retryDecision = shouldRetryInteractionResponse(res);
        if (retryDecision.retry && !signal?.aborted) {
          const retryBase =
            retryDecision.isMalformedToolCall && !usedStripped
              ? sanitizeInputForGemini(input, {
                  stripAllThoughts: true,
                  foldUnsignedToolTurns: true,
                })
              : activeInput;
          const retryNotice = retryDecision.isMalformedToolCall
            ? `[System Retry Notice: The previous tool call failed because of invalid JSON syntax (${retryDecision.reason}). Retry now: either invoke a native function tool with strictly valid JSON arguments, or answer directly in plain text.]`
            : `[System Retry Notice: The previous response produced no output (${retryDecision.reason}). Please continue and either invoke a valid native tool call or provide a direct answer.]`;
          const retryInput = appendRetryNoticeToInput(retryBase, retryNotice);
          res = await invokeCreate(
            buildParams(targetModel, retryInput),
            signal,
            perCallTimeoutMs
          );
          totalUsage = mergeTokenUsage(totalUsage, extractGeminiUsage(res));
        }

        const finalStatus = String(res?.status || "").trim().toLowerCase();
        const finalSteps = extractInteractionSteps(res);
        const finalErrors = extractInteractionErrors(res);
        if (
          finalStatus === "failed" ||
          finalStatus === "cancelled" ||
          finalStatus === "budget_exceeded" ||
          (finalErrors.length > 0 && finalSteps.length === 0)
        ) {
          const errSummary = formatInteractionErrors(res) || `status=${finalStatus || "failed"}`;
          throw new Error(`Gemini interaction ${finalStatus || "failed"}: ${errSummary}`);
        }

        return { res, usage: totalUsage };
      };

      const effectiveTimeoutMs =
        typeof callTimeoutMs === "number" && callTimeoutMs > 0
          ? callTimeoutMs
          : timeoutMs;

      const hasDistinctFallback = Boolean(fallbackModel && fallbackModel !== model);
      let usedModel = model;
      let invocation: { res: any; usage: TokenUsage };
      try {
        invocation = await invokeWithRecovery(
          model,
          hasDistinctFallback ? effectiveTimeoutMs : 0
        );
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        if (hasDistinctFallback && fallbackModel && isModelUnavailableError(err)) {
          markModelUnavailable(model, {
            permanent: isPermanentModelError(err),
          });
          usedModel = fallbackModel;
          invocation = await invokeWithRecovery(fallbackModel, 0);
        } else {
          throw err;
        }
      }

      const { res, usage } = invocation;
      const outputSteps = extractInteractionSteps(res);
      const thoughts: string[] = [];
      const textPieces: string[] = [];
      const calls: ModelTurnResult["calls"] = [];

      for (const step of outputSteps) {
        if (!step) continue;

        if (step.type === "thought") {
          if (typeof step.summary === "string" && step.summary.trim()) {
            thoughts.push(step.summary.trim());
          } else if (Array.isArray(step.summary)) {
            for (const part of step.summary) {
              if (part && typeof part.text === "string" && part.text.trim()) {
                thoughts.push(part.text.trim());
              }
            }
          } else if (typeof step.text === "string" && step.text.trim()) {
            thoughts.push(step.text.trim());
          } else if (Array.isArray(step.content)) {
            for (const part of step.content) {
              if (part && typeof part.text === "string" && part.text.trim()) {
                thoughts.push(part.text.trim());
              }
            }
          }
        } else if (step.type === "model_output") {
          if (Array.isArray(step.content)) {
            const stepText = step.content
              .filter((p: any) => p && typeof p.text === "string")
              .map((p: any) => p.text)
              .join("");
            if (stepText) textPieces.push(stepText);
          } else if (typeof step.text === "string") {
            textPieces.push(step.text);
          }
        } else if (step.type === "text") {
          if (typeof step.text === "string") {
            textPieces.push(step.text);
          } else if (Array.isArray(step.content)) {
            const stepText = step.content
              .filter((p: any) => p && typeof p.text === "string")
              .map((p: any) => p.text)
              .join("");
            if (stepText) textPieces.push(stepText);
          }
        } else if (step.type === "function_call") {
          const { args, parseError } = parseToolArguments(step.arguments ?? step.args ?? {});
          calls.push({
            id: step.id,
            name: step.name,
            args,
            ...(parseError ? { parseError } : {}),
          });
        }
      }

      const combinedText =
        textPieces.join("\n").trim() ||
        (calls.length === 0 && typeof res?.output_text === "string" ? res.output_text.trim() : "");
      const resStatus = String(res?.status || "").trim().toLowerCase();
      const finishReason =
        resStatus === "incomplete"
          ? "length"
          : !combinedText && calls.length === 0
            ? "empty"
            : undefined;

      return {
        thoughts,
        text: combinedText,
        calls,
        outputSteps,
        usage,
        usedModel,
        ...(finishReason ? { finishReason } : {}),
      };
    },

    async generateImage({
      prompt,
      model = "gemini-3.1-flash-image",
      fallbackModel = "gemini-2.5-flash-image",
      aspectRatio = "1:1",
      imageSize,
      referenceImages = [],
      timeoutMs: callTimeoutMs = 60_000,
      signal,
    }: {
      prompt?: string;
      model?: string;
      fallbackModel?: string;
      aspectRatio?: string;
      imageSize?: string;
      referenceImages?: Array<{ data: string; mimeType?: string }>;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}): Promise<ImageGenerationResult> {
      const cleanPrompt = String(prompt || "").trim();
      if (!cleanPrompt) {
        throw new Error("generateImage requires a non-empty prompt");
      }

      const validRefs = Array.isArray(referenceImages)
        ? referenceImages.filter((img) => img && typeof img.data === "string" && img.data.length > 0)
        : [];

      const interactionInput =
        validRefs.length > 0
          ? [
              {
                type: "user_input",
                content: [
                  ...validRefs.map((img) => ({
                    type: "image",
                    data: img.data,
                    mime_type: inferImageMimeType(img.data, img.mimeType),
                  })),
                  { type: "text", text: cleanPrompt },
                ],
              },
            ]
          : cleanPrompt;

      const imageConfig: Record<string, string> = {};
      if (aspectRatio) imageConfig.aspect_ratio = String(aspectRatio);
      if (imageSize) imageConfig.image_size = String(imageSize);

      const buildImageParams = (targetModel: string) => ({
        model: targetModel,
        input: interactionInput,
        response_modalities: ["image"],
        ...(Object.keys(imageConfig).length > 0
          ? { generation_config: { image_config: imageConfig } }
          : {}),
        store: false,
      });

      const effectiveTimeoutMs =
        typeof callTimeoutMs === "number" && callTimeoutMs > 0
          ? callTimeoutMs
          : 60_000;

      const hasDistinctFallback = Boolean(fallbackModel && fallbackModel !== model);
      let usedModel = model;
      let res: any;
      try {
        res = await invokeCreate(
          buildImageParams(model),
          signal,
          hasDistinctFallback ? effectiveTimeoutMs : 0
        );
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        if (hasDistinctFallback && fallbackModel && isModelUnavailableError(err)) {
          markModelUnavailable(model, {
            permanent: isPermanentModelError(err),
          });
          usedModel = fallbackModel;
          res = await invokeCreate(buildImageParams(fallbackModel), signal, 0);
        } else {
          throw err;
        }
      }

      const seenData = new Set<string>();
      const images: ImageGenerationResult["images"] = [];
      const pushCandidate = (cand: any) => {
        if (!cand || typeof cand.data !== "string" || !cand.data) return;
        if (seenData.has(cand.data)) return;
        seenData.add(cand.data);
        images.push({
          data: cand.data,
          mimeType: inferImageMimeType(cand.data, cand.mime_type || cand.mimeType),
        });
      };

      if (res?.output_image) {
        pushCandidate(res.output_image);
      }
      const steps = extractInteractionSteps(res);
      const textPieces: string[] = [];
      for (const step of steps) {
        if (!step) continue;
        if (step.type === "image") {
          pushCandidate(step);
        } else if (Array.isArray(step.content)) {
          for (const part of step.content) {
            if (part?.type === "image") pushCandidate(part);
            else if (typeof part?.text === "string" && part.text.trim()) {
              textPieces.push(part.text.trim());
            }
          }
        } else if (step.type === "text" && typeof step.text === "string" && step.text.trim()) {
          textPieces.push(step.text.trim());
        }
      }

      if (images.length === 0) {
        throw new Error(`No image returned by ${usedModel}`);
      }

      return {
        images,
        text:
          (typeof res?.output_text === "string" && res.output_text.trim()) ||
          textPieces.join("\n").trim(),
        usage: extractGeminiUsage(res),
        usedModel,
      };
    },
  };
}
