// sim.test.ts — the timed mesh simulation.
//
// The assertions mirror tests/mesh.test.ts, because this simulates that mesh
// using its own modules and the two must agree: multi-hop flooding,
// duplicate rejection, late-joiner backfill, and partition healing to the union.
//
// You cannot hand-test a distributed system. These are the properties that make
// the demo's claims true, and every one of them is invisible on screen when it
// breaks — a partition that never heals just looks like a slow network.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { areaAround, distanceM, makeFrame, toLatLon } from "../app/operator/placement.ts";
import { estimateFrom, expectedSnrDb } from "../app/operator/sim/estimate.ts";
import { DETECT_THRESHOLD, MARGINAL_FLOOR, MARGINAL_TICKS, RELEASE_THRESHOLD, DetectionLatch } from "../app/lib/detection.ts";
import { keyOf } from "../app/lib/protocol.ts";
import { gaussian, makeRng } from "../app/operator/sim/rng.ts";
import { DIGEST_INTERVAL_MS, SimWorld, TICK_MS, type SimNodeSpec } from "../app/operator/sim/world.ts";
import type { Waypoint } from "../app/operator/attackRoute.ts";

const LAT = 38.9012;
const LON = -77.0402;
const frame = makeFrame(LAT, LON);
const at = (x: number, y: number): [number, number] => toLatLon(frame, x, y);

/** A chain of n nodes, 120 m apart — diameter n-1, so flooding must multi-hop. */
function chain(n: number): { specs: SimNodeSpec[]; links: { a: string; b: string }[] } {
  const specs: SimNodeSpec[] = [];
  const links: { a: string; b: string }[] = [];
  for (let i = 0; i < n; i++) {
    const [lat, lon] = at(i * 120, 0);
    specs.push({ id: `n${i}`, lat, lon });
    if (i > 0) links.push({ a: `n${i - 1}`, b: `n${i}` });
  }
  return { specs, links };
}

/** Run until `ms` of simulated time has passed. */
function run(w: SimWorld, ms: number): void {
  for (let t = 0; t < ms; t += TICK_MS) w.tick();
}

// ---------------------------------------------------------------------------
// randomness
// ---------------------------------------------------------------------------

test("the seeded rng is reproducible and gaussian() is finite", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
  const g = makeRng(7);
  for (let i = 0; i < 2000; i++) assert.ok(Number.isFinite(gaussian(g)));
});

// ---------------------------------------------------------------------------
// the detection latch — copied from sim-demo, so assert it still behaves
// ---------------------------------------------------------------------------

test("detection latches with hysteresis rather than tracking a threshold", () => {
  const latch = new DetectionLatch();
  assert.equal(latch.push(0.30).detecting, false, "below the trip point");
  assert.equal(latch.push(DETECT_THRESHOLD + 0.01).detecting, true, "trips");
  // Between release and trip it must *stay* latched, which is the whole point.
  assert.equal(latch.push(0.30).detecting, true, "holds between release and trip");
  assert.equal(latch.push(RELEASE_THRESHOLD - 0.05).detecting, false, "releases");
});

test("a distant drone trips on sustained marginal readings", () => {
  // A source that never reaches 0.35 would otherwise be invisible forever.
  const latch = new DetectionLatch();
  const marginal = MARGINAL_FLOOR + 0.01;
  for (let i = 0; i < MARGINAL_TICKS - 1; i++) {
    assert.equal(latch.push(marginal).detecting, false, `tick ${i + 1} should not trip yet`);
  }
  assert.equal(latch.push(marginal).detecting, true, `trips on tick ${MARGINAL_TICKS}`);
});

// ---------------------------------------------------------------------------
// replication
// ---------------------------------------------------------------------------

test("records reach non-adjacent nodes by multi-hop flooding", () => {
  const { specs, links } = chain(4);
  const w = new SimWorld({ seed: 1 });
  w.setTopology(specs, links);
  run(w, 3_000);
  // n0 and n3 are three hops apart and never exchange a message directly.
  const far = w.replica("n3").filter((r) => r.origin === "n0");
  assert.ok(far.length > 0, "n0's records never reached n3");
});

