import { useEffect, type RefObject } from "react";
import {
  minimizeOrExitMobileApp,
  onHardwareBackButton,
} from "../mobile-bridge.js";
import {
  initKeyboardViewportSync,
  isMobileViewport,
} from "../mobile-ui.js";
import {
  closeAllPopovers,
  closeAppsModal,
  closeBotScreenOverlay,
  closeNewChatBar,
  closeSettingsModal,
  openAppsModal,
  resolveConfirmDialog,
  scrollChatStreamToBottom,
} from "../services/actions.js";
import { dismissLanOfflineModal } from "../services/api-client.js";
import { shouldShowAccountDisconnectedGate } from "../services/network-monitor.js";
import { getState, setState } from "../state/store.js";

export function useMobileViewport(chatStageRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    initKeyboardViewportSync({
      onKeyboardOpen: () => {
        scrollChatStreamToBottom({ guardMs: 320 });
      },
    });

    const chatStage = chatStageRef.current;
    let startX = 0;
    let startY = 0;
    let tracking = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (!isMobileViewport() || getState().mobileView !== "chat") return;
      const touch = e.touches?.[0];
      if (!touch || touch.clientX > 36) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches?.[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (dx > 72 && dy < 54) {
        setState({ mobileView: "list" });
      }
    };

    chatStage?.addEventListener("touchstart", handleTouchStart, { passive: true });
    chatStage?.addEventListener("touchend", handleTouchEnd, { passive: true });

    const unsubBack = onHardwareBackButton(() => {
      const s = getState();

      // While the blocking Account Disconnected Gate is active, never dismiss back into
      // the disconnected workspace; if inline LAN pairing is open, close pairing first,
      // otherwise minimize the app cleanly.
      if (shouldShowAccountDisconnectedGate(s)) {
        if (s.mobilePairModalOpen) {
          setState({ mobilePairModalOpen: false });
          return;
        }
        void minimizeOrExitMobileApp();
        return;
      }

      if (s.confirmDialog.open) {
        resolveConfirmDialog(false);
        return;
      }
      if (s.htmlPreviewModal.open) {
        setState((prev) => ({
          htmlPreviewModal: { ...prev.htmlPreviewModal, open: false },
        }));
        return;
      }
      if (s.shortcutsDialogOpen) {
        setState({ shortcutsDialogOpen: false });
        return;
      }
      if (s.mobilePairModalOpen) {
        setState({ mobilePairModalOpen: false });
        return;
      }
      if (s.lanOfflineModalShown) {
        dismissLanOfflineModal();
        return;
      }
      if (s.cloudAccountModal.open) {
        setState((prev) => ({
          cloudAccountModal: { ...prev.cloudAccountModal, open: false },
        }));
        return;
      }
      if (s.botMemoryModal.open) {
        setState((prev) => ({
          botMemoryModal: { ...prev.botMemoryModal, open: false },
        }));
        return;
      }
      if (s.scheduleModalOpen) {
        setState({ scheduleModalOpen: false, editingScheduleId: null });
        return;
      }
      if (s.imageLightbox.open) {
        setState({ imageLightbox: { open: false, url: "", alt: "" } });
        return;
      }
      if (s.desktopPairingModal.open) {
        setState((prev) => ({
          desktopPairingModal: { ...prev.desktopPairingModal, open: false },
        }));
        return;
      }
      if (s.openPopover !== null) {
        closeAllPopovers();
        return;
      }
      if (s.searchModalOpen) {
        setState({ searchModalOpen: false });
        return;
      }
      if (s.traceDrawerOpen) {
        setState({ traceDrawerOpen: false });
        return;
      }
      if (s.botExchangeSheet.open) {
        setState((prev) => ({
          botExchangeSheet: { ...prev.botExchangeSheet, open: false },
        }));
        return;
      }
      if (s.newChatBarOpen) {
        closeNewChatBar();
        return;
      }
      if (s.appsModalOpen) {
        if (s.skillsView === "detail") {
          openAppsModal(s.detailFrom === "manage" ? "manage" : "store");
          return;
        }
        if (s.skillsView === "manage") {
          openAppsModal("store");
          return;
        }
        closeAppsModal();
        return;
      }
      if (s.settingsModal.open) {
        closeSettingsModal();
        return;
      }
      if (s.screenOverlayOpen) {
        closeBotScreenOverlay();
        return;
      }
      if (s.mobileSheets.nodeOpen) {
        setState((prev) => ({
          mobileSheets: { ...prev.mobileSheets, nodeOpen: false },
        }));
        return;
      }
      if (s.mobileSheets.botEditorOpen) {
        setState((prev) => ({
          mobileSheets: { ...prev.mobileSheets, botEditorOpen: false },
        }));
        return;
      }
      if (s.mobileSheets.settingsOpen) {
        setState((prev) => ({
          mobileSheets: { ...prev.mobileSheets, settingsOpen: false },
        }));
        return;
      }
      if (s.mobileSheets.inspectorOpen) {
        setState((prev) => ({
          mobileSheets: { ...prev.mobileSheets, inspectorOpen: false },
        }));
        return;
      }
      if (s.mobileView === "chat") {
        setState({ mobileView: "list" });
        return;
      }
      void minimizeOrExitMobileApp();
    });

    return () => {
      chatStage?.removeEventListener("touchstart", handleTouchStart);
      chatStage?.removeEventListener("touchend", handleTouchEnd);
      if (typeof unsubBack === "function") unsubBack();
    };
  }, [chatStageRef]);
}
