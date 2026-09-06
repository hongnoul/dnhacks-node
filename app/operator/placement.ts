// placement.ts — where should the next sensor go?
//
// The map already answers "is this spot legal?" with three constants
// (MIN_NODE_DISTANCE_M, MAX_LINK_DISTANCE_M, MIN_CONNECTIONS). This module
// answers the harder question: "of every legal spot, which one is best?"
//
// WHY THIS IS COMPUTABLE AND NOT A GUESS
//
// A node measures how loud the drone is, and level falls with distance as
// 20·log10(d). So each node contributes a *range* measurement, and the geometry
// of the array decides how well those ranges intersect. That is exactly the
// setting the Cramér–Rao lower bound was built for: given the sensor positions
// and the measurement noise, there is a closed-form floor on how precisely any
// estimator could ever locate a source. No model to train, no data to fit — the
// answer falls out of the forward model the simulation already assumes.
//
// The Fisher information a node at x contributes about a source at s:
//
//   z(s) = A − 20·log10(d)            d = ‖s − x‖
//   ∂z/∂s = −(K/d)·û                  K = 20/ln10 ≈ 8.686 dB per metre-e-fold
//   J     = (K² / (σ² d²))·û ûᵀ       û = (s − x)/d
//
// Two terms, and both matter:
//
//   1/d²   — information decays with distance. This is coverage.
//   û ûᵀ   — a rank-1 outer product, so *direction* matters. Nodes bunched on
//            one bearing all measure nearly the same û, the summed matrix stays
//            near-singular, and the position is unconstrained along the
//            perpendicular. This is the "all the phones are along one wall"
//            failure, and it is why a coverage map alone is not enough.
//
// det(FIM)^(−1/4) is then the equivalent radius, in metres, of the 1σ error
// ellipse — one honest scalar per candidate source position.
//
// Deliberately free of React, Leaflet and browser APIs so it unit-tests under
// plain `node --test`.

// ---------------------------------------------------------------------------
// Constraints — the placement rules the operator map already enforces.
// They live here rather than in the component so the optimiser and the hover
// preview cannot drift apart: one definition of "legal spot", used by both.
// ---------------------------------------------------------------------------

/** No two sensors closer than this — co-located nodes measure the same thing. */
export const MIN_NODE_DISTANCE_M = 100;
/** Radio range: beyond this, two nodes cannot form a link. */
export const MAX_LINK_DISTANCE_M = 150;
/** A node with one link is a leaf, and a leaf is a single point of failure. */
export const MIN_CONNECTIONS = 2;
/** Half-detection distance for the acoustic model. */
export const DRONE_DETECTION_RADIUS_M = 140;

// ---------------------------------------------------------------------------
// Sensor model
// ---------------------------------------------------------------------------

export interface SensorModel {
  /** Half-detection distance, metres. */
  d0: number;
  /** Softness of the falloff. */
  w: number;
  pmin: number;
  pmax: number;
}

/** Same logistic shape as sim-demo's fusion.ts, tuned to this map's radius. */
export const DEFAULT_SENSOR: SensorModel = {
  d0: DRONE_DETECTION_RADIUS_M,
  w: 35,
  pmin: 0.02,
  pmax: 0.98,
};

/**
 * Level measurement noise, dB.
 *
 * 4 dB is sim-demo's measured value for phones of the same model in one room
 * (fusion.ts DEFAULT_RANGE.sigmaDb). It is the knob that decides how sharp a fix
 * can be, so it should reflect what you actually measured rather than optimism —
 * cross-device gain differences are larger than this.
 */
export const SIGMA_DB = 4;

/** 20/ln10 — the level gradient constant, dB per metre at unit distance. */
const K = 20 / Math.LN10;

/**
 * Distance floor for the information calculation.
 *
 * The 1/d² term diverges as a source approaches a node, which would let the
 * optimiser claim unbounded precision for a cell sitting exactly on a sensor.
 * Mirrors the `Math.max(d, dRefM)` guard in sim-demo's expectedSnr().
 */
