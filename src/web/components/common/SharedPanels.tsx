import { isMobileViewport } from "../../mobile-ui.js";
import { describeCronExpression } from "/shared/cron.js";
import {
  openBotScreenOverlay,
  openImageLightbox,
  openLocalFile,
  refreshSchedules,
  showConfirmDialog,
  showToast,
  upsertLocalSession,
} from "../../services/actions.js";
import { apiJson, apiUrl } from "../../services/api-client.js";
import { useI18n } from "../../services/i18n.js";
import { formatClockTime } from "../../state/helpers.js";
import { setState, useStore, type TraceItem } from "../../state/store.js";
import { StatusText, UiIcon } from "./Icon.js";

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
              },
            });
            requestAnimationFrame(() => {
              (
                document.getElementById("bot-memory-modal-name-input") as HTMLInputElement | null
              )?.focus();
            });
          };
          return (
            <div key={mem.id || mem.name} className="private-skill-row">
              <div className="skill-row-icon" aria-hidden="true">
                <UiIcon name="brain" size={19} />
              </div>
              <div
                className="skill-row-info is-editable"
                role="button"
                tabIndex={0}
                title={t("memory.clickEditTitle")}
                onClick={openEditMemory}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openEditMemory();
                  }
                }}
              >
                <div className="skill-row-name">{mem.name || t("memory.defaultName")}</div>
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
          return (
            <div key={item.id} className="upcoming-card">
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
