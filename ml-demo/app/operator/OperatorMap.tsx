"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, CircleMarker, MapContainer, Marker, Pane, Polyline, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import { divIcon, type LeafletMouseEvent } from "leaflet";
import { commandPost, initialNetwork } from "./mockData";
import type { NodeConnection, OperatorNode } from "./types";
import styles from "./operator.module.css";

type MapMode = "idle" | "placing" | "connecting" | "impact" | "droneStart" | "droneDestination";
type DronePhase = "idle" | "placingStart" | "placingDestination" | "ready" | "flying" | "complete";
type AlertRoute = { path: string[]; phase: "routing" | "delivered" | "lost"; reachedIndex: number; activeEdge: string | null } | null;
type EventTone = "info" | "warning" | "critical" | "success";
type ActivityEvent = { id: number; time: string; message: string; tone: EventTone };
type ImpactState = { lat: number; lon: number; radiusM: number; affectedIds: string[] } | null;
type PlacementCandidate = { lat: number; lon: number; distances: { node: OperatorNode; distanceM: number }[] } | null;
const MAP_CENTER: [number, number] = [38.9012, -77.0402];
const DEMO_IMPACT_RADIUS_M = 105;
export const MIN_NODE_DISTANCE_M = 100;
export const MAX_LINK_DISTANCE_M = 150;
export const MIN_CONNECTIONS = 2;
export const DRONE_DETECTION_RADIUS_M = 140;
const FLIGHT_DURATION_MS = 7_000;
const COMMAND_POST_LINK_PREFIX = "command-post-link";

