// survey.test.ts — what a distance survey can and cannot recover.
//
// The load-bearing assertions are the negative ones. A solver that always
// returns coordinates is easy; one that says "these measurements do not pin
// this node" is what keeps ARCHITECTURE.md §13's sigma_m honest, and what stops
// fusion from treating a guess as a surveyed mark.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  solveSurvey,
  pairKey,
  METHOD_SIGMA_M,
  type Measurement,
} from "../app/lib/survey.ts";

const room = { w: 12, h: 8 };

/** Every pair of a ground-truth layout, as if measured perfectly. */
function allPairs(truth: Record<string, [number, number]>, noise = 0): Measurement[] {
  const ids = Object.keys(truth);
  const out: Measurement[] = [];
  // Deterministic pseudo-noise: a seeded ramp, so a failure is reproducible.
  let k = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [ax, ay] = truth[ids[i]];
      const [bx, by] = truth[ids[j]];
      const d = Math.hypot(ax - bx, ay - by);
      out.push({ a: ids[i], b: ids[j], dM: d + noise * Math.sin(k++ * 2.399963) });
    }
  }
  return out;
}

/**
 * Distances are invariant to rotation, reflection and translation, so a solved
 * layout can only be compared up to those. Best-fit alignment (Kabsch, with the
 * reflection tried explicitly) is the only fair comparison.
 */
function alignedError(
  truth: Record<string, [number, number]>,
  solved: { node: string; x: number; y: number }[]
): number {
  const ids = solved.map((s) => s.node);
  const p = ids.map((id) => truth[id]);
  const q = solved.map((s) => [s.x, s.y] as [number, number]);
  const mean = (pts: [number, number][]) => [
    pts.reduce((s, v) => s + v[0], 0) / pts.length,
    pts.reduce((s, v) => s + v[1], 0) / pts.length,
  ];
  const [pcx, pcy] = mean(p);
  const [qcx, qcy] = mean(q);
  const pc = p.map(([x, y]) => [x - pcx, y - pcy]);
  let best = Infinity;
  for (const mirror of [1, -1]) {
    const qc = q.map(([x, y]) => [x - qcx, mirror * (y - qcy)]);
    // Optimal 2D rotation aligning qc onto pc.
    let num = 0;
    let den = 0;
    for (let i = 0; i < pc.length; i++) {
      num += qc[i][0] * pc[i][1] - qc[i][1] * pc[i][0];
      den += qc[i][0] * pc[i][0] + qc[i][1] * pc[i][1];
    }
    const ang = Math.atan2(num, den);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    let worst = 0;
    for (let i = 0; i < pc.length; i++) {
      const rx = c * qc[i][0] - s * qc[i][1];
      const ry = s * qc[i][0] + c * qc[i][1];
      worst = Math.max(worst, Math.hypot(rx - pc[i][0], ry - pc[i][1]));
    }
    best = Math.min(best, worst);
  }
  return best;
}

const square: Record<string, [number, number]> = {
  n01: [2, 2],
  n02: [9, 2],
  n03: [9, 6],
  n04: [2, 6],
};

