// AdminDashboard.tsx — the control plane, extracted from admin/page.tsx so it
// can live on the operator console (/station) beside the join QR and drone.
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
import { AdminChannel, edgesToTopology, preset, type Preset } from "./admin.ts";
import { relayUrl, sessionId } from "./config.ts";
import { useMesh } from "./useMesh.ts";
import { RoomMap, linkKey } from "./RoomMap.tsx";
import { ConfidenceGraph } from "./ConfidenceGraph.tsx";
import { DETECT_THRESHOLD } from "./detection.ts";
import { DEFAULT_ROOM } from "./mesh.ts";
import {
  DRONE_DETECTION_RADIUS_M,
  FLIGHT_DURATION_MS,
  IMPACT_RADIUS_M,
  MIN_CONNECTIONS,
  buildPlacementCandidate,
  findAlertPath,
  interpolatePosition,
  isConnected,
  networkHealth,
  nodesWithinRadius,
  placementNeighbours,
  placementStatus,
  pushEvent,
  type ActivityEvent,
  type PlacementCandidate,
  type PlacementStatus,
} from "./scenario.ts";

const ADMIN_ID = "admin";

/** Map interaction modes, ported from Avery's OperatorMap (Leaflet → RoomMap). */
type MapMode = "idle" | "placing" | "impact" | "droneStart" | "droneDestination";
type DronePhase = "idle" | "placingStart" | "placingDestination" | "ready" | "flying" | "complete";
interface AlertRoute {
  path: string[];
  phase: "routing" | "delivered" | "lost";
  reachedIndex: number;
  activeEdge: string | null;
}

