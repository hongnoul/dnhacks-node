"use client";

// SkyMesh sensor node — fully self-contained drone detection.
// The phone IS the node: mic → mel-spectrogram → on-device CRNN → confidence.
// No server, no location, no network after first load. Airplane mode works.

import { useCallback, useEffect, useRef, useState } from "react";
import { MicCapture } from "./lib/audio";
import { DroneDetector } from "./lib/detector";

const SCORE_INTERVAL_MS = 250;
const DETECT_THRESHOLD = 0.5;
// Release below the trip point so a flickering 0.45/0.55 signal holds the
// DETECTED pill instead of chattering. Lower = stickier (more sensitive).
const RELEASE_THRESHOLD = 0.35;
// Display smoothing: raw CRNN output jumps hard (0.02 → 1.0 between 1 s
// windows). EMA alpha 0.6 keeps attack fast (~1 tick to cross 0.5 on a
// step) while damping single-window flicker. Detection itself uses the raw
// score so smoothing never delays the pill.
const DISPLAY_ALPHA = 0.6;
// Max-hold: keep the displayed peak for this long so a brief 1.0 spike
// (one 1 s window sliding past the drone) stays visible across ticks.
const PEAK_HOLD_MS = 1500;

// Graph: show the last 60 s, keep the whole session (4 Hz → 14400 pts/hour).
const WINDOW_MS = 60_000;
const MAX_POINTS = 28_800; // ~2 h cap at 4 Hz to bound memory

type Phase = "idle" | "loading" | "starting" | "listening" | "error";
type Point = { t: number; p: number };

function randomNodeId(): string {
  return Math.random().toString(36).slice(2, 8);
}

const GREEN = "#16a34a";
const RED = "#dc2626";
const RED_FILL = "rgba(220,38,38,0.12)";
const GRID = "#e5e7eb";
const MUTED = "#6b7280";

