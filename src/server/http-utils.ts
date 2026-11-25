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

export const DEFAULT_PRIVATE_SKILLS: Array<Record<string, any>> = [];

export async function parseJsonBody(
  req: http.IncomingMessage,
  maxBytes = 12 * 1024 * 1024
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let totalBytes = 0;
    let tooLarge = false;
    let settled = false;
    const hardAbortBytes = maxBytes + 32 * 1024 * 1024;
    const fail = (err: Error & { statusCode?: number; code?: string }) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const makeTooLargeError = () => {
      const err: Error & { statusCode?: number; code?: string } = new Error("payload too large");
      err.statusCode = 413;
      err.code = "PAYLOAD_TOO_LARGE";
      return err;
    };

    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      tooLarge = true;
    }

    req.setEncoding("utf-8");
    req.on("data", (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk, "utf-8");
      if (tooLarge || totalBytes > maxBytes) {
        tooLarge = true;
        raw = "";
        if (totalBytes > hardAbortBytes) {
          req.destroy();
          fail(makeTooLargeError());
        }
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (tooLarge) {
        fail(makeTooLargeError());
        return;
      }
      if (!raw.trim()) {
        if (!settled) {
          settled = true;
          resolve({});
        }
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!settled) {
          settled = true;
          resolve(parsed);
        }
      } catch {
        fail(new Error("invalid json"));
      }
    });
    req.on("error", (err) => fail(err));
  });
}

export function sendParseBodyError(
  res: http.ServerResponse,
  err: unknown,
  fallbackMessage = "invalid json"
): true {
  const e = err as any;
  if (
    e?.statusCode === 413 ||
    e?.code === "PAYLOAD_TOO_LARGE" ||
    e?.message === "payload too large"
  ) {
    return sendJson(res, 413, { error: "payload too large" }, { Connection: "close" });
  }
  return sendJson(res, 400, { error: fallbackMessage });
}

export function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
  extraHeaders?: Record<string, string | number>
): true {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    ...(extraHeaders || {}),
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
