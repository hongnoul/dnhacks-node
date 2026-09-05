"use client";

// /tone — demo station: QR to the apex node page (left) + clickable 3D drone
// (right). Clicking the drone spins its 4 propellers and plays REAL drone
// audio (DADS clips looped, 48 kHz mono) so the on-device CRNN verdict on the
// phone slams to ~100%.
//
// Usage: MacBook shows this page. iPhone scans the QR, opens the apex node
// page, Start listening. Click the drone, volume 100%, hold the MacBook
// speaker 10-30 cm from the iPhone mic. Expect 🚨 DRONE DETECTED in ~1 s.
//
// Audio credit: Drone Audio Detection Samples (DADS, MIT),
// https://huggingface.co/datasets/geronimobasso/drone-audio-detection-samples
// 3D credit: "Drone" by NateGazzard, CC-BY 3.0 via Poly Pizza,
// https://poly.pizza/m/DNbUoMtG3H (vendored in /public/models).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import QRCode from "react-qr-code";

// Apex = production node page the phone opens.
const APEX_URL = "https://dnhacks-node.vercel.app";
const MODEL_SRC = "/models/drone-nate.glb";

export default function TonePage() {
  const [playing, setPlaying] = useState(false);
  const [spin, setSpin] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const droneRef = useRef<HTMLAudioElement | null>(null);
  const spinRef = useRef(false);
  const rotorsRef = useRef<THREE.Object3D[]>([]);

  // Keep the mutable spin flag in sync for the animation loop.
  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  // Three.js scene: top-pick drone, orbit drag, click = spin + sound.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let raf = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const size = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      return { w, h };
    };
    const { w, h } = size();
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.01, 100);
    camera.position.set(0.9, 0.75, 1.15);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, -0.1);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x9ca3af, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdbeafe, 0.7);
    fill.position.set(-2, 1, -1.5);
    scene.add(fill);

    const drone = new THREE.Group();
    scene.add(drone);
    const clock = new THREE.Clock();

    new GLTFLoader().load(
      MODEL_SRC,
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        // Center + normalize: model spans z in [-0.5, 0.26].
        model.position.set(0, 0, 0.13);
        drone.add(model);
        // Named rotor nodes spin around local Y (thin flat discs, Y ~ 0.008).
        rotorsRef.current = [];
        model.traverse((o) => {
          if (/rotor/i.test(o.name)) rotorsRef.current.push(o);
        });
        setReady(true);
      },
      undefined,
      (err: unknown) => {
        if (!disposed)
          setLoadError(err instanceof Error ? err.message : "failed to load drone.glb");
      },
    );

    // Click (not drag): raycast against the drone group.
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    let downAt = 0;
    let downXY: [number, number] = [0, 0];
    const onDown = (e: PointerEvent) => {
      downAt = performance.now();
      downXY = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent) => {
      if (performance.now() - downAt > 300) return; // was a drag
      const dx = e.clientX - downXY[0];
      const dy = e.clientY - downXY[1];
      if (dx * dx + dy * dy > 36) return; // moved too far
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(ptr, camera);
      if (ray.intersectObject(drone, true).length > 0) {
        // Custom event picked up by the React click handler below.
        mount.dispatchEvent(new CustomEvent("drone-click"));
      }
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (spinRef.current) {
        // Counter-rotating quad: FL+BR clockwise, FR+BL counter.
        rotorsRef.current.forEach((r, i) => {
          r.rotation.y += (i % 2 === 0 ? 1 : -1) * dt * 40;
        });
        drone.position.y = Math.sin(performance.now() / 300) * 0.02;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const onResize = () => {
      const { w: nw, h: nh } = size();
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  const stop = () => {
    spinRef.current = false;
    setSpin(false);
    droneRef.current?.pause();
    setPlaying(false);
  };

  const toggleDrone = async () => {
    // Forwarded from the three.js canvas click OR the fallback button.
    if (spinRef.current) {
      stop();
      return;
    }
    const el = droneRef.current;
    if (el) {
      try {
        el.volume = 1.0;
        el.loop = true;
        await el.play();
      } catch {
        /* autoplay blocked — user gesture already happened, ignore */
      }
    }
    spinRef.current = true;
    setSpin(true);
    setPlaying(true);
  };

  // Bridge canvas clicks into the React handler.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const h = () => void toggleDrone();
    mount.addEventListener("drone-click", h);
    return () => mount.removeEventListener("drone-click", h);
  }, []);

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: "0 auto",
        fontFamily: "-apple-system, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22 }}>SkyMesh demo station</h1>
      <p style={{ color: "#6b7280", fontSize: 13 }}>
        Phone scans the QR to open the apex node page. Click the drone to spin
        its propellers and play real drone audio at the phone mic.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        {/* LEFT: QR to apex */}
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 24,
            background: "#fff",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          <div style={{ background: "#fff", padding: 12 }}>
            <QRCode value={APEX_URL} size={220} data-testid="apex-qr" />
          </div>
          <div style={{ fontWeight: 700 }}>1. Scan with the iPhone</div>
          <div
            style={{ fontSize: 12, color: "#6b7280", textAlign: "center" }}
          >
            Opens the apex node page:
            <br />
            <a
              href={APEX_URL}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#2563eb", wordBreak: "break-all" }}
            >
              {APEX_URL}
            </a>
            <br />
            Then tap <b>Start listening</b> on the phone.
          </div>
        </section>

        {/* RIGHT: clickable drone */}
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            overflow: "hidden",
            background: "#f9fafb",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            ref={mountRef}
            data-testid="drone-canvas"
            onClick={() => void toggleDrone()}
            style={{
              width: "100%",
              height: 380,
              cursor: "pointer",
              background: "#f3f4f6",
              position: "relative",
            }}
            title={spin ? "Click to stop" : "Click to spin + play sound"}
          >
            {!ready && !loadError && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#6b7280",
                  fontSize: 13,
                }}
              >
                Loading drone…
              </div>
            )}
            {loadError && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#dc2626",
                  fontSize: 13,
                  padding: 16,
                  textAlign: "center",
                }}
              >
                3D failed: {loadError} — the audio button below still works.
              </div>
            )}
            <div
              style={{
                position: "absolute",
                left: 12,
                top: 10,
                fontSize: 12,
                fontWeight: 700,
                color: spin ? "#16a34a" : "#6b7280",
                background: "rgba(255,255,255,0.85)",
                padding: "4px 10px",
                borderRadius: 999,
                pointerEvents: "none",
              }}
              data-testid="spin-state"
            >
              {spin ? "● spinning + playing" : "○ click the drone"}
            </div>
          </div>
          <div style={{ padding: "12px 16px" }}>
            <div style={{ fontWeight: 700 }}>
              2. Click the drone — props spin + real audio plays
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
              Quad rotor + underside camera · 260 KB · 4564 tris · “Drone” by
              NateGazzard, CC-BY 3.0 via{" "}
              <a
                href="https://poly.pizza/m/DNbUoMtG3H"
                target="_blank"
                rel="noreferrer"
                style={{ color: "#2563eb" }}
              >
                Poly Pizza
              </a>
              . Drag to orbit, scroll to zoom.
            </div>
            {playing ? (
              <button
                onClick={stop}
                style={{
                  marginTop: 10,
                  width: "100%",
                  padding: "14px 0",
                  fontSize: 16,
                  borderRadius: 10,
                  border: "none",
                  background: "#dc2626",
                  color: "white",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                ■ Stop (props + audio)
              </button>
            ) : (
              <button
                onClick={() => void toggleDrone()}
                style={{
                  marginTop: 10,
                  width: "100%",
                  padding: "14px 0",
                  fontSize: 16,
                  borderRadius: 10,
                  border: "none",
                  background: "#16a34a",
                  color: "white",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                ▶ Spin + play drone audio
              </button>
            )}
          </div>
        </section>
      </div>

      <audio
        ref={droneRef}
        src="/drone-demo.wav"
        loop
        controls
        preload="auto"
        style={{ width: "100%", maxWidth: 480, marginTop: 16 }}
      />

      <ol style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.7 }}>
        <li>iPhone: scan the QR, open the apex page, Start listening.</li>
        <li>
          MacBook: click the drone (or ▶ button), volume 100%, hold the
          speaker 10–30 cm from the iPhone mic.
        </li>
        <li>
          Expect: drone confidence slams to ~100% + “🚨 DRONE DETECTED” within
          a second.
        </li>
      </ol>
      <p style={{ fontSize: 11, color: "#9ca3af" }}>
        Drone audio: DADS (MIT), geronimobasso/drone-audio-detection-samples.
      </p>
    </main>
  );
}
