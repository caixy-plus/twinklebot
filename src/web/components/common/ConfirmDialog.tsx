import { useEffect, useRef, type MouseEvent } from "react";
import { resolveConfirmDialog } from "../../services/actions.js";
import { useStore } from "../../state/store.js";

export function ConfirmDialog() {
  const confirmDialog = useStore((s) => s.confirmDialog);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const okBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (confirmDialog.open) {
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
      queueMicrotask(() => {
        okBtnRef.current?.focus();
      });
    } else if (dialog.open) {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute("open");
      }
    }
  }, [confirmDialog.open]);

  const handleClose = () => {
    const dialog = dialogRef.current;
    const confirmed = dialog?.returnValue === "confirm";
    if (dialog) {
      dialog.returnValue = "";
    }
    if (confirmDialog.open) {
      resolveConfirmDialog(confirmed);
    }
  };

  const handleDialogClick = (event: MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
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
      dialog.close("cancel");
    }
  };

  const isPrimary = confirmDialog.tone === "primary";

  return (
    <dialog
      ref={dialogRef}
      id="app-confirm-dialog"
      className="app-confirm-dialog"
      closedby="any"
      aria-labelledby="app-confirm-title"
      aria-describedby="app-confirm-message"
      onClose={handleClose}
      onClick={handleDialogClick}
    >
      <form method="dialog" className="app-confirm-shell">
        <div className="app-confirm-header">
          <div
            id="app-confirm-icon"
            className={`app-confirm-icon ${isPrimary ? "is-primary" : "is-danger"}`}
            aria-hidden="true"
          >
            <svg viewBox="0 0 20 20" fill="none">
              {isPrimary ? (
                <path
                  d="M10 3.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6Zm0 3.6v3.7m0 2.5h.01"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M4.5 6.2h11M8 6.2V4.7a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6.3 6.2l.65 9.1a1.5 1.5 0 0 0 1.5 1.4h3.1a1.5 1.5 0 0 0 1.5-1.4l.65-9.1"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </div>
          <div className="app-confirm-copy">
            <h2 id="app-confirm-title" className="app-confirm-title">
              {confirmDialog.title || "确认操作"}
            </h2>
            <p id="app-confirm-message" className="app-confirm-message">
              {confirmDialog.message}
            </p>
          </div>
        </div>
        <p
          id="app-confirm-detail"
          className="app-confirm-detail"
          hidden={!confirmDialog.detail}
        >
          {confirmDialog.detail}
        </p>
        <div className="app-confirm-actions">
          <button
            id="app-confirm-cancel-btn"
            type="submit"
            value="cancel"
            className="settings-pill-btn app-confirm-btn"
          >
            {confirmDialog.cancelText || "取消"}
          </button>
          <button
            ref={okBtnRef}
            id="app-confirm-ok-btn"
            type="submit"
            value="confirm"
            className={`${isPrimary ? "settings-blue-pill" : "settings-red-btn"} app-confirm-btn`}
          >
            {confirmDialog.confirmText || "确认"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
