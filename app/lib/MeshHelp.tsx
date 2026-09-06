"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./SensorDesktop.module.css";

export function MeshHelp() {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => { pinned.current = false; setOpen(false); };
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) dismiss();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div ref={root} className={styles.meshHeading}
    onMouseLeave={() => { if (!pinned.current) setOpen(false); }}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) { pinned.current = false; setOpen(false); }
    }}>
    <h2>Your mesh picture</h2>
    <button type="button" className={styles.meshHelpButton} aria-label="What does the mesh picture show?"
      aria-describedby={open ? "mesh-help-tooltip" : undefined}
      onMouseEnter={() => setOpen(true)} onFocus={() => setOpen(true)}
      onClick={() => { pinned.current = !pinned.current; setOpen(pinned.current); }}>?</button>
    {open && <div id="mesh-help-tooltip" role="tooltip" className={styles.meshTooltip}>
      <strong className={styles.meshHelpTitle}>SkyMesh Help · The shared picture</strong>
      <div className={styles.meshHelpBody}>
        <p><strong>One phone hears. Together, phones estimate where the drone sound is coming from.</strong></p>
        <p>This is a top-down map of the whole 12 × 8 metre demo area, not just your phone. Each grid square is one metre.</p>
        <ul>
          <li><strong>Labelled dots:</strong> phones placed by the operator, including yours. These are assigned positions, not GPS.</li>
          <li><strong>Shaded heatmap:</strong> likely sound-source locations from combined readings. A source marker and dashed circle appear when the estimate is sufficiently constrained.</li>
          <li><strong>Shared intelligence:</strong> each phone exchanges detection scores and sound levels, then computes its own picture. Raw audio stays on the phone.</li>
        </ul>
        <p>The showcase is distributed sensing and local computation, rather than a server sending everyone a finished map. This browser demo still uses a network relay to carry messages.</p>
        <p>No dots yet? The operator needs to place nodes. Location estimates are experimental and depend on room and microphone calibration.</p>
        <span className={styles.meshHelpHint}>Tap ? to toggle · Esc to dismiss</span>
      </div>
    </div>}
  </div>;
}
