// survey.ts — measured node-to-node distances into room coordinates.
//
// ARCHITECTURE.md §13 says the right things and the code never implemented
// them: "only relative geometry matters", "a tape measure across a room is
// ~0.1 m", "record sigma_m honestly". Until this module the only way to set a
// position was to drag a marker over a satellite tile, which is an eyeball
// measurement dressed up as a survey — and fusion.ts believes those metres.
//
// So: the operator measures what a tape can actually measure (the distance
// between two phones) and this solves for coordinates. That inverts the error
// budget. Dragging puts ~1 m of error into every absolute position; a tape puts
// ~0.1 m into each *relative* distance, which is the only thing the occupancy
// grid ever uses.
//
// WHY NOT PLAIN TRILATERATION
//
// Trilateration wants a complete, consistent set and has nowhere to put the
// leftover error when the operator measures more pairs than the minimum. Real
// surveys are partial (some pairs are across a wall) and over-determined (the
// easy pairs get measured twice). So: classical MDS for a seed, then stress
// majorisation (SMACOF) against the measured pairs only, weighted by each
// measurement's own sigma. Extra measurements tighten the fit instead of
// contradicting it, and missing ones just weaken it.
//
// WHAT DISTANCES CANNOT TELL YOU
//
// A distance set fixes shape and size. It does not fix position, rotation, or
// reflection — no amount of measuring will tell you which way the array points.
// That gauge freedom is handed to the operator (`rotateDeg`, `flip`) rather
// than silently resolved, because the operator is the only one who knows where
// north is.
//
// Browser-free, so it unit-tests directly like fusion.ts.

import type { Room } from "./fusion.ts";

export interface Measurement {
  a: string;
  b: string;
  dM: number;
  /** 1-sigma on this reading. Falls back to the solve's `defaultSigmaM`. */
  sigmaM?: number;
}

/**
 * How the distance was obtained, and what that is worth.
 *
 * These are the numbers §13 asks the operator to record honestly. The gap
 * between `laser` and `eyeball` is a factor of 20, and it propagates all the
 * way to whether fusion will call a fix localised — which is the point of
 * making the operator choose rather than assuming.
 */
export type SurveyMethod = "laser" | "tape" | "paced" | "eyeball";

export const METHOD_SIGMA_M: Record<SurveyMethod, number> = {
  laser: 0.05,
  tape: 0.10,
  paced: 0.50, // ~0.75 m stride, and nobody paces a straight line
  eyeball: 1.00,
};

export interface SurveyNode {
  node: string;
  x: number;
  y: number;
  /** 1-sigma position uncertainty, metres. Feeds `node_config.sigma_m` (§13). */
  sigmaM: number;
  /** Measured edges touching this node. */
  degree: number;
  /**
   * True when this node's own measurements do not pin it in two dimensions —
   * one distance leaves it anywhere on a circle, and two collinear ones leave a
   * mirror pair. Its coordinate is a guess the solver had to make.
   */
  underdetermined: boolean;
}

export interface SurveyResidual {
  a: string;
  b: string;
  measuredM: number;
  solvedM: number;
  residualM: number;
  /** Residual in multiples of that measurement's own sigma. */
  sigmas: number;
}

export interface SurveyResult {
  nodes: SurveyNode[];
  /**
   * Nodes named in measurements but not reachable from the main component —
   * a separate island of measurements has its own arbitrary gauge, so merging
   * it into one frame would be inventing geometry.
   */
  excluded: string[];
  /** Worst first: the fat-fingered entry is the one you want to see. */
  residuals: SurveyResidual[];
  rmsResidualM: number;
  /** Worst residual in sigmas, or 0 with no measurements. */
  worstSigmas: number;
  /**
   * m - (2n - 3): spare measurements beyond the minimum that fixes the shape.
   * At zero the fit is satisfied rather than tested — every residual is zero
   * because it has to be, not because the tape agreed with itself.
   */
  redundancy: number;
  /**
   * Minor over major axis of the solved constellation, 0..1. Near zero means
   * the nodes came out in a line, which fusion cannot use: §13.1's smeared
   * blob. 1 is a circular spread.
   */
  aspect: number;
  extentM: { w: number; h: number };
  /** False when the solved array is larger than the room frame it was fitted into. */
  fitsRoom: boolean;
}

