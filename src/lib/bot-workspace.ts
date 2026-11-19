import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MEDIA_EXTS,
  expandUserPath,
  isSensitiveFilePath,
} from "./file-attachments.js";

const SAFE_WORKSPACE_ID_RE = /^[A-Za-z0-9._-]+$/;
export const BOTS_WORKSPACE_SUBDIR = "bots";

/**
 * Validates and returns a single-segment Bot/session workspace directory name,
 * rejecting path traversal and empty or unexpected values.
 */
export function sanitizeBotWorkspaceId(rawId: unknown): string {
  if (typeof rawId !== "string") return "";
  const trimmed = rawId.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "";
  if (!SAFE_WORKSPACE_ID_RE.test(trimmed)) return "";
  return trimmed;
}

/**
 * Extracts raw `writeRoots` array from a config object or array.
 */
function extractRawWriteRoots(configOrRoots: unknown): string[] {
  const raw = Array.isArray(configOrRoots)
    ? configOrRoots
    : configOrRoots && typeof configOrRoots === "object"
      ? (configOrRoots as Record<string, any>).writeRoots
      : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? expandUserPath(entry) : ""))
    .filter(Boolean);
}

/**
 * Resolves the base global workspace directory (typically `writeRoots[0]`).
 */
export function resolveBaseWorkspaceRoot({
  config,
  writeRoots,
  fallbackDir,
}: {
  config?: Record<string, any> | null;
  writeRoots?: string[] | null;
  fallbackDir?: string;
} = {}): string {
  const explicitBase =
    config && typeof config === "object" && typeof config.baseWorkspaceRoot === "string"
      ? expandUserPath(config.baseWorkspaceRoot)
      : "";
  if (explicitBase) return explicitBase;

  const roots = extractRawWriteRoots(writeRoots ?? config);
  if (roots.length > 0) return roots[0];

  if (fallbackDir && typeof fallbackDir === "string") {
    return expandUserPath(fallbackDir) || path.resolve(fallbackDir);
  }
  return path.join(os.tmpdir(), "twinklebot-workspace");
}

function isAlreadyBotWorkspaceRoot(resolvedBase: string, safeSessionId: string): boolean {
  if (!safeSessionId) return false;
  return (
    path.basename(resolvedBase) === safeSessionId &&
    path.basename(path.dirname(resolvedBase)) === BOTS_WORKSPACE_SUBDIR
  );
}

/**
 * Resolves the dedicated exclusive workspace root (`<baseRoot>/bots/<sessionId>`)
 * for a Bot or Group session, avoiding double-nesting when `writeRoots[0]` is
 * already scoped to that session.
 */
export function resolveBotWorkspaceRoot({
  config,
  writeRoots,
  sessionId,
  fallbackDir,
}: {
  config?: Record<string, any> | null;
  writeRoots?: string[] | null;
  sessionId?: unknown;
  fallbackDir?: string;
} = {}): string {
  const baseRoot = resolveBaseWorkspaceRoot({ config, writeRoots, fallbackDir });
  const safeId = sanitizeBotWorkspaceId(sessionId);
  if (!safeId || isAlreadyBotWorkspaceRoot(baseRoot, safeId)) {
    return baseRoot;
  }
  return path.join(baseRoot, BOTS_WORKSPACE_SUBDIR, safeId);
}

/**
 * Creates the Bot's exclusive workspace directory if needed and returns its path.
 */
