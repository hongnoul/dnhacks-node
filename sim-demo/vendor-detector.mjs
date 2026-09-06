// vendor-detector.mjs — pull the detection pipeline in from ml-demo.
//
// ml-demo owns the detector: the TS mel front end is bit-parity with the
// PyTorch reference, and the ORT pin (1.18.0, single-threaded SIMD) is the only
// build that survives iOS Safari. Copying rather than re-implementing keeps one
// source of truth; copying rather than cross-importing keeps sim-demo a
// standalone Next app.
//
// Runs at postinstall + prebuild.
import { copyFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const ml = join(root, "..", "ml-demo");

const files = [
  ["app/lib/mel.ts", "app/lib/vendor/mel.ts"],
  ["app/lib/detector.ts", "app/lib/vendor/detector.ts"],
  ["app/lib/audio.ts", "app/lib/vendor/audio.ts"],
  ["public/drone_crnn.onnx", "public/drone_crnn.onnx"],
  ["public/drone-demo.wav", "public/drone-demo.wav"],
  // Demo-station assets: the QR onboarding + clickable 3D drone (see /station).
  ["public/drone-tone.wav", "public/drone-tone.wav"],
  ["public/models/drone-sillyfear.glb", "public/models/drone-sillyfear.glb"],
];

mkdirSync(join(root, "app/lib/vendor"), { recursive: true });
mkdirSync(join(root, "public"), { recursive: true });
mkdirSync(join(root, "public/models"), { recursive: true });

let copied = 0;
for (const [from, to] of files) {
  const src = join(ml, from);
  if (!existsSync(src)) {
    console.warn(`  ! missing ${from} — is ml-demo checked out?`);
    continue;
  }
  copyFileSync(src, join(root, to));
  copied++;
}

// ORT wasm, same pin and same reasoning as ml-demo/copy-ort-wasm.mjs.
const ortSrc = join(root, "node_modules", "onnxruntime-web", "dist");
const ortDst = join(root, "public", "ort");
if (existsSync(ortSrc)) {
  mkdirSync(ortDst, { recursive: true });
  for (const f of readdirSync(ortSrc)) {
    if (f === "ort-wasm-simd.wasm" || f === "ort-wasm-simd-threaded.wasm") {
      copyFileSync(join(ortSrc, f), join(ortDst, f));
      copied++;
    }
  }
}
console.log(`vendored ${copied} files from ml-demo`);
