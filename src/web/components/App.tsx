import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts.js";
import { useMobileViewport } from "../hooks/useMobileViewport.js";
import { isMobileViewport } from "../mobile-ui.js";
import { bootstrapApp } from "../services/actions.js";
import { getState, readUiPrefs, useStore, writeUiPrefs } from "../state/store.js";
import { ChatStage } from "./chat/ChatStage.js";
import { AccountDisconnectedGate } from "./common/AccountDisconnectedGate.js";
import { ConfirmDialog } from "./common/ConfirmDialog.js";
import { Toast } from "./common/Toast.js";
import { RightInspector } from "./inspector/RightInspector.js";
import { MobileSheets } from "./mobile/MobileSheets.js";
import { BotComputerOverlay } from "./modals/BotComputerOverlay.js";
import { OnboardingOverlay } from "./modals/OnboardingOverlay.js";
import { SecondaryModals } from "./modals/SecondaryModals.js";
import { SettingsModal } from "./modals/SettingsModal.js";
import { SkillsStoreModal } from "./modals/SkillsStoreModal.js";
import { LeftSidebar, SidebarContextMenu } from "./sidebar/LeftSidebar.js";

export function App() {
  const sidebarCompact = useStore((s) => s.sidebarCompact);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const desktopFullscreen = useStore((s) => s.desktopFullscreen);
  const mobileView = useStore((s) => s.mobileView);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const accentColor = useStore((s) => s.accentColor);

  const appShellRef = useRef<HTMLDivElement | null>(null);
  const chatStageRef = useRef<HTMLElement | null>(null);
  const prevSessionIdRef = useRef<string | null>(activeSessionId);

  const { toggleCompactSidebar, setInspectorOpen, toggleInspector } =
    useGlobalShortcuts();
  useMobileViewport(chatStageRef);

  useEffect(() => {
    const prevSid = prevSessionIdRef.current;
    prevSessionIdRef.current = activeSessionId;
    if (!isMobileViewport() || typeof document === "undefined") return;
    const activeEl = document.activeElement as HTMLElement | null;
    if (!activeEl || activeEl.id !== "message-input") return;
    const switchedToList = mobileView === "list";
    const switchedSession =
      Boolean(prevSid && activeSessionId && prevSid !== activeSessionId) &&
      !getState().keepInputFocusedOnSend;
    if (switchedToList || switchedSession) {
      activeEl.blur();
    }
  }, [mobileView, activeSessionId]);

  useEffect(() => {
    const prefs = readUiPrefs();
    if (
      typeof prefs.leftSidebarW === "number" &&
      prefs.leftSidebarW >= 200 &&
      prefs.leftSidebarW <= 420
    ) {
      document.documentElement.style.setProperty("--left-sidebar-w", `${prefs.leftSidebarW}px`);
    }
    if (
      typeof prefs.rightInspectorW === "number" &&
      prefs.rightInspectorW >= 260 &&
      prefs.rightInspectorW <= 460
    ) {
      document.documentElement.style.setProperty(
        "--right-inspector-w",
        `${prefs.rightInspectorW}px`
      );
    }
    bootstrapApp().catch(() => {});
  }, []);

  const startPaneResize = (isLeft: boolean) => (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const shell = appShellRef.current;
    const splitterEl = e.currentTarget;
    shell?.classList.add("is-resizing");
    splitterEl.classList.add("is-dragging");
    let lastWidth = 0;

    const onMove = (ev: MouseEvent) => {
      if (isLeft) {
        const w = Math.min(420, Math.max(200, Math.round(ev.clientX)));
        lastWidth = w;
        document.documentElement.style.setProperty("--left-sidebar-w", `${w}px`);
      } else {
        const w = Math.min(460, Math.max(260, Math.round(window.innerWidth - ev.clientX)));
        lastWidth = w;
        document.documentElement.style.setProperty("--right-inspector-w", `${w}px`);
      }
    };

    const onUp = () => {
      shell?.classList.remove("is-resizing");
      splitterEl.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (lastWidth > 0) {
        writeUiPrefs(isLeft ? { leftSidebarW: lastWidth } : { rightInspectorW: lastWidth });
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={appShellRef}
      className="app-shell"
      id="app-shell"
      data-sidebar-compact={sidebarCompact ? "true" : "false"}
      data-inspector-open={inspectorOpen ? "true" : "false"}
      data-desktop-fullscreen={desktopFullscreen ? "true" : "false"}
      data-mobile-view={mobileView}
      data-accent-color={accentColor || "black"}
    >
      <LeftSidebar
        onToggleCompact={toggleCompactSidebar}
        onStartLeftResize={startPaneResize(true)}
      />

      <ChatStage
        chatStageRef={chatStageRef}
        onToggleInspector={toggleInspector}
      />

      <RightInspector
        onCloseInspector={() => setInspectorOpen(false)}
        onStartRightResize={startPaneResize(false)}
      />

      <SidebarContextMenu />
      <BotComputerOverlay />
      <SecondaryModals />
      <SkillsStoreModal />
      <SettingsModal />
      <ConfirmDialog />
      <AccountDisconnectedGate />
      <OnboardingOverlay />
      <MobileSheets />
      <Toast />
    </div>
  );
}
