// page.tsx — the node. One tap to join, then it listens and gossips.
//
// The join flow of ARCHITECTURE.md §11: mic permission needs a user gesture on
// iOS, and no geolocation is requested at all because the admin sets position in
// room coordinates (§13).

"use client";

import styles from "./join.module.css";
import { AsciiLogo } from "./lib/AsciiLogo";
import { TrajectoryHero } from "./lib/TrajectoryHero";

import { useEffect, useRef, useState } from "react";
import { useMesh } from "./lib/useMesh.ts";
import { MicScorer, SILENT, type Score } from "./lib/scoring.ts";
import { SensorDesktop } from "./lib/SensorDesktop";
import { SCORE_INTERVAL_MS } from "./lib/detection.ts";

export default function NodePage() {
  const [joined, setJoined] = useState(false);
  const [resume, setResume] = useState(false);
  useEffect(() => {
    try { setResume(sessionStorage.getItem("skymesh.sensor.visited") === "true"); } catch {}
  }, []);
  const [loading, setLoading] = useState(false);
  const [sensorReady, setSensorReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [score, setScore] = useState<Score>(SILENT);
  const [detections, setDetections] = useState(0);
  const wasDetecting = useRef(false);
  const { mesh, view } = useMesh({ enabled: joined });
  const scorerRef = useRef<MicScorer | null>(null);

  async function join() {
    setMicError(null);
    try { sessionStorage.setItem("skymesh.sensor.visited", "true"); } catch {}
    setLoading(true);
    const scorer = new MicScorer();
    try {
      // Loads the CRNN (~6 MB, cached after first visit) then opens the mic.
      await scorer.start();
      scorerRef.current = scorer;
      setSensorReady(true);
    } catch (e) {
      // start() may have loaded the model and opened the mic before failing.
      // Without this the wasm session and the mic track leak for the life of
      // the tab, and iOS keeps the recording indicator lit.
      scorer.stop();
      // A node that cannot score is still a valid node — it just contributes no
      // evidence, and silence from it is not mistaken for a quiet room because
      // it publishes nothing at all.
      setMicError(String(e));
      setLoading(false);
      setJoined(true);
    }
  }

  // Let the mascot acknowledge successful setup before entering the node view.
  useEffect(() => {
    if (!sensorReady) return;
    const timer = setTimeout(() => { setLoading(false); setJoined(true); }, 650);
    return () => clearTimeout(timer);
  }, [sensorReady]);

  // Publish a reading every second, whatever its value: a quiet node is evidence
  // (§6.1), and silence is what pushes the posterior away from empty space.
  useEffect(() => {
    if (!joined || !mesh) return;
    // Publish every scored window, at the CRNN's own 500 ms hop. One rate keeps
    // the log the single source of truth for the confidence graph — the node's
    // own view and the operator's are then the same data, at the same
    // resolution, and the operator's arrived by gossip. ~160 B/s per node.
    const id = setInterval(() => {
      const scorer = scorerRef.current;
      if (!scorer?.ready) return; // absent beats a false "heard nothing" (§6.1)
      const s = scorer.latest();
      setScore(s);
      // The verdict is the scorer's latch (SkyMesh's), not a threshold applied here.
      if (s.detecting && !wasDetecting.current) {
        setDetections((n) => n + 1);
        try {
          navigator.vibrate?.(200);
        } catch {
          /* unsupported */
        }
      }
      wasDetecting.current = s.detecting;
      mesh.publishReading(s);
    }, SCORE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [joined, mesh]);

  // Screen lock kills the mic and the socket, so hold a wake lock while active.
  useEffect(() => {
    if (!joined) return;
    let lock: any = null;
    let disposed = false;
    const nav = navigator as any;
    nav.wakeLock?.request("screen").then((l: any) => { if (disposed) l.release().catch(() => {}); else lock = l; }).catch(() => {});
    return () => { disposed = true; lock?.release?.().catch(() => {}); };
  }, [joined]);

  useEffect(() => () => scorerRef.current?.stop(), []);

  if (!joined) {
    return (
      <main className={styles.screen}>
        <TrajectoryHero />
        <section data-join-panel className={`${styles.dialog} ${sensorReady ? styles.departing : ""}`} aria-labelledby="join-title" aria-busy={loading}>
          <div className={styles.content}>
            <h1 id="join-title" className={styles.title}>Welcome to SkyMesh</h1>
            <div className={styles.rule} />
            <p className={styles.intro}>A shared sky. Powered by your phone.</p>
            <dl className={styles.fields}>
              <dt>Mode:</dt><dd>On-device drone detection</dd>
              <dt>Privacy:</dt><dd>Audio stays on this phone</dd>
            </dl>
            <ol className={styles.steps}>
              <li>Enable your microphone.</li>
              <li>Wait for the operator to admit you.</li>
              <li>Keep this screen open to listen.</li>
            </ol>
            <button className={styles.joinButton} type="button" onClick={join} disabled={loading}>
              {sensorReady ? "Sensor ready!" : loading ? "Preparing your sensor…" : resume ? "Resume sensor" : "Enable microphone & join"}
            </button>
            <p className={styles.note} role="status" aria-live="polite">
              {sensorReady ? "Sensor ready. Joining the mesh…" : loading ? "Loading the detector (~6 MB). Please wait…" : "Beta phone build. SkyMesh proper runs on frontline hardware."}
            </p>
          </div>
          <div className={styles.brand}>
            <AsciiLogo className={styles.logo} mood={sensorReady ? "happy" : loading ? "loading" : "idle"} />
          </div>
        </section>
      </main>
    );
  }

  function stopSensor() {
    scorerRef.current?.stop();
    scorerRef.current = null;
    setJoined(false);
    setSensorReady(false);
    setLoading(false);
    setScore(SILENT);
    setDetections(0);
    wasDetecting.current = false;
    setResume(true);
  }

  // The runtime stays mounted here while the desktop switches or hides windows.
  return <SensorDesktop mesh={mesh} view={view} score={score}
    detections={detections} micError={micError} onStop={stopSensor} />;
}