export interface SurveyOptions {
  /** Solved coordinates are centred in this frame. Defaults to 12 x 8 m. */
  room?: Room;
  /** Operator-supplied orientation. Distances cannot supply it (see header). */
  rotateDeg?: number;
  /** Mirror the solution. Also unrecoverable from distances alone. */
  flip?: boolean;
  defaultSigmaM?: number;
  iterations?: number;
}

const DEFAULT_ROOM_FRAME: Room = { w: 12, h: 8 };
const EPS = 1e-9;

export function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

// ---------- linear algebra ----------

/**
 * Jacobi eigenvalue iteration for a symmetric matrix.
 *
 * Classical MDS needs the top two eigenvectors of an n x n Gram matrix. Power
 * iteration would do, but n here is the number of phones — under twenty — so
 * the whole spectrum is nearly free, and having it is what lets the solve
 * report `aspect` rather than guessing whether the array is degenerate.
 */
function jacobiEigen(input: number[][], sweeps = 64): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-16) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

// ---------- the solve ----------

interface Clean {
  ids: string[];
  index: Map<string, number>;
  edges: { i: number; j: number; d: number; sigma: number }[];
}

/** Dedupe, reject nonsense, and index. Later readings of a pair win. */
function cleanMeasurements(ms: Measurement[], defaultSigmaM: number): Clean {
  const byPair = new Map<string, Measurement>();
  for (const m of ms) {
    if (!m.a || !m.b || m.a === m.b) continue;
    if (!Number.isFinite(m.dM) || m.dM <= 0) continue;
    byPair.set(pairKey(m.a, m.b), m);
  }
  const ids = [...new Set([...byPair.values()].flatMap((m) => [m.a, m.b]))].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const edges = [...byPair.values()].map((m) => ({
    i: index.get(m.a)!,
    j: index.get(m.b)!,
    d: m.dM,
    sigma:
      Number.isFinite(m.sigmaM) && (m.sigmaM as number) > 0 ? (m.sigmaM as number) : defaultSigmaM,
  }));
  return { ids, index, edges };
}

/** Indices of the largest connected component of the measurement graph. */
function largestComponent(n: number, edges: Clean["edges"]): number[] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.i].push(e.j);
    adj[e.j].push(e.i);
  }
  const seen = new Array<boolean>(n).fill(false);
  let best: number[] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const comp: number[] = [];
    const queue = [start];
    seen[start] = true;
    while (queue.length) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const nb of adj[cur]) {
        if (seen[nb]) continue;
        seen[nb] = true;
        queue.push(nb);
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best.sort((a, b) => a - b);
}

/**
 * Fill unmeasured pairs with the shortest measured path between them.
 *
 * Only a seed. Path length over-estimates straight-line distance whenever the
 * route bends, so the seeded constellation comes out stretched — SMACOF then
 * pulls it back using the measured pairs alone, which are the only distances
 * anyone actually observed.
 */
function completeDistances(n: number, edges: Clean["edges"]): number[][] {
  const d: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity))
  );
  for (const e of edges) {
    d[e.i][e.j] = Math.min(d[e.i][e.j], e.d);
    d[e.j][e.i] = d[e.i][e.j];
  }
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d;
}

