import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  getLocalizedSkillMeta,
  inferMailServerPreset,
  isSkillSupportedOnPlatform,
} from "/skills-catalog.js";
import {
  closeAppsModal,
  commitSettingsPatch,
  openAppsModal,
  refreshMcpSkillStatus,
  refreshSettingsFromServer,
  selectSession,
  showConfirmDialog,
  showToast,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { hasConnectedNodeCapability } from "../../services/ota-updater.js";
import {
  getDefaultKimiCuConfig,
  resolveHostPlatformHint,
} from "../../state/constants.js";
import {
  formatMcpServersJson,
  getConfigurableSkillFromSettings,
  getSkillsCatalogFromSettings,
  parseMcpConfigJsonInput,
} from "../../state/helpers.js";
import { getState, setState, useStore } from "../../state/store.js";
import { isRemoteAccountOffline } from "../../services/network-monitor.js";
import { useI18n } from "../../services/i18n.js";
import {
  resolveSkillIconName,
  StatusText,
  UiIcon,
} from "../common/Icon.js";
import { NetworkStatusBanner } from "../common/NetworkStatusBanner.js";

function SkillIconGraphic({
  skillId,
  rawIcon,
  size = 19,
}: {
  skillId?: string | null;
  rawIcon?: string | null;
  size?: number;
}) {
  const svgName = resolveSkillIconName(skillId, rawIcon);
  if (svgName) {
    return <UiIcon name={svgName} size={size} />;
  }
  return <>{rawIcon || ""}</>;
}

function SkillRemoveConfirmBox({
  skill,
  spanGrid = false,
  onCancel,
  onDone,
}: {
  skill: any;
  spanGrid?: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { locale, t } = useI18n();
  const [purge, setPurge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const saved = Number(skill?.savedAccountCount) || 0;
  const isChannel = skill?.id === "feishu-bot" || skill?.id === "telegram-bot";
  const displayName = getLocalizedSkillMeta(skill, locale).name || skill?.name || skill?.id || "";

  return (
    <div
      className={`skill-remove-confirm${spanGrid ? " skills-grid-span" : ""}`}
      role="group"
      aria-label={t("skills.removeBoxAria", { name: displayName })}
    >
      <div className="skill-remove-text">
        {t("skills.removeBoxText", { name: displayName })}
      </div>
      {saved > 0 && (
        <label className="skill-remove-purge">
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => setPurge(e.target.checked)}
          />
          <span>
            {isChannel
              ? t("skills.removePurgeChannel")
              : t("skills.removePurgeMail", { count: saved })}
          </span>
        </label>
      )}
      <div className="skill-remove-actions">
        <button type="button" className="skill-pill-btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="skill-pill-btn is-danger"
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            try {
              const res = await apiJson(
                `/api/skills/${encodeURIComponent(skill.id)}${purge ? "?purgeCredentials=true" : ""}`,
                { method: "DELETE" }
              );
              setState((prev) => ({ settings: { ...prev.settings, ...res } }));
              showToast(t("skills.removedToast", { name: displayName }));
              onDone();
            } catch (err: any) {
              setSubmitting(false);
              showToast(t("skills.removeFailedToast", { error: err.message || "" }));
            }
          }}
        >
          {t("common.confirmRemove")}
        </button>
      </div>
    </div>
  );
}

