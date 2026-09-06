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
// 3D credit: "Drone" by Silly Fear, CC-BY 3.0 via Poly Pizza,
// https://poly.pizza/m/3Ae_y67lzvd (vendored in /public/models).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import QRCode from "react-qr-code";

// Apex = production node page the phone opens.
const APEX_URL = "https://dnhacks-node.vercel.app";
const MODEL_SRC = "/models/drone-sillyfear.glb";

// Wind + music sound externality demos (false-positive stress tests).
const WIND_YT_EMBED = "https://www.youtube.com/embed/sT5f1jBJHng";
const MUSIC_YT_EMBED = "https://www.youtube.com/embed/kRqCxuF2bms";

export default function TonePage() {
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

  // Three.js scene: Silly Fear Phantom-style drone, orbit drag, click = spin + sound.
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
    camera.position.set(0.55, 0.5, 0.7);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.2, 0);

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
        // Normalize: model spans roughly x [-0.4, 0.37], y [-0.3, 0.14],
        // z [-0.41, 0.28]. Center it and scale to ~0.7 units wide.
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 0.7 / maxDim;
        model.scale.setScalar(scale);
        model.position.sub(center.clone().multiplyScalar(scale));
        // Lift so landing skids sit just above y=0.
        const grounded = new THREE.Box3().setFromObject(model);
        model.position.y -= grounded.min.y;
        drone.add(model);
        // Propeller discs: 4 flat meshes (thin in Y, wide in X/Z) at the
        // corners. Detect by geometry: thin flat bounding boxes up high.
        rotorsRef.current = [];
        model.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          o.geometry.computeBoundingBox();
          const bb = o.geometry.boundingBox;
          if (!bb) return;
          const sx = bb.max.x - bb.min.x;
          const sy = bb.max.y - bb.min.y;
          const sz = bb.max.z - bb.min.z;
          const flat = sy < 0.02 && sx > 0.1 && sz > 0.1;
          if (flat) {
            // Wrap in a pivot at the disc center so it spins in place.
            // Parent to the (scaled) model so the clone inherits its scale.
            const pivot = new THREE.Group();
            const world = new THREE.Vector3();
            o.getWorldPosition(world);
            model.worldToLocal(world);
            pivot.position.copy(world);
            const clone = o.clone();
            clone.position.set(0, 0, 0);
            // Re-center blade geometry on the pivot.
            clone.geometry = o.geometry.clone();
            clone.geometry.computeBoundingBox();
            const c = clone.geometry.boundingBox!.getCenter(new THREE.Vector3());
            clone.geometry.translate(-c.x, 0, -c.z);
            o.visible = false;
            pivot.add(clone);
            model.add(pivot);
            rotorsRef.current.push(pivot);
          }
        });
        setReady(true);
      },
      undefined,
      (err: unknown) => {
        if (!disposed)
          setLoadError(err instanceof Error ? err.message : "failed to load drone.glb");
      },
    );

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
      disposed = true;
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
          alignItems: "stretch",
        }}
      >
        <QRCode value={APEX_URL} size={180} data-testid="apex-qr" />

        <div
          ref={mountRef}
          data-testid="drone-canvas"
          onClick={() => void toggleDrone()}
          style={{
            width: "100%",
            aspectRatio: "4 / 3",
            cursor: "pointer",
            position: "relative",
            borderRadius: 12,
            border: spin ? "2px solid #16a34a" : "2px solid transparent",
          }}
        >
          {!ready && !loadError && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#9ca3af",
                fontSize: 13,
              }}
            >
              Loading…
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
              }}
            >
              3D failed to load
            </div>
          )}
        </div>

        <iframe
          data-testid="wind-embed"
          width="100%"
          height="180"
          style={{ borderRadius: 12, border: "1px solid #e5e7eb" }}
          src={WIND_YT_EMBED}
          title="Wind sound externality demo"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />

        <iframe
          data-testid="music-embed"
          width="100%"
          height="180"
          style={{ borderRadius: 12, border: "1px solid #e5e7eb" }}
          src={MUSIC_YT_EMBED}
          title="Music sound externality demo"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />

        <audio ref={droneRef} src="/drone-demo.wav" loop preload="auto" />
      </aside>

      <div style={{ flex: 1 }} />
    </main>
  );
}
