// mesh.ts — one object wiring link + log + gossip + clock + fusion.
//
// Every node runs this, including the admin console (passively). There is no
// privileged instance: each derives the whole picture from its own replica, so
// two nodes disagreeing means gossip is still in flight, not that one of them is
// wrong (ARCHITECTURE.md §10).

import { Gossip } from "./gossip.ts";
import { Log } from "./log.ts";
import { RelayedLink, type LinkStatus } from "./link.ts";
import { Clock } from "./clock.ts";
import { loadIdentity, type Identity } from "./identity.ts";
import { fuse, type Estimate, type Placed, type Room, type NodeReading } from "./fusion.ts";
import type { NewRecord } from "./protocol.ts";
import type { Score } from "./scoring.ts";
import { DETECT_THRESHOLD, GRAPH_WINDOW_MS } from "./detection.ts";
import type { Point } from "./ConfidenceGraph.tsx";

export const DEFAULT_ROOM: Room = { w: 12, h: 8 };

/** How far back a reading still counts toward the current picture. */
const FRESH_MS = 3_000;

export interface MeshView {
  nodeId: string;
  status: LinkStatus;
  neighbours: string[];
  records: number;
  positions: Map<string, Placed>;
  /** Null unless at least one node is actually reporting — see view(). */
  estimate: Estimate | null;
  /** Nodes reporting fresh readings, whatever the value. */
  listening: number;
  liveNodes: string[];
  clock: { rootId: string; offsetMs: number; hops: number };
  stats: { sent: number; received: number; duplicates: number; forwarded: number };
}

export class Mesh {
  public readonly id: Identity;
  public readonly log = new Log();
  public readonly link: RelayedLink;
  public readonly gossip: Gossip;
  public readonly clock: Clock;
  public room: Room = DEFAULT_ROOM;

  private status: LinkStatus = { state: "connecting" };
  private listeners = new Set<() => void>();

  constructor(opts: {
    url: string;
    session: string;
    requestedId?: string | null;
    passive?: boolean;
  }) {
    this.id = loadIdentity(opts.requestedId);
    this.link = new RelayedLink(opts.url, opts.session, this.id.nodeId);
    this.gossip = new Gossip(this.link, this.log, this.id, opts.passive ?? false);
    this.clock = new Clock(this.gossip, this.link, this.id.nodeId, !(opts.passive ?? false));

    this.link.onStatus((s) => {
      this.status = s;
      this.emit();
    });
    this.gossip.onChange(() => this.emit());
  }

  start(): void {
    this.gossip.start();
    this.clock.start();
  }

  stop(): void {
    this.gossip.stop();
    this.clock.stop();
    this.link.close();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  publishReading(score: Score): void {
    this.gossip.publish({
      type: "reading",
      p: score.p,
      logit: score.logit,
      snr_db: score.snrDb,
    } satisfies NewRecord);
  }

  /** Admin only: node placement, injected as a record so it gossips (§3.3). */
  publishPosition(node: string, x: number, y: number, enabled = true): void {
    this.gossip.publish({ type: "node_config", node, x, y, enabled } satisfies NewRecord);
  }

  positions(): Map<string, Placed> {
    const out = new Map<string, Placed>();
    // Sorted by key, so the last write per node wins deterministically across
    // replicas — a single-writer LWW register on a grow-only log (§3.3).
    for (const r of this.log.ofType("node_config")) {
      const c = r as unknown as { node: string; x: number; y: number; enabled: boolean };
      if (c.enabled) out.set(c.node, { node: c.node, x: c.x, y: c.y });
      else out.delete(c.node);
    }
    return out;
  }

  /**
   * Confidence history for one node, straight out of the replicated log.
   *
   * Note where this comes from: on the operator console these points arrived by
   * gossip, so the graph is both the detection picture and evidence that
   * replication works. No separate telemetry path exists.
   */
  history(node: string, windowMs = GRAPH_WINDOW_MS): Point[] {
    const cutoff = this.clock.now() - windowMs;
    const out: Point[] = [];
    for (const rec of this.log.ofType("reading")) {
      const r = rec as unknown as { origin: string; t: number; p: number };
      if (r.origin === node && r.t >= cutoff) out.push({ t: r.t, p: r.p });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** Nodes currently over ml-demo's detection threshold. */
  detecting(): string[] {
    return this.currentReadings()
      .filter((r) => r.p >= DETECT_THRESHOLD)
      .map((r) => r.node);
  }

  /** Most recent reading per node, within the freshness window. */
  currentReadings(): NodeReading[] {
    const now = this.clock.now();
    const latest = new Map<string, { t: number; r: NodeReading }>();
    for (const rec of this.log.ofType("reading")) {
      const r = rec as unknown as { origin: string; t: number; p: number; snr_db: number | null };
      if (now - r.t > FRESH_MS) continue;
      const prev = latest.get(r.origin);
      if (!prev || r.t > prev.t) {
        latest.set(r.origin, { t: r.t, r: { node: r.origin, p: r.p, snrDb: r.snr_db } });
      }
    }
    return [...latest.values()].map((e) => e.r);
  }

  view(): MeshView {
    const positions = this.positions();
    const readings = this.currentReadings();
    const est = fuse({ room: this.room, positions, readings });
    // With every node silent, the posterior is still well defined — it points
    // away from all of them — but rendering that as a track would claim a
    // detection nobody made. Report "nothing heard" instead.
    const detected = est !== null && est.nReports > 0;
    return {
      nodeId: this.id.nodeId,
      status: this.status,
      neighbours: this.link.neighbours,
      records: this.log.size,
      positions,
      estimate: detected ? est : null,
      listening: readings.length,
      liveNodes: readings.map((r) => r.node),
      clock: {
        rootId: this.clock.rootId,
        offsetMs: this.clock.offsetToRoot,
        hops: this.clock.hopsToRoot,
      },
      stats: this.gossip.stats,
    };
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}
