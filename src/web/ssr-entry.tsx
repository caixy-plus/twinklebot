import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./components/App.js";
import {
  ApprovalCard,
  BotExchangePill,
  ChoiceCard,
  CredentialCard,
  DraftCard,
} from "./components/chat/InteractiveCards.js";
import { MarkdownRenderer } from "./components/chat/MarkdownRenderer.js";
import { MarkupPreviewCard } from "./components/chat/MarkupPreviewCard.js";
import { MessageGroup } from "./components/chat/MessageGroup.js";
import { UiIcon } from "./components/common/Icon.js";
import { formatErrorNotice } from "./state/helpers.js";
import {
  dismissSessionErrorCard,
  refreshActiveAccountConnection,
  reloadWorkspaceForActiveAccount,
  retryActiveLanConnection,
} from "./services/actions.js";
import {
  apiFetch,
  dismissLanOfflineModal,
  markLanReachable,
  triggerLanUnreachableFallback,
} from "./services/api-client.js";
import {
  clearNetworkMonitorTimers,
  computeReconnectDelayMs,
  dismissWeakNetworkBanner,
  getActiveAccountMeta,
  getNetworkThresholds,
  handleBrowserOnlineChange,
  isRemoteAccountOffline,
  reportHeartbeatRtt,
  reportHeartbeatTimeout,
  reportHttpOutcome,
  reportHttpSlowInFlight,
  reportTransportConnected,
  reportTransportDisconnected,
  resetNetworkHealthForAccountSwitch,
  shouldShowAccountDisconnectedGate,
} from "./services/network-monitor.js";
import {
  connectGlobalSse,
  connectRealtimeTransport,
  disconnectRealtimeTransport,
  handleRealtimePayload,
  probeActiveTransportOnResume,
  reconnectRealtimeNow,
} from "./services/realtime.js";
import {
  createInitialState,
  getState,
  reduceSessionEvent,
  resetStoreForTest,
  runtimeRefs,
  setState,
  type AppState,
  type StreamItem,
} from "./state/store.js";

export {
  apiFetch,
  clearNetworkMonitorTimers,
  computeReconnectDelayMs,
  connectGlobalSse,
  connectRealtimeTransport,
  createInitialState,
  disconnectRealtimeTransport,
  dismissLanOfflineModal,
  dismissSessionErrorCard,
  dismissWeakNetworkBanner,
  getActiveAccountMeta,
  getNetworkThresholds,
  getState,
  handleBrowserOnlineChange,
  handleRealtimePayload,
  isRemoteAccountOffline,
  markLanReachable,
  probeActiveTransportOnResume,
  reconnectRealtimeNow,
  reduceSessionEvent,
  refreshActiveAccountConnection,
  reloadWorkspaceForActiveAccount,
  reportHeartbeatRtt,
  reportHeartbeatTimeout,
  reportHttpOutcome,
  reportHttpSlowInFlight,
  reportTransportConnected,
  reportTransportDisconnected,
  resetNetworkHealthForAccountSwitch,
  resetStoreForTest,
  retryActiveLanConnection,
  runtimeRefs,
  setState,
  shouldShowAccountDisconnectedGate,
  triggerLanUnreachableFallback,
};

export function renderAppToStaticMarkup(overrides?: Partial<AppState>): string {
  resetStoreForTest(overrides);
  return renderToStaticMarkup(<App />);
}

export function renderStreamItemToStaticMarkup(
  item: StreamItem,
  overrides?: Partial<AppState>
): string {
  resetStoreForTest(overrides);
  switch (item.kind) {
    case "message":
      return renderToStaticMarkup(<MessageGroup item={item} />);
    case "choice":
      return renderToStaticMarkup(<ChoiceCard item={item} />);
    case "approval":
      return renderToStaticMarkup(<ApprovalCard item={item} />);
    case "draft":
      return renderToStaticMarkup(<DraftCard item={item} />);
    case "credential":
      return renderToStaticMarkup(<CredentialCard item={item} />);
    case "bot_exchange":
      return renderToStaticMarkup(<BotExchangePill item={item} />);
    case "route_notice":
      if (item.level === "max_steps") {
        return renderToStaticMarkup(
          <div className="confirm-card max-steps-card" role="status">
            <div className="confirm-header max-steps-header">
              <span>已达单轮步数上限</span>
            </div>
            <div className="max-steps-body">{item.text}</div>
          </div>
        );
      }
      return renderToStaticMarkup(
        <div className="route-notice-pill" role="status">
          {item.text || "本轮费用已接近预算上限"}
        </div>
      );
    case "error": {
      const formatted = formatErrorNotice(item.message || "");
      return renderToStaticMarkup(
        <div className="error-card" role="alert">
          <div className="error-card-main">
            <span className="error-card-icon" aria-hidden="true">
              <UiIcon name="alert-triangle" size={14} />
            </span>
            <div className="error-card-body">{formatted.summary}</div>
            <button
              type="button"
              className="error-card-close-btn"
              aria-label="关闭提示"
              title="关闭提示"
            >
              <UiIcon name="x" size={12} />
            </button>
          </div>
          {formatted.detail && (
            <details className="error-card-details">
              <summary className="error-card-details-summary">查看详情</summary>
              <pre className="error-card-raw">{formatted.detail}</pre>
            </details>
          )}
        </div>
      );
    }
    case "unread_divider":
      return renderToStaticMarkup(
        <div className="unread-divider">
          <span>以下为新消息</span>
        </div>
      );
    case "date_divider":
      return renderToStaticMarkup(
        <div className="date-divider">
          <span>{item.label}</span>
        </div>
      );
    default:
      return "";
  }
}

export function renderMarkdownToStaticMarkup(text: string): string {
  return renderToStaticMarkup(<MarkdownRenderer text={text} />);
}

export function renderMarkupPreviewToStaticMarkup(props: {
  code: string;
  kind?: "html" | "svg";
  badgeLabel?: string;
  lang?: string;
  sourceLabel?: string;
  downloadUrl?: string;
}): string {
  return renderToStaticMarkup(<MarkupPreviewCard {...props} />);
}
