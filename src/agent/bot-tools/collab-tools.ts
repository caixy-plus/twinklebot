import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferImageMimeType } from "../model.js";
import { registerEphemeralSecret } from "../tools.js";
import { computeInitialNextRun } from "../scheduler.js";
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
  isOtherBotPrivateWorkspacePath,
  resolveBotWorkspaceRoot,
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
import {
  COLORFUL_KEYS,
  MAX_BOT_HOPS,
  VALID_COLORS,
  VALID_SHAPES,
  pickByHash,
} from "./declarations.js";

export const UNHANDLED_BOT_TOOL = Symbol.for("twinklebot.unhandled_bot_tool");

function isPathInsideAllowedRoots(targetPath: string, roots: string[] = []) {
  const resolved = path.resolve(targetPath);
  if (isSensitiveFilePath(resolved)) return false;
  return roots.some((root) => {
    if (!root || typeof root !== "string") return false;
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export function resolveBotByRef(sessions: any[], ref: unknown) {
  const needle = String(ref || "").trim();
  if (!needle) return null;
  const dmBots = sessions.filter((s) => s.type !== "group");
  const exactId = dmBots.find((s) => s.id === needle);
  if (exactId) return exactId;
  const lower = needle.toLowerCase();
  const exactTitle = dmBots.find(
    (s) => String(s.title || "").trim().toLowerCase() === lower
  );
  if (exactTitle) return exactTitle;
  return (
    dmBots.find((s) => String(s.title || "").toLowerCase().includes(lower)) ||
    null
  );
}

export async function handleCollabBotTool(
  name: string,
  args: Record<string, any> = {},
  ctx: Record<string, any> = {}
) {
  const {
    store,
    model,
    executor,
    fetchImpl,
    config = {},
    userMeta,
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

  if (name === "web_search") {
    return await searchWeb(args.query, {
      maxResults: args.max_results,
      ...(args.freshness ? { freshness: args.freshness } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  if (name === "web_fetch") {
    return await fetchWebPage(args.url, {
      maxChars: args.max_chars,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  if (name === "send_file") {
    const rawPath = String(args.path || "").trim();
    if (!rawPath) {
      return { ok: false, error: "send_file requires a non-empty path" };
    }
    const workspaceSessionId = String(senderSessionId || senderBot?.id || "").trim();
    const workspaceRoot = resolveBotWorkspaceRoot({
      config,
      sessionId: workspaceSessionId,
      fallbackDir: path.join(os.tmpdir(), "twinklebot-generated"),
    });
    const expanded = expandUserPath(rawPath);
    if (isSensitiveFilePath(expanded)) {
      return {
        ok: false,
        error: "access denied: sensitive system/credential files cannot be sent",
      };
    }
    if (
      workspaceSessionId &&
      isOtherBotPrivateWorkspacePath(expanded, config, workspaceSessionId)
    ) {
      return {
        ok: false,
        error: "access denied: file belongs to another Bot's private workspace",
      };
    }

    try {
      let staged;
      if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
        staged = stageDeliveredFile({
          sourcePath: expanded,
          title: args.title,
          workspaceRoot,
        });
      } else if (executor && typeof executor.call === "function") {
        // Fallback: pull file bytes safely from Bot's Ubuntu computer if it lives there
        const b64Script =
          "python3 -c " +
          JSON.stringify(
            "import sys,os,base64; p=os.path.expanduser(sys.argv[1]); " +
              "assert os.path.isfile(p), 'missing'; " +
              "assert os.path.getsize(p) <= 25*1024*1024, 'too_large'; " +
              "sys.stdout.write(base64.b64encode(open(p,'rb').read()).decode('ascii'))"
          ) +
          " " +
          JSON.stringify(rawPath);
        const shellRes = await executor.call("/shell", { command: b64Script });
        const b64 = String(shellRes?.stdout || "").trim();
        if (!shellRes?.ok && !b64) {
          throw new Error(`file not found on local computer or Bot's Ubuntu computer: ${rawPath}`);
        }
        const buf = Buffer.from(b64, "base64");
        if (!buf.length) {
          throw new Error(`unable to read file: ${rawPath}`);
        }
        staged = stageDeliveredFile({
          buffer: buf,
          fileName: path.basename(rawPath),
          title: args.title,
          workspaceRoot,
        });
      } else {
        throw new Error(`file not found: ${expanded}`);
      }

      broadcastGlobal?.({
        type: "library_updated",
        sessionId: senderSessionId,
      });

      const channelMeta =
        userMeta?.channelMeta && typeof userMeta.channelMeta === "object"
          ? userMeta.channelMeta
          : null;
      const channelName = String(channelMeta?.channel || "").trim();
      const channelHardLimitBytes = channelName === "feishu-bot" ? 30 * 1024 * 1024 : 50 * 1024 * 1024;
      const channelLimitMb = channelName === "feishu-bot" ? 30 : 50;
      const channelDelivery = !channelMeta
        ? { channel_delivery: "app_only" }
        : staged.size > channelHardLimitBytes
          ? {
              channel_delivery: "exceeds_channel_limit",
              delivery_note: `File staged in App (${staged.size} bytes), but exceeds ${channelName}'s ${channelLimitMb}MB limit and cannot be uploaded there. Tell the user to download from TwinkleBot App or split/compress the file.`,
            }
          : {
              channel_delivery: "queued_on_turn_end",
              delivery_note: `File staged in App and queued for automatic upload to ${channelName} at turn end. Actual upload runs asynchronously after your final reply; if upload fails, the user will receive an explicit failure notice in the channel and lastSendError will record the reason.`,
            };

      return {
        ok: true,
        name: staged.name,
        title: staged.name,
        path: staged.path,
        source_path: staged.sourcePath,
        size: staged.size,
        mime_type: staged.mimeType,
        url: staged.url,
        download_url: staged.downloadUrl,
        is_media: staged.isMedia,
        markdown: staged.markdown,
        ...(args.caption ? { caption: String(args.caption).trim() } : {}),
        ...channelDelivery,
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `send_file failed: ${err?.message || String(err)}`,
      };
    }
  }

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
    case "list_bots": {
      const all = store.listSessions();
      const writeRoots = Array.isArray(config?.writeRoots) ? config.writeRoots : [];
      const bots = all
        .filter((s: any) => s.type !== "group")
        .map((s: any) => {
          const wsDir =
            writeRoots.length > 0
              ? resolveBotWorkspaceRoot({ writeRoots, sessionId: s.id })
              : "";
          return {
            id: s.id,
            name: s.title,
            role_prompt: s.rolePrompt || "",
            status: s.status || "idle",
            avatar: s.avatar || null,
            ...(wsDir ? { workspace_dir: wsDir } : {}),
          };
        });
      const groups = all
        .filter((s: any) => s.type === "group")
        .map((s: any) => ({
          id: s.id,
          title: s.title,
          memberBotIds: s.memberBotIds || [],
        }));
      const botsWorkspaceRoot =
        writeRoots.length > 0 ? path.join(path.resolve(String(writeRoots[0])), "bots") : "";
      return {
        ok: true,
        bots,
        groups,
        ...(botsWorkspaceRoot ? { bots_workspace_root: botsWorkspaceRoot } : {}),
      };
    }

    case "create_bot": {
      const botName = String(args.name || "").trim();
      if (!botName) {
        return { error: "name is required" };
      }
      const shape = VALID_SHAPES.includes(args.shape)
        ? args.shape
        : pickByHash(botName, VALID_SHAPES);
      const color = VALID_COLORS.includes(args.color)
        ? args.color
        : pickByHash(botName, COLORFUL_KEYS);

      const created = store.createSession({
        title: botName.slice(0, 52),
        type: "dm",
        avatar: { shape, color },
        rolePrompt: String(args.role_prompt || "").trim(),
        createdByBotId: currentBot.id,
        subtitle: `由 ${currentBot.title || "Bot"} 创建`,
      });

      broadcastGlobal?.({
        type: "bot_created",
        sessionId: created.id,
        bot: created,
      });

      let handoff: any = null;
      if (args.initial_message && String(args.initial_message).trim()) {
        handoff = await deliverInterBotMessage({
          store,
          fromBot: currentBot,
          toBot: created,
          message: String(args.initial_message).trim(),
          hopDepth,
          broadcastGlobal,
          onDispatchBotTurn,
        });
      }

      return {
        ok: true,
        bot: {
          id: created.id,
          name: created.title,
          shape,
          color,
        },
        ...(handoff ? { handoff } : {}),
      };
    }

    case "send_bot_message": {
      if (hopDepth >= MAX_BOT_HOPS) {
        return {
          error: `Maximum inter-Bot hop depth (${MAX_BOT_HOPS}) reached; summarize current progress back to the user instead.`,
        };
      }
      const sessions = store.listSessions();
      const target = resolveBotByRef(sessions, args.target_bot);
      if (!target) {
        return {
          error: `Target Bot '${args.target_bot}' not found. Call list_bots or create_bot first.`,
        };
      }
      if (target.id === currentBot.id) {
        return { error: "Cannot send_bot_message to yourself." };
      }
      const text = String(args.message || "").trim();
      if (!text) {
        return { error: "message cannot be empty" };
      }

      const delivery = await deliverInterBotMessage({
        store,
        fromBot: currentBot,
        toBot: target,
        message: text,
        hopDepth,
        awaitReply: Boolean(args.await_reply),
        awaitTimeoutSec: args.await_timeout_sec,
        signal: control?.signal || null,
        broadcastGlobal,
        onDispatchBotTurn,
      });

      if (delivery?.error) {
        return { ok: false, ...delivery };
      }
      return { ok: true, ...delivery };
    }

    case "create_bot_group": {
      const title = String(args.title || "").trim() || "Bot 协作群";
      const refs = Array.isArray(args.member_bots) ? args.member_bots : [];
      const sessions = store.listSessions();
      const memberIds = new Set();
      if (currentBot.id && currentBot.type !== "group") {
        memberIds.add(currentBot.id);
      }
      for (const ref of refs) {
        const found = resolveBotByRef(sessions, ref);
        if (found) memberIds.add(found.id);
      }
      if (memberIds.size < 2) {
        for (const s of sessions) {
          if (s.type !== "group") memberIds.add(s.id);
          if (memberIds.size >= 2) break;
        }
      }

      const group = store.createSession({
        title: title.slice(0, 52),
        type: "group",
        memberBotIds: [...memberIds],
        createdByBotId: currentBot.id,
        subtitle: `${memberIds.size} 位成员`,
      });

      broadcastGlobal?.({
        type: "bot_created",
        sessionId: group.id,
        bot: group,
      });

      if (args.initial_message && String(args.initial_message).trim()) {
        onDispatchGroupTurn?.({
          groupId: group.id,
          text: String(args.initial_message).trim(),
          initiatorBot: currentBot,
        });
      }

      return {
        ok: true,
        group: {
          id: group.id,
          title: group.title,
          memberBotIds: group.memberBotIds,
        },
      };
    }

    case "ask_user_choice": {
      const normalizedQuestions: any[] = [];
      if (Array.isArray(args.questions) && args.questions.length > 0) {
        args.questions.slice(0, 6).forEach((qItem, idx) => {
          const qText = String(qItem?.question || `问题 ${idx + 1}`).trim();
          const qOpts = (Array.isArray(qItem?.options) ? qItem.options : [])
            .map((o: any) => String(o || "").trim())
            .filter(Boolean)
            .slice(0, 6);
          if (qOpts.length >= 2) {
            normalizedQuestions.push({
              id: String(qItem?.id || `q_${idx + 1}`),
              question: qText,
              options: qOpts,
              multiSelect: Boolean(qItem?.multi_select),
              placeholder: String(qItem?.placeholder || "输入你自己的回答…"),
            });
          }
        });
      } else {
        const question = String(args.question || "接下来先帮你做哪一步？").trim();
        const rawOpts = Array.isArray(args.options) ? args.options : [];
        const options = rawOpts
          .map((o) => String(o || "").trim())
          .filter(Boolean)
          .slice(0, 6);
        if (options.length >= 2) {
          normalizedQuestions.push({
            id: "q_1",
            question,
            options,
            multiSelect: Boolean(args.multi_select),
            placeholder: String(args.placeholder || "输入你自己的回答…"),
          });
        }
      }

      if (normalizedQuestions.length === 0) {
        return { error: "ask_user_choice requires at least 2 options" };
      }

      const firstQ = normalizedQuestions[0];
      const allowCustom = args.allow_custom !== false;

      if (!control?.requestChoice) {
        return { selected: firstQ.options[0], autoSelected: true };
      }

      const choicePromise = control.requestChoice(callId);
      emit?.({
        type: "choice_request",
        callId,
        question: firstQ.question,
        options: firstQ.options,
        multiSelect: firstQ.multiSelect,
        allowCustom,
        placeholder: firstQ.placeholder,
        questions: normalizedQuestions,
      });
      emit?.({ type: "status", status: "awaiting_choice" });

      const selection = await choicePromise;
      if (selection === null || control.stopped) {
        emit?.({ type: "choice_superseded", callId });
        return { error: "choice cancelled" };
      }

      emit?.({
        type: "choice_resolved",
        callId,
        selected: selection,
      });
      emit?.({ type: "status", status: "running" });

      return { ok: true, selected: selection };
    }

    case "propose_draft": {
      const title = String(args.title || "待确认草稿").trim();
      const recipient = String(args.recipient || "").trim();
      const content = String(args.content || "");
      const kind = String(args.kind || "message").trim();

      if (!control?.requestChoice) {
        return { ok: true, approved: true, title, recipient, content, autoApproved: true };
      }

      const draftPromise = control.requestChoice(callId);
      emit?.({
        type: "draft_request",
        callId,
        title,
        recipient,
        content,
        kind,
      });
      emit?.({ type: "status", status: "awaiting_choice" });

      const resolution = await draftPromise;
      if (resolution === null || control.stopped) {
        emit?.({ type: "choice_superseded", callId });
        return { error: "draft superseded or cancelled" };
      }

      const approved =
        typeof resolution === "object" && resolution !== null
          ? resolution.approved !== false
          : Boolean(resolution);
      const finalTitle =
        typeof resolution === "object" && resolution?.title !== undefined
          ? String(resolution.title)
          : title;
      const finalRecipient =
        typeof resolution === "object" && resolution?.recipient !== undefined
          ? String(resolution.recipient)
          : recipient;
      const finalContent =
        typeof resolution === "object" && resolution?.content !== undefined
          ? String(resolution.content)
          : content;

      emit?.({
        type: "draft_resolved",
        callId,
        approved,
        title: finalTitle,
        recipient: finalRecipient,
        content: finalContent,
      });
      emit?.({ type: "status", status: "running" });

      if (!approved) {
        return { ok: false, approved: false, reason: "user cancelled draft" };
      }
      return {
        ok: true,
        approved: true,
        title: finalTitle,
        recipient: finalRecipient,
        content: finalContent,
      };
    }

    case "request_credential": {
      const service = String(args.service || "外部服务").trim();
      const label = String(args.label || "请输入登录凭据或验证码").trim();
      const fieldType = ["password", "otp", "text"].includes(args.field_type)
        ? args.field_type
        : "password";

      if (!control?.requestChoice) {
        return { error: "interactive credential input unavailable" };
      }

      const credPromise = control.requestChoice(callId);
      emit?.({
        type: "credential_request",
        callId,
        service,
        label,
        fieldType,
      });
      emit?.({ type: "status", status: "awaiting_choice" });

      const credRes = await credPromise;
      if (credRes === null || control.stopped) {
        emit?.({ type: "choice_superseded", callId });
        return { error: "credential input cancelled" };
      }

      const submittedValue =
        typeof credRes === "object" && credRes !== null
          ? String(credRes.value || "")
          : String(credRes || "");
      const saveToVault = Boolean(credRes?.saveToVault);

      if (saveToVault && submittedValue && store?.readVault && store?.writeVault) {
        const items = [...store.readVault()];
        const vaultTitle = `${service} 登录凭据`;
        const vaultSubtitle = String(credRes?.account || service).trim();
        const existingIdx = items.findIndex(
          (v: any) =>
            v &&
            (String(v.title || "").trim().toLowerCase() === vaultTitle.toLowerCase() ||
              (v.category === "credential" &&
                String(v.subtitle || "").trim().toLowerCase() === vaultSubtitle.toLowerCase()))
        );
        if (existingIdx >= 0) {
          items[existingIdx] = {
            ...items[existingIdx],
            category: "credential",
            title: items[existingIdx].title || vaultTitle,
            subtitle: vaultSubtitle || items[existingIdx].subtitle || service,
            notes: items[existingIdx].notes || "已通过对话安全卡片加密保存",
            password: submittedValue,
          };
        } else {
          items.unshift({
            id: `v-${Date.now()}`,
            category: "credential",
            title: vaultTitle,
            subtitle: vaultSubtitle,
            notes: "已通过对话安全卡片加密保存",
            password: submittedValue,
          });
        }
        store.writeVault(items);
        broadcastGlobal?.({ type: "vault_updated" });
      }

      emit?.({
        type: "credential_resolved",
        callId,
        service,
        submitted: Boolean(submittedValue),
        savedToVault: saveToVault,
      });
      emit?.({ type: "status", status: "running" });

      if (!submittedValue) {
        return { ok: false, error: "user skipped credential input" };
      }
      const secretRef = registerEphemeralSecret(submittedValue);
      return {
        ok: true,
        service,
        secret_ref: secretRef,
        savedToVault: saveToVault,
        usage_hint:
          "Pass secret_ref directly as the `text` argument of `browser_type` (preferred for normal web inputs) or OS-level `type_text` (for cross-origin iframes / native windows after clicking the input). Never pass it to `run_shell`, `key`, URLs, or echo it.",
      };
    }

    case "bot_manage": {
      const action = String(args.action || "").trim();
      const allSessions = store?.listSessions?.() || [];

      if (action === "update_group_members") {
        const groupNeedle = String(args.group || "").trim();
        const groups = allSessions.filter((s: any) => s.type === "group");
        const targetGroup = groupNeedle
          ? groups.find((g: any) => g.id === groupNeedle) ||
            groups.find(
              (g: any) => String(g.title || "").trim().toLowerCase() === groupNeedle.toLowerCase()
            ) ||
            groups.find((g: any) =>
              String(g.title || "").toLowerCase().includes(groupNeedle.toLowerCase())
            )
          : senderSessionId
            ? groups.find((g: any) => g.id === senderSessionId)
            : null;
        if (!targetGroup) {
          return {
            ok: false,
            error: groupNeedle
              ? `未找到目标群聊「${groupNeedle}」`
              : "请通过 group 参数指定要更新成员的群聊名称或 ID",
          };
        }

        const currentIds = new Set(
          Array.isArray(targetGroup.memberBotIds) ? targetGroup.memberBotIds : []
        );
        const addRefs = Array.isArray(args.add_bots) ? args.add_bots : [];
        const removeRefs = Array.isArray(args.remove_bots) ? args.remove_bots : [];

        for (const ref of addRefs) {
          const found = resolveBotByRef(allSessions, ref);
          if (found) currentIds.add(found.id);
        }
        for (const ref of removeRefs) {
          const found = resolveBotByRef(allSessions, ref);
          if (found) currentIds.delete(found.id);
        }

        const nextMemberIds = [...currentIds];
        const updatedGroup = store.updateSession?.(targetGroup.id, {
          memberBotIds: nextMemberIds,
        });
        broadcastGlobal?.({
          type: "session_updated",
          sessionId: targetGroup.id,
          session: updatedGroup || { ...targetGroup, memberBotIds: nextMemberIds },
        });
        return {
          ok: true,
          action: "update_group_members",
          groupId: targetGroup.id,
          title: updatedGroup?.title || targetGroup.title,
          memberBotIds: nextMemberIds,
        };
      }

      const selfId = senderBot?.id || senderSessionId;
      const targetBot =
        args.target_bot && String(args.target_bot).trim()
          ? resolveBotByRef(allSessions, args.target_bot)
          : (selfId && store?.getSession?.(selfId)) || senderBot || null;

      if (!targetBot) {
        return {
          ok: false,
          error: args.target_bot
            ? `未找到目标 Bot「${args.target_bot}」`
            : "未找到当前 Bot 会话",
        };
      }

      if (action === "clone") {
        const overrides: Record<string, any> = {};
        if (args.name && String(args.name).trim()) {
          overrides.title = String(args.name).trim().slice(0, 52);
        }
        if (args.role_prompt && String(args.role_prompt).trim()) {
          overrides.rolePrompt = String(args.role_prompt).trim();
        }
        if (args.shape || args.color) {
          const prevAvatar =
            targetBot.avatar && typeof targetBot.avatar === "object"
              ? targetBot.avatar
              : {};
          overrides.avatar = {
            ...prevAvatar,
            shape: VALID_SHAPES.includes(args.shape)
              ? args.shape
              : prevAvatar.shape || pickByHash(overrides.title || targetBot.title, VALID_SHAPES),
            color: VALID_COLORS.includes(args.color)
              ? args.color
              : prevAvatar.color || pickByHash(overrides.title || targetBot.title, COLORFUL_KEYS),
          };
        }
        const cloned = store?.cloneSession?.(targetBot.id, overrides);
        if (!cloned) {
          return { ok: false, error: `克隆 Bot「${targetBot.title}」失败` };
        }
        broadcastGlobal?.({
          type: "bot_created",
          sessionId: cloned.id,
          bot: cloned,
        });
        return {
          ok: true,
          action: "clone",
          bot: {
            id: cloned.id,
            name: cloned.title,
            rolePrompt: cloned.rolePrompt || "",
            avatar: cloned.avatar || null,
          },
        };
      }

      if (action === "update_profile") {
        const patch: Record<string, any> = {};
        if (args.name && String(args.name).trim()) {
          patch.title = String(args.name).trim().slice(0, 52);
        }
        if (typeof args.role_prompt === "string" && args.role_prompt.trim()) {
          patch.rolePrompt = args.role_prompt.trim();
        }
        if (args.shape || args.color) {
          const prevAvatar =
            targetBot.avatar && typeof targetBot.avatar === "object"
              ? targetBot.avatar
              : {};
          patch.avatar = {
            ...prevAvatar,
            ...(VALID_SHAPES.includes(args.shape) ? { shape: args.shape } : {}),
            ...(VALID_COLORS.includes(args.color) ? { color: args.color } : {}),
          };
        }
        if (Object.keys(patch).length === 0) {
          return {
            ok: false,
            error: "update_profile 需要至少提供 name、role_prompt、shape 或 color 之一",
          };
        }
        const updated = store?.updateSession?.(targetBot.id, patch) || {
          ...targetBot,
          ...patch,
        };
        broadcastGlobal?.({
          type: "session_updated",
          sessionId: targetBot.id,
          session: updated,
        });
        return {
          ok: true,
          action: "update_profile",
          bot: {
            id: updated.id,
            name: updated.title,
            rolePrompt: updated.rolePrompt || "",
            avatar: updated.avatar || null,
          },
        };
      }

      return { ok: false, error: `unknown bot_manage action: ${action}` };
    }

    default:
      return UNHANDLED_BOT_TOOL;
  }
}

const INTER_BOT_DEBOUNCE_MS = 3_000;
const EXCHANGE_LOOP_SIMILARITY_THRESHOLD = 0.85;
const recentInterBotDeliveries = new Map<
  string,
  { at: number; message: string; result: Record<string, any> }
>();

function normalizeCollabText(input: unknown): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

function computeTextSimilarity(a: unknown, b: unknown): number {
  const na = normalizeCollabText(a);
  const nb = normalizeCollabText(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const toBigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };
  const mapA = toBigrams(na);
  const mapB = toBigrams(nb);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const v of mapA.values()) totalA += v;
  for (const v of mapB.values()) totalB += v;
  for (const [k, va] of mapA.entries()) {
    const vb = mapB.get(k);
    if (vb) overlap += Math.min(va, vb);
  }
  return (2 * overlap) / (totalA + totalB);
}

export async function deliverInterBotMessage({
  store,
  fromBot,
  toBot,
  message,
  hopDepth = 0,
  awaitReply = false,
  awaitTimeoutSec,
  signal = null,
  broadcastGlobal,
  onDispatchBotTurn,
}: {
  store: any;
  fromBot: any;
  toBot: any;
  message: string;
  hopDepth?: number;
  awaitReply?: boolean;
  awaitTimeoutSec?: number;
  signal?: AbortSignal | null;
  broadcastGlobal?: ((evt: any) => void) | null;
  onDispatchBotTurn?: ((opts: any) => void) | null;
}) {
  const pairKey = `${fromBot.id}::${toBot.id}`;
  const nowMs = Date.now();
  if (recentInterBotDeliveries.size > 200) {
    for (const [k, entry] of recentInterBotDeliveries.entries()) {
      if (nowMs - entry.at > 60_000) recentInterBotDeliveries.delete(k);
    }
  }
  const recent = recentInterBotDeliveries.get(pairKey);
  if (
    recent &&
    nowMs - recent.at < INTER_BOT_DEBOUNCE_MS &&
    computeTextSimilarity(recent.message, message) >= EXCHANGE_LOOP_SIMILARITY_THRESHOLD
  ) {
    return {
      ...recent.result,
      coalesced: true,
      deduplicated: true,
    };
  }

  const pairId = store.pairExchangeId?.(fromBot.id, toBot.id);
  const existingExchange = pairId ? store.getExchange?.(pairId) : null;
  const prevMsgs: any[] = Array.isArray(existingExchange?.messages)
    ? existingExchange.messages
    : [];
  if (prevMsgs.length >= 2) {
    const m1 = prevMsgs[prevMsgs.length - 2];
    const m2 = prevMsgs[prevMsgs.length - 1];
    const recentWindow =
      hopDepth >= 1 ||
      (m2?.at && Number.isFinite(Date.parse(m2.at)) && nowMs - Date.parse(m2.at) < 120_000);
    if (
      recentWindow &&
      computeTextSimilarity(m1?.text, m2?.text) > EXCHANGE_LOOP_SIMILARITY_THRESHOLD &&
      computeTextSimilarity(m2?.text, message) > EXCHANGE_LOOP_SIMILARITY_THRESHOLD &&
      computeTextSimilarity(m1?.text, message) > EXCHANGE_LOOP_SIMILARITY_THRESHOLD
    ) {
      return {
        error: `Inter-Bot hop loop detected: 3 consecutive messages in exchange ${pairId} exceed 85% similarity; summarize progress back to the user instead.`,
        loopBlocked: true,
        exchangeId: pairId,
      };
    }
  }
  const exchange = store.recordExchangeMessage({
    fromBot,
    toBot,
    text: message,
  });

  const messageCount = exchange.messages.length;
  const senderExchangeEvent = store.appendEvent(fromBot.id, {
    type: "bot_exchange",
    exchangeId: exchange.id,
    direction: "outbound",
    messageCount,
    peer: {
      id: toBot.id,
      title: toBot.title,
      avatar: toBot.avatar || null,
    },
    lastText: message,
  });

  const targetExchangeEvent = store.appendEvent(toBot.id, {
    type: "bot_exchange",
    exchangeId: exchange.id,
    direction: "inbound",
    messageCount,
    peer: {
      id: fromBot.id,
      title: fromBot.title,
      avatar: fromBot.avatar || null,
    },
    lastText: message,
  });

  const prevUnread = Number(toBot.unreadCount) || 0;
  store.updateSession(toBot.id, {
    unreadCount: prevUnread + 1,
    subtitle: `来自 ${fromBot.title}：${message.slice(0, 36)}`,
  });

  broadcastGlobal?.({ sessionId: fromBot.id, ...senderExchangeEvent });
  broadcastGlobal?.({ sessionId: toBot.id, ...targetExchangeEvent });

  let replyPromise: Promise<{
    status?: string;
    text?: string;
    error?: string;
    timedOut?: boolean;
  }> | null = null;
  let onReplyComplete:
    | ((res: { status?: string; text?: string; error?: string }) => void)
    | undefined;
  if (awaitReply && onDispatchBotTurn) {
    const timeoutMs =
      Math.max(5, Math.min(180, Math.round(Number(awaitTimeoutSec) || 60))) * 1000;
    replyPromise = new Promise((resolve) => {
      let settled = false;
      const settle = (val: {
        status?: string;
        text?: string;
        error?: string;
        timedOut?: boolean;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        resolve(val);
      };
      const timer = setTimeout(() => settle({ timedOut: true }), timeoutMs);
      const onAbort = () => settle({ status: "aborted", timedOut: true });
      if (signal?.aborted) {
        settle({ status: "aborted", timedOut: true });
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      onReplyComplete = (res) => settle(res || { status: "done", text: "" });
    });
  }

  onDispatchBotTurn?.({
    targetBotId: toBot.id,
    fromBot,
    exchangeId: exchange.id,
    message,
    hopDepth: hopDepth + 1,
    ...(onReplyComplete ? { onReplyComplete } : {}),
  });

  const baseResult: Record<string, any> = {
    exchangeId: exchange.id,
    targetBotId: toBot.id,
    targetBotName: toBot.title,
    messageCount,
  };
  recentInterBotDeliveries.set(pairKey, {
    at: nowMs,
    message,
    result: baseResult,
  });

  if (replyPromise) {
    const awaited = await replyPromise;
    return {
      ...baseResult,
      awaitReply: true,
      timedOut: Boolean(awaited.timedOut),
      ...(awaited.status ? { replyStatus: awaited.status } : {}),
      ...(awaited.text !== undefined ? { replyText: awaited.text } : {}),
      ...(awaited.error ? { replyError: awaited.error } : {}),
    };
  }

  return baseResult;
}

