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

    const clearScrollPinGuard = () => {
      if (getState().scrollPinGuardUntil !== 0) {
        setState({ scrollPinGuardUntil: 0 });
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

    streamEl.addEventListener("touchstart", clearScrollPinGuard, { passive: true });
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
      streamEl.removeEventListener("touchstart", clearScrollPinGuard);
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
