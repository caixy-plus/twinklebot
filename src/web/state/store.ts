import { useSyncExternalStore } from "react";
import {
  DEFAULT_KIMI_CU_MCP_CONFIG,
} from "./constants.js";
import {
  estimateClientTurnCost,
  formatClientRouteLabel,
  formatClusterHeaderTime,
  isSessionCurrentlyBusy,
  sanitizeLiveThinkingSummary,
  summarizeArgs,
  translateToolHumanSummary,
} from "./helpers.js";

export type NetworkStatus = "online" | "weak" | "reconnecting" | "offline" | "recovered";

export interface NetworkHealthState {
  status: NetworkStatus;
  rttMs: number | null;
  reconnectAttempt: number;
  nextRetryAt: number | null;
  transport: "ws" | "sse" | "none";
  reason: string;
  browserOffline: boolean;
  dismissedWeakBanner: boolean;
  updatedAt: number;
}

export function createInitialNetworkHealth(): NetworkHealthState {
  return {
    status: "online",
    rttMs: null,
    reconnectAttempt: 0,
    nextRetryAt: null,
    transport: "none",
    reason: "",
    browserOffline: false,
    dismissedWeakBanner: false,
    updatedAt: 0,
  };
}

export type StreamItem =
  | { kind: "unread_divider"; id: string }
  | { kind: "date_divider"; id: string; label: string }
  | {
      kind: "message";
      id: string;
      seq?: number;
      at?: string;
      text: string;
      isUser: boolean;
      botId?: string | null;
      botName?: string;
      botAvatar?: any;
      replyTo?: { seq?: number | null; author?: string; botId?: string | null; snippet?: string } | null;
      quotes?: string[];
      interim?: boolean;
    }
  | {
      kind: "bot_exchange";
      id: string;
      exchangeId?: string;
      direction?: string;
      messageCount: number;
      peer?: { title?: string; avatar?: any } | null;
    }
  | {
      kind: "approval";
      id: string;
      callId: string;
      name: string;
      args: any;
      reason?: string;
      resolved: boolean;
      receiptText?: string;
    }
  | {
      kind: "choice";
      id: string;
      callId: string;
      questions: Array<{
        id: string;
        question: string;
        options: string[];
        multiSelect: boolean;
        placeholder: string;
      }>;
      allowCustom: boolean;
      status: "pending" | "resolved" | "superseded";
      selectedSummary?: any;
      chosenBadge?: string;
    }
  | {
      kind: "draft";
      id: string;
      callId: string;
      draftKind?: string;
      recipient?: string;
      title?: string;
      content?: string;
      resolved: boolean;
      approved?: boolean;
      finalTitle?: string;
      overrideText?: string;
    }
  | {
      kind: "credential";
      id: string;
      callId: string;
      service?: string;
      label?: string;
      fieldType?: string;
      hideVaultCheckbox?: boolean;
      resolved: boolean;
      submitted?: boolean;
      resolvedText?: string;
    }
  | {
      kind: "memory_suggestion";
      id: string;
      suggestionId: string;
      sessionId?: string;
      scope: "bot" | "global";
      name: string;
      content: string;
      status: "pending" | "accepted" | "dismissed";
    }
  | {
      kind: "route_notice";
      id: string;
      level?: string;
      maxSteps?: number;
      toolCount?: number;
      text: string;
    }
  | {
      kind: "error";
      id: string;
      message: string;
    };

export type TraceItem =
  | {
      kind: "thought";
      id: string;
      botName?: string;
      routeLabel?: string;
      text: string;
    }
  | {
      kind: "tool";
      id: string;
      callId?: string;
      name: string;
      argSummary: string;
      argsJson: string;
      at: number;
      status: "pending" | "ok" | "warn";
      summaryText: string;
      resultJson?: string;
      screenUrl?: string | null;
      isMcpScreen?: boolean;
    };

export interface ConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  detail: string;
  confirmText: string;
  cancelText: string;
  tone: "danger" | "primary";
}

export interface HtmlPreviewModalState {
  open: boolean;
  code: string;
  kind: "html" | "svg";
  badgeLabel: string;
  lang: string;
  canvasBg: "light" | "grid" | "dark";
  mode: "preview" | "code";
  vp: "full" | "desktop" | "mobile";
  reloadNonce: number;
}

export interface AppState {
  // Multi-account & transport
  accountsState: {
    activeAccountId: string;
    accounts: Array<{
      id: string;
      type: "local" | "cloud" | "lan";
      name: string;
      baseUrl: string;
      wsUrl?: string;
      authToken?: string;
      instanceId?: string;
      hostname?: string;
      platform?: string;
      createdAt?: string;
    }>;
  };
  localBackendUrl: string;
  localControlToken: string;
  activeBaseUrl: string;
  activeWsUrl: string;
  activeAuthToken: string;
  accountEpoch: number;
  onlineCloudHosts: any[];
  selectedCloudHostId: string | null;
  lanDiscoveredDevices: any[];
  lanScanning: boolean;
  pendingPairingDevice: any | null;
  pendingPairingId: string | null;
  lanOfflineModalShown: boolean;
  lanNodeOffline: boolean;
  lanOfflineDismissed: boolean;
  networkHealth: NetworkHealthState;
  mobilePairModalOpen: boolean;
  mobilePairFeedback: { text: string; kind: string };
  desktopPairingModal: { open: boolean; deviceName: string; code: string };
  cloudAccountModal: {
    open: boolean;
    id: string;
    baseUrl: string;
    name: string;
    authToken: string;
    feedback: string;
  };

