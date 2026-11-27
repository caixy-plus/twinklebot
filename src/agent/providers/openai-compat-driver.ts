import type {
  ImageGenerationResult,
  ModelTurnResult,
  ToolCall,
} from "../../shared/config.js";
import {
  isModelUnavailableError,
  isPermanentModelError,
  markModelUnavailable,
} from "../router.js";
import { isContextOverflowError, sanitizeSurrogates } from "../context.js";
import { inferImageMimeType, parseToolArguments } from "./gemini-driver.js";

function mapThinkingToReasoningEffort(thinkingLevel = ""): string {
  const lvl = String(thinkingLevel || "").trim().toLowerCase();
  if (lvl === "none" || lvl === "off") return "none";
  if (lvl === "minimal") return "minimal";
  if (lvl === "xhigh" || lvl === "high") return "high";
  if (lvl === "medium") return "medium";
  if (lvl === "low") return "low";
  return "";
}

function shouldAttachReasoningEffort(
  model = "",
  providerType = "",
  effort = ""
): boolean {
  const m = String(model || "").toLowerCase();
  if (providerType === "openai") {
    return /^o\d|^gpt-5/.test(m);
  }
  if (providerType === "deepseek") {
    return effort === "none" || effort === "minimal";
  }
  return providerType === "openai-compatible";
}

function convertToolsToOpenAi(tools: any[] | undefined) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .filter((t) => t && t.name)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
      },
    }));
}

