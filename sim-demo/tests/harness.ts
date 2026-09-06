// harness.ts — spin up a real relay and real nodes, in-process.
//
// You cannot hand-test a mesh. This runs the actual relay subprocess and the
// actual Link/Log/Gossip modules, so the tests exercise the shipping code paths
// rather than a model of them (IMPLEMENTATION.md §6).

import { spawn, type ChildProcess } from "node:child_process";
import { Gossip } from "../app/lib/gossip.ts";
import { Log } from "../app/lib/log.ts";
import { RelayedLink } from "../app/lib/link.ts";
import type { Identity } from "../app/lib/identity.ts";

// node:test runs each FILE in its own process but runs files CONCURRENTLY, so a
// fixed port makes two suites fight over one relay — and one file's after() hook
// kills the relay the other is still using. Bind an ephemeral port instead.
// Module state is safe here precisely because each file gets its own process.
let relayPort = 0;

export function relayWs(): string {
  if (!relayPort) throw new Error("startRelay() has not run yet");
  return `ws://127.0.0.1:${relayPort}/ws`;
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitFor(
  cond: () => boolean,
  timeoutMs = 5000,
  label = "condition",
  progress?: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const detail = progress ? ` — ${progress()}` : "";
  throw new Error(`timed out waiting for ${label}${detail}`);
}

export async function startRelay(): Promise<ChildProcess> {
  relayPort = await freePort();
  const proc = spawn(
    "server/.venv/bin/uvicorn",
    ["relay:app", "--app-dir", "server", "--host", "127.0.0.1", "--port", String(relayPort), "--log-level", "warning"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  proc.stderr?.on("data", (d) => {
    const line = String(d).trim();
    if (line && !line.includes("WARNING")) console.error("[relay]", line);
  });
  proc.on("exit", (code, sig) => console.error(`[relay] exited code=${code} sig=${sig}`));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("relay failed to start");
}

/** Admin control-plane client: admission, topology, link state. */
export class Admin {
  private ws: WebSocket;
  public state: any = null;
  public forwards: any[] = [];

  private session: string;

  constructor(session: string) {
    this.session = session;
    this.ws = new WebSocket(relayWs());
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({ ctrl: "admin", session: this.session }));
    this.ws.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string);
      if (m.ctrl === "state") this.state = m;
      if (m.ctrl === "forward") this.forwards.push(m);
    };
  }

  ready(): Promise<void> {
    return waitFor(() => this.state !== null, 5000, "admin state");
  }

  setTopology(edges: Record<string, string[]>): void {
    this.ws.send(JSON.stringify({ ctrl: "set_topology", edges }));
  }

  admit(node: string): void {
    this.ws.send(JSON.stringify({ ctrl: "admit", node }));
  }

  setLink(a: string, b: string, patch: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ ctrl: "set_link", a, b, ...patch }));
  }

  close(): void {
    this.ws.close();
  }
}

/** One node: the real Link + Log + Gossip stack. */
export class TestNode {
  public log = new Log();
  public link: RelayedLink;
  public gossip: Gossip;
  public active = false;
  public id: Identity;

  constructor(nodeId: string, session: string, boot = 1, digestMs = 400) {
    this.id = { nodeId, boot };
    this.link = new RelayedLink(relayWs(), session, nodeId);
    this.link.onStatus((s) => {
      if (s.state === "active") this.active = true;
      if (s.state === "disconnected") this.active = false;
    });
    // 400 ms instead of the shipping 5 s: convergence assertions should measure
    // the protocol, not the timer.
    this.gossip = new Gossip(this.link, this.log, this.id, false, digestMs);
    this.gossip.start();
  }

  close(): void {
    this.gossip.stop();
    this.link.close();
  }
}