test("duplicate arrivals by two paths are stored once", () => {
  // A ring gives every record two routes to the far side. The dedupe is what
  // makes flooding safe; without it the log would double and never converge.
  const specs: SimNodeSpec[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (2 * Math.PI * i) / 6;
    const [lat, lon] = at(Math.cos(a) * 200, Math.sin(a) * 200);
    specs.push({ id: `n${i}`, lat, lon });
  }
  const links = specs.map((s, i) => ({ a: s.id, b: specs[(i + 1) % 6].id }));
  const w = new SimWorld({ seed: 2 });
  w.setTopology(specs, links);
  run(w, 2_000);

  for (const s of specs) {
    const keys = w.replica(s.id).map(keyOf);
    assert.equal(new Set(keys).size, keys.length, `${s.id} holds a duplicate record`);
  }
});

test("every node ends up with the same set once gossip settles", () => {
  const { specs, links } = chain(4);
  const w = new SimWorld({ seed: 3 });
  w.setTopology(specs, links);
  run(w, 6_000);
  const sizes = specs.map((s) => w.recordCount(s.id));
  const spread = Math.max(...sizes) - Math.min(...sizes);
  // Not exact equality: the newest records are still in flight at any instant.
  assert.ok(spread <= 6, `replicas differ by ${spread} records: ${sizes.join(", ")}`);
});

// ---------------------------------------------------------------------------
// the failure demos
// ---------------------------------------------------------------------------

test("a partition diverges, and anti-entropy heals it to the union", () => {
  // The strongest claim in ARCHITECTURE.md §12, and the reason push alone is not
  // enough: with the link cut, neither half hears the other; on reconnect the
  // digest exchange — not the flood — is what backfills what was missed.
  const { specs, links } = chain(4);
  const w = new SimWorld({ seed: 4 });
  w.setTopology(specs, links);
  run(w, 2_000);

  // Cut the middle link: {n0,n1} | {n2,n3}
  const cut = links.filter((l) => !(l.a === "n1" && l.b === "n2"));
  w.setTopology(specs, cut);
  run(w, 4_000);

  const leftHasRight = w.replica("n0").filter((r) => r.origin === "n3").length;
  const beforeHeal = w.recordCount("n0");
  const rightProduced = w.replica("n3").filter((r) => r.origin === "n3").length;
  assert.ok(rightProduced > 0, "n3 should have kept scoring while cut off");

  // Heal.
  w.setTopology(specs, links);
  run(w, 3 * DIGEST_INTERVAL_MS);

  const leftHasRightAfter = w.replica("n0").filter((r) => r.origin === "n3").length;
  assert.ok(
    leftHasRightAfter > leftHasRight,
    `n0 learned nothing new about n3 after the heal (${leftHasRight} -> ${leftHasRightAfter})`
  );
  assert.ok(w.recordCount("n0") > beforeHeal, "n0's replica did not grow after reconnect");
});

test("a node added mid-run backfills the history it missed", () => {
  const { specs, links } = chain(3);
  const w = new SimWorld({ seed: 5 });
  w.setTopology(specs, links);
  run(w, 4_000);

  const [lat, lon] = at(3 * 120, 0);
  const joined = [...specs, { id: "late", lat, lon }];
  w.setTopology(joined, [...links, { a: "n2", b: "late" }]);
  // Long enough for boot plus a couple of digest rounds.
  run(w, 3 * DIGEST_INTERVAL_MS);

  const held = w.replica("late");
  const fromOthers = held.filter((r) => r.origin !== "late");
  assert.ok(fromOthers.length > 0, "the late joiner pulled none of the history");
  assert.ok(
    fromOthers.some((r) => r.origin === "n0"),
    "backfill did not reach as far as n0, three hops away"
  );
});

test("packet loss is survivable — anti-entropy repairs what push drops", () => {
  // Push alone is lossy: a dropped record is dropped forever. This is the test
  // that fails if the digest exchange is ever removed as redundant.
  const { specs, links } = chain(3);
  const lossy = new SimWorld({ seed: 6, loss: 0.6 });
  lossy.setTopology(specs, links);
  run(lossy, 8_000);
  const reached = lossy.replica("n2").filter((r) => r.origin === "n0").length;
  assert.ok(reached > 0, "with 60% loss nothing from n0 survived to n2");
});

test("a cut link stops delivery immediately", () => {
  const { specs, links } = chain(2);
  const w = new SimWorld({ seed: 7 });
  w.setTopology(specs, links);
  run(w, 1_500);
  const before = w.replica("n1").filter((r) => r.origin === "n0").length;

  w.setTopology(specs, []); // no links at all
  run(w, 3_000);
  const after = w.replica("n1").filter((r) => r.origin === "n0").length;
  assert.equal(after, before, "records crossed a link that does not exist");
});

