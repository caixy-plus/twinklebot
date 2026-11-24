import { startTransition } from "react";
import {
  formatLanguageOptionLabel,
  normalizeLanguagePreference,
  type LanguagePreference,
} from "/shared/i18n.js";
import {
  readStoredLanguagePreference,
  setLocalLanguageState,
  syncLanguageToDomAndStorage,
  tr,
} from "./i18n.js";
import {
  getResolvedColorMeta,
  resolveBotAvatar,
} from "../avatars.js";
import {
  LOCAL_ACCOUNT_ID,
  normalizeAccountsState,
  removeCloudAccount,
  setActiveAccount,
  upsertLanAccount,
} from "/accounts-store.js";
import {
  discoverLanDevices,
  getMobilePlatform,
  isMobileAppTarget,
  onAppForeground,
  scanSubnetForDevices,
  setScreenOrientation,
  storageGet,
  storageSet,
} from "../mobile-bridge.js";
import {
  isMobileViewport,
  syncMobileChatBottomMetrics,
} from "../mobile-ui.js";
import {
  ACCOUNTS_STORAGE_KEY,
  buildBotComputerSelfHealPrompt,
  getFileManagerLabel,
  PRESET_BOT_COMPUTER_INIT_PROMPT,
} from "../state/constants.js";
import {
  computeClientSessionSummary,
  getConfigurableSkillFromSettings,
  isSessionCurrentlyBusy,
  teardownAllPreviewFrames,
} from "../state/helpers.js";
import {
  dismissErrorCard,
  finalizeOrphanedInteractiveItems,
  getActiveSessionFromState,
  getPrimarySessionFromState,
  getState,
  nextStreamItemId,
  reduceSessionEvent,
  runtimeRefs,
  setState,
  writeUiPrefs,
  type StreamItem,
} from "../state/store.js";
import {
  apiFetch,
  apiJson,
  apiUrl,
  dismissLanOfflineModal,
  markLanReachable,
} from "./api-client.js";
import {
  connectRealtimeTransport,
  disconnectRealtimeTransport,
  probeActiveTransportOnResume,
  reconnectRealtimeNow,
  syncSessionsAndActiveOnReconnect,
} from "./realtime.js";
import {
  getActiveAccountMeta,
  getNetworkThresholds,
  handleBrowserOnlineChange,
  inspectNavigatorConnectionHint,
  isRemoteAccountOffline,
  resetNetworkHealthForAccountSwitch,
} from "./network-monitor.js";
import {
  checkForAppUpdates,
  confirmBootedWebBundleReady,
  hasConnectedNodeCapability,
  refreshLocalUpdateMetadata,
  syncConnectedNodeStatusWithManifest,
} from "./ota-updater.js";

/* ==================== SETTINGS SCROLL-IDLE DEFERRED UPDATES (`scrollend`) ==================== */
const activeSettingsScrollers = new Set<Element>();
const deferredSettingsTasks = new Map<string, () => void>();
const fallbackScrollTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function flushDeferredSettingsTasks() {
  if (activeSettingsScrollers.size > 0 || deferredSettingsTasks.size === 0) return;
  const tasks = Array.from(deferredSettingsTasks.values());
  deferredSettingsTasks.clear();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      startTransition(() => {
        for (const fn of tasks) {
          try {
            fn();
          } catch {}
        }
      });
    });
  } else {
    for (const fn of tasks) {
      try {
        fn();
      } catch {}
    }
  }
}

export function bindScrollEndTracking(scroller: Element | null) {
  if (!scroller || (scroller as any).__settingsScrollTracked) return;
  (scroller as any).__settingsScrollTracked = true;

  const markEnded = () => {
    const prevTimer = fallbackScrollTimers.get(scroller);
    if (prevTimer) {
      clearTimeout(prevTimer);
      fallbackScrollTimers.delete(scroller);
    }
    if (activeSettingsScrollers.delete(scroller)) {
      flushDeferredSettingsTasks();
    }
  };

  scroller.addEventListener(
    "scroll",
    () => {
      activeSettingsScrollers.add(scroller);
      const prevTimer = fallbackScrollTimers.get(scroller);
      if (prevTimer) clearTimeout(prevTimer);
      const supportsNativeScrollEnd = typeof window !== "undefined" && "onscrollend" in window;
      const delayMs = supportsNativeScrollEnd ? 420 : 120;
      fallbackScrollTimers.set(
        scroller,
        setTimeout(() => {
          if (!supportsNativeScrollEnd) {
            scroller.dispatchEvent(new CustomEvent("scrollend"));
          } else {
            markEnded();
          }
        }, delayMs)
      );
    },
    { passive: true }
  );

  scroller.addEventListener("scrollend", markEnded, { passive: true });
}

export function isSettingsScrollActive(): boolean {
  const s = getState();
  if (!s.settingsModal.open && !s.mobileSheets.settingsOpen) {
    activeSettingsScrollers.clear();
    return false;
  }
  return activeSettingsScrollers.size > 0;
}

export function runWhenSettingsScrollIdle(key: string, fn: () => void) {
  if (!isSettingsScrollActive()) {
    deferredSettingsTasks.delete(key);
    fn();
    return;
  }
  deferredSettingsTasks.set(key, fn);
}

/* ==================== TOAST & CONFIRM DIALOG ==================== */
export function showToast(msg: unknown) {
  const text = String(msg || "");
  setState({ toast: { open: true, message: text } });
  if (runtimeRefs.toastTimer) clearTimeout(runtimeRefs.toastTimer);
  runtimeRefs.toastTimer = setTimeout(() => {
    setState((prev) => ({ toast: { ...prev.toast, open: false } }));
  }, 2400);
}

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: "danger" | "primary";
}

export function resolveConfirmDialog(confirmed: boolean) {
  const finish = runtimeRefs.confirmResolve;
  runtimeRefs.confirmResolve = null;
  setState((prev) => ({
    confirmDialog: { ...prev.confirmDialog, open: false },
  }));
  finish?.(confirmed);
}

export function showConfirmDialog({
  title = "确认操作",
  message,
  detail = "",
  confirmText = "确认",
  cancelText = "取消",
  tone = "danger",
}: ConfirmDialogOptions): Promise<boolean> {
  if (typeof document === "undefined") {
    return Promise.resolve(false);
  }
  if (runtimeRefs.confirmResolve) {
    const prev = runtimeRefs.confirmResolve;
    runtimeRefs.confirmResolve = null;
    prev(false);
  }
  const resolvedTone = tone === "primary" ? "primary" : "danger";
  return new Promise<boolean>((resolve) => {
    runtimeRefs.confirmResolve = resolve;
    setState({
      confirmDialog: {
        open: true,
        title,
        message,
        detail: String(detail || "").trim(),
        confirmText,
        cancelText,
        tone: resolvedTone,
      },
    });
  });
}

/* ==================== THEME, ACCENT & POPOVERS ==================== */
export function closeAllPopovers() {
  setState({
    openPopover: null,
    selectionToolbar: { open: false, x: 0, y: 0, snippet: "" },
  });
}

export function syncDerivedAccent() {
  const s = getState();
  const primary = getPrimarySessionFromState(s);
  const primaryId = primary?.id || s.primarySessionId || null;
  const active = getActiveSessionFromState(s);
  const av = resolveBotAvatar(active, primaryId);
  const rawColorKey = active?.type === "group" ? "blue" : av.color;
  const effectiveKey = s.settings?.accentMode === "bot" ? rawColorKey : "black";

  if (s.accentColor !== effectiveKey || s.primarySessionId !== primaryId) {
    setState({
      accentColor: effectiveKey,
      primarySessionId: primaryId,
    });
  }

  if (typeof document !== "undefined") {
    const color = getResolvedColorMeta(effectiveKey);
    document.documentElement.style.setProperty("--bot-bright-bg", color.bright || "");
    document.documentElement.style.setProperty("--bot-bright-fg", color.brightFg || "");
    document.documentElement.style.setProperty("--bot-bubble-bg", color.bubble || "");
    document.documentElement.style.setProperty("--bot-bubble-fg", color.bubbleFg || "");
  }
}

function syncThemeToDomAndStorage(themeValue: string) {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null;
  if (meta) {
    meta.content = themeValue === "light" || themeValue === "dark" ? themeValue : "light dark";
  }
  try {
    if (themeValue === "light" || themeValue === "dark") {
      localStorage.setItem("color-scheme", themeValue);
    } else {
      localStorage.removeItem("color-scheme");
    }
  } catch {}
}

export function applyServerSettingsSnapshot(
  saved: Record<string, any> | null | undefined,
  { isMutation = false }: { isMutation?: boolean } = {}
) {
  if (!saved || typeof saved !== "object") return;
  if (isMutation) {
    runtimeRefs.settingsMutationSeq += 1;
    deferredSettingsTasks.delete("settings");
  }
  const hasServerSpellcheck = typeof saved.spellcheckEnabled === "boolean";
  const serverTheme =
    typeof saved.theme === "string" &&
    (saved.theme === "light" || saved.theme === "dark" || saved.theme === "system")
      ? saved.theme
      : null;
  if (typeof saved.language === "string" && !readStoredLanguagePreference()) {
    syncLanguageToDomAndStorage(normalizeLanguagePreference(saved.language), false);
  }

  setState((prev) => ({
    settings: { ...prev.settings, ...saved },
    ...(hasServerSpellcheck ? { spellcheckEnabled: saved.spellcheckEnabled } : {}),
  }));
  if (hasServerSpellcheck) {
    writeUiPrefs({ spellcheckEnabled: saved.spellcheckEnabled });
  }
  if (serverTheme) {
    syncThemeToDomAndStorage(serverTheme);
  }
  syncDerivedAccent();
}

