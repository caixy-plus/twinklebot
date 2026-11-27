/**
 * Unified Skills Catalog (技能商店) — shared by the server, Bot tools and the browser.
 * Browser-safe: no Node.js imports. Served to the frontend at `/skills-catalog.js`.
 */

export interface SkillMeta {
  id: string;
  name: string;
  nameEn?: string;
  desc: string;
  descEn?: string;
  icon: string;
  category: "office" | "platform" | "builtin";
  builtin?: boolean;
  removable?: boolean;
  supportedPlatforms?: readonly string[];
  mcpServerId?: string;
  toolCount?: number;
}

export const SKILL_CATEGORIES = {
  office: { id: "office", label: "办公", labelEn: "Office", hidden: false },
  platform: { id: "platform", label: "平台技能", labelEn: "Platform", hidden: false },
  builtin: { id: "builtin", label: "内置", labelEn: "Built-in", hidden: true },
} as const;

export const VISIBLE_SKILL_CATEGORIES = Object.values(SKILL_CATEGORIES).filter(
  (c) => !c.hidden
);

export const PLATFORM_SKILLS: SkillMeta[] = [
  {
    id: "desktop-control",
    name: "电脑桌面操控",
    nameEn: "Desktop Control",
    desc: "截屏、点击、拖拽、键鼠输入与窗口和浏览器操作",
    descEn: "Screenshots, clicks, drags, keyboard/mouse input, and window/browser actions",
    icon: "🖥️",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 10,
  },
  {
    id: "shell-and-files",
    name: "终端与文件读写",
    nameEn: "Terminal & Files",
    desc: "在沙盒与授权目录内执行命令、读写工作区文件",
    descEn: "Run shell commands and read/write workspace files inside authorized directories",
    icon: "⌨️",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 3,
  },
  {
    id: "ai-image",
    name: "AI 图像生成与重绘",
    nameEn: "AI Image Generation",
    desc: "优先调用生图模型，未配置或不可用时自动降级为大模型编写 SVG（支持按需转格式接口 /api/images/convert）",
    descEn: "Generate images with configured image models, falling back to SVG synthesis with on-demand conversion",
    icon: "🎨",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 1,
  },
  {
    id: "multi-bot-collab",
    name: "多 Bot 派生与群聊协作",
    nameEn: "Multi-Bot Collaboration",
    desc: "创建专职子 Bot、跨 Bot 委派与群聊协同",
    descEn: "Spawn specialized sub-bots, delegate across bots, and collaborate in group chats",
    icon: "🤝",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 4,
  },
  {
    id: "interactive-cards",
    name: "交互提问与安全审批",
    nameEn: "Interactive Cards & Approvals",
    desc: "多选提问卡、草稿审核卡与加密凭据输入卡",
    descEn: "Choice prompts, draft review cards, and encrypted credential inputs",
    icon: "🛡️",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 3,
  },
  {
    id: "custom-skill-manager",
    name: "自定义技能与记忆管理",
    nameEn: "Custom Skills & Memory",
    desc: "支持 Bot 自动判断沉淀可复用工作流（SKILL.md）或记忆，全 Bot 共享与按需读取",
    descEn: "Save reusable workflows (SKILL.md) and memories shared across bots on demand",
    icon: "🧩",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 2,
  },
  {
    id: "websearch",
    name: "联网搜索与网页读取",
    nameEn: "Web Search & Fetch",
    desc: "实时全网检索（web_search）与网页正文抓取（web_fetch），无需打开浏览器即可查证最新资讯",
    descEn: "Real-time web search and page extraction without opening a browser",
    icon: "🌐",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 2,
  },
  {
    id: "kimi-cu",
    name: "KimiCU 桌面软件操控",
    nameEn: "KimiCU Desktop Control",
    desc: "通过 MCP 后台无感操控 Mac 任意桌面软件（单窗口截图 + AX 树 + 键鼠注入，不抢物理鼠标）",
    descEn: "Control macOS desktop apps silently via MCP (window capture + AX tree + cursor-safe input)",
    icon: "🖱️",
    category: "platform",
    builtin: false,
    removable: true,
    supportedPlatforms: ["darwin"],
    mcpServerId: "kimi-cu",
    toolCount: 20,
  },
  {
    id: "feishu-bot",
    name: "飞书机器人",
    nameEn: "Feishu / Lark Bot",
    desc: "将飞书（Feishu / Lark）机器人接入为对话渠道，支持 WebSocket 长连接与 Webhook 收发消息及审批确认",
    descEn: "Connect Feishu / Lark bots via WebSocket or Webhook for messaging, pairing, and approvals",
    icon: "💬",
    category: "platform",
    builtin: false,
    removable: true,
  },
  {
    id: "telegram-bot",
    name: "Telegram 机器人",
    nameEn: "Telegram Bot",
    desc: "将 Telegram Bot 接入为对话渠道，支持长轮询（免公网 IP）与 Webhook 与你的 Bot 直接收发消息",
    descEn: "Connect Telegram bots via Long Polling (no public IP needed) or Webhook with your bots",
    icon: "✈️",
    category: "platform",
    builtin: false,
    removable: true,
  },
];