// ---------------------------------------------------------------------------
// determinism and sensing
// ---------------------------------------------------------------------------

test("the same seed produces the same run", () => {
  const build = (seed: number) => {
    const { specs, links } = chain(3);
    const w = new SimWorld({ seed, loss: 0.2 });
    w.setTopology(specs, links);
    w.setRoute([at(-200, 0), at(400, 0)] as Waypoint[]);
    // Long enough that the drone actually reaches the array: below that the
    // contact sets are empty for every seed and this compares record counts.
    run(w, 20_000);
    return specs.map((s) => `${s.id}:${w.recordCount(s.id)}:${w.contactsSeenBy(s.id).join("+")}`).join("|");
  };
  assert.equal(build(11), build(11), "identical seeds diverged");
  assert.notEqual(build(11), build(12), "different seeds produced identical runs");
});

test("a drone flying past is detected, and the contact spreads beyond the node that heard it", () => {
  const { specs, links } = chain(4);
  const w = new SimWorld({ seed: 8 });
  w.setTopology(specs, links);
  // Straight over n0, far from n3.
  w.setRoute([at(-300, 0), at(200, 0)] as Waypoint[]);
  // 300 m to cross n0, at DRONE_SPEED_MPS.
  run(w, 26_000);

  const heardSomewhere = specs.some((s) => w.contactsSeenBy(s.id).length > 0);
  assert.ok(heardSomewhere, "nobody detected a drone flying directly overhead");

  // n3 is ~360 m from the closest approach and cannot hear it itself, but it
  // should know about the contact because the record reached it.
  const n3Knows = w.replica("n3").some((r) => r.origin !== "n3" && (r as { d?: boolean }).d === true);
  assert.ok(n3Knows, "the far node never learned about a contact it could not hear itself");
});

test("only records carrying a detection light a link", () => {
  // The invariant the map's ripple depends on. Every node publishes every
  // window whether it heard anything or not, so "a record is in flight" is
  // true of nearly every link nearly always; if that is what lights a link,
  // the highlight is on permanently and means nothing.
  const { specs, links } = chain(3);
  const w = new SimWorld({ seed: 31 });
  w.setTopology(specs, links);

  for (let t = 0; t < 3_000; t += TICK_MS) {
    w.tick();
    assert.ok(
      w.snapshot(true).inFlight.every((f) => !f.carriesDetection),
      `a mesh that has heard nothing flagged a link as carrying a detection at t=${t}`
    );
  }

  // Now fly one past n0 and the flag has to appear on the wire.
  w.setRoute([at(-260, 0), at(200, 0)] as Waypoint[]);
  let onTheWire = false;
  for (let t = 0; t < 40_000 && !onTheWire; t += TICK_MS) {
    w.tick();
    onTheWire = w.snapshot(true).inFlight.some((f) => f.carriesDetection);
  }
  assert.ok(onTheWire, "a latched detection never appeared on a link");
});

test("the fringe hold is display-only and does not outlive the latch by much", () => {
  // detectingHeld exists so a node at the edge of range stops strobing. It
  // must never claim a detection the node never made, and must relax again.
  const { specs, links } = chain(2);
  const w = new SimWorld({ seed: 32 });
  w.setTopology(specs, links);
  run(w, 2_000); // nothing to hear
  for (const n of w.snapshot(true).nodes) {
    assert.equal(n.detecting, false);
    assert.equal(n.detectingHeld, false, "held a detection that never happened");
  }

  w.setRoute([at(-100, 0), at(100, 0)] as Waypoint[]);
  let everHeld = false;
  for (let t = 0; t < 40_000; t += TICK_MS) {
    w.tick();
    const n0 = w.snapshot(true).nodes.find((n) => n.id === "n0")!;
    if (n0.detecting) assert.ok(n0.detectingHeld, "the hold dropped a live verdict");
    everHeld ||= n0.detectingHeld;
  }
  assert.ok(everHeld, "n0 never heard a drone passing directly overhead");
  // The drone finished its run long ago; the hold must have relaxed.
  const n0 = w.snapshot(true).nodes.find((n) => n.id === "n0")!;
  assert.equal(n0.detectingHeld, false, "the hold never released after the run ended");
});