export async function commitSettingsPatch(
  patch: Record<string, any>,
  opts: { silentError?: boolean } = {}
): Promise<any> {
  const reqEpoch = getState().accountEpoch;
  const mutSeq = ++runtimeRefs.settingsMutationSeq;
  runtimeRefs.settingsMutationsInFlight += 1;
  deferredSettingsTasks.delete("settings");
  try {
    const saved = await apiJson("/api/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    });
    if (reqEpoch === getState().accountEpoch && mutSeq === runtimeRefs.settingsMutationSeq) {
      applyServerSettingsSnapshot(saved, { isMutation: false });
    }
    return saved;
  } catch (err) {
    if (!opts.silentError) throw err;
    return null;
  } finally {
    runtimeRefs.settingsMutationsInFlight = Math.max(
      0,
      runtimeRefs.settingsMutationsInFlight - 1
    );
  }
}

export function applyLanguagePreference(
  languageValue: string,
  persist = false
) {
  const norm: LanguagePreference = normalizeLanguagePreference(languageValue);
  const resolved = setLocalLanguageState(norm);
  if (persist) {
    void commitSettingsPatch({ language: norm }, { silentError: true });
    showToast(
      tr("lang.switchedToast", {
        label: formatLanguageOptionLabel(norm, resolved),
      })
    );
  }
  return resolved;
}

export function applyThemePreference(themeValue: string, persist = false) {
  syncThemeToDomAndStorage(themeValue);
  setState((prev) => ({
    settings: { ...prev.settings, theme: themeValue },
  }));
  syncDerivedAccent();

  if (persist) {
    void commitSettingsPatch({ theme: themeValue }, { silentError: true });
  }
}

export function setSpellcheckPreference(enabled: boolean) {
  const next = Boolean(enabled);
  writeUiPrefs({ spellcheckEnabled: next });
  setState((prev) => ({
    spellcheckEnabled: next,
    settings: { ...prev.settings, spellcheckEnabled: next },
  }));
  void commitSettingsPatch({ spellcheckEnabled: next }, { silentError: true });
}

/* ==================== SCROLL PINNING ==================== */
let pendingScrollBottomRaf = 0;
let pendingScrollBottomTimer = 0;

export function scrollChatStreamToBottom(opts: { guardMs?: number; settle?: boolean } = {}) {
  if (typeof document === "undefined") return;
  const streamEl = document.getElementById("event-stream");
  if (!streamEl) return;
  syncMobileChatBottomMetrics();
  const guardMs = Number(opts?.guardMs) || 0;
  const nextGuard =
    guardMs > 0
      ? Math.max(getState().scrollPinGuardUntil || 0, Date.now() + guardMs)
      : getState().scrollPinGuardUntil;
  setState({ autoScrollPinned: true, scrollPinGuardUntil: nextGuard });

  const snap = () => {
    const el = document.getElementById("event-stream");
    if (!el || !getState().autoScrollPinned) return;
    el.scrollTop = el.scrollHeight;
  };
  snap();
  if (pendingScrollBottomRaf) cancelAnimationFrame(pendingScrollBottomRaf);
  pendingScrollBottomRaf = requestAnimationFrame(() => {
    pendingScrollBottomRaf = 0;
    snap();
    if (opts?.settle) {
      requestAnimationFrame(snap);
    }
  });
  if (opts?.settle) {
    if (pendingScrollBottomTimer) clearTimeout(pendingScrollBottomTimer);
    pendingScrollBottomTimer = window.setTimeout(() => {
      pendingScrollBottomTimer = 0;
      snap();
    }, 320);
  }
}

/* ==================== BOT SCREEN OVERLAY & NOVNC ==================== */
export function syncBotScreenLandscapeState() {
  const s = getState();
  const isLandscape =
    typeof window !== "undefined" && window.innerWidth > window.innerHeight;
  const nextLandscape = Boolean(s.screenOverlayOpen && isMobileViewport() && isLandscape);
  if (s.landscapeDesktop !== nextLandscape) {
    setState({ landscapeDesktop: nextLandscape });
  }
}

export function setNovncMode(viewOnly: boolean) {
  if (viewOnly && typeof document !== "undefined") {
    const novncFrame = document.getElementById("novnc-frame") as HTMLIFrameElement | null;
    if (novncFrame && document.activeElement === novncFrame) {
      try {
        novncFrame.blur();
      } catch {}
    }
  }
  setState({ takeoverActive: !viewOnly });
}

export function openBotScreenOverlay(targetBotId?: string | null) {
  setState({
    desktopFullscreen: true,
    screenOverlayOpen: true,
    screenConnecting: true,
    ...(targetBotId ? { screenOverlayTargetBotId: targetBotId } : {}),
  });
  if (isMobileViewport()) {
    setScreenOrientation("sensor");
  }
  syncBotScreenLandscapeState();
  void refreshComputerDisplays();
  if (runtimeRefs.connectingTimer) clearTimeout(runtimeRefs.connectingTimer);
  runtimeRefs.connectingTimer = setTimeout(() => {
    setState({ screenConnecting: false });
    void refreshComputerDisplays();
  }, 420);
}

export function closeBotScreenOverlay() {
  setState({
    desktopFullscreen: false,
    screenOverlayOpen: false,
    landscapeDesktop: false,
  });
  if (isMobileViewport()) {
    setScreenOrientation("portrait");
  }
}

export async function handleBotComputerCardActivate() {
  const s = getState();
  const compState = s.computerStatus?.state || "ready";
  if (compState === "uncreated") {
    const adminBot = s.sessions.find((item) => item.isAdmin) || getPrimarySessionFromState(s);
    if (!adminBot) {
      showToast("未找到管理员 Bot");
      return;
    }
    if (s.activeSessionId !== adminBot.id) {
      await selectSession(adminBot.id);
    }
    await sendUserMessage(PRESET_BOT_COMPUTER_INIT_PROMPT);
    return;
  }
  if (compState === "creating") {
    showToast("正在初始化 Bot 电脑环境，请稍候…");
    return;
  }
  if (compState === "unsupported") {
    showToast(s.computerStatus?.detail || "当前平台暂不支持本地 Bot 电脑");
    return;
  }
  if (compState === "error" || s.computerStatus?.online === false) {
    const adminBot = s.sessions.find((item) => item.isAdmin) || getPrimarySessionFromState(s);
    if (adminBot && s.computerStatus?.provider !== "cloud-linux") {
      if (s.activeSessionId !== adminBot.id) {
        await selectSession(adminBot.id);
      }
      await sendUserMessage(buildBotComputerSelfHealPrompt(s.computerStatus));
      return;
    }
    openSettingsModal("computer");
    return;
  }
  if (s.config?.novncUrl) {
    openBotScreenOverlay();
  } else {
    openSettingsModal("computer");
  }
}

/* ==================== SESSION MANAGEMENT & EVENT STREAM ==================== */
export function upsertLocalSession(session: any) {
  if (!session?.id) return;
  setState((prev) => {
    const idx = prev.sessions.findIndex((s) => s.id === session.id);
    const nextSessions =
      idx >= 0
        ? prev.sessions.map((s, i) => (i === idx ? { ...s, ...session } : s))
        : [session, ...prev.sessions];
    return { sessions: nextSessions };
  });
  syncDerivedAccent();
}

export function renderEmptyState() {
  teardownAllPreviewFrames({ includeModal: false });
  setState({
    streamItems: [],
  });
}

export function resetActiveSessionViewState(sessionId: string | null, wasSameSession: boolean) {
  teardownAllPreviewFrames({ includeModal: true });
  setState({
    activeSessionId: sessionId,
    liveThinkingSummary: "",
    queuedCount: 0,
    renderedSeqs: new Set<number>(),
    streamItems: [],
    traceItems: [],
    lastClusterTs: 0,
    autoScrollPinned: true,
    stepCount: 0,
    lastRouteLabel: "自动调配",
    lastRouteReason: "",
    lastRoutePlan: null,
    lastTierPath: "",
    routerUsage: { calls: 0, tokens: 0 },
    botExchangeSheet: { open: false, participants: [], messages: [] },
    traceDrawerOpen: false,
    computerMiniThumbUrl: null,
    ...(!wasSameSession ? { libraryItems: [], libraryExpanded: false } : {}),
  });
  syncDerivedAccent();
}

export function renderEventForActiveSession(evt: any, { replay = false } = {}) {
  const prev = getState();
  const { next, effects } = reduceSessionEvent(prev, evt, {
    replay,
    resolveApiUrl: apiUrl,
  });
  if (next !== prev) {
    setState(next);
  }
  if (effects.shouldRefreshUsage) {
    refreshUsageAndHealth().catch(() => {});
  }
  if (effects.debouncedRefreshUsage) {
    if (runtimeRefs.usageLiveRefreshTimer) clearTimeout(runtimeRefs.usageLiveRefreshTimer);
    runtimeRefs.usageLiveRefreshTimer = setTimeout(() => {
      refreshUsageAndHealth().catch(() => {});
    }, 350);
  }
  if (!replay && evt?.type !== "error_dismissed" && typeof document !== "undefined") {
    const streamEl = document.getElementById("event-stream");
    if (getState().autoScrollPinned && streamEl) {
      streamEl.scrollTop = streamEl.scrollHeight;
      requestAnimationFrame(() => {
        const el = document.getElementById("event-stream");
        if (el && getState().autoScrollPinned) {
          el.scrollTop = el.scrollHeight;
        }
      });
    } else if (!getState().autoScrollPinned && isMobileViewport()) {
      syncMobileChatBottomMetrics();
    }
  }
}

export function dismissSessionErrorCard(
  itemId: string,
  dismissKey?: string,
  seq?: number,
  clientOnly = false
): void {
  const s = getState();
  const activeSessionId = s.activeSessionId;
  const matchedItem = s.streamItems.find(
    (item): item is Extract<StreamItem, { kind: "error" }> =>
      item.kind === "error" && item.id === itemId
  );
  const resolvedSeq =
    typeof seq === "number" && Number.isFinite(seq)
      ? seq
      : matchedItem && typeof matchedItem.seq === "number" && Number.isFinite(matchedItem.seq)
        ? matchedItem.seq
        : undefined;
  const resolvedKey = dismissKey || matchedItem?.dismissKey;
  const isClientOnly = Boolean(clientOnly || matchedItem?.clientOnly);

  // Optimistic local dismissal + localStorage fallback for older backends / offline mode
  dismissErrorCard(itemId, resolvedKey, resolvedSeq);

  if (!activeSessionId || isClientOnly) return;
  if (resolvedSeq === undefined && !resolvedKey) return;

  apiJson(`/api/sessions/${activeSessionId}/errors/dismiss`, {
    method: "POST",
    suppressLanOfflineModal: true,
    body: JSON.stringify({
      ...(resolvedSeq !== undefined ? { seq: resolvedSeq } : {}),
      ...(resolvedKey ? { dismissKey: resolvedKey } : {}),
    }),
  }).catch(() => {
    // Graceful fallback: local dismissal already succeeded (e.g. older backend node)
  });
}

function resolveFallbackObservedModel(session: any, fallbackObservedModel = ""): string {
  const explicitSessionModel = String(session?.model || "")
    .trim()
    .replace(/^models\//i, "");
  if (explicitSessionModel) return explicitSessionModel;
  const prevObserved = String(fallbackObservedModel || "")
    .trim()
    .replace(/^models\//i, "");
  if (prevObserved) return prevObserved;
  const boundMedium = String(getState().settings?.routing?.tiers?.medium?.model || "").trim();
  if (boundMedium) return boundMedium;
  return "gemini-4-argon";
}

function syncUsageStateFromSessionData(session: any, data: any, fallbackObservedModel = "") {
  const lastObservedModel = resolveFallbackObservedModel(session, fallbackObservedModel);
  const usage = session?.usage
    ? {
        input: Number(session.usage.input) || 0,
        output: Number(session.usage.output) || 0,
      }
    : { input: 0, output: 0 };

  let sessionUsageByProviderModel: Record<string, any> = {};
  if (
    Array.isArray(data?.usageSummary?.byProviderBuckets) &&
    data.usageSummary.byProviderBuckets.length > 0
  ) {
    for (const b of data.usageSummary.byProviderBuckets) {
      if (!b?.est || (b.est.totalTokens || 0) <= 0) continue;
      const pmKey = `${b.providerId || "default"}::${b.model || b.est.model}`;
      const prev = sessionUsageByProviderModel[pmKey];
      if (!prev) {
        sessionUsageByProviderModel[pmKey] = {
          input: Number(b.est.inputTokens) || 0,
          output: Number(b.est.outputTokens) || 0,
          cached: Number(b.est.cachedTokens) || 0,
          thoughts: Number(b.est.thoughtTokens) || 0,
          calls: Number(b.calls) || 0,
          costCny: Number(b.est.costCny) || 0,
          costUsd: Number(b.est.costUsd) || 0,
          hasExactCost: true,
        };
      } else {
        prev.input += Number(b.est.inputTokens) || 0;
        prev.output += Number(b.est.outputTokens) || 0;
        prev.cached += Number(b.est.cachedTokens) || 0;
        prev.thoughts += Number(b.est.thoughtTokens) || 0;
        prev.calls += Number(b.calls) || 0;
        prev.costCny += Number(b.est.costCny) || 0;
        prev.costUsd += Number(b.est.costUsd) || 0;
      }
    }
  } else if (session?.usageByProviderModel && typeof session.usageByProviderModel === "object") {
    for (const [k, v] of Object.entries(session.usageByProviderModel)) {
      if (!v || typeof v !== "object") continue;
      sessionUsageByProviderModel[k] = {
        input: Number((v as any).input) || 0,
        output: Number((v as any).output) || 0,
        cached: Number((v as any).cached) || 0,
        thoughts: Number((v as any).thoughts) || 0,
        calls: Number((v as any).calls) || 0,
        ...((v as any).costVersion === 2 && typeof (v as any).costNative === "number"
          ? {
              costNative: Number((v as any).costNative) || 0,
              costCurrency: (v as any).costCurrency,
              costVersion: 2,
            }
          : {}),
      };
    }
  }

  const sessionUsageByModel: Record<string, any> = {};
  if (Array.isArray(data?.usageSummary?.byModel) && data.usageSummary.byModel.length > 0) {
    for (const m of data.usageSummary.byModel) {
      if ((m.totalTokens || 0) <= 0) continue;
      sessionUsageByModel[m.model] = {
        input: Number(m.inputTokens) || 0,
        output: Number(m.outputTokens) || 0,
        cached: Number(m.cachedTokens) || 0,
        thoughts: Number(m.thoughtTokens) || 0,
        calls: Number(m.calls) || 0,
        costCny: Number(m.costCny) || 0,
        costUsd: Number(m.costUsd) || 0,
        hasExactCost: true,
      };
    }
  }

  return {
    lastObservedModel,
    usage,
    sessionUsageByModel,
    sessionUsageByProviderModel,
  };
}

function activeSessionStorageKey(accountId?: string | null): string {
  return `tb_active_session:${String(accountId || LOCAL_ACCOUNT_ID)}`;
}

function saveLastActiveSessionId(sessionId: string) {
  if (!sessionId || typeof sessionStorage === "undefined") return;
  try {
    const accountId = getState().accountsState?.activeAccountId || LOCAL_ACCOUNT_ID;
    sessionStorage.setItem(activeSessionStorageKey(accountId), sessionId);
  } catch {}
}

function readLastActiveSessionId(): string {
  if (typeof sessionStorage === "undefined") return "";
  try {
    const accountId = getState().accountsState?.activeAccountId || LOCAL_ACCOUNT_ID;
    return String(sessionStorage.getItem(activeSessionStorageKey(accountId)) || "").trim();
  } catch {
    return "";
  }
}

export async function selectSession(sessionId: string) {
  if (!sessionId) return;
  saveLastActiveSessionId(sessionId);
  const selectSeq = ++runtimeRefs.selectSessionSeq;
  const opts = runtimeRefs.nextSelectOpts || {};
  runtimeRefs.nextSelectOpts = null;
  const sBefore = getState();
  const wasSameSession = sBefore.activeSessionId === sessionId;
  const isSilentReconnectSync = Boolean(opts.preserveScrollIfUnpinned && wasSameSession);
  const prevUnread =
    Number(sBefore.sessions.find((s) => s.id === sessionId)?.unreadCount) || 0;

  if (!isSilentReconnectSync) {
    resetActiveSessionViewState(sessionId, wasSameSession);
  }

  const data = await apiJson(`/api/sessions/${sessionId}`);
  if (selectSeq !== runtimeRefs.selectSessionSeq || getState().activeSessionId !== sessionId) {
    return;
  }

  const session = data.session || {};
  const events: any[] = Array.isArray(data.events) ? data.events : [];
  const nextQueuedCount = Math.max(0, Number(data.queueLength) || 0);

  const curActiveMap = { ...getState().activeMap };
  if ("activeState" in data) {
    if (data.activeState) {
      curActiveMap[sessionId] = data.activeState;
    } else {
      delete curActiveMap[sessionId];
    }
  }
  const effectiveSessionStatus =
    "activeState" in data
      ? data.activeState ||
        (isSessionCurrentlyBusy(session.status) ? "stopped" : session.status) ||
        "idle"
      : curActiveMap[sessionId] || session.status || "idle";

  session.status = effectiveSessionStatus;
  session.unreadCount = 0;

  setState({
    activeMap: curActiveMap,
    sessionStatus: effectiveSessionStatus,
    queuedCount: nextQueuedCount,
  });
  upsertLocalSession(session);

  if (prevUnread > 0) {
    apiJson(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ unreadCount: 0, touch: false }),
    }).catch(() => {});
  }

  const sMid = getState();
  const streamEl = typeof document !== "undefined" ? document.getElementById("event-stream") : null;
  const curScrollTop = streamEl ? streamEl.scrollTop : 0;
  const curAutoScrollPinned = sMid.autoScrollPinned;

  let canSkipRebuild = false;
  let appendableNewEvents: any[] | null = null;
  if (isSilentReconnectSync) {
    const allHaveSeq = events.every((ev) => ev && ev.seq !== undefined);
    if (events.length === 0 && sMid.streamItems.length === 0 && sMid.renderedSeqs.size === 0) {
      canSkipRebuild = true;
    } else if (events.length > 0 && allHaveSeq) {
      const serverSeqSet = new Set(events.map((ev) => ev.seq));
      const allRenderedStillPresent = Array.from(sMid.renderedSeqs).every((seq) =>
        serverSeqSet.has(seq)
      );
      if (allRenderedStillPresent) {
        const missing = events.filter((ev) => !sMid.renderedSeqs.has(ev.seq));
        if (missing.length === 0) {
          canSkipRebuild = true;
        } else if (sMid.streamItems.length > 0 && sMid.renderedSeqs.size > 0) {
          const maxRenderedSeq = Math.max(...Array.from(sMid.renderedSeqs, Number));
          if (missing.every((ev) => Number(ev.seq) > maxRenderedSeq)) {
            appendableNewEvents = missing;
          }
        }
      }
    }
  }

  if (canSkipRebuild) {
    const usagePatch = syncUsageStateFromSessionData(session, data, getState().lastObservedModel);
    setState((prev) => ({
      ...usagePatch,
      ...(isSessionCurrentlyBusy(effectiveSessionStatus)
        ? {}
        : {
            liveThinkingSummary: "",
            streamItems: finalizeOrphanedInteractiveItems(prev.streamItems, "⏹ 上一轮操作已中断"),
          }),
    }));
    syncDerivedAccent();
    if (getState().inspectorTab === "library" || getState().mobileSheets.inspectorOpen || isMobileViewport()) {
      refreshLibrary();
    }
    return;
  }

  if (appendableNewEvents) {
    setState({ isReplaying: true });
    try {
      let working = getState();
      if (prevUnread > 0) {
        working = {
          ...working,
          streamItems: [
            ...working.streamItems,
            { kind: "unread_divider", id: nextStreamItemId("unread") },
          ],
        };
      }
      for (const ev of appendableNewEvents) {
        working = reduceSessionEvent(working, ev, { replay: true, resolveApiUrl: apiUrl }).next;
      }
      if (!isSessionCurrentlyBusy(effectiveSessionStatus)) {
        working = {
          ...working,
          liveThinkingSummary: "",
          streamItems: finalizeOrphanedInteractiveItems(working.streamItems, "⏹ 上一轮操作已中断"),
        };
      }
      setState({
        ...working,
        ...syncUsageStateFromSessionData(session, data, working.lastObservedModel),
      });
    } finally {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => setState({ isReplaying: false }));
      } else {
        setState({ isReplaying: false });
      }
    }
    syncDerivedAccent();
    if (curAutoScrollPinned) {
      scrollChatStreamToBottom({ guardMs: 450, settle: true });
    }
    if (getState().inspectorTab === "library" || getState().mobileSheets.inspectorOpen || isMobileViewport()) {
      refreshLibrary();
    }
    return;
  }

  if (isSilentReconnectSync) {
    resetActiveSessionViewState(sessionId, true);
    setState({ autoScrollPinned: curAutoScrollPinned });
  }

  renderEmptyState();
  setState({ isReplaying: true });
  try {
    let working: any = {
      ...getState(),
      usage: { input: 0, output: 0 },
      sessionUsageByModel: {},
      sessionUsageByProviderModel: {},
      lastObservedModel:
        String(session.model || "")
          .trim()
          .replace(/^models\//i, ""),
    };
    const unreadStartIdx = prevUnread > 0 ? Math.max(0, events.length - prevUnread * 3) : -1;
    events.forEach((ev, idx) => {
      if (idx === unreadStartIdx && prevUnread > 0) {
        working = {
          ...working,
          streamItems: [
            ...working.streamItems,
            { kind: "unread_divider", id: nextStreamItemId("unread") },
          ],
        };
      }
      working = reduceSessionEvent(working, ev, { replay: true, resolveApiUrl: apiUrl }).next;
    });
    if (!isSessionCurrentlyBusy(effectiveSessionStatus)) {
      working = {
        ...working,
        liveThinkingSummary: "",
        streamItems: finalizeOrphanedInteractiveItems(working.streamItems, "⏹ 上一轮操作已中断"),
      };
    }
    setState({
      ...working,
      ...syncUsageStateFromSessionData(session, data, working.lastObservedModel),
    });
  } finally {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setState({ isReplaying: false }));
    } else {
      setState({ isReplaying: false });
    }
  }

  syncDerivedAccent();
  if (streamEl) {
    if (opts.preserveScrollIfUnpinned && wasSameSession && !getState().autoScrollPinned) {
      streamEl.scrollTop = curScrollTop;
    } else {
      scrollChatStreamToBottom({ guardMs: 450, settle: true });
    }
  }

  if (getState().inspectorTab === "library" || getState().mobileSheets.inspectorOpen || isMobileViewport()) {
    refreshLibrary();
  }
}