export function canonicalToOpenAiMessages(
  systemInstruction?: string,
  inputSteps: any[] = []
): any[] {
  const messages: any[] = [];
  if (systemInstruction && String(systemInstruction).trim()) {
    messages.push({ role: "system", content: sanitizeSurrogates(String(systemInstruction)) });
  }

  let pendingAssistant: {
    content: string;
    tool_calls: any[];
    reasoning: string;
  } | null = null;
  let activeToolRound: {
    assistantMsgIndex: number;
    expectedCounts: Map<string, number>;
    answeredCounts: Map<string, number>;
    totalExpected: number;
    totalAnswered: number;
    deferredSteps: any[];
  } | null = null;

  const ensurePendingAssistant = () => {
    if (!pendingAssistant) {
      pendingAssistant = { content: "", tool_calls: [], reasoning: "" };
    }
    return pendingAssistant;
  };

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    // Skip empty assistant messages with neither visible text nor tool_calls;
    // providers reject assistant messages that have neither content nor tool_calls.
    if (!pendingAssistant.content && pendingAssistant.tool_calls.length === 0) {
      pendingAssistant = null;
      return;
    }
    const msg: Record<string, any> = { role: "assistant" };
    if (pendingAssistant.content) {
      msg.content = sanitizeSurrogates(pendingAssistant.content);
    } else {
      msg.content = null;
    }
    if (pendingAssistant.tool_calls.length > 0) {
      msg.tool_calls = pendingAssistant.tool_calls;
    }
    if (pendingAssistant.reasoning) {
      msg.reasoning_content = sanitizeSurrogates(pendingAssistant.reasoning);
    }
    messages.push(msg);
    if (pendingAssistant.tool_calls.length > 0) {
      const expectedCounts = new Map<string, number>();
      for (const tc of pendingAssistant.tool_calls) {
        expectedCounts.set(tc.id, (expectedCounts.get(tc.id) || 0) + 1);
      }
      activeToolRound = {
        assistantMsgIndex: messages.length - 1,
        expectedCounts,
        answeredCounts: new Map<string, number>(),
        totalExpected: pendingAssistant.tool_calls.length,
        totalAnswered: 0,
        deferredSteps: [],
      };
    }
    pendingAssistant = null;
  };

  const closeActiveToolRound = (): any[] => {
    if (!activeToolRound) return [];
    const round = activeToolRound;
    activeToolRound = null;
    const assistantMsg = messages[round.assistantMsgIndex];
    if (assistantMsg && Array.isArray(assistantMsg.tool_calls)) {
      if (round.totalAnswered < round.totalExpected) {
        const remainingToKeep = new Map(round.answeredCounts);
        const keptCalls = assistantMsg.tool_calls.filter((tc: any) => {
          const left = remainingToKeep.get(tc.id) || 0;
          if (left > 0) {
            remainingToKeep.set(tc.id, left - 1);
            return true;
          }
          return false;
        });
        if (keptCalls.length === 0) {
          delete assistantMsg.tool_calls;
          if (!assistantMsg.content) {
            messages.splice(round.assistantMsgIndex, 1);
          }
        } else {
          assistantMsg.tool_calls = keptCalls;
        }
      }
    }
    return round.deferredSteps;
  };

  const steps = Array.isArray(inputSteps) ? inputSteps : [];
  // Find the last real user turn index: DeepSeek/OpenAI reasoning models only need
  // reasoning_content within the active turn's tool-call loop, never from older finished turns.
  let lastRealUserIdx = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.type !== "user_input") continue;
    const rawParts = Array.isArray(s.content)
      ? s.content
      : typeof s.content === "string"
        ? [{ type: "text", text: s.content }]
        : [];
    const txt = rawParts
      .filter((p: any) => p?.type === "text")
      .map((p: any) => String(p.text || "").trim())
      .join("\n")
      .trim();
    if (
      txt &&
      txt !== "Current screen:" &&
      txt !== "Current desktop screen:" &&
      !txt.startsWith("[Auto Context Summary]") &&
      !txt.startsWith("[自动上下文压缩摘要]") &&
      !txt.startsWith("[System Notice") &&
      !txt.startsWith("[系统提示")
    ) {
      lastRealUserIdx = i;
      break;
    }
  }

  const processStep = (step: any, stepIdx = steps.length - 1) => {
    if (!step) return;

    if (activeToolRound) {
      if (step.type === "function_result") {
        const callId = String(step.call_id || "");
        const expected = activeToolRound.expectedCounts.get(callId) || 0;
        const answered = activeToolRound.answeredCounts.get(callId) || 0;
        if (callId && answered < expected) {
          const rawResultText =
            typeof step.result === "string"
              ? step.result
              : JSON.stringify(step.result ?? {});
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: sanitizeSurrogates(rawResultText),
          });
          activeToolRound.answeredCounts.set(callId, answered + 1);
          activeToolRound.totalAnswered += 1;
          if (activeToolRound.totalAnswered >= activeToolRound.totalExpected) {
            const deferred = closeActiveToolRound();
            for (const d of deferred) {
              processStep(d, stepIdx);
            }
          }
        }
        return;
      }

      if (step.type === "function_call") {
        // A new tool-calling turn began before all prior tool_calls received results:
        // finalize the prior round (stripping unanswered tool_calls) and replay deferred steps.
        const deferred = closeActiveToolRound();
        for (const d of deferred) {
          processStep(d, stepIdx);
        }
      } else {
        // Defer non-tool steps (e.g. interleaved "Current screen:" user_input) until all
        // pending tool_call_ids in the active assistant message receive their tool responses.
        activeToolRound.deferredSteps.push(step);
        return;
      }
    }

    if (step.type === "user_input") {
      flushAssistant();
      if (activeToolRound) {
        activeToolRound.deferredSteps.push(step);
        return;
      }
      const parts = Array.isArray(step.content)
        ? step.content
        : typeof step.content === "string"
          ? [{ type: "text", text: step.content }]
          : [];
      const hasImage = parts.some((p: any) => p?.type === "image" && p.data);
      if (!hasImage) {
        const text = parts
          .filter((p: any) => p?.type === "text")
          .map((p: any) => String(p.text || ""))
          .join("\n");
        messages.push({ role: "user", content: sanitizeSurrogates(text) });
      } else {
        const content: any[] = [];
        for (const p of parts) {
          if (p?.type === "text") {
            content.push({ type: "text", text: sanitizeSurrogates(String(p.text || "")) });
          } else if (p?.type === "image" && p.data) {
            const mime = inferImageMimeType(p.data, p.mime_type || p.mimeType);
            content.push({
              type: "image_url",
              image_url: { url: `data:${mime};base64,${p.data}` },
            });
          }
        }
        messages.push({ role: "user", content });
      }
      return;
    }

    if (step.type === "thought") {
      if (stepIdx < lastRealUserIdx) {
        return;
      }
      const assistant = ensurePendingAssistant();
      const t =
        typeof step.summary === "string"
          ? step.summary
          : typeof step.text === "string"
            ? step.text
            : "";
      if (t) {
        assistant.reasoning = assistant.reasoning
          ? `${assistant.reasoning}\n${t}`
          : t;
      }
      return;
    }

    if (step.type === "model_output" || step.type === "text") {
      const assistant = ensurePendingAssistant();
      let txt = "";
      if (typeof step.text === "string") {
        txt = step.text;
      } else if (Array.isArray(step.content)) {
        txt = step.content
          .filter((p: any) => p && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("");
      }
      if (txt) {
        assistant.content = assistant.content
          ? `${assistant.content}\n${txt}`
          : txt;
      }
      return;
    }

    if (step.type === "function_call") {
      const assistant = ensurePendingAssistant();
      const rawArgs = step.arguments ?? step.args ?? {};
      const { args: parsedArgs, parseError } = parseToolArguments(rawArgs);
      const serializedArgs =
        typeof rawArgs === "string" && !parseError
          ? sanitizeSurrogates(rawArgs.trim() || "{}")
          : sanitizeSurrogates(JSON.stringify(parsedArgs));
      assistant.tool_calls.push({
        id: String(step.id || `call_${assistant.tool_calls.length + 1}`),
        type: "function",
        function: {
          name: String(step.name || ""),
          arguments: serializedArgs,
        },
      });
      return;
    }

    if (step.type === "function_result") {
      if (pendingAssistant && pendingAssistant.tool_calls.length > 0) {
        flushAssistant();
        processStep(step);
      }
      // Drop orphaned function_result that has no preceding assistant tool_calls
    }
  };

  for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
    processStep(steps[stepIdx], stepIdx);
  }

  flushAssistant();
  if (activeToolRound) {
    const deferred = closeActiveToolRound();
    for (const d of deferred) {
      processStep(d, steps.length - 1);
    }
    flushAssistant();
    if (activeToolRound) {
      closeActiveToolRound();
    }
  }
  return messages;
}

