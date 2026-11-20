import os from "node:os";
import path from "node:path";
import { isHostTool } from "./host-tools.js";
import { isMcpToolName } from "../lib/mcp-client.js";
import { isOtherBotPrivateWorkspacePath } from "../lib/bot-workspace.js";

const HOME_DIR = os.homedir();
const CURRENT_USERNAME = (() => {
  try {
    return os.userInfo().username || path.basename(HOME_DIR);
  } catch {
    return path.basename(HOME_DIR);
  }
})();

const DENIED_DIRS = Array.from(
  new Set([
    path.join(HOME_DIR, ".ssh"),
    path.join(HOME_DIR, "Library", "Keychains"),
    path.join(HOME_DIR, ".aws"),
    path.join(HOME_DIR, ".gnupg"),
    ...(CURRENT_USERNAME
      ? [
          `/Users/${CURRENT_USERNAME}/.ssh`,
          `/Users/${CURRENT_USERNAME}/Library/Keychains`,
          `/Users/${CURRENT_USERNAME}/.aws`,
          `/Users/${CURRENT_USERNAME}/.gnupg`,
          `/home/${CURRENT_USERNAME}/.ssh`,
          `/home/${CURRENT_USERNAME}/.aws`,
          `/home/${CURRENT_USERNAME}/.gnupg`,
        ]
      : []),
  ])
);

const DENIED_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", "keychains"]);

const CONFIRM_SHELL_RE = /\b(sudo|rm|mv|dd|mkfs|shutdown|reboot|format|diskpart|Remove-Item)\b|(curl|wget)[^|]*\|\s*(ba)?sh\b/i;

const SANDBOX_TOOLS = new Set([
  "screenshot",
  "click",
  "type_text",
  "key",
  "scroll",
  "drag",
  "list_windows",
  "focus_window",
  "run_shell",
  "read_file",
  "write_file",
  "open_url",
  "browser_snapshot",
  "browser_click",
  "browser_type",
]);

const DENIED_KEYCHAIN_SHELL_RE =
  /\bsecurity\s+(dump-keychain\b|find-(generic|internet)-password\b[^|;&\n]*\s-(w|g)\b)/i;

const READ_ONLY_HOST_AND_MCP_TOOLS = new Set([
  "host_read_file",
  "mcp__kimi_cu__list_apps",
  "mcp__kimi_cu__list_windows",
  "mcp__kimi_cu__get_window",
  "mcp__kimi_cu__get_app_state",
  "mcp__kimi_cu__get_window_state",
]);

