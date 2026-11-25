import os from "node:os";
import path from "node:path";
import { isHostTool } from "./host-tools.js";
import { isMcpToolName } from "../lib/mcp-client.js";
import { isOtherBotPrivateWorkspacePath } from "../lib/bot-workspace.js";
import { extractSuggestedCommandPattern } from "../shared/policy-utils.js";

export { extractSuggestedCommandPattern };

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

const DENIED_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", "keychains", "chrome-debug-profile"]);

const SENSITIVE_CONFIG_BASENAMES = new Set([
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".gitconfig",
  "crontab",
  "sudoers",
  "hosts",
]);

const SENSITIVE_SYSTEM_DIR_PREFIXES = [
  "/etc/",
  "/system/",
  "/usr/",
  "/sbin/",
  "/bin/",
  "/library/launchdaemons/",
  "/library/launchagents/",
  "c:\\windows\\",
  "c:/windows/",
];

const PIPE_TO_SHELL_RE =
  /(?:^|[;&|\n]\s*)(?:curl|wget)\b[^|\n]*\|\s*(?:env\s+)?(?:ba|z|da|k)?sh\b/i;

const SHELL_WRAPPER_CMDS = new Set([
  "command",
  "builtin",
  "nohup",
  "time",
  "nice",
  "env",
  "xargs",
]);

const DANGEROUS_COMMAND_NAMES = new Set([
  "sudo",
  "doas",
  "su",
  "rm",
  "unlink",
  "shred",
  "srm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "mkfs",
  "fdisk",
  "parted",
  "diskpart",
  "format-volume",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
]);

