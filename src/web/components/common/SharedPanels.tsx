import { useState } from "react";
import { isMobileViewport } from "../../mobile-ui.js";
import { describeCronExpression } from "/shared/cron.js";
import { normalizeMemoryCategory } from "/shared/entities.js";
import {
  openBotScreenOverlay,
  openImageLightbox,
  openLocalFile,
  refreshSchedules,
  refreshSettingsFromServer,
  showConfirmDialog,
  showToast,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson, apiUrl } from "../../services/api-client.js";
import { hasConnectedNodeCapability } from "../../services/ota-updater.js";
import { useI18n } from "../../services/i18n.js";
import { formatClockTime } from "../../state/helpers.js";
import { setState, useStore, type TraceItem } from "../../state/store.js";
import { StatusText, UiIcon } from "./Icon.js";

export function getMemoryCategoryLabelKey(category: unknown) {
  switch (normalizeMemoryCategory(category)) {
    case "identity":
      return "memory.cat.identity" as const;
    case "preference":
      return "memory.cat.preference" as const;
    case "rule":
      return "memory.cat.rule" as const;
    case "context":
      return "memory.cat.context" as const;
    default:
      return "memory.cat.general" as const;
  }
}

export function MemoryMetaBadges({
  category,
  source,
}: {
  category?: unknown;
  source?: unknown;
}) {
  const { t } = useI18n();
  const cat = normalizeMemoryCategory(category);
  const showCat = cat !== "general";
  const isAuto = source === "auto";
  if (!showCat && !isAuto) return null;
  return (
    <span className="memory-meta-badges">
      {showCat && <span className="memory-cat-badge">{t(getMemoryCategoryLabelKey(cat))}</span>}
      {isAuto && <span className="memory-source-badge">{t("memory.sourceAuto")}</span>}
    </span>
  );
}

