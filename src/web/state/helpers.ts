import type { ResolvedLocale } from "./constants.js";
import {
  CLIENT_CN_HOLIDAYS,
  CLIENT_MODEL_RATES,
  CLIENT_USD_TO_CNY,
  DEFAULT_KIMI_CU_MCP_CONFIG,
  getDefaultKimiCuConfig,
  getFileManagerLabel,
  SKILL_FALLBACK_CATALOG,
} from "./constants.js";

export const previewFrameRegistry = new Map<string, HTMLIFrameElement>();
let previewSeqCounter = 0;

export function nextPreviewInstanceId(): string {
  previewSeqCounter += 1;
  return `gb-prev-${previewSeqCounter}`;
}

export function teardownPreviewIframe(iframe: HTMLIFrameElement | null | undefined) {
  if (!iframe) return;
  try {
    iframe.contentWindow?.postMessage({ __twinklebotPreviewTeardown: true }, "*");
  } catch {}
  try {
    iframe.removeAttribute("srcdoc");
  } catch {}
  try {
    iframe.src = "about:blank";
  } catch {}
}

export function teardownAllPreviewFrames({ includeModal = true } = {}) {
  const seen = new Set<HTMLIFrameElement>();
  for (const iframe of previewFrameRegistry.values()) {
    if (iframe && !seen.has(iframe)) {
      seen.add(iframe);
      teardownPreviewIframe(iframe);
    }
  }
  previewFrameRegistry.clear();
  if (typeof document !== "undefined") {
    const streamEl = document.getElementById("event-stream");
    if (streamEl) {
      for (const iframe of streamEl.querySelectorAll<HTMLIFrameElement>("iframe.msg-preview-iframe")) {
        if (!seen.has(iframe)) {
          seen.add(iframe);
          teardownPreviewIframe(iframe);
        }
      }
    }
    if (includeModal) {
      const dialog = document.getElementById("html-preview-dialog") as HTMLDialogElement | null;
      const modalFrame = document.getElementById("html-preview-modal-frame") as HTMLIFrameElement | null;
      if (modalFrame) teardownPreviewIframe(modalFrame);
      if (dialog?.open) {
        try {
          dialog.close();
        } catch {}
      }
    }
  }
}

export function isSessionCurrentlyBusy(status = "idle"): boolean {
  return (
    status === "running" ||
    status === "waiting_screen" ||
    status === "awaiting_approval" ||
    status === "awaiting_choice" ||
    status === "paused"
  );
}

export function isImeConfirmEnter(event: { isComposing?: boolean; keyCode?: number; timeStamp: number; nativeEvent?: any }, lastCompEndAt: number | null = null): boolean {
  const isComposing = event.isComposing || event.nativeEvent?.isComposing;
  const keyCode = event.keyCode ?? event.nativeEvent?.keyCode;
  if (isComposing || keyCode === 229) return true;
  if (lastCompEndAt !== null && Math.abs(event.timeStamp - lastCompEndAt) < 50) {
    return true;
  }
  return false;
}

export const LIVE_SUMMARY_LEAK_RE =
  /(\brun_shell\b|\bhost_run_shell\b|\bmcp__[a-z0-9_]+\b|\bread_file\b|\bwrite_file\b|\bhost_read_file\b|\bhost_write_file\b|\bbrowser_snapshot\b|\bfunction_call\b|\/Users\/|\/etc\/|\/var\/|\/tmp\/|&&|\|\||sudo\s)/i;
export const LIVE_SUMMARY_PUNCT_RE = /[\p{P}\p{S}\s]+/gu;
export const LIVE_SUMMARY_MAX_CHARS = 9;

export function normalizeLiveSummaryPhrase(text = ""): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const full = raw.replace(LIVE_SUMMARY_PUNCT_RE, "").trim();
  if (!full) return "";
  if (Array.from(full).length <= LIVE_SUMMARY_MAX_CHARS) return full;

  const firstClause = raw
    .split(/[，,。！？!?;；、…—]+/)
    .map((part) => part.replace(LIVE_SUMMARY_PUNCT_RE, "").trim())
    .find(Boolean);
  if (
    firstClause &&
    Array.from(firstClause).length >= 3 &&
    Array.from(firstClause).length <= LIVE_SUMMARY_MAX_CHARS
  ) {
    return firstClause;
  }

  return Array.from(full).slice(0, LIVE_SUMMARY_MAX_CHARS).join("");
}

