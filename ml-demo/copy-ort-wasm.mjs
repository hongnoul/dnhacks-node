// copy-ort-wasm.mjs — vendor onnxruntime-web wasm into public/ort/ so the
// model runs same-origin (required for offline/airplane-mode demo).
// Runs at postinstall + prebuild.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dst = join(root, "public", "ort");
mkdirSync(dst, { recursive: true });

// Single-threaded SIMD build (+ its JSEP helper, which ORT probes for at
// runtime — a 404 there is harmless but noisy). numThreads=1 keeps it small.
const wanted = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];
for (const f of readdirSync(src)) {
  if (wanted.includes(f)) copyFileSync(join(src, f), join(dst, f));
}
console.log(`copied ${wanted.length} ORT runtime files -> public/ort/`);
