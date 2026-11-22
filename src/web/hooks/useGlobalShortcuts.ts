import { useCallback, useEffect, useRef } from "react";
import { isMobileViewport } from "../mobile-ui.js";
import {
  applyThemePreference,
  closeAllPopovers,
  closeAppsModal,
  closeBotScreenOverlay,
  closeNewChatBar,
  closeSettingsModal,
  openBotScreenOverlay,
  openNewChatBar,
  openSettingsModal,
  syncBotScreenLandscapeState,
} from "../services/actions.js";
import { apiJson } from "../services/api-client.js";
import { shouldShowAccountDisconnectedGate } from "../services/network-monitor.js";
import { previewFrameRegistry } from "../state/helpers.js";
import {
  getState,
  resolveApprovalItemSummary,
  setState,
  writeUiPrefs,
} from "../state/store.js";

export const DESKTOP_INSPECTOR_COLLAPSE_W = 920;
export const DESKTOP_SIDEBAR_COMPACT_W = 720;

export function useGlobalShortcuts() {
  const preferredSidebarCompactRef = useRef<boolean>(getState().sidebarCompact);
  const preferredInspectorOpenRef = useRef<boolean>(getState().inspectorOpen);
  const lastDesktopWidthRef = useRef<number | null>(null);

  const toggleCompactSidebar = useCallback(() => {
    const next = !getState().sidebarCompact;
    setState({ sidebarCompact: next });
    if (typeof window !== "undefined" && window.innerWidth >= DESKTOP_SIDEBAR_COMPACT_W) {
      preferredSidebarCompactRef.current = next;
      writeUiPrefs({ sidebarCompact: next });
    }
  }, []);

  const setInspectorOpen = useCallback((open: boolean) => {
    setState({ inspectorOpen: open });
    if (typeof window !== "undefined" && window.innerWidth >= DESKTOP_INSPECTOR_COLLAPSE_W) {
      preferredInspectorOpenRef.current = open;
      writeUiPrefs({ inspectorOpen: open });
    }
  }, []);

  const toggleInspector = useCallback(() => {
    setInspectorOpen(!getState().inspectorOpen);
  }, [setInspectorOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncDesktopResponsivePanes = () => {
      if (isMobileViewport()) return;
      const w = window.innerWidth;
      const prev = lastDesktopWidthRef.current;
      lastDesktopWidthRef.current = w;

      if (prev === null) {
        if (w < DESKTOP_INSPECTOR_COLLAPSE_W) {
          setState({ inspectorOpen: false });
        }
        if (w < DESKTOP_SIDEBAR_COMPACT_W) {
          setState({ sidebarCompact: true });
        }
        return;
      }

      if (prev >= DESKTOP_INSPECTOR_COLLAPSE_W && w < DESKTOP_INSPECTOR_COLLAPSE_W) {
        setState({ inspectorOpen: false });
      } else if (prev < DESKTOP_INSPECTOR_COLLAPSE_W && w >= DESKTOP_INSPECTOR_COLLAPSE_W) {
        setState({ inspectorOpen: preferredInspectorOpenRef.current });
      }

      if (prev >= DESKTOP_SIDEBAR_COMPACT_W && w < DESKTOP_SIDEBAR_COMPACT_W) {
        setState({ sidebarCompact: true });
      } else if (prev < DESKTOP_SIDEBAR_COMPACT_W && w >= DESKTOP_SIDEBAR_COMPACT_W) {
        setState({ sidebarCompact: preferredSidebarCompactRef.current });
      }
    };

    syncDesktopResponsivePanes();

    const handleResize = () => {
      syncDesktopResponsivePanes();
      syncBotScreenLandscapeState();
    };

    const handlePreviewResizeMessage = (event: MessageEvent) => {
      // Sandboxed `srcdoc` iframes without `allow-same-origin` emit from opaque `"null"` origin
      if (event.origin !== "null") return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.__twinklebotPreviewResize !== true) return;
      const id = typeof data.id === "string" ? data.id : "";
      const iframe = id ? previewFrameRegistry.get(id) : null;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const rawH = Number(data.height);
      if (!Number.isFinite(rawH) || rawH <= 0) return;
      const clamped = Math.min(460, Math.max(110, Math.ceil(rawH) + 4));
      iframe.style.setProperty("--preview-h", `${clamped}px`);
    };

    const handleDocumentClick = (e: MouseEvent) => {
      closeAllPopovers();
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.(".msg-group") && getState().mobileActionsOpenSeq !== null) {
        setState({ mobileActionsOpenSeq: null });
      }
    };

    const openPaletteSearch = () => {
      closeAllPopovers();
      setState({ searchModalOpen: true });
      requestAnimationFrame(() => {
        (document.getElementById("palette-search-input") as HTMLInputElement | null)?.focus();
      });
    };

    const handleDocumentKeyDown = (e: KeyboardEvent) => {
      if (shouldShowAccountDisconnectedGate(getState())) {
        if ((e.metaKey || e.ctrlKey) && ["k", ",", "\\", "i"].includes(e.key.toLowerCase())) {
          e.preventDefault();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPaletteSearch();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openSettingsModal("general");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleCompactSidebar();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        const activeEl = document.activeElement as HTMLElement | null;
        const tag = activeEl?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !activeEl?.isContentEditable) {
          e.preventDefault();
          toggleInspector();
          return;
        }
      }

      if (e.key === "Escape") {
        const s = getState();
        if (s.imageLightbox.open) {
          setState({ imageLightbox: { open: false, url: "", alt: "" } });
          return;
        }
        if (s.traceDrawerOpen) {
          setState({ traceDrawerOpen: false });
          return;
        }
        // If there is an active pending approval card, Esc denies it once!
        const pendingApproval = s.streamItems.find(
          (item) => item.kind === "approval" && !item.resolved
        );
        if (pendingApproval && pendingApproval.kind === "approval" && s.activeSessionId) {
          const sid = s.activeSessionId;
          setState((prev) => ({
            streamItems: prev.streamItems.map((it) =>
              it.kind === "approval" && it.callId === pendingApproval.callId
                ? {
                    ...it,
                    resolved: true,
                    receiptText: resolveApprovalItemSummary(
                      pendingApproval.name,
                      pendingApproval.args,
                      "deny"
                    ),
                  }
                : it
            ),
          }));
          apiJson(`/api/approvals/${pendingApproval.callId}`, {
            method: "POST",
            body: JSON.stringify({ allow: false }),
          }).catch(() => {});
          return;
        }

        if (s.replyTarget || s.replyQuote || s.pendingQuotes.length > 0) {
          setState({
            replyTarget: null,
            replyQuote: null,
            pendingQuotes: [],
          });
        }
        closeAllPopovers();
        if (s.newChatBarOpen) closeNewChatBar();
        if (s.botExchangeSheet.open) {
          setState((prev) => ({
            botExchangeSheet: { ...prev.botExchangeSheet, open: false },
          }));
        }
        if (s.screenOverlayOpen) closeBotScreenOverlay();
        if (s.searchModalOpen) setState({ searchModalOpen: false });
        if (s.appsModalOpen) closeAppsModal();
        if (s.settingsModal.open) closeSettingsModal();
        if (s.scheduleModalOpen) setState({ scheduleModalOpen: false, editingScheduleId: null });
        if (s.botMemoryModal.open) {
          setState((prev) => ({
            botMemoryModal: { ...prev.botMemoryModal, open: false },
          }));
        }
        if (s.cloudAccountModal.open) {
          setState((prev) => ({
            cloudAccountModal: { ...prev.cloudAccountModal, open: false },
          }));
        }
        if (
          !isMobileViewport() &&
          window.innerWidth < DESKTOP_INSPECTOR_COLLAPSE_W &&
          s.inspectorOpen
        ) {
          setState({ inspectorOpen: false });
        }
        return;
      }

      // Keyboard shortcuts `1`–`6` or `A`–`F` for active Question Card (`ask_user_choice`) when focus is not in an input
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const activeEl = document.activeElement as HTMLElement | null;
        const tag = activeEl?.tagName;
        if (
          tag !== "INPUT" &&
          tag !== "TEXTAREA" &&
          tag !== "SELECT" &&
          !activeEl?.isContentEditable
        ) {
          let optIdx = -1;
          if (e.key >= "1" && e.key <= "6") {
            optIdx = Number(e.key) - 1;
          } else if (/^[a-fA-F]$/.test(e.key)) {
            optIdx = e.key.toUpperCase().charCodeAt(0) - 65;
          }
          if (optIdx >= 0) {
            const pendingChoiceCards = document.querySelectorAll<HTMLElement>(
              ".choice-card:not(.is-resolved):not(.is-superseded)"
            );
            const activeCard = pendingChoiceCards[pendingChoiceCards.length - 1];
            const optBtns = activeCard?.querySelectorAll<HTMLButtonElement>(
              ".choice-option-btn:not(.choice-custom-trigger)"
            );
            if (optBtns && optBtns[optIdx]) {
              e.preventDefault();
              optBtns[optIdx].click();
            }
          }
        }
      }
    };

    const unsubMenu = window.twinklebotDesktop?.onMenuCommand?.((cmd: string, payload?: any) => {
      if (cmd === "new-bot") openNewChatBar(false);
      else if (cmd === "new-group") openNewChatBar(true);
      else if (cmd === "open-search") openPaletteSearch();
      else if (cmd === "open-settings") openSettingsModal(payload?.tab || "general");
      else if (cmd === "toggle-compact-sidebar") toggleCompactSidebar();
      else if (cmd === "toggle-inspector") toggleInspector();
      else if (cmd === "open-computer") openBotScreenOverlay();
      else if (cmd === "set-theme" && payload?.theme) applyThemePreference(payload.theme, true);
    });

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", syncBotScreenLandscapeState);
    window.addEventListener("message", handlePreviewResizeMessage);
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", syncBotScreenLandscapeState);
      window.removeEventListener("message", handlePreviewResizeMessage);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleDocumentKeyDown);
      if (typeof unsubMenu === "function") unsubMenu();
    };
  }, [toggleCompactSidebar, toggleInspector]);

  return {
    toggleCompactSidebar,
    setInspectorOpen,
    toggleInspector,
  };
}
