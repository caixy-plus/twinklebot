import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { isMobileViewport, syncMobileChatBottomMetrics } from "../../mobile-ui.js";
import {
  closeAllPopovers,
  sendUserMessage,
  stopCurrentSessionTask,
  uploadAndStageFiles,
} from "../../services/actions.js";
import { apiUrl } from "../../services/api-client.js";
import { useI18n } from "../../services/i18n.js";
import {
  getLiveWorkingLabel,
  isImeConfirmEnter,
  isSessionCurrentlyBusy,
} from "../../state/helpers.js";
import {
  getActiveSessionFromState,
  getState,
  setState,
  useStore,
} from "../../state/store.js";
import { SessionAvatar } from "../common/AvatarView.js";
import { UiIcon } from "../common/Icon.js";

function syncComposerInputHeight(input: HTMLTextAreaElement | null) {
  if (!input) return;
  input.style.height = "auto";
  const maxH = 136;
  const scrollH = Number(input.scrollHeight) || 0;
  if (scrollH > 0) {
    input.style.height = `${Math.min(scrollH, maxH)}px`;
    input.style.overflowY = scrollH > maxH ? "auto" : "hidden";
  } else {
    input.style.height = "";
    input.style.overflowY = "";
  }
}

export function Composer({
  composerWrapRef,
}: {
  composerWrapRef: RefObject<HTMLDivElement | null>;
}) {
  const composerText = useStore((s) => s.composerText);
  const replyQuote = useStore((s) => s.replyQuote);
  const replyTarget = useStore((s) => s.replyTarget);
  const pendingQuotes = useStore((s) => s.pendingQuotes);
  const pendingAttachments = useStore((s) => s.pendingAttachments);
  const spellcheckEnabled = useStore((s) => s.spellcheckEnabled);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const liveThinkingSummary = useStore((s) => s.liveThinkingSummary);
  const queuedCount = useStore((s) => s.queuedCount);
  const sessions = useStore((s) => s.sessions);
  const activeSession = useStore((s) => getActiveSessionFromState(s));
  const activeSessionId = useStore((s) => s.activeSessionId);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const openPopover = useStore((s) => s.openPopover);

  const [stopping, setStopping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = isSessionCurrentlyBusy(sessionStatus);
  const mobileMode = isMobileViewport();

  const displayName =
    activeSession?.title && activeSession.title !== "New Session"
      ? activeSession.title
      : "Twinkle";
  const placeholder =
    activeSession?.type === "group"
      ? "给群组发消息（输入 @ 可点名某位 Bot）"
      : `给 ${displayName} 发消息`;

  const hasReply = Boolean(replyTarget || replyQuote);
  const hasQuotes = pendingQuotes.length > 0;
  const hasAtts = pendingAttachments.length > 0;
  const showTray = hasReply || hasQuotes || hasAtts;

  const replyText = replyTarget
    ? `回复 ${replyTarget.author || "消息"}：${replyTarget.snippet || ""}`
    : replyQuote
      ? `回复：${replyQuote}`
      : "";

  const atMatch = composerText.match(/@([^\s@]*)$/);
  const mentionQuery = atMatch ? atMatch[1].toLowerCase() : null;
  const mentionPool =
    mentionQuery === null
      ? []
      : activeSession?.type === "group"
        ? (activeSession.memberBotIds || [])
            .map((id: string) => sessions.find((s: any) => s.id === id))
            .filter(Boolean)
        : sessions.filter((s: any) => s.type !== "group" && s.id !== activeSessionId);
  const mentionMatches =
    mentionQuery === null
      ? []
      : mentionPool.filter((b: any) =>
          String(b.title || "").toLowerCase().includes(mentionQuery)
        );
  const showMentionPopover = openPopover === "mention" && mentionMatches.length > 0;

  useEffect(() => {
    syncComposerInputHeight(textareaRef.current);
  }, [composerText]);

  const handleStop = () => {
    setStopping(true);
    stopCurrentSessionTask().finally(() => {
      setStopping(false);
    });
  };

  const handleInputChange = (val: string) => {
    const nextMatch = val.match(/@([^\s@]*)$/);
    setState((prev) => ({
      composerText: val,
      openPopover: nextMatch ? "mention" : prev.openPopover === "mention" ? null : prev.openPopover,
    }));
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter(Boolean) as File[];
    if (files.length > 0) {
      e.preventDefault();
      await uploadAndStageFiles(files);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (isMobileViewport()) return;
      if (isImeConfirmEnter(e, getState().lastCompositionEndAt)) return;
      e.preventDefault();
      sendUserMessage(composerText);
    } else if (e.key === "Escape") {
      if (replyTarget || replyQuote || pendingQuotes.length > 0) {
        setState({
          replyTarget: null,
          replyQuote: null,
          pendingQuotes: [],
        });
      }
    }
  };

  const preserveComposerFocusOnSend = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (typeof document !== "undefined" && document.activeElement === textareaRef.current) {
      setState({ keepInputFocusedOnSend: true });
    }
    if (e.type === "mousedown") {
      e.preventDefault();
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    sendUserMessage(composerText);
  };

  useEffect(() => {
    syncMobileChatBottomMetrics();
    if (typeof requestAnimationFrame === "function") {
      const raf = requestAnimationFrame(() => syncMobileChatBottomMetrics());
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [busy, liveThinkingSummary, pendingAttachments.length, pendingQuotes.length, queuedCount]);

  const showQueueBanner = queuedCount > 0 && busy;
  const waitHint =
    sessionStatus === "awaiting_approval"
      ? `⏳ 已排队 ${queuedCount} 条消息 · 当前等待操作审批，批准或停止后继续`
      : sessionStatus === "awaiting_choice"
        ? `⏳ 已排队 ${queuedCount} 条消息 · 当前等待你的选择，确认或停止后继续`
        : sessionStatus === "paused"
          ? `⏳ 已排队 ${queuedCount} 条消息 · 当前处于接管状态，恢复或停止后继续`
          : `⏳ 已排队 ${queuedCount} 条消息，上一轮执行完成后将自动衔接`;

  const sendTitle = busy
    ? t("chat.sendMessage")
    : mobileMode
      ? t("chat.sendMessage")
      : `${t("chat.sendMessage")} (Enter)`;

  return (
    <div className="composer-wrap" id="composer-wrap" ref={composerWrapRef}>
      {busy && (
        <div id="live-working-bubble" className="live-activity-row">
          <span className="live-pulse-dot" aria-hidden="true" />
          <span className="live-working-text">
            {getLiveWorkingLabel(sessionStatus, liveThinkingSummary)}
          </span>
          <button
            type="button"
            id="live-working-stop-btn"
            className="live-working-stop-btn"
            title="停止当前任务"
            aria-label="停止当前任务"
            disabled={stopping}
            onClick={handleStop}
          >
            停止
          </button>
        </div>
      )}

      {showQueueBanner && (
        <div id="composer-queue-banner" className="composer-queue-banner" role="status">
          <span>{waitHint}</span>
          <button
            type="button"
            className="composer-queue-stop-btn"
            disabled={stopping}
            onClick={handleStop}
          >
            停止当前任务
          </button>
        </div>
      )}

      {/* @Bot Mention Autocomplete Popover */}
      <div
        id="mention-popover"
        className="floating-menu mention-popover"
        hidden={!showMentionPopover}
        onClick={(e) => e.stopPropagation()}
      >
        {mentionMatches.map((b: any) => (
          <button
            key={b.id}
            type="button"
            className="menu-item-row"
            onClick={() => {
              const nextVal = composerText.replace(/@([^\s@]*)$/, `@${b.title} `);
              setState({ composerText: nextVal, openPopover: null });
              textareaRef.current?.focus();
            }}
          >
            <span className="menu-item-leading">
              <span style={{ width: "18px", height: "18px", display: "inline-flex" }}>
                <SessionAvatar
                  session={b}
                  allSessions={sessions}
                  primaryId={primarySessionId}
                />
              </span>
              <span>{b.title}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Hidden File Input for Real Attachment Upload */}
      <input
        ref={fileInputRef}
        id="attachment-file-input"
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files || [])];
          e.target.value = "";
          await uploadAndStageFiles(files);
        }}
      />

      <form id="message-form" className="composer-pill" noValidate onSubmit={handleSubmit}>
        <div id="composer-staging-tray" className="composer-staging-tray" hidden={!showTray}>
          <div id="reply-quote-bar" className="reply-quote-bar" hidden={!hasReply}>
            <span className="reply-connector-glyph" aria-hidden="true">
              <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                <path
                  d="M7.6 5.2L4.1 8.7L7.6 12.2"
                  stroke="currentColor"
                  strokeWidth="1.65"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M4.5 8.7H12.2A3.6 3.6 0 0 1 15.8 12.3V14.4"
                  stroke="currentColor"
                  strokeWidth="1.65"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="reply-quote-text" id="reply-quote-text">
              {replyText}
            </span>
            <button
              id="reply-quote-clear"
              type="button"
              className="reply-quote-close"
              aria-label="取消回复"
              onClick={() => setState({ replyQuote: null, replyTarget: null })}
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

          <div id="composer-quotes-bar" className="composer-quotes-bar" hidden={!hasQuotes}>
            {pendingQuotes.map((qt, idx) => (
              <div key={`${idx}-${qt}`} className="quote-staging-chip">
                <span>
                  <UiIcon name="quote" className="inline-ui-icon" size={12} />
                  {qt}
                </span>
                <button
                  type="button"
                  aria-label="移除引用"
                  onClick={() =>
                    setState((prev) => ({
                      pendingQuotes: prev.pendingQuotes.filter((_, i) => i !== idx),
                    }))
                  }
                >
                  <UiIcon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>

          <div
            id="composer-attachments-bar"
            className="composer-attachments-bar"
            hidden={!hasAtts}
          >
            {pendingAttachments.map((att: any, idx: number) => {
              const extMatch = String(att.name || "").match(/\.([a-zA-Z0-9]{1,5})$/);
              const fileExt = extMatch ? extMatch[1].toUpperCase() : "FILE";
              return (
                <div
                  key={`${att.url || att.name}-${idx}`}
                  className={`attachment-chip${att.isMedia ? " is-media" : " is-file"}`}
                  title={att.name}
                >
                  {att.isMedia ? (
                    <img src={apiUrl(att.url)} alt={att.name} />
                  ) : (
                    <span className="attachment-chip-ext" aria-hidden="true">
                      {fileExt}
                    </span>
                  )}
                  <span className="attachment-chip-name">{att.name}</span>
                  <button
                    type="button"
                    className="attachment-chip-remove"
                    aria-label={`移除附件 ${att.name}`}
                    onClick={() =>
                      setState((prev) => ({
                        pendingAttachments: prev.pendingAttachments.filter((_, i) => i !== idx),
                      }))
                    }
                  >
                    <UiIcon name="x" size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="composer-main-row">
          <button
            id="composer-ops-btn"
            type="button"
            className="composer-plus-btn"
            title={t("chat.attachFile")}
            aria-label={t("chat.attachFile")}
            onClick={(e) => {
              e.stopPropagation();
              closeAllPopovers();
              fileInputRef.current?.click();
            }}
          >
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 4.5V15.5M4.5 10H15.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <label htmlFor="message-input" className="sr-only">
            给当前 Bot 发送消息
          </label>
          <textarea
            ref={textareaRef}
            id="message-input"
            className="composer-input"
            rows={1}
            aria-label="提示词"
            placeholder={placeholder}
            enterKeyHint={mobileMode ? "enter" : "send"}
            spellCheck={spellcheckEnabled}
            value={composerText}
            onChange={(e) => handleInputChange(e.target.value)}
            onCompositionEnd={(e) => setState({ lastCompositionEndAt: e.timeStamp })}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
          />
          <button
            id="composer-stop-btn"
            type="button"
            className="composer-stop-pill"
            hidden={true}
            title="停止当前任务"
            onClick={handleStop}
          >
            停止
          </button>
          <button
            id="send-btn"
            type="submit"
            className="composer-voice-send-btn"
            data-mode="send"
            title={sendTitle}
            aria-label="发送消息"
            onPointerDown={preserveComposerFocusOnSend}
            onMouseDown={preserveComposerFocusOnSend}
          >
            <svg
              className="send-arrow-svg mode-icon-send"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4.5 10H15.5M15.5 10L10.75 5.25M15.5 10L10.75 14.75"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <svg
              className="stop-square-svg mode-icon-stop"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <rect x="6" y="6" width="8" height="8" rx="2" fill="currentColor" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
