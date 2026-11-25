import {
  Fragment,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { parsePromptToAvatar } from "../../avatars.js";
import { useAnimatedSheet } from "../../hooks/useAnimatedSheet.js";
import { useChatScrollPin } from "../../hooks/useChatScrollPin.js";
import {
  isMobileViewport,
  syncMobileChatBottomMetrics,
} from "../../mobile-ui.js";
import {
  clearSessionHistory,
  closeAllPopovers,
  closeNewChatBar,
  continueFromMaxSteps,
  deleteSessionWithConfirm,
  dismissSessionErrorCard,
  openSettingsModal,
  refreshLibrary,
  refreshSchedules,
  selectSession,
  showToast,
  uploadAndStageFiles,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { useI18n } from "../../services/i18n.js";
import { STATUS_LABELS } from "../../state/constants.js";
import {
  computeClientSessionSummary,
  formatClockTime,
  formatCny,
  formatErrorNotice,
  isSessionCurrentlyBusy,
} from "../../state/helpers.js";
import {
  getActiveSessionFromState,
  setState,
  useStore,
  type StreamItem,
} from "../../state/store.js";
import { AvatarNode, MascotSvg, SessionAvatar } from "../common/AvatarView.js";
import { UiIcon } from "../common/Icon.js";
import { NetworkStatusBanner } from "../common/NetworkStatusBanner.js";
import { TraceEventsList } from "../common/SharedPanels.js";
import { Composer } from "./Composer.js";
import {
  ApprovalCard,
  BotExchangePill,
  ChoiceCard,
  CredentialCard,
  DraftCard,
} from "./InteractiveCards.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { MessageGroup } from "./MessageGroup.js";

export function ChatStage({
  chatStageRef,
  onToggleInspector,
}: {
  chatStageRef: RefObject<HTMLElement | null>;
  onToggleInspector: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const activeSession = useStore((s) => getActiveSessionFromState(s));
  const activeSessionId = useStore((s) => s.activeSessionId);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const streamItems = useStore((s) => s.streamItems);
  const isReplaying = useStore((s) => s.isReplaying);
  const autoScrollPinned = useStore((s) => s.autoScrollPinned);
  const openPopover = useStore((s) => s.openPopover);
  const selectionToolbar = useStore((s) => s.selectionToolbar);
  const newChatBarOpen = useStore((s) => s.newChatBarOpen);
  const newChatGroupMode = useStore((s) => s.newChatGroupMode);
  const newChatRecipients = useStore((s) => s.newChatRecipients);
  const newChatQuery = useStore((s) => s.newChatQuery);
  const botExchangeSheet = useStore((s) => s.botExchangeSheet);
  const traceDrawerOpen = useStore((s) => s.traceDrawerOpen);
  const stepCount = useStore((s) => s.stepCount);
  const settings = useStore((s) => s.settings);
  const usage = useStore((s) => s.usage);
  const sessionUsageByModel = useStore((s) => s.sessionUsageByModel);
  const sessionUsageByProviderModel = useStore((s) => s.sessionUsageByProviderModel);
  const lastObservedModel = useStore((s) => s.lastObservedModel);

  const [isDragOver, setIsDragOver] = useState(false);
  const eventStreamRef = useRef<HTMLDivElement | null>(null);
  const closeExchangeSheet = () =>
    setState((prev) => ({
      botExchangeSheet: { ...prev.botExchangeSheet, open: false },
    }));
  const exchangeAnim = useAnimatedSheet(botExchangeSheet.open, closeExchangeSheet, { axis: "y" });
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  const newChatInputRef = useRef<HTMLInputElement | null>(null);

  useChatScrollPin(eventStreamRef, composerWrapRef);

  const isPrimaryOrAdmin = Boolean(
    activeSession &&
      (activeSession.isAdmin || (primarySessionId && activeSession.id === primarySessionId))
  );
  const { locale, t, tStatus } = useI18n();
  const displayName =
    activeSession?.title && activeSession.title !== "New Session"
      ? activeSession.title
      : isPrimaryOrAdmin
        ? "Twinkle"
        : t("actions.newBotFallback");
  const statusKey = sessionStatus || "idle";
  const statusLabel = tStatus(statusKey) || STATUS_LABELS[statusKey] || statusKey;
  const busy = isSessionCurrentlyBusy(statusKey);

  const costSummary = computeClientSessionSummary({
    providers: settings?.providers || [],
    sessionUsageByProviderModel,
    sessionUsageByModel,
    usage,
    lastObservedModel,
    locale,
  });

  // New Chat Bar calculations
  const isMulti = newChatGroupMode || newChatRecipients.length > 0;
  const qTrim = newChatQuery.trim();
  const qLower = qTrim.toLowerCase();
  const dmBots = sessions
    .filter(
      (s: any) =>
        s.type !== "group" &&
        !newChatRecipients.some((r: any) => r.id === s.id) &&
        (!qLower || String(s.title || "").toLowerCase().includes(qLower))
    )
    .slice(0, 9);

  const handleCreateSingleBot = async () => {
    const title = qTrim || t("chat.newBotWithIndex", { index: sessions.length });
    const av = parsePromptToAvatar(title);
    const created = await apiJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title, avatar: av }),
    });
    closeNewChatBar();
    upsertLocalSession(created);
    await selectSession(created.id);
    (document.getElementById("inspector-bot-name-input") as HTMLInputElement | null)?.focus();
  };

  const handleCommitGroup = async () => {
    if (newChatRecipients.length < 2) return;
    const names = newChatRecipients.map((b: any) => b.title).join(locale === "en" ? ", " : "、");
    const group = await apiJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: t("chat.groupTitleTemplate", { names: names.slice(0, 22) }),
        type: "group",
        memberBotIds: newChatRecipients.map((b: any) => b.id),
      }),
    });
    closeNewChatBar();
    upsertLocalSession(group);
    await selectSession(group.id);
    (document.getElementById("message-input") as HTMLTextAreaElement | null)?.focus();
  };

  const handleNewChatKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !newChatQuery && newChatRecipients.length > 0) {
      setState((prev) => ({
        newChatRecipients: prev.newChatRecipients.slice(0, -1),
      }));
    } else if (e.key === "Escape") {
      closeNewChatBar();
    } else if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
      const idx = Number(e.key) - 1;
      const targetBot = dmBots[idx];
      if (targetBot) {
        e.preventDefault();
        if (isMulti) {
          setState((prev) => ({
            newChatRecipients: [...prev.newChatRecipients, targetBot],
            newChatQuery: "",
          }));
          newChatInputRef.current?.focus();
        } else {
          closeNewChatBar();
          selectSession(targetBot.id);
        }
      }
    }
  };

  const handleStreamMouseUp = () => {
    setTimeout(() => {
      if (typeof window === "undefined") return;
      const sel = window.getSelection();
      const raw = sel ? sel.toString().trim() : "";
      const streamEl = eventStreamRef.current;
      if (!raw || !sel || !sel.rangeCount || !streamEl || !streamEl.contains(sel.anchorNode)) {
        return;
      }
      const anchorEl: any =
        sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
      if (anchorEl?.closest?.("input, textarea")) return;

      const snippet = raw.slice(0, 280);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const top = Math.max(12, rect.top - 42);
      const left = Math.min(
        window.innerWidth - 150,
        Math.max(12, rect.left + rect.width / 2 - 64)
      );
      setState({
        selectionToolbar: { open: true, x: left, y: top, snippet },
      });
    }, 10);
  };

  const handleDragOver = (e: DragEvent<HTMLElement>) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      if (!isDragOver) setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLElement>) => {
    setIsDragOver(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length > 0) {
      e.preventDefault();
      await uploadAndStageFiles(files);
    }
  };

  const stageCls = [
    "chat-stage",
    busy ? "has-live-bubble" : "",
    isDragOver ? "is-dragover" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      ref={chatStageRef}
      className={stageCls}
      aria-label={t("chat.stageAria")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Standard Stage Header */}
      <header className="stage-header" id="stage-header">
        <button
          id="mobile-back-btn"
          type="button"
          className="mobile-circle-btn mobile-only"
          title={t("chat.backToList")}
          aria-label={t("chat.backToList")}
          onClick={() => setState({ mobileView: "list" })}
        >
          <UiIcon name="chevron-left" />
        </button>
        <div className="stage-header-spacer" />

        <button
          id="header-bot-pill"
          type="button"
          className="stage-bot-pill"
          title={t("chat.viewInspector")}
          aria-label={t("chat.viewInspector")}
          onClick={() => {
            if (isMobileViewport()) {
              refreshSchedules();
              refreshLibrary();
              setState((prev) => ({
                mobileSheets: {
                  ...prev.mobileSheets,
                  inspectorOpen: true,
                  inspectorTab: "activity",
                },
              }));
            } else {
              onToggleInspector();
            }
          }}
        >
          <span className="header-bot-avatar" id="header-bot-avatar">
            {activeSession ? (
              <SessionAvatar
                session={activeSession}
                allSessions={sessions}
                primaryId={primarySessionId}
                sizeVariant="sm"
              />
            ) : (
              <MascotSvg shapeKey="blob" colorKey="black" />
            )}
          </span>
          <span className="stage-bot-name" id="header-bot-name">
            {displayName}
          </span>
          <span
            id="status-badge"
            className="inline-status-chip"
            data-status={statusKey}
            aria-live="polite"
          >
            <span className="status-dot" aria-hidden="true" />
            <span id="status-text" className="status-state">
              {statusLabel}
            </span>
          </span>
        </button>

        <div className="stage-header-actions">
          <button
            id="mobile-inspector-btn"
            type="button"
            className="mobile-circle-btn mobile-only"
            title={t("chat.moreActions")}
            aria-label={t("chat.moreActions")}
            aria-expanded={openPopover === "mobile-more" ? "true" : "false"}
            onClick={(e) => {
              e.stopPropagation();
              const nextOpen = openPopover !== "mobile-more";
              closeAllPopovers();
              if (nextOpen) setState({ openPopover: "mobile-more" });
            }}
          >
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="5" cy="10" r="1.4" fill="currentColor" />
              <circle cx="10" cy="10" r="1.4" fill="currentColor" />
              <circle cx="15" cy="10" r="1.4" fill="currentColor" />
            </svg>
          </button>

          <div
            id="mobile-more-popover"
            className="floating-menu mobile-more-popover"
            aria-label={t("chat.moreActions")}
            hidden={openPopover !== "mobile-more"}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="menu-item-row"
              data-mobile-more-action="inspector"
              onClick={() => {
                setState((prev) => ({
                  openPopover: null,
                  mobileSheets: {
                    ...prev.mobileSheets,
                    inspectorOpen: true,
                    inspectorTab: "activity",
                  },
                }));
                refreshSchedules();
                refreshLibrary();
              }}
            >
              <span className="menu-item-leading">{t("chat.openInspector")}</span>
            </button>
            <button
              type="button"
              className="menu-item-row"
              data-mobile-more-action="clear"
              onClick={() => {
                setState({ openPopover: null });
                if (activeSessionId) clearSessionHistory(activeSessionId);
              }}
            >
              <span className="menu-item-leading">{t("chat.clearSession")}</span>
            </button>
            <div className="menu-divider" hidden={Boolean(activeSession?.isAdmin)} />
            <button
              type="button"
              className="menu-item-row danger-text"
              data-mobile-more-action="delete"
              hidden={Boolean(activeSession?.isAdmin)}
              onClick={async () => {
                setState({ openPopover: null });
                if (activeSessionId) {
                  await deleteSessionWithConfirm(activeSessionId);
                  if (isMobileViewport()) {
                    setState({ mobileView: "list" });
                  }
                }
              }}
            >
              <span className="menu-item-leading">{t("chat.deleteBot")}</span>
            </button>
          </div>

          <button
            id="clear-session-btn"
            type="button"
            className="share-pill-btn clear-session-btn"
            title={t("chat.clearTooltip")}
            aria-label={t("chat.clearTooltip")}
            onClick={() => {
              if (activeSessionId) clearSessionHistory(activeSessionId);
            }}
          >
            <svg
              className="icon-svg clear-session-icon"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4.5 6.2h11M8 6.2V4.7a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6.3 6.2l.65 9.1a1.5 1.5 0 0 0 1.5 1.4h3.1a1.5 1.5 0 0 0 1.5-1.4l.65-9.1"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="clear-session-label">{t("chat.clearShort")}</span>
          </button>

          <button
            id="share-btn"
            type="button"
            className="share-pill-btn"
            onClick={(e) => {
              e.stopPropagation();
              const nextOpen = openPopover !== "share";
              closeAllPopovers();
              if (nextOpen) setState({ openPopover: "share" });
            }}
          >
            {t("chat.shareBtn")}
          </button>

          <div
            id="share-popover"
            className="floating-menu share-popover"
            aria-label={t("chat.shareBtn")}
            hidden={openPopover !== "share"}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              id="share-template-item"
              type="button"
              className="share-menu-card"
              onClick={async () => {
                setState({ openPopover: null });
                if (!activeSessionId) return;
                const cloned = await apiJson(`/api/sessions/${activeSessionId}/clone`, {
                  method: "POST",
                });
                upsertLocalSession(cloned);
                await selectSession(cloned.id);
                showToast(t("chat.clonedToast", { title: cloned.title }));
              }}
            >
              <div className="share-card-icon" aria-hidden="true">
                <svg viewBox="0 0 36 36" fill="none">
                  <rect
                    x="13"
                    y="6"
                    width="15"
                    height="15"
                    rx="5"
                    stroke="currentColor"
                    strokeOpacity="0.45"
                    strokeWidth="1.6"
                    strokeDasharray="2.2 2.2"
                  />
                  <rect x="6" y="12.5" width="16" height="15.5" rx="5.5" fill="currentColor" />
                  <rect
                    x="8.8"
                    y="17.2"
                    width="10.4"
                    height="5.6"
                    rx="2.8"
                    fill="var(--bg-stage)"
                    fillOpacity="0.26"
                  />
                  <rect
                    x="10.8"
                    y="18.4"
                    width="2"
                    height="3.4"
                    rx="1"
                    fill="var(--bg-stage)"
                  />
                  <rect
                    x="15.2"
                    y="18.4"
                    width="2"
                    height="3.4"
                    rx="1"
                    fill="var(--bg-stage)"
                  />
                </svg>
              </div>
              <div className="share-card-copy">
                <div className="share-card-title">{t("chat.createCloneTitle")}</div>
                <div className="share-card-sub" id="share-card-sub">
                  {t("chat.createCloneSub")}
                </div>
              </div>
            </button>
          </div>
        </div>
      </header>

      <NetworkStatusBanner placement="stage" />

      {/* iMessage-Style New Chat / Group Compose Bar (`收件人:`) */}
      <div id="new-chat-bar" className="new-chat-bar" hidden={!newChatBarOpen}>
        <div className="new-chat-bar-row">
          <span className="new-chat-to-label">{t("chat.newBarTo")}</span>
          <div id="new-chat-chips" className="new-chat-chips">
            {newChatRecipients.map((r: any, idx: number) => (
              <span key={r.id || idx} className="new-chat-chip">
                <span>{r.title || "Bot"}</span>
                <button
                  type="button"
                  aria-label={t("chat.removeRecipientAria")}
                  onClick={() =>
                    setState((prev) => ({
                      newChatRecipients: prev.newChatRecipients.filter(
                        (_: any, i: number) => i !== idx
                      ),
                    }))
                  }
                >
                  <UiIcon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
          <input
            ref={newChatInputRef}
            id="new-chat-input"
            type="text"
            className="new-chat-input"
            placeholder={t("chat.newBarInputPlaceholder")}
            autoComplete="off"
            value={newChatQuery}
            onChange={(e) => setState({ newChatQuery: e.target.value })}
            onKeyDown={handleNewChatKeyDown}
          />
          <button
            id="new-chat-commit-group-btn"
            type="button"
            className="new-chat-commit-btn"
            hidden={newChatRecipients.length < 2}
            onClick={handleCommitGroup}
          >
            {t("chat.createGroupBtn")}
          </button>
          <button
            id="new-chat-close-btn"
            type="button"
            className="new-chat-close-btn"
            aria-label={t("chat.closeNewBarAria")}
            onClick={closeNewChatBar}
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
        </div>
        <div id="new-chat-group-note" className="new-chat-group-note" hidden={!isMulti}>
          {t("chat.groupBillingNote")}
        </div>
        <div id="new-chat-dropdown" className="new-chat-dropdown" role="listbox">
          <button type="button" className="new-chat-row" onClick={handleCreateSingleBot}>
            <span className="new-chat-row-icon" aria-hidden="true">
              <UiIcon name="plus" size={16} />
            </span>
            <span className="new-chat-row-title">
              {qTrim ? t("chat.createNamedBot", { name: qTrim }) : t("chat.newBarTitleSingle")}
            </span>
            <span className="new-chat-row-sub">{t("chat.newBotDesc")}</span>
          </button>

          {!newChatGroupMode && newChatRecipients.length === 0 && (
            <button
              type="button"
              className="new-chat-row"
              onClick={() => {
                setState({ newChatGroupMode: true });
                newChatInputRef.current?.focus();
              }}
            >
              <span className="new-chat-row-icon" aria-hidden="true">
                <UiIcon name="users" size={16} />
              </span>
              <span className="new-chat-row-title">{t("chat.createBotGroupTitle")}</span>
              <span className="new-chat-row-sub">{t("chat.createBotGroupSub")}</span>
            </button>
          )}

          {dmBots.map((bot: any, idx: number) => (
            <button
              key={bot.id}
              type="button"
              className="new-chat-row"
              onClick={() => {
                if (isMulti) {
                  setState((prev) => ({
                    newChatRecipients: [...prev.newChatRecipients, bot],
                    newChatQuery: "",
                  }));
                  newChatInputRef.current?.focus();
                } else {
                  closeNewChatBar();
                  selectSession(bot.id);
                }
              }}
            >
              <span className="new-chat-row-icon">
                <SessionAvatar
                  session={bot}
                  allSessions={sessions}
                  primaryId={primarySessionId}
                />
              </span>
              <span className="new-chat-row-title">{bot.title || "Bot"}</span>
              <span className="new-chat-row-sub">
                {isMulti ? t("chat.clickJoinGroup") : bot.rolePrompt || t("chat.jumpToChat")}
              </span>
              <span className="kbd-hint">⌘{idx + 1}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Chat Event Stream */}
      <div
        ref={eventStreamRef}
        id="event-stream"
        className={`event-stream${isReplaying ? " is-replaying" : ""}`}
        role="log"
        aria-live="polite"
        onMouseUp={handleStreamMouseUp}
      >
        {streamItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-mascot">
              {activeSession ? (
                <SessionAvatar
                  session={activeSession}
                  allSessions={sessions}
                  primaryId={primarySessionId}
                  sizeVariant="lg"
                />
              ) : (
                <MascotSvg shapeKey="blob" colorKey="black" />
              )}
            </div>
            <div className="empty-state-title">{displayName}</div>
            <div className="empty-state-sub">
              {activeSession?.type === "group"
                ? t("chat.emptyGroupSub")
                : activeSession?.rolePrompt || t("chat.emptyBotSub")}
            </div>
          </div>
        ) : (
          streamItems.map((item: StreamItem, itemIdx: number) => {
            switch (item.kind) {
              case "unread_divider":
                return (
                  <div key={item.id} className="unread-divider">
                    {t("chat.unreadDivider")}
                  </div>
                );
              case "date_divider":
                return (
                  <div key={item.id} className="date-divider">
                    {item.label}
                  </div>
                );
              case "message":
                return <MessageGroup key={item.id} item={item} />;
              case "bot_exchange":
                return <BotExchangePill key={item.id} item={item} />;
              case "choice":
                return <ChoiceCard key={item.id} item={item} />;
              case "approval":
                return <ApprovalCard key={item.id} item={item} />;
              case "draft":
                return <DraftCard key={item.id} item={item} />;
              case "credential":
                return <CredentialCard key={item.id} item={item} />;
              case "route_notice": {
                if (item.level === "max_steps") {
                  const hasFollowUp = streamItems
                    .slice(itemIdx + 1)
                    .some((it) => it.kind === "message" || (it.kind === "route_notice" && it.level === "max_steps"));
                  return (
                    <div key={item.id} className="confirm-card max-steps-card" role="status">
                      <div className="confirm-header max-steps-header">
                        <UiIcon name="alert-triangle" className="inline-ui-icon" size={14} />
                        <span>{t("chat.maxStepsTitle")}</span>
                      </div>
                      <div className="max-steps-body">{item.text}</div>
                      {!hasFollowUp ? (
                        <div className="confirm-actions">
                          <button
                            type="button"
                            className="btn-approve max-steps-continue-btn"
                            disabled={busy}
                            onClick={() => void continueFromMaxSteps()}
                          >
                            {busy ? t("chat.maxStepsContinuing") : t("chat.maxStepsContinue")}
                          </button>
                        </div>
                      ) : (
                        <div className="max-steps-continued-hint">{t("chat.maxStepsContinued")}</div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={item.id} className="route-notice-pill" role="status">
                    <UiIcon name="lightbulb" className="inline-ui-icon" size={14} />
                    {item.text || t("ssr.budgetNearCap")}
                  </div>
                );
              }
              case "error": {
                const formatted = formatErrorNotice(
                  item.message || "",
                  t("card.errorFallback"),
                  locale
                );
                return (
                  <div key={item.id} className="error-card" role="alert">
                    <div className="error-card-main">
                      <span className="error-card-icon" aria-hidden="true">
                        <UiIcon name="alert-triangle" size={14} />
                      </span>
                      <div className="error-card-body">{formatted.summary}</div>
                      <button
                        type="button"
                        className="error-card-close-btn"
                        aria-label={t("card.errorClose")}
                        title={t("card.errorClose")}
                        onClick={() =>
                          dismissSessionErrorCard(
                            item.id,
                            item.dismissKey,
                            item.seq,
                            item.clientOnly
                          )
                        }
                      >
                        <UiIcon name="x" size={12} />
                      </button>
                    </div>
                    {formatted.detail && (
                      <details className="error-card-details">
                        <summary className="error-card-details-summary">
                          {t("card.errorDetails")}
                        </summary>
                        <pre className="error-card-raw">{formatted.detail}</pre>
                      </details>
                    )}
                  </div>
                );
              }
              default:
                return null;
            }
          })
        )}
      </div>

      {/* Floating Scroll-to-Bottom Pill */}
      <button
        id="scroll-bottom-btn"
        type="button"
        className="scroll-bottom-btn"
        aria-label={t("chat.scrollBottom")}
        hidden={autoScrollPinned}
        onClick={() => {
          if (isMobileViewport()) {
            syncMobileChatBottomMetrics();
          }
          setState({ autoScrollPinned: true, scrollPinGuardUntil: Date.now() + 600 });
          const streamEl = eventStreamRef.current;
          if (streamEl) {
            const targetTop = Math.max(0, streamEl.scrollHeight - streamEl.clientHeight);
            streamEl.scrollTo({ top: targetTop, behavior: "smooth" });
          }
        }}
      >
        <svg
          className="icon-svg inline-ui-icon"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M10 4.8V15.2M10 15.2L5.7 10.9M10 15.2L14.3 10.9"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span id="scroll-bottom-label">{t("chat.scrollBottom")}</span>
      </button>

      {/* Highlight-to-Quote Floating Selection Toolbar */}
      <div
        id="selection-quote-toolbar"
        className="selection-quote-toolbar"
        role="toolbar"
        aria-label={t("chat.selectionToolbarAria")}
        hidden={!selectionToolbar.open}
        style={
          selectionToolbar.open
            ? { left: `${selectionToolbar.x}px`, top: `${selectionToolbar.y}px` }
            : undefined
        }
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          id="selection-quote-btn"
          type="button"
          className="selection-tool-btn"
          onClick={() => {
            if (selectionToolbar.snippet) {
              setState((prev) => ({
                pendingQuotes: [...prev.pendingQuotes, selectionToolbar.snippet],
                selectionToolbar: { open: false, x: 0, y: 0, snippet: "" },
              }));
              window.getSelection()?.removeAllRanges();
              (document.getElementById("message-input") as HTMLTextAreaElement | null)?.focus();
            }
          }}
        >
          <svg
            className="icon-svg inline-ui-icon"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M5.2 13.6V9.8C5.2 7.9 6.3 6.5 8.1 6.1M11.6 13.6V9.8C11.6 7.9 12.7 6.5 14.5 6.1"
              stroke="currentColor"
              strokeWidth="1.65"
              strokeLinecap="round"
            />
            <rect x="5" y="10.4" width="3.1" height="3.2" rx="0.8" stroke="currentColor" strokeWidth="1.45" />
            <rect x="11.4" y="10.4" width="3.1" height="3.2" rx="0.8" stroke="currentColor" strokeWidth="1.45" />
          </svg>
          <span>{t("chat.quoteBtn")}</span>
        </button>
        <span className="selection-tool-sep" aria-hidden="true" />
        <button
          id="selection-copy-btn"
          type="button"
          className="selection-tool-btn"
          onClick={() => {
            if (selectionToolbar.snippet) {
              navigator.clipboard?.writeText(selectionToolbar.snippet);
              window.getSelection()?.removeAllRanges();
              setState({ selectionToolbar: { open: false, x: 0, y: 0, snippet: "" } });
              showToast(t("chat.copiedSelectionToast"));
            }
          }}
        >
          <svg
            className="icon-svg inline-ui-icon"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <rect x="7.4" y="6.8" width="8.6" height="9.6" rx="1.8" stroke="currentColor" strokeWidth="1.55" />
            <path
              d="M12.6 6.8V5.2A1.6 1.6 0 0 0 11 3.6H5.6A1.6 1.6 0 0 0 4 5.2V11.6A1.6 1.6 0 0 0 5.6 13.2H7.4"
              stroke="currentColor"
              strokeWidth="1.55"
              strokeLinecap="round"
            />
          </svg>
          <span>{t("common.copy")}</span>
        </button>
      </div>

      {/* Typing / Working Indicator above Composer (kept hidden; inline live row used instead) */}
      <div id="typing-indicator-bar" className="typing-indicator-bar" hidden>
        <span className="typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span id="typing-indicator-text">{t("chat.typingIndicator", { name: displayName })}</span>
      </div>

      {/* Bottom Unified Composer Pill */}
      <Composer composerWrapRef={composerWrapRef} />

      {/* Bot-to-Bot Exchange Slide-up Drawer */}
      <div
        id="bot-exchange-sheet"
        className={`bot-exchange-sheet${exchangeAnim.stateClass ? ` ${exchangeAnim.stateClass}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.botExchangeTitle")}
        hidden={exchangeAnim.hidden}
      >
        <div
          className="exchange-sheet-backdrop"
          id="exchange-sheet-backdrop"
          onClick={closeExchangeSheet}
        />
        <div ref={exchangeAnim.panelRef} className="exchange-sheet-panel">
          <div
            className="mobile-sheet-handle mobile-only"
            aria-hidden="true"
            {...exchangeAnim.handleProps}
          />
          <div className="exchange-sheet-header">
            <div className="exchange-participants-bar" id="exchange-participants-bar">
              {botExchangeSheet.participants.map((p: any, i: number) => (
                <Fragment key={p.id || p.title || i}>
                  <span className="exchange-peer-chip">
                    <AvatarNode avatar={p.avatar || { shape: "blob", color: "black" }} />
                    <span>{p.title || "Bot"}</span>
                  </span>
                  {i < botExchangeSheet.participants.length - 1 && (
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <UiIcon name="arrows-exchange" size={14} />
                    </span>
                  )}
                </Fragment>
              ))}
            </div>
            <button
              id="close-exchange-sheet-btn"
              type="button"
              className="modal-close-btn"
              style={{ position: "static" }}
              aria-label={t("common.close")}
              onClick={() =>
                setState((prev) => ({
                  botExchangeSheet: { ...prev.botExchangeSheet, open: false },
                }))
              }
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
          </div>
          <div id="exchange-messages-list" className="exchange-messages-list">
            {botExchangeSheet.messages.map((m: any, idx: number) => (
              <div key={idx} className="msg-group is-bot" style={{ maxWidth: "92%" }}>
                <div className="msg-speaker-header">
                  <AvatarNode avatar={m.fromAvatar || { shape: "blob", color: "black" }} />
                  <span>
                    {m.fromBotName} → {m.toBotName} · {formatClockTime(m.at, locale)}
                  </span>
                </div>
                <div className="msg-bubble bot-bubble">
                  <MarkdownRenderer text={m.text || ""} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Technical Execution Trace Drawer */}
      <div
        id="trace-drawer-sheet"
        className="bot-exchange-sheet trace-drawer-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.traceDrawerAria")}
        hidden={!traceDrawerOpen}
      >
        <div
          className="exchange-sheet-backdrop"
          id="trace-drawer-backdrop"
          onClick={() => setState({ traceDrawerOpen: false })}
        />
        <div className="exchange-sheet-panel trace-drawer-panel">
          <div className="exchange-sheet-header">
            <div className="exchange-participants-bar">
              <span>{t("chat.traceDrawerTitle")}</span>
              <span className="route-mini-tag" id="trace-drawer-count-badge">
                {t("chat.traceStepsCount", { count: stepCount })}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                id="open-full-billing-btn"
                type="button"
                className="settings-pill-btn"
                style={{ fontSize: "12px", padding: "4px 10px" }}
                onClick={() => {
                  setState({ traceDrawerOpen: false });
                  openSettingsModal("usage");
                }}
              >
                <span>{t("chat.globalUsageBtn")}</span>
                <svg
                  className="icon-svg inline-ui-icon"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M7.8 5.2L12.6 10L7.8 14.8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                id="close-trace-drawer-btn"
                type="button"
                className="modal-close-btn"
                style={{ position: "static" }}
                aria-label={t("common.close")}
                onClick={() => setState({ traceDrawerOpen: false })}
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
            </div>
          </div>

          <div
            id="session-model-usage-bar"
            className="session-model-usage-bar"
            hidden={costSummary.byModel.length === 0}
          >
            {costSummary.byModel.map((m: any) => (
              <div
                key={m.model}
                className="session-model-chip"
                title={t("chat.modelChipTitle", {
                  label: m.label,
                  input: m.inputTokens.toLocaleString(),
                  output: m.outputTokens.toLocaleString(),
                  thought:
                    m.thoughtTokens > 0
                      ? t("chat.modelChipThought", { thought: m.thoughtTokens.toLocaleString() })
                      : "",
                })}
              >
                <span className={`model-accent-dot model-accent-${m.accent}`} />
                <strong>{m.shortLabel}</strong>
                <span className="session-model-chip-sub">
                  {m.totalTokens.toLocaleString()} tok · {formatCny(m.costCny)}
                </span>
              </div>
            ))}
          </div>

          <TraceEventsList
            id="trace-drawer-list"
            className="exchange-messages-list trace-drawer-list"
          />
        </div>
      </div>
    </main>
  );
}
