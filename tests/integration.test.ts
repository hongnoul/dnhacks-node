// integration.test.ts — the end-to-end claim.
//
// "Every phone holds the whole picture, every phone computes it independently,
// and no phone's loss degrades it" (ARCHITECTURE.md §1). This drives a real
// relay, real gossip and real fusion, then checks that six independent replicas
// reach the same answer — and keep working when one dies.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { Admin, TestNode, startRelay, waitFor } from "./harness.ts";
import { fuse, expectedSnr, DEFAULT_RANGE, type Placed } from "../app/lib/fusion.ts";
import { solveSurvey, METHOD_SIGMA_M, type Measurement } from "../app/lib/survey.ts";

let relay: ChildProcess;
before(async () => {
  relay = await startRelay();
});
after(() => relay?.kill());

const ROOM = { w: 12, h: 8 };
const PLACES: Record<string, [number, number]> = {
  n01: [0.5, 0.5], n02: [11.5, 0.5], n03: [0.5, 7.5],
  n04: [11.5, 7.5], n05: [6.0, 0.5], n06: [6.0, 7.5],
};
const IDS = Object.keys(PLACES);

// Two triangles joined by n03–n04, so there is an edge worth cutting.
const TOPOLOGY: Record<string, string[]> = {
  n01: ["n02", "n03"], n02: ["n01", "n03"], n03: ["n01", "n02", "n04"],
  n04: ["n03", "n05", "n06"], n05: ["n04", "n06"], n06: ["n04", "n05"],
};

/** What each node reports with a source at (tx, ty). */
function reading(node: string, tx: number, ty: number) {
  const [x, y] = PLACES[node];
  const snr = expectedSnr(Math.hypot(x - tx, y - ty), DEFAULT_RANGE);
  return { p: 1 / (1 + Math.exp(-(snr - 8) / 4)), logit: (snr - 8) / 4, snr_db: snr };
}

/** Fuse from one node's own replica, exactly as the UI does. */
function localEstimate(n: TestNode) {
  const positions = new Map<string, Placed>();
  for (const r of n.log.ofType("node_config")) {
    const c = r as any;
    positions.set(c.node, { node: c.node, x: c.x, y: c.y });
  }
  const latest = new Map<string, any>();
  for (const r of n.log.ofType("reading")) {
    const rec = r as any;
    const prev = latest.get(rec.origin);
    if (!prev || rec.t > prev.t) latest.set(rec.origin, rec);
  }
  return fuse({
    room: ROOM,
    positions,
    readings: [...latest.values()].map((r) => ({ node: r.origin, p: r.p, snrDb: r.snr_db })),
  });
}

async function bringUp(session: string) {
  const admin = new Admin(session);
  await admin.ready();
  admin.setTopology(TOPOLOGY);

  const nodes: Record<string, TestNode> = {};
  for (const id of IDS) nodes[id] = new TestNode(id, session);
  await waitFor(
    () => IDS.every((id) => admin.state?.nodes?.some((n: any) => n.node === id)),
    5000, "registration",
    () => (admin.state?.nodes ?? []).map((n: any) => n.node).join(",")
  );
  for (const id of IDS) admin.admit(id);
  await waitFor(() => IDS.every((id) => nodes[id].active), 5000, "admission",
    () => IDS.map((id) => `${id}:${nodes[id].active}`).join(" "));

  // The admin injects placement as records, so it spreads by gossip like
  // anything else (§3.3). Publish via n01 — the admin's own passive node is a
  // UI concern, and this proves config propagates through the sensor mesh.
  for (const [node, [x, y]] of Object.entries(PLACES)) {
    nodes.n01.gossip.publish({ type: "node_config", node, x, y, enabled: true });
  }
  await waitFor(
    () => IDS.every((id) => nodes[id].log.ofType("node_config").length === IDS.length),
    8000, "placement spread",
    () => IDS.map((id) => `${id}:${nodes[id].log.ofType("node_config").length}/${nodes[id].active ? "up" : "DOWN"}`).join(" ")
  );
  return { admin, nodes, close: () => { Object.values(nodes).forEach((n) => n.close()); admin.close(); } };
}