export const D_MIN_M = 10;

/**
 * Ceiling on reported position error, metres.
 *
 * A cell no node can hear has zero information and an infinite bound. Capping
 * makes the aggregate finite, and it also quietly does the right thing: an
 * uncovered cell contributes the cap, so *closing a coverage hole* and
 * *sharpening a fix* both reduce the same objective. Coverage does not need its
 * own term — it falls out.
 */
export const CRLB_CAP_M = 400;

/** At or below this error, a fix is as good as this array will ever get. */
export const CRLB_FLOOR_M = 15;

/**
 * What one articulation point costs, expressed in metres of position error.
 *
 * The two goals genuinely compete: the acoustically ideal spot is often the far
 * corner, which is exactly where a node is out of radio range of everything and
 * hangs off the mesh by a single link. Rather than hide that trade in a
 * dimensionless weight, price it in the same unit as the other term — "we treat
 * one cut vertex as worth 25 m of localisation error" is a claim an operator can
 * argue with, which is the point.
 */
export const ARTICULATION_COST_M = 25;

export function detectionProb(d: number, m: SensorModel = DEFAULT_SENSOR): number {
  return m.pmin + (m.pmax - m.pmin) / (1 + Math.exp((d - m.d0) / m.w));
}

// ---------------------------------------------------------------------------
// Geometry — a local metric frame, so the inner loop is flat arithmetic
// ---------------------------------------------------------------------------

export interface Site {
  lat: number;
  lon: number;
}

export interface SensorSite extends Site {
  id: string;
}

const LAT_SCALE = 111_320;

/** Equirectangular distance. Exact enough over a few km, and cheap. */
export function distanceM(
  firstLat: number,
  firstLon: number,
  secondLat: number,
  secondLon: number
): number {
  const lonScale = LAT_SCALE * Math.cos((firstLat * Math.PI) / 180);
  return Math.hypot((firstLat - secondLat) * LAT_SCALE, (firstLon - secondLon) * lonScale);
}

export interface Frame {
  lat0: number;
  lon0: number;
  lonScale: number;
}

/**
 * Freeze one metric frame for the whole computation.
 *
 * Everything downstream works in metres from an origin, so the grid loop never
 * calls cos() or hypot() on degrees — it matters at ~4M inner iterations.
 */
export function makeFrame(lat0: number, lon0: number): Frame {
  return { lat0, lon0, lonScale: LAT_SCALE * Math.cos((lat0 * Math.PI) / 180) };
}

export function toXY(frame: Frame, lat: number, lon: number): [number, number] {
  return [(lon - frame.lon0) * frame.lonScale, (lat - frame.lat0) * LAT_SCALE];
}

export function toLatLon(frame: Frame, x: number, y: number): [number, number] {
  return [frame.lat0 + y / LAT_SCALE, frame.lon0 + x / frame.lonScale];
}

// ---------------------------------------------------------------------------
// Fisher information
// ---------------------------------------------------------------------------

/** Symmetric 2x2, stored flat. */
export interface Fim {
  xx: number;
  xy: number;
  yy: number;
}

/**
 * Information a sensor at (nx, ny) carries about a source at (sx, sy).
 *
 * Weighted by detection probability: a node too far to hear the drone supplies
 * no level measurement, so it supplies no information about position. (Silence
 * is genuinely informative — sim-demo's fusion treats it as a censored
 * observation that bounds distance from below — but the CRLB here is the bound
 * on the *detected* measurement, and claiming the negative evidence too would
 * overstate what the array can do.)
 */
