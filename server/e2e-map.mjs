import { chromium } from "playwright";

// e2e-map.mjs — verify the live map renders nodes + track + alerts.
// Self-seeding: posts fresh heartbeats + a replay trigger first, so the
// test never depends on stale log state from a prior run.
const SERVER = process.env.SERVER ?? "http://localhost:8000";

async function seed() {
  const nodes = [
    ["e2e-n1", 38.9021, -77.0402],
    ["e2e-n2", 38.9003, -77.0402],
    ["e2e-n3", 38.9012, -77.039],
    ["e2e-n4", 38.9012, -77.0414],
  ];
  for (const [node_id, lat, lon] of nodes) {
    await fetch(`${SERVER}/ingest/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "heartbeat", node_id, t: Date.now() / 1000, lat, lon, loudness: 0.5, gps_accuracy_m: 5 }),
    });
  }
  // fresh track via replay (rebases timestamps to now)
  await fetch(`${SERVER}/replay/start?session=demo1&speed=8`, { method: "POST" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
}
await seed();

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://localhost:8000/map", { waitUntil: "networkidle" });
await page.waitForTimeout(2500); // two polls

const nNodes = await page.textContent("#n-nodes");
const model = await page.textContent("#model");
const trackBadge = await page.locator(".track-badge").count();
const alerts = await page.locator(".alert").count();
const confirmed = await page.locator(".alert.confirmed").count();
const rejected = await page.locator(".alert.rejected").count();
const droneDrawn = await page.evaluate(() =>
  document.querySelectorAll("path.leaflet-interactive").length
);

console.log(`live nodes: ${nNodes}`);
console.log(`model: ${model}`);
console.log(`track badge: ${trackBadge}`);
console.log(`alerts: ${alerts} (confirmed ${confirmed}, rejected ${rejected})`);
console.log(`leaflet vector layers drawn: ${droneDrawn}`);
console.log(`js errors: ${errors.length ? errors.join("; ") : "none"}`);

await page.screenshot({ path: "map-screenshot.png" });
console.log("screenshot: server/map-screenshot.png");

const ok =
  Number(nNodes) >= 4 && model === "loaded" && trackBadge === 1 &&
  alerts > 0 && confirmed > 0 && rejected > 0 && droneDrawn >= 6 && errors.length === 0;
console.log(ok ? "\nMAP E2E OK" : "\nMAP E2E FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
