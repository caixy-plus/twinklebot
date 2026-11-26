import { useEffect, type RefObject } from "react";
import { isMobileViewport, syncMobileChatBottomMetrics } from "../mobile-ui.js";
import { scrollChatStreamToBottom } from "../services/actions.js";
import { getState, runtimeRefs, setState, useStore } from "../state/store.js";

export function useChatScrollPin(
  eventStreamRef: RefObject<HTMLDivElement | null>,
  composerWrapRef: RefObject<HTMLDivElement | null>
) {
  const streamCount = useStore((s) => s.streamItems.length);
  const lastStreamItem = useStore((s) => s.streamItems[s.streamItems.length - 1]);
  const activeSessionId = useStore((s) => s.activeSessionId);

  useEffect(() => {
    const streamEl = eventStreamRef.current;
    if (!streamEl) return;

    let touchStartY: number | null = null;
    let userInteractingWithStream = false;
    let wheelInteractingUntil = 0;
    let programmaticScrollUntil = 0;

    const markProgrammaticScroll = (ms = 140) => {
      programmaticScrollUntil = Math.max(programmaticScrollUntil, Date.now() + ms);
    };

    const dismissMobileKeyboardIfFocused = () => {
      if (!isMobileViewport() || typeof document === "undefined") return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || typeof active.blur !== "function") return;
      const isComposerField =
        active.id === "message-input" ||
        Boolean(composerWrapRef.current && composerWrapRef.current.contains(active));
      if (isComposerField) {
        runtimeRefs.lastStreamKeyboardDismissAt = Date.now();
        active.blur();
      }
    };

    const clearScrollPinGuard = () => {
      userInteractingWithStream = true;
      programmaticScrollUntil = 0;
      if (getState().scrollPinGuardUntil !== 0) {
        setState({ scrollPinGuardUntil: 0 });
      }
    };

    const handleWheel = () => {
      wheelInteractingUntil = Date.now() + 250;
      programmaticScrollUntil = 0;
      if (getState().scrollPinGuardUntil !== 0) {
        setState({ scrollPinGuardUntil: 0 });
      }
    };

    const handleTouchStart = (ev: TouchEvent) => {
      clearScrollPinGuard();
      touchStartY = ev.touches?.[0]?.clientY ?? null;
    };

    const handleTouchMove = (ev: TouchEvent) => {
      if (touchStartY === null) return;
      const curY = ev.touches?.[0]?.clientY;
      if (typeof curY === "number" && Math.abs(curY - touchStartY) >= 12) {
        dismissMobileKeyboardIfFocused();
        touchStartY = null;
      }
    };

    const handleTouchEnd = () => {
      touchStartY = null;
      userInteractingWithStream = false;
    };

    const handlePointerUp = () => {
      userInteractingWithStream = false;
    };

    const handleComposerFocusIn = (ev: FocusEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.id === "message-input" ||
          Boolean(composerWrapRef.current && composerWrapRef.current.contains(target)))
      ) {
        userInteractingWithStream = false;
        wheelInteractingUntil = 0;
        touchStartY = null;
      }
    };

    const handleScroll = () => {
      const s = getState();
      if (s.scrollPinGuardUntil && Date.now() < s.scrollPinGuardUntil) {
        if (!s.autoScrollPinned) {
          setState({ autoScrollPinned: true });
        }
        return;
      }
      const hasActiveUserScroll =
        userInteractingWithStream || Date.now() < wheelInteractingUntil;
      if (!hasActiveUserScroll && Date.now() < programmaticScrollUntil) {
        return;
      }
      if (hasActiveUserScroll) {
        dismissMobileKeyboardIfFocused();
        userInteractingWithStream = false;
        wheelInteractingUntil = 0;
      }
      const distFromBottom =
        streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
      const nextPinned = distFromBottom < 64;
      if (s.autoScrollPinned !== nextPinned) {
        setState({ autoScrollPinned: nextPinned });
        if (!nextPinned && isMobileViewport()) {
          syncMobileChatBottomMetrics();
        }
      }
    };

    const handleCaptureLoad = () => {
      if (getState().autoScrollPinned) {
        markProgrammaticScroll(140);
        streamEl.scrollTop = streamEl.scrollHeight;
      }
    };

    streamEl.addEventListener("pointerdown", clearScrollPinGuard, { passive: true });
    streamEl.addEventListener("touchstart", handleTouchStart, { passive: true });
    streamEl.addEventListener("touchmove", handleTouchMove, { passive: true });
    streamEl.addEventListener("wheel", handleWheel, { passive: true });
    streamEl.addEventListener("scroll", handleScroll, { passive: true });
    streamEl.addEventListener("load", handleCaptureLoad, true);
    if (typeof window !== "undefined") {
      window.addEventListener("pointerup", handlePointerUp, { passive: true });
      window.addEventListener("pointercancel", handlePointerUp, { passive: true });
      window.addEventListener("touchend", handleTouchEnd, { passive: true });
      window.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    }
    if (typeof document !== "undefined") {
      document.addEventListener("focusin", handleComposerFocusIn, true);
    }

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => {
        syncMobileChatBottomMetrics();
        if (getState().autoScrollPinned) {
          markProgrammaticScroll(140);
          streamEl.scrollTop = streamEl.scrollHeight;
        }
      });
      observer.observe(streamEl);
      if (composerWrapRef.current) {
        observer.observe(composerWrapRef.current);
      }
    }

    return () => {
      streamEl.removeEventListener("pointerdown", clearScrollPinGuard);
      streamEl.removeEventListener("touchstart", handleTouchStart);
      streamEl.removeEventListener("touchmove", handleTouchMove);
      streamEl.removeEventListener("wheel", handleWheel);
      streamEl.removeEventListener("scroll", handleScroll);
      streamEl.removeEventListener("load", handleCaptureLoad, true);
      if (typeof window !== "undefined") {
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        window.removeEventListener("touchend", handleTouchEnd);
        window.removeEventListener("touchcancel", handleTouchEnd);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("focusin", handleComposerFocusIn, true);
      }
      observer?.disconnect();
    };
  }, [eventStreamRef, composerWrapRef]);

  useEffect(() => {
    if (getState().autoScrollPinned) {
      scrollChatStreamToBottom({ guardMs: 120 });
    }
  }, [activeSessionId, streamCount, lastStreamItem]);
}