function drawGraph(canvas: HTMLCanvasElement, history: Point[], now: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 30;
  const padR = 8;
  const padT = 14;
  const padB = 18;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const t0 = now - WINDOW_MS;
  const x = (t: number) => padL + ((t - t0) / WINDOW_MS) * iw;
  const y = (p: number) => padT + (1 - Math.min(1, Math.max(0, p))) * ih;

  // Gridlines at 0 / 50 / 100
  ctx.font = "10px -apple-system, sans-serif";
  ctx.fillStyle = MUTED;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (const g of [0, 0.5, 1]) {
    ctx.beginPath();
    ctx.moveTo(padL, y(g));
    ctx.lineTo(w - padR, y(g));
    ctx.stroke();
    ctx.fillText(`${Math.round(g * 100)}`, 4, y(g) + 3);
  }

  // X labels
  ctx.fillText("-60s", padL, h - 5);
  const midLabel = "-30s";
  ctx.fillText(midLabel, padL + iw / 2 - ctx.measureText(midLabel).width / 2, h - 5);
  ctx.fillText("now", w - padR - ctx.measureText("now").width, h - 5);

  // Threshold line (dashed) + label
  ctx.save();
  ctx.strokeStyle = MUTED;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, y(DETECT_THRESHOLD));
  ctx.lineTo(w - padR, y(DETECT_THRESHOLD));
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = MUTED;
  const tLabel = "threshold 50%";
  ctx.fillText(tLabel, w - padR - ctx.measureText(tLabel).width, y(DETECT_THRESHOLD) - 4);

  // Visible points (+ one before the window so the line enters from the edge)
  const vis: Point[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t >= t0) vis.push(history[i]);
    else {
      vis.push(history[i]);
      break;
    }
  }
  vis.reverse();
  if (vis.length === 0) {
    // Empty state: hint so the axes + threshold read as "ready", not broken
    ctx.fillStyle = MUTED;
    ctx.font = "13px -apple-system, sans-serif";
    const hint = "press Start — live confidence appears here";
    ctx.fillText(hint, padL + (iw - ctx.measureText(hint).width) / 2, padT + ih / 2);
    return;
  }

  // Red fill wherever the line is above threshold
  ctx.beginPath();
  let filling = false;
  for (let i = 0; i < vis.length; i++) {
    const px = Math.max(padL, x(vis[i].t));
    const py = y(vis[i].p);
    if (vis[i].p >= DETECT_THRESHOLD) {
      if (!filling) {
        ctx.moveTo(px, y(DETECT_THRESHOLD));
        ctx.lineTo(px, py);
        filling = true;
      } else {
        ctx.lineTo(px, py);
      }
    } else if (filling) {
      ctx.lineTo(px, y(DETECT_THRESHOLD));
      ctx.closePath();
      filling = false;
    }
  }
  if (filling) {
    const lastX = Math.max(padL, x(vis[vis.length - 1].t));
    ctx.lineTo(lastX, y(DETECT_THRESHOLD));
    ctx.closePath();
  }
  ctx.fillStyle = RED_FILL;
  ctx.fill();

  // Confidence polyline, colored per segment (green below, red above)
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 1; i < vis.length; i++) {
    const a = vis[i - 1];
    const b = vis[i];
    ctx.strokeStyle = (b.p >= DETECT_THRESHOLD || a.p >= DETECT_THRESHOLD) ? RED : GREEN;
    ctx.beginPath();
    ctx.moveTo(Math.max(padL, x(a.t)), y(a.p));
    ctx.lineTo(Math.max(padL, x(b.t)), y(b.p));
    ctx.stroke();
  }

  // Red ticks along the top edge for each rising-edge crossing in view
  ctx.fillStyle = RED;
  for (let i = 1; i < vis.length; i++) {
    if (vis[i - 1].p < DETECT_THRESHOLD && vis[i].p >= DETECT_THRESHOLD) {
      const px = Math.max(padL, x(vis[i].t));
      ctx.fillRect(px - 1, 0, 2, 6);
    }
  }

  // Head dot at the newest point
  const last = vis[vis.length - 1];
  if (now - last.t < WINDOW_MS) {
    ctx.beginPath();
    ctx.arc(Math.max(padL, x(last.t)), y(last.p), 4, 0, Math.PI * 2);
    ctx.fillStyle = last.p >= DETECT_THRESHOLD ? RED : GREEN;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

export default function NodePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>("");
  const [conf, setConf] = useState<number | null>(null);
  const [history, setHistory] = useState<Point[]>([]);
  const [detections, setDetections] = useState<number>(0);
  const [lastDetectAt, setLastDetectAt] = useState<string>("never");
  const [nodeId, setNodeId] = useState<string>("");

  // nodeId is random — assign client-side only to avoid SSR hydration mismatch
  useEffect(() => setNodeId(randomNodeId()), []);

  const micRef = useRef<MicCapture | null>(null);
  const detectorRef = useRef<DroneDetector | null>(null);
  const scoringRef = useRef(false); // skip ticks while an inference is in flight
  const wasDetectingRef = useRef(false);
  const smoothRef = useRef<number | null>(null); // EMA of raw scores for display
  const peakRef = useRef<{ p: number; t: number } | null>(null); // max-hold peak
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<Point[]>([]);
  historyRef.current = history;
  const [nowTick, setNowTick] = useState<number>(Date.now());

  const start = useCallback(async () => {
    setErr("");
    try {
      // 1. Model first (needs network on first visit; cached after)
      if (!detectorRef.current?.ready) {
        setPhase("loading");
        const d = new DroneDetector();
        await d.load();
        detectorRef.current = d;
      }

      // 2. Mic (must stay within the tap's call stack for iOS)
      setPhase("starting");
      const mic = new MicCapture();
      await mic.start();
      micRef.current = mic;

      // Screen wake lock (iOS 16.4+); non-fatal if unavailable
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wakeLockRef.current = await (navigator as any).wakeLock?.request("screen");
      } catch {
        /* ignore */
      }

      setHistory([]);
      wasDetectingRef.current = false;
      smoothRef.current = null;
      peakRef.current = null;
      setPhase("listening");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, []);

  // CRNN scoring at 4 Hz — all on this phone. Each tick scores the last 1 s
  // of audio, so windows overlap 75%: a drone entering mid-window still gets
  // a full look within ~250 ms. Detection uses the raw score (never delayed
  // by smoothing); the graph shows EMA + max-hold so spikes stay visible.
  useEffect(() => {
    if (phase !== "listening") return;

    const scorer = setInterval(() => {
      const mic = micRef.current;
      const det = detectorRef.current;
      if (!mic || !det?.ready || scoringRef.current) return;
      const samples = mic.samples(1.0);
      if (!samples) return;
      scoringRef.current = true;
      det
        .score(samples, mic.sampleRate)
        .then((raw) => {
          const t = Date.now();
          // Display: fast-attack EMA + peak hold. Detection: raw + hysteresis.
          const prev = smoothRef.current;
          const smooth = prev == null ? raw : prev + DISPLAY_ALPHA * (raw - prev);
          smoothRef.current = smooth;
          const held = peakRef.current;
          const display =
            held && t - held.t < PEAK_HOLD_MS ? Math.max(smooth, held.p) : smooth;
          if (!held || smooth >= held.p || t - held.t >= PEAK_HOLD_MS) {
            peakRef.current = { p: smooth, t };
          }
          const p = display;
          setConf(p);
          setHistory((prevHist) => {
            const next = [...prevHist, { t, p }];
            return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
          });
          // Hysteresis: trip at 0.5, hold until below 0.35 — a flickering
          // 0.45/0.55 signal stays DETECTED instead of chattering.
          const was = wasDetectingRef.current;
          const detecting = was ? raw >= RELEASE_THRESHOLD : raw >= DETECT_THRESHOLD;
          if (detecting && !was) {
            setDetections((n) => n + 1);
            setLastDetectAt(new Date().toLocaleTimeString());
            try {
              navigator.vibrate?.(200);
            } catch {
              /* ignore */
            }
          }
          wasDetectingRef.current = detecting;
        })
        .catch(() => {
          /* transient scoring error — next tick retries */
        })
        .finally(() => {
          scoringRef.current = false;
        });
    }, SCORE_INTERVAL_MS);

    // Re-render clock so the graph scrolls even between scores
    const clock = setInterval(() => setNowTick(Date.now()), 500);

    return () => {
      clearInterval(scorer);
      clearInterval(clock);
    };
  }, [phase]);

  // Redraw the graph on new data, clock ticks, and resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawGraph(canvas, history, nowTick);
  }, [history, nowTick]);

  useEffect(() => {
    const onResize = () => {
      if (canvasRef.current) drawGraph(canvasRef.current, historyRef.current, Date.now());
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  const stop = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    // Release the wasm session so a later Start re-inits from a clean slate
    // (stale sessions pin wasm memory and can OOM mobile Safari on restart).
    const det = detectorRef.current;
    detectorRef.current = null;
    if (det) void det.dispose().catch(() => {});
    void wakeLockRef.current?.release();
    wakeLockRef.current = null;
    scoringRef.current = false;
    setPhase("idle");
    setConf(null);
    wasDetectingRef.current = false;
  }, []);

  const detecting = (conf ?? 0) >= DETECT_THRESHOLD;
  const confPct = conf == null ? null : Math.round(conf * 100);
  const busy = phase === "loading" || phase === "starting";

  return (
    <main style={{ padding: 20, maxWidth: 560, margin: "0 auto" }}>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
        SkyMesh Node · {nodeId || "…"}
      </div>

      {/* Big readout */}
      <div style={{ textAlign: "center", margin: "8px 0 4px" }}>
        <div
          style={{
            fontSize: 76,
            fontWeight: 800,
            lineHeight: 1,
            color: detecting ? RED : "#111",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {confPct == null ? "—" : `${confPct}%`}
        </div>
        <div style={{ marginTop: 8, minHeight: 32 }}>
          {phase === "listening" ? (
            detecting ? (
              <span
                style={{
                  display: "inline-block",
                  background: RED,
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 16,
                  padding: "6px 16px",
                  borderRadius: 999,
                }}
              >
                DRONE DETECTED
              </span>
            ) : (
              <span style={{ color: MUTED, fontWeight: 600, fontSize: 16 }}>clear</span>
            )
          ) : (
            <span style={{ color: MUTED, fontSize: 14 }}>
              {phase === "idle" ? "press Start to listen" : "\u00a0"}
            </span>
          )}
        </div>
      </div>

      {/* Infinite confidence graph */}
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          marginTop: 8,
          overflow: "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={
            conf == null
              ? "Drone confidence history, no data yet"
              : `Drone confidence history, current ${Math.round(conf * 100)} percent${
                  detecting ? ", above threshold, drone detected" : ", below threshold, clear"
                }`
          }
          style={{ display: "block", width: "100%", height: 260 }}
        />
      </div>
      {phase === "listening" && detections > 0 && (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 6, textAlign: "center" }}>
          {detections} detection{detections === 1 ? "" : "s"} · last {lastDetectAt}
        </div>
      )}

      {/* One big button */}
      <div style={{ marginTop: 16 }}>
        {(phase === "idle" || phase === "error") && (
          <button
            onClick={start}
            style={{
              width: "100%",
              padding: "20px 0",
              fontSize: 20,
              borderRadius: 12,
              border: "none",
              background: "#16a34a",
              color: "white",
              fontWeight: 700,
            }}
          >
            Start listening
          </button>
        )}
        {busy && (
          <p style={{ textAlign: "center", color: MUTED }}>
            {phase === "loading" ? "Loading drone detector (6 MB, one-time)…" : "Requesting microphone…"}
          </p>
        )}
        {phase === "listening" && (
          <button
            onClick={stop}
            style={{
              width: "100%",
              padding: "14px 0",
              fontSize: 17,
              borderRadius: 12,
              border: "2px solid #111",
              background: "#fff",
              color: "#111",
              fontWeight: 700,
            }}
          >
            Stop
          </button>
        )}
        {phase === "error" && (
          <div>
            <p style={{ color: RED }}>{err}</p>
            <p style={{ fontSize: 13, color: MUTED }}>
              Mic needs HTTPS (or localhost) and permission. Check Settings → Safari → Microphone.
            </p>
          </div>
        )}
      </div>

      <p style={{ fontSize: 12, color: MUTED, textAlign: "center", marginTop: 12 }}>
        All on-device · audio never leaves this phone
      </p>
    </main>
  );
}
