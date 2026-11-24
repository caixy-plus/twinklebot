import { useEffect, useRef, useState, type FormEvent } from "react";
import { inferMailServerPreset } from "/skills-catalog.js";
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
  const [purge, setPurge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const saved = Number(skill?.savedAccountCount) || 0;

  return (
    <div
      className={`skill-remove-confirm${spanGrid ? " skills-grid-span" : ""}`}
      role="group"
      aria-label={`确认移除${skill.name}`}
    >
      <div className="skill-remove-text">
        确认移除「{skill.name}」？移除后 Bot 将暂停使用该技能，重新添加即可恢复。
      </div>
      {saved > 0 && (
        <label className="skill-remove-purge">
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => setPurge(e.target.checked)}
          />
          <span>同时清除已保存的 {saved} 个邮箱凭据</span>
        </label>
      )}
      <div className="skill-remove-actions">
        <button type="button" className="skill-pill-btn" onClick={onCancel}>
          取消
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
              showToast(`已移除「${skill.name}」`);
              onDone();
            } catch (err: any) {
              setSubmitting(false);
              showToast(`移除失败：${err.message || ""}`);
            }
          }}
        >
          确认移除
        </button>
      </div>
    </div>
  );
}

export function SkillsStoreModal() {
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
    computerStatus?.hostComputer?.platform || diagnostics?.hostComputer?.platform
  );
  const isNonMacHost = Boolean(hostPlatform && hostPlatform !== "darwin");
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

  // MCP JSON editor
  const detailSkill = getConfigurableSkillFromSettings(settings, detailSkillId);
  const isMcpSkill = Boolean(detailSkill?.mcpServerId || detailSkill?.category === "platform");
  const mcpServerId = detailSkill?.mcpServerId || detailSkillId || "kimi-cu";
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
    if (skillsView === "detail" && detailSkillId && !isMcpSkill) {
      const pAccounts = getProviderAccounts(detailSkillId);
      if (pAccounts.length === 0 && !editingMailAccountId && !mailEditorOpen) {
        resetMailFormsForCreate(detailSkillId === "custom-mail" ? "custom-mail" : "qqmail");
      }
    }
  }, [skillsView, detailSkillId, isMcpSkill]);

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
    setProviderMailFeedback(provider, "正在连接邮箱服务器验证收发通道…", "info");
    try {
      const payload = collectMailPayload(provider);
      const res = await apiJson("/api/integrations/mail/accounts", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      applyMailApiResponse(res);
      const savedAcct = res.account || {};
      const stats = res.inboxStats;
      const unseenInfo = stats?.unseen !== undefined ? `（未读 ${stats.unseen} 封）` : "";
      resetMailFormsForCreate(provider);
      setState({
        mailEditorOpen: false,
        editingMailAccountId: null,
        mailListFeedback: {
          text: wasEditing
            ? `✓ 已保存 ${savedAcct.email || payload.email} 的修改，收件箱共 ${stats?.messages ?? 0} 封${unseenInfo}。`
            : `✓ 已连接 ${savedAcct.email || payload.email}，收件箱共 ${stats?.messages ?? 0} 封${unseenInfo}。`,
          kind: "success",
        },
      });
      await refreshSettingsFromServer();
      showToast(
        wasEditing
          ? `已更新邮箱 ${savedAcct.label || savedAcct.email}`
          : `已添加邮箱 ${savedAcct.label || savedAcct.email}`
      );
    } catch (err: any) {
      setProviderMailFeedback(provider, `❌ ${err.message || "邮箱连接验证失败"}`, "error");
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
      sendTestMail ? "正在向当前邮箱发送测试邮件…" : "正在测试收件与 SMTP 发件握手…",
      "info"
    );
    try {
      const payload = collectMailPayload(provider);
      const res = await apiJson("/api/integrations/mail/test", {
        method: "POST",
        body: JSON.stringify(sendTestMail ? { ...payload, sendTestMail: true } : payload),
      });
      if (sendTestMail) {
        setProviderMailFeedback(
          provider,
          "✓ 测试邮件已成功发送至您自己的收件箱，请查收确认。",
          "success"
        );
      } else {
        const unseenInfo = res.unseen !== undefined ? `，未读 ${res.unseen} 封` : "";
        setProviderMailFeedback(
          provider,
          `✓ 连通性测试成功（耗时 ${res.latencyMs || 0}ms）：收件箱共 ${res.messages ?? 0} 封${unseenInfo}，SMTP 认证正常。`,
          "success"
        );
      }
    } catch (err: any) {
      setProviderMailFeedback(
        provider,
        sendTestMail
          ? `❌ 发送测试信失败：${err.message || ""}`
          : `❌ ${err.message || "测试失败"}`,
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
      title: "移除邮箱账号",
      message: "确定要移除此邮箱账号吗？",
      detail: "将断开同步并清除本地保存的邮箱授权凭据。",
      confirmText: "确认移除",
      cancelText: "取消",
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
          text: "已移除该邮箱账号并清除本地保存的凭据。",
          kind: "info",
        },
      });
      await refreshSettingsFromServer();
      showToast("已移除邮箱账号");
    } catch (err: any) {
      setProviderMailFeedback(provider, `❌ 移除失败：${err.message || ""}`, "error");
    } finally {
      setMailBusyBtn(null);
    }
  };

  const installSkill = async (skillId: string) => {
    try {
      const res = await apiJson(`/api/skills/${encodeURIComponent(skillId)}/install`, {
        method: "POST",
      });
      const mergedSettings = { ...getState().settings, ...res };
      setState({ settings: mergedSettings });
      const addedSkill = getConfigurableSkillFromSettings(mergedSettings, skillId);
      showToast(`已添加「${addedSkill?.name || skillId}」`);
      if (addedSkill?.mcpServerId) {
        refreshMcpSkillStatus(addedSkill.mcpServerId, true);
      }
    } catch (err: any) {
      showToast(`添加失败：${err.message || ""}`);
    }
  };

  const officeSkillSubtitle = (skill: any) => {
    if (!skill.installed) return skill.desc;
    const n = getProviderAccounts(skill.id).length;
    return n > 0 ? `已配置 ${n} 个账号` : "IMAP / POP3 + SMTP · 待配置";
  };

  const platformSkillSubtitle = (skill: any) => {
    if (!skill.removable) {
      return `${skill.toolCount} 项工具 · ${skill.desc}`;
    }
    if (!skill.installed) {
      return `手动添加启用 · ${skill.desc}`;
    }
    const srv = mcpStatusByServer?.[skill.mcpServerId || skill.id];
    if (srv?.connected) {
      const ver = srv.serverInfo?.version ? ` v${srv.serverInfo.version}` : "";
      return `MCP 已连接${ver} · ${srv.toolCount || skill.toolCount} 项工具可用`;
    }
    if (srv?.binaryExists === false || srv?.binaryInstalled === false) {
      return isNonMacHost || srv?.unsupportedPlatform
        ? "已添加 · 当前系统未安装或不支持 KimiCU，点击「配置」查看"
        : "已添加 · 未检测到 KimiCU，点击「配置」查看";
    }
    return `${skill.toolCount} 项工具 · 已添加，点击「配置」检测或修改 MCP 服务`;
  };

  const skillMatchesSearch = (skill: any, query: string) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const accountText = (skill.id ? getProviderAccounts(skill.id) : [])
      .map((a: any) => `${a.email} ${a.label || ""}`)
      .join(" ");
    return `${skill.name || ""} ${skill.desc || skill.instruction || ""} ${accountText}`
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
  const filteredPlatform =
    skillFilter === "all" || skillFilter === "platform"
      ? visiblePlatform.filter((s: any) => skillMatchesSearch(s, searchTrim))
      : [];

  // Custom Skills calculations
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
    const name = csName.trim() || "未命名技能";
    const slug =
      csSlug.trim() ||
      editingCustomSkillId ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      "custom-skill";
    const icon = csIcon.trim() || "⚡";
    const desc = csDesc.trim() || "（尚未填写触发简介）";
    const body = csInstructions.trim() || "（尚未填写步骤正文）";
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
        customSkillFeedback: "请完整填写技能名称、触发简介以及操作步骤正文。",
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
      showToast(wasEdit ? `已更新自定义技能「${name}」` : `已创建自定义技能「${name}」`);
    } catch (err: any) {
      setState({ customSkillFeedback: err?.message || "保存失败，请检查输入" });
    } finally {
      setCsSaving(false);
    }
  };

  // Detail view mail & MCP state
  const detailProviderAccounts =
    detailSkillId && !isMcpSkill ? getProviderAccounts(detailSkillId) : [];
  const editingAccount = editingMailAccountId
    ? detailProviderAccounts.find((a: any) => a.id === editingMailAccountId) || null
    : null;
  const showMailCreateForm =
    !isMcpSkill && ((mailEditorOpen && !editingMailAccountId) || detailProviderAccounts.length === 0);
  const detailBackLabel = detailFrom === "manage" ? "管理已添加技能" : "技能商店";

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
            ? `编辑自定义技能「${csName || editingCustomSkillId}」`
            : "新建自定义技能"}
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
          {customSkillPreviewMode ? "返回表单编辑" : "预览 SKILL.md"}
        </button>
      </div>

      <div
        id="custom-skill-fields-pane"
        className="custom-skill-fields"
        hidden={customSkillPreviewMode}
      >
        <div className="custom-skill-row-two">
          <label className="field-group custom-skill-icon-field">
            <span>图标</span>
            <input
              id="custom-skill-icon-input"
              type="text"
              maxLength={4}
              value={csIcon}
              onChange={(e) => setCsIcon(e.target.value)}
            />
          </label>
          <label className="field-group custom-skill-name-field">
            <span>技能名称 *</span>
            <input
              ref={csNameRef}
              id="custom-skill-name-input"
              type="text"
              maxLength={64}
              placeholder="例如：周报汇总发送"
              required
              value={csName}
              onChange={(e) => setCsName(e.target.value)}
            />
          </label>
          <label className="field-group custom-skill-slug-field">
            <span>英文标识 (Slug，可选)</span>
            <input
              id="custom-skill-slug-input"
              type="text"
              maxLength={64}
              placeholder="自动生成如 weekly-report"
              value={csSlug}
              onChange={(e) => setCsSlug(e.target.value)}
            />
          </label>
        </div>
        <label className="field-group">
          <span>触发简介（注入轻量索引供所有 Bot 按需识别）*</span>
          <input
            id="custom-skill-desc-input"
            type="text"
            maxLength={240}
            placeholder="例如：当需要汇总项目进展并群发团队邮件周报时使用"
            required
            value={csDesc}
            onChange={(e) => setCsDesc(e.target.value)}
          />
        </label>
        <label className="field-group">
          <span>完整操作步骤（Markdown 正文，按需加载给 Bot）*</span>
          <textarea
            id="custom-skill-instructions-input"
            rows={6}
            placeholder={"## 执行步骤\n1. 收集本周关键产出与阻塞事项\n2. 按「摘要 → 明细 → 下周计划」排版\n3. ..."}
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
          <span>保存后全 Bot 启用共享</span>
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
            取消
          </button>
          <button
            id="custom-skill-save-btn"
            type="submit"
            className="skill-pill-btn is-primary"
            disabled={csSaving}
          >
            保存技能
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
          新增邮箱账号
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
                ? `编辑 QQ 邮箱：${editingAccount.email}`
                : "新增 QQ 邮箱账号"}
            </h3>
            <div className="mail-form-meta" id="qqmail-verified-meta">
              {editingAccount && activeMailProvider === "qqmail"
                ? editingAccount.inboxStats
                  ? `当前已连接 · 收件箱共 ${editingAccount.inboxStats.messages ?? 0} 封${
                      editingAccount.inboxStats.unseen !== undefined
                        ? `，未读 ${editingAccount.inboxStats.unseen} 封`
                        : ""
                    }`
                  : `正在编辑 ${editingAccount.email}`
                : "默认使用 imap.qq.com:993 与 smtp.qq.com:465 SSL 加密连接"}
            </div>
          </div>
          <button
            id="qqmail-cancel-edit-btn"
            type="button"
            className="settings-pill-btn"
            hidden={detailProviderAccounts.length === 0}
            onClick={() => setState({ mailEditorOpen: false, editingMailAccountId: null })}
          >
            {inline ? "收起" : "返回账号列表"}
          </button>
        </div>

        <div className="mail-form-grid-two">
          <div className="mail-field">
            <label htmlFor="qqmail-email-input">
              QQ 邮箱地址 <span aria-hidden="true">*</span>
            </label>
            <span id="qqmail-email-hint" className="mail-field-hint">
              支持 @qq.com、@foxmail.com 或绑定的域名别名
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
              placeholder="例如：12345678@qq.com"
              value={qqEmail}
              onChange={(e) => setQqEmail(e.target.value)}
            />
            <div id="qqmail-email-error" className="mail-error-msg">
              请输入有效的 QQ 邮箱地址（如 123456@qq.com）。
            </div>
          </div>

          <div className="mail-field">
            <label htmlFor="qqmail-label-input">账号备注（区分多个邮箱，可选）</label>
            <span id="qqmail-label-hint" className="mail-field-hint">
              例如「工作QQ」「个人主号」，方便直接对 Bot 指定账号
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
              placeholder="例如：工作QQ / 个人邮箱"
              value={qqLabel}
              onChange={(e) => setQqLabel(e.target.value)}
            />
          </div>
        </div>

        <div className="mail-field">
          <div className="mail-label-row">
            <label htmlFor="qqmail-authcode-input">
              16 位 IMAP/POP3/SMTP 授权码{" "}
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
              aria-label="显示 QQ 邮箱授权码"
              onClick={() => setQqShowSecret((v) => !v)}
            >
              {qqShowSecret ? "隐藏授权码" : "显示授权码"}
            </button>
          </div>
          <span id="qqmail-authcode-hint" className="mail-field-hint">
            获取路径：网页版 QQ 邮箱 → 设置 → 账户 → 开启「IMAP/SMTP服务」或「POP3/SMTP服务」→ 生成 16 位授权码（非 QQ 密码）
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
                ? `已保存授权码 (${editingAccount.maskedSecret || "••••"})，留空保持不变`
                : "输入 16 位授权码（支持自动去除空格）"
            }
            value={qqAuthCode}
            onChange={(e) => setQqAuthCode(e.target.value)}
          />
          <div id="qqmail-authcode-error" className="mail-error-msg">
            请输入至少 8 位的 QQ 邮箱客户端授权码。
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
            <label htmlFor="qqmail-default-check">设为默认收发邮箱</label>
          </div>
        </div>

        <details className="mail-advanced-details">
          <summary>高级选项（发件人昵称 · IMAP / POP3 协议）</summary>
          <div className="mail-advanced-body">
            <div className="mail-field">
              <label htmlFor="qqmail-sender-input">发件人显示名称（可选）</label>
              <span id="qqmail-sender-hint" className="mail-field-hint">
                发信时收件人看到的名称，留空默认使用邮箱地址
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
                placeholder="例如：张工 / 研发助理"
                value={qqSender}
                onChange={(e) => setQqSender(e.target.value)}
              />
            </div>
            <fieldset className="mail-radio-fieldset">
              <legend>QQ 邮箱收件协议</legend>
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
                    IMAP（imap.qq.com:993 · 推荐，支持未读筛选）
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
              ? "正在验证并保存…"
              : editingAccount
                ? "保存修改"
                : "连接并保存"}
          </button>
          <button
            id="qqmail-test-btn"
            type="button"
            className="settings-pill-btn"
            disabled={mailBusyBtn === "qqmail-test"}
            onClick={() => handleMailTest("qqmail", false)}
          >
            {mailBusyBtn === "qqmail-test" ? "测试中…" : "测试连通性"}
          </button>
          <button
            id="qqmail-send-test-btn"
            type="button"
            className="settings-pill-btn"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "qqmail-send"}
            onClick={() => handleMailTest("qqmail", true)}
          >
            {mailBusyBtn === "qqmail-send" ? "发送中…" : "给自己发封测试信"}
          </button>
          <button
            id="qqmail-disconnect-btn"
            type="button"
            className="settings-pill-btn danger-text"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "qqmail-disconnect"}
            onClick={() => handleMailDisconnect("qqmail")}
          >
            移除此账号
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
                ? `编辑通用邮箱：${editingAccount.email}`
                : "新增通用邮箱账号（POP3 / IMAP + SMTP）"}
            </h3>
            <div className="mail-form-meta" id="custom-mail-verified-meta">
              {editingAccount && activeMailProvider === "custom-mail"
                ? `正在编辑 ${editingAccount.email}`
                : cmPresetApplied
                  ? "已根据邮箱域名自动填入推荐服务器，可随时手动修改"
                  : "自定义收件服务器（POP3 或 IMAP）与发件服务器（SMTP）接入任意标准邮箱"}
            </div>
          </div>
          <button
            id="custom-mail-cancel-edit-btn"
            type="button"
            className="settings-pill-btn"
            hidden={detailProviderAccounts.length === 0}
            onClick={() => setState({ mailEditorOpen: false, editingMailAccountId: null })}
          >
            {inline ? "收起" : "返回账号列表"}
          </button>
        </div>

        <div className="mail-form-grid-two">
          <div className="mail-field">
            <label htmlFor="custom-mail-email-input">
              邮箱账号 <span aria-hidden="true">*</span>
            </label>
            <span id="custom-mail-email-hint" className="mail-field-hint">
              完整的登录邮箱地址，如 name@company.com
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
              请输入格式正确的完整邮箱账号（如 user@example.com）。
            </div>
          </div>

          <div className="mail-field">
            <div className="mail-label-row">
              <label htmlFor="custom-mail-password-input">
                邮箱密码 / 授权码{" "}
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
                aria-label="显示通用邮箱密码"
                onClick={() => setCmShowSecret((v) => !v)}
              >
                {cmShowSecret ? "隐藏密码" : "显示密码"}
              </button>
            </div>
            <span id="custom-mail-password-hint" className="mail-field-hint">
              163/阿里/腾讯企业邮开启客户端登录时请填专用密码
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
                  ? `已保存密码 (${editingAccount.maskedSecret || "••••"})，留空保持不变`
                  : "输入邮箱密码或客户端专用授权码"
              }
              value={cmPassword}
              onChange={(e) => setCmPassword(e.target.value)}
            />
            <div id="custom-mail-password-error" className="mail-error-msg">
              请输入邮箱登录密码或客户端授权码。
            </div>
          </div>
        </div>

        <div className="mail-form-grid-two">
          <div className="mail-field">
            <label htmlFor="custom-mail-label-input">账号备注（区分多个邮箱，可选）</label>
            <span id="custom-mail-label-hint" className="mail-field-hint">
              例如「企业邮箱」「运维告警号」，便于对 Bot 指定收发账号
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
              placeholder="例如：公司企业邮 / 163 备用号"
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
              <label htmlFor="custom-mail-default-check">设为默认收发邮箱</label>
            </div>
          </div>
        </div>

        <fieldset className="mail-radio-fieldset">
          <legend>收件服务器协议（POP3 / IMAP）</legend>
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
              <label htmlFor="custom-proto-pop3">POP3（标准收件协议 · 默认端口 995）</label>
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
                IMAP（双向同步与未读状态 · 默认端口 993）
              </label>
            </div>
          </div>
        </fieldset>

        <div className="mail-server-grid">
          <div className="mail-field">
            <label htmlFor="custom-mail-inbound-host">
              收件服务器 (POP3 / IMAP) <span aria-hidden="true">*</span>
            </label>
            <span id="custom-inbound-host-hint" className="mail-field-hint">
              如 pop.163.com 或 imap.exmail.qq.com
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
              请填写收件服务器主机地址（如 pop.example.com）。
            </div>
          </div>

          <div className="mail-field">
            <label htmlFor="custom-mail-inbound-port">
              收件端口 <span aria-hidden="true">*</span>
            </label>
            <span id="custom-inbound-port-hint" className="mail-field-hint">
              SSL 常用 995 / 993
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
              请输入有效的端口号（如 995 或 993）。
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
              <label htmlFor="custom-mail-inbound-tls">收件 SSL/TLS</label>
            </div>
          </div>
        </div>

        <fieldset className="mail-radio-fieldset">
          <legend>发件服务器加密方式（SMTP）</legend>
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
              <label htmlFor="custom-smtp-ssl">SSL/TLS 加密（端口 465）</label>
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
              <label htmlFor="custom-smtp-starttls">STARTTLS 升级（端口 587）</label>
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
              <label htmlFor="custom-smtp-none">明文（端口 25）</label>
            </div>
          </div>
        </fieldset>

        <div className="mail-server-grid">
          <div className="mail-field">
            <label htmlFor="custom-mail-smtp-host">
              发件服务器 (SMTP) <span aria-hidden="true">*</span>
            </label>
            <span id="custom-smtp-host-hint" className="mail-field-hint">
              如 smtp.163.com 或 smtp.exmail.qq.com
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
              请填写 SMTP 发件服务器主机地址（如 smtp.example.com）。
            </div>
          </div>

          <div className="mail-field">
            <label htmlFor="custom-mail-smtp-port">
              SMTP 端口 <span aria-hidden="true">*</span>
            </label>
            <span id="custom-smtp-port-hint" className="mail-field-hint">
              常用 465 或 587
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
              请输入有效的 SMTP 端口号（如 465 或 587）。
            </div>
          </div>
        </div>

        <details className="mail-advanced-details">
          <summary>高级选项（发件人昵称）</summary>
          <div className="mail-advanced-body">
            <div className="mail-field">
              <label htmlFor="custom-mail-sender-input">发件人昵称（可选）</label>
              <span id="custom-sender-hint" className="mail-field-hint">
                对外显示的发件人名
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
                placeholder="选填"
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
              ? "正在验证并保存…"
              : editingAccount
                ? "保存修改"
                : "连接并保存"}
          </button>
          <button
            id="custom-mail-test-btn"
            type="button"
            className="settings-pill-btn"
            disabled={mailBusyBtn === "custom-mail-test"}
            onClick={() => handleMailTest("custom-mail", false)}
          >
            {mailBusyBtn === "custom-mail-test" ? "测试中…" : "测试连通性"}
          </button>
          <button
            id="custom-mail-send-test-btn"
            type="button"
            className="settings-pill-btn"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "custom-mail-send"}
            onClick={() => handleMailTest("custom-mail", true)}
          >
            {mailBusyBtn === "custom-mail-send" ? "发送中…" : "给自己发封测试信"}
          </button>
          <button
            id="custom-mail-disconnect-btn"
            type="button"
            className="settings-pill-btn danger-text"
            hidden={!editingAccount}
            disabled={mailBusyBtn === "custom-mail-disconnect"}
            onClick={() => handleMailDisconnect("custom-mail")}
          >
            移除此账号
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
      <div className="apps-modal skills-modal" role="dialog" aria-modal="true" aria-label="技能商店">
        <button
          id="close-apps-modal-btn"
          type="button"
          className="modal-close-btn"
          title="关闭"
          aria-label="关闭"
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
          contextHint="技能配置暂为只读"
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
              title="返回"
              aria-label="返回"
              onClick={closeAppsModal}
            >
              <UiIcon name="chevron-left" />
            </button>
            <h2 className="apps-modal-title" id="skills-store-title" tabIndex={-1}>
              技能商店
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
                商店已添加 {totalAdded} 个 · 自定义 {customSkills.length} 个
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
                placeholder="在技能中搜索"
                aria-label="在技能中搜索"
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
              title="创建专属「邮箱管家」Bot"
              onClick={async () => {
                const tpl = await apiJson("/api/sessions", {
                  method: "POST",
                  body: JSON.stringify({
                    title: "邮箱管家",
                    avatar: { shape: "tablet", color: "blue" },
                    rolePrompt:
                      "专门负责协助用户管理已连接的 QQ 邮箱与通用邮箱（POP3/IMAP + SMTP）：拉取最新未读信件、提炼重要邮件摘要与待办清单，并在起草专业得体的回复草稿后交由用户确认发送。",
                  }),
                });
                closeAppsModal();
                upsertLocalSession(tpl);
                await selectSession(tpl.id);
                showToast("已创建专属「邮箱管家」Bot");
              }}
            >
              <span className="template-blob-dot" aria-hidden="true" />
              <span>Bot 模板</span>
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

          <div className="skills-filter-pills" role="group" aria-label="技能分类">
            {(
              [
                ["all", "全部"],
                ["office", "办公"],
                ["platform", "平台技能"],
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
              <div className="skills-empty">没有找到与「{searchTrim}」相关的技能</div>
            ) : (
              <>
                {filteredOffice.length > 0 && (
                  <section className="apps-section-block">
                    <div className="apps-section-header">
                      <h4>办公</h4>
                    </div>
                    <div className="skills-grid">
                      {filteredOffice.map((s: any) => (
                        <div key={s.id} className="skill-row">
                          <div className="skill-row-icon" aria-hidden="true">
                            <SkillIconGraphic skillId={s.id} rawIcon={s.icon} />
                          </div>
                          <div className="skill-row-info">
                            <div className="skill-row-name">{s.name}</div>
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
                              配置
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="skill-pill-btn is-primary"
                              onClick={() => installSkill(s.id)}
                            >
                              添加
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
                      <h4>平台技能</h4>
                    </div>
                    <div className="skills-grid">
                      {filteredPlatform.map((s: any) => (
                        <div key={s.id} className="skill-row">
                          <div className="skill-row-icon" aria-hidden="true">
                            <SkillIconGraphic skillId={s.id} rawIcon={s.icon} />
                          </div>
                          <div className="skill-row-info">
                            <div className="skill-row-name">{s.name}</div>
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
                                配置
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="skill-pill-btn is-primary"
                                onClick={() => installSkill(s.id)}
                              >
                                添加
                              </button>
                            )
                          ) : (
                            <span className="skill-builtin-tag">内置</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>

          <div className="skills-store-footer-note">
            <span>自己或 Bot 创建的自定义技能（全 Bot 共享）不在商店展示</span>
            <button
              id="store-manage-custom-btn"
              type="button"
              className="skills-store-manage-link"
              onClick={() => openAppsModal("manage")}
            >
              <span>管理我的自定义技能</span>
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
            title="返回技能商店"
            aria-label="返回技能商店"
            onClick={() => openAppsModal("store")}
          >
            <UiIcon name="chevron-left" className="inline-ui-icon" />
            <span>技能商店</span>
          </button>

          <div className="apps-header-row skills-subheader">
            <h2 className="apps-modal-title" id="skills-manage-title" tabIndex={-1}>
              管理已添加技能
            </h2>
            <button
              id="add-custom-skill-btn"
              type="button"
              className="settings-blue-pill custom-skill-create-btn"
              disabled={remoteAccountOffline}
              onClick={() => openCustomEditorFor(null)}
            >
              + 新建自定义技能
            </button>
          </div>

          <fieldset
            className="remote-offline-fieldset"
            data-remote-offline-guard="skills-manage"
            disabled={remoteAccountOffline}
          >
          <div className="apps-sections-scroll skills-sections">
            {/* Section A: 自定义技能 */}
            <section
              id="custom-skills-section"
              className="apps-section-block custom-skills-section"
              aria-labelledby="custom-skills-heading"
            >
              <div className="apps-section-header custom-skills-section-header">
                <div className="custom-skills-title-group">
                  <h4 id="custom-skills-heading">自定义技能（我 / Bot 创建 · 全 Bot 共享）</h4>
                  <span id="custom-skills-count-badge" className="custom-skills-count-badge">
                    {customSkills.length > 0
                      ? `已启用 ${enabledCustomCount} / ${customSkills.length} 项`
                      : "0 项"}
                  </span>
                </div>
                <label className="custom-skill-search-wrap">
                  <input
                    id="custom-skill-search-input"
                    type="search"
                    className="custom-skill-search-input"
                    placeholder="搜索自定义技能…"
                    aria-label="搜索自定义技能"
                    autoComplete="off"
                    value={customSkillSearch}
                    onChange={(e) => setState({ customSkillSearch: e.target.value })}
                  />
                </label>
              </div>

              {(!customSkillEditorOpen || !editingCustomSkillId) &&
                renderCustomSkillEditorForm(
                  false,
                  customSkillEditorOpen && !editingCustomSkillId
                )}

              <div id="custom-skills-list" className="custom-skills-list">
                {filteredCustomSkills.length === 0 ? (
                  <div className="skills-empty">
                    {csQuery
                      ? `没有找到与「${customSkillSearch.trim()}」匹配的自定义技能`
                      : "暂无自定义技能。可点击右上角「+ 新建自定义技能」，或在对话中让任意 Bot 总结创建（例如「把刚才的流程沉淀成自定义技能」）。"}
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
                                    ? `Bot「${s.createdByBotName || "Bot"}」创建`
                                    : "用户创建"}
                                </span>
                                <span className="custom-skill-shared-tag">全 Bot 共享</span>
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
                                  ? "全局启用（点击停用）"
                                  : "已停用（点击启用）"
                              }
                            >
                              <input
                                type="checkbox"
                                checked={s.enabled !== false}
                                aria-label={`全局启用自定义技能 ${s.name}`}
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
                                      `${checked ? "已启用" : "已停用"}自定义技能「${s.name}」`
                                    );
                                  } catch (err: any) {
                                    showToast(err?.message || "更新状态失败");
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
                              {isEditingThisSkill ? "收起" : "查看 / 编辑"}
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
                              删除
                            </button>
                          </div>
                        </div>

                        {isEditingThisSkill && renderCustomSkillEditorForm(true, true)}

                        {pendingDeleteCustomSkillId === s.id && (
                          <div className="skill-remove-confirm">
                            <div className="skill-remove-text">
                              确定永久删除自定义技能「{s.name}」({s.id}.md)？所有 Bot 将立即停止共享此技能。
                            </div>
                            <div className="skill-remove-actions">
                              <button
                                type="button"
                                className="skill-pill-btn"
                                onClick={() => setState({ pendingDeleteCustomSkillId: null })}
                              >
                                取消
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
                                    showToast(`已删除自定义技能「${s.name}」`);
                                  } catch (err: any) {
                                    showToast(err?.message || "删除失败");
                                  } finally {
                                    setDeletingCsId(null);
                                  }
                                }}
                              >
                                确认删除
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

            {/* Section B: 商店技能与内置平台能力 */}
            <section className="apps-section-block" aria-labelledby="skills-added-heading">
              <div className="apps-section-header">
                <h4 id="skills-added-heading">商店技能与内置平台能力</h4>
              </div>
              <div id="installed-plugins-grid" className="skills-grid">
                {removableInstalled.map((s: any) => (
                  <div key={s.id} style={{ display: "contents" }}>
                    <div className="skill-row">
                      <div className="skill-row-icon" aria-hidden="true">
                        <SkillIconGraphic skillId={s.id} rawIcon={s.icon} />
                      </div>
                      <div className="skill-row-info">
                        <div className="skill-row-name">{s.name}</div>
                        <div className="skill-row-desc">
                          {s.category === "platform"
                            ? platformSkillSubtitle(s)
                            : officeSkillSubtitle(s)}
                        </div>
                      </div>
                      <div className="skill-row-actions">
                        <span className="skill-added-status">已添加</span>
                        <button
                          type="button"
                          className="skill-pill-btn"
                          onClick={() =>
                            openAppsModal("detail", { skillId: s.id, from: "manage" })
                          }
                        >
                          配置
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
                          移除
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
            title={`返回${detailBackLabel}`}
            aria-label={`返回${detailBackLabel}`}
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
                {detailSkill?.name || "QQ 邮箱"}
              </h2>
              <div className="skill-row-desc" id="skill-detail-sub">
                {detailSkill
                  ? isMcpSkill
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
              移除技能
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
              aria-label="已绑定的邮箱账号"
              hidden={isMcpSkill || showMailCreateForm}
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
                aria-label="已绑定的邮箱账号列表"
              >
                {detailProviderAccounts.map((acct: any) => {
                  const isEditingThisAcct =
                    mailEditorOpen && editingMailAccountId === acct.id;
                  const stats = acct.inboxStats;
                  const statsPart = stats
                    ? ` · 收件箱 ${stats.messages ?? 0} 封${
                        stats.unseen !== undefined ? `（未读 ${stats.unseen}）` : ""
                      }`
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
                                <span className="mail-default-badge">默认</span>
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
                                      text: `✓ 已将 ${acct.email} 设为默认收发邮箱。`,
                                      kind: "success",
                                    },
                                  });
                                } catch (err: any) {
                                  setState({
                                    mailListFeedback: {
                                      text: `❌ 设置默认失败：${err.message || ""}`,
                                      kind: "error",
                                    },
                                  });
                                }
                              }}
                            >
                              设为默认
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
                                  text: `正在测试 ${acct.email} 的收发连接…`,
                                  kind: "info",
                                },
                              });
                              try {
                                const res = await apiJson(
                                  `/api/integrations/mail/accounts/${encodeURIComponent(acct.id)}/test`,
                                  { method: "POST", body: JSON.stringify({}) }
                                );
                                const unseenInfo =
                                  res.unseen !== undefined ? `，未读 ${res.unseen} 封` : "";
                                setState({
                                  mailListFeedback: {
                                    text: `✓ ${acct.email} 连通正常（${res.latencyMs || 0}ms）：收件箱共 ${res.messages ?? 0} 封${unseenInfo}。`,
                                    kind: "success",
                                  },
                                });
                              } catch (err: any) {
                                setState({
                                  mailListFeedback: {
                                    text: `❌ ${acct.email} 测试失败：${err.message || ""}`,
                                    kind: "error",
                                  },
                                });
                              } finally {
                                setTestingAccountId(null);
                              }
                            }}
                          >
                            {testingAccountId === acct.id ? "测试中…" : "测试"}
                          </button>
                          <button
                            type="button"
                            className={`mail-acct-btn${isEditingThisAcct ? " is-active" : ""}`}
                            aria-expanded={isEditingThisAcct}
                            onClick={() => startEditingMailAccount(acct)}
                          >
                            {isEditingThisAcct ? "收起" : "编辑"}
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
                + 添加邮箱账号
              </button>
            </section>

            {(!mailEditorOpen || !editingMailAccountId) &&
              renderMailFormEditorShell(false, showMailCreateForm)}

            {/* MCP Skill Config Panel */}
            <section
              id="mcp-skill-config-panel"
              className="mcp-skill-config-panel"
              aria-label="MCP 服务连接与配置"
              hidden={!isMcpSkill}
            >
              <div className="mcp-status-card">
                <div className="mcp-status-head">
                  <span className="mcp-status-title">MCP 服务状态（stdio 本地直连）</span>
                  {!srv ? (
                    <span id="mcp-status-badge" className="mcp-status-badge">
                      检测中…
                    </span>
                  ) : srv.connected ? (
                    <span id="mcp-status-badge" className="mcp-status-badge is-online">
                      <span className="status-dot-inline is-ok" aria-hidden="true" />
                      已就绪 · {srv.toolCount || 0} 项工具
                    </span>
                  ) : srvBinMissing ? (
                    <span id="mcp-status-badge" className="mcp-status-badge is-offline">
                      <UiIcon
                        name="alert-triangle"
                        className="inline-ui-icon inline-status-svg is-warn"
                        size={13}
                      />
                      {isNonMacHost || srv?.unsupportedPlatform ? "当前系统不可用" : "未安装 KimiCU"}
                    </span>
                  ) : srvErr ? (
                    <span id="mcp-status-badge" className="mcp-status-badge is-offline">
                      <UiIcon
                        name="alert-triangle"
                        className="inline-ui-icon inline-status-svg is-warn"
                        size={13}
                      />
                      连接异常
                    </span>
                  ) : (
                    <span id="mcp-status-badge" className="mcp-status-badge">
                      <span className="status-dot-inline is-muted" aria-hidden="true" />
                      已就绪（按需拉起）
                    </span>
                  )}
                </div>
                <div id="mcp-status-detail" className="mcp-status-detail">
                  {!srv
                    ? isNonMacHost
                      ? "正在检测本地 MCP 服务状态…"
                      : `正在检测 ${
                          settings?.mcpServers?.[mcpServerId]?.command ||
                          defaultKimiConfig.command ||
                          "本地 MCP 服务"
                        } …`
                    : srv.connected
                      ? `${srv.serverInfo?.name || "kimi-cu"}${
                          srv.serverInfo?.version ? ` v${srv.serverInfo.version}` : ""
                        } 握手成功 · ${srvCmdText}`
                      : srvBinMissing
                        ? isNonMacHost || srv?.unsupportedPlatform
                          ? srvErr ||
                            "当前系统未安装或暂不支持 KimiCU（仅支持 macOS），如需使用其它本地 MCP 服务请在下方配置可执行路径。"
                          : `未在本机检测到可执行文件：${srv.command || "未配置"}。请先安装 KimiCU，或在下方修改 command 路径后点击「保存并连接测试」。`
                        : srvErr
                          ? `${srvErr}${srvCmdText ? `（${srvCmdText}）` : ""}`
                          : `已检测到可执行文件：${srvCmdText}。点击「重新握手检测」可立即验证工具列表。`}
                </div>
                <div
                  id="mcp-tools-chips"
                  className="mcp-tools-chips"
                  aria-label="已发现的 MCP 工具"
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
                <label htmlFor="mcp-config-json-input">MCP Server 配置（JSON）</label>
                <span className="mail-field-hint">
                  {isNonMacHost ? (
                    <>
                      填写兼容 stdio 协议的本地 MCP 可执行路径与参数（KimiCU 桌面软件操控目前仅支持
                      macOS）。
                    </>
                  ) : (
                    <>
                      默认调用 <code>/Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp -s user</code>
                      ，后台无感操控本机任意 Mac 桌面软件且不抢占物理鼠标指针。
                    </>
                  )}
                </span>
                <textarea
                  id="mcp-config-json-input"
                  className="inline-textarea mcp-json-textarea"
                  rows={8}
                  spellCheck={false}
                  aria-label="MCP Server JSON 配置"
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
                        mcpServerId
                      );
                    } catch (err: any) {
                      setState({
                        mcpFeedback: {
                          text: `❌ JSON 配置格式错误：${err.message}`,
                          kind: "error",
                        },
                      });
                      return;
                    }
                    setMcpBusy("save");
                    setState({
                      mcpFeedback: {
                        text: "正在保存 MCP 配置并启动本地握手检测…",
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
                            text: `✓ MCP 配置已保存，成功连接并发现 ${nextSrv.toolCount || 0} 项工具。`,
                            kind: "success",
                          },
                        });
                        showToast("KimiCU MCP 已连接就绪");
                      } else {
                        setState({
                          mcpFeedback: {
                            text: `⚠ 配置已保存，但握手未就绪：${
                              nextSrv?.error || nextSrv?.lastError || "请检查可执行文件路径"
                            }`,
                            kind: "error",
                          },
                        });
                      }
                    } catch (err: any) {
                      await refreshMcpSkillStatus(mcpServerId, false);
                      setState({
                        mcpFeedback: {
                          text: `❌ 连接失败：${err.message || ""}`,
                          kind: "error",
                        },
                      });
                    } finally {
                      setMcpBusy(null);
                    }
                  }}
                >
                  {mcpBusy === "save" ? "正在保存并握手…" : "保存并连接测试"}
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
                        text: "正在重新启动 MCP stdio 握手并读取工具列表…",
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
                            text: `✓ 重新握手成功（${
                              nextSrv.serverInfo?.version
                                ? `v${nextSrv.serverInfo.version}`
                                : "已就绪"
                            }），共 ${nextSrv.toolCount || 0} 项工具可用。`,
                            kind: "success",
                          },
                        });
                      } else {
                        setState({
                          mcpFeedback: {
                            text: `❌ 握手检测未通过：${
                              nextSrv?.error || nextSrv?.lastError || "无法拉起 MCP 进程"
                            }`,
                            kind: "error",
                          },
                        });
                      }
                    } catch (err: any) {
                      await refreshMcpSkillStatus(mcpServerId, false);
                      setState({
                        mcpFeedback: {
                          text: `❌ 握手检测失败：${err.message || ""}`,
                          kind: "error",
                        },
                      });
                    } finally {
                      setMcpBusy(null);
                    }
                  }}
                >
                  {mcpBusy === "test" ? "握手中…" : "重新握手检测"}
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
