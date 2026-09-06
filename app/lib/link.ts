// link.ts — transport, behind an interface.
//
// Nothing above this line (gossip, version vectors, fusion) knows how bytes
// move. In the demo they move through a relay that emulates radio links; on real
// hardware each node listens and connects to its neighbours directly, running
// the identical protocol (ARCHITECTURE.md §4.0.1). Swapping one for the other is
// a new implementation of this interface, not a rewrite.

import { isSimulationAlert, type SimulationAlert } from "./simulationChannel.ts";

export interface Link {
  send(to: string, payload: unknown): void;
  onMessage(cb: (from: string, payload: unknown) => void): void;
  onNeighbours(cb: (neighbours: string[]) => void): void;
  onStatus(cb: (status: LinkStatus) => void): void;
  readonly neighbours: string[];
  close(): void;
}

export type LinkStatus =
  | { state: "connecting" }
  | { state: "pending"; nodeId: string }
  | { state: "active"; nodeId: string }
  | { state: "disconnected"; error?: string };

export class RelayedLink implements Link {
  private ws: WebSocket | null = null;
  private msgCb: (from: string, payload: unknown) => void = () => {};
  private nbrCb: (n: string[]) => void = () => {};
  private statusCb: (s: LinkStatus) => void = () => {};
  private simulationCb: (alert: SimulationAlert) => void = () => {};
  private backoffMs = 500;
  private closed = false;

  public neighbours: string[] = [];

  private url: string;
  private sessionId: string;
  private nodeId: string;

  constructor(url: string, sessionId: string, nodeId: string) {
    this.url = url;
    this.sessionId = sessionId;
    this.nodeId = nodeId;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.statusCb({ state: "connecting" });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 500;
      ws.send(
        JSON.stringify({
          ctrl: "join",
          session: this.sessionId,
          node: this.nodeId,
        })
      );
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.from !== undefined) {
        this.msgCb(msg.from, msg.payload);
        return;
      }
      switch (msg.ctrl) {
        case "simulation":
          if (isSimulationAlert(msg.alert)) this.simulationCb(msg.alert);
          break;
        case "pending":
          this.statusCb({ state: "pending", nodeId: msg.node });
          break;
        case "admitted":
          this.neighbours = msg.neighbours ?? [];
          this.statusCb({ state: "active", nodeId: msg.node });
          this.nbrCb(this.neighbours);
          break;
        case "neighbours":
          this.neighbours = msg.neighbours ?? [];
          this.nbrCb(this.neighbours);
          break;
      }
    };

    // A dropped socket resets nothing: the replica stays in memory, so
    // reconnect is hello + digest + delta rather than a full resync (§7.8).
    ws.onclose = () => {
      this.statusCb({ state: "disconnected" });
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
    };

    ws.onerror = () => {
      this.statusCb({ state: "disconnected", error: "socket error" });
    };
  }

  send(to: string, payload: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Backpressure: a late joiner pulling full history can outrun the socket.
    if (this.ws.bufferedAmount > 256 * 1024) return;
    this.ws.send(JSON.stringify({ to, payload }));
  }

  onMessage(cb: (from: string, payload: unknown) => void): void {
    this.msgCb = cb;
  }
  onNeighbours(cb: (n: string[]) => void): void {
    this.nbrCb = cb;
  }
  onStatus(cb: (s: LinkStatus) => void): void {
    this.statusCb = cb;
  }

  onSimulation(cb: (alert: SimulationAlert) => void): void {
    this.simulationCb = cb;
  }

  acknowledgeSimulation(id: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ ctrl: "simulation_ack", id }));
    return true;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
