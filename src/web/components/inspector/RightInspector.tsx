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
import { resolveBotComputerStatusDisplay } from "/shared/computer-status.js";
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
  const computerDisplays = useStore((s) => s.computerDisplays);

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

  // Computer card status (unified with SettingsModal & MobileSheets via resolveBotComputerStatusDisplay)
  const anySessionRunning =
    isSessionCurrentlyBusy(sessionStatus) ||
    Object.values(activeMap || {}).some((st) => isSessionCurrentlyBusy(st));
  const multiDisplayEnabled = hasConnectedNodeCapability("multi-display-v1", { diagnostics });
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
  });

  // Usage & route stats
  const totalTok = (Number(usage.input) || 0) + (Number(usage.output) || 0);
  const costSummary = computeClientSessionSummary({
    providers: settings?.providers || [],
    sessionUsageByProviderModel,
    sessionUsageByModel,
    usage,
    lastObservedModel,
  });
  const routeDisplay =
    formatClientRouteLabel(lastRouteLabel, lastObservedModel) || "自动调配";
  const complexityLabel: Record<string, string> = {
    trivial: "简单",
    standard: "常规",
    complex: "复杂",
  };
  const stepPlanText =
    Array.isArray(lastRoutePlan?.step_plan) && lastRoutePlan.step_plan.length > 0
      ? `分步计划：${lastRoutePlan.step_plan
          .map((sp: any) => {
            const range =
              sp.fromStep === sp.toStep ? `第${sp.fromStep}步` : `第${sp.fromStep}-${sp.toStep}步`;
            const mName =
              sp.model === "carbon" || sp.model === "advanced"
                ? "高级档"
                : sp.model === "argon" || sp.model === "medium"
                  ? "中等档"
                  : "极速档";
            const tName = sp.thinking ? ` ${sp.thinking}` : "";
            return `${range} ${mName}${tName}${sp.task ? `(${sp.task})` : ""}`;
          })
          .join(" → ")}`
      : "";
  const routeTipLines = [
    lastRouteReason ? `路由理由：${lastRouteReason}` : "",
    lastRoutePlan
      ? `任务画像：${complexityLabel[lastRoutePlan.complexity] || lastRoutePlan.complexity} · ${lastRoutePlan.category} · 置信度 ${Math.round((lastRoutePlan.confidence || 0) * 100)}%`
      : "",
    stepPlanText,
    lastTierPath ? `本轮档位路径：${lastTierPath}` : "",
  ].filter(Boolean);
  const routeTitle = routeTipLines.length ? routeTipLines.join("\n") : "当前路由档位";

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
    showToast("职责与人设已保存");
  };

  const handleAddGroupMember = async () => {
    if (!activeSession || activeSession.type !== "group") return;
    const existing = new Set(memberIds);
    const candidate = sessions.find((s: any) => s.type !== "group" && !existing.has(s.id));
    if (!candidate) {
      showToast("所有现有 Bot 均已在群内，可先新建专职 Bot");
      return;
    }
    const nextIds = [...existing, candidate.id];
    const updated = await apiJson(`/api/sessions/${activeSession.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memberBotIds: nextIds }),
    });
    upsertLocalSession(updated);
    showToast(`已将「${candidate.title}」拉入群聊`);
  };

  const handleRemoveGroupMember = async (member: any) => {
    if (!activeSession) return;
    const nextIds = memberIds.filter((id) => id !== member.id);
    if (nextIds.length < 2) {
      showToast("群聊至少保留 2 位 Bot 成员");
      return;
    }
    const ok = await showConfirmDialog({
      title: "移除群聊成员",
      message: `确定将「${member.title || "Bot"}」移出当前群聊吗？`,
      detail: "该成员仅移出当前群聊，其自身历史对话与配置不受影响。",
      confirmText: "确认移除",
      cancelText: "取消",
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
          title: `头像_${promptText.slice(0, 12)}`,
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
          ? `已降级为大模型生成头像（${data.degradedReason || "未配置生图模型"}）`
          : "已生成专属头像"
      );
    } catch (err: any) {
      showToast(`头像生成失败：${err?.message || "请稍后重试"}`);
    } finally {
      setAvatarGenerating(false);
    }
  };

  const handleUploadAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    const dataUrl = await cropImageFileToDataUrl(file, 128);
    await saveActiveAvatarPatch({ imageDataUrl: dataUrl });
    showToast("自定义图片头像已保存");
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
      aria-label="对话详情"
    >
      <div
        id="right-splitter"
        className="pane-splitter splitter-left"
        role="separator"
        aria-label="调整详情面板大小"
        onMouseDown={onStartRightResize}
      />

      <div className="inspector-top-bar">
        <div className="inspector-top-spacer" />
        <button
          id="close-inspector-btn"
          type="button"
          className="inspector-close-btn"
          title="关闭"
          aria-label="关闭"
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
            title="编辑 Bot 头像"
            aria-label="编辑 Bot 头像"
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

          {/* Secondary Popover: 头像编辑器 (Bot / 生成 / 上传) */}
          <div
            id="avatar-editor-popover"
            className="avatar-editor-popover"
            role="dialog"
            aria-label="头像编辑器"
            hidden={!isAvatarEditorOpen}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="avatar-editor-header">
              <div className="avatar-source-tabs" role="tablist" aria-label="头像来源">
                {(
                  [
                    ["bot", "Bot"],
                    ["generate", "生成"],
                    ["upload", "上传"],
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
                aria-label="将角色重置为默认"
                onClick={() => {
                  const isPrimary = activeSessionId === primarySessionId;
                  saveActiveAvatarPatch({
                    shape: "blob",
                    color: isPrimary ? "black" : "blue",
                    imageDataUrl: null,
                  });
                  showToast("已重置默认形象");
                }}
              >
                重置
              </button>
            </div>

            <div id="avatar-tab-bot" className="avatar-tab-pane" hidden={avatarTab !== "bot"}>
              <div
                id="avatar-shapes-grid"
                className="avatar-shapes-grid"
                role="group"
                aria-label="角色形状"
              >
                {BOT_SHAPES.map((s) => {
                  const selected = s.key === currentAvatar.shape && !currentAvatar.imageDataUrl;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={`avatar-shape-btn${selected ? " is-selected" : ""}`}
                      data-shape-key={s.key}
                      title={s.label}
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
                aria-label="角色颜色"
              >
                {BOT_COLORS.map((c) => {
                  const selected = c.key === currentAvatar.color && !currentAvatar.imageDataUrl;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      className={`avatar-color-btn${selected ? " is-selected" : ""}`}
                      data-color-key={c.key}
                      title={c.label}
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
                placeholder="输入画面描述，由已配置的生图模型生成专属头像（如：戴护目镜的彩虹小机器人扁平风头像）…"
                aria-label="描述你的头像"
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
                {avatarGenerating ? "AI 绘制中…" : "AI 生成头像"}
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
                <p className="upload-dropzone-title">拖入图片或点击选择文件</p>
                <p className="upload-dropzone-sub">自动居中裁剪为 128×128 高清圆形头像并保存</p>
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
                  选择图片
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
          aria-label="Bot 名称"
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={handleRenameCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />

        <div className="inspector-tabs" role="tablist" aria-label="对话详情">
          <button
            id="tab-activity"
            type="button"
            role="tab"
            aria-selected={inspectorTab === "activity" ? "true" : "false"}
            className={`inspector-tab${inspectorTab === "activity" ? " is-active" : ""}`}
            onClick={() => setState({ inspectorTab: "activity" })}
          >
            动态
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
            资料库
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
            <h3 className="section-label" id="group-members-count-label">
              {isGroup ? `${groupMembers.length} 位成员` : "成员"}
            </h3>
            <button
              id="add-group-member-btn"
              type="button"
              className="section-action-link"
              onClick={handleAddGroupMember}
            >
              + 添加成员
            </button>
          </div>
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
                  移除
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Bot Persona / Role Section */}
        <section className="inspector-section" id="bot-persona-section" hidden={isGroup}>
          <div className="section-header-row">
            <h3 className="section-label">职责与人设</h3>
            <button
              id="save-persona-btn"
              type="button"
              className="section-action-link"
              hidden={!personaDirty}
              onClick={handleSavePersona}
            >
              保存
            </button>
          </div>
          <textarea
            id="bot-persona-input"
            className="persona-textarea"
            rows={2}
            placeholder="设置该 Bot 的专属职责（例如：专门跟进工单、代码审查或管理某账号）..."
            value={personaInput}
            onChange={(e) => {
              setPersonaInput(e.target.value);
              setPersonaDirty(true);
            }}
          />
        </section>

        {/* Per-Bot Dedicated Memory Section */}
        <section className="inspector-section" id="bot-memory-section" hidden={isGroup}>
          <div className="section-header-row">
            <h3 className="section-label">
              专属记忆{" "}
              <span id="bot-memory-count-badge" className="section-sub-count">
                {memCountBadge}
              </span>
            </h3>
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
              + 新增
            </button>
          </div>
          <BotMemoriesList session={activeSession} listId="bot-memories-list" />
        </section>

        {/* Section: 即将进行 (Real Per-Bot Schedules) */}
        <section className="inspector-section" id="upcoming-section">
          <div className="section-header-row">
            <h3 className="section-label">即将进行</h3>
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
              + 新建
            </button>
          </div>
          <SchedulesList listId="upcoming-schedules-list" />
        </section>

        {/* Section: 电脑 */}
        <section className="inspector-section">
          <div className="section-header-row">
            <h3 className="section-label">电脑</h3>
            <span id="vnc-mode-badge" className="sr-only">
              {takeoverActive ? "人工接管中" : "只看不操作 (view_only=1)"}
            </span>
          </div>

          <div
            id="bot-computer-card"
            className="computer-card"
            role="button"
            tabIndex={0}
            aria-label="Bot 的电脑"
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
              <div className="computer-card-title">Bot 的电脑</div>
              <div id="computer-card-status" className="computer-card-sub">
                {compStatusText}
              </div>
            </div>
            <div className="computer-card-preview" id="computer-card-preview">
              <img
                id="computer-mini-thumb"
                className="computer-mini-thumb"
                src={computerMiniThumbUrl || undefined}
                alt="最新桌面画面预览"
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

        {/* Section: 模型用量 */}
        <section className="inspector-section">
          <div className="section-header-row">
            <h3 className="section-label">模型用量</h3>
          </div>
          <div className="kv-list">
            <div className="kv-row">
              <span className="kv-label">智能路由</span>
              <span className="kv-value" id="auto-route-indicator" title={routeTitle}>
                {routeDisplay}
              </span>
            </div>
            <div
              className="kv-row kv-row-interactive"
              id="open-trace-drawer-row"
              role="button"
              tabIndex={0}
              title="点击查看当前 Bot 的用量与账单"
              onClick={() => openBotUsageModal(activeSessionId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openBotUsageModal(activeSessionId);
                }
              }}
            >
              <span className="kv-label">用量与账单</span>
              <span className="kv-value kv-value-trailing">
                <span className="kv-value-summary">
                  <span id="step-count">{stepCount} 步</span> ·{" "}
                  <span id="token-usage" title="当前会话累计 Token">
                    {totalTok.toLocaleString()} tok
                  </span>
                </span>
                <span
                  id="session-cost-badge"
                  className="session-cost-inline"
                  title={`当前会话预估费用 ${formatCny(costSummary.costCny)}${
                    routerUsage.calls > 0
                      ? `\n其中路由判断 ${routerUsage.calls} 次 · ${routerUsage.tokens.toLocaleString()} tokens（按极速档计价）`
                      : ""
                  }`}
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

      {/* ==================== RIGHT TAB 2: 资料库 (Library) ==================== */}
      <div
        id="inspector-pane-library"
        className="inspector-body"
        hidden={inspectorTab !== "library"}
      >
        <div className="library-filter-pills" role="group" aria-label="类型">
          {(
            [
              ["all", "全部"],
              ["media", "媒体"],
              ["file", "文件"],
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
            <h3 className="section-label">工作区与会话产物</h3>
            <button
              id="refresh-library-btn"
              type="button"
              className="section-action-link"
              onClick={refreshLibrary}
            >
              刷新
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
