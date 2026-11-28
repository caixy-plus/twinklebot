import fs from "node:fs";
import path from "node:path";
import { isSensitiveFilePath } from "../lib/file-attachments.js";

export interface ToolHookCallRecord {
  name: string;
  sig: string;
  ok: boolean;
  errorText?: string;
}

export interface TurnHookState {
  recentCalls: ToolHookCallRecord[];
}

export interface ToolHookContext {
  sessionId: string;
  toolName: string;
  args: Record<string, any>;
  stepNo: number;
  botWorkspaceRoot?: string;
  isExternalChannel?: boolean;
}

export interface PreToolHookResult {
  action: "pass" | "block";
  reason?: string;
}

export interface PostToolHookResult {
  hint?: string;
  verifyWarning?: string;
}

const MAX_RECENT_CALLS = 16;
const MAX_VERIFY_FILE_BYTES = 512 * 1024;
const WRITE_VERIFY_TOOLS = new Set([
  "write_file",
  "edit_file",
  "host_write_file",
  "host_edit_file",
]);

function stableJsonStringify(value: unknown, depth = 0): string {
  if (depth > 4) return '"[depth]"';
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.slice(0, 20).map((item) => stableJsonStringify(item, depth + 1)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .slice(0, 30)
    .map((k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k], depth + 1)}`)
    .join(",")}}`;
}

export function computeToolCallSignature(toolName: string, args: Record<string, any> = {}): string {
  return `${String(toolName || "").trim()}::${stableJsonStringify(args || {})}`;
}

export function createTurnHookState(): TurnHookState {
  return { recentCalls: [] };
}

function isResultError(result: any): { ok: boolean; errorText: string } {
  if (!result || typeof result !== "object") {
    return { ok: true, errorText: "" };
  }
  const rawErr = result.error ? String(result.error) : "";
  const stderrText = result.stderr ? String(result.stderr) : "";
  const msgText = result.message || result.reason ? String(result.message || result.reason) : "";
  const exitNonZero = typeof result.exit_code === "number" && result.exit_code !== 0;
  if (rawErr || result.ok === false || exitNonZero) {
    return {
      ok: false,
      errorText:
        rawErr ||
        stderrText ||
        msgText ||
        (exitNonZero ? String(result.stdout || `exit_code=${result.exit_code}`) : "failed"),
    };
  }
  return { ok: true, errorText: "" };
}

/**
 * PreToolUse in-loop guard: blocks >=3 consecutive identical failing calls
 * without touching or overriding Frozen Policy decisions.
 */
export function runPreToolHooks(
  state: TurnHookState,
  ctx: ToolHookContext
): PreToolHookResult {
  const sig = computeToolCallSignature(ctx.toolName, ctx.args);
  const tail = state.recentCalls.slice(-2);
  if (
    tail.length === 2 &&
    tail.every((r) => r.sig === sig && !r.ok)
  ) {
    return {
      action: "block",
      reason:
        `已连续 2 次以完全相同的参数调用 ${ctx.toolName} 并失败，为避免死循环已拦截第 3 次重复调用。请先根据已有报错信息调整参数、切换工具或换一种思路继续。`,
    };
  }
  return { action: "pass" };
}

function deriveErrorOrContextHint(
  toolName: string,
  result: any,
  errorText: string
): string | undefined {
  const lowerErr = errorText.toLowerCase();

  if (toolName.startsWith("browser_")) {
    if (lowerErr.includes("target_id not found") || lowerErr.includes("target not found")) {
      return "提示：错误载荷通常附带当前 live tabs 列表，请直接选用其中的有效 target_id 调用 browser_tabs(action: \"switch\") 或新建标签。";
    }
    if (toolName === "browser_snapshot" && result && typeof result === "object") {
      if (result.challenge_detected === true) {
        return "提示：检测到人机验证/风控挑战，请立即停止重复刷新，引导用户在「Bot 的电脑」点击「取得控制权」完成验证后再继续。";
      }
      if (
        Array.isArray(result.iframes) &&
        result.iframes.some((f: any) => f && f.cross_origin === true)
      ) {
        return "提示：页面存在 cross_origin: true iframe；若目标输入框/按钮位于跨源 iframe 内，请直接切换 screenshot → click(x, y) → type_text。";
      }
    }
  }

  if (toolName === "run_shell" || toolName === "host_run_shell") {
    if (
      lowerErr.includes("command not found") ||
      lowerErr.includes("no such file or directory") ||
      lowerErr.includes("not recognized as an internal or external command")
    ) {
      return "提示：可将多步环境/路径检查合并进单条命令一起探测，避免分多轮试探不存在的路径或二进制。";
    }
  }

  if (
    lowerErr.includes("another bot") ||
    lowerErr.includes("private workspace") ||
    lowerErr.includes("其他 bot")
  ) {
    return "提示：禁止跨 Bot 盲读私有目录；可先调用 list_bots 查看目标工作区路径，或用 send_bot_message 请对方协作。";
  }

  return undefined;
}

