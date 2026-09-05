// e2e-map.mjs — verify the live map renders nodes + track + alerts.
import { chromium } from "playwright";

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
