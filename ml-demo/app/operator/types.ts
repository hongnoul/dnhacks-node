export type NodeStatus = "online" | "degraded" | "offline";

export interface OperatorNode {
  id: string;
  name: string;
  lat: number;
  lon: number;
  status: NodeStatus;
  lastSeen: string;
  loudness: number;
  gpsAccuracyM: number;
}

export interface NodeConnection {
  id: string;
  sourceId: string;
  targetId: string;
  status: "active" | "degraded";
}

export interface MockNetworkState {
  nodes: OperatorNode[];
  connections: NodeConnection[];
}

export interface CommandPostConfig {
  id: string;
  name: string;
  lat: number;
  lon: number;
  gatewayNodeIds: string[];
}