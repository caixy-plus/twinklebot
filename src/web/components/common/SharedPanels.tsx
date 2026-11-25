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
      title: "删除专属记忆",
      message: `确定要删除专属记忆「${mem.name || "专属记忆"}」吗？`,
      detail: "删除后该 Bot 将不再参考这条记忆。",
      confirmText: "确认删除",
      cancelText: "取消",
      tone: "danger",
    });
    if (!ok) return;
    const next = memories.filter((x) => x.id !== mem.id);
    const updated = await apiJson(`/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memories: next, touch: false }),
    });
    upsertLocalSession(updated);
    showToast(`已移除专属记忆「${mem.name}」`);
  };

  return (
    <div id={listId} className="private-skills-list">
      {memories.length === 0 ? (
        <div className="skills-empty" style={{ fontSize: "12px" }}>
          该 Bot 会在对话中自动沉淀和管理自己的专属记忆，也可点击右上角「+ 新增」。
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
                title="点击编辑专属记忆"
                onClick={openEditMemory}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openEditMemory();
                  }
                }}
              >
                <div className="skill-row-name">{mem.name || "专属记忆"}</div>
                <div className="skill-row-desc">
                  {mem.instruction || mem.content || mem.desc || ""}
                </div>
              </div>
              <label className="ios-switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  aria-label={`启用专属记忆 ${mem.name}`}
                  onChange={(e) => handleToggle(mem, e.target.checked)}
                />
                <span className="ios-switch-track" />
              </label>
              <button
                type="button"
                className="section-action-link"
                aria-label={`编辑专属记忆 ${mem.name || "专属记忆"}`}
                title="编辑"
                onClick={openEditMemory}
              >
                <UiIcon name="pencil" size={14} />
              </button>
              <button
                type="button"
                className="section-action-link danger-text"
                onClick={() => handleDelete(mem)}
              >
                删除
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

export function SchedulesList({ listId }: { listId: string }) {
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
    showToast(checked ? "例行任务已启用" : "例行任务已暂停");
  };

  const handleDelete = async (item: any) => {
    const label = item.title || item.name || "例行任务";
    const ok = await showConfirmDialog({
      title: "删除例行任务",
      message: `确定要删除定时任务「${label}」吗？`,
      detail: item.cron ? `触发计划：${item.cron}` : "",
      confirmText: "确认删除",
      cancelText: "取消",
      tone: "danger",
    });
    if (!ok) return;
    await apiJson(`/api/schedules/${item.id}`, { method: "DELETE" });
    refreshSchedules();
    showToast(`已删除例行任务「${label}」`);
  };

  return (
    <div id={listId} className="schedules-stack">
      {items.length === 0 ? (
        <div className="upcoming-card">
          <div className="upcoming-copy">
            <div className="upcoming-sub">暂无例行提醒，点击右上角「+ 新建」添加</div>
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
                title="点击编辑例行任务"
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
                    {item.scheduleLabel ||
                      (item.cron ? describeCronExpression(item.cron) : "定时执行")}
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
                aria-label={`编辑例行任务 ${item.title || "例行任务"}`}
                title="编辑"
                onClick={openEditSchedule}
              >
                <UiIcon name="pencil" size={14} />
              </button>
              <button
                type="button"
                className="section-action-link danger-text"
                aria-label="删除例行任务"
                title="删除"
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
  ariaLabel = "资料库列表",
  emptyText = "对话中截图或生成的文件会归档在此",
}: {
  listId: string;
  expandBtnId: string;
  ariaLabel?: string;
  emptyText?: string;
}) {
  const libraryItems = useStore((s) => s.libraryItems);
  const libraryFilter = useStore((s) => s.libraryFilter);
  const libraryExpanded = useStore((s) => s.libraryExpanded);

  const filtered = libraryItems.filter((it: any) =>
    libraryFilter === "all" ? true : it.type === libraryFilter
  );
  const visible = libraryExpanded ? filtered : filtered.slice(0, 5);

  const handleRowClick = (item: any) => {
    if (item.type === "media" && item.url) {
      openImageLightbox(apiUrl(item.url), item.name || "图片预览");
    } else if (item.type !== "media" && item.path && !isMobileViewport()) {
      openLocalFile(item.path, { reveal: false });
    } else if (item.url) {
      const dlUrl = item.url.includes("?") ? `${item.url}&download=1` : `${item.url}?download=1`;
      window.open(apiUrl(dlUrl), "_blank");
    }
  };

  return (
    <>
      <div id={listId} className="library-list" role="list" aria-label={ariaLabel}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: "16px",
              fontSize: "12.5px",
              color: "var(--text-secondary)",
              textAlign: "center",
            }}
          >
            {libraryItems.length === 0 ? emptyText : "暂无截图或工作区文件产物"}
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
                    {kb} KB · {formatClockTime(item.mtime)}
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
        {libraryExpanded ? "收起" : `展开全部 (${filtered.length})`}
      </button>
    </>
  );
}

export function TraceEventsList({
  id,
  className = "trace-drawer-list",
  emptyText = "发送任务后，Bot 的思考链路与工具调用会实时记录在此",
}: {
  id: string;
  className?: string;
  emptyText?: string;
}) {
  const traceItems = useStore((s) => s.traceItems);

  return (
    <div id={id} className={className}>
      {traceItems.length === 0 ? (
        <div className="trace-empty-placeholder">{emptyText}</div>
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
                      "思考"
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
                    alt={item.isMcpScreen ? "Mac 窗口截图" : "桌面截图"}
                    loading="lazy"
                    onClick={() =>
                      item.isMcpScreen
                        ? openImageLightbox(item.screenUrl!, "Mac 窗口截图")
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