  // Config, Computer & Settings
  computerStatus: {
    state: string;
    provider: string;
    online: boolean;
    latencyMs?: number;
    screen?: { width?: number; height?: number };
    detail: string;
    error?: string;
    errorCode?: string;
    vmInstalled?: boolean;
    vmRunning?: boolean;
    hostComputer?: { hostname?: string; executionMode?: string };
  };
  computerDisplays: {
    bindings: Record<string, string>;
    displays: any[];
    pool?: {
      maxConcurrentScreens: number;
      activeCount: number;
      activeBotIds?: string[];
      queuedCount: number;
      queuedBotIds?: string[];
    } | null;
  };
  groupActiveSpeakerBySession: Record<string, string>;
  screenOverlayTargetBotId: string | null;
  diagnostics: any | null;
  updateState: {
    checking: boolean;
    lastCheckedAt: number;
    error: string;
    errorCode?: string;
    localMeta: {
      platform: "desktop" | "android" | "ios" | "web";
      desktopArch?: string;
      githubRepo?: string;
      nativeVersion: string;
      nativeBuildCode?: number;
      activeWebBuild: string;
      usingBuiltIn: boolean;
      lastRollbackReason: string;
    } | null;
    latestManifest: any | null;
    decision: any | null;
    connectedNodeStatus: {
      hasDiagnostics: boolean;
      deployEnv: string;
      nodeVersion: string;
      latestBackendVersion: string;
      nodeOutdated: boolean;
      nodeCapabilities: string[];
      missingLatestCapabilities: string[];
    } | null;
    progress: { phase: string; percent: number; message: string } | null;
    applying: boolean;
    dismissedVersionKey: string;
  };
  config: any | null;
  settings: Record<string, any>;
  spellcheckEnabled: boolean;

  // Sessions & Chat Stream
  sessions: any[];
  activeMap: Record<string, string>;
  primarySessionId: string | null;
  activeSessionId: string | null;
  sessionStatus: string;
  liveThinkingSummary: string;
  queuedCount: number;
  stepCount: number;
  usage: { input: number; output: number };
  sessionUsageByModel: Record<string, any>;
  sessionUsageByProviderModel: Record<string, any>;
  lastObservedModel: string;
  lastRouteLabel: string;
  lastRouteReason: string;
  lastRoutePlan: any | null;
  lastTierPath: string;
  routerUsage: { calls: number; tokens: number };
  lastAssistantText: string;

  streamItems: StreamItem[];
  traceItems: TraceItem[];
  renderedSeqs: Set<number>;
  lastClusterTs: number;
  isReplaying: boolean;
  autoScrollPinned: boolean;
  scrollPinGuardUntil: number;
  computerMiniThumbUrl: string | null;

  // Layout & Shell state
  sidebarCompact: boolean;
  inspectorOpen: boolean;
  desktopFullscreen: boolean;
  mobileView: "list" | "chat";
  accentColor: string;
  inspectorTab: "activity" | "library";
  takeoverActive: boolean;
  screenOverlayOpen: boolean;
  screenConnecting: boolean;
  landscapeDesktop: boolean;
  novncReconnectSeq: number;

  // Composer & NewChatBar
  composerText: string;
  replyQuote: string | null;
  replyTarget: { seq: number | null; author: string; botId: string | null; snippet: string } | null;
  pendingQuotes: string[];
  pendingAttachments: any[];
  keepInputFocusedOnSend: boolean;
  lastCompositionEndAt: number | null;
  isRecordingVoice: boolean;
  newChatBarOpen: boolean;
  newChatGroupMode: boolean;
  newChatRecipients: any[];
  newChatQuery: string;
  mobileSearchQuery: string;

  // Popovers & Floating Toolbars
  openPopover:
    | null
    | "account"
    | "share"
    | "mobile-more"
    | "avatar-editor"
    | "sidebar-context"
    | "mention";
  sidebarContextMenu: { x: number; y: number; sessionId: string | null };
  selectionToolbar: { open: boolean; x: number; y: number; snippet: string };
  mobileActionsOpenSeq: number | null;

  // Modals & Drawers
  searchModalOpen: boolean;
  scheduleModalOpen: boolean;
  editingScheduleId: string | null;
  botMemoryModal: {
    open: boolean;
    sessionId: string | null;
    memoryId: string | null;
    name: string;
    content: string;
  };
  shortcutsDialogOpen: boolean;
  botExchangeSheet: { open: boolean; participants: any[]; messages: any[] };
  traceDrawerOpen: boolean;
  imageLightbox: { open: boolean; url: string; alt: string };
  htmlPreviewModal: HtmlPreviewModalState;
  confirmDialog: ConfirmDialogState;
  toast: { open: boolean; message: string };

  // Settings, Billing, Vault, Library, Schedules
  settingsModal: {
    open: boolean;
    tab: "general" | "models" | "computer" | "permissions" | "vault" | "usage" | "updates";
    standaloneBotSessionId: string | null;
    openNewMemoryOnMount: boolean;
  };
  mobileReturnToSettingsSheet: boolean;
  usageScope: "all" | "session";
  usageScopeSessionId: string | null;
  usageTraceActive: boolean;
  lastGlobalUsagePayload: any | null;
  lastSessionUsagePayloads: Record<string, any>;
  providerBilling: any | null;
  providerCalibrationModes: Record<string, string>;
  providerOpenCalibrationIds: Record<string, boolean>;
  providerRefreshingIds: Record<string, boolean>;
  libraryItems: any[];
  libraryFilter: "all" | "media" | "file";
  libraryExpanded: boolean;
  schedules: any[];
  vaultItems: any[];
  vaultTab: "all" | "login" | "contact";
  vaultSearch: string;

