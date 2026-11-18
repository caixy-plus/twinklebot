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
import {
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
  createInitialState,
  getState,
  reduceSessionEvent,
  resetStoreForTest,
  setState,
  type AppState,
  type StreamItem,
} from "./state/store.js";

export {
  apiFetch,
  createInitialState,
  dismissLanOfflineModal,
  getState,
  markLanReachable,
  reduceSessionEvent,
  reloadWorkspaceForActiveAccount,
  resetStoreForTest,
  retryActiveLanConnection,
  setState,
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
