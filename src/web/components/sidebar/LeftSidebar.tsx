import type { MouseEvent as ReactMouseEvent } from "react";
import { LOCAL_ACCOUNT_ID } from "/accounts-store.js";
import { isMobileViewport } from "../../mobile-ui.js";
import {
  clearSessionHistory,
  closeAllPopovers,
  confirmAndRemoveCloudAccount,
  deleteSessionWithConfirm,
  openAppsModal,
  openNewChatBar,
  openSettingsModal,
  refreshUsageAndHealth,
  scrollChatStreamToBottom,
  selectSession,
  showToast,
  switchAccount,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { computeUpdateDecisionKey } from "../../services/ota-updater.js";
import { STATUS_LABELS } from "../../state/constants.js";
import { formatCny } from "../../state/helpers.js";
import {
  getPrimarySessionFromState,
  setState,
  useStore,
} from "../../state/store.js";
import { SessionAvatar } from "../common/AvatarView.js";
import { UiIcon } from "../common/Icon.js";
import { NetworkStatusBanner } from "../common/NetworkStatusBanner.js";
import { getActiveAccountMeta } from "../../services/network-monitor.js";
import { useI18n, resolveLocalizedAccountName, resolveLocalizedProfileName } from "../../services/i18n.js";

export function LeftSidebar({
  onToggleCompact,
  onStartLeftResize,
}: {
  onToggleCompact: () => void;
  onStartLeftResize: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeMap = useStore((s) => s.activeMap);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const primarySession = useStore((s) => getPrimarySessionFromState(s));
  const primarySessionId = primarySession?.id || null;
  const mobileSearchQuery = useStore((s) => s.mobileSearchQuery);
  const openPopover = useStore((s) => s.openPopover);
  const accountsState = useStore((s) => s.accountsState);
  const settings = useStore((s) => s.settings);
  const lastGlobalUsagePayload = useStore((s) => s.lastGlobalUsagePayload);
  const computerStatus = useStore((s) => s.computerStatus);
  const lanNodeOffline = useStore((s) => s.lanNodeOffline);
  const networkHealth = useStore((s) => s.networkHealth);
  const activeAccMeta = getActiveAccountMeta({ accountsState } as any);
  const effectiveNetStatus =
    activeAccMeta.type === "lan" && lanNodeOffline && networkHealth.status !== "recovered"
      ? "offline"
      : networkHealth.status;
  const mobileNodeIsOnline = effectiveNetStatus !== "offline" && !lanNodeOffline;
  const updateState = useStore((s) => s.updateState);
  const { locale, t, tStatus } = useI18n();
  const updateDecision = updateState?.decision;
  const hasVisibleUpdate = Boolean(
    updateDecision &&
      updateDecision.status !== "up-to-date" &&
      computeUpdateDecisionKey(updateDecision) !== updateState?.dismissedVersionKey
  );

  const profile = settings?.profile || { name: "", color: "slate" };
  const profileName = resolveLocalizedProfileName(profile.name, locale, t("sidebar.localUser"));
  const profileColor = String(profile.color || "slate");
  const profileInitial = Array.from(profileName)[0]?.toUpperCase() || "U";

  const activeAccountId = accountsState?.activeAccountId || LOCAL_ACCOUNT_ID;
  const accounts = accountsState?.accounts || [];

  const totalTok = Number(lastGlobalUsagePayload?.totalTokens) || 0;
  const estCny = Number(lastGlobalUsagePayload?.estimatedCostCny) || 0;
  const usageLabel = `${totalTok.toLocaleString()} tok · ${formatCny(estCny)}`;

  const hasComputerProbe =
    computerStatus?.latencyMs !== undefined ||
    Boolean(computerStatus?.detail) ||
    Boolean(computerStatus?.error);
  const accountCompText = !hasComputerProbe
    ? t("common.checking")
    : computerStatus?.online
      ? `${t("common.online")} · ${computerStatus.latencyMs ?? 0}ms`
      : t("common.offline");

  const pinnedLabel =
    primarySession &&
    primarySession.id === sessions[sessions.length - 1]?.id &&
    primarySession.title === "New Session"
      ? "Twinkle"
      : primarySession?.title || "Twinkle";
  const isPinnedActive = primarySession
    ? activeSessionId === primarySession.id
    : true;

  const normalizedQuery = mobileSearchQuery.trim().toLowerCase();
  const visibleSessions = sessions.filter((s: any) => {
    if (primarySession && s.id === primarySession.id) return false;
    if (normalizedQuery) {
      const haystack = `${s.title || ""} ${s.subtitle || ""} ${s.rolePrompt || ""}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) return false;
    }
    return true;
  });

  const openSidebarContextMenu = (x: number, y: number, sessionId: string) => {
    closeAllPopovers();
    const clampedX = typeof window !== "undefined" ? Math.min(x, window.innerWidth - 200) : x;
    const clampedY = typeof window !== "undefined" ? Math.min(y, window.innerHeight - 240) : y;
    setState({
      openPopover: "sidebar-context",
      sidebarContextMenu: { x: clampedX, y: clampedY, sessionId },
    });
  };

  const handleToggleAccountPopover = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const nextOpen = openPopover !== "account";
    closeAllPopovers();
    if (nextOpen) {
      setState({ openPopover: "account" });
      refreshUsageAndHealth();
    }
  };

  const handleAccountAction = (action: string) => {
    setState({ openPopover: null });
    if (action === "usage") openSettingsModal("usage");
    else if (action === "computer") openSettingsModal("computer");
    else if (action === "updates") openSettingsModal("updates");
    else if (action === "shortcuts") setState({ shortcutsDialogOpen: true });
    else if (action === "settings") openSettingsModal("general");
    else if (action === "quit-app") {
      if (typeof window !== "undefined") {
        window.twinklebotDesktop?.quitApp?.();
      }
    }
  };

  const isElectronDesktop =
    typeof window !== "undefined" && Boolean(window.twinklebotDesktop?.quitApp);

  const openUpdatesPanel = () => {
    closeAllPopovers();
    setState({ mobileReturnToSettingsSheet: false });
    openSettingsModal("updates");
  };

  const updateTriggerTitle =
    updateDecision?.status === "ota-available"
      ? updateDecision?.otaKind === "core"
        ? t("sidebar.updateAvailableCore")
        : t("sidebar.updateAvailableWeb")
      : t("sidebar.updateAvailableGeneric");

  return (
    <aside className="sidebar-left" id="sidebar-left" aria-label="Bot">
      <div className="sidebar-top-bar">
        <div className="window-traffic-dots" aria-hidden="true">
          <span className="traffic-dot dot-close" />
          <span className="traffic-dot dot-min" />
          <span className="traffic-dot dot-max" />
        </div>
        <div className="sidebar-top-actions">
          <button
            id="compact-sidebar-btn"
            type="button"
            className="sidebar-icon-btn"
            title={t("sidebar.compactToggle")}
            aria-label={t("sidebar.compactToggle")}
            onClick={onToggleCompact}
          >
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="14" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 4.5V15.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <button
            id="open-search-modal-btn"
            type="button"
            className="sidebar-circle-btn"
            title={t("sidebar.searchTooltip")}
            aria-label={t("sidebar.searchAria")}
            onClick={() => {
              closeAllPopovers();
              setState({ searchModalOpen: true });
              requestAnimationFrame(() => {
                (document.getElementById("palette-search-input") as HTMLInputElement | null)?.focus();
              });
            }}
          >
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="5.4" stroke="currentColor" strokeWidth="1.6" />
              <path d="M13.2 13.2L16.6 16.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            id="new-session-btn"
            type="button"
            className="sidebar-circle-btn"
            title={t("sidebar.newChat")}
            aria-label={t("sidebar.newBot")}
            onClick={() => openNewChatBar(false)}
          >
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mobile-list-topbar mobile-only">
        <button
          id="mobile-settings-btn"
          type="button"
          className="mobile-circle-btn"
          title={t("sidebar.nodesAndSettings")}
          aria-label={t("sidebar.nodesAndSettings")}
          onClick={() => {
            refreshUsageAndHealth();
            setState((prev) => ({
              mobileSheets: { ...prev.mobileSheets, settingsOpen: true },
            }));
          }}
        >
          <span id="mobile-profile-initial">{profileInitial}</span>
          <span
            id="mobile-node-dot"
            className="mobile-node-dot"
            data-online={mobileNodeIsOnline ? "true" : "false"}
            data-net-status={effectiveNetStatus}
            aria-hidden="true"
          />
        </button>
        <div className="mobile-topbar-actions">
          {hasVisibleUpdate && (
            <button
              id="mobile-update-btn"
              type="button"
              className="mobile-circle-btn mobile-update-btn"
              title={updateTriggerTitle}
              aria-label={t("sidebar.updateBadgeAria")}
              onClick={openUpdatesPanel}
            >
              <UiIcon name="cloud-download" size={18} />
            </button>
          )}
          <button
            id="mobile-new-bot-btn"
            type="button"
            className="mobile-circle-btn"
            title={t("sidebar.newBot")}
            aria-label={t("sidebar.newBot")}
            onClick={() =>
              setState((prev) => ({
                mobileSheets: { ...prev.mobileSheets, botEditorOpen: true },
                mobileBotEditor: {
                  mode: "create",
                  sessionId: null,
                  name: "",
                  rolePrompt: "",
                  shape: "cloud",
                  color: "red",
                },
              }))
            }
          >
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <NetworkStatusBanner placement="mobile-list" />

      {/* Pinned Primary Bot (Nori) */}
      <div className="pinned-bot-zone" aria-label={t("sidebar.pinnedZoneAria")}>
        <button
          id="pinned-primary-bot"
          type="button"
          className={`pinned-bot-card${isPinnedActive ? " is-active" : ""}`}
          aria-label={`${pinnedLabel}, ${t("sidebar.primaryBot")}`}
          onClick={() => {
            if (primarySession) {
              selectSession(primarySession.id);
              if (isMobileViewport()) {
                setState({ mobileView: "chat" });
                scrollChatStreamToBottom({ guardMs: 420, settle: true });
              }
            }
          }}
          onContextMenu={(e) => {
            if (!primarySession) return;
            e.preventDefault();
            openSidebarContextMenu(e.clientX, e.clientY, primarySession.id);
          }}
        >
          <div className="pinned-avatar-wrap" id="pinned-avatar-slot">
            <SessionAvatar
              session={primarySession || { avatar: { shape: "blob", color: "black" } }}
              allSessions={sessions}
              primaryId={primarySessionId}
            />
          </div>
          <span className="pinned-star-badge" title={t("sidebar.primaryBot")} aria-hidden="true">
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 3.2L12.05 7.35L16.6 8.02L13.3 11.24L14.08 15.78L10 13.63L5.92 15.78L6.7 11.24L3.4 8.02L7.95 7.35L10 3.2Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className="pinned-bot-label" id="pinned-bot-label">
            {pinnedLabel}
          </span>
        </button>
        <div className="compact-rail-divider" aria-hidden="true" />
      </div>

      {/* Hidden select & search input preserved for programmatic compatibility */}
      <select
        id="session-select"
        className="sr-only"
        aria-label={t("sidebar.sessionSelectAria")}
        value={activeSessionId || ""}
        onChange={(e) => {
          if (e.target.value) selectSession(e.target.value);
        }}
      >
        {sessions.map((s: any) => (
          <option key={s.id} value={s.id}>
            {s.title || "Bot"}
          </option>
        ))}
      </select>
      <input
        id="session-search"
        type="search"
        className="sr-only"
        aria-label={t("sidebar.sessionSearchAria")}
        readOnly
      />
      <select id="model-select" className="sr-only" aria-label={t("sidebar.autoRouteModelAria")} />

      {/* Scrollable Bot / Group List */}
      <div id="session-list" className="session-list" role="listbox" aria-label={t("sidebar.botListAria")}>
        {visibleSessions.map((s: any) => {
          const isActive = s.id === activeSessionId;
          const liveState = activeMap[s.id] || (isActive ? sessionStatus : s.status);
          const isWorking =
            liveState === "running" ||
            liveState === "awaiting_approval" ||
            liveState === "awaiting_choice";
          const rawSub =
            s.subtitle ||
            (s.type === "group"
              ? t("sidebar.groupMembersCount", { count: (s.memberBotIds || []).length })
              : s.rolePrompt || (liveState ? tStatus(liveState) : t("sidebar.ready")));
          const cleanSub = String(rawSub)
            .replace(/\*\*|`+/g, "")
            .replace(/\s+/g, " ")
            .trim();

          return (
            <button
              key={s.id}
              type="button"
              className={`session-item${isActive ? " is-active" : ""}`}
              onClick={() => {
                if (s.id !== activeSessionId) selectSession(s.id);
                if (isMobileViewport()) {
                  setState({ mobileView: "chat" });
                  scrollChatStreamToBottom({ guardMs: 420, settle: true });
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openSidebarContextMenu(e.clientX, e.clientY, s.id);
              }}
            >
              <div className="bot-avatar">
                <SessionAvatar
                  session={s}
                  allSessions={sessions}
                  primaryId={primarySessionId}
                />
              </div>
              <div className="session-item-body">
                <div className="session-item-row">
                  <span className="session-item-title">
                    {s.title && s.title !== "New Session" ? s.title : t("actions.newBotFallback")}
                  </span>
                  <span className="session-badges">
                    {isWorking && (
                      <span className="working-pill-badge">
                        {liveState ? tStatus(liveState) : t("sidebar.workingFallback")}
                      </span>
                    )}
                    {!isActive && Number(s.unreadCount) > 0 && (
                      <span className="unread-blue-dot" title={t("sidebar.unreadCountTitle", { count: s.unreadCount })} />
                    )}
                  </span>
                </div>
                <div className="session-item-sub">{cleanSub}</div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mobile-list-bottombar mobile-only">
        <button
          id="mobile-tools-btn"
          type="button"
          className="mobile-circle-btn"
          title={t("sidebar.skillsStore")}
          aria-label={t("sidebar.skillsStore")}
          onClick={() => {
            setState({ mobileReturnToSettingsSheet: false });
            openAppsModal("store");
          }}
        >
          <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3.2" y="3.2" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
            <rect x="11.4" y="3.2" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
            <rect x="3.2" y="11.4" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
            <rect x="11.4" y="11.4" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        <label className="mobile-search-pill">
          <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="5.4" stroke="currentColor" strokeWidth="1.6" />
            <path d="M13.2 13.2L16.6 16.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            id="mobile-search-input"
            type="search"
            className="mobile-search-input"
            placeholder={t("sidebar.searchPlaceholder")}
            aria-label={t("sidebar.searchPlaceholder")}
            autoComplete="off"
            value={mobileSearchQuery}
            onChange={(e) => setState({ mobileSearchQuery: e.target.value })}
          />
        </label>
      </div>

      {/* Compact Sidebar Bottom Vertical Action Stack */}
      <div className="compact-rail-footer" aria-label={t("sidebar.compactActionsAria")}>
        <button
          id="compact-expand-btn"
          type="button"
          className="sidebar-icon-btn"
          title={t("sidebar.expandSidebar")}
          aria-label={t("sidebar.compactToggle")}
          onClick={onToggleCompact}
        >
          <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3" y="4" width="14" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 4.5V15.5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        <button
          id="compact-new-btn"
          type="button"
          className="sidebar-icon-btn"
          title={t("sidebar.newChat")}
          aria-label={t("sidebar.newBot")}
          onClick={() => openNewChatBar(false)}
        >
          <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
        <button
          id="compact-apps-btn"
          type="button"
          className="sidebar-icon-btn"
          title={t("sidebar.skillsStore")}
          aria-label={t("sidebar.skillsAriaShort")}
          onClick={() => {
            setState({ mobileReturnToSettingsSheet: false });
            openAppsModal("store");
          }}
        >
          <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3.2" y="3.2" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
            <rect x="11.4" y="3.2" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
            <rect x="3.2" y="11.4" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
            <rect x="11.4" y="11.4" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        {hasVisibleUpdate && (
          <button
            id="compact-update-btn"
            type="button"
            className="sidebar-icon-btn sidebar-update-btn"
            title={updateTriggerTitle}
            aria-label={t("sidebar.updateBadgeAria")}
            onClick={openUpdatesPanel}
          >
            <UiIcon name="cloud-download" size={16} />
          </button>
        )}
        <button
          id="compact-account-btn"
          type="button"
          className="user-avatar-circle has-update-anchor"
          data-profile-color={profileColor}
          title={t("sidebar.profileMenuWithName", { name: profileName })}
          aria-label={t("sidebar.openAccountMenu")}
          onClick={handleToggleAccountPopover}
        >
          {profileInitial}
          {hasVisibleUpdate && <span className="update-badge-dot" aria-hidden="true" />}
        </button>
      </div>

      {/* Expanded Bottom Footer */}
      <div className="sidebar-footer">
        <button
          id="account-menu-btn"
          type="button"
          className="user-profile-btn"
          title={t("sidebar.openAccountMenu")}
          onClick={handleToggleAccountPopover}
        >
          <span
            id="sidebar-user-avatar"
            className="user-avatar-circle has-update-anchor"
            data-profile-color={profileColor}
          >
            {profileInitial}
            {hasVisibleUpdate && <span className="update-badge-dot" aria-hidden="true" />}
          </span>
          <span id="sidebar-user-name" className="user-profile-name">
            {profileName}
          </span>
        </button>

        <div className="sidebar-footer-actions">
          <button
            id="connect-apps-btn"
            type="button"
            className="sidebar-icon-btn"
            title={t("sidebar.skillsStore")}
            aria-label={t("sidebar.skillsAriaShort")}
            onClick={() => {
              setState({ mobileReturnToSettingsSheet: false });
              openAppsModal("store");
            }}
          >
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="3.2" y="3.2" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
              <rect x="11.4" y="3.2" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
              <rect x="3.2" y="11.4" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
              <rect x="11.4" y="11.4" width="5.4" height="5.4" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          {hasVisibleUpdate && (
            <button
              id="sidebar-update-btn"
              type="button"
              className="sidebar-icon-btn sidebar-update-btn"
              title={updateTriggerTitle}
              aria-label={t("sidebar.updateBadgeAria")}
              onClick={openUpdatesPanel}
            >
              <UiIcon name="cloud-download" size={17} />
            </button>
          )}
        </div>
      </div>

      {/* Personal & Workspace Menu Popover */}
      <div
        id="account-popover"
        className="floating-menu account-popover"
        aria-label={t("sidebar.accountPopoverAria")}
        hidden={openPopover !== "account"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="account-popover-section-label">{t("sidebar.accountsHeading")}</div>
        <div
          id="account-list-section"
          className="account-list-section"
          role="group"
          aria-label={t("sidebar.accountSwitchAria")}
        >
          {accounts.map((acc: any) => {
            const isActiveAcc = acc.id === activeAccountId;
            const accDisplayName = resolveLocalizedAccountName(acc, locale, acc.id);
            return (
              <div key={acc.id} className="account-switch-row">
                <button
                  type="button"
                  className={`account-switch-item${isActiveAcc ? " is-active" : ""}`}
                  data-account-id={acc.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setState({ openPopover: null });
                    if (!isActiveAcc) {
                      switchAccount(acc.id);
                    }
                  }}
                >
                  <span className="account-switch-meta">
                    <span className="account-switch-name">
                      <UiIcon
                        name={acc.type === "local" ? "laptop" : "cloud"}
                        className="inline-ui-icon"
                        size={14}
                      />
                      {accDisplayName}
                    </span>
                    <span className="account-switch-sub">
                      {acc.type === "local"
                        ? t("sidebar.localWorkspace")
                        : acc.baseUrl || t("sidebar.cloudServiceFallback")}
                    </span>
                  </span>
                  <span>
                    {isActiveAcc && (
                      <UiIcon
                        name="check"
                        className="inline-ui-icon inline-status-svg is-ok"
                        size={14}
                      />
                    )}
                  </span>
                </button>
                {acc.type === "cloud" && (
                  <button
                    type="button"
                    className="account-remove-btn"
                    title={t("sidebar.removeCloudAccountTitle")}
                    aria-label={t("sidebar.removeAccountAria", { name: accDisplayName })}
                    onClick={(e) => {
                      e.stopPropagation();
                      confirmAndRemoveCloudAccount(acc, { mobileFallback: false });
                    }}
                  >
                    <UiIcon name="x" size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          id="add-cloud-account-btn"
          type="button"
          className="menu-item-row account-add-cloud-btn"
          onClick={(e) => {
            e.stopPropagation();
            setState({
              openPopover: null,
              cloudAccountModal: {
                open: true,
                id: "",
                baseUrl: "",
                name: "",
                authToken: "",
                feedback: "",
              },
            });
            requestAnimationFrame(() => {
              (document.getElementById("cloud-account-url-input") as HTMLInputElement | null)?.focus();
            });
          }}
        >
          <span className="menu-item-leading">
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>{t("sidebar.addCloudAccount")}</span>
          </span>
        </button>
        <div className="menu-divider" role="separator" />
        <button
          type="button"
          className="menu-item-row"
          data-account-action="usage"
          onClick={() => handleAccountAction("usage")}
        >
          <span className="menu-item-leading">
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M4 13.5A6 6 0 1 1 16 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M10 10.5L13 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>{t("sidebar.accountUsage")}</span>
          </span>
          <span className="menu-item-trailing">
            <span id="account-usage-pct">{usageLabel}</span>{" "}
            <span className="menu-chevron" aria-hidden="true">
              <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                <path d="M7.8 5.2L12.6 10L7.8 14.8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </span>
        </button>
        <button
          type="button"
          className="menu-item-row"
          data-account-action="computer"
          onClick={() => handleAccountAction("computer")}
        >
          <span className="menu-item-leading">
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="14" height="9.5" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M7.5 16.2H12.5M10 13.5V16.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>{t("sidebar.accountComputer")}</span>
          </span>
          <span className="menu-item-trailing">
            <span
              id="account-computer-status"
              className={`account-status-pill${hasComputerProbe && computerStatus?.online ? " is-online" : ""}`}
            >
              {accountCompText}
            </span>{" "}
            <span className="menu-chevron" aria-hidden="true">
              <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                <path d="M7.8 5.2L12.6 10L7.8 14.8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </span>
        </button>
        <button
          type="button"
          className="menu-item-row"
          data-account-action="shortcuts"
          onClick={() => handleAccountAction("shortcuts")}
        >
          <span className="menu-item-leading">
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="2.8" y="5" width="14.4" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M6 8.5H7.2M9.4 8.5H10.6M12.8 8.5H14M6.5 12H13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>{t("sidebar.accountShortcuts")}</span>
          </span>
          <span className="menu-item-trailing">
            <span className="menu-chevron" aria-hidden="true">
              <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                <path d="M7.8 5.2L12.6 10L7.8 14.8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </span>
        </button>
        <button
          type="button"
          className="menu-item-row"
          data-account-action="settings"
          onClick={() => handleAccountAction("settings")}
        >
          <span className="menu-item-leading">
            <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M10 3.2V5M10 15V16.8M3.2 10H5M15 10H16.8M5.2 5.2L6.5 6.5M13.5 13.5L14.8 14.8M14.8 5.2L13.5 6.5M6.5 13.5L5.2 14.8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <span>{t("sidebar.settings")}</span>
          </span>
          <span className="menu-item-trailing">
            {hasVisibleUpdate ? (
              <span
                className="account-status-pill is-online"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAccountAction("updates");
                }}
              >
                {updateDecision?.status === "ota-available" ? t("sidebar.otaPill") : t("sidebar.newVersionPill")}
              </span>
            ) : (
              <kbd className="menu-kbd">⌘,</kbd>
            )}
          </span>
        </button>
        <div id="electron-quit-section" hidden={!isElectronDesktop}>
          <div className="menu-divider" role="separator" />
          <button
            type="button"
            className="menu-item-row"
            data-account-action="quit-app"
            onClick={() => handleAccountAction("quit-app")}
          >
            <span className="menu-item-leading">
              <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 3.5V10M6.2 5.4A6.2 6.2 0 1 0 13.8 5.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>{t("sidebar.accountQuit")}</span>
            </span>
          </button>
        </div>
      </div>

      {/* Draggable Left Resize Handle */}
      <div
        id="left-splitter"
        className="pane-splitter splitter-right"
        role="separator"
        aria-label={t("sidebar.resizeLeftAria")}
        onMouseDown={onStartLeftResize}
      />
    </aside>
  );
}

export function SidebarContextMenu() {
  const { t } = useI18n();
  const openPopover = useStore((s) => s.openPopover);
  const ctx = useStore((s) => s.sidebarContextMenu);
  const sessions = useStore((s) => s.sessions);

  const isOpen = openPopover === "sidebar-context" && Boolean(ctx.sessionId);
  const target = sessions.find((s: any) => s.id === ctx.sessionId) || null;
  const hideDelete = Boolean(target?.isAdmin);

  const handleAction = async (act: string) => {
    const sid = ctx.sessionId;
    setState({ openPopover: null });
    if (!sid || !target) return;

    if (act === "pin") {
      showToast(t("sidebar.pinForbiddenToast"));
    } else if (act === "rename") {
      await selectSession(sid);
      setState({ inspectorOpen: true });
      requestAnimationFrame(() => {
        const inp = document.getElementById("inspector-bot-name-input") as HTMLInputElement | null;
        inp?.focus();
        inp?.select();
      });
    } else if (act === "clone") {
      const cloned = await apiJson(`/api/sessions/${sid}/clone`, { method: "POST" });
      upsertLocalSession(cloned);
      await selectSession(cloned.id);
      showToast(t("sidebar.clonedToast", { title: cloned.title }));
    } else if (act === "clear") {
      await clearSessionHistory(sid);
    } else if (act === "delete") {
      await deleteSessionWithConfirm(sid);
    }
  };

  return (
    <div
      id="sidebar-context-menu"
      className="floating-menu sidebar-context-menu"
      hidden={!isOpen}
      style={isOpen ? { left: `${ctx.x}px`, top: `${ctx.y}px` } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="menu-item-row"
        data-ctx-action="pin"
        hidden={true}
        onClick={() => handleAction("pin")}
      >
        {t("sidebar.ctxPinToggle")}
      </button>
      <button
        type="button"
        className="menu-item-row"
        data-ctx-action="rename"
        onClick={() => handleAction("rename")}
      >
        {t("sidebar.ctxRename")}
      </button>
      <button
        type="button"
        className="menu-item-row"
        data-ctx-action="clone"
        onClick={() => handleAction("clone")}
      >
        {t("sidebar.ctxDuplicate")}
      </button>
      <button
        type="button"
        className="menu-item-row"
        data-ctx-action="clear"
        onClick={() => handleAction("clear")}
      >
        {t("sidebar.ctxClear")}
      </button>
      <div className="menu-divider" hidden={hideDelete} />
      <button
        type="button"
        className="menu-item-row danger-text"
        data-ctx-action="delete"
        hidden={hideDelete}
        onClick={() => handleAction("delete")}
      >
        {t("common.delete")}
      </button>
    </div>
  );
}
