import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { parseRelayInvite } from "/accounts-store.js";
import {
  describeCronExpression,
  getNextCronDates,
  parseCronExpression,
  resolvePresetCronExpression,
} from "/shared/cron.js";
import {
  VALID_MEMORY_CATEGORIES,
  normalizeMemoryCategory,
} from "/shared/entities.js";
import { isNativeQrScannerAvailable, scanQrCodeNative } from "../../mobile-bridge.js";
import { buildPreviewSrcdoc } from "../../preview-utils.js";
import {
  importRemoteAccountFromInput,
  openBotScreenOverlay,
  openNewChatBar,
  openSettingsModal,
  refreshSchedules,
  selectSession,
  showToast,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { useI18n } from "../../services/i18n.js";
import { hasConnectedNodeCapability } from "../../services/ota-updater.js";
import { getBgModes } from "../../state/constants.js";
import {
  formatClockTime,
  teardownPreviewIframe,
} from "../../state/helpers.js";
import { getState, setState, useStore } from "../../state/store.js";
import { SessionAvatar } from "../common/AvatarView.js";
import { getMemoryCategoryLabelKey } from "../common/SharedPanels.js";

function handleDialogOutsideFallback(
  event: ReactMouseEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement | null
) {
  if (!dialog || typeof HTMLDialogElement === "undefined") return;
  if ("closedBy" in HTMLDialogElement.prototype) return;
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  const isDialogContent =
    rect.top <= event.clientY &&
    event.clientY <= rect.top + rect.height &&
    rect.left <= event.clientX &&
    event.clientX <= rect.left + rect.width;
  if (!isDialogContent) {
    dialog.close();
  }
}

export function SecondaryModals() {
  const searchModalOpen = useStore((s) => s.searchModalOpen);
  const scheduleModalOpen = useStore((s) => s.scheduleModalOpen);
  const editingScheduleId = useStore((s) => s.editingScheduleId);
  const botMemoryModal = useStore((s) => s.botMemoryModal);
  const schedules = useStore((s) => s.schedules);
  const shortcutsDialogOpen = useStore((s) => s.shortcutsDialogOpen);
  const imageLightbox = useStore((s) => s.imageLightbox);
  const htmlPreviewModal = useStore((s) => s.htmlPreviewModal);
  const cloudAccountModal = useStore((s) => s.cloudAccountModal);
  const desktopPairingModal = useStore((s) => s.desktopPairingModal);
  const diagnostics = useStore((s) => s.diagnostics);
  const sessions = useStore((s) => s.sessions);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const { locale, t } = useI18n();
  const bgModes = getBgModes(locale);
  const defaultDailyLabel = t("schedule.defaultDailyLabel");

  // Search palette state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ bots: any[]; messages: any[] }>({
    bots: [],
    messages: [],
  });
  const [cloudQrScanning, setCloudQrScanning] = useState(false);

  // Schedule modal state
  const [schedTitle, setSchedTitle] = useState("");
  const [schedRepeat, setSchedRepeat] = useState("daily");
  const [schedLabel, setSchedLabel] = useState(defaultDailyLabel);
  const [schedPrompt, setSchedPrompt] = useState("");
  const [schedCron, setSchedCron] = useState("0 10 * * *");
  const [schedCronTouched, setSchedCronTouched] = useState(false);
  const [schedLabelManual, setSchedLabelManual] = useState(false);
  const schedCronInputRef = useRef<HTMLInputElement | null>(null);

  const supportsCronSchedules =
    !Array.isArray(diagnostics?.apiCapabilities) ||
    diagnostics.apiCapabilities.length === 0 ||
    hasConnectedNodeCapability("schedule-cron-v1") ||
    schedRepeat === "cron";

  useEffect(() => {
    if (!scheduleModalOpen) return;
    setSchedCronTouched(false);
    if (editingScheduleId) {
      const target = schedules.find((s: any) => s.id === editingScheduleId);
      if (target) {
        const initRepeat = String(target.repeat || "daily");
        const initLabel = String(target.scheduleLabel || defaultDailyLabel);
        const initCron =
          String(target.cron || "").trim() ||
          resolvePresetCronExpression(initRepeat, { scheduleLabel: initLabel }) ||
          "0 10 * * *";
        setSchedTitle(String(target.title || ""));
        setSchedRepeat(initRepeat);
        setSchedLabel(initLabel);
        setSchedPrompt(String(target.prompt || ""));
        setSchedCron(initCron);
        setSchedLabelManual(Boolean(target.scheduleLabel));
        return;
      }
    }
    setSchedTitle("");
    setSchedRepeat("daily");
    setSchedLabel(defaultDailyLabel);
    setSchedPrompt("");
    setSchedCron(
      resolvePresetCronExpression("daily", { scheduleLabel: defaultDailyLabel }) || "0 10 * * *"
    );
    setSchedLabelManual(false);
  }, [scheduleModalOpen, editingScheduleId, defaultDailyLabel]);

  const htmlPreviewDialogRef = useRef<HTMLDialogElement | null>(null);
  const htmlPreviewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const shortcutsDialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!searchModalOpen) {
      setSearchQuery("");
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await apiJson(`/api/search?q=${encodeURIComponent(searchQuery.trim())}`);
        setSearchResults({
          bots: Array.isArray(res.bots) ? res.bots : [],
          messages: Array.isArray(res.messages) ? res.messages : [],
        });
      } catch {
        setSearchResults({ bots: [], messages: [] });
      }
    }, 90);
    return () => clearTimeout(timer);
  }, [searchModalOpen, searchQuery]);

  // Native `<dialog id="html-preview-dialog">` sync
  useEffect(() => {
    const dialog = htmlPreviewDialogRef.current;
    if (!dialog) return;
    if (htmlPreviewModal.open) {
      dialog.returnValue = "";
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          try {
            dialog.showModal();
          } catch {
            dialog.setAttribute("open", "");
          }
        } else {
          dialog.setAttribute("open", "");
        }
      }
    } else if (dialog.open) {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute("open");
      }
    }
  }, [htmlPreviewModal.open]);

  // Native `<dialog id="shortcuts-help-dialog">` sync
  useEffect(() => {
    const dialog = shortcutsDialogRef.current;
    if (!dialog) return;
    if (shortcutsDialogOpen) {
      dialog.returnValue = "";
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          try {
            dialog.showModal();
          } catch {
            dialog.setAttribute("open", "");
          }
        } else {
          dialog.setAttribute("open", "");
        }
      }
    } else if (dialog.open) {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute("open");
      }
    }
  }, [shortcutsDialogOpen]);

  const navShortcuts = [
    { label: t("search.navNewBot"), sub: "+", fn: () => openNewChatBar(false) },
    {
      label: t("search.navComputer"),
      sub: t("search.navComputerSub"),
      fn: () => openBotScreenOverlay(),
    },
    {
      label: t("search.navPermissions"),
      sub: t("search.navSettingsSub"),
      fn: () => openSettingsModal("permissions"),
    },
    {
      label: t("search.navTheme"),
      sub: t("search.navSettingsSub"),
      fn: () => openSettingsModal("general"),
    },
  ].filter(
    (nav) =>
      !searchQuery.trim() || nav.label.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  const handleSaveSchedule = async () => {
    const title = schedTitle.trim();
    const prompt = schedPrompt.trim();
    let cronPayload: string | undefined;
    if (schedRepeat === "cron") {
      const parsedCron = parseCronExpression(schedCron, locale);
      if (!parsedCron.ok) {
        setSchedCronTouched(true);
        schedCronInputRef.current?.focus();
        showToast(parsedCron.error);
        return;
      }
      cronPayload = parsedCron.normalized;
    } else if (
      (schedRepeat === "daily" || schedRepeat === "hourly" || schedRepeat === "weekly") &&
      supportsCronSchedules
    ) {
      cronPayload =
        resolvePresetCronExpression(schedRepeat, {
          scheduleLabel: schedLabel.trim() || defaultDailyLabel,
        }) || undefined;
    }
    const scheduleLabel =
      schedLabel.trim() ||
      (schedRepeat === "cron" && cronPayload
        ? describeCronExpression(cronPayload, locale)
        : defaultDailyLabel);
    if (!title || !prompt || (!editingScheduleId && !activeSessionId)) {
      showToast(t("schedule.fillTitleAndPromptToast"));
      return;
    }
    const hasExplicitClock = /(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/.test(scheduleLabel);
    const nextRunAt =
      schedRepeat === "once" && !hasExplicitClock
        ? new Date(Date.now() + 60 * 1000).toISOString()
        : undefined;
    if (editingScheduleId) {
      await apiJson(`/api/schedules/${encodeURIComponent(editingScheduleId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          title,
          prompt,
          repeat: schedRepeat,
          scheduleLabel,
          ...(cronPayload ? { cron: cronPayload } : {}),
          ...(nextRunAt ? { nextRunAt } : {}),
        }),
      });
    } else {
      await apiJson("/api/schedules", {
        method: "POST",
        body: JSON.stringify({
          sessionId: activeSessionId,
          title,
          prompt,
          repeat: schedRepeat,
          scheduleLabel,
          ...(cronPayload ? { cron: cronPayload } : {}),
          ...(nextRunAt ? { nextRunAt } : {}),
        }),
      });
    }
    setSchedTitle("");
    setSchedPrompt("");
    setSchedCron("0 10 * * *");
    setSchedCronTouched(false);
    setState({ scheduleModalOpen: false, editingScheduleId: null });
    refreshSchedules();
    showToast(editingScheduleId ? t("schedule.updatedToast") : t("schedule.createdToast"));
  };

  const handleSaveBotMemoryModal = async () => {
    const targetSid = botMemoryModal.sessionId || activeSessionId;
    if (!targetSid) return;
    const targetSession = sessions.find((s: any) => s.id === targetSid);
    if (!targetSession) return;
    const content = botMemoryModal.content.trim();
    if (!content) {
      showToast(t("memory.enterContentToast"));
      return;
    }
    const title =
      botMemoryModal.name.trim() || content.replace(/\s+/g, " ").slice(0, 18);
    const prevMemories = Array.isArray(targetSession.memories)
      ? targetSession.memories
      : [];
    const nowIso = new Date().toISOString();
    const category = normalizeMemoryCategory(botMemoryModal.category);
    const nextMemories = botMemoryModal.memoryId
      ? prevMemories.map((m: any) =>
          (m.id || m.name) === botMemoryModal.memoryId
            ? {
                ...m,
                name: title,
                desc: content,
                instruction: content,
                content,
                category,
                updatedAt: nowIso,
              }
            : m
        )
      : [
          {
            id: `bmem-${Date.now()}`,
            name: title,
            desc: content,
            instruction: content,
            content,
            category,
            enabled: true,
            updatedAt: nowIso,
          },
          ...prevMemories,
        ];
    try {
      const updated = await apiJson(`/api/sessions/${targetSid}`, {
        method: "PATCH",
        body: JSON.stringify({ memories: nextMemories, touch: false }),
      });
      upsertLocalSession(updated);
      setState((prev) => ({
        botMemoryModal: {
          ...prev.botMemoryModal,
          open: false,
          memoryId: null,
          name: "",
          content: "",
          category: "general",
        },
      }));
      showToast(
        botMemoryModal.memoryId
          ? t("memory.updatedForBotToast", {
              name: targetSession.title || t("memory.currentBotFallback"),
            })
          : t("memory.savedForBotToast", {
              name: targetSession.title || t("memory.currentBotFallback"),
            })
      );
    } catch (err: any) {
      showToast(
        t("memory.saveFailedToast", {
          error: err?.message || t("memory.unknownError"),
        })
      );
    }
  };

  const handleSaveCloudAccount = async () => {
    try {
      await importRemoteAccountFromInput({
        accountId: cloudAccountModal.id.trim(),
        rawUrlOrInvite: cloudAccountModal.baseUrl.trim(),
        name: cloudAccountModal.name.trim(),
        authToken: cloudAccountModal.authToken.trim(),
        switchAfter: true,
      });
      setState((prev) => ({
        cloudAccountModal: { ...prev.cloudAccountModal, open: false, feedback: "" },
      }));
    } catch (err: any) {
      setState((prev) => ({
        cloudAccountModal: {
          ...prev.cloudAccountModal,
          feedback: err?.message || t("cloudModal.invalidUrlFallback"),
        },
      }));
    }
  };

  // HTML Preview Modal derived props
  const isModalPreview = htmlPreviewModal.mode !== "code";
  const curBgObj =
    bgModes.find((b) => b.key === htmlPreviewModal.canvasBg) || bgModes[0];
  const modalSrcdoc =
    htmlPreviewModal.open && htmlPreviewModal.code
      ? buildPreviewSrcdoc(htmlPreviewModal.code, {
          kind: htmlPreviewModal.kind,
          instanceId: "",
          canvasBg: htmlPreviewModal.canvasBg,
          fullscreen: true,
        })
      : "";

  const lightboxDownloadName =
    imageLightbox.alt && /\.[a-z0-9]{2,5}$/i.test(imageLightbox.alt)
      ? imageLightbox.alt
      : `${imageLightbox.alt || "generated"}.png`;

  return (
    <>
      {/* ==================== SEARCH COMMAND PALETTE MODAL ==================== */}
      <div
        id="search-modal-backdrop"
        className="modal-backdrop"
        hidden={!searchModalOpen}
        onClick={(e) => {
          if (e.target === e.currentTarget) setState({ searchModalOpen: false });
        }}
      >
        <div className="search-palette-modal" role="dialog" aria-modal="true" aria-label={t("common.search")}>
          <div className="search-palette-top">
            <svg className="search-palette-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="5.6" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M13.4 13.4L17 17"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <input
              id="palette-search-input"
              type="text"
              className="palette-search-input"
              placeholder={t("search.placeholder")}
              aria-label={t("common.search")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div
            id="palette-results-list"
            className="palette-results-list"
            role="listbox"
            aria-label={t("search.resultsAria")}
          >
            {searchResults.bots.length > 0 && (
              <>
                <div className="palette-section-title">{t("search.sectionBots")}</div>
                {searchResults.bots.map((b: any) => (
                  <button
                    key={b.id}
                    type="button"
                    className="palette-result-item"
                    onClick={() => {
                      setState({ searchModalOpen: false });
                      selectSession(b.id);
                    }}
                  >
                    <span className="palette-result-avatar">
                      <SessionAvatar
                        session={b}
                        allSessions={sessions}
                        primaryId={primarySessionId}
                      />
                    </span>
                    <span className="palette-result-title">{b.title}</span>
                    <span className="palette-result-sub">
                      {b.type === "group" ? t("search.typeGroup") : "Bot"}
                    </span>
                  </button>
                ))}
              </>
            )}

            {searchResults.messages.length > 0 && (
              <>
                <div className="palette-section-title">{t("search.sectionMessages")}</div>
                {searchResults.messages.map((m: any, idx: number) => (
                  <button
                    key={`${m.sessionId}-${idx}`}
                    type="button"
                    className="palette-result-item"
                    onClick={() => {
                      setState({ searchModalOpen: false });
                      selectSession(m.sessionId);
                    }}
                  >
                    <span className="palette-result-title">
                      {m.sessionTitle}: {m.snippet}
                    </span>
                    <span className="palette-result-sub">{formatClockTime(m.at, locale)}</span>
                  </button>
                ))}
              </>
            )}

            <div className="palette-section-title">{t("search.sectionNav")}</div>
            {navShortcuts.map((nav) => (
              <button
                key={nav.label}
                type="button"
                className="palette-result-item"
                onClick={() => {
                  setState({ searchModalOpen: false });
                  nav.fn();
                }}
              >
                <span className="palette-result-title">{nav.label}</span>
                <span className="palette-result-sub">{nav.sub}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ==================== BOT DEDICATED MEMORY MODAL ==================== */}
      <div
        id="bot-memory-modal-backdrop"
        className="modal-backdrop"
        hidden={!botMemoryModal.open}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setState((prev) => ({
              botMemoryModal: { ...prev.botMemoryModal, open: false },
            }));
          }
        }}
      >
        <div
          className="compact-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={
            botMemoryModal.memoryId ? t("memory.modalEditTitle") : t("memory.modalCreateTitle")
          }
        >
          <h3 className="compact-dialog-title">
            {botMemoryModal.memoryId ? t("memory.modalEditTitle") : t("memory.modalCreateTitle")}
          </h3>
          <input
            id="bot-memory-modal-name-input"
            type="text"
            className="inline-text-input"
            placeholder={t("memory.namePlaceholder")}
            aria-label={t("memory.titleAria")}
            value={botMemoryModal.name}
            onChange={(e) =>
              setState((prev) => ({
                botMemoryModal: { ...prev.botMemoryModal, name: e.target.value },
              }))
            }
          />
          <select
            id="bot-memory-modal-category-select"
            className="inline-text-input"
            aria-label={t("memory.categoryLabel")}
            value={normalizeMemoryCategory(botMemoryModal.category)}
            onChange={(e) =>
              setState((prev) => ({
                botMemoryModal: { ...prev.botMemoryModal, category: e.target.value },
              }))
            }
          >
            {VALID_MEMORY_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {t("memory.categoryLabel")}: {t(getMemoryCategoryLabelKey(cat))}
              </option>
            ))}
          </select>
          <textarea
            id="bot-memory-modal-content-input"
            className="inline-textarea"
            rows={4}
            placeholder={t("memory.contentPlaceholder")}
            aria-label={t("memory.contentAria")}
            value={botMemoryModal.content}
            onChange={(e) =>
              setState((prev) => ({
                botMemoryModal: { ...prev.botMemoryModal, content: e.target.value },
              }))
            }
          />
          <div className="inline-form-actions">
            <button
              id="cancel-bot-memory-modal-btn"
              type="button"
              className="settings-pill-btn"
              onClick={() =>
                setState((prev) => ({
                  botMemoryModal: { ...prev.botMemoryModal, open: false },
                }))
              }
            >
              {t("common.cancel")}
            </button>
            <button
              id="save-bot-memory-modal-btn"
              type="button"
              className="settings-blue-pill"
              onClick={handleSaveBotMemoryModal}
            >
              {botMemoryModal.memoryId ? t("mobile.saveChanges") : t("common.save")}
            </button>
          </div>
        </div>
      </div>

      {/* ==================== SCHEDULE CREATION / EDIT MODAL ==================== */}
      <div
        id="schedule-modal-backdrop"
        className="modal-backdrop"
        hidden={!scheduleModalOpen}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setState({ scheduleModalOpen: false, editingScheduleId: null });
          }
        }}
      >
        <div
          className="compact-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={
            editingScheduleId ? t("schedule.modalEditTitle") : t("schedule.modalCreateTitle")
          }
        >
          <h3 className="compact-dialog-title">
            {editingScheduleId ? t("schedule.modalEditTitle") : t("schedule.modalCreateTitle")}
          </h3>
          <input
            id="sched-title-input"
            type="text"
            className="inline-text-input"
            placeholder={t("schedule.titlePlaceholder")}
            value={schedTitle}
            onChange={(e) => setSchedTitle(e.target.value)}
          />
          <div className="inline-form-grid">
            <select
              id="sched-repeat-select"
              className="inline-text-input"
              value={schedRepeat}
              onChange={(e) => {
                const next = e.target.value;
                setSchedRepeat(next);
                setSchedCronTouched(false);
                if (next === "cron") {
                  const seed = schedCron.trim() || "0 10 * * *";
                  if (!schedCron.trim()) setSchedCron(seed);
                  if (!schedLabelManual) {
                    setSchedLabel(describeCronExpression(seed, locale));
                  }
                } else {
                  const presetLabel =
                    next === "hourly"
                      ? t("schedule.defaultHourlyLabel")
                      : next === "weekly"
                        ? t("schedule.defaultWeeklyLabel")
                        : next === "once"
                          ? t("schedule.defaultOnceLabel")
                          : t("schedule.defaultDailyLabel");
                  const nextLabel = schedLabelManual ? schedLabel : presetLabel;
                  if (!schedLabelManual) {
                    setSchedLabel(presetLabel);
                  }
                  const derived = resolvePresetCronExpression(next, {
                    scheduleLabel: nextLabel,
                  });
                  if (derived) setSchedCron(derived);
                }
              }}
            >
              <option value="daily">{t("schedule.repeatDaily")}</option>
              <option value="hourly">{t("schedule.repeatHourly")}</option>
              <option value="weekly">{t("schedule.repeatWeekly")}</option>
              <option value="once">{t("schedule.repeatOnce")}</option>
              {supportsCronSchedules && (
                <option value="cron">{t("schedule.repeatCron")}</option>
              )}
            </select>
            <input
              id="sched-label-input"
              type="text"
              className="inline-text-input"
              value={schedLabel}
              placeholder={t("schedule.labelPlaceholder")}
              onChange={(e) => {
                const val = e.target.value;
                setSchedLabelManual(Boolean(val.trim()));
                setSchedLabel(val);
                const derived = resolvePresetCronExpression(schedRepeat, {
                  scheduleLabel: val,
                });
                if (derived) setSchedCron(derived);
              }}
            />
          </div>
          {schedRepeat === "cron" &&
            (() => {
              const cronRes = parseCronExpression(schedCron, locale);
              const showCronError = schedCronTouched && !cronRes.ok;
              const nextDates = cronRes.ok ? getNextCronDates(schedCron, 3) : [];
              const fmtPreviewDate = (d: Date) => {
                const mo = String(d.getMonth() + 1).padStart(2, "0");
                const da = String(d.getDate()).padStart(2, "0");
                const hh = String(d.getHours()).padStart(2, "0");
                const mm = String(d.getMinutes()).padStart(2, "0");
                return `${mo}/${da} ${hh}:${mm}`;
              };
              return (
                <div className="sched-cron-panel">
                  <span id="sched-cron-hint" className="sched-cron-hint">
                    {t("schedule.cronHint")}
                  </span>
                  <input
                    ref={schedCronInputRef}
                    id="sched-cron-input"
                    type="text"
                    className={`inline-text-input sched-cron-input${showCronError ? " is-invalid" : ""}`}
                    placeholder={t("schedule.cronPlaceholder")}
                    value={schedCron}
                    aria-label={t("schedule.cronAria")}
                    aria-invalid={showCronError ? "true" : "false"}
                    aria-describedby={
                      showCronError ? "sched-cron-hint sched-cron-error" : "sched-cron-hint"
                    }
                    data-error="sched-cron-error"
                    onChange={(e) => {
                      const val = e.target.value;
                      setSchedCron(val);
                      if (!schedLabelManual) {
                        const parsed = parseCronExpression(val, locale);
                        if (parsed.ok) {
                          setSchedLabel(describeCronExpression(val, locale));
                        }
                      }
                    }}
                    onBlur={() => setSchedCronTouched(true)}
                  />
                  <div
                    id="sched-cron-error"
                    className="sched-cron-error"
                    hidden={!showCronError}
                  >
                    <span role="img" aria-label={t("schedule.cronErrorAria")}>
                      ⚠
                    </span>{" "}
                    {!cronRes.ok ? cronRes.error : ""}
                  </div>
                  {cronRes.ok && (
                    <div
                      id="sched-cron-preview"
                      className="sched-cron-preview"
                      role="status"
                      aria-live="polite"
                    >
                      <span>✓ {describeCronExpression(schedCron, locale)}</span>
                      {nextDates.length > 0 && (
                        <span>
                          {t("schedule.nextRunPrefix")}
                          {nextDates.map(fmtPreviewDate).join(" · ")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          <textarea
            id="sched-prompt-input"
            className="inline-textarea"
            rows={3}
            placeholder={t("schedule.promptPlaceholder")}
            value={schedPrompt}
            onChange={(e) => setSchedPrompt(e.target.value)}
          />
          <div className="inline-form-actions">
            <button
              id="cancel-sched-modal-btn"
              type="button"
              className="settings-pill-btn"
              onClick={() => setState({ scheduleModalOpen: false, editingScheduleId: null })}
            >
              {t("common.cancel")}
            </button>
            <button
              id="save-sched-modal-btn"
              type="button"
              className="settings-blue-pill"
              onClick={handleSaveSchedule}
            >
              {editingScheduleId ? t("mobile.saveChanges") : t("schedule.createTaskBtn")}
            </button>
          </div>
        </div>
      </div>

      {/* ==================== FULLSCREEN IMAGE LIGHTBOX MODAL ==================== */}
      <div
        id="image-lightbox-modal"
        className="modal-backdrop image-lightbox-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("actions.imagePreviewAlt")}
        hidden={!imageLightbox.open}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setState({ imageLightbox: { open: false, url: "", alt: "" } });
          }
        }}
      >
        <div className="lightbox-top-actions">
          <a
            id="download-lightbox-btn"
            className="lightbox-download-btn"
            href={imageLightbox.url || "#"}
            download={lightboxDownloadName}
          >
            {t("lightbox.downloadOriginal")}
          </a>
          <button
            id="close-lightbox-btn"
            type="button"
            className="screen-exit-btn"
            aria-label={t("lightbox.closePreviewAria")}
            onClick={() => setState({ imageLightbox: { open: false, url: "", alt: "" } })}
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
        </div>
        <img
          id="lightbox-img"
          className="lightbox-img"
          src={imageLightbox.url || undefined}
          alt={imageLightbox.alt || t("lightbox.altFallback")}
          fetchPriority="low"
        />
      </div>

      {/* ==================== NATIVE MODAL DIALOG: SANDBOXED HTML / HTM / SVG PREVIEW ==================== */}
      <dialog
        ref={htmlPreviewDialogRef}
        id="html-preview-dialog"
        className="html-preview-dialog"
        closedby="any"
        aria-labelledby="html-preview-dialog-title"
        onClose={() => {
          if (htmlPreviewDialogRef.current) htmlPreviewDialogRef.current.returnValue = "";
          teardownPreviewIframe(htmlPreviewFrameRef.current);
          if (htmlPreviewModal.open) {
            setState((prev) => ({
              htmlPreviewModal: { ...prev.htmlPreviewModal, open: false },
            }));
          }
        }}
        onClick={(e) => handleDialogOutsideFallback(e, htmlPreviewDialogRef.current)}
      >
        <div className="html-preview-dialog-shell">
          <div className="html-preview-dialog-header">
            <div className="html-preview-dialog-title-group">
              <h2 id="html-preview-dialog-title" className="html-preview-dialog-title">
                {htmlPreviewModal.badgeLabel || t("actions.htmlPreviewBadge")}
              </h2>
              <span className="html-preview-sandbox-badge">{t("previewModal.sandboxBadge")}</span>
            </div>

            <div className="html-preview-dialog-controls">
              <div className="msg-preview-tabs" role="group" aria-label={t("previewModal.viewSwitchAria")}>
                <button
                  type="button"
                  className={`msg-preview-tab${isModalPreview ? " is-active" : ""}`}
                  data-preview-modal-mode="preview"
                  onClick={() =>
                    setState((prev) => ({
                      htmlPreviewModal: { ...prev.htmlPreviewModal, mode: "preview" },
                    }))
                  }
                >
                  {t("card.previewRender")}
                </button>
                <button
                  type="button"
                  className={`msg-preview-tab${!isModalPreview ? " is-active" : ""}`}
                  data-preview-modal-mode="code"
                  onClick={() =>
                    setState((prev) => ({
                      htmlPreviewModal: { ...prev.htmlPreviewModal, mode: "code" },
                    }))
                  }
                >
                  {t("card.previewCode")}
                </button>
              </div>

              <div
                className="msg-preview-tabs"
                id="html-preview-viewport-group"
                role="group"
                aria-label={t("previewModal.viewportAria")}
                hidden={!isModalPreview || htmlPreviewModal.kind === "svg"}
              >
                {(
                  [
                    ["full", t("previewModal.viewportFull")],
                    ["desktop", "1024px"],
                    ["mobile", "390px"],
                  ] as const
                ).map(([vpKey, vpLabel]) => (
                  <button
                    key={vpKey}
                    type="button"
                    className={`msg-preview-tab${htmlPreviewModal.vp === vpKey ? " is-active" : ""}`}
                    data-preview-vp={vpKey}
                    onClick={() =>
                      setState((prev) => ({
                        htmlPreviewModal: { ...prev.htmlPreviewModal, vp: vpKey },
                      }))
                    }
                  >
                    {vpLabel}
                  </button>
                ))}
              </div>

              <button
                id="html-preview-modal-bg-btn"
                type="button"
                className="msg-preview-btn"
                hidden={!isModalPreview}
                onClick={() => {
                  const curIdx = bgModes.findIndex(
                    (b) => b.key === htmlPreviewModal.canvasBg
                  );
                  const nextKey = bgModes[(curIdx + 1) % bgModes.length].key;
                  setState((prev) => ({
                    htmlPreviewModal: { ...prev.htmlPreviewModal, canvasBg: nextKey },
                  }));
                }}
              >
                {curBgObj.label}
              </button>

              <button
                id="html-preview-modal-reload-btn"
                type="button"
                className="msg-preview-btn"
                aria-label={t("card.previewRefresh")}
                hidden={!isModalPreview}
                onClick={() => {
                  teardownPreviewIframe(htmlPreviewFrameRef.current);
                  setState((prev) => ({
                    htmlPreviewModal: {
                      ...prev.htmlPreviewModal,
                      reloadNonce: Date.now(),
                    },
                  }));
                }}
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

              <button
                id="html-preview-modal-copy-btn"
                type="button"
                className="msg-preview-btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(htmlPreviewModal.code || "");
                  } catch {}
                  showToast(t("card.previewSourceCopied"));
                }}
              >
                {t("previewModal.copySource")}
              </button>

              <button
                id="html-preview-modal-download-btn"
                type="button"
                className="msg-preview-btn"
                onClick={() => {
                  const isSvg = htmlPreviewModal.kind === "svg";
                  const ext = isSvg
                    ? "svg"
                    : htmlPreviewModal.lang === "htm"
                      ? "htm"
                      : "html";
                  const mime = isSvg
                    ? "image/svg+xml;charset=utf-8"
                    : "text/html;charset=utf-8";
                  const blob = new Blob([htmlPreviewModal.code || ""], { type: mime });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `twinklebot-preview-${Date.now()}.${ext}`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                {t("card.previewDownload")}
              </button>

              <button
                id="close-html-preview-dialog-btn"
                type="button"
                className="modal-close-btn html-preview-close-btn"
                aria-label={t("lightbox.closePreviewAria")}
                onClick={() => htmlPreviewDialogRef.current?.close()}
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
            </div>
          </div>

          <div className="html-preview-dialog-body">
            <div
              id="html-preview-modal-stage"
              className="html-preview-modal-stage"
              data-vp={htmlPreviewModal.vp || "full"}
              hidden={!isModalPreview}
            >
              <iframe
                key={htmlPreviewModal.reloadNonce}
                ref={htmlPreviewFrameRef}
                id="html-preview-modal-frame"
                className="html-preview-modal-frame"
                sandbox="allow-scripts allow-forms"
                title={t("previewModal.frameTitle")}
                srcDoc={modalSrcdoc}
              />
            </div>
            <pre
              id="html-preview-modal-pre"
              className="html-preview-modal-pre"
              role="region"
              aria-labelledby="html-preview-dialog-title"
              tabIndex={0}
              hidden={isModalPreview}
            >
              <code id="html-preview-modal-code">{htmlPreviewModal.code}</code>
            </pre>
          </div>
        </div>
      </dialog>

      {/* ==================== NATIVE MODAL DIALOG: KEYBOARD SHORTCUTS & QUICK GUIDE ==================== */}
      <dialog
        ref={shortcutsDialogRef}
        id="shortcuts-help-dialog"
        className="shortcuts-help-dialog"
        closedby="any"
        aria-labelledby="shortcuts-dialog-title"
        onClose={() => {
          if (shortcutsDialogRef.current) shortcutsDialogRef.current.returnValue = "";
          if (shortcutsDialogOpen) {
            setState({ shortcutsDialogOpen: false });
          }
        }}
        onClick={(e) => handleDialogOutsideFallback(e, shortcutsDialogRef.current)}
      >
        <div className="shortcuts-dialog-shell">
          <div className="shortcuts-dialog-header">
            <h2 id="shortcuts-dialog-title" className="shortcuts-dialog-title">
              {t("shortcuts.title")}
            </h2>
            <button
              id="close-shortcuts-dialog-btn"
              type="button"
              className="modal-close-btn"
              aria-label={t("shortcuts.closeAria")}
              onClick={() => shortcutsDialogRef.current?.close()}
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
          </div>
          <div className="shortcuts-dialog-body">
            <div className="shortcuts-section-label">{t("shortcuts.sectionNav")}</div>
            <div className="shortcuts-grid">
              <div className="shortcut-row">
                <span>{t("shortcuts.navSearch")}</span>
                <kbd>⌘ K</kbd>
              </div>
              <div className="shortcut-row">
                <span>{t("shortcuts.navSettings")}</span>
                <kbd>⌘ ,</kbd>
              </div>
              <div className="shortcut-row">
                <span>{t("shortcuts.navLeftSidebar")}</span>
                <kbd>⌘ \</kbd>
              </div>
              <div className="shortcut-row">
                <span>{t("shortcuts.navRightInspector")}</span>
                <kbd>⌘ I</kbd>
              </div>
            </div>
            <div className="shortcuts-section-label">{t("shortcuts.sectionChat")}</div>
            <div className="shortcuts-grid">
              <div className="shortcut-row">
                <span>{t("shortcuts.chatMention")}</span>
                <kbd>@</kbd>
              </div>
              <div className="shortcut-row">
                <span>{t("shortcuts.chatNewline")}</span>
                <kbd>Shift + Enter</kbd>
              </div>
              <div className="shortcut-row">
                <span>{t("shortcuts.chatQuote")}</span>
                <kbd>{t("shortcuts.chatQuoteKbd")}</kbd>
              </div>
            </div>
          </div>
        </div>
      </dialog>

      {/* ==================== CLOUD ACCOUNT MODAL ==================== */}
      <div
        id="cloud-account-modal"
        className="modal-backdrop"
        hidden={!cloudAccountModal.open}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setState((prev) => ({
              cloudAccountModal: { ...prev.cloudAccountModal, open: false },
            }));
          }
        }}
      >
        <div
          className="compact-dialog cloud-account-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("cloudModal.title")}
        >
          <div className="vault-header-row">
            <h3 className="compact-dialog-title" id="cloud-account-modal-title">
              {t("cloudModal.title")}
            </h3>
            <button
              id="close-cloud-account-modal-btn"
              type="button"
              className="modal-close-btn"
              aria-label={t("common.close")}
              onClick={() =>
                setState((prev) => ({
                  cloudAccountModal: { ...prev.cloudAccountModal, open: false },
                }))
              }
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
          </div>
          <input id="cloud-account-id-input" type="hidden" value={cloudAccountModal.id} readOnly />
          <label className="onboarding-field">
            <span>{t("cloudModal.urlLabel")}</span>
            <input
              id="cloud-account-url-input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              className="inline-text-input"
              placeholder="https://bot.example.com / twinklebot://relay?..."
              value={cloudAccountModal.baseUrl}
              onChange={(e) => {
                const rawVal = e.target.value;
                const parsed = rawVal.trim().startsWith("twinklebot://")
                  ? parseRelayInvite(rawVal)
                  : null;
                setState((prev) => ({
                  cloudAccountModal: {
                    ...prev.cloudAccountModal,
                    baseUrl: rawVal,
                    name: prev.cloudAccountModal.name || parsed?.name || parsed?.hostname || "",
                    authToken: prev.cloudAccountModal.authToken || parsed?.relayToken || "",
                  },
                }));
              }}
            />
          </label>
          <label className="onboarding-field">
            <span>{t("cloudModal.nameLabel")}</span>
            <input
              id="cloud-account-name-input"
              type="text"
              className="inline-text-input"
              placeholder={t("gate.cloudNamePlaceholder")}
              value={cloudAccountModal.name}
              onChange={(e) =>
                setState((prev) => ({
                  cloudAccountModal: { ...prev.cloudAccountModal, name: e.target.value },
                }))
              }
            />
          </label>
          <label className="onboarding-field">
            <span>{t("cloudModal.tokenLabel")}</span>
            <input
              id="cloud-account-token-input"
              type="password"
              className="inline-text-input"
              placeholder={t("cloudModal.tokenPlaceholder")}
              autoComplete="off"
              value={cloudAccountModal.authToken}
              onChange={(e) =>
                setState((prev) => ({
                  cloudAccountModal: { ...prev.cloudAccountModal, authToken: e.target.value },
                }))
              }
            />
          </label>
          <div
            id="cloud-account-feedback"
            className="mail-feedback-box is-error"
            role="status"
            aria-live="polite"
            hidden={!cloudAccountModal.feedback}
          >
            {cloudAccountModal.feedback}
          </div>
          <div className="inline-form-actions">
            {isNativeQrScannerAvailable() && (
              <button
                id="cloud-modal-scan-qr-btn"
                type="button"
                className="settings-pill-btn"
                disabled={cloudQrScanning}
                onClick={async () => {
                  if (cloudQrScanning) return;
                  setCloudQrScanning(true);
                  try {
                    const res = await scanQrCodeNative(t("mobile.qrScanPrompt"));
                    if (res.unsupported) {
                      setState((prev) => ({
                        cloudAccountModal: {
                          ...prev.cloudAccountModal,
                          feedback: t("mobile.qrUnsupportedToast"),
                        },
                      }));
                      return;
                    }
                    if (res.permissionDenied) {
                      setState((prev) => ({
                        cloudAccountModal: {
                          ...prev.cloudAccountModal,
                          feedback: t("mobile.qrPermissionDeniedToast"),
                        },
                      }));
                      return;
                    }
                    if (res.cancelled) return;
                    if (!res.ok || !res.content) {
                      setState((prev) => ({
                        cloudAccountModal: {
                          ...prev.cloudAccountModal,
                          feedback: t("mobile.qrInvalidToast", {
                            error: res.error || t("actions.requestError"),
                          }),
                        },
                      }));
                      return;
                    }
                    const parsed = res.content.trim().startsWith("twinklebot://")
                      ? parseRelayInvite(res.content)
                      : null;
                    setState((prev) => ({
                      cloudAccountModal: {
                        ...prev.cloudAccountModal,
                        baseUrl: res.content || prev.cloudAccountModal.baseUrl,
                        name: parsed?.name || parsed?.hostname || prev.cloudAccountModal.name,
                        authToken: parsed?.relayToken || prev.cloudAccountModal.authToken,
                        feedback: "",
                      },
                    }));
                    try {
                      await importRemoteAccountFromInput({
                        accountId: cloudAccountModal.id.trim(),
                        rawUrlOrInvite: res.content,
                        name: cloudAccountModal.name.trim() || parsed?.name || parsed?.hostname || "",
                        authToken: cloudAccountModal.authToken.trim() || parsed?.relayToken || "",
                        switchAfter: true,
                      });
                      setState((prev) => ({
                        cloudAccountModal: { ...prev.cloudAccountModal, open: false, feedback: "" },
                      }));
                    } catch (err: any) {
                      setState((prev) => ({
                        cloudAccountModal: {
                          ...prev.cloudAccountModal,
                          feedback: err?.message || t("cloudModal.invalidUrlFallback"),
                        },
                      }));
                    }
                  } finally {
                    setCloudQrScanning(false);
                  }
                }}
              >
                {t("cloudModal.scanQrBtn")}
              </button>
            )}
            <button
              id="cancel-cloud-account-btn"
              type="button"
              className="settings-pill-btn"
              onClick={() =>
                setState((prev) => ({
                  cloudAccountModal: { ...prev.cloudAccountModal, open: false },
                }))
              }
            >
              {t("common.cancel")}
            </button>
            <button
              id="save-cloud-account-btn"
              type="button"
              className="settings-blue-pill"
              onClick={handleSaveCloudAccount}
            >
              {t("cloudModal.saveAndConnect")}
            </button>
          </div>
        </div>
      </div>

      {/* ==================== DESKTOP LAN PAIRING MODAL ==================== */}
      <div
        id="desktop-pairing-modal"
        className="modal-backdrop"
        hidden={!desktopPairingModal.open}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setState((prev) => ({
              desktopPairingModal: { ...prev.desktopPairingModal, open: false },
            }));
          }
        }}
      >
        <div
          className="compact-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("pairingModal.aria")}
        >
          <h3 className="compact-dialog-title">{t("pairing.title")}</h3>
          <p className="settings-row-sub" id="desktop-pairing-device-meta">
            {desktopPairingModal.deviceName
              ? t("pairingModal.withDevice", { device: desktopPairingModal.deviceName })
              : t("pairingModal.defaultPrompt")}
          </p>
          <div
            id="desktop-pairing-code-display"
            style={{
              fontSize: "34px",
              fontWeight: 800,
              letterSpacing: "10px",
              textAlign: "center",
              padding: "14px 12px",
              borderRadius: "14px",
              background: "var(--bg-modal-card)",
              border: "1px solid var(--border-card)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {desktopPairingModal.code || "000000"}
          </div>
          <div className="inline-form-actions">
            <button
              id="desktop-pairing-close-btn"
              type="button"
              className="settings-blue-pill"
              onClick={() =>
                setState((prev) => ({
                  desktopPairingModal: { ...prev.desktopPairingModal, open: false },
                }))
              }
            >
              {t("pairingModal.gotItBtn")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
