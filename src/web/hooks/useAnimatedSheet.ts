import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";

export function useAnimatedSheet(open: boolean, onClose: () => void) {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">(open ? "open" : "closed");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragStartYRef = useRef<number>(0);
  const dragDyRef = useRef<number>(0);

  useEffect(() => {
    if (open) {
      setPhase("open");
      return;
    }
    setPhase((prev) => {
      if (prev === "closed") return "closed";
      return "closing";
    });
    const timer = setTimeout(() => {
      setPhase("closed");
    }, 220);
    return () => clearTimeout(timer);
  }, [open]);

  const handleTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    dragStartYRef.current = e.touches?.[0]?.clientY || 0;
    dragDyRef.current = 0;
  };

  const handleTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const curY = e.touches?.[0]?.clientY || 0;
    const dy = Math.max(0, curY - dragStartYRef.current);
    dragDyRef.current = dy;
    const panel = panelRef.current;
    if (panel && dy > 0) {
      panel.style.transform = `translateY(${dy}px)`;
      panel.style.transition = "none";
    }
  };

  const handleTouchEnd = () => {
    const panel = panelRef.current;
    if (panel) {
      panel.style.transition = "";
      panel.style.transform = "";
    }
    if (dragDyRef.current > 80) {
      onClose();
    }
    dragDyRef.current = 0;
  };

  const hidden = phase === "closed";
  const stateClass =
    phase === "open" ? "is-open" : phase === "closing" ? "is-closing" : "";

  return {
    hidden,
    stateClass,
    panelRef,
    handleProps: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
