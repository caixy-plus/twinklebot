import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  FILE_MIME_TYPES as MIME_TYPES,
  MEDIA_EXTS,
  isSensitiveFilePath,
} from "../lib/file-attachments.js";

export { MIME_TYPES };

export const VALID_PROFILE_COLORS = new Set([
  "slate",
  "blue",
  "violet",
  "emerald",
  "amber",
  "rose",
]);
export const VALID_HOST_EXEC_MODES = new Set(["always", "ask", "off"]);

export const FALLBACK_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>TwinkleBot</title></head><body><h1>TwinkleBot</h1></body></html>';

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SCREENSHOT_FILE_REGEX = /^\d{4}\.png$/;

export const DEFAULT_POLICY = {
  autoAudit: true,
  askRules: [
    {
      id: "ask-shell-danger",
      tool: "run_shell",
      pattern: "sudo",
      label: "run_shell · 包含 sudo 的命令前必须批准",
    },
  ],
  allowRules: [],
};

const DEFAULT_WORKSPACE_DIR = path.join(os.homedir(), "TwinkleBot", "workspace");

export const DEFAULT_PRIVATE_SKILLS = [
  {
    id: "skill-1",
    name: "工作区整洁约定",
    desc: `生成的报告、脚本或下载产物统一存放在 ${DEFAULT_WORKSPACE_DIR} 下并告知绝对路径`,
    instruction:
      `Save generated files under ${DEFAULT_WORKSPACE_DIR} and report the exact file path when done.`,
    enabled: true,
  },
  {
    id: "skill-2",
    name: "OrbStack 桌面巡检",
    desc: "检查 :1 桌面窗口与网络连通状态时优先用 run_shell 与 list_windows 配合",
    instruction:
      "When diagnosing desktop or network state, combine list_windows and run_shell before clicking blindly.",
    enabled: true,
  },
];

export async function parseJsonBody(
  req: http.IncomingMessage,
  maxBytes = 12 * 1024 * 1024
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): true {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
  return true;
}

export function isInsideAllowedRoots(targetPath: string, roots: string[] = []) {
  const resolved = path.resolve(targetPath);
  if (isSensitiveFilePath(resolved)) return false;
  return roots.some((root) => {
    if (!root || typeof root !== "string") return false;
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export function scanWorkspaceFiles(rootDir: string, maxItems = 40) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results: any[] = [];

  function walk(dir: string, depth = 0) {
    if (depth > 2 || results.length >= maxItems) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        try {
          const stat = fs.statSync(full);
          const ext = path.extname(ent.name).toLowerCase();
          results.push({
            name: ent.name,
            path: full,
            type: MEDIA_EXTS.has(ext) ? "media" : "file",
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            url: `/api/workspace/file?path=${encodeURIComponent(full)}`,
          });
        } catch {
          // ignore
        }
      }
      if (results.length >= maxItems) break;
    }
  }

  walk(rootDir, 0);
  results.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return results;
}
