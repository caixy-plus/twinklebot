export type ResolvedLocale = "zh-CN" | "en";

export const ACCOUNTS_STORAGE_KEY = "twinklebot.accounts.v2";

export const PRESET_BOT_COMPUTER_INIT_PROMPT =
  "请先检测当前系统的 Bot 电脑虚拟桌面环境状态；如果尚未创建或未就绪，请立即帮我完成初始化部署（computer_provision）并验证执行器与桌面画面可用。";

export const PRESET_BOT_COMPUTER_INIT_PROMPT_EN =
  "Check the current Bot Computer virtual desktop environment status. If not created or not ready yet, initialize it immediately using computer_provision and verify that the executor and desktop display are online.";

export function getBotComputerInitPrompt(locale: ResolvedLocale = "zh-CN"): string {
  return locale === "en" ? PRESET_BOT_COMPUTER_INIT_PROMPT_EN : PRESET_BOT_COMPUTER_INIT_PROMPT;
}

export function buildBotComputerSelfHealPrompt(
  computerStatus?: {
    state?: string;
    errorCode?: string;
    error?: string;
    detail?: string;
  } | null,
  locale: ResolvedLocale = "zh-CN"
): string {
  if (locale === "en") {
    const reason = String(
      computerStatus?.error || computerStatus?.detail || computerStatus?.errorCode || "abnormal state"
    ).trim();
    return `Bot's Computer is currently abnormal or not ready (${reason}). Run self-diagnostics and auto-repair now (prefer system_diagnostics or computer_provision to sync components, repair the service/token, and wake the desktop), then verify that the executor and display are back online.`;
  }
  const reason = String(
    computerStatus?.error || computerStatus?.detail || computerStatus?.errorCode || "状态异常"
  ).trim();
  return `当前「Bot 的电脑」状态异常或未就绪（${reason}）。请立即自动自检并完成自愈修复（优先调用 system_diagnostics 或 computer_provision 同步组件、修复服务/令牌并唤醒桌面），最后确认执行器与桌面画面恢复在线可用。`;
}

export const PROVIDER_PRESETS_UI: Record<
  string,
  {
    name: string;
    nameEn: string;
    shortLabel: string;
    shortLabelEn: string;
    hint: string;
    hintEn: string;
    baseUrl: string;
    billingCurrency: "USD" | "CNY";
    models: string;
    imageModels: string;
  }
> = {
  gemini: {
    name: "Google Gemini",
    nameEn: "Google Gemini",
    shortLabel: "Google Gemini",
    shortLabelEn: "Google Gemini",
    hint: "本地走 AI Studio (GEMINI_API_KEY)；GCP 服务器部署支持环境变量启用 Vertex AI",
    hintEn: "Uses AI Studio (GEMINI_API_KEY) locally; GCP server deployments can enable Vertex AI via env",
    baseUrl: "",
    billingCurrency: "USD",
    models: "gemini-4-hydrogen, gemini-4-argon, gemini-4-carbon",
    imageModels: "gemini-3.1-flash-image, gemini-3-pro-image, gemini-2.5-flash-image",
  },
  openai: {
    name: "OpenAI",
    nameEn: "OpenAI",
    shortLabel: "OpenAI",
    shortLabelEn: "OpenAI",
    hint: "官方 OpenAI 接口与 GPT / o 系列模型",
    hintEn: "Official OpenAI API for GPT and o-series models",
    baseUrl: "https://api.openai.com/v1",
    billingCurrency: "USD",
    models: "gpt-4o-mini, gpt-4o, o4-mini",
    imageModels: "",
  },
  deepseek: {
    name: "DeepSeek",
    nameEn: "DeepSeek",
    shortLabel: "DeepSeek",
    shortLabelEn: "DeepSeek",
    hint: "人民币原币计费，支持实时余额查询与缓存折扣",
    hintEn: "Native CNY billing with live balance check & context cache discount",
    baseUrl: "https://api.deepseek.com/v1",
    billingCurrency: "CNY",
    models: "deepseek-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner",
    imageModels: "",
  },
  "openai-compatible": {
    name: "自定义 OpenAI 兼容",
    nameEn: "Custom OpenAI-Compatible",
    shortLabel: "自定义兼容",
    shortLabelEn: "Custom",
    hint: "接入任意兼容 /v1/chat/completions 的网关或私有部署模型",
    hintEn: "Connect any gateway or self-hosted endpoint compatible with /v1/chat/completions",
    baseUrl: "",
    billingCurrency: "USD",
    models: "",
    imageModels: "",
  },
};