export function sensorInfo(sx: number, sy: number, nx: number, ny: number): Fim {
  const dx = sx - nx;
  const dy = sy - ny;
  const raw = Math.hypot(dx, dy);
  // Direction is undefined at zero range, and a range-only sensor genuinely
  // carries no bearing information about a source sitting on top of it.
  if (raw < 1e-6) return { xx: 0, xy: 0, yy: 0 };
  const d = Math.max(raw, D_MIN_M);
  const w = detectionProb(raw);
  // (K/d)²·w/σ² times û ûᵀ. The clamp bounds the gradient *magnitude* only —
  // û stays a unit vector, so dividing by raw² is correct and not a typo.
  const g = (K * K * w) / (SIGMA_DB * SIGMA_DB * d * d * raw * raw);
  return { xx: g * dx * dx, xy: g * dx * dy, yy: g * dy * dy };
}

/**
 * The body of sensorInfo, accumulated in place.
 *
 * The grid loops run ~4M cell-node pairs per suggestion request, and returning a
 * fresh Fim object for each one is the difference between a responsive button
 * and a visible stall. sensorInfo above stays the readable reference — a test
 * asserts the two agree, so this stays honest.
 */
function accumulate(out: Fim, sx: number, sy: number, nx: number, ny: number): void {
  const dx = sx - nx;
  const dy = sy - ny;
  const r2 = dx * dx + dy * dy;
  if (r2 < 1e-12) return;
  const raw = Math.sqrt(r2);
  const d = raw < D_MIN_M ? D_MIN_M : raw;
  const w =
    DEFAULT_SENSOR.pmin +
    (DEFAULT_SENSOR.pmax - DEFAULT_SENSOR.pmin) /
      (1 + Math.exp((raw - DEFAULT_SENSOR.d0) / DEFAULT_SENSOR.w));
  const g = (K * K * w) / (SIGMA_DB * SIGMA_DB * d * d * r2);
  out.xx += g * dx * dx;
  out.xy += g * dx * dy;
  out.yy += g * dy * dy;
}

/**
 * Equivalent radius of the 1σ error ellipse, metres.
 *
 * area = π/√det, so radius = √(area/π) = det^(−1/4). A singular matrix means the
 * source is unconstrained along at least one direction — report the cap rather
 * than Infinity so aggregates stay finite.
 */
export function crlbRadiusM(fim: Fim): number {
  const det = fim.xx * fim.yy - fim.xy * fim.xy;
  if (!(det > 0)) return CRLB_CAP_M;
  return Math.min(Math.pow(det, -0.25), CRLB_CAP_M);
}

// ---------------------------------------------------------------------------
// The quality grid
// ---------------------------------------------------------------------------

export interface Area {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface QualityGrid {
  nx: number;
  ny: number;
  /** CRLB equivalent radius per cell, row-major, metres. Lower is better. */
  radiusM: Float32Array;
  area: Area;
  /**
   * Mean radius over *all* cells — the scalar the optimiser minimises.
   *
   * Blind cells contribute the cap, which is what makes closing a coverage hole
   * and sharpening a fix the same objective. That also makes this number a poor
   * headline: over a sparse array most cells are blind, so it reads as "±300 m"
   * and says more about how much empty ground was evaluated than about the
   * array. Rank with it; show medianCoveredRadiusM instead.
   */
  meanRadiusM: number;
  /**
   * Typical position error over the ground the array can actually hear.
   *
   * Median rather than mean so one unreachable corner cannot drag it, and
   * restricted to covered cells so it answers the operator's real question:
   * "when my sensors do detect something, how well do I know where it is?"
   */
  medianCoveredRadiusM: number;
  /** Fraction of cells any node would detect a source in, at P_d >= 0.5. */
  coverage: number;
}

/** Bounding box of the sites, expanded by a margin in metres. */
export function areaAround(sites: Site[], marginM: number): Area {
  if (sites.length === 0) return { south: 0, west: 0, north: 0, east: 0 };
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const s of sites) {
    south = Math.min(south, s.lat);
    north = Math.max(north, s.lat);
    west = Math.min(west, s.lon);
    east = Math.max(east, s.lon);
  }
  const lonScale = LAT_SCALE * Math.cos((((south + north) / 2) * Math.PI) / 180);
  const dLat = marginM / LAT_SCALE;
  const dLon = marginM / lonScale;
  return {
    south: south - dLat,
    north: north + dLat,
    west: west - dLon,
    east: east + dLon,
  };
}

