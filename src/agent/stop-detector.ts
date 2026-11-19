import type { ModelAdapter } from "../shared/config.js";
import { resolveUtilityModels } from "./router.js";

const EXPLICIT_STOP_CN_RE =
  /^(?:请|麻烦|先|快|立刻|马上|立即)?(?:停|停下|停下来|停止|停一下|停手|住手|别做了|别再做了|别干了|不要做了|别继续了|别继续做了|别再继续了|别跑了|别弄了|不用做了|打住|算了[,，\s]*(?:别做了|不用做了|停吧|停止)|中止|终止|取消)(?:吧|呀|啊|了|一下)?(?:当前)?(?:任务|执行|操作|运行|工作)?$/;

const EXPLICIT_STOP_EN_RE =
  /^(?:please\s+)?(?:stop(?:\s+(?:it|now|this|please|running|(?:the\s+|current\s+)?task))?|abort(?:\s+(?:it|now|this|(?:the\s+|current\s+)?task))?|cancel(?:\s+(?:it|now|this|(?:the\s+|current\s+)?task))?|halt|quit)(?:\s+please)?$/i;

const STOP_CUE_RE =
  /(停|别|不要|不用|算了|取消|中止|终止|打住|住手|stop|abort|cancel|halt|quit)/i;

function normalizeStopCandidate(text = ""): string {
  return String(text || "")
    .trim()
    .replace(/^[!！。.~～?？,，、\s]+|[!！。.~～?？,，、\s]+$/g, "")
    .replace(/\s+/g, " ");
}

export function isExplicitStopCommand(text = ""): boolean {
  const normalized = normalizeStopCandidate(text);
  if (!normalized || normalized.length > 32) return false;
  return EXPLICIT_STOP_CN_RE.test(normalized) || EXPLICIT_STOP_EN_RE.test(normalized);
}

export interface DetectSemanticStopIntentOptions {
  model?: ModelAdapter | null;
  config?: Record<string, any>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DetectSemanticStopIntentResult {
  shouldStop: boolean;
  source: "empty" | "rule" | "model" | "fallback";
  usedModel?: string;
}

export async function detectSemanticStopIntent(
  text = "",
  { model = null, config = {}, signal, timeoutMs = 2500 }: DetectSemanticStopIntentOptions = {}
): Promise<DetectSemanticStopIntentResult> {
  const normalized = normalizeStopCandidate(text);
  if (!normalized) {
    return { shouldStop: false, source: "empty" };
  }
  if (isExplicitStopCommand(normalized)) {
    return { shouldStop: true, source: "rule" };
  }
  if (normalized.length > 40 || !STOP_CUE_RE.test(normalized)) {
    return { shouldStop: false, source: "rule" };
  }
  if (!model || typeof model.summarizeTurn !== "function") {
    return { shouldStop: false, source: "rule" };
  }

  const { fastModel: targetModel, fallbackModel } = resolveUtilityModels(config);
  const timeoutCtrl = new AbortController();
  const combinedSignal =
    signal && typeof AbortSignal?.any === "function"
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turnPromise = model.summarizeTurn({
      model: targetModel,
      fallbackModel,
      thinkingLevel: "low",
      timeoutMs,
      systemInstruction:
        "You classify whether a user message is an explicit command to immediately abort/stop the AI assistant's currently running task. Output ONLY YES or NO.",
      input: [
        {
          type: "user_input",
          content: [
            {
              type: "text",
              text: [
                "The user sent the following message to an AI assistant that is currently executing a task. Determine whether the user is explicitly telling the assistant to immediately stop or abort its current task.",
                "Rules:",
                "- Output NO if the user is asking to stop a software/service/process, asking a question (e.g., 'what are stop words'), or providing additional/modified instructions.",
                "- Output YES ONLY if the user is clearly instructing the assistant itself to stop working, quit, or abort the current task.",
                `Message: ${normalized}`,
              ].join("\n"),
            },
          ],
        },
      ],
      signal: combinedSignal,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutCtrl.abort();
        reject(new Error("stop intent check timed out"));
      }, timeoutMs);
    });
    turnPromise.catch(() => {});
    const turn = await Promise.race([turnPromise, timeoutPromise]).finally(() =>
      clearTimeout(timer)
    );
    const answer = String(turn?.text || "").trim().toUpperCase();
    return {
      shouldStop: answer === "YES" || answer.startsWith("YES\n") || answer.startsWith("YES "),
      source: "model",
      usedModel: turn?.usedModel || targetModel,
    };
  } catch {
    return { shouldStop: false, source: "fallback" };
  }
}

export default {
  isExplicitStopCommand,
  detectSemanticStopIntent,
};
