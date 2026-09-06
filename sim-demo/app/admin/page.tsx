// admin/page.tsx — the control plane.
//
// Two roles, deliberately separated (ARCHITECTURE.md §3):
//   1. control — admission, topology, link health, over the relay's ctrl channel
//   2. observer — a *passive* mesh node holding its own replica, so the big
//      screen shows what a node sees rather than a privileged server view
//
// The observer never forwards and never answers a digest, so attaching it to
// every node cannot silently repair the partition it is meant to demonstrate.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AdminChannel, edgesToTopology, preset, type Preset } from "../lib/admin.ts";
import { relayUrl, sessionId } from "../lib/config.ts";
import { useMesh } from "../lib/useMesh.ts";
import { RoomMap, linkKey } from "../lib/RoomMap.tsx";
import { DEFAULT_ROOM } from "../lib/mesh.ts";

const ADMIN_ID = "admin";

export default function AdminPage() {
  const chanRef = useRef<AdminChannel | null>(null);
  const [, force] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingEdge, setPendingEdge] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const { mesh, view } = useMesh({ passive: true, forceId: ADMIN_ID });

  useEffect(() => {
    const chan = new AdminChannel(relayUrl(), sessionId());
    chan.onChange(() => force((n) => n + 1));
    chanRef.current = chan;
    // Animation + reading expiry both need a heartbeat independent of traffic.
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => {
      clearInterval(id);
      chan.close();
      chanRef.current = null;
    };
  }, []);

  const chan = chanRef.current;
  const state = chan?.state ?? { nodes: [], topology: {}, links: [] };

  // The observer joins like any node, so it lands in the pending queue too.
  // Admit it silently — it is this console, not a sensor awaiting approval.
  useEffect(() => {
    const self = state.nodes.find((n) => n.node === ADMIN_ID);
    if (self && !self.admitted) chan?.admit(ADMIN_ID);
  }, [chan, state.nodes]);
  const sensors = state.nodes.filter((n) => n.node !== ADMIN_ID);
  const admitted = sensors.filter((n) => n.admitted).map((n) => n.node);
  const pending = sensors.filter((n) => !n.admitted);

  const positions = view?.positions ?? new Map();
  const downLinks = useMemo(
    () => new Set(state.links.filter((l) => !l.up).map((l) => linkKey(l.a, l.b))),
    [state.links]
  );

  // Levels drive the pulse on each node marker.
  const levels = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of mesh?.currentReadings() ?? []) m.set(r.node, r.p);
    return m;
  }, [mesh, tick]);

  const ripples = useMemo(
    () => (chan?.forwards ?? []).filter((f) => !f.dropped && Date.now() - f.at < 600),
    [chan, tick]
  );

  /** Topology always links the admin observer to every node, plus the sensor graph. */
  function applyTopology(edges: [string, string][]) {
    const withAdmin: [string, string][] = [
      ...edges,
      ...admitted.map((n) => [ADMIN_ID, n] as [string, string]),
    ];
    chan?.setTopology(edgesToTopology(withAdmin));
  }

  function sensorEdges(): [string, string][] {
    const out: [string, string][] = [];
    const seen = new Set<string>();
    for (const [a, ns] of Object.entries(state.topology)) {
      if (a === ADMIN_ID) continue;
      for (const b of ns) {
        if (b === ADMIN_ID) continue;
        const k = linkKey(a, b);
        if (!seen.has(k)) {
          seen.add(k);
          out.push([a, b]);
        }
      }
    }
    return out;
  }

  function applyPreset(kind: Preset) {
    applyTopology(preset(kind, admitted));
  }

  /** Ring-lay any admitted node that has no position yet, so the map is never empty. */
  function autoPlace() {
    if (!mesh) return;
    admitted.forEach((node, i) => {
      if (positions.has(node)) return;
      const a = (2 * Math.PI * i) / Math.max(admitted.length, 1);
      mesh.publishPosition(
        node,
        DEFAULT_ROOM.w / 2 + Math.cos(a) * DEFAULT_ROOM.w * 0.36,
        DEFAULT_ROOM.h / 2 + Math.sin(a) * DEFAULT_ROOM.h * 0.36
      );
    });
  }

  function onPick(node: string) {
    if (node === ADMIN_ID) return;
    if (!pendingEdge) {
      setSelected(node);
      setPendingEdge(node);
      return;
    }
    if (pendingEdge === node) {
      setPendingEdge(null);
      return;
    }
    // Second click completes or removes an edge.
    const existing = sensorEdges();
    const k = linkKey(pendingEdge, node);
    const next = existing.some(([a, b]) => linkKey(a, b) === k)
      ? existing.filter(([a, b]) => linkKey(a, b) !== k)
      : [...existing, [pendingEdge, node] as [string, string]];
    applyTopology(next);
    setPendingEdge(null);
  }

  const est = view?.estimate ?? null;
  const sensorLinks = state.links.filter((l) => l.a !== ADMIN_ID && l.b !== ADMIN_ID);

  return (
    <main style={{ padding: 16, display: "grid", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>SkyMesh — operator</h1>
        <span className="dim" style={{ color: chan?.connected ? "var(--ok)" : "var(--hot)" }}>
          relay {chan?.connected ? "connected" : "down"} · {admitted.length} nodes ·{" "}
          {view?.records ?? 0} records
        </span>
      </div>

      <div className="wrap" style={{ alignItems: "flex-start" }}>
        <div className="panel">
          <RoomMap
            room={DEFAULT_ROOM}
            positions={positions}
            estimate={est}
            topology={state.topology}
            downLinks={downLinks}
            levels={levels}
            selected={pendingEdge ?? selected}
            onPick={onPick}
            onMove={(node, x, y) => mesh?.publishPosition(node, x, y)}
            ripples={ripples}
            width={620}
          />
          <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            Drag to place. Click two nodes to add or remove a link.
            {pendingEdge && <b style={{ color: "var(--accent)" }}> linking from {pendingEdge}…</b>}
          </div>
          <div style={{ fontSize: 13, marginTop: 6 }}>
            {est ? (
              <>
                <b>{est.nReports}</b> reporting · <b>{est.nSilent}</b> silent · ±
                {est.spreadM.toFixed(1)} m at ({est.x.toFixed(1)}, {est.y.toFixed(1)})
                {!est.graded && (
                  <span style={{ color: "var(--warn)" }}> · no SNR on the wire: coarse</span>
                )}
              </>
            ) : positions.size > 0 ? (
              <span className="dim">
                nothing heard · {view?.listening ?? 0} nodes listening
              </span>
            ) : (
              <span className="dim">no positioned readings — admit and place some nodes</span>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 12, minWidth: 300, flex: 1 }}>
          {pending.length > 0 && (
            <div className="panel" style={{ borderColor: "var(--accent)" }}>
              <h2>waiting to join</h2>
              {pending.map((n) => (
                <div key={n.node} className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
                  <span>{n.node}</span>
                  <button className="primary" onClick={() => chan?.admit(n.node)}>
                    admit
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="panel">
            <h2>topology</h2>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button onClick={() => applyPreset("bridge")}>two clusters + bridge</button>
              <button onClick={() => applyPreset("ring")}>ring</button>
              <button onClick={() => applyPreset("full")}>full mesh</button>
              <button onClick={autoPlace}>auto-place</button>
            </div>
            <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
              Adjacency is imposed here — every phone can physically reach every other.
              It stands in for the radio range of a real deployment, and the bridge preset
              is what makes partition-and-heal visible.
            </p>
          </div>

          <div className="panel">
            <h2>links</h2>
            {sensorLinks.length === 0 && <span className="dim">no links yet</span>}
            <table>
              <tbody>
                {sensorLinks.map((l) => (
                  <tr key={linkKey(l.a, l.b)}>
                    <td>{l.a}–{l.b}</td>
                    <td>
                      <button
                        className={l.up ? "danger" : ""}
                        onClick={() => chan?.setLink(l.a, l.b, { up: !l.up })}
                      >
                        {l.up ? "cut" : "restore"}
                      </button>
                    </td>
                    <td style={{ width: 120 }}>
                      <input
                        type="range" min={0} max={500} step={10} value={l.latency_ms}
                        onChange={(e) => chan?.setLink(l.a, l.b, { latency_ms: +e.target.value })}
                      />
                      <div className="dim">{l.latency_ms} ms</div>
                    </td>
                    <td style={{ width: 110 }}>
                      <input
                        type="range" min={0} max={0.5} step={0.05} value={l.loss}
                        onChange={(e) => chan?.setLink(l.a, l.b, { loss: +e.target.value })}
                      />
                      <div className="dim">{Math.round(l.loss * 100)}% loss</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => sensorLinks.forEach((l) => chan?.setLink(l.a, l.b, { latency_ms: 500, loss: 0.2 }))}
              >
                degrade all (500 ms, 20%)
              </button>
              <button
                onClick={() => sensorLinks.forEach((l) => chan?.setLink(l.a, l.b, { latency_ms: 50, loss: 0, up: true }))}
              >
                restore all
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>nodes</h2>
            <table>
              <thead>
                <tr><th>node</th><th>p</th><th>pos</th><th>neighbours</th></tr>
              </thead>
              <tbody>
                {admitted.map((n) => {
                  const pos = positions.get(n);
                  const p = levels.get(n);
                  return (
                    <tr key={n}>
                      <td>{n}</td>
                      <td style={{ color: (p ?? 0) > 0.7 ? "var(--hot)" : undefined }}>
                        {p === undefined ? "—" : p.toFixed(2)}
                      </td>
                      <td className="dim">
                        {pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}` : "unplaced"}
                      </td>
                      <td className="dim">
                        {(state.topology[n] ?? []).filter((x) => x !== ADMIN_ID).join(" ") || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