export function MemoryConsolidatePreviewCard({
  plan,
  applying,
  idPrefix,
  onApply,
  onCancel,
}: {
  plan: any;
  applying: boolean;
  idPrefix: string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  if (!plan) return null;
  const merges: any[] = Array.isArray(plan.merges) ? plan.merges : [];
  const removals: any[] = Array.isArray(plan.removals) ? plan.removals : [];
  return (
    <div id={`${idPrefix}-memory-consolidate-preview`} className="memory-consolidate-preview">
      <div className="memory-consolidate-head">
        <span>{t("memory.consolidatePreviewTitle")}</span>
        <span className="memory-consolidate-diff-pill">
          {t("memory.consolidateCountDiff", {
            before: String(plan.beforeCount ?? 0),
            after: String(plan.afterCount ?? 0),
          })}
        </span>
      </div>
      {plan.summary && <div>{plan.summary}</div>}
      {merges.length > 0 && (
        <div className="memory-consolidate-section">
          <strong>{t("memory.consolidateMergesTitle", { count: String(merges.length) })}</strong>
          {merges.slice(0, 4).map((m: any, idx: number) => (
            <div key={idx} className="memory-consolidate-item">
              {(Array.isArray(m.sourceNames) ? m.sourceNames.join(" + ") : "")} →{" "}
              <strong>{m.result?.name || ""}</strong>：{m.result?.content || ""}
            </div>
          ))}
        </div>
      )}
      {removals.length > 0 && (
        <div className="memory-consolidate-section">
          <strong>{t("memory.consolidateRemovalsTitle", { count: String(removals.length) })}</strong>
          {removals.slice(0, 4).map((r: any, idx: number) => (
            <div key={idx} className="memory-consolidate-item">
              {r.name}（{r.reason}）
            </div>
          ))}
        </div>
      )}
      <div className="memory-consolidate-actions">
        <button
          type="button"
          className="skill-pill-btn"
          disabled={applying}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        {plan.changed && (
          <button
            id={`apply-${idPrefix}-memory-consolidate-btn`}
            type="button"
            className="skill-pill-btn is-primary"
            disabled={applying}
            onClick={onApply}
          >
            {applying ? t("memory.consolidatingBtn") : t("memory.consolidateApplyBtn")}
          </button>
        )}
      </div>
    </div>
  );
}

export function BotMemoriesList({
  session,
  listId,
}: {
  session: any;
  listId: string;
}) {
  const { t } = useI18n();
  const memories: any[] = Array.isArray(session?.memories) ? session.memories : [];

  const handleToggle = async (mem: any, checked: boolean) => {
    if (!session?.id) return;
    const next = memories.map((x) => (x.id === mem.id ? { ...x, enabled: checked } : x));
    const updated = await apiJson(`/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memories: next, touch: false }),
    });
    upsertLocalSession(updated);
  };

  const handleDelete = async (mem: any) => {
    if (!session?.id) return;
    const ok = await showConfirmDialog({
      title: t("memory.deleteConfirmTitle"),
      message: t("memory.deleteConfirmMsg", { name: mem.name || t("memory.defaultName") }),
      detail: t("memory.deleteConfirmDetail"),
      confirmText: t("memory.deleteConfirmBtn"),
      cancelText: t("common.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    const next = memories.filter((x) => x.id !== mem.id);
    const updated = await apiJson(`/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memories: next, touch: false }),
    });
    upsertLocalSession(updated);
    showToast(t("memory.deletedToast", { name: mem.name }));
  };

  return (
    <div id={listId} className="private-skills-list">
      {memories.length === 0 ? (
        <div className="skills-empty" style={{ fontSize: "12px" }}>
          {t("memory.emptyListHint")}
        </div>
      ) : (
        memories.map((mem) => {
          const enabled = mem.enabled !== false;
          const openEditMemory = () => {
            if (!session?.id) return;
            setState({
              botMemoryModal: {
                open: true,
                sessionId: session.id,
                memoryId: mem.id || mem.name,
                name: mem.name || "",
                content: mem.instruction || mem.content || mem.desc || "",
                category: normalizeMemoryCategory(mem.category),
              },
            });
            requestAnimationFrame(() => {
              (
                document.getElementById("bot-memory-modal-name-input") as HTMLInputElement | null
              )?.focus();
            });
          };
          const memTitle = mem.name || t("memory.defaultName");
          return (
            <div key={mem.id || mem.name} className="private-skill-row">
              <div className="skill-row-icon" aria-hidden="true">
                <UiIcon name="brain" size={19} />
              </div>
              <div
                className="skill-row-info is-editable"
                role="button"
                tabIndex={0}
                title={`${memTitle} — ${t("memory.clickEditTitle")}`}
                onClick={openEditMemory}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openEditMemory();
                  }
                }}
              >
                <div className="skill-row-name">
                  {memTitle}
                  <MemoryMetaBadges category={mem.category} source={mem.source} />
                </div>
                <div className="skill-row-desc">
                  {mem.instruction || mem.content || mem.desc || ""}
                </div>
              </div>
              <label className="ios-switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  aria-label={t("memory.toggleAria", { name: mem.name })}
                  onChange={(e) => handleToggle(mem, e.target.checked)}
                />
                <span className="ios-switch-track" />
              </label>
              <button
                type="button"
                className="section-action-link"
                aria-label={t("memory.editAria", { name: mem.name || t("memory.defaultName") })}
                title={t("common.edit")}
                onClick={openEditMemory}
              >
                <UiIcon name="pencil" size={14} />
              </button>
              <button
                type="button"
                className="section-action-link danger-text"
                onClick={() => handleDelete(mem)}
              >
                {t("common.delete")}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

export function SchedulesList({ listId }: { listId: string }) {
  const { locale, t } = useI18n();
  const schedules = useStore((s) => s.schedules);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const diagnostics = useStore((s) => s.diagnostics);
  const supportsOptimizer = hasConnectedNodeCapability("schedule-optimizer-v1", { diagnostics });
  const [optimizingId, setOptimizingId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [optResultById, setOptResultById] = useState<Record<string, any>>({});
  const [saveSkillById, setSaveSkillById] = useState<Record<string, boolean>>({});

  const items = schedules.filter(
    (s: any) => !activeSessionId || s.sessionId === activeSessionId
  );

  const handleToggle = async (item: any, checked: boolean) => {
    await apiJson(`/api/schedules/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: checked }),
    });
    setState((prev) => ({
      schedules: prev.schedules.map((s: any) =>
        s.id === item.id ? { ...s, enabled: checked } : s
      ),
    }));
    showToast(checked ? t("schedule.enabledToast") : t("schedule.pausedToast"));
  };

  const handleDelete = async (item: any) => {
    const label = item.title || item.name || t("schedule.defaultName");
    const ok = await showConfirmDialog({
      title: t("schedule.deleteConfirmTitle"),
      message: t("schedule.deleteConfirmMsg", { label }),
      detail: item.cron ? t("schedule.deleteConfirmDetailCron", { cron: item.cron }) : "",
      confirmText: t("memory.deleteConfirmBtn"),
      cancelText: t("common.cancel"),
      tone: "danger",
    });
    if (!ok) return;
    await apiJson(`/api/schedules/${item.id}`, { method: "DELETE" });
    refreshSchedules();
    showToast(t("schedule.deletedToast", { label }));
  };

  const handleOptimize = async (item: any) => {
    if (!item?.id || optimizingId) return;
    setOptimizingId(item.id);
    try {
      const res = await apiJson(`/api/schedules/${encodeURIComponent(item.id)}/optimize`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setOptResultById((prev) => ({ ...prev, [item.id]: res }));
      if (res?.draftSkill) {
        setSaveSkillById((prev) => ({ ...prev, [item.id]: false }));
      }
    } catch (err: any) {
      showToast(t("schedule.optimizeFailedToast", { error: err?.message || "" }));
    } finally {
      setOptimizingId(null);
    }
  };

  const handleApplyOptimization = async (item: any, optRes: any) => {
    if (!item?.id || !optRes?.optimizedPrompt || applyingId) return;
    setApplyingId(item.id);
    try {
      const saveAsSkill = Boolean(saveSkillById[item.id] && optRes.draftSkill);
      await apiJson(`/api/schedules/${encodeURIComponent(item.id)}/apply-optimization`, {
        method: "POST",
        body: JSON.stringify({
          optimizedPrompt: optRes.optimizedPrompt,
          saveAsSkill,
          ...(saveAsSkill ? { draftSkill: optRes.draftSkill } : {}),
        }),
      });
      setOptResultById((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      refreshSchedules();
      if (saveAsSkill) {
        await refreshSettingsFromServer();
      }
      showToast(t("schedule.optimizeAppliedToast"));
    } catch (err: any) {
      showToast(t("schedule.optimizeFailedToast", { error: err?.message || "" }));
    } finally {
      setApplyingId(null);
    }
  };

  const dismissOptimization = (id: string) => {
    setOptResultById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  return (
    <div id={listId} className="schedules-stack">
      {items.length === 0 ? (
        <div className="upcoming-card">
          <div className="upcoming-copy">
            <div className="upcoming-sub">{t("inspector.schedulesEmpty")}</div>
          </div>
        </div>
      ) : (
        items.map((item: any) => {
          const enabled = item.enabled !== false;
          const openEditSchedule = () => {
            setState({ scheduleModalOpen: true, editingScheduleId: item.id });
            requestAnimationFrame(() => {
              (document.getElementById("sched-title-input") as HTMLInputElement | null)?.focus();
            });
          };
          const optRes = optResultById[item.id] || null;
          const isOptimizingThis = optimizingId === item.id;
          return (
            <div key={item.id} className="upcoming-card-wrap">
              <div className="upcoming-card">
                <div
                  className="upcoming-copy is-editable"
                  role="button"
                  tabIndex={0}
                  title={t("schedule.clickEditTitle")}
                  onClick={openEditSchedule}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openEditSchedule();
                    }
                  }}
                >
                  <div className="upcoming-title">{item.title}</div>
                  <div className="upcoming-sub">
                    <span>
                      {item.cron
                        ? describeCronExpression(item.cron, locale)
                        : item.scheduleLabel || t("schedule.cronFallback")}
                    </span>
                    {item.cron && (
                      <code className="upcoming-cron-badge" title={`Cron: ${item.cron}`}>
                        {item.cron}
                      </code>
                    )}
                  </div>
                </div>
                <label className="ios-switch">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => handleToggle(item, e.target.checked)}
                  />
                  <span className="ios-switch-track" />
                </label>
                {supportsOptimizer && (
                  <button
                    type="button"
                    className={`section-action-link schedule-optimize-btn${isOptimizingThis ? " is-busy" : ""}`}
                    aria-label={t("schedule.optimizeAria", {
                      title: item.title || t("schedule.defaultName"),
                    })}
                    title={isOptimizingThis ? t("schedule.optimizeRunning") : t("schedule.optimizeTitle")}
                    disabled={Boolean(optimizingId)}
                    onClick={() => void handleOptimize(item)}
                  >
                    <UiIcon name="sparkle" size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="section-action-link"
                  aria-label={t("schedule.editAria", { title: item.title || t("schedule.defaultName") })}
                  title={t("common.edit")}
                  onClick={openEditSchedule}
                >
                  <UiIcon name="pencil" size={14} />
                </button>
                <button
                  type="button"
                  className="section-action-link danger-text"
                  aria-label={t("schedule.deleteAria")}
                  title={t("common.delete")}
                  onClick={() => handleDelete(item)}
                >
                  <UiIcon name="x" size={13} />
                </button>
              </div>
              {isOptimizingThis && (
                <div className="schedule-opt-panel is-loading">{t("schedule.optimizeRunning")}</div>
              )}
              {optRes && !isOptimizingThis && (
                <div className="schedule-opt-panel" data-schedule-opt-id={item.id}>
                  <div className="schedule-opt-header">
                    <span>
                      {optRes.decision === "IMPROVED"
                        ? t("schedule.optimizeImprovedTitle")
                        : t("schedule.optimizeKeepBaseTitle")}
                    </span>
                  </div>
                  {optRes.sideEffectNotice && (
                    <div className="schedule-opt-notice">{optRes.sideEffectNotice}</div>
                  )}
                  {optRes.metrics?.candidate && (
                    <div className="schedule-opt-metrics">
                      {t("schedule.optimizeMetrics", {
                        baseSteps: optRes.metrics.base?.steps ?? 0,
                        baseErrors: optRes.metrics.base?.toolErrors ?? 0,
                        candSteps: optRes.metrics.candidate?.steps ?? 0,
                        candErrors: optRes.metrics.candidate?.toolErrors ?? 0,
                      })}
                    </div>
                  )}
                  {optRes.comparison?.reason && (
                    <div className="schedule-opt-reason">{optRes.comparison.reason}</div>
                  )}
                  {optRes.decision === "IMPROVED" && optRes.optimizedPrompt ? (
                    <>
                      <div className="schedule-opt-prompt">
                        <strong>{t("schedule.optimizePromptLabel")}</strong>{" "}
                        {optRes.optimizedPrompt}
                      </div>
                      {optRes.draftSkill?.name && (
                        <label className="schedule-opt-skill-check">
                          <input
                            type="checkbox"
                            checked={Boolean(saveSkillById[item.id])}
                            onChange={(e) =>
                              setSaveSkillById((prev) => ({
                                ...prev,
                                [item.id]: e.target.checked,
                              }))
                            }
                          />
                          <span>
                            {t("schedule.optimizeSaveSkillLabel", {
                              name: optRes.draftSkill.name,
                            })}
                          </span>
                        </label>
                      )}
                      <div className="schedule-opt-actions">
                        <button
                          type="button"
                          className="section-action-link"
                          onClick={() => dismissOptimization(item.id)}
                        >
                          {t("schedule.optimizeKeepBtn")}
                        </button>
                        <button
                          type="button"
                          className="section-action-link schedule-opt-apply-btn"
                          disabled={applyingId === item.id}
                          onClick={() => void handleApplyOptimization(item, optRes)}
                        >
                          {t("schedule.optimizeApplyBtn")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="schedule-opt-actions">
                      <button
                        type="button"
                        className="section-action-link"
                        onClick={() => dismissOptimization(item.id)}
                      >
                        {t("schedule.optimizeCloseBtn")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

export function LibraryItemsPanel({
  listId,
  expandBtnId,
  ariaLabel,
  emptyText,
}: {
  listId: string;
  expandBtnId: string;
  ariaLabel?: string;
  emptyText?: string;
}) {
  const { locale, t } = useI18n();
  const resolvedAriaLabel = ariaLabel || t("inspector.libraryListAria");
  const resolvedEmptyText = emptyText || t("inspector.libraryDefaultEmpty");
  const libraryItems = useStore((s) => s.libraryItems);
  const libraryFilter = useStore((s) => s.libraryFilter);
  const libraryExpanded = useStore((s) => s.libraryExpanded);

  const filtered = libraryItems.filter((it: any) =>
    libraryFilter === "all" ? true : it.type === libraryFilter
  );
  const visible = libraryExpanded ? filtered : filtered.slice(0, 5);

  const handleRowClick = (item: any) => {
    if (item.type === "media" && item.url) {
      openImageLightbox(apiUrl(item.url), item.name || t("actions.imagePreviewAlt"));
    } else if (item.type !== "media" && item.path && !isMobileViewport()) {
      openLocalFile(item.path, { reveal: false });
    } else if (item.url) {
      const dlUrl = item.url.includes("?") ? `${item.url}&download=1` : `${item.url}?download=1`;
      window.open(apiUrl(dlUrl), "_blank");
    }
  };

  return (
    <>
      <div id={listId} className="library-list" role="list" aria-label={resolvedAriaLabel}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: "16px",
              fontSize: "12.5px",
              color: "var(--text-secondary)",
              textAlign: "center",
            }}
          >
            {libraryItems.length === 0 ? resolvedEmptyText : t("inspector.libraryFilteredEmpty")}
          </div>
        ) : (
          visible.map((item: any, idx: number) => {
            const kb = Math.max(0.1, (Number(item.size) || 0) / 1024).toFixed(1);
            return (
              <div
                key={item.path || item.url || `${item.name}-${idx}`}
                className="library-row"
                onClick={() => handleRowClick(item)}
              >
                {item.type === "media" && item.url ? (
                  <img className="library-thumb" src={apiUrl(item.url)} alt={item.name} />
                ) : (
                  <div className="library-thumb" aria-hidden="true">
                    <UiIcon name="file-text" size={17} />
                  </div>
                )}
                <div className="library-meta">
                  <div className="library-name">{item.name}</div>
                  <div className="library-sub">
                    {kb} KB · {formatClockTime(item.mtime, locale)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <button
        id={expandBtnId}
        type="button"
        className="library-expand-btn"
        hidden={filtered.length <= 5}
        onClick={() => setState((prev) => ({ libraryExpanded: !prev.libraryExpanded }))}
      >
        {libraryExpanded
          ? t("common.collapse")
          : t("inspector.libraryExpandAll", { count: filtered.length })}
      </button>
    </>
  );
}

export function TraceEventsList({
  id,
  className = "trace-drawer-list",
  emptyText,
}: {
  id: string;
  className?: string;
  emptyText?: string;
}) {
  const { t } = useI18n();
  const resolvedEmptyText = emptyText || t("inspector.traceDefaultEmpty");
  const traceItems = useStore((s) => s.traceItems);

  return (
    <div id={id} className={className}>
      {traceItems.length === 0 ? (
        <div className="trace-empty-placeholder">{resolvedEmptyText}</div>
      ) : (
        traceItems.map((item: TraceItem) => {
          if (item.kind === "thought") {
            return (
              <details key={item.id} className="trace-pill">
                <summary>
                  <span className="trace-badge">
                    {item.botName ? (
                      <>
                        <UiIcon name="thought" className="inline-ui-icon" size={12} />
                        {item.botName}
                      </>
                    ) : (
                      t("inspector.traceThoughtBadge")
                    )}
                  </span>
                  {item.routeLabel && <span className="route-mini-tag">{item.routeLabel}</span>}
                  <span className="trace-summary-text">{item.text}</span>
                </summary>
                <div className="trace-detail-body">
                  <pre className="trace-pre">{item.text}</pre>
                </div>
              </details>
            );
          }

          const badgeClass =
            item.status === "ok"
              ? "trace-badge ok"
              : item.status === "warn"
                ? "trace-badge warn"
                : "trace-badge";
          const badgeIcon =
            item.status === "ok"
              ? "check-circle"
              : item.status === "warn"
                ? "alert-triangle"
                : "zap";

          return (
            <details key={item.id} className="trace-pill">
              <summary>
                <span className={badgeClass}>
                  <UiIcon name={badgeIcon} className="inline-ui-icon" size={12} />
                  {item.name || "action"}
                </span>
                <span className="trace-summary-text">
                  <StatusText text={item.summaryText} iconSize={12} />
                </span>
              </summary>
              <div className="trace-detail-body">
                {item.argsJson && <pre className="trace-pre">{item.argsJson}</pre>}
                {item.resultJson && <pre className="trace-pre">{item.resultJson}</pre>}
                {item.screenUrl && (
                  <img
                    className="trace-thumb"
                    src={item.screenUrl}
                    alt={
                      item.isMcpScreen
                        ? t("inspector.macWindowShot")
                        : t("inspector.desktopShot")
                    }
                    loading="lazy"
                    onClick={() =>
                      item.isMcpScreen
                        ? openImageLightbox(item.screenUrl!, t("inspector.macWindowShot"))
                        : openBotScreenOverlay()
                    }
                  />
                )}
              </div>
            </details>
          );
        })
      )}
    </div>
  );
}