/** Cell centres of an nx-by-ny grid over `area`, in the given metric frame. */
function cellCentres(area: Area, frame: Frame, nx: number, ny: number): Float64Array {
  const out = new Float64Array(nx * ny * 2);
  for (let iy = 0; iy < ny; iy++) {
    const lat = area.south + ((iy + 0.5) / ny) * (area.north - area.south);
    for (let ix = 0; ix < nx; ix++) {
      const lon = area.west + ((ix + 0.5) / nx) * (area.east - area.west);
      const [x, y] = toXY(frame, lat, lon);
      const i = (iy * nx + ix) * 2;
      out[i] = x;
      out[i + 1] = y;
    }
  }
  return out;
}

export interface GridOptions {
  nx?: number;
  ny?: number;
}

/**
 * Localisation quality over the area, one CRLB radius per cell.
 *
 * This is the layer the operator sees: bright where a source could be pinned
 * down, dark where the array is blind or the geometry is degenerate.
 */
export function qualityGrid(
  nodes: SensorSite[],
  area: Area,
  opts: GridOptions = {}
): QualityGrid {
  const nx = opts.nx ?? 48;
  const ny = opts.ny ?? 48;
  const frame = makeFrame((area.south + area.north) / 2, (area.west + area.east) / 2);
  const cells = cellCentres(area, frame, nx, ny);
  const pts = nodes.map((n) => toXY(frame, n.lat, n.lon));

  const radiusM = new Float32Array(nx * ny);
  let sum = 0;
  let covered = 0;
  const coveredRadii: number[] = [];

  const acc: Fim = { xx: 0, xy: 0, yy: 0 };
  for (let c = 0; c < nx * ny; c++) {
    const sx = cells[c * 2];
    const sy = cells[c * 2 + 1];
    acc.xx = 0;
    acc.xy = 0;
    acc.yy = 0;
    let nearest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      accumulate(acc, sx, sy, pts[i][0], pts[i][1]);
      const d = Math.hypot(sx - pts[i][0], sy - pts[i][1]);
      if (d < nearest) nearest = d;
    }
    const r = crlbRadiusM(acc);
    radiusM[c] = r;
    sum += r;
    if (detectionProb(nearest) >= 0.5) {
      covered++;
      coveredRadii.push(r);
    }
  }

  coveredRadii.sort((a, b) => a - b);

  return {
    nx,
    ny,
    radiusM,
    area,
    meanRadiusM: sum / (nx * ny),
    medianCoveredRadiusM: coveredRadii.length
      ? coveredRadii[coveredRadii.length >> 1]
      : CRLB_CAP_M,
    coverage: covered / (nx * ny),
  };
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

export type Edge = [string, string];

/** Links every pair within radio range. The map's own adjacency rule. */
export function rangeEdges(nodes: SensorSite[], maxM = MAX_LINK_DISTANCE_M): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (distanceM(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon) <= maxM) {
        out.push([nodes[i].id, nodes[j].id]);
      }
    }
  }
  return out;
}

/**
 * Cut vertices: nodes whose loss disconnects the mesh (Tarjan, iterative).
 *
 * This is the resilience half of the objective. A layout can have perfect
 * acoustic geometry and still lose half its picture to one casualty, and the
 * operator has no way to see that by looking at the map — an articulation point
 * looks exactly like any other node.
 *
 * Iterative rather than recursive so a long chain cannot blow the stack.
 */
