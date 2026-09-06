// placement.test.ts — the placement advisor's maths.
//
// These are the claims the feature rests on. If the geometry argument is wrong,
// the map confidently points the operator at the worst spot in the field, and
// nothing on screen would look wrong.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ARTICULATION_COST_M,
  CRLB_CAP_M,
  MAX_LINK_DISTANCE_M,
  MIN_CONNECTIONS,
  MIN_NODE_DISTANCE_M,
  areaAround,
  articulationPoints,
  crlbRadiusM,
  detectionProb,
  distanceM,
  isConnected,
  makeFrame,
  qualityGrid,
  rangeEdges,
  sensorInfo,
  suggestPlacements,
  toLatLon,
  toXY,
  type SensorSite,
} from "../app/operator/placement.ts";

const LAT = 38.9012;
const LON = -77.0402;

/** Nodes on a ring of `radiusM` around the origin — good geometry by construction. */
function ring(n: number, radiusM: number, lat = LAT, lon = LON): SensorSite[] {
  const frame = makeFrame(lat, lon);
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const [la, lo] = toLatLon(frame, Math.cos(a) * radiusM, Math.sin(a) * radiusM);
    return { id: `n${i}`, lat: la, lon: lo };
  });
}

/** Nodes strung along a line — the degenerate case. */
function line(n: number, spacingM: number, lat = LAT, lon = LON): SensorSite[] {
  const frame = makeFrame(lat, lon);
  return Array.from({ length: n }, (_, i) => {
    const [la, lo] = toLatLon(frame, (i - (n - 1) / 2) * spacingM, 0);
    return { id: `n${i}`, lat: la, lon: lo };
  });
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

test("toXY/toLatLon round-trips to sub-centimetre", () => {
  const frame = makeFrame(LAT, LON);
  for (const [x, y] of [[0, 0], [250, -400], [-1200, 900]]) {
    const [lat, lon] = toLatLon(frame, x, y);
    const [rx, ry] = toXY(frame, lat, lon);
    assert.ok(Math.hypot(rx - x, ry - y) < 0.01, `round-trip drifted at ${x},${y}`);
  }
});

test("distanceM agrees with the metric frame", () => {
  const frame = makeFrame(LAT, LON);
  const [lat, lon] = toLatLon(frame, 300, 400);
  assert.ok(Math.abs(distanceM(LAT, LON, lat, lon) - 500) < 1);
});

test("areaAround pads the bounding box by the requested margin", () => {
  const area = areaAround([{ lat: LAT, lon: LON }], 200);
  const northPad = distanceM(LAT, LON, area.north, LON);
  const eastPad = distanceM(LAT, LON, LAT, area.east);
  assert.ok(Math.abs(northPad - 200) < 2, `north pad ${northPad}`);
  assert.ok(Math.abs(eastPad - 200) < 2, `east pad ${eastPad}`);
});

// ---------------------------------------------------------------------------
// the information model
// ---------------------------------------------------------------------------

test("detection probability falls through 0.5 at the half-detection radius", () => {
  assert.ok(detectionProb(0) > 0.95);
  assert.ok(Math.abs(detectionProb(140) - 0.5) < 0.01);
  assert.ok(detectionProb(300) < 0.05);
});

test("a single sensor cannot localise: rank-1 information, capped radius", () => {
  // One range measurement fixes distance but not bearing — the posterior is an
  // annulus, so the bound must be the cap rather than a confident number.
  const info = sensorInfo(100, 0, 0, 0);
  const det = info.xx * info.yy - info.xy * info.xy;
  assert.ok(Math.abs(det) < 1e-20, `single-sensor FIM should be singular, det=${det}`);
  assert.equal(crlbRadiusM(info), CRLB_CAP_M);
});

test("information decays with distance", () => {
  const near = sensorInfo(50, 0, 0, 0);
  const far = sensorInfo(200, 0, 0, 0);
  assert.ok(near.xx > far.xx * 10, `near ${near.xx} vs far ${far.xx}`);
});

test("the inlined grid path matches the sensorInfo reference", () => {
  // qualityGrid inlines the accumulation for speed. If the two ever diverge the
  // fast path is silently computing a different objective from the documented one.
  const nodes = ring(3, 120);
  const area = areaAround(nodes, 50);
  const grid = qualityGrid(nodes, area, { nx: 8, ny: 8 });
  const frame = makeFrame((area.south + area.north) / 2, (area.west + area.east) / 2);
  const pts = nodes.map((n) => toXY(frame, n.lat, n.lon));

  for (let iy = 0; iy < grid.ny; iy++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      const lat = area.south + ((iy + 0.5) / grid.ny) * (area.north - area.south);
      const lon = area.west + ((ix + 0.5) / grid.nx) * (area.east - area.west);
      const [sx, sy] = toXY(frame, lat, lon);
      let xx = 0;
      let xy = 0;
      let yy = 0;
      for (const [px, py] of pts) {
        const info = sensorInfo(sx, sy, px, py);
        xx += info.xx;
        xy += info.xy;
        yy += info.yy;
      }
      const expected = crlbRadiusM({ xx, xy, yy });
      const actual = grid.radiusM[iy * grid.nx + ix];
      assert.ok(
        Math.abs(expected - actual) < 1e-3,
        `cell ${ix},${iy}: reference ${expected} vs grid ${actual}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// the claim that makes the feature worth building
// ---------------------------------------------------------------------------

test("spread beats clustered at equal node count", () => {
  // The whole argument: it is not how many sensors you have, it is where they
  // are. Same four nodes, same area, different geometry.
  const spread = qualityGrid(ring(4, 120), areaAround(ring(4, 120), 100), { nx: 32, ny: 32 });
  const clustered = qualityGrid(ring(4, 15), areaAround(ring(4, 120), 100), { nx: 32, ny: 32 });
  assert.ok(
    spread.meanRadiusM < clustered.meanRadiusM * 0.7,
    `spread ${spread.meanRadiusM.toFixed(1)} m vs clustered ${clustered.meanRadiusM.toFixed(1)} m`
  );
});

test("collinear nodes localise worse than a ring", () => {
  // Nodes along one wall all measure nearly the same bearing, so the summed
  // information stays near-singular perpendicular to the line. This is the
  // failure a pure coverage map cannot show.
  const area = areaAround(ring(4, 120), 100);
  const straight = qualityGrid(line(4, 90), area, { nx: 32, ny: 32 });
  const round = qualityGrid(ring(4, 120), area, { nx: 32, ny: 32 });
  assert.ok(
    round.meanRadiusM < straight.meanRadiusM,
    `ring ${round.meanRadiusM.toFixed(1)} m should beat line ${straight.meanRadiusM.toFixed(1)} m`
  );
});

test("adding sensors never makes the bound worse", () => {
  // Fisher information is additive and positive semi-definite, so a further
  // measurement cannot reduce it. A regression here means a sign error.
  const area = areaAround(ring(6, 130), 80);
  let previous = Infinity;
  for (const n of [2, 3, 4, 5, 6]) {
    const grid = qualityGrid(ring(n, 130), area, { nx: 24, ny: 24 });
    assert.ok(
      grid.meanRadiusM <= previous + 1e-6,
      `${n} nodes gave ${grid.meanRadiusM}, worse than ${n - 1}'s ${previous}`
    );
    previous = grid.meanRadiusM;
  }
});

// ---------------------------------------------------------------------------
// connectivity
// ---------------------------------------------------------------------------

test("articulationPoints finds the bridge node in a barbell", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const edges: [string, string][] = [
    ["a", "b"],
    ["b", "c"],
    ["c", "d"],
    ["d", "e"],
    ["e", "c"],
  ];
  const cuts = articulationPoints(ids, edges);
  assert.ok(cuts.has("c"), "c joins the a-b chain to the c-d-e triangle");
  assert.ok(cuts.has("b"), "b is the only path from a");
  assert.ok(!cuts.has("a"), "a is a leaf, not a cut vertex");
  assert.ok(!cuts.has("d") && !cuts.has("e"), "triangle members are redundant");
});

