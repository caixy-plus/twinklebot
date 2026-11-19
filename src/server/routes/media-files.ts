import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import type { ServerContext } from "../context.js";
import {
  DEFAULT_POLICY,
  DEFAULT_PRIVATE_SKILLS,
  FALLBACK_HTML,
  MIME_TYPES,
  SCREENSHOT_FILE_REGEX,
  UUID_REGEX,
  VALID_HOST_EXEC_MODES,
  VALID_PROFILE_COLORS,
  isInsideAllowedRoots,
  parseJsonBody,
  scanWorkspaceFiles,
  sendJson,
  sendParseBodyError,
} from "../http-utils.js";
import {
  runBotCollabTool,
  saveGeneratedImageFile,
} from "../../agent/bot-tools.js";
import { inferImageMimeType } from "../../agent/model.js";
import { convertImageBuffer } from "../../lib/image-convert.js";
import { resolveProviderApiKey } from "../../agent/providers/registry.js";
import { expandUserPath, inferFileMimeType, isSensitiveFilePath, MEDIA_EXTS } from "../../lib/file-attachments.js";
import {
  inferSessionIdFromWorkspacePath,
  isOtherBotPrivateWorkspacePath,
  resolveBaseWorkspaceRoot,
  resolveBotWorkspaceRoot,
  resolveBotWriteRoots,
  sanitizeBotWorkspaceId,
} from "../../lib/bot-workspace.js";
import { normalizeRoutingSettings } from "../../agent/route-stats.js";
import { accumulateSessionUsagePatch } from "../../agent/pricing.js";

function recordSessionModelUsage(
  ctx: ServerContext,
  sessionId: string,
  usedModel: string,
  usage: { input?: number; output?: number; cached?: number; thoughts?: number } | null | undefined,
  usedProviderId = ""
) {
  if (
    !sessionId ||
    !usage ||
    !ctx.store?.getSession ||
    !ctx.store?.updateSession
  ) {
    return;
  }
  const s = ctx.store.getSession(sessionId);
  if (!s) return;
  const providers = ctx.store?.readSettings?.()?.providers || [];
  const patch = accumulateSessionUsagePatch(
    s,
    {
      model: usedModel,
      providerId: usedProviderId,
      input: usage.input,
      output: usage.output,
      cached: usage.cached,
      thoughts: usage.thoughts,
      at: new Date().toISOString(),
    },
    { providers }
  );
  ctx.store.updateSession(sessionId, patch);
}