describe("recovering a known layout", () => {
  test("exact distances reproduce the shape to millimetres", () => {
    const r = solveSurvey(allPairs(square), { room });
    assert.ok(r);
    assert.equal(r.nodes.length, 4);
    assert.ok(
      alignedError(square, r.nodes) < 0.01,
      `worst node off by ${alignedError(square, r.nodes).toFixed(3)} m`
    );
    assert.ok(r.rmsResidualM < 0.01);
  });

  test("solved pairwise distances match what was measured", () => {
    const r = solveSurvey(allPairs(square), { room })!;
    const pos = new Map(r.nodes.map((n) => [n.node, n]));
    for (const m of allPairs(square)) {
      const a = pos.get(m.a)!;
      const b = pos.get(m.b)!;
      assert.ok(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - m.dM) < 0.01);
    }
  });

  test("a partial survey still solves — five of six pairs", () => {
    // Drop one diagonal. 5 >= 2n-3 = 5, so the square is still rigid.
    const partial = allPairs(square).filter((m) => pairKey(m.a, m.b) !== pairKey("n01", "n03"));
    const r = solveSurvey(partial, { room });
    assert.ok(r);
    assert.equal(r.excluded.length, 0);
    assert.ok(alignedError(square, r.nodes) < 0.05);
    assert.equal(r.redundancy, 0);
  });

  test("noisy tape readings degrade gracefully rather than failing", () => {
    const r = solveSurvey(allPairs(square, 0.08), { room, defaultSigmaM: METHOD_SIGMA_M.tape })!;
    assert.ok(alignedError(square, r.nodes) < 0.25);
    assert.ok(r.rmsResidualM < 0.15, `rms ${r.rmsResidualM}`);
  });

  test("the array lands centred in the room frame", () => {
    const r = solveSurvey(allPairs(square), { room })!;
    const xs = r.nodes.map((n) => n.x);
    const ys = r.nodes.map((n) => n.y);
    // The *extent* is centred, not the centre of mass — see the lopsided case.
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - room.w / 2) < 1e-6);
    assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - room.h / 2) < 1e-6);
  });

  test("a lopsided array stays inside the frame it says it fits", () => {
    // Two nodes bunched together and one far away: the centre of mass sits well
    // off the middle of the extent. Centring on the centroid used to report
    // fitsRoom true while pushing the far node to x = 13.2 in a 12 m room,
    // where it is clipped off the map and gossiped as a real position.
    const lopsided: Record<string, [number, number]> = {
      n01: [0, 0], n02: [0.5, 0.2], n03: [11, 0.1],
    };
    const r = solveSurvey(allPairs(lopsided), { room })!;
    assert.equal(r.fitsRoom, true, "an 11 m span fits a 12 m frame");
    for (const n of r.nodes) {
      assert.ok(
        n.x >= 0 && n.x <= room.w && n.y >= 0 && n.y <= room.h,
        `${n.node} at (${n.x.toFixed(2)}, ${n.y.toFixed(2)}) escaped the frame`
      );
    }
  });
});

describe("gauge freedom is the operator's, not the solver's", () => {
  test("the same measurements always give the same coordinates", () => {
    const a = solveSurvey(allPairs(square), { room })!;
    const b = solveSurvey(allPairs(square).reverse(), { room })!;
    const byId = new Map(b.nodes.map((n) => [n.node, n]));
    for (const n of a.nodes) {
      const m = byId.get(n.node)!;
      assert.ok(Math.hypot(n.x - m.x, n.y - m.y) < 1e-6, `${n.node} moved between solves`);
    }
  });

  test("rotation turns the array without changing its shape", () => {
    const base = solveSurvey(allPairs(square), { room })!;
    const turned = solveSurvey(allPairs(square), { room, rotateDeg: 37 })!;
    const dist = (r: typeof base, a: string, b: string) => {
      const p = r.nodes.find((n) => n.node === a)!;
      const q = r.nodes.find((n) => n.node === b)!;
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    assert.ok(Math.abs(dist(base, "n01", "n03") - dist(turned, "n01", "n03")) < 1e-6);
    // ...and it really did move.
    const p = base.nodes.find((n) => n.node === "n01")!;
    const q = turned.nodes.find((n) => n.node === "n01")!;
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) > 0.5);
  });

  test("flip mirrors without changing any measured distance", () => {
    const base = solveSurvey(allPairs(square), { room })!;
    const flipped = solveSurvey(allPairs(square), { room, flip: true })!;
    assert.ok(flipped.rmsResidualM < 0.01);
    const byId = new Map(flipped.nodes.map((n) => [n.node, n]));
    for (const n of base.nodes) {
      const m = byId.get(n.node)!;
      assert.ok(Math.abs(n.x - m.x) < 1e-6);
      assert.ok(Math.abs(n.y - (room.h - m.y)) < 1e-6);
    }
  });
});

