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
//
// 3D models: CC-BY 3.0 via Poly Pizza (Google Poly successor). See credits
// below per model. Files vendored in /public/models for offline hackathon use.

import { useEffect, useRef, useState } from "react";

const FUNDAMENTAL = 150;
const HARMONICS = 5;

// model-viewer web component (no React types needed via `as any` tag).
const MV = "model-viewer" as unknown as React.ElementType;

type Drone = {
  id: string;
  name: string;
  src: string;
  page: string;
  author: string;
  size: string;
  tris: string;
  note: string;
};

const DRONES: Drone[] = [
  {
    id: "nate",
    name: "Drone (NateGazzard) — top pick",
    src: "/models/drone-nate.glb",
    page: "https://poly.pizza/m/DNbUoMtG3H",
    author: "NateGazzard",
    size: "260 KB",
    tris: "4564",
    note: "Quad rotor + underside camera, most realistic",
  },
  {
    id: "silly",
    name: "Drone (Silly Fear)",
    src: "/models/drone-silly.glb",
    page: "https://poly.pizza/m/3Ae_y67lzvd",
    author: "Silly Fear",
    size: "228 KB",
    tris: "2397",
    note: "Clean quadcopter backup",
  },
  {
    id: "antigrav",
    name: "Anti-Gravity Drone",
    src: "/models/drone-antigrav.glb",
    page: "https://poly.pizza/m/fiYuC73Xlwp",
    author: "Adam Marc Williams",
    size: "193 KB",
    tris: "3352",
    note: "Most popular (16.5k downloads), futuristic",
  },
  {
    id: "little",
    name: "Little Drone",
    src: "/models/drone-little.glb",
    page: "https://poly.pizza/m/dJ9mjQQqDQJ",
    author: "Nick Olson",
    size: "189 KB",
    tris: "2690",
    note: "Cute, good for small viewport",
  },
  {
    id: "stinger",
    name: "Stinger Drone (lightest)",
    src: "/models/drone-stinger.glb",
    page: "https://poly.pizza/m/6CUQX98vha4",
    author: "Aaron Clifford",
    size: "95 KB",
    tris: "1132",
    note: "Fastest load, laser drone",
  },
];

export default function TonePage() {
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"drone" | "synth">("drone");
  const [selected, setSelected] = useState<Drone>(DRONES[0]);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<OscillatorNode[]>([]);
  const droneRef = useRef<HTMLAudioElement | null>(null);

  // Load <model-viewer> web component once on the client.
  useEffect(() => {
    if (document.querySelector('script[data-model-viewer]')) return;
    const s = document.createElement("script");
    s.type = "module";
    s.src =
      "https://ajax.googleapis.com/ajax/libs/model-viewer/4.3.1/model-viewer.min.js";
    s.setAttribute("data-model-viewer", "1");
    document.head.appendChild(s);
  }, []);

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
        maxWidth: 920,
        margin: "0 auto",
        fontFamily: "-apple-system, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22 }}>Drone verification sound + 3D picker</h1>
      <p style={{ color: "#8b949e", fontSize: 13 }}>
        Compare the 5 vendored GLB drones below (drag to orbit, scroll to
        zoom). Click a card to feature it, then tell me which one to keep.
      </p>

      {/* Featured viewer */}
      <div
        style={{
          border: "1px solid #30363d",
          borderRadius: 12,
          overflow: "hidden",
          background: "#0d1117",
        }}
      >
        <MV
          src={selected.src}
          alt={selected.name}
          camera-controls
          auto-rotate
          shadow-intensity="1"
          interaction-prompt="auto"
          style={{ width: "100%", height: 380, background: "#11161d" }}
        />
        <div style={{ padding: "12px 16px" }}>
          <div style={{ fontWeight: 700 }}>{selected.name}</div>
          <div style={{ fontSize: 12, color: "#8b949e", marginTop: 4 }}>
            {selected.size} · {selected.tris} tris · by {selected.author} ·
            CC-BY 3.0 via{" "}
            <a
              href={selected.page}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#58a6ff" }}
            >
              Poly Pizza
            </a>{" "}
            · <code>{selected.src}</code>
          </div>
          <div style={{ fontSize: 12, color: "#8b949e" }}>{selected.note}</div>
        </div>
      </div>

      {/* Thumbnail grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        {DRONES.map((d) => {
          const active = d.id === selected.id;
          return (
            <button
              key={d.id}
              onClick={() => setSelected(d)}
              style={{
                textAlign: "left",
                borderRadius: 12,
                overflow: "hidden",
                cursor: "pointer",
                background: "#0d1117",
                color: "inherit",
                border: active ? "2px solid #2ea043" : "1px solid #30363d",
                padding: 0,
              }}
            >
              <MV
                src={d.src}
                alt={d.name}
                camera-controls
                auto-rotate
                shadow-intensity="1"
                style={{
                  width: "100%",
                  height: 140,
                  background: "#11161d",
                  pointerEvents: "none",
                }}
              />
              <div style={{ padding: "8px 10px" }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>
                  {active ? "● " : "○ "}
                  {d.name}
                </div>
                <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>
                  {d.size} · {d.tris} tris
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: "#6e7681" }}>
        3D credit: all models CC-BY 3.0 via Poly Pizza — NateGazzard, Silly
        Fear, Adam Marc Williams, Nick Olson, Aaron Clifford.
      </p>

      {/* Audio section (unchanged logic, constrained width) */}
      <div style={{ maxWidth: 480, margin: "24px auto 0" }}>
        <h2 style={{ fontSize: 18 }}>Drone verification sound</h2>
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
      </div>
    </main>
  );
}
