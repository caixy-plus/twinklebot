import { useEffect, useRef, useState } from "react";
import { upsertCloudAccount } from "/accounts-store.js";
import { isMobileAppTarget } from "../../mobile-bridge.js";
import { isMobileViewport } from "../../mobile-ui.js";
import {
  initiateLanPairing,
  refreshActiveAccountConnection,
  saveAccountsDirectory,
  scanAndRenderLanNodes,
  submitLanPairingCode,
  switchAccount,
} from "../../services/actions.js";
import {
  getActiveAccountMeta,
  shouldShowAccountDisconnectedGate,
} from "../../services/network-monitor.js";
import { getState, setState, useStore } from "../../state/store.js";
import { UiIcon } from "./Icon.js";

type GateSubPanel = "none" | "add-cloud" | "lan-pair";

export function AccountDisconnectedGate() {
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

  const gateSnapshot = {
    accountsState,
    networkHealth,
    lanNodeOffline,
    updateState,
  } as any;
  const isOpen = shouldShowAccountDisconnectedGate(gateSnapshot);
  const accMeta = getActiveAccountMeta(gateSnapshot);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const refreshBtnRef = useRef<HTMLButtonElement | null>(null);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const [refreshing, setRefreshing] = useState(false);
  const [switchingAccountId, setSwitchingAccountId] = useState<string | null>(null);
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

  const accounts = Array.isArray(accountsState?.accounts) ? accountsState.accounts : [];
  const activeAccountId = accountsState?.activeAccountId || "";
  const activeAccount = accounts.find((a: any) => a.id === activeAccountId) || null;
  const otherAccounts = accounts.filter((a: any) => a.id !== activeAccountId);
  const showMobileLanTools = isMobileViewport() || isMobileAppTarget();

  // Reset transient feedback/sub-panels when gate closes or active account changes
  useEffect(() => {
    if (!isOpen) {
      setRefreshing(false);
      setSwitchingAccountId(null);
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
          refreshBtnRef.current?.focus();
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
    if (refreshing || switchingAccountId) return;
    setRefreshing(true);
    setFeedback({ text: `正在刷新「${accMeta.label}」连接…`, kind: "info" });
    try {
      const res = await refreshActiveAccountConnection(accountEpoch);
      if (!res.ok && isOpenRef.current) {
        setFeedback({
          text: networkHealth.browserOffline
            ? "当前设备仍无网络连接，请检查网络设置后重试"
            : `仍无法连接至「${accMeta.label}」，请检查服务端状态或切换其他账号`,
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
    setSwitchingAccountId(targetId);
    setFeedback({
      text: `正在切换至「${targetAcc?.name || targetAcc?.baseUrl || "目标账号"}」…`,
      kind: "info",
    });
    try {
      await switchAccount(targetId);
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
      const next = upsertCloudAccount(getState().accountsState, {
        id: "",
        baseUrl: cloudUrl.trim(),
        name: cloudName.trim(),
        authToken: cloudToken.trim(),
      });
      const added = next.accounts[next.accounts.length - 1];
      await saveAccountsDirectory(next);
      setCloudUrl("");
      setCloudName("");
      setCloudToken("");
      setSubPanel("none");
      await switchAccount(added.id);
    } catch (err: any) {
      setFeedback({
        text: err?.message || "云端地址格式无效，请输入 http(s):// 地址",
        kind: "error",
      });
    } finally {
      setCloudSaving(false);
    }
  };

  const handleManualLanPair = async () => {
    const raw = manualLanIp.trim();
    if (!raw) {
      setFeedback({ text: "请输入局域网电脑 IP 地址（例如 192.168.1.10:3230）", kind: "error" });
      return;
    }
    const clean = /^https?:\/\//i.test(raw)
      ? raw.replace(/\/+$/, "")
      : `http://${raw.includes(":") ? raw : `${raw}:3230`}`;
    setFeedback({ text: `正在向 ${clean} 发起配对请求…`, kind: "info" });
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

  const titleText = networkHealth.browserOffline
    ? "当前无网络连接"
    : "账号已失去连接";
  const descText = networkHealth.browserOffline
    ? `当前设备处于离线状态，无法访问「${accMeta.label}」。恢复网络后可刷新当前账号，或直接切换至其他可用账号。`
    : `无法连接至「${accMeta.label}」。在连接恢复前，当前工作台已暂停交互；你可以刷新当前账号或切换至其他账号。`;

  return (
    <dialog
      ref={dialogRef}
      id="account-disconnected-gate"
      className="account-disconnected-gate"
      {...({ closedby: "none" } as any)}
      aria-labelledby="account-gate-title"
      aria-describedby="account-gate-desc"
      data-account-gate-open={isOpen ? "true" : "false"}
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
              {activeAccount?.baseUrl || (accMeta.type === "lan" ? "局域网电脑" : "云端工作台")}
            </div>
          </div>
          <span className="account-gate-status-badge">
            <span className="account-gate-status-dot" aria-hidden="true" />
            {refreshing ? "刷新中" : "已断开"}
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
          <span>{refreshing ? "正在刷新连接…" : "刷新当前账号"}</span>
        </button>

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
            <span className="account-gate-section-title">切换账号</span>
            <span className="account-gate-section-count">
              {otherAccounts.length > 0 ? `${otherAccounts.length} 个可切换` : "暂无其他账号"}
            </span>
          </div>

          <div
            id="account-gate-account-list"
            className="account-gate-list"
            role="group"
            aria-label="可切换的账号列表"
          >
            {otherAccounts.length === 0 ? (
              <div className="account-gate-empty-hint">
                当前仅保存了这一个账号。你可以点击下方添加新的云端账号
                {showMobileLanTools ? "或配对局域网电脑" : ""}。
              </div>
            ) : (
              otherAccounts.map((acc: any) => {
                const isSwitching = switchingAccountId === acc.id;
                const isLocal = acc.type === "local";
                const subLabel = isLocal
                  ? "本地工作台 · 始终可用"
                  : acc.baseUrl || (acc.type === "lan" ? "局域网电脑" : "云端服务");
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
                        <span className="account-gate-item-name">
                          {acc.name || acc.hostname || acc.baseUrl || acc.id}
                        </span>
                        <span className="account-gate-item-sub">{subLabel}</span>
                      </span>
                    </span>
                    <span className="account-gate-item-trailing">
                      {isSwitching ? "切换中…" : "切换"}
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
              id="account-gate-add-cloud-btn"
              type="button"
              className={`account-gate-secondary-btn${subPanel === "add-cloud" ? " is-active" : ""}`}
              disabled={refreshing || Boolean(switchingAccountId)}
              onClick={() => {
                setFeedback({ text: "", kind: "info" });
                setSubPanel((prev) => (prev === "add-cloud" ? "none" : "add-cloud"));
              }}
            >
              + 添加云端账号
            </button>
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
                配对局域网电脑
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
                <span>云端服务地址</span>
                <input
                  id="account-gate-cloud-url"
                  type="url"
                  className="inline-text-input"
                  placeholder="https://bot.example.com"
                  autoComplete="url"
                  autoCapitalize="none"
                  required
                  value={cloudUrl}
                  onChange={(e) => setCloudUrl(e.target.value)}
                />
              </label>
              <label className="account-gate-field">
                <span>账号名称（可选）</span>
                <input
                  id="account-gate-cloud-name"
                  type="text"
                  className="inline-text-input"
                  placeholder="例如：公司云端工作台"
                  value={cloudName}
                  onChange={(e) => setCloudName(e.target.value)}
                />
              </label>
              <label className="account-gate-field">
                <span>访问令牌（Token）</span>
                <input
                  id="account-gate-cloud-token"
                  type="password"
                  className="inline-text-input"
                  placeholder="粘贴 TWINKLEBOT_CLOUD_TOKEN"
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
                  取消
                </button>
                <button
                  id="account-gate-cloud-submit-btn"
                  type="submit"
                  className="settings-blue-pill"
                  disabled={cloudSaving || !cloudUrl.trim()}
                >
                  {cloudSaving ? "连接中…" : "连接并切换"}
                </button>
              </div>
            </form>
          )}

          {showMobileLanTools && subPanel === "lan-pair" && (
            <div id="account-gate-lan-panel" className="account-gate-inline-panel">
              {mobilePairModalOpen && pendingPairingDevice ? (
                <div className="account-gate-pair-verify">
                  <div className="account-gate-inline-hint">
                    配对至 {pendingPairingDevice.hostname || pendingPairingDevice.host}：请输入电脑端显示的 6 位配对码
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
                    aria-label="6 位数字配对码"
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
                      取消配对
                    </button>
                    <button
                      id="account-gate-pair-submit-btn"
                      type="button"
                      className="settings-blue-pill"
                      onClick={() => submitLanPairingCode(pairCode)}
                    >
                      验证并连接
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="account-gate-lan-head">
                    <span className="account-gate-inline-hint">
                      {lanScanning
                        ? "正在扫描同一 Wi-Fi 下的 TwinkleBot 桌面端…"
                        : unpairedDiscovered.length > 0
                          ? `发现 ${unpairedDiscovered.length} 台可配对电脑`
                          : "未自动发现新电脑，可重新扫描或手动输入 IP"}
                    </span>
                    <button
                      type="button"
                      className="settings-pill-btn"
                      disabled={lanScanning}
                      onClick={() => void scanAndRenderLanNodes()}
                    >
                      {lanScanning ? "扫描中…" : "重新扫描"}
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
                          <span className="account-gate-item-trailing">配对</span>
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
                      aria-label="手动输入局域网电脑地址"
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
                      配对
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
