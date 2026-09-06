// station/page.tsx — the onboarding station, for the laptop screen.
//
// Same idea as ml-demo's /tone, pointed at the mesh: a QR that puts a phone on
// this session as a sensor node (left), and a clickable 3D drone that spins its
// props and plays real DADS audio (right) so every phone in the room hears a
// drone at once.
//
// The QR is the part that matters here. ml-demo's station links to a fixed apex
// URL because each phone is standalone; a mesh node has to land in *this*
// session on *this* host, so the link is built from the current origin and
// session at render time. Scan it from a phone, get admitted on /admin, done.
//
// Audio credit: Drone Audio Detection Samples (DADS, MIT).
// 3D credit: "Drone" by Silly Fear, CC-BY 3.0 via Poly Pizza — vendored from
// ml-demo by vendor-detector.mjs.

"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import QRCode from "react-qr-code";
import { sessionId } from "../lib/config.ts";

const MODEL_SRC = "/models/drone-sillyfear.glb";
const TONE_SRC = "/drone-tone.wav";

export default function StationPage() {
  const [spin, setSpin] = useState(false);
  const [joinUrl, setJoinUrl] = useState("");
  const [session, setSession] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const spinRef = useRef(false);
  const rotorsRef = useRef<THREE.Object3D[]>([]);

  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  // Built client-side: the QR has to carry this origin and session, and the
  // origin is whatever the phone can actually reach (a tunnel, usually).
  useEffect(() => {
    const s = sessionId();
    setSession(s);
    const u = new URL(window.location.origin);
    u.searchParams.set("session", s);
    setJoinUrl(u.toString());
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 1.6, 4.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x0b0f14, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(3, 6, 4);
    scene.add(key);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 2.5;
    controls.maxDistance = 8;

    const pivot = new THREE.Group();
    scene.add(pivot);

    new GLTFLoader().load(
      MODEL_SRC,
      (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = 2.6 / Math.max(size.x, size.y, size.z);
        model.scale.setScalar(scale);
        const centre = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
        model.position.sub(centre);
        pivot.add(model);

        // Visible two-blade props on shaft pivots — the GLB's own discs are
        // rotationally symmetric, so spinning them reads as motionless.
        const span = 2.6 * 0.34;
        const bladeGeo = new THREE.BoxGeometry(span * 0.95, 0.012, 0.07);
        const bladeMat = new THREE.MeshStandardMaterial({
          color: 0x9fd0ff,
          metalness: 0.1,
          roughness: 0.5,
        });
        for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          const rotor = new THREE.Group();
          rotor.position.set(dx * span, 0.16, dz * span);
          const a = new THREE.Mesh(bladeGeo, bladeMat);
          const b = new THREE.Mesh(bladeGeo, bladeMat);
          b.rotation.y = Math.PI / 2;
          rotor.add(a, b);
          pivot.add(rotor);
          rotorsRef.current.push(rotor);
        }
      },
      undefined,
      (e) => setModelError(String(e))
    );

    let raf = 0;
    let last = performance.now();
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    const loop = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      pivot.rotation.y += dt * 0.25;
      if (spinRef.current) {
        for (const r of rotorsRef.current) r.rotation.y += dt * 40;
      }
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      rotorsRef.current = [];
    };
  }, []);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (spin) {
      el.pause();
      el.currentTime = 0;
      setSpin(false);
    } else {
      el.loop = true;
      el.volume = 1;
      void el.play().catch(() => {});
      setSpin(true);
    }
  }

  return (
    <main style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
      <aside
        style={{
          width: "26%",
          minWidth: 280,
          padding: 24,
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20 }}>Join the mesh</h1>
          <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
            Scan to turn your phone into a sensor node. Detection runs on the device —
            audio never leaves it.
          </p>
        </div>

        <div style={{ background: "#fff", padding: 14, borderRadius: 10, alignSelf: "flex-start" }}>
          {joinUrl ? (
            <QRCode value={joinUrl} size={190} />
          ) : (
            <div style={{ width: 190, height: 190 }} />
          )}
        </div>

        <div className="dim" style={{ fontSize: 11, wordBreak: "break-all" }}>
          {joinUrl || "…"}
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          session <b style={{ color: "var(--text)" }}>{session || "…"}</b>
          <br />
          Admit new nodes on <a href={`/admin/?session=${session}`} style={{ color: "var(--accent)" }}>/admin</a>.
        </div>

        <div style={{ marginTop: "auto" }}>
          <button
            className={spin ? "danger" : "primary"}
            style={{ fontSize: 16, padding: "12px 20px", width: "100%" }}
            onClick={toggle}
          >
            {spin ? "stop drone" : "play drone"}
          </button>
          <p className="dim" style={{ fontSize: 11, marginTop: 8 }}>
            Real DADS drone audio. Volume up, hold the speaker 10–30 cm from the phones.
          </p>
          {modelError && (
            <p style={{ color: "var(--warn)", fontSize: 11 }}>3D model failed: {modelError}</p>
          )}
        </div>
      </aside>

      <div
        ref={mountRef}
        onClick={toggle}
        title="click to play drone audio"
        style={{ flex: 1, cursor: "pointer", background: "radial-gradient(circle at 50% 40%, #16202c, #0b0f14)" }}
      />
      <audio ref={audioRef} src={TONE_SRC} preload="auto" />
    </main>
  );
}