test("a cycle has no articulation points", () => {
  const ids = ["a", "b", "c", "d"];
  const edges: [string, string][] = [["a", "b"], ["b", "c"], ["c", "d"], ["d", "a"]];
  assert.equal(articulationPoints(ids, edges).size, 0);
});

test("articulationPoints handles a disconnected graph without false positives", () => {
  const ids = ["a", "b", "c", "d"];
  const edges: [string, string][] = [["a", "b"], ["c", "d"]];
  assert.equal(articulationPoints(ids, edges).size, 0, "two isolated pairs have no cut vertex");
  assert.equal(isConnected(ids, edges), false);
});

test("rangeEdges links exactly the pairs within radio range", () => {
  const nodes = line(3, MAX_LINK_DISTANCE_M - 10);
  const edges = rangeEdges(nodes);
  // Adjacent pairs are in range; the end-to-end pair is nearly double, so not.
  assert.equal(edges.length, 2);
  assert.ok(!edges.some(([a, b]) => (a === "n0" && b === "n2") || (a === "n2" && b === "n0")));
});

// ---------------------------------------------------------------------------
// the suggestion search
// ---------------------------------------------------------------------------

test("suggestions obey the hard placement rules", () => {
  const nodes = ring(4, 120);
  const { suggestions } = suggestPlacements(nodes, { count: 3, candidatesPerAxis: 20, nx: 20, ny: 20 });
  assert.ok(suggestions.length > 0, "expected at least one legal spot");

  const placed = [...nodes];
  for (const s of suggestions) {
    for (const n of placed) {
      assert.ok(
        distanceM(s.lat, s.lon, n.lat, n.lon) >= MIN_NODE_DISTANCE_M - 1e-6,
        `suggestion at rank ${s.rank} is ${distanceM(s.lat, s.lon, n.lat, n.lon).toFixed(0)} m from ${n.id}`
      );
    }
    assert.ok(
      s.neighbours.length >= MIN_CONNECTIONS,
      `rank ${s.rank} has ${s.neighbours.length} links, needs ${MIN_CONNECTIONS}`
    );
    placed.push({ id: `s${s.rank}`, lat: s.lat, lon: s.lon });
  }
});