function countPattern(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export function verifyWrittenContent(filePath: string, content: string): string | undefined {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  const ext = path.extname(base);
  const text = String(content ?? "");

  if (ext === ".json") {
    try {
      JSON.parse(text);
    } catch (err: any) {
      return `写后校验告警：${base} 不是合法 JSON（${err?.message || "parse error"}），请立即修复后再继续。`;
    }
    return undefined;
  }

  if (ext === ".svg") {
    if (!/<svg\b/i.test(text) || !/<\/svg\s*>/i.test(text)) {
      return `写后校验告警：${base} 缺少完整的 <svg>...</svg> 闭合标签，请补全。`;
    }
    return undefined;
  }

  if (ext === ".html" || ext === ".htm") {
    if (!text.trim()) {
      return `写后校验告警：${base} 内容为空。`;
    }
    const openScripts = countPattern(text, /<script\b[^>]*>/gi);
    const closeScripts = countPattern(text, /<\/script\s*>/gi);
    const openStyles = countPattern(text, /<style\b[^>]*>/gi);
    const closeStyles = countPattern(text, /<\/style\s*>/gi);
    if (openScripts !== closeScripts || openStyles !== closeStyles) {
      return `写后校验告警：${base} 存在未闭合的 <script> 或 <style> 标签，请检查并补全。`;
    }
    return undefined;
  }

  const isSkillMarkdown =
    base === "skill.md" ||
    (ext === ".md" && normalized.toLowerCase().includes("/custom-skills/"));
  if (isSkillMarkdown && text.trimStart().startsWith("---")) {
    const body = text.replace(/\r\n/g, "\n").trimStart();
    if (!/^---\n[\s\S]*?\n---(?:\n|$)/.test(body)) {
      return `写后校验告警：${base} 的 YAML frontmatter 缺少闭合的 --- 分隔符，请补全。`;
    }
  }

  return undefined;
}

function runPostWriteVerification(ctx: ToolHookContext, result: any): string | undefined {
  if (!WRITE_VERIFY_TOOLS.has(ctx.toolName)) return undefined;
  if (!isResultError(result).ok) return undefined;

  const targetPath = String(ctx.args?.path || result?.path || "").trim();
  if (!targetPath) return undefined;

  // Prefer in-memory content for write_file / host_write_file so sandbox writes are verified too
  if (
    (ctx.toolName === "write_file" || ctx.toolName === "host_write_file") &&
    typeof ctx.args?.content === "string"
  ) {
    return verifyWrittenContent(targetPath, ctx.args.content);
  }

  // For host edits, read the local file safely if readable & non-sensitive
  if (ctx.toolName === "host_edit_file") {
    try {
      if (isSensitiveFilePath(targetPath)) return undefined;
      if (!fs.existsSync(targetPath)) return undefined;
      const st = fs.statSync(targetPath);
      if (!st.isFile() || st.size > MAX_VERIFY_FILE_BYTES) return undefined;
      const raw = fs.readFileSync(targetPath, "utf8");
      return verifyWrittenContent(targetPath, raw);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * PostToolUse in-loop hook: records outcome for loop guarding, injects targeted recovery
 * hints on known error signatures, and runs deterministic syntax verification on written files.
 */
export function runPostToolHooks(
  state: TurnHookState,
  ctx: ToolHookContext,
  toolResult: any
): PostToolHookResult {
  const sig = computeToolCallSignature(ctx.toolName, ctx.args);
  const status = isResultError(toolResult);
  state.recentCalls.push({
    name: ctx.toolName,
    sig,
    ok: status.ok,
    ...(status.errorText ? { errorText: status.errorText.slice(0, 200) } : {}),
  });
  if (state.recentCalls.length > MAX_RECENT_CALLS) {
    state.recentCalls.splice(0, state.recentCalls.length - MAX_RECENT_CALLS);
  }

  const hint = deriveErrorOrContextHint(ctx.toolName, toolResult, status.errorText);
  const verifyWarning = runPostWriteVerification(ctx, toolResult);
  return {
    ...(hint ? { hint: hint.slice(0, 260) } : {}),
    ...(verifyWarning ? { verifyWarning: verifyWarning.slice(0, 280) } : {}),
  };
}
