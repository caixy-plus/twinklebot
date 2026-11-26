import { useEffect, useRef, useState } from "react";
import { parseRelayInvite } from "/accounts-store.js";
import {
  isNativeQrScannerAvailable,
  scanQrCodeNative,
} from "../../mobile-bridge.js";
import { isMobileViewport } from "../../mobile-ui.js";
import {
  importRemoteAccountFromInput,
  initiateLanPairing,
  refreshActiveAccountConnection,
  scanAndRenderLanNodes,
  showToast,
  submitLanPairingCode,
  switchAccountFromGate,
} from "../../services/actions.js";
import {
  getActiveAccountMeta,
  isMobileAccountEnvironment,
  shouldShowAccountDisconnectedGate,
} from "../../services/network-monitor.js";
import { getState, setState, useStore } from "../../state/store.js";
import { useI18n, resolveLocalizedAccountName } from "../../services/i18n.js";
import { UiIcon } from "./Icon.js";

type GateSubPanel = "none" | "add-cloud" | "lan-pair";

export function AccountDisconnectedGate() {
  const isMobileClient = useStore((s) => s.isMobileClient);
  const accountsState = useStore((s) => s.accountsState);
  const networkHealth = useStore((s) => s.networkHealth);
  const lanNodeOffline = useStore((s) => s.lanNodeOffline);
  const updateState = useStore((s) => s.updateState);
  const accountEpoch = useStore((s) => s.accountEpoch);
  const lanScanning = useStore((s) => s.lanScanning);
  const lanDiscoveredDevices = useStore((s) => s.lanDiscoveredDevices);
  const mobilePairModalOpen = useStore((s) => s.mobilePairModalOpen);
  const pendingPairingDevice = useStore((s) => s.pendingPairingDevice);
  const mobilePairFeedback = useStore((s) => s.mobilePairFeedback);
  const { locale, t } = useI18n();

  const gateSnapshot = {
    isMobileClient,
    accountsState,
    networkHealth,
    lanNodeOffline,
    updateState,
  } as any;
  const isOpen = shouldShowAccountDisconnectedGate(gateSnapshot);
  const isMobileEnv = isMobileAccountEnvironment(gateSnapshot);
  const accMeta = getActiveAccountMeta(gateSnapshot);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const refreshBtnRef = useRef<HTMLButtonElement | null>(null);
  const addCloudBtnRef = useRef<HTMLButtonElement | null>(null);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const [refreshing, setRefreshing] = useState(false);
  const [switchingAccountId, setSwitchingAccountId] = useState<string | null>(null);
  const [qrScanning, setQrScanning] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; kind: "info" | "error" }>({
    text: "",
    kind: "info",
  });
  const [subPanel, setSubPanel] = useState<GateSubPanel>("none");
  const [cloudUrl, setCloudUrl] = useState("");
  const [cloudName, setCloudName] = useState("");
  const [cloudToken, setCloudToken] = useState("");
  const [cloudSaving, setCloudSaving] = useState(false);
  const [manualLanIp, setManualLanIp] = useState("");
  const [pairCode, setPairCode] = useState("");

  const rawAccounts = Array.isArray(accountsState?.accounts) ? accountsState.accounts : [];
  const accounts = isMobileEnv
    ? rawAccounts.filter((a: any) => a && a.type !== "local")
    : rawAccounts;
  const activeAccountId = accountsState?.activeAccountId || "";
  const activeAccount = accounts.find((a: any) => a.id === activeAccountId) || null;
  const otherAccounts = activeAccount
    ? accounts.filter((a: any) => a.id !== activeAccount.id)
    : accounts;
  const isSetupMode = isMobileEnv && !activeAccount;
  const showMobileLanTools = isMobileViewport() || isMobileEnv;
  const showScanQrBtn =
    showMobileLanTools && (isNativeQrScannerAvailable() || typeof window !== "undefined");

  // Collapse any underlying mobile sheets/popovers/modals whenever the blocking gate activates
  useEffect(() => {
    if (!isOpen) return;
    setState((prev) => {
      const hasUnderlyingOverlay =
        prev.mobileSheets.inspectorOpen ||
        prev.mobileSheets.settingsOpen ||
        prev.mobileSheets.nodeOpen ||
        prev.mobileSheets.botEditorOpen ||
        prev.settingsModal.open ||
        prev.appsModalOpen ||
        prev.searchModalOpen ||
        prev.openPopover !== null ||
        prev.lanOfflineModalShown;
      if (!hasUnderlyingOverlay) return prev;
      return {
        openPopover: null,
        searchModalOpen: false,
        appsModalOpen: false,
        lanOfflineModalShown: false,
        settingsModal: { ...prev.settingsModal, open: false },
        mobileSheets: {
          ...prev.mobileSheets,
          inspectorOpen: false,
          settingsOpen: false,
          nodeOpen: false,
          botEditorOpen: false,
        },
      };
    });
  }, [isOpen]);

  // Auto-open LAN pairing sub-panel when entering setup mode online on mobile
  useEffect(() => {
    if (isOpen && isSetupMode && showMobileLanTools && !networkHealth.browserOffline) {
      setSubPanel((prev) => (prev === "none" ? "lan-pair" : prev));
      void scanAndRenderLanNodes();
    }
  }, [isOpen, isSetupMode, showMobileLanTools, networkHealth.browserOffline]);

  // Reset transient feedback/sub-panels when gate closes or active account changes
  useEffect(() => {
    if (!isOpen) {
      setRefreshing(false);
      setSwitchingAccountId(null);
      setQrScanning(false);
      setFeedback({ text: "", kind: "info" });
      setSubPanel("none");
      setPairCode("");
    }
  }, [isOpen, activeAccountId]);

  // Synchronize native top-layer <dialog> modal state strictly via showModal() / close()
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.returnValue = "";
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          try {
            dialog.showModal();
          } catch {
            // ignore if already open or detached
          }
        }
      }
      queueMicrotask(() => {
        if (isOpenRef.current && dialogRef.current?.open) {
          (refreshBtnRef.current || addCloudBtnRef.current)?.focus();
        }
      });
    } else if (dialog.open) {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute("open");
      }
    }
  }, [isOpen]);

  // Auto-open inline LAN panel if user initiated pairing while gate is active
  useEffect(() => {
    if (isOpen && mobilePairModalOpen && pendingPairingDevice) {
      setSubPanel("lan-pair");
      setPairCode("");
    }
  }, [isOpen, mobilePairModalOpen, pendingPairingDevice]);

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    if (isOpenRef.current) {
      e.preventDefault();
    }
  };

  const handleClose = () => {
    const dialog = dialogRef.current;
    if (dialog) dialog.returnValue = "";
    // Guard against browsers that bypass `cancel` on repeated Esc presses
    if (isOpenRef.current && dialog && !dialog.open) {
      queueMicrotask(() => {
        if (isOpenRef.current && dialogRef.current && !dialogRef.current.open) {
          try {
            dialogRef.current.showModal();
          } catch {}
        }
      });
    }
  };

  const handleRefreshAccount = async () => {
    if (refreshing || switchingAccountId || !activeAccount) return;
    setRefreshing(true);
    setFeedback({ text: t("gate.refreshingAccountToast", { label: accMeta.label }), kind: "info" });
    try {
      const res = await refreshActiveAccountConnection(accountEpoch);
      if (!res.ok && isOpenRef.current) {
        const latestHealth = getState().networkHealth;
        const isAuthErr =
          !latestHealth?.browserOffline && latestHealth?.reason === "auth_failed";
        setFeedback({
          text: latestHealth?.browserOffline
            ? t("gate.stillOfflineError")
            : isAuthErr
              ? t("gate.authFailedError", { name: accMeta.label })
              : t("gate.stillUnreachableError", { label: accMeta.label }),
          kind: "error",
        });
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleSwitchAccount = async (targetId: string) => {
    if (!targetId || targetId === activeAccountId || switchingAccountId || refreshing) return;
    const targetAcc = accounts.find((a: any) => a.id === targetId);
    const targetName =
      targetAcc?.name || targetAcc?.hostname || targetAcc?.baseUrl || t("gate.targetAccountFallback");
    setSwitchingAccountId(targetId);
    setFeedback({
      text: t("gate.switchingAccountStatus", { name: targetName }),
      kind: "info",
    });
    try {
      const res = await switchAccountFromGate(targetId);
      if (!res.ok && isOpenRef.current) {
        setFeedback({
          text: res.error || t("gate.stillUnreachableError", { label: targetName }),
          kind: "error",
        });
      }
    } finally {
      setSwitchingAccountId(null);
    }
  };

  const handleAddCloudSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cloudSaving) return;
    setCloudSaving(true);
    setFeedback({ text: "", kind: "info" });
    try {
      await importRemoteAccountFromInput({
        rawUrlOrInvite: cloudUrl.trim(),
        name: cloudName.trim(),
        authToken: cloudToken.trim(),
        switchAfter: true,
        requireReachable: true,
      });
      setCloudUrl("");
      setCloudName("");
      setCloudToken("");
      setSubPanel("none");
    } catch (err: any) {
      setFeedback({
        text: err?.message || t("gate.invalidCloudUrlError"),
        kind: "error",
      });
    } finally {
      setCloudSaving(false);
    }
  };

  const handleGateScanCloudQr = async () => {
    if (qrScanning || refreshing || switchingAccountId) return;
    setQrScanning(true);
    setFeedback({ text: "", kind: "info" });
    try {
      const scanRes = await scanQrCodeNative(t("mobile.qrScanPrompt"));
      if (scanRes.unsupported) {
        showToast(t("mobile.qrUnsupportedToast"));
        setSubPanel("add-cloud");
        return;
      }
      if (scanRes.permissionDenied) {
        setFeedback({ text: t("mobile.qrPermissionDeniedToast"), kind: "error" });
        return;
      }
      if (scanRes.cancelled || !scanRes.ok || !scanRes.content) {
        return;
      }
      const imported = await importRemoteAccountFromInput({
        rawUrlOrInvite: scanRes.content,
        switchAfter: true,
        requireReachable: true,
      });
      showToast(
        t("mobile.cloudQrAddedToast", {
          name: imported.account?.name || imported.account?.baseUrl || "",
        })
      );
    } catch (err: any) {
      setFeedback({
        text: t("mobile.qrInvalidToast", { error: err?.message || t("actions.requestError") }),
        kind: "error",
      });
    } finally {
      setQrScanning(false);
    }
  };

  const handleManualLanPair = async () => {
    const raw = manualLanIp.trim();
    if (!raw) {
      setFeedback({ text: t("gate.enterLanIpError"), kind: "error" });
      return;
    }
    const clean = /^https?:\/\//i.test(raw)
      ? raw.replace(/\/+$/, "")
      : `http://${raw.includes(":") ? raw : `${raw}:3230`}`;
    setFeedback({ text: t("gate.pairingRequestStatus", { url: clean }), kind: "info" });
    await initiateLanPairing({ baseUrl: clean, host: raw, hostname: raw });
  };

  const pairedLanUrls = new Set(
    accounts
      .filter((a: any) => a.type === "lan")
      .map((a: any) => String(a.baseUrl || "").replace(/\/+$/, ""))
  );
  const unpairedDiscovered = (lanDiscoveredDevices || []).filter(
    (d: any) => !pairedLanUrls.has(String(d?.baseUrl || "").replace(/\/+$/, ""))
  );

  const isAuthFailed =
    !isSetupMode && !networkHealth.browserOffline && networkHealth.reason === "auth_failed";

  const titleText = networkHealth.browserOffline
    ? t("gate.titleOffline")
    : isSetupMode
      ? t("gate.titleSetup")
      : isAuthFailed
        ? t("gate.titleAuthFailed")
        : t("gate.titleLost");
  const descText = networkHealth.browserOffline
    ? isSetupMode
      ? t("gate.descSetup")
      : t("gate.descOffline", { label: accMeta.label })
    : isSetupMode
      ? t("gate.descSetup")
      : isAuthFailed
        ? t("gate.descAuthFailed", { label: accMeta.label })
        : t("gate.descLost", { label: accMeta.label });

  return (
    <dialog
      ref={dialogRef}
      id="account-disconnected-gate"
      className="account-disconnected-gate"
      {...({ closedby: "none" } as any)}
      aria-labelledby="account-gate-title"
      aria-describedby="account-gate-desc"
      data-account-gate-open={isOpen ? "true" : "false"}
      data-account-gate-mode={isSetupMode ? "setup" : isAuthFailed ? "auth-failed" : "disconnected"}
      data-account-type={accMeta.type}
      data-browser-offline={networkHealth.browserOffline ? "true" : "false"}
      onCancel={handleCancel}
      onClose={handleClose}
    >
      <div className="account-gate-card">
        <div className="account-gate-header">
          <div className="account-gate-emblem" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M3 3l18 18M9.5 5.4A6.2 6.2 0 0 1 17.8 10a4.1 4.1 0 0 1 2.2 7.2M6.5 8.8A4.6 4.6 0 0 0 6.8 18h9.4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h2 id="account-gate-title" className="account-gate-title">
            {titleText}
          </h2>
          <p id="account-gate-desc" className="account-gate-desc">
            {descText}
          </p>
        </div>

        {!isSetupMode && activeAccount && (
          <>
            <div className="account-gate-current-card" data-current-account-id={activeAccountId}>
              <div className="account-gate-current-meta">
                <div className="account-gate-current-name">
                  <UiIcon
                    name={accMeta.type === "cloud" ? "cloud" : "laptop"}
                    className="inline-ui-icon"
                    size={15}
                  />
                  <span>{accMeta.label}</span>
                </div>
                <div className="account-gate-current-sub">
                  {activeAccount?.baseUrl ||
                    activeAccount?.relayUrl ||
                    (accMeta.type === "lan"
                      ? t("gate.lanWorkspaceLabel")
                      : t("gate.cloudWorkspaceLabel"))}
                </div>
              </div>
              <span className="account-gate-status-badge">
                <span className="account-gate-status-dot" aria-hidden="true" />
                {refreshing
                  ? t("gate.statusRefreshing")
                  : isAuthFailed
                    ? t("gate.statusAuthFailed")
                    : t("gate.statusDisconnected")}
              </span>
            </div>

            <button
              ref={refreshBtnRef}
              id="account-gate-refresh-btn"
              type="button"
              className="account-gate-primary-btn"
              data-account-gate-action="refresh"
              disabled={refreshing || Boolean(switchingAccountId)}
              onClick={handleRefreshAccount}
            >
              <svg
                className={`account-gate-btn-icon${refreshing ? " is-spinning" : ""}`}
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M15.8 10a5.8 5.8 0 1 1-1.7-4.1M15.8 4.4v3.4h-3.4"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{refreshing ? t("gate.refreshingBtn") : t("gate.refreshBtn")}</span>
            </button>
          </>
        )}

        {feedback.text && (
          <div
            id="account-gate-feedback"
            className={`account-gate-feedback${feedback.kind === "error" ? " is-error" : ""}`}
            role="status"
            aria-live="polite"
          >
            {feedback.text}
          </div>
        )}

        <div className="account-gate-section">
          <div className="account-gate-section-head">
            <span className="account-gate-section-title">{t("gate.switchSection")}</span>
            <span className="account-gate-section-count">
              {otherAccounts.length > 0
                ? t("gate.otherCount", { count: otherAccounts.length })
                : t("gate.noOtherAccounts")}
            </span>
          </div>

          <div
            id="account-gate-account-list"
            className="account-gate-list"
            role="group"
            aria-label={t("gate.switchListAria")}
          >
            {otherAccounts.length === 0 ? (
              <div className="account-gate-empty-hint">
                {isSetupMode
                  ? t("gate.setupEmptyHint")
                  : t("gate.onlyOneAccountHint", {
                      lanHint: showMobileLanTools ? t("gate.orPairLanHint") : "",
                    })}
              </div>
            ) : (
              otherAccounts.map((acc: any) => {
                const isSwitching = switchingAccountId === acc.id;
                const isLocal = acc.type === "local";
                const subLabel = isLocal
                  ? t("gate.localAlwaysAvailable")
                  : acc.baseUrl ||
                    acc.relayUrl ||
                    (acc.type === "lan"
                      ? t("gate.lanWorkspaceLabel")
                      : t("sidebar.cloudServiceFallback"));
                const accDisplayName = resolveLocalizedAccountName(
                  acc,
                  locale,
                  acc.hostname || acc.baseUrl || acc.id
                );
                return (
                  <button
                    key={acc.id}
                    type="button"
                    className="account-gate-account-item"
                    data-account-gate-switch-id={acc.id}
                    disabled={refreshing || Boolean(switchingAccountId)}
                    onClick={() => handleSwitchAccount(acc.id)}
                  >
                    <span className="account-gate-item-leading">
                      <span
                        className={`account-gate-item-icon${isLocal ? " is-local" : ""}`}
                        aria-hidden="true"
                      >
                        <UiIcon
                          name={acc.type === "cloud" ? "cloud" : "laptop"}
                          size={15}
                        />
                      </span>
                      <span className="account-gate-item-meta">
                        <span className="account-gate-item-name">{accDisplayName}</span>
                        <span className="account-gate-item-sub">{subLabel}</span>
                      </span>
                    </span>
                    <span className="account-gate-item-trailing">
                      {isSwitching ? t("common.switching") : t("common.switch")}
                      {!isSwitching && (
                        <UiIcon name="chevron-right" className="inline-ui-icon" size={13} />
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="account-gate-secondary-actions">
            <button
              ref={addCloudBtnRef}
              id="account-gate-add-cloud-btn"
              type="button"
              className={`account-gate-secondary-btn${subPanel === "add-cloud" ? " is-active" : ""}`}
              disabled={refreshing || Boolean(switchingAccountId)}
              onClick={() => {
                setFeedback({ text: "", kind: "info" });
                setSubPanel((prev) => (prev === "add-cloud" ? "none" : "add-cloud"));
              }}
            >
              {t("gate.addCloudBtn")}
            </button>
            {showScanQrBtn && (
              <button
                id="account-gate-scan-qr-btn"
                type="button"
                className="account-gate-secondary-btn"
                disabled={refreshing || Boolean(switchingAccountId) || qrScanning}
                onClick={() => void handleGateScanCloudQr()}
              >
                {qrScanning ? t("gate.connecting") : t("gate.scanQrBtn")}
              </button>
            )}
            {showMobileLanTools && (
              <button
                id="account-gate-lan-btn"
                type="button"
                className={`account-gate-secondary-btn${subPanel === "lan-pair" ? " is-active" : ""}`}
                disabled={refreshing || Boolean(switchingAccountId)}
                onClick={() => {
                  setFeedback({ text: "", kind: "info" });
                  setSubPanel((prev) => {
                    const next = prev === "lan-pair" ? "none" : "lan-pair";
                    if (next === "lan-pair") {
                      void scanAndRenderLanNodes();
                    }
                    return next;
                  });
                }}
              >
                {t("gate.pairLanBtn")}
              </button>
            )}
          </div>

          {subPanel === "add-cloud" && (
            <form
              id="account-gate-add-cloud-form"
              className="account-gate-inline-panel"
              onSubmit={handleAddCloudSubmit}
            >
              <label className="account-gate-field">
                <span>{t("gate.cloudUrlLabel")}</span>
                <input
                  id="account-gate-cloud-url"
                  type="text"
                  inputMode="url"
                  className="inline-text-input"
                  placeholder="https://bot.example.com / twinklebot://relay?..."
                  autoComplete="url"
                  autoCapitalize="none"
                  required
                  value={cloudUrl}
                  onChange={(e) => {
                    const rawVal = e.target.value;
                    setCloudUrl(rawVal);
                    if (rawVal.trim().startsWith("twinklebot://")) {
                      const parsed = parseRelayInvite(rawVal);
                      if (parsed) {
                        if (!cloudName && (parsed.name || parsed.hostname)) {
                          setCloudName(parsed.name || parsed.hostname || "");
                        }
                        if (!cloudToken && parsed.relayToken) {
                          setCloudToken(parsed.relayToken);
                        }
                      }
                    }
                  }}
                />
              </label>
              <label className="account-gate-field">
                <span>{t("gate.cloudNameLabel")}</span>
                <input
                  id="account-gate-cloud-name"
                  type="text"
                  className="inline-text-input"
                  placeholder={t("gate.cloudNamePlaceholder")}
                  value={cloudName}
                  onChange={(e) => setCloudName(e.target.value)}
                />
              </label>
              <label className="account-gate-field">
                <span>{t("gate.cloudTokenLabel")}</span>
                <input
                  id="account-gate-cloud-token"
                  type="password"
                  className="inline-text-input"
                  placeholder={t("gate.cloudTokenPlaceholder")}
                  autoComplete="off"
                  value={cloudToken}
                  onChange={(e) => setCloudToken(e.target.value)}
                />
              </label>
              <div className="account-gate-inline-actions">
                <button
                  type="button"
                  className="settings-pill-btn"
                  onClick={() => setSubPanel("none")}
                >
                  {t("common.cancel")}
                </button>
                <button
                  id="account-gate-cloud-submit-btn"
                  type="submit"
                  className="settings-blue-pill"
                  disabled={cloudSaving || !cloudUrl.trim()}
                >
                  {cloudSaving ? t("gate.connecting") : t("gate.connectAndSwitch")}
                </button>
              </div>
            </form>
          )}

          {showMobileLanTools && subPanel === "lan-pair" && (
            <div id="account-gate-lan-panel" className="account-gate-inline-panel">
              {mobilePairModalOpen && pendingPairingDevice ? (
                <div className="account-gate-pair-verify">
                  <div className="account-gate-inline-hint">
                    {t("gate.pairPromptWithHost", {
                      host: pendingPairingDevice.hostname || pendingPairingDevice.host,
                    })}
                  </div>
                  <input
                    id="account-gate-pair-code"
                    type="tel"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    maxLength={6}
                    className="inline-text-input"
                    placeholder="000000"
                    aria-label={t("gate.pairCodeInputAria")}
                    value={pairCode}
                    onChange={(e) =>
                      setPairCode(String(e.target.value || "").replace(/\D+/g, "").slice(0, 6))
                    }
                  />
                  {mobilePairFeedback.text && (
                    <div
                      className={`account-gate-feedback${
                        mobilePairFeedback.kind === "error" ? " is-error" : ""
                      }`}
                    >
                      {mobilePairFeedback.text}
                    </div>
                  )}
                  <div className="account-gate-inline-actions">
                    <button
                      type="button"
                      className="settings-pill-btn"
                      onClick={() => setState({ mobilePairModalOpen: false })}
                    >
                      {t("mobile.pairCancel")}
                    </button>
                    <button
                      id="account-gate-pair-submit-btn"
                      type="button"
                      className="settings-blue-pill"
                      onClick={() => submitLanPairingCode(pairCode)}
                    >
                      {t("mobile.pairVerify")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="account-gate-lan-head">
                    <span className="account-gate-inline-hint">
                      {lanScanning
                        ? t("gate.lanScanningHint")
                        : unpairedDiscovered.length > 0
                          ? t("gate.lanFoundCount", { count: unpairedDiscovered.length })
                          : t("gate.lanNoneFoundHint")}
                    </span>
                    <button
                      type="button"
                      className="settings-pill-btn"
                      disabled={lanScanning}
                      onClick={() => void scanAndRenderLanNodes()}
                    >
                      {lanScanning ? t("mobile.lanScanning") : t("gate.lanRescanBtn")}
                    </button>
                  </div>
                  {unpairedDiscovered.length > 0 && (
                    <div className="account-gate-list">
                      {unpairedDiscovered.map((dev: any, idx: number) => (
                        <button
                          key={dev.baseUrl || idx}
                          type="button"
                          className="account-gate-account-item"
                          onClick={() => initiateLanPairing(dev)}
                        >
                          <span className="account-gate-item-leading">
                            <span className="account-gate-item-icon" aria-hidden="true">
                              <UiIcon name="laptop" size={14} />
                            </span>
                            <span className="account-gate-item-meta">
                              <span className="account-gate-item-name">
                                {dev.hostname || dev.host}
                              </span>
                              <span className="account-gate-item-sub">{dev.baseUrl}</span>
                            </span>
                          </span>
                          <span className="account-gate-item-trailing">{t("mobile.pair")}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="account-gate-manual-row">
                    <input
                      id="account-gate-lan-ip"
                      type="text"
                      className="inline-text-input"
                      placeholder="192.168.1.10:3230"
                      aria-label={t("gate.lanManualIpAria")}
                      autoComplete="off"
                      autoCapitalize="none"
                      value={manualLanIp}
                      onChange={(e) => setManualLanIp(e.target.value)}
                    />
                    <button
                      id="account-gate-lan-pair-btn"
                      type="button"
                      className="settings-blue-pill"
                      onClick={handleManualLanPair}
                    >
                      {t("mobile.pair")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
