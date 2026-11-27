import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferImageMimeType } from "../model.js";
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
  redactProxyUrlForDisplay,
  redactSensitiveTokensInText,
} from "../../lib/channel-integrations.js";


export const MAX_BOT_HOPS = 4;

export const VALID_SHAPES = [
  "blob", "cloud", "square", "sparkle", "clover", "heart",
  "flower", "teardrop", "tablet", "wedge", "house", "star", "hex",
];

export const VALID_COLORS = [
  "black", "brown", "red", "orange", "yellow", "green",
  "cyan", "blue", "violet", "magenta", "gray",
];

export const COLORFUL_KEYS = VALID_COLORS.filter((c) => c !== "black" && c !== "gray");

const VALID_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "4:5",
  "5:4",
  "21:9",
]);


export function pickByHash(str: string, arr: string[]) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return arr[h % arr.length];
}

export const BOT_COLLAB_TOOL_DECLARATIONS: Record<string, any>[] = [
  {
    type: "function",
    name: "list_bots",
    description:
      "List all existing Bots and Bot Group chats in TwinkleBot, including their IDs, names, role descriptions, and current statuses.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "create_bot",
    description:
      "Create a brand-new specialist Bot with its own name, mascot shape/color, and dedicated role instructions, optionally sending it an initial task handoff message.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name of the new Bot (e.g. 'eSIM 跟进员', '代码动画师').",
        },
        role_prompt: {
          type: "string",
          description: "Dedicated system persona and responsibilities for this Bot.",
        },
        shape: {
          type: "string",
          enum: VALID_SHAPES,
          description: "Optional mascot shape.",
        },
        color: {
          type: "string",
          enum: VALID_COLORS,
          description: "Optional mascot accent color.",
        },
        initial_message: {
          type: "string",
          description: "Optional initial handoff message to immediately send to the new Bot.",
        },
      },
      required: ["name", "role_prompt"],
    },
  },
  {
    type: "function",
    name: "send_bot_message",
    description:
      "Send a direct message or task handoff to another Bot by its name or ID. The target Bot will wake up, process your message, and record the exchange.",
    parameters: {
      type: "object",
      properties: {
        target_bot: {
          type: "string",
          description: "Target Bot ID or exact/partial name.",
        },
        message: {
          type: "string",
          description: "Message or task instructions to send to the target Bot.",
        },
      },
      required: ["target_bot", "message"],
    },
  },
  {
    type: "function",
    name: "create_bot_group",
    description:
      "Create a multi-Bot group chat combining two or more existing Bots so they can collaborate on a shared topic.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Group chat title.",
        },
        member_bots: {
          type: "array",
          items: { type: "string" },
          description: "List of Bot names or IDs to include in the group.",
        },
        initial_message: {
          type: "string",
          description: "Optional opening topic/prompt to post into the group chat.",
        },
      },
      required: ["title", "member_bots"],
    },
  },
  {
    type: "function",
    name: "ask_user_choice",
    description:
      "Present an interactive GrokBot question card (single or multi-step questions, A/B/C/D options, optional multi-select, and built-in 'Your own answer' custom text input) in the chat stream and wait for the user's answer.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Short prompt heading for a single question (e.g. '接下来先帮你做哪一步？').",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2 to 6 concise options for a single question.",
        },
        multi_select: {
          type: "boolean",
          description: "Whether the user may select multiple options (default: false).",
        },
        allow_custom: {
          type: "boolean",
          description: "Whether to include an inline 'Your own answer' custom input row inside the card (default: true).",
        },
        placeholder: {
          type: "string",
          description: "Optional placeholder for the inline custom input box.",
        },
        questions: {
          type: "array",
          description: "Optional batched multi-step questions rendered inside a single stepper card.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              multi_select: { type: "boolean" },
              placeholder: { type: "string" },
            },
            required: ["question", "options"],
          },
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "propose_draft",
    description:
      "Render an inline editable Draft Card (for outbound emails, posts, replies, or important templates) so the user can review/edit the title and content inside the card before approving.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Subject or draft heading.",
        },
        recipient: {
          type: "string",
          description: "Optional recipient or target channel (e.g. email address or platform).",
        },
        content: {
          type: "string",
          description: "Draft body text that the user can edit inline before confirming.",
        },
        kind: {
          type: "string",
          description: "Draft category (e.g. 'email', 'post', 'message', 'document').",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    type: "function",
    name: "request_credential",
    description:
      "Render an inline encrypted Credential / OTP input card when login, password, or 2FA verification code is needed to continue a task. Returns an opaque `secret_ref` handle (`{{secret:cred_...}}`) that is resolved in host memory ONLY when passed directly as the `text` argument of `browser_type` or OS-level `type_text` (never `run_shell`, `key`, or URLs) without ever exposing plaintext credentials in logs.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service or website name (e.g. 'Gmail', 'GitHub').",
        },
        label: {
          type: "string",
          description: "Prompt shown on the card (e.g. '请输入 6 位动态验证码').",
        },
        field_type: {
          type: "string",
          enum: ["password", "otp", "text"],
          description: "Input masking mode (default: 'password').",
        },
      },
      required: ["service", "label"],
    },
  },
  {
    type: "function",
    name: "generate_image",
    description:
      "Generate a brand-new AI image or edit/restyle a reference image using the user's configured image generation model (Settings -> 模型接入与路由 -> 生图模型). IMPORTANT — WHEN TO SKIP THIS TOOL: If the user explicitly asks to draw with code or write SVG / HTML / Canvas markup (e.g. '用代码画', '用 svg 生成', '写一段 SVG/HTML/Canvas'), DO NOT call `generate_image` — skip this tool and write the ```svg ... ``` (or ```html ... ```) code directly in your reply using your own coding capability (the chat UI natively renders interactive SVG/HTML preview cards). Only call `generate_image` for normal image/illustration/poster/avatar/photo generation or reference-image editing requests. When called and no image model is configured or the image model is unexpectedly unavailable, this tool automatically falls back to LLM-coded `.svg` (returning `.svg` by default unless a specific raster/PDF format was requested in `output_format`), and returns `degraded` + `degraded_reason` so you MUST inform the user about the fallback and its reason. Backend format conversion API `POST /api/images/convert` (body: `{ path | svg | dataBase64, format: 'png'|'jpg'|'webp'|'gif'|'bmp'|'ico'|'pdf', width?, height?, title? }`) is also exposed if an existing SVG/image needs converting later.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed visual prompt describing subject, artistic style, lighting, colors, composition, and any text to render.",
        },
        title: {
          type: "string",
          description:
            "Short descriptive title used for the saved filename and image caption (e.g. '赛博霓虹猫咪').",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
          description: "Output image aspect ratio (default: '1:1').",
        },
        quality: {
          type: "string",
          enum: ["standard", "pro"],
          description:
            "'standard' uses the configured image model; 'pro' requests high-detail studio quality when supported.",
        },
        image_size: {
          type: "string",
          enum: ["1K", "2K", "4K"],
          description: "Optional output resolution preset (default: '1K').",
        },
        output_format: {
          type: "string",
          enum: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "pdf"],
          description:
            "Optional target raster/document file format. OMIT this parameter unless the user explicitly asked for a specific format (e.g. 'PNG 格式', '转成 jpg'); when omitted, fallback mode ALWAYS returns '.svg' by default.",
        },
        reference_image_path: {
          type: "string",
          description:
            "Optional absolute workspace path of an uploaded or previously generated image to edit, restyle, or use as visual reference.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "send_file",
    description:
      "Send/deliver a document or binary file (.docx, .pdf, .xlsx, .pptx, .csv, .md, .html, .zip, or image) directly as an interactive attachment card in the chat stream so the user can open, reveal in Finder, or download it with one click. Works for both local Mac paths (e.g. '~/Downloads/report.docx') and files created in Bot's Ubuntu computer.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path on the local Mac (supports ~/... e.g. '~/Downloads/report.docx') or in Bot's Ubuntu computer.",
        },
        title: {
          type: "string",
          description:
            "Optional display filename for the attachment card (e.g. 'B站关注UP主最新视频汇总.docx'). Defaults to the source filename.",
        },
        caption: {
          type: "string",
          description: "Optional short description shown in the tool result.",
        },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the public internet with automatic multi-engine routing (Google -> Bing -> DuckDuckGo -> Baidu) without launching a browser. Returns top search result titles, URLs, snippets, optional publication dates, and fetch timestamp. For time-sensitive or real-time queries (prices, news, exchange rates), set freshness='day' and follow up with web_fetch on an authoritative page instead of trusting cached snippets.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords or question.",
        },
        max_results: {
          type: "integer",
          description: "Maximum results to return (1-10, default 6).",
        },
        freshness: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description:
            "Optional recency filter (e.g. 'day' for today's news/prices, 'week' for recent updates).",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "web_fetch",
    description:
      "Fetch and extract clean readable text and title from a public http(s) web page URL without launching a browser.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public http:// or https:// URL to read.",
        },
        max_chars: {
          type: "integer",
          description: "Maximum text characters to return (default 12000).",
        },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "mail_list_accounts",
    description:
      "List all connected QQ Mail and Generic Mail (POP3/IMAP + SMTP) accounts configured by the user, including each account's ID, email, custom label, protocol, and whether it is the default mailbox.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "mail_list_messages",
    description:
      "List recent emails or search by keyword/unread status from any connected QQ Mail or Generic Mail (POP3/IMAP) account.",
    parameters: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Optional mail account selector when multiple mailboxes are connected: pass an account ID, email address (e.g. 'work@qq.com'), custom label, or provider ('qqmail' / 'custom-mail'). Defaults to the primary default account.",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to fetch (1–30, default: 10).",
        },
        unseen_only: {
          type: "boolean",
          description: "If true, only list unread messages (supported on IMAP).",
        },
        query: {
          type: "string",
          description: "Optional keyword filter matched against subject or sender.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "mail_read_message",
    description:
      "Read the full decoded body and attachment metadata of an email message by its UID from a connected QQ Mail or Generic Mail account.",
    parameters: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Optional mail account selector (account ID, email address, custom label, or provider).",
        },
        uid: {
          type: "string",
          description: "Message UID returned by mail_list_messages.",
        },
      },
      required: ["uid"],
    },
  },
  {
    type: "function",
    name: "mail_send_message",
    description:
      "Compose and send an email through a connected QQ Mail or Generic Mail SMTP server. Presents an inline editable Draft Card for user approval before sending.",
    parameters: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description:
            "Optional sender mail account selector (account ID, email address, custom label, or provider). Defaults to the primary default account.",
        },
        to: {
          type: "string",
          description: "Recipient email address(es), comma-separated if multiple.",
        },
        cc: {
          type: "string",
          description: "Optional CC email address(es).",
        },
        subject: {
          type: "string",
          description: "Email subject line.",
        },
        body: {
          type: "string",
          description: "Plain-text email body.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    type: "function",
    name: "skill_list",
    description:
      "List the user's Skills Store state: built-in platform skills (always on), optional channel integrations (Feishu / Telegram multi-bot runtime status, pending pairing requests & whitelists without secrets), and office skills.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "channel_pairing_manage",
    description:
      "Manage 6-digit pairing requests and approved chats for Feishu & Telegram bots (list pending/approved entries, approve or reject a 6-digit pairing code, suspend/resume or delete an approved chat). NOTE: Mutating actions are ONLY allowed when the owner instructs you inside TwinkleBot App (never when a message came from an external Feishu/Telegram chat).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "approve", "reject", "suspend", "resume", "delete"],
          description: "Pairing operation to perform.",
        },
        code: {
          type: "string",
          description: "6-digit pairing code (required for 'approve' and 'reject').",
        },
        channel: {
          type: "string",
          enum: ["feishu-bot", "telegram-bot"],
          description: "Target channel ID (used for 'suspend', 'resume', 'delete', or optional filter for 'list').",
        },
        account_id: {
          type: "string",
          description: "Optional specific bot account ID (e.g. fs_default or fs_...).",
        },
        chat_id: {
          type: "string",
          description: "Target remote chat ID (required for 'suspend', 'resume', 'delete').",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "memory_manage",
    description:
      "Manage your own dedicated Bot Memory (`scope: 'bot'`, 专属记忆 shown in the right sidebar) or the user's Global Memory (`scope: 'global'`, 全局记忆 shared across all Bots): list, save (add or update), remove (delete), or toggle entries. Set `trigger: 'explicit'` when the user explicitly asked to remember/save something; set `trigger: 'auto'` when silently recording a genuinely durable long-term preference or identity fact (never transient details or secrets).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "save", "remove", "toggle"],
          description: "Operation to perform on memory.",
        },
        scope: {
          type: "string",
          enum: ["bot", "global"],
          description:
            "Memory target: 'bot' for this Bot's own dedicated memory (专属记忆, default), or 'global' for cross-Bot Global Memory (全局记忆).",
        },
        trigger: {
          type: "string",
          enum: ["explicit", "auto"],
          description:
            "When action is 'save': use 'explicit' when the user explicitly asked to remember something, or 'auto' when silently auto-recording a high-value durable preference/fact in the background.",
        },
        memory: {
          type: "string",
          description:
            "Selector for an existing memory (ID, title, or keyword substring) when action is 'remove', 'toggle', or updating an existing entry.",
        },
        name: {
          type: "string",
          description:
            "Short title for the memory when action is 'save' (e.g. '王总邮件抄送规则', '周报排版规范').",
        },
        content: {
          type: "string",
          description:
            "The full memory rule, preference, or context fact to remember when action is 'save'.",
        },
        enabled: {
          type: "boolean",
          description: "Optional enabled state when saving or toggling a memory (default: true).",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "custom_skill_manage",
    description:
      "Manage TwinkleBot's cross-Bot shared Custom Workflow Skills (`SKILL.md` playbooks stored in `custom-skills/`): list, get (load full SKILL.md instructions on demand), create, update, toggle (enable/disable), or delete. Use this tool for reusable multi-step workflows, SOPs, templates, or scripts shared across all Bots — NEVER use it for simple facts/contacts/preferences (use `memory_manage` for those). When asked to create/edit/delete a skill, execute directly and summarize in chat.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "toggle", "delete"],
          description: "Operation to perform on shared custom skills.",
        },
        skill: {
          type: "string",
          description:
            "Selector for an existing skill (slug id, exact name, or keyword) when action is 'get', 'update', 'toggle', or 'delete'.",
        },
        id: {
          type: "string",
          description:
            "Optional kebab-case slug identifier (e.g. 'weekly-report-sender'). Used when creating with a specific slug, or as selector for 'get'/'update'/'toggle'/'delete'.",
        },
        newId: {
          type: "string",
          description: "Optional new slug identifier when renaming an existing skill via 'update'.",
        },
        name: {
          type: "string",
          description: "Display title of the custom skill (e.g. '周报汇总发送').",
        },
        icon: {
          type: "string",
          description: "Optional single emoji icon for the skill card (default '⚡').",
        },
        description: {
          type: "string",
          description:
            "Concise 1-2 sentence summary + trigger scenario shown in the lightweight prompt index across all Bots.",
        },
        instructions: {
          type: "string",
          description:
            "Full Markdown body (`SKILL.md` instructions) with clear step-by-step execution guidance, parameters, or scripts.",
        },
        enabled: {
          type: "boolean",
          description: "Optional enabled state for 'create', 'update', or 'toggle' (default: true).",
        },
        query: {
          type: "string",
          description: "Optional search keyword filter when action is 'list'.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "schedule_manage",
    description:
      "Manage TwinkleBot's built-in per-Bot scheduled tasks and recurring routines (`即将进行` / 例行任务 shown in the right sidebar): list, create, update, toggle (enable/pause), or remove schedules. When a schedule triggers, TwinkleBot automatically wakes up the Bot in its chat window and runs `prompt` (and the Bot can reply in chat or send email via `mail_send_message`). Always use this native tool instead of probing macOS crontab or LaunchAgents.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "update", "toggle", "remove"],
          description: "Operation to perform on scheduled routines.",
        },
        schedule: {
          type: "string",
          description:
            "Selector for an existing schedule (ID, title, or keyword substring) when action is 'update', 'toggle', or 'remove'.",
        },
        title: {
          type: "string",
          description:
            "Task display name shown in the right sidebar under 「即将进行」(e.g. '每日博客流量日报', '每小时检查回信').",
        },
        prompt: {
          type: "string",
          description:
            "Detailed instruction sent to the Bot when the timer fires (e.g. '统计服务器 Caddy 今日访问量，在当前聊天窗口发送日报，并发邮件到 xxx@qq.com').",
        },
        repeat: {
          type: "string",
          enum: ["daily", "hourly", "weekly", "cron", "once"],
          description:
            "Recurrence mode: 'daily' (每天), 'hourly' (每小时), 'weekly' (每周), 'cron' (自定义 5 段 Cron 表达式), or 'once' (单次执行). Default: 'daily' (or 'cron' when `cron` is provided).",
        },
        cron: {
          type: "string",
          description:
            "Standard 5-field cron expression ('minute hour dayOfMonth month dayOfWeek', e.g. '0 10 */3 * *' for every 3 days at 10:00, '30 9 * * 1-5' for weekdays 09:30, '*/15 * * * *' for every 15 min) or alias (@hourly/@daily/@weekly/@monthly).",
        },
        schedule_label: {
          type: "string",
          description:
            "Human-readable schedule label shown in the right sidebar (e.g. '每天 21:00', '每天 09:00', '每小时', '明天 09:00').",
        },
        time: {
          type: "string",
          description:
            "Optional 24-hour local time 'HH:MM' (e.g. '21:00', '09:30') or ISO 8601 timestamp for the next run.",
        },
        delay_minutes: {
          type: "number",
          description:
            "Optional delay in minutes from now for the first/next execution (e.g. 1 for immediate test or 30 for in 30 minutes).",
        },
        enabled: {
          type: "boolean",
          description: "Optional enabled state (default: true).",
        },
        target_bot: {
          type: "string",
          description:
            "Optional Bot name or ID if managing schedules for another Bot (defaults to the current Bot).",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "skill_configure_mail",
    description:
      "Configure an ADDED mail skill (qqmail = QQ 邮箱, custom-mail = 通用邮箱 POP3/IMAP + SMTP) directly from chat: add or edit a mailbox account, switch the default mailbox, test connectivity, or remove one account. If the user has not given the password / 16-digit auth code, OMIT `secret` — a secure masked input card is shown to the user automatically. Never ask for passwords in plain text. Server hosts are auto-filled from the email domain when omitted.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["upsert_account", "set_default", "test_account", "remove_account"],
          description: "Operation to perform.",
        },
        skill_id: {
          type: "string",
          enum: ["qqmail", "custom-mail"],
          description: "Mail skill to configure. Required for adding a new account; otherwise inferred from `account`.",
        },
        account: {
          type: "string",
          description: "Existing account selector (account ID, email address, or label) for edit / set_default / test / remove.",
        },
        email: { type: "string", description: "Mailbox address for a new or edited account." },
        secret: {
          type: "string",
          description: "Optional password or QQ 16-digit auth code — only if the user explicitly typed it. Omit to show the secure card.",
        },
        label: { type: "string", description: "Optional account label, e.g. 工作QQ." },
        sender_name: { type: "string", description: "Optional sender display name." },
        inbound_protocol: { type: "string", enum: ["imap", "pop3"], description: "Inbound protocol (default imap)." },
        inbound_host: { type: "string", description: "Optional inbound server host override." },
        inbound_port: { type: "number", description: "Optional inbound server port override." },
        inbound_tls: { type: "boolean", description: "Optional inbound TLS flag." },
        smtp_host: { type: "string", description: "Optional SMTP host override." },
        smtp_port: { type: "number", description: "Optional SMTP port override." },
        smtp_security: { type: "string", enum: ["ssl", "starttls", "none"], description: "Optional SMTP security." },
        is_default: { type: "boolean", description: "Set as default mailbox." },
        send_test_mail: { type: "boolean", description: "For test_account: also send a test email to the account itself." },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "skill_configure_channel",
    description:
      "Configure Feishu (`feishu-bot`) or Telegram (`telegram-bot`) bot instances directly from chat (App-only): list configured bots (`list`), add or replace credentials / routing / pairing policy / reconnect (`upsert`, auto-installs the skill if not yet added), manage static whitelist (`whitelist`), test connection (`test`), force reconnect (`reconnect`), or delete an instance (`delete`). If adding a new bot and the user has NOT provided `app_secret` / `bot_token` yet, OMIT the secret to trigger a secure encrypted password card automatically. Never return plaintext secrets.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "upsert", "test", "reconnect", "delete", "whitelist"],
          description: "Channel configuration operation to run.",
        },
        channel: {
          type: "string",
          enum: ["feishu-bot", "telegram-bot"],
          description: "Channel platform ('feishu-bot' or 'telegram-bot'). Inferred when omitted if credentials or account_id uniquely identify it.",
        },
        account_id: {
          type: "string",
          description: "Target bot instance selector (account ID, label, or Feishu app_id). Required only when selecting among multiple configured bots; omit to target the single configured bot or pass create_new=true to add another.",
        },
        create_new: {
          type: "boolean",
          description: "Set true when adding a new / additional bot instance alongside existing ones.",
        },
        label: {
          type: "string",
          description: "Optional human-friendly label for this bot instance (e.g. '研发飞书助手').",
        },
        enabled: {
          type: "boolean",
          description: "Enable or disable this bot instance (default true for new bots).",
        },
        connection_mode: {
          type: "string",
          enum: ["websocket", "webhook", "polling"],
          description: "Connection mode ('websocket' or 'webhook' for Feishu; 'polling' or 'webhook' for Telegram).",
        },
        domain: {
          type: "string",
          enum: ["feishu", "lark"],
          description: "Feishu region ('feishu' for open.feishu.cn or 'lark' for open.larksuite.com).",
        },
        app_id: {
          type: "string",
          description: "Feishu App ID (e.g. cli_xxx).",
        },
        app_secret: {
          type: "string",
          description: "Optional Feishu App Secret (only when explicitly given by user; omit when adding a new Feishu bot to prompt via secure encrypted card, or when editing other settings to preserve existing secret).",
        },
        verification_token: {
          type: "string",
          description: "Optional Feishu Webhook Verification Token.",
        },
        encrypt_key: {
          type: "string",
          description: "Optional Feishu Webhook Encrypt Key.",
        },
        bot_token: {
          type: "string",
          description: "Optional Telegram Bot Token from @BotFather (omit when adding a new Telegram bot to prompt via secure encrypted card, or when editing other settings to preserve existing token).",
        },
        webhook_secret: {
          type: "string",
          description: "Optional Telegram Webhook secret token.",
        },
        proxy: {
          type: "string",
          description: "Optional HTTP/HTTPS/SOCKS5 proxy URL for Telegram bot (e.g. 'http://127.0.0.1:7890' or 'socks5://127.0.0.1:7891').",
        },
        clear_proxy: {
          type: "boolean",
          description: "Set true to clear saved Telegram proxy.",
        },
        target_bot: {
          type: "string",
          description: "Target TwinkleBot Bot or Bot Group name/ID to route inbound messages to (e.g. '节点刷新员', '博客管理员', or '' / 'admin' for Admin Bot Nori).",
        },
        require_pairing: {
          type: "boolean",
          description: "When true (default), unknown senders receive a 6-digit pairing code; when false, only static whitelist and approved chats are allowed.",
        },
        allowed_sender_ids: {
          type: "array",
          items: { type: "string" },
          description: "Replace the static whitelist with this list of user open_id / sender IDs / chat IDs.",
        },
        add_allowed_sender_ids: {
          type: "array",
          items: { type: "string" },
          description: "Append one or more user/chat IDs (e.g. ['ou_xxx']) to the existing static whitelist.",
        },
        remove_allowed_sender_ids: {
          type: "array",
          items: { type: "string" },
          description: "Remove one or more user/chat IDs from the existing static whitelist.",
        },
        approval_mode: {
          type: "string",
          enum: ["channel_and_app", "app_only"],
          description: "High-risk tool approval policy for messages from this bot.",
        },
        auto_test: {
          type: "boolean",
          description: "When true (default for upsert), run connectivity test immediately after saving.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "bot_manage",
    description:
      "Manage your own Bot profile or another Bot / Bot Group: update name, dedicated role & persona (`role_prompt`, shown in right sidebar under 「职责与人设」), or mascot shape/color (`action: 'update_profile'`); clone an existing Bot (`action: 'clone'`); or add/remove members in a Bot Group (`action: 'update_group_members'`).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["update_profile", "clone", "update_group_members"],
          description: "Operation to perform on a Bot or Bot Group.",
        },
        target_bot: {
          type: "string",
          description:
            "Optional Bot name or ID to update or clone (defaults to the current Bot).",
        },
        name: {
          type: "string",
          description: "New display name for update_profile or clone.",
        },
        role_prompt: {
          type: "string",
          description:
            "New dedicated role & persona description (`职责与人设`) for update_profile or clone.",
        },
        shape: {
          type: "string",
          enum: VALID_SHAPES,
          description: "Optional mascot shape for update_profile or clone.",
        },
        color: {
          type: "string",
          enum: VALID_COLORS,
          description: "Optional mascot accent color for update_profile or clone.",
        },
        group: {
          type: "string",
          description:
            "Target Bot Group name or ID when action is 'update_group_members'.",
        },
        add_bots: {
          type: "array",
          items: { type: "string" },
          description:
            "Bot names or IDs to add to the group when action is 'update_group_members'.",
        },
        remove_bots: {
          type: "array",
          items: { type: "string" },
          description:
            "Bot names or IDs to remove from the group when action is 'update_group_members'.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "workspace_search",
    description:
      "Search across all Bots' chat histories (`action: 'search'`), read inter-Bot handoff transcripts (`action: 'read_exchange'`), or inspect recent messages from another Bot's conversation (`action: 'recent_messages'`). Use this to find information another Bot already gathered without blindly guessing or re-running commands.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "read_exchange", "recent_messages"],
          description: "Search or inspection mode.",
        },
        query: {
          type: "string",
          description:
            "Keyword to search across all Bots and conversation messages when action is 'search'.",
        },
        peer_bot: {
          type: "string",
          description:
            "Target Bot name or ID when reading an inter-Bot exchange (`read_exchange`) or inspecting another Bot's recent messages (`recent_messages`).",
        },
        exchange_id: {
          type: "string",
          description: "Optional explicit exchange ID (`ex_...`) for `read_exchange`.",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 15, max: 40).",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "library_manage",
    description:
      "Inspect or archive items in the right sidebar's 「资料库 (Library)」 tab: list session screenshots, generated images, uploaded files, and saved notes (`action: 'list'`), or archive a Markdown report/note into `saved-notes/` so it appears directly in the user's Library (`action: 'save_note'`).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "save_note"],
          description: "Operation to perform on the Library.",
        },
        filter: {
          type: "string",
          enum: ["all", "media", "file"],
          description: "Optional item filter when action is 'list' (default: 'all').",
        },
        title: {
          type: "string",
          description:
            "Note title when action is 'save_note' (e.g. '2026-11-12 博客流量分析报告').",
        },
        content: {
          type: "string",
          description:
            "Markdown content to save into the Library when action is 'save_note'.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "vault_manage",
    description:
      "Manage the user's Encrypted Local Vault (`vault.json`, shown in 设置 → 保险箱): list saved contacts/accounts/credentials (`action: 'list'`, includes `hasPassword` flag, never plaintext), obtain an opaque `secret_ref` handle (`{{secret:cred_...}}`) for a saved credential's encrypted password (`action: 'get_secret'`) to inject via `browser_type` or `type_text`, save or update non-secret metadata (`action: 'save'`), or remove an entry (`action: 'remove'`). Never returns plaintext passwords.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get_secret", "save", "remove"],
          description: "Operation to perform on the Vault.",
        },
        item: {
          type: "string",
          description:
            "Selector for an existing vault item (ID, title, or email/subtitle substring) when retrieving a secret handle, updating, or removing.",
        },
        category: {
          type: "string",
          enum: ["contact", "account", "credential", "login", "note"],
          description: "Item category when action is 'save' (default: 'contact').",
        },
        title: {
          type: "string",
          description:
            "Display title when action is 'save' (e.g. '博客读者反馈邮箱', '王总').",
        },
        subtitle: {
          type: "string",
          description:
            "Email address, handle, or identifier when action is 'save' (e.g. 'you@example.com').",
        },
        notes: {
          type: "string",
          description:
            "Optional role or context notes when action is 'save' (e.g. '每日博客日报默认收件人').",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "system_diagnostics",
    description:
      "Inspect real-time TwinkleBot runtime diagnostics or trigger self-healing: check the status of 「Bot 的电脑」(Ubuntu Executor), 「你的电脑」(local Mac host), `KimiCU` MCP server, and current session token/cost statistics (`action: 'status'`); reconnect the `kimi-cu` MCP server (`action: 'reconnect_mcp'`); or sync & restart the Ubuntu Executor (`action: 'update_bot_computer'`).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "reconnect_mcp", "update_bot_computer"],
          description: "Diagnostic or self-healing action to perform.",
        },
        server_id: {
          type: "string",
          description: "Optional MCP server ID for reconnect_mcp (default: 'kimi-cu').",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "computer_provision",
    description:
      "ADMIN-BOT EXCLUSIVE: Probe, initialize/install, or verify Bot's Computer sandbox environment (Windows: WSL + Ubuntu + GUI; macOS: OrbStack + Ubuntu + GUI; Cloud: already ready). Regular non-admin Bots are strictly forbidden from calling install.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["probe", "install", "verify"],
          description: "Provisioning action to run.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "account_manage",
    description:
      "ADMIN-BOT EXCLUSIVE: List, configure (add/update), test, or remove saved 云端账号 / 本地账号 (Cloud Accounts & remote Relay nodes in accounts-auth.json). Automatically probes the target server's authoritative deployEnv ('cloud' vs 'local') and syncs to the UI account menu. Strictly NEVER supports automatic account switching — the user must always switch accounts manually.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "upsert", "test", "remove"],
          description: "Action to perform on remote/cloud accounts.",
        },
        account_id: {
          type: "string",
          description: "Existing account ID, name, or URL when testing/removing/updating.",
        },
        name: {
          type: "string",
          description: "Display name for the account (e.g. '阿里云节点' or 'MacBook Pro').",
        },
        base_url: {
          type: "string",
          description: "Server or Relay base URL (https://... or http://...).",
        },
        auth_token: {
          type: "string",
          description: "Bearer access token or relay token (masked in display).",
        },
        invite_uri: {
          type: "string",
          description: "Optional twinklebot://relay?data=... invite URI to import.",
        },
        preferred_route: {
          type: "string",
          enum: ["auto", "lan", "relay"],
          description: "Route preference when binding a Local Account's remote relay.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "self_update",
    description:
      "Check TwinkleBot OTA update status, inspect the authoritative GitHub Releases manifest, apply Web + Core Runtime OTA self-updates (with SHA-256 verification, strict shell-version binding, idle-deferred switching after the Bot finishes replying, and automatic watchdog rollback), or roll back to the previous/built-in stable version. Note: OTA updates TwinkleBot's Web UI and Core Runtime bundle only (external AI models are not part of OTA). `apply` and `rollback` are ADMIN-BOT EXCLUSIVE.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["check", "status", "apply", "rollback"],
          description:
            "'status' inspects current local runtime/OTA state; 'check' queries GitHub Releases compatibility; 'apply' downloads, verifies, and switches Web+Core OTA; 'rollback' restores previous or built-in runtime.",
        },
        force: {
          type: "boolean",
          description:
            "Optional for action='apply' (default: false). Keep false so the switch defers cleanly until the current Bot reply finishes; only set true if the user explicitly asks to force-restart immediately.",
        },
        rollback_mode: {
          type: "string",
          enum: ["previous", "builtin"],
          description:
            "Optional for action='rollback': 'previous' (default) restores last known-good OTA release; 'builtin' restores the app's built-in bundle.",
        },
        reason: {
          type: "string",
          description: "Optional human-readable reason when action='rollback'.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "app_knowledge",
    description:
      "Query TwinkleBot's built-in product self-knowledge documentation (`list` | `search` | `read`) covering Desktop/Mobile UI navigation, all 8 Settings tabs, shortcuts, interactive cards, accounts/Remote Relay, skills/channels, dual-computer & memory workflows. Always call this before answering user questions about where a TwinkleBot setting/button lives or how an App feature works.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "search", "read"],
          description:
            "'list' returns available topic IDs and summaries; 'search' matches keywords or user questions; 'read' reads a full topic or filtered ## section.",
        },
        query: {
          type: "string",
          description: "Search keywords or question (used when action='search').",
        },
        topic: {
          type: "string",
          description:
            "Topic ID (e.g. 'ui-navigation-desktop', 'ui-navigation-mobile', 'chat-cards-and-workflows', 'accounts-relay-and-updates', 'skills-channels-and-vault', 'computers-and-memory') for action='read'.",
        },
        section: {
          type: "string",
          description: "Optional ## section heading keyword when action='read'.",
        },
        limit: {
          type: "number",
          description: "Optional max results (1-6, default 3) for action='search'.",
        },
      },
      required: ["action"],
    },
  },
];