export function getProviderPresetUi(
  type: string,
  locale: ResolvedLocale = "zh-CN"
) {
  const raw = PROVIDER_PRESETS_UI[type] || PROVIDER_PRESETS_UI["openai-compatible"];
  const isEn = locale === "en";
  return {
    ...raw,
    name: isEn ? raw.nameEn : raw.name,
    shortLabel: isEn ? raw.shortLabelEn : raw.shortLabel,
    hint: isEn ? raw.hintEn : raw.hint,
  };
}

export const STATUS_LABELS: Record<string, string> = {
  idle: "空闲",
  running: "工作中",
  awaiting_approval: "待批准",
  awaiting_choice: "待选择",
  paused: "已接管",
  stopped: "已停止",
  done: "已完成",
  completed: "已完成",
  error: "错误",
  max_steps: "已达步数上限",
  interrupted: "已中断",
};

export const CLIENT_USD_TO_CNY = 7.25;

export const CLIENT_MODEL_RATES: Record<string, any> = {
  "gemini-4-carbon": {
    label: "Gemini 4 Carbon",
    shortLabel: "4 Carbon",
    role: "深度旗舰",
    roleEn: "Deep Flagship",
    accent: "violet",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.1,
    outputPer1M: 10.0,
  },
  "gemini-4-argon": {
    label: "Gemini 4 Argon",
    shortLabel: "4 Argon",
    role: "性能旗舰",
    roleEn: "Performance Flagship",
    accent: "blue",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.1,
    outputPer1M: 10.0,
  },
  "gemini-4-hydrogen": {
    label: "Gemini 4 Hydrogen",
    shortLabel: "4 Hydrogen",
    role: "轻量全能",
    roleEn: "Compact All-Rounder",
    accent: "emerald",
    inputPer1M: 1.5,
    cachedInputPer1M: 0.075,
    outputPer1M: 7.5,
  },
  "gemini-3.8-flash": {
    label: "Gemini 3.8 Flash",
    shortLabel: "3.8 Flash",
    role: "极速对话",
    roleEn: "Fast Chat",
    accent: "emerald",
    inputPer1M: 0.75,
    cachedInputPer1M: 0.075,
    outputPer1M: 3.75,
  },
  "gemini-3.1-flash-image": {
    label: "Nano Banana 2 (3.1 Flash Image)",
    shortLabel: "3.1 Flash Image",
    role: "图像生成",
    roleEn: "Image Generation",
    accent: "amber",
    inputPer1M: 0.5,
    cachedInputPer1M: 0.05,
    outputPer1M: 60.0,
  },
  "gemini-3-pro-image": {
    label: "Nano Banana Pro (3 Pro Image)",
    shortLabel: "3 Pro Image",
    role: "图像生成",
    roleEn: "Image Generation",
    accent: "rose",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.2,
    outputPer1M: 120.0,
  },
  "gemini-3.1-flash-lite-image": {
    label: "Nano Banana 2 Lite (3.1 Flash Lite Image)",
    shortLabel: "3.1 Lite Image",
    role: "图像生成",
    roleEn: "Image Generation",
    accent: "amber",
    inputPer1M: 0.25,
    cachedInputPer1M: 0.025,
    outputPer1M: 30.0,
  },
  "gemini-2.5-flash-image": {
    label: "Nano Banana (2.5 Flash Image)",
    shortLabel: "2.5 Flash Image",
    role: "图像生成",
    roleEn: "Image Generation",
    accent: "amber",
    inputPer1M: 0.3,
    cachedInputPer1M: 0.03,
    outputPer1M: 30.0,
  },
  "gpt-4o": {
    label: "GPT-4o",
    shortLabel: "GPT-4o",
    role: "OpenAI 旗舰",
    roleEn: "OpenAI Flagship",
    accent: "blue",
    inputPer1M: 2.5,
    cachedInputPer1M: 1.25,
    outputPer1M: 10.0,
  },
  "gpt-4o-mini": {
    label: "GPT-4o mini",
    shortLabel: "4o-mini",
    role: "OpenAI 极速",
    roleEn: "OpenAI Fast",
    accent: "emerald",
    inputPer1M: 0.15,
    cachedInputPer1M: 0.075,
    outputPer1M: 0.6,
  },
  "gpt-4.1": {
    label: "GPT-4.1",
    shortLabel: "GPT-4.1",
    role: "OpenAI 工程",
    roleEn: "OpenAI Coding",
    accent: "blue",
    inputPer1M: 2.0,
    cachedInputPer1M: 0.5,
    outputPer1M: 8.0,
  },
  "o4-mini": {
    label: "o4-mini",
    shortLabel: "o4-mini",
    role: "OpenAI 推理",
    roleEn: "OpenAI Reasoning",
    accent: "violet",
    inputPer1M: 1.1,
    cachedInputPer1M: 0.275,
    outputPer1M: 4.4,
  },
  "deepseek-flash": {
    label: "DeepSeek Flash",
    shortLabel: "DS-Flash",
    role: "DeepSeek 极速",
    roleEn: "DeepSeek Fast",
    accent: "emerald",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 2.0,
    cachedInputPer1M: 0.04,
    outputPer1M: 8.0,
  },
  "deepseek-v4-pro": {
    label: "DeepSeek V4 Pro",
    shortLabel: "DS-V4-Pro",
    role: "DeepSeek 旗舰",
    roleEn: "DeepSeek Flagship",
    accent: "violet",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 9.0,
    cachedInputPer1M: 0.3,
    outputPer1M: 27.0,
  },
  "deepseek-chat": {
    label: "DeepSeek Chat",
    shortLabel: "DS-Chat",
    role: "DeepSeek 对话",
    roleEn: "DeepSeek Chat",
    accent: "emerald",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 2.0,
    cachedInputPer1M: 0.5,
    outputPer1M: 8.0,
  },
  "deepseek-reasoner": {
    label: "DeepSeek Reasoner",
    shortLabel: "DS-R1",
    role: "DeepSeek 推理",
    roleEn: "DeepSeek Reasoning",
    accent: "violet",
    currency: "CNY",
    supportsOffPeakDiscount: true,
    inputPer1M: 4.0,
    cachedInputPer1M: 1.0,
    outputPer1M: 16.0,
  },
};

