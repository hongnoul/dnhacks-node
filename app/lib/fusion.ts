// fusion.ts — Bayesian occupancy grid over the room.
//
// Only scalars cross the wire (ARCHITECTURE.md §6), so there is no audio to
// cross-correlate and no TDOA. Fusion is a posterior over where the source could
// be, given what every node reports — including nodes reporting nothing.
//
// WHICH SCALAR MATTERS
//
// `p` alone is nearly useless for position. A detect/don't-detect observation
// says only "inside or outside a fuzzy disk", so the posterior stays broad no
// matter how many nodes report; measured spread barely moves from 2 nodes to 6.
// Worse, when p is well calibrated the per-node likelihood is p·P_d+(1−p)(1−P_d)
// = P_d²+(1−P_d)², which is *minimised* at P_d=0.5 — a source at the true
// half-detection radius is actively penalised.
//
// `snr_db` is a graded measurement that falls predictably with distance, so each
// node contributes an annulus rather than a disk, and three of them intersect to
// a point. This is why §6.2 insists the wire carries SNR alongside p: detection
// survives a saturated model, localisation does not.
//
// So: SNR-based likelihood when available, detection-based as a documented
// fallback. Pure and browser-free, so it unit-tests directly.

export interface Room {
  w: number; // metres
  h: number;
}

export interface Placed {
  node: string;
  x: number;
  y: number;
  /**
   * 1-sigma on this position, metres. Undefined means unstated, which is
   * treated as "trust the coordinate" — the pre-survey behaviour.
   */
  sigmaM?: number;
}

export interface NodeReading {
  node: string;
  p: number; // raw CRNN score, 0..1
  snrDb?: number | null; // graded level — carries the range information
  /** The node's own latched verdict (detection.ts). Absent for synthetic data. */
  detecting?: boolean;
}

/** Detection probability vs distance. Fallback path, and used for `nSilent`. */
export interface SensorModel {
  d0: number; // half-detection distance, metres
  w: number; // softness of the falloff
  pmin: number;
  pmax: number;
}

/**
 * Level vs distance. Spherical spreading is 20·log10(d), which is the dominant
 * term indoors at these ranges.
 *
 * These defaults are a placeholder. Fit them in the actual room before trusting
 * a fused position — reverberation flattens the curve far more than
 * inverse-square intuition suggests (§8.1, §13.1).
 */
export interface RangeModel {
  snrRefDb: number; // expected SNR at dRefM
  dRefM: number;
  sigmaDb: number; // measurement noise
  floorDb: number; // at or below this, the observation is censored
}

export const DEFAULT_MODEL: SensorModel = { d0: 4.0, w: 1.5, pmin: 0.02, pmax: 0.98 };
/**
 * Levels are absolute dBFS (scoring.ts), so the reference is "what a drone
 * measures at 1 m" and the floor is "quiet room". Placeholders: fit them in the
 * actual room (§8.1) before trusting a fused position.
 */
export const DEFAULT_RANGE: RangeModel = {
  snrRefDb: -20, // dBFS at 1 m
  dRefM: 1,
  // Measurement noise in dB. This is the knob that decides how sharp a fix can
  // be, so it should reflect reality rather than optimism: 4 dB fits phones of
  // the same model in one room. Cross-device gain differences are larger, and
  // are exactly what the §8.1 calibration pass is for — raise this until it
  // matches what you actually measure, and accept the wider posterior.
  sigmaDb: 4,
  floorDb: -55, // at or below: heard nothing
};

export function detectionProb(d: number, m: SensorModel = DEFAULT_MODEL): number {
  return m.pmin + (m.pmax - m.pmin) / (1 + Math.exp((d - m.d0) / m.w));
}

