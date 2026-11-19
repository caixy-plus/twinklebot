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

  let cardStatusText = "检测中…";
  let mobileSubText = "点击管理设备";
  let settingsStatusTone: "pending" | "ok" | "err" | "warn" = "pending";
  let settingsOfflineReason = "";

  if (!hasProbe && !opts.detecting) {
    settingsStatusTone = "pending";
  } else if (opts.detecting) {
    settingsStatusTone = "pending";
  }

  if (compState === "uncreated") {
    cardStatusText = "待创建 · 点击初始化";
    mobileSubText = "待创建（点击跳转管理员 Bot 初始化）";
    settingsStatusTone = hasProbe ? "warn" : "pending";
    settingsOfflineReason = computerStatus?.detail || "尚未创建本地 Bot 电脑";
  } else if (compState === "creating") {
    cardStatusText = "创建中…";
    mobileSubText = "正在创建虚拟桌面环境…";
    settingsStatusTone = "warn";
    settingsOfflineReason = computerStatus?.detail || "正在初始化 Bot 电脑环境…";
  } else if (compState === "unsupported") {
    cardStatusText = "暂不支持";
    mobileSubText = "当前平台暂不支持";
    settingsStatusTone = "err";
    settingsOfflineReason = computerStatus?.detail || "当前平台暂不支持本地容器";
  } else if (isAuthMismatch) {
    cardStatusText = "令牌未对齐 · 点击自检自愈";
    mobileSubText = "认证异常（点击跳转管理员 Bot 自检自愈）";
    settingsStatusTone = "err";
    settingsOfflineReason = "unauthorized · 容器执行器密钥不一致，可点击卡片交由主 Bot 自愈或点击下方「更新」";
  } else if (compState === "error") {
    cardStatusText = "状态异常 · 点击自检自愈";
    mobileSubText = "状态异常（点击跳转管理员 Bot 自检自愈）";
    settingsStatusTone = "err";
    settingsOfflineReason =
      computerStatus?.error || computerStatus?.detail || "执行器未响应";
  } else if (!isCompOnline) {
    cardStatusText = "休眠中";
    mobileSubText = "休眠中（点击跳转管理员 Bot 唤醒自检）";
    settingsStatusTone = "err";
    settingsOfflineReason =
      computerStatus?.error || computerStatus?.detail || "执行器未响应";
  } else if (opts.takeoverActive) {
    cardStatusText = "你正在控制";
    mobileSubText = "运行中 · 点击全屏查看";
    settingsStatusTone = "ok";
  } else if (opts.sessionStatus === "waiting_screen") {
    cardStatusText = "排队等待空闲屏幕…";
    mobileSubText = "排队等待空闲屏幕…";
    settingsStatusTone = "ok";
  } else if (
    computerStatus?.provider === "cloud-linux" &&
    !opts.anySessionRunning
  ) {
    cardStatusText = "云端沙箱已就绪";
    mobileSubText = "云端沙箱已就绪 · 点击全屏查看";
    settingsStatusTone = "ok";
  } else if (hasProbe) {
    const multiDisplayEnabled = Boolean(opts.multiDisplayEnabled);
    const pool = opts.computerDisplays?.pool;
    const queueHint =
      multiDisplayEnabled && pool && pool.queuedCount > 0
        ? ` · 排队 ${pool.queuedCount}`
        : "";
    cardStatusText = `运行中${queueHint}`;
    mobileSubText = "运行中 · 点击全屏查看";
    settingsStatusTone = "ok";
  } else {
    settingsOfflineReason = computerStatus?.error || "执行器未响应";
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
