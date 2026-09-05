"use client";

// /tone — MacBook verification sound for the SkyMesh iPhone node.
// Plays REAL drone audio (DADS clips looped to 10 s, 48 kHz mono) so the
// on-device CRNN verdict slams to ~100%. A pure sine stack is also offered,
// but note it only trips the cheap loudness/harmonic gate — the CRNN learned
// real prop noise and scores sine stacks ~0.001.
//
// Usage: open this page on the MacBook, hit PLAY, volume to max, hold the
// speaker near the iPhone running the node page. Expect the drone confidence
// readout to slam to ~100% within a second.
//
// Audio credit: Drone Audio Detection Samples (DADS, MIT),
// https://huggingface.co/datasets/geronimobasso/drone-audio-detection-samples
// (aggregates CC-BY sources — see dataset card for per-source licenses).

import { useRef, useState } from "react";

const FUNDAMENTAL = 150;
const HARMONICS = 5;

export default function TonePage() {
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"drone" | "synth">("drone");
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<OscillatorNode[]>([]);
  const droneRef = useRef<HTMLAudioElement | null>(null);

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
    droneRef.current?.pause();
    setPlaying(false);
  };

  const playDrone = async () => {
    stop();
    const el = droneRef.current;
    if (!el) return;
    el.volume = 1.0;
    el.loop = true;
    await el.play();
    setMode("drone");
    setPlaying(true);
  };

  const playSynth = async () => {
    stop();
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    for (let h = 1; h <= HARMONICS; h++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = FUNDAMENTAL * h;
      const g = ctx.createGain();
      g.gain.value = 1 / h;
      osc.connect(g);
      g.connect(master);
      osc.start();
      nodesRef.current.push(osc);
    }
    setMode("synth");
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
      <h1 style={{ fontSize: 22 }}>Drone verification sound</h1>
      <p style={{ color: "#8b949e", fontSize: 13 }}>
        Real drone audio — drives the on-device CRNN to ~100%. MacBook volume
        to MAX, speaker near the iPhone mic.
      </p>

      {!playing ? (
        <>
          <button
            onClick={playDrone}
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
            ▶ Play drone audio (loops)
          </button>
          <button
            onClick={playSynth}
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
            Gate-check tone instead (sine stack, CRNN ignores it)
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
          ■ Stop ({mode === "drone" ? "drone loop" : "sine loop"})
        </button>
      )}

      <audio
        ref={droneRef}
        src="/drone-demo.wav"
        loop
        controls
        preload="auto"
        style={{ width: "100%", marginTop: 16 }}
      />

      <ol style={{ fontSize: 13, color: "#8b949e", lineHeight: 1.7 }}>
        <li>MacBook: open this page, hit Play, volume 100%.</li>
        <li>
          iPhone: open the node page, Start listening, hold it 10–30 cm from
          the MacBook speaker.
        </li>
        <li>
          Expect: drone confidence slams to ~100% + &quot;🚨 DRONE
          DETECTED&quot; within a second.
        </li>
        <li>
          The sine stack only moves the drone-band/harmonics meters — the CRNN
          verdict stays near 0%. That split is the gate vs classifier working
          as designed.
        </li>
      </ol>
      <p style={{ fontSize: 12, color: "#8b949e" }}>
        Direct file links (play natively on macOS):{" "}
        <code>/drone-demo.wav</code> (real drone audio, verifies detection) ·{" "}
        <code>/drone-tone.wav</code> (sine stack, gate meters only)
      </p>
      <p style={{ fontSize: 11, color: "#6e7681" }}>
        Drone audio: DADS (MIT), geronimobasso/drone-audio-detection-samples —
        aggregates CC-BY sources, see dataset card.
      </p>
    </main>
  );
}
