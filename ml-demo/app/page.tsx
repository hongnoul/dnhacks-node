"use client";

// SkyMesh sensor node — fully self-contained drone detection.
// The phone IS the node: mic → mel-spectrogram → on-device CRNN → confidence.
// No server, no location, no network after first load. Airplane mode works.
// This is the Demo 1 showcase: confidence in the existence of a drone.

import { useCallback, useEffect, useRef, useState } from "react";
import { MicCapture, type AudioFrame } from "./lib/audio";
import { DroneDetector } from "./lib/detector";

// On-device dual pre-gate (cheap, runs at 4 Hz): drone-band RMS + harmonic
// peakiness. Purely a power saver — the CRNN always has final say and runs
// continuously at 2 Hz regardless.
const GATE_THRESHOLD = 0.25;
const PEAKINESS_THRESHOLD = 10;

// CRNN verdict: score the last 1s window every 500 ms (same hop as model.py).
const SCORE_INTERVAL_MS = 500;
const DETECT_THRESHOLD = 0.5;

type Phase = "idle" | "loading" | "starting" | "listening" | "error";

function randomNodeId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export default function NodePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>("");
  const [frame, setFrame] = useState<AudioFrame>({ loudness: 0, bandLoudness: 0, peakiness: 0 });
  const [conf, setConf] = useState<number | null>(null);
  const [peakConf, setPeakConf] = useState<number>(0);
  const [detections, setDetections] = useState<number>(0);
  const [lastDetectAt, setLastDetectAt] = useState<string>("never");
  const [inferMs, setInferMs] = useState<number | null>(null);
  const [nodeId] = useState(randomNodeId);

  const micRef = useRef<MicCapture | null>(null);
  const detectorRef = useRef<DroneDetector | null>(null);
  const scoringRef = useRef(false); // skip ticks while an inference is in flight
  const wasDetectingRef = useRef(false);
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null);

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

      setPhase("listening");
    } catch (e) {
      setErr(String(e));
      setPhase("error");
    }
  }, []);

  // Meters at 4 Hz + CRNN scoring at 2 Hz — all on this phone.
  useEffect(() => {
    if (phase !== "listening") return;

    const meter = setInterval(() => {
      const mic = micRef.current;
      if (mic) setFrame(mic.frame());
    }, 250);

    const scorer = setInterval(() => {
      const mic = micRef.current;
      const det = detectorRef.current;
      if (!mic || !det?.ready || scoringRef.current) return;
      const samples = mic.samples(1.0);
      if (!samples) return;
      scoringRef.current = true;
      const t0 = performance.now();
      det
        .score(samples, mic.sampleRate)
        .then((p) => {
          setInferMs(performance.now() - t0);
          setConf(p);
          setPeakConf((prev) => Math.max(prev, p));
          const detecting = p >= DETECT_THRESHOLD;
          if (detecting && !wasDetectingRef.current) {
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

    return () => {
      clearInterval(meter);
      clearInterval(scorer);
    };
  }, [phase]);

  const stop = useCallback(() => {
    micRef.current?.stop();
    void wakeLockRef.current?.release();
    setPhase("idle");
    setConf(null);
    wasDetectingRef.current = false;
  }, []);

  const gateHit = frame.bandLoudness > GATE_THRESHOLD && frame.peakiness > PEAKINESS_THRESHOLD;
  const detecting = (conf ?? 0) >= DETECT_THRESHOLD;
  const confPct = conf == null ? null : Math.round(conf * 100);

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>SkyMesh Node</h1>
      <p style={{ color: "#8b949e", marginTop: 0, fontSize: 13 }}>
        node <code>{nodeId}</code> · CRNN runs on this phone — no server, no
        location, works offline
      </p>

      {phase === "idle" && (
        <button
          onClick={start}
          style={{
            width: "100%",
            padding: "20px 0",
            fontSize: 20,
            borderRadius: 12,
            border: "none",
            background: "#2ea043",
            color: "white",
            fontWeight: 700,
          }}
        >
          Start listening
        </button>
      )}
      {phase === "loading" && <p>Loading drone detector (6 MB, one-time)…</p>}
      {phase === "starting" && <p>Requesting microphone…</p>}
      {phase === "error" && (
        <div>
          <p style={{ color: "#f85149" }}>{err}</p>
          <p style={{ fontSize: 13, color: "#8b949e" }}>
            Mic needs HTTPS (or localhost) and permission. Check Settings →
            Safari → Microphone.
          </p>
          <button onClick={start}>Retry</button>
        </div>
      )}

      {phase === "listening" && (
        <>
          {/* Big verdict: THE demo readout */}
          <div
            style={{
              textAlign: "center",
              margin: "20px 0 4px",
              padding: "16px 0",
              borderRadius: 12,
              background: detecting ? "#f8514922" : "transparent",
              border: detecting ? "2px solid #f85149" : "2px solid transparent",
              transition: "all 200ms",
            }}
          >
            <div style={{ fontSize: 13, color: "#8b949e" }}>drone confidence</div>
            <div
              style={{
                fontSize: 56,
                fontWeight: 800,
                lineHeight: 1.1,
                color: detecting ? "#f85149" : "#3fb950",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {confPct == null ? "—" : `${confPct}%`}
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: detecting ? "#f85149" : "#8b949e",
                minHeight: 24,
              }}
            >
              {detecting ? "🚨 DRONE DETECTED" : "clear"}
            </div>
          </div>

          {/* pulsing listening indicator */}
          <div
            style={{
              height: 100,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "8px 0",
            }}
          >
            <div
              style={{
                width: 50 + frame.bandLoudness * 120,
                height: 50 + frame.bandLoudness * 120,
                borderRadius: "50%",
                background: detecting ? "#f8514966" : "#2ea04333",
                border: `3px solid ${detecting ? "#f85149" : "#2ea043"}`,
                transition: "all 120ms",
              }}
            />
          </div>

          <table style={{ width: "100%", fontSize: 14, borderSpacing: "0 6px" }}>
            <tbody>
              <tr>
                <td style={{ color: "#8b949e" }}>drone-band level</td>
                <td style={{ textAlign: "right" }}>
                  {Math.round(frame.bandLoudness * 100)}% {gateHit ? "🔴" : ""}
                </td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>harmonics</td>
                <td style={{ textAlign: "right", fontSize: 12 }}>
                  {frame.peakiness.toFixed(1)}×{" "}
                  {frame.peakiness > PEAKINESS_THRESHOLD ? "🟢 prop-like" : "flat"}
                </td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>peak confidence</td>
                <td style={{ textAlign: "right" }}>{Math.round(peakConf * 100)}%</td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>detections</td>
                <td style={{ textAlign: "right" }}>{detections}</td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>last detection</td>
                <td style={{ textAlign: "right" }}>{lastDetectAt}</td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>inference</td>
                <td style={{ textAlign: "right", fontSize: 12 }}>
                  {inferMs == null ? "—" : `${inferMs.toFixed(0)} ms on-device`}
                </td>
              </tr>
            </tbody>
          </table>

          <button
            onClick={stop}
            style={{
              width: "100%",
              padding: "12px 0",
              marginTop: 16,
              borderRadius: 8,
              border: "1px solid #f85149",
              background: "transparent",
              color: "#f85149",
            }}
          >
            Stop
          </button>
          <p style={{ fontSize: 12, color: "#8b949e" }}>
            All processing stays on this phone. The neural net scores the mic
            every 500 ms — audio never leaves the device.
          </p>
        </>
      )}
    </main>
  );
}