test("the threat's ground speed changes when the array acquires it", () => {
  // The knob has to move the simulation, not just the playback: a slower drone
  // spends longer inside a node's earshot and is acquired further from it in
  // time, and a fast one can be most of the way across before anything latches.
  const firstContactMs = (mps: number) => {
    const { specs, links } = chain(3);
    const w = new SimWorld({ seed: 41, droneSpeedMps: mps });
    w.setTopology(specs, links);
    w.setRoute([at(-400, 0), at(400, 0)] as Waypoint[]);
    for (let t = 0; t < 200_000; t += TICK_MS) {
      w.tick();
      if (w.drainEvents().some((e) => e.kind === "detect")) return w.timeMs;
    }
    return Infinity;
  };
  const slow = firstContactMs(5);
  const fast = firstContactMs(40);
  assert.ok(Number.isFinite(slow) && Number.isFinite(fast), "one of the runs never detected anything");
  assert.ok(slow > fast * 2, `a 5 m/s drone reached the array in ${slow} ms, a 40 m/s one in ${fast} ms`);
});

test("changing speed mid-run changes pace rather than teleporting the drone", () => {
  // Distance is integrated per tick, not recomputed as timeMs * speed. The
  // latter would jump the drone to wherever the new speed says it should have
  // got to by now — forwards on a speed-up, backwards on a slow-down.
  const { specs, links } = chain(2);
  const w = new SimWorld({ seed: 42, droneSpeedMps: 10 });
  w.setTopology(specs, links);
  w.setRoute([at(0, 0), at(1000, 0)] as Waypoint[]);
  run(w, 10_000);
  const before = w.snapshot(true).travelledM;
  assert.ok(Math.abs(before - 100) < 1, `expected ~100 m at 10 m/s, got ${before}`);

  w.setDroneSpeed(30);
  const justAfter = w.snapshot(true).travelledM;
  assert.equal(justAfter, before, "the drone jumped the instant the speed changed");

  run(w, 1_000);
  const after = w.snapshot(true).travelledM;
  assert.ok(Math.abs(after - (before + 30)) < 1, `expected ~${before + 30} m after a second at 30 m/s, got ${after}`);
});

test("nodes publish every window, silent or not", () => {
  // Silence is evidence (§6.1). If quiet nodes stayed quiet the fused picture
  // would lose the negative information that pushes it away from empty space.
  const { specs, links } = chain(2);
  const w = new SimWorld({ seed: 9 });
  w.setTopology(specs, links);
  run(w, 3_000); // no route at all — nothing to hear
  assert.ok(w.recordCount("n0") > 5, "a node with nothing to report published nothing");
});

test("reset starts a fresh stream rather than reusing record keys", () => {
  // The one bug here that causes permanent divergence rather than delay: two
  // different records under one key can never be reconciled (§7.8).
  const { specs, links } = chain(2);
  const w = new SimWorld({ seed: 10 });
  w.setTopology(specs, links);
  run(w, 1_500);
  const before = new Set(w.replica("n0").map(keyOf));
  assert.ok(before.size > 0);

  w.reset();
  run(w, 1_500);
  const after = w.replica("n0").map(keyOf);
  assert.ok(after.length > 0);
  for (const k of after) assert.ok(!before.has(k), `key ${k} reused across a reboot`);
});

// ---------------------------------------------------------------------------
// per-node estimates
// ---------------------------------------------------------------------------

test("a node with no reports has nothing to fuse", () => {
  const positions = new Map([["a", { lat: LAT, lon: LON }]]);
  assert.equal(estimateFrom([], positions, areaAround([{ lat: LAT, lon: LON }], 300)), null);
});

