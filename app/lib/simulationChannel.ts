// Simulation control-plane protocol. These are never MeshRecords or CRNN evidence.
export const SIMULATION_HISTORY_LIMIT = 40;
export const SIMULATION_TTL_MS = 120_000;
export const SIMULATION_KINDS = ["impact", "drone", "interference", "isolation"] as const;
export const SIMULATION_PHASES = ["started", "contact", "completed", "cancelled", "restored"] as const;

export interface SimulationNotice {
  runId: string;
  kind: typeof SIMULATION_KINDS[number];
  phase: typeof SIMULATION_PHASES[number];
  message: string;
  affectedNodes: string[];
  position?: { x: number; y: number };
}

export interface SimulationAlert extends SimulationNotice {
  id: string;
  createdAt: number;
  expiresAt: number;
  recipients: string[];
  acknowledgedBy: string[];
}

export const SIMULATION_LABELS: Record<SimulationNotice["kind"], string> = {
  impact: "Blast impact",
  drone: "Drone flight",
  interference: "Radio interference",
  isolation: "Node isolation",
};

/** Defensive boundary for control messages, independent of the gossip parser. */
export function isSimulationAlert(value: unknown): value is SimulationAlert {
  if (!value || typeof value !== "object") return false;
  const a = value as SimulationAlert;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 1024 && v.every(s => typeof s === "string" && s.length <= 128);
  return typeof a.id === "string" && a.id.length > 0 && a.id.length <= 128
    && typeof a.runId === "string" && a.runId.length > 0 && a.runId.length <= 128
    && SIMULATION_KINDS.includes(a.kind) && SIMULATION_PHASES.includes(a.phase)
    && typeof a.message === "string" && a.message.length > 0 && a.message.length <= 500
    && Number.isFinite(a.createdAt) && Number.isFinite(a.expiresAt) && a.expiresAt > a.createdAt
    && a.expiresAt - a.createdAt <= SIMULATION_TTL_MS
    && strings(a.affectedNodes) && strings(a.recipients) && strings(a.acknowledgedBy)
    && (a.position === undefined || (a.position !== null && Number.isFinite(a.position.x) && Number.isFinite(a.position.y)));
}

/** Newest first. ACK updates do not reorder, duplicate, or re-announce an event. */
export function mergeSimulationAlert(history: SimulationAlert[], alert: SimulationAlert, now = Date.now()): SimulationAlert[] {
  const live = history.filter(a => a.expiresAt > now);
  if (alert.expiresAt <= now) return live;
  const index = live.findIndex(a => a.id === alert.id);
  if (index >= 0) return live.map(a => a.id === alert.id ? alert : a);
  return [alert, ...live].slice(0, SIMULATION_HISTORY_LIMIT);
}

/** A later phase supersedes earlier notices for the same run, including reset. */
export function currentSimulationAlerts(history: SimulationAlert[], now = Date.now()): SimulationAlert[] {
  const seen = new Set<string>();
  return history.filter(a => {
    if (a.expiresAt <= now || seen.has(a.runId)) return false;
    seen.add(a.runId);
    return true;
  });
}