function isSensitiveConfigPath(filePath: unknown): boolean {
  const resolved = normalizeCandidatePath(filePath);
  if (!resolved) return false;
  const normalizedSlashes = resolved.replace(/\\/g, "/");
  const lower = normalizedSlashes.toLowerCase();
  const base = path.basename(resolved).toLowerCase();

  if (SENSITIVE_CONFIG_BASENAMES.has(base)) {
    return true;
  }
  if (lower.includes("/library/launchagents/") || lower.includes("/library/launchdaemons/")) {
    return true;
  }
  for (const prefix of SENSITIVE_SYSTEM_DIR_PREFIXES) {
    if (lower === prefix.slice(0, -1) || lower.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Strip single/double quoted string literals (keeping `$(...)` and backtick substitutions
 * inside double quotes visible for inspection), and collect quoted payloads of `sh -c` / `eval`.
 */
function stripShellQuotesForScan(command: string): {
  sanitized: string;
  nestedPayloads: string[];
  quotedRedirectTargets: string[];
} {
  let out = "";
  const nestedPayloads: string[] = [];
  const quotedRedirectTargets: string[] = [];
  let i = 0;
  const n = command.length;

  while (i < n) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const before = out.trimEnd();
      const isInlineShellExec =
        /(?:^|[;&|\n(]\s*)(?:(?:\/[\w./-]*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c|eval)\s*$/i.test(before);
      const isRedirectTarget = /(?:^|[\s\d&])>{1,2}$/.test(before);
      i += 1;
      let literal = "";
      out += " ";
      while (i < n) {
        const c = command[i];
        if (quote === '"' && c === "\\" && i + 1 < n) {
          literal += command[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        // Keep command substitutions inside double quotes so `echo "$(rm -rf /)"` is still caught
        if (quote === '"' && c === "$" && command[i + 1] === "(") {
          let depth = 1;
          let sub = "$(";
          i += 2;
          while (i < n && depth > 0) {
            const sc = command[i];
            if (sc === "(") depth += 1;
            else if (sc === ")") depth -= 1;
            sub += sc;
            i += 1;
          }
          out += ` ${sub} `;
          literal += sub;
          continue;
        }
        if (quote === '"' && c === "`") {
          let sub = "`";
          i += 1;
          while (i < n && command[i] !== "`") {
            sub += command[i];
            i += 1;
          }
          if (i < n) {
            sub += "`";
            i += 1;
          }
          out += ` ${sub} `;
          literal += sub;
          continue;
        }
        literal += c;
        i += 1;
      }
      if (isInlineShellExec && literal.trim()) {
        nestedPayloads.push(literal);
      }
      if (isRedirectTarget && literal.trim()) {
        quotedRedirectTargets.push(literal.trim());
      }
      continue;
    }
    out += ch;
    i += 1;
  }

  return { sanitized: out, nestedPayloads, quotedRedirectTargets };
}

function isDangerousShellCommand(
  command: string,
  { allowNormalMv = false }: { allowNormalMv?: boolean } = {},
  depth = 0
): boolean {
  if (!command || depth > 3) return false;
  if (PIPE_TO_SHELL_RE.test(command)) return true;

  const { sanitized, nestedPayloads, quotedRedirectTargets } = stripShellQuotesForScan(command);

  // Output redirection (`>`, `>>`, `1>`, `2>`, `&>`) targeting sensitive configs or denied paths
  for (const qTarget of quotedRedirectTargets) {
    if (isPathDenied(qTarget) || isSensitiveConfigPath(qTarget)) {
      return true;
    }
  }
  const redirectRe = /(?:\d?>{1,2}|&>{1,2})\s*([^\s;&|)`]+)/g;
  let redirMatch: RegExpExecArray | null;
  while ((redirMatch = redirectRe.exec(sanitized)) !== null) {
    const target = redirMatch[1];
    if (target && (isPathDenied(target) || isSensitiveConfigPath(target))) {
      return true;
    }
  }

  // Split by shell command boundaries (;, &&, ||, |, &, newline, $(, backtick)
  const segments = sanitized.split(/(?:&&|\|\||[;\n|&`]|\$\(|\))/);
  for (const rawSeg of segments) {
    let seg = rawSeg.trim();
    if (!seg) continue;

    // Strip leading environment variable assignments (e.g. FOO=1 BAR=baz cmd)
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(seg)) {
      seg = seg.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "").trim();
    }
    if (!seg) continue;

    const tokens = seg.split(/\s+/).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length) {
      const tokBase = path.basename(tokens[idx]).toLowerCase();
      if (SHELL_WRAPPER_CMDS.has(tokBase)) {
        idx += 1;
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          idx += 1;
        }
        continue;
      }
      break;
    }
    if (idx >= tokens.length) continue;

    const cmdBase = path.basename(tokens[idx]).toLowerCase();
    const restTokens = tokens.slice(idx + 1);
    const restStr = restTokens.join(" ");

    if (DANGEROUS_COMMAND_NAMES.has(cmdBase) || cmdBase.startsWith("mkfs.")) {
      return true;
    }
    if (cmdBase === "dd" && /\b(?:if|of)=/i.test(restStr)) {
      return true;
    }
    if (cmdBase === "format" && /(?:^|\s)[a-z]:/i.test(restStr)) {
      return true;
    }
    if (cmdBase === "diskutil" && /\b(erase\w*|partitiondisk)\b/i.test(restStr)) {
      return true;
    }
    if (
      cmdBase === "find" &&
      (/(?:^|\s)-delete(?:\s|$)/i.test(restStr) ||
        /(?:^|\s)-exec\s+(?:\/[\w./-]*\/)?(?:rm|unlink|shred)\b/i.test(restStr))
    ) {
      return true;
    }
    if (cmdBase === "git") {
      let gi = 0;
      while (gi < restTokens.length && restTokens[gi].startsWith("-")) {
        const flag = restTokens[gi];
        gi += 1;
        if (
          (flag === "-C" ||
            flag === "-c" ||
            flag === "--git-dir" ||
            flag === "--work-tree" ||
            flag === "--namespace") &&
          gi < restTokens.length
        ) {
          gi += 1;
        }
      }
      const gitSub = (restTokens[gi] || "").toLowerCase();
      const gitArgs = restTokens.slice(gi + 1);
      if (
        gitSub === "push" &&
        gitArgs.some(
          (t) =>
            t === "--force" ||
            t === "-f" ||
            (/^-[a-z]*f[a-z]*$/i.test(t) && !t.startsWith("--"))
        )
      ) {
        return true;
      }
      if (gitSub === "reset" && gitArgs.some((t) => t === "--hard")) {
        return true;
      }
      if (
        gitSub === "clean" &&
        gitArgs.some(
          (t) =>
            t === "--force" ||
            t === "-f" ||
            (/^-[a-z]*f[a-z]*$/i.test(t) && !t.startsWith("--"))
        )
      ) {
        return true;
      }
    }
    if (cmdBase === "tee" || cmdBase === "cp" || cmdBase === "install" || cmdBase === "ln") {
      const pathArgs = restTokens.filter((tok) => tok && !tok.startsWith("-"));
      if (pathArgs.some((p) => isPathDenied(p) || isSensitiveConfigPath(p))) {
        return true;
      }
    }
    if (cmdBase === "mv" || cmdBase === "move-item") {
      if (!allowNormalMv) {
        return true;
      }
      // Under hostExecutionMode="always", allow moving/renaming normal files,
      // but still confirm if any path touches sensitive directories or system configs.
      const pathArgs = restTokens.filter((tok) => tok && !tok.startsWith("-"));
      if (pathArgs.some((p) => isPathDenied(p) || isSensitiveConfigPath(p))) {
        return true;
      }
    }
  }

  for (const nested of nestedPayloads) {
    if (isDangerousShellCommand(nested, { allowNormalMv }, depth + 1)) {
      return true;
    }
  }

  return false;
}

