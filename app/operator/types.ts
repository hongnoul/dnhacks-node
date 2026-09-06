export type NodeStatus = "online" | "degraded" | "offline";

export interface OperatorNode {
  id: string;
  name: string;
  lat: number;
  lon: number;
  status: NodeStatus;
  /** Epoch ms of the last state change, rendered as a relative age. */
  lastSeen: number;
}

export interface NodeConnection {
  id: string;
  sourceId: string;
  targetId: string;
  status: "active" | "degraded";
}
