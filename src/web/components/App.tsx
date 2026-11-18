import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts.js";
import { useMobileViewport } from "../hooks/useMobileViewport.js";
import { bootstrapApp } from "../services/actions.js";
import { useStore } from "../state/store.js";
import { ChatStage } from "./chat/ChatStage.js";
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
  const accentColor = useStore((s) => s.accentColor);

  const appShellRef = useRef<HTMLDivElement | null>(null);
  const chatStageRef = useRef<HTMLElement | null>(null);

  const { toggleCompactSidebar, setInspectorOpen, toggleInspector } =
    useGlobalShortcuts();
  useMobileViewport(chatStageRef);

  useEffect(() => {
    bootstrapApp().catch(() => {});
  }, []);

  const startPaneResize = (isLeft: boolean) => (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const shell = appShellRef.current;
    const splitterEl = e.currentTarget;
    shell?.classList.add("is-resizing");
    splitterEl.classList.add("is-dragging");

    const onMove = (ev: MouseEvent) => {
      if (isLeft) {
        const w = Math.min(420, Math.max(200, ev.clientX));
        document.documentElement.style.setProperty("--left-sidebar-w", `${w}px`);
      } else {
        const w = Math.min(460, Math.max(260, window.innerWidth - ev.clientX));
        document.documentElement.style.setProperty("--right-inspector-w", `${w}px`);
      }
    };

    const onUp = () => {
      shell?.classList.remove("is-resizing");
      splitterEl.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
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
      <OnboardingOverlay />
      <MobileSheets />
      <Toast />
    </div>
  );
}
