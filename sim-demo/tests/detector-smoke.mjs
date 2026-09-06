// detector-smoke.mjs — end-to-end check that the ml-demo CRNN really drives the
// mesh. Chromium synthesises the microphone from a WAV, so this exercises the
// whole path: fake mic → MicCapture → TS mel → ONNX CRNN → reading → gossip.
//
// Run:  node tests/detector-smoke.mjs   (relay + next dev must be running)

import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WAV = join(ROOT, "public", "drone-demo.wav");

const fail = [];
const ok = (m) => console.log("  ✔", m);
const bad = (m) => { fail.push(m); console.log("  ✖", m); };

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV}`,
  ],
});
const ctx = await browser.newContext({ permissions: ["microphone"] });
const errors = [];
ctx.on("weberror", (e) => errors.push(String(e.error())));

const S = "det" + (Date.now() % 10000);
const page = await ctx.newPage();
await page.goto(`${APP}/?session=${S}&node=n01`);
await page.getByRole("button", { name: /join the mesh/i }).click();

// Model fetch is ~6 MB on a cold cache.
await page.waitForFunction(() => /drone likelihood/i.test(document.body.innerText), { timeout: 60000 })
  .then(() => ok("CRNN loaded and mic opened")).catch(() => bad("detector never came up"));

const noMic = await page.evaluate(() => /Detector unavailable/.test(document.body.innerText));
if (noMic) bad("fake mic was rejected");

// Poll the on-screen likelihood while the drone WAV plays into the fake mic.
let peak = 0, peakSnr = null;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(700);
  const s = await page.evaluate(() => {
    const t = document.body.innerText;
    const p = t.match(/drone likelihood\s*([\d.]+)/i);
    const snr = t.match(/snr\s*(-?[\d.]+) dB/i);
    return { p: p ? +p[1] : null, snr: snr ? +snr[1] : null };
  });
  if (s.p !== null && s.p > peak) { peak = s.p; peakSnr = s.snr; }
  if (peak > 0.7) break;
}
console.log(`     peak p=${peak.toFixed(2)}  snr=${peakSnr === null ? "—" : peakSnr.toFixed(1) + " dB"}`);
peak > 0.5 ? ok(`CRNN fired on drone audio (p=${peak.toFixed(2)})`)
           : bad(`CRNN did not fire (peak p=${peak.toFixed(2)})`);
peakSnr !== null ? ok("level channel present alongside p (needed for range)")
                 : bad("no snr reported — fusion cannot localise");

const records = await page.evaluate(() => {
  const m = document.body.innerText.match(/(\d+) records held/);
  return m ? +m[1] : 0;
});
records > 0 ? ok(`readings reaching the log (${records} records)`) : bad("no records published");

if (errors.length) { console.log("\npage errors:"); errors.slice(0, 5).forEach((e) => console.log("   ", e.split("\n")[0])); }
await browser.close();
console.log(fail.length ? `\nFAILED (${fail.length})` : "\ndetector smoke passed");
process.exit(fail.length ? 1 : 0);
