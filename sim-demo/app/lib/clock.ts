// clock.ts — coarse mesh time.
//
// No audio crosses the wire, so there is no cross-correlation and no
// millisecond sync requirement (ARCHITECTURE.md §8). All that is needed is
// enough agreement to bin readings into 500 ms windows: ±50 ms, which ordinary
// NTP-style exchange clears easily.
//
// There is no central time authority, so nodes converge on a deterministic
// *time root* — the lowest node id anyone has heard of — and offsets compose
// along gossip paths, distance-vector style. No election, no tie-breaking.

import type { Gossip } from "./gossip.ts";
import type { Link } from "./link.ts";

const PING_INTERVAL_MS = 5_000;
const BURST = 5;
export const WINDOW_MS = 500;

/** How long a min-RTT sample stays authoritative before a worse one may replace it. */
const SAMPLE_TTL_MS = 60_000;

interface Sample {
  offset: number; // peer clock − my clock
  rtt: number;
  at: number;
}

export class Clock {
  /** Lowest node id seen: the deterministic time root. */
  public rootId: string;
  /** meshTime − localTime. Zero at the root by definition. */
  public offsetToRoot = 0;
  public hopsToRoot = 0;
  public sigmaMs = 0;

  private gossip: Gossip;
  private link: Link;
  private selfId: string;
  private best = new Map<string, Sample>();
  private peerRoot = new Map<string, { root: string; hops: number; offset: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;

  /**
   * A passive observer (the admin console) must never become the time root:
   * it would anchor mesh time purely because "admin" sorts first, and the whole
   * mesh would re-root the moment the operator closed the tab.
   */
  private rootEligible: boolean;

  constructor(gossip: Gossip, link: Link, selfId: string, rootEligible = true) {
    this.gossip = gossip;
    this.link = link;
    this.selfId = selfId;
    this.rootEligible = rootEligible;
    this.rootId = rootEligible ? selfId : "";

    gossip.registerHandler("ping", (from, msg) => {
      const t2 = Date.now();
      gossip.send(from, {
        m: "pong",
        id: msg.id,
        t1: msg.t1,
        t2,
        t3: Date.now(),
        root: this.rootId,
        hops: this.hopsToRoot,
        offset: this.offsetToRoot,
        eligible: this.rootEligible,
      } as never);
    });

    gossip.registerHandler("pong", (from, msg) => this.onPong(from, msg));
  }

  start(): void {
    for (let i = 0; i < BURST; i++) setTimeout(() => this.ping(), i * 200);
    this.timer ??= setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Mesh time in ms. Use this for every record timestamp. */
  now(): number {
    return Date.now() + this.offsetToRoot;
  }

  /** Window id for a mesh timestamp — snapped so independent nodes agree. */
  window(t: number = this.now()): number {
    return Math.floor(t / WINDOW_MS);
  }

  private ping(): void {
    const live = new Set(this.link.neighbours);
    // Forget peers that are no longer adjacent. Without this a cut link keeps
    // its stale offset forever and nodes follow a time root through a neighbour
    // they cannot reach.
    for (const peer of [...this.best.keys()]) if (!live.has(peer)) this.best.delete(peer);
    for (const peer of [...this.peerRoot.keys()]) if (!live.has(peer)) this.peerRoot.delete(peer);
    if (this.best.size === 0 && this.peerRoot.size === 0) this.recompute();

    for (const n of live) {
      this.gossip.send(n, { m: "ping", id: this.nextId++, t1: Date.now() } as never);
    }
  }

  private onPong(from: string, msg: any): void {
    const t4 = Date.now();
    const { t1, t2, t3 } = msg;
    const offset = (t2 - t1 + (t3 - t4)) / 2;
    const rtt = t4 - t1 - (t3 - t2);

    // Keep the minimum-RTT sample — least queueing delay, least bias — but let
    // it expire, or the offset freezes after the opening burst and never tracks
    // crystal drift.
    const prev = this.best.get(from);
    if (!prev || rtt < prev.rtt || t4 - prev.at > SAMPLE_TTL_MS) {
      this.best.set(from, { offset, rtt, at: t4 });
    }

    // Ignore a peer's own id as a root candidate when it is not eligible, but
    // still follow whatever root it has adopted.
    const advertised = msg.eligible === false && msg.root === from ? null : msg.root ?? from;
    if (advertised) {
      this.peerRoot.set(from, {
        root: advertised,
        hops: msg.hops ?? 0,
        offset: msg.offset ?? 0,
      });
    }
    this.recompute();
  }

  private recompute(): void {
    // Start from the assumption that we are the root (if eligible), then adopt
    // any better one. An ineligible node starts with no root at all.
    let root = this.rootEligible ? this.selfId : "";
    let hops = 0;
    let offsetToRoot = 0;
    let sigma = 0;

    for (const [peer, pr] of this.peerRoot) {
      const sample = this.best.get(peer);
      if (!sample) continue;
      const candidateRoot = pr.root;
      const candidateHops = pr.hops + 1;
      // Lower id wins; among equals, the shorter path wins.
      const better =
        root === "" ||
        candidateRoot < root ||
        (candidateRoot === root && candidateHops < hops);
      if (!better) continue;
      root = candidateRoot;
      hops = candidateHops;
      // time_root − time_me = (time_root − time_peer) + (time_peer − time_me)
      offsetToRoot = pr.offset + sample.offset;
      sigma = sample.rtt / 2;
    }

    this.rootId = root;
    this.hopsToRoot = hops;
    this.offsetToRoot = offsetToRoot;
    this.sigmaMs = sigma;
  }
}
