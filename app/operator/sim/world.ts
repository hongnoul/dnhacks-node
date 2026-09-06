// world.ts — a timed simulation of the SkyMesh mesh.
//
// The operator map used to be omniscient: it computed from the drone's true
// position which sensors were within earshot, and every panel read that one
// global truth instantly. Nothing was ever late, nothing was ever dropped, and
// no two nodes could disagree — which makes the project's actual claim
// unshowable.
//
// Here each node holds its own append-only replica and learns about a contact
// only when a record reaches it. Records travel over links that impose latency
// and drop packets, so replicas genuinely diverge; anti-entropy is what brings
// them back together. "Two nodes that disagree have not finished gossiping"
// (ARCHITECTURE.md §7.1) becomes something you can watch happen.
//
// Runs the live mesh's own modules (app/lib), so the two agree by construction:
//   - readings scored at 4 Hz and published *every* window, silent or not (§6.1)
//   - detection is a stateful latch, and the verdict travels on the wire (§13)
//   - eager push + lazy pull; push is fast and lossy, pull is slow and complete
//   - records are a grow-only set keyed origin:boot:seq, so merge is union (§7.1)
//
// Pure: no React, no Leaflet, no browser APIs, no wall-clock. Time is a number
// this module advances. That is what makes it testable and reproducible.

// The mesh's own modules, not copies of them. When ml-demo and sim-demo were
// separate Next builds these had to be vendored; they are one app now, so the
// simulation runs the *same* Log, the same record keys and the same detection
// latch the live mesh does. A tuning change to app/lib/detection.ts can no
// longer silently stop applying to the simulation of it.
import { DetectionLatch, SCORE_INTERVAL_MS } from "../../lib/detection.ts";
import { Log } from "../../lib/log.ts";
import { keyOf, type MeshRecord, type VersionVector } from "../../lib/protocol.ts";
import { gaussian, makeRng } from "./rng.ts";
import { DRONE_DETECTION_RADIUS_M, detectionProb, distanceM } from "../placement.ts";
import { expectedSnrDb } from "./estimate.ts";
import { pointAlongRoute, routeLengthM, DRONE_SPEED_MPS, type Waypoint } from "../attackRoute.ts";

/** Simulation timestep. Fine enough to resolve a 50 ms link, coarse enough to be cheap. */
export const TICK_MS = 50;

/** Anti-entropy period (sim-demo gossip.ts DIGEST_INTERVAL_MS). */
export const DIGEST_INTERVAL_MS = 5_000;

/** Default one-hop delay (sim-demo relay.py DEFAULT_LATENCY_MS). */
export const DEFAULT_LATENCY_MS = 50;

/** How long a reading counts toward the current picture (sim-demo mesh.ts FRESH_MS). */
export const FRESH_MS = 3_000;

/** Time from placement to a node scoring. Stands in for model load + join. */
export const BOOT_MS = 800;

/**
 * Spread on the synthesised score.
 *
 * sim-demo gets `p` from a real CRNN; distance is all this has. Without noise
 * the latch would be a pure function of range and its whole reason for existing
 * — hysteresis, the marginal-trip counter — would be dead code. At ~190 m a node
 * sits near the 0.22 marginal floor and flickers across it, which is exactly the
 * case MARGINAL_TICKS was written for.
 */
export const SCORE_SIGMA = 0.08;

/** Spread on the level channel, dB. sim-demo measured 4 dB between like phones. */
export const SNR_SIGMA_DB = 4;

export type NodeLifecycle = "booting" | "listening";

export interface SimLink {
  a: string;
  b: string;
  latencyMs: number;
  /** 0..1 chance a record is dropped on this hop. Drops are silent, by design. */
  loss: number;
}

export interface SimNodeSpec {
  id: string;
  lat: number;
  lon: number;
}

/** A record in flight between two nodes. */
interface InFlight {
  from: string;
  to: string;
  arriveAt: number;
  msg: Msg;
}

type Msg =
  | { m: "records"; r: MeshRecord[] }
  | { m: "digest"; vv: VersionVector };

export interface Reading extends MeshRecord {
  type: "reading";
  /** Raw score. Fusion's input — smoothing would lag the evidence. */
  p: number;
  /** The node's own latched verdict. Stateful, so it cannot be recomputed from p. */
  d: boolean;
  snr_db: number | null;
}

