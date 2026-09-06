// routeAdvisor.ts — where to put the next sensor, given a specific ingress.
//
// The advisor in placement.ts answers a different question: where to put a
// sensor so the array localises *well over an area*, scored on the Cramér-Rao
// bound. That is the right question when you are covering ground you expect a
// threat to cross somewhere.
//
// This one answers the question an operator asks once a route is drawn: this
// run gets 40% observed and is not heard until 300 m in — where does a sensor
// go to fix *that*? The two disagree often, and they should: the CRLB advisor
// will happily thicken the middle of an array that already hears the ingress
// fine, because that is where a fix gets sharpest.
//
// Nothing here is learned. It is a greedy search over legal positions, scored
// on three things an operator can check on the map afterwards, and the phrasing
// is generated from whichever of those three actually dominated. Calling it a
// model would be a lie; the numbers in the rationale are real and are the same
// numbers the coverage bar shows, because both come from routeCoverage().

import { routeCoverage, type Waypoint } from "./attackRoute.ts";
import {
  DRONE_DETECTION_RADIUS_M,
  MAX_LINK_DISTANCE_M,
  MIN_CONNECTIONS,
  MIN_NODE_DISTANCE_M,
  distanceM,
  makeFrame,
  toLatLon,
  type Site,
} from "./placement.ts";

export interface RouteSuggestion {
  /** 1 is the best spot; 2 assumes 1 was taken, and so on. */
  rank: number;
  lat: number;
  lon: number;
  /**
   * Existing nodes within radio range — the links it would come up with.
   *
   * Real node ids only. A rank-2 spot may also reach rank 1, but that sensor
   * does not exist yet, so quoting it here would hand the caller an id it
   * cannot wire to.
   */
  neighbours: string[];
  /** Higher-ranked suggestions it would reach, if those are taken too. */
  linksToRanks: number[];
  /**
   * True when nothing in the existing mesh is within radio range.
   *
   * Then the spot is still the best place to *hear* this run, but it would
   * come up isolated — it detects and tells nobody until the operator wires it
   * or backfills the gap. Offered rather than suppressed, because "your mesh
   * cannot reach the ingress" is the most useful thing the advisor can say.
   */
  detached: boolean;
  /** Fraction of the route observed with this and every better-ranked spot in. */
  coverage: number;
  /** Percentage points of the route this placement newly observes, 0..1. */
  coverageGain: number;
  /** Metres into the run before first contact, after this placement. */
  firstContactM: number | null;
  /**
   * Metres of warning this buys — how much earlier the array first hears it.
   *
   * The number an operator actually cares about. A route detected only in its
   * last 100 m was detected too late to do anything about, and a placement
   * that raises total coverage while leaving the approach blind has not helped.
   */
  earlierByM: number;
  /** Longest remaining unobserved stretch after the placement. */
  longestGapM: number;
  /** Metres shaved off the longest blind stretch. */
  gapClosedM: number;
  /** Which of the three effects dominated, as a short verdict. */
  headline: string;
  /**
   * The dominant effect as a single number, for the map badge.
   *
   * The headline repeats down the list whenever the same effect dominates
   * every spot — which is the common case, since the search walks back along
   * one blind approach — and three identical captions on the map say nothing.
   * The number differs even when the reason does not.
   */
  badge: string;
  /** The same thing spelled out, with the numbers behind it. */
  detail: string;
  /** Merit relative to the best spot found this round, 0..1. */
  confidence: number;
}

export interface RouteAdvice {
  suggestions: RouteSuggestion[];
  /** The array as it stands, for comparison. */
  baselineCoverage: number;
  baselineFirstContactM: number | null;
  baselineLongestGapM: number;
  /** Candidate spots that passed the hard placement rules. */
  feasibleCount: number;
  routeLengthM: number;
}

export interface RouteAdviceOptions {
  count?: number;
  /** Candidate positions per axis. */
  candidatesPerAxis?: number;
  radiusM?: number;
}

/**
 * Weights on the three things a placement can do for a run.
 *
 * Earliness leads because warning time is the operationally scarce thing: 20%
 * more of the route observed is worth little if all of it is behind the
 * threat. Coverage is next, and closing the single widest blind stretch last —
 * it correlates with the other two, so weighting it heavily double-counts.
 */
const W_EARLY = 0.45;
const W_COVERAGE = 0.35;
const W_GAP = 0.2;

/** Below this a "recommendation" is noise dressed up as advice. */
const MIN_USEFUL_SCORE = 0.01;

type Node = Site & { id: string };

/** Nodes within radio range of a point — the links it would come up with. */
function neighboursOf(lat: number, lon: number, nodes: Node[]): string[] {
  return nodes
    .filter((n) => distanceM(lat, lon, n.lat, n.lon) <= MAX_LINK_DISTANCE_M)
    .map((n) => n.id);
}