test("suggestions are ranked and each one improves the array", () => {
  const nodes = ring(4, 120);
  const result = suggestPlacements(nodes, { count: 3, candidatesPerAxis: 20, nx: 20, ny: 20 });
  assert.deepEqual(result.suggestions.map((s) => s.rank), [1, 2, 3]);
  assert.ok(
    result.suggestions[0].meanRadiusM < result.baselineMeanRadiusM,
    "the top suggestion should beat doing nothing"
  );
  assert.ok(result.suggestions[0].improvementM > 0);
});

test("greedy suggestions do not all crowd into one gap", () => {
  // Ranking a single pass by individual merit returns three names for the same
  // hole. The search re-runs with each pick in place specifically to avoid that.
  const nodes = ring(4, 130);
  const { suggestions } = suggestPlacements(nodes, { count: 3, candidatesPerAxis: 22, nx: 20, ny: 20 });
  for (let i = 0; i < suggestions.length; i++) {
    for (let j = i + 1; j < suggestions.length; j++) {
      const d = distanceM(
        suggestions[i].lat,
        suggestions[i].lon,
        suggestions[j].lat,
        suggestions[j].lon
      );
      assert.ok(d >= MIN_NODE_DISTANCE_M - 1e-6, `ranks ${i + 1} and ${j + 1} are ${d.toFixed(0)} m apart`);
    }
  }
});