class SimNode {
  readonly id: string;
  lat: number;
  lon: number;
  lifecycle: NodeLifecycle = "booting";
  readonly log = new Log();
  readonly latch = new DetectionLatch();
  /** Increments per (re)boot, so a restart starts a fresh stream (§7.8). */
  boot = 1;
  seq = 0;
  bootedAt: number;
  lastScoreAt = -Infinity;
  lastDigestAt = 0;
  /** Latest verdict this node reached about its own microphone. */
  detecting = false;
  p = 0;

  constructor(spec: SimNodeSpec, at: number) {
    this.id = spec.id;
    this.lat = spec.lat;
    this.lon = spec.lon;
    this.bootedAt = at;
    this.lastDigestAt = at;
  }
}

export interface SimSnapshot {
  timeMs: number;
  running: boolean;
  dronePosition: Waypoint | null;
  /** Metres flown so far. */
  travelledM: number;
  routeLengthM: number;
  done: boolean;
  nodes: {
    id: string;
    lifecycle: NodeLifecycle;
    /** This node's own verdict about what it can hear. */
    detecting: boolean;
    p: number;
    /** Records held in this node's replica. */
    records: number;
    /** Distinct nodes this one currently believes are detecting, itself included. */
    contacts: string[];
  }[];
  /** Records currently on the wire, for the ripple. */
  inFlight: { from: string; to: string; progress: number }[];
}

/**
 * Something a node decided, for the contact log.
 *
 * Drained rather than pushed through a callback so the simulation stays free of
 * React: it records what happened, the caller collects it when convenient.
 */
export type SimEvent =
  | { kind: "detect"; node: string; timeMs: number; travelledM: number }
  | { kind: "held"; count: number; total: number; timeMs: number };

export interface WorldOptions {
  seed?: number;
  /** Per-hop delay applied to every link unless overridden. */
  latencyMs?: number;
  /** Per-hop drop probability. */
  loss?: number;
}

export class SimWorld {
  timeMs = 0;
  private nodes = new Map<string, SimNode>();
  private links: SimLink[] = [];
  private adjacency = new Map<string, string[]>();
  private wire: InFlight[] = [];
  private route: Waypoint[] = [];
  private totalM = 0;
  private rng: () => number;
  private defaultLatency: number;
  private defaultLoss: number;
  private events: SimEvent[] = [];
  /**
   * Nodes that have already reported an acquisition this run, and the widest the
   * contact has spread so far.
   *
   * The latch chatters at the fringe by design — noise carries `p` back and
   * forth across the 0.22 marginal floor, so a node on the edge of range trips
   * and releases every second or so. That is the correct verdict each time and
   * the map shows it live, but as a log it is a wall of "contact lost / acoustic
   * contact" for one drone. The log records the first acquisition per node and
   * each new high-water mark of spread; the live state shows the rest.
   */
  private announced = new Set<string>();
  private maxHeld = 0;

  constructor(opts: WorldOptions = {}) {
    this.rng = makeRng(opts.seed ?? 1);
    this.defaultLatency = opts.latencyMs ?? DEFAULT_LATENCY_MS;
    this.defaultLoss = opts.loss ?? 0;
  }

  // ---------------------------------------------------------------- topology

  /** Replace the node set and link set. Nodes that persist keep their replica. */
  setTopology(specs: SimNodeSpec[], links: { a: string; b: string }[]): void {
    const keep = new Set(specs.map((s) => s.id));
    for (const id of [...this.nodes.keys()]) if (!keep.has(id)) this.nodes.delete(id);
    for (const spec of specs) {
      const existing = this.nodes.get(spec.id);
      if (existing) {
        existing.lat = spec.lat;
        existing.lon = spec.lon;
      } else {
        this.nodes.set(spec.id, new SimNode(spec, this.timeMs));
      }
    }
    this.links = links.map((l) => ({
      a: l.a,
      b: l.b,
      latencyMs: this.defaultLatency,
      loss: this.defaultLoss,
    }));
    this.adjacency = new Map([...this.nodes.keys()].map((id) => [id, [] as string[]]));
    for (const l of this.links) {
      if (!this.adjacency.has(l.a) || !this.adjacency.has(l.b)) continue;
      this.adjacency.get(l.a)!.push(l.b);
      this.adjacency.get(l.b)!.push(l.a);
    }
    // A message to a node or over a link that no longer exists is undeliverable.
    // Dropping it silently is the correct behaviour for a cut radio link.
    this.wire = this.wire.filter((f) => this.adjacent(f.from, f.to));
  }

