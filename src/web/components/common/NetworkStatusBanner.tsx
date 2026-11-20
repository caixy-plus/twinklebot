import { useEffect, useState } from "react";
import { isMobileViewport } from "../../mobile-ui.js";
import {
  dismissWeakNetworkBanner,
  getActiveAccountMeta,
} from "../../services/network-monitor.js";
import { reconnectRealtimeNow } from "../../services/realtime.js";
import { setState, useStore } from "../../state/store.js";

export interface NetworkStatusBannerProps {
  placement?: "stage" | "mobile-list" | "modal";
  contextHint?: string;
  onlyWhenOffline?: boolean;
}

function formatLatencyText(rttMs: number | null): string {
  if (!rttMs || !Number.isFinite(rttMs) || rttMs <= 0) return "";
  if (rttMs >= 1000) return `${(rttMs / 1000).toFixed(1)}s`;
  return `${Math.round(rttMs)}ms`;
}

export function NetworkStatusBanner({
  placement = "stage",
  contextHint = "",
  onlyWhenOffline = false,
}: NetworkStatusBannerProps) {
  const networkHealth = useStore((s) => s.networkHealth);
  const lanNodeOffline = useStore((s) => s.lanNodeOffline);
  const accountsState = useStore((s) => s.accountsState);
  const [retrying, setRetrying] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  const accMeta = getActiveAccountMeta({
    accountsState,
    networkHealth,
    lanNodeOffline,
  } as any);

  const effectiveStatus =
    accMeta.type === "lan" && lanNodeOffline && networkHealth.status !== "recovered"
      ? "offline"
      : networkHealth.status;

  const isVisible =
    effectiveStatus !== "online" &&
    !(effectiveStatus === "weak" && networkHealth.dismissedWeakBanner) &&
    (!onlyWhenOffline || effectiveStatus === "offline" || effectiveStatus === "reconnecting");

  // Tick countdown once per second while reconnecting with a scheduled retry timestamp
  useEffect(() => {
    if (effectiveStatus !== "reconnecting" || !networkHealth.nextRetryAt) return;
    setNowTs(Date.now());
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [effectiveStatus, networkHealth.nextRetryAt]);

  if (!isVisible) return null;

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await reconnectRealtimeNow();
    } finally {
      setRetrying(false);
    }
  };

  const handleSwitchAccount = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (isMobileViewport()) {
      setState((prev) => ({
        settingsModal: { ...prev.settingsModal, open: false },
        appsModalOpen: false,
        openPopover: null,
        mobileSheets: { ...prev.mobileSheets, settingsOpen: false, nodeOpen: true },
      }));
    } else {
      setState((prev) => ({
        settingsModal: { ...prev.settingsModal, open: false },
        appsModalOpen: false,
        openPopover: "account",
      }));
    }
  };

  const accountLabel = accMeta.label;
  const showSwitchBtn =
    !networkHealth.browserOffline &&
    (accMeta.hasOtherAccounts || accMeta.type === "lan");

  let message = "";
  if (effectiveStatus === "weak") {
    const rttText = formatLatencyText(networkHealth.rttMs);
    message = rttText
      ? `当前网络较慢（${rttText}），响应可能变慢`
      : "当前网络较慢，响应可能变慢";
  } else if (effectiveStatus === "reconnecting") {
    if (retrying) {
      message = `正在重连${accountLabel}…`;
    } else {
      const remainSec = networkHealth.nextRetryAt
        ? Math.max(1, Math.ceil((networkHealth.nextRetryAt - nowTs) / 1000))
        : null;
      const attemptPart =
        networkHealth.reconnectAttempt > 0
          ? `第 ${networkHealth.reconnectAttempt} 次${remainSec ? `，${remainSec}s 后` : ""}`
          : "";
      message = `与${accountLabel}连接中断，正在重连${attemptPart ? `（${attemptPart}）` : ""}`;
    }
  } else if (effectiveStatus === "offline") {
    if (retrying) {
      message = "正在重新连接…";
    } else if (networkHealth.browserOffline) {
      message = "当前无网络连接，请检查网络设置";
    } else {
      message = `无法连接至${accountLabel}`;
    }
    if (contextHint && !retrying) {
      message = `${message}，${contextHint}`;
    }
  } else if (effectiveStatus === "recovered") {
    message = "连接已恢复，已同步最新状态";
  }

  return (
    <div
      className={`network-status-banner-wrap is-placement-${placement}`}
      data-network-banner-placement={placement}
    >
      <div
        className="network-status-banner"
        data-network-status={effectiveStatus}
        role="status"
        aria-live="polite"
      >
        <div className="network-status-banner-main">
          <span
            className={`network-status-dot${
              effectiveStatus === "weak" || effectiveStatus === "reconnecting"
                ? " is-pulsing"
                : ""
            }`}
            aria-hidden="true"
          />
          <span className="network-status-banner-text">{message}</span>
        </div>

        {effectiveStatus !== "recovered" && (
          <div className="network-status-banner-actions">
            {effectiveStatus === "weak" && (
              <button
                type="button"
                className="network-status-pill-btn"
                data-network-action="dismiss"
                onClick={() => dismissWeakNetworkBanner()}
              >
                收起
              </button>
            )}
            {effectiveStatus === "reconnecting" && (
              <>
                <button
                  type="button"
                  className="network-status-pill-btn"
                  data-network-action="retry"
                  disabled={retrying}
                  onClick={handleRetry}
                >
                  {retrying ? "重连中…" : "立即重连"}
                </button>
                {showSwitchBtn && (
                  <button
                    type="button"
                    className="network-status-pill-btn"
                    data-network-action="switch-account"
                    onClick={handleSwitchAccount}
                  >
                    切换账号
                  </button>
                )}
              </>
            )}
            {effectiveStatus === "offline" && (
              <>
                <button
                  type="button"
                  className="network-status-pill-btn"
                  data-network-action="retry"
                  disabled={retrying}
                  onClick={handleRetry}
                >
                  {retrying ? "重连中…" : "重新连接"}
                </button>
                {showSwitchBtn && (
                  <button
                    type="button"
                    className="network-status-pill-btn"
                    data-network-action="switch-account"
                    onClick={handleSwitchAccount}
                  >
                    切换账号
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