export function isHostShellSafeForAlwaysMode(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  if (DENIED_KEYCHAIN_SHELL_RE.test(command)) return false;
  return !isDangerousShellCommand(command, { allowNormalMv: true });
}

const SANDBOX_INTERNAL_AUTO_ALLOW_TOOLS = new Set([
  "screenshot",
  "list_windows",
  "focus_window",
  "scroll",
  "drag",
  "run_shell",
  "read_file",
  "write_file",
  "open_url",
  "browser_snapshot",
  "browser_tabs",
  "browser_scroll",
  "browser_wait",
  "browser_select",
  "browser_upload_file",
]);

const SANDBOX_EXTERNAL_INTERACTION_TOOLS = new Set([
  "click",
  "type_text",
  "key",
  "browser_click",
  "browser_type",
]);

const SANDBOX_TOOLS = new Set([
  ...SANDBOX_INTERNAL_AUTO_ALLOW_TOOLS,
  ...SANDBOX_EXTERNAL_INTERACTION_TOOLS,
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
    base === "frpc.toml" ||
    base === "frps.toml" ||
    base === "relay-token" ||
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

  if (name === "browser_upload_file") {
    const rawPaths = Array.isArray(safeArgs.paths)
      ? safeArgs.paths
      : typeof safeArgs.paths === "string"
        ? [safeArgs.paths]
        : typeof safeArgs.path === "string"
          ? [safeArgs.path]
          : [];
    const isLocalHostBrowser =
      Boolean(config?.browserAutomationMode) &&
      config?.browserAutomationMode !== "bot_computer";
    const hostMode = String(config?.hostExecutionMode || "ask");
    if (isLocalHostBrowser && hostMode === "off") {
      return {
        decision: "deny",
        reason: "当前「你的电脑」执行权限已设为「从不允许」，禁止本机浏览器读取上传宿主机文件",
      };
    }
    let needsHostConfirm = false;
    for (const p of rawPaths) {
      if (isPathDenied(p)) {
        return {
          decision: "deny",
          reason: `Uploading sensitive path '${p}' is denied`,
        };
      }
      if (
        config?.botWorkspaceSessionId &&
        config?.baseWorkspaceRoot &&
        isOtherBotPrivateWorkspacePath(
          p,
          [config.baseWorkspaceRoot],
          config.botWorkspaceSessionId
        )
      ) {
        return {
          decision: "confirm",
          reason: "待上传文件属于其他 Bot 的专属工作区/资料库，需用户确认后方可访问",
        };
      }
      if (isLocalHostBrowser && hostMode === "ask") {
        const resolved = normalizeCandidatePath(p);
        const ownWs = config?.botWorkspaceRoot
          ? path.resolve(String(config.botWorkspaceRoot))
          : "";
        const insideOwnWs =
          Boolean(ownWs) &&
          (resolved === ownWs || resolved.startsWith(ownWs + path.sep));
        if (!insideOwnWs) {
          needsHostConfirm = true;
        }
      }
    }
    if (needsHostConfirm) {
      return {
        decision: "confirm",
        reason: "本机浏览器即将读取并上传宿主机文件，需用户确认后方可继续",
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

  const sandboxMode = config?.sandboxMode || "full";
  const policy = config?.policy;
  const autoAuditEnabled = policy?.autoAudit !== false;

  // 2. Dynamic user policy rules (from Settings -> 权限)
  if (policy) {
    // 2a. Explicit askRules ALWAYS apply (even when autoAudit === false)
    const askRules = Array.isArray(policy.askRules) ? policy.askRules : [];
    for (const rule of askRules) {
      if (matchesCustomRule(rule, name, safeArgs)) {
        return {
          decision: "confirm",
          reason: rule.label || `Matched ask rule: ${rule.tool || "*"} ${rule.pattern || ""}`.trim(),
        };
      }
    }

    // 2b. Explicit allowRules:
    // - Always honored when risk !== "high".
    // - Also honored for Bot Computer external interactive tools (browser_click / browser_type /
    //   click / type_text / key) under sandboxMode="full" and specific (non-wildcard) rules under
    //   hostExecutionMode="always", so clicking "始终允许" actually suppresses repeat prompts.
    // - Under hostExecutionMode="ask", risk === "high" must NEVER be bypassed by allowRules.
    const canAllowRuleBypassHighRisk =
      (sandboxMode === "full" && SANDBOX_EXTERNAL_INTERACTION_TOOLS.has(name)) ||
      (isLocalHostAction && hostExecutionMode === "always");
    const allowRules = Array.isArray(policy.allowRules) ? policy.allowRules : [];
    for (const rule of allowRules) {
      const ruleTool = String(rule?.tool || "").trim();
      const rulePat = String(rule?.pattern || "").trim();
      const isWildcardRule =
        (!ruleTool || ruleTool === "*") && (!rulePat || rulePat === "*");
      if (safeArgs.risk === "high" && (!canAllowRuleBypassHighRisk || isWildcardRule)) {
        continue;
      }
      if (matchesCustomRule(rule, name, safeArgs)) {
        return {
          decision: "allow",
          reason: rule.label || "Allowed by user permission rule",
        };
      }
    }
  }

  // 3. High risk action confirmation (skipped when policy.autoAudit === false)
  // - Under sandboxMode="full", internal Bot Computer tools (shell, files, reads, navigation,
  //   scroll, wait, select, upload) run in an isolated sandbox and ignore spurious LLM risk="high".
  // - Under hostExecutionMode="always", ignore spurious LLM risk="high" on read-only host/MCP
  //   inspection, host_open, non-sensitive host_write_file, and deterministic-safe host_run_shell
  //   commands (e.g. `cd /repo && git commit`, `./deploy.sh`), while still confirming real
  //   destructive/privileged shell commands, sensitive config writes, and risky MCP GUI actions.
  const ignoreSpuriousHighRisk =
    (sandboxMode === "full" && SANDBOX_INTERNAL_AUTO_ALLOW_TOOLS.has(name) && !isLocalHostAction) ||
    (hostExecutionMode === "always" &&
      (READ_ONLY_HOST_AND_MCP_TOOLS.has(name) ||
        name === "host_open" ||
        (name === "host_write_file" &&
          Boolean(normalizeCandidatePath(safeArgs.path)) &&
          !isSensitiveConfigPath(safeArgs.path)) ||
        (name === "host_run_shell" && isHostShellSafeForAlwaysMode(safeArgs.command))));
  if (autoAuditEnabled && safeArgs.risk === "high" && !ignoreSpuriousHighRisk) {
    return {
      decision: "confirm",
      reason: "Action is flagged as high risk",
    };
  }

  // 4. Sandbox high-privilege mode (default "full"): Bot Computer tools run freely inside isolated sandbox
  if (sandboxMode === "full" && SANDBOX_TOOLS.has(name) && !isLocalHostAction) {
    if (name === "write_file" && !normalizeCandidatePath(safeArgs.path)) {
      return {
        decision: "confirm",
        reason: `Missing or invalid file path for ${name}`,
      };
    }
    return {
      decision: "allow",
      reason: "Bot Computer sandbox auto-allowed",
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

  // 6. Shell dangerous command confirmation (host_run_shell, or restricted sandbox run_shell)
  if (name === "run_shell" || name === "host_run_shell") {
    const command = typeof safeArgs.command === "string" ? safeArgs.command : "";
    const allowNormalMv = name === "host_run_shell" && hostExecutionMode === "always";
    if (isDangerousShellCommand(command, { allowNormalMv })) {
      return {
        decision: "confirm",
        reason: "Shell command requires confirmation",
      };
    }
  }

  // 7. File write path validation & writeRoots boundary
  if (name === "write_file" || name === "host_write_file") {
    const filePath = safeArgs.path;
    const resolvedPath = normalizeCandidatePath(filePath);
    if (!resolvedPath) {
      return {
        decision: "confirm",
        reason: `Missing or invalid file path for ${name}`,
      };
    }
    // When "你的电脑" is set to "始终允许" ("always"), allow non-sensitive host file writes
    // outside writeRoots without prompting, while still confirming sensitive shell/system configs
    // (hardcoded credential paths remain strictly denied in step 1).
    if (name === "host_write_file" && hostExecutionMode === "always") {
      if (isSensitiveConfigPath(filePath)) {
        return {
          decision: "confirm",
          reason: `修改敏感配置文件 '${filePath}' 需要确认`,
        };
      }
      return {
        decision: "allow",
        reason: "Host file write allowed under hostExecutionMode=always",
      };
    }
    const writeRoots = Array.isArray(config?.writeRoots) ? config.writeRoots : [];
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