  // Skills Store & Custom Skills & Mail & MCP
  appsModalOpen: boolean;
  skillsView: "store" | "manage" | "detail";
  skillFilter: "all" | "office" | "platform";
  skillSearch: string;
  detailSkillId: string | null;
  detailFrom: "store" | "manage";
  activeMailProvider: "qqmail" | "custom-mail";
  mailEditorOpen: boolean;
  editingMailAccountId: string | null;
  mailListFeedback: { text: string; kind: string };
  mailFormFeedback: Record<string, { text: string; kind: string }>;
  pendingRemoveSkillId: string | null;
  customSkillSearch: string;
  customSkillEditorOpen: boolean;
  editingCustomSkillId: string | null;
  customSkillPreviewMode: boolean;
  customSkillFeedback: string;
  pendingDeleteCustomSkillId: string | null;
  mcpStatusByServer: Record<string, any>;
  mcpFeedback: { text: string; kind: string };

  // Mobile Sheets
  mobileSheets: {
    inspectorOpen: boolean;
    inspectorTab: "activity" | "library";
    settingsOpen: boolean;
    nodeOpen: boolean;
    botEditorOpen: boolean;
  };
  mobileBotEditor: {
    mode: "create" | "edit";
    sessionId: string | null;
    name: string;
    rolePrompt: string;
    shape: string;
    color: string;
  };
}

let itemAutoId = 0;
export function nextStreamItemId(prefix = "it"): string {
  itemAutoId += 1;
  return `${prefix}-${itemAutoId}`;
}

export function createInitialState(): AppState {
  return {
    accountsState: {
      activeAccountId: "local",
      accounts: [
        {
          id: "local",
          type: "local",
          name: "本地电脑",
          baseUrl: "",
          wsUrl: "",
        },
      ],
    },
    localBackendUrl: "",
    localControlToken: "",
    activeBaseUrl: "",
    activeWsUrl: "",
    activeAuthToken: "",
    accountEpoch: 0,
    onlineCloudHosts: [],
    selectedCloudHostId: null,
    lanDiscoveredDevices: [],
    lanScanning: false,
    pendingPairingDevice: null,
    pendingPairingId: null,
    lanOfflineModalShown: false,
    lanNodeOffline: false,
    lanOfflineDismissed: false,
    networkHealth: createInitialNetworkHealth(),
    mobilePairModalOpen: false,
    mobilePairFeedback: { text: "", kind: "info" },
    desktopPairingModal: { open: false, deviceName: "", code: "000000" },
    cloudAccountModal: { open: false, id: "", baseUrl: "", name: "", authToken: "", feedback: "" },

    computerStatus: {
      state: "ready",
      provider: "orbstack",
      online: true,
      detail: "",
    },
    computerDisplays: {
      bindings: {},
      displays: [],
      pool: null,
    },
    groupActiveSpeakerBySession: {},
    screenOverlayTargetBotId: null,
    novncReconnectSeq: 0,
    diagnostics: null,
    updateState: {
      checking: false,
      lastCheckedAt: 0,
      error: "",
      errorCode: "",
      localMeta: null,
      latestManifest: null,
      decision: null,
      connectedNodeStatus: null,
      progress: null,
      applying: false,
      dismissedVersionKey: "",
    },
    config: null,
    settings: {
      theme: "system",
      accentMode: "bot",
      onboardingRequired: false,
      profile: { name: "本地用户", color: "slate" },
      voice: { name: "Liora", speed: 1, lang: "Auto-detect" },
      autoExpandScreen: false,
      hostComputer: { executionMode: "always" },
      mcpServers: {
        "kimi-cu": { ...DEFAULT_KIMI_CU_MCP_CONFIG },
      },
      policy: { autoAudit: true, askRules: [], allowRules: [] },
      privateSkills: [],
      globalMemories: [],
      customSkills: [],
      providers: [],
      routing: {
        smartRouter: true,
        mode: "balanced",
        maxTurnUsd: 0.5,
        tiers: {},
      },
      contextCompression: {
        enabled: true,
        triggerPercent: 75,
        customInstruction: "",
      },
      screenPool: {
        mode: "auto",
        maxConcurrentScreens: 4,
      },
      connectedApps: [],
      mailAccounts: [],
      mailIntegrations: {
        qqmail: { configured: false, enabled: false },
        "custom-mail": { configured: false, enabled: false },
      },
    },
    spellcheckEnabled: true,

    sessions: [],
    activeMap: {},
    primarySessionId: null,
    activeSessionId: null,
    sessionStatus: "idle",
    liveThinkingSummary: "",
    queuedCount: 0,
    stepCount: 0,
    usage: { input: 0, output: 0 },
    sessionUsageByModel: {},
    sessionUsageByProviderModel: {},
    lastObservedModel: "gemini-4-argon",
    lastRouteLabel: "自动调配",
    lastRouteReason: "",
    lastRoutePlan: null,
    lastTierPath: "",
    routerUsage: { calls: 0, tokens: 0 },
    lastAssistantText: "",

    streamItems: [],
    traceItems: [],
    renderedSeqs: new Set<number>(),
    lastClusterTs: 0,
    isReplaying: false,
    autoScrollPinned: true,
    scrollPinGuardUntil: 0,
    computerMiniThumbUrl: null,

    sidebarCompact: false,
    inspectorOpen: true,
    desktopFullscreen: false,
    mobileView: "list",
    accentColor: "black",
    inspectorTab: "activity",
    takeoverActive: false,
    screenOverlayOpen: false,
    screenConnecting: false,
    landscapeDesktop: false,

    composerText: "",
    replyQuote: null,
    replyTarget: null,
    pendingQuotes: [],
    pendingAttachments: [],
    keepInputFocusedOnSend: false,
    lastCompositionEndAt: null,
    isRecordingVoice: false,
    newChatBarOpen: false,
    newChatGroupMode: false,
    newChatRecipients: [],
    newChatQuery: "",
    mobileSearchQuery: "",

    openPopover: null,
    sidebarContextMenu: { x: 0, y: 0, sessionId: null },
    selectionToolbar: { open: false, x: 0, y: 0, snippet: "" },
    mobileActionsOpenSeq: null,

    searchModalOpen: false,
    scheduleModalOpen: false,
    editingScheduleId: null,
    botMemoryModal: {
      open: false,
      sessionId: null,
      memoryId: null,
      name: "",
      content: "",
    },
    shortcutsDialogOpen: false,
    botExchangeSheet: { open: false, participants: [], messages: [] },
    traceDrawerOpen: false,
    imageLightbox: { open: false, url: "", alt: "图片预览" },
    htmlPreviewModal: {
      open: false,
      code: "",
      kind: "html",
      badgeLabel: "HTML 预览",
      lang: "html",
      canvasBg: "light",
      mode: "preview",
      vp: "full",
      reloadNonce: 0,
    },
    confirmDialog: {
      open: false,
      title: "确认操作",
      message: "",
      detail: "",
      confirmText: "确认",
      cancelText: "取消",
      tone: "danger",
    },
    toast: { open: false, message: "" },

    settingsModal: {
      open: false,
      tab: "general",
      standaloneBotSessionId: null,
      openNewMemoryOnMount: false,
    },
    mobileReturnToSettingsSheet: false,
    usageScope: "all",
    usageScopeSessionId: null,
    usageTraceActive: false,
    lastGlobalUsagePayload: null,
    lastSessionUsagePayloads: {},
    providerBilling: null,
    providerCalibrationModes: {},
    providerOpenCalibrationIds: {},
    providerRefreshingIds: {},
    libraryItems: [],
    libraryFilter: "all",
    libraryExpanded: false,
    schedules: [],
    vaultItems: [],
    vaultTab: "all",
    vaultSearch: "",

    appsModalOpen: false,
    skillsView: "store",
    skillFilter: "all",
    skillSearch: "",
    detailSkillId: null,
    detailFrom: "store",
    activeMailProvider: "qqmail",
    mailEditorOpen: false,
    editingMailAccountId: null,
    mailListFeedback: { text: "", kind: "info" },
    mailFormFeedback: {
      qqmail: { text: "", kind: "info" },
      "custom-mail": { text: "", kind: "info" },
    },
    pendingRemoveSkillId: null,
    customSkillSearch: "",
    customSkillEditorOpen: false,
    editingCustomSkillId: null,
    customSkillPreviewMode: false,
    customSkillFeedback: "",
    pendingDeleteCustomSkillId: null,
    mcpStatusByServer: {},
    mcpFeedback: { text: "", kind: "info" },

    mobileSheets: {
      inspectorOpen: false,
      inspectorTab: "activity",
      settingsOpen: false,
      nodeOpen: false,
      botEditorOpen: false,
    },
    mobileBotEditor: {
      mode: "create",
      sessionId: null,
      name: "",
      rolePrompt: "",
      shape: "cloud",
      color: "red",
    },
  };
}