export const BUILTIN_SKILLS: SkillMeta[] = PLATFORM_SKILLS.filter(
  (s) => s.category === "builtin"
);
export const VISIBLE_PLATFORM_SKILLS: SkillMeta[] = PLATFORM_SKILLS.filter(
  (s) => s.category !== "builtin"
);

export const OFFICE_SKILLS: SkillMeta[] = [
  {
    id: "qqmail",
    name: "QQ 邮箱",
    nameEn: "QQ Mail",
    desc: "绑定多个 QQ 邮箱，IMAP/POP3 收信 + SMTP 发信",
    descEn: "Bind multiple QQ Mail accounts for IMAP/POP3 receiving & SMTP sending",
    icon: "✉️",
    category: "office",
  },
  {
    id: "custom-mail",
    name: "通用邮箱",
    nameEn: "Generic Email",
    desc: "POP3 / IMAP + SMTP 接入 163、企业邮、Outlook 等",
    descEn: "Connect 163, enterprise mail, Outlook, Gmail, and more via POP3/IMAP + SMTP",
    icon: "📬",
    category: "office",
  },
];

export const MAIL_SKILL_IDS = ["qqmail", "custom-mail"];
export const CHANNEL_SKILL_IDS = ["feishu-bot", "telegram-bot"];
export const OPTIONAL_PLATFORM_SKILL_IDS = PLATFORM_SKILLS.filter(
  (s) => s.builtin === false
).map((s) => s.id);
export const INSTALLABLE_SKILL_IDS = [
  ...OFFICE_SKILLS.map((s) => s.id),
  ...OPTIONAL_PLATFORM_SKILL_IDS,
];
export const DEFAULT_INSTALLED_SKILLS = ["qqmail", "custom-mail"];

const PLATFORM_IDS = new Set(PLATFORM_SKILLS.map((s) => s.id));
const BUILTIN_PLATFORM_IDS = new Set(
  PLATFORM_SKILLS.filter((s) => s.builtin !== false).map((s) => s.id)
);
const INSTALLABLE_IDS = new Set(INSTALLABLE_SKILL_IDS);

export function isPlatformSkill(id: unknown): boolean {
  return PLATFORM_IDS.has(String(id || ""));
}

export function isChannelSkill(id: unknown): boolean {
  return CHANNEL_SKILL_IDS.includes(String(id || ""));
}

export function isBuiltinPlatformSkill(id: unknown): boolean {
  return BUILTIN_PLATFORM_IDS.has(String(id || ""));
}

export function isHiddenBuiltinSkill(skillOrId: unknown): boolean {
  if (skillOrId && typeof skillOrId === "object") {
    const obj = skillOrId as { id?: unknown; category?: unknown; removable?: unknown };
    if (obj.category === "builtin") return true;
    if (obj.removable === false) return true;
    return BUILTIN_PLATFORM_IDS.has(String(obj.id || ""));
  }
  return BUILTIN_PLATFORM_IDS.has(String(skillOrId || ""));
}

export function isInstallableSkill(id: unknown): boolean {
  return INSTALLABLE_IDS.has(String(id || ""));
}

export function isSkillSupportedOnPlatform(
  skillOrId: { id?: string; supportedPlatforms?: readonly string[] } | string | null | undefined,
  platform?: string | null
): boolean {
  const meta =
    typeof skillOrId === "string"
      ? getSkillMeta(skillOrId)
      : skillOrId && typeof skillOrId === "object"
        ? Array.isArray(skillOrId.supportedPlatforms)
          ? skillOrId
          : skillOrId.id
            ? getSkillMeta(skillOrId.id)
            : null
        : null;
  const supported = meta?.supportedPlatforms;
  if (!Array.isArray(supported) || supported.length === 0) return true;
  const norm = String(platform || "").trim().toLowerCase();
  if (!norm) return true;
  const mapped =
    norm === "macos" || norm === "mac"
      ? "darwin"
      : norm === "windows" || norm === "win"
        ? "win32"
        : norm;
  return supported.includes(mapped);
}