export async function handleMediaFilesRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        if (method === "POST" && pathname === "/api/images/generate") {
          let body;
          try {
            body = await parseJsonBody(req, 8 * 1024 * 1024);
          } catch (err) {
            return sendParseBodyError(res, err, "invalid json");
          }
          const prompt = String(body?.prompt || "").trim();
          if (!prompt) {
            return sendJson(res, 400, { error: "prompt is required" });
          }
          if (
            !ctx.model ||
            (typeof ctx.model.generateImage !== "function" &&
              typeof ctx.model.nextTurn !== "function")
          ) {
            return sendJson(res, 503, {
              error: "Google image generation model is not configured",
            });
          }

          const rawSessionId = String(body?.sessionId || body?.botId || "").trim();
          const sessionId = rawSessionId ? sanitizeBotWorkspaceId(rawSessionId) : "";
          if (rawSessionId && !sessionId) {
            return sendJson(res, 400, { error: "invalid sessionId" });
          }

          const storedSettings = ctx.store?.readSettings?.() || {};
          const rawProviders =
            ctx.resolveRawProviders?.() ||
            storedSettings.providers ||
            ctx.getMergedSettings?.()?.providers;
          const rawRouting = storedSettings.routing
            ? normalizeRoutingSettings(storedSettings.routing)
            : undefined;
          const baseWriteRoots = Array.isArray(ctx.finalConfig.writeRoots)
            ? ctx.finalConfig.writeRoots
            : [];
          const scopedWriteRoots = sessionId
            ? resolveBotWriteRoots({ writeRoots: baseWriteRoots, sessionId })
            : baseWriteRoots;
          const effectiveConfig = {
            ...ctx.finalConfig,
            ...(baseWriteRoots.length > 0
              ? {
                  baseWorkspaceRoot: resolveBaseWorkspaceRoot({ writeRoots: baseWriteRoots }),
                  writeRoots: scopedWriteRoots,
                }
              : {}),
            ...(Array.isArray(rawProviders) && rawProviders.length > 0
              ? { providers: rawProviders }
              : {}),
            ...(rawRouting ? { routing: rawRouting } : {}),
          };

          let capturedMeta: { saved: any; genRes: any } | null = null;
          const toolRes: any = await runBotCollabTool(
            "generate_image",
            {
              prompt,
              title: body?.title || "",
              aspect_ratio: String(body?.aspectRatio || "1:1").trim() || "1:1",
              quality: body?.quality === "pro" ? "pro" : "standard",
              image_size: body?.imageSize,
              output_format: String(body?.outputFormat || body?.output_format || "").trim(),
              reference_image_path: body?.referenceImagePath || body?.reference_image_path || "",
            },
            {
              store: ctx.store,
              model: ctx.model,
              executor: ctx.executor,
              config: effectiveConfig,
              senderSessionId: sessionId || undefined,
              broadcastGlobal: ctx.runner?.broadcastGlobal,
              onImageGenerated: (meta: { saved: any; genRes: any }) => {
                capturedMeta = meta;
              },
            }
          );

          if (!toolRes?.ok) {
            return sendJson(res, 502, {
              error: toolRes?.error || "image generation failed",
            });
          }

          const genRes = (capturedMeta as any)?.genRes || {};
          const saved = (capturedMeta as any)?.saved || {};
          const base64Data =
            genRes.base64Data ||
            (toolRes.path && fs.existsSync(toolRes.path)
              ? fs.readFileSync(toolRes.path).toString("base64")
              : "");

          // Record usage against the session if sessionId was supplied
          recordSessionModelUsage(
            ctx,
            sessionId,
            toolRes.model,
            genRes.usage,
            genRes.usedProviderId || ""
          );

          return sendJson(res, 201, {
            ok: true,
            model: toolRes.model,
            name: toolRes.title,
            path: toolRes.path,
            size: saved.size ?? toolRes.size,
            mimeType: toolRes.mime_type,
            outputFormat: toolRes.output_format,
            url: toolRes.url,
            markdown: toolRes.markdown,
            dataUrl: `data:${toolRes.mime_type};base64,${base64Data}`,
            usage: genRes.usage ?? null,
            degraded: Boolean(toolRes.degraded),
            ...(toolRes.degraded
              ? {
                  fallbackMode: toolRes.fallback_mode,
                  degradedReason: toolRes.degraded_reason,
                  fallbackNotice: toolRes.fallback_notice,
                  convertedFromSvg: Boolean(toolRes.converted_from_svg),
                  ...(toolRes.conversion_warning
                    ? { conversionWarning: toolRes.conversion_warning }
                    : {}),
                }
              : {}),
          });
        }

        // POST /api/images/convert
        if (method === "POST" && pathname === "/api/images/convert") {
          let body;
          try {
            body = await parseJsonBody(req, 16 * 1024 * 1024);
          } catch (err) {
            return sendParseBodyError(res, err, "invalid or oversized json");
          }

          const targetFormat = String(body?.format || body?.outputFormat || "").trim();
          if (!targetFormat) {
            return sendJson(res, 400, { error: "format is required" });
          }

          const rawExplicitSessionId = String(body?.sessionId || body?.botId || "").trim();
          const explicitSessionId = rawExplicitSessionId
            ? sanitizeBotWorkspaceId(rawExplicitSessionId)
            : "";
          if (rawExplicitSessionId && !explicitSessionId) {
            return sendJson(res, 400, { error: "invalid sessionId" });
          }

          let inputBuffer: Buffer | null = null;
          let inputMimeType = String(body?.mimeType || "").trim();

          if (typeof body?.svg === "string" && body.svg.trim()) {
            inputBuffer = Buffer.from(body.svg, "utf-8");
            inputMimeType = inputMimeType || "image/svg+xml";
          } else if (typeof body?.dataBase64 === "string" && body.dataBase64.trim()) {
            const rawB64 = body.dataBase64.replace(/^data:[^;]+;base64,/i, "").trim();
            inputBuffer = Buffer.from(rawB64, "base64");
            inputMimeType = inferImageMimeType(rawB64, inputMimeType);
          } else if (typeof body?.path === "string" && body.path.trim()) {
            const reqPath = body.path.trim();
            if (!isInsideAllowedRoots(reqPath, ctx.finalConfig.writeRoots)) {
              return sendJson(res, 403, { error: "access denied" });
            }
            if (
              explicitSessionId &&
              isOtherBotPrivateWorkspacePath(reqPath, ctx.finalConfig.writeRoots, explicitSessionId)
            ) {
              return sendJson(res, 403, { error: "access denied" });
            }
            const resolved = path.resolve(reqPath);
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
              return sendJson(res, 404, { error: "source image file not found" });
            }
            inputBuffer = fs.readFileSync(resolved);
            if (!inputMimeType) {
              inputMimeType = inferFileMimeType(path.extname(resolved));
            }
          } else {
            return sendJson(res, 400, {
              error: "one of path, svg, or dataBase64 is required",
            });
          }

          if (!inputBuffer || inputBuffer.length === 0) {
            return sendJson(res, 400, { error: "empty input image data" });
          }

          const targetSessionId =
            explicitSessionId ||
            (typeof body?.path === "string"
              ? inferSessionIdFromWorkspacePath(body.path, ctx.finalConfig.writeRoots)
              : "");

          try {
            const width = body?.width !== undefined ? Number(body.width) : undefined;
            const height = body?.height !== undefined ? Number(body.height) : undefined;
            const converted = await convertImageBuffer({
              inputBuffer,
              inputMimeType: inputMimeType || "image/png",
              targetFormat,
              width: Number.isFinite(width) && (width as number) > 0 ? width : undefined,
              height: Number.isFinite(height) && (height as number) > 0 ? height : undefined,
              executor: ctx.executor,
            });
            const workspaceRoot = resolveBotWorkspaceRoot({
              config: ctx.finalConfig,
              sessionId: targetSessionId,
              fallbackDir: path.join(os.tmpdir(), "twinklebot-generated"),
            });
            const outB64 = converted.buffer.toString("base64");
            const saved = saveGeneratedImageFile({
              base64Data: outB64,
              mimeType: converted.mimeType,
              title: body?.title || (body?.path ? path.basename(body.path, path.extname(body.path)) : "converted_image"),
              workspaceRoot,
            });
            if (targetSessionId) {
              ctx.runner?.broadcastGlobal?.({
                type: "library_updated",
                sessionId: targetSessionId,
              });
            }
            return sendJson(res, 201, {
              ok: true,
              format: converted.format,
              mimeType: converted.mimeType,
              converter: converted.converter,
              name: saved.name,
              path: saved.path,
              size: saved.size,
              url: saved.url,
              markdown: saved.markdown,
              dataUrl: `data:${saved.mimeType};base64,${outB64}`,
            });
          } catch (err: any) {
            return sendJson(res, 422, {
              error: err?.message || "image conversion failed",
            });
          }
        }

        // POST /api/attachments
        if (method === "POST" && pathname === "/api/attachments") {
          let body;
          try {
            body = await parseJsonBody(req, 16 * 1024 * 1024);
          } catch (err) {
            return sendParseBodyError(res, err, "invalid or oversized payload");
          }
          const rawSessionId = String(body?.sessionId || body?.botId || "").trim();
          const sessionId = rawSessionId ? sanitizeBotWorkspaceId(rawSessionId) : "";
          if (rawSessionId && !sessionId) {
            return sendJson(res, 400, { error: "invalid sessionId" });
          }
          const rawName = path.basename(String(body?.name || "upload.bin"));
          const safeName = rawName.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_");
          const dataBase64 = String(body?.dataBase64 || "");
          if (!dataBase64) {
            return sendJson(res, 400, { error: "dataBase64 is required" });
          }
          const workspaceRoot = resolveBotWorkspaceRoot({
            config: ctx.finalConfig,
            sessionId,
            fallbackDir: path.join(os.tmpdir(), "twinklebot-uploads"),
          });
          const uploadsDir = path.join(workspaceRoot, "uploads");
          fs.mkdirSync(uploadsDir, { recursive: true });
          const uniqueName = `${Date.now()}_${safeName}`;
          const destPath = path.join(uploadsDir, uniqueName);
          const buf = Buffer.from(dataBase64, "base64");
          fs.writeFileSync(destPath, buf);

          if (sessionId) {
            ctx.runner?.broadcastGlobal?.({
              type: "library_updated",
              sessionId,
            });
          }

          const ext = path.extname(uniqueName).toLowerCase();
          return sendJson(res, 201, {
            ok: true,
            name: rawName,
            path: destPath,
            size: buf.length,
            isMedia: MEDIA_EXTS.has(ext),
            url: `/api/workspace/file?path=${encodeURIComponent(destPath)}`,
          });
        }

        // GET /api/workspace/file?path=...
        if (method === "GET" && pathname === "/api/workspace/file") {
          const requestedPath = url.searchParams.get("path") || "";
          const reqSessionId = String(url.searchParams.get("sessionId") || "").trim();
          if (
            !requestedPath ||
            !isInsideAllowedRoots(requestedPath, ctx.finalConfig.writeRoots) ||
            (reqSessionId &&
              isOtherBotPrivateWorkspacePath(
                requestedPath,
                ctx.finalConfig.writeRoots,
                reqSessionId
              ))
          ) {
            return sendJson(res, 403, { error: "access denied" });
          }
          const resolved = path.resolve(requestedPath);
          if (!fs.existsSync(resolved)) {
            return sendJson(res, 404, { error: "file not found" });
          }
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) {
            return sendJson(res, 404, { error: "file not found" });
          }
          const ext = path.extname(resolved).toLowerCase();
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          const fileHeaders: Record<string, string | number> = {
            "Content-Type": contentType,
            "Content-Length": stat.size,
            "X-Content-Type-Options": "nosniff",
          };
          if (url.searchParams.get("download") === "1") {
            const rawName = String(url.searchParams.get("name") || "").trim();
            const downloadName = path.basename(rawName || resolved) || "download";
            fileHeaders["Content-Disposition"] =
              `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
          } else if (
            ext === ".html" ||
            ext === ".htm" ||
            ext === ".xhtml" ||
            ext === ".svg"
          ) {
            fileHeaders["Content-Security-Policy"] = "sandbox allow-scripts allow-forms";
          }
          res.writeHead(200, fileHeaders);
          fs.createReadStream(resolved).pipe(res);
          return true;
        }

        // GET /api/files/meta?path=...
        if (method === "GET" && pathname === "/api/files/meta") {
          const requestedPath = url.searchParams.get("path") || "";
          const resolved = expandUserPath(requestedPath);
          if (!resolved || isSensitiveFilePath(resolved)) {
            return sendJson(res, 403, { error: "access denied" });
          }
          if (!fs.existsSync(resolved)) {
            return sendJson(res, 200, {
              ok: true,
              exists: false,
              name: path.basename(resolved),
              ext: path.extname(resolved).toLowerCase(),
            });
          }
          const stat = fs.statSync(resolved);
          const ext = path.extname(resolved).toLowerCase();
          return sendJson(res, 200, {
            ok: true,
            exists: stat.isFile(),
            name: path.basename(resolved),
            path: resolved,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            ext,
            mimeType: inferFileMimeType(ext),
            inWorkspace: isInsideAllowedRoots(resolved, ctx.finalConfig.writeRoots),
          });
        }

        // POST /api/files/open
        if (method === "POST" && pathname === "/api/files/open") {
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const rawPath = String(body?.path || "").trim();
          const resolved = expandUserPath(rawPath);
          if (!resolved || isSensitiveFilePath(resolved)) {
            return sendJson(res, 403, { error: "access denied" });
          }
          if (!fs.existsSync(resolved)) {
            return sendJson(res, 404, { error: "file not found" });
          }
          const reveal = Boolean(body?.reveal);
          const args = reveal ? ["-R", resolved] : [resolved];
          try {
            await new Promise<void>((resolve, reject) => {
              execFile("/usr/bin/open", args, { timeout: 10000 }, (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
            return sendJson(res, 200, { ok: true, path: resolved, reveal });
          } catch (err: any) {
            return sendJson(res, 500, {
              error: err?.message || "failed to open file",
            });
          }
        }

  return false;
}
