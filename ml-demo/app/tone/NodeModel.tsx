"use client";

// Procedural 3D model of the dnhacks sensor node industrial design,
// modeled from the front view of the reference photo (black glossy dome,
// matte rim shroud, twin barrel sensor ports, whip antenna, cylindrical
// base and spike legs). Rendered with three.js + orbit controls.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

function buildNode(): THREE.Group {
  const node = new THREE.Group();

  // --- Materials -----------------------------------------------------------
  const glossyDome = new THREE.MeshPhysicalMaterial({
    color: 0x0a0a0c,
    roughness: 0.12,
    metalness: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
  });
  const matteShell = new THREE.MeshStandardMaterial({
    color: 0x141416,
    roughness: 0.92,
    metalness: 0.05,
  });
  const satinPlastic = new THREE.MeshStandardMaterial({
    color: 0x1a1a1d,
    roughness: 0.55,
    metalness: 0.15,
  });
  const barrelMetal = new THREE.MeshStandardMaterial({
    color: 0x1c1c20,
    roughness: 0.3,
    metalness: 0.7,
  });
  const lensDark = new THREE.MeshPhysicalMaterial({
    color: 0x050506,
    roughness: 0.05,
    metalness: 0.2,
    clearcoat: 1.0,
  });

  // --- Base disc (layered, like the 3D-printed puck in the photo) ---------
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.5, 0.16, 64),
    satinPlastic,
  );
  base.position.y = 0.08;
  node.add(base);
  // Print-layer grooves: thin darker rings.
  for (let i = 0; i < 3; i++) {
    const groove = new THREE.Mesh(
      new THREE.TorusGeometry(0.512, 0.004, 8, 64),
      matteShell,
    );
    groove.rotation.x = Math.PI / 2;
    groove.position.y = 0.045 + i * 0.04;
    node.add(groove);
  }

  // --- Spike legs (4 cones pointing down) ---------------------------------
  const legGeo = new THREE.ConeGeometry(0.065, 0.34, 24);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(legGeo, satinPlastic);
    leg.rotation.x = Math.PI; // point down
    leg.position.set(Math.cos(a) * 0.36, -0.15, Math.sin(a) * 0.36);
    node.add(leg);
  }

  // --- Matte rim shroud (the foam-textured ring behind the dome) ----------
  const shroud = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2),
    matteShell,
  );
  shroud.position.y = 0.16;
  shroud.scale.set(1.06, 1.0, 1.06);
  node.add(shroud);

  // --- Glossy dome ---------------------------------------------------------
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.48, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2),
    glossyDome,
  );
  dome.position.y = 0.17;
  node.add(dome);

  // --- Twin barrel sensor ports (angled out from dome front) --------------
  const mkPort = (side: number) => {
    const port = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.095, 0.16, 32),
      barrelMetal,
    );
    barrel.rotation.x = Math.PI / 2;
    port.add(barrel);
    // Knurled collar ridges.
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.088, 0.006, 8, 32),
        satinPlastic,
      );
      ring.position.z = 0.02 + i * 0.045;
      port.add(ring);
    }
    // Recessed lens/mic opening.
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.02, 32),
      lensDark,
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.07;
    port.add(lens);
    // Place on dome surface, low-front, angled outward like the photo.
    const yaw = side * 0.42; // splay left/right
    const pitch = -0.12; // slightly below equator-facing
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    );
    port.position
      .copy(dir)
      .multiplyScalar(0.47)
      .add(new THREE.Vector3(0, 0.4, 0));
    port.lookAt(port.position.clone().add(dir));
    return port;
  };
  node.add(mkPort(-1), mkPort(1));

  // --- Whip antenna --------------------------------------------------------
  const antenna = new THREE.Group();
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, 0.55, 16),
    satinPlastic,
  );
  mast.position.y = 0.275;
  antenna.add(mast);
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.05, 16),
    barrelMetal,
  );
  collar.position.y = 0.5;
  antenna.add(collar);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), satinPlastic);
  cap.position.y = 0.55;
  antenna.add(cap);
  antenna.position.set(0, 0.62, -0.05);
  antenna.rotation.z = -0.06; // slight lean like the photo
  node.add(antenna);

  return node;
}

export default function NodeModel() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let raf = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const size = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      return { w, h };
    };
    const { w, h } = size();
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, w / h, 0.01, 100);
    // Front view to match the reference photo.
    camera.position.set(0, 0.5, 2.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.35, 0);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.8;

    // Studio-style lighting so the glossy dome reads like the photo.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.0);
    key.position.set(2, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xdbeafe, 1.6);
    rim.position.set(-3, 2, -2);
    scene.add(rim);
    const front = new THREE.PointLight(0xffffff, 3.0, 12);
    front.position.set(0.5, 1.4, 2.5);
    scene.add(front);
    // Soft overhead softbox reflection for the glossy dome highlight.
    const soft = new THREE.RectAreaLight(0xffffff, 3.0, 3, 2);
    soft.position.set(0, 3, 1);
    soft.lookAt(0, 0.4, 0);
    scene.add(soft);

    const model = buildNode();
    scene.add(model);
    setReady(true);

    const tick = () => {
      raf = requestAnimationFrame(tick);
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

  return (
    <div
      ref={mountRef}
      data-testid="node-canvas"
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      {!ready && (
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
    </div>
  );
}