export function articulationPoints(ids: string[], edges: Edge[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const [a, b] of edges) {
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const cuts = new Set<string>();
  let timer = 0;

  for (const root of ids) {
    if (disc.has(root)) continue;
    let rootChildren = 0;
    // Each frame tracks how far through its neighbour list we are.
    const stack: { v: string; i: number }[] = [{ v: root, i: 0 }];
    disc.set(root, timer);
    low.set(root, timer);
    timer++;
    parent.set(root, null);

    while (stack.length) {
      const frame = stack[stack.length - 1];
      const neighbours = adj.get(frame.v)!;
      if (frame.i < neighbours.length) {
        const to = neighbours[frame.i++];
        if (to === parent.get(frame.v)) continue;
        if (disc.has(to)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, disc.get(to)!));
          continue;
        }
        parent.set(to, frame.v);
        disc.set(to, timer);
        low.set(to, timer);
        timer++;
        if (frame.v === root) rootChildren++;
        stack.push({ v: to, i: 0 });
      } else {
        stack.pop();
        const p = parent.get(frame.v);
        if (p != null) {
          low.set(p, Math.min(low.get(p)!, low.get(frame.v)!));
          // A non-root is a cut vertex when a child's subtree cannot reach above it.
          if (p !== root && low.get(frame.v)! >= disc.get(p)!) cuts.add(p);
        }
      }
    }
    // The root is a cut vertex exactly when it has more than one DFS child.
    if (rootChildren > 1) cuts.add(root);
  }
  return cuts;
}

