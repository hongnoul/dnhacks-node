"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type MouseEvent } from "react";

/** Presentation-only dragging. Capture the pointer without starting HTML drag/drop. */
export function useDesktopDrag<T extends HTMLElement>(windowHandle = false) {
  const ref = useRef<T>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const gesture = useRef<{ id: number; x: number; y: number; left: number; top: number; width: number; height: number; ox: number; oy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    const reset = () => setOffset({ x: 0, y: 0 });
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);
  const handlers = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || !event.isPrimary || !ref.current) return;
      if (windowHandle && (event.target as HTMLElement).closest("button, a, input")) return;
      const box = ref.current.getBoundingClientRect();
      suppressClick.current = false;
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.left, top: box.top, width: box.width, height: box.height, ox: offset.x, oy: offset.y, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = gesture.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 5) return;
      start.moved = true;
      const maxX = Math.max(0, window.innerWidth - start.width);
      const maxY = Math.max(0, window.innerHeight - (windowHandle ? 48 : start.height));
      const left = Math.max(0, Math.min(maxX, start.left + dx));
      const top = Math.max(0, Math.min(maxY, start.top + dy));
      setOffset({ x: start.ox + left - start.left, y: start.oy + top - start.top });
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (gesture.current?.id !== event.pointerId) return;
      suppressClick.current = gesture.current.moved;
      gesture.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel() { gesture.current = null; suppressClick.current = true; },
    onLostPointerCapture() { gesture.current = null; },
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
      suppressClick.current = false;
    },
    onDragStart(event: React.DragEvent<HTMLElement>) { event.preventDefault(); },
  };
  return { ref, handlers, reset: () => setOffset({ x: 0, y: 0 }), style: { translate: `${offset.x}px ${offset.y}px` } as CSSProperties };
}