describe("end to end", () => {
  test("every node independently computes the same picture", async () => {
    const m = await bringUp("e2e");
    const [tx, ty] = [3, 4];
    for (const id of IDS) m.nodes[id].gossip.publish({ type: "reading", ...reading(id, tx, ty) });

    await waitFor(
      () => IDS.every((id) => m.nodes[id].log.ofType("reading").length === IDS.length),
      8000, "readings spread"
    );

    const estimates = IDS.map((id) => ({ id, est: localEstimate(m.nodes[id])! }));
    for (const { id, est } of estimates) {
      assert.ok(est, `${id} produced no estimate`);
      assert.ok(est.graded, `${id} fused without SNR`);
      assert.ok(
        Math.hypot(est.x - tx, est.y - ty) < 1.0,
        `${id} put the source at (${est.x.toFixed(1)}, ${est.y.toFixed(1)})`
      );
    }
    // Identical inputs, identical output — no coordinator, no vote.
    const first = estimates[0].est;
    for (const { id, est } of estimates) {
      assert.equal(est.x, first.x, `${id} disagreed on x`);
      assert.equal(est.y, first.y, `${id} disagreed on y`);
    }
    m.close();
  });

  test("losing a node degrades coverage, not the picture", async () => {
    const m = await bringUp("nodeloss");
    for (const id of IDS) m.nodes[id].gossip.publish({ type: "reading", ...reading(id, 6, 4) });
    await waitFor(
      () => m.nodes.n06.log.ofType("reading").length === IDS.length, 8000, "readings spread"
    );
    const before = m.nodes.n06.log.size;

    // n01 leaves. Its records were replicated, so they survive it.
    m.nodes.n01.close();
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(m.nodes.n06.log.size, before, "records of a departed node must persist");
    const est = localEstimate(m.nodes.n06)!;
    assert.ok(est, "survivors still fuse");
    assert.ok(est.nReports + est.nSilent >= IDS.length - 1);

    Object.entries(m.nodes).forEach(([id, n]) => id !== "n01" && n.close());
    m.admin.close();
  });

  test("a surveyed placement reaches every node with its uncertainty intact", async () => {
    // survey.ts quotes a sigma per node and mesh.ts puts it on the wire. If it
    // is dropped anywhere between here and a peer's replica, every phone
    // silently upgrades an eyeballed mark to a surveyed one — the exact
    // over-claim §13 asks the operator to record honestly.
    const m = await bringUp("survey-spread");
    const truth = Object.fromEntries(
      Object.entries(PLACES).map(([id, [x, y]]) => [id, [x, y] as [number, number]])
    );
    const measurements: Measurement[] = [];
    for (let i = 0; i < IDS.length; i++)
      for (let j = i + 1; j < IDS.length; j++) {
        const [ax, ay] = truth[IDS[i]];
        const [bx, by] = truth[IDS[j]];
        measurements.push({ a: IDS[i], b: IDS[j], dM: Math.hypot(ax - bx, ay - by) });
      }
    const solved = solveSurvey(measurements, { room: ROOM, defaultSigmaM: METHOD_SIGMA_M.tape })!;
    assert.ok(solved.nodes.every((n) => n.sigmaM > 0 && n.sigmaM < 0.5));

    for (const n of solved.nodes) {
      m.nodes.n01.gossip.publish({
        type: "node_config", node: n.node, x: n.x, y: n.y, sigma_m: n.sigmaM, enabled: true,
      });
    }
    await waitFor(
      // bringUp already placed each node once, so a second config per node is
      // 2 * IDS.length in total.
      () => IDS.every((id) => m.nodes[id].log.ofType("node_config").length === 2 * IDS.length),
      8000, "survey spread"
    );

    for (const id of IDS) {
      const latest = new Map<string, any>();
      for (const r of m.nodes[id].log.ofType("node_config")) latest.set((r as any).node, r);
      for (const n of solved.nodes) {
        const got = latest.get(n.node);
        assert.equal(got.sigma_m, n.sigmaM, `${id} lost ${n.node}'s sigma`);
      }
    }
    m.close();
  });

  test("position uncertainty widens the fix rather than being decorative", async () => {
    // The same readings and the same coordinates, differing only in how well
    // those coordinates are known. A sigma that does not move the posterior is
    // a number on a screen, not evidence.
    const m = await bringUp("survey-weight");
    const [tx, ty] = [3, 4];
    for (const id of IDS) m.nodes[id].gossip.publish({ type: "reading", ...reading(id, tx, ty) });
    await waitFor(
      () => IDS.every((id) => m.nodes[id].log.ofType("reading").length === IDS.length),
      8000, "readings spread"
    );

    const readings = [...new Map(
      m.nodes.n06.log.ofType("reading").map((r: any) => [r.origin, r])
    ).values()].map((r: any) => ({ node: r.origin, p: r.p, snrDb: r.snr_db }));
    const withSigma = (sigmaM?: number) =>
      fuse({
        room: ROOM,
        positions: new Map(
          Object.entries(PLACES).map(([node, [x, y]]) => [node, { node, x, y, sigmaM }])
        ),
        readings,
      })!;

    const surveyed = withSigma(0.1);   // tape
    const eyeballed = withSigma(1.5);  // dragged onto a satellite tile
    assert.ok(
      eyeballed.spreadM > surveyed.spreadM,
      `eyeballed ${eyeballed.spreadM.toFixed(2)} m should exceed surveyed ${surveyed.spreadM.toFixed(2)} m`
    );
    // Unstated sigma keeps the pre-survey behaviour exactly.
    assert.equal(withSigma(undefined).spreadM, withSigma(0).spreadM);
    m.close();
  });

  test("a degraded network still converges", async () => {
    // 500 ms latency and 20% loss on every link: push suffers, anti-entropy
    // still gets everyone there. Slow on purpose: loss compounds per hop, so a
    // 3-hop path drops roughly half, and repair waits on the 5 s digest timer.
    // The claim is that it converges, not that it converges quickly.
    const m = await bringUp("degraded");
    for (const [a, ns] of Object.entries(TOPOLOGY))
      for (const b of ns) if (a < b) m.admin.setLink(a, b, { latency_ms: 500, loss: 0.2 });
    await new Promise((r) => setTimeout(r, 300));

    for (const id of IDS) m.nodes[id].gossip.publish({ type: "reading", ...reading(id, 9, 2) });
    await waitFor(
      () => IDS.every((id) => m.nodes[id].log.ofType("reading").length === IDS.length),
      30000, "convergence under loss"
    );
    m.close();
  });
});