/** Classical MDS: double-centre the squared distances, take the top two axes. */
function classicalMds(d: number[][]): number[][] {
  const n = d.length;
  const sq = d.map((row) => row.map((v) => v * v));
  const rowMean = sq.map((row) => row.reduce((s, v) => s + v, 0) / n);
  const grand = rowMean.reduce((s, v) => s + v, 0) / n;
  const b = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => -0.5 * (sq[i][j] - rowMean[i] - rowMean[j] + grand))
  );
  const { values, vectors } = jacobiEigen(b);
  const order = values.map((_, i) => i).sort((p, q) => values[q] - values[p]);
  return Array.from({ length: n }, (_, i) =>
    [0, 1].map((k) => {
      const col = order[k];
      return vectors[i][col] * Math.sqrt(Math.max(values[col], 0));
    })
  );
}

/**
 * Ratio of the constellation's minor axis to its major axis, from the solved
 * coordinates.
 *
 * Deliberately not taken from the MDS seed's spectrum: shortest-path completion
 * stretches every unmeasured pair, so the seed describes a constellation nobody
 * measured — a square missing one diagonal comes back looking half as wide as it
 * is. Covariance eigenvalues are squared lengths, hence the square root, so this
 * really is a ratio of axes and 0.1 really does mean "ten times longer than
 * wide".
 */
function axisRatio(pts: number[][]): number {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const half = (sxx + syy) / 2;
  const root = Math.sqrt(Math.max(0, half * half - (sxx * syy - sxy * sxy)));
  const major = half + root;
  return major > EPS ? Math.sqrt(Math.max(0, half - root) / major) : 0;
}

/**
 * Stress majorisation against the measured pairs, weighted by 1/sigma^2.
 *
 * The Guttman transform is a descent step on weighted stress, so this cannot
 * diverge — it only stalls. That matters more than speed here: the operator is
 * watching the numbers update as they type, and a solver that occasionally
 * jumped to a wild configuration would read as a bug in the tape measure.
 */
function smacof(pts: number[][], edges: Clean["edges"], iterations: number): number[][] {
  const n = pts.length;
  let x = pts.map((p) => p.slice());
  const wsum = new Array<number>(n).fill(0);
  for (const e of edges) {
    const w = 1 / (e.sigma * e.sigma);
    wsum[e.i] += w;
    wsum[e.j] += w;
  }
  let prevStress = Infinity;
  for (let it = 0; it < iterations; it++) {
    const next = Array.from({ length: n }, () => [0, 0]);
    for (const e of edges) {
      const w = 1 / (e.sigma * e.sigma);
      const dx = x[e.i][0] - x[e.j][0];
      const dy = x[e.i][1] - x[e.j][1];
      const dist = Math.hypot(dx, dy);
      // Coincident points have no direction to separate along. A deterministic
      // offset keeps the iteration reproducible, which random jitter would not.
      const ux = dist > EPS ? dx / dist : 1;
      const uy = dist > EPS ? dy / dist : 0;
      const mx = (x[e.i][0] + x[e.j][0]) / 2;
      const my = (x[e.i][1] + x[e.j][1]) / 2;
      next[e.i][0] += w * (mx + (e.d / 2) * ux);
      next[e.i][1] += w * (my + (e.d / 2) * uy);
      next[e.j][0] += w * (mx - (e.d / 2) * ux);
      next[e.j][1] += w * (my - (e.d / 2) * uy);
    }
    for (let i = 0; i < n; i++) {
      if (wsum[i] <= 0) continue; // isolated: leave the seed alone
      next[i][0] /= wsum[i];
      next[i][1] /= wsum[i];
    }
    x = next.map((p, i) => (wsum[i] > 0 ? p : x[i]));

    let stress = 0;
    for (const e of edges) {
      const dist = Math.hypot(x[e.i][0] - x[e.j][0], x[e.i][1] - x[e.j][1]);
      stress += ((dist - e.d) * (dist - e.d)) / (e.sigma * e.sigma);
    }
    if (Math.abs(prevStress - stress) < 1e-12 * Math.max(stress, 1)) break;
    prevStress = stress;
  }
  return x;
}

