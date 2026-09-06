// routeAdvisor.test.ts — placement advice for a specific ingress.
//
// The advice is generated, not learned, so the thing worth asserting is that
// it is *honest*: every spot it offers has to be legal, the numbers it quotes
// have to be the ones routeCoverage actually reports, and the stated reason
// has to be the reason it ranked. A recommendation that reads well and is
// wrong is worse than none, and none of that is visible on screen.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { adviseForRoute } from "../app/operator/routeAdvisor.ts";
import { routeCoverage, type Waypoint } from "../app/operator/attackRoute.ts";
import {
  MAX_LINK_DISTANCE_M,
  MIN_NODE_DISTANCE_M,
  distanceM,
  makeFrame,
  toLatLon,
} from "../app/operator/placement.ts";

const frame = makeFrame(38.9012, -77.0402);
const at = (x: number, y: number): [number, number] => toLatLon(frame, x, y);

/** A run straight west to east through the origin. */
const RUN: Waypoint[] = [at(-500, 0), at(500, 0)];

test("a route nobody can hear gets advice, and the advice improves it", () => {
  // A sensor near the corridor but off the track: the run is barely observed.
  const nodes = [{ id: "n0", ...pos(at(-400, 200)) }];
  const advice = adviseForRoute(RUN, nodes);
  assert.ok(advice.suggestions.length > 0, "no advice offered for an unobserved run");

  const first = advice.suggestions[0];
  assert.ok(
    first.coverage > advice.baselineCoverage,
    `advice did not raise coverage (${advice.baselineCoverage} -> ${first.coverage})`
  );
});

test("a mesh that cannot reach the ingress still gets advice, flagged as detached", () => {
  // The case where advice matters most. Insisting every spot reach the mesh
  // would leave the advisor silent exactly when the array is in the wrong
  // place entirely — so it answers, and says the sensor would come up isolated.
  const nodes = [{ id: "n0", ...pos(at(0, 900)) }];
  const advice = adviseForRoute(RUN, nodes);
  assert.ok(advice.suggestions.length > 0, "silent about a mesh nowhere near the route");
  const first = advice.suggestions[0];
  assert.equal(first.detached, true, "should have reported the spot as unreachable by the mesh");
  assert.equal(first.neighbours.length, 0);
  assert.match(first.detail, /no mesh within \d+ m/);
  assert.ok(first.coverage > advice.baselineCoverage);
});

test("every suggested spot obeys the spacing and attachment rules", () => {
  const nodes = [
    { id: "n0", ...pos(at(-200, 60)) },
    { id: "n1", ...pos(at(-80, 60)) },
  ];
  const advice = adviseForRoute(RUN, nodes);
  assert.ok(advice.suggestions.length > 0);

  const placed = [...nodes];
  for (const s of advice.suggestions) {
    for (const n of placed) {
      const d = distanceM(s.lat, s.lon, n.lat, n.lon);
      assert.ok(d >= MIN_NODE_DISTANCE_M, `rank ${s.rank} sits ${d.toFixed(0)} m from ${n.id}`);
    }
    assert.ok(
      s.neighbours.length + s.linksToRanks.length >= 1,
      `rank ${s.rank} would come up with no links at all`
    );
    // Quoted neighbours must be real nodes the operator can wire to today.
    for (const id of s.neighbours) {
      const n = nodes.find((p) => p.id === id);
      assert.ok(n, `rank ${s.rank} names ${id}, which is not an existing node`);
      assert.ok(
        distanceM(s.lat, s.lon, n!.lat, n!.lon) <= MAX_LINK_DISTANCE_M,
        `rank ${s.rank} claims a link to ${id} beyond radio range`
      );
    }
    placed.push({ id: `r${s.rank}`, lat: s.lat, lon: s.lon });
  }
});

test("the quoted numbers are the ones routeCoverage actually reports", () => {
  // The rationale is generated text; if it drifts from the model behind it the
  // advisor becomes a liar that sounds confident. Recompute independently.
  const nodes = [{ id: "n0", ...pos(at(-300, 40)) }];
  const advice = adviseForRoute(RUN, nodes);
  const first = advice.suggestions[0];
  assert.ok(first);

  const check = routeCoverage(RUN, [...nodes, { id: "s1", lat: first.lat, lon: first.lon }]);
  assert.equal(first.coverage, check.covered, "quoted coverage is not what the model computes");
  assert.equal(first.firstContactM, check.firstContactM, "quoted first contact does not match");
  assert.equal(first.longestGapM, check.longestGapM, "quoted blind stretch does not match");
});

test("suggestions complement each other rather than naming one hole three times", () => {
  const nodes = [{ id: "n0", ...pos(at(0, 60)) }];
  const advice = adviseForRoute(RUN, nodes, { count: 3 });
  assert.ok(advice.suggestions.length >= 2, "expected more than one suggestion on a long blind run");
  for (let i = 0; i < advice.suggestions.length; i++) {
    for (let j = i + 1; j < advice.suggestions.length; j++) {
      const d = distanceM(
        advice.suggestions[i].lat, advice.suggestions[i].lon,
        advice.suggestions[j].lat, advice.suggestions[j].lon
      );
      assert.ok(d >= MIN_NODE_DISTANCE_M, `ranks ${i + 1} and ${j + 1} are ${d.toFixed(0)} m apart`);
    }
  }
});

test("confidence falls down the list, showing diminishing returns", () => {
  const nodes = [{ id: "n0", ...pos(at(0, 60)) }];
  const advice = adviseForRoute(RUN, nodes, { count: 3 });
  assert.equal(advice.suggestions[0].confidence, 1, "the top pick should be the reference");
  for (let i = 1; i < advice.suggestions.length; i++) {
    assert.ok(
      advice.suggestions[i].confidence <= advice.suggestions[i - 1].confidence,
      "a later suggestion claimed more merit than an earlier one"
    );
  }
});

test("a run that is already fully observed gets no advice", () => {
  // Offering a placement that changes nothing is the failure mode that makes
  // an advisor look automated rather than useful.
  const nodes: { id: string; lat: number; lon: number }[] = [];
  for (let i = 0; i <= 10; i++) nodes.push({ id: `n${i}`, ...pos(at(-500 + i * 100, 0)) });
  const advice = adviseForRoute(RUN, nodes);
  assert.equal(advice.baselineCoverage, 1, "fixture does not actually cover the run");
  assert.equal(advice.suggestions.length, 0, "advised a placement for a run already fully heard");
});

test("with no route there is nothing to advise on", () => {
  assert.equal(adviseForRoute([], []).suggestions.length, 0);
  assert.equal(adviseForRoute([at(0, 0)] as Waypoint[], []).suggestions.length, 0);
});

test("the headline names the effect that actually dominated", () => {
  // A run blind only at its start: the win is warning time, and the headline
  // has to say so rather than defaulting to a generic line.
  const nodes = [
    { id: "n0", ...pos(at(150, 0)) },
    { id: "n1", ...pos(at(350, 0)) },
  ];
  const advice = adviseForRoute(RUN, nodes);
  const first = advice.suggestions[0];
  assert.ok(first, "no advice for a run blind on approach");
  assert.ok(first.earlierByM > 0, "the top pick bought no warning at all");
  assert.equal(first.headline, "Buys the most warning", `headline was "${first.headline}"`);
  assert.match(first.detail, /first contact \d+ m earlier/);
  // The badge carries the same effect as a number, so a list where every
  // headline coincides still distinguishes its entries on the map.
  assert.match(first.badge, /^\d+ m earlier$/, `badge was "${first.badge}"`);
});

function pos([lat, lon]: [number, number]) {
  return { lat, lon };
}
