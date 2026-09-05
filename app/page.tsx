"use client";

// SkyMesh sensor node — single page: join → listening.
// One tap starts mic + GPS + heartbeats; loudness gate sends 2s clips.

import { useCallback, useEffect, useRef, useState } from "react";
import { MicCapture, type AudioFrame } from "./lib/audio";
import { GeoWatcher } from "./lib/geo";
import { ServerLink, randomNodeId, type NetStats } from "./lib/net";

// Server base URL: ?server=https://... overrides; default same-origin /api proxy
// or NEXT_PUBLIC_SERVER_URL baked at build time.
// Anchor pin for demo: ?lat=38.9&lon=-77.04[&acc=5] locks node position instead
// of live GPS — essential indoors where phone GPS is ±30m+.
function resolveServerUrl(): string {
  if (typeof window === "undefined") return "";
  const qp = new URLSearchParams(window.location.search).get("server");
  if (qp) return qp.replace(/\/$/, "");
  if (process.env.NEXT_PUBLIC_SERVER_URL)
    return process.env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, "");
  return `${window.location.origin}/api`;
}

function resolveAnchor(): { lat: number; lon: number; acc: number } | null {
  if (typeof window === "undefined") return null;
  const qp = new URLSearchParams(window.location.search);
  const lat = parseFloat(qp.get("lat") ?? "");
  const lon = parseFloat(qp.get("lon") ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const acc = parseFloat(qp.get("acc") ?? "3");
  return { lat, lon, acc: Number.isFinite(acc) ? acc : 3 };
}

function gpsQuality(acc: number | null): { label: string; color: string } {
  if (acc == null) return { label: "no fix", color: "#8b949e" };
  if (acc <= 10) return { label: "good", color: "#3fb950" };
  if (acc <= 20) return { label: "fair", color: "#d29922" };
  return { label: "poor — pin position for demo", color: "#f85149" };
}

// Loudness gate: band RMS must exceed GATE_THRESHOLD, with a refractory period
// so we don't spam clips. Tune at the venue; deliberately trigger-happy for now.
const GATE_THRESHOLD = 0.25;
const REFRACTORY_MS = 3000;

type Phase = "idle" | "starting" | "listening" | "error";

export default function NodePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>("");
  const [frame, setFrame] = useState<AudioFrame>({ loudness: 0, bandLoudness: 0 });
  const [gps, setGps] = useState<string>("no fix");
  const [gpsAcc, setGpsAcc] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ lat: number; lon: number; acc: number } | null>(null);
  const [stats, setStats] = useState<NetStats | null>(null);
  const [serverUrl, setServerUrl] = useState<string>("");
  const [nodeId] = useState(randomNodeId);
  const [lastClipAt, setLastClipAt] = useState<string>("never");

  const micRef = useRef<MicCapture | null>(null);
  const geoRef = useRef<GeoWatcher | null>(null);
  const linkRef = useRef<ServerLink | null>(null);
  const lastTriggerRef = useRef<number>(0);
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null);

  useEffect(() => {
    setServerUrl(resolveServerUrl());
    setAnchor(resolveAnchor());
  }, []);

  const start = useCallback(async () => {
    setPhase("starting");
    setErr("");
    try {
      const mic = new MicCapture();
      await mic.start(); // must be inside the tap's call stack for iOS
      micRef.current = mic;

      const geo = new GeoWatcher();
      geo.start();
      geoRef.current = geo;

      linkRef.current = new ServerLink(resolveServerUrl(), nodeId);

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
  }, [nodeId]);

  // Main loops: 4 Hz meter + gate, 1 Hz heartbeat
  useEffect(() => {
    if (phase !== "listening") return;
    const meter = setInterval(() => {
      const mic = micRef.current;
      const link = linkRef.current;
      if (!mic || !link) return;
      const f = mic.frame();
      setFrame(f);
      const live = geoRef.current?.last ?? null;
      const pinned = resolveAnchor();
      const fix = pinned
        ? { lat: pinned.lat, lon: pinned.lon, accuracyM: pinned.acc, t: Date.now() / 1000 }
        : live;
      setGpsAcc(fix?.accuracyM ?? null);
      setGps(
        fix
          ? `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} (±${Math.round(fix.accuracyM)}m)${pinned ? " 📌" : ""}`
          : geoRef.current?.error ?? "no fix"
      );

      // loudness gate
      const now = Date.now();
      if (f.bandLoudness > GATE_THRESHOLD && now - lastTriggerRef.current > REFRACTORY_MS) {
        lastTriggerRef.current = now;
        const clip = mic.clip();
        if (clip) {
          void link
            .sendClip(clip.wav, {
              t0: clip.t0,
              sampleRate: clip.sampleRate,
              durationS: clip.durationS,
              loudness: f.bandLoudness,
              fix,
            })
            .then((ok) => {
              if (ok) setLastClipAt(new Date().toLocaleTimeString());
              setStats({ ...link.stats });
            });
        }
      }
    }, 250);

    const hb = setInterval(() => {
      const link = linkRef.current;
      if (!link) return;
      const pinned = resolveAnchor();
      const fix = pinned
        ? { lat: pinned.lat, lon: pinned.lon, accuracyM: pinned.acc, t: Date.now() / 1000 }
        : geoRef.current?.last ?? null;
      void link
        .heartbeat(fix, micRef.current?.frame().bandLoudness ?? 0)
        .then(() => setStats({ ...link.stats }));
    }, 1000);

    return () => {
      clearInterval(meter);
      clearInterval(hb);
    };
  }, [phase]);

  const stop = useCallback(() => {
    micRef.current?.stop();
    geoRef.current?.stop();
    void wakeLockRef.current?.release();
    setPhase("idle");
  }, []);

  const pct = Math.round(frame.bandLoudness * 100);
  const gateHit = frame.bandLoudness > GATE_THRESHOLD;

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>SkyMesh Node</h1>
      <p style={{ color: "#8b949e", marginTop: 0, fontSize: 13 }}>
        node <code>{nodeId}</code> → <code style={{ wordBreak: "break-all" }}>{serverUrl}</code>
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
          Join the mesh
        </button>
      )}
      {phase === "starting" && <p>Requesting mic + GPS…</p>}
      {phase === "error" && (
        <div>
          <p style={{ color: "#f85149" }}>{err}</p>
          <p style={{ fontSize: 13, color: "#8b949e" }}>
            Mic needs HTTPS (or localhost) and permission. Check Settings → Safari →
            Microphone.
          </p>
          <button onClick={start}>Retry</button>
        </div>
      )}

      {phase === "listening" && (
        <>
          <div
            style={{
              height: 120,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "16px 0",
            }}
          >
            {/* pulsing listening indicator; keeps screen "active-looking" */}
            <div
              style={{
                width: 60 + frame.bandLoudness * 140,
                height: 60 + frame.bandLoudness * 140,
                borderRadius: "50%",
                background: gateHit ? "#f8514966" : "#2ea04333",
                border: `3px solid ${gateHit ? "#f85149" : "#2ea043"}`,
                transition: "all 120ms",
              }}
            />
          </div>

          <table style={{ width: "100%", fontSize: 14, borderSpacing: "0 6px" }}>
            <tbody>
              <tr>
                <td style={{ color: "#8b949e" }}>drone-band level</td>
                <td style={{ textAlign: "right" }}>
                  {pct}% {gateHit ? "🔴 GATE" : ""}
                </td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>GPS</td>
                <td style={{ textAlign: "right", fontSize: 12 }}>{gps}</td>
              </tr>
              {(() => {
                const q = gpsQuality(anchor ? anchor.acc : gpsAcc);
                return (
                  <tr>
                    <td style={{ color: "#8b949e" }}>GPS quality</td>
                    <td style={{ textAlign: "right", fontSize: 12, color: q.color }}>
                      {anchor ? `📌 pinned ±${anchor.acc}m` : q.label}
                    </td>
                  </tr>
                );
              })()}
              <tr>
                <td style={{ color: "#8b949e" }}>heartbeats</td>
                <td style={{ textAlign: "right" }}>{stats?.heartbeatsSent ?? 0}</td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>clips sent / failed</td>
                <td style={{ textAlign: "right" }}>
                  {stats?.clipsSent ?? 0} / {stats?.clipsFailed ?? 0}
                </td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>last clip</td>
                <td style={{ textAlign: "right" }}>{lastClipAt}</td>
              </tr>
              <tr>
                <td style={{ color: "#8b949e" }}>last server ack</td>
                <td style={{ textAlign: "right" }}>{stats?.lastServerAck ?? "—"}</td>
              </tr>
            </tbody>
          </table>
          {stats?.lastError && (
            <p style={{ color: "#f85149", fontSize: 12 }}>{stats.lastError}</p>
          )}

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
            Leave mesh
          </button>
          <p style={{ fontSize: 12, color: "#8b949e" }}>
            Keep this tab open and the screen on. Audio leaves this phone only as 2s
            clips when the loudness gate trips.
          </p>
        </>
      )}
    </main>
  );
}
