// route.test.ts — attack-route geometry and the coverage number the demo rests on.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { distanceM, makeFrame, toLatLon } from "../app/operator/placement.ts";
import {
  pointAlongRoute,
  routeCoverage,
  routeLegs,
  routeLengthM,
  type Waypoint,
} from "../app/operator/attackRoute.ts";

const LAT = 38.9012;
const LON = -77.0402;
const frame = makeFrame(LAT, LON);

const at = (x: number, y: number): Waypoint => toLatLon(frame, x, y);

test("routeLengths sums the legs", () => {
  const route = [at(0, 0), at(300, 0), at(300, 400)];
  const { legs, total } = routeLegs(route);
  assert.equal(legs.length, 2);
  assert.ok(Math.abs(legs[0] - 300) < 1);
  assert.ok(Math.abs(legs[1] - 400) < 1);
  assert.ok(Math.abs(total - 700) < 2);
});

test("a single waypoint has no length and no route", () => {
  assert.equal(routeLengthM([at(0, 0)]), 0);
  assert.equal(routeLengthM([]), 0);
  assert.deepEqual(pointAlongRoute([], 100), [0, 0]);
});

test("pointAlongRoute walks at constant ground speed across a corner", () => {
  // The whole reason distance is the parameter and not a 0..1 fraction: with a
  // fraction the drone would cross a 400 m leg in the same time as a 100 m one.
  const route = [at(0, 0), at(300, 0), at(300, 400)];
  const quarter = pointAlongRoute(route, 175); // 175 m in: still on leg one
  assert.ok(Math.abs(distanceM(route[0][0], route[0][1], quarter[0], quarter[1]) - 175) < 2);
  const past = pointAlongRoute(route, 500); // 200 m up the second leg
  assert.ok(Math.abs(distanceM(route[1][0], route[1][1], past[0], past[1]) - 200) < 2);
});

test("pointAlongRoute clamps at both ends", () => {
  const route = [at(0, 0), at(100, 0)];
  assert.deepEqual(pointAlongRoute(route, -50), route[0]);
  assert.deepEqual(pointAlongRoute(route, 9_999), route[1]);
});

test("a zero-length leg does not divide by zero", () => {
  // Two clicks in the same spot is an easy thing for an operator to do.
  const route = [at(0, 0), at(0, 0), at(200, 0)];
  const p = pointAlongRoute(route, 100);
  assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
  assert.ok(Math.abs(distanceM(LAT, LON, p[0], p[1]) - 100) < 2);
});

test("a route through a sensor is fully covered; one far away is not seen at all", () => {
  const node = { id: "n1", ...pointObj(at(0, 0)) };
  const through: Waypoint[] = [at(-100, 0), at(100, 0)];
  const wide: Waypoint[] = [at(-100, 5_000), at(100, 5_000)];
  assert.equal(routeCoverage(through, [node]).covered, 1);
  const missed = routeCoverage(wide, [node]);
  assert.equal(missed.covered, 0);
  assert.equal(missed.firstContactM, null);
  assert.deepEqual(missed.contacts, []);
});

test("coverage reports where the array is blind, and for how long", () => {
  // Two sensors 900 m apart with a 140 m radius: a straight run between them is
  // heard at each end and unobserved through the middle.
  const nodes = [
    { id: "a", ...pointObj(at(0, 0)) },
    { id: "b", ...pointObj(at(900, 0)) },
  ];
  const run: Waypoint[] = [at(0, 0), at(900, 0)];
  const cov = routeCoverage(run, nodes);
  assert.ok(cov.covered > 0.2 && cov.covered < 0.5, `covered ${cov.covered}`);
  assert.deepEqual(cov.contacts.sort(), ["a", "b"]);
  assert.equal(cov.firstContactM, 0, "it starts on top of a sensor");
  // Gap runs from ~140 m to ~760 m.
  assert.ok(Math.abs(cov.longestGapM - 620) < 30, `gap ${cov.longestGapM.toFixed(0)} m`);
});

test("firstContactM says how far in the run got before anyone heard it", () => {
  // A sensor 500 m along a 1 km straight run: contact at ~360 m, where the run
  // enters the 140 m radius.
  const nodes = [{ id: "a", ...pointObj(at(500, 0)) }];
  const run: Waypoint[] = [at(0, 0), at(1_000, 0)];
  const cov = routeCoverage(run, nodes);
  assert.ok(cov.firstContactM !== null);
  assert.ok(Math.abs(cov.firstContactM! - 360) < 15, `first contact at ${cov.firstContactM}`);
});

test("adding a sensor in the gap can only improve coverage", () => {
  const run: Waypoint[] = [at(0, 0), at(900, 0)];
  const before = [{ id: "a", ...pointObj(at(0, 0)) }, { id: "b", ...pointObj(at(900, 0)) }];
  const after = [...before, { id: "c", ...pointObj(at(450, 0)) }];
  assert.ok(routeCoverage(run, after).covered > routeCoverage(run, before).covered);
});

test("segments tile the route exactly once, and mark the blind stretch", () => {
  // A percentage says how much is covered; the segments say which part, and
  // those call for different responses. They must also reconstruct the whole
  // route — a gap in the tiling would draw as a hole in the line.
  const nodes = [
    { id: "a", ...pointObj(at(0, 0)) },
    { id: "b", ...pointObj(at(900, 0)) },
  ];
  const cov = routeCoverage([at(0, 0), at(900, 0)], nodes);
  assert.ok(cov.segments.length >= 3, `expected covered/blind/covered, got ${cov.segments.length}`);
  assert.equal(cov.segments[0].covered, true, "starts on top of a sensor");
  assert.equal(cov.segments[cov.segments.length - 1].covered, true, "ends on one");
  assert.ok(cov.segments.some((s) => !s.covered), "and is blind in between");

  // Consecutive segments share their boundary point, so the drawn line is
  // continuous rather than dotted at each handover.
  for (let i = 1; i < cov.segments.length; i++) {
    const prevEnd = cov.segments[i - 1].points[cov.segments[i - 1].points.length - 1];
    const nextStart = cov.segments[i].points[0];
    assert.deepEqual(nextStart, prevEnd, `segment ${i} does not continue from ${i - 1}`);
  }
  // And alternate, or they would have been one run.
  for (let i = 1; i < cov.segments.length; i++) {
    assert.notEqual(cov.segments[i].covered, cov.segments[i - 1].covered);
  }
});

test("a fully observed route is one segment", () => {
  const cov = routeCoverage([at(-100, 0), at(100, 0)], [{ id: "a", ...pointObj(at(0, 0)) }]);
  assert.equal(cov.segments.length, 1);
  assert.equal(cov.segments[0].covered, true);
});

test("no sensors means nothing is seen", () => {
  const cov = routeCoverage([at(0, 0), at(500, 0)], []);
  assert.equal(cov.covered, 0);
  assert.equal(cov.firstContactM, null);
  assert.ok(Math.abs(cov.longestGapM - 500) < 10);
  assert.equal(cov.segments.length, 1);
  assert.equal(cov.segments[0].covered, false);
});

function pointObj(w: Waypoint): { lat: number; lon: number } {
  return { lat: w[0], lon: w[1] };
}
