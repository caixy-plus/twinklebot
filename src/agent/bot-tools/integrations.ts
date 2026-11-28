import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferImageMimeType } from "../model.js";
import { executeImageGenerationWithFallback } from "../image-fallback.js";
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
  isPathInsideBotAccessibleRoots,
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
  parseWhitelistIds,
  summarizeChannelStatusForBot,
} from "../../lib/channel-integrations.js";
import { resolveBotByRef } from "./collab-tools.js";
import {
  upsertMailAccount,
  findMailAccount,
  setDefaultMailAccount,
  removeMailAccount,
} from "../../lib/mail-accounts.js";
import {
  MAX_BOT_HOPS,
  SKILL_NOT_ADDED_ERROR,
  getInstalledSkillIds,
} from "./declarations.js";

export const UNHANDLED_BOT_TOOL = Symbol.for("twinklebot.unhandled_bot_tool");

const VALID_ASPECT_RATIOS = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9",
]);

function extFromMime(mimeType = "") {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("svg")) return ".svg";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("bmp")) return ".bmp";
  if (m.includes("icon") || m.includes("ico")) return ".ico";
  if (m.includes("pdf")) return ".pdf";
  return ".png";
}

export function saveGeneratedImageFile({
  base64Data = "",
  mimeType = "image/png",
  title = "AI 生成图片",
  workspaceRoot,
}: {
  base64Data?: string;
  mimeType?: string;
  title?: string;
  workspaceRoot?: string;
} = {}) {
  const root =
    workspaceRoot || path.join(os.tmpdir(), "twinklebot-generated");
  const genDir = path.join(root, "generated");
  fs.mkdirSync(genDir, { recursive: true });

  const resolvedMime = inferImageMimeType(base64Data, mimeType);
  const ext = extFromMime(resolvedMime);
  const rawSlug = String(title || "generated_image")
    .trim()
    .slice(0, 42)
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safeSlug = rawSlug || "generated_image";
  const fileName = `${Date.now()}_${safeSlug}${ext}`;
  const destPath = path.join(genDir, fileName);
  const buf = Buffer.from(base64Data, "base64");
  fs.writeFileSync(destPath, buf);

  const displayName = `${safeSlug}${ext}`;
  const url = `/api/workspace/file?path=${encodeURIComponent(destPath)}`;
  return {
    name: displayName,
    path: destPath,
    size: buf.length,
    mimeType: resolvedMime,
    url,
    markdown: `[图片附件: ${displayName}](${url})`,
  };
}

const VALID_SHAPES = [
  "blob",
  "cloud",
  "square",
  "sparkle",
  "clover",
  "heart",
  "flower",
  "teardrop",
  "tablet",
  "wedge",
  "house",
  "star",
  "hex",
];

const VALID_COLORS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
];

const COLORFUL_KEYS = VALID_COLORS.filter((c) => c !== "black" && c !== "gray");


function slimMailAccount(a: Record<string, any> = {}) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    label: a.label || "",
    isDefault: Boolean(a.isDefault),
    inboundProtocol: a.inboundProtocol,
    inboundHost: a.inboundHost,
    smtpHost: a.smtpHost,
  };
}

function mailSkillName(id: string) {
  return OFFICE_SKILLS.find((s) => s.id === id)?.name || id;
}

function getEnabledMailAccounts(store: any) {
  const installed = getInstalledSkillIds(store);
  const { accounts } = normalizeMailAuthStore(store?.readMailAuth?.() || {});
  return accounts.filter(
    (acct) =>
      installed.includes(acct.provider) &&
      acct.enabled !== false &&
      acct.email &&
      acct.password &&
      acct.inboundHost &&
      acct.smtpHost
  );
}

function resolveConnectedMailAccount(
  store: any,
  requestedAccount?: string
):
  | { ok: false; error: string }
  | { ok: true; accountId: string; provider: string; label: string; config: any } {
  const active = getEnabledMailAccounts(store);
  if (active.length === 0) {
    return {
      ok: false,
      error:
        "当前尚未配置可用的邮箱账号。可在左下角「技能商店」配置 QQ 邮箱或通用邮箱，也可以直接在对话里让我帮你添加（我会弹出安全卡片收集授权码）。",
    };
  }

  const needle = String(requestedAccount || "").trim();
  if (!needle) {
    const chosen = active.find((a) => a.isDefault) || active[0];
    return {
      ok: true,
      accountId: chosen.id,
      provider: chosen.provider,
      label: chosen.label || "",
      config: normalizeMailConfig(chosen, chosen.provider),
    };
  }

  const lower = needle.toLowerCase();
  const matched =
    active.find((a) => a.id === needle) ||
    active.find((a) => a.email.toLowerCase() === lower) ||
    active.find((a) => a.label && a.label.toLowerCase() === lower) ||
    active.find((a) => a.provider === lower && a.isDefault) ||
    active.find((a) => a.provider === lower) ||
    active.find(
      (a) =>
        a.email.toLowerCase().includes(lower) ||
        (a.label && a.label.toLowerCase().includes(lower))
    );

  if (!matched) {
    const available = active
      .map((a) => `${a.email}${a.label ? ` (${a.label})` : ""}`)
      .join("、");
    return {
      ok: false,
      error: `未找到匹配的已连接邮箱「${needle}」。当前可用邮箱：${available}`,
    };
  }

  return {
    ok: true,
    accountId: matched.id,
    provider: matched.provider,
    label: matched.label || "",
    config: normalizeMailConfig(matched, matched.provider),
  };
}

function isMailSendAllowlisted(store: any, args: Record<string, any> = {}) {
  const policy = store?.readSettings?.()?.policy;
  if (!policy || policy.autoAudit === false) return false;
  const allowRules = Array.isArray(policy.allowRules) ? policy.allowRules : [];
  const haystack = `mail_send_message ${JSON.stringify(args)}`.toLowerCase();
  return allowRules.some((r: any) => {
    if (!r || typeof r !== "object") return false;
    const tool = String(r.tool || "").trim();
    if (tool !== "mail_send_message") return false;
    const pat = String(r.pattern || "").trim().toLowerCase();
    return !pat || haystack.includes(pat);
  });
}