export function sanitizeLiveThinkingSummary(
  rawText = "",
  fallback?: string,
  locale: ResolvedLocale = "zh-CN"
): string {
  const defaultFallback = locale === "en" ? "Thinking…" : "正在思考处理中";
  const resolvedFallback = fallback ?? defaultFallback;
  const safeFallback = normalizeLiveSummaryPhrase(resolvedFallback) || defaultFallback;
  const firstLine =
    String(rawText || "")
      .replace(/[`*_~#>]/g, "")
      .replace(/^["'“‘「『]+|["'”’」』]+$/g, "")
      .replace(/^\d+[.)、]\s*/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] || "";
  if (!firstLine) return safeFallback;
  if (LIVE_SUMMARY_LEAK_RE.test(firstLine)) return safeFallback;
  return normalizeLiveSummaryPhrase(firstLine) || safeFallback;
}

export function getLiveWorkingLabel(
  sessionStatus: string,
  liveThinkingSummary: string,
  locale: ResolvedLocale = "zh-CN"
): string {
  const isEn = locale === "en";
  switch (sessionStatus) {
    case "waiting_screen":
      return isEn ? "Waiting for free screen…" : "等待空闲屏幕排队中";
    case "awaiting_approval":
      return isEn ? "Awaiting approval" : "等待确认当前操作";
    case "awaiting_choice":
      return isEn ? "Awaiting your choice" : "等待你的选择确认";
    case "paused":
      return isEn ? "Takeover active" : "已接管等待恢复";
    default:
      return sanitizeLiveThinkingSummary(
        liveThinkingSummary,
        isEn ? "Thinking…" : "正在思考处理中",
        locale
      );
  }
}

export function translateToolHumanSummary(
  toolName: string,
  args: any = {},
  locale: ResolvedLocale = "zh-CN"
): string {
  const isEn = locale === "en";
  const name = String(toolName || "");
  if (name === "generate_image") {
    const subject = String(args?.title || args?.prompt || (isEn ? "Image" : "图片")).trim();
    const shortSubject = subject.slice(0, 26) + (subject.length > 26 ? "…" : "");
    const fmt = String(args?.output_format || "").trim().toUpperCase();
    if (isEn) {
      return fmt ? `Generating image "${shortSubject}" (${fmt})` : `Generating image "${shortSubject}"`;
    }
    return fmt
      ? `正在生成图片「${shortSubject}」（${fmt}）`
      : `正在生成图片「${shortSubject}」`;
  }
  if (name === "host_run_shell") {
    const cmd = String(args?.command || "").trim();
    if (isEn) {
      return cmd
        ? `Running on your computer: ${cmd.slice(0, 48)}${cmd.length > 48 ? "…" : ""}`
        : "Running shell command on your computer";
    }
    return cmd
      ? `在你的电脑终端运行：${cmd.slice(0, 48)}${cmd.length > 48 ? "…" : ""}`
      : "在你的电脑终端执行命令";
  }
  if (name === "host_open") {
    if (args?.reveal) {
      const fm = getFileManagerLabel(undefined, locale);
      return isEn ? `Revealing in ${fm}: ${args?.target || ""}` : `在${fm}中定位：${args?.target || ""}`;
    }
    const label = args?.app
      ? `${args.app}${args?.target ? ` (${args.target})` : ""}`
      : args?.target || (isEn ? "local app or file" : "本地应用或文件");
    return isEn ? `Opening on your computer: ${label}` : `在你的电脑打开：${label}`;
  }
  if (name === "host_read_file") {
    return isEn ? `Reading computer file: ${args?.path || ""}` : `读取你的电脑文件：${args?.path || ""}`;
  }
  if (name === "host_write_file") {
    return isEn ? `Writing computer file: ${args?.path || ""}` : `写入你的电脑文件：${args?.path || ""}`;
  }
  if (name.startsWith("mcp__kimi_cu__")) {
    const sub = name.slice("mcp__kimi_cu__".length);
    if (sub === "list_apps" || sub === "list_windows") {
      return isEn ? "Listing running Mac apps and windows" : "正在枚举你的 Mac 运行中的应用与窗口";
    }
    if (sub === "get_app_state") {
      return isEn
        ? `Inspecting Mac app menus & state${args?.app ? ` (${args.app})` : ""}`
        : `正在探测 Mac 应用菜单与状态${args?.app ? `（${args.app}）` : ""}`;
    }
    if (sub === "get_window") {
      const suffix = args?.app ? `(${args.app})` : args?.window_id ? `(#${args.window_id})` : "";
      return isEn
        ? `Capturing Mac window${suffix ? ` ${suffix}` : ""}`
        : `正在后台截取并查看 Mac 窗口${args?.app ? `（${args.app}）` : args?.window_id ? `（#${args.window_id}）` : ""}`;
    }
    if (sub === "get_window_state") {
      return isEn
        ? `Reading Mac window accessibility tree${args?.window_id ? ` (#${args.window_id})` : ""}`
        : `正在读取 Mac 窗口控件树${args?.window_id ? `（#${args.window_id}）` : ""}`;
    }
    if (sub === "launch_app") {
      return isEn
        ? `Launching Mac app${args?.app ? ` (${args.app})` : ""}`
        : `正在启动 Mac 应用${args?.app ? `（${args.app}）` : ""}`;
    }
    if (sub === "activate_window") {
      return isEn
        ? `Activating Mac window${args?.window_id ? ` (#${args.window_id})` : ""}`
        : `正在激活 Mac 窗口${args?.window_id ? `（#${args.window_id}）` : ""}`;
    }
    if (sub === "click" || sub === "perform_secondary_action") {
      return isEn
        ? "Clicking Mac UI element in background (cursor-safe)"
        : "正在后台点击 Mac 软件界面元素（不抢占物理鼠标）";
    }
    if (sub === "type_text" || sub === "paste" || sub === "set_value") {
      return isEn
        ? "Typing text into Mac window in background"
        : "正在向 Mac 软件窗口后台输入内容";
    }
    if (sub === "press_key") {
      return isEn
        ? `Sending key to Mac window${args?.key ? ` (${args.key})` : ""}`
        : `正在向 Mac 窗口发送按键${args?.key ? `（${args.key}）` : ""}`;
    }
    if (sub === "scroll") {
      return isEn ? "Scrolling Mac window in background" : "正在后台滚动 Mac 软件窗口";
    }
    if (sub === "js") {
      return isEn
        ? `Running JS in Mac app webview${args?.window_id ? ` (#${args.window_id})` : ""}`
        : `正在操控 Mac 应用内嵌页面${args?.window_id ? `（#${args.window_id}）` : ""}`;
    }
    return isEn ? `Operating Mac app via KimiCU (${sub})` : `正在通过 KimiCU 操控 Mac 软件（${sub}）`;
  }
  if (name === "run_shell") {
    const cmd = String(args?.command || "").trim();
    if (isEn) {
      return cmd
        ? `Running shell command: ${cmd.slice(0, 48)}${cmd.length > 48 ? "…" : ""}`
        : "Running shell command";
    }
    return cmd
      ? `在电脑终端运行命令：${cmd.slice(0, 48)}${cmd.length > 48 ? "…" : ""}`
      : "在电脑终端执行命令";
  }
  if (name === "write_file") {
    return isEn
      ? `Writing file: ${args?.path || "workspace file"}`
      : `写入文件：${args?.path || "工作区文件"}`;
  }
  if (name === "read_file") {
    return isEn
      ? `Reading file: ${args?.path || "workspace file"}`
      : `读取文件：${args?.path || "工作区文件"}`;
  }
  if (name === "open_url") {
    return isEn ? `Opening URL in browser: ${args?.url || ""}` : `在浏览器打开网页：${args?.url || ""}`;
  }
  if (name === "browser_snapshot") {
    if (isEn) {
      return args?.url ? `Inspecting webpage: ${args.url}` : "Reading current page structure";
    }
    return args?.url ? `在浏览器查看网页：${args.url}` : "正在读取当前网页结构";
  }
  if (name === "browser_click") {
    return isEn
      ? `Clicking element ${args?.ref || ""}`.trim()
      : `在网页中点击元素 ${args?.ref || ""}`.trim();
  }
  if (name === "browser_type") {
    return isEn
      ? `Typing into input ${args?.ref || ""}`.trim()
      : `在网页输入框 ${args?.ref || ""} 填入内容`.trim();
  }
  if (name === "browser_tabs") {
    return isEn
      ? `Managing browser tabs (${args?.action || "list"})`
      : `管理浏览器标签页（${args?.action || "list"}）`;
  }
  if (name === "browser_scroll") {
    return isEn
      ? `Scrolling page ${args?.direction || "down"}`
      : `在网页中向${args?.direction || "down"}滚动页面`;
  }
  if (name === "browser_wait") {
    if (isEn) {
      return args?.text
        ? `Waiting for text "${String(args.text).slice(0, 24)}"`
        : "Waiting for page to load";
    }
    return args?.text ? `等待网页出现「${String(args.text).slice(0, 24)}」` : "等待网页加载完成";
  }
  if (name === "browser_select") {
    return isEn
      ? `Selecting "${args?.label || args?.value || ""}" in ${args?.ref || "dropdown"}`
      : `在网页下拉框 ${args?.ref || ""} 选择「${args?.label || args?.value || ""}」`;
  }
  if (name === "browser_upload_file") {
    const count = Array.isArray(args?.paths) ? args.paths.length : 1;
    return isEn
      ? `Uploading ${count} file(s) to ${args?.ref || "input"}`
      : `向网页文件框 ${args?.ref || ""} 上传 ${count} 个文件`;
  }
  if (name === "screenshot") {
    return isEn ? "Capturing Bot Computer screen" : "正在查看电脑桌面画面";
  }
  if (name === "click" || name === "double_click" || name === "right_click") {
    return isEn
      ? `Clicking desktop at (${args?.x ?? "?"}, ${args?.y ?? "?"})`
      : `在桌面点击位置 (${args?.x ?? "?"}, ${args?.y ?? "?"})`;
  }
  if (name === "type_text") return isEn ? "Typing text on desktop" : "正在向桌面窗口输入文字";
  if (name === "key") {
    return isEn ? `Pressing key ${args?.combo || args?.key || ""}` : `按下快捷键 ${args?.combo || args?.key || ""}`;
  }
  if (name === "create_bot") {
    return isEn ? `Creating specialized bot "${args?.name || ""}"` : `正在创建专职新 Bot「${args?.name || ""}」`;
  }
  if (name === "send_bot_message") {
    return isEn ? "Handing off task to collaborator bot" : "正在向协作 Bot 交接任务";
  }
  if (name === "mail_list_accounts") {
    return isEn ? "Listing connected email accounts" : "正在查看已绑定的全部邮箱账号";
  }
  if (name === "mail_list_messages") {
    return isEn
      ? `Fetching inbox messages${args?.account ? ` (${args.account})` : ""}`
      : `正在拉取邮箱收件箱列表${args?.account ? `（${args.account}）` : ""}`;
  }
  if (name === "mail_read_message") {
    return isEn
      ? `Reading email #${args?.uid || ""}${args?.account ? ` (${args.account})` : ""}`
      : `正在读取邮件正文 #${args?.uid || ""}${args?.account ? `（${args.account}）` : ""}`;
  }
  if (name === "mail_send_message") {
    return isEn
      ? `Preparing email to ${args?.to || ""}${args?.account ? ` (via ${args.account})` : ""}`
      : `正在准备发送邮件至 ${args?.to || ""}${args?.account ? `（使用 ${args.account}）` : ""}`;
  }
  if (name === "memory_manage") {
    const scopeLabel =
      args?.scope === "global"
        ? isEn
          ? "global memory"
          : "全局记忆"
        : isEn
          ? "bot memory"
          : "专属记忆";
    if (args?.action === "save") {
      return isEn
        ? `Saving ${scopeLabel}: "${args?.name || String(args?.content || "").slice(0, 18)}"`
        : `正在写入${scopeLabel}：「${args?.name || String(args?.content || "").slice(0, 18)}」`;
    }
    if (args?.action === "remove") {
      return isEn
        ? `Removing ${scopeLabel}: "${args?.memory || args?.name || ""}"`
        : `正在移除${scopeLabel}：「${args?.memory || args?.name || ""}」`;
    }
    if (args?.action === "toggle") {
      return isEn
        ? `Updating ${scopeLabel}: "${args?.memory || args?.name || ""}"`
        : `正在更新${scopeLabel}状态：「${args?.memory || args?.name || ""}」`;
    }
    return isEn ? `Viewing ${scopeLabel}` : `正在查看${scopeLabel}`;
  }
  return isEn ? `Running action: ${name || "step"}` : `正在执行操作：${name || "步骤"}`;
}

export function summarizeArgs(args: any): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args)
    .filter(([k]) => k !== "risk")
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${val.length > 36 ? `${val.slice(0, 36)}…` : val}`;
    })
    .join(" · ");
}

export function buildNovncSrc(
  novncUrl: string,
  viewOnly = true,
  activeBaseUrl = "",
  activeAuthToken = "",
  displayTarget?: { sessionId?: string | null; botId?: string | null }
): string {
  if (!novncUrl) return "about:blank";
  const viewOnlyFlag = viewOnly ? "1" : "0";
  const sid = String(displayTarget?.sessionId || "").trim();
  const bid = String(displayTarget?.botId || "").trim();
  try {
    const baseStr =
      activeBaseUrl || (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3230");
    const baseUrl = new URL(baseStr);
    const basePath = baseUrl.pathname.replace(/\/+$/, "");
    const rawUrl = new URL(novncUrl, baseUrl);
    const shouldProxy =
      !rawUrl.pathname.includes("/novnc/") &&
      (rawUrl.pathname.endsWith("/vnc.html") ||
        rawUrl.pathname.endsWith("/vnc_auto.html") ||
        rawUrl.pathname.endsWith("/vnc_lite.html"));
    const url = shouldProxy
      ? new URL(`${basePath}/novnc${rawUrl.pathname}${rawUrl.search}`, baseUrl.origin)
      : rawUrl.pathname.startsWith("/novnc/") && basePath && !rawUrl.pathname.startsWith(`${basePath}/`)
        ? new URL(`${basePath}${rawUrl.pathname}${rawUrl.search}`, baseUrl.origin)
        : rawUrl;
    url.searchParams.set("autoconnect", "1");
    url.searchParams.set("resize", "scale");
    url.searchParams.set("view_only", viewOnlyFlag);
    url.searchParams.set("cursor_mode", "native");
    if (url.pathname.includes("/novnc/")) {
      if (activeAuthToken && !url.searchParams.has("token")) {
        url.searchParams.set("token", activeAuthToken);
      }
      const wsPrefix = basePath ? `${basePath.replace(/^\/+/, "")}/` : "";
      const wsParams = new URLSearchParams();
      if (activeAuthToken) wsParams.set("token", activeAuthToken);
      if (sid) wsParams.set("sessionId", sid);
      if (bid) wsParams.set("botId", bid);
      const qs = wsParams.toString();
      const wsPath = qs ? `${wsPrefix}novnc/websockify?${qs}` : `${wsPrefix}novnc/websockify`;
      url.searchParams.set("path", wsPath);
    }
    return url.toString();
  } catch {
    const sep = novncUrl.includes("?") ? "&" : "?";
    return `${novncUrl}${sep}autoconnect=1&resize=scale&view_only=${viewOnlyFlag}&cursor_mode=native`;
  }
}

export function isClientDeepSeekOffPeak(timestamp?: number | string | Date | null): boolean {
  if (timestamp === undefined || timestamp === null || timestamp === "") return false;
  const ms =
    timestamp instanceof Date
      ? timestamp.getTime()
      : typeof timestamp === "number"
        ? timestamp
        : Date.parse(String(timestamp));
  if (!Number.isFinite(ms) || ms <= 0) return false;
  const bj = new Date(ms + 8 * 3_600_000);
  const dow = bj.getUTCDay();
  if (dow === 0 || dow === 6) return true;
  const yyyy = bj.getUTCFullYear();
  const mm = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bj.getUTCDate()).padStart(2, "0");
  if (CLIENT_CN_HOLIDAYS.has(`${yyyy}-${mm}-${dd}`)) return true;
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const isMorningPeak = mins >= 9 * 60 && mins < 12 * 60;
  const isAfternoonPeak = mins >= 14 * 60 && mins < 18 * 60;
  return !(isMorningPeak || isAfternoonPeak);
}

export function getClientModelMeta(
  modelName = "",
  locale: ResolvedLocale = "zh-CN"
) {
  const isEn = locale === "en";
  const localize = (m: any) => ({
    ...m,
    role: isEn ? m.roleEn || m.role : m.role,
  });
  let clean = String(modelName || "").trim();
  const sepIdx = clean.indexOf("::");
  if (sepIdx !== -1) clean = clean.slice(sepIdx + 2).trim();
  const id = clean.replace(/^models\//i, "") || "gemini-4-argon";
  if (CLIENT_MODEL_RATES[id]) return localize({ model: id, ...CLIENT_MODEL_RATES[id] });
  const lower = id.toLowerCase();
  if (CLIENT_MODEL_RATES[lower]) return localize({ model: lower, ...CLIENT_MODEL_RATES[lower] });
  if (lower.startsWith("deepseek")) {
    if (lower.includes("v4-pro") || lower.includes("pro")) {
      const isCanon = lower.startsWith("deepseek-v4-pro");
      return localize({
        ...CLIENT_MODEL_RATES["deepseek-v4-pro"],
        model: isCanon ? "deepseek-v4-pro" : id,
        label: isCanon ? "DeepSeek V4 Pro" : id,
      });
    }
    if (lower.includes("reasoner") || lower.includes("r1")) {
      const isCanon = lower.startsWith("deepseek-reasoner");
      return localize({
        ...CLIENT_MODEL_RATES["deepseek-reasoner"],
        model: isCanon ? "deepseek-reasoner" : id,
        label: isCanon ? "DeepSeek Reasoner" : id,
      });
    }
    if (lower.includes("flash")) {
      const isCanon =
        lower === "deepseek-flash" ||
        lower.startsWith("deepseek-v4-flash") ||
        lower.startsWith("deepseek-v4.1-flash");
      return localize({
        ...CLIENT_MODEL_RATES["deepseek-flash"],
        model: isCanon ? "deepseek-flash" : id,
        label: isCanon ? "DeepSeek Flash" : id,
      });
    }
    const isCanon = lower.startsWith("deepseek-chat");
    return localize({
      ...CLIENT_MODEL_RATES["deepseek-chat"],
      model: isCanon ? "deepseek-chat" : id,
      label: isCanon ? "DeepSeek Chat" : id,
    });
  }
  if (lower.includes("image") || lower.includes("imagen")) {
    if (lower.includes("pro")) {
      return localize({ ...CLIENT_MODEL_RATES["gemini-3-pro-image"], model: id, label: id });
    }
    return localize({ ...CLIENT_MODEL_RATES["gemini-3.1-flash-image"], model: id, label: id });
  }
  if (lower.includes("carbon")) {
    return localize({ ...CLIENT_MODEL_RATES["gemini-4-carbon"], model: id, label: id });
  }
  if (lower.includes("argon") || lower.includes("pro")) {
    return localize({ ...CLIENT_MODEL_RATES["gemini-4-argon"], model: id, label: id });
  }
  if (lower.includes("hydrogen")) {
    return localize({
      ...CLIENT_MODEL_RATES["gemini-4-hydrogen"],
      model: id,
      label: lower === "gemini-4-hydrogen" ? "Gemini 4 Hydrogen" : id,
    });
  }
  if (lower.includes("flash-lite") || lower.includes("lite")) {
    return {
      model: id,
      label: id,
      shortLabel: "Flash Lite",
      role: isEn ? "Fast Chat" : "极速对话",
      roleEn: "Fast Chat",
      accent: "emerald",
      inputPer1M: 0.25,
      cachedInputPer1M: 0.025,
      outputPer1M: 1.5,
    };
  }
  if (lower.includes("flash")) {
    return {
      model: id,
      label: lower === "gemini-3.8-flash" ? "Gemini 3.8 Flash" : id,
      shortLabel: "3.8 Flash",
      role: isEn ? "Fast Chat" : "极速对话",
      roleEn: "Fast Chat",
      accent: "emerald",
      inputPer1M: 0.75,
      cachedInputPer1M: 0.075,
      outputPer1M: 3.75,
    };
  }
  return localize({
    ...CLIENT_MODEL_RATES["gemini-4-argon"],
    model: id,
    label: id,
    shortLabel: id,
    accent: "slate",
  });
}

export function formatCny(cny: unknown): string {
  const v = Math.max(0, Number(cny) || 0);
  if (v === 0) return "¥0.00";
  if (v < 0.01) return `¥${v.toFixed(4)}`;
  if (v < 0.1) return `¥${v.toFixed(3)}`;
  return `¥${v.toFixed(2)}`;
}

export function resolveClientProviderForModel(
  providersInput: any[],
  modelId = "",
  explicitProviderId = ""
) {
  const providers = Array.isArray(providersInput) ? providersInput : [];
  if (explicitProviderId) {
    const exact = providers.find((p) => p.id === explicitProviderId) || null;
    return {
      providerId: explicitProviderId,
      provider: exact,
      enabled: exact ? exact.enabled !== false : true,
    };
  }
  const norm = getClientModelMeta(modelId).model;
  const lower = norm.toLowerCase();
  const hasModel = (p: any) =>
    [...(p.models || []), ...(p.imageModels || [])]
      .map((m) => String(m || "").replace(/^models\//i, "").trim())
      .includes(norm);
  const enabledMatch = providers.find((p) => p.enabled !== false && hasModel(p));
  if (enabledMatch) return { providerId: enabledMatch.id, provider: enabledMatch, enabled: true };
  const anyMatch = providers.find((p) => hasModel(p));
  if (anyMatch) {
    return { providerId: anyMatch.id, provider: anyMatch, enabled: anyMatch.enabled !== false };
  }
  const byType = (types: string[]) =>
    providers.find((p) => p.enabled !== false && types.includes(p.type)) ||
    providers.find((p) => types.includes(p.type)) ||
    null;
  let matched: any = null;
  if (lower.startsWith("deepseek")) matched = byType(["deepseek"]);
  else if (lower.startsWith("gemini") || lower.startsWith("imagen")) matched = byType(["gemini"]);
  else if (/^(gpt-|o[134]-|dall-e|tts-)/.test(lower)) matched = byType(["openai", "openai-compatible"]);
  if (matched) {
    return { providerId: matched.id, provider: matched, enabled: matched.enabled !== false };
  }
  return { providerId: "", provider: null, enabled: true };
}

export function formatClientRouteLabel(
  rawLabel: unknown,
  modelName = "",
  locale: ResolvedLocale = "zh-CN"
): string {
  const isEn = locale === "en";
  const label = String(rawLabel || "").trim();
  if (!label) return "";
  if (label === "跨 Bot 协同") return isEn ? "Cross-Bot Collab" : label;
  if (label === "自动调配") return isEn ? "Auto Routing" : label;
  const labelLower = label.toLowerCase();
  const src = label.includes(" · ")
    ? labelLower
    : `${labelLower} ${String(modelName || "").toLowerCase()}`;
  if (src.includes("carbon")) return isEn ? "Deep Flagship · Carbon" : "深度旗舰 · Carbon";
  if (src.includes("argon")) return isEn ? "Flagship · Argon" : "性能旗舰 · Argon";
  if (src.includes("hydrogen")) return isEn ? "Compact · Hydrogen" : "轻量全能 · Hydrogen";
  if (src.includes("flash")) return isEn ? "Fast Chat · Flash" : "极速对话 · Flash";
  return label;
}

export function estimateClientTurnCost(
  providersInput: any[],
  rawModel = "",
  usage: { input?: number; output?: number; cached?: number } = {},
  explicitProviderId = "",
  timestamp?: number | string | Date | null
) {
  const provInfo = resolveClientProviderForModel(providersInput, rawModel, explicitProviderId);
  const meta: any = getClientModelMeta(rawModel);
  const inp = Math.max(0, Number(usage?.input) || 0);
  const cached = Math.min(inp, Math.max(0, Number(usage?.cached) || 0));
  const uncached = Math.max(0, inp - cached);
  const out = Math.max(0, Number(usage?.output) || 0);
  const catalogCurr = meta.currency || "USD";
  const provCurr =
    provInfo.provider?.billingCurrency === "CNY" || provInfo.provider?.billingCurrency === "USD"
      ? provInfo.provider.billingCurrency
      : provInfo.provider?.type === "deepseek"
        ? "CNY"
        : catalogCurr;
  const scale =
    provCurr === catalogCurr ? 1 : provCurr === "CNY" ? CLIENT_USD_TO_CNY : 1 / CLIENT_USD_TO_CNY;
  const mult =
    meta.supportsOffPeakDiscount && timestamp ? (isClientDeepSeekOffPeak(timestamp) ? 0.5 : 1) : 1;
  const mNative =
    ((uncached / 1_000_000) * meta.inputPer1M * scale +
      (cached / 1_000_000) * meta.cachedInputPer1M * scale +
      (out / 1_000_000) * meta.outputPer1M * scale) *
    mult;
  const costCny = provCurr === "CNY" ? mNative : mNative * CLIENT_USD_TO_CNY;
  const costUsd = provCurr === "USD" ? mNative : mNative / CLIENT_USD_TO_CNY;
  return { costNative: mNative, costCny, costUsd, currency: provCurr };
}

export function computeClientSessionSummary(params: {
  providers: any[];
  sessionUsageByProviderModel: Record<string, any>;
  sessionUsageByModel: Record<string, any>;
  usage: { input: number; output: number };
  lastObservedModel: string;
  locale?: ResolvedLocale;
}) {
  const pmEntries = Object.entries(params.sessionUsageByProviderModel || {});
  const entries = Object.entries(params.sessionUsageByModel || {});
  const buckets: Array<[string, any]> =
    pmEntries.length > 0
      ? pmEntries
      : entries.length > 0
        ? entries
        : (Number(params.usage?.input) || 0) + (Number(params.usage?.output) || 0) > 0
          ? [[params.lastObservedModel || "gemini-4-argon", params.usage]]
          : [];

  let costUsd = 0;
  let costCny = 0;
  const byModelMap = new Map<string, any>();

  for (const [rawKey, b] of buckets) {
    let explicitProviderId = "";
    let rawModel = rawKey;
    const sep = rawKey.indexOf("::");
    if (sep !== -1) {
      explicitProviderId = rawKey.slice(0, sep).trim();
      rawModel = rawKey.slice(sep + 2).trim();
    }
    const provInfo = resolveClientProviderForModel(params.providers, rawModel, explicitProviderId);
    if (!provInfo.enabled) continue;

    const meta: any = getClientModelMeta(rawModel, params.locale || "zh-CN");
    const inp = Math.max(0, Number((b as any)?.input) || 0);
    const cached = Math.min(inp, Math.max(0, Number((b as any)?.cached) || 0));
    const uncached = Math.max(0, inp - cached);
    const out = Math.max(0, Number((b as any)?.output) || 0);
    const thoughts = Math.max(0, Number((b as any)?.thoughts) || 0);
    const totalTokens = inp + out;
    if (totalTokens <= 0) continue;

    const catalogCurr = meta.currency || "USD";
    const provCurr =
      provInfo.provider?.billingCurrency === "CNY" || provInfo.provider?.billingCurrency === "USD"
        ? provInfo.provider.billingCurrency
        : provInfo.provider?.type === "deepseek"
          ? "CNY"
          : catalogCurr;
    const scale =
      provCurr === catalogCurr ? 1 : provCurr === "CNY" ? CLIENT_USD_TO_CNY : 1 / CLIENT_USD_TO_CNY;
    const inRate = meta.inputPer1M * scale;
    const cachedRate = meta.cachedInputPer1M * scale;
    const outRate = meta.outputPer1M * scale;

    let mCny: number;
    let mUsd: number;
    if ((b as any)?.hasExactCost === true && typeof (b as any)?.costCny === "number") {
      mCny = Math.max(0, Number((b as any).costCny) || 0);
      mUsd =
        typeof (b as any)?.costUsd === "number"
          ? Math.max(0, Number((b as any).costUsd) || 0)
          : mCny / CLIENT_USD_TO_CNY;
    } else if (
      (b as any)?.costVersion === 2 &&
      typeof (b as any)?.costNative === "number" &&
      (!(b as any)?.costCurrency || (b as any).costCurrency === provCurr)
    ) {
      const mNative = Math.max(0, Number((b as any).costNative) || 0);
      mCny = provCurr === "CNY" ? mNative : mNative * CLIENT_USD_TO_CNY;
      mUsd = provCurr === "USD" ? mNative : mNative / CLIENT_USD_TO_CNY;
    } else {
      const mNative =
        (uncached / 1_000_000) * inRate +
        (cached / 1_000_000) * cachedRate +
        (out / 1_000_000) * outRate;
      mCny = provCurr === "CNY" ? mNative : mNative * CLIENT_USD_TO_CNY;
      mUsd = provCurr === "USD" ? mNative : mNative / CLIENT_USD_TO_CNY;
    }
    const rateScaleCny = provCurr === "CNY" ? 1 : CLIENT_USD_TO_CNY;

    costUsd += mUsd;
    costCny += mCny;

    const prev = byModelMap.get(meta.model);
    if (!prev) {
      byModelMap.set(meta.model, {
        model: meta.model,
        label: meta.label,
        shortLabel: meta.shortLabel,
        role:
          meta.role ||
          (params.locale === "en" ? "Auto-Routed Model" : "自动路由模型"),
        accent: meta.accent,
        nativeCurrency: provCurr,
        offPeakHalfPrice: Boolean(meta.supportsOffPeakDiscount),
        ratesCny: {
          inputPer1M: inRate * rateScaleCny,
          cachedInputPer1M: cachedRate * rateScaleCny,
          outputPer1M: outRate * rateScaleCny,
        },
        inputTokens: inp,
        outputTokens: out,
        cachedTokens: cached,
        thoughtTokens: thoughts,
        totalTokens,
        calls: Number((b as any)?.calls) || 0,
        costUsd: mUsd,
        costCny: mCny,
      });
    } else {
      prev.inputTokens += inp;
      prev.outputTokens += out;
      prev.cachedTokens += cached;
      prev.thoughtTokens += thoughts;
      prev.totalTokens += totalTokens;
      prev.calls += Number((b as any)?.calls) || 0;
      prev.costUsd += mUsd;
      prev.costCny += mCny;
    }
  }

  const byModel = Array.from(byModelMap.values());
  byModel.sort((a, b) => b.totalTokens - a.totalTokens);
  return { costUsd, costCny, byModel };
}

export function formatClockTime(
  iso: unknown,
  locale: ResolvedLocale = "zh-CN"
): string {
  if (!iso) return "";
  try {
    const d = new Date(iso as any);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

export function formatClusterHeaderTime(
  iso: unknown,
  locale: ResolvedLocale = "zh-CN"
): string {
  if (!iso) return "";
  try {
    const d = new Date(iso as any);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    const hm = d.toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      return hm;
    }
    if (locale === "en") {
      const dateStr = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      return `${dateStr} ${hm}`;
    }
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${d.getMonth() + 1}月${d.getDate()}日${weekdays[d.getDay()]} ${hm}`;
  } catch {
    return "";
  }
}

export function formatBillingTime(
  ts: number | null | undefined,
  locale: ResolvedLocale = "zh-CN"
): string {
  if (!ts) return locale === "en" ? "Not refreshed yet" : "尚未刷新";
  return new Date(ts).toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatFileBytes(bytes: unknown): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatFileBuildTime(iso: unknown): string {
  if (!iso) return "";
  try {
    const d = new Date(iso as any);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    const mdhm = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.getFullYear() === new Date().getFullYear() ? mdhm : `${d.getFullYear()}-${mdhm}`;
  } catch {
    return "";
  }
}

export function describeFileExtension(
  fileName = "",
  locale: ResolvedLocale = "zh-CN"
) {
  const isEn = locale === "en";
  const m = String(fileName || "").trim().match(/\.([a-zA-Z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : "";
  const map: Record<string, { badge: string; kind: string; kindEn: string; cls: string }> = {
    docx: { badge: "DOCX", kind: "Word 文档", kindEn: "Word Document", cls: "ext-docx" },
    doc: { badge: "DOC", kind: "Word 文档", kindEn: "Word Document", cls: "ext-docx" },
    pdf: { badge: "PDF", kind: "PDF 文档", kindEn: "PDF Document", cls: "ext-pdf" },
    xlsx: { badge: "XLSX", kind: "Excel 表格", kindEn: "Excel Spreadsheet", cls: "ext-xlsx" },
    xls: { badge: "XLS", kind: "Excel 表格", kindEn: "Excel Spreadsheet", cls: "ext-xlsx" },
    csv: { badge: "CSV", kind: "CSV 表格", kindEn: "CSV Table", cls: "ext-xlsx" },
    pptx: { badge: "PPTX", kind: "PowerPoint 演示", kindEn: "PowerPoint Deck", cls: "ext-pptx" },
    ppt: { badge: "PPT", kind: "PowerPoint 演示", kindEn: "PowerPoint Deck", cls: "ext-pptx" },
    zip: { badge: "ZIP", kind: "压缩包", kindEn: "Archive", cls: "ext-zip" },
    tar: { badge: "TAR", kind: "压缩包", kindEn: "Archive", cls: "ext-zip" },
    gz: { badge: "GZ", kind: "压缩包", kindEn: "Archive", cls: "ext-zip" },
    md: { badge: "MD", kind: "Markdown 文档", kindEn: "Markdown Doc", cls: "ext-code" },
    txt: { badge: "TXT", kind: "文本文件", kindEn: "Text File", cls: "ext-code" },
    html: { badge: "HTML", kind: "网页文件", kindEn: "HTML File", cls: "ext-code" },
    htm: { badge: "HTM", kind: "网页文件", kindEn: "HTML File", cls: "ext-code" },
    svg: { badge: "SVG", kind: "矢量图形", kindEn: "Vector Graphic", cls: "ext-code" },
    json: { badge: "JSON", kind: "JSON 数据", kindEn: "JSON Data", cls: "ext-code" },
  };
  const found = map[ext];
  if (found) {
    return { badge: found.badge, kind: isEn ? found.kindEn : found.kind, cls: found.cls };
  }
  return {
    badge: ext ? ext.toUpperCase().slice(0, 4) : "FILE",
    kind: ext
      ? isEn
        ? `${ext.toUpperCase()} File`
        : `${ext.toUpperCase()} 文件`
      : isEn
        ? "Local File"
        : "本地文件",
    cls: "ext-generic",
  };
}

export function parseModelsCsv(raw = ""): string[] {
  return [
    ...new Set(
      String(raw || "")
        .split(/[\n,]/)
        .map((m) => m.trim())
        .filter(Boolean)
    ),
  ];
}

export function formatMcpServersJson(
  mcpServers: any,
  serverId = "kimi-cu",
  hostPlatform?: string | null
): string {
  const fallback = getDefaultKimiCuConfig(hostPlatform);
  const cfg = mcpServers?.[serverId] || fallback;
  const rawCmd = String(cfg.command || "").trim();
  const cmd =
    fallback.command === "" && rawCmd === DEFAULT_KIMI_CU_MCP_CONFIG.command
      ? ""
      : rawCmd || fallback.command;
  return JSON.stringify(
    {
      mcpServers: {
        [serverId]: {
          type: cfg.type || "stdio",
          command: cmd,
          args: Array.isArray(cfg.args) ? cfg.args : fallback.args,
        },
      },
    },
    null,
    2
  );
}

export function parseMcpConfigJsonInput(
  rawText: string,
  prevMcpServers: any,
  serverId = "kimi-cu",
  locale: ResolvedLocale = "zh-CN"
) {
  const isEn = locale === "en";
  const parsed = JSON.parse(String(rawText || "{}"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(isEn ? "Root JSON value must be an object" : "JSON 顶层必须是对象");
  }
  const serverMap =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers
      : parsed[serverId] && typeof parsed[serverId] === "object"
        ? parsed
        : { [serverId]: parsed };
  const target = serverMap[serverId];
  if (!target || typeof target !== "object") {
    throw new Error(
      isEn
        ? `Server definition "${serverId}" not found in JSON`
        : `未在 JSON 中找到 "${serverId}" 服务定义`
    );
  }
  const command = String(target.command || "").trim();
  if (!command) {
    throw new Error(
      isEn ? "Please specify a valid executable command path" : "请填写有效的可执行文件 command 路径"
    );
  }
  const args = Array.isArray(target.args) ? target.args.map((x: any) => String(x)) : [];
  return {
    ...(prevMcpServers || {}),
    [serverId]: {
      type: "stdio",
      command,
      args,
    },
  };
}

export function getSkillsCatalogFromSettings(settings: any) {
  return settings?.skillsCatalog || SKILL_FALLBACK_CATALOG;
}

export function getConfigurableSkillFromSettings(settings: any, id: string | null) {
  if (!id) return null;
  const catalog = getSkillsCatalogFromSettings(settings);
  return (
    catalog.office.find((s: any) => s.id === id) ||
    catalog.platform.find((s: any) => s.id === id && s.removable) ||
    null
  );
}

const ERROR_SUMMARY_MAX_CHARS = 140;

export function formatErrorNotice(
  rawMessage: string,
  fallback?: string,
  locale: ResolvedLocale = "zh-CN"
): { summary: string; detail: string | null } {
  const isEn = locale === "en";
  const resolvedFallback = fallback ?? (isEn ? "Task interrupted or encountered an error" : "任务中断或遇到异常");
  const raw = String(rawMessage || "").trim();
  if (!raw) {
    return { summary: resolvedFallback, detail: null };
  }

  const clip = (text: string) =>
    text.length > ERROR_SUMMARY_MAX_CHARS
      ? `${text.slice(0, ERROR_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
      : text;

  const objIdx = raw.indexOf("{");
  const arrIdx = raw.indexOf("[");
  const jsonStart =
    objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx);
  if (jsonStart !== -1 && (raw.includes("}") || raw.includes("]"))) {
    const jsonCandidate = raw.slice(jsonStart);
    try {
      const parsed = JSON.parse(jsonCandidate);
      const target = Array.isArray(parsed)
        ? parsed.find((item) => item && typeof item === "object")
        : parsed;
      if (target && typeof target === "object" && !Array.isArray(target)) {
        const nestedMsg =
          typeof target?.error?.message === "string"
            ? target.error.message.trim()
            : typeof target?.message === "string"
              ? target.message.trim()
              : "";
        const prefix = raw
          .slice(0, jsonStart)
          .replace(/[:\-\s]+$/, "")
          .trim();
        if (nestedMsg) {
          const combined = prefix ? `${prefix}${isEn ? ": " : "："}${nestedMsg}` : nestedMsg;
          const summary = clip(combined.split(/\r?\n/)[0]!.trim());
          return {
            summary: summary || resolvedFallback,
            detail: summary !== raw ? raw : null,
          };
        }
        if (prefix) {
          const friendlyPrefix = /^402\b/.test(prefix)
            ? isEn
              ? `${prefix} (Model provider balance insufficient or quota exhausted)`
              : `${prefix}（模型供应商账户余额不足或额度已用尽）`
            : prefix;
          const summary = clip(friendlyPrefix.split(/\r?\n/)[0]!.trim());
          return {
            summary: summary || resolvedFallback,
            detail: raw,
          };
        }
      }
    } catch {
      // Not valid trailing JSON; fall through to standard multi-line/length handling.
    }
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] || raw;
  const hasMultipleLines = lines.length > 1;

  if (hasMultipleLines || firstLine.length > ERROR_SUMMARY_MAX_CHARS) {
    const summary = clip(firstLine);
    return {
      summary: summary || resolvedFallback,
      detail: summary !== raw ? raw : null,
    };
  }

  return { summary: firstLine, detail: null };
}
