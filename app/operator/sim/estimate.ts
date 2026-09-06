// estimate.ts — what one node thinks it knows about where the drone is.
//
// A Bayesian occupancy grid over the area, computed from a *single node's
// replica*. Estimates are never gossiped: a fused position is a deterministic
// function of evidence the node already holds, so replicating conclusions would
// duplicate the mesh's reasoning N times for no information gain. Replicate
// evidence, derive conclusions (ARCHITECTURE.md §10).
//
// That is what makes the viewpoint toggle honest rather than a UI trick — asking
// "what does n3 think?" really is running this over n3's records, and two nodes
// disagree exactly when their replicas differ.
//
// The likelihood mirrors sim-demo/app/lib/fusion.ts: a Gaussian on the level
// channel with a censored tail below the noise floor. `p` alone cannot localise
// — a detect/don't-detect observation is a fuzzy disk, not a range — which is
// the failure §6.2 documents as measured, not predicted.

import {
  distanceM,
  makeFrame,
  toXY,
  type Area,
  type Site,
} from "../placement.ts";

/** Expected level at 1 m, dBFS. */
export const SNR_REF_DB = -20;

/** Measurement noise on the level channel, dB. */
export const SNR_SIGMA_DB = 4;

/** At or below this, the observation is censored: "heard nothing". */
export const SNR_FLOOR_DB = -75;

/**
 * Fraction of the area's equivalent radius beyond which a fix means nothing.
 *
 * Generous, and deliberately so. Level falls 6 dB per doubling of range, so 4 dB
 * of measurement noise is a ~58% distance uncertainty: a *correct* three-node
 * fix measured 6 m from the truth still carried a 243 m credible region across a
 * 440 m area — ratio 0.55. Tightening this would reject good fixes for being
 * honest about their uncertainty.
 */
export const LOCALISED_MAX_FRACTION = 0.7;

/**
 * Goodness-of-fit gate, in multiples of sigma.
 *
 * 2, not 3, and this is the gate that does the real work. Measured: four nodes
 * reporting an identical level — consistent with no single source position —
 * produced a *tighter* posterior (133 m) than a genuine fix (243 m), so spread
 * alone would have accepted the fake and rejected the real one. Their residuals
 * separate cleanly instead: 11.5 dB against 0. At 3σ = 12 dB the degenerate case
 * slipped under the bar by half a decibel.
 */
export const MAX_RESIDUAL_SIGMAS = 2;

/** Spherical spreading. The dominant term at these ranges. */
export function expectedSnrDb(d: number): number {
  return SNR_REF_DB - 20 * Math.log10(Math.max(d, 1));
}

// Abramowitz & Stegun 7.1.26 — plenty for a likelihood weight.
function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
}

const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export interface EstimateReading {
  origin: string;
  /** The node's own latched verdict. */
  d: boolean;
  snr_db: number | null;
}

export interface NodeEstimate {
  nx: number;
  ny: number;
  area: Area;
  /** Normalised posterior, row-major, south row first. */
  posterior: Float32Array;
  lat: number;
  lon: number;
  /** Equivalent radius of the 90% credible region, metres. */
  spreadM: number;
  nReports: number;
  nSilent: number;
  /**
   * True when the peak sits on the edge of the solved grid.
   *
   * Then the box has cut the distribution off rather than contained it, and
   * the argmax is wherever the boundary happened to fall. Exposed so the UI
   * can say "off that way, further than we can solve" instead of drawing a
   * position.
   */
  edgePinned: boolean;
  /**
   * False when the posterior is too broad, when its peak is pinned to the edge
   * of the grid, or when no source at the peak would explain the levels
   * actually reported.
   *
   * This is where a demo lies most easily: several nodes hearing the same thing
   * at the same level constrain nothing, the posterior goes nearly flat, and the
   * argmax lands in an arbitrary corner. Drawing a marker there claims precision
   * that does not exist (IMPLEMENTATION.md §12).
   */
  localised: boolean;
}

/**
 * Fuse one node's freshest readings into a posterior over source position.
 *
 * `positions` is the geometry every node knows (the operator placed the
 * sensors). `readings` is what *this* node holds, which is the part that varies
 * between nodes and the reason two of them can disagree.
 */