/** Measure the parent so the map fills the column instead of fixing 620 px. */
function useContainerWidth(fallback: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.floor(Math.min(el.clientWidth, window.matchMedia("(min-width: 1000px) and (min-height: 650px)").matches && el.clientHeight > 0 ? el.clientHeight * 1.5 : el.clientWidth));
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    // First paint may precede layout; take whatever the box reports now too.
    const w = Math.floor(Math.min(el.clientWidth, window.matchMedia("(min-width: 1000px) and (min-height: 650px)").matches && el.clientHeight > 0 ? el.clientHeight * 1.5 : el.clientWidth));
    if (w > 0) setWidth(w);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function PageControls({ label, count, size, offset, onPage }: { label: string; count: number; size: number; offset: number; onPage: (page: number) => void }) {
  if (count <= size) return null;
  const page = offset / size;
  return <nav className="page-controls" aria-label={`${label} pages`}>
    <button aria-label={`Previous ${label.toLowerCase()}`} disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button>
    <span>{offset + 1}–{Math.min(offset + size, count)} of {count}</span>
    <button aria-label={`Next ${label.toLowerCase()}`} disabled={offset + size >= count} onClick={() => onPage(page + 1)}>›</button>
  </nav>;
}

export function AdminDashboard() {
  const chanRef = useRef<AdminChannel | null>(null);
  const [, force] = useState(0);
  const [eventPage, setEventPage] = useState(0);
  const [sensorPage, setSensorPage] = useState(0);
  const [linkPage, setLinkPage] = useState(0);
  const [pendingPage, setPendingPage] = useState(0);
  const [panel, setPanel] = useState("confidence");
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingEdge, setPendingEdge] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showLinks, setShowLinks] = useState(false);
  const { mesh, view } = useMesh({ passive: true, forceId: ADMIN_ID });
  const mapBox = useContainerWidth(560);

  // Scenario controls (Avery's demo layer, rewired to live mesh primitives).
  const [mode, setMode] = useState<MapMode>("idle");
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [placeHover, setPlaceHover] = useState<{ x: number; y: number } | null>(null);
  const [dronePhase, setDronePhase] = useState<DronePhase>("idle");
  const [droneStart, setDroneStart] = useState<{ x: number; y: number } | null>(null);
  const [droneDest, setDroneDest] = useState<{ x: number; y: number } | null>(null);
  const [dronePos, setDronePos] = useState<{ x: number; y: number } | null>(null);
  const [simDetecting, setSimDetecting] = useState<string[]>([]);
  const [alertRoute, setAlertRoute] = useState<AlertRoute | null>(null);
  const [impact, setImpact] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [interference, setInterference] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const flightRef = useRef<number | null>(null);
  const alertTimerRef = useRef<number | null>(null);
  const replayTimerRef = useRef<number | null>(null);
  const detectedRef = useRef<Set<string>>(new Set());

  function log(message: string, tone: ActivityEvent["tone"] = "info") {
    setEvents((cur) => pushEvent(cur, message, tone));
  }

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

  // Each node's own latched verdict — the mesh reports what the node decided,
  // it does not re-derive detection from p (detection.ts).
  const hot = useMemo(
    () => new Set(mesh?.detecting() ?? []),
    [mesh, tick]
  );

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
      setPanel("inspector");
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

  // ---- scenario layer (Avery's demo controls, live-mesh edition) ----

  const upLinks = useMemo(() => {
    const down = new Set(state.links.filter((l) => !l.up).map((l) => linkKey(l.a, l.b)));
    return (a: string, b: string) => !down.has(linkKey(a, b));
  }, [state.links]);

  const connected = isConnected(admitted, state.topology, upLinks);
  const health = networkHealth(admitted, view?.liveNodes ?? []);

  const placeCandidate: { candidate: PlacementCandidate; status: PlacementStatus } | null =
    useMemo(() => {
      if (mode !== "placing" || !placeHover) return null;
      const candidate = buildPlacementCandidate(placeHover.x, placeHover.y, positions);
      return { candidate, status: placementStatus(candidate) };
    }, [mode, placeHover, positions]);

  /** Every mutation goes through the control channel or gossip — never local. */
  function cutLinks(pairs: [string, string][], up: boolean, extra?: { latency_ms?: number; loss?: number }) {
    for (const [a, b] of pairs) chan?.setLink(a, b, { up, ...extra });
  }

  function handleMapClick(x: number, y: number) {
    if (mode === "placing") {
      const candidate = buildPlacementCandidate(x, y, positions);
      const status = placementStatus(candidate);
      if (status === "invalid") {
        log("Placement rejected — too close to an existing node", "critical");
        return;
      }
      if (status === "warning") {
        log(
          `Placement rejected — ${placementNeighbours(candidate).length}/${MIN_CONNECTIONS} required neighbours in range`,
          "warning"
        );
        return;
      }
      // No local node is created: the operator admits a real phone, then the
      // console guides where to stand by publishing the validated position.
      // For now, log the validated spot and its edges; the next admitted node
      // can be ring-placed near it via auto-place.
      log(
        `Valid placement at (${x.toFixed(1)}, ${y.toFixed(1)}) — ${placementNeighbours(candidate).length} links in range`,
        "success"
      );
      setPlaceHover(null);
      setMode("idle");
      return;
    }
    if (mode === "droneStart") {
      setDroneStart({ x, y });
      setDronePos({ x, y });
      setDroneDest(null);
      setDronePhase("placingDestination");
      setMode("droneDestination");
      log("Drone start placed — click a destination", "info");
      return;
    }
    if (mode === "droneDestination") {
      setDroneDest({ x, y });
      setDronePhase("ready");
      setMode("idle");
      log("Drone destination set — ready for flight", "info");
      return;
    }
    if (mode === "impact") {
      const ids = nodesWithinRadius({ x, y }, positions, IMPACT_RADIUS_M);
      setImpact({ x, y, ids });
      // Cut every link touching an affected node: the outage is demonstrated
      // by real partition, not by flipping a mock status flag.
      const pairs: [string, string][] = [];
      for (const [a, ns] of Object.entries(state.topology)) {
        for (const b of ns) {
          if (ids.includes(a) || ids.includes(b)) pairs.push([a, b]);
        }
      }
      cutLinks(pairs, false);
      setMode("idle");
      setSelected(null);
      log(
        ids.length ? `${ids.length} node${ids.length === 1 ? "" : "s"} cut off by simulated impact` : "Impact hit no nodes",
        ids.length ? "critical" : "success"
      );
      window.setTimeout(() => {
        cutLinks(pairs, true);
        setImpact(null);
        if (ids.length) log("Impact links restored", "success");
      }, 8_000);
    }
  }

  function startDroneMode() {
    resetDrone();
    setDronePhase("placingStart");
    setMode("droneStart");
    log("Select drone starting position", "info");
  }

  function resetDrone() {
    if (flightRef.current !== null) window.cancelAnimationFrame(flightRef.current);
    if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
    if (replayTimerRef.current !== null) window.clearTimeout(replayTimerRef.current);
    flightRef.current = null;
    alertTimerRef.current = null;
    replayTimerRef.current = null;
    // Cancelling mid-replay must not leave interference on with no flight to
    // justify it, nor the replay button stuck disabled.
    if (replaying) {
      setInterferenceOn(false);
      setReplaying(false);
      log("Replay cancelled", "info");
    }
    setAlertRoute(null);
    setDronePhase("idle");
    setDroneStart(null);
    setDroneDest(null);
    setDronePos(null);
    setSimDetecting([]);
    detectedRef.current.clear();
    if (mode === "droneStart" || mode === "droneDestination") setMode("idle");
  }

  /** Which positioned nodes fall inside the drone halo — a hint, not a verdict. */
  function updateSimDetections(p: { x: number; y: number }) {
    const ids = nodesWithinRadius(p, positions, DRONE_DETECTION_RADIUS_M);
    setSimDetecting(ids);
    for (const id of ids) {
      if (detectedRef.current.has(id)) continue;
      detectedRef.current.add(id);
      log(`${id} inside simulated drone halo`, "warning");
      if (!alertRoute) beginAlertRoute(id);
    }
  }

  function beginAlertRoute(sourceId: string) {
    if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
    const path = findAlertPath(sourceId, state.topology, upLinks, ADMIN_ID);
    if (!path) {
      setAlertRoute({ path: [sourceId], phase: "lost", reachedIndex: 0, activeEdge: null });
      log("Alert to command post LOST — network partitioned", "critical");
      return;
    }
    setAlertRoute({ path, phase: "routing", reachedIndex: 0, activeEdge: null });
    const advance = (reached: number) => {
      if (reached >= path.length - 1) {
        setAlertRoute({ path, phase: "delivered", reachedIndex: reached, activeEdge: null });
        log(`Alert delivered to command post — ${path.length - 1} hops`, "success");
        return;
      }
      const next = reached + 1;
      setAlertRoute({
        path,
        phase: "routing",
        reachedIndex: next,
        activeEdge: `${path[reached]}->${path[next]}`,
      });
      if (path[next] !== ADMIN_ID) log(`Routing alert through ${path[next]}`, "info");
      alertTimerRef.current = window.setTimeout(() => advance(next), 850);
    };
    alertTimerRef.current = window.setTimeout(() => advance(0), 450);
  }

  function startFlight() {
    if (!droneStart || !droneDest || dronePhase === "flying") return;
    const t0 = performance.now();
    detectedRef.current.clear();
    setAlertRoute(null);
    setSimDetecting([]);
    setDronePhase("flying");
    log("Simulated drone flight started", "warning");
    const start = droneStart;
    const dest = droneDest;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / FLIGHT_DURATION_MS);
      const p = interpolatePosition(start, dest, t);
      setDronePos(p);
      updateSimDetections(p);
      if (t < 1) {
        flightRef.current = window.requestAnimationFrame(step);
      } else {
        flightRef.current = null;
        setDronePhase("complete");
        log("Simulated drone flight complete", "success");
      }
    };
    flightRef.current = window.requestAnimationFrame(step);
  }

  function setInterferenceOn(on: boolean) {
    setInterference(on);
    if (on) {
      sensorLinks.forEach((l) => chan?.setLink(l.a, l.b, { latency_ms: 500, loss: 0.2 }));
      log("Interference on — 500 ms, 20% loss on all links", "warning");
    } else {
      sensorLinks.forEach((l) => chan?.setLink(l.a, l.b, { latency_ms: 50, loss: 0, up: true }));
      log("Links restored to nominal", "success");
    }
  }

  /**
   * One-click demo: interference on, then a drone flight across the room while
   * links are degraded, then restore. Ports Avery's replayScenario — the flight
   * path is fixed (west to east edge) so there is nothing to aim.
   */
  function replayScenario() {
    if (replaying) return;
    resetDrone();
    setReplaying(true);
    setInterferenceOn(true);
    log("Replay started: drone flight under interference", "warning");
    const start = { x: DEFAULT_ROOM.w * 0.1, y: DEFAULT_ROOM.h / 2 };
    const dest = { x: DEFAULT_ROOM.w * 0.9, y: DEFAULT_ROOM.h / 2 };
    setDroneStart(start);
    setDroneDest(dest);
    setDronePos(start);
    setDronePhase("flying");
    detectedRef.current.clear();
    setAlertRoute(null);
    setSimDetecting([]);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / FLIGHT_DURATION_MS);
      const p = interpolatePosition(start, dest, t);
      setDronePos(p);
      updateSimDetections(p);
      if (t < 1) {
        flightRef.current = window.requestAnimationFrame(step);
      } else {
        flightRef.current = null;
        setDronePhase("complete");
        log("Replay flight complete", "success");
        replayTimerRef.current = window.setTimeout(() => {
          setInterferenceOn(false);
          setReplaying(false);
          log("Replay sequence complete", "success");
        }, 1_500);
      }
    };
    flightRef.current = window.requestAnimationFrame(step);
  }

  function disableRandomNode() {
    const ids = admitted.filter((n) => {
      const ns = state.topology[n] ?? [];
      return ns.some((nb) => nb !== ADMIN_ID && upLinks(n, nb));
    });
    if (!ids.length) return;
    const id = ids[Math.floor(Math.random() * ids.length)];
    const pairs: [string, string][] = (state.topology[id] ?? [])
      .filter((nb) => nb !== ADMIN_ID)
      .map((nb) => [id, nb]);
    cutLinks(pairs, false);
    log(`${id} temporarily isolated`, "critical");
    window.setTimeout(() => {
      cutLinks(pairs, true);
      log(`${id} rejoined`, "success");
    }, 6_000);
  }

  useEffect(
    () => () => {
      if (flightRef.current !== null) window.cancelAnimationFrame(flightRef.current);
      if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
      if (replayTimerRef.current !== null) window.clearTimeout(replayTimerRef.current);
    },
    []
  );

  const droneStatus =
    dronePhase === "flying"
      ? simDetecting.length
        ? `IN FLIGHT — halo over ${simDetecting.length} node${simDetecting.length === 1 ? "" : "s"}`
        : "IN FLIGHT — no node in halo"
      : dronePhase === "complete"
        ? "FLIGHT COMPLETE"
        : dronePhase === "ready"
          ? "READY TO FLY"
          : null;
  const alertStatus =
    alertRoute?.phase === "routing"
      ? `Relaying alert… hop ${alertRoute.reachedIndex} of ${alertRoute.path.length - 1}`
      : alertRoute?.phase === "delivered"
        ? `Alert delivered — ${alertRoute.path.length - 1} hops`
        : alertRoute?.phase === "lost"
          ? "NETWORK PATH LOST"
          : null;
  const selectedNeighbours = selected ? (state.topology[selected] ?? []).filter((n) => n !== ADMIN_ID) : [];
  const selectedPos = selected ? positions.get(selected) : undefined;
  const selectedLive = selected ? (view?.liveNodes ?? []).includes(selected) : false;

  const eventOffset = Math.min(eventPage, Math.max(0, Math.ceil(events.length / 3) - 1)) * 3;
  const sensorOffset = Math.min(sensorPage, Math.max(0, Math.ceil(admitted.length / 3) - 1)) * 3;
  const linkOffset = Math.min(linkPage, Math.max(0, Math.ceil(sensorLinks.length / 2) - 1)) * 2;
  const pendingOffset = Math.min(pendingPage, Math.max(0, Math.ceil(pending.length / 2) - 1)) * 2;
  const sensorPager = <PageControls label="Sensors" count={admitted.length} size={3} offset={sensorOffset} onPage={setSensorPage} />;

  return (
    <div className="dashboard">
      {pending.length > 0 && (
        <div
          className="panel"
          style={{
            borderColor: "var(--accent)",
            position: "sticky",
            top: 0,
            zIndex: 5,
          }}
        >
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>
              waiting to join ({pending.length})
            </h2>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {pending.slice(pendingOffset, pendingOffset + 2).map((n) => (
                <span key={n.node} className="row" style={{ gap: 6, marginRight: 8 }}>
                  <span>{n.node}</span>
                  <button className="primary" onClick={() => chan?.admit(n.node)}>
                    admit
                  </button>
                </span>
              ))}
              <PageControls label="Pending sensors" count={pending.length} size={2} offset={pendingOffset} onPage={setPendingPage} />
              {pending.length > 1 && (
                <button onClick={() => pending.forEach((n) => chan?.admit(n.node))}>
                  admit all
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <header className="dashboard-header">
        <div><p className="eyebrow">Operations console</p><h1>Shared airspace awareness</h1><p className="dim">A live picture built by the mesh, not a central detector.</p></div>
        <span className={`badge ${chan?.connected ? "live" : "offline"}`} role="status">Relay {chan?.connected ? "connected" : "offline"}</span>
      </header>
      <section className="metrics" aria-label="Mesh status">
        <div className="panel metric"><span>Admitted sensors</span><strong>{admitted.length}</strong><small>Phones in this session</small></div>
        <div className="panel metric"><span>Listening now</span><strong>{view?.listening ?? 0}</strong><small>Live mesh readings</small></div>
        <div className="panel metric"><span>Detecting nodes</span><strong style={{ color: hot.size ? "var(--hot)" : "var(--ok)" }}>{hot.size}</strong><small>On-device verdicts</small></div>
        <div className="panel metric"><span>Replicated records</span><strong>{view?.records ?? 0}</strong><small>Received through gossip</small></div>
      </section>

      <div className="dashboard-grid">
        <div className="panel map-card">
          <div className="card-heading"><h2>Mesh overview</h2><span className="badge">Room coordinates</span></div>
          <div ref={mapBox.ref} className="map-viewport">
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
              width={Math.max(120, Math.min(mapBox.width, 720))}
              placement={placeCandidate}
              drone={dronePos ? { x: dronePos.x, y: dronePos.y, radiusM: DRONE_DETECTION_RADIUS_M, dest: droneDest } : null}
              alertPath={alertRoute?.path ?? null}
              alertEdge={alertRoute?.activeEdge ?? null}
              impact={impact ? { x: impact.x, y: impact.y, radiusM: IMPACT_RADIUS_M } : null}
              onMapClick={handleMapClick}
              onMapHover={(x, y) => { if (mode === "placing") setPlaceHover({ x, y }); }}
            />
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            {mode === "placing"
              ? placeCandidate
                ? placeCandidate.status === "invalid"
                  ? `Too close — ${placeCandidate.candidate.distances[0] ? `${placeCandidate.candidate.distances[0].d.toFixed(1)} m to ${placeCandidate.candidate.distances[0].node}` : "no nodes"}`
                  : placeCandidate.status === "warning"
                    ? `${placementNeighbours(placeCandidate.candidate).length}/${MIN_CONNECTIONS} neighbours in range — move closer to the array`
                    : `Valid — ${placementNeighbours(placeCandidate.candidate).length} links in range. Click to confirm.`
                : "Move across the map to preview placement."
              : mode === "impact"
                ? "Click anywhere to run a simulated impact (cuts links, restores after 8 s)."
                : mode === "droneStart"
                  ? "Click to place the drone start."
                  : mode === "droneDestination"
                    ? "Click to place the drone destination."
                    : "Drag to place. Click two nodes to add or remove a link."}
            {pendingEdge && <b style={{ color: "var(--accent)" }}> linking from {pendingEdge}…</b>}
          </div>
          <div style={{ fontSize: 13, marginTop: 6 }}>
            {est && est.localised ? (
              <>
                <b>{est.nReports}</b> reporting · <b>{est.nSilent}</b> silent · ±
                {est.spreadM.toFixed(1)} m at ({est.x.toFixed(1)}, {est.y.toFixed(1)})
                {!est.graded && (
                  <span style={{ color: "var(--warn)" }}> · no SNR on the wire: coarse</span>
                )}
              </>
            ) : est ? (
              <span style={{ color: "var(--warn)" }}>
                <b>{est.nReports}</b> detecting, but not localised — nodes hear it at
                similar levels, so nothing pins it down. Spread them out, or the drone is
                outside the array.
              </span>
            ) : positions.size > 0 ? (
              <span className="dim">
                nothing heard · {view?.listening ?? 0} nodes listening
              </span>
            ) : (
              <span className="dim">no positioned readings — admit and place some nodes</span>
            )}
          </div>
        </div>

        <div className="dashboard-cards" data-panel={panel}>
          <label className="panel-switcher">Console panel
            <select aria-label="Console panel" value={panel} onChange={e => setPanel(e.target.value)}>
              <option value="confidence">Sensor confidence</option>
              <option value="topology">Network topology</option>
              <option value="scenario">Scenario controls</option>
              <option value="activity">Scenario activity</option>
              <option value="links">Link emulation</option>
              <option value="nodes">Sensor directory</option>
              {selected && <option value="inspector">Selected sensor</option>}
            </select>
          </label>
          <div className="panel" data-section="confidence">
            {sensorPager}
            <div className="card-heading"><h2>Sensor confidence</h2><span className="badge live">Live readings</span></div>
            <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
              Each node&apos;s on-device CRNN confidence, drawn from records that gossiped
              here. Dashed line is SkyMesh&apos;s {DETECT_THRESHOLD} threshold.
            </p>
            {admitted.length === 0 && <div className="empty-state"><strong>Your mesh starts with one phone.</strong><p>Scan the QR code, allow microphone access, then admit the phone here.</p></div>}
            {admitted.slice(sensorOffset, sensorOffset + 3).map((n) => {
              const p = levels.get(n);
              const isHot = hot.has(n);
              return (
                <div key={n} style={{ marginBottom: 6 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ color: isHot ? "var(--hot)" : undefined }}>
                      {n} {isHot && "· DRONE"}
                    </span>
                    <span
                      className="dim"
                      style={{ color: isHot ? "var(--hot)" : undefined, fontVariantNumeric: "tabular-nums" }}
                    >
                      {p === undefined ? "—" : p.toFixed(2)}
                    </span>
                  </div>
                  <ConfidenceGraph
                    history={mesh?.history(n) ?? []}
                    width={300}
                    height={38}
                    compact
                    now={Date.now()}
                  />
                </div>
              );
            })}
          </div>

          <div className="panel" data-section="topology">
            <h2>Network topology</h2>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button onClick={() => applyPreset("bridge")}>two clusters + bridge</button>
              <button onClick={() => applyPreset("ring")}>ring</button>
              <button onClick={() => applyPreset("full")}>full mesh</button>
              <button onClick={autoPlace}>auto-place</button>
              <button
                className={mode === "placing" ? "primary" : ""}
                onClick={() => {
                  if (mode === "placing") {
                    setMode("idle");
                    setPlaceHover(null);
                  } else {
                    setMode("placing");
                    setSelected(null);
                    setPendingEdge(null);
                    log("Placement mode — hover to preview constraints", "info");
                  }
                }}
              >
                {mode === "placing" ? "cancel place" : "place node"}
              </button>
            </div>
            <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
              Adjacency is imposed here — every phone can physically reach every other.
              It stands in for the radio range of a real deployment, and the bridge preset
              is what makes partition-and-heal visible.
            </p>
          </div>

          <div className="panel" data-section="scenario">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Scenario controls <span className="badge simulation">Simulation</span></h2>
              <span
                className="dim"
                style={{
                  fontSize: 12,
                  color: impact || interference ? "var(--hot)" : connected ? "var(--ok)" : "var(--warn)",
                }}
              >
                {impact || interference ? "elevated" : connected ? "nominal" : "partitioned"}
              </span>
            </div>
            <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
              <button onClick={dronePhase === "idle" ? startDroneMode : resetDrone}>
                {dronePhase === "idle" ? "◈ simulate drone" : "reset drone"}
              </button>
              <button
                className={mode === "impact" ? "primary" : ""}
                onClick={() => {
                  if (mode === "impact") {
                    setMode("idle");
                  } else {
                    setMode("impact");
                    setSelected(null);
                    log("Impact armed — click the map", "warning");
                  }
                }}
              >
                {mode === "impact" ? "cancel impact" : "◌ simulate impact"}
              </button>
              <button onClick={disableRandomNode}>− disable random node</button>
              <button
                className={interference ? "primary" : ""}
                onClick={() => setInterferenceOn(!interference)}
              >
                {interference ? "≋ interference on (clear)" : "≋ simulate interference"}
              </button>
              <button onClick={replayScenario} disabled={replaying}>
                {replaying ? "↻ replaying…" : "↻ replay scenario"}
              </button>
            </div>
            <div className="row" style={{ marginTop: 8, fontSize: 12 }}>
              <span className="dim">
                <b style={{ color: "var(--text)" }}>{health}%</b> health ·{" "}
                <b style={{ color: connected ? "var(--ok)" : "var(--warn)" }}>
                  {connected ? "connected" : "partitioned"}
                </b>
              </span>
            </div>
            {droneStatus && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                <span style={{ color: "var(--warn)" }}>{droneStatus}</span>
                {dronePhase === "ready" && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="primary" onClick={startFlight}>start flight</button>
                    <button onClick={resetDrone}>remove drone</button>
                  </div>
                )}
                {(dronePhase === "complete" || dronePhase === "flying") && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button onClick={resetDrone}>remove drone</button>
                  </div>
                )}
              </div>
            )}
            {alertStatus && (
              <div
                style={{
                  fontSize: 13,
                  marginTop: 6,
                  color: alertRoute?.phase === "lost" ? "var(--hot)" : "var(--warn)",
                }}
              >
                {alertStatus}
              </div>
            )}
            <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
              Demo layer: the drone halo is a visual hint, never a record. Impact and
              isolation cut real relay links, so partitions here are partitions
              everywhere.
            </p>
          </div>

          <div className="panel" data-section="activity">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Scenario activity</h2>
              <span className="dim" style={{ fontSize: 12 }}>{events.length} events</span>
            </div>
            <PageControls label="Events" count={events.length} size={3} offset={eventOffset} onPage={setEventPage} />
            {events.length === 0 && (
              <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
                Scenario events land here.
              </p>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 4, fontSize: 12 }}>
              {events.slice(eventOffset, eventOffset + 3).map((e) => (
                <li key={e.id} className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
                  <span
                    style={{
                      width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto",
                      background:
                        e.tone === "critical" ? "var(--hot)"
                        : e.tone === "warning" ? "var(--warn)"
                        : e.tone === "success" ? "var(--ok)"
                        : "var(--dim)",
                    }}
                  />
                  <span className="dim" style={{ fontVariantNumeric: "tabular-nums" }}>{e.time}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          </div>

          {selected && (
            <div className="panel" data-section="inspector">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>{selected}</h2>
                <button onClick={() => { setSelected(null); setPanel("confidence"); }} aria-label="Close inspector">×</button>
              </div>
              <dl style={{ display: "grid", gap: 4, fontSize: 13, margin: "8px 0" }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <dt className="dim">heartbeat</dt>
                  <dd style={{ margin: 0, color: selectedLive ? "var(--ok)" : "var(--hot)" }}>
                    {selectedLive ? "fresh readings" : "silent"}
                  </dd>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <dt className="dim">position</dt>
                  <dd style={{ margin: 0 }}>
                    {selectedPos ? `${selectedPos.x.toFixed(1)}, ${selectedPos.y.toFixed(1)} m` : "unplaced"}
                  </dd>
                </div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <dt className="dim">confidence</dt>
                  <dd style={{ margin: 0, color: hot.has(selected) ? "var(--hot)" : undefined }}>
                    {levels.get(selected) === undefined
                      ? "—"
                      : `${levels.get(selected)!.toFixed(2)}${hot.has(selected) ? " · DRONE" : ""}`}
                  </dd>
                </div>
              </dl>
              <h2 style={{ fontSize: 13 }}>connections ({selectedNeighbours.length})</h2>
              {selectedNeighbours.length === 0 ? (
                <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>No links assigned.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0", display: "grid", gap: 4, fontSize: 12 }}>
                  {selectedNeighbours.map((nb) => (
                    <li key={nb} className="row" style={{ justifyContent: "space-between" }}>
                      <span>{nb}</span>
                      <span className="dim">{upLinks(selected, nb) ? "up" : "cut"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="panel" data-section="links">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>link emulation</h2>
              <button onClick={() => setShowLinks((v) => !v)}>
                {showLinks ? "hide" : "show"}
              </button>
            </div>
            <p className="dim" style={{ fontSize: 12, margin: "6px 0 0" }}>
              Network conditions, not detection. These stand in for radio links: latency
              and packet loss the phones would face in the field but never see on one WiFi.
              Cutting a link is how partition-and-heal is demonstrated.
            </p>
            {showLinks && sensorLinks.length === 0 && <span className="dim">no links yet</span>}
            {showLinks && <PageControls label="Links" count={sensorLinks.length} size={2} offset={linkOffset} onPage={setLinkPage} />}
            {showLinks && (
            <table>
              <tbody>
                {sensorLinks.slice(linkOffset, linkOffset + 2).map((l) => (
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
            )}
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

          <div className="panel" data-section="nodes">
            <h2>Sensor directory</h2>
            {sensorPager}
            <table>
              <thead>
                <tr><th>node</th><th>p</th><th>pos</th><th>neighbours</th></tr>
              </thead>
              <tbody>
                {admitted.slice(sensorOffset, sensorOffset + 3).map((n) => {
                  const pos = positions.get(n);
                  const p = levels.get(n);
                  return (
                    <tr key={n}>
                      <td>{n}</td>
                      <td style={{ color: hot.has(n) ? "var(--hot)" : undefined }}>
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
    </div>
  );
}
