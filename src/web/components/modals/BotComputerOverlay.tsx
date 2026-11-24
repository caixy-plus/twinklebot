import { useEffect, useRef, useState, type FormEvent } from "react";
import { resolveBotAvatar } from "../../avatars.js";
import {
  closeBotScreenOverlay,
  refreshComputerDisplays,
  setNovncMode,
  showToast,
  stopCurrentSessionTask,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { hasConnectedNodeCapability } from "../../services/ota-updater.js";
import { useI18n } from "../../services/i18n.js";
import {
  buildNovncSrc,
  isSessionCurrentlyBusy,
} from "../../state/helpers.js";
import {
  getActiveSessionFromState,
  setState,
  useStore,
} from "../../state/store.js";
import { AvatarNode } from "../common/AvatarView.js";

export function BotComputerOverlay() {
  const screenOverlayOpen = useStore((s) => s.screenOverlayOpen);
  const screenConnecting = useStore((s) => s.screenConnecting);
  const takeoverActive = useStore((s) => s.takeoverActive);
  const landscapeDesktop = useStore((s) => s.landscapeDesktop);
  const config = useStore((s) => s.config);
  const activeBaseUrl = useStore((s) => s.activeBaseUrl);
  const activeAuthToken = useStore((s) => s.activeAuthToken);
  const activeSession = useStore((s) => getActiveSessionFromState(s));
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const diagnostics = useStore((s) => s.diagnostics);
  const computerDisplays = useStore((s) => s.computerDisplays);
  const groupActiveSpeakerBySession = useStore((s) => s.groupActiveSpeakerBySession);
  const screenOverlayTargetBotId = useStore((s) => s.screenOverlayTargetBotId);
  const novncReconnectSeq = useStore((s) => s.novncReconnectSeq);

  const isGroup = activeSession?.type === "group";
  const groupMembers = isGroup && Array.isArray(activeSession?.memberBotIds)
    ? activeSession.memberBotIds
        .map((id: string) => sessions.find((item: any) => item.id === id))
        .filter(Boolean)
    : [];

  const multiDisplayEnabled = hasConnectedNodeCapability("multi-display-v1", { diagnostics });
  const remoteInputSupported = hasConnectedNodeCapability("computer-remote-input-v1", {
    diagnostics,
  });
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [remoteInputText, setRemoteInputText] = useState("");
  const [sendingRemoteInput, setSendingRemoteInput] = useState(false);
  const remoteInputRef = useRef<HTMLInputElement | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    if (!screenOverlayOpen) {
      setKeyboardOpen(false);
      setRemoteInputText("");
    }
  }, [screenOverlayOpen]);
  const activeSpeakerId = activeSessionId
    ? groupActiveSpeakerBySession?.[activeSessionId] || ""
    : "";
  const targetDisplayBotId = isGroup
    ? (screenOverlayTargetBotId &&
      groupMembers.some((m: any) => m.id === screenOverlayTargetBotId)
        ? screenOverlayTargetBotId
        : activeSpeakerId && groupMembers.some((m: any) => m.id === activeSpeakerId)
          ? activeSpeakerId
          : groupMembers[0]?.id || activeSessionId)
    : activeSessionId;

  const targetBotSession = isGroup
    ? groupMembers.find((m: any) => m.id === targetDisplayBotId) || activeSession
    : activeSession;

  const displayName =
    targetBotSession?.title && targetBotSession.title !== "New Session"
      ? targetBotSession.title
      : "Twinkle";
  const av = resolveBotAvatar(targetBotSession, primarySessionId);

  const boundDisplay = multiDisplayEnabled
    ? computerDisplays?.bindings?.[String(targetDisplayBotId || "")] || ""
    : "";

  const viewOnly = !takeoverActive;
  const dimsText =
    config?.screen?.width && config?.screen?.height
      ? `${config.screen.width}×${config.screen.height}`
      : "1440×900";
  const novncSrc =
    screenOverlayOpen && config?.novncUrl
      ? buildNovncSrc(
          config.novncUrl,
          viewOnly,
          activeBaseUrl,
          activeAuthToken,
          multiDisplayEnabled && activeSessionId
            ? isGroup && targetDisplayBotId
              ? { sessionId: activeSessionId, botId: targetDisplayBotId }
              : { sessionId: activeSessionId }
            : undefined
        )
      : "about:blank";
  const isRunning = isSessionCurrentlyBusy(sessionStatus);

  const ensureTakeoverForKeyboard = () => {
    if (!viewOnly) return;
    setNovncMode(false);
    void apiJson("/api/control", {
      method: "POST",
      body: JSON.stringify({ action: "pause", sessionId: activeSessionId }),
    }).catch(() => {});
  };

  const handleToggleKeyboard = () => {
    ensureTakeoverForKeyboard();
    if (!remoteInputSupported) {
      const frame = document.getElementById("novnc-frame") as HTMLIFrameElement | null;
      try {
        frame?.contentWindow?.postMessage(
          { type: "twinklebot:focus_keyboard" },
          window.location.origin
        );
      } catch {}
      return;
    }
    const nextOpen = !keyboardOpen;
    setKeyboardOpen(nextOpen);
    if (nextOpen) {
      requestAnimationFrame(() => {
        remoteInputRef.current?.focus();
      });
    } else {
      remoteInputRef.current?.blur();
    }
  };

  const sendRemotePayload = async (payload: {
    text?: string;
    key?: string;
    pressEnter?: boolean;
  }) => {
    if (sendingRemoteInput) return;
    setSendingRemoteInput(true);
    try {
      await apiJson("/api/computer/input", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          sessionId: activeSessionId || undefined,
          botId: targetDisplayBotId || undefined,
        }),
      });
      if (payload.text) {
        setRemoteInputText("");
      }
      remoteInputRef.current?.focus();
    } catch (err: any) {
      showToast(`发送输入失败：${err?.message || "连接异常"}`);
    } finally {
      setSendingRemoteInput(false);
    }
  };

  const handleRemoteInputSubmit = (e: FormEvent) => {
    e.preventDefault();
    const val = remoteInputText;
    if (!val) return;
    void sendRemotePayload({ text: val, pressEnter: false });
  };

  return (
    <section
      id="bot-screen-overlay"
      className="bot-screen-overlay"
      data-takeover={takeoverActive ? "true" : "false"}
      data-landscape-desktop={landscapeDesktop ? "true" : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={`${displayName} 的屏幕`}
      hidden={!screenOverlayOpen}
    >
      <button
        id="exit-fullscreen-btn"
        type="button"
        className="screen-exit-btn"
        title={t("computer.exitBtn")}
        aria-label={t("computer.exitBtn")}
        onClick={closeBotScreenOverlay}
      >
        <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M16.5 3.5L12 8M12 8H16M12 8V4M3.5 16.5L8 12M8 12H4M8 12V16"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="screen-stage-outer">
        <div className="screen-stage-frame">
          <span id="screen-dims" className="sr-only">
            {dimsText}
          </span>
          <span id="toolbar-hint" className="sr-only">
            {viewOnly ? "默认只读监看" : "人工接管模式"}
          </span>

          <div
            id="screen-connecting-mask"
            className="screen-connecting-mask"
            hidden={!screenConnecting}
          >
            <div className="connecting-mascot-row">
              <span className="connecting-dot dot-left" />
              <div className="connecting-blob" id="connecting-blob-slot">
                <AvatarNode avatar={av} />
              </div>
              <span className="connecting-dot dot-right" />
            </div>
            <div className="connecting-label">连接中</div>
          </div>

          <iframe
            key={novncReconnectSeq}
            id="novnc-frame"
            className="novnc-frame"
            title="Ubuntu XFCE Desktop"
            src={novncSrc}
            data-reconnect-seq={novncReconnectSeq}
            allow="clipboard-read; clipboard-write"
          />
        </div>
      </div>

      <div className="screen-bottom-pill-wrap">
        <div
          className="screen-control-pill"
          id="screen-control-pill"
          data-controlling={takeoverActive ? "true" : "false"}
        >
          <div className="screen-control-status" id="screen-control-status">
            <svg
              id="screen-icon-watch"
              className="icon-svg"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
              hidden={!viewOnly}
            >
              <path
                d="M2.2 10C3.8 6.4 6.6 4.5 10 4.5C13.4 4.5 16.2 6.4 17.8 10C16.2 13.6 13.4 15.5 10 15.5C6.6 15.5 3.8 13.6 2.2 10Z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <svg
              id="screen-icon-control"
              className="icon-svg"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
              hidden={viewOnly}
            >
              <path
                d="M5 4L15 8.8L10.2 10.6L8.4 15.4L5 4Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <span id="screen-status-label">
              {viewOnly ? "仅观看" : "你正在独占控制"}
              {boundDisplay
                ? ` · ${displayName} (${boundDisplay})`
                : isGroup
                  ? ` · ${displayName}`
                  : ""}
            </span>
          </div>

          {multiDisplayEnabled && isGroup && groupMembers.length > 1 && (
            <select
              id="group-screen-member-select"
              aria-label="切换群成员屏幕"
              value={targetDisplayBotId || ""}
              onChange={(e) => {
                setState({
                  screenOverlayTargetBotId: e.target.value || null,
                  screenConnecting: true,
                });
                setTimeout(() => {
                  setState({ screenConnecting: false });
                  void refreshComputerDisplays();
                }, 420);
              }}
              style={{
                background: "rgba(255,255,255,0.12)",
                color: "inherit",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: "999px",
                padding: "3px 10px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              {groupMembers.map((m: any) => {
                const mDisp = computerDisplays?.bindings?.[String(m.id)] || "";
                return (
                  <option key={m.id} value={m.id} style={{ color: "#111" }}>
                    {m.title || "Bot"}
                    {mDisp ? ` (${mDisp})` : ""}
                  </option>
                );
              })}
            </select>
          )}

          <button
            id="pause-btn"
            type="button"
            className="screen-takeover-btn"
            hidden={!viewOnly}
            onClick={async () => {
              setNovncMode(false);
              await apiJson("/api/control", {
                method: "POST",
                body: JSON.stringify({ action: "pause", sessionId: activeSessionId }),
              }).catch(() => {});
            }}
          >
            取得控制权
          </button>

          <button
            id="resume-btn"
            type="button"
            className="screen-release-btn"
            hidden={viewOnly}
            onClick={async () => {
              setNovncMode(true);
              await apiJson("/api/control", {
                method: "POST",
                body: JSON.stringify({ action: "resume", sessionId: activeSessionId }),
              }).catch(() => {});
            }}
          >
            停止
          </button>

          <button
            id="stop-btn"
            type="button"
            className="screen-abort-btn"
            hidden={!isRunning}
            title="终止当前任务"
            onClick={() => stopCurrentSessionTask()}
          >
            终止任务
          </button>
        </div>
      </div>

      {keyboardOpen && remoteInputSupported && (
        <form
          id="screen-remote-input-bar"
          className="screen-remote-input-bar"
          onSubmit={handleRemoteInputSubmit}
        >
          <input
            ref={remoteInputRef}
            id="screen-remote-input"
            type="text"
            className="screen-remote-input"
            placeholder="输入文字发送到 Bot 电脑…"
            value={remoteInputText}
            onChange={(e) => setRemoteInputText(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
          />
          <button
            type="submit"
            id="screen-remote-send-btn"
            className="screen-remote-action-btn is-primary"
            disabled={sendingRemoteInput || !remoteInputText}
          >
            发送
          </button>
          <button
            type="button"
            id="screen-remote-enter-btn"
            className="screen-remote-action-btn"
            disabled={sendingRemoteInput}
            onClick={() => void sendRemotePayload({ key: "Return" })}
          >
            回车
          </button>
          <button
            type="button"
            id="screen-remote-backspace-btn"
            className="screen-remote-action-btn"
            disabled={sendingRemoteInput}
            onClick={() => void sendRemotePayload({ key: "BackSpace" })}
          >
            退格
          </button>
          <button
            type="button"
            id="screen-remote-close-btn"
            className="screen-remote-action-btn"
            onClick={() => {
              setKeyboardOpen(false);
              remoteInputRef.current?.blur();
            }}
          >
            收起
          </button>
        </form>
      )}

      <button
        id="screen-keyboard-btn"
        type="button"
        className={`screen-keyboard-btn${keyboardOpen ? " is-active" : ""}`}
        title={keyboardOpen ? "收起远程键盘输入" : "弹出键盘向 Bot 电脑输入"}
        aria-label={keyboardOpen ? "收起远程键盘输入" : "弹出键盘向 Bot 电脑输入"}
        onClick={handleToggleKeyboard}
      >
        <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect
            x="2.2"
            y="4.5"
            width="15.6"
            height="11"
            rx="2.4"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M5.2 8H6.6M8.6 8H10M12 8H13.4M15.2 8H15.4M5.2 10.6H6.6M8.6 10.6H10M12 10.6H14.8M6.6 13H13.4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </section>
  );
}
