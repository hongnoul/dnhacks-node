// gossip.ts — replication over an unreliable, partially-connected graph.
//
// Two mechanisms, each covering the other's failure (ARCHITECTURE.md §7.4):
//
//   push  — forward new records to every neighbour except the sender. Fast
//           (~diameter x hop latency) but lossy: a dropped message is dropped
//           forever.
//   pull  — exchange digests every few seconds and send back whatever the peer
//           lacks. Slow but complete: repairs loss, backfills late joiners, and
//           heals partitions.
//
// Reconciliation is two messages, not three: `digest` from the peer that wants
// to catch up, `records` straight back. A separate `want` round trip would only
// buy the requester control over pull size, which chunking already handles.

import type { Link } from "./link.ts";
import type { Log } from "./log.ts";
import type { Identity } from "./identity.ts";
import { PROTO_VERSION, type GossipMsg, type MeshRecord, type NewRecord } from "./protocol.ts";

export const DIGEST_INTERVAL_MS = 5_000;
const CHUNK = 100; // ~80 B a record, so ~8 KB — well under the 16 KB batch ceiling

export interface GossipStats {
  sent: number;
  received: number;
  duplicates: number;
  forwarded: number;
}

export class Gossip {
  public stats: GossipStats = {
    sent: 0,
    received: 0,
    duplicates: 0,
    forwarded: 0,
  };

  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private greeted = new Set<string>();
  private changeCb: () => void = () => {};
  private handlers = new Map<string, (from: string, msg: any) => void>();

  private link: Link;
  private log: Log;
  private id: Identity;
  /**
   * A passive peer publishes and observes but never forwards and never answers a
   * digest. That is what lets the admin console attach to every node for
   * visibility without becoming a bridge that would silently repair the very
   * partition it is demonstrating (ARCHITECTURE.md §3.2).
   */
  private passive: boolean;
  /** Anti-entropy period. Lowered in tests so convergence is not timer-bound. */
  private digestMs: number;

  constructor(
    link: Link,
    log: Log,
    id: Identity,
    passive = false,
    digestMs = DIGEST_INTERVAL_MS
  ) {
    this.link = link;
    this.log = log;
    this.id = id;
    this.passive = passive;
    this.digestMs = digestMs;
    link.onMessage((from, payload) => this.receive(from, payload as GossipMsg));
    link.onNeighbours((ns) => this.greet(ns));
  }

  start(): void {
    if (this.passive) return;
    this.timer ??= setInterval(() => this.antiEntropy(), this.digestMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  /** Lets other modules (clock sync) share the one message loop. */
  registerHandler(m: string, fn: (from: string, msg: any) => void): void {
    this.handlers.set(m, fn);
  }

  send(to: string, msg: GossipMsg): void {
    this.link.send(to, msg);
    this.stats.sent++;
  }

  /** Append a record of our own and push it to the mesh. */
  publish(fields: NewRecord): MeshRecord {
    const r: MeshRecord = {
      ...fields,
      origin: this.id.nodeId,
      boot: this.id.boot,
      seq: ++this.seq,
      t: Date.now(),
    };
    this.log.add(r);
    this.broadcast({ m: "records", r: [r] });
    this.changeCb();
    return r;
  }

  // ---------- internals ----------

  private broadcast(msg: GossipMsg, except?: string): void {
    for (const n of this.link.neighbours) {
      if (n !== except) this.send(n, msg);
    }
  }

  private greet(neighbours: string[]): void {
    for (const n of neighbours) {
      if (this.greeted.has(n)) continue;
      this.greeted.add(n);
      if (this.passive) continue;
      this.send(n, {
        m: "hello",
        node: this.id.nodeId,
        boot: this.id.boot,
        proto: PROTO_VERSION,
      });
    }
    // Drop peers that are no longer adjacent so a re-added link re-greets.
    for (const n of [...this.greeted]) {
      if (!neighbours.includes(n)) this.greeted.delete(n);
    }
  }

  private antiEntropy(): void {
    this.broadcast({ m: "digest", vv: this.log.vv() });
  }

  private sendRecords(to: string, records: MeshRecord[]): void {
    for (let i = 0; i < records.length; i += CHUNK) {
      this.send(to, { m: "records", r: records.slice(i, i + CHUNK) });
    }
  }

  private receive(from: string, msg: GossipMsg): void {
    if (!msg || typeof msg !== "object") return;
    this.stats.received++;

    switch (msg.m) {
      case "hello":
        // A fresh peer is exactly a peer that may be behind: reconcile at once
        // rather than waiting up to a full digest interval.
        if (!this.passive) this.send(from, { m: "digest", vv: this.log.vv() });
        break;

      case "digest": {
        if (this.passive) break;
        const delta = this.log.since(msg.vv);
        if (delta.length) this.sendRecords(from, delta);
        break;
      }

      case "records": {
        const fresh: MeshRecord[] = [];
        for (const r of msg.r) {
          if (this.log.add(r)) fresh.push(r);
          else this.stats.duplicates++;
        }
        if (fresh.length) {
          if (!this.passive) {
            // Never back to the sender: that is what bounds a flood to 2|E|.
            this.broadcast({ m: "records", r: fresh }, from);
            this.stats.forwarded += fresh.length;
          }
          this.changeCb();
        }
        break;
      }

      default: {
        const h = this.handlers.get((msg as { m: string }).m);
        if (h) h(from, msg);
      }
    }
  }
}