export function ensureBotWorkspaceDir(opts: {
  config?: Record<string, any> | null;
  writeRoots?: string[] | null;
  sessionId?: unknown;
  fallbackDir?: string;
} = {}): string {
  const dir = resolveBotWorkspaceRoot(opts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Safely deletes a deleted Bot's dedicated workspace directory (`<baseRoot>/bots/<id>`).
 */
export function removeBotWorkspaceDir({
  config,
  writeRoots,
  sessionId,
  fallbackDir,
}: {
  config?: Record<string, any> | null;
  writeRoots?: string[] | null;
  sessionId?: unknown;
  fallbackDir?: string;
} = {}): boolean {
  const safeId = sanitizeBotWorkspaceId(sessionId);
  if (!safeId) return false;
  const baseRoot = resolveBaseWorkspaceRoot({ config, writeRoots, fallbackDir });
  if (!baseRoot) return false;
  const botsParent = isAlreadyBotWorkspaceRoot(baseRoot, safeId)
    ? path.dirname(baseRoot)
    : path.join(baseRoot, BOTS_WORKSPACE_SUBDIR);
  const targetDir = path.join(botsParent, safeId);
  if (
    !targetDir.startsWith(botsParent + path.sep) ||
    !fs.existsSync(targetDir)
  ) {
    return false;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  return true;
}

/**
 * Computes the effective `writeRoots` list scoped to a specific Bot/session:
 * replaces the primary shared workspace root with `<baseRoot>/bots/<sessionId>`
 * while retaining additional permitted host directories (such as `~/Downloads`).
 */
export function resolveBotWriteRoots({
  config,
  writeRoots,
  sessionId,
  fallbackDir,
}: {
  config?: Record<string, any> | null;
  writeRoots?: string[] | null;
  sessionId?: unknown;
  fallbackDir?: string;
} = {}): string[] {
  const rawRoots = extractRawWriteRoots(writeRoots ?? config);
  const safeId = sanitizeBotWorkspaceId(sessionId);
  if (rawRoots.length === 0) {
    return fallbackDir
      ? [resolveBotWorkspaceRoot({ fallbackDir, sessionId: safeId })]
      : [];
  }
  const botRoot = resolveBotWorkspaceRoot({
    config,
    writeRoots: rawRoots,
    sessionId: safeId,
    fallbackDir,
  });
  const rest = rawRoots.slice(1).filter((r) => path.resolve(r) !== path.resolve(botRoot));
  return [botRoot, ...rest];
}

/**
 * Checks whether `filePath` resides inside `<baseRoot>/bots/<someId>` and returns `<someId>`.
 */
export function inferSessionIdFromWorkspacePath(
  filePath: unknown,
  configOrRoots?: Record<string, any> | string[] | null
): string {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  const resolved = expandUserPath(filePath);
  if (!resolved) return "";
  const baseRoot = resolveBaseWorkspaceRoot(
    Array.isArray(configOrRoots)
      ? { writeRoots: configOrRoots }
      : { config: configOrRoots ?? undefined }
  );
  const rootsToCheck = [baseRoot];
  if (path.basename(path.dirname(baseRoot)) === BOTS_WORKSPACE_SUBDIR) {
    rootsToCheck.push(path.dirname(path.dirname(baseRoot)));
  }
  for (const candidateBase of rootsToCheck) {
    const botsDir = path.join(candidateBase, BOTS_WORKSPACE_SUBDIR);
    if (resolved.startsWith(botsDir + path.sep)) {
      const rel = resolved.slice(botsDir.length + 1);
      const firstSeg = rel.split(path.sep)[0] || "";
      const safe = sanitizeBotWorkspaceId(firstSeg);
      if (safe) return safe;
    }
  }
  return "";
}

/**
 * Returns true if `targetPath` resolves inside `<baseRoot>/bots/<otherId>`
 * belonging to a different Bot/session than `currentSessionId`.
 */
export function isOtherBotPrivateWorkspacePath(
  targetPath: unknown,
  configOrRoots?: Record<string, any> | string[] | null,
  currentSessionId?: unknown
): boolean {
  const ownerId = inferSessionIdFromWorkspacePath(targetPath, configOrRoots);
  if (!ownerId) return false;
  const currentSafeId = sanitizeBotWorkspaceId(currentSessionId);
  return ownerId !== currentSafeId;
}

/**
 * Validates that a read/reference/send path is non-sensitive, resides inside allowed
 * workspace or host roots, and does NOT cross into another Bot's private workspace.
 */
export function isPathInsideBotAccessibleRoots(
  targetPath: unknown,
  {
    config,
    writeRoots,
    sessionId,
    extraRoots = [],
  }: {
    config?: Record<string, any> | null;
    writeRoots?: string[] | null;
    sessionId?: unknown;
    extraRoots?: string[];
  } = {}
): boolean {
  if (typeof targetPath !== "string" || !targetPath.trim()) return false;
  const resolved = expandUserPath(targetPath);
  if (!resolved || isSensitiveFilePath(resolved)) return false;

  const baseSource =
    config && typeof config === "object"
      ? {
          writeRoots:
            config.baseWorkspaceRoot && Array.isArray(config.writeRoots)
              ? [config.baseWorkspaceRoot, ...config.writeRoots]
              : config.baseWorkspaceRoot
                ? [config.baseWorkspaceRoot]
                : config.writeRoots,
        }
      : writeRoots;
  const checkRoots = writeRoots ?? (baseSource as any)?.writeRoots ?? [];

  if (
    sanitizeBotWorkspaceId(sessionId) &&
    isOtherBotPrivateWorkspacePath(resolved, checkRoots, sessionId)
  ) {
    return false;
  }

  const allowed = [
    ...resolveBotWriteRoots({ config, writeRoots, sessionId }),
    ...extractRawWriteRoots(checkRoots),
    ...extraRoots.map((r) => expandUserPath(r)).filter(Boolean),
  ];

  return allowed.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

/**
 * Scans a Bot workspace directory for recent user/Bot artifacts (uploads, generated images,
 * deliverables, saved notes, and workspace files), sorted newest-first.
 */
export function scanWorkspaceFiles(rootDir: string, maxItems = 40) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results: any[] = [];
  const maxCandidates = Math.max(maxItems * 5, 200);

  function walk(dir: string, depth = 0) {
    if (depth > 2 || results.length >= maxCandidates) return;
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
        // Never leak `bots/<other>` into the parent directory scan if rootDir happens to be a base root
        if (depth === 0 && ent.name === BOTS_WORKSPACE_SUBDIR) continue;
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
          // ignore unreadable entries
        }
      }
      if (results.length >= maxCandidates) break;
    }
  }

  walk(rootDir, 0);
  results.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return results.slice(0, maxItems);
}
