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
  CONTEXT_COMPRESSION_PRESETS,
  matchContextCompressionPreset,
  normalizeContextCompressionSettings,
} from "/shared/context-compression.js";
import {
  FALLBACK_SCREEN_POOL_BUDGET,
  matchScreenPoolPreset,
  normalizeScreenPoolSettings,
} from "/shared/screen-pool.js";
import { resolveBotComputerStatusDisplay } from "/shared/computer-status.js";
import { isMobileViewport } from "../../mobile-ui.js";
import {
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
  PROFILE_COLORS,
  PROVIDER_PRESETS_UI,
} from "../../state/constants.js";
import {
  formatBillingTime,
  formatCny,
  isImeConfirmEnter,
  parseModelsCsv,
} from "../../state/helpers.js";
import { getState, setState, useStore } from "../../state/store.js";
import { isRemoteAccountOffline } from "../../services/network-monitor.js";
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
  ["general", "gear", "通用"],
  ["models", "models-diamond", "模型接入与路由"],
  ["computer", "monitor", "电脑"],
  ["permissions", "shield-check", "权限"],
  ["vault", "vault-safe", "保险库"],
  ["usage", "bar-chart", "用量与账单"],
  ["updates", "sparkle", "关于与诊断"],
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

const PERMISSION_RULE_TOOLS = [
  ["*", "任意工具 (*)"],
  ["host_run_shell", "host_run_shell (宿主机终端)"],
  ["host_open", "host_open (宿主机打开应用)"],
  ["host_write_file", "host_write_file (宿主机写文件)"],
  ["mcp__kimi_cu__click", "mcp__kimi_cu__click (Mac 点击)"],
  ["mcp__kimi_cu__type_text", "mcp__kimi_cu__type_text (Mac 输入)"],
  ["mcp__kimi_cu__js", "mcp__kimi_cu__js (Mac 页面脚本)"],
  ["run_shell", "run_shell (Bot 电脑终端)"],
  ["write_file", "write_file (Bot 电脑写文件)"],
  ["open_url", "open_url"],
  ["click", "click"],
] as const;

