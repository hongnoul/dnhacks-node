// ui-smoke.mjs — drives the real pages in a real browser.
//
// Admits three nodes from the admin console, places and links them, then checks
// that a node's own page renders a picture computed from its own replica.
// Run:  node tests/ui-smoke.mjs   (relay + next dev must already be running)

import { chromium } from "playwright";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const fail = [];
const ok = (m) => console.log("  ✔", m);
const bad = (m) => { fail.push(m); console.log("  ✖", m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: [] });
const errors = [];
ctx.on("weberror", (e) => errors.push(String(e.error())));

console.log("admin console");
const admin = await ctx.newPage();
await admin.goto(`${APP}/admin`);
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

await admin.waitForFunction(() => /links/i.test(document.body.innerText) &&
  document.querySelectorAll("input[type=range]").length > 0, { timeout: 5000 })
  .then(() => ok("link controls rendered")).catch(() => bad("no link controls"));

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
const cut = admin.getByRole("button", { name: "cut" }).first();
if (await cut.count()) {
  await cut.click();
  await admin.waitForFunction(() => document.body.innerText.includes("restore"), { timeout: 5000 })
    .then(() => ok("link cut and restorable")).catch(() => bad("cut did not take"));
} else bad("no cut control found");

if (errors.length) { console.log("\npage errors:"); errors.forEach((e) => console.log("   ", e.split("\n")[0])); }
await browser.close();

console.log(fail.length ? `\nFAILED (${fail.length})` : "\nUI smoke passed");
process.exit(fail.length || errors.length ? 1 : 0);
