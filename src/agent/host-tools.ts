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
    `Estimated risk level on the user's ${HOST_OS_LABEL} ('high' for destructive edits, deletions, payments, or external sends).`,
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
            ? "Windows PowerShell command/script to execute on the user's Windows PC (UTF-8 & WSL_UTF8=1 already enabled)."
            : "zsh command line to execute on the user's Mac.",
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
        risk: RISK_PROP,
      },
    },
  },
  {
    type: "function",
    name: "host_read_file",
    description: `Read a UTF-8 text file directly from the user's ${HOST_OS_LABEL} ('你的电脑').`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `File path on the user's ${HOST_OS_LABEL} (supports ~ expansion).`,
        },
        risk: RISK_PROP,
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

function buildWindowsPowerShellEncodedCommand(command: string): string {
  const normalized = /^\s*"[^"]+"\s+\S/.test(command) ? `& ${command}` : command;
  const prelude =
    "$ProgressPreference = 'SilentlyContinue'; " +
    "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n";
  return Buffer.from(`${prelude}${normalized}`, "utf16le").toString("base64");
}

function runHostShellCommand(
  command: string,
  { cwd, timeoutSec = 60, signal }: { cwd?: string; timeoutSec?: number; signal?: AbortSignal } = {}
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
    const child = isWin
      ? spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            buildWindowsPowerShellEncodedCommand(command),
          ],
          {
            cwd: resolvedCwd,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          }
        )
      : spawn(
          process.platform === "darwin" ? "/bin/zsh" : "/bin/sh",
          [process.platform === "darwin" ? "-lc" : "-c", command],
          {
            cwd: resolvedCwd,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

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
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        timedOut,
        stdout,
        stderr: timedOut
          ? `${stderr}${stderr ? "\n" : ""}[Command timed out after ${clampedSec}s]`
          : stderr,
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
      const raw = await fs.readFile(filePath, "utf8");
      const maxLen = 100_000;
      const truncated = raw.length > maxLen;
      return {
        result: {
          ok: true,
          path: filePath,
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