function ProviderCalibrationForm({ provider: p }: { provider: any }) {
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
      previewText = "尚未设置初始余额，请先选择「直接修改」或「+ 增加」";
    }
  } else {
    const amt = Number(rawTrim);
    if (Number.isFinite(amt) && amt >= 0) {
      if (curMode === "add") {
        const base = curVal ?? 0;
        previewText = `当前 ¥${base.toFixed(2)} + ¥${amt.toFixed(2)} = ¥${(base + amt).toFixed(2)}`;
      } else if (curMode === "sub") {
        previewText =
          curVal === null
            ? "尚未设置初始余额，请先选择「直接修改」或「+ 增加」"
            : `当前 ¥${curVal.toFixed(2)} - ¥${amt.toFixed(2)} = ¥${Math.max(0, curVal - amt).toFixed(2)}`;
      } else {
        previewText = `保存后将从 ¥${amt.toFixed(2)} 开始按实时用量自动扣减`;
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
              ? "已增加额度并更新扣减基线"
              : curMode === "sub"
                ? "已扣减额度并更新扣减基线"
                : "余额设置已保存"
          );
        } catch (err: any) {
          showToast(err?.message || "保存失败");
        }
      }}
    >
      <div className="usage-gcp-mode-row">
        <span className="usage-gcp-mode-caption">校准方式</span>
        <div
          className="usage-gcp-mode-tabs"
          role="tablist"
          aria-label={`${p.providerName} 校准方式`}
        >
          {[
            { id: "add", label: "+ 增加" },
            { id: "sub", label: "- 扣减" },
            { id: "set", label: "直接修改" },
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
              ? "增加额度（¥ 人民币）"
              : curMode === "sub"
                ? "扣减额度（¥ 人民币）"
                : "设为剩余余额（¥ 人民币）"}
          </span>
          <input
            ref={remInputRef}
            type="number"
            step="0.01"
            min="0"
            aria-label={`${p.providerName} 校准金额（人民币）`}
            placeholder={
              curMode === "add" ? "如 500.00" : curMode === "sub" ? "如 35.00" : "如 1500.00"
            }
            value={remAmount}
            onChange={(e) => setRemAmount(e.target.value)}
          />
        </label>
        <label className="usage-gcp-field">
          <span>总额度（¥，可选，显示进度条）</span>
          <input
            type="number"
            step="1"
            min="0"
            placeholder="如 2000"
            aria-label={`${p.providerName} 总额度（人民币）`}
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
          保存
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
              showToast("已清除余额设置");
            } catch (err: any) {
              showToast(err?.message || "清除失败");
            }
          }}
        >
          清除设置
        </button>
        <button type="button" className="settings-pill-btn" onClick={closeCalibration}>
          取消
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

    setEdgePullHint((prev) =>
      prev && prev.dir === dir && prev.targetLabel === targetTab[2]
        ? prev
        : { dir, targetLabel: targetTab[2] }
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

  // Profile local state
  const profile = settings?.profile || { name: "本地用户", color: "slate" };
  const profileName = String(profile.name || "本地用户").trim() || "本地用户";
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
  const presetMeta = CONTEXT_COMPRESSION_PRESETS.find((p) => p.id === matchedPresetId);

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
    const preset = PROVIDER_PRESETS_UI[nextType] || PROVIDER_PRESETS_UI.gemini;
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
    const t = PROVIDER_PRESETS_UI[rawT] ? rawT : "gemini";
    const preset = PROVIDER_PRESETS_UI[t] || PROVIDER_PRESETS_UI.gemini;
    setProvId(targetId);
    setProvType(t);
    setProvName(p?.name || preset.name);
    setProvCurrency(
      p?.billingCurrency || preset.billingCurrency || (t === "deepseek" ? "CNY" : "USD")
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
      showToast("模型路由配置已保存");
    } catch (err: any) {
      showToast(`保存失败: ${err.message}`);
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
      showToast(`保存上下文压缩设置失败：${err?.message || "请求异常"}`);
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
      showToast(`保存屏幕并发上限失败：${err?.message || "请求异常"}`);
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
      showToast(`保存预算上限失败：${err?.message || "请求异常"}`);
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
      showToast("请输入有效的显示昵称");
      return;
    }
    try {
      const saved = await commitSettingsPatch({
        profile: { name: nextName, color: profileColor },
      });
      showToast(`个人资料已保存为「${saved?.profile?.name || nextName}」`);
    } catch (err: any) {
      showToast(`保存个人资料失败：${err?.message || "请求异常"}`);
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
  const scopedSessionTitle = scopedSession?.title || "当前 Bot";

  const totalTok = Number(usagePayload?.totalTokens) || 0;
  const estCny = Number(usagePayload?.estimatedCostCny) || 0;
  const extraParts: string[] = [];
  if (Number(usagePayload?.cachedTokens) > 0) {
    extraParts.push(`缓存命中 ${Number(usagePayload.cachedTokens).toLocaleString()}`);
  }
  if (Number(usagePayload?.thoughtTokens) > 0) {
    extraParts.push(`含思考 ${Number(usagePayload.thoughtTokens).toLocaleString()}`);
  }
  const extraSuffix = extraParts.length > 0 ? `（${extraParts.join(" · ")}）` : "";
  const tailSuffix = isSessionScope
    ? requestedSid === activeSessionId && stepCount > 0
      ? ` · 执行 ${stepCount} 步`
      : ""
    : ` · 共 ${usagePayload?.sessionCount ?? sessions.length} 个 Bot/群聊`;

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
    const searchOk =
      !vQuery ||
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
      ? "宿主机执行已关闭"
      : hostExecMode === "ask"
        ? "宿主机操作每次询问"
        : "允许直接操控你的电脑";
  const compStatusView = resolveBotComputerStatusDisplay(computerStatus, {
    detecting: detectingComputer,
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
    diagnostics?.deployEnv === "cloud" ? "云端主控模式" : "本地守护进程模式";
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
          <strong>新建全局记忆</strong>
        </div>
      )}
      <div className="custom-skill-fields">
        <label className="field-group">
          <span>记忆标题（可选）</span>
          <input
            ref={memNameRef}
            id="memory-name-input"
            type="text"
            placeholder="例如：周报排版规范 / 汇报语气偏好"
            aria-label="记忆标题"
            value={memName}
            onChange={(e) => setMemName(e.target.value)}
          />
        </label>
        <label className="field-group">
          <span>记忆内容（所有 Bot 共享遵守）*</span>
          <textarea
            id="memory-content-input"
            className="is-compact-textarea"
            rows={3}
            placeholder="输入希望所有 Bot 长期遵守的背景、偏好或执行约定（也可直接在聊天中说「记住…」自动添加）..."
            aria-label="记忆内容"
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
          取消
        </button>
        <button
          id="save-memory-btn"
          type="button"
          className="skill-pill-btn is-primary"
          onClick={async () => {
            const content = memContent.trim();
            if (!content) {
              showToast("请输入记忆内容");
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
              showToast(editingMemId ? "全局记忆已更新" : "全局记忆已保存");
            } catch (err: any) {
              showToast(`保存全局记忆失败：${err?.message || "请求异常"}`);
            }
          }}
        >
          保存记忆
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
          provName.trim() || PROVIDER_PRESETS_UI[provType]?.name || provType;
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
              ? `已保存「${resolvedName}」，已为你自动选好 3 档路由模型，可自行修改`
              : `已保存模型供应商「${resolvedName}」`
          );
        } catch (err: any) {
          setProvFeedback({ text: `❌ ${err.message}`, kind: "error" });
        }
      }}
    >
      <input id="provider-id-input" type="hidden" value={provId} readOnly />
      {!inline && (
        <div className="custom-skill-editor-top">
          <strong>添加模型供应商</strong>
        </div>
      )}

      <div className="custom-skill-fields">
        <div className="field-group">
          <span>供应商类型</span>
          <div
            className="provider-preset-pills"
            role="radiogroup"
            aria-label="供应商类型"
          >
            {SETTINGS_PROVIDER_KEYS.map((pKey) => {
              const pr = PROVIDER_PRESETS_UI[pKey];
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
                {PROVIDER_PRESETS_UI[pKey]?.name || pKey}
              </option>
            ))}
          </select>
          <span className="provider-preset-hint">
            {PROVIDER_PRESETS_UI[provType]?.hint || ""}
          </span>
        </div>

        {provType === "gemini" && Boolean(settings?.gcpVertexActive) && (
          <div className="mail-feedback-box is-success">
            当前 GCP 云服务器已通过环境变量启用 Vertex AI 服务账号认证（
            {settings?.gcpVertexProject} · {settings?.gcpVertexLocation}
            ），API Key 可留空。
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
            <span>显示名称 *</span>
            <input
              ref={provNameRef}
              id="provider-name-input"
              type="text"
              placeholder="例如：Google Gemini / DeepSeek 主力"
              aria-label="供应商名称"
              value={provName}
              onChange={(e) => setProvName(e.target.value)}
            />
          </label>
          <label className="field-group custom-skill-slug-field">
            <span>计费结算币种</span>
            <select
              id="provider-billing-currency-select"
              aria-label="计费结算币种"
              value={provCurrency}
              onChange={(e) => setProvCurrency(e.target.value as "USD" | "CNY")}
            >
              <option value="USD">USD（美元，自动折算人民币 ¥）</option>
              <option value="CNY">CNY（人民币 ¥ 原币计费）</option>
            </select>
          </label>
        </div>

        <div className="field-group">
          <div className="mail-label-row">
            <span>
              API Key / 环境变量名
              {provId ? "（留空保留原密钥）" : ""}
            </span>
            <button
              type="button"
              className="mail-secret-toggle"
              onClick={() => setProvShowKey((v) => !v)}
            >
              {provShowKey ? "隐藏" : "显示"}
            </button>
          </div>
          <input
            id="provider-api-key-input"
            type={provShowKey ? "text" : "password"}
            placeholder="粘贴 API Key 或填环境变量名（如 GEMINI_API_KEY）"
            aria-label="供应商 API Key"
            autoComplete="off"
            value={provApiKey}
            onChange={(e) => setProvApiKey(e.target.value)}
          />
        </div>

        <label className="field-group">
          <span>
            接口地址 Base URL（
            {provType === "openai-compatible" ? "自定义兼容必填" : "官方接口可留空"}
            ）
          </span>
          <input
            id="provider-base-url-input"
            type="url"
            placeholder="例如：https://api.openai.com/v1"
            aria-label="供应商 Base URL"
            value={provBaseUrl}
            onChange={(e) => setProvBaseUrl(e.target.value)}
          />
        </label>

        <label className="field-group">
          <span>大语言模型列表（逗号或换行分隔）*</span>
          <textarea
            id="provider-models-input"
            className="is-compact-textarea"
            rows={2}
            placeholder="例如：gemini-4-hydrogen, gemini-4-argon, gemini-4-carbon"
            aria-label="大语言模型列表"
            value={provModels}
            onChange={(e) => setProvModels(e.target.value)}
          />
        </label>

        <label className="field-group">
          <span>生图模型列表（可选，逗号或换行分隔）</span>
          <textarea
            id="provider-image-models-input"
            className="is-compact-textarea"
            rows={1}
            placeholder="例如：gemini-3.1-flash-image, gpt-image-1"
            aria-label="生图模型列表"
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
          取消
        </button>
        <button
          id="provider-test-btn"
          type="button"
          className="skill-pill-btn"
          onClick={async () => {
            const models = parseModelsCsv(provModels);
            setProvFeedback({ text: "正在测试连接…", kind: "info" });
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
                text: res.ok ? `✓ 连接成功 (${res.latencyMs}ms)` : `❌ 失败：${res.error}`,
                kind: res.ok ? "ok" : "error",
              });
            } catch (err: any) {
              setProvFeedback({ text: `❌ ${err.message}`, kind: "error" });
            }
          }}
        >
          测试连接
        </button>
        <button
          id="provider-save-btn"
          type="submit"
          className="skill-pill-btn is-primary"
        >
          保存供应商
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
          <strong>新建保险库条目</strong>
        </div>
      )}
      <div className="custom-skill-fields">
        <div className="custom-skill-row-two">
          <label className="field-group custom-skill-slug-field">
            <span>条目分类</span>
            <select
              id="vault-cat-input"
              value={vaultCat}
              onChange={(e) => setVaultCat(e.target.value)}
            >
              <option value="contact">联系信息</option>
              <option value="credential">登录凭据（账号 + 密码）</option>
              <option value="login">账号备注</option>
            </select>
          </label>
          <label className="field-group custom-skill-name-field">
            <span>名称 *</span>
            <input
              ref={vaultTitleRef}
              id="vault-title-input"
              type="text"
              placeholder="如：测试站账号 / 常用收件人"
              value={vaultTitle}
              onChange={(e) => setVaultTitle(e.target.value)}
            />
          </label>
        </div>
        <label className="field-group">
          <span>邮箱 / 用户名 / 备注内容</span>
          <input
            id="vault-sub-input"
            type="text"
            placeholder="邮箱 / 用户名 / 备注内容"
            value={vaultSub}
            onChange={(e) => setVaultSub(e.target.value)}
          />
        </label>
        {vaultSecretSupported && (
          <label className="field-group">
            <span>密码 / 授权码（可选 · 本机 AES-256-GCM 加密）</span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                id="vault-password-input"
                type={vaultPasswordVisible ? "text" : "password"}
                autoComplete="new-password"
                style={{ flex: 1, minWidth: 0 }}
                placeholder={
                  editingVaultId && vaultHasPassword && !vaultPasswordTouched
                    ? "••••••••（已加密保存，留空则保持不变）"
                    : "输入密码或授权码，留空表示不存密码"
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
                        showToast(`读取密码失败: ${err?.message || "请重试"}`);
                      } finally {
                        setVaultRevealing(false);
                      }
                    } else {
                      setVaultPasswordVisible(true);
                    }
                  }}
                >
                  {vaultRevealing ? "解密中…" : vaultPasswordVisible ? "隐藏" : "查看"}
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
                  清除
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
          取消
        </button>
        <button
          type="button"
          className="skill-pill-btn is-primary"
          id="save-vault-item-btn"
          onClick={async () => {
            const title = vaultTitle.trim();
            if (!title) {
              showToast("请输入条目名称");
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
            showToast(editingVaultId ? "保险库项目已更新" : "保险库项目已保存");
          }}
        >
          保存项目
        </button>
      </div>
    </div>
  );

  const renderRuleInlineEditor = (kind: "ask" | "allow", rule: any) => (
    <div className="custom-skill-editor settings-inline-editor is-inline-row-editor">
      <div className="custom-skill-fields">
        <div className="custom-skill-row-two">
          <label className="field-group custom-skill-name-field">
            <span>目标工具</span>
            <select
              value={editRuleTool}
              onChange={(e) => setEditRuleTool(e.target.value)}
            >
              {PERMISSION_RULE_TOOLS.map(([val, label]) => (
                <option key={val} value={val}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-group custom-skill-slug-field">
            <span>参数匹配关键词（留空匹配全部）</span>
            <input
              type="text"
              placeholder={kind === "ask" ? "如 rm、git push、pay" : "如 /tmp/、npm test"}
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
          取消
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
              showToast("权限规则已更新");
            } catch (err: any) {
              showToast(`更新权限规则失败：${err?.message || "请求异常"}`);
            }
          }}
        >
          保存规则
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
        aria-label="TwinkleBot 设置"
      >
        <button
          id="close-settings-modal-btn"
          type="button"
          className="modal-close-btn"
          title="关闭"
          aria-label="关闭"
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
                  ? `继续下滑切换「${edgePullHint.targetLabel}」`
                  : `继续上滑切换「${edgePullHint.targetLabel}」`}
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
            title="返回"
            aria-label="返回"
            onClick={closeSettingsModal}
          >
            <UiIcon name="chevron-left" />
          </button>
          <div className="settings-nav-wrap">
            <nav ref={settingsNavRef} className="settings-nav" role="tablist" aria-label="设置分区">
              {SETTINGS_TABS.map(([tabKey, iconName, label]) => (
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
                  <span>{label}</span>
                  {tabKey === "updates" && hasVisibleUpdate && (
                    <span className="settings-nav-update-dot" aria-label="有可用更新" />
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
            contextHint="远端配置暂为只读（外观与账号切换仍可用）"
            onlyWhenOffline
          />

          {/* ==================== PANE 1: 通用 ==================== */}
          <div
            className="settings-pane"
            data-settings-pane="general"
            hidden={activeTab !== "general"}
          >
            <h2 className="settings-pane-title">通用</h2>

            <fieldset
              className="remote-offline-fieldset"
              data-remote-offline-guard="profile"
              disabled={remoteAccountOffline}
            >
            <div className="settings-group-label">个人资料（本机工作台）</div>
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
                        placeholder="输入你的显示昵称"
                        aria-label="显示昵称"
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
                        保存资料
                      </button>
                    </div>
                    <div
                      className="profile-color-swatches"
                      id="profile-color-swatches"
                      role="group"
                      aria-label="头像配色"
                    >
                      {PROFILE_COLORS.map((c) => (
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
                              showToast("个人头像配色已更新");
                            } catch (err: any) {
                              showToast(`更新头像配色失败：${err?.message || "请求异常"}`);
                            }
                          }}
                        />
                      ))}
                    </div>
                    <div className="settings-row-sub" id="profile-api-status-sub">
                      {diagnostics
                        ? `${diagEnvLabel} v${diagnostics.appVersion || "1.0.0"} · ${
                            diagLlmReady ? "模型路由已就绪" : "请先完成模型接入"
                          }`
                        : "本地守护进程模式 · 模型路由已就绪"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </fieldset>

            <div className="settings-group-label">外观</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <span className="settings-row-title">主题</span>
                <select
                  id="setting-theme-select"
                  className="settings-select"
                  aria-label="主题"
                  value={settings?.theme || "system"}
                  onChange={(e) => applyThemePreference(e.target.value, true)}
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <span className="settings-row-title">强调色</span>
                <select
                  id="setting-accent-mode"
                  className="settings-select"
                  aria-label="强调色"
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
                  <option value="bot">Bot 颜色</option>
                  <option value="default">默认</option>
                </select>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <span className="settings-row-title">输入时检查拼写</span>
                <label className="ios-switch" aria-label="输入时检查拼写">
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
            <div className="settings-group-label">智能模型路由</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">模型参与路由判断</div>
                  <div className="settings-row-sub">
                    每轮先由极速档模型制定包含分步模型分配的执行计划（纯文字聊天直接走极速档），再按需调度极速档 · 中等档 · 高级档；关闭后退回关键词规则路由
                  </div>
                </div>
                <label className="ios-switch" aria-label="模型参与路由判断">
                  <input
                    id="setting-smart-router-toggle"
                    type="checkbox"
                    checked={routing.smartRouter !== false}
                    onChange={async (e) => {
                      const nextRouting = { ...routing, smartRouter: e.target.checked };
                      try {
                        await commitSettingsPatch({ routing: nextRouting });
                      } catch (err: any) {
                        showToast(`保存路由设置失败：${err?.message || "请求异常"}`);
                      }
                    }}
                  />
                  <span className="ios-switch-track" />
                </label>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">路由模式</div>
                  <div className="settings-row-sub">
                    经济：全线优先极速档，高级档最多 1 步；均衡：极速档负责日常看屏/读图与脚本，重型工程用中等档，高级档最多 3 步；质量：复杂与视觉任务优先中等档，高级档最多 5 步
                  </div>
                </div>
                <select
                  id="setting-routing-mode"
                  className="settings-select"
                  aria-label="路由模式"
                  disabled={routing.smartRouter === false}
                  value={routing.mode || "balanced"}
                  onChange={async (e) => {
                    const nextRouting = { ...routing, mode: e.target.value };
                    try {
                      await commitSettingsPatch({ routing: nextRouting });
                    } catch (err: any) {
                      showToast(`保存路由模式失败：${err?.message || "请求异常"}`);
                    }
                  }}
                >
                  <option value="economy">经济</option>
                  <option value="balanced">均衡</option>
                  <option value="quality">质量</option>
                </select>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">单轮预算上限（¥）</div>
                  <div className="settings-row-sub">
                    达到 80% 停止升级深度推理，达到 100% 不再升档（不会中断任务）
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
                  aria-label="单轮预算上限（人民币）"
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

            <div className="settings-group-label">上下文自动压缩</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">启用上下文过长自动压缩</div>
                  <div className="settings-row-sub" id="ctx-compress-summary-sub">
                    {!ctxEnabled
                      ? "已关闭（长对话将保留完整历史，可能更快触及上下文上限）"
                      : presetMeta
                        ? `已开启 · ${presetMeta.label}模式（${presetMeta.desc}）`
                        : `已开启 · 自定义（达到模型上下文窗口 ${ctxEffective.triggerPercent}% 时自动压缩）`}
                  </div>
                </div>
                <label className="ios-switch" aria-label="启用上下文过长自动压缩">
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
                <div className="ctx-presets-grid" role="group" aria-label="压缩阈值预设">
                  {[
                    {
                      id: "compact",
                      name: "省 Token",
                      desc: "窗口 50% 触发 · 更省开销",
                      pct: 50,
                    },
                    {
                      id: "balanced",
                      name: "均衡",
                      badge: "推荐",
                      desc: "窗口 75% 触发 · 兼顾记忆与成本",
                      pct: 75,
                    },
                    {
                      id: "long",
                      name: "长记忆",
                      desc: "窗口 85% 触发 · 保留更长对话",
                      pct: 85,
                    },
                  ].map((pr) => (
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
                        ctxDraftRef.current.triggerPercent = pr.pct;
                        ctxPercentDirtyRef.current = true;
                        setCtxPercentDraft(pr.pct);
                        void saveCtxCompression({ enabled: true, triggerPercent: pr.pct });
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
                  <div className="ctx-percent-header">
                    <label className="ctx-adv-label" htmlFor="setting-ctx-compress-percent">
                      触发压缩比例（上下文窗口占比）
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
                    <span>30%（更省开销）</span>
                    <span>95%（更长记忆）</span>
                  </div>
                </div>

                <details className="ctx-advanced-details" id="ctx-compress-advanced">
                  <summary className="ctx-advanced-summary">
                    <span>自定义摘要保留规则（可选）</span>
                    <span
                      className="ctx-custom-pill"
                      id="ctx-compress-custom-badge"
                      hidden={!ctxEnabled || !ctxInstructionDraft.trim()}
                    >
                      已自定义
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
                        placeholder="例如：保留所有文件路径、已执行命令结果、用户约束与未完成任务..."
                        aria-label="自定义压缩规则"
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
                全局记忆（所有 Bot 共享的长期偏好与规则）
              </div>
              <button
                id="new-memory-btn"
                type="button"
                className="settings-blue-pill"
                onClick={() => openMemoryEditor(null)}
              >
                + 新增记忆
              </button>
            </div>

            {(!memFormOpen || !editingMemId) && renderMemoryEditor(false, memFormOpen && !editingMemId)}

            <div id="global-memories-list" className="private-skills-list">
              {globalMemories.length === 0 ? (
                <div className="skills-empty">
                  暂无全局记忆。可点击右上角「+ 新增记忆」，或直接在对话中对 Bot 说「记住…」。
                </div>
              ) : (
                globalMemories.map((mem: any) => {
                  const memId = String(mem.id || mem.name);
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
                      showToast(`已移除全局记忆「${mem.name}」`);
                    } catch (err: any) {
                      showToast(`移除全局记忆失败：${err?.message || "请求异常"}`);
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
                            <div className="skill-row-name">{mem.name || "全局记忆"}</div>
                            <div className="skill-row-desc">
                              {mem.instruction || mem.content || mem.desc || ""}
                            </div>
                          </div>
                        </div>
                        <div className="private-skill-card-actions">
                          <label className="ios-switch">
                            <input
                              type="checkbox"
                              checked={mem.enabled !== false}
                              aria-label={`启用记忆 ${mem.name}`}
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
                                  showToast(`更新全局记忆状态失败：${err?.message || "请求异常"}`);
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
                            {isEditingThisMem ? "收起" : "查看 / 编辑"}
                          </button>
                          <button
                            type="button"
                            className="skill-pill-btn is-danger-text"
                            onClick={async () => {
                              if (isMobileViewport()) {
                                const ok = await showConfirmDialog({
                                  title: "删除全局记忆",
                                  message: `确定要删除全局记忆「${mem.name || "全局记忆"}」吗？`,
                                  detail: "删除后所有 Bot 将不再共享此记忆内容。",
                                  confirmText: "确认删除",
                                  cancelText: "取消",
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
                            删除
                          </button>
                        </div>
                      </div>

                      {isEditingThisMem && renderMemoryEditor(true, true)}

                      {pendingDeleteMemId === memId && (
                        <div className="skill-remove-confirm">
                          <div className="skill-remove-text">
                            确定删除全局记忆「{mem.name || "全局记忆"}」？删除后所有 Bot 将不再共享此记忆内容。
                          </div>
                          <div className="skill-remove-actions">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteMemId(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={deleteGlobalMemory}
                            >
                              确认删除
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
              <h2 className="settings-pane-title">模型接入与路由</h2>
              <button
                id="add-provider-btn"
                type="button"
                className="settings-blue-pill"
                onClick={() => openProviderEditor(null)}
              >
                + 添加供应商
              </button>
            </div>

            <div className="settings-group-label">3 档智能路由模型绑定</div>
            <div className="settings-card">
              {(
                [
                  ["fast", "tier-fast-select", "极速档（Fast）", "用于路由规划、标题/思考摘要与轻量日常对话", "极速档模型"],
                  ["medium", "tier-medium-select", "中等档（Medium）", "主力日常任务、代码编写与桌面操作执行", "中等档模型"],
                  ["advanced", "tier-advanced-select", "高级档（Advanced）", "复杂系统架构、疑难排错与跨步骤救援", "高级档模型"],
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
                        <option value="">暂无可用模型（请先启用供应商）</option>
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
                  <div className="settings-row-title">生图模型（Image）</div>
                  <div className="settings-row-sub">
                    用于绘图工具与头像生成（支持 Gemini 或 OpenAI 兼容生图模型）
                  </div>
                </div>
                <select
                  id="tier-image-select"
                  className="settings-select tier-select"
                  aria-label="生图模型"
                  value={resolveTierSelectVal("image", imageModelOptions, true)}
                  onChange={(e) => handleTierChange("image", e.target.value)}
                >
                  <option value="">未配置</option>
                  {imageModelOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="settings-group-label">
              已接入模型供应商（Google Gemini / OpenAI / DeepSeek / 自定义兼容）
            </div>

            {(!provFormOpen || !provId) && renderProviderEditor(false, provFormOpen && !provId)}

            <div id="providers-list" className="providers-list">
              {providers.length === 0 ? (
                <div className="skills-empty">
                  暂未配置模型供应商，请点击右上角「+ 添加供应商」。
                </div>
              ) : (
                providers.map((p: any) => {
                  const isEditingThisProv = provFormOpen && provId === p.id;
                  const billingCurr =
                    p.billingCurrency || (p.type === "deepseek" ? "CNY" : "USD");
                  const modelsText = (p.models || []).join(" · ") || "未指定大语言模型";
                  const imgText =
                    Array.isArray(p.imageModels) && p.imageModels.length > 0
                      ? `生图: ${p.imageModels.join(" · ")}`
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
                          ? `已移除「${p.name}」，已为你自动选好 3 档路由模型，可自行修改`
                          : `已移除供应商「${p.name}」`
                      );
                    } catch (err: any) {
                      showToast(`删除失败: ${err.message}`);
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
                                ? `Key ${p.maskedApiKey || "已配置"}`
                                : "未填 Key"}
                            </span>
                          )}
                          {p.enabled === false && (
                            <span className="provider-type-badge">已禁用</span>
                          )}
                        </div>
                        <div className="provider-card-actions">
                          <label
                            className="ios-switch"
                            title={
                              p.enabled !== false
                                ? "已启用（点击禁用）"
                                : "已禁用（点击启用）"
                            }
                          >
                            <input
                              type="checkbox"
                              checked={p.enabled !== false}
                              aria-label={`启用或禁用模型供应商 ${p.name || p.type}`}
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
                                      ? `${checked ? "已启用" : "已禁用"}「${p.name || p.type}」，已为你自动选好 3 档路由模型，可自行修改`
                                      : `${checked ? "已启用" : "已禁用"}供应商「${p.name || p.type}」`
                                  );
                                } catch (err: any) {
                                  showToast(`更新状态失败: ${err.message}`);
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
                            {isEditingThisProv ? "收起" : "查看 / 编辑"}
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
                                    ? `✓ ${p.name} 连接正常 (${res.latencyMs}ms)`
                                    : `❌ 连接失败: ${res.error}`
                                );
                              } catch (err: any) {
                                showToast(`❌ 测试失败: ${err.message}`);
                              } finally {
                                setTestingProviderId(null);
                              }
                            }}
                          >
                            {testingProviderId === p.id ? "测试中…" : "测速"}
                          </button>
                          <button
                            type="button"
                            className="skill-pill-btn is-danger-text"
                            onClick={async () => {
                              if (isMobileViewport()) {
                                const ok = await showConfirmDialog({
                                  title: "删除模型供应商",
                                  message: `确定要删除供应商「${p.name}」吗？`,
                                  detail:
                                    "删除后将清除其 API 密钥配置；若当前智能路由正使用其模型，系统会自动切换至其他可用模型。",
                                  confirmText: "确认删除",
                                  cancelText: "取消",
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
                            删除
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
                            确定删除供应商「{p.name}」？删除后将清除其密钥配置，并自动为 3 档路由切换至其他可用模型。
                          </div>
                          <div className="skill-remove-actions">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteProviderId(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={executeDeleteProvider}
                            >
                              确认删除
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
            <h2 className="settings-pane-title">电脑</h2>

            <div className="settings-group-label">你的电脑</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">在这台电脑上执行</div>
                  <div className="settings-row-sub">
                    允许 TwinkleBot 在你的电脑上打开文件并运行任务，自动审核仍会先检查所有操作：选「始终允许」时查文件、编辑普通文件、重命名移动与常规命令直接执行，仅删除、提权、改敏感配置或高危外发操作需要确认。
                  </div>
                </div>
                <select
                  id="host-exec-mode-select"
                  className="settings-select"
                  aria-label="在这台电脑上执行"
                  value={hostExecMode}
                  onChange={async (e) => {
                    const executionMode = e.target.value;
                    try {
                      await commitSettingsPatch({
                        hostComputer: { ...(settings?.hostComputer || {}), executionMode },
                      });
                    } catch (err: any) {
                      showToast(`保存宿主机执行模式失败：${err?.message || "请求异常"}`);
                    }
                  }}
                >
                  <option value="always">始终允许</option>
                  <option value="ask">每次询问</option>
                  <option value="off">从不允许</option>
                </select>
              </div>
            </div>

            {onlineCloudHosts.length > 0 && (
              <>
                <div className="settings-group-label">已连接的远程宿主机</div>
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
                            showToast("已切换目标执行宿主机");
                          }}
                        >
                          {selectedCloudHostId === h.clientId ? "当前目标" : "选择"}
                        </button>
                      </div>
                    </Fragment>
                  ))}
                </div>
              </>
            )}

            <div className="settings-group-label">管理设备</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div className="settings-account-left">
                  <span className="device-icon" aria-hidden="true">
                    <UiIcon name="laptop" />
                  </span>
                  <div>
                    <div className="settings-row-title" id="host-device-hostname">
                      {computerStatus?.hostComputer?.hostname || "本地宿主机"}
                    </div>
                    <div className="settings-row-sub" id="host-device-status-line">
                      <span className="status-dot-inline is-ok" aria-hidden="true" />
                      <span>
                        电脑 · 当前在线{hasCompProbe ? ` · ${hostModeLabel}` : ""}
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
                        "正在检测 Executor 状态…"
                      ) : computerStatus?.online ? (
                        <>
                          <span className="status-dot-inline is-ok" aria-hidden="true" />
                          在线 · {computerStatus.latencyMs ?? 0}ms ·{" "}
                          {computerStatus.screen?.width || 1440}×
                          {computerStatus.screen?.height || 900}
                        </>
                      ) : (
                        <>
                          <span className="status-dot-inline is-err" aria-hidden="true" />
                          离线（{compStatusView.settingsOfflineReason}）
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
                        showToast(`✓ Bot 的电脑在线 · ${c.latencyMs ?? 0}ms`);
                      } else if (c) {
                        showToast(`Bot 的电脑离线：${c.error || c.detail || "执行器未响应"}`);
                      } else {
                        showToast("Bot 的电脑状态检测失败");
                      }
                    } finally {
                      setDetectingComputer(false);
                    }
                  }}
                >
                  {detectingComputer ? "检测中…" : "重新检测"}
                </button>
              </div>
            </div>

            <div className="settings-group-label">Bot 的电脑</div>
            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">更新 Bot 的电脑</div>
                  <div className="settings-row-sub">
                    客户端升级后会在启动或使用 Bot 的电脑时自动同步；异常时可手动强制更新并重启服务
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
                      showToast("✓ Bot 的电脑已同步最新执行器并重启");
                    } catch (err: any) {
                      showToast(`更新失败：${err.message || "无法连接桌面执行器"}`);
                    } finally {
                      setUpdatingComputer(false);
                    }
                  }}
                >
                  {updatingComputer ? "更新中…" : "更新"}
                </button>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">重置桌面连接与在途任务</div>
                  <div className="settings-row-sub">
                    当桌面控制卡住时停止当前动作队列并重连 noVNC
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
                        showToast("✓ 已停止在途任务并重连 noVNC 桌面");
                      } else {
                        showToast(
                          `已停止在途任务，当前执行器离线（${latest?.error || res?.status?.error || "执行器未响应"}）`
                        );
                      }
                    } catch (err: any) {
                      showToast(`重置失败：${err?.message || "无法重置桌面连接"}`);
                    } finally {
                      setResettingComputer(false);
                    }
                  }}
                >
                  {resettingComputer ? "重置中…" : "重置"}
                </button>
              </div>
              {multiDisplaySupported && (
                <>
                  <div className="settings-divider" />
                  <div className="settings-item-block" id="settings-screen-pool-block">
                    <div className="settings-item-row" style={{ padding: 0 }}>
                      <div>
                        <div className="settings-row-title">同时运行屏幕上限</div>
                        <div className="settings-row-sub">
                          Bot 数量不设上限；共享主 Google Chrome 登录态并在独立浏览器窗口并发运行（每窗口支持自由多标签页），超出上限自动进入 FIFO 队列等待
                          {computerDisplays?.pool
                            ? `（当前活跃 ${computerDisplays.pool.activeCount} / ${computerDisplays.pool.maxConcurrentScreens} 屏${
                                computerDisplays.pool.queuedCount > 0
                                  ? ` · 排队 ${computerDisplays.pool.queuedCount}`
                                  : ""
                              }）`
                            : ""}
                        </div>
                      </div>
                      <span className="ctx-percent-value" id="screen-pool-limit-label">
                        {screenPoolEffective.maxConcurrentScreens} 屏
                      </span>
                    </div>

                    <div className="ctx-presets-grid">
                      {[
                        {
                          id: "min" as const,
                          name: "省资源",
                          desc: `下限 ${screenBudget.min} 屏 · 低内存占用`,
                          mode: "custom" as const,
                          val: screenBudget.min,
                        },
                        {
                          id: "balanced" as const,
                          name: "均衡",
                          badge: "默认",
                          desc: `推荐 ${screenBudget.defaultBalanced} 屏 · 兼顾并发与流畅`,
                          mode: "auto" as const,
                          val: screenBudget.defaultBalanced,
                        },
                        {
                          id: "max" as const,
                          name: "高并发",
                          desc: `上限 ${screenBudget.max} 屏 · 基于 ${screenBudget.totalMemGiB}GB/${screenBudget.cpuCores}核预算`,
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
                        <span>{screenBudget.min} 屏（配置预算下限）</span>
                        <span>{screenBudget.defaultBalanced} 屏（均衡默认）</span>
                        <span>{screenBudget.max} 屏（配置预算上限）</span>
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
            <h2 className="settings-pane-title">权限</h2>

            <div className="settings-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">自动审核自定义规则</div>
                  <div className="settings-row-sub">
                    敏感路径（.ssh / .env / 钥匙串）始终强制拦截，不可绕过
                  </div>
                </div>
                <label className="ios-switch" aria-label="自动审核">
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
                        showToast(`更新自动审核失败：${err?.message || "请求异常"}`);
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
                  <div className="settings-row-title">始终询问</div>
                  <div className="settings-row-sub">
                    工具或参数包含指定关键词时，强制弹出审批卡片
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-pill-btn"
                  id="add-ask-rule-btn"
                  onClick={() => setAskFormOpen((v) => !v)}
                >
                  + 添加规则
                </button>
              </div>

              <div
                id="ask-rule-form"
                className="custom-skill-editor settings-inline-editor"
                hidden={!askFormOpen}
              >
                <div className="custom-skill-editor-top">
                  <strong>添加「始终询问」规则</strong>
                </div>
                <div className="custom-skill-fields">
                  <div className="custom-skill-row-two">
                    <label className="field-group custom-skill-name-field">
                      <span>目标工具</span>
                      <select
                        id="ask-rule-tool"
                        value={askTool}
                        onChange={(e) => setAskTool(e.target.value)}
                      >
                        {PERMISSION_RULE_TOOLS.map(([val, label]) => (
                          <option key={val} value={val}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-group custom-skill-slug-field">
                      <span>参数匹配关键词（留空匹配全部）</span>
                      <input
                        id="ask-rule-pattern"
                        type="text"
                        placeholder="如 rm、git push、pay"
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
                    取消
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
                        showToast("询问规则已生效");
                      } catch (err: any) {
                        showToast(`保存询问规则失败：${err?.message || "请求异常"}`);
                      }
                    }}
                  >
                    保存询问规则
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
                      showToast(`移除询问规则失败：${err?.message || "请求异常"}`);
                    }
                  };
                  return (
                    <div
                      key={rule.id}
                      className={`perm-rule-chip${isEditingRule ? " is-editing" : ""}`}
                    >
                      <div className="perm-rule-chip-row">
                        <span>
                          <code>{rule.tool || "*"}</code> · {rule.pattern || "全部参数"}
                        </span>
                        {pendingDeleteRuleId === rule.id ? (
                          <span className="perm-inline-confirm">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteRuleId(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={removeAskRule}
                            >
                              确认移除
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
                              {isEditingRule ? "收起" : "编辑"}
                            </button>
                            <button
                              type="button"
                              className="section-action-link danger-text"
                              onClick={async () => {
                                if (isMobileViewport()) {
                                  const ok = await showConfirmDialog({
                                    title: "移除权限规则",
                                    message: "确定要移除这条每次询问规则吗？",
                                    detail: `${rule.tool || "*"} · ${rule.pattern || "全部参数"}`,
                                    confirmText: "确认移除",
                                    cancelText: "取消",
                                    tone: "danger",
                                  });
                                  if (ok) await removeAskRule();
                                  return;
                                }
                                setPendingDeleteRuleId(rule.id);
                              }}
                            >
                              移除
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
                  <div className="settings-row-title">无需询问直接允许</div>
                  <div className="settings-row-sub">
                    审批时点击「始终允许」也会自动保存在此处
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-pill-btn"
                  id="add-allow-rule-btn"
                  onClick={() => setAllowFormOpen((v) => !v)}
                >
                  + 添加规则
                </button>
              </div>

              <div
                id="allow-rule-form"
                className="custom-skill-editor settings-inline-editor"
                hidden={!allowFormOpen}
              >
                <div className="custom-skill-editor-top">
                  <strong>添加「始终允许」规则</strong>
                </div>
                <div className="custom-skill-fields">
                  <div className="custom-skill-row-two">
                    <label className="field-group custom-skill-name-field">
                      <span>目标工具</span>
                      <select
                        id="allow-rule-tool"
                        value={allowTool}
                        onChange={(e) => setAllowTool(e.target.value)}
                      >
                        {PERMISSION_RULE_TOOLS.map(([val, label]) => (
                          <option key={val} value={val}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-group custom-skill-slug-field">
                      <span>参数匹配关键词（留空匹配全部）</span>
                      <input
                        id="allow-rule-pattern"
                        type="text"
                        placeholder="如 /tmp/、npm test"
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
                    取消
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
                        showToast("允许规则已生效");
                      } catch (err: any) {
                        showToast(`保存允许规则失败：${err?.message || "请求异常"}`);
                      }
                    }}
                  >
                    保存允许规则
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
                      showToast(`移除允许规则失败：${err?.message || "请求异常"}`);
                    }
                  };
                  return (
                    <div
                      key={rule.id}
                      className={`perm-rule-chip${isEditingRule ? " is-editing" : ""}`}
                    >
                      <div className="perm-rule-chip-row">
                        <span>
                          <code>{rule.tool || "*"}</code> · {rule.pattern || "全部参数"}
                        </span>
                        {pendingDeleteRuleId === rule.id ? (
                          <span className="perm-inline-confirm">
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() => setPendingDeleteRuleId(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger"
                              onClick={removeAllowRule}
                            >
                              确认移除
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
                              {isEditingRule ? "收起" : "编辑"}
                            </button>
                            <button
                              type="button"
                              className="section-action-link danger-text"
                              onClick={async () => {
                                if (isMobileViewport()) {
                                  const ok = await showConfirmDialog({
                                    title: "移除权限规则",
                                    message: "确定要移除这条始终允许规则吗？",
                                    detail: `${rule.tool || "*"} · ${rule.pattern || "全部参数"}`,
                                    confirmText: "确认移除",
                                    cancelText: "取消",
                                    tone: "danger",
                                  });
                                  if (ok) await removeAllowRule();
                                  return;
                                }
                                setPendingDeleteRuleId(rule.id);
                              }}
                            >
                              移除
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
              <h2 className="settings-pane-title">保险库</h2>
              <button
                type="button"
                className="settings-blue-pill"
                id="vault-new-item-btn"
                onClick={() => openVaultEditor(null)}
              >
                + 新项目
              </button>
            </div>

            <div className="vault-toolbar-row">
              <div className="vault-tabs" role="tablist" aria-label="项目类型">
                {(
                  [
                    ["all", "全部"],
                    ["login", "账号与凭据"],
                    ["contact", "联系信息"],
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
                placeholder="搜索保险库..."
                aria-label="搜索保险库"
                value={vaultSearch}
                onChange={(e) => setState({ vaultSearch: e.target.value })}
              />
            </div>

            {(!vaultFormOpen || !editingVaultId) && renderVaultEditor(false, vaultFormOpen && !editingVaultId)}

            <div className="settings-card" id="vault-items-list">
              {filteredVault.length === 0 ? (
                <div className="settings-item-row">
                  <span className="settings-row-sub">暂无匹配项目，可点击右上角新增</span>
                </div>
              ) : (
                filteredVault.map((it: any, idx: number) => {
                  const isEditingThisVault = vaultFormOpen && editingVaultId === it.id;
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
                    showToast(`已移除「${it.title || "条目"}」`);
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
                                {it.title}
                                {it.hasPassword && (
                                  <span
                                    className="settings-row-sub"
                                    style={{ marginLeft: "6px", fontWeight: 500 }}
                                  >
                                    · 已存加密密码
                                  </span>
                                )}
                              </div>
                              <div className="settings-row-sub">{it.subtitle || ""}</div>
                            </div>
                          </div>
                          <div className="private-skill-card-actions">
                            <button
                              type="button"
                              className={`skill-pill-btn${isEditingThisVault ? " is-active" : ""}`}
                              aria-expanded={isEditingThisVault}
                              onClick={() => openVaultEditor(it)}
                            >
                              {isEditingThisVault ? "收起" : "查看 / 编辑"}
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger-text"
                              onClick={async () => {
                                if (isMobileViewport()) {
                                  const ok = await showConfirmDialog({
                                    title: "移除保险库条目",
                                    message: `确定要移除「${it.title || "此条目"}」吗？`,
                                    detail:
                                      it.subtitle ||
                                      "移除后相关登录态或个人资料将不再保存在保险库中。",
                                    confirmText: "确认移除",
                                    cancelText: "取消",
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
                              移除
                            </button>
                          </div>
                        </div>

                        {isEditingThisVault && renderVaultEditor(true, true)}

                        {pendingDeleteVaultId === it.id && (
                          <div className="skill-remove-confirm">
                            <div className="skill-remove-text">
                              确定移除保险库条目「{it.title || "此条目"}」？
                            </div>
                            <div className="skill-remove-actions">
                              <button
                                type="button"
                                className="skill-pill-btn"
                                onClick={() => setPendingDeleteVaultId(null)}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="skill-pill-btn is-danger"
                                onClick={executeDeleteVault}
                              >
                                确认移除
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
              本机 AES-256-GCM 加密存储于 data/vault.json（密钥受系统钥匙串/本机安全存储保护），明文密码绝不会发送给大模型。
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
                    ? `${scopedSessionTitle} · 执行步数`
                    : `${scopedSessionTitle} · 用量与账单`
                  : "用量与账单"}
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
                    返回用量与账单
                  </>
                ) : (
                  <>
                    <span>
                      {stepCount > 0 ? `执行步数 (${stepCount})` : "执行步数"}
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
                        ? `${scopedSessionTitle} 真实累计 Token 用量`
                        : "全部 Bot 真实累计 Token 用量"}
                    </div>
                    <div className="usage-big-stat">
                      <strong id="usage-total-tokens">{totalTok.toLocaleString()}</strong> tokens
                    </div>
                  </div>
                  <div className="usage-cost-hero-box">
                    <div className="usage-label">累计预估费用（人民币）</div>
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
                  输入 {(Number(usagePayload?.inputTokens) || 0).toLocaleString()} · 输出{" "}
                  {(Number(usagePayload?.outputTokens) || 0).toLocaleString()}
                  {extraSuffix}
                  {tailSuffix}
                </div>
              </div>

              <div className="settings-group-label">API 合并剩余余额</div>
              <div className="settings-card usage-merged-card" id="usage-merged-balance-card">
                <div className="usage-gcp-head">
                  <div className="usage-gcp-info">
                    <div className="usage-gcp-title-row">
                      <span className="settings-row-title">已启用供应商合并余额</span>
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
                          ? "汇总中"
                          : billingCards.length === 0
                            ? "无可展示供应商"
                            : mergedBilling.hasAnyBalance
                              ? `已汇总 ${mergedBilling.providersWithBalanceCount}/${mergedBilling.totalEnabledProviders} 家`
                              : "待设置或刷新"}
                      </span>
                    </div>
                    <div className="usage-reset-sub" id="usage-merged-sub">
                      {!providerBilling
                        ? "按各供应商实际结算币种核算后统一折算为人民币（¥），已禁用供应商自动隐藏"
                        : billingCards.length === 0
                          ? "当前没有已启用的模型供应商；启用后将在此展示合并余额"
                          : `按各供应商实际结算币种核算后统一折算为人民币（¥）${
                              mergedBilling.lastRefreshedAt
                                ? ` · 最近实时同步 ${formatBillingTime(mergedBilling.lastRefreshedAt)}`
                                : ""
                            }`}
                    </div>
                    <div
                      className="usage-merged-tags"
                      id="usage-merged-provider-tags"
                      hidden={mergedTags.length === 0}
                    >
                      {mergedTags.map((t: any) => (
                        <span key={t.providerId || t.providerName} className="usage-merged-tag">
                          {t.providerName}: {formatCny(t.remainingCny)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="usage-cost-hero-box">
                    <div className="usage-label">合并可用余额（人民币）</div>
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
                        {refreshingAllBilling ? "刷新中…" : "全部刷新"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-group-label">分供应商额度与余额管理</div>
              <div className="usage-provider-balance-list" id="usage-provider-balance-list">
                {providerBilling && billingCards.length === 0 ? (
                  <div className="settings-card usage-provider-card">
                    <div className="settings-row-sub">
                      当前所有模型供应商均已禁用，已隐藏其消费记录与余额卡片。
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
                        ? "刷新失败"
                        : p.status === "live_ok"
                          ? p.liveAvailable === false
                            ? "余额不足"
                            : "接口实时同步"
                          : "待刷新余额"
                      : p.remainingCny !== null
                        ? p.remainingPct != null
                          ? `已设置 · 剩 ${p.remainingPct}%`
                          : "实时扣减中"
                        : "未设置余额";

                    let metaText = "";
                    if (p.supportsLiveBalance) {
                      const subParts = [`本机累计消耗 ${formatCny(p.spentCny)}`];
                      if (p.grantedCny != null || p.toppedUpCny != null) {
                        subParts.push(
                          `赠金 ${formatCny(p.grantedCny || 0)} · 充值 ${formatCny(p.toppedUpCny || 0)}`
                        );
                      }
                      subParts.push(`上次同步：${formatBillingTime(p.lastRefreshedAt)}`);
                      metaText = subParts.join(" · ");
                    } else if (p.remainingCny !== null) {
                      const calTime = formatBillingTime(p.calibratedAt);
                      const totalTag =
                        p.totalCreditsCny != null
                          ? ` · 总额度 ${formatCny(p.totalCreditsCny)}`
                          : "";
                      metaText = `基准 ${formatCny(p.baselineRemainingCny || 0)}（${calTime}） · 之后已扣减 ${formatCny(p.deltaSinceCalibrationCny || 0)}${totalTag}`;
                    } else {
                      metaText = `本机累计消耗 ${formatCny(p.spentCny)} · 设置初始余额后自动扣减`;
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
                                  ? `${p.providerType} · CNY 计费`
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
                              {p.supportsLiveBalance ? "接口剩余余额" : "预估剩余余额"}
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
                            上次刷新异常：{p.lastError}
                            {p.remainingCny !== null ? "（当前展示最近一次成功缓存）" : ""}
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
                                        ? `✓ ${p.providerName} 余额已更新`
                                        : `刷新失败：${res.error || "请检查 API Key"}`
                                    );
                                  } catch (err: any) {
                                    setState((prev) => {
                                      const next = { ...prev.providerRefreshingIds };
                                      delete next[p.providerId];
                                      return { providerRefreshingIds: next };
                                    });
                                    showToast(`刷新失败：${err?.message || "网络异常"}`);
                                  }
                                }}
                              >
                                {isBusy ? "刷新中…" : "立即刷新余额"}
                              </button>
                              <label className="usage-provider-schedule-wrap">
                                <span>定时刷新</span>
                                <select
                                  className="usage-provider-schedule-select"
                                  aria-label={`${p.providerName} 自动刷新频率`}
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
                                          ? `已关闭 ${p.providerName} 自动刷新`
                                          : `已设 ${p.providerName} 每 ${mins} 分钟自动刷新`
                                      );
                                    } catch (err: any) {
                                      showToast(err?.message || "保存刷新周期失败");
                                    }
                                  }}
                                >
                                  <option value="0">关闭自动刷新</option>
                                  <option value="5">每 5 分钟</option>
                                  <option value="15">每 15 分钟</option>
                                  <option value="30">每 30 分钟</option>
                                  <option value="60">每 60 分钟</option>
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
                              {isCalOpen ? "收起校准" : "校准 / 设置余额"}
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

              <div className="settings-group-label">分模型消耗与费用预估</div>
              <div className="settings-card usage-models-card" id="usage-by-model-list">
                {byModel.length === 0 ? (
                  <div className="usage-session-row">
                    <span className="settings-row-sub">当前已启用供应商暂无模型消耗记录</span>
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
                        cacheR > 0 && cacheR < inR ? ` (缓存 ¥${fmtRate(cacheR)}/M)` : "";
                      const offPeakPart = m.offPeakHalfPrice ? " · 闲时半价" : "";
                      rateText = `¥${fmtRate(inR)}/M 输入${cacheRatePart} · ¥${fmtRate(outR)}/M 输出${offPeakPart}`;
                    }
                    const inpCount = Number(m.inputTokens) || 0;
                    const cachedCount = Number(m.cachedTokens) || 0;
                    const cacheHitPct = inpCount > 0 ? Math.round((cachedCount / inpCount) * 100) : 0;
                    const cachePart =
                      cachedCount > 0
                        ? `（缓存命中 ${cachedCount.toLocaleString()} · ${cacheHitPct}%）`
                        : "";
                    const thoughtPart =
                      m.thoughtTokens > 0
                        ? `（含思考 ${Number(m.thoughtTokens).toLocaleString()}）`
                        : "";
                    const callPart = m.calls > 0 ? `${m.calls} 次调用 · ` : "";

                    return (
                      <div key={m.model} className="usage-model-row">
                        <div className="usage-model-head">
                          <div className="usage-model-title-wrap">
                            <span
                              className={`model-accent-dot model-accent-${m.accent || "blue"}`}
                            />
                            <span className="usage-model-name">{m.label || m.model}</span>
                            <span className="usage-model-role">
                              {m.role || "自动路由模型"}
                            </span>
                            <span className="usage-model-rate">{rateText}</span>
                          </div>
                          <div className="usage-model-cost-col">
                            <div className="usage-model-cost-usd">{formatCny(m.costCny)}</div>
                          </div>
                        </div>
                        <div className="usage-model-metrics">
                          <span>
                            {callPart}输入 {inpCount.toLocaleString()}
                            {cachePart} · 输出 {(Number(m.outputTokens) || 0).toLocaleString()}
                            {thoughtPart}
                          </span>
                          <span>
                            共 {(Number(m.totalTokens) || 0).toLocaleString()} tok ({m.sharePct || 0}
                            %)
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
                各 Bot / 群聊消耗排行
              </div>
              <div
                className="settings-card usage-sessions-card"
                id="usage-by-session-list"
                hidden={isSessionScope}
              >
                {bySession.length === 0 ? (
                  <div className="usage-session-row">
                    <span className="settings-row-sub">暂无会话消耗记录</span>
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
                各模型按对应供应商结算币种（CNY / USD）独立计费，界面统一按 ¥ 人民币实时折算并汇总显示；禁用的供应商及其消费与余额不会展示。
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
              <h2 className="settings-pane-title">关于与诊断</h2>
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
                <span>刷新诊断</span>
              </button>
            </div>

            <div className="settings-group-label">版本检测与热更新</div>
            <div className="settings-card ota-update-card">
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title" id="ota-shell-version-line">
                    {(() => {
                      const lm = updateState?.localMeta;
                      const plat = lm?.platform || "desktop";
                      const platLabel =
                        plat === "ios"
                          ? "iOS 原生壳"
                          : plat === "android"
                            ? "Android 原生壳"
                            : plat === "desktop"
                              ? lm?.supportsCoreOta
                                ? "桌面端原生壳（独立可升级架构）"
                                : "桌面端壳（含内嵌后端）"
                              : "Web 浏览器端";
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
                      const tag = lm?.usingBuiltIn === false ? "热更新生效中" : "随包内置基线";
                      if (lm?.supportsCoreOta) {
                        return `核心运行时：${cb}（含本地 Node 服务、前端与执行器 · ${tag}）`;
                      }
                      return `前端资源：${wb}（${tag}）`;
                    })()}
                  </div>
                  {updateState?.lastCheckedAt > 0 && (
                    <div className="settings-row-sub">
                      上次检查：{formatBillingTime(updateState.lastCheckedAt)}
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
                          showToast("当前已是最新版本");
                        } else if (res.status === "ota-available") {
                          showToast(
                            res.otaKind === "core"
                              ? "发现 Core 运行时热更新包（本地服务 + 前端 + 执行器），可一键平滑升级"
                              : "发现纯前端热更新包，可一键生效"
                          );
                        }
                      });
                    }}
                  >
                    {updateState?.checking ? "检查中…" : "检查更新"}
                  </button>
                </div>
              </div>

              {Boolean(updateState?.localMeta?.lastRollbackReason) && (
                <>
                  <div className="settings-divider" />
                  <div className="mail-feedback-box is-error ota-inline-banner">
                    自愈回滚保护已触发：{updateState.localMeta?.lastRollbackReason}
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
                            ? `新版本 ${updateState.localMeta.deferredSwitch.buildId} 已下载就绪；当前有 ${updateState.localMeta.deferredSwitch.activeRunCount} 个 Bot 正在运行，空闲后将自动平滑切换`
                            : "正在更新…")}
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
                              showToast(`强制切换失败: ${err?.message || "未知错误"}`);
                            });
                          }}
                        >
                          立即强制重启切换
                        </button>
                        <button
                          type="button"
                          id="cancel-deferred-core-ota-btn"
                          className="settings-pill-btn"
                          disabled={Boolean(updateState?.applying)}
                          onClick={() => {
                            void cancelDeferredCoreOta().then(() => {
                              showToast("已取消待切换的核心更新");
                            });
                          }}
                        >
                          取消
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
                              ? "发现兼容的 Core 运行时热更新（本地服务 + 前端 + 执行器）"
                              : "发现兼容的纯前端热更新"
                            : updateDecision.status === "reload-required"
                              ? "前端资源已更新"
                              : `发现新版安装包 v${updateDecision.shellUpdate?.latestVersion || ""}`}
                        </span>
                        <span className="provider-type-badge is-gcp-vertex">
                          {updateDecision.status === "ota-available"
                            ? "GitHub Releases · 免重装"
                            : "GitHub Releases"}
                        </span>
                      </div>
                      {(updateDecision.coreBundle || updateDecision.otaBundle) && (
                        <span className="ota-offer-sub">
                          目标构建：
                          {updateDecision.coreBundle?.coreBuild ||
                            updateDecision.otaBundle?.webBuild}{" "}
                          ·{" "}
                          {Math.max(
                            1,
                            Math.round(
                              ((updateDecision.coreBundle?.sizeBytes ??
                                updateDecision.otaBundle?.sizeBytes) ||
                                0) / 1024
                            )
                          )}{" "}
                          KB
                        </span>
                      )}
                      {updateDecision.resolvedAsset?.fileName && (
                        <span className="ota-offer-sub">
                          安装包：{updateDecision.resolvedAsset.fileName}
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
                                  showToast(
                                    "新版本已下载就绪，当前 Bot 任务结束后将自动平滑切换"
                                  );
                                }
                              })
                              .catch((err: any) => {
                                showToast(`热更新失败: ${err?.message || "未知错误"}`);
                              });
                          }}
                        >
                          {updateState?.applying
                            ? "热更新中…"
                            : updateState?.progress?.phase === "waiting_idle" ||
                                updateState?.localMeta?.deferredSwitch
                              ? "已就绪 · 等待空闲自动切换"
                              : updateDecision.otaKind === "core"
                                ? "立即热更新并平滑切换"
                                : "立即热更新并生效"}
                        </button>
                      )}
                      {updateDecision.status === "reload-required" && (
                        <button
                          type="button"
                          className="skill-pill-btn is-primary"
                          onClick={() => window.location.reload()}
                        >
                          立即刷新页面
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
                              showToast(`下载失败: ${err?.message || "请前往 Release 页面手动下载"}`);
                            });
                          }}
                        >
                          {updateDecision.status === "shell-update-required"
                            ? "下载新版安装包"
                            : `同步下载新版原生壳 v${updateDecision.optionalShellUpdate?.latestVersion || ""}`}
                        </button>
                      )}
                      <button
                        type="button"
                        className="section-action-link"
                        onClick={() => dismissCurrentUpdateNotice()}
                      >
                        暂不提醒
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="settings-group-label">运行时与接口连通性</div>
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
                      ? `Node.js ${diagnostics.nodeVersion || ""} · 当前管理 ${diagnostics.sessionCount ?? 0} 个会话`
                      : "正在读取本机运行时信息…"}
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
                  <span>{diagLlmReady ? "模型已就绪" : "未配置模型"}</span>
                </span>
              </div>
              {Boolean(updateState?.connectedNodeStatus?.nodeOutdated) && (
                <>
                  <div className="settings-divider" />
                  <div className="mail-feedback-box ota-inline-banner" id="connected-node-outdated-banner">
                    当前所连服务端节点（v{updateState.connectedNodeStatus?.nodeVersion}）落后于 GitHub 最新服务端版本（v
                    {updateState.connectedNodeStatus?.latestBackendVersion}）；基线对话与核心功能不受影响，如需使用新版专属后端特性请在对应主机升级服务。
                  </div>
                </>
              )}
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">桌面执行器 (Ubuntu Executor)</div>
                  <div className="settings-row-sub" id="diag-executor-line">
                    {!diagnostics ? (
                      "正在检测…"
                    ) : diagExecOnline ? (
                      <>
                        <span className="status-dot-inline is-ok" aria-hidden="true" />{" "}
                        在线 ({diagExecUrl}) · 响应延迟 {diagnostics.executorLatencyMs ?? 0}ms
                      </>
                    ) : (
                      <>
                        <span className="status-dot-inline is-err" aria-hidden="true" />{" "}
                        离线 ({diagExecUrl}) · {diagnostics.executorError || "无响应"}
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">已启用模型池</div>
                  <div className="settings-row-sub" id="diag-models-line">
                    {!diagnostics
                      ? "正在读取已启用模型…"
                      : diagAllModels.length > 0
                        ? diagAllModels.join(" · ")
                        : "暂未启用任何模型（请在「模型接入与路由」中配置并启用）"}
                  </div>
                </div>
              </div>
              <div className="settings-divider" />
              <div className="settings-item-row">
                <div>
                  <div className="settings-row-title">安全允许写入根目录</div>
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
