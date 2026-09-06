"use client";

import { useEffect, useRef, useState } from "react";
import type { Mesh, MeshView } from "./mesh";
import { DEFAULT_ROOM } from "./mesh";
import type { Score } from "./scoring";
import { ConfidenceGraph } from "./ConfidenceGraph";
import { RoomMap } from "./RoomMap";
import { TrajectoryHero } from "./TrajectoryHero";
import styles from "./SensorDesktop.module.css";

const tabs = ["Monitor", "Mesh", "Diagnostics"] as const;
type Tab = typeof tabs[number];
const preferenceKey = "skymesh.sensor.desktop";

export function SensorDesktop({ mesh, view, score, detections, micError, onStop }: {
  mesh: Mesh | null; view: MeshView | null; score: Score;
  detections: number; micError: string | null; onStop: () => void;
}) {
  const [tab, setTab] = useState<Tab>("Monitor");
  const [minimized, setMinimized] = useState(false);
  const [closing, setClosing] = useState(false);
  const [ready, setReady] = useState(false);
  const [width, setWidth] = useState(300);
  const viewport = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLElement>(null);
  const taskButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(preferenceKey) ?? "null");
      if (tabs.includes(saved?.tab)) setTab(saved.tab);
      if (typeof saved?.minimized === "boolean") setMinimized(saved.minimized);
    } catch { /* Storage is optional, including in private browsing. */ }
    setReady(true);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { sessionStorage.setItem(preferenceKey, JSON.stringify({ tab, minimized })); } catch {}
  }, [tab, minimized, ready]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.floor(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, [minimized, ready]);
  useEffect(() => {
    if (!ready) return;
    if (minimized) taskButton.current?.focus();
    else windowRef.current?.focus();
  }, [minimized, ready]);

  function minimize() {
    if (closing) return;
    setClosing(true);
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    timer.current = setTimeout(() => { setMinimized(true); setClosing(false); }, duration);
  }
  const status = view?.status.state ?? "connecting";
  const statusLabel = status === "pending" ? "Waiting for operator" : status === "active" ? "Admitted to mesh" : status;
  const activity = micError ? "Relay only · detector unavailable" : score.detecting ? "Drone detected" : "Sensor running";
  const est = view?.estimate;
  if (!ready) return <main className={styles.desktop}><TrajectoryHero /></main>;
  return <main className={styles.desktop}>
    <TrajectoryHero />
    <div className={styles.desktopLabel} aria-hidden="true">SKYMESH / SENSOR WORKSTATION</div>
    {!minimized && <section ref={windowRef} tabIndex={-1} aria-label="SkyMesh sensor window" className={`${styles.window} ${closing ? styles.closing : ""}`}>
      <header className={styles.titlebar}>
        <span>▧ SkyMesh · Sensor</span>
        <button type="button" aria-label="Minimize sensor window" title="Minimize. Sensor keeps running." onClick={minimize}>_</button>
      </header>
      <div className={styles.body}>
        <div className={styles.heading}>
          <div><p className={styles.eyebrow}>A shared sky. Powered by you.</p><h1>Node {view?.nodeId ?? "…"}</h1></div>
          <span className={styles.status} role="status" data-active={status === "active"}>● {statusLabel}</span>
        </div>
        {micError && <p className={styles.warning} role="status">Detector unavailable: {micError}. This node still relays and fuses mesh data, but contributes no microphone readings.</p>}
        <div className={styles.tabs} role="tablist" aria-label="Sensor views">
          {tabs.map((name, index) => <button key={name} id={`tab-${name}`} role="tab" aria-selected={tab === name} aria-controls={`panel-${name}`} tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)} onKeyDown={event => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault(); setTab(tabs[next]); document.getElementById(`tab-${tabs[next]}`)?.focus();
            }}>{name}</button>)}
        </div>
        <div ref={viewport} className={styles.content}>
          <div key={tab} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className={styles.tabPanel}>
            {tab === "Monitor" && <>
              <div className={styles.readout}><h2>{micError ? "Detector unavailable" : score.detecting ? "DRONE DETECTED" : "Drone confidence"}</h2><strong data-detecting={score.detecting}>{micError ? "N/A" : `${(score.display * 100).toFixed(0)}%`}</strong></div>
              <div className={styles.instrument}><ConfidenceGraph history={mesh?.history(view?.nodeId ?? "") ?? []} width={Math.max(1, width - 28)} height={200} now={Date.now()} /></div>
              <dl className={styles.metrics}><div><dt>Detector</dt><dd>{micError ? "Unavailable" : "On-device CRNN"}</dd></div><div><dt>Detections</dt><dd>{detections}</dd></div><div><dt>Signal / noise</dt><dd>{score.snrDb === null ? "—" : `${score.snrDb.toFixed(1)} dB`}</dd></div></dl>
              <p className={styles.note}>Audio stays on this phone. Only detection scores are shared.</p>
            </>}
            {tab === "Mesh" && <>
              <h2>Your mesh picture</h2><p className={styles.note}>Computed on this phone from its own replica, not received from a server.</p>
              <div className={styles.map}><RoomMap room={DEFAULT_ROOM} positions={view?.positions ?? new Map()} estimate={est ?? null} levels={new Map(view ? [[view.nodeId, score.p]] : [])} width={Math.max(1, width)} /></div>
              <p className={styles.note}>{est?.localised ? `Fused from ${est.nReports} reporting + ${est.nSilent} silent · ±${est.spreadM.toFixed(1)} m${!est.graded ? " · no SNR: coarse" : ""}` : est ? `${est.nReports} detecting · not localised` : (view?.positions.size ?? 0) > 0 ? `Nothing heard · ${view?.listening ?? 0} nodes listening` : "No positioned readings yet. The operator must place nodes."}</p>
            </>}
            {tab === "Diagnostics" && <>
              <h2>Mesh diagnostics</h2><dl className={styles.diagnostics}>
                <dt>Records held</dt><dd>{view?.records ?? 0}</dd><dt>Neighbours</dt><dd>{view?.neighbours.join(", ") || "None"}</dd>
                <dt>Clock root</dt><dd>{view?.clock.rootId ?? "?"}</dd><dt>Clock offset</dt><dd>{(view?.clock.offsetMs ?? 0).toFixed(0)} ms</dd><dt>Clock hops</dt><dd>{view?.clock.hops ?? 0}</dd>
                <dt>Microphone</dt><dd>{micError ? "Unavailable" : "Listening"}</dd>
              </dl><p className={styles.note}>Switching tabs or minimizing this window keeps the sensor running. Keep this browser tab open.</p>
            </>}
          </div>
        </div>
      </div>
      <footer className={styles.statusbar}><span>{view?.records ?? 0} records</span><span>{view?.neighbours.length ?? 0} neighbours</span><span>{activity}</span></footer>
    </section>}
    {minimized && <div className={styles.minimizedNote}><h1>Sensor window minimized</h1><p>{activity}. Restore the window from the taskbar below.</p></div>}
    <nav className={styles.taskbar} aria-label="Sensor taskbar"><span className={styles.wordmark}>SkyMesh</span><button ref={taskButton} type="button" aria-expanded={!minimized} onClick={() => minimized ? setMinimized(false) : minimize()}>▧ {minimized ? "Restore sensor" : "Sensor window"}</button><span className={styles.taskActivity} role="status">● {activity}</span><button type="button" onClick={onStop}>Stop sensor</button></nav>
  </main>;
}
