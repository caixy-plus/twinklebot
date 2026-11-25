import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  getLocalizedContextCompressionPresets,
  matchContextCompressionPreset,
  normalizeContextCompressionSettings,
} from "/shared/context-compression.js";
import {
  FALLBACK_SCREEN_POOL_BUDGET,
  matchScreenPoolPreset,
  normalizeScreenPoolSettings,
} from "/shared/screen-pool.js";
import {
  normalizeBrowserAutomationSettings,
  normalizeBrowserDebugPort,
} from "/shared/browser-automation.js";
import { resolveBotComputerStatusDisplay } from "/shared/computer-status.js";
import { isMobileViewport } from "../../mobile-ui.js";
import {
  applyLanguagePreference,
  applyThemePreference,
  bindScrollEndTracking,
  buildOptimisticUsagePayload,
  closeSettingsModal,
  commitSettingsPatch,
  openSettingsModal,
  refreshAllLiveProviderBalances,
  refreshComputerDisplays,
  refreshComputerStatus,
  refreshSettingsFromServer,
  refreshSystemDiagnostics,
  refreshUsageAndHealth,
  refreshVault,
  resetBotComputerConnection,
  setNovncMode,
  setSpellcheckPreference,
  showConfirmDialog,
  showToast,
  syncDerivedAccent,
  updateBotComputerComponents,
} from "../../services/actions.js";
import { apiJson, apiUrl } from "../../services/api-client.js";
import {
  applyAvailableOtaUpdate,
  cancelDeferredCoreOta,
  checkForAppUpdates,
  computeUpdateDecisionKey,
  dismissCurrentUpdateNotice,
  downloadOrOpenFullShellUpdate,
  forceSwitchCoreOtaNow,
  hasConnectedNodeCapability,
} from "../../services/ota-updater.js";
import {
  CLIENT_USD_TO_CNY,
  getProfileColors,
  getProviderPresetUi,
} from "../../state/constants.js";
import {
  formatBillingTime,
  formatCny,
  getClientModelMeta,
  isImeConfirmEnter,
  parseModelsCsv,
} from "../../state/helpers.js";
import { getState, setState, useStore } from "../../state/store.js";
import { isRemoteAccountOffline } from "../../services/network-monitor.js";
import {
  resolveLocalizedGlobalMemory,
  resolveLocalizedProfileName,
  resolveLocalizedVaultItem,
  useI18n,
} from "../../services/i18n.js";
import { StatusText, UiIcon } from "../common/Icon.js";
import { NetworkStatusBanner } from "../common/NetworkStatusBanner.js";
import { TraceEventsList } from "../common/SharedPanels.js";

const SETTINGS_PROVIDER_KEYS = [
  "gemini",
  "openai",
  "deepseek",
  "openai-compatible",
] as const;

const SETTINGS_TABS = [
  ["general", "gear"],
  ["models", "models-diamond"],
  ["computer", "monitor"],
  ["permissions", "shield-check"],
  ["vault", "vault-safe"],
  ["usage", "bar-chart"],
  ["updates", "sparkle"],
] as const;

function isHorizontallyScrollableAncestor(
  target: EventTarget | null,
  boundary: HTMLElement | null
): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== boundary) {
    const tag = node.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable) {
      return true;
    }
    if (node.scrollWidth > node.clientWidth + 2) {
      const ox = getComputedStyle(node).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    node = node.parentElement;
  }
  return false;
}

function ProviderCalibrationForm({ provider: p }: { provider: any }) {
  const { t } = useI18n();
  const savedMode = useStore(
    (s) => s.providerCalibrationModes[p.providerId] || "set"
  );
  const [curMode, setCurMode] = useState<string>(savedMode);
  const [remAmount, setRemAmount] = useState<string>(() =>
    savedMode === "set" && p.remainingCny !== null
      ? Number(p.remainingCny).toFixed(2)
      : ""
  );
  const [totAmount, setTotAmount] = useState<string>(() =>
    p.totalCreditsCny != null ? String(p.totalCreditsCny) : ""
  );
  const remInputRef = useRef<HTMLInputElement | null>(null);

  const switchMode = (nextMode: string) => {
    const resolved = ["add", "sub", "set"].includes(nextMode) ? nextMode : "set";
    setCurMode(resolved);
    setState((prev) => ({
      providerCalibrationModes: {
        ...prev.providerCalibrationModes,
        [p.providerId]: resolved,
      },
    }));
    if (resolved === "set" && p.remainingCny !== null && remAmount.trim() === "") {
      setRemAmount(Number(p.remainingCny).toFixed(2));
    } else if (
      (resolved === "add" || resolved === "sub") &&
      p.remainingCny !== null &&
      remAmount.trim() === Number(p.remainingCny).toFixed(2)
    ) {
      setRemAmount("");
    }
    requestAnimationFrame(() => remInputRef.current?.focus());
  };

  const curVal = p.remainingCny !== null ? Number(p.remainingCny) : null;
  let previewText = "";
  const rawTrim = remAmount.trim();
  if (rawTrim === "") {
    if (curMode === "sub" && curVal === null) {
      previewText = t("settings.calNeedInitialBalance");
    }
  } else {
    const amt = Number(rawTrim);
    if (Number.isFinite(amt) && amt >= 0) {
      if (curMode === "add") {
        const base = curVal ?? 0;
        previewText = t("settings.calPreviewAdd", {
          base: base.toFixed(2),
          amt: amt.toFixed(2),
          total: (base + amt).toFixed(2),
        });
      } else if (curMode === "sub") {
        previewText =
          curVal === null
            ? t("settings.calNeedInitialBalance")
            : t("settings.calPreviewSub", {
                cur: curVal.toFixed(2),
                amt: amt.toFixed(2),
                rem: Math.max(0, curVal - amt).toFixed(2),
              });
      } else {
        previewText = t("settings.calPreviewSet", { amt: amt.toFixed(2) });
      }
    }
  }

  const closeCalibration = () => {
    setState((prev) => {
      const next = { ...prev.providerOpenCalibrationIds };
      delete next[p.providerId];
      return { providerOpenCalibrationIds: next };
    });
  };

  return (
    <form
      className="usage-gcp-calibrate-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const data = await apiJson(
            `/api/billing/providers/${encodeURIComponent(p.providerId)}/calibration`,
            {
              method: "POST",
              body: JSON.stringify({
                mode: curMode,
                amountCny: rawTrim === "" ? null : Number(rawTrim),
                totalCreditsCny: totAmount.trim() === "" ? null : Number(totAmount.trim()),
              }),
            }
          );
          setState((prev) => {
            const nextOpen = { ...prev.providerOpenCalibrationIds };
            delete nextOpen[p.providerId];
            return {
              providerOpenCalibrationIds: nextOpen,
              providerBilling: data,
            };
          });
          showToast(
            curMode === "add"
              ? t("settings.calToastAdded")
              : curMode === "sub"
                ? t("settings.calToastSubtracted")
                : t("settings.calToastSaved")
          );
        } catch (err: any) {
          showToast(err?.message || t("settings.calSaveFailed"));
        }
      }}
    >
      <div className="usage-gcp-mode-row">
        <span className="usage-gcp-mode-caption">{t("settings.calModeLabel")}</span>
        <div
          className="usage-gcp-mode-tabs"
          role="tablist"
          aria-label={t("settings.calModeAria", { name: p.providerName })}
        >
          {[
            { id: "add", label: t("settings.calModeAdd") },
            { id: "sub", label: t("settings.calModeSub") },
            { id: "set", label: t("settings.calModeSet") },
          ].map((mDef) => (
            <button
              key={mDef.id}
              type="button"
              className={`usage-gcp-mode-btn${curMode === mDef.id ? " is-active" : ""}`}
              data-cal-mode={mDef.id}
              onClick={() => switchMode(mDef.id)}
            >
              {mDef.label}
            </button>
          ))}
        </div>
      </div>

      <div className="usage-gcp-form-grid">
        <label className="usage-gcp-field">
          <span>
            {curMode === "add"
              ? t("settings.calFieldAddLabel")
              : curMode === "sub"
                ? t("settings.calFieldSubLabel")
                : t("settings.calFieldSetLabel")}
          </span>
          <input
            ref={remInputRef}
            type="number"
            step="0.01"
            min="0"
            aria-label={t("settings.calAmountAria", { name: p.providerName })}
            placeholder={
              curMode === "add"
                ? t("settings.calAmountAddPh")
                : curMode === "sub"
                  ? t("settings.calAmountSubPh")
                  : t("settings.calAmountSetPh")
            }
            value={remAmount}
            onChange={(e) => setRemAmount(e.target.value)}
          />
        </label>
        <label className="usage-gcp-field">
          <span>{t("settings.calTotalCreditsLabel")}</span>
          <input
            type="number"
            step="1"
            min="0"
            placeholder={t("settings.calTotalCreditsPh")}
            aria-label={t("settings.calTotalCreditsAria", { name: p.providerName })}
            value={totAmount}
            onChange={(e) => setTotAmount(e.target.value)}
          />
        </label>
      </div>

      <div className="usage-gcp-preview" hidden={!previewText}>
        {previewText}
      </div>

      <div className="usage-gcp-form-actions">
        <button type="submit" className="settings-pill-btn usage-gcp-save-btn">
          {t("common.save")}
        </button>
        <button
          type="button"
          className="settings-pill-btn"
          onClick={async () => {
            try {
              const data = await apiJson(
                `/api/billing/providers/${encodeURIComponent(p.providerId)}/calibration`,
                { method: "POST", body: JSON.stringify({ clear: true }) }
              );
              setState((prev) => {
                const nextOpen = { ...prev.providerOpenCalibrationIds };
                delete nextOpen[p.providerId];
                return { providerOpenCalibrationIds: nextOpen, providerBilling: data };
              });
              showToast(t("settings.calToastCleared"));
            } catch (err: any) {
              showToast(err?.message || t("settings.calClearFailed"));
            }
          }}
        >
          {t("settings.calClearBtn")}
        </button>
        <button type="button" className="settings-pill-btn" onClick={closeCalibration}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

