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

function sanitizeInputForGemini(
  input: any,
  { stripAllThoughts = false }: { stripAllThoughts?: boolean } = {}
): any {
  if (!Array.isArray(input)) return input;
  const out: any[] = [];
  for (const step of input) {
    if (!step || typeof step !== "object") {
      out.push(step);
      continue;
    }
    if (step.type === "thought" || step.type === "thought_signature") {
      if (stripAllThoughts) continue;
      if (typeof step.signature !== "string" || !step.signature.trim()) continue;
      out.push(step);
      continue;
    }
    if (stripAllThoughts && "signature" in step) {
      const { signature: _ignored, ...rest } = step;
      out.push(rest);
      continue;
    }
    out.push(step);
  }
  return out;
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

      const invokeWithSignatureRecovery = async (targetModel: string, perCallTimeoutMs: number) => {
        const firstInput = sanitizeInputForGemini(input, { stripAllThoughts: false });
        try {
          return await invokeCreate(
            buildParams(targetModel, firstInput),
            signal,
            perCallTimeoutMs
          );
        } catch (err) {
          if (signal?.aborted || !isInvalidThoughtSignatureError(err)) {
            throw err;
          }
          const strippedInput = sanitizeInputForGemini(input, { stripAllThoughts: true });
          const changed =
            !Array.isArray(firstInput) ||
            !Array.isArray(strippedInput) ||
            strippedInput.length !== firstInput.length ||
            firstInput.some((s: any) => s && typeof s === "object" && "signature" in s);
          if (!changed) {
            throw err;
          }
          return invokeCreate(
            buildParams(targetModel, strippedInput),
            signal,
            perCallTimeoutMs
          );
        }
      };

      const effectiveTimeoutMs =
        typeof callTimeoutMs === "number" && callTimeoutMs > 0
          ? callTimeoutMs
          : timeoutMs;

      const hasDistinctFallback = Boolean(fallbackModel && fallbackModel !== model);
      let usedModel = model;
      let res: any;
      try {
        res = await invokeWithSignatureRecovery(
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
          res = await invokeWithSignatureRecovery(fallbackModel, 0);
        } else {
          throw err;
        }
      }

      const outputSteps = res?.steps ?? res?.outputs ?? [];
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

      return {
        thoughts,
        text: textPieces.join("\n").trim(),
        calls,
        outputSteps,
        usage: extractGeminiUsage(res),
        usedModel,
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
      const steps = res?.steps ?? res?.outputs ?? [];
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
