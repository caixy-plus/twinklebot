import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferImageMimeType } from "../model.js";
import { registerEphemeralSecret } from "../tools.js";
import { findDuplicateMemory, hasExplicitMemoryIntent } from "../memory-extractor.js";
import { computeInitialNextRun } from "../scheduler.js";
import { describeCronExpression, parseCronExpression } from "../../shared/cron.js";
import { buildSessionCostSummary } from "../pricing.js";
import { updateBotComputer } from "../../lib/bot-computer-updater.js";
import {
  probeBotComputerState,
  provisionBotComputer,
} from "../../lib/bot-computer-provisioner.js";
import {
  stageDeliveredFile,
  expandUserPath,
  isSensitiveFilePath,
} from "../../lib/file-attachments.js";
import {
  resolveBotWorkspaceRoot,
  scanWorkspaceFiles,
} from "../../lib/bot-workspace.js";
import { searchWeb, fetchWebPage } from "../../lib/web-search.js";
import {
  normalizeMailConfig,
  normalizeMailAuthStore,
  listMailMessages,
  readMailMessage,
  sendMailMessage,
  verifyMailConnection,
} from "../../lib/mail-client.js";
import {
  PLATFORM_SKILLS,
  OFFICE_SKILLS,
  MAIL_SKILL_IDS,
  resolveInstalledSkillIds,
  inferMailServerPreset,
} from "../../shared/skills-catalog.js";
import {
  upsertMailAccount,
  findMailAccount,
  setDefaultMailAccount,
  removeMailAccount,
} from "../../lib/mail-accounts.js";
import { MAX_BOT_HOPS, getInstalledSkillIds } from "./declarations.js";
import { resolveBotByRef } from "./collab-tools.js";
import { summarizeChannelStatusForBot } from "../../lib/channel-integrations.js";

export const UNHANDLED_BOT_TOOL = Symbol.for("twinklebot.unhandled_bot_tool");