export function estimateFrom(
  readings: EstimateReading[],
  positions: Map<string, Site>,
  area: Area,
  opts: { nx?: number; ny?: number } = {}
): NodeEstimate | null {
  const nx = opts.nx ?? 32;
  const ny = opts.ny ?? 32;

  const used = readings
    .map((r) => ({ r, pos: positions.get(r.origin) }))
    .filter((e): e is { r: EstimateReading; pos: Site } => !!e.pos);
  if (used.length === 0) return null;

  const frame = makeFrame((area.south + area.north) / 2, (area.west + area.east) / 2);
  const pts = used.map((e) => toXY(frame, e.pos.lat, e.pos.lon));

  const logL = new Float64Array(nx * ny);
  const cell: [number, number][] = [];
  for (let iy = 0; iy < ny; iy++) {
    const lat = area.south + ((iy + 0.5) / ny) * (area.north - area.south);
    for (let ix = 0; ix < nx; ix++) {
      const lon = area.west + ((ix + 0.5) / nx) * (area.east - area.west);
      cell.push(toXY(frame, lat, lon));
    }
  }

  // Log space: a 32x32 grid times a dozen nodes underflows otherwise.
  for (let c = 0; c < nx * ny; c++) {
    const [sx, sy] = cell[c];
    let ll = 0;
    for (let i = 0; i < used.length; i++) {
      const { r } = used[i];
      const d = Math.hypot(sx - pts[i][0], sy - pts[i][1]);
      const mu = expectedSnrDb(d);
      // A node whose own latch says it hears nothing is a *censored*
      // observation: it bounds the distance from below rather than measuring
      // it. Feeding its ambient level in as a range would plant a phantom
      // source at whatever that noise implies.
      const lik =
        !r.d || r.snr_db === null
          ? normCdf((SNR_FLOOR_DB - mu) / SNR_SIGMA_DB)
          : Math.exp(-0.5 * ((r.snr_db - mu) / SNR_SIGMA_DB) ** 2);
      ll += Math.log(Math.max(lik, 1e-12));
    }
    logL[c] = ll;
  }

  let max = -Infinity;
  for (const v of logL) if (v > max) max = v;
  const posterior = new Float32Array(nx * ny);
  let sum = 0;
  for (let i = 0; i < logL.length; i++) {
    const w = Math.exp(logL[i] - max);
    posterior[i] = w;
    sum += w;
  }
  for (let i = 0; i < posterior.length; i++) posterior[i] /= sum;

  let best = 0;
  for (let i = 1; i < posterior.length; i++) if (posterior[i] > posterior[best]) best = i;

  // 90% credible region by mass, reported as an equivalent radius.
  const order = [...posterior].sort((a, b) => b - a);
  let acc = 0;
  let cells = 0;
  for (const v of order) {
    acc += v;
    cells++;
    if (acc >= 0.9) break;
  }

  const spanY = distanceM(area.south, area.west, area.north, area.west);
  const spanX = distanceM(area.south, area.west, area.south, area.east);
  const cellArea = (spanX / nx) * (spanY / ny);
  const spreadM = Math.sqrt((cells * cellArea) / Math.PI);
  const areaRadiusM = Math.sqrt((spanX * spanY) / Math.PI);

  const bx = best % nx;
  const by = Math.floor(best / nx);
  const lat = area.south + ((by + 0.5) / ny) * (area.north - area.south);
  const lon = area.west + ((bx + 0.5) / nx) * (area.east - area.west);

  // Does a source at the peak actually explain what the nodes measured?
  // Spread alone cannot tell a real fix from a degenerate one — several nodes
  // hearing the same thing at the same level produce a tight-looking posterior
  // in an arbitrary place. Residuals can.
  const [px, py] = toXY(frame, lat, lon);
  let sq = 0;
  let n = 0;
  for (let i = 0; i < used.length; i++) {
    const { r } = used[i];
    if (!r.d || r.snr_db === null) continue;
    const d = Math.hypot(px - pts[i][0], py - pts[i][1]);
    const resid = r.snr_db - expectedSnrDb(d);
    sq += resid * resid;
    n++;
  }
  const rms = n > 0 ? Math.sqrt(sq / n) : Infinity;
  const nReports = used.filter((e) => e.r.d).length;

  /**
   * Is the peak against the wall of the grid?
   *
   * A silent node is a censored observation: it bounds the source *away* from
   * itself, and that pushes probability outward with nothing to stop it. So a
   * mesh that is mostly quiet has a posterior with no compact support, and the
   * argmax lands wherever the grid happens to end. The residual test cannot
   * catch this — one detecting node fits its own annulus perfectly at any
   * point along it, including the corner — and neither can the spread test,
   * because truncation is what makes the retained mass look compact. Without
   * this the map draws a confident marker hundreds of metres from the source,
   * on the boundary of a box the operator cannot even see.
   */
  const edgePinned = bx === 0 || by === 0 || bx === nx - 1 || by === ny - 1;

  return {
    nx,
    ny,
    area,
    posterior,
    lat,
    lon,
    spreadM,
    nReports,
    nSilent: used.length - nReports,
    // Both tests have to pass: consistent AND actually constrained. One graded
    // reading fits its own annulus perfectly while the posterior covers the map.
    edgePinned,
    localised:
      n > 0 &&
      !edgePinned &&
      rms <= MAX_RESIDUAL_SIGMAS * SNR_SIGMA_DB &&
      spreadM < LOCALISED_MAX_FRACTION * areaRadiusM,
  };
}
