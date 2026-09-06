// page.tsx — the node. One tap to join, then it listens and gossips.
//
// The join flow of ARCHITECTURE.md §11: mic permission needs a user gesture on
// iOS, and no geolocation is requested at all because the admin sets position in
// room coordinates (§13).

"use client";

import { useEffect, useRef, useState } from "react";
import { useMesh } from "./lib/useMesh.ts";
import { MicScorer, SILENT, type Score } from "./lib/scoring.ts";
import { RoomMap } from "./lib/RoomMap.tsx";
import { DEFAULT_ROOM } from "./lib/mesh.ts";

export default function NodePage() {
  const [joined, setJoined] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [score, setScore] = useState<Score>(SILENT);
  const { mesh, view } = useMesh({ enabled: joined });
  const scorerRef = useRef<MicScorer | null>(null);

  async function join() {
    setMicError(null);
    const scorer = new MicScorer();
    try {
      await scorer.start();
      scorerRef.current = scorer;
      setJoined(true);
    } catch (e) {
      // A node without a mic is still a valid node — it just contributes nothing.
      setMicError(String(e));
      setJoined(true);
    }
  }

  // Publish a reading every second, whatever its value: a quiet node is evidence
  // (§6.1), and silence is what pushes the posterior away from empty space.
  useEffect(() => {
    if (!joined || !mesh) return;
    const id = setInterval(() => {
      const s = scorerRef.current?.latest() ?? SILENT;
      setScore(s);
      mesh.publishReading(s);
    }, 1000);
    return () => clearInterval(id);
  }, [joined, mesh]);

  // Screen lock kills the mic and the socket, so hold a wake lock while active.
  useEffect(() => {
    if (!joined) return;
    let lock: any = null;
    const nav = navigator as any;
    nav.wakeLock?.request("screen").then((l: any) => (lock = l)).catch(() => {});
    return () => lock?.release?.().catch(() => {});
  }, [joined]);

  useEffect(() => () => scorerRef.current?.stop(), []);

  if (!joined) {
    return (
      <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <h1 style={{ fontSize: 28, marginBottom: 4 }}>SkyMesh</h1>
          <p className="dim" style={{ marginTop: 0 }}>
            Your phone becomes a sensor node. Audio never leaves the device — only a
            likelihood does.
          </p>
          <button className="primary" style={{ fontSize: 18, padding: "14px 32px" }} onClick={join}>
            Join the mesh
          </button>
          <p className="dim" style={{ fontSize: 12 }}>Allow microphone access when asked.</p>
        </div>
      </main>
    );
  }

  const status = view?.status.state ?? "connecting";
  const est = view?.estimate ?? null;
  const levels = new Map<string, number>(view ? [[view.nodeId, score.p]] : []);

  return (
    <main style={{ padding: 16, display: "grid", gap: 12, maxWidth: 780, margin: "0 auto" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>node {view?.nodeId ?? "…"}</h1>
        <span
          className="dim"
          style={{ color: status === "active" ? "var(--ok)" : "var(--warn)" }}
        >
          {status === "pending" ? "waiting for admin" : status}
        </span>
      </div>

      {micError && (
        <div className="panel" style={{ borderColor: "var(--warn)", color: "var(--warn)" }}>
          No microphone: {micError}. Still a valid node — it just contributes no evidence.
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>drone likelihood</h2>
          <span style={{ fontSize: 24, color: score.p > 0.7 ? "var(--hot)" : "var(--text)" }}>
            {score.p.toFixed(2)}
          </span>
        </div>
        <div style={{ height: 10, background: "#0e1620", borderRadius: 5, overflow: "hidden" }}>
          <div
            style={{
              width: `${score.p * 100}%`,
              height: "100%",
              background: score.p > 0.7 ? "var(--hot)" : "var(--accent)",
              transition: "width 300ms",
            }}
          />
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
          snr {score.snrDb === null ? "—" : `${score.snrDb.toFixed(1)} dB`} · logit{" "}
          {score.logit.toFixed(2)}
        </div>
      </div>

      <div className="panel">
        <h2>my picture</h2>
        <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
          Computed here, from this phone's own replica — not received from a server.
        </p>
        <RoomMap
          room={DEFAULT_ROOM}
          positions={view?.positions ?? new Map()}
          estimate={est}
          levels={levels}
          width={340}
        />
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {est ? (
            <>
              fused from <b>{est.nReports}</b> reporting + <b>{est.nSilent}</b> silent · ±
              {est.spreadM.toFixed(1)} m
              {!est.graded && <span style={{ color: "var(--warn)" }}> · no SNR: coarse</span>}
            </>
          ) : (view?.positions.size ?? 0) > 0 ? (
            <span className="dim">nothing heard · {view?.listening ?? 0} nodes listening</span>
          ) : (
            <span className="dim">no positioned readings yet — admin must place nodes</span>
          )}
        </div>
      </div>

      <div className="panel dim" style={{ fontSize: 12 }}>
        {view?.records ?? 0} records held · neighbours {view?.neighbours.join(", ") || "none"} ·
        clock root {view?.clock.rootId ?? "?"} ({(view?.clock.offsetMs ?? 0).toFixed(0)} ms,{" "}
        {view?.clock.hops ?? 0} hops)
      </div>
    </main>
  );
}