let currentState: AppState = createInitialState();
const listeners = new Set<() => void>();

export const runtimeRefs: {
  accountAbortController: AbortController | null;
  wsSocket: WebSocket | null;
  wsReconnectTimer: any;
  wsPingTimer: any;
  wsPongTimeoutTimer: any;
  wsLastPingSentAt: number;
  wsReconnectAttempt: number;
  lastHiddenAt: number;
  wsHasOpenedInEpoch: boolean;
  inflightReconnectSync: Promise<any> | null;
  eventSource: EventSource | null;
  selectSessionSeq: number;
  nextSelectOpts: { preserveScrollIfUnpinned?: boolean } | null;
  providerBillingFetchSeq: number;
  usageFetchSeq: number;
  usageLiveRefreshTimer: any;
  speechRec: any;
  toastTimer: any;
  connectingTimer: any;
  confirmResolve: ((confirmed: boolean) => void) | null;
} = {
  accountAbortController: null,
  wsSocket: null,
  wsReconnectTimer: null,
  wsPingTimer: null,
  wsPongTimeoutTimer: null,
  wsLastPingSentAt: 0,
  wsReconnectAttempt: 0,
  lastHiddenAt: 0,
  wsHasOpenedInEpoch: false,
  inflightReconnectSync: null,
  eventSource: null,
  selectSessionSeq: 0,
  nextSelectOpts: null,
  providerBillingFetchSeq: 0,
  usageFetchSeq: 0,
  usageLiveRefreshTimer: null,
  speechRec: null,
  toastTimer: null,
  connectingTimer: null,
  confirmResolve: null,
};

export function getState(): AppState {
  return currentState;
}

export function setState(
  updater: Partial<AppState> | ((prev: AppState) => AppState | Partial<AppState>)
): AppState {
  const nextPartial = typeof updater === "function" ? updater(currentState) : updater;
  if (!nextPartial || nextPartial === currentState) return currentState;
  currentState = { ...currentState, ...nextPartial };
  for (const listener of listeners) {
    listener();
  }
  return currentState;
}

export function resetStoreForTest(overrides?: Partial<AppState>): AppState {
  currentState = { ...createInitialState(), ...(overrides || {}) };
  for (const listener of listeners) {
    listener();
  }
  return currentState;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStore<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(currentState),
    () => selector(currentState)
  );
}

export function getActiveSessionFromState(s: AppState = currentState): any | null {
  return s.sessions.find((item) => item.id === s.activeSessionId) || null;
}