export function openAiResponseToTurn(
  json: any,
  requestedModel = ""
): ModelTurnResult {
  const choice = json?.choices?.[0];
  const msg = choice?.message || {};
  const thoughts: string[] = [];
  const outputSteps: any[] = [];
  const calls: ToolCall[] = [];

  const reasoningText =
    typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()
      ? msg.reasoning_content.trim()
      : typeof msg.reasoning === "string" && msg.reasoning.trim()
        ? msg.reasoning.trim()
        : "";
  if (reasoningText) {
    thoughts.push(reasoningText);
    outputSteps.push({ type: "thought", text: reasoningText });
  }

  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .filter((p: any) => p && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }
  text = text.trim();
  if (text) {
    outputSteps.push({
      type: "model_output",
      content: [{ type: "text", text }],
    });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc) continue;
      const name = tc.function?.name || tc.name || "";
      const rawArgs = tc.function?.arguments ?? tc.arguments ?? {};
      const { args, parseError } = parseToolArguments(rawArgs);
      const id = String(tc.id || `call_${calls.length + 1}`);
      calls.push({
        id,
        name,
        args,
        ...(parseError ? { parseError } : {}),
      });
      outputSteps.push({
        type: "function_call",
        id,
        name,
        arguments: args,
      });
    }
  }

  const finishReason = String(choice?.finish_reason || "").trim().toLowerCase();

  const u = json?.usage || {};
  const explicitCacheHit =
    Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  const rawCacheMiss = u.prompt_cache_miss_tokens;
  const hasExplicitCacheMiss =
    rawCacheMiss !== undefined &&
    rawCacheMiss !== null &&
    Number.isFinite(Number(rawCacheMiss));
  const cacheMiss = hasExplicitCacheMiss ? Math.max(0, Number(rawCacheMiss)) : null;
  const rawInputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const inputTokens =
    rawInputTokens > 0
      ? rawInputTokens
      : cacheMiss !== null
        ? explicitCacheHit + cacheMiss
        : 0;
  const cachedTokens =
    cacheMiss !== null && inputTokens >= cacheMiss
      ? Math.min(inputTokens, Math.max(explicitCacheHit, inputTokens - cacheMiss))
      : Math.min(inputTokens, Math.max(0, explicitCacheHit));
  const thoughtTokens =
    Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;

  return {
    thoughts,
    text,
    calls,
    outputSteps,
    usage: {
      input: inputTokens,
      output: outputTokens,
      ...(cachedTokens > 0 ? { cached: cachedTokens } : {}),
      ...(thoughtTokens > 0 ? { thoughts: thoughtTokens } : {}),
    },
    usedModel: json?.model || requestedModel,
    ...(finishReason ? { finishReason } : {}),
  };
}

