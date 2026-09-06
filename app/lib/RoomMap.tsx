// RoomMap.tsx — the room, its nodes, and the posterior over where the source is.
//
// Canvas for the heatmap (a 48x32 grid is a lot of SVG rects), SVG on top for
// nodes, links and labels. Used by both the node view and the admin console, so
// what the operator sees is what a node sees (ARCHITECTURE.md §3.2).

"use client";

import { useEffect, useRef, useState } from "react";
import type { Estimate, Placed, Room } from "./fusion.ts";
import {
  MAX_LINK_DISTANCE_M,
  MIN_NODE_DISTANCE_M,
  type PlacementCandidate,
  type PlacementStatus,
} from "./scenario.ts";

export interface RoomMapProps {
  room: Room;
  positions: Map<string, Placed>;
  estimate: Estimate | null;
  /** Staging markers are real participants without assigned physical coordinates. */
  unplaced?: Set<string>;
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
  /** Hover preview while placing (Avery's PlacementPreview, room-scale). */
  placement?: { candidate: PlacementCandidate; status: PlacementStatus } | null;
  /** Simulated drone marker + detection halo. Visual hint only — never a record. */
  drone?: { x: number; y: number; radiusM: number; dest?: { x: number; y: number } | null } | null;
  /** BFS alert path to highlight, and the edge currently relaying. */
  alertPath?: string[] | null;
  alertEdge?: string | null;
  /** Impact blast circle for the simulated-outage demo. */
  impact?: { x: number; y: number; radiusM: number } | null;
  /** Map clicks in placement/drone/impact modes. Room metres. */
  onMapClick?: (x: number, y: number) => void;
  /** Hover position while placing. Room metres. */
  onMapHover?: (x: number, y: number) => void;
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
  /** Where the drag started, to tell a click from a drag. */
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  /** Set after a real drag so the trailing click does not double as a map click. */
  const suppressClick = useRef(false);
  /** Local preview while dragging, so the map tracks the finger at 60 Hz
   *  without publishing a replicated record per pointermove. */
  const [preview, setPreview] = useState<Placed | null>(null);

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
    // A diffuse posterior should *look* diffuse. At full strength an
    // unconstrained fix paints the whole room and reads as confidence, which is
    // the opposite of what it means.
    const alpha = estimate.localised ? 210 : 70;
    for (let i = 0; i < posterior.length; i++) {
      // Square-root stretch: the tail carries the shape of the uncertainty and a
      // linear ramp hides all of it.
      const t = peak > 0 ? Math.sqrt(posterior[i] / peak) : 0;
      img.data[i * 4 + 0] = Math.round(40 + 215 * t);
      img.data[i * 4 + 1] = Math.round(60 + 80 * t);
      img.data[i * 4 + 2] = Math.round(120 - 60 * t);
      img.data[i * 4 + 3] = Math.round(alpha * t);
    }
    // Draw at grid resolution, then let the browser scale it up smoothly.
    const off = document.createElement("canvas");
    off.width = nx;
    off.height = ny;
    off.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cv.width, cv.height);
  }, [estimate, w, h]);

  function pointFromEvent(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
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
      if (seen.has(k) || !positions.has(a) || !positions.has(b) || props.unplaced?.has(a) || props.unplaced?.has(b)) continue;
      seen.add(k);
      edges.push([a, b]);
    }
  }

  const now = Date.now();

  return (
    <div style={{ position: "relative", width: w, maxWidth: "100%", aspectRatio: `${w} / ${h}`, flex: "0 0 auto" }}>
      <canvas
        ref={canvasRef}
        width={w}
        height={h}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%", height: "100%",
          borderRadius: 8,
          background: "#0e1620",
          border: "1px solid var(--line)",
        }}
      />
      <svg
        ref={svgRef}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none" }}
        onPointerMove={(e) => {
          // Hover preview while placing needs pointer position even when no
          // drag is in flight.
          if (!dragging.current && props.onMapHover) {
            const pt = pointFromEvent(e);
            if (pt) props.onMapHover(pt.x, pt.y);
          }
          if (!dragging.current || !props.onMove) return;
          const pt = pointFromEvent(e);
          if (!pt) return;
          const from = dragFrom.current;
          if (from && Math.hypot(pt.x - from.x, pt.y - from.y) > 0.15) moved.current = true;
          // Preview only. Publishing here would put ~120 replicated records on
          // the wire for one drag.
          setPreview({ node: dragging.current, x: pt.x, y: pt.y });
        }}
        onPointerUp={() => {
          const node = dragging.current;
          const at = preview;
          dragging.current = null;
          dragFrom.current = null;
          if (node && moved.current && at && props.onMove) {
            // One record, on release.
            props.onMove(node, at.x, at.y);
            // A drag ending on background still fires click — swallow it so a
            // node move in drone/impact mode does not place a waypoint there.
            suppressClick.current = true;
          } else if (node && !moved.current) {
            // No movement: it was a click, so it means "pick", not "place".
            props.onPick?.(node);
          }
          moved.current = false;
          setPreview(null);
        }}
        onClick={(e) => {
          // Background clicks (not on a node) drive scenario modes: placing,
          // drone start/destination, impact. Node clicks arrive via onPick.
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if ((e.target as Element).closest("g")) return;
          if (!props.onMapClick) return;
          const pt = pointFromEvent(e);
          if (pt) props.onMapClick(pt.x, pt.y);
        }}
        onPointerLeave={() => {
          dragging.current = null;
          dragFrom.current = null;
          moved.current = false;
          setPreview(null);
        }}
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

        {estimate?.localised && (
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

        {/* alert path: highlight each hop, emphasise the edge now relaying */}
        {props.alertPath?.slice(0, -1).map((id, i) => {
          const next = props.alertPath![i + 1];
          const pa = positions.get(id);
          const pb = positions.get(next);
          // The command post (admin observer) has no position — skip that leg's
          // line but keep the hop count honest in the status text.
          if (!pa || !pb) return null;
          const [x1, y1] = toPx(pa.x, pa.y);
          const [x2, y2] = toPx(pb.x, pb.y);
          const active = props.alertEdge === `${id}->${next}`;
          return (
            <line
              key={`alert-${id}-${next}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={active ? "#ffd166" : "var(--warn)"}
              strokeWidth={active ? 4 : 2}
              strokeDasharray="6 4"
              opacity={active ? 1 : 0.45}
            />
          );
        })}

        {/* impact blast */}
        {props.impact && (
          <circle
            cx={toPx(props.impact.x, props.impact.y)[0]}
            cy={toPx(props.impact.x, props.impact.y)[1]}
            r={(props.impact.radiusM / room.w) * w}
            fill="#f07b62"
            fillOpacity={0.1}
            stroke="#f07b62"
            strokeWidth={2}
            strokeDasharray="7 8"
          />
        )}

        {/* placement preview: min-distance ring + links it would add */}
        {props.placement && (() => {
          const { candidate, status } = props.placement;
          const color = status === "valid" ? "var(--ok)" : status === "warning" ? "var(--warn)" : "var(--hot)";
          const [cx, cy] = toPx(candidate.x, candidate.y);
          return (
            <g style={{ pointerEvents: "none" }}>
              <circle
                cx={cx} cy={cy}
                r={(MIN_NODE_DISTANCE_M / room.w) * w}
                fill="none" stroke={color} strokeWidth={1} strokeDasharray="4 6" opacity={0.8}
              />
              <circle
                cx={cx} cy={cy} r={9}
                fill="none" stroke={color} strokeWidth={2} strokeDasharray="5 5" opacity={0.9}
              />
              {candidate.distances
                .filter(({ d }) => d <= MAX_LINK_DISTANCE_M * 1.35)
                .map(({ node, d }) => {
                  const p = positions.get(node);
                  if (!p) return null;
                  const [x2, y2] = toPx(p.x, p.y);
                  return (
                    <line
                      key={`place-${node}`}
                      x1={cx} y1={cy} x2={x2} y2={y2}
                      stroke={d <= MAX_LINK_DISTANCE_M ? color : "#65778a"}
                      strokeWidth={1} strokeDasharray="3 6" opacity={0.65}
                    />
                  );
                })}
            </g>
          );
        })()}

        {/* simulated drone: flight path, halo, marker. Never a record. */}
        {props.drone && (() => {
          const [dx, dy] = toPx(props.drone.x, props.drone.y);
          const dest = props.drone.dest;
          return (
            <g style={{ pointerEvents: "none" }}>
              {dest && (
                <line
                  x1={dx} y1={dy}
                  x2={toPx(dest.x, dest.y)[0]} y2={toPx(dest.x, dest.y)[1]}
                  stroke="var(--warn)" strokeWidth={2} strokeDasharray="8 8" opacity={0.85}
                />
              )}
              {dest && (
                <circle
                  cx={toPx(dest.x, dest.y)[0]} cy={toPx(dest.x, dest.y)[1]} r={7}
                  fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="4 4"
                />
              )}
              <circle
                cx={dx} cy={dy}
                r={(props.drone.radiusM / room.w) * w}
                fill="#f4c95d" fillOpacity={0.06}
                stroke="#f4c95d" strokeWidth={1} strokeDasharray="4 7"
              />
              <text x={dx} y={dy + 1} fontSize={18} textAnchor="middle" dominantBaseline="central">✦</text>
              <text x={dx} y={dy + 18} fill="var(--warn)" fontSize={10} textAnchor="middle">sim drone</text>
            </g>
          );
        })()}

        {[...positions.values()].map((placed) => {
          const p = preview && preview.node === placed.node ? preview : placed;
          const [cx, cy] = toPx(p.x, p.y);
          const level = levels?.get(p.node) ?? 0;
          const isSel = props.selected === p.node;
          return (
            <g
              key={p.node}
              data-node-id={p.node}
              data-placed={!props.unplaced?.has(p.node)}
              role={props.onPick ? "button" : undefined}
              aria-label={`Participant ${p.node}${props.unplaced?.has(p.node) ? ", unplaced" : ""}`}
              tabIndex={props.onPick ? 0 : undefined}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onPick?.(p.node); } }}
              style={{ cursor: props.onMove ? "grab" : "pointer" }}
              onPointerDown={(e) => {
                (e.target as Element).releasePointerCapture?.(e.pointerId);
                // Do NOT pick here. pointerdown used to both start a drag and
                // fire onPick, so dragging two nodes in sequence silently
                // toggled the topology edge between them. onPick now fires on
                // pointerup, and only when nothing moved.
                if (props.onMove) {
                  dragging.current = p.node;
                  dragFrom.current = { x: p.x, y: p.y };
                  moved.current = false;
                } else {
                  props.onPick?.(p.node);
                }
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
                strokeDasharray={props.unplaced?.has(p.node) ? "3 3" : undefined}
              />
              <text x={cx} y={cy + 22} fill="var(--dim)" fontSize={10} textAnchor="middle">
                {p.node}{props.unplaced?.has(p.node) ? " · unplaced" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