export function applySessionClearedUI(sessionId: string, updatedSession: any = null) {
  if (!sessionId) return;
  if (updatedSession) {
    upsertLocalSession(updatedSession);
  } else {
    const existing = getState().sessions.find((s) => s.id === sessionId);
    if (existing) {
      upsertLocalSession({
        ...existing,
        status: "idle",
        lastMessagePreview: "",
        stepCount: 0,
        unreadCount: 0,
      });
    }
  }
  if (getState().activeSessionId === sessionId) {
    renderEmptyState();
    setState({
      sessionStatus: "idle",
      renderedSeqs: new Set<number>(),
      traceItems: [],
      stepCount: 0,
      usage: { input: 0, output: 0 },
      sessionUsageByModel: {},
      sessionUsageByProviderModel: {},
      liveThinkingSummary: "",
      queuedCount: 0,
    });
    syncDerivedAccent();
  }
}

export async function clearSessionHistory(sessionId: string, { skipConfirm = false } = {}) {
  if (!sessionId) return false;
  const target = getState().sessions.find((s) => s.id === sessionId);
  const label = target?.title || "当前会话";
  if (!skipConfirm) {
    const ok = await showConfirmDialog({
      title: "清空对话记录",
      message: `确定要清空「${label}」的所有对话记录吗？`,
      detail: "Bot 人设、记忆、技能和配置将保留。",
      confirmText: "确认清空",
      cancelText: "取消",
      tone: "danger",
    });
    if (!ok) return false;
  }
  const res = await apiJson(`/api/sessions/${sessionId}/clear`, {
    method: "POST",
  });
  applySessionClearedUI(sessionId, res?.session || null);
  showToast(`已清空「${label}」对话记录`);
  return true;
}

