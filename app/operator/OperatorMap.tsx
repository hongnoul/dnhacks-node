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
import { DRONE_SPEED_MPS, pointAlongRoute, routeCoverage, routeLengthM, type Waypoint } from "./attackRoute";
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

  const onSimEvents = (batch: SimEvent[]) => {
    for (const e of batch) {
      if (e.kind === "detect") {
        const n = nodes.find((x) => x.id === e.node);
        if (n) logContact("detection", "acoustic contact", { node: n.name, detail: `acquired ${Math.round(e.travelledM)} m into the run` });
      } else {
        logContact("consensus", `contact held by ${e.count} of ${e.total} node${e.total === 1 ? "" : "s"}`, { detail: `t+${(e.timeMs / 1000).toFixed(1)} s` });
      }
    }
  };
  const sim = useSimulation(nodes, connections, route, onSimEvents);
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
  const hearing = sim.snapshot.nodes.filter((n) => n.detecting).length;
  const droneStatusText = sim.running
    ? hearing
      ? `TRACKED BY ${hearing} NODE${hearing === 1 ? "" : "S"}`
      : "INBOUND — UNOBSERVED"
    : sim.snapshot.done
      ? "RUN COMPLETE"
      : dronePhase === "ready"
        ? `${Math.round(coverage.lengthM)} m route · ${Math.round(coverage.lengthM / DRONE_SPEED_MPS)} s`
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
    const area = areaAround(shownNodes, DRONE_DETECTION_RADIUS_M);
    if (viewpoint) {
      return {
        estimate: estimateFrom(sim.world.freshReadings(viewpoint), positions, area),
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
      estimate: estimateFrom([...union.values()], positions, area),
      contacts: [...union.values()].filter((r) => r.d).map((r) => r.origin).sort(),
      records: Math.max(0, ...shownNodes.map((n) => sim.world.recordCount(n.id))),
    };
    // sim.snapshot is the tick signal: the world mutates in place, so a new
    // snapshot identity is what tells React the replicas moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownNodes, viewpoint, sim.snapshot, sim.world]);

  const detectingNodeIds = view.contacts;

  // Route drawing and sensor placement both need raw map clicks.
  const linksClickable = mode === "idle" || mode === "connecting";

  /** Links carrying a record right now, straight off the in-flight queue. */
  const carryingLinks = useMemo(() => {
    const set = new Set<string>();
    for (const f of sim.snapshot.inFlight) set.add(linkKey(f.from, f.to));
    return set;
  }, [sim.snapshot]);

  const holders = sim.snapshot.nodes.filter((n) => n.contacts.length > 0).length;
  const alertStatusText =
    holders === 0
      ? null
      : `Contact held by ${holders} of ${sim.snapshot.nodes.length} node${sim.snapshot.nodes.length === 1 ? "" : "s"}`;
  // First contact per node per run is deduped at the source (detectedNodeIdsRef),
  // so the log needs no second filter.
  const visibleEvents = events;

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
    sim.reset();
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
    sim.reset();
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
          {tilesUnavailable && <p className={styles.tileNotice} role="status">Basemap unavailable. Placement and simulation still work on the blank map.</p>}
          <div className={styles.toolbar}>
            <ActionButton className={mode === "placing" ? styles.buttonActive : styles.button} onClick={togglePlacementMode} type="button">{mode === "placing" ? "Cancel placement" : "Place node"}</ActionButton>
            <ActionButton className={mode === "connecting" ? styles.buttonActive : styles.button} onClick={toggleLinkMode} type="button">{mode === "connecting" ? "Done linking" : "Link nodes"}</ActionButton>
          </div>
          {mode !== "idle" && <div className={styles.mapHint}>{mode === "placing" ? placementCandidate ? <><strong>{placementStatus === "invalid" ? `${Math.round(placementCandidate.distances[0]?.distanceM ?? 0)} m — too close` : placementStatus === "warning" ? `${eligiblePlacementNodes.length}/${MIN_CONNECTIONS} required neighbors` : `Valid placement — ${eligiblePlacementNodes.length} available links`}</strong><span className={styles.placementDistances}>{placementCandidate.distances.slice(0, 3).map(({ node, distanceM }) => `${node.name}: ${Math.round(distanceM)} m`).join(" · ")}</span></> : "Move across the map to preview placement constraints." : mode === "route" ? (route.length === 0 ? "Click to set the launch point, then click each waypoint along the ingress." : `${route.length} waypoint${route.length === 1 ? "" : "s"} · ${Math.round(coverage.lengthM)} m · ${Math.round(coverage.covered * 100)}% observed — finish when done`) : linkFrom ? `Linking from ${nodes.find((n) => n.id === linkFrom)?.name ?? linkFrom} — click another sensor to link or unlink.` : "Click a sensor, then click another to link or unlink the pair."}</div>}
          <MapContainer center={MAP_CENTER} zoom={15} className={styles.map} zoomControl={false}>
            <TileLayer eventHandlers={{ tileerror: () => setTilesUnavailable(true) }} className={styles.mapTiles} attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapInteractions onMapClick={handleMapClick} onMapMove={handleMapMove} onMapUp={endNodeDrag} mapRef={mapRef} />
            {connections.map((connection) => {
              const points = connectionPoints(connection, shownNodes);
              if (!points) return null;
              // A link is carrying the contact when it joins consecutive hop
              // layers that the ripple has already reached.
              // Lit because a record is physically on this link right now, not
              // because an animation decided it should be.
              const carrying = carryingLinks.has(linkKey(connection.sourceId, connection.targetId));
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
                    <Tooltip sticky>click to remove this link</Tooltip>
                  </Polyline>
                )}
                <Polyline positions={points} interactive={false}
                  pathOptions={{ className: carrying ? styles.alertRouteLine : styles.mapDecoration, color: carrying ? "#ffd166" : connection.status === "degraded" ? "#e3a93b" : "#4bc4ff", dashArray: !carrying && connection.status === "degraded" ? "6 8" : undefined, opacity: carrying ? 1 : .72, weight: carrying ? 4 : 2 }} />
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
                const hearing = !!s?.detecting;
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
                <Tooltip direction="top" offset={[0, -8]}>{i === 0 ? "Launch" : i === route.length - 1 ? "Target" : `Waypoint ${i}`}</Tooltip>
              </CircleMarker>
            ))}
            {dronePosition && <><Circle center={dronePosition} radius={DRONE_DETECTION_RADIUS_M} pathOptions={{ className: styles.mapDecoration, color: "#f4c95d", fillColor: "#f4c95d", fillOpacity: .05, weight: 1, dashArray: "4 7" }} /><Marker position={dronePosition} icon={droneIcon}><Tooltip direction="top" offset={[0, -16]}>Simulated drone</Tooltip></Marker></>}
          </MapContainer>
          {viewpoint && (
            <div className={styles.viewpointBanner}>
              <span>Seeing what <b>{nodes.find((n) => n.id === viewpoint)?.name ?? viewpoint}</b> sees — {view.records} records, {view.contacts.length} contact{view.contacts.length === 1 ? "" : "s"}</span>
              <ActionButton onClick={() => setViewpoint(null)} type="button">operator view</ActionButton>
            </div>
          )}
          {nodes.length === 0 && mode === "idle" && (
            <div className={styles.emptyHint}>
              No sensors. Use <b>Place node</b> above, or <ActionButton className={styles.linkAction} onClick={() => seedRing()} type="button">seed a ring of 5</ActionButton>.
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
              <div className={styles.transport}>
                <ActionButton className={styles.transportPlay} onClick={sim.running ? sim.pause : sim.play} type="button">
                  {sim.running ? "❚❚ Pause" : sim.snapshot.done ? "▶ Replay" : "▶ Run"}
                </ActionButton>
                <div className={styles.transportSpeeds}>
                  {SPEEDS.map((x) => (
                    <ActionButton key={x} className={sim.speed === x ? styles.speedActive : styles.speed} onClick={() => sim.setSpeed(x)} type="button">{x}×</ActionButton>
                  ))}
                </div>
                <ActionButton className={styles.scenarioButton} onClick={sim.reset} type="button"><span>↺</span>Reset</ActionButton>
                <span className={styles.transportClock}>t+{(sim.snapshot.timeMs / 1000).toFixed(1)} s</span>
              </div>
            ) : null}
            <div className={styles.scenarioRow}>
              {mode === "route" && route.length > 0 && <ActionButton className={styles.scenarioButton} onClick={undoWaypoint} type="button"><span>↶</span>Undo</ActionButton>}
              {dronePhase !== "idle" && mode !== "route" && <ActionButton className={styles.scenarioButton} onClick={() => { sim.reset(); setDronePhase("idle"); setRoute([]); }} type="button"><span>×</span>Clear</ActionButton>}
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
            {nodes.length > 0 && <div className={styles.connectionHealth}><span>Network connectivity</span><strong data-connected={networkConnected}>{networkConnected ? "Connected" : "Partitioned"}</strong></div>}
            {dronePhase !== "idle" && <div className={styles.droneStatus}><span>{droneStatusText}</span>{detectingNodeIds.length > 0 && <b>{detectingNodeIds.length} detecting</b>}</div>}
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