/**
 * The hard rules, same as the ones the hover preview colours a spot by.
 *
 * Spacing is a real constraint (two sensors on top of each other measure the
 * same thing twice); attachment is a harder one, because a sensor that cannot
 * reach the mesh hears the drone and tells nobody. An empty map is the one
 * case where no link is required — there is nothing to link to yet.
 */
function isLegal(
  lat: number,
  lon: number,
  nodes: Node[],
  placed: Node[],
  requireLink: boolean
): boolean {
  for (const n of [...nodes, ...placed]) {
    if (distanceM(lat, lon, n.lat, n.lon) < MIN_NODE_DISTANCE_M) return false;
  }
  if (!requireLink || nodes.length + placed.length === 0) return true;
  return neighboursOf(lat, lon, [...nodes, ...placed]).length >= 1;
}

/**
 * Say what this spot does, leading with whatever it mostly does.
 *
 * Generated from the same three deltas that were scored, so the sentence
 * cannot drift from the ranking that produced it — a recommendation whose
 * stated reason is not its actual reason is worse than no reason at all.
 */
function explain(
  earlierByM: number,
  coverageGain: number,
  gapClosedM: number,
  lengthM: number,
  neighbours: number,
  linksToRanks: number[],
  detached: boolean
): { headline: string; detail: string; badge: string } {
  const parts: string[] = [];
  if (earlierByM >= 20) parts.push(`first contact ${Math.round(earlierByM)} m earlier`);
  if (coverageGain >= 0.02) parts.push(`+${Math.round(coverageGain * 100)}% of the run observed`);
  if (gapClosedM >= 20) parts.push(`${Math.round(gapClosedM)} m less blind ground`);

  // The *same* normalised terms the ranking used. Comparing raw metres against
  // a 0..1 fraction — which is what this did first — makes coverage win almost
  // every time, and every entry in the list ends up with the same headline
  // while the ranking underneath was driven by something else.
  const early = W_EARLY * (earlierByM / lengthM);
  const cover = W_COVERAGE * coverageGain;
  const gap = W_GAP * (gapClosedM / lengthM);
  const dominant = early >= cover && early >= gap ? "early" : cover >= gap ? "cover" : "gap";
  const headline =
    dominant === "early"
      ? "Buys the most warning"
      : dominant === "cover"
        ? "Sees the most of the run"
        : "Closes the widest blind stretch";
  const badge =
    dominant === "early"
      ? `${Math.round(earlierByM)} m earlier`
      : dominant === "cover"
        ? `+${Math.round(coverageGain * 100)}% seen`
        : `−${Math.round(gapClosedM)} m blind`;

  const links = neighbours + linksToRanks.length;
  if (detached) {
    parts.push(`no mesh within ${MAX_LINK_DISTANCE_M} m — it would need wiring or a relay`);
  } else if (neighbours === 0) {
    // Reachable, but only via a sensor that does not exist yet. Worth saying
    // plainly: taken on its own this spot comes up isolated.
    parts.push(`reaches suggestion ${linksToRanks.join(" and ")}, so place ${linksToRanks.length === 1 ? "that" : "those"} first`);
  } else if (links < MIN_CONNECTIONS) {
    parts.push(`${links} link to the mesh, under the ${MIN_CONNECTIONS} the rules want`);
  } else {
    parts.push(`${links} links to the mesh`);
  }
  return { headline, badge, detail: parts.join(" · ") };
}

/**
 * Rank legal placements by what they do for *this* ingress.
 *
 * Greedy and sequential, for the same reason suggestPlacements is: scored in
 * one pass by individual merit, the top three are three names for the same
 * hole. Each round re-scores against a route the previous winners are already
 * covering, so the list complements itself.
 */
