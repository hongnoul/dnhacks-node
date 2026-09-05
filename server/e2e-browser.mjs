// e2e-browser.mjs — validate prod URL in real Chromium with fake mic + GPS.
// Loads https://dnhacks-node.vercel.app, grants permissions, taps "Join the mesh",
// then polls the fusion server for heartbeats (and a clip if the gate trips).
import { execSync } from "child_process";
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

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", // synthetic mic producing a tone
    `--use-file-for-fake-audio-capture=${new URL("./drone_tone.wav", import.meta.url).pathname}`,
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
