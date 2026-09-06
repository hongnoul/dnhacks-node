// fusion.test.ts — the occupancy grid's claimed properties.
//
// Note the split: SNR-graded readings localise, p-only readings do not. That is
// not a shortcoming to fix but the empirical form of ARCHITECTURE.md §6.2 —
// detection survives a saturated model, localisation does not — and it is worth
// a test so nobody quietly drops `snr_db` from the wire.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fuse,
  detectionProb,
  expectedSnr,
  DEFAULT_MODEL,
  DEFAULT_RANGE,
  type Placed,
  type NodeReading,
} from "../app/lib/fusion.ts";

const room = { w: 12, h: 8 };
const at = (node: string, x: number, y: number): [string, Placed] => [node, { node, x, y }];

const perimeter = new Map<string, Placed>([
  at("n01", 0.5, 0.5), at("n02", 11.5, 0.5), at("n03", 0.5, 7.5),
  at("n04", 11.5, 7.5), at("n05", 6.0, 0.5), at("n06", 6.0, 7.5),
]);

/** What a node at `pos` would measure with the source at (tx, ty). */
function measure(pos: Placed, tx: number, ty: number): NodeReading {
  const d = Math.hypot(pos.x - tx, pos.y - ty);
  const snrDb = expectedSnr(d, DEFAULT_RANGE);
  return { node: pos.node, p: 1 / (1 + Math.exp(-(snrDb - 8) / 4)), snrDb };
}

describe("models", () => {
  test("detection probability falls with distance", () => {
    assert.ok(detectionProb(0) > detectionProb(4));
    assert.ok(detectionProb(4) > detectionProb(12));
    assert.ok(detectionProb(50) >= DEFAULT_MODEL.pmin);
  });

  test("expected level falls with distance", () => {
    assert.ok(expectedSnr(1) > expectedSnr(4));
    assert.ok(expectedSnr(4) > expectedSnr(12));
  });
});

describe("fusion — graded (snr_db present)", () => {
  test("returns null when no reading has a position", () => {
    assert.equal(fuse({ room, positions: new Map(), readings: [{ node: "n01", p: 0.9 }] }), null);
  });

  test("locates the source", () => {
    for (const [tx, ty] of [[3, 4], [6, 4], [9, 2]] as const) {
      const readings = [...perimeter.values()].map((p) => measure(p, tx, ty));
      const est = fuse({ room, positions: perimeter, readings })!;
      assert.ok(est.graded);
      assert.ok(
        Math.hypot(est.x - tx, est.y - ty) < 1.0,
        `truth (${tx},${ty}) → MAP (${est.x.toFixed(1)},${est.y.toFixed(1)})`
      );
    }
  });

  test("more nodes tighten the credible region", () => {
    const all = [...perimeter.values()];
    const spread = (k: number) =>
      fuse({ room, positions: perimeter, readings: all.slice(0, k).map((p) => measure(p, 6, 4)) })!
        .spreadM;
    const [s3, s6] = [spread(3), spread(6)];
    assert.ok(s6 < s3, `6 nodes (${s6.toFixed(2)} m) should beat 3 (${s3.toFixed(2)} m)`);
  });

  test("silence is evidence: a censored reading pushes the posterior away", () => {
    const positions = new Map([at("n01", 1, 4), at("n02", 11, 4)]);
    const est = fuse({
      room, positions,
      readings: [
        { node: "n01", p: 0.02, snrDb: DEFAULT_RANGE.floorDb - 5 }, // heard nothing
        { node: "n02", p: 0.9, snrDb: expectedSnr(2) },
      ],
    })!;
    assert.ok(est.x > 6, `expected the right half, got x=${est.x.toFixed(1)}`);
    assert.equal(est.nSilent, 1);
    assert.equal(est.nReports, 1);
  });

  test("posterior is a normalised distribution", () => {
    const est = fuse({
      room, positions: perimeter,
      readings: [...perimeter.values()].map((p) => measure(p, 6, 4)),
    })!;
    const total = [...est.posterior].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-4, `mass was ${total}`);
  });
});

describe("fusion — degraded (p only)", () => {
  test("flags itself as ungraded", () => {
    const readings = [...perimeter.values()].map((pos) => ({ node: pos.node, p: 0.9 }));
    assert.equal(fuse({ room, positions: perimeter, readings })!.graded, false);
  });

  test("a saturated model yields a broad region, not a confident dot", () => {
    // The §6.2 failure mode: every node pinned at 1.0 carries no position
    // information, so the posterior must spread rather than invent a location.
    // The meaningful comparison is against the room, not against graded fusion:
    // the claim is "it covers most of the space", not "it is twice as wide".
    const roomRadius = Math.sqrt((room.w * room.h) / Math.PI);
    const saturated = [...perimeter.values()].map((pos) => ({ node: pos.node, p: 1.0 }));
    const flat = fuse({ room, positions: perimeter, readings: saturated })!;
    const sharp = fuse({
      room, positions: perimeter,
      readings: [...perimeter.values()].map((p) => measure(p, 3, 4)),
    })!;

    assert.ok(
      flat.spreadM > 0.6 * roomRadius,
      `saturated region should span most of the room: ${flat.spreadM.toFixed(2)} m of ${roomRadius.toFixed(2)} m`
    );
    assert.ok(flat.spreadM > sharp.spreadM, "graded fusion must beat saturated");
  });

  test("adding nodes barely helps without a graded measurement", () => {
    // Documents *why* snr_db is on the wire: binary evidence does not trilaterate.
    const all = [...perimeter.values()];
    const spread = (k: number) =>
      fuse({
        room, positions: perimeter,
        readings: all.slice(0, k).map((pos) => ({
          node: pos.node,
          p: detectionProb(Math.hypot(pos.x - 6, pos.y - 4)) > 0.5 ? 0.95 : 0.05,
        })),
      })!.spreadM;
    const gain = spread(3) / spread(6);
    assert.ok(gain < 1.5, `p-only improvement should be marginal, was ${gain.toFixed(2)}x`);
  });
});
