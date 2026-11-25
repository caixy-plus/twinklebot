export interface ComputerStatusPayload {
  state?: string;
  provider?: string;
  online?: boolean;
  latencyMs?: number;
  screen?: { width?: number; height?: number } | null;
  detail?: string;
  error?: string;
  errorCode?: string;
  vmInstalled?: boolean;
  vmRunning?: boolean;
  hostComputer?: { hostname?: string; executionMode?: string; [key: string]: any };
}

export interface BotComputerDisplayOptions {
  sessionStatus?: string;
  takeoverActive?: boolean;
  anySessionRunning?: boolean;
  multiDisplayEnabled?: boolean;
  computerDisplays?: { bindings?: Record<string, string>; pool?: any } | null;
  activeSessionId?: string | null;
  detecting?: boolean;
  locale?: "zh-CN" | "en";
}

export interface BotComputerStatusView {
  compState: string;
  isCompOnline: boolean;
  hasProbe: boolean;
  isAuthMismatch: boolean;
  isSleeping: boolean;
  cardStatusText: string;
  mobileSubText: string;
  settingsStatusTone: "pending" | "ok" | "err" | "warn";
  settingsOfflineReason: string;
}

/**
 * Detects HTTP 401 / executor Bearer token mismatch from status payloads.
 */
export function isComputerAuthMismatch(
  computerStatus?: ComputerStatusPayload | null
): boolean {
  if (!computerStatus || computerStatus.online) return false;
  if (computerStatus.errorCode === "unauthorized") return true;
  const msg = `${computerStatus.error || ""} ${computerStatus.detail || ""}`;
  return /\bunauthorized\b|401/i.test(msg);
}

/**
 * Single source of truth for rendering "Bot 的电脑" status consistently across
 * Settings -> 电脑, RightInspector desktop card, and MobileSheets.
 */
