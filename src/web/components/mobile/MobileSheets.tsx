import { useEffect, useState } from "react";
import { LOCAL_ACCOUNT_ID } from "/accounts-store.js";
import {
  BOT_COLORS,
  BOT_SHAPES,
  getBotColorLabel,
  getBotShapeLabel,
  resolveBotAvatar,
} from "../../avatars.js";
import { useAnimatedSheet } from "../../hooks/useAnimatedSheet.js";
import { isNativeQrScannerAvailable, scanQrCodeNative } from "../../mobile-bridge.js";
import { isMobileViewport } from "../../mobile-ui.js";
import {
  applyLanguagePreference,
  bindScrollEndTracking,
  confirmAndRemoveCloudAccount,
  handleBotComputerCardActivate,
  importRemoteAccountFromInput,
  initiateLanPairing,
  openSettingsModal,
  refreshLibrary,
  retryActiveLanConnection,
  scanAndRenderLanNodes,
  selectCloudHost,
  selectSession,
  showToast,
  submitLanPairingCode,
  switchAccount,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson, dismissLanOfflineModal } from "../../services/api-client.js";
import {
  computeUpdateDecisionKey,
  hasConnectedNodeCapability,
} from "../../services/ota-updater.js";
import {
  isMobileAccountEnvironment,
  shouldShowAccountDisconnectedGate,
} from "../../services/network-monitor.js";
import { useI18n, resolveLocalizedAccountName, resolveLocalizedProfileName } from "../../services/i18n.js";
import { resolveBotComputerStatusDisplay } from "/shared/computer-status.js";
import {
  formatBrowserAutomationModeLabel,
  normalizeBotBrowserMode,
  normalizeBrowserAutomationMode,
} from "/shared/browser-automation.js";
import { formatCny } from "../../state/helpers.js";
import {
  getActiveSessionFromState,
  setState,
  useStore,
} from "../../state/store.js";
import { AvatarNode, MascotSvg } from "../common/AvatarView.js";
import { StatusText, UiIcon } from "../common/Icon.js";
import {
  BotMemoriesList,
  LibraryItemsPanel,
  SchedulesList,
} from "../common/SharedPanels.js";

