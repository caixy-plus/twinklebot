import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  BOT_COLORS,
  BOT_SHAPES,
  cropImageFileToDataUrl,
  getBotColorLabel,
  getBotShapeLabel,
  resolveBotAvatar,
} from "../../avatars.js";
import {
  closeAllPopovers,
  handleBotComputerCardActivate,
  openBotUsageModal,
  refreshLibrary,
  saveActiveAvatarPatch,
  showConfirmDialog,
  showToast,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { hasConnectedNodeCapability } from "../../services/ota-updater.js";
import { useI18n } from "../../services/i18n.js";
import { resolveBotComputerStatusDisplay } from "/shared/computer-status.js";
import {
  formatBrowserAutomationModeLabel,
  normalizeBotBrowserMode,
  normalizeBrowserAutomationMode,
} from "/shared/browser-automation.js";
import {
  computeClientSessionSummary,
  formatClientRouteLabel,
  formatCny,
  isSessionCurrentlyBusy,
} from "../../state/helpers.js";
import {
  getActiveSessionFromState,
  setState,
  useStore,
} from "../../state/store.js";
import { MascotSvg, SessionAvatar } from "../common/AvatarView.js";
import {
  BotMemoriesList,
  LibraryItemsPanel,
  MemoryConsolidatePreviewCard,
  SchedulesList,
} from "../common/SharedPanels.js";

export function RightInspector({
  onCloseInspector,
  onStartRightResize,
}: {
  onCloseInspector: () => void;
  onStartRightResize: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const activeSession = useStore((s) => getActiveSessionFromState(s));
  const activeSessionId = useStore((s) => s.activeSessionId);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const inspectorTab = useStore((s) => s.inspectorTab);
  const takeoverActive = useStore((s) => s.takeoverActive);
  const openPopover = useStore((s) => s.openPopover);
  const computerStatus = useStore((s) => s.computerStatus);
  const computerMiniThumbUrl = useStore((s) => s.computerMiniThumbUrl);
  const activeMap = useStore((s) => s.activeMap);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const settings = useStore((s) => s.settings);
  const stepCount = useStore((s) => s.stepCount);
  const usage = useStore((s) => s.usage);
  const sessionUsageByModel = useStore((s) => s.sessionUsageByModel);
  const sessionUsageByProviderModel = useStore((s) => s.sessionUsageByProviderModel);
  const lastObservedModel = useStore((s) => s.lastObservedModel);
  const lastRouteLabel = useStore((s) => s.lastRouteLabel);
  const lastRouteReason = useStore((s) => s.lastRouteReason);
  const lastRoutePlan = useStore((s) => s.lastRoutePlan);
  const lastTierPath = useStore((s) => s.lastTierPath);
  const routerUsage = useStore((s) => s.routerUsage);
  const libraryFilter = useStore((s) => s.libraryFilter);
  const diagnostics = useStore((s) => s.diagnostics);
  const { locale, t } = useI18n();
  const computerDisplays = useStore((s) => s.computerDisplays);
  const schedules = useStore((s) => s.schedules);

  type CollapsibleSectionKey = "groupMembers" | "botMemory" | "upcoming";
  const [sectionExpandedOverrides, setSectionExpandedOverrides] = useState<
    Partial<Record<CollapsibleSectionKey, boolean>>
  >({});
  const [botConsolidating, setBotConsolidating] = useState(false);
  const [applyingBotConsolidate, setApplyingBotConsolidate] = useState(false);
  const [botConsolidatePlan, setBotConsolidatePlan] = useState<any>(null);

  useEffect(() => {
    setSectionExpandedOverrides({});
    setBotConsolidatePlan(null);
  }, [activeSessionId]);

  const isSectionExpanded = (key: CollapsibleSectionKey, itemCount: number): boolean => {
    const override = sectionExpandedOverrides[key];
    if (typeof override === "boolean") return override;
    return itemCount < 2;
  };

  const toggleSectionExpanded = (key: CollapsibleSectionKey, currentExpanded: boolean) => {
    setSectionExpandedOverrides((prev) => ({
      ...prev,
      [key]: !currentExpanded,
    }));
  };

  const displayName =
    activeSession?.title && activeSession.title !== "New Session"
      ? activeSession.title
      : "Twinkle";
  const isGroup = activeSession?.type === "group";

  const [nameInput, setNameInput] = useState(displayName);
  const [personaInput, setPersonaInput] = useState(activeSession?.rolePrompt || "");
  const [personaDirty, setPersonaDirty] = useState(false);

  const [avatarTab, setAvatarTab] = useState<"bot" | "generate" | "upload">("bot");
  const [avatarPrompt, setAvatarPrompt] = useState("");
  const [avatarGenerating, setAvatarGenerating] = useState(false);

  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setNameInput(displayName);
  }, [activeSessionId, displayName]);

  useEffect(() => {
    setPersonaInput(activeSession?.rolePrompt || "");
    setPersonaDirty(false);
  }, [activeSessionId, activeSession?.rolePrompt]);

  const currentAvatar = resolveBotAvatar(activeSession, primarySessionId);

  const memories = Array.isArray(activeSession?.memories) ? activeSession.memories : [];
  const activeMemCount = memories.filter((m: any) => m && m.enabled !== false).length;
  const memCountBadge = memories.length > 0 ? `(${activeMemCount}/${memories.length})` : "";

  const memberIds: string[] = Array.isArray(activeSession?.memberBotIds)
    ? activeSession.memberBotIds
    : [];
  const groupMembers = memberIds
    .map((id) => sessions.find((s: any) => s.id === id))
    .filter(Boolean);

  const sessionSchedules = (Array.isArray(schedules) ? schedules : []).filter(
    (s: any) => !activeSessionId || s.sessionId === activeSessionId
  );
  const schedulesCount = sessionSchedules.length;
  const schedCountBadge = schedulesCount > 0 ? `(${schedulesCount})` : "";

  const groupMembersExpanded = isSectionExpanded("groupMembers", groupMembers.length);
  const botMemoryExpanded = isSectionExpanded("botMemory", memories.length);
  const upcomingExpanded = isSectionExpanded("upcoming", schedulesCount);

  // Computer card status (unified with SettingsModal & MobileSheets via resolveBotComputerStatusDisplay)
  const anySessionRunning =
    isSessionCurrentlyBusy(sessionStatus) ||
    Object.values(activeMap || {}).some((st) => isSessionCurrentlyBusy(st));
  const multiDisplayEnabled = hasConnectedNodeCapability("multi-display-v1", { diagnostics });
  const supportsMemoryGovernance = hasConnectedNodeCapability("memory-governance-v1", {
    diagnostics,
  });

  const handleConsolidateBotMemories = async () => {
    if (!activeSession?.id || botConsolidating) return;
    setBotConsolidating(true);
    setSectionExpandedOverrides((prev) => ({ ...prev, botMemory: true }));
    try {
      const res = await apiJson("/api/memories/consolidate", {
        method: "POST",
        body: JSON.stringify({ scope: "bot", sessionId: activeSession.id }),
      });
      setBotConsolidatePlan(res?.plan || null);
    } catch (err: any) {
      showToast(
        t("memory.consolidateFailedToast", {
          error: err?.message || t("actions.requestError"),
        })
      );
    } finally {
      setBotConsolidating(false);
    }
  };

  const handleApplyBotConsolidate = async () => {
    if (!activeSession?.id || !botConsolidatePlan || applyingBotConsolidate) return;
    setApplyingBotConsolidate(true);
    try {
      const res = await apiJson("/api/memories/consolidate/apply", {
        method: "POST",
        body: JSON.stringify({
          scope: "bot",
          sessionId: activeSession.id,
          proposedList: botConsolidatePlan.proposedList || [],
        }),
      });
      if (Array.isArray(res?.memories)) {
        upsertLocalSession({ ...activeSession, memories: res.memories });
      }
      setBotConsolidatePlan(null);
      showToast(
        t("memory.consolidateAppliedToast", {
          count: String(res?.count ?? res?.memories?.length ?? 0),
        })
      );
    } catch (err: any) {
      showToast(
        t("memory.consolidateFailedToast", {
          error: err?.message || t("actions.requestError"),
        })
      );
    } finally {
      setApplyingBotConsolidate(false);
    }
  };
  const {
    compState,
    isCompOnline,
    isSleeping,
    cardStatusText: compStatusText,
  } = resolveBotComputerStatusDisplay(computerStatus, {
    sessionStatus,
    takeoverActive,
    anySessionRunning,
    multiDisplayEnabled,
    computerDisplays,
    activeSessionId: activeSession?.id,
    locale,
  });

  // Usage & route stats
  const totalTok = (Number(usage.input) || 0) + (Number(usage.output) || 0);
  const costSummary = computeClientSessionSummary({
    providers: settings?.providers || [],
    sessionUsageByProviderModel,
    sessionUsageByModel,
    usage,
    lastObservedModel,
    locale,
  });
  const routeDisplay =
    formatClientRouteLabel(lastRouteLabel, lastObservedModel, locale) || t("actions.autoRouting");
  const complexityLabel: Record<string, string> = {
    trivial: t("inspector.complexityTrivial"),
    standard: t("inspector.complexityStandard"),
    complex: t("inspector.complexityComplex"),
  };
  const stepPlanText =
    Array.isArray(lastRoutePlan?.step_plan) && lastRoutePlan.step_plan.length > 0
      ? t("inspector.stepPlanPrefix", {
          plan: lastRoutePlan.step_plan
            .map((sp: any) => {
              const range =
                sp.fromStep === sp.toStep
                  ? t("inspector.stepRangeSingle", { step: sp.fromStep })
                  : t("inspector.stepRangeMulti", { from: sp.fromStep, to: sp.toStep });
              const mName =
                sp.model === "carbon" || sp.model === "advanced"
                  ? t("inspector.tierAdvanced")
                  : sp.model === "argon" || sp.model === "medium"
                    ? t("inspector.tierMedium")
                    : t("inspector.tierFast");
              const tName = sp.thinking ? ` ${sp.thinking}` : "";
              return `${range} ${mName}${tName}${sp.task ? `(${sp.task})` : ""}`;
            })
            .join(" → "),
        })
      : "";
  const routeTipLines = [
    lastRouteReason ? t("inspector.routeReasonLine", { reason: lastRouteReason }) : "",
    lastRoutePlan
      ? t("inspector.routeTaskLine", {
          complexity: complexityLabel[lastRoutePlan.complexity] || lastRoutePlan.complexity,
          category: lastRoutePlan.category,
          confidence: Math.round((lastRoutePlan.confidence || 0) * 100),
        })
      : "",
    stepPlanText,
    lastTierPath ? t("inspector.routeTierPathLine", { path: lastTierPath }) : "",
  ].filter(Boolean);
  const routeTitle = routeTipLines.length
    ? routeTipLines.join("\n")
    : t("inspector.routeDefaultTitle");

  const handleRenameCommit = async () => {
    const title = nameInput.trim();
    if (!title || !activeSessionId || title === displayName) return;
    const updated = await apiJson(`/api/sessions/${activeSessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title, touch: false }),
    });
    upsertLocalSession(updated);
  };

  const handleSavePersona = async () => {
    if (!activeSessionId) return;
    const updated = await apiJson(`/api/sessions/${activeSessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ rolePrompt: personaInput.trim(), touch: false }),
    });
    upsertLocalSession(updated);
    setPersonaDirty(false);
    showToast(t("inspector.personaSaved"));
  };

  const handleAddGroupMember = async () => {
    if (!activeSession || activeSession.type !== "group") return;
    const existing = new Set(memberIds);
    const candidate = sessions.find((s: any) => s.type !== "group" && !existing.has(s.id));
    if (!candidate) {
      showToast(t("inspector.allBotsInGroupToast"));
      return;
    }
    const nextIds = [...existing, candidate.id];
    const updated = await apiJson(`/api/sessions/${activeSession.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memberBotIds: nextIds }),
    });
    upsertLocalSession(updated);
    showToast(t("inspector.addedToGroupToast", { name: candidate.title }));
  };

  const handleRemoveGroupMember = async (member: any) => {
    if (!activeSession) return;
    const nextIds = memberIds.filter((id) => id !== member.id);
    if (nextIds.length < 2) {
      showToast(t("inspector.groupMinMembersToast"));
      return;
    }
    const ok = await showConfirmDialog({
      title: t("inspector.removeMemberTitle"),
      message: t("inspector.removeMemberMsg", { name: member.title || "Bot" }),
      detail: t("inspector.removeMemberDetail"),
      confirmText: t("inspector.removeMemberConfirm"),
      cancelText: t("common.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    const updated = await apiJson(`/api/sessions/${activeSession.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memberBotIds: nextIds }),
    });
    upsertLocalSession(updated);
  };

  const handleGenerateAvatar = async () => {
    const promptText = avatarPrompt.trim();
    if (!promptText) return;
    setAvatarGenerating(true);
    try {
      const data = await apiJson("/api/images/generate", {
        method: "POST",
        noLanTimeout: true,
        body: JSON.stringify({
          prompt: `Cute minimalist flat vector avatar icon, centered mascot character, clean solid pastel background, no text: ${promptText}`,
          title: t("inspector.avatarTitlePrefix", { name: promptText.slice(0, 12) }),
          aspectRatio: "1:1",
          quality: "standard",
          sessionId: activeSessionId || undefined,
        }),
      });
      if (!data?.dataUrl) {
        throw new Error(data?.error || "generate failed");
      }
      const isSvgAvatar =
        data.mimeType === "image/svg+xml" ||
        String(data.dataUrl).startsWith("data:image/svg+xml");
      const avatarDataUrl = isSvgAvatar
        ? data.dataUrl
        : await new Promise<string>((resolve) => {
            const img = new Image();
            img.onload = () => {
              const cv = document.createElement("canvas");
              cv.width = 128;
              cv.height = 128;
              const ctx = cv.getContext("2d")!;
              ctx.drawImage(img, 0, 0, 128, 128);
              resolve(cv.toDataURL("image/png"));
            };
            img.onerror = () => resolve(data.dataUrl);
            img.src = data.dataUrl;
          });
      await saveActiveAvatarPatch({ imageDataUrl: avatarDataUrl });
      refreshLibrary();
      showToast(
        data.degraded
          ? t("inspector.avatarDegradedToast", {
              reason: data.degradedReason || t("inspector.avatarNoImageModel"),
            })
          : t("inspector.avatarGeneratedToast")
      );
    } catch (err: any) {
      showToast(
        t("inspector.avatarFailedToast", {
          error: err?.message || t("inspector.retryLater"),
        })
      );
    } finally {
      setAvatarGenerating(false);
    }
  };

  const handleUploadAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    const dataUrl = await cropImageFileToDataUrl(file, 128, locale);
    await saveActiveAvatarPatch({ imageDataUrl: dataUrl });
    showToast(t("inspector.avatarUploadedToast"));
  };

  const handleDropAvatar = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) {
      await handleUploadAvatarFile(file);
    }
  };

  const isAvatarEditorOpen = openPopover === "avatar-editor";

  return (
    <aside
      className="inspector-right"
      id="desktop-pane"
      data-takeover={takeoverActive ? "true" : "false"}
      aria-label={t("inspector.title")}
    >
      <div
        id="right-splitter"
        className="pane-splitter splitter-left"
        role="separator"
        aria-label={t("inspector.resizeAria")}
        onMouseDown={onStartRightResize}
      />

      <div className="inspector-top-bar">
        <div className="inspector-top-spacer" />
        <button
          id="close-inspector-btn"
          type="button"
          className="inspector-close-btn"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onCloseInspector}
        >
          <svg className="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M5.5 5.5L14.5 14.5M14.5 5.5L5.5 14.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Bot Avatar + Editable Name + Tabs */}
      <div className="inspector-profile" id="inspector-profile">
        <div className="avatar-editor-anchor">
          <button
            id="edit-avatar-btn"
            type="button"
            className="inspector-avatar-btn"
            title={t("inspector.editAvatarBtn")}
            aria-label={t("inspector.editAvatarBtn")}
            onClick={(e) => {
              e.stopPropagation();
              const nextOpen = !isAvatarEditorOpen;
              closeAllPopovers();
              if (nextOpen) setState({ openPopover: "avatar-editor" });
            }}
          >
            <div id="inspector-avatar-slot" className="inspector-avatar-slot">
              {activeSession ? (
                <SessionAvatar
                  session={activeSession}
                  allSessions={sessions}
                  primaryId={primarySessionId}
                  sizeVariant="lg"
                />
              ) : (
                <MascotSvg shapeKey="blob" colorKey="black" />
              )}
            </div>
          </button>

          {/* Secondary Popover: Avatar Editor */}
          <div
            id="avatar-editor-popover"
            className="avatar-editor-popover"
            role="dialog"
            aria-label={t("inspector.avatarEditorAria")}
            hidden={!isAvatarEditorOpen}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="avatar-editor-header">
              <div className="avatar-source-tabs" role="tablist" aria-label={t("inspector.avatarSourceAria")}>
                {(
                  [
                    ["bot", "Bot"],
                    ["generate", t("inspector.avatarTabGenerate")],
                    ["upload", t("inspector.avatarTabUpload")],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    className={`avatar-source-tab${avatarTab === key ? " is-active" : ""}`}
                    data-avatar-tab={key}
                    aria-selected={avatarTab === key ? "true" : "false"}
                    onClick={() => setAvatarTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                id="reset-avatar-btn"
                type="button"
                className="avatar-reset-btn"
                aria-label={t("inspector.avatarResetAria")}
                onClick={() => {
                  const isPrimary = activeSessionId === primarySessionId;
                  saveActiveAvatarPatch({
                    shape: "blob",
                    color: isPrimary ? "black" : "blue",
                    imageDataUrl: null,
                  });
                  showToast(t("inspector.avatarResetToast"));
                }}
              >
                {t("inspector.avatarResetBtn")}
              </button>
            </div>

            <div id="avatar-tab-bot" className="avatar-tab-pane" hidden={avatarTab !== "bot"}>
              <div
                id="avatar-shapes-grid"
                className="avatar-shapes-grid"
                role="group"
                aria-label={t("inspector.avatarShapeGroupAria")}
              >
                {BOT_SHAPES.map((s) => {
                  const selected = s.key === currentAvatar.shape && !currentAvatar.imageDataUrl;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={`avatar-shape-btn${selected ? " is-selected" : ""}`}
                      data-shape-key={s.key}
                      title={getBotShapeLabel(s.key, locale)}
                      onClick={() =>
                        saveActiveAvatarPatch({ shape: s.key, imageDataUrl: null })
                      }
                    >
                      <MascotSvg shapeKey={s.key} colorKey={currentAvatar.color} />
                    </button>
                  );
                })}
              </div>
              <div
                id="avatar-colors-grid"
                className="avatar-colors-grid"
                role="group"
                aria-label={t("inspector.avatarColorGroupAria")}
              >
                {BOT_COLORS.map((c) => {
                  const selected = c.key === currentAvatar.color && !currentAvatar.imageDataUrl;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      className={`avatar-color-btn${selected ? " is-selected" : ""}`}
                      data-color-key={c.key}
                      title={getBotColorLabel(c.key, locale)}
                      onClick={() =>
                        saveActiveAvatarPatch({ color: c.key, imageDataUrl: null })
                      }
                    >
                      <span
                        className="avatar-color-swatch"
                        style={{ background: c.swatch }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              id="avatar-tab-generate"
              className="avatar-tab-pane"
              hidden={avatarTab !== "generate"}
            >
              <textarea
                id="avatar-prompt-input"
                className="avatar-prompt-textarea"
                placeholder={t("inspector.avatarPromptPlaceholder")}
                aria-label={t("inspector.avatarPromptAria")}
                value={avatarPrompt}
                onChange={(e) => setAvatarPrompt(e.target.value)}
              />
              <button
                id="avatar-generate-submit"
                type="button"
                className="avatar-generate-btn"
                disabled={avatarGenerating || !avatarPrompt.trim()}
                onClick={handleGenerateAvatar}
              >
                {avatarGenerating
                  ? t("inspector.avatarGeneratingBtn")
                  : t("inspector.avatarGenerateBtn")}
              </button>
            </div>

            <div
              id="avatar-tab-upload"
              className="avatar-tab-pane"
              hidden={avatarTab !== "upload"}
            >
              <div
                className="avatar-upload-dropzone"
                id="avatar-upload-dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDropAvatar}
              >
                <p className="upload-dropzone-title">{t("inspector.uploadDropTitle")}</p>
                <p className="upload-dropzone-sub">{t("inspector.uploadDropSub")}</p>
                <input
                  ref={avatarFileInputRef}
                  id="avatar-file-input"
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    await handleUploadAvatarFile(file);
                  }}
                />
                <button
                  id="avatar-upload-trigger"
                  type="button"
                  className="settings-pill-btn"
                  onClick={() => avatarFileInputRef.current?.click()}
                >
                  {t("inspector.uploadPickBtn")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <input
          id="inspector-bot-name-input"
          type="text"
          className="inspector-name-input"
          value={nameInput}
          aria-label={t("inspector.botNameAria")}
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={handleRenameCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />

        <div className="inspector-tabs" role="tablist" aria-label={t("inspector.title")}>
          <button
            id="tab-activity"
            type="button"
            role="tab"
            aria-selected={inspectorTab === "activity" ? "true" : "false"}
            className={`inspector-tab${inspectorTab === "activity" ? " is-active" : ""}`}
            onClick={() => setState({ inspectorTab: "activity" })}
          >
            {t("inspector.tabActivity")}
          </button>
          <button
            id="tab-library"
            type="button"
            role="tab"
            aria-selected={inspectorTab === "library" ? "true" : "false"}
            className={`inspector-tab${inspectorTab === "library" ? " is-active" : ""}`}
            onClick={() => {
              setState({ inspectorTab: "library" });
              refreshLibrary();
            }}
          >
            {t("inspector.tabLibrary")}
          </button>
        </div>
      </div>

      {/* ==================== RIGHT TAB 1: 动态 (Activity) ==================== */}
      <div
        id="inspector-pane-activity"
        className="inspector-body"
        hidden={inspectorTab !== "activity"}
      >
        {/* Group Members Section */}
        <section className="inspector-section" id="group-members-section" hidden={!isGroup}>
          <div className="section-header-row">
            <button
              id="group-members-toggle-btn"
              type="button"
              className="section-collapse-toggle"
              aria-expanded={groupMembersExpanded}
              aria-controls="group-members-body"
              onClick={() => toggleSectionExpanded("groupMembers", groupMembersExpanded)}
            >
              <span className="section-label" id="group-members-count-label">
                {isGroup
                  ? t("inspector.membersCount", { count: groupMembers.length })
                  : t("inspector.memberFallback")}
              </span>
              <svg
                className="section-collapse-chevron"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4.5 2.5L8 6L4.5 9.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              id="add-group-member-btn"
              type="button"
              className="section-action-link"
              onClick={handleAddGroupMember}
            >
              {t("inspector.addMember")}
            </button>
          </div>
          <div id="group-members-body" className="inspector-section-body" hidden={!groupMembersExpanded}>
            <div className="grouped-card" id="group-members-list">
              {groupMembers.map((m: any) => (
                <div key={m.id} className="grouped-row-btn" style={{ cursor: "default" }}>
                  <span style={{ width: "24px", height: "24px", display: "inline-flex" }}>
                    <SessionAvatar
                      session={m}
                      allSessions={sessions}
                      primaryId={primarySessionId}
                    />
                  </span>
                  <span className="grouped-row-text">{m.title || "Bot"}</span>
                  <button
                    type="button"
                    className="section-action-link danger-text"
                    onClick={() => handleRemoveGroupMember(m)}
                  >
                    {t("common.remove")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Bot Persona / Role Section */}
        <section className="inspector-section" id="bot-persona-section" hidden={isGroup}>
          <div className="section-header-row">
            <h3 className="section-label">{t("inspector.personaLabel")}</h3>
            <button
              id="save-persona-btn"
              type="button"
              className="section-action-link"
              hidden={!personaDirty}
              onClick={handleSavePersona}
            >
              {t("common.save")}
            </button>
          </div>
          <textarea
            id="bot-persona-input"
            className="persona-textarea"
            rows={2}
            placeholder={t("inspector.personaPlaceholder")}
            value={personaInput}
            onChange={(e) => {
              setPersonaInput(e.target.value);
              setPersonaDirty(true);
            }}
          />
        </section>

        {/* Per-Bot Browser Automation Mode Override (#8) */}
        {!isGroup &&
          hasConnectedNodeCapability("local-browser-automation-v1", { diagnostics }) && (
            <section className="inspector-section" id="bot-browser-mode-section">
              <div className="section-header-row">
                <h3 className="section-label">{t("inspector.browserEngineLabel")}</h3>
              </div>
              <select
                id="bot-browser-mode-select"
                className="settings-select"
                style={{ width: "100%" }}
                aria-label={t("inspector.browserEngineLabel")}
                value={normalizeBotBrowserMode(activeSession?.browserMode)}
                onChange={async (e) => {
                  if (!activeSessionId) return;
                  const browserMode = normalizeBotBrowserMode(e.target.value);
                  try {
                    const updated = await apiJson(`/api/sessions/${activeSessionId}`, {
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

        {/* Per-Bot Dedicated Memory Section */}
        <section className="inspector-section" id="bot-memory-section" hidden={isGroup}>
          <div className="section-header-row">
            <button
              id="bot-memory-toggle-btn"
              type="button"
              className="section-collapse-toggle"
              aria-expanded={botMemoryExpanded}
              aria-controls="bot-memory-body"
              onClick={() => toggleSectionExpanded("botMemory", botMemoryExpanded)}
            >
              <span className="section-label">
                {t("inspector.memoryLabel")}{" "}
                <span id="bot-memory-count-badge" className="section-sub-count">
                  {memCountBadge}
                </span>
              </span>
              <svg
                className="section-collapse-chevron"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4.5 2.5L8 6L4.5 9.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div className="memory-header-actions">
              {supportsMemoryGovernance && memories.length >= 2 && (
                <button
                  id="consolidate-bot-memory-btn"
                  type="button"
                  className="section-action-link"
                  disabled={botConsolidating}
                  onClick={handleConsolidateBotMemories}
                >
                  {botConsolidating ? t("memory.consolidatingBtn") : t("memory.consolidateBtn")}
                </button>
              )}
              <button
                id="new-bot-memory-btn"
                type="button"
                className="section-action-link"
                onClick={() => {
                  setState({
                    botMemoryModal: {
                      open: true,
                      sessionId: activeSession?.id || null,
                      memoryId: null,
                      name: "",
                      content: "",
                      category: "general",
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
          </div>
          <div id="bot-memory-body" className="inspector-section-body" hidden={!botMemoryExpanded}>
            <MemoryConsolidatePreviewCard
              plan={botConsolidatePlan}
              applying={applyingBotConsolidate}
              idPrefix="bot"
              onApply={handleApplyBotConsolidate}
              onCancel={() => setBotConsolidatePlan(null)}
            />
            <BotMemoriesList session={activeSession} listId="bot-memories-list" />
          </div>
        </section>

        {/* Section: Upcoming Schedules */}
        <section className="inspector-section" id="upcoming-section">
          <div className="section-header-row">
            <button
              id="upcoming-toggle-btn"
              type="button"
              className="section-collapse-toggle"
              aria-expanded={upcomingExpanded}
              aria-controls="upcoming-body"
              onClick={() => toggleSectionExpanded("upcoming", upcomingExpanded)}
            >
              <span className="section-label">
                {t("inspector.schedulesLabel")}{" "}
                <span id="upcoming-schedule-count-badge" className="section-sub-count">
                  {schedCountBadge}
                </span>
              </span>
              <svg
                className="section-collapse-chevron"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4.5 2.5L8 6L4.5 9.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              id="new-schedule-btn"
              type="button"
              className="section-action-link"
              onClick={() => {
                setState({ scheduleModalOpen: true, editingScheduleId: null });
                requestAnimationFrame(() => {
                  (document.getElementById("sched-title-input") as HTMLInputElement | null)?.focus();
                });
              }}
            >
              {t("inspector.schedulesAdd")}
            </button>
          </div>
          <div id="upcoming-body" className="inspector-section-body" hidden={!upcomingExpanded}>
            <SchedulesList listId="upcoming-schedules-list" />
          </div>
        </section>

        {/* Section: Computer */}
        <section className="inspector-section">
          <div className="section-header-row">
            <h3 className="section-label">{t("inspector.computerSection")}</h3>
            <span id="vnc-mode-badge" className="sr-only">
              {takeoverActive ? t("inspector.vncTakeover") : t("inspector.vncViewOnly")}
            </span>
          </div>

          <div
            id="bot-computer-card"
            className="computer-card"
            role="button"
            tabIndex={0}
            aria-label={t("inspector.botComputerLabel")}
            data-computer-state={compState}
            data-computer-online={isCompOnline ? "true" : "false"}
            onClick={handleBotComputerCardActivate}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleBotComputerCardActivate();
              }
            }}
          >
            <div className="computer-card-info">
              <div className="computer-card-title">{t("inspector.botComputerLabel")}</div>
              <div id="computer-card-status" className="computer-card-sub">
                {compStatusText}
              </div>
            </div>
            <div className="computer-card-preview" id="computer-card-preview">
              <img
                id="computer-mini-thumb"
                className="computer-mini-thumb"
                src={computerMiniThumbUrl || undefined}
                alt={t("inspector.computerThumbAlt")}
                hidden={!computerMiniThumbUrl}
              />
              <div
                className="computer-mini-placeholder"
                id="computer-mini-placeholder"
                hidden={Boolean(computerMiniThumbUrl)}
              >
                <span
                  className="sleep-zz"
                  id="computer-sleep-zz"
                  aria-hidden="true"
                  hidden={!isSleeping}
                >
                  z<sup>z</sup>
                </span>
                <svg className="mini-blob-svg" viewBox="0 0 64 64" aria-hidden="true">
                  <path
                    d="M32 6C34 6 35.6 7.6 35.6 9.6C35.6 10.9 34.8 12.1 33.6 12.7V15H40C47.2 15 52.5 20.3 52.5 27.5V28.6H54C55.9 28.6 57.4 30.1 57.4 32V36.8C57.4 38.7 55.9 40.2 54 40.2H52.5V42C52.5 49.2 47.2 54.5 40 54.5H24C16.8 54.5 11.5 49.2 11.5 42V40.2H10C8.1 40.2 6.6 38.7 6.6 36.8V32C6.6 30.1 8.1 28.6 10 28.6H11.5V27.5C11.5 20.3 16.8 15 24 15H30.4V12.7C29.2 12.1 28.4 10.9 28.4 9.6C28.4 7.6 30 6 32 6Z"
                    fill="currentColor"
                    fillOpacity="0.24"
                  />
                  <rect x="17" y="27" width="30" height="14" rx="7" fill="var(--bg-card)" fillOpacity="0.55" />
                  <rect x="22" y="32.8" width="5.6" height="2.4" rx="1.2" fill="var(--bg-card)" />
                  <rect x="36.4" y="32.8" width="5.6" height="2.4" rx="1.2" fill="var(--bg-card)" />
                </svg>
              </div>
            </div>
          </div>
        </section>

        {/* Section: Model Usage */}
        <section className="inspector-section">
          <div className="section-header-row">
            <h3 className="section-label">{t("inspector.modelUsageSection")}</h3>
          </div>
          <div className="kv-list">
            <div className="kv-row">
              <span className="kv-label">{t("inspector.smartRouting")}</span>
              <span className="kv-value" id="auto-route-indicator" title={routeTitle}>
                {routeDisplay}
              </span>
            </div>
            <div
              className="kv-row kv-row-interactive"
              id="open-trace-drawer-row"
              role="button"
              tabIndex={0}
              title={t("inspector.openUsageTitle")}
              onClick={() => openBotUsageModal(activeSessionId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openBotUsageModal(activeSessionId);
                }
              }}
            >
              <span className="kv-label">{t("inspector.usageAndBilling")}</span>
              <span className="kv-value kv-value-trailing">
                <span className="kv-value-summary">
                  <span id="step-count">{t("chat.traceStepsCount", { count: stepCount })}</span> ·{" "}
                  <span id="token-usage" title={t("inspector.tokenUsageTitle")}>
                    {totalTok.toLocaleString()} tok
                  </span>
                </span>
                <span
                  id="session-cost-badge"
                  className="session-cost-inline"
                  title={t("inspector.sessionCostTitle", {
                    cost: formatCny(costSummary.costCny),
                    routerNote:
                      routerUsage.calls > 0
                        ? t("inspector.sessionRouterCostNote", {
                            calls: routerUsage.calls,
                            tokens: routerUsage.tokens.toLocaleString(),
                          })
                        : "",
                  })}
                >
                  ≈ {formatCny(costSummary.costCny)}
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
              </span>
            </div>
          </div>
        </section>
      </div>

      {/* ==================== RIGHT TAB 2: Library ==================== */}
      <div
        id="inspector-pane-library"
        className="inspector-body"
        hidden={inspectorTab !== "library"}
      >
        <div className="library-filter-pills" role="group" aria-label={t("inspector.libraryTypeAria")}>
          {(
            [
              ["all", t("inspector.libraryAll")],
              ["media", t("inspector.libraryMedia")],
              ["file", t("inspector.libraryFiles")],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`filter-pill${libraryFilter === key ? " is-active" : ""}`}
              data-lib-filter={key}
              onClick={() => setState({ libraryFilter: key })}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="inspector-section">
          <div className="section-header-row">
            <h3 className="section-label">{t("inspector.libraryArtifactsTitle")}</h3>
            <button
              id="refresh-library-btn"
              type="button"
              className="section-action-link"
              onClick={refreshLibrary}
            >
              {t("common.refresh")}
            </button>
          </div>
          <div className="library-card">
            <LibraryItemsPanel listId="library-list" expandBtnId="library-expand-btn" />
          </div>
        </section>
      </div>
    </aside>
  );
}