export async function deleteSessionWithConfirm(sessionId: string) {
  if (!sessionId) return false;
  const target = getState().sessions.find((s) => s.id === sessionId);
  if (!target) return false;
  if (target.isAdmin) {
    showToast("管理员 Bot 严禁删除");
    return false;
  }
  const label = target.title && target.title !== "New Session" ? target.title : "新 Bot";
  const isGroup = target.type === "group";
  const ok = await showConfirmDialog({
    title: isGroup ? "删除群聊" : "删除 Bot",
    message: `确定要删除${isGroup ? "群聊" : " Bot"}「${label}」吗？`,
    detail: isGroup
      ? "删除后将永久移除该协作群聊及其全部历史对话记录，成员 Bot 本身保留。"
      : "删除后将永久移除该 Bot 及其人设、专属记忆和全部历史对话记录。",
    confirmText: "确认删除",
    cancelText: "取消",
    tone: "danger",
  });
  if (!ok) return false;
  try {
    await apiJson(`/api/sessions/${sessionId}`, { method: "DELETE" });
    const nextSessions = getState().sessions.filter((s) => s.id !== sessionId);
    setState({ sessions: nextSessions });
    if (getState().activeSessionId === sessionId) {
      if (nextSessions[0]) {
        await selectSession(nextSessions[0].id);
      } else {
        setState({ activeSessionId: null });
        renderEmptyState();
      }
    }
    syncDerivedAccent();
    showToast(`已删除「${label}」`);
    return true;
  } catch (err: any) {
    showToast(`删除失败: ${err?.message || err}`);
    return false;
  }
}

export function applySessionRewoundUI(
  sessionId: string,
  keptEvents: any[] = [],
  updatedSession: any = null
) {
  if (!sessionId) return;
  if (updatedSession) {
    upsertLocalSession(updatedSession);
  }
  if (getState().activeSessionId === sessionId) {
    renderEmptyState();
    let working: any = {
      ...getState(),
      sessionStatus: "idle",
      renderedSeqs: new Set<number>(),
      traceItems: [],
      stepCount: 0,
      usage: { input: 0, output: 0 },
      sessionUsageByModel: {},
      sessionUsageByProviderModel: {},
      liveThinkingSummary: "",
      queuedCount: 0,
      lastClusterTs: 0,
    };
    const safeEvents = Array.isArray(keptEvents) ? keptEvents : [];
    for (const ev of safeEvents) {
      working = reduceSessionEvent(working, ev, { replay: true, resolveApiUrl: apiUrl }).next;
    }
    setState(working);
    syncDerivedAccent();
  }
}

/* ==================== COMPOSER & ATTACHMENTS ==================== */
export async function uploadAndStageFiles(files: File[]) {
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      showToast(`${file.name} 超过 10MB 限制`);
      continue;
    }
    const base64 = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.readAsDataURL(file);
    });
    const activeSessionId = getState().activeSessionId || "";
    const uploaded = await apiJson("/api/attachments", {
      method: "POST",
      body: JSON.stringify({
        name: file.name || `paste_${Date.now()}.png`,
        dataBase64: base64,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      }),
    });
    setState((prev) => ({
      pendingAttachments: [...prev.pendingAttachments, uploaded],
    }));
  }
}

export function closeNewChatBar() {
  setState({
    newChatBarOpen: false,
    newChatRecipients: [],
    newChatGroupMode: false,
    newChatQuery: "",
  });
}

export function openNewChatBar(groupMode = false) {
  closeAllPopovers();
  setState({
    newChatBarOpen: true,
    newChatGroupMode: groupMode,
    newChatRecipients: [],
    newChatQuery: "",
  });
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      (document.getElementById("new-chat-input") as HTMLInputElement | null)?.focus();
    });
  }
}

export async function sendUserMessage(rawText?: string) {
  const s = getState();
  let text = String(rawText ?? s.composerText ?? "").trim();
  const stagedAttachments = [...s.pendingAttachments];
  const stagedQuotes = [...s.pendingQuotes];
  const stagedReplyTarget = s.replyTarget ? { ...s.replyTarget } : null;

  const msgInputEl =
    typeof document !== "undefined"
      ? (document.getElementById("message-input") as HTMLTextAreaElement | null)
      : null;
  const sendBtnEl =
    typeof document !== "undefined"
      ? (document.getElementById("send-btn") as HTMLButtonElement | null)
      : null;

  const shouldKeepFocus =
    !isMobileViewport() ||
    s.keepInputFocusedOnSend ||
    (typeof document !== "undefined" &&
      (document.activeElement === msgInputEl || document.activeElement === sendBtnEl));

  if (!text && stagedAttachments.length === 0 && stagedQuotes.length === 0) {
    showToast("请输入消息内容");
    msgInputEl?.focus();
    setState({ keepInputFocusedOnSend: false });
    return;
  }

  if (stagedAttachments.length > 0) {
    const lines = stagedAttachments.map((att) =>
      att.isMedia
        ? `[图片附件: ${att.name}](${att.url})\n(工作区路径: ${att.path})`
        : `[文件附件: ${att.name} · 路径: ${att.path}]`
    );
    text = `${lines.join("\n")}\n${text}`.trim();
    setState({ pendingAttachments: [] });
  }

  if (s.newChatBarOpen && s.newChatRecipients.length >= 2) {
    const names = s.newChatRecipients.map((b) => b.title).join("、");
    const group = await apiJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: `${names.slice(0, 22)} 协作群`,
        type: "group",
        memberBotIds: s.newChatRecipients.map((b) => b.id),
      }),
    });
    closeNewChatBar();
    upsertLocalSession(group);
    await selectSession(group.id);
  }

  if (s.replyQuote && !stagedReplyTarget) {
    text = `> ${s.replyQuote}\n\n${text}`;
  }
  // Invalidate any in-flight voice recognition session before clearing composerText
  // so late async rec.onresult callbacks cannot write stale transcripts back (PI-012).
  runtimeRefs.voiceSessionSeq = (runtimeRefs.voiceSessionSeq || 0) + 1;
  if (runtimeRefs.speechRec) {
    const activeRec = runtimeRefs.speechRec;
    runtimeRefs.speechRec = null;
    try {
      if (typeof activeRec.abort === "function") {
        activeRec.abort();
      } else if (typeof activeRec.stop === "function") {
        activeRec.stop();
      }
    } catch {}
  }
  setState({
    replyQuote: null,
    replyTarget: null,
    pendingQuotes: [],
    composerText: "",
    isRecordingVoice: false,
    openPopover: getState().openPopover === "mention" ? null : getState().openPopover,
  });
  if (msgInputEl && msgInputEl.value) {
    msgInputEl.value = "";
  }

  if (!getState().activeSessionId) {
    const created = await apiJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Twinkle" }),
    });
    upsertLocalSession(created);
    await selectSession(created.id);
  }

  const activeSid = getState().activeSessionId!;
  const wasBusy = isSessionCurrentlyBusy(getState().sessionStatus);

  if (!wasBusy) {
    setState((prev) => ({
      streamItems: prev.streamItems.map((it): StreamItem =>
        it.kind === "choice" && it.status === "pending" ? { ...it, status: "superseded" } : it
      ),
    }));
  }

  if (shouldKeepFocus && typeof document !== "undefined" && document.activeElement !== msgInputEl) {
    msgInputEl?.focus?.({ preventScroll: true });
  }
  let blurredAfterSend = false;
  const onBlurAfterSend = () => {
    blurredAfterSend = true;
  };
  if (msgInputEl) {
    msgInputEl.addEventListener("blur", onBlurAfterSend, { once: true });
  }
  scrollChatStreamToBottom({ guardMs: 500, settle: true });

  try {
    if (!wasBusy) {
      setState((prev) => ({
        sessionStatus: "running",
        activeMap: { ...prev.activeMap, [activeSid]: "running" },
      }));
    }

    const isMobClient = isMobileViewport() || isMobileAppTarget();
    const clientSource = isMobClient
      ? { deviceKind: "mobile" as const, platform: getMobilePlatform() || "mobile" }
      : {
          deviceKind: "desktop" as const,
          platform:
            (typeof window !== "undefined" ? (window as any)?.twinklebotDesktop?.platform : "") ||
            "web",
        };

    const msgRes = await apiJson(`/api/sessions/${activeSid}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text,
        clientSource,
        ...(stagedReplyTarget ? { replyTo: stagedReplyTarget } : {}),
        ...(stagedQuotes.length > 0 ? { quotes: stagedQuotes } : {}),
        ...(stagedAttachments.length > 0 ? { attachments: stagedAttachments } : {}),
      }),
    });

    if (msgRes?.stopped) {
      setState((prev) => {
        const nextMap = { ...prev.activeMap };
        delete nextMap[activeSid];
        return {
          sessionStatus: "stopped",
          liveThinkingSummary: "",
          queuedCount: 0,
          activeMap: nextMap,
        };
      });
    } else if (msgRes?.queued) {
      setState({ queuedCount: Number(msgRes.queueLength) || 1 });
    }

    const refreshed = await apiJson("/api/sessions");
    if (Array.isArray(refreshed.sessions)) {
      setState((prev) => {
        const nextActiveMap =
          refreshed.activeSessions && typeof refreshed.activeSessions === "object"
            ? refreshed.activeSessions
            : prev.activeMap;
        const curSession = refreshed.sessions.find((x: any) => x.id === prev.activeSessionId);
        const shouldSettleStatus =
          prev.activeSessionId &&
          !nextActiveMap[prev.activeSessionId] &&
          curSession &&
          !isSessionCurrentlyBusy(curSession.status) &&
          isSessionCurrentlyBusy(prev.sessionStatus);
        return {
          sessions: refreshed.sessions,
          activeMap: nextActiveMap,
          ...(shouldSettleStatus
            ? {
                sessionStatus: curSession.status || "done",
                liveThinkingSummary: "",
              }
            : {}),
        };
      });
      syncDerivedAccent();
    }
  } catch (err: any) {
    renderEventForActiveSession({
      type: "error",
      message: err?.message || "发送失败",
      clientOnly: true,
    });
  } finally {
    if (msgInputEl) {
      msgInputEl.removeEventListener("blur", onBlurAfterSend);
    }
    setState({ keepInputFocusedOnSend: false });
    const hasPendingChoice = getState().streamItems.some(
      (it) => it.kind === "choice" && it.status === "pending"
    );
    if (
      shouldKeepFocus &&
      !blurredAfterSend &&
      !hasPendingChoice &&
      typeof document !== "undefined" &&
      document.activeElement !== msgInputEl
    ) {
      msgInputEl?.focus?.({ preventScroll: true });
    }
    if (getState().autoScrollPinned) {
      scrollChatStreamToBottom();
    }
  }
}

export async function continueFromMaxSteps() {
  const s = getState();
  const activeSid = s.activeSessionId;
  if (!activeSid || isSessionCurrentlyBusy(s.sessionStatus)) return;
  const prevStatus = s.sessionStatus || "max_steps";
  try {
    setState((prev) => ({
      sessionStatus: "running",
      activeMap: { ...prev.activeMap, [activeSid]: "running" },
    }));
    await apiJson(`/api/sessions/${activeSid}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text: "继续执行未完成的任务，请从当前进度接续完成。",
      }),
    });
    scrollChatStreamToBottom({ guardMs: 400, settle: true });
  } catch (err: any) {
    setState((prev) => {
      const nextMap = { ...prev.activeMap };
      delete nextMap[activeSid];
      return {
        sessionStatus: prevStatus,
        activeMap: nextMap,
      };
    });
    showToast(`继续执行失败: ${err?.message || "请求失败"}`);
  }
}