export function getPrimarySessionFromState(s: AppState = currentState): any | null {
  const admin = s.sessions.find((item) => item.isAdmin === true);
  if (admin) return admin;
  const pinned = s.sessions.find((item) => item.pinned);
  if (pinned) return pinned;
  const nori = s.sessions.find(
    (item) => item.type !== "group" && String(item.title || "").trim().toLowerCase() === "nori"
  );
  if (nori) return nori;
  if (s.primarySessionId) {
    const found = s.sessions.find((item) => item.id === s.primarySessionId);
    if (found) return found;
  }
  const rootBots = [...s.sessions]
    .reverse()
    .filter((item) => item.type !== "group" && !item.createdByBotId);
  return rootBots[0] || s.sessions.find((item) => item.type !== "group") || s.sessions[0] || null;
}

export function finalizeOrphanedInteractiveItems(
  items: StreamItem[],
  reasonText = "⏹ 本轮任务已结束"
): StreamItem[] {
  let changed = false;
  const next = items.map((item): StreamItem => {
    if (item.kind === "approval" && !item.resolved) {
      changed = true;
      return { ...item, resolved: true, receiptText: reasonText };
    }
    if (item.kind === "choice" && item.status === "pending") {
      changed = true;
      return { ...item, status: "superseded" };
    }
    if (item.kind === "draft" && !item.resolved) {
      changed = true;
      return { ...item, resolved: true, approved: false, finalTitle: reasonText };
    }
    if (item.kind === "credential" && !item.resolved) {
      changed = true;
      return { ...item, resolved: true, submitted: false };
    }
    return item;
  });
  return changed ? next : items;
}

export interface EventApplySideEffects {
  shouldAutoExpandScreen?: boolean;
  autoExpandTargetBotId?: string;
  shouldRefreshUsage?: boolean;
  debouncedRefreshUsage?: boolean;
}

/**
 * Pure state transition applying one SessionEvent (`replay` or live WS/SSE) to `AppState`.
 */