test("the advisor breaks up a wall of collinear nodes", () => {
  // Three nodes along one line all measure nearly the same bearing, so the
  // array is blind perpendicular to itself. The fix is a node *off* the line.
  //
  // Note it cannot be a specific side: the search area is the node bounding box
  // plus a margin, so a wall of nodes is symmetric about itself and east and
  // west are equally valuable. Asserting a side would be asserting a tie-break.
  const frame = makeFrame(LAT, LON);
  const nodes: SensorSite[] = [
    { id: "a", ...pt(frame, -120, 110) },
    { id: "b", ...pt(frame, -120, 0) },
    { id: "c", ...pt(frame, -120, -110) },
  ];
  const { suggestions } = suggestPlacements(nodes, { count: 1, candidatesPerAxis: 24, nx: 24, ny: 24 });
  assert.equal(suggestions.length, 1);
  const [x] = toXY(frame, suggestions[0].lat, suggestions[0].lon);
  assert.ok(
    Math.abs(x - -120) > 50,
    `suggestion should stand well off the wall at x=-120, got x=${x.toFixed(0)} m`
  );
  assert.ok(suggestions[0].improvementM > 0);
});

test("connectivity is priced into the ranking", () => {
  // The constant is what makes the trade legible, so assert it is actually a
  // trade and not decoration.
  assert.ok(ARTICULATION_COST_M > 0);
  // Radius 100 puts adjacent nodes 141 m apart — inside the 150 m radio range,
  // so this really is a 4-cycle. (At radius 120 the spacing is 170 m and the
  // "ring" has no edges at all, which is a different test.)
  const nodes = ring(4, 100);
  const { suggestions, baselineArticulation } = suggestPlacements(nodes, {
    count: 1,
    candidatesPerAxis: 20,
    nx: 20,
    ny: 20,
  });
  assert.equal(baselineArticulation, 0, "a 4-cycle has no cut vertex");
  assert.equal(suggestions[0].articulation, 0, "and the advisor should not introduce one");
});

test("bridging two out-of-range nodes is correctly counted as a cut vertex", () => {
  // The converse, and the reason the objective prices articulation at all: when
  // the existing nodes cannot reach each other, anything that joins them is a
  // single point of failure. The advisor must see that, not just the geometry.
  const nodes = ring(4, 120); // 170 m apart — no edges between them
  const { baselineArticulation, suggestions } = suggestPlacements(nodes, {
    count: 1,
    candidatesPerAxis: 20,
    nx: 20,
    ny: 20,
  });
  assert.equal(baselineArticulation, 0, "isolated vertices have no cut vertex");
  assert.equal(suggestions[0].articulation, 1, "the bridging node is one");
});

test("improvement is marginal, so the ranking reads top-down", () => {
  // Measured against the original baseline these would grow down the list,
  // because each rank silently includes the ones above it. Marginal gains must
  // be non-increasing: the greedy search takes the best spot first.
  const nodes = ring(4, 100);
  const { suggestions } = suggestPlacements(nodes, { count: 3, candidatesPerAxis: 22, nx: 20, ny: 20 });
  assert.ok(suggestions.length >= 2, "need at least two suggestions to compare");
  for (const s of suggestions) assert.ok(s.improvementM >= 0, `rank ${s.rank} went backwards`);
  for (let i = 1; i < suggestions.length; i++) {
    assert.ok(
      suggestions[i].improvementM <= suggestions[i - 1].improvementM + 1e-6,
      `rank ${i + 1} gained ${suggestions[i].improvementM} > rank ${i}'s ${suggestions[i - 1].improvementM}`
    );
  }
});