describe("what the survey refuses to claim", () => {
  test("a node with one measurement is flagged, not quietly placed", () => {
    // n04 hangs off n01 by a single distance: it is somewhere on a circle.
    const ms = allPairs(square).filter(
      (m) => !(m.a === "n04" || m.b === "n04") || pairKey(m.a, m.b) === pairKey("n01", "n04")
    );
    const r = solveSurvey(ms, { room })!;
    const n04 = r.nodes.find((n) => n.node === "n04")!;
    assert.equal(n04.degree, 1);
    assert.equal(n04.underdetermined, true);
    assert.ok(n04.sigmaM > 1, `sigma ${n04.sigmaM} should be room-scale, not tape-scale`);
    // The rigid three keep their honest, small uncertainty.
    for (const id of ["n01", "n02", "n03"]) {
      assert.equal(r.nodes.find((n) => n.node === id)!.underdetermined, false);
    }
  });

  test("nodes in a separate island of measurements are excluded", () => {
    const ms: Measurement[] = [
      ...allPairs(square),
      { a: "x01", b: "x02", dM: 3 },
    ];
    const r = solveSurvey(ms, { room })!;
    assert.deepEqual(r.excluded.sort(), ["x01", "x02"]);
    assert.deepEqual(r.nodes.map((n) => n.node).sort(), ["n01", "n02", "n03", "n04"]);
  });

  test("a collinear array reports a near-zero aspect", () => {
    const line: Record<string, [number, number]> = {
      n01: [1, 4], n02: [4, 4], n03: [7, 4], n04: [10, 4],
    };
    const r = solveSurvey(allPairs(line), { room })!;
    assert.ok(r.aspect < 1e-3, `aspect ${r.aspect} should say "these are in a line"`);
    // §13.1: nodes bunched along one line cannot resolve the perpendicular.
    assert.ok(r.nodes.every((n) => n.underdetermined));
  });

  test("aspect describes the solved shape, not the path-completed seed", () => {
    // Shortest-path completion stretches unmeasured pairs, so reading aspect off
    // the MDS seed made a square with one missing diagonal look half as wide as
    // it is (0.5) — enough to fire a "these are in a line" warning about a
    // perfectly square array.
    const sq: Record<string, [number, number]> = {
      n01: [0, 0], n02: [4, 0], n03: [4, 4], n04: [0, 4],
    };
    const full = solveSurvey(allPairs(sq), { room })!;
    assert.ok(Math.abs(full.aspect - 1) < 0.02, `square aspect ${full.aspect}`);

    const partial = solveSurvey(
      allPairs(sq).filter((m) => pairKey(m.a, m.b) !== pairKey("n01", "n03")),
      { room }
    )!;
    assert.ok(Math.abs(partial.aspect - 1) < 0.02, `square-minus-a-diagonal aspect ${partial.aspect}`);

    // And it is an axis ratio, so a 4:1 rectangle reads as 0.25, not 0.0625.
    const strip = solveSurvey(
      allPairs({ n01: [0, 0], n02: [8, 0], n03: [8, 2], n04: [0, 2] }),
      { room }
    )!;
    assert.ok(Math.abs(strip.aspect - 0.25) < 0.03, `4:1 strip aspect ${strip.aspect}`);
  });

  test("one mistyped distance is detected but not blamed, at low redundancy", () => {
    // Four nodes, six pairs, redundancy 1. There is exactly one spare
    // measurement, so least squares smears the inconsistency evenly and every
    // residual comes out the same size. The survey can say "these numbers
    // disagree"; it cannot say which one lied. Same shape as fusion.ts's split
    // between detection and localisation, for the same reason: one redundant
    // observation is enough to notice a contradiction and not to place it.
    const ms = allPairs(square).map((m) =>
      pairKey(m.a, m.b) === pairKey("n01", "n02") ? { ...m, dM: m.dM + 1.5 } : m
    );
    const r = solveSurvey(ms, { room, defaultSigmaM: METHOD_SIGMA_M.tape })!;
    assert.equal(r.redundancy, 1);
    assert.ok(r.worstSigmas > 3, `worst residual only ${r.worstSigmas.toFixed(1)} sigma`);
    // Nothing stands out: the top residuals are all within a hair of each other.
    const top = r.residuals.slice(0, 3).map((x) => x.sigmas);
    assert.ok(top[0] - top[2] < 0.5, `expected a tie, got ${top.map((v) => v.toFixed(1))}`);
  });

  test("more redundancy identifies the culprit pair", () => {
    // Six nodes, fifteen pairs, redundancy 6. Now the corrupted edge cannot
    // hide: it disagrees with far more geometry than it can bend.
    const six: Record<string, [number, number]> = {
      n01: [2, 2], n02: [9, 2], n03: [9, 6],
      n04: [2, 6], n05: [5.5, 4], n06: [5.5, 1],
    };
    const ms = allPairs(six).map((m) =>
      pairKey(m.a, m.b) === pairKey("n01", "n02") ? { ...m, dM: m.dM + 1.5 } : m
    );
    const r = solveSurvey(ms, { room, defaultSigmaM: METHOD_SIGMA_M.tape })!;
    assert.equal(r.redundancy, 6);
    assert.equal(pairKey(r.residuals[0].a, r.residuals[0].b), pairKey("n01", "n02"));
    // Clear of the runner-up, not a coin flip between neighbours.
    assert.ok(
      r.residuals[0].sigmas > r.residuals[1].sigmas * 1.5,
      `${r.residuals[0].sigmas.toFixed(1)} vs ${r.residuals[1].sigmas.toFixed(1)} sigma`
    );
  });

  test("a bad measurement inflates every quoted sigma", () => {
    const clean = solveSurvey(allPairs(square), { room, defaultSigmaM: METHOD_SIGMA_M.tape })!;
    const dirty = solveSurvey(
      allPairs(square).map((m) =>
        pairKey(m.a, m.b) === pairKey("n01", "n02") ? { ...m, dM: m.dM + 1.5 } : m
      ),
      { room, defaultSigmaM: METHOD_SIGMA_M.tape }
    )!;
    const sig = (r: typeof clean, id: string) => r.nodes.find((n) => n.node === id)!.sigmaM;
    for (const id of ["n01", "n02", "n03", "n04"]) {
      assert.ok(sig(dirty, id) > sig(clean, id) * 2, `${id} sigma did not widen`);
    }
  });

  test("redundancy counts spare measurements past the rigid minimum", () => {
    const full = solveSurvey(allPairs(square), { room })!;
    assert.equal(full.redundancy, 6 - (2 * 4 - 3)); // 1
    const triangle = solveSurvey(allPairs({ n01: [0, 0], n02: [4, 0], n03: [0, 3] }), { room })!;
    assert.equal(triangle.redundancy, 0); // fit satisfied, not tested
  });

  test("an array larger than the room frame says so", () => {
    const wide: Record<string, [number, number]> = {
      n01: [0, 0], n02: [40, 0], n03: [40, 25], n04: [0, 25],
    };
    const r = solveSurvey(allPairs(wide), { room })!;
    assert.equal(r.fitsRoom, false);
    assert.ok(r.extentM.w > room.w);
  });
});

