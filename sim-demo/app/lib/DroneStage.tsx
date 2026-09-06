// DroneStage.tsx — clickable 3D drone that plays real DADS audio.
//
// Extracted from station/page.tsx so the operator console can mount it in the
// sidebar. Self-contained: Three.js scene, sound tabs, play/stop, and the
// audio element. Only the drone clip spins the props — the wind/music embeds
// are externality tests and should look and sound like not-a-drone.
//
// The canvas sizing trap is documented inline: pin CSS to 100% and size from
// the mount, never from the canvas, or the ResizeObserver feedback loop grows
// the canvas to tens of millions of px on retina displays.
//
// Audio credit: Drone Audio Detection Samples (DADS, MIT).
// 3D credit: "Drone" by Silly Fear, CC-BY 3.0 via Poly Pizza.

"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const MODEL_SRC = "/models/drone-sillyfear.glb";

// Drone is the real thing (DADS clips). Wind and music are ml-demo's
// false-positive stress tests: play them loud and the CRNN should stay quiet,
// which is a more convincing demo than only ever showing it succeed.
const SOUNDS = [
  // drone-demo.wav, not drone-tone.wav: higher pitched, and the prop harmonics
  // sit where the CRNN is most confident.
  { id: "drone", label: "drone", kind: "audio", src: "/drone-demo.wav",
    note: "Real DADS drone audio. Detection should trip within about a second." },
  { id: "wind", label: "wind", kind: "embed", src: "https://www.youtube.com/embed/sT5f1jBJHng",
    note: "Externality test: broadband noise. Detection should stay quiet." },
  { id: "music", label: "music", kind: "embed", src: "https://www.youtube.com/embed/kRqCxuF2bms",
    note: "Externality test: music. Detection should stay quiet." },
] as const;

type SoundId = (typeof SOUNDS)[number]["id"];

export function DroneStage({ height = 240 }: { height?: number }) {
  const [spin, setSpin] = useState(false);
  const [sound, setSound] = useState<SoundId>("drone");
  const [modelError, setModelError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const spinRef = useRef(false);
  const rotorsRef = useRef<THREE.Object3D[]>([]);

  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 1.6, 4.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Pin the canvas to the box rather than letting it size the box. Without
    // this the canvas lays out at its *attribute* width (CSS px = w x dpr),
    // which grows the flex parent, which retriggers the ResizeObserver, which
    // grows it again — a doubling loop that reached 67 million px wide on a
    // retina display before WebGL gave up and rendered nothing. Invisible at
    // dpr 1, which is why headless testing missed it.
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
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
      // clientWidth of the mount, never of the canvas: reading the canvas back
      // is what closes the feedback loop.
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); // CSS size is fixed at 100% above
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

  const active = SOUNDS.find((s) => s.id === sound)!;

  function toggle() {
    // Only the drone clip spins the props — the externality tests are meant to
    // look and sound like something that is not a drone.
    if (active.kind !== "audio") return;
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

  function pick(id: SoundId) {
    const el = audioRef.current;
    el?.pause();
    if (el) el.currentTime = 0;
    setSpin(false);
    setSound(id);
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        ref={mountRef}
        onClick={toggle}
        title="click to play drone audio"
        style={{
          height,
          borderRadius: 8,
          overflow: "hidden",
          cursor: active.kind === "audio" ? "pointer" : "default",
          background: "radial-gradient(circle at 50% 40%, #16202c, #0b0f14)",
          border: "1px solid var(--line)",
        }}
      />
      <div className="row" style={{ gap: 4 }}>
        {SOUNDS.map((s) => (
          <button
            key={s.id}
            onClick={() => pick(s.id)}
            style={{
              flex: 1,
              borderColor: sound === s.id ? "var(--accent)" : undefined,
              color: sound === s.id ? "var(--accent)" : undefined,
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {active.kind === "audio" ? (
        <button
          className={spin ? "danger" : "primary"}
          style={{ fontSize: 15, padding: "10px 16px", width: "100%" }}
          onClick={toggle}
        >
          {spin ? "stop" : `play ${active.label}`}
        </button>
      ) : (
        <iframe
          key={active.id}
          src={active.src}
          title={active.label}
          allow="autoplay; encrypted-media"
          style={{ width: "100%", aspectRatio: "16 / 9", border: 0, borderRadius: 8 }}
        />
      )}

      <p className="dim" style={{ fontSize: 11, margin: 0 }}>
        {active.note} Volume up, speaker 10–30 cm from the phones.
      </p>
      {modelError && (
        <p style={{ color: "var(--warn)", fontSize: 11 }}>3D model failed: {modelError}</p>
      )}
      <audio ref={audioRef} src="/drone-demo.wav" preload="auto" />
    </div>
  );
}
