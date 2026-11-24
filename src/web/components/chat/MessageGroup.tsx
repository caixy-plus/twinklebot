import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { resolveBotAvatar } from "../../avatars.js";
import { isMobileViewport } from "../../mobile-ui.js";
import { splitIntoMessageChunksWithMarkup } from "../../preview-utils.js";
import {
  selectSession,
  showToast,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { useI18n } from "../../services/i18n.js";
import {
  formatClockTime,
  isImeConfirmEnter,
} from "../../state/helpers.js";
import {
  getActiveSessionFromState,
  runtimeRefs,
  setState,
  useStore,
  type StreamItem,
} from "../../state/store.js";
import { AvatarNode } from "../common/AvatarView.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";

function ActionSvg({
  kind,
}: {
  kind: "edit" | "reply" | "copy";
}) {
  const d =
    kind === "edit"
      ? "M11.4 2.6a1.4 1.4 0 0 1 2 2L5.6 12.4 2.8 13.2l.8-2.8 7.8-7.8Z"
      : kind === "reply"
        ? "M6.5 4.5 3 8l3.5 3.5M3.5 8h6.2A3.3 3.3 0 0 1 13 11.3v.7"
        : "M5.5 5.5v-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2m-7-5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z";
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MessageGroup({
  item,
}: {
  item: Extract<StreamItem, { kind: "message" }>;
}) {
  const sessions = useStore((s) => s.sessions);
  const activeSession = useStore((s) => getActiveSessionFromState(s));
  const activeSessionId = useStore((s) => s.activeSessionId);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const mobileActionsOpenSeq = useStore((s) => s.mobileActionsOpenSeq);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(item.text || "");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const editTaRef = useRef<HTMLTextAreaElement | null>(null);
  const { t } = useI18n();

  const isUser = item.isUser;
  const isGroup = activeSession?.type === "group";
  const authorName = isUser
    ? "你"
    : item.botName ||
      (activeSession?.title && activeSession.title !== "New Session"
        ? activeSession.title
        : "Twinkle");

  const chunks = isUser
    ? [String(item.text || "")]
    : splitIntoMessageChunksWithMarkup(item.text);
  const exactClock = formatClockTime(item.at);

  const isActionsOpen =
    item.seq !== undefined && mobileActionsOpenSeq === item.seq;

  const handleReplyJump = () => {
    const targetSeq = item.replyTo?.seq;
    const targetEl =
      targetSeq && typeof document !== "undefined"
        ? document.querySelector<HTMLElement>(`.msg-group[data-seq="${targetSeq}"]`)
        : null;
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
      targetEl.classList.remove("is-reply-target-flash");
      void targetEl.offsetWidth;
      targetEl.classList.add("is-reply-target-flash");
      setTimeout(() => targetEl.classList.remove("is-reply-target-flash"), 1400);
    } else {
      showToast("原消息位于更早对话记录");
    }
  };

  const startInlineEdit = (e: ReactMouseEvent) => {
    e.stopPropagation();
    setState({ mobileActionsOpenSeq: null });
    setEditText(String(item.text || ""));
    setEditing(true);
    requestAnimationFrame(() => {
      const ta = editTaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  };

  const commitInlineEdit = async () => {
    const nextText = editText.trim();
    if (!nextText) {
      showToast("消息内容不能为空");
      editTaRef.current?.focus();
      return;
    }
    if (!activeSessionId || !item.seq) return;
    setEditSubmitting(true);
    try {
      await apiJson(`/api/sessions/${activeSessionId}/edit-message`, {
        method: "POST",
        body: JSON.stringify({ seq: item.seq, text: nextText }),
      });
      setEditing(false);
      setEditSubmitting(false);
      if (runtimeRefs.wsSocket?.readyState !== WebSocket.OPEN) {
        await selectSession(activeSessionId);
      }
      showToast("已覆盖后续记录并重新发送");
    } catch (err: any) {
      setEditSubmitting(false);
      showToast(`修改失败: ${err?.message || "请重试"}`);
    }
  };

  const handleLastBubbleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isMobileViewport() || item.seq === undefined) return;
    const targetEl = e.target as HTMLElement | null;
    if (
      targetEl?.closest(
        "a, button, img, video, audio, pre, textarea, input, .msg-inline-edit, .msg-hover-actions"
      )
    ) {
      return;
    }
    const selected = typeof window !== "undefined" ? window.getSelection()?.toString()?.trim() : "";
    if (selected) return;
    setState((prev) => ({
      mobileActionsOpenSeq: prev.mobileActionsOpenSeq === item.seq ? null : item.seq ?? null,
    }));
  };

  const hoverBar = (
    <div className="msg-hover-actions">
      {isUser && Boolean(item.seq) && (
        <button
          type="button"
          className="msg-action-icon"
          title="修改并重发"
          aria-label="修改并重发"
          onClick={startInlineEdit}
        >
          <ActionSvg kind="edit" />
        </button>
      )}
      <button
        type="button"
        className="msg-action-icon"
        title="回复此消息"
        aria-label="回复此消息"
        onClick={() => {
          setState({
            mobileActionsOpenSeq: null,
            replyTarget: {
              seq: item.seq ?? null,
              author: authorName || "消息",
              botId: isUser ? null : item.botId || activeSessionId,
              snippet: String(item.text || "").replace(/\s+/g, " ").slice(0, 64),
            },
            replyQuote: null,
          });
          (document.getElementById("message-input") as HTMLTextAreaElement | null)?.focus();
        }}
      >
        <ActionSvg kind="reply" />
      </button>
      <button
        type="button"
        className="msg-action-icon"
        title="复制文本"
        aria-label="复制文本"
        onClick={async () => {
          setState({ mobileActionsOpenSeq: null });
          try {
            await navigator.clipboard.writeText(String(item.text || ""));
          } catch {}
          showToast("已复制到剪贴板");
        }}
      >
        <ActionSvg kind="copy" />
      </button>
    </div>
  );

  const speakerSession =
    !isUser && isGroup && item.botName
      ? sessions.find((s: any) => s.id === item.botId) ||
        sessions.find((s: any) => s.title === item.botName)
      : null;
  const resolvedSpeakerAvatar = speakerSession
    ? resolveBotAvatar(speakerSession, primarySessionId)
    : item.botName === "Twinkle" || item.botName === "Nori"
      ? { shape: "blob", color: "black" }
      : item.botAvatar || { shape: "blob", color: "blue" };

  return (
    <div
      className={`msg-group ${isUser ? "is-user" : "is-bot"}${isActionsOpen ? " is-actions-open" : ""}`}
      data-seq={item.seq !== undefined ? String(item.seq) : undefined}
    >
      {!isUser && isGroup && item.botName && (
        <div className="msg-speaker-header">
          <AvatarNode avatar={resolvedSpeakerAvatar} />
          <span>{item.botName}</span>
        </div>
      )}

      {item.replyTo && typeof item.replyTo === "object" && (
        <button type="button" className="msg-reply-anchor" onClick={handleReplyJump}>
          <span className="msg-reply-author">{item.replyTo.author || "原消息"}</span>
          <span className="msg-reply-snippet">
            {String(item.replyTo.snippet || "")
              .replace(/\s+/g, " ")
              .slice(0, 60)}
          </span>
        </button>
      )}

      <div className="msg-bubble-stack">
        {chunks.map((chunk, idx) => {
          const isLast = idx === chunks.length - 1;
          const posClass =
            chunks.length === 1
              ? "is-single"
              : idx === 0
                ? "is-first"
                : isLast
                  ? "is-last"
                  : "is-middle";
          const bubbleCls = `msg-bubble ${isUser ? "user-bubble" : "bot-bubble"} ${posClass}${
            item.interim ? " is-interim-bubble" : ""
          }`;

          const showQuotes =
            idx === 0 &&
            Array.isArray(item.quotes) &&
            item.quotes.length > 0 &&
            !String(chunk).trim().startsWith(">");

          const bubbleEl = (
            <div
              key={idx}
              className={bubbleCls}
              title={exactClock || undefined}
              onClick={isLast ? handleLastBubbleClick : undefined}
            >
              {isLast && editing ? (
                <div className="msg-inline-edit">
                  <textarea
                    ref={editTaRef}
                    className="msg-inline-edit-textarea"
                    rows={Math.min(8, Math.max(2, editText.split("\n").length))}
                    value={editText}
                    disabled={editSubmitting}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Escape") {
                        ev.preventDefault();
                        setEditing(false);
                      } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
                        ev.preventDefault();
                        commitInlineEdit();
                      }
                    }}
                  />
                  <div className="msg-inline-edit-actions">
                    <button
                      type="button"
                      className="msg-inline-edit-btn"
                      disabled={editSubmitting}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setEditing(false);
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="msg-inline-edit-btn is-primary"
                      disabled={editSubmitting}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        commitInlineEdit();
                      }}
                    >
                      保存并重发
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {showQuotes &&
                    item.quotes!.map((qt, qIdx) => <blockquote key={qIdx}>{qt}</blockquote>)}
                  <MarkdownRenderer text={chunk} />
                </>
              )}
            </div>
          );

          if (!isLast) return bubbleEl;

          return (
            <div key={idx} className="msg-bubble-row">
              {isUser ? (
                <>
                  {hoverBar}
                  {bubbleEl}
                </>
              ) : (
                <>
                  {bubbleEl}
                  {hoverBar}
                </>
              )}
            </div>
          );
        })}
      </div>

      {isUser && item.clientSource?.deviceKind && (
        <div
          className="msg-source-tag"
          data-client-source={item.clientSource.deviceKind}
          title={
            item.clientSource.deviceKind === "mobile"
              ? `${t("source.mobile")}${item.clientSource.platform ? ` (${item.clientSource.platform})` : ""}`
              : `${t("source.desktop")}${item.clientSource.platform ? ` (${item.clientSource.platform})` : ""}`
          }
        >
          {item.clientSource.deviceKind === "mobile" ? t("source.mobile") : t("source.desktop")}
        </div>
      )}
    </div>
  );
}
