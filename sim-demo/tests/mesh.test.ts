// mesh.test.ts — the properties the demo depends on.
//
// Priority order from IMPLEMENTATION.md §6: the reload/key-reuse bug first,
// because it is the one that corrupts the log permanently and silently.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { Admin, TestNode, startRelay, waitFor, relayWs } from "./harness.ts";
import { Log } from "../app/lib/log.ts";
import { keyOf } from "../app/lib/protocol.ts";

let relay: ChildProcess;

before(async () => {
  relay = await startRelay();
});
after(() => {
  relay?.kill();
});

// Triangle — bridge — triangle. Diameter 3, and n03–n04 is a cut edge, so the
// partition test can split it cleanly.
const TOPOLOGY: Record<string, string[]> = {
  n01: ["n02", "n03"],
  n02: ["n01", "n03"],
  n03: ["n01", "n02", "n04"],
  n04: ["n03", "n05", "n06"],
  n05: ["n04", "n06"],
  n06: ["n04", "n05"],
};

async function mesh(session: string, ids = Object.keys(TOPOLOGY)) {
  const admin = new Admin(session);
  await admin.ready();
  admin.setTopology(TOPOLOGY);

  const nodes: Record<string, TestNode> = {};
  for (const id of ids) nodes[id] = new TestNode(id, session);
  await waitFor(
    () => ids.every((id) => admin.state?.nodes?.some((n: any) => n.node === id)),
    5000,
    "nodes registered"
  );
  for (const id of ids) admin.admit(id);
  await waitFor(() => ids.every((id) => nodes[id].active), 5000, "nodes admitted");
  return { admin, nodes, close: () => {
    for (const n of Object.values(nodes)) n.close();
    admin.close();
  }};
}

const held = (n: TestNode, type: string) => n.log.ofType(type as any).length;

describe("log", () => {
  test("a reload cannot reuse a record key", () => {
    // The bug this guards: restarting seq at 1 after a reload writes a DIFFERENT
    // record under an EXISTING key. Both replicas then believe they have
    // converged, so anti-entropy never repairs it. `boot` makes that structural.
    const log = new Log();
    const before = { type: "reading" as const, origin: "n01", boot: 1, seq: 1, t: 1, p: 0.1 };
    const afterReload = { type: "reading" as const, origin: "n01", boot: 2, seq: 1, t: 2, p: 0.9 };

    assert.equal(log.add(before), true);
    assert.equal(log.add(afterReload), true, "post-reload record must not collide");
    assert.notEqual(keyOf(before), keyOf(afterReload));
    assert.equal(log.size, 2);
  });

  test("duplicate adds are rejected", () => {
    const log = new Log();
    const r = { type: "reading" as const, origin: "n01", boot: 1, seq: 1, t: 1, p: 0.1 };
    assert.equal(log.add(r), true);
    assert.equal(log.add({ ...r }), false);
    assert.equal(log.size, 1);
  });

  test("gaps hold the contiguous mark back until filled", () => {
    const log = new Log();
    const rec = (seq: number) => ({ type: "reading" as const, origin: "n01", boot: 1, seq, t: seq, p: 0 });
    log.add(rec(1));
    log.add(rec(3));
    assert.equal(log.vv()["n01:1"], 1, "seq 3 must not advance the mark past the gap");
    log.add(rec(2));
    assert.equal(log.vv()["n01:1"], 3, "filling the gap advances to 3");
  });

  test("since() returns exactly what a peer lacks", () => {
    const log = new Log();
    for (let s = 1; s <= 5; s++)
      log.add({ type: "reading" as const, origin: "n01", boot: 1, seq: s, t: s, p: 0 });
    assert.equal(log.since({}).length, 5);
    assert.equal(log.since({ "n01:1": 3 }).length, 2);
    assert.equal(log.since({ "n01:1": 5 }).length, 0);
  });

  test("sorted() is stable regardless of insertion order", () => {
    const mk = (o: string, s: number) => ({ type: "reading" as const, origin: o, boot: 1, seq: s, t: 0, p: 0 });
    const a = new Log(), b = new Log();
    [mk("n01", 1), mk("n02", 1), mk("n01", 2)].forEach((r) => a.add(r));
    [mk("n01", 2), mk("n01", 1), mk("n02", 1)].forEach((r) => b.add(r));
    assert.deepEqual(a.sorted().map(keyOf), b.sorted().map(keyOf));
  });
});