export function getSkillMeta(id: string): SkillMeta | null {
  return (
    OFFICE_SKILLS.find((s) => s.id === id) ||
    PLATFORM_SKILLS.find((s) => s.id === id) ||
    null
  );
}

export function getLocalizedSkillMeta<T extends { id?: string; name?: string; nameEn?: string; desc?: string; descEn?: string }>(
  skill: T,
  locale: "zh-CN" | "en" = "zh-CN"
): { name: string; desc: string } {
  const catalog = skill?.id ? getSkillMeta(String(skill.id)) : null;
  if (locale === "en") {
    return {
      name: String(skill?.nameEn || catalog?.nameEn || skill?.name || catalog?.name || skill?.id || ""),
      desc: String(skill?.descEn || catalog?.descEn || skill?.desc || catalog?.desc || ""),
    };
  }
  return {
    name: String(skill?.name || catalog?.name || skill?.id || ""),
    desc: String(skill?.desc || catalog?.desc || ""),
  };
}

export function getSkillCategoryLabel(
  categoryId: string,
  locale: "zh-CN" | "en" = "zh-CN"
): string {
  const cat = (SKILL_CATEGORIES as Record<string, { label: string; labelEn?: string }>)[categoryId];
  if (!cat) return categoryId;
  return locale === "en" ? cat.labelEn || cat.label : cat.label;
}

export function resolveInstalledSkillIds(settings: any): string[] {
  const raw = settings && typeof settings === "object" ? settings.installedSkills : undefined;
  if (!Array.isArray(raw)) return [...DEFAULT_INSTALLED_SKILLS];
  const out: string[] = [];
  for (const id of raw) {
    if (isInstallableSkill(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

type MailDomainPreset = [string, string, string, number, string];
const SSL = "ssl";
const MAIL_DOMAIN_PRESETS: Record<string, MailDomainPreset> = {
  "163.com": ["imap.163.com", "pop.163.com", "smtp.163.com", 465, SSL],
  "126.com": ["imap.126.com", "pop.126.com", "smtp.126.com", 465, SSL],
  "yeah.net": ["imap.yeah.net", "pop.yeah.net", "smtp.yeah.net", 465, SSL],
  "qq.com": ["imap.qq.com", "pop.qq.com", "smtp.qq.com", 465, SSL],
  "foxmail.com": ["imap.qq.com", "pop.qq.com", "smtp.qq.com", 465, SSL],
  "exmail.qq.com": ["imap.exmail.qq.com", "pop.exmail.qq.com", "smtp.exmail.qq.com", 465, SSL],
  "aliyun.com": ["imap.aliyun.com", "pop.aliyun.com", "smtp.aliyun.com", 465, SSL],
  "outlook.com": ["outlook.office365.com", "outlook.office365.com", "smtp.office365.com", 587, "starttls"],
  "hotmail.com": ["outlook.office365.com", "outlook.office365.com", "smtp.office365.com", 587, "starttls"],
  "live.com": ["outlook.office365.com", "outlook.office365.com", "smtp.office365.com", 587, "starttls"],
  "gmail.com": ["imap.gmail.com", "pop.gmail.com", "smtp.gmail.com", 465, SSL],
  "feishu.cn": ["imap.feishu.cn", "pop.feishu.cn", "smtp.feishu.cn", 465, SSL],
};

export function inferMailServerPreset(
  email: string,
  preferredProtocol: "imap" | "pop3" = "imap"
) {
  const m = String(email || "").trim().toLowerCase().match(/^[^\s@]+@([^\s@]+\.[^\s@]+)$/);
  if (!m) return null;
  const domain = m[1];
  const isPop = preferredProtocol === "pop3";
  const preset: MailDomainPreset = MAIL_DOMAIN_PRESETS[domain] || [
    `imap.${domain}`,
    `pop.${domain}`,
    `smtp.${domain}`,
    465,
    SSL,
  ];
  return {
    inboundProtocol: isPop ? "pop3" : "imap",
    inboundHost: isPop ? preset[1] : preset[0],
    inboundPort: isPop ? 995 : 993,
    inboundTls: true,
    smtpHost: preset[2],
    smtpPort: preset[3],
    smtpSecurity: preset[4],
  };
}