export function SettingsModal() {
  const settingsModal = useStore((s) => s.settingsModal);
  const settings = useStore((s) => s.settings);
  const spellcheckEnabled = useStore((s) => s.spellcheckEnabled);
  const diagnostics = useStore((s) => s.diagnostics);
  const computerStatus = useStore((s) => s.computerStatus);
  const computerDisplays = useStore((s) => s.computerDisplays);
  const vaultItems = useStore((s) => s.vaultItems);
  const vaultTab = useStore((s) => s.vaultTab);
  const vaultSearch = useStore((s) => s.vaultSearch);
  const usageScope = useStore((s) => s.usageScope);
  const usageScopeSessionId = useStore((s) => s.usageScopeSessionId);
  const usageTraceActive = useStore((s) => s.usageTraceActive);
  const lastGlobalUsagePayload = useStore((s) => s.lastGlobalUsagePayload);
  const lastSessionUsagePayloads = useStore((s) => s.lastSessionUsagePayloads);
  const providerBilling = useStore((s) => s.providerBilling);
  const providerOpenCalibrationIds = useStore((s) => s.providerOpenCalibrationIds);
  const providerRefreshingIds = useStore((s) => s.providerRefreshingIds);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const stepCount = useStore((s) => s.stepCount);
  const onlineCloudHosts = useStore((s) => s.onlineCloudHosts);
  const selectedCloudHostId = useStore((s) => s.selectedCloudHostId);
  const updateState = useStore((s) => s.updateState);
  const updateDecision = updateState?.decision;
  const hasVisibleUpdate = Boolean(
    updateDecision &&
      updateDecision.status !== "up-to-date" &&
      computeUpdateDecisionKey(updateDecision) !== updateState?.dismissedVersionKey
  );

  const activeTab = settingsModal.tab || "general";
  const isStandalone = Boolean(settingsModal.standaloneBotSessionId);

  const settingsNavRef = useRef<HTMLElement | null>(null);
  const settingsContentRef = useRef<HTMLDivElement | null>(null);
  const wasModalOpenRef = useRef(false);
  const pendingEdgeLandingRef = useRef<"top" | "bottom">("top");
  const pendingEdgeAnimDirRef = useRef<1 | -1 | 0>(0);
  const pulledPaneRef = useRef<HTMLElement | null>(null);
  const pullResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgeFillRef = useRef<HTMLSpanElement | null>(null);
  const [edgePullHint, setEdgePullHint] = useState<{
    dir: 1 | -1;
    targetLabel: string;
  } | null>(null);
  const edgeWheelRef = useRef<{
    dir: 1 | -1 | 0;
    accum: number;
    lastEventAt: number;
    lastScrollMoveAt: number;
    cooldownUntil: number;
    touchActive: boolean;
    momentumBlocked: boolean;
    requireNewGesture: boolean;
    prevAbsDy: number;
    peakAbsDy: number;
    decayStreak: number;
    webMomentumBlocked: boolean;
  }>({
    dir: 0,
    accum: 0,
    lastEventAt: 0,
    lastScrollMoveAt: 0,
    cooldownUntil: 0,
    touchActive: false,
    momentumBlocked: false,
    requireNewGesture: false,
    prevAbsDy: 0,
    peakAbsDy: 0,
    decayStreak: 0,
    webMomentumBlocked: false,
  });
  const prevTabIndexRef = useRef<number>(
    Math.max(0, SETTINGS_TABS.findIndex(([k]) => k === activeTab))
  );
  const swipeStateRef = useRef<{
    startX: number;
    startY: number;
    lastDx: number;
    startTime: number;
    locked: "h" | "v" | null;
  } | null>(null);

  const EDGE_SWITCH_THRESHOLD = 280;
  const EDGE_CONTINUOUS_GAP_MS = 100;

  const getActivePaneEl = (): HTMLElement | null => {
    const contentEl = settingsContentRef.current;
    if (!contentEl) return null;
    return contentEl.querySelector<HTMLElement>(
      `.settings-pane[data-settings-pane="${activeTab}"]`
    );
  };

  const getActivePaneScroller = (): HTMLElement | null => {
    const contentEl = settingsContentRef.current;
    if (!contentEl) return null;
    if (activeTab === "usage") {
      const traceEl = contentEl.querySelector<HTMLElement>(
        "#usage-inline-trace-view:not([hidden])"
      );
      if (traceEl) return traceEl;
      const mainEl = contentEl.querySelector<HTMLElement>(
        "#usage-main-view:not([hidden])"
      );
      if (mainEl) return mainEl;
    }
    return contentEl;
  };

  const clearPullTimers = () => {
    if (pullResetTimerRef.current) {
      clearTimeout(pullResetTimerRef.current);
      pullResetTimerRef.current = null;
    }
  };

  const resetEdgePull = () => {
    clearPullTimers();
    edgeWheelRef.current.accum = 0;
    edgeWheelRef.current.dir = 0;
    setEdgePullHint(null);
    if (edgeFillRef.current) {
      edgeFillRef.current.style.transform = "scaleX(0)";
    }
    const paneEl = pulledPaneRef.current;
    pulledPaneRef.current = null;
    if (!paneEl) return;

    paneEl.style.transition = "";
    paneEl.style.transform = "";
  };

  useEffect(() => {
    if (!settingsModal.open) {
      pendingEdgeLandingRef.current = "top";
      pendingEdgeAnimDirRef.current = 0;
      resetEdgePull();
      return;
    }
    if (isMobileViewport()) return;

    const landing = pendingEdgeLandingRef.current;
    const animDir = pendingEdgeAnimDirRef.current;
    pendingEdgeLandingRef.current = "top";
    pendingEdgeAnimDirRef.current = 0;

    const applyLanding = () => {
      const scroller = getActivePaneScroller();
      if (!scroller) return;
      scroller.scrollTop = landing === "bottom" ? scroller.scrollHeight : 0;
      edgeWheelRef.current.lastScrollMoveAt = Date.now();
    };
    applyLanding();

    if (animDir !== 0) {
      const reducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      const targetPane = getActivePaneEl();
      if (targetPane && typeof targetPane.animate === "function" && !reducedMotion) {
        const fromY = animDir > 0 ? 36 : -36;
        targetPane.animate(
          [
            { opacity: 0.22, transform: `translateY(${fromY}px)` },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
        );
      }
    }

    if (landing === "bottom") {
      const rafId = requestAnimationFrame(applyLanding);
      return () => cancelAnimationFrame(rafId);
    }
  }, [settingsModal.open, activeTab, usageTraceActive]);

  useEffect(() => {
    const unsub = window.twinklebotDesktop?.onScrollTouch?.(
      (ev: { phase?: "begin" | "fling" | "end"; active?: boolean }) => {
        const wheelState = edgeWheelRef.current;
        const phase = ev?.phase || (ev?.active ? "begin" : "end");
        if (phase === "begin") {
          wheelState.touchActive = true;
          wheelState.momentumBlocked = false;
          wheelState.requireNewGesture = false;
          wheelState.webMomentumBlocked = false;
          wheelState.decayStreak = 0;
          wheelState.peakAbsDy = 0;
        } else if (phase === "fling") {
          wheelState.touchActive = false;
          wheelState.momentumBlocked = true;
          wheelState.webMomentumBlocked = true;
          wheelState.requireNewGesture = false;
          resetEdgePull();
        } else {
          wheelState.touchActive = false;
          wheelState.requireNewGesture = false;
          resetEdgePull();
        }
      }
    );
    return () => {
      if (typeof unsub === "function") unsub();
      clearPullTimers();
    };
  }, []);

  const handleContentScrollCapture = () => {
    if (!settingsModal.open || isStandalone || isMobileViewport()) return;
    edgeWheelRef.current.lastScrollMoveAt = Date.now();
    if (edgeWheelRef.current.accum > 0 || pulledPaneRef.current) {
      resetEdgePull();
    }
  };

  const hasInnerScrollCapacity = (
    target: EventTarget | null,
    stopEl: HTMLElement,
    dir: 1 | -1
  ): boolean => {
    let cur = target instanceof HTMLElement ? target : null;
    while (cur && cur !== stopEl) {
      const overflowY = window.getComputedStyle(cur).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        cur.scrollHeight > cur.clientHeight + 2
      ) {
        if (dir > 0 && cur.scrollTop < cur.scrollHeight - cur.clientHeight - 2) {
          return true;
        }
        if (dir < 0 && cur.scrollTop > 2) {
          return true;
        }
      }
      cur = cur.parentElement;
    }
    return false;
  };

  const handleContentWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!settingsModal.open || isStandalone || isMobileViewport()) return;
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;

    const dy =
      e.deltaMode === 1
        ? e.deltaY * 24
        : e.deltaMode === 2
          ? e.deltaY * 240
          : e.deltaY;
    const dir: 1 | -1 = dy > 0 ? 1 : -1;
    const absDy = Math.abs(dy);
    const now = Date.now();
    const wheelState = edgeWheelRef.current;
    const dt = wheelState.lastEventAt ? now - wheelState.lastEventAt : 9999;

    // 1. Hardware-exact macOS Electron inertia kill: after fingers lift (`scroll-touch-end`),
    // ignore all momentum wheel events until `scroll-touch-begin` (or full silence for USB mice).
    if (wheelState.momentumBlocked) {
      if (dt < 220) {
        wheelState.lastEventAt = now;
        return;
      }
      wheelState.momentumBlocked = false;
    }

    // Prevent one single long swipe from chain-switching two tabs in a row
    if (wheelState.requireNewGesture) {
      if (wheelState.touchActive || dt < 220) {
        wheelState.lastEventAt = now;
        return;
      }
      wheelState.requireNewGesture = false;
    }

    // 2. Always-on macOS trackpad momentum / inertia eliminator:
    // AppKit trackpad inertia emits smooth monotonically decaying wheel deltas (~16ms apart)
    // even when Chromium doesn't fire gestureFlingStart. Kill it immediately on decay.
    if (wheelState.webMomentumBlocked) {
      const freshPush =
        dt >= 140 || (absDy >= 10 && absDy > wheelState.prevAbsDy * 1.6);
      if (!freshPush) {
        wheelState.prevAbsDy = absDy;
        wheelState.lastEventAt = now;
        return;
      }
      wheelState.webMomentumBlocked = false;
      wheelState.decayStreak = 0;
      wheelState.peakAbsDy = absDy;
    } else if (dt < 75 && wheelState.prevAbsDy > 0) {
      if (absDy <= wheelState.prevAbsDy && absDy < wheelState.peakAbsDy * 0.85) {
        wheelState.decayStreak += 1;
      } else if (absDy > wheelState.prevAbsDy) {
        wheelState.decayStreak = 0;
      }
      wheelState.peakAbsDy = Math.max(wheelState.peakAbsDy, absDy);
      if (wheelState.decayStreak >= 3 || (wheelState.peakAbsDy >= 10 && absDy <= 4)) {
        wheelState.webMomentumBlocked = true;
        wheelState.prevAbsDy = absDy;
        wheelState.lastEventAt = now;
        resetEdgePull();
        return;
      }
    } else if (dt >= 75) {
      wheelState.decayStreak = 0;
      wheelState.peakAbsDy = absDy;
    }
    wheelState.prevAbsDy = absDy;

    if (now < wheelState.cooldownUntil) {
      wheelState.lastEventAt = now;
      return;
    }

    const scroller = getActivePaneScroller();
    if (!scroller) return;
    if (hasInnerScrollCapacity(e.target, scroller, dir)) {
      if (wheelState.accum > 0) resetEdgePull();
      wheelState.lastEventAt = now;
      return;
    }

    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const hasScrollbar = maxScroll > 2;
    const atEdge =
      dir > 0
        ? !hasScrollbar || scroller.scrollTop >= maxScroll - 2
        : !hasScrollbar || scroller.scrollTop <= 2;

    if (!atEdge) {
      if (wheelState.accum > 0) resetEdgePull();
      wheelState.lastScrollMoveAt = now;
      wheelState.lastEventAt = now;
      return;
    }

    // Wait briefly after arriving at the top/bottom of a scrollable tab so the
    // initial arrival settles cleanly before the continuous pull starts.
    if (hasScrollbar && now - wheelState.lastScrollMoveAt < 160) {
      if (wheelState.accum > 0) resetEdgePull();
      wheelState.lastEventAt = now;
      return;
    }

    const curIdx = SETTINGS_TABS.findIndex(([k]) => k === activeTab);
    const nextIdx = curIdx + dir;
    if (curIdx < 0 || nextIdx < 0 || nextIdx >= SETTINGS_TABS.length) {
      if (wheelState.accum > 0) resetEdgePull();
      wheelState.lastEventAt = now;
      return;
    }

    if (wheelState.dir !== dir || dt > EDGE_CONTINUOUS_GAP_MS) {
      wheelState.accum = 0;
      wheelState.dir = dir;
    }
    wheelState.lastEventAt = now;
    wheelState.accum += absDy;

    const progress = Math.min(1, wheelState.accum / EDGE_SWITCH_THRESHOLD);
    const targetTab = SETTINGS_TABS[nextIdx];

    if (progress >= 1) {
      resetEdgePull();
      wheelState.cooldownUntil = now + 560;
      wheelState.requireNewGesture = true;
      pendingEdgeLandingRef.current = dir > 0 ? "top" : "bottom";
      pendingEdgeAnimDirRef.current = dir;
      openSettingsModal(targetTab[0]);
      return;
    }

    // Continuous rubber-band pull + progress indicator while user keeps scrolling
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const paneEl = getActivePaneEl();
    if (paneEl && !reducedMotion) {
      pulledPaneRef.current = paneEl;
      const offsetPx = -dir * Math.round(24 * Math.pow(progress, 0.78));
      paneEl.style.transition = "none";
      paneEl.style.transform = `translateY(${offsetPx}px)`;
    }

    const targetTabLabel = settingsTabLabels[targetTab[0]] || targetTab[0];
    setEdgePullHint((prev) =>
      prev && prev.dir === dir && prev.targetLabel === targetTabLabel
        ? prev
        : { dir, targetLabel: targetTabLabel }
    );
    if (edgeFillRef.current) {
      edgeFillRef.current.style.transform = `scaleX(${progress.toFixed(3)})`;
    } else {
      requestAnimationFrame(() => {
        if (edgeFillRef.current && edgeWheelRef.current.accum > 0) {
          const p = Math.min(1, edgeWheelRef.current.accum / EDGE_SWITCH_THRESHOLD);
          edgeFillRef.current.style.transform = `scaleX(${p.toFixed(3)})`;
        }
      });
    }

    // The moment scrolling stops, immediately disappear with zero exit/rebound animation
    if (pullResetTimerRef.current) clearTimeout(pullResetTimerRef.current);
    pullResetTimerRef.current = setTimeout(() => {
      pullResetTimerRef.current = null;
      resetEdgePull();
    }, EDGE_CONTINUOUS_GAP_MS);
  };

  useEffect(() => {
    const isOpen = settingsModal.open;
    const justOpened = isOpen && !wasModalOpenRef.current;
    wasModalOpenRef.current = isOpen;

    const curIdx = Math.max(0, SETTINGS_TABS.findIndex(([k]) => k === activeTab));
    const prevIdx = prevTabIndexRef.current;
    prevTabIndexRef.current = curIdx;

    if (!isOpen || isStandalone || !isMobileViewport()) return;

    const rafId = requestAnimationFrame(() => {
      const nav = settingsNavRef.current;
      const activeBtn = nav?.querySelector<HTMLElement>(`[data-settings-tab="${activeTab}"]`);
      if (nav && activeBtn) {
        const targetLeft =
          activeBtn.offsetLeft + activeBtn.offsetWidth / 2 - nav.clientWidth / 2;
        nav.scrollTo({
          left: Math.max(0, targetLeft),
          behavior: justOpened ? "auto" : "smooth",
        });
      }

      if (!justOpened && curIdx !== prevIdx) {
        settingsContentRef.current?.scrollTo({ top: 0 });
        const activePane = settingsContentRef.current?.querySelector<HTMLElement>(
          `.settings-pane[data-settings-pane="${activeTab}"]`
        );
        const reducedMotion =
          typeof window !== "undefined" &&
          window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        if (activePane && typeof activePane.animate === "function" && !reducedMotion) {
          const offset = curIdx > prevIdx ? 28 : -28;
          activePane.animate(
            [
              { opacity: 0.72, transform: `translateX(${offset}px)` },
              { opacity: 1, transform: "translateX(0)" },
            ],
            { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
          );
        }
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [settingsModal.open, activeTab, isStandalone]);

  const handleContentTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobileViewport() || isStandalone || !settingsModal.open || e.touches.length !== 1) {
      swipeStateRef.current = null;
      return;
    }
    if (isHorizontallyScrollableAncestor(e.target, settingsContentRef.current)) {
      swipeStateRef.current = null;
      return;
    }
    const t = e.touches[0];
    swipeStateRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      lastDx: 0,
      startTime: Date.now(),
      locked: null,
    };
  };

  const handleContentTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const st = swipeStateRef.current;
    if (!st || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - st.startX;
    const dy = t.clientY - st.startY;
    if (st.locked === null) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        st.locked = "v";
        return;
      }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        st.locked = "h";
      } else {
        return;
      }
    }
    if (st.locked !== "h") return;
    st.lastDx = dx;
    const curIdx = SETTINGS_TABS.findIndex(([k]) => k === activeTab);
    const atEdge = (dx > 0 && curIdx <= 0) || (dx < 0 && curIdx >= SETTINGS_TABS.length - 1);
    const damped = dx * (atEdge ? 0.2 : 0.42);
    const activePane = settingsContentRef.current?.querySelector<HTMLElement>(
      `.settings-pane[data-settings-pane="${activeTab}"]`
    );
    if (activePane) {
      activePane.style.transform = `translateX(${damped}px)`;
      activePane.style.transition = "none";
    }
  };

  const handleContentTouchEnd = () => {
    const st = swipeStateRef.current;
    swipeStateRef.current = null;
    const activePane = settingsContentRef.current?.querySelector<HTMLElement>(
      `.settings-pane[data-settings-pane="${activeTab}"]`
    );
    if (activePane) {
      activePane.style.transform = "";
      activePane.style.transition = "";
    }
    if (!st || st.locked !== "h") return;
    const elapsed = Math.max(1, Date.now() - st.startTime);
    const velocity = Math.abs(st.lastDx) / elapsed;
    const triggered = Math.abs(st.lastDx) > 48 || (Math.abs(st.lastDx) > 24 && velocity > 0.35);
    if (!triggered) return;
    const curIdx = SETTINGS_TABS.findIndex(([k]) => k === activeTab);
    if (curIdx < 0) return;
    const step = st.lastDx < 0 ? 1 : -1;
    const nextEntry = SETTINGS_TABS[curIdx + step];
    if (nextEntry) {
      openSettingsModal(nextEntry[0]);
    }
  };

  const { language: currentLanguage, locale: currentLocale, t } = useI18n();
  const settingsTabLabels: Record<string, string> = {
    general: t("settings.tabGeneral"),
    models: t("settings.tabModels"),
    computer: t("settings.tabComputer"),
    permissions: t("settings.tabPermissions"),
    vault: t("settings.tabVault"),
    usage: t("settings.tabUsage"),
    updates: t("settings.tabUpdates"),
  };
  const permissionRuleTools = [
    ["*", t("settings.permToolAny")],
    ["host_run_shell", t("settings.permToolHostShell")],
    ["host_open", t("settings.permToolHostOpen")],
    ["host_write_file", t("settings.permToolHostWrite")],
    ["mcp__kimi_cu__click", t("settings.permToolMacClick")],
    ["mcp__kimi_cu__type_text", t("settings.permToolMacType")],
    ["mcp__kimi_cu__js", t("settings.permToolMacJs")],
    ["run_shell", t("settings.permToolBotShell")],
    ["write_file", t("settings.permToolBotWrite")],
    ["open_url", "open_url"],
    ["click", "click"],
  ] as const;

  // Profile local state
  const profile = settings?.profile || { name: "", color: "slate" };
  const profileName = resolveLocalizedProfileName(profile.name, currentLocale);
  const profileColor = String(profile.color || "slate");
  const profileInitial = Array.from(profileName)[0]?.toUpperCase() || "U";
  const [profileNameInput, setProfileNameInput] = useState(profileName);
  const profileCompEndRef = useRef<number | null>(null);

  useEffect(() => {
    setProfileNameInput(profileName);
  }, [profileName]);

  // Budget & Context Compression local state
  const routing = settings?.routing || { smartRouter: true, mode: "balanced", maxTurnUsd: 0.5 };
  const cnyBudgetDefault = String(
    Math.round(Number(routing.maxTurnUsd ?? 0.5) * CLIENT_USD_TO_CNY * 100) / 100
  );
  const [budgetInput, setBudgetInput] = useState(cnyBudgetDefault);
  const budgetInputRef = useRef(cnyBudgetDefault);
  const budgetDirtyRef = useRef(false);
  useEffect(() => {
    if (!budgetDirtyRef.current) {
      setBudgetInput(cnyBudgetDefault);
      budgetInputRef.current = cnyBudgetDefault;
    }
  }, [cnyBudgetDefault]);

  const ctxBase = normalizeContextCompressionSettings(settings?.contextCompression);
  const [ctxPercentDraft, setCtxPercentDraft] = useState<number>(ctxBase.triggerPercent);
  const [ctxInstructionDraft, setCtxInstructionDraft] = useState<string>(
    String(ctxBase.customInstruction || "")
  );
  const ctxDraftRef = useRef({
    enabled: ctxBase.enabled !== false,
    triggerPercent: ctxBase.triggerPercent,
    customInstruction: String(ctxBase.customInstruction || ""),
  });
  const ctxPercentDirtyRef = useRef(false);
  const ctxInstructionDirtyRef = useRef(false);
  const ctxPercentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctxInstructionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctxSaveSeqRef = useRef(0);
  useEffect(() => {
    ctxDraftRef.current.enabled = ctxBase.enabled !== false;
    if (!ctxPercentDirtyRef.current) {
      setCtxPercentDraft(ctxBase.triggerPercent);
      ctxDraftRef.current.triggerPercent = ctxBase.triggerPercent;
    }
    if (!ctxInstructionDirtyRef.current) {
      const nextInstr = String(ctxBase.customInstruction || "");
      setCtxInstructionDraft(nextInstr);
      ctxDraftRef.current.customInstruction = nextInstr;
    }
  }, [ctxBase.enabled, ctxBase.triggerPercent, ctxBase.customInstruction]);

  const ctxEffective = normalizeContextCompressionSettings({
    ...ctxBase,
    triggerPercent: ctxPercentDraft,
    customInstruction: ctxInstructionDraft,
  });
  const ctxEnabled = ctxEffective.enabled !== false;
  const matchedPresetId = matchContextCompressionPreset(ctxEffective);
  const ctxPresets = getLocalizedContextCompressionPresets(currentLocale);
  const presetMeta = ctxPresets.find((p) => p.id === matchedPresetId);

  const screenBudget =
    settings?.screenPool?.budget && typeof settings.screenPool.budget === "object"
      ? settings.screenPool.budget
      : FALLBACK_SCREEN_POOL_BUDGET;
  const screenPoolBase = normalizeScreenPoolSettings(settings?.screenPool, screenBudget);
  const [screenMaxDraft, setScreenMaxDraft] = useState<number>(
    screenPoolBase.maxConcurrentScreens
  );
  const screenMaxDraftRef = useRef<number>(screenPoolBase.maxConcurrentScreens);
  const screenMaxDirtyRef = useRef(false);
  const screenSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenSaveSeqRef = useRef(0);
  useEffect(() => {
    if (!screenMaxDirtyRef.current) {
      setScreenMaxDraft(screenPoolBase.maxConcurrentScreens);
      screenMaxDraftRef.current = screenPoolBase.maxConcurrentScreens;
    }
  }, [screenPoolBase.maxConcurrentScreens]);
  const screenPoolEffective = normalizeScreenPoolSettings(
    {
      ...screenPoolBase,
      mode:
        screenPoolBase.mode === "auto" &&
        screenMaxDraft === screenBudget.defaultBalanced
          ? "auto"
          : "custom",
      maxConcurrentScreens: screenMaxDraft,
    },
    screenBudget
  );
  const matchedScreenPreset = matchScreenPoolPreset(screenPoolEffective, screenBudget);
  const multiDisplaySupported = hasConnectedNodeCapability("multi-display-v1", { diagnostics });
  const vaultSecretSupported = hasConnectedNodeCapability("vault-secret-v1", { diagnostics });
  const localBrowserSupported = hasConnectedNodeCapability("local-browser-automation-v1", {
    diagnostics,
  });
  const browserAutomationCfg = normalizeBrowserAutomationSettings(settings?.browserAutomation);
  const [browserPortDraft, setBrowserPortDraft] = useState<string>(
    String(browserAutomationCfg.debugPort)
  );
  const [browserExecDraft, setBrowserExecDraft] = useState<string>(
    browserAutomationCfg.executablePath
  );
  useEffect(() => {
    setBrowserPortDraft(String(browserAutomationCfg.debugPort));
    setBrowserExecDraft(browserAutomationCfg.executablePath);
  }, [browserAutomationCfg.debugPort, browserAutomationCfg.executablePath]);
  const networkHealth = useStore((s) => s.networkHealth);
  const lanNodeOffline = useStore((s) => s.lanNodeOffline);
  const accountsState = useStore((s) => s.accountsState);
  const remoteAccountOffline = isRemoteAccountOffline({
    accountsState,
    networkHealth,
    lanNodeOffline,
  } as any);

  // Global Memory form
  const [memFormOpen, setMemFormOpen] = useState(false);
  const [editingMemId, setEditingMemId] = useState<string | null>(null);
  const [memName, setMemName] = useState("");
  const [memContent, setMemContent] = useState("");
  const [pendingDeleteMemId, setPendingDeleteMemId] = useState<string | null>(null);
  const memNameRef = useRef<HTMLInputElement | null>(null);

  const openMemoryEditor = (mem: any | null) => {
    const targetId = mem ? String(mem.id || mem.name || "") : null;
    if (memFormOpen && editingMemId === targetId) {
      setMemFormOpen(false);
      setEditingMemId(null);
      return;
    }
    if (mem) {
      setEditingMemId(targetId);
      setMemName(String(mem.name || ""));
      setMemContent(String(mem.instruction || mem.content || mem.desc || ""));
    } else {
      setEditingMemId(null);
      setMemName("");
      setMemContent("");
    }
    setPendingDeleteMemId(null);
    setMemFormOpen(true);
    requestAnimationFrame(() => memNameRef.current?.focus());
  };

  useEffect(() => {
    if (settingsModal.open && settingsModal.openNewMemoryOnMount) {
      openMemoryEditor(null);
      setState((prev) => ({
        settingsModal: { ...prev.settingsModal, openNewMemoryOnMount: false },
      }));
    }
  }, [settingsModal.open, settingsModal.openNewMemoryOnMount]);

  const globalMemories: any[] = Array.isArray(settings?.globalMemories)
    ? settings.globalMemories
    : Array.isArray(settings?.privateSkills)
      ? settings.privateSkills
      : [];

  // Provider form
  const [provFormOpen, setProvFormOpen] = useState(false);
  const [provId, setProvId] = useState("");
  const [provType, setProvType] = useState("gemini");
  const [provName, setProvName] = useState("Google Gemini");
  const [provCurrency, setProvCurrency] = useState<"USD" | "CNY">("USD");
  const [provApiKey, setProvApiKey] = useState("");
  const [provShowKey, setProvShowKey] = useState(false);
  const [provBaseUrl, setProvBaseUrl] = useState("");
  const [provModels, setProvModels] = useState(
    "gemini-4-hydrogen, gemini-4-argon, gemini-4-carbon"
  );
  const [provImageModels, setProvImageModels] = useState(
    "gemini-3.1-flash-image, gemini-3-pro-image, gemini-2.5-flash-image"
  );
  const [provFeedback, setProvFeedback] = useState<{ text: string; kind: string }>({
    text: "",
    kind: "info",
  });
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [pendingDeleteProviderId, setPendingDeleteProviderId] = useState<string | null>(null);
  const provNameRef = useRef<HTMLInputElement | null>(null);

  // Policy rules forms
  const [askFormOpen, setAskFormOpen] = useState(false);
  const [askTool, setAskTool] = useState("*");
  const [askPattern, setAskPattern] = useState("");
  const [allowFormOpen, setAllowFormOpen] = useState(false);
  const [allowTool, setAllowTool] = useState("host_run_shell");
  const [allowPattern, setAllowPattern] = useState("");
  const [editingRuleKey, setEditingRuleKey] = useState<string | null>(null);
  const [editRuleTool, setEditRuleTool] = useState("*");
  const [editRulePattern, setEditRulePattern] = useState("");
  const [pendingDeleteRuleId, setPendingDeleteRuleId] = useState<string | null>(null);

  // Vault form
  const [vaultFormOpen, setVaultFormOpen] = useState(false);
  const [editingVaultId, setEditingVaultId] = useState<string | null>(null);
  const [vaultCat, setVaultCat] = useState("contact");
  const [vaultTitle, setVaultTitle] = useState("");
  const [vaultSub, setVaultSub] = useState("");
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultPasswordTouched, setVaultPasswordTouched] = useState(false);
  const [vaultHasPassword, setVaultHasPassword] = useState(false);
  const [vaultPasswordVisible, setVaultPasswordVisible] = useState(false);
  const [vaultRevealing, setVaultRevealing] = useState(false);
  const [pendingDeleteVaultId, setPendingDeleteVaultId] = useState<string | null>(null);
  const vaultTitleRef = useRef<HTMLInputElement | null>(null);

  // Computer & Billing busy states
  const [detectingComputer, setDetectingComputer] = useState(false);
  const [updatingComputer, setUpdatingComputer] = useState(false);
  const [resettingComputer, setResettingComputer] = useState(false);
  const [refreshingAllBilling, setRefreshingAllBilling] = useState(false);

  const openVaultEditor = (item: any | null) => {
    const targetId = item ? String(item.id || "") : null;
    if (vaultFormOpen && editingVaultId === targetId) {
      setVaultFormOpen(false);
      setEditingVaultId(null);
      return;
    }
    if (item) {
      setEditingVaultId(targetId);
      setVaultCat(item.category || "contact");
      setVaultTitle(String(item.title || ""));
      setVaultSub(String(item.subtitle || ""));
      setVaultHasPassword(Boolean(item.hasPassword));
    } else {
      setEditingVaultId(null);
      setVaultCat("contact");
      setVaultTitle("");
      setVaultSub("");
      setVaultHasPassword(false);
    }
    setVaultPassword("");
    setVaultPasswordTouched(false);
    setVaultPasswordVisible(false);
    setVaultRevealing(false);
    setPendingDeleteVaultId(null);
    setVaultFormOpen(true);
    requestAnimationFrame(() => vaultTitleRef.current?.focus());
  };

  const applyProviderTypePreset = (nextType: string, keepCustomEdits = false) => {
    const preset = getProviderPresetUi(nextType, currentLocale);
    setProvType(nextType);
    if (!keepCustomEdits) {
      setProvName(preset.name);
      setProvCurrency(
        preset.billingCurrency || (nextType === "deepseek" ? "CNY" : "USD")
      );
      setProvBaseUrl(preset.baseUrl);
      setProvModels(preset.models);
      setProvImageModels(preset.imageModels || "");
    }
    setProvFeedback({ text: "", kind: "info" });
  };

  const openProviderEditor = (p: any | null) => {
    const targetId = p?.id || "";
    if (provFormOpen && provId === targetId) {
      setProvFormOpen(false);
      setProvId("");
      return;
    }
    const rawT = p?.type === "vertex" ? "gemini" : p?.type || "gemini";
    const tKey = (SETTINGS_PROVIDER_KEYS as readonly string[]).includes(rawT) ? rawT : "gemini";
    const preset = getProviderPresetUi(tKey, currentLocale);
    setProvId(targetId);
    setProvType(tKey);
    setProvName(p?.name || preset.name);
    setProvCurrency(
      p?.billingCurrency || preset.billingCurrency || (tKey === "deepseek" ? "CNY" : "USD")
    );
    setProvApiKey("");
    setProvShowKey(false);
    setProvBaseUrl(p ? p.baseUrl || "" : preset.baseUrl);
    setProvModels(p ? (p.models || []).join(", ") : preset.models);
    setProvImageModels(p ? (p.imageModels || []).join(", ") : preset.imageModels || "");
    setProvFeedback({ text: "", kind: "info" });
    setPendingDeleteProviderId(null);
    setProvFormOpen(true);
    requestAnimationFrame(() => provNameRef.current?.focus());
  };

  // Tier options
  const providers: any[] = Array.isArray(settings?.providers) ? settings.providers : [];
  const enabledProviders = providers.filter((p) => p.enabled !== false);
  const textModelOptions: Array<{ value: string; label: string }> = [];
  const imageModelOptions: Array<{ value: string; label: string }> = [];
  const seenImg = new Set<string>();

  for (const p of enabledProviders) {
    for (const m of p.models || []) {
      textModelOptions.push({
        value: `${p.id}::${m}`,
        label: `${p.name || p.type} · ${m}`,
      });
    }
    for (const m of p.imageModels || []) {
      const val = `${p.id}::${m}`;
      if (!seenImg.has(val)) {
        seenImg.add(val);
        imageModelOptions.push({ value: val, label: `${p.name || p.type} · ${m}` });
      }
    }
  }

  const tiers = routing?.tiers || {};
  const resolveTierSelectVal = (tierKey: string, opts: Array<{ value: string }>, optional: boolean) => {
    const cur = tiers[tierKey];
    const curVal = cur?.providerId && cur?.model ? `${cur.providerId}::${cur.model}` : "";
    if (opts.some((o) => o.value === curVal)) return curVal;
    return optional ? "" : opts[0]?.value || "";
  };

  const handleTierChange = async (tierKey: string, nextVal: string) => {
    const nextTiers: Record<string, any> = {};
    for (const k of ["fast", "medium", "advanced", "image"]) {
      const val =
        k === tierKey
          ? nextVal
          : k === "image"
            ? resolveTierSelectVal("image", imageModelOptions, true)
            : resolveTierSelectVal(k, textModelOptions, false);
      const sep = val.indexOf("::");
      if (sep !== -1) {
        nextTiers[k] = {
          providerId: val.slice(0, sep),
          model: val.slice(sep + 2),
        };
      }
    }
    try {
      await commitSettingsPatch({ routing: { ...routing, tiers: nextTiers } });
      showToast(t("settings.modelRoutingSavedToast"));
    } catch (err: any) {
      showToast(t("actions.saveFailed", { error: err.message }));
    }
  };

  const saveCtxCompression = async (
    patch: Partial<{ enabled: boolean; triggerPercent: number; customInstruction: string }>,
    opts: { skipIfUnchanged?: boolean } = {}
  ) => {
    if (ctxPercentTimerRef.current) {
      clearTimeout(ctxPercentTimerRef.current);
      ctxPercentTimerRef.current = null;
    }
    if (ctxInstructionTimerRef.current) {
      clearTimeout(ctxInstructionTimerRef.current);
      ctxInstructionTimerRef.current = null;
    }
    const mergedDraft = {
      enabled:
        patch.enabled !== undefined ? patch.enabled : ctxDraftRef.current.enabled,
      triggerPercent:
        patch.triggerPercent !== undefined
          ? patch.triggerPercent
          : ctxDraftRef.current.triggerPercent,
      customInstruction:
        patch.customInstruction !== undefined
          ? patch.customInstruction
          : ctxDraftRef.current.customInstruction,
    };
    ctxDraftRef.current = mergedDraft;
    const next = normalizeContextCompressionSettings({ ...ctxBase, ...mergedDraft });
    if (
      opts.skipIfUnchanged &&
      next.enabled === ctxBase.enabled &&
      next.triggerPercent === ctxBase.triggerPercent &&
      String(next.customInstruction || "") === String(ctxBase.customInstruction || "")
    ) {
      ctxPercentDirtyRef.current = false;
      ctxInstructionDirtyRef.current = false;
      return;
    }
    const mySaveSeq = ++ctxSaveSeqRef.current;
    try {
      await commitSettingsPatch({ contextCompression: next });
      if (mySaveSeq === ctxSaveSeqRef.current) {
        ctxPercentDirtyRef.current = false;
        ctxInstructionDirtyRef.current = false;
      }
    } catch (err: any) {
      if (mySaveSeq === ctxSaveSeqRef.current) {
        ctxPercentDirtyRef.current = false;
        ctxInstructionDirtyRef.current = false;
        ctxDraftRef.current = {
          enabled: ctxBase.enabled !== false,
          triggerPercent: ctxBase.triggerPercent,
          customInstruction: String(ctxBase.customInstruction || ""),
        };
        setCtxPercentDraft(ctxBase.triggerPercent);
        setCtxInstructionDraft(String(ctxBase.customInstruction || ""));
      }
      showToast(t("settings.ctxCompressSaveFailed", { error: err?.message || t("actions.requestError") }));
    }
  };

  const saveScreenPool = async (
    patch: { mode?: "auto" | "custom"; maxConcurrentScreens?: number },
    opts: { skipIfUnchanged?: boolean } = {}
  ) => {
    if (screenSaveTimerRef.current) {
      clearTimeout(screenSaveTimerRef.current);
      screenSaveTimerRef.current = null;
    }
    const next = normalizeScreenPoolSettings(
      { ...screenPoolBase, ...patch },
      screenBudget
    );
    screenMaxDraftRef.current = next.maxConcurrentScreens;
    if (
      opts.skipIfUnchanged &&
      next.mode === screenPoolBase.mode &&
      next.maxConcurrentScreens === screenPoolBase.maxConcurrentScreens
    ) {
      screenMaxDirtyRef.current = false;
      return;
    }
    const mySaveSeq = ++screenSaveSeqRef.current;
    try {
      await commitSettingsPatch({
        screenPool: {
          mode: next.mode,
          maxConcurrentScreens: next.maxConcurrentScreens,
        },
      });
      if (mySaveSeq === screenSaveSeqRef.current) {
        screenMaxDirtyRef.current = false;
      }
      void refreshComputerDisplays();
    } catch (err: any) {
      if (mySaveSeq === screenSaveSeqRef.current) {
        screenMaxDirtyRef.current = false;
        screenMaxDraftRef.current = screenPoolBase.maxConcurrentScreens;
        setScreenMaxDraft(screenPoolBase.maxConcurrentScreens);
      }
      showToast(t("settings.screenPoolSaveFailed", { error: err?.message || t("actions.requestError") }));
    }
  };

  const commitBudget = async (rawValue = budgetInputRef.current) => {
    const cny = Math.max(0.35, Math.min(72.5, Number(rawValue) || 3.63));
    const maxTurnUsd = Math.round((cny / CLIENT_USD_TO_CNY) * 1000) / 1000;
    const prevUsd = Math.round(Number(routing.maxTurnUsd ?? 0.5) * 1000) / 1000;
    budgetDirtyRef.current = false;
    if (maxTurnUsd === prevUsd) {
      setBudgetInput(cnyBudgetDefault);
      budgetInputRef.current = cnyBudgetDefault;
      return;
    }
    try {
      await commitSettingsPatch({ routing: { ...routing, maxTurnUsd } });
    } catch (err: any) {
      setBudgetInput(cnyBudgetDefault);
      budgetInputRef.current = cnyBudgetDefault;
      showToast(t("settings.budgetSaveFailed", { error: err?.message || t("actions.requestError") }));
    }
  };

  const flushDirtyDraftsRef = useRef<() => void>(() => {});
  flushDirtyDraftsRef.current = () => {
    if (ctxPercentDirtyRef.current || ctxInstructionDirtyRef.current) {
      void saveCtxCompression({}, { skipIfUnchanged: true });
    }
    if (screenMaxDirtyRef.current) {
      const val = screenMaxDraftRef.current;
      void saveScreenPool(
        {
          mode: val === screenBudget.defaultBalanced ? "auto" : "custom",
          maxConcurrentScreens: val,
        },
        { skipIfUnchanged: true }
      );
    }
    if (budgetDirtyRef.current) {
      void commitBudget(budgetInputRef.current);
    }
  };

  const prevOpenForFlushRef = useRef(settingsModal.open);
  useEffect(() => {
    if (prevOpenForFlushRef.current && !settingsModal.open) {
      flushDirtyDraftsRef.current();
    }
    prevOpenForFlushRef.current = settingsModal.open;
  }, [settingsModal.open]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const dirtyPatch: Record<string, any> = {};
      if (ctxPercentDirtyRef.current || ctxInstructionDirtyRef.current) {
        dirtyPatch.contextCompression = normalizeContextCompressionSettings({
          ...ctxDraftRef.current,
        });
      }
      if (screenMaxDirtyRef.current) {
        const val = screenMaxDraftRef.current;
        dirtyPatch.screenPool = {
          mode: val === screenBudget.defaultBalanced ? "auto" : "custom",
          maxConcurrentScreens: val,
        };
      }
      if (budgetDirtyRef.current) {
        const cny = Math.max(0.35, Math.min(72.5, Number(budgetInputRef.current) || 3.63));
        dirtyPatch.routing = {
          maxTurnUsd: Math.round((cny / CLIENT_USD_TO_CNY) * 1000) / 1000,
        };
      }
      if (Object.keys(dirtyPatch).length === 0) return;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const authToken = getState().activeAuthToken;
        if (authToken) headers.Authorization = `Bearer ${authToken}`;
        void fetch(apiUrl("/api/settings"), {
          method: "POST",
          keepalive: true,
          headers,
          body: JSON.stringify(dirtyPatch),
        });
      } catch {}
    };
    window.addEventListener("pagehide", handleBeforeUnload);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", handleBeforeUnload);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (ctxPercentTimerRef.current) clearTimeout(ctxPercentTimerRef.current);
      if (ctxInstructionTimerRef.current) clearTimeout(ctxInstructionTimerRef.current);
      if (screenSaveTimerRef.current) clearTimeout(screenSaveTimerRef.current);
    };
  }, [screenBudget.defaultBalanced]);

  const handleSaveProfile = async () => {
    const nextName = profileNameInput.trim();
    if (!nextName) {
      showToast(t("settings.profileNameInvalid"));
      return;
    }
    try {
      const saved = await commitSettingsPatch({
        profile: { name: nextName, color: profileColor },
      });
      showToast(t("settings.profileSavedToast", { name: saved?.profile?.name || nextName }));
    } catch (err: any) {
      showToast(t("settings.profileSaveFailed", { error: err?.message || t("actions.requestError") }));
    }
  };

  // Usage payload computation
  const requestedSid =
    usageScope === "session" ? usageScopeSessionId || activeSessionId || "" : "";
  const usagePayload = requestedSid
    ? lastSessionUsagePayloads[requestedSid] || buildOptimisticUsagePayload(requestedSid)
    : lastGlobalUsagePayload || buildOptimisticUsagePayload("");

  const isSessionScope = Boolean(requestedSid || usagePayload?.scope === "session");
  const scopedSession =
    usagePayload?.session || sessions.find((s: any) => s.id === requestedSid) || null;
  const scopedSessionTitle = scopedSession?.title || t("settings.usageCurrentBotFallback");

  const totalTok = Number(usagePayload?.totalTokens) || 0;
  const estCny = Number(usagePayload?.estimatedCostCny) || 0;
  const extraParts: string[] = [];
  if (Number(usagePayload?.cachedTokens) > 0) {
    extraParts.push(
      t("settings.usageCacheHitPart", { n: Number(usagePayload.cachedTokens).toLocaleString() })
    );
  }
  if (Number(usagePayload?.thoughtTokens) > 0) {
    extraParts.push(
      t("settings.usageThoughtPart", { n: Number(usagePayload.thoughtTokens).toLocaleString() })
    );
  }
  const extraSuffix =
    extraParts.length > 0 ? t("settings.usageParenWrap", { text: extraParts.join(" · ") }) : "";
  const tailSuffix = isSessionScope
    ? requestedSid === activeSessionId && stepCount > 0
      ? t("settings.usageExecStepsPart", { count: stepCount })
      : ""
    : t("settings.usageSessionCountPart", { count: usagePayload?.sessionCount ?? sessions.length });

  const byModel: any[] = Array.isArray(usagePayload?.byModel) ? usagePayload.byModel : [];
  const nonZeroModels = byModel.filter((m) => (Number(m.totalTokens) || 0) > 0);
  const bySession: any[] =
    !isSessionScope && Array.isArray(usagePayload?.bySession)
      ? usagePayload.bySession.slice(0, 12)
      : [];

  const mergedBilling = providerBilling?.merged || {};
  const billingCards: any[] = Array.isArray(providerBilling?.providers)
    ? providerBilling.providers
    : [];
  const mergedTags: any[] = Array.isArray(mergedBilling.providersWithBalance)
    ? mergedBilling.providersWithBalance
    : [];

  // Vault filtered items
  const vQuery = vaultSearch.trim().toLowerCase();
  const filteredVault = vaultItems.filter((it: any) => {
    const isAccountLike =
      it.category === "login" || it.category === "credential" || it.category === "account";
    const tabOk =
      vaultTab === "all" ||
      (vaultTab === "login" ? isAccountLike : it.category === vaultTab);
    const locIt = resolveLocalizedVaultItem(it, currentLocale);
    const searchOk =
      !vQuery ||
      locIt.title.toLowerCase().includes(vQuery) ||
      locIt.subtitle.toLowerCase().includes(vQuery) ||
      String(it.title || "").toLowerCase().includes(vQuery) ||
      String(it.subtitle || "").toLowerCase().includes(vQuery);
    return tabOk && searchOk;
  });

  // Policy rules
  const policy = settings?.policy || { autoAudit: true, askRules: [], allowRules: [] };
  const askRules: any[] = policy.askRules || [];
  const allowRules: any[] = policy.allowRules || [];

  // Computer & Diagnostics display
  const hostExecMode = settings?.hostComputer?.executionMode || "always";
  const hostModeLabel =
    hostExecMode === "off"
      ? t("settings.computerExecHostOffLabel")
      : hostExecMode === "ask"
        ? t("settings.computerExecHostAskLabel")
        : t("settings.computerExecHostAlwaysLabel");
  const compStatusView = resolveBotComputerStatusDisplay(computerStatus, {
    detecting: detectingComputer,
    locale: currentLocale,
  });
  const hasCompProbe = compStatusView.hasProbe;

  const providerModels = enabledProviders.flatMap((p: any) =>
    [...(p.models || []), ...(p.imageModels || [])]
      .filter(Boolean)
      .map((m: string) => `${p.name || p.type}:${m}`)
  );
  const diagAllModels =
    providerModels.length > 0
      ? providerModels
      : diagnostics
        ? [
            ...(diagnostics.models || []),
            ...(diagnostics.imageModels || []),
          ].filter(Boolean)
        : [];
  const diagLlmReady = diagnostics
    ? Boolean(diagnostics.llmConfigured ?? diagnostics.geminiKeyConfigured)
    : enabledProviders.length > 0;
  const diagEnvLabel =
    diagnostics?.deployEnv === "cloud"
      ? t("settings.diagEnvCloud")
      : t("settings.diagEnvLocal");
  const diagExecOnline = Boolean(diagnostics?.executorOnline);
  const diagExecUrl = diagnostics?.executorUrl || "http://127.0.0.1:7300";

  const openRuleEditor = (kind: "ask" | "allow", rule: any) => {
    const key = `${kind}:${rule.id}`;
    if (editingRuleKey === key) {
      setEditingRuleKey(null);
      return;
    }
    setPendingDeleteRuleId(null);
    setEditingRuleKey(key);
    setEditRuleTool(rule.tool || "*");
    setEditRulePattern(rule.pattern || "");
  };

  const renderMemoryEditor = (inline: boolean, visible: boolean) => (
    <div
      id="new-memory-form-card"
      className={`custom-skill-editor settings-inline-editor${inline ? " is-inline-row-editor" : ""}`}
      hidden={!visible}
    >
      {!inline && (
        <div className="custom-skill-editor-top">
          <strong>{t("settings.memEditorNewTitle")}</strong>
        </div>
      )}
      <div className="custom-skill-fields">
        <label className="field-group">
          <span>{t("settings.memEditorNameLabel")}</span>
          <input
            ref={memNameRef}
            id="memory-name-input"
            type="text"
            placeholder={t("settings.memEditorNamePh")}
            aria-label={t("settings.memEditorNameAria")}
            value={memName}
            onChange={(e) => setMemName(e.target.value)}
          />
        </label>
        <label className="field-group">
          <span>{t("settings.memEditorContentLabel")}</span>
          <textarea
            id="memory-content-input"
            className="is-compact-textarea"
            rows={3}
            placeholder={t("settings.memEditorContentPh")}
            aria-label={t("settings.memEditorContentAria")}
            value={memContent}
            onChange={(e) => setMemContent(e.target.value)}
          />
        </label>
      </div>
      <div className="inline-form-actions">
        <button
          id="cancel-memory-btn"
          type="button"
          className="skill-pill-btn"
          onClick={() => {
            setMemFormOpen(false);
            setEditingMemId(null);
          }}
        >
          {t("common.cancel")}
        </button>
        <button
          id="save-memory-btn"
          type="button"
          className="skill-pill-btn is-primary"
          onClick={async () => {
            const content = memContent.trim();
            if (!content) {
              showToast(t("settings.memContentRequiredToast"));
              return;
            }
            const title = memName.trim() || content.replace(/\s+/g, " ").slice(0, 18);
            const nowIso = new Date().toISOString();
            const next = editingMemId
              ? globalMemories.map((x: any) =>
                  String(x.id || x.name) === editingMemId
                    ? {
                        ...x,
                        name: title,
                        desc: content,
                        instruction: content,
                        content,
                        updatedAt: nowIso,
                      }
                    : x
                )
              : [
                  {
                    id: `gmem-${Date.now()}`,
                    name: title,
                    desc: content,
                    instruction: content,
                    content,
                    enabled: true,
                    updatedAt: nowIso,
                  },
                  ...globalMemories,
                ];
            try {
              await commitSettingsPatch({ globalMemories: next, privateSkills: next });
              setMemName("");
              setMemContent("");
              setEditingMemId(null);
              setMemFormOpen(false);
              showToast(editingMemId ? t("settings.memUpdatedToast") : t("settings.memSavedToast"));
            } catch (err: any) {
              showToast(t("settings.memSaveFailedToast", { error: err?.message || t("actions.requestError") }));
            }
          }}
        >
          {t("settings.memSaveBtn")}
        </button>
      </div>
    </div>
  );

  const renderProviderEditor = (inline: boolean, visible: boolean) => (
    <form
      id="provider-form"
      className={`custom-skill-editor settings-inline-editor provider-form-card${inline ? " is-inline-row-editor" : ""}`}
      hidden={!visible}
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        const resolvedName =
          provName.trim() || getProviderPresetUi(provType, currentLocale).name || provType;
        try {
          const res = await apiJson("/api/providers", {
            method: "POST",
            body: JSON.stringify({
              id: provId.trim() || undefined,
              type: provType,
              name: resolvedName,
              billingCurrency: provCurrency,
              apiKey: provApiKey.trim(),
              baseUrl: provBaseUrl.trim(),
              models: parseModelsCsv(provModels),
              imageModels: parseModelsCsv(provImageModels),
            }),
          });
          setProvFormOpen(false);
          setProvId("");
          await refreshSettingsFromServer();
          refreshSystemDiagnostics(false);
          showToast(
            res.autoAssignedTiers
              ? t("settings.provSavedAutoTiersToast", { name: resolvedName })
              : t("settings.provSavedToast", { name: resolvedName })
          );
        } catch (err: any) {
          setProvFeedback({ text: `❌ ${err.message}`, kind: "error" });
        }
      }}
    >
      <input id="provider-id-input" type="hidden" value={provId} readOnly />
      {!inline && (
        <div className="custom-skill-editor-top">
          <strong>{t("settings.provAddTitle")}</strong>
        </div>
      )}

      <div className="custom-skill-fields">
        <div className="field-group">
          <span>{t("settings.provTypeLabel")}</span>
          <div
            className="provider-preset-pills"
            role="radiogroup"
            aria-label={t("settings.provTypeLabel")}
          >
            {SETTINGS_PROVIDER_KEYS.map((pKey) => {
              const pr = getProviderPresetUi(pKey, currentLocale);
              const active = provType === pKey;
              return (
                <button
                  key={pKey}
                  type="button"
                  role="radio"
                  aria-checked={active ? "true" : "false"}
                  className={`provider-preset-pill${active ? " is-active" : ""}`}
                  data-provider-preset={pKey}
                  onClick={() => applyProviderTypePreset(pKey, Boolean(provId))}
                >
                  {pr?.shortLabel || pr?.name || pKey}
                </button>
              );
            })}
          </div>
          <select
            id="provider-type-select"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            value={provType}
            onChange={(e) => applyProviderTypePreset(e.target.value, Boolean(provId))}
          >
            {SETTINGS_PROVIDER_KEYS.map((pKey) => (
              <option key={pKey} value={pKey}>
                {getProviderPresetUi(pKey, currentLocale).name || pKey}
              </option>
            ))}
          </select>
          <span className="provider-preset-hint">
            {getProviderPresetUi(provType, currentLocale).hint || ""}
          </span>
        </div>

        {provType === "gemini" && Boolean(settings?.gcpVertexActive) && (
          <div className="mail-feedback-box is-success">
            {t("settings.provGcpVertexNotice", {
              project: settings?.gcpVertexProject || "",
              location: settings?.gcpVertexLocation || "",
            })}
          </div>
        )}
        {provType === "gemini" &&
          !settings?.gcpVertexActive &&
          Boolean(settings?.blockedVertexReason) && (
            <div className="mail-feedback-box is-error">
              {settings?.blockedVertexReason}
            </div>
          )}

        <div className="custom-skill-row-two">
          <label className="field-group custom-skill-name-field">
            <span>{t("settings.provDisplayNameLabel")}</span>
            <input
              ref={provNameRef}
              id="provider-name-input"
              type="text"
              placeholder={t("settings.provDisplayNamePh")}
              aria-label={t("settings.provDisplayNameAria")}
              value={provName}
              onChange={(e) => setProvName(e.target.value)}
            />
          </label>
          <label className="field-group custom-skill-slug-field">
            <span>{t("settings.provCurrencyLabel")}</span>
            <select
              id="provider-billing-currency-select"
              aria-label={t("settings.provCurrencyLabel")}
              value={provCurrency}
              onChange={(e) => setProvCurrency(e.target.value as "USD" | "CNY")}
            >
              <option value="USD">{t("settings.provCurrencyUsd")}</option>
              <option value="CNY">{t("settings.provCurrencyCny")}</option>
            </select>
          </label>
        </div>

        <div className="field-group">
          <div className="mail-label-row">
            <span>
              {t("settings.provApiKeyLabel")}
              {provId ? t("settings.provApiKeyKeepHint") : ""}
            </span>
            <button
              type="button"
              className="mail-secret-toggle"
              onClick={() => setProvShowKey((v) => !v)}
            >
              {provShowKey ? t("common.hide") : t("common.show")}
            </button>
          </div>
          <input
            id="provider-api-key-input"
            type={provShowKey ? "text" : "password"}
            placeholder={t("settings.provApiKeyPh")}
            aria-label={t("settings.provApiKeyAria")}
            autoComplete="off"
            value={provApiKey}
            onChange={(e) => setProvApiKey(e.target.value)}
          />
        </div>

        <label className="field-group">
          <span>
            {t("settings.provBaseUrlLabel", {
              hint:
                provType === "openai-compatible"
                  ? t("settings.provBaseUrlRequiredHint")
                  : t("settings.provBaseUrlOptionalHint"),
            })}
          </span>
          <input
            id="provider-base-url-input"
            type="url"
            placeholder={t("settings.provBaseUrlPh")}
            aria-label={t("settings.provBaseUrlAria")}
            value={provBaseUrl}
            onChange={(e) => setProvBaseUrl(e.target.value)}
          />
        </label>

        <label className="field-group">
          <span>{t("settings.provModelsLabel")}</span>
          <textarea
            id="provider-models-input"
            className="is-compact-textarea"
            rows={2}
            placeholder={t("settings.provModelsPh")}
            aria-label={t("settings.provModelsAria")}
            value={provModels}
            onChange={(e) => setProvModels(e.target.value)}
          />
        </label>

        <label className="field-group">
          <span>{t("settings.provImageModelsLabel")}</span>
          <textarea
            id="provider-image-models-input"
            className="is-compact-textarea"
            rows={1}
            placeholder={t("settings.provImageModelsPh")}
            aria-label={t("settings.provImageModelsAria")}
            value={provImageModels}
            onChange={(e) => setProvImageModels(e.target.value)}
          />
        </label>
      </div>

      <div
        id="provider-form-feedback"
        className={`mail-feedback-box${
          provFeedback.kind === "ok"
            ? " is-success"
            : provFeedback.kind === "error"
              ? " is-error"
              : ""
        }`}
        role="status"
        aria-live="polite"
        hidden={!provFeedback.text}
      >
        <StatusText text={provFeedback.text} />
      </div>

      <div className="inline-form-actions">
        <button
          id="provider-cancel-btn"
          type="button"
          className="skill-pill-btn"
          onClick={() => {
            setProvFormOpen(false);
            setProvId("");
          }}
        >
          {t("common.cancel")}
        </button>
        <button
          id="provider-test-btn"
          type="button"
          className="skill-pill-btn"
          onClick={async () => {
            const models = parseModelsCsv(provModels);
            setProvFeedback({ text: t("settings.provTestingConn"), kind: "info" });
            try {
              const res = await apiJson("/api/providers/test", {
                method: "POST",
                body: JSON.stringify({
                  id: provId.trim() || undefined,
                  type: provType,
                  apiKey: provApiKey.trim(),
                  baseUrl: provBaseUrl.trim(),
                  models,
                  model: models[0],
                }),
              });
              setProvFeedback({
                text: res.ok
                  ? t("settings.provConnOk", { ms: res.latencyMs })
                  : t("settings.provConnFail", { error: res.error }),
                kind: res.ok ? "ok" : "error",
              });
            } catch (err: any) {
              setProvFeedback({ text: `❌ ${err.message}`, kind: "error" });
            }
          }}
        >
          {t("settings.provTestBtn")}
        </button>
        <button
          id="provider-save-btn"
          type="submit"
          className="skill-pill-btn is-primary"
        >
          {t("settings.provSaveBtn")}
        </button>
      </div>
    </form>
  );

  const renderVaultEditor = (inline: boolean, visible: boolean) => (
    <div
      id="vault-new-form"
      className={`custom-skill-editor settings-inline-editor${inline ? " is-inline-row-editor" : ""}`}
      hidden={!visible}
    >
      {!inline && (
        <div className="custom-skill-editor-top">
          <strong>{t("settings.vaultNewItemTitle")}</strong>
        </div>
      )}
      <div className="custom-skill-fields">
        <div className="custom-skill-row-two">
          <label className="field-group custom-skill-slug-field">
            <span>{t("settings.vaultCatLabel")}</span>
            <select
              id="vault-cat-input"
              value={vaultCat}
              onChange={(e) => setVaultCat(e.target.value)}
            >
              <option value="contact">{t("settings.vaultCatContact")}</option>
              <option value="credential">{t("settings.vaultCatCredential")}</option>
              <option value="login">{t("settings.vaultCatLogin")}</option>
            </select>
          </label>
          <label className="field-group custom-skill-name-field">
            <span>{t("settings.vaultNameLabel")}</span>
            <input
              ref={vaultTitleRef}
              id="vault-title-input"
              type="text"
              placeholder={t("settings.vaultNamePh")}
              value={vaultTitle}
              onChange={(e) => setVaultTitle(e.target.value)}
            />
          </label>
        </div>
        <label className="field-group">
          <span>{t("settings.vaultSubLabel")}</span>
          <input
            id="vault-sub-input"
            type="text"
            placeholder={t("settings.vaultSubLabel")}
            value={vaultSub}
            onChange={(e) => setVaultSub(e.target.value)}
          />
        </label>
        {vaultSecretSupported && (
          <label className="field-group">
            <span>{t("settings.vaultPasswordLabel")}</span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                id="vault-password-input"
                type={vaultPasswordVisible ? "text" : "password"}
                autoComplete="new-password"
                style={{ flex: 1, minWidth: 0 }}
                placeholder={
                  editingVaultId && vaultHasPassword && !vaultPasswordTouched
                    ? t("settings.vaultPasswordKeepPh")
                    : t("settings.vaultPasswordNewPh")
                }
                value={vaultPassword}
                onChange={(e) => {
                  setVaultPassword(e.target.value);
                  setVaultPasswordTouched(true);
                }}
              />
              {editingVaultId && vaultHasPassword && (
                <button
                  type="button"
                  id="vault-reveal-password-btn"
                  className="skill-pill-btn"
                  disabled={vaultRevealing}
                  onClick={async () => {
                    if (vaultPasswordVisible) {
                      setVaultPasswordVisible(false);
                      return;
                    }
                    if (!vaultPasswordTouched && !vaultPassword) {
                      setVaultRevealing(true);
                      try {
                        const res = await apiJson(
                          `/api/vault/${encodeURIComponent(editingVaultId)}/reveal`,
                          { method: "POST" }
                        );
                        setVaultPassword(String(res?.password || ""));
                        setVaultPasswordVisible(true);
                      } catch (err: any) {
                        showToast(t("settings.vaultRevealFailedToast", { error: err?.message || t("settings.vaultRetry") }));
                      } finally {
                        setVaultRevealing(false);
                      }
                    } else {
                      setVaultPasswordVisible(true);
                    }
                  }}
                >
                  {vaultRevealing
                    ? t("settings.vaultDecrypting")
                    : vaultPasswordVisible
                      ? t("common.hide")
                      : t("settings.vaultViewBtn")}
                </button>
              )}
              {editingVaultId && vaultHasPassword && (
                <button
                  type="button"
                  id="vault-clear-password-btn"
                  className="skill-pill-btn is-danger-text"
                  onClick={() => {
                    setVaultPassword("");
                    setVaultPasswordTouched(true);
                    setVaultHasPassword(false);
                    setVaultPasswordVisible(false);
                  }}
                >
                  {t("settings.vaultClearBtn")}
                </button>
              )}
            </div>
          </label>
        )}
      </div>
      <div className="inline-form-actions">
        <button
          type="button"
          className="skill-pill-btn"
          id="cancel-vault-item-btn"
          onClick={() => {
            setVaultFormOpen(false);
            setEditingVaultId(null);
            setVaultPassword("");
            setVaultPasswordTouched(false);
            setVaultPasswordVisible(false);
          }}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="skill-pill-btn is-primary"
          id="save-vault-item-btn"
          onClick={async () => {
            const title = vaultTitle.trim();
            if (!title) {
              showToast(t("settings.vaultNameRequiredToast"));
              return;
            }
            const payload: Record<string, any> = {
              category: vaultCat,
              title,
              subtitle: vaultSub.trim(),
            };
            if (vaultSecretSupported) {
              if (editingVaultId) {
                if (vaultPasswordTouched) {
                  payload.password = vaultPassword;
                }
              } else if (vaultPassword) {
                payload.password = vaultPassword;
              }
            }
            if (editingVaultId) {
              await apiJson(`/api/vault/${encodeURIComponent(editingVaultId)}`, {
                method: "PATCH",
                body: JSON.stringify(payload),
              });
            } else {
              await apiJson("/api/vault", {
                method: "POST",
                body: JSON.stringify(payload),
              });
            }
            setVaultTitle("");
            setVaultSub("");
            setVaultPassword("");
            setVaultPasswordTouched(false);
            setVaultHasPassword(false);
            setVaultPasswordVisible(false);
            setEditingVaultId(null);
            setVaultFormOpen(false);
            refreshVault();
            showToast(editingVaultId ? t("settings.vaultUpdatedToast") : t("settings.vaultSavedToast"));
          }}
        >
          {t("settings.vaultSaveBtn")}
        </button>
      </div>
    </div>
  );

  const renderRuleInlineEditor = (kind: "ask" | "allow", rule: any) => (
    <div className="custom-skill-editor settings-inline-editor is-inline-row-editor">
      <div className="custom-skill-fields">
        <div className="custom-skill-row-two">
          <label className="field-group custom-skill-name-field">
            <span>{t("settings.permTargetToolLabel")}</span>
            <select
              value={editRuleTool}
              onChange={(e) => setEditRuleTool(e.target.value)}
            >
              {permissionRuleTools.map(([val, label]) => (
                <option key={val} value={val}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-group custom-skill-slug-field">
            <span>{t("settings.permPatternLabel")}</span>
            <input
              type="text"
              placeholder={kind === "ask" ? t("settings.permAskPatternPh") : t("settings.permAllowPatternPh")}
              value={editRulePattern}
              onChange={(e) => setEditRulePattern(e.target.value)}
            />
          </label>
        </div>
      </div>
      <div className="inline-form-actions">
        <button
          type="button"
          className="skill-pill-btn"
          onClick={() => setEditingRuleKey(null)}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="skill-pill-btn is-primary"
          onClick={async () => {
            const pat = editRulePattern.trim();
            const listKey = kind === "ask" ? "askRules" : "allowRules";
            const srcList = kind === "ask" ? askRules : allowRules;
            const nextList = srcList.map((x: any) =>
              x.id === rule.id
                ? {
                    ...x,
                    tool: editRuleTool,
                    pattern: pat,
                    label: `${editRuleTool} ${pat}`.trim(),
                  }
                : x
            );
            try {
              await commitSettingsPatch({ policy: { [listKey]: nextList } });
              setEditingRuleKey(null);
              showToast(t("settings.permRuleUpdatedToast"));
            } catch (err: any) {
              showToast(t("settings.permRuleUpdateFailedToast", { error: err?.message || t("actions.requestError") }));
            }
          }}
        >
          {t("settings.permSaveRuleBtn")}
        </button>
      </div>
    </div>
  );

  return (
    <div
      id="settings-modal-backdrop"
      className="modal-backdrop"
      hidden={!settingsModal.open}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSettingsModal();
      }}
    >
      <div
        className={`settings-modal${isStandalone ? " is-standalone-pane" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.modalAria")}
      >
        <button
          id="close-settings-modal-btn"
          type="button"
          className="modal-close-btn"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={closeSettingsModal}
        >
          <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M5.5 5.5L14.5 14.5M14.5 5.5L5.5 14.5"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </button>

        {edgePullHint && !isStandalone && (
          <div
            className={`settings-edge-hint ${edgePullHint.dir > 0 ? "is-bottom" : "is-top"}`}
            aria-hidden="true"
          >
            <div className="settings-edge-hint-pill">
              <span className="settings-edge-hint-arrow">
                {edgePullHint.dir > 0 ? "↓" : "↑"}
              </span>
              <span className="settings-edge-hint-text">
                {edgePullHint.dir > 0
                  ? t("settings.edgePullDown", { target: edgePullHint.targetLabel })
                  : t("settings.edgePullUp", { target: edgePullHint.targetLabel })}
              </span>
              <span className="settings-edge-hint-track">
                <span ref={edgeFillRef} className="settings-edge-hint-fill" />
              </span>
            </div>
          </div>
        )}

        <div className="settings-mobile-topbar">
          <button
            id="mobile-settings-modal-back-btn"
            type="button"
            className="mobile-circle-btn mobile-only"
            title={t("common.back")}
            aria-label={t("common.back")}
            onClick={closeSettingsModal}
          >
            <UiIcon name="chevron-left" />
          </button>
          <div className="settings-nav-wrap">
            <nav ref={settingsNavRef} className="settings-nav" role="tablist" aria-label={t("settings.navAria")}>
              {SETTINGS_TABS.map(([tabKey, iconName]) => (
                <button
                  key={tabKey}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tabKey}
                  tabIndex={activeTab === tabKey ? 0 : -1}
                  className={`settings-nav-item${activeTab === tabKey ? " is-active" : ""}`}
                  data-settings-tab={tabKey}
                  onClick={() => {
                    resetEdgePull();
                    pendingEdgeLandingRef.current = "top";
                    pendingEdgeAnimDirRef.current = 0;
                    if (activeTab === tabKey) {
                      const scroller = getActivePaneScroller();
                      if (scroller) scroller.scrollTop = 0;
                      return;
                    }
                    openSettingsModal(tabKey);
                  }}
                >
                  <span className="settings-nav-icon" aria-hidden="true">
                    <UiIcon name={iconName} />
                  </span>
                  <span>{settingsTabLabels[tabKey] || tabKey}</span>
                  {tabKey === "updates" && hasVisibleUpdate && (
                    <span className="settings-nav-update-dot" aria-label={t("settings.updateDotAria")} />
                  )}
                </button>
              ))}
            </nav>
          </div>
        </div>

        <div
          className={`settings-content${activeTab === "usage" ? " is-usage-pane-active" : ""}`}
          ref={(node) => {
            settingsContentRef.current = node;
            bindScrollEndTracking(node);
          }}
          onScrollCapture={handleContentScrollCapture}
          onWheel={handleContentWheel}
          onTouchStart={handleContentTouchStart}
          onTouchMove={handleContentTouchMove}
          onTouchEnd={handleContentTouchEnd}
          onTouchCancel={handleContentTouchEnd}
        >
          <NetworkStatusBanner
            placement="modal"
            contextHint={t("settings.remoteOfflineReadonlyHint")}
            onlyWhenOffline
          />

          {/* ==================== PANE 1: 通用 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="general"
            hidden={activeTab !== "general"}
          >
            <h2 className="settings-pane-title">{t("settings.tabGeneral")}</h2>

            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="profile"
              disabled={remoteAccountOffline}
            >
            <div className="settings-group-label">{t("settings.profileGroupTitle")}</div>
            <div className="settings-card">
              <div className="settings-account-row">
                <div className="settings-account-left">
                  <span
                    id="settings-profile-avatar"
                    className="user-avatar-circle lg"
                    data-profile-color={profileColor}
                  >
                    {profileInitial}
                  </span>
                  <div className="profile-edit-stack">
                    <div className="profile-name-edit-row">
                      <input
                        id="profile-name-input"
                        type="text"
                        className="inline-text-input profile-name-input"
                        maxLength={32}
                        placeholder={t("settings.profileNamePh")}
                        aria-label={t("settings.profileNameAria")}
                        value={profileNameInput}
                        onChange={(e) => setProfileNameInput(e.target.value)}
                        onCompositionEnd={(e) => {
                          profileCompEndRef.current = e.timeStamp;
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !isImeConfirmEnter(e, profileCompEndRef.current)) {
                            e.preventDefault();
                            handleSaveProfile();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="settings-blue-pill"
                        id="save-profile-btn"
                        onClick={handleSaveProfile}
                      >
                        {t("settings.profileSaveBtn")}
                      </button>
                    </div>
                    <div
                      className="profile-color-swatches"
                      id="profile-color-swatches"
                      role="group"
                      aria-label={t("settings.profileColorAria")}
                    >
                      {getProfileColors(currentLocale).map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          className={`profile-color-dot${profileColor === c.key ? " is-active" : ""}`}
                          data-profile-color={c.key}
                          title={c.label}
                          aria-label={c.label}
                          onClick={async () => {
                            const curName = profileNameInput.trim() || profileName;
                            try {
                              await commitSettingsPatch({
                                profile: { name: curName, color: c.key },
                              });
                              showToast(t("settings.profileColorUpdatedToast"));
                            } catch (err: any) {
                              showToast(t("settings.profileColorFailedToast", { error: err?.message || t("actions.requestError") }));
                            }
                          }}
                        />
                      ))}
                    </div>
                    <div className="settings-row-sub" id="profile-api-status-sub">
                      {diagnostics
                        ? t("settings.profileApiStatusLine", {
                            env: diagEnvLabel,
                            version: diagnostics.appVersion || "1.0.0",
                            state: diagLlmReady
                              ? t("settings.profileRoutingReady")
                              : t("settings.profileRoutingMissing"),
                          })
                        : t("settings.profileApiStatusDefault")}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </fieldset>

            <div className="settings-group-label">{t("settings.generalGroupAppearance")}</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("lang.label")}</div>
                  <div className="settings-row-sub">{t("lang.desc")}</div>
                </div>
                <select
                  id="setting-language-select"
                  className="settings-select"
                  aria-label={t("lang.label")}
                  value={currentLanguage}
                  onChange={(e) => applyLanguagePreference(e.target.value, true)}
                >
                  <option value="system">{t("lang.system")}</option>
                  <option value="zh-CN">{t("lang.zhCN")}</option>
                  <option value="en">{t("lang.en")}</option>
                </select>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <span className="settings-row-title">{t("theme.label")}</span>
                <select
                  id="setting-theme-select"
                  className="settings-select"
                  aria-label={t("theme.label")}
                  value={settings?.theme || "system"}
                  onChange={(e) => applyThemePreference(e.target.value, true)}
                >
                  <option value="system">{t("theme.system")}</option>
                  <option value="light">{t("theme.light")}</option>
                  <option value="dark">{t("theme.dark")}</option>
                </select>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <span className="settings-row-title">{t("accent.label")}</span>
                <select
                  id="setting-accent-mode"
                  className="settings-select"
                  aria-label={t("accent.label")}
                  value={settings?.accentMode || "bot"}
                  onChange={async (e) => {
                    const accentMode = e.target.value;
                    setState((prev) => ({
                      settings: { ...prev.settings, accentMode },
                    }));
                    syncDerivedAccent();
                    await commitSettingsPatch({ accentMode }, { silentError: true });
                  }}
                >
                  <option value="bot">{t("accent.bot")}</option>
                  <option value="default">{t("accent.custom")}</option>
                </select>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <span className="settings-row-title">{t("settings.spellcheckTitle")}</span>
                <label className="ios-switch" aria-label={t("settings.spellcheckTitle")}>
                  <input
                    id="setting-spellcheck-toggle"
                    type="checkbox"
                    checked={spellcheckEnabled}
                    onChange={(e) => setSpellcheckPreference(e.target.checked)}
                  />
                  <span className="ios-switch-track" />
                </label>
              </div>
            </div>

            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="general-remote"
              disabled={remoteAccountOffline}
            >
            <div className="settings-group-label">{t("settings.smartRoutingGroup")}</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.smartRouterToggleTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.smartRouterToggleDesc")}
                  </div>
                </div>
                <label className="ios-switch" aria-label={t("settings.smartRouterToggleTitle")}>
                  <input
                    id="setting-smart-router-toggle"
                    type="checkbox"
                    checked={routing.smartRouter !== false}
                    onChange={async (e) => {
                      const nextRouting = { ...routing, smartRouter: e.target.checked };
                      try {
                        await commitSettingsPatch({ routing: nextRouting });
                      } catch (err: any) {
                        showToast(t("settings.routingSaveFailed", { error: err?.message || t("actions.requestError") }));
                      }
                    }}
                  />
                  <span className="ios-switch-track" />
                </label>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.routingModeTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.routingModeDesc")}
                  </div>
                </div>
                <select
                  id="setting-routing-mode"
                  className="settings-select"
                  aria-label={t("settings.routingModeTitle")}
                  disabled={routing.smartRouter === false}
                  value={routing.mode || "balanced"}
                  onChange={async (e) => {
                    const nextRouting = { ...routing, mode: e.target.value };
                    try {
                      await commitSettingsPatch({ routing: nextRouting });
                    } catch (err: any) {
                      showToast(t("settings.routingModeSaveFailed", { error: err?.message || t("actions.requestError") }));
                    }
                  }}
                >
                  <option value="economy">{t("settings.routingModeEconomy")}</option>
                  <option value="balanced">{t("settings.routingModeBalanced")}</option>
                  <option value="quality">{t("settings.routingModeQuality")}</option>
                </select>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.turnBudgetTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.turnBudgetDesc")}
                  </div>
                </div>
                <input
                  id="setting-routing-budget"
                  type="number"
                  className="settings-number-input"
                  min="0.35"
                  max="72.5"
                  step="0.35"
                  disabled={routing.smartRouter === false}
                  value={budgetInput}
                  aria-label={t("settings.turnBudgetAria")}
                  onChange={(e) => {
                    const v = e.target.value;
                    budgetInputRef.current = v;
                    budgetDirtyRef.current = true;
                    setBudgetInput(v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitBudget(e.currentTarget.value);
                    }
                  }}
                  onBlur={(e) => {
                    void commitBudget(e.currentTarget.value);
                  }}
                />
              </div>
            </div>

            <div className="settings-group-label">{t("settings.ctxCompressGroup")}</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.ctxCompressEnableTitle")}</div>
                  <div className="settings-row-sub" id="ctx-compress-summary-sub">
                    {!ctxEnabled
                      ? t("settings.ctxCompressDisabledSub")
                      : presetMeta
                        ? t("settings.ctxCompressPresetSub", { label: presetMeta.label, desc: presetMeta.desc })
                        : t("settings.ctxCompressCustomSub", { pct: ctxEffective.triggerPercent })}
                  </div>
                </div>
                <label className="ios-switch" aria-label={t("settings.ctxCompressEnableTitle")}>
                  <input
                    id="setting-ctx-compress-enabled"
                    type="checkbox"
                    checked={ctxEnabled}
                    onChange={(e) => {
                      ctxDraftRef.current.enabled = e.target.checked;
                      void saveCtxCompression({ enabled: e.target.checked });
                    }}
                  />
                  <span className="ios-switch-track" />
                </label>
              </div>

              <div
                id="ctx-compress-presets-wrap"
                className={`ctx-presets-wrap${!ctxEnabled ? " is-disabled" : ""}`}
              >
                <div className="ctx-presets-grid" role="group" aria-label={t("settings.ctxCompressPresetsAria")}>
                  {ctxPresets.map((pr) => (
                    <button
                      key={pr.id}
                      type="button"
                      className={`ctx-preset-card${
                        ctxEnabled && matchedPresetId === pr.id ? " is-active" : ""
                      }`}
                      data-ctx-preset={pr.id}
                      disabled={!ctxEnabled}
                      onClick={() => {
                        ctxDraftRef.current.enabled = true;
                        ctxDraftRef.current.triggerPercent = pr.values.triggerPercent;
                        ctxPercentDirtyRef.current = true;
                        setCtxPercentDraft(pr.values.triggerPercent);
                        void saveCtxCompression({
                          enabled: true,
                          triggerPercent: pr.values.triggerPercent,
                        });
                      }}
                    >
                      <div className="ctx-preset-head">
                        <span className="ctx-preset-name">{pr.label}</span>
                        {pr.badge && <span className="ctx-preset-badge">{pr.badge}</span>}
                      </div>
                      <div className="ctx-preset-desc">{pr.desc}</div>
                    </button>
                  ))}
                </div>

                <div className="ctx-percent-control">
                  <div className="ctx-percent-header">
                    <label className="ctx-adv-label" htmlFor="setting-ctx-compress-percent">
                      {t("settings.ctxCompressPercentLabel")}
                    </label>
                    <span className="ctx-percent-value" id="ctx-compress-percent-label">
                      {ctxEffective.triggerPercent}%
                    </span>
                  </div>
                  <input
                    id="setting-ctx-compress-percent"
                    name="ctxTriggerPercent"
                    type="range"
                    className="ctx-percent-slider"
                    min="30"
                    max="95"
                    step="5"
                    disabled={!ctxEnabled}
                    value={ctxEffective.triggerPercent}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      ctxDraftRef.current.triggerPercent = val;
                      ctxPercentDirtyRef.current = true;
                      setCtxPercentDraft(val);
                      if (ctxPercentTimerRef.current) clearTimeout(ctxPercentTimerRef.current);
                      ctxPercentTimerRef.current = setTimeout(() => {
                        ctxPercentTimerRef.current = null;
                        void saveCtxCompression(
                          { triggerPercent: ctxDraftRef.current.triggerPercent },
                          { skipIfUnchanged: true }
                        );
                      }, 220);
                    }}
                    onPointerUp={(e) => {
                      const val = Number(e.currentTarget.value);
                      ctxDraftRef.current.triggerPercent = val;
                      void saveCtxCompression({ triggerPercent: val }, { skipIfUnchanged: true });
                    }}
                    onMouseUp={(e) => {
                      const val = Number(e.currentTarget.value);
                      ctxDraftRef.current.triggerPercent = val;
                      void saveCtxCompression({ triggerPercent: val }, { skipIfUnchanged: true });
                    }}
                    onTouchEnd={(e) => {
                      const val = Number(e.currentTarget.value);
                      ctxDraftRef.current.triggerPercent = val;
                      void saveCtxCompression({ triggerPercent: val }, { skipIfUnchanged: true });
                    }}
                    onKeyUp={(e) => {
                      const val = Number(e.currentTarget.value);
                      ctxDraftRef.current.triggerPercent = val;
                      void saveCtxCompression({ triggerPercent: val }, { skipIfUnchanged: true });
                    }}
                    onBlur={(e) => {
                      const val = Number(e.currentTarget.value);
                      ctxDraftRef.current.triggerPercent = val;
                      void saveCtxCompression({ triggerPercent: val }, { skipIfUnchanged: true });
                    }}
                  />
                  <div className="ctx-percent-scale" aria-hidden="true">
                    <span>{t("settings.ctxScaleMin")}</span>
                    <span>{t("settings.ctxScaleMax")}</span>
                  </div>
                </div>

                <details className="ctx-advanced-details" id="ctx-compress-advanced">
                  <summary className="ctx-advanced-summary">
                    <span>{t("settings.ctxAdvancedTitle")}</span>
                    <span
                      className="ctx-custom-pill"
                      id="ctx-compress-custom-badge"
                      hidden={!ctxEnabled || !ctxInstructionDraft.trim()}
                    >
                      {t("settings.ctxCustomBadge")}
                    </span>
                  </summary>
                  <div className="ctx-advanced-body">
                    <div className="ctx-adv-instruction">
                      <textarea
                        id="setting-ctx-compress-instruction"
                        name="ctxCustomInstruction"
                        className="inline-textarea"
                        rows={2}
                        maxLength={500}
                        placeholder={t("settings.ctxInstructionPh")}
                        aria-label={t("settings.ctxInstructionAria")}
                        disabled={!ctxEnabled}
                        value={ctxInstructionDraft}
                        onChange={(e) => {
                          const val = e.target.value;
                          ctxDraftRef.current.customInstruction = val;
                          ctxInstructionDirtyRef.current = true;
                          setCtxInstructionDraft(val);
                          if (ctxInstructionTimerRef.current) {
                            clearTimeout(ctxInstructionTimerRef.current);
                          }
                          ctxInstructionTimerRef.current = setTimeout(() => {
                            ctxInstructionTimerRef.current = null;
                            void saveCtxCompression(
                              { customInstruction: ctxDraftRef.current.customInstruction },
                              { skipIfUnchanged: true }
                            );
                          }, 450);
                        }}
                        onBlur={(e) => {
                          const val = e.currentTarget.value;
                          ctxDraftRef.current.customInstruction = val;
                          void saveCtxCompression(
                            { customInstruction: val },
                            { skipIfUnchanged: true }
                          );
                        }}
                      />
                    </div>
                  </div>
                </details>
              </div>
            </div>

            <div className="section-header-row" style={{ marginTop: "20px", marginBottom: "8px" }}>
              <div className="settings-group-label" style={{ margin: 0 }}>
                {t("settings.globalMemGroup")}
              </div>
              <button
                id="new-memory-btn"
                type="button"
                className="settings-blue-pill"
                onClick={() => openMemoryEditor(null)}
              >
                {t("settings.newMemoryBtn")}
              </button>
            </div>

            {(!memFormOpen || !editingMemId) && renderMemoryEditor(false, memFormOpen && !editingMemId)}

            <div id="global-memories-list" className="private-skills-list">
              {globalMemories.length === 0 ? (
                <div className="skills-empty">
                  {t("settings.globalMemEmpty")}
                </div>
              ) : (
                globalMemories.map((mem: any) => {
                  const memId = String(mem.id || mem.name);
                  const locMem = resolveLocalizedGlobalMemory(mem, currentLocale);
                  const memDisplayName = locMem.name || t("settings.memFallbackName");
                  const isEditingThisMem = memFormOpen && editingMemId === memId;
                  const deleteGlobalMemory = async () => {
                    const next = globalMemories.filter((x: any) => (x.id || x.name) !== memId);
                    try {
                      await commitSettingsPatch({ globalMemories: next, privateSkills: next });
                      setPendingDeleteMemId(null);
                      if (editingMemId === memId) {
                        setEditingMemId(null);
                        setMemFormOpen(false);
                      }
                      showToast(t("settings.memRemovedToast", { name: locMem.name }));
                    } catch (err: any) {
                      showToast(t("settings.memRemoveFailedToast", { error: err?.message || t("actions.requestError") }));
                    }
                  };

                  return (
                    <div
                      key={memId}
                      className={`private-skill-card${mem.enabled === false ? " is-disabled" : ""}${isEditingThisMem ? " is-editing" : ""}`}
                    >
                      <div className="private-skill-card-head">
                        <div className="custom-skill-card-left">
                          <div className="skill-row-icon" aria-hidden="true">
                            <UiIcon name="brain" size={19} />
                          </div>
                          <div className="skill-row-info">
                            <div className="skill-row-name">{memDisplayName}</div>
                            <div className="skill-row-desc">
                              {locMem.desc}
                            </div>
                          </div>
                        </div>
                        <div className="private-skill-card-actions">
                          <label className="ios-switch">
                            <input
                              type="checkbox"
                              checked={mem.enabled !== false}
                              aria-label={t("settings.memToggleAria", { name: locMem.name })}
                              onChange={async (e) => {
                                const next = globalMemories.map((x: any) =>
                                  (x.id || x.name) === memId
                                    ? { ...x, enabled: e.target.checked }
                                    : x
                                );
                                try {
                                  await commitSettingsPatch({
                                    globalMemories: next,
                                    privateSkills: next,
                                  });
                                } catch (err: any) {
                                  showToast(t("settings.memToggleFailedToast", { error: err?.message || t("actions.requestError") }));
                                }
                              }}
                            />
                            <span className="ios-switch-track" />
                          </label>
                          <button
                            type="button"
                            className={`skill-pill-btn${isEditingThisMem ? " is-active" : ""}`}
                            aria-expanded={isEditingThisMem}
                            onClick={() => openMemoryEditor(mem)}
                          >
                            {isEditingThisMem ? t("common.collapse") : t("settings.viewEditBtn")}
                          </button>
                          <button
                            type="button"
                            className="skill-pill-btn is-danger-text"
                            onClick={async () => {
                              if (isMobileViewport()) {
                                const ok = await showConfirmDialog({
                                  title: t("settings.memDeleteTitle"),
                                  message: t("settings.memDeleteMsg", { name: memDisplayName }),
                                  detail: t("settings.memDeleteDetail"),
                                  confirmText: t("common.confirmDelete"),
                                  cancelText: t("common.cancel"),
                                  tone: "danger",
                                });
                                if (ok) await deleteGlobalMemory();
                                return;
                              }
                              setPendingDeleteMemId((prev) =>
                                prev === memId ? null : memId
                              );
                            }}
                          >
                            {t("common.delete")}
                          </button>
                        </div>
                      </div>

                      {isEditingThisMem && renderMemoryEditor(true, true)}

                      {pendingDeleteMemId === memId && (
                        <div className="skill-remove-confirm">
                          <div className="skill-remove-text">
                            {t("settings.memDeleteInlineText", { name: memDisplayName })}
                          </div>
                          <div className="skill-remove-actions">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteMemId(null)}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={deleteGlobalMemory}
                            >
                              {t("common.confirmDelete")}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            </fieldset>
          </div>

          {/* ==================== PANE 2: 模型接入与路由 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="models"
            hidden={activeTab !== "models"}
          >
            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="models"
              disabled={remoteAccountOffline}
            >
            <div className="vault-header-row">
              <h2 className="settings-pane-title">{t("settings.tabModels")}</h2>
              <button
                id="add-provider-btn"
                type="button"
                className="settings-blue-pill"
                onClick={() => openProviderEditor(null)}
              >
                {t("settings.addProviderBtn")}
              </button>
            </div>

            <div className="settings-group-label">{t("settings.tiersGroupTitle")}</div>
            <div className="settings-card">
              {(
                [
                  ["fast", "tier-fast-select", t("settings.tierFastTitle"), t("settings.tierFastDesc"), t("settings.tierFastAria")],
                  ["medium", "tier-medium-select", t("settings.tierMediumTitle"), t("settings.tierMediumDesc"), t("settings.tierMediumAria")],
                  ["advanced", "tier-advanced-select", t("settings.tierAdvTitle"), t("settings.tierAdvDesc"), t("settings.tierAdvAria")],
                ] as const
              ).map(([tKey, selId, title, sub, aria], idx) => (
                <Fragment key={tKey}>
                  {idx > 0 && <div className="settings-divider" />}
                  <div className="settings-item-row">
                    <div>
                      <div className="settings-row-title">{title}</div>
                      <div className="settings-row-sub">{sub}</div>
                    </div>
                    <select
                      id={selId}
                      className="settings-select tier-select"
                      aria-label={aria}
                      value={resolveTierSelectVal(tKey, textModelOptions, false)}
                      onChange={(e) => handleTierChange(tKey, e.target.value)}
                    >
                      {textModelOptions.length === 0 ? (
                        <option value="">{t("settings.tierNoModelOpt")}</option>
                      ) : (
                        textModelOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                </Fragment>
              ))}

              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.tierImageTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.tierImageDesc")}
                  </div>
                </div>
                <select
                  id="tier-image-select"
                  className="settings-select tier-select"
                  aria-label={t("settings.tierImageAria")}
                  value={resolveTierSelectVal("image", imageModelOptions, true)}
                  onChange={(e) => handleTierChange("image", e.target.value)}
                >
                  <option value="">{t("settings.tierImageUnsetOpt")}</option>
                  {imageModelOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="settings-group-label">
              {t("settings.providersGroupTitle")}
            </div>

            {(!provFormOpen || !provId) && renderProviderEditor(false, provFormOpen && !provId)}

            <div id="providers-list" className="providers-list">
              {providers.length === 0 ? (
                <div className="skills-empty">
                  {t("settings.providersEmpty")}
                </div>
              ) : (
                providers.map((p: any) => {
                  const isEditingThisProv = provFormOpen && provId === p.id;
                  const billingCurr =
                    p.billingCurrency || (p.type === "deepseek" ? "CNY" : "USD");
                  const modelsText = (p.models || []).join(" · ") || t("settings.provNoLlm");
                  const imgText =
                    Array.isArray(p.imageModels) && p.imageModels.length > 0
                      ? t("settings.provImgPrefix", { list: p.imageModels.join(" · ") })
                      : "";
                  const isGcpVertex = p.authMode === "gcp-vertex";
                  const endpointMeta = isGcpVertex
                    ? p.gcpVertexLabel || "GCP Vertex AI"
                    : p.baseUrl;

                  const executeDeleteProvider = async () => {
                    try {
                      const res = await apiJson(
                        `/api/providers/${encodeURIComponent(p.id)}`,
                        { method: "DELETE" }
                      );
                      setPendingDeleteProviderId(null);
                      if (provId === p.id) {
                        setProvFormOpen(false);
                        setProvId("");
                      }
                      await refreshSettingsFromServer();
                      refreshUsageAndHealth();
                      refreshSystemDiagnostics(false);
                      showToast(
                        res.autoAssignedTiers
                          ? t("settings.provRemovedAutoTiersToast", { name: p.name })
                          : t("settings.provRemovedToast", { name: p.name })
                      );
                    } catch (err: any) {
                      showToast(t("settings.provDeleteFailedToast", { error: err.message }));
                    }
                  };

                  return (
                    <div
                      key={p.id}
                      className={`provider-card${p.enabled === false ? " is-disabled" : ""}${isEditingThisProv ? " is-editing" : ""}`}
                    >
                      <div className="provider-card-head">
                        <div className="provider-card-title-row">
                          <strong>{p.name || p.type}</strong>
                          <span className="provider-type-badge">{p.type}</span>
                          <span className="provider-type-badge">
                            {billingCurr === "CNY" ? "CNY ¥" : "USD→¥"}
                          </span>
                          {isGcpVertex ? (
                            <span className="provider-type-badge is-gcp-vertex">
                              GCP Vertex AI (ADC)
                            </span>
                          ) : (
                            <span className="provider-type-badge">
                              {p.hasApiKey
                                ? t("settings.provKeySetBadge", { mask: p.maskedApiKey || t("settings.provKeyConfiguredFallback") })
                                : t("settings.provKeyMissingBadge")}
                            </span>
                          )}
                          {p.enabled === false && (
                            <span className="provider-type-badge">{t("settings.provDisabledBadge")}</span>
                          )}
                        </div>
                        <div className="provider-card-actions">
                          <label
                            className="ios-switch"
                            title={
                              p.enabled !== false
                                ? t("settings.provEnabledSwitchTitle")
                                : t("settings.provDisabledSwitchTitle")
                            }
                          >
                            <input
                              type="checkbox"
                              checked={p.enabled !== false}
                              aria-label={t("settings.provToggleAria", { name: p.name || p.type })}
                              onChange={async (e) => {
                                const checked = e.target.checked;
                                try {
                                  const res = await apiJson(
                                    `/api/providers/${encodeURIComponent(p.id)}`,
                                    {
                                      method: "PATCH",
                                      body: JSON.stringify({ enabled: checked }),
                                    }
                                  );
                                  await refreshSettingsFromServer();
                                  refreshUsageAndHealth();
                                  refreshSystemDiagnostics(false);
                                  showToast(
                                    res.autoAssignedTiers
                                      ? t(checked ? "settings.provEnabledAutoTiersToast" : "settings.provDisabledAutoTiersToast", {
                                          name: p.name || p.type,
                                        })
                                      : t(checked ? "settings.provEnabledToast" : "settings.provDisabledToast", {
                                          name: p.name || p.type,
                                        })
                                  );
                                } catch (err: any) {
                                  showToast(t("settings.provStatusFailedToast", { error: err.message }));
                                }
                              }}
                            />
                            <span className="ios-switch-track" />
                          </label>
                          <button
                            type="button"
                            className={`skill-pill-btn${isEditingThisProv ? " is-active" : ""}`}
                            aria-expanded={isEditingThisProv}
                            onClick={() => openProviderEditor(p)}
                          >
                            {isEditingThisProv ? t("common.collapse") : t("settings.viewEditBtn")}
                          </button>
                          <button
                            type="button"
                            className="skill-pill-btn"
                            disabled={testingProviderId === p.id}
                            onClick={async () => {
                              setTestingProviderId(p.id);
                              try {
                                const res = await apiJson("/api/providers/test", {
                                  method: "POST",
                                  body: JSON.stringify({
                                    id: p.id,
                                    type: p.type,
                                    baseUrl: p.baseUrl,
                                    model: p.models?.[0],
                                  }),
                                });
                                showToast(
                                  res.ok
                                    ? t("settings.provPingOkToast", { name: p.name, ms: res.latencyMs })
                                    : t("settings.provPingFailToast", { error: res.error })
                                );
                              } catch (err: any) {
                                showToast(t("settings.provTestFailedToast", { error: err.message }));
                              } finally {
                                setTestingProviderId(null);
                              }
                            }}
                          >
                            {testingProviderId === p.id ? t("settings.provTestingShort") : t("settings.provSpeedTestBtn")}
                          </button>
                          <button
                            type="button"
                            className="skill-pill-btn is-danger-text"
                            onClick={async () => {
                              if (isMobileViewport()) {
                                const ok = await showConfirmDialog({
                                  title: t("settings.provDeleteTitle"),
                                  message: t("settings.provDeleteMsg", { name: p.name }),
                                  detail: t("settings.provDeleteDetail"),
                                  confirmText: t("common.confirmDelete"),
                                  cancelText: t("common.cancel"),
                                  tone: "danger",
                                });
                                if (ok) await executeDeleteProvider();
                                return;
                              }
                              setPendingDeleteProviderId((prev) =>
                                prev === p.id ? null : p.id
                              );
                            }}
                          >
                            {t("common.delete")}
                          </button>
                        </div>
                      </div>
                      <div className="provider-card-meta">
                        {[endpointMeta, modelsText, imgText]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>

                      {isEditingThisProv && renderProviderEditor(true, true)}

                      {pendingDeleteProviderId === p.id && (
                        <div className="skill-remove-confirm">
                          <div className="skill-remove-text">
                            {t("settings.provDeleteInlineText", { name: p.name })}
                          </div>
                          <div className="skill-remove-actions">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteProviderId(null)}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={executeDeleteProvider}
                            >
                              {t("common.confirmDelete")}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            </fieldset>
          </div>

          {/* ==================== PANE 3: 电脑 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="computer"
            hidden={activeTab !== "computer"}
          >
            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="computer"
              disabled={remoteAccountOffline}
            >
            <h2 className="settings-pane-title">{t("settings.tabComputer")}</h2>

            <div className="settings-group-label">{t("settings.computerYourPc")}</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.computerHostExecTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.computerHostExecDesc")}
                  </div>
                </div>
                <select
                  id="host-exec-mode-select"
                  className="settings-select"
                  aria-label={t("settings.computerHostExecTitle")}
                  value={hostExecMode}
                  onChange={async (e) => {
                    const executionMode = e.target.value;
                    try {
                      await commitSettingsPatch({
                        hostComputer: { ...(settings?.hostComputer || {}), executionMode },
                      });
                    } catch (err: any) {
                      showToast(t("settings.hostExecSaveFailed", { error: err?.message || t("actions.requestError") }));
                    }
                  }}
                >
                  <option value="always">{t("settings.computerExecAlways")}</option>
                  <option value="ask">{t("settings.computerExecAsk")}</option>
                  <option value="off">{t("settings.computerExecOff")}</option>
                </select>
              </div>
            </div>

            {localBrowserSupported && (
              <>
                <div className="settings-group-label">{t("browser.sectionTitle")}</div>
                <div className="settings-card" id="browser-automation-settings-card">
                  <div className="settings-item-row">
                    <div>
                      <div className="settings-row-title">{t("browser.defaultModeTitle")}</div>
                      <div className="settings-row-sub">
                        {browserAutomationCfg.mode === "local_headless"
                          ? t("browser.descLocalHeadless")
                          : browserAutomationCfg.mode === "local_debug"
                            ? t("browser.descLocalDebug", {
                                port: browserAutomationCfg.debugPort,
                                profileDir:
                                  computerStatus?.localBrowser?.profileDir ||
                                  "data/chrome-debug-profile",
                              })
                            : t("browser.descBotComputer")}
                      </div>
                      {computerStatus?.localBrowser && (
                        <div
                          className="settings-row-sub"
                          id="local-browser-detect-status"
                          style={{ marginTop: "4px" }}
                        >
                          {computerStatus.localBrowser.available
                            ? t("browser.detectedReady", {
                                path: computerStatus.localBrowser.executablePath
                                  ? ` (${computerStatus.localBrowser.executablePath})`
                                  : "",
                                cdp: computerStatus.localBrowser.debugReachable
                                  ? ` · CDP :${computerStatus.localBrowser.debugPort}`
                                  : "",
                              })
                            : t("browser.detectedMissing")}
                        </div>
                      )}
                    </div>
                    <select
                      id="browser-automation-mode-select"
                      className="settings-select"
                      aria-label={t("browser.defaultModeTitle")}
                      value={browserAutomationCfg.mode}
                      onChange={async (e) => {
                        const mode = e.target.value;
                        try {
                          await commitSettingsPatch({
                            browserAutomation: {
                              ...browserAutomationCfg,
                              mode,
                            },
                          });
                          showToast(t("browser.modeUpdatedToast"));
                        } catch (err: any) {
                          showToast(`${err?.message || "Error"}`);
                        }
                      }}
                    >
                      <option value="bot_computer">{t("browser.modeBotComputer")}</option>
                      <option value="local_headless">{t("browser.modeLocalHeadless")}</option>
                      <option value="local_debug">{t("browser.modeLocalDebug")}</option>
                    </select>
                  </div>

                  {browserAutomationCfg.mode !== "bot_computer" && (
                    <>
                      <div className="settings-divider" />
                      <div className="settings-item-row" style={{ alignItems: "flex-end", gap: "10px" }}>
                        {browserAutomationCfg.mode === "local_debug" && (
                          <label style={{ display: "flex", flexDirection: "column", gap: "4px", width: "130px" }}>
                            <span className="settings-row-sub">{t("browser.debugPortLabel")}</span>
                            <input
                              id="browser-automation-debug-port"
                              type="number"
                              min={1024}
                              max={65535}
                              className="inline-text-input"
                              value={browserPortDraft}
                              onChange={(e) => setBrowserPortDraft(e.target.value)}
                            />
                          </label>
                        )}
                        <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 200px", minWidth: 0 }}>
                          <span className="settings-row-sub">{t("browser.execPathLabel")}</span>
                          <input
                            id="browser-automation-exec-path"
                            type="text"
                            className="inline-text-input"
                            placeholder={t("browser.execPathPlaceholder")}
                            value={browserExecDraft}
                            onChange={(e) => setBrowserExecDraft(e.target.value)}
                          />
                        </label>
                        <button
                          id="browser-automation-save-btn"
                          type="button"
                          className="settings-pill-btn"
                          onClick={async () => {
                            try {
                              const nextPort = normalizeBrowserDebugPort(browserPortDraft);
                              await commitSettingsPatch({
                                browserAutomation: {
                                  ...browserAutomationCfg,
                                  debugPort: nextPort,
                                  executablePath: browserExecDraft.trim(),
                                },
                              });
                              setBrowserPortDraft(String(nextPort));
                              showToast(t("browser.configSavedToast"));
                              void refreshComputerStatus();
                            } catch (err: any) {
                              showToast(`${err?.message || "Error"}`);
                            }
                          }}
                        >
                          {t("common.save")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}

            {onlineCloudHosts.length > 0 && (
              <>
                <div className="settings-group-label">{t("settings.computerRemoteHostsTitle")}</div>
                <div className="settings-card">
                  {onlineCloudHosts.map((h: any, idx: number) => (
                    <Fragment key={h.clientId}>
                      {idx > 0 && <div className="settings-divider" />}
                      <div className="settings-item-row">
                        <div>
                          <div className="settings-row-title">
                            {h.hostname || h.clientId}
                          </div>
                          <div className="settings-row-sub">
                            {h.platform || "Host"} · {h.arch || ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={
                            selectedCloudHostId === h.clientId
                              ? "settings-blue-pill"
                              : "settings-pill-btn"
                          }
                          onClick={async () => {
                            const res = await apiJson("/api/computer/hosts/select", {
                              method: "POST",
                              body: JSON.stringify({ clientId: h.clientId }),
                            });
                            setState({
                              selectedCloudHostId: res.selectedHostId || h.clientId,
                            });
                            showToast(t("settings.computerHostSwitchedToast"));
                          }}
                        >
                          {selectedCloudHostId === h.clientId
                            ? t("settings.computerHostSelectedBtn")
                            : t("settings.computerHostSelectBtn")}
                        </button>
                      </div>
                    </Fragment>
                  ))}
                </div>
              </>
            )}

            <div className="settings-group-label">{t("settings.computerDevicesTitle")}</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div className="settings-account-left">
                  <span className="device-icon" aria-hidden="true">
                    <UiIcon name="laptop" />
                  </span>
                  <div>
                    <div className="settings-row-title" id="host-device-hostname">
                      {computerStatus?.hostComputer?.hostname || t("settings.computerLocalHostFallback")}
                    </div>
                    <div className="settings-row-sub" id="host-device-status-line">
                      <span className="status-dot-inline is-ok" aria-hidden="true" />
                      <span>
                        {t("settings.computerHostOnlineLine", {
                          mode: hasCompProbe ? ` · ${hostModeLabel}` : "",
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div className="settings-account-left">
                  <span className="device-icon" aria-hidden="true">
                    <UiIcon name="linux-container" />
                  </span>
                  <div>
                    <div className="settings-row-title" id="computer-provider-title">
                      {computerStatus?.provider === "wsl"
                        ? "WSL Ubuntu XFCE (:1)"
                        : computerStatus?.provider === "cloud-linux"
                          ? "Cloud Ubuntu XFCE (:1)"
                          : "OrbStack Ubuntu XFCE (:1)"}
                    </div>
                    <div className="settings-row-sub" id="computer-health-line">
                      {detectingComputer || !hasCompProbe ? (
                        t("settings.computerCheckingExec")
                      ) : computerStatus?.online ? (
                        <>
                          <span className="status-dot-inline is-ok" aria-hidden="true" />
                          {t("settings.computerExecOnlineLine", {
                            ms: computerStatus.latencyMs ?? 0,
                            width: computerStatus.screen?.width || 1440,
                            height: computerStatus.screen?.height || 900,
                          })}
                        </>
                      ) : (
                        <>
                          <span className="status-dot-inline is-err" aria-hidden="true" />
                          {t("settings.computerExecOfflineLine", {
                            reason: compStatusView.settingsOfflineReason,
                          })}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-pill-btn"
                  id="settings-check-computer-btn"
                  disabled={detectingComputer}
                  onClick={async () => {
                    setDetectingComputer(true);
                    try {
                      const c = await refreshComputerStatus({ force: true, suppressLanOfflineModal: true });
                      void refreshSystemDiagnostics(false);
                      if (c?.online) {
                        showToast(t("settings.computerOnlineToast", { ms: c.latencyMs ?? 0 }));
                      } else if (c) {
                        showToast(
                          t("settings.computerOfflineToast", {
                            error: c.error || c.detail || t("settings.computerExecNoResponse"),
                          })
                        );
                      } else {
                        showToast(t("settings.computerCheckFailedToast"));
                      }
                    } finally {
                      setDetectingComputer(false);
                    }
                  }}
                >
                  {detectingComputer ? t("settings.computerCheckingBtn") : t("settings.computerRecheckBtn")}
                </button>
              </div>
            </div>

            <div className="settings-group-label">{t("settings.computerBotPcGroup")}</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.computerUpdateTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.computerUpdateDesc")}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-pill-btn"
                  id="settings-update-computer-btn"
                  disabled={updatingComputer}
                  onClick={async () => {
                    setUpdatingComputer(true);
                    try {
                      await updateBotComputerComponents();
                      showToast(t("settings.computerUpdatedToast"));
                    } catch (err: any) {
                      showToast(
                        t("settings.computerUpdateFailedToast", {
                          error: err.message || t("settings.computerExecConnectFail"),
                        })
                      );
                    } finally {
                      setUpdatingComputer(false);
                    }
                  }}
                >
                  {updatingComputer ? t("settings.computerUpdatingBtn") : t("settings.computerUpdateBtn")}
                </button>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.computerResetTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.computerResetDesc")}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-red-btn"
                  id="settings-reset-computer-btn"
                  disabled={resettingComputer}
                  onClick={async () => {
                    setResettingComputer(true);
                    try {
                      const { res, latest } = await resetBotComputerConnection();
                      const isOnline = latest ? Boolean(latest.online) : res?.online !== false;
                      if (isOnline) {
                        showToast(t("settings.computerResetOkToast"));
                      } else {
                        showToast(
                          t("settings.computerResetOfflineToast", {
                            error: latest?.error || res?.status?.error || t("settings.computerExecNoResponse"),
                          })
                        );
                      }
                    } catch (err: any) {
                      showToast(
                        t("settings.computerResetFailedToast", {
                          error: err?.message || t("settings.computerResetCantFail"),
                        })
                      );
                    } finally {
                      setResettingComputer(false);
                    }
                  }}
                >
                  {resettingComputer ? t("settings.computerResettingBtn") : t("settings.computerResetBtn")}
                </button>
              </div>
              {multiDisplaySupported && (
                <>
                  <div className="settings-divider" />
                  <div className="settings-item-block" id="settings-screen-pool-block">
                    <div className="settings-item-row" style={{ padding: 0 }}>
                      <div>
                        <div className="settings-row-title">{t("settings.screenPoolTitle")}</div>
                        <div className="settings-row-sub">
                          {t("settings.screenPoolDesc")}
                          {computerDisplays?.pool
                            ? t("settings.screenPoolActiveMeta", {
                                active: computerDisplays.pool.activeCount,
                                max: computerDisplays.pool.maxConcurrentScreens,
                                queued:
                                  computerDisplays.pool.queuedCount > 0
                                    ? t("settings.screenPoolQueuedMeta", { count: computerDisplays.pool.queuedCount })
                                    : "",
                              })
                            : ""}
                        </div>
                      </div>
                      <span className="ctx-percent-value" id="screen-pool-limit-label">
                        {t("settings.screenPoolLimitLabel", { n: screenPoolEffective.maxConcurrentScreens })}
                      </span>
                    </div>

                    <div className="ctx-presets-grid">
                      {[
                        {
                          id: "min" as const,
                          name: t("settings.screenPresetMin"),
                          desc: t("settings.screenPresetMinDesc", { n: screenBudget.min }),
                          mode: "custom" as const,
                          val: screenBudget.min,
                        },
                        {
                          id: "balanced" as const,
                          name: t("settings.screenPresetBalanced"),
                          badge: t("settings.screenPresetDefaultBadge"),
                          desc: t("settings.screenPresetBalancedDesc", { n: screenBudget.defaultBalanced }),
                          mode: "auto" as const,
                          val: screenBudget.defaultBalanced,
                        },
                        {
                          id: "max" as const,
                          name: t("settings.screenPresetMax"),
                          desc: t("settings.screenPresetMaxDesc", {
                            n: screenBudget.max,
                            mem: screenBudget.totalMemGiB,
                            cores: screenBudget.cpuCores,
                          }),
                          mode: "custom" as const,
                          val: screenBudget.max,
                        },
                      ].map((pr) => (
                        <button
                          key={pr.id}
                          type="button"
                          className={`ctx-preset-card${
                            matchedScreenPreset === pr.id ? " is-active" : ""
                          }`}
                          data-screen-preset={pr.id}
                          onClick={() => {
                            screenMaxDraftRef.current = pr.val;
                            screenMaxDirtyRef.current = true;
                            setScreenMaxDraft(pr.val);
                            void saveScreenPool({
                              mode: pr.mode,
                              maxConcurrentScreens: pr.val,
                            });
                          }}
                        >
                          <div className="ctx-preset-head">
                            <span className="ctx-preset-name">{pr.name}</span>
                            {pr.badge && <span className="ctx-preset-badge">{pr.badge}</span>}
                          </div>
                          <div className="ctx-preset-desc">{pr.desc}</div>
                        </button>
                      ))}
                    </div>

                    <div className="ctx-percent-control">
                      <input
                        id="setting-max-concurrent-screens"
                        name="maxConcurrentScreens"
                        type="range"
                        className="ctx-percent-slider"
                        min={screenBudget.min}
                        max={screenBudget.max}
                        step={1}
                        value={screenPoolEffective.maxConcurrentScreens}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          screenMaxDraftRef.current = val;
                          screenMaxDirtyRef.current = true;
                          setScreenMaxDraft(val);
                          if (screenSaveTimerRef.current) clearTimeout(screenSaveTimerRef.current);
                          screenSaveTimerRef.current = setTimeout(() => {
                            screenSaveTimerRef.current = null;
                            const v = screenMaxDraftRef.current;
                            void saveScreenPool(
                              {
                                mode: v === screenBudget.defaultBalanced ? "auto" : "custom",
                                maxConcurrentScreens: v,
                              },
                              { skipIfUnchanged: true }
                            );
                          }, 220);
                        }}
                        onPointerUp={(e) => {
                          const val = Number(e.currentTarget.value);
                          screenMaxDraftRef.current = val;
                          void saveScreenPool(
                            {
                              mode: val === screenBudget.defaultBalanced ? "auto" : "custom",
                              maxConcurrentScreens: val,
                            },
                            { skipIfUnchanged: true }
                          );
                        }}
                        onMouseUp={(e) => {
                          const val = Number(e.currentTarget.value);
                          screenMaxDraftRef.current = val;
                          void saveScreenPool(
                            {
                              mode: val === screenBudget.defaultBalanced ? "auto" : "custom",
                              maxConcurrentScreens: val,
                            },
                            { skipIfUnchanged: true }
                          );
                        }}
                        onTouchEnd={(e) => {
                          const val = Number(e.currentTarget.value);
                          screenMaxDraftRef.current = val;
                          void saveScreenPool(
                            {
                              mode: val === screenBudget.defaultBalanced ? "auto" : "custom",
                              maxConcurrentScreens: val,
                            },
                            { skipIfUnchanged: true }
                          );
                        }}
                        onKeyUp={(e) => {
                          const val = Number(e.currentTarget.value);
                          screenMaxDraftRef.current = val;
                          void saveScreenPool(
                            {
                              mode: val === screenBudget.defaultBalanced ? "auto" : "custom",
                              maxConcurrentScreens: val,
                            },
                            { skipIfUnchanged: true }
                          );
                        }}
                        onBlur={(e) => {
                          const val = Number(e.currentTarget.value);
                          screenMaxDraftRef.current = val;
                          void saveScreenPool(
                            {
                              mode: val === screenBudget.defaultBalanced ? "auto" : "custom",
                              maxConcurrentScreens: val,
                            },
                            { skipIfUnchanged: true }
                          );
                        }}
                      />
                      <div className="ctx-percent-scale" aria-hidden="true">
                        <span>{t("settings.screenScaleMin", { n: screenBudget.min })}</span>
                        <span>{t("settings.screenScaleBalanced", { n: screenBudget.defaultBalanced })}</span>
                        <span>{t("settings.screenScaleMax", { n: screenBudget.max })}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
            </fieldset>
          </div>

          {/* ==================== PANE 4: 权限 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="permissions"
            hidden={activeTab !== "permissions"}
          >
            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="permissions"
              disabled={remoteAccountOffline}
            >
            <h2 className="settings-pane-title">{t("settings.tabPermissions")}</h2>

            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.permAutoAuditTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.permAutoAuditDesc")}
                  </div>
                </div>
                <label className="ios-switch" aria-label={t("settings.permAutoAuditAria")}>
                  <input
                    id="policy-auto-audit-toggle"
                    type="checkbox"
                    checked={policy.autoAudit !== false}
                    onChange={async (e) => {
                      try {
                        await commitSettingsPatch({
                          policy: { autoAudit: e.target.checked },
                        });
                      } catch (err: any) {
                        showToast(t("settings.permAutoAuditFailedToast", { error: err?.message || t("actions.requestError") }));
                      }
                    }}
                  />
                  <span className="ios-switch-track" />
                </label>
              </div>
            </div>

            <div className="settings-perm-block">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.permAlwaysAskTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.permAlwaysAskDesc")}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-pill-btn"
                  id="add-ask-rule-btn"
                  onClick={() => setAskFormOpen((v) => !v)}
                >
                  {t("settings.permAddRuleBtn")}
                </button>
              </div>

              <div
                id="ask-rule-form"
                className="custom-skill-editor settings-inline-editor"
                hidden={!askFormOpen}
              >
                <div className="custom-skill-editor-top">
                  <strong>{t("settings.permAddAskTitle")}</strong>
                </div>
                <div className="custom-skill-fields">
                  <div className="custom-skill-row-two">
                    <label className="field-group custom-skill-name-field">
                      <span>{t("settings.permTargetToolLabel")}</span>
                      <select
                        id="ask-rule-tool"
                        value={askTool}
                        onChange={(e) => setAskTool(e.target.value)}
                      >
                        {permissionRuleTools.map(([val, label]) => (
                          <option key={val} value={val}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-group custom-skill-slug-field">
                      <span>{t("settings.permPatternLabel")}</span>
                      <input
                        id="ask-rule-pattern"
                        type="text"
                        placeholder={t("settings.permAskPatternPh")}
                        value={askPattern}
                        onChange={(e) => setAskPattern(e.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <div className="inline-form-actions">
                  <button
                    type="button"
                    className="skill-pill-btn"
                    onClick={() => setAskFormOpen(false)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="skill-pill-btn is-primary"
                    id="save-ask-rule-btn"
                    onClick={async () => {
                      const pat = askPattern.trim();
                      const nextAskRules = [
                        ...askRules,
                        {
                          id: `ask-${Date.now()}`,
                          tool: askTool,
                          pattern: pat,
                          label: `${askTool} ${pat}`.trim(),
                        },
                      ];
                      try {
                        await commitSettingsPatch({ policy: { askRules: nextAskRules } });
                        setAskPattern("");
                        setAskFormOpen(false);
                        showToast(t("settings.permAskSavedToast"));
                      } catch (err: any) {
                        showToast(t("settings.permAskSaveFailedToast", { error: err?.message || t("actions.requestError") }));
                      }
                    }}
                  >
                    {t("settings.permSaveAskRuleBtn")}
                  </button>
                </div>
              </div>

              <div id="ask-rules-list" className="perm-rules-list">
                {askRules.map((rule: any) => {
                  const isEditingRule = editingRuleKey === `ask:${rule.id}`;
                  const removeAskRule = async () => {
                    const nextAskRules = askRules.filter((x: any) => x.id !== rule.id);
                    try {
                      await commitSettingsPatch({ policy: { askRules: nextAskRules } });
                      setPendingDeleteRuleId(null);
                      if (isEditingRule) setEditingRuleKey(null);
                    } catch (err: any) {
                      showToast(t("settings.permAskRemoveFailedToast", { error: err?.message || t("actions.requestError") }));
                    }
                  };
                  return (
                    <div
                      key={rule.id}
                      className={`perm-rule-chip${isEditingRule ? " is-editing" : ""}`}
                    >
                      <div className="perm-rule-chip-row">
                        <span>
                          <code>{rule.tool || "*"}</code> · {rule.pattern || t("settings.permAllParams")}
                        </span>
                        {pendingDeleteRuleId === rule.id ? (
                          <span className="perm-inline-confirm">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteRuleId(null)}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={removeAskRule}
                            >
                              {t("common.confirmRemove")}
                            </button>
                          </span>
                        ) : (
                          <span className="perm-rule-actions">
                            <button
                              type="button"
                              className="section-action-link"
                              aria-expanded={isEditingRule}
                              onClick={() => openRuleEditor("ask", rule)}
                            >
                              {isEditingRule ? t("common.collapse") : t("common.edit")}
                            </button>
                            <button
                              type="button"
                              className="section-action-link danger-text"
                              onClick={async () => {
                                if (isMobileViewport()) {
                                  const ok = await showConfirmDialog({
                                    title: t("settings.permRemoveTitle"),
                                    message: t("settings.permRemoveAskMsg"),
                                    detail: `${rule.tool || "*"} · ${rule.pattern || t("settings.permAllParams")}`,
                                    confirmText: t("common.confirmRemove"),
                                    cancelText: t("common.cancel"),
                                    tone: "danger",
                                  });
                                  if (ok) await removeAskRule();
                                  return;
                                }
                                setPendingDeleteRuleId(rule.id);
                              }}
                            >
                              {t("common.remove")}
                            </button>
                          </span>
                        )}
                      </div>
                      {isEditingRule && renderRuleInlineEditor("ask", rule)}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="settings-perm-block">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.permAlwaysAllowTitle")}</div>
                  <div className="settings-row-sub">
                    {t("settings.permAlwaysAllowDesc")}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-pill-btn"
                  id="add-allow-rule-btn"
                  onClick={() => setAllowFormOpen((v) => !v)}
                >
                  {t("settings.permAddRuleBtn")}
                </button>
              </div>

              <div
                id="allow-rule-form"
                className="custom-skill-editor settings-inline-editor"
                hidden={!allowFormOpen}
              >
                <div className="custom-skill-editor-top">
                  <strong>{t("settings.permAddAllowTitle")}</strong>
                </div>
                <div className="custom-skill-fields">
                  <div className="custom-skill-row-two">
                    <label className="field-group custom-skill-name-field">
                      <span>{t("settings.permTargetToolLabel")}</span>
                      <select
                        id="allow-rule-tool"
                        value={allowTool}
                        onChange={(e) => setAllowTool(e.target.value)}
                      >
                        {permissionRuleTools.map(([val, label]) => (
                          <option key={val} value={val}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-group custom-skill-slug-field">
                      <span>{t("settings.permPatternLabel")}</span>
                      <input
                        id="allow-rule-pattern"
                        type="text"
                        placeholder={t("settings.permAllowPatternPh")}
                        value={allowPattern}
                        onChange={(e) => setAllowPattern(e.target.value)}
                      />
                    </label>
                  </div>
                </div>
                <div className="inline-form-actions">
                  <button
                    type="button"
                    className="skill-pill-btn"
                    onClick={() => setAllowFormOpen(false)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="skill-pill-btn is-primary"
                    id="save-allow-rule-btn"
                    onClick={async () => {
                      const pat = allowPattern.trim();
                      const nextAllowRules = [
                        ...allowRules,
                        {
                          id: `allow-${Date.now()}`,
                          tool: allowTool,
                          pattern: pat,
                          label: `${allowTool} ${pat}`.trim(),
                        },
                      ];
                      try {
                        await commitSettingsPatch({ policy: { allowRules: nextAllowRules } });
                        setAllowPattern("");
                        setAllowFormOpen(false);
                        showToast(t("settings.permAllowSavedToast"));
                      } catch (err: any) {
                        showToast(t("settings.permAllowSaveFailedToast", { error: err?.message || t("actions.requestError") }));
                      }
                    }}
                  >
                    {t("settings.permSaveAllowRuleBtn")}
                  </button>
                </div>
              </div>

              <div id="allow-rules-list" className="perm-rules-list">
                {allowRules.map((rule: any) => {
                  const isEditingRule = editingRuleKey === `allow:${rule.id}`;
                  const removeAllowRule = async () => {
                    const nextAllowRules = allowRules.filter((x: any) => x.id !== rule.id);
                    try {
                      await commitSettingsPatch({ policy: { allowRules: nextAllowRules } });
                      setPendingDeleteRuleId(null);
                      if (isEditingRule) setEditingRuleKey(null);
                    } catch (err: any) {
                      showToast(t("settings.permAllowRemoveFailedToast", { error: err?.message || t("actions.requestError") }));
                    }
                  };
                  return (
                    <div
                      key={rule.id}
                      className={`perm-rule-chip${isEditingRule ? " is-editing" : ""}`}
                    >
                      <div className="perm-rule-chip-row">
                        <span>
                          <code>{rule.tool || "*"}</code> · {rule.pattern || t("settings.permAllParams")}
                        </span>
                        {pendingDeleteRuleId === rule.id ? (
                          <span className="perm-inline-confirm">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteRuleId(null)}
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={removeAllowRule}
                            >
                              {t("common.confirmRemove")}
                            </button>
                          </span>
                        ) : (
                          <span className="perm-rule-actions">
                            <button
                              type="button"
                              className="section-action-link"
                              aria-expanded={isEditingRule}
                              onClick={() => openRuleEditor("allow", rule)}
                            >
                              {isEditingRule ? t("common.collapse") : t("common.edit")}
                            </button>
                            <button
                              type="button"
                              className="section-action-link danger-text"
                              onClick={async () => {
                                if (isMobileViewport()) {
                                  const ok = await showConfirmDialog({
                                    title: t("settings.permRemoveTitle"),
                                    message: t("settings.permRemoveAllowMsg"),
                                    detail: `${rule.tool || "*"} · ${rule.pattern || t("settings.permAllParams")}`,
                                    confirmText: t("common.confirmRemove"),
                                    cancelText: t("common.cancel"),
                                    tone: "danger",
                                  });
                                  if (ok) await removeAllowRule();
                                  return;
                                }
                                setPendingDeleteRuleId(rule.id);
                              }}
                            >
                              {t("common.remove")}
                            </button>
                          </span>
                        )}
                      </div>
                      {isEditingRule && renderRuleInlineEditor("allow", rule)}
                    </div>
                  );
                })}
              </div>
            </div>
            </fieldset>
          </div>

          {/* ==================== PANE 5: 保险库 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="vault"
            hidden={activeTab !== "vault"}
          >
            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="vault"
              disabled={remoteAccountOffline}
            >
            <div className="vault-header-row">
              <h2 className="settings-pane-title">{t("settings.tabVault")}</h2>
              <button
                type="button"
                className="settings-blue-pill"
                id="vault-new-item-btn"
                onClick={() => openVaultEditor(null)}
              >
                {t("settings.vaultNewBtn")}
              </button>
            </div>

            <div className="vault-toolbar-row">
              <div className="vault-tabs" role="tablist" aria-label={t("settings.vaultTabsAria")}>
                {(
                  [
                    ["all", t("settings.vaultTabAll")],
                    ["login", t("settings.vaultTabLogin")],
                    ["contact", t("settings.vaultTabContact")],
                  ] as const
                ).map(([vKey, vLabel]) => (
                  <button
                    key={vKey}
                    type="button"
                    className={`vault-tab${vaultTab === vKey ? " is-active" : ""}`}
                    data-vault-tab={vKey}
                    onClick={() => setState({ vaultTab: vKey })}
                  >
                    {vLabel}
                  </button>
                ))}
              </div>
              <input
                id="vault-search-input"
                type="search"
                className="vault-search-input"
                placeholder={t("settings.vaultSearchPh")}
                aria-label={t("settings.vaultSearchAria")}
                value={vaultSearch}
                onChange={(e) => setState({ vaultSearch: e.target.value })}
              />
            </div>

            {(!vaultFormOpen || !editingVaultId) && renderVaultEditor(false, vaultFormOpen && !editingVaultId)}

            <div className="settings-card" id="vault-items-list">
              {filteredVault.length === 0 ? (
                <div className="settings-item-row">
                  <span className="settings-row-sub">{t("settings.vaultEmpty")}</span>
                </div>
              ) : (
                filteredVault.map((it: any, idx: number) => {
                  const isEditingThisVault = vaultFormOpen && editingVaultId === it.id;
                  const locItem = resolveLocalizedVaultItem(it, currentLocale);
                  const executeDeleteVault = async () => {
                    await apiJson(`/api/vault/${encodeURIComponent(it.id)}`, {
                      method: "DELETE",
                    });
                    setPendingDeleteVaultId(null);
                    if (editingVaultId === it.id) {
                      setEditingVaultId(null);
                      setVaultFormOpen(false);
                    }
                    refreshVault();
                    showToast(t("settings.vaultRemovedToast", { title: locItem.title || t("settings.vaultItemFallback") }));
                  };

                  return (
                    <Fragment key={it.id || idx}>
                      {idx > 0 && <div className="settings-divider" />}
                      <div className={`vault-item-block${isEditingThisVault ? " is-editing" : ""}`}>
                        <div className="settings-item-row">
                          <div className="settings-account-left">
                            <span className="vault-row-icon" aria-hidden="true">
                              <UiIcon
                                name={
                                  it.category === "login" ||
                                  it.category === "credential" ||
                                  it.category === "account" ||
                                  it.hasPassword
                                    ? "key"
                                    : "user"
                                }
                                size={15}
                              />
                            </span>
                            <div>
                              <div className="settings-row-title">
                                {locItem.title}
                                {it.hasPassword && (
                                  <span
                                    className="settings-row-sub"
                                    style={{ marginLeft: "6px", fontWeight: 500 }}
                                  >
                                    {t("settings.vaultHasEncryptedPasswordBadge")}
                                  </span>
                                )}
                              </div>
                              <div className="settings-row-sub">{locItem.subtitle || ""}</div>
                            </div>
                          </div>
                          <div className="private-skill-card-actions">
                            <button
                              type="button"
                              className={`skill-pill-btn${isEditingThisVault ? " is-active" : ""}`}
                              aria-expanded={isEditingThisVault}
                              onClick={() => openVaultEditor(it)}
                            >
                              {isEditingThisVault ? t("common.collapse") : t("settings.viewEditBtn")}
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger-text"
                              onClick={async () => {
                                if (isMobileViewport()) {
                                  const ok = await showConfirmDialog({
                                    title: t("settings.vaultRemoveTitle"),
                                    message: t("settings.vaultRemoveMsg", { title: locItem.title || t("settings.vaultThisItemFallback") }),
                                    detail:
                                      locItem.subtitle ||
                                      t("settings.vaultRemoveDetail"),
                                    confirmText: t("common.confirmRemove"),
                                    cancelText: t("common.cancel"),
                                    tone: "danger",
                                  });
                                  if (ok) await executeDeleteVault();
                                  return;
                                }
                                setPendingDeleteVaultId((prev) =>
                                  prev === it.id ? null : it.id
                                );
                              }}
                            >
                              {t("common.remove")}
                            </button>
                          </div>
                        </div>

                        {isEditingThisVault && renderVaultEditor(true, true)}

                        {pendingDeleteVaultId === it.id && (
                          <div className="skill-remove-confirm">
                            <div className="skill-remove-text">
                              {t("settings.vaultRemoveInlineText", { title: locItem.title || t("settings.vaultThisItemFallback") })}
                            </div>
                            <div className="skill-remove-actions">
                              <button
                                type="button"
                                className="skill-pill-btn"
                                onClick={() => setPendingDeleteVaultId(null)}
                              >
                                {t("common.cancel")}
                              </button>
                              <button
                                type="button"
                                className="skill-pill-btn is-danger"
                                onClick={executeDeleteVault}
                              >
                                {t("common.confirmRemove")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </Fragment>
                  );
                })
              )}
            </div>
            <p className="vault-footnote">
              {t("settings.vaultFootnote")}
            </p>
            </fieldset>
          </div>

          {/* ==================== PANE 6: 用量与账单 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="usage"
            hidden={activeTab !== "usage"}
          >
            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="usage"
              disabled={remoteAccountOffline}
            >
            <div className="vault-header-row">
              <h2 className="settings-pane-title" id="usage-pane-title">
                {isSessionScope
                  ? usageTraceActive
                    ? t("settings.usageSessionStepsTitle", { title: scopedSessionTitle })
                    : t("settings.usageSessionTitle", { title: scopedSessionTitle })
                  : t("settings.tabUsage")}
              </h2>
              <button
                type="button"
                className="settings-pill-btn usage-trace-link-btn"
                id="usage-open-trace-btn"
                hidden={!(isSessionScope && requestedSid === activeSessionId)}
                onClick={() => setState((prev) => ({ usageTraceActive: !prev.usageTraceActive }))}
              >
                {usageTraceActive ? (
                  <>
                    <UiIcon name="chevron-left" className="inline-ui-icon" size={13} />
                    {t("settings.usageBackToUsage")}
                  </>
                ) : (
                  <>
                    <span>
                      {stepCount > 0
                        ? t("settings.usageStepsWithCount", { count: stepCount })
                        : t("settings.usageStepsBtn")}
                    </span>
                    <UiIcon name="chevron-right" className="inline-ui-icon" size={13} />
                  </>
                )}
              </button>
            </div>

            <div id="usage-main-view" ref={bindScrollEndTracking} hidden={usageTraceActive}>
              <div className="settings-card usage-hero-card">
                <div className="usage-hero-top">
                  <div>
                    <div className="usage-label" id="usage-hero-label">
                      {isSessionScope
                        ? t("settings.usageHeroSessionLabel", { title: scopedSessionTitle })
                        : t("settings.usageHeroGlobalLabel")}
                    </div>
                    <div className="usage-big-stat">
                      <strong id="usage-total-tokens">{totalTok.toLocaleString()}</strong> tokens
                    </div>
                  </div>
                  <div className="usage-cost-hero-box">
                    <div className="usage-label">{t("settings.usageEstCostLabel")}</div>
                    <div className="usage-cost-primary" id="usage-total-cost-cny">
                      {formatCny(estCny)}
                    </div>
                  </div>
                </div>
                <div className="usage-progress-track" id="usage-stacked-track">
                  {nonZeroModels.length > 0 ? (
                    nonZeroModels.map((m: any) => (
                      <div
                        key={m.model}
                        className="usage-stacked-seg"
                        data-accent={m.accent || "blue"}
                        style={{ width: `${Math.max(2, Number(m.sharePct) || 0)}%` }}
                        title={`${m.label}: ${Number(m.totalTokens).toLocaleString()} tok (${m.sharePct}%) · ${formatCny(m.costCny)}`}
                      />
                    ))
                  ) : (
                    <div
                      className="usage-progress-fill"
                      id="usage-progress-fill"
                      style={{ width: `${Math.max(2, Number(usagePayload?.percentUsed) || 0)}%` }}
                    />
                  )}
                </div>
                <div className="usage-reset-sub" id="settings-token-summary">
                  {t("settings.usageTokenSummaryLine", {
                    input: (Number(usagePayload?.inputTokens) || 0).toLocaleString(),
                    output: (Number(usagePayload?.outputTokens) || 0).toLocaleString(),
                  })}
                  {extraSuffix}
                  {tailSuffix}
                </div>
              </div>

              <div className="settings-group-label">{t("settings.usageMergedGroupTitle")}</div>
              <div className="settings-card usage-merged-card" id="usage-merged-balance-card">
                <div className="usage-gcp-head">
                  <div className="usage-gcp-info">
                    <div className="usage-gcp-title-row">
                      <span className="settings-row-title">{t("settings.usageMergedTitle")}</span>
                      <span
                        className={`usage-gcp-badge${
                          !providerBilling
                            ? ""
                            : billingCards.length === 0
                              ? " is-warn"
                              : mergedBilling.hasAnyBalance
                                ? " is-ok"
                                : " is-warn"
                        }`}
                        id="usage-merged-status-badge"
                      >
                        {!providerBilling
                          ? t("settings.usageMergedLoadingBadge")
                          : billingCards.length === 0
                            ? t("settings.usageMergedEmptyBadge")
                            : mergedBilling.hasAnyBalance
                              ? t("settings.usageMergedCountBadge", {
                                  ok: mergedBilling.providersWithBalanceCount,
                                  total: mergedBilling.totalEnabledProviders,
                                })
                              : t("settings.usageMergedPendingBadge")}
                      </span>
                    </div>
                    <div className="usage-reset-sub" id="usage-merged-sub">
                      {!providerBilling
                        ? t("settings.usageMergedSubBase")
                        : billingCards.length === 0
                          ? t("settings.usageMergedSubNoProviders")
                          : `${t("settings.usageMergedSubBase")}${
                              mergedBilling.lastRefreshedAt
                                ? t("settings.usageMergedLastSyncPart", {
                                    time: formatBillingTime(mergedBilling.lastRefreshedAt, currentLocale),
                                  })
                                : ""
                            }`}
                    </div>
                    <div
                      className="usage-merged-tags"
                      id="usage-merged-provider-tags"
                      hidden={mergedTags.length === 0}
                    >
                      {mergedTags.map((tg: any) => (
                        <span key={tg.providerId || tg.providerName} className="usage-merged-tag">
                          {tg.providerName}: {formatCny(tg.remainingCny)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="usage-cost-hero-box">
                    <div className="usage-label">{t("settings.usageMergedAvailLabel")}</div>
                    <div className="usage-cost-primary" id="usage-merged-balance-cny">
                      {mergedBilling.hasAnyBalance
                        ? formatCny(mergedBilling.remainingCny)
                        : "—"}
                    </div>
                    <div className="usage-merged-actions">
                      <button
                        type="button"
                        className="settings-pill-btn"
                        id="usage-refresh-all-btn"
                        hidden={!mergedBilling.supportsAnyLiveRefresh}
                        disabled={refreshingAllBilling}
                        onClick={async () => {
                          setRefreshingAllBilling(true);
                          await refreshAllLiveProviderBalances();
                          setRefreshingAllBilling(false);
                        }}
                      >
                        {refreshingAllBilling
                          ? t("settings.usageRefreshingBtn")
                          : t("settings.usageRefreshAllBtn")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-group-label">{t("settings.usageByProviderGroupTitle")}</div>
              <div className="usage-provider-balance-list" id="usage-provider-balance-list">
                {providerBilling && billingCards.length === 0 ? (
                  <div className="settings-card usage-provider-card">
                    <div className="settings-row-sub">
                      {t("settings.usageNoEnabledProvidersDesc")}
                    </div>
                  </div>
                ) : (
                  billingCards.map((p: any) => {
                    const isBusy = Boolean(providerRefreshingIds[p.providerId]);
                    const isCalOpen = Boolean(providerOpenCalibrationIds[p.providerId]);
                    const statusClass = p.supportsLiveBalance
                      ? p.status === "live_error"
                        ? "is-err"
                        : p.status === "live_ok"
                          ? "is-ok"
                          : "is-warn"
                      : p.remainingCny !== null
                        ? "is-ok"
                        : "is-warn";
                    const statusLabel = p.supportsLiveBalance
                      ? p.status === "live_error"
                        ? t("settings.usageProvStatusError")
                        : p.status === "live_ok"
                          ? p.liveAvailable === false
                            ? t("settings.usageProvStatusLowBalance")
                            : t("settings.usageProvStatusLiveOk")
                          : t("settings.usageProvStatusLivePending")
                      : p.remainingCny !== null
                        ? p.remainingPct != null
                          ? t("settings.usageProvStatusSetPct", { pct: p.remainingPct })
                          : t("settings.usageProvStatusDeducting")
                        : t("settings.usageProvStatusUnset");

                    let metaText = "";
                    if (p.supportsLiveBalance) {
                      const subParts = [t("settings.usageProvLocalSpent", { amount: formatCny(p.spentCny) })];
                      if (p.grantedCny != null || p.toppedUpCny != null) {
                        subParts.push(
                          t("settings.usageProvGrantAndTopup", {
                            granted: formatCny(p.grantedCny || 0),
                            topup: formatCny(p.toppedUpCny || 0),
                          })
                        );
                      }
                      subParts.push(
                        t("settings.usageProvLastSync", {
                          time: formatBillingTime(p.lastRefreshedAt, currentLocale),
                        })
                      );
                      metaText = subParts.join(" · ");
                    } else if (p.remainingCny !== null) {
                      const calTime = formatBillingTime(p.calibratedAt, currentLocale);
                      const totalTag =
                        p.totalCreditsCny != null
                          ? t("settings.usageProvTotalCreditsPart", { amount: formatCny(p.totalCreditsCny) })
                          : "";
                      metaText = t("settings.usageProvCalibratedMeta", {
                        base: formatCny(p.baselineRemainingCny || 0),
                        time: calTime,
                        delta: formatCny(p.deltaSinceCalibrationCny || 0),
                        totalTag,
                      });
                    } else {
                      metaText = t("settings.usageProvUnsetMeta", { amount: formatCny(p.spentCny) });
                    }

                    return (
                      <div
                        key={p.providerId}
                        className="settings-card usage-provider-card"
                        data-provider-id={p.providerId}
                      >
                        <div className="usage-gcp-head">
                          <div className="usage-gcp-info">
                            <div className="usage-gcp-title-row">
                              <span className="settings-row-title">
                                {p.providerName || p.providerId}
                              </span>
                              <span className="usage-gcp-badge">
                                {p.billingCurrency === "CNY"
                                  ? t("settings.usageProvCnyBadge", { type: p.providerType })
                                  : `${p.providerType} · USD→¥`}
                              </span>
                              <span className={`usage-gcp-badge ${statusClass}`}>
                                {statusLabel}
                              </span>
                            </div>
                            <div className="usage-reset-sub">{metaText}</div>
                          </div>
                          <div className="usage-cost-hero-box">
                            <div className="usage-label">
                              {p.supportsLiveBalance
                                ? t("settings.usageProvLiveRemLabel")
                                : t("settings.usageProvEstRemLabel")}
                            </div>
                            <div className="usage-cost-primary">
                              {p.remainingCny !== null ? formatCny(p.remainingCny) : "—"}
                            </div>
                          </div>
                        </div>

                        {!p.supportsLiveBalance &&
                          p.remainingCny !== null &&
                          p.remainingPct != null && (
                            <div className="usage-gcp-progress-wrap">
                              <div className="usage-progress-track">
                                <div
                                  className="usage-progress-fill"
                                  style={{ width: `${Math.max(2, p.remainingPct)}%` }}
                                />
                              </div>
                            </div>
                          )}

                        {p.supportsLiveBalance && p.lastError && (
                          <div className="usage-provider-error-banner">
                            {t("settings.usageProvLastErrorPrefix", { error: p.lastError })}
                            {p.remainingCny !== null ? t("settings.usageProvCachedSuffix") : ""}
                          </div>
                        )}

                        <div className="usage-gcp-actions">
                          {p.supportsLiveBalance ? (
                            <>
                              <button
                                type="button"
                                className="settings-pill-btn"
                                disabled={isBusy}
                                onClick={async () => {
                                  setState((prev) => ({
                                    providerRefreshingIds: {
                                      ...prev.providerRefreshingIds,
                                      [p.providerId]: true,
                                    },
                                  }));
                                  try {
                                    const res = await apiJson(
                                      `/api/billing/providers/${encodeURIComponent(p.providerId)}/refresh`,
                                      { method: "POST", body: "{}" }
                                    );
                                    setState((prev) => {
                                      const next = { ...prev.providerRefreshingIds };
                                      delete next[p.providerId];
                                      return {
                                        providerRefreshingIds: next,
                                        providerBilling: res,
                                      };
                                    });
                                    showToast(
                                      res.ok
                                        ? t("settings.usageProvRefreshedToast", { name: p.providerName })
                                        : t("settings.usageProvRefreshFailToast", {
                                            error: res.error || t("settings.usageCheckApiKeyFallback"),
                                          })
                                    );
                                  } catch (err: any) {
                                    setState((prev) => {
                                      const next = { ...prev.providerRefreshingIds };
                                      delete next[p.providerId];
                                      return { providerRefreshingIds: next };
                                    });
                                    showToast(
                                      t("settings.usageProvRefreshFailToast", {
                                        error: err?.message || t("settings.networkErrorFallback"),
                                      })
                                    );
                                  }
                                }}
                              >
                                {isBusy ? t("settings.usageRefreshingBtn") : t("settings.usageRefreshNowBtn")}
                              </button>
                              <label className="usage-provider-schedule-wrap">
                                <span>{t("settings.usageAutoRefreshLabel")}</span>
                                <select
                                  className="usage-provider-schedule-select"
                                  aria-label={t("settings.usageAutoRefreshAria", { name: p.providerName })}
                                  value={String(p.autoRefreshMinutes ?? 15)}
                                  onChange={async (e) => {
                                    const mins = Number(e.target.value);
                                    try {
                                      const res = await apiJson(
                                        `/api/billing/providers/${encodeURIComponent(p.providerId)}/schedule`,
                                        {
                                          method: "PATCH",
                                          body: JSON.stringify({ autoRefreshMinutes: mins }),
                                        }
                                      );
                                      setState({ providerBilling: res });
                                      showToast(
                                        mins === 0
                                          ? t("settings.usageScheduleOffToast", { name: p.providerName })
                                          : t("settings.usageScheduleOnToast", { name: p.providerName, mins })
                                      );
                                    } catch (err: any) {
                                      showToast(err?.message || t("settings.usageScheduleFailedToast"));
                                    }
                                  }}
                                >
                                  <option value="0">{t("settings.usageScheduleOffOpt")}</option>
                                  <option value="5">{t("settings.usageScheduleMinOpt", { mins: 5 })}</option>
                                  <option value="15">{t("settings.usageScheduleMinOpt", { mins: 15 })}</option>
                                  <option value="30">{t("settings.usageScheduleMinOpt", { mins: 30 })}</option>
                                  <option value="60">{t("settings.usageScheduleMinOpt", { mins: 60 })}</option>
                                </select>
                              </label>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="settings-pill-btn"
                              onClick={() =>
                                setState((prev) => {
                                  const next = { ...prev.providerOpenCalibrationIds };
                                  if (next[p.providerId]) delete next[p.providerId];
                                  else next[p.providerId] = true;
                                  return { providerOpenCalibrationIds: next };
                                })
                              }
                            >
                              {isCalOpen ? t("settings.usageCalCollapseBtn") : t("settings.usageCalOpenBtn")}
                            </button>
                          )}
                        </div>

                        {!p.supportsLiveBalance && isCalOpen && (
                          <ProviderCalibrationForm provider={p} />
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="settings-group-label">{t("settings.usageByModelGroupTitle")}</div>
              <div className="settings-card usage-models-card" id="usage-by-model-list">
                {byModel.length === 0 ? (
                  <div className="usage-session-row">
                    <span className="settings-row-sub">{t("settings.usageByModelEmpty")}</span>
                  </div>
                ) : (
                  byModel.map((m: any) => {
                    const cnyRates =
                      m.ratesCny ||
                      (m.rates
                        ? {
                            inputPer1M:
                              m.nativeCurrency === "CNY"
                                ? m.rates.inputPer1M
                                : m.rates.inputPer1M * CLIENT_USD_TO_CNY,
                            cachedInputPer1M:
                              typeof m.rates.cachedInputPer1M === "number"
                                ? m.nativeCurrency === "CNY"
                                  ? m.rates.cachedInputPer1M
                                  : m.rates.cachedInputPer1M * CLIENT_USD_TO_CNY
                                : undefined,
                            outputPer1M:
                              m.nativeCurrency === "CNY"
                                ? m.rates.outputPer1M
                                : m.rates.outputPer1M * CLIENT_USD_TO_CNY,
                          }
                        : null);
                    const fmtRate = (v: number) => {
                      const num = Number(v) || 0;
                      if (num === 0) return "0";
                      if (num < 1) return String(Number(num.toFixed(4)));
                      return num.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
                    };
                    let rateText = "";
                    if (cnyRates) {
                      const inR = Number(cnyRates.inputPer1M) || 0;
                      const cacheR =
                        typeof cnyRates.cachedInputPer1M === "number"
                          ? Number(cnyRates.cachedInputPer1M)
                          : -1;
                      const outR = Number(cnyRates.outputPer1M) || 0;
                      const cacheRatePart =
                        cacheR > 0 && cacheR < inR
                          ? t("settings.usageModelCacheRatePart", { rate: fmtRate(cacheR) })
                          : "";
                      const offPeakPart = m.offPeakHalfPrice ? t("settings.usageModelOffPeakPart") : "";
                      rateText = t("settings.usageModelRateLine", {
                        inRate: fmtRate(inR),
                        cacheRatePart,
                        outRate: fmtRate(outR),
                        offPeakPart,
                      });
                    }
                    const inpCount = Number(m.inputTokens) || 0;
                    const cachedCount = Number(m.cachedTokens) || 0;
                    const cacheHitPct = inpCount > 0 ? Math.round((cachedCount / inpCount) * 100) : 0;
                    const cachePart =
                      cachedCount > 0
                        ? t("settings.usageModelCacheHitPart", {
                            count: cachedCount.toLocaleString(),
                            pct: cacheHitPct,
                          })
                        : "";
                    const thoughtPart =
                      m.thoughtTokens > 0
                        ? t("settings.usageModelThoughtPart", {
                            count: Number(m.thoughtTokens).toLocaleString(),
                          })
                        : "";
                    const callPart =
                      m.calls > 0 ? t("settings.usageModelCallsPart", { calls: m.calls }) : "";
                    const clientMeta = getClientModelMeta(m.model, currentLocale);
                    const displayRole =
                      currentLocale === "en"
                        ? clientMeta.role
                        : m.role || clientMeta.role || t("settings.usageAutoRouteModel");

                    return (
                      <div key={m.model} className="usage-model-row">
                        <div className="usage-model-head">
                          <div className="usage-model-title-wrap">
                            <span
                              className={`model-accent-dot model-accent-${m.accent || "blue"}`}
                            />
                            <span className="usage-model-name">{m.label || m.model}</span>
                            <span className="usage-model-role">{displayRole}</span>
                            <span className="usage-model-rate">{rateText}</span>
                          </div>
                          <div className="usage-model-cost-col">
                            <div className="usage-model-cost-usd">{formatCny(m.costCny)}</div>
                          </div>
                        </div>
                        <div className="usage-model-metrics">
                          <span>
                            {callPart}
                            {t("settings.usageModelInputPrefix", { count: inpCount.toLocaleString() })}
                            {cachePart}
                            {t("settings.usageModelOutputPart", {
                              count: (Number(m.outputTokens) || 0).toLocaleString(),
                            })}
                            {thoughtPart}
                          </span>
                          <span>
                            {t("settings.usageModelTotalLine", {
                              total: (Number(m.totalTokens) || 0).toLocaleString(),
                              pct: m.sharePct || 0,
                            })}
                          </span>
                        </div>
                        <div className="usage-mini-bar-track">
                          <div
                            className={`usage-mini-bar-fill model-accent-${m.accent || "blue"}`}
                            style={{
                              width: `${m.totalTokens > 0 ? Math.max(2, Number(m.sharePct) || 0) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div
                className="settings-group-label"
                id="usage-sessions-group-label"
                hidden={isSessionScope}
              >
                {t("settings.usageBySessionGroupTitle")}
              </div>
              <div
                className="settings-card usage-sessions-card"
                id="usage-by-session-list"
                hidden={isSessionScope}
              >
                {bySession.length === 0 ? (
                  <div className="usage-session-row">
                    <span className="settings-row-sub">{t("settings.usageBySessionEmpty")}</span>
                  </div>
                ) : (
                  bySession.map((s: any) => (
                    <div key={s.id} className="usage-session-row">
                      <span className="usage-session-name">
                        {s.type === "group" && (
                          <UiIcon name="users" className="inline-ui-icon" size={13} />
                        )}
                        {s.title || "Bot"}
                      </span>
                      <span className="usage-session-meta">
                        {(Number(s.totalTokens) || 0).toLocaleString()} tok · {formatCny(s.costCny)}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <p className="vault-footnote" id="usage-pricing-footnote">
                {t("settings.usagePricingFootnote")}
              </p>
            </div>

            <div
              id="usage-inline-trace-view"
              className="usage-inline-trace-view"
              ref={bindScrollEndTracking}
              hidden={!usageTraceActive}
            >
              {usageTraceActive && <TraceEventsList id="usage-inline-trace-list" />}
            </div>
            </fieldset>
          </div>

          {/* ==================== PANE 7: 关于与系统诊断 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="updates"
            hidden={activeTab !== "updates"}
          >
            <div className="vault-header-row">
              <h2 className="settings-pane-title">{t("settings.tabUpdates")}</h2>
              <button
                type="button"
                className="settings-pill-btn"
                id="check-update-btn"
                onClick={() => refreshSystemDiagnostics(true)}
              >
                <svg
                  className="icon-svg inline-ui-icon"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M15.6 8.3A5.8 5.8 0 0 0 5.4 6.5M4.4 11.7A5.8 5.8 0 0 0 14.6 13.5"
                    stroke="currentColor"
                    strokeWidth="1.55"
                    strokeLinecap="round"
                  />
                  <path
                    d="M15.8 4.8V8.4H12.2M4.2 15.2V11.6H7.8"
                    stroke="currentColor"
                    strokeWidth="1.55"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{t("settings.refreshDiagBtn")}</span>
              </button>
            </div>

            <div className="settings-group-label">{t("settings.otaGroupTitle")}</div>
            <div className="settings-card ota-update-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title" id="ota-shell-version-line">
                    {(() => {
                      const lm = updateState?.localMeta;
                      const plat = lm?.platform || "desktop";
                      const platLabel =
                        plat === "ios"
                          ? t("settings.otaPlatIos")
                          : plat === "android"
                            ? t("settings.otaPlatAndroid")
                            : plat === "desktop"
                              ? lm?.supportsCoreOta
                                ? t("settings.otaPlatDesktopCore")
                                : t("settings.otaPlatDesktopEmbedded")
                              : t("settings.otaPlatWeb");
                      const verStr = lm?.nativeVersion || diagnostics?.appVersion || "1.0.0";
                      const codeSuffix = lm?.nativeBuildCode ? ` (Build ${lm.nativeBuildCode})` : "";
                      return `${platLabel} v${verStr}${codeSuffix}`;
                    })()}
                  </div>
                  <div className="settings-row-sub" id="ota-web-build-line">
                    {(() => {
                      const lm = updateState?.localMeta;
                      const wb = lm?.activeWebBuild || diagnostics?.webBuild || "builtin";
                      const cb = lm?.activeCoreBuild || wb;
                      const tag =
                        lm?.usingBuiltIn === false
                          ? t("settings.otaTagActive")
                          : t("settings.otaTagBuiltin");
                      if (lm?.supportsCoreOta) {
                        return t("settings.otaCoreRuntimeLine", { cb, tag });
                      }
                      return t("settings.otaWebAssetsLine", { wb, tag });
                    })()}
                  </div>
                  {updateState?.lastCheckedAt > 0 && (
                    <div className="settings-row-sub">
                      {t("settings.otaLastCheckedLine", {
                        time: formatBillingTime(updateState.lastCheckedAt, currentLocale),
                      })}
                    </div>
                  )}
                </div>
                <div className="ota-actions-row">
                  <button
                    type="button"
                    className="settings-pill-btn"
                    id="ota-check-btn"
                    disabled={Boolean(updateState?.checking || updateState?.applying)}
                    onClick={() => {
                      void checkForAppUpdates({ force: true }).then((res) => {
                        if (!res) return;
                        if (res.status === "up-to-date") {
                          showToast(t("settings.otaUpToDateToast"));
                        } else if (res.status === "ota-available") {
                          showToast(
                            res.otaKind === "core"
                              ? t("settings.otaCoreFoundToast")
                              : t("settings.otaWebFoundToast")
                          );
                        }
                      });
                    }}
                  >
                    {updateState?.checking ? t("settings.otaCheckingBtn") : t("settings.otaCheckBtn")}
                  </button>
                </div>
              </div>

              {Boolean(updateState?.localMeta?.lastRollbackReason) && (
                <>
                  <div className="settings-divider" />
                  <div className="mail-feedback-box is-error ota-inline-banner">
                    {t("settings.otaRollbackBanner", { reason: updateState.localMeta?.lastRollbackReason || "" })}
                  </div>
                </>
              )}

              {Boolean(updateState?.error) && (
                <>
                  <div className="settings-divider" />
                  <div
                    className={`mail-feedback-box ota-inline-banner${
                      updateState.errorCode === "NO_PUBLISHED_RELEASE" ||
                      updateState.errorCode === "GITHUB_RATE_LIMITED"
                        ? ""
                        : " is-error"
                    }`}
                  >
                    {updateState.error}
                  </div>
                </>
              )}

              {Boolean(
                (updateState?.applying && updateState?.progress) ||
                  updateState?.progress?.phase === "waiting_idle" ||
                  updateState?.localMeta?.deferredSwitch
              ) && (
                <>
                  <div className="settings-divider" />
                  <div className="ota-progress-wrap">
                    <div className="ota-progress-meta">
                      <span>
                        {updateState.progress?.message ||
                          (updateState?.localMeta?.deferredSwitch
                            ? t("settings.otaDeferredMsg", {
                                buildId: updateState.localMeta.deferredSwitch.buildId,
                                count: updateState.localMeta.deferredSwitch.activeRunCount,
                              })
                            : t("settings.otaUpdatingMsg"))}
                      </span>
                      <span>
                        {Math.round(
                          updateState.progress?.percent ??
                            (updateState?.localMeta?.deferredSwitch ? 90 : 0)
                        )}
                        %
                      </span>
                    </div>
                    <div className="usage-progress-track">
                      <div
                        className="usage-progress-fill"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(
                              5,
                              updateState.progress?.percent ??
                                (updateState?.localMeta?.deferredSwitch ? 90 : 0)
                            )
                          )}%`,
                        }}
                      />
                    </div>
                    {(updateState?.progress?.phase === "waiting_idle" ||
                      Boolean(updateState?.localMeta?.deferredSwitch)) && (
                      <div className="ota-offer-actions" style={{ marginTop: 6 }}>
                        <button
                          type="button"
                          id="force-switch-core-ota-btn"
                          className="skill-pill-btn is-primary"
                          disabled={Boolean(updateState?.applying)}
                          onClick={() => {
                            void forceSwitchCoreOtaNow().catch((err: any) => {
                              showToast(
                                t("settings.otaForceSwitchFailToast", {
                                  error: err?.message || t("actions.unknownError"),
                                })
                              );
                            });
                          }}
                        >
                          {t("settings.otaForceSwitchBtn")}
                        </button>
                        <button
                          type="button"
                          id="cancel-deferred-core-ota-btn"
                          className="settings-pill-btn"
                          disabled={Boolean(updateState?.applying)}
                          onClick={() => {
                            void cancelDeferredCoreOta().then(() => {
                              showToast(t("settings.otaCancelledDeferredToast"));
                            });
                          }}
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {updateDecision && updateDecision.status !== "up-to-date" && (
                <>
                  <div className="settings-divider" />
                  <div className="ota-offer-box" id="ota-offer-box">
                    <div className="ota-offer-head">
                      <div className="ota-offer-title-row">
                        <span className="ota-offer-title">
                          {updateDecision.status === "ota-available"
                            ? updateDecision.otaKind === "core"
                              ? t("settings.otaOfferCoreTitle")
                              : t("settings.otaOfferWebTitle")
                            : updateDecision.status === "reload-required"
                              ? t("settings.otaOfferReloadTitle")
                              : t("settings.otaOfferShellTitle", {
                                  version: updateDecision.shellUpdate?.latestVersion || "",
                                })}
                        </span>
                        <span className="provider-type-badge is-gcp-vertex">
                          {updateDecision.status === "ota-available"
                            ? t("settings.otaBadgeNoReinstall")
                            : "GitHub Releases"}
                        </span>
                      </div>
                      {(updateDecision.coreBundle || updateDecision.otaBundle) && (
                        <span className="ota-offer-sub">
                          {t("settings.otaTargetBuildLine", {
                            build:
                              updateDecision.coreBundle?.coreBuild ||
                              updateDecision.otaBundle?.webBuild ||
                              "",
                            kb: Math.max(
                              1,
                              Math.round(
                                ((updateDecision.coreBundle?.sizeBytes ??
                                  updateDecision.otaBundle?.sizeBytes) ||
                                  0) / 1024
                              )
                            ),
                          })}
                        </span>
                      )}
                      {updateDecision.resolvedAsset?.fileName && (
                        <span className="ota-offer-sub">
                          {t("settings.otaAssetNameLine", {
                            name: updateDecision.resolvedAsset.fileName,
                          })}
                        </span>
                      )}
                      {Boolean(updateDecision.reason) && (
                        <span className="ota-offer-sub">{updateDecision.reason}</span>
                      )}
                      {Boolean(updateDecision.releaseNotes) && (
                        <span className="ota-offer-notes">{updateDecision.releaseNotes}</span>
                      )}
                    </div>
                    <div className="ota-offer-actions">
                      {updateDecision.status === "ota-available" && (
                        <button
                          type="button"
                          id="apply-web-ota-btn"
                          className="skill-pill-btn is-primary"
                          disabled={Boolean(
                            updateState?.applying ||
                              updateState?.progress?.phase === "waiting_idle" ||
                              updateState?.localMeta?.deferredSwitch
                          )}
                          onClick={() => {
                            void applyAvailableOtaUpdate()
                              .then((res) => {
                                if (res?.queuedForIdle) {
                                  showToast(t("settings.otaQueuedIdleToast"));
                                }
                              })
                              .catch((err: any) => {
                                showToast(
                                  t("settings.otaApplyFailToast", {
                                    error: err?.message || t("actions.unknownError"),
                                  })
                                );
                              });
                          }}
                        >
                          {updateState?.applying
                            ? t("settings.otaApplyingBtn")
                            : updateState?.progress?.phase === "waiting_idle" ||
                                updateState?.localMeta?.deferredSwitch
                              ? t("settings.otaWaitingIdleBtn")
                              : updateDecision.otaKind === "core"
                                ? t("settings.otaApplyCoreBtn")
                                : t("settings.otaApplyWebBtn")}
                        </button>
                      )}
                      {updateDecision.status === "reload-required" && (
                        <button
                          type="button"
                          className="skill-pill-btn is-primary"
                          onClick={() => window.location.reload()}
                        >
                          {t("settings.otaReloadBtn")}
                        </button>
                      )}
                      {(updateDecision.status === "shell-update-required" ||
                        Boolean(updateDecision.optionalShellUpdate)) && (
                        <button
                          type="button"
                          id="download-shell-update-btn"
                          className={
                            updateDecision.status === "shell-update-required"
                              ? "skill-pill-btn is-primary"
                              : "settings-pill-btn"
                          }
                          disabled={Boolean(updateState?.applying)}
                          onClick={() => {
                            void downloadOrOpenFullShellUpdate().catch((err: any) => {
                              showToast(
                                t("settings.otaDownloadFailToast", {
                                  error: err?.message || t("settings.otaManualDownloadFallback"),
                                })
                              );
                            });
                          }}
                        >
                          {updateDecision.status === "shell-update-required"
                            ? t("settings.otaDownloadShellBtn")
                            : t("settings.otaDownloadOptionalShellBtn", {
                                version: updateDecision.optionalShellUpdate?.latestVersion || "",
                              })}
                        </button>
                      )}
                      <button
                        type="button"
                        className="section-action-link"
                        onClick={() => dismissCurrentUpdateNotice()}
                      >
                        {t("settings.otaDismissBtn")}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="settings-group-label">{t("settings.diagRuntimeGroupTitle")}</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title" id="diag-version-line">
                    {diagnostics
                      ? `TwinkleBot v${diagnostics.appVersion || "1.0.0"} (${diagnostics.platform || "local"})`
                      : "TwinkleBot v1.0.0"}
                  </div>
                  <div className="settings-row-sub" id="update-check-status">
                    {diagnostics
                      ? t("settings.diagRuntimeSub", {
                          node: diagnostics.nodeVersion || "",
                          count: diagnostics.sessionCount ?? 0,
                        })
                      : t("settings.diagRuntimeLoading")}
                  </div>
                </div>
                <span
                  className={`online-dot${diagLlmReady ? "" : " is-warn"}`}
                  id="diag-api-badge"
                >
                  <span
                    className={`status-dot-inline ${diagLlmReady ? "is-ok" : "is-warn"}`}
                    aria-hidden="true"
                  />
                  <span>
                    {diagLlmReady ? t("settings.diagModelsReadyBadge") : t("settings.diagModelsMissingBadge")}
                  </span>
                </span>
              </div>
              {Boolean(updateState?.connectedNodeStatus?.nodeOutdated) && (
                <>
                  <div className="settings-divider" />
                  <div className="mail-feedback-box ota-inline-banner" id="connected-node-outdated-banner">
                    {t("settings.diagConnectedNodeOutdated", {
                      nodeVersion: updateState.connectedNodeStatus?.nodeVersion || "",
                      latestVersion: updateState.connectedNodeStatus?.latestBackendVersion || "",
                    })}
                  </div>
                </>
              )}
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.diagExecutorTitle")}</div>
                  <div className="settings-row-sub" id="diag-executor-line">
                    {!diagnostics ? (
                      t("settings.diagExecutorChecking")
                    ) : diagExecOnline ? (
                      <>
                        <span className="status-dot-inline is-ok" aria-hidden="true" />{" "}
                        {t("settings.diagExecutorOnlineLine", {
                          url: diagExecUrl,
                          ms: diagnostics.executorLatencyMs ?? 0,
                        })}
                      </>
                    ) : (
                      <>
                        <span className="status-dot-inline is-err" aria-hidden="true" />{" "}
                        {t("settings.diagExecutorOfflineLine", {
                          url: diagExecUrl,
                          error: diagnostics.executorError || t("settings.diagExecutorNoResp"),
                        })}
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.diagEnabledModelsTitle")}</div>
                  <div className="settings-row-sub" id="diag-models-line">
                    {!diagnostics
                      ? t("settings.diagEnabledModelsLoading")
                      : diagAllModels.length > 0
                        ? diagAllModels.join(" · ")
                        : t("settings.diagEnabledModelsEmpty")}
                  </div>
                </div>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">{t("settings.diagWriteRootTitle")}</div>
                  <div className="settings-row-sub" id="diag-workspace-line">
                    {Array.isArray(diagnostics?.writeRoots)
                      ? diagnostics.writeRoots.join("  |  ")
                      : "~/TwinkleBot/workspace"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
