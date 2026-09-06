import type { CommandPostConfig, MockNetworkState } from "./types";

export const commandPost: CommandPostConfig = {
  id: "command-post",
  name: "Command Post",
  lat: 38.9012,
  lon: -77.0409,
  gatewayNodeIds: ["node-charlie"],
};

export const initialNetwork: MockNetworkState = {
  nodes: [
    { id: "node-alpha", name: "Alpha Ridge", lat: 38.9022, lon: -77.0402, status: "online", lastSeen: "12 sec ago", loudness: 0.42, gpsAccuracyM: 5 },
    { id: "node-bravo", name: "Bravo Park", lat: 38.9002, lon: -77.0402, status: "online", lastSeen: "8 sec ago", loudness: 0.28, gpsAccuracyM: 8 },
    { id: "node-charlie", name: "Charlie South", lat: 38.9012, lon: -77.0387, status: "degraded", lastSeen: "31 sec ago", loudness: 0.67, gpsAccuracyM: 18 },
    { id: "node-delta", name: "Delta West", lat: 38.9012, lon: -77.0417, status: "online", lastSeen: "5 sec ago", loudness: 0.35, gpsAccuracyM: 6 },
  ],
  connections: [
    { id: "link-alpha-bravo", sourceId: "node-alpha", targetId: "node-bravo", status: "active" },
    { id: "link-alpha-delta", sourceId: "node-alpha", targetId: "node-delta", status: "active" },
    { id: "link-bravo-charlie", sourceId: "node-bravo", targetId: "node-charlie", status: "degraded" },
  ],
};