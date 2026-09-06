import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createDroneRotors } from "../app/lib/droneRotors.ts";

async function loadDrone() {
  const bytes = await readFile(new URL("../public/models/drone-sillyfear.glb", import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ""
  );
  return gltf.scene;
}

function vertices(mesh: THREE.Mesh) {
  mesh.updateWorldMatrix(true, false);
  const positions = mesh.geometry.getAttribute("position");
  return Array.from({ length: positions.count }, (_, index) =>
    new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld)
  );
}

test("rotor pivots preserve every original mesh and blade vertex without adding duplicate props", async () => {
  const model = await loadDrone();
  const original = new Map<THREE.Mesh, THREE.Vector3[]>();
  model.traverse(part => {
    if (part instanceof THREE.Mesh) original.set(part, vertices(part));
  });
  const rotors = createDroneRotors(model);
  assert.equal(rotors.length, 4);
  assert.equal(new Set(rotors.map(rotor => rotor.children[0])).size, 4);
  let meshCount = 0;
  model.traverse(part => {
    if (!(part instanceof THREE.Mesh)) return;
    meshCount++;
    const before = original.get(part);
    assert(before, "Only the asset's original meshes should be rendered");
    vertices(part).forEach((vertex, index) => {
      assert(vertex.distanceTo(before[index]) < 1e-6, "Reparenting must not move the blades");
    });
  });
  assert.equal(meshCount, original.size);
});

test("all four propellers spin on their motor shafts after scene normalization", async () => {
  const model = await loadDrone();
  const rotors = createDroneRotors(model);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = 2.6 / Math.max(size.x, size.y, size.z);
  model.scale.setScalar(scale);
  model.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(scale));
  const pivot = new THREE.Group();
  pivot.add(model);
  pivot.rotation.y = 0.7;
  pivot.updateWorldMatrix(true, true);

  const shafts = ["group1400634789", "group1359119253", "group1208690003", "group419559090"];
  rotors.forEach((rotor, index) => {
    const shaft = model.getObjectByName(shafts[index])!;
    const blade = rotor.children[0] as THREE.Mesh;
    const shaftBox = new THREE.Box3().setFromObject(shaft);
    const shaftCentre = shaftBox.getCenter(new THREE.Vector3());
    const centre = rotor.getWorldPosition(new THREE.Vector3());
    assert(Math.abs(centre.x - shaftCentre.x) < 1e-6);
    assert(Math.abs(centre.z - shaftCentre.z) < 1e-6);
    assert(centre.y >= shaftBox.min.y && centre.y <= shaftBox.max.y);
    const original = vertices(blade);
    for (const angle of [Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI]) {
      rotor.rotation.y = angle;
      assert(rotor.getWorldPosition(new THREE.Vector3()).distanceTo(centre) < 1e-6);
      const rotated = vertices(blade);
      rotated.forEach((vertex, i) => {
        assert(Math.abs(vertex.y - original[i].y) < 1e-6);
        assert(Math.abs(vertex.distanceTo(centre) - original[i].distanceTo(centre)) < 1e-6);
      });
      if (angle === Math.PI / 2) {
        assert(rotated.some((vertex, i) => vertex.distanceTo(original[i]) > 0.1), "The original blades must visibly spin");
      }
      if (angle === 2 * Math.PI) {
        rotated.forEach((vertex, i) => assert(vertex.distanceTo(original[i]) < 1e-6));
      }
    }
  });
});