/**
 * Resolve the gauge freedom: centre, align the long axis to x, pick a
 * deterministic reflection, then apply the operator's rotation and flip.
 *
 * The deterministic step matters for a reason that is not aesthetic. Without
 * it, adding one measurement can mirror or spin the whole array, and the
 * operator watches the map scramble while they are still typing.
 */
function canonicalise(pts: number[][], rotateDeg: number, flip: boolean): number[][] {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  let out = pts.map((p) => [p[0] - cx, p[1] - cy]);

  // Principal axis of the constellation, via the 2 x 2 covariance.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of out) {
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  const axis = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const rot = (input: number[][], ang: number) => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return input.map(([x, y]) => [c * x - s * y, s * x + c * y]);
  };
  out = rot(out, -axis);

  // Reflection is genuinely unknowable from distances. Tie it to node order so
  // the same measurements always produce the same picture.
  const firstOff = out.findIndex(([, y]) => Math.abs(y) > 1e-6);
  if (firstOff >= 0 && out[firstOff][1] < 0) out = out.map(([x, y]) => [x, -y]);

  if (flip) out = out.map(([x, y]) => [x, -y]);
  if (rotateDeg) out = rot(out, (rotateDeg * Math.PI) / 180);
  return out;
}

/**
 * Per-node position uncertainty from the geometry of its own measurements.
 *
 * Each measured edge constrains the node along one direction only, so the
 * covariance is (AtA)^-1 with rows being unit bearings scaled by 1/sigma — the
 * GDOP argument. Two edges pointing the same way constrain one direction twice
 * and the perpendicular not at all, which is exactly the case an operator
 * cannot see by eye and the number makes obvious.
 *
 * It is optimistic: neighbours have their own errors and this treats them as
 * fixed. The chi-square inflation in solveSurvey is what keeps it from being a
 * lie when the measurements disagree.
 */
function positionSigma(
  pts: number[][],
  edges: Clean["edges"],
  i: number,
  fallbackM: number
): { sigmaM: number; underdetermined: boolean } {
  let axx = 0;
  let axy = 0;
  let ayy = 0;
  let count = 0;
  for (const e of edges) {
    const j = e.i === i ? e.j : e.j === i ? e.i : -1;
    if (j < 0) continue;
    const dx = pts[i][0] - pts[j][0];
    const dy = pts[i][1] - pts[j][1];
    const dist = Math.hypot(dx, dy);
    if (dist < EPS) continue;
    const w = 1 / e.sigma;
    const ux = (dx / dist) * w;
    const uy = (dy / dist) * w;
    axx += ux * ux;
    axy += ux * uy;
    ayy += uy * uy;
    count++;
  }
  const det = axx * ayy - axy * axy;
  // A near-singular normal matrix is the collinear case: the perpendicular
  // direction is unconstrained, so quoting a small sigma would be the wrong
  // kind of confident.
  if (count < 2 || det <= 1e-9 * Math.max(axx * ayy, EPS)) {
    return { sigmaM: fallbackM, underdetermined: true };
  }
  const trace = (ayy + axx) / det; // trace of the 2 x 2 inverse
  return { sigmaM: Math.sqrt(trace / 2), underdetermined: false };
}

/**
 * Solve a set of measured distances into room coordinates.
 *
 * Returns null when there is nothing to solve — fewer than two nodes, or no
 * usable measurement. Callers should treat that as "not enough survey yet",
 * not as an error.
 */
