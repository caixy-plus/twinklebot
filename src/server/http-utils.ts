import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  FILE_MIME_TYPES as MIME_TYPES,
  MEDIA_EXTS,
  isSensitiveFilePath,
} from "../lib/file-attachments.js";
import { scanWorkspaceFiles } from "../lib/bot-workspace.js";

export { MIME_TYPES, scanWorkspaceFiles };

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

export const DEFAULT_PRIVATE_SKILLS = [
  {
    id: "skill-1",
    name: "工作区整洁约定",
    desc: "生成的报告、脚本或下载产物统一存放在当前 Bot 专属工作区目录下并告知绝对路径",
    instruction:
      "Save generated files inside your dedicated Bot workspace root (your primary writeRoots directory) and report the exact file path when done.",
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
