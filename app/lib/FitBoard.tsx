"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Fit all content, not just its container. New rows resize the complete board. */
export function FitBoard({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 1440, scale: 1, left: 0, ready: false });
  useLayoutEffect(() => {
    const outer = viewport.current;
    const inner = board.current;
    if (!outer || !inner) return;
    const measure = () => {
      const width = Math.max(1440, outer.clientWidth);
      const totalWidth = Math.max(width, inner.scrollWidth);
      const scale = Math.min(1, outer.clientWidth / totalWidth, outer.clientHeight / Math.max(1, inner.scrollHeight));
      const left = Math.max(0, (outer.clientWidth - totalWidth * scale) / 2);
      setLayout(previous => previous.width === width && Math.abs(previous.scale - scale) < 0.00001 && Math.abs(previous.left - left) < 0.01 && previous.ready
        ? previous : { width, scale, left, ready: true });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    measure();
    return () => observer.disconnect();
  }, []);
  return <div ref={viewport} className="board-viewport">
    <div ref={board} className="fit-board" data-scale={layout.scale.toFixed(4)} style={{ width: layout.width, left: layout.left, transform: `scale(${layout.scale})`, visibility: layout.ready ? "visible" : "hidden" }}>
      {children}
    </div>
  </div>;
}