export function SkillsStoreModal() {
  const { locale, t } = useI18n();
  const appsModalOpen = useStore((s) => s.appsModalOpen);
  const skillsView = useStore((s) => s.skillsView);
  const skillFilter = useStore((s) => s.skillFilter);
  const skillSearch = useStore((s) => s.skillSearch);
  const detailSkillId = useStore((s) => s.detailSkillId);
  const detailFrom = useStore((s) => s.detailFrom);
  const activeMailProvider = useStore((s) => s.activeMailProvider);
  const mailEditorOpen = useStore((s) => s.mailEditorOpen);
  const editingMailAccountId = useStore((s) => s.editingMailAccountId);
  const mailListFeedback = useStore((s) => s.mailListFeedback);
  const mailFormFeedback = useStore((s) => s.mailFormFeedback);
  const pendingRemoveSkillId = useStore((s) => s.pendingRemoveSkillId);
  const customSkillSearch = useStore((s) => s.customSkillSearch);
  const customSkillEditorOpen = useStore((s) => s.customSkillEditorOpen);
  const editingCustomSkillId = useStore((s) => s.editingCustomSkillId);
  const customSkillPreviewMode = useStore((s) => s.customSkillPreviewMode);
  const customSkillFeedback = useStore((s) => s.customSkillFeedback);
  const pendingDeleteCustomSkillId = useStore((s) => s.pendingDeleteCustomSkillId);
  const mcpStatusByServer = useStore((s) => s.mcpStatusByServer);
  const mcpFeedback = useStore((s) => s.mcpFeedback);
  const settings = useStore((s) => s.settings);
  const diagnostics = useStore((s) => s.diagnostics);
  const computerStatus = useStore((s) => s.computerStatus);
  const networkHealth = useStore((s) => s.networkHealth);
  const lanNodeOffline = useStore((s) => s.lanNodeOffline);
  const accountsState = useStore((s) => s.accountsState);
  const hostPlatform = resolveHostPlatformHint(
    settings?.hostPlatform ||
      computerStatus?.hostComputer?.platform ||
      diagnostics?.hostComputer?.platform
  );
  const isNonMacHost = Boolean(hostPlatform && hostPlatform !== "darwin");
  const isSkillUnsupported = (skill: any): boolean => {
    if (!skill) return false;
    if (skill.supported === false) return true;
    return !isSkillSupportedOnPlatform(skill, hostPlatform);
  };
  const defaultKimiConfig = getDefaultKimiCuConfig(hostPlatform);
  const remoteAccountOffline = isRemoteAccountOffline({
    accountsState,
    networkHealth,
    lanNodeOffline,
  } as any);

  const catalog = getSkillsCatalogFromSettings(settings);
  const customSkills: any[] = Array.isArray(settings?.customSkills) ? settings.customSkills : [];
  const enabledMailAccounts: any[] = (settings?.mailAccounts || []).filter(
    (a: any) => a && a.enabled !== false && a.email
  );
  const getProviderAccounts = (providerId: string | null) =>
    enabledMailAccounts.filter((a: any) => a.provider === providerId);

  // Custom Skill form local fields
  const [csIcon, setCsIcon] = useState("⚡");
  const [csName, setCsName] = useState("");
  const [csSlug, setCsSlug] = useState("");
  const [csDesc, setCsDesc] = useState("");
  const [csInstructions, setCsInstructions] = useState("");
  const [csEnabled, setCsEnabled] = useState(true);
  const [csSaving, setCsSaving] = useState(false);
  const [deletingCsId, setDeletingCsId] = useState<string | null>(null);
  const csNameRef = useRef<HTMLInputElement | null>(null);

  // QQ Mail form local fields
  const [qqEmail, setQqEmail] = useState("");
  const [qqLabel, setQqLabel] = useState("");
  const [qqAuthCode, setQqAuthCode] = useState("");
  const [qqShowSecret, setQqShowSecret] = useState(false);
  const [qqDefault, setQqDefault] = useState(false);
  const [qqSender, setQqSender] = useState("");
  const [qqProto, setQqProto] = useState<"imap" | "pop3">("imap");

  // Generic Mail form local fields
  const [cmEmail, setCmEmail] = useState("");
  const [cmPassword, setCmPassword] = useState("");
  const [cmShowSecret, setCmShowSecret] = useState(false);
  const [cmLabel, setCmLabel] = useState("");
  const [cmDefault, setCmDefault] = useState(false);
  const [cmProto, setCmProto] = useState<"pop3" | "imap">("pop3");
  const [cmInboundHost, setCmInboundHost] = useState("");
  const [cmInboundPort, setCmInboundPort] = useState("995");
  const [cmInboundTls, setCmInboundTls] = useState(true);
  const [cmSmtpSec, setCmSmtpSec] = useState<"ssl" | "starttls" | "none">("ssl");
  const [cmSmtpHost, setCmSmtpHost] = useState("");
  const [cmSmtpPort, setCmSmtpPort] = useState("465");
  const [cmSender, setCmSender] = useState("");
  const [cmUserEditedHost, setCmUserEditedHost] = useState(false);
  const [cmPresetApplied, setCmPresetApplied] = useState(false);

  const [mailBusyBtn, setMailBusyBtn] = useState<string | null>(null);
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null);

  const qqFormRef = useRef<HTMLFormElement | null>(null);
  const cmFormRef = useRef<HTMLFormElement | null>(null);

  // Detail skill routing: Mail vs MCP (`kimi-cu`) vs Chat Channel (`feishu-bot` / `telegram-bot`)
  const sessions = useStore((s) => s.sessions);
  const activeBaseUrl = useStore((s) => s.activeBaseUrl);
  const detailSkill = getConfigurableSkillFromSettings(settings, detailSkillId);
  const isChannelSkillDetail =
    detailSkillId === "feishu-bot" || detailSkillId === "telegram-bot";
  const isMcpSkill = Boolean(
    detailSkill?.mcpServerId || (detailSkill?.category === "platform" && !isChannelSkillDetail)
  );
  const mcpServerId = detailSkill?.mcpServerId || detailSkillId || "kimi-cu";

  // Channel integration multi-bot & pairing editor state (#13)
  const channelEntry = isChannelSkillDetail
    ? (settings?.channelIntegrations as any)?.[detailSkillId] || null
    : null;
  const supportsMultiBotChannels =
    hasConnectedNodeCapability("channel-multi-bot-pairing-v1") ||
    Array.isArray(channelEntry?.accounts);
  const channelAccounts: any[] = isChannelSkillDetail
    ? Array.isArray(channelEntry?.accounts)
      ? channelEntry.accounts
      : channelEntry?.config?.configured || channelEntry?.runtime?.status
        ? [
            {
              id: detailSkillId === "feishu-bot" ? "fs_default" : "tg_default",
              config: channelEntry.config || {},
              runtime: channelEntry.runtime || {},
              webhookPath: channelEntry.webhookPath,
            },
          ]
        : []
    : [];
  const [editingChannelAcctId, setEditingChannelAcctId] = useState<string | null>(null);
  const [channelEditorOpen, setChannelEditorOpen] = useState(false);
  const chEditorTarget =
    editingChannelAcctId !== null
      ? channelAccounts.find((a: any) => a.id === editingChannelAcctId) || null
      : null;
  const channelCfg =
    chEditorTarget?.config || (!supportsMultiBotChannels ? channelEntry?.config || {} : {});
  const channelRt =
    chEditorTarget?.runtime || (!supportsMultiBotChannels ? channelEntry?.runtime || {} : {});
  const [chLabel, setChLabel] = useState("");
  const [chEnabled, setChEnabled] = useState(true);
  const [chMode, setChMode] = useState("websocket");
  const [chTargetBotId, setChTargetBotId] = useState("");
  const [chRequirePairing, setChRequirePairing] = useState(true);
  const [chWhitelist, setChWhitelist] = useState("");
  const [chApprovalMode, setChApprovalMode] = useState("channel_and_app");
  const [chTgToken, setChTgToken] = useState("");
  const [chTgProxy, setChTgProxy] = useState("");
  const [chClearTgProxy, setChClearTgProxy] = useState(false);
  const [chTgSecret, setChTgSecret] = useState("");
  const [chClearTgSecret, setChClearTgSecret] = useState(false);
  const [chFsDomain, setChFsDomain] = useState("feishu");
  const [chFsAppId, setChFsAppId] = useState("");
  const [chFsAppSecret, setChFsAppSecret] = useState("");
  const [chFsVerifyToken, setChFsVerifyToken] = useState("");
  const [chFsEncryptKey, setChFsEncryptKey] = useState("");
  const [chClearFsVerify, setChClearFsVerify] = useState(false);
  const [chClearFsEncrypt, setChClearFsEncrypt] = useState(false);
  const [chBusy, setChBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [chTestingAccountId, setChTestingAccountId] = useState<string | null>(null);
  const [chConfirmDeleteId, setChConfirmDeleteId] = useState<string | null>(null);
  const [chFeedback, setChFeedback] = useState<{ text: string; kind: "info" | "success" | "error" }>({
    text: "",
    kind: "info",
  });
  const [chListFeedback, setChListFeedback] = useState<{ text: string; kind: "info" | "success" | "error" }>({
    text: "",
    kind: "info",
  });
  const [chPairings, setChPairings] = useState<{ pending: any[]; approved: any[] }>({
    pending: [],
    approved: [],
  });
  const [chPairingsBusyKey, setChPairingsBusyKey] = useState<string | null>(null);

  const loadChannelFormFromAccount = (acct: any | null, skillId: string) => {
    const cfg = acct?.config || {};
    setChLabel(String(cfg.label || ""));
    setChEnabled(!cfg.configured && !cfg.updatedAt ? true : Boolean(cfg.enabled));
    setChMode(cfg.connectionMode || (skillId === "feishu-bot" ? "websocket" : "polling"));
    setChTargetBotId(String(cfg.defaultSessionId || ""));
    setChRequirePairing(cfg.requirePairing !== undefined ? Boolean(cfg.requirePairing) : true);
    setChWhitelist(
      Array.isArray(cfg.allowedSenderIds) ? cfg.allowedSenderIds.join(", ") : ""
    );
    setChApprovalMode(cfg.approvalMode || "channel_and_app");
    setChTgToken("");
    setChTgProxy(String(cfg.proxy || ""));
    setChClearTgProxy(false);
    setChTgSecret("");
    setChClearTgSecret(false);
    setChFsDomain(cfg.domain || "feishu");
    setChFsAppId(String(cfg.appId || ""));
    setChFsAppSecret("");
    setChFsVerifyToken("");
    setChFsEncryptKey("");
    setChClearFsVerify(false);
    setChClearFsEncrypt(false);
  };

  const refreshChannelPairingsFromServer = async () => {
    if (!supportsMultiBotChannels) return;
    try {
      const res = await apiJson("/api/integrations/channels", { method: "GET" });
      if (res?.channels?.pairings) {
        setChPairings({
          pending: Array.isArray(res.channels.pairings.pending)
            ? res.channels.pairings.pending
            : [],
          approved: Array.isArray(res.channels.pairings.approved)
            ? res.channels.pairings.approved
            : [],
        });
      }
    } catch {
      // ignore transient network errors on background refresh
    }
  };

  useEffect(() => {
    if (!appsModalOpen || !isChannelSkillDetail || !detailSkillId) return;
    const entry = (settings?.channelIntegrations as any)?.[detailSkillId];
    const accts: any[] = Array.isArray(entry?.accounts)
      ? entry.accounts
      : entry?.config?.configured || entry?.runtime?.status
        ? [
            {
              id: detailSkillId === "feishu-bot" ? "fs_default" : "tg_default",
              config: entry.config || {},
              runtime: entry.runtime || {},
            },
          ]
        : [];
    setChConfirmDeleteId(null);
    setChListFeedback({ text: "", kind: "info" });
    setChFeedback({ text: "", kind: "info" });
    if (accts.length === 0) {
      setEditingChannelAcctId(null);
      setChannelEditorOpen(true);
      loadChannelFormFromAccount(null, detailSkillId);
    } else {
      setEditingChannelAcctId(null);
      setChannelEditorOpen(false);
      loadChannelFormFromAccount(accts[0], detailSkillId);
    }
  }, [appsModalOpen, detailSkillId, skillsView]);

  useEffect(() => {
    if (!appsModalOpen || !isChannelSkillDetail || !supportsMultiBotChannels) return;
    void refreshChannelPairingsFromServer();
  }, [appsModalOpen, isChannelSkillDetail, detailSkillId, supportsMultiBotChannels]);

  const livePairings: { pending: any[]; approved: any[] } =
    (settings?.channelIntegrations as any)?.pairings || chPairings;

  const getChannelPendingCount = (skillId: string, skill?: any): number => {
    const entry = (settings?.channelIntegrations as any)?.[skillId];
    if (typeof entry?.pendingPairingCount === "number") {
      return entry.pendingPairingCount;
    }
    if (typeof skill?.pendingPairingCount === "number") {
      return skill.pendingPairingCount;
    }
    const accts: any[] = Array.isArray(entry?.accounts) ? entry.accounts : [];
    if (accts.length > 0) {
      return accts.reduce(
        (sum, a) =>
          sum + (Array.isArray(a?.config?.pendingPairings) ? a.config.pendingPairings.length : 0),
        0
      );
    }
    return (livePairings?.pending || []).filter((p: any) => p?.channel === skillId).length;
  };

  const renderChannelPendingBadge = (skillId: string, skill?: any) => {
    if (skillId !== "feishu-bot" && skillId !== "telegram-bot") return null;
    const count = getChannelPendingCount(skillId, skill);
    if (count <= 0) return null;
    return (
      <span className="channel-pending-pill">
        {t("channel.pendingBadge", { count })}
      </span>
    );
  };
  const [mcpJsonText, setMcpJsonText] = useState(() =>
    formatMcpServersJson(settings?.mcpServers, mcpServerId, hostPlatform)
  );
  const [mcpBusy, setMcpBusy] = useState<"save" | "test" | null>(null);

  useEffect(() => {
    setMcpJsonText(formatMcpServersJson(settings?.mcpServers, mcpServerId, hostPlatform));
  }, [settings?.mcpServers, mcpServerId, detailSkillId, hostPlatform]);

  const resetMailFormsForCreate = (targetProvider: "qqmail" | "custom-mail") => {
    const anyMail = enabledMailAccounts.length > 0;
    setQqEmail("");
    setQqLabel("");
    setQqAuthCode("");
    setQqShowSecret(false);
    setQqDefault(!anyMail);
    setQqSender("");
    setQqProto("imap");

    setCmEmail("");
    setCmPassword("");
    setCmShowSecret(false);
    setCmLabel("");
    setCmDefault(!anyMail);
    setCmProto("imap");
    setCmInboundHost("");
    setCmInboundPort("993");
    setCmInboundTls(true);
    setCmSmtpSec("ssl");
    setCmSmtpHost("");
    setCmSmtpPort("465");
    setCmSender("");
    setCmUserEditedHost(false);
    setCmPresetApplied(false);

    setState({
      activeMailProvider: targetProvider,
      editingMailAccountId: null,
      mailFormFeedback: {},
    });
  };

  const startEditingMailAccount = (acct: any) => {
    if (!acct?.id) return;
    if (mailEditorOpen && editingMailAccountId === acct.id) {
      setState({
        editingMailAccountId: null,
        mailEditorOpen: false,
        mailFormFeedback: {},
      });
      return;
    }
    const provider = acct.provider === "custom-mail" ? "custom-mail" : "qqmail";
    setState({
      editingMailAccountId: acct.id,
      mailEditorOpen: true,
      activeMailProvider: provider,
      mailFormFeedback: {},
    });
    if (provider === "qqmail") {
      setQqEmail(acct.email || "");
      setQqLabel(acct.label || "");
      setQqAuthCode("");
      setQqShowSecret(false);
      setQqDefault(Boolean(acct.isDefault));
      setQqSender(acct.senderName || "");
      setQqProto(acct.inboundProtocol === "pop3" ? "pop3" : "imap");
    } else {
      const proto = acct.inboundProtocol === "imap" ? "imap" : "pop3";
      setCmEmail(acct.email || "");
      setCmPassword("");
      setCmShowSecret(false);
      setCmLabel(acct.label || "");
      setCmDefault(Boolean(acct.isDefault));
      setCmProto(proto);
      setCmInboundHost(acct.inboundHost || "");
      setCmInboundPort(String(acct.inboundPort || (proto === "imap" ? 993 : 995)));
      setCmInboundTls(acct.inboundTls !== false);
      setCmSmtpSec(
        acct.smtpTls ? "ssl" : acct.smtpStarttls ? "starttls" : "none"
      );
      setCmSmtpHost(acct.smtpHost || "");
      setCmSmtpPort(String(acct.smtpPort || 465));
      setCmSender(acct.senderName || "");
      setCmUserEditedHost(true);
      setCmPresetApplied(false);
    }
  };

  useEffect(() => {
    if (skillsView === "detail" && detailSkillId && !isMcpSkill && !isChannelSkillDetail) {
      const pAccounts = getProviderAccounts(detailSkillId);
      if (pAccounts.length === 0 && !editingMailAccountId && !mailEditorOpen) {
        resetMailFormsForCreate(detailSkillId === "custom-mail" ? "custom-mail" : "qqmail");
      }
    }
  }, [skillsView, detailSkillId, isMcpSkill, isChannelSkillDetail]);

  const applyCustomPresetForEmail = (nextEmail: string, nextProto: "pop3" | "imap") => {
    if (editingMailAccountId || cmUserEditedHost) return;
    const preset = inferMailServerPreset(nextEmail.trim(), nextProto);
    if (!preset) return;
    setCmInboundHost(String(preset.inboundHost));
    setCmInboundPort(String(preset.inboundPort));
    setCmSmtpHost(String(preset.smtpHost));
    setCmSmtpPort(String(preset.smtpPort));
    setCmSmtpSec(
      preset.smtpSecurity === "starttls"
        ? "starttls"
        : preset.smtpSecurity === "none"
          ? "none"
          : "ssl"
    );
    setCmPresetApplied(true);
  };

  const applyMailApiResponse = (res: any) => {
    if (!res || typeof res !== "object") return;
    setState((prev) => {
      const nextSettings = { ...prev.settings };
      if (Array.isArray(res.accounts)) nextSettings.mailAccounts = res.accounts;
      else if (Array.isArray(res.mailAccounts)) nextSettings.mailAccounts = res.mailAccounts;
      if (Array.isArray(res.connectedApps)) nextSettings.connectedApps = res.connectedApps;
      if (res.mailIntegrations) nextSettings.mailIntegrations = res.mailIntegrations;
      return { settings: nextSettings };
    });
  };

  const collectMailPayload = (provider: "qqmail" | "custom-mail") => {
    const editingId = editingMailAccountId || undefined;
    const forceNew = !editingId;
    if (provider === "qqmail") {
      return {
        id: editingId,
        forceNew,
        provider: "qqmail",
        label: qqLabel.trim(),
        email: qqEmail.trim(),
        authCode: qqAuthCode.trim(),
        senderName: qqSender.trim(),
        inboundProtocol: qqProto,
        isDefault: qqDefault,
      };
    }
    return {
      id: editingId,
      forceNew,
      provider: "custom-mail",
      label: cmLabel.trim(),
      email: cmEmail.trim(),
      password: cmPassword.trim(),
      senderName: cmSender.trim(),
      inboundProtocol: cmProto,
      inboundHost: cmInboundHost.trim(),
      inboundPort: Number(cmInboundPort.trim()) || (cmProto === "imap" ? 993 : 995),
      inboundTls: cmInboundTls,
      smtpHost: cmSmtpHost.trim(),
      smtpPort:
        Number(cmSmtpPort.trim()) ||
        (cmSmtpSec === "starttls" ? 587 : cmSmtpSec === "none" ? 25 : 465),
      smtpSecurity: cmSmtpSec,
      isDefault: cmDefault,
    };
  };

  const setProviderMailFeedback = (
    provider: "qqmail" | "custom-mail",
    text: string,
    kind: string
  ) => {
    setState((prev) => ({
      mailFormFeedback: {
        ...prev.mailFormFeedback,
        [provider]: { text, kind },
      },
    }));
  };

  const handleMailSave = async (provider: "qqmail" | "custom-mail", e: FormEvent) => {
    e.preventDefault();
    const formEl = provider === "qqmail" ? qqFormRef.current : cmFormRef.current;
    if (formEl && !formEl.checkValidity()) {
      (formEl.querySelector(":invalid") as HTMLElement | null)?.focus();
      return;
    }
    const wasEditing = Boolean(editingMailAccountId);
    setMailBusyBtn(`${provider}-save`);
    setProviderMailFeedback(provider, t("skills.mailConnectingFeedback"), "info");
    try {
      const payload = collectMailPayload(provider);
      const res = await apiJson("/api/integrations/mail/accounts", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      applyMailApiResponse(res);
      const savedAcct = res.account || {};
      const stats = res.inboxStats;
      const unseenInfo =
        stats?.unseen !== undefined ? t("skills.mailUnseenParenPart", { count: stats.unseen }) : "";
      resetMailFormsForCreate(provider);
      setState({
        mailEditorOpen: false,
        editingMailAccountId: null,
        mailListFeedback: {
          text: wasEditing
            ? t("skills.mailSavedEditFeedback", {
                email: savedAcct.email || payload.email,
                count: stats?.messages ?? 0,
                unseenInfo,
              })
            : t("skills.mailConnectedFeedback", {
                email: savedAcct.email || payload.email,
                count: stats?.messages ?? 0,
                unseenInfo,
              }),
          kind: "success",
        },
      });
      await refreshSettingsFromServer();
      showToast(
        wasEditing
          ? t("skills.mailUpdatedToast", { label: savedAcct.label || savedAcct.email })
          : t("skills.mailAddedToast", { label: savedAcct.label || savedAcct.email })
      );
    } catch (err: any) {
      setProviderMailFeedback(
        provider,
        `❌ ${err.message || t("skills.mailConnectFailedFallback")}`,
        "error"
      );
    } finally {
      setMailBusyBtn(null);
    }
  };

  const handleMailTest = async (provider: "qqmail" | "custom-mail", sendTestMail = false) => {
    const formEl = provider === "qqmail" ? qqFormRef.current : cmFormRef.current;
    if (!sendTestMail && formEl && !formEl.checkValidity()) {
      (formEl.querySelector(":invalid") as HTMLElement | null)?.focus();
      return;
    }
    setMailBusyBtn(`${provider}-${sendTestMail ? "send" : "test"}`);
    setProviderMailFeedback(
      provider,
      sendTestMail ? t("skills.mailSendingTestFeedback") : t("skills.mailTestingHandshakeFeedback"),
      "info"
    );
    try {
      const payload = collectMailPayload(provider);
      const res = await apiJson("/api/integrations/mail/test", {
        method: "POST",
        body: JSON.stringify(sendTestMail ? { ...payload, sendTestMail: true } : payload),
      });
      if (sendTestMail) {
        setProviderMailFeedback(provider, t("skills.mailTestSentSuccess"), "success");
      } else {
        const unseenInfo =
          res.unseen !== undefined ? t("skills.mailUnseenCommaPart", { count: res.unseen }) : "";
        setProviderMailFeedback(
          provider,
          t("skills.mailHandshakeOkFeedback", {
            ms: res.latencyMs || 0,
            count: res.messages ?? 0,
            unseenInfo,
          }),
          "success"
        );
      }
    } catch (err: any) {
      setProviderMailFeedback(
        provider,
        sendTestMail
          ? t("skills.mailSendTestFailed", { error: err.message || "" })
          : `❌ ${err.message || t("skills.mailTestFailedFallback")}`,
        "error"
      );
    } finally {
      setMailBusyBtn(null);
    }
  };

  const handleMailDisconnect = async (provider: "qqmail" | "custom-mail") => {
    const targetId = editingMailAccountId;
    if (!targetId) return;
    const ok = await showConfirmDialog({
      title: t("skills.mailRemoveTitle"),
      message: t("skills.mailRemoveMsg"),
      detail: t("skills.mailRemoveDetail"),
      confirmText: t("common.confirmRemove"),
      cancelText: t("common.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    setMailBusyBtn(`${provider}-disconnect`);
    try {
      const res = await apiJson(
        `/api/integrations/mail/accounts/${encodeURIComponent(targetId)}`,
        { method: "DELETE" }
      );
      applyMailApiResponse(res);
      resetMailFormsForCreate(provider);
      setState({
        mailEditorOpen: false,
        editingMailAccountId: null,
        mailListFeedback: {
          text: t("skills.mailRemovedNotice"),
          kind: "info",
        },
      });
      await refreshSettingsFromServer();
      showToast(t("skills.mailRemovedToast"));
    } catch (err: any) {
      setProviderMailFeedback(
        provider,
        t("skills.mailRemoveFailedFeedback", { error: err.message || "" }),
        "error"
      );
    } finally {
      setMailBusyBtn(null);
    }
  };

  const installSkill = async (skillId: string) => {
    const targetSkill = getConfigurableSkillFromSettings(getState().settings, skillId);
    if (targetSkill && isSkillUnsupported(targetSkill)) {
      showToast(t("skills.unsupportedPlatformToast"));
      return;
    }
    try {
      const res = await apiJson(`/api/skills/${encodeURIComponent(skillId)}/install`, {
        method: "POST",
      });
      const mergedSettings = { ...getState().settings, ...res };
      setState({ settings: mergedSettings });
      const addedSkill = getConfigurableSkillFromSettings(mergedSettings, skillId);
      const addedName = addedSkill
        ? getLocalizedSkillMeta(addedSkill, locale).name || addedSkill.name || skillId
        : skillId;
      showToast(t("skills.addedToast", { name: addedName }));
      if (addedSkill?.mcpServerId) {
        refreshMcpSkillStatus(addedSkill.mcpServerId, true);
      }
    } catch (err: any) {
      showToast(t("skills.addFailedToast", { error: err.message || "" }));
    }
  };

  const officeSkillSubtitle = (skill: any) => {
    const loc = getLocalizedSkillMeta(skill, locale);
    if (!skill.installed) return loc.desc;
    const n = getProviderAccounts(skill.id).length;
    return n > 0 ? t("skills.officeConfiguredSub", { count: n }) : t("skills.officePendingSub");
  };

  const isChannelSkillItem = (skill: any) =>
    skill?.id === "feishu-bot" || skill?.id === "telegram-bot";

  const channelSkillSubtitle = (skill: any) => {
    const loc = getLocalizedSkillMeta(skill, locale);
    if (!skill?.installed) {
      return t("skills.manualEnableSub", { desc: loc.desc });
    }
    const entry = (settings?.channelIntegrations as any)?.[skill.id];
    const accts: any[] = Array.isArray(entry?.accounts) ? entry.accounts : [];
    const pendingCount = getChannelPendingCount(skill.id, skill);
    const pendingText = pendingCount > 0 ? ` · ${t("channel.pendingBadge", { count: pendingCount })}` : "";
    if (accts.length > 0) {
      const onlineCount = accts.filter(
        (a) => a?.runtime?.status === "connected" || a?.runtime?.status === "webhook_ready"
      ).length;
      const errAcct = accts.find((a) => a?.runtime?.status === "error" && a?.runtime?.lastError);
      if (onlineCount > 0) {
        return t("skills.channelMultiOnlineSub", {
          bots: t("channel.multiBotCountSubtitle", { count: accts.length }),
          online: onlineCount,
          pendingText,
          desc: loc.desc,
        });
      }
      if (errAcct) {
        return `${t("channel.multiBotCountSubtitle", { count: accts.length })} · ${errAcct.runtime.lastError}${pendingText}`;
      }
      return t("skills.channelMultiConfigureSub", {
        bots: t("channel.multiBotCountSubtitle", { count: accts.length }),
        pendingText,
      });
    }
    const cfg = entry?.config;
    const rt = entry?.runtime;
    if (rt?.status === "connected") {
      return `${t("channel.statusConnected")}${rt.botName ? ` · ${rt.botName}` : ""}${pendingText} · ${loc.desc}`;
    }
    if (rt?.status === "connecting") {
      return `${t("channel.statusConnecting")}${rt.botName ? ` · ${rt.botName}` : ""}${pendingText} · ${loc.desc}`;
    }
    if (rt?.status === "webhook_ready") {
      return `${t("channel.statusReady")}${rt.botName ? ` · ${rt.botName}` : ""}${pendingText} · ${loc.desc}`;
    }
    if (rt?.status === "error" && rt.lastError) {
      return `${rt.lastError}${pendingText}`;
    }
    if (cfg?.configured) {
      return cfg.enabled
        ? t("skills.channelStoppedCheckSub", { status: t("channel.statusStopped") })
        : t("skills.channelDisabledHintSub");
    }
    return t("skills.channelPendingConfigSub", { desc: loc.desc });
  };

  const platformSkillSubtitle = (skill: any) => {
    if (isChannelSkillItem(skill)) {
      return channelSkillSubtitle(skill);
    }
    const loc = getLocalizedSkillMeta(skill, locale);
    if (!skill.removable) {
      return t("skills.toolCountSub", { count: skill.toolCount, desc: loc.desc });
    }
    if (!skill.installed) {
      return isSkillUnsupported(skill)
        ? t("skills.macOnlyStoreSub", { desc: loc.desc })
        : t("skills.manualEnableSub", { desc: loc.desc });
    }
    const srv = mcpStatusByServer?.[skill.mcpServerId || skill.id];
    if (srv?.connected) {
      const ver = srv.serverInfo?.version ? ` v${srv.serverInfo.version}` : "";
      return t("skills.mcpConnectedSub", {
        ver,
        count: srv.toolCount || skill.toolCount,
      });
    }
    if (isSkillUnsupported(skill)) {
      return t("skills.mcpUnsupportedSub");
    }
    if (srv?.binaryExists === false || srv?.binaryInstalled === false) {
      return isNonMacHost || srv?.unsupportedPlatform
        ? t("skills.mcpUnsupportedSub")
        : t("skills.mcpMissingBinarySub");
    }
    return typeof skill.toolCount === "number" && skill.toolCount > 0
      ? t("skills.mcpAddedSub", { count: skill.toolCount })
      : t("skills.mcpAddedDynamicSub");
  };

  const skillMatchesSearch = (skill: any, query: string) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const loc = getLocalizedSkillMeta(skill, locale);
    const accountText = (skill.id ? getProviderAccounts(skill.id) : [])
      .map((a: any) => `${a.email} ${a.label || ""}`)
      .join(" ");
    return `${skill.name || ""} ${loc.name || ""} ${skill.desc || skill.instruction || ""} ${loc.desc || ""} ${accountText}`
      .toLowerCase()
      .includes(q);
  };

  // Store counts — hide non-configurable built-in skills (`category === "builtin"` / `removable === false`, #14)
  const visiblePlatform = catalog.platform.filter(
    (s: any) => s && s.category !== "builtin" && s.removable !== false
  );
  const installedOffice = catalog.office.filter((s: any) => s.installed);
  const installedPlatform = visiblePlatform.filter((s: any) => s.installed);
  const totalAdded = installedOffice.length + installedPlatform.length;
  const searchTrim = skillSearch.trim();
  const filteredOffice =
    skillFilter === "all" || skillFilter === "office"
      ? catalog.office.filter((s: any) => skillMatchesSearch(s, searchTrim))
      : [];
  const filteredPlatform = (
    skillFilter === "all" || skillFilter === "platform"
      ? visiblePlatform.filter((s: any) => skillMatchesSearch(s, searchTrim))
      : []
  ).sort((a: any, b: any) => {
    const aUnsup = !a.installed && isSkillUnsupported(a) ? 1 : 0;
    const bUnsup = !b.installed && isSkillUnsupported(b) ? 1 : 0;
    return aUnsup - bUnsup;
  });

  // Custom Skills calculations
  const supportsExperienceReflector = hasConnectedNodeCapability("experience-reflector-v1", {
    diagnostics,
  });
  const [pendingProposals, setPendingProposals] = useState<any[]>([]);
  const [resolvingProposalId, setResolvingProposalId] = useState<string | null>(null);

  const loadPendingProposals = async () => {
    if (!supportsExperienceReflector) {
      setPendingProposals([]);
      return;
    }
    try {
      const res = await apiJson("/api/experience-proposals?status=pending", { method: "GET" });
      setPendingProposals(Array.isArray(res?.proposals) ? res.proposals : []);
    } catch {
      // ignore transient errors when modal refreshes
    }
  };

  useEffect(() => {
    if (!appsModalOpen || skillsView !== "manage" || !supportsExperienceReflector) return;
    void loadPendingProposals();
  }, [appsModalOpen, skillsView, supportsExperienceReflector]);

  const handleResolveProposal = async (proposal: any, action: "accept" | "dismiss") => {
    if (!proposal?.id || resolvingProposalId) return;
    setResolvingProposalId(proposal.id);
    try {
      await apiJson(`/api/experience-proposals/${encodeURIComponent(proposal.id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setPendingProposals((prev) => prev.filter((p) => p.id !== proposal.id));
      if (action === "accept") {
        await refreshSettingsFromServer();
        showToast(t("skills.expProposalsAcceptedToast", { title: proposal.title || "" }));
      } else {
        showToast(t("skills.expProposalsDismissedToast", { title: proposal.title || "" }));
      }
    } catch (err: any) {
      showToast(err?.message || t("skills.customSaveFailedFallback"));
    } finally {
      setResolvingProposalId(null);
    }
  };

  const enabledCustomCount = customSkills.filter((s: any) => s.enabled !== false).length;
  const csQuery = customSkillSearch.trim().toLowerCase();
  const filteredCustomSkills = csQuery
    ? customSkills.filter((s: any) =>
        `${s.id} ${s.name} ${s.description} ${s.createdByBotName || ""}`
          .toLowerCase()
          .includes(csQuery)
      )
    : customSkills;

  const openCustomEditorFor = (skill: any | null) => {
    const targetId = skill ? skill.id : null;
    if (customSkillEditorOpen && editingCustomSkillId === targetId) {
      setState({
        customSkillEditorOpen: false,
        editingCustomSkillId: null,
        customSkillPreviewMode: false,
        customSkillFeedback: "",
      });
      return;
    }
    setCsIcon(skill?.icon || "⚡");
    setCsName(skill?.name || "");
    setCsSlug(skill?.id || "");
    setCsDesc(skill?.description || "");
    setCsInstructions(skill?.instructions || "");
    setCsEnabled(skill ? skill.enabled !== false : true);
    setState({
      customSkillEditorOpen: true,
      editingCustomSkillId: skill ? skill.id : null,
      customSkillPreviewMode: false,
      customSkillFeedback: "",
      pendingDeleteCustomSkillId: null,
    });
    requestAnimationFrame(() => csNameRef.current?.focus({ preventScroll: true }));
  };

  const buildCustomPreviewMd = () => {
    const name = csName.trim() || t("skills.customUnnamedFallback");
    const slug =
      csSlug.trim() ||
      editingCustomSkillId ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      "custom-skill";
    const icon = csIcon.trim() || "⚡";
    const desc = csDesc.trim() || t("skills.customDescMissingFallback");
    const body = csInstructions.trim() || t("skills.customBodyMissingFallback");
    const existing = editingCustomSkillId
      ? customSkills.find((s: any) => s.id === editingCustomSkillId)
      : null;
    const createdBy = existing?.createdBy === "bot" ? "bot" : "user";
    const lines = [
      "---",
      `id: ${slug}`,
      `name: ${name}`,
      `icon: ${icon}`,
      `description: ${desc}`,
      `enabled: ${csEnabled}`,
      `createdBy: ${createdBy}`,
    ];
    if (existing?.createdByBotName) {
      lines.push(`createdByBotName: ${existing.createdByBotName}`);
    }
    lines.push("---", "", body);
    return lines.join("\n");
  };

  const handleSaveCustomSkill = async (e: FormEvent) => {
    e.preventDefault();
    const name = csName.trim();
    const slug = csSlug.trim();
    const icon = csIcon.trim() || "⚡";
    const description = csDesc.trim();
    const instructions = csInstructions.trim();
    if (!name || !description || !instructions) {
      setState({
        customSkillFeedback: t("skills.customRequiredFieldsMsg"),
      });
      return;
    }
    setState({ customSkillFeedback: "" });
    setCsSaving(true);
    try {
      if (editingCustomSkillId) {
        await apiJson(`/api/custom-skills/${encodeURIComponent(editingCustomSkillId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(slug && slug !== editingCustomSkillId ? { newId: slug } : {}),
            name,
            icon,
            description,
            instructions,
            enabled: csEnabled,
          }),
        });
      } else {
        await apiJson("/api/custom-skills", {
          method: "POST",
          body: JSON.stringify({
            ...(slug ? { id: slug } : {}),
            name,
            icon,
            description,
            instructions,
            enabled: csEnabled,
            createdBy: "user",
          }),
        });
      }
      const wasEdit = Boolean(editingCustomSkillId);
      setState({
        customSkillEditorOpen: false,
        editingCustomSkillId: null,
        customSkillPreviewMode: false,
        customSkillFeedback: "",
      });
      await refreshSettingsFromServer();
      showToast(
        wasEdit
          ? t("skills.customUpdatedToast", { name })
          : t("skills.customCreatedToast", { name })
      );
    } catch (err: any) {
      setState({ customSkillFeedback: err?.message || t("skills.customSaveFailedFallback") });
    } finally {
      setCsSaving(false);
    }
  };

  // Detail view mail & MCP state
  const detailProviderAccounts =
    detailSkillId && !isMcpSkill && !isChannelSkillDetail ? getProviderAccounts(detailSkillId) : [];
  const editingAccount = editingMailAccountId
    ? detailProviderAccounts.find((a: any) => a.id === editingMailAccountId) || null
    : null;
  const showMailCreateForm =
    !isMcpSkill &&
    !isChannelSkillDetail &&
    ((mailEditorOpen && !editingMailAccountId) || detailProviderAccounts.length === 0);
  const detailBackLabel = detailFrom === "manage" ? t("skills.backManageLabel") : t("skills.title");

  const srv = mcpStatusByServer?.[mcpServerId];
  const srvCmdText = srv
    ? `${srv.command || ""}${Array.isArray(srv.args) && srv.args.length ? ` ${srv.args.join(" ")}` : ""}`
    : "";
  const srvErr = srv?.error || srv?.lastError || "";
  const srvBinMissing = srv?.binaryExists === false || srv?.binaryInstalled === false;

  const qqFb = mailFormFeedback.qqmail || { text: "", kind: "info" };
  const cmFb = mailFormFeedback["custom-mail"] || { text: "", kind: "info" };

  const removableInstalled = [
    ...catalog.office.filter((x: any) => x.installed),
    ...visiblePlatform.filter((x: any) => x.removable && x.installed),
  ];

  const renderCustomSkillEditorForm = (inline: boolean, visible: boolean) => (
    <form
      id="custom-skill-editor-form"
      className={`custom-skill-editor${inline ? " is-inline-row-editor" : ""}`}
      hidden={!visible}
      onSubmit={handleSaveCustomSkill}
    >
      <div className="custom-skill-editor-top">
        <strong id="custom-skill-editor-title">
          {editingCustomSkillId
            ? t("skills.customEditTitle", { name: csName || editingCustomSkillId })
            : t("skills.customNewTitle")}
        </strong>
        <button
          id="custom-skill-preview-toggle-btn"
          type="button"
          className="skill-pill-btn"
          onClick={() =>
            setState((prev) => ({
              customSkillPreviewMode: !prev.customSkillPreviewMode,
            }))
          }
        >
          {customSkillPreviewMode ? t("skills.customBackToFormBtn") : t("skills.customPreviewMdBtn")}
        </button>
      </div>

      <div
        id="custom-skill-fields-pane"
        className="custom-skill-fields"
        hidden={customSkillPreviewMode}
      >
        <div className="custom-skill-row-two">
          <label className="field-group custom-skill-icon-field">
            <span>{t("skills.customIconLabel")}</span>
            <input
              id="custom-skill-icon-input"
              type="text"
              maxLength={4}
              value={csIcon}
              onChange={(e) => setCsIcon(e.target.value)}
            />
          </label>
          <label className="field-group custom-skill-name-field">
            <span>{t("skills.customNameLabel")}</span>
            <input
              ref={csNameRef}
              id="custom-skill-name-input"
              type="text"
              maxLength={64}
              placeholder={t("skills.customNamePh")}
              required
              value={csName}
              onChange={(e) => setCsName(e.target.value)}
            />
          </label>
          <label className="field-group custom-skill-slug-field">
            <span>{t("skills.customSlugLabel")}</span>
            <input
              id="custom-skill-slug-input"
              type="text"
              maxLength={64}
              placeholder={t("skills.customSlugPh")}
              value={csSlug}
              onChange={(e) => setCsSlug(e.target.value)}
            />
          </label>
        </div>
        <label className="field-group">
          <span>{t("skills.customDescLabel")}</span>
          <input
            id="custom-skill-desc-input"
            type="text"
            maxLength={240}
            placeholder={t("skills.customDescPh")}
            required
            value={csDesc}
            onChange={(e) => setCsDesc(e.target.value)}
          />
        </label>
        <label className="field-group">
          <span>{t("skills.customInstructionsLabel")}</span>
          <textarea
            id="custom-skill-instructions-input"
            rows={6}
            placeholder={t("skills.customInstructionsPh")}
            required
            value={csInstructions}
            onChange={(e) => setCsInstructions(e.target.value)}
          />
        </label>
      </div>

      <pre
        id="custom-skill-md-preview"
        className="custom-skill-md-preview"
        hidden={!customSkillPreviewMode}
      >
        {customSkillPreviewMode ? buildCustomPreviewMd() : ""}
      </pre>

      <div
        id="custom-skill-form-feedback"
        className="mail-feedback-box is-error"
        hidden={!customSkillFeedback}
      >
        {customSkillFeedback}
      </div>

      <div className="custom-skill-editor-actions">
        <label className="custom-skill-enabled-check">
          <input
            id="custom-skill-enabled-input"
            type="checkbox"
            checked={csEnabled}
            onChange={(e) => setCsEnabled(e.target.checked)}
          />
          <span>{t("skills.customShareAllBots")}</span>
        </label>
        <div className="custom-skill-editor-btns">
          <button
            id="custom-skill-cancel-btn"
            type="button"
            className="skill-pill-btn"
            onClick={() =>
              setState({
                customSkillEditorOpen: false,
                editingCustomSkillId: null,
                customSkillPreviewMode: false,
                customSkillFeedback: "",
              })
            }
          >
            {t("common.cancel")}
          </button>
          <button
            id="custom-skill-save-btn"
            type="submit"
            className="skill-pill-btn is-primary"
            disabled={csSaving}
          >
            {t("skills.customSaveBtn")}
          </button>
        </div>
      </div>
    </form>
  );

  const renderMailFormEditorShell = (inline: boolean, visible: boolean) => (
    <div
      className={`mail-form-editor-shell${inline ? " is-inline-row-editor" : ""}`}
      id="mail-form-editor-shell"
      hidden={!visible}
    >
      <div className="mail-editor-mode-bar" hidden>
        <span className="mail-editor-mode-label" id="mail-editor-mode-label">
          {t("skills.mailAddModeBar")}
        </span>
      </div>

      {/* Form 1: QQ Mail */}
      <form
        ref={qqFormRef}
        id="qqmail-config-form"
        className="mail-config-form"
        action="/api/integrations/mail/accounts"
        method="POST"
        aria-labelledby="qqmail-form-heading"
        noValidate
        hidden={activeMailProvider !== "qqmail"}
        onSubmit={(e) => handleMailSave("qqmail", e)}
      >
        <div className="mail-form-header">
          <div>
            <h3 id="qqmail-form-heading" className="mail-form-title">
              {editingAccount && activeMailProvider === "qqmail"
                ? t("skills.qqFormEditTitle", { email: editingAccount.email })
                : t("skills.qqFormNewTitle")}
            </h3>
            <div className="mail-form-meta" id="qqmail-verified-meta">
              {editingAccount && activeMailProvider === "qqmail"
                ? editingAccount.inboxStats
                  ? t("skills.qqFormInboxStats", {
                      count: editingAccount.inboxStats.messages ?? 0,
                      unseenPart:
                        editingAccount.inboxStats.unseen !== undefined
                          ? t("skills.mailUnseenCommaPart", { count: editingAccount.inboxStats.unseen })
                          : "",
                    })
                  : t("skills.mailEditingMeta", { email: editingAccount.email })
                : t("skills.qqFormDefaultMeta")}
            </div>
          </div>
          <button
            id="qqmail-cancel-edit-btn"
            type="button"
            className="settings-pill-btn"
            hidden={detailProviderAccounts.length === 0}
            onClick={() => setState({ mailEditorOpen: false, editingMailAccountId: null })}
          >
            {inline ? t("common.collapse") : t("skills.mailBackToListBtn")}
          </button>
        </div>

        <div className="mail-form-grid-two">
          <div className="mail-field">
            <label htmlFor="qqmail-email-input">
              {t("skills.qqEmailLabel")} <span aria-hidden="true">*</span>
            </label>
            <span id="qqmail-email-hint" className="mail-field-hint">
              {t("skills.qqEmailHint")}
            </span>
            <input
              id="qqmail-email-input"
              name="email"
              type="email"
              className="mail-text-input"
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              required
              aria-invalid="false"
              aria-describedby="qqmail-email-hint"
              data-error="qqmail-email-error"
              placeholder={t("skills.qqEmailPh")}
              value={qqEmail}
              onChange={(e) => setQqEmail(e.target.value)}
            />
            <div id="qqmail-email-error" className="mail-error-msg">
              {t("skills.qqEmailError")}
            </div>
          </div>

          <div className="mail-field">
            <label htmlFor="qqmail-label-input">{t("skills.mailLabelField")}</label>
            <span id="qqmail-label-hint" className="mail-field-hint">
              {t("skills.qqLabelHint")}
            </span>
            <input
              id="qqmail-label-input"
              name="label"
              type="text"
              className="mail-text-input"
              maxLength={32}
              enterKeyHint="next"
              aria-invalid="false"
              aria-describedby="qqmail-label-hint"
              placeholder={t("skills.qqLabelPh")}
              value={qqLabel}
              onChange={(e) => setQqLabel(e.target.value)}
            />
          </div>
        </div>

        <div className="mail-field">
          <div className="mail-label-row">
            <label htmlFor="qqmail-authcode-input">
              {t("skills.qqAuthCodeLabel")}{" "}
              <span
                id="qqmail-secret-req"
                aria-hidden="true"
                hidden={Boolean(editingAccount)}
              >
                *
              </span>
            </label>
            <button
              type="button"
              id="qqmail-toggle-secret-btn"
              className="mail-secret-toggle"
              aria-pressed={qqShowSecret ? "true" : "false"}
              aria-label={t("skills.qqToggleSecretAria")}
              onClick={() => setQqShowSecret((v) => !v)}
            >
              {qqShowSecret ? t("skills.qqHideSecret") : t("skills.qqShowSecret")}
            </button>
          </div>
          <span id="qqmail-authcode-hint" className="mail-field-hint">
            {t("skills.qqAuthCodeHint")}
          </span>
          <input
            id="qqmail-authcode-input"
            name="authCode"
            type={qqShowSecret ? "text" : "password"}
            className="mail-text-input"
            autoComplete="current-password"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            minLength={editingAccount ? undefined : 8}
            enterKeyHint="done"
            required={!editingAccount}
            aria-invalid="false"
            aria-describedby="qqmail-authcode-hint"
            data-error="qqmail-authcode-error"
            placeholder={
              editingAccount
                ? t("skills.qqAuthKeepPh", { mask: editingAccount.maskedSecret || "••••" })
                : t("skills.qqAuthNewPh")
            }
            value={qqAuthCode}
            onChange={(e) => setQqAuthCode(e.target.value)}
          />
          <div id="qqmail-authcode-error" className="mail-error-msg">
            {t("skills.qqAuthCodeError")}
          </div>
        </div>

        <div className="mail-field mail-checkbox-row">
          <div className="mail-inline-check">
            <input
              type="checkbox"
              id="qqmail-default-check"
              name="isDefault"
              checked={qqDefault}
              onChange={(e) => setQqDefault(e.target.checked)}
            />
            <label htmlFor="qqmail-default-check">{t("skills.mailSetDefaultLabel")}</label>
          </div>
        </div>

        <details className="mail-advanced-details">
          <summary>{t("skills.qqAdvSummary")}</summary>
          <div className="mail-advanced-body">
            <div className="mail-field">
              <label htmlFor="qqmail-sender-input">{t("skills.qqSenderLabel")}</label>
              <span id="qqmail-sender-hint" className="mail-field-hint">
                {t("skills.qqSenderHint")}
              </span>
              <input
                id="qqmail-sender-input"
                name="senderName"
                type="text"
                className="mail-text-input"
                autoComplete="name"
                enterKeyHint="next"
                aria-invalid="false"
                aria-describedby="qqmail-sender-hint"
                placeholder={t("skills.qqSenderPh")}
                value={qqSender}
                onChange={(e) => setQqSender(e.target.value)}
              />
            </div>
            <fieldset className="mail-radio-fieldset">
              <legend>{t("skills.qqProtoLegend")}</legend>
              <div className="mail-radio-group">
                <div className="mail-radio-option">
                  <input
                    type="radio"
                    id="qqmail-proto-imap"
                    name="inboundProtocol"
                    value="imap"
                    checked={qqProto === "imap"}
                    onChange={() => setQqProto("imap")}
                  />
                  <label htmlFor="qqmail-proto-imap">
                    {t("skills.qqProtoImapOpt")}
                  </label>
                </div>
                <div className="mail-radio-option">
                  <input
                    type="radio"
                    id="qqmail-proto-pop3"
                    name="inboundProtocol"
                    value="pop3"
                    checked={qqProto === "pop3"}
                    onChange={() => setQqProto("pop3")}
                  />
                  <label htmlFor="qqmail-proto-pop3">POP3（pop.qq.com:995）</label>
                </div>
              </div>
            </fieldset>
          </div>
        </details>

        <div
          id="qqmail-feedback-box"
          className={`mail-feedback-box${
            qqFb.kind === "success"
              ? " is-success"
              : qqFb.kind === "error"
                ? " is-error"
                : ""
          }`}
          role="status"
          aria-live="polite"
          hidden={!qqFb.text}
        >
          <StatusText text={qqFb.text} />
        </div>

        <div className="mail-form-actions">
          <button
            id="qqmail-save-btn"
            type="submit"
            className="settings-blue-pill"
            disabled={mailBusyBtn === "qqmail-save"}
          >
            {mailBusyBtn === "qqmail-save"
              ? t("skills.mailSavingBtn")
              : editingAccount
                ? t("skills.mailSaveEditBtn")
                : t("skills.mailConnectSaveBtn")}
          </button>
          <button
            id="qqmail-test-btn"
            type="button"
            className="settings-pill-btn"
            disabled={mailBusyBtn === "qqmail-test"}
            onClick={() => handleMailTest("qqmail", false)}
          >
            {mailBusyBtn === "qqmail-test" ? t("skills.mailTestingBtn") : t("skills.mailTestConnBtn")}
          </button>
          <button
            id="qqmail-send-test-btn"
            type="button"
            className="settings-pill-btn"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "qqmail-send"}
            onClick={() => handleMailTest("qqmail", true)}
          >
            {mailBusyBtn === "qqmail-send" ? t("skills.mailSendingBtn") : t("skills.mailSendTestBtn")}
          </button>
          <button
            id="qqmail-disconnect-btn"
            type="button"
            className="settings-pill-btn danger-text"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "qqmail-disconnect"}
            onClick={() => handleMailDisconnect("qqmail")}
          >
            {t("skills.mailRemoveAccountBtn")}
          </button>
        </div>
      </form>

      {/* Form 2: Generic Mail */}
      <form
        ref={cmFormRef}
        id="custom-mail-config-form"
        className="mail-config-form"
        action="/api/integrations/mail/accounts"
        method="POST"
        aria-labelledby="custom-mail-form-heading"
        noValidate
        hidden={activeMailProvider !== "custom-mail"}
        onSubmit={(e) => handleMailSave("custom-mail", e)}
      >
        <div className="mail-form-header">
          <div>
            <h3 id="custom-mail-form-heading" className="mail-form-title">
              {editingAccount && activeMailProvider === "custom-mail"
                ? t("skills.cmFormEditTitle", { email: editingAccount.email })
                : t("skills.cmFormNewTitle")}
            </h3>
            <div className="mail-form-meta" id="custom-mail-verified-meta">
              {editingAccount && activeMailProvider === "custom-mail"
                ? t("skills.mailEditingMeta", { email: editingAccount.email })
                : cmPresetApplied
                  ? t("skills.cmPresetAppliedMeta")
                  : t("skills.cmDefaultMeta")}
            </div>
          </div>
          <button
            id="custom-mail-cancel-edit-btn"
            type="button"
            className="settings-pill-btn"
            hidden={detailProviderAccounts.length === 0}
            onClick={() => setState({ mailEditorOpen: false, editingMailAccountId: null })}
          >
            {inline ? t("common.collapse") : t("skills.mailBackToListBtn")}
          </button>
        </div>

        <div className="mail-form-grid-two">
          <div className="mail-field">
            <label htmlFor="custom-mail-email-input">
              {t("skills.cmEmailLabel")} <span aria-hidden="true">*</span>
            </label>
            <span id="custom-mail-email-hint" className="mail-field-hint">
              {t("skills.cmEmailHint")}
            </span>
            <input
              id="custom-mail-email-input"
              name="email"
              type="email"
              className="mail-text-input"
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              required
              aria-invalid="false"
              aria-describedby="custom-mail-email-hint"
              data-error="custom-mail-email-error"
              placeholder="user@example.com"
              value={cmEmail}
              onChange={(e) => {
                const val = e.target.value;
                setCmEmail(val);
                applyCustomPresetForEmail(val, cmProto);
              }}
            />
            <div id="custom-mail-email-error" className="mail-error-msg">
              {t("skills.cmEmailError")}
            </div>
          </div>

          <div className="mail-field">
            <div className="mail-label-row">
              <label htmlFor="custom-mail-password-input">
                {t("skills.cmPasswordLabel")}{" "}
                <span
                  id="custom-mail-secret-req"
                  aria-hidden="true"
                  hidden={Boolean(editingAccount)}
                >
                  *
                </span>
              </label>
              <button
                type="button"
                id="custom-mail-toggle-secret-btn"
                className="mail-secret-toggle"
                aria-pressed={cmShowSecret ? "true" : "false"}
                aria-label={t("skills.cmToggleSecretAria")}
                onClick={() => setCmShowSecret((v) => !v)}
              >
                {cmShowSecret ? t("skills.cmHidePassword") : t("skills.cmShowPassword")}
              </button>
            </div>
            <span id="custom-mail-password-hint" className="mail-field-hint">
              {t("skills.cmPasswordHint")}
            </span>
            <input
              id="custom-mail-password-input"
              name="password"
              type={cmShowSecret ? "text" : "password"}
              className="mail-text-input"
              autoComplete="current-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              required={!editingAccount}
              aria-invalid="false"
              aria-describedby="custom-mail-password-hint"
              data-error="custom-mail-password-error"
              placeholder={
                editingAccount
                  ? t("skills.cmPasswordKeepPh", { mask: editingAccount.maskedSecret || "••••" })
                  : t("skills.cmPasswordNewPh")
              }
              value={cmPassword}
              onChange={(e) => setCmPassword(e.target.value)}
            />
            <div id="custom-mail-password-error" className="mail-error-msg">
              {t("skills.cmPasswordError")}
            </div>
          </div>
        </div>

        <div className="mail-form-grid-two">
          <div className="mail-field">
            <label htmlFor="custom-mail-label-input">{t("skills.mailLabelField")}</label>
            <span id="custom-mail-label-hint" className="mail-field-hint">
              {t("skills.cmLabelHint")}
            </span>
            <input
              id="custom-mail-label-input"
              name="label"
              type="text"
              className="mail-text-input"
              maxLength={32}
              enterKeyHint="next"
              aria-invalid="false"
              aria-describedby="custom-mail-label-hint"
              placeholder={t("skills.cmLabelPh")}
              value={cmLabel}
              onChange={(e) => setCmLabel(e.target.value)}
            />
          </div>

          <div className="mail-field mail-checkbox-col">
            <div className="mail-inline-check">
              <input
                type="checkbox"
                id="custom-mail-default-check"
                name="isDefault"
                checked={cmDefault}
                onChange={(e) => setCmDefault(e.target.checked)}
              />
              <label htmlFor="custom-mail-default-check">{t("skills.mailSetDefaultLabel")}</label>
            </div>
          </div>
        </div>

        <fieldset className="mail-radio-fieldset">
          <legend>{t("skills.cmProtoLegend")}</legend>
          <div className="mail-radio-group">
            <div className="mail-radio-option">
              <input
                type="radio"
                id="custom-proto-pop3"
                name="inboundProtocol"
                value="pop3"
                checked={cmProto === "pop3"}
                onChange={() => {
                  setCmProto("pop3");
                  if (["995", "993", "110", "143", ""].includes(cmInboundPort.trim())) {
                    setCmInboundPort(cmInboundTls ? "995" : "110");
                  }
                  applyCustomPresetForEmail(cmEmail, "pop3");
                }}
              />
              <label htmlFor="custom-proto-pop3">{t("skills.cmProtoPop3Opt")}</label>
            </div>
            <div className="mail-radio-option">
              <input
                type="radio"
                id="custom-proto-imap"
                name="inboundProtocol"
                value="imap"
                checked={cmProto === "imap"}
                onChange={() => {
                  setCmProto("imap");
                  if (["995", "993", "110", "143", ""].includes(cmInboundPort.trim())) {
                    setCmInboundPort(cmInboundTls ? "993" : "143");
                  }
                  applyCustomPresetForEmail(cmEmail, "imap");
                }}
              />
              <label htmlFor="custom-proto-imap">
                {t("skills.cmProtoImapOpt")}
              </label>
            </div>
          </div>
        </fieldset>

        <div className="mail-server-grid">
          <div className="mail-field">
            <label htmlFor="custom-mail-inbound-host">
              {t("skills.cmInboundHostLabel")} <span aria-hidden="true">*</span>
            </label>
            <span id="custom-inbound-host-hint" className="mail-field-hint">
              {t("skills.cmInboundHostHint")}
            </span>
            <input
              id="custom-mail-inbound-host"
              name="inboundHost"
              type="text"
              className="mail-text-input"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              required
              aria-invalid="false"
              aria-describedby="custom-inbound-host-hint"
              data-error="custom-inbound-host-error"
              placeholder={cmProto === "imap" ? "imap.example.com" : "pop.example.com"}
              value={cmInboundHost}
              onChange={(e) => {
                setCmUserEditedHost(true);
                setCmInboundHost(e.target.value);
              }}
            />
            <div id="custom-inbound-host-error" className="mail-error-msg">
              {t("skills.cmInboundHostError")}
            </div>
          </div>

          <div className="mail-field">
            <label htmlFor="custom-mail-inbound-port">
              {t("skills.cmInboundPortLabel")} <span aria-hidden="true">*</span>
            </label>
            <span id="custom-inbound-port-hint" className="mail-field-hint">
              {t("skills.cmInboundPortHint")}
            </span>
            <input
              id="custom-mail-inbound-port"
              name="inboundPort"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{2,5}"
              className="mail-text-input"
              value={cmInboundPort}
              required
              aria-invalid="false"
              aria-describedby="custom-inbound-port-hint"
              data-error="custom-inbound-port-error"
              onChange={(e) => {
                setCmUserEditedHost(true);
                setCmInboundPort(e.target.value);
              }}
            />
            <div id="custom-inbound-port-error" className="mail-error-msg">
              {t("skills.cmInboundPortError")}
            </div>
          </div>

          <div className="mail-field mail-checkbox-col">
            <div className="mail-inline-check">
              <input
                type="checkbox"
                id="custom-mail-inbound-tls"
                name="inboundTls"
                checked={cmInboundTls}
                onChange={(e) => {
                  const useTls = e.target.checked;
                  setCmInboundTls(useTls);
                  if (["995", "993", "110", "143", ""].includes(cmInboundPort.trim())) {
                    setCmInboundPort(
                      cmProto === "imap"
                        ? useTls
                          ? "993"
                          : "143"
                        : useTls
                          ? "995"
                          : "110"
                    );
                  }
                }}
              />
              <label htmlFor="custom-mail-inbound-tls">{t("skills.cmInboundTlsLabel")}</label>
            </div>
          </div>
        </div>

        <fieldset className="mail-radio-fieldset">
          <legend>{t("skills.cmSmtpSecLegend")}</legend>
          <div className="mail-radio-group">
            <div className="mail-radio-option">
              <input
                type="radio"
                id="custom-smtp-ssl"
                name="smtpSecurity"
                value="ssl"
                checked={cmSmtpSec === "ssl"}
                onChange={() => {
                  setCmSmtpSec("ssl");
                  if (["465", "587", "25", ""].includes(cmSmtpPort.trim())) {
                    setCmSmtpPort("465");
                  }
                }}
              />
              <label htmlFor="custom-smtp-ssl">{t("skills.cmSmtpSslOpt")}</label>
            </div>
            <div className="mail-radio-option">
              <input
                type="radio"
                id="custom-smtp-starttls"
                name="smtpSecurity"
                value="starttls"
                checked={cmSmtpSec === "starttls"}
                onChange={() => {
                  setCmSmtpSec("starttls");
                  if (["465", "587", "25", ""].includes(cmSmtpPort.trim())) {
                    setCmSmtpPort("587");
                  }
                }}
              />
              <label htmlFor="custom-smtp-starttls">{t("skills.cmSmtpStarttlsOpt")}</label>
            </div>
            <div className="mail-radio-option">
              <input
                type="radio"
                id="custom-smtp-none"
                name="smtpSecurity"
                value="none"
                checked={cmSmtpSec === "none"}
                onChange={() => {
                  setCmSmtpSec("none");
                  if (["465", "587", "25", ""].includes(cmSmtpPort.trim())) {
                    setCmSmtpPort("25");
                  }
                }}
              />
              <label htmlFor="custom-smtp-none">{t("skills.cmSmtpNoneOpt")}</label>
            </div>
          </div>
        </fieldset>

        <div className="mail-server-grid">
          <div className="mail-field">
            <label htmlFor="custom-mail-smtp-host">
              {t("skills.cmSmtpHostLabel")} <span aria-hidden="true">*</span>
            </label>
            <span id="custom-smtp-host-hint" className="mail-field-hint">
              {t("skills.cmSmtpHostHint")}
            </span>
            <input
              id="custom-mail-smtp-host"
              name="smtpHost"
              type="text"
              className="mail-text-input"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              required
              aria-invalid="false"
              aria-describedby="custom-smtp-host-hint"
              data-error="custom-smtp-host-error"
              placeholder="smtp.example.com"
              value={cmSmtpHost}
              onChange={(e) => {
                setCmUserEditedHost(true);
                setCmSmtpHost(e.target.value);
              }}
            />
            <div id="custom-smtp-host-error" className="mail-error-msg">
              {t("skills.cmSmtpHostError")}
            </div>
          </div>

          <div className="mail-field">
            <label htmlFor="custom-mail-smtp-port">
              {t("skills.cmSmtpPortLabel")} <span aria-hidden="true">*</span>
            </label>
            <span id="custom-smtp-port-hint" className="mail-field-hint">
              {t("skills.cmSmtpPortHint")}
            </span>
            <input
              id="custom-mail-smtp-port"
              name="smtpPort"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{2,5}"
              className="mail-text-input"
              value={cmSmtpPort}
              required
              aria-invalid="false"
              aria-describedby="custom-smtp-port-hint"
              data-error="custom-smtp-port-error"
              onChange={(e) => {
                setCmUserEditedHost(true);
                setCmSmtpPort(e.target.value);
              }}
            />
            <div id="custom-smtp-port-error" className="mail-error-msg">
              {t("skills.cmSmtpPortError")}
            </div>
          </div>
        </div>

        <details className="mail-advanced-details">
          <summary>{t("skills.cmAdvSummary")}</summary>
          <div className="mail-advanced-body">
            <div className="mail-field">
              <label htmlFor="custom-mail-sender-input">{t("skills.cmSenderLabel")}</label>
              <span id="custom-sender-hint" className="mail-field-hint">
                {t("skills.cmSenderHint")}
              </span>
              <input
                id="custom-mail-sender-input"
                name="senderName"
                type="text"
                className="mail-text-input"
                autoComplete="name"
                enterKeyHint="done"
                aria-invalid="false"
                aria-describedby="custom-sender-hint"
                placeholder={t("skills.cmSenderPh")}
                value={cmSender}
                onChange={(e) => setCmSender(e.target.value)}
              />
            </div>
          </div>
        </details>

        <div
          id="custom-mail-feedback-box"
          className={`mail-feedback-box${
            cmFb.kind === "success"
              ? " is-success"
              : cmFb.kind === "error"
                ? " is-error"
                : ""
          }`}
          role="status"
          aria-live="polite"
          hidden={!cmFb.text}
        >
          <StatusText text={cmFb.text} />
        </div>

        <div className="mail-form-actions">
          <button
            id="custom-mail-save-btn"
            type="submit"
            className="settings-blue-pill"
            disabled={mailBusyBtn === "custom-mail-save"}
          >
            {mailBusyBtn === "custom-mail-save"
              ? t("skills.mailSavingBtn")
              : editingAccount
                ? t("skills.mailSaveEditBtn")
                : t("skills.mailConnectSaveBtn")}
          </button>
          <button
            id="custom-mail-test-btn"
            type="button"
            className="settings-pill-btn"
            disabled={mailBusyBtn === "custom-mail-test"}
            onClick={() => handleMailTest("custom-mail", false)}
          >
            {mailBusyBtn === "custom-mail-test" ? t("skills.mailTestingBtn") : t("skills.mailTestConnBtn")}
          </button>
          <button
            id="custom-mail-send-test-btn"
            type="button"
            className="settings-pill-btn"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "custom-mail-send"}
            onClick={() => handleMailTest("custom-mail", true)}
          >
            {mailBusyBtn === "custom-mail-send" ? t("skills.mailSendingBtn") : t("skills.mailSendTestBtn")}
          </button>
          <button
            id="custom-mail-disconnect-btn"
            type="button"
            className="settings-pill-btn danger-text"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "custom-mail-disconnect"}
            onClick={() => handleMailDisconnect("custom-mail")}
          >
            {t("skills.mailRemoveAccountBtn")}
          </button>
        </div>
      </form>
    </div>
  );

  return (
    <div
      id="apps-modal-backdrop"
      className="modal-backdrop"
      hidden={!appsModalOpen}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAppsModal();
      }}
    >
      <div className="apps-modal skills-modal" role="dialog" aria-modal="true" aria-label={t("skills.title")}>
        <button
          id="close-apps-modal-btn"
          type="button"
          className="modal-close-btn"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={(e) => {
            e.stopPropagation();
            closeAppsModal();
          }}
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

        <NetworkStatusBanner
          placement="modal"
          contextHint={t("skills.remoteOfflineReadonlyHint")}
          onlyWhenOffline
        />

        {/* ==================== SUB-VIEW 1: 技能商店 ==================== */}
        <div
          id="skills-store-view"
          className="apps-modal-view skills-view"
          hidden={skillsView !== "store"}
        >
          <div className="skills-header-row">
            <button
              id="mobile-apps-back-btn"
              type="button"
              className="mobile-circle-btn mobile-only"
              title={t("common.back")}
              aria-label={t("common.back")}
              onClick={closeAppsModal}
            >
              <UiIcon name="chevron-left" />
            </button>
            <h2 className="apps-modal-title" id="skills-store-title" tabIndex={-1}>
              {t("skills.title")}
            </h2>
            <button
              id="open-installed-plugins-btn"
              type="button"
              className="skills-added-pill"
              onClick={() => openAppsModal("manage")}
            >
              <span id="skills-added-icons" className="skills-icon-stack" aria-hidden="true">
                {[...installedOffice, ...installedPlatform].slice(0, 4).map((s: any) => (
                  <span key={s.id} className="skills-icon-dot">
                    <SkillIconGraphic skillId={s.id} rawIcon={s.icon} size={12} />
                  </span>
                ))}
              </span>
              <span id="connected-count-label">
                {t("skills.connectedCountLabel", {
                  added: totalAdded,
                  custom: customSkills.length,
                })}
              </span>
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

          <div className="skills-search-row">
            <label className="skills-search-box">
              <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="9" cy="9" r="5.2" stroke="currentColor" strokeWidth="1.6" />
                <path
                  d="M13 13L16.5 16.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <input
                id="skills-search-input"
                type="search"
                className="skills-search-input"
                placeholder={t("skills.searchPlaceholder")}
                aria-label={t("skills.searchPlaceholder")}
                autoComplete="off"
                enterKeyHint="search"
                value={skillSearch}
                onChange={(e) => setState({ skillSearch: e.target.value })}
              />
            </label>
            <button
              id="bot-templates-btn"
              type="button"
              className="bot-templates-pill"
              disabled={remoteAccountOffline}
              title={t("skills.botTemplateTitle")}
              onClick={async () => {
                const tpl = await apiJson("/api/sessions", {
                  method: "POST",
                  body: JSON.stringify({
                    title: t("skills.botTemplateMailTitle"),
                    avatar: { shape: "tablet", color: "blue" },
                    rolePrompt: t("skills.botTemplateMailRolePrompt"),
                  }),
                });
                closeAppsModal();
                upsertLocalSession(tpl);
                await selectSession(tpl.id);
                showToast(t("skills.botTemplateCreatedToast"));
              }}
            >
              <span className="template-blob-dot" aria-hidden="true" />
              <span>{t("skills.botTemplateBtn")}</span>
              <svg
                className="icon-svg inline-ui-icon"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6.2 13.8L13.8 6.2M8.2 6.2H13.8V11.8"
                  stroke="currentColor"
                  strokeWidth="1.65"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <div className="skills-filter-pills" role="group" aria-label={t("skills.categoryAria")}>
            {(
              [
                ["all", t("skills.filterAll")],
                ["office", t("skills.filterOffice")],
                ["platform", t("skills.filterPlatform")],
              ] as const
            ).map(([key, label]) => {
              const active = skillFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`filter-pill${active ? " is-active" : ""}`}
                  data-skill-filter={key}
                  aria-pressed={active ? "true" : "false"}
                  onClick={() => setState({ skillFilter: key })}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <fieldset
            className="remote-offline-fieldset"
            data-remote-offline-guard="skills-store"
            disabled={remoteAccountOffline}
          >
          <div id="skills-store-sections" className="apps-sections-scroll skills-sections">
            {filteredOffice.length === 0 && filteredPlatform.length === 0 ? (
              <div className="skills-empty">
                {t("skills.searchEmpty", { query: searchTrim })}
              </div>
            ) : (
              <>
                {filteredOffice.length > 0 && (
                  <section className="apps-section-block">
                    <div className="apps-section-header">
                      <h4>{t("skills.filterOffice")}</h4>
                    </div>
                    <div className="skills-grid">
                      {filteredOffice.map((s: any) => (
                        <div key={s.id} className="skill-row">
                          <div className="skill-row-icon" aria-hidden="true">
                            <SkillIconGraphic skillId={s.id} rawIcon={s.icon} />
                          </div>
                          <div className="skill-row-info">
                            <div className="skill-row-name">
                              {getLocalizedSkillMeta(s, locale).name}
                            </div>
                            <div className="skill-row-desc">{officeSkillSubtitle(s)}</div>
                          </div>
                          {s.installed ? (
                            <button
                              type="button"
                              className="skill-pill-btn"
                              onClick={() =>
                                openAppsModal("detail", { skillId: s.id, from: "store" })
                              }
                            >
                              {t("skills.configureBtn")}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="skill-pill-btn is-primary"
                              onClick={() => installSkill(s.id)}
                            >
                              {t("skills.addBtn")}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {filteredPlatform.length > 0 && (
                  <section className="apps-section-block">
                    <div className="apps-section-header">
                      <h4>{t("skills.filterPlatform")}</h4>
                    </div>
                    <div className="skills-grid">
                      {filteredPlatform.map((s: any) => {
                        const unsupported = isSkillUnsupported(s);
                        const unavailableToAdd = !s.installed && unsupported;
                        return (
                          <div
                            key={s.id}
                            className={`skill-row${unavailableToAdd ? " is-unsupported" : ""}`}
                            data-skill-id={s.id}
                            data-skill-unsupported={unsupported ? "true" : undefined}
                          >
                            <div className="skill-row-icon" aria-hidden="true">
                              <SkillIconGraphic skillId={s.id} rawIcon={s.icon} />
                            </div>
                            <div className="skill-row-info">
                              <div className="skill-row-name">
                                {getLocalizedSkillMeta(s, locale).name}
                                {renderChannelPendingBadge(s.id, s)}
                              </div>
                              <div className="skill-row-desc">{platformSkillSubtitle(s)}</div>
                            </div>
                            {s.removable ? (
                              s.installed ? (
                                <button
                                  type="button"
                                  className="skill-pill-btn"
                                  onClick={() =>
                                    openAppsModal("detail", { skillId: s.id, from: "store" })
                                  }
                                >
                                  {t("skills.configureBtn")}
                                </button>
                              ) : unsupported ? (
                                <span
                                  className="skill-pill-disabled-wrap"
                                  title={t("skills.macOnlyTooltip")}
                                >
                                  <button
                                    type="button"
                                    className="skill-pill-btn is-unsupported"
                                    disabled
                                    aria-disabled="true"
                                  >
                                    {t("skills.addBtn")}
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="skill-pill-btn is-primary"
                                  onClick={() => installSkill(s.id)}
                                >
                                  {t("skills.addBtn")}
                                </button>
                              )
                            ) : (
                              <span className="skill-builtin-tag">{t("skills.builtinTag")}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>

          <div className="skills-store-footer-note">
            <span>{t("skills.storeFooterNote")}</span>
            <button
              id="store-manage-custom-btn"
              type="button"
              className="skills-store-manage-link"
              onClick={() => openAppsModal("manage")}
            >
              <span>{t("skills.storeManageCustomBtn")}</span>
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
          </fieldset>
        </div>

        {/* ==================== SUB-VIEW 2: 管理技能 ==================== */}
        <div
          id="skills-manage-view"
          className="apps-modal-view skills-view"
          hidden={skillsView !== "manage"}
        >
          <button
            id="back-to-apps-btn"
            type="button"
            className="modal-back-btn"
            title={t("skills.backToStoreAria")}
            aria-label={t("skills.backToStoreAria")}
            onClick={() => openAppsModal("store")}
          >
            <UiIcon name="chevron-left" className="inline-ui-icon" />
            <span>{t("skills.title")}</span>
          </button>

          <div className="apps-header-row skills-subheader">
            <h2 className="apps-modal-title" id="skills-manage-title" tabIndex={-1}>
              {t("skills.backManageLabel")}
            </h2>
            <button
              id="add-custom-skill-btn"
              type="button"
              className="settings-blue-pill custom-skill-create-btn"
              disabled={remoteAccountOffline}
              onClick={() => openCustomEditorFor(null)}
            >
              {t("skills.addCustomBtn")}
            </button>
          </div>

          <fieldset
            className="remote-offline-fieldset"
            data-remote-offline-guard="skills-manage"
            disabled={remoteAccountOffline}
          >
          <div className="apps-sections-scroll skills-sections">
            <section
              id="custom-skills-section"
              className="apps-section-block custom-skills-section"
              aria-labelledby="custom-skills-heading"
            >
              <div className="apps-section-header custom-skills-section-header">
                <div className="custom-skills-title-group">
                  <h4 id="custom-skills-heading">{t("skills.customHeading")}</h4>
                  <span id="custom-skills-count-badge" className="custom-skills-count-badge">
                    {customSkills.length > 0
                      ? t("skills.customEnabledCountBadge", {
                          enabled: enabledCustomCount,
                          total: customSkills.length,
                        })
                      : t("skills.customZeroBadge")}
                  </span>
                </div>
                <label className="custom-skill-search-wrap">
                  <input
                    id="custom-skill-search-input"
                    type="search"
                    className="custom-skill-search-input"
                    placeholder={t("skills.customSearchPh")}
                    aria-label={t("skills.customSearchAria")}
                    autoComplete="off"
                    value={customSkillSearch}
                    onChange={(e) => setState({ customSkillSearch: e.target.value })}
                  />
                </label>
              </div>

              {supportsExperienceReflector && pendingProposals.length > 0 && (
                <div id="experience-proposals-panel" className="exp-proposals-panel">
                  <div className="exp-proposals-heading">{t("skills.expProposalsHeading")}</div>
                  {pendingProposals.map((p: any) => (
                    <div key={p.id} className="exp-proposal-card" data-proposal-id={p.id}>
                      <div className="exp-proposal-header">
                        <span className="exp-proposal-title">{p.title}</span>
                        <span className="exp-proposal-dim-pill">
                          {p.dimension === "invariant"
                            ? t("skills.expProposalsDimInvariant")
                            : t("skills.expProposalsDimDomain")}
                        </span>
                      </div>
                      <div className="exp-proposal-meta">
                        <div>
                          <strong>{t("skills.expProposalsCueLabel")}:</strong> {p.cue}
                        </div>
                        <div>
                          <strong>{t("skills.expProposalsLessonLabel")}:</strong> {p.lesson}
                        </div>
                        <div>
                          <strong>{t("skills.expProposalsEvidenceLabel")}:</strong> {p.evidence}
                        </div>
                      </div>
                      <div className="exp-proposal-actions">
                        <button
                          type="button"
                          className="skill-pill-btn"
                          disabled={resolvingProposalId === p.id}
                          onClick={() => void handleResolveProposal(p, "dismiss")}
                        >
                          {t("skills.expProposalsDismissBtn")}
                        </button>
                        <button
                          type="button"
                          className="skill-pill-btn is-primary"
                          disabled={resolvingProposalId === p.id}
                          onClick={() => void handleResolveProposal(p, "accept")}
                        >
                          {t("skills.expProposalsAcceptBtn")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(!customSkillEditorOpen || !editingCustomSkillId) &&
                renderCustomSkillEditorForm(
                  false,
                  customSkillEditorOpen && !editingCustomSkillId
                )}

              <div id="custom-skills-list" className="custom-skills-list">
                {filteredCustomSkills.length === 0 ? (
                  <div className="skills-empty">
                    {csQuery
                      ? t("skills.customSearchEmpty", { query: customSkillSearch.trim() })
                      : t("skills.customListEmpty")}
                  </div>
                ) : (
                  filteredCustomSkills.map((s: any) => {
                    const isBot = s.createdBy === "bot";
                    const isEditingThisSkill =
                      customSkillEditorOpen && editingCustomSkillId === s.id;
                    return (
                      <div
                        key={s.id}
                        className={`custom-skill-card${s.enabled === false ? " is-disabled" : ""}${isEditingThisSkill ? " is-editing" : ""}`}
                        data-custom-skill-id={s.id}
                      >
                        <div className="custom-skill-card-main">
                          <div className="custom-skill-card-left">
                            <div className="skill-row-icon" aria-hidden="true">
                              <SkillIconGraphic
                                skillId="custom-skill"
                                rawIcon={s.icon || "⚡"}
                              />
                            </div>
                            <div className="skill-row-info">
                              <div className="custom-skill-title-row">
                                <span className="skill-row-name">{s.name}</span>
                                <code className="custom-skill-slug-chip">{s.id}</code>
                                <span
                                  className={`custom-skill-creator-badge ${isBot ? "is-bot" : "is-user"}`}
                                >
                                  <UiIcon
                                    name={isBot ? "bot" : "user"}
                                    className="inline-ui-icon"
                                    size={12}
                                  />
                                  {isBot
                                    ? t("skills.customCreatedByBot", { name: s.createdByBotName || "Bot" })
                                    : t("skills.customCreatedByUser")}
                                </span>
                                <span className="custom-skill-shared-tag">{t("skills.customSharedTag")}</span>
                              </div>
                              <div className="custom-skill-card-desc">
                                {s.description || ""}
                              </div>
                            </div>
                          </div>

                          <div className="custom-skill-card-actions">
                            <label
                              className="ios-switch"
                              title={
                                s.enabled !== false
                                  ? t("skills.customEnabledSwitchTitle")
                                  : t("skills.customDisabledSwitchTitle")
                              }
                            >
                              <input
                                type="checkbox"
                                checked={s.enabled !== false}
                                aria-label={t("skills.customToggleAria", { name: s.name })}
                                onChange={async (e) => {
                                  const checked = e.target.checked;
                                  try {
                                    await apiJson(
                                      `/api/custom-skills/${encodeURIComponent(s.id)}`,
                                      {
                                        method: "PATCH",
                                        body: JSON.stringify({ enabled: checked }),
                                      }
                                    );
                                    await refreshSettingsFromServer();
                                    showToast(
                                      t(checked ? "skills.customEnabledToast" : "skills.customDisabledToast", {
                                        name: s.name,
                                      })
                                    );
                                  } catch (err: any) {
                                    showToast(err?.message || t("skills.statusUpdateFailed"));
                                  }
                                }}
                              />
                              <span className="ios-switch-track" />
                            </label>
                            <button
                              type="button"
                              className={`skill-pill-btn${isEditingThisSkill ? " is-active" : ""}`}
                              aria-expanded={isEditingThisSkill}
                              onClick={() => openCustomEditorFor(s)}
                            >
                              {isEditingThisSkill ? t("common.collapse") : t("settings.viewEditBtn")}
                            </button>
                            <button
                              type="button"
                              className="skill-pill-btn is-danger-text"
                              onClick={() =>
                                setState((prev) => ({
                                  pendingDeleteCustomSkillId:
                                    prev.pendingDeleteCustomSkillId === s.id ? null : s.id,
                                }))
                              }
                            >
                              {t("common.delete")}
                            </button>
                          </div>
                        </div>

                        {isEditingThisSkill && renderCustomSkillEditorForm(true, true)}

                        {pendingDeleteCustomSkillId === s.id && (
                          <div className="skill-remove-confirm">
                            <div className="skill-remove-text">
                              {t("skills.customDeleteInlineText", { name: s.name, id: s.id })}
                            </div>
                            <div className="skill-remove-actions">
                              <button
                                type="button"
                                className="skill-pill-btn"
                                onClick={() => setState({ pendingDeleteCustomSkillId: null })}
                              >
                                {t("common.cancel")}
                              </button>
                              <button
                                type="button"
                                className="skill-pill-btn is-danger"
                                disabled={deletingCsId === s.id}
                                onClick={async () => {
                                  setDeletingCsId(s.id);
                                  try {
                                    await apiJson(
                                      `/api/custom-skills/${encodeURIComponent(s.id)}`,
                                      { method: "DELETE" }
                                    );
                                    setState((prev) => ({
                                      pendingDeleteCustomSkillId: null,
                                      ...(prev.editingCustomSkillId === s.id
                                        ? {
                                            customSkillEditorOpen: false,
                                            editingCustomSkillId: null,
                                          }
                                        : {}),
                                    }));
                                    await refreshSettingsFromServer();
                                    showToast(t("skills.customDeletedToast", { name: s.name }));
                                  } catch (err: any) {
                                    showToast(err?.message || t("skills.deleteFailedFallback"));
                                  } finally {
                                    setDeletingCsId(null);
                                  }
                                }}
                              >
                                {t("common.confirmDelete")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <div className="custom-skills-divider" aria-hidden="true" />

            <section className="apps-section-block" aria-labelledby="skills-added-heading">
              <div className="apps-section-header">
                <h4 id="skills-added-heading">{t("skills.addedSectionHeading")}</h4>
              </div>
              <div id="installed-plugins-grid" className="skills-grid">
                {removableInstalled.map((s: any) => (
                  <div key={s.id} style={{ display: "contents" }}>
                    <div className="skill-row">
                      <div className="skill-row-icon" aria-hidden="true">
                        <SkillIconGraphic skillId={s.id} rawIcon={s.icon} />
                      </div>
                      <div className="skill-row-info">
                        <div className="skill-row-name">
                          {getLocalizedSkillMeta(s, locale).name}
                          {renderChannelPendingBadge(s.id, s)}
                        </div>
                        <div className="skill-row-desc">
                          {s.category === "platform"
                            ? platformSkillSubtitle(s)
                            : officeSkillSubtitle(s)}
                        </div>
                      </div>
                      <div className="skill-row-actions">
                        <span className="skill-added-status">{t("skills.addedStatusLabel")}</span>
                        <button
                          type="button"
                          className="skill-pill-btn"
                          onClick={() =>
                            openAppsModal("detail", { skillId: s.id, from: "manage" })
                          }
                        >
                          {t("skills.configureBtn")}
                        </button>
                        <button
                          type="button"
                          className="skill-pill-btn is-danger-text"
                          onClick={() =>
                            setState((prev) => ({
                              pendingRemoveSkillId:
                                prev.pendingRemoveSkillId === s.id ? null : s.id,
                            }))
                          }
                        >
                          {t("common.remove")}
                        </button>
                      </div>
                    </div>
                    {pendingRemoveSkillId === s.id && (
                      <SkillRemoveConfirmBox
                        skill={s}
                        spanGrid
                        onCancel={() => setState({ pendingRemoveSkillId: null })}
                        onDone={() => setState({ pendingRemoveSkillId: null })}
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
          </fieldset>
        </div>

        {/* ==================== SUB-VIEW 3: SKILL DETAIL ==================== */}
        <div
          id="skill-detail-view"
          className="apps-modal-view skills-view"
          hidden={skillsView !== "detail"}
        >
          <button
            id="skill-detail-back-btn"
            type="button"
            className="modal-back-btn"
            title={t("skills.detailBackBtnTitle", { label: detailBackLabel })}
            aria-label={t("skills.detailBackBtnTitle", { label: detailBackLabel })}
            onClick={() => {
              if (!isMcpSkill && mailEditorOpen && detailProviderAccounts.length > 0) {
                setState({ mailEditorOpen: false, editingMailAccountId: null });
                return;
              }
              openAppsModal(detailFrom === "manage" ? "manage" : "store");
            }}
          >
            <UiIcon name="chevron-left" className="inline-ui-icon" />
            <span id="skill-detail-back-label">{detailBackLabel}</span>
          </button>

          <div className="skill-detail-header">
            <div className="skill-row-icon" id="skill-detail-icon" aria-hidden="true">
              <SkillIconGraphic
                skillId={detailSkill?.id || "qqmail"}
                rawIcon={detailSkill?.icon}
                size={22}
              />
            </div>
            <div className="skill-detail-heading">
              <h2 className="apps-modal-title" id="skill-detail-title" tabIndex={-1}>
                {detailSkill
                  ? getLocalizedSkillMeta(detailSkill, locale).name
                  : t("skills.qqMailFallbackName")}
                {detailSkill?.id && renderChannelPendingBadge(detailSkill.id, detailSkill)}
              </h2>
              <div className="skill-row-desc" id="skill-detail-sub">
                {detailSkill
                  ? isChannelSkillDetail
                    ? channelSkillSubtitle(detailSkill)
                    : isMcpSkill
                      ? platformSkillSubtitle(detailSkill)
                      : officeSkillSubtitle(detailSkill)
                  : ""}
              </div>
            </div>
            <button
              id="skill-detail-remove-btn"
              type="button"
              className="settings-pill-btn danger-text"
              disabled={remoteAccountOffline}
              onClick={() =>
                setState((prev) => ({
                  pendingRemoveSkillId:
                    prev.pendingRemoveSkillId === prev.detailSkillId
                      ? null
                      : prev.detailSkillId,
                }))
              }
            >
              {t("skills.removeSkillBtn")}
            </button>
          </div>

          <fieldset
            className="remote-offline-fieldset"
            data-remote-offline-guard="skills-detail"
            disabled={remoteAccountOffline}
          >
          <div id="skill-detail-remove-slot">
            {detailSkill && pendingRemoveSkillId === detailSkill.id && (
              <SkillRemoveConfirmBox
                skill={detailSkill}
                onCancel={() => setState({ pendingRemoveSkillId: null })}
                onDone={() => {
                  setState({ pendingRemoveSkillId: null });
                  openAppsModal(detailFrom === "manage" ? "manage" : "store");
                }}
              />
            )}
          </div>

          <div className="apps-sections-scroll skills-sections">
            <section
              id="mail-accounts-section"
              className="mail-accounts-section"
              aria-label={t("skills.mailBoundListAria")}
              hidden={isMcpSkill || isChannelSkillDetail || showMailCreateForm}
            >
              <div
                id="mail-list-feedback-box"
                className={`mail-feedback-box${
                  mailListFeedback.kind === "success"
                    ? " is-success"
                    : mailListFeedback.kind === "error"
                      ? " is-error"
                      : ""
                }`}
                role="status"
                aria-live="polite"
                hidden={!mailListFeedback.text}
              >
                <StatusText text={mailListFeedback.text} />
              </div>

              <div
                id="mail-accounts-list"
                className="mail-accounts-list"
                role="list"
                aria-label={t("skills.mailBoundListItemsAria")}
              >
                {detailProviderAccounts.map((acct: any) => {
                  const isEditingThisAcct =
                    mailEditorOpen && editingMailAccountId === acct.id;
                  const stats = acct.inboxStats;
                  const statsPart = stats
                    ? t("skills.mailAccountStatsPart", {
                        count: stats.messages ?? 0,
                        unseenPart:
                          stats.unseen !== undefined
                            ? t("skills.mailAccountUnseenPart", { count: stats.unseen })
                            : "",
                      })
                    : "";
                  return (
                    <div
                      key={acct.id}
                      className={`mail-account-card${isEditingThisAcct ? " is-editing" : ""}`}
                      role="listitem"
                    >
                      <div className="mail-account-head">
                        <div className="mail-account-main">
                          <div className="mail-account-meta">
                            <div className="mail-account-title-row">
                              <span className="mail-account-name">
                                {acct.label ? `${acct.label} · ${acct.email}` : acct.email}
                              </span>
                              {acct.isDefault && (
                                <span className="mail-default-badge">{t("skills.mailDefaultBadge")}</span>
                              )}
                            </div>
                            <div className="mail-account-sub">
                              {(acct.inboundProtocol || "imap").toUpperCase()} + SMTP ·{" "}
                              {acct.inboundHost || ""}
                              {statsPart}
                            </div>
                          </div>
                        </div>
                        <div className="mail-account-actions">
                          {!acct.isDefault && (
                            <button
                              type="button"
                              className="mail-acct-btn"
                              onClick={async () => {
                                try {
                                  const res = await apiJson(
                                    `/api/integrations/mail/accounts/${encodeURIComponent(acct.id)}`,
                                    {
                                      method: "PATCH",
                                      body: JSON.stringify({ isDefault: true }),
                                    }
                                  );
                                  applyMailApiResponse(res);
                                  await refreshSettingsFromServer();
                                  setState({
                                    mailListFeedback: {
                                      text: t("skills.mailSetDefaultFeedback", { email: acct.email }),
                                      kind: "success",
                                    },
                                  });
                                } catch (err: any) {
                                  setState({
                                    mailListFeedback: {
                                      text: t("skills.mailSetDefaultFailed", { error: err.message || "" }),
                                      kind: "error",
                                    },
                                  });
                                }
                              }}
                            >
                              {t("skills.mailSetDefaultBtn")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="mail-acct-btn"
                            disabled={testingAccountId === acct.id}
                            onClick={async () => {
                              setTestingAccountId(acct.id);
                              setState({
                                mailListFeedback: {
                                  text: t("skills.mailTestingAccountFeedback", { email: acct.email }),
                                  kind: "info",
                                },
                              });
                              try {
                                const res = await apiJson(
                                  `/api/integrations/mail/accounts/${encodeURIComponent(acct.id)}/test`,
                                  { method: "POST", body: JSON.stringify({}) }
                                );
                                const unseenInfo =
                                  res.unseen !== undefined
                                    ? t("skills.mailUnseenCommaPart", { count: res.unseen })
                                    : "";
                                setState({
                                  mailListFeedback: {
                                    text: t("skills.mailAccountTestOkFeedback", {
                                      email: acct.email,
                                      ms: res.latencyMs || 0,
                                      count: res.messages ?? 0,
                                      unseenInfo,
                                    }),
                                    kind: "success",
                                  },
                                });
                              } catch (err: any) {
                                setState({
                                  mailListFeedback: {
                                    text: t("skills.mailAccountTestFailFeedback", {
                                      email: acct.email,
                                      error: err.message || "",
                                    }),
                                    kind: "error",
                                  },
                                });
                              } finally {
                                setTestingAccountId(null);
                              }
                            }}
                          >
                            {testingAccountId === acct.id ? t("common.testing") : t("skills.testShortBtn")}
                          </button>
                          <button
                            type="button"
                            className={`mail-acct-btn${isEditingThisAcct ? " is-active" : ""}`}
                            aria-expanded={isEditingThisAcct}
                            onClick={() => startEditingMailAccount(acct)}
                          >
                            {isEditingThisAcct ? t("common.collapse") : t("common.edit")}
                          </button>
                        </div>
                      </div>
                      {isEditingThisAcct && renderMailFormEditorShell(true, true)}
                    </div>
                  );
                })}
              </div>

              <button
                id="start-new-mail-btn"
                type="button"
                className="skills-add-account-btn"
                onClick={() => {
                  const target =
                    detailSkillId === "custom-mail" ? "custom-mail" : "qqmail";
                  resetMailFormsForCreate(target);
                  setState({ mailEditorOpen: true });
                }}
              >
                {t("skills.mailAddBtn")}
              </button>
            </section>

            {(!mailEditorOpen || !editingMailAccountId) &&
              renderMailFormEditorShell(false, showMailCreateForm)}

            {/* Chat Channel Skill Config Panel (Feishu / Telegram Multi-Bot + Pairing) (#13) */}
            {isChannelSkillDetail &&
              (() => {
                const originFallback =
                  typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3230";
                const resolvedOrigin = activeBaseUrl || originFallback;

                const getChannelStatusMeta = (rt: any) => {
                  if (rt?.status === "connected") {
                    return { label: t("channel.statusConnected"), cls: " is-online" };
                  }
                  if (rt?.status === "connecting") {
                    return { label: t("channel.statusConnecting"), cls: "" };
                  }
                  if (rt?.status === "webhook_ready") {
                    return { label: t("channel.statusReady"), cls: " is-online" };
                  }
                  if (rt?.status === "error") {
                    return { label: rt?.lastError || t("common.offline"), cls: " is-offline" };
                  }
                  return { label: t("channel.statusStopped"), cls: "" };
                };

                const resolveTargetBotTitle = (sessionId?: string | null) => {
                  const sid = String(sessionId || "").trim();
                  if (!sid) return t("channel.targetBotAdmin");
                  const found = (sessions || []).find((s: any) => s && s.id === sid);
                  return found?.title || sid;
                };

                const applyChannelApiResult = (res: any) => {
                  if (res?.settings) {
                    setState((prev) => ({ settings: { ...prev.settings, ...res.settings } }));
                  }
                  if (res?.channels?.pairings) {
                    setChPairings({
                      pending: Array.isArray(res.channels.pairings.pending)
                        ? res.channels.pairings.pending
                        : [],
                      approved: Array.isArray(res.channels.pairings.approved)
                        ? res.channels.pairings.approved
                        : [],
                    });
                  }
                };

                const startEditingChannelAccount = (acct: any) => {
                  if (!detailSkillId) return;
                  if (channelEditorOpen && editingChannelAcctId === acct.id) {
                    setChannelEditorOpen(false);
                    setEditingChannelAcctId(null);
                    setChConfirmDeleteId(null);
                    return;
                  }
                  setEditingChannelAcctId(acct.id);
                  setChannelEditorOpen(true);
                  setChConfirmDeleteId(null);
                  loadChannelFormFromAccount(acct, detailSkillId);
                  setChFeedback({ text: "", kind: "info" });
                };

                const startCreateChannelAccount = () => {
                  if (!detailSkillId) return;
                  setEditingChannelAcctId(null);
                  setChannelEditorOpen(true);
                  setChConfirmDeleteId(null);
                  loadChannelFormFromAccount(null, detailSkillId);
                  setChFeedback({ text: "", kind: "info" });
                };

                const runChannelTest = async (explicitAcct?: any) => {
                  if (!detailSkillId) return;
                  if (explicitAcct) {
                    setChTestingAccountId(explicitAcct.id);
                    setChListFeedback({ text: t("common.testing"), kind: "info" });
                    try {
                      const url = supportsMultiBotChannels
                        ? `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/accounts/${encodeURIComponent(explicitAcct.id)}/test`
                        : `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/test`;
                      const res = await apiJson(url, {
                        method: "POST",
                        body: JSON.stringify({}),
                      });
                      const nameLabel =
                        explicitAcct?.config?.label || res?.botName || detailSkillId;
                      setChListFeedback({
                        text: res?.warning
                          ? `⚠️ ${nameLabel} · ${res.warning}`
                          : `✓ ${nameLabel}`,
                        kind: "success",
                      });
                    } catch (err: any) {
                      setChListFeedback({
                        text: `❌ ${err?.message || "Test failed"}`,
                        kind: "error",
                      });
                    } finally {
                      setChTestingAccountId(null);
                    }
                    return;
                  }

                  setChBusy("test");
                  setChFeedback({ text: t("common.testing"), kind: "info" });
                  try {
                    const cleanProxy =
                      chTgProxy.trim() && !chTgProxy.includes("••••")
                        ? chTgProxy.trim()
                        : undefined;
                    const testBody =
                      detailSkillId === "telegram-bot"
                        ? {
                            isNew: !editingChannelAcctId,
                            botToken: chTgToken.trim() || undefined,
                            proxy: cleanProxy,
                            ...(chClearTgProxy && !cleanProxy ? { clearProxy: true } : {}),
                          }
                        : {
                            isNew: !editingChannelAcctId,
                            domain: chFsDomain,
                            connectionMode: chMode,
                            appId: chFsAppId.trim() || undefined,
                            appSecret: chFsAppSecret.trim() || undefined,
                          };
                    const url =
                      editingChannelAcctId && supportsMultiBotChannels
                        ? `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/accounts/${encodeURIComponent(editingChannelAcctId)}/test`
                        : `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/test`;
                    const res = await apiJson(url, {
                      method: "POST",
                      body: JSON.stringify(testBody),
                    });
                    setChFeedback({
                      text: res?.warning
                        ? `⚠️ ${res.botName || detailSkillId} · ${res.warning}`
                        : `✓ ${res?.botName || detailSkillId}`,
                      kind: "success",
                    });
                  } catch (err: any) {
                    setChFeedback({
                      text: `❌ ${err?.message || "Test failed"}`,
                      kind: "error",
                    });
                  } finally {
                    setChBusy(null);
                  }
                };

                const runChannelFormSubmit = async (e: FormEvent) => {
                  e.preventDefault();
                  if (!detailSkillId) return;
                  setChBusy("save");
                  setChFeedback({ text: "", kind: "info" });
                  try {
                    const cleanProxy =
                      chTgProxy.trim() && !chTgProxy.includes("••••")
                        ? chTgProxy.trim()
                        : undefined;
                    const basePayload = {
                      label: chLabel.trim() || undefined,
                      enabled: chEnabled,
                      connectionMode: chMode,
                      defaultSessionId: chTargetBotId,
                      requirePairing: chRequirePairing,
                      allowedSenderIds: chWhitelist,
                      approvalMode: chApprovalMode,
                    };
                    const payload =
                      detailSkillId === "telegram-bot"
                        ? {
                            ...basePayload,
                            botToken: chTgToken.trim() || undefined,
                            proxy: cleanProxy,
                            ...(chClearTgProxy && !cleanProxy ? { clearProxy: true } : {}),
                            webhookSecret: chTgSecret.trim() || undefined,
                            ...(chClearTgSecret && !chTgSecret.trim()
                              ? { clearWebhookSecret: true }
                              : {}),
                          }
                        : {
                            ...basePayload,
                            domain: chFsDomain,
                            appId: chFsAppId.trim(),
                            appSecret: chFsAppSecret.trim() || undefined,
                            verificationToken: chFsVerifyToken.trim() || undefined,
                            encryptKey: chFsEncryptKey.trim() || undefined,
                            ...(chClearFsVerify && !chFsVerifyToken.trim()
                              ? { clearVerificationToken: true }
                              : {}),
                            ...(chClearFsEncrypt && !chFsEncryptKey.trim()
                              ? { clearEncryptKey: true }
                              : {}),
                          };

                    const isCreating = supportsMultiBotChannels && !editingChannelAcctId;
                    const url = supportsMultiBotChannels
                      ? editingChannelAcctId
                        ? `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/accounts/${encodeURIComponent(editingChannelAcctId)}`
                        : `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/accounts`
                      : `/api/integrations/channels/${encodeURIComponent(detailSkillId)}`;
                    const method =
                      supportsMultiBotChannels && editingChannelAcctId ? "PATCH" : "POST";

                    const res = await apiJson(url, {
                      method,
                      body: JSON.stringify(payload),
                    });
                    applyChannelApiResult(res);
                    setChTgToken("");
                    setChTgSecret("");
                    setChClearTgSecret(false);
                    setChClearTgProxy(false);
                    setChFsAppSecret("");
                    setChFsVerifyToken("");
                    setChFsEncryptKey("");
                    setChClearFsVerify(false);
                    setChClearFsEncrypt(false);

                    const savedAccounts: any[] = Array.isArray(res?.channels?.[detailSkillId]?.accounts)
                      ? res.channels[detailSkillId].accounts
                      : [];
                    const savedTargetId = editingChannelAcctId || res?.accountId;
                    const savedAcct = savedTargetId
                      ? savedAccounts.find((a) => a.id === savedTargetId)
                      : null;
                    if (savedAcct?.config?.proxy !== undefined) {
                      setChTgProxy(String(savedAcct.config.proxy || ""));
                    } else if (chClearTgProxy && !cleanProxy) {
                      setChTgProxy("");
                    }

                    if (isCreating) {
                      setChannelEditorOpen(false);
                      setEditingChannelAcctId(null);
                      setChListFeedback({ text: `✓ ${t("channel.savedToast")}`, kind: "success" });
                    } else {
                      setChFeedback({ text: `✓ ${t("channel.savedToast")}`, kind: "success" });
                    }
                    showToast(t("channel.savedToast"));
                  } catch (err: any) {
                    setChFeedback({
                      text: `❌ ${err?.message || "Save failed"}`,
                      kind: "error",
                    });
                  } finally {
                    setChBusy(null);
                  }
                };

                const runChannelDelete = async (accountId: string) => {
                  if (!detailSkillId) return;
                  setChBusy("delete");
                  setChFeedback({ text: "", kind: "info" });
                  try {
                    const res = await apiJson(
                      `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/accounts/${encodeURIComponent(accountId)}`,
                      { method: "DELETE" }
                    );
                    applyChannelApiResult(res);
                    setEditingChannelAcctId(null);
                    setChannelEditorOpen(false);
                    setChConfirmDeleteId(null);
                    setChListFeedback({ text: `✓ ${t("channel.deletedBotFeedback")}`, kind: "success" });
                  } catch (err: any) {
                    setChFeedback({
                      text: `❌ ${err?.message || "Delete failed"}`,
                      kind: "error",
                    });
                  } finally {
                    setChBusy(null);
                  }
                };

                const runPairingAction = async (
                  busyKey: string,
                  url: string,
                  method: "POST" | "DELETE",
                  body: Record<string, any>,
                  successText: string
                ) => {
                  setChPairingsBusyKey(busyKey);
                  setChListFeedback({ text: "", kind: "info" });
                  try {
                    const res = await apiJson(url, {
                      method,
                      body: JSON.stringify(body),
                    });
                    applyChannelApiResult(res);
                    if (!res?.channels?.pairings) {
                      await refreshChannelPairingsFromServer();
                    }
                    setChListFeedback({ text: `✓ ${successText}`, kind: "success" });
                    showToast(successText);
                  } catch (err: any) {
                    setChListFeedback({
                      text: `❌ ${err?.message || "Operation failed"}`,
                      kind: "error",
                    });
                  } finally {
                    setChPairingsBusyKey(null);
                  }
                };

                const renderChannelFormEditorShell = (isInline: boolean, visible: boolean) => {
                  if (!visible) return null;
                  const editingStatus = getChannelStatusMeta(channelRt);
                  const editBotDisplay =
                    chLabel ||
                    channelRt.botName ||
                    chFsAppId ||
                    (detailSkillId === "feishu-bot"
                      ? t("channel.feishuBotFallback")
                      : "Telegram Bot");
                  const webhookPath =
                    chEditorTarget?.webhookPath ||
                    (detailSkillId === "telegram-bot"
                      ? "/api/channels/telegram/webhook"
                      : "/api/channels/feishu/webhook");

                  return (
                    <div className="mail-form-editor-shell" style={isInline ? { marginTop: "10px" } : undefined}>
                      <div className="mail-editor-mode-bar">
                        <span className="mail-editor-mode-label">
                          {editingChannelAcctId
                            ? t("channel.editBot", { name: editBotDisplay })
                            : t("channel.newBotHeader")}
                        </span>
                        {channelAccounts.length > 0 && (
                          <button
                            type="button"
                            className="mail-acct-btn"
                            onClick={() => {
                              setChannelEditorOpen(false);
                              setEditingChannelAcctId(null);
                              setChConfirmDeleteId(null);
                            }}
                          >
                            {t("channel.cancelEdit")}
                          </button>
                        )}
                      </div>

                      {editingChannelAcctId && (
                        <div className="mcp-status-card" style={{ marginBottom: "8px" }}>
                          <div className="mcp-status-head">
                            <span className="mcp-status-title">{editBotDisplay}</span>
                            <span
                              id="channel-status-badge"
                              className={`mcp-status-badge${editingStatus.cls}`}
                            >
                              {editingStatus.label}
                            </span>
                          </div>
                          {channelRt.botName && (
                            <div className="mcp-status-detail">Bot: {channelRt.botName}</div>
                          )}
                          {channelRt.lastEventAt && (
                            <div id="channel-last-event" className="mcp-status-detail">
                              {t("channel.lastEventAt", {
                                time: new Date(channelRt.lastEventAt).toLocaleString(),
                              })}
                            </div>
                          )}
                          {channelRt.lastSendError && (
                            <div
                              id="channel-send-error-banner"
                              className="mail-feedback-box is-error channel-runtime-alert"
                              role="alert"
                            >
                              <div>
                                <strong>{t("channel.sendErrorTitle")}</strong>
                                <div>{channelRt.lastSendError}</div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <form
                        id="channel-config-form"
                        className="mail-config-form"
                        onSubmit={runChannelFormSubmit}
                      >
                        <div className="mail-field">
                          <label htmlFor="channel-label-input">{t("channel.botLabel")}</label>
                          <input
                            id="channel-label-input"
                            type="text"
                            className="inline-text-input"
                            placeholder={t("channel.botLabelPlaceholder")}
                            value={chLabel}
                            onChange={(e) => setChLabel(e.target.value)}
                          />
                        </div>

                        <label
                          className="mail-checkbox-row"
                          style={{ display: "flex", alignItems: "center", gap: "8px" }}
                        >
                          <input
                            id="channel-enabled-toggle"
                            type="checkbox"
                            checked={chEnabled}
                            onChange={(e) => setChEnabled(e.target.checked)}
                          />
                          <span>{t("channel.enabled")}</span>
                        </label>

                        <div className="mail-field">
                          <label htmlFor="channel-mode-select">{t("channel.connectionMode")}</label>
                          <select
                            id="channel-mode-select"
                            className="inline-text-input"
                            value={chMode}
                            onChange={(e) => setChMode(e.target.value)}
                          >
                            {detailSkillId === "telegram-bot" ? (
                              <>
                                <option value="polling">{t("channel.modePolling")}</option>
                                <option value="webhook">{t("channel.modeWebhook")}</option>
                              </>
                            ) : (
                              <>
                                <option value="websocket">{t("channel.modeWebsocket")}</option>
                                <option value="webhook">{t("channel.modeWebhook")}</option>
                              </>
                            )}
                          </select>
                          {chMode === "webhook" && (
                            <span
                              className="mail-field-hint"
                              style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                            >
                              {t("channel.webhookUrlHint", {
                                url: `${resolvedOrigin}${webhookPath}`,
                              })}
                            </span>
                          )}
                        </div>

                        {detailSkillId === "telegram-bot" ? (
                          <>
                            <div className="mail-field">
                              <label htmlFor="channel-tg-token-input">
                                {t("channel.telegramToken")}
                              </label>
                              <input
                                id="channel-tg-token-input"
                                type="password"
                                className="inline-text-input"
                                autoComplete="off"
                                placeholder={
                                  channelCfg.hasBotToken
                                    ? t("channel.secretSavedPlaceholder")
                                    : "123456:ABC-DEF..."
                                }
                                value={chTgToken}
                                onChange={(e) => setChTgToken(e.target.value)}
                              />
                            </div>
                            {supportsMultiBotChannels && (
                              <div className="mail-field">
                                <label htmlFor="channel-tg-proxy-input">
                                  {t("channel.telegramProxy")}
                                </label>
                                <input
                                  id="channel-tg-proxy-input"
                                  type="text"
                                  className="inline-text-input"
                                  autoComplete="off"
                                  placeholder={t("channel.telegramProxyPlaceholder")}
                                  value={chTgProxy}
                                  onChange={(e) => {
                                    setChTgProxy(e.target.value);
                                    if (e.target.value) setChClearTgProxy(false);
                                  }}
                                />
                                {channelCfg.hasProxy && (
                                  <label
                                    className="mail-checkbox-row"
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "6px",
                                      marginTop: "4px",
                                      fontSize: "12px",
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={chClearTgProxy}
                                      onChange={(e) => setChClearTgProxy(e.target.checked)}
                                    />
                                    <span>{t("channel.proxyClearHint")}</span>
                                  </label>
                                )}
                              </div>
                            )}
                            {chMode === "webhook" && (
                              <div className="mail-field">
                                <label htmlFor="channel-tg-secret-input">
                                  {t("channel.telegramSecret")}
                                </label>
                                <input
                                  id="channel-tg-secret-input"
                                  type="password"
                                  className="inline-text-input"
                                  autoComplete="off"
                                  placeholder={
                                    channelCfg.hasWebhookSecret && !chClearTgSecret
                                      ? t("channel.secretSavedPlaceholder")
                                      : "X-Telegram-Bot-Api-Secret-Token"
                                  }
                                  value={chTgSecret}
                                  onChange={(e) => {
                                    setChTgSecret(e.target.value);
                                    if (e.target.value) setChClearTgSecret(false);
                                  }}
                                />
                                {channelCfg.hasWebhookSecret && !chEnabled && (
                                  <label
                                    className="mail-checkbox-row"
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "6px",
                                      marginTop: "4px",
                                      fontSize: "12px",
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={chClearTgSecret}
                                      onChange={(e) => setChClearTgSecret(e.target.checked)}
                                    />
                                    <span>{t("channel.clearWebhookSecretHint")}</span>
                                  </label>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="mail-form-grid-two">
                              <div className="mail-field">
                                <label htmlFor="channel-fs-domain-select">
                                  {t("channel.feishuDomain")}
                                </label>
                                <select
                                  id="channel-fs-domain-select"
                                  className="inline-text-input"
                                  value={chFsDomain}
                                  onChange={(e) => setChFsDomain(e.target.value)}
                                >
                                  <option value="feishu">{t("channel.feishuDomainChinaOpt")}</option>
                                  <option value="lark">Lark International (open.larksuite.com)</option>
                                </select>
                              </div>
                              <div className="mail-field">
                                <label htmlFor="channel-fs-appid-input">
                                  {t("channel.feishuAppId")}
                                </label>
                                <input
                                  id="channel-fs-appid-input"
                                  type="text"
                                  className="inline-text-input"
                                  placeholder="cli_a1b2c3d4..."
                                  value={chFsAppId}
                                  onChange={(e) => setChFsAppId(e.target.value)}
                                />
                              </div>
                            </div>
                            <div className="mail-field">
                              <label htmlFor="channel-fs-secret-input">
                                {t("channel.feishuAppSecret")}
                              </label>
                              <input
                                id="channel-fs-secret-input"
                                type="password"
                                className="inline-text-input"
                                autoComplete="off"
                                placeholder={
                                  channelCfg.hasAppSecret
                                    ? t("channel.secretSavedPlaceholder")
                                    : "App Secret"
                                }
                                value={chFsAppSecret}
                                onChange={(e) => setChFsAppSecret(e.target.value)}
                              />
                            </div>
                            {chMode === "webhook" && (
                              <div className="mail-form-grid-two">
                                <div className="mail-field">
                                  <label htmlFor="channel-fs-verify-input">
                                    {t("channel.feishuVerifyToken")}
                                  </label>
                                  <input
                                    id="channel-fs-verify-input"
                                    type="password"
                                    className="inline-text-input"
                                    autoComplete="off"
                                    placeholder={
                                      channelCfg.hasVerificationToken && !chClearFsVerify
                                        ? t("channel.secretSavedPlaceholder")
                                        : "Verification Token"
                                    }
                                    value={chFsVerifyToken}
                                    onChange={(e) => {
                                      setChFsVerifyToken(e.target.value);
                                      if (e.target.value) setChClearFsVerify(false);
                                    }}
                                  />
                                  {channelCfg.hasVerificationToken && !chEnabled && (
                                    <label
                                      className="mail-checkbox-row"
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        marginTop: "4px",
                                        fontSize: "12px",
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={chClearFsVerify}
                                        onChange={(e) => setChClearFsVerify(e.target.checked)}
                                      />
                                      <span>{t("channel.clearVerifyTokenHint")}</span>
                                    </label>
                                  )}
                                </div>
                                <div className="mail-field">
                                  <label htmlFor="channel-fs-encrypt-input">
                                    {t("channel.feishuEncryptKey")}
                                  </label>
                                  <input
                                    id="channel-fs-encrypt-input"
                                    type="password"
                                    className="inline-text-input"
                                    autoComplete="off"
                                    placeholder={
                                      channelCfg.hasEncryptKey && !chClearFsEncrypt
                                        ? t("channel.secretSavedPlaceholder")
                                        : "Encrypt Key"
                                    }
                                    value={chFsEncryptKey}
                                    onChange={(e) => {
                                      setChFsEncryptKey(e.target.value);
                                      if (e.target.value) setChClearFsEncrypt(false);
                                    }}
                                  />
                                  {channelCfg.hasEncryptKey && (
                                    <label
                                      className="mail-checkbox-row"
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        marginTop: "4px",
                                        fontSize: "12px",
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={chClearFsEncrypt}
                                        onChange={(e) => setChClearFsEncrypt(e.target.checked)}
                                      />
                                      <span>{t("channel.clearEncryptKeyHint")}</span>
                                    </label>
                                  )}
                                </div>
                              </div>
                            )}
                          </>
                        )}

                        <div className="mail-field">
                          <label htmlFor="channel-default-session-select">
                            {t("channel.targetBot")}
                          </label>
                          <select
                            id="channel-default-session-select"
                            className="inline-text-input"
                            value={chTargetBotId}
                            onChange={(e) => setChTargetBotId(e.target.value)}
                          >
                            <option value="">{t("channel.targetBotAdmin")}</option>
                            {(sessions || [])
                              .filter((s: any) => s && s.id)
                              .map((s: any) => (
                                <option key={s.id} value={s.id}>
                                  {s.title || s.id}
                                </option>
                              ))}
                          </select>
                        </div>

                        {supportsMultiBotChannels && (
                          <div className="mail-field">
                            <label
                              className="mail-checkbox-row"
                              style={{ display: "flex", alignItems: "center", gap: "8px" }}
                            >
                              <input
                                id="channel-require-pairing-toggle"
                                type="checkbox"
                                checked={chRequirePairing}
                                onChange={(e) => setChRequirePairing(e.target.checked)}
                              />
                              <span>{t("channel.requirePairing")}</span>
                            </label>
                            <span className="mail-field-hint">
                              {t("channel.requirePairingHint")}
                            </span>
                          </div>
                        )}

                        <div className="mail-field">
                          <label htmlFor="channel-allowed-senders-input">
                            {chRequirePairing && supportsMultiBotChannels
                              ? t("channel.whitelistOptionalLabel")
                              : t("channel.whitelistLabel")}
                          </label>
                          <input
                            id="channel-allowed-senders-input"
                            type="text"
                            className="inline-text-input"
                            placeholder={t("channel.whitelistPlaceholder")}
                            value={chWhitelist}
                            onChange={(e) => setChWhitelist(e.target.value)}
                          />
                          {(() => {
                            const rejectedSender = channelRt.lastRejectedSender;
                            const savedWhitelist: string[] = Array.isArray(
                              channelCfg.allowedSenderIds
                            )
                              ? channelCfg.allowedSenderIds
                              : [];
                            const showQuickAdd = Boolean(
                              rejectedSender?.senderId &&
                                !savedWhitelist.includes(rejectedSender.senderId)
                            );
                            if (showQuickAdd && rejectedSender) {
                              return (
                                <div
                                  id="channel-rejected-sender-banner"
                                  className="channel-rejected-banner"
                                  role="status"
                                >
                                  <span>
                                    {t("channel.rejectedSenderHint", {
                                      senderId: rejectedSender.senderId,
                                      chatId: rejectedSender.chatId,
                                    })}
                                  </span>
                                  <button
                                    id="channel-quick-whitelist-btn"
                                    type="button"
                                    className="settings-pill-btn"
                                    disabled={Boolean(chBusy)}
                                    onClick={async () => {
                                      if (!detailSkillId) return;
                                      const existingTokens = chWhitelist
                                        .split(/[\s,;，；]+/)
                                        .map((s) => s.trim())
                                        .filter(Boolean);
                                      const merged = Array.from(
                                        new Set([...existingTokens, rejectedSender.senderId])
                                      );
                                      setChWhitelist(merged.join(", "));
                                      setChBusy("save");
                                      setChFeedback({ text: "", kind: "info" });
                                      try {
                                        const url =
                                          editingChannelAcctId && supportsMultiBotChannels
                                            ? `/api/integrations/channels/${encodeURIComponent(detailSkillId)}/accounts/${encodeURIComponent(editingChannelAcctId)}`
                                            : `/api/integrations/channels/${encodeURIComponent(detailSkillId)}`;
                                        const method =
                                          editingChannelAcctId && supportsMultiBotChannels
                                            ? "PATCH"
                                            : "POST";
                                        const res = await apiJson(url, {
                                          method,
                                          body: JSON.stringify({ allowedSenderIds: merged }),
                                        });
                                        applyChannelApiResult(res);
                                        setChFeedback({
                                          text: `✓ ${t("channel.savedToast")}`,
                                          kind: "success",
                                        });
                                        showToast(t("channel.savedToast"));
                                      } catch (err: any) {
                                        setChFeedback({
                                          text: `❌ ${err?.message || "Save failed"}`,
                                          kind: "error",
                                        });
                                      } finally {
                                        setChBusy(null);
                                      }
                                    }}
                                  >
                                    {t("channel.quickAddWhitelist")}
                                  </button>
                                </div>
                              );
                            }
                            if (
                              chEnabled &&
                              !chRequirePairing &&
                              !chWhitelist.trim() &&
                              !rejectedSender
                            ) {
                              return (
                                <div className="mcp-status-detail">
                                  {t("channel.whitelistEmptyWarn")}
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>

                        <div className="mail-field">
                          <label htmlFor="channel-approval-mode-select">
                            {t("channel.approvalMode")}
                          </label>
                          <select
                            id="channel-approval-mode-select"
                            className="inline-text-input"
                            value={chApprovalMode}
                            onChange={(e) => setChApprovalMode(e.target.value)}
                          >
                            <option value="channel_and_app">{t("channel.approvalBoth")}</option>
                            <option value="app_only">{t("channel.approvalAppOnly")}</option>
                          </select>
                        </div>

                        <div
                          id="channel-config-feedback"
                          className={`mail-feedback-box${
                            chFeedback.kind === "success"
                              ? " is-success"
                              : chFeedback.kind === "error"
                                ? " is-error"
                                : ""
                          }`}
                          role="status"
                          aria-live="polite"
                          hidden={!chFeedback.text}
                        >
                          <StatusText text={chFeedback.text} />
                        </div>

                        <div className="mail-form-actions">
                          {editingChannelAcctId &&
                            supportsMultiBotChannels &&
                            (chConfirmDeleteId === editingChannelAcctId ? (
                              <span style={{ display: "inline-flex", gap: "6px", marginRight: "auto" }}>
                                <button
                                  id="channel-delete-confirm-btn"
                                  type="button"
                                  className="mail-acct-btn is-danger"
                                  disabled={Boolean(chBusy)}
                                  onClick={() => runChannelDelete(editingChannelAcctId)}
                                >
                                  {t("channel.deleteBotConfirm")}
                                </button>
                                <button
                                  id="channel-delete-cancel-btn"
                                  type="button"
                                  className="mail-acct-btn"
                                  disabled={Boolean(chBusy)}
                                  onClick={() => setChConfirmDeleteId(null)}
                                >
                                  {t("channel.cancelDelete")}
                                </button>
                              </span>
                            ) : (
                              <button
                                id="channel-delete-btn"
                                type="button"
                                className="mail-acct-btn is-danger"
                                style={{ marginRight: "auto" }}
                                disabled={Boolean(chBusy)}
                                onClick={() => setChConfirmDeleteId(editingChannelAcctId)}
                              >
                                {t("channel.deleteBotBtn")}
                              </button>
                            ))}

                          <button
                            id="channel-test-btn"
                            type="button"
                            className="settings-pill-btn"
                            disabled={Boolean(chBusy)}
                            onClick={() => runChannelTest()}
                          >
                            {chBusy === "test" ? t("common.testing") : t("common.testConnection")}
                          </button>
                          <button
                            id="channel-save-btn"
                            type="submit"
                            className="settings-blue-pill"
                            disabled={Boolean(chBusy)}
                          >
                            {chBusy === "save" ? t("common.saving") : t("common.save")}
                          </button>
                        </div>
                      </form>
                    </div>
                  );
                };

                const channelPending = (livePairings?.pending || []).filter(
                  (p: any) => p?.channel === detailSkillId
                );
                const channelApproved = (livePairings?.approved || []).filter(
                  (a: any) => a?.channel === detailSkillId
                );
                const showCreateForm = channelEditorOpen || channelAccounts.length === 0;

                return (
                  <section
                    id="channel-skill-config-panel"
                    className="mcp-skill-config-panel"
                    aria-label={
                      detailSkill
                        ? getLocalizedSkillMeta(detailSkill, locale).name
                        : t("channel.panelAriaFallback")
                    }
                  >
                    <div
                      id="channel-list-feedback"
                      className={`mail-feedback-box${
                        chListFeedback.kind === "success"
                          ? " is-success"
                          : chListFeedback.kind === "error"
                            ? " is-error"
                            : ""
                      }`}
                      role="status"
                      aria-live="polite"
                      hidden={!chListFeedback.text}
                    >
                      <StatusText text={chListFeedback.text} />
                    </div>

                    {channelAccounts.length > 0 && (
                      <section className="mail-accounts-section" aria-label={t("channel.accountsListAria")}>
                        <div className="mail-accounts-list">
                          {channelAccounts.map((acct: any) => {
                            const cfg = acct?.config || {};
                            const rt = acct?.runtime || {};
                            const st = getChannelStatusMeta(rt);
                            const isEditingThis =
                              channelEditorOpen && editingChannelAcctId === acct.id;
                            const acctTitle =
                              cfg.label ||
                              rt.botName ||
                              cfg.appId ||
                              (detailSkillId === "feishu-bot"
                                ? t("channel.feishuBotFallback")
                                : "Telegram Bot");
                            const targetLabel = resolveTargetBotTitle(cfg.defaultSessionId);
                            const whitelistCount = Array.isArray(cfg.allowedSenderIds)
                              ? cfg.allowedSenderIds.length
                              : 0;
                            const approvedCount = Array.isArray(cfg.approvedChats)
                              ? cfg.approvedChats.length
                              : 0;
                            return (
                              <div
                                key={acct.id}
                                className={`mail-account-card${isEditingThis ? " is-editing" : ""}`}
                              >
                                <div className="mail-account-head">
                                  <div className="mail-account-main">
                                    <div className="mail-account-meta">
                                      <div className="mail-account-title-row">
                                        <span className="mail-account-name">{acctTitle}</span>
                                        <span className={`mcp-status-badge${st.cls}`}>
                                          {st.label}
                                        </span>
                                      </div>
                                      <div className="mail-account-sub">
                                        {cfg.connectionMode ||
                                          (detailSkillId === "feishu-bot" ? "websocket" : "polling")}
                                        {t("channel.routeToPart", { target: targetLabel })}
                                        {cfg.requirePairing !== false
                                          ? t("channel.pairingOnPart")
                                          : t("channel.whitelistOnlyPart")}
                                        {approvedCount > 0
                                          ? t("channel.approvedCountPart", { count: approvedCount })
                                          : ""}
                                        {whitelistCount > 0
                                          ? t("channel.whitelistCountPart", { count: whitelistCount })
                                          : ""}
                                      </div>
                                      {rt.lastEventAt && (
                                        <div className="mail-account-sub">
                                          {t("channel.lastEventAt", {
                                            time: new Date(rt.lastEventAt).toLocaleString(),
                                          })}
                                        </div>
                                      )}
                                      {rt.lastSendError && (
                                        <div
                                          className="mail-feedback-box is-error channel-runtime-alert"
                                          role="alert"
                                        >
                                          <div>
                                            <strong>{t("channel.sendErrorTitle")}</strong>
                                            <div>{rt.lastSendError}</div>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <div className="mail-account-actions">
                                    <button
                                      type="button"
                                      className="mail-acct-btn"
                                      disabled={chTestingAccountId === acct.id}
                                      onClick={() => runChannelTest(acct)}
                                    >
                                      {chTestingAccountId === acct.id
                                        ? t("common.testing")
                                        : t("skills.testShortBtn")}
                                    </button>
                                    <button
                                      type="button"
                                      className={`mail-acct-btn${isEditingThis ? " is-active" : ""}`}
                                      aria-expanded={isEditingThis}
                                      onClick={() => startEditingChannelAccount(acct)}
                                    >
                                      {isEditingThis ? t("common.collapse") : t("common.edit")}
                                    </button>
                                  </div>
                                </div>
                                {isEditingThis && renderChannelFormEditorShell(true, true)}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}

                    {supportsMultiBotChannels && (
                      <button
                        id="start-new-channel-btn"
                        type="button"
                        className="skills-add-account-btn"
                        onClick={startCreateChannelAccount}
                      >
                        {detailSkillId === "feishu-bot"
                          ? t("channel.addFeishuBot")
                          : t("channel.addTelegramBot")}
                      </button>
                    )}

                    {(!channelEditorOpen || !editingChannelAcctId) &&
                      renderChannelFormEditorShell(false, showCreateForm)}

                    {supportsMultiBotChannels && (
                      <section
                        id="channel-pairing-panel"
                        className="channel-pairing-panel"
                        aria-label={t("channel.pairingPendingTitle")}
                      >
                        <div className="channel-pairing-tip">{t("channel.pairingBotTip")}</div>

                        <div className="channel-pairing-group">
                          <h4 className="channel-pairing-group-title">
                            <span>{t("channel.pairingPendingTitle")}</span>
                            {channelPending.length > 0 && (
                              <span className="channel-pending-pill">{channelPending.length}</span>
                            )}
                          </h4>
                          {channelPending.length === 0 ? (
                            <div id="channel-pairing-pending-list" className="channel-pairing-empty">
                              {t("channel.pairingPendingEmpty")}
                            </div>
                          ) : (
                            <div id="channel-pairing-pending-list" className="channel-pairing-table">
                              {channelPending.map((p: any) => {
                                const busyKey = `pending:${p.code}`;
                                return (
                                  <div key={p.code} className="channel-pairing-row">
                                    <div className="channel-pairing-row-main">
                                      <div className="channel-pairing-row-head">
                                        <span className="channel-pairing-code">{p.code}</span>
                                        <span className="mail-account-name">
                                          {p.senderName || p.senderId || p.chatId}
                                        </span>
                                        <span className="mail-default-badge">
                                          {p.accountLabel || p.accountId}
                                        </span>
                                      </div>
                                      <div className="channel-pairing-meta">
                                        chatId: {p.chatId}
                                        {t("channel.routeToPart", {
                                          target: resolveTargetBotTitle(p.defaultSessionId),
                                        })}
                                      </div>
                                    </div>
                                    <div className="mail-account-actions">
                                      <button
                                        type="button"
                                        className="mail-acct-btn is-primary"
                                        data-pairing-approve={p.code}
                                        disabled={chPairingsBusyKey === busyKey}
                                        onClick={() =>
                                          runPairingAction(
                                            busyKey,
                                            "/api/integrations/channels/pairings/approve",
                                            "POST",
                                            { code: p.code },
                                            t("channel.approvedCodeToast", { code: p.code })
                                          )
                                        }
                                      >
                                        {t("channel.pairingApprove")}
                                      </button>
                                      <button
                                        type="button"
                                        className="mail-acct-btn is-danger"
                                        data-pairing-reject={p.code}
                                        disabled={chPairingsBusyKey === busyKey}
                                        onClick={() =>
                                          runPairingAction(
                                            busyKey,
                                            "/api/integrations/channels/pairings/reject",
                                            "POST",
                                            { code: p.code },
                                            t("channel.rejectedCodeToast", { code: p.code })
                                          )
                                        }
                                      >
                                        {t("channel.pairingReject")}
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="channel-pairing-group">
                          <h4 className="channel-pairing-group-title">
                            <span>{t("channel.pairingApprovedTitle")}</span>
                          </h4>
                          {channelApproved.length === 0 ? (
                            <div id="channel-pairing-approved-list" className="channel-pairing-empty">
                              {t("channel.pairingApprovedEmpty")}
                            </div>
                          ) : (
                            <div id="channel-pairing-approved-list" className="channel-pairing-table">
                              {channelApproved.map((a: any) => {
                                const key = `${a.channel}:${a.accountId}:${a.chatId}`;
                                const enabled = a.enabled !== false;
                                return (
                                  <div key={key} className="channel-pairing-row">
                                    <div className="channel-pairing-row-main">
                                      <div className="channel-pairing-row-head">
                                        <span
                                          className={`channel-state-pill ${
                                            enabled ? "is-enabled" : "is-suspended"
                                          }`}
                                        >
                                          {enabled
                                            ? t("channel.pairingStateEnabled")
                                            : t("channel.pairingStateSuspended")}
                                        </span>
                                        <span className="mail-account-name">
                                          {a.senderName || a.senderId || a.chatId}
                                        </span>
                                        <span className="mail-default-badge">
                                          {a.accountLabel || a.accountId}
                                        </span>
                                      </div>
                                      <div className="channel-pairing-meta">
                                        chatId: {a.chatId}
                                        {t("channel.routeToPart", {
                                          target: resolveTargetBotTitle(a.defaultSessionId),
                                        })}
                                      </div>
                                    </div>
                                    <div className="mail-account-actions">
                                      <button
                                        type="button"
                                        className="mail-acct-btn"
                                        disabled={chPairingsBusyKey === key}
                                        onClick={() =>
                                          runPairingAction(
                                            key,
                                            "/api/integrations/channels/pairings/toggle",
                                            "POST",
                                            {
                                              channel: a.channel,
                                              accountId: a.accountId,
                                              chatId: a.chatId,
                                              enabled: !enabled,
                                            },
                                            enabled
                                              ? t("channel.suspendedChatToast", { chatId: a.chatId })
                                              : t("channel.resumedChatToast", { chatId: a.chatId })
                                          )
                                        }
                                      >
                                        {enabled
                                          ? t("channel.pairingSuspend")
                                          : t("channel.pairingResume")}
                                      </button>
                                      <button
                                        type="button"
                                        className="mail-acct-btn is-danger"
                                        disabled={chPairingsBusyKey === key}
                                        onClick={() =>
                                          runPairingAction(
                                            key,
                                            "/api/integrations/channels/pairings/approved",
                                            "DELETE",
                                            {
                                              channel: a.channel,
                                              accountId: a.accountId,
                                              chatId: a.chatId,
                                            },
                                            t("channel.deletedChatToast", { chatId: a.chatId })
                                          )
                                        }
                                      >
                                        {t("channel.pairingDelete")}
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </section>
                    )}
                  </section>
                );
              })()}

            {/* MCP Skill Config Panel */}
            <section
              id="mcp-skill-config-panel"
              className="mcp-skill-config-panel"
              aria-label={t("skills.mcpPanelAria")}
              hidden={!isMcpSkill}
            >
              <div className="mcp-status-card">
                <div className="mcp-status-head">
                  <span className="mcp-status-title">{t("skills.mcpStatusTitle")}</span>
                  {!srv ? (
                    <span id="mcp-status-badge" className="mcp-status-badge">
                      {t("skills.mcpCheckingBadge")}
                    </span>
                  ) : srv.connected ? (
                    <span id="mcp-status-badge" className="mcp-status-badge is-online">
                      <span className="status-dot-inline is-ok" aria-hidden="true" />
                      {t("skills.mcpReadyToolsBadge", { count: srv.toolCount || 0 })}
                    </span>
                  ) : srvBinMissing ? (
                    <span id="mcp-status-badge" className="mcp-status-badge is-offline">
                      <UiIcon
                        name="alert-triangle"
                        className="inline-ui-icon inline-status-svg is-warn"
                        size={13}
                      />
                      {isNonMacHost || srv?.unsupportedPlatform
                        ? t("skills.mcpUnsupportedBadge")
                        : t("skills.mcpMissingBinaryBadge")}
                    </span>
                  ) : srvErr ? (
                    <span id="mcp-status-badge" className="mcp-status-badge is-offline">
                      <UiIcon
                        name="alert-triangle"
                        className="inline-ui-icon inline-status-svg is-warn"
                        size={13}
                      />
                      {t("skills.mcpErrorBadge")}
                    </span>
                  ) : (
                    <span id="mcp-status-badge" className="mcp-status-badge">
                      <span className="status-dot-inline is-muted" aria-hidden="true" />
                      {t("skills.mcpOnDemandBadge")}
                    </span>
                  )}
                </div>
                <div id="mcp-status-detail" className="mcp-status-detail">
                  {!srv
                    ? isNonMacHost
                      ? t("skills.mcpCheckingLocal")
                      : t("skills.mcpCheckingCmd", {
                          cmd:
                            settings?.mcpServers?.[mcpServerId]?.command ||
                            defaultKimiConfig.command ||
                            t("skills.mcpLocalFallback"),
                        })
                    : srv.connected
                      ? t("skills.mcpHandshakeOkDetail", {
                          name: srv.serverInfo?.name || "kimi-cu",
                          ver: srv.serverInfo?.version ? ` v${srv.serverInfo.version}` : "",
                          cmd: srvCmdText,
                        })
                      : srvBinMissing
                        ? isNonMacHost || srv?.unsupportedPlatform
                          ? srvErr || t("skills.mcpUnsupportedDetail")
                          : t("skills.mcpMissingBinaryDetail", {
                              cmd: srv.command || t("skills.mcpUnconfiguredFallback"),
                            })
                        : srvErr
                          ? `${srvErr}${srvCmdText ? ` (${srvCmdText})` : ""}`
                          : t("skills.mcpExecutableReadyDetail", { cmd: srvCmdText })}
                </div>
                {srv?.connected && srv.runtimeCapabilities && (
                  <div id="mcp-cap-chips" className="mcp-cap-chips">
                    {srv.runtimeCapabilities.input_mode === "adaptive_background_first" && (
                      <span className="mcp-cap-chip">{t("skills.mcpCapBackgroundFirst")}</span>
                    )}
                    {srv.runtimeCapabilities.moves_real_pointer === false && (
                      <span className="mcp-cap-chip">{t("skills.mcpCapCursorSafe")}</span>
                    )}
                    {srv.runtimeCapabilities.state_diff === true && (
                      <span className="mcp-cap-chip">{t("skills.mcpCapStateDiff")}</span>
                    )}
                    {srv.runtimeCapabilities.supports_rich_paste === true && (
                      <span className="mcp-cap-chip">{t("skills.mcpCapRichPaste")}</span>
                    )}
                  </div>
                )}
                <div
                  id="mcp-tools-chips"
                  className="mcp-tools-chips"
                  aria-label={t("skills.mcpToolsAria")}
                >
                  {srv?.connected &&
                    (srv.tools || []).map((toolName: string) => (
                      <span key={toolName} className="mcp-tool-chip">
                        {toolName}
                      </span>
                    ))}
                </div>
              </div>

              <div className="mail-field mcp-json-block">
                <label htmlFor="mcp-config-json-input">{t("skills.mcpJsonLabel")}</label>
                <span className="mail-field-hint">
                  {isNonMacHost ? (
                    <>{t("skills.mcpNonMacHint")}</>
                  ) : (
                    <>
                      {t("skills.mcpMacHintBefore")}{" "}
                      <code>/Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp -s user</code>
                      {t("skills.mcpMacHintAfter")}
                    </>
                  )}
                </span>
                <textarea
                  id="mcp-config-json-input"
                  className="inline-textarea mcp-json-textarea"
                  rows={8}
                  spellCheck={false}
                  aria-label={t("skills.mcpJsonAria")}
                  value={mcpJsonText}
                  onChange={(e) => setMcpJsonText(e.target.value)}
                />
              </div>

              <div
                id="mcp-config-feedback"
                className={`mail-feedback-box${
                  mcpFeedback.kind === "success"
                    ? " is-success"
                    : mcpFeedback.kind === "error"
                      ? " is-error"
                      : ""
                }`}
                role="status"
                aria-live="polite"
                hidden={!mcpFeedback.text}
              >
                <StatusText text={mcpFeedback.text} />
              </div>

              <div className="mail-form-actions">
                <button
                  id="mcp-save-reconnect-btn"
                  type="button"
                  className="settings-blue-pill"
                  disabled={mcpBusy !== null}
                  onClick={async () => {
                    let nextMcpServers;
                    try {
                      nextMcpServers = parseMcpConfigJsonInput(
                        mcpJsonText,
                        settings?.mcpServers,
                        mcpServerId,
                        locale
                      );
                    } catch (err: any) {
                      setState({
                        mcpFeedback: {
                          text: t("skills.mcpJsonError", { error: err.message }),
                          kind: "error",
                        },
                      });
                      return;
                    }
                    setMcpBusy("save");
                    setState({
                      mcpFeedback: {
                        text: t("skills.mcpSavingHandshakeFeedback"),
                        kind: "info",
                      },
                    });
                    try {
                      await commitSettingsPatch({ mcpServers: nextMcpServers });
                      const res = await apiJson("/api/mcp/reconnect", {
                        method: "POST",
                        body: JSON.stringify({ serverId: mcpServerId }),
                      });
                      const nextSrv = res?.server || res;
                      if (nextSrv && typeof nextSrv === "object") {
                        setState((prev) => ({
                          mcpStatusByServer: {
                            ...prev.mcpStatusByServer,
                            [mcpServerId]: nextSrv,
                          },
                        }));
                      }
                      if (nextSrv?.connected) {
                        setState({
                          mcpFeedback: {
                            text: t("skills.mcpSavedConnectedFeedback", {
                              count: nextSrv.toolCount || 0,
                            }),
                            kind: "success",
                          },
                        });
                        showToast(t("skills.mcpConnectedToast"));
                      } else {
                        setState({
                          mcpFeedback: {
                            text: t("skills.mcpSavedNotReadyFeedback", {
                              error:
                                nextSrv?.error ||
                                nextSrv?.lastError ||
                                t("skills.mcpCheckPathFallback"),
                            }),
                            kind: "error",
                          },
                        });
                      }
                    } catch (err: any) {
                      await refreshMcpSkillStatus(mcpServerId, false);
                      setState({
                        mcpFeedback: {
                          text: t("skills.mcpConnectFailedFeedback", {
                            error: err.message || "",
                          }),
                          kind: "error",
                        },
                      });
                    } finally {
                      setMcpBusy(null);
                    }
                  }}
                >
                  {mcpBusy === "save" ? t("skills.mcpSavingBtn") : t("skills.mcpSaveAndTestBtn")}
                </button>
                <button
                  id="mcp-test-reconnect-btn"
                  type="button"
                  className="settings-pill-btn"
                  disabled={mcpBusy !== null}
                  onClick={async () => {
                    setMcpBusy("test");
                    setState({
                      mcpFeedback: {
                        text: t("skills.mcpRetestingFeedback"),
                        kind: "info",
                      },
                    });
                    try {
                      const res = await apiJson("/api/mcp/reconnect", {
                        method: "POST",
                        body: JSON.stringify({ serverId: mcpServerId }),
                      });
                      const nextSrv = res?.server || res;
                      if (nextSrv && typeof nextSrv === "object") {
                        setState((prev) => ({
                          mcpStatusByServer: {
                            ...prev.mcpStatusByServer,
                            [mcpServerId]: nextSrv,
                          },
                        }));
                      }
                      if (nextSrv?.connected) {
                        setState({
                          mcpFeedback: {
                            text: t("skills.mcpRetestOkFeedback", {
                              ver: nextSrv.serverInfo?.version
                                ? `v${nextSrv.serverInfo.version}`
                                : t("skills.mcpReadyWord"),
                              count: nextSrv.toolCount || 0,
                            }),
                            kind: "success",
                          },
                        });
                      } else {
                        setState({
                          mcpFeedback: {
                            text: t("skills.mcpRetestFailFeedback", {
                              error:
                                nextSrv?.error ||
                                nextSrv?.lastError ||
                                t("skills.mcpLaunchFailFallback"),
                            }),
                            kind: "error",
                          },
                        });
                      }
                    } catch (err: any) {
                      await refreshMcpSkillStatus(mcpServerId, false);
                      setState({
                        mcpFeedback: {
                          text: t("skills.mcpRetestErrorFeedback", {
                            error: err.message || "",
                          }),
                          kind: "error",
                        },
                      });
                    } finally {
                      setMcpBusy(null);
                    }
                  }}
                >
                  {mcpBusy === "test" ? t("skills.mcpHandshakingBtn") : t("skills.mcpRetestBtn")}
                </button>
              </div>
            </section>
          </div>
          </fieldset>
        </div>
      </div>
    </div>
  );
}
