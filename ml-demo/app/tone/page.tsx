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
// 3D: procedural FPV-style quadcopter (no external asset).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import QRCode from "react-qr-code";

// Apex = production node page the phone opens.
const APEX_URL = "https://dnhacks-node.vercel.app";

// Wind + music sound externality demos (false-positive stress tests).
const WIND_YT_WATCH = "https://www.youtube.com/watch?v=sT5f1jBJHng";
const WIND_YT_EMBED = "https://www.youtube.com/embed/sT5f1jBJHng";
const MUSIC_YT_WATCH = "https://www.youtube.com/watch?v=kRqCxuF2bms";
const MUSIC_YT_EMBED = "https://www.youtube.com/embed/kRqCxuF2bms";

export default function TonePage() {
  const [spin, setSpin] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const droneRef = useRef<HTMLAudioElement | null>(null);
  const spinRef = useRef(false);
  const rotorsRef = useRef<THREE.Object3D[]>([]);

  // Keep the mutable spin flag in sync for the animation loop.
  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  // Three.js scene: procedural FPV quad, orbit drag, click = spin + sound.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
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

    // Alternative model: procedural cinewhoop-style FPV quad with prop
    // guards, orange canopy accents, and a front FPV camera. Built from
    // primitives so /tone works fully offline with zero GLB downloads.
    const carbon = new THREE.MeshStandardMaterial({
      color: 0x23272f,
      metalness: 0.55,
      roughness: 0.4,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: 0xf97316,
      metalness: 0.25,
      roughness: 0.45,
    });
    const darkPlastic = new THREE.MeshStandardMaterial({
      color: 0x111318,
      metalness: 0.2,
      roughness: 0.7,
    });
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0x9ca3af,
      metalness: 0.1,
      roughness: 0.5,
      transparent: true,
      opacity: 0.9,
    });

    // Central body: low slab + raised orange canopy.
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.34), carbon);
    drone.add(body);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), accent);
    canopy.scale.set(1, 0.55, 1.25);
    canopy.position.set(0, 0.06, -0.02);
    drone.add(canopy);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.305, 0.02, 0.06), accent);
    stripe.position.set(0, 0.01, 0.1);
    drone.add(stripe);

    // Front FPV camera eye.
    const camBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.04, 0.05, 20),
      darkPlastic,
    );
    camBarrel.rotation.x = Math.PI / 2;
    camBarrel.position.set(0, 0.01, 0.19);
    drone.add(camBarrel);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.022, 20),
      new THREE.MeshStandardMaterial({
        color: 0x0ea5e9,
        emissive: 0x0369a1,
        emissiveIntensity: 0.9,
        roughness: 0.2,
      }),
    );
    lens.position.set(0, 0.01, 0.216);
    drone.add(lens);

    // X arms, motors, guards, and 2-blade props.
    rotorsRef.current = [];
    const corners: Array<[number, number]> = [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    corners.forEach(([sx, sz], i) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.028, 0.05), carbon);
      arm.position.set(sx * 0.14, 0.01, sz * 0.14);
      arm.rotation.y = sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4;
      drone.add(arm);

      const mx = sx * 0.24;
      const mz = sz * 0.24;
      const motor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.032, 0.045, 16),
        darkPlastic,
      );
      motor.position.set(mx, 0.045, mz);
      drone.add(motor);
      const bell = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 0.02, 12),
        accent,
      );
      bell.position.set(mx, 0.07, mz);
      drone.add(bell);

      // Prop guard ring — the visual signature of this model.
      const guard = new THREE.Mesh(
        new THREE.TorusGeometry(0.125, 0.009, 10, 36),
        i < 2 ? accent : carbon,
      );
      guard.rotation.x = Math.PI / 2;
      guard.position.set(mx, 0.05, mz);
      drone.add(guard);
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), carbon);
      strut.position.set(mx + sx * 0.11, 0.025, mz);
      drone.add(strut);

      const prop = new THREE.Group();
      prop.position.set(mx, 0.085, mz);
      const bladeGeo = new THREE.BoxGeometry(0.21, 0.005, 0.024);
      const b1 = new THREE.Mesh(bladeGeo, bladeMat);
      const b2 = new THREE.Mesh(bladeGeo, bladeMat);
      b2.rotation.y = Math.PI / 2;
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.018, 10),
        darkPlastic,
      );
      prop.add(b1, b2, hub);
      drone.add(prop);
      rotorsRef.current.push(prop);

      // Status LED under each guard.
      const led = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 10, 8),
        new THREE.MeshStandardMaterial({
          color: sz > 0 ? 0x22c55e : 0xef4444,
          emissive: sz > 0 ? 0x16a34a : 0xdc2626,
          emissiveIntensity: 1.4,
        }),
      );
      led.position.set(mx, -0.035, mz);
      drone.add(led);
    });

    // Skids.
    [-0.1, 0.1].forEach((x) => {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, 0.12, 8),
        darkPlastic,
      );
      leg.position.set(x, -0.1, 0);
      drone.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.015, 0.16), darkPlastic);
      foot.position.set(x, -0.16, 0.01);
      drone.add(foot);
    });

    // Whole canvas is clickable via the container's onClick — no raycast
    // needed for the simplified UI.

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
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  const stop = () => {
    spinRef.current = false;
    setSpin(false);
    droneRef.current?.pause();
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
  };


  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        fontFamily: "-apple-system, sans-serif",
      }}
    >
      {/* LEFT: side panel (~25%) — all texts live here, single column */}
      <aside
        data-testid="side-panel"
        style={{
          flex: "0 0 25%",
          minWidth: 220,
          maxWidth: 320,
          borderRight: "1px solid #e5e7eb",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 20,
          fontSize: 13,
          color: "#374151",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Node</div>
          <div style={{ color: "#6b7280" }}>Scan to open node</div>
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Drone</div>
          <div data-testid="spin-state" style={{ color: spin ? "#16a34a" : "#6b7280" }}>
            {spin ? "● playing — click to stop" : "Click drone to play sound"}
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Wind sound externality (false-positive check)
          </div>
          <div style={{ color: "#6b7280", marginBottom: 6 }}>
            Play wind noise near the listening phone to simulate a windy-day
            externality. Expect the node to stay quiet (no false drone alarm).
          </div>
          <a
            href={WIND_YT_WATCH}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#2563eb" }}
          >
            Open on YouTube
          </a>
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Music sound externality (false-positive check)
          </div>
          <div style={{ color: "#6b7280", marginBottom: 6 }}>
            Play loud music near the listening phone to simulate a concert /
            street-noise externality. Expect the node to stay quiet (no false
            drone alarm).
          </div>
          <a
            href={MUSIC_YT_WATCH}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#2563eb" }}
          >
            Open on YouTube
          </a>
        </div>
      </aside>

      {/* RIGHT: visuals only, no texts */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
          padding: 24,
        }}
      >
        <QRCode value={APEX_URL} size={260} data-testid="apex-qr" />

        <div
          ref={mountRef}
          data-testid="drone-canvas"
          onClick={() => void toggleDrone()}
          style={{
            width: 420,
            maxWidth: "90vw",
            height: 340,
            cursor: "pointer",
            position: "relative",
          }}
        />

        <iframe
          data-testid="wind-embed"
          width="560"
          height="315"
          style={{ maxWidth: "90vw", borderRadius: 12, border: "1px solid #e5e7eb" }}
          src={WIND_YT_EMBED}
          title="Wind sound externality demo"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />

        <iframe
          data-testid="music-embed"
          width="560"
          height="315"
          style={{ maxWidth: "90vw", borderRadius: 12, border: "1px solid #e5e7eb" }}
          src={MUSIC_YT_EMBED}
          title="Music sound externality demo (My Bloody Valentine — New You)"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />

        <audio ref={droneRef} src="/drone-demo.wav" loop preload="auto" />
      </div>
    </main>
  );
}