describe("measurement hygiene", () => {
  test("nonsense entries are dropped, not solved around", () => {
    const ms: Measurement[] = [
      ...allPairs(square),
      { a: "n01", b: "n01", dM: 5 }, // self
      { a: "n02", b: "n03", dM: 0 }, // zero
      { a: "n01", b: "n04", dM: Number.NaN },
      { a: "", b: "n02", dM: 3 },
    ];
    const r = solveSurvey(ms, { room })!;
    assert.equal(r.nodes.length, 4);
    assert.ok(!r.nodes.some((n) => n.node === ""));
    // A junk entry is discarded rather than overwriting the good reading for
    // the same pair — a half-typed box in the UI must not erase a real
    // measurement, so all six survive and the layout is still exact.
    assert.equal(r.residuals.length, 6);
    assert.ok(alignedError(square, r.nodes) < 0.01);
  });

  test("a re-measured pair overrides the earlier reading", () => {
    const r = solveSurvey(
      [
        { a: "n01", b: "n02", dM: 3 },
        { a: "n02", b: "n03", dM: 4 },
        { a: "n01", b: "n03", dM: 5 },
        { a: "n02", b: "n01", dM: 7 }, // same pair, reversed, remeasured
      ],
      { room }
    )!;
    const measured = r.residuals.find((x) => pairKey(x.a, x.b) === pairKey("n01", "n02"))!;
    assert.equal(measured.measuredM, 7);
    assert.equal(r.residuals.length, 3);
  });

  test("per-measurement sigma outweighs the survey default", () => {
    // One laser reading among paced ones should dominate where they disagree.
    const ms: Measurement[] = [
      { a: "n01", b: "n02", dM: 5.0, sigmaM: METHOD_SIGMA_M.laser },
      { a: "n02", b: "n03", dM: 4.0 },
      { a: "n01", b: "n03", dM: 3.0 },
      { a: "n01", b: "n04", dM: 4.0 },
      { a: "n02", b: "n04", dM: 3.0 },
      { a: "n03", b: "n04", dM: 5.0 },
    ];
    const r = solveSurvey(ms, { room, defaultSigmaM: METHOD_SIGMA_M.paced })!;
    const tight = r.residuals.find((x) => pairKey(x.a, x.b) === pairKey("n01", "n02"))!;
    assert.ok(Math.abs(tight.residualM) < 0.02);
  });

  test("too little to solve returns null rather than a fabricated layout", () => {
    assert.equal(solveSurvey([], { room }), null);
    assert.equal(solveSurvey([{ a: "n01", b: "n01", dM: 4 }], { room }), null);
    // A single pair is two nodes on a line: solvable, and honest about it.
    const pair = solveSurvey([{ a: "n01", b: "n02", dM: 4 }], { room })!;
    assert.equal(pair.nodes.length, 2);
    assert.ok(pair.nodes.every((n) => n.underdetermined));
  });
});
