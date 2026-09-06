"use client";

import { useEffect, useId, useRef, useState } from "react";
import { currentSimulationAlerts, SIMULATION_LABELS, type SimulationAlert, type SimulationNotice } from "./simulationChannel.ts";
import styles from "./SimulationAlerts.module.css";

const PHASE_LABELS: Record<SimulationNotice["phase"], string> = {
  started: "Started", contact: "Contact", completed: "Completed", cancelled: "Cancelled", restored: "Restored",
};
const CONFIRMATION_WAIT_MS = 10_000;

export function SimulationAlerts({ alerts, nodeId, connected, onAcknowledge }: {
  alerts: SimulationAlert[];
  nodeId: string;
  connected: boolean;
  onAcknowledge: (id: string) => boolean;
}) {
  const bodyId = useId();
  const titleId = useId();
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const [attempts, setAttempts] = useState<Record<string, { sentAt: number; sent: boolean }>>({});
  const seen = useRef(new Set<string>());
  // Expire notices and pending UI even when no further mesh updates arrive.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const current = currentSimulationAlerts(alerts, now);
  const latest = current[0];
  const latestId = latest?.id;
  useEffect(() => {
    if (!latestId || seen.current.has(latestId)) return;
    seen.current.add(latestId);
    if (seen.current.size > 80) seen.current.delete(seen.current.values().next().value!);
    setExpanded(true);
    setAttempts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => alerts.some(alert => alert.id === id))));
  }, [latestId, alerts]);
  const unacknowledged = current.filter(alert => !nodeId || !alert.acknowledgedBy.includes(nodeId)).length;
  const summary = !latest ? "Waiting for simulation events" : unacknowledged
    ? `${unacknowledged} event${unacknowledged === 1 ? "" : "s"} awaiting acknowledgement`
    : "Acknowledged by this node";
  const connectionLabel = connected ? "Channel active" : "Offline / awaiting admission";

  function acknowledge(id: string) {
    if (!connected || !nodeId) return;
    const sent = onAcknowledge(id);
    setAttempts(previous => ({ ...previous, [id]: { sentAt: Date.now(), sent } }));
  }

  return <section className={styles.panel} aria-labelledby={titleId}>
    <header className={styles.titlebar}>
      <span id={titleId}>▧ Simulation channel</span>
      <button type="button" aria-expanded={expanded} aria-controls={bodyId}
        aria-label={expanded ? "Collapse simulation channel" : "Expand simulation channel"}
        onClick={() => setExpanded(value => !value)}>{expanded ? "−" : "+"}</button>
    </header>
    <div className={styles.summary}>
      <strong className={styles.badge}>SIMULATION / DEMO ONLY</strong>
      <span>{summary}</span>
      <span className={styles.connection} data-connected={connected}>{connectionLabel}</span>
    </div>
    {/* Keep event text separate from ACK/network status. Identical text is not
        mutated by React on expiry-clock ticks or acknowledgement echoes. */}
    <p className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
      {latest ? `Simulation only. ${SIMULATION_LABELS[latest.kind]}. ${PHASE_LABELS[latest.phase]}. ${latest.message}. ${latest.affectedNodes.includes(nodeId) ? "Affects your node." : "Session only. Your node is not affected."}` : "Waiting for simulation events."}
    </p>
    <p className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{summary}. {connectionLabel}.</p>
    <div id={bodyId} hidden={!expanded} className={styles.body}>
      <p className={styles.disclaimer}>Operator demo messages, not neural-network detections. No detector scores or map readings are changed.</p>
      {!connected && <p className={styles.notice}>Live delivery is not confirmed. Displayed events may be stale. Acknowledgement is disabled until the channel is active.</p>}
      {!latest && <p className={styles.waiting}>No current simulation events. This channel works independently of the microphone and sensor window.</p>}
      <ul className={styles.events}>
        {current.slice(0, 8).map(alert => {
          const acknowledged = Boolean(nodeId && alert.acknowledgedBy.includes(nodeId));
          const attempt = attempts[alert.id];
          const pending = !acknowledged && attempt?.sent && now - attempt.sentAt < CONFIRMATION_WAIT_MS;
          const affected = Boolean(nodeId && alert.affectedNodes.includes(nodeId));
          return <li key={alert.id} className={styles.event}>
            <div className={styles.eventHeading}><strong>{SIMULATION_LABELS[alert.kind]}</strong><span>{PHASE_LABELS[alert.phase]}</span></div>
            <time dateTime={new Date(alert.createdAt).toISOString()}>{new Date(alert.createdAt).toLocaleString()}</time>
            <p className={styles.context}>{affected ? "AFFECTS YOUR NODE (simulated)" : "SESSION ONLY · your node is not affected"}</p>
            <p className={styles.message}>{alert.message}</p>
            {alert.position && <p className={styles.coordinates}>Room position: x {alert.position.x.toFixed(2)} m, y {alert.position.y.toFixed(2)} m</p>}
            <div className={styles.acknowledgement}>
              <button type="button" disabled={!connected || !nodeId || acknowledged || Boolean(pending)} onClick={() => acknowledge(alert.id)}>
                {acknowledged ? "Acknowledged" : pending ? "Awaiting server echo…" : attempt ? "Retry acknowledgement" : "Acknowledge"}
              </button>
              <span role="status">{acknowledged ? "Confirmed by server for this node." : pending
                ? "Sent locally. Not yet confirmed by server."
                : attempt ? attempt.sent ? "No server confirmation received. Retry when connected." : "Not sent. Retry when connected."
                : "Not acknowledged by this node."}</span>
            </div>
          </li>;
        })}
      </ul>
      {current.length > 8 && <p className={styles.notice}>{current.length - 8} additional current events are not shown. Showing the 8 latest runs.</p>}
      {latest && <p className={styles.hint}>Latest phase per run. Notices expire automatically. Acknowledgement is recorded only after a server echo.</p>}
    </div>
  </section>;
}