export function expectedSnr(d: number, m: RangeModel = DEFAULT_RANGE): number {
  return m.snrRefDb - 20 * Math.log10(Math.max(d, m.dRefM) / m.dRefM);
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

/** dB of level change per fractional change in range, from 20·log10. */
const DB_PER_FRACTIONAL_RANGE = 20 / Math.LN10; // 8.686

/**
 * Level uncertainty for one node, folding in how well its position is known.
 *
 * §13 promises `sigma_m` "feeds fusion weighting" and this is where it does.
 * Differentiating `expectedSnr` gives 8.686/d dB per metre of range error, so a
 * node whose own position is uncertain by σ metres cannot predict its level to
 * better than 8.686·σ/d dB no matter how good its microphone is. The two
 * uncertainties are independent, so they add in quadrature.
 *
 * Note the 1/d: position error matters enormously up close and barely at all far
 * away. A node surveyed to ±1 m contributes ~8.7 dB of slop to a source 1 m
 * away — swamping the 4 dB measurement noise — and ~0.9 dB to one 10 m away.
 * That is the correct shape: near a node, small displacements change the level a
 * lot. Getting this wrong in the optimistic direction is how a demo produces a
 * confident fix from dragged markers.
 */
export function effectiveSigmaDb(d: number, m: RangeModel, sigmaPosM?: number): number {
  if (!sigmaPosM || !Number.isFinite(sigmaPosM) || sigmaPosM <= 0) return m.sigmaDb;
  const range = Math.max(d, m.dRefM); // same clamp expectedSnr uses
  return Math.hypot(m.sigmaDb, (DB_PER_FRACTIONAL_RANGE * sigmaPosM) / range);
}

/**
 * P(observed level | source at distance d). Censored below the noise floor.
 *
 * The `1/sigma` on the Gaussian branch is load-bearing now and was not before.
 * While sigma was a single constant it was the same factor in every cell and
 * divided out in normalisation, so dropping it was harmless. `effectiveSigmaDb`
 * makes sigma depend on the distance being evaluated — 17.8 dB at 1 m versus
 * 4.4 dB at 10 m for a node known to ±2 m — so it no longer cancels. Without
 * it, wide-sigma cells get scored as if they were as informative as narrow ones
 * and the posterior drifts toward whichever node is worst surveyed.
 */
function snrLikelihood(snrDb: number, d: number, m: RangeModel, sigmaDb: number): number {
  const mu = expectedSnr(d, m);
  if (snrDb <= m.floorDb) {
    // Heard nothing: we know only that the true level was under the floor.
    // This is what makes silence informative without inventing a range. Already
    // a probability, so it takes no density normaliser.
    return normCdf((m.floorDb - mu) / sigmaDb);
  }
  const z = (snrDb - mu) / sigmaDb;
  return Math.exp(-0.5 * z * z) / sigmaDb;
}

export interface Estimate {
  nx: number;
  ny: number;
  cellM: number;
  posterior: Float32Array; // normalised, row-major
  x: number; // MAP estimate, metres
  y: number;
  /** Equivalent radius of the 90% credible region. Honest uncertainty. */
  spreadM: number;
  nReports: number;
  nSilent: number;
  /** False when no reading carried SNR, so position came from the weak path. */
  graded: boolean;
  /**
   * False when the credible region covers so much of the room that the MAP cell
   * is not a meaningful fix.
   *
   * This is the case where a demo lies most easily: several nodes hearing the
   * same thing at the same level constrain nothing, the posterior goes nearly
   * flat, and the argmax lands in an arbitrary corner. Drawing a marker there
   * claims precision that does not exist, so callers should suppress it and say
   * "detected, not localised".
   */
  localised: boolean;
}

/** Fraction of the room's equivalent radius beyond which a fix is meaningless. */
export const LOCALISED_MAX_FRACTION = 0.6;

/**
 * Goodness-of-fit gate, in multiples of each node's own effective sigma
 * (measurement noise combined with its position uncertainty, see
 * `effectiveSigmaDb`).
 *
 * Spread alone cannot tell a real fix from a degenerate one: several nodes
 * hearing the same thing at the same level produce a *tight looking* posterior
 * in an arbitrary place. Residuals can. If the source really were at the MAP,
 * each node's observed level would match what that distance predicts; when the
 * readings are consistent with no single position, the residuals blow up.
 */
export const MAX_RESIDUAL_SIGMAS = 3;

// A node counts as silent when its own latch says it hears nothing. Falling
// back to a bare threshold keeps synthetic test data working.
const SILENT_BELOW = 0.22; // SkyMesh's MARGINAL_FLOOR
const hears = (r: NodeReading) =>
  typeof r.detecting === "boolean" ? r.detecting : r.p >= SILENT_BELOW;

export function fuse(opts: {
  room: Room;
  positions: Map<string, Placed>;
  readings: NodeReading[];
  model?: SensorModel;
  range?: RangeModel;
  cellM?: number;
}): Estimate | null {
  const model = opts.model ?? DEFAULT_MODEL;
  const range = opts.range ?? DEFAULT_RANGE;
  const cellM = opts.cellM ?? 0.25;

  const used = opts.readings
    .map((r) => ({ r, pos: opts.positions.get(r.node) }))
    .filter((e): e is { r: NodeReading; pos: Placed } => !!e.pos);
  if (used.length === 0) return null;

  const graded = used.some((e) => typeof e.r.snrDb === "number");

  const nx = Math.max(1, Math.ceil(opts.room.w / cellM));
  const ny = Math.max(1, Math.ceil(opts.room.h / cellM));
  const logL = new Float64Array(nx * ny);

  // Log space: a 48x32 grid times a dozen nodes underflows otherwise.
  for (let iy = 0; iy < ny; iy++) {
    const cy = (iy + 0.5) * cellM;
    for (let ix = 0; ix < nx; ix++) {
      const cx = (ix + 0.5) * cellM;
      let ll = 0;
      for (const { r, pos } of used) {
        const d = Math.hypot(cx - pos.x, cy - pos.y);
        // A node whose own latch says it hears nothing is a *censored*
        // observation — it bounds the distance from below rather than measuring
        // it. Feeding its ambient room level in as a range measurement would
        // place a phantom source at whatever distance that noise implies, which
        // is the common case: real ambient sits well above the nominal floor,
        // so the censored branch almost never fired on its own.
        const silent = r.detecting === false;
        const lik =
          typeof r.snrDb === "number"
            ? snrLikelihood(
                silent ? range.floorDb : r.snrDb,
                d,
                range,
                effectiveSigmaDb(d, range, pos.sigmaM)
              )
            : // Fallback: soft detection evidence. Coarse by construction.
              r.p * detectionProb(d, model) + (1 - r.p) * (1 - detectionProb(d, model));
        ll += Math.log(Math.max(lik, 1e-12));
      }
      logL[iy * nx + ix] = ll;
    }
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

  let bestI = 0;
  for (let i = 1; i < posterior.length; i++) if (posterior[i] > posterior[bestI]) bestI = i;

  // 90% credible region by mass, reported as an equivalent radius.
  const order = [...posterior].sort((a, b) => b - a);
  let acc = 0;
  let cells = 0;
  for (const v of order) {
    acc += v;
    cells++;
    if (acc >= 0.9) break;
  }

  const spreadM = Math.sqrt((cells * cellM * cellM) / Math.PI);
  const roomRadiusM = Math.sqrt((opts.room.w * opts.room.h) / Math.PI);
  const mapX = ((bestI % nx) + 0.5) * cellM;
  const mapY = (Math.floor(bestI / nx) + 0.5) * cellM;

  // Does a source at the MAP actually explain what the nodes measured?
  let localised: boolean;
  if (graded) {
    let sq = 0;
    let n = 0;
    for (const { r, pos } of used) {
      if (typeof r.snrDb !== "number") continue;
      const d = Math.hypot(mapX - pos.x, mapY - pos.y);
      // A censored reading only says "below the floor"; it cannot be residual-checked.
      if (r.detecting === false || r.snrDb <= range.floorDb) continue;
      // Normalised by each node's own effective sigma, so a node with a stated
      // position uncertainty is not judged against a precision it never claimed.
      //
      // Note what this does *not* do: a dragged marker publishes no `sigma_m`
      // at all, so it falls back to the bare measurement noise and is held to
      // the tightest standard of any node here. That is backwards on its face,
      // and it is why the survey exists — the fix is to state an uncertainty,
      // not to invent one for a drag whose real error nobody measured.
      const resid = (r.snrDb - expectedSnr(d, range)) / effectiveSigmaDb(d, range, pos.sigmaM);
      sq += resid * resid;
      n++;
    }
    const rms = n > 0 ? Math.sqrt(sq / n) : Infinity;
    // Residuals alone are not enough: a single graded reading fits its own
    // annulus perfectly (residual 0) while the posterior covers most of the
    // room. Both tests have to pass — consistent AND actually constrained.
    localised =
      n > 0 &&
      rms <= MAX_RESIDUAL_SIGMAS &&
      spreadM < LOCALISED_MAX_FRACTION * roomRadiusM;
  } else {
    localised = spreadM < LOCALISED_MAX_FRACTION * roomRadiusM;
  }

  return {
    nx,
    ny,
    cellM,
    posterior,
    x: mapX,
    y: mapY,
    spreadM,
    localised,
    nReports: used.filter((e) => hears(e.r)).length,
    nSilent: used.filter((e) => !hears(e.r)).length,
    graded,
  };
}
