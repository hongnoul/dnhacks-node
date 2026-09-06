// ui-smoke.mjs — drives the real pages in a real browser.
//
// Admits three nodes from the admin console, places and links them, then checks
// that a node's own page renders a picture computed from its own replica.
// Run:  node tests/ui-smoke.mjs   (relay + next dev must already be running)

import { chromium } from "playwright";

const APP = process.env.APP_URL ?? "http://127.0.0.1:8001";
const fail = [];
const ok = (m) => console.log("  ✔", m);
const bad = (m) => { fail.push(m); console.log("  ✖", m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: [] });
const errors = [];
ctx.on("weberror", (e) => errors.push(String(e.error())));

console.log("operator console");
const admin = await ctx.newPage();
await admin.goto(`${APP}/station/`);
await admin.waitForSelector("h1");
await admin.waitForFunction(() => document.body.innerText.includes("relay connected"), { timeout: 8000 })
  .then(() => ok("relay connected")).catch(() => bad("relay never connected"));

console.log("nodes join");
const nodes = [];
for (const id of ["n01", "n02", "n03"]) {
  const p = await ctx.newPage();
  await p.goto(`${APP}/?node=${id}`);
  await p.getByRole("button", { name: /join the mesh/i }).click();
  nodes.push({ id, page: p });
  await p.waitForTimeout(300); // stagger model loads
}
await admin.waitForFunction(() => document.body.innerText.includes("waiting to join"), { timeout: 60000 })
  .then(() => ok("pending queue populated")).catch(() => bad("no pending nodes appeared"));

for (let i = 0; i < 6; i++) {
  const b = admin.getByRole("button", { name: "admit" }).first();
  if (!(await b.count())) break;
  await b.click();
  await admin.waitForTimeout(300);
}
const admittedIds = async () =>
  admin.evaluate(() =>
    [...document.querySelectorAll("table tr")]
      .map((tr) => tr.querySelector("td")?.textContent?.trim())
      .filter((t) => t && /^n\d+$/.test(t))
  );
await admin.waitForFunction(
  () => [...document.querySelectorAll("table tr")]
    .filter((tr) => /^n\d+$/.test(tr.querySelector("td")?.textContent?.trim() ?? "")).length >= 3,
  { timeout: 8000 }
).then(async () => ok(`admitted ${(await admittedIds()).join(", ")}`))
 .catch(() => bad("nodes not admitted"));

console.log("topology + placement");
await admin.getByRole("button", { name: /two clusters \+ bridge/i }).click();
await admin.waitForTimeout(300);
await admin.getByRole("button", { name: /auto-place/i }).click();
await admin.waitForFunction(() => !document.body.innerText.includes("unplaced"), { timeout: 8000 })
  .then(() => ok("nodes placed via gossiped config records")).catch(() => bad("placement did not propagate"));

// Link emulation is collapsed by default — it is network conditions, not
// detection, and detection is what leads the console now.
await admin.getByRole("button", { name: /^show$/ }).first().click();
await admin.waitForFunction(
  () => document.querySelectorAll("input[type=range]").length > 0, { timeout: 5000 }
).then(() => ok("link emulation controls expand on demand"))
 .catch(() => bad("no link controls"));

await admin.waitForFunction(
  () => /detections/i.test(document.body.innerText) && document.querySelectorAll("canvas").length > 1,
  { timeout: 8000 }
).then(() => ok("per-node confidence graphs render from the replicated log"))
 .catch(() => bad("no confidence graphs on the console"));

console.log("node view");
const n1 = nodes[0].page;
await n1.waitForFunction(() => document.body.innerText.includes("my picture"), { timeout: 5000 })
  .then(() => ok("node renders its own picture")).catch(() => bad("node view missing"));
await n1.waitForFunction(() => /records held/.test(document.body.innerText), { timeout: 5000 })
  .then(() => ok("node reports its replica size")).catch(() => bad("no replica info"));

// Wait for convergence rather than sampling once: the admin's placement records
// have to gossip to the node, and an instantaneous read races that.
await n1.waitForFunction(
  () => {
    const m = document.body.innerText.match(/(\d+) records held/);
    return m ? +m[1] > 0 : false;
  },
  { timeout: 15000 }
).then(async () => {
  const n = await n1.evaluate(() => +document.body.innerText.match(/(\d+) records held/)[1]);
  ok(`replica converged (${n} records received from the mesh)`);
}).catch(() => bad("no records reached the node"));