export async function stopCurrentSessionTask() {
  const targetSessionId = getState().activeSessionId;
  if (!targetSessionId) return;
  setNovncMode(true);
  await apiJson("/api/control", {
    method: "POST",
    body: JSON.stringify({ action: "stop", sessionId: targetSessionId }),
  }).catch(() => {});
  setState((prev) => {
    const nextMap = { ...prev.activeMap };
    delete nextMap[targetSessionId];
    return {
      sessionStatus: "stopped",
      liveThinkingSummary: "",
      queuedCount: 0,
      activeMap: nextMap,
    };
  });
}

/* ==================== AVATAR, MODALS, SETTINGS, BILLING & SKILLS ==================== */
let avatarPatchSeq = 0;

export async function saveActiveAvatarPatch(patch: any) {
  const s = getState();
  if (!s.activeSessionId) return;
  const activeSid = s.activeSessionId;
  const active = getActiveSessionFromState(s);
  const currentAv = resolveBotAvatar(active, s.primarySessionId);
  const nextAvatar = { ...currentAv, ...patch };
  const seq = ++avatarPatchSeq;
  if (active) {
    upsertLocalSession({ ...active, avatar: nextAvatar });
  }
  const updated = await apiJson(`/api/sessions/${activeSid}`, {
    method: "PATCH",
    body: JSON.stringify({ avatar: nextAvatar, touch: false }),
  });
  if (seq === avatarPatchSeq) {
    upsertLocalSession(updated);
  }
}

export function openSettingsModal(
  tab: AppStateTab = "general",
  opts: { newMemory?: boolean } = {}
) {
  const prev = getState();
  const wasOpen = prev.settingsModal.open;
  const wasStandalone = Boolean(prev.settingsModal.standaloneBotSessionId);
  closeAllPopovers();
  setState({
    usageScope: "all",
    usageScopeSessionId: null,
    usageTraceActive: false,
    settingsModal: {
      open: true,
      tab,
      standaloneBotSessionId: null,
      openNewMemoryOnMount: Boolean(tab === "general" && opts.newMemory),
    },
  });
  if (!wasOpen || wasStandalone) {
    void refreshSettingsFromServer({ retries: 1 });
    refreshUsageAndHealth();
    refreshVault();
    refreshSystemDiagnostics(false);
    void refreshLocalUpdateMetadata();
  } else if (tab === "usage" || tab === "computer") {
    refreshUsageAndHealth();
  } else if (tab === "vault") {
    refreshVault();
  } else if (tab === "updates") {
    refreshSystemDiagnostics(false);
    void refreshLocalUpdateMetadata();
  }
}

type AppStateTab = "general" | "models" | "computer" | "permissions" | "vault" | "usage" | "updates";

export function openBotUsageModal(sessionId?: string | null) {
  const prev = getState();
  const scopedSid = sessionId || prev.activeSessionId || "";
  closeAllPopovers();
  setState({
    usageScope: "session",
    usageScopeSessionId: scopedSid || null,
    usageTraceActive: false,
    settingsModal: {
      open: true,
      tab: "usage",
      standaloneBotSessionId: scopedSid || null,
      openNewMemoryOnMount: false,
    },
  });
  refreshUsageAndHealth();
}

export function closeSettingsModal() {
  const prev = getState();
  const returnToMobile = isMobileViewport() && prev.mobileReturnToSettingsSheet;
  setState({
    usageTraceActive: false,
    usageScope: "all",
    usageScopeSessionId: null,
    mobileReturnToSettingsSheet: false,
    settingsModal: {
      ...prev.settingsModal,
      open: false,
      standaloneBotSessionId: null,
      openNewMemoryOnMount: false,
    },
    ...(returnToMobile
      ? { mobileSheets: { ...prev.mobileSheets, settingsOpen: true } }
      : {}),
  });
}

export function openAppsModal(
  view: "store" | "manage" | "detail" | "installed" | "directory" = "store",
  opts: { skillId?: string; from?: "store" | "manage" } = {}
) {
  const normalized: "store" | "manage" | "detail" =
    view === "installed" ? "manage" : view === "directory" ? "store" : view;
  closeAllPopovers();
  const prev = getState();
  const detailSkillId =
    normalized === "detail" ? opts.skillId || prev.detailSkillId || "qqmail" : prev.detailSkillId;
  const detailFrom = normalized === "detail" ? opts.from || "store" : prev.detailFrom;

  setState({
    appsModalOpen: true,
    skillsView: normalized,
    detailSkillId,
    detailFrom,
    ...(normalized === "detail"
      ? {
          mailEditorOpen: false,
          editingMailAccountId: null,
          pendingRemoveSkillId: null,
          mcpFeedback: { text: "", kind: "info" },
        }
      : {
          pendingRemoveSkillId: null,
          pendingDeleteCustomSkillId: null,
          ...(normalized !== "manage"
            ? {
                customSkillEditorOpen: false,
                editingCustomSkillId: null,
                customSkillPreviewMode: false,
                customSkillFeedback: "",
              }
            : {}),
        }),
    mailListFeedback: { text: "", kind: "info" },
    mailFormFeedback: {
      qqmail: { text: "", kind: "info" },
      "custom-mail": { text: "", kind: "info" },
    },
  });

  if (normalized === "detail" && detailSkillId) {
    const isChannelSkill =
      detailSkillId === "feishu-bot" || detailSkillId === "telegram-bot";
    const targetSkill = getConfigurableSkillFromSettings(getState().settings, detailSkillId);
    if (isChannelSkill) {
      // Channel skills use /api/integrations/channels, not MCP stdio servers
      void refreshSettingsFromServer({ retries: 0 });
    } else if (targetSkill?.mcpServerId || targetSkill?.category === "platform") {
      refreshMcpSkillStatus(targetSkill.mcpServerId || targetSkill.id, true);
    } else {
      setState({
        activeMailProvider: detailSkillId === "custom-mail" ? "custom-mail" : "qqmail",
      });
    }
  }
}

export function closeAppsModal() {
  const prev = getState();
  const returnToMobile = isMobileViewport() && prev.mobileReturnToSettingsSheet;
  setState({
    appsModalOpen: false,
    mobileReturnToSettingsSheet: false,
    ...(returnToMobile
      ? { mobileSheets: { ...prev.mobileSheets, settingsOpen: true } }
      : {}),
  });
}

export async function refreshSettingsFromServer(
  opts: { retries?: number } = {}
) {
  const reqEpoch = getState().accountEpoch;
  const startMutSeq = runtimeRefs.settingsMutationSeq;
  const fetchSeq = ++runtimeRefs.settingsFetchSeq;
  const maxRetries = Math.max(0, Math.min(3, Number(opts.retries ?? 2)));
  const retryDelays = [250, 600, 1200];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const s = await apiJson("/api/settings");
      if (
        reqEpoch !== getState().accountEpoch ||
        fetchSeq !== runtimeRefs.settingsFetchSeq ||
        runtimeRefs.settingsMutationSeq !== startMutSeq ||
        runtimeRefs.settingsMutationsInFlight > 0
      ) {
        return;
      }
      runWhenSettingsScrollIdle("settings", () => {
        if (
          reqEpoch !== getState().accountEpoch ||
          fetchSeq !== runtimeRefs.settingsFetchSeq ||
          runtimeRefs.settingsMutationSeq !== startMutSeq ||
          runtimeRefs.settingsMutationsInFlight > 0
        ) {
          return;
        }
        applyServerSettingsSnapshot(s, { isMutation: false });
      });
      return;
    } catch (err: any) {
      if (
        err?.code === "STALE_ACCOUNT_EPOCH" ||
        reqEpoch !== getState().accountEpoch ||
        fetchSeq !== runtimeRefs.settingsFetchSeq ||
        getState().lanNodeOffline ||
        isRemoteAccountOffline(getState())
      ) {
        return;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt] || 500));
        if (
          reqEpoch !== getState().accountEpoch ||
          fetchSeq !== runtimeRefs.settingsFetchSeq
        ) {
          return;
        }
      }
    }
  }
}