export interface CreateOpenAiCompatDriverOptions {
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createOpenAiCompatDriver({
  apiKey,
  baseUrl = "https://api.openai.com/v1",
  providerType = "openai",
  fetchImpl = fetch,
  timeoutMs = 45_000,
}: CreateOpenAiCompatDriverOptions = {}) {
  const cleanBase = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

  function createTimeoutErr(ms: number): Error {
    return typeof DOMException === "function"
      ? new DOMException("The operation was aborted due to timeout", "TimeoutError")
      : new Error(`The operation was aborted due to timeout (${ms}ms)`);
  }

  function parseRetryAfterHeaderMs(res: Response): number | undefined {
    const msRaw = res.headers?.get?.("retry-after-ms");
    if (msRaw) {
      const val = Number.parseFloat(msRaw);
      if (Number.isFinite(val) && val >= 0) return val;
    }
    const secRaw = res.headers?.get?.("retry-after");
    if (secRaw) {
      const secs = Number.parseFloat(secRaw);
      if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
      const dateMs = Date.parse(secRaw) - Date.now();
      if (Number.isFinite(dateMs) && dateMs >= 0) return dateMs;
    }
    return undefined;
  }

  function isTransientRetryableError(err: any): boolean {
    if (!err || isContextOverflowError(err)) return false;
    const msg = String(err?.message || err || "");
    if (
      /insufficient_quota|quota exceeded|out of budget|available balance|monthly usage limit|billing/i.test(
        msg
      )
    ) {
      return false;
    }
    const status = Number(err?.status ?? err?.statusCode ?? 0);
    if (status === 429 || status === 408 || (status >= 500 && status <= 599)) {
      return true;
    }
    return /econnreset|etimedout|epipe|socket hang up|other side closed|fetch failed|overloaded|server_busy|rate.?limit|too many requests|service.*unavailable|stream disconnected/i.test(
      msg
    );
  }

  function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function parseErrorResponse(res: Response): Promise<never> {
    const rawText = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
    const msg =
      parsed?.error?.message ||
      parsed?.message ||
      rawText ||
      `HTTP ${res.status}`;
    const err: any = new Error(msg);
    err.status = res.status;
    const retryAfterMs = parseRetryAfterHeaderMs(res);
    if (retryAfterMs !== undefined) {
      err.retryAfterMs = retryAfterMs;
    }
    throw err;
  }

  async function readSseChatCompletion(
    res: Response,
    fallbackModelName: string,
    touchIdle: () => void
  ): Promise<Record<string, any>> {
    if (!res.body || typeof res.body.getReader !== "function") {
      const rawText = await res.text();
      return JSON.parse(rawText || "{}");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let resolvedModel = fallbackModelName;
    let reasoning = "";
    let content = "";
    let finishReason = "";
    let usage: any = undefined;
    const toolCallMap = new Map<
      number,
      { id: string; type: string; function: { name: string; arguments: string } }
    >();

    const handleSseLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line || line.startsWith(":")) return;
      if (!line.startsWith("data:")) return;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") return;
      let chunk: any;
      try {
        chunk = JSON.parse(dataStr);
      } catch {
        return;
      }
      if (chunk?.error) {
        const err: any = new Error(
          chunk.error?.message || JSON.stringify(chunk.error)
        );
        err.status = chunk.error?.code || 500;
        throw err;
      }
      if (chunk?.model) resolvedModel = String(chunk.model);
      if (chunk?.usage && typeof chunk.usage === "object") {
        usage = chunk.usage;
      }
      const choiceFinishReason = chunk?.choices?.[0]?.finish_reason;
      if (typeof choiceFinishReason === "string" && choiceFinishReason.trim()) {
        finishReason = choiceFinishReason.trim();
      }
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta || typeof delta !== "object") {
        const fullMsg = chunk?.choices?.[0]?.message;
        if (fullMsg) {
          if (typeof fullMsg.reasoning_content === "string") {
            reasoning += fullMsg.reasoning_content;
          } else if (typeof fullMsg.reasoning === "string") {
            reasoning += fullMsg.reasoning;
          }
          if (typeof fullMsg.content === "string") {
            content += fullMsg.content;
          }
        }
        return;
      }
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      } else if (typeof delta.reasoning === "string") {
        reasoning += delta.reasoning;
      }
      if (typeof delta.content === "string") {
        content += delta.content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc) continue;
          const idx = Number.isFinite(Number(tc.index)) ? Number(tc.index) : 0;
          let entry = toolCallMap.get(idx);
          if (!entry) {
            entry = {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
            toolCallMap.set(idx, entry);
          }
          if (tc.id) entry.id = String(tc.id);
          if (tc.type) entry.type = String(tc.type);
          if (tc.function?.name) entry.function.name += String(tc.function.name);
          if (typeof tc.function?.arguments === "string") {
            entry.function.arguments += tc.function.arguments;
          }
        }
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        touchIdle();
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handleSseLine(line);
          nl = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          handleSseLine(line);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    const toolCalls = Array.from(toolCallMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => tc);

