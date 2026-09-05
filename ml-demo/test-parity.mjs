// test-parity.mjs — prove the browser pipeline (mel.ts + drone_crnn.onnx via
// onnxruntime-web wasm) matches the Python reference (model.py + PyTorch) on
// real DADS clips. Runs in Node 24+ (native TS import). Usage:
//   node test-parity.mjs
// Requires server/.venv (for the Python reference) and server/testdata/*.wav.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const testdata = join(root, "server", "testdata");
const py = join(root, "server", ".venv", "bin", "python");

const { logMelSpectrogram, resampleTo16k, N_MELS, SR } = await import(
  "./app/lib/mel.ts"
);
const ort = await import("onnxruntime-web");

// --- load model from disk (no fetch in Node) ---
const modelBytes = readFileSync(join(root, "public", "drone_crnn.onnx"));
const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
  executionProviders: ["wasm"],
});

function readWav(path) {
  const buf = readFileSync(path);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF: " + path);
  // walk chunks to find fmt + data
  let off = 12;
  let sr = 0, nch = 1, bits = 16, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      nch = v.getUint16(off + 10, true);
      sr = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0 || bits !== 16) throw new Error("unsupported wav: " + path);
  const n = Math.floor(dataLen / 2 / nch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < nch; c++) acc += v.getInt16(dataOff + (i * nch + c) * 2, true);
    out[i] = acc / nch / 32768;
  }
  return { samples: out, sampleRate: sr };
}

async function scoreJs(samples, sampleRate) {
  let wave = resampleTo16k(samples, sampleRate);
  const W = SR, H = SR / 2;
  if (wave.length < W) {
    const p = new Float32Array(W);
    p.set(wave);
    wave = p;
  }
  let best = 0;
  for (let s = 0; s + W <= wave.length; s += H) {
    const raw = wave.subarray(s, s + W);
    let peak = 0;
    for (let i = 0; i < raw.length; i++) {
      const a = Math.abs(raw[i]);
      if (a > peak) peak = a;
    }
    if (peak < 0.005) continue;
    const g = 0.9 / peak;
    const chunk = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) chunk[i] = raw[i] * g;
    const { data, frames } = logMelSpectrogram(chunk);
    const t = new ort.Tensor("float32", data, [1, 1, N_MELS, frames]);
    const out = await session.run({ log_mel: t });
    const prob = 1 / (1 + Math.exp(-out.logit.data[0]));
    if (prob > best) best = prob;
  }
  return best;
}

// --- reference scores from Python in one shot ---
const wavs = existsSync(testdata)
  ? readdirSync(testdata).filter((f) => f.endsWith(".wav")).sort()
  : [];
if (!wavs.length) {
  console.error("no testdata wavs — skipping (refetch DADS samples to run)");
  process.exit(0);
}
const pyScript = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(root, "server"))})
from model import score_wav
files = json.load(open(${JSON.stringify(join(testdata, "..", "_parity_files.json"))}))
print(json.dumps({f: score_wav(f) for f in files}))
`;
const files = wavs.map((f) => join(testdata, f));
const fileList = join(testdata, "..", "_parity_files.json");
writeFileSync(fileList, JSON.stringify(files));
const ref = JSON.parse(
  execFileSync(py, ["-c", pyScript], { encoding: "utf8", timeout: 300_000 }).trim()
);
rmSync(fileList, { force: true });

// --- compare ---
let worst = 0;
let fail = 0;
for (const f of files) {
  const { samples, sampleRate } = readWav(f);
  const js = await scoreJs(samples, sampleRate);
  const p = ref[f];
  const diff = Math.abs(js - p);
  worst = Math.max(worst, diff);
  const ok = diff < 0.02;
  if (!ok) fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${f.split("/").pop().padEnd(16)} py=${p.toFixed(4)} js=${js.toFixed(4)} diff=${diff.toExponential(1)}`
  );
}
console.log(`\nworst diff: ${worst.toExponential(2)} — ${fail ? `${fail} FAILURES` : "all within 0.02"}`);
process.exit(fail ? 1 : 0);
