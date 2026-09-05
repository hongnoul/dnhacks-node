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

// Single-threaded SIMD build only — numThreads=1, keeps the payload small.
const wanted = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];
for (const f of readdirSync(src)) {
  if (wanted.includes(f)) copyFileSync(join(src, f), join(dst, f));
}
console.log(`copied ${wanted.length} ORT runtime files -> public/ort/`);