function normalizeCandidatePath(filePath: unknown): string {
  if (typeof filePath !== "string") return "";
  const trimmed = filePath.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return HOME_DIR;
  if (trimmed.startsWith("~/")) {
    return path.resolve(HOME_DIR, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function isPathDenied(filePath: unknown): boolean {
  const resolved = normalizeCandidatePath(filePath);
  if (!resolved) return false;
  const resolvedLower = resolved.toLowerCase();

  for (const deniedDir of DENIED_DIRS) {
    const deniedLower = deniedDir.toLowerCase();
    if (resolvedLower === deniedLower || resolvedLower.startsWith(deniedLower + path.sep)) {
      return true;
    }
  }

  const segments = resolved.split(path.sep);
  if (segments.some((s) => DENIED_SEGMENTS.has(s.toLowerCase()))) {
    return true;
  }

  const base = path.basename(resolved).toLowerCase();
  if (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "accounts.json" ||
    base === "desktop-config.json" ||
    base === "devices.json" ||
    base === "vault.json" ||
    base === ".vault.key" ||
    base === ".vault.dpapi" ||
    /.*auth.*\.json$/i.test(base)
  ) {
    return true;
  }

  return false;
}

function isSelfControlMcpAttempt(name: string, safeArgs: Record<string, any>): boolean {
  if (!isMcpToolName(name)) return false;
  const app = String(safeArgs.app || "").trim().toLowerCase();
  if (app === "com.twinklebot.desktop") {
    return true;
  }
  const serialized = JSON.stringify(safeArgs).toLowerCase();
  if (serialized.includes("com.twinklebot.desktop")) {
    return true;
  }
  return false;
}

function matchesCustomRule(
  rule: { tool?: string; pattern?: string; label?: string } | null | undefined,
  name: string,
  safeArgs: Record<string, any>
): boolean {
  if (!rule || typeof rule !== "object") return false;
  const ruleTool = String(rule.tool || "").trim();
  if (ruleTool && ruleTool !== "*" && ruleTool !== name) {
    return false;
  }
  const pattern = String(rule.pattern || "").trim().toLowerCase();
  if (!pattern) {
    return Boolean(ruleTool);
  }
  const haystack = `${name} ${JSON.stringify(safeArgs)}`.toLowerCase();
  return haystack.includes(pattern);
}

export interface PolicyAssessment {
  decision: "allow" | "deny" | "confirm";
  reason: string;
}

export function assessToolCall(
  name: string,
  args: Record<string, any> = {},
  config: Record<string, any> = {}
): PolicyAssessment {
  const safeArgs = args && typeof args === "object" ? args : {};
  const isLocalHostAction = isHostTool(name) || isMcpToolName(name);
  const hostExecutionMode = config?.hostExecutionMode || "always";

  // 0. Host execution master switch ("off" = 从不允许)
  if (isLocalHostAction && hostExecutionMode === "off") {
    return {
      decision: "deny",
      reason: "「你的电脑」执行权限当前设为「从不允许」",
    };
  }

  // 1. Hardcoded non-bypassable guardrails
  if (isSelfControlMcpAttempt(name, safeArgs)) {
    return {
      decision: "deny",
      reason: "禁止操控 TwinkleBot 自身窗口（防自授权安全保护）",
    };
  }

  if (
    name === "read_file" ||
    name === "write_file" ||
    name === "host_read_file" ||
    name === "host_write_file"
  ) {
    if (isPathDenied(safeArgs.path)) {
      return {
        decision: "deny",
        reason: `Access to sensitive path '${safeArgs.path}' is denied`,
      };
    }
    if (
      config?.botWorkspaceSessionId &&
      config?.baseWorkspaceRoot &&
      isOtherBotPrivateWorkspacePath(
        safeArgs.path,
        [config.baseWorkspaceRoot],
        config.botWorkspaceSessionId
      )
    ) {
      return {
        decision: "confirm",
        reason: "目标路径属于其他 Bot 的专属工作区/资料库，需用户确认后方可访问",
      };
    }
  }

  if (name === "host_run_shell" || name === "run_shell") {
    const cmd = typeof safeArgs.command === "string" ? safeArgs.command : "";
    if (DENIED_KEYCHAIN_SHELL_RE.test(cmd)) {
      return {
        decision: "deny",
        reason: "禁止通过命令行导出 macOS 钥匙串明文密码",
      };
    }
  }

  // 2. Dynamic user policy rules (from Settings -> 权限)
  const policy = config?.policy;
  if (policy && policy.autoAudit !== false) {
    const askRules = Array.isArray(policy.askRules) ? policy.askRules : [];
    for (const rule of askRules) {
      if (matchesCustomRule(rule, name, safeArgs)) {
        return {
          decision: "confirm",
          reason: rule.label || `Matched ask rule: ${rule.tool || "*"} ${rule.pattern || ""}`.trim(),
        };
      }
    }

    if (safeArgs.risk !== "high") {
      const allowRules = Array.isArray(policy.allowRules) ? policy.allowRules : [];
      for (const rule of allowRules) {
        if (matchesCustomRule(rule, name, safeArgs)) {
          return {
            decision: "allow",
            reason: rule.label || "Allowed by user permission rule",
          };
        }
      }
    }
  }

  // 3. High risk action confirmation
  if (safeArgs.risk === "high") {
    return {
      decision: "confirm",
      reason: "Action is flagged as high risk",
    };
  }

  // 4. Sandbox high-privilege mode: Bot Computer tools run freely inside isolated sandbox
  const sandboxMode = config?.sandboxMode || "restricted";
  if (sandboxMode === "full" && SANDBOX_TOOLS.has(name) && !isLocalHostAction) {
    return {
      decision: "allow",
      reason: "Bot Computer sandbox high-privilege mode",
    };
  }

  // 5. Host execution mode "ask" ("每次询问"): confirm all mutating host/MCP calls
  if (
    isLocalHostAction &&
    hostExecutionMode === "ask" &&
    !READ_ONLY_HOST_AND_MCP_TOOLS.has(name)
  ) {
    return {
      decision: "confirm",
      reason: "「你的电脑」当前设为「每次询问」",
    };
  }

  // 5b. Host screen recording requires confirmation unless allowlisted by policy rule
  if (name === "host_record_screen") {
    return {
      decision: "confirm",
      reason: "客户端主机录屏需要确认",
    };
  }

  // 6. Shell dangerous command confirmation
  if (name === "run_shell" || name === "host_run_shell") {
    const command = typeof safeArgs.command === "string" ? safeArgs.command : "";
    if (CONFIRM_SHELL_RE.test(command)) {
      return {
        decision: "confirm",
        reason: "Shell command requires confirmation",
      };
    }
  }

  // 6. File write outside writeRoots confirmation
  if (name === "write_file" || name === "host_write_file") {
    const filePath = safeArgs.path;
    const writeRoots = Array.isArray(config?.writeRoots) ? config.writeRoots : [];
    const resolvedPath = normalizeCandidatePath(filePath);
    if (!resolvedPath) {
      return {
        decision: "confirm",
        reason: `Missing or invalid file path for ${name}`,
      };
    }
    const isInsideRoots = writeRoots.some((root: unknown) => {
      const resolvedRoot = normalizeCandidatePath(root);
      if (!resolvedRoot) return false;
      return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
    });

    if (!isInsideRoots) {
      return {
        decision: "confirm",
        reason: `Write path '${filePath}' is outside allowed write roots`,
      };
    }
  }

  return {
    decision: "allow",
    reason: "Action allowed",
  };
}
