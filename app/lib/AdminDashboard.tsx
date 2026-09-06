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

import { Tag } from "@carbon/react";
import { ActionButton } from "./DesignSystem";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AdminChannel, edgesToTopology, preset, type Preset } from "./admin.ts";
import { relayUrl, sessionId } from "./config.ts";
import { useMesh } from "./useMesh.ts";
import { linkKey } from "./RoomMap.tsx";
import dynamic from "next/dynamic";
const GeographicMap = dynamic(() => import("./GeographicMap"), { ssr: false, loading: () => <p role="status">Loading geographic map…</p> });
import { ConfidenceGraph } from "./ConfidenceGraph.tsx";
import { DETECT_THRESHOLD } from "./detection.ts";
import { DEFAULT_ROOM } from "./mesh.ts";
import { SIMULATION_LABELS, type SimulationNotice } from "./simulationChannel.ts";
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
const simulationRunId = () => globalThis.crypto?.randomUUID?.() ?? `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
    const measure = () => {
      const available = Math.floor(el.clientWidth);
      // Preserve the room aspect ratio while keeping the whole map on laptop
      // screens. Mobile uses document scrolling rather than scaling all text.
      const heightBound = window.innerWidth > 900 ? Math.max(180, window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 100) * 1.5 : available;
      if (available > 0) setWidth(Math.min(available, heightBound));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    measure();
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return { ref, width };
}

export function AdminDashboard({ onboarding }: { onboarding?: ReactNode }) {
  const chanRef = useRef<AdminChannel | null>(null);
  const [, force] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [placeTarget, setPlaceTarget] = useState("");
  const [pendingEdge, setPendingEdge] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showLinks, setShowLinks] = useState(true);
  const { mesh, view } = useMesh({ passive: true, forceId: ADMIN_ID });
  const mapBox = useContainerWidth(560);

  // Scenario controls (Avery's demo layer, rewired to live mesh primitives).
  const [mode, setMode] = useState<MapMode>("idle");
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const eventSequence = useRef(0);
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
  const droneRunRef = useRef<string | null>(null);
  const interferenceRunRef = useRef<string | null>(null);

  function announce(notice: SimulationNotice) {
    if (!chanRef.current?.publishSimulation(notice)) {
      log("Simulation notice not sent: control channel disconnected", "warning");
    }
  }

  function log(message: string, tone: ActivityEvent["tone"] = "info") {
    // Several actions can log in one millisecond. Unique keys prevent React
    // from retaining duplicate DOM rows when the bounded event list shifts.
    const id = ++eventSequence.current;
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setEvents((cur) => pushEvent(cur, message, tone, () => ({ id, time })));
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

  // Replicated records outlive a connection. Never render departed or unadmitted
  // record owners as current participants.
  const positions = new Map([...(view?.positions ?? new Map())].filter(([id]) => admitted.includes(id)));
  const unplaced = new Set(admitted.filter(id => !positions.has(id)));
  // Unplaced participants are visible in a staging row, not fabricated physical
  // positions. Only an explicit drag/place publishes a room coordinate.
  const mapPositions = new Map(positions);
  [...unplaced].forEach((node, i) => mapPositions.set(node, {
    node, x: DEFAULT_ROOM.w * (i + 1) / (unplaced.size + 1), y: DEFAULT_ROOM.h * 0.93,
  }));
  const target = admitted.includes(placeTarget) ? placeTarget : (selected && admitted.includes(selected) ? selected : admitted[0] ?? "");
  useEffect(() => {
    if (selected && !admitted.includes(selected)) setSelected(null);
    if (pendingEdge && !admitted.includes(pendingEdge)) setPendingEdge(null);
  }, [state.nodes, selected, pendingEdge]);
  useEffect(() => {
    if (selected) document.querySelector('[data-section="inspector"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

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

  // Connect the passive observer when participants are admitted, without
  // inventing participant-to-participant links. Placement records must reach
  // phones even before the operator chooses a topology preset.
  useEffect(() => {
    if (!chan || !state.nodes.some(n => n.node === ADMIN_ID && n.admitted)) return;
    if (admitted.some(id => !(state.topology[ADMIN_ID] ?? []).includes(id))) {
      applyTopology(sensorEdges());
    }
  }, [chan, state.nodes, state.topology]);

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
    if (node === ADMIN_ID || !admitted.includes(node)) return;
    setSelected(node);
    if (!linking) return;
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
      const candidate = buildPlacementCandidate(placeHover.x, placeHover.y, new Map([...positions].filter(([id]) => id !== target)));
      return { candidate, status: placementStatus(candidate) };
    }, [mode, placeHover, positions, target]);

  /** Every mutation goes through the control channel or gossip — never local. */
  function cutLinks(pairs: [string, string][], up: boolean, extra?: { latency_ms?: number; loss?: number }) {
    for (const [a, b] of pairs) chan?.setLink(a, b, { up, ...extra });
  }

  function handleMapClick(x: number, y: number) {
    if (mode === "placing") {
      if (!target || !mesh) return;
      const candidate = buildPlacementCandidate(x, y, new Map([...positions].filter(([id]) => id !== target)));
      const status = placementStatus(candidate);
      if (status === "invalid") {
        log("Placement rejected — too close to an existing node", "critical");
        return;
      }
      if (status === "warning") {
        log(
          `Under-connected placement — ${placementNeighbours(candidate).length}/${MIN_CONNECTIONS} neighbours in range. Link this participant after placement.`,
          "warning"
        );
      }
      mesh.publishPosition(target, x, y);
      setSelected(target);
      log(`${target} placed at (${x.toFixed(1)}, ${y.toFixed(1)})`, "success");
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
      const runId = simulationRunId();
      const ids = nodesWithinRadius({ x, y }, positions, IMPACT_RADIUS_M);
      setImpact({ x, y, ids });
      announce({ runId, kind: "impact", phase: "started", affectedNodes: ids, position: { x, y },
        message: `Simulated blast impact. ${ids.length} node${ids.length === 1 ? "" : "s"} in the impact area. Affected links restore after 8 seconds.` });
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
        announce({ runId, kind: "impact", phase: "restored", affectedNodes: ids, position: { x, y },
          message: "Blast simulation ended. Impact links restored." });
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
    if (droneRunRef.current) {
      announce({ runId: droneRunRef.current, kind: "drone", phase: "cancelled", affectedNodes: [...detectedRef.current],
        message: "Drone simulation cancelled by the operator." });
      droneRunRef.current = null;
    }
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
    const newIds = ids.filter(id => !detectedRef.current.has(id));
    setSimDetecting(ids);
    for (const id of ids) {
      if (detectedRef.current.has(id)) continue;
      detectedRef.current.add(id);
      log(`${id} inside simulated drone halo`, "warning");
      if (!alertRoute) beginAlertRoute(id);
    }
    if (newIds.length && droneRunRef.current) {
      announce({ runId: droneRunRef.current, kind: "drone", phase: "contact", affectedNodes: [...detectedRef.current], position: p,
        message: `Simulated drone halo reached ${newIds.join(", ")}. This is a proximity simulation, not an audio detection.` });
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
    const runId = simulationRunId();
    droneRunRef.current = runId;
    announce({ runId, kind: "drone", phase: "started", affectedNodes: [], position: droneStart,
      message: "Simulated drone flight started. Watch for proximity updates as it crosses the participant map." });
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
        announce({ runId, kind: "drone", phase: "completed", affectedNodes: [...detectedRef.current], position: dest,
          message: "Simulated drone flight complete. No neural-network detection was generated by this demo." });
        droneRunRef.current = null;
        log("Simulated drone flight complete", "success");
      }
    };
    flightRef.current = window.requestAnimationFrame(step);
  }

  function setInterferenceOn(on: boolean) {
    setInterference(on);
    if (on) {
      const runId = interferenceRunRef.current ?? simulationRunId();
      interferenceRunRef.current = runId;
      announce({ runId, kind: "interference", phase: "started", affectedNodes: [...new Set(sensorLinks.flatMap(l => [l.a, l.b]))],
        message: "Simulated radio interference enabled: 500 ms latency and 20% loss on sensor links." });
      sensorLinks.forEach((l) => chan?.setLink(l.a, l.b, { latency_ms: 500, loss: 0.2 }));
      log("Interference on — 500 ms, 20% loss on all links", "warning");
    } else {
      if (interferenceRunRef.current) {
        announce({ runId: interferenceRunRef.current, kind: "interference", phase: "restored", affectedNodes: [...new Set(sensorLinks.flatMap(l => [l.a, l.b]))],
          message: "Radio interference cleared. Sensor links restored to nominal." });
        interferenceRunRef.current = null;
      }
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
    const runId = simulationRunId();
    droneRunRef.current = runId;
    announce({ runId, kind: "drone", phase: "started", affectedNodes: [], position: start,
      message: "Scenario replay started: simulated drone flight under radio interference." });
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
        announce({ runId, kind: "drone", phase: "completed", affectedNodes: [...detectedRef.current], position: dest,
          message: "Replay drone flight complete. Radio interference will clear shortly." });
        droneRunRef.current = null;
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
    const runId = simulationRunId();
    announce({ runId, kind: "isolation", phase: "started", affectedNodes: [id],
      message: `${id} temporarily isolated by the operator. Sensor links restore after 6 seconds.` });
    const pairs: [string, string][] = (state.topology[id] ?? [])
      .filter((nb) => nb !== ADMIN_ID)
      .map((nb) => [id, nb]);
    cutLinks(pairs, false);
    log(`${id} temporarily isolated`, "critical");
    window.setTimeout(() => {
      cutLinks(pairs, true);
      announce({ runId, kind: "isolation", phase: "restored", affectedNodes: [id],
        message: `${id} rejoined after the node isolation simulation.` });
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
      ? `Simulated route… hop ${alertRoute.reachedIndex} of ${alertRoute.path.length - 1}`
      : alertRoute?.phase === "delivered"
        ? `Simulated route complete — ${alertRoute.path.length - 1} hops`
        : alertRoute?.phase === "lost"
          ? "NETWORK PATH LOST"
          : null;
  const selectedNeighbours = selected ? (state.topology[selected] ?? []).filter((n) => n !== ADMIN_ID) : [];
  const selectedPos = selected ? positions.get(selected) : undefined;
  const selectedLive = selected ? (view?.liveNodes ?? []).includes(selected) : false;
  const recentNotices = (chan?.simulationAlerts ?? []).filter(a => a.expiresAt > Date.now()).slice(0, 6);


  return (
    <div className="dashboard">
      <section className="metrics" aria-label="Mesh status">
        <div className="panel metric"><span>Admitted sensors</span><strong>{admitted.length}</strong><small>Phones in this session</small></div>
        <div className="panel metric"><span>Listening now</span><strong>{view?.listening ?? 0}</strong><small>Live mesh readings</small></div>
        <div className="panel metric"><span>Detecting nodes</span><strong style={{ color: hot.size ? "var(--hot)" : "var(--ok)" }}>{hot.size}</strong><small>On-device verdicts</small></div>
        <div className="panel metric"><span>Replicated records</span><strong>{view?.records ?? 0}</strong><small>Received through gossip</small></div>
      </section>

      <div className="dashboard-grid">
        <div className="panel map-card" id="participant-map" tabIndex={-1}>
          <div className="card-heading"><h2>Participant map</h2><span className="map-coordinate-label">Real participants · satellite</span></div>
          <div className="map-toolbar">
            <ActionButton className={linking ? "primary" : ""} onClick={() => { setLinking(!linking); setPendingEdge(null); }}>{linking ? "Done linking" : "Link participants"}</ActionButton>
            <span className="dim">{admitted.length} participants · {unplaced.size} awaiting placement</span>
          </div>
          <div ref={mapBox.ref} className="map-viewport">
            <GeographicMap
              room={DEFAULT_ROOM}
              positions={mapPositions}
              unplaced={unplaced}
              estimate={est}
              topology={state.topology}
              downLinks={downLinks}
              levels={levels}
              selected={pendingEdge ?? selected}
              onPick={onPick}
              onMove={(node, x, y) => mesh?.publishPosition(node, x, y)}
              ripples={ripples}
              width={Math.max(120, mapBox.width)}
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
                    : linking ? "Click two participants to add or remove a live link." : "Select to inspect. Drag a participant to assign its room position."}
            {pendingEdge && <b style={{ color: "var(--accent)" }}> linking from {pendingEdge}…</b>}
          </div>
          <p className="map-legend">Solid nodes: assigned room positions. Dashed nodes: unplaced participants in a staging row, not GPS locations. Scenario overlays never become live readings.</p>
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

        <div className="dashboard-cards" aria-label="Participant and scenario controls">
          <section className="panel onboarding" id="participants" tabIndex={-1}>
            {onboarding}
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
              {pending.map((n) => (
                <span key={n.node} className="row" style={{ gap: 6, marginRight: 8 }}>
                  <span>{n.node}</span>
                  <ActionButton className="primary" onClick={() => chan?.admit(n.node)}>
                    admit
                  </ActionButton>
                </span>
              ))}
              {pending.length > 1 && (
                <ActionButton onClick={() => pending.forEach((n) => chan?.admit(n.node))}>
                  admit all
                </ActionButton>
              )}
            </div>
          </div>
        </div>
      )}
          </section>
          <div className="panel" data-section="confidence">
            <div className="card-heading"><h2>Sensor confidence</h2><Tag type="teal" size="sm">Live readings</Tag></div>
            <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
              Each node&apos;s on-device CRNN confidence, drawn from records that gossiped
              here. Dashed line is SkyMesh&apos;s {DETECT_THRESHOLD} threshold.
            </p>
            {admitted.length === 0 && <div className="empty-state"><strong>Your mesh starts with one phone.</strong><p>Scan the QR code, allow microphone access, then admit the phone here.</p></div>}
            {admitted.map((n) => {
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
            <label className="placement-target">Participant to place
              <select aria-label="Participant to place" value={target} onChange={e => setPlaceTarget(e.target.value)} disabled={!admitted.length}>
                {!admitted.length && <option value="">Admit a participant first</option>}
                {admitted.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <ActionButton onClick={() => applyPreset("bridge")}>two clusters + bridge</ActionButton>
              <ActionButton onClick={() => applyPreset("ring")}>ring</ActionButton>
              <ActionButton onClick={() => applyPreset("full")}>full mesh</ActionButton>
              <ActionButton onClick={autoPlace}>auto-place</ActionButton>
              <ActionButton
                disabled={!target}
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
              </ActionButton>
            </div>
            <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
              Adjacency is imposed here — every phone can physically reach every other.
              It stands in for the radio range of a real deployment, and the bridge preset
              is what makes partition-and-heal visible.
            </p>
          </div>

          <div className="panel" data-section="scenario" id="scenarios" tabIndex={-1}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Scenario controls <Tag type="purple" size="sm">Simulation</Tag></h2>
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
              <ActionButton onClick={dronePhase === "idle" ? startDroneMode : resetDrone}>
                {dronePhase === "idle" ? "◈ simulate drone" : "reset drone"}
              </ActionButton>
              <ActionButton
                className={mode === "impact" ? "primary" : ""}
                disabled={!!impact}
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
              </ActionButton>
              <ActionButton onClick={disableRandomNode}>− disable random node</ActionButton>
              <ActionButton
                className={interference ? "primary" : ""}
                onClick={() => setInterferenceOn(!interference)}
              >
                {interference ? "≋ interference on (clear)" : "≋ simulate interference"}
              </ActionButton>
              <ActionButton onClick={replayScenario} disabled={replaying}>
                {replaying ? "↻ replaying…" : "↻ replay scenario"}
              </ActionButton>
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
                    <ActionButton className="primary" onClick={startFlight}>start flight</ActionButton>
                    <ActionButton onClick={resetDrone}>remove drone</ActionButton>
                  </div>
                )}
                {(dronePhase === "complete" || dronePhase === "flying") && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <ActionButton onClick={resetDrone}>remove drone</ActionButton>
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
              Demo only. Joined nodes receive a separate simulation alert, never a
              microphone reading. Impact and isolation cut mesh links. Simulation
              notices use the control channel and still arrive during those cuts.
            </p>
            <section aria-label="Node simulation acknowledgements" style={{ marginTop: 12, fontSize: 12 }}>
              <strong>Node simulation channel · {chan?.connected ? "connected" : "disconnected"}</strong>
              <p className="dim">Live to admitted nodes in this session. Acknowledgements confirm a participant saw the demo, not mesh delivery. Notices expire after 2 minutes.</p>
              {recentNotices.length === 0 ? <p className="dim">Run a scenario to notify participants.</p> : <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
                {recentNotices.map(a => <li key={a.id} data-simulation-id={a.id}>
                  <b>{SIMULATION_LABELS[a.kind]} · {a.phase}</b><br />
                  <span>{a.acknowledgedBy.length}/{a.recipients.length} acknowledged</span>
                  {a.acknowledgedBy.length > 0 && <span> · {a.acknowledgedBy.join(", ")}</span>}
                  {a.recipients.length === 0 && <span className="dim"> · no admitted recipients</span>}
                </li>)}
              </ul>}
            </section>
          </div>

          <div className="panel" data-section="activity">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>Scenario activity</h2>
              <span className="dim" style={{ fontSize: 12 }}>{events.length} events</span>
            </div>
            {events.length === 0 && (
              <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
                Scenario events land here.
              </p>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: 4, fontSize: 12 }}>
              {events.map((e) => (
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

          {!selected && <div className="panel" data-section="inspector"><h2>Sensor inspector</h2><p className="dim">Select a sensor on the map to inspect its readings and connections.</p></div>}
          {selected && (
            <div className="panel" data-section="inspector">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>{selected}</h2>
                <ActionButton onClick={() => { setSelected(null); }} aria-label="Close inspector">×</ActionButton>
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
              <ActionButton onClick={() => setShowLinks((v) => !v)}>
                {showLinks ? "hide" : "show"}
              </ActionButton>
            </div>
            <p className="dim" style={{ fontSize: 12, margin: "6px 0 0" }}>
              Network conditions, not detection. These stand in for radio links: latency
              and packet loss the phones would face in the field but never see on one WiFi.
              Cutting a link is how partition-and-heal is demonstrated.
            </p>
            {showLinks && sensorLinks.length === 0 && <span className="dim">no links yet</span>}
            {showLinks && (
            <table>
              <tbody>
                {sensorLinks.map((l) => (
                  <tr key={linkKey(l.a, l.b)}>
                    <td>{l.a}–{l.b}</td>
                    <td>
                      <ActionButton
                        className={l.up ? "danger" : ""}
                        onClick={() => chan?.setLink(l.a, l.b, { up: !l.up })}
                      >
                        {l.up ? "cut" : "restore"}
                      </ActionButton>
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
              <ActionButton
                onClick={() => sensorLinks.forEach((l) => chan?.setLink(l.a, l.b, { latency_ms: 500, loss: 0.2 }))}
              >
                degrade all (500 ms, 20%)
              </ActionButton>
              <ActionButton
                onClick={() => sensorLinks.forEach((l) => chan?.setLink(l.a, l.b, { latency_ms: 50, loss: 0, up: true }))}
              >
                restore all
              </ActionButton>
            </div>
          </div>

          <div className="panel" data-section="nodes">
            <h2>Sensor directory</h2>
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
                      <td><button className="participant-select" onClick={() => { setSelected(n); setPlaceTarget(n); }}>{n}</button></td>
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