/** Is every node reachable from every other? */
export function isConnected(ids: string[], edges: Edge[]): boolean {
  if (ids.length <= 1) return true;
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const [a, b] of edges) {
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const seen = new Set<string>([ids[0]]);
  const queue = [ids[0]];
  while (queue.length) {
    const v = queue.shift()!;
    for (const to of adj.get(v)!) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen.size === ids.length;
}

// ---------------------------------------------------------------------------
// The suggestion search
// ---------------------------------------------------------------------------

export interface Suggestion {
  lat: number;
  lon: number;
  /** 1 is the best spot; 2 assumes 1 was taken, and so on. */
  rank: number;
  /** Mean CRLB radius the array would have with this node added, metres. */
  meanRadiusM: number;
  /**
   * Metres of mean position error *this* placement removes, given the
   * higher-ranked ones are already in.
   *
   * Marginal, not cumulative. Measured against the original baseline it would
   * grow down the list — rank 3 would post the largest number because it
   * silently includes ranks 1 and 2 — and a ranked list whose best-looking entry
   * sits at the bottom reads as broken. Marginal also shows the diminishing
   * returns that are actually there.
   */
  improvementM: number;
  /** Typical error over covered ground after the placement, metres. */
  medianCoveredRadiusM: number;
  /** Fraction of the area detectable after the placement. */
  coverage: number;
  /** Percentage points of coverage this placement adds. */
  coverageGain: number;
  /** Existing nodes within radio range — the links it would form. */
  neighbours: string[];
  /** Cut vertices remaining after the placement. */
  articulation: number;
  /**
   * Cut vertices this placement removes, given the higher-ranked ones are in.
   *
   * Marginal for the same reason improvementM is: ranks 2 and 3 are evaluated
   * against a mesh that already contains rank 1, so comparing them to the
   * original baseline would double-count what rank 1 already fixed.
   */
  articulationDelta: number;
}

export interface SuggestOptions extends GridOptions {
  /** How many suggestions to return. */
  count?: number;
  /** Candidate positions per axis. */
  candidatesPerAxis?: number;
  /**
   * Extra padding beyond the placement envelope, metres.
   *
   * The envelope is already the bounding box plus MAX_LINK_DISTANCE_M, because
   * a candidate further out than that could not link to anything and is not a
   * legal spot anyway. Padding past it only adds ground nobody is trying to
   * cover, which drags every aggregate toward "blind" and makes a decent array
   * look terrible.
   */
  marginM?: number;
  /**
   * The mesh as it actually stands.
   *
   * Passed in rather than derived from range, because the two are not the same
   * graph: the operator can wire links by hand, and the seeded demo network has
   * a 222 m link that the 150 m range rule would never create. Deriving it here
   * would mean the "single points of failure" count described a topology that is
   * drawn nowhere on the map.
   */
  edges?: Edge[];
}

export interface SuggestResult {
  suggestions: Suggestion[];
  /** Quality of the array as it stands, for comparison. */
  baselineMeanRadiusM: number;
  baselineMedianCoveredRadiusM: number;
  baselineCoverage: number;
  baselineArticulation: number;
  /** Candidate spots that passed the hard placement rules. */
  feasibleCount: number;
  area: Area;
}

/**
 * Rank legal placements by how much they improve the array.
 *
 * Greedy and sequential: suggestion 2 is computed with suggestion 1 already in
 * place, so the three spots returned complement each other instead of all
 * crowding into the same hole. That is worth the extra rounds — ranking one
 * pass of candidates by individual merit reliably returns three names for the
 * same gap.
 *
 * Cost is O(rounds × candidates × cells). At the defaults that is ~4M inner
 * iterations of flat arithmetic, which is a few tens of ms — fine for a button
 * press, and the reason the base information per cell is accumulated once per
 * round rather than per candidate.
 */
export function suggestPlacements(
  nodes: SensorSite[],
  opts: SuggestOptions = {}
): SuggestResult {
  const count = opts.count ?? 3;
  const perAxis = opts.candidatesPerAxis ?? 30;
  const marginM = opts.marginM ?? 0;
  const nx = opts.nx ?? 40;
  const ny = opts.ny ?? 40;

  const area = areaAround(
    nodes.length ? nodes : [{ lat: 0, lon: 0 }],
    marginM + MAX_LINK_DISTANCE_M
  );
  const frame = makeFrame((area.south + area.north) / 2, (area.west + area.east) / 2);
  const cells = cellCentres(area, frame, nx, ny);
  const nCells = nx * ny;

  const base = qualityGrid(nodes, area, { nx, ny });
  // The mesh as drawn, not as range would imply. Fall back to range only when
  // the caller has no topology of its own to offer.
  const baseEdges = opts.edges ?? rangeEdges(nodes);
  const baselineArticulation = articulationPoints(nodes.map((n) => n.id), baseEdges).size;

  // Candidate positions, as a coarser grid over the same area.
  const candidates: { lat: number; lon: number; x: number; y: number }[] = [];
  for (let iy = 0; iy < perAxis; iy++) {
    const lat = area.south + ((iy + 0.5) / perAxis) * (area.north - area.south);
    for (let ix = 0; ix < perAxis; ix++) {
      const lon = area.west + ((ix + 0.5) / perAxis) * (area.east - area.west);
      const [x, y] = toXY(frame, lat, lon);
      candidates.push({ lat, lon, x, y });
    }
  }

  const placed = [...nodes];
  const edges: Edge[] = [...baseEdges];
  const suggestions: Suggestion[] = [];
  let feasibleCount = 0;
  // Marginal improvement is measured against the array as it stood at the start
  // of this round, so each rank reports only what it adds.
  let prevMean = base.meanRadiusM;
  let prevCoverage = base.coverage;
  let prevArticulation = baselineArticulation;

  for (let round = 0; round < count; round++) {
    const pts = placed.map((n) => toXY(frame, n.lat, n.lon));

    // Information the current array already has, per cell. Computed once per
    // round; each candidate then only adds its own rank-1 contribution.
    const baseXX = new Float64Array(nCells);
    const baseXY = new Float64Array(nCells);
    const baseYY = new Float64Array(nCells);
    // Coverage has to be decided by the same rule qualityGrid uses — nearest
    // node detects at P_d >= 0.5 — or the gain a suggestion advertises is not
    // the gain the operator gets when they accept it.
    const baseCovered = new Uint8Array(nCells);

    const acc: Fim = { xx: 0, xy: 0, yy: 0 };
    for (let c = 0; c < nCells; c++) {
      const sx = cells[c * 2];
      const sy = cells[c * 2 + 1];
      acc.xx = 0;
      acc.xy = 0;
      acc.yy = 0;
      let nearest = Infinity;
      for (let i = 0; i < pts.length; i++) {
        accumulate(acc, sx, sy, pts[i][0], pts[i][1]);
        const d = Math.hypot(sx - pts[i][0], sy - pts[i][1]);
        if (d < nearest) nearest = d;
      }
      baseXX[c] = acc.xx;
      baseXY[c] = acc.xy;
      baseYY[c] = acc.yy;
      baseCovered[c] = detectionProb(nearest) >= 0.5 ? 1 : 0;
    }

    let best: Suggestion | null = null;
    let bestCost = Infinity;
    let roundFeasible = 0;

    for (const cand of candidates) {
      // Hard rules first — they are cheap and reject most of the grid.
      let tooClose = false;
      const neighbours: string[] = [];
      for (const n of placed) {
        const d = distanceM(cand.lat, cand.lon, n.lat, n.lon);
        if (d < MIN_NODE_DISTANCE_M) {
          tooClose = true;
          break;
        }
        if (d <= MAX_LINK_DISTANCE_M) neighbours.push(n.id);
      }
      if (tooClose || neighbours.length < MIN_CONNECTIONS) continue;
      roundFeasible++;

      // Objective: mean position error over the area, with the candidate added.
      let sum = 0;
      let covered = 0;
      const one: Fim = { xx: 0, xy: 0, yy: 0 };
      for (let c = 0; c < nCells; c++) {
        const sx = cells[c * 2];
        const sy = cells[c * 2 + 1];
        one.xx = baseXX[c];
        one.xy = baseXY[c];
        one.yy = baseYY[c];
        accumulate(one, sx, sy, cand.x, cand.y);
        sum += crlbRadiusM(one);
        if (baseCovered[c] || detectionProb(Math.hypot(sx - cand.x, sy - cand.y)) >= 0.5) {
          covered++;
        }
      }
      const meanRadiusM = sum / nCells;

      const id = `suggested-${round + 1}`;
      // The candidate joins the existing topology by radio range; the links
      // already on the map stay exactly as the operator drew them.
      const withCandidate = [...placed.map((n) => n.id), id];
      const candidateEdges: Edge[] = [
        ...edges,
        ...neighbours.map((n) => [id, n] as Edge),
      ];
      const articulation = articulationPoints(withCandidate, candidateEdges).size;

      // Position error and resilience in one number, both in metres (§ARTICULATION_COST_M).
      const cost = meanRadiusM + ARTICULATION_COST_M * articulation;
      if (cost < bestCost) {
        bestCost = cost;
        const coverage = covered / nCells;
        best = {
          lat: cand.lat,
          lon: cand.lon,
          rank: round + 1,
          meanRadiusM,
          improvementM: prevMean - meanRadiusM,
          medianCoveredRadiusM: 0, // filled in below, once the winner is known
          coverage,
          coverageGain: coverage - prevCoverage,
          neighbours,
          articulation,
          articulationDelta: prevArticulation - articulation,
        };
      }
    }

    if (round === 0) feasibleCount = roundFeasible;
    if (!best) break;

    // The displayed "typical error" needs a sort per layout, which is far too
    // expensive per candidate — so compute it once, for the winner.
    const id = `suggested-${round + 1}`;
    const nextPlaced = [...placed, { id, lat: best.lat, lon: best.lon }];
    best.medianCoveredRadiusM = qualityGrid(nextPlaced, area, { nx, ny }).medianCoveredRadiusM;

    suggestions.push(best);
    placed.push({ id, lat: best.lat, lon: best.lon });
    edges.push(...best.neighbours.map((n) => [id, n] as Edge));
    prevMean = best.meanRadiusM;
    prevCoverage = best.coverage;
    prevArticulation = best.articulation;
  }

  return {
    suggestions,
    baselineMeanRadiusM: base.meanRadiusM,
    baselineMedianCoveredRadiusM: base.medianCoveredRadiusM,
    baselineCoverage: base.coverage,
    baselineArticulation,
    feasibleCount,
    area,
  };
}
