import * as THREE from "three";

// Blade/shaft pairs in drone-sillyfear.glb. Its vertices are baked in model
// space, so rotating a blade mesh directly would orbit the whole drone.
const ROTOR_PARTS = [
  ["group1301670615", "group1400634789"],
  ["group1326258638", "group1359119253"],
  ["group255131489", "group1208690003"],
  ["group1083488708", "group419559090"],
] as const;

/** Keep the original blades, with one animation pivot on each motor shaft. */
export function createDroneRotors(model: THREE.Object3D): THREE.Group[] {
  model.updateWorldMatrix(true, true);
  const worldToModel = model.matrixWorld.clone().invert();
  const boundsInModel = (mesh: THREE.Mesh) => {
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox!.clone().applyMatrix4(
      worldToModel.clone().multiply(mesh.matrixWorld)
    );
  };

  return ROTOR_PARTS.map(([bladeName, shaftName]) => {
    const blade = model.getObjectByName(bladeName);
    const shaft = model.getObjectByName(shaftName);
    if (!(blade instanceof THREE.Mesh) || !(shaft instanceof THREE.Mesh)) {
      throw new Error(`Missing drone rotor parts: ${bladeName}, ${shaftName}`);
    }

    const centre = boundsInModel(shaft).getCenter(new THREE.Vector3());
    centre.y = boundsInModel(blade).getCenter(new THREE.Vector3()).y;
    const rotor = new THREE.Group();
    rotor.name = `rotor-${shaftName}`;
    rotor.position.copy(centre);
    model.add(rotor);
    // Preserve the authored pose while changing the centre of rotation.
    rotor.attach(blade);
    return rotor;
  });
}
