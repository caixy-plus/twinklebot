import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildScrubbedEnv } from "../lib/mcp-client.js";

const execFileAsync = promisify(execFile);

const IS_WIN_HOST = process.platform === "win32";
const HOST_OS_LABEL = IS_WIN_HOST
  ? "Windows PC"
  : process.platform === "darwin"
    ? "Mac"
    : "Linux host";

const RISK_PROP = {
  type: "string",
  enum: ["low", "medium", "high"],
  description:
    `Estimated risk level on the user's ${HOST_OS_LABEL}. Always use 'low'/'medium' for routine reads, searches, cd/git/npm/build/deploy scripts, organizing/renaming files, running normal CLI tools, or editing ordinary files the user asked for. Reserve 'high' ONLY for irreversible external actions (sending messages/posts, payments, orders, agreements), deleting important files (rm), destructive git force-push/reset, modifying sensitive system/shell configs, or privileged sudo commands.`,
};

export const HOST_TOOL_DECLARATIONS = [
  {
    type: "function",
    name: "host_run_shell",
    description: IS_WIN_HOST
      ? "Run a Windows PowerShell command directly on the user's local Windows PC ('你的电脑') via powershell.exe -NoProfile -NonInteractive (UTF-8 & WSL_UTF8=1 pre-enabled). Write native PowerShell 5.1 syntax directly (use ';' instead of '&&' to chain statements; do NOT wrap in an extra 'powershell -Command' call). Supports wsl, git, winget, python, and PowerShell cmdlets. Prefer Bot's Ubuntu computer when isolated sandbox execution is safer."
      : "Run a zsh shell command directly on the user's local Mac ('你的电脑'). Supports macOS CLI tools (open, osascript, shortcuts, brew, git, rg, python3). Do NOT use this when isolated sandbox execution in Bot's Ubuntu computer is safer.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: IS_WIN_HOST
            ? "Command/script to execute on the user's Windows PC (PowerShell 5.1 syntax by default, or bash syntax when `shell: 'wsl'`; UTF-8 & WSL_UTF8=1 pre-enabled)."
            : "zsh command line to execute on the user's Mac.",
        },
        shell: {
          type: "string",
          enum: ["auto", "powershell", "wsl"],
          description: IS_WIN_HOST
            ? "Optional Windows shell selector: 'auto'/'powershell' runs PowerShell 5.1; 'wsl' invokes `wsl.exe -- bash -lc` directly so Linux commands/quotes/pipes work without PowerShell escaping."
            : "Optional shell selector (ignored on macOS/Linux hosts).",
        },
        wsl_distro: {
          type: "string",
          description: "Optional WSL distribution name (e.g. 'Ubuntu') when `shell='wsl'` on Windows.",
        },
        cwd: {
          type: "string",
          description: `Optional working directory on the user's ${HOST_OS_LABEL} (defaults to ~).`,
        },
        timeout: {
          type: "number",
          description: "Optional timeout in seconds (default 60, max 300).",
        },
        risk: RISK_PROP,
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "host_open",
    description: IS_WIN_HOST
      ? "Open a file, folder, URL, or application on the user's Windows PC ('你的电脑') via Explorer / default shell handler."
      : "Open a file, folder, URL, or macOS application on the user's Mac ('你的电脑') via /usr/bin/open.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "File path, directory path, or URL to open (optional if app is specified).",
        },
        app: {
          type: "string",
          description: IS_WIN_HOST
            ? "Optional Windows executable or app name to launch."
            : "Optional macOS application name or bundle path (e.g. 'Finder', 'Safari', 'Preview').",
        },
        reveal_in_finder: {
          type: "boolean",
          description: IS_WIN_HOST
            ? "If true, highlights/selects the target file in Windows Explorer (/select,)."
            : "If true, reveals the target file/folder in Finder (-R).",
        },
      },
    },
  },
  {
    type: "function",
    name: "host_read_file",
    description: `Read a UTF-8 text file directly from the user's ${HOST_OS_LABEL} ('你的电脑'). Supports optional 1-based \`start_line\` / \`end_line\` slice reading with line numbers.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `File path on the user's ${HOST_OS_LABEL} (supports ~ expansion).`,
        },
        start_line: {
          type: "integer",
          description: "Optional 1-based start line number (inclusive).",
        },
        end_line: {
          type: "integer",
          description: "Optional 1-based end line number (inclusive).",
        },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "host_write_file",
    description:
      `Write UTF-8 text content to a file on the user's ${HOST_OS_LABEL} ('你的电脑'), creating parent directories if needed.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `Destination file path on the user's ${HOST_OS_LABEL} (supports ~ expansion).`,
        },
        content: {
          type: "string",
          description: "Full UTF-8 text content to write.",
        },
        risk: RISK_PROP,
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
    name: "host_edit_file",
    description:
      `Edit an existing UTF-8 file on the user's ${HOST_OS_LABEL} ('你的电脑') via exact \`target\` -> \`replacement\` substitution or \`append: true\`. Strongly preferred over overwriting large files with \`host_write_file\` or PowerShell/shell piping.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `File path on the user's ${HOST_OS_LABEL} (supports ~ expansion).`,
        },
        target: {
          type: "string",
          description: "Exact existing substring to replace (required unless `append: true`).",
        },
        replacement: {
          type: "string",
          description: "Replacement text (or text to append when `append: true`).",
        },
        append: {
          type: "boolean",
          description: "If true, append `replacement` to the end of the file (creates file if missing).",
        },
        replace_all: {
          type: "boolean",
          description: "If true, replace all occurrences of `target` instead of requiring a unique match.",
        },
        risk: RISK_PROP,
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "host_record_screen",
    description:
      "Record a short screen video (1-60 seconds) of the user's local physical computer ('客户端主机') and save it as a deliverable MP4/MOV file.",
    parameters: {
      type: "object",
      properties: {
        duration_sec: {
          type: "number",
          description: "Recording duration in seconds (1-60, default 8).",
        },
        display_index: {
          type: "number",
          description: "Optional display index (0-based, default 0).",
        },
        risk: RISK_PROP,
      },
    },
  },
];