export function reduceSessionEvent(
  prev: AppState,
  evt: any,
  opts: { replay?: boolean; resolveApiUrl?: (u: string) => string } = {}
): { next: AppState; effects: EventApplySideEffects } {
  const replay = Boolean(opts.replay);
  const effects: EventApplySideEffects = {};
  if (!evt || typeof evt !== "object") return { next: prev, effects };

  if (evt.seq !== undefined) {
    if (!replay && prev.renderedSeqs.has(evt.seq)) {
      return { next: prev, effects };
    }
    prev.renderedSeqs.add(evt.seq);
  }

  let streamItems = prev.streamItems;
  let traceItems = prev.traceItems;
  let sessionStatus = prev.sessionStatus;
  let liveThinkingSummary = prev.liveThinkingSummary;
  let queuedCount = prev.queuedCount;
  let stepCount = prev.stepCount;
  let lastClusterTs = prev.lastClusterTs;
  let lastObservedModel = prev.lastObservedModel;
  let lastRouteLabel = prev.lastRouteLabel;
  let lastRouteReason = prev.lastRouteReason;
  let lastRoutePlan = prev.lastRoutePlan;
  let lastTierPath = prev.lastTierPath;
  let lastAssistantText = prev.lastAssistantText;
  let usage = prev.usage;
  let routerUsage = prev.routerUsage;
  let sessionUsageByModel = prev.sessionUsageByModel;
  let sessionUsageByProviderModel = prev.sessionUsageByProviderModel;
  let computerMiniThumbUrl = prev.computerMiniThumbUrl;
  let autoScrollPinned = prev.autoScrollPinned;

  const resolveUrl = opts.resolveApiUrl || ((u: string) => u);

  const maybePushTimeDivider = (iso?: string) => {
    if (!iso) return;
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return;
    if (!lastClusterTs || ts - lastClusterTs >= 5 * 60 * 1000) {
      const label = formatClusterHeaderTime(iso);
      if (label) {
        streamItems = [
          ...streamItems,
          { kind: "date_divider", id: nextStreamItemId("date"), label },
        ];
        lastClusterTs = ts;
      }
    }
  };

  switch (evt.type) {
    case "user":
    case "user_message": {
      maybePushTimeDivider(evt.at);
      streamItems = [
        ...streamItems,
        {
          kind: "message",
          id: nextStreamItemId("msg"),
          seq: evt.seq,
          at: evt.at,
          text: evt.text || "",
          isUser: true,
          replyTo: evt.replyTo || null,
          quotes: Array.isArray(evt.quotes) ? evt.quotes : undefined,
        },
      ];
      if (!replay) autoScrollPinned = true;
      break;
    }

    case "bot_exchange": {
      const exId = evt.exchangeId;
      const count = Number(evt.messageCount) || 1;
      if (exId) {
        const existingIdx = streamItems.findIndex(
          (it) => it.kind === "bot_exchange" && it.exchangeId === exId
        );
        if (existingIdx !== -1) {
          streamItems = streamItems.slice();
          streamItems[existingIdx] = {
            ...(streamItems[existingIdx] as any),
            direction: evt.direction,
            messageCount: count,
            peer: evt.peer || null,
          };
          break;
        }
      }
      streamItems = [
        ...streamItems,
        {
          kind: "bot_exchange",
          id: nextStreamItemId("ex"),
          exchangeId: exId,
          direction: evt.direction,
          messageCount: count,
          peer: evt.peer || null,
        },
      ];
      break;
    }

    case "thinking_summary": {
      if (evt.text && isSessionCurrentlyBusy(sessionStatus)) {
        liveThinkingSummary = sanitizeLiveThinkingSummary(evt.text, "正在思考处理中");
      }
      break;
    }

    case "queue_updated": {
      queuedCount = Math.max(0, Number(evt.queueLength) || 0);
      break;
    }

    case "context_compressed": {
      // Silent by design: never render compression notice dividers in chat
      break;
    }

    case "thought": {
      if (evt.usedModel) {
        lastObservedModel = String(evt.usedModel).replace(/^models\//i, "");
      }
      if (evt.routeLabel) {
        lastRouteLabel = formatClientRouteLabel(evt.routeLabel, evt.usedModel);
      }
      if (!evt.text) break;
      traceItems = [
        ...traceItems,
        {
          kind: "thought",
          id: nextStreamItemId("tr-thought"),
          botName: evt.botName,
          routeLabel: evt.routeLabel ? formatClientRouteLabel(evt.routeLabel, evt.usedModel) : "",
          text: evt.text,
        },
      ];
      break;
    }

    case "action":
    case "tool_call": {
      stepCount += 1;
      const isBotDesktopVisualTool = [
        "screenshot",
        "click",
        "double_click",
        "right_click",
        "move",
        "drag",
        "scroll",
        "type_text",
        "key",
        "list_windows",
        "focus_window",
        "open_url",
        "browser_snapshot",
        "browser_click",
        "browser_type",
      ].includes(evt.name);
      if (isBotDesktopVisualTool && prev.settings?.autoExpandScreen && !prev.screenOverlayOpen && !replay) {
        effects.shouldAutoExpandScreen = true;
        if (evt.botId) {
          effects.autoExpandTargetBotId = String(evt.botId);
        }
      }
      const argSummary = summarizeArgs(evt.args) || `步骤 #${stepCount}`;
      traceItems = [
        ...traceItems,
        {
          kind: "tool",
          id: nextStreamItemId("tr-tool"),
          callId: evt.callId,
          name: evt.name || "action",
          argSummary,
          argsJson: JSON.stringify(evt.args || {}, null, 2),
          at: evt.at ? Date.parse(evt.at) : Date.now(),
          status: "pending",
          summaryText: argSummary,
        },
      ];
      break;
    }

    case "result":
    case "tool_result": {
      const resultCopy = { ...(evt.result || {}) };
      delete resultCopy.png_base64;

      const isMcpScreen = String(evt.name || "").startsWith("mcp__");
      const screenUrl = evt.screenshotUrl
        ? resolveUrl(evt.screenshotUrl)
        : evt.screenshot && prev.activeSessionId
          ? resolveUrl(`/api/screens/${prev.activeSessionId}/${evt.screenshot}`)
          : null;

      if (screenUrl && !isMcpScreen) {
        computerMiniThumbUrl = screenUrl;
      }

      const pendingIdx = evt.callId
        ? traceItems.findIndex(
            (it) => it.kind === "tool" && it.callId === evt.callId && it.status === "pending"
          )
        : -1;

      if (pendingIdx !== -1) {
        const existing = traceItems[pendingIdx] as Extract<TraceItem, { kind: "tool" }>;
        const hasErr =
          Boolean(resultCopy.error) ||
          (typeof resultCopy.exit_code === "number" && resultCopy.exit_code !== 0);
        const outBrief =
          typeof resultCopy.stdout === "string" && resultCopy.stdout.trim()
            ? resultCopy.stdout.trim().replace(/\s+/g, " ").slice(0, 44)
            : typeof resultCopy.error === "string"
              ? resultCopy.error.slice(0, 44)
              : resultCopy.ok
                ? "完成"
                : "";
        const endTs = evt.at ? Date.parse(evt.at) : Date.now();
        const elapsedMs = Math.max(0, endTs - (existing.at || endTs));
        const durTag =
          elapsedMs >= 100 && elapsedMs < 300000 ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : "";

        traceItems = traceItems.slice();
        traceItems[pendingIdx] = {
          ...existing,
          name: evt.name || existing.name || "result",
          status: hasErr ? "warn" : "ok",
          summaryText: `${existing.argSummary}${outBrief ? ` → ${outBrief}` : ""}${durTag}`,
          resultJson: Object.keys(resultCopy).length > 0 ? JSON.stringify(resultCopy, null, 2) : undefined,
          screenUrl,
          isMcpScreen,
        };
      } else {
        traceItems = [
          ...traceItems,
          {
            kind: "tool",
            id: nextStreamItemId("tr-res"),
            callId: evt.callId,
            name: evt.name || "result",
            argSummary: summarizeArgs(resultCopy) || "执行完成",
            argsJson: "",
            at: evt.at ? Date.parse(evt.at) : Date.now(),
            status: "ok",
            summaryText: summarizeArgs(resultCopy) || "执行完成",
            resultJson: Object.keys(resultCopy).length > 0 ? JSON.stringify(resultCopy, null, 2) : undefined,
            screenUrl,
            isMcpScreen,
          },
        ];
      }
      break;
    }

    case "approval_request":
    case "confirmation_required": {
      if (!replay) sessionStatus = "awaiting_approval";
      streamItems = [
        ...streamItems,
        {
          kind: "approval",
          id: nextStreamItemId("appr"),
          callId: evt.callId || nextStreamItemId("call"),
          name: evt.name || "tool",
          args: evt.args || {},
          reason: evt.reason,
          resolved: false,
        },
      ];
      break;
    }

    case "approval":
    case "confirmation_resolved": {
      const ok = evt.allowed ?? evt.approved;
      const receiptText = evt.superseded
        ? "↻ 已收到新消息，已跳过本次确认"
        : ok
          ? "✓ 已允许该操作"
          : "✕ 已暂不允许该操作";
      streamItems = streamItems.map((it) =>
        it.kind === "approval" && it.callId === evt.callId && !it.resolved
          ? { ...it, resolved: true, receiptText }
          : it
      );
      if (!replay && sessionStatus === "awaiting_approval") {
        sessionStatus = "running";
      }
      break;
    }

    case "choice_request": {
      if (!replay) sessionStatus = "awaiting_choice";
      const questions =
        Array.isArray(evt.questions) && evt.questions.length > 0
          ? evt.questions.map((q: any, idx: number) => ({
              id: q.id || `q${idx + 1}`,
              question: q.question || "请选择下一步操作",
              options: Array.isArray(q.options) ? q.options : [],
              multiSelect: Boolean(q.multiSelect),
              placeholder: q.placeholder || "输入你自己的回答…",
            }))
          : [
              {
                id: "q1",
                question: evt.question || "接下来先帮你做哪一步？",
                options: Array.isArray(evt.options) ? evt.options : [],
                multiSelect: Boolean(evt.multiSelect),
                placeholder: evt.placeholder || "输入你自己的回答…",
              },
            ];
      streamItems = [
        ...streamItems,
        {
          kind: "choice",
          id: nextStreamItemId("choice"),
          callId: evt.callId || nextStreamItemId("call"),
          questions,
          allowCustom: evt.allowCustom !== false,
          status: "pending",
        },
      ];
      break;
    }

    case "choice_resolved": {
      streamItems = streamItems.map((it) =>
        it.kind === "choice" && it.callId === evt.callId
          ? { ...it, status: "resolved", selectedSummary: evt.selected, chosenBadge: "✓" }
          : it
      );
      break;
    }

    case "choice_superseded": {
      streamItems = streamItems.map((it) => {
        if (it.kind === "choice" && it.callId === evt.callId && it.status === "pending") {
          return { ...it, status: "superseded" };
        }
        if (it.kind === "draft" && it.callId === evt.callId && !it.resolved) {
          return { ...it, resolved: true, approved: false, finalTitle: "已跳过" };
        }
        if (it.kind === "credential" && it.callId === evt.callId && !it.resolved) {
          return { ...it, resolved: true, submitted: false };
        }
        return it;
      });
      break;
    }

    case "draft_request": {
      if (!replay) sessionStatus = "awaiting_choice";
      streamItems = [
        ...streamItems,
        {
          kind: "draft",
          id: nextStreamItemId("draft"),
          callId: evt.callId || nextStreamItemId("call"),
          draftKind: evt.kind,
          recipient: evt.recipient,
          title: evt.title,
          content: evt.content,
          resolved: false,
        },
      ];
      break;
    }

    case "draft_resolved": {
      streamItems = streamItems.map((it) =>
        it.kind === "draft" && it.callId === evt.callId
          ? { ...it, resolved: true, approved: evt.approved !== false, finalTitle: evt.title }
          : it
      );
      break;
    }

    case "credential_request": {
      if (!replay) sessionStatus = "awaiting_choice";
      streamItems = [
        ...streamItems,
        {
          kind: "credential",
          id: nextStreamItemId("cred"),
          callId: evt.callId || nextStreamItemId("call"),
          service: evt.service,
          label: evt.label,
          fieldType: evt.fieldType,
          hideVaultCheckbox: Boolean(evt.hideVaultCheckbox),
          resolved: false,
        },
      ];
      break;
    }

    case "credential_resolved": {
      streamItems = streamItems.map((it) =>
        it.kind === "credential" && it.callId === evt.callId
          ? {
              ...it,
              resolved: true,
              submitted: Boolean(evt.submitted),
              resolvedText: evt.resolvedText || "",
            }
          : it
      );
      break;
    }

    case "memory_suggestion": {
      const sugId = String(evt.suggestionId || nextStreamItemId("memsug"));
      const existingIdx = streamItems.findIndex(
        (it) => it.kind === "memory_suggestion" && it.suggestionId === sugId
      );
      if (existingIdx === -1) {
        streamItems = [
          ...streamItems,
          {
            kind: "memory_suggestion",
            id: nextStreamItemId("memsug-item"),
            suggestionId: sugId,
            sessionId: evt.sessionId || prev.activeSessionId || "",
            scope: evt.scope === "global" ? "global" : "bot",
            name: String(evt.name || "记忆建议"),
            content: String(evt.content || ""),
            status:
              evt.status === "accepted" || evt.status === "dismissed"
                ? evt.status
                : "pending",
          },
        ];
      }
      break;
    }

    case "memory_suggestion_resolved": {
      const sugId = String(evt.suggestionId || "");
      const nextStatus = evt.status === "accepted" ? "accepted" : "dismissed";
      streamItems = streamItems.map((it) =>
        it.kind === "memory_suggestion" && it.suggestionId === sugId
          ? { ...it, status: nextStatus }
          : it
      );
      break;
    }

    case "answer":
    case "assistant_text":
    case "done": {
      const text = evt.text || "";
      if (evt.type === "done" && !replay) {
        sessionStatus = "done";
        liveThinkingSummary = "";
        effects.shouldRefreshUsage = true;
      }
      if (text) {
        lastAssistantText = text;
        maybePushTimeDivider(evt.at);
        streamItems = [
          ...streamItems,
          {
            kind: "message",
            id: nextStreamItemId("msg"),
            seq: evt.seq,
            at: evt.at,
            text,
            isUser: false,
            botId: evt.botId,
            botName: evt.botName,
            botAvatar: evt.botAvatar,
            replyTo: evt.replyTo || null,
            quotes: Array.isArray(evt.quotes) ? evt.quotes : undefined,
            interim: Boolean(evt.interim),
          },
        ];
      }
      break;
    }

    case "usage": {
      const inp = Number(evt.input) || 0;
      const out = Number(evt.output) || 0;
      const cached = Number(evt.cached) || 0;
      const thoughts = Number(evt.thoughts) || 0;
      usage = {
        input: (Number(usage.input) || 0) + inp,
        output: (Number(usage.output) || 0) + out,
      };
      if (evt.routeTier === "router") {
        routerUsage = {
          calls: routerUsage.calls + 1,
          tokens: routerUsage.tokens + inp + out,
        };
      }
      if (evt.routeLabel && evt.routeTier !== "router" && evt.routeTier !== "summary") {
        lastRouteLabel = formatClientRouteLabel(evt.routeLabel, evt.model);
        lastRouteReason = evt.routeReason || lastRouteReason || "";
        if (evt.tierPath) lastTierPath = evt.tierPath;
      }
      const mKey =
        String(evt.model || lastObservedModel || "gemini-4-argon")
          .trim()
          .replace(/^models\//i, "") || "gemini-4-argon";
      const isUtilityTier =
        evt.routeTier === "router" || evt.routeTier === "summary" || evt.routeTier === "image";
      if (!isUtilityTier || !lastObservedModel) {
        lastObservedModel = mKey;
      }
      if (inp > 0 || out > 0) {
        const turnCost = estimateClientTurnCost(
          prev.settings?.providers || [],
          mKey,
          { input: inp, output: out, cached },
          String(evt.providerId || ""),
          evt.at || (!replay ? Date.now() : undefined)
        );
        const cur = sessionUsageByModel[mKey]
          ? { ...sessionUsageByModel[mKey] }
          : {
              input: 0,
              output: 0,
              cached: 0,
              thoughts: 0,
              calls: 0,
              costCny: 0,
              costUsd: 0,
              hasExactCost: true,
            };
        const curWasEmpty = cur.input === 0 && cur.output === 0;
        cur.input += inp;
        cur.output += out;
        cur.cached += cached;
        cur.thoughts += thoughts;
        cur.calls += 1;
        if (curWasEmpty || cur.hasExactCost) {
          cur.costCny = (curWasEmpty ? 0 : Number(cur.costCny) || 0) + turnCost.costCny;
          cur.costUsd = (curWasEmpty ? 0 : Number(cur.costUsd) || 0) + turnCost.costUsd;
          cur.hasExactCost = true;
        }
        sessionUsageByModel = { ...sessionUsageByModel, [mKey]: cur };

        if (evt.providerId) {
          const pmKey = `${String(evt.providerId).trim()}::${mKey}`;
          const pmCur = sessionUsageByProviderModel[pmKey]
            ? { ...sessionUsageByProviderModel[pmKey] }
            : {
                input: 0,
                output: 0,
                cached: 0,
                thoughts: 0,
                calls: 0,
                costCny: 0,
                costUsd: 0,
                hasExactCost: true,
              };
          const pmWasEmpty = pmCur.input === 0 && pmCur.output === 0;
          pmCur.input += inp;
          pmCur.output += out;
          pmCur.cached += cached;
          pmCur.thoughts += thoughts;
          pmCur.calls += 1;
          if (pmWasEmpty || pmCur.hasExactCost) {
            pmCur.costCny = (pmWasEmpty ? 0 : Number(pmCur.costCny) || 0) + turnCost.costCny;
            pmCur.costUsd = (pmWasEmpty ? 0 : Number(pmCur.costUsd) || 0) + turnCost.costUsd;
            pmCur.hasExactCost = true;
          }
          sessionUsageByProviderModel = { ...sessionUsageByProviderModel, [pmKey]: pmCur };
        }
      }
      if (!replay && prev.settingsModal.open) {
        effects.debouncedRefreshUsage = true;
      }
      break;
    }

    case "status": {
      if (!replay && evt.status) {
        sessionStatus = evt.status;
        if (
          ["done", "completed", "stopped", "error", "idle", "max_steps", "interrupted"].includes(
            evt.status
          )
        ) {
          liveThinkingSummary = "";
          streamItems = finalizeOrphanedInteractiveItems(
            streamItems,
            evt.status === "stopped" ? "⏹ 已停止当前操作" : "⏹ 上一轮操作已结束"
          );
          effects.shouldRefreshUsage = true;
        }
        if (["stopped", "error", "idle"].includes(evt.status)) {
          queuedCount = 0;
        }
      }
      break;
    }

    case "route_plan": {
      lastRoutePlan = evt.plan || null;
      lastRouteReason = evt.plan?.reason || "";
      lastTierPath = "";
      break;
    }

    case "route_notice": {
      streamItems = [
        ...streamItems,
        {
          kind: "route_notice",
          id: nextStreamItemId("rnotice"),
          level: evt.level,
          maxSteps: Number.isFinite(Number(evt.maxSteps)) ? Number(evt.maxSteps) : undefined,
          toolCount: Number.isFinite(Number(evt.toolCount)) ? Number(evt.toolCount) : undefined,
          text: evt.text || "本轮费用已接近预算上限",
        },
      ];
      break;
    }

    case "error": {
      if (!replay) {
        sessionStatus = "error";
        liveThinkingSummary = "";
      }
      streamItems = [
        ...streamItems,
        {
          kind: "error",
          id: nextStreamItemId("err"),
          message: evt.message || "任务中断或遇到异常",
        },
      ];
      break;
    }

    default:
      break;
  }

  return {
    next: {
      ...prev,
      streamItems,
      traceItems,
      sessionStatus,
      liveThinkingSummary,
      queuedCount,
      stepCount,
      lastClusterTs,
      lastObservedModel,
      lastRouteLabel,
      lastRouteReason,
      lastRoutePlan,
      lastTierPath,
      lastAssistantText,
      usage,
      routerUsage,
      sessionUsageByModel,
      sessionUsageByProviderModel,
      computerMiniThumbUrl,
      autoScrollPinned,
    },
    effects,
  };
}

export function resolveApprovalItemSummary(name: string, args: any, kind: "custom" | "always" | "allow" | "deny"): string {
  const summaryLabel = translateToolHumanSummary(name, args);
  if (kind === "custom") return `🛡 已保存自定义规则并允许 · ${summaryLabel}`;
  if (kind === "always") return `🛡 已设为始终允许 · ${summaryLabel}`;
  if (kind === "allow") return `✓ 已允许 · ${summaryLabel}`;
  return `✕ 已暂不允许 · ${summaryLabel}`;
}