export function resolveBotComputerStatusDisplay(
  computerStatus?: ComputerStatusPayload | null,
  opts: BotComputerDisplayOptions = {}
): BotComputerStatusView {
  const isEn = opts.locale === "en";
  const compState = computerStatus?.state || "ready";
  const isCompOnline = computerStatus?.online !== false;
  const hasProbe =
    computerStatus?.latencyMs !== undefined ||
    Boolean(computerStatus?.detail) ||
    Boolean(computerStatus?.error) ||
    Boolean(computerStatus?.errorCode);
  const isAuthMismatch = isComputerAuthMismatch(computerStatus);
  const isSleeping = Boolean(
    compState === "ready" &&
      !isCompOnline &&
      !isAuthMismatch &&
      computerStatus?.errorCode !== "unreachable"
  );

  let cardStatusText = isEn ? "Checking…" : "检测中…";
  let mobileSubText = isEn ? "Tap to manage devices" : "点击管理设备";
  let settingsStatusTone: "pending" | "ok" | "err" | "warn" = "pending";
  let settingsOfflineReason = "";

  if (!hasProbe && !opts.detecting) {
    settingsStatusTone = "pending";
  } else if (opts.detecting) {
    settingsStatusTone = "pending";
  }

  if (compState === "uncreated") {
    cardStatusText = isEn ? "Not initialized · Click to set up" : "待创建 · 点击初始化";
    mobileSubText = isEn
      ? "Not initialized (Tap to set up via Admin Bot)"
      : "待创建（点击跳转管理员 Bot 初始化）";
    settingsStatusTone = hasProbe ? "warn" : "pending";
    settingsOfflineReason =
      computerStatus?.detail ||
      (isEn ? "Local Bot Computer has not been created yet" : "尚未创建本地 Bot 电脑");
  } else if (compState === "creating") {
    cardStatusText = isEn ? "Initializing…" : "创建中…";
    mobileSubText = isEn
      ? "Creating virtual desktop environment…"
      : "正在创建虚拟桌面环境…";
    settingsStatusTone = "warn";
    settingsOfflineReason =
      computerStatus?.detail ||
      (isEn ? "Initializing Bot Computer environment…" : "正在初始化 Bot 电脑环境…");
  } else if (compState === "unsupported") {
    cardStatusText = isEn ? "Unsupported" : "暂不支持";
    mobileSubText = isEn ? "Unsupported on current platform" : "当前平台暂不支持";
    settingsStatusTone = "err";
    settingsOfflineReason =
      computerStatus?.detail ||
      (isEn ? "Local container is not supported on this platform" : "当前平台暂不支持本地容器");
  } else if (isAuthMismatch) {
    cardStatusText = isEn ? "Token mismatch · Click to repair" : "令牌未对齐 · 点击自检自愈";
    mobileSubText = isEn
      ? "Auth mismatch (Tap to auto-repair via Admin Bot)"
      : "认证异常（点击跳转管理员 Bot 自检自愈）";
    settingsStatusTone = "err";
    settingsOfflineReason = isEn
      ? "unauthorized · Container executor token mismatch; click card to auto-heal or click Refresh below"
      : "unauthorized · 容器执行器密钥不一致，可点击卡片交由主 Bot 自愈或点击下方「更新」";
  } else if (compState === "error") {
    cardStatusText = isEn ? "Error · Click to auto-repair" : "状态异常 · 点击自检自愈";
    mobileSubText = isEn
      ? "Error (Tap to auto-repair via Admin Bot)"
      : "状态异常（点击跳转管理员 Bot 自检自愈）";
    settingsStatusTone = "err";
    settingsOfflineReason =
      computerStatus?.error ||
      computerStatus?.detail ||
      (isEn ? "Executor not responding" : "执行器未响应");
  } else if (!isCompOnline) {
    cardStatusText = isEn ? "Hibernated" : "休眠中";
    mobileSubText = isEn
      ? "Hibernated (Tap to wake via Admin Bot)"
      : "休眠中（点击跳转管理员 Bot 唤醒自检）";
    settingsStatusTone = "err";
    settingsOfflineReason =
      computerStatus?.error ||
      computerStatus?.detail ||
      (isEn ? "Executor not responding" : "执行器未响应");
  } else if (opts.takeoverActive) {
    cardStatusText = isEn ? "You are in control" : "你正在控制";
    mobileSubText = isEn ? "Running · Tap for fullscreen" : "运行中 · 点击全屏查看";
    settingsStatusTone = "ok";
  } else if (opts.sessionStatus === "waiting_screen") {
    cardStatusText = isEn ? "Waiting for free screen…" : "排队等待空闲屏幕…";
    mobileSubText = isEn ? "Waiting for free screen…" : "排队等待空闲屏幕…";
    settingsStatusTone = "ok";
  } else if (
    computerStatus?.provider === "cloud-linux" &&
    !opts.anySessionRunning
  ) {
    cardStatusText = isEn ? "Cloud sandbox ready" : "云端沙箱已就绪";
    mobileSubText = isEn
      ? "Cloud sandbox ready · Tap for fullscreen"
      : "云端沙箱已就绪 · 点击全屏查看";
    settingsStatusTone = "ok";
  } else if (hasProbe) {
    const multiDisplayEnabled = Boolean(opts.multiDisplayEnabled);
    const pool = opts.computerDisplays?.pool;
    const queueHint =
      multiDisplayEnabled && pool && pool.queuedCount > 0
        ? isEn
          ? ` · Queued ${pool.queuedCount}`
          : ` · 排队 ${pool.queuedCount}`
        : "";
    cardStatusText = isEn ? `Running${queueHint}` : `运行中${queueHint}`;
    mobileSubText = isEn ? "Running · Tap for fullscreen" : "运行中 · 点击全屏查看";
    settingsStatusTone = "ok";
  } else {
    settingsOfflineReason =
      computerStatus?.error || (isEn ? "Executor not responding" : "执行器未响应");
  }

  return {
    compState,
    isCompOnline,
    hasProbe,
    isAuthMismatch,
    isSleeping,
    cardStatusText,
    mobileSubText,
    settingsStatusTone,
    settingsOfflineReason,
  };
}
