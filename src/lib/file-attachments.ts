import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FILE_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".rtf": "application/rtf",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const MEDIA_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".mp4",
  ".webm",
]);

export const CHAT_INLINE_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

export function expandUserPath(rawPath: unknown): string {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function isSensitiveFilePath(targetPath: unknown): boolean {
  if (!targetPath || typeof targetPath !== "string") return true;
  const resolved = path.resolve(targetPath);
  const base = path.basename(resolved).toLowerCase();
  if (
    base === ".env" ||
    base.startsWith(".env.") ||
    /.*auth.*\.json$/i.test(base) ||
    base === "credentials.json" ||
    base === "vault.json" ||
    base === "frpc.toml" ||
    base === "frps.toml" ||
    base === "relay-token" ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    base === "shadow" ||
    base === "sudoers" ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".p12")
  ) {
    return true;
  }
  if (resolved.split(path.sep).some((seg) => seg.toLowerCase() === ".ssh")) {
    return true;
  }
  return false;
}

export function inferFileMimeType(filePathOrExt = ""): string {
  const s = String(filePathOrExt || "").trim().toLowerCase();
  const ext = s.startsWith(".") ? s : path.extname(s);
  return FILE_MIME_TYPES[ext] || "application/octet-stream";
}

function isInsideSubdir(targetPath: string, rootDir: string, subdirNames: string[] = []): boolean {
  if (!rootDir) return false;
  const resolved = path.resolve(targetPath);
  return subdirNames.some((sub) => {
    const dir = path.resolve(rootDir, sub);
    return resolved.startsWith(dir + path.sep);
  });
}

function sanitizeSafeSlug(rawName: unknown): string {
  const clean = String(rawName || "file")
    .trim()
    .slice(0, 64)
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean || "file";
}

export interface StagedDeliveredFile {
  name: string;
  path: string;
  sourcePath: string;
  size: number;
  ext: string;
  mimeType: string;
  isMedia: boolean;
  url: string;
  downloadUrl: string;
  markdown: string;
}

/**
 * Stages a deliverable file (from a local path or in-memory Buffer) inside
 * `<workspaceRoot>/deliverables/` so the web/desktop UI can preview, open,
 * reveal in Finder, download, and surface it inside the Bot's Library.
 */
export function stageDeliveredFile({
  sourcePath = "",
  buffer = null,
  fileName = "",
  title = "",
  workspaceRoot = "",
  maxBytes = 100 * 1024 * 1024,
}: {
  sourcePath?: string;
  buffer?: Buffer | null;
  fileName?: string;
  title?: string;
  workspaceRoot?: string;
  maxBytes?: number;
} = {}): StagedDeliveredFile {
  const root = workspaceRoot || path.join(os.tmpdir(), "twinklebot-generated");
  let resolvedSource = "";
  let statSize = 0;

  if (!buffer) {
    resolvedSource = expandUserPath(sourcePath);
    if (!resolvedSource) {
      throw new Error("path is required");
    }
    if (isSensitiveFilePath(resolvedSource)) {
      throw new Error("access denied: sensitive file cannot be shared");
    }
    if (!fs.existsSync(resolvedSource)) {
      throw new Error(`file not found: ${resolvedSource}`);
    }
    const st = fs.statSync(resolvedSource);
    if (!st.isFile()) {
      throw new Error(`not a regular file: ${resolvedSource}`);
    }
    if (st.size > maxBytes) {
      throw new Error(`file exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    statSize = st.size;
  } else {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error("buffer must be a Node Buffer");
    }
    if (buffer.length > maxBytes) {
      throw new Error(`file exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    statSize = buffer.length;
  }

  const fallbackBase = path.basename(resolvedSource || fileName || "file");
  const ext =
    path.extname(fallbackBase).toLowerCase() ||
    path.extname(String(fileName || "")).toLowerCase();
  const rawTitle = String(title || "").trim();
  let displayName = rawTitle || fallbackBase;
  if (rawTitle && ext && !rawTitle.toLowerCase().endsWith(ext)) {
    displayName = `${rawTitle}${ext}`;
  }

  let destPath = resolvedSource;
  const alreadyStaged =
    Boolean(resolvedSource) &&
    isInsideSubdir(resolvedSource, root, ["deliverables", "generated", "uploads"]);

  if (!alreadyStaged) {
    const deliverablesDir = path.join(root, "deliverables");
    fs.mkdirSync(deliverablesDir, { recursive: true });
    const baseWithoutExt = path.basename(displayName, ext);
    const safeSlug = sanitizeSafeSlug(baseWithoutExt);
    const stampedName = `${Date.now()}_${safeSlug}${ext}`;
    destPath = path.join(deliverablesDir, stampedName);
    if (buffer) {
      fs.writeFileSync(destPath, buffer);
    } else {
      fs.copyFileSync(resolvedSource, destPath);
    }
  }

  const mimeType = inferFileMimeType(ext);
  const isMedia = CHAT_INLINE_IMAGE_EXTS.has(ext);
  const url = `/api/workspace/file?path=${encodeURIComponent(destPath)}`;
  const downloadUrl = `/api/workspace/file?path=${encodeURIComponent(destPath)}&download=1&name=${encodeURIComponent(displayName)}`;

  return {
    name: displayName,
    path: destPath,
    sourcePath: resolvedSource || destPath,
    size: statSize,
    ext,
    mimeType,
    isMedia,
    url,
    downloadUrl,
    markdown: isMedia
      ? `[图片附件: ${displayName}](${url})`
      : `[文件附件: ${displayName} · 路径: ${destPath}]`,
  };
}
