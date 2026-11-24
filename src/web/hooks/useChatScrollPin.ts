import { useEffect, type RefObject } from "react";
import { isMobileViewport, syncMobileChatBottomMetrics } from "../mobile-ui.js";
import { scrollChatStreamToBottom } from "../services/actions.js";
import { getState, setState, useStore } from "../state/store.js";

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

    const dismissMobileKeyboardIfFocused = () => {
      if (!isMobileViewport() || typeof document === "undefined") return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || typeof active.blur !== "function") return;
      const isComposerField =
        active.id === "message-input" ||
        Boolean(composerWrapRef.current && composerWrapRef.current.contains(active));
      if (isComposerField) {
        active.blur();
      }
    };

    const clearScrollPinGuard = () => {
      userInteractingWithStream = true;
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

    const handleScroll = () => {
      const s = getState();
      if (s.scrollPinGuardUntil && Date.now() < s.scrollPinGuardUntil) {
        if (!s.autoScrollPinned) {
          setState({ autoScrollPinned: true });
        }
        return;
      }
      if (userInteractingWithStream) {
        dismissMobileKeyboardIfFocused();
        userInteractingWithStream = false;
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
        streamEl.scrollTop = streamEl.scrollHeight;
      }
    };

    streamEl.addEventListener("pointerdown", clearScrollPinGuard, { passive: true });
    streamEl.addEventListener("pointerup", handlePointerUp, { passive: true });
    streamEl.addEventListener("pointercancel", handlePointerUp, { passive: true });
    streamEl.addEventListener("touchstart", handleTouchStart, { passive: true });
    streamEl.addEventListener("touchmove", handleTouchMove, { passive: true });
    streamEl.addEventListener("touchend", handleTouchEnd, { passive: true });
    streamEl.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    streamEl.addEventListener("wheel", clearScrollPinGuard, { passive: true });
    streamEl.addEventListener("scroll", handleScroll, { passive: true });
    streamEl.addEventListener("load", handleCaptureLoad, true);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => {
        syncMobileChatBottomMetrics();
        if (getState().autoScrollPinned) {
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
      streamEl.removeEventListener("pointerup", handlePointerUp);
      streamEl.removeEventListener("pointercancel", handlePointerUp);
      streamEl.removeEventListener("touchstart", handleTouchStart);
      streamEl.removeEventListener("touchmove", handleTouchMove);
      streamEl.removeEventListener("touchend", handleTouchEnd);
      streamEl.removeEventListener("touchcancel", handleTouchEnd);
      streamEl.removeEventListener("wheel", clearScrollPinGuard);
      streamEl.removeEventListener("scroll", handleScroll);
      streamEl.removeEventListener("load", handleCaptureLoad, true);
      observer?.disconnect();
    };
  }, [eventStreamRef, composerWrapRef]);

  useEffect(() => {
    if (getState().autoScrollPinned) {
      scrollChatStreamToBottom({ guardMs: 120 });
    }
  }, [activeSessionId, streamCount, lastStreamItem]);
}
