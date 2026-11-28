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

// Destructive / privileged verbs: "Always Allow" must never generalize these to a bare
// verb prefix (e.g. saving `rm` would silently allow every future `rm -rf <anything>`).
const DESTRUCTIVE_RULE_VERBS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "trash",
  "mv",
  "dd",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
  "chflags",
  "kill",
  "killall",
  "pkill",
  "diskutil",
  "format",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "sudo",
  "doas",
  "su",
]);

function segmentVerbIsDestructive(tokens: string[]): boolean {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (isEnvAssignmentToken(tok)) {
      idx += 1;
      continue;
    }
    const base = basenameOf(tok);
    if (WRAPPER_CMDS.has(base) || base === "xargs") {
      idx += 1;
      while (idx < tokens.length && (tokens[idx].startsWith("-") || isEnvAssignmentToken(tokens[idx]))) {
        idx += 1;
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return false;
  const verb = basenameOf(tokens[idx]);
  if (DESTRUCTIVE_RULE_VERBS.has(verb) || verb.startsWith("mkfs")) return true;
  const rest = tokens.slice(idx + 1).map((t) => stripOuterQuotes(t).toLowerCase());
  if (verb === "find" && rest.some((t) => t === "-delete" || t === "-exec" || t === "-execdir")) {
    return true;
  }
  if (verb === "git") {
    const forceFlag = (t: string) => t === "--force" || t === "-f" || /^-[a-z]*f[a-z]*$/.test(t);
    const sub = rest.find((t) => !t.startsWith("-")) || "";
    const subArgs = rest.slice(rest.indexOf(sub) + 1);
    if (sub === "push" && subArgs.some((t) => forceFlag(t) || t.startsWith("--force-with-lease") || t.startsWith("+"))) return true;
    if (sub === "reset" && subArgs.includes("--hard")) return true;
    if (sub === "clean" && subArgs.some(forceFlag)) return true;
  }
  // Infrastructure destroy verbs: `terraform destroy` is irreversible, never a reusable prefix.
  if (verb === "terraform" || verb === "pulumi" || verb === "vagrant" || verb === "cdk") {
    if (rest.some((t) => t === "destroy")) return true;
  }
  if (verb === "docker" && (rest.includes("prune") || (rest[0] === "rm" && rest.some((t) => t === "-f" || t === "--force")))) {
    return true;
  }
  return false;
}

/**
 * True when any segment of `command` runs a destructive or privileged verb (rm, mv, sudo,
 * chmod, kill, `find -delete`, `git push --force`, ...). Allow rules for such commands must be
 * the exact full command (incl. paths), never a reusable verb prefix.
 */
export function isDestructiveShellCommandForRule(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  for (const seg of splitShellSegmentsRespectingQuotes(command.trim())) {
    // Also inspect each side of single pipes (`ls | xargs rm`)
    for (const piece of seg.split(/(?<!\|)\|(?!\|)/)) {
      if (segmentVerbIsDestructive(tokenizeSegment(piece.trim()))) return true;
    }
  }
  return false;
}

// Whole-disk / whole-home / system-root targets. No allow rule may ever cover these.
const CATASTROPHIC_VERBS = new Set([
  "rm",
  "srm",
  "trash",
  "shred",
  "rmdir",
  "unlink",
  "rd",
  "del",
  "erase",
  "remove-item",
  "ri",
]);

export type CatastrophicShellLevel = "hard-deny" | "force-confirm";

function isHardCatastrophicTarget(raw: string): boolean {
  const t = stripOuterQuotes(String(raw || "")).trim();
  if (!t) return false;
  const noTrail = t.replace(/\/+$/, "");
  // Filesystem root: `/`, `//`, `/*`, `/.`, `/..`
  if (noTrail === "") return true;
  if (/^\/(?:\*|\.|\.\.)$/.test(noTrail)) return true;
  // Home directory shorthand: `~`, `~/`, `~/*`, `$HOME`, `${HOME}`, `$HOME/*`, `${HOME}/*`
  if (noTrail === "~" || noTrail === "$HOME" || noTrail === "${HOME}") return true;
  if (/^~\/(?:\*|\.|\.\.)$/.test(noTrail) || /^\$(?:\{HOME\}|HOME)\/(?:\*|\.|\.\.)$/.test(noTrail)) {
    return true;
  }
  // An entire user's home: `/Users/<name>`, `/home/<name>`, and their `/*`, `/.`, `/..` forms
  if (/^\/(?:Users|home)\/[^/*]+$/.test(noTrail)) return true;
  if (/^\/(?:Users|home)\/[^/*]+\/(?:\*|\.|\.\.)$/.test(noTrail)) return true;
  // System roots
  if (
    /^\/(?:etc|usr|bin|sbin|lib|lib64|System|Library|Applications|opt|var|boot|dev|cores)$/i.test(
      noTrail
    )
  ) {
    return true;
  }
  if (
    /^\/(?:etc|usr|System|Library|Applications|bin|sbin|lib|opt|var|boot|dev)\/(?:\*|\.|\.\.)$/i.test(
      noTrail
    )
  ) {
    return true;
  }
  return false;
}

function isBroadUserFolderWipeTarget(raw: string): boolean {
  const t = stripOuterQuotes(String(raw || "")).trim();
  if (!t) return false;
  const noTrail = t.replace(/\/+$/, "");
  return (
    /^~\/[^/]+\/(?:\*|\.|\.\.)$/.test(noTrail) ||
    /^\$(?:\{HOME\}|HOME)\/[^/]+\/(?:\*|\.|\.\.)$/.test(noTrail)
  );
}

function isCwdWildcardTarget(raw: string): boolean {
  const s = stripOuterQuotes(String(raw || "")).trim();
  return s === "*" || s === "." || s === "./" || s === "./*";
}

function maxCatastrophicLevel(
  a: CatastrophicShellLevel | null,
  b: CatastrophicShellLevel | null
): CatastrophicShellLevel | null {
  if (a === "hard-deny" || b === "hard-deny") return "hard-deny";
  if (a === "force-confirm" || b === "force-confirm") return "force-confirm";
  return null;
}

function classifySegmentCatastrophic(
  tokens: string[],
  cwdLevel: CatastrophicShellLevel | null = null
): CatastrophicShellLevel | null {
  if (!tokens.length) return null;
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (isEnvAssignmentToken(tok)) {
      idx += 1;
      continue;
    }
    const base = basenameOf(tok);
    // Privilege / wrapper prefixes are transparent: `sudo rm -rf /` is still catastrophic.
    if (WRAPPER_CMDS.has(base) || base === "xargs" || base === "sudo" || base === "doas") {
      idx += 1;
      while (
        idx < tokens.length &&
        (tokens[idx].startsWith("-") || isEnvAssignmentToken(tokens[idx]))
      ) {
        idx += 1;
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return null;

  const verb = basenameOf(tokens[idx]);
  const restRaw = tokens.slice(idx + 1);
  const rest = restRaw.map((t) => stripOuterQuotes(t).toLowerCase());
  const classifyTarget = (t: string): CatastrophicShellLevel | null => {
    if (isHardCatastrophicTarget(t)) return "hard-deny";
    if (cwdLevel === "hard-deny" && isCwdWildcardTarget(t)) return "hard-deny";
    if (isBroadUserFolderWipeTarget(t)) return "force-confirm";
    if (cwdLevel === "force-confirm" && isCwdWildcardTarget(t)) return "force-confirm";
    return null;
  };
  const worstOperandLevel = (candidates: string[]): CatastrophicShellLevel | null => {
    let worst: CatastrophicShellLevel | null = null;
    for (const c of candidates) {
      worst = maxCatastrophicLevel(worst, classifyTarget(c));
      if (worst === "hard-deny") return "hard-deny";
    }
    return worst;
  };

  if (CATASTROPHIC_VERBS.has(verb)) {
    return worstOperandLevel(
      restRaw.filter((t) => !stripOuterQuotes(t).startsWith("-"))
    );
  }
  // Disk/partition destruction
  if (verb.startsWith("mkfs")) return "hard-deny";
  if (verb === "dd" && rest.some((t) => /^of=\/dev\/(?:disk|rdisk|sd|nvme|mmcblk|vd)/.test(t))) {
    return "hard-deny";
  }
  if (verb === "diskutil" && rest.some((t) => /^(?:erasedisk|erasevolume|partitiondisk|reformat|zeroDisk|secureErase)/.test(t))) {
    return "hard-deny";
  }
  if (verb === "fdisk" || verb === "parted" || verb === "sgdisk" || verb === "gdisk") {
    if (tokens.slice(idx + 1).some((t) => /^\/dev\//.test(stripOuterQuotes(t)))) {
      return "hard-deny";
    }
  }
  // Recursive permission/ownership change on a system root
  if (
    (verb === "chmod" || verb === "chown" || verb === "chgrp") &&
    rest.some((t) => t === "--recursive" || /^-[a-z]*r[a-z]*$/.test(t))
  ) {
    return worstOperandLevel(
      restRaw.filter((t) => !stripOuterQuotes(t).startsWith("-"))
    );
  }
  if (verb === "find" && rest.some((t) => t === "-delete" || t === "-exec" || t === "-execdir")) {
    return worstOperandLevel(restRaw);
  }
  return null;
}

/**
 * Classify catastrophic shell commands into:
 * - `"hard-deny"`: whole disk, system root, or entire home directory (`rm -rf /`, `rm -rf ~`, `mkfs.*`, `dd of=/dev/disk2`, `chmod -R 777 /`).
 * - `"force-confirm"`: broad top-level user folder wipe (`rm -rf ~/Downloads/*`).
 * - `null`: not catastrophic.
 */
export function classifyCatastrophicShellCommand(command: unknown): CatastrophicShellLevel | null {
  if (typeof command !== "string" || !command.trim()) return null;
  let cwdLevel: CatastrophicShellLevel | null = null;
  let worst: CatastrophicShellLevel | null = null;
  for (const seg of splitShellSegmentsRespectingQuotes(command.trim())) {
    const trimmedSeg = seg.trim();
    const segTokens = tokenizeSegment(trimmedSeg);
    let idx = 0;
    while (idx < segTokens.length && isEnvAssignmentToken(segTokens[idx])) {
      idx += 1;
    }
    if (idx < segTokens.length) {
      const cmdBase = basenameOf(segTokens[idx]);
      if (cmdBase === "cd" || cmdBase === "pushd") {
        const cdOperands = extractOperands(segTokens.slice(idx + 1));
        const target = cdOperands[0] ?? "~";
        const noTrail = stripOuterQuotes(target).trim().replace(/\/+$/, "");
        if (isHardCatastrophicTarget(target)) {
          cwdLevel = "hard-deny";
        } else if (
          /^~\/[^/]+$/.test(noTrail) ||
          /^\$(?:\{HOME\}|HOME)\/[^/]+$/.test(noTrail)
        ) {
          cwdLevel = "force-confirm";
        } else {
          cwdLevel = null;
        }
      }
    }
    for (const piece of trimmedSeg.split(/(?<!\|)\|(?!\|)/)) {
      worst = maxCatastrophicLevel(
        worst,
        classifySegmentCatastrophic(tokenizeSegment(piece.trim()), cwdLevel)
      );
      if (worst === "hard-deny") return "hard-deny";
    }
  }
  return worst;
}

/**
 * True for commands that can wipe a whole disk, the entire home directory, or a system root
 * (`rm -rf /`, `rm -rf ~`, `rm -rf /Users/me`, `mkfs.*`, `dd of=/dev/disk2`, ...).
 * These are hard-blocked: NO user allow rule may ever auto-approve them.
 */
export function isCatastrophicShellCommand(command: unknown): boolean {
  return classifyCatastrophicShellCommand(command) !== null;
}

function extractOperands(rawTokens: string[]): string[] {
  const operands: string[] = [];
  let afterDoubleDash = false;
  for (const tok of rawTokens) {
    const clean = stripOuterQuotes(tok);
    if (!afterDoubleDash && clean === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && clean.startsWith("-")) continue;
    operands.push(tok);
  }
  return operands;
}

function isUnanchoredWildcardOperand(tok: string): boolean {
  const s = stripOuterQuotes(tok).trim();
  return s === "*" || s === "." || s === "./" || s === ".." || s === "../";
}

function segmentIsBareDestructive(tokens: string[]): boolean {
  if (!tokens.length) return false;
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (isEnvAssignmentToken(tok)) {
      idx += 1;
      continue;
    }
    const base = basenameOf(tok);
    if (WRAPPER_CMDS.has(base) || base === "xargs") {
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
  if (idx >= tokens.length) return false;

  const verb = basenameOf(tokens[idx]);
  const restRaw = tokens.slice(idx + 1);

  if (verb === "sudo" || verb === "doas" || verb === "su") {
    let flagIdx = 0;
    while (flagIdx < restRaw.length) {
      const f = stripOuterQuotes(restRaw[flagIdx]);
      if (!f.startsWith("-") || f === "--") {
        if (f === "--") flagIdx += 1;
        break;
      }
      flagIdx += 1;
      if (
        (verb === "sudo" || verb === "doas") &&
        (f === "-u" || f === "-g" || f === "-C" || f === "-h" || f === "-p" || f === "-r" || f === "-t") &&
        flagIdx < restRaw.length
      ) {
        flagIdx += 1;
      }
    }
    const inner = restRaw.slice(flagIdx);
    if (inner.length <= 1) return true;
    if (segmentVerbIsDestructive(inner)) return segmentIsBareDestructive(inner);
    return false;
  }

  if (verb === "chmod" || verb === "chown" || verb === "chgrp" || verb === "chflags" || verb === "mv") {
    const operands = extractOperands(restRaw);
    if (operands.length < 2) return true;
    const targets = verb === "mv" ? [operands[operands.length - 1]] : operands.slice(1);
    return targets.every(isUnanchoredWildcardOperand);
  }

  if (verb === "dd") {
    return !restRaw.some((t) => /^of=\S+/i.test(stripOuterQuotes(t)));
  }

  if (DESTRUCTIVE_RULE_VERBS.has(verb) || verb.startsWith("mkfs")) {
    const operands = extractOperands(restRaw);
    if (operands.length === 0) return true;
    return operands.every(isUnanchoredWildcardOperand);
  }

  const restLower = restRaw.map((t) => stripOuterQuotes(t).toLowerCase());

  if (verb === "find" && restLower.some((t) => t === "-delete" || t === "-exec" || t === "-execdir")) {
    const pathTokens: string[] = [];
    for (const t of restRaw) {
      const clean = stripOuterQuotes(t);
      if (clean.startsWith("-") || clean === "(" || clean === "!") break;
      pathTokens.push(clean);
    }
    if (pathTokens.length === 0) return true;
  }

  if (verb === "terraform" || verb === "pulumi" || verb === "vagrant" || verb === "cdk") {
    if (
      restLower.includes("destroy") &&
      !restLower.some(
        (t) =>
          t.startsWith("-target=") ||
          t.startsWith("--target=") ||
          t === "-target" ||
          t === "--target"
      )
    ) {
      return true;
    }
  }

  if (verb === "docker") {
    if (restLower.includes("prune")) return true;
    if (restLower[0] === "rm" && restLower.some((t) => t === "-f" || t === "--force")) {
      if (extractOperands(restRaw.slice(1)).length === 0) return true;
    }
  }

  if (verb === "git") {
    let gi = 0;
    while (gi < restRaw.length && stripOuterQuotes(restRaw[gi]).startsWith("-")) {
      const flag = stripOuterQuotes(restRaw[gi]);
      gi += 1;
      if (
        (flag === "-C" ||
          flag === "-c" ||
          flag === "--git-dir" ||
          flag === "--work-tree" ||
          flag === "--namespace") &&
        gi < restRaw.length
      ) {
        gi += 1;
      }
    }
    const sub = stripOuterQuotes(restRaw[gi] || "").toLowerCase();
    const subArgs = restRaw.slice(gi + 1);
    const subArgsLower = subArgs.map((t) => stripOuterQuotes(t).toLowerCase());
    const forceFlag = (t: string) => t === "--force" || t === "-f" || /^-[a-z]*f[a-z]*$/.test(t);
    if (
      sub === "push" &&
      subArgsLower.some((t) => forceFlag(t) || t.startsWith("--force-with-lease") || t.startsWith("+"))
    ) {
      if (extractOperands(subArgs).length === 0) return true;
    }
    if (sub === "reset" && subArgsLower.includes("--hard")) {
      if (extractOperands(subArgs).length === 0) return true;
    }
    if (sub === "clean" && subArgsLower.some(forceFlag)) {
      if (extractOperands(subArgs).length === 0) return true;
    }
  }

  return false;
}

/**
 * True when a destructive/privileged shell pattern omits concrete target operands
 * (e.g. `rm`, `rm -rf`, `rm *`, `sudo`, `sudo rm`, `mv`, `chmod 755`, `git push --force`,
 * `terraform destroy`). Such overly-broad patterns must never be persisted as allowRules.
 */
export function isBareDestructiveShellPattern(pattern: unknown): boolean {
  if (typeof pattern !== "string" || !pattern.trim()) return false;
  if (!isDestructiveShellCommandForRule(pattern)) return false;
  for (const seg of splitShellSegmentsRespectingQuotes(pattern.trim())) {
    for (const piece of seg.split(/(?<!\|)\|(?!\|)/)) {
      if (segmentIsBareDestructive(tokenizeSegment(piece.trim()))) return true;
    }
  }
  return false;
}

export type UnsafeShellAllowReason = "wildcard" | "catastrophic" | "bare-destructive";

export function classifyUnsafeShellAllowRule(
  rule: { tool?: string; pattern?: string } | null | undefined
): { unsafe: boolean; reason?: UnsafeShellAllowReason } {
  if (!rule || typeof rule !== "object") return { unsafe: false };
  const tool = String(rule.tool || "").trim();
  const pattern = String(rule.pattern || "").trim();
  const isShellTool = tool === "run_shell" || tool === "host_run_shell";
  const isWildcardTool = !tool || tool === "*";

  if (isShellTool) {
    if (!pattern || pattern === "*") return { unsafe: true, reason: "wildcard" };
    if (isCatastrophicShellCommand(pattern)) return { unsafe: true, reason: "catastrophic" };
    if (isBareDestructiveShellPattern(pattern)) {
      return { unsafe: true, reason: "bare-destructive" };
    }
    return { unsafe: false };
  }

  if (isWildcardTool && pattern && pattern !== "*") {
    if (isCatastrophicShellCommand(pattern)) return { unsafe: true, reason: "catastrophic" };
    if (isBareDestructiveShellPattern(pattern)) {
      return { unsafe: true, reason: "bare-destructive" };
    }
  }

  return { unsafe: false };
}

export function sanitizePolicyAllowRules(allowRules: unknown): {
  list: any[];
  removed: Array<{ rule: any; reason: UnsafeShellAllowReason }>;
  changed: boolean;
} {
  if (!Array.isArray(allowRules)) {
    return { list: [], removed: [], changed: false };
  }
  const list: any[] = [];
  const removed: Array<{ rule: any; reason: UnsafeShellAllowReason }> = [];
  for (const rule of allowRules) {
    const verdict = classifyUnsafeShellAllowRule(rule);
    if (verdict.unsafe && verdict.reason) {
      removed.push({ rule, reason: verdict.reason });
    } else {
      list.push(rule);
    }
  }
  return { list, removed, changed: removed.length > 0 };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match for non-destructive shell allowRules against `command` only
 * (never JSON-serialized tool wrapper keys, and `rm` never matches `npm run format`).
 */
export function matchesShellAllowPattern(command: string, rawPattern: string): boolean {
  const normCmd = String(command || "").replace(/\s+/g, " ").trim().toLowerCase();
  const normPat = String(rawPattern || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normCmd || !normPat) return false;
  const escaped = escapeRegExp(normPat);
  const prefix = /^[a-z0-9_]/.test(normPat) ? "(?<![a-z0-9_])" : "";
  const suffix = /[a-z0-9_]$/.test(normPat) ? "(?![a-z0-9_])" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`).test(normCmd);
}

/**
 * Extract a meaningful, verbatim-matching command pattern for "Always Allow" rules.
 * Skips leading context-setup segments (`cd <dir>`, `export K=V`, `FOO=bar`) so compound
 * commands like `cd /Users/.../blog && git commit -m "hi"` suggest `git commit` instead of `cd`.
 * Destructive / privileged commands return the exact full command (with paths) instead.
 */
export function extractSuggestedCommandPattern(command: unknown): string {
  if (typeof command !== "string") return "";
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (isDestructiveShellCommandForRule(trimmed)) return trimmed;

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
