import { execSync } from "child_process";
import { chromium } from "playwright";

// Resolve the live tunnel URL from tunnel.log (written by demo.sh),
// overridable via TUNNEL env. The old hardcoded URL rotted every restart.
function liveTunnel() {
  if (process.env.TUNNEL) return process.env.TUNNEL.replace(/\/$/, "");
  try {
    const out = execSync(
      "grep -o 'https://[a-z0-9-]*\\.trycloudflare\\.com' tunnel.log | head -1",
      { encoding: "utf8" }
    ).trim();
    if (out) return out;
  } catch { /* fall through */ }
  throw new Error("no live tunnel URL: run ./demo.sh first or set TUNNEL=");
}

const TUNNEL = liveTunnel();

// Self-seed a fresh track: the map only badges tracks <15 s old, so replay
// the demo session first (falls back to sim_fusion if no session saved).
async function ensureFreshTrack() {
  try {
    const r = await fetch("http://localhost:8000/replay/start?session=demo1&speed=8", { method: "POST" });
    if (r.ok) { await new Promise((res) => setTimeout(res, 5000)); return; }
  } catch { /* fall through to sim seed */ }
  const { execSync: ex } = await import("child_process");
  ex(".venv/bin/python sim_fusion.py > /dev/null 2>&1", { timeout: 120000 });
}
await ensureFreshTrack();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${TUNNEL}/map`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
const nNodes = await page.textContent("#n-nodes");
const track = await page.locator(".track-badge").count();
console.log(`tunnel map (${TUNNEL}): nodes=${nNodes} trackBadge=${track} jsErrors=${errors.length}`);
await page.screenshot({ path: "map-tunnel.png" });
const ok = Number(nNodes) >= 4 && track === 1 && errors.length === 0;
console.log(ok ? "TUNNEL MAP OK" : "TUNNEL MAP FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
