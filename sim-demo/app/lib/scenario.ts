// scenario.ts — demo-layer scenario controls for the admin console.
//
// Ported from ml-demo/app/operator/OperatorMap.tsx (avery/frontend-map), rescaled
// from street metres to room metres and rewired from Leaflet/mock state to live
// mesh primitives. Everything here is pure: geometry, placement validation, BFS
// alert routing, network health, and the activity-log reducer. The page wires
// these to AdminChannel (link cuts, topology) and gossip records (positions),
// so the console never holds a private picture (ARCHITECTURE.md §3).
//
// Browser-free, so it unit-tests directly like fusion.ts.

export interface Pt {
  x: number;
  y: number;
}

/** Room-scale equivalents of Avery's street-scale constants (100 m / 150 m). */
export const MIN_NODE_DISTANCE_M = 1.2;
export const MAX_LINK_DISTANCE_M = 6.0;
export const MIN_CONNECTIONS = 2;
/** How far the simulated drone's detection halo reaches — a visual hint only. */
export const DRONE_DETECTION_RADIUS_M = 3.0;
/** Impact blast radius for the simulated-outage demo. */
export const IMPACT_RADIUS_M = 3.0;
export const FLIGHT_DURATION_MS = 7_000;

export function distM(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export type PlacementStatus = "invalid" | "warning" | "valid";

export interface PlacementCandidate {
  x: number;
  y: number;
  distances: { node: string; d: number }[];
}

/** Distances from a candidate point to every positioned node, nearest first. */
export function buildPlacementCandidate(
  x: number,
  y: number,
  positions: Map<string, Pt> | Record<string, Pt>
): PlacementCandidate {
  const entries =
    positions instanceof Map ? [...positions.entries()] : Object.entries(positions);
  const distances = entries
    .map(([node, p]) => ({ node, d: distM({ x, y }, p) }))
    .sort((a, b) => a.d - b.d);
  return { x, y, distances };
}

/**
 * invalid — too close to an existing node (would hear identically, so it
 * constrains nothing, per RUNNING.md §demo-script-3).
 * warning — placed but under-connected; valid geometry, weak mesh position.
 * valid — spaced and within link range of enough neighbours.
 */
export function placementStatus(c: PlacementCandidate | null): PlacementStatus {
  if (!c) return "invalid";
  if (c.distances.some(({ d }) => d < MIN_NODE_DISTANCE_M)) return "invalid";
  const neighbours = c.distances.filter(({ d }) => d <= MAX_LINK_DISTANCE_M).length;
  return neighbours < MIN_CONNECTIONS ? "warning" : "valid";
}

/** Nodes within link range of the candidate — the edges a placement would add. */
export function placementNeighbours(c: PlacementCandidate): string[] {
  return c.distances.filter(({ d }) => d <= MAX_LINK_DISTANCE_M).map(({ node }) => node);
}

/**
 * Symmetric adjacency: the relay stores one directed record per side, and a
 * stale replica may hold only half of an edge. Routing must not depend on
 * which half arrived first.
 */
function adjacency(topology: Record<string, string[]>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const [a, nbs] of Object.entries(topology)) {
    if (!adj.has(a)) adj.set(a, new Set());
    for (const b of nbs) link(a, b);
  }
  return adj;
}

/**
 * BFS from the detecting node to the command post (the admin observer) over
 * links that are up. Returns the hop path, or null when partitioned — which is
 * the "NETWORK PATH LOST" demo, not an error.
 */
export function findAlertPath(
  sourceId: string,
  topology: Record<string, string[]>,
  isUp: (a: string, b: string) => boolean,
  commandId: string
): string[] | null {
  if (sourceId === commandId) return [commandId];
  const adj = adjacency(topology);
  const prev = new Map<string, string | null>([[sourceId, null]]);
  const queue = [sourceId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === commandId) break;
    for (const nb of adj.get(cur) ?? []) {
      if (prev.has(nb)) continue;
      if (!isUp(cur, nb)) continue;
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  if (!prev.has(commandId)) return null;
  const path: string[] = [];
  let cur: string | null = commandId;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }
  return path;
}

/** True when every admitted node reaches every other over links that are up. */
export function isConnected(
  nodes: string[],
  topology: Record<string, string[]>,
  isUp: (a: string, b: string) => boolean
): boolean {
  if (nodes.length < 2) return true;
  const adj = adjacency(topology);
  const inSet = new Set(nodes);
  const visited = new Set([nodes[0]]);
  const queue = [nodes[0]];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) ?? []) {
      if (!inSet.has(nb) || visited.has(nb)) continue;
      if (!isUp(cur, nb)) continue;
      visited.add(nb);
      queue.push(nb);
    }
  }
  return visited.size === nodes.length;
}

/**
 * Share of admitted nodes with fresh readings. Liveness comes from the mesh
 * replica (records gossiped here), not from the relay — the console reports
 * what a node would see.
 */
export function networkHealth(admitted: string[], live: Set<string> | string[]): number {
  if (admitted.length === 0) return 100;
  const liveSet = live instanceof Set ? live : new Set(live);
  const n = admitted.filter((id) => liveSet.has(id)).length;
  return Math.round((n / admitted.length) * 100);
}

/** Linear flight interpolation for the simulated drone marker. */
export function interpolatePosition(start: Pt, dest: Pt, progress: number): Pt {
  const t = Math.max(0, Math.min(1, progress));
  return { x: start.x + (dest.x - start.x) * t, y: start.y + (dest.y - start.y) * t };
}

/** Nodes whose positions fall within `radius` of a point. */
export function nodesWithinRadius(
  pt: Pt,
  positions: Map<string, Pt>,
  radius: number
): string[] {
  const out: string[] = [];
  for (const [node, p] of positions) {
    if (distM(pt, p) <= radius) out.push(node);
  }
  return out;
}

export type EventTone = "info" | "warning" | "critical" | "success";

export interface ActivityEvent {
  id: number;
  time: string;
  message: string;
  tone: EventTone;
}

const MAX_EVENTS = 6;

/**
 * Prepend, cap at six, and dedupe repeat detections — one flight past three
 * nodes is one story, not three log lines.
 */
export function pushEvent(
  events: ActivityEvent[],
  message: string,
  tone: EventTone = "info",
  now: () => { id: number; time: string } = () => ({
    id: Date.now(),
    time: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  })
): ActivityEvent[] {
  if (
    message.includes("detected simulated drone") &&
    events.some((e) => e.message === message)
  ) {
    return events;
  }
  const t = now();
  return [{ id: t.id, time: t.time, message, tone }, ...events].slice(0, MAX_EVENTS);
}
