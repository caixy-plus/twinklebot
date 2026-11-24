import {
  BOT_COLORS,
  BOT_SHAPES,
  createMascotSvg,
} from "./avatars.js";

const el = (id) => document.getElementById(id);
const closeTimers = new WeakMap();

export function isMobileViewport() {
  if (typeof window === "undefined") return false;
  if (window.twinklebotDesktop?.isElectron || document.documentElement?.dataset?.electron === "true") {
    return false;
  }
  if (window.__TWINKLEBOT_APP_TARGET__ === "mobile") return true;
  if (window.Capacitor?.isNativePlatform?.()) return true;
  return (
    window.matchMedia?.(
      "(hover: none) and (pointer: coarse) and (max-width: 1024px)"
    )?.matches ?? false
  );
}

const MOBILE_LIVE_BUBBLE_GAP = 10;

export function syncMobileChatBottomMetrics() {
  if (typeof document === "undefined") return;
  const chatStage = document.querySelector(".chat-stage") as HTMLElement | null;
  if (!chatStage) return;
  if (!isMobileViewport()) {
    chatStage.style.removeProperty("--mobile-composer-bottom");
    chatStage.style.removeProperty("--mobile-live-bubble-reserve");
    chatStage.style.removeProperty("--mobile-scroll-btn-height");
    return;
  }
  const liveBubble = el("live-working-bubble");
  const liveBubbleVisible = Boolean(
    liveBubble && !liveBubble.hidden && liveBubble.offsetHeight > 0
  );
  const liveReserve = liveBubbleVisible
    ? Math.ceil(liveBubble!.offsetHeight) + MOBILE_LIVE_BUBBLE_GAP
    : 0;
  const nextLiveReserve = `${liveReserve}px`;
  if (chatStage.style.getPropertyValue("--mobile-live-bubble-reserve") !== nextLiveReserve) {
    chatStage.style.setProperty("--mobile-live-bubble-reserve", nextLiveReserve);
  }
  const composerWrap = el("composer-wrap");
  if (composerWrap && chatStage.clientHeight > 0 && composerWrap.offsetHeight > 0) {
    const baseComposerBottom = Math.max(
      composerWrap.offsetHeight,
      Math.round(chatStage.clientHeight - composerWrap.offsetTop)
    );
    const nextComposerBottom = `${baseComposerBottom + liveReserve}px`;
    if (chatStage.style.getPropertyValue("--mobile-composer-bottom") !== nextComposerBottom) {
      chatStage.style.setProperty("--mobile-composer-bottom", nextComposerBottom);
    }
  }
  const scrollBtn = el("scroll-bottom-btn");
  if (scrollBtn && !scrollBtn.hidden && scrollBtn.offsetHeight > 0) {
    const btnHeight = Math.max(34, Math.ceil(scrollBtn.offsetHeight));
    const nextBtnHeight = `${btnHeight}px`;
    if (chatStage.style.getPropertyValue("--mobile-scroll-btn-height") !== nextBtnHeight) {
      chatStage.style.setProperty("--mobile-scroll-btn-height", nextBtnHeight);
    }
  }
}

export function setMobileView(view = "list") {
  const shell = el("app-shell");
  if (!shell) return;
  shell.dataset.mobileView = view === "chat" ? "chat" : "list";
  if (view === "chat") {
    requestAnimationFrame(() => syncMobileChatBottomMetrics());
  }
}

export function openSheetAnimated(sheet) {
  if (!sheet) return;
  const prevTimer = closeTimers.get(sheet);
  if (prevTimer) {
    clearTimeout(prevTimer);
    closeTimers.delete(sheet);
  }
  sheet.classList.remove("is-closing");
  sheet.hidden = false;
  requestAnimationFrame(() => {
    sheet.classList.add("is-open");
  });
}

export function closeSheetAnimated(sheet) {
  if (!sheet || sheet.hidden) return;
  sheet.classList.remove("is-open");
  sheet.classList.add("is-closing");
  const prevTimer = closeTimers.get(sheet);
  if (prevTimer) clearTimeout(prevTimer);
  const timer = setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("is-closing");
    closeTimers.delete(sheet);
  }, 220);
  closeTimers.set(sheet, timer);
}

export function closeMobileInspectorSheet() {
  closeSheetAnimated(el("mobile-inspector-sheet"));
}

export function openMobileInspectorSheet(tab = "activity") {
  const sheet = el("mobile-inspector-sheet");
  if (!sheet) return;
  const resolvedTab = tab === "library" ? "library" : "activity";
  for (const btn of sheet.querySelectorAll<HTMLElement>("[data-mobile-inspector-tab]")) {
    btn.classList.toggle("is-active", btn.dataset.mobileInspectorTab === resolvedTab);
  }
  for (const pane of sheet.querySelectorAll<HTMLElement>("[data-mobile-inspector-pane]")) {
    pane.hidden = pane.dataset.mobileInspectorPane !== resolvedTab;
  }
  openSheetAnimated(sheet);
}

export function closeMobileSettingsSheet() {
  closeSheetAnimated(el("mobile-settings-sheet"));
}

export function openMobileSettingsSheet() {
  const sheet = el("mobile-settings-sheet");
  if (!sheet) return;
  openSheetAnimated(sheet);
}

export function closeMobileNodeSwitcherSheet() {
  closeSheetAnimated(el("mobile-node-sheet"));
}

export function openMobileNodeSwitcherSheet() {
  openSheetAnimated(el("mobile-node-sheet"));
}

export function closeMobileBotEditor() {
  closeSheetAnimated(el("mobile-bot-editor-sheet"));
}