function isPathInsideAllowedRoots(targetPath: string, roots: string[] = []) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const resolved = path.resolve(targetPath);
  const base = path.basename(resolved).toLowerCase();
  if (base === ".env" || /.*auth.*\.json$/i.test(base)) return false;
  if (resolved.split(path.sep).some((seg) => seg.toLowerCase() === ".ssh")) {
    return false;
  }
  return roots.some((root) => {
    if (!root || typeof root !== "string") return false;
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}


export async function handleSystemBotTool(
  name: string,
  args: Record<string, any> = {},
  ctx: Record<string, any> = {}
) {
  const {
    store,
    model,
    executor,
    fetchImpl,
    getChannelStatus,
    config = {},
    senderSessionId,
    senderBot,
    hopDepth = 0,
    control,
    callId,
    emit,
    broadcastGlobal,
    onDispatchBotTurn,
    onDispatchGroupTurn,
    provisionComputerFn = provisionBotComputer,
    probeComputerFn = probeBotComputerState,
  } = ctx;

  if (!store) {
    return { error: "store unavailable for bot collaboration" };
  }
  const currentBot =
    senderBot ||
    store.getSession(senderSessionId) || {
      id: senderSessionId,
      title: "Twinkle",
      avatar: { shape: "blob", color: "black" },
    };

  switch (name) {
    case "memory_manage": {
      const action = String(args.action || "").trim();
      const targetBotId = senderBot?.id || senderSessionId;
      const botSession = targetBotId ? store.getSession?.(targetBotId) : null;
      const settings = store.readSettings?.() || {};
      const globalList = Array.isArray(settings.globalMemories)
        ? [...settings.globalMemories]
        : Array.isArray(settings.privateSkills)
          ? [...settings.privateSkills]
          : [];
      const botList = Array.isArray(botSession?.memories)
        ? [...botSession.memories]
        : [];

      const slimMemory = (m: any, scopeTag?: string) => ({
        id: m.id,
        name: m.name || "",
        content: m.instruction || m.content || m.desc || "",
        enabled: m.enabled !== false,
        ...(scopeTag ? { scope: scopeTag } : {}),
      });

      const findInList = (list: any[], query: unknown) => {
        const needle = String(query || "").trim().toLowerCase();
        if (!needle) return -1;
        const exactId = list.findIndex((m) => String(m.id || "").toLowerCase() === needle);
        if (exactId >= 0) return exactId;
        const exactName = list.findIndex(
          (m) => String(m.name || "").trim().toLowerCase() === needle
        );
        if (exactName >= 0) return exactName;
        return list.findIndex((m) => {
          const hay = `${m.name || ""} ${m.instruction || m.content || m.desc || ""}`.toLowerCase();
          return hay.includes(needle);
        });
      };

      const persistTargetList = (targetScope: string, nextList: any[]) => {
        if (targetScope === "bot" && botSession) {
          const updatedSession = store.updateSession?.(botSession.id, {
            memories: nextList,
            touch: false,
          });
          broadcastGlobal?.({
            type: "session_updated",
            sessionId: botSession.id,
            session: updatedSession || { ...botSession, memories: nextList },
          });
        } else {
          store.writeSettings?.({
            globalMemories: nextList,
            privateSkills: nextList,
          });
          broadcastGlobal?.({ type: "skills_updated" });
        }
      };

      if (action === "list") {
        const botMapped = botList.map((m) => slimMemory(m, "bot"));
        const globalMapped = globalList.map((m) => slimMemory(m, "global"));
        const combined =
          args.scope === "bot"
            ? botMapped
            : args.scope === "global"
              ? globalMapped
              : [...botMapped, ...globalMapped];
        return {
          ok: true,
          action: "list",
          botName: currentBot.title,
          botMemories: botMapped,
          globalMemories: globalMapped,
          memories: combined,
        };
      }

      if (action === "save") {
        const rawContent = String(args.content || args.instruction || "").trim();
        if (!rawContent) {
          return { ok: false, error: "请提供要保存的记忆内容（content）" };
        }
        const targetScope =
          args.scope === "global"
            ? "global"
            : args.scope === "bot"
              ? botSession
                ? "bot"
                : "global"
              : botSession
                ? "bot"
                : "global";
        const activeList = targetScope === "bot" ? botList : globalList;

        const rawName =
          String(args.name || "").trim() ||
          rawContent.replace(/\s+/g, " ").slice(0, 18);
        const targetIdx = args.memory
          ? findInList(activeList, args.memory)
          : activeList.findIndex(
              (m) => String(m.name || "").trim().toLowerCase() === rawName.toLowerCase()
            );

        // Server-side deduplication against existing memories in both bot & global scope
        if (targetIdx < 0 && !args.memory) {
          const dupInTarget = findDuplicateMemory(activeList, rawContent);
          const dupInOther =
            !dupInTarget && targetScope === "bot"
              ? findDuplicateMemory(globalList, rawContent)
              : null;
          const dup = dupInTarget || dupInOther;
          if (dup) {
            return {
              ok: true,
              action: "save",
              deduplicated: true,
              scope: dupInTarget ? targetScope : "global",
              memory: slimMemory(dup, dupInTarget ? targetScope : "global"),
              totalCount: activeList.length,
            };
          }
        }

        // Direct silent persistence for both explicit ("记住…") and auto-triggered durable memories.
        // Never pops suggestion cards in chat; deduplication above protects against duplicates.
        const turnUserText = typeof ctx.userText === "string" ? ctx.userText.trim() : "";
        const effectiveTrigger =
          args.trigger === "auto" || (turnUserText.length > 0 && !hasExplicitMemoryIntent(turnUserText))
            ? "auto"
            : "explicit";

        let savedItem: any;
        let created = false;
        if (targetIdx >= 0) {
          const prev = activeList[targetIdx];
          savedItem = {
            ...prev,
            name: rawName || prev.name,
            desc: rawContent,
            instruction: rawContent,
            content: rawContent,
            enabled: args.enabled !== undefined ? Boolean(args.enabled) : prev.enabled !== false,
            updatedAt: new Date().toISOString(),
          };
          activeList[targetIdx] = savedItem;
        } else {
          created = true;
          savedItem = {
            id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: rawName,
            desc: rawContent,
            instruction: rawContent,
            content: rawContent,
            enabled: args.enabled !== false,
            source: effectiveTrigger,
            updatedAt: new Date().toISOString(),
          };
          activeList.unshift(savedItem);
        }

        persistTargetList(targetScope, activeList);
        return {
          ok: true,
          action: "save",
          scope: targetScope,
          trigger: effectiveTrigger,
          created,
          memory: slimMemory(savedItem, targetScope),
          totalCount: activeList.length,
        };
      }

      if (action === "remove" || action === "toggle") {
        const selector = args.memory || args.name || args.content || "";
        const resolveTarget = () => {
          if (args.scope === "bot") {
            return { scope: "bot", list: botList, idx: findInList(botList, selector) };
          }
          if (args.scope === "global") {
            return { scope: "global", list: globalList, idx: findInList(globalList, selector) };
          }
          const bIdx = findInList(botList, selector);
          if (bIdx >= 0) return { scope: "bot", list: botList, idx: bIdx };
          return { scope: "global", list: globalList, idx: findInList(globalList, selector) };
        };

        const { scope: hitScope, list: hitList, idx } = resolveTarget();
        if (idx < 0) {
          return {
            ok: false,
            error: selector
              ? `未找到匹配的记忆「${selector}」`
              : "请通过 memory 指定要操作的记忆（标题、关键词或 ID）",
          };
        }

        if (action === "remove") {
          const [removed] = hitList.splice(idx, 1);
          persistTargetList(hitScope, hitList);
          return {
            ok: true,
            action: "remove",
            scope: hitScope,
            removed: slimMemory(removed, hitScope),
            totalCount: hitList.length,
          };
        }

        const prev = hitList[idx];
        const nextEnabled =
          args.enabled !== undefined ? Boolean(args.enabled) : prev.enabled === false;
        const updated = { ...prev, enabled: nextEnabled };
        hitList[idx] = updated;
        persistTargetList(hitScope, hitList);
        return {
          ok: true,
          action: "toggle",
          scope: hitScope,
          memory: slimMemory(updated, hitScope),
        };
      }

      return { ok: false, error: `unknown action: ${action}` };
    }

    case "schedule_manage": {
      const action = String(args.action || "").trim();
      const allSessions = store?.listSessions?.() || [];
      let targetSession: any = null;
      if (args.target_bot && String(args.target_bot).trim()) {
        targetSession = resolveBotByRef(allSessions, args.target_bot);
        if (!targetSession) {
          return {
            ok: false,
            error: `未找到目标 Bot「${args.target_bot}」`,
          };
        }
      } else {
        const selfId = senderBot?.id || senderSessionId;
        targetSession =
          (selfId && store?.getSession?.(selfId)) ||
          senderBot || {
            id: selfId || "default",
            title: senderBot?.title || "当前 Bot",
          };
      }

      const targetBotId = targetSession.id;
      const targetBotName = targetSession.title || "Bot";
      const allSchedules = Array.isArray(store?.readSchedules?.())
        ? [...store.readSchedules()]
        : [];

      const slimSchedule = (s: any) => {
        const owner = allSessions.find((b: any) => b.id === s.sessionId);
        return {
          id: s.id,
          sessionId: s.sessionId,
          botName: owner?.title || (s.sessionId === targetBotId ? targetBotName : s.sessionId),
          title: s.title || "",
          scheduleLabel: s.scheduleLabel || "每天 10:00",
          repeat: s.repeat || "daily",
          ...(s.cron ? { cron: s.cron } : {}),
          prompt: s.prompt || "",
          nextRunAt: s.nextRunAt || null,
          lastRunAt: s.lastRunAt || null,
          enabled: s.enabled !== false,
        };
      };

      const findScheduleIdx = (selector: unknown) => {
        const needle = String(selector || "").trim().toLowerCase();
        if (!needle) return -1;
        // Prefer matching within targetBotId first, then across all schedules
        const matchInScope = (onlyTargetBot: boolean) =>
          allSchedules.findIndex((s) => {
            if (!s) return false;
            if (onlyTargetBot && s.sessionId !== targetBotId) return false;
            if (String(s.id || "").toLowerCase() === needle) return true;
            if (String(s.title || "").trim().toLowerCase() === needle) return true;
            const hay = `${s.title || ""} ${s.scheduleLabel || ""} ${s.prompt || ""}`.toLowerCase();
            return hay.includes(needle);
          });
        const ownIdx = matchInScope(true);
        return ownIdx >= 0 ? ownIdx : matchInScope(false);
      };

      const persistSchedules = (nextList: any[]) => {
        store?.writeSchedules?.(nextList);
        broadcastGlobal?.({
          type: "schedules_updated",
          sessionId: targetBotId,
        });
      };

      if (action === "list") {
        const botSchedules = allSchedules
          .filter((s) => s && s.sessionId === targetBotId)
          .map(slimSchedule);
        return {
          ok: true,
          action: "list",
          botId: targetBotId,
          botName: targetBotName,
          count: botSchedules.length,
          schedules: botSchedules,
          allSchedulesCount: allSchedules.length,
        };
      }

      if (action === "create") {
        const title = String(args.title || "").trim();
        const prompt = String(args.prompt || "").trim();
        if (!title || !prompt) {
          return {
            ok: false,
            error: "创建例行任务需要提供 title（任务名称）与 prompt（到点执行的指令）",
          };
        }
        const rawCron = typeof args.cron === "string" ? args.cron.trim() : "";
        const validRepeats = ["daily", "hourly", "weekly", "cron", "once"];
        const repeat = validRepeats.includes(args.repeat)
          ? args.repeat
          : rawCron
            ? "cron"
            : "daily";
        let normalizedCron = "";
        if (repeat === "cron") {
          const parsedCron = parseCronExpression(rawCron);
          if (!parsedCron.ok) {
            return { ok: false, error: parsedCron.error };
          }
          normalizedCron = parsedCron.normalized;
        }
        const defaultLabel =
          repeat === "cron"
            ? describeCronExpression(normalizedCron)
            : repeat === "hourly"
              ? "每小时"
              : repeat === "weekly"
                ? `每周 ${args.time || "10:00"}`
                : repeat === "once"
                  ? args.time
                    ? `单次 ${args.time}`
                    : "单次执行"
                  : `每天 ${args.time || "10:00"}`;
        const scheduleLabel =
          String(args.schedule_label || "").trim() || defaultLabel;
        const nextRunAt = computeInitialNextRun({
          repeat,
          scheduleLabel,
          time: args.time,
          delayMinutes: args.delay_minutes,
          cron: normalizedCron,
        });

        const item = {
          id: crypto.randomUUID(),
          sessionId: targetBotId,
          title,
          scheduleLabel,
          repeat,
          ...(repeat === "cron" ? { cron: normalizedCron } : {}),
          prompt,
          nextRunAt,
          enabled: args.enabled !== false,
          createdAt: new Date().toISOString(),
        };
        allSchedules.unshift(item);
        persistSchedules(allSchedules);
        return {
          ok: true,
          action: "create",
          schedule: slimSchedule(item),
        };
      }

      if (action === "update" || action === "toggle" || action === "remove") {
        const selector = args.schedule || args.title || "";
        const idx = findScheduleIdx(selector);
        if (idx < 0) {
          return {
            ok: false,
            error: selector
              ? `未找到匹配的例行任务「${selector}」`
              : "请通过 schedule 参数指定要操作的例行任务（ID、名称或关键词）",
          };
        }

        if (action === "remove") {
          const [removed] = allSchedules.splice(idx, 1);
          persistSchedules(allSchedules);
          return {
            ok: true,
            action: "remove",
            removed: slimSchedule(removed),
          };
        }

        const prev = allSchedules[idx];
        if (action === "toggle") {
          const nextEnabled =
            args.enabled !== undefined ? Boolean(args.enabled) : prev.enabled === false;
          const updated = { ...prev, enabled: nextEnabled };
          allSchedules[idx] = updated;
          persistSchedules(allSchedules);
          return {
            ok: true,
            action: "toggle",
            schedule: slimSchedule(updated),
          };
        }

        const validRepeats = ["daily", "hourly", "weekly", "cron", "once"];
        const hasCronArg = typeof args.cron === "string" && args.cron.trim().length > 0;
        const nextRepeat = validRepeats.includes(args.repeat)
          ? args.repeat
          : hasCronArg
            ? "cron"
            : prev.repeat || "daily";
        let normalizedCron = "";
        if (nextRepeat === "cron") {
          const rawCron = String(args.cron !== undefined ? args.cron : prev.cron || "").trim();
          const parsedCron = parseCronExpression(rawCron);
          if (!parsedCron.ok) {
            return { ok: false, error: parsedCron.error };
          }
          normalizedCron = parsedCron.normalized;
        }
        const nextLabel =
          args.schedule_label !== undefined
            ? String(args.schedule_label).trim() ||
              (nextRepeat === "cron" ? describeCronExpression(normalizedCron) : prev.scheduleLabel)
            : nextRepeat === "cron" && (args.cron !== undefined || prev.repeat !== "cron")
              ? describeCronExpression(normalizedCron)
              : args.time
                ? nextRepeat === "daily"
                  ? `每天 ${args.time}`
                  : `${prev.scheduleLabel || ""}`
                : prev.scheduleLabel;
        const shouldRecomputeNextRun =
          args.time !== undefined ||
          args.delay_minutes !== undefined ||
          args.schedule_label !== undefined ||
          args.repeat !== undefined ||
          args.cron !== undefined;
        const nextRunAt = shouldRecomputeNextRun
          ? computeInitialNextRun({
              repeat: nextRepeat,
              scheduleLabel: nextLabel,
              time: args.time,
              delayMinutes: args.delay_minutes,
              cron: normalizedCron,
            })
          : prev.nextRunAt;

        const updated: Record<string, any> = {
          ...prev,
          ...(args.title ? { title: String(args.title).trim() } : {}),
          ...(args.prompt ? { prompt: String(args.prompt).trim() } : {}),
          repeat: nextRepeat,
          scheduleLabel: nextLabel,
          nextRunAt,
          ...(args.enabled !== undefined ? { enabled: Boolean(args.enabled) } : {}),
        };
        if (nextRepeat === "cron") {
          updated.cron = normalizedCron;
        } else {
          delete updated.cron;
        }
        allSchedules[idx] = updated;
        persistSchedules(allSchedules);
        return {
          ok: true,
          action: "update",
          schedule: slimSchedule(updated),
        };
      }

      return { ok: false, error: `unknown action: ${action}` };
    }

    case "workspace_search": {
      const action = String(args.action || "").trim();
      const allSessions = store?.listSessions?.() || [];
      const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 40);

      if (action === "search") {
        const q = String(args.query || "").trim();
        const found = store?.search?.(q) || { bots: [], messages: [] };
        return {
          ok: true,
          action: "search",
          query: q,
          bots: (found.bots || []).slice(0, limit).map((b: any) => ({
            id: b.id,
            name: b.title,
            type: b.type || "dm",
            rolePrompt: b.rolePrompt || "",
            status: b.status || "idle",
          })),
          messages: (found.messages || []).slice(0, limit),
        };
      }

      if (action === "read_exchange") {
        const selfId = senderBot?.id || senderSessionId;
        let exchangeId = String(args.exchange_id || "").trim();
        let peerBot: any = null;
        if (!exchangeId && args.peer_bot) {
          peerBot = resolveBotByRef(allSessions, args.peer_bot);
          if (!peerBot) {
            return { ok: false, error: `未找到目标 Bot「${args.peer_bot}」` };
          }
          if (selfId && store?.pairExchangeId) {
            exchangeId = store.pairExchangeId(selfId, peerBot.id);
          }
        }
        if (!exchangeId) {
          return {
            ok: false,
            error: "请提供 peer_bot（对方 Bot 名称或 ID）或 exchange_id",
          };
        }
        const ex = store?.getExchange?.(exchangeId);
        if (!ex) {
          return {
            ok: true,
            action: "read_exchange",
            exchangeId,
            messages: [],
            note: "当前尚无该跨 Bot 交接记录",
          };
        }
        return {
          ok: true,
          action: "read_exchange",
          exchangeId: ex.id,
          updatedAt: ex.updatedAt,
          participants: ex.participants || [],
          messages: (ex.messages || []).slice(-limit),
        };
      }

      if (action === "recent_messages") {
        const targetRef = args.peer_bot || senderBot?.id || senderSessionId;
        const target =
          allSessions.find((s: any) => s.id === targetRef) ||
          resolveBotByRef(allSessions, targetRef);
        if (!target) {
          return {
            ok: false,
            error: `未找到会话或 Bot「${targetRef || ""}」`,
          };
        }
        const evs = (store?.readEvents?.(target.id) || []).filter(
          (e: any) => e && (e.type === "user" || e.type === "answer" || e.type === "bot_exchange")
        );
        return {
          ok: true,
          action: "recent_messages",
          botId: target.id,
          botName: target.title,
          messages: evs.slice(-limit).map((e: any) => ({
            seq: e.seq,
            type: e.type,
            botName: e.botName || (e.type === "user" ? "用户" : target.title),
            text: e.text || e.lastText || "",
            at: e.at,
          })),
        };
      }

      return { ok: false, error: `unknown workspace_search action: ${action}` };
    }

    case "library_manage": {
      const action = String(args.action || "").trim();
      const targetBotId = String(senderSessionId || senderBot?.id || "").trim() || "default";
      const targetBotName = senderBot?.title || "Bot";
      const workspaceRoot = resolveBotWorkspaceRoot({
        config,
        sessionId: targetBotId === "default" ? "" : targetBotId,
        fallbackDir: path.join(os.tmpdir(), "twinklebot-workspace"),
      });

      if (action === "save_note") {
        const rawTitle = String(args.title || "").trim();
        const rawContent = String(args.content || "").trim();
        if (!rawTitle || !rawContent) {
          return {
            ok: false,
            error: "save_note 需要提供 title（笔记标题）与 content（Markdown 内容）",
          };
        }
        const notesDir = path.join(workspaceRoot, "saved-notes");
        fs.mkdirSync(notesDir, { recursive: true });
        const safeSlug = rawTitle
          .slice(0, 48)
          .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, "_")
          .replace(/^_+|_+$/g, "");
        const fileName = `${Date.now()}_${safeSlug || "note"}.md`;
        const destPath = path.join(notesDir, fileName);
        const fullMd = rawContent.startsWith("#")
          ? rawContent
          : `# ${rawTitle}\n\n${rawContent}\n`;
        fs.writeFileSync(destPath, fullMd, "utf8");
        const url = `/api/workspace/file?path=${encodeURIComponent(destPath)}`;
        broadcastGlobal?.({
          type: "library_updated",
          sessionId: targetBotId,
        });
        return {
          ok: true,
          action: "save_note",
          title: rawTitle,
          name: fileName,
          path: destPath,
          url,
          attachmentLine: `[文件附件: ${fileName} · 路径: ${destPath}]`,
          botName: targetBotName,
          workspaceRoot,
        };
      }

      if (action === "list") {
        const filter = ["all", "media", "file"].includes(args.filter)
          ? args.filter
          : "all";
        const screenshots = (store?.listScreenshots?.(targetBotId) || []).map((s: any) => ({
          name: `桌面截图 ${s.file}`,
          type: "media",
          size: s.size,
          mtime: s.mtime,
          url: s.url,
          source: "screen",
        }));
        const workspaceFiles = scanWorkspaceFiles(workspaceRoot, 40);

        const combined = [...screenshots, ...workspaceFiles].filter((item) =>
          filter === "all" ? true : item.type === filter
        );
        return {
          ok: true,
          action: "list",
          filter,
          workspaceRoot,
          count: combined.length,
          items: combined,
        };
      }

      return { ok: false, error: `unknown library_manage action: ${action}` };
    }

    case "vault_manage": {
      const action = String(args.action || "").trim();
      const items = Array.isArray(store?.readVault?.())
        ? [...store.readVault()]
        : [];

      const slimVaultItem = (v: any) => ({
        id: v.id,
        category: v.category || "contact",
        title: v.title || "",
        subtitle: v.subtitle || "",
        notes: v.notes || "",
        hasPassword: typeof v.password === "string" && v.password.length > 0,
      });

      const findVaultIdx = (selector: string) => {
        const needle = String(selector || "").trim().toLowerCase();
        if (!needle) return -1;
        const exactId = items.findIndex((v) => String(v.id || "").toLowerCase() === needle);
        if (exactId >= 0) return exactId;
        const exactTitle = items.findIndex(
          (v) => String(v.title || "").trim().toLowerCase() === needle
        );
        if (exactTitle >= 0) return exactTitle;
        return items.findIndex((v) => {
          const hay = `${v.title || ""} ${v.subtitle || ""} ${v.notes || ""}`.toLowerCase();
          return hay.includes(needle);
        });
      };

      const persistVault = (nextItems: any[]) => {
        store?.writeVault?.(nextItems);
        broadcastGlobal?.({ type: "vault_updated" });
      };

      if (action === "list") {
        return {
          ok: true,
          action: "list",
          count: items.length,
          items: items.map(slimVaultItem),
        };
      }

      if (action === "get_secret") {
        const selector = args.item || args.title || args.subtitle || "";
        const idx = findVaultIdx(selector);
        if (idx < 0) {
          return {
            ok: false,
            error: selector
              ? `未找到匹配的保险箱条目「${selector}」`
              : "请通过 item 指定要读取密码句柄的保险箱条目（ID、标题或账号）",
          };
        }
        const entry = items[idx];
        if (typeof entry.password !== "string" || entry.password.length === 0) {
          return {
            ok: false,
            error: `保险箱条目「${entry.title || entry.id}」未保存密码；如需用户输入请调用 request_credential`,
            item: slimVaultItem(entry),
          };
        }
        const secretRef = registerEphemeralSecret(entry.password);
        return {
          ok: true,
          action: "get_secret",
          item: slimVaultItem(entry),
          secret_ref: secretRef,
          usage_hint:
            "Pass secret_ref directly as the `text` argument of `browser_type` or OS-level `type_text` ONLY. Never pass it to `run_shell`, `key`, URLs, or echo it.",
        };
      }

      if (action === "save") {
        const rawTitle = String(args.title || "").trim();
        const rawSubtitle = String(args.subtitle || "").trim();
        const rawNotes = String(args.notes || "").trim();
        if (!rawTitle && !rawSubtitle) {
          return {
            ok: false,
            error: "save 需要提供 title（名称）或 subtitle（邮箱/账号标识）",
          };
        }
        const category = ["contact", "account", "credential", "login", "note"].includes(
          args.category
        )
          ? args.category
          : "contact";
        const hitIdx = args.item
          ? findVaultIdx(args.item)
          : items.findIndex(
              (v) =>
                (rawTitle &&
                  String(v.title || "").trim().toLowerCase() === rawTitle.toLowerCase()) ||
                (rawSubtitle &&
                  String(v.subtitle || "").trim().toLowerCase() === rawSubtitle.toLowerCase())
            );

        let saved;
        let created = false;
        if (hitIdx >= 0) {
          const prev = items[hitIdx];
          saved = {
            ...prev,
            category: args.category ? category : prev.category || "contact",
            title: rawTitle || prev.title,
            subtitle: rawSubtitle || prev.subtitle || "",
            notes: args.notes !== undefined ? rawNotes : prev.notes || "",
          };
          items[hitIdx] = saved;
        } else {
          created = true;
          saved = {
            id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            category,
            title: rawTitle || rawSubtitle,
            subtitle: rawSubtitle,
            notes: rawNotes,
          };
          items.unshift(saved);
        }
        persistVault(items);
        return {
          ok: true,
          action: "save",
          created,
          item: slimVaultItem(saved),
          totalCount: items.length,
        };
      }

      if (action === "remove") {
        const selector = args.item || args.title || args.subtitle || "";
        const idx = findVaultIdx(selector);
        if (idx < 0) {
          return {
            ok: false,
            error: selector
              ? `未找到匹配的保险箱条目「${selector}」`
              : "请通过 item 指定要删除的条目（ID、标题或邮箱）",
          };
        }
        const [removed] = items.splice(idx, 1);
        persistVault(items);
        return {
          ok: true,
          action: "remove",
          removed: slimVaultItem(removed),
          totalCount: items.length,
        };
      }

      return { ok: false, error: `unknown vault_manage action: ${action}` };
    }

    case "system_diagnostics": {
      const action = String(args.action || "status").trim();
      const executor = ctx.executor || null;
      const mcpManager = ctx.mcpManager || null;
      const updateBotComputerFn = ctx.updateBotComputerFn || updateBotComputer;

      if (action === "reconnect_mcp") {
        const serverId = String(args.server_id || "kimi-cu").trim() || "kimi-cu";
        if (!mcpManager || typeof mcpManager.reconnectServer !== "function") {
          return { ok: false, error: "MCP manager is not configured" };
        }
        const st = await mcpManager.reconnectServer(serverId);
        return {
          ok: Boolean(st?.connected),
          action: "reconnect_mcp",
          server: st,
        };
      }

      if (action === "update_bot_computer") {
        const callerIsAdmin = Boolean(
          senderBot?.isAdmin || (senderSessionId && store?.getSession?.(senderSessionId)?.isAdmin)
        );
        if (!callerIsAdmin) {
          return {
            ok: false,
            action: "update_bot_computer",
            error: "权限不足：仅管理员 Bot 有权初始化或更新 Bot 电脑环境。",
          };
        }
        try {
          const upd = await updateBotComputerFn({
            executor,
            executorToken: config?.executorToken || "",
          });
          broadcastGlobal?.({
            type: "computer_status_updated",
            state: "ready",
            online: true,
          });
          return {
            ok: true,
            action: "update_bot_computer",
            ...upd,
          };
        } catch (err: any) {
          return {
            ok: false,
            action: "update_bot_computer",
            error: err?.message || String(err),
          };
        }
      }

      if (action === "status") {
        const startMs = Date.now();
        let botComputerOnline = true;
        let botComputerError = "";
        if (executor?.health) {
          try {
            await executor.health();
            botComputerOnline = true;
          } catch (err: any) {
            botComputerOnline = false;
            botComputerError = err?.message || "unreachable";
          }
        }
        const botComputerLatencyMs = Date.now() - startMs;

        const settings = store?.readSettings?.() || {};
        const hostExecutionMode =
          settings?.hostComputer?.executionMode || config.hostExecutionMode || "always";
        const installedSkills = getInstalledSkillIds(store);
        let mcpStatus: any = null;
        if (mcpManager && typeof mcpManager.getServerStatus === "function") {
          try {
            mcpStatus = await mcpManager.getServerStatus("kimi-cu", {
              connect: installedSkills.includes("kimi-cu"),
            });
          } catch (err: any) {
            mcpStatus = {
              serverId: "kimi-cu",
              connected: false,
              error: err?.message || String(err),
            };
          }
        }

        const selfId = senderBot?.id || senderSessionId;
        const sessionObj = selfId ? store?.getSession?.(selfId) : null;
        const usageSummary = sessionObj
          ? buildSessionCostSummary(sessionObj, {
              readEvents: () => store?.readEvents?.(selfId) || [],
              defaultModel: config.defaultModel || "gemini-4-argon",
            })
          : null;

        const channels = summarizeChannelStatusForBot(
          typeof getChannelStatus === "function" ? getChannelStatus() : null
        );

        return {
          ok: true,
          action: "status",
          botComputer: {
            online: botComputerOnline,
            latencyMs: botComputerLatencyMs,
            screen: config.screen || { width: 1440, height: 900 },
            ...(botComputerError ? { error: botComputerError } : {}),
          },
          hostComputer: {
            hostname: os.hostname(),
            platform: `${process.platform}/${process.arch}`,
            release: os.release(),
            executionMode: hostExecutionMode,
          },
          kimiCuSkill: {
            addedInSkillsStore: installedSkills.includes("kimi-cu"),
            ...(mcpStatus ? { mcpStatus } : {}),
          },
          channels,
          sessionUsage: usageSummary,
        };
      }

      return { ok: false, error: `unknown system_diagnostics action: ${action}` };
    }

    case "computer_provision": {
      const action = String(args.action || "probe").trim();
      const deployEnv = config?.deployEnv || "local";
      const callerIsAdmin = Boolean(
        senderBot?.isAdmin || (senderSessionId && store?.getSession?.(senderSessionId)?.isAdmin)
      );

      if (action === "probe" || action === "verify") {
        const probed = await probeComputerFn({
          deployEnv,
          executor,
          store,
        });
        return { ok: true, action, ...probed };
      }

      if (action === "install") {
        if (deployEnv === "local" && !callerIsAdmin) {
          return {
            ok: false,
            action,
            error: "权限不足：仅管理员 Bot 有权初始化或创建 Bot 电脑环境。",
          };
        }
        const res = await provisionComputerFn({
          deployEnv,
          store,
          executor,
          executorToken: config?.executorToken || "",
          onProgress: (msg: string) => {
            broadcastGlobal?.({
              type: "computer_status_updated",
              state: "creating",
              detail: msg,
            });
          },
        });
        broadcastGlobal?.({
          type: "computer_status_updated",
          state: res.state,
          online: Boolean(res.online),
          provider: res.provider,
          detail: res.detail || res.error || "",
        });
        return res;
      }

      return { ok: false, error: `unknown computer_provision action: ${action}` };
    }

    default:
      return UNHANDLED_BOT_TOOL;
  }
}