export const CLIENT_CN_HOLIDAYS = new Set([
  "2025-01-01",
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
  "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
  "2025-04-04", "2025-04-05", "2025-04-06",
  "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
  "2025-05-31", "2025-06-01", "2025-06-02",
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04",
  "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  "2026-10-05", "2026-10-06", "2026-10-07",
]);

export const DEFAULT_KIMI_CU_MCP_CONFIG = {
  type: "stdio",
  command: "/Applications/KimiCU.app/Contents/MacOS/kimi-cu",
  args: ["mcp", "-s", "user"],
};

export function resolveHostPlatformHint(
  hostPlatform?: string | null
): "darwin" | "win32" | "linux" | "" {
  const raw = String(hostPlatform || "").trim().toLowerCase();
  if (raw === "darwin" || raw === "macos" || raw === "mac") return "darwin";
  if (raw === "win32" || raw === "windows" || raw === "win") return "win32";
  if (raw === "linux") return "linux";
  if (typeof window !== "undefined") {
    const deskPlat = String((window as any)?.twinklebotDesktop?.platform || "").toLowerCase();
    if (deskPlat === "darwin" || deskPlat === "win32" || deskPlat === "linux") {
      return deskPlat as "darwin" | "win32" | "linux";
    }
  }
  if (typeof navigator !== "undefined") {
    const ua = String(navigator.userAgent || "");
    if (/Windows/i.test(ua)) return "win32";
    if (/Macintosh|Mac OS X/i.test(ua)) return "darwin";
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
  }
  return "";
}

