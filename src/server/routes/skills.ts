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
  CHANNEL_SKILL_IDS,
  INSTALLABLE_SKILL_IDS,
  MAIL_SKILL_IDS,
  getSkillMeta,
  isBuiltinPlatformSkill,
  isInstallableSkill,
  isSkillSupportedOnPlatform,
} from "../../shared/skills-catalog.js";
import { purgeProviderAccounts } from "../../lib/mail-accounts.js";
import {
  normalizeChannelsAuthStore,
  normalizeFeishuChannelConfig,
  normalizeTelegramChannelConfig,
} from "../../lib/channel-integrations.js";
import {
  consolidateMemories,
  validateConsolidatedMemoryListWithReport,
} from "../../agent/memory-consolidator.js";

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

        // Resolve non-blocking Memory Suggestion Card (PI-016)
        const memSugMatch = pathname.match(/^\/api\/memories\/suggestions\/([^/]+)\/resolve$/);
        if (method === "POST" && memSugMatch) {
          const suggestionId = decodeURIComponent(memSugMatch[1]);
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const decision = body?.action === "accept" ? "accept" : "dismiss";
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          const scope = body?.scope === "global" ? "global" : "bot";
          const rawContent = String(body?.content || "").trim();
          const rawName =
            String(body?.name || "").trim() || rawContent.replace(/\s+/g, " ").slice(0, 18);

          let savedMemory: any = null;
          if (decision === "accept") {
            if (!rawContent) {
              return sendJson(res, 400, { error: "content is required" });
            }
            const botSession =
              scope === "bot" && sessionId ? ctx.store?.getSession?.(sessionId) : null;
            const effectiveScope = scope === "bot" && botSession ? "bot" : "global";
            const item = {
              id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              name: rawName,
              desc: rawContent,
              instruction: rawContent,
              content: rawContent,
              enabled: true,
              updatedAt: new Date().toISOString(),
            };
            if (effectiveScope === "bot" && botSession) {
              const prevList = Array.isArray(botSession.memories) ? [...botSession.memories] : [];
              const exists = prevList.some(
                (m: any) =>
                  String(m?.instruction || m?.content || m?.desc || "").trim().toLowerCase() ===
                  rawContent.toLowerCase()
              );
              if (!exists) {
                prevList.unshift(item);
                const updatedSession = ctx.store?.updateSession?.(botSession.id, {
                  memories: prevList,
                  touch: false,
                });
                ctx.broadcastEvent?.({
                  type: "session_updated",
                  sessionId: botSession.id,
                  session: updatedSession || { ...botSession, memories: prevList },
                });
              }
              savedMemory = item;
            } else {
              const settings = ctx.store?.readSettings?.() || {};
              const prevGlobal = Array.isArray(settings.globalMemories)
                ? [...settings.globalMemories]
                : Array.isArray(settings.privateSkills)
                  ? [...settings.privateSkills]
                  : [];
              const exists = prevGlobal.some(
                (m: any) =>
                  String(m?.instruction || m?.content || m?.desc || "").trim().toLowerCase() ===
                  rawContent.toLowerCase()
              );
              if (!exists) {
                prevGlobal.unshift(item);
                ctx.store?.writeSettings?.({
                  globalMemories: prevGlobal,
                  privateSkills: [],
                });
                ctx.broadcastSkillsUpdated();
              }
              savedMemory = item;
            }
          }

          const resolvedEvent = {
            type: "memory_suggestion_resolved",
            suggestionId,
            status: decision === "accept" ? "accepted" : "dismissed",
            scope,
            name: rawName,
            content: rawContent,
          };
          if (sessionId && ctx.store?.getSession?.(sessionId)) {
            ctx.store?.appendEvent?.(sessionId, resolvedEvent);
            ctx.broadcastEvent?.({ ...resolvedEvent, sessionId });
          }
          return sendJson(res, 200, {
            ok: true,
            suggestionId,
            status: resolvedEvent.status,
            ...(savedMemory ? { memory: savedMemory } : {}),
          });
        }

        // One-Click Memory Consolidation (Preview + Apply)
        if (method === "POST" && pathname === "/api/memories/consolidate") {
          let body: any = {};
          try {
            body = await parseJsonBody(req);
          } catch {
            // allow defaults
          }
          const scope: "bot" | "global" = body?.scope === "bot" ? "bot" : "global";
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          const mode: "llm" | "deterministic" =
            body?.mode === "deterministic" ? "deterministic" : "llm";
          const settings = ctx.store?.readSettings?.() || {};

          let memories: any[] = [];
          let botTitle = "Twinkle";
          let botRolePrompt = "";
          if (scope === "bot") {
            const botSession = sessionId ? ctx.store?.getSession?.(sessionId) : null;
            if (!botSession) {
              return sendJson(res, 404, { error: "未找到指定的 Bot 会话" });
            }
            memories = Array.isArray(botSession.memories) ? [...botSession.memories] : [];
            botTitle = botSession.title || "Twinkle";
            botRolePrompt = typeof botSession.rolePrompt === "string" ? botSession.rolePrompt : "";
          } else {
            memories = Array.isArray(settings.globalMemories)
              ? [...settings.globalMemories]
              : Array.isArray(settings.privateSkills)
                ? [...settings.privateSkills]
                : [];
          }

          const result = await consolidateMemories({
            scope,
            ...(sessionId ? { sessionId } : {}),
            memories,
            model: ctx.model,
            config: {
              ...(ctx.finalConfig || {}),
              routing: settings.routing || ctx.finalConfig?.routing,
            },
            botName: botTitle,
            ...(botRolePrompt ? { botRolePrompt } : {}),
            mode,
          });
          if (!result.ok) {
            return sendJson(res, result.statusCode || 400, { error: result.error });
          }
          return sendJson(res, 200, { ok: true, plan: result.plan });
        }

        if (method === "POST" && pathname === "/api/memories/consolidate/apply") {
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const scope: "bot" | "global" = body?.scope === "bot" ? "bot" : "global";
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
          if (!Array.isArray(body?.proposedList)) {
            return sendJson(res, 400, { error: "proposedList array is required" });
          }

          if (scope === "bot") {
            const botSession = sessionId ? ctx.store?.getSession?.(sessionId) : null;
            if (!botSession) {
              return sendJson(res, 404, { error: "未找到指定的 Bot 会话" });
            }
            const origList = Array.isArray(botSession.memories) ? botSession.memories : [];
            const { memories: sanitized, dropped } = validateConsolidatedMemoryListWithReport(
              body.proposedList,
              origList
            );
            const updatedSession = ctx.store?.updateSession?.(botSession.id, {
              memories: sanitized,
              touch: false,
            });
            ctx.broadcastEvent?.({
              type: "session_updated",
              sessionId: botSession.id,
              session: updatedSession || { ...botSession, memories: sanitized },
            });
            return sendJson(res, 200, {
              ok: true,
              scope: "bot",
              sessionId: botSession.id,
              count: sanitized.length,
              memories: sanitized,
              dropped,
            });
          }

          const settings = ctx.store?.readSettings?.() || {};
          const origGlobal = Array.isArray(settings.globalMemories)
            ? settings.globalMemories
            : [];
          const { memories: sanitizedGlobal, dropped: droppedGlobal } =
            validateConsolidatedMemoryListWithReport(body.proposedList, origGlobal);
          ctx.store?.writeSettings?.({
            globalMemories: sanitizedGlobal,
            privateSkills: [],
          });
          ctx.broadcastSkillsUpdated();
          return sendJson(res, 200, {
            ok: true,
            scope: "global",
            count: sanitizedGlobal.length,
            memories: sanitizedGlobal,
            dropped: droppedGlobal,
          });
        }

        // Harness² Experience Proposals (Phase H3)
        if (method === "GET" && pathname === "/api/experience-proposals") {
          const sessionId = String(url.searchParams.get("sessionId") || "").trim();
          const status = String(url.searchParams.get("status") || "pending").trim();
          const proposals =
            ctx.store?.listExperienceProposals?.({
              ...(sessionId ? { sessionId } : {}),
              ...(status ? { status } : {}),
            }) || [];
          return sendJson(res, 200, { ok: true, proposals });
        }

        const expResolveMatch = pathname.match(/^\/api\/experience-proposals\/([^/]+)\/resolve$/);
        if (method === "POST" && expResolveMatch) {
          const proposalId = decodeURIComponent(expResolveMatch[1]);
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          const decision = body?.action === "accept" ? "accept" : "dismiss";
          const allProposals = ctx.store?.listExperienceProposals?.({ status: "all" }) || [];
          const proposal = allProposals.find((p: any) => p && p.id === proposalId);
          if (!proposal) {
            return sendJson(res, 404, { error: "未找到该经验建议" });
          }

          let applied: any = null;
          if (decision === "accept" && proposal.status === "pending") {
            if (
              (proposal.targetType === "custom_skill" || proposal.targetType === "skill_script") &&
              proposal.draftSkill
            ) {
              try {
                const ds = proposal.draftSkill;
                const savedSkill = ctx.store?.saveCustomSkill?.({
                  ...(ds.id ? { id: ds.id } : {}),
                  mode: "create",
                  name: ds.name || proposal.title,
                  description: ds.description || proposal.cue,
                  instructions: ds.instructions || proposal.lesson,
                  ...(Array.isArray(ds.triggers) ? { triggers: ds.triggers } : {}),
                  scope:
                    proposal.dimension === "domain" && proposal.sessionId
                      ? proposal.sessionId
                      : "global",
                  createdBy: "bot",
                  createdByBotId: proposal.sessionId || "",
                  createdByBotName: proposal.botName || "",
                });
                if (savedSkill && ds.scriptName && ds.scriptContent) {
                  ctx.store?.saveCustomSkillScript?.(
                    savedSkill.id,
                    ds.scriptName,
                    ds.scriptContent
                  );
                }
                ctx.broadcastSkillsUpdated();
                applied = { kind: "custom_skill", skillId: savedSkill?.id };
              } catch (err: any) {
                return sendJson(res, 400, { error: err?.message || "采纳生成技能失败" });
              }
            } else {
              const botSession = proposal.sessionId
                ? ctx.store?.getSession?.(proposal.sessionId)
                : null;
              const memEntry = {
                id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                name: String(proposal.title || "经验规则").slice(0, 24),
                content: proposal.lesson,
                enabled: true,
                source: "reflection",
                updatedAt: new Date().toISOString(),
              };
              if (botSession) {
                const prev = Array.isArray(botSession.memories) ? [...botSession.memories] : [];
                const dup = prev.some(
                  (m: any) =>
                    String(m?.content || m?.instruction || m?.desc || "").trim().toLowerCase() ===
                    String(proposal.lesson || "").trim().toLowerCase()
                );
                if (!dup) {
                  prev.unshift(memEntry);
                  const updatedSession = ctx.store?.updateSession?.(botSession.id, {
                    memories: prev,
                    touch: false,
                  });
                  ctx.broadcastEvent?.({
                    type: "session_updated",
                    sessionId: botSession.id,
                    session: updatedSession || { ...botSession, memories: prev },
                  });
                }
                applied = { kind: "bot_playbook", sessionId: botSession.id };
              } else {
                const settings = ctx.store?.readSettings?.() || {};
                const prevGlobal = Array.isArray(settings.globalMemories)
                  ? [...settings.globalMemories]
                  : [];
                const dup = prevGlobal.some(
                  (m: any) =>
                    String(m?.content || m?.instruction || m?.desc || "").trim().toLowerCase() ===
                    String(proposal.lesson || "").trim().toLowerCase()
                );
                if (!dup) {
                  prevGlobal.unshift(memEntry);
                  ctx.store?.writeSettings?.({ globalMemories: prevGlobal, privateSkills: [] });
                  ctx.broadcastSkillsUpdated();
                }
                applied = { kind: "global_playbook" };
              }
            }
          }

          const nextStatus = decision === "accept" ? "accepted" : "dismissed";
          const resolved = ctx.store?.resolveExperienceProposal?.(proposalId, nextStatus);
          ctx.broadcastEvent?.({
            type: "experience_proposal_resolved",
            proposalId,
            status: nextStatus,
            sessionId: proposal.sessionId,
          });
          return sendJson(res, 200, {
            ok: true,
            proposal: resolved || { ...proposal, status: nextStatus },
            ...(applied ? { applied } : {}),
          });
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

        const skillScriptsCollectionMatch = pathname.match(/^\/api\/custom-skills\/([^/]+)\/scripts$/);
        if (skillScriptsCollectionMatch && method === "POST") {
          const targetId = decodeURIComponent(skillScriptsCollectionMatch[1]);
          let body: any;
          try {
            body = await parseJsonBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid json" });
          }
          try {
            const resData = ctx.store?.saveCustomSkillScript?.(
              targetId,
              body?.name || body?.script_name,
              body?.content ?? body?.script_content
            );
            ctx.broadcastSkillsUpdated();
            return sendJson(res, 200, { ok: true, ...resData });
          } catch (err: any) {
            return sendJson(res, 400, { error: err?.message || "保存技能脚本失败" });
          }
        }

        const skillScriptItemMatch = pathname.match(/^\/api\/custom-skills\/([^/]+)\/scripts\/([^/]+)$/);
        if (skillScriptItemMatch) {
          const targetId = decodeURIComponent(skillScriptItemMatch[1]);
          const scriptName = decodeURIComponent(skillScriptItemMatch[2]);
          if (method === "GET") {
            try {
              const script = ctx.store?.readCustomSkillScript?.(targetId, scriptName);
              return sendJson(res, 200, { ok: true, script });
            } catch (err: any) {
              return sendJson(res, 404, { error: err?.message || "未找到脚本" });
            }
          }
          if (method === "PUT") {
            let body: any;
            try {
              body = await parseJsonBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid json" });
            }
            try {
              const resData = ctx.store?.saveCustomSkillScript?.(
                targetId,
                scriptName,
                body?.content ?? body?.script_content
              );
              ctx.broadcastSkillsUpdated();
              return sendJson(res, 200, { ok: true, ...resData });
            } catch (err: any) {
              return sendJson(res, 400, { error: err?.message || "保存技能脚本失败" });
            }
          }
          if (method === "DELETE") {
            try {
              const resData = ctx.store?.deleteCustomSkillScript?.(targetId, scriptName);
              ctx.broadcastSkillsUpdated();
              return sendJson(res, 200, { ok: true, ...resData });
            } catch (err: any) {
              return sendJson(res, 400, { error: err?.message || "删除技能脚本失败" });
            }
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
            if (isInstall) {
              const skillMeta = getSkillMeta(skillId);
              const hostPlatform = ctx.hostPlatform || process.platform;
              if (!isSkillSupportedOnPlatform(skillMeta || skillId, hostPlatform)) {
                return sendJson(res, 400, {
                  error: `${skillMeta?.name || skillId} 仅支持 macOS，当前系统暂不支持添加`,
                  code: "UNSUPPORTED_PLATFORM",
                  supportedPlatforms: skillMeta?.supportedPlatforms || [],
                  hostPlatform,
                });
              }
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
            if (!isInstall && CHANNEL_SKILL_IDS.includes(skillId)) {
              ctx.channelManager?.stopChannel?.(skillId);
              if (purgeCredentials) {
                const curCh = normalizeChannelsAuthStore(ctx.store?.readChannelsAuth?.() || {});
                if (skillId === "telegram-bot") {
                  curCh.telegramAccounts = [];
                  curCh["telegram-bot"] = normalizeTelegramChannelConfig({});
                } else if (skillId === "feishu-bot") {
                  curCh.feishuAccounts = [];
                  curCh["feishu-bot"] = normalizeFeishuChannelConfig({});
                }
                ctx.store?.writeChannelsAuth?.(normalizeChannelsAuthStore(curCh));
              }
            }
            ctx.broadcastSkillsUpdated();
            return sendJson(res, 200, { ok: true, ...ctx.getMergedSettings() });
          }
        }

  return false;
}