export async function refreshSystemDiagnostics(showFeedback = false) {
  const reqEpoch = getState().accountEpoch;
  try {
    const d = await apiJson("/api/system/diagnostics");
    if (reqEpoch !== getState().accountEpoch) return;
    const apply = () => {
      setState({ diagnostics: d });
      syncConnectedNodeStatusWithManifest(d);
    };
    if (showFeedback) {
      apply();
      showToast("系统运行诊断已刷新");
    } else {
      runWhenSettingsScrollIdle("diagnostics", apply);
    }
  } catch {
    if (showFeedback && reqEpoch === getState().accountEpoch) {
      showToast("诊断信息读取失败");
    }
  }
}

export async function loadProviderBillingSummary() {
  const fetchSeq = ++runtimeRefs.providerBillingFetchSeq;
  try {
    const data = await apiJson("/api/billing/summary");
    if (fetchSeq !== runtimeRefs.providerBillingFetchSeq) return getState().providerBilling;
    runWhenSettingsScrollIdle("provider-billing", () => {
      setState({ providerBilling: data });
    });
    return data;
  } catch {
    return null;
  }
}

export async function refreshAllLiveProviderBalances() {
  try {
    const data = await apiJson("/api/billing/refresh", { method: "POST", body: "{}" });
    setState({ providerBilling: data });
    const failed = (data.results || []).filter((r: any) => !r.ok);
    if (failed.length > 0) {
      showToast(`部分供应商刷新失败：${failed[0].error || "请检查密钥或网络"}`);
    } else {
      showToast("✓ 已刷新全部实时余额");
    }
  } catch (err: any) {
    showToast(`刷新失败：${err?.message || "请求异常"}`);
  }
}

export async function refreshComputerDisplays() {
  const s = getState();
  if (!hasConnectedNodeCapability("multi-display-v1", s)) return;
  try {
    const res = await apiJson("/api/computer/displays", { suppressLanOfflineModal: true });
    if (res && typeof res === "object") {
      setState({
        computerDisplays: {
          bindings: res.bindings && typeof res.bindings === "object" ? res.bindings : {},
          displays: Array.isArray(res.displays) ? res.displays : [],
          pool: res.pool && typeof res.pool === "object" ? res.pool : null,
        },
      });
    }
  } catch {}
}

let inflightComputerStatusPromise: Promise<void> | null = null;
let computerStatusSeq = 0;

function applyComputerStatusPayload(c: any) {
  if (!c || typeof c !== "object") return;
  const online = Boolean(c.online);
  setState((prev) => ({
    computerStatus: {
      state: c.state || (online ? "ready" : "uncreated"),
      provider: c.provider || prev.computerStatus?.provider || "orbstack",
      online,
      latencyMs: c.latencyMs,
      screen: c.screen,
      detail: typeof c.detail === "string" ? c.detail : c.error || "",
      error: online ? undefined : c.error,
      errorCode: online ? undefined : c.errorCode,
      vmInstalled: c.vmInstalled,
      vmRunning: c.vmRunning,
      hostComputer: c.hostComputer || prev.computerStatus?.hostComputer,
      localBrowser: c.localBrowser || prev.computerStatus?.localBrowser,
    },
  }));
}

export async function refreshComputerStatus(
  opts: { suppressLanOfflineModal?: boolean; force?: boolean } = {}
) {
  if (inflightComputerStatusPromise && !opts.force) {
    return inflightComputerStatusPromise;
  }
  const epoch = getState().accountEpoch;
  const reqSeq = ++computerStatusSeq;
  const promise = (async () => {
    try {
      const c = await apiJson("/api/computer/status", {
        suppressLanOfflineModal: opts.suppressLanOfflineModal,
      });
      if (epoch !== getState().accountEpoch || reqSeq !== computerStatusSeq) {
        return getState().computerStatus;
      }
      if (opts.force) {
        applyComputerStatusPayload(c);
      } else {
        runWhenSettingsScrollIdle("computer-status", () => {
          if (epoch !== getState().accountEpoch || reqSeq !== computerStatusSeq) return;
          applyComputerStatusPayload(c);
        });
      }
      if (c.online && hasConnectedNodeCapability("multi-display-v1")) {
        void refreshComputerDisplays();
      }
      return c;
    } catch {
      return null;
    }
  })().finally(() => {
    if (inflightComputerStatusPromise === promise) {
      inflightComputerStatusPromise = null;
    }
  });
  inflightComputerStatusPromise = promise;
  return promise;
}

export async function resetBotComputerConnection() {
  setNovncMode(true);
  setState((prev) => ({
    novncReconnectSeq: (Number(prev.novncReconnectSeq) || 0) + 1,
  }));
  const res = await apiJson("/api/computer/reset", { method: "POST", body: "{}" });
  if (res?.status && typeof res.status === "object") {
    computerStatusSeq += 1;
    applyComputerStatusPayload(res.status);
  }
  const latest = await refreshComputerStatus({ force: true, suppressLanOfflineModal: true });
  return { res, latest };
}

export async function updateBotComputerComponents() {
  const res = await apiJson("/api/computer/update", { method: "POST", body: "{}" });
  if (res?.status && typeof res.status === "object") {
    computerStatusSeq += 1;
    applyComputerStatusPayload(res.status);
  }
  const latest = await refreshComputerStatus({ force: true, suppressLanOfflineModal: true });
  void refreshSystemDiagnostics(false);
  return { res, latest };
}

export async function refreshUsageAndHealth() {
  const fetchSeq = ++runtimeRefs.usageFetchSeq;
  try {
    const s = getState();
    const isModalOpen = s.settingsModal.open;
    const requestedSid =
      isModalOpen && s.usageScope === "session"
        ? s.usageScopeSessionId || s.activeSessionId || ""
        : "";
    const u = await apiJson(
      requestedSid ? `/api/usage?sessionId=${encodeURIComponent(requestedSid)}` : "/api/usage"
    );
    if (fetchSeq !== runtimeRefs.usageFetchSeq) return;
    const isSessionScope = Boolean(u.scope === "session" && requestedSid);
    runWhenSettingsScrollIdle("usage-view", () => {
      setState((prev) => ({
        ...(isSessionScope
          ? {
              lastSessionUsagePayloads: {
                ...prev.lastSessionUsagePayloads,
                [requestedSid]: u,
              },
            }
          : {
              lastGlobalUsagePayload: u,
            }),
      }));
    });
    if (getState().settingsModal.open) {
      loadProviderBillingSummary();
    }
  } catch {}

  await refreshComputerStatus();
}

export async function refreshSchedules() {
  try {
    const data = await apiJson("/api/schedules");
    setState({ schedules: Array.isArray(data.schedules) ? data.schedules : [] });
  } catch {}
}

export async function refreshLibrary() {
  const sid = getState().activeSessionId;
  if (!sid) return;
  try {
    const data = await apiJson(`/api/sessions/${sid}/library`);
    if (getState().activeSessionId !== sid) return;
    setState({ libraryItems: Array.isArray(data.items) ? data.items : [] });
  } catch {}
}

export async function refreshVault() {
  try {
    const data = await apiJson("/api/vault");
    runWhenSettingsScrollIdle("vault", () => {
      setState({ vaultItems: Array.isArray(data.items) ? data.items : [] });
    });
  } catch {}
}

export async function refreshMcpSkillStatus(serverId = "kimi-cu", connect = false) {
  try {
    const data = await apiJson(
      `/api/mcp/status?server=${encodeURIComponent(serverId)}&connect=${connect ? "true" : "false"}`
    );
    const srv = data?.server || data;
    if (srv && typeof srv === "object") {
      setState((prev) => ({
        mcpStatusByServer: { ...prev.mcpStatusByServer, [serverId]: srv },
      }));
    }
  } catch (err: any) {
    setState((prev) => ({
      mcpStatusByServer: {
        ...prev.mcpStatusByServer,
        [serverId]: {
          serverId,
          connected: false,
          error: err?.message || "状态读取失败",
        },
      },
    }));
  }
}

/* ==================== ACCOUNTS, LAN PAIRING & CLOUD HOSTS ==================== */
export async function loadAccountsDirectory() {
  const s = getState();
  const fallbackLocal = isMobileAppTarget()
    ? ""
    : s.localBackendUrl || (typeof window !== "undefined" ? window.location.origin : "");
  if (typeof window !== "undefined" && window.twinklebotDesktop?.loadAccounts) {
    try {
      const loaded = await window.twinklebotDesktop.loadAccounts();
      const next = normalizeAccountsState(loaded, fallbackLocal);
      setState({ accountsState: next });
      return next;
    } catch {}
  }
  let raw: any = null;
  try {
    const str = await storageGet(ACCOUNTS_STORAGE_KEY);
    if (str) raw = JSON.parse(str);
  } catch {
    raw = null;
  }
  const next = normalizeAccountsState(raw, fallbackLocal);
  setState({ accountsState: next });
  return next;
}

export async function saveAccountsDirectory(nextState: any) {
  const s = getState();
  const fallbackLocal = isMobileAppTarget()
    ? ""
    : s.localBackendUrl || (typeof window !== "undefined" ? window.location.origin : "");
  let normalized = normalizeAccountsState(nextState, fallbackLocal);
  setState({ accountsState: normalized });
  if (typeof window !== "undefined" && window.twinklebotDesktop?.saveAccounts) {
    try {
      const saved = await window.twinklebotDesktop.saveAccounts(normalized);
      normalized = normalizeAccountsState(saved, fallbackLocal);
      setState({ accountsState: normalized });
      return normalized;
    } catch {}
  }
  try {
    await storageSet(ACCOUNTS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {}
  return normalized;
}

export async function confirmAndRemoveCloudAccount(acc: any, { mobileFallback = false } = {}) {
  const label = acc.name || acc.baseUrl || acc.id;
  const ok = await showConfirmDialog({
    title: "移除云端账号",
    message: `确定要移除云端工作台「${label}」吗？`,
    detail: acc.baseUrl
      ? `节点地址：${acc.baseUrl}\n移除后若需重新连接，需再次配置服务地址与访问令牌。`
      : "移除后若需重新连接，需再次配置服务地址与访问令牌。",
    confirmText: "确认移除",
    cancelText: "取消",
    tone: "danger",
  });
  if (!ok) return false;
  const curState = getState();
  const wasActive = acc.id === curState.accountsState.activeAccountId;
  const next = removeCloudAccount(curState.accountsState, acc.id);
  await saveAccountsDirectory(next);
  if (wasActive) {
    if (mobileFallback) {
      if (next.accounts.length > 1) {
        await switchAccount(next.accounts[1].id);
      }
    } else {
      await switchAccount(LOCAL_ACCOUNT_ID);
    }
  }
  showToast(`已移除云端账号「${label}」`);
  return true;
}

export async function reloadWorkspaceForActiveAccount(epoch = getState().accountEpoch) {
  try {
    const config = await apiJson("/api/config");
    if (epoch !== getState().accountEpoch) return;
    setState({ config });
    setNovncMode(true);
  } catch (err: any) {
    if (err?.code === "STALE_ACCOUNT_EPOCH") return;
    if (epoch !== getState().accountEpoch || getState().lanNodeOffline || isRemoteAccountOffline(getState())) return;
    showToast(`配置加载失败: ${err.message}`);
  }

  await refreshSettingsFromServer();
  if (epoch !== getState().accountEpoch || getState().lanNodeOffline || isRemoteAccountOffline(getState())) return;

  connectRealtimeTransport();

  try {
    const data = await apiJson("/api/sessions");
    if (epoch !== getState().accountEpoch) return;
    let sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const activeMap = data.activeSessions || {};

    if (sessions.length === 0) {
      const twinkle = await apiJson("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          title: "Twinkle",
          avatar: { shape: "blob", color: "black" },
          rolePrompt:
            "TwinkleBot 主控协调智能体，可操控桌面、创建专职新 Bot、派发跨 Bot 交接消息及组建群聊。",
        }),
      });
      sessions = [twinkle];
    }

    setState({ sessions, activeMap });
    const primary = getPrimarySessionFromState(getState());
    if (primary) {
      setState({ primarySessionId: primary.id });
    }
    const savedSessionId = readLastActiveSessionId();
    const restored = savedSessionId
      ? sessions.find((s: any) => s.id === savedSessionId)
      : null;
    const initialSession = restored || primary || sessions[0] || null;
    if (initialSession) {
      await selectSession(initialSession.id);
    } else {
      renderEmptyState();
    }
  } catch (err: any) {
    if (err?.code === "STALE_ACCOUNT_EPOCH") return;
    if (epoch !== getState().accountEpoch || getState().lanNodeOffline || isRemoteAccountOffline(getState())) return;
    showToast(`会话加载失败: ${err.message}`);
  }

  if (epoch !== getState().accountEpoch || getState().lanNodeOffline || isRemoteAccountOffline(getState())) return;
  refreshSchedules();
  refreshUsageAndHealth();
  refreshOnlineCloudHosts();
  void refreshSystemDiagnostics(false);
}