export function renderMobileBotAvatarSelectors({
  selectedShape = "blob",
  selectedColor = "red",
  onChange,
}: any = {}) {
  const preview = el("mobile-bot-preview-slot");
  const shapesGrid = el("mobile-bot-shapes-grid");
  const colorsGrid = el("mobile-bot-colors-grid");
  if (preview) {
    preview.replaceChildren(createMascotSvg(selectedShape, selectedColor));
  }
  if (shapesGrid) {
    shapesGrid.replaceChildren();
    for (const s of BOT_SHAPES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mobile-shape-btn${s.key === selectedShape ? " is-active" : ""}`;
      btn.setAttribute("aria-label", s.label);
      btn.appendChild(createMascotSvg(s.key, selectedColor));
      btn.addEventListener("click", () => {
        onChange?.({ shape: s.key, color: selectedColor });
      });
      shapesGrid.appendChild(btn);
    }
  }
  if (colorsGrid) {
    colorsGrid.replaceChildren();
    for (const c of BOT_COLORS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mobile-color-dot${c.key === selectedColor ? " is-active" : ""}`;
      btn.style.background = c.swatch;
      btn.setAttribute("aria-label", c.label);
      btn.addEventListener("click", () => {
        onChange?.({ shape: selectedShape, color: c.key });
      });
      colorsGrid.appendChild(btn);
    }
  }
}

export function attachMobileGestures() {
  if (typeof window === "undefined") return;
  const chatStage = document.querySelector(".chat-stage");
  const shell = el("app-shell");
  if (chatStage && shell) {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    chatStage.addEventListener(
      "touchstart",
      (e: any) => {
        if (!isMobileViewport() || shell.dataset.mobileView !== "chat") return;
        const touch = e.touches?.[0];
        if (!touch || touch.clientX > 36) return;
        startX = touch.clientX;
        startY = touch.clientY;
        tracking = true;
      },
      { passive: true }
    );
    chatStage.addEventListener(
      "touchend",
      (e: any) => {
        if (!tracking) return;
        tracking = false;
        const touch = e.changedTouches?.[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = Math.abs(touch.clientY - startY);
        if (dx > 72 && dy < 54) {
          setMobileView("list");
        }
      },
      { passive: true }
    );
  }

  for (const sheetId of ["mobile-inspector-sheet", "mobile-node-sheet"]) {
    const sheet = el(sheetId);
    const panel = sheet?.querySelector<HTMLElement>(".mobile-sheet-panel");
    const handle = sheet?.querySelector<HTMLElement>(".mobile-sheet-handle");
    if (!sheet || !panel || !handle) continue;
    let startY = 0;
    let dy = 0;
    handle.addEventListener(
      "touchstart",
      (e: any) => {
        startY = e.touches?.[0]?.clientY || 0;
        dy = 0;
      },
      { passive: true }
    );
    handle.addEventListener(
      "touchmove",
      (e: any) => {
        const curY = e.touches?.[0]?.clientY || 0;
        dy = Math.max(0, curY - startY);
        if (dy > 0) {
          panel.style.transform = `translateY(${dy}px)`;
          panel.style.transition = "none";
        }
      },
      { passive: true }
    );
    handle.addEventListener(
      "touchend",
      () => {
        panel.style.transition = "";
        panel.style.transform = "";
        if (dy > 80) closeSheetAnimated(sheet);
        dy = 0;
      },
      { passive: true }
    );
  }
}

export function initKeyboardViewportSync({ onKeyboardOpen }: any = {}) {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return;
  let prevHeight = vv.height;
  const resetWindowScroll = () => {
    if (!isMobileViewport()) return;
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
    if (document.documentElement.scrollTop !== 0) {
      document.documentElement.scrollTop = 0;
    }
    if (document.body.scrollTop !== 0) {
      document.body.scrollTop = 0;
    }
  };
  const syncHeight = () => {
    const shell = el("app-shell");
    if (!shell || !isMobileViewport()) {
      if (shell) {
        shell.style.height = "";
        shell.classList.remove("is-keyboard-open");
      }
      document.documentElement.style.removeProperty("--mobile-vv-height");
      prevHeight = vv.height;
      return;
    }
    const nextHeight = Math.round(vv.height);
    const shrank = nextHeight < prevHeight - 60;
    const offsetShifted = Math.abs(vv.offsetTop) > 1 || window.scrollY > 1;
    prevHeight = nextHeight;
    shell.style.height = `${nextHeight}px`;
    shell.classList.toggle("is-keyboard-open", nextHeight < window.innerHeight - 100);
    document.documentElement.style.setProperty("--mobile-vv-height", `${nextHeight}px`);
    resetWindowScroll();
    syncMobileChatBottomMetrics();
    if (shrank || offsetShifted) {
      requestAnimationFrame(() => {
        resetWindowScroll();
        onKeyboardOpen?.();
      });
      setTimeout(() => {
        resetWindowScroll();
        if (shrank) onKeyboardOpen?.();
      }, 60);
      setTimeout(() => {
        resetWindowScroll();
        if (shrank) onKeyboardOpen?.();
      }, 180);
    }
  };
  vv.addEventListener("resize", syncHeight);
  vv.addEventListener("scroll", syncHeight);
  window.addEventListener("resize", syncHeight);
  window.addEventListener("scroll", resetWindowScroll, { passive: true });
  document.addEventListener("focusin", () => {
    if (!isMobileViewport()) return;
    requestAnimationFrame(syncHeight);
    setTimeout(syncHeight, 80);
  });
  const blockPinchZoom = (e: Event) => {
    if (!isMobileViewport()) return;
    e.preventDefault();
  };
  document.addEventListener("gesturestart", blockPinchZoom, { passive: false });
  document.addEventListener("gesturechange", blockPinchZoom, { passive: false });
  syncHeight();
}
