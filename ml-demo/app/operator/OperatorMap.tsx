"use client";

import { useMemo, useState } from "react";
import { Circle, CircleMarker, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import type { LeafletMouseEvent } from "leaflet";
import { initialNetwork } from "./mockData";
import type { NodeConnection, OperatorNode } from "./types";
import styles from "./operator.module.css";

type MapMode = "idle" | "placing" | "connecting" | "impact";
type EventTone = "info" | "warning" | "critical" | "success";
type ActivityEvent = { id: number; time: string; message: string; tone: EventTone };
type ImpactState = { lat: number; lon: number; radiusM: number; affectedIds: string[] } | null;
type PlacementCandidate = { lat: number; lon: number; distances: { node: OperatorNode; distanceM: number }[] } | null;
const MAP_CENTER: [number, number] = [38.9012, -77.0402];
const DEMO_IMPACT_RADIUS_M = 105;
export const MIN_NODE_DISTANCE_M = 100;
export const MAX_LINK_DISTANCE_M = 150;
export const MIN_CONNECTIONS = 2;

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

function PlacementPreview({ candidate, status }: { candidate: PlacementCandidate; status: "invalid" | "warning" | "valid" }) {
  if (!candidate) return null;
  const color = placementColor(status);
  return <>
    <Circle center={[candidate.lat, candidate.lon]} radius={MIN_NODE_DISTANCE_M} pathOptions={{ className: styles.mapDecoration, color, fillColor: color, fillOpacity: .08, weight: 1, dashArray: "4 6" }} />
    <CircleMarker center={[candidate.lat, candidate.lon]} radius={9} pathOptions={{ className: styles.mapDecoration, color, fillColor: color, fillOpacity: .25, weight: 2, dashArray: "5 5" }} />
    {candidate.distances.filter(({ distanceM }) => distanceM <= MAX_LINK_DISTANCE_M * 1.35).map(({ node, distanceM }) => <Polyline key={node.id} positions={[[candidate.lat, candidate.lon], [node.lat, node.lon]]} pathOptions={{ className: styles.mapDecoration, color: distanceM <= MAX_LINK_DISTANCE_M ? color : "#65778a", dashArray: "3 6", opacity: .65, weight: 1 }} />)}
  </>;
}

export default function OperatorMap() {
  const [nodes, setNodes] = useState<OperatorNode[]>(initialNetwork.nodes);
  const [connections, setConnections] = useState<NodeConnection[]>(initialNetwork.connections);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialNetwork.nodes[0]?.id ?? null);
  const [mode, setMode] = useState<MapMode>("idle");
  const [heartbeatState, setHeartbeatState] = useState<"idle" | "checking" | "ok" | "failed">("idle");
  const [impact, setImpact] = useState<ImpactState>(null);
  const [activeDroneCount, setActiveDroneCount] = useState(0);
  const [interferenceActive, setInterferenceActive] = useState(false);
  const [placementCandidate, setPlacementCandidate] = useState<PlacementCandidate>(null);
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

  function addEvent(message: string, tone: EventTone = "info") {
    setEvents((current) => [{ id: Date.now(), time: eventTime(), message, tone }, ...current].slice(0, 6));
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
    setActiveDroneCount((current) => current + 1);
    addEvent("Simulated drone track entered the area", "warning");
  }

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
          {mode !== "idle" && <div className={styles.mapHint}>{mode === "placing" ? placementCandidate ? <><strong>{placementStatus === "invalid" ? `${Math.round(placementCandidate.distances[0]?.distanceM ?? 0)} m — too close` : placementStatus === "warning" ? `${eligiblePlacementNodes.length}/${MIN_CONNECTIONS} required neighbors` : `Valid placement — ${eligiblePlacementNodes.length} available links`}</strong><span className={styles.placementDistances}>{placementCandidate.distances.slice(0, 3).map(({ node, distanceM }) => `${node.name}: ${Math.round(distanceM)} m`).join(" · ")}</span></> : "Move across the map to preview placement constraints." : mode === "impact" ? "Click anywhere on the map to run a visual impact simulation." : "Select a second node to create a connection."}</div>}
          <MapContainer center={MAP_CENTER} zoom={15} className={styles.map}>
            <TileLayer className={styles.mapTiles} attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapClickHandler onMapClick={handleMapClick} onMapMove={handleMapMove} />
            {impact && <Circle center={[impact.lat, impact.lon]} radius={impact.radiusM} pathOptions={{ className: styles.impactPulse, color: "#f07b62", fillColor: "#f07b62", fillOpacity: .12, weight: 2, dashArray: "7 8" }} />}
            {connections.map((connection) => { const points = connectionPoints(connection, nodes); return points ? <Polyline key={connection.id} positions={points} pathOptions={{ className: styles.mapDecoration, color: connection.status === "degraded" ? "#e3a93b" : "#4bc4ff", dashArray: connection.status === "degraded" ? "6 8" : undefined, opacity: .72, weight: 2 }} /> : null; })}
            {nodes.map((node) => { const selected = node.id === selectedNodeId; const affected = impact?.affectedIds.includes(node.id); const color = affected ? "#f07b62" : nodeColor(node, selected); return <Circle key={`${node.id}-accuracy`} center={[node.lat, node.lon]} radius={node.gpsAccuracyM} pathOptions={{ className: styles.mapDecoration, color, opacity: selected ? .55 : .35, fillOpacity: selected ? .11 : .05, weight: selected ? 2 : 1 }} />; })}
            <Pane name="nodeMarkers" style={{ zIndex: 650 }}>
              {nodes.map((node) => { const selected = node.id === selectedNodeId; const affected = impact?.affectedIds.includes(node.id); const color = affected ? "#f07b62" : nodeColor(node, selected); return <CircleMarker key={node.id} center={[node.lat, node.lon]} radius={selected ? 10 : 7} pathOptions={{ className: affected ? styles.nodeAffected : node.status === "online" && !selected ? styles.nodePulse : selected ? styles.nodeSelected : undefined, color, fillColor: color, fillOpacity: .9, weight: selected ? 4 : 3 }} eventHandlers={{ click: () => selectNode(node.id) }}><Tooltip direction="top" offset={[0, -8]}>{node.name}{affected ? " · affected" : ""}</Tooltip></CircleMarker>; })}
            </Pane>
            <PlacementPreview candidate={placementCandidate} status={placementStatus} />
          </MapContainer>
        </section>
        <aside className={styles.panel} aria-label="Node inspector">
          <section className={styles.scenarioSection} aria-label="Scenario controls">
            <div className={styles.scenarioHeader}><div><p className={styles.sectionKicker}>Demo layer</p><h2>Scenario Controls</h2></div><span className={styles.threatBadge} data-level={impact || interferenceActive ? "elevated" : "nominal"}>{impact || interferenceActive ? "Elevated" : "Nominal"}</span></div>
            <div className={styles.scenarioGrid}>
              <button className={styles.scenarioButton} onClick={simulateDrone} type="button"><span>◈</span>Simulate Drone</button>
              <button className={mode === "impact" ? styles.scenarioButtonActive : styles.scenarioButton} onClick={simulateImpact} type="button"><span>◌</span>{mode === "impact" ? "Cancel Impact" : "Simulate Impact"}</button>
              <button className={styles.scenarioButton} onClick={disableRandomNode} type="button"><span>−</span>Disable Random Node</button>
              <button className={styles.scenarioButton} onClick={addSensorNode} type="button"><span>＋</span>Add Sensor Node</button>
              <button className={interferenceActive ? styles.scenarioButtonActive : styles.scenarioButton} onClick={simulateInterference} type="button"><span>≋</span>Simulate Interference</button>
              <button className={styles.scenarioButton} onClick={replayScenario} type="button"><span>↻</span>Replay Scenario</button>
            </div>
            <div className={styles.metricStrip}><div><strong>{activeNodes.length}</strong><span>active nodes</span></div><div><strong>{activeDroneCount}</strong><span>simulated drones</span></div><div><strong>{networkHealth}%</strong><span>network health</span></div></div>
            <div className={styles.connectionHealth}><span>Network connectivity</span><strong data-connected={networkConnected}>{networkConnected ? "Connected" : "Partitioned"}</strong></div>
          </section>
          <section className={styles.activitySection}><div className={styles.activityHeading}><h3>Activity Log</h3><span>{events.length} events</span></div><ul className={styles.activityList}>{events.map((event) => <li key={event.id} data-tone={event.tone}><i /><time>{event.time}</time><span>{event.message}</span></li>)}</ul></section>
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