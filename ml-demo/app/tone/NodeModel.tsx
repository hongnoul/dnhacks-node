"use client";

// Procedural 3D model of the dnhacks sensor node industrial design, derived
// from the latest reference photo: gray mesh-fabric dome with a dark glossy
// top cap, black rib cage (two crossing arch bands + rim band), black layered
// base puck, whip antenna, and four spike legs. three.js + orbit controls.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Woven acoustic-fabric texture painted on a canvas.
function fabricTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b9b9b6";
  ctx.fillRect(0, 0, 256, 256);
  // Fine weave: alternating light/dark dots.
  for (let y = 0; y < 256; y += 4) {
    for (let x = 0; x < 256; x += 4) {
      const v = 150 + Math.floor(Math.random() * 70);
      ctx.fillStyle = `rgb(${v},${v},${v - 3})`;
      ctx.fillRect(x + ((y / 4) % 2) * 2, y, 2, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildNode(): THREE.Group {
  const node = new THREE.Group();

  // --- Materials -----------------------------------------------------------
  const fabric = new THREE.MeshStandardMaterial({
    map: fabricTexture(),
    roughness: 0.95,
    metalness: 0.0,
  });
  const ribMatte = new THREE.MeshStandardMaterial({
    color: 0x141416,
    roughness: 0.9,
    metalness: 0.05,
  });
  const satinBlack = new THREE.MeshStandardMaterial({
    color: 0x1a1a1d,
    roughness: 0.55,
    metalness: 0.15,
  });
  const glossyCap = new THREE.MeshPhysicalMaterial({
    color: 0x0c0c0e,
    roughness: 0.12,
    metalness: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
  });

  // --- Base puck (layered 3D-print look) ----------------------------------
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.5, 0.16, 64),
    satinBlack,
  );
  base.position.y = 0.08;
  node.add(base);
  for (let i = 0; i < 3; i++) {
    const groove = new THREE.Mesh(
      new THREE.TorusGeometry(0.512, 0.004, 8, 64),
      ribMatte,
    );
    groove.rotation.x = Math.PI / 2;
    groove.position.y = 0.045 + i * 0.04;
    node.add(groove);
  }

  // --- Spike legs (4 cones pointing down) ---------------------------------
  const legGeo = new THREE.ConeGeometry(0.065, 0.34, 24);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(legGeo, satinBlack);
    leg.rotation.x = Math.PI;
    leg.position.set(Math.cos(a) * 0.36, -0.15, Math.sin(a) * 0.36);
    node.add(leg);
  }

  // --- Fabric mesh dome ----------------------------------------------------
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.47, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2),
    fabric,
  );
  dome.position.y = 0.17;
  node.add(dome);

  // --- Dark glossy top cap (electronics dome peeking above the fabric) ----
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.478, 64, 24, 0, Math.PI * 2, 0, 0.55),
    glossyCap,
  );
  cap.position.y = 0.175;
  node.add(cap);

  // --- Rib cage: two crossing arch bands over the dome ---------------------
  // Each band is a half-torus lying in a vertical plane, with a rectangular
  // cross-section feel (thick tube), like the foam-covered ribs in the photo.
  const mkArch = (rotY: number) => {
    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.045, 12, 64, Math.PI),
      ribMatte,
    );
    arch.position.y = 0.17;
    arch.rotation.y = rotY;
    arch.scale.z = 0.75; // flatten toward the dome surface
    return arch;
  };
  node.add(mkArch(0), mkArch(Math.PI / 2));

  // --- Rim band around the equator (clamps the fabric at the base) --------
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.505, 0.51, 0.1, 64, 1, true),
    ribMatte,
  );
  rim.position.y = 0.2;
  node.add(rim);

  // --- Whip antenna --------------------------------------------------------
  const antenna = new THREE.Group();
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.026, 0.5, 16),
    satinBlack,
  );
  mast.position.y = 0.25;
  antenna.add(mast);
  const cap2 = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.032, 0.05, 8, 16),
    satinBlack,
  );
  cap2.position.y = 0.53;
  antenna.add(cap2);
  antenna.position.set(0, 0.62, 0);
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

    // Studio-style lighting so the fabric and glossy cap read like the photo.
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
    // Soft overhead softbox reflection for the glossy cap highlight.
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
