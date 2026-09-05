"use client";

// /tone — MacBook verification sound for the SkyMesh iPhone node.
// Synthesizes the same prop-harmonic stack as server/drone_tone.wav
// (150 Hz ×5 harmonics, 1/h weighting) via WebAudio, so it loops
// forever at full volume with no file download. Also offers the
// exact fixture WAV (/drone-tone.wav) as a looping <audio> fallback.
//
// Usage: open this page on the MacBook, hit PLAY, volume to max,
// hold the speaker near the iPhone running the node page. The node
// should show drone-band level >25% + "prop-like" + GATE → clips sent.

import { useRef, useState } from "react";

const FUNDAMENTAL = 150;
const HARMONICS = 5;

export default function TonePage() {
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"synth" | "wav">("synth");
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<OscillatorNode[]>([]);
  const wavRef = useRef<HTMLAudioElement | null>(null);

  const stop = () => {
    nodesRef.current.forEach((o) => {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      o.disconnect();
    });
    nodesRef.current = [];
    if (ctxRef.current) {
      void ctxRef.current.close();
      ctxRef.current = null;
    }
    wavRef.current?.pause();
    setPlaying(false);
  };

  const playSynth = async () => {
    stop();
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.9; // full-scale, matches fixture gain headroom
    master.connect(ctx.destination);
    for (let h = 1; h <= HARMONICS; h++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = FUNDAMENTAL * h;
      const g = ctx.createGain();
      g.gain.value = 1 / h; // same 1/h weighting as drone_tone.wav
      osc.connect(g);
      g.connect(master);
      osc.start();
      nodesRef.current.push(osc);
    }
    setMode("synth");
    setPlaying(true);
  };

  const playWav = async () => {
    stop();
    const el = wavRef.current;
    if (!el) return;
    el.volume = 1.0;
    el.loop = true;
    await el.play();
    setMode("wav");
    setPlaying(true);
  };

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 480,
        margin: "0 auto",
        fontFamily: "-apple-system, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22 }}>Drone verification tone</h1>
      <p style={{ color: "#8b949e", fontSize: 13 }}>
        150 Hz ×5 harmonics — trips the node loudness + harmonic gate.
        MacBook volume to MAX, speaker near the iPhone mic.
      </p>

      {!playing ? (
        <>
          <button
            onClick={playSynth}
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
            ▶ Play test tone (loops)
          </button>
          <button
            onClick={playWav}
            style={{
              width: "100%",
              padding: "12px 0",
              marginTop: 12,
              borderRadius: 8,
              border: "1px solid #8b949e",
              background: "transparent",
              color: "inherit",
            }}
          >
            Play exact fixture WAV instead
          </button>
        </>
      ) : (
        <button
          onClick={stop}
          style={{
            width: "100%",
            padding: "20px 0",
            fontSize: 20,
            borderRadius: 12,
            border: "none",
            background: "#f85149",
            color: "white",
            fontWeight: 700,
          }}
        >
          ■ Stop ({mode === "synth" ? "synth loop" : "WAV loop"})
        </button>
      )}

      <audio
        ref={wavRef}
        src="/drone-tone.wav"
        loop
        controls
        preload="auto"
        style={{ width: "100%", marginTop: 16 }}
      />

      <ol style={{ fontSize: 13, color: "#8b949e", lineHeight: 1.7 }}>
        <li>MacBook: open this page, hit Play, volume 100%.</li>
        <li>
          iPhone: open the node page, Join the mesh, hold it 10–30 cm from the
          MacBook speaker.
        </li>
        <li>
          Expect: drone-band level jumps, &quot;prop-like 🟢&quot;, 🔴 GATE,
          clips sent increments.
        </li>
      </ol>
      <p style={{ fontSize: 12, color: "#8b949e" }}>
        Direct file link (plays natively on macOS):{" "}
        <code>/drone-tone.wav</code>
      </p>
    </main>
  );
}
