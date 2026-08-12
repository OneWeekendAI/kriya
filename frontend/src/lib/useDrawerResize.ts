import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "kriya_drawer_width";
export const DEFAULT_DRAWER_WIDTH = 620;
export const MIN_DRAWER_WIDTH = 400;
export const WIDE_DRAWER_WIDTH = 900;
export const MAX_DRAWER_WIDTH = 1400;

export function useDrawerResize(inline: boolean = false) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined" || inline) return DEFAULT_DRAWER_WIDTH;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= MIN_DRAWER_WIDTH && parsed <= 2400) {
          return Math.min(parsed, Math.floor(window.innerWidth * 0.94));
        }
      }
    } catch {
      // ignore localStorage errors (e.g. private browsing)
    }
    return Math.min(DEFAULT_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
  });

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  const setAndSaveWidth = useCallback((newWidth: number) => {
    const maxW = Math.min(MAX_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
    const clamped = Math.max(MIN_DRAWER_WIDTH, Math.min(newWidth, maxW));
    setWidth(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // ignore
    }
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (inline) return;
      e.preventDefault();
      e.stopPropagation();
      isDraggingRef.current = true;
      setIsDragging(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return;
        const newWidth = window.innerWidth - moveEvent.clientX;
        const maxW = Math.min(MAX_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
        const clamped = Math.max(MIN_DRAWER_WIDTH, Math.min(newWidth, maxW));
        setWidth(clamped);
      };

      const onMouseUp = (upEvent: MouseEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        setIsDragging(false);

        const finalWidth = window.innerWidth - upEvent.clientX;
        const maxW = Math.min(MAX_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
        const clamped = Math.max(MIN_DRAWER_WIDTH, Math.min(finalWidth, maxW));
        try {
          localStorage.setItem(STORAGE_KEY, String(clamped));
        } catch {
          // ignore
        }

        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [inline]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (inline) return;
      const touch = e.touches[0];
      if (!touch) return;
      isDraggingRef.current = true;
      setIsDragging(true);

      const onTouchMove = (moveEvent: TouchEvent) => {
        if (!isDraggingRef.current) return;
        const t = moveEvent.touches[0];
        if (!t) return;
        const newWidth = window.innerWidth - t.clientX;
        const maxW = Math.min(MAX_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
        const clamped = Math.max(MIN_DRAWER_WIDTH, Math.min(newWidth, maxW));
        setWidth(clamped);
      };

      const onTouchEnd = (endEvent: TouchEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        setIsDragging(false);
        const t = endEvent.changedTouches[0];
        if (t) {
          const finalWidth = window.innerWidth - t.clientX;
          const maxW = Math.min(MAX_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
          const clamped = Math.max(MIN_DRAWER_WIDTH, Math.min(finalWidth, maxW));
          try {
            localStorage.setItem(STORAGE_KEY, String(clamped));
          } catch {
            // ignore
          }
        }
        window.removeEventListener("touchmove", onTouchMove);
        window.removeEventListener("touchend", onTouchEnd);
      };

      window.addEventListener("touchmove", onTouchMove, { passive: true });
      window.addEventListener("touchend", onTouchEnd);
    },
    [inline]
  );

  const toggleSize = useCallback(() => {
    const maxW = Math.min(MAX_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
    if (width < 720) {
      setAndSaveWidth(Math.min(WIDE_DRAWER_WIDTH, maxW));
    } else if (width < 1100 && maxW > 1000) {
      setAndSaveWidth(maxW);
    } else {
      setAndSaveWidth(DEFAULT_DRAWER_WIDTH);
    }
  }, [width, setAndSaveWidth]);

  const resetDefault = useCallback(() => {
    setAndSaveWidth(DEFAULT_DRAWER_WIDTH);
  }, [setAndSaveWidth]);

  // Adjust on window resize if current width exceeds window bounds
  useEffect(() => {
    if (inline) return;
    const onResize = () => {
      const maxW = Math.min(MAX_DRAWER_WIDTH, Math.floor(window.innerWidth * 0.94));
      setWidth((prev) => (prev > maxW ? maxW : prev));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [inline]);

  return {
    width: inline ? undefined : width,
    isDragging,
    isExpanded: !inline && width >= 800,
    handleMouseDown,
    handleTouchStart,
    toggleSize,
    resetDefault,
    setWidth: setAndSaveWidth,
  };
}