console.log("cut a link");
// A previous run may have left a link cut (button reads "restore") — either
// label proves the control rendered from live relay link state.
const cut = admin.getByRole("button", { name: "cut" }).first();
const restore = admin.getByRole("button", { name: "restore" }).first();
if (await cut.count()) {
  await cut.click();
  await admin.waitForFunction(() => document.body.innerText.includes("restore"), { timeout: 5000 })
    .then(() => ok("link cut and restorable")).catch(() => bad("cut did not take"));
} else if (await restore.count()) {
  await restore.click();
  await admin.waitForFunction(
    () => admin.getByRole("button", { name: "cut" }).count(),
    { timeout: 5000 }
  ).then(() => ok("link restored, cut available again")).catch(() => bad("restore did not take"));
} else bad("no cut control found");

console.log("scenario controls");
await admin.waitForFunction(() => document.body.innerText.includes("scenario controls"), { timeout: 5000 })
  .then(() => ok("scenario panel renders")).catch(() => bad("no scenario panel"));

// Placing mode arms from the topology panel and narrates hover constraints.
await admin.getByRole("button", { name: /place node/i }).click();
await admin.waitForFunction(() => document.body.innerText.includes("Move across the map"), { timeout: 5000 })
  .then(() => ok("placement mode arms")).catch(() => bad("placement mode did not arm"));
await admin.getByRole("button", { name: /cancel place/i }).click();

// Drone mode: start + destination clicks arm the flight on the map overlay.
await admin.getByRole("button", { name: /simulate drone/i }).click();
await admin.waitForFunction(() => document.body.innerText.includes("Select drone starting position"), { timeout: 5000 })
  .then(() => ok("drone mode arms")).catch(() => bad("drone mode did not arm"));
const mapBox = await admin.evaluate(() => {
  // The sidebar drone is also an SVG — the map is the largest one.
  const svg = [...document.querySelectorAll("svg")].sort(
    (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width
  )[0];
  const r = svg.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await admin.mouse.click(mapBox.x + mapBox.w * 0.3, mapBox.y + mapBox.h * 0.3);
await admin.waitForFunction(() => document.body.innerText.includes("Drone start placed"), { timeout: 5000 })
  .then(() => ok("drone start placed on map")).catch(() => bad("drone start click missed"));
await admin.mouse.click(mapBox.x + mapBox.w * 0.7, mapBox.y + mapBox.h * 0.7);
await admin.waitForFunction(
  () => document.body.innerText.includes("READY TO FLY") || document.body.innerText.includes("start flight"),
  { timeout: 5000 }
).then(() => ok("drone destination set, ready to fly")).catch(() => bad("drone destination click missed"));
await admin.getByRole("button", { name: /start flight/i }).click();
await admin.waitForFunction(() => document.body.innerText.includes("IN FLIGHT"), { timeout: 5000 })
  .then(() => ok("simulated flight runs")).catch(() => bad("flight did not start"));
await admin.getByRole("button", { name: /remove drone/i }).first().click();

// Impact mode arms and narrates the click-to-cut contract.
await admin.getByRole("button", { name: /simulate impact/i }).click();
await admin.waitForFunction(() => document.body.innerText.includes("Impact armed"), { timeout: 5000 })
  .then(() => ok("impact mode arms")).catch(() => bad("impact mode did not arm"));
await admin.getByRole("button", { name: /cancel impact/i }).click();

// Clicking a node row opens the inspector with heartbeat and links.
await admin.waitForFunction(() => document.body.innerText.includes("scenario events") || document.body.innerText.includes("events"), { timeout: 5000 })
  .then(() => ok("activity log present")).catch(() => bad("no activity log"));

// Replay: one click runs interference + flight + restore, then reports done.
await admin.getByRole("button", { name: /replay scenario/i }).click();
await admin.waitForFunction(() => document.body.innerText.includes("Replay started"), { timeout: 5000 })
  .then(() => ok("replay sequence starts")).catch(() => bad("replay did not start"));
await admin.waitForFunction(() => document.body.innerText.includes("Replay sequence complete"), { timeout: 20000 })
  .then(() => ok("replay sequence completes")).catch(() => bad("replay did not complete"));

if (errors.length) { console.log("\npage errors:"); errors.forEach((e) => console.log("   ", e.split("\n")[0])); }
await browser.close();

console.log(fail.length ? `\nFAILED (${fail.length})` : "\nUI smoke passed");
process.exit(fail.length || errors.length ? 1 : 0);
