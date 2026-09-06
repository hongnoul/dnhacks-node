// protocol.ts — wire types for the mesh.
//
// Two layers travel the same socket (ARCHITECTURE.md §4.1):
//   - the relay envelope {to, payload} / {from, payload}, which the relay routes
//     but never opens;
//   - the gossip messages below, which live inside `payload` and are only ever
//     read by nodes.

export const PROTO_VERSION = 1;

// ---------- records: the replicated, immutable unit ----------

export interface MeshRecord {
  type: "reading" | "node_config";
  origin: string; // node id
  boot: number; // increments per page load — see identity.ts
  seq: number; // per (origin, boot), monotonic from 1
  t: number; // mesh time, ms
  [k: string]: unknown;
}

export interface Reading extends MeshRecord {
  type: "reading";
  p: number; // raw CRNN score, 0..1 — fusion's input
  /**
   * SkyMesh's latched detection verdict.
   *
   * On the wire because it is *stateful*: hysteresis plus a marginal-trip
   * counter mean a peer cannot recover it by comparing p to a threshold, and if
   * it tried, the mesh and the standalone demo would disagree about the same
   * audio (detection.ts).
   */
  d: boolean;
  logit: number; // dynamic range where p saturates (§6.2)
  snr_db: number | null;
}

export interface NodeConfig extends MeshRecord {
  type: "node_config";
  node: string;
  x: number; // room frame, metres (§13)
  y: number;
  /**
   * 1-sigma on that position, metres (§13).
   *
   * On the wire because a coordinate without its uncertainty is a claim the
   * receiver cannot check: 3.2 m from a laser survey and 3.2 m from a dragged
   * marker are the same two numbers and very different evidence, and fusion
   * weights them differently (fusion.ts, `effectiveSigmaDb`). Optional so that
   * pre-survey records still parse — absent means "unstated", and fusion falls
   * back to trusting the coordinate.
   */
  sigma_m?: number;
  enabled: boolean;
}

// A reboot starts a fresh stream rather than reusing keys, so `origin:boot` is
// the real identity of a sequence. This is what makes reload-safety structural
// instead of a discipline someone has to remember (§7.8).
export type StreamId = string; // `${origin}:${boot}`
export type RecordKey = string; // `${origin}:${boot}:${seq}`

export function streamOf(r: MeshRecord): StreamId {
  return `${r.origin}:${r.boot}`;
}

export function keyOf(r: MeshRecord): RecordKey {
  return `${r.origin}:${r.boot}:${r.seq}`;
}

/** What a caller supplies to publish: the body, minus what the log stamps on. */
export type NewRecord = { type: MeshRecord["type"] } & Record<string, unknown>;

/** origin:boot → highest *contiguous* seq held. */
export type VersionVector = Record<StreamId, number>;

// ---------- gossip messages ----------

export type GossipMsg =
  | { m: "hello"; node: string; boot: number; proto: number }
  | { m: "digest"; vv: VersionVector }
  | { m: "records"; r: MeshRecord[] }
  | { m: "ping"; id: number; t1: number }
  | { m: "pong"; id: number; t1: number; t2: number; t3: number };
