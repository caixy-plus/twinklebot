import type { ModelAdapter, TokenUsage } from "../shared/config.js";
import { resolveUtilityModels } from "./router.js";

const RAW_LEAK_RE =
  /(\brun_shell\b|\bhost_run_shell\b|\bmcp__[a-z0-9_]+\b|\bread_file\b|\bwrite_file\b|\bhost_read_file\b|\bhost_write_file\b|\bbrowser_snapshot\b|\bfunction_call\b|\/Users\/|\/etc\/|\/var\/|\/tmp\/|&&|\|\||sudo\s)/i;
const PUNCT_AND_SPACE_RE = /[\p{P}\p{S}\s]+/gu;
const MAX_SUMMARY_CHARS = 9;

function normalizeSummaryText(text = ""): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const full = raw.replace(PUNCT_AND_SPACE_RE, "").trim();
  if (!full) return "";
  if (Array.from(full).length <= MAX_SUMMARY_CHARS) return full;

  const firstClause = raw
    .split(/[，,。！？!?;；、…—]+/)
    .map((part) => part.replace(PUNCT_AND_SPACE_RE, "").trim())
    .find(Boolean);
  if (
    firstClause &&
    Array.from(firstClause).length >= 3 &&
    Array.from(firstClause).length <= MAX_SUMMARY_CHARS
  ) {
    return firstClause;
  }

  return Array.from(full).slice(0, MAX_SUMMARY_CHARS).join("");
}

export function fallbackThinkingSummary(calls: any[] = [], stepNo = 1): string {
  const firstName = String(calls?.[0]?.name || "");
  if (firstName === "run_shell" || firstName === "host_run_shell") {
    return "正在核查运行环境";
  }
  if (firstName === "read_file" || firstName === "host_read_file") {
    return "正在查阅相关文件";
  }
  if (firstName === "write_file" || firstName === "host_write_file") {
    return "正在整理写入文件";
  }
  if (firstName === "web_search") {
    return "正在联网搜索查证";
  }
  if (firstName === "web_fetch") {
    return "正在阅读网页内容";
  }
  if (firstName === "open_url" || firstName.startsWith("browser_")) {
    return "正在浏览网页信息";
  }
  if (
    firstName === "screenshot" ||
    firstName === "click" ||
    firstName === "double_click" ||
    firstName === "right_click" ||
    firstName === "move" ||
    firstName === "drag" ||
    firstName === "scroll" ||
    firstName === "type_text" ||
    firstName === "key" ||
    firstName.startsWith("mcp__kimi_cu__")
  ) {
    return "正在查看桌面操作";
  }
  if (firstName.startsWith("mail_")) {
    return "正在处理邮件请求";
  }
  if (firstName === "generate_image") {
    return "正在绘制所需图片";
  }
  if (firstName === "send_file") {
    return "正在整理发送文件";
  }
  if (
    firstName === "create_bot" ||
    firstName === "send_bot_message" ||
    firstName === "bot_manage"
  ) {
    return "正在协调伙伴处理";
  }
  if (firstName === "schedule_manage") {
    return "正在配置日程提醒";
  }
  if (firstName === "memory_manage") {
    return "正在更新记忆偏好";
  }
  if (firstName === "custom_skill_manage") {
    return "正在处理扩展技能";
  }
  if (
    firstName === "ask_user_choice" ||
    firstName === "propose_draft" ||
    firstName === "request_credential"
  ) {
    return "正在准备交互确认";
  }
  if (stepNo <= 1) {
    return "正在分析当前需求";
  }
  return "正在思考推进任务";
}

