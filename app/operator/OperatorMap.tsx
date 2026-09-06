"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Marker, Pane, Polyline, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import { divIcon, type LeafletMouseEvent, type Map as LeafletMap } from "leaflet";
import type { NodeConnection, OperatorNode } from "./types";
import { PlacementLayer } from "./PlacementLayer";
import { EstimateLayer } from "./EstimateLayer";
import { SPEEDS, useSimulation } from "./useSimulation";
import { estimateFrom, type NodeEstimate } from "./sim/estimate";
import type { SimEvent } from "./sim/world";
import { adviseForRoute, type RouteSuggestion } from "./routeAdvisor";
import { DRONE_SPEED_MPS, MAX_DRONE_SPEED_MPS, MIN_DRONE_SPEED_MPS, pointAlongRoute, routeCoverage, routeLengthM, type Waypoint } from "./attackRoute";
import {
  DRONE_DETECTION_RADIUS_M,
  MAX_LINK_DISTANCE_M,
  areaAround,
  MIN_CONNECTIONS,
  MIN_NODE_DISTANCE_M,
  detectionProb,
  distanceM,
  makeFrame,
  toLatLon,
  qualityGrid,
  suggestPlacements,
  type QualityGrid,
  type SuggestResult,
} from "./placement";
import styles from "./operator.module.css";
import { ActionButton, OperationsHeader } from "../lib/DesignSystem";

type MapMode = "idle" | "placing" | "connecting" | "route";
type DronePhase = "idle" | "drawing" | "ready";
/**
 * The log records what the sensors reported, not what the operator clicked.
 *
 * Arming a mode, engaging the advisor and plotting a route are all things the
 * operator already knows they just did, and mixing them in buries the two lines
 * that matter — which node heard something, and how far the contact spread.
 */
type ContactKind = "detection" | "relay" | "consensus" | "online" | "offline";
type ContactEvent = { id: number; time: string; kind: ContactKind; node?: string; message: string; detail?: string };

const KIND_TONE: Record<ContactKind, string> = {
  detection: "warning",
  relay: "info",
  consensus: "success",
  online: "success",
  offline: "critical",
};
type PlacementCandidate = { lat: number; lon: number; distances: { node: OperatorNode; distanceM: number }[] } | null;
const MAP_CENTER: [number, number] = [38.9012, -77.0402];
/** Plain global class: the overlay pane is click-through by default (see the
 *  module CSS), so the link hit area has to opt back in by a name CSS Modules
 *  will not hash. */
const LINK_HIT_CLASS = "skymesh-link-hit";
/**
 * Wall-clock hold on the link highlight, ms.
 *
 * A hop is 50 ms — one TICK_MS — so a record carrying a detection is on a link
 * for a single frame and the pulse would be gone before the eye caught it.
 * This is a render concern only: the world keeps exact timing, the highlight
 * just lingers and fades so a one-tick burst is perceptible.
 */
const LINK_FLASH_MS = 400;
/**
 * How long an acquisition connector stays on the map, in *simulated* ms.
 *
 * Simulated rather than wall-clock so it re-renders naturally with each
 * snapshot, respects the playback speed, and does not quietly decay while the
 * run is paused.
 */
const ACQUIRE_FADE_MS = 2_500;
/**
 * Margin around the sensors that the fused estimate is solved over.
 *
 * Was one detection radius, which is too tight: the posterior is normalised
 * over this grid and its argmax searched inside it, so a source near the edge
 * had its distribution sliced off by the boundary — the estimate rendered as a
 * hard-edged rectangle, and the "fix" was pinned to the edge of the box rather
 * than to where the levels actually pointed. Detection is a smooth curve on
 * range, not a hard cutoff at DRONE_DETECTION_RADIUS_M, so a node genuinely
 * hears things from well beyond it and the grid has to have room for the tail.
 */
const ESTIMATE_MARGIN_M = DRONE_DETECTION_RADIUS_M * 2.5;
/** Finer than the 32x32 default, to hold resolution over the wider area. */
const ESTIMATE_GRID = { nx: 48, ny: 48 };
// The placement rules live in placement.ts so the hover preview and the advisor
// cannot drift apart — one definition of "legal spot", used by both.
export { MIN_NODE_DISTANCE_M, MAX_LINK_DISTANCE_M, MIN_CONNECTIONS, DRONE_DETECTION_RADIUS_M };

/** Node dragging needs the map handle (to suspend panning) and mouseup, which
 *  fires on the map rather than the marker once the pointer has moved off it. */
function MapInteractions({ onMapClick, onMapMove, onMapUp, mapRef }: {
  onMapClick: (event: LeafletMouseEvent) => void;
  onMapMove: (event: LeafletMouseEvent) => void;
  onMapUp: () => void;
  mapRef: { current: LeafletMap | null };
}) {
  const map = useMapEvents({ click: onMapClick, mousemove: onMapMove, mouseup: onMapUp });
  mapRef.current = map;
  return null;
}

/** One key per unordered pair, so a link reads the same from either end. */
function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function nodeColor(node: OperatorNode, selected: boolean): string {
  if (selected) return "#4bc4ff";
  if (node.status === "degraded") return "#e3a93b";
  if (node.status === "offline") return "#f85149";
  return "#39d98a";
}

function connectionPoints(connection: NodeConnection, nodes: OperatorNode[]): [number, number][] | null {
  const source = nodes.find((node) => node.id === connection.sourceId);
  const target = nodes.find((node) => node.id === connection.targetId);
  if (!source || !target) return null;
  return [[source.lat, source.lon], [target.lat, target.lon]];
}

function relativeAge(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} sec ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function eventTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function placementColor(status: "invalid" | "warning" | "valid"): string {
  return status === "valid" ? "#39d98a" : status === "warning" ? "#e3a93b" : "#f07b62";
}

function buildPlacementCandidate(lat: number, lon: number, nodes: OperatorNode[]): PlacementCandidate {
  return { lat, lon, distances: nodes.map((node) => ({ node, distanceM: distanceM(lat, lon, node.lat, node.lon) })).sort((first, second) => first.distanceM - second.distanceM) };
}

function getPlacementStatus(candidate: PlacementCandidate): "invalid" | "warning" | "valid" {
  if (!candidate || candidate.distances.some(({ distanceM }) => distanceM < MIN_NODE_DISTANCE_M)) return "invalid";
  return candidate.distances.filter(({ distanceM }) => distanceM <= MAX_LINK_DISTANCE_M).length < MIN_CONNECTIONS ? "warning" : "valid";
}

/**
 * Hop layers outward from the node that heard the drone.
 *
 * A contact spreads through the mesh rather than travelling to a designated
 * headquarters: every node is identical and any of them can hold the picture,
 * so there is no privileged destination for the alert to reach — and no single
 * node whose loss stops it. Nodes unreachable from the detector simply never
 * appear in a layer, which is what a partition looks like.
 */
function PlacementPreview({ candidate, status }: { candidate: PlacementCandidate; status: "invalid" | "warning" | "valid" }) {
  if (!candidate) return null;
  const color = placementColor(status);
  return <>
    <Circle center={[candidate.lat, candidate.lon]} radius={MIN_NODE_DISTANCE_M} pathOptions={{ className: styles.mapDecoration, interactive: false, color, fillColor: color, fillOpacity: .08, weight: 1, dashArray: "4 6" }} />
    <CircleMarker center={[candidate.lat, candidate.lon]} radius={9} pathOptions={{ className: styles.mapDecoration, interactive: false, color, fillColor: color, fillOpacity: .25, weight: 2, dashArray: "5 5" }} />
    {candidate.distances.filter(({ distanceM }) => distanceM <= MAX_LINK_DISTANCE_M * 1.35).map(({ node, distanceM }) => <Polyline key={node.id} positions={[[candidate.lat, candidate.lon], [node.lat, node.lon]]} pathOptions={{ className: styles.mapDecoration, interactive: false, color: distanceM <= MAX_LINK_DISTANCE_M ? color : "#65778a", dashArray: "3 6", opacity: .65, weight: 1 }} />)}
  </>;
}

