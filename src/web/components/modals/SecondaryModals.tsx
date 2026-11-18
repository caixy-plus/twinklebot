import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { upsertCloudAccount } from "/accounts-store.js";
import { buildPreviewSrcdoc } from "../../preview-utils.js";
import {
  openBotScreenOverlay,
  openNewChatBar,
  openSettingsModal,
  refreshSchedules,
  saveAccountsDirectory,
  selectSession,
  showToast,
  switchAccount,
} from "../../services/actions.js";
import { apiJson } from "../../services/api-client.js";
import { BG_MODES } from "../../state/constants.js";
import {
  formatClockTime,
  teardownPreviewIframe,
} from "../../state/helpers.js";
import { getState, setState, useStore } from "../../state/store.js";
import { SessionAvatar } from "../common/AvatarView.js";

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
  const shortcutsDialogOpen = useStore((s) => s.shortcutsDialogOpen);
  const imageLightbox = useStore((s) => s.imageLightbox);
  const htmlPreviewModal = useStore((s) => s.htmlPreviewModal);
  const cloudAccountModal = useStore((s) => s.cloudAccountModal);
  const desktopPairingModal = useStore((s) => s.desktopPairingModal);
  const sessions = useStore((s) => s.sessions);
  const primarySessionId = useStore((s) => s.primarySessionId);
  const activeSessionId = useStore((s) => s.activeSessionId);

  // Search palette state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ bots: any[]; messages: any[] }>({
    bots: [],
    messages: [],
  });

  // Schedule modal state
  const [schedTitle, setSchedTitle] = useState("");
  const [schedRepeat, setSchedRepeat] = useState("daily");
  const [schedLabel, setSchedLabel] = useState("每天 10:00");
  const [schedPrompt, setSchedPrompt] = useState("");

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
    { label: "创建新 Bot 或 Bot 群聊", sub: "+", fn: () => openNewChatBar(false) },
    { label: "打开 Bot 的电脑 (全屏实时桌面)", sub: "电脑", fn: () => openBotScreenOverlay() },
    {
      label: "设置 · 权限与自动审核规则",
      sub: "设置",
      fn: () => openSettingsModal("permissions"),
    },
    {
      label: "设置 · 外观主题 (跟随系统 / 浅色 / 深色)",
      sub: "设置",
      fn: () => openSettingsModal("general"),
    },
  ].filter(
    (nav) =>
      !searchQuery.trim() || nav.label.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  const handleSaveSchedule = async () => {
    const title = schedTitle.trim();
    const prompt = schedPrompt.trim();
    const scheduleLabel = schedLabel.trim() || "每天 10:00";
    if (!title || !prompt || !activeSessionId) {
      showToast("请填写任务名称与执行指令");
      return;
    }
    const hasExplicitClock = /(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/.test(scheduleLabel);
    const nextRunAt =
      schedRepeat === "once" && !hasExplicitClock
        ? new Date(Date.now() + 60 * 1000).toISOString()
        : undefined;
    await apiJson("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        sessionId: activeSessionId,
        title,
        prompt,
        repeat: schedRepeat,
        scheduleLabel,
        ...(nextRunAt ? { nextRunAt } : {}),
      }),
    });
    setSchedTitle("");
    setSchedPrompt("");
    setState({ scheduleModalOpen: false });
    refreshSchedules();
    showToast("例行任务已创建");
  };

  const handleSaveCloudAccount = async () => {
    try {
      const next = upsertCloudAccount(getState().accountsState, {
        id: cloudAccountModal.id.trim(),
        baseUrl: cloudAccountModal.baseUrl.trim(),
        name: cloudAccountModal.name.trim(),
        authToken: cloudAccountModal.authToken.trim(),
      });
      const added = next.accounts[next.accounts.length - 1];
      await saveAccountsDirectory(next);
      setState((prev) => ({
        cloudAccountModal: { ...prev.cloudAccountModal, open: false, feedback: "" },
      }));
      await switchAccount(cloudAccountModal.id.trim() || added.id);
    } catch (err: any) {
      setState((prev) => ({
        cloudAccountModal: {
          ...prev.cloudAccountModal,
          feedback: err?.message || "云端地址格式无效",
        },
      }));
    }
  };

  // HTML Preview Modal derived props
  const isModalPreview = htmlPreviewModal.mode !== "code";
  const curBgObj =
    BG_MODES.find((b) => b.key === htmlPreviewModal.canvasBg) || BG_MODES[0];
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
        <div className="search-palette-modal" role="dialog" aria-modal="true" aria-label="搜索">
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
              placeholder="搜索 Bot、聊天消息全文、设置..."
              aria-label="搜索"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div
            id="palette-results-list"
            className="palette-results-list"
            role="listbox"
            aria-label="结果"
          >
            {searchResults.bots.length > 0 && (
              <>
                <div className="palette-section-title">Bot 与群聊</div>
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
                      {b.type === "group" ? "群聊" : "Bot"}
                    </span>
                  </button>
                ))}
              </>
            )}

            {searchResults.messages.length > 0 && (
              <>
                <div className="palette-section-title">历史聊天消息匹配</div>
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
                    <span className="palette-result-sub">{formatClockTime(m.at)}</span>
                  </button>
                ))}
              </>
            )}

            <div className="palette-section-title">快捷导航</div>
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

      {/* ==================== SCHEDULE CREATION MODAL ==================== */}
      <div
        id="schedule-modal-backdrop"
        className="modal-backdrop"
        hidden={!scheduleModalOpen}
        onClick={(e) => {
          if (e.target === e.currentTarget) setState({ scheduleModalOpen: false });
        }}
      >
        <div
          className="compact-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="创建例行任务"
        >
          <h3 className="compact-dialog-title">创建例行任务</h3>
          <input
            id="sched-title-input"
            type="text"
            className="inline-text-input"
            placeholder="任务名称（如：每日检查邮件回信）"
            value={schedTitle}
            onChange={(e) => setSchedTitle(e.target.value)}
          />
          <div className="inline-form-grid">
            <select
              id="sched-repeat-select"
              className="inline-text-input"
              value={schedRepeat}
              onChange={(e) => setSchedRepeat(e.target.value)}
            >
              <option value="daily">每天执行</option>
              <option value="hourly">每小时执行</option>
              <option value="once">仅执行一次（1分钟后测试）</option>
            </select>
            <input
              id="sched-label-input"
              type="text"
              className="inline-text-input"
              value={schedLabel}
              placeholder="时间标签"
              onChange={(e) => setSchedLabel(e.target.value)}
            />
          </div>
          <textarea
            id="sched-prompt-input"
            className="inline-textarea"
            rows={3}
            placeholder="到点发送给当前 Bot 执行的具体指令..."
            value={schedPrompt}
            onChange={(e) => setSchedPrompt(e.target.value)}
          />
          <div className="inline-form-actions">
            <button
              id="cancel-sched-modal-btn"
              type="button"
              className="settings-pill-btn"
              onClick={() => setState({ scheduleModalOpen: false })}
            >
              取消
            </button>
            <button
              id="save-sched-modal-btn"
              type="button"
              className="settings-blue-pill"
              onClick={handleSaveSchedule}
            >
              创建任务
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
        aria-label="图片预览"
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
            下载原图
          </a>
          <button
            id="close-lightbox-btn"
            type="button"
            className="screen-exit-btn"
            aria-label="关闭预览"
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
          alt={imageLightbox.alt || "图片大图预览"}
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
                {htmlPreviewModal.badgeLabel || "HTML 预览"}
              </h2>
              <span className="html-preview-sandbox-badge">沙盒隔离运行</span>
            </div>

            <div className="html-preview-dialog-controls">
              <div className="msg-preview-tabs" role="group" aria-label="视图切换">
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
                  预览
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
                  源码
                </button>
              </div>

              <div
                className="msg-preview-tabs"
                id="html-preview-viewport-group"
                role="group"
                aria-label="视口宽度"
                hidden={!isModalPreview || htmlPreviewModal.kind === "svg"}
              >
                {(
                  [
                    ["full", "自适应"],
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
                  const curIdx = BG_MODES.findIndex(
                    (b) => b.key === htmlPreviewModal.canvasBg
                  );
                  const nextKey = BG_MODES[(curIdx + 1) % BG_MODES.length].key;
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
                aria-label="刷新预览"
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
                <span>刷新</span>
              </button>

              <button
                id="html-preview-modal-copy-btn"
                type="button"
                className="msg-preview-btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(htmlPreviewModal.code || "");
                  } catch {}
                  showToast("源码已复制");
                }}
              >
                复制源码
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
                下载
              </button>

              <button
                id="close-html-preview-dialog-btn"
                type="button"
                className="modal-close-btn html-preview-close-btn"
                aria-label="关闭预览"
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
                title="HTML 与 SVG 沙盒预览"
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
              快捷键与使用指南
            </h2>
            <button
              id="close-shortcuts-dialog-btn"
              type="button"
              className="modal-close-btn"
              aria-label="关闭快捷键指南"
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
            <div className="shortcuts-section-label">全局导航快捷键</div>
            <div className="shortcuts-grid">
              <div className="shortcut-row">
                <span>全局搜索 Bot 与历史消息</span>
                <kbd>⌘ K</kbd>
              </div>
              <div className="shortcut-row">
                <span>打开设置与账单面板</span>
                <kbd>⌘ ,</kbd>
              </div>
              <div className="shortcut-row">
                <span>收起 / 展开左侧边栏</span>
                <kbd>⌘ \</kbd>
              </div>
              <div className="shortcut-row">
                <span>打开 / 关闭右侧资料库与动态</span>
                <kbd>⌘ I</kbd>
              </div>
            </div>
            <div className="shortcuts-section-label">对话与多媒体能力</div>
            <div className="shortcuts-grid">
              <div className="shortcut-row">
                <span>在群聊中指定某个专职 Bot 发言</span>
                <kbd>@</kbd>
              </div>
              <div className="shortcut-row">
                <span>输入框内换行（不直接发送）</span>
                <kbd>Shift + Enter</kbd>
              </div>
              <div className="shortcut-row">
                <span>划选任意回复文字片段精准引用追问</span>
                <kbd>选中文字 → 引用</kbd>
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
          aria-label="添加云端账号"
        >
          <div className="vault-header-row">
            <h3 className="compact-dialog-title" id="cloud-account-modal-title">
              添加云端账号
            </h3>
            <button
              id="close-cloud-account-modal-btn"
              type="button"
              className="modal-close-btn"
              aria-label="关闭"
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
            <span>云端服务地址（Server URL）</span>
            <input
              id="cloud-account-url-input"
              type="url"
              className="inline-text-input"
              placeholder="https://bot.example.com"
              value={cloudAccountModal.baseUrl}
              onChange={(e) =>
                setState((prev) => ({
                  cloudAccountModal: { ...prev.cloudAccountModal, baseUrl: e.target.value },
                }))
              }
            />
          </label>
          <label className="onboarding-field">
            <span>工作台名称</span>
            <input
              id="cloud-account-name-input"
              type="text"
              className="inline-text-input"
              placeholder="例如：公司云端工作台"
              value={cloudAccountModal.name}
              onChange={(e) =>
                setState((prev) => ({
                  cloudAccountModal: { ...prev.cloudAccountModal, name: e.target.value },
                }))
              }
            />
          </label>
          <label className="onboarding-field">
            <span>访问令牌（Bearer Token）</span>
            <input
              id="cloud-account-token-input"
              type="password"
              className="inline-text-input"
              placeholder="输入 CLOUD_AUTH_TOKEN"
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
              取消
            </button>
            <button
              id="save-cloud-account-btn"
              type="button"
              className="settings-blue-pill"
              onClick={handleSaveCloudAccount}
            >
              保存并连接
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
          aria-label="手机端配对请求"
        >
          <h3 className="compact-dialog-title">手机端请求配对本机</h3>
          <p className="settings-row-sub" id="desktop-pairing-device-meta">
            {desktopPairingModal.deviceName
              ? `来自「${desktopPairingModal.deviceName}」的配对请求，请在手机端输入以下 6 位数字配对码（5 分钟内有效）：`
              : "请在手机端输入以下 6 位数字配对码（5 分钟内有效）："}
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
              我知道了
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
