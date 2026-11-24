import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { isMobileViewport } from "../mobile-ui.js";

export interface AnimatedSheetOptions {
  /** Dismissal gesture axis: "y" for bottom sheets (drag down), "x" for fullscreen push pages (left-edge swipe back). */
  axis?: "y" | "x";
  /** Close transition duration in ms (matches --mobile-dur-page / --mobile-dur-sheet). */
  closeDurationMs?: number;
}

export function useAnimatedSheet(
  open: boolean,
  onClose: () => void,
  options?: AnimatedSheetOptions
) {
  const axis = options?.axis || "y";
  const closeDurationMs = options?.closeDurationMs ?? 300;
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "closing">(
    open ? "open" : "closed"
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });
  const dragDeltaRef = useRef<number>(0);

  useEffect(() => {
    if (open) {
      let raf1 = 0;
      let raf2 = 0;
      setPhase((prev) => (prev === "open" ? "open" : "opening"));
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setPhase("open");
        });
      });
      return () => {
        if (raf1) cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    if (!isMobileViewport()) {
      setPhase("closed");
      return;
    }
    setPhase((prev) => {
      if (prev === "closed") return "closed";
      return "closing";
    });
    const timer = setTimeout(() => {
      setPhase("closed");
    }, closeDurationMs);
    return () => clearTimeout(timer);
  }, [open, closeDurationMs]);

  const handleTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    const touch = e.touches?.[0];
    if (!touch) return;
    if (axis === "x") {
      if (touch.clientX > 36) {
        dragStartRef.current = { x: 0, y: 0, active: false };
        return;
      }
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.closest?.("pre, code, table, .msg-code-pre, .msg-table-scroll, input[type='range']")) {
        dragStartRef.current = { x: 0, y: 0, active: false };
        return;
      }
    }
    dragStartRef.current = { x: touch.clientX, y: touch.clientY, active: true };
    dragDeltaRef.current = 0;
  };

  const handleTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (!dragStartRef.current.active) return;
    const touch = e.touches?.[0];
    if (!touch) return;
    const panel = panelRef.current;
    if (axis === "x") {
      const dx = Math.max(0, touch.clientX - dragStartRef.current.x);
      const dy = Math.abs(touch.clientY - dragStartRef.current.y);
      if (dx === 0 || (dragDeltaRef.current === 0 && dy > dx * 1.15)) {
        if (dy > 16) dragStartRef.current.active = false;
        return;
      }
      dragDeltaRef.current = dx;
      if (panel && dx > 0) {
        panel.style.transform = `translateX(${dx}px)`;
        panel.style.transition = "none";
      }
      return;
    }
    const dy = Math.max(0, touch.clientY - dragStartRef.current.y);
    dragDeltaRef.current = dy;
    if (panel && dy > 0) {
      panel.style.transform = `translateY(${dy}px)`;
      panel.style.transition = "none";
    }
  };

  const handleTouchEnd = () => {
    if (!dragStartRef.current.active) return;
    dragStartRef.current.active = false;
    const panel = panelRef.current;
    if (panel) {
      panel.style.transition = "";
      panel.style.transform = "";
    }
    const threshold = axis === "x" ? 72 : 80;
    if (dragDeltaRef.current > threshold) {
      onClose();
    }
    dragDeltaRef.current = 0;
  };

  const hidden = phase === "closed";
  const stateClass =
    phase === "open"
      ? "is-open"
      : phase === "closing"
        ? "is-closing"
        : phase === "opening"
          ? "is-opening"
          : "";

  return {
    hidden,
    stateClass,
    panelRef,
    handleProps: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchEnd,
    },
  };
}
