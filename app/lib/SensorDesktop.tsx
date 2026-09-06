"use client";

import { useEffect, useRef, useState } from "react";
import type { Mesh, MeshView } from "./mesh";
import { DEFAULT_ROOM } from "./mesh";
import type { Score } from "./scoring";
import { ConfidenceGraph } from "./ConfidenceGraph";
import { RoomMap } from "./RoomMap";
import { TrajectoryHero } from "./TrajectoryHero";
import QRCode from "react-qr-code";
import { AsciiLogo } from "./AsciiLogo";
import { useDesktopDrag } from "./useDesktopDrag";
import styles from "./SensorDesktop.module.css";

const tabs = ["Monitor", "Mesh", "Diagnostics"] as const;
type Tab = typeof tabs[number];
const preferenceKey = "skymesh.sensor.desktop";

export function SensorDesktop({ mesh, view, score, detections, micError }: {
  mesh: Mesh | null; view: MeshView | null; score: Score;
  detections: number; micError: string | null;
}) {
  const [joinUrl, setJoinUrl] = useState("");
  const [qrOpen, setQrOpen] = useState<false | "qr" | "video">(false);
  const sensorDrag = useDesktopDrag<HTMLElement>(true);
  const viewerDrag = useDesktopDrag<HTMLDialogElement>(true);
  const qrDrag = useDesktopDrag<HTMLButtonElement>();
  const videoDrag = useDesktopDrag<HTMLButtonElement>();
  const mascotDrag = useDesktopDrag<HTMLButtonElement>();
  const stationDrag = useDesktopDrag<HTMLAnchorElement>();
  const qrDialog = viewerDrag.ref;
  const qrFile = qrDrag.ref;
  const launchIcon = useRef<HTMLElement | null>(null);
  const viewerAnimation = useRef<Animation | null>(null);
  const viewerClosing = useRef(false);
  const [tab, setTab] = useState<Tab>("Monitor");
  const [minimized, setMinimized] = useState(false);
  const [closing, setClosing] = useState(false);
  const [ready, setReady] = useState(false);
  const [width, setWidth] = useState(300);
  const viewport = useRef<HTMLDivElement>(null);
  const windowRef = sensorDrag.ref;
  const taskButton = mascotDrag.ref;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(preferenceKey) ?? "null");
      if (tabs.includes(saved?.tab)) setTab(saved.tab);
      // Always show the dashboard at startup; the mascot restores it after minimizing.
    } catch { /* Storage is optional, including in private browsing. */ }
    const url = new URL("/", window.location.origin);
    const session = new URLSearchParams(window.location.search).get("session");
    if (session) url.searchParams.set("session", session);
    setJoinUrl(url.href);
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

  function viewerFrames() {
    const icon = launchIcon.current?.getBoundingClientRect();
    const box = qrDialog.current?.getBoundingClientRect();
    if (!icon || !box) return [{ opacity: 0 }, { opacity: 1 }];
    return [
      { transform: `translate(${icon.x + icon.width / 2 - box.x - box.width / 2}px, ${icon.y + icon.height / 2 - box.y - box.height / 2}px) scale(${icon.width / box.width}, ${icon.height / box.height})`, opacity: 0.25 },
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
    ];
  }
  useEffect(() => {
    if (!qrOpen) { qrDialog.current?.close(); return; }
    qrDialog.current?.showModal();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      viewerAnimation.current = qrDialog.current!.animate(viewerFrames(), { duration: 220, easing: "steps(5, end)" });
    }
    return () => viewerAnimation.current?.cancel();
  }, [qrOpen]);

  function openViewer(kind: "qr" | "video") {
    viewerDrag.reset();
    launchIcon.current = kind === "qr" ? qrFile.current : videoDrag.ref.current;
    setQrOpen(kind);
  }
  async function closeViewer() {
    if (viewerClosing.current) return;
    viewerClosing.current = true;
    viewerAnimation.current?.cancel();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && qrDialog.current) {
      viewerAnimation.current = qrDialog.current.animate(viewerFrames().reverse(), { duration: 160, easing: "steps(4, end)", fill: "forwards" });
      await viewerAnimation.current.finished.catch(() => {});
    }
    setQrOpen(false);
    viewerClosing.current = false;
  }

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
    <button ref={qrFile} style={qrDrag.style} {...qrDrag.handlers} className={styles.qrFile} type="button" onClick={() => openViewer("qr")} aria-label="Open skymesh-join.svg">
      <span className={styles.fileImage}><QRCode value={joinUrl} size={72} /></span>
      <span className={styles.fileName}>skymesh-join.svg</span>
    </button>
    <button ref={videoDrag.ref} style={videoDrag.style} {...videoDrag.handlers} className={styles.videoFile} type="button" onClick={() => openViewer("video")} aria-label="Open drone-demo.mp4" title="Open video viewer">
      <span className={styles.videoImage} aria-hidden="true"><span>▶</span><small>MP4</small></span>
      <span className={styles.fileName}>drone-demo.mp4</span>
    </button>
    <a ref={stationDrag.ref} style={stationDrag.style} {...stationDrag.handlers} className={styles.stationFile} href="https://stationdc.org" target="_blank" rel="noopener noreferrer" aria-label="Open Station DC website (new tab)">
      <span className={styles.stationImage} aria-hidden="true"><span>▥</span><strong>STATION<br />DC</strong></span>
      <span className={styles.fileName}>station-dc.url</span>
    </a>
    <dialog ref={qrDialog} style={viewerDrag.style} className={`${styles.qrViewer} ${qrOpen === "video" ? styles.videoViewer : ""}`} aria-labelledby="qr-title" onCancel={event => { event.preventDefault(); void closeViewer(); }} onClose={() => { setQrOpen(false); launchIcon.current?.focus(); }}>
      <header {...viewerDrag.handlers} className={styles.titlebar}><span id="qr-title">{qrOpen === "video" ? "drone-demo.mp4" : "skymesh-join.svg"}</span><button type="button" aria-label={qrOpen === "video" ? "Close video viewer" : "Close QR image"} onClick={() => void closeViewer()}>×</button></header>
      {qrOpen === "video" ? <>
        <iframe className={styles.videoPlayer} src="https://www.youtube-nocookie.com/embed/DUTQkbuzxtk" title="Drone demo video" allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        <p>drone-demo.mp4 · YouTube video</p><a href="https://youtu.be/DUTQkbuzxtk?is=_DargxbSpjJiuzxG" target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a>
      </> : <>
        <div className={styles.qrImage}><QRCode value={joinUrl} size={256} title="Scan to join this SkyMesh session" /></div>
        <p>Scan to join this mesh.</p><a href={joinUrl}>{joinUrl}</a>
      </>}
    </dialog>
    {!minimized && <section ref={windowRef} style={sensorDrag.style} tabIndex={-1} aria-label="SkyMesh sensor window" className={`${styles.window} ${closing ? styles.closing : ""}`}>
      <header {...sensorDrag.handlers} className={styles.titlebar}>
        <span>▧ SkyMesh · Sensor</span>
        <div className={styles.windowControls}><button type="button" aria-label="Minimize sensor window" title="Minimize. Sensor keeps running." onClick={minimize}>_</button><button type="button" aria-label="Close sensor window" title="Close window. Sensor keeps running." onClick={minimize}>×</button></div>
      </header>
      <div className={styles.body}>
        <div className={styles.heading}>
          <div><p className={styles.eyebrow}>A shared sky. Powered by you.</p><h1>Node {view?.nodeId ?? "…"}</h1></div>
          <span className={styles.status} role="status" data-active={status === "active"}> {statusLabel}</span>
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
              <div className={styles.instrument}><ConfidenceGraph history={mesh?.history(view?.nodeId ?? "") ?? []} monochrome width={Math.max(1, width - 28)} height={200} now={Date.now()} /></div>
              <dl className={styles.metrics}><div><dt>Detector</dt><dd>{micError ? "Unavailable" : "On-device CRNN"}</dd></div><div><dt>Detections</dt><dd>{detections}</dd></div><div><dt>Signal / noise</dt><dd>{score.snrDb === null ? "—" : `${score.snrDb.toFixed(1)} dB`}</dd></div></dl>
              <p className={styles.note}>Audio stays on this phone. Only detection scores are shared.</p>
            </>}
            {tab === "Mesh" && <>
              <h2>Your mesh picture</h2><p className={styles.note}>Computed on this phone from its own replica, not received from a server.</p>
              <div className={styles.map}><RoomMap room={DEFAULT_ROOM} positions={view?.positions ?? new Map()} estimate={est ?? null} levels={new Map(view ? [[view.nodeId, score.p]] : [])} width={Math.max(1, width - 2)} /></div>
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
    <button ref={taskButton} style={mascotDrag.style} {...mascotDrag.handlers} className={styles.sensorFile} type="button" aria-label="Open sensor dashboard" aria-expanded={!minimized} onClick={() => { setMinimized(false); requestAnimationFrame(() => windowRef.current?.focus()); }}>
      <span className={styles.sensorImage}><AsciiLogo className={styles.desktopMascot} mood="idle" /></span>
      <span className={styles.fileName}>SkyMesh_x64.exe</span>
    </button>
  </main>;
}