export async function refreshActiveAccountConnection(
  epoch = getState().accountEpoch
): Promise<{ ok: boolean; error?: string }> {
  const s = getState();
  const accMeta = getActiveAccountMeta(s);
  try {
    const res = await apiFetch("/api/system/health", {
      timeoutMs: 4000,
      suppressLanOfflineModal: true,
    });
    if (epoch !== getState().accountEpoch) return { ok: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markLanReachable();
    runtimeRefs.wsReconnectAttempt = 0;
    connectRealtimeTransport();
    if (!getState().sessions.length) {
      await reloadWorkspaceForActiveAccount(epoch);
    } else {
      await syncSessionsAndActiveOnReconnect(epoch);
    }
    showToast(`已恢复连接：${accMeta.label}`);
    return { ok: true };
  } catch (err: any) {
    if (epoch !== getState().accountEpoch) return { ok: false };
    if (accMeta.type === "lan") {
      setState({ lanNodeOffline: true });
    }
    return { ok: false, error: err?.message || "无法连接到账号服务端" };
  }
}

export async function retryActiveLanConnection(epoch = getState().accountEpoch): Promise<boolean> {
  try {
    const res = await apiFetch("/api/system/health", { suppressLanOfflineModal: true });
    if (epoch !== getState().accountEpoch) return false;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markLanReachable();
    showToast("已重新连接局域网电脑");
    await reloadWorkspaceForActiveAccount(epoch);
    return true;
  } catch {
    if (epoch !== getState().accountEpoch) return false;
    dismissLanOfflineModal();
    setState({ lanNodeOffline: true });
    showToast("局域网电脑暂不可达，已停留在当前页");
    return false;
  }
}

export async function switchAccount(accountId: string, opts: any = {}) {
  const s = getState();
  const accounts = s.accountsState?.accounts || [];
  const target = accounts.find((a) => a.id === accountId) || accounts[0];
  if (!target) return;

  const epoch = s.accountEpoch + 1;
  if (runtimeRefs.accountAbortController) {
    try {
      runtimeRefs.accountAbortController.abort();
    } catch {}
  }
  runtimeRefs.accountAbortController = new AbortController();
  runtimeRefs.wsHasOpenedInEpoch = false;
  runtimeRefs.wsReconnectAttempt = 0;
  runtimeRefs.inflightReconnectSync = null;
  disconnectRealtimeTransport();
  resetNetworkHealthForAccountSwitch();

  setState({
    accountEpoch: epoch,
    lanOfflineModalShown: false,
    lanNodeOffline: false,
    lanOfflineDismissed: false,
  });

  await saveAccountsDirectory(setActiveAccount(getState().accountsState, target.id));

  const isCloud = target.type === "cloud";
  const isLan = target.type === "lan";
  const isRemote = isCloud || isLan;

  setState({
    activeBaseUrl: isRemote ? target.baseUrl : "",
    activeWsUrl: isRemote ? target.wsUrl || "" : "",
    activeAuthToken: isRemote ? target.authToken || "" : "",
  });

  const localBase = String(
    getState().localBackendUrl || (typeof window !== "undefined" ? window.location.origin : "")
  ).replace(/\/+$/, "");
  if (!opts.skipRoleSwitch && !isMobileAppTarget() && localBase && /^https?:\/\//i.test(localBase)) {
    const roleHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (getState().localControlToken) {
      roleHeaders["X-Local-Token"] = getState().localControlToken;
    }
    try {
      await fetch(`${localBase}/api/system/role`, {
        method: "POST",
        headers: roleHeaders,
        body: JSON.stringify({
          role: isCloud ? "host_executor" : "master",
          ...(isCloud ? { cloudOrigin: target.baseUrl } : {}),
        }),
      });
    } catch {
      // Ignore if running directly against cloud origin without local backend
    }
  }

  setState({
    sessions: [],
    activeMap: {},
    activeSessionId: null,
    diagnostics: null,
    onlineCloudHosts: [],
    selectedCloudHostId: null,
  });
  syncConnectedNodeStatusWithManifest(null);
  closeBotScreenOverlay();

  if (isMobileAppTarget() && target.type === "local" && !target.baseUrl) {
    setState((prev) => ({
      mobileSheets: { ...prev.mobileSheets, nodeOpen: true },
    }));
    scanAndRenderLanNodes();
    return;
  }

  await reloadWorkspaceForActiveAccount(epoch);
  if (!opts.silent && epoch === getState().accountEpoch) {
    showToast(
      `已切换至：${target.name || (isCloud ? "云端工作台" : isLan ? "局域网电脑" : "本地工作台")}`
    );
  }
}

export async function refreshOnlineCloudHosts() {
  const s = getState();
  const activeAcc = (s.accountsState?.accounts || []).find(
    (a) => a.id === s.accountsState?.activeAccountId
  );
  if (activeAcc?.type !== "cloud" && s.config?.deployEnv !== "cloud") {
    setState({ onlineCloudHosts: [], selectedCloudHostId: null });
    return;
  }
  try {
    const data = await apiJson("/api/computer/hosts");
    setState({
      onlineCloudHosts: Array.isArray(data.hosts) ? data.hosts : [],
      selectedCloudHostId: data.selectedHostId || null,
    });
  } catch {}
}

export async function selectCloudHost(clientId: string) {
  if (!clientId) return;
  const res = await apiJson("/api/computer/hosts/select", {
    method: "POST",
    body: JSON.stringify({ clientId }),
  });
  setState((prev) => ({
    onlineCloudHosts: Array.isArray(res.hosts) ? res.hosts : prev.onlineCloudHosts,
    selectedCloudHostId: res.selectedHostId || clientId,
  }));
  showToast("已切换目标执行宿主机");
}

export async function scanAndRenderLanNodes() {
  if (getState().lanScanning) return;
  setState({ lanScanning: true });
  try {
    let found = await discoverLanDevices({ timeoutMs: 1200 });
    if (found.length === 0) {
      found = await scanSubnetForDevices({ port: 3230, timeoutMs: 800, batchSize: 25 });
    }
    setState({ lanDiscoveredDevices: found });
  } catch {
    setState({ lanDiscoveredDevices: [] });
  } finally {
    setState({ lanScanning: false });
  }
}

export async function initiateLanPairing(deviceInfo: any) {
  const host = String(deviceInfo?.host || "").trim();
  const port = Number(deviceInfo?.port) || 3230;
  const resolvedBaseUrl = String(
    deviceInfo?.baseUrl || (host ? `http://${host}:${port}` : "")
  )
    .trim()
    .replace(/\/+$/, "");
  if (!resolvedBaseUrl) {
    showToast("未能识别该设备的局域网地址");
    return;
  }
  const normalizedDev = {
    ...deviceInfo,
    port,
    baseUrl: resolvedBaseUrl,
  };
  setState({
    pendingPairingDevice: normalizedDev,
    pendingPairingId: null,
  });
  try {
    const res = await fetch(`${resolvedBaseUrl}/api/lan/pair/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceName: `TwinkleBot Mobile (${getMobilePlatform()})`,
        platform: getMobilePlatform(),
        deviceId: `mob-${getMobilePlatform()}`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.pairingId) {
      throw new Error(data.error || "发起配对失败");
    }
    setState({
      pendingPairingId: data.pairingId,
      mobilePairModalOpen: true,
      mobilePairFeedback: { text: "", kind: "info" },
    });
    setTimeout(() => {
      (document.getElementById("mobile-pair-code-input") as HTMLInputElement | null)?.focus();
    }, 60);
  } catch (err: any) {
    showToast(`发起配对失败: ${err.message}`);
  }
}

export async function submitLanPairingCode(code: string) {
  const s = getState();
  const dev = s.pendingPairingDevice;
  const pairingId = s.pendingPairingId;
  if (!dev?.baseUrl || !pairingId) return;
  const cleanCode = String(code || "").trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    setState({
      mobilePairFeedback: { text: "请输入电脑端显示的 6 位数字配对码", kind: "error" },
    });
    return;
  }
  try {
    const res = await fetch(`${dev.baseUrl}/api/lan/pair/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingId,
        code: cleanCode,
        deviceName: `TwinkleBot Mobile (${getMobilePlatform()})`,
        platform: getMobilePlatform(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.deviceToken) {
      throw new Error(data.error || "配对码校验失败");
    }
    const nextState = upsertLanAccount(getState().accountsState, {
      instanceId: data.instanceId || dev.instanceId,
      name: data.hostname || dev.hostname || dev.host,
      hostname: data.hostname || dev.hostname || "",
      platform: data.platform || dev.platform || "",
      baseUrl: dev.baseUrl,
      deviceToken: data.deviceToken,
    });
    const saved = await saveAccountsDirectory(nextState);
    const added = saved.accounts.find(
      (a: any) =>
        a.type === "lan" &&
        (a.instanceId === (data.instanceId || dev.instanceId) || a.baseUrl === dev.baseUrl)
    );
    setState({ mobilePairModalOpen: false });
    if (added) {
      await switchAccount(added.id);
    }
  } catch (err: any) {
    setState({
      mobilePairFeedback: { text: err?.message || "配对验证失败", kind: "error" },
    });
  }
}

/* ==================== VOICE DICTATION, FILES & PREVIEWS ==================== */
export function toggleVoiceDictation() {
  if (typeof window === "undefined") return;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    showToast("当前浏览器不支持原生语音识别");
    return;
  }
  const s = getState();
  if (s.isRecordingVoice && runtimeRefs.speechRec) {
    runtimeRefs.speechRec.stop();
    return;
  }
  const rec = new SpeechRec();
  rec.lang = "zh-CN";
  rec.interimResults = false;
  const sessionSeq = (runtimeRefs.voiceSessionSeq = (runtimeRefs.voiceSessionSeq || 0) + 1);
  runtimeRefs.speechRec = rec;
  setState({ isRecordingVoice: true });
  showToast("正在聆听，请说话…");

  rec.onresult = (ev: any) => {
    if (sessionSeq !== runtimeRefs.voiceSessionSeq) return;
    const transcript = ev.results?.[0]?.[0]?.transcript || "";
    if (transcript) {
      setState((prev) => ({
        composerText: `${prev.composerText ? `${prev.composerText} ` : ""}${transcript}`,
      }));
      (document.getElementById("message-input") as HTMLTextAreaElement | null)?.focus();
    }
  };
  rec.onend = () => {
    if (runtimeRefs.speechRec === rec) {
      runtimeRefs.speechRec = null;
    }
    if (sessionSeq === runtimeRefs.voiceSessionSeq) {
      setState({ isRecordingVoice: false });
    }
  };
  rec.onerror = () => {
    if (runtimeRefs.speechRec === rec) {
      runtimeRefs.speechRec = null;
    }
    if (sessionSeq === runtimeRefs.voiceSessionSeq) {
      setState({ isRecordingVoice: false });
    }
  };
  rec.start();
}

export async function openLocalFile(filePath: string, { reveal = false } = {}) {
  if (!filePath) return;
  try {
    await apiJson("/api/files/open", {
      method: "POST",
      body: JSON.stringify({ path: filePath, reveal }),
    });
  } catch (err: any) {
    const fmLabel = getFileManagerLabel(
      getState().computerStatus?.hostComputer?.platform ||
        getState().diagnostics?.hostComputer?.platform
    );
    showToast(`${reveal ? `打开${fmLabel}` : "打开文件"}失败: ${err.message}`);
  }
}

export function openImageLightbox(url: string, alt = "图片预览") {
  if (!url) return;
  setState({ imageLightbox: { open: true, url, alt } });
}

export function openHtmlPreviewModal(params: {
  code: string;
  kind?: "html" | "svg";
  badgeLabel?: string;
  lang?: string;
  canvasBg?: "light" | "grid" | "dark";
}) {
  setState({
    htmlPreviewModal: {
      open: true,
      code: String(params.code || ""),
      kind: params.kind || "html",
      badgeLabel: params.badgeLabel || "HTML 预览",
      lang: params.lang || "html",
      canvasBg: params.canvasBg || "light",
      mode: "preview",
      vp: "full",
      reloadNonce: Date.now(),
    },
  });
}

export function buildOptimisticUsagePayload(requestedSid = "") {
  const s = getState();
  if (!requestedSid) {
    if (s.lastGlobalUsagePayload) return s.lastGlobalUsagePayload;
    return {
      scope: "all",
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtTokens: 0,
      estimatedCostUsd: 0,
      estimatedCostCny: 0,
      sessionCount: s.sessions.length,
      byModel: [],
      bySession: [],
    };
  }
  const cached = s.lastSessionUsagePayloads[requestedSid];
  if (cached) return cached;

  const targetSession = s.sessions.find((item) => item.id === requestedSid) || null;
  if (requestedSid === s.activeSessionId) {
    const summary = computeClientSessionSummary({
      providers: s.settings?.providers || [],
      sessionUsageByProviderModel: s.sessionUsageByProviderModel,
      sessionUsageByModel: s.sessionUsageByModel,
      usage: s.usage,
      lastObservedModel: s.lastObservedModel,
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let thoughtTokens = 0;
    for (const m of summary.byModel) {
      inputTokens += Number(m.inputTokens) || 0;
      outputTokens += Number(m.outputTokens) || 0;
      cachedTokens += Number(m.cachedTokens) || 0;
      thoughtTokens += Number(m.thoughtTokens) || 0;
    }
    const totalTokens = inputTokens + outputTokens;
    const byModel = summary.byModel.map((m) => ({
      ...m,
      sharePct: totalTokens > 0 ? Math.round(((m.totalTokens || 0) / totalTokens) * 1000) / 10 : 0,
    }));
    return {
      scope: "session",
      session: targetSession,
      totalTokens,
      inputTokens,
      outputTokens,
      cachedTokens,
      thoughtTokens,
      estimatedCostUsd: summary.costUsd,
      estimatedCostCny: summary.costCny,
      byModel,
      bySession: [],
    };
  }
  return {
    scope: "session",
    session: targetSession,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thoughtTokens: 0,
    estimatedCostUsd: 0,
    estimatedCostCny: 0,
    byModel: [],
    bySession: [],
  };
}

/* ==================== APP BOOTSTRAP ==================== */
let appBootstrapped = false;

export async function bootstrapApp() {
  if (appBootstrapped || typeof window === "undefined") return;
  appBootstrapped = true;

  if (isMobileAppTarget()) {
    document.documentElement.dataset.appTarget = "mobile";
    setScreenOrientation("portrait");
  }

  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener("change", () => {
    syncDerivedAccent();
  });

  if (window.twinklebotDesktop?.getDesktopInfo) {
    try {
      const info = await window.twinklebotDesktop.getDesktopInfo();
      if (info?.backendUrl || info?.localControlToken) {
        setState((prev) => ({
          localBackendUrl: info.backendUrl || prev.localBackendUrl,
          localControlToken: info.localControlToken || prev.localControlToken,
        }));
      }
    } catch {}
  }

  if (
    !getState().localBackendUrl &&
    !isMobileAppTarget() &&
    /^(127\.0\.0\.1|localhost)$/i.test(window.location.hostname)
  ) {
    setState({ localBackendUrl: window.location.origin });
  }

  await loadAccountsDirectory();

  onAppForeground(async () => {
    const now = Date.now();
    if (runtimeRefs.lastForegroundProbeAt && now - runtimeRefs.lastForegroundProbeAt < 2000) {
      return;
    }
    runtimeRefs.lastForegroundProbeAt = now;
    const s = getState();
    const activeAcc = (s.accountsState?.accounts || []).find(
      (a) => a.id === s.accountsState?.activeAccountId
    );
    if (!activeAcc || (activeAcc.type === "local" && !activeAcc.baseUrl)) return;
    try {
      await apiFetch("/api/system/health");
      markLanReachable();
      if (!runtimeRefs.wsSocket || runtimeRefs.wsSocket.readyState !== WebSocket.OPEN) {
        connectRealtimeTransport();
      }
      await syncSessionsAndActiveOnReconnect(getState().accountEpoch);
      await refreshOnlineCloudHosts();
      void checkForAppUpdates({ silent: true });
    } catch {
      // apiFetch handles 3s LAN unreachable fallback automatically
    }
  });

  const storedLang = readStoredLanguagePreference();
  if (storedLang) {
    applyLanguagePreference(storedLang, false);
  } else {
    syncLanguageToDomAndStorage("system", false);
  }

  const storedScheme = (() => {
    try {
      return localStorage.getItem("color-scheme");
    } catch {
      return null;
    }
  })();
  if (storedScheme === "light" || storedScheme === "dark") {
    applyThemePreference(storedScheme, false);
  }

  const activeId = getState().accountsState?.activeAccountId || LOCAL_ACCOUNT_ID;
  await switchAccount(activeId, { skipRoleSwitch: activeId === LOCAL_ACCOUNT_ID, silent: true });

  if (!storedLang && getState().settings?.language) {
    applyLanguagePreference(getState().settings.language, false);
  }
  if (!storedScheme && getState().settings?.theme) {
    applyThemePreference(getState().settings.theme, false);
  }

  // Confirm to native watchdog that this booted web bundle rendered cleanly, then run throttled silent update check
  confirmBootedWebBundleReady().catch(() => {});
  setTimeout(() => {
    void checkForAppUpdates({ silent: true });
  }, 1800);

  let lastComputerPollAt = Date.now();
  const maybePollComputerStatus = (minIntervalMs: number) => {
    if (document.visibilityState === "hidden") return;
    if (isMobileAppTarget() && !getState().activeBaseUrl) return;
    const now = Date.now();
    if (now - lastComputerPollAt < minIntervalMs) return;
    lastComputerPollAt = now;
    const st = getState();
    refreshComputerStatus({
      suppressLanOfflineModal: st.lanNodeOffline || st.lanOfflineDismissed,
    }).catch(() => {});
  };
  setInterval(() => maybePollComputerStatus(18_000), 20_000);
  window.addEventListener("focus", () => maybePollComputerStatus(5_000));

  const onForegroundResume = () => {
    const hiddenMs = runtimeRefs.lastHiddenAt ? Date.now() - runtimeRefs.lastHiddenAt : 0;
    runtimeRefs.lastHiddenAt = 0;
    const { resumeBgThresholdMs } = getNetworkThresholds();
    if (hiddenMs >= resumeBgThresholdMs) {
      probeActiveTransportOnResume();
    }
    maybePollComputerStatus(5_000);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      runtimeRefs.lastHiddenAt = Date.now();
    } else if (document.visibilityState === "visible") {
      onForegroundResume();
    }
  });

  window.addEventListener("offline", () => {
    handleBrowserOnlineChange(false);
    disconnectRealtimeTransport();
  });

  window.addEventListener("online", () => {
    handleBrowserOnlineChange(true);
    void reconnectRealtimeNow();
  });

  const navConn = (navigator as any)?.connection;
  if (navConn && typeof navConn.addEventListener === "function") {
    navConn.addEventListener("change", () => {
      inspectNavigatorConnectionHint();
      probeActiveTransportOnResume();
    });
  }

  const capApp = (window as any)?.Capacitor?.Plugins?.App;
  if (capApp && typeof capApp.addListener === "function") {
    try {
      capApp.addListener("appStateChange", (state: { isActive?: boolean }) => {
        if (state?.isActive) {
          onForegroundResume();
        } else {
          runtimeRefs.lastHiddenAt = Date.now();
        }
      });
    } catch {}
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    handleBrowserOnlineChange(false);
  } else {
    inspectNavigatorConnectionHint();
  }
}
