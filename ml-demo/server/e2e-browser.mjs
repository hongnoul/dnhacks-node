// e2e-browser.mjs — validate the on-device pipeline in real Chromium.
// Fake mic loops REAL drone audio (testdata/l1_*.wav, DADS clips that score
// ~1.0 on the CRNN); the page must load the ONNX model, run the CRNN locally,
// and show a rising drone confidence — with NO server and NO geolocation
// (offline-capable architecture).
// Usage: node e2e-browser.mjs            (against local `next dev`, default)
//        PAGE_URL=https://... node e2e-browser.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { chromium } from "playwright";

const PAGE_URL = process.env.PAGE_URL ?? "http://localhost:3000";

// Fake-mic fixture: loop real drone clips into a 10 s 48 kHz mono WAV.
// Pure sine stacks score ~0.001 on the CRNN (it learned real prop noise, not
// tones), so the e2e must feed audio the model actually fires on. Generated
// on first run — gitignored fixture.
const TONE_PATH = new URL("./drone_tone.wav", import.meta.url).pathname;
function readMono16(path) {
  const buf = readFileSync(path);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, sr = 16000, nch = 1, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      nch = v.getUint16(off + 10, true);
      sr = v.getUint32(off + 12, true);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(dataLen / 2 / nch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < nch; c++) acc += v.getInt16(dataOff + (i * nch + c) * 2, true);
    out[i] = acc / nch / 32768;
  }
  return { samples: out, sampleRate: sr };
}
function ensureTone() {
  // NOTE: regenerates only when missing. A stale sine-stack fixture from an
  // older run scores ~0.001 on the CRNN and fails the ≥0.80 assert — delete
  // server/drone_tone.wav and re-run if the e2e suddenly stops detecting.
  if (existsSync(TONE_PATH)) return;
  const dir = new URL("./testdata/", import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.startsWith("l1_") && f.endsWith(".wav")).sort();
  if (!files.length) throw new Error("no l1 drone clips in testdata/");
  // Concatenate + resample (nearest) to 48 kHz, loop to 10 s
  let mono = [];
  for (const f of files) {
    const { samples, sampleRate } = readMono16(dir + f);
    const step = sampleRate / 48000;
    for (let i = 0; i * step < samples.length; i++) mono.push(samples[Math.floor(i * step)]);
  }
  const rate = 48000, n = rate * 10;
  const loop = new Float32Array(n);
  for (let i = 0; i < n; i++) loop[i] = mono[i % mono.length];
  const data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + n * 2, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, loop[i]));
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  writeFileSync(TONE_PATH, data);
  console.log("→ generated fake-mic fixture drone_tone.wav from", files.length, "drone clips");
}
ensureTone();

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${TONE_PATH}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
// Deliberately: microphone ONLY. No geolocation — the app must never ask.
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("PAGE ERR:", m.text()));

// Fail if the app ever touches geolocation.
await page.addInitScript(() => {
  if (navigator.geolocation) {
    for (const fn of ["getCurrentPosition", "watchPosition"]) {
      navigator.geolocation[fn] = () => {
        console.error("E2E VIOLATION: geolocation." + fn + " called");
      };
    }
  }
});
let geoViolation = false;
page.on("console", (m) => {
  if (m.text().includes("E2E VIOLATION")) geoViolation = true;
});

console.log("→ open", PAGE_URL);
await page.goto(PAGE_URL, { waitUntil: "networkidle" });

const nodeLine = await page.locator("code").first().textContent();
console.log("→ node id:", nodeLine);

console.log("→ tap Start listening");
await page.getByRole("button", { name: /start listening/i }).click();

// Model load (6 MB) + mic start
await page.waitForSelector("text=drone confidence", { timeout: 60000 });
console.log("→ listening state reached (model loaded, mic live)");

// Poll the confidence readout: real drone audio must push the CRNN to ~1.0.
// (Threshold 0.80: l1 clips score 1.0000 in Python; the looped fixture is the
// same bytes, so anything much lower means the browser pipeline diverged.)
const deadline = Date.now() + 20000;
let best = 0;
while (Date.now() < deadline) {
  await page.waitForTimeout(500);
  const txt = await page.locator("text=peak confidence").locator("xpath=..").textContent();
  const m = txt?.match(/(\d+)%/);
  if (m) best = Math.max(best, parseInt(m[1], 10) / 100);
  if (best >= 0.8) break;
}
console.log("→ peak on-device confidence:", best.toFixed(2));

// Inference latency shown = proof it actually ran locally
const inferRow = await page.locator("text=inference").locator("xpath=..").textContent();
console.log("→", inferRow?.replace(/\s+/g, " ").trim());

await browser.close();

if (geoViolation) {
  console.error("FAIL: app called geolocation — must be location-free");
  process.exit(1);
}
if (best < 0.8) {
  console.error(`FAIL: confidence never rose above 0.80 (best ${best.toFixed(2)})`);
  process.exit(1);
}
if (!/\d+ ms on-device/.test(inferRow ?? "")) {
  console.error("FAIL: no on-device inference latency shown");
  process.exit(1);
}
console.log(`\nBROWSER E2E OK — on-device CRNN detected the drone audio (peak ${best.toFixed(2)}), zero server, zero location`);