export function sanitizeThinkingSummary(rawText = "", fallback = "正在思考推进任务"): string {
  const safeFallback = normalizeSummaryText(fallback) || "正在思考推进任务";
  let clean =
    String(rawText || "")
      .replace(/[`*_~#>]/g, "")
      .replace(/^["'“‘「『]+|["'”’」』]+$/g, "")
      .replace(/^\d+[.)、]\s*/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] || "";

  clean = clean.replace(/\s+/g, " ").trim();
  if (!clean) return safeFallback;

  if (RAW_LEAK_RE.test(clean)) {
    return safeFallback;
  }

  return normalizeSummaryText(clean) || safeFallback;
}

function summarizeCallsContext(calls: any[] = []): string {
  if (!Array.isArray(calls) || calls.length === 0) return "";
  return calls
    .slice(0, 4)
    .map((c) => {
      const name = String(c?.name || "step");
      const args = c?.args && typeof c.args === "object" ? c.args : {};
      const hintParts: string[] = [];
      if (args.app) hintParts.push(`app=${String(args.app).slice(0, 24)}`);
      if (args.url) hintParts.push("web");
      if (args.subject) hintParts.push(`subject=${String(args.subject).slice(0, 24)}`);
      if (args.title) hintParts.push(`title=${String(args.title).slice(0, 24)}`);
      if (args.action) hintParts.push(`action=${String(args.action).slice(0, 20)}`);
      if (args.command) hintParts.push(`cmd_intent=${String(args.command).slice(0, 40)}`);
      if (args.path) hintParts.push("file");
      return hintParts.length > 0 ? `${name}(${hintParts.join(",")})` : name;
    })
    .join("; ");
}

export interface SummarizeThinkingProgressOptions {
  model?: ModelAdapter | null;
  userText?: string;
  thoughts?: string[];
  calls?: any[];
  stepNo?: number;
  config?: Record<string, any>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SummarizeThinkingProgressResult {
  text: string;
  source: "model" | "fallback";
  usedModel: string | null;
  usedProviderId?: string | null;
  usage: TokenUsage | null;
}

export async function summarizeThinkingProgress({
  model = null,
  userText = "",
  thoughts = [],
  calls = [],
  stepNo = 1,
  config = {},
  signal,
  timeoutMs = 8000,
}: SummarizeThinkingProgressOptions = {}): Promise<SummarizeThinkingProgressResult> {
  const fallback = fallbackThinkingSummary(calls, stepNo);
  if (!model || typeof model.summarizeTurn !== "function") {
    return {
      text: fallback,
      source: "fallback",
      usedModel: null,
      usage: null,
    };
  }

  const { fastModel: targetModel, fallbackModel } = resolveUtilityModels(config);
  const thoughtsBrief = (Array.isArray(thoughts) ? thoughts : [])
    .filter((t) => typeof t === "string" && t.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  const callsBrief = summarizeCallsContext(calls).slice(0, 220);

  const prompt = [
    "Distill the current task progress into a single ultra-short Chinese phrase (strictly fewer than 10 Chinese characters, with zero punctuation marks) for a live status capsule in the chat UI.",
    "Strict rules:",
    "1. Length MUST be strictly 4 to 9 Chinese characters — never exceed 9 characters, and include ZERO punctuation marks or spaces (no periods, commas, ellipses, quotes, spaces, etc.).",
    "2. NEVER include shell commands, code, English tool names (such as run_shell, click, or read_file), file paths, URLs, or coordinate numbers.",
    "3. Use a natural Chinese verb-object phrase describing what is currently happening (e.g., 正在核查服务状态, 正在查阅相关文件, 正在联网搜索信息, 正在整理回复内容).",
    "4. Output ONLY the phrase itself — no quotes, no newlines, no numbering, and no explanation.",
    userText ? `User request: ${String(userText).replace(/\s+/g, " ").trim().slice(0, 180)}` : "",
    thoughtsBrief ? `Model thoughts: ${thoughtsBrief}` : "",
    callsBrief ? `Action intent: ${callsBrief}` : "",
  ]
    .filter(Boolean)
    .join("\n");

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
        "You summarize an AI assistant's in-progress work into a single ultra-short Chinese phrase under 10 characters with zero punctuation marks, without technical commands, file paths, or tool names.",
      input: [{ type: "user_input", content: [{ type: "text", text: prompt }] }],
      signal: combinedSignal,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timeoutCtrl.abort();
        reject(new Error("thinking summary timed out"));
      }, timeoutMs);
    });
    turnPromise.catch(() => {});
    const turn = await Promise.race([turnPromise, timeoutPromise]).finally(() =>
      clearTimeout(timer)
    );

    const text = sanitizeThinkingSummary(turn?.text || "", fallback);
    return {
      text,
      source: "model",
      usedModel: turn?.usedModel || targetModel,
      usedProviderId: turn?.usedProviderId || null,
      usage: turn?.usage || null,
    };
  } catch {
    return {
      text: fallback,
      source: "fallback",
      usedModel: null,
      usage: null,
    };
  }
}

export default {
  fallbackThinkingSummary,
  sanitizeThinkingSummary,
  summarizeThinkingProgress,
};