export function adviseForRoute(
  route: Waypoint[],
  nodes: Node[],
  opts: RouteAdviceOptions = {}
): RouteAdvice {
  const count = opts.count ?? 3;
  const per = opts.candidatesPerAxis ?? 22;
  const radiusM = opts.radiusM ?? DRONE_DETECTION_RADIUS_M;

  const base = routeCoverage(route, nodes, radiusM);
  const empty: RouteAdvice = {
    suggestions: [],
    baselineCoverage: base.covered,
    baselineFirstContactM: base.firstContactM,
    baselineLongestGapM: base.longestGapM,
    feasibleCount: 0,
    routeLengthM: base.lengthM,
  };
  if (route.length < 2 || base.lengthM === 0) return empty;

  // Candidates over the route's own envelope, widened by one detection radius:
  // a sensor further from the ingress than it can hear does nothing for it, so
  // searching out there only burns time and dilutes the ranking.
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const [lat, lon] of route) {
    south = Math.min(south, lat); north = Math.max(north, lat);
    west = Math.min(west, lon); east = Math.max(east, lon);
  }
  const midLat = (south + north) / 2;
  const midLon = (west + east) / 2;
  const frame = makeFrame(midLat, midLon);
  const halfY = distanceM(south, midLon, north, midLon) / 2 + radiusM;
  const halfX = distanceM(midLat, west, midLat, east) / 2 + radiusM;

  const suggestions: RouteSuggestion[] = [];
  /** Raw scores, kept alongside so confidence can be relative to the best. */
  const scores: number[] = [];
  const placed: Node[] = [];
  let prev = base;
  let feasibleCount = 0;

  /**
   * Whether a candidate has to reach the existing mesh.
   *
   * Normally yes — a sensor that cannot relay hears the drone and tells
   * nobody. But if the mesh is nowhere near the ingress, insisting on it means
   * the advisor has nothing to say about the very case where advice matters
   * most. Decided once, from whether any legal attached spot exists at all.
   */
  const anyAttached = (() => {
    for (let iy = 0; iy < per; iy++) {
      const y = -halfY + ((iy + 0.5) / per) * 2 * halfY;
      for (let ix = 0; ix < per; ix++) {
        const x = -halfX + ((ix + 0.5) / per) * 2 * halfX;
        const [lat, lon] = toLatLon(frame, x, y);
        if (isLegal(lat, lon, nodes, [], true)) return true;
      }
    }
    return false;
  })();
  const requireLink = anyAttached;

  for (let rank = 1; rank <= count; rank++) {
    let best: { lat: number; lon: number; score: number } | null = null;
    let bestScore = 0;
    let feasibleThisRound = 0;

    for (let iy = 0; iy < per; iy++) {
      const y = -halfY + ((iy + 0.5) / per) * 2 * halfY;
      for (let ix = 0; ix < per; ix++) {
        const x = -halfX + ((ix + 0.5) / per) * 2 * halfX;
        const [lat, lon] = toLatLon(frame, x, y);
        if (!isLegal(lat, lon, nodes, placed, requireLink)) continue;
        feasibleThisRound++;

        const trial = routeCoverage(
          route,
          [...nodes, ...placed, { id: `__cand${rank}`, lat, lon }],
          radiusM
        );
        // A route nobody hears has no "first contact" to be earlier than, so
        // the whole run counts as the warning this placement creates.
        const before = prev.firstContactM ?? prev.lengthM;
        const after = trial.firstContactM ?? trial.lengthM;
        const earlierByM = Math.max(0, before - after);
        const coverageGain = trial.covered - prev.covered;
        const gapClosedM = Math.max(0, prev.longestGapM - trial.longestGapM);

        const score =
          W_EARLY * (earlierByM / base.lengthM) +
          W_COVERAGE * coverageGain +
          W_GAP * (gapClosedM / base.lengthM);
        if (score > bestScore) {
          bestScore = score;
          best = { lat, lon, score };
        }
      }
    }

    if (rank === 1) feasibleCount = feasibleThisRound;
    if (!best || bestScore < MIN_USEFUL_SCORE) break;

    // Real nodes and prior suggestions are different kinds of neighbour: only
    // the first can be wired to today.
    const neighbours = neighboursOf(best.lat, best.lon, nodes);
    const linksToRanks = placed
      .filter((pn) => distanceM(best.lat, best.lon, pn.lat, pn.lon) <= MAX_LINK_DISTANCE_M)
      .map((pn) => Number(pn.id.replace("__rank", "")));
    const detached = neighbours.length === 0 && linksToRanks.length === 0 && nodes.length > 0;
    const all = [...nodes, ...placed];
    const after = routeCoverage(
      route,
      [...all, { id: `__rank${rank}`, lat: best.lat, lon: best.lon }],
      radiusM
    );
    const beforeFirst = prev.firstContactM ?? prev.lengthM;
    const afterFirst = after.firstContactM ?? after.lengthM;
    const earlierByM = Math.max(0, beforeFirst - afterFirst);
    const coverageGain = after.covered - prev.covered;
    const gapClosedM = Math.max(0, prev.longestGapM - after.longestGapM);
    const { headline, detail, badge } = explain(
      earlierByM, coverageGain, gapClosedM, base.lengthM, neighbours.length, linksToRanks, detached
    );

    suggestions.push({
      rank,
      lat: best.lat,
      lon: best.lon,
      neighbours,
      linksToRanks,
      detached,
      coverage: after.covered,
      coverageGain,
      firstContactM: after.firstContactM,
      earlierByM,
      longestGapM: after.longestGapM,
      gapClosedM,
      headline,
      badge,
      detail,
      // Filled in below, once the best score of the run is known.
      confidence: 1,
    });
    scores.push(best.score);

    placed.push({ id: `__rank${rank}`, lat: best.lat, lon: best.lon });
    prev = after;
  }

  // Relative to the best spot found, so the list shows its own diminishing
  // returns instead of every entry reading as equally certain.
  for (let i = 0; i < suggestions.length; i++) {
    suggestions[i].confidence = scores[0] > 0 ? Math.min(1, scores[i] / scores[0]) : 0;
  }

  return {
    suggestions,
    baselineCoverage: base.covered,
    baselineFirstContactM: base.firstContactM,
    baselineLongestGapM: base.longestGapM,
    feasibleCount,
    routeLengthM: base.lengthM,
  };
}