export function solveSurvey(
  measurements: Measurement[],
  opts: SurveyOptions = {}
): SurveyResult | null {
  const room = opts.room ?? DEFAULT_ROOM_FRAME;
  const defaultSigmaM = opts.defaultSigmaM ?? METHOD_SIGMA_M.tape;
  const clean = cleanMeasurements(measurements, defaultSigmaM);
  if (clean.ids.length < 2 || clean.edges.length === 0) return null;

  const comp = largestComponent(clean.ids.length, clean.edges);
  if (comp.length < 2) return null;
  const inComp = new Set(comp);
  const excluded = clean.ids.filter((_, i) => !inComp.has(i));

  // Re-index onto the solvable component: an unreachable island carries its own
  // arbitrary rotation and translation, and no measurement ties the two gauges
  // together.
  const local = new Map(comp.map((globalI, i) => [globalI, i]));
  const ids = comp.map((i) => clean.ids[i]);
  const edges = clean.edges
    .filter((e) => local.has(e.i) && local.has(e.j))
    .map((e) => ({ i: local.get(e.i)!, j: local.get(e.j)!, d: e.d, sigma: e.sigma }));
  const n = ids.length;

  const complete = completeDistances(n, edges);
  const solved = smacof(classicalMds(complete), edges, opts.iterations ?? 300);

  // Weighted residuals first: they set the chi-square scale that every quoted
  // sigma is multiplied by, so a disagreeing tape widens the whole array's
  // uncertainty rather than hiding inside an optimistic number.
  const residuals: SurveyResidual[] = edges.map((e) => {
    const solvedM = Math.hypot(solved[e.i][0] - solved[e.j][0], solved[e.i][1] - solved[e.j][1]);
    const residualM = solvedM - e.d;
    return {
      a: ids[e.i],
      b: ids[e.j],
      measuredM: e.d,
      solvedM,
      residualM,
      sigmas: Math.abs(residualM) / e.sigma,
    };
  });
  const rmsResidualM =
    residuals.length > 0
      ? Math.sqrt(residuals.reduce((s, r) => s + r.residualM * r.residualM, 0) / residuals.length)
      : 0;

  // 2n - 3: two coordinates per node, minus the three gauge freedoms distances
  // can never fix (two of translation, one of rotation).
  const redundancy = edges.length - (2 * n - 3);
  let chiScale = 1;
  if (redundancy > 0) {
    const chi2 = residuals.reduce((s, r) => s + r.sigmas * r.sigmas, 0);
    chiScale = Math.max(1, Math.sqrt(chi2 / redundancy));
  }

  const oriented = canonicalise(solved, opts.rotateDeg ?? 0, opts.flip ?? false);

  const xs = oriented.map((p) => p[0]);
  const ys = oriented.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const extentM = { w: maxX - minX, h: maxY - minY };
  const radiusM = Math.max(EPS, Math.hypot(extentM.w, extentM.h) / 2);

  // Offset by the centre of the bounding box, not the centroid. A lopsided
  // array — two nodes close together and one far away — has its centre of mass
  // well off the middle of its own extent, so centring on the centroid pushes
  // the far node outside a frame that `fitsRoom` just called big enough. Using
  // the bounding-box centre makes `fitsRoom` mean what it says: true implies
  // every node landed inside.
  const offsetX = room.w / 2 - (minX + maxX) / 2;
  const offsetY = room.h / 2 - (minY + maxY) / 2;

  const nodes: SurveyNode[] = oriented.map((p, i) => {
    const { sigmaM, underdetermined } = positionSigma(oriented, edges, i, radiusM);
    return {
      node: ids[i],
      // Distances fix shape, not where the shape sits; the middle of the frame
      // is the only placement that does not favour a corner.
      x: p[0] + offsetX,
      y: p[1] + offsetY,
      sigmaM: underdetermined ? sigmaM : sigmaM * chiScale,
      degree: edges.filter((e) => e.i === i || e.j === i).length,
      underdetermined,
    };
  });

  return {
    nodes,
    excluded,
    residuals: [...residuals].sort((a, b) => b.sigmas - a.sigmas),
    rmsResidualM,
    worstSigmas: residuals.reduce((m, r) => Math.max(m, r.sigmas), 0),
    redundancy,
    aspect: axisRatio(oriented),
    extentM,
    fitsRoom: extentM.w <= room.w + EPS && extentM.h <= room.h + EPS,
  };
}