function MapClickHandler({ onMapClick, onMapMove }: { onMapClick: (event: LeafletMouseEvent) => void; onMapMove: (event: LeafletMouseEvent) => void }) {
  useMapEvents({ click: onMapClick, mousemove: onMapMove });
  return null;
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

function distanceM(firstLat: number, firstLon: number, secondLat: number, secondLon: number): number {
  const latScale = 111_320;
  const lonScale = latScale * Math.cos((firstLat * Math.PI) / 180);
  return Math.hypot((firstLat - secondLat) * latScale, (firstLon - secondLon) * lonScale);
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

function interpolatePosition(start: [number, number], destination: [number, number], progress: number): [number, number] {
  return [start[0] + (destination[0] - start[0]) * progress, start[1] + (destination[1] - start[1]) * progress];
}

function routeEdgeKey(sourceId: string, targetId: string): string {
  return `${sourceId}->${targetId}`;
}

function findAlertPath(sourceId: string, nodes: OperatorNode[], connections: NodeConnection[]): string[] | null {
  const activeIds = new Set(nodes.filter((node) => node.status !== "offline").map((node) => node.id));
  if (!activeIds.has(sourceId)) return null;
  const adjacency = new Map<string, string[]>();
  activeIds.forEach((id) => adjacency.set(id, []));
  connections.forEach((connection) => {
    if (!activeIds.has(connection.sourceId) || !activeIds.has(connection.targetId)) return;
    adjacency.get(connection.sourceId)?.push(connection.targetId);
    adjacency.get(connection.targetId)?.push(connection.sourceId);
  });
  commandPost.gatewayNodeIds.forEach((gatewayId) => {
    if (!activeIds.has(gatewayId)) return;
    adjacency.get(gatewayId)?.push(commandPost.id);
    adjacency.set(commandPost.id, [...(adjacency.get(commandPost.id) ?? []), gatewayId]);
  });
  const queue = [sourceId];
  const previous = new Map<string, string | null>([[sourceId, null]]);
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    if (current === commandPost.id) break;
    adjacency.get(current)?.forEach((neighbor) => {
      if (previous.has(neighbor)) return;
      previous.set(neighbor, current);
      queue.push(neighbor);
    });
  }
  if (!previous.has(commandPost.id)) return null;
  const path: string[] = [];
  let current: string | null = commandPost.id;
  while (current) {
    path.unshift(current);
    current = previous.get(current) ?? null;
  }
  return path;
}

function locationForId(id: string, nodes: OperatorNode[]): [number, number] | null {
  if (id === commandPost.id) return [commandPost.lat, commandPost.lon];
  const node = nodes.find((candidate) => candidate.id === id);
  return node ? [node.lat, node.lon] : null;
}

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
  const destinationIcon = useMemo(() => divIcon({ className: styles.destinationMarker, html: `<span class="${styles.destinationGlyph}"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] }), []);
  const commandPostIcon = useMemo(() => divIcon({ className: styles.commandPostMarker, html: `<span class="${styles.commandPostGlyph}">⌂</span>`, iconSize: [38, 38], iconAnchor: [19, 19] }), []);
  const [nodes, setNodes] = useState<OperatorNode[]>(initialNetwork.nodes);
  const [connections, setConnections] = useState<NodeConnection[]>(initialNetwork.connections);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialNetwork.nodes[0]?.id ?? null);
  const [mode, setMode] = useState<MapMode>("idle");
  const [heartbeatState, setHeartbeatState] = useState<"idle" | "checking" | "ok" | "failed">("idle");
  const [impact, setImpact] = useState<ImpactState>(null);
  const [activeDroneCount, setActiveDroneCount] = useState(0);
  const [interferenceActive, setInterferenceActive] = useState(false);
  const [placementCandidate, setPlacementCandidate] = useState<PlacementCandidate>(null);
  const [dronePhase, setDronePhase] = useState<DronePhase>("idle");
  const [droneStart, setDroneStart] = useState<[number, number] | null>(null);
  const [droneDestination, setDroneDestination] = useState<[number, number] | null>(null);
  const [dronePosition, setDronePosition] = useState<[number, number] | null>(null);
  const [detectingNodeIds, setDetectingNodeIds] = useState<string[]>([]);
  const flightFrameRef = useRef<number | null>(null);
  const detectedNodeIdsRef = useRef<Set<string>>(new Set());
  const loggedDetectionNodeIdsRef = useRef<Set<string>>(new Set());
  const alertTimerRef = useRef<number | null>(null);
  const alertRouteRef = useRef<AlertRoute>(null);
  const [alertRoute, setAlertRoute] = useState<AlertRoute>(null);
  alertRouteRef.current = alertRoute;
  const [events, setEvents] = useState<ActivityEvent[]>([
    { id: 1, time: eventTime(), message: "Demo network initialized", tone: "info" },
  ]);
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
  const eligiblePlacementNodes = placementCandidate?.distances.filter(({ distanceM }) => distanceM <= MAX_LINK_DISTANCE_M) ?? [];
  const droneStatusText = dronePhase === "flying" ? (detectingNodeIds.length ? `DETECTED BY ${detectingNodeIds.length} NODES` : "IN FLIGHT") : dronePhase === "complete" ? "FLIGHT COMPLETE" : dronePhase === "ready" ? "READY TO FLY" : "DRONE ACTIVE";
  const alertStatusText = alertRoute?.phase === "routing" ? `Relaying alert... Hop ${alertRoute.reachedIndex} of ${alertRoute.path.length - 1}` : alertRoute?.phase === "delivered" ? `Alert delivered to Command Post — ${alertRoute.path.length - 1} hops` : alertRoute?.phase === "lost" ? "NETWORK PATH LOST" : null;
  const alertReachedIds = new Set(alertRoute?.path.slice(0, (alertRoute?.reachedIndex ?? -1) + 1) ?? []);
  const visibleEvents = useMemo(() => {
    const seenDetections = new Set<string>();
    return events.filter((event) => {
      if (!event.message.includes("detected simulated drone")) return true;
      if (seenDetections.has(event.message)) return false;
      seenDetections.add(event.message);
      return true;
    });
  }, [events]);

  function addEvent(message: string, tone: EventTone = "info") {
    setEvents((current) => {
      if (message.includes("detected simulated drone") && current.some((event) => event.message === message)) return current;
      return [{ id: Date.now(), time: eventTime(), message, tone }, ...current].slice(0, 6);
    });
  }

  function selectNode(nodeId: string) {
    if (mode === "connecting" && selectedNodeId && selectedNodeId !== nodeId) {
      const alreadyConnected = connections.some((connection) => (connection.sourceId === selectedNodeId && connection.targetId === nodeId) || (connection.sourceId === nodeId && connection.targetId === selectedNodeId));
      if (!alreadyConnected) {
        setConnections((current) => [...current, { id: `link-${selectedNodeId}-${nodeId}`, sourceId: selectedNodeId, targetId: nodeId, status: "active" }]);
      }
      setMode("idle");
      setSelectedNodeId(nodeId);
      return;
    }
    setSelectedNodeId(nodeId);
  }

  function handleMapClick(event: LeafletMouseEvent) {
    if (mode === "droneStart") {
      const point: [number, number] = [event.latlng.lat, event.latlng.lng];
      setDroneStart(point);
      setDronePosition(point);
      setDroneDestination(null);
      setDronePhase("placingDestination");
      setMode("droneDestination");
      addEvent("Drone starting position placed", "info");
      return;
    }
    if (mode === "droneDestination") {
      const point: [number, number] = [event.latlng.lat, event.latlng.lng];
      setDroneDestination(point);
      setDronePhase("ready");
      setMode("idle");
      addEvent("Drone destination selected — ready for flight", "info");
      return;
    }
    if (mode === "impact") {
      const affectedIds = nodes.filter((node) => distanceM(event.latlng.lat, event.latlng.lng, node.lat, node.lon) <= DEMO_IMPACT_RADIUS_M).map((node) => node.id);
      setImpact({ lat: event.latlng.lat, lon: event.latlng.lng, radiusM: DEMO_IMPACT_RADIUS_M, affectedIds });
      setNodes((current) => current.map((node) => affectedIds.includes(node.id) ? { ...node, status: "offline", lastSeen: "just now" } : node));
      setMode("idle");
      setSelectedNodeId(null);
      addEvent(`${affectedIds.length} node${affectedIds.length === 1 ? "" : "s"} affected by simulated impact`, affectedIds.length ? "critical" : "success");
      window.setTimeout(() => {
        setNodes((current) => current.map((node) => affectedIds.includes(node.id) ? { ...node, status: "online", lastSeen: "just now" } : node));
        setImpact(null);
        addEvent("Affected nodes restored to service", "success");
      }, 8_000);
      return;
    }
    if (mode !== "placing") return;
    const candidate = buildPlacementCandidate(event.latlng.lat, event.latlng.lng, nodes);
    if (!candidate) return;
    const candidateStatus = getPlacementStatus(candidate);
    const candidateNeighbors = candidate.distances.filter(({ distanceM }) => distanceM <= MAX_LINK_DISTANCE_M);
    setPlacementCandidate(candidate);
    if (candidateStatus === "invalid") {
      addEvent("Placement rejected — node is too close to an existing sensor", "critical");
      return;
    }
    if (candidateStatus === "warning") {
      addEvent(`Placement rejected — ${candidateNeighbors.length}/${MIN_CONNECTIONS} required neighbors`, "warning");
      return;
    }
    const nodeNumber = nodes.length + 1;
    const newNode: OperatorNode = { id: `node-${nodeNumber}`, name: `Field Node ${nodeNumber}`, lat: event.latlng.lat, lon: event.latlng.lng, status: "online", lastSeen: "just now", loudness: 0, gpsAccuracyM: 5 };
    setNodes((current) => [...current, newNode]);
    setConnections((current) => [...current, ...candidateNeighbors.map(({ node }) => ({ id: `link-${newNode.id}-${node.id}`, sourceId: newNode.id, targetId: node.id, status: "active" as const }))]);
    setSelectedNodeId(newNode.id);
    setMode("idle");
    setPlacementCandidate(null);
    addEvent(`${newNode.name} added to the network`, "success");
  }

  function handleMapMove(event: LeafletMouseEvent) {
    if (mode !== "placing") return;
    setPlacementCandidate(buildPlacementCandidate(event.latlng.lat, event.latlng.lng, nodes));
  }

  function heartbeatCheck() {
    if (!selectedNode) return;
    setHeartbeatState("checking");
    window.setTimeout(() => setHeartbeatState(selectedNode.status === "offline" ? "failed" : "ok"), 650);
  }

  function simulateDrone() {
    resetDrone();
    setActiveDroneCount(1);
    setDronePhase("placingStart");
    setMode("droneStart");
    addEvent("Select drone starting position", "info");
  }

  function resetDrone() {
    if (flightFrameRef.current !== null) window.cancelAnimationFrame(flightFrameRef.current);
    if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
    flightFrameRef.current = null;
    alertTimerRef.current = null;
    alertRouteRef.current = null;
    setAlertRoute(null);
    setDronePhase("idle");
    setDroneStart(null);
    setDroneDestination(null);
    setDronePosition(null);
    setDetectingNodeIds([]);
    detectedNodeIdsRef.current.clear();
    loggedDetectionNodeIdsRef.current.clear();
    setActiveDroneCount(0);
    if (mode === "droneStart" || mode === "droneDestination") setMode("idle");
  }

  function updateDroneDetections(position: [number, number]) {
    const nearbyIds = activeNodes.filter((node) => distanceM(position[0], position[1], node.lat, node.lon) <= DRONE_DETECTION_RADIUS_M).map((node) => node.id);
    setDetectingNodeIds(nearbyIds);
    nearbyIds.forEach((nodeId) => {
      if (detectedNodeIdsRef.current.has(nodeId)) return;
      detectedNodeIdsRef.current.add(nodeId);
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (node && !loggedDetectionNodeIdsRef.current.has(nodeId)) {
        loggedDetectionNodeIdsRef.current.add(nodeId);
        addEvent(`${node.name} detected simulated drone`, "warning");
        if (!alertRouteRef.current || alertRouteRef.current.phase !== "routing") beginAlertRoute(nodeId);
      }
    });
  }

  function beginAlertRoute(sourceId: string) {
    if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
    const path = findAlertPath(sourceId, nodes, connections);
    if (!path) {
      const lostRoute = { path: [sourceId], phase: "lost" as const, reachedIndex: 0, activeEdge: null };
      alertRouteRef.current = lostRoute;
      setAlertRoute(lostRoute);
      addEvent("NETWORK PATH LOST", "critical");
      return;
    }
    const initialRoute = { path, phase: "routing" as const, reachedIndex: 0, activeEdge: null };
    alertRouteRef.current = initialRoute;
    setAlertRoute(initialRoute);
    const advance = (reachedIndex: number) => {
      if (reachedIndex >= path.length - 1) {
        const deliveredRoute = { path, phase: "delivered" as const, reachedIndex, activeEdge: null };
        alertRouteRef.current = deliveredRoute;
        setAlertRoute(deliveredRoute);
        addEvent(`Alert delivered to Command Post — ${path.length - 1} hops`, "success");
        return;
      }
      const nextIndex = reachedIndex + 1;
      const nextRoute = { path, phase: "routing" as const, reachedIndex: nextIndex, activeEdge: routeEdgeKey(path[reachedIndex], path[nextIndex]) };
      alertRouteRef.current = nextRoute;
      setAlertRoute(nextRoute);
      if (path[nextIndex] !== commandPost.id) {
        const relay = nodes.find((node) => node.id === path[nextIndex]);
        if (relay) addEvent(`Routing alert through ${relay.name}`, "info");
      }
      alertTimerRef.current = window.setTimeout(() => advance(nextIndex), 850);
    };
    alertTimerRef.current = window.setTimeout(() => advance(0), 450);
  }

  function startFlight() {
    if (!droneStart || !droneDestination || dronePhase === "flying") return;
    const startedAt = performance.now();
    detectedNodeIdsRef.current.clear();
    loggedDetectionNodeIdsRef.current.clear();
    setAlertRoute(null);
    alertRouteRef.current = null;
    setDetectingNodeIds([]);
    setDronePhase("flying");
    addEvent("Simulated drone flight started", "warning");
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / FLIGHT_DURATION_MS);
      const position = interpolatePosition(droneStart, droneDestination, progress);
      setDronePosition(position);
      updateDroneDetections(position);
      if (progress < 1) {
        flightFrameRef.current = window.requestAnimationFrame(tick);
      } else {
        flightFrameRef.current = null;
        setDronePhase("complete");
        addEvent("Simulated drone flight complete", "success");
      }
    };
    flightFrameRef.current = window.requestAnimationFrame(tick);
  }

  function handleDestinationDrag(event: { target: { getLatLng(): { lat: number; lng: number } } }) {
    if (dronePhase === "flying" || !droneStart) return;
    const nextDestination = event.target.getLatLng();
    const point: [number, number] = [nextDestination.lat, nextDestination.lng];
    setDroneDestination(point);
    setDronePosition(droneStart);
    setDronePhase("ready");
  }

  useEffect(() => () => {
    if (flightFrameRef.current !== null) window.cancelAnimationFrame(flightFrameRef.current);
    if (alertTimerRef.current !== null) window.clearTimeout(alertTimerRef.current);
  }, []);

  function simulateImpact() {
    setMode((current) => current === "impact" ? "idle" : "impact");
    setSelectedNodeId(null);
    addEvent(mode === "impact" ? "Impact placement cancelled" : "Impact placement armed", "warning");
  }

  function disableRandomNode() {
    const candidates = nodes.filter((node) => node.status !== "offline");
    if (!candidates.length) return;
    const node = candidates[Math.floor(Math.random() * candidates.length)];
    setNodes((current) => current.map((item) => item.id === node.id ? { ...item, status: "offline", lastSeen: "just now" } : item));
    addEvent(`${node.name} temporarily disabled`, "critical");
    window.setTimeout(() => {
      setNodes((current) => current.map((item) => item.id === node.id ? { ...item, status: "online", lastSeen: "just now" } : item));
      addEvent(`${node.name} returned to service`, "success");
    }, 6_000);
  }

  function addSensorNode() {
    setMode("placing");
    setSelectedNodeId(null);
    setPlacementCandidate(null);
    addEvent("Sensor placement armed", "info");
  }

  function togglePlacementMode() {
    if (mode === "placing") {
      setMode("idle");
      setPlacementCandidate(null);
      return;
    }
    addSensorNode();
  }

  function simulateInterference() {
    setInterferenceActive((current) => !current);
    addEvent(interferenceActive ? "Simulated interference cleared" : "Simulated interference detected", interferenceActive ? "success" : "warning");
  }

  function replayScenario() {
    setActiveDroneCount((current) => Math.max(current, 1));
    setInterferenceActive(true);
    addEvent("Replay started: drone and interference sequence", "warning");
    window.setTimeout(() => {
      setInterferenceActive(false);
      addEvent("Replay sequence complete", "success");
    }, 5_000);
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>SkyMesh / Operator</p><h1 className={styles.title}>Sensor network</h1></div>
        <div className={styles.headerStats}><div className={styles.networkStatus}><span className={styles.statusDot} /> Mock network online</div><div className={styles.stat}><strong>{activeNodes.length}</strong> active</div><div className={styles.stat}><strong>{activeDroneCount}</strong> drones</div><div className={styles.stat}><strong>{networkHealth}%</strong> health</div></div>
      </header>
      <div className={styles.workspace}>
        <section className={styles.mapArea} aria-label="Interactive sensor map">
          <div className={styles.toolbar}>
            <button className={mode === "placing" ? styles.buttonActive : styles.button} onClick={togglePlacementMode} type="button">{mode === "placing" ? "Cancel placement" : "Place node"}</button>
            <button className={mode === "connecting" ? styles.buttonActive : styles.button} onClick={() => setMode(mode === "connecting" ? "idle" : "connecting")} type="button">{mode === "connecting" ? "Cancel connection" : "Connect nodes"}</button>
          </div>
          {mode !== "idle" && <div className={styles.mapHint}>{mode === "placing" ? placementCandidate ? <><strong>{placementStatus === "invalid" ? `${Math.round(placementCandidate.distances[0]?.distanceM ?? 0)} m — too close` : placementStatus === "warning" ? `${eligiblePlacementNodes.length}/${MIN_CONNECTIONS} required neighbors` : `Valid placement — ${eligiblePlacementNodes.length} available links`}</strong><span className={styles.placementDistances}>{placementCandidate.distances.slice(0, 3).map(({ node, distanceM }) => `${node.name}: ${Math.round(distanceM)} m`).join(" · ")}</span></> : "Move across the map to preview placement constraints." : mode === "impact" ? "Click anywhere on the map to run a visual impact simulation." : mode === "droneStart" ? "Select drone starting position" : mode === "droneDestination" ? "Select drone destination" : "Select a second node to create a connection."}</div>}
          <MapContainer center={MAP_CENTER} zoom={15} className={styles.map}>
            <TileLayer className={styles.mapTiles} attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapClickHandler onMapClick={handleMapClick} onMapMove={handleMapMove} />
            {impact && <Circle center={[impact.lat, impact.lon]} radius={impact.radiusM} pathOptions={{ className: styles.impactPulse, color: "#f07b62", fillColor: "#f07b62", fillOpacity: .12, weight: 2, dashArray: "7 8" }} />}
            {connections.map((connection) => { const points = connectionPoints(connection, nodes); return points ? <Polyline key={connection.id} positions={points} pathOptions={{ className: styles.mapDecoration, color: connection.status === "degraded" ? "#e3a93b" : "#4bc4ff", dashArray: connection.status === "degraded" ? "6 8" : undefined, opacity: .72, weight: 2 }} /> : null; })}
            {commandPost.gatewayNodeIds.map((gatewayId) => { const gateway = nodes.find((node) => node.id === gatewayId); const points = gateway ? [[gateway.lat, gateway.lon], [commandPost.lat, commandPost.lon]] as [number, number][] : null; return points ? <Polyline key={`${COMMAND_POST_LINK_PREFIX}-${gatewayId}`} positions={points} pathOptions={{ className: styles.mapDecoration, color: alertRoute?.activeEdge === routeEdgeKey(gatewayId, commandPost.id) ? "#ffd166" : "#8d78d8", dashArray: "5 6", opacity: .8, weight: alertRoute?.activeEdge === routeEdgeKey(gatewayId, commandPost.id) ? 4 : 2 }} /> : null; })}
            {alertRoute?.path.slice(0, -1).map((id, index) => { const nextId = alertRoute.path[index + 1]; const source = locationForId(id, nodes); const target = locationForId(nextId, nodes); if (!source || !target) return null; const active = alertRoute.activeEdge === routeEdgeKey(id, nextId); return <Polyline key={`alert-${id}-${nextId}`} positions={[source, target]} pathOptions={{ className: styles.alertRouteLine, color: active ? "#ffd166" : "#f4c95d", opacity: active ? 1 : .18, weight: active ? 5 : 2 }} />; })}
            {nodes.map((node) => { const selected = node.id === selectedNodeId; const detecting = detectingNodeIds.includes(node.id); const routeIndex = alertRoute?.path.indexOf(node.id) ?? -1; const relaying = routeIndex > 0 && alertReachedIds.has(node.id); const affected = impact?.affectedIds.includes(node.id); const color = affected ? "#f07b62" : relaying ? "#b9a3ff" : detecting ? "#ffd166" : nodeColor(node, selected); return <Circle key={`${node.id}-accuracy`} center={[node.lat, node.lon]} radius={node.gpsAccuracyM} pathOptions={{ className: styles.mapDecoration, color, opacity: selected ? .55 : .35, fillOpacity: selected ? .11 : .05, weight: selected ? 2 : 1 }} />; })}
            <Pane name="nodeMarkers" style={{ zIndex: 650 }}>
              {nodes.map((node) => { const selected = node.id === selectedNodeId; const detecting = detectingNodeIds.includes(node.id); const routeIndex = alertRoute?.path.indexOf(node.id) ?? -1; const relaying = routeIndex > 0 && alertReachedIds.has(node.id); const affected = impact?.affectedIds.includes(node.id); const color = affected ? "#f07b62" : relaying ? "#b9a3ff" : detecting ? "#ffd166" : nodeColor(node, selected); return <CircleMarker key={node.id} center={[node.lat, node.lon]} radius={selected ? 10 : relaying || detecting ? 9 : 7} pathOptions={{ className: affected ? styles.nodeAffected : relaying ? styles.nodeRelaying : detecting ? styles.nodeDetecting : node.status === "online" && !selected ? styles.nodePulse : selected ? styles.nodeSelected : undefined, color, fillColor: color, fillOpacity: .9, weight: selected ? 4 : 3 }} eventHandlers={{ click: () => selectNode(node.id) }}><Tooltip direction="top" offset={[0, -8]}>{node.name}{relaying ? " · relaying alert" : detecting ? " · detecting drone" : affected ? " · affected" : ""}</Tooltip></CircleMarker>; })}
            </Pane>
            <PlacementPreview candidate={placementCandidate} status={placementStatus} />
            <Marker position={[commandPost.lat, commandPost.lon]} icon={commandPostIcon} interactive={false}><Tooltip direction="top" offset={[0, -20]}>{commandPost.name}</Tooltip></Marker>
            {droneStart && droneDestination && <Polyline positions={[droneStart, droneDestination]} pathOptions={{ className: styles.flightPath, color: "#f4c95d", dashArray: "8 8", opacity: .85, weight: 2 }} />}
            {droneDestination && <Marker position={droneDestination} icon={destinationIcon} draggable={dronePhase !== "flying"} eventHandlers={{ dragend: handleDestinationDrag }}><Tooltip direction="top" offset={[0, -10]}>Destination</Tooltip></Marker>}
            {dronePosition && <><Circle center={dronePosition} radius={DRONE_DETECTION_RADIUS_M} pathOptions={{ className: styles.mapDecoration, color: "#f4c95d", fillColor: "#f4c95d", fillOpacity: .05, weight: 1, dashArray: "4 7" }} /><Marker position={dronePosition} icon={droneIcon}><Tooltip direction="top" offset={[0, -16]}>Simulated drone</Tooltip></Marker></>}
          </MapContainer>
        </section>
        <aside className={styles.panel} aria-label="Node inspector">
          <section className={styles.scenarioSection} aria-label="Scenario controls">
            <div className={styles.scenarioHeader}><div><p className={styles.sectionKicker}>Demo layer</p><h2>Scenario Controls</h2></div><span className={styles.threatBadge} data-level={impact || interferenceActive ? "elevated" : "nominal"}>{impact || interferenceActive ? "Elevated" : "Nominal"}</span></div>
            <div className={styles.scenarioGrid}>
              <button className={styles.scenarioButton} onClick={dronePhase === "idle" ? simulateDrone : resetDrone} type="button"><span>◈</span>{dronePhase === "idle" ? "Simulate Drone" : "Reset Drone"}</button>
              <button className={mode === "impact" ? styles.scenarioButtonActive : styles.scenarioButton} onClick={simulateImpact} type="button"><span>◌</span>{mode === "impact" ? "Cancel Impact" : "Simulate Impact"}</button>
              <button className={styles.scenarioButton} onClick={disableRandomNode} type="button"><span>−</span>Disable Random Node</button>
              <button className={styles.scenarioButton} onClick={addSensorNode} type="button"><span>＋</span>Add Sensor Node</button>
              <button className={interferenceActive ? styles.scenarioButtonActive : styles.scenarioButton} onClick={simulateInterference} type="button"><span>≋</span>Simulate Interference</button>
              <button className={styles.scenarioButton} onClick={replayScenario} type="button"><span>↻</span>Replay Scenario</button>
            </div>
            <div className={styles.metricStrip}><div><strong>{activeNodes.length}</strong><span>active nodes</span></div><div><strong>{activeDroneCount}</strong><span>simulated drones</span></div><div><strong>{networkHealth}%</strong><span>network health</span></div></div>
            <div className={styles.connectionHealth}><span>Network connectivity</span><strong data-connected={networkConnected}>{networkConnected ? "Connected" : "Partitioned"}</strong></div>
            {dronePhase !== "idle" && <div className={styles.droneStatus}><span>{droneStatusText}</span>{detectingNodeIds.length > 0 && <b>{detectingNodeIds.length} detecting</b>}</div>}
            {alertStatusText && <div className={styles.alertStatus} data-phase={alertRoute?.phase}><span>{alertStatusText}</span>{alertRoute?.phase === "routing" && <b>Command Post</b>}</div>}
            {dronePhase === "ready" && <button className={styles.flightButton} onClick={startFlight} type="button">Start Flight</button>}
            {(dronePhase === "ready" || dronePhase === "complete") && <button className={styles.resetDroneButton} onClick={resetDrone} type="button">Remove drone</button>}
          </section>
          <section className={styles.activitySection}><div className={styles.activityHeading}><h3>Activity Log</h3><span>{visibleEvents.length} events</span></div><ul className={styles.activityList}>{visibleEvents.map((event) => <li key={event.id} data-tone={event.tone}><i /><time>{event.time}</time><span>{event.message}</span></li>)}</ul></section>
          {selectedNode ? <>
            <section className={styles.panelSection}>
              <div className={styles.panelHeading}><div><h2>{selectedNode.name}</h2><p className={styles.nodeId}>{selectedNode.id}</p></div><button className={styles.closeButton} onClick={() => setSelectedNodeId(null)} type="button" aria-label="Close inspector">×</button></div>
              <span className={styles.statusBadge} data-status={selectedNode.status}>{selectedNode.status}</span>
              <dl className={styles.infoGrid}><div><dt>Last heartbeat</dt><dd>{selectedNode.lastSeen}</dd></div><div><dt>GPS accuracy</dt><dd>±{selectedNode.gpsAccuracyM} m</dd></div><div><dt>Signal level</dt><dd>{Math.round(selectedNode.loudness * 100)}%</dd></div><div><dt>Coordinates</dt><dd>{selectedNode.lat.toFixed(4)}, {selectedNode.lon.toFixed(4)}</dd></div></dl>
              <button className={styles.actionButton} onClick={heartbeatCheck} disabled={heartbeatState === "checking"} type="button">{heartbeatState === "checking" ? "Checking heartbeat..." : heartbeatState === "ok" ? "Heartbeat OK" : heartbeatState === "failed" ? "Heartbeat failed" : "Run heartbeat check"}</button>
            </section>
            <section className={styles.panelSection}><h3>Connections ({selectedConnections.length})</h3>{selectedConnections.length ? <ul className={styles.connectionList}>{selectedConnections.map((connection) => { const otherId = connection.sourceId === selectedNode.id ? connection.targetId : connection.sourceId; const otherNode = nodes.find((node) => node.id === otherId); return <li className={styles.connectionItem} key={connection.id}><span>{otherNode?.name ?? otherId}</span><span className={styles.connectionStatus} data-status={connection.status}>{connection.status}</span></li>; })}</ul> : <p className={styles.emptyState}>No connections assigned to this node.</p>}</section>
          </> : <section className={styles.panelSection}><h2>Select a node</h2><p className={styles.emptyState}>Click a sensor on the map to inspect its health and connections.</p></section>}
        </aside>
      </div>
    </main>
  );
}