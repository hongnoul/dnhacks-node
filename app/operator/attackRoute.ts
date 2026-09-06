// attackRoute.ts — attack routes, and whether the array would actually see one.
//
// Not route.ts: inside app/, that filename is the App Router's API route-handler
// convention, and it cannot coexist with the page.tsx in this segment.
//
// A straight line between two clicks is not a drone attack. Real ingress follows
// terrain, skirts known sensors and turns onto the target, so the interesting
// question is not "can this array hear a drone" but "can it hear *this* run" —
// and the honest answer is a percentage of the route, not a yes.
//
// That number is what ties the placement advisor to something an operator cares
// about: draw an ingress, see that 40% of it is unobserved, take the advisor's
// suggestion, and watch the gap close.
//
// Pure geometry, no React or Leaflet, so it unit-tests under plain `node --test`.

import { DRONE_DETECTION_RADIUS_M, distanceM, type Site } from "./placement.ts";

/** [lat, lon] — the order Leaflet uses, kept so callers need no conversion. */
export type Waypoint = [number, number];

/**
 * Ground speed of the simulated threat, m/s (~54 km/h).
 *
 * An approach/loiter speed for a quadcopter rather than a dash, which is the
 * honest profile for a run against a target it has to find. It is also the
 * speed that makes the array watchable: nodes sit 100-150 m apart with a 140 m
 * detection radius, so at a transit dash the drone is through a node's earshot
 * in a couple of seconds and the mesh gossiping about it is over before it
 * registers. At 15 m/s a node holds it for ~19 s and the spread is visible.
 */
export const DRONE_SPEED_MPS = 15;

/**
 * Range the operator can dial the threat's speed over, m/s.
 *
 * 5 m/s is a quadcopter creeping in on a target; 45 m/s (~162 km/h) is a fast
 * fixed-wing run. Both are real profiles, and the array behaves very
 * differently against them — which is the point of making it adjustable rather
 * than fixing one number and calling it "the drone".
 */
export const MIN_DRONE_SPEED_MPS = 5;
export const MAX_DRONE_SPEED_MPS = 45;

/** Route sampling interval for the coverage estimate, metres. */
const SAMPLE_M = 5;

/** Length of each leg, and the total. */
export function routeLegs(route: Waypoint[]): { legs: number[]; total: number } {
  const legs: number[] = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const d = distanceM(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
    legs.push(d);
    total += d;
  }
  return { legs, total };
}

export function routeLengthM(route: Waypoint[]): number {
  return routeLegs(route).total;
}

/**
 * The point `distM` along the route.
 *
 * Distance rather than a 0..1 fraction, so the drone holds a constant ground
 * speed instead of racing through long legs to finish a fixed-duration flight.
 * Clamps at both ends.
 */
export function pointAlongRoute(route: Waypoint[], distM: number): Waypoint {
  if (route.length === 0) return [0, 0];
  if (route.length === 1) return route[0];
  const { legs, total } = routeLegs(route);
  if (distM <= 0) return route[0];
  if (distM >= total) return route[route.length - 1];

  let remaining = distM;
  for (let i = 0; i < legs.length; i++) {
    if (remaining <= legs[i]) {
      // A zero-length leg (two clicks in one spot) would divide by zero.
      const f = legs[i] > 0 ? remaining / legs[i] : 0;
      const a = route[i];
      const b = route[i + 1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    remaining -= legs[i];
  }
  return route[route.length - 1];
}

export interface RouteCoverage {
  /** Fraction of the route within detection range of at least one node. */
  covered: number;
  /** Nodes that make contact at any point along the run. */
  contacts: string[];
  /**
   * Metres into the run before the first node hears it, or null if never.
   *
   * The operationally interesting number: a route detected only in its last
   * 100 m was detected too late to do anything about.
   */
  firstContactM: number | null;
  /** Longest unobserved stretch, metres — where the array is blind. */
  longestGapM: number;
  lengthM: number;
  /**
   * The route split into observed and unobserved runs, for drawing.
   *
   * A percentage tells an operator how much of the ingress is covered; it does
   * not tell them *which part*, and those have completely different responses.
   * Blind for the first 200 m is a sensor-placement problem; blind for the last
   * 200 m means the threat reaches the target unobserved.
   */
  segments: { points: Waypoint[]; covered: boolean }[];
}

/**
 * How much of this route the array would actually detect.
 *
 * Uses the same hard detection radius the live flight animation uses, so the
 * predicted percentage and what the operator then watches happen agree. (The
 * advisor's smooth P_d curve is the right model for *ranking* placements; here
 * the point is to match the simulation exactly.)
 */
export function routeCoverage(
  route: Waypoint[],
  nodes: (Site & { id: string })[],
  radiusM = DRONE_DETECTION_RADIUS_M
): RouteCoverage {
  const lengthM = routeLengthM(route);
  if (route.length < 2 || lengthM === 0) {
    return { covered: 0, contacts: [], firstContactM: null, longestGapM: 0, lengthM, segments: [] };
  }

  const steps = Math.max(2, Math.ceil(lengthM / SAMPLE_M));
  const contacts = new Set<string>();
  let seen = 0;
  let firstContactM: number | null = null;
  let gap = 0;
  let longestGapM = 0;

  const segments: { points: Waypoint[]; covered: boolean }[] = [];
  let run: Waypoint[] = [];
  let runCovered: boolean | null = null;

  for (let i = 0; i <= steps; i++) {
    const along = (i / steps) * lengthM;
    const point = pointAlongRoute(route, along);
    let heard = false;
    for (const n of nodes) {
      if (distanceM(point[0], point[1], n.lat, n.lon) <= radiusM) {
        heard = true;
        contacts.add(n.id);
      }
    }
    if (heard) {
      seen++;
      if (firstContactM === null) firstContactM = along;
      gap = 0;
    } else {
      gap += lengthM / steps;
      if (gap > longestGapM) longestGapM = gap;
    }

    if (runCovered === null) {
      runCovered = heard;
      run = [point];
    } else if (heard === runCovered) {
      run.push(point);
    } else {
      // Carry the boundary sample into both runs so the drawn line has no gap
      // at the handover.
      run.push(point);
      segments.push({ points: run, covered: runCovered });
      runCovered = heard;
      run = [point];
    }
  }
  if (run.length > 1 && runCovered !== null) segments.push({ points: run, covered: runCovered });

  return {
    covered: seen / (steps + 1),
    contacts: [...contacts],
    firstContactM,
    longestGapM,
    lengthM,
    segments,
  };
}