  setRoute(route: Waypoint[]): void {
    this.route = route;
    this.totalM = routeLengthM(route);
  }

  private adjacent(a: string, b: string): boolean {
    return (this.adjacency.get(a) ?? []).includes(b);
  }

  private linkFor(a: string, b: string): SimLink | undefined {
    return this.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  }

  // -------------------------------------------------------------------- time

  reset(): void {
    this.timeMs = 0;
    this.wire = [];
    this.events = [];
    this.announced.clear();
    this.maxHeld = 0;
    for (const [id, node] of this.nodes) {
      const fresh = new SimNode({ id, lat: node.lat, lon: node.lon }, 0);
      // A reset is a reboot: a fresh stream rather than reused keys (§7.8).
      fresh.boot = node.boot + 1;
      this.nodes.set(id, fresh);
    }
  }

  /** Advance one fixed timestep. */
  tick(): void {
    this.timeMs += TICK_MS;
    this.deliver();
    this.score();
    this.antiEntropy();
    this.trackSpread();
  }

  /**
   * How far a contact has spread through the mesh.
   *
   * Reported as a count rather than a hop animation because that is the honest
   * statement: N of M replicas currently hold a record saying somebody heard
   * something. It rises as gossip carries it and falls when the readings age
   * past the freshness window.
   */
  private trackSpread(): void {
    let held = 0;
    for (const node of this.nodes.values()) {
      if (this.contactsSeenBy(node.id).length > 0) held++;
    }
    if (held > this.maxHeld) {
      this.maxHeld = held;
      this.events.push({ kind: "held", count: held, total: this.nodes.size, timeMs: this.timeMs });
    }
  }

  /** Take everything recorded since the last call. */
  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ------------------------------------------------------------------ sensing

  private dronePosition(): Waypoint | null {
    if (this.route.length < 2) return null;
    const travelled = (this.timeMs / 1000) * DRONE_SPEED_MPS;
    if (travelled > this.totalM) return null;
    return pointAlongRoute(this.route, travelled);
  }

  private score(): void {
    const drone = this.dronePosition();
    for (const node of this.nodes.values()) {
      if (node.lifecycle === "booting") {
        if (this.timeMs - node.bootedAt < BOOT_MS) continue;
        node.lifecycle = "listening";
      }
      if (this.timeMs - node.lastScoreAt < SCORE_INTERVAL_MS) continue;
      node.lastScoreAt = this.timeMs;

      // Synthesise what the microphone would have produced. Outside detection
      // range there is nothing but noise; the node still publishes, because a
      // quiet node is evidence and silence has to be on the wire (§6.1).
      let p = 0;
      let snr: number | null = null;
      if (drone) {
        const d = distanceM(drone[0], drone[1], node.lat, node.lon);
        p = detectionProb(d) + gaussian(this.rng) * SCORE_SIGMA;
        if (d <= DRONE_DETECTION_RADIUS_M * 2) {
          snr = expectedSnrDb(d) + gaussian(this.rng) * SNR_SIGMA_DB;
        }
      } else {
        p = Math.abs(gaussian(this.rng)) * 0.02;
      }
      p = Math.min(1, Math.max(0, p));

      const verdict = node.latch.push(p, this.timeMs);
      if (verdict.detecting && !this.announced.has(node.id)) {
        this.announced.add(node.id);
        this.events.push({
          kind: "detect",
          node: node.id,
          timeMs: this.timeMs,
          travelledM: (this.timeMs / 1000) * DRONE_SPEED_MPS,
        });
      }
      node.detecting = verdict.detecting;
      node.p = p;

      const record: Reading = {
        type: "reading",
        origin: node.id,
        boot: node.boot,
        seq: ++node.seq,
        t: this.timeMs,
        p,
        d: verdict.detecting,
        snr_db: snr,
      };
      node.log.add(record);
      this.push(node.id, { m: "records", r: [record] });
    }
  }

  // -------------------------------------------------------------- replication

  /** Eager push: forward to every neighbour except the one it came from. */
  private push(from: string, msg: Msg, except?: string): void {
    for (const to of this.adjacency.get(from) ?? []) {
      if (to === except) continue;
      this.send(from, to, msg);
    }
  }

