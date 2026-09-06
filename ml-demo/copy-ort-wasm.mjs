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

// ORT 1.18.0 is the last version shipping a SINGLE-THREADED SIMD build.
// 1.19+ is threaded-only: its wasm pre-allocates a 16 MB SharedArrayBuffer
// that iOS Safari cannot grow, so model load dies with
// "no available backend found. ERR: [wasm] RangeError: Out of memory".
// With numThreads=1 (no COOP/COEP on Vercel) ORT 1.18 loads
// ort-wasm-simd.wasm — plain (non-shared) memory that Safari can grow.
const wanted = [
  "ort-wasm-simd.wasm",
  "ort-wasm-simd-threaded.wasm",
];
for (const f of readdirSync(src)) {
  if (wanted.includes(f)) copyFileSync(join(src, f), join(dst, f));
}
console.log(`copied ${wanted.length} ORT runtime files -> public/ort/`);