    return {
      model: resolvedModel,
      choices: [
        {
          ...(finishReason ? { finish_reason: finishReason } : {}),
          message: {
            role: "assistant",
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            content: content || (toolCalls.length > 0 ? null : ""),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      ...(usage ? { usage } : {}),
    };
  }

  async function postJson(
    endpointPath: string,
    body: Record<string, any>,
    signal?: AbortSignal,
    callTimeoutMs?: number
  ) {
    const effectiveTimeout =
      typeof callTimeoutMs === "number" && callTimeoutMs > 0
        ? callTimeoutMs
        : timeoutMs;
    const streamEnabled = body?.stream === true;
    const reqCtrl = new AbortController();
    const onExtAbort = () => reqCtrl.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) {
        reqCtrl.abort(signal.reason);
      } else {
        signal.addEventListener("abort", onExtAbort, { once: true });
      }
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let maxCapTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (effectiveTimeout > 0) {
        idleTimer = setTimeout(() => {
          reqCtrl.abort(createTimeoutErr(effectiveTimeout));
        }, effectiveTimeout);
      }
    };
    resetIdleTimer();
    if (streamEnabled && effectiveTimeout > 0) {
      // Allow active streaming up to 6x idle window (at least 5 min) so long SVG/code generations finish cleanly
      const hardCapMs = Math.max(effectiveTimeout * 6, 300_000);
      maxCapTimer = setTimeout(() => {
        reqCtrl.abort(createTimeoutErr(hardCapMs));
      }, hardCapMs);
    }

    try {
      const res = await fetchImpl(`${cleanBase}${endpointPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: reqCtrl.signal,
      });

      if (!res.ok) {
        await parseErrorResponse(res);
      }

      const contentType = String(res.headers?.get?.("content-type") || "").toLowerCase();
      if (streamEnabled && contentType.includes("text/event-stream")) {
        resetIdleTimer();
        return await readSseChatCompletion(res, String(body?.model || ""), resetIdleTimer);
      }

      const rawText = await res.text();
      if (streamEnabled && /^\s*data:/m.test(rawText)) {
        const fakeStreamRes = new Response(rawText, {
          status: res.status,
          headers: { "Content-Type": "text/event-stream" },
        });
        return await readSseChatCompletion(
          fakeStreamRes,
          String(body?.model || ""),
          resetIdleTimer
        );
      }

      let parsed: any = null;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
      return parsed || {};
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxCapTimer) clearTimeout(maxCapTimer);
      if (signal) signal.removeEventListener("abort", onExtAbort);
    }
  }

  function mapAspectRatioToSize(aspectRatio = "1:1"): string {
    const r = String(aspectRatio || "1:1").trim();
    if (r === "16:9" || r === "4:3" || r === "3:2" || r === "21:9") return "1536x1024";
    if (r === "9:16" || r === "3:4" || r === "2:3") return "1024x1536";
    return "1024x1024";
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
      const messages = canonicalToOpenAiMessages(systemInstruction, input);
      const openAiTools = convertToolsToOpenAi(tools);
      const mappedEffort = mapThinkingToReasoningEffort(thinkingLevel);

      const withAssistantReasoningDefaults = (msgs: any[]) =>
        msgs.map((m) =>
          m && m.role === "assistant" && m.reasoning_content === undefined
            ? { ...m, reasoning_content: "" }
            : m
        );

      const isDeepSeekEndpoint =
        providerType === "deepseek" || cleanBase.toLowerCase().includes("deepseek");

      const executeSingleModel = async (
        targetModel: string,
        perCallTimeoutMs?: number
      ): Promise<ModelTurnResult> => {
        const effort = shouldAttachReasoningEffort(targetModel, providerType, mappedEffort)
          ? mappedEffort
          : "";
        const isDeepSeekReasoning =
          isDeepSeekEndpoint &&
          effort !== "none" &&
          (/reasoner|deepseek-r1|deepseek-v4/i.test(targetModel) ||
            messages.some((m) => m?.role === "assistant" && typeof m.reasoning_content === "string"));
        const effectiveMessages = isDeepSeekReasoning
          ? withAssistantReasoningDefaults(messages)
          : messages;

        let payload: Record<string, any> = {
          model: targetModel,
          messages: effectiveMessages,
          stream: true,
          stream_options: { include_usage: true },
          ...(openAiTools ? { tools: openAiTools, tool_choice: "auto" } : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
        };

        try {
          const json = await postJson("/chat/completions", payload, signal, perCallTimeoutMs);
          return openAiResponseToTurn(json, targetModel);
        } catch (err: any) {
          if (err?.status === 400 && payload.stream_options) {
            const msg = String(err.message || "");
            if (/stream_options|stream/i.test(msg)) {
              const noStreamOptsPayload = { ...payload };
              delete noStreamOptsPayload.stream_options;
              if (/stream/i.test(msg) && !/stream_options/i.test(msg)) {
                delete noStreamOptsPayload.stream;
              }
              payload = noStreamOptsPayload;
              try {
                const json = await postJson(
                  "/chat/completions",
                  payload,
                  signal,
                  perCallTimeoutMs
                );
                return openAiResponseToTurn(json, targetModel);
              } catch (retryErr: any) {
                err = retryErr;
              }
            }
          }
          if (
            err?.status === 400 &&
            /reasoning_content/i.test(String(err.message || "")) &&
            payload.messages.some((m: any) => m?.role === "assistant" && m.reasoning_content === undefined)
          ) {
            payload = {
              ...payload,
              messages: withAssistantReasoningDefaults(payload.messages),
            };
            try {
              const json = await postJson(
                "/chat/completions",
                payload,
                signal,
                perCallTimeoutMs
              );
              return openAiResponseToTurn(json, targetModel);
            } catch (retryErr: any) {
              err = retryErr;
            }
          }
          if (
            effort &&
            err?.status === 400 &&
            /reasoning_effort|unsupported/i.test(String(err.message || ""))
          ) {
            const retryPayload = { ...payload };
            delete retryPayload.reasoning_effort;
            const json = await postJson(
              "/chat/completions",
              retryPayload,
              signal,
              perCallTimeoutMs
            );
            return openAiResponseToTurn(json, targetModel);
          }
          throw err;
        }
      };

      const executeWithTransientRetry = async (
        targetModel: string,
        perCallTimeoutMs: number | undefined,
        maxTransientRetries: number
      ): Promise<ModelTurnResult> => {
        let attempt = 0;
        while (true) {
          try {
            return await executeSingleModel(targetModel, perCallTimeoutMs);
          } catch (err: any) {
            if (signal?.aborted || attempt >= maxTransientRetries || !isTransientRetryableError(err)) {
              throw err;
            }
            const baseDelay =
              typeof err?.retryAfterMs === "number" && err.retryAfterMs >= 0
                ? Math.min(10_000, err.retryAfterMs)
                : Math.min(6_000, 650 * 2 ** attempt * (0.8 + Math.random() * 0.2));
            attempt += 1;
            await abortableSleep(baseDelay, signal);
          }
        }
      };

      const hasDistinctFallback = Boolean(fallbackModel && fallbackModel !== model);
      try {
        // When a distinct fallback model exists, fail over immediately on unavailability;
        // otherwise use short abort-aware exponential backoff for transient 429/5xx/network drops.
        return await executeWithTransientRetry(model, callTimeoutMs, hasDistinctFallback ? 0 : 2);
      } catch (err: any) {
        if (signal?.aborted) throw err;
        if (hasDistinctFallback && fallbackModel && isModelUnavailableError(err)) {
          markModelUnavailable(model, {
            permanent: isPermanentModelError(err),
          });
          return await executeWithTransientRetry(
            fallbackModel,
            Math.max(Number(callTimeoutMs) || 0, 90_000),
            1
          );
        }
        throw err;
      }
    },

    async generateImage({
      prompt,
      model = "gpt-image-1",
      aspectRatio = "1:1",
      signal,
      timeoutMs: callTimeoutMs,
    }: {
      prompt?: string;
      model?: string;
      aspectRatio?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {}): Promise<ImageGenerationResult> {
      const cleanPrompt = String(prompt || "").trim();
      if (!cleanPrompt) {
        throw new Error("generateImage requires a non-empty prompt");
      }
      const json = await postJson(
        "/images/generations",
        {
          model,
          prompt: cleanPrompt,
          n: 1,
          size: mapAspectRatioToSize(aspectRatio),
        },
        signal,
        callTimeoutMs || 60_000
      );
      const item = Array.isArray(json?.data) ? json.data[0] : null;
      let base64Data = item?.b64_json || "";
      let mimeType = "image/png";
      if (!base64Data && item?.url) {
        const imgRes = await fetchImpl(item.url, signal ? { signal } : undefined);
        if (!imgRes.ok) {
          throw new Error(`Failed to fetch generated image (${imgRes.status})`);
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        base64Data = buf.toString("base64");
        mimeType = imgRes.headers.get("content-type") || "image/png";
      }
      if (!base64Data) {
        throw new Error(`Image generation model ${model} returned no image data`);
      }
      return {
        images: [{ data: base64Data, mimeType }],
        usedModel: model,
        usage: null,
      };
    },
  };
}