  private send(from: string, to: string, msg: Msg): void {
    const link = this.linkFor(from, to);
    if (!link) return;
    // Drops are silent to the sender, by design: a radio link that is down does
    // not send you an error (sim-demo/server/relay.py).
    if (link.loss > 0 && this.rng() < link.loss) return;
    this.wire.push({ from, to, arriveAt: this.timeMs + link.latencyMs, msg });
  }

  private deliver(): void {
    if (this.wire.length === 0) return;
    const due = this.wire.filter((f) => f.arriveAt <= this.timeMs);
    if (due.length === 0) return;
    this.wire = this.wire.filter((f) => f.arriveAt > this.timeMs);

    for (const f of due) {
      const node = this.nodes.get(f.to);
      if (!node || node.lifecycle === "booting") continue;

      if (f.msg.m === "records") {
        const fresh: MeshRecord[] = [];
        for (const r of f.msg.r) if (node.log.add(r)) fresh.push(r);
        // Never back to the sender: that is what bounds a flood to 2|E| (§7.6).
        if (fresh.length) this.push(node.id, { m: "records", r: fresh }, f.from);
      } else {
        // Reconciliation is two messages, not three: digest in, records straight
        // back (§7.3).
        const delta = node.log.since(f.msg.vv);
        if (delta.length) this.send(node.id, f.from, { m: "records", r: delta });
      }
    }
  }

  /**
   * Lazy pull. Push alone is lossy — a dropped record is dropped forever — so
   * every node offers its version vector to each neighbour on a timer and gets
   * back whatever it lacks. This is the mechanism that heals a partition, and
   * the reason cutting a link and restoring it converges instead of staying
   * broken (§7.4).
   */
  private antiEntropy(): void {
    for (const node of this.nodes.values()) {
      if (node.lifecycle === "booting") continue;
      if (this.timeMs - node.lastDigestAt < DIGEST_INTERVAL_MS) continue;
      node.lastDigestAt = this.timeMs;
      this.push(node.id, { m: "digest", vv: node.log.vv() });
    }
  }

  // ------------------------------------------------------------------ reading

  /** Records this node holds, newest first. */
  replica(id: string): MeshRecord[] {
    return this.nodes.get(id)?.log.sorted() ?? [];
  }

  /** Nodes `viewer` currently believes are detecting, from its own replica. */
  contactsSeenBy(id: string): string[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    const latest = new Map<string, Reading>();
    for (const rec of node.log.ofType<Reading>("reading")) {
      if (this.timeMs - rec.t > FRESH_MS) continue;
      const prev = latest.get(rec.origin);
      if (!prev || rec.t > prev.t) latest.set(rec.origin, rec);
    }
    return [...latest.values()].filter((r) => r.d).map((r) => r.origin).sort();
  }

  /** Freshest reading per origin held by `id`. What that node would fuse from. */
  freshReadings(id: string): Reading[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    const latest = new Map<string, Reading>();
    for (const rec of node.log.ofType<Reading>("reading")) {
      if (this.timeMs - rec.t > FRESH_MS) continue;
      const prev = latest.get(rec.origin);
      if (!prev || rec.t > prev.t) latest.set(rec.origin, rec);
    }
    return [...latest.values()];
  }

  recordCount(id: string): number {
    return this.nodes.get(id)?.log.size ?? 0;
  }

  snapshot(running: boolean): SimSnapshot {
    const travelled = (this.timeMs / 1000) * DRONE_SPEED_MPS;
    return {
      timeMs: this.timeMs,
      running,
      dronePosition: this.dronePosition(),
      travelledM: Math.min(travelled, this.totalM),
      routeLengthM: this.totalM,
      done: this.route.length > 1 && travelled >= this.totalM,
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        lifecycle: n.lifecycle,
        detecting: n.detecting,
        p: n.p,
        records: n.log.size,
        contacts: this.contactsSeenBy(n.id),
      })),
      inFlight: this.wire
        .filter((f) => f.msg.m === "records")
        .map((f) => {
          const link = this.linkFor(f.from, f.to);
          const span = link?.latencyMs || 1;
          return {
            from: f.from,
            to: f.to,
            progress: Math.min(1, Math.max(0, 1 - (f.arriveAt - this.timeMs) / span)),
          };
        }),
    };
  }
}

export { keyOf };
