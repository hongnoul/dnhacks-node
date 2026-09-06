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
import NodeModel from "./NodeModel";

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
        // Propellers: the GLB's own discs are radially symmetric opaque
        // slabs, so spinning them is invisible. Instead: hide the discs,
        // keep the spinner cones on their pivots, and add visible 2-blade
        // props (dark blades + red tips) that spin around each motor shaft.
        const discs: THREE.Mesh[] = [];
        const shafts: THREE.Mesh[] = [];
        model.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          o.geometry.computeBoundingBox();
          const bb = o.geometry.boundingBox;
          if (!bb) return;
          const sx = bb.max.x - bb.min.x;
          const sy = bb.max.y - bb.min.y;
          const sz = bb.max.z - bb.min.z;
          if (bb.min.y > 0.09 && sy < 0.02 && sx > 0.15 && sz > 0.15) discs.push(o);
          else if (bb.min.y > 0.09 && sy < 0.05 && sx < 0.05 && sz < 0.05)
            shafts.push(o);
        });
        const bladeMat = new THREE.MeshStandardMaterial({
          color: 0x1f2937,
          roughness: 0.5,
          metalness: 0.2,
        });
        const tipMat = new THREE.MeshStandardMaterial({
          color: 0xef4444,
          roughness: 0.5,
          metalness: 0.1,
        });
        rotorsRef.current = [];
        discs.forEach((disc) => {
          // Spin axis = nearest motor shaft; fall back to the disc center.
          const dc = disc.geometry.boundingBox!.getCenter(new THREE.Vector3());
          let axis = dc;
          let bestShaft: THREE.Mesh | null = null;
          let best = Infinity;
          shafts.forEach((shaft) => {
            const c = shaft.geometry.boundingBox!.getCenter(new THREE.Vector3());
            const d = (c.x - dc.x) ** 2 + (c.z - dc.z) ** 2;
            if (d < best) {
              best = d;
              bestShaft = shaft;
              axis = c;
            }
          });
          if (bestShaft) shafts.splice(shafts.indexOf(bestShaft), 1);
          disc.visible = false;
          // Prop radius from the disc extent (~0.16 half-width).
          const radius =
            Math.max(
              disc.geometry.boundingBox!.max.x - disc.geometry.boundingBox!.min.x,
              disc.geometry.boundingBox!.max.z - disc.geometry.boundingBox!.min.z,
            ) / 2;
          const pivot = new THREE.Group();
          pivot.position.set(axis.x, axis.y + 0.005, axis.z);
          const bladeLen = radius * 0.92;
          const bladeW = 0.035;
          const bladeT = 0.006;
          for (let b = 0; b < 2; b++) {
            const blade = new THREE.Group();
            const inner = new THREE.Mesh(
              new THREE.BoxGeometry(bladeLen - 0.05, bladeT, bladeW),
              bladeMat,
            );
            inner.position.x = 0.025 + (bladeLen - 0.05) / 2;
            const tip = new THREE.Mesh(new THREE.BoxGeometry(0.05, bladeT, bladeW), tipMat);
            tip.position.x = bladeLen - 0.025 + 0.025;
            blade.add(inner, tip);
            blade.rotation.y = b * Math.PI;
            // Slight pitch so blades catch the light while spinning.
            blade.rotation.z = 0.06;
            pivot.add(blade);
          }
          const hub = new THREE.Mesh(
            new THREE.CylinderGeometry(0.014, 0.014, 0.02, 10),
            bladeMat,
          );
          pivot.add(hub);
          if (bestShaft) {
            // Keep the original spinner cone centered on the pivot.
            const cone: THREE.Mesh = bestShaft;
            cone.geometry = cone.geometry.clone();
            cone.geometry.translate(-axis.x, -axis.y, -axis.z);
            pivot.add(cone);
          }
          model.add(pivot);
          rotorsRef.current.push(pivot);
        });
        if (rotorsRef.current.length !== 4)
          console.warn(`tone: expected 4 propellers, found ${rotorsRef.current.length}`);
        (window as unknown as { __rotorCount?: number }).__rotorCount =
          rotorsRef.current.length;
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

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: 20,
          gap: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, color: "#111827" }}>
          Sensor node — industrial design
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>
          Procedural 3D model built from the front view of the design photo.
          Drag to orbit, scroll to zoom.
        </p>
        <div style={{ flex: 1, minHeight: 0, borderRadius: 12, background: "#f3f4f6" }}>
          <NodeModel />
        </div>
      </div>
    </main>
  );
}