const HOST_TOOL_NAMES = new Set(HOST_TOOL_DECLARATIONS.map((t) => t.name));

const hostFileEditLocks = new Map<string, Promise<unknown>>();

async function withHostFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostFileEditLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  hostFileEditLocks.set(filePath, tail);
  try {
    return await next;
  } finally {
    if (hostFileEditLocks.get(filePath) === tail) {
      hostFileEditLocks.delete(filePath);
    }
  }
}

function parsePositiveLineNumber(val: unknown, field: string): number | undefined {
  if (val === undefined || val === null || val === "") return undefined;
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${field} must be a positive 1-based integer`);
  }
  return n;
}

export function isHostTool(name: string): boolean {
  return HOST_TOOL_NAMES.has(name);
}

export function expandHostPath(rawPath: unknown): string {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

interface HostShellResult {
  ok: boolean;
  exitCode: number;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
}

function killHostChildTree(child: ReturnType<typeof spawn>, isWin: boolean) {
  if (isWin && child.pid) {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.unref?.();
    } catch {}
  }
  try {
    child.kill("SIGTERM");
  } catch {}
}

export function cleanPowerShellClixmlStderr(rawStderr: string): string {
  const s = String(rawStderr || "");
  if (!s.includes("#< CLIXML") && !s.includes("<Objs ")) return s;
  const errorMsgs: string[] = [];
  const errRe = /<S\s+S="Error">([\s\S]*?)<\/S>/gi;
  let m: RegExpExecArray | null;
  while ((m = errRe.exec(s)) !== null) {
    const decoded = m[1]
      .replace(/_x000D__x000A_/gi, "\n")
      .replace(/_x000A_/gi, "\n")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
    if (decoded) errorMsgs.push(decoded);
  }
  const stripped = s
    .replace(/#< CLIXML\r?\n?/g, "")
    .replace(/<Objs\b[\s\S]*?<\/Objs>/gi, "")
    .trim();
  return [stripped, ...errorMsgs].filter(Boolean).join("\n").trim();
}

export function buildWindowsPowerShellEncodedCommand(command: string): string {
  const normalized = /^\s*"[^"]+"\s+\S/.test(command) ? `& ${command}` : command;
  const prelude =
    "$ProgressPreference = 'SilentlyContinue'; " +
    "$ErrorActionPreference = 'Continue'; " +
    "$PSNativeCommandUseErrorActionPreference = $false; " +
    "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n";
  return Buffer.from(`${prelude}${normalized}`, "utf16le").toString("base64");
}

export function buildHostShellSpawnSpec(
  command: string,
  {
    platform = process.platform,
    shell = "auto",
    wslDistro = "",
  }: { platform?: string; shell?: string; wslDistro?: string } = {}
): { cmd: string; args: string[]; isPowerShell: boolean } {
  const normShell = String(shell || "auto").trim().toLowerCase();
  if (platform === "win32") {
    if (normShell === "wsl") {
      const args: string[] = [];
      const distro = String(wslDistro || "").trim();
      if (distro) args.push("-d", distro);
      args.push("--", "bash", "-lc", command);
      return { cmd: "wsl.exe", args, isPowerShell: false };
    }
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        buildWindowsPowerShellEncodedCommand(command),
      ],
      isPowerShell: true,
    };
  }
  return {
    cmd: platform === "darwin" ? "/bin/zsh" : "/bin/sh",
    args: platform === "darwin" ? ["-o", "nonomatch", "-lc", command] : ["-c", command],
    isPowerShell: false,
  };
}

function runHostShellCommand(
  command: string,
  {
    cwd,
    timeoutSec = 60,
    signal,
    shell,
    wslDistro,
  }: {
    cwd?: string;
    timeoutSec?: number;
    signal?: AbortSignal;
    shell?: string;
    wslDistro?: string;
  } = {}
): Promise<HostShellResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Aborted"));
      return;
    }

    const resolvedCwd = cwd ? expandHostPath(cwd) : os.homedir();
    const clampedSec = Math.min(Math.max(Number(timeoutSec) || 60, 1), 300);
    const isWin = process.platform === "win32";
    const childEnv = {
      ...buildScrubbedEnv(),
      ...(isWin ? { WSL_UTF8: "1", PYTHONIOENCODING: "utf-8" } : {}),
    } as NodeJS.ProcessEnv;
    const spec = buildHostShellSpawnSpec(command, {
      platform: process.platform,
      shell,
      wslDistro,
    });
    const child = spawn(spec.cmd, spec.args, {
      cwd: resolvedCwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const MAX_CAPTURE = 64 * 1024;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) {
        stderr += chunk.toString("utf8");
      }
    });

    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killHostChildTree(child, isWin);
    }, clampedSec * 1000);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        killHostChildTree(child, isWin);
        reject(signal.reason || new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: err.message || String(err),
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (signal?.aborted) return;
      const cleanedStderr = spec.isPowerShell ? cleanPowerShellClixmlStderr(stderr) : stderr;
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        timedOut,
        stdout,
        stderr: timedOut
          ? `${cleanedStderr}${cleanedStderr ? "\n" : ""}[Command timed out after ${clampedSec}s]`
          : cleanedStderr,
      });
    });
  });
}

async function defaultExecRecordScreen({
  outputPath,
  durationSec,
  displayIndex = 0,
  signal,
}: {
  outputPath: string;
  durationSec: number;
  displayIndex?: number;
  signal?: AbortSignal;
}): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const env = buildScrubbedEnv() as NodeJS.ProcessEnv;
  if (process.platform === "darwin") {
    const args = ["-v", "-x", "-T", String(durationSec)];
    if (Number.isInteger(displayIndex) && displayIndex >= 0) {
      args.push("-D", String(displayIndex + 1));
    }
    args.push(outputPath);
    await execFileAsync("/usr/sbin/screencapture", args, {
      env,
      timeout: (durationSec + 15) * 1000,
      signal,
    });
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "gdigrab",
        "-framerate",
        "15",
        "-t",
        String(durationSec),
        "-i",
        "desktop",
        "-pix_fmt",
        "yuv420p",
        outputPath,
      ],
      { env, timeout: (durationSec + 15) * 1000, signal }
    );
    return;
  }
  throw new Error(`host_record_screen is not supported on platform ${process.platform}`);
}

export interface RunHostToolOptions {
  shellTimeoutSec?: number;
  workspaceRoot?: string;
  signal?: AbortSignal;
  execOpenFn?: (cmd: string, openArgs: string[]) => Promise<unknown>;
  execRecordFn?: (opts: {
    outputPath: string;
    durationSec: number;
    displayIndex: number;
    signal?: AbortSignal;
  }) => Promise<void>;
}

export async function runHostTool(
  name: string,
  args: Record<string, any> = {},
  {
    shellTimeoutSec = 60,
    workspaceRoot = path.join(os.homedir(), "TwinkleBot", "workspace"),
    signal,
    execOpenFn = (cmd, openArgs) =>
      execFileAsync(cmd, openArgs, { env: buildScrubbedEnv() as NodeJS.ProcessEnv, timeout: 15_000 }),
    execRecordFn = defaultExecRecordScreen,
  }: RunHostToolOptions = {}
): Promise<{ result: Record<string, any>; screenshot: null }> {
  const safeArgs = args && typeof args === "object" ? args : {};

  if (name === "host_run_shell") {
    const command = String(safeArgs.command || "").trim();
    if (!command) {
      return { result: { ok: false, error: "command is required" }, screenshot: null };
    }
    const res = await runHostShellCommand(command, {
      cwd: safeArgs.cwd,
      timeoutSec: safeArgs.timeout ?? shellTimeoutSec,
      signal,
      shell: safeArgs.shell,
      wslDistro: safeArgs.wsl_distro,
    });
    return { result: res, screenshot: null };
  }

  if (name === "host_open") {
    const openArgs: string[] = [];
    if (safeArgs.reveal_in_finder) {
      openArgs.push("-R");
    }
    if (typeof safeArgs.app === "string" && safeArgs.app.trim()) {
      openArgs.push("-a", safeArgs.app.trim());
    }
    if (typeof safeArgs.target === "string" && safeArgs.target.trim()) {
      const rawTarget = safeArgs.target.trim();
      const isUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawTarget);
      openArgs.push(isUrl ? rawTarget : expandHostPath(rawTarget));
    }
    if (openArgs.length === 0) {
      return {
        result: { ok: false, error: "target or app is required for host_open" },
        screenshot: null,
      };
    }
    try {
      if (process.platform === "win32") {
        const target =
          typeof safeArgs.target === "string" && safeArgs.target.trim()
            ? expandHostPath(safeArgs.target.trim())
            : safeArgs.app || "";
        const winArgs = safeArgs.reveal_in_finder
          ? ["/select,", target]
          : ["/c", "start", "", target];
        const winCmd = safeArgs.reveal_in_finder ? "explorer.exe" : "cmd.exe";
        await execOpenFn(winCmd, winArgs);
      } else if (process.platform === "linux") {
        const target =
          typeof safeArgs.target === "string" && safeArgs.target.trim()
            ? expandHostPath(safeArgs.target.trim())
            : safeArgs.app || "";
        await execOpenFn("xdg-open", [target]);
      } else {
        await execOpenFn("/usr/bin/open", openArgs);
      }
      return {
        result: { ok: true, opened: openArgs },
        screenshot: null,
      };
    } catch (err: any) {
      return {
        result: { ok: false, error: err?.message || String(err) },
        screenshot: null,
      };
    }
  }

  if (name === "host_read_file") {
    const filePath = expandHostPath(safeArgs.path);
    if (!filePath) {
      return { result: { ok: false, error: "path is required" }, screenshot: null };
    }
    try {
      const startLine = parsePositiveLineNumber(safeArgs.start_line, "start_line");
      const endLine = parsePositiveLineNumber(safeArgs.end_line, "end_line");
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        return {
          result: { ok: false, path: filePath, error: "end_line must be >= start_line" },
          screenshot: null,
        };
      }
      const raw = await fs.readFile(filePath, "utf8");
      const maxLen = 100_000;
      if (startLine !== undefined || endLine !== undefined) {
        const lines = raw.split(/\r?\n/);
        const totalLines = lines.length;
        const effectiveStart = Math.min(startLine ?? 1, Math.max(totalLines, 1));
        const effectiveEnd = Math.min(endLine ?? Math.min(effectiveStart + 399, totalLines), totalLines);
        const sliced = totalLines === 0 ? [] : lines.slice(effectiveStart - 1, effectiveEnd);
        const numbered = sliced.map((line, i) => `${effectiveStart + i}: ${line}`).join("\n");
        const truncated = numbered.length > maxLen;
        return {
          result: {
            ok: true,
            path: filePath,
            startLine: effectiveStart,
            endLine: totalLines === 0 ? 0 : effectiveEnd,
            totalLines,
            hasMore: effectiveEnd < totalLines,
            content: truncated
              ? `${numbered.slice(0, maxLen)}\n...[truncated ${numbered.length - maxLen} chars]...`
              : numbered,
            truncated,
          },
          screenshot: null,
        };
      }
      const truncated = raw.length > maxLen;
      const totalLines = raw.length === 0 ? 0 : raw.split(/\r?\n/).length;
      return {
        result: {
          ok: true,
          path: filePath,
          totalLines,
          hasMore: truncated,
          content: truncated
            ? `${raw.slice(0, maxLen)}\n...[truncated ${raw.length - maxLen} chars]...`
            : raw,
          truncated,
        },
        screenshot: null,
      };
    } catch (err: any) {
      return {
        result: { ok: false, path: filePath, error: err?.message || String(err) },
        screenshot: null,
      };
    }
  }

  if (name === "host_write_file") {
    const filePath = expandHostPath(safeArgs.path);
    if (!filePath) {
      return { result: { ok: false, error: "path is required" }, screenshot: null };
    }
    const content = typeof safeArgs.content === "string" ? safeArgs.content : String(safeArgs.content ?? "");
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      return {
        result: {
          ok: true,
          path: filePath,
          bytesWritten: Buffer.byteLength(content, "utf8"),
        },
        screenshot: null,
      };
    } catch (err: any) {
      return {
        result: { ok: false, path: filePath, error: err?.message || String(err) },
        screenshot: null,
      };
    }
  }

  if (name === "host_edit_file") {
    const filePath = expandHostPath(safeArgs.path);
    if (!filePath) {
      return { result: { ok: false, error: "path is required" }, screenshot: null };
    }
    const appendMode = Boolean(safeArgs.append);
    const replaceAll = Boolean(safeArgs.replace_all);
    const replacement =
      typeof safeArgs.replacement === "string"
        ? safeArgs.replacement
        : String(safeArgs.replacement ?? "");
    try {
      const res = await withHostFileLock(filePath, async () => {
        if (appendMode) {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.appendFile(filePath, replacement, "utf8");
          return {
            ok: true,
            path: filePath,
            mode: "append",
            bytesAppended: Buffer.byteLength(replacement, "utf8"),
          };
        }
        const target = typeof safeArgs.target === "string" ? safeArgs.target : "";
        if (!target) {
          return { ok: false, path: filePath, error: "target is required unless append=true" };
        }
        const existing = await fs.readFile(filePath, "utf8");
        const occurrences = existing.split(target).length - 1;
        if (occurrences === 0) {
          return { ok: false, path: filePath, error: "target not found in file" };
        }
        if (occurrences > 1 && !replaceAll) {
          return {
            ok: false,
            path: filePath,
            error: `target matched ${occurrences} times; provide more context or set replace_all=true`,
          };
        }
        const updated = replaceAll
          ? existing.split(target).join(replacement)
          : existing.replace(target, replacement);
        await fs.writeFile(filePath, updated, "utf8");
        return {
          ok: true,
          path: filePath,
          mode: "replace",
          replacements: replaceAll ? occurrences : 1,
          bytesWritten: Buffer.byteLength(updated, "utf8"),
        };
      });
      return { result: res, screenshot: null };
    } catch (err: any) {
      return {
        result: { ok: false, path: filePath, error: err?.message || String(err) },
        screenshot: null,
      };
    }
  }

  if (name === "host_record_screen") {
    const rawDur = Number(safeArgs.duration_sec);
    const durationSec = Number.isFinite(rawDur)
      ? Math.min(Math.max(Math.round(rawDur), 1), 60)
      : 8;
    const displayIndex = Number.isFinite(Number(safeArgs.display_index))
      ? Math.max(0, Math.round(Number(safeArgs.display_index)))
      : 0;
    const deliverablesDir = path.join(workspaceRoot, "deliverables");
    const fileName = `screen_${Date.now()}.mp4`;
    const outputPath = path.join(deliverablesDir, fileName);
    try {
      await fs.mkdir(deliverablesDir, { recursive: true });
      await execRecordFn({ outputPath, durationSec, displayIndex, signal });
      const stat = await fs.stat(outputPath);
      const url = `/api/workspace/file?path=${encodeURIComponent(outputPath)}`;
      const downloadUrl = `/api/workspace/file?path=${encodeURIComponent(outputPath)}&download=1&name=${encodeURIComponent(fileName)}`;
      return {
        result: {
          ok: true,
          path: outputPath,
          name: fileName,
          durationSec,
          size: stat.size,
          mimeType: "video/mp4",
          url,
          downloadUrl,
        },
        screenshot: null,
      };
    } catch (err: any) {
      return {
        result: {
          ok: false,
          path: outputPath,
          error: err?.message || String(err),
        },
        screenshot: null,
      };
    }
  }

  throw new Error(`Unknown host tool: ${name}`);
}
