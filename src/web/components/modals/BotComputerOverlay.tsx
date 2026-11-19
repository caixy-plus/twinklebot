import { resolveBotAvatar } from "../../avatars.js";
import {
  closeBotScreenOverlay,
  setNovncMode,
  stopCurrentSessionTask,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { hasConnectedNodeCapability } from "../../services/ota-updater.js";
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
        title="退出全屏"
        aria-label="退出全屏"
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
              {boundDisplay.startsWith(":")
                ? ` · ${displayName} (${boundDisplay})`
                : isGroup && boundDisplay
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
                setTimeout(() => setState({ screenConnecting: false }), 420);
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
                    {mDisp.startsWith(":") ? ` (${mDisp})` : ""}
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
    </section>
  );
}
