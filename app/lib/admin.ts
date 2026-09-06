// admin.ts — the relay's control plane.
//
// Separate from gossip on purpose (IMPLEMENTATION.md §3). The relay parses this
// channel because it is the relay's own state — admission, topology, link
// health. It never parses the gossip channel. Positions are NOT sent here: they
// are records, published into the mesh by the admin's passive node, so they
// propagate by gossip like anything else (ARCHITECTURE.md §3.3).

"use client";

import { isSimulationAlert, mergeSimulationAlert, type SimulationAlert, type SimulationNotice } from "./simulationChannel.ts";

export interface RelayLinkState {
  a: string;
  b: string;
  up: boolean;
  latency_ms: number;
  loss: number;
}

export interface RelayState {
  nodes: { node: string; admitted: boolean }[];
  topology: Record<string, string[]>;
  links: RelayLinkState[];
}

export interface Forward {
  from: string;
  to: string;
  dropped: string | null;
  at: number;
}

export class AdminChannel {
  public state: RelayState = { nodes: [], topology: {}, links: [] };
  public forwards: Forward[] = [];
  public connected = false;
  public simulationAlerts: SimulationAlert[] = [];

  private ws: WebSocket | null = null;
  private cb: () => void = () => {};
  private closed = false;
  private url: string;
  private session: string;

  constructor(url: string, session: string) {
    this.url = url;
    this.session = session;
    this.connect();
  }

  onChange(cb: () => void): void {
    this.cb = cb;
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      ws.send(JSON.stringify({ ctrl: "admin", session: this.session }));
      this.cb();
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.ctrl === "state") {
        this.state = { nodes: m.nodes, topology: m.topology, links: m.links };
        this.cb();
      } else if (m.ctrl === "forward") {
        // The relay cannot tell a reading from a ping — the payload is opaque to
        // it by design — so this is *all* mesh traffic, not just records.
        this.forwards.push({ from: m.from, to: m.to, dropped: m.dropped, at: Date.now() });
        if (this.forwards.length > 120) this.forwards.splice(0, this.forwards.length - 120);
      } else if (m.ctrl === "simulation" && isSimulationAlert(m.alert)) {
        this.simulationAlerts = mergeSimulationAlert(this.simulationAlerts, m.alert);
        this.cb();
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.cb();
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  admit(node: string): void {
    this.send({ ctrl: "admit", node });
  }
  setTopology(edges: Record<string, string[]>): void {
    this.send({ ctrl: "set_topology", edges });
  }
  setLink(a: string, b: string, patch: Partial<RelayLinkState>): void {
    this.send({ ctrl: "set_link", a, b, ...patch });
  }
  publishSimulation(notice: SimulationNotice): boolean {
    // Never queue old scenarios for a later connection and claim they are live.
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ ctrl: "simulation", notice }));
    return true;
  }
  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/** Symmetric adjacency from an undirected edge list. */
export function edgesToTopology(edges: [string, string][]): Record<string, string[]> {
  const t: Record<string, string[]> = {};
  const push = (a: string, b: string) => {
    (t[a] ??= []).includes(b) || t[a].push(b);
  };
  for (const [a, b] of edges) {
    push(a, b);
    push(b, a);
  }
  return t;
}

export type Preset = "ring" | "bridge" | "full";

/**
 * Presets exist because the demo needs a specific shape: `bridge` has a cut edge
 * to sever, which is what makes partition-and-heal observable. A full mesh among
 * phones in one room proves nothing, since nothing is ever routed (§5).
 */
export function preset(kind: Preset, nodes: string[]): [string, string][] {
  const n = nodes.length;
  if (n < 2) return [];
  if (kind === "full") {
    const out: [string, string][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([nodes[i], nodes[j]]);
    return out;
  }
  if (kind === "ring") return nodes.map((a, i) => [a, nodes[(i + 1) % n]] as [string, string]);

  // bridge: two clusters joined by a single edge.
  const half = Math.ceil(n / 2);
  const left = nodes.slice(0, half);
  const right = nodes.slice(half);
  const out: [string, string][] = [];
  const clique = (g: string[]) => {
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) out.push([g[i], g[j]]);
  };
  clique(left);
  clique(right);
  if (left.length && right.length) out.push([left[left.length - 1], right[0]]);
  return out;
}
