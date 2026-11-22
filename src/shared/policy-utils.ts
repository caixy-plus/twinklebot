const CONTEXT_SETUP_CMDS = new Set([
  "cd",
  "pushd",
  "popd",
  "pwd",
  "export",
  "unset",
  "set",
  "source",
  ".",
  "true",
  "umask",
  "alias",
]);

const WRAPPER_CMDS = new Set([
  "command",
  "builtin",
  "nohup",
  "time",
  "nice",
  "env",
]);

const SUBCOMMAND_CMDS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "brew",
  "docker",
  "kubectl",
  "orb",
  "systemctl",
  "launchctl",
  "cargo",
  "gh",
  "firebase",
  "gcloud",
  "aws",
  "az",
  "terraform",
  "helm",
  "apt",
  "apt-get",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "sudo",
  "doas",
]);

const RUN_SCRIPT_CMDS = new Set(["npm", "pnpm", "yarn", "bun"]);

function splitShellSegmentsRespectingQuotes(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  const n = command.length;

  while (i < n) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (quote === '"' && ch === "\\" && i + 1 < n) {
        current += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (
      (ch === "&" && command[i + 1] === "&") ||
      (ch === "|" && command[i + 1] === "|")
    ) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 2;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeSegment(seg: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  const n = seg.length;

  while (i < n) {
    const ch = seg[i];
    if (quote) {
      current += ch;
      if (quote === '"' && ch === "\\" && i + 1 < n) {
        current += seg[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current) tokens.push(current);
  return tokens;
}

function stripOuterQuotes(tok: string): string {
  if (
    tok.length >= 2 &&
    ((tok.startsWith('"') && tok.endsWith('"')) ||
      (tok.startsWith("'") && tok.endsWith("'")))
  ) {
    return tok.slice(1, -1);
  }
  return tok;
}

function basenameOf(tok: string): string {
  const clean = stripOuterQuotes(tok);
  const parts = clean.split(/[\\/]/);
  return (parts[parts.length - 1] || clean).toLowerCase();
}

function isEnvAssignmentToken(tok: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok);
}

function isSimpleSubcommandToken(tok: string): boolean {
  if (!tok || tok.startsWith("-")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(tok);
}

/**
 * Extract a meaningful, verbatim-matching command pattern for "Always Allow" rules.
 * Skips leading context-setup segments (`cd <dir>`, `export K=V`, `FOO=bar`) so compound
 * commands like `cd /Users/.../blog && git commit -m "hi"` suggest `git commit` instead of `cd`.
 */
export function extractSuggestedCommandPattern(command: unknown): string {
  if (typeof command !== "string") return "";
  const trimmed = command.trim();
  if (!trimmed) return "";

  const segments = splitShellSegmentsRespectingQuotes(trimmed);
  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg || seg.startsWith("#")) continue;

    const tokens = tokenizeSegment(seg);
    let idx = 0;

    // Skip leading env assignments (FOO=1 BAR="a b") and transparent wrappers (env, time, nohup, ...)
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (isEnvAssignmentToken(tok)) {
        idx += 1;
        continue;
      }
      const base = basenameOf(tok);
      if (WRAPPER_CMDS.has(base)) {
        idx += 1;
        while (idx < tokens.length && (tokens[idx].startsWith("-") || isEnvAssignmentToken(tokens[idx]))) {
          const flag = tokens[idx];
          idx += 1;
          if (
            (base === "env" &&
              (flag === "-u" || flag === "--unset" || flag === "-C" || flag === "--chdir" || flag === "-S" || flag === "--split-string")) ||
            (base === "nice" && (flag === "-n" || flag === "--adjustment"))
          ) {
            if (idx < tokens.length) idx += 1;
          }
        }
        continue;
      }
      break;
    }

    if (idx >= tokens.length) continue;

    const cmdToken = tokens[idx];
    const cmdBase = basenameOf(cmdToken);
    if (CONTEXT_SETUP_CMDS.has(cmdBase)) {
      continue;
    }

    const nextTok = tokens[idx + 1];
    if (SUBCOMMAND_CMDS.has(cmdBase) && nextTok && isSimpleSubcommandToken(nextTok)) {
      const nextLower = nextTok.toLowerCase();
      const thirdTok = tokens[idx + 2];
      if (
        RUN_SCRIPT_CMDS.has(cmdBase) &&
        nextLower === "run" &&
        thirdTok &&
        isSimpleSubcommandToken(thirdTok)
      ) {
        return `${cmdToken} ${nextTok} ${thirdTok}`;
      }
      return `${cmdToken} ${nextTok}`;
    }

    return cmdToken;
  }

  // Fallback if the command consisted exclusively of setup statements (e.g. a bare `cd /tmp`)
  return trimmed.slice(0, 60);
}