export function MobileSheets() {
  const mobileSheets = useStore((s) => s.mobileSheets);
  const mobileBotEditor = useStore((s) => s.mobileBotEditor);
  const activeSession = useStore((s) => getActiveSessionFromState(s));
  const sessions = useStore((s) => s.sessions);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const computerStatus = useStore((s) => s.computerStatus);
  const config = useStore((s) => s.config);
  const isMobileClient = useStore((s) => s.isMobileClient);
  const accountsState = useStore((s) => s.accountsState);
  const networkHealth = useStore((s) => s.networkHealth);
  const lanNodeOffline = useStore((s) => s.lanNodeOffline);
  const onlineCloudHosts = useStore((s) => s.onlineCloudHosts);
  const selectedCloudHostId = useStore((s) => s.selectedCloudHostId);
  const lanDiscoveredDevices = useStore((s) => s.lanDiscoveredDevices);
  const lanScanning = useStore((s) => s.lanScanning);
  const pendingPairingDevice = useStore((s) => s.pendingPairingDevice);
  const mobilePairModalOpen = useStore((s) => s.mobilePairModalOpen);
  const mobilePairFeedback = useStore((s) => s.mobilePairFeedback);
  const lanOfflineModalShown = useStore((s) => s.lanOfflineModalShown);
  const accountEpoch = useStore((s) => s.accountEpoch);
  const settings = useStore((s) => s.settings);
  const diagnostics = useStore((s) => s.diagnostics);
  const { language: currentLanguage, locale, t } = useI18n();
  const lastGlobalUsagePayload = useStore((s) => s.lastGlobalUsagePayload);
  const updateState = useStore((s) => s.updateState);
  const updateDecision = updateState?.decision;
  const hasVisibleUpdate = Boolean(
    updateDecision &&
      updateDecision.status !== "up-to-date" &&
      computeUpdateDecisionKey(updateDecision) !== updateState?.dismissedVersionKey
  );
  const libraryFilter = useStore((s) => s.libraryFilter);

  const closeInspector = () =>
    setState((prev) => ({
      mobileSheets: { ...prev.mobileSheets, inspectorOpen: false },
    }));
  const closeSettings = () =>
    setState((prev) => ({
      mobileSheets: { ...prev.mobileSheets, settingsOpen: false },
    }));
  const closeNode = () =>
    setState((prev) => ({
      mobileSheets: { ...prev.mobileSheets, nodeOpen: false },
    }));
  const closeBotEditor = () =>
    setState((prev) => ({
      mobileSheets: { ...prev.mobileSheets, botEditorOpen: false },
    }));

  const inspectorAnim = useAnimatedSheet(mobileSheets.inspectorOpen, closeInspector, { axis: "y" });
  const settingsAnim = useAnimatedSheet(mobileSheets.settingsOpen, closeSettings, { axis: "x" });
  const nodeAnim = useAnimatedSheet(mobileSheets.nodeOpen, closeNode, { axis: "y" });
  const botEditorAnim = useAnimatedSheet(mobileSheets.botEditorOpen, closeBotEditor, { axis: "x" });

  const [personaDraft, setPersonaDraft] = useState(activeSession?.rolePrompt || "");
  useEffect(() => {
    setPersonaDraft(activeSession?.rolePrompt || "");
  }, [activeSession?.id, activeSession?.rolePrompt]);

  const [manualIp, setManualIp] = useState("");
  const [lanRetrying, setLanRetrying] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [qrScanning, setQrScanning] = useState(false);

  useEffect(() => {
    if (!mobilePairModalOpen) setPairCode("");
  }, [mobilePairModalOpen]);

  // Derived mobile summary info
  const isMobEnv = isMobileAccountEnvironment({ isMobileClient } as any);
  const rawAccounts = accountsState?.accounts || [];
  const accounts = isMobEnv
    ? rawAccounts.filter((a: any) => a && a.type !== "local")
    : rawAccounts;
  const activeAccId = accountsState?.activeAccountId || (isMobEnv ? "" : LOCAL_ACCOUNT_ID);
  const activeAcc = accounts.find((a: any) => a.id === activeAccId) || null;
  const gateOpen = shouldShowAccountDisconnectedGate({
    isMobileClient,
    accountsState,
    networkHealth,
    lanNodeOffline,
    updateState,
  } as any);
  const isCloudMode = activeAcc?.type === "cloud" || config?.deployEnv === "cloud";
  const displayNodeName = activeAcc
    ? resolveLocalizedAccountName(
        activeAcc,
        locale,
        activeAcc.type === "cloud" ? t("mobile.cloudNodeFallback") : t("mobile.nodeDisconnected")
      )
    : t("mobile.nodeDisconnected");
  const profileName = resolveLocalizedProfileName(
    settings?.profile?.name,
    locale,
    displayNodeName || "U"
  );
  const initial = String(profileName).trim().charAt(0).toUpperCase() || "U";

  const nodeSubText =
    activeAcc?.type === "lan"
      ? t("mobile.lanNodeSub", { url: activeAcc.baseUrl })
      : activeAcc?.type === "cloud"
        ? t("mobile.cloudNodeSub", { url: activeAcc.baseUrl })
        : t("mobile.tapScanOrAddNode");

  const handleMobileScanCloudQr = async () => {
    if (qrScanning) return;
    setQrScanning(true);
    try {
      const scanRes = await scanQrCodeNative(t("mobile.qrScanPrompt"));
      if (scanRes.unsupported) {
        showToast(t("mobile.qrUnsupportedToast"));
        setState({
          cloudAccountModal: {
            open: true,
            id: "",
            baseUrl: "",
            name: "",
            authToken: "",
            feedback: "",
          },
        });
        return;
      }
      if (scanRes.permissionDenied) {
        showToast(t("mobile.qrPermissionDeniedToast"));
        return;
      }
      if (scanRes.cancelled || !scanRes.ok || !scanRes.content) {
        return;
      }
      const imported = await importRemoteAccountFromInput({
        rawUrlOrInvite: scanRes.content,
        switchAfter: true,
      });
      closeNode();
      showToast(
        t("mobile.cloudQrAddedToast", {
          name: imported.account?.name || imported.account?.baseUrl || "",
        })
      );
    } catch (err: any) {
      showToast(t("mobile.qrInvalidToast", { error: err?.message || t("actions.requestError") }));
    } finally {
      setQrScanning(false);
    }
  };

  const totalTok = Number(lastGlobalUsagePayload?.totalTokens) || 0;
  const estCny = Number(lastGlobalUsagePayload?.estimatedCostCny) || 0;
  const usageSubText = `${totalTok.toLocaleString()} tok · ${formatCny(estCny)}`;

  const policy = settings?.policy || {};
  const ruleCount = (policy.askRules?.length || 0) + (policy.allowRules?.length || 0);
  const permSubText = t("mobile.permSubSummary", {
    audit:
      policy.autoAudit !== false ? t("mobile.autoAuditOn") : t("mobile.autoAuditOff"),
    count: ruleCount,
  });

  const { mobileSubText: mobileCompSub } = resolveBotComputerStatusDisplay(computerStatus, {
    locale,
  });

  const cloudHostOffline = isCloudMode && onlineCloudHosts.length === 0;
  const activeCloudHost =
    onlineCloudHosts.find((h: any) => h.clientId === selectedCloudHostId) ||
    onlineCloudHosts[0];
  const hostStatusBadgeText = cloudHostOffline
    ? t("mobile.hostOffline")
    : isCloudMode
      ? t("mobile.hostCloudOnline", {
          name: activeCloudHost?.hostname || t("mobile.hostConnected"),
        })
      : t("mobile.hostLocalOnline");

  const memories = Array.isArray(activeSession?.memories) ? activeSession.memories : [];
  const activeMemCount = memories.filter((m: any) => m && m.enabled !== false).length;
  const memCountBadge = memories.length > 0 ? `(${activeMemCount}/${memories.length})` : "";

  // Node switcher lists
  const pairedLans = accounts.filter((a: any) => a.type === "lan");
  const seenLanUrls = new Set(pairedLans.map((a: any) => a.baseUrl));
  const unpairedDiscovered = (lanDiscoveredDevices || []).filter(
    (d: any) => !seenLanUrls.has(d.baseUrl)
  );
  const cloudAccounts = accounts.filter((a: any) => a.type === "cloud");

  const handleSaveMobileBot = async () => {
    const title = mobileBotEditor.name.trim() || t("actions.newBotFallback");
    const rolePrompt = mobileBotEditor.rolePrompt.trim();
    const avatar = {
      shape: mobileBotEditor.shape,
      color: mobileBotEditor.color,
    };
    try {
      if (mobileBotEditor.mode === "edit" && mobileBotEditor.sessionId) {
        const updated = await apiJson(`/api/sessions/${mobileBotEditor.sessionId}`, {
          method: "PATCH",
          body: JSON.stringify({ title, rolePrompt, avatar }),
        });
        upsertLocalSession(updated);
        closeBotEditor();
        showToast(t("mobile.botUpdatedToast"));
      } else {
        const created = await apiJson("/api/sessions", {
          method: "POST",
          body: JSON.stringify({ title, rolePrompt, avatar }),
        });
        upsertLocalSession(created);
        closeBotEditor();
        await selectSession(created.id);
        if (isMobileViewport()) {
          setState({ mobileView: "chat" });
        }
      }
    } catch (err: any) {
      showToast(t("mobile.saveFailedToast", { error: err.message }));
    }
  };

  const handleManualPair = async () => {
    const raw = manualIp.trim();
    if (!raw) {
      showToast(t("mobile.enterLanIpToast"));
      return;
    }
    const clean = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(clean);
      if (!parsedUrl.port) parsedUrl.port = "3230";
    } catch {
      showToast(t("mobile.invalidIpToast"));
      return;
    }
    const baseUrl = parsedUrl.origin;
    let hostname = parsedUrl.hostname;
    let instanceId = "";
    let platform = "";
    try {
      const infoRes = await fetch(`${baseUrl}/api/discovery/info`, {
        signal: AbortSignal.timeout(2500),
      });
      const info = await infoRes.json().catch(() => null);
      if (info?.ok) {
        hostname = info.hostname || hostname;
        instanceId = info.instanceId || "";
        platform = info.platform || "";
      }
    } catch {}
    await initiateLanPairing({
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port) || 3230,
      baseUrl,
      hostname,
      instanceId,
      platform,
    });
  };

  const isEditBot = mobileBotEditor.mode === "edit" && Boolean(mobileBotEditor.sessionId);

  return (
    <>
      {/* ==================== MOBILE INSPECTOR SHEET ==================== */}
      <div
        id="mobile-inspector-sheet"
        className={`mobile-sheet is-tall${inspectorAnim.stateClass ? ` ${inspectorAnim.stateClass}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("mobile.inspectorAria")}
        hidden={inspectorAnim.hidden}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeInspector();
        }}
      >
        <div ref={inspectorAnim.panelRef} className="mobile-sheet-panel">
          <div
            className="mobile-sheet-handle"
            aria-hidden="true"
            {...inspectorAnim.handleProps}
          />
          <div className="mobile-sheet-header">
            <h2 className="mobile-sheet-title" id="mobile-inspector-title">
              {activeSession?.title || t("mobile.inspectorAria")}
            </h2>
            <button
              id="mobile-edit-bot-btn"
              type="button"
              className="settings-pill-btn"
              onClick={() => {
                closeInspector();
                if (activeSession) {
                  const av = resolveBotAvatar(activeSession, primarySessionId);
                  setState((prev) => ({
                    mobileSheets: { ...prev.mobileSheets, botEditorOpen: true },
                    mobileBotEditor: {
                      mode: "edit",
                      sessionId: activeSession.id,
                      name: activeSession.title || "",
                      rolePrompt: activeSession.rolePrompt || "",
                      shape: av.shape || "blob",
                      color: av.color || "red",
                    },
                  }));
                }
              }}
            >
              {t("mobile.botEditTitle")}
            </button>
          </div>

          <div className="mobile-sheet-tabs" role="tablist">
            <button
              type="button"
              className={`mobile-sheet-tab${
                mobileSheets.inspectorTab === "activity" ? " is-active" : ""
              }`}
              data-mobile-inspector-tab="activity"
              onClick={() =>
                setState((prev) => ({
                  mobileSheets: { ...prev.mobileSheets, inspectorTab: "activity" },
                }))
              }
            >
              {t("inspector.tabActivity")}
            </button>
            <button
              type="button"
              className={`mobile-sheet-tab${
                mobileSheets.inspectorTab === "library" ? " is-active" : ""
              }`}
              data-mobile-inspector-tab="library"
              onClick={() => {
                setState((prev) => ({
                  mobileSheets: { ...prev.mobileSheets, inspectorTab: "library" },
                }));
                refreshLibrary();
              }}
            >
              {t("inspector.tabLibrary")}
            </button>
          </div>

          <div
            data-mobile-inspector-pane="activity"
            className="mobile-inspector-pane mobile-inspector-scroll"
            hidden={mobileSheets.inspectorTab !== "activity"}
          >
            <section className="mobile-inspector-section">
              <div className="mobile-section-caption">{t("mobile.computerFeedCaption")}</div>
              <div className="mobile-grouped-card">
                <button
                  id="mobile-bot-computer-open-btn"
                  type="button"
                  className="mobile-card-row"
                  onClick={() => {
                    closeInspector();
                    handleBotComputerCardActivate();
                  }}
                >
                  <div>
                    <div className="mobile-card-row-title">{t("mobile.botComputerSandboxTitle")}</div>
                    <div className="mobile-card-row-sub" id="mobile-bot-computer-sub">
                      {mobileCompSub}
                    </div>
                  </div>
                  <span className="menu-chevron" aria-hidden="true">
                    <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                      <path
                        d="M7.8 5.2L12.6 10L7.8 14.8"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </button>
                <div
                  id="mobile-host-control-card"
                  className={`mobile-card-row mobile-host-card${cloudHostOffline ? " is-disabled" : ""}`}
                  aria-disabled={cloudHostOffline ? "true" : "false"}
                >
                  <div>
                    <div className="mobile-card-row-title">{t("mobile.hostComputerTitle")}</div>
                    <div className="mobile-card-row-sub" id="mobile-host-status-badge">
                      {hostStatusBadgeText}
                    </div>
                  </div>
                </div>
              </div>
              <div
                id="mobile-cloud-hosts-list"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  marginTop: "8px",
                }}
                hidden={!isCloudMode || onlineCloudHosts.length <= 1}
              >
                {isCloudMode &&
                  onlineCloudHosts.length > 1 &&
                  onlineCloudHosts.map((h: any) => (
                    <button
                      key={h.clientId}
                      type="button"
                      className="mobile-card-row"
                      onClick={() => selectCloudHost(h.clientId)}
                    >
                      <span>{h.hostname || h.clientId}</span>
                      <span>
                        {selectedCloudHostId === h.clientId
                          ? t("common.current")
                          : t("common.switch")}
                      </span>
                    </button>
                  ))}
              </div>
            </section>

            <section className="mobile-inspector-section">
              <div className="mobile-sheet-header">
                <span className="mobile-section-caption">{t("inspector.personaLabel")}</span>
                <button
                  id="mobile-inspector-persona-save-btn"
                  type="button"
                  className="settings-blue-pill"
                  onClick={async () => {
                    if (!activeSession?.id) return;
                    try {
                      const updated = await apiJson(`/api/sessions/${activeSession.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ rolePrompt: personaDraft }),
                      });
                      upsertLocalSession(updated);
                      showToast(t("inspector.personaSaved"));
                    } catch (err: any) {
                      showToast(t("mobile.saveFailedToast", { error: err.message }));
                    }
                  }}
                >
                  {t("mobile.savePersonaBtn")}
                </button>
              </div>
              <textarea
                id="mobile-inspector-persona-input"
                className="persona-textarea"
                rows={3}
                placeholder={t("mobile.personaPlaceholder")}
                value={personaDraft}
                onChange={(e) => setPersonaDraft(e.target.value)}
              />
            </section>

            {activeSession?.type !== "group" &&
              hasConnectedNodeCapability("local-browser-automation-v1", { diagnostics }) && (
                <section className="mobile-inspector-section" id="mobile-bot-browser-mode-section">
                  <div className="mobile-sheet-header">
                    <span className="mobile-section-caption">{t("inspector.browserEngineLabel")}</span>
                  </div>
                  <select
                    id="mobile-bot-browser-mode-select"
                    className="settings-select"
                    aria-label={t("inspector.browserEngineLabel")}
                    value={normalizeBotBrowserMode(activeSession?.browserMode)}
                    onChange={async (e) => {
                      if (!activeSession?.id) return;
                      const browserMode = normalizeBotBrowserMode(e.target.value);
                      try {
                        const updated = await apiJson(`/api/sessions/${activeSession.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ browserMode, touch: false }),
                        });
                        upsertLocalSession(updated);
                        showToast(
                          `${t("inspector.browserEngineLabel")}: ${formatBrowserAutomationModeLabel(
                            browserMode,
                            locale
                          )}`
                        );
                      } catch (err: any) {
                        showToast(`${err?.message || "Error"}`);
                      }
                    }}
                  >
                    <option value="inherit">
                      {t("inspector.browserEngineFollow", {
                        mode: formatBrowserAutomationModeLabel(
                          normalizeBrowserAutomationMode(settings?.browserAutomation?.mode),
                          locale
                        ),
                      })}
                    </option>
                    <option value="bot_computer">{t("browser.modeBotComputer")}</option>
                    <option value="local_headless">{t("browser.modeLocalHeadless")}</option>
                    <option value="local_debug">{t("browser.modeLocalDebug")}</option>
                  </select>
                </section>
              )}

            <section className="mobile-inspector-section">
              <div className="mobile-sheet-header">
                <span className="mobile-section-caption">
                  {t("inspector.memoryLabel")}{" "}
                  <span id="mobile-bot-memory-count-badge" className="section-sub-count">
                    {memCountBadge}
                  </span>
                </span>
                <button
                  id="mobile-new-bot-memory-btn"
                  type="button"
                  className="settings-pill-btn"
                  onClick={() => {
                    setState({
                      botMemoryModal: {
                        open: true,
                        sessionId: activeSession?.id || null,
                        memoryId: null,
                        name: "",
                        content: "",
                      },
                    });
                    requestAnimationFrame(() => {
                      (
                        document.getElementById(
                          "bot-memory-modal-name-input"
                        ) as HTMLInputElement | null
                      )?.focus();
                    });
                  }}
                >
                  {t("inspector.memoryAdd")}
                </button>
              </div>
              <BotMemoriesList
                session={activeSession}
                listId="mobile-inspector-memories-list"
              />
            </section>

            <section className="mobile-inspector-section">
              <div className="mobile-sheet-header">
                <span className="mobile-section-caption">{t("inspector.schedulesLabel")}</span>
                <button
                  id="mobile-new-schedule-btn"
                  type="button"
                  className="settings-pill-btn"
                  onClick={() => {
                    setState({ scheduleModalOpen: true, editingScheduleId: null });
                    requestAnimationFrame(() => {
                      (
                        document.getElementById("sched-title-input") as HTMLInputElement | null
                      )?.focus();
                    });
                  }}
                >
                  {t("inspector.schedulesAdd")}
                </button>
              </div>
              <SchedulesList listId="mobile-inspector-schedules-list" />
            </section>
          </div>

          <div
            data-mobile-inspector-pane="library"
            className="mobile-inspector-pane mobile-inspector-scroll"
            hidden={mobileSheets.inspectorTab !== "library"}
          >
            <div className="mobile-sheet-header">
              <div
                className="library-filter-pills"
                role="group"
                aria-label={t("mobile.libraryTypeAria")}
                style={{ marginBottom: 0 }}
              >
                {(
                  [
                    ["all", t("inspector.libraryAll")],
                    ["media", t("inspector.libraryMedia")],
                    ["file", t("inspector.libraryFiles")],
                  ] as const
                ).map(([fKey, fLabel]) => (
                  <button
                    key={fKey}
                    type="button"
                    className={`filter-pill${libraryFilter === fKey ? " is-active" : ""}`}
                    data-mobile-lib-filter={fKey}
                    onClick={() => setState({ libraryFilter: fKey })}
                  >
                    {fLabel}
                  </button>
                ))}
              </div>
              <button
                id="mobile-refresh-library-btn"
                type="button"
                className="settings-pill-btn"
                onClick={refreshLibrary}
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
                <span>{t("common.refresh")}</span>
              </button>
            </div>
            <div className="library-card">
              <LibraryItemsPanel
                listId="mobile-inspector-library-list"
                expandBtnId="mobile-library-expand-btn"
                ariaLabel={t("mobile.libraryListAria")}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ==================== MOBILE SETTINGS SHEET ==================== */}
      <div
        id="mobile-settings-sheet"
        className={`mobile-sheet is-fullscreen${settingsAnim.stateClass ? ` ${settingsAnim.stateClass}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("mobile.settingsAria")}
        hidden={settingsAnim.hidden}
      >
        <div
          ref={(node) => {
            settingsAnim.panelRef.current = node;
            bindScrollEndTracking(node);
          }}
          className="mobile-sheet-panel"
          {...settingsAnim.handleProps}
        >
          <div className="mobile-sheet-header">
            <button
              id="mobile-settings-close-btn"
              type="button"
              className="mobile-circle-btn"
              title={t("common.back")}
              aria-label={t("common.back")}
              onClick={closeSettings}
            >
              <UiIcon name="chevron-left" />
            </button>
            <h2 className="mobile-sheet-title">{t("mobile.settingsTitle")}</h2>
            <span style={{ width: "42px" }} aria-hidden="true" />
          </div>

          <div className="mobile-grouped-card">
            <button
              id="mobile-node-switcher-card"
              type="button"
              className="mobile-card-row"
              onClick={() => {
                setState((prev) => ({
                  mobileSheets: { ...prev.mobileSheets, nodeOpen: true },
                }));
                scanAndRenderLanNodes();
              }}
            >
              <div className="mobile-node-card-left">
                <span id="mobile-settings-avatar" className="user-avatar-circle">
                  {initial}
                </span>
                <div className="mobile-node-card-meta">
                  <div className="mobile-card-row-title" id="mobile-active-node-name">
                    {activeAcc ? (
                      <>
                        <UiIcon
                          name={activeAcc.type === "cloud" ? "cloud" : "laptop"}
                          className="inline-ui-icon"
                          size={15}
                        />
                        {displayNodeName}
                      </>
                    ) : (
                      t("mobile.nodeDisconnected")
                    )}
                  </div>
                  <div className="mobile-card-row-sub" id="mobile-active-node-sub">
                    {nodeSubText}
                  </div>
                </div>
              </div>
              <span className="menu-chevron" aria-hidden="true">
                <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M7.8 5.2L12.6 10L7.8 14.8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>

            <button
              id="mobile-settings-usage-row"
              type="button"
              className="mobile-card-row"
              onClick={() => {
                setState({ mobileReturnToSettingsSheet: true });
                closeSettings();
                openSettingsModal("usage");
              }}
            >
              <div>
                <div className="mobile-card-row-title">{t("settings.tabUsage")}</div>
                <div className="mobile-card-row-sub" id="mobile-settings-usage-sub">
                  {usageSubText}
                </div>
              </div>
              <span className="menu-chevron" aria-hidden="true">
                <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M7.8 5.2L12.6 10L7.8 14.8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>

            <button
              id="mobile-settings-vault-row"
              type="button"
              className="mobile-card-row"
              onClick={() => {
                setState({ mobileReturnToSettingsSheet: true });
                closeSettings();
                openSettingsModal("vault");
              }}
            >
              <div>
                <div className="mobile-card-row-title">{t("settings.tabVault")}</div>
                <div className="mobile-card-row-sub">{t("mobile.vaultSub")}</div>
              </div>
              <span className="menu-chevron" aria-hidden="true">
                <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M7.8 5.2L12.6 10L7.8 14.8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>

            <button
              id="mobile-settings-permissions-row"
              type="button"
              className="mobile-card-row"
              onClick={() => {
                setState({ mobileReturnToSettingsSheet: true });
                closeSettings();
                openSettingsModal("permissions");
              }}
            >
              <div>
                <div className="mobile-card-row-title">{t("settings.tabPermissions")}</div>
                <div className="mobile-card-row-sub" id="mobile-settings-permissions-sub">
                  {permSubText}
                </div>
              </div>
              <span className="menu-chevron" aria-hidden="true">
                <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M7.8 5.2L12.6 10L7.8 14.8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>

            <button
              id="mobile-settings-models-row"
              type="button"
              className="mobile-card-row"
              onClick={() => {
                setState({ mobileReturnToSettingsSheet: true });
                closeSettings();
                openSettingsModal("models");
              }}
            >
              <div>
                <div className="mobile-card-row-title">{t("settings.tabModels")}</div>
                <div className="mobile-card-row-sub">{t("mobile.modelsSub")}</div>
              </div>
              <span className="menu-chevron" aria-hidden="true">
                <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M7.8 5.2L12.6 10L7.8 14.8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>

            <div className="mobile-card-row" id="mobile-settings-language-row">
              <div>
                <div className="mobile-card-row-title">{t("lang.label")}</div>
                <div className="mobile-card-row-sub">{t("lang.desc")}</div>
              </div>
              <select
                id="mobile-settings-language-select"
                className="settings-select"
                aria-label={t("lang.label")}
                value={currentLanguage}
                style={{ width: "auto", minWidth: "110px" }}
                onChange={(e) => applyLanguagePreference(e.target.value, true)}
              >
                <option value="system">{t("lang.system")}</option>
                <option value="zh-CN">{t("lang.zhCN")}</option>
                <option value="en">{t("lang.en")}</option>
              </select>
            </div>

            <button
              id="mobile-settings-more-row"
              type="button"
              className="mobile-card-row"
              onClick={() => {
                setState({ mobileReturnToSettingsSheet: true });
                closeSettings();
                openSettingsModal("general");
              }}
            >
              <div>
                <div className="mobile-card-row-title">{t("mobile.moreSettings")}</div>
                <div className="mobile-card-row-sub">{t("mobile.moreSettingsSub")}</div>
              </div>
              <span className="menu-chevron" aria-hidden="true">
                <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M7.8 5.2L12.6 10L7.8 14.8"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>
          </div>

          <div className="mobile-grouped-card mobile-settings-about-card">
            {(() => {
              const mainBot =
                sessions.find((item: any) => item?.isAdmin) ||
                sessions.find((item: any) => item?.id === primarySessionId) ||
                sessions[0] ||
                null;
              const mainBotAvatar = resolveBotAvatar(mainBot, primarySessionId);
              const nativeVer = updateState?.localMeta?.nativeVersion || "1.0.4";
              const guidanceText = hasVisibleUpdate
                ? updateDecision?.status === "ota-available"
                  ? t("mobile.otaAvailableGuide")
                  : t("mobile.newVersionGuide")
                : t("mobile.aboutSubDefault");
              return (
                <button
                  id="mobile-settings-about-row"
                  type="button"
                  className="mobile-card-row mobile-about-hero-row"
                  onClick={() => {
                    setState({ mobileReturnToSettingsSheet: true });
                    closeSettings();
                    openSettingsModal("updates");
                  }}
                >
                  <div className="mobile-about-avatar" id="mobile-about-bot-avatar" aria-hidden="true">
                    <AvatarNode avatar={mainBotAvatar} />
                  </div>
                  <div className="mobile-about-body">
                    <div className="mobile-card-row-title mobile-about-title-row">
                      <span>{t("mobile.aboutTitle")}</span>
                      <span className="mobile-about-ver-pill">v{nativeVer}</span>
                      {hasVisibleUpdate && (
                        <span
                          className="settings-nav-update-dot"
                          aria-label={t("mobile.updateAvailableAria")}
                        />
                      )}
                    </div>
                    <div className="mobile-about-guide">{guidanceText}</div>
                    <div className="mobile-card-row-sub" id="mobile-settings-about-sub">
                      {updateState?.connectedNodeStatus?.nodeOutdated
                        ? t("mobile.aboutNodeOutdated", {
                            nodeVer: updateState.connectedNodeStatus.nodeVersion,
                            latestVer: updateState.connectedNodeStatus.latestBackendVersion,
                          })
                        : `TwinkleBot v${nativeVer} · ${
                            updateState?.localMeta?.activeWebBuild || t("mobile.aboutUpToDate")
                          }`}
                    </div>
                  </div>
                  <span className="menu-chevron" aria-hidden="true">
                    <svg className="icon-svg" viewBox="0 0 20 20" fill="none">
                      <path
                        d="M7.8 5.2L12.6 10L7.8 14.8"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </button>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ==================== MOBILE NODE SWITCHER SHEET ==================== */}
      <div
        id="mobile-node-sheet"
        className={`mobile-sheet${nodeAnim.stateClass ? ` ${nodeAnim.stateClass}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("mobile.nodeSheetAria")}
        hidden={nodeAnim.hidden}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeNode();
        }}
      >
        <div ref={nodeAnim.panelRef} className="mobile-sheet-panel">
          <div className="mobile-sheet-handle" aria-hidden="true" {...nodeAnim.handleProps} />
          <div className="mobile-sheet-header is-centered">
            <h2 className="mobile-sheet-title">{t("mobile.nodeSwitchTitle")}</h2>
          </div>

          <div className="mobile-sheet-header">
            <span className="mobile-section-caption">{t("mobile.lanSectionTitle")}</span>
            <button
              id="mobile-lan-scan-btn"
              type="button"
              className="settings-pill-btn"
              disabled={lanScanning}
              onClick={scanAndRenderLanNodes}
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
              <span>{t("mobile.lanScan")}</span>
            </button>
          </div>

          <div id="mobile-lan-list" className="mobile-grouped-card">
            {pairedLans.length === 0 && unpairedDiscovered.length === 0 ? (
              <div className="mobile-card-row">
                <span className="mobile-card-row-sub">
                  {lanScanning ? t("mobile.lanScanningEmpty") : t("mobile.lanNoneEmpty")}
                </span>
              </div>
            ) : (
              <>
                {pairedLans.map((acc: any) => {
                  const isActive = acc.id === activeAccId;
                  const accLabel = acc.name || acc.hostname || t("mobile.pairedComputerFallback");
                  return (
                    <div key={acc.id} className="mobile-card-row">
                      <button
                        type="button"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          flex: 1,
                          minWidth: 0,
                          textAlign: "left",
                          background: "transparent",
                          border: "none",
                          color: "inherit",
                          cursor: "pointer",
                          padding: 0,
                        }}
                        onClick={() => {
                          closeNode();
                          if (!isActive) switchAccount(acc.id);
                        }}
                      >
                        <div>
                          <div className="mobile-card-row-title">
                            <span className="status-dot-inline is-ok" aria-hidden="true" />
                            {accLabel}
                          </div>
                          <div className="mobile-card-row-sub">
                            {t("mobile.pairedSub", { url: acc.baseUrl })}
                          </div>
                        </div>
                        <span style={{ flexShrink: 0 }}>
                          {isActive ? (
                            <>
                              {t("common.current")}{" "}
                              <UiIcon
                                name="check"
                                className="inline-ui-icon inline-status-svg is-ok"
                                size={13}
                              />
                            </>
                          ) : (
                            <>
                              {t("common.switch")}{" "}
                              <UiIcon
                                name="chevron-right"
                                className="inline-ui-icon"
                                size={13}
                              />
                            </>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="account-remove-btn"
                        aria-label={t("sidebar.removeAccountAria", { name: accLabel })}
                        onClick={() =>
                          confirmAndRemoveCloudAccount(acc, { mobileFallback: true })
                        }
                      >
                        <UiIcon name="x" size={13} />
                      </button>
                    </div>
                  );
                })}

                {unpairedDiscovered.map((dev: any, idx: number) => (
                  <button
                    key={dev.baseUrl || idx}
                    type="button"
                    className="mobile-card-row"
                    onClick={() => initiateLanPairing(dev)}
                  >
                    <div>
                      <div className="mobile-card-row-title">
                        <UiIcon name="laptop" className="inline-ui-icon" size={14} />
                        {dev.hostname || dev.host}
                      </div>
                      <div className="mobile-card-row-sub">
                        {t("mobile.tapPairCodeSub", { url: dev.baseUrl })}
                      </div>
                    </div>
                    <span>
                      {t("mobile.pair")}{" "}
                      <UiIcon name="chevron-right" className="inline-ui-icon" size={13} />
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="mobile-manual-pair-row">
            <input
              id="mobile-lan-manual-ip-input"
              type="text"
              className="inline-text-input"
              placeholder={t("mobile.lanManualPlaceholder")}
              aria-label={t("gate.lanManualIpAria")}
              autoComplete="off"
              autoCapitalize="none"
              value={manualIp}
              onChange={(e) => setManualIp(e.target.value)}
            />
            <button
              id="mobile-lan-manual-pair-btn"
              type="button"
              className="settings-pill-btn"
              onClick={handleManualPair}
            >
              {t("mobile.manualPairBtn")}
            </button>
          </div>

          <div className="mobile-sheet-header">
            <span className="mobile-section-caption">{t("mobile.cloudSectionTitle")}</span>
            <div className="mobile-sheet-header-actions">
              {(isNativeQrScannerAvailable() || typeof window !== "undefined") && (
                <button
                  id="mobile-scan-cloud-qr-btn"
                  type="button"
                  className="settings-pill-btn"
                  disabled={qrScanning}
                  onClick={() => void handleMobileScanCloudQr()}
                >
                  {t("mobile.scanCloudQrBtn")}
                </button>
              )}
              <button
                id="mobile-add-cloud-btn"
                type="button"
                className="settings-blue-pill"
                onClick={() => {
                  setState({
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
                    (
                      document.getElementById("cloud-account-url-input") as HTMLInputElement | null
                    )?.focus();
                  });
                }}
              >
                {t("mobile.addCloudShort")}
              </button>
            </div>
          </div>

          <div id="mobile-cloud-list" className="mobile-grouped-card">
            {cloudAccounts.length === 0 ? (
              <div className="mobile-card-row">
                <span className="mobile-card-row-sub">{t("mobile.cloudEmpty")}</span>
              </div>
            ) : (
              cloudAccounts.map((acc: any) => {
                const isActive = acc.id === activeAccId;
                return (
                  <div key={acc.id} className="mobile-card-row">
                    <button
                      type="button"
                      style={{
                        flex: 1,
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                      }}
                      onClick={() => {
                        closeNode();
                        if (!isActive) switchAccount(acc.id);
                      }}
                    >
                      <div className="mobile-card-row-title">
                        <UiIcon name="cloud" className="inline-ui-icon" size={14} />
                        {acc.name || acc.baseUrl}
                      </div>
                      <div className="mobile-card-row-sub">{acc.baseUrl}</div>
                    </button>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span>
                        {isActive && (
                          <UiIcon
                            name="check"
                            className="inline-ui-icon inline-status-svg is-ok"
                            size={14}
                          />
                        )}
                      </span>
                      <button
                        type="button"
                        className="account-remove-btn"
                        aria-label={t("sidebar.removeAccountAria", {
                          name: acc.name || acc.baseUrl,
                        })}
                        onClick={() =>
                          confirmAndRemoveCloudAccount(acc, { mobileFallback: true })
                        }
                      >
                        <UiIcon name="x" size={13} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ==================== MOBILE PAIR CODE MODAL ==================== */}
      <div id="mobile-pair-modal" className="modal-backdrop" hidden={!mobilePairModalOpen || gateOpen}>
        <div
          className="compact-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("mobile.pairModalAria")}
        >
          <h3 className="compact-dialog-title">{t("mobile.pairModalTitle")}</h3>
          <p className="settings-row-sub" id="mobile-pair-target-name">
            {pendingPairingDevice
              ? t("gate.pairPromptWithHost", {
                  host: pendingPairingDevice.hostname || pendingPairingDevice.host,
                })
              : t("mobile.pairModalPromptDefault")}
          </p>
          <input
            id="mobile-pair-code-input"
            type="tel"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={6}
            className="inline-text-input"
            placeholder="000000"
            aria-label={t("gate.pairCodeInputAria")}
            value={pairCode}
            onChange={(e) => {
              const digits = String(e.target.value || "").replace(/\D+/g, "").slice(0, 6);
              setPairCode(digits);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitLanPairingCode(pairCode);
              }
            }}
          />
          <div
            id="mobile-pair-feedback"
            className={`mail-feedback-box${
              mobilePairFeedback.kind === "error" ? " is-error" : ""
            }`}
            role="status"
            aria-live="polite"
            hidden={!mobilePairFeedback.text}
          >
            <StatusText text={mobilePairFeedback.text} />
          </div>
          <div className="inline-form-actions">
            <button
              id="mobile-pair-cancel-btn"
              type="button"
              className="settings-pill-btn"
              onClick={() => setState({ mobilePairModalOpen: false })}
            >
              {t("common.cancel")}
            </button>
            <button
              id="mobile-pair-submit-btn"
              type="button"
              className="settings-blue-pill"
              onClick={() => submitLanPairingCode(pairCode)}
            >
              {t("mobile.pairVerify")}
            </button>
          </div>
        </div>
      </div>

      {/* ==================== MOBILE LAN OFFLINE MODAL ==================== */}
      <div
        id="mobile-lan-offline-modal"
        className="modal-backdrop"
        hidden={!lanOfflineModalShown}
        onClick={(e) => {
          if (e.target === e.currentTarget && !lanRetrying) {
            dismissLanOfflineModal();
          }
        }}
      >
        <div
          className="compact-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("mobile.lanOfflineAria")}
        >
          <div className="compact-dialog-header">
            <h3 className="compact-dialog-title">{t("mobile.lanOfflineTitle")}</h3>
            <button
              id="mobile-lan-offline-close-btn"
              type="button"
              className="modal-close-btn"
              aria-label={t("common.close")}
              disabled={lanRetrying}
              onClick={() => dismissLanOfflineModal()}
            >
              ×
            </button>
          </div>
          <p className="settings-row-sub">
            {t("mobile.lanOfflineDesc")}
          </p>
          <div className="inline-form-actions">
            <button
              id="mobile-lan-retry-btn"
              type="button"
              className="settings-pill-btn"
              disabled={lanRetrying}
              onClick={async () => {
                if (lanRetrying) return;
                setLanRetrying(true);
                try {
                  await retryActiveLanConnection(accountEpoch);
                } finally {
                  setLanRetrying(false);
                }
              }}
            >
              {lanRetrying ? t("mobile.lanRetrying") : t("mobile.lanRetryHere")}
            </button>
            <button
              id="mobile-lan-switch-cloud-btn"
              type="button"
              className="settings-blue-pill"
              disabled={lanRetrying}
              onClick={() => {
                dismissLanOfflineModal();
                if (cloudAccounts.length === 1) {
                  switchAccount(cloudAccounts[0].id);
                } else {
                  setState((prev) => ({
                    mobileSheets: { ...prev.mobileSheets, nodeOpen: true },
                  }));
                }
              }}
            >
              {t("mobile.lanSwitchCloud")}
            </button>
          </div>
        </div>
      </div>

      {/* ==================== MOBILE BOT EDITOR SHEET ==================== */}
      <div
        id="mobile-bot-editor-sheet"
        className={`mobile-sheet is-fullscreen${botEditorAnim.stateClass ? ` ${botEditorAnim.stateClass}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("mobile.botEditorAria")}
        hidden={botEditorAnim.hidden}
      >
        <div
          ref={botEditorAnim.panelRef}
          className="mobile-sheet-panel"
          {...botEditorAnim.handleProps}
        >
          <div className="mobile-sheet-header">
            <button
              id="mobile-bot-editor-close-btn"
              type="button"
              className="mobile-circle-btn"
              title={t("common.back")}
              aria-label={t("common.back")}
              onClick={closeBotEditor}
            >
              <UiIcon name="chevron-left" />
            </button>
            <h2 className="mobile-sheet-title" id="mobile-bot-editor-title">
              {isEditBot ? t("mobile.botEditTitle") : t("mobile.botCreateTitle")}
            </h2>
            <button
              id="mobile-bot-done-btn"
              type="button"
              className="settings-pill-btn"
              hidden={!isEditBot}
              onClick={handleSaveMobileBot}
            >
              {t("common.done")}
            </button>
          </div>

          <div className="mobile-bot-preview-wrap">
            <div id="mobile-bot-preview-slot" className="mobile-bot-preview-slot">
              <MascotSvg
                shapeKey={mobileBotEditor.shape}
                colorKey={mobileBotEditor.color}
              />
            </div>
          </div>

          <input
            id="mobile-bot-name-input"
            type="text"
            className="mobile-bot-name-pill"
            maxLength={40}
            placeholder={t("mobile.botNamePlaceholder")}
            aria-label={t("inspector.botNameAria")}
            value={mobileBotEditor.name}
            onChange={(e) =>
              setState((prev) => ({
                mobileBotEditor: { ...prev.mobileBotEditor, name: e.target.value },
              }))
            }
          />

          <input
            id="mobile-bot-role-input"
            type="text"
            className="inline-text-input"
            placeholder={t("mobile.botRolePlaceholder")}
            aria-label={t("mobile.botRoleAria")}
            value={mobileBotEditor.rolePrompt}
            onChange={(e) =>
              setState((prev) => ({
                mobileBotEditor: { ...prev.mobileBotEditor, rolePrompt: e.target.value },
              }))
            }
          />

          <div
            id="mobile-bot-shapes-grid"
            className="mobile-shapes-grid"
            role="group"
            aria-label={t("mobile.botShapeAria")}
          >
            {BOT_SHAPES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`mobile-shape-btn${s.key === mobileBotEditor.shape ? " is-active" : ""}`}
                aria-label={getBotShapeLabel(s.key, locale)}
                onClick={() =>
                  setState((prev) => ({
                    mobileBotEditor: { ...prev.mobileBotEditor, shape: s.key },
                  }))
                }
              >
                <MascotSvg shapeKey={s.key} colorKey={mobileBotEditor.color} />
              </button>
            ))}
          </div>

          <div
            id="mobile-bot-colors-grid"
            className="mobile-colors-grid"
            role="group"
            aria-label={t("mobile.botColorAria")}
          >
            {BOT_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`mobile-color-dot${c.key === mobileBotEditor.color ? " is-active" : ""}`}
                style={{ background: c.swatch }}
                aria-label={getBotColorLabel(c.key, locale)}
                onClick={() =>
                  setState((prev) => ({
                    mobileBotEditor: { ...prev.mobileBotEditor, color: c.key },
                  }))
                }
              />
            ))}
          </div>

          <button
            id="mobile-bot-save-btn"
            type="button"
            className="mobile-primary-cta"
            onClick={handleSaveMobileBot}
          >
            {isEditBot ? t("mobile.saveChanges") : t("mobile.createBtn")}
          </button>
        </div>
      </div>
    </>
  );
}