export const SKILL_NOT_ADDED_ERROR = "该技能当前未添加，请先在左下角「技能商店」添加后再配置。";

export function getInstalledSkillIds(store: any) {
  return resolveInstalledSkillIds(store?.readSettings?.() || {});
}

export function filterToolDeclarationsForSkills(
  declarations: any[] = [],
  installedSkillIds: string[] = []
) {
  const hasMailSkill = installedSkillIds.some((id) => MAIL_SKILL_IDS.includes(id));
  const hasChannelSkill =
    installedSkillIds.includes("feishu-bot") || installedSkillIds.includes("telegram-bot");
  return declarations.filter((d) => {
    const name = String(d?.name || "");
    if (!hasMailSkill && name.startsWith("mail_")) return false;
    if (!hasChannelSkill && name === "channel_pairing_manage") return false;
    return true;
  });
}

export function redactToolArgsForDisplay(name: string, args: any) {
  if (!args || typeof args !== "object") return args;
  if (name === "skill_configure_mail") {
    if (!("secret" in args)) return args;
    return { ...args, secret: "••••" };
  }
  if (name === "skill_configure_channel") {
    const out: Record<string, any> = { ...args };
    for (const secretKey of [
      "app_secret",
      "bot_token",
      "webhook_secret",
      "verification_token",
      "encrypt_key",
    ]) {
      if (secretKey in out && out[secretKey]) {
        out[secretKey] = "••••••••";
      }
    }
    if (typeof out.proxy === "string" && out.proxy.trim()) {
      out.proxy = redactProxyUrlForDisplay(out.proxy);
    }
    return out;
  }
  if (name === "account_manage") {
    const out: Record<string, any> = { ...args };
    for (const secretKey of ["auth_token", "invite_uri", "relay_token"]) {
      if (secretKey in out && out[secretKey]) {
        out[secretKey] = "••••••••";
      }
    }
    return out;
  }
  if ((name === "run_shell" || name === "host_run_shell") && typeof args.command === "string") {
    const redacted = redactSensitiveTokensInText(args.command);
    return redacted === args.command ? args : { ...args, command: redacted };
  }
  return args;
}


export const BOT_TOOL_NAMES = new Set(BOT_COLLAB_TOOL_DECLARATIONS.map((t) => t.name));

export function isBotCollabTool(name: string) {
  return BOT_TOOL_NAMES.has(name);
}