export default function OperatorMap() {
  const droneIcon = useMemo(() => divIcon({ className: styles.droneMarker, html: `<span class="${styles.droneGlyph}">✦</span>`, iconSize: [34, 34], iconAnchor: [17, 17] }), []);
  // The network starts empty and is built by the operator. There is no seeded
  // fixture: hardcoded sensors come with hardcoded fictions next to them —
  // frozen "12 sec ago" heartbeats, a node permanently "degraded" for no reason,
  // and a 222 m link that the 150 m range rule would never have created.
  const [nodes, setNodes] = useState<OperatorNode[]>([]);
  const [connections, setConnections] = useState<NodeConnection[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /**
   * Monotonic, never reused.
   *
   * Numbering from `nodes.length + 1` reuses an id after any removal: delete the
   * second of three and the next sensor added is "node-3" again, which collides
   * with the existing one. React sees duplicate keys, and a link drawn to one
   * silently attaches to the other.
   */
  const nodeSeq = useRef(0);
  /** Drives the relative "last change" readout. Only ticks while it is on screen. */
  const [now, setNow] = useState(() => Date.now());
  const [mode, setMode] = useState<MapMode>("idle");
  const [placementCandidate, setPlacementCandidate] = useState<PlacementCandidate>(null);
  const [advisorOn, setAdvisorOn] = useState(false);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  /** Placement advice for the drawn ingress, as opposed to for the area. */
  const [routeAdvisorOn, setRouteAdvisorOn] = useState(false);
  /**
   * First node of a link being drawn.
   *
   * Kept apart from `selectedNodeId` so linking works in pairs rather than
   * chains. If every click toggled against whatever was previously selected,
   * wiring A-B and then C-D would quietly also create B-C. sim-demo's admin
   * console settled on the same pair semantics for the same reason.
   */
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [dronePhase, setDronePhase] = useState<DronePhase>("idle");
  /**
   * Whose picture the map draws.
   *
   * null is the operator's omniscient view. A node id draws that node's replica
   * instead — its records, its contacts, its fused estimate — which is the only
   * way divergence is visible at all (ARCHITECTURE.md §3.2).
   */
  const [viewpoint, setViewpoint] = useState<string | null>(null);
  const [route, setRoute] = useState<Waypoint[]>([]);
  /**
   * The threat's ground speed, m/s. A property of the run, not of playback.
   *
   * Changing it changes the simulation: a slower drone sits in a node's
   * earshot for longer and is acquired further out, a faster one can cross a
   * blind stretch before anything latches. Playback speed, next to it, only
   * changes how fast you watch that happen.
   */
  const [droneSpeedMps, setDroneSpeedMps] = useState(DRONE_SPEED_MPS);
  /** Link lengths are the operator's main placement feedback; on by default. */
  const [showLinkLengths, setShowLinkLengths] = useState(true);
  /**
   * The "what is this" panel, up on arrival.
   *
   * An empty map with a Place node button says nothing about what the tool is
   * for or what the demo proves, and building the scenario by hand is four
   * gestures before anything moves. This states the claim and offers to set
   * the whole thing up.
   */
  const [showIntro, setShowIntro] = useState(true);
  const mapRef = useRef<LeafletMap | null>(null);
  /**
   * Live position of the node under the cursor.
   *
   * Held apart from `nodes` so the marker and its links track the pointer at
   * 60 Hz while the advisor — which re-solves a CRLB grid over the whole area —
   * only recomputes once, on release.
   */
  const [dragPreview, setDragPreview] = useState<{ id: string; lat: number; lon: number } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragMovedRef = useRef(false);
  /** Read by endNodeDrag, which a window listener may invoke outside React's flow. */
  const dragPreviewRef = useRef<{ id: string; lat: number; lon: number } | null>(null);
  dragPreviewRef.current = dragPreview;
  const eventSeq = useRef(0);
  const [events, setEvents] = useState<ContactEvent[]>([]);
  /**
   * Where the drone was when each node first heard it.
   *
   * A node turning amber is the visible effect; this draws the cause next to
   * it. SimWorld emits exactly one "detect" per node per run — the `announced`
   * set dedupes the fringe latch's chatter at the source — so this list is
   * bounded by the node count and cannot spam.
   */
  const [acquisitions, setAcquisitions] = useState<{ node: string; at: number; travelledM: number; point: Waypoint }[]>([]);

  const onSimEvents = (batch: SimEvent[]) => {
    for (const e of batch) {
      if (e.kind === "detect") {
        const n = nodes.find((x) => x.id === e.node);
        if (route.length > 1) {
          setAcquisitions((current) => [
            ...current.filter((a) => a.node !== e.node),
            { node: e.node, at: e.timeMs, travelledM: e.travelledM, point: pointAlongRoute(route, e.travelledM) },
          ]);
        }
        if (n) logContact("detection", "acoustic contact", { node: n.name, detail: `acquired ${Math.round(e.travelledM)} m into the run` });
      } else {
        logContact("consensus", `contact held by ${e.count} of ${e.total} node${e.total === 1 ? "" : "s"}`, { detail: `t+${(e.timeMs / 1000).toFixed(1)} s` });
      }
    }
  };
  const sim = useSimulation(nodes, connections, route, droneSpeedMps, onSimEvents);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedConnections = useMemo(() => connections.filter((connection) => connection.sourceId === selectedNodeId || connection.targetId === selectedNodeId), [connections, selectedNodeId]);
  const activeNodes = nodes.filter((node) => node.status === "online" || node.status === "degraded");
  const onlineNodeCount = nodes.filter((node) => node.status === "online").length;
  const networkHealth = nodes.length ? Math.round((onlineNodeCount / nodes.length) * 100) : 0;
  const networkConnected = useMemo(() => {
    if (activeNodes.length < 2) return activeNodes.length === 1;
    const activeIds = new Set(activeNodes.map((node) => node.id));
    const visited = new Set<string>([activeNodes[0].id]);
    const queue = [activeNodes[0].id];
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      connections.forEach((connection) => {
        if (!activeIds.has(connection.sourceId) || !activeIds.has(connection.targetId)) return;
        const neighbor = connection.sourceId === current ? connection.targetId : connection.targetId === current ? connection.sourceId : null;
        if (neighbor && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      });
    }
    return visited.size === activeNodes.length;
  }, [activeNodes, connections]);
  const placementStatus = useMemo(() => {
    if (!placementCandidate) return "invalid" as const;
    return getPlacementStatus(placementCandidate);
  }, [placementCandidate]);

  /**
   * The placement advisor.
   *
   * Only nodes that are actually up contribute — an offline sensor measures
   * nothing, so it earns no information. That is what makes this live rather
   * than a one-shot report: delete a sensor and the field goes dark where it
   * stood, and the advisor immediately says where to backfill.
   *
   * Keyed on `nodes` (state, stable between renders) rather than the derived
   * activeNodes array, which is rebuilt every render and would re-run this on
   * every tick. ~15 ms at these resolutions.
   */
  const advisor = useMemo<{ grid: QualityGrid; result: SuggestResult } | null>(() => {
    if (!advisorOn) return null;
    const sites = nodes
      .filter((node) => node.status !== "offline")
      .map((node) => ({ id: node.id, lat: node.lat, lon: node.lon }));
    if (sites.length === 0) return null;
    const live = new Set(sites.map((s) => s.id));
    // The topology the operator actually sees, so the failure count refers to
    // the graph on screen rather than one re-derived from radio range.
    const edges = connections
      .filter((c) => live.has(c.sourceId) && live.has(c.targetId))
      .map((c) => [c.sourceId, c.targetId] as [string, string]);
    const result = suggestPlacements(sites, { edges });
    const grid = qualityGrid(sites, result.area, { nx: 64, ny: 64 });
    return { grid, result };
  }, [advisorOn, nodes, connections]);
  const eligiblePlacementNodes = placementCandidate?.distances.filter(({ distanceM }) => distanceM <= MAX_LINK_DISTANCE_M) ?? [];

  /** Nodes as drawn: committed state, with the dragged one following the cursor. */
  const shownNodes = useMemo(
    () => dragPreview ? nodes.map((n) => n.id === dragPreview.id ? { ...n, lat: dragPreview.lat, lon: dragPreview.lon } : n) : nodes,
    [nodes, dragPreview]
  );

  /**
   * How much of the drawn ingress this array would actually hear.
   *
   * The number that connects placement to a threat: draw a run, see the blind
   * stretch, take the advisor's suggestion, redraw. Uses the same hard radius
   * the flight animation uses, so the prediction and the playback agree.
   */
  const coverage = useMemo(
    () => routeCoverage(route, shownNodes.filter((n) => n.status !== "offline")),
    [route, shownNodes]
  );
  // detectingHeld, to match the markers. Reading the raw latch here while the
  // map holds it puts "INBOUND — UNOBSERVED" next to a map full of amber nodes
  // every time a fringe sensor releases for a window.
  /**
   * Where to put the next sensor, for *this* run.
   *
   * Deliberately separate from the CRLB advisor above: that one asks where a
   * fix gets sharpest over an area, this one asks what would have heard the
   * ingress the operator just drew, and they routinely disagree. Keyed on
   * `nodes` rather than the derived shownNodes so dragging a sensor does not
   * re-solve the search on every frame.
   */
  const routeAdvice = useMemo(() => {
    if (!routeAdvisorOn || route.length < 2) return null;
    return adviseForRoute(
      route,
      nodes.filter((n) => n.status !== "offline").map((n) => ({ id: n.id, lat: n.lat, lon: n.lon }))
    );
  }, [routeAdvisorOn, route, nodes]);

  const hearing = sim.snapshot.nodes.filter((n) => n.detectingHeld).length;
  const droneStatusText = sim.running
    ? hearing
      ? `TRACKED BY ${hearing} NODE${hearing === 1 ? "" : "S"}`
      : "INBOUND — UNOBSERVED"
    : sim.snapshot.done
      ? "RUN COMPLETE"
      : dronePhase === "ready"
        ? `${Math.round(coverage.lengthM)} m route · ${Math.round(coverage.lengthM / droneSpeedMps)} s`
        : "CLICK TO ADD WAYPOINTS";
  /**
   * What each sensor is hearing right now, 0..1.
   *
   * Derived rather than written back into `nodes`: the advisor re-solves a CRLB
   * grid whenever `nodes` changes, and this updates every animation frame.
   */
  const simNodes = useMemo(() => new Map(sim.snapshot.nodes.map((n) => [n.id, n])), [sim.snapshot]);
  const dronePosition = sim.snapshot.dronePosition;

  /**
   * The picture being drawn, and whose it is.
   *
   * In operator view this fuses every fresh reading in the mesh. From a node's
   * viewpoint it fuses only what *that node* holds — so a sensor that has not
   * yet received a record genuinely draws a different map, which is the point.
   */
  const view = useMemo<{ estimate: NodeEstimate | null; contacts: string[]; records: number }>(() => {
    if (shownNodes.length === 0) return { estimate: null, contacts: [], records: 0 };
    const positions = new Map(shownNodes.map((n) => [n.id, { lat: n.lat, lon: n.lon }]));
    const area = areaAround(shownNodes, ESTIMATE_MARGIN_M);
    if (viewpoint) {
      return {
        estimate: estimateFrom(sim.world.freshReadings(viewpoint), positions, area, ESTIMATE_GRID),
        contacts: sim.world.contactsSeenBy(viewpoint),
        records: sim.world.recordCount(viewpoint),
      };
    }
    // Operator view: the union of what the mesh currently holds. Honest about
    // what it is — no single node sees this, which is why the toggle exists.
    const union = new Map<string, ReturnType<typeof sim.world.freshReadings>[number]>();
    for (const n of shownNodes) {
      for (const r of sim.world.freshReadings(n.id)) {
        const prev = union.get(r.origin);
        if (!prev || r.t > prev.t) union.set(r.origin, r);
      }
    }
    return {
      estimate: estimateFrom([...union.values()], positions, area, ESTIMATE_GRID),
      contacts: [...union.values()].filter((r) => r.d).map((r) => r.origin).sort(),
      records: Math.max(0, ...shownNodes.map((n) => sim.world.recordCount(n.id))),
    };
    // sim.snapshot is the tick signal: the world mutates in place, so a new
    // snapshot identity is what tells React the replicas moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownNodes, viewpoint, sim.snapshot, sim.world]);

  const detectingNodeIds = view.contacts;

  /**
   * Whether the drone's audible footprint currently covers a listening sensor.
   *
   * The circle swallowing a node is the cause of that node lighting up, so it
   * should say so at the moment it happens rather than sit as faint decoration.
   */
  const footprintOnNode = useMemo(() => {
    if (!dronePosition) return false;
    return shownNodes.some((node) => {
      if (node.status === "offline") return false;
      if (simNodes.get(node.id)?.lifecycle !== "listening") return false;
      return distanceM(dronePosition[0], dronePosition[1], node.lat, node.lon) <= DRONE_DETECTION_RADIUS_M;
    });
  }, [dronePosition, shownNodes, simNodes]);

  /**
   * Acquisitions still worth drawing, brightest first out of the drone.
   *
   * Aged in simulated time so the fade tracks playback speed and holds while
   * paused.
   */
  const liveAcquisitions = useMemo(
    () => acquisitions
      .map((a) => ({ ...a, fade: 1 - (sim.snapshot.timeMs - a.at) / ACQUIRE_FADE_MS }))
      .filter((a) => a.fade > 0),
    [acquisitions, sim.snapshot.timeMs]
  );

  // Route drawing and sensor placement both need raw map clicks.
  const linksClickable = mode === "idle" || mode === "connecting";

  /**
   * Links carrying news of a detection, 1 fading to 0 over LINK_FLASH_MS.
   *
   * Not "links carrying a record": every node publishes every window whether it
   * heard anything or not, so that set is nearly the whole graph nearly all of
   * the time and a highlight on it is permanently on. Filtering on
   * carriesDetection turns the pulse back into an event — it is off until
   * somebody hears something, then travels outward as the contact does.
   */
  const linkFlashRef = useRef(new Map<string, number>());
  /** Bumped by the fade timer so the highlight keeps decaying once ticks stop. */
  const [flashTick, setFlashTick] = useState(0);
  const carryingLinks = useMemo(() => {
    const now = performance.now();
    const flashes = linkFlashRef.current;
    for (const f of sim.snapshot.inFlight) {
      if (f.carriesDetection) flashes.set(linkKey(f.from, f.to), now);
    }
    const live = new Map<string, number>();
    for (const [key, at] of flashes) {
      const age = now - at;
      if (age < LINK_FLASH_MS) live.set(key, 1 - age / LINK_FLASH_MS);
      else flashes.delete(key);
    }
    return live;
    // flashTick is the fade clock; sim.snapshot is the tick signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.snapshot, flashTick]);

  // Snapshots stop arriving the moment the run pauses or ends, so without this
  // the last flash would freeze on the map at whatever brightness it had.
  useEffect(() => {
    if (sim.running || carryingLinks.size === 0) return;
    const id = window.setTimeout(() => setFlashTick((n) => n + 1), 80);
    return () => window.clearTimeout(id);
  }, [sim.running, carryingLinks.size, flashTick]);

  const holders = sim.snapshot.nodes.filter((n) => n.contacts.length > 0).length;
  const alertStatusText =
    holders === 0
      ? null
      : `Contact held by ${holders} of ${sim.snapshot.nodes.length} node${sim.snapshot.nodes.length === 1 ? "" : "s"}`;
  // First contact per node per run is deduped at the source (detectedNodeIdsRef),
  // so the log needs no second filter.
  const visibleEvents = events;

  /**
   * Reset the world and the things drawn on top of it.
   *
   * The connectors and the link flashes belong to a particular run; leaving
   * them behind after a reset would show causes for detections that no longer
   * exist.
   */
  function resetRun() {
    sim.reset();
    setAcquisitions([]);
    linkFlashRef.current.clear();
  }

  function logContact(kind: ContactKind, message: string, opts: { node?: string; detail?: string } = {}) {
    setEvents((current) =>
      // Monotonic id rather than Date.now(): two events logged inside the same
      // millisecond would share a React key, and duplicate keys let React drop
      // or duplicate list items.
      [{ id: ++eventSeq.current, time: eventTime(), kind, message, ...opts }, ...current].slice(0, 40)
    );
  }

  function selectNode(nodeId: string) {
    if (mode === "connecting") {
      setSelectedNodeId(nodeId);
      if (!linkFrom) { setLinkFrom(nodeId); return; }
      // Clicking the same node again backs out of the pair.
      if (linkFrom === nodeId) { setLinkFrom(null); return; }
      toggleLink(linkFrom, nodeId);
      // Stays in linking mode — wiring a network means several links in a row —
      // but the pair is finished, so the next click starts a new one.
      setLinkFrom(null);
      return;
    }
    setSelectedNodeId(nodeId);
  }

  function toggleLinkMode() {
    const next = mode === "connecting" ? "idle" : "connecting";
    setMode(next);
    setLinkFrom(null);
    // Entering link mode has to clear the selection. A node is almost always
    // already selected — placing or dragging one selects it — so the first
    // click would otherwise complete a link from whatever happened to be
    // highlighted rather than starting a new one.
    if (next === "connecting") setSelectedNodeId(null);
  }

  /** One link per pair, either direction — so this adds or removes. */
  function toggleLink(a: string, b: string) {
    const id = a < b ? `link-${a}-${b}` : `link-${b}-${a}`;
    setConnections((current) =>
      current.some((c) => (c.sourceId === a && c.targetId === b) || (c.sourceId === b && c.targetId === a))
        ? current.filter((c) => !((c.sourceId === a && c.targetId === b) || (c.sourceId === b && c.targetId === a)))
        : [...current, { id, sourceId: a, targetId: b, status: "active" }]
    );
  }

  /**
   * Lay a ring of sensors around whatever the map is currently looking at.
   *
   * Generated from the live map centre rather than stored coordinates, so it
   * works wherever you have panned to — the point of dropping the fixture was
   * to stop pinning this tool to one place. 120 m puts adjacent nodes 141 m
   * apart, inside the 150 m radio range, so the ring comes up connected.
   */
  function seedRing(count = 5, radiusM = 120) {
    const centre = mapRef.current?.getCenter();
    if (!centre) return;
    const frame = makeFrame(centre.lat, centre.lng);
    const fresh: OperatorNode[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count;
      const [lat, lon] = toLatLon(frame, Math.cos(angle) * radiusM, Math.sin(angle) * radiusM);
      const n = ++nodeSeq.current;
      fresh.push({ id: `node-${n}`, name: `Sensor ${n}`, lat, lon, status: "online", lastSeen: Date.now() });
    }
    const all = [...nodes, ...fresh];
    const links: NodeConnection[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (distanceM(all[i].lat, all[i].lon, all[j].lat, all[j].lon) > MAX_LINK_DISTANCE_M) continue;
        const id = all[i].id < all[j].id ? `link-${all[i].id}-${all[j].id}` : `link-${all[j].id}-${all[i].id}`;
        if (connections.some((c) => c.id === id)) continue;
        links.push({ id, sourceId: all[i].id, targetId: all[j].id, status: "active" });
      }
    }
    setNodes(all);
    setConnections((current) => [...current, ...links.filter((l) => !current.some((c) => c.id === l.id))]);
    fresh.forEach((n) => logContact("online", "came online", { node: n.name }));
  }

  /**
   * The whole scenario in one click: array, ingress, framing, go.
   *
   * Building it by hand is the point of the tool, but it is four separate
   * gestures before anything happens — and at the default zoom a hand-drawn
   * route comes out kilometres long, so a newcomer's first run is a drone
   * crawling across empty map for a minute. This lays down the same ring
   * seedRing does, draws an ingress that actually crosses it, frames both, and
   * starts the run.
   *
   * Only offered from an empty map (see the intro panel), so it can replace
   * state outright without discarding a network somebody built.
   */
  function runWholeDemo() {
    const centre = mapRef.current?.getCenter();
    if (!centre) return;
    const frame = makeFrame(centre.lat, centre.lng);

    // 120 m radius puts neighbours 141 m apart — inside the 150 m radio range,
    // so the ring comes up connected rather than as five islands.
    const fresh: OperatorNode[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (2 * Math.PI * i) / 5;
      const [lat, lon] = toLatLon(frame, Math.cos(angle) * 120, Math.sin(angle) * 120);
      const n = ++nodeSeq.current;
      fresh.push({ id: `node-${n}`, name: `Sensor ${n}`, lat, lon, status: "online", lastSeen: Date.now() });
    }
    const links: NodeConnection[] = [];
    for (let i = 0; i < fresh.length; i++) {
      for (let j = i + 1; j < fresh.length; j++) {
        if (distanceM(fresh[i].lat, fresh[i].lon, fresh[j].lat, fresh[j].lon) > MAX_LINK_DISTANCE_M) continue;
        links.push({ id: `link-${fresh[i].id}-${fresh[j].id}`, sourceId: fresh[i].id, targetId: fresh[j].id, status: "active" });
      }
    }

    // A blind lead-in, a crossing, an exit. The lead-in matters: it is the
    // stretch where nothing is lit, which is what makes the moment the array
    // acquires the drone read as an event rather than the map's resting state.
    // ~10 s of it before anything can hear the drone. That lead-in is doing
    // real work: it is the stretch where no link is lit, which is what makes
    // the moment the array acquires the contact read as an event rather than
    // as the map's resting state.
    const demoRoute = [
      toLatLon(frame, -450, 120),
      toLatLon(frame, 0, -20),
      toLatLon(frame, 200, 55),
    ] as Waypoint[];

    setNodes(fresh);
    setConnections(links);
    setRoute(demoRoute);
    setDronePhase("ready");
    setSelectedNodeId(null);
    setViewpoint(null);
    setMode("idle");
    setShowIntro(false);
    resetRun();
    fresh.forEach((n) => logContact("online", "came online", { node: n.name }));
    // Frame the array and the whole ingress; a hand-drawn route at this zoom
    // would otherwise run off the edges.
    mapRef.current?.fitBounds(
      [...demoRoute, ...fresh.map((n) => [n.lat, n.lon] as Waypoint)],
      { padding: [80, 80], maxZoom: 17 }
    );
    sim.play();
  }

  function removeLink(linkId: string) {
    const link = connections.find((c) => c.id === linkId);
    if (!link) return;
    setConnections((current) => current.filter((c) => c.id !== linkId));
    const a = nodes.find((n) => n.id === link.sourceId)?.name ?? link.sourceId;
    const b = nodes.find((n) => n.id === link.targetId)?.name ?? link.targetId;
    logContact("offline", `link ${a} – ${b} removed`);
  }

  function removeNode(nodeId: string) {
    const node = nodes.find((n) => n.id === nodeId);
    setNodes((current) => current.filter((n) => n.id !== nodeId));
    setConnections((current) => current.filter((c) => c.sourceId !== nodeId && c.targetId !== nodeId));
    setSelectedNodeId(null);
    if (node) logContact("offline", "removed from the network", { node: node.name });
  }

  function handleMapClick(event: LeafletMouseEvent) {
    // A click that ends a node drag is not a map click.
    if (dragMovedRef.current) { dragMovedRef.current = false; return; }
    if (mode === "route") {
      const point: Waypoint = [event.latlng.lat, event.latlng.lng];
      setRoute((current) => [...current, point]);
      return;
    }
    if (mode !== "placing") return;
    const candidate = buildPlacementCandidate(event.latlng.lat, event.latlng.lng, nodes);
    if (!candidate) return;
    const candidateNeighbors = candidate.distances.filter(({ distanceM }) => distanceM <= MAX_LINK_DISTANCE_M);
    setPlacementCandidate(candidate);
    // The spacing and link rules are guidance, not a gate: the hover preview
    // already colours the spot red/amber/green before the click. Refusing to
    // place a node makes laying out a network by hand a fight, and an isolated
    // node is a legitimate thing to want — you can wire it up afterwards.
    placeNodeAt(event.latlng.lat, event.latlng.lng, candidateNeighbors.map(({ node }) => node.id));
  }

  /** Add a sensor and wire it to the given neighbours. Shared by the hover-click
   *  placement path and by accepting an advisor suggestion. */
  function placeNodeAt(lat: number, lon: number, neighbourIds: string[], describe?: string): OperatorNode {
    const n = ++nodeSeq.current;
    const newNode: OperatorNode = { id: `node-${n}`, name: `Sensor ${n}`, lat, lon, status: "online", lastSeen: Date.now() };
    setNodes((current) => [...current, newNode]);
    setConnections((current) => [...current, ...neighbourIds.map((id) => ({ id: `link-${newNode.id}-${id}`, sourceId: newNode.id, targetId: id, status: "active" as const }))]);
    setSelectedNodeId(newNode.id);
    setMode("idle");
    setPlacementCandidate(null);
    logContact("online", "came online", { node: newNode.name, detail: describe ?? (neighbourIds.length ? `${neighbourIds.length} link${neighbourIds.length === 1 ? "" : "s"}` : "no links — wire it up") });
    return newNode;
  }

  function toggleAdvisor() {
    const next = !advisorOn;
    setAdvisorOn(next);

  }

  function acceptSuggestion(lat: number, lon: number, neighbourIds: string[], rank: number) {
    placeNodeAt(lat, lon, neighbourIds, `suggested position ${rank}`);
  }

  /** Take a route recommendation, keeping the reason it was made in the log. */
  function acceptRouteSuggestion(s: RouteSuggestion) {
    placeNodeAt(s.lat, s.lon, s.neighbours, `for the ingress · ${s.headline.toLowerCase()}`);
  }

  function handleMapMove(event: LeafletMouseEvent) {
    if (dragIdRef.current) { dragNodeTo(event.latlng.lat, event.latlng.lng); return; }
    if (mode !== "placing") return;
    setPlacementCandidate(buildPlacementCandidate(event.latlng.lat, event.latlng.lng, nodes));
  }

  // --- dragging a sensor to a new position ---

  function startNodeDrag(nodeId: string) {
    dragIdRef.current = nodeId;
    dragMovedRef.current = false;
    // Otherwise Leaflet pans the map out from under the node being dragged.
    mapRef.current?.dragging.disable();
  }

  function dragNodeTo(lat: number, lon: number) {
    const id = dragIdRef.current;
    if (!id) return;
    dragMovedRef.current = true;
    setDragPreview({ id, lat, lon });
  }

  function endNodeDrag() {
    const id = dragIdRef.current;
    dragIdRef.current = null;
    mapRef.current?.dragging.enable();
    if (!id) return;
    const preview = dragPreviewRef.current;
    setDragPreview(null);
    // A press that never moved is a selection, not a drag — the click handler
    // would otherwise be swallowed and picking a node would stop working.
    if (!dragMovedRef.current || !preview) {
      selectNode(id);
      return;
    }
    setNodes((current) => current.map((n) => n.id === id ? { ...n, lat: preview.lat, lon: preview.lon, lastSeen: Date.now() } : n));
    const node = nodes.find((n) => n.id === id);

  }

  // --- attack route ---

  function drawRoute() {
    if (mode === "route") { finishRoute(); return; }
    resetRun();
    setRoute([]);
    setDronePhase("drawing");
    setMode("route");
    setSelectedNodeId(null);

  }

  function finishRoute() {
    setMode("idle");
    if (route.length < 2) {
      setDronePhase("idle");
      setRoute([]);

      return;
    }
    setDronePhase("ready");
    resetRun();
  }

  function undoWaypoint() {
    setRoute((current) => current.slice(0, -1));
  }

  useEffect(() => {
    if (!selectedNodeId) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [selectedNodeId]);

  // Releasing outside the map never reaches Leaflet's mouseup, which would leave
  // the node glued to the cursor and map panning disabled for the rest of the
  // session. Catch it on the window instead.
  useEffect(() => {
    const up = () => { if (dragIdRef.current) endNodeDrag(); };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  });

  function addSensorNode() {
    setMode("placing");
    setSelectedNodeId(null);
    setPlacementCandidate(null);

  }

  function togglePlacementMode() {
    if (mode === "placing") {
      setMode("idle");
      setPlacementCandidate(null);
      return;
    }
    addSensorNode();
  }

  return (
    <>
    <OperationsHeader />
    <main className={styles.shell}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>Simulation · synthetic sensors</p><h1 className={styles.title}>Network simulation</h1><p className={styles.modeNotice}>Planning sandbox. No microphone, live sensors, or relay connection.</p></div>
        <div className={styles.headerStats}><div className={styles.networkStatus}><span className={styles.statusDot} /> {nodes.length === 0 ? "no network" : "simulated network"}</div><div className={styles.stat}><strong>{activeNodes.length}</strong> active</div><div className={styles.stat}><strong>{sim.running ? 1 : 0}</strong> drones</div><div className={styles.stat}><strong>{nodes.length === 0 ? "—" : `${networkHealth}%`}</strong> health</div></div>
      </header>
      <div className={styles.workspace}>
        <section className={styles.mapArea} aria-label="Interactive sensor map">
          {tilesUnavailable && <p className={styles.tileNotice} role="status">Satellite imagery unavailable. Placement and simulation still work on the blank map.</p>}
          <div className={styles.toolbar}>
            <ActionButton className={mode === "placing" ? styles.buttonActive : styles.button} onClick={togglePlacementMode} type="button">{mode === "placing" ? "Cancel placement" : "Place node"}</ActionButton>
            <ActionButton className={mode === "connecting" ? styles.buttonActive : styles.button} onClick={toggleLinkMode} type="button">{mode === "connecting" ? "Done linking" : "Link nodes"}</ActionButton>
            <ActionButton className={showLinkLengths ? styles.buttonActive : styles.button} onClick={() => setShowLinkLengths((on) => !on)} type="button" aria-pressed={showLinkLengths}>Link lengths</ActionButton>
            <ActionButton className={showIntro ? styles.buttonActive : styles.button} onClick={() => setShowIntro((on) => !on)} type="button" aria-pressed={showIntro}>What is this?</ActionButton>
          </div>
          {mode !== "idle" && <div className={styles.mapHint}>{mode === "placing" ? placementCandidate ? <><strong>{placementStatus === "invalid" ? `${Math.round(placementCandidate.distances[0]?.distanceM ?? 0)} m — too close` : placementStatus === "warning" ? `${eligiblePlacementNodes.length}/${MIN_CONNECTIONS} required neighbors` : `Valid placement — ${eligiblePlacementNodes.length} available links`}</strong><span className={styles.placementDistances}>{placementCandidate.distances.slice(0, 3).map(({ node, distanceM }) => `${node.name}: ${Math.round(distanceM)} m`).join(" · ")}</span></> : "Move across the map to preview placement constraints." : mode === "route" ? (route.length === 0 ? "Click to set the launch point, then click each waypoint along the ingress." : `${route.length} waypoint${route.length === 1 ? "" : "s"} · ${Math.round(coverage.lengthM)} m · ${Math.round(coverage.covered * 100)}% observed — finish when done`) : linkFrom ? `Linking from ${nodes.find((n) => n.id === linkFrom)?.name ?? linkFrom} — click another sensor to link or unlink.` : "Click a sensor, then click another to link or unlink the pair."}</div>}
          <MapContainer center={MAP_CENTER} zoom={15} className={styles.map} zoomControl={false}>
            <TileLayer eventHandlers={{ tileerror: () => setTilesUnavailable(true) }} className={styles.mapTiles} attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics" url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />
            <MapInteractions onMapClick={handleMapClick} onMapMove={handleMapMove} onMapUp={endNodeDrag} mapRef={mapRef} />
            {connections.map((connection) => {
              const points = connectionPoints(connection, shownNodes);
              if (!points) return null;
              // Lit because a record saying somebody heard a drone is
              // physically on this link right now, not because an animation
              // decided it should be. `flash` fades it out over LINK_FLASH_MS
              // so a single 50 ms hop is still something you can see.
              const flash = carryingLinks.get(linkKey(connection.sourceId, connection.targetId)) ?? 0;
              const carrying = flash > 0;
              // Measured from the drawn positions, so the number tracks a
              // sensor being dragged rather than lagging until mouse-up.
              const span = Math.round(distanceM(points[0][0], points[0][1], points[1][0], points[1][1]));
              // Over-range links are legal — the operator may have drawn one
              // deliberately — but the label should say so rather than read as
              // an ordinary hop.
              const overRange = span > MAX_LINK_DISTANCE_M;
              return <Fragment key={connection.id}>
                {/* A fat invisible polyline under the 2 px line. Without it a link
                    is almost impossible to hit with a mouse, and "delete it in
                    place" is a promise the map cannot keep. Suppressed while a
                    route is being drawn or a sensor placed, so it cannot swallow
                    the map clicks those modes are waiting for. */}
                {linksClickable && (
                  <Polyline positions={points} interactive
                    pathOptions={{ className: LINK_HIT_CLASS, color: "#ffffff", opacity: 0, weight: 16 }}
                    eventHandlers={{ click: () => removeLink(connection.id), contextmenu: (e) => { e.originalEvent.preventDefault(); removeLink(connection.id); } }}>
                    <Tooltip sticky>{span} m{overRange ? ` · over the ${MAX_LINK_DISTANCE_M} m range` : ""} · click to remove</Tooltip>
                  </Polyline>
                )}
                <Polyline positions={points} interactive={false}
                  pathOptions={{ className: carrying ? styles.alertRouteLine : styles.mapDecoration, color: carrying ? "#ffd166" : connection.status === "degraded" ? "#e3a93b" : "#4bc4ff", dashArray: !carrying && connection.status === "degraded" ? "6 8" : undefined, opacity: carrying ? .72 + .28 * flash : .72, weight: carrying ? 2 + 3 * flash : 2 }}>
                  {showLinkLengths && (
                    <Tooltip permanent direction="center" className={overRange ? styles.linkLabelOver : styles.linkLabel}>{span} m</Tooltip>
                  )}
                </Polyline>
              </Fragment>;
            })}
            {dragPreview && <Circle center={[dragPreview.lat, dragPreview.lon]} radius={DRONE_DETECTION_RADIUS_M} pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#4bc4ff", fillColor: "#4bc4ff", fillOpacity: .06, weight: 1, dashArray: "4 7" }} />}
            <Pane name="nodeMarkers" style={{ zIndex: 650 }}>
              {shownNodes.map((node) => {
                const selected = node.id === selectedNodeId || node.id === linkFrom;
                const s = simNodes.get(node.id);
                // Three distinct things, and the difference is the whole point:
                // what this node hears itself, what it has been *told* about,
                // and whether it is still booting.
                // detectingHeld, not detecting: a node at the edge of range
                // trips and releases about once a second — the right verdict
                // each time, and a strobe as a colour. The verdict on the wire
                // and everything derived from it stays the true latched one.
                const hearing = !!s?.detectingHeld;
                const informed = !hearing && (s?.contacts.length ?? 0) > 0;
                const booting = s?.lifecycle === "booting";
                const isViewpoint = node.id === viewpoint;
                const color = booting ? "#65778a" : hearing ? "#ffd166" : informed ? "#b9a3ff" : nodeColor(node, selected);
                return <CircleMarker key={node.id} center={[node.lat, node.lon]}
                  radius={isViewpoint ? 11 : selected ? 10 : hearing || informed ? 9 : 7}
                  pathOptions={{ className: informed ? styles.nodeRelaying : hearing ? styles.nodeDetecting : booting ? undefined : node.status === "online" && !selected ? styles.nodePulse : selected ? styles.nodeSelected : undefined, color, fillColor: color, fillOpacity: booting ? .35 : .9, weight: isViewpoint ? 5 : selected ? 4 : 3 }}
                  eventHandlers={{ mousedown: () => startNodeDrag(node.id), contextmenu: (e) => { e.originalEvent.preventDefault(); removeNode(node.id); } }}>
                  <Tooltip direction="top" offset={[0, -8]}>
                    {node.name}{booting ? " · booting" : hearing ? " · hears the drone" : informed ? " · holds a contact it cannot hear" : ""}
                    <br />{s?.records ?? 0} records held{isViewpoint ? " · this is the view" : ""}
                  </Tooltip>
                </CircleMarker>;
              })}
            </Pane>
            {view.estimate && view.estimate.nReports > 0 && (
              <EstimateLayer estimate={view.estimate} />
            )}
            {advisor && <PlacementLayer grid={advisor.grid} suggestions={advisor.result.suggestions} nodes={shownNodes} showField onAccept={(s) => acceptSuggestion(s.lat, s.lon, s.neighbours, s.rank)} />}
            <PlacementPreview candidate={placementCandidate} status={placementStatus} />
            {/* Each recommendation drawn where it would go, with the ground it
                would newly hear. The circle is the point: you can see it
                swallow the blind stretch before accepting anything. */}
            {routeAdvice?.suggestions.map((s) => (
              <Fragment key={`ra-${s.rank}`}>
                <Circle center={[s.lat, s.lon]} radius={DRONE_DETECTION_RADIUS_M}
                  pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#5ce1c6", fillColor: "#5ce1c6", fillOpacity: s.rank === 1 ? .1 : .05, weight: s.rank === 1 ? 2 : 1, dashArray: "5 6" }} />
                {s.neighbours.map((id) => {
                  const n = shownNodes.find((x) => x.id === id);
                  return n ? <Polyline key={`ra-${s.rank}-${id}`} positions={[[s.lat, s.lon], [n.lat, n.lon]]}
                    pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#5ce1c6", dashArray: "3 6", opacity: .6, weight: 1 }} /> : null;
                })}
                <CircleMarker center={[s.lat, s.lon]} radius={9}
                  pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#5ce1c6", fillColor: "#08201d", fillOpacity: .92, weight: 3 }}>
                  <Tooltip permanent direction="top" offset={[0, -10]} className={styles.adviceLabel}>
                    {s.rank} · {s.badge}
                  </Tooltip>
                </CircleMarker>
              </Fragment>
            ))}
            {route.length > 1 && (
              // Drawn per coverage run rather than as one line: the percentage
              // says how much of the ingress is observed, this says which part.
              // Solid where a sensor hears it, dashed and amber where nothing does.
              coverage.segments.map((seg, i) => (
                <Polyline key={`seg-${i}`} positions={seg.points} pathOptions={{ className: styles.flightPath, interactive: false, color: seg.covered ? "#39d98a" : "#e3a93b", dashArray: seg.covered ? undefined : "6 7", opacity: seg.covered ? .95 : .9, weight: seg.covered ? 4 : 3 }} />
              ))
            )}
            {route.map((wp, i) => (
              <CircleMarker key={`wp-${i}`} center={wp} radius={i === route.length - 1 && route.length > 1 ? 7 : 5} pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#f4c95d", fillColor: "#0a0f1a", fillOpacity: .9, weight: 2 }}>
                {/* Named on the map rather than on hover: a dark dot with a
                    gold ring is also what the fused fix looks like, and three
                    of them on one screen meaning different things is what
                    makes the picture unreadable. */}
                <Tooltip permanent={i === 0 || (i === route.length - 1 && route.length > 1)}
                  direction="top" offset={[0, -9]} className={styles.routeLabel}>
                  {i === 0 ? "Launch" : i === route.length - 1 && route.length > 1 ? "Target" : `Waypoint ${i}`}
                </Tooltip>
              </CircleMarker>
            ))}
            {/* Why a node lit: the drone was here, this far into the run, and
                that sensor heard it. One connector per node per run — SimWorld
                emits a single "detect" event each — fading over simulated time
                so it tracks the playback speed and holds while paused. */}
            {liveAcquisitions.map((a) => {
              const node = shownNodes.find((n) => n.id === a.node);
              if (!node) return null;
              return <Fragment key={`acq-${a.node}`}>
                <Polyline positions={[a.point, [node.lat, node.lon]]} pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#ffd166", dashArray: "5 5", opacity: a.fade, weight: 2 }} />
                <CircleMarker center={a.point} radius={4} pathOptions={{ className: styles.mapDecoration, interactive: false, color: "#ffd166", fillColor: "#ffd166", fillOpacity: a.fade, opacity: a.fade, weight: 1 }}>
                  <Tooltip permanent direction="top" offset={[0, -6]} className={styles.acquireLabel}>
                    {node.name} · {Math.round(a.travelledM)} m in
                  </Tooltip>
                </CircleMarker>
              </Fragment>;
            })}
            {/* The audible footprint. Warm and solid while it covers a
                listening sensor, because that overlap is the cause of the node
                going amber and it should be the thing you notice. */}
            {dronePosition && <><Circle center={dronePosition} radius={DRONE_DETECTION_RADIUS_M} pathOptions={{ className: styles.mapDecoration, color: footprintOnNode ? "#ffb347" : "#f4c95d", fillColor: footprintOnNode ? "#ffb347" : "#f4c95d", fillOpacity: footprintOnNode ? .17 : .09, weight: footprintOnNode ? 3 : 1.5, dashArray: footprintOnNode ? undefined : "4 7" }} /><Marker position={dronePosition} icon={droneIcon}><Tooltip direction="top" offset={[0, -16]}>Simulated drone</Tooltip></Marker></>}
          </MapContainer>
          {viewpoint && (
            <div className={styles.viewpointBanner}>
              <span>Seeing what <b>{nodes.find((n) => n.id === viewpoint)?.name ?? viewpoint}</b> sees — {view.records} records, {view.contacts.length} contact{view.contacts.length === 1 ? "" : "s"}</span>
              <ActionButton onClick={() => setViewpoint(null)} type="button">operator view</ActionButton>
            </div>
          )}
          {showIntro && mode === "idle" && (
            <div className={styles.introPanel}>
              <ActionButton className={styles.introClose} onClick={() => setShowIntro(false)} type="button" aria-label="Close">×</ActionButton>
              <p className={styles.introKicker}>What this is</p>
              <h2 className={styles.introTitle}>A drone-detection net with no server in it.</h2>
              <p className={styles.introLede}>
                Counter-UAS radar runs $100k a site and is a single thing to kill. SkyMesh is
                the opposite bet: many cheap, identical phones that each hear the drone
                themselves and gossip what they heard to their neighbours. Every node holds
                its own copy of the picture, so there is no headquarters for an alert to
                reach — and no one node whose loss stops it.
              </p>
              <ol className={styles.introSteps}>
                <li><b>Place</b> sensors and wire them into a mesh — the map shows the spacing and range rules as you go.</li>
                <li><b>Draw</b> an ingress a drone would really fly, and see what fraction of it the array would hear.</li>
                <li><b>Watch</b> which sensor hears it first, and the contact spread outward hop by hop.</li>
              </ol>
              <p className={styles.introNote}>
                The run is a real timed simulation, not an animation: per-node replicas,
                50 ms links, gossip, and a detection latch that can and does disagree
                between nodes. Open any sensor and pick <b>See what this node sees</b> to
                draw the map from its replica instead of the operator&rsquo;s.
              </p>
              <div className={styles.introActions}>
                {nodes.length === 0 ? (
                  <>
                    <ActionButton className={styles.introPrimary} onClick={runWholeDemo} type="button">▶ Run the whole demo</ActionButton>
                    <ActionButton className={styles.linkAction} onClick={() => { setShowIntro(false); seedRing(); }} type="button">just place 5 sensors</ActionButton>
                    <ActionButton className={styles.linkAction} onClick={() => { setShowIntro(false); addSensorNode(); }} type="button">build it myself</ActionButton>
                  </>
                ) : (
                  <ActionButton className={styles.introPrimary} onClick={() => setShowIntro(false)} type="button">Got it</ActionButton>
                )}
              </div>
            </div>
          )}
          {/* The four node states are already distinct on the map and named
              only in a hover tooltip, which is no use while watching a run. */}
          {nodes.length > 0 && (
            <div className={styles.stateLegend}>
              <p className={styles.stateLegendTitle}>Sensor state</p>
              <ul>
                <li><i style={{ background: "#65778a" }} />booting</li>
                <li><i style={{ background: "#39d98a" }} />listening</li>
                <li><i style={{ background: "#ffd166" }} />hears the drone</li>
                <li><i style={{ background: "#b9a3ff" }} />holds a relayed contact</li>
              </ul>
              {/* Everything else on the map. Without this the amber shapes all
                  read alike: a waypoint, a fused fix and the drone's audible
                  footprint are three different claims in the same palette. */}
              <p className={styles.stateLegendTitle}>Map layers</p>
              <ul>
                <li><b className={styles.swatchLine} style={{ background: "#4bc4ff" }} />link, with its span in metres</li>
                <li><b className={styles.swatchLine} style={{ background: "#ffd166" }} />link carrying a detection</li>
                <li><b className={styles.swatchLine} style={{ background: "#39d98a" }} />route the array would hear</li>
                <li><b className={styles.swatchDash} style={{ color: "#e3a93b" }} />route it would not</li>
                <li><span className={styles.swatchRing} style={{ borderColor: "#f4c95d" }} />drone + what it is audible within</li>
                <li><span className={styles.swatchFix} />fused fix, and how wide it is</li>
              </ul>
            </div>
          )}
          {/* Dismissing the explanation should not leave a blank map with no
              way forward; "What is this?" in the toolbar brings it back. */}
          {!showIntro && nodes.length === 0 && mode === "idle" && (
            <div className={styles.emptyHint}>
              No sensors. Use <b>Place node</b> above, <ActionButton className={styles.linkAction} onClick={() => seedRing()} type="button">seed a ring of 5</ActionButton>, or <ActionButton className={styles.linkAction} onClick={runWholeDemo} type="button">run the whole demo</ActionButton>.
            </div>
          )}
          {advisor && (
            <div className={styles.advisorLegend}>
              <p className={styles.advisorLegendTitle}>Localisation quality</p>
              <div className={styles.advisorRamp} />
              <div className={styles.advisorScale}><span>blind</span><span>±50 m</span><span>±15 m</span></div>
              <p className={styles.advisorLegendNote}>
                Cramér–Rao bound on position error from acoustic level, given this
                geometry. Dark is where the array cannot tell you where a drone is.
              </p>
            </div>
          )}
        </section>
        <aside className={styles.panel} aria-label="Node inspector">
          <section className={styles.scenarioSection} aria-label="Scenario controls">
            <div className={styles.scenarioHeader}><div><p className={styles.sectionKicker}>Demo layer</p><h2>Attack run</h2></div><span className={styles.threatBadge} data-level={sim.running ? "elevated" : "nominal"}>{sim.running ? "Elevated" : "Nominal"}</span></div>
            <ActionButton className={mode === "route" ? styles.runButtonActive : styles.runButton} onClick={drawRoute} type="button">
              {mode === "route" ? `Finish route (${route.length} waypoint${route.length === 1 ? "" : "s"})` : dronePhase === "idle" ? "Draw attack route" : "Redraw route"}
            </ActionButton>
            {route.length > 1 && (
              <div className={styles.runCoverage} data-thin={coverage.covered < 0.6}>
                <div className={styles.runBar}><i style={{ width: `${Math.round(coverage.covered * 100)}%` }} /></div>
                <div className={styles.runLegend}>
                  <span data-covered="true">observed</span>
                  <span data-covered="false">blind</span>
                </div>
                <div className={styles.runFacts}>
                  <span><b>{Math.round(coverage.covered * 100)}%</b> of run observed</span>
                  <span>{coverage.contacts.length}/{activeNodes.length} nodes make contact</span>
                  <span>{coverage.firstContactM === null ? "never detected" : `first contact ${Math.round(coverage.firstContactM)} m in`}</span>
                  {coverage.longestGapM > 1 && <span>{Math.round(coverage.longestGapM)} m blind stretch</span>}
                </div>
              </div>
            )}
            {dronePhase === "ready" || sim.snapshot.timeMs > 0 ? (
              <div className={styles.speedControl}>
                <div className={styles.speedControlHead}>
                  <label htmlFor="drone-speed">Drone speed</label>
                  <strong>{droneSpeedMps} m/s</strong>
                  <span>{Math.round(droneSpeedMps * 3.6)} km/h</span>
                </div>
                <input id="drone-speed" type="range" className={styles.speedSlider}
                  min={MIN_DRONE_SPEED_MPS} max={MAX_DRONE_SPEED_MPS} step={1} value={droneSpeedMps}
                  onChange={(e) => setDroneSpeedMps(Number(e.target.value))} />
                {/* How fast the threat actually flies, not how fast you watch
                    it. Coverage is geometry and does not move; the time to
                    cross it does, and so does whether a node gets enough
                    windows to latch on the way past. */}
                <p className={styles.speedNote}>
                  {route.length > 1
                    ? `${Math.round(coverage.lengthM)} m run · ${Math.round(coverage.lengthM / droneSpeedMps)} s at this speed`
                    : "Ground speed of the threat — playback speed below is only how fast you watch it."}
                </p>
              </div>
            ) : null}
            {dronePhase === "ready" || sim.snapshot.timeMs > 0 ? (
              <div className={styles.transport}>
                <ActionButton className={styles.transportPlay} onClick={sim.running ? sim.pause : sim.play} type="button">
                  {sim.running ? "❚❚ Pause" : sim.snapshot.done ? "▶ Replay" : "▶ Run"}
                </ActionButton>
                <div className={styles.transportSpeeds}>
                  {SPEEDS.map((x) => (
                    <ActionButton key={x} className={sim.speed === x ? styles.speedActive : styles.speed} onClick={() => sim.setSpeed(x)} type="button">{x}×</ActionButton>
                  ))}
                </div>
                <ActionButton className={styles.scenarioButton} onClick={resetRun} type="button"><span>↺</span>Reset</ActionButton>
                <span className={styles.transportClock}>t+{(sim.snapshot.timeMs / 1000).toFixed(1)} s</span>
              </div>
            ) : null}
            <div className={styles.scenarioRow}>
              {mode === "route" && route.length > 0 && <ActionButton className={styles.scenarioButton} onClick={undoWaypoint} type="button"><span>↶</span>Undo</ActionButton>}
              {dronePhase !== "idle" && mode !== "route" && <ActionButton className={styles.scenarioButton} onClick={() => { resetRun(); setDronePhase("idle"); setRoute([]); }} type="button"><span>×</span>Clear</ActionButton>}
              <ActionButton className={advisorOn ? styles.scenarioButtonActive : styles.scenarioButton} onClick={toggleAdvisor} type="button"><span>◎</span>{advisorOn ? "Hide advice" : "Suggest placement"}</ActionButton>
            </div>
            {advisor && (
              <>
                <div className={styles.advisorStats}>
                  <div><strong>±{Math.round(advisor.result.baselineMedianCoveredRadiusM)} m</strong><span>typical fix, where heard</span></div>
                  <div><strong>{Math.round(advisor.result.baselineCoverage * 100)}%</strong><span>area covered</span></div>
                </div>
                {advisor.result.suggestions.length > 0 ? (
                  <ul className={styles.advisorList}>
                    {advisor.result.suggestions.map((s) => (
                      <li key={s.rank}>
                        <ActionButton className={styles.advisorItem} type="button" onClick={() => acceptSuggestion(s.lat, s.lon, s.neighbours, s.rank)}>
                          <span className={styles.advisorRank}>{s.rank}</span>
                          <span>±<b>{Math.round(s.medianCoveredRadiusM)} m</b> · {s.neighbours.length} link{s.neighbours.length === 1 ? "" : "s"}{s.coverageGain > 0.005 && ` · +${Math.round(s.coverageGain * 100)}% area`}</span>
                          <span className={styles.advisorGain}>−{Math.round(s.improvementM)} m</span>
                        </ActionButton>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.advisorLegendNote}>
                    No legal spot left: every candidate is either within {MIN_NODE_DISTANCE_M} m of an
                    existing sensor or cannot reach {MIN_CONNECTIONS} neighbours inside {MAX_LINK_DISTANCE_M} m.
                  </p>
                )}
              </>
            )}
            {route.length > 1 && (
              <ActionButton className={routeAdvisorOn ? styles.scenarioButtonActive : styles.scenarioButton}
                onClick={() => setRouteAdvisorOn((on) => !on)} type="button" style={{ width: "100%", marginTop: 8 }}>
                <span>◈</span>{routeAdvisorOn ? "Hide ingress advice" : "Where should sensors go for this run?"}
              </ActionButton>
            )}
            {routeAdvice && (
              <div className={styles.adviceBox}>
                <div className={styles.adviceHead}>
                  <p className={styles.sectionKicker}>Placement for this ingress</p>
                  <span>{routeAdvice.feasibleCount} legal spots searched</span>
                </div>
                {routeAdvice.suggestions.length === 0 ? (
                  <p className={styles.advisorLegendNote}>
                    {routeAdvice.baselineCoverage >= 0.999
                      ? "This run is already observed end to end. Another sensor would sharpen the fix, not find the drone sooner — the area advisor is the one to ask for that."
                      : "No legal spot meaningfully improves this run. Every candidate is either within " +
                        `${MIN_NODE_DISTANCE_M} m of an existing sensor, or too far from the track to hear it.`}
                  </p>
                ) : (
                  <ol className={styles.adviceList}>
                    {routeAdvice.suggestions.map((s) => (
                      <li key={s.rank}>
                        <ActionButton className={styles.adviceItem} type="button" onClick={() => acceptRouteSuggestion(s)}>
                          <span className={styles.adviceRank}>{s.rank}</span>
                          <span className={styles.adviceBody}>
                            <b>{s.headline}</b>
                            <em>{s.detail}</em>
                            <i className={styles.adviceBar} aria-hidden>
                              <u style={{ width: `${Math.round(s.confidence * 100)}%` }} />
                            </i>
                          </span>
                          <span className={styles.adviceScore}>{Math.round(s.confidence * 100)}%</span>
                        </ActionButton>
                      </li>
                    ))}
                  </ol>
                )}
                <p className={styles.adviceFootnote}>
                  Ranked by warning time first, then how much of the run is observed, then
                  the widest blind stretch closed — each spot scored with the higher-ranked
                  ones already in place. A search over legal positions, not a model.
                </p>
              </div>
            )}
            {nodes.length > 0 && <div className={styles.connectionHealth}><span>Network connectivity</span><strong data-connected={networkConnected}>{networkConnected ? "Connected" : "Partitioned"}</strong></div>}
            {dronePhase !== "idle" && <div className={styles.droneStatus}><span>{droneStatusText}</span>{detectingNodeIds.length > 0 && <b>{detectingNodeIds.length} detecting</b>}</div>}
            {/* A mesh can hear a drone and still not be able to say where it
                is — and that is a different, weaker claim than a fix. Said in
                words because the honest picture for it is not a marker. */}
            {view.estimate && view.estimate.nReports > 0 && !view.estimate.localised && (
              <div className={styles.fixStatus}>
                <span>{view.estimate.nReports} detecting · no fix</span>
                <em>{view.estimate.edgePinned
                  ? "bearing only — the source is outside the area this array can solve over"
                  : "the levels are consistent with more than one position"}</em>
              </div>
            )}
            {alertStatusText && <div className={styles.alertStatus} data-phase={sim.running ? "routing" : "delivered"}><span>{alertStatusText}</span></div>}
          </section>
          <section className={styles.activitySection}>
            <div className={styles.activityHeading}>
              <h3>Contact log</h3>
            </div>
            {visibleEvents.length === 0
              ? <p className={styles.emptyState}>Nothing heard yet. Draw an attack route and launch it.</p>
              : <ul className={styles.activityList}>{visibleEvents.map((event) => (
                  <li key={event.id} data-tone={KIND_TONE[event.kind]}>
                    <i />
                    <time>{event.time}</time>
                    <span>{event.node && <b className={styles.logNode}>{event.node}</b>}{event.message}{event.detail && <em className={styles.logDetail}>{event.detail}</em>}</span>
                  </li>
                ))}</ul>}
          </section>
          {selectedNode ? <>
            <section className={styles.panelSection}>
              <div className={styles.panelHeading}><div><h2>{selectedNode.name}</h2><p className={styles.nodeId}>{selectedNode.id}</p></div><ActionButton className={styles.closeButton} onClick={() => setSelectedNodeId(null)} type="button" aria-label="Close inspector">×</ActionButton></div>
              <span className={styles.statusBadge} data-status={selectedNode.status}>{selectedNode.status}</span>
              <dl className={styles.infoGrid}>
                <div><dt>Confidence</dt><dd>{sim.snapshot.timeMs > 0 ? `${Math.round((simNodes.get(selectedNode.id)?.p ?? 0) * 100)}%` : "—"}</dd></div>
                <div><dt>Records held</dt><dd>{simNodes.get(selectedNode.id)?.records ?? 0}</dd></div>
                <div><dt>Contacts known</dt><dd>{simNodes.get(selectedNode.id)?.contacts.length ?? 0}</dd></div>
                <div><dt>Links</dt><dd>{selectedConnections.length}</dd></div>
              </dl>
              {/* The one control that makes divergence visible: redraw the map
                  from this node's replica instead of the operator's union. */}
              <ActionButton className={viewpoint === selectedNode.id ? styles.viewpointActive : styles.actionButton} onClick={() => setViewpoint(viewpoint === selectedNode.id ? null : selectedNode.id)} type="button">
                {viewpoint === selectedNode.id ? "Showing this node's view — back to operator" : "See what this node sees"}
              </ActionButton>
            </section>
            <section className={styles.panelSection}>
              <h3>Links ({selectedConnections.length})</h3>
              {selectedConnections.length ? <ul className={styles.connectionList}>{selectedConnections.map((connection) => {
                const otherId = connection.sourceId === selectedNode.id ? connection.targetId : connection.sourceId;
                const otherNode = nodes.find((node) => node.id === otherId);
                const span = otherNode ? Math.round(distanceM(selectedNode.lat, selectedNode.lon, otherNode.lat, otherNode.lon)) : null;
                return <li className={styles.connectionItem} key={connection.id}>
                  <span>{otherNode?.name ?? otherId}</span>
                  {/* Out-of-range links are legal — the operator may have drawn them
                      deliberately — but they should say so rather than look normal. */}
                  <span className={styles.connectionStatus} data-status={span !== null && span > MAX_LINK_DISTANCE_M ? "degraded" : connection.status}>{span === null ? connection.status : `${span} m`}</span>
                  <ActionButton className={styles.unlinkButton} onClick={() => toggleLink(selectedNode.id, otherId)} type="button" aria-label={`Unlink ${otherNode?.name ?? otherId}`}>unlink</ActionButton>
                </li>;
              })}</ul> : <p className={styles.emptyState}>No links. Use “Link nodes”, or drag this sensor near another.</p>}
              <ActionButton className={styles.removeButton} onClick={() => removeNode(selectedNode.id)} type="button">Remove sensor</ActionButton>
            </section>
          </> : <section className={styles.panelSection}><h2>Select a node</h2><p className={styles.emptyState}>Click a sensor on the map to inspect its health and connections.</p></section>}
        </aside>
      </div>
    </main>
    </>
  );
}