export function getDefaultKimiCuConfig(hostPlatform?: string | null) {
  const plat = resolveHostPlatformHint(hostPlatform);
  return {
    type: "stdio",
    command: plat && plat !== "darwin" ? "" : DEFAULT_KIMI_CU_MCP_CONFIG.command,
    args: [...DEFAULT_KIMI_CU_MCP_CONFIG.args],
  };
}

export function getFileManagerLabel(
  hostPlatform?: string | null,
  locale: ResolvedLocale = "zh-CN"
): string {
  const plat = resolveHostPlatformHint(hostPlatform);
  if (locale === "en") {
    if (plat === "darwin") return "Finder";
    if (plat === "win32") return "File Explorer";
    return "File Manager";
  }
  if (plat === "darwin") return "访达";
  if (plat === "win32") return "资源管理器";
  return "文件管理器";
}

export const SKILL_FALLBACK_CATALOG = {
  platform: [
    {
      id: "kimi-cu",
      name: "KimiCU 桌面软件操控",
      nameEn: "KimiCU Desktop Control",
      desc: "通过本地 KimiCU MCP 服务无感后台操控任意 Mac 桌面软件（不抢占物理鼠标指针）",
      descEn: "Control macOS desktop apps silently via local KimiCU MCP without hijacking the cursor",
      icon: "🖱️",
      category: "platform",
      builtin: false,
      removable: true,
      supportedPlatforms: ["darwin"],
      installed: false,
      mcpServerId: "kimi-cu",
      toolCount: 20,
    },
  ],
  office: [
    {
      id: "qqmail",
      name: "QQ 邮箱",
      nameEn: "QQ Mail",
      desc: "绑定多个 QQ 邮箱，IMAP/POP3 收信 + SMTP 发信",
      descEn: "Bind multiple QQ Mail accounts for IMAP/POP3 receiving & SMTP sending",
      icon: "✉️",
      installed: true,
      accountCount: 0,
      savedAccountCount: 0,
    },
    {
      id: "custom-mail",
      name: "通用邮箱",
      nameEn: "Generic Email",
      desc: "POP3 / IMAP + SMTP 接入 163、企业邮、Outlook 等",
      descEn: "Connect 163, enterprise mail, Outlook, Gmail, and more via POP3/IMAP + SMTP",
      icon: "📬",
      installed: true,
      accountCount: 0,
      savedAccountCount: 0,
    },
  ],
};

export const BG_MODES = [
  { key: "light" as const, label: "浅色底", labelEn: "Light" },
  { key: "grid" as const, label: "透明格", labelEn: "Grid" },
  { key: "dark" as const, label: "深色底", labelEn: "Dark" },
];

export function getBgModes(locale: ResolvedLocale = "zh-CN") {
  return BG_MODES.map((m) => ({
    key: m.key,
    label: locale === "en" ? m.labelEn : m.label,
  }));
}

export const PROFILE_COLORS = [
  { key: "slate", label: "石墨灰", labelEn: "Slate" },
  { key: "blue", label: "海湾蓝", labelEn: "Gulf Blue" },
  { key: "violet", label: "极光紫", labelEn: "Aurora Violet" },
  { key: "emerald", label: "翡翠绿", labelEn: "Emerald" },
  { key: "amber", label: "琥珀橙", labelEn: "Amber" },
  { key: "rose", label: "珊瑚粉", labelEn: "Coral" },
];

export function getProfileColors(locale: ResolvedLocale = "zh-CN") {
  return PROFILE_COLORS.map((c) => ({
    key: c.key,
    label: locale === "en" ? c.labelEn : c.label,
  }));
}
