// e2e-browser.mjs — validate prod URL in real Chromium with fake mic + GPS.
// Loads https://dnhacks-node.vercel.app, grants permissions, taps "Join the mesh",
// then polls the fusion server for heartbeats (and a clip if the gate trips).
import { chromium } from "playwright";

const PAGE_URL = process.env.PAGE_URL ?? "https://dnhacks-node.vercel.app";
const SERVER = process.env.SERVER ?? "http://localhost:8000";

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

// server-side verification
const nodes = await (await fetch(`${SERVER}/nodes`)).json();
const phoneNodes = Object.entries(nodes).filter(([id]) => id !== "fake01");
console.log("→ server /nodes (non-fake):", JSON.stringify(phoneNodes, null, 1).slice(0, 500));

if (phoneNodes.length === 0) {
  console.error("FAIL: no browser-node heartbeat reached the server");
  process.exit(1);
}
const [id, hb] = phoneNodes[0];
if (hb.lat !== 38.9012) console.warn("warn: GPS not the mocked value:", hb.lat);
console.log(`\nBROWSER E2E OK — node ${id} heartbeats flowing via prod page → tunnel → server`);
await browser.close();