describe("relay", () => {
  test("routes payloads it cannot parse", async () => {
    // Payload opacity is the property that keeps "the server does not fuse"
    // testable rather than a promise (IMPLEMENTATION.md §3).
    const session = "opaque";
    const admin = new Admin(session);
    await admin.ready();
    admin.setTopology({ a: ["b"], b: ["a"] });

    const mkRaw = (id: string) =>
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(relayWs());
        ws.onopen = () => ws.send(JSON.stringify({ ctrl: "join", session, node: id }));
        ws.onmessage = (ev: MessageEvent) => {
          const m = JSON.parse(ev.data as string);
          if (m.ctrl === "pending") resolve(ws);
        };
      });

    const [wsA, wsB] = await Promise.all([mkRaw("a"), mkRaw("b")]);
    admin.admit("a");
    admin.admit("b");

    const got: unknown[] = [];
    wsB.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string);
      if (m.from) got.push(m.payload);
    };

    await new Promise((r) => setTimeout(r, 300));
    const garbage = { not: "gossip", nested: [1, 2, { deep: true }] };
    wsA.send(JSON.stringify({ to: "b", payload: garbage }));

    await waitFor(() => got.length > 0, 3000, "opaque payload delivered");
    assert.deepEqual(got[0], garbage);
    wsA.close(); wsB.close(); admin.close();
  });
});

describe("gossip", () => {
  test("records reach non-adjacent nodes by multi-hop flooding", async () => {
    const m = await mesh("multihop");
    m.nodes.n01.gossip.publish({ type: "reading", p: 0.94, logit: 2.75, snr_db: 14 } as any);

    // n01 -> n03 -> n04 -> n06 is three hops; n06 is not adjacent to n01.
    await waitFor(() => held(m.nodes.n06, "reading") === 1, 5000, "3-hop delivery");
    for (const id of Object.keys(TOPOLOGY))
      assert.equal(held(m.nodes[id], "reading"), 1, `${id} should hold exactly one`);
    m.close();
  });

  test("redundant paths deliver duplicates, and they are dropped", async () => {
    const m = await mesh("dedupe");
    m.nodes.n01.gossip.publish({ type: "reading", p: 0.5, logit: 0, snr_db: null } as any);
    await waitFor(() => held(m.nodes.n02, "reading") === 1, 5000, "delivery");
    await new Promise((r) => setTimeout(r, 400));

    // n02 hears it from n01 directly and again via n03.
    assert.ok(m.nodes.n02.gossip.stats.duplicates > 0, "expected a duplicate arrival");
    assert.equal(held(m.nodes.n02, "reading"), 1, "duplicate must not be stored twice");
    m.close();
  });

  test("non-adjacent sends are dropped by the relay", async () => {
    const m = await mesh("adjacency");
    m.nodes.n01.link.send("n06", { m: "records", r: [
      { type: "reading", origin: "n01", boot: 1, seq: 99, t: 0, p: 1 },
    ]});
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(held(m.nodes.n06, "reading"), 0, "n06 is not adjacent to n01");
    assert.ok(
      m.admin.forwards.some((f) => f.to === "n06" && f.dropped === "not_adjacent"),
      "relay should report the drop reason"
    );
    m.close();
  });

  test("a late joiner backfills the whole history", async () => {
    const session = "latejoin";
    const m = await mesh(session, ["n01", "n02", "n03"]);
    for (let i = 0; i < 5; i++)
      m.nodes.n01.gossip.publish({ type: "reading", p: i / 10, logit: 0, snr_db: null } as any);
    await waitFor(() => held(m.nodes.n03, "reading") === 5, 5000, "initial spread");

    // n04 arrives after the fact and must pull everything it missed.
    const late = new TestNode("n04", session);
    await waitFor(() => m.admin.state?.nodes?.some((n: any) => n.node === "n04"), 5000, "n04 seen");
    m.admin.admit("n04");
    await waitFor(() => late.active, 5000, "n04 admitted");

    await waitFor(() => held(late, "reading") === 5, 10000, "backfill via anti-entropy");
    late.close();
    m.close();
  });

  test("a partition heals to the union of both sides", async () => {
    const m = await mesh("partition");
    m.nodes.n01.gossip.publish({ type: "reading", p: 0.1, logit: 0, snr_db: null } as any);
    await waitFor(() => held(m.nodes.n06, "reading") === 1, 5000, "pre-cut spread");

    // Cut the bridge. n01..n03 and n04..n06 can no longer reach each other.
    m.admin.setLink("n03", "n04", { up: false });
    await new Promise((r) => setTimeout(r, 300));

    m.nodes.n01.gossip.publish({ type: "reading", p: 0.7, logit: 0, snr_db: null } as any);
    m.nodes.n06.gossip.publish({ type: "reading", p: 0.8, logit: 0, snr_db: null } as any);
    await waitFor(() => held(m.nodes.n02, "reading") === 2, 5000, "left side spread");
    await waitFor(() => held(m.nodes.n05, "reading") === 2, 5000, "right side spread");

    // Both halves kept working; neither blocked on the other.
    assert.equal(held(m.nodes.n01, "reading"), 2, "left must not see the right's record");
    assert.equal(held(m.nodes.n06, "reading"), 2, "right must not see the left's record");

    // Heal. Union of grow-only sets: nothing to reconcile, so both converge to 3.
    m.admin.setLink("n03", "n04", { up: true });
    await waitFor(
      () => Object.keys(TOPOLOGY).every((id) => held(m.nodes[id], "reading") === 3),
      15000,
      "convergence after heal"
    );
    m.close();
  });
});
