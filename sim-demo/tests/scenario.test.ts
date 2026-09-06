// scenario.test.ts — the demo-layer rules the admin console enforces.
//
// Placement keeps the array honest: nodes too close together hear the same
// thing at the same level, which constrains nothing (RUNNING.md demo 3), and
// alert routing is BFS over links that are up, with partition as a first-class
// outcome — the "path lost" demo, not an error.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlacementCandidate,
  placementStatus,
  placementNeighbours,
  findAlertPath,
  isConnected,
  networkHealth,
  interpolatePosition,
  nodesWithinRadius,
  pushEvent,
  type ActivityEvent,
} from "../app/lib/scenario.ts";

const at = (node: string, x: number, y: number): [string, { x: number; y: number }] => [
  node,
  { x, y },
];

// Spread-out array in the 12x8 room: corners plus mid-edges.
const room = new Map([
  at("n01", 0.5, 0.5),
  at("n02", 11.5, 0.5),
  at("n03", 0.5, 7.5),
  at("n04", 11.5, 7.5),
  at("n05", 6.0, 0.5),
  at("n06", 6.0, 7.5),
]);

const up = () => true;

describe("placement", () => {
  test("rejects a point on top of an existing node", () => {
    const c = buildPlacementCandidate(0.6, 0.6, room);
    assert.equal(placementStatus(c), "invalid");
  });

  test("warns when in range of too few neighbours", () => {
    // Sparse array: (1,4) clears n01 but only n01 is within link range.
    const sparse = new Map([
      at("n01", 1.0, 1.0),
      at("n02", 11.0, 7.0),
    ]);
    const c = buildPlacementCandidate(1.0, 4.0, sparse);
    assert.equal(placementStatus(c), "warning");
    assert.deepEqual(placementNeighbours(c), ["n01"]);
  });

  test("accepts a well-placed point and names its neighbours", () => {
    const c = buildPlacementCandidate(6.0, 4.0, room);
    assert.equal(placementStatus(c), "valid");
    assert.ok(placementNeighbours(c).length >= 2);
  });

  test("distances come out nearest-first", () => {
    const c = buildPlacementCandidate(6.0, 4.0, room);
    for (let i = 1; i < c.distances.length; i++) {
      assert.ok(c.distances[i - 1].d <= c.distances[i].d);
    }
  });
});

describe("alert routing", () => {
  // Two clusters joined by one bridge edge — the partition demo shape.
  const topo: Record<string, string[]> = {
    n01: ["n02", "n03"],
    n02: ["n01", "n03"],
    n03: ["n01", "n02", "n04"],
    n04: ["n03", "n05", "n06"],
    n05: ["n04", "n06"],
    n06: ["n04", "n05"],
    admin: ["n03", "n04"],
  };

  test("finds the shortest path to the command post", () => {
    const path = findAlertPath("n01", topo, up, "admin");
    assert.ok(path);
    assert.equal(path![0], "n01");
    assert.equal(path![path!.length - 1], "admin");
    assert.equal(path!.length, 3); // n01 -> n03 -> admin
  });

  test("routes around a cut bridge edge", () => {
    const cutBridge = (a: string, b: string) =>
      (a === "n03" && b === "n04") || (a === "n04" && b === "n03") ? false : true;
    const path = findAlertPath("n01", topo, cutBridge, "admin");
    assert.ok(path); // admin peers with both halves, so still reachable
    assert.equal(path![path!.length - 1], "admin");
  });

  test("returns null when the source is partitioned off", () => {
    const island: Record<string, string[]> = {
      n01: [],
      n02: ["admin"],
      admin: ["n02"],
    };
    assert.equal(findAlertPath("n01", island, up, "admin"), null);
  });

  test("connectivity drops when the bridge is cut", () => {
    const nodes = ["n01", "n02", "n03", "n04", "n05", "n06"];
    assert.equal(isConnected(nodes, topo, up), true);
    const cut = (a: string, b: string) =>
      (a === "n03" && b === "n04") || (a === "n04" && b === "n03") ? false : true;
    assert.equal(isConnected(nodes, topo, cut), false);
  });
});

describe("health, flight, activity", () => {
  test("health is the share of admitted nodes with fresh readings", () => {
    assert.equal(networkHealth(["n01", "n02", "n03", "n04"], new Set(["n01", "n02", "n03"])), 75);
    assert.equal(networkHealth([], []), 100);
    assert.equal(networkHealth(["n01"], []), 0);
  });

  test("interpolation clamps and midpoints", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 4 };
    assert.deepEqual(interpolatePosition(a, b, 0.5), { x: 5, y: 2 });
    assert.deepEqual(interpolatePosition(a, b, 9), b);
    assert.deepEqual(interpolatePosition(a, b, -1), a);
  });

  test("impact radius picks out the nodes in the blast", () => {
    const hit = nodesWithinRadius({ x: 0.5, y: 0.5 }, room, 3.0);
    assert.deepEqual(hit, ["n01"]);
    assert.equal(nodesWithinRadius({ x: 6, y: 4 }, room, 12).length, 6);
  });

  test("activity log caps at six and dedupes repeat detections", () => {
    let n = 0;
    const now = () => ({ id: ++n, time: `t${n}` });
    let events: ActivityEvent[] = [];
    for (let i = 0; i < 8; i++) {
      events = pushEvent(events, `event ${i}`, "info", now);
    }
    assert.equal(events.length, 6);
    assert.equal(events[0].message, "event 7");
    events = pushEvent(events, "n01 detected simulated drone", "warning", now);
    const len = events.length;
    events = pushEvent(events, "n01 detected simulated drone", "warning", now);
    assert.equal(events.length, len);
  });
});