export async function handleIntegrationBotTool(
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
    channelPairingActions,
    channelConfigActions,
    userMeta,
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

  if (name === "generate_image") {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) {
      return { error: "generate_image requires a non-empty prompt" };
    }
    if (!model) {
      return { error: "model adapter unavailable" };
    }

    const aspectRatio = VALID_ASPECT_RATIOS.has(args.aspect_ratio)
      ? args.aspect_ratio
      : "1:1";
    const quality = args.quality === "pro" ? "pro" : "standard";
    const configuredImage = config?.routing?.tiers?.image;

    const workspaceSessionId = String(senderSessionId || senderBot?.id || "").trim();
    const referenceImages: any[] = [];
    if (args.reference_image_path && String(args.reference_image_path).trim()) {
      const refPath = String(args.reference_image_path).trim();
      if (!isPathInsideBotAccessibleRoots(refPath, { config, sessionId: workspaceSessionId })) {
        return {
          error: `reference_image_path denied: path must reside inside workspace writeRoots`,
        };
      }
      const resolvedRef = path.resolve(refPath);
      if (!fs.existsSync(resolvedRef) || !fs.statSync(resolvedRef).isFile()) {
        return { error: `reference_image_path not found: ${refPath}` };
      }
      const refB64 = fs.readFileSync(resolvedRef).toString("base64");
      referenceImages.push({
        data: refB64,
        mimeType: inferImageMimeType(refB64),
      });
    }

    try {
      const genRes = await executeImageGenerationWithFallback({
        model,
        prompt,
        title: args.title || "",
        aspectRatio,
        quality,
        imageSize: args.image_size,
        outputFormat: args.output_format || "",
        referenceImages,
        config,
        activeLlmModel: ctx.activeLlmModel || "",
        fallbackLlmModel: ctx.fallbackLlmModel || "",
        executor,
        signal: control?.signal,
      });

      if (
        genRes.usage &&
        (genRes.usage.input > 0 || genRes.usage.output > 0)
      ) {
        emit?.({
          type: "usage",
          model: genRes.usedModel,
          ...(genRes.usedProviderId ? { providerId: genRes.usedProviderId } : {}),
          routeTier: genRes.degraded ? "standard" : "image",
          routeLabel: genRes.degraded
            ? `图像降级 (SVG) · ${genRes.usedModel}`
            : configuredImage?.model
              ? `图像生成 · ${configuredImage.model}`
              : quality === "pro"
                ? "图像生成 · 高清模式"
                : "图像生成 · 标准模式",
          ...genRes.usage,
        });
      }

      const targetWorkspaceRoot = resolveBotWorkspaceRoot({
        config,
        sessionId: workspaceSessionId,
        fallbackDir: path.join(os.tmpdir(), "twinklebot-generated"),
      });
      const saved = saveGeneratedImageFile({
        base64Data: genRes.base64Data,
        mimeType: genRes.mimeType,
        title: args.title || prompt.slice(0, 24),
        workspaceRoot: targetWorkspaceRoot,
      });

      if (workspaceSessionId) {
        broadcastGlobal?.({
          type: "library_updated",
          sessionId: workspaceSessionId,
        });
      }

      if (typeof ctx.onImageGenerated === "function") {
        ctx.onImageGenerated({
          saved,
          genRes,
        });
      }

      return {
        ok: true,
        model: genRes.usedModel,
        title: saved.name,
        path: saved.path,
        size: saved.size,
        url: saved.url,
        mime_type: saved.mimeType,
        output_format: genRes.outputFormat,
        aspect_ratio: aspectRatio,
        markdown: saved.markdown,
        degraded: genRes.degraded,
        ...(genRes.degraded
          ? {
              fallback_mode: genRes.fallbackMode,
              degraded_reason: genRes.degradedReason,
              fallback_notice: genRes.fallbackNotice,
              converted_from_svg: Boolean(genRes.convertedFromSvg),
              ...(genRes.converter ? { converter: genRes.converter } : {}),
              ...(genRes.conversionWarning
                ? { conversion_warning: genRes.conversionWarning }
                : {}),
              instruction:
                "本次生图已自动降级为大语言模型代码生成 SVG。请在最终回复中内嵌 markdown 预览，并明确告知用户发生了降级及 degraded_reason 中的降级原因。",
            }
          : {}),
      };
    } catch (err: any) {
      if (control?.signal?.aborted || err?.name === "AbortError") {
        throw err;
      }
      return {
        error: `image generation failed: ${err?.message || String(err)}`,
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
    case "mail_list_accounts": {
      const active = getEnabledMailAccounts(store);
      return {
        ok: true,
        count: active.length,
        accounts: active.map((a) => ({
          id: a.id,
          provider: a.provider,
          label: a.label || (a.provider === "qqmail" ? "QQ 邮箱" : "通用邮箱"),
          email: a.email,
          senderName: a.senderName || "",
          inboundProtocol: a.inboundProtocol,
          isDefault: Boolean(a.isDefault),
        })),
      };
    }

    case "mail_list_messages": {
      const resolved = resolveConnectedMailAccount(store, args.account);
      if (!resolved.ok) return { error: resolved.error };
      try {
        const messages = await listMailMessages(resolved.config, {
          limit: args.limit,
          unseenOnly: Boolean(args.unseen_only),
          query: args.query || "",
        });
        return {
          ok: true,
          accountId: resolved.accountId,
          account: resolved.provider,
          label: resolved.label,
          email: resolved.config.email,
          protocol: resolved.config.inboundProtocol,
          count: messages.length,
          messages,
        };
      } catch (err: any) {
        return { error: `读取邮件列表失败: ${err?.message || String(err)}` };
      }
    }

    case "mail_read_message": {
      const resolved = resolveConnectedMailAccount(store, args.account);
      if (!resolved.ok) return { error: resolved.error };
      try {
        const message = await readMailMessage(resolved.config, {
          uid: args.uid,
        });
        return {
          ok: true,
          accountId: resolved.accountId,
          account: resolved.provider,
          label: resolved.label,
          email: resolved.config.email,
          message,
        };
      } catch (err: any) {
        return { error: `读取邮件正文失败: ${err?.message || String(err)}` };
      }
    }

    case "mail_send_message": {
      const resolved = resolveConnectedMailAccount(store, args.account);
      if (!resolved.ok) return { error: resolved.error };

      let finalTo = String(args.to || "").trim();
      const finalCc = String(args.cc || "").trim();
      let finalSubject = String(args.subject || "").trim();
      let finalBody = String(args.body || "");

      if (!finalTo || !finalSubject) {
        return { error: "mail_send_message 需要提供有效的收件人 (to) 与主题 (subject)" };
      }

      if (!isMailSendAllowlisted(store, args)) {
        if (!control?.requestChoice) {
          return {
            error:
              "后台或非交互上下文中禁止自动外发邮件；请在对话界面确认草稿，或在「设置 -> 权限」中显式允许 mail_send_message。",
          };
        }

        const draftPromise = control.requestChoice(callId);
        emit?.({
          type: "draft_request",
          callId,
          title: finalSubject,
          recipient: finalCc ? `${finalTo} (抄送: ${finalCc})` : finalTo,
          fromEmail: resolved.config.email,
          content: finalBody,
          kind: "email",
        });
        emit?.({ type: "status", status: "awaiting_choice" });

        const resolution = await draftPromise;
        if (resolution === null || control.stopped) {
          emit?.({ type: "choice_superseded", callId });
          return { error: "邮件发送草稿已取消" };
        }

        const approved =
          typeof resolution === "object" && resolution !== null
            ? resolution.approved !== false
            : Boolean(resolution);
        if (typeof resolution === "object" && resolution !== null) {
          if (resolution.title !== undefined) {
            finalSubject = String(resolution.title).trim() || finalSubject;
          }
          if (resolution.recipient !== undefined) {
            const rawRcpt = String(resolution.recipient).replace(/\(抄送:.*\)$/, "").trim();
            if (rawRcpt) finalTo = rawRcpt;
          }
          if (resolution.content !== undefined) {
            finalBody = String(resolution.content);
          }
        }

        emit?.({
          type: "draft_resolved",
          callId,
          approved,
          title: finalSubject,
          recipient: finalTo,
          fromEmail: resolved.config.email,
          content: finalBody,
        });
        emit?.({ type: "status", status: "running" });

        if (!approved) {
          return { ok: false, approved: false, reason: "用户取消了该封邮件的发送" };
        }
      }

      try {
        const sent = await sendMailMessage(resolved.config, {
          to: finalTo,
          cc: finalCc,
          subject: finalSubject,
          text: finalBody,
        });
        return {
          ...sent,
          ok: true,
          accountId: resolved.accountId,
          account: resolved.provider,
          label: resolved.label,
        };
      } catch (err: any) {
        return { error: `发送邮件失败: ${err?.message || String(err)}` };
      }
    }

    case "skill_list": {
      const installed = getInstalledSkillIds(store);
      const { accounts } = normalizeMailAuthStore(store.readMailAuth?.() || {});
      const channelStatus = summarizeChannelStatusForBot(
        typeof getChannelStatus === "function" ? getChannelStatus() : null
      );
      return {
        ok: true,
        platform: PLATFORM_SKILLS.map((s) => {
          const isBuiltin = s.builtin !== false;
          const isInstalled = isBuiltin ? true : installed.includes(s.id);
          return {
            id: s.id,
            name: s.name,
            desc: s.desc,
            installed: isInstalled,
            removable: !isBuiltin,
            status: isBuiltin
              ? "内置常驻"
              : isInstalled
                ? "已添加"
                : "未添加（需在技能商店手动添加）",
            ...(channelStatus[s.id] ? { channel: channelStatus[s.id] } : {}),
          };
        }),
        office: OFFICE_SKILLS.map((s) => {
          const isInstalled = installed.includes(s.id);
          const mine = accounts.filter((a) => a.provider === s.id);
          return {
            id: s.id,
            name: s.name,
            installed: isInstalled,
            accountCount: isInstalled ? mine.length : 0,
            accounts: isInstalled ? mine.map(slimMailAccount) : [],
          };
        }),
      };
    }

    case "channel_pairing_manage": {
      const action = String(args.action || "").trim();
      const installed = getInstalledSkillIds(store);
      if (!installed.includes("feishu-bot") && !installed.includes("telegram-bot")) {
        return { ok: false, error: SKILL_NOT_ADDED_ERROR };
      }
      if (!channelPairingActions) {
        return { ok: false, error: "当前运行时未挂载渠道配对管理器" };
      }
      const mutating = action !== "list";
      if (mutating && userMeta?.channelMeta) {
        return {
          ok: false,
          error:
            "出于安全限制，配对审批与访问控制仅允许在 TwinkleBot App 内由主人操作，不能通过外部飞书/Telegram 对话触发。",
        };
      }

      const selfBotId = senderBot?.id || senderSessionId || "";
      const callerIsAdmin = Boolean(
        senderBot?.isAdmin || (selfBotId && store?.getSession?.(selfBotId)?.isAdmin)
      );

      if (action === "list") {
        const channelFilter =
          args.channel === "feishu-bot" || args.channel === "telegram-bot"
            ? args.channel
            : undefined;
        const accountFilter = args.account_id ? String(args.account_id).trim() : undefined;
        const listed = channelPairingActions.listPairings?.({
          ...(channelFilter ? { channel: channelFilter } : {}),
          ...(accountFilter ? { accountId: accountFilter } : {}),
        }) || { pending: [], approved: [] };
        return {
          ok: true,
          action: "list",
          pending: listed.pending || [],
          approved: listed.approved || [],
        };
      }

      if (action === "approve" || action === "reject") {
        const code = String(args.code || "").trim();
        if (!code) {
          return { ok: false, error: `${action} 操作需要提供 6 位配对码 code` };
        }
        const curList = channelPairingActions.listPairings?.() || { pending: [] };
        const matchedPending = (curList.pending || []).find(
          (p: any) => String(p.code || "").trim() === code
        );
        if (
          matchedPending &&
          !callerIsAdmin &&
          matchedPending.defaultSessionId !== selfBotId
        ) {
          return {
            ok: false,
            error:
              "权限不足：该配对码对应的机器人未绑定到当前 Bot，请在管理员 Bot（Twinkle）或绑定该机器人的 Bot 中审批，或前往技能商店操作。",
          };
        }
        const res =
          action === "approve"
            ? channelPairingActions.approvePairing?.(code, { notifyChat: true })
            : channelPairingActions.rejectPairing?.(code);
        if (!res?.ok) {
          return { ok: false, error: res?.error || `配对码 ${code} 操作失败` };
        }
        broadcastGlobal?.({ type: "skills_updated" });
        return { ok: true, action, ...res };
      }

      if (action === "suspend" || action === "resume" || action === "delete") {
        const channelId =
          args.channel === "feishu-bot" || args.channel === "telegram-bot"
            ? args.channel
            : "";
        const chatId = String(args.chat_id || "").trim();
        const accountId = String(args.account_id || "").trim();
        if (!channelId || !chatId) {
          return {
            ok: false,
            error: `${action} 操作需要提供 channel ('feishu-bot' | 'telegram-bot') 和 chat_id`,
          };
        }
        if (!callerIsAdmin) {
          const curStatus = summarizeChannelStatusForBot(
            typeof getChannelStatus === "function" ? getChannelStatus() : null
          );
          const accts: any[] = curStatus?.[channelId]?.accounts || [];
          const targetAcct = accountId
            ? accts.find((a) => a.id === accountId)
            : accts.find((a) =>
                (a.approvedChats || []).some(
                  (c: any) => c.chatId === chatId || c.senderId === chatId
                )
              );
          if (!targetAcct || targetAcct.defaultSessionId !== selfBotId) {
            return {
              ok: false,
              error:
                "权限不足：仅管理员 Bot 或该渠道绑定的目标 Bot 可管理此会话授权。",
            };
          }
        }
        const res =
          action === "delete"
            ? channelPairingActions.deleteApproval?.(channelId, accountId, chatId)
            : channelPairingActions.setApprovalEnabled?.(
                channelId,
                accountId,
                chatId,
                action === "resume"
              );
        if (!res?.ok) {
          return { ok: false, error: res?.error || "操作失败" };
        }
        broadcastGlobal?.({ type: "skills_updated" });
        return { ok: true, action, channel: channelId, accountId, chatId, ...res };
      }

      return { ok: false, error: `未知 channel_pairing_manage 操作: ${action}` };
    }

    case "custom_skill_manage": {
      const action = String(args.action || "").trim();
      const selector = String(args.skill || args.id || args.name || "").trim();
      const targetBotId = senderBot?.id || senderSessionId || "";
      const botSession = targetBotId ? store.getSession?.(targetBotId) : null;
      const creatorBotName = senderBot?.title || botSession?.title || "TwinkleBot";

      const slimSkillSummary = (s: any) => ({
        id: s.id,
        name: s.name,
        icon: s.icon || "⚡",
        description: s.description,
        enabled: s.enabled !== false,
        scope: s.scope || "global",
        ...(Array.isArray(s.triggers) && s.triggers.length > 0 ? { triggers: s.triggers } : {}),
        ...(Array.isArray(s.scripts) && s.scripts.length > 0 ? { scripts: s.scripts } : {}),
        createdBy: s.createdBy || "user",
        ...(s.createdByBotId ? { createdByBotId: s.createdByBotId } : {}),
        ...(s.createdByBotName ? { createdByBotName: s.createdByBotName } : {}),
        updatedAt: s.updatedAt || null,
      });

      const notifySkillsUpdated = () => {
        broadcastGlobal?.({ type: "skills_updated" });
      };

      if (action === "list") {
        const list = store.listCustomSkills?.({
          query: String(args.query || "").trim(),
          enabledOnly: false,
          ...(typeof args.scope === "string" && args.scope.trim() && args.scope.trim() !== "all"
            ? { botId: args.scope.trim() === "global" ? "__global_only__" : args.scope.trim() }
            : {}),
        }) || [];
        const filteredList =
          String(args.scope || "").trim() === "global"
            ? list.filter((s: any) => !s.scope || s.scope === "global")
            : list;
        return {
          ok: true,
          count: filteredList.length,
          enabledCount: filteredList.filter((s: any) => s.enabled !== false).length,
          skills: filteredList.map(slimSkillSummary),
        };
      }

      if (action === "get") {
        if (!selector) {
          return { ok: false, error: "get 操作需要提供 skill 或 id" };
        }
        const found = store.getCustomSkill?.(selector);
        if (!found) {
          return { ok: false, error: `未找到匹配的自定义技能「${selector}」` };
        }
        return {
          ok: true,
          skill: {
            ...slimSkillSummary(found),
            instructions: found.instructions,
            filePath: found.filePath,
          },
        };
      }

      if (action === "create") {
        const name = String(args.name || "").trim();
        const description = String(args.description || "").trim();
        const instructions = String(args.instructions || "").trim();
        if (!name || !description || !instructions) {
          return {
            ok: false,
            error: "创建自定义技能必须提供 name、description 和 instructions（完整 SKILL.md 步骤）",
          };
        }
        try {
          const saved = store.saveCustomSkill?.({
            id: args.id ? String(args.id).trim() : undefined,
            mode: "create",
            name,
            icon: args.icon ? String(args.icon).trim() : undefined,
            description,
            instructions,
            ...(args.scope !== undefined ? { scope: String(args.scope).trim() } : {}),
            ...(args.triggers !== undefined ? { triggers: args.triggers } : {}),
            enabled: typeof args.enabled === "boolean" ? args.enabled : true,
            createdBy: botSession ? "bot" : "user",
            createdByBotId: botSession?.id || targetBotId || "",
            createdByBotName: botSession ? creatorBotName : "",
          });
          notifySkillsUpdated();
          return {
            ok: true,
            created: true,
            skill: {
              ...slimSkillSummary(saved),
              instructions: saved.instructions,
              filePath: saved.filePath,
            },
          };
        } catch (err: any) {
          return { ok: false, error: err?.message || "创建自定义技能失败" };
        }
      }

      if (action === "update") {
        if (!selector) {
          return { ok: false, error: "update 操作需要提供要修改的 skill 或 id" };
        }
        const existing = store.getCustomSkill?.(selector);
        if (!existing) {
          return { ok: false, error: `未找到匹配的自定义技能「${selector}」` };
        }
        try {
          const saved = store.saveCustomSkill?.({
            id: existing.id,
            mode: "update",
            newId: args.newId ? String(args.newId).trim() : undefined,
            name: args.name !== undefined ? String(args.name).trim() : undefined,
            icon: args.icon !== undefined ? String(args.icon).trim() : undefined,
            description: args.description !== undefined ? String(args.description).trim() : undefined,
            instructions: args.instructions !== undefined ? String(args.instructions).trim() : undefined,
            ...(args.scope !== undefined ? { scope: String(args.scope).trim() } : {}),
            ...(args.triggers !== undefined ? { triggers: args.triggers } : {}),
            enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
          });
          notifySkillsUpdated();
          return {
            ok: true,
            updated: true,
            skill: {
              ...slimSkillSummary(saved),
              instructions: saved.instructions,
              filePath: saved.filePath,
            },
          };
        } catch (err: any) {
          return { ok: false, error: err?.message || "更新自定义技能失败" };
        }
      }

      if (action === "save_script") {
        if (!selector) {
          return { ok: false, error: "save_script 操作需要提供 skill 或 id" };
        }
        const scriptName = String(args.script_name || "").trim();
        const scriptContent = args.script_content;
        if (!scriptName || typeof scriptContent !== "string") {
          return { ok: false, error: "save_script 需要提供 script_name 与 script_content" };
        }
        try {
          const res = store.saveCustomSkillScript?.(selector, scriptName, scriptContent);
          notifySkillsUpdated();
          return {
            ok: true,
            savedScript: true,
            script: res?.script,
            skill: slimSkillSummary(res?.skill),
          };
        } catch (err: any) {
          return { ok: false, error: err?.message || "保存技能脚本失败" };
        }
      }

      if (action === "read_script") {
        if (!selector || !args.script_name) {
          return { ok: false, error: "read_script 需要提供 skill 与 script_name" };
        }
        try {
          const res = store.readCustomSkillScript?.(selector, String(args.script_name).trim());
          return { ok: true, ...res };
        } catch (err: any) {
          return { ok: false, error: err?.message || "读取技能脚本失败" };
        }
      }

      if (action === "delete_script") {
        if (!selector || !args.script_name) {
          return { ok: false, error: "delete_script 需要提供 skill 与 script_name" };
        }
        try {
          const res = store.deleteCustomSkillScript?.(selector, String(args.script_name).trim());
          notifySkillsUpdated();
          return {
            ok: true,
            deleted: Boolean(res?.deleted),
            skill: slimSkillSummary(res?.skill),
          };
        } catch (err: any) {
          return { ok: false, error: err?.message || "删除技能脚本失败" };
        }
      }

      if (action === "toggle") {
        if (!selector) {
          return { ok: false, error: "toggle 操作需要提供 skill 或 id" };
        }
        const existing = store.getCustomSkill?.(selector);
        if (!existing) {
          return { ok: false, error: `未找到匹配的自定义技能「${selector}」` };
        }
        const nextEnabled =
          typeof args.enabled === "boolean" ? args.enabled : existing.enabled === false;
        const saved = store.toggleCustomSkill?.(existing.id, nextEnabled);
        notifySkillsUpdated();
        return {
          ok: true,
          toggled: true,
          skill: slimSkillSummary(saved),
        };
      }

      if (action === "delete") {
        if (!selector) {
          return { ok: false, error: "delete 操作需要提供 skill 或 id" };
        }
        const existing = store.getCustomSkill?.(selector);
        if (!existing) {
          return { ok: false, error: `未找到匹配的自定义技能「${selector}」` };
        }
        const removed = store.deleteCustomSkill?.(existing.id);
        notifySkillsUpdated();
        return {
          ok: true,
          deleted: Boolean(removed),
          id: existing.id,
          name: existing.name,
        };
      }

      return { ok: false, error: `未知的 custom_skill_manage action: ${action}` };
    }

    case "skill_configure_mail": {
      const installed = getInstalledSkillIds(store);
      const verifyFn = ctx.verifyMailFn || verifyMailConnection;
      const action = String(args.action || "");
      const { accounts: allAccounts } = normalizeMailAuthStore(store.readMailAuth?.() || {});

      let target: any = null;
      if (args.account) {
        target = findMailAccount(allAccounts, args.account, { providers: installed });
        if (!target) {
          const dormant = findMailAccount(allAccounts, args.account);
          if (dormant) return { ok: false, error: SKILL_NOT_ADDED_ERROR };
          if (action !== "upsert_account") {
            return { ok: false, error: `未找到匹配的邮箱账号「${args.account}」` };
          }
        }
      }

      if (action === "set_default" || action === "test_account" || action === "remove_account") {
        if (!target) return { ok: false, error: "请通过 account 指定要操作的邮箱账号（邮箱地址、备注或 ID）" };
        if (action === "set_default") {
          const r = setDefaultMailAccount(store, target.id);
          if (!r.ok) return { ok: false, error: r.error };
          broadcastGlobal?.({ type: "skills_updated" });
          return { ok: true, action, account: slimMailAccount({ ...target, isDefault: true }) };
        }
        if (action === "remove_account") {
          const r = removeMailAccount(store, target.id);
          if (!r.ok) return { ok: false, error: r.error };
          broadcastGlobal?.({ type: "skills_updated" });
          return { ok: true, action, removed: slimMailAccount(target) };
        }
        try {
          const cfg = normalizeMailConfig(target, target.provider);
          const v = await verifyFn(cfg);
          let testMailSent = false;
          if (args.send_test_mail) {
            await sendMailMessage(cfg, {
              to: cfg.email,
              subject: "TwinkleBot 邮箱连接测试成功",
              text: "你好！这是一封来自本地 TwinkleBot 对话配置的连通性测试邮件。",
            });
            testMailSent = true;
          }
          return {
            ok: true,
            action,
            account: slimMailAccount(target),
            messages: v.messages,
            ...(v.unseen !== undefined ? { unseen: v.unseen } : {}),
            latencyMs: v.latencyMs,
            testMailSent,
          };
        } catch (err: any) {
          return { ok: false, action, error: `连通性测试失败：${err?.message || String(err)}` };
        }
      }

      if (action !== "upsert_account") {
        return { ok: false, error: `unknown action: ${action}` };
      }

      const skillId = target?.provider || args.skill_id;
      if (!MAIL_SKILL_IDS.includes(skillId)) {
        return { ok: false, error: "请指定 skill_id（qqmail 或 custom-mail）" };
      }
      if (!installed.includes(skillId)) return { ok: false, error: SKILL_NOT_ADDED_ERROR };

      const email = String(args.email || target?.email || "").trim();
      if (!target && email) {
        target =
          allAccounts.find(
            (a) => a.provider === skillId && a.email.toLowerCase() === email.toLowerCase()
          ) || null;
      }

      const body: Record<string, any> = { provider: skillId, email };
      if (args.label !== undefined) body.label = args.label;
      if (args.sender_name !== undefined) body.senderName = args.sender_name;
      if (args.inbound_protocol) body.inboundProtocol = args.inbound_protocol;
      if (args.inbound_host) body.inboundHost = args.inbound_host;
      if (args.inbound_port) body.inboundPort = Number(args.inbound_port);
      if (args.inbound_tls !== undefined) body.inboundTls = Boolean(args.inbound_tls);
      if (args.smtp_host) body.smtpHost = args.smtp_host;
      if (args.smtp_port) body.smtpPort = Number(args.smtp_port);
      if (args.smtp_security) body.smtpSecurity = args.smtp_security;
      if (args.is_default !== undefined) body.isDefault = Boolean(args.is_default);

      if (skillId === "custom-mail" && !target && !body.inboundHost) {
        const preset = inferMailServerPreset(email, body.inboundProtocol || "imap");
        if (preset) {
          body.inboundProtocol = preset.inboundProtocol;
          body.inboundHost = preset.inboundHost;
          body.inboundPort = body.inboundPort || preset.inboundPort;
          body.inboundTls = preset.inboundTls;
          body.smtpHost = body.smtpHost || preset.smtpHost;
          body.smtpPort = body.smtpPort || preset.smtpPort;
          body.smtpSecurity = body.smtpSecurity || preset.smtpSecurity;
        }
      }

      let secret = String(args.secret || "").replace(/\s+/g, "");
      const serviceTitle = `${mailSkillName(skillId)} · ${email}`;
      let usedCard = false;

      if (!secret && !target) {
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return { ok: false, error: "请提供有效的邮箱地址（email）" };
        }
        if (!control?.requestChoice) {
          return { ok: false, error: "需要在对话界面中通过安全卡片输入授权码，当前上下文不支持交互输入" };
        }
        const credPromise = control.requestChoice(callId);
        emit?.({
          type: "credential_request",
          callId,
          service: serviceTitle,
          label:
            skillId === "qqmail"
              ? "请输入该 QQ 邮箱的 16 位授权码（QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP 服务后生成），仅加密保存在本机，不会出现在聊天记录中。"
              : "请输入该邮箱的登录密码或客户端授权码，仅加密保存在本机，不会出现在聊天记录中。",
          fieldType: "password",
          hideVaultCheckbox: true,
        });
        emit?.({ type: "status", status: "awaiting_choice" });
        const credRes = await credPromise;
        if (credRes === null || control.stopped) {
          emit?.({ type: "choice_superseded", callId });
          return { ok: false, error: "授权码输入已取消" };
        }
        secret = String(
          typeof credRes === "object" && credRes !== null ? credRes.value || "" : credRes || ""
        ).replace(/\s+/g, "");
        usedCard = true;
        if (!secret) {
          emit?.({
            type: "credential_resolved",
            callId,
            service: serviceTitle,
            submitted: false,
            resolvedText: `✕ 已跳过 ${serviceTitle} 的授权码输入`,
          });
          emit?.({ type: "status", status: "running" });
          return { ok: false, error: "用户跳过了授权码输入，账号未保存" };
        }
      }

      if (secret) body.password = secret;
      const result = await upsertMailAccount(store, body, {
        forcedProvider: skillId,
        explicitId: target?.id || null,
        verify: Boolean(secret) || !target,
        verifyFn,
      });

      if (usedCard) {
        emit?.({
          type: "credential_resolved",
          callId,
          service: serviceTitle,
          submitted: true,
          resolvedText: result.ok
            ? `🔒 已连接 ${serviceTitle}`
            : `⚠️ ${serviceTitle} 验证未通过`,
        });
        emit?.({ type: "status", status: "running" });
      }

      if (!result.ok) return { ok: false, action, error: result.error };
      broadcastGlobal?.({ type: "skills_updated" });
      return {
        ok: true,
        action,
        created: result.created,
        account: slimMailAccount(result.record),
        ...(result.inboxStats ? { inbox: result.inboxStats } : {}),
      };
    }

    case "skill_configure_channel": {
      const action = String(args.action || "").trim();
      const rawStatus =
        typeof getChannelStatus === "function" ? getChannelStatus() : null;
      const summaryMap = summarizeChannelStatusForBot(rawStatus);
      const sessions = store?.listSessions?.() || [];
      const resolveSessionLabel = (sid?: string | null) => {
        const clean = String(sid || "").trim();
        if (!clean) return "主管理员 Bot（Twinkle）";
        const found = sessions.find((s: any) => s && s.id === clean);
        return found?.title || clean;
      };

      const getConfiguredAccounts = (cid: "feishu-bot" | "telegram-bot"): any[] => {
        const rawEntry = rawStatus?.[cid];
        const summaryEntry = summaryMap?.[cid];
        const summaryAccounts: any[] = Array.isArray(summaryEntry?.accounts)
          ? summaryEntry.accounts
          : [];
        if (Array.isArray(rawEntry?.accounts)) {
          if (rawEntry.accounts.length === 0) return [];
          const realIds = new Set(rawEntry.accounts.map((a: any) => String(a?.id || "")));
          return summaryAccounts.filter((a: any) => realIds.has(String(a?.id || "")));
        }
        return summaryEntry?.configured ? summaryAccounts : [];
      };

      if (action === "list") {
        const enrichAccounts = (cid: "feishu-bot" | "telegram-bot") =>
          getConfiguredAccounts(cid).map((a: any) => ({
            ...a,
            targetBotTitle: resolveSessionLabel(a.defaultSessionId),
          }));
        return {
          ok: true,
          action: "list",
          "feishu-bot": summaryMap?.["feishu-bot"]
            ? {
                ...summaryMap["feishu-bot"],
                accounts: enrichAccounts("feishu-bot"),
              }
            : null,
          "telegram-bot": summaryMap?.["telegram-bot"]
            ? {
                ...summaryMap["telegram-bot"],
                accounts: enrichAccounts("telegram-bot"),
              }
            : null,
        };
      }

      if (userMeta?.channelMeta) {
        return {
          ok: false,
          error:
            "出于安全限制，飞书/Telegram 渠道凭据、白名单与路由配置仅允许在 TwinkleBot App 内由主人操作，禁止从外部聊天渠道修改。",
        };
      }

      if (!channelConfigActions) {
        return { ok: false, error: "当前运行时未挂载渠道配置控制器" };
      }

      const selfBotId = senderBot?.id || senderSessionId || "";
      const callerIsAdmin = Boolean(
        senderBot?.isAdmin || (selfBotId && store?.getSession?.(selfBotId)?.isAdmin)
      );

      // Infer platform when omitted
      let channelId: "feishu-bot" | "telegram-bot" | "" =
        args.channel === "feishu-bot" || args.channel === "telegram-bot"
          ? args.channel
          : "";
      if (!channelId) {
        if (
          args.app_id ||
          args.app_secret ||
          args.domain ||
          args.verification_token ||
          args.encrypt_key
        ) {
          channelId = "feishu-bot";
        } else if (args.bot_token || args.proxy || args.webhook_secret || args.clear_proxy) {
          channelId = "telegram-bot";
        } else if (args.account_id) {
          const needle = String(args.account_id).trim().toLowerCase();
          const fsMatches = getConfiguredAccounts("feishu-bot").some(
            (a: any) =>
              a.id === args.account_id ||
              String(a.label || "").toLowerCase() === needle ||
              String(a.appId || "").toLowerCase() === needle
          );
          const tgMatches = getConfiguredAccounts("telegram-bot").some(
            (a: any) =>
              a.id === args.account_id ||
              String(a.label || "").toLowerCase() === needle
          );
          if (fsMatches && !tgMatches) channelId = "feishu-bot";
          else if (tgMatches && !fsMatches) channelId = "telegram-bot";
        }
      }
      if (!channelId) {
        return {
          ok: false,
          error: "请指定 channel（'feishu-bot' 或 'telegram-bot'）",
        };
      }

      const existingAccounts: any[] = getConfiguredAccounts(channelId);
      const accountSelector = String(args.account_id || "").trim();
      let targetAcct: any = null;
      if (accountSelector) {
        const lower = accountSelector.toLowerCase();
        targetAcct =
          existingAccounts.find((a) => a.id === accountSelector) ||
          existingAccounts.find((a) => String(a.appId || "") === accountSelector) ||
          existingAccounts.find((a) => String(a.label || "").toLowerCase() === lower) ||
          null;
        if (!targetAcct) {
          const canCreateWithExplicitId =
            action === "upsert" &&
            (Boolean(args.create_new) ||
              (channelId === "feishu-bot" && Boolean(args.app_id || args.app_secret)) ||
              (channelId === "telegram-bot" && Boolean(args.bot_token)));
          if (!canCreateWithExplicitId) {
            return {
              ok: false,
              error: `未在 ${channelId} 中找到匹配的机器人实例「${accountSelector}」`,
            };
          }
        }
      } else if (!args.create_new) {
        if (args.app_id && channelId === "feishu-bot") {
          targetAcct =
            existingAccounts.find((a) => a.appId === String(args.app_id).trim()) ||
            (existingAccounts.length === 1 ? existingAccounts[0] : null);
        } else if (existingAccounts.length === 1) {
          targetAcct = existingAccounts[0];
        } else if (existingAccounts.length > 1) {
          return {
            ok: false,
            error: `${channelId} 当前已配置 ${existingAccounts.length} 个机器人，请通过 account_id 指定目标实例，或传入 create_new=true 新增：${existingAccounts
              .map((a) => `${a.label || a.appId || a.id}(${a.id})`)
              .join("、")}`,
          };
        }
      }

      const checkManagePermission = (isCreate: boolean, reroutingOther: boolean) => {
        if (callerIsAdmin) return null;
        if (isCreate || !targetAcct || targetAcct.defaultSessionId !== selfBotId) {
          return "权限不足：仅管理员 Bot（Twinkle）可新增、删除或跨 Bot 修改渠道配置；专职 Bot 仅可管理已绑定到自身的机器人实例。";
        }
        if (reroutingOther) {
          return "权限不足：非管理员 Bot 不能把渠道消息改路由给其他 Bot。";
        }
        return null;
      };

      if (action === "delete") {
        if (!targetAcct) {
          return { ok: false, error: "未找到要删除的机器人实例，请提供 account_id" };
        }
        const permErr = checkManagePermission(false, false);
        if (permErr) return { ok: false, error: permErr };
        const delRes = channelConfigActions.deleteAccount?.(channelId, targetAcct.id);
        if (!delRes?.ok) {
          return { ok: false, error: delRes?.error || "删除机器人实例失败" };
        }
        return {
          ok: true,
          action: "delete",
          channel: channelId,
          deletedAccountId: targetAcct.id,
        };
      }

      if (action === "reconnect") {
        const permErr = checkManagePermission(false, false);
        if (permErr) return { ok: false, error: permErr };
        channelConfigActions.reconnectAccount?.(channelId, targetAcct?.id);
        await new Promise((r) => setTimeout(r, 250));
        const afterMap = summarizeChannelStatusForBot(
          typeof getChannelStatus === "function" ? getChannelStatus() : null
        );
        const updatedAcct =
          afterMap?.[channelId]?.accounts?.find((a: any) => a.id === targetAcct?.id) ||
          afterMap?.[channelId]?.accounts?.[0] ||
          null;
        return {
          ok: true,
          action: "reconnect",
          channel: channelId,
          account: updatedAcct,
        };
      }

      if (action === "test") {
        const testRes = await channelConfigActions.testChannel?.(
          channelId,
          {},
          targetAcct?.id
        );
        if (!testRes) return { ok: false, error: "连通性测试未返回结果" };
        return {
          ok: Boolean(testRes.ok),
          action: "test",
          channel: channelId,
          accountId: targetAcct?.id || null,
          ...testRes,
        };
      }

      const computeNextWhitelist = (baseList: string[] = []): string[] | undefined => {
        const hasReplace = args.allowed_sender_ids !== undefined;
        const hasAdd = Array.isArray(args.add_allowed_sender_ids) && args.add_allowed_sender_ids.length > 0;
        const hasRemove =
          Array.isArray(args.remove_allowed_sender_ids) &&
          args.remove_allowed_sender_ids.length > 0;
        if (!hasReplace && !hasAdd && !hasRemove) return undefined;

        let next = hasReplace
          ? parseWhitelistIds(args.allowed_sender_ids)
          : [...baseList];
        if (hasAdd) {
          const toAdd = parseWhitelistIds(args.add_allowed_sender_ids);
          next = Array.from(new Set([...next, ...toAdd]));
        }
        if (hasRemove) {
          const rmSet = new Set(parseWhitelistIds(args.remove_allowed_sender_ids));
          next = next.filter((id) => !rmSet.has(id));
        }
        return next;
      };

      if (action === "whitelist") {
        if (!targetAcct) {
          return {
            ok: false,
            error: `尚未配置 ${channelId} 机器人实例，请先使用 action='upsert' 配置后再管理白名单。`,
          };
        }
        const permErr = checkManagePermission(false, false);
        if (permErr) return { ok: false, error: permErr };
        const nextWhitelist = computeNextWhitelist(targetAcct.allowedSenderIds || []);
        if (!nextWhitelist) {
          return {
            ok: false,
            error:
              "请提供 add_allowed_sender_ids、remove_allowed_sender_ids 或 allowed_sender_ids。",
          };
        }
        const saved = channelConfigActions.upsertAccount?.(
          channelId,
          { allowedSenderIds: nextWhitelist },
          { accountId: targetAcct.id }
        );
        if (!saved?.ok) {
          return { ok: false, error: saved?.error || "更新白名单失败" };
        }
        const afterMap = summarizeChannelStatusForBot(
          typeof getChannelStatus === "function" ? getChannelStatus() : null
        );
        const updatedAcct =
          afterMap?.[channelId]?.accounts?.find((a: any) => a.id === targetAcct.id) || null;
        return {
          ok: true,
          action: "whitelist",
          channel: channelId,
          accountId: targetAcct.id,
          allowedSenderIds: nextWhitelist,
          account: updatedAcct,
        };
      }

      if (action !== "upsert") {
        return { ok: false, error: `未知的 skill_configure_channel action: ${action}` };
      }

      // Resolve target Bot routing if supplied
      let resolvedTargetSessionId: string | undefined;
      if (args.target_bot !== undefined) {
        const rawRef = String(args.target_bot || "").trim();
        if (!rawRef || rawRef === "admin" || rawRef === "管理员") {
          const adminBot = sessions.find((s: any) => s?.isAdmin);
          resolvedTargetSessionId = adminBot?.id || "";
        } else {
          const matchedBot = resolveBotByRef(sessions, rawRef);
          if (!matchedBot) {
            return {
              ok: false,
              error: `未找到目标 Bot「${rawRef}」。当前可用 Bot：${sessions
                .map((s: any) => s.title || s.id)
                .join("、")}`,
            };
          }
          resolvedTargetSessionId = matchedBot.id;
        }
      }

      const reroutingOther = Boolean(
        resolvedTargetSessionId !== undefined && resolvedTargetSessionId !== selfBotId
      );
      const permErr = checkManagePermission(!targetAcct, reroutingOther);
      if (permErr) return { ok: false, error: permErr };

      // Ensure store skill is marked installed seamlessly
      channelConfigActions.ensureInstalled?.(channelId);

      // Handle interactive encrypted credential card when adding a NEW bot without secret
      let appSecret = args.app_secret !== undefined ? String(args.app_secret).trim() : "";
      let botToken = args.bot_token !== undefined ? String(args.bot_token).trim() : "";
      let usedCard = false;
      const appIdTrimmed = args.app_id !== undefined ? String(args.app_id).trim() : "";

      if (channelId === "feishu-bot" && !targetAcct) {
        if (!appIdTrimmed) {
          return {
            ok: false,
            error: "新增飞书机器人需要提供 app_id（如 cli_xxx）",
          };
        }
        if (!appSecret) {
          if (!control?.requestChoice) {
            return {
              ok: false,
              error: "请在 TwinkleBot App 对话中通过安全卡片输入 App Secret",
            };
          }
          const serviceTitle = `飞书机器人 · ${appIdTrimmed}`;
          const credPromise = control.requestChoice(callId);
          emit?.({
            type: "credential_request",
            callId,
            service: serviceTitle,
            label:
              "请输入该飞书应用的 App Secret（来自飞书开放平台 → 凭据与基础信息），仅加密保存在本机，不会出现在聊天记录中。",
            fieldType: "password",
            hideVaultCheckbox: true,
          });
          emit?.({ type: "status", status: "awaiting_choice" });
          const credRes = await credPromise;
          if (credRes === null || control.stopped) {
            emit?.({ type: "choice_superseded", callId });
            return { ok: false, error: "App Secret 输入已取消" };
          }
          appSecret = String(
            typeof credRes === "object" && credRes !== null ? credRes.value || "" : credRes || ""
          ).trim();
          usedCard = true;
          if (!appSecret) {
            emit?.({
              type: "credential_resolved",
              callId,
              service: serviceTitle,
              submitted: false,
              resolvedText: `✕ 已跳过 ${serviceTitle} 的 App Secret 输入`,
            });
            emit?.({ type: "status", status: "running" });
            return { ok: false, error: "用户跳过了 App Secret 输入，配置未保存" };
          }
        }
      } else if (channelId === "telegram-bot" && !targetAcct && !botToken) {
        if (!control?.requestChoice) {
          return {
            ok: false,
            error: "请在 TwinkleBot App 对话中通过安全卡片输入 Telegram Bot Token",
          };
        }
        const serviceTitle = args.label
          ? `Telegram 机器人 · ${String(args.label).trim()}`
          : "Telegram 机器人";
        const credPromise = control.requestChoice(callId);
        emit?.({
          type: "credential_request",
          callId,
          service: serviceTitle,
          label:
            "请输入来自 @BotFather 的 Telegram Bot Token，仅加密保存在本机，不会出现在聊天记录中。",
          fieldType: "password",
          hideVaultCheckbox: true,
        });
        emit?.({ type: "status", status: "awaiting_choice" });
        const credRes = await credPromise;
        if (credRes === null || control.stopped) {
          emit?.({ type: "choice_superseded", callId });
          return { ok: false, error: "Bot Token 输入已取消" };
        }
        botToken = String(
          typeof credRes === "object" && credRes !== null ? credRes.value || "" : credRes || ""
        ).trim();
        usedCard = true;
        if (!botToken) {
          emit?.({
            type: "credential_resolved",
            callId,
            service: serviceTitle,
            submitted: false,
            resolvedText: `✕ 已跳过 ${serviceTitle} 的 Bot Token 输入`,
          });
          emit?.({ type: "status", status: "running" });
          return { ok: false, error: "用户跳过了 Bot Token 输入，配置未保存" };
        }
      }

      const body: Record<string, any> = {};
      if (args.label !== undefined) body.label = String(args.label);
      else if (!targetAcct && accountSelector) body.label = accountSelector;
      if (args.enabled !== undefined) body.enabled = Boolean(args.enabled);
      else if (!targetAcct) body.enabled = true;
      if (args.connection_mode !== undefined) body.connectionMode = args.connection_mode;
      else if (!targetAcct) {
        body.connectionMode = channelId === "feishu-bot" ? "websocket" : "polling";
      }
      if (channelId === "feishu-bot") {
        if (args.domain !== undefined) body.domain = args.domain;
        if (appIdTrimmed) body.appId = appIdTrimmed;
        if (appSecret) body.appSecret = appSecret;
        if (args.verification_token !== undefined) {
          body.verificationToken = args.verification_token;
        }
        if (args.encrypt_key !== undefined) body.encryptKey = args.encrypt_key;
      } else {
        if (botToken) body.botToken = botToken;
        if (args.webhook_secret !== undefined) body.webhookSecret = args.webhook_secret;
        if (args.proxy !== undefined) body.proxy = args.proxy;
        if (args.clear_proxy === true) body.clearProxy = true;
      }
      if (resolvedTargetSessionId !== undefined) {
        body.defaultSessionId = resolvedTargetSessionId;
      }
      if (args.require_pairing !== undefined) {
        body.requirePairing = Boolean(args.require_pairing);
      }
      const nextWhitelist = computeNextWhitelist(targetAcct?.allowedSenderIds || []);
      if (nextWhitelist !== undefined) {
        body.allowedSenderIds = nextWhitelist;
      }
      if (args.approval_mode !== undefined) {
        body.approvalMode = args.approval_mode;
      }

      const saved = channelConfigActions.upsertAccount?.(
        channelId,
        body,
        {
          accountId: targetAcct?.id || (accountSelector || undefined),
          createNew: Boolean(args.create_new || (!targetAcct && accountSelector)),
        }
      );

      if (usedCard) {
        const cardTitle =
          channelId === "feishu-bot"
            ? `飞书机器人 · ${appIdTrimmed}`
            : args.label
              ? `Telegram 机器人 · ${String(args.label).trim()}`
              : "Telegram 机器人";
        emit?.({
          type: "credential_resolved",
          callId,
          service: cardTitle,
          submitted: true,
          resolvedText: saved?.ok
            ? `🔒 已保存 ${cardTitle}`
            : `⚠️ ${cardTitle} 保存未通过`,
        });
        emit?.({ type: "status", status: "running" });
      }

      if (!saved?.ok) {
        return { ok: false, error: saved?.error || "保存渠道配置失败" };
      }

      let testResult: any = null;
      if (args.auto_test !== false && body.enabled !== false) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          testResult = await channelConfigActions.testChannel?.(
            channelId,
            {},
            saved.accountId
          );
        } catch (err: any) {
          testResult = { ok: false, error: err?.message || String(err) };
        }
      }

      const afterMap = summarizeChannelStatusForBot(
        typeof getChannelStatus === "function" ? getChannelStatus() : null
      );
      const savedAcct =
        afterMap?.[channelId]?.accounts?.find((a: any) => a.id === saved.accountId) || null;
      return {
        ok: true,
        action: "upsert",
        created: !targetAcct,
        channel: channelId,
        accountId: saved.accountId,
        targetBotTitle: resolveSessionLabel(savedAcct?.defaultSessionId),
        account: savedAcct,
        ...(testResult ? { testResult } : {}),
      };
    }

    default:
      return UNHANDLED_BOT_TOOL;
  }
}
