/**
 * Unified Skills Catalog (技能商店) — shared by the server, Bot tools and the browser.
 * Browser-safe: no Node.js imports. Served to the frontend at `/skills-catalog.js`.
 */

export interface SkillMeta {
  id: string;
  name: string;
  desc: string;
  icon: string;
  category: "office" | "platform" | "builtin";
  builtin?: boolean;
  removable?: boolean;
  mcpServerId?: string;
  toolCount?: number;
}

export const SKILL_CATEGORIES = {
  office: { id: "office", label: "办公", hidden: false },
  platform: { id: "platform", label: "平台技能", hidden: false },
  builtin: { id: "builtin", label: "内置", hidden: true },
} as const;

export const VISIBLE_SKILL_CATEGORIES = Object.values(SKILL_CATEGORIES).filter(
  (c) => !c.hidden
);

export const PLATFORM_SKILLS: SkillMeta[] = [
  {
    id: "desktop-control",
    name: "电脑桌面操控",
    desc: "截屏、点击、拖拽、键鼠输入与窗口和浏览器操作",
    icon: "🖥️",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 10,
  },
  {
    id: "shell-and-files",
    name: "终端与文件读写",
    desc: "在沙盒与授权目录内执行命令、读写工作区文件",
    icon: "⌨️",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 3,
  },
  {
    id: "ai-image",
    name: "AI 图像生成与重绘",
    desc: "优先调用生图模型，未配置或不可用时自动降级为大模型编写 SVG（支持按需转格式接口 /api/images/convert）",
    icon: "🎨",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 1,
  },
  {
    id: "multi-bot-collab",
    name: "多 Bot 派生与群聊协作",
    desc: "创建专职子 Bot、跨 Bot 委派与群聊协同",
    icon: "🤝",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 4,
  },
  {
    id: "interactive-cards",
    name: "交互提问与安全审批",
    desc: "多选提问卡、草稿审核卡与加密凭据输入卡",
    icon: "🛡️",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 3,
  },
  {
    id: "custom-skill-manager",
    name: "自定义技能与记忆管理",
    desc: "支持 Bot 自动判断沉淀可复用工作流（SKILL.md）或记忆，全 Bot 共享与按需读取",
    icon: "🧩",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 2,
  },
  {
    id: "websearch",
    name: "联网搜索与网页读取",
    desc: "实时全网检索（web_search）与网页正文抓取（web_fetch），无需打开浏览器即可查证最新资讯",
    icon: "🌐",
    category: "builtin",
    builtin: true,
    removable: false,
    toolCount: 2,
  },
  {
    id: "kimi-cu",
    name: "KimiCU 桌面软件操控",
    desc: "通过 MCP 后台无感操控 Mac 任意桌面软件（单窗口截图 + AX 树 + 键鼠注入，不抢物理鼠标）",
    icon: "🖱️",
    category: "platform",
    builtin: false,
    removable: true,
    mcpServerId: "kimi-cu",
    toolCount: 20,
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
    desc: "绑定多个 QQ 邮箱，IMAP/POP3 收信 + SMTP 发信",
    icon: "✉️",
    category: "office",
  },
  {
    id: "custom-mail",
    name: "通用邮箱",
    desc: "POP3 / IMAP + SMTP 接入 163、企业邮、Outlook 等",
    icon: "📬",
    category: "office",
  },
];

export const MAIL_SKILL_IDS = ["qqmail", "custom-mail"];
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

export function getSkillMeta(id: string): SkillMeta | null {
  return (
    OFFICE_SKILLS.find((s) => s.id === id) ||
    PLATFORM_SKILLS.find((s) => s.id === id) ||
    null
  );
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