test("the gain a suggestion advertises is the gain accepting it delivers", () => {
  // The search evaluates thousands of candidates, so it cannot afford the full
  // qualityGrid per candidate and reimplements the aggregates inline. That is
  // exactly where the two can drift: the first version decided coverage from
  // "is the CRLB finite here", which is true far outside detection range, so a
  // suggestion promised +26% area and delivered none.
  const nodes = ring(4, 100);
  const opts = { count: 1, candidatesPerAxis: 22, nx: 24, ny: 24 } as const;
  const { suggestions, area, baselineCoverage, baselineMeanRadiusM } = suggestPlacements(nodes, opts);
  assert.equal(suggestions.length, 1);
  const s = suggestions[0];

  const after = qualityGrid([...nodes, { id: "accepted", lat: s.lat, lon: s.lon }], area, {
    nx: opts.nx,
    ny: opts.ny,
  });
  assert.ok(
    Math.abs(after.coverage - s.coverage) < 1e-9,
    `promised ${(s.coverage * 100).toFixed(1)}% coverage, delivered ${(after.coverage * 100).toFixed(1)}%`
  );
  assert.ok(
    Math.abs(after.meanRadiusM - s.meanRadiusM) < 0.5,
    `promised ±${s.meanRadiusM.toFixed(1)} m mean, delivered ±${after.meanRadiusM.toFixed(1)} m`
  );
  assert.ok(
    Math.abs(s.coverageGain - (after.coverage - baselineCoverage)) < 1e-9,
    "coverageGain must be the real delta"
  );
  assert.ok(Math.abs(s.improvementM - (baselineMeanRadiusM - after.meanRadiusM)) < 0.5);
});

test("typical-error headline ignores ground no sensor can hear", () => {
  // The mean over the whole box is dominated by blind cells at the cap, which is
  // right for ranking and useless as a headline. The median over covered ground
  // has to be a genuinely different, and much smaller, number.
  const nodes = ring(4, 100);
  const grid = qualityGrid(nodes, areaAround(nodes, 400), { nx: 40, ny: 40 });
  assert.ok(grid.coverage < 0.6, "fixture should have plenty of blind ground");
  assert.ok(
    grid.medianCoveredRadiusM < grid.meanRadiusM / 2,
    `median-covered ${grid.medianCoveredRadiusM.toFixed(0)} m vs mean ${grid.meanRadiusM.toFixed(0)} m`
  );
  assert.ok(grid.medianCoveredRadiusM < CRLB_CAP_M);
});

test("the caller's topology is used, not one re-derived from range", () => {
  // The seeded demo network has a 222 m link the 150 m range rule would never
  // create. If the advisor rebuilt adjacency itself, its failure count would
  // describe a graph drawn nowhere on the map.
  const nodes = ring(4, 120); // 170 m apart — rangeEdges would find no links
  const chain: [string, string][] = [["n0", "n1"], ["n1", "n2"], ["n2", "n3"]];
  const derived = suggestPlacements(nodes, { count: 1, candidatesPerAxis: 16, nx: 16, ny: 16 });
  const given = suggestPlacements(nodes, { count: 1, candidatesPerAxis: 16, nx: 16, ny: 16, edges: chain });
  assert.equal(derived.baselineArticulation, 0, "range-derived: four isolated nodes");
  assert.equal(given.baselineArticulation, 2, "as drawn: a path of four has two cut vertices");
});

test("no legal spot yields no suggestions rather than a bad one", () => {
  // A lone node has nothing to form MIN_CONNECTIONS links with, so every
  // candidate fails the hard rules. Returning nothing is the correct answer.
  const { suggestions, feasibleCount } = suggestPlacements([{ id: "solo", lat: LAT, lon: LON }], {
    count: 3,
    candidatesPerAxis: 16,
    nx: 16,
    ny: 16,
  });
  assert.equal(feasibleCount, 0);
  assert.equal(suggestions.length, 0);
});

test("a suggestion request stays inside an interactive budget", () => {
  const nodes = ring(5, 130);
  const started = performance.now();
  suggestPlacements(nodes, { count: 3 });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `took ${elapsed.toFixed(0)} ms at default resolution`);
});

function pt(frame: ReturnType<typeof makeFrame>, x: number, y: number): { lat: number; lon: number } {
  const [lat, lon] = toLatLon(frame, x, y);
  return { lat, lon };
}
