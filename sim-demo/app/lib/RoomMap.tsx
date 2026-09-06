// RoomMap.tsx — the room, its nodes, and the posterior over where the source is.
//
// Canvas for the heatmap (a 48x32 grid is a lot of SVG rects), SVG on top for
// nodes, links and labels. Used by both the node view and the admin console, so
// what the operator sees is what a node sees (ARCHITECTURE.md §3.2).

"use client";

import { useEffect, useRef } from "react";
import type { Estimate, Placed, Room } from "./fusion.ts";

export interface RoomMapProps {
  room: Room;
  positions: Map<string, Placed>;
  estimate: Estimate | null;
  /** node → neighbours, drawn as edges. */
  topology?: Record<string, string[]>;
  /** Links the admin has cut, drawn dashed. */
  downLinks?: Set<string>;
  /** Nodes that reported recently, and how loudly. */
  levels?: Map<string, number>;
  selected?: string | null;
  onPick?: (node: string) => void;
  onMove?: (node: string, x: number, y: number) => void;
  /** Active hops, for the ripple animation. */
  ripples?: { from: string; to: string; at: number }[];
  width?: number;
}

const PX_PER_M = 56;

export function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function RoomMap(props: RoomMapProps) {
  const { room, positions, estimate, topology = {}, downLinks, levels } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<string | null>(null);

  const w = props.width ?? room.w * PX_PER_M;
  const h = (w / room.w) * room.h;
  const toPx = (x: number, y: number) => [(x / room.w) * w, (y / room.h) * h] as const;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!estimate) return;

    const { nx, ny, posterior } = estimate;
    const img = ctx.createImageData(nx, ny);
    let peak = 0;
    for (const v of posterior) if (v > peak) peak = v;
    for (let i = 0; i < posterior.length; i++) {
      // Square-root stretch: the tail carries the shape of the uncertainty and a
      // linear ramp hides all of it.
      const t = peak > 0 ? Math.sqrt(posterior[i] / peak) : 0;
      img.data[i * 4 + 0] = Math.round(40 + 215 * t);
      img.data[i * 4 + 1] = Math.round(60 + 80 * t);
      img.data[i * 4 + 2] = Math.round(120 - 60 * t);
      img.data[i * 4 + 3] = Math.round(210 * t);
    }
    // Draw at grid resolution, then let the browser scale it up smoothly.
    const off = document.createElement("canvas");
    off.width = nx;
    off.height = ny;
    off.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cv.width, cv.height);
  }, [estimate, w, h]);

  function pointFromEvent(e: React.PointerEvent): { x: number; y: number } | null {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.max(0, Math.min(room.w, ((e.clientX - rect.left) / rect.width) * room.w)),
      y: Math.max(0, Math.min(room.h, ((e.clientY - rect.top) / rect.height) * room.h)),
    };
  }

  const edges: [string, string][] = [];
  const seen = new Set<string>();
  for (const [a, ns] of Object.entries(topology)) {
    for (const b of ns) {
      const k = linkKey(a, b);
      if (seen.has(k) || !positions.has(a) || !positions.has(b)) continue;
      seen.add(k);
      edges.push([a, b]);
    }
  }

  const now = Date.now();

  return (
    <div style={{ position: "relative", width: w, height: h, flex: "0 0 auto" }}>
      <canvas
        ref={canvasRef}
        width={w}
        height={h}
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 8,
          background: "#0e1620",
          border: "1px solid var(--line)",
        }}
      />
      <svg
        ref={svgRef}
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, touchAction: "none" }}
        onPointerMove={(e) => {
          if (!dragging.current || !props.onMove) return;
          const pt = pointFromEvent(e);
          if (pt) props.onMove(dragging.current, pt.x, pt.y);
        }}
        onPointerUp={() => (dragging.current = null)}
        onPointerLeave={() => (dragging.current = null)}
      >
        {/* one-metre grid */}
        {Array.from({ length: Math.floor(room.w) + 1 }, (_, i) => (
          <line key={`v${i}`} x1={toPx(i, 0)[0]} y1={0} x2={toPx(i, 0)[0]} y2={h} stroke="#1b2735" />
        ))}
        {Array.from({ length: Math.floor(room.h) + 1 }, (_, i) => (
          <line key={`hh${i}`} x1={0} y1={toPx(0, i)[1]} x2={w} y2={toPx(0, i)[1]} stroke="#1b2735" />
        ))}

        {edges.map(([a, b]) => {
          const [x1, y1] = toPx(positions.get(a)!.x, positions.get(a)!.y);
          const [x2, y2] = toPx(positions.get(b)!.x, positions.get(b)!.y);
          const down = downLinks?.has(linkKey(a, b));
          return (
            <line
              key={linkKey(a, b)}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={down ? "#5a2b2b" : "#2f4763"}
              strokeWidth={down ? 1 : 2}
              strokeDasharray={down ? "5 5" : undefined}
            />
          );
        })}

        {/* ripple: a record in flight along a hop */}
        {props.ripples?.map((r, i) => {
          const pa = positions.get(r.from);
          const pb = positions.get(r.to);
          if (!pa || !pb) return null;
          const age = (now - r.at) / 600;
          if (age > 1) return null;
          const [x1, y1] = toPx(pa.x, pa.y);
          const [x2, y2] = toPx(pb.x, pb.y);
          return (
            <circle
              key={`${r.from}-${r.to}-${r.at}-${i}`}
              cx={x1 + (x2 - x1) * age}
              cy={y1 + (y2 - y1) * age}
              r={4}
              fill="var(--ok)"
              opacity={1 - age}
            />
          );
        })}

        {estimate && (
          <>
            <circle
              cx={toPx(estimate.x, estimate.y)[0]}
              cy={toPx(estimate.x, estimate.y)[1]}
              r={(estimate.spreadM / room.w) * w}
              fill="none"
              stroke="var(--hot)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              opacity={0.8}
            />
            <circle
              cx={toPx(estimate.x, estimate.y)[0]}
              cy={toPx(estimate.x, estimate.y)[1]}
              r={5}
              fill="var(--hot)"
            />
          </>
        )}

        {[...positions.values()].map((p) => {
          const [cx, cy] = toPx(p.x, p.y);
          const level = levels?.get(p.node) ?? 0;
          const isSel = props.selected === p.node;
          return (
            <g
              key={p.node}
              style={{ cursor: props.onMove ? "grab" : "pointer" }}
              onPointerDown={(e) => {
                (e.target as Element).releasePointerCapture?.(e.pointerId);
                if (props.onMove) dragging.current = p.node;
                props.onPick?.(p.node);
              }}
            >
              {level > 0.02 && (
                <circle cx={cx} cy={cy} r={10 + level * 26} fill="var(--accent)" opacity={0.12 + level * 0.3} />
              )}
              <circle
                cx={cx} cy={cy} r={8}
                fill={isSel ? "var(--accent)" : "#12202f"}
                stroke={isSel ? "#fff" : "var(--accent)"}
                strokeWidth={2}
              />
              <text x={cx} y={cy + 22} fill="var(--dim)" fontSize={10} textAnchor="middle">
                {p.node}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
