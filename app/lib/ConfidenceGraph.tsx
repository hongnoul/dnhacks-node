// ConfidenceGraph.tsx — CRNN confidence over time.
//
// Mirrors SkyMesh's node-page graph (same 60 s window, same 0.5 threshold, same
// green-below/red-above treatment) so a node reads the same in either app.
//
// The point of interest: on the operator console this is drawn from *replicated
// records*, not from a live feed. Every point is a reading that gossiped across
// the mesh to get here, so the graph is simultaneously the detection picture and
// evidence that replication is working.

"use client";

import { useEffect, useRef } from "react";
import { drawBottomGraph } from "./bottomGraph.ts";
import {
  DETECT_THRESHOLD,
  GRAPH_WINDOW_MS,
  GREEN as DEFAULT_GREEN, GRID as DEFAULT_GRID, MUTED as DEFAULT_MUTED,
  RED as DEFAULT_RED, RED_FILL as DEFAULT_RED_FILL,
} from "./detection.ts";

export interface Point {
  t: number;
  p: number;
  /** Latched verdict at that tick — marginal trips sit below the line but count. */
  d?: boolean;
}

export function ConfidenceGraph({
  history,
  width,
  height = 90,
  compact = false,
  monochrome = false,
  terminal = false,
  now,
}: {
  history: Point[];
  width: number;
  height?: number;
  compact?: boolean;
  monochrome?: boolean;
  terminal?: boolean;
  now: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const GREEN = monochrome ? "#eeeeee" : DEFAULT_GREEN;
    const RED = monochrome ? "#ffffff" : DEFAULT_RED;
    const RED_FILL = monochrome ? "rgba(255,255,255,0.14)" : DEFAULT_RED_FILL;
    const GRID = monochrome ? "#444444" : DEFAULT_GRID;
    const MUTED = monochrome ? "#aaaaaa" : DEFAULT_MUTED;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (terminal) {
      drawBottomGraph(ctx, history, now, width, height);
      return;
    }

    const padL = compact ? 2 : 26;
    const padR = 4;
    const padT = 6;
    const padB = compact ? 4 : 14;
    const iw = width - padL - padR;
    const ih = height - padT - padB;
    const t0 = now - GRAPH_WINDOW_MS;
    const x = (t: number) => padL + ((t - t0) / GRAPH_WINDOW_MS) * iw;
    const y = (p: number) => padT + (1 - Math.min(1, Math.max(0, p))) * ih;

    ctx.font = monochrome ? "10px 'Courier New', monospace" : "10px ui-monospace, monospace";
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (const g of compact ? [1] : [0, 0.5, 1]) {
      ctx.beginPath();
      ctx.moveTo(padL, y(g));
      ctx.lineTo(width - padR, y(g));
      ctx.stroke();
      if (!compact) {
        ctx.fillStyle = MUTED;
        ctx.fillText(String(Math.round(g * 100)), 2, y(g) + 3);
      }
    }

    // Threshold line — the same 0.5 SkyMesh calls a detection.
    ctx.save();
    ctx.strokeStyle = MUTED;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(DETECT_THRESHOLD));
    ctx.lineTo(width - padR, y(DETECT_THRESHOLD));
    ctx.stroke();
    ctx.restore();

    const vis = history.filter((pt) => pt.t >= t0 - 2000);
    if (vis.length === 0) {
      if (!compact) {
        ctx.fillStyle = MUTED;
        ctx.fillText("no readings yet", padL + 6, padT + ih / 2);
      }
      return;
    }

    // Shade the area above threshold.
    ctx.beginPath();
    let filling = false;
    for (const pt of vis) {
      const px = Math.max(padL, x(pt.t));
      if (pt.d ?? pt.p >= DETECT_THRESHOLD) {
        if (!filling) {
          ctx.moveTo(px, y(DETECT_THRESHOLD));
          filling = true;
        }
        ctx.lineTo(px, y(pt.p));
      } else if (filling) {
        ctx.lineTo(px, y(DETECT_THRESHOLD));
        ctx.closePath();
        filling = false;
      }
    }
    if (filling) {
      ctx.lineTo(Math.max(padL, x(vis[vis.length - 1].t)), y(DETECT_THRESHOLD));
      ctx.closePath();
    }
    ctx.fillStyle = RED_FILL;
    ctx.fill();

    ctx.lineWidth = monochrome ? 1 : compact ? 1.5 : 2.5;
    ctx.lineJoin = monochrome ? "miter" : "round";
    ctx.lineCap = monochrome ? "butt" : "round";
    for (let i = 1; i < vis.length; i++) {
      const a = vis[i - 1];
      const b = vis[i];
      const hot = (b.d ?? b.p >= DETECT_THRESHOLD) || (a.d ?? a.p >= DETECT_THRESHOLD);
      ctx.strokeStyle = hot ? RED : GREEN;
      ctx.beginPath();
      ctx.moveTo(Math.max(padL, x(a.t)), y(a.p));
      ctx.lineTo(Math.max(padL, x(b.t)), y(b.p));
      ctx.stroke();
    }

    const last = vis[vis.length - 1];
    if (now - last.t < GRAPH_WINDOW_MS) {
      ctx.fillStyle = (last.d ?? last.p >= DETECT_THRESHOLD) ? RED : GREEN;
      const px = Math.max(padL, x(last.t));
      const py = y(last.p);
      if (monochrome) {
        // A square cursor keeps the terminal instrument free of rounded UI marks.
        const size = compact ? 4 : 6;
        ctx.fillRect(Math.round(px - size / 2), Math.round(py - size / 2), size, size);
      } else {
        ctx.beginPath();
        ctx.arc(px, py, compact ? 2.5 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (!compact) {
      ctx.fillStyle = MUTED;
      ctx.fillText("-60s", padL, height - 3);
      ctx.fillText("now", width - padR - 22, height - 3);
    }
  }, [history, width, height, compact, now, monochrome, terminal]);

  return <canvas ref={ref} aria-label="Drone confidence over the last 60 seconds" role="img" style={{ width, maxWidth: "100%", height: "auto", aspectRatio: `${width} / ${height}`, display: "block" }} />;
}