test("silence alone is not a fix", () => {
  // With every node quiet the posterior is well defined — it points away from
  // all of them — but rendering that as a track claims a detection nobody made.
  const sites = [at(-150, 0), at(150, 0), at(0, 150)].map(([lat, lon], i) => ({ id: `n${i}`, lat, lon }));
  const positions = new Map(sites.map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
  const est = estimateFrom(
    sites.map((s) => ({ origin: s.id, d: false, snr_db: null })),
    positions,
    areaAround(sites, 300)
  );
  assert.ok(est);
  assert.equal(est!.nReports, 0);
  assert.equal(est!.localised, false, "a silent mesh must not report a fix");
});

test("three nodes hearing a real source localise it near the truth", () => {
  const sites = [at(-150, -100), at(150, -100), at(0, 160)].map(([lat, lon], i) => ({ id: `n${i}`, lat, lon }));
  const positions = new Map(sites.map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
  const truth = at(20, 10);
  const readings = sites.map((s) => ({
    origin: s.id,
    d: true,
    snr_db: expectedSnrDb(distanceM(truth[0], truth[1], s.lat, s.lon)),
  }));
  const est = estimateFrom(readings, positions, areaAround(sites, 250), { nx: 48, ny: 48 });
  assert.ok(est);
  assert.equal(est!.localised, true, "a clean three-node fix should be reported");
  const err = distanceM(truth[0], truth[1], est!.lat, est!.lon);
  assert.ok(err < 60, `fix landed ${err.toFixed(0)} m from the truth`);
  // And it must stay honest about how wide that fix is. 6 dB per doubling of
  // range against 4 dB of noise is a ~58% distance uncertainty; a credible
  // region of a couple of hundred metres is the truth, not a bug to tune away.
  assert.ok(est!.spreadM > 100, `spread ${est!.spreadM.toFixed(0)} m is implausibly confident`);
});

test("nodes all hearing the same level are detecting but not localised", () => {
  // The honesty bug from IMPLEMENTATION.md §12: four nodes reporting identical
  // levels is consistent with no single source position, but the argmax still
  // lands somewhere. Suppress it rather than draw a confident marker.
  const sites = [at(-150, -150), at(150, -150), at(150, 150), at(-150, 150)].map(([lat, lon], i) => ({ id: `n${i}`, lat, lon }));
  const positions = new Map(sites.map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
  const est = estimateFrom(
    sites.map((s) => ({ origin: s.id, d: true, snr_db: -55 })),
    positions,
    areaAround(sites, 250)
  );
  assert.ok(est);
  assert.equal(est!.nReports, 4);
  assert.equal(est!.localised, false, "identical levels must not produce a fix");
});

test("a peak pinned to the edge of the grid is not reported as a fix", () => {
  // The bug this guards: one node detecting plus several silent ones has no
  // compact posterior — silence bounds the source *away*, so probability piles
  // up outward until the grid stops it. The residual test cannot catch that (a
  // lone reading fits its own annulus perfectly anywhere along it) and neither
  // can the spread test (truncation is what makes the mass look compact), so
  // the map drew a confident marker in whichever corner the box ended at.
  const sites = [at(-120, 0), at(0, 100), at(120, 0)].map(([lat, lon], i) => ({ id: `n${i}`, lat, lon }));
  const positions = new Map(sites.map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
  // One node hears something faint; the rest hear nothing at all.
  const est = estimateFrom(
    [
      { origin: "n0", d: true, snr_db: expectedSnrDb(600) },
      { origin: "n1", d: false, snr_db: null },
      { origin: "n2", d: false, snr_db: null },
    ],
    positions,
    areaAround(sites, 200)
  );
  assert.ok(est);
  assert.equal(est!.edgePinned, true, "a source well outside the grid should peak on its boundary");
  assert.equal(est!.localised, false, "an edge-pinned peak was reported as a position");
});

test("a genuine fix inside the grid is still reported", () => {
  // The other half: rejecting edge peaks must not reject real localisations.
  const sites = [at(-150, -100), at(150, -100), at(0, 160)].map(([lat, lon], i) => ({ id: `n${i}`, lat, lon }));
  const positions = new Map(sites.map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
  const truth = at(20, 10);
  const est = estimateFrom(
    sites.map((s) => ({ origin: s.id, d: true, snr_db: expectedSnrDb(distanceM(truth[0], truth[1], s.lat, s.lon)) })),
    positions,
    areaAround(sites, 250),
    { nx: 48, ny: 48 }
  );
  assert.ok(est);
  assert.equal(est!.edgePinned, false, "a source in the middle of the array peaked on the boundary");
  assert.equal(est!.localised, true, "the edge test rejected a good fix");
});

test("two nodes can disagree while their replicas differ", () => {
  // The whole reason the viewpoint toggle is worth having: the estimate is a
  // function of the replica, so a node that has not yet received a record
  // genuinely draws a different picture.
  const { specs, links } = chain(4);
  const w = new SimWorld({ seed: 21, latencyMs: 400 });
  w.setTopology(specs, links);
  w.setRoute([at(-260, 0), at(120, 0)] as Waypoint[]);
  let sawDisagreement = false;
  // 260 m before the drone is over n0. The loop breaks on the first
  // disagreement, so a generous bound costs nothing.
  for (let t = 0; t < 24_000; t += TICK_MS) {
    w.tick();
    const near = w.contactsSeenBy("n0").join(",");
    const far = w.contactsSeenBy("n3").join(",");
    if (near !== far) { sawDisagreement = true; break; }
  }
  assert.ok(sawDisagreement, "no two nodes ever held different pictures");
});
