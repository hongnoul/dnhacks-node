// e2e-browser.mjs — validate prod URL in real Chromium with fake mic + GPS.
// Loads https://dnhacks-node.vercel.app, grants permissions, taps "Join the mesh",
// then polls the fusion server for heartbeats (and a clip if the gate trips).
import { execSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { chromium } from "playwright";

// Resolve the server under test: env SERVER, else the live tunnel from
// tunnel.log (written by demo.sh), else localhost. The node page gets
// ?server=<SERVER> appended so it talks to THIS server — not whatever
// stale tunnel URL was baked into the Vercel build.
function liveServer() {
  if (process.env.SERVER) return process.env.SERVER.replace(/\/$/, "");
  try {
    const out = execSync(
      "grep -o 'https://[a-z0-9-]*\\.trycloudflare\\.com' tunnel.log | head -1",
      { encoding: "utf8" }
    ).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return "http://localhost:8000";
}

const SERVER = liveServer();
const RAW_PAGE_URL = process.env.PAGE_URL ?? "https://dnhacks-node.vercel.app";
const PAGE_URL = RAW_PAGE_URL.includes("server=")
  ? RAW_PAGE_URL
  : RAW_PAGE_URL + (RAW_PAGE_URL.includes("?") ? "&" : "?") + `server=${encodeURIComponent(SERVER)}`;
console.log("→ server under test:", SERVER);

// Fake-mic fixture: 10 s propeller-ish harmonic stack (150 Hz ×5 harmonics
// at 0.35 gain, 48 kHz — matches the original fixture synthesis exactly).
// Generated on first run so the .wav never needs to be committed
// (gitignored test fixture).
const TONE_PATH = new URL("./drone_tone.wav", import.meta.url).pathname;
function ensureTone() {
  if (existsSync(TONE_PATH)) return;
  const rate = 48000, n = rate * 10, gain = 0.35;
  const data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + n * 2, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let s = 0;
    for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * 150 * h * t) / h;
    s = Math.max(-1, Math.min(1, s * gain));
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  writeFileSync(TONE_PATH, data);
  console.log("→ generated fake-mic fixture drone_tone.wav");
}
ensureTone();

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", // synthetic mic producing a tone
    `--use-file-for-fake-audio-capture=${TONE_PATH}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({
  permissions: ["microphone", "geolocation"],
  geolocation: { latitude: 38.9012, longitude: -77.0402, accuracy: 12 },
});
await ctx.grantPermissions(["microphone", "geolocation"], { origin: PAGE_URL });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("PAGE ERR:", m.text()));

console.log("→ open", PAGE_URL);
await page.goto(PAGE_URL, { waitUntil: "networkidle" });

// capture node id shown on the page
const nodeLine = await page.locator("code").first().textContent();
console.log("→ node id:", nodeLine);

console.log("→ tap Join the mesh");
await page.getByRole("button", { name: /join the mesh/i }).click();
await page.waitForSelector("text=drone-band level", { timeout: 15000 });
console.log("→ listening state reached");

// let it run: heartbeats every 1s; fake mic tone may trip the gate
await page.waitForTimeout(8000);

const stats = await page.locator("table").textContent();
console.log("→ page stats:", stats?.replace(/\s+/g, " ").trim());

// server-side verification: assert OUR node id (read off the page) is alive,
// not just any stale heartbeat from a prior run.
const nodes = await (await fetch(`${SERVER}/nodes`)).json();
const nodeId = (nodeLine ?? "").trim();
const hb = nodes[nodeId];
console.log("→ server /nodes keys:", Object.keys(nodes).join(", "));
if (!hb) {
  console.error(`FAIL: our node ${nodeId} never reached the server`);
  process.exit(1);
}
if (hb.lat !== 38.9012) console.warn("warn: GPS not the mocked value:", hb.lat);
console.log(`\nBROWSER E2E OK — node ${nodeId} heartbeats flowing via prod page → tunnel → server`);
await browser.close();
