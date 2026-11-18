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
} from "../http-utils.js";
import {
  INSTALLABLE_SKILL_IDS,
  MAIL_SKILL_IDS,
  isBuiltinPlatformSkill,
  isInstallableSkill,
} from "../../shared/skills-catalog.js";
import { purgeProviderAccounts } from "../../lib/mail-accounts.js";

export async function handleSkillsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string,
  ctx: ServerContext
): Promise<boolean> {
        if (method === "GET" && pathname === "/api/skills") {
          return sendJson(res, 200, ctx.getMergedSettings());
        }

        // Custom Skills CRUD (shared across all Bots, kept separate from Skills Store)
        if (method === "GET" && pathname === "/api/custom-skills") {
          return sendJson(res, 200, {
            ok: true,
            customSkills: ctx.store?.listCustomSkills?.() || [],
          });
        }

        if (method === "POST" && pathname === "/api/custom-skills") {
          let body;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return sendJson(res, 400, { error: "invalid payload" });
          }
          try {
            const skill = ctx.store?.saveCustomSkill?.({
              ...body,
              mode: body.mode || "create",
              createdBy: body.createdBy === "bot" ? "bot" : "user",
            });
            ctx.broadcastSkillsUpdated();
            return sendJson(res, 201, {
              ok: true,
              skill,
              customSkills: ctx.store?.listCustomSkills?.() || [],
            });
          } catch (err: any) {
            return sendJson(res, 400, { error: err?.message || "保存自定义技能失败" });
          }
        }

        const customSkillItemMatch = pathname.match(/^\/api\/custom-skills\/([^/]+)$/);
        if (customSkillItemMatch) {
          const targetId = decodeURIComponent(customSkillItemMatch[1]);
          if (method === "GET") {
            const skill = ctx.store?.getCustomSkill?.(targetId);
            if (!skill) return sendJson(res, 404, { error: "未找到该自定义技能" });
            return sendJson(res, 200, { ok: true, skill });
          }
          if (method === "PATCH") {
            let body;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return sendJson(res, 400, { error: "invalid payload" });
            }
            const existing = ctx.store?.getCustomSkill?.(targetId);
            if (!existing) {
              return sendJson(res, 404, { error: "未找到该自定义技能" });
            }
            try {
              const onlyToggle =
                "enabled" in body &&
                !("name" in body) &&
                !("description" in body) &&
                !("desc" in body) &&
                !("instructions" in body) &&
                !("content" in body) &&
                !("icon" in body) &&
                !("newId" in body);
              const skill = onlyToggle
                ? ctx.store?.toggleCustomSkill?.(existing.id, body.enabled)
                : ctx.store?.saveCustomSkill?.({
                    ...body,
                    id: existing.id,
                    mode: "update",
                  });
              ctx.broadcastSkillsUpdated();
              return sendJson(res, 200, {
                ok: true,
                skill,
                customSkills: ctx.store?.listCustomSkills?.() || [],
              });
            } catch (err: any) {
              return sendJson(res, 400, { error: err?.message || "更新自定义技能失败" });
            }
          }
          if (method === "DELETE") {
            const deleted = ctx.store?.deleteCustomSkill?.(targetId);
            if (!deleted) {
              return sendJson(res, 404, { error: "未找到该自定义技能" });
            }
            ctx.broadcastSkillsUpdated();
            return sendJson(res, 200, {
              ok: true,
              deleted,
              customSkills: ctx.store?.listCustomSkills?.() || [],
            });
          }
        }

        // POST /api/skills/:id/install · DELETE /api/skills/:id
        const skillRouteMatch = pathname.match(/^\/api\/skills\/([^/]+)(\/install)?$/);
        if (skillRouteMatch) {
          const skillId = skillRouteMatch[1];
          const isInstall = Boolean(skillRouteMatch[2]);
          if ((isInstall && method === "POST") || (!isInstall && method === "DELETE")) {
            if (isBuiltinPlatformSkill(skillId)) {
              return sendJson(res, 400, {
                error: "平台技能为系统内置核心能力，不可关闭或移除",
              });
            }
            if (!isInstallableSkill(skillId)) {
              return sendJson(res, 404, { error: "未找到该技能" });
            }
            const current = ctx.getInstalledSkills();
            let purgeCredentials = url.searchParams.get("purgeCredentials") === "true";
            if (!isInstall) {
              try {
                const body = await parseJsonBody(req);
                if (body && body.purgeCredentials === true) purgeCredentials = true;
              } catch {
                // empty or invalid body: rely on query parameter
              }
            }
            const next = isInstall
              ? INSTALLABLE_SKILL_IDS.filter(
                  (id: any) => id === skillId || current.includes(id)
                )
              : current.filter((id: any) => id !== skillId);
            ctx.store?.writeSettings?.({ installedSkills: next });
            if (!isInstall && purgeCredentials && MAIL_SKILL_IDS.includes(skillId)) {
              purgeProviderAccounts(ctx.store, skillId);
            }
            if (!isInstall && skillId === "kimi-cu") {
              await ctx.activeMcpManager?.stopServer?.("kimi-cu");
            }
            ctx.broadcastSkillsUpdated();
            return sendJson(res, 200, { ok: true, ...ctx.getMergedSettings() });
          }
        }

  return false;
